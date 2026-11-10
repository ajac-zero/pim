import { describe, expect, it } from "vitest";
import { Cooldowns, ERROR_COOLDOWN_MS } from "../src/plan-quota";

describe("plan quota", () => {
	it("leaves a provider alone for a minute after an error", () => {
		const cooldowns = new Cooldowns();
		cooldowns.failed("openai", 0);
		expect(cooldowns.blocked("openai", ERROR_COOLDOWN_MS - 1)).toBe(true);
		expect(cooldowns.blocked("openai", ERROR_COOLDOWN_MS + 1)).toBe(false);
		cooldowns.failed("openai", 0);
		cooldowns.clear("openai");
		expect(cooldowns.blocked("openai", 1)).toBe(false);
	});
});
