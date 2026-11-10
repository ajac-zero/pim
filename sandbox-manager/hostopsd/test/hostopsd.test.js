import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { afterEach, describe, test } from 'node:test'
import { fileURLToPath } from 'node:url'
import { createDaemon, loadConfig } from '../hostopsd.js'
import { redact } from '../ops.js'
import { HOSTOPS_TOKEN, MANAGER_TOKEN, setup } from '../support/harness.js'

const ENTRY = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'hostopsd.js')
let h
let nextId = 0
afterEach(() => h?.close())

async function start(opts, envOver = {}) {
	h = await setup(opts)
	return daemon(envOver)
}
async function daemon(envOver = {}) {
	const logs = []
	const d = createDaemon(loadConfig({ ...h.env, ...envOver }), { log: (m) => logs.push(m) })
	await d.start()
	d.logs = logs
	return d
}
// Queues one op at the fake Pim, lets the daemon poll and run it, then deliver the result.
async function op(d, name, args) {
	const id = `op-${++nextId}`
	h.pim.ops.push({ id, name, args, deadlineMs: Date.now() + 600000 })
	await d.step()
	const s = await d.step()
	assert.equal(s.waitMs, 0)
	const r = h.pim.results.at(-1)
	assert.equal(r.id, id)
	return r
}
const ran = (tool, pred = () => true) => h.calls().filter((c) => c.tool === tool && pred(c.args))
const upCalls = () => ran('up').map((c) => c.buildSha)

describe('deploy', () => {
	test('fast-forwards to origin/main, rebuilds and checks health', async () => {
		const d = await start()
		const r = await op(d, 'deploy', {})
		assert.equal(r.state, 'succeeded', r.summary)
		assert.equal(r.ok, true)
		assert.equal(h.head(), h.repo.c3)
		assert.deepEqual({ previous: r.data.previous, target: r.data.target }, { previous: h.repo.c2, target: h.repo.c3 })
		assert.match(r.summary, new RegExp(`Deployed ${h.repo.c3.slice(0, 12)} \\(was ${h.repo.c2.slice(0, 12)}\\)`))
		assert.deepEqual(upCalls(), [h.short(h.repo.c3)])
		assert.ok(ran('git', (a) => a.includes('fetch')).length === 1)
		// up.sh runs in sandbox-manager/ with the manager's environment, not hostopsd's credential.
		const up = ran('up')[0]
		assert.equal(up.cwd, path.join(h.repo.checkout, 'sandbox-manager'))
		assert.equal(up.managerToken, MANAGER_TOKEN)
		assert.ok(up.env.includes('PROXY_ADMIN_TOKEN'))
		assert.ok(!up.env.includes('HOSTOPS_TOKEN'))
		assert.equal(d.state.deploy, null)
		assert.deepEqual(d.state.deploys.map((x) => x.commit), [h.repo.c3])
		assert.deepEqual((await d.step()).exit, undefined) // no restart: hostopsd/ did not change
		// The state file has it too.
		const saved = JSON.parse(readFileSync(h.env.HOSTOPSD_STATE_FILE, 'utf8'))
		assert.equal(saved.deploy, null)
		assert.equal(saved.deploys[0].commit, h.repo.c3)
	})

	test('restarts itself after reporting when its own code changed', async () => {
		const d = await start()
		const r = await op(d, 'deploy', { ref: 'origin/selfupdate' })
		assert.equal(r.state, 'succeeded', r.summary)
		assert.deepEqual(await d.step(), { exit: true })
	})

	test('rolls back when the manager does not become healthy', async () => {
		const d = await start()
		h.mgr.unhealthy = [h.repo.c3]
		const r = await op(d, 'deploy', {})
		assert.equal(r.state, 'rolled_back', r.summary)
		assert.equal(r.ok, false)
		assert.match(r.summary, /failed at health: the manager was not healthy at \w+ within 1 s: \/health is not ok/)
		assert.match(r.summary, /Rolled back to \w+, which is healthy/)
		assert.equal(h.head(), h.repo.c2)
		assert.equal(h.deployed(), h.short(h.repo.c2))
		assert.deepEqual(upCalls(), [h.short(h.repo.c3), h.short(h.repo.c2)])
		assert.equal(d.state.deploy, null)
		assert.deepEqual(d.state.deploys, [])
	})

	test('rolls back when up.sh fails', async () => {
		const d = await start({ fake: { upFail: [] } })
		h.setFake({ upFail: [h.repo.c3] })
		const r = await op(d, 'deploy', {})
		assert.equal(r.state, 'rolled_back', r.summary)
		assert.match(r.summary, /failed at up\.sh: up\.sh exited with 1: compose build failed/)
		assert.equal(h.head(), h.repo.c2)
	})

	test('reports failed when the rollback fails too', async () => {
		const d = await start()
		h.setFake({ upFail: [h.repo.c3] })
		h.mgr.unhealthy = [h.repo.c2]
		const r = await op(d, 'deploy', {})
		assert.equal(r.state, 'failed')
		assert.match(r.summary, /The rollback to \w+ also failed at health: .* needs attention/)
		assert.deepEqual(upCalls(), [h.short(h.repo.c3), h.short(h.repo.c2)])
		assert.equal(d.state.deploy, null)
	})

	test('refuses a ref that is not a fast-forward, but takes it by commit hash', async () => {
		const d = await start()
		const r = await op(d, 'deploy', { ref: 'origin/side' })
		assert.equal(r.state, 'failed')
		assert.match(r.summary, /not a fast-forward of the current commit/)
		assert.equal(h.head(), h.repo.c2)
		assert.deepEqual(upCalls(), [])
		const byHash = await op(d, 'deploy', { ref: h.repo.s1.slice(0, 10) })
		assert.equal(byHash.state, 'succeeded', byHash.summary)
		assert.equal(h.head(), h.repo.s1)
	})

	test('a branch named like a hash still has to fast-forward', async () => {
		const d = await start()
		// A ref that looks like a hash but resolves to something else is not an explicit commit.
		const name = 'deadbeef00'
		const { execFileSync } = await import('node:child_process')
		execFileSync('git', ['update-ref', `refs/heads/${name}`, h.repo.s1], { cwd: h.repo.checkout })
		const r = await op(d, 'deploy', { ref: name })
		assert.equal(r.state, 'failed')
		assert.match(r.summary, /not a fast-forward/)
	})

	test('fails cleanly for an unknown ref', async () => {
		const d = await start()
		const r = await op(d, 'deploy', { ref: 'origin/nope' })
		assert.equal(r.state, 'failed')
		assert.match(r.summary, /origin\/nope does not name a commit/)
		assert.deepEqual(upCalls(), [])
	})
})

describe('rollback', () => {
	test('goes to an ancestor of HEAD', async () => {
		const d = await start()
		const r = await op(d, 'rollback', { commit: h.repo.c1.slice(0, 8) })
		assert.equal(r.state, 'succeeded', r.summary)
		assert.equal(h.head(), h.repo.c1)
		assert.equal(h.deployed(), h.short(h.repo.c1))
	})

	test('refuses a commit that is neither an ancestor nor deployed, and one that is not there', async () => {
		const d = await start()
		const r = await op(d, 'rollback', { commit: h.repo.s1 })
		assert.equal(r.state, 'failed')
		assert.match(r.summary, /neither an ancestor/)
		const missing = await op(d, 'rollback', { commit: '0123456789abcdef' })
		assert.match(missing.summary, /is not a commit in the checkout/)
		assert.deepEqual(upCalls(), [])
		assert.equal(h.head(), h.repo.c2)
	})

	test('takes a commit recorded by an earlier deploy', async () => {
		const d = await start()
		assert.equal((await op(d, 'deploy', { ref: h.repo.s1 })).state, 'succeeded')
		// c2 is not an ancestor of s1, but it is the commit that deploy replaced.
		const r = await op(d, 'rollback', { commit: h.repo.c2 })
		assert.equal(r.state, 'succeeded', r.summary)
		assert.equal(h.head(), h.repo.c2)
	})

	test('does not roll back again when it fails', async () => {
		const d = await start()
		h.mgr.unhealthy = [h.repo.c1]
		const r = await op(d, 'rollback', { commit: h.repo.c1 })
		assert.equal(r.state, 'failed')
		assert.match(r.summary, /nothing more was tried/)
		assert.deepEqual(upCalls(), [h.short(h.repo.c1)])
		assert.equal(h.head(), h.repo.c1)
	})
})

describe('crash recovery', () => {
	const interrupted = (status, extra = {}) => {
		mkdirSync(path.dirname(h.env.HOSTOPSD_STATE_FILE), { recursive: true })
		writeFileSync(h.env.HOSTOPSD_STATE_FILE, JSON.stringify({ deploy: { kind: 'deploy', opId: 'op-crash', previous: h.repo.c2, target: h.repo.c3, status, pid: 999999, bootId: 'old', startedAt: new Date().toISOString(), ...extra }, deploys: [], pendingResults: [] }))
	}

	test('rolls back a deploy that was running and is unhealthy, then reports it', async () => {
		h = await setup()
		// It died after checking out c3, before up.sh finished: the manager still runs c2.
		const { execFileSync } = await import('node:child_process')
		execFileSync('git', ['checkout', '--quiet', '--detach', h.repo.c3], { cwd: h.repo.checkout })
		interrupted('running')
		const d = await daemon()
		assert.equal(d.state.deploy, null)
		assert.equal(h.head(), h.repo.c2)
		assert.deepEqual(upCalls(), [h.short(h.repo.c2)])
		await d.step()
		const r = h.pim.results.at(-1)
		assert.equal(r.id, 'op-crash')
		assert.equal(r.state, 'rolled_back')
		assert.match(r.summary, /hostopsd restarted during the deploy/)
	})

	test('reports success for a deploy that had finished', async () => {
		h = await setup()
		const { execFileSync } = await import('node:child_process')
		execFileSync('git', ['checkout', '--quiet', '--detach', h.repo.c3], { cwd: h.repo.checkout })
		writeFileSync(path.join(h.tmp, 'fake', 'deployed'), h.short(h.repo.c3))
		interrupted('running')
		const d = await daemon()
		await d.step()
		const r = h.pim.results.at(-1)
		assert.equal(r.state, 'succeeded', r.summary)
		assert.deepEqual(upCalls(), [])
		assert.equal(d.state.deploys[0].commit, h.repo.c3)
	})

	test('reports a deploy that died before the checkout changed without rebuilding', async () => {
		h = await setup()
		interrupted('running')
		const d = await daemon()
		await d.step()
		const r = h.pim.results.at(-1)
		assert.equal(r.state, 'rolled_back')
		assert.match(r.summary, /still at \w+, which is healthy/)
		assert.deepEqual(upCalls(), [])
	})

	test('does not touch a deploy another live process holds', async () => {
		h = await setup()
		const sleeper = spawn('sleep', ['30'])
		try {
			const bootId = readFileSync('/proc/sys/kernel/random/boot_id', 'utf8').trim()
			interrupted('running', { pid: sleeper.pid, bootId })
			const d = await daemon()
			assert.equal(d.state.deploy.pid, sleeper.pid)
			// That is the deploy lock: another deploy is refused without running anything.
			const r = await op(d, 'deploy', {})
			assert.equal(r.state, 'failed')
			assert.match(r.summary, new RegExp(`Not deploying: deploy op-crash of \\w+ is running in process ${sleeper.pid}`))
			assert.deepEqual(ran('git', (a) => a.includes('fetch')), [])
			assert.match((await op(d, 'rollback', { commit: h.repo.c1 })).summary, /Not rolling back/)
		} finally {
			sleeper.kill()
		}
	})
})

describe('one op at a time', () => {
	test('a second op while one runs is refused', async () => {
		h = await setup()
		const { createOps } = await import('../ops.js')
		const cfg = loadConfig(h.env)
		const state = { deploy: null, deploys: [], pendingResults: [] }
		const ops = createOps(cfg, { state, save: async () => {} })
		const [a, b] = await Promise.all([ops.run({ id: 'a', name: 'deploy', args: { ref: 'origin/main' } }), ops.run({ id: 'b', name: 'stats', args: {} })])
		assert.equal(a.result.state, 'succeeded')
		assert.equal(b.result.state, 'failed')
		assert.match(b.result.summary, /Another operation is running/)
	})
})

describe('restart, logs, slots, stats', () => {
	test('restart runs docker compose restart for the service', async () => {
		const d = await start()
		const r = await op(d, 'restart', { service: 'egress-proxy' })
		assert.equal(r.state, 'succeeded')
		const c = ran('docker')
		assert.deepEqual(c.map((x) => x.args), [['compose', 'restart', 'egress-proxy']])
		assert.equal(c[0].cwd, path.join(h.repo.checkout, 'sandbox-manager'))
		assert.equal(c[0].buildSha, h.short(h.repo.c2))
		h.setFake({ restartFail: true })
		const f = await op(d, 'restart', { service: 'sandbox-manager' })
		assert.equal(f.state, 'failed')
		assert.match(f.summary, /docker compose restart sandbox-manager exited with 1: no such service/)
	})

	test('restart hostopsd exits after the result is delivered', async () => {
		const d = await start()
		h.pim.resultFailures = 1
		h.pim.ops.push({ id: 'r1', name: 'restart', args: { service: 'hostopsd' } })
		await d.step() // runs it
		assert.ok((await d.step()).waitMs > 0) // delivery fails once
		assert.equal((await d.step()).waitMs, 0) // delivered
		assert.equal(h.pim.results[0].state, 'succeeded')
		assert.deepEqual(await d.step(), { exit: true })
		assert.deepEqual(ran('docker'), [])
	})

	test('logs are redacted and capped', async () => {
		const secretB64 = 'eyJhbGciOiJIUzI1NiJ9AbCdEfGh1234567890xyzQ'
		const logsText = [
			'sandbox-manager-docker-socket-proxy-1  | started /home/azureuser/pim/sandbox-manager/src/main.js',
			'sandbox-manager  | authorization: Bearer abc.def-123',
			`sandbox-manager  | token ${'0123456789abcdef'.repeat(3)} and ${secretB64}==`,
			`sandbox-manager  | MANAGER_TOKEN=${MANAGER_TOKEN} proxy proxy-admin-secret-value`,
			'x'.repeat(70 * 1024),
			'last line',
		].join('\n')
		const d = await start({ fake: { logsText } })
		const r = await op(d, 'logs', { service: 'sandbox-manager', lines: 50 })
		assert.equal(r.state, 'succeeded', r.summary)
		assert.deepEqual(ran('docker').map((c) => c.args), [['compose', 'logs', '--no-color', '--tail', '50', 'sandbox-manager']])
		assert.equal(r.data.truncated, true)
		assert.ok(Buffer.byteLength(JSON.stringify(r)) < 64 * 1024 + 4096)
		assert.match(r.data.text, /last line/)
		// Without the cap, check every redaction on the same text.
		const short = redact(logsText.split('\n').slice(0, 4).join('\n'), [MANAGER_TOKEN, 'proxy-admin-secret-value'])
		assert.match(short, /sandbox-manager-docker-socket-proxy-1 {2}\| started \/home\/azureuser\/pim\/sandbox-manager\/src\/main\.js/)
		assert.match(short, /Bearer \[redacted\]/)
		for (const secret of ['abc.def-123', '0123456789abcdef0123', secretB64, MANAGER_TOKEN, 'proxy-admin-secret-value']) assert.ok(!short.includes(secret), secret)
		const j = await op(d, 'logs', { service: 'hostopsd', lines: 3 })
		assert.equal(j.state, 'succeeded')
		assert.deepEqual(ran('journalctl').map((c) => c.args), [['--unit', 'hostopsd', '--lines', '3', '--no-pager', '--output', 'short-iso']])
	})

	test('set_slot_limit sets maxConcurrent and confirms it', async () => {
		const d = await start()
		const r = await op(d, 'set_slot_limit', { maxConcurrent: 3 })
		assert.equal(r.state, 'succeeded', r.summary)
		assert.equal(h.mgr.maxConcurrent, 3)
		assert.deepEqual(r.data.config, { maxConcurrent: 3, source: 'override' })
		h.mgr.ignoreConfig = true
		assert.match((await op(d, 'set_slot_limit', { maxConcurrent: 5 })).summary, /accepted maxConcurrent 5 but \/health reports 3/)
		h.mgr.noConfig = true
		assert.match((await op(d, 'set_slot_limit', { maxConcurrent: 5 })).summary, /no PUT \/config yet/)
	})

	test('stats reports the host, docker and the manager', async () => {
		const d = await start()
		h.mgr.running = 1
		const r = await op(d, 'stats', {})
		assert.equal(r.state, 'succeeded', r.summary)
		assert.equal(r.data.errors, undefined)
		assert.equal(r.data.commit, h.repo.c2)
		assert.equal(r.data.manager.commit, h.short(h.repo.c2))
		assert.equal(r.data.disk.root.path, '/')
		assert.equal(r.data.disk.dockerRoot.path, '/')
		assert.ok(r.data.memory.totalBytes > 0)
		assert.equal(r.data.containers.length, 3)
		assert.equal(r.data.dockerDf[0].type, 'Images')
		assert.match(r.summary, /2 containers running; manager \w+ with 1 of 4 slots in use/)
	})
})

describe('deploying while sessions run', () => {
	test('waits for the manager to be idle, then deploys, logging both', async () => {
		const d = await start({ manager: { running: 2 } })
		const t = setInterval(() => d.logs.some((l) => /deferring/.test(l)) && ((h.mgr.running = 0), clearInterval(t)), 20)
		const r = await op(d, 'deploy', {})
		assert.equal(r.state, 'succeeded', r.summary)
		assert.match(r.summary, /^Waited for the manager to be idle\. Deployed/)
		assert.ok(d.logs.some((l) => /deploy: deferring, the manager runs 2 sessions/.test(l)))
		assert.ok(d.logs.some((l) => /deploy: the manager is idle, proceeding/.test(l)))
		assert.deepEqual(upCalls(), [h.short(h.repo.c3)])
	})

	test('goes ahead after the timeout when sessions are still running, and says so', async () => {
		const d = await start({ manager: { running: 1 } })
		const started = Date.now()
		const r = await op(d, 'deploy', {})
		assert.ok(Date.now() - started >= 500)
		assert.equal(r.state, 'succeeded', r.summary)
		assert.match(r.summary, /Went ahead with 1 sessions still running after waiting 1 s/)
		assert.ok(d.logs.some((l) => /proceeding anyway/.test(l)))
	})

	test('does not wait when it is idle, for a rollback, or for a restart of another service', async () => {
		const d = await start({ manager: { running: 1 } })
		await op(d, 'restart', { service: 'egress-proxy' })
		assert.equal((await op(d, 'rollback', { commit: h.repo.c1 })).state, 'succeeded')
		assert.equal(d.logs.filter((l) => /deferring/.test(l)).length, 0)
	})

	test('waits before restarting the manager itself', async () => {
		const d = await start({ manager: { running: 1 } })
		const t = setInterval(() => d.logs.some((l) => /deferring/.test(l)) && ((h.mgr.running = 0), clearInterval(t)), 20)
		const r = await op(d, 'restart', { service: 'sandbox-manager' })
		assert.match(r.summary, /^Waited for the manager to be idle\. Restarted sandbox-manager/)
	})
})

describe('talking to Pim', () => {
	test('polls with its version and commit, and retries a result until Pim accepts it', async () => {
		const d = await start({ pim: { resultFailures: 3 } })
		h.pim.ops.push({ id: 's1', name: 'stats', args: {} })
		await d.step()
		assert.deepEqual(Object.keys(h.pim.polls[0].body).sort(), ['agentVersion', 'commit', 'waitMs'])
		assert.equal(h.pim.polls[0].body.commit, h.repo.c2)
		assert.equal(h.pim.polls[0].body.waitMs, 25000)
		assert.ok(h.pim.polls[0].authed)
		for (let i = 0; i < 3; i++) assert.ok((await d.step()).waitMs > 0)
		// A daemon that crashes now still has the result in its state file.
		const saved = JSON.parse(readFileSync(h.env.HOSTOPSD_STATE_FILE, 'utf8'))
		assert.deepEqual(saved.pendingResults.map((r) => r.id), ['s1'])
		const again = await daemon()
		assert.equal((await again.step()).waitMs, 0)
		assert.deepEqual(h.pim.results.map((r) => r.id), ['s1'])
		assert.equal(h.pim.resultAttempts, 4)
		assert.deepEqual(again.state.pendingResults, [])
		assert.equal(h.pim.polls.length, 1) // no new op is taken while a result is pending
	})

	test('a 401 is logged clearly and retried slowly', async () => {
		const d = await start({ pim: { pollStatus: 401 } })
		const s = await d.step()
		assert.ok(s.waitMs >= 30000 && s.waitMs <= 60000, String(s.waitMs))
		assert.match(d.logs.join('\n'), /rejected HOSTOPS_TOKEN \(401\); the credential may have been revoked/)
		assert.ok(!d.logs.join('\n').includes(HOSTOPS_TOKEN))
		h.pim.pollStatus = 503
		const e = await d.step()
		assert.ok(e.waitMs <= 40)
	})

	test('refuses unknown ops and injection attempts without running anything', async () => {
		const d = await start()
		const m = path.join(h.tmp, 'pwned')
		const attempts = [
			['reboot', {}],
			['deploy', { ref: `origin/main;touch ${m}` }],
			['deploy', { ref: `$(touch ${m})` }],
			['deploy', { ref: `\`touch ${m}\`` }],
			['deploy', { ref: '--upload-pack=touch' }],
			['rollback', { commit: `abc1234; touch ${m}` }],
			['rollback', { commit: `abc1234$(touch ${m})` }],
			['restart', { service: `sandbox-manager && touch ${m}` }],
			['logs', { service: 'hostopsd', lines: `5; touch ${m}` }],
			['logs', { service: `hostopsd;touch ${m}`, lines: 5 }],
			['set_slot_limit', { maxConcurrent: `2; touch ${m}` }],
			['stats', { cmd: `touch ${m}` }],
		]
		for (const [name, args] of attempts) {
			const r = await op(d, name, args)
			assert.equal(r.state, 'failed', `${name} ${JSON.stringify(args)}`)
			assert.match(r.summary, /^Refused: .*Nothing ran\.$/)
		}
		// The only command run was reading HEAD for each poll.
		assert.deepEqual([...new Set(h.calls().map((c) => `${c.tool} ${c.args.join(' ')}`))], [`git -c safe.directory=${h.repo.checkout} rev-parse HEAD`])
		assert.equal(existsSync(m), false)
	})

	test('an op past its deadline does not run', async () => {
		const d = await start()
		h.pim.ops.push({ id: 'late', name: 'deploy', args: {}, deadlineMs: Date.now() - 1000 })
		await d.step()
		await d.step()
		assert.match(h.pim.results[0].summary, /deadline/)
		assert.deepEqual(ran('git', (a) => a.includes('fetch')), [])
	})
})

describe('exec', () => {
	const exec = (d, command, extra = {}) => op(d, 'exec', { command, ...extra })
	const alive = (pid) => {
		try {
			process.kill(pid, 0)
			return true
		} catch {
			return false
		}
	}

	test('runs one command in a non-interactive shell with stdout and stderr together, as the daemon user', async () => {
		const d = await start()
		const r = await exec(d, 'echo out; echo err >&2; test -t 0 || echo no-tty; cat; id -u; echo "$HOME"; exit 0')
		assert.equal(r.state, 'succeeded', r.summary)
		assert.equal(r.ok, true)
		assert.equal(r.data.exitCode, 0)
		assert.equal(r.data.timedOut, false)
		assert.equal(r.data.truncated, false)
		assert.equal(typeof r.data.durationMs, 'number')
		// No stdin (cat saw end of file), no terminal, and the daemon's own user: no sudo, no root.
		assert.equal(r.data.output, `out\nerr\nno-tty\n${process.getuid()}\n${h.tmp}\n`)
		assert.match(r.summary, /^Exited with 0 in [\d.]+ s\.$/)
	})

	test('reports a failing command as failed, with its exit code and output', async () => {
		const d = await start()
		const r = await exec(d, 'echo partial; echo boom >&2; exit 7')
		assert.equal(r.state, 'failed')
		assert.equal(r.ok, false)
		assert.equal(r.data.exitCode, 7)
		assert.equal(r.data.output, 'partial\nboom\n')
		assert.match(r.summary, /^Exited with 7 in /)
		const nf = await exec(d, 'no-such-command-here')
		assert.equal(nf.data.exitCode, 127)
	})

	test('runs with a minimal environment: no credential of hostopsd or the manager', async () => {
		const d = await start()
		const r = await exec(d, 'env | sort')
		const names = r.data.output.split('\n').map((l) => l.split('=')[0])
		for (const name of ['HOSTOPS_TOKEN', 'MANAGER_TOKEN', 'PROXY_ADMIN_TOKEN', 'HOSTOPS_URL', 'PIM_CHECKOUT']) assert.ok(!names.includes(name), name)
		assert.ok(names.includes('PATH'))
	})

	test('kills the whole process group at the timeout', async () => {
		const d = await start()
		const pidFile = path.join(h.tmp, 'child.pid')
		const started = Date.now()
		const r = await exec(d, `sleep 60 & echo $! > ${pidFile}; echo started; wait`, { timeoutSeconds: 1 })
		assert.ok(Date.now() - started < 10000)
		assert.equal(r.state, 'failed')
		assert.equal(r.data.timedOut, true)
		assert.equal(r.data.output, 'started\n')
		assert.match(r.summary, /^Timed out after 1 s and was killed with its process group\.$/)
		const child = Number(readFileSync(pidFile, 'utf8'))
		await new Promise((resolve) => setTimeout(resolve, 200))
		assert.equal(alive(child), false, 'the background child of the shell is gone')
	})

	test('does not wait for what a finished command left running in the background', async () => {
		const d = await start()
		const pidFile = path.join(h.tmp, 'bg.pid')
		const started = Date.now()
		const r = await exec(d, `sleep 60 & echo $! > ${pidFile}; echo done`, { timeoutSeconds: 30 })
		assert.ok(Date.now() - started < 5000)
		assert.equal(r.state, 'succeeded')
		assert.equal(r.data.timedOut, false)
		assert.equal(r.data.output, 'done\n')
		await new Promise((resolve) => setTimeout(resolve, 200))
		assert.equal(alive(Number(readFileSync(pidFile, 'utf8'))), false)
	})

	test('cuts the output to its last maxOutputBytes and says so', async () => {
		const d = await start()
		const r = await exec(d, "printf 'HEAD'; head -c 3000 /dev/zero | tr '\\0' x; printf 'TAIL'", { maxOutputBytes: 100 })
		assert.equal(r.state, 'succeeded')
		assert.equal(Buffer.byteLength(r.data.output), 100)
		assert.ok(r.data.output.endsWith('xxTAIL'))
		assert.ok(!r.data.output.includes('HEAD'))
		assert.equal(r.data.truncated, true)
		assert.equal(r.data.outputBytes, 3008)
		assert.match(r.summary, /the output was cut/)
		// Within the cap, nothing is cut: exactly at the cap is not truncated.
		const exact = await exec(d, "printf 'abcde'", { maxOutputBytes: 5 })
		assert.deepEqual([exact.data.output, exact.data.truncated], ['abcde', false])
	})

	test('keeps a result under 64 KB at the default cap and a multi-megabyte flood flagged', async () => {
		const d = await start()
		const r = await exec(d, "head -c 3000000 /dev/zero | tr '\\0' 'y'")
		assert.equal(r.state, 'succeeded')
		assert.equal(r.data.truncated, true)
		assert.ok(Buffer.byteLength(JSON.stringify(r.data)) <= 64 * 1024)
		assert.equal(r.data.outputBytes, 3000000)
	})

	test('redacts known secrets, bearer tokens and key-like values from the output and the command', async () => {
		const d = await start()
		const bearer = 'abc.def-ghi_jkl'
		const command = [
			`echo ${MANAGER_TOKEN}`,
			`echo "token ${HOSTOPS_TOKEN}"`,
			'echo proxy-admin-secret-value',
			`echo "Authorization: Bearer ${bearer}"`,
			'echo sk-test1234567890abcdefgh',
			'echo AKIAIOSFODNN7EXAMPLE',
			'echo ghp_abcdefghijklmnopqrstuvwxyz0123456789',
			'echo "API_KEY=hunter2hunter2"',
			'echo \'{"password": "p4ss w0rd"}\'',
			'echo eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.c2lnbmF0dXJl',
			'echo plain words stay',
		].join('; ')
		const r = await exec(d, command)
		const reported = JSON.stringify(r)
		for (const secret of [MANAGER_TOKEN, HOSTOPS_TOKEN, 'proxy-admin-secret-value', bearer, 'sk-test1234567890abcdefgh', 'AKIAIOSFODNN7EXAMPLE', 'ghp_abcdefghijklmnopqrstuvwxyz0123456789', 'hunter2hunter2', 'p4ss w0rd', 'c2lnbmF0dXJl']) {
			assert.ok(!reported.includes(secret), `${secret} reached Pim`)
			assert.ok(!d.logs.join('\n').includes(secret), `${secret} reached the log`)
		}
		assert.match(r.data.output, /plain words stay/)
		assert.match(r.data.output, /Bearer \[redacted\]/)
		assert.match(r.data.output, /API_KEY=\[redacted\]/)
	})

	test('redacts the secrets of its own environment file as it reads them', async () => {
		const d = await start({}, { SOME_API_KEY: 'k3y-value-0123456789' })
		const r = await exec(d, 'echo k3y-value-0123456789')
		assert.equal(r.data.output, '[redacted]\n')
	})

	test('refuses what the allowlist does not take, running nothing', async () => {
		const d = await start()
		const m = path.join(h.tmp, 'marker')
		const attempts = [
			{ command: `touch ${m}`, timeoutSeconds: 301 },
			{ command: `touch ${m}`, timeoutSeconds: 0 },
			{ command: `touch ${m}`, timeoutSeconds: '5' },
			{ command: `touch ${m}`, maxOutputBytes: 65537 },
			{ command: `touch ${m}`, asRoot: true },
			{ command: `touch ${m}`, sudo: true },
			{ command: `touch ${m}`, approval: 'x' },
			{ command: `touch ${m}\0 true` },
			{ command: 'x'.repeat(2001) },
			{ command: '   ' },
			{ command: ['touch', m] },
			{},
		]
		for (const args of attempts) {
			const r = await op(d, 'exec', args)
			assert.equal(r.state, 'failed', JSON.stringify(args).slice(0, 80))
			assert.match(r.summary, /^Refused: .*Nothing ran\.$/)
		}
		assert.equal(existsSync(m), false)
	})

	test('runs nothing while Pim does not accept its credential', async () => {
		const d = await start()
		const m = path.join(h.tmp, 'marker')
		h.pim.ops.push({ id: 'exec-unauth', name: 'exec', args: { command: `touch ${m}` } })
		h.pim.pollStatus = 401
		const s = await d.step()
		assert.ok(s.waitMs > 0)
		assert.equal(existsSync(m), false)
		assert.equal(h.pim.results.length, 0)
		h.pim.pollStatus = null
		// With the wrong credential Pim answers 401 too, and the op stays queued at Pim.
		const wrong = createDaemon(loadConfig({ ...h.env, HOSTOPS_TOKEN: 'not-the-credential' }), { log: () => {} })
		await wrong.start()
		assert.ok((await wrong.step()).waitMs > 0)
		assert.equal(existsSync(m), false)
		assert.equal(h.pim.ops.length, 1)
	})

	test('cannot start without a credential', async () => {
		h = await setup()
		const { HOSTOPS_TOKEN: _, ...rest } = h.env
		assert.throws(() => loadConfig(rest), /HOSTOPS_TOKEN is not set/)
	})
})

describe('the hostopsd process', () => {
	test('runs from its env file, takes an op and exits 0 to restart itself', async () => {
		h = await setup()
		const envFile = path.join(h.tmp, 'env')
		const { HOSTOPS_TOKEN: token, ...rest } = h.env
		writeFileSync(envFile, `HOSTOPS_TOKEN=${token}\n`)
		h.pim.ops.push({ id: 'restart-1', name: 'restart', args: { service: 'hostopsd' } })
		const child = spawn(process.execPath, [ENTRY], { env: { ...rest, HOSTOPSD_ENV_FILE: envFile }, stdio: ['ignore', 'pipe', 'pipe'] })
		let out = ''
		child.stdout.on('data', (c) => (out += c))
		child.stderr.on('data', (c) => (out += c))
		const timer = setTimeout(() => child.kill(), 15000)
		const code = await new Promise((r) => child.on('exit', r))
		clearTimeout(timer)
		assert.equal(code, 0, out)
		assert.equal(h.pim.results[0].id, 'restart-1')
		assert.match(out, /restarting to run the code now checked out/)
		assert.ok(!out.includes(token))
	})

	test('exits 2 with a clear message when misconfigured', async () => {
		h = await setup()
		const child = spawn(process.execPath, [ENTRY], { env: { ...h.env, HOSTOPS_URL: 'http://pim.example.com' }, stdio: ['ignore', 'pipe', 'pipe'] })
		let out = ''
		child.stderr.on('data', (c) => (out += c))
		assert.equal(await new Promise((r) => child.on('exit', r)), 2)
		assert.match(out, /HOSTOPS_URL must be an https:\/\/ origin/)
	})
})
