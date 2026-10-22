import type { Message } from "@earendil-works/pi-ai";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { env, runInDurableObject } from "cloudflare:test";
import { describe, expect, it, vi } from "vitest";
import type { Agent } from "../src/agents";
import { CircleStore } from "../src/circles";
import { cover } from "../src/extensions/optmem/cover";
import { OptMemStore } from "../src/extensions/optmem/store";
import { api, lastUserText, OWNER, pendingApproval, post, say, scripts, settled as idle, toolUse } from "./helpers";
import { faux, napper, type Pim } from "./worker";

/**
 * One space for the whole file: the tests build on each other's memories,
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
		return toolUse("send_to_user", { message: "ok" });
	};
}

async function memoryCount(): Promise<number> {
	return (await api("/memory")).body.count;
}

describe("long-term memory", () => {
	it("records a note from the conversation", async () => {
		faux.setResponses([toolUse("note", { text: "Ana is the user's sister." }), toolUse("send_to_user", { message: "Noted." })]);
		await say("My sister Ana is visiting.");
		const { body } = await api("/memory/log");
		expect(body.entries).toEqual([
			{ id: 0, date: expect.stringMatching(/^\d{4}-\d{2}-\d{2}$/), text: "Ana is the user's sister.", forgotten: false, source: "1", scope: "private" },
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
				return toolUse("send_to_user", { message: "Oops." });
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

		const zoomed = (await api("/memory/tree/private/0-15")).body;
		expect(zoomed).toMatchObject({
			summary: "S[0-15]",
			halves: [{ block: "0-7", summary: "S[0-7]" }, { block: "8-15", summary: "S[8-15]" }],
		});
	});

	it("shows a fixed-size view: summaries for the past, the newest memories verbatim", async () => {
		const { body } = await api("/memory");
		expect(body.count).toBe(20);
		const view = body.view as string[];
		// The majordomo's view: its own scope, which holds them all and so has all 8 lines, then the empty one every agent reads.
		expect(view).toHaveLength(11);
		const expected = cover(20, 8).map(([lo, hi]) =>
			hi - lo === 1 ? expect.stringMatching(new RegExp(`^#${lo} \\S+ fact ${lo}$`)) : `#private/${lo}-${hi - 1} S[${lo}-${hi - 1}]`,
		);
		expect(view).toEqual(["Scope private, your own: only you read it:", ...expected, "Scope everyone, which all of the person's agents read:", "(nothing yet)"]);
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
					[fauxToolCall("recall", { pattern: "sister|fact 3[12]" }), fauxToolCall("zoom", { block: "private/0-15" })],
					{ stopReason: "toolUse" },
				);
			},
			(context) => {
				results = JSON.stringify(context.messages.filter((message) => message.role === "toolResult"));
				return toolUse("send_to_user", { message: "Ana, of course." });
			},
		]);
		await say("Who is my sister?", (await post("/sessions")).body.id);
		expect(prompt).toMatch(/^<memory scopes="private:33 everyone:0" epoch="0">/);
		// cover(33, 8) is #0-7, #8-15, #16-23, #24-27, #28-29, then #30, #31 and #32 verbatim.
		expect(prompt).toContain("#private/0-7 S[0-7]\n#private/8-15 S[8-15]\n#private/16-23 S[16-23]\n#private/24-27 S[24-27]\n#private/28-29 S[28-29]\n#30 ");
		expect(prompt).toContain("fact 32");
		// Recall searches the raw log, oldest match first in its answer.
		expect(results).toMatch(/#0 \S+ Ana is the user's sister\.\\n#31 \S+ fact 31\\n#32 \S+ fact 32\\n3 matches\./);
		expect(results).toContain("#private/0-7 S[0-7]\\n#private/8-15 S[8-15]");
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
		expect(seen[2]!.memory[1]).toMatch(new RegExp(`^<memory scopes="private:${base + 5} everyone:0" epoch="0">`));
		expect(seen[2]!.since.at(-1)).toBeNull();
		await settled();
	});

	it("gets a fresh view from a compaction, which re-sends every section anyway", async () => {
		const session = (await post("/sessions")).body.id;
		const seen: { memory: (string | null)[]; since: (string | null)[] }[] = [];
		faux.setResponses([capture(seen)]);
		await say("one", session);
		const before = seen[0]!.memory[0]!;
		faux.setResponses([toolUse("note", { text: "Noted before the compaction." }), toolUse("send_to_user", { message: "Noted." })]);
		await say("Remember this.", session);
		await settled();

		faux.setResponses([fauxAssistantMessage("The user said one, then asked to remember something.")]);
		await runInDurableObject(env.Pim.getByName(OWNER), async (instance: Pim) => {
			const pi = await instance.harness.pi();
			const conversation = (await pi.conversation(Number(instance.store.sessionOf(session)) as never, BACKGROUND_CONTEXT))!;
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
		expect(seen[1]!.memory[0]).toMatch(new RegExp(`^<memory scopes="private:${count} everyone:0" epoch="0">`));
		expect(seen[1]!.memory[0]).not.toBe(before);
		expect(seen[1]!.memory[0]).toContain("Noted before the compaction.");
	});

	it("forgets for good: the memory, its summaries, and the conversation's view", async () => {
		const session = (await post("/sessions")).body.id;
		faux.setResponses([toolUse("send_to_user", { message: "hi" })]);
		await say("hi", session);
		const before = naps.length;

		faux.setResponses([toolUse("forget", { id: 5 }), toolUse("send_to_user", { message: "Forgotten." })]);
		await say("Forget fact 5.", session);
		await settled();

		expect((await api("/memory/log?before=6&limit=1")).body.entries).toEqual([
			{ id: 5, date: expect.any(String), text: "", forgotten: true, source: null, scope: "private" },
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
				return toolUse("send_to_user", { message: "ok" });
			},
		]);
		await say("still there?", session);
		expect(latest).toMatch(new RegExp(`^<memory scopes="private:${await memoryCount()} everyone:0" epoch="1">`));
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
		expect((await api(`/memory/tree/private/${block}`)).body.summary).toBe(`S[${block}]`);
	});

	it("validates the memory API", async () => {
		expect((await post("/memory/log", { text: "" })).status).toBe(400);
		expect((await post("/memory/log", { text: "a\nb" })).status).toBe(400);
		expect((await post("/memory/log", { text: "é".repeat(141) })).status).toBe(400);
		expect((await api("/memory/log/999", { method: "DELETE" })).status).toBe(404);
		expect((await api("/memory/log?q=(")).status).toBe(400);
		expect((await api("/memory/tree/private/5-6")).status).toBe(400);
	});
});

/** What a model was sent in one request: its latest memory view, and the tool results it had. */
type Seen = { memory: string; since: string; results: string };

function seen(context: { messages: Message[] }): Seen {
	return {
		memory: systemText(context.messages).at(-1) ?? "",
		since: patches(context.messages, "memory_since").at(-1) ?? "",
		results: JSON.stringify(context.messages.filter((message) => message.role === "toolResult")),
	};
}

/** Says something in a chat whose model calls `calls`, one after another, then answers; returns what it saw first and last. */
async function ask(session: string, calls: [string, Record<string, unknown>][]): Promise<{ first: Seen; last: Seen }> {
	const views: Seen[] = [];
	faux.setResponses([
		...calls.map(([name, args]) => (context: { messages: Message[] }) => {
			views.push(seen(context));
			return toolUse(name, args as never);
		}),
		(context: { messages: Message[] }) => {
			views.push(seen(context));
			return toolUse("send_to_user", { message: "ok" });
		},
	]);
	await say("go", session);
	return { first: views[0]!, last: views.at(-1)! };
}

describe("memory scopes", () => {
	let gamer: Agent;
	let coder: Agent;
	let gamerChat: string;
	let coderChat: string;

	it("keeps an agent's notes in its own scope, and shows each agent only the scopes it reads", async () => {
		gamer = (await post("/agents", { name: "Gamer" })).body;
		coder = (await post("/agents", { name: "Coder" })).body;
		expect([gamer.memoryScope, coder.memoryScope]).toEqual([`agent-${gamer.id}`, `agent-${coder.id}`]);
		gamerChat = (await post("/sessions", { agent: gamer.id })).body.id;
		coderChat = (await post("/sessions", { agent: coder.id })).body.id;

		const noted = await ask(gamerChat, [["note", { text: "The Minecraft world seed is 4417." }]]);
		expect(noted.last.results).toContain(`in ${gamer.memoryScope}.`);
		expect((await api(`/memory/log?scope=${gamer.memoryScope}`)).body.entries).toEqual([
			expect.objectContaining({ text: "The Minecraft world seed is 4417.", scope: gamer.memoryScope }),
		]);

		// The coder reads its own scope and everyone's: none of the majordomo's memories, nor the gamer's.
		const { first, last } = await ask(coderChat, [
			["recall", { pattern: "sister|4417" }],
			["zoom", { block: "private/0-15" }],
			["forget", { id: 0 }],
		]);
		expect(first.memory).toMatch(new RegExp(`^<memory scopes="${coder.memoryScope}:0 everyone:0" epoch="\\d+">`));
		expect(first.memory).toContain(`Scope ${coder.memoryScope}, your own: only you and the majordomo read it:`);
		expect(first.memory).not.toMatch(/4417|sister|fact|Scope private/);
		expect(last.results).toContain("No match.");
		expect(last.results).toContain("You don't read the scope private.");
		expect(last.results).toContain("There is no memory #0.");
		expect((await api("/memory/log?q=sister")).body.total).toBe(1);

		// The majordomo reads every scope.
		const view = (await api("/memory")).body.view.join("\n");
		expect(view).toContain(`Scope ${gamer.memoryScope}, the own scope of Gamer:`);
		expect(view).toContain("The Minecraft world seed is 4417.");
		await settled();
	});

	it("lets an agent keep and move memories among the scopes it reads, and no others", async () => {
		const noted = await ask(coderChat, [
			["note", { text: "Prefers TypeScript.", scope: "everyone" }],
			["note", { text: "Earns a lot.", scope: "private" }],
		]);
		expect(noted.last.results).toContain("in everyone.");
		expect(noted.last.results).toContain("You can't keep memories in private");
		const [typescript] = (await api("/memory/log?q=TypeScript")).body.matches;
		expect(typescript.scope).toBe("everyone");
		expect((await api("/memory/log?q=Earns")).body.total).toBe(0);

		// Everyone's scope reaches the gamer's conversation.
		const told = await ask(gamerChat, []);
		expect(`${told.first.memory}${told.first.since}`).toContain("Prefers TypeScript.");

		// The coder takes it back into its own scope: the gamer no longer finds it; the majordomo's memory it can't move.
		const moved = await ask(coderChat, [
			["move_memory", { id: typescript.id, scope: coder.memoryScope }],
			["move_memory", { id: 0, scope: coder.memoryScope }],
		]);
		expect(moved.last.results).toMatch(new RegExp(`Moved #${typescript.id} to ${coder.memoryScope}, as #\\d+\\.`));
		expect(moved.last.results).toContain("There is no memory #0.");
		const recalled = await ask(gamerChat, [["recall", { pattern: "TypeScript" }]]);
		expect(recalled.last.results).toContain("No match.");
		expect((await api(`/memory/log?scope=${coder.memoryScope}`)).body.entries.map((entry: { text: string }) => entry.text)).toEqual(["Prefers TypeScript."]);
		await settled();
	});

	it("lets the person name scopes and choose which agents read them", async () => {
		expect((await post("/memory/scopes", { name: "" })).status).toBe(400);
		const work = (await post("/memory/scopes", { name: "Work" })).body;
		expect(work).toMatchObject({ key: expect.stringMatching(/^s_/), kind: "named", name: "Work", count: 0 });
		expect((await api(`/agents/${coder.id}`, { method: "PUT", body: JSON.stringify({ memoryScopes: ["s_nope"] }) })).status).toBe(400);
		const ticked = (await api(`/agents/${coder.id}`, { method: "PUT", body: JSON.stringify({ memoryScopes: [work.key] }) })).body;
		expect(ticked.memoryScopes).toEqual([work.key]);
		expect((await post("/memory/log", { text: "Works at Acme.", scope: work.key })).status).toBe(201);
		expect((await post("/memory/log", { text: "Nope.", scope: "s_nope" })).status).toBe(404);

		const coderSaw = await ask(coderChat, []);
		expect(`${coderSaw.first.memory}${coderSaw.first.since}`).toContain("Works at Acme.");
		const gamerSaw = await ask(gamerChat, [["recall", { pattern: "Acme" }]]);
		expect(gamerSaw.first.memory).not.toContain("Acme");
		expect(gamerSaw.last.results).toContain("No match.");

		// Deleted, no agent reads it, and its memory stays for the majordomo alone.
		expect((await api(`/memory/scopes/${work.key}`, { method: "DELETE" })).status).toBe(200);
		expect((await api(`/agents/${coder.id}`)).body.memoryScopes).toEqual([]);
		const { scopes, view } = (await api("/memory")).body;
		expect(scopes.find((scope: { key: string }) => scope.key === work.key)).toMatchObject({ kind: "former", count: 1, readers: [expect.any(String)] });
		expect(view.join("\n")).toContain("Works at Acme.");
		const after = await ask(coderChat, [["recall", { pattern: "Acme" }]]);
		expect(after.last.results).toContain("No match.");
		await settled();
	});

	it("lets the majordomo name a scope, and share it with an agent once the person approves", async () => {
		const chat = (await post("/sessions")).body.id;
		const made = await ask(chat, [
			["create_memory_scope", { name: "Health" }],
			["create_memory_scope", { name: "health" }],
		]);
		const health = (await api("/memory")).body.scopes.find((scope: { name: string | null }) => scope.name === "Health");
		expect(made.last.results).toContain(`Made the scope \\"Health\\", as ${health.key}.`);
		expect(made.last.results).toContain(`The scope \\"Health\\" is there already, as ${health.key}.`);
		await ask(chat, [["note", { text: "Has asthma.", scope: health.key }]]);

		// Other agents aren't offered naming or sharing scopes.
		let offered: string[] = [];
		faux.setResponses([
			(context) => {
				offered = context.messages.flatMap((message) => (message.role === "system" ? (message.toolsAdded ?? []).map((tool) => tool.name) : []));
				return toolUse("send_to_user", { message: "ok" });
			},
		]);
		await say("hi", (await post("/sessions", { agent: coder.id })).body.id);
		expect(offered).toContain("move_memory");
		expect(offered).not.toContain("create_memory_scope");
		expect(offered).not.toContain("share_memory_scope");

		// Sharing asks the person first; approved, the agent reads the scope.
		faux.setResponses([toolUse("share_memory_scope", { scope: health.key, agent: coder.id }), toolUse("send_to_user", { message: "Shared." })]);
		const said = say("Let Coder know about my health.", chat);
		const approval = await pendingApproval();
		expect(approval.summary).toBe('Let "Coder" read the memory scope "Health"');
		expect((await api(`/agents/${coder.id}`)).body.memoryScopes).toEqual([]);
		await post(`/approvals/${approval.id}/approve`);
		await said;
		expect((await api(`/agents/${coder.id}`)).body.memoryScopes).toEqual([health.key]);
		const coderSaw = await ask(coderChat, [["recall", { pattern: "asthma" }]]);
		expect(coderSaw.last.results).toContain("Has asthma.");
		await settled();
	});

	it("moves a memory through the API, rebuilding its old scope's summaries without it", async () => {
		const before = naps.length;
		const moved = (await api("/memory/log/0", { method: "PUT", body: JSON.stringify({ scope: "everyone" }) })).body;
		expect(moved).toMatchObject({ text: "Ana is the user's sister.", scope: "everyone" });
		expect(moved.id).toBeGreaterThan(0);
		await settled();
		expect((await api("/memory/log?q=sister")).body.matches.map((entry: { id: number }) => entry.id)).toEqual([moved.id]);
		// The private scope's summaries over its old place were rebuilt, and none of them saw it; everyone's has it now.
		const rebuilt = naps.slice(before).filter((nap) => nap.prompt.includes("of the scope private"));
		expect(rebuilt.map((nap) => nap.block)).toEqual(["0-1", "0-3", "0-7", "0-15", "0-31"]);
		expect(rebuilt[0]!.prompt).toContain("#0 2");
		expect(rebuilt[0]!.prompt).toContain("(moved to another scope)");
		for (const nap of rebuilt) expect(nap.prompt).not.toContain("sister");
		expect(naps.slice(before).find((nap) => nap.prompt.includes("of the scope everyone"))?.prompt).toContain("Ana is the user's sister.");
		const found = await ask(gamerChat, [["recall", { pattern: "sister" }]]);
		expect(found.last.results).toContain("Ana is the user's sister.");

		expect((await api("/memory/log/0", { method: "PUT", body: JSON.stringify({ scope: "everyone" }) })).status).toBe(404);
		expect((await api("/memory/log/5", { method: "PUT", body: JSON.stringify({ scope: "everyone" }) })).status).toBe(409);
		expect((await api(`/memory/log/${moved.id}`, { method: "PUT", body: JSON.stringify({ scope: "nowhere" }) })).status).toBe(404);
	});

	it("gives a task the memory of the agent doing it, not of the one that handed it out", async () => {
		await post("/memory/log", { text: "Saving for a new car." });
		const chat = (await post("/sessions")).body.id;
		let task = "";
		scripts({
			lead: [
				() => toolUse("delegate", { tasks: [{ to: "Gamer", task: "What is my world seed?" }] }),
				() => toolUse("send_to_user", { message: "Asked Gamer." }),
				() => toolUse("send_to_user", { message: "It's 4417." }),
			],
			Gamer: [
				(context) => {
					task = seen(context).memory;
					return fauxAssistantMessage("4417");
				},
			],
		});
		await say("What's my seed?", chat);
		await idle(chat);
		expect(task).toMatch(new RegExp(`^<memory scopes="${gamer.memoryScope}:1 everyone:\\d+"`));
		expect(task).toContain("The Minecraft world seed is 4417.");
		expect(task).not.toContain("new car");
		await settled();
	});

	it("puts memories from before scopes in the private scope, keeping their summaries, and gives circles that read memory everyone's", async () => {
		await runInDurableObject(env.Pim.getByName("memory-before-scopes"), (_instance: Pim, state) => {
			const sql = state.storage.sql;
			sql.exec("DROP TABLE optmem_log");
			sql.exec("DROP TABLE optmem_tree");
			sql.exec("CREATE TABLE optmem_log (id INTEGER PRIMARY KEY, key TEXT UNIQUE, date TEXT NOT NULL, text TEXT NOT NULL, forgotten INTEGER NOT NULL DEFAULT 0, source TEXT)");
			sql.exec("CREATE TABLE optmem_tree (size INTEGER NOT NULL, lo INTEGER NOT NULL, text TEXT NOT NULL, PRIMARY KEY (size, lo))");
			for (const [id, text] of ["one", "two", "three"].entries()) sql.exec("INSERT INTO optmem_log (id, key, date, text) VALUES (?, ?, '2026-01-01', ?)", id, `k${id}`, text);
			sql.exec("INSERT INTO optmem_tree (size, lo, text) VALUES (2, 0, 'one and two')");
			const store = new OptMemStore(sql);
			expect(store.entries("private", 0, 3).map((entry) => [entry.id, entry.text, entry.scope])).toEqual([
				[0, "one", "private"],
				[1, "two", "private"],
				[2, "three", "private"],
			]);
			expect(store.summary("private", [0, 2])).toBe("one and two");
			expect(store.append("four", "2026-01-02", { scope: "everyone" })).toMatchObject({ id: 3, scope: "everyone" });
			expect(store.size("private")).toBe(3);

			const circles = new CircleStore(sql);
			const reads = circles.createCircle("Family");
			const not = circles.createCircle("Friends");
			sql.exec("ALTER TABLE pim_circles DROP COLUMN memory_scopes");
			sql.exec("INSERT INTO pim_tool_permissions (audience, app, tool, permission, definition, updated_at) VALUES (?, '', 'memory', 'on', NULL, 1), (?, '', 'memory', 'off', NULL, 1)", reads.id, not.id);
			const migrated = new CircleStore(sql);
			expect(migrated.circles().map((circle) => [circle.name, circle.memoryScopes]).sort()).toEqual([
				["Family", ["everyone"]],
				["Friends", []],
			]);
			expect(sql.exec("SELECT COUNT(*) AS n FROM pim_tool_permissions WHERE tool = 'memory'").one().n).toBe(0);
		});
	});
});

