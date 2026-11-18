import { describe, expect, it } from "vitest";
import { chatgptProvider } from "../src/chatgpt-auth.ts";
import { currentOpenaiProvider } from "../src/openai-catalog.ts";

describe("the OpenAI catalog", () => {
	it("lists GPT-6.1 Terra with its plan limits beside Sol and Luna, for the plan and the API service alike", () => {
		for (const provider of [currentOpenaiProvider(), chatgptProvider()]) {
			const models = [...provider.getModels()];
			const ids = models.map((m) => m.id);
			expect(ids).toEqual(expect.arrayContaining(["gpt-6.1-terra", "gpt-6.1-sol", "gpt-6-luna"]));
			expect(ids.filter((id) => id === "gpt-6.1-terra")).toHaveLength(1);
			const terra = models.find((m) => m.id === "gpt-6.1-terra")!;
			expect(terra).toMatchObject({ api: "openai-responses", provider: "openai", contextWindow: 500_000, maxTokens: 128_000 });
			expect(terra.input).toContain("image");
		}
	});
});
