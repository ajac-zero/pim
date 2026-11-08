import assert from 'node:assert/strict'
import http from 'node:http'
import net from 'node:net'
import { after, before, describe, test } from 'node:test'
import { createProxy, isBlockedIp } from '../src/proxy.js'

describe('isBlockedIp', () => {
	test('blocks loopback, private, link-local, CGNAT and mapped addresses; allows public ones', () => {
		for (const ip of ['127.0.0.1', '10.1.2.3', '172.16.0.1', '172.31.255.255', '192.168.1.1', '169.254.169.254', '100.64.0.1', '0.0.0.0', '::1', 'fd00::1', 'fe80::1', '::ffff:10.0.0.1']) assert.ok(isBlockedIp(ip), ip)
		for (const ip of ['93.184.216.34', '172.32.0.1', '172.15.0.1', '2606:4700::1']) assert.ok(!isBlockedIp(ip), ip)
	})
})

describe('egress proxy', () => {
	let p, port, adminPort, echo
	const dns = { 'github.com': '93.184.216.34', 'sneaky.github.com': '10.0.0.5', 'evil.com': '93.184.216.35' }

	before(async () => {
		echo = net.createServer((s) => s.on('data', (d) => s.write(`echo:${d}`)))
		await new Promise((r) => echo.listen(0, '127.0.0.1', r))
		p = createProxy({
			adminToken: 'adm',
			lookup: async (h) => [{ address: dns[h] }],
			dial: () => net.connect(echo.address().port, '127.0.0.1'),
		})
		await new Promise((r) => p.proxy.listen(0, '127.0.0.1', r))
		await new Promise((r) => p.admin.listen(0, '127.0.0.1', r))
		port = p.proxy.address().port
		adminPort = p.admin.address().port
	})
	after(() => {
		p.proxy.close()
		p.admin.close()
		echo.close()
	})

	const admin = (method, body, token = 'adm') => fetch(`http://127.0.0.1:${adminPort}/allow/127.0.0.1`, { method, headers: { authorization: `Bearer ${token}` }, body: body && JSON.stringify(body) })
	const connect = (target) =>
		new Promise((resolve) => {
			const req = http.request({ host: '127.0.0.1', port, method: 'CONNECT', path: target })
			req.on('connect', (res, socket) => {
				if (res.statusCode !== 200) return socket.destroy(), resolve({ status: res.statusCode })
				socket.write('ping')
				socket.once('data', (d) => (socket.destroy(), resolve({ status: res.statusCode, data: d.toString() })))
			})
			req.on('response', (res) => resolve({ status: res.statusCode }))
			req.end()
		})

	test('admin endpoint requires the token', async () => {
		assert.equal((await admin('PUT', { hosts: ['github.com'] }, 'wrong')).status, 401)
		assert.equal((await admin('PUT', { hosts: ['github.com', '*.github.com'] })).status, 200)
	})
	test('tunnels to allowlisted hosts on 443 only', async () => {
		assert.deepEqual(await connect('github.com:443'), { status: 200, data: 'echo:ping' })
		assert.equal((await connect('github.com:22')).status, 403)
	})
	test('denies unlisted hosts, IP literals, localhost, and names that resolve to private addresses', async () => {
		for (const t of ['evil.com:443', '93.184.216.34:443', '127.0.0.1:443', '169.254.169.254:443', 'localhost:443', '[::1]:443', 'sneaky.github.com:443']) {
			assert.equal((await connect(t)).status, 403, t)
		}
	})
	test('sources without an allowlist are denied, and plain HTTP is refused', async () => {
		await admin('DELETE')
		assert.equal((await connect('github.com:443')).status, 403)
		const r = await fetch(`http://127.0.0.1:${port}/`)
		assert.equal(r.status, 405)
	})
})
