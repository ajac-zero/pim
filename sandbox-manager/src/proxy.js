// A minimal CONNECT-allowlist proxy. Sessions live on an internal network whose only
// neighbour is this proxy. The allowlist is per source IP (the session container's address
// on the shared network), set by the manager through an authenticated admin endpoint.
// Only HTTPS tunnels (CONNECT to :443) are supported; plain http:// requests get 405.
// Every refusal answers 403 with `x-pim-egress: denied`, so a 403 from Pim is told apart
// from one the destination sent.
import dns from 'node:dns/promises'
import http from 'node:http'
import net from 'node:net'
import { timingSafeEqual, createHash } from 'node:crypto'

export function isBlockedIp(ip) {
	if (net.isIPv6(ip)) {
		const l = ip.toLowerCase()
		const mapped = l.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/)
		if (mapped) return isBlockedIp(mapped[1])
		return l === '::' || l === '::1' || /^f[cd]/.test(l) || /^fe[89ab]/.test(l)
	}
	const [a, b] = ip.split('.').map(Number)
	return (
		a === 0 || a === 10 || a === 127 || a >= 224 ||
		(a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) ||
		(a === 192 && b === 168) || (a === 100 && b >= 64 && b <= 127)
	)
}

export function hostAllowed(host, patterns) {
	return patterns.some((p) => (p.startsWith('*.') ? host.endsWith(p.slice(1)) : host === p))
}

const sha = (s) => createHash('sha256').update(s).digest()
export const tokenOk = (given, expected) => timingSafeEqual(sha(given ?? ''), sha(expected))

// lookup and dial are injectable for tests.
export function createProxy({ adminToken, lookup = (h) => dns.lookup(h, { all: true }), dial = (addr, port) => net.connect(port, addr) }) {
	const allow = new Map() // source ip -> string[]
	const clean = (a) => (a ?? '').replace(/^::ffff:/, '')

	const proxy = http.createServer((_req, res) => {
		res.writeHead(405, { 'content-type': 'text/plain' }).end('only CONNECT to :443 is supported\n')
	})
	proxy.on('connect', async (req, client, head) => {
		// Every refusal is marked as the proxy's, so a 403 from Pim is told apart from one the destination sent.
		const deny = (code, why) => client.end(`HTTP/1.1 ${code} ${why}\r\nx-pim-egress: denied\r\nconnection: close\r\n\r\n`)
		client.on('error', () => {})
		try {
			const m = /^([^:\[\]]+):(\d+)$/.exec(req.url ?? '')
			if (!m) return deny(403, 'Forbidden') // also rejects bracketed IPv6 literals
			const host = m[1].toLowerCase()
			if (m[2] !== '443' || net.isIP(host) || host === 'localhost') return deny(403, 'Forbidden')
			if (!hostAllowed(host, allow.get(clean(client.remoteAddress)) ?? [])) return deny(403, 'Forbidden')
			const addrs = (await lookup(host)).map((a) => a.address)
			// Dial the address we checked, so DNS cannot change its answer between check and connect.
			if (!addrs.length || addrs.some(isBlockedIp)) return deny(403, 'Forbidden')
			const upstream = dial(addrs[0], 443)
			upstream.on('error', () => client.destroy())
			client.on('close', () => upstream.destroy())
			upstream.once('connect', () => {
				client.write('HTTP/1.1 200 Connection Established\r\n\r\n')
				if (head.length) upstream.write(head)
				upstream.pipe(client)
				client.pipe(upstream)
			})
		} catch {
			deny(502, 'Bad Gateway')
		}
	})

	const admin = http.createServer(async (req, res) => {
		const send = (c, o) => res.writeHead(c, { 'content-type': 'application/json' }).end(JSON.stringify(o ?? {}))
		if (!tokenOk(req.headers.authorization?.replace(/^Bearer /, ''), adminToken)) return send(401, { error: 'unauthorized' })
		const m = /^\/allow\/([0-9a-f.:]+)$/i.exec(req.url ?? '')
		if (!m) return send(404, { error: 'not found' })
		if (req.method === 'DELETE') return allow.delete(m[1]), send(200)
		if (req.method !== 'PUT') return send(405, { error: 'method not allowed' })
		const chunks = []
		for await (const c of req) chunks.push(c)
		try {
			const { hosts } = JSON.parse(Buffer.concat(chunks).toString())
			if (!Array.isArray(hosts) || !hosts.every((h) => typeof h === 'string')) throw new Error()
			allow.set(m[1], hosts)
			send(200)
		} catch {
			send(400, { error: 'body must be {hosts: string[]}' })
		}
	})
	return { proxy, admin, allow }
}
