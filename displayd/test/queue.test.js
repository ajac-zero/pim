import assert from 'node:assert/strict'
import { beforeEach, test } from 'node:test'
import { DisplayAllocator } from '../src/allocator.js'
import { MemoryStore } from '../src/store.js'
import { FakeRunner } from '../support/fake-runner.js'

const GiB = 1024 ** 3
const MIN = 60_000
let clock, runner, store

// Memory for 2 displays at 3.9 GiB total, as on the real computer, so a third thread must queue.
const mem = { memAvailableBytes: 3 * GiB, memTotalBytes: 3.9 * GiB }
beforeEach(() => {
	clock = 1_000_000
	runner = new FakeRunner()
	store = new MemoryStore()
})
const make = (config = {}) => new DisplayAllocator({ runner, store, readMemory: async () => mem, now: () => clock, config: { maxDisplays: 2, ...config } })
const advance = (ms) => (clock += ms)
const up = async (a, t, space = 's1') => {
	await a.acquire(t, space)
	await a.tick()
	return a.get(t)
}
const full = async (a) => {
	await up(a, 'h1')
	await up(a, 'h2')
}

test('queued threads are served oldest first and report position, holders and wait', async () => {
	const a = make()
	await full(a)
	advance(30_000)
	const q1 = await a.acquire('q1', 's1')
	advance(1000)
	const q2 = await a.acquire('q2', 's1')
	assert.equal(q1.state, 'queued')
	assert.equal(q1.position, 1)
	assert.equal(a.get('q2').position, 2)
	assert.deepEqual(q1.holders, [
		{ threadId: 'h1', idleSec: 30, state: 'active' },
		{ threadId: 'h2', idleSec: 30, state: 'active' },
	])
	// A holder is taken once idle for 2 minutes: 90 s from now for the first, another ttl later for the second round.
	assert.equal(q1.estimatedWaitSec, 90)
	assert.equal(a.get('q2').estimatedWaitSec, 89) // a second later
	assert.equal(q2.holders.length, 2)
	// Asking again keeps the place.
	assert.equal((await a.acquire('q1', 's1')).position, 1)

	await a.release('h1')
	await a.tick()
	assert.equal(a.get('q1').state, 'active')
	assert.equal(a.get('q2').position, 1)
})

test('with several spaces queued they take turns', async () => {
	const a = make()
	await full(a)
	for (const [t, s] of [['a1', 'A'], ['a2', 'A'], ['b1', 'B'], ['a3', 'A'], ['b2', 'B']]) {
		await a.acquire(t, s)
		advance(1000)
	}
	const order = ['a1', 'b1', 'a2', 'b2', 'a3']
	assert.deepEqual(order.map((t) => a.get(t).position), [1, 2, 3, 4, 5])
})

test('a lease queued for 5 minutes times out, once, and the next acquire queues again', async () => {
	const a = make()
	await full(a)
	await a.acquire('q', 's1')
	for (let i = 0; i < 5; i++) {
		advance(MIN - (i === 4 ? 1 : 0))
		await a.touch('h1') // the holders stay busy, so nothing is preempted
		await a.touch('h2')
		if (i < 4) assert.equal((await a.acquire('q', 's1')).state, 'queued')
	}
	assert.equal((await a.acquire('q', 's1')).state, 'queued') // 5 min minus 1 ms
	advance(1)
	assert.equal((await a.acquire('q', 's1')).state, 'timeout')
	await a.touch('h1')
	await a.touch('h2')
	const again = await a.acquire('q', 's1')
	assert.equal(again.state, 'queued')
	assert.equal(again.position, 1)
	assert.equal(a.list().filter((l) => l.threadId === 'q').length, 1)
})

test('preemption takes the longest-idle display that is idle for more than minIdle', async () => {
	const a = make()
	await up(a, 'old')
	advance(30_000)
	await up(a, 'newer')
	advance(MIN + 30_000) // old: 2 min exactly, newer: 1.5 min
	await a.acquire('q', 's1')
	await a.tick()
	assert.notEqual(a.get('old').state, 'gone', 'idle for exactly minIdle is not enough')
	assert.equal(a.get('q').state, 'queued')

	advance(1000) // old: 121 s
	await a.tick()
	assert.equal(a.get('old').state, 'gone')
	assert.equal(a.get('old').reason, 'preempted')
	assert.notEqual(a.get('newer').state, 'gone')
	assert.equal(a.get('q').state, 'starting')
	// Only one display was taken for the one queued thread.
	assert.deepEqual(a.list().filter((l) => l.display !== null).map((l) => l.threadId).sort(), ['newer', 'q'])
})

test('a display touched within minIdle, or under user control, is never preempted', async () => {
	const a = make()
	await full(a)
	advance(5 * MIN)
	await a.touch('h1') // a tool call
	await a.setControl('h2', 'user')
	advance(MIN)
	await a.acquire('q', 's1')
	await a.tick()
	assert.notEqual(a.get('h1').state, 'gone')
	assert.notEqual(a.get('h2').state, 'gone')
	assert.equal(a.get('q').state, 'queued')
	advance(MIN + 1000) // h1 is now idle for more than 2 min; h2 is still in a person's hands
	await a.tick()
	assert.equal(a.get('h1').state, 'gone')
	assert.notEqual(a.get('h2').state, 'gone')
	assert.equal(a.get('q').state, 'starting')
})

test('a preempted thread asking again is queued behind the others with a fresh lease', async () => {
	const a = make()
	await full(a)
	advance(3 * MIN)
	await a.touch('h2') // so only h1 is idle long enough
	await a.acquire('q', 's1')
	await a.tick()
	const gone = a.get('h1')
	assert.equal(gone.state, 'gone')
	assert.equal(gone.reason, 'preempted')
	const back = await a.acquire(gone.threadId, 's1')
	assert.equal(back.state, 'queued')
	assert.notEqual(back.id, gone.id)
	assert.equal(back.position, 1)
	assert.equal(a.list().filter((l) => l.threadId === gone.threadId).length, 1)
})

test('user control lasts until handed back or 30 minutes without a viewer touch', async () => {
	const a = make({ ttlMs: 10 * MIN })
	await up(a, 't')
	assert.equal(a.get('t').control, 'agent')
	await a.setControl('t', 'user')
	assert.equal(a.get('t').control, 'user')
	// Not idle and not reaped past the idle TTL.
	advance(15 * MIN)
	await a.tick()
	assert.equal(a.get('t').state, 'active')
	// A viewer touch keeps the take-over going.
	await a.touch('t', { viewer: true })
	advance(29 * MIN)
	await a.tick()
	assert.equal(a.get('t').control, 'user')
	advance(MIN)
	await a.tick()
	assert.equal(a.get('t').control, 'agent')
	assert.equal(a.get('t').state, 'active') // the agent gets a fresh idle clock
	await a.setControl('t', 'user')
	await a.setControl('t', 'agent')
	assert.equal(a.get('t').control, 'agent')
	assert.equal(await a.setControl('nobody', 'user'), null)
})

test('viewer activity keeps an otherwise idle display from being reaped', async () => {
	const a = make({ ttlMs: 10 * MIN })
	await up(a, 'watched')
	await up(a, 'ignored')
	for (let i = 0; i < 3; i++) {
		advance(4 * MIN)
		await a.touch('watched', { viewer: true })
		await a.tick()
	}
	assert.equal(a.get('watched').state, 'active')
	assert.equal(a.get('ignored'), null) // reaped after 10 idle minutes
})

test('a restart keeps the queue and the leases', async () => {
	const a = make()
	await full(a)
	advance(MIN)
	await a.acquire('q1', 's1')
	advance(1000)
	await a.acquire('q2', 's2')
	await a.setControl('h1', 'user')
	const before = a.get('q1').createdAt

	const b = make()
	await b.recover()
	assert.deepEqual(['h1', 'h2'].map((t) => b.get(t).state), ['active', 'active'])
	assert.equal(b.get('h1').control, 'user')
	assert.equal(b.get('q1').createdAt, before)
	assert.deepEqual([b.get('q1').position, b.get('q2').position], [1, 2])
	await b.release('h2')
	await b.tick()
	assert.equal(b.get('q1').state, 'active')
	assert.equal(b.get('q2').position, 1)
})
