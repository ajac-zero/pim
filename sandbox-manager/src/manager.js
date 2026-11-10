// The sandbox-manager: one hardened gVisor container per session, driven through the Docker API.
// Commands and files go to the workspace-agentd running inside each container.
import http from 'node:http'
import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto'
import { mkdir, rename, statfs, readFile, writeFile } from 'node:fs/promises'
import { readFileSync } from 'node:fs'
import os from 'node:os'
import { fileURLToPath } from 'node:url'
import path from 'node:path'
import * as agentd from './agentd.js'
import { DockerError } from './docker.js'
import { HttpError } from './errors.js'
import { checkKey, checkOwner, createEnvCache, parseSnapshot } from './snapshots.js'
import { AGENTD_PORT, LABEL, LABEL_KEPT, LABEL_KEPT_INFO, LABEL_NONCE, LABEL_SPEC, agentdPath, buildSpec, cacheVolume, names, parseCreate, proxyEnv, workspacePath } from './template.js'

const MAX_FILE = 32 * 1024 * 1024
// An exec id, as agentd takes it (workspace-agentd/exec.mjs).
const EXEC_ID = /^[A-Za-z0-9_-]{8,128}$/
const MiB = 1024 * 1024
const notFound = (e) => e instanceof DockerError && e.status === 404
const sha = (s) => createHash('sha256').update(s).digest()
const q = (s) => encodeURIComponent(s)
const labelFilter = (label) => q(JSON.stringify({ label: [label] }))

// Returns the build SHA from BUILD_SHA env var, or from .build-sha file next to src/, or 'unknown'.
async function getBuildSha() {
	const envSha = process.env.BUILD_SHA
	if (envSha) return envSha
	const __dirname = path.dirname(fileURLToPath(import.meta.url))
	const buildShaPath = path.resolve(__dirname, '../.build-sha')
	try {
		return (await readFile(buildShaPath, 'utf8')).trim()
	} catch {
		return 'unknown'
	}
}

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
const validLimit = (n) => Number.isInteger(n) && n >= 1 && n <= 16

export function defaultMaxConcurrent(cpus = os.cpus().length, totalMem = os.totalmem()) {
	const memGiB = totalMem / 2 ** 30
	return Math.min(8, Math.max(1, Math.min(cpus, Math.floor((memGiB - 1) / 1.5))))
}

// cfg: { token, agentdSecret, allowedImages, defaultDiskMiB, dockerRoot, minFreePct, maxConcurrent,
//        maxTotalWorkspaceMiB, idleMin, keptVolumeDays, quotaMode, proxyUrl, proxyContainer,
//        managerContainer, agentdPort, agentdReadyMs, execGraceMs, dataDir, snapshotMaxBytes,
//        envCachePct, maxConcurrentSource ('env' or 'default', default 'default') }.
// A maxConcurrent set through PUT /config is kept in DATA_DIR/config.json and wins over cfg.
// proxyAdmin: { set(ip, hosts), del(ip) }. agentdAddress maps a container IP to {host, port};
// tests point it at local fake daemons.
export function createManager({ docker, cfg, proxyAdmin, statfsFn = statfs, now = Date.now, agentdAddress }) {
	const sessions = new Map() // id -> {params, createdAt, lastUsed, ip, proxyIp, token, egress, disk}
	const creating = new Map() // id -> {params, promise}
	const kept = new Map() // id -> {params, keptAt, reason, diskBytes}: the volume outlives the container
	// Session containers a restarted manager found but could not take over or clean up yet: running
	// without an address, paused, half-created and still young, or unreadable. Nothing of theirs is
	// removed while they are here; the periodic reattach looks at them again.
	const unsettled = new Set()
	const selfIps = new Map() // session network -> this manager's address on it
	const agentdPort = cfg.agentdPort ?? AGENTD_PORT
	const graceMs = cfg.execGraceMs ?? 5000
	const leftoverGraceMs = cfg.leftoverGraceMs ?? 60000
	const ipWaitMs = cfg.ipWaitMs ?? 5000
	const address = agentdAddress ?? ((ip) => ({ host: ip, port: agentdPort }))
	let proxyStartedAt
	// The slot limit: cfg.maxConcurrent (MAX_CONCURRENT or derived) until PUT /config sets one.
	const configFile = path.join(cfg.dataDir, 'config.json')
	let runtimeMax
	try {
		runtimeMax = JSON.parse(readFileSync(configFile, 'utf8')).maxConcurrent
		if (!validLimit(runtimeMax)) throw new Error('maxConcurrent must be an integer from 1 to 16')
	} catch (e) {
		if (e.code !== 'ENOENT') console.error(`ignoring ${configFile}:`, e.message)
		runtimeMax = undefined
	}
	const limit = () => runtimeMax ?? cfg.maxConcurrent
	const configView = () => ({
		maxConcurrent: limit(),
		source: runtimeMax !== undefined ? 'runtime' : (cfg.maxConcurrentSource ?? 'default'),
		envValue: cfg.maxConcurrentSource === 'env' ? cfg.maxConcurrent : null,
	})
	async function setConfig(body) {
		if (!body || typeof body !== 'object' || Array.isArray(body) || Object.keys(body).some((k) => k !== 'maxConcurrent')) throw new HttpError(400, 'body must be {maxConcurrent}')
		if (!validLimit(body.maxConcurrent)) throw new HttpError(400, 'maxConcurrent must be an integer from 1 to 16')
		await mkdir(cfg.dataDir, { recursive: true })
		const tmp = `${configFile}.${process.pid}.${randomBytes(4).toString('hex')}.tmp`
		await writeFile(tmp, JSON.stringify({ maxConcurrent: body.maxConcurrent }), { flush: true })
		await rename(tmp, configFile)
		runtimeMax = body.maxConcurrent
		return configView()
	}
	// The cache volumes of live and starting sessions, which the env cache's GC never evicts.
	const mounted = () => new Set([...sessions.values(), ...creating.values()].map((x) => cacheVolume(x.params)?.Name).filter(Boolean))
	const env = createEnvCache({ docker, cfg, now, mounted })

	// The token is derived, not stored in a label. A restarted manager reads it back from the
	// container's environment, so it reaches every agentd even when the secret has changed since.
	const tokenFor = (id, nonce) => createHmac('sha256', cfg.agentdSecret).update(`${id}.${nonce}`).digest('hex')
	const target = (s) => {
		if (!s.ip) throw new HttpError(503, 'the session is reconnecting; try again shortly', { code: 'session_reconnecting' })
		return { ...address(s.ip), token: s.token }
	}

	async function freeDiskPct() {
		const s = await statfsFn(cfg.dockerRoot)
		return (Number(s.bavail) / Number(s.blocks)) * 100
	}

	const view = (s) => ({ ...s.params, state: 'running', createdAt: s.createdAt, lastUsedAt: s.lastUsed, ...(s.restoredFrom && { restoredFrom: s.restoredFrom }) })
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
	// and returns its address on every network it is on. A network it cannot join is in `failed`
	// and does not keep it from joining the others.
	async function attach(container, networks, alias) {
		let info = await docker.request('GET', `/containers/${container}/json`)
		const missing = networks.filter((n) => !info.NetworkSettings?.Networks?.[n])
		const failed = new Map()
		for (const n of missing) {
			await docker.request('POST', `/networks/${n}/connect`, { Container: container, ...(alias && { EndpointConfig: { Aliases: [container] } }) }).catch((e) => failed.set(n, e))
		}
		if (missing.length) info = await docker.request('GET', `/containers/${container}/json`)
		const ips = Object.fromEntries(Object.entries(info.NetworkSettings?.Networks ?? {}).map(([n, v]) => [n, v.IPAddress]))
		return { ips, startedAt: info.State?.StartedAt, connected: missing.filter((n) => !failed.has(n)), failed }
	}
	const joined = (r) => {
		for (const e of r.failed.values()) throw e
		return r
	}

	async function attachSelf(networks) {
		if (!cfg.managerContainer) return { ips: {}, failed: new Map() }
		const r = await attach(cfg.managerContainer, networks)
		for (const n of networks) if (r.ips[n]) selfIps.set(n, r.ips[n])
		return r
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
		// The marker goes first, so a manager stopped halfway leaves a marked volume, never an
		// unmarked one that the next start would take for a leftover.
		if (keep?.info) {
			await step(() => docker.request('DELETE', `/volumes/${n.marker}`))
			await step(() => docker.request('POST', '/volumes/create', { Name: n.marker, Labels: { [LABEL_KEPT]: id, [LABEL_KEPT_INFO]: JSON.stringify(keep.info) } }))
		}
		await step(() => docker.request('DELETE', `/containers/${n.container}?force=true&v=true`))
		// A container that is not on the network (a recreated one) fails to disconnect; removing the
		// network below reports anything still attached.
		for (const c of [cfg.proxyContainer, cfg.managerContainer].filter(Boolean)) {
			await docker.request('POST', `/networks/${n.network}/disconnect`, { Container: c, Force: true }).catch(() => {})
		}
		selfIps.delete(n.network)
		await step(() => docker.request('DELETE', `/networks/${n.network}`))
		if (!keep) {
			await step(() => docker.request('DELETE', `/volumes/${n.volume}?force=true`))
			await step(() => docker.request('DELETE', `/volumes/${n.marker}`))
		}
		if (errors.length) throw errors[0]
	}

	// `restoreFrom` ({key}) fills a new workspace from the user's snapshot before the container starts.
	async function doCreate(params, restoreFrom) {
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
			const cache = cacheVolume(params)
			if (cache) {
				await docker.request('POST', '/volumes/create', cache)
				await env.useCache(cache)
			}
			await docker.request('POST', '/networks/create', network)
			// Docker's embedded DNS does not work under gVisor, so the session reaches the proxy by
			// IP: attach the proxy first, read its address on the session network, then create.
			const proxyIp = joined(await attach(cfg.proxyContainer, [n.network], true)).ips[n.network]
			joined(await attachSelf([n.network]))
			const container = buildSpec(params, { ...base, proxyUrl: proxyUrlFor(proxyIp) }).container
			await docker.request('POST', `/containers/create?name=${container.name}`, container.body)
			// A resumed workspace keeps its own files.
			const restored = restoreFrom && !resuming && (await env.restore({ userId: params.userId, repo: params.repo, key: restoreFrom.key }, container.name))
			await docker.request('POST', `/containers/${container.name}/start`)
			const info = await docker.request('GET', `/containers/${container.name}/json`)
			const ip = info.NetworkSettings.Networks[n.network].IPAddress
			await proxyAdmin.set(ip, params.egressAllow)
			const s = { params, createdAt: kept.get(id)?.createdAt ?? now(), lastUsed: now(), ip, proxyIp, token, egress: true, disk: null, ...(restored && { restoredFrom: restored.key }) }
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

	// What a kept workspace holds back: the bytes it uses when they are known (never more than its
	// quota), else its whole quota. Live and starting workspaces hold their whole quota, since they
	// may grow into it.
	const keptMiB = (k) => {
		const quota = k.params.limits.diskMiB
		return typeof k.diskBytes === 'number' ? Math.min(quota, Math.max(1, Math.ceil(k.diskBytes / MiB))) : quota
	}

	// Disk promised to workspaces, by what holds it: live and starting workspaces, kept ones, and
	// snapshots and cache volumes.
	function reservation(except) {
		const r = { liveMiB: 0, live: 0, keptMiB: 0, kept: 0, envMiB: Math.ceil(env.bytes() / MiB) }
		for (const [id, x] of [...sessions, ...creating]) if (id !== except) (r.liveMiB += x.params.limits.diskMiB, r.live++)
		for (const [id, k] of kept) if (id !== except) (r.keptMiB += keptMiB(k), r.kept++)
		r.totalMiB = r.liveMiB + r.keptMiB + r.envMiB
		return r
	}
	const reservedMiB = (except) => reservation(except).totalMiB

	// Reads what kept workspaces really use from Docker, and forgets kept entries whose volume is
	// gone, so a stale entry cannot hold quota for good.
	async function reconcileKept() {
		if (!kept.size) return
		const df = await docker.request('GET', '/system/df?type=volume&verbose=1')
		const volumes = df?.VolumeUsage ? (df.VolumeUsage.Items ?? []) : df?.Volumes
		if (!Array.isArray(volumes)) return
		const sizes = new Map(volumes.map((v) => [v.Name, v.UsageData?.Size]))
		for (const [id, k] of [...kept]) {
			const size = sizes.get(names(id).volume)
			if (size === undefined) {
				kept.delete(id)
				await docker.request('DELETE', `/volumes/${names(id).marker}`).catch(() => {})
			} else if (size >= 0) k.diskBytes = size
		}
	}

	// Frees disk for a workspace needing `needMiB` before the create is refused: collects snapshots
	// and caches over their share, then removes kept workspaces, those of deleted sessions first and
	// then the longest stopped, until it fits.
	async function makeRoom(id, needMiB) {
		const fits = () => reservedMiB(id) + needMiB <= cfg.maxTotalWorkspaceMiB
		await env.gc().catch(() => {})
		await reconcileKept().catch(() => {})
		const order = [...kept].filter(([kid]) => kid !== id).sort(([, a], [, b]) => (a.reason === 'kept_volume' ? 0 : 1) - (b.reason === 'kept_volume' ? 0 : 1) || a.keptAt - b.keptAt)
		for (const [kid] of order) {
			if (fits()) return
			console.warn(`removing kept workspace ${kid} to make room`)
			await remove(kid).catch(() => {})
		}
	}

	const lowDisk = (free) => new HttpError(507, `free disk ${free.toFixed(1)}% is below ${cfg.minFreePct}%`, { code: 'low_disk', freeDiskPct: Math.round(free * 10) / 10, minFreePct: cfg.minFreePct })

	function parseRestore(r, params) {
		if (r === undefined) return undefined
		if (!r || typeof r !== 'object' || Array.isArray(r) || Object.keys(r).some((k) => k !== 'key')) throw new HttpError(400, 'restoreFrom must be {key}')
		checkKey(r.key)
		checkOwner(params.userId, params.repo)
		return { key: r.key }
	}

	async function createSession(body) {
		const params = parseCreate(body, cfg.allowedImages, cfg.defaultDiskMiB)
		const restoreFrom = parseRestore(body.restoreFrom, params)
		const id = params.sessionId
		const existing = sessions.get(id)
		const pending = creating.get(id)
		if (existing || pending) {
			const s = existing ?? (await pending.promise)
			if (JSON.stringify(s.params) !== JSON.stringify(params)) throw new HttpError(409, 'session exists with different parameters')
			s.lastUsed = now()
			return { created: false, session: view(s) }
		}
		// Creating it now would fail on its container and remove what is there.
		if (unsettled.has(id)) throw new HttpError(409, 'the session has a container the manager has not taken over yet; try again shortly', { code: 'session_unsettled' })
		if (restoreFrom) await env.find(params.userId, params.repo, restoreFrom.key)
		return { created: true, session: view(await launch(params, restoreFrom)) }
	}

	// Starts a container for `params`, reusing a kept volume of the same session.
	async function launch(params, restoreFrom) {
		const id = params.sessionId
		const need = params.limits.diskMiB
		if (cfg.maxTotalWorkspaceMiB && reservedMiB(id) + need > cfg.maxTotalWorkspaceMiB) await makeRoom(id, need)
		// Check and reserve the slot in one synchronous step (no await in between), so concurrent
		// creates cannot pass the checks together. Existing sessions over the limit are left alone.
		const running = sessions.size + creating.size
		if (running >= limit()) throw new HttpError(429, 'at capacity', { code: 'capacity', limit: limit(), running })
		const held = reservation(id)
		if (cfg.maxTotalWorkspaceMiB && held.totalMiB + need > cfg.maxTotalWorkspaceMiB) {
			const { totalMiB, ...by } = held
			const detail = `${by.live} live workspaces ${by.liveMiB} MiB, ${by.kept} stopped workspaces ${by.keptMiB} MiB, snapshots and caches ${by.envMiB} MiB`
			throw new HttpError(507, `workspace disk would exceed ${cfg.maxTotalWorkspaceMiB} MiB (${detail}; ${totalMiB} MiB reserved, ${need} MiB requested)`, { code: 'workspace_quota', reservedMiB: totalMiB, requestedMiB: need, maxTotalMiB: cfg.maxTotalWorkspaceMiB, ...by })
		}
		const promise = (async () => {
			const free = await freeDiskPct()
			if (free < cfg.minFreePct) throw lowDisk(free)
			return doCreate(params, restoreFrom)
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
		unsettled.delete(id)
		const s = sessions.get(id)
		const k = kept.get(id)
		if (s) await measure(s).catch(() => {})
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
	// The proxy variables are passed each time because a re-attached proxy can change address. Until
	// a restarted manager has read the proxy's address, commands keep the container's own.
	const execSpec = (s, opts) => ({ ...opts, cwd: agentdPath(opts.cwd), env: { ...(s.proxyIp && proxyEnv(proxyUrlFor(s.proxyIp))), ...opts.env } })

	function parseExec(b) {
		if (!b || typeof b !== 'object') throw new HttpError(400, 'body must be an object')
		for (const k of Object.keys(b)) if (!['cmd', 'cwd', 'timeoutMs', 'stdin', 'env'].includes(k)) throw new HttpError(400, `unknown field ${k}`)
		if (!Array.isArray(b.cmd) || !b.cmd.length || b.cmd.length > 256 || !b.cmd.every((c) => typeof c === 'string')) throw new HttpError(400, 'cmd must be a non-empty string array')
		if (!Number.isInteger(b.timeoutMs) || b.timeoutMs < 1 || b.timeoutMs > 604800000) throw new HttpError(400, 'timeoutMs must be an integer in [1, 604800000]')
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
		unsettled.delete(id)
		kept.delete(id)
		await teardown(id, { ip: s?.ip })
		return { deleted: id }
	}

	// Takes a snapshot of a running session's workspace for its user. The session must be that user's
	// and repo's, and must not hold run-time secrets.
	async function snapshot(body) {
		const req = parseSnapshot(body)
		const s = get(req.sessionId)
		if (s.params.userId !== req.userId) throw new HttpError(403, 'the session belongs to another user', { code: 'forbidden' })
		if (s.params.repo !== req.repo) throw new HttpError(409, 'the session is for another repo', { code: 'repo_mismatch' })
		if (s.params.hasRuntimeSecrets) throw new HttpError(409, 'the session was given run-time secrets, so it cannot be snapshotted', { code: 'runtime_secrets' })
		return env.create(req, names(req.sessionId).container, async () => {
			const free = await freeDiskPct()
			if (free < cfg.minFreePct) throw lowDisk(free)
		})
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
		await settle()
		const nets = [...sessions.values()].map((s) => names(s.params.sessionId).network)
		const proxy = await attach(cfg.proxyContainer, nets, true)
		const restarted = proxy.startedAt !== proxyStartedAt
		proxyStartedAt = proxy.startedAt
		const self = await attachSelf(nets).catch((e) => ({ failed: new Map([['its own container', e]]) }))
		for (const [n, e] of [...proxy.failed, ...self.failed]) console.error(`re-attaching ${n}:`, e.message)
		for (const s of sessions.values()) {
			const net = names(s.params.sessionId).network
			s.proxyIp = proxy.ips[net] ?? s.proxyIp
			if (!s.ip || proxy.failed.has(net)) s.egress = false
			else if (restarted || proxy.connected.includes(net) || !s.egress) {
				s.egress = await proxyAdmin.set(s.ip, s.params.egressAllow).then(() => true, () => false)
			}
		}
	}

	const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
	const inspect = (n) => docker.request('GET', `/containers/${n.container}/json`)
	const ipOf = (info, n) => info.NetworkSettings?.Networks?.[n.network]?.IPAddress || null

	// Takes over a session container Docker reports, or removes it when it is a half-created
	// leftover. Returns whether the id is settled; an unsettled one is looked at again later. A
	// container that runs is never removed: it is registered even before it has an address, with
	// the agentd token from its environment (or derived from its nonce). Only a container that
	// never started or has stopped is a leftover: with a kept workspace it loses only its container
	// and network, and without one it goes entirely once it is older than leftoverGraceMs.
	async function adopt(id, waitMs = 0) {
		const n = names(id)
		let info
		try {
			info = await inspect(n)
			for (const end = Date.now() + waitMs; info.State?.Status === 'running' && !ipOf(info, n) && Date.now() < end; ) {
				await sleep(250)
				info = await inspect(n)
			}
		} catch (e) {
			return notFound(e) // gone: what is left of it is cleaned up with the orphans
		}
		const state = info.State?.Status
		if (state === 'running') {
			const ip = ipOf(info, n)
			const known = sessions.get(id)
			if (known) return Boolean((known.ip ??= ip))
			let params
			try {
				params = JSON.parse(info.Config.Labels[LABEL_SPEC])
			} catch {
				return false
			}
			const fromEnv = info.Config.Env?.find((e) => e.startsWith('AGENTD_TOKEN='))?.slice('AGENTD_TOKEN='.length)
			const nonce = info.Config.Labels[LABEL_NONCE]
			const token = fromEnv || (nonce && tokenFor(id, nonce))
			if (!token) return false
			if (fromEnv && nonce && fromEnv !== tokenFor(id, nonce)) console.warn(`session ${id}: its agentd token is not the one AGENTD_TOKEN_SECRET derives; using the container's`)
			const createdAt = Date.parse(info.Created) || now()
			sessions.set(id, { params, createdAt, lastUsed: now(), ip, proxyIp: null, token, egress: false, disk: null })
			return Boolean(ip)
		}
		if (!['created', 'exited', 'dead'].includes(state)) return false // paused, restarting, removing
		if (kept.has(id)) {
			await teardown(id, { keep: true })
			return true
		}
		if (now() - (Date.parse(info.Created) || 0) < leftoverGraceMs) return false
		await teardown(id)
		return true
	}

	// Looks again at what a restart left unsettled.
	async function settle() {
		for (const id of [...unsettled]) {
			if (creating.has(id)) continue
			const done = await adopt(id).catch(() => false)
			// A session deleted meanwhile is no longer unsettled, and is not brought back.
			if (!unsettled.has(id)) sessions.delete(id)
			else if (done) unsettled.delete(id)
		}
	}

	// Rebuilds the registry from Docker after a restart and removes half-created leftovers. Nothing
	// of a running session is ever removed here (see adopt).
	async function reconcile() {
		await env.ready()
		// Kept workspaces first, so a leftover of a resume keeps its volume.
		const markers = (await docker.request('GET', `/volumes?filters=${labelFilter(LABEL_KEPT)}`)).Volumes ?? []
		for (const v of markers) {
			try {
				kept.set(v.Labels[LABEL_KEPT], JSON.parse(v.Labels[LABEL_KEPT_INFO]))
			} catch {
				await docker.request('DELETE', `/volumes/${v.Name}`).catch(() => {})
			}
		}
		const containers = await docker.request('GET', `/containers/json?all=true&filters=${labelFilter(LABEL)}`)
		for (const c of containers) {
			const id = c.Labels[LABEL]
			if (!(await adopt(id, ipWaitMs).catch(() => false))) unsettled.add(id)
		}
		// A marker of a session that runs is a resume (or a stop) that did not finish.
		for (const id of [...kept.keys()]) {
			if (!sessions.has(id)) continue
			kept.delete(id)
			await docker.request('DELETE', `/volumes/${names(id).marker}`).catch(() => {})
		}
		const vols = (await docker.request('GET', `/volumes?filters=${labelFilter(LABEL)}`)).Volumes ?? []
		const nets = await docker.request('GET', `/networks?filters=${labelFilter(LABEL)}`)
		for (const id of new Set([...vols, ...nets].map((o) => o.Labels?.[LABEL]).filter(Boolean))) {
			if (!sessions.has(id) && !unsettled.has(id) && !creating.has(id)) await teardown(id, { keep: kept.has(id) }).catch(() => {})
		}
		if (unsettled.size) console.warn(`sessions not taken over yet, left as they are: ${[...unsettled].join(', ')}`)
		// The periodic reattach retries if the proxy is not up yet.
		await reattach().catch((e) => console.error('re-attaching session networks:', e.message))
		await env.gc().catch((e) => console.error('collecting snapshots and caches:', e.message))
	}

	async function reap() {
		for (const [id, s] of [...sessions]) if (now() - s.lastUsed > cfg.idleMin * 60000) await remove(id).catch(() => {})
		if (cfg.keptVolumeDays) for (const [id, k] of [...kept]) if (now() - k.keptAt > cfg.keptVolumeDays * 86400000) await remove(id).catch(() => {})
		await reconcileKept().catch((e) => console.error('measuring kept workspaces:', e.message))
		await env.gc().catch((e) => console.error('collecting snapshots and caches:', e.message))
	}

	async function health() {
		const running = sessions.size + creating.size
		return {
			version: await getBuildSha(),
			runsc: await hasRunsc(docker).catch(() => false),
			freeDiskPct: Math.round((await freeDiskPct().catch(() => NaN)) * 10) / 10,
			maxConcurrent: limit(),
			maxConcurrentSource: configView().source,
			running,
			free: Math.max(0, limit() - running),
			sessions: sessions.size,
			reserved: reservation(),
			...(await env.ready().then(env.stats, () => ({ snapshotBytes: null, cacheBytes: null, snapshotCount: null }))),
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
		// Streams a command's events as NDJSON. A client that goes away aborts the request to agentd,
		// and the command is killed: by agentd at once, or, for one with an id (which agentd would
		// keep running for a client to read on), by a DELETE. If the manager itself stops, nothing
		// kills a command with an id, and the client reads on through the restarted manager
		// (GET /sessions/:id/exec/:execId/stream?after=n).
		const stream = async (s, execId, open) => {
			const gone = new AbortController()
			let over = false
			res.on('close', () => {
				gone.abort()
				if (!over && execId) Promise.resolve().then(() => agentd.killExec(target(s), execId)).catch(() => {})
			})
			let events
			try {
				events = await open(gone.signal)
			} catch (e) {
				over = true
				throw e
			}
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
				over = true
				clearInterval(beat)
			}
			res.end()
		}
		try {
			if (req.method === 'GET' && url.pathname === '/health') return send(200, await health())
			if (!authorized(req)) throw new HttpError(401, 'unauthorized')
			if (url.pathname === '/config') {
				if (req.method === 'GET') return send(200, configView())
				if (req.method !== 'PUT') throw new HttpError(405, 'method not allowed')
				return send(200, await setConfig(await json()))
			}
			if (url.pathname === '/snapshots') {
				if (req.method === 'GET') return send(200, await env.list(url.searchParams.get('userId'), url.searchParams.get('repo')))
				if (req.method !== 'POST') throw new HttpError(405, 'method not allowed')
				const r = await snapshot(await json())
				return send(r.created ? 201 : 200, r.snapshot)
			}
			const sm = /^\/snapshots\/([^/]+)$/.exec(url.pathname)
			if (sm) {
				if (req.method !== 'DELETE') throw new HttpError(405, 'method not allowed')
				return send(200, await env.remove(url.searchParams.get('userId'), sm[1]))
			}
			if (url.pathname === '/sessions') {
				if (req.method === 'GET') return send(200, list())
				if (req.method !== 'POST') throw new HttpError(405, 'method not allowed')
				const r = await createSession(await json())
				return send(r.created ? 201 : 200, r.session)
			}
			const resume = /^\/sessions\/([a-z0-9-]+)\/exec\/([A-Za-z0-9_-]{8,128})\/stream$/.exec(url.pathname)
			if (resume) {
				if (req.method !== 'GET') throw new HttpError(405, 'method not allowed')
				const after = Number(url.searchParams.get('after') ?? 0)
				if (!Number.isInteger(after) || after < 0) throw new HttpError(400, 'after must be a non-negative integer')
				const s = get(resume[1])
				return await stream(s, resume[2], (signal) => agentd.resumeExec(target(s), resume[2], after, graceMs, signal))
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
				const execId = req.headers['x-exec-id']
				if (execId !== undefined && !EXEC_ID.test(execId)) throw new HttpError(400, 'x-exec-id must be 8-128 letters, digits, - or _')
				return await stream(s, execId, (signal) => agentd.startExec(target(s), { ...spec, ...(execId && { id: execId }) }, graceMs, signal))
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
	return { server, createSession, start, stop, list, reconcile, reattach, reap, checkDisk, status, health, remove, snapshot, env, sessions, kept }
}
