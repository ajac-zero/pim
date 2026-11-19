// The Runner keeps a partition resident while chats in it are active. A provider whose address changes in the meantime (an imported one pointed at a reachable host, a
// key rotated) must be what the next message runs on, not what the partition was opened with: a stale address failed every call with "Connection error" and never
// reached the server.
import { Type } from "typebox";
import { describe, expect, it } from "vitest";
import type { Db as RuntimeDb } from "@pim/v2-runtime/db";
import { compatibleProvider, createAgentHost } from "../src/agent-host.ts";

describe("the agent host's model catalog", () => {
	it("follows a provider changed while the partition is resident", async () => {
		let url = "http://127.0.0.1:1/v1";
		const db = {
			read: async (_owner: string, sql: string) => {
				if (sql.includes("runner_providers")) return { rows: [{ p: [{ id: "pv_a", kind: "openai_compatible", config: { name: "A", url, models: [{ id: "m" }] }, secret: null }] }] };
				if (sql.includes("runner_context")) return { rows: [{ c: { username: "ada", agent: null, skills: [], goals: [], memories: [], contacts: [], fallbacks: [] } }] };
				return { rows: [] };
			},
		} as unknown as RuntimeDb;
		const host = createAgentHost({ db, env: {} });
		const options = await host.harnessOptions({ ownerId: "o_ada", partitionId: "p1" } as never);
		const models = options.models as { getModel(provider: string, id: string): { baseUrl: string } | undefined };
		expect(models.getModel("pv_a", "m")?.baseUrl).toBe("http://127.0.0.1:1/v1");
		url = "http://172.18.0.1:9/v1";
		// The next message in the chat sets its model, and sees the provider as it is now.
		expect(await host.chatAgent("o_ada", null as never)).toMatchObject({ model: expect.objectContaining({ provider: "pv_a" }) });
		expect(models.getModel("pv_a", "m")?.baseUrl).toBe("http://172.18.0.1:9/v1");
	});

	it("prices a custom endpoint's models by what the person set, else by the price table, and gives an unknown model room to think", async () => {
		const provider = compatibleProvider("own", "Mine", "http://127.0.0.1:1/v1", [{ id: "local-llm", contextWindow: 64_000 }, { id: "anthropic/claude-sonnet-5-5" }, { id: "paid", cost: { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 } }, { id: "huge", contextWindow: 1_000_000, maxTokens: 4_000 }], () => "k");
		const model = (id: string) => (provider as any).getModels().find((m: any) => m.id === id);
		// An unknown model is free to the ledger, and its longest answer is a quarter of its window (v1), not 8192.
		expect(model("local-llm")).toMatchObject({ cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 64_000, maxTokens: 16_000 });
		expect(model("huge")).toMatchObject({ maxTokens: 4_000 });
		// One the price table knows, under its gateway prefix, is priced; the person's own price beats the table.
		expect(model("anthropic/claude-sonnet-5-5").cost).toEqual({ input: 2, output: 10, cacheRead: 0.2, cacheWrite: 2.5 });
		expect(model("paid").cost).toEqual({ input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 });
		expect(compatibleProvider("own", "Mine", "http://x/v1", [{ id: "unlisted" }], () => "k").getModels()[0]).toMatchObject({ contextWindow: 128_000, maxTokens: 32_000 });
	});

	it("sends a failed tool's result to a gateway's non-Claude model as text, and to Claude as an error", async () => {
		const bodies: any[] = [];
		const real = globalThis.fetch;
		globalThis.fetch = (async (_url: unknown, init?: RequestInit) => (bodies.push(JSON.parse(String(init?.body))), new Response("{}", { status: 500 }))) as typeof fetch;
		try {
			const gateway = compatibleProvider("gw", "AI Gateway", "http://127.0.0.1:1/anthropic", [{ id: "claude-sonnet-5-5" }, { id: "gemini-4-carbon" }], () => "k", "anthropic-messages");
			const at = 1;
			const context = {
				messages: [
					{ role: "user", content: "go", timestamp: at },
					{ role: "assistant", content: [{ type: "toolCall", id: "t1", name: "fetch_url", arguments: {} }], api: "anthropic-messages", provider: "gw", model: "gemini-4-carbon", usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } }, stopReason: "toolUse", timestamp: at },
					{ role: "toolResult", toolCallId: "t1", toolName: "fetch_url", content: [{ type: "text", text: "404 not found" }], isError: true, timestamp: at },
				],
			};
			for (const id of ["gemini-4-carbon", "claude-sonnet-5-5"]) {
				const model = gateway.getModels().find((m: any) => m.id === id) as any;
				await (gateway as any).stream(model, context, { apiKey: "k", maxRetries: 0 }).result();
			}
		} finally {
			globalThis.fetch = real;
		}
		const result = (body: any) => body.messages.flatMap((m: any) => (Array.isArray(m.content) ? m.content : [])).find((b: any) => b.type === "tool_result");
		expect(bodies.map((b) => b.model)).toEqual(["gemini-4-carbon", "claude-sonnet-5-5"]);
		expect(result(bodies[0])).not.toHaveProperty("is_error");
		expect(JSON.stringify(result(bodies[0]).content)).toContain("Error: 404 not found");
		expect(result(bodies[1])).toMatchObject({ is_error: true });
		expect(JSON.stringify(result(bodies[1]).content)).not.toContain("Error:");
	});

	it("sends a gateway's non-Claude model tool schemas Vertex takes, and Claude's as the tool gave them", async () => {
		const bodies: any[] = [];
		const real = globalThis.fetch;
		globalThis.fetch = (async (_url: unknown, init?: RequestInit) => (bodies.push(JSON.parse(String(init?.body))), new Response("{}", { status: 500 }))) as typeof fetch;
		try {
			const gateway = compatibleProvider("gw", "AI Gateway", "http://127.0.0.1:1/anthropic", [{ id: "claude-sonnet-5-5" }, { id: "gemini-4-carbon" }], () => "k", "anthropic-messages");
			const parameters = Type.Object({
				icon: Type.Union([Type.String(), Type.Null()]),
				color: Type.Optional(Type.Union([Type.Literal("red"), Type.Literal("blue")], { description: "A color." })),
				where: Type.Union([Type.Object({ city: Type.String() }), Type.Object({ zip: Type.Number() })]),
			});
			const before = JSON.stringify(parameters);
			// pi-ai carries a transcript's tools in its leading system message.
			const context = { messages: [{ role: "system", content: "", toolsAdded: [{ name: "create_agent", description: "Make an agent.", parameters }], timestamp: 0 }, { role: "user", content: "go", timestamp: 1 }] };
			for (const id of ["gemini-4-carbon", "claude-sonnet-5-5"]) {
				const model = gateway.getModels().find((m: any) => m.id === id) as any;
				await (gateway as any).stream(model, context, { apiKey: "k", maxRetries: 0 }).result();
			}
			const [gemini, claude] = bodies.map((b) => b.tools[0].input_schema);
			expect(gemini.properties.icon).toEqual({ type: "string" });
			expect(gemini.properties.color).toEqual({ type: "string", enum: ["red", "blue"], description: "A color." });
			// A union that is a real choice stays one, with every branch typed and nothing else set beside `anyOf`.
			expect(Object.keys(gemini.properties.where)).toEqual(["anyOf"]);
			expect(gemini.properties.where.anyOf.every((branch: any) => branch.type === "object")).toBe(true);
			expect(JSON.stringify(gemini)).not.toContain('"type":"null"');
			expect(claude.properties.icon).toHaveProperty("anyOf");
			// The tool's own schema, which checks the model's arguments, is not changed.
			expect(JSON.stringify(parameters)).toBe(before);
		} finally {
			globalThis.fetch = real;
		}
	});
});
