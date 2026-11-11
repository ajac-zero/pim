import assert from 'node:assert/strict'
import { test } from 'node:test'
import { memoryGuard, parseMeminfo, reserveBytesFor } from '../src/memory.js'

const GiB = 1024 ** 3
const TOTAL = 15.6 * GiB

const SMALL = 3.9 * GiB // the agent computer: 4 GiB swap, reserve about 0.585 GiB, hard maximum 2
// [name, total, available, active, swapTotal, swapFree, allow]
const table = [
	['3.9 GiB computer, 2.7 GiB available, none running', SMALL, 2.7 * GiB, 0, 4 * GiB, 4 * GiB, true],
	['3.9 GiB computer, one running, still fits', SMALL, 2.7 * GiB, 1, 4 * GiB, 4 * GiB, true],
	['3.9 GiB computer, hard maximum of 2 reached', SMALL, 2.7 * GiB, 2, 4 * GiB, 4 * GiB, false],
	['3.9 GiB computer, too little memory available', SMALL, 1.5 * GiB, 0, 4 * GiB, 4 * GiB, false],
	['low free swap refuses', SMALL, 2.7 * GiB, 0, 4 * GiB, 1 * GiB - 1, false],
	['swap free at exactly 1 GiB is enough', SMALL, 2.7 * GiB, 0, 4 * GiB, 1 * GiB, true],
	['no swap at all is not a refusal', SMALL, 2.7 * GiB, 0, 0, 0, true],
	['15.6 GiB, 10 GiB available, none running', 15.6 * GiB, 10 * GiB, 0, 0, 0, true],
	['15.6 GiB, sixth display taken', 15.6 * GiB, 10 * GiB, 5, 0, 0, true],
	['15.6 GiB, hard maximum of 6', 15.6 * GiB, 14 * GiB, 6, 0, 0, false],
	['15.6 GiB, just under reserve 2.34 + cost 1', 15.6 * GiB, 3.34 * GiB - 1, 0, 0, 0, false],
	['no memory at all', 15.6 * GiB, 0, 0, 0, 0, false],
]
for (const [name, total, avail, active, swapTotal, swapFree, allow] of table)
	test(`memoryGuard: ${name}`, () => {
		const r = memoryGuard({ memAvailableBytes: avail, memTotalBytes: total, swapTotalBytes: swapTotal, swapFreeBytes: swapFree, activeDisplays: active })
		assert.equal(r.allow, allow, r.reason)
		assert.equal(r.headroomBytes, avail - 1 * GiB - reserveBytesFor(total))
	})

test('reserveBytesFor clamps 15% of MemTotal to 0.5-3 GiB', () => {
	assert.equal(reserveBytesFor(1 * GiB), 0.5 * GiB)
	assert.ok(Math.abs(reserveBytesFor(3.9 * GiB) - 0.585 * GiB) < 1)
	assert.ok(Math.abs(reserveBytesFor(15.6 * GiB) - 2.34 * GiB) < 1)
	assert.equal(reserveBytesFor(64 * GiB), 3 * GiB)
})

test('memoryGuard: refuses a reading it cannot trust', () => {
	assert.equal(memoryGuard({ memAvailableBytes: NaN, memTotalBytes: TOTAL, activeDisplays: 0 }).allow, false)
	assert.equal(memoryGuard({ memAvailableBytes: TOTAL + 1, memTotalBytes: TOTAL, activeDisplays: 0 }).allow, false)
})

test('memoryGuard: the maximum can be lowered', () => {
	assert.equal(memoryGuard({ memAvailableBytes: 14 * GiB, memTotalBytes: TOTAL, activeDisplays: 2, maxDisplays: 2 }).allow, false)
})

test('parseMeminfo reads memory and swap in bytes', () => {
	const r = parseMeminfo('MemTotal:       16357196 kB\nMemFree:         1000 kB\nMemAvailable:   10590000 kB\nSwapTotal:      4194300 kB\nSwapFree:       4000000 kB\n')
	assert.deepEqual(r, { memAvailableBytes: 10590000 * 1024, memTotalBytes: 16357196 * 1024, swapTotalBytes: 4194300 * 1024, swapFreeBytes: 4000000 * 1024 })
	assert.equal(parseMeminfo('MemTotal: 1 kB\nMemAvailable: 1 kB\n').swapTotalBytes, 0)
})
