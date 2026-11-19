// The utility model's suggestions: an answer that follows the schema but holds nonsense still gives its usable messages.
import { describe, expect, it } from "vitest";
import { suggestionsIn } from "../src/compat/utility.ts";

describe("suggestionsIn", () => {
	it("keeps the usable suggestions of an answer that follows the schema but holds nonsense", () => {
		const messages = [" Plan my long run ", "Plan my long run", "", 7, "x".repeat(101), "How was my pace?", "Add a rest day", "Should I taper?", "One more"];
		expect(suggestionsIn(JSON.stringify({ messages }))).toEqual(["Plan my long run", "How was my pace?"]);
		for (const nothing of ["", "no json", "{}", '{"messages":"no"}', '{"messages":[]}']) expect(suggestionsIn(nothing)).toEqual([]);
	});
});
