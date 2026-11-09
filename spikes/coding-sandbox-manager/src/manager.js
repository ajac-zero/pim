// The sandbox-manager: one hardened gVisor container per session, driven through the Docker API.
import http from 'node:http'
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto'
import { statfs } from 'node:fs/promises'
import os from 'node:os'
import { DockerError } from './docker.js'
import { HttpError } from './errors.js'
import { LABEL, LABEL_SPEC, buildSpec, names, parseCreate, workspacePath } from './template.js'

const MAX_FILE = 32 * 1024 * 1024
const notFound = (e) => e instanceof DockerError && e.status === 404
const sha = (s) => createHash('sha256').update(s).digest()
const q = (s) => encodeURIComponent(s)

export const RUNSC_REQUIRED = 'gVisor (runsc) is required: register the runsc runtime with Docker and make sure `docker run --runtime=runsc` works'

export async function ensureImage(docker, image) {
	try {
		await docker.request('GET', `/images/${image}/json`)
	} catch (e) {
		if (!notFound(e)) throw e
		await docker.request('POST', `/images/create?fromImage=${q(image)}`)
	}
}

export async function hasRunsc(docker) {
	const info = await docker.request('GET', '/info')
	return Boolean(info?.Runtimes && 'runsc' in info.Runtimes)
}

// Throws unless Docker lists runsc AND a throwaway container actually runs under it.
export async function selfCheck(docker, probeImage) {
	if (!(await hasRunsc(docker))) throw new Error(`${RUNSC_REQUIRED} (runtime not listed by /info)`)
	const name = `pim-probe-${randomBytes(4).toString('hex')}`
	let id
	try {
		await ensureImage(docker, probeImage)
		;({ Id: id } = await docker.request('POST', `/containers/create?name=${name}`, {
			Image: probeImage,
			Cmd: ['true'],
			HostConfig: { Runtime: 'runsc', NetworkMode: 'none', ReadonlyRootfs: true, CapDrop: ['ALL'] },
		}))
		await docker.request('POST', `/containers/${id}/start`)
		const { StatusCode } = await docker.request('POST', `/containers/${id}/wait`)
		if (StatusCode !== 0) throw new Error(`probe exited with ${StatusCode}`)
	} catch (e) {
		throw new Error(`${RUNSC_REQUIRED} (probe container failed: ${e.message})`)
	} finally {
		if (id) await docker.request('DELETE', `/containers/${id}?force=true`).catch(() => {})
	}
}

// The default MAX_CONCURRENT: one session per CPU, each assumed to need 1.5 GiB of memory after
// reserving 1 GiB for the host, clamped to 1..8. For example 2 vCPU / 3 GiB gives 1, 4 / 16 gives 4.
export function defaultMaxConcurrent(cpus = os.cpus().length, totalMem = os.totalmem()) {
	const memGiB = totalMem / 2 ** 30
	return Math.min(8, Math.max(1, Math.min(cpus, Math.floor((memGiB - 1) / 1.5))))
}

// cfg: { token, allowedImages, dockerRoot, minFreePct, maxConcurrent, idleMin, proxyUrl,
//        proxyContainer, workspaceTmpfs }. proxyAdmin: { set(ip, hosts), del(ip) }.
export function createManager({ docker, cfg, proxyAdmin, statfsFn = statfs, now = Date.now }) {
	const sessions = new Map() // id -> {params, createdAt, lastUsed, ip, lock}
	const creating = new Map() // id -> Promise

	async function freeDiskPct() {
		const s = await statfsFn(cfg.dockerRoot)
		return (Number(s.bavail) / Number(s.blocks)) * 100
	}

	const view = (s) => ({ ...s.params, state: 'running', createdAt: s.createdAt, lastUsedAt: s.lastUsed })

	async function teardown(id, ip) {
		const n = names(id)
		const errors = []
		const step = async (fn) => {
			try {
				await fn()
			} catch (e) {
				if (!notFound(e)) errors.push(e)
			}
		}
		if (ip) await proxyAdmin.del(ip).catch(() => {})
		await step(() => docker.request('DELETE', `/containers/${n.container}?force=true&v=true`))
		await step(() => docker.request('POST', `/networks/${n.network}/disconnect`, { Container: cfg.proxyContainer, Force: true }))
		await step(() => docker.request('DELETE', `/networks/${n.network}`))
		await step(() => docker.request('DELETE', `/volumes/${n.volume}?force=true`))
		if (errors.length) throw errors[0]
	}

	async function doCreate(params) {
		const id = params.sessionId
		const n = names(id)
		try {
			await ensureImage(docker, params.image)
			// Docker's embedded DNS does not work under gVisor, so the session reaches the proxy by
			// IP: attach the proxy first, read its address on the session network, then create.
			const { volume, network } = buildSpec(params, cfg) // the container part is rebuilt below with the proxy IP
			await docker.request('POST', '/volumes/create', volume)
			await docker.request('POST', '/networks/create', network)
			await docker.request('POST', `/networks/${n.network}/connect`, { Container: cfg.proxyContainer, EndpointConfig: { Aliases: [cfg.proxyContainer] } })
			const proxyInfo = await docker.request('GET', `/containers/${cfg.proxyContainer}/json`)
			const proxyUrl = new URL(cfg.proxyUrl)
			proxyUrl.hostname = proxyInfo.NetworkSettings.Networks[n.network].IPAddress
			const container = buildSpec(params, { ...cfg, proxyUrl: proxyUrl.origin }).container
			await docker.request('POST', `/containers/create?name=${container.name}`, container.body)
			await docker.request('POST', `/containers/${container.name}/start`)
			const info = await docker.request('GET', `/containers/${container.name}/json`)
			const ip = info.NetworkSettings.Networks[n.network].IPAddress
			await proxyAdmin.set(ip, params.egressAllow)
			const s = { params, createdAt: now(), lastUsed: now(), ip, lock: Promise.resolve() }
			sessions.set(id, s)
			return s
		} catch (e) {
			await teardown(id).catch(() => {})
			throw e
		}
	}

	async function createSession(body) {
		const params = parseCreate(body, cfg.allowedImages)
		const existing = sessions.get(params.sessionId)
		const pending = creating.get(params.sessionId)
		if (existing || pending) {
			const s = existing ?? (await pending)
			if (JSON.stringify(s.params) !== JSON.stringify(params)) throw new HttpError(409, 'session exists with different parameters')
			s.lastUsed = now()
			return { created: false, session: view(s) }
		}
		// Check and reserve the slot in one synchronous step (no await in between), so concurrent
		// creates cannot pass the check together. Existing sessions over the limit are left alone.
		const running = sessions.size + creating.size
		if (running >= cfg.maxConcurrent) throw new HttpError(429, 'at capacity', { code: 'capacity', limit: cfg.maxConcurrent, running })
		const p = (async () => {
			const free = await freeDiskPct()
			if (free < cfg.minFreePct) throw new HttpError(507, `free disk ${free.toFixed(1)}% is below ${cfg.minFreePct}%`, { code: 'low_disk', freeDiskPct: Math.round(free * 10) / 10, minFreePct: cfg.minFreePct })
			return doCreate(params)
		})()
		creating.set(params.sessionId, p)
		try {
			return { created: true, session: view(await p) }
		} finally {
			creating.delete(params.sessionId)
		}
	}

	function get(id) {
		const s = sessions.get(id)
		if (!s) throw new HttpError(404, 'no such session')
		s.lastUsed = now()
		return s
	}

	// Serialised per session: a timeout kills every process of the sandbox user.
	function exec(s, opts) {
		const run = s.lock.then(() => docker.exec(names(s.params.sessionId).container, opts))
		s.lock = run.catch(() => {})
		return run
	}

	const FILE_SCRIPT = {
		// Resolve inside the container (following symlinks), then act only if still under /workspace.
		write: 'p=$(realpath -m -- "$1") || exit 70; case "$p" in /workspace/*) ;; *) exit 77;; esac; mkdir -p -- "$(dirname -- "$p")" && cat > "$p"',
		read: 'p=$(realpath -m -- "$1") || exit 70; case "$p" in /workspace/*) ;; *) exit 77;; esac; [ -f "$p" ] || exit 78; cat -- "$p"',
	}

	async function fileOp(s, kind, path, stdin) {
		const r = await exec(s, { cmd: ['sh', '-c', FILE_SCRIPT[kind], 'sh', workspacePath(path)], stdin, timeoutMs: 60000, maxOutput: MAX_FILE })
		if (r.timedOut) throw new HttpError(504, 'file operation timed out')
		if (r.exitCode === 77) throw new HttpError(403, 'path escapes /workspace')
		if (r.exitCode === 78) throw new HttpError(404, 'no such file')
		if (r.exitCode !== 0 || r.truncated) throw new HttpError(500, `file operation failed: ${r.stderr.toString().slice(0, 200)}`)
		return r.stdout
	}

	function parseExec(b) {
		if (!b || typeof b !== 'object') throw new HttpError(400, 'body must be an object')
		for (const k of Object.keys(b)) if (!['cmd', 'cwd', 'timeoutMs', 'stdin'].includes(k)) throw new HttpError(400, `unknown field ${k}`)
		if (!Array.isArray(b.cmd) || !b.cmd.length || b.cmd.length > 256 || !b.cmd.every((c) => typeof c === 'string')) throw new HttpError(400, 'cmd must be a non-empty string array')
		if (!Number.isInteger(b.timeoutMs) || b.timeoutMs < 1 || b.timeoutMs > 600000) throw new HttpError(400, 'timeoutMs must be an integer in [1, 600000]')
		if (b.stdin !== undefined && typeof b.stdin !== 'string') throw new HttpError(400, 'stdin must be a string')
		return { cmd: b.cmd, cwd: b.cwd === undefined ? '/workspace' : workspacePath(b.cwd), timeoutMs: b.timeoutMs, stdin: b.stdin }
	}

	async function remove(id) {
		const s = sessions.get(id)
		sessions.delete(id)
		await teardown(id, s?.ip)
	}

	// Rebuilds the registry from labels after a restart and removes half-created leftovers.
	async function reconcile() {
		const filters = q(JSON.stringify({ label: [LABEL] }))
		const containers = await docker.request('GET', `/containers/json?all=true&filters=${filters}`)
		const live = new Set()
		for (const c of containers) {
			const id = c.Labels[LABEL]
			try {
				const params = JSON.parse(c.Labels[LABEL_SPEC])
				if (c.State !== 'running') throw new Error('not running')
				const ip = c.NetworkSettings?.Networks?.[names(id).network]?.IPAddress
				await proxyAdmin.set(ip, params.egressAllow)
				sessions.set(id, { params, createdAt: c.Created * 1000, lastUsed: now(), ip, lock: Promise.resolve() })
				live.add(id)
			} catch {
				await teardown(id).catch(() => {})
			}
		}
		const vols = (await docker.request('GET', `/volumes?filters=${filters}`)).Volumes ?? []
		const nets = await docker.request('GET', `/networks?filters=${filters}`)
		for (const id of new Set([...vols, ...nets].map((o) => o.Labels?.[LABEL]).filter(Boolean))) if (!live.has(id)) await teardown(id).catch(() => {})
	}

	async function reap() {
		for (const [id, s] of [...sessions]) if (now() - s.lastUsed > cfg.idleMin * 60000) await remove(id).catch(() => {})
	}

	async function health() {
		const running = sessions.size + creating.size
		return {
			runsc: await hasRunsc(docker).catch(() => false),
			freeDiskPct: Math.round((await freeDiskPct().catch(() => NaN)) * 10) / 10,
			maxConcurrent: cfg.maxConcurrent,
			running,
			free: Math.max(0, cfg.maxConcurrent - running),
			sessions: sessions.size,
		}
	}

	const authorized = (req) => timingSafeEqual(sha(req.headers.authorization?.replace(/^Bearer /, '') ?? ''), sha(cfg.token))

	async function handle(req, res) {
		const url = new URL(req.url, 'http://x')
		const send = (code, body) => res.writeHead(code, { 'content-type': 'application/json' }).end(JSON.stringify(body))
		const raw = async (max) => {
			const chunks = []
			let n = 0
			for await (const c of req) {
				if ((n += c.length) > max) throw new HttpError(413, 'body too large')
				chunks.push(c)
			}
			return Buffer.concat(chunks)
		}
		const json = async () => {
			try {
				return JSON.parse((await raw(1024 * 1024)).toString() || 'null')
			} catch (e) {
				throw e instanceof HttpError ? e : new HttpError(400, 'invalid JSON')
			}
		}
		try {
			if (req.method === 'GET' && url.pathname === '/health') return send(200, await health())
			if (!authorized(req)) throw new HttpError(401, 'unauthorized')
			if (req.method === 'POST' && url.pathname === '/sessions') {
				const r = await createSession(await json())
				return send(r.created ? 201 : 200, r.session)
			}
			const m = /^\/sessions\/([a-z0-9-]+)(?:\/(exec|files))?$/.exec(url.pathname)
			if (!m) throw new HttpError(404, 'not found')
			const [, id, sub] = m
			if (!sub && req.method === 'GET') return send(200, view(get(id)))
			if (!sub && req.method === 'DELETE') return await remove(id), send(200, { deleted: id })
			if (sub === 'exec' && req.method === 'POST') {
				const r = await exec(get(id), parseExec(await json()))
				return send(200, { stdout: r.stdout.toString(), stderr: r.stderr.toString(), exitCode: r.exitCode, timedOut: r.timedOut, truncated: r.truncated })
			}
			if (sub === 'files' && req.method === 'PUT') {
				const body = await raw(MAX_FILE)
				await fileOp(get(id), 'write', url.searchParams.get('path'), body)
				return send(200, { ok: true })
			}
			if (sub === 'files' && req.method === 'GET') {
				const data = await fileOp(get(id), 'read', url.searchParams.get('path'))
				return res.writeHead(200, { 'content-type': 'application/octet-stream' }).end(data)
			}
			throw new HttpError(405, 'method not allowed')
		} catch (e) {
			if (e instanceof HttpError) return send(e.status, { error: e.message, ...e.extra })
			console.error(e)
			send(500, { error: 'internal error' })
		}
	}

	const server = http.createServer(handle)
	return { server, createSession, reconcile, reap, health, remove, sessions }
}
