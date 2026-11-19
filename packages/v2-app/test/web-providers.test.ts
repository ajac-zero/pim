// What adding or changing a provider checks before it is kept (v1's `test/providers.test.ts`): a built-in service's key and models, a custom endpoint's listing, and what the listing says of each model.
import { describe, expect, it } from "vitest";
import { providerCatalog, toServiceInput, toWebProvider } from "../src/web-providers.ts";
import type { Provider } from "../src/providers.ts";

const answer = (status: number, body: unknown = {}) => (async () => new Response(JSON.stringify(body), { status })) as unknown as typeof fetch;
const lists = (data: unknown[]) => answer(200, { data });
const rejected = (input: Record<string, unknown>, existing?: Provider, options: Parameters<typeof toServiceInput>[2] = {}) => toServiceInput(input, existing, options).then(() => "accepted", (error: Error) => error.message);
const stored = (config: Record<string, unknown>, hasKey = true): Provider => ({ id: "pv_1", kind: "openai_compatible", name: "Home", config, hasKey, fallbackOrder: null });

describe("a provider's form", () => {
	it("needs a known service with a key and models of the catalog, and no address of its own", async () => {
		providerCatalog.builtin = (id) => (id === "openai" ? ["gpt-4.1", "gpt-5"] : undefined);
		try {
			expect(await rejected({ builtin: "unknown", key: "k", models: ["gpt-4.1"] })).toContain("builtin is one of");
			expect(await rejected({ builtin: "openai", models: ["gpt-4.1"] })).toBe("An API key is required");
			expect(await rejected({ builtin: "openai", key: "k", models: [] })).toBe("Choose at least one model");
			expect(await rejected({ builtin: "openai", key: "k", models: ["not-a-model"] })).toBe("OpenAI API doesn't offer a model not-a-model in Pim's catalog");
			expect(await rejected({ builtin: "openai", key: "k", models: ["gpt-4.1"], url: "https://models.test/v1" })).toBe("A built-in provider's address cannot be changed");
			expect(await rejected({ builtin: "openai", key: "k", models: ["gpt-4.1"], overrides: {} })).toContain("cannot be given other limits");
			expect(await rejected({ builtin: "openai", key: "k", models: ["gpt-4.1"] })).toBe("accepted");
			// A change that leaves the key out keeps it; one that empties it is refused.
			const existing = stored({ builtin: "openai", chosen: ["gpt-4.1"] });
			expect(await rejected({ name: "Mine" }, existing)).toBe("accepted");
			expect(await rejected({ key: "" }, existing)).toBe("An API key is required");
		} finally {
			providerCatalog.builtin = undefined;
		}
	});

	it("tells a bad key, an unreadable server and an unlisted model from each other, and asks for models when there are too many", async () => {
		const many = Array.from({ length: 60 }, (_, i) => ({ id: `m${i}` }));
		expect(await rejected({ name: "Cloud", url: "https://models.test/v1" }, undefined, { fetcher: answer(401) })).toContain("it answered 401");
		expect(await rejected({ name: "Cloud", url: "https://models.test/v1", key: "k" }, undefined, { fetcher: lists(many) })).toContain("lists 60 models. Name the ones to use.");
		expect(await rejected({ name: "Cloud", url: "https://models.test/v1", key: "k" }, undefined, { fetcher: lists([]) })).toContain("lists no models");
		expect(await rejected({ name: "Cloud", url: "https://models.test/v1", key: "k", models: ["gpt-9"] }, undefined, { fetcher: lists(many) })).toBe("https://models.test/v1 doesn't list a model gpt-9");
		expect(await rejected({ name: "Cloud", url: "ftp://models.test/v1" })).toContain("url must be an http(s) address");
		const down = (async () => { throw new TypeError("fetch failed"); }) as unknown as typeof fetch;
		expect(await rejected({ name: "Cloud", url: "https://models.test/v1" }, undefined, { fetcher: down })).toContain("it couldn't be reached");
		// Models that are named are taken when the server cannot be asked.
		expect(await rejected({ name: "Cloud", url: "https://models.test/v1", models: ["m1"] }, undefined, { fetcher: down })).toBe("accepted");
		expect(await rejected({ name: "Cloud", url: "https://models.test/v1", structuredOutput: "yes", models: ["m1"] }, undefined, { fetcher: down })).toBe("structuredOutput must be true or false");
		expect(await rejected({ name: "Cloud", url: "https://models.test/v1", models: ["m1"], overrides: { m1: { maxTokens: 1.5 } } }, undefined, { fetcher: down })).toContain("maxTokens must be a whole number");
	});

	it("reads a model's context window, output limit, images and reasoning from the listing, and checks the key it kept on a change", async () => {
		const seen: Record<string, string>[] = [];
		const fetcher = (async (_url: unknown, init?: RequestInit) => (seen.push(init?.headers as Record<string, string>), new Response(JSON.stringify({ data: [
			{ id: "or/model", context_length: 200_000, top_provider: { max_completion_tokens: 64_000 }, architecture: { input_modalities: ["text", "image"] }, supported_parameters: ["reasoning"] },
			{ id: "vllm", max_model_len: 4_096 },
			{ id: "gemini", outputTokenLimit: 32_768 },
		] })))) as unknown as typeof fetch;
		const made = await toServiceInput({ name: "Home", url: "http://localhost:1234/v1/", key: "k" }, undefined, { fetcher });
		expect(made.config.models).toEqual([
			{ id: "or/model", contextWindow: 200_000, maxTokens: 64_000, images: true, reasoning: true },
			{ id: "vllm", contextWindow: 4_096 },
			{ id: "gemini", maxTokens: 32_768 },
		]);
		const card = toWebProvider({ ...stored(made.config), id: "pv_1" }).models;
		expect(card[0]).toMatchObject({ contextWindow: 200_000, maxTokens: 64_000, maxTokensSource: "listing", images: true, reasoning: true });
		// A window of 4096 leaves 1024 for an answer; the person's own settings come first and stay when the models are read again.
		expect(card[1]).toMatchObject({ contextWindow: 4_096, maxTokens: 1_024, maxTokensSource: "estimated", images: false });
		const set = await toServiceInput({ overrides: { vllm: { contextWindow: 20_000, maxTokens: 9_000, cost: { input: 3 } } } }, stored(made.config), { existingKey: "kept", fetcher });
		expect(seen.at(-1)).toMatchObject({ authorization: "Bearer kept" });
		expect((set.config.models as any[])[1]).toEqual({ id: "vllm", contextWindow: 20_000, maxTokens: 9_000, cost: { input: 3, output: 0, cacheRead: 0, cacheWrite: 0 } });
		expect(toWebProvider(stored(set.config)).models[1]).toMatchObject({ contextWindow: 20_000, maxTokens: 9_000, maxTokensSource: "override", cost: { input: 3 } });
		// What pi-ai's catalog knows of a model the server did not describe fills the card.
		providerCatalog.known = (id) => (id === "gemini" ? { contextWindow: 1_000_000, maxTokens: 65_536, images: true, reasoning: true } : undefined);
		try {
			expect(toWebProvider(stored(made.config)).models[2]).toMatchObject({ contextWindow: 1_000_000, maxTokens: 32_768, maxTokensSource: "listing", images: true, reasoning: true });
			expect(toWebProvider(stored({ models: [{ id: "gemini" }] })).models[0]).toMatchObject({ contextWindow: 1_000_000, maxTokens: 65_536, maxTokensSource: "catalog", images: true });
		} finally {
			providerCatalog.known = undefined;
		}
	});
});
