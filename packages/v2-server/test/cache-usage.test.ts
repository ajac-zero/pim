import { describe, expect, it } from "vitest";
import { cacheHitRatio, MAX_TURN_HISTORY, turnHistory } from "../src/compat/cache-usage.ts";

describe("cacheHitRatio", () => {
	it("is the cache-read share of all input: uncached, read and written", () => {
		expect(cacheHitRatio({ input: 100, cacheRead: 800, cacheWrite: 100 })).toBeCloseTo(0.8, 9);
		expect(cacheHitRatio({ input: 300, cacheRead: 100, cacheWrite: 0 })).toBeCloseTo(0.25, 9);
	});
	it("is a real 0 for a call that wrote the cache but read none", () => {
		expect(cacheHitRatio({ input: 50, cacheRead: 0, cacheWrite: 950 })).toBe(0);
	});
	it("is unknown, not 0, with no input or with no cache tokens at all", () => {
		expect(cacheHitRatio({ input: 0, cacheRead: 0, cacheWrite: 0 })).toBeNull();
		expect(cacheHitRatio({ input: 1000, cacheRead: 0, cacheWrite: 0 })).toBeNull();
	});
});

describe("turnHistory", () => {
	const row = (id: string, at: string, extra: Record<string, unknown> = {}) => ({ id, at, model: "m", input_tokens: 10, output_tokens: 5, cache_read_tokens: 0, cache_write_tokens: 0, cost_microusd: 2_500, ...extra });

	it("lists calls newest first with the tiers, the hit rate and the cost in dollars", () => {
		const turns = turnHistory([
			row("old", "2026-01-01T00:00:00Z", { input_tokens: 100, cache_read_tokens: 300, cache_write_tokens: 100, output_tokens: 7, cost_microusd: 1_000_000 }),
			row("new", "2026-01-02T00:00:00Z"),
		]);
		expect(turns.map((t) => t.id)).toEqual(["new", "old"]);
		expect(turns[1]).toEqual({ id: "old", at: "2026-01-01T00:00:00.000Z", model: "m", input: 100, cacheRead: 300, cacheWrite: 100, output: 7, hitRatio: 0.6, cost: 1 });
		expect(turns[0]).toMatchObject({ input: 10, output: 5, hitRatio: null, cost: 0.0025 });
	});

	it("treats missing or null cache fields as zero and drops calls that used no tokens", () => {
		const turns = turnHistory([
			{ id: "a", at: new Date("2026-01-03T00:00:00Z"), input_tokens: "12", output_tokens: 3 },
			row("b", "2026-01-02T00:00:00Z", { cache_read_tokens: null, cache_write_tokens: null, cost_microusd: null }),
			row("failed", "2026-01-04T00:00:00Z", { input_tokens: 0, output_tokens: 0 }),
		]);
		expect(turns.map((t) => t.id)).toEqual(["a", "b"]);
		expect(turns[0]).toMatchObject({ input: 12, cacheRead: 0, cacheWrite: 0, hitRatio: null, cost: 0 });
		expect(turns[1]).toMatchObject({ cacheRead: 0, cacheWrite: 0, hitRatio: null, cost: 0 });
	});

	it("keeps only the newest MAX_TURN_HISTORY calls", () => {
		const rows = Array.from({ length: MAX_TURN_HISTORY + 5 }, (_, i) => row(`c${i}`, new Date(Date.UTC(2026, 0, 1, 0, i)).toISOString()));
		const turns = turnHistory(rows);
		expect(turns).toHaveLength(MAX_TURN_HISTORY);
		expect(turns[0]!.id).toBe(`c${MAX_TURN_HISTORY + 4}`);
		expect(turns.at(-1)!.id).toBe("c5");
	});
});
