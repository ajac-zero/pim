import assert from 'node:assert/strict'
import { after, before, test } from 'node:test'
import { DisplayAllocator } from '../src/allocator.js'
import { createServer } from '../src/api.js'
import { MemoryStore } from '../src/store.js'
import { FakeRunner } from '../support/fake-runner.js'

const GiB = 1024 ** 3
let server, base, allocator
const runner = new FakeRunner()

before(async () => {
	allocator = new DisplayAllocator({ runner, store: new MemoryStore(), readMemory: async () => ({ memAvailableBytes: 10 * GiB, memTotalBytes: 15.6 * GiB }) })
	server = createServer({ allocator, token: 'secret-token' })
	await new Promise((r) => server.listen(0, '127.0.0.1', r))
	base = `http://127.0.0.1:${server.address().port}`
})
after(() => server.close())

const call = async (method, path, body, token = 'secret-token') => {
	const res = await fetch(base + path, { method, headers: { ...(token ? { authorization: `Bearer ${token}` } : {}), 'content-type': 'application/json' }, body: body ? JSON.stringify(body) : undefined })
	return { status: res.status, json: await res.json() }
}

test('every route needs the bearer token', async () => {
	assert.equal((await call('GET', '/health', null, null)).status, 401)
	assert.equal((await call('GET', '/displays', null, 'wrong')).status, 401)
	assert.equal((await call('POST', '/acquire', { threadId: 't', spaceId: 's' }, 'wrong')).status, 401)
})

test('acquire, touch, list, health and release', async () => {
	const a = await call('POST', '/acquire', { threadId: 'thr-1', spaceId: 'sp-1' })
	assert.equal(a.status, 202) // still starting
	assert.equal(a.json.lease.state, 'starting')
	assert.equal(a.json.lease.env.DISPLAY, ':100')

	await allocator.tick()
	const t = await call('POST', '/touch', { threadId: 'thr-1', browser: true })
	assert.equal(t.status, 200)
	assert.equal(t.json.lease.browser, true)
	assert.equal((await call('POST', '/touch', { threadId: 'nobody' })).status, 404)

	assert.deepEqual((await call('GET', '/displays')).json.displays.map((d) => d.threadId), ['thr-1'])
	const h = await call('GET', '/health')
	assert.equal(h.json.slots.used, 1)
	assert.equal(h.json.displays[0].alive, true)

	assert.deepEqual((await call('POST', '/release', { threadId: 'thr-1' })).json, { released: true })
	assert.deepEqual((await call('GET', '/displays')).json.displays, [])
})

test('bad input is rejected', async () => {
	assert.equal((await call('POST', '/acquire', { threadId: 't' })).status, 400)
	assert.equal((await call('POST', '/acquire', { threadId: '../x y', spaceId: 's' })).status, 400)
	assert.equal((await call('GET', '/nope')).status, 404)
})
