import { createModels } from "@earendil-works/pi-ai/models";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { piProvider, prepareProvider } from "../src/providers";
import { typedSchema } from "../src/typed-schemas";
import { completionStream } from "./worker";

type Sent = { url: string; headers: Record<string, string>; raw: string; body: any };
let sent: Sent[];

beforeEach(() => {
	sent = [];
	vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
		const request = new Request(input, init);
		const raw = await request.text();
		sent.push({ url: request.url, headers: Object.fromEntries(request.headers), raw, body: JSON.parse(raw) });
		const events = [
			{ type: "message_start", message: { id: "m", type: "message", role: "assistant", content: [], model: "x", usage: { input_tokens: 1, output_tokens: 0 } } },
			{ type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
			{ type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "hi" } },
			{ type: "content_block_stop", index: 0 },
			{ type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 1 } },
			{ type: "message_stop" },
		];
		if (new URL(request.url).pathname.endsWith("/chat/completions")) return completionStream("m", "hi");
		return new Response(events.map((event) => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join(""), { headers: { "content-type": "text/event-stream" } });
	});
});

const tool = (n: number) => ({
	name: `connector_tool_${n}`,
	description: `Does thing ${n} with a long enough description to be realistic, mentioning options and limits.`,
	parameters: {
		type: "object",
		properties: {
			query: { type: "string", description: "What to look for" },
			filters: { type: "array", items: { anyOf: [{ type: "object", properties: { field: { type: "string" }, value: { anyOf: [{ type: "string" }, { type: "number" }, { type: "boolean" }] } }, required: ["field"] }, { type: "string" }] } },
			limit: { anyOf: [{ type: "integer", minimum: 1, maximum: 100 }, { type: "null" }] },
		},
		required: ["query"],
	} as never,
});

/*
 * The requests Pim sends a custom gateway, as they go over the wire: one `fetch`, with what pi-ai
 * and its SDK put in it, for models and histories like the ones a chat has. They pin down what a
 * gateway that is slow to answer is sent, so a change to either side shows up here.
 */

const TOOLS = 155;
const tools = Array.from({ length: TOOLS }, (_, n) => tool(n));
const user = (text: string, n: number) => ({ role: "user" as const, content: text, timestamp: n });

/** A history of 1, 3 or 7 messages, ending on the user's: answers, and for the longer one a tool round. */
function history(n: number) {
	const usage = { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };
	const answer = (content: any[], stopReason: "stop" | "toolUse", timestamp: number) => ({ role: "assistant" as const, content, api: "anthropic-messages" as const, provider: "own:ai-gateway", model: "claude-sonnet-5-5", usage, stopReason, timestamp });
	const text = (t: string, timestamp: number) => answer([{ type: "text", text: t }], "stop", timestamp);
	const call = { type: "toolCall" as const, id: "toolu_1", name: "connector_tool_1", arguments: { query: "x" } };
	const result = { role: "toolResult" as const, toolCallId: "toolu_1", toolName: "connector_tool_1", content: [{ type: "text" as const, text: "ok" }], isError: false, timestamp: 3 };
	if (n === 1) return [user("Hi", 1)];
	if (n === 3) return [user("Hi", 1), text("Hello", 2), user("And?", 3)];
	return [user("Hi", 1), answer([call], "toolUse", 2), result, text("Found it", 4), user("And?", 5), text("Anything else?", 6), user("No", 7)];
}

async function gateway(api: "anthropic-messages" | "openai-completions", id: string) {
	const provider = await prepareProvider({ name: "GW", url: "https://claude.test", key: "k", ...(api === "anthropic-messages" ? { api } : {}), models: [id] }, null, new Set());
	const models = createModels();
	models.setProvider(piProvider("own:ai-gateway", provider));
	return { models, model: { ...models.getModel("own:ai-gateway", id)!, maxTokens: 32_768 } };
}

describe("a custom Messages gateway's request for Claude", () => {
	it.each([1, 3, 7])("sends the plain Messages request, once, with %i messages and 155 tools, and no pre-release features", async (n) => {
		const { models, model } = await gateway("anthropic-messages", "claude-sonnet-5-5");
		for (const reasoning of ["low", "medium"] as const) {
			sent.length = 0;
			await models.completeSimple(model, { systemPrompt: "Be helpful.", messages: history(n), tools }, { reasoning, maxTokens: 32_768 });
			// One request: nothing in the stack sends it again behind the caller's back.
			expect(sent).toHaveLength(1);
			const { url, headers, body } = sent[0]!;
			expect(url).toBe("https://claude.test/v1/messages?beta=true");
			expect(headers["x-stainless-retry-count"]).toBe("0");
			expect(headers["anthropic-beta"] ?? "").not.toMatch(/mid-conversation|thinking-binding|inline-tools|server-side-fallback/);
			// Both credentials, as a gateway may take either.
			expect(headers).toMatchObject({ "x-api-key": "k", authorization: "Bearer k", "anthropic-version": "2023-06-01" });
			expect(body).toMatchObject({ model: "claude-sonnet-5-5", max_tokens: 32_768, stream: true, thinking: { type: "adaptive", display: "summarized" }, output_config: { effort: reasoning } });
			expect(body.thinking).not.toHaveProperty("block_binding");
			expect(body.tools).toHaveLength(TOOLS);
			expect(body.tools.some((each: any) => each.defer_loading)).toBe(false);
			expect(body.messages.some((message: any) => message.role === "system")).toBe(false);
			expect(body.messages).toHaveLength(n);
			expect(body).not.toHaveProperty("fallbacks");
		}
	});

	it("leaves a model other than Claude its typed tool schemas without letting them grow out of proportion, and sends 155 tools in well under a second of Pim's own work", async () => {
		const { models, model } = await gateway("anthropic-messages", "gemini-4-argon");
		const before = performance.now();
		await models.completeSimple(model, { systemPrompt: "Be helpful.", messages: history(3), tools }, { reasoning: "low", maxTokens: 32_768 });
		expect(performance.now() - before).toBeLessThan(2_000);
		const { body, raw } = sent[0]!;
		expect(body.tools).toHaveLength(TOOLS);
		const plain = JSON.stringify(tools.map((each) => each.parameters)).length;
		expect(raw.length).toBeLessThan(plain * 3);
		const start = performance.now();
		for (const each of tools) typedSchema(each.parameters);
		expect(performance.now() - start).toBeLessThan(250);
	});
});

describe("a custom OpenAI-compatible gateway's request", () => {
	it("is one streamed chat completion with the output limit and tools, and no retry headers beyond the SDK's own", async () => {
		const { models, model } = await gateway("openai-completions", "some-model");
		await models.completeSimple(model, { systemPrompt: "Be helpful.", messages: history(1), tools }, { maxTokens: 32_768 });
		expect(sent).toHaveLength(1);
		const { url, headers, body } = sent[0]!;
		expect(url).toBe("https://claude.test/chat/completions");
		expect(headers["x-stainless-retry-count"]).toBe("0");
		expect(headers.authorization).toBe("Bearer k");
		expect(body).toMatchObject({ model: "some-model", stream: true });
		expect(body.max_completion_tokens ?? body.max_tokens).toBe(32_768);
		expect(body.tools).toHaveLength(TOOLS);
	});
});
