// A memory or goal that changes mid-chat must not rewrite the start of the next model request, or the provider's prompt cache is lost for the whole history. These use pi-ai's own
// resolver and the request body the OpenAI-compatible path really sends.
import { describe, expect, it } from "vitest";
import { resolveTranscript } from "@earendil-works/pi-ai/utils/transcript";
import type { Db as RuntimeDb } from "@pim/v2-runtime/db";
import { createAgentHost } from "../src/agent-host.ts";
import { withStablePrefix } from "../src/stable-prefix.ts";

const tool = { name: "send_to_user", description: "Say something.", parameters: { type: "object", properties: { text: { type: "string" } } } };
const tagged = (key: string, text: string) => `<${key}>\n${text}\n</${key}>`;
const system = (sections: Record<string, string | null>, extra: object = {}) => ({ role: "system", content: "", sections, timestamp: 1, ...extra });
const usage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };
const history = [
	{ role: "user", content: "hello", timestamp: 2 },
	{ role: "assistant", content: [{ type: "toolCall", id: "t1", name: "send_to_user", arguments: { text: "hi" } }], api: "openai-completions", provider: "p", model: "m", usage, stopReason: "toolUse", timestamp: 3 },
	{ role: "toolResult", toolCallId: "t1", toolName: "send_to_user", content: [{ type: "text", text: "sent" }], isError: false, timestamp: 4 },
];
const first = system({ agent: tagged("agent", "You are Pim."), memory: tagged("memory", "- [1] likes tea"), active_goals: tagged("active_goals", "Run a 5k") }, { toolsAdded: [tool] });
const memoryV2 = system({ memory: tagged("memory", "- [1] likes tea\n- [2] moved to Oslo") });
const at = (messages: any[]) => ({ messages });
const resolved = (context: { messages: any[] }): any[] => resolveTranscript(context as never, false).messages;

describe("the start of a request when memory or goals change", () => {
	it("is rewritten by pi's resolver on its own, which is what loses the cache", () => {
		const before = resolved(at([first, ...history]));
		const after = resolved(at([first, memoryV2, ...history]));
		expect(JSON.stringify(after[0])).not.toBe(JSON.stringify(before[0]));
	});

	it("stays byte for byte the same, and the change follows the history", () => {
		const request = (context: { messages: any[] }) => resolved(withStablePrefix(context as any));
		const before = request(at([first, ...history]));
		const after = request(at([first, memoryV2, system({ active_goals: null }), ...history]));
		// Everything the earlier request sent, the system message with its tools and the history, leads the later one unchanged.
		expect(JSON.stringify(after.slice(0, before.length))).toBe(JSON.stringify(before));
		expect(after).toHaveLength(before.length + 1);
		const update = after[after.length - 1];
		expect(update.role).toBe("user");
		expect(update.content).toContain("- [2] moved to Oslo");
		expect(update.content).toContain("<active_goals>\nNothing now.\n</active_goals>");
		expect(update.content).not.toContain("Run a 5k");
	});

	it("tells of a section that first appears later, and starts afresh at a new baseline", () => {
		const bare = system({ agent: tagged("agent", "You are Pim."), memory: tagged("memory", "none") }, { toolsAdded: [tool] });
		const out = withStablePrefix(at([bare, system({ active_goals: tagged("active_goals", "Learn Norwegian") }), ...history]) as any).messages;
		expect(out[0].sections).toEqual(bare.sections);
		expect(out[out.length - 1].content).toContain("Learn Norwegian");
		// A compaction writes the current sections as the baseline of what follows, so nothing is left to tell.
		const rebased = system({ ...first.sections, memory: memoryV2.sections.memory ?? null }, { toolsAdded: [tool] });
		expect(withStablePrefix(at([rebased, ...history]) as any).messages).toHaveLength(history.length + 1);
	});

	it("changes nothing in a request whose volatile sections do not change", () => {
		const context = at([first, system({ agent: tagged("agent", "You are Pim, again.") }), ...history]);
		expect(withStablePrefix(context as any)).toBe(context);
	});
});

describe("a request sent to an OpenAI-compatible endpoint", () => {
	const db = { read: async (_owner: string, sql: string) => (sql.includes("runner_providers") ? { rows: [{ p: [{ id: "pv", kind: "openai_compatible", config: { name: "C", url: "http://127.0.0.1:1/v1", models: [{ id: "m-chat" }] }, secret: null }] }] } : { rows: [] }) } as unknown as RuntimeDb;

	it("keeps its first bytes across a memory change and still carries the new memory", async () => {
		const host = createAgentHost({ db, env: {} });
		const models = (await host.harnessOptions({ ownerId: "o_ada", partitionId: "p1" } as never)).models as any;
		const model = models.getModel("pv", "m-chat");
		const send = async (messages: any[]) => {
			const bodies: any[] = [];
			const real = globalThis.fetch;
			globalThis.fetch = (async (_url: unknown, init?: RequestInit) => (bodies.push(JSON.parse(String(init?.body))), new Response("{}", { status: 500 }))) as typeof fetch;
			try {
				await models.stream(model, { messages }, { apiKey: "k", maxRetries: 0 }).result();
			} finally {
				globalThis.fetch = real;
			}
			return bodies[0];
		};
		const user = { role: "user", content: "and now?", timestamp: 5 };
		const one = await send([first, ...history, user]);
		const two = await send([first, memoryV2, ...history, user]);
		expect(one.messages.length).toBeGreaterThan(3);
		expect(JSON.stringify(two.tools)).toBe(JSON.stringify(one.tools));
		expect(JSON.stringify(two.messages.slice(0, one.messages.length))).toBe(JSON.stringify(one.messages));
		expect(JSON.stringify(two.messages.slice(one.messages.length))).toContain("moved to Oslo");
		expect(JSON.stringify(one)).not.toContain("moved to Oslo");
	});
});
