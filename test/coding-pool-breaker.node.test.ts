import { describe, expect, it } from "vitest";
import { closedPool, POOL_COOLDOWN_MS, POOL_FAILURE_THRESHOLD, poolAvailable, poolResult, reservePool } from "../src/coding/pool-breaker";

describe("a pool's circuit breaker", () => {
	it("counts consecutive failures, not capacity refusals, and resets on success", () => {
		let state = closedPool();
		state = poolResult(state, "a", "failure", 0);
		state = poolResult(state, "b", "ignored", 1);
		expect(state.failures).toBe(1);
		state = poolResult(state, "c", "success", 2);
		expect(state).toEqual(closedPool());
		for (let i = 0; i < POOL_FAILURE_THRESHOLD; i++) state = poolResult(state, "a", "failure", 10);
		expect(poolAvailable(state, 10 + POOL_COOLDOWN_MS - 1)).toBe(false);
		expect(poolAvailable(state, 10 + POOL_COOLDOWN_MS)).toBe(true);
	});

	it("allows one half-open probe, reopens on failure and closes on success", () => {
		let now = 100;
		let state = closedPool();
		for (let i = 0; i < POOL_FAILURE_THRESHOLD; i++) state = poolResult(state, "a", "failure", now);
		expect(poolResult(state, "late", "success", now)).toEqual(state);
		now += POOL_COOLDOWN_MS;
		state = reservePool(state, "probe");
		expect(poolAvailable(state, now)).toBe(false);
		expect(poolResult(state, "late", "failure", now)).toEqual(state);
		state = poolResult(state, "probe", "failure", now);
		expect(poolAvailable(state, now)).toBe(false);
		now += POOL_COOLDOWN_MS;
		state = reservePool(state, "next");
		state = poolResult(state, "next", "success", now);
		expect(state).toEqual(closedPool());
	});

	it("releases a cancelled or refused probe without counting a failure", () => {
		const state = { failures: 3, retryAt: 0, probe: "probe" };
		expect(poolResult(state, "probe", "ignored", 42)).toEqual({ failures: 3, retryAt: 42 + POOL_COOLDOWN_MS, probe: null });
	});
});
