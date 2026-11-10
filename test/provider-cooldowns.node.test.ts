import { DatabaseSync } from "node:sqlite";
import { createModels } from "@earendil-works/pi-ai/models";
import { fauxAssistantMessage, fauxProvider } from "@earendil-works/pi-ai/providers/faux";
import { describe, expect, it } from "vitest";
import { backoffMs, failingOver, isUsageLimitError, ProviderCooldowns, resetAtOf } from "../src/provider-cooldowns";

/** A Durable Object's SQL API over node:sqlite, as much as the cooldowns use. */
function sqlStorage(db: DatabaseSync): SqlStorage {
	const exec = (query: string, ...bindings: unknown[]) => {
		const statement = db.prepare(query);
		const rows = statement.columns().length > 0 ? (statement.all(...(bindings as never[])) as Record<string, SqlStorageValue>[]) : (statement.run(...(bindings as never[])), []);
		return { toArray: () => rows, one: () => rows[0]! };
	};
	return { exec } as unknown as SqlStorage;
}

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
/** Noon UTC, so times of day before and after it are both tested. */
const NOW = Date.UTC(2026, 10, 10, 12, 0, 0);
const CODEX_LIMIT = "You have hit your ChatGPT usage limit (plus plan). Try again in ~42 min.";

describe("usage limit errors", () => {
	it("are told from other errors", () => {
		for (const message of [
			CODEX_LIMIT,
			'{"error":{"type":"usage_limit_reached","message":"The usage limit has been reached","resets_in_seconds":259200}}',
			"429 You exceeded your current quota, please check your plan and billing details.",
			"OpenAI API error: rate_limit_exceeded",
			"subscription_sharing_usage_limit_exceeded\nCheck your ChatGPT usage",
			"Too Many Requests",
		]) expect(isUsageLimitError(message), message).toBe(true);
		for (const message of [
			// An overflow is no limit of the plan's: only a compaction helps it.
			"This model's maximum context length was exceeded: 210000 tokens",
			// Pim's own daily limits are not the provider's.
			"Space usage quota exceeded: today's 100 model requests are used up. It resets at midnight UTC.",
			"Invalid request: bad schema",
			"500 Internal server error",
			undefined,
		]) expect(isUsageLimitError(message), message).toBe(false);
	});
});

describe("when a limit resets", () => {
	const at = (failure: Parameters<typeof resetAtOf>[0]) => resetAtOf(failure, NOW);

	it("reads the provider's headers, which come before its words", () => {
		expect(at({ headers: { "Retry-After": "120" }, message: "try again in 3 days" })).toBe(NOW + 120_000);
		expect(at({ headers: { "retry-after-ms": "1500" } })).toBe(NOW + 1500);
		expect(at({ headers: { "retry-after": "Tue, 10 Nov 2026 13:30:00 GMT" } })).toBe(NOW + 90 * MINUTE);
		// The window that is used up resets later than the one that isn't: its reset is the one that counts.
		expect(at({ headers: { "x-codex-primary-used-percent": "40", "x-codex-primary-reset-after-seconds": "600", "x-codex-secondary-used-percent": "100", "x-codex-secondary-reset-after-seconds": "86400" } })).toBe(NOW + 24 * HOUR);
		expect(at({ headers: { "x-codex-primary-used-percent": "100", "x-codex-primary-reset-at": String((NOW + HOUR) / 1000) } })).toBe(NOW + HOUR);
		expect(at({ headers: { "x-ratelimit-remaining-requests": "0", "x-ratelimit-reset-requests": "6m0s", "x-ratelimit-remaining-tokens": "5000", "x-ratelimit-reset-tokens": "1s" } })).toBe(NOW + 6 * MINUTE);
	});

	it("reads the provider's error, by its fields or its words", () => {
		expect(at({ message: `{"error":{"type":"usage_limit_reached","resets_at":${(NOW + 2 * HOUR) / 1000}}}` })).toBe(NOW + 2 * HOUR);
		expect(at({ message: '{"error":{"type":"usage_limit_reached","resets_in_seconds":259200}}' })).toBe(NOW + 72 * HOUR);
		expect(at({ message: CODEX_LIMIT })).toBe(NOW + 42 * MINUTE);
		expect(at({ message: "Limit reached. Please try again in 1h 30m." })).toBe(NOW + 90 * MINUTE);
		expect(at({ message: "Rate limit reached for requests. Please try again in 6m0s." })).toBe(NOW + 6 * MINUTE);
		expect(at({ message: "You've hit your usage limit. Upgrade to Pro or try again in 3 days." })).toBe(NOW + 72 * HOUR);
		expect(at({ message: "Server requested 10800s retry delay (max: 60s)" })).toBe(NOW + 3 * HOUR);
		expect(at({ message: "Usage limit reached, try again at 2026-11-10T20:00:00Z." })).toBe(Date.UTC(2026, 10, 10, 20));
		expect(at({ message: "You've hit your usage limit. Try again at Nov 11, 2026 3:00 PM UTC." })).toBe(Date.UTC(2026, 10, 11, 15));
		// A bare time of day is read as UTC, the next time it comes: later today, or tomorrow once it has passed.
		expect(at({ message: "You've hit your usage limit. Try again at 5:32 PM." })).toBe(Date.UTC(2026, 10, 10, 17, 32));
		expect(at({ message: "You've hit your usage limit, try again at 9:00 AM, or upgrade." })).toBe(Date.UTC(2026, 10, 11, 9));
		expect(at({ message: "Usage limit reached. Try again later." })).toBeUndefined();
		expect(at({ message: "429 Too Many Requests" })).toBeUndefined();
	});

	it("is kept between a moment and a week from now", () => {
		expect(at({ message: `{"resets_at":${(NOW - HOUR) / 1000}}` })).toBe(NOW + 1000);
		expect(at({ message: "try again in 30 days" })).toBe(NOW + 7 * 24 * HOUR);
	});
});

describe("a provider's cooldown", () => {
	const fresh = () => new ProviderCooldowns(sqlStorage(new DatabaseSync(":memory:")));

	it("backs off from five minutes to six hours, limit after limit", () => {
		expect([1, 2, 3, 4, 5, 6, 50].map(backoffMs)).toEqual([5 * MINUTE, 15 * MINUTE, HOUR, 3 * HOUR, 6 * HOUR, 6 * HOUR, 6 * HOUR]);
		const cooldowns = fresh();
		let now = NOW;
		const untils: number[] = [];
		for (let limit = 0; limit < 4; limit++) {
			const cooldown = cooldowns.failed("plan", { message: "usage limit reached" }, now)!;
			untils.push(cooldown.until - now);
			expect(cooldown).toMatchObject({ failures: limit + 1, resetFrom: "backoff", since: now });
			now = cooldown.until;
		}
		expect(untils).toEqual([5 * MINUTE, 15 * MINUTE, HOUR, 3 * HOUR]);
	});

	it("starts only on a usage limit, a 429 included, and counts limits found together once", () => {
		const cooldowns = fresh();
		expect(cooldowns.failed("plan", { message: "Invalid request: bad schema" }, NOW)).toBeUndefined();
		expect(cooldowns.active("plan", NOW)).toBeUndefined();
		const first = cooldowns.failed("plan", { message: "Bad gateway", status: 429 }, NOW)!;
		expect(first).toMatchObject({ provider: "plan", since: NOW, until: NOW + 5 * MINUTE, failures: 1, reason: "Bad gateway" });
		// Another request finds the limit a moment later: still one limit, made longer only when the provider says so.
		expect(cooldowns.failed("plan", { message: "usage limit reached" }, NOW + 1000)).toEqual(first);
		const longer = cooldowns.failed("plan", { message: CODEX_LIMIT }, NOW + 2000)!;
		expect(longer).toMatchObject({ since: NOW, until: NOW + 2000 + 42 * MINUTE, failures: 1, resetFrom: "provider" });
		expect(cooldowns.active("plan", NOW + 30 * MINUTE)).toEqual(longer);
		expect(cooldowns.active("plan", longer.until)).toBeUndefined();
		expect(cooldowns.active("other", NOW)).toBeUndefined();
	});

	it("is forgotten once the provider answers a request sent since it began, and its count decays", () => {
		const cooldowns = fresh();
		const cooldown = cooldowns.failed("plan", { message: "usage limit reached" }, NOW)!;
		// A request under way when the limit was found shows nothing.
		cooldowns.succeeded("plan", NOW - 1);
		expect(cooldowns.list()).toEqual([cooldown]);
		cooldowns.succeeded("plan", cooldown.until);
		expect(cooldowns.list()).toEqual([]);
		expect(cooldowns.failed("plan", { message: "usage limit reached" }, cooldown.until + 1)!.failures).toBe(1);

		// Without a request since, a limit long after the last one starts the count again.
		const later = cooldowns.failed("plan", { message: "usage limit reached" }, NOW + 10 * HOUR)!;
		expect(later.failures).toBe(1);
		expect(cooldowns.failed("plan", { message: "usage limit reached" }, later.until + 6 * HOUR + 1)!.failures).toBe(1);
	});

	it("outlasts a restart", () => {
		const sql = sqlStorage(new DatabaseSync(":memory:"));
		const cooldown = new ProviderCooldowns(sql).failed("plan", { message: CODEX_LIMIT }, NOW)!;
		expect(new ProviderCooldowns(sql).active("plan", NOW + MINUTE)).toEqual(cooldown);
	});
});

describe("failing over", () => {
	function setup(options: { fallback?: boolean } = {}) {
		const plan = fauxProvider({ provider: "plan", models: [{ id: "plan-model" }] });
		const fallback = fauxProvider({ provider: "default", models: [{ id: "default-model" }] });
		const models = createModels();
		models.setProvider(plan.provider);
		models.setProvider(fallback.provider);
		const clock = { now: NOW };
		const cooldowns = new ProviderCooldowns(sqlStorage(new DatabaseSync(":memory:")));
		const cooled: string[] = [];
		const routed = failingOver(models, {
			cooldowns,
			subscription: (provider) => provider === "plan",
			fallback: () => (options.fallback === false ? undefined : fallback.getModel()),
			cooled: (cooldown) => cooled.push(cooldown.provider),
			now: () => clock.now,
		});
		const ask = () => routed.completeSimple(plan.getModel(), { messages: [{ role: "user", content: "Hi", timestamp: 1 }] });
		return { plan, fallback, cooldowns, cooled, clock, ask };
	}
	const limit = fauxAssistantMessage([], { stopReason: "error", errorMessage: CODEX_LIMIT });

	it("answers from the default model at once when the plan finds its limit, and goes there directly until the limit resets", async () => {
		const { plan, fallback, cooldowns, cooled, clock, ask } = setup();
		plan.setResponses([limit]);
		fallback.setResponses([fauxAssistantMessage("From the default"), fauxAssistantMessage("Still the default")]);
		const first = await ask();
		expect(first).toMatchObject({ stopReason: "stop", provider: "default", content: [{ type: "text", text: "From the default" }] });
		expect(cooled).toEqual(["plan"]);
		expect(cooldowns.active("plan", clock.now)).toMatchObject({ until: NOW + 42 * MINUTE, failures: 1 });

		// While it cools down, the plan isn't asked at all.
		expect((await ask()).content).toEqual([{ type: "text", text: "Still the default" }]);
		expect(plan.state.callCount).toBe(1);

		// Once it has, the plan is asked again, and an answer ends its cooldown.
		clock.now = NOW + 43 * MINUTE;
		plan.setResponses([fauxAssistantMessage("From the plan")]);
		expect((await ask()).provider).toBe("plan");
		expect(plan.state.callCount).toBe(2);
		expect(cooldowns.list()).toEqual([]);
	});

	it("leaves other errors, and other providers, alone", async () => {
		const { plan, fallback, cooldowns, ask } = setup();
		plan.setResponses([fauxAssistantMessage([], { stopReason: "error", errorMessage: "Invalid request: bad schema" })]);
		expect(await ask()).toMatchObject({ stopReason: "error", provider: "plan", errorMessage: "Invalid request: bad schema" });
		expect(fallback.state.callCount).toBe(0);
		expect(cooldowns.list()).toEqual([]);
	});

	it("answers the plan's error, and still cools it down, with no other model to go to", async () => {
		const { plan, cooldowns, clock, ask } = setup({ fallback: false });
		plan.setResponses([limit, limit]);
		expect(await ask()).toMatchObject({ stopReason: "error", provider: "plan", errorMessage: CODEX_LIMIT });
		expect(cooldowns.active("plan", clock.now)).toMatchObject({ failures: 1 });
		// With nowhere else to go, the plan is still asked: it may be back before its reset.
		expect((await ask()).stopReason).toBe("error");
		expect(plan.state.callCount).toBe(2);
	});
});
