import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { createModels } from "@earendil-works/pi-ai";
import { fauxAssistantMessage, fauxProvider } from "@earendil-works/pi-ai/providers/faux";
import { type Conversation, createRegistry, defineExtension, defineTask, type EntryRecord, type EntryId, Harness, type TaskId } from "@earendil-works/pi-durable";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";

const ctx = BACKGROUND_CONTEXT;

/** The root-attached background task Pim registers (`optmem.nap`), reduced to a sleeping state machine. */
export const NapTask = defineTask<{ note: string }, { phase: "sleep" }, string>({
	name: "optmem.nap",
	version: 1,
	initial: () => ({ phase: "sleep" }),
	phases: {
		sleep: async (_task, runtime, context) => {
			await runtime.sleep(Date.now() + 3_600_000, context);
		},
	},
	abort: async (_task, runtime, context) => {
		await runtime.commit(() => ({ status: "terminal", outcome: { status: "aborted" } }), context);
	},
});

export type LegacyFixture = {
	path: string;
	ids: {
		root: number;
		chat: number;
		fork1: number;
		fork2: number;
		seat1: number;
		seat2: number;
		delegated: number;
		continuation: number;
		napTask: number;
	};
};

/** A realistic legacy space, built by really running pi-durable over a SQLite file: the single storage a space has today. */
export async function buildLegacySpace(): Promise<LegacyFixture> {
	const path = join(mkdtempSync(join(tmpdir(), "pim-legacy-")), "space.sqlite");
	const faux = fauxProvider({ provider: "faux", models: [{ id: "m" }] });
	const models = createModels();
	models.setProvider(faux.provider);
	const registry = createRegistry();
	registry.install(defineExtension({ name: "optmem", tasks: [NapTask] }));
	const storage = await openNodeSqliteStorage(path);
	const harness = await Harness.open(storage, { models, registry }, ctx);
	const agent = { model: { provider: "faux", modelId: "m" } };
	const ask = async (conversation: Conversation, text: string, answer: string): Promise<void> => {
		faux.appendResponses([fauxAssistantMessage(answer)]);
		const submission = await conversation.submit({ type: "input", content: text }, ctx);
		const settled = await submission.wait(ctx);
		if (settled.status !== "done") throw new Error(`turn failed: ${JSON.stringify(settled)}`);
	};
	const answerEntry = async (conversation: Conversation, n: number): Promise<EntryId> => {
		const page = await conversation.entries({ order: "ascending" }, 100, undefined, ctx);
		const answers = page.items.filter((e: EntryRecord) => e.kind === "pi.assistant");
		return answers[n]!.id;
	};

	const root = await harness.root(ctx, { agent });
	const napTask = await root.commit((tx) => tx.createTask(NapTask, { note: "tidy memory" }, { ownership: { kind: "conversation" }, background: true }), ctx);
	await ask(root, "hello root", "root answer");

	// One chat with a branching fork tree whose agent changes after the forks, so forked documents diverge.
	const chat = await harness.createConversation({ ownership: { kind: "ownerless" }, agent }, ctx);
	await ask(chat, "a1", "A1");
	await ask(chat, "a2", "A2");
	const fork1 = await chat.fork(await answerEntry(chat, 0), { ownership: { kind: "ownerless" } }, ctx);
	await ask(fork1, "f1", "F1");
	const fork2 = await fork1.fork(await answerEntry(fork1, 1), { ownership: { kind: "ownerless" } }, ctx);
	await ask(fork2, "g1", "G1");
	await chat.configure({ instructions: "changed after the forks" }, ctx);
	await ask(chat, "a3", "A3");

	// A group chat: one seat per agent, a message written across by request id.
	const seat1 = await harness.createConversation({ ownership: { kind: "ownerless" }, agent }, ctx);
	const seat2 = await harness.createConversation({ ownership: { kind: "ownerless" }, agent }, ctx);
	await ask(seat1, "room: hi", "seat1 reply");
	await seat2.submit({ type: "write", entry: { kind: "pim.room", data: { from: "seat1", text: "seat1 reply" } }, requestId: "room-1" }, ctx);
	await ask(seat2, "room: and you?", "seat2 reply");

	// A delegated task chat, and a post-idle summary continuation seeded by an init commit.
	const delegated = await harness.createConversation({ ownership: { kind: "ownerless" }, agent }, ctx);
	await ask(delegated, "do the errand", "errand done");
	const continuation = await harness.createConversation({
		ownership: { kind: "ownerless" },
		agent,
		init: async (tx, id) => {
			await tx.appendEntry(id, { kind: "pim.summary", model: [{ role: "user", content: "Summary of the earlier chat: A1, A2, A3", timestamp: 1 }] });
		},
	}, ctx);
	await ask(continuation, "carry on", "carrying on");

	await harness.close(ctx);
	return {
		path,
		ids: { root: root.id, chat: chat.id, fork1: fork1.id, fork2: fork2.id, seat1: seat1.id, seat2: seat2.id, delegated: delegated.id, continuation: continuation.id, napTask: napTask as TaskId as number },
	};
}
