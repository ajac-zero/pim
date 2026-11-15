/** Consecutive infrastructure failures before a pool stops admitting threads. */
export const POOL_FAILURE_THRESHOLD = 3;
/** How long an unhealthy pool waits before admitting one probe. */
export const POOL_COOLDOWN_MS = 5 * 60_000;

/** Kept by the scheduler, including the thread that owns a half-open probe. */
export type PoolBreaker = { failures: number; retryAt: number | null; probe: string | null };
export const closedPool = (): PoolBreaker => ({ failures: 0, retryAt: null, probe: null });

/** Whether admission may reserve a slot now; the caller supplies its clock. */
export function poolAvailable(state: PoolBreaker, now: number): boolean {
	return state.retryAt === null || (state.probe === null && now >= state.retryAt);
}

/** Reserves the sole half-open attempt, in the same transaction as its slot. */
export function reservePool(state: PoolBreaker, thread: string): PoolBreaker {
	return state.retryAt === null ? state : { ...state, probe: thread };
}

/** An ignored result (capacity, cancellation or quota) never counts as a failure. */
export function poolResult(state: PoolBreaker, thread: string, result: "success" | "failure" | "ignored", now: number): PoolBreaker {
	// Results from attempts admitted before the pool opened cannot close it or steal its probe.
	if (state.retryAt !== null && state.probe !== thread) return state;
	if (result === "success") return closedPool();
	if (result === "ignored" && state.probe === null) return state;
	const failures = state.failures + (result === "failure" ? 1 : 0);
	if (state.retryAt !== null || failures >= POOL_FAILURE_THRESHOLD) return { failures, retryAt: now + POOL_COOLDOWN_MS, probe: null };
	return { failures, retryAt: null, probe: null };
}
