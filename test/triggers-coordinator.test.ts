import { env, runInDurableObject } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import type { Pim } from "../src/pim";
import {
	type ChatCreation,
	type ChatLookup,
	type HostPreflight,
	type RunStatus,
	type SubmissionLookup,
	type SubmitResult,
	type TimeEvidence,
	type TriggerAgentHost,
	TriggerCoordinator,
	type TriggerCoordinatorOptions,
} from "../src/triggers/coordinator";
import type { TriggerDestination } from "../src/triggers/spec";
import { TriggerStore } from "../src/triggers/store";
import { TriggerValidationError } from "../src/triggers/validate";

// Triggers are not wired into Pim (docs/triggers.md). These tests build the store and the coordinator on a Durable Object's database of their own,
// with a fake clock and a fake host; no model, chat or run of Pim's is touched.

// Vite reads every file this names as text when it builds the test; see the last test.
declare global {
	interface ImportMeta {
		glob(patterns: string[], options: { query: "?raw"; import: "default"; eager: true }): Record<string, string>;
	}
}

const START = 1_800_000_000_000; // 2027-01-15T08:00:00Z
const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;
const at = (iso: string) => Date.parse(iso);

type Deferred = { promise: Promise<void>; resolve: () => void };
function deferred(): Deferred {
	let resolve!: () => void;
	const promise = new Promise<void>((done) => {
		resolve = done;
	});
	return { promise, resolve };
}

/**
 * A host with chats, a run budget and runs of its own, which keeps its own
 * record by idempotency key as `submitTo` does. Each method can be scripted
 * for its next calls; `log` records every call.
 */
class FakeHost implements TriggerAgentHost {
	agents = new Set(["agent-1"]);
	chats = new Map<string, { agent: string; operationId: string | null }>([["chat-1", { agent: "agent-1", operationId: null }]]);
	submissions = new Map<string, { receipt: string; chatId: string; instruction: string; evidence: TimeEvidence }>();
	runs = new Map<string, RunStatus>();
	/** Runs the budget still allows; a reservation is taken for each new submission and given back for a duplicate. */
	budget = Number.POSITIVE_INFINITY;
	ledger = { reserved: 0, released: 0 };
	suspended = false;
	/** Whether `createChat` gives the same chat for the same key. */
	idempotentChats = true;
	log: string[] = [];
	script: {
		preflight?: (() => Promise<HostPreflight>)[];
		findChat?: ChatLookup["status"][];
		createChat?: ("throw_after_create" | "throw")[];
		submit?: ("accept_then_throw" | "throw" | "uncertain" | "fail" | Deferred)[];
		lookupSubmission?: ("unknown" | "absent" | "throw")[];
	} = {};
	#receipts = 0;

	async preflight(input: { triggerId: string; operationId: string; agentId: string; destination: TriggerDestination; sourceKind: "time" }): Promise<HostPreflight> {
		this.log.push(`preflight:${input.triggerId}`);
		const scripted = this.script.preflight?.shift();
		if (scripted) return scripted();
		if (!this.agents.has(input.agentId)) return { ok: false, reason: "the agent was deleted", retryable: false };
		if (input.destination.type === "existing_chat" && this.chats.get(input.destination.chatId)?.agent !== input.agentId) return { ok: false, reason: "the chat is gone", retryable: false };
		if (this.suspended) return { ok: false, reason: "the space is suspended", retryable: true };
		return { ok: true };
	}

	async findChat(input: { operationId: string }): Promise<ChatLookup> {
		this.log.push(`findChat:${input.operationId}`);
		const scripted = this.script.findChat?.shift();
		if (scripted === "unknown") return { status: "unknown" };
		const found = [...this.chats].find(([, chat]) => chat.operationId === input.operationId);
		return found ? { status: "found", chatId: found[0] } : { status: "absent" };
	}

	async createChat(input: { operationId: string; agentId: string; title: string }): Promise<ChatCreation> {
		this.log.push(`createChat:${input.operationId}`);
		const scripted = this.script.createChat?.shift();
		if (scripted === "throw") throw new Error("connection reset");
		if (!this.agents.has(input.agentId)) return { status: "denied", reason: "the agent was deleted" };
		const known = this.idempotentChats ? [...this.chats].find(([, chat]) => chat.operationId === input.operationId) : undefined;
		const chatId = known?.[0] ?? `chat-${this.chats.size + 1}`;
		this.chats.set(chatId, { agent: input.agentId, operationId: input.operationId });
		if (scripted === "throw_after_create") throw new Error("connection reset after the chat was made");
		return { status: "created", chatId };
	}

	async lookupSubmission(input: { operationId: string }): Promise<SubmissionLookup> {
		this.log.push(`lookupSubmission:${input.operationId}`);
		const scripted = this.script.lookupSubmission?.shift();
		if (scripted === "throw") throw new Error("storage unavailable");
		if (scripted === "unknown") return { status: "unknown" };
		if (scripted === "absent") return { status: "absent" };
		const known = this.submissions.get(input.operationId);
		return known ? { status: "accepted", receipt: known.receipt } : { status: "absent" };
	}

	async submit(input: { idempotencyKey: string; chatId: string; agentId: string; instruction: string; evidence: TimeEvidence }): Promise<SubmitResult> {
		this.log.push(`submit:${input.idempotencyKey}`);
		const scripted = this.script.submit?.shift();
		if (typeof scripted === "object") await scripted.promise;
		if (scripted === "throw") throw new Error("connection reset before the request was sent");
		if (scripted === "uncertain") return { status: "uncertain", reason: "timed out" };
		if (scripted === "fail") return { status: "failed", reason: "the input was refused" };
		if (this.suspended) return { status: "suspended", reason: "the space is suspended" };
		if (this.chats.get(input.chatId)?.agent !== input.agentId) return { status: "failed", reason: "the chat is gone" };
		if (this.budget <= 0) return { status: "budget_blocked", reason: "the daily run limit is reached" };
		// Reserved before the record is checked, and given back for a duplicate, as `submitTo` does.
		this.budget--;
		this.ledger.reserved++;
		const known = this.submissions.get(input.idempotencyKey);
		if (known) {
			this.budget++;
			this.ledger.released++;
			return { status: "duplicate", receipt: known.receipt };
		}
		const receipt = `receipt-${++this.#receipts}`;
		this.submissions.set(input.idempotencyKey, { receipt, chatId: input.chatId, instruction: input.instruction, evidence: input.evidence });
		this.runs.set(receipt, "queued");
		if (scripted === "accept_then_throw") throw new Error("connection reset after it was accepted");
		return { status: "accepted", receipt };
	}

	async lookupRun(input: { operationId: string; receipt: string }): Promise<RunStatus> {
		this.log.push(`lookupRun:${input.operationId}`);
		return this.runs.get(input.receipt) ?? "unknown";
	}

	calls(kind: string): number {
		return this.log.filter((entry) => entry.startsWith(`${kind}:`)).length;
	}

	/** Ends every run it knows of. */
	finishAll(status: RunStatus = "completed"): void {
		for (const receipt of this.runs.keys()) this.runs.set(receipt, status);
	}
}

type Context = {
	store: TriggerStore;
	coordinator: TriggerCoordinator;
	host: FakeHost;
	clock: { now: number };
	sql: SqlStorage;
	/** A new store and coordinator on the same database and host, as after the Durable Object restarts; `crash` aborts every transaction before it commits. */
	restart: (options?: Partial<TriggerCoordinatorOptions> & { crash?: boolean }) => { store: TriggerStore; coordinator: TriggerCoordinator };
};

async function withCoordinator(work: (context: Context) => Promise<void>, options: Partial<TriggerCoordinatorOptions> = {}): Promise<void> {
	await runInDurableObject(env.Pim.getByName(`coordinator-${crypto.randomUUID()}`), async (_pim: Pim, state) => {
		const clock = { now: START };
		const host = new FakeHost();
		const restart = (more: Partial<TriggerCoordinatorOptions> & { crash?: boolean } = {}) => {
			const transaction = <T>(run: () => T): T =>
				state.storage.transactionSync(() => {
					const result = run();
					if (more.crash) throw new Error("crash before commit");
					return result;
				});
			// No `authorize`: as in Pim, nothing that runs on the computer can be enabled.
			const store = new TriggerStore(state.storage.sql, { transaction, now: () => clock.now });
			const coordinator = new TriggerCoordinator(state.storage.sql, { store, host, transaction, now: () => clock.now, ...options, ...more });
			return { store, coordinator };
		};
		const { store, coordinator } = restart();
		await work({ store, coordinator, host, clock, sql: state.storage.sql, restart });
	});
}

const base = { version: 1, owningAgentId: "agent-1", originChatId: "chat-1", label: "Morning brief", instruction: "Write my morning brief.", destination: { type: "existing_chat", chatId: "chat-1" } };
const hourly = (over: Record<string, unknown> = {}) => ({ ...base, source: { kind: "time", schedule: "interval", everyMs: HOUR, anchorAt: START + HOUR }, ...over });

function create(store: TriggerStore, id: string, spec: unknown) {
	const result = store.create({ id, spec, lifecycle: "enabled" });
	if (!result.ok) throw new Error(`not created: ${result.reason}`);
	return result.trigger;
}

describe("time trigger coordinator", () => {
	it("admits a due firing once and hands it on once, however often the alarm goes off", async () => {
		await withCoordinator(async ({ store, coordinator, host, clock }) => {
			create(store, "brief", hourly());
			expect(await coordinator.tick()).toMatchObject({ admitted: [], handedOn: [], nextWakeAt: START + HOUR });
			clock.now = START + HOUR;
			// Two alarms at once, then a third: one occurrence, one submission.
			const [first, second] = await Promise.all([coordinator.tick(), coordinator.tick()]);
			await coordinator.tick();
			expect([...first.admitted, ...second.admitted]).toHaveLength(1);
			expect([...first.handedOn, ...second.handedOn]).toHaveLength(1);
			expect(host.calls("submit")).toBe(1);
			const [occurrence] = store.occurrences("brief");
			const [item] = store.outbox("brief");
			expect(item).toMatchObject({ status: "done", operationId: `trigger:brief:${occurrence!.id}` });
			// Accepted is not finished: the run is tracked from what the host says of it.
			const run = coordinator.run(item!.operationId)!;
			expect(run).toMatchObject({ phase: "queued", revision: 1, chatId: "chat-1", scheduledFor: START + HOUR, admittedAt: START + HOUR, acceptedAt: START + HOUR, receipt: "receipt-1" });
			// The run is told of the firing's times and schedule, and nothing else.
			expect(host.submissions.get(item!.operationId)).toEqual({
				receipt: "receipt-1",
				chatId: "chat-1",
				instruction: "Write my morning brief.",
				evidence: { kind: "time", triggerId: "brief", revision: 1, label: "Morning brief", scheduledFor: START + HOUR, admittedAt: START + HOUR, schedule: { schedule: "interval", everyMs: HOUR, anchorAt: START + HOUR }, older: null },
			});
			expect(host.ledger).toEqual({ reserved: 1, released: 0 });
			// The next wake is the next run check, then the next firing once the run ends.
			expect(coordinator.nextWakeAt()).toBe(START + HOUR + MINUTE);
			host.finishAll();
			clock.now = START + HOUR + MINUTE;
			await coordinator.tick();
			expect(coordinator.run(item!.operationId)?.phase).toBe("completed");
			expect(coordinator.nextWakeAt()).toBe(START + 2 * HOUR);
		});
	});

	it("neither loses nor replays a firing across a crash before or after its admission commits", async () => {
		await withCoordinator(async ({ store, host, clock, restart }) => {
			create(store, "brief", hourly());
			// Down from the start until two firings have passed, the first more than an hour late.
			clock.now = START + 2 * HOUR + 30 * MINUTE;
			const crashed = restart({ crash: true });
			await expect(crashed.coordinator.tick()).rejects.toThrow("crash before commit");
			expect(store.occurrences("brief")).toEqual([]);
			expect(store.sourceState("brief")).toMatchObject({ lastObservedAt: null, activeSince: START, nextWakeAt: START });
			// Up again: the boundary is still when it was enabled, so the latest firing runs once and the older one is counted.
			const up = restart();
			const report = await up.coordinator.tick();
			expect(report.admitted).toHaveLength(1);
			expect(store.occurrences("brief")).toMatchObject([{ key: `time:${START + 2 * HOUR}`, evidence: { reason: "time", scheduledFor: START + 2 * HOUR, older: { count: 1, first: START + HOUR, last: START + HOUR, complete: true } } }]);
			// Restarted after it committed: nothing is admitted or submitted again.
			const again = restart();
			expect((await again.coordinator.tick()).admitted).toEqual([]);
			expect(host.calls("submit")).toBe(1);

			// Paused across firings and enabled again: the paused hours are not replayed; firings count from the new enabling.
			clock.now = START + 3 * HOUR + 10 * MINUTE;
			expect(store.setLifecycle({ id: "brief", to: "paused" })).toMatchObject({ ok: true });
			clock.now = START + 6 * HOUR + 30 * MINUTE;
			expect(store.setLifecycle({ id: "brief", to: "enabled", expectedRevision: 1 })).toMatchObject({ ok: true });
			expect(store.sourceState("brief")?.activeSince).toBe(START + 6 * HOUR + 30 * MINUTE);
			expect((await again.coordinator.tick()).admitted).toEqual([]);
			expect(store.sourceState("brief")?.nextWakeAt).toBe(START + 7 * HOUR);
		});
	});

	it("pins a new chat before submitting, and never makes a second one on a crash or a retry", async () => {
		await withCoordinator(
			async ({ store, coordinator, host, clock, restart }) => {
				host.idempotentChats = false;
				create(store, "brief", hourly({ destination: { type: "new_chat" } }));
				clock.now = START + HOUR;
				host.script.createChat = ["throw_after_create"];
				const report = await coordinator.tick();
				const [item] = store.outbox("brief");
				// The chat was made, but the answer was lost: nothing is submitted, and the run knows a chat may exist.
				expect(report.deferred).toEqual([item!.operationId]);
				expect(coordinator.run(item!.operationId)).toMatchObject({ phase: "preparing", chatId: null, chatState: "creating" });
				expect(host.calls("submit")).toBe(0);
				// After a restart, the chat is looked up, found and pinned, never made again.
				const up = restart();
				clock.now = START + HOUR + 10 * MINUTE;
				host.script.findChat = ["unknown"];
				await up.coordinator.tick();
				expect(host.calls("createChat")).toBe(1);
				expect(host.calls("submit")).toBe(0);
				clock.now = START + HOUR + 20 * MINUTE;
				expect((await up.coordinator.tick()).handedOn).toEqual([item!.operationId]);
				expect(host.calls("createChat")).toBe(1);
				expect(host.chats.size).toBe(2);
				expect(up.coordinator.run(item!.operationId)).toMatchObject({ phase: "accepted", chatId: "chat-2", chatState: "pinned", deferrals: 2 });
				expect(host.submissions.get(item!.operationId)?.chatId).toBe("chat-2");

				// A definitive refusal ends the operation; its chat stays pinned, and no other chat is made for it.
				host.finishAll();
				clock.now = START + 2 * HOUR;
				host.script.submit = ["fail"];
				await up.coordinator.tick();
				const second = store.outbox("brief")[1]!;
				expect(up.coordinator.run(second.operationId)).toMatchObject({ phase: "not_submitted", chatId: "chat-3", lastError: "the input was refused" });
				expect(second.status).toBe("failed");
				expect(host.calls("createChat")).toBe(2);
			},
			{ retryMs: 10 * MINUTE },
		);
	});

	it("asks the host after a submission's answer was lost, and never submits or reserves the budget again", async () => {
		await withCoordinator(
			async ({ store, coordinator, host, clock, restart }) => {
				create(store, "brief", hourly());
				clock.now = START + HOUR;
				host.script.submit = ["accept_then_throw"];
				await coordinator.tick();
				const [item] = store.outbox("brief");
				// A throw is not an acceptance, and not a refusal: the outcome is unknown, and it holds the trigger's slot.
				expect(coordinator.run(item!.operationId)).toMatchObject({ phase: "submitting", receipt: null, lastError: "connection reset after it was accepted" });
				expect(item?.status).toBe("leased");
				// The process restarts; a firing meanwhile waits behind the unknown one.
				const up = restart();
				clock.now = START + 2 * HOUR;
				host.script.lookupSubmission = ["unknown"];
				const waiting = await up.coordinator.tick();
				expect(waiting.admitted).toHaveLength(1);
				expect(waiting.handedOn).toEqual([]);
				expect(up.coordinator.run(item!.operationId)?.phase).toBe("submitting");
				clock.now = START + 2 * HOUR + 10 * MINUTE;
				const settled = await up.coordinator.tick();
				expect(settled.reconciled).toEqual([item!.operationId]);
				expect(up.coordinator.run(item!.operationId)).toMatchObject({ phase: "queued", receipt: "receipt-1" });
				expect(store.outbox("brief")[0]?.status).toBe("done");
				expect(host.calls("submit")).toBe(1);
				expect(host.ledger).toEqual({ reserved: 1, released: 0 });
				// The waiting firing goes once the first run ends.
				host.finishAll();
				clock.now = START + 2 * HOUR + 11 * MINUTE;
				await up.coordinator.tick();
				expect(host.calls("submit")).toBe(2);
			},
			{ retryMs: 10 * MINUTE },
		);
	});

	it("gives back the reservation of a duplicate when a lookup missed a submission the host had accepted", async () => {
		await withCoordinator(
			async ({ store, coordinator, host, clock }) => {
				create(store, "brief", hourly());
				clock.now = START + HOUR;
				host.script.submit = ["accept_then_throw"];
				await coordinator.tick();
				const [item] = store.outbox("brief");
				// A stale answer says it was never submitted, so it is submitted again under the same key, and the host knows it.
				host.script.lookupSubmission = ["absent"];
				clock.now = START + HOUR + 10 * MINUTE;
				const report = await coordinator.tick();
				expect(report.handedOn).toEqual([item!.operationId]);
				expect(host.calls("submit")).toBe(2);
				expect(host.ledger).toEqual({ reserved: 2, released: 1 });
				expect(host.submissions.size).toBe(1);
				expect(coordinator.run(item!.operationId)).toMatchObject({ phase: "accepted", receipt: "receipt-1" });
				expect(store.outbox("brief")[0]).toMatchObject({ status: "done", attempts: 2 });
			},
			{ retryMs: 10 * MINUTE },
		);
	});

	it("defers on the run limit without moving the admission deadline, hands on past the hour, and gives up only at its own deadline", async () => {
		await withCoordinator(
			async ({ store, coordinator, host, clock }) => {
				create(store, "remind", { ...base, source: { kind: "time", schedule: "once", at: START + 10 * MINUTE } });
				host.budget = 0;
				clock.now = START + 10 * MINUTE;
				const blocked = await coordinator.tick();
				expect(blocked.admitted).toHaveLength(1);
				expect(blocked.deferred).toHaveLength(1);
				expect(store.get("remind")).toMatchObject({ lifecycle: "ended", health: "budget_blocked" });
				expect(host.ledger.reserved).toBe(0);
				// Two hours later, past the one-time trigger's hour: admitted work is still handed on, not missed or cancelled.
				clock.now = START + 2 * HOUR;
				host.budget = 1;
				expect((await coordinator.tick()).handedOn).toHaveLength(1);
				const [occurrence] = store.occurrences("remind");
				expect(occurrence).toMatchObject({ status: "delivered", createdAt: START + 10 * MINUTE });
				const run = coordinator.run(store.outbox("remind")[0]!.operationId)!;
				expect(run).toMatchObject({ admittedAt: START + 10 * MINUTE, firstDispatchAt: START + 10 * MINUTE, acceptedAt: START + 2 * HOUR, deliverBy: START + 10 * MINUTE + 3 * HOUR, deferrals: 1 });
				expect(host.ledger).toEqual({ reserved: 1, released: 0 });

				// Blocked past its own deadline, it is never submitted, and nothing was reserved for it.
				create(store, "late", { ...base, source: { kind: "time", schedule: "once", at: START + 3 * HOUR } });
				host.budget = 0;
				clock.now = START + 3 * HOUR;
				await coordinator.tick();
				const late = store.outbox("late")[0]!;
				for (let step = 1; step <= 3; step++) {
					clock.now = START + 3 * HOUR + step * HOUR;
					await coordinator.tick();
				}
				expect(coordinator.run(late.operationId)).toMatchObject({ phase: "not_submitted", lastError: "the daily run limit is reached; the time to hand it on ran out" });
				expect(store.outbox("late")[0]?.status).toBe("failed");
				expect(host.ledger).toEqual({ reserved: 1, released: 0 });
			},
			{ retryMs: HOUR, deliveryTtlMs: 3 * HOUR },
		);
	});

	it("keeps one agent run per trigger with only its latest firing pending; a run waiting for approval holds its slot but no compute", async () => {
		await withCoordinator(
			async ({ store, coordinator, host, clock }) => {
				create(store, "a", hourly());
				create(store, "b", hourly({ source: { kind: "time", schedule: "interval", everyMs: HOUR, anchorAt: START + 3 * HOUR } }));
				clock.now = START + HOUR;
				await coordinator.tick();
				const first = store.outbox("a")[0]!;
				host.runs.set("receipt-1", "waiting_approval");
				clock.now = START + HOUR + MINUTE;
				await coordinator.tick();
				expect(coordinator.run(first.operationId)?.phase).toBe("waiting_approval");
				// Two more firings: the newer supersedes the older while the run waits, and neither is handed on.
				clock.now = START + 2 * HOUR;
				await coordinator.tick();
				clock.now = START + 3 * HOUR;
				await coordinator.tick();
				expect(store.outbox("a").map((item) => item.status)).toEqual(["done", "superseded", "pending"]);
				expect(host.calls("submit")).toBe(2);
				// b ran meanwhile, though only one run may hold compute: a's waits for an approval.
				const b = store.outbox("b")[0]!;
				expect(coordinator.run(b.operationId)?.phase).toBe("accepted");
				// a's approval comes; a callback for another receipt changes nothing, the right one frees a's slot.
				expect(coordinator.runStatusChanged({ operationId: first.operationId, receipt: "receipt-9", status: "completed" })).toEqual({ ok: false });
				expect(coordinator.runStatusChanged({ operationId: first.operationId, receipt: "receipt-1", status: "completed" })).toEqual({ ok: true });
				expect(coordinator.runStatusChanged({ operationId: first.operationId, receipt: "receipt-1", status: "running" })).toEqual({ ok: false });
				// b's run holds the space's one compute slot, so a's latest waits for it.
				host.runs.set("receipt-2", "running");
				clock.now = START + 3 * HOUR + MINUTE;
				await coordinator.tick();
				expect(host.calls("submit")).toBe(2);
				host.runs.set("receipt-2", "completed");
				clock.now = START + 3 * HOUR + 2 * MINUTE;
				const report = await coordinator.tick();
				expect(report.handedOn).toEqual([store.outbox("a")[2]!.operationId]);
				expect(host.submissions.get(store.outbox("a")[2]!.operationId)?.evidence.scheduledFor).toBe(START + 3 * HOUR);
			},
			{ maxRunning: 1 },
		);
	});

	it("keeps what happened when a trigger is paused, edited or deleted during a handoff, and starts nothing new", async () => {
		await withCoordinator(
			async ({ store, coordinator, host, clock }) => {
				const settle = () => new Promise((resolve) => setTimeout(resolve, 10));
				create(store, "edit", hourly());
				clock.now = START + HOUR;
				const editGate = deferred();
				host.script.submit = [editGate];
				const running = coordinator.tick();
				await settle();
				expect(host.calls("submit")).toBe(1);
				// While the host is answering, its instruction changes and it is paused.
				expect(store.update({ id: "edit", expectedRevision: 1, spec: { ...hourly(), instruction: "Write the evening brief." } })).toMatchObject({ ok: true, trigger: { revision: 2 } });
				expect(store.setLifecycle({ id: "edit", to: "paused" })).toMatchObject({ ok: true });
				// Another tick, past the lease, neither claims it nor asks about it while the answer is awaited.
				clock.now = START + HOUR + 6 * MINUTE;
				await coordinator.tick();
				expect(host.calls("submit")).toBe(1);
				expect(host.calls("lookupSubmission")).toBe(0);
				// Nor does the alarm spin on what it is waiting for.
				expect(coordinator.nextWakeAt()).toBeNull();
				editGate.resolve();
				await running;
				// Its submission is recorded as it happened, with the revision it was made under.
				const editItem = store.outbox("edit")[0]!;
				expect(editItem.status).toBe("done");
				expect(coordinator.run(editItem.operationId)).toMatchObject({ phase: "accepted", revision: 1 });
				expect(host.submissions.get(editItem.operationId)).toMatchObject({ instruction: "Write my morning brief.", evidence: { revision: 1 } });

				// Another's submission is under way when it is deleted: the run it started is recorded and followed, not called cancelled.
				create(store, "gone", hourly());
				clock.now = START + 2 * HOUR;
				const goneGate = deferred();
				host.script.submit = [goneGate];
				const deleting = coordinator.tick();
				await settle();
				expect(host.calls("submit")).toBe(2);
				expect(store.remove({ id: "gone" })).toEqual({ ok: true });
				expect(store.outbox("gone")[0]?.status).toBe("outcome_unknown");
				goneGate.resolve();
				await deleting;
				const goneItem = store.outbox("gone")[0]!;
				expect(goneItem.status).toBe("done");
				expect(store.occurrences("gone")[0]?.status).toBe("delivered");
				expect(coordinator.run(goneItem.operationId)?.phase).toBe("accepted");
				// Hours later nothing new is admitted or handed on for either; the deleted one's run is still followed, and its history stays.
				clock.now = START + 5 * HOUR;
				const later = await coordinator.tick();
				expect(later.admitted).toEqual([]);
				expect(host.calls("submit")).toBe(2);
				expect(coordinator.runs("gone")).toHaveLength(1);
				expect(coordinator.run(goneItem.operationId)?.phase).toBe("queued");
			},
			{ leaseMs: 5 * MINUTE },
		);
	});

	it("holds an admitted occurrence paused before its submission, and hands it on with its revision once enabled", async () => {
		await withCoordinator(async ({ store, coordinator, host, clock }) => {
			create(store, "brief", hourly());
			clock.now = START + HOUR;
			const gate = deferred();
			host.script.preflight = [
				async () => {
					await gate.promise;
					return { ok: true };
				},
			];
			const running = coordinator.tick();
			await new Promise((resolve) => setTimeout(resolve, 10));
			store.update({ id: "brief", expectedRevision: 1, spec: { ...hourly(), instruction: "Write the evening brief." } });
			store.setLifecycle({ id: "brief", to: "paused" });
			gate.resolve();
			await running;
			expect(host.calls("submit")).toBe(0);
			expect(store.outbox("brief")[0]).toMatchObject({ status: "pending" });
			clock.now = START + 90 * MINUTE;
			expect(store.setLifecycle({ id: "brief", to: "enabled", expectedRevision: 2 })).toMatchObject({ ok: true });
			const report = await coordinator.tick();
			expect(report.admitted).toEqual([]);
			expect(report.handedOn).toHaveLength(1);
			expect(host.submissions.get(store.outbox("brief")[0]!.operationId)).toMatchObject({ instruction: "Write my morning brief.", evidence: { revision: 1, scheduledFor: START + HOUR } });
		});
	});

	it("settles outcomes the store lost track of by asking the host, and leaves an unknown one unknown", async () => {
		await withCoordinator(
			async ({ store, coordinator, host, clock }) => {
				for (const id of ["lost", "deleted", "silent"]) create(store, id, hourly());
				clock.now = START + HOUR;
				for (const id of ["lost", "deleted", "silent"]) store.admitDueTime({ id, generation: 1 });
				// An earlier deliverer claimed them with the store alone: one's leases ran out five times, one was deleted while claimed.
				for (let attempt = 0; attempt < 6; attempt++) {
					store.claim({ leaseMs: MINUTE, triggerId: "lost" });
					clock.now += MINUTE;
				}
				store.claim({ leaseMs: MINUTE, triggerId: "deleted" });
				store.remove({ id: "deleted" });
				for (let attempt = 0; attempt < 6; attempt++) {
					store.claim({ leaseMs: MINUTE, triggerId: "silent" });
					clock.now += MINUTE;
				}
				const [lost, deleted, silent] = ["lost", "deleted", "silent"].map((id) => store.outbox(id)[0]!);
				expect([lost!.status, deleted!.status, silent!.status]).toEqual(["outcome_unknown", "outcome_unknown", "outcome_unknown"]);
				// The host had accepted the first; it never saw the second; it can't say about the third yet.
				host.submissions.set(lost!.operationId, { receipt: "receipt-old", chatId: "chat-1", instruction: "Write my morning brief.", evidence: {} as TimeEvidence });
				host.runs.set("receipt-old", "running");
				const realLookup = host.lookupSubmission.bind(host);
				host.lookupSubmission = async (input) => (input.operationId === silent!.operationId ? { status: "unknown" } : realLookup(input));
				const report = await coordinator.tick();
				expect(report.reconciled.sort()).toEqual([lost!.operationId, deleted!.operationId].sort());
				expect(store.outbox("lost")[0]?.status).toBe("done");
				expect(coordinator.run(lost!.operationId)).toMatchObject({ phase: "running", receipt: "receipt-old" });
				expect(store.outbox("deleted")[0]?.status).toBe("failed");
				expect(coordinator.run(deleted!.operationId)?.phase).toBe("not_submitted");
				expect(store.outbox("silent")[0]?.status).toBe("outcome_unknown");
				expect(coordinator.run(silent!.operationId)).toMatchObject({ phase: "submitting", checkAt: clock.now + 10 * MINUTE });
				// Nothing was submitted for any of them, and the unknown one holds its trigger's slot.
				expect(host.calls("submit")).toBe(0);
				clock.now = START + 2 * HOUR;
				const next = await coordinator.tick();
				expect(next.admitted).toHaveLength(2);
				expect(next.handedOn).toEqual([]);
				expect(host.calls("submit")).toBe(0);
			},
			{ retryMs: 10 * MINUTE },
		);
	});

	it("hands on only time firings, never substitutes an agent or chat, and enables nothing on the computer", async () => {
		await withCoordinator(async ({ store, coordinator, host, clock }) => {
			// A connector event the store took in stays pending: its context and grant have no contract yet.
			create(store, "event", { ...base, source: { kind: "connector_event", connectorId: "flights", event: "price.changed" } });
			expect(store.admit({ id: "event", generation: 1, eventId: "e1", observedAt: START, payload: { price: 1 } })).toMatchObject({ status: "accepted" });
			// With no grant check given, as in Pim, no computer source can be enabled.
			expect(store.create({ id: "poll", spec: { ...base, source: { kind: "poll", command: "./check.sh" }, condition: { when: { op: "exists", path: ["a"] } }, authorizationRef: "approval-1" }, lifecycle: "enabled" })).toMatchObject({
				ok: false,
				reason: "authorization_denied",
			});
			create(store, "orphan", hourly());
			create(store, "moved", hourly({ destination: { type: "existing_chat", chatId: "chat-old" } }));
			clock.now = START + HOUR;
			await coordinator.tick();
			expect(store.outbox("event")[0]?.status).toBe("pending");
			expect(host.log.some((entry) => entry.includes("event"))).toBe(false);
			// The chat named is gone: the operation ends and the trigger says why, with no new chat made in its place.
			const moved = store.outbox("moved")[0]!;
			expect(coordinator.run(moved.operationId)).toMatchObject({ phase: "not_submitted", lastError: "the chat is gone" });
			expect(store.get("moved")).toMatchObject({ health: "configuration_error", healthDetail: "the chat is gone" });
			// The agent is deleted: nothing is submitted, to it or to any other agent.
			host.agents.delete("agent-1");
			host.finishAll();
			clock.now = START + 2 * HOUR;
			await coordinator.tick();
			const orphan = store.outbox("orphan")[1]!;
			expect(coordinator.run(orphan.operationId)).toMatchObject({ phase: "not_submitted", lastError: "the agent was deleted" });
			expect(host.calls("createChat")).toBe(0);
			expect(host.calls("submit")).toBe(1);
			expect([...host.submissions.values()].every((submission) => submission.chatId === "chat-1")).toBe(true);
		});
	});

	it("admits in bounded batches and says when to wake", async () => {
		await withCoordinator(
			async ({ store, coordinator, clock }) => {
				const ids = ["t1", "t2", "t3", "t4", "t5"];
				for (const id of ids) create(store, id, hourly());
				clock.now = START + HOUR;
				const first = await coordinator.tick();
				expect(first.admitted).toHaveLength(2);
				// More is due, so the next wake is now.
				expect(first.nextWakeAt).toBe(clock.now);
				expect((await coordinator.tick()).admitted).toHaveLength(2);
				expect((await coordinator.tick()).admitted).toHaveLength(1);
				expect(ids.map((id) => store.sourceState(id)?.nextWakeAt)).toEqual(ids.map(() => START + 2 * HOUR));
				for (const id of ids) store.setLifecycle({ id, to: "paused" });
				for (const id of ids) coordinator.runs(id).forEach((run) => coordinator.runStatusChanged({ operationId: run.operationId, receipt: run.receipt!, status: "completed" }));
				expect(coordinator.nextWakeAt()).toBeNull();
			},
			{ batch: { admissions: 2 } },
		);
	});

	it("hands on fairly: the trigger handed on to longest ago goes first, not the one with the oldest occurrence", async () => {
		await withCoordinator(
			async ({ store, coordinator, host, clock, sql }) => {
				create(store, "chatty", hourly({ source: { kind: "time", schedule: "interval", everyMs: 10 * MINUTE, anchorAt: START + 10 * MINUTE } }));
				create(store, "quiet", hourly());
				create(store, "rare", hourly());
				clock.now = START + 10 * MINUTE;
				expect((await coordinator.tick()).handedOn).toHaveLength(1);
				host.finishAll();
				// An hour on, all three are due, chatty's occurrence first; one handoff per tick goes to those not handed on yet.
				clock.now = START + HOUR;
				const order: string[] = [];
				for (let tick = 0; tick < 3; tick++) {
					const report = await coordinator.tick();
					order.push(...report.handedOn.map((operation) => operation.split(":")[1]!));
					host.finishAll();
					clock.now += 1_000;
				}
				const admittedOrder = sql.exec("SELECT trigger_id FROM pim_trigger_outbox WHERE created_at = ? ORDER BY seq", START + HOUR).toArray();
				expect(admittedOrder.map((row) => row.trigger_id)).toEqual(["chatty", "quiet", "rare"]);
				expect(order).toEqual(["quiet", "rare", "chatty"]);
			},
			{ batch: { handoffs: 1 }, runCheckMs: 1_000 },
		);
	});

	it("admits the canonical sequence of a local cron across both daylight saving changes", async () => {
		await withCoordinator(async ({ store, coordinator, host, clock }) => {
			clock.now = at("2026-10-30T12:00:00-04:00");
			create(store, "night", { ...base, source: { kind: "time", schedule: "cron", expression: "30 1 * * *", timeZone: "America/New_York" } });
			create(store, "early", { ...base, source: { kind: "time", schedule: "cron", expression: "30 2 * * *", timeZone: "America/New_York" } });
			// The alarm goes off when the coordinator asks, and again in the repeated hour, as a restart might.
			const extra = [at("2026-11-01T01:10:00-05:00"), at("2026-11-01T01:40:00-05:00")];
			const until = at("2027-03-16T12:00:00-04:00");
			while (clock.now < until) {
				host.finishAll();
				const wake = (await coordinator.tick()).nextWakeAt;
				const next = Math.min(wake ?? until, extra[0] ?? until);
				if (next === extra[0]) extra.shift();
				clock.now = Math.max(clock.now + 1, next);
			}
			const local = (id: string) => store.occurrences(id).map((occurrence) => occurrence.dueAt);
			const night = local("night");
			expect(night).toContain(at("2026-11-01T01:30:00-04:00"));
			expect(night).not.toContain(at("2026-11-01T01:30:00-05:00"));
			expect(night).toContain(at("2026-11-02T01:30:00-05:00"));
			expect(new Set(night.map((time) => new Date(time).toISOString().slice(0, 10))).size).toBe(night.length);
			const early = local("early");
			expect(early).toContain(at("2027-03-13T02:30:00-05:00"));
			expect(early).toContain(at("2027-03-15T02:30:00-04:00"));
			expect(early.filter((time) => time > at("2027-03-13T12:00:00-05:00") && time < at("2027-03-15T00:00:00-04:00"))).toEqual([]);
			// Each is admitted on time, never as missed, and handed on once.
			expect(store.occurrences("night").every((occurrence) => occurrence.status === "delivered")).toBe(true);
			expect(host.submissions.size).toBe(night.length + early.length);
		});
	});

	it("stops at the supported range rather than scheduling past 2100", async () => {
		await withCoordinator(async ({ store, coordinator, clock }) => {
			// The 29th of February from 2097 next falls in 2104: refused when saved, with nothing written.
			clock.now = at("2097-03-01T00:00:00Z");
			expect(() => store.create({ id: "leap", spec: { ...base, source: { kind: "time", schedule: "cron", expression: "0 0 29 2 *", timeZone: "UTC" } }, lifecycle: "enabled" })).toThrow(TriggerValidationError);
			expect(store.get("leap")).toBeUndefined();
			// A daily interval admits its last firing at the limit, then stops and says so, scheduling no wake beyond it.
			clock.now = at("2099-12-31T12:00:00Z");
			create(store, "daily", { ...base, source: { kind: "time", schedule: "interval", everyMs: DAY, anchorAt: at("2099-12-30T00:00:00Z") } });
			expect((await coordinator.tick()).nextWakeAt).toBe(at("2100-01-01T00:00:00Z"));
			clock.now = at("2100-01-01T00:00:00Z");
			const report = await coordinator.tick();
			expect(report.admitted).toHaveLength(1);
			expect(store.sourceState("daily")?.nextWakeAt).toBeNull();
			expect(store.get("daily")).toMatchObject({ lifecycle: "enabled", health: "configuration_error", healthDetail: "the next firing is after 2100-01-01, past the supported range" });
			// A clock past the range stops a trigger instead of throwing from the tick.
			clock.now = at("2099-12-31T23:00:00Z");
			create(store, "hourly", { ...base, source: { kind: "time", schedule: "interval", everyMs: HOUR, anchorAt: at("2099-12-31T00:00:00Z") } });
			clock.now = at("2100-01-02T00:00:00Z");
			await expect(coordinator.tick()).resolves.toMatchObject({ admitted: [] });
			expect(store.get("hourly")).toMatchObject({ health: "configuration_error" });
			expect(store.sourceState("hourly")?.nextWakeAt).toBeNull();
			// A one-time trigger paused past its time can't be enabled to wait for nothing.
			clock.now = at("2099-06-01T00:00:00Z");
			create(store, "once", { ...base, source: { kind: "time", schedule: "once", at: at("2099-06-01T01:00:00Z") } });
			store.setLifecycle({ id: "once", to: "paused" });
			clock.now = at("2099-06-01T02:00:00Z");
			expect(store.setLifecycle({ id: "once", to: "enabled", expectedRevision: 1 })).toMatchObject({ ok: false, reason: "schedule_exhausted" });
		});
	});

	it("adds no wiring: nothing outside src/triggers uses it", () => {
		const files = import.meta.glob(["../src/**/*.ts", "../preview/**/*.ts", "../pim.config.ts", "../test/worker.ts", "../web/src/**/*.{ts,tsx}"], { query: "?raw", import: "default", eager: true });
		expect(Object.keys(files)).toContain("../src/pim.ts");
		const users = Object.entries(files)
			.filter(([path]) => !path.startsWith("../src/triggers/"))
			.filter(([, source]) => /triggers\/|TriggerCoordinator|TriggerStore|pim_trigger/.test(source))
			.map(([path]) => path);
		expect(users).toEqual([]);
	});
});
