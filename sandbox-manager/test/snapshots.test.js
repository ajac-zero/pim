import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { createHash, randomBytes } from 'node:crypto'
import { promises as fs, mkdtempSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { Readable } from 'node:stream'
import { afterEach, beforeEach, describe, test } from 'node:test'
import zlib from 'node:zlib'
import { Docker } from '../src/docker.js'
import { createManager } from '../src/manager.js'
import { entryPolicy } from '../src/snapshots.js'
import { TarError, tarEnd, tarHeader, transformTar } from '../src/tar.js'
import { startFakeDocker } from '../support/fake-docker.js'

const IMAGE = 'registry.example/sandbox@sha256:abc'
const KiB = 1024
const MiB = 1024 * KiB
const DAY = 86400000
const limits = { cpu: 1, memMiB: 512, diskMiB: 64, pids: 128 }
const cfg = { token: 't0ken', agentdSecret: 's3cret', allowedImages: [IMAGE], dockerRoot: '/', minFreePct: 15, maxConcurrent: 8, idleMin: 30, proxyUrl: 'http://egress-proxy:3128', proxyContainer: 'egress-proxy', quotaMode: 'measure', agentdReadyMs: 2000, execGraceMs: 200 }
const ada = { userId: 'ada', repo: 'github.com/ada/app' }
const bob = { userId: 'bob', repo: 'github.com/ada/app' }
const K1 = '1'.repeat(32)
const K2 = '2'.repeat(32)
const K3 = '3'.repeat(32)
const K4 = '4'.repeat(32)
const session = (sessionId, owner = ada, extra = {}) => ({ sessionId, image: IMAGE, limits, ...owner, ...extra })

let fake, mgr, dataDir, clock
const proxy = { set: async () => {}, del: async () => {} }
const make = (over = {}, statfsFn = async () => ({ bavail: 50, blocks: 100 })) =>
	createManager({ docker: new Docker(fake.path), cfg: { ...cfg, dataDir, ...over }, proxyAdmin: proxy, statfsFn, agentdAddress: fake.agentdAddress, now: () => clock.t })
async function setup(over = {}) {
	fake = await startFakeDocker()
	dataDir = mkdtempSync(path.join(os.tmpdir(), 'mgr-snap-'))
	clock = { t: 1_800_000_000_000 }
	mgr = make(over)
	await new Promise((r) => mgr.server.listen(0, '127.0.0.1', r))
}
async function teardown() {
	mgr.server.closeAllConnections()
	await new Promise((r) => mgr.server.close(r))
	await fake.close()
	await fs.rm(dataDir, { recursive: true, force: true })
}
async function call(method, p, body) {
	const r = await fetch(`http://127.0.0.1:${mgr.server.address().port}${p}`, { method, headers: { authorization: 'Bearer t0ken' }, body: body === undefined ? undefined : JSON.stringify(body) })
	const text = await r.text()
	let json
	try {
		json = JSON.parse(text)
	} catch {}
	return { status: r.status, json, text }
}
const snap = (sessionId, key, owner = ada) => call('POST', '/snapshots', { ...owner, key, sessionId })
const listed = async (owner = ada) => (await call('GET', `/snapshots?userId=${owner.userId}&repo=${encodeURIComponent(owner.repo)}`)).json.map((s) => s.key)
const ws = (id) => fake.volumeDir(`pim-ws-${id}`)
async function write(dir, files) {
	for (const [p, content] of Object.entries(files)) {
		await fs.mkdir(path.dirname(path.join(dir, p)), { recursive: true })
		await fs.writeFile(path.join(dir, p), content)
	}
}
// Every file under the snapshot store, relative to it.
const stored = async () => (await fs.readdir(path.join(dataDir, 'snapshots'), { recursive: true, withFileTypes: true })).filter((e) => e.isFile()).map((e) => path.relative(dataDir, path.join(e.parentPath, e.name)))
const archiveCalls = (method) => fake.calls.filter((c) => c.method === method && c.path.endsWith('/archive'))
async function storedFiles(key) {
	const meta = (await stored()).find((f) => f.endsWith(`${key}.json`))
	const m = JSON.parse(await fs.readFile(path.join(dataDir, meta), 'utf8'))
	return { m, meta: path.join(dataDir, meta), data: path.join(dataDir, path.dirname(meta), `${key}${m.format === 'zstd' ? '.tar.zst' : '.tar.gz'}`) }
}
const compress = (buf, format) => (format === 'zstd' ? zlib.zstdCompressSync(buf) : zlib.gzipSync(buf))
const pad = (n) => Buffer.alloc((512 - (n % 512)) % 512)
const tarOf = (entries) => Buffer.concat([...entries.flatMap((e) => [tarHeader({ mode: 0o644, mtime: 1, size: e.data?.length ?? 0, ...e }), e.data ?? Buffer.alloc(0), pad(e.data?.length ?? 0)]), tarEnd()])
async function runPolicy(buf, policy = entryPolicy()) {
	const out = []
	for await (const c of transformTar(Readable.from([buf]), policy)) out.push(c)
	return Buffer.concat(out)
}

describe('snapshots', () => {
	beforeEach(() => setup())
	afterEach(() => teardown())

	test('create, list and restore round-trip: sha256 verified, credentials left out, files owned by the sandbox user', async () => {
		assert.equal((await call('POST', '/sessions', session('a-1'))).status, 201)
		const dir = ws('a-1')
		const long = `app/${'d'.repeat(120)}/f.txt`
		await write(dir, {
			'app/package.json': '{"name":"app"}',
			'app/src/index.js': 'console.log(1)',
			[long]: 'long name',
			'app/.env': 'IN_REPO=1',
			'app/.npmrc': 'registry=https://registry.npmjs.org/',
			'app/.git/config': '[remote "origin"]\n\turl = https://x-access-token:ghp_SECRET@github.com/ada/app.git\n[http "https://github.com/"]\n\textraheader = AUTHORIZATION: basic U0VDUkVUMg==\n',
			'.cache/tool/bin': '#!/bin/sh',
			'.npmrc': '//registry.npmjs.org/:_authToken=NPM_SECRET',
			'.netrc': 'machine github.com password NETRC_SECRET',
			'.config/gh/hosts.yml': 'oauth_token: GH_SECRET',
			'.cache/x/.env': 'CACHE_SECRET=1',
			'.env.local': 'HOME_SECRET=1',
			'.codex/auth.json': '{"token":"CODEX_SECRET"}',
		})
		await fs.chmod(path.join(dir, '.cache/tool/bin'), 0o4755)
		await fs.symlink('src/index.js', path.join(dir, 'app/link'))
		await fs.link(path.join(dir, 'app/src/index.js'), path.join(dir, 'app/hard'))
		await fs.mkdir(path.join(dir, '.venv/bin'), { recursive: true })
		await fs.symlink('/usr/bin/python3', path.join(dir, '.venv/bin/python'))
		assert.equal(spawnSync('mkfifo', [path.join(dir, 'app/pipe')]).status, 0)

		const r = await snap('a-1', K1)
		assert.equal(r.status, 201, r.text)
		const { data } = await storedFiles(K1)
		const bytes = await fs.readFile(data)
		assert.deepEqual([r.json.key, r.json.repo, r.json.size, r.json.sha256], [K1, ada.repo, bytes.length, createHash('sha256').update(bytes).digest('hex')])
		// .npmrc, .netrc, .config/gh and its file, .cache/x/.env, .env.local, .codex/auth.json, the python link, the fifo.
		assert.equal(r.json.excluded, 9)
		assert.ok(!bytes.includes('SECRET'), 'compressed, so this only rules out the obvious')
		const list = await call('GET', `/snapshots?userId=ada&repo=${encodeURIComponent(ada.repo)}`)
		assert.deepEqual(list.json.map((s) => [s.key, s.size, s.sha256, s.createdAt, s.lastUsedAt]), [[K1, r.json.size, r.json.sha256, clock.t, clock.t]])

		clock.t += 60000
		const b = await call('POST', '/sessions', session('b-1', ada, { restoreFrom: { key: K1 } }))
		assert.equal(b.status, 201, b.text)
		assert.equal(b.json.restoredFrom, K1)
		const [put] = archiveCalls('PUT')
		assert.equal(put.path, '/containers/pim-s-b-1/archive')
		assert.deepEqual([put.query.get('path'), put.query.get('copyUIDGID')], ['/workspace', '1'])
		const order = fake.calls.map((c) => `${c.method} ${c.path}`)
		assert.ok(order.indexOf('PUT /containers/pim-s-b-1/archive') < order.indexOf('POST /containers/pim-s-b-1/start'), 'restored before the container starts')
		// Every entry Docker received is the sandbox user's and has no setuid bit.
		const seen = []
		await runPolicy(put.raw, (e) => (seen.push(e), null))
		assert.ok(seen.every((e) => e.uid === 10001 && e.gid === 10001 && !(e.mode & 0o7000)))

		const out = ws('b-1')
		const read = (p) => fs.readFile(path.join(out, p), 'utf8')
		assert.equal(await read('app/package.json'), '{"name":"app"}')
		assert.equal(await read(long), 'long name')
		assert.equal(await read('app/.env'), 'IN_REPO=1')
		assert.equal(await read('app/.npmrc'), 'registry=https://registry.npmjs.org/')
		assert.equal(await fs.readlink(path.join(out, 'app/link')), 'src/index.js')
		assert.equal(await read('app/hard'), 'console.log(1)')
		assert.equal((await fs.stat(path.join(out, '.cache/tool/bin'))).mode & 0o7777, 0o755)
		const git = await read('app/.git/config')
		assert.match(git, /url = https:\/\/github\.com\/ada\/app\.git/)
		assert.ok(!git.includes('ghp_SECRET') && !git.includes('extraheader'), git)
		for (const p of ['.npmrc', '.netrc', '.config/gh', '.cache/x/.env', '.env.local', '.codex/auth.json', '.venv/bin/python', 'app/pipe']) {
			await assert.rejects(fs.lstat(path.join(out, p)), { code: 'ENOENT' }, p)
		}
		assert.deepEqual((await call('GET', '/snapshots?userId=ada')).json.map((s) => [s.key, s.lastUsedAt]), [[K1, clock.t]])
		// The same key again returns the snapshot there, without reading the workspace.
		const again = await snap('a-1', K1)
		assert.deepEqual([again.status, again.json.sha256], [200, r.json.sha256])
		assert.equal(archiveCalls('GET').length, 1)
	})

	test('a corrupt snapshot is refused before anything is extracted, deleted, and the session is not created', async () => {
		await call('POST', '/sessions', session('a-1'))
		await write(ws('a-1'), { 'a.txt': 'hello' })
		await snap('a-1', K1)
		const { data } = await storedFiles(K1)
		const bytes = await fs.readFile(data)
		bytes[bytes.length >> 1] ^= 0xff
		await fs.writeFile(data, bytes)
		const r = await call('POST', '/sessions', session('b-1', ada, { restoreFrom: { key: K1 } }))
		assert.deepEqual([r.status, r.json.code], [422, 'snapshot_corrupt'])
		assert.equal(archiveCalls('PUT').length, 0)
		assert.ok(!fake.containers.has('pim-s-b-1') && !fake.volumes.has('pim-ws-b-1') && !fake.networks.has('pim-net-b-1'))
		assert.deepEqual(await listed(), [])
		assert.equal((await call('GET', '/health')).json.running, 1, 'the slot was released')
	})

	test('a tampered snapshot that escapes the workspace is refused and the new workspace removed', async () => {
		await call('POST', '/sessions', session('a-1'))
		await write(ws('a-1'), { 'a.txt': 'hello' })
		await snap('a-1', K1)
		// Someone with write access to the store replaced the tarball and its recorded sha256.
		const { m, meta, data } = await storedFiles(K1)
		const evil = compress(tarOf([{ name: 'ok.txt', type: 'file', data: Buffer.from('ok') }, { name: '../evil', type: 'file', data: Buffer.from('pwned') }]), m.format)
		await fs.writeFile(data, evil)
		await fs.writeFile(meta, JSON.stringify({ ...m, size: evil.length, sha256: createHash('sha256').update(evil).digest('hex') }))
		const fresh = make()
		await fresh.reconcile()
		await assert.rejects(fresh.createSession(session('b-1', ada, { restoreFrom: { key: K1 } })), (e) => e.status === 422 && e.extra.code === 'snapshot_invalid' && /escapes the workspace/.test(e.message))
		const [put] = archiveCalls('PUT')
		assert.ok(!put?.raw?.includes('pwned'), 'the escaping entry never reached Docker')
		await assert.rejects(fs.access(path.join(path.dirname(ws('b-1')), 'evil')), { code: 'ENOENT' })
		assert.ok(!fake.containers.has('pim-s-b-1') && !fake.volumes.has('pim-ws-b-1'))
	})

	test('restore refuses every unsafe tar entry', async () => {
		const file = (name, data = 'x') => ({ name, type: 'file', data: Buffer.from(data) })
		const bad = {
			absolute: [file('/etc/passwd')],
			dotdot: [file('a/../../evil')],
			'symlink up': [{ name: 'l', type: 'symlink', linkname: '../../etc' }],
			'absolute symlink': [{ name: 'l', type: 'symlink', linkname: '/etc' }],
			'absolute symlink through workspace': [{ name: 'l', type: 'symlink', linkname: '/workspace/../etc' }],
			'entry beneath a symlink': [{ name: 'sub/', type: 'dir' }, { name: 'l', type: 'symlink', linkname: 'sub' }, file('l/x')],
			'symlink replaced': [{ name: 'l', type: 'symlink', linkname: 'a' }, file('l')],
			'hardlink outside': [{ name: 'h', type: 'hardlink', linkname: '../etc/passwd' }],
			'hardlink to nothing': [{ name: 'h', type: 'hardlink', linkname: 'missing' }],
			'char device': [{ name: 'tty', flag: '3' }],
			fifo: [{ name: 'p', flag: '6' }],
		}
		for (const [what, entries] of Object.entries(bad)) await assert.rejects(runPolicy(tarOf(entries)), TarError, what)
		const ok = tarOf([file('a'), { name: 'l', type: 'symlink', linkname: '/workspace/a' }, { name: 'd/l2', type: 'symlink', linkname: '../a' }, { name: 'h', type: 'hardlink', linkname: 'a' }])
		assert.ok((await runPolicy(ok)).length > 0)
		const truncated = tarOf([file('a', 'x'.repeat(2000))]).subarray(0, 1024)
		await assert.rejects(runPolicy(truncated), TarError)
		const badSum = tarOf([file('a')])
		badSum[0] ^= 1
		await assert.rejects(runPolicy(badSum), /checksum/)
	})

	test('one user can never list, restore, delete or take another user\'s snapshot', async () => {
		await call('POST', '/sessions', session('a-1'))
		await call('POST', '/sessions', session('b-1', bob))
		await write(ws('a-1'), { 'who.txt': 'ada' })
		await write(ws('b-1'), { 'who.txt': 'bob' })
		assert.equal((await snap('a-1', K1)).status, 201)
		assert.deepEqual(await listed(bob), [])
		assert.equal((await call('GET', '/snapshots')).status, 400, 'userId is required')
		const stolen = await call('POST', '/sessions', session('b-2', bob, { restoreFrom: { key: K1 } }))
		assert.deepEqual([stolen.status, stolen.json.code], [404, 'snapshot_not_found'])
		assert.ok(!fake.containers.has('pim-s-b-2'))
		assert.equal((await call('DELETE', `/snapshots/${K1}?userId=bob`)).status, 404)
		assert.equal((await call('DELETE', `/snapshots/${K1}`)).status, 400)
		assert.deepEqual(await listed(), [K1])
		const forged = await snap('a-1', K2, bob)
		assert.deepEqual([forged.status, forged.json.code], [403, 'forbidden'])
		// The same key is a different snapshot per user.
		assert.equal((await snap('b-1', K1, bob)).status, 201)
		await call('POST', '/sessions', session('a-2', ada, { restoreFrom: { key: K1 } }))
		await call('POST', '/sessions', session('b-2', bob, { restoreFrom: { key: K1 } }))
		assert.equal(await fs.readFile(path.join(ws('a-2'), 'who.txt'), 'utf8'), 'ada')
		assert.equal(await fs.readFile(path.join(ws('b-2'), 'who.txt'), 'utf8'), 'bob')
		assert.equal((await call('DELETE', `/snapshots/${K1}?userId=bob`)).status, 200)
		assert.deepEqual([await listed(), await listed(bob)], [[K1], []])
	})

	test('concurrent creates of one (user, key) share one snapshot', async () => {
		await call('POST', '/sessions', session('a-1'))
		await write(ws('a-1'), { 'a.txt': randomBytes(256 * KiB).toString('hex') })
		const rs = await Promise.all([snap('a-1', K1), snap('a-1', K1), snap('a-1', K1)])
		assert.deepEqual(rs.map((r) => r.status).sort(), [200, 200, 201])
		assert.equal(new Set(rs.map((r) => r.json.sha256)).size, 1)
		assert.equal(archiveCalls('GET').length, 1)
		assert.equal((await stored()).length, 2, 'one tarball and its metadata')
	})

	test('a failed or interrupted write leaves no snapshot and no files', async () => {
		await call('POST', '/sessions', session('a-1'))
		await write(ws('a-1'), { 'big.bin': randomBytes(MiB) })
		fake.archiveFailAfter = 64 * KiB
		const r = await snap('a-1', K1)
		assert.deepEqual([r.status, r.json.code], [502, 'snapshot_failed'], r.text)
		assert.deepEqual(await listed(), [])
		assert.deepEqual(await stored(), [])
		// What a crash in the middle of a write leaves: a temporary file, a tarball whose metadata was
		// never written, and metadata whose tarball is gone. A restarted manager removes all of it.
		fake.archiveFailAfter = null
		assert.equal((await snap('a-1', K2)).status, 201)
		const { m, data } = await storedFiles(K2)
		const dir = path.dirname(data)
		await fs.writeFile(path.join(dir, '.tmp-abc123'), 'partial')
		await fs.writeFile(path.join(dir, `${K3}.tar.zst`), 'orphan')
		await fs.writeFile(path.join(dir, `${K4}.json`), JSON.stringify({ ...m, key: K4 }))
		const fresh = make()
		await fresh.reconcile()
		assert.deepEqual((await fresh.env.list('ada')).map((s) => s.key), [K2])
		assert.deepEqual((await fs.readdir(dir)).sort(), [`${K2}.json`, path.basename(data)].sort())
	})

	test('a snapshot over the size limit fails clearly and leaves nothing', async () => {
		await teardown()
		await setup({ snapshotMaxBytes: 128 * KiB })
		await call('POST', '/sessions', session('a-1'))
		await write(ws('a-1'), { 'big.bin': randomBytes(512 * KiB) })
		const r = await snap('a-1', K1)
		assert.deepEqual([r.status, r.json.code, r.json.maxBytes], [413, 'snapshot_too_large', 128 * KiB])
		assert.match(r.json.error, /larger than 131072 bytes/)
		assert.deepEqual(await stored(), [])
	})

	test('snapshot creation refuses sessions with run-time secrets, of other repos and on low disk', async () => {
		await call('POST', '/sessions', session('s-1', ada, { hasRuntimeSecrets: true }))
		const r = await snap('s-1', K1)
		assert.deepEqual([r.status, r.json.code], [409, 'runtime_secrets'])
		assert.equal(archiveCalls('GET').length, 0)
		assert.deepEqual(JSON.parse(fake.containers.get('pim-s-s-1').body.Labels['pim.coding.spec']).hasRuntimeSecrets, true, 'survives a restart')
		assert.equal((await call('POST', '/sessions', session('s-2', ada, { hasRuntimeSecrets: 'yes' }))).status, 400)
		await call('POST', '/sessions', { sessionId: 'anon', image: IMAGE, limits })
		assert.equal((await snap('anon', K1)).status, 403)
		await call('POST', '/sessions', session('a-1'))
		assert.deepEqual([(await snap('a-1', K1, { ...ada, repo: 'github.com/ada/other' })).json.code], ['repo_mismatch'])
		assert.equal((await call('POST', '/sessions', { ...session('x'), userId: undefined, restoreFrom: { key: K1 } })).status, 400)
		const low = make({}, async () => ({ bavail: 5, blocks: 100 }))
		await low.reconcile()
		await assert.rejects(low.snapshot({ ...ada, key: K1, sessionId: 'a-1' }), { status: 507, extra: { code: 'low_disk', freeDiskPct: 5, minFreePct: 15 } })
		assert.deepEqual(await stored(), [])
	})
})

describe('garbage collection and disk accounting', () => {
	afterEach(() => teardown())

	test('keeps the newest two snapshots per (user, repo) and deletes ones unused for 7 days', async () => {
		await setup()
		const other = { ...ada, repo: 'github.com/ada/other' }
		await call('POST', '/sessions', session('a-1'))
		await call('POST', '/sessions', session('o-1', other))
		for (const k of [K1, K2, K3]) {
			await write(ws('a-1'), { 'v.txt': k })
			assert.equal((await snap('a-1', k)).status, 201)
			clock.t += 1000
		}
		await snap('o-1', K4, other)
		await mgr.reap()
		assert.deepEqual(await listed(), [K3, K2])
		assert.deepEqual(await listed(other), [K4])
		clock.t += 6 * DAY
		await call('POST', '/sessions', session('a-2', ada, { restoreFrom: { key: K2 } }))
		clock.t += 2 * DAY
		await mgr.reap()
		assert.deepEqual(await listed(), [K2], 'used two days ago')
		assert.deepEqual(await listed(other), [])
		assert.equal((await stored()).length, 2)
	})

	test('over the cap the least recently used snapshots and unmounted caches go; mounted caches stay and still count', async () => {
		// Snapshots and caches may use 0.2% of 1000 MiB: 2 MiB.
		await setup({ maxTotalWorkspaceMiB: 1000, envCachePct: 0.2 })
		await call('POST', '/sessions', session('a-1'))
		const cacheOf = (id) => fake.containers.get(`pim-s-${id}`).body.HostConfig.Mounts.find((m) => m.Target === '/caches').Source
		const adaCache = cacheOf('a-1')
		await write(ws('a-1'), { 'r.bin': randomBytes(900 * KiB) })
		await snap('a-1', K1)
		clock.t += 1000
		await call('POST', '/sessions', session('b-1', bob))
		const bobCache = cacheOf('b-1')
		await call('DELETE', '/sessions/b-1')
		clock.t += 1000
		await write(ws('a-1'), { 'r.bin': randomBytes(900 * KiB) })
		await snap('a-1', K2)
		fake.volumeSizes.set(adaCache, 700 * KiB)
		fake.volumeSizes.set(bobCache, 500 * KiB)
		await mgr.reap()
		// 900 + 900 + 700 + 500 KiB: K1, then bob's unmounted cache, are the least recently used.
		assert.deepEqual(await listed(), [K2])
		assert.ok(!fake.volumes.has(bobCache) && fake.volumes.has(adaCache))
		const h = (await call('GET', '/health')).json
		assert.equal(h.snapshotCount, 1)
		assert.equal(h.cacheBytes, 700 * KiB)
		assert.ok(h.snapshotBytes > 900 * KiB && h.snapshotBytes < 1000 * KiB, String(h.snapshotBytes))
		// A mounted cache is never evicted, even alone over the cap, and counts toward the total.
		fake.volumeSizes.set(adaCache, 950 * MiB)
		await mgr.reap()
		assert.ok(fake.volumes.has(adaCache))
		assert.ok(!fake.calls.some((c) => c.method === 'DELETE' && c.path === `/volumes/${adaCache}`), 'not even tried while mounted')
		assert.deepEqual(await listed(), [], 'the snapshot went first')
		const r = await call('POST', '/sessions', session('c-1', bob))
		assert.deepEqual([r.status, r.json.code, r.json.reservedMiB], [507, 'workspace_quota', 950 + 64])
		// Unmounted, it goes at the next pass.
		await call('DELETE', '/sessions/a-1')
		await mgr.reap()
		assert.ok(!fake.volumes.has(adaCache))
		assert.deepEqual((await call('GET', '/health')).json.cacheBytes, 0)
	})

	test('cache volumes are measured whichever /system/df shape the daemon answers with', async () => {
		await setup()
		await call('POST', '/sessions', session('a-1'))
		const cache = fake.containers.get('pim-s-a-1').body.HostConfig.Mounts.find((m) => m.Target === '/caches').Source
		fake.volumeSizes.set(cache, 300 * KiB)
		for (const [apiVersion, size] of [['1.51', 300 * KiB], ['1.52', 400 * KiB], ['1.53', 500 * KiB]]) {
			fake.apiVersion = apiVersion
			fake.volumeSizes.set(cache, size)
			await mgr.reap()
			assert.equal((await call('GET', '/health')).json.cacheBytes, size, apiVersion)
		}
		// A cache volume that is gone is forgotten, even when Docker leaves out an empty list.
		await call('DELETE', '/sessions/a-1')
		fake.volumes.delete(cache)
		await mgr.reap()
		assert.equal((await call('GET', '/health')).json.cacheBytes, 0)
	})

	test('a snapshot being restored is never collected or deleted', async () => {
		await setup()
		await call('POST', '/sessions', session('a-1'))
		await write(ws('a-1'), { 'a.txt': 'hello' })
		await snap('a-1', K1)
		clock.t += 8 * DAY
		let release
		fake.onArchivePut = () => new Promise((r) => (release = r))
		const pending = call('POST', '/sessions', session('b-1', ada, { restoreFrom: { key: K1 } }))
		while (!release) await new Promise((r) => setTimeout(r, 5))
		await mgr.reap()
		assert.deepEqual(await listed(), [K1], 'expired but in use')
		const del = await call('DELETE', `/snapshots/${K1}?userId=ada`)
		assert.deepEqual([del.status, del.json.code], [409, 'snapshot_in_use'])
		release()
		assert.equal((await pending).status, 201)
		assert.equal(await fs.readFile(path.join(ws('b-1'), 'a.txt'), 'utf8'), 'hello')
		await mgr.reap()
		assert.deepEqual(await listed(), [K1], 'the restore counted as use')
		assert.equal((await call('DELETE', `/snapshots/${K1}?userId=ada`)).status, 200)
		assert.deepEqual(await stored(), [])
	})
})
