import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { test } from 'node:test'
import { loadSites, parseSites } from '../src/sites.js'

test('a missing sites file is created with LinkedIn limited to one display', () => {
	const dir = mkdtempSync(path.join(tmpdir(), 'displayd-'))
	try {
		const file = path.join(dir, 'state', 'sites.json')
		assert.deepEqual(loadSites(file), { 'linkedin.com': { max: 1, domains: ['linkedin.com', 'licdn.com'] } })
		assert.ok(existsSync(file))
		// an edit is read on the next start, and domains default to the site
		writeFileSync(file, JSON.stringify({ 'bank.example': { max: 2 } }))
		assert.deepEqual(loadSites(file), { 'bank.example': { max: 2, domains: ['bank.example'] } })
		assert.match(readFileSync(file, 'utf8'), /bank/)
	} finally {
		rmSync(dir, { recursive: true, force: true })
	}
})

test('a bad entry is refused', () => {
	assert.throws(() => parseSites({ x: { max: 0 } }), /max/)
	assert.throws(() => parseSites({ x: { max: 1, domains: 'x.com' } }), /domains/)
	assert.throws(() => parseSites([]), /object/)
})
