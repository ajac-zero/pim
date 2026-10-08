import type { Message } from "@earendil-works/pi-ai";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { env, runInDurableObject } from "cloudflare:test";
import { describe, expect, it, vi } from "vitest";
import { cover } from "../src/extensions/optmem/cover";
import { AGENT_NAME } from "../src/agent";
import { api, lastUserText, post, say, toolUse } from "./helpers";
import { faux, napper, type Pim } from "./worker";

/**
 * One agent for the whole file: the tests build on each other's memories,
 * the way a real memory grows.
 */

type Nap = { block: string; prompt: string };

/** Every compression prompt the napper has answered, in order. */
const naps: Nap[] = [];
/** Blocks whose compression waits on a promise the test resolves. */
const held = new Map<string, Promise<string>>();

function blockOf(prompt: string): string {
	return /Compress memories #(\d+-\d+)/.exec(prompt)![1]!;
}

// The napper answers every compression with `S[a-b]`, unless the test holds that block.
napper.setResponses(
	Array.from({ length: 1000 }, () => async (context: { messages: Message[] }) => {
		const prompt = lastUserText(context.messages);
		const block = blockOf(prompt);
		const hold = held.get(block);
		held.delete(block);
		const answer = hold ? await hold : `S[${block}]`;
		naps.push({ block, prompt });
		return fauxAssistantMessage(answer);
	}),
);

async function settled() {
	await vi.waitFor(
		async () => expect((await api("/memory")).body.pendingCompressions).toBe(0),
		{ timeout: 10_000, interval: 20 },
	);
}

async function addMemories(from: number, to: number) {
	for (let i = from; i < to; i++) expect((await post("/memory/log", { text: `fact ${i}` })).status).toBe(201);
}

/** Every value pi sent for one section, in order: the text, or null when it was removed. */
function patches(messages: readonly Message[], key: string): (string | null)[] {
	return messages.flatMap((message) =>
		message.role === "system" && message.sections !== undefined && key in message.sections
			? [message.sections[key] ?? null]
			: [],
	);
}

function systemText(messages: readonly Message[]): string[] {
	return patches(messages, "memory").filter((value) => value !== null);
}

/** Answers the next request with "ok", recording the memory sections the model was sent. */
function capture(into: { memory: (string | null)[]; since: (string | null)[] }[]) {
	return (context: { messages: Message[] }) => {
		into.push({ memory: patches(context.messages, "memory"), since: patches(context.messages, "memory_since") });
		return fauxAssistantMessage("ok");
	};
}

async function memoryCount(): Promise<number> {
	return (await api("/memory")).body.count;
}

describe("long-term memory", () => {
	it("records a note from the conversation", async () => {
		faux.setResponses([toolUse("note", { text: "Ana is the user's sister." }), fauxAssistantMessage("Noted.")]);
		await say("My sister Ana is visiting.");
		const { body } = await api("/memory/log");
		expect(body.entries).toEqual([
			{ id: 0, date: expect.stringMatching(/^\d{4}-\d{2}-\d{2}$/), text: "Ana is the user's sister.", forgotten: false, source: "1" },
		]);
	});

	it("rejects notes that are not one short line, recording nothing", async () => {
		let results = "";
		faux.setResponses([
			fauxAssistantMessage(
				[fauxToolCall("note", { text: "line one\nline two" }), fauxToolCall("note", { text: "x".repeat(281) })],
				{ stopReason: "toolUse" },
			),
			(context) => {
				results = JSON.stringify(context.messages.filter((message) => message.role === "toolResult"));
				return fauxAssistantMessage("Oops.");
			},
		]);
		await say("Remember a lot.");
		expect(results).toContain("A memory is one line");
		expect(results).toContain("Too long: 281 bytes");
		expect((await api("/memory")).body.count).toBe(1);
	});

	it("compresses memories into a tree in the background, smallest blocks first", async () => {
		await addMemories(1, 20);
		await settled();
		// 20 memories: ten pairs, five quads, two octets and one block of 16, each compressed once.
		const order = naps.map((nap) => nap.block);
		expect([...order].sort()).toEqual(
			[
				"0-1", "2-3", "4-5", "6-7", "8-9", "10-11", "12-13", "14-15", "16-17", "18-19",
				"0-3", "4-7", "8-11", "12-15", "16-19",
				"0-7", "8-15",
				"0-15",
			].sort(),
		);
		// Memories arrive while it runs, so levels interleave, but a block always comes after its halves.
		for (const [index, block] of order.entries()) {
			const [lo, last] = block.split("-").map(Number) as [number, number];
			if (last - lo + 1 === 2) continue;
			const mid = (lo + last + 1) / 2;
			expect(order.indexOf(`${lo}-${mid - 1}`)).toBeLessThan(index);
			expect(order.indexOf(`${mid}-${last}`)).toBeLessThan(index);
		}
		// Blocks up to 16 are compressed from the raw memories.
		const sixteen = naps.find((nap) => nap.block === "0-15")!.prompt;
		expect(sixteen).toContain("Ana is the user's sister.");
		expect(sixteen).toContain("fact 15");
		expect(sixteen).not.toContain("fact 16");

		const zoomed = (await api("/memory/tree/0-15")).body;
		expect(zoomed).toMatchObject({
			summary: "S[0-15]",
			halves: [{ block: "0-7", summary: "S[0-7]" }, { block: "8-15", summary: "S[8-15]" }],
		});
	});

	it("shows a fixed-size view: summaries for the past, the newest memories verbatim", async () => {
		const { body } = await api("/memory");
		expect(body.count).toBe(20);
		const view = body.view as string[];
		expect(view).toHaveLength(8);
		const expected = cover(20, 8).map(([lo, hi]) =>
			hi - lo === 1 ? expect.stringMatching(new RegExp(`^#${lo} \\S+ fact ${lo}$`)) : `#${lo}-${hi - 1} S[${lo}-${hi - 1}]`,
		);
		expect(view).toEqual(expected);
		expect(view.at(-1)).toMatch(/^#19 \S+ fact 19$/);
	});

	it("builds blocks above 16 from their two halves", async () => {
		await addMemories(20, 33);
		await settled();
		const prompt = naps.find((nap) => nap.block === "0-31")!.prompt;
		expect(prompt).toContain("#0-15 S[0-15]");
		expect(prompt).toContain("#16-31 S[16-31]");
		expect(prompt).not.toContain("fact 3");
	});

	it("puts the view in the conversation's prompt and lets the model recall and zoom", async () => {
		let prompt = "";
		let results = "";
		faux.setResponses([
			(context) => {
				prompt = systemText(context.messages).at(-1) ?? "";
				return fauxAssistantMessage(
					[fauxToolCall("recall", { pattern: "sister|fact 3[12]" }), fauxToolCall("zoom", { block: "0-15" })],
					{ stopReason: "toolUse" },
				);
			},
			(context) => {
				results = JSON.stringify(context.messages.filter((message) => message.role === "toolResult"));
				return fauxAssistantMessage("Ana, of course.");
			},
		]);
		await say("Who is my sister?", (await post("/sessions")).body.id);
		expect(prompt).toMatch(/^<memory count="33" epoch="0">/);
		// cover(33, 8) is #0-7, #8-15, #16-23, #24-27, #28-29, then #30, #31 and #32 verbatim.
		expect(prompt).toContain("#0-7 S[0-7]\n#8-15 S[8-15]\n#16-23 S[16-23]\n#24-27 S[24-27]\n#28-29 S[28-29]\n#30 ");
		expect(prompt).toContain("fact 32");
		// Recall searches the raw log, oldest match first in its answer.
		expect(results).toMatch(/#0 \S+ Ana is the user's sister\.\\n#31 \S+ fact 31\\n#32 \S+ fact 32\\n3 matches\./);
		expect(results).toContain("#0-7 S[0-7]\\n#8-15 S[8-15]");
	});

	it("keeps a conversation's view, listing memories from elsewhere in a small section", async () => {
		const session = (await post("/sessions")).body.id;
		const seen: { memory: (string | null)[]; since: (string | null)[] }[] = [];
		faux.setResponses([capture(seen)]);
		await say("one", session);
		expect(seen[0]!.memory).toHaveLength(1);
		expect(seen[0]!.since).toEqual([]);
		const base = await memoryCount();

		// A memory from outside the conversation: the view stays, and one short section lists it.
		await addMemories(base, base + 1);
		faux.setResponses([capture(seen)]);
		await say("two", session);
		expect(seen[1]!.memory).toEqual(seen[0]!.memory);
		expect(seen[1]!.since).toEqual([
			expect.stringMatching(new RegExp(`^<memory_since>\\nMemories recorded elsewhere since your memory view:\\n#${base} \\S+ fact ${base}\\n</memory_since>$`)),
		]);

		// The conversation's own note is in its transcript already: nothing is re-sent for it.
		faux.setResponses([toolUse("note", { text: "Noted in this conversation." }), capture(seen)]);
		await say("Remember this.", session);
		expect(seen[2]!.memory).toEqual(seen[0]!.memory);
		expect(seen[2]!.since).toEqual(seen[1]!.since);
		await settled();
	});

	it("re-renders the view once too many memories from elsewhere pile up", async () => {
		const session = (await post("/sessions")).body.id;
		const seen: { memory: (string | null)[]; since: (string | null)[] }[] = [];
		faux.setResponses([capture(seen)]);
		await say("one", session);
		const base = await memoryCount();
		// With an 8-line view, up to 4 are listed separately.
		await addMemories(base, base + 4);
		faux.setResponses([capture(seen)]);
		await say("two", session);
		expect(seen[1]!.memory).toHaveLength(1);
		expect(seen[1]!.since.at(-1)).toContain(`fact ${base + 3}`);

		await addMemories(base + 4, base + 5);
		faux.setResponses([capture(seen)]);
		await say("three", session);
		// One fresh copy of the view, and the list is withdrawn.
		expect(seen[2]!.memory).toHaveLength(2);
		expect(seen[2]!.memory[1]).toMatch(new RegExp(`^<memory count="${base + 5}" epoch="0">`));
		expect(seen[2]!.since.at(-1)).toBeNull();
		await settled();
	});

	it("gets a fresh view from a compaction, which re-sends every section anyway", async () => {
		const session = (await post("/sessions")).body.id;
		const seen: { memory: (string | null)[]; since: (string | null)[] }[] = [];
		faux.setResponses([capture(seen)]);
		await say("one", session);
		const before = seen[0]!.memory[0]!;
		faux.setResponses([toolUse("note", { text: "Noted before the compaction." }), fauxAssistantMessage("Noted.")]);
		await say("Remember this.", session);
		await settled();

		faux.setResponses([fauxAssistantMessage("The user said one, then asked to remember something.")]);
		await runInDurableObject(env.Pim.getByName(AGENT_NAME), async (instance: Pim) => {
			const pi = await instance.harness.pi();
			const conversation = (await pi.conversation(Number(session) as never, BACKGROUND_CONTEXT))!;
			const task = await pi.waitForTask(await conversation.compact(undefined, BACKGROUND_CONTEXT), BACKGROUND_CONTEXT);
			const outcome = task.state.outcome;
			expect(outcome.status).toBe("completed");
			const placed = (outcome as { result: { submissionId?: never } }).result.submissionId;
			expect(placed).toBeDefined();
			await (await pi.submission(placed!, BACKGROUND_CONTEXT))!.wait(BACKGROUND_CONTEXT);
		});

		faux.setResponses([capture(seen)]);
		await say("after", session);
		// The old copy is gone with the compacted entries; the one copy left is current.
		const count = await memoryCount();
		expect(seen[1]!.memory).toHaveLength(1);
		expect(seen[1]!.memory[0]).toMatch(new RegExp(`^<memory count="${count}" epoch="0">`));
		expect(seen[1]!.memory[0]).not.toBe(before);
		expect(seen[1]!.memory[0]).toContain("Noted before the compaction.");
	});

	it("forgets for good: the memory, its summaries, and the conversation's view", async () => {
		const session = (await post("/sessions")).body.id;
		faux.setResponses([fauxAssistantMessage("hi")]);
		await say("hi", session);
		const before = naps.length;

		faux.setResponses([toolUse("forget", { id: 5 }), fauxAssistantMessage("Forgotten.")]);
		await say("Forget fact 5.", session);
		await settled();

		expect((await api("/memory/log?before=6&limit=1")).body.entries).toEqual([
			{ id: 5, date: expect.any(String), text: "", forgotten: true, source: null },
		]);
		expect((await api("/memory/log?q=fact%205$")).body.total).toBe(0);
		// Exactly the summaries over #5 were rebuilt, and none of them saw it.
		const rebuilt = naps.slice(before);
		expect(rebuilt.map((nap) => nap.block)).toEqual(["4-5", "4-7", "0-7", "0-15", "0-31"]);
		expect(rebuilt[0]!.prompt).toMatch(/#5 \S+ \(forgotten at the user's request\)/);
		for (const nap of rebuilt) expect(nap.prompt).not.toMatch(/fact 5$/m);

		// The next request replaces the conversation's view, even with no new memories.
		let latest = "";
		faux.setResponses([
			(context) => {
				latest = systemText(context.messages).at(-1)!;
				return fauxAssistantMessage("ok");
			},
		]);
		await say("still there?", session);
		expect(latest).toMatch(new RegExp(`^<memory count="${await memoryCount()}" epoch="1">`));
	});

	it("discards a summary written from memories forgotten while it was being written", async () => {
		// The secret must complete a pair, so its block is compressed as soon as it is recorded.
		if ((await memoryCount()) % 2 === 0) await addMemories(1000, 1001);
		await settled();
		const id = await memoryCount();
		const block = `${id - 1}-${id}`;
		let release!: (answer: string) => void;
		held.set(block, new Promise((resolve) => (release = resolve)));
		const before = naps.length;
		expect((await post("/memory/log", { text: "the secret plan" })).body.id).toBe(id);
		await vi.waitFor(() => expect(held.has(block)).toBe(false));

		expect((await api(`/memory/log/${id}`, { method: "DELETE" })).status).toBe(200);
		release(`S[${block}] mentions the secret plan`);
		await settled();

		const attempts = naps.slice(before).filter((nap) => nap.block === block);
		expect(attempts).toHaveLength(2);
		expect(attempts[1]!.prompt).not.toContain("the secret plan");
		expect((await api(`/memory/tree/${block}`)).body.summary).toBe(`S[${block}]`);
	});

	it("validates the memory API", async () => {
		expect((await post("/memory/log", { text: "" })).status).toBe(400);
		expect((await post("/memory/log", { text: "a\nb" })).status).toBe(400);
		expect((await post("/memory/log", { text: "é".repeat(141) })).status).toBe(400);
		expect((await api("/memory/log/999", { method: "DELETE" })).status).toBe(404);
		expect((await api("/memory/log?q=(")).status).toBe(400);
		expect((await api("/memory/tree/5-6")).status).toBe(400);
	});
});
