// hostopsd looking after the Pim stack on Docker Compose (HOSTOPSD_STACK=compose): the same allowlist and results, with `docker build` and deploy/compose/pim.sh in place of the sandbox manager's up.sh.
import assert from 'node:assert/strict'
import { chmodSync, mkdirSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { afterEach, describe, test } from 'node:test'
import { fileURLToPath } from 'node:url'
import { createDaemon, loadConfig } from '../hostopsd.js'
import { COMPOSE_SERVICES, validateOp } from '../validate.js'
import { setup } from '../support/harness.js'

const FAKES = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'support', 'fakes.js')
let h
let nextId = 0
afterEach(() => h?.close())

async function start(opts, env = 'PIM_IMAGE=pim:test\nPIM_WEB_IMAGE=pim-web:test\n') {
	h = await setup(opts)
	const dir = path.join(h.tmp, 'compose')
	mkdirSync(dir)
	writeFileSync(path.join(dir, '.env'), `${env}POSTGRES_PASSWORD="db-password-value-123"\n`)
	writeFileSync(path.join(dir, 'pim.sh'), `#!/bin/sh\nexec "${process.execPath}" "${FAKES}" pimsh "${path.join(h.tmp, 'fake')}" "$@"\n`)
	chmodSync(path.join(dir, 'pim.sh'), 0o755)
	const d = createDaemon(loadConfig({ ...h.env, HOSTOPSD_STACK: 'compose', PIM_COMPOSE_DIR: dir, MANAGER_ENV_FILE: path.join(h.tmp, 'no-manager-env') }), { log: () => {} })
	await d.start()
	return d
}
async function op(d, name, args) {
	const id = `op-${++nextId}`
	h.pim.ops.push({ id, name, args, deadlineMs: Date.now() + 600000 })
	await d.step()
	await d.step()
	const r = h.pim.results.at(-1)
	assert.equal(r.id, id)
	return r
}
const ran = (tool, pred = () => true) => h.calls().filter((c) => c.tool === tool && pred(c.args))

describe('the stack on Docker Compose', () => {
	test('allows the stack services and refuses the sandbox manager stack ones', () => {
		assert.equal(validateOp({ id: 'a', name: 'restart', args: { service: 'gate' } }, COMPOSE_SERVICES).error, undefined)
		assert.match(validateOp({ id: 'a', name: 'restart', args: { service: 'egress-proxy' } }, COMPOSE_SERVICES).error, /must be one of/)
		assert.match(validateOp({ id: 'a', name: 'restart', args: { service: 'gate; id' } }, COMPOSE_SERVICES).error, /must be one of/)
		assert.equal(validateOp({ id: 'a', name: 'restart', args: { service: 'egress-proxy' } }).error, undefined)
	})

	test('deploys a commit by building the backend and the web images under their names and bringing the stack up healthy', async () => {
		const d = await start()
		const r = await op(d, 'deploy', { ref: h.repo.c3 })
		assert.equal(r.state, 'succeeded', r.summary)
		assert.equal(h.head(), h.repo.c3)
		const builds = ran('docker', (a) => a[0] === 'build')
		const build = builds[0]
		assert.deepEqual(build.args, ['build', '-f', 'deploy/Dockerfile.v2', '--build-arg', `PIM_REVISION=${h.repo.c3}`, '-t', 'pim:test', '.'])
		// The interface is built from the same commit, so a deploy never leaves the backend running without its web app or with another commit's.
		assert.deepEqual(builds.map((b) => b.args.slice(0, 3)), [['build', '-f', 'deploy/Dockerfile.v2'], ['build', '-f', 'deploy/Dockerfile.web']])
		assert.deepEqual(builds[1].args, ['build', '-f', 'deploy/Dockerfile.web', '--build-arg', `PIM_REVISION=${h.repo.c3}`, '-t', 'pim-web:test', '.'])
		assert.equal(build.cwd, await import('node:fs').then((fs) => fs.realpathSync(h.repo.checkout)))
		const up = ran('pimsh', (a) => a[0] === 'up')[0]
		assert.deepEqual(up.args.slice(0, 3), ['up', '-d', '--wait'])
		assert.equal(r.data.health.services[0].service, 'gate')
		assert.match(r.summary, /Deployed/)
		// Nothing of the daemon's or the stack's credentials goes to the commands it runs, but the .env the stack reads stays where compose finds it.
		assert.ok(!up.env.includes('HOSTOPS_TOKEN'))
	})

	test('updates through pim.sh and reports its result line, whatever else it printed', async () => {
		const d = await start()
		h.setFake({ update: { from: 'sha256:aaa', to: 'sha256:bbb', result: 'updated' } })
		const r = await op(d, 'update', { tag: 'edge' })
		assert.equal(r.state, 'succeeded', r.summary)
		assert.deepEqual(ran('pimsh', (a) => a[0] === 'update')[0].args, ['update', 'edge'])
		assert.deepEqual(r.data, { from: 'sha256:aaa', to: 'sha256:bbb', result: 'updated' })
		h.setFake({ update: { from: 'sha256:bbb', to: 'sha256:bbb', result: 'unchanged' } })
		const same = await op(d, 'update', {})
		assert.equal(same.state, 'succeeded')
		assert.deepEqual(ran('pimsh', (a) => a[0] === 'update').at(-1).args, ['update'])
		assert.match(same.summary, /up to date/)
		h.setFake({ update: { from: 'sha256:bbb', to: 'sha256:ccc', result: 'rolled_back' } })
		const back = await op(d, 'update', {})
		assert.equal(back.state, 'rolled_back')
		assert.equal(back.data.result, 'rolled_back')
		h.setFake({ update: null })
		const none = await op(d, 'update', {})
		assert.equal(none.state, 'failed')
	})

	test('refuses an update tag that is not an image tag', () => {
		assert.equal(validateOp({ id: 'a', name: 'update', args: {} }, COMPOSE_SERVICES).error, undefined)
		assert.equal(validateOp({ id: 'a', name: 'update', args: { tag: 'sha-0123456789ab' } }, COMPOSE_SERVICES).error, undefined)
		for (const tag of ['--force', '-x', 'a b', 'a;id', '', 7]) assert.match(validateOp({ id: 'a', name: 'update', args: { tag } }, COMPOSE_SERVICES).error, /tag must be/)
	})

	test('goes back to the commit it came from when the new one does not come up healthy', async () => {
		const d = await start()
		h.setFake({ upFail: [h.short(h.repo.c3)] })
		const r = await op(d, 'deploy', { ref: h.repo.c3 })
		assert.equal(r.state, 'rolled_back', r.summary)
		assert.match(r.summary, /unhealthy/)
		assert.equal(h.head(), h.repo.c2)
		assert.equal(h.deployed(), h.short(h.repo.c2))
	})

	test('goes back to the previous commit when the image does not build', async () => {
		const d = await start()
		h.setFake({ buildFail: [h.short(h.repo.c3)] })
		const r = await op(d, 'deploy', { ref: h.repo.c3 })
		assert.equal(r.state, 'rolled_back')
		assert.equal(ran('pimsh', (a) => a[0] === 'up').length, 1)
	})

	test('goes back to the previous commit when the web app does not build, so the backend is never left without its interface', async () => {
		const d = await start()
		h.setFake({ webBuildFail: [h.short(h.repo.c3)] })
		const r = await op(d, 'deploy', { ref: h.repo.c3 })
		assert.equal(r.state, 'rolled_back', r.summary)
		assert.equal(h.head(), h.repo.c2)
		// The stack was brought up once, for the commit it went back to: nothing started on the commit whose interface did not build.
		assert.equal(ran('pimsh', (a) => a[0] === 'up').length, 1)
	})

	test('refuses a deploy that could not build the web app with the backend: PIM_WEB_IMAGE missing, or a pulled digest', async () => {
		for (const env of ['PIM_IMAGE=pim:test\n', 'PIM_IMAGE=pim:test\nPIM_WEB_IMAGE=ghcr.io/ajac-zero/pim-web:stable@sha256:abc\n']) {
			const d = await start(undefined, env)
			const r = await op(d, 'deploy', { ref: h.repo.c3 })
			assert.notEqual(r.state, 'succeeded')
			assert.match(r.summary, /PIM_WEB_IMAGE/)
			assert.equal(ran('docker', (a) => a[0] === 'build').length, 0)
			assert.equal(ran('pimsh', (a) => a[0] === 'up').length, 0)
			h.close()
		}
	})

	test('restarts and reads the logs of a service through the stack, redacting its secrets', async () => {
		const d = await start()
		const restarted = await op(d, 'restart', { service: 'gate' })
		assert.equal(restarted.state, 'succeeded', restarted.summary)
		assert.deepEqual(ran('pimsh', (a) => a[0] === 'restart')[0].args, ['restart', 'gate'])
		h.setFake({ logsText: 'gate | listening\ngate | password=db-password-value-123 and POSTGRES_PASSWORD db-password-value-123\n' })
		const logs = await op(d, 'logs', { service: 'runner', lines: 20 })
		assert.equal(logs.state, 'succeeded')
		assert.deepEqual(ran('pimsh', (a) => a[0] === 'logs')[0].args, ['logs', '--no-color', '--tail', '20', 'runner'])
		assert.match(logs.data.text, /listening/)
		assert.ok(!logs.data.text.includes('db-password-value-123'))
		const refused = await op(d, 'restart', { service: 'egress-proxy' })
		assert.equal(refused.state, 'failed')
		assert.match(refused.summary, /Refused/)
	})

	test('reads the stats, with the stack services and no sandbox manager where there is none', async () => {
		const d = await start()
		const r = await op(d, 'stats', {})
		assert.equal(r.state, 'succeeded', r.summary)
		assert.equal(r.data.manager, null)
		assert.deepEqual(r.data.compose.map((c) => c.service), ['gate', 'runner'])
		assert.equal(r.data.errors?.manager, undefined)
	})

	test('runs a command as the daemon user with none of the stack credentials, and does not need the stack .env to', async () => {
		const d = await start()
		const r = await op(d, 'exec', { command: 'env | cut -d= -f1 | sort | tr "\\n" " "' })
		assert.equal(r.state, 'succeeded')
		assert.ok(!/POSTGRES|HOSTOPS|PIM_/.test(r.data.output), r.data.output)
	})
})
