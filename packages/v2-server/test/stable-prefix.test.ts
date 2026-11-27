// A memory that changes mid-chat must not rewrite the start of the next model request, or the provider's prompt cache is lost for the whole history, and the change must be sent once and then
// stay in the history the provider has cached. These use pi-ai's own
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
const first = system({ agent: tagged("agent", "You are Pim."), memory: tagged("memory", "- [1] likes tea"), room: tagged("room", "Run a 5k") }, { toolsAdded: [tool] });
const memoryV2 = system({ memory: tagged("memory", "- [1] likes tea\n- [2] moved to Oslo") });
const at = (messages: any[]) => ({ messages });
const resolved = (context: { messages: any[] }): any[] => resolveTranscript(context as never, false).messages;
const request = (messages: any[]) => resolved(withStablePrefix(at(messages) as any));
const round = (n: number) => [
	{ role: "assistant", content: [{ type: "toolCall", id: `r${n}`, name: "send_to_user", arguments: { text: `round ${n}` } }], api: "openai-completions", provider: "p", model: "m", usage, stopReason: "toolUse", timestamp: 10 * n },
	{ role: "toolResult", toolCallId: `r${n}`, toolName: "send_to_user", content: [{ type: "text", text: `sent ${n}` }], isError: false, timestamp: 10 * n + 1 },
];
const updates = (messages: any[]) => messages.filter((m) => typeof m.content === "string" && m.content.startsWith("[Context update]"));
const memoryV3 = system({ memory: tagged("memory", "- [1] likes tea\n- [2] moved to Oslo\n- [3] has a dog") }, { timestamp: 7 });

describe("the start of a request when memory changes", () => {
	it("is rewritten by pi's resolver on its own, which is what loses the cache", () => {
		const before = resolved(at([first, ...history]));
		const after = resolved(at([first, memoryV2, ...history]));
		expect(JSON.stringify(after[0])).not.toBe(JSON.stringify(before[0]));
	});

	it("leaves the system message as it was and puts the change where the harness stored it, once", () => {
		const before = request([first, ...history]);
		// The harness writes the patch after the tool result the next model call answers, and the model's next answer follows it.
		const after = request([first, ...history, memoryV2, system({ room: null })]);
		expect(JSON.stringify(after.slice(0, before.length))).toBe(JSON.stringify(before));
		expect(after).toHaveLength(before.length + 1);
		const update = after[after.length - 1];
		expect(update.role).toBe("user");
		expect(update.content).toContain("- [2] moved to Oslo");
		expect(update.content).toContain("<room>\nNothing now.\n</room>");
		expect(update.content).not.toContain("likes tea\n</memory>\n\n<room>");
	});

	it("shares the whole earlier request, the update included, with every request after it", () => {
		const two = request([first, ...history, memoryV2]);
		const three = request([first, ...history, memoryV2, ...round(2)]);
		const four = request([first, ...history, memoryV2, ...round(2), ...round(3)]);
		expect(JSON.stringify(three.slice(0, two.length))).toBe(JSON.stringify(two));
		expect(JSON.stringify(four.slice(0, three.length))).toBe(JSON.stringify(three));
		// The update is sent once per change, not once per call, and what follows it is only what is new.
		for (const sent of [two, three, four]) expect(updates(sent)).toHaveLength(1);
		expect(three.length - two.length).toBe(2);
		expect(JSON.stringify(four)).toContain("sent 3");
	});

	it("adds only what changed when it changes again, and leaves the earlier update where it was", () => {
		const two = request([first, ...history, memoryV2]);
		const four = request([first, ...history, memoryV2, ...round(2), memoryV3]);
		expect(JSON.stringify(four.slice(0, two.length))).toBe(JSON.stringify(two));
		const [older, newer] = updates(four);
		expect(updates(four)).toHaveLength(2);
		expect(older.content).toContain("moved to Oslo");
		expect(newer.content).toContain("has a dog");
		// The room did not change after the first update, so the second does not carry it.
		expect(newer.content).not.toContain("<room>");
		expect(four.indexOf(newer)).toBe(four.length - 1);
	});

	it("says what changed back to what the chat began with, because the model has been told otherwise since", () => {
		const out = updates(request([first, ...history, memoryV2, ...round(2), system({ memory: first.sections.memory! })]));
		expect(out).toHaveLength(2);
		expect(out[1].content).toContain("- [1] likes tea\n</memory>");
		// Setting a section to the text already shown tells nothing.
		expect(updates(request([first, ...history, system({ memory: first.sections.memory! })]))).toHaveLength(0);
	});

	it("keeps an update from coming between a tool call and its result", () => {
		const parallel = [
			{ ...round(2)[0], content: [{ type: "toolCall", id: "a", name: "send_to_user", arguments: {} }, { type: "toolCall", id: "b", name: "send_to_user", arguments: {} }] },
			{ ...round(2)[1], toolCallId: "a" },
			memoryV2,
			{ ...round(2)[1], toolCallId: "b" },
		];
		const out = request([first, ...history, ...parallel]);
		expect(out.map((m) => m.role)).toEqual(["system", "user", "assistant", "toolResult", "assistant", "toolResult", "toolResult", "user"]);
	});

	it("starts afresh at a compaction, which writes the current sections as the baseline of what follows", () => {
		const rebased = system({ ...first.sections, memory: memoryV2.sections.memory ?? null }, { toolsAdded: [tool] });
		const out = withStablePrefix(at([rebased, ...history]) as any).messages;
		expect(out).toHaveLength(history.length + 1);
		expect(updates(out)).toHaveLength(0);
		// A change after it is told once, against the new baseline.
		expect(updates(request([rebased, ...history, memoryV3]))).toHaveLength(1);
	});

	it("tells of a section that first appears later", () => {
		const bare = system({ agent: tagged("agent", "You are Pim."), memory: tagged("memory", "none") }, { toolsAdded: [tool] });
		const out = withStablePrefix(at([bare, ...history, system({ room: tagged("room", "Learn Norwegian") })]) as any).messages;
		expect(out[0].sections).toEqual(bare.sections);
		expect(out[out.length - 1].content).toContain("Learn Norwegian");
	});

	it("leaves a patch of other sections in the system message, and changes nothing in a request whose volatile sections do not change", () => {
		const context = at([first, ...history, system({ agent: tagged("agent", "You are Pim, again.") })]);
		expect(withStablePrefix(context as any)).toBe(context);
	});
});

describe("a request sent to an OpenAI-compatible endpoint", () => {
	const db = { read: async (_owner: string, sql: string) => (sql.includes("runner_providers") ? { rows: [{ p: [{ id: "pv", kind: "openai_compatible", config: { name: "C", url: "http://127.0.0.1:1/v1", models: [{ id: "m-chat" }] }, secret: null }] }] } : { rows: [] }) } as unknown as RuntimeDb;

	it("keeps its first bytes across a memory change, carries the new memory once, and keeps it where it was", async () => {
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
		const one = await send([first, ...history]);
		const two = await send([first, ...history, memoryV2]);
		const three = await send([first, ...history, memoryV2, ...round(2)]);
		expect(one.messages.length).toBeGreaterThan(3);
		for (const sent of [two, three]) expect(JSON.stringify(sent.tools)).toBe(JSON.stringify(one.tools));
		expect(JSON.stringify(two.messages.slice(0, one.messages.length))).toBe(JSON.stringify(one.messages));
		expect(JSON.stringify(two.messages.slice(one.messages.length))).toContain("moved to Oslo");
		expect(JSON.stringify(one)).not.toContain("moved to Oslo");
		expect(JSON.stringify(three.messages.slice(0, two.messages.length))).toBe(JSON.stringify(two.messages));
		expect(JSON.stringify(three).split("moved to Oslo").length - 1).toBe(1);
	});
});
