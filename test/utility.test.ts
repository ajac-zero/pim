import { Type } from "@earendil-works/pi-ai";
import { describe, expect, it } from "vitest";
import { SUGGEST_PROMPTS, withJsonSchema } from "../src/utility";

describe("structured utility answers", () => {
	const schema = Type.Object({ messages: Type.Array(Type.String()) }, { additionalProperties: false });

	it("asks each API for the schema in the form it takes, and leaves the rest of the request alone", () => {
		const format = { name: "answer", strict: true, schema };
		const base = { model: "m", messages: [] };
		expect(withJsonSchema("openai-completions", base, schema)).toEqual({ ...base, response_format: { type: "json_schema", json_schema: format } });
		expect(withJsonSchema("cloudflare-ai", base, schema)).toEqual({ ...base, response_format: { type: "json_schema", json_schema: format } });
		// The Responses API keeps the text settings it already has, such as the ChatGPT backend's verbosity.
		expect(withJsonSchema("openai-codex-responses", { ...base, text: { verbosity: "low" } }, schema)).toEqual({ ...base, text: { verbosity: "low", format: { type: "json_schema", ...format } } });
		expect(withJsonSchema("anthropic-messages", { ...base, output_config: { effort: "low" } }, schema)).toEqual({ ...base, output_config: { effort: "low", format: { type: "json_schema", schema } } });
		expect(withJsonSchema("google-generative-ai", { ...base, config: { temperature: 0 } }, schema)).toEqual({
			...base,
			config: { temperature: 0, responseMimeType: "application/json", responseJsonSchema: schema },
		});
		// An API without a way to ask leaves the request as it was.
		expect(withJsonSchema("faux", base, schema)).toBeUndefined();
	});

	it("keeps the usable suggestions of an answer that follows the schema but holds nonsense", () => {
		const messages = [" Plan my long run ", "Plan my long run", "", 7, "x".repeat(101), "How was my pace?", "Add a rest day", "Should I taper?", "One more"];
		expect(SUGGEST_PROMPTS.result({ messages })).toEqual(["Plan my long run", "How was my pace?", "Add a rest day", "Should I taper?"]);
		for (const nothing of [undefined, null, {}, { messages: "no" }, { messages: [] }]) expect(SUGGEST_PROMPTS.result(nothing)).toEqual([]);
	});
});
