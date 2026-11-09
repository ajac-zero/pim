// A fake Docker Engine API on a unix socket: just enough for the manager, recording every call.
// Each started session container gets its own fake agentd (or `startAgentd`'s), reachable
// through `agentdAddress(ip)`.
import http from 'node:http'
import { mkdtempSync } from 'node:fs'
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
	const f = {
		calls,
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

	const server = http.createServer(async (req, res) => {
		const chunks = []
		for await (const c of req) chunks.push(c)
		const text = Buffer.concat(chunks).toString()
		const body = text ? JSON.parse(text) : undefined
		const url = new URL(req.url, 'http://x')
		calls.push({ method: req.method, path: url.pathname, query: url.searchParams, body })
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
			containers.set(name, { id: `id-${name}`, body, ip: nextIp(), name, state: 'created' })
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
			const c = containers.get(m[1])
			if (!c) return out(404, { message: 'no such container' })
			return out(200, { NetworkSettings: { Networks: { [c.body.HostConfig.NetworkMode]: { IPAddress: c.ip } } } })
		}
		if (key === 'GET /containers/json') {
			const list = [...containers.values()].filter((c) => byLabel(url.searchParams, c.body.Labels))
			return out(200, list.map((c) => ({ Id: c.id, State: c.state, Created: 1, Labels: c.body.Labels, NetworkSettings: { Networks: { [c.body.HostConfig.NetworkMode]: { IPAddress: c.ip } } } })))
		}
		if ((m = /^DELETE \/containers\/([^/]+)$/.exec(key))) {
			const name = m[1].replace(/^id-/, '')
			const c = containers.get(name)
			if (!c) return out(404, { message: 'no such container' })
			containers.delete(name)
			await c.agentd?.close()
			return out(204)
		}
		if ((m = /^POST \/networks\/([^/]+)\/(connect|disconnect)$/.exec(key))) {
			const x = infra.get(body.Container)
			if (!networks.has(m[1]) || !x) return out(404, { message: 'no such network or container' })
			if (m[2] === 'connect' && x.nets.has(m[1])) return out(403, { message: 'endpoint already exists in network' })
			m[2] === 'connect' ? x.nets.add(m[1]) : x.nets.delete(m[1])
			return out(200)
		}
		if ((m = /^DELETE \/networks\/([^/]+)$/.exec(key))) return networks.delete(m[1]) ? out(204) : out(404, { message: 'no such network' })
		if ((m = /^DELETE \/volumes\/([^/]+)$/.exec(key))) return volumes.delete(m[1]) ? out(204) : out(404, { message: 'no such volume' })
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
		},
	})
}
