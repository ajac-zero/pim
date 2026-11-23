// A stored answer with nothing to say (`[text "\n", thinking ""]`, which a model leaves after `send_to_user`) was replayed to Vertex on every call, which refused it ("must
// include at least one parts field") and left the chat unusable. Every provider's request is built without such an answer, and what is stored is left as it is.
import { describe, expect, it } from "vitest";
import type { Db as RuntimeDb } from "@pim/v2-runtime/db";
import { createAgentHost, withoutEmptyAssistants } from "../src/agent-host.ts";

const usage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };
const assistant = (provider: string, api: string, model: string, content: unknown[], stopReason = "stop") => ({ role: "assistant", content, api, provider, model, usage, stopReason, timestamp: 1 });
const tell = { type: "toolCall", id: "t1", name: "send_to_user", arguments: { text: "hi" } };

/** The history of the incident: a turn that ends in `send_to_user`, an empty answer, and the person's next message. */
const incident = (provider: string, api: string, model: string, signature?: string) => ({
	messages: [
		{ role: "user", content: "hello", timestamp: 1 },
		assistant(provider, api, model, [tell], "toolUse"),
		{ role: "toolResult", toolCallId: "t1", toolName: "send_to_user", content: [{ type: "text", text: "sent" }], isError: false, timestamp: 1 },
		assistant(provider, api, model, [{ type: "text", text: "\n" }, { type: "thinking", thinking: "", ...(signature ? { thinkingSignature: signature } : {}) }]),
		{ role: "user", content: "and now?", timestamp: 2 },
	],
});

describe("an assistant message with nothing in it", () => {
	it("is left out of a history, with the user messages it separated joined", () => {
		const context = incident("p", "anthropic-messages", "m", "sig");
		const clean = withoutEmptyAssistants(context);
		expect(clean.messages.map((m: any) => m.role)).toEqual(["user", "assistant", "toolResult", "user"]);
		expect(context.messages).toHaveLength(5);
		const two = withoutEmptyAssistants({ messages: [{ role: "user", content: "a", timestamp: 1 }, assistant("p", "x", "m", [{ type: "text", text: " " }]), { role: "user", content: [{ type: "text", text: "b" }], timestamp: 2 }] });
		expect(two.messages).toEqual([{ role: "user", content: [{ type: "text", text: "a" }, { type: "text", text: "b" }], timestamp: 1 }]);
	});

	it("does not replay a failed answer, and joins the person's message with the delivery reminder an empty answer led to", () => {
		const error = { ...assistant("p", "x", "m", [], "error"), errorMessage: "The agent did not deliver its reply with send_to_user." };
		const reminder = "[Delivery required] Use send_to_user to deliver your answer now.";
		const clean = withoutEmptyAssistants({
			messages: [
				{ role: "user", content: "hello", timestamp: 1 },
				assistant("p", "x", "m", [{ type: "text", text: " " }]),
				{ role: "user", content: reminder, timestamp: 2 },
				assistant("p", "x", "m", [{ type: "text", text: "\n" }]),
				{ role: "user", content: reminder, timestamp: 3 },
				error,
				{ role: "user", content: "again", timestamp: 4 },
			],
		});
		expect(clean.messages.map((m: any) => m.role)).toEqual(["user"]);
		expect(JSON.stringify((clean.messages[0] as any).content)).toBe(JSON.stringify([{ type: "text", text: "hello" }, { type: "text", text: reminder }, { type: "text", text: reminder }, { type: "text", text: "again" }]));
	});

	it("keeps a message that calls tools, and the words next to blank parts", () => {
		const calls = assistant("p", "x", "m", [{ type: "text", text: "\n" }, { type: "thinking", thinking: "", thinkingSignature: "sig" }, tell], "toolUse");
		const said = assistant("p", "x", "m", [{ type: "thinking", thinking: "", thinkingSignature: "s" }, { type: "text", text: "Done." }, { type: "text", text: " " }]);
		const clean = withoutEmptyAssistants({ messages: [{ role: "user", content: "go", timestamp: 1 }, calls, { role: "toolResult", toolCallId: "t1", toolName: "send_to_user", content: [], isError: false, timestamp: 1 }, said] });
		expect((clean.messages[1] as any).content).toEqual([{ type: "thinking", thinking: "", thinkingSignature: "sig" }, tell]);
		expect((clean.messages[3] as any).content).toEqual([{ type: "text", text: "Done." }]);
	});
});

describe("a request built from the stored history of the incident", () => {
	const rows = [
		{ id: "pv_chat", kind: "openai_compatible", config: { name: "C", url: "http://127.0.0.1:1/v1", models: [{ id: "m-chat" }] }, secret: null },
		{ id: "pv_msgs", kind: "openai_compatible", config: { name: "M", url: "http://127.0.0.1:1/anthropic", api: "anthropic-messages", models: [{ id: "gemini-4-neon" }] }, secret: null },
	];
	const db = {
		read: async (_owner: string, sql: string) => (sql.includes("runner_providers") ? { rows: [{ p: rows }] } : { rows: [] }),
	} as unknown as RuntimeDb;

	it.each([
		["anthropic", "anthropic", "claude-sonnet-5-5", "anthropic-messages"],
		["openai", "openai", "gpt-5.5", "openai-responses"],
		["google", "google", "gemini-2.5-flash", "google-generative-ai"],
		["an OpenAI-compatible endpoint", "pv_chat", "m-chat", "openai-completions"],
		["an Anthropic-style gateway", "pv_msgs", "gemini-4-neon", "anthropic-messages"],
	])("sends %s no message without content", async (_name, provider, id, api) => {
		const host = createAgentHost({ db, env: {} });
		const models = (await host.harnessOptions({ ownerId: "o_ada", partitionId: "p1" } as never)).models as any;
		const model = models.getModels?.().find((m: any) => m.provider === provider && m.id === id) ?? models.getModel(provider, id);
		expect(model).toBeTruthy();
		const bodies: any[] = [];
		const real = globalThis.fetch;
		globalThis.fetch = (async (_url: unknown, init?: RequestInit) => (bodies.push(JSON.parse(String(init?.body))), new Response("{}", { status: 500 }))) as typeof fetch;
		try {
			await models.stream(model, incident(provider, api, id, "sig"), { apiKey: "k", maxRetries: 0 }).result();
		} finally {
			globalThis.fetch = real;
		}
		expect(bodies).toHaveLength(1);
		const wire = JSON.stringify(bodies[0]);
		// Nothing of the empty answer is sent, and the only assistant message left is the one that called send_to_user (OpenAI's Responses API has it as a bare function_call).
		expect(wire).not.toMatch(/"text":"\\n"|"thinking":""|"parts":\[\]/);
		expect(wire.match(/"role":"(assistant|model)"/g) ?? []).toHaveLength(provider === "openai" ? 0 : 1);
		expect(wire).toContain("send_to_user");
		expect(wire).toContain("and now?");
	});
});
