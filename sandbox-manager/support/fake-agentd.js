// A fake workspace-agentd: the HTTP protocol from workspace-agentd/README.md over an in-memory
// file map, recording every call. Tests script exec with `onExec` and disk use with `status`.
import http from 'node:http'

export const exit = (code = 0, extra = {}) => ({ type: 'exit', code, signal: null, timedOut: false, ...extra })

export async function startFakeAgentd({ token }) {
	const f = {
		token,
		calls: [],
		files: new Map(), // agentd-relative path -> Buffer
		escapes: new Set(), // paths agentd would refuse as symlink escapes
		status: { diskUsedBytes: 0, diskFreeBytes: 10 * 2 ** 30, rootBytes: 0, activeExecs: 0, uptimeSec: 1 },
		// Returns NDJSON events, {spawnFailed: message}, or {hang: true} (never answers).
		onExec: () => [exit(0)],
	}
	const open = new Set()
	const record = (name, p) => ({ name, type: 'file', size: f.files.get(p).length, mtimeMs: 1 })
	const server = http.createServer(async (req, res) => {
		open.add(res)
		res.on('close', () => open.delete(res))
		const chunks = []
		for await (const c of req) chunks.push(c)
		const raw = Buffer.concat(chunks)
		const url = new URL(req.url, 'http://x')
		const p = url.searchParams.get('path')
		const call = { method: req.method, path: url.pathname, query: Object.fromEntries(url.searchParams), token: req.headers.authorization, body: raw }
		f.calls.push(call)
		const send = (code, o) => res.writeHead(code, { 'content-type': 'application/json' }).end(JSON.stringify(o))
		const error = (code, error) => send(code, { error, message: `${error}: ${p}` })
		if (req.headers.authorization !== `Bearer ${f.token}`) return error(401, 'unauthorized')
		if (p !== null && f.escapes.has(p)) return error(400, 'path_escape')
		const key = `${req.method} ${url.pathname}`
		if (key === 'GET /health') return send(200, { ok: true, version: 'fake' })
		if (key === 'GET /status') return send(200, f.status)
		if (key === 'POST /exec') {
			call.body = JSON.parse(raw.toString())
			const r = await f.onExec(call.body)
			if (r.spawnFailed) return send(400, { error: 'spawn_failed', message: r.spawnFailed })
			res.writeHead(200, { 'content-type': 'application/x-ndjson' })
			res.flushHeaders()
			if (r.hang) return
			return res.end(r.map((e) => `${JSON.stringify(e)}\n`).join(''))
		}
		if (key === 'PUT /file') return f.files.set(p, raw), send(200, { ok: true, size: raw.length })
		if (key === 'GET /file') return f.files.has(p) ? res.writeHead(200, { 'content-type': 'application/octet-stream' }).end(f.files.get(p)) : error(404, 'not_found')
		if (key === 'DELETE /file') return f.files.delete(p) ? send(200, { ok: true }) : error(404, 'not_found')
		if (key === 'GET /stat') return f.files.has(p) ? send(200, record(p.split('/').at(-1), p)) : error(404, 'not_found')
		if (key === 'GET /list') {
			const prefix = p === '.' ? '' : `${p}/`
			return send(200, [...f.files.keys()].filter((k) => k.startsWith(prefix) && !k.slice(prefix.length).includes('/')).map((k) => record(k.slice(prefix.length), k)))
		}
		error(404, 'not_found')
	})
	await new Promise((r) => server.listen(0, '127.0.0.1', r))
	return Object.assign(f, {
		port: server.address().port,
		close: () => new Promise((r) => (open.forEach((x) => x.destroy()), server.closeAllConnections(), server.close(r))),
	})
}
