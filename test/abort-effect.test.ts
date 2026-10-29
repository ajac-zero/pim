import { BACKGROUND_CONTEXT as context, withAbortSignal } from "@earendil-works/chord/context";
import { type AssistantMessage, Type } from "@earendil-works/pi-ai";
import { createModels } from "@earendil-works/pi-ai/models";
import { fauxAssistantMessage, fauxProvider, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import {
	type ConversationId,
	createRegistry,
	defineExtension,
	defineTool,
	Harness,
	LiveDoc,
	type Storage,
	StorageRejected,
	type Tx,
} from "@earendil-works/pi-durable";
import { MemoryStorage } from "@earendil-works/pi-durable/storage/memory";
import { env, runInDurableObject } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { OWNER, post, toolUse, waits } from "./helpers";
import { faux, type Pim } from "./worker";

/**
 * The opt-in abort-effect companions of Pim's local patches (docs/cua-native-abort-effect.md):
 * `Conversation.abortWithEffect()` in pi-durable, and `PiSession.abortWithEffect()` in the agents
 * adapter. Each reports what the commits that marked and withdrew actually did, and resolves after
 * the marking commit, before idle. `abort()` keeps its boolean and its wait. The first part runs the
 * real harness over its in-memory storage; the second runs the real Pim Durable Object in workerd,
 * with the agents adapter over its SQLite storage. Every model is the faux one, held by gates.
 */

function bounded<T>(work: Promise<T>, ms: number, what: string): Promise<T> {
	let timer: ReturnType<typeof setTimeout> | undefined;
	const timeout = new Promise<never>((_, reject) => {
		timer = setTimeout(() => reject(new Error(`${what} did not settle within ${ms} ms`)), ms);
	});
	return Promise.race([work, timeout]).finally(() => clearTimeout(timer));
}

/** Whether `promise` is still pending after `ms`. */
async function pending(promise: Promise<unknown>, ms = 50): Promise<boolean> {
	const marker = Symbol("pending");
	const settled = await Promise.race([promise.then(() => "resolved", () => "rejected"), new Promise((resolve) => setTimeout(() => resolve(marker), ms))]);
	return settled === marker;
}

// ─── pi-durable, over its in-memory storage ─────────────────────────────────

const model = fauxProvider({ provider: "effects", models: [{ id: "effects-model" }] });
const MODEL = { provider: "effects", modelId: "effects-model" };
const call = (name: string) => fauxAssistantMessage(fauxToolCall(name, {}), { stopReason: "toolUse" });

/** A model response held until `open()`; `called` resolves once the harness asks for it. */
function heldResponse(what: string, answer: () => AssistantMessage) {
	const gate = waits().gate(what);
	let entered = () => undefined as void;
	const called = new Promise<void>((resolve) => {
		entered = resolve;
	});
	return {
		respond: async () => {
			entered();
			await gate.opened;
			return answer();
		},
		called: () => bounded(called, 5_000, `${what}: model called`),
		open: gate.open,
	};
}

/** Storage whose next commit can be refused, as a storage that rejected the batch: nothing of it is written. */
function refusable(storage: Storage = new MemoryStorage()) {
	let refuse = false;
	const proxy = new Proxy(storage, {
		get: (target, key) =>
			key === "commit"
				? (...args: Parameters<Storage["commit"]>) => {
						if (refuse) {
							refuse = false;
							return Promise.reject(new StorageRejected("refused for the test"));
						}
						return target.commit(...args);
					}
				: Reflect.get(target, key, target),
	});
	return { storage: proxy as Storage, refuseNext: () => void (refuse = true) };
}

/** A harness with `wait`, which suspends its call, and `spawn`, which starts a child conversation its task owns and suspends. */
async function open(storage: Storage) {
	const wait = defineTool({
		name: "wait",
		description: "Waits until woken.",
		parameters: Type.Object({}),
		replay: "safe",
		async execute() {
			return { control: { suspend: true } };
		},
	});
	const spawn = defineTool({
		name: "spawn",
		description: "Starts a child conversation and waits.",
		parameters: Type.Object({}),
		replay: "safe",
		async execute(_args, api, ctx) {
			if (!(await api.memo<boolean>("spawned", ctx))) {
				await api.memo("spawned", true, ctx);
				const child = await api.commit((tx: Tx) => tx.createConversation({ ownership: { kind: "task", taskId: api.taskId } }), ctx);
				await (await api.conversation(child.id, ctx))!.submit({ type: "input", content: "child work" }, ctx);
			}
			return { control: { suspend: true } };
		},
	});
	const models = createModels();
	models.setProvider(model.provider);
	const registry = createRegistry();
	registry.install(defineExtension({ name: "effects", tools: [wait, spawn] }));
	const harness = await Harness.open(storage, { models, registry }, context);
	const root = await harness.root(context, { agent: { model: MODEL } });
	return { harness, root };
}

async function liveTasks(harness: Harness) {
	return (await harness.inspect(context)).tasks.map(({ record }) => record);
}

async function waitFor(check: () => Promise<boolean>, what: string) {
	await expect.poll(check, { timeout: 5_000, message: what }).toBe(true);
}

describe("Conversation.abortWithEffect (pi-durable)", () => {
	it("reports each reached conversation's run, the tasks it marked and the inputs it withdrew, from the marking commit", async () => {
		const { harness, root } = await open(new MemoryStorage());
		model.setResponses([call("spawn"), call("wait")]);
		await root.submit({ type: "input", content: "start", requestId: "start" }, context);
		await waitFor(async () => (await liveTasks(harness)).filter((task) => task.kind === "pi.tool" && task.state.status === "waiting").length === 2, "both calls suspended");
		await root.submit({ type: "input", content: "later", whenBusy: "followUp", requestId: "later" }, context);
		const before = await liveTasks(harness);
		const child = before.find((task) => task.kind === "pi.generation" && task.conversationId !== root.id)!.conversationId as ConversationId;
		const runs = await harness.commit(async (tx) => ({ root: (await tx.run(root.id))?.id, child: (await tx.run(child))?.id }), context);

		const { effect, idle } = await root.abortWithEffect(context);
		// Every live task of both conversations was unmarked before, and the traversal reaches them all.
		const marked = (conversation: ConversationId) => before.filter((task) => task.conversationId === conversation && !task.abortRequested && !task.background).length;
		expect(effect.marked).toEqual(
			expect.arrayContaining([
				{ conversationId: root.id, runId: runs.root, newlyMarked: marked(root.id) },
				{ conversationId: child, runId: runs.child, newlyMarked: marked(child) },
			]),
		);
		expect(effect.marked).toHaveLength(2);
		expect(runs.root).not.toBe(runs.child);
		expect(marked(root.id)).toBeGreaterThan(0);
		expect(marked(child)).toBeGreaterThan(0);
		expect(effect.withdrawn).toEqual([{ conversationId: root.id, submissionId: expect.any(Number), requestId: "later" }]);
		await bounded(idle, 5_000, "idle");

		// A repeat on an idle conversation marks nothing and withdraws nothing, and says so.
		const again = await root.abortWithEffect(context);
		expect(again.effect).toEqual({ marked: [], withdrawn: [] });
		await again.idle;
		await harness.close(context);
	});

	it("resolves after the marking commit and before idle; idle settles as abort() would, and is handled if never awaited", async () => {
		const { harness, root } = await open(new MemoryStorage());
		const held = heldResponse("held generation", () => fauxAssistantMessage("done"));
		model.setResponses([held.respond]);
		await root.submit({ type: "input", content: "start" }, context);
		await held.called();
		const run = (await harness.commit((tx) => tx.run(root.id), context))!;

		// Waiting for idle under a signal the caller then aborts: idle rejects as abort() would, and the effect is already known.
		const controller = new AbortController();
		const { effect, idle } = await root.abortWithEffect(withAbortSignal(controller.signal, context));
		expect(effect.marked).toEqual([{ conversationId: root.id, runId: run.id, newlyMarked: 1 }]);
		expect(await pending(idle)).toBe(true);
		controller.abort(new Error("caller stopped waiting"));
		await expect(idle).rejects.toThrow("caller stopped waiting");

		// A second call on the still-running, already marked run: the same run, nothing newly marked.
		const repeat = await root.abortWithEffect(context);
		expect(repeat.effect.marked).toEqual([{ conversationId: root.id, runId: run.id, newlyMarked: 0 }]);
		// An idle never awaited, which then rejects: handled by the companion, so no unhandled rejection fails this run.
		const forgotten = new AbortController();
		await root.abortWithEffect(withAbortSignal(forgotten.signal, context));
		forgotten.abort(new Error("never awaited"));
		held.open();
		await bounded(repeat.idle, 5_000, "idle after the model answers");
		await harness.close(context);
	});

	it("reports a run from before run IDs as null, and a refused commit as no effect at all", async () => {
		const refusing = refusable();
		const { harness, root } = await open(refusing.storage);
		model.setResponses([call("wait")]);
		await root.submit({ type: "input", content: "start" }, context);
		await waitFor(async () => (await liveTasks(harness)).some((task) => task.kind === "pi.tool" && task.state.status === "waiting"), "call suspended");
		// As a run that began before run IDs: the live run without its ID.
		await harness.commit(async (tx) => {
			const live = (await tx.doc(LiveDoc, root.id)) as { run?: { id?: number } };
			delete live.run!.id;
		}, context);

		// The marking commit refused: abortWithEffect and abort reject alike, and nothing was marked.
		refusing.refuseNext();
		await expect(root.abortWithEffect(context)).rejects.toThrow("refused for the test");
		expect((await liveTasks(harness)).some((task) => task.abortRequested)).toBe(false);
		refusing.refuseNext();
		await expect(root.abort(context)).rejects.toThrow("refused for the test");
		expect((await liveTasks(harness)).some((task) => task.abortRequested)).toBe(false);

		const { effect, idle } = await root.abortWithEffect(context);
		expect(effect.marked).toEqual([{ conversationId: root.id, runId: null, newlyMarked: 2 }]);
		await bounded(idle, 5_000, "idle");
		await harness.close(context);
	});
});

// ─── The agents adapter, in Pim's Durable Object ────────────────────────────

function within<T>(work: (pim: Pim) => Promise<T>): Promise<T> {
	return runInDurableObject(env.Pim.getByName(OWNER), work);
}

async function newChat(): Promise<{ session: string; conversation: ConversationId }> {
	const chat = (await post<{ id: string }>("/sessions")).body.id;
	return within(async (pim) => {
		const session = pim.store.sessionOf(chat)!;
		return { session, conversation: Number(session) as ConversationId };
	});
}

/** The handle of a Stop, kept here rather than passed back across `runInDurableObject`. */
let idleOf: Promise<void> | undefined;

describe("PiSession.abortWithEffect (agents adapter)", () => {
	it("reports the operation's own commit and the conversation abort's, keeps abort()'s boolean, and resolves before idle", async () => {
		const { session, conversation } = await newChat();
		const other = await newChat();
		const first = heldResponse("adapter: run 1", () => toolUse("send_to_user", { message: "one" }));
		const second = heldResponse("adapter: run 2", () => toolUse("send_to_user", { message: "two" }));
		const third = heldResponse("adapter: run 3", () => toolUse("send_to_user", { message: "three" }));
		const fourth = heldResponse("adapter: run 4", () => toolUse("send_to_user", { message: "four" }));
		faux.setResponses([first.respond, second.respond, third.respond, fourth.respond]);
		const submit = (operationId: string, whenBusy?: "followUp") =>
			within(async (pim) => {
				await pim.harness.session(session).submit(`Input ${operationId}.`, { operationId, ...(whenBusy ? { whenBusy } : {}) });
			});
		const stop = (operationId?: string, where = session) =>
			within(async (pim) => {
				const { effect, idle } = await bounded(pim.harness.session(where).abortWithEffect(operationId), 5_000, `abortWithEffect(${operationId})`);
				idleOf = idle;
				return effect;
			});
		const idleState = () => within(async () => ((await pending(idleOf!)) ? "pending" : "settled"));
		const awaitIdle = () => within(() => bounded(idleOf!, 5_000, "idle"));
		const runOf = () => within(async (pim) => (await pim.harness.pi()).commit(async (tx: Tx) => (await tx.run(conversation))?.id ?? null, context));

		// Run 1, from op-A. A queued op-Q is withdrawn by its own Stop: no conversation abort, nothing to wait for.
		await submit("op-A");
		await first.called();
		const run1 = await runOf();
		await submit("op-Q", "followUp");
		expect(await stop("op-Q")).toEqual({ aborted: true, operation: { operationId: "op-Q", outcome: "withdrawn" } });
		expect(await idleState()).toBe("settled");

		// A placed op-A: the conversation's abort ran, marking run 1 and withdrawing the unrelated queued op-B and op-D.
		await submit("op-B", "followUp");
		await submit("op-D", "followUp");
		const placed = await stop("op-A");
		expect(placed).toEqual({
			aborted: true,
			operation: { operationId: "op-A", outcome: "placed" },
			conversation: {
				marked: [{ conversationId: conversation, runId: run1, newlyMarked: expect.any(Number) }],
				withdrawn: [
					{ conversationId: conversation, submissionId: expect.any(Number), requestId: "op-B" },
					{ conversationId: conversation, submissionId: expect.any(Number), requestId: "op-D" },
				],
			},
		});
		expect(placed.conversation!.marked[0]!.newlyMarked).toBeGreaterThan(0);
		// Resolved after the marking commit, while the model is still held: idle hasn't come.
		expect(await idleState()).toBe("pending");
		first.open();
		await awaitIdle();

		// Repeated after the run ended: op-A is settled, nothing more is done, and abort()'s boolean is false.
		expect(await stop("op-A")).toEqual({ aborted: false, operation: { operationId: "op-A", outcome: "settled" } });
		// Missing, empty, and another chat's: not found, nothing done.
		expect(await stop("op-missing")).toEqual({ aborted: false, operation: { operationId: "op-missing", outcome: "not_found" } });
		expect(await stop("")).toEqual({ aborted: false, operation: { operationId: "", outcome: "not_found" } });
		expect(await stop("op-A", other.session)).toEqual({ aborted: false, operation: { operationId: "op-A", outcome: "not_found" } });

		// The plain Stop: run 2 is marked and reported, and abort()'s boolean stays true.
		await submit("op-E");
		await second.called();
		const run2 = await runOf();
		expect(run2).not.toBe(run1);
		const plain = await stop();
		expect(plain).toEqual({ aborted: true, conversation: { marked: [{ conversationId: conversation, runId: run2, newlyMarked: expect.any(Number) }], withdrawn: [] } });
		expect(await idleState()).toBe("pending");
		second.open();
		await awaitIdle();

		// Queued, then placed by a boundary into a new run before its Stop: the effect names the run actually marked, run 4.
		await submit("op-G");
		await third.called();
		const run3 = await runOf();
		await submit("op-F", "followUp");
		third.open();
		await fourth.called();
		const run4 = await runOf();
		expect(run4).not.toBe(run3);
		const raced = await stop("op-F");
		expect(raced.operation).toEqual({ operationId: "op-F", outcome: "placed" });
		expect(raced.conversation!.marked).toEqual([{ conversationId: conversation, runId: run4, newlyMarked: expect.any(Number) }]);
		fourth.open();
		await awaitIdle();

		// abort() itself is unchanged: the same booleans as before the patch for missing and settled operations.
		expect(await within((pim) => pim.harness.session(session).abort("op-missing"))).toBe(false);
		expect(await within((pim) => pim.harness.session(session).abort("op-F"))).toBe(false);
	});
});
