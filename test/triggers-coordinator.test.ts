import { env, runInDurableObject } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import type { Pim } from "../src/pim";
import {
	type ChatCreation,
	type ChatLookup,
	type HostPreflight,
	MAX_RECEIPT_LENGTH,
	type RunStatus,
	type SubmissionLookup,
	type SubmitResult,
	type TimeEvidence,
	type TriggerAgentHost,
	TriggerCoordinator,
	type TriggerCoordinatorOptions,
	UNKNOWN_ATTENTION,
} from "../src/triggers/coordinator";
import type { TriggerDestination } from "../src/triggers/spec";
import { TriggerStore } from "../src/triggers/store";
import { TriggerValidationError } from "../src/triggers/validate";

// These tests build the store and the coordinator on a Durable Object's database of their own (Pim's own engine is tested in test/triggers-host.test.ts),
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

/** A promise that never settles: a host that never answers. */
const never = () => new Promise<void>(() => {});
const settle = () => new Promise((resolve) => setTimeout(resolve, 10));

type Method = "preflight" | "findChat" | "createChat" | "lookupSubmission" | "submit" | "lookupRun";

/**
 * A host with chats, a run budget and runs of its own, which keeps its own
 * record by idempotency key as `submitTo` does. `hooks` run at the start of
 * each method's next calls, to hold or slow it; `script` sets what its next
 * calls answer; `log` records every call; `maxActive` is the most runs it
 * ever had accepted and not ended at once.
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
	maxActive = 0;
	log: string[] = [];
	hooks: Partial<Record<Method, (() => Promise<void>)[]>> = {};
	script: {
		findChat?: ChatLookup["status"][];
		createChat?: ("throw_after_create" | "throw")[];
		submit?: ("accept_then_throw" | "throw" | "uncertain" | "fail")[];
		lookupSubmission?: ("unknown" | "absent" | "throw")[];
	} = {};
	#receipts = 0;

	async #hook(method: Method): Promise<void> {
		const hook = this.hooks[method]?.shift();
		if (hook) await hook();
	}

	async preflight(input: { triggerId: string; operationId: string; agentId: string; destination: TriggerDestination; sourceKind: "time" }): Promise<HostPreflight> {
		this.log.push(`preflight:${input.triggerId}`);
		await this.#hook("preflight");
		if (!this.agents.has(input.agentId)) return { ok: false, reason: "the agent was deleted", retryable: false };
		if (input.destination.type === "existing_chat" && this.chats.get(input.destination.chatId)?.agent !== input.agentId) return { ok: false, reason: "the chat is gone", retryable: false };
		if (this.suspended) return { ok: false, reason: "the space is suspended", retryable: true };
		return { ok: true };
	}

	async findChat(input: { operationId: string }): Promise<ChatLookup> {
		this.log.push(`findChat:${input.operationId}`);
		await this.#hook("findChat");
		const scripted = this.script.findChat?.shift();
		if (scripted === "unknown") return { status: "unknown" };
		const found = [...this.chats].find(([, chat]) => chat.operationId === input.operationId);
		return found ? { status: "found", chatId: found[0] } : { status: "absent" };
	}

	async createChat(input: { operationId: string; agentId: string; title: string }): Promise<ChatCreation> {
		this.log.push(`createChat:${input.operationId}`);
		await this.#hook("createChat");
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
		await this.#hook("lookupSubmission");
		const scripted = this.script.lookupSubmission?.shift();
		if (scripted === "throw") throw new Error("storage unavailable");
		if (scripted === "unknown") return { status: "unknown" };
		if (scripted === "absent") return { status: "absent" };
		const known = this.submissions.get(input.operationId);
		return known ? { status: "accepted", receipt: known.receipt } : { status: "absent" };
	}

	async submit(input: { idempotencyKey: string; chatId: string; agentId: string; instruction: string; evidence: TimeEvidence }): Promise<SubmitResult> {
		this.log.push(`submit:${input.idempotencyKey}`);
		await this.#hook("submit");
		const scripted = this.script.submit?.shift();
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
		this.maxActive = Math.max(this.maxActive, [...this.runs.values()].filter((status) => status === "queued" || status === "running").length);
		if (scripted === "accept_then_throw") throw new Error("connection reset after it was accepted");
		return { status: "accepted", receipt };
	}

	async lookupRun(input: { operationId: string; receipt: string }): Promise<RunStatus> {
		this.log.push(`lookupRun:${input.operationId}`);
		await this.#hook("lookupRun");
		return this.runs.get(input.receipt) ?? "unknown";
	}

	calls(kind: Method): number {
		return this.log.filter((entry) => entry.startsWith(`${kind}:`)).length;
	}

	/** Ends every run it knows of. */
	finishAll(status: RunStatus = "completed"): void {
		for (const receipt of this.runs.keys()) this.runs.set(receipt, status);
	}
}

/** Deadlines for host calls that pass only when the test says: `expire` is every call's deadline passing at once. */
class FakeTimers {
	readonly #pending = new Set<() => void>();
	sleep = (_ms: number, signal: AbortSignal): Promise<void> =>
		new Promise((resolve) => {
			const fire = () => {
				this.#pending.delete(fire);
				resolve();
			};
			this.#pending.add(fire);
			signal.addEventListener("abort", fire);
		});
	expire(): void {
		for (const fire of [...this.#pending]) fire();
	}
}

type Context = {
	store: TriggerStore;
	coordinator: TriggerCoordinator;
	host: FakeHost;
	timers: FakeTimers;
	clock: { now: number };
	sql: SqlStorage;
	/** A new store and coordinator on the same database and host, as after the Durable Object restarts; `crash` aborts every transaction before it commits. */
	restart: (options?: Partial<TriggerCoordinatorOptions> & { crash?: boolean }) => { store: TriggerStore; coordinator: TriggerCoordinator };
};

async function withCoordinator<T>(work: (context: Context) => Promise<T>, options: Partial<TriggerCoordinatorOptions> = {}): Promise<T> {
	return runInDurableObject(env.Pim.getByName(`coordinator-${crypto.randomUUID()}`), async (_pim: Pim, state) => {
		const clock = { now: START };
		const host = new FakeHost();
		const timers = new FakeTimers();
		const restart = (more: Partial<TriggerCoordinatorOptions> & { crash?: boolean } = {}) => {
			const transaction = <T>(run: () => T): T =>
				state.storage.transactionSync(() => {
					const result = run();
					if (more.crash) throw new Error("crash before commit");
					return result;
				});
			// No `authorize`: as in Pim, nothing that runs on the computer can be enabled.
			const store = new TriggerStore(state.storage.sql, { transaction, now: () => clock.now });
			const coordinator = new TriggerCoordinator(state.storage.sql, { store, host, transaction, now: () => clock.now, sleep: timers.sleep, ...options, ...more });
			return { store, coordinator };
		};
		const { store, coordinator } = restart();
		return work({ store, coordinator, host, timers, clock, sql: state.storage.sql, restart });
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
				create(store, "edit", hourly());
				clock.now = START + HOUR;
				const editGate = deferred();
				host.hooks.submit = [() => editGate.promise];
				const running = coordinator.tick();
				await settle();
				expect(host.calls("submit")).toBe(1);
				// While the host is answering, its instruction changes and it is paused.
				expect(store.update({ id: "edit", expectedRevision: 1, spec: { ...hourly(), instruction: "Write the evening brief." } })).toMatchObject({ ok: true, trigger: { revision: 2 } });
				expect(store.setLifecycle({ id: "edit", to: "paused" })).toMatchObject({ ok: true });
				// Another tick, while the answer is still within its deadline, neither claims it nor asks about it.
				clock.now = START + HOUR + 20_000;
				await coordinator.tick();
				expect(host.calls("submit")).toBe(1);
				expect(host.calls("lookupSubmission")).toBe(0);
				// Nor does the alarm spin on it: the next wake is when its answer is due.
				expect(coordinator.nextWakeAt()).toBe(START + HOUR + 31_000);
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
				host.hooks.submit = [() => goneGate.promise];
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
			host.hooks.preflight = [() => gate.promise];
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

	it("never runs more than maxRunning, across concurrent ticks and a coordinator made again, while a handoff waits on the host", async () => {
		await withCoordinator(
			async ({ store, coordinator, host, clock, restart }) => {
				const once = (at: number) => ({ ...base, source: { kind: "time", schedule: "once", at } });
				create(store, "a", once(START + MINUTE));
				create(store, "b", once(START + MINUTE));
				clock.now = START + MINUTE;
				const gate = deferred();
				host.hooks.preflight = [() => gate.promise];
				// The first tick reserves one handoff and waits on its preflight; the other occurrence can't take a compute slot.
				const first = coordinator.tick();
				await settle();
				expect(host.calls("preflight")).toBe(1);
				const waiting = store.outbox("a")[0]!;
				expect(coordinator.run(waiting.operationId)).toMatchObject({ phase: "preparing", dispatchAttempt: 1, dispatchUntil: START + MINUTE + 5 * MINUTE });
				// Another tick, and a coordinator made again after a restart, see the reservation in the database.
				await coordinator.tick();
				await restart().coordinator.tick();
				expect(host.calls("preflight")).toBe(1);
				gate.resolve();
				expect((await first).handedOn).toEqual([waiting.operationId]);
				// b waits while a's run holds the one slot, then goes.
				await coordinator.tick();
				expect(host.calls("submit")).toBe(1);
				host.finishAll();
				clock.now += 2 * MINUTE;
				await coordinator.tick();
				expect(host.calls("submit")).toBe(2);
				expect(host.maxActive).toBe(1);
			},
			{ maxRunning: 1 },
		);
	});

	it("checks compute again just before submitting, when a slow handoff's reservation ran out and another run took the slot", async () => {
		await withCoordinator(
			async ({ store, coordinator, host, clock }) => {
				create(store, "a", hourly());
				create(store, "b", hourly());
				clock.now = START + HOUR;
				const gate = deferred();
				host.hooks.preflight = [() => gate.promise];
				const slow = coordinator.tick();
				await settle();
				const a = store.outbox("a")[0]!;
				// Past the reservation: b takes the free slot and runs.
				clock.now = START + HOUR + 5 * MINUTE + 1;
				expect((await coordinator.tick()).handedOn).toEqual([store.outbox("b")[0]!.operationId]);
				// a's handoff wakes up and finds no compute free: it submits nothing and waits to try again.
				gate.resolve();
				const report = await slow;
				expect(report.handedOn).toEqual([]);
				expect(report.deferred).toEqual([a.operationId]);
				expect(coordinator.run(a.operationId)).toMatchObject({ phase: "preparing", dispatchUntil: null, lastError: "no compute was free when it was to be submitted" });
				expect(host.calls("submit")).toBe(1);
				expect(host.maxActive).toBe(1);
			},
			{ maxRunning: 1 },
		);
	});

	it("reserves at most maxRunning handoffs that make chats, however many ticks run", async () => {
		await withCoordinator(
			async ({ store, coordinator, host, clock, restart }) => {
				for (const id of ["a", "b", "c"]) create(store, id, hourly({ destination: { type: "new_chat" } }));
				clock.now = START + HOUR;
				const gate = deferred();
				host.hooks.createChat = [() => gate.promise, () => gate.promise, () => gate.promise];
				const first = coordinator.tick();
				const second = restart().coordinator.tick();
				await settle();
				expect(host.calls("createChat")).toBe(2);
				gate.resolve();
				await Promise.all([first, second]);
				await coordinator.tick();
				expect(host.calls("submit")).toBe(2);
				expect(host.maxActive).toBe(2);
				host.finishAll();
				clock.now += MINUTE;
				await coordinator.tick();
				expect(host.calls("submit")).toBe(3);
				expect(host.chats.size).toBe(4);
			},
			{ maxRunning: 2 },
		);
	});

	it("waits a bounded time for the host, so one silent call holds up nothing else, and takes silence as not known", async () => {
		await withCoordinator(
			async ({ store, coordinator, host, timers, clock }) => {
				// Handed on in this order: the silent one first.
				create(store, "a-silent", hourly());
				create(store, "lively", hourly());
				clock.now = START + HOUR;
				host.hooks.preflight = [never];
				const tick = coordinator.tick();
				await settle();
				// The other trigger was handed on while the first's preflight had no answer.
				expect(host.submissions.has(store.outbox("lively")[0]!.operationId)).toBe(true);
				timers.expire();
				const report = await tick;
				const silent = store.outbox("a-silent")[0]!;
				expect(report.deferred).toEqual([silent.operationId]);
				expect(coordinator.run(silent.operationId)?.lastError).toBe("the host's check gave no answer: no answer within 30000 ms");

				// A submission with no answer is not known: it isn't submitted again until the host is asked.
				host.finishAll();
				clock.now = START + 2 * HOUR;
				host.hooks.submit = [never];
				const submitting = coordinator.tick();
				await settle();
				timers.expire();
				await submitting;
				const unanswered = store.outbox("a-silent")[1]!;
				expect(coordinator.run(unanswered.operationId)).toMatchObject({ phase: "submitting", lastError: "no answer within 30000 ms" });
				const submits = host.calls("submit");
				await coordinator.tick();
				expect(host.calls("submit")).toBe(submits);
				clock.now += 15 * MINUTE;
				await coordinator.tick();
				expect(host.calls("lookupSubmission")).toBe(1);

				// A chat with no answer is looked up on the next try, never made blind.
				create(store, "chatty", hourly({ destination: { type: "new_chat" } }));
				clock.now = START + 3 * HOUR;
				host.hooks.createChat = [never];
				const making = coordinator.tick();
				await settle();
				timers.expire();
				await making;
				const chatty = store.outbox("chatty")[0]!;
				expect(coordinator.run(chatty.operationId)).toMatchObject({ phase: "preparing", chatState: "creating", chatId: null });
				clock.now += 15 * MINUTE;
				await coordinator.tick();
				expect(host.log.filter((entry) => entry.endsWith(chatty.operationId)).map((entry) => entry.split(":")[0])).toEqual(["createChat", "findChat", "createChat", "submit"]);
			},
			{ maxRunning: 4 },
		);
	});

	it("asks about each run once at a time, and an answer older than a callback changes nothing", async () => {
		await withCoordinator(async ({ store, coordinator, host, clock }) => {
			create(store, "x", hourly());
			create(store, "y", hourly());
			clock.now = START + HOUR;
			await coordinator.tick();
			const [x, y] = ["x", "y"].map((id) => store.outbox(id)[0]!.operationId) as [string, string];
			const gate = deferred();
			host.hooks.lookupRun = [() => gate.promise, () => gate.promise];
			host.runs.set("receipt-1", "running");
			host.runs.set("receipt-2", "queued");
			clock.now += MINUTE;
			const asking = coordinator.tick();
			await settle();
			// A second tick doesn't ask about the same runs while their questions are out.
			await coordinator.tick();
			expect(host.calls("lookupRun")).toBe(2);
			// The host says x ended, and y is running, before the older answers arrive.
			expect(coordinator.runStatusChanged({ operationId: x, receipt: "receipt-1", status: "completed" })).toEqual({ ok: true });
			expect(coordinator.runStatusChanged({ operationId: y, receipt: "receipt-2", status: "running" })).toEqual({ ok: true });
			gate.resolve();
			await asking;
			expect(coordinator.run(x)?.phase).toBe("completed");
			expect(coordinator.run(y)?.phase).toBe("running");
		});
	});

	it("checks the deadline again after each wait on the host, and keeps what was submitted past it", async () => {
		// One occurrence, admitted at START + 1 min with an hour to be handed on; the host's preflight or chat takes until `until`.
		const handOff = (step: "preflight" | "createChat", until: number) =>
			withCoordinator(
				async ({ store, coordinator, host, clock }) => {
					create(store, "t", { ...base, source: { kind: "time", schedule: "once", at: START + MINUTE }, destination: step === "createChat" ? { type: "new_chat" } : base.destination });
					clock.now = START + MINUTE;
					host.hooks[step] = [
						async () => {
							clock.now = until;
						},
					];
					await coordinator.tick();
					return { run: coordinator.run(store.outbox("t")[0]!.operationId)!, submitted: host.calls("submit"), item: store.outbox("t")[0]! };
				},
				{ deliveryTtlMs: HOUR },
			);
		const deadline = START + MINUTE + HOUR;
		for (const step of ["preflight", "createChat"] as const) {
			const exact = await handOff(step, deadline);
			expect(exact.run.phase, step).toBe("accepted");
			expect(exact.submitted).toBe(1);
			const late = await handOff(step, deadline + 1);
			expect(late.run, step).toMatchObject({ phase: "not_submitted", lastError: "the time to hand it on ran out" });
			expect(late.run.chatState).toBe("pinned");
			expect(late.submitted).toBe(0);
			expect(late.item.status).toBe("failed");
		}

		// Submitted before its deadline with no answer, then found accepted after it: recorded as accepted, not cancelled.
		await withCoordinator(
			async ({ store, coordinator, host, clock }) => {
				create(store, "kept", { ...base, source: { kind: "time", schedule: "once", at: START + MINUTE } });
				clock.now = START + MINUTE;
				host.script.submit = ["accept_then_throw"];
				await coordinator.tick();
				clock.now = START + MINUTE + 2 * HOUR;
				await coordinator.tick();
				expect(coordinator.run(store.outbox("kept")[0]!.operationId)).toMatchObject({ phase: "queued", receipt: "receipt-1" });
				expect(store.outbox("kept")[0]?.status).toBe("done");
			},
			{ deliveryTtlMs: HOUR },
		);
	});

	it("makes no chat and submits nothing once the trigger is paused or deleted during its preflight", async () => {
		await withCoordinator(async ({ store, coordinator, host, clock }) => {
			create(store, "paused", hourly({ destination: { type: "new_chat" } }));
			create(store, "deleted", hourly({ destination: { type: "new_chat" } }));
			create(store, "late", hourly({ destination: { type: "new_chat" } }));
			clock.now = START + HOUR;
			const preflight = deferred();
			const chat = deferred();
			host.hooks.preflight = [() => preflight.promise, () => preflight.promise, () => preflight.promise];
			host.hooks.createChat = [() => chat.promise];
			const tick = coordinator.tick();
			await settle();
			store.setLifecycle({ id: "paused", to: "paused" });
			store.remove({ id: "deleted" });
			// "late" is deleted only after its chat was asked for.
			preflight.resolve();
			await settle();
			expect(host.log.filter((entry) => entry.startsWith("createChat:")).map((entry) => entry.split(":")[2])).toEqual(["late"]);
			store.remove({ id: "late" });
			chat.resolve();
			await tick;
			expect(host.calls("submit")).toBe(0);
			expect(store.outbox("paused")[0]?.status).toBe("pending");
			await coordinator.tick();
			expect(coordinator.run(store.outbox("deleted")[0]!.operationId)).toMatchObject({ phase: "not_submitted", chatId: null });
			// The chat made before the deletion is recorded as made, honestly, and nothing goes to it.
			expect(coordinator.run(store.outbox("late")[0]!.operationId)).toMatchObject({ phase: "not_submitted", chatId: "chat-2", chatState: "pinned" });
			expect(store.outbox("deleted")[0]?.status).toBe("failed");
			expect(host.calls("createChat")).toBe(1);
			expect(host.calls("submit")).toBe(0);
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

	it("keeps a receipt whole or not at all, and says when the host keeps not knowing, without taking that as an answer", async () => {
		await withCoordinator(async ({ store, coordinator, host, clock }) => {
			create(store, "brief", hourly());
			clock.now = START + HOUR;
			const long = `receipt-${"x".repeat(MAX_RECEIPT_LENGTH)}`;
			host.submit = async () => ({ status: "accepted", receipt: long });
			await coordinator.tick();
			const [item] = store.outbox("brief");
			const operationId = item!.operationId;
			// Accepted with a receipt too long to keep: never cut short, so the submission stays unknown and holds the slot.
			expect(coordinator.run(operationId)).toMatchObject({ phase: "submitting", receipt: null, lastError: expect.stringContaining(`longer than ${MAX_RECEIPT_LENGTH} characters`) });
			let answer: SubmissionLookup = { status: "accepted", receipt: long };
			host.lookupSubmission = async () => answer;
			for (let asked = 1; asked <= UNKNOWN_ATTENTION; asked++) {
				clock.now += 15 * MINUTE;
				if (asked === 2) answer = { status: "unknown" };
				await coordinator.tick();
				expect(coordinator.run(operationId)).toMatchObject({ phase: "submitting", receipt: null, unknownAnswers: asked });
				if (asked < UNKNOWN_ATTENTION) expect(store.get("brief")?.healthDetail).toBeNull();
			}
			// After answers of "not known" in a row, the trigger says what it waits on; the next firing waits behind it.
			expect(store.get("brief")).toMatchObject({ health: "unknown", healthDetail: expect.stringContaining(`after ${UNKNOWN_ATTENTION} questions about operation ${operationId}`) });
			clock.now = START + 2 * HOUR + MINUTE;
			await coordinator.tick();
			expect(coordinator.runs("brief")).toHaveLength(1);
			// A known answer settles it, and the trigger is healthy again.
			answer = { status: "accepted", receipt: "receipt-ok" };
			host.runs.set("receipt-ok", "running");
			clock.now += 15 * MINUTE;
			await coordinator.tick();
			expect(coordinator.run(operationId)).toMatchObject({ phase: "running", receipt: "receipt-ok", unknownAnswers: 0 });
			expect(store.get("brief")).toMatchObject({ health: "healthy", healthDetail: null });
		});
	});

	it("adds the column runs now keep to a table made by the coordinator before it, keeping every run, receipt and claim as it was", async () => {
		await runInDurableObject(env.Pim.getByName(`upgrade-${crypto.randomUUID()}`), async (_pim: Pim, state) => {
			const sql = state.storage.sql;
			// pim_trigger_runs exactly as bd9ee3b made it.
			sql.exec(`
CREATE TABLE IF NOT EXISTS pim_trigger_runs (
	operation_id TEXT PRIMARY KEY,
	trigger_id TEXT NOT NULL,
	outbox_id TEXT NOT NULL UNIQUE,
	occurrence_id TEXT NOT NULL,
	revision INTEGER NOT NULL,
	agent_id TEXT NOT NULL,
	chat_id TEXT,
	chat_state TEXT NOT NULL,
	phase TEXT NOT NULL,
	receipt TEXT,
	scheduled_for INTEGER NOT NULL,
	admitted_at INTEGER NOT NULL,
	deliver_by INTEGER NOT NULL,
	dispatch_attempt INTEGER,
	dispatch_until INTEGER,
	first_dispatch_at INTEGER,
	last_dispatch_at INTEGER,
	submitted_at INTEGER,
	accepted_at INTEGER,
	ended_at INTEGER,
	check_at INTEGER,
	check_token TEXT,
	deferrals INTEGER NOT NULL,
	last_error TEXT,
	created_at INTEGER NOT NULL,
	updated_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS pim_trigger_runs_by_trigger ON pim_trigger_runs (trigger_id, phase);
CREATE INDEX IF NOT EXISTS pim_trigger_runs_by_check ON pim_trigger_runs (phase, check_at);
CREATE TRIGGER IF NOT EXISTS pim_trigger_runs_pinned BEFORE UPDATE OF operation_id, trigger_id, outbox_id, occurrence_id, revision, agent_id, scheduled_for, admitted_at, deliver_by ON pim_trigger_runs
BEGIN SELECT RAISE(ABORT, 'a run keeps its operation, revision, agent and deadlines'); END;
CREATE TRIGGER IF NOT EXISTS pim_trigger_runs_chat_pinned BEFORE UPDATE OF chat_id ON pim_trigger_runs WHEN OLD.chat_id IS NOT NULL AND NEW.chat_id IS NOT OLD.chat_id
BEGIN SELECT RAISE(ABORT, 'a run keeps the chat it was pinned to'); END;
`);
			const insert = (operationId: string, phase: string, receipt: string | null, attempt: number) =>
				sql.exec(
					`INSERT INTO pim_trigger_runs (operation_id, trigger_id, outbox_id, occurrence_id, revision, agent_id, chat_id, chat_state, phase, receipt, scheduled_for, admitted_at, deliver_by, dispatch_attempt, dispatch_until, first_dispatch_at, last_dispatch_at, submitted_at, accepted_at, check_at, deferrals, last_error, created_at, updated_at)
					VALUES (?, 'brief', ?, ?, 2, 'agent-1', 'chat-1', 'pinned', ?, ?, ?, ?, ?, ?, NULL, ?, ?, ?, ?, ?, 1, 'connection reset', ?, ?)`,
					operationId,
					`outbox-${operationId}`,
					`occurrence-${operationId}`,
					phase,
					receipt,
					START,
					START,
					START + DAY,
					attempt,
					START,
					START,
					START,
					receipt === null ? null : START,
					START,
					START,
					START,
				);
			insert("op-submitting", "submitting", null, 3);
			insert("op-accepted", "accepted", "receipt-7", 2);
			const before = sql.exec("SELECT * FROM pim_trigger_runs ORDER BY operation_id").toArray();
			const clock = { now: START };
			const host = new FakeHost();
			host.script.lookupSubmission = ["unknown"];
			host.runs.set("receipt-7", "running");
			const transaction = <T>(run: () => T): T => state.storage.transactionSync(run);
			const store = new TriggerStore(sql, { transaction, now: () => clock.now });
			const make = () => new TriggerCoordinator(sql, { store, host, transaction, now: () => clock.now });
			const coordinator = make();
			// Made again, it adds nothing more.
			make();
			const columns = sql
				.exec("PRAGMA table_info(pim_trigger_runs)")
				.toArray()
				.map((row) => String(row.name));
			expect(columns.filter((name) => name === "unknown_answers")).toHaveLength(1);
			expect(sql.exec("SELECT * FROM pim_trigger_runs ORDER BY operation_id").toArray()).toEqual(before.map((row) => ({ ...row, unknown_answers: 0 })));
			expect(coordinator.run("op-submitting")).toMatchObject({ phase: "submitting", dispatchAttempt: 3, receipt: null, revision: 2, unknownAnswers: 0 });
			// The pinned columns are still pinned, and the runs go on: an unknown answer is counted, and a known one recorded.
			expect(() => sql.exec("UPDATE pim_trigger_runs SET revision = 3 WHERE operation_id = 'op-accepted'")).toThrow(/keeps its operation, revision/);
			await coordinator.tick();
			expect(coordinator.run("op-submitting")).toMatchObject({ phase: "submitting", unknownAnswers: 1, lastError: "connection reset" });
			expect(coordinator.run("op-accepted")).toMatchObject({ phase: "running", receipt: "receipt-7", dispatchAttempt: 2, unknownAnswers: 0 });
		});
	});

	it("is wired only into Pim, behind its gate (test/triggers-host.test.ts), into connector watches, which are triggers, and into what a space holds; the preview and the web app don't use it", () => {
		const files = import.meta.glob(["../src/**/*.ts", "../preview/**/*.ts", "../pim.config.ts", "../test/worker.ts", "../web/src/**/*.{ts,tsx}"], { query: "?raw", import: "default", eager: true });
		expect(Object.keys(files)).toContain("../src/pim.ts");
		// A file uses triggers when it imports a module of src/triggers/ (statically, for its effects, dynamically or to re-export it) or names their classes or tables; a URL such as the web app's `/triggers/<id>` is not a use.
		const root = new URL("file:///repo/test/");
		const importsTriggers = (path: string, source: string) =>
			[...source.matchAll(/\b(?:from|import)\s*\(?\s*["'`]([^"'`]+)["'`]/g)].some(([, specifier]) => specifier!.startsWith(".") && new URL(specifier!, new URL(path, root)).pathname.startsWith("/repo/src/triggers/"));
		const users = Object.entries(files)
			.filter(([path]) => !path.startsWith("../src/triggers/"))
			.filter(([path, source]) => importsTriggers(path, source) || /TriggerCoordinator|TriggerStore|pim_trigger/.test(source))
			.map(([path]) => path);
		expect(users).toEqual(["../src/extensions/app-events.ts", "../src/pim.ts", "../src/store.ts"]);
	});
});
