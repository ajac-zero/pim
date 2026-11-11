import assert from 'node:assert/strict'
import { test } from 'node:test'
import { memoryGuard, parseMeminfo } from '../src/memory.js'

const GiB = 1024 ** 3
const TOTAL = 15.6 * GiB

// The threshold is MemAvailable - 1.5 GiB >= 3 GiB, so 4.5 GiB available is exactly enough.
const table = [
	['the measured host (10.1 GiB available), none running', 10.1 * GiB, 0, true],
	['exactly at the threshold', 4.5 * GiB, 2, true],
	['one byte under the threshold', 4.5 * GiB - 1, 2, false],
	['plenty of memory but the sixth display is taken', 14 * GiB, 5, true],
	['plenty of memory at the maximum', 14 * GiB, 6, false],
	['little memory, none running', 3 * GiB, 0, false],
	['no memory at all', 0, 0, false],
]
for (const [name, avail, active, allow] of table)
	test(`memoryGuard: ${name}`, () => {
		const r = memoryGuard({ memAvailableBytes: avail, memTotalBytes: TOTAL, activeDisplays: active })
		assert.equal(r.allow, allow, r.reason)
		assert.equal(r.headroomBytes, avail - 4.5 * GiB)
	})

test('memoryGuard: refuses a reading it cannot trust', () => {
	assert.equal(memoryGuard({ memAvailableBytes: NaN, memTotalBytes: TOTAL, activeDisplays: 0 }).allow, false)
	assert.equal(memoryGuard({ memAvailableBytes: TOTAL + 1, memTotalBytes: TOTAL, activeDisplays: 0 }).allow, false)
})

test('memoryGuard: the maximum can be lowered', () => {
	assert.equal(memoryGuard({ memAvailableBytes: 14 * GiB, memTotalBytes: TOTAL, activeDisplays: 2, maxDisplays: 2 }).allow, false)
})

test('parseMeminfo reads MemAvailable and MemTotal in bytes', () => {
	const r = parseMeminfo('MemTotal:       16357196 kB\nMemFree:         1000 kB\nMemAvailable:   10590000 kB\n')
	assert.deepEqual(r, { memAvailableBytes: 10590000 * 1024, memTotalBytes: 16357196 * 1024 })
})
