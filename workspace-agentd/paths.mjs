import { promises as fs } from 'node:fs'
import path from 'node:path'
import { HttpError } from './errors.mjs'

const escape = (p) => new HttpError(400, 'path_escape', `path is outside the workspace root: ${p}`)

function within(root, p) {
	return p === root || p.startsWith(root === '/' ? '/' : `${root}/`)
}

// Resolves the deepest existing ancestor of `target` with realpath, then re-appends the missing tail.
// A dangling symlink is followed to where it points, so it cannot hide an escape.
async function realpathLoose(target, depth = 0) {
	if (depth > 40) throw Object.assign(new Error('too many links'), { code: 'ELOOP' })
	const tail = []
	let current = target
	for (;;) {
		try {
			return path.join(await fs.realpath(current), ...tail)
		} catch (error) {
			if (error.code !== 'ENOENT' && error.code !== 'ENOTDIR') throw error
			const link = await fs.readlink(current).catch(() => null)
			if (link !== null) {
				const resolved = await realpathLoose(path.resolve(path.dirname(current), link), depth + 1)
				return path.join(resolved, ...tail)
			}
			const parent = path.dirname(current)
			if (parent === current) throw error
			tail.unshift(path.basename(current))
			current = parent
		}
	}
}

// Confines workspace paths to a root. Paths may be absolute or relative to the root.
export async function makeResolver(rootInput) {
	const root = await fs.realpath(path.resolve(rootInput))
	const lexical = (input) => {
		if (typeof input !== 'string' || input === '' || input.includes('\0')) {
			throw new HttpError(400, 'bad_path', 'path must be a non-empty string')
		}
		const abs = path.resolve(root, input)
		if (!within(root, abs)) throw escape(input)
		return abs
	}
	return {
		root,
		// Resolves following every symlink, including the last component. The path may not exist yet.
		async follow(input) {
			const real = await realpathLoose(lexical(input))
			if (!within(root, real)) throw escape(input)
			return real
		},
		// Resolves every symlink in the parent directory but leaves the last component alone, for
		// operations on the entry itself (stat, delete, atomic replace).
		async entry(input) {
			const abs = lexical(input)
			if (abs === root) return abs
			const parent = await realpathLoose(path.dirname(abs))
			if (!within(root, parent)) throw escape(input)
			return path.join(parent, path.basename(abs))
		},
	}
}
