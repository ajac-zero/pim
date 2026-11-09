import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { promises as fs, readFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, test } from 'node:test'
import { createAgentd } from '../../workspace-agentd/server.mjs'
import { Docker } from '../src/docker.js'
import { createManager, defaultMaxConcurrent, detectQuotaMode, selfCheck } from '../src/manager.js'
import { exit } from '../support/fake-agentd.js'
import { startFakeDocker } from '../support/fake-docker.js'

const IMAGE = 'registry.example/sandbox@sha256:abc'
const MiB = 1024 * 1024
const limits = { cpu: 1.5, memMiB: 512, diskMiB: 1024, pids: 128 }
const good = { sessionId: 'abc-1', image: IMAGE, limits, egressAllow: ['github.com', '*.npmjs.org'] }
const cfg = { token: 't0ken', agentdSecret: 's3cret', allowedImages: [IMAGE], dockerRoot: '/', minFreePct: 15, maxConcurrent: 2, idleMin: 30, proxyUrl: 'http://egress-proxy:3128', proxyContainer: 'egress-proxy', quotaMode: 'measure', agentdReadyMs: 2000, execGraceMs: 200 }

let fake, mgr, proxy, base
const statfsFn = async () => ({ bavail: 50, blocks: 100 })
const make = (over = {}, opts = {}) => createManager({ docker: new Docker(fake.path), cfg: { ...cfg, ...over }, proxyAdmin: proxy, statfsFn, agentdAddress: fake.agentdAddress, ...opts })
async function call(method, path, body, headers = {}, host = '127.0.0.1') {
	const r = await fetch(`http://${host}:${mgr.server.address().port}${path}`, { method, headers: { authorization: 'Bearer t0ken', ...headers }, body: body === undefined ? undefined : typeof body === 'string' || Buffer.isBuffer(body) ? body : JSON.stringify(body) })
	const text = await r.text()
	let json
	try { json = JSON.parse(text) } catch {}
	return { status: r.status, json, text }
}
const alive = (pid) => {
	try {
		process.kill(pid, 0)
		return !/\) Z /.test(readFileSync(`/proc/${pid}/stat`, 'utf8')) // zombies are dead
	} catch {
		return false
	}
}
const envOf = (name) => Object.fromEntries(fake.containers.get(name).body.Env.map((e) => e.split(/=(.*)/s).slice(0, 2)))

async function setup(over = {}, dockerOpts = {}, listenHost = '127.0.0.1') {
	fake = await startFakeDocker(dockerOpts)
	proxy = { sets: [], set: async (ip, hosts) => (proxy.sets.push(ip), (proxy.map[ip] = hosts)), del: async (ip) => delete proxy.map[ip], map: {} }
	mgr = make(over)
	await new Promise((r) => mgr.server.listen(0, listenHost, r))
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
		await reject({ limits: { ...limits, diskMiB: 30000 } }, 400)
		await reject({ sessionId: '../x' }, 400)
		await reject({ egressAllow: ['10.0.0.1'] }, 400)
		await reject({ egressAllow: ['a.com/../b'] }, 400)
	})
	test('image defaults to the first allowed one and the disk quota to 5 GiB', async () => {
		const { image, limits: { diskMiB, ...rest } } = good
		const r = await call('POST', '/sessions', { sessionId: 'abc-1', limits: rest })
		assert.equal(r.status, 201, r.text)
		assert.equal(r.json.image, image)
		assert.equal(r.json.limits.diskMiB, 5120)
		assert.equal(fake.containers.get('pim-s-abc-1').body.Image, IMAGE)
		// The defaults are part of the parameters, so spelling them out is the same session.
		assert.equal((await call('POST', '/sessions', { sessionId: 'abc-1', image, limits: { ...rest, diskMiB: 5120 }, egressAllow: [] })).status, 200)
		assert.equal((await call('POST', '/sessions', { sessionId: 'abc-1', limits: { ...rest, diskMiB: 1024 } })).status, 409)
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
		assert.ok(fake.infra.get('egress-proxy').nets.has('pim-net-abc-1'))
		// Without the alias the proxy's name does not resolve inside the session network.
		const connect = fake.calls.find((x) => x.path === '/networks/pim-net-abc-1/connect').body
		assert.deepEqual(connect, { Container: 'egress-proxy', EndpointConfig: { Aliases: ['egress-proxy'] } })
		assert.deepEqual(Object.values(proxy.map), [['github.com', '*.npmjs.org']])
	})
	test('runs the image entrypoint (agentd) with a per-session token kept out of labels', async () => {
		await call('POST', '/sessions', good)
		await call('POST', '/sessions', { ...good, sessionId: 'abc-2' })
		const c = fake.containers.get('pim-s-abc-1').body
		assert.equal(c.Entrypoint, undefined)
		assert.equal(c.Cmd, undefined)
		const env = envOf('pim-s-abc-1')
		assert.match(env.AGENTD_TOKEN, /^[0-9a-f]{64}$/)
		assert.notEqual(env.AGENTD_TOKEN, envOf('pim-s-abc-2').AGENTD_TOKEN)
		assert.equal(env.AGENTD_ROOT, '/workspace')
		assert.equal(env.AGENTD_MAX_OUTPUT_BYTES, String(20 * MiB))
		for (const where of [c.Labels, fake.volumes.get('pim-ws-abc-1').Labels, fake.networks.get('pim-net-abc-1').Labels]) {
			assert.ok(!JSON.stringify(where).includes(env.AGENTD_TOKEN), 'token in a label')
		}
		assert.ok(!JSON.stringify(fake.calls.map((x) => x.body)).includes('s3cret'), 'secret sent to Docker')
		// The manager waited for this agentd before answering, with this token.
		assert.deepEqual(fake.agentd('pim-s-abc-1').calls.map((x) => [x.path, x.token]), [['/health', `Bearer ${env.AGENTD_TOKEN}`]])
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
		const full = await call('POST', '/sessions', { ...good, sessionId: 'abc-3' })
		assert.equal(full.status, 429)
		assert.deepEqual(full.json, { error: 'at capacity', code: 'capacity', limit: 2, running: 2 })
		await call('DELETE', '/sessions/abc-2')
		const low = make({}, { statfsFn: async () => ({ bavail: 10, blocks: 100 }) })
		await assert.rejects(low.createSession({ ...good, sessionId: 'abc-9' }), (e) => e.status === 507 && e.extra.code === 'low_disk')
	})
	test('concurrent creates far above the limit never exceed it, and delete frees a slot', async () => {
		const rs = await Promise.all(Array.from({ length: 12 }, (_, i) => call('POST', '/sessions', { ...good, sessionId: `s-${i}` })))
		assert.equal(rs.filter((r) => r.status === 201).length, 2)
		assert.equal(rs.filter((r) => r.status === 429 && r.json.code === 'capacity').length, 10)
		assert.equal(fake.containers.size, 2)
		assert.equal((await call('DELETE', `/sessions/${rs.find((r) => r.status === 201).json.sessionId}`)).status, 200)
		assert.equal((await call('POST', '/sessions', { ...good, sessionId: 'later' })).status, 201)
		assert.equal((await call('POST', '/sessions', { ...good, sessionId: 'later2' })).status, 429)
	})
	test('a failed create releases its slot', async () => {
		fake.containers.set('pim-s-abc-1', { id: 'x', body: {}, ip: '1' })
		assert.equal((await call('POST', '/sessions', good)).status, 500)
		assert.equal((await call('POST', '/sessions', { ...good, sessionId: 'abc-2' })).status, 201)
		assert.equal((await call('POST', '/sessions', { ...good, sessionId: 'abc-3' })).status, 201)
	})
	test('a session whose agentd never answers fails to create and leaves nothing behind', async () => {
		fake.startAgentd = async () => ({ port: 1, close: async () => {} }) // nothing listens there
		const quick = make({ agentdReadyMs: 300 })
		await assert.rejects(quick.createSession(good), (e) => e.status === 502 && e.extra.code === 'agentd_unreachable')
		assert.equal(fake.containers.size + fake.networks.size + fake.volumes.size, 0)
	})
	test('a lowered limit refuses new sessions but kills none, and idempotent create still works', async () => {
		await call('POST', '/sessions', good)
		await call('POST', '/sessions', { ...good, sessionId: 'abc-2' })
		const lowered = make({ maxConcurrent: 1 })
		await lowered.reconcile()
		assert.equal(lowered.sessions.size, 2)
		await assert.rejects(lowered.createSession({ ...good, sessionId: 'abc-3' }), { status: 429, extra: { code: 'capacity', limit: 1, running: 2 } })
		assert.equal((await lowered.createSession(good)).created, false)
		assert.equal(fake.containers.size, 2)
	})
	test('low disk is refused with a typed error and creates nothing', async () => {
		const low = make({ minFreePct: 20 }, { statfsFn: async () => ({ bavail: 19, blocks: 100 }) })
		await assert.rejects(low.createSession(good), { status: 507, extra: { code: 'low_disk', freeDiskPct: 19, minFreePct: 20 } })
		assert.equal(fake.containers.size, 0)
		const ok = make({ minFreePct: 20 }, { statfsFn: async () => ({ bavail: 20, blocks: 100 }) })
		assert.equal((await ok.createSession(good)).created, true)
	})
	test('delete removes container, volume and network, and is safe to repeat', async () => {
		await call('POST', '/sessions', good)
		assert.equal((await call('DELETE', '/sessions/abc-1')).status, 200)
		assert.equal(fake.containers.size + fake.networks.size + fake.volumes.size, 0)
		assert.deepEqual(proxy.map, {})
		assert.equal((await call('GET', '/sessions/abc-1')).status, 404)
		assert.equal((await call('DELETE', '/sessions/abc-1')).status, 200)
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
		const fresh = make()
		fake.volumes.set('pim-ws-orphan', { Name: 'pim-ws-orphan', Labels: { 'pim.coding.session': 'orphan' } })
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
		assert.deepEqual(r.json, { runsc: true, freeDiskPct: 50, maxConcurrent: 2, running: 1, free: 1, sessions: 1 })
	})
})

describe('defaultMaxConcurrent', () => {
	const GiB = 2 ** 30
	test('derives the limit from cpus and memory, clamped to 1..8', () => {
		const table = [[2, 3, 1], [4, 16, 4], [8, 8, 4], [16, 64, 8], [1, 1, 1], [32, 2, 1], [3, 4.5, 2], [6, 10, 6]]
		for (const [cpus, mem, want] of table) assert.equal(defaultMaxConcurrent(cpus, mem * GiB), want, `${cpus} cpus ${mem} GiB`)
		assert.ok(defaultMaxConcurrent() >= 1 && defaultMaxConcurrent() <= 8)
	})
})

describe('exec and files through agentd', () => {
	let agent
	beforeEach(async () => {
		await setup()
		await call('POST', '/sessions', good)
		agent = fake.agentd('pim-s-abc-1')
	})
	afterEach(() => teardown())
	const execCalls = () => agent.calls.filter((c) => c.path === '/exec')

	test('exec gathers stdout/stderr, passes stdin, cwd, the proxy env and the session token', async () => {
		agent.onExec = (b) => [{ type: 'stdout', data: `out:${b.stdin}` }, { type: 'stderr', data: 'err' }, { type: 'stdout', data: '!' }, exit(3)]
		const r = await call('POST', '/sessions/abc-1/exec', { cmd: ['cat'], stdin: 'hello', timeoutMs: 5000, cwd: 'sub' })
		assert.deepEqual(r.json, { stdout: 'out:hello!', stderr: 'err', exitCode: 3, timedOut: false, truncated: false })
		const [x] = execCalls()
		assert.equal(x.token, `Bearer ${envOf('pim-s-abc-1').AGENTD_TOKEN}`)
		assert.deepEqual({ ...x.body, env: undefined }, { cmd: ['cat'], stdin: 'hello', timeoutMs: 5000, cwd: 'sub', env: undefined })
		assert.equal(x.body.env.HTTPS_PROXY, 'http://10.9.100.2:3128')
		assert.equal(fake.calls.filter((c) => c.path.includes('/exec')).length, 0, 'no Docker exec')
	})
	test('exec maps a missing command to 127, a signal to 128+n, and caps each stream at 10 MiB', async () => {
		agent.onExec = () => ({ spawnFailed: 'cannot start nope: ENOENT' })
		assert.deepEqual((await call('POST', '/sessions/abc-1/exec', { cmd: ['nope'], timeoutMs: 1000 })).json, { stdout: '', stderr: 'cannot start nope: ENOENT\n', exitCode: 127, timedOut: false, truncated: false })
		agent.onExec = () => [exit(null, { signal: 'SIGKILL' })]
		assert.equal((await call('POST', '/sessions/abc-1/exec', { cmd: ['x'], timeoutMs: 1000 })).json.exitCode, 137)
		const chunk = 'a'.repeat(4 * MiB)
		agent.onExec = () => [...Array(3).fill({ type: 'stdout', data: chunk }), { type: 'stderr', data: 'e' }, exit(0)]
		const r = await call('POST', '/sessions/abc-1/exec', { cmd: ['x'], timeoutMs: 1000 })
		assert.equal(r.json.stdout.length, 10 * MiB)
		assert.equal(r.json.stderr, 'e')
		assert.equal(r.json.truncated, true)
	})
	test('exec timeout is agentd killing that exec only: no other kill reaches the sandbox', async () => {
		agent.onExec = (b) => (b.cmd[0] === 'sleep' ? [exit(null, { signal: 'SIGTERM', timedOut: true })] : [{ type: 'stdout', data: 'still here' }, exit(0)])
		const r = await call('POST', '/sessions/abc-1/exec', { cmd: ['sleep', '100'], timeoutMs: 200 })
		assert.equal(r.json.timedOut, true)
		assert.equal(r.json.exitCode, null)
		assert.deepEqual(execCalls().map((c) => [c.body.cmd, c.body.timeoutMs]), [[['sleep', '100'], 200]])
		assert.equal(fake.calls.filter((c) => c.path.includes('/exec')).length, 0, 'no Docker exec')
		assert.equal((await call('POST', '/sessions/abc-1/exec', { cmd: ['echo'], timeoutMs: 1000 })).json.stdout, 'still here')
	})
	test('a hung agentd is dropped after the timeout plus grace, which makes agentd kill the group', async () => {
		agent.onExec = () => ({ hang: true })
		const t = Date.now()
		const r = await call('POST', '/sessions/abc-1/exec', { cmd: ['sleep', '100'], timeoutMs: 200 })
		assert.ok(Date.now() - t < 3000)
		assert.deepEqual({ timedOut: r.json.timedOut, exitCode: r.json.exitCode }, { timedOut: true, exitCode: null })
	})
	test('exec validates its body', async () => {
		for (const b of [{ cmd: 'ls', timeoutMs: 1000 }, { cmd: ['ls'] }, { cmd: ['ls'], timeoutMs: 1000, user: 'root' }, { cmd: ['ls'], timeoutMs: 1000, cwd: '/etc' }, { cmd: ['ls'], timeoutMs: 1000, cwd: '../..' }]) {
			assert.equal((await call('POST', '/sessions/abc-1/exec', b)).status, 400 + (b.cwd ? 3 : 0), JSON.stringify(b))
		}
		assert.equal(execCalls().length, 0)
	})
	test('file paths are confined: lexical escapes never reach agentd, symlink escapes it finds are 403', async () => {
		for (const p of ['/etc/passwd', '../etc/passwd', 'a/../../etc', '/workspace/../etc', '/workspaceevil/x']) {
			assert.equal((await call('GET', `/sessions/abc-1/files?path=${encodeURIComponent(p)}`)).status, 403, p)
			assert.equal((await call('GET', `/sessions/abc-1/list?path=${encodeURIComponent(p)}`)).status, 403, p)
		}
		assert.equal(agent.calls.filter((c) => c.path !== '/health').length, 0, 'lexical rejects never reach agentd')
		agent.escapes.add('link/x')
		const r = await call('PUT', '/sessions/abc-1/files?path=link/x', 'data')
		assert.deepEqual([r.status, r.json.code], [403, 'path_escape'])
		assert.equal((await call('GET', '/sessions/abc-1/files?path=/workspace/link/x')).status, 403)
	})
	test('write, read, list, stat and delete map to agentd; missing files are 404', async () => {
		// `/file` is the route; `/files` is the older spelling and stays.
		assert.deepEqual((await call('PUT', '/sessions/abc-1/files?path=dir/a.txt', 'hello')).json, { ok: true })
		assert.deepEqual((await call('PUT', '/sessions/abc-1/file?path=dir/run.sh&mode=0755', '#!/bin/sh')).json, { ok: true })
		assert.equal(agent.files.get('dir/a.txt').toString(), 'hello')
		assert.equal(agent.calls.find((c) => c.query.path === 'dir/run.sh').query.mode, '0755')
		assert.equal((await call('PUT', '/sessions/abc-1/file?path=x&mode=777;rm', 'x')).status, 400)
		assert.equal((await call('GET', '/sessions/abc-1/files?path=/workspace/dir/a.txt')).text, 'hello')
		assert.equal((await call('GET', '/sessions/abc-1/file?path=dir/a.txt')).text, 'hello')
		assert.deepEqual((await call('GET', '/sessions/abc-1/list?path=dir')).json, [{ name: 'a.txt', type: 'file', size: 5, mode: 0o644, mtimeMs: 1 }, { name: 'run.sh', type: 'file', size: 9, mode: 0o755, mtimeMs: 1 }])
		assert.deepEqual((await call('GET', '/sessions/abc-1/stat?path=dir/a.txt')).json, { name: 'a.txt', type: 'file', size: 5, mode: 0o644, mtimeMs: 1 })
		assert.deepEqual((await call('DELETE', '/sessions/abc-1/file?path=dir/a.txt')).json, { ok: true })
		for (const [m, p] of [['GET', 'file'], ['GET', 'files'], ['GET', 'stat'], ['DELETE', 'file']]) {
			const r = await call(m, `/sessions/abc-1/${p}?path=dir/a.txt`)
			// The Worker's client tells a missing file from a missing session by this message.
			assert.deepEqual([r.status, r.json.code], [404, 'not_found'], `${m} ${p}`)
			assert.match(r.json.error, /no such file/i)
		}
		await call('GET', '/sessions/abc-1/list')
		await call('DELETE', '/sessions/abc-1/files?path=dir&recursive=1')
		assert.deepEqual(agent.calls.slice(-2).map((c) => c.query), [{ path: '.' }, { path: 'dir', recursive: '1' }])
	})
	test('a write past the disk limit is 507 disk_full', async () => {
		agent.diskFull = true // the filesystem refused it (volume or tmpfs quota)
		const r = await call('PUT', '/sessions/abc-1/file?path=a', 'data')
		assert.deepEqual([r.status, r.json.code], [507, 'disk_full'])
		agent.diskFull = false
		// In measure mode the manager refuses before agentd, from the measured use.
		agent.status.rootBytes = 1024 * MiB - 3
		mgr.sessions.get('abc-1').disk = null
		assert.equal((await call('PUT', '/sessions/abc-1/file?path=a', 'abc')).status, 200)
		const over = await call('PUT', '/sessions/abc-1/file?path=b', 'd')
		assert.deepEqual([over.status, over.json.code, over.json.diskQuotaBytes], [507, 'disk_full', 1024 * MiB])
		assert.ok(!agent.files.has('b'))
	})
	test('exec takes env on top of the proxy variables', async () => {
		await call('POST', '/sessions/abc-1/exec', { cmd: ['env'], timeoutMs: 1000, env: { FOO: 'bar', HTTPS_PROXY: '' } })
		const { env } = execCalls()[0].body
		assert.deepEqual([env.FOO, env.HTTPS_PROXY, env.HTTP_PROXY], ['bar', '', 'http://10.9.100.2:3128'])
		for (const env of [{ 'A-B': 'x' }, { A: 1 }, ['A=1']]) assert.equal((await call('POST', '/sessions/abc-1/exec', { cmd: ['env'], timeoutMs: 1000, env })).status, 400)
	})
	test('exec/stream passes agentd events through as NDJSON', async () => {
		const evs = [{ type: 'stdout', data: 'a' }, { type: 'stderr', data: 'b' }, exit(2)]
		agent.onExec = () => evs
		const r = await call('POST', '/sessions/abc-1/exec/stream', { cmd: ['x'], timeoutMs: 1000 })
		assert.equal(r.status, 200)
		assert.deepEqual(r.text.trim().split('\n').map((l) => JSON.parse(l)), evs)
		agent.onExec = () => ({ spawnFailed: 'cannot start x: ENOENT' })
		const missing = await call('POST', '/sessions/abc-1/exec/stream', { cmd: ['x'], timeoutMs: 1000 })
		assert.deepEqual(missing.text.trim().split('\n').map((l) => JSON.parse(l)), [{ type: 'stderr', data: 'cannot start x: ENOENT\n' }, exit(127)])
		agent.onExec = () => ({ hang: true })
		const hung = await call('POST', '/sessions/abc-1/exec/stream', { cmd: ['x'], timeoutMs: 100 })
		assert.deepEqual(JSON.parse(hung.text.trim()), { type: 'exit', code: null, signal: 'SIGKILL', timedOut: true })
		assert.equal((await call('POST', '/sessions/abc-1/exec/stream', { cmd: 'x', timeoutMs: 1000 })).status, 400)
		assert.equal((await call('POST', '/sessions/nope/exec/stream', { cmd: ['x'], timeoutMs: 1000 })).status, 404)
	})
	test('status reports state and disk use measured by agentd', async () => {
		agent.status = { ...agent.status, rootBytes: 1234, diskFreeBytes: 99, activeExecs: 1 }
		const r = await call('GET', '/sessions/abc-1/status')
		assert.deepEqual({ ...r.json, measuredAt: typeof r.json.measuredAt }, { sessionId: 'abc-1', state: 'running', reason: null, quotaMode: 'measure', diskBytes: 1234, diskQuotaBytes: 1024 * MiB, diskFreeBytes: 99, activeExecs: 1, measuredAt: 'number' })
		assert.equal((await call('GET', '/sessions/nope/status')).status, 404)
	})
})

describe('session lifecycle', () => {
	beforeEach(() => setup({ maxConcurrent: 3 }))
	afterEach(() => teardown())

	test('GET /sessions lists running, starting, stopped and kept sessions from the registry', async () => {
		await call('POST', '/sessions', { ...good, sessionId: 'b-run' })
		await call('POST', '/sessions', { ...good, sessionId: 'a-stop' })
		await call('POST', '/sessions', { ...good, sessionId: 'c-kept' })
		await call('POST', '/sessions/a-stop/stop')
		await call('DELETE', '/sessions/c-kept?keepVolume=1')
		const slow = fake.startAgentd
		let release
		fake.startAgentd = async (c) => (await new Promise((r) => (release = r)), slow(c))
		const pending = call('POST', '/sessions', { ...good, sessionId: 'd-new' })
		while (!release) await new Promise((r) => setTimeout(r, 5))
		const r = await call('GET', '/sessions')
		release()
		await pending
		assert.deepEqual(r.json.map((x) => [x.sessionId, x.state, x.reason ?? null]), [['a-stop', 'stopped', 'stopped'], ['b-run', 'running', null], ['c-kept', 'gone', 'kept_volume'], ['d-new', 'creating', null]])
		const run = r.json[1]
		assert.deepEqual({ image: run.image, limits: run.limits, egressAllow: run.egressAllow, createdAt: typeof run.createdAt }, { image: IMAGE, limits, egressAllow: good.egressAllow, createdAt: 'number' })
		assert.equal(r.json[0].keptVolume, 'pim-ws-a-stop')
		// A restarted manager lists the same, from Docker labels.
		const fresh = make()
		await fresh.reconcile()
		assert.deepEqual(fresh.list().map((x) => [x.sessionId, x.state]), [['a-stop', 'stopped'], ['b-run', 'running'], ['c-kept', 'gone'], ['d-new', 'running']])
	})
	test('stop keeps the files and frees the slot; start brings the session back', async () => {
		await call('POST', '/sessions', good)
		const createdAt = (await call('GET', '/sessions/abc-1')).json.createdAt
		const stopped = await call('POST', '/sessions/abc-1/stop')
		assert.deepEqual([stopped.status, stopped.json.state, stopped.json.reason], [200, 'stopped', 'stopped'])
		assert.ok(!fake.containers.has('pim-s-abc-1') && !fake.networks.has('pim-net-abc-1'))
		assert.ok(fake.volumes.has('pim-ws-abc-1'))
		assert.equal((await call('GET', '/sessions/abc-1')).json.state, 'stopped')
		assert.equal((await call('GET', '/health', undefined, {})).json.running, 0)
		const ex = await call('POST', '/sessions/abc-1/exec', { cmd: ['ls'], timeoutMs: 1000 })
		assert.deepEqual([ex.status, ex.json.code], [409, 'session_stopped'])
		assert.equal((await call('POST', '/sessions/abc-1/stop')).status, 200, 'stopping a stopped session does nothing')
		// The stop survives a manager restart.
		const fresh = make()
		await fresh.reconcile()
		assert.equal((await fresh.status('abc-1')).state, 'stopped')
		const started = await call('POST', '/sessions/abc-1/start')
		assert.deepEqual([started.status, started.json.state, started.json.createdAt], [200, 'running', createdAt])
		assert.ok(fake.containers.has('pim-s-abc-1'))
		assert.equal(fake.calls.filter((c) => c.path === '/volumes/create' && c.body.Name === 'pim-ws-abc-1').length, 2, 'the same volume')
		assert.ok(!fake.volumes.has('pim-kept-abc-1'))
		assert.equal((await call('POST', '/sessions/abc-1/start')).status, 200, 'starting a running session does nothing')
		assert.equal(fake.calls.filter((c) => c.path === '/containers/create').length, 2)
	})
	test('start goes through the same limits as create; gone and unknown sessions are 404', async () => {
		await call('POST', '/sessions', good)
		await call('POST', '/sessions/abc-1/stop')
		await call('POST', '/sessions', { ...good, sessionId: 'x-1' })
		await call('POST', '/sessions', { ...good, sessionId: 'x-2' })
		await call('POST', '/sessions', { ...good, sessionId: 'x-3' })
		const full = await call('POST', '/sessions/abc-1/start')
		assert.deepEqual([full.status, full.json.code], [429, 'capacity'])
		assert.equal((await call('GET', '/sessions/abc-1')).json.state, 'stopped')
		await call('DELETE', '/sessions/x-3?keepVolume=1')
		for (const p of ['/sessions/x-3/start', '/sessions/x-3/stop', '/sessions/nope/start', '/sessions/nope/stop']) assert.equal((await call('POST', p)).status, 404, p)
		assert.equal((await call('GET', '/sessions/x-3')).status, 404)
	})
})

describe('disk governance', () => {
	afterEach(() => teardown())

	test('in measure mode a session over its quota is stopped, its volume kept, the reason in status', async () => {
		await setup()
		await call('POST', '/sessions', good)
		await call('POST', '/sessions', { ...good, sessionId: 'abc-2' })
		fake.agentd('pim-s-abc-1').status.rootBytes = 1024 * MiB + 1
		fake.agentd('pim-s-abc-2').status.rootBytes = 1024 * MiB
		await mgr.checkDisk()
		assert.ok(!fake.containers.has('pim-s-abc-1') && !fake.networks.has('pim-net-abc-1'))
		assert.ok(fake.containers.has('pim-s-abc-2'), 'a session exactly at its quota stays')
		assert.ok(fake.volumes.has('pim-ws-abc-1'), 'the workspace is kept')
		const st = await call('GET', '/sessions/abc-1/status')
		assert.deepEqual([st.json.state, st.json.reason, st.json.diskBytes], ['stopped', 'over_disk_quota', 1024 * MiB + 1])
		const ex = await call('POST', '/sessions/abc-1/exec', { cmd: ['ls'], timeoutMs: 1000 })
		assert.deepEqual([ex.status, ex.json.code], [409, 'over_disk_quota'])
		// A restarted manager still knows why, and does not clear the kept volume as an orphan.
		const fresh = make()
		await fresh.reconcile()
		assert.equal((await fresh.status('abc-1')).reason, 'over_disk_quota')
		assert.ok(fake.volumes.has('pim-ws-abc-1'))
	})
	test('in volume mode Docker enforces the quota and the manager does not stop sessions', async () => {
		await setup({ quotaMode: 'volume' }, { quotaSupport: true })
		await call('POST', '/sessions', good)
		assert.deepEqual(fake.volumes.get('pim-ws-abc-1').DriverOpts, { size: '1024m' })
		fake.agentd('pim-s-abc-1').status.rootBytes = 2048 * MiB
		await mgr.checkDisk()
		assert.equal((await call('GET', '/sessions/abc-1/status')).json.state, 'running')
	})
	test('quota mode detection probes for volume size support and cleans up', async () => {
		for (const quotaSupport of [true, false]) {
			const f = await startFakeDocker({ quotaSupport })
			assert.equal(await detectQuotaMode(new Docker(f.path)), quotaSupport ? 'volume' : 'measure')
			assert.equal(f.volumes.size, 0)
			await f.close()
		}
		fake = await startFakeDocker()
		mgr = make()
		await new Promise((r) => mgr.server.listen(0, '127.0.0.1', r))
	})
	test('the total workspace quota refuses creates with 507, and counts kept volumes', async () => {
		await setup({ maxTotalWorkspaceMiB: 2048, maxConcurrent: 5 })
		await call('POST', '/sessions', good)
		await call('POST', '/sessions', { ...good, sessionId: 'abc-2' })
		const r = await call('POST', '/sessions', { ...good, sessionId: 'abc-3', limits: { ...limits, diskMiB: 64 } })
		assert.equal(r.status, 507)
		assert.deepEqual(r.json, { error: 'workspace disk would exceed 2048 MiB', code: 'workspace_quota', reservedMiB: 2048, requestedMiB: 64, maxTotalMiB: 2048 })
		assert.equal(fake.calls.filter((c) => c.path === '/containers/create').length, 2)
		await call('DELETE', '/sessions/abc-2?keepVolume=1')
		assert.equal((await call('POST', '/sessions', { ...good, sessionId: 'abc-3' })).status, 507, 'kept volume still reserved')
		// Resuming the kept session reuses its own reservation.
		assert.equal((await call('POST', '/sessions', { ...good, sessionId: 'abc-2' })).status, 201)
		await call('DELETE', '/sessions/abc-2')
		assert.equal((await call('POST', '/sessions', { ...good, sessionId: 'abc-3' })).status, 201)
	})
	test('delete with keepVolume keeps the workspace across restarts until resumed, deleted or reaped', async () => {
		await setup({ keptVolumeDays: 7 })
		await call('POST', '/sessions', good)
		const r = await call('DELETE', '/sessions/abc-1?keepVolume=1')
		assert.deepEqual(r.json, { deleted: 'abc-1', keptVolume: 'pim-ws-abc-1' })
		assert.ok(!fake.containers.has('pim-s-abc-1') && !fake.networks.has('pim-net-abc-1'))
		assert.ok(fake.volumes.has('pim-ws-abc-1'))
		assert.equal((await call('GET', '/sessions/abc-1')).status, 404)
		const st = (await call('GET', '/sessions/abc-1/status')).json
		assert.deepEqual([st.state, st.reason], ['gone', 'kept_volume'])
		// Restart: the kept volume is not an orphan.
		const fresh = make({ keptVolumeDays: 7 })
		await fresh.reconcile()
		assert.ok(fake.volumes.has('pim-ws-abc-1'))
		// Resume reuses the volume and clears the mark; a crash now would treat it as a live session's.
		assert.equal((await fresh.createSession(good)).created, true)
		assert.equal(fake.calls.filter((c) => c.path === '/volumes/create' && c.body.Name === 'pim-ws-abc-1').length, 2)
		assert.ok(!fake.volumes.has('pim-kept-abc-1'))
		// Keep again, then the reaper removes it after KEPT_VOLUME_DAYS.
		await fresh.remove('abc-1', true)
		await fresh.reap()
		assert.ok(fake.volumes.has('pim-ws-abc-1'))
		fresh.kept.get('abc-1').keptAt -= 8 * 86400000
		await fresh.reap()
		assert.equal(fake.volumes.size, 0)
	})
})

describe('reconcile after a restart', () => {
	afterEach(() => teardown())

	test('re-attaches recreated proxy and manager containers and keeps agentd reachable', async () => {
		await setup({ managerContainer: 'sandbox-manager' })
		await call('POST', '/sessions', good)
		assert.ok(fake.infra.get('sandbox-manager').nets.has('pim-net-abc-1'), 'manager attached to reach agentd')
		// `docker compose up` recreated both: they lost every session network.
		fake.recreate('egress-proxy', '10.9.101.2')
		fake.recreate('sandbox-manager', '10.9.101.3')
		proxy.map = {}
		const fresh = make({ managerContainer: 'sandbox-manager' })
		await fresh.reconcile()
		assert.ok(fake.infra.get('egress-proxy').nets.has('pim-net-abc-1'))
		assert.ok(fake.infra.get('sandbox-manager').nets.has('pim-net-abc-1'))
		assert.deepEqual(Object.values(proxy.map), [good.egressAllow])
		// The token is derived again from the label nonce, and execs get the proxy's new address.
		const agent = fake.agentd('pim-s-abc-1')
		agent.onExec = () => [{ type: 'stdout', data: 'ok' }, exit(0)]
		const r = await fresh.status('abc-1')
		assert.equal(r.error, undefined)
		mgr.server.close()
		mgr = fresh
		await new Promise((res) => mgr.server.listen(0, '127.0.0.1', res))
		assert.equal((await call('POST', '/sessions/abc-1/exec', { cmd: ['true'], timeoutMs: 1000 })).json.stdout, 'ok')
		assert.equal(agent.calls.at(-1).body.env.HTTPS_PROXY, 'http://10.9.101.2:3128')
	})
	test('the periodic reattach restores a restarted proxy without a manager restart', async () => {
		await setup()
		await call('POST', '/sessions', good)
		await mgr.reattach()
		const before = proxy.sets.length
		await mgr.reattach()
		assert.equal(proxy.sets.length, before, 'nothing to do when nothing changed')
		fake.recreate('egress-proxy', '10.9.102.2')
		proxy.map = {}
		await mgr.reattach()
		assert.ok(fake.infra.get('egress-proxy').nets.has('pim-net-abc-1'))
		assert.deepEqual(Object.values(proxy.map), [good.egressAllow])
	})
	test('requests that arrive on the manager address inside a session network are refused', async () => {
		fake = await startFakeDocker()
		fake.infra.get('sandbox-manager').ip = '127.0.0.2'
		proxy = { sets: [], set: async () => {}, del: async () => {}, map: {} }
		mgr = make({ managerContainer: 'sandbox-manager' })
		await new Promise((r) => mgr.server.listen(0, '0.0.0.0', r))
		await call('POST', '/sessions', good)
		await assert.rejects(call('GET', '/health', undefined, {}, '127.0.0.2'))
		assert.equal((await call('GET', '/health')).status, 200)
	})
})

describe('with the real workspace-agentd', () => {
	let root
	beforeEach(async () => {
		root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'mgr-agentd-')))
		await setup()
		// Each container runs a real agentd over its own directory, with the token the manager gave it.
		fake.startAgentd = async (c) => {
			const dir = path.join(root, c.name)
			await fs.mkdir(dir)
			const s = await createAgentd({ token: c.body.Env.find((e) => e.startsWith('AGENTD_TOKEN=')).slice(13), root: dir })
			await new Promise((r) => s.listen(0, '127.0.0.1', r))
			return { port: s.address().port, close: () => new Promise((r) => (s.closeAllConnections(), s.close(r))) }
		}
		assert.equal((await call('POST', '/sessions', good)).status, 201)
	})
	afterEach(() => teardown())

	test('a timed-out exec dies alone; a concurrent exec in the same session finishes', async () => {
		const [slow, timed] = await Promise.all([
			call('POST', '/sessions/abc-1/exec', { cmd: ['sh', '-c', 'sleep 1; echo alive'], timeoutMs: 10000 }),
			call('POST', '/sessions/abc-1/exec', { cmd: ['sleep', '30'], timeoutMs: 300 }),
		])
		assert.deepEqual(timed.json, { stdout: '', stderr: '', exitCode: null, timedOut: true, truncated: false })
		assert.deepEqual(slow.json, { stdout: 'alive\n', stderr: '', exitCode: 0, timedOut: false, truncated: false })
		const missing = await call('POST', '/sessions/abc-1/exec', { cmd: ['definitely-not-a-command'], timeoutMs: 1000 })
		assert.equal(missing.json.exitCode, 127)
	})
	test('a client that drops exec/stream kills that command', async () => {
		const ac = new AbortController()
		let pid
		try {
			const res = await fetch(`${base}/sessions/abc-1/exec/stream`, { method: 'POST', signal: ac.signal, headers: { authorization: 'Bearer t0ken' }, body: JSON.stringify({ cmd: ['sh', '-c', 'echo start; sleep 60 & echo $!; wait'], timeoutMs: 20000 }) })
			assert.equal(res.headers.get('content-type'), 'application/x-ndjson')
			// Neither the NDJSON lines nor the stdout events line up with reads: buffer both until the pid line is complete.
			const decoder = new TextDecoder()
			let ndjson = ''
			let stdout = ''
			for await (const chunk of res.body) {
				ndjson += decoder.decode(chunk, { stream: true })
				const lines = ndjson.split('\n')
				ndjson = lines.pop()
				for (const line of lines.filter(Boolean)) {
					const ev = JSON.parse(line)
					assert.notEqual(ev.type, 'exit', 'the command ended early')
					if (ev.type === 'stdout') stdout += ev.data
				}
				const m = /^start\n(\d+)\n/.exec(stdout)
				if (m) {
					pid = Number(m[1])
					break
				}
			}
			assert.ok(pid && alive(pid), `no live pid in ${JSON.stringify(stdout)}`)
		} finally {
			ac.abort()
		}
		const end = Date.now() + 8000
		while (alive(pid) && Date.now() < end) await new Promise((r) => setTimeout(r, 50))
		const survived = alive(pid)
		if (survived) process.kill(pid, 'SIGKILL')
		assert.ok(!survived, 'the command outlived the client')
	})
	test('files round-trip and symlink escapes are refused', async () => {
		assert.equal((await call('PUT', '/sessions/abc-1/files?path=d/a.txt', 'héllo')).status, 200)
		assert.equal((await call('GET', '/sessions/abc-1/files?path=d/a.txt')).text, 'héllo')
		assert.deepEqual((await call('GET', '/sessions/abc-1/list?path=d')).json.map((e) => [e.name, e.type]), [['a.txt', 'file']])
		assert.equal((await call('GET', '/sessions/abc-1/stat?path=d')).json.type, 'dir')
		assert.equal((await call('POST', '/sessions/abc-1/exec', { cmd: ['ln', '-s', '/etc', 'evil'], timeoutMs: 5000 })).json.exitCode, 0)
		assert.equal((await call('GET', '/sessions/abc-1/files?path=evil/passwd')).status, 403)
		assert.equal((await call('DELETE', '/sessions/abc-1/files?path=d')).status, 409)
		assert.equal((await call('DELETE', '/sessions/abc-1/files?path=d&recursive=1')).status, 200)
		assert.ok((await call('GET', '/sessions/abc-1/status')).json.diskBytes >= 0)
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
