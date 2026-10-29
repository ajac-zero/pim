import { BACKGROUND_CONTEXT as context } from "@earendil-works/chord/context";
import { type AssistantMessage, Type } from "@earendil-works/pi-ai";
import { createModels } from "@earendil-works/pi-ai/models";
import { fauxAssistantMessage, fauxProvider, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import {
	type Conversation,
	type ConversationId,
	createRegistry,
	defineExtension,
	defineTool,
	Harness,
	LiveDoc,
	type Storage,
	type TaskId,
	ToolTask,
} from "@earendil-works/pi-durable";
import { MemoryStorage } from "@earendil-works/pi-durable/storage/memory";
import { describe, expect, it } from "vitest";

/**
 * Run identity in Pim's local pi-durable patch (patches/@earendil-works__pi-durable@1.1.0.patch,
 * docs/pi-durable-run-identity.md), on the real harness over its in-memory storage, with a scripted
 * model. A run ID is minted only when a run starts, kept by its tool tasks for good, kept across
 * handover, steering, `onYield`, suspension and a restart, and ended with the run.
 */

const faux = fauxProvider({ provider: "runs", models: [{ id: "runs-model" }] });
const MODEL = { provider: "runs", modelId: "runs-model" };

type Seen = { taskId: TaskId; runId: unknown; current: unknown };

/** A storage that outlives the harness that closes it, so a second harness opens what the first left, as after a restart. */
function durable(storage: Storage = new MemoryStorage()): Storage {
	return new Proxy(storage, { get: (target, key) => (key === "close" ? async () => undefined : Reflect.get(target, key, target)) });
}

/** One harness over `storage`, with `probe`, which reads its own task and the run in one commit, and `wait`, which suspends until woken. */
async function open(storage: Storage, options: { onYield?: (answer: AssistantMessage) => string | undefined } = {}) {
	const seen: Seen[] = [];
	const read = async (api: { taskId: TaskId; conversationId: ConversationId; commit: Function }) =>
		api.commit(async (tx: { task(id: TaskId): Promise<{ input: unknown } | undefined>; run(id: ConversationId): Promise<unknown> }) => {
			const task = await tx.task(api.taskId);
			seen.push({ taskId: api.taskId, runId: (task?.input as { runId?: unknown }).runId, current: await tx.run(api.conversationId) });
			return undefined;
		}, context);
	const probe = defineTool({
		name: "probe",
		description: "Reads its run.",
		parameters: Type.Object({}),
		async execute(_args, api) {
			await read(api as never);
			return { content: [{ type: "text", text: "probed" }] };
		},
	});
	const wait = defineTool({
		name: "wait",
		description: "Waits until woken.",
		parameters: Type.Object({}),
		replay: "safe",
		async execute(_args, api, ctx) {
			await read(api as never);
			const woken = await api.memo<boolean>("woken", ctx);
			if (woken) return { content: [{ type: "text", text: "woken" }] };
			await api.memo("woken", true, ctx);
			return { control: { suspend: true } };
		},
	});
	const models = createModels();
	models.setProvider(faux.provider);
	const registry = createRegistry();
	const hooks = options.onYield
		? [{ task: "pi.generation", handlers: { onYield: (answer: AssistantMessage) => ({ continue: options.onYield!(answer) }) } }]
		: [];
	registry.install(defineExtension({ name: "runs", tools: [probe, wait], hooks }));
	const harness = await Harness.open(storage, { models, registry }, context);
	const root = await harness.root(context, { agent: { model: MODEL } });
	return { harness, root, seen };
}

const call = (name: string) => fauxAssistantMessage(fauxToolCall(name, {}), { stopReason: "toolUse" });
const say = (text: string) => fauxAssistantMessage(text);

async function runOf(harness: Harness, conversation: Conversation) {
	return harness.commit((tx) => tx.run(conversation.id), context);
}

async function toolTasks(harness: Harness) {
	const { tasks } = await harness.inspect(context);
	return tasks.filter(({ record }) => record.kind === "pi.tool").map(({ record }) => record);
}

async function settle(harness: Harness, conversation: Conversation) {
	await conversation.waitForIdle(context);
	await harness.waitForIdle(context);
}

describe("run identity in the local pi-durable patch", () => {
	it("mints one ID per run, which every tool task of the run carries and the run keeps across its tool rounds", async () => {
		const { harness, root, seen } = await open(durable());
		faux.setResponses([call("probe"), call("probe"), say("one"), call("probe"), say("two")]);
		await (await root.submit({ type: "input", content: "first" }, context)).wait(context);
		await (await root.submit({ type: "input", content: "second" }, context)).wait(context);
		await settle(harness, root);
		expect(seen).toHaveLength(3);
		const [a, b, c] = seen;
		// Each tool task carries the run that created it, and reads that same run as current in its own commit.
		for (const each of seen) expect(each.current).toEqual({ id: each.runId, taskId: expect.any(Number) });
		expect(typeof a!.runId).toBe("number");
		// The first run's two rounds share its ID, handed from generation to generation; the second run has its own.
		expect(b!.runId).toBe(a!.runId);
		expect(c!.runId).not.toBe(a!.runId);
		// Not equal by construction to a task: the ID is minted apart from them.
		expect(seen.map((each) => each.taskId)).not.toContain(a!.runId);
		// Idle, there is no run.
		expect(await runOf(harness, root)).toBeUndefined();
		await harness.close(context);
	});

	it("keeps the ID through steering, an onYield continuation, suspension and a restart, and the tool task keeps it after", async () => {
		const storage = durable();
		let continued = false;
		const first = await open(storage, { onYield: () => (continued ? undefined : ((continued = true), "go on")) });
		faux.setResponses([call("wait")]);
		const asked = await first.root.submit({ type: "input", content: "start" }, context);
		await expect.poll(async () => (await toolTasks(first.harness)).some((task) => task.state.status === "waiting"), { timeout: 5_000 }).toBe(true);
		const run = await runOf(first.harness, first.root);
		expect(run).toMatchObject({ id: expect.any(Number) });
		const [suspended] = await toolTasks(first.harness);
		expect((suspended!.input as { runId?: number }).runId).toBe((run as { id: number }).id);

		// A steering input joins the run waiting on the suspended call; nothing is minted.
		await first.root.submit({ type: "input", content: "steer", whenBusy: "steer" }, context);
		expect(await runOf(first.harness, first.root)).toEqual(run);
		await first.harness.close(context);

		// Restarted: the same run, the same call, which is woken and reruns.
		const second = await open(storage, { onYield: () => (continued ? undefined : ((continued = true), "go on")) });
		expect(await runOf(second.harness, second.root)).toEqual(run);
		faux.setResponses([call("probe"), say("done"), call("probe"), say("after the continuation")]);
		await second.harness.resumeTask(suspended!.id as TaskId, context);
		await second.root.waitForIdle(context);
		void asked;
		await settle(second.harness, second.root);
		const ids = second.seen.map((each) => each.runId);
		// The woken call, the next round after the steer, and the round after the onYield continuation: one run.
		expect(ids.length).toBeGreaterThanOrEqual(3);
		expect(new Set(ids)).toEqual(new Set([(run as { id: number }).id]));
		expect(continued).toBe(true);
		expect((await second.harness.getTask(suspended!.id as TaskId, context))?.input).toMatchObject({ runId: (run as { id: number }).id });
		await second.harness.close(context);
	});

	it("ends the ID with the run: an abort and a reset each leave none, and the next run gets a new one", async () => {
		const { harness, root } = await open(durable());
		faux.setResponses([call("wait")]);
		await root.submit({ type: "input", content: "start" }, context);
		await expect.poll(async () => (await runOf(harness, root)) !== undefined, { timeout: 5_000 }).toBe(true);
		const aborted = (await runOf(harness, root)) as { id: number };
		await root.abort(context);
		await settle(harness, root);
		expect(await runOf(harness, root)).toBeUndefined();

		faux.setResponses([call("wait")]);
		await root.submit({ type: "input", content: "again" }, context);
		await expect.poll(async () => (await runOf(harness, root)) !== undefined, { timeout: 5_000 }).toBe(true);
		const next = (await runOf(harness, root)) as { id: number };
		expect(next.id).not.toBe(aborted.id);
		// A reset queued while the call waits ends the run at the next boundary.
		await expect.poll(async () => (await toolTasks(harness)).some((task) => task.state.status === "waiting"), { timeout: 5_000 }).toBe(true);
		const resetting = root.reset(undefined, context);
		const [waiting] = (await toolTasks(harness)).filter((task) => task.state.status === "waiting");
		await harness.resumeTask(waiting!.id as TaskId, context);
		await resetting;
		await settle(harness, root);
		expect(await runOf(harness, root)).toBeUndefined();
		await harness.close(context);
	});

	it("fails closed on a run begun before run IDs: it reads as null, and its calls carry none", async () => {
		const { harness, root, seen } = await open(durable());
		faux.setResponses([call("wait")]);
		await root.submit({ type: "input", content: "start" }, context);
		await expect.poll(async () => (await toolTasks(harness)).some((task) => task.state.status === "waiting"), { timeout: 5_000 }).toBe(true);
		// As a run stored before the patch: run control without an ID.
		await harness.commit(async (tx) => {
			const live = await tx.doc(LiveDoc, root.id);
			delete (live.run as { id?: unknown }).id;
		}, context);
		expect(await runOf(harness, root)).toEqual({ id: null, taskId: expect.any(Number) });
		faux.setResponses([call("probe"), say("done")]);
		const [suspended] = await toolTasks(harness);
		await harness.resumeTask(suspended!.id as TaskId, context);
		await settle(harness, root);
		// The next round's call was made under the legacy run: no ID was filled in for it, or for the run.
		expect(seen.at(-1)).toMatchObject({ runId: undefined, current: { id: null } });
		await harness.close(context);
	});

	it("migrates a call stored before run IDs without adding one", async () => {
		expect(ToolTask.definition.version).toBe(2);
		const input = { assistant: 7, callId: "call-1" };
		expect(ToolTask.definition.migrate!(input, { phase: "call" }, 1)).toEqual({ input: { assistant: 7, callId: "call-1" }, checkpoint: { phase: "call" } });

		// A version-1 call stored mid-run: the harness migrates it and runs it, and it still carries no run.
		const storage = durable();
		const first = await open(storage);
		faux.setResponses([call("wait")]);
		await first.root.submit({ type: "input", content: "start" }, context);
		await expect.poll(async () => (await toolTasks(first.harness)).some((task) => task.state.status === "waiting"), { timeout: 5_000 }).toBe(true);
		const [stored] = await toolTasks(first.harness);
		await first.harness.close(context);
		const { runId: _dropped, ...legacy } = stored!.input as { runId?: number; assistant: number; callId: string };
		await storage.commit([{ type: "task", value: { ...stored!, version: 1, input: legacy } }], context);

		const second = await open(storage);
		faux.setResponses([say("done")]);
		await second.harness.resumeTask(stored!.id as TaskId, context);
		await settle(second.harness, second.root);
		expect(second.seen.at(-1)).toMatchObject({ taskId: stored!.id, runId: undefined });
		expect((await second.harness.getTask(stored!.id as TaskId, context))?.input).toEqual(legacy);
		await second.harness.close(context);
	});

	it("starts a fork with no run", async () => {
		const { harness, root } = await open(durable());
		faux.setResponses([call("wait")]);
		await root.submit({ type: "input", content: "start" }, context);
		await expect.poll(async () => (await runOf(harness, root)) !== undefined, { timeout: 5_000 }).toBe(true);
		const [entry] = (await root.entries({}, 1, undefined, context)).items;
		const fork = await root.fork(entry!.id, { ownership: { kind: "ownerless" } }, context);
		expect(await harness.commit((tx) => tx.run(fork.id), context)).toBeUndefined();
		await root.abort(context);
		await settle(harness, root);
		await harness.close(context);
	});
});
