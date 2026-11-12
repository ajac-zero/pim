// A fake Docker Engine API on a unix socket: just enough for the manager, recording every call.
// Each started session container gets its own fake agentd (or `startAgentd`'s), reachable
// through `agentdAddress(ip)`. Each volume is a directory (`volumeDir(name)`), which the archive
// routes read and write with GNU tar the way Docker does for /workspace.
import { spawn, spawnSync } from 'node:child_process'
import http from 'node:http'
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { startFakeAgentd } from './fake-agentd.js'

const INFRA = ['egress-proxy', 'sandbox-manager']

export async function startFakeDocker({ runtimes = { runc: {}, runsc: {} }, probeExit = 0, quotaSupport = false } = {}) {
	const calls = []
	const containers = new Map() // name -> {id, name, body, ip, state, agentd}
	const volumes = new Map() // name -> create body
	const networks = new Map() // name -> create body
	// The egress proxy and the manager's own container: which session networks they are on.
	const infra = new Map(INFRA.map((name, i) => [name, { ip: `10.9.100.${i + 2}`, startedAt: 'gen-0', nets: new Set() }]))
	const dirs = mkdtempSync(join(tmpdir(), 'fake-volumes-'))
	const f = {
		calls,
		// Sizes /system/df reports, by volume name; others report -1 (not measured).
		volumeSizes: new Map(),
		// The API version /system/df answers as: before 1.52 volumes are in `Volumes`; 1.52 lists them
		// in `VolumeUsage.Items` too (only there with `verbose`), and 1.53 only there, with `verbose`.
		apiVersion: '1.53',
		// Ends GET archive answers after this many bytes, as a daemon that died would.
		archiveFailAfter: null,
		// Awaited before a PUT archive is extracted, so tests can hold a restore open.
		onArchivePut: null,
		volumeDir(name) {
			const d = join(dirs, name)
			mkdirSync(d, { recursive: true })
			return d
		},
		containers,
		volumes,
		networks,
		infra,
		startAgentd: (c) => startFakeAgentd({ token: c.body.Env.find((e) => e.startsWith('AGENTD_TOKEN=')).slice(13) }),
		agentdAddress: (ip) => ({ host: '127.0.0.1', port: [...containers.values()].find((c) => c.ip === ip)?.agentd?.port ?? 1 }),
		agentd: (name) => containers.get(name).agentd,
		// Simulates `docker compose up` recreating an infra container: new address, no session networks.
		recreate(name, ip) {
			const x = infra.get(name)
			Object.assign(x, { ip, startedAt: `${x.startedAt}+`, nets: new Set() })
		},
	}
	let n = 0
	const nextIp = () => `10.9.0.${++n + 1}`
	const byLabel = (query, labels = {}) => {
		const want = JSON.parse(query.get('filters') ?? '{}').label ?? []
		return want.every((l) => {
			const [k, v] = l.split('=')
			return k in labels && (v === undefined || labels[k] === v)
		})
	}

	const networksOf = (c) => {
		const hidden = c.hideIp > 0
		if (hidden) c.hideIp--
		return { Networks: { [c.body.HostConfig?.NetworkMode]: { IPAddress: hidden || c.state !== 'running' ? '' : c.ip } } }
	}

	const workspaceOf = (c) => f.volumeDir(c.body.HostConfig.Mounts.find((m) => m.Target === '/workspace').Source)

	const server = http.createServer(async (req, res) => {
		const chunks = []
		try {
			for await (const c of req) chunks.push(c)
		} catch {
			return // the client aborted
		}
		const raw = Buffer.concat(chunks)
		const isJson = req.headers['content-type'] === 'application/json'
		const body = isJson && raw.length ? JSON.parse(raw.toString()) : undefined
		const url = new URL(req.url, 'http://x')
		calls.push({ method: req.method, path: url.pathname, query: url.searchParams, body, ...(!isJson && raw.length && { raw }) })
		const out = (code, o) => res.writeHead(code, { 'content-type': 'application/json' }).end(o === undefined ? '' : JSON.stringify(o))
		const key = `${req.method} ${url.pathname}`
		let m
		if (key === 'GET /info') return out(200, { Runtimes: runtimes })
		if (/^GET \/images\/(.+)\/json$/.test(key)) return out(200, {})
		if (key === 'POST /images/create') return out(200, {})
		if (key === 'POST /volumes/create') {
			if (body.DriverOpts?.size && !quotaSupport) return out(400, { message: 'quota size requested but no quota support' })
			if (!volumes.has(body.Name)) volumes.set(body.Name, body) // Docker returns an existing volume as it is
			return out(201, volumes.get(body.Name))
		}
		if (key === 'POST /networks/create') {
			if (networks.has(body.Name)) return out(409, { message: 'network exists' })
			return networks.set(body.Name, body), out(201, { Id: body.Name })
		}
		if (key === 'POST /containers/create') {
			const name = url.searchParams.get('name')
			if (containers.has(name)) return out(409, { message: 'conflict' })
			// `hideIp` answers that many lookups of the container without an address, as Docker does
			// for a moment while it sets up the container's network.
			containers.set(name, { id: `id-${name}`, body, ip: nextIp(), name, state: 'created', created: Date.now(), hideIp: 0 })
			return out(201, { Id: `id-${name}` })
		}
		if ((m = /^POST \/containers\/([^/]+)\/start$/.exec(key))) {
			const c = containers.get(m[1]) ?? [...containers.values()].find((x) => x.id === m[1])
			if (c) c.state = 'running'
			if (c?.body.Env?.some((e) => e.startsWith('AGENTD_TOKEN='))) c.agentd = await f.startAgentd(c)
			return out(204)
		}
		if (/^POST \/containers\/([^/]+)\/wait$/.test(key)) return out(200, { StatusCode: probeExit })
		if ((m = /^GET \/containers\/([^/]+)\/json$/.exec(key))) {
			const x = infra.get(m[1])
			if (x) return out(200, { State: { StartedAt: x.startedAt }, NetworkSettings: { Networks: Object.fromEntries([...x.nets].map((net) => [net, { IPAddress: x.ip }])) } })
			const c = containers.get(m[1]) ?? [...containers.values()].find((x) => x.id === m[1])
			if (!c) return out(404, { message: 'no such container' })
			return out(200, {
				Id: c.id,
				Name: `/${c.name}`,
				Created: new Date(c.created ?? 0).toISOString(),
				State: { Status: c.state, Running: c.state === 'running' },
				Config: { Env: c.body.Env, Labels: c.body.Labels },
				NetworkSettings: networksOf(c),
			})
		}
		if (key === 'GET /containers/json') {
			const list = [...containers.values()].filter((c) => byLabel(url.searchParams, c.body.Labels))
			return out(200, list.map((c) => ({ Id: c.id, Names: [`/${c.name}`], State: c.state, Created: Math.floor((c.created ?? 0) / 1000), Labels: c.body.Labels, NetworkSettings: networksOf(c) })))
		}
		if ((m = /^POST \/containers\/([^/]+)\/stop$/.exec(key))) {
			const c = containers.get(m[1])
			if (!c) return out(404, { message: 'no such container' })
			c.state = 'exited'
			await c.agentd?.close()
			c.agentd = null
			return out(204)
		}
		if ((m = /^DELETE \/containers\/([^/]+)$/.exec(key))) {
			const name = m[1].replace(/^id-/, '')
			const c = containers.get(name)
			if (!c) return out(404, { message: 'no such container' })
			containers.delete(name)
			await c.agentd?.close()
			return out(204)
		}
		if ((m = /^GET \/containers\/([^/]+)\/archive$/.exec(key))) {
			const c = containers.get(m[1])
			if (!c || url.searchParams.get('path') !== '/workspace') return out(404, { message: 'no such container or path' })
			// Docker names the entries after the requested directory: workspace/, workspace/a, ...
			const tar = spawn('tar', ['-C', workspaceOf(c), '--transform', 's,^\\.,workspace,S', '-cf', '-', '.'])
			res.writeHead(200, { 'content-type': 'application/x-tar' })
			let sent = 0
			tar.stdout.on('data', (d) => {
				sent += d.length
				if (f.archiveFailAfter !== null && sent > f.archiveFailAfter) {
					tar.kill()
					return res.destroy()
				}
				res.write(d)
			})
			tar.stdout.on('end', () => res.end())
			return
		}
		if ((m = /^PUT \/containers\/([^/]+)\/archive$/.exec(key))) {
			const c = containers.get(m[1])
			if (!c || url.searchParams.get('path') !== '/workspace') return out(404, { message: 'no such container or path' })
			await f.onArchivePut?.(c)
			const r = spawnSync('tar', ['-C', workspaceOf(c), '-xf', '-', '--no-same-owner'], { input: raw })
			return r.status === 0 ? out(200) : out(400, { message: r.stderr.toString() })
		}
		if (key === 'GET /system/df') {
			const items = [...volumes.values()].map((v) => ({ Name: v.Name, Labels: v.Labels ?? {}, UsageData: { Size: f.volumeSizes.get(v.Name) ?? -1, RefCount: 0 } }))
			const minor = Number(f.apiVersion.split('.')[1])
			if (minor < 52) return out(200, { Volumes: items })
			const verbose = url.searchParams.get('verbose') === '1'
			const usage = { TotalCount: items.length, ...((verbose || minor === 52) && items.length && { Items: items }) }
			return out(200, { VolumeUsage: usage, ...(minor === 52 && !verbose && { Volumes: items }) })
		}
		if ((m = /^POST \/networks\/([^/]+)\/(connect|disconnect)$/.exec(key))) {
			const x = infra.get(body.Container)
			if (!networks.has(m[1]) || !x) return out(404, { message: 'no such network or container' })
			if (m[2] === 'connect' && x.nets.has(m[1])) return out(403, { message: 'endpoint already exists in network' })
			m[2] === 'connect' ? x.nets.add(m[1]) : x.nets.delete(m[1])
			return out(200)
		}
		if ((m = /^DELETE \/networks\/([^/]+)$/.exec(key))) return networks.delete(m[1]) ? out(204) : out(404, { message: 'no such network' })
		if ((m = /^DELETE \/volumes\/([^/]+)$/.exec(key))) {
			if ([...containers.values()].some((c) => c.body.HostConfig?.Mounts?.some((x) => x.Source === m[1]))) return out(409, { message: 'volume is in use' })
			if (!volumes.delete(m[1])) return out(404, { message: 'no such volume' })
			rmSync(join(dirs, m[1]), { recursive: true, force: true })
			return out(204)
		}
		if (key === 'GET /volumes') return out(200, { Volumes: [...volumes.values()].filter((v) => byLabel(url.searchParams, v.Labels)) })
		if (key === 'GET /networks') return out(200, [...networks.values()].filter((v) => byLabel(url.searchParams, v.Labels)))
		out(404, { message: `unhandled ${key}` })
	})

	const path = join(mkdtempSync(join(tmpdir(), 'fake-docker-')), 'docker.sock')
	await new Promise((r) => server.listen(path, r))
	return Object.assign(f, {
		path,
		close: async () => {
			await Promise.all([...containers.values()].map((c) => c.agentd?.close()))
			server.closeAllConnections()
			await new Promise((r) => server.close(r))
			rmSync(dirs, { recursive: true, force: true })
		},
	})
}
