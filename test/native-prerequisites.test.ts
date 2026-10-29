import { BACKGROUND_CONTEXT as ctx } from "@earendil-works/chord/context";
import { type ConversationId, defineDoc, LiveDoc, type Tx } from "@earendil-works/pi-durable";
import { env, runInDurableObject } from "cloudflare:test";
import { describe, expect, it, vi } from "vitest";
import { OWNER, post, toolUse, waits } from "./helpers";
import { faux, type Pim } from "./worker";

/**
 * Prerequisite qualification for the native fence design (docs/cua-native-fence-protocol.md, frozen at d1ee74d),
 * not a test of any native behaviour: nothing here turns native calls on. It runs on the real Pim Durable Object in
 * workerd, its real SQLite storage, Pim's patched pi-durable and the agents adapter, with the faux model held by gates.
 *
 * 1. Whether a harness commit's callback can await `ctx.storage.sync()` while it holds the harness's mutation line,
 *    what that sync can cover, and that a real `Conversation.abort()` asked for meanwhile lands only after the callback.
 * 2. Whether an operation-specific Stop can be classified exactly from the harness's records: queued, joined the live
 *    run, ended, or not found; and whether that classification is the one `abort(operationId)` then acts on.
 *
 * Every wait is bounded, so a deadlock fails the test instead of hanging it.
 */

/** The stop asked for during the held commit, kept here rather than passed back across `runInDurableObject`. */
let pendingAbort: Promise<unknown> | undefined;
/** A Stop that settles only once its conversation is idle, kept here for the same reason. */
let pendingWithdraw: Promise<boolean> | undefined;

const ProbeDoc = defineDoc<{ n?: number }>({ kind: "test.native-prerequisites", version: 1, scope: "conversation", history: "latest", fork: "initial", initial: () => ({}) });

function bounded<T>(work: Promise<T>, ms: number, what: string): Promise<T> {
	let timer: ReturnType<typeof setTimeout> | undefined;
	const timeout = new Promise<never>((_, reject) => {
		timer = setTimeout(() => reject(new Error(`${what} did not settle within ${ms} ms`)), ms);
	});
	return Promise.race([work, timeout]).finally(() => clearTimeout(timer));
}

/** A model response held until its gate opens; `called` resolves when the harness asks for it. */
function held(what: string, answer: () => ReturnType<typeof toolUse>) {
	const gate = waits().gate(what);
	let entered = () => undefined as void;
	const called = new Promise<void>((resolve) => {
		entered = resolve;
	});
	const respond = async () => {
		entered();
		await gate.opened;
		return answer();
	};
	return { respond, called: () => bounded(called, 5_000, `${what}: model called`), open: gate.open };
}

function within<T>(work: (pim: Pim, state: DurableObjectState) => Promise<T>): Promise<T> {
	return runInDurableObject(env.Pim.getByName(OWNER), work);
}

/** The harness's commit sequence, from the adapter's real table: it moves only when a harness commit reaches storage. */
function sequence(state: DurableObjectState): number {
	const [table] = state.storage.sql
		.exec("SELECT name FROM sqlite_master WHERE type = 'table' AND name LIKE '%durable_metadata'")
		.toArray()
		.map((row) => String(row.name));
	return Number(state.storage.sql.exec(`SELECT next_seq FROM ${table}`).one().next_seq);
}

type Classified = { status: string; id: number } | null;

/** One harness commit that reads, never writes: the run, each operation's submission, and (ground truth for the test only) the run's inputs. */
async function classify(pim: Pim, conversation: ConversationId, operations: readonly string[]) {
	const pi = await pim.harness.pi();
	return pi.commit(async (tx: Tx) => {
		const run = await tx.run(conversation);
		const live = (await tx.doc(LiveDoc, conversation)) as { run?: { inputs?: readonly number[] } };
		const submissions: Record<string, Classified> = {};
		for (const operation of operations) {
			const record = await tx.submissionByRequest(conversation, operation);
			submissions[operation] = record ? { status: record.status, id: record.id as unknown as number } : null;
		}
		const task = run ? await tx.task(run.taskId) : undefined;
		return { runId: run?.id ?? null, inputs: [...(live.run?.inputs ?? [])], submissions, abortRequested: task?.abortRequested === true };
	}, ctx);
}

async function newChat(): Promise<{ session: string; conversation: ConversationId }> {
	const chat = (await post<{ id: string }>("/sessions")).body.id;
	return within(async (pim) => {
		const session = pim.store.sessionOf(chat)!;
		return { session, conversation: Number(session) as ConversationId };
	});
}

describe("native fence prerequisites", () => {
	it("awaits real storage sync inside a real harness commit while holding the line; a real abort lands after it", async () => {
		const { session, conversation } = await newChat();
		const model = held("sync: model", () => toolUse("send_to_user", { message: "never shown" }));
		faux.setResponses([model.respond]);
		await within(async (pim) => {
			await pim.harness.session(session).submit("Hold the run.", { operationId: "sync-run" });
		});
		await model.called();

		const evidence = await within(async (pim, state) => {
			state.storage.sql.exec("CREATE TABLE IF NOT EXISTS test_native_probe (id TEXT PRIMARY KEY)");
			const pi = await pim.harness.pi();
			// The conversation's handle, looked up before the line is held, so the stop below queues its commit at once.
			const handle = await pim.harness.conversation(session);
			const before = sequence(state);
			const result = await bounded(
				pi.commit(async (tx: Tx) => {
					const run = await tx.run(conversation);
					// A real stop, asked for while this commit holds the line.
					pendingAbort = handle.abort(ctx);
					// A harness write in this callback, and a write to Pim's own SQL.
					(await tx.doc(ProbeDoc, conversation)).n = 1;
					state.storage.sql.exec("INSERT INTO test_native_probe (id) VALUES ('inside')");
					// Real I/O time, so the abort's commit is surely queued before the sync.
					await new Promise((resolve) => setTimeout(resolve, 50));
					await bounded(state.storage.sync(), 5_000, "storage.sync() inside a harness commit");
					const task = run ? await tx.task(run.taskId) : undefined;
					return {
						runId: run?.id ?? null,
						taskId: run?.taskId,
						sequenceAfterSync: sequence(state),
						runAfterSync: (await tx.run(conversation))?.id ?? null,
						abortRequestedAfterSync: task?.abortRequested === true,
						pimRowAfterSync: state.storage.sql.exec("SELECT COUNT(*) AS n FROM test_native_probe WHERE id = 'inside'").one().n,
					};
				}, ctx),
				8_000,
				"the commit holding the line",
			);
			const committed = sequence(state);
			const later = await bounded(
				pi.commit(async (tx: Tx) => ({
					abortRequested: result.taskId ? (await tx.task(result.taskId))?.abortRequested === true : false,
					probe: (await tx.doc(ProbeDoc, conversation)).n ?? null,
				}), ctx),
				5_000,
				"a commit after it",
			);

			// A callback that throws after writing Pim's SQL: the harness commit rejects, Pim's row stays. No cross-store transaction.
			const failed = await bounded(
				pi
					.commit(async (tx: Tx) => {
						(await tx.doc(ProbeDoc, conversation)).n = 2;
						state.storage.sql.exec("INSERT INTO test_native_probe (id) VALUES ('rolled-back?')");
						await bounded(state.storage.sync(), 5_000, "sync before a throw");
						throw new Error("refused after the write");
					}, ctx)
					.then(
						() => "committed",
						(error: Error) => error.message,
					),
				5_000,
				"the failing commit",
			);
			const afterFailure = await bounded(pi.commit(async (tx: Tx) => (await tx.doc(ProbeDoc, conversation)).n ?? null, ctx), 5_000, "read after failure");
			const pimRowAfterFailure = state.storage.sql.exec("SELECT COUNT(*) AS n FROM test_native_probe WHERE id = 'rolled-back?'").one().n;
			// The control: anything awaited on the line itself inside the callback can never run. The watchdog ends it, and the line recovers.
			const selfWait = await bounded(
				pi
					.commit(async () => {
						await bounded(pi.inspect(ctx), 1_000, "a read on the line from inside its own commit");
					}, ctx)
					.then(
						() => "settled",
						(error: Error) => error.message,
					),
				5_000,
				"the self-waiting commit",
			);
			const recovered = await bounded(pi.commit(async (tx: Tx) => (await tx.doc(ProbeDoc, conversation)).n ?? null, ctx), 5_000, "a commit after the self-wait");
			return { before, result, committed, later, failed, afterFailure, pimRowAfterFailure, selfWait, recovered };
		});

		// The line was held through the sync: the stop asked for before it hadn't landed after it.
		expect(evidence.result.runId).not.toBeNull();
		expect(evidence.result.runAfterSync).toBe(evidence.result.runId);
		expect(evidence.result.abortRequestedAfterSync).toBe(false);
		// The sync covered Pim's own write but not the commit's own harness write, which reaches storage only after the callback.
		expect(evidence.result.pimRowAfterSync).toBe(1);
		expect(evidence.result.sequenceAfterSync).toBe(evidence.before);
		expect(evidence.committed).toBeGreaterThan(evidence.before);
		expect(evidence.later).toEqual({ abortRequested: true, probe: 1 });
		// No cross-store transaction: the harness write rolled back, Pim's row did not.
		expect(evidence.failed).toBe("refused after the write");
		expect(evidence.afterFailure).toBe(1);
		expect(evidence.pimRowAfterFailure).toBe(1);
		// A storage sync isn't on the line; a harness read is, and deadlocks inside the commit until the watchdog ends it.
		expect(evidence.selfWait).toBe("a read on the line from inside its own commit did not settle within 1000 ms");
		expect(evidence.recovered).toBe(1);

		model.open();
		await within(async () => {
			await bounded(pendingAbort!, 5_000, "the abort settling");
		});
	});

	it("classifies an operation from the harness's records in one commit, which isn't the commit abort(operationId) acts in", async () => {
		const { session, conversation } = await newChat();
		const other = await newChat();
		const first = held("classify: first generation", () => toolUse("current_time", {}));
		const second = held("classify: second generation", () => toolUse("send_to_user", { message: "two" }));
		const third = held("classify: next run", () => toolUse("send_to_user", { message: "three" }));
		faux.setResponses([first.respond, second.respond, third.respond]);
		const submit = (operationId: string, whenBusy?: "steer" | "followUp") =>
			within(async (pim) => {
				await pim.harness.session(session).submit(`Input ${operationId}.`, { operationId, ...(whenBusy ? { whenBusy } : {}) });
			});
		const read = (operations: readonly string[], where = conversation) => within((pim) => classify(pim, where, operations));
		const withdraw = (operationId: string) => within((pim) => bounded(pim.harness.session(session).abort(operationId), 5_000, `abort(${operationId})`));
		const all = ["op-A", "op-B", "op-C", "op-D", "op-Q", "op-E"];

		// Idle: op-A starts run r1 and is placed in it.
		await submit("op-A");
		await first.called();
		// While r1 runs: two follow-ups and a steer queue; op-Q queues and is withdrawn by its own Stop.
		await submit("op-B", "followUp");
		await submit("op-C", "steer");
		await submit("op-D", "followUp");
		await submit("op-Q", "followUp");
		const sequenceBefore = await within(async (_pim, state) => sequence(state));
		const r1 = await read(all);
		const sequenceAfterRead = await within(async (_pim, state) => sequence(state));
		const withdrewQueued = await withdraw("op-Q");
		const afterQ = await read(all);

		// The tool round ends; the steer joins r1 at the boundary.
		first.open();
		await second.called();
		const joined = await read(all);
		// Classified now, op-B is queued.
		const classifiedB = joined.submissions["op-B"];

		// r1 ends; the follow-ups start r2. Then a later follow-up queues behind it.
		second.open();
		await third.called();
		await submit("op-E", "followUp");
		const r2 = await read(all);

		// The Stop for op-B, classified "queued" above, now aborts r2: the harness's own check runs in later commits.
		// It settles only once the conversation is idle, so it is started here and awaited after r2's model is let go.
		await within(async (pim) => {
			pendingWithdraw = pim.harness.session(session).abort("op-B");
		});
		const afterB = await vi.waitFor(
			async () => {
				const snapshot = await read(all);
				expect(snapshot.submissions["op-E"]?.status).toBe("unanswered");
				return snapshot;
			},
			{ timeout: 5_000 },
		);
		third.open();
		const withdrewB = await within(() => bounded(pendingWithdraw!, 5_000, "abort(op-B)"));

		// Not found: an unknown ID, an empty one, and op-A read in another chat (as a seat's or task's conversation would be).
		const missing = await read(["op-missing", ""]);
		const elsewhere = await read(["op-A"], other.conversation);
		const withdrewMissing = await withdraw("op-missing");

		const status = (snapshot: { submissions: Record<string, Classified> }, op: string) => snapshot.submissions[op]?.status ?? null;
		const id = (snapshot: { submissions: Record<string, Classified> }, op: string) => snapshot.submissions[op]!.id;

		// The read changed nothing in storage.
		expect(sequenceAfterRead).toBe(sequenceBefore);
		// Run r1, its first input placed and listed; the rest queued and not listed.
		expect(r1.runId).not.toBeNull();
		expect(status(r1, "op-A")).toBe("placed");
		expect(r1.inputs).toEqual([id(r1, "op-A")]);
		for (const op of ["op-B", "op-C", "op-D", "op-Q"]) expect(status(r1, op)).toBe("queued");
		// A queued input's Stop withdraws it and leaves the run alone.
		expect(withdrewQueued).toBe(true);
		expect(status(afterQ, "op-Q")).toBe("unanswered");
		expect(afterQ.runId).toBe(r1.runId);
		expect(afterQ.abortRequested).toBe(false);
		// A multi-input run: the steer joined r1; placed means listed in the live run.
		expect(joined.runId).toBe(r1.runId);
		expect(status(joined, "op-C")).toBe("placed");
		expect(joined.inputs).toEqual([id(r1, "op-A"), id(r1, "op-C")]);
		expect(classifiedB?.status).toBe("queued");
		// A new run r2 holds the follow-ups; op-A ended with r1.
		expect(r2.runId).not.toBeNull();
		expect(r2.runId).not.toBe(r1.runId);
		expect(status(r2, "op-A")).toBe("done");
		expect(status(r2, "op-B")).toBe("placed");
		// Follow-ups are placed one run at a time: op-D waits behind op-B.
		expect(r2.inputs).toEqual([id(r2, "op-B")]);
		expect(status(r2, "op-D")).toBe("queued");
		expect(status(r2, "op-E")).toBe("queued");
		// The Stop for op-B aborted the run it had joined since (the conversation's abort), and withdrew the unrelated queued op-D and op-E.
		expect(withdrewB).toBe(true);
		expect(afterB.runId).toBe(r2.runId);
		expect(afterB.abortRequested).toBe(true);
		expect(status(afterB, "op-D")).toBe("unanswered");
		expect(status(afterB, "op-E")).toBe("unanswered");
		// Not found, and conversation-scoped.
		expect(missing.submissions).toEqual({ "op-missing": null, "": null });
		expect(elsewhere.submissions["op-A"]).toBeNull();
		expect(withdrewMissing).toBe(false);
	});
});
