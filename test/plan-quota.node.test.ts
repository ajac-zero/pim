import { describe, expect, it } from "vitest";
import { Cooldowns, ERROR_COOLDOWN_MS, QUOTA_COOLDOWN_MS, isQuotaError } from "../src/plan-quota";

describe("plan quota", () => {
	it("recognises quota and throttling errors", () => {
		expect(isQuotaError("429 You exceeded your current quota")).toBe(true);
		expect(isQuotaError("The usage limit has been reached")).toBe(true);
		expect(isQuotaError("Invalid request: bad schema")).toBe(false);
		expect(isQuotaError(undefined)).toBe(false);
	});

	it("leaves a provider alone for longer after a quota error", () => {
		const cooldowns = new Cooldowns();
		cooldowns.failed("openai", "usage limit reached", 0);
		expect(cooldowns.blocked("openai", QUOTA_COOLDOWN_MS - 1)).toBe(true);
		expect(cooldowns.blocked("openai", QUOTA_COOLDOWN_MS + 1)).toBe(false);
		cooldowns.failed("openai", "boom", 0);
		expect(cooldowns.blocked("openai", ERROR_COOLDOWN_MS + 1)).toBe(false);
		cooldowns.failed("openai", "429", 0);
		cooldowns.clear("openai");
		expect(cooldowns.blocked("openai", 1)).toBe(false);
	});
});
