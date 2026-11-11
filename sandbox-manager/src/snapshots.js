// Environment caching: snapshots of a session's /workspace, stored per user under the manager's
// data directory and restored into new sessions, and the per (user, repo) dependency cache volumes.
// Both count toward the manager's disk accounting and are collected least recently used first.
//
// A snapshot is `<dataDir>/snapshots/<hash of userId>/<key>.tar.zst` (`.tar.gz` where Node has no
// zstd) with its metadata in `<key>.json`. The metadata file is written last and is what makes the
// snapshot exist: a crash before it leaves only files that the next start removes.
import { createHash, randomBytes } from 'node:crypto'
import { createReadStream, createWriteStream } from 'node:fs'
import fs from 'node:fs/promises'
import path from 'node:path'
import { Readable } from 'node:stream'
import { finished, pipeline } from 'node:stream/promises'
import zlib from 'node:zlib'
import { DockerError } from './docker.js'
import { HttpError } from './errors.js'
import { TarError, coalesce, transformTar } from './tar.js'
import { LABEL_CACHE, LABEL_CACHE_REPO, LABEL_CACHE_USER, REPO, SANDBOX_UID, USER_ID } from './template.js'

const MiB = 1024 * 1024
const DAY = 86400000
export const SNAPSHOT_KEEP = 2
export const SNAPSHOT_TTL_DAYS = 7
const KEY = /^[0-9a-f]{16,128}$/
const MAX_GIT_CONFIG = MiB

const FORMATS = {
	zstd: { ext: '.tar.zst', compress: () => zlib.createZstdCompress(), decompress: () => zlib.createZstdDecompress() },
	gzip: { ext: '.tar.gz', compress: () => zlib.createGzip(), decompress: () => zlib.createGunzip() },
}
const FORMAT = typeof zlib.createZstdCompress === 'function' ? 'zstd' : 'gzip'

// Credentials that live in the home directory (/workspace, as HOME) and never go into a snapshot.
const HOME_SECRETS = [
	'.config/pim/git',
	'.npmrc', '.netrc', '.git-credentials', '.pypirc', '.yarnrc.yml', '.ssh', '.aws', '.docker', '.kube', '.gnupg', '.azure',
	'.config/gh', '.config/gcloud', '.cargo/credentials', '.cargo/credentials.toml',
	// The coding harnesses' sign-ins.
	'.claude.json', '.claude/.credentials.json', '.codex/auth.json', '.local/share/amp',
	'.bash_history', '.python_history', '.node_repl_history',
]

// Whether a path (relative to /workspace) holds credentials: a known credential file, or a `.env*`
// file in the home directory or its dot-directories (tool caches and configs, not a checkout).
export function isCredential(rel) {
	if (HOME_SECRETS.some((p) => rel === p || rel.startsWith(`${p}/`))) return true
	const parts = rel.split('/')
	return parts[0].startsWith('.') && parts.some((p) => p.startsWith('.env'))
}

// A repository's .git/config without tokens: http(s) remotes lose their user and password, and
// `extraheader` lines (where CI checkouts put an Authorization header) go.
export function sanitizeGitConfig(buf) {
	const lines = buf.toString('utf8').split('\n').filter((l) => !/^\s*extraheader\s*=/i.test(l))
	return Buffer.from(lines.map((l) => l.replace(/(https?:\/\/)[^@/\s"]+@/gi, '$1')).join('\n'))
}

const isGitConfig = (rel) => {
	const parts = rel.split('/')
	return parts.at(-1) === 'config' && parts.slice(0, -1).includes('.git')
}

// A relative path without `.` parts; throws for an absolute path, `..` or a NUL.
function cleanPath(name) {
	if (name.includes('\0')) throw new TarError('NUL in a path')
	if (name.startsWith('/')) throw new TarError(`absolute path: ${name}`)
	const parts = name.split('/').filter((p) => p && p !== '.')
	if (parts.includes('..')) throw new TarError(`path escapes the workspace: ${name}`)
	return parts.join('/')
}

// Whether a symlink at `rel` points outside /workspace (an absolute target must be under it).
function linkEscapes(rel, target) {
	let stack = rel.split('/').slice(0, -1)
	let segs = target.split('/')
	if (target.startsWith('/')) {
		segs = segs.filter(Boolean)
		if (segs[0] !== 'workspace') return true
		stack = []
		segs = segs.slice(1)
	}
	for (const s of segs) {
		if (!s || s === '.') continue
		if (s !== '..') stack.push(s)
		else if (!stack.length) return true
		else stack.pop()
	}
	return false
}

// The entry policy for `transformTar`. Restoring (`strict`) refuses anything unsafe: an absolute
// path, `..`, a symlink out of /workspace, an entry beneath a symlink, a hardlink to anything but an
// earlier file, and any device, fifo or other special file. Snapshotting (`fromDocker`) reads
// Docker's archive of /workspace, whose names start with `workspace/`, and leaves out credentials,
// special files and escaping links instead, counting them in `stats.excluded`. Every entry kept is
// owned by the sandbox user and loses setuid, setgid and sticky bits. `omit` is a set of names: a
// snapshot leaves out every file or directory so named, at any depth, counting them in `stats.omitted`.
export function entryPolicy({ fromDocker = false, stats = { excluded: 0, omitted: 0 }, omit = new Set() } = {}) {
	const links = new Set()
	const files = new Set()
	const strip = (name) => {
		if (!fromDocker) return cleanPath(name)
		const rel = cleanPath(name)
		if (rel !== 'workspace' && !rel.startsWith('workspace/')) throw new TarError(`unexpected entry ${name}`)
		return rel.slice('workspace/'.length)
	}
	return (e) => {
		const rel = strip(e.name)
		if (!rel) return null // /workspace itself, which the image owns
		const parts = rel.split('/')
		if (fromDocker && parts.some((p) => omit.has(p))) {
			stats.omitted++
			return null
		}
		for (let i = 1; i <= parts.length; i++) if (links.has(parts.slice(0, i).join('/'))) throw new TarError(`entry beneath or replacing a symlink: ${rel}`)
		const refuse = (why) => {
			if (!fromDocker) throw new TarError(`${why}: ${rel}`)
			stats.excluded++
			return null
		}
		if (fromDocker && isCredential(rel)) return refuse('credentials')
		let linkname = ''
		if (e.type === 'symlink') {
			if (linkEscapes(rel, e.linkname)) return refuse('symlink leaves the workspace')
			linkname = e.linkname
			links.add(rel)
		} else if (e.type === 'hardlink') {
			linkname = strip(e.linkname)
			if (!files.has(linkname)) return refuse('hardlink to something that is not an earlier file')
		} else if (e.type === 'file') files.add(rel)
		else if (e.type !== 'dir') return refuse(`${e.type} entry`)
		const entry = { name: e.type === 'dir' ? `${rel}/` : rel, type: e.type, mode: e.mode & 0o777, uid: SANDBOX_UID, gid: SANDBOX_UID, mtime: e.mtime, linkname }
		if (fromDocker && e.type === 'file' && isGitConfig(rel)) {
			if (e.size > MAX_GIT_CONFIG) return refuse('oversized git config')
			return { entry, edit: sanitizeGitConfig }
		}
		return { entry }
	}
}

// A name `exclude` may list: one path component, no glob, not `.` or `..`.
const EXCLUDE_NAME = /^(?!\.\.?$)[\w.@+-]{1,255}$/
const MAX_EXCLUDE = 16

// Checks a POST /snapshots body. `exclude` lists names of files and directories to leave out
// wherever they are, such as `node_modules`, for a caller that rebuilds them after a restore.
export function parseSnapshot(b) {
	if (!b || typeof b !== 'object' || Array.isArray(b)) throw new HttpError(400, 'body must be an object')
	for (const k of Object.keys(b)) if (!['userId', 'repo', 'key', 'sessionId', 'exclude'].includes(k)) throw new HttpError(400, `unknown field ${k}`)
	checkOwner(b.userId, b.repo)
	checkKey(b.key)
	if (typeof b.sessionId !== 'string') throw new HttpError(400, 'sessionId required')
	const exclude = b.exclude ?? []
	if (!Array.isArray(exclude) || exclude.length > MAX_EXCLUDE || !exclude.every((n) => typeof n === 'string' && EXCLUDE_NAME.test(n))) {
		throw new HttpError(400, `exclude must be at most ${MAX_EXCLUDE} file or directory names, without slashes or wildcards`)
	}
	return { userId: b.userId, repo: b.repo, key: b.key, sessionId: b.sessionId, exclude: [...new Set(exclude)].sort() }
}

export function checkOwner(userId, repo, repoOptional = false) {
	if (typeof userId !== 'string' || !USER_ID.test(userId)) throw new HttpError(400, 'userId required: 1-128 letters, digits or ._:@-')
	if (repoOptional && repo == null) return
	if (typeof repo !== 'string' || !REPO.test(repo)) throw new HttpError(400, 'repo required: 1-512 printable characters without spaces')
}

export function checkKey(key) {
	if (typeof key !== 'string' || !KEY.test(key)) throw new HttpError(400, 'key must be 16-128 lowercase hex characters')
}

// cfg: { dataDir, maxTotalWorkspaceMiB, snapshotMaxBytes, envCachePct }. `mounted()` returns the
// names of the cache volumes that live or starting sessions use.
export function createEnvCache({ docker, cfg, now = Date.now, mounted = () => new Set() }) {
	const root = path.join(cfg.dataDir, 'snapshots')
	const cacheIndex = path.join(cfg.dataDir, 'caches.json')
	const snaps = new Map() // `${userId}\0${key}` -> metadata
	const caches = new Map() // volume name -> {userId, repo, lastUsedAt, bytes}
	const restoring = new Map() // snapshot id -> restores reading it
	const flights = new Map() // snapshot id -> the creation in progress
	const maxBytes = cfg.snapshotMaxBytes ?? 4 * 1024 * MiB
	const keep = cfg.snapshotKeep ?? SNAPSHOT_KEEP
	const ttlMs = (cfg.snapshotTtlDays ?? SNAPSHOT_TTL_DAYS) * DAY
	let loaded
	let gcRun
	let saving = Promise.resolve()

	const idOf = (userId, key) => `${userId}\0${key}`
	const userDir = (userId) => path.join(root, createHash('sha256').update(`user:${userId}`).digest('hex').slice(0, 32))
	const filesOf = (m) => ({ data: path.join(userDir(m.userId), `${m.key}${FORMATS[m.format].ext}`), meta: path.join(userDir(m.userId), `${m.key}.json`) })
	const view = (m) => ({ key: m.key, repo: m.repo, size: m.size, sha256: m.sha256, format: m.format, contentBytes: m.contentBytes, excluded: m.excluded, exclude: m.exclude ?? [], omitted: m.omitted ?? 0, createdAt: m.createdAt, lastUsedAt: m.lastUsedAt })
	const notFound = () => new HttpError(404, 'no such snapshot', { code: 'snapshot_not_found' })

	async function writeAtomic(file, text) {
		const tmp = path.join(path.dirname(file), `.tmp-${randomBytes(6).toString('hex')}`)
		try {
			await fs.writeFile(tmp, text, { mode: 0o600, flush: true })
			await fs.rename(tmp, file)
		} finally {
			await fs.rm(tmp, { force: true })
		}
	}

	async function syncDir(dir) {
		const h = await fs.open(dir, 'r')
		await h.sync().catch(() => {})
		await h.close()
	}

	// Reads every committed snapshot and removes what an interrupted write left behind.
	async function load() {
		await fs.mkdir(root, { recursive: true, mode: 0o700 })
		for (const d of await fs.readdir(root)) {
			const dir = path.join(root, d)
			const names = await fs.readdir(dir).catch(() => [])
			const kept = new Set()
			for (const n of names.filter((x) => x.endsWith('.json'))) {
				try {
					const m = JSON.parse(await fs.readFile(path.join(dir, n), 'utf8'))
					const f = filesOf(m)
					if (f.meta !== path.join(dir, n)) throw new Error('misplaced')
					await fs.access(f.data)
					snaps.set(idOf(m.userId, m.key), m)
					kept.add(n).add(path.basename(f.data))
				} catch {}
			}
			for (const n of names) if (!kept.has(n)) await fs.rm(path.join(dir, n), { recursive: true, force: true })
		}
		try {
			for (const [k, v] of Object.entries(JSON.parse(await fs.readFile(cacheIndex, 'utf8')))) caches.set(k, v)
		} catch {}
	}
	const ready = () => (loaded ??= load())

	const saveCaches = () => (saving = saving.then(() => writeAtomic(cacheIndex, JSON.stringify(Object.fromEntries(caches)))).catch((e) => console.error('saving the cache index:', e.message)))

	function stats() {
		let snapshotBytes = 0
		for (const m of snaps.values()) snapshotBytes += m.size
		let cacheBytes = 0
		for (const c of caches.values()) cacheBytes += c.bytes ?? 0
		return { snapshotBytes, cacheBytes, snapshotCount: snaps.size }
	}
	const bytes = () => {
		const s = stats()
		return s.snapshotBytes + s.cacheBytes
	}
	// Snapshots and caches together may use this share of the workspace budget.
	const cap = () => (cfg.maxTotalWorkspaceMiB ? (cfg.maxTotalWorkspaceMiB * MiB * (cfg.envCachePct ?? 20)) / 100 : Number.POSITIVE_INFINITY)
	const overCap = () => bytes() > cap()

	function lookup(userId, repo, key) {
		const m = snaps.get(idOf(userId, key))
		if (!m || (repo != null && m.repo !== repo)) throw notFound()
		return m
	}

	async function drop(m) {
		snaps.delete(idOf(m.userId, m.key))
		const f = filesOf(m)
		await fs.rm(f.meta, { force: true })
		await fs.rm(f.data, { force: true })
	}

	async function build({ userId, repo, key, exclude = [] }, container) {
		const dir = userDir(userId)
		await fs.mkdir(dir, { recursive: true, mode: 0o700 })
		const m = { userId, repo, key, format: FORMAT }
		const f = filesOf(m)
		const tmp = path.join(dir, `.tmp-${randomBytes(6).toString('hex')}`)
		const policy = { fromDocker: true, stats: { excluded: 0, omitted: 0 }, omit: new Set(exclude) }
		const hash = createHash('sha256')
		let size = 0
		let content = 0
		let committed = false
		try {
			const archive = await docker.stream('GET', `/containers/${container}/archive?path=/workspace`)
			await pipeline(
				archive,
				async function* (src) {
					for await (const b of coalesce(transformTar(src, entryPolicy(policy)))) {
						content += b.length
						if (content > maxBytes) throw new HttpError(413, `the workspace snapshot is larger than ${maxBytes} bytes`, { code: 'snapshot_too_large', maxBytes })
						yield b
					}
				},
				FORMATS[FORMAT].compress(),
				async function* (src) {
					for await (const c of src) {
						hash.update(c)
						size += c.length
						yield c
					}
				},
				createWriteStream(tmp, { flags: 'wx', mode: 0o600, flush: true }),
			)
			await fs.rename(tmp, f.data)
			const t = now()
			Object.assign(m, { size, sha256: hash.digest('hex'), contentBytes: content, excluded: policy.stats.excluded, exclude, omitted: policy.stats.omitted, createdAt: t, lastUsedAt: t })
			await writeAtomic(f.meta, JSON.stringify(m))
			committed = true
			await syncDir(dir)
		} catch (e) {
			await fs.rm(tmp, { force: true })
			if (!committed) await fs.rm(f.data, { force: true })
			if (e instanceof HttpError) throw e
			throw new HttpError(502, `cannot read the workspace: ${e.message}`, { code: 'snapshot_failed' })
		}
		snaps.set(idOf(userId, key), m)
		return m
	}

	// Takes a snapshot of `container`'s /workspace, or returns the one already there for the key.
	// One creation runs per (userId, key); concurrent requests share it. `check` runs before a new
	// snapshot is written (the manager's free-disk check).
	async function create(req, container, check = async () => {}) {
		await ready()
		const id = idOf(req.userId, req.key)
		const existing = snaps.get(id)
		const pending = flights.get(id)
		if (existing || pending) {
			const m = existing ?? (await pending)
			if (m.repo !== req.repo) throw new HttpError(409, 'a snapshot with this key exists for another repo', { code: 'snapshot_conflict' })
			return { created: false, snapshot: view(m) }
		}
		const promise = (async () => {
			await check()
			if (overCap()) await gc()
			const m = await build(req, container)
			if (overCap()) await gc()
			return m
		})()
		flights.set(id, promise)
		try {
			return { created: true, snapshot: view(await promise) }
		} finally {
			flights.delete(id)
		}
	}

	async function list(userId, repo) {
		checkOwner(userId, repo, true)
		await ready()
		return [...snaps.values()].filter((m) => m.userId === userId && (repo == null || m.repo === repo)).sort((a, b) => b.createdAt - a.createdAt).map(view)
	}

	async function remove(userId, key) {
		checkOwner(userId, null, true)
		checkKey(key)
		await ready()
		const m = lookup(userId, null, key)
		if (restoring.has(idOf(userId, key))) throw new HttpError(409, 'the snapshot is being restored', { code: 'snapshot_in_use' })
		await drop(m)
		return { deleted: key }
	}

	// Throws 404 unless the user has this snapshot for this repo.
	async function find(userId, repo, key) {
		checkKey(key)
		await ready()
		return view(lookup(userId, repo, key))
	}

	// Verifies the snapshot's sha256, then extracts it into `container`'s /workspace through Docker,
	// which makes every file the container user's. The container is created and not started yet.
	async function restore({ userId, repo, key }, container) {
		await ready()
		const id = idOf(userId, key)
		const m = lookup(userId, repo, key)
		restoring.set(id, (restoring.get(id) ?? 0) + 1)
		try {
			const f = filesOf(m)
			const h = createHash('sha256')
			for await (const c of createReadStream(f.data)) h.update(c)
			if (h.digest('hex') !== m.sha256) {
				await drop(m)
				throw new HttpError(422, 'the snapshot is corrupt (sha256 mismatch) and was deleted', { code: 'snapshot_corrupt' })
			}
			let invalid
			const dec = FORMATS[m.format].decompress()
			pipeline(createReadStream(f.data), dec).catch(() => {})
			const body = Readable.from(
				(async function* () {
					try {
						yield* coalesce(transformTar(dec, entryPolicy()))
					} catch (e) {
						invalid = e
						throw e
					}
				})(),
			)
			try {
				const res = await docker.stream('PUT', `/containers/${container}/archive?path=/workspace&copyUIDGID=1`, { body, headers: { 'content-type': 'application/x-tar' } })
				res.resume()
				await finished(res)
			} catch (e) {
				if (invalid) throw new HttpError(422, `the snapshot is invalid: ${invalid.message}`, { code: 'snapshot_invalid' })
				throw e
			} finally {
				dec.destroy()
			}
			m.lastUsedAt = now()
			await writeAtomic(f.meta, JSON.stringify(m)).catch((e) => console.error('recording snapshot use:', e.message))
			return view(m)
		} finally {
			const n = restoring.get(id) - 1
			if (n) restoring.set(id, n)
			else restoring.delete(id)
		}
	}

	// Records that a session mounts this cache volume now.
	async function useCache(volume) {
		await ready()
		caches.set(volume.Name, { bytes: 0, ...caches.get(volume.Name), userId: volume.Labels[LABEL_CACHE_USER], repo: volume.Labels[LABEL_CACHE_REPO], lastUsedAt: now() })
		await saveCaches()
	}

	// Reads every cache volume's size from Docker, which also finds volumes the index lost and
	// forgets volumes that are gone. Docker before API 1.52 lists volumes in `Volumes`; 1.52 and
	// later list them, with `verbose`, in `VolumeUsage.Items`, and are dropping `Volumes`.
	async function measureCaches() {
		const df = await docker.request('GET', '/system/df?type=volume&verbose=1')
		// `Items` is left out when there are none.
		const volumes = df?.VolumeUsage ? (df.VolumeUsage.Items ?? []) : df?.Volumes
		if (!Array.isArray(volumes)) throw new Error('/system/df listed no volumes')
		const seen = new Set()
		for (const v of volumes) {
			if (!v.Labels?.[LABEL_CACHE]) continue
			seen.add(v.Name)
			const c = caches.get(v.Name) ?? { userId: v.Labels[LABEL_CACHE_USER], repo: v.Labels[LABEL_CACHE_REPO], lastUsedAt: now(), bytes: 0 }
			if (v.UsageData?.Size >= 0) c.bytes = v.UsageData.Size
			caches.set(v.Name, c)
		}
		for (const n of [...caches.keys()]) if (!seen.has(n)) caches.delete(n)
	}

	async function dropCache(name) {
		try {
			await docker.request('DELETE', `/volumes/${name}`)
		} catch (e) {
			if (!(e instanceof DockerError && e.status === 404)) throw e
		}
		caches.delete(name)
	}

	// Keeps the newest `keep` snapshots per (user, repo), deletes snapshots unused for the TTL, then
	// evicts the least recently used snapshots and unmounted caches while both together are over the
	// cap. A snapshot being restored and a cache a session mounts are never deleted.
	async function collect() {
		await ready()
		await measureCaches().catch((e) => console.error('measuring cache volumes:', e.message))
		const t = now()
		for (const n of mounted()) {
			const c = caches.get(n)
			if (c) c.lastUsedAt = t
		}
		const groups = new Map()
		for (const m of snaps.values()) {
			const g = idOf(m.userId, m.repo)
			groups.set(g, [...(groups.get(g) ?? []), m])
		}
		const doomed = new Set()
		for (const g of groups.values()) for (const m of g.sort((a, b) => b.createdAt - a.createdAt).slice(keep)) doomed.add(m)
		for (const m of snaps.values()) if (t - m.lastUsedAt > ttlMs) doomed.add(m)
		for (const m of doomed) if (!restoring.has(idOf(m.userId, m.key))) await drop(m)
		const skip = new Set()
		while (overCap()) {
			const busy = mounted()
			const candidates = [
				...[...snaps].filter(([id]) => !restoring.has(id)).map(([id, m]) => ({ id, at: m.lastUsedAt, drop: () => drop(m) })),
				...[...caches].filter(([n]) => !busy.has(n)).map(([n, c]) => ({ id: n, at: c.lastUsedAt, drop: () => dropCache(n) })),
			].filter((c) => !skip.has(c.id))
			const lru = candidates.sort((a, b) => a.at - b.at)[0]
			if (!lru) break
			await lru.drop().catch((e) => {
				console.error(`evicting ${lru.id}:`, e.message)
				skip.add(lru.id)
			})
		}
		await saveCaches()
	}
	const gc = () => (gcRun ??= collect().finally(() => (gcRun = undefined)))

	return { ready, create, list, remove, find, restore, useCache, gc, stats, bytes, overCap }
}
