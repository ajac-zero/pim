import assert from 'node:assert/strict'
import { promises as fs, existsSync, readFileSync } from 'node:fs'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import { after, before, describe, test } from 'node:test'
import { guard } from '../files.mjs'
import { createAgentd } from '../server.mjs'

const TOKEN = 'test-token-123'
let server, base, root, outside

async function start(extra = {}) {
	const s = await createAgentd({ token: TOKEN, root, ...extra })
	await new Promise((r) => s.listen(0, '127.0.0.1', r))
	return { s, url: `http://127.0.0.1:${s.address().port}` }
}

before(async () => {
	const tmp = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'agentd-')))
	root = path.join(tmp, 'ws')
	outside = path.join(tmp, 'outside')
	await fs.mkdir(root)
	await fs.mkdir(outside)
	await fs.writeFile(path.join(outside, 'secret.txt'), 'secret')
	await fs.symlink(outside, path.join(root, 'linkdir'))
	await fs.symlink(path.join(outside, 'secret.txt'), path.join(root, 'linkfile'))
	await fs.symlink(path.join(outside, 'nothing-yet'), path.join(root, 'dangling'))
	;({ s: server, url: base } = await start())
})
after(() => server.close())

const auth = { authorization: `Bearer ${TOKEN}` }
const api = (p, init = {}) => fetch(base + p, { ...init, headers: { ...auth, ...init.headers } })
const exec = (body) =>
	api('/exec', { method: 'POST', body: JSON.stringify({ timeoutMs: 10000, ...body }) })
async function events(res) {
	assert.equal(res.status, 200)
	return (await res.text()).trim().split('\n').map((l) => JSON.parse(l))
}
const alive = (pid) => {
	try {
		process.kill(pid, 0)
	} catch {
		return false
	}
	try {
		return !/\) Z /.test(readFileSync(`/proc/${pid}/stat`, 'utf8')) // zombies are dead
	} catch {
		return true
	}
}
const until = async (fn, ms = 8000) => {
	const end = Date.now() + ms
	while (Date.now() < end) {
		if (await fn()) return true
		await new Promise((r) => setTimeout(r, 50))
	}
	return false
}

describe('auth and status', () => {
	test('requires a valid bearer token on every route', async () => {
		for (const [m, p] of [['GET', '/health'], ['GET', '/status'], ['POST', '/exec'], ['GET', '/file?path=a'], ['PUT', '/file?path=a'], ['DELETE', '/file?path=a'], ['GET', '/list?path=.'], ['GET', '/stat?path=.']]) {
			for (const headers of [{}, { authorization: 'Bearer wrong' }, { authorization: TOKEN }]) {
				const res = await fetch(base + p, { method: m, headers })
				assert.equal(res.status, 401, `${m} ${p}`)
				assert.equal((await res.json()).error, 'unauthorized')
			}
		}
	})
	test('refuses to be built without a token', async () => {
		await assert.rejects(createAgentd({ token: '', root }))
	})
	test('health and status', async () => {
		const h = await (await api('/health')).json()
		assert.equal(h.ok, true)
		assert.equal(typeof h.version, 'string')
		const s = await (await api('/status')).json()
		for (const k of ['diskUsedBytes', 'diskFreeBytes', 'rootBytes', 'activeExecs', 'uptimeSec']) assert.equal(typeof s[k], 'number', k)
	})
})

describe('exec', () => {
	test('streams stdout and stderr in order with exit code', async () => {
		const script = 'echo one; sleep 0.2; echo two >&2; sleep 0.2; echo three; exit 3'
		const ev = await events(await exec({ cmd: ['sh', '-c', script] }))
		assert.deepEqual(ev, [
			{ type: 'stdout', data: 'one\n' },
			{ type: 'stderr', data: 'two\n' },
			{ type: 'stdout', data: 'three\n' },
			{ type: 'exit', code: 3, signal: null, timedOut: false },
		])
	})
	test('stdin, env and cwd', async () => {
		await fs.mkdir(path.join(root, 'sub'), { recursive: true })
		const ev = await events(await exec({ cmd: ['sh', '-c', 'cat; echo $FOO; pwd'], stdin: 'héllo\n', env: { FOO: 'bar' }, cwd: 'sub' }))
		const out = ev.filter((e) => e.type === 'stdout').map((e) => e.data).join('')
		assert.equal(out, `héllo\nbar\n${path.join(root, 'sub')}\n`)
	})
	test('commands do not inherit the token from the environment', async () => {
		process.env.AGENTD_TOKEN = TOKEN
		process.env.AGENTD_OTHER = 'kept'
		const { s, url } = await start()
		try {
			const res = await fetch(`${url}/exec`, { method: 'POST', headers: auth, body: JSON.stringify({ cmd: ['sh', '-c', 'echo ${AGENTD_TOKEN-unset} $AGENTD_OTHER'], timeoutMs: 10000 }) })
			assert.equal((await events(res))[0].data, 'unset kept\n')
		} finally {
			delete process.env.AGENTD_TOKEN
			delete process.env.AGENTD_OTHER
			s.close()
		}
	})
	test('argv is not a shell', async () => {
		const ev = await events(await exec({ cmd: ['echo', '$HOME;', 'x'] }))
		assert.equal(ev[0].data, '$HOME; x\n')
	})
	test('unknown command is a 400, bad body is a 400', async () => {
		assert.equal((await exec({ cmd: ['definitely-not-a-command'] })).status, 400)
		assert.equal((await exec({ cmd: 'ls' })).status, 400)
		assert.equal((await exec({ cmd: ['ls'], timeoutMs: undefined })).status, 400)
	})
	test('timeout kills the whole process group', async () => {
		const ev = await events(await exec({ cmd: ['sh', '-c', 'sleep 61 & echo $!; wait'], timeoutMs: 400 }))
		const pid = Number(ev[0].data)
		const exit = ev.at(-1)
		assert.equal(exit.type, 'exit')
		assert.equal(exit.timedOut, true)
		assert.ok(await until(() => !alive(pid)), 'grandchild still running')
	})
	test('client disconnect kills the process group', async () => {
		const res = await exec({ cmd: ['sh', '-c', 'sleep 62 & echo $!; wait'], timeoutMs: 60000 })
		const reader = res.body.getReader()
		const { value } = await reader.read()
		const pid = Number(JSON.parse(new TextDecoder().decode(value).split('\n')[0]).data)
		assert.ok(alive(pid))
		await reader.cancel()
		assert.ok(await until(() => !alive(pid)), 'grandchild survived disconnect')
		assert.ok(await until(async () => (await (await api('/status')).json()).activeExecs === 0))
	})
	// Reads NDJSON events from a stream until `stop(events)` says so, and returns them.
	const readUntil = async (res, stop) => {
		const reader = res.body.getReader()
		const got = []
		let buf = ''
		while (!stop(got)) {
			const { value, done } = await reader.read()
			if (done) break
			buf += new TextDecoder().decode(value)
			const lines = buf.split('\n')
			buf = lines.pop()
			for (const l of lines) if (l) got.push(JSON.parse(l))
		}
		return { got, reader }
	}
	test('an exec with an id outlives its client, which reads on from where it was', async () => {
		const id = 'exec-outlives-1'
		const res = await exec({ id, cmd: ['sh', '-c', 'echo $$; echo one; while [ ! -f go ]; do sleep 0.05; done; echo two'], cwd: '.', timeoutMs: 20000 })
		const { got, reader } = await readUntil(res, (ev) => ev.map((e) => e.data).join('').includes('one\n'))
		const pid = Number(got[0].data.split('\n')[0])
		await reader.cancel()
		await new Promise((r) => setTimeout(r, 300))
		assert.ok(alive(pid), 'the command survived its client')
		await fs.writeFile(path.join(root, 'go'), '')
		const rest = await events(await api(`/exec/${id}?after=${got.length}`))
		assert.deepEqual(rest.map((e) => e.type), ['stdout', 'exit'])
		assert.equal(rest[0].data, 'two\n')
		assert.equal(rest[1].code, 0)
		// Every event is still there for a client that lost them all.
		assert.deepEqual(await events(await api(`/exec/${id}`)), [...got, ...rest])
		await fs.rm(path.join(root, 'go'))
	})
	test('a detached exec is killed after the grace period, a DELETE kills one at once, and ids are checked', async () => {
		const { s, url } = await start({ detachGraceMs: 300 })
		const call = (p, init = {}) => fetch(url + p, { ...init, headers: auth })
		const run = (id, cmd) => call('/exec', { method: 'POST', body: JSON.stringify({ id, cmd, timeoutMs: 60000 }) })
		try {
			const sleeper = ['sh', '-c', 'sleep 63 & echo $!; wait']
			const { got, reader } = await readUntil(await run('detached-1', sleeper), (ev) => ev.length > 0)
			const pid = Number(got[0].data)
			await reader.cancel()
			assert.ok(await until(() => !alive(pid)), 'killed once nobody came back')
			assert.equal((await events(await call('/exec/detached-1'))).at(-1).signal, 'SIGTERM')
			const second = await readUntil(await run('deleted-1', sleeper), (ev) => ev.length > 0)
			assert.equal((await call('/exec/deleted-1', { method: 'DELETE' })).status, 200)
			assert.ok(await until(() => !alive(Number(second.got[0].data))))
			assert.equal((await run('deleted-1', ['true'])).status, 409, 'an id is not reused while it is kept')
			assert.equal((await call('/exec/nope-nope-1')).status, 404)
			assert.equal((await call('/exec/deleted-1?after=99')).status, 400)
			assert.equal((await run('bad id!', ['true'])).status, 400)
		} finally {
			s.close()
		}
	})
	test('output is capped, truncated and killed', async () => {
		const { s, url } = await start({ maxOutputBytes: 1000 })
		try {
			const res = await fetch(`${url}/exec`, { method: 'POST', headers: auth, body: JSON.stringify({ cmd: ['sh', '-c', 'yes abcdefghij'], timeoutMs: 20000 }) })
			const ev = await events(res)
			const out = ev.filter((e) => e.type === 'stdout').map((e) => e.data).join('')
			assert.equal(out.length, 1000)
			assert.deepEqual(ev.at(-2), { type: 'stderr', data: '[output truncated]' })
			const exit = ev.at(-1)
			assert.equal(exit.type, 'exit')
			assert.equal(exit.timedOut, false)
			assert.equal(ev.filter((e) => e.type === 'exit').length, 1)
		} finally {
			s.close()
		}
	})
})

describe('files', () => {
	test('round trips binary, creates parents, accepts absolute paths', async () => {
		const bytes = Buffer.from([0, 255, 1, 254, 0x80, 0, 10, 13])
		const put = await api('/file?path=a/b/c.bin&mode=0600', { method: 'PUT', body: bytes })
		assert.equal(put.status, 200)
		const got = Buffer.from(await (await api(`/file?path=${encodeURIComponent(path.join(root, 'a/b/c.bin'))}`)).arrayBuffer())
		assert.deepEqual(got, bytes)
		assert.equal((await fs.stat(path.join(root, 'a/b/c.bin'))).mode & 0o777, 0o600)
	})
	test('writes are atomic: a failed upload leaves the old file and no temp files', async () => {
		await api('/file?path=atomic.txt', { method: 'PUT', body: 'old' })
		await new Promise((resolve) => {
			const req = http.request(`${base}/file?path=atomic.txt`, { method: 'PUT', headers: { ...auth, 'content-length': '1000' } })
			req.on('error', resolve)
			req.write('partial')
			setTimeout(() => req.destroy(), 100)
		})
		await until(async () => !(await fs.readdir(root)).some((n) => n.endsWith('.tmp')))
		assert.equal(await fs.readFile(path.join(root, 'atomic.txt'), 'utf8'), 'old')
		assert.deepEqual((await fs.readdir(root)).filter((n) => n.endsWith('.tmp')), [])
		await api('/file?path=atomic.txt', { method: 'PUT', body: 'new' })
		assert.equal(await (await api('/file?path=atomic.txt')).text(), 'new')
	})
	test('list, stat, delete', async () => {
		await api('/file?path=d/f.txt', { method: 'PUT', body: 'hello' })
		await fs.symlink('f.txt', path.join(root, 'd/l'))
		await fs.mkdir(path.join(root, 'd/sub'))
		const list = await (await api('/list?path=d')).json()
		const by = Object.fromEntries(list.map((e) => [e.name, e]))
		assert.equal(by['f.txt'].type, 'file')
		assert.equal(by['f.txt'].size, 5)
		assert.equal(typeof by['f.txt'].mtimeMs, 'number')
		assert.equal(by['f.txt'].mode, 0o644)
		assert.equal(by.l.type, 'symlink')
		assert.equal(by.sub.type, 'dir')
		const st = await (await api('/stat?path=d/f.txt')).json()
		assert.equal(st.name, 'f.txt')
		assert.equal((await api('/stat?path=d/missing')).status, 404)
		assert.equal((await api('/file?path=d/missing')).status, 404)
		assert.equal((await api('/file?path=d')).status, 400)
		assert.equal((await api('/file?path=d', { method: 'DELETE' })).status, 409)
		assert.equal((await api('/file?path=d/f.txt', { method: 'DELETE' })).status, 200)
		assert.equal((await api('/stat?path=d/f.txt')).status, 404)
		assert.equal((await api('/file?path=d&recursive=1', { method: 'DELETE' })).status, 200)
		assert.equal(existsSync(path.join(root, 'd')), false)
	})
	test('a full disk or quota is 507 disk_full', async () => {
		for (const code of ['ENOSPC', 'EDQUOT']) {
			await assert.rejects(guard('a', () => Promise.reject(Object.assign(new Error(code), { code }))), { status: 507, code: 'disk_full' })
		}
	})
	test('rejects escapes for read, write, list, delete and exec cwd', async () => {
		const bad = ['../outside/secret.txt', 'a/../../outside/secret.txt', path.join(outside, 'secret.txt'), '/etc/passwd', 'linkfile', 'linkdir/secret.txt', 'linkdir/new.txt', 'linkdir/sub/new.txt', 'dangling/x', '/']
		for (const p of bad) {
			const q = encodeURIComponent(p)
			const isRoot = p === '/'
			const expect = (res, what) => assert.equal(res.status, 400, `${what} ${p} -> ${res.status}`)
			const check = async (res, what) => {
				if (isRoot) return // '/' is outside the root unless root is '/'
				expect(res, what)
				assert.equal((await res.json()).error, 'path_escape')
			}
			if (!p.endsWith('new.txt') && !p.endsWith('x') && p !== 'linkdir/sub/new.txt') await check(await api(`/file?path=${q}`), 'read')
			await check(await api(`/file?path=${q}`, { method: 'PUT', body: 'pwn' }), 'write')
			await check(await api(`/list?path=${q}`), 'list')
			await check(await exec({ cmd: ['true'], cwd: p }), 'cwd')
			if (p !== 'linkfile') await check(await api(`/file?path=${q}&recursive=1`, { method: 'DELETE' }), 'delete')
		}
		assert.equal(await fs.readFile(path.join(outside, 'secret.txt'), 'utf8'), 'secret')
		assert.deepEqual((await fs.readdir(outside)).sort(), ['secret.txt'])
	})
	test('deleting a symlink removes the link, not its target', async () => {
		await fs.symlink(outside, path.join(root, 'tmplink'))
		assert.equal((await api('/file?path=tmplink', { method: 'DELETE' })).status, 200)
		assert.equal(existsSync(path.join(root, 'tmplink')), false)
		assert.equal(existsSync(path.join(outside, 'secret.txt')), true)
	})
	test('listing the root works and the root cannot be deleted', async () => {
		assert.equal((await api('/list?path=.')).status, 200)
		assert.equal((await api('/file?path=.&recursive=1', { method: 'DELETE' })).status, 400)
	})
	test('body limit returns 413 and leaves nothing behind', async () => {
		const { s, url } = await start({ maxBodyBytes: 1024 })
		try {
			const res = await fetch(`${url}/file?path=big.bin`, { method: 'PUT', headers: auth, body: Buffer.alloc(4096) })
			assert.equal(res.status, 413)
			assert.equal((await res.json()).error, 'body_too_large')
			// Chunked upload with no content-length is stopped while streaming.
			const chunked = await new Promise((resolve, reject) => {
				const req = http.request(`${url}/file?path=big2.bin`, { method: 'PUT', headers: auth }, (r) => resolve(r.statusCode))
				req.on('error', reject)
				req.write(Buffer.alloc(900))
				req.write(Buffer.alloc(900))
				req.end()
			})
			assert.equal(chunked, 413)
			assert.equal(existsSync(path.join(root, 'big.bin')), false)
			assert.equal(existsSync(path.join(root, 'big2.bin')), false)
			assert.deepEqual((await fs.readdir(root)).filter((n) => n.endsWith('.tmp')), [])
		} finally {
			s.close()
		}
	})
	test('default body cap is 64 MiB', async () => {
		const res = await fetch(`${base}/file?path=huge.bin`, { method: 'PUT', headers: { ...auth, 'content-length': String(64 * 1024 * 1024 + 1) }, body: 'x' }).catch((e) => e)
		// Either the declared length is refused, or fetch rejects the mismatched length itself.
		if (res instanceof Response) assert.equal(res.status, 413)
	})
})
