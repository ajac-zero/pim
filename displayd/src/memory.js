// The memory guard: whether the computer displayd runs in can take one more display. Pure, so the
// table of cases in test/memory.test.js is the whole policy. displayd shares the agent computer
// with its primary display and browser, so the guard scales with the machine and counts swap.
const GiB = 1024 ** 3

export const EXPECTED_DISPLAY_BYTES = 1 * GiB // Xvnc, openbox and dbus (0.8 GiB) plus a browser (0.4 GiB)
export const MIN_SWAP_FREE_BYTES = 1 * GiB // swap that must be free when the machine has any
export const MAX_DISPLAYS = 6
const SLOT_BYTES = EXPECTED_DISPLAY_BYTES + 0.5 * GiB // what each display in the hard maximum is budgeted

// What must stay available for the computer's own processes: 15% of MemTotal, between 0.5 and 3 GiB.
export function reserveBytesFor(memTotalBytes) {
	return Math.min(3 * GiB, Math.max(0.5 * GiB, 0.15 * memTotalBytes))
}

// activeDisplays counts every display that holds memory: starting, active, idle and reaping.
// Returns {allow, reason, headroomBytes}; headroomBytes is what would remain above the reserve
// after the new display's expected cost, and is negative when it would not fit.
// maxDisplays, expectedDisplayBytes and reserveBytes are optional tuning; the defaults come from memTotalBytes.
export function memoryGuard({
	memAvailableBytes,
	memTotalBytes,
	swapTotalBytes = 0,
	swapFreeBytes = 0,
	activeDisplays,
	maxDisplays = MAX_DISPLAYS,
	expectedDisplayBytes = EXPECTED_DISPLAY_BYTES,
	reserveBytes = reserveBytesFor(memTotalBytes),
}) {
	if (!Number.isFinite(memAvailableBytes) || memAvailableBytes < 0) return { allow: false, reason: 'memory unknown', headroomBytes: null }
	if (!Number.isFinite(memTotalBytes)) return { allow: false, reason: 'memory unknown', headroomBytes: null }
	// MemAvailable cannot exceed MemTotal; a reading that does is not to be trusted.
	if (memAvailableBytes > memTotalBytes) return { allow: false, reason: 'memory reading inconsistent', headroomBytes: null }
	const headroomBytes = memAvailableBytes - expectedDisplayBytes - reserveBytes
	const max = Math.min(maxDisplays, Math.floor((memTotalBytes - reserveBytes) / SLOT_BYTES))
	if (activeDisplays >= max) return { allow: false, reason: `at the maximum of ${max} displays`, headroomBytes }
	if (headroomBytes < 0) return { allow: false, reason: 'not enough available memory', headroomBytes }
	if (swapTotalBytes > 0 && !(swapFreeBytes >= MIN_SWAP_FREE_BYTES)) return { allow: false, reason: 'not enough free swap', headroomBytes }
	return { allow: true, reason: 'ok', headroomBytes }
}

// Parses /proc/meminfo text into bytes.
export function parseMeminfo(text) {
	const kib = (key) => {
		const m = text.match(new RegExp(`^${key}:\\s+(\\d+)\\s*kB`, 'm'))
		return m ? Number(m[1]) * 1024 : NaN
	}
	// A machine without swap has no SwapTotal line, or a zero one.
	const swap = (key) => (Number.isFinite(kib(key)) ? kib(key) : 0)
	return { memAvailableBytes: kib('MemAvailable'), memTotalBytes: kib('MemTotal'), swapTotalBytes: swap('SwapTotal'), swapFreeBytes: swap('SwapFree') }
}
