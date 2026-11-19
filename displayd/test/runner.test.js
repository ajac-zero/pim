import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { test } from 'node:test'
import { RealRunner, SUPERVISOR } from '../src/runner.js'

const runner = (driver) => {
	const root = mkdtempSync(path.join(tmpdir(), 'displayd-'))
	return new RealRunner({ root, env: { PATH: process.env.PATH, HOME: root, DISPLAYD_DRIVER_BIN: driver } })
}

test('the display supervisor is valid shell, and starts the driver only where the computer has one', () => {
	assert.equal(spawnSync('bash', ['-n', '-c', SUPERVISOR]).status, 0)
	assert.match(SUPERVISOR, /if \[ -x "\$PIM_DRIVER_BIN" \]; then\n\t"\$PIM_DRIVER_BIN" serve/)
})

test('a computer without Cua\'s driver has healthy displays: nothing is waited for on the driver\'s port', async () => {
	const none = runner('/nonexistent/cua-env-driver')
	assert.equal(none.hasDriver(), false)
	// No driver is listening on 59999, and none is wanted.
	assert.equal(await none.probeDriver({ driverPort: 59999 }), true)
})

test('where the driver is installed its port must answer', async () => {
	const dir = mkdtempSync(path.join(tmpdir(), 'driver-'))
	const bin = path.join(dir, 'cua-env-driver')
	writeFileSync(bin, '#!/bin/sh\n', { mode: 0o755 })
	const have = runner(bin)
	assert.equal(have.hasDriver(), true)
	assert.equal(await have.probeDriver({ driverPort: 59999 }), false)
})
