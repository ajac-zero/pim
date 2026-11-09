import { randomBytes } from 'node:crypto'
import { createWriteStream, promises as fs } from 'node:fs'
import path from 'node:path'
import { HttpError } from './errors.mjs'

function map(error, p) {
	if (error instanceof HttpError) return error
	switch (error.code) {
		case 'ENOENT':
		case 'ENOTDIR':
			return new HttpError(404, 'not_found', `no such file or directory: ${p}`)
		case 'EISDIR':
			return new HttpError(400, 'is_directory', `is a directory: ${p}`)
		case 'ENOTEMPTY':
			return new HttpError(409, 'not_empty', `directory is not empty: ${p}`)
		case 'ENOSPC':
		case 'EDQUOT':
			return new HttpError(507, 'disk_full', `no space left for: ${p}`)
		case 'EACCES':
		case 'EPERM':
			return new HttpError(403, 'permission_denied', `permission denied: ${p}`)
		default:
			return error
	}
}

export async function guard(p, fn) {
	try {
		return await fn()
	} catch (error) {
		throw map(error, p)
	}
}

export function record(name, st) {
	const type = st.isSymbolicLink() ? 'symlink' : st.isDirectory() ? 'dir' : 'file'
	return { name, type, size: st.size, mode: st.mode & 0o7777, mtimeMs: st.mtimeMs }
}

export const stat = (resolver, p) =>
	guard(p, async () => {
		const entry = await resolver.entry(p)
		return record(path.basename(entry), await fs.lstat(entry))
	})

export const list = (resolver, p) =>
	guard(p, async () => {
		const dir = await resolver.follow(p)
		const names = await fs.readdir(dir)
		const out = []
		for (const name of names) {
			try {
				out.push(record(name, await fs.lstat(path.join(dir, name))))
			} catch (error) {
				if (error.code !== 'ENOENT') throw error
			}
		}
		return out
	})

export const openRead = (resolver, p) =>
	guard(p, async () => {
		const file = await resolver.follow(p)
		const st = await fs.stat(file)
		if (st.isDirectory()) throw new HttpError(400, 'is_directory', `is a directory: ${p}`)
		return { file, size: st.size }
	})

export const remove = (resolver, p, recursive) =>
	guard(p, async () => {
		const entry = await resolver.entry(p)
		if (entry === resolver.root) throw new HttpError(400, 'bad_path', 'cannot delete the workspace root')
		const st = await fs.lstat(entry)
		if (st.isDirectory()) {
			if (!recursive) throw new HttpError(409, 'is_directory', `is a directory; pass recursive=1: ${p}`)
			await fs.rm(entry, { recursive: true })
		} else {
			await fs.unlink(entry)
		}
	})

// Streams `req` into a temp file beside the target, then renames it into place.
export async function write(resolver, p, mode, req, maxBytes) {
	let entry = await guard(p, () => resolver.entry(p))
	// Writing through a symlink writes its target, so the target must be inside the root too.
	if ((await fs.lstat(entry).catch(() => null))?.isSymbolicLink()) entry = await guard(p, () => resolver.follow(p))
	if (entry === resolver.root) throw new HttpError(400, 'is_directory', 'cannot write the workspace root')
	const dir = path.dirname(entry)
	await guard(p, () => fs.mkdir(dir, { recursive: true }))
	// mkdir may have created directories through nothing unsafe, but re-check the parent now it exists.
	await guard(p, () => resolver.entry(p))
	const tmp = path.join(dir, `.agentd-${randomBytes(6).toString('hex')}.tmp`)
	let size = 0
	try {
		await guard(p, () =>
			new Promise((resolve, reject) => {
				const out = createWriteStream(tmp, { mode, flags: 'wx' })
				out.on('error', reject)
				out.on('finish', resolve)
				req.on('error', (e) => out.destroy(e))
				req.on('aborted', () => out.destroy(new HttpError(400, 'aborted', 'upload aborted')))
				req.on('data', (chunk) => {
					size += chunk.length
					if (size > maxBytes) {
						req.unpipe(out)
						out.destroy(new HttpError(413, 'body_too_large', `body exceeds ${maxBytes} bytes`))
					}
				})
				req.pipe(out)
			}),
		)
		await fs.chmod(tmp, mode)
		const existing = await fs.lstat(entry).catch(() => null)
		if (existing?.isDirectory()) throw new HttpError(400, 'is_directory', `is a directory: ${p}`)
		await fs.rename(tmp, entry)
	} catch (error) {
		await fs.rm(tmp, { force: true })
		throw error
	}
	return { size }
}

export async function treeBytes(dir) {
	let total = 0
	let entries
	try {
		entries = await fs.readdir(dir, { withFileTypes: true })
	} catch {
		return 0
	}
	for (const e of entries) {
		const full = path.join(dir, e.name)
		try {
			if (e.isDirectory()) total += await treeBytes(full)
			else total += (await fs.lstat(full)).size
		} catch {}
	}
	return total
}
