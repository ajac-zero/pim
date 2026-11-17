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

async function start(opts) {
	h = await setup(opts)
	const dir = path.join(h.tmp, 'compose')
	mkdirSync(dir)
	writeFileSync(path.join(dir, '.env'), 'PIM_IMAGE=pim:test\nPOSTGRES_PASSWORD="db-password-value-123"\n')
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

	test('deploys a commit by building the Pim image under its name and bringing the stack up healthy', async () => {
		const d = await start()
		const r = await op(d, 'deploy', { ref: h.repo.c3 })
		assert.equal(r.state, 'succeeded', r.summary)
		assert.equal(h.head(), h.repo.c3)
		const build = ran('docker', (a) => a[0] === 'build')[0]
		assert.deepEqual(build.args, ['build', '-f', 'deploy/Dockerfile.v2', '-t', 'pim:test', '.'])
		assert.equal(build.cwd, await import('node:fs').then((fs) => fs.realpathSync(h.repo.checkout)))
		const up = ran('pimsh', (a) => a[0] === 'up')[0]
		assert.deepEqual(up.args.slice(0, 3), ['up', '-d', '--wait'])
		assert.equal(r.data.health.services[0].service, 'gate')
		assert.match(r.summary, /Deployed/)
		// Nothing of the daemon's or the stack's credentials goes to the commands it runs, but the .env the stack reads stays where compose finds it.
		assert.ok(!up.env.includes('HOSTOPS_TOKEN'))
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
