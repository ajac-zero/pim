// A fake Docker Engine API on a unix socket: just enough for the manager, recording every call.
import http from 'node:http'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const frame = (type, data) => {
	const b = Buffer.from(data)
	const h = Buffer.alloc(8)
	h[0] = type
	h.writeUInt32BE(b.length, 4)
	return Buffer.concat([h, b])
}

export async function startFakeDocker({ runtimes = { runc: {}, runsc: {} }, probeExit = 0 } = {}) {
	const calls = []
	const containers = new Map() // name -> {id, body, ip}
	const execs = new Map()
	const networks = new Set()
	const volumes = new Set()
	const f = { calls, containers, networks, volumes, execLog: [], onExec: () => ({ stdout: '', exitCode: 0 }), proxyNet: new Set() }
	let n = 0
	const hijacked = new Set()
	const nextIp = () => `10.9.0.${++n + 1}`

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
		if ((m = /^GET \/images\/(.+)\/json$/.exec(key))) return out(200, {})
		if (key === 'POST /images/create') return out(200, {})
		if (key === 'POST /volumes/create') return volumes.add(body.Name), out(201, body)
		if (key === 'POST /networks/create') return networks.add(body.Name), out(201, { Id: body.Name })
		if (key === 'POST /containers/create') {
			const name = url.searchParams.get('name')
			if (containers.has(name)) return out(409, { message: 'conflict' })
			containers.set(name, { id: `id-${name}`, body, ip: nextIp(), name })
			return out(201, { Id: `id-${name}` })
		}
		if ((m = /^POST \/containers\/([^/]+)\/start$/.exec(key))) return out(204)
		if ((m = /^POST \/containers\/([^/]+)\/wait$/.exec(key))) return out(200, { StatusCode: probeExit })
		if ((m = /^GET \/containers\/([^/]+)\/json$/.exec(key))) {
			if (m[1] === 'egress-proxy') return out(200, { NetworkSettings: { Networks: Object.fromEntries([...f.proxyNet].map((net) => [net, { IPAddress: '10.9.100.2' }])) } })
			const c = containers.get(m[1])
			if (!c) return out(404, { message: 'no such container' })
			return out(200, { NetworkSettings: { Networks: { [c.body.HostConfig.NetworkMode]: { IPAddress: c.ip } } } })
		}
		if (key === 'GET /containers/json') {
			const list = [...containers.values()].filter((c) => c.body.Labels).map((c) => ({ Id: c.id, State: 'running', Created: 1, Labels: c.body.Labels, NetworkSettings: { Networks: { [c.body.HostConfig.NetworkMode]: { IPAddress: c.ip } } } }))
			return out(200, list)
		}
		if ((m = /^DELETE \/containers\/([^/]+)$/.exec(key))) return containers.delete(m[1].replace(/^id-/, '')) ? out(204) : out(404, { message: 'no such container' })
		if ((m = /^POST \/networks\/([^/]+)\/connect$/.exec(key))) return f.proxyNet.add(m[1]), out(200)
		if ((m = /^POST \/networks\/([^/]+)\/disconnect$/.exec(key))) return f.proxyNet.delete(m[1]), out(200)
		if ((m = /^DELETE \/networks\/([^/]+)$/.exec(key))) return networks.delete(m[1]) ? out(204) : out(404, { message: 'no such network' })
		if ((m = /^DELETE \/volumes\/([^/]+)$/.exec(key))) return volumes.delete(m[1]) ? out(204) : out(404, { message: 'no such volume' })
		if (key === 'GET /volumes') return out(200, { Volumes: [...volumes].map((Name) => ({ Name, Labels: { 'pim.coding.session': Name.replace('pim-ws-', '') } })) })
		if (key === 'GET /networks') return out(200, [...networks].map((Name) => ({ Name, Labels: { 'pim.coding.session': Name.replace('pim-net-', '') } })))
		if ((m = /^POST \/containers\/([^/]+)\/exec$/.exec(key))) {
			const id = `exec-${execs.size + 1}`
			execs.set(id, { ...body, container: m[1] })
			f.execLog.push(body)
			return out(201, { Id: id })
		}
		if ((m = /^GET \/exec\/([^/]+)\/json$/.exec(key))) return out(200, { ExitCode: execs.get(m[1]).exitCode })
		out(404, { message: `unhandled ${key}` })
	})

	server.on('upgrade', (req, socket) => {
		const id = /^\/exec\/([^/]+)\/start$/.exec(req.url)[1]
		const ex = execs.get(id)
		hijacked.add(socket)
		const respond = (stdin) => {
			const r = f.onExec(ex.Cmd, stdin, ex)
			if (r.hang) return // never answers: the manager must time out
			ex.exitCode = r.exitCode ?? 0
			// Two frames, split mid-header, to exercise demuxing.
			const data = Buffer.concat([frame(1, r.stdout ?? ''), frame(2, r.stderr ?? '')])
			socket.write(data.subarray(0, 3))
			socket.write(data.subarray(3))
			socket.end()
		}
		socket.write('HTTP/1.1 101 UPGRADED\r\nConnection: Upgrade\r\nUpgrade: tcp\r\n\r\n')
		if (ex.AttachStdin) {
			const buf = []
			socket.on('data', (c) => buf.push(c))
			socket.on('end', () => respond(Buffer.concat(buf).toString()))
		} else respond()
	})

	const path = join(mkdtempSync(join(tmpdir(), 'fake-docker-')), 'docker.sock')
	await new Promise((r) => server.listen(path, r))
	return Object.assign(f, { path, close: () => new Promise((r) => (server.closeAllConnections(), hijacked.forEach((x) => x.destroy()), server.close(r))) })
}
