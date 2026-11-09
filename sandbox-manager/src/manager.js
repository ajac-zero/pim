// The sandbox-manager: one hardened gVisor container per session, driven through the Docker API.
// Commands and files go to the workspace-agentd running inside each container.
import http from 'node:http'
import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto'
import { statfs } from 'node:fs/promises'
import os from 'node:os'
import * as agentd from './agentd.js'
import { DockerError } from './docker.js'
import { HttpError } from './errors.js'
import { AGENTD_PORT, LABEL, LABEL_KEPT, LABEL_KEPT_INFO, LABEL_NONCE, LABEL_SPEC, agentdPath, buildSpec, names, parseCreate, proxyEnv, workspacePath } from './template.js'

const MAX_FILE = 32 * 1024 * 1024
const MiB = 1024 * 1024
const notFound = (e) => e instanceof DockerError && e.status === 404
const sha = (s) => createHash('sha256').update(s).digest()
const q = (s) => encodeURIComponent(s)
const labelFilter = (label) => q(JSON.stringify({ label: [label] }))

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

// 'volume' when Docker's local volume driver accepts a size (an XFS project quota on its data
// root), otherwise 'measure': the manager measures each workspace and stops sessions over quota.
export async function detectQuotaMode(docker) {
	const name = `pim-quota-probe-${randomBytes(4).toString('hex')}`
	try {
		await docker.request('POST', '/volumes/create', { Name: name, Driver: 'local', DriverOpts: { size: '64m' } })
		return 'volume'
	} catch (e) {
		if (e instanceof DockerError) return 'measure'
		throw e
	} finally {
		await docker.request('DELETE', `/volumes/${name}`).catch(() => {})
	}
}

// The default MAX_CONCURRENT: one session per CPU, each assumed to need 1.5 GiB of memory after
// reserving 1 GiB for the host, clamped to 1..8. For example 2 vCPU / 3 GiB gives 1, 4 / 16 gives 4.
export function defaultMaxConcurrent(cpus = os.cpus().length, totalMem = os.totalmem()) {
	const memGiB = totalMem / 2 ** 30
	return Math.min(8, Math.max(1, Math.min(cpus, Math.floor((memGiB - 1) / 1.5))))
}

// cfg: { token, agentdSecret, allowedImages, defaultDiskMiB, dockerRoot, minFreePct, maxConcurrent,
//        maxTotalWorkspaceMiB, idleMin, keptVolumeDays, quotaMode, proxyUrl, proxyContainer,
//        managerContainer, agentdPort, agentdReadyMs, execGraceMs }.
// proxyAdmin: { set(ip, hosts), del(ip) }. agentdAddress maps a container IP to {host, port};
// tests point it at local fake daemons.
export function createManager({ docker, cfg, proxyAdmin, statfsFn = statfs, now = Date.now, agentdAddress }) {
	const sessions = new Map() // id -> {params, createdAt, lastUsed, ip, proxyIp, token, egress, disk}
	const creating = new Map() // id -> {params, promise}
	const kept = new Map() // id -> {params, keptAt, reason, diskBytes}: the volume outlives the container
	const selfIps = new Map() // session network -> this manager's address on it
	const agentdPort = cfg.agentdPort ?? AGENTD_PORT
	const graceMs = cfg.execGraceMs ?? 5000
	const address = agentdAddress ?? ((ip) => ({ host: ip, port: agentdPort }))
	let proxyStartedAt

	// The token is derived, not stored, so a restarted manager can still reach every agentd.
	const tokenFor = (id, nonce) => createHmac('sha256', cfg.agentdSecret).update(`${id}.${nonce}`).digest('hex')
	const target = (s) => ({ ...address(s.ip), token: s.token })

	async function freeDiskPct() {
		const s = await statfsFn(cfg.dockerRoot)
		return (Number(s.bavail) / Number(s.blocks)) * 100
	}

	const view = (s) => ({ ...s.params, state: 'running', createdAt: s.createdAt, lastUsedAt: s.lastUsed })
	// A kept workspace is 'stopped' (stop, or over its disk quota) or 'gone' (deleted with
	// keepVolume: the session no longer exists, only its volume does).
	const keptState = (k) => (k.reason === 'kept_volume' ? 'gone' : 'stopped')
	const keptView = (id, k) => ({ ...k.params, state: keptState(k), reason: k.reason, createdAt: k.createdAt ?? null, keptAt: k.keptAt, keptVolume: names(id).volume })

	// The session as GET /sessions/:id shows it: running, starting or stopped. 404 otherwise.
	function describe(id) {
		const s = sessions.get(id)
		if (s) return view(s)
		const c = creating.get(id)
		if (c) return { ...c.params, state: 'creating' }
		const k = kept.get(id)
		if (k && keptState(k) === 'stopped') return keptView(id, k)
		throw new HttpError(404, 'no such session')
	}

	// Every session the manager knows, from its registry (rebuilt from Docker labels at start).
	function list() {
		const all = [...sessions.values()].map(view)
		for (const c of creating.values()) all.push({ ...c.params, state: 'creating' })
		for (const [id, k] of kept) all.push(keptView(id, k))
		return all.sort((a, b) => (a.sessionId < b.sessionId ? -1 : 1))
	}

	// Connects `container` to each network it is not on yet (a recreated container has lost them)
	// and returns its address on every network it is on.
	async function attach(container, networks, alias) {
		let info = await docker.request('GET', `/containers/${container}/json`)
		const missing = networks.filter((n) => !info.NetworkSettings?.Networks?.[n])
		const errors = []
		for (const n of missing) {
			await docker.request('POST', `/networks/${n}/connect`, { Container: container, ...(alias && { EndpointConfig: { Aliases: [container] } }) }).catch((e) => errors.push(e))
		}
		if (missing.length) info = await docker.request('GET', `/containers/${container}/json`)
		if (errors.length) throw errors[0]
		const ips = Object.fromEntries(Object.entries(info.NetworkSettings?.Networks ?? {}).map(([n, v]) => [n, v.IPAddress]))
		return { ips, startedAt: info.State?.StartedAt, connected: missing }
	}

	async function attachSelf(networks) {
		if (!cfg.managerContainer) return
		const { ips } = await attach(cfg.managerContainer, networks)
		for (const n of networks) if (ips[n]) selfIps.set(n, ips[n])
	}

	// Removes what exists of a session. `keep` leaves the workspace volume; `keep.info` also
	// records it in a marker volume so it survives a manager restart.
	async function teardown(id, { ip, keep } = {}) {
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
		// A container that is not on the network (a recreated one) fails to disconnect; removing the
		// network below reports anything still attached.
		for (const c of [cfg.proxyContainer, cfg.managerContainer].filter(Boolean)) {
			await docker.request('POST', `/networks/${n.network}/disconnect`, { Container: c, Force: true }).catch(() => {})
		}
		selfIps.delete(n.network)
		await step(() => docker.request('DELETE', `/networks/${n.network}`))
		if (keep?.info) {
			await step(() => docker.request('DELETE', `/volumes/${n.marker}`))
			await step(() => docker.request('POST', '/volumes/create', { Name: n.marker, Labels: { [LABEL_KEPT]: id, [LABEL_KEPT_INFO]: JSON.stringify(keep.info) } }))
		} else if (!keep) {
			await step(() => docker.request('DELETE', `/volumes/${n.volume}?force=true`))
			await step(() => docker.request('DELETE', `/volumes/${n.marker}`))
		}
		if (errors.length) throw errors[0]
	}

	async function doCreate(params) {
		const id = params.sessionId
		const n = names(id)
		const resuming = kept.has(id)
		try {
			await ensureImage(docker, params.image)
			const nonce = randomBytes(12).toString('hex')
			const token = tokenFor(id, nonce)
			const base = { quotaMode: cfg.quotaMode, nonce, token, agentdPort }
			// Creating a volume that exists returns it, so a kept workspace is reused as it is.
			const { volume, network } = buildSpec(params, { ...base, proxyUrl: cfg.proxyUrl })
			await docker.request('POST', '/volumes/create', volume)
			await docker.request('POST', '/networks/create', network)
			// Docker's embedded DNS does not work under gVisor, so the session reaches the proxy by
			// IP: attach the proxy first, read its address on the session network, then create.
			const proxyIp = (await attach(cfg.proxyContainer, [n.network], true)).ips[n.network]
			await attachSelf([n.network])
			const container = buildSpec(params, { ...base, proxyUrl: proxyUrlFor(proxyIp) }).container
			await docker.request('POST', `/containers/create?name=${container.name}`, container.body)
			await docker.request('POST', `/containers/${container.name}/start`)
			const info = await docker.request('GET', `/containers/${container.name}/json`)
			const ip = info.NetworkSettings.Networks[n.network].IPAddress
			await proxyAdmin.set(ip, params.egressAllow)
			const s = { params, createdAt: kept.get(id)?.createdAt ?? now(), lastUsed: now(), ip, proxyIp, token, egress: true, disk: null }
			await agentd.ready(target(s), cfg.agentdReadyMs ?? 30000)
			if (resuming) {
				await docker.request('DELETE', `/volumes/${n.marker}`).catch(() => {})
				kept.delete(id)
			}
			sessions.set(id, s)
			return s
		} catch (e) {
			await teardown(id, { keep: resuming }).catch(() => {})
			throw e
		}
	}

	function proxyUrlFor(ip) {
		const u = new URL(cfg.proxyUrl)
		u.hostname = ip
		return u.origin
	}

	// Disk promised to workspaces: the quota of every live, starting and kept workspace.
	function reservedMiB(except) {
		let sum = 0
		for (const [id, x] of [...sessions, ...creating, ...kept]) if (id !== except) sum += x.params.limits.diskMiB
		return sum
	}

	async function createSession(body) {
		const params = parseCreate(body, cfg.allowedImages, cfg.defaultDiskMiB)
		const id = params.sessionId
		const existing = sessions.get(id)
		const pending = creating.get(id)
		if (existing || pending) {
			const s = existing ?? (await pending.promise)
			if (JSON.stringify(s.params) !== JSON.stringify(params)) throw new HttpError(409, 'session exists with different parameters')
			s.lastUsed = now()
			return { created: false, session: view(s) }
		}
		return { created: true, session: view(await launch(params)) }
	}

	// Starts a container for `params`, reusing a kept volume of the same session.
	async function launch(params) {
		const id = params.sessionId
		// Check and reserve the slot in one synchronous step (no await in between), so concurrent
		// creates cannot pass the checks together. Existing sessions over the limit are left alone.
		const running = sessions.size + creating.size
		if (running >= cfg.maxConcurrent) throw new HttpError(429, 'at capacity', { code: 'capacity', limit: cfg.maxConcurrent, running })
		const reserved = reservedMiB(id)
		if (cfg.maxTotalWorkspaceMiB && reserved + params.limits.diskMiB > cfg.maxTotalWorkspaceMiB) {
			throw new HttpError(507, `workspace disk would exceed ${cfg.maxTotalWorkspaceMiB} MiB`, { code: 'workspace_quota', reservedMiB: reserved, requestedMiB: params.limits.diskMiB, maxTotalMiB: cfg.maxTotalWorkspaceMiB })
		}
		const promise = (async () => {
			const free = await freeDiskPct()
			if (free < cfg.minFreePct) throw new HttpError(507, `free disk ${free.toFixed(1)}% is below ${cfg.minFreePct}%`, { code: 'low_disk', freeDiskPct: Math.round(free * 10) / 10, minFreePct: cfg.minFreePct })
			return doCreate(params)
		})()
		creating.set(id, { params, promise })
		try {
			return await promise
		} finally {
			creating.delete(id)
		}
	}

	function get(id) {
		const s = sessions.get(id)
		if (s) {
			s.lastUsed = now()
			return s
		}
		const k = kept.get(id)
		if (k?.reason === 'over_disk_quota') throw new HttpError(409, 'session was stopped: its workspace went over its disk quota', { code: 'over_disk_quota' })
		if (k?.reason === 'stopped') throw new HttpError(409, 'session is stopped; start it first', { code: 'session_stopped' })
		throw new HttpError(404, 'no such session')
	}

	// Removes the container and network and keeps the volume, recording why in a marker volume.
	async function keep(id, reason) {
		const s = sessions.get(id)
		const k = kept.get(id)
		sessions.delete(id)
		const params = s?.params ?? k?.params
		const info = params && { params, createdAt: s?.createdAt ?? k?.createdAt ?? null, keptAt: now(), reason, diskBytes: s?.disk?.rootBytes ?? k?.diskBytes ?? null }
		if (info) kept.set(id, info)
		await teardown(id, { ip: s?.ip, keep: info ? { info } : true })
	}

	// Stops a session and keeps its files; stopping a stopped session does nothing.
	async function stop(id) {
		await creating.get(id)?.promise.catch(() => {})
		if (sessions.has(id)) await keep(id, 'stopped')
		return describe(id)
	}

	// Starts a stopped session again with its parameters, through the same limits as a create.
	async function start(id) {
		const k = kept.get(id)
		if (!sessions.has(id) && !creating.has(id) && k && keptState(k) === 'stopped') await launch(k.params)
		await creating.get(id)?.promise
		return describe(id)
	}

	// Each exec runs in its own process group inside agentd, so a timeout kills only that exec.
	// The proxy variables are passed each time because a re-attached proxy can change address.
	const execSpec = (s, opts) => ({ ...opts, cwd: agentdPath(opts.cwd), env: { ...proxyEnv(proxyUrlFor(s.proxyIp)), ...opts.env } })

	function parseExec(b) {
		if (!b || typeof b !== 'object') throw new HttpError(400, 'body must be an object')
		for (const k of Object.keys(b)) if (!['cmd', 'cwd', 'timeoutMs', 'stdin', 'env'].includes(k)) throw new HttpError(400, `unknown field ${k}`)
		if (!Array.isArray(b.cmd) || !b.cmd.length || b.cmd.length > 256 || !b.cmd.every((c) => typeof c === 'string')) throw new HttpError(400, 'cmd must be a non-empty string array')
		if (!Number.isInteger(b.timeoutMs) || b.timeoutMs < 1 || b.timeoutMs > 600000) throw new HttpError(400, 'timeoutMs must be an integer in [1, 600000]')
		if (b.stdin !== undefined && typeof b.stdin !== 'string') throw new HttpError(400, 'stdin must be a string')
		const env = b.env ?? {}
		if (typeof env !== 'object' || Array.isArray(env) || Object.keys(env).length > 256 || !Object.entries(env).every(([k, v]) => /^[A-Za-z_][A-Za-z0-9_]*$/.test(k) && typeof v === 'string')) {
			throw new HttpError(400, 'env must map variable names to strings')
		}
		return { cmd: b.cmd, cwd: b.cwd === undefined ? '/workspace' : workspacePath(b.cwd), timeoutMs: b.timeoutMs, stdin: b.stdin, env }
	}

	const fileQuery = (p, extra = '') => `?path=${q(agentdPath(workspacePath(p)))}${extra}`

	// Removes a session. With keepVolume the workspace volume stays (and is reused when the same
	// sessionId is created again) until a plain delete or the kept-volume reaper removes it.
	async function remove(id, keepVolume = false) {
		if (keepVolume) {
			await keep(id, 'kept_volume')
			return { deleted: id, keptVolume: names(id).volume }
		}
		const s = sessions.get(id)
		sessions.delete(id)
		kept.delete(id)
		await teardown(id, { ip: s?.ip })
		return { deleted: id }
	}

	async function measure(s) {
		const st = await agentd.json(target(s), 'GET', '/status', { idleMs: 10000 })
		s.disk = { rootBytes: st.rootBytes, diskFreeBytes: st.diskFreeBytes, activeExecs: st.activeExecs, measuredAt: now() }
		return s.disk
	}

	// In 'measure' mode nothing stops a write past the quota, so the manager refuses one that would
	// take the workspace (as last measured, at most 5 s ago) over it. The other modes leave it to the
	// filesystem, which agentd reports as disk_full too.
	async function checkWrite(s, bytes) {
		if (cfg.quotaMode !== 'measure') return
		if (!s.disk || now() - s.disk.measuredAt > 5000) await measure(s).catch(() => {})
		const used = s.disk?.rootBytes ?? 0
		const quota = s.params.limits.diskMiB * MiB
		if (used + bytes > quota) throw new HttpError(507, 'the write would take the workspace over its disk quota', { code: 'disk_full', diskBytes: used, diskQuotaBytes: quota })
	}

	// Measures every workspace. In 'measure' mode nothing else bounds a workspace, so a session
	// over its quota is stopped: its container goes, its volume is kept for inspection or resume.
	async function checkDisk() {
		for (const [id, s] of [...sessions]) {
			const d = await measure(s).catch(() => null)
			const quota = s.params.limits.diskMiB * MiB
			if (!d || cfg.quotaMode !== 'measure' || d.rootBytes <= quota || sessions.get(id) !== s) continue
			console.warn(`session ${id} stopped: workspace uses ${d.rootBytes} bytes, quota ${quota}`)
			await keep(id, 'over_disk_quota').catch((e) => console.error(`stopping ${id}:`, e.message))
		}
	}

	async function status(id) {
		const base = (params) => ({ sessionId: id, quotaMode: cfg.quotaMode, diskQuotaBytes: params.limits.diskMiB * MiB })
		const s = sessions.get(id)
		if (s) {
			let error
			await measure(s).catch((e) => (error = e.message))
			const d = s.disk ?? {}
			return { ...base(s.params), state: 'running', reason: null, diskBytes: d.rootBytes ?? null, diskFreeBytes: d.diskFreeBytes ?? null, activeExecs: d.activeExecs ?? null, measuredAt: d.measuredAt ?? null, ...(error && { error }) }
		}
		const c = creating.get(id)
		if (c) return { ...base(c.params), state: 'creating', reason: null, diskBytes: null, diskFreeBytes: null, activeExecs: null, measuredAt: null }
		const k = kept.get(id)
		if (k) return { ...base(k.params), state: keptState(k), reason: k.reason, diskBytes: k.diskBytes, diskFreeBytes: null, activeExecs: null, measuredAt: null, keptAt: k.keptAt }
		throw new HttpError(404, 'no such session')
	}

	// Makes sure the egress proxy (and this manager, when it runs in a container) is on every live
	// session network, and re-registers allowlists the proxy may have lost. A recreated container
	// has lost its network attachments and a restarted proxy has lost its allowlists.
	async function reattach() {
		const nets = [...sessions.values()].map((s) => names(s.params.sessionId).network)
		const proxy = await attach(cfg.proxyContainer, nets, true)
		const restarted = proxy.startedAt !== proxyStartedAt
		proxyStartedAt = proxy.startedAt
		await attachSelf(nets)
		for (const s of sessions.values()) {
			const net = names(s.params.sessionId).network
			s.proxyIp = proxy.ips[net] ?? s.proxyIp
			if (restarted || proxy.connected.includes(net) || !s.egress) {
				s.egress = await proxyAdmin.set(s.ip, s.params.egressAllow).then(() => true, () => false)
			}
		}
	}

	// Rebuilds the registry from labels after a restart and removes half-created leftovers.
	async function reconcile() {
		const containers = await docker.request('GET', `/containers/json?all=true&filters=${labelFilter(LABEL)}`)
		const live = new Set()
		for (const c of containers) {
			const id = c.Labels[LABEL]
			try {
				const params = JSON.parse(c.Labels[LABEL_SPEC])
				const nonce = c.Labels[LABEL_NONCE]
				const ip = c.NetworkSettings?.Networks?.[names(id).network]?.IPAddress
				if (c.State !== 'running' || !nonce || !ip) throw new Error('not running')
				sessions.set(id, { params, createdAt: c.Created * 1000, lastUsed: now(), ip, proxyIp: null, token: tokenFor(id, nonce), egress: false, disk: null })
				live.add(id)
			} catch {
				await teardown(id).catch(() => {})
			}
		}
		for (const v of (await docker.request('GET', `/volumes?filters=${labelFilter(LABEL_KEPT)}`)).Volumes ?? []) {
			const id = v.Labels[LABEL_KEPT]
			if (live.has(id)) await docker.request('DELETE', `/volumes/${v.Name}`).catch(() => {}) // a resume that finished
			else {
				try {
					kept.set(id, JSON.parse(v.Labels[LABEL_KEPT_INFO]))
				} catch {
					await docker.request('DELETE', `/volumes/${v.Name}`).catch(() => {})
				}
			}
		}
		const vols = (await docker.request('GET', `/volumes?filters=${labelFilter(LABEL)}`)).Volumes ?? []
		const nets = await docker.request('GET', `/networks?filters=${labelFilter(LABEL)}`)
		for (const id of new Set([...vols, ...nets].map((o) => o.Labels?.[LABEL]).filter(Boolean))) {
			if (!live.has(id)) await teardown(id, { keep: kept.has(id) }).catch(() => {})
		}
		// The periodic reattach retries if the proxy is not up yet.
		await reattach().catch((e) => console.error('re-attaching session networks:', e.message))
	}

	async function reap() {
		for (const [id, s] of [...sessions]) if (now() - s.lastUsed > cfg.idleMin * 60000) await remove(id).catch(() => {})
		if (!cfg.keptVolumeDays) return
		for (const [id, k] of [...kept]) if (now() - k.keptAt > cfg.keptVolumeDays * 86400000) await remove(id).catch(() => {})
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
	// The manager's own address on a session network is reachable from inside the session; nothing
	// is served there.
	const fromSessionNetwork = (req) => [...selfIps.values()].includes(req.socket.localAddress?.replace(/^::ffff:/, ''))

	async function handle(req, res) {
		if (fromSessionNetwork(req)) return req.socket.destroy()
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
		const path = () => url.searchParams.get('path')
		try {
			if (req.method === 'GET' && url.pathname === '/health') return send(200, await health())
			if (!authorized(req)) throw new HttpError(401, 'unauthorized')
			if (url.pathname === '/sessions') {
				if (req.method === 'GET') return send(200, list())
				if (req.method !== 'POST') throw new HttpError(405, 'method not allowed')
				const r = await createSession(await json())
				return send(r.created ? 201 : 200, r.session)
			}
			const m = /^\/sessions\/([a-z0-9-]+)(?:\/(exec|exec\/stream|files?|list|stat|status|stop|start))?$/.exec(url.pathname)
			if (!m) throw new HttpError(404, 'not found')
			const [, id, sub = ''] = m
			// `files` is the older spelling of `file`.
			const route = `${req.method} ${sub === 'files' ? 'file' : sub}`
			if (route === 'GET ') return send(200, describe(id))
			if (route === 'DELETE ') return send(200, await remove(id, ['1', 'true'].includes(url.searchParams.get('keepVolume'))))
			if (route === 'GET status') return send(200, await status(id))
			if (route === 'POST stop') return send(200, await stop(id))
			if (route === 'POST start') return send(200, await start(id))
			if (route === 'POST exec') {
				const s = get(id)
				return send(200, await agentd.exec(target(s), execSpec(s, parseExec(await json())), graceMs))
			}
			if (route === 'POST exec/stream') {
				const s = get(id)
				const spec = execSpec(s, parseExec(await json()))
				// A client that goes away aborts the request to agentd, which then kills the command.
				const gone = new AbortController()
				res.on('close', () => gone.abort())
				const events = await agentd.startExec(target(s), spec, graceMs, gone.signal)
				res.writeHead(200, { 'content-type': 'application/x-ndjson', 'cache-control': 'no-store' })
				res.flushHeaders()
				// A silent command (a device-code sign-in polling for minutes) would hit Cloudflare's 100 s idle limit (524): a blank line, which clients skip, keeps the stream alive and the session in use.
				const beat = setInterval(() => {
					s.lastUsed = now()
					if (!res.writableEnded) res.write('\n')
				}, 15000)
				try {
					for await (const ev of events) res.write(`${JSON.stringify(ev)}\n`)
				} finally {
					clearInterval(beat)
				}
				return res.end()
			}
			if (route === 'PUT file') {
				const s = get(id)
				const mode = url.searchParams.get('mode')
				if (mode !== null && !/^[0-7]{3,4}$/.test(mode)) throw new HttpError(400, 'mode must be octal, such as 0644')
				const query = fileQuery(path(), mode === null ? '' : `&mode=${mode}`)
				const body = await raw(MAX_FILE)
				await checkWrite(s, body.length)
				await agentd.json(target(s), 'PUT', `/file${query}`, { body, headers: { 'content-type': 'application/octet-stream', 'content-length': body.length } })
				if (s.disk) s.disk.rootBytes += body.length
				return send(200, { ok: true })
			}
			if (route === 'GET file') {
				const s = get(id)
				const r = await agentd.request(target(s), 'GET', `/file${fileQuery(path())}`)
				if (r.statusCode !== 200) await agentd.fail(r)
				res.writeHead(200, { 'content-type': 'application/octet-stream', ...(r.headers['content-length'] && { 'content-length': r.headers['content-length'] }) })
				r.on('error', () => res.destroy())
				return r.pipe(res)
			}
			if (route === 'DELETE file') {
				const s = get(id)
				const recursive = ['1', 'true'].includes(url.searchParams.get('recursive')) ? '&recursive=1' : ''
				await agentd.json(target(s), 'DELETE', `/file${fileQuery(path(), recursive)}`)
				return send(200, { ok: true })
			}
			if (route === 'GET list') return send(200, await agentd.json(target(get(id)), 'GET', `/list${fileQuery(path() ?? '/workspace')}`))
			if (route === 'GET stat') return send(200, await agentd.json(target(get(id)), 'GET', `/stat${fileQuery(path())}`))
			throw new HttpError(405, 'method not allowed')
		} catch (e) {
			if (res.headersSent) return res.destroy()
			if (e instanceof HttpError) return send(e.status, { error: e.message, ...e.extra })
			console.error(e)
			send(500, { error: 'internal error' })
		}
	}

	const server = http.createServer(handle)
	return { server, createSession, start, stop, list, reconcile, reattach, reap, checkDisk, status, health, remove, sessions, kept }
}
