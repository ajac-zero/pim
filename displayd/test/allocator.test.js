import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, test } from 'node:test'
import { DisplayAllocator } from '../src/allocator.js'
import { FileStore, MemoryStore } from '../src/store.js'
import { FakeRunner } from '../support/fake-runner.js'

const GiB = 1024 ** 3
const MIN = 60_000
let clock, mem, runner, store

beforeEach(() => {
	clock = 1_000_000
	mem = { memAvailableBytes: 10 * GiB, memTotalBytes: 15.6 * GiB }
	runner = new FakeRunner()
	store = new MemoryStore()
})
const make = (over = {}) => new DisplayAllocator({ runner, store, readMemory: async () => mem, now: () => clock, ...over })
const advance = (ms) => (clock += ms)
// Displays start one at a time, so a lease becomes active on the tick after it is acquired.
const up = async (a, threadId, spaceId = 's1') => {
	const l = await a.acquire(threadId, spaceId)
	await a.tick()
	return a.get(threadId) ?? l
}

test('acquire starts one display per thread and is idempotent', async () => {
	const a = make()
	const l1 = await up(a, 't1')
	const again = await a.acquire('t1', 's1')
	assert.equal(again.id, l1.id)
	assert.equal(again.state, 'active')
	assert.equal(runner.started(l1.id), 1)
	assert.equal(a.list().length, 1)

	const l2 = await up(a, 't2')
	assert.notEqual(l2.id, l1.id)
	assert.notEqual(l2.display, l1.display)
	assert.notEqual(l2.vncPort, l1.vncPort)
	assert.notEqual(l2.cdpPort, l1.cdpPort)
})

test('the lease carries the display environment', async () => {
	const a = make()
	const l = await up(a, 't1')
	assert.equal(l.display, 100)
	assert.equal(l.vncPort, 5910)
	assert.equal(l.cdpPort, 9320)
	assert.deepEqual(l.env, {
		DISPLAY: ':100',
		XAUTHORITY: `/fake/displays/${l.id}/Xauthority`,
		DBUS_SESSION_BUS_ADDRESS: `unix:path=/fake/displays/${l.id}/bus`,
		XDG_RUNTIME_DIR: `/fake/displays/${l.id}/run`,
		GTK_MODULES: 'gail:atk-bridge',
		QT_ACCESSIBILITY: '1',
	})
})

test('states: queued, starting, active, idle, active again, reaping, gone', async () => {
	const a = make()
	// Not enough memory: the lease waits in queued.
	mem.memAvailableBytes = 3 * GiB
	assert.equal((await a.acquire('t1', 's1')).state, 'queued')
	assert.equal(a.get('t1').display, null)
	assert.equal(runner.calls.length, 0)

	// Memory frees up; the next tick starts it, and it stays starting until healthy.
	mem.memAvailableBytes = 10 * GiB
	runner.autoHealthy = false
	await a.tick()
	assert.equal(a.get('t1').state, 'starting')
	runner.setHealthy(a.get('t1').id)
	await a.tick()
	assert.equal(a.get('t1').state, 'active')

	advance(61_000)
	await a.tick()
	assert.equal(a.get('t1').state, 'idle')
	await a.touch('t1')
	assert.equal(a.get('t1').state, 'active')

	const id = a.get('t1').id
	assert.equal(await a.release('t1'), true)
	assert.equal(a.get('t1'), null)
	assert.equal(runner.procs.size, 0)
	assert.equal(runner.contexts.has(id), false)
	assert.equal(await a.release('t1'), false)
})

test('a dead display is reaped and the thread can acquire a fresh one', async () => {
	const a = make()
	const first = await up(a, 't1')
	runner.crash(first.id)
	await a.tick()
	assert.equal(a.get('t1'), null)
	const second = await up(a, 't1')
	assert.notEqual(second.id, first.id)
	assert.equal(second.display, first.display) // the slot was freed
})

test('an idle display is reaped after the TTL, 10 minutes by default', async () => {
	const a = make()
	await up(a, 't1')
	await up(a, 't2')
	advance(9 * MIN + 59_000)
	await a.tick()
	assert.equal(a.list().length, 2)
	await a.touch('t2') // t2 is kept alive by its heartbeat
	advance(2_000)
	await a.tick()
	assert.deepEqual(a.list().map((l) => l.threadId), ['t2'])
	assert.equal(runner.procs.size, 1)
})

test('a display marked for a browser lives 20 minutes', async () => {
	const a = make()
	await up(a, 't1')
	await up(a, 't2')
	await a.markBrowser('t1')
	advance(10 * MIN + 1)
	await a.tick()
	assert.deepEqual(a.list().map((l) => l.threadId), ['t1'])
	advance(10 * MIN)
	await a.tick()
	assert.equal(a.list().length, 0)
})

test('a display stuck in starting is killed and started once more', async () => {
	const a = make()
	runner.autoHealthy = false
	const l = await a.acquire('t1', 's1')
	advance(29_000)
	await a.tick()
	assert.equal(runner.started(l.id), 1)

	advance(2_000) // past 30 s
	await a.tick()
	assert.equal(runner.started(l.id), 2)
	assert.equal(runner.procs.size, 1) // the first attempt was killed
	assert.equal(a.get('t1').state, 'starting')
	assert.equal(a.get('t1').attempts, 2)

	runner.setHealthy(l.id)
	await a.tick()
	assert.equal(a.get('t1').state, 'active')
})

test('a display that never starts is given up on after the retry, freeing its slot', async () => {
	const a = make()
	runner.autoHealthy = false
	const l = await a.acquire('t1', 's1')
	advance(31_000)
	await a.tick()
	advance(31_000)
	await a.tick()
	assert.equal(runner.started(l.id), 2)
	assert.equal(a.get('t1'), null)
	assert.equal(runner.procs.size, 0)
	assert.equal(runner.contexts.size, 0)
})

test('a start that throws is retried once, and a second failure drops the lease', async () => {
	const a = make()
	runner.failStarts = 1
	const l = await a.acquire('t1', 's1')
	assert.equal(l.state, 'starting')
	assert.equal(l.attempts, 2)
	assert.match(l.lastError, /spawn failed/)

	runner.failStarts = 2
	await a.tick() // t1 becomes active
	await a.acquire('t2', 's1')
	assert.equal(a.get('t2'), null)
	assert.equal(runner.procs.size, 1)
})

test('the memory guard and the maximum queue leases; a free slot admits the oldest first', async () => {
	const a = make({ config: { maxDisplays: 2 } })
	await up(a, 't1')
	await up(a, 't2')
	assert.equal((await a.acquire('t3', 's1')).state, 'queued')
	advance(1)
	assert.equal((await a.acquire('t4', 's1')).state, 'queued')
	await a.release('t1')
	assert.equal(a.get('t3').state, 'starting')
	assert.equal(a.get('t4').state, 'queued')
})

test('starts one at a time so memory is re-read between displays', async () => {
	const a = make()
	runner.autoHealthy = false
	await a.acquire('t1', 's1')
	assert.equal((await a.acquire('t2', 's1')).state, 'queued')
	runner.setHealthy(a.get('t1').id)
	await a.tick()
	assert.equal(a.get('t1').state, 'active')
	assert.equal(a.get('t2').state, 'starting')
})

test('re-adopts live displays after a restart and reaps orphans', async () => {
	const dir = mkdtempSync(path.join(tmpdir(), 'displayd-'))
	try {
		store = new FileStore(dir)
		const before = make()
		const live = await up(before, 't1')
		const dead = await up(before, 't2')
		const hung = await up(before, 't3')
		await before.touch('t1')
		runner.crash(dead.id) // died while displayd was down
		runner.setHealthy(hung.id, false) // alive but not answering
		// An orphan: a context and processes no lease owns.
		runner.contexts.add('orphan')
		runner.procs.set(77, { id: 'orphan', healthy: true })

		advance(30 * MIN) // a long outage is not the thread's idleness
		const after = make({ store: new FileStore(dir) })
		await after.recover()

		assert.deepEqual(after.list().map((l) => [l.threadId, l.id, l.state]), [['t1', live.id, 'active']])
		assert.equal(runner.started(live.id), 1) // adopted, not restarted
		assert.equal(runner.procs.size, 1)
		assert.deepEqual([...runner.contexts], [live.id])
		await after.tick()
		assert.equal(after.get('t1').state, 'active')
		// and the table written by the new instance survives another restart
		assert.deepEqual(new FileStore(dir).load().map((l) => l.threadId), ['t1'])
	} finally {
		rmSync(dir, { recursive: true, force: true })
	}
})

test('health reports slots, memory and per-display liveness', async () => {
	const a = make()
	const l = await up(a, 't1')
	await up(a, 't2')
	runner.setHealthy(l.id, false)
	const h = await a.health()
	assert.deepEqual(h.slots, { max: 6, used: 2, free: 4 })
	assert.equal(h.memAvailableBytes, 10 * GiB)
	assert.deepEqual(h.displays.map((d) => [d.threadId, d.alive]), [['t1', false], ['t2', true]])
})
