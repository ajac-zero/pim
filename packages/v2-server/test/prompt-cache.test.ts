// Prompt-cache diagnostics: what a model request looks like to the provider's cache (`../src/request-fingerprint.ts`), taken from the body the real provider adapters build, and what the
// cache would do with consecutive requests. Anthropic writes a prefix to its cache only at a cache breakpoint, and a later request reads it only when that prefix, byte for byte, still leads
// it and lies within 20 blocks of one of its own breakpoints; `cacheModel` below applies exactly those rules to the real wire bodies, so what it says of a request is what the provider's cache
// does with it, with no model called.
import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import type { Db as RuntimeDb } from "@pim/v2-runtime/db";
import { createAssistantMessageEventStream } from "@earendil-works/pi-ai";
import { takeCall, trackAttempt } from "../src/call-details.ts";
import { createFailover, failureMessage } from "../src/provider-failover.ts";
import { createAgentHost } from "../src/agent-host.ts";
import { compareTraces, createFingerprinter } from "../src/request-fingerprint.ts";

const tool = { name: "send_to_user", description: "Say something.", parameters: { type: "object", properties: { text: { type: "string" } } } };
const tagged = (key: string, text: string) => `<${key}>\n${text}\n</${key}>`;
const system = (sections: Record<string, string | null>, extra: object = {}) => ({ role: "system", content: "", sections, timestamp: 1, ...extra });
const usage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };
const OWNER = "o_ada";

/** A chat as pi stores it: a system message with the tools and sections, then rounds of an assistant tool call and its result. */
const first = system({ agent: tagged("agent", "You are Pim."), memory: tagged("memory", "- [1] likes tea") }, { toolsAdded: [tool] });
const memoryV2 = system({ memory: tagged("memory", "- [1] likes tea\n- [2] moved to Oslo") });
const person = { role: "user", content: "hello there", timestamp: 2 };
const round = (n: number, api = "anthropic-messages", provider = "anthropic", model = "claude-sonnet-5-5") => [
	{ role: "assistant", content: [{ type: "toolCall", id: `t${n}`, name: "send_to_user", arguments: { text: `round ${n}` } }], api, provider, model, providerThinkingLevel: "high", usage, stopReason: "toolUse", timestamp: 100 + n },
	{ role: "toolResult", toolCallId: `t${n}`, toolName: "send_to_user", content: [{ type: "text", text: `sent ${n}` }], isError: false, timestamp: 200 + n },
];
const chat = (rounds: number, ...patches: object[]) => [first, ...patches, person, ...Array.from({ length: rounds }, (_, i) => round(i + 1)).flat()];

const sse = (events: [string, object][]) => new Response(events.map(([name, data]) => `event: ${name}\ndata: ${JSON.stringify(data)}\n\n`).join(""), { headers: { "content-type": "text/event-stream" } });
const answer = (id: string) =>
	sse([
		["message_start", { type: "message_start", message: { id, type: "message", role: "assistant", model: "m", content: [], stop_reason: null, usage: { input_tokens: 4, output_tokens: 1 } } }],
		["content_block_start", { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } }],
		["content_block_delta", { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "ok" } }],
		["content_block_stop", { type: "content_block_stop", index: 0 }],
		["message_delta", { type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 2 } }],
		["message_stop", { type: "message_stop" }],
	]);

type Sent = { body: any; trace: any; message: any };
type Host = { models: any; model: any; send(messages: any[], options?: Record<string, unknown>): Promise<Sent> };

/** The host's own models, with the failover that watches every attempt, over a fetch that records the body and answers as the test says. */
async function rig(provider: string, id: string, env: NodeJS.ProcessEnv = {}, reply: (n: number) => Response = (n) => answer(`msg_${n}`)): Promise<Host & { bodies: any[] }> {
	// "neon" is a person's own endpoint that speaks Anthropic's Messages API, "gw" one that speaks OpenAI's chat API.
	const own = { neon: { name: "Neon", url: "https://neon.example.test/v1", api: "anthropic-messages" }, gw: { name: "Gateway", url: "https://gw.example.test/v1" } }[provider as "neon" | "gw"];
	const providers = own ? [{ id: provider, kind: "openai_compatible", config: { ...own, models: [{ id }] }, secret: null }] : [];
	const db = { read: async (_owner: string, sql: string) => (sql.includes("runner_providers") ? { rows: [{ p: providers }] } : { rows: [] }) } as unknown as RuntimeDb;
	const host = createAgentHost({ db, env });
	const models = (await host.harnessOptions({ ownerId: OWNER, partitionId: "p1" } as never)).models as any;
	const model = models.getModel(provider, id);
	const bodies: any[] = [];
	return {
		models,
		model,
		bodies,
		async send(messages, options = {}) {
			const fetcher = async (_url: unknown, init?: RequestInit) => (bodies.push(JSON.parse(String(init?.body))), reply(bodies.length));
			const message = await models.stream(model, { messages }, { apiKey: "k", maxRetries: 0, fetch: fetcher, ...options }).result();
			// The failover leaves its record just after the answer's last event, which the caller sees first.
			await new Promise((resolve) => setImmediate(resolve));
			const kept = takeCall(OWNER, message);
			return { body: bodies[bodies.length - 1], trace: kept?.cacheTrace, message };
		},
	};
}

/**
 * Anthropic's prompt cache as its documentation states it, applied to a request body: a prefix is written at each cache breakpoint (the tools, then the system prompt, then the messages,
 * each block in order, `cache_control` not part of what is cached), and a request reads the longest earlier-written prefix that ends within 20 blocks before one of its own breakpoints.
 * Returns how many leading blocks were read, how many the request has, and how many lead up to its last breakpoint. Independent of the fingerprint: it works on the wire body alone.
 */
function cacheModel() {
	const written = new Set<string>();
	return (body: any) => {
		const blocks: { text: string; marked: boolean }[] = [];
		const add = (value: any) => blocks.push({ text: JSON.stringify(value, (k, v) => (k === "cache_control" ? undefined : v)), marked: !!value?.cache_control });
		for (const t of body.tools ?? []) add(t);
		for (const s of body.system ?? []) add(s);
		for (const m of body.messages ?? []) {
			const content = typeof m.content === "string" ? [{ type: "text", text: m.content }] : m.content;
			// A message with no blocks (the effort markers) is still bytes of the prefix.
			if (content.length === 0) add({ role: m.role, ...m });
			for (const block of content) add({ role: m.role, ...block, cache_control: block.cache_control });
		}
		const prefix: string[] = [];
		const hash = createHash("sha256");
		for (const block of blocks) prefix.push((hash.update(block.text), hash.copy().digest("hex")));
		let read = 0;
		blocks.forEach((block, at) => {
			if (!block.marked) return;
			for (let q = at; q >= Math.max(0, at - 19); q--) if (written.has(prefix[q]!)) return void (read = Math.max(read, q + 1));
		});
		blocks.forEach((block, at) => block.marked && written.add(prefix[at]!));
		return { read, total: blocks.length, marked: blocks.findLastIndex((block) => block.marked) + 1 };
	};
}

describe("what is recorded of a request", () => {
	it("is taken from the body the Anthropic adapter really sends, hashes only", async () => {
		const r = await rig("anthropic", "claude-sonnet-5-5");
		const image = { role: "user", content: [{ type: "text", text: "see this" }, { type: "image", data: "AAAASECRETIMAGEBYTES", mimeType: "image/png" }], timestamp: 3 };
		const { body, trace } = await r.send([...chat(2), image]);
		expect(trace).toMatchObject({ v: 1, counts: { tools: 2, system: 1, messages: body.messages.length }, breakpoints: [{ in: "tools", index: 0 }, { in: "system", index: 0 }, { in: "messages" }] });
		expect(trace.tail.roles).toMatch(/^[uats]+$/);
		// Nothing a person or an agent wrote, no key and no signature, is in it: only hex, counts, role letters and the names of the request's settings.
		const text = JSON.stringify(trace);
		for (const secret of ["hello there", "Pim", "likes tea", "send_to_user", "sent 1", "see this", "SECRETIMAGEBYTES", "claude", "ephemeral"]) expect(text).not.toContain(secret);
		expect(Object.keys(trace.settingKeys)).toEqual(expect.arrayContaining(["model", "max_tokens", "thinking", "output_config"]));
		expect(text.length).toBeLessThan(2_000);
	});

	it("is kept for a call that was fast and succeeded, and for one that failed", async () => {
		const ok = await rig("anthropic", "claude-sonnet-5-5");
		const fast = await ok.send(chat(1));
		expect(fast.message.stopReason).toBe("stop");
		expect(fast.trace).toMatchObject({ v: 1, counts: { messages: expect.any(Number) } });
		const bad = await rig("anthropic", "claude-sonnet-5-5", {}, () => new Response("{}", { status: 400 }));
		const failed = await bad.send(chat(1));
		expect(failed.message.stopReason).toBe("error");
		expect(failed.trace.messages).toBe(fast.trace.messages);
	});
});

describe("a provider that is not Anthropic", () => {
	it("is traced from its own body shape: OpenAI's chat API has no system field and no markers", async () => {
		const r = await rig("gw", "m-chat");
		const { body, trace } = await r.send(chat(2, memoryV2));
		expect(trace).toMatchObject({ system: null, counts: { tools: 1, messages: body.messages.length }, breakpoints: [] });
		expect(JSON.stringify(trace)).not.toContain("likes tea");
	});
});

describe("the attempts of one request", () => {
	it("each keep the trace of the body they sent, so a fallback is told apart from the model it replaced", async () => {
		const bodyOf = (model: string) => ({ model, system: [{ type: "text", text: `for ${model}`, cache_control: { type: "ephemeral" } }], messages: [{ role: "user", content: "hi" }] });
		const models: any = {
			getModel: (provider: string, id: string) => ({ provider, id, api: "anthropic-messages" }),
			getAuth: async () => ({}),
			stream(model: any, _context: unknown, options: any) {
				const out = createAssistantMessageEventStream();
				void (async () => {
					await options.onPayload(bodyOf(model.id), model);
					const message: any = failureMessage(model, "529 overloaded", "error", 5);
					if (model.id !== "down") Object.assign(message, { stopReason: "stop", content: [{ type: "text", text: "ok" }], errorMessage: undefined });
					if (model.id === "down") out.push({ type: "error", reason: "error", error: message } as never);
					else (out.push({ type: "done", reason: "stop", message } as never), out.end(message));
				})();
				return out;
			},
		};
		const failover = createFailover({ now: () => 5, fingerprint: (owner) => createFingerprinter({}, owner) });
		failover.setChain(OWNER, { provider: "anthropic", id: "down" }, [{ provider: "anthropic", id: "down" }, { provider: "anthropic", id: "up" }]);
		const message = await failover.wrap(models, OWNER).stream({ provider: "anthropic", id: "down", api: "anthropic-messages" } as never, { messages: [{ role: "user", content: "hi", timestamp: 1 }] } as never, { apiKey: "k" } as never).result();
		await new Promise((resolve) => setImmediate(resolve));
		const kept = takeCall(OWNER, message)!;
		const [failed] = kept.failures;
		expect(message.model).toBe("up");
		expect(failed).toMatchObject({ model: "down", detail: { stopReason: "error" } });
		const mine = createFingerprinter({}, OWNER);
		expect(failed!.detail.cacheTrace).toEqual(mine(bodyOf("down")));
		expect(kept.cacheTrace).toEqual(mine(bodyOf("up")));
		expect(kept.cacheTrace!.system).not.toBe(failed!.detail.cacheTrace!.system);
	});

	it("keep the trace of the body that was sent last when the adapter builds it again", () => {
		const fingerprint = createFingerprinter({}, OWNER);
		const attempt = trackAttempt({ api: "anthropic-messages" }, { messages: [] }, {}, () => 1, fingerprint);
		void attempt.options.onPayload({ model: "m", messages: [{ role: "user", content: "first" }] }, {});
		void attempt.options.onPayload({ model: "m", messages: [{ role: "user", content: "second" }] }, {});
		expect(attempt.finish({ stopReason: "stop" }).cacheTrace).toEqual(fingerprint({ model: "m", messages: [{ role: "user", content: "second" }] }));
	});
});

describe("comparing consecutive requests", () => {
	const settle = async (r: Host, ...requests: any[][]) => {
		const out: Sent[] = [];
		for (const messages of requests) out.push(await r.send(messages));
		return out;
	};

	it("says which section changed first, and where the shared messages end", async () => {
		const r = await rig("anthropic", "claude-sonnet-5-5");
		const [base, grown, edited, retooled, rewritten, resized] = (await settle(
			r,
			chat(3),
			chat(4),
			// The result of the first round of tools is different: everything before it is shared.
			chat(3).map((m: any) => (m.toolCallId === "t1" ? { ...m, content: [{ type: "text", text: "changed" }] } : m)),
			[{ ...first, toolsAdded: [{ ...tool, description: "Say something else." }] }, ...chat(3).slice(1)],
			[{ ...first, sections: { ...first.sections, agent: tagged("agent", "You are someone else.") } }, ...chat(3).slice(1)],
			chat(3),
		)) as [Sent, Sent, Sent, Sent, Sent, Sent];
		const at = base.body.messages.findIndex((m: any) => JSON.stringify(m).includes("sent 1"));
		const diff = (a: Sent, b: Sent) => compareTraces(a.trace, b.trace) as any;
		expect(diff(base, grown)).toMatchObject({ firstChange: "none", sharedMessages: base.body.messages.length, window: 1, addedMessages: 3 });
		expect(diff(base, edited)).toMatchObject({ firstChange: "messages", sharedMessages: at });
		expect(diff(base, retooled)).toMatchObject({ firstChange: "tools" });
		expect(diff(base, rewritten)).toMatchObject({ firstChange: "system" });
		expect(diff(base, resized)).toMatchObject({ firstChange: "none", settings: [], sharedMessages: base.body.messages.length });
		// A setting that differs is named.
		const lower = await r.send(chat(3), { maxTokens: 1000 });
		expect(diff(base, lower)).toMatchObject({ firstChange: "none", settings: ["max_tokens"] });
	});

	it("does not count where the cache markers are, or how long they last", async () => {
		const r = await rig("anthropic", "claude-sonnet-5-5");
		const short = await r.send(chat(2));
		const long = await r.send(chat(2), { cacheRetention: "long" });
		expect(JSON.stringify(long.body)).toContain('"ttl":"1h"');
		expect(JSON.stringify(short.body)).not.toContain('"ttl"');
		const { breakpoints: _a, ...one } = short.trace;
		const { breakpoints: _b, ...two } = long.trace;
		expect(two).toEqual(one);
		expect(long.trace.breakpoints).toEqual(short.trace.breakpoints);
	});

	it("is the same for the same owner and secret, and never for another owner", () => {
		const body = { model: "m", system: [{ type: "text", text: "s" }], messages: [{ role: "user", content: "hi" }] };
		const env = { PIM_INGRESS_SECRET: "a secret" };
		expect(createFingerprinter(env, "o_ada")(body)).toEqual(createFingerprinter(env, "o_ada")(body));
		const other = createFingerprinter(env, "o_bob")(body)!;
		const mine = createFingerprinter(env, "o_ada")(body)!;
		expect(other.key).not.toBe(mine.key);
		for (const field of ["system", "settings", "head", "messages"] as const) expect(other[field]).not.toBe(mine[field]);
		expect(compareTraces(mine, other)).toMatchObject({ comparable: false });
		expect(compareTraces(mine, createFingerprinter({ PIM_INGRESS_SECRET: "another" }, "o_ada")(body)!)).toMatchObject({ comparable: false });
	});

	it("stays small however long the chat is, and still finds where two long chats part", () => {
		const fingerprint = createFingerprinter({}, "o_ada");
		const long = (n: number, edit = -1) => ({ model: "m", messages: Array.from({ length: n }, (_, i) => ({ role: i % 2 ? "assistant" : "user", content: i === edit ? "edited" : `message ${i}` })) });
		const a = fingerprint(long(5000))!;
		const b = fingerprint(long(5000, 3001))!;
		expect(a.stride).toBe(8);
		expect(a.chain.length).toBeLessThanOrEqual(1024 * 4);
		expect(JSON.stringify(a).length).toBeLessThan(6_000);
		expect(compareTraces(a, b)).toMatchObject({ firstChange: "messages", window: 8, sharedMessages: 3000 });
		// A trace of a short chat against one of a long chat that continues it.
		expect(compareTraces(fingerprint(long(40))!, fingerprint(long(41))!)).toMatchObject({ firstChange: "none", sharedMessages: 40 });
	});

	it("does not say a breakpoint survived when the traces cannot tell, or when its message is gone", () => {
		const fingerprint = createFingerprinter({}, "o_ada");
		const mark = { cache_control: { type: "ephemeral" } };
		const body = (messages: any[]) => ({ model: "m", messages });
		const text = (t: string, marked = false) => ({ type: "text", text: t, ...(marked ? mark : {}) });
		const user = (...blocks: any[]) => ({ role: "user", content: blocks });
		const earlier = fingerprint(body([user(text("one")), user(text("two")), user(text("history", true), text("old suffix"))]))!;
		const at = (later: any[]) => (compareTraces(earlier, fingerprint(body(later))!) as any).breakpoints[0].stillThere;
		// The breakpoint is inside the last message, which keeps its first block and changes the rest: the traces hold messages whole, so they cannot say; never "true".
		expect(at([user(text("one")), user(text("two")), user(text("history"), text("new suffix")), user(text("more"))])).toBeNull();
		// Something before the message changed: it is gone.
		expect(at([user(text("ONE")), user(text("two")), user(text("history"), text("old suffix"))])).toBe(false);
		// The message with the same blocks is still there.
		expect(at([user(text("one")), user(text("two")), user(text("history"), text("old suffix")), user(text("next"))])).toBe(true);
		// The later history is shorter: the message the breakpoint was on is gone, and the request is told so.
		const shorter = compareTraces(earlier, fingerprint(body([user(text("one")), user(text("two"))]))!) as any;
		expect(shorter).toMatchObject({ firstChange: "truncated", sharedMessages: 2, addedMessages: 0 });
		expect(shorter.breakpoints[0].stillThere).toBe(false);
	});

	it("is conservative where a long chat's thinned chain cannot see", () => {
		const fingerprint = createFingerprinter({}, "o_ada");
		const long = (n: number, edit = -1, marked = -1) => ({ model: "m", messages: Array.from({ length: n }, (_, i) => ({ role: "user", content: [{ type: "text", text: i === edit ? "edited" : `message ${i}`, ...(i === marked ? { cache_control: { type: "ephemeral" } } : {}) }] })) });
		const a = fingerprint(long(5003, -1, 5001))!;
		expect(a.stride).toBe(8);
		// The same length with its last message changed differs, though no checkpoint is at the end.
		expect(compareTraces(a, fingerprint(long(5003, 5002))!)).toMatchObject({ firstChange: "messages" });
		// A longer chat whose last messages were changed in the part the chain does not reach: nothing seen differs, but "none" would be a claim the traces cannot make.
		const longer = compareTraces(a, fingerprint(long(5010, 5002))!) as any;
		expect(longer.firstChange).toBe("unknown");
		expect(longer.breakpoints[0].stillThere).toBeNull();
		// A shorter later chat is truncated, and the breakpoint beyond its end is gone.
		const shorter = compareTraces(a, fingerprint(long(4000))!) as any;
		expect(shorter).toMatchObject({ firstChange: "truncated" });
		expect(shorter.breakpoints[0].stillThere).toBe(false);
	});

	it("never throws or names content when a body cannot be read", () => {
		const fingerprint = createFingerprinter({}, "o_ada");
		const loop: any = { messages: [{ role: "user", content: "my private note" }] };
		loop.messages[0].self = loop;
		expect(fingerprint(loop)).toBeUndefined();
		expect(fingerprint({ messages: [{ role: "user", content: 10n }] })).toBeUndefined();
		expect(fingerprint(null)).toBeUndefined();
		expect(fingerprint("text")).toBeUndefined();
		// A body the code does not know still gets a trace; OpenAI's chat shape has its system prompt as the first message.
		expect(fingerprint({ model: "gpt", messages: [{ role: "system", content: "s" }, { role: "user", content: "u" }], tools: [{ type: "function" }] })).toMatchObject({ system: null, counts: { tools: 1, messages: 2 }, breakpoints: [] });
	});
});

describe("the cache across the tool rounds of one chat", () => {
	/** What the provider's cache reads of each request of a chat that grows by a tool round every time: [blocks read, blocks sent]. */
	const run = async (provider: string, id: string, patches: object[], rounds = [1, 2, 3, 4], options: Record<string, unknown> = {}) => {
		const r = await rig(provider, id);
		const cache = cacheModel();
		const out: { read: number; total: number; marked: number; trace: any; body: any }[] = [];
		for (const n of rounds) {
			const sent = await r.send(chat(n, ...patches), options);
			out.push({ ...cache(sent.body), trace: sent.trace, body: sent.body });
		}
		return out;
	};
	// What every request reads when nothing of the history is reused: its tools and its system prompt.
	const headOf = (body: any) => (body.tools?.length ?? 0) + (body.system?.length ?? 0);
	const models = [["anthropic", "claude-sonnet-5-5"], ["neon", "claude-sonnet-5-5"]] as const;

	for (const [provider, id] of models) {
		it(`reads the whole earlier history on ${provider}/${id} when nothing changes mid-chat`, async () => {
			const calls = await run(provider, id, []);
			for (const [i, call] of calls.entries()) if (i > 0) expect(call.read).toBe(calls[i - 1]!.marked);
		});

		it(`reads the earlier history on ${provider}/${id} when a memory has changed, as when nothing has`, async () => {
			// The context update that the stable prefix puts last is never marked: the end of the history before it is, so each request's write is what the next one starts with.
			const calls = await run(provider, id, [memoryV2]);
			for (const [i, call] of calls.entries()) {
				const wire = JSON.stringify(call.body.messages);
				expect(wire).toContain("[Context update]");
				expect(wire.indexOf('"cache_control"')).toBeLessThan(wire.indexOf("[Context update]"));
				expect(call.body.messages.flatMap((m: any) => m.content).filter((b: any) => b.text?.startsWith("[Context update]") && b.cache_control)).toEqual([]);
				expect(JSON.stringify(call.body).split('"cache_control"').length - 1).toBeLessThanOrEqual(4);
				if (i > 0) expect(call.read).toBe(calls[i - 1]!.marked);
			}
			const [one, two] = calls;
			// The whole history of the first request is the shared prefix, and its breakpoint lies on the second.
			expect(compareTraces(one!.trace, two!.trace)).toMatchObject({ breakpoints: [{ stillThere: true }, { stillThere: true }, { in: "messages", stillThere: true }] });
		});

		it(`still reads it on ${provider}/${id} when the update itself changes between requests`, async () => {
			const r = await rig(provider, id);
			const cache = cacheModel();
			const memoryV3 = system({ memory: tagged("memory", "- [1] likes tea\n- [3] has a dog") });
			let before: ReturnType<typeof cache> | undefined;
			for (const [n, patches] of [[1, [memoryV2]], [2, [memoryV2]], [3, [memoryV2, memoryV3]], [4, [memoryV2, memoryV3]]] as const) {
				const now = cache((await r.send(chat(n, ...patches))).body);
				if (before) expect(now.read).toBe(before.marked);
				before = now;
			}
		});
	}

	it("does not depend on the effort a request asks for", async () => {
		const r = await rig("anthropic", "claude-sonnet-5-5");
		const cache = cacheModel();
		const one = await r.send(chat(2), { effort: "low" });
		const first = cache(one.body);
		// The effort of the earlier answers is stored with them; only the marker after the last message follows the request's, and it comes after the breakpoint.
		const two = await r.send(chat(3), { effort: "high" });
		expect(cache(two.body).read).toBe(first.marked);
		expect(two.trace.settings).toBe(one.trace.settings);
	});
});
