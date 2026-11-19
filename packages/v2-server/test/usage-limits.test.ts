// How long a subscription's usage limit is left alone, as v1 settled it: until the reset its error gives, or a growing backoff when it gives none.
import { describe, expect, it } from "vitest";
import { backoffMs, isUsageLimitError, limitCooldown, resetAtOf, type LimitState } from "../src/usage-limits.ts";
import { failureKind } from "../src/provider-failover.ts";

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
/** Noon UTC, so times of day before and after it are both tested. */
const NOW = Date.UTC(2026, 10, 10, 12, 0, 0);
const CODEX_LIMIT = "You have hit your ChatGPT usage limit (plus plan). Try again in ~42 min.";

describe("usage limit errors", () => {
	it("are told from other errors, and Pim's own daily limits are not the provider's", () => {
		for (const message of [CODEX_LIMIT, '{"error":{"type":"usage_limit_reached","message":"The usage limit has been reached","resets_in_seconds":259200}}', "429 You exceeded your current quota, please check your plan and billing details.", "OpenAI API error: rate_limit_exceeded", "subscription_sharing_usage_limit_exceeded\nCheck your ChatGPT usage", "Too Many Requests"]) expect(isUsageLimitError(message), message).toBe(true);
		for (const message of ["This model's maximum context length was exceeded: 210000 tokens", "Space usage quota exceeded: 100 model requests a day. It resets at midnight UTC.", "Invalid request: bad schema", "500 Internal server error", undefined]) expect(isUsageLimitError(message), message).toBe(false);
		// A plan that is used up moves the request on to the next model, like an overloaded one; Pim's own limit does not.
		const failed = (errorMessage: string) => ({ role: "assistant", content: [], stopReason: "error", errorMessage }) as never;
		expect(failureKind(failed("You've hit your usage limit. Upgrade or try again in 3 days."))).toBe("transient");
		expect(failureKind(failed("Space usage quota exceeded: 100 model requests a day. It resets at midnight UTC."))).toBeNull();
	});
});

describe("when a limit resets", () => {
	const at = (message: string) => resetAtOf(message, NOW);
	it("reads the provider's error, by its fields or its words", () => {
		expect(at(`{"error":{"type":"usage_limit_reached","resets_at":${(NOW + 2 * HOUR) / 1000}}}`)).toBe(NOW + 2 * HOUR);
		expect(at('{"error":{"type":"usage_limit_reached","resets_in_seconds":259200}}')).toBe(NOW + 72 * HOUR);
		expect(at(CODEX_LIMIT)).toBe(NOW + 42 * MINUTE);
		expect(at("Limit reached. Please try again in 1h 30m.")).toBe(NOW + 90 * MINUTE);
		expect(at("Rate limit reached for requests. Please try again in 6m0s.")).toBe(NOW + 6 * MINUTE);
		expect(at("You've hit your usage limit. Upgrade to Pro or try again in 3 days.")).toBe(NOW + 72 * HOUR);
		expect(at("Server requested 10800s retry delay (max: 60s)")).toBe(NOW + 3 * HOUR);
		expect(at("You've hit your usage limit. Try again at Nov 11, 2026 3:00 PM UTC.")).toBe(Date.UTC(2026, 10, 11, 15));
		expect(at("Usage limit reached, try again at 2026-11-10T20:00:00Z.")).toBe(Date.UTC(2026, 10, 10, 20));
		// A bare time of day is read as UTC, the next time it comes: later today, or tomorrow once it has passed.
		expect(at("You've hit your usage limit. Try again at 5:32 PM.")).toBe(Date.UTC(2026, 10, 10, 17, 32));
		expect(at("You've hit your usage limit, try again at 9:00 AM, or upgrade.")).toBe(Date.UTC(2026, 10, 11, 9));
		expect(at("Usage limit reached. Try again later.")).toBeUndefined();
		expect(at("429 Too Many Requests")).toBeUndefined();
	});

	it("is kept between a moment and a week from now", () => {
		expect(at(`{"resets_at":${(NOW - HOUR) / 1000}}`)).toBe(NOW + 1000);
		expect(at("try again in 30 days")).toBe(NOW + 7 * 24 * HOUR);
	});
});

describe("a plan's cooldown", () => {
	it("backs off from five minutes to six hours, limit after limit", () => {
		expect([1, 2, 3, 4, 5, 6, 50].map(backoffMs)).toEqual([5 * MINUTE, 15 * MINUTE, HOUR, 3 * HOUR, 6 * HOUR, 6 * HOUR, 6 * HOUR]);
		let state: LimitState | undefined;
		let now = NOW;
		const waits: number[] = [];
		for (let limit = 0; limit < 4; limit++) {
			state = limitCooldown(state, "usage limit reached", now);
			waits.push(state.until - now);
			now = state.until;
		}
		expect(waits).toEqual([5 * MINUTE, 15 * MINUTE, HOUR, 3 * HOUR]);
	});

	it("counts limits found together once, is made longer only when the error says so, and decays", () => {
		const first = limitCooldown(undefined, "Bad gateway: too many requests", NOW);
		expect(first).toEqual({ until: NOW + 5 * MINUTE, failures: 1 });
		expect(limitCooldown(first, "usage limit reached", NOW + 1000)).toBe(first);
		expect(limitCooldown(first, CODEX_LIMIT, NOW + 2000)).toEqual({ until: NOW + 2000 + 42 * MINUTE, failures: 1 });
		// A limit hours after the last cooldown ended starts over.
		expect(limitCooldown(first, "usage limit reached", first.until + 7 * HOUR)).toMatchObject({ failures: 1 });
		expect(limitCooldown(first, "usage limit reached", first.until + HOUR)).toMatchObject({ failures: 2 });
	});
});
