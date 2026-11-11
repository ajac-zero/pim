// The memory guard: whether the host can take one more display. Pure, so the table of cases in
// test/memory.test.js is the whole policy. The host also runs sandbox-manager and has no swap, so
// a display that tips it into the OOM killer would take coding sessions down with it.
const GiB = 1024 ** 3

export const EXPECTED_DISPLAY_BYTES = 1.5 * GiB // Chrome plus the X server and window manager
export const RESERVE_BYTES = 3 * GiB // what must stay available for sandbox-manager and the OS
export const MAX_DISPLAYS = 6

// activeDisplays counts every display that holds memory: starting, active, idle and reaping.
// Returns {allow, reason, headroomBytes}; headroomBytes is what would remain above the reserve
// after the new display's expected cost, and is negative when it would not fit.
export function memoryGuard({
	memAvailableBytes,
	memTotalBytes,
	activeDisplays,
	maxDisplays = MAX_DISPLAYS,
	expectedDisplayBytes = EXPECTED_DISPLAY_BYTES,
	reserveBytes = RESERVE_BYTES,
}) {
	if (!Number.isFinite(memAvailableBytes) || memAvailableBytes < 0) return { allow: false, reason: 'memory unknown', headroomBytes: null }
	// MemAvailable cannot exceed MemTotal; a reading that does is not to be trusted.
	if (Number.isFinite(memTotalBytes) && memAvailableBytes > memTotalBytes) return { allow: false, reason: 'memory reading inconsistent', headroomBytes: null }
	const headroomBytes = memAvailableBytes - expectedDisplayBytes - reserveBytes
	if (activeDisplays >= maxDisplays) return { allow: false, reason: `at the maximum of ${maxDisplays} displays`, headroomBytes }
	if (headroomBytes < 0) return { allow: false, reason: 'not enough available memory', headroomBytes }
	return { allow: true, reason: 'ok', headroomBytes }
}

// Parses /proc/meminfo text into bytes.
export function parseMeminfo(text) {
	const kib = (key) => {
		const m = text.match(new RegExp(`^${key}:\\s+(\\d+)\\s*kB`, 'm'))
		return m ? Number(m[1]) * 1024 : NaN
	}
	return { memAvailableBytes: kib('MemAvailable'), memTotalBytes: kib('MemTotal') }
}
