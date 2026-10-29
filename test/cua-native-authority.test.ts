import type { JsonValue } from "@earendil-works/chord";
import { BACKGROUND_CONTEXT as context } from "@earendil-works/chord/context";
import { Type } from "@earendil-works/pi-ai";
import { createModels } from "@earendil-works/pi-ai/models";
import { fauxAssistantMessage, fauxProvider, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import { type Conversation, createRegistry, defineExtension, defineTool, Harness, LiveDoc, type Storage, type TaskId, type TaskRecord } from "@earendil-works/pi-durable";
import { MemoryStorage } from "@earendil-works/pi-durable/storage/memory";
import { describe, expect, it } from "vitest";
import type { NativeOutcome } from "../computer/native-outcome";
import {
	harnessAuthority,
	harnessScope,
	type NativeBinding,
	type NativeIdentityAuthority,
	NativeIdentityBinder,
	type NativeIdentityClaim,
	type Transact,
} from "../src/cua-native-identity";

type Task = TaskRecord<JsonValue, JsonValue, JsonValue>;

/**
 * Pim's run authority (`harnessAuthority`) and the native-call binder in one
 * harness transaction each (`harnessScope`), over the real harness with Pim's
 * local pi-durable patch, its in-memory storage and a scripted model. A tool
 * call that suspends stands for one waiting on its approval. `send` is the
 * test's: no control state, computer or network is involved here
 * (test/cua.test.ts composes those).
 */

const SPACE = "space-1";
const AGENT = "agent-1";
const faux = fauxProvider({ provider: "authority", models: [{ id: "authority-model" }] });
const known: NativeOutcome = { status: "completed", isError: false, code: null, content: [{ type: "text", text: "clicked" }], presentation: [] };
const lease = { epoch: 1, leaseId: "L1" };
const click = { pid: 42, x: 1, y: 2 };

/** A storage that outlives the harness that closes it, so a second harness opens what the first left, as after a restart. */
function durable(storage: Storage = new MemoryStorage()): Storage {
	return new Proxy(storage, { get: (target, key) => (key === "close" ? async () => undefined : Reflect.get(target, key, target)) });
}

/** A harness whose `wait` tool suspends until woken, and a binder over it as Pim makes one, with the deleted chats `deleted`. */
async function open(storage: Storage = durable(), wrap: (authority: NativeIdentityAuthority) => NativeIdentityAuthority = (authority) => authority) {
	const wait = defineTool({
		name: "wait",
		description: "Waits until woken.",
		parameters: Type.Object({}),
		replay: "safe",
		async execute(_args, api, ctx) {
			if (await api.memo<boolean>("woken", ctx)) return { content: [{ type: "text", text: "woken" }] };
			await api.memo("woken", true, ctx);
			return { control: { suspend: true } };
		},
	});
	const models = createModels();
	models.setProvider(faux.provider);
	const registry = createRegistry();
	registry.install(defineExtension({ name: "authority", tools: [wait] }));
	const harness = await Harness.open(storage, { models, registry }, context);
	const root = await harness.root(context, { agent: { model: { provider: "authority", modelId: "authority-model" } } });
	const deleted = new Set<string>();
	const binder = new NativeIdentityBinder(SPACE, { lease: () => lease, newId: () => crypto.randomUUID() });
	const transact: Transact = (work) =>
		harness.commit(async (tx) => work(await harnessScope(tx, (read) => wrap(harnessAuthority(read, { owner: SPACE, agentOf: () => AGENT, deleted: (id) => deleted.has(id) })))), context);
	return { harness, root, deleted, binder, transact, storage };
}
type Opened = Awaited<ReturnType<typeof open>>;

const call = (name: string) => fauxAssistantMessage(fauxToolCall(name, {}), { stopReason: "toolUse" });

async function waiting(harness: Harness): Promise<Task> {
	let found: Task | undefined;
	await expect
		.poll(
			async () => {
				const { tasks } = await harness.inspect(context);
				found = tasks.find(({ record }) => record.kind === "pi.tool" && record.state.status === "waiting" && record.state.on.length === 0)?.record;
				return found !== undefined;
			},
			{ timeout: 5_000 },
		)
		.toBe(true);
	return found!;
}

const claimOf = (root: Conversation, task: Task): NativeIdentityClaim => ({
	conversationId: String(root.id),
	toolTaskId: String(task.id),
	callId: (task.input as { callId: string }).callId,
});

/** Starts a run whose `wait` call suspends, and binds that call: as the desktop's tools bind a call before filing its approval. */
async function bound(opened: Opened) {
	faux.setResponses([call("wait")]);
	await opened.root.submit({ type: "input", content: "act" }, context);
	const task = await waiting(opened.harness);
	const result = await opened.transact((scope) => opened.binder.bind(scope, claimOf(opened.root, task), "click", click));
	if (!result.ok) throw new Error(`not bound: ${result.reason}`);
	return { task, binding: result.binding };
}

/** A send that records what it was given. */
function sender(answer: () => Promise<NativeOutcome> = async () => known) {
	const sent: NativeBinding[] = [];
	return { sent, send: async (binding: NativeBinding) => (sent.push(binding), answer()) };
}

const statusOf = (opened: Opened, id: string) => opened.transact((scope) => opened.binder.status(scope, id));

async function close(opened: Opened) {
	await opened.root.abort(context);
	await opened.harness.waitForIdle(context);
	await opened.harness.close(context);
}

describe("Pim's run authority and the binder in one harness transaction", () => {
	it("binds a live call of the run going now under the run ID the harness minted, and sends it once", async () => {
		const opened = await open();
		const { task, binding } = await bound(opened);
		const run = await opened.harness.commit((tx) => tx.run(opened.root.id), context);
		expect(binding.identity).toEqual({ owner: SPACE, agentId: AGENT, ...claimOf(opened.root, task), runAnchor: String(run!.id) });
		expect((task.input as { runId: number }).runId).toBe(run!.id);
		const { sent, send } = sender();
		expect(await opened.binder.dispatch(opened.transact, binding.id, send)).toEqual({ ok: true, outcome: known });
		expect(await opened.binder.dispatch(opened.transact, binding.id, send)).toMatchObject({ ok: false, reason: "closed" });
		expect(sent).toHaveLength(1);
		await close(opened);
	});

	it("sends nothing when an abort, a reset's end of the run or a deletion commits before the claim", async () => {
		const opened = await open();
		const { sent, send } = sender();

		const aborted = await bound(opened);
		await opened.root.abort(context);
		await opened.harness.waitForIdle(context);
		expect(await opened.binder.dispatch(opened.transact, aborted.binding.id, send)).toMatchObject({ ok: false, reason: "stopped" });
		expect(await statusOf(opened, aborted.binding.id)).toBe("closed");

		// A reset is queued while the call waits, and ends the run at the boundary after the call: once that has committed, the call is over.
		const reset = await bound(opened);
		const resetting = opened.root.reset(undefined, context);
		await opened.harness.resumeTask(reset.task.id as TaskId, context);
		await resetting;
		await opened.harness.waitForIdle(context);
		expect(await opened.harness.commit((tx) => tx.run(opened.root.id), context)).toBeUndefined();
		expect(await opened.binder.dispatch(opened.transact, reset.binding.id, send)).toMatchObject({ ok: false, reason: "stopped" });

		// Pim marks a chat deleted before it aborts its run: from that mark on, nothing of it is sent.
		const deleting = await bound(opened);
		opened.deleted.add(String(opened.root.id));
		expect(await opened.binder.dispatch(opened.transact, deleting.binding.id, send)).toMatchObject({ ok: false, reason: "stopped" });
		opened.deleted.clear();

		expect(sent).toEqual([]);
		await close(opened);
	});

	it("sends a call claimed before an abort, a reset or a deletion commits once, and records its outcome, unknown included", async () => {
		const opened = await open();
		for (const end of ["abort", "reset", "delete"] as const) {
			const { task, binding } = await bound(opened);
			const outcome: NativeOutcome = end === "reset" ? { status: "unknown", reason: "timeout" } : known;
			const { sent, send } = sender(async () => {
				// After the claim committed: the run ends, and the call is already taken as possibly sent.
				if (end === "abort") await opened.root.abort(context);
				if (end === "reset") {
					const resetting = opened.root.reset(undefined, context);
					await opened.harness.resumeTask(task.id as TaskId, context);
					await resetting;
				}
				if (end === "delete") {
					opened.deleted.add(String(opened.root.id));
					await opened.root.abort(context);
				}
				return outcome;
			});
			expect(await opened.binder.dispatch(opened.transact, binding.id, send)).toEqual({ ok: true, outcome });
			expect(sent).toHaveLength(1);
			expect(await statusOf(opened, binding.id)).toBe(end === "reset" ? "unknown" : "closed");
			await opened.harness.waitForIdle(context);
			opened.deleted.clear();
		}
		await close(opened);
	});

	it("orders an abort asked for during the claim's transaction wholly after it", async () => {
		let abort: Promise<void> | undefined;
		let armed = false;
		let opened!: Opened;
		const order: string[] = [];
		opened = await open(durable(), (authority) => ({
			async verify(claim) {
				// Asked for between the authority's read and the claim's write; it can commit only once this transaction has.
				if (armed && !abort) abort = opened.root.abort(context).then(() => void order.push("aborted"));
				await new Promise((resolve) => setTimeout(resolve, 20));
				return authority.verify(claim);
			},
		}));
		const { binding } = await bound(opened);
		armed = true;
		const claimed = await opened.transact((scope) => opened.binder.claim(scope, binding.id));
		order.push("claimed");
		await abort;
		expect(claimed).toMatchObject({ ok: true });
		expect(order).toEqual(["claimed", "aborted"]);
		expect(await opened.harness.commit((tx) => tx.run(opened.root.id), context)).toBeUndefined();
		// The claim stands: settled, it is the call's record, though its run has ended.
		expect(await opened.transact((scope) => opened.binder.settle(scope, binding.id, { outcome: known }))).toEqual({ ok: true, outcome: known });
		expect(await statusOf(opened, binding.id)).toBe("closed");
		await opened.harness.close(context);
	});

	it("checks the call again at dispatch: a later run, or a run whose ID is gone, refuses it", async () => {
		const opened = await open();
		const { sent, send } = sender();
		const first = await bound(opened);
		// The run's control loses its ID, as a run stored before run IDs: the call can't be shown to be the run's.
		await opened.harness.commit(async (tx) => {
			const live = await tx.doc(LiveDoc, opened.root.id);
			delete (live.run as { id?: unknown }).id;
		}, context);
		expect(await opened.binder.dispatch(opened.transact, first.binding.id, send)).toMatchObject({ ok: false, reason: "legacy" });
		await opened.root.abort(context);
		await opened.harness.waitForIdle(context);

		// A call of a later run is bound under that run, and an earlier call's binding is never its.
		const second = await bound(opened);
		expect(second.binding.identity.runAnchor).not.toBe(first.binding.identity.runAnchor);
		expect(await opened.binder.dispatch(opened.transact, first.binding.id, send)).toMatchObject({ ok: false, reason: "closed" });
		expect(sent).toEqual([]);
		await close(opened);
	});

	it("refuses a call made before run IDs, as one migrated from then is", async () => {
		const storage = durable();
		const first = await open(storage);
		faux.setResponses([call("wait")]);
		await first.root.submit({ type: "input", content: "act" }, context);
		const task = await waiting(first.harness);
		await first.harness.close(context);
		const { runId: _dropped, ...legacy } = task.input as { runId?: number };
		await storage.commit([{ type: "task", value: { ...task, version: 1, input: legacy } }], context);

		const second = await open(storage);
		expect(await second.transact((scope) => second.binder.bind(scope, claimOf(second.root, task), "click", click))).toMatchObject({ ok: false, reason: "legacy" });
		await close(second);
	});

	it("latches a run once a call of it is unknown, across a restart, and lets the next run go on", async () => {
		const storage = durable();
		const opened = await open(storage);
		const { task, binding } = await bound(opened);
		// The process dies while the call is out: its claim is stored, its end never is.
		const out = opened.binder.dispatch(opened.transact, binding.id, () => new Promise<NativeOutcome>(() => undefined));
		await expect.poll(() => statusOf(opened, binding.id)).toBe("claimed");
		void out;
		await opened.harness.close(context);

		// Restarted: a new binder, over the same harness storage, takes the claim as unknown and the run as latched.
		const restarted = await open(storage);
		expect(await statusOf(restarted, binding.id)).toBe("unknown");
		const { sent, send } = sender();
		expect(await restarted.binder.dispatch(restarted.transact, binding.id, send)).toMatchObject({ ok: false, reason: "uncertain" });
		// The same run's next call, after the waiting one is woken, is refused unsent.
		faux.setResponses([call("wait")]);
		await restarted.harness.resumeTask(task.id as TaskId, context);
		const next = await waiting(restarted.harness);
		expect(next.id).not.toBe(task.id);
		expect((next.input as { runId: number }).runId).toBe((task.input as { runId: number }).runId);
		expect(await restarted.transact((scope) => restarted.binder.bind(scope, claimOf(restarted.root, next), "click", click))).toMatchObject({
			ok: false,
			reason: "run_uncertain",
		});
		await restarted.root.abort(context);
		await restarted.harness.waitForIdle(context);

		// Another run is not latched.
		const later = await bound(restarted);
		expect(await restarted.binder.dispatch(restarted.transact, later.binding.id, send)).toMatchObject({ ok: true });
		expect(sent).toHaveLength(1);
		await close(restarted);
	});
});
