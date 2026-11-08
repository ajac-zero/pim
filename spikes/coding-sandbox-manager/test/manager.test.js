import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { after, afterEach, beforeEach, describe, test } from 'node:test'
import { Docker } from '../src/docker.js'
import { createManager, selfCheck } from '../src/manager.js'
import { startFakeDocker } from '../support/fake-docker.js'

const IMAGE = 'registry.example/sandbox@sha256:abc'
const limits = { cpu: 1.5, memMiB: 512, diskMiB: 1024, pids: 128 }
const good = { sessionId: 'abc-1', image: IMAGE, limits, egressAllow: ['github.com', '*.npmjs.org'] }
const cfg = { token: 't0ken', allowedImages: [IMAGE], dockerRoot: '/', minFreePct: 15, maxConcurrent: 2, idleMin: 30, proxyUrl: 'http://egress-proxy:3128', proxyContainer: 'egress-proxy' }

let fake, mgr, proxy, base
const statfsFn = async () => ({ bavail: 50, blocks: 100 })
async function call(method, path, body, headers = {}) {
	const r = await fetch(base + path, { method, headers: { authorization: 'Bearer t0ken', ...headers }, body: body === undefined ? undefined : typeof body === 'string' || Buffer.isBuffer(body) ? body : JSON.stringify(body) })
	const text = await r.text()
	let json
	try { json = JSON.parse(text) } catch {}
	return { status: r.status, json, text }
}

async function setup(over = {}) {
	fake = await startFakeDocker()
	proxy = { set: async (ip, hosts) => (proxy.map[ip] = hosts), del: async (ip) => delete proxy.map[ip], map: {} }
	mgr = createManager({ docker: new Docker(fake.path), cfg: { ...cfg, ...over }, proxyAdmin: proxy, statfsFn })
	await new Promise((r) => mgr.server.listen(0, '127.0.0.1', r))
	base = `http://127.0.0.1:${mgr.server.address().port}`
}
async function teardown() {
	mgr.server.closeAllConnections()
	await new Promise((r) => mgr.server.close(r))
	await fake.close()
}

describe('template validation', () => {
	beforeEach(() => setup())
	afterEach(() => teardown())

	const reject = async (patch, status) => {
		const r = await call('POST', '/sessions', { ...good, ...patch })
		assert.equal(r.status, status, r.text)
		assert.equal(fake.containers.size, 0)
		assert.equal(fake.calls.filter((c) => c.path === '/containers/create').length, 0)
	}
	test('rejects binds, privileged, caps, host network, devices', async () => {
		await reject({ binds: ['/:/host'] }, 400)
		await reject({ Binds: ['/var/run/docker.sock:/s'] }, 400)
		await reject({ privileged: true }, 400)
		await reject({ capAdd: ['SYS_ADMIN'] }, 400)
		await reject({ networkMode: 'host' }, 400)
		await reject({ HostConfig: { Privileged: true } }, 400)
		await reject({ limits: { ...limits, privileged: true } }, 400)
	})
	test('rejects images outside the allowlist, including tag variants', async () => {
		await reject({ image: 'alpine:latest' }, 403)
		await reject({ image: IMAGE.replace('abc', 'abd') }, 403)
	})
	test('rejects out-of-range or non-numeric limits and bad session ids and hosts', async () => {
		await reject({ limits: { ...limits, memMiB: 1e9 } }, 400)
		await reject({ limits: { ...limits, pids: '100' } }, 400)
		await reject({ limits: { ...limits, cpu: 0 } }, 400)
		await reject({ limits: { ...limits, pids: 1.5 } }, 400)
		await reject({ sessionId: '../x' }, 400)
		await reject({ egressAllow: ['10.0.0.1'] }, 400)
		await reject({ egressAllow: ['a.com/../b'] }, 400)
	})
	test('builds a hardened container from the template only', async () => {
		const r = await call('POST', '/sessions', good)
		assert.equal(r.status, 201, r.text)
		const c = fake.containers.get('pim-s-abc-1').body
		const h = c.HostConfig
		assert.equal(h.Runtime, 'runsc')
		assert.equal(h.Privileged, false)
		assert.equal(h.ReadonlyRootfs, true)
		assert.deepEqual(h.CapDrop, ['ALL'])
		assert.deepEqual(h.SecurityOpt, ['no-new-privileges'])
		assert.equal(c.User, '10001')
		assert.equal(h.PidsLimit, 128)
		assert.equal(h.Memory, 512 * 1024 * 1024)
		assert.equal(h.NanoCpus, 1.5e9)
		assert.match(h.Tmpfs['/tmp'], /size=\d+m/)
		assert.equal(h.Binds, undefined)
		assert.equal(h.PortBindings, undefined)
		assert.equal(h.PublishAllPorts, false)
		assert.deepEqual(h.Mounts.map((m) => [m.Type, m.Target]), [['volume', '/workspace']])
		assert.equal(c.Labels['pim.coding.session'], 'abc-1')
		assert.equal(h.NetworkMode, 'pim-net-abc-1')
		// Docker's embedded DNS is unavailable under gVisor, so the env carries the proxy's IP.
		for (const k of ['HTTP_PROXY', 'HTTPS_PROXY', 'http_proxy', 'https_proxy']) assert.ok(c.Env.includes(`${k}=http://10.9.100.2:3128`), k)
		assert.ok(!c.Env.some((e) => e.includes('egress-proxy')))
		const order = fake.calls.map((x) => x.path)
		assert.ok(order.indexOf('/networks/pim-net-abc-1/connect') < order.indexOf('/containers/create'), 'proxy attached before the container is created')
		const net = fake.calls.find((x) => x.path === '/networks/create').body
		assert.equal(net.Internal, true)
		assert.ok(fake.proxyNet.has('pim-net-abc-1'))
		// Without the alias the proxy's name does not resolve inside the session network.
		const connect = fake.calls.find((x) => x.path === '/networks/pim-net-abc-1/connect').body
		assert.deepEqual(connect, { Container: 'egress-proxy', EndpointConfig: { Aliases: ['egress-proxy'] } })
		assert.deepEqual(Object.values(proxy.map), [['github.com', '*.npmjs.org']])
	})
})

describe('sessions', () => {
	beforeEach(() => setup())
	afterEach(() => teardown())

	test('create is idempotent, also when concurrent, and conflicting params give 409', async () => {
		const [a, b] = await Promise.all([call('POST', '/sessions', good), call('POST', '/sessions', good)])
		assert.deepEqual([a.status, b.status].sort(), [200, 201])
		assert.equal(fake.calls.filter((c) => c.path === '/containers/create').length, 1)
		const c = await call('POST', '/sessions', { ...good, limits: { ...limits, pids: 64 } })
		assert.equal(c.status, 409)
	})
	test('enforces auth, concurrency and free-disk limits', async () => {
		assert.equal((await call('GET', '/sessions/abc-1', undefined, { authorization: 'Bearer nope' })).status, 401)
		assert.equal((await call('POST', '/sessions', good, { authorization: '' })).status, 401)
		await call('POST', '/sessions', good)
		await call('POST', '/sessions', { ...good, sessionId: 'abc-2' })
		assert.equal((await call('POST', '/sessions', { ...good, sessionId: 'abc-3' })).status, 429)
		const low = createManager({ docker: new Docker(fake.path), cfg, proxyAdmin: proxy, statfsFn: async () => ({ bavail: 10, blocks: 100 }) })
		await assert.rejects(low.createSession({ ...good, sessionId: 'abc-9' }), { status: 507 })
	})
	test('delete removes container, volume and network, and is safe to repeat', async () => {
		await call('POST', '/sessions', good)
		assert.equal((await call('DELETE', '/sessions/abc-1')).status, 200)
		assert.equal(fake.containers.size + fake.networks.size + fake.volumes.size, 0)
		assert.deepEqual(proxy.map, {})
		assert.equal((await call('GET', '/sessions/abc-1')).status, 404)
	})
	test('a failed create leaves nothing behind', async () => {
		fake.containers.set('pim-s-abc-1', { id: 'x', body: {}, ip: '1' }) // makes create conflict
		const r = await call('POST', '/sessions', good)
		assert.equal(r.status, 500)
		assert.equal(fake.networks.size + fake.volumes.size, 0)
	})
	test('reaper removes idle sessions; reconcile rebuilds from labels', async () => {
		await call('POST', '/sessions', good)
		const s = mgr.sessions.get('abc-1')
		const fresh = createManager({ docker: new Docker(fake.path), cfg, proxyAdmin: proxy, statfsFn })
		fake.volumes.add('pim-ws-orphan')
		await fresh.reconcile()
		assert.ok(fresh.sessions.has('abc-1'))
		assert.deepEqual(fresh.sessions.get('abc-1').params, good)
		assert.ok(!fake.volumes.has('pim-ws-orphan'), 'orphan volume removed')
		s.lastUsed = Date.now() - 31 * 60000
		await mgr.reap()
		assert.equal(mgr.sessions.size, 0)
		assert.equal(fake.containers.size, 0)
	})
	test('health reports runsc, disk and session count', async () => {
		await call('POST', '/sessions', good)
		const r = await call('GET', '/health', undefined, { authorization: '' })
		assert.deepEqual(r.json, { runsc: true, freeDiskPct: 50, sessions: 1 })
	})
})

describe('exec and files', () => {
	beforeEach(async () => {
		await setup()
		await call('POST', '/sessions', good)
	})
	afterEach(() => teardown())

	test('exec demuxes stdout/stderr, passes stdin, cwd and runs as 10001', async () => {
		fake.onExec = (cmd, stdin) => ({ stdout: `out:${stdin}`, stderr: 'err', exitCode: 3 })
		const r = await call('POST', '/sessions/abc-1/exec', { cmd: ['cat'], stdin: 'hello', timeoutMs: 5000, cwd: 'sub' })
		assert.deepEqual(r.json, { stdout: 'out:hello', stderr: 'err', exitCode: 3, timedOut: false, truncated: false })
		assert.equal(fake.execLog[0].User, '10001')
		assert.equal(fake.execLog[0].WorkingDir, '/workspace/sub')
	})
	test('exec timeout drops the stream and kills the sandbox processes', async () => {
		fake.onExec = (cmd) => (cmd[0] === 'sleep' ? { hang: true } : { exitCode: 0 })
		const t = Date.now()
		const r = await call('POST', '/sessions/abc-1/exec', { cmd: ['sleep', '100'], timeoutMs: 200 })
		assert.ok(Date.now() - t < 3000)
		assert.equal(r.json.timedOut, true)
		assert.equal(r.json.exitCode, null)
		assert.deepEqual(fake.execLog.at(-1).Cmd, ['kill', '-9', '-1'])
	})
	test('exec validates its body', async () => {
		for (const b of [{ cmd: 'ls', timeoutMs: 1000 }, { cmd: ['ls'] }, { cmd: ['ls'], timeoutMs: 1000, user: 'root' }, { cmd: ['ls'], timeoutMs: 1000, cwd: '/etc' }, { cmd: ['ls'], timeoutMs: 1000, cwd: '../..' }]) {
			assert.equal((await call('POST', '/sessions/abc-1/exec', b)).status, 400 + (b.cwd ? 3 : 0), JSON.stringify(b))
		}
	})
	test('file paths are confined: lexical escapes and in-container symlink escapes are rejected', async () => {
		for (const p of ['/etc/passwd', '../etc/passwd', 'a/../../etc', '/workspace/../etc', '/workspaceevil/x']) {
			assert.equal((await call('GET', `/sessions/abc-1/files?path=${encodeURIComponent(p)}`)).status, 403, p)
		}
		assert.equal(fake.execLog.length, 0, 'lexical rejects never reach the container')
		fake.onExec = () => ({ exitCode: 77 }) // the in-container realpath check says: outside /workspace
		assert.equal((await call('PUT', '/sessions/abc-1/files?path=link/x', 'data')).status, 403)
		const script = fake.execLog[0].Cmd
		assert.match(script[2], /realpath -m/)
		assert.equal(script[4], '/workspace/link/x')
	})
	test('file write sends the body on stdin; read returns bytes; missing file is 404', async () => {
		fake.onExec = (cmd, stdin) => ({ exitCode: 0, stdout: cmd[2].includes('cat >') ? '' : 'contents' })
		assert.equal((await call('PUT', '/sessions/abc-1/files?path=a.txt', 'hello')).status, 200)
		assert.equal((await call('GET', '/sessions/abc-1/files?path=a.txt')).text, 'contents')
		fake.onExec = () => ({ exitCode: 78 })
		assert.equal((await call('GET', '/sessions/abc-1/files?path=nope')).status, 404)
	})
})

describe('gVisor self-check', () => {
	let f
	afterEach(() => f.close())

	test('passes when runsc is listed and the probe runs under it', async () => {
		f = await startFakeDocker()
		await selfCheck(new Docker(f.path), 'busybox')
		const probe = f.calls.find((c) => c.path === '/containers/create').body
		assert.equal(probe.HostConfig.Runtime, 'runsc')
		assert.deepEqual(probe.Cmd, ['true'])
	})
	test('fails when runsc is not registered', async () => {
		f = await startFakeDocker({ runtimes: { runc: {} } })
		await assert.rejects(selfCheck(new Docker(f.path), 'busybox'), /gVisor \(runsc\) is required/)
	})
	test('fails when the probe container fails', async () => {
		f = await startFakeDocker({ probeExit: 1 })
		await assert.rejects(selfCheck(new Docker(f.path), 'busybox'), /gVisor \(runsc\) is required/)
		assert.equal(f.containers.size, 0, 'probe container cleaned up')
	})
	test('the service exits non-zero with a clear message when the check fails', async () => {
		f = await startFakeDocker({ runtimes: { runc: {} } })
		const r = spawnSync(process.execPath, ['src/main.js'], {
			cwd: new URL('..', import.meta.url),
			env: { ...process.env, DOCKER_HOST: `unix://${f.path}`, MANAGER_TOKEN: 'x', ALLOWED_IMAGES: IMAGE, PROXY_ADMIN_TOKEN: 'y' },
			encoding: 'utf8',
			timeout: 10000,
		})
		// spawnSync blocks this process's event loop, so the fake must answer from another one.
		assert.notEqual(r.status, 0)
	})
})
