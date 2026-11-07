import { env, runInDurableObject } from "cloudflare:test";
import { beforeAll, describe, expect, it, vi } from "vitest";
import type { Pim } from "../src/pim";
import {
	type ChatCreation,
	type ChatLookup,
	type HandedSource,
	type HostPreflight,
	type RunStatus,
	type SubmissionLookup,
	type SubmitResult,
	type TriggerAgentHost,
	TriggerCoordinator,
	type TriggerCoordinatorOptions,
	type TriggerEvidence,
} from "../src/triggers/coordinator";
import { triggerHistory } from "../src/triggers/engine";
import { firingText } from "../src/triggers/host";
import type { TriggerDestination } from "../src/triggers/spec";
import { TriggerStore, type TriggerStoreOptions } from "../src/triggers/store";
import { api, messagesOf, OWNER, pendingApproval, post, settled, toolUse } from "./helpers";
import { faux, triggerClock } from "./worker";

// Connector events handed to their agent by the coordinator, through the outbox and the steps time firings take. Most tests build
// the store and a coordinator made with `connectorEvents` on a Durable Object's database of their own, with a fake clock and host;
// the last goes through Pim's own host and runs. Events are admitted with `TriggerStore.admit`, as the ingress adapter admits them.

const START = 1_800_000_000_000;
const SECOND = 1_000;
const MINUTE = 60 * SECOND;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;
const EVENT = "flight.price_changed";
/** What an event carried, which must never reach a run, a record or a log. */
const SECRET = "card-4111-secret-fare";
const EDITED = "its trigger was edited after its event was taken in, so it is never handed on";

type Deferred = { promise: Promise<void>; resolve: () => void };
function deferred(): Deferred {
	let resolve!: () => void;
	const promise = new Promise<void>((done) => {
		resolve = done;
	});
	return { promise, resolve };
}
const settle = () => new Promise((resolve) => setTimeout(resolve, 10));
const iso = (ms: number) => new Date(ms).toISOString();

type Method = "preflight" | "findChat" | "createChat" | "lookupSubmission" | "submit" | "lookupRun";

/** A host with chats and runs of its own, which keeps its own record by idempotency key as `submitTo` does. */
class FakeHost implements TriggerAgentHost<TriggerEvidence> {
	agents = new Set(["agent-1"]);
	chats = new Map<string, { agent: string; operationId: string | null }>([["chat-1", { agent: "agent-1", operationId: null }]]);
	submissions = new Map<string, { receipt: string; chatId: string; instruction: string; evidence: TriggerEvidence }>();
	runs = new Map<string, RunStatus>();
	reserved = 0;
	log: string[] = [];
	sources: HandedSource[] = [];
	hooks: Partial<Record<Method, (() => Promise<void>)[]>> = {};
	script: { createChat?: "throw_after_create"[]; submit?: "accept_then_throw"[] } = {};
	#receipts = 0;

	async #hook(method: Method): Promise<void> {
		await this.hooks[method]?.shift()?.();
	}

	async preflight(input: { triggerId: string; operationId: string; agentId: string; destination: TriggerDestination; sourceKind: HandedSource }): Promise<HostPreflight> {
		this.log.push(`preflight:${input.operationId}`);
		this.sources.push(input.sourceKind);
		await this.#hook("preflight");
		if (!this.agents.has(input.agentId)) return { ok: false, reason: "the agent was deleted", retryable: false };
		if (input.destination.type === "existing_chat" && this.chats.get(input.destination.chatId)?.agent !== input.agentId) return { ok: false, reason: "the chat is gone", retryable: false };
		return { ok: true };
	}

	async findChat(input: { operationId: string }): Promise<ChatLookup> {
		this.log.push(`findChat:${input.operationId}`);
		await this.#hook("findChat");
		const found = [...this.chats].find(([, chat]) => chat.operationId === input.operationId);
		return found ? { status: "found", chatId: found[0] } : { status: "absent" };
	}

	async createChat(input: { operationId: string; agentId: string; title: string }): Promise<ChatCreation> {
		this.log.push(`createChat:${input.operationId}`);
		await this.#hook("createChat");
		const known = [...this.chats].find(([, chat]) => chat.operationId === input.operationId);
		const chatId = known?.[0] ?? `chat-${this.chats.size + 1}`;
		this.chats.set(chatId, { agent: input.agentId, operationId: input.operationId });
		if (this.script.createChat?.shift() === "throw_after_create") throw new Error("connection reset after the chat was made");
		return { status: "created", chatId };
	}

	async lookupSubmission(input: { operationId: string }): Promise<SubmissionLookup> {
		this.log.push(`lookupSubmission:${input.operationId}`);
		await this.#hook("lookupSubmission");
		const known = this.submissions.get(input.operationId);
		return known ? { status: "accepted", receipt: known.receipt } : { status: "absent" };
	}

	async submit(input: { idempotencyKey: string; chatId: string; agentId: string; instruction: string; evidence: TriggerEvidence }): Promise<SubmitResult> {
		this.log.push(`submit:${input.idempotencyKey}`);
		await this.#hook("submit");
		if (this.chats.get(input.chatId)?.agent !== input.agentId) return { status: "failed", reason: "the chat is gone" };
		const known = this.submissions.get(input.idempotencyKey);
		if (known) return { status: "duplicate", receipt: known.receipt };
		this.reserved++;
		const receipt = `receipt-${++this.#receipts}`;
		this.submissions.set(input.idempotencyKey, { receipt, chatId: input.chatId, instruction: input.instruction, evidence: input.evidence });
		this.runs.set(receipt, "queued");
		if (this.script.submit?.shift() === "accept_then_throw") throw new Error("connection reset after it was accepted");
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

	finishAll(): void {
		for (const receipt of this.runs.keys()) this.runs.set(receipt, "completed");
	}
}

/** Deadlines for host calls that pass only when the test says. */
function fakeSleep(_ms: number, signal: AbortSignal): Promise<void> {
	return new Promise((resolve) => signal.addEventListener("abort", () => resolve()));
}

type Context = {
	store: TriggerStore;
	coordinator: TriggerCoordinator;
	host: FakeHost;
	clock: { now: number };
	sql: SqlStorage;
	/**
	 * A new store and coordinator on the same database and host, as after the
	 * Durable Object restarts. With `cutAfterClaim`, the next transaction that
	 * claims an outbox item throws before it commits, as a crash there would.
	 */
	restart: (options?: Partial<TriggerCoordinatorOptions> & { storeOptions?: Partial<TriggerStoreOptions>; cutAfterClaim?: boolean }) => { store: TriggerStore; coordinator: TriggerCoordinator };
};

async function withDispatch(work: (context: Context) => Promise<void>, options: Partial<TriggerCoordinatorOptions> = {}): Promise<void> {
	await runInDurableObject(env.Pim.getByName(`events-${crypto.randomUUID()}`), async (_pim: Pim, state) => {
		const clock = { now: START };
		const host = new FakeHost();
		const restart: Context["restart"] = (more = {}) => {
			const cut = { armed: false };
			let depth = 0;
			const transaction = <T>(run: () => T): T =>
				state.storage.transactionSync(() => {
					depth++;
					try {
						const result = run();
						if (depth === 1 && cut.armed) {
							cut.armed = false;
							throw new Error("crash before commit");
						}
						return result;
					} finally {
						depth--;
					}
				});
			const store = new TriggerStore(state.storage.sql, { transaction, now: () => clock.now, ...more.storeOptions });
			if (more.cutAfterClaim) {
				const claim = store.claim.bind(store);
				store.claim = (input) => {
					const delivery = claim(input);
					if (delivery) cut.armed = true;
					return delivery;
				};
			}
			const { storeOptions: _storeOptions, cutAfterClaim: _cut, ...coordinatorOptions } = more;
			const coordinator = new TriggerCoordinator(state.storage.sql, { store, host, transaction, now: () => clock.now, sleep: fakeSleep, connectorEvents: true, ...options, ...coordinatorOptions });
			return { store, coordinator };
		};
		const { store, coordinator } = restart();
		await work({ store, coordinator, host, clock, sql: state.storage.sql, restart });
	});
}

const base = { version: 1, owningAgentId: "agent-1", originChatId: "chat-1", label: "Fares", instruction: "Tell me about cheap fares.", destination: { type: "existing_chat", chatId: "chat-1" } };
const eventSpec = (over: Record<string, unknown> = {}) => ({ ...base, source: { kind: "connector_event", connectorId: "travel", event: EVENT, arguments: { route: "JFK-LIS" } }, ...over });

function create(store: TriggerStore, id: string, spec: unknown) {
	const result = store.create({ id, spec, lifecycle: "enabled" });
	if (!result.ok) throw new Error(`not created: ${result.reason}`);
	return result.trigger;
}

/** Admits an event as the ingress adapter does, at its own time, carrying the secret. */
function admit(store: TriggerStore, id: string, eventId: string, payload: Record<string, unknown> = { price: 481.37, note: SECRET }) {
	return store.admit({ id, generation: store.get(id)!.generation, eventId, observedAt: START - MINUTE, payload });
}

describe("connector events handed on by the coordinator", () => {
	it("hands an admitted event to its agent once, through the outbox, told what it was and never what it carried", async () => {
		const logged = (["log", "info", "warn", "error", "debug"] as const).map((method) => vi.spyOn(console, method));
		await withDispatch(async ({ store, coordinator, host, clock, sql }) => {
			create(store, "fares", eventSpec({ condition: { when: { op: "compare", path: ["price"], cmp: "lt", value: 500 } } }));
			expect(admit(store, "fares", "evt_1")).toMatchObject({ status: "accepted", occurrence: { status: "pending" } });
			const item = store.outbox("fares")[0]!;
			expect(item.operationId).toBe(`trigger:fares:${item.occurrenceId}`);

			const report = await coordinator.tick();
			expect(report.handedOn).toEqual([item.operationId]);
			expect(host.sources).toEqual(["connector_event"]);
			const submission = host.submissions.get(item.operationId)!;
			expect(submission).toEqual({
				receipt: "receipt-1",
				chatId: "chat-1",
				instruction: "Tell me about cheap fares.",
				evidence: {
					kind: "connector_event",
					triggerId: "fares",
					revision: 1,
					label: "Fares",
					connectorId: "travel",
					event: EVENT,
					eventId: "evt_1",
					observedAt: START - MINUTE,
					admittedAt: START,
					reason: "condition",
					fields: [{ path: ["price"], present: true }],
				},
			});
			expect(coordinator.run(item.operationId)).toMatchObject({ phase: "accepted", revision: 1, agentId: "agent-1", chatId: "chat-1", scheduledFor: START - MINUTE, admittedAt: START, deliverBy: START + DAY });
			expect(store.outbox("fares")[0]).toMatchObject({ status: "done", attempts: 1 });
			expect(store.occurrences("fares")[0]?.status).toBe("delivered");

			// However often it ticks after, nothing is handed on again; the slot frees when the host says the run ended.
			await coordinator.tick();
			host.finishAll();
			clock.now += MINUTE;
			await coordinator.tick();
			await coordinator.tick();
			expect(host.calls("submit")).toBe(1);
			expect(host.reserved).toBe(1);
			expect(coordinator.run(item.operationId)?.phase).toBe("completed");

			// What the agent reads: the event by name, id and time.
			const text = firingText(submission.instruction, submission.evidence);
			expect(text).toBe(`[Trigger "Fares" fares] Tell me about cheap fares.\n\n(On ${EVENT} from travel at ${iso(START - MINUTE)}, event evt_1. What the event carried isn't kept or passed on.)`);
			// Nothing it carried is in the run, the export's record of triggers, the host's calls or a log.
			const everything = JSON.stringify({ history: triggerHistory(sql), runs: coordinator.runs("fares"), log: host.log, submissions: [...host.submissions.values()], text });
			expect(everything).toContain("evt_1");
			for (const carried of [SECRET, "481.37"]) expect(everything).not.toContain(carried);
		});
		const lines = logged.flatMap((spy) => spy.mock.calls.flat().map((value) => (typeof value === "string" ? value : JSON.stringify(value) ?? String(value))));
		expect(lines.join("\n")).not.toContain(SECRET);
	});

	it("submits each event once across duplicates, concurrent ticks and a coordinator made again, one run per trigger and in order", async () => {
		await withDispatch(async ({ store, coordinator, host, clock, restart }) => {
			create(store, "fares", eventSpec());
			expect(admit(store, "fares", "evt_1")).toMatchObject({ status: "accepted" });
			expect(admit(store, "fares", "evt_1")).toEqual({ status: "duplicate" });
			const gate = deferred();
			host.hooks.submit = [() => gate.promise];
			const again = restart().coordinator;
			const ticks = [coordinator.tick(), coordinator.tick(), again.tick()];
			await settle();
			expect(host.calls("preflight")).toBe(1);
			expect(host.calls("submit")).toBe(1);
			gate.resolve();
			await Promise.all(ticks);
			expect(host.submissions.size).toBe(1);

			// Later events wait for the trigger's run to end, then go one at a time, oldest first.
			expect(admit(store, "fares", "evt_2")).toMatchObject({ status: "accepted" });
			expect(admit(store, "fares", "evt_3")).toMatchObject({ status: "accepted" });
			await Promise.all([coordinator.tick(), again.tick()]);
			expect(host.calls("submit")).toBe(1);
			for (let round = 0; round < 3; round++) {
				host.finishAll();
				clock.now += MINUTE;
				await Promise.all([coordinator.tick(), again.tick()]);
			}
			expect([...host.submissions.values()].map((submission) => (submission.evidence.kind === "connector_event" ? submission.evidence.eventId : null))).toEqual(["evt_1", "evt_2", "evt_3"]);
			expect(host.calls("submit")).toBe(3);
			expect(host.reserved).toBe(3);
			expect(store.outbox("fares").map((item) => [item.status, item.attempts])).toEqual([
				["done", 1],
				["done", 1],
				["done", 1],
			]);
		});
	});

	it("neither loses nor repeats an event cut short in its claim, while its preflight is out, or while its chat is made", async () => {
		await withDispatch(async ({ store, host, clock, restart }) => {
			create(store, "fares", eventSpec());
			admit(store, "fares", "evt_1");
			const item = store.outbox("fares")[0]!;

			// Cut inside the claim's transaction: nothing of it was written.
			await expect(restart({ cutAfterClaim: true }).coordinator.tick()).rejects.toThrow("crash before commit");
			expect(store.outbox("fares")[0]).toMatchObject({ status: "pending", attempts: 0 });
			expect(restart().coordinator.run(item.operationId)).toBeUndefined();
			expect(host.log).toEqual([]);

			// Cut while its preflight is out: the reservation holds until its lease runs out, then the next attempt hands it on once,
			// and the first attempt, answering late, does nothing more.
			const late = deferred();
			host.hooks.preflight = [() => late.promise];
			const abandoned = restart().coordinator.tick();
			await settle();
			const { coordinator } = restart();
			expect(coordinator.run(item.operationId)).toMatchObject({ phase: "preparing", dispatchAttempt: 1, dispatchUntil: START + 5 * MINUTE });
			await coordinator.tick();
			expect(host.calls("preflight")).toBe(1);
			clock.now = START + 5 * MINUTE + 1;
			expect((await coordinator.tick()).handedOn).toEqual([item.operationId]);
			late.resolve();
			await abandoned;
			expect(host.calls("submit")).toBe(1);
			expect(coordinator.run(item.operationId)).toMatchObject({ phase: "accepted", dispatchAttempt: 2 });
			expect(store.outbox("fares")[0]).toMatchObject({ status: "done", attempts: 2 });

			// A new chat each time: made, and the answer lost. The next attempt finds it rather than making another.
			create(store, "fresh", eventSpec({ destination: { type: "new_chat" } }));
			admit(store, "fresh", "evt_9");
			const fresh = store.outbox("fresh")[0]!;
			host.script.createChat = ["throw_after_create"];
			await restart().coordinator.tick();
			expect(restart().coordinator.run(fresh.operationId)).toMatchObject({ phase: "preparing", chatState: "creating", chatId: null, deferrals: 1 });
			clock.now += 15 * MINUTE;
			await restart().coordinator.tick();
			const made = [...host.chats].filter(([, chat]) => chat.operationId === fresh.operationId).map(([id]) => id);
			expect(made).toHaveLength(1);
			expect(host.calls("createChat")).toBe(1);
			expect(restart().coordinator.run(fresh.operationId)).toMatchObject({ phase: "accepted", chatState: "pinned", chatId: made[0] });
			expect(host.submissions.get(fresh.operationId)?.chatId).toBe(made[0]);
		});
	});

	it("looks up a submission whose answer was lost, after a restart, and never submits it again", async () => {
		await withDispatch(async ({ store, coordinator, host, clock, restart }) => {
			create(store, "fares", eventSpec());
			admit(store, "fares", "evt_1");
			const item = store.outbox("fares")[0]!;
			host.script.submit = ["accept_then_throw"];
			await coordinator.tick();
			expect(coordinator.run(item.operationId)).toMatchObject({ phase: "submitting", lastError: "connection reset after it was accepted" });
			// Its slot stays taken, and nothing is claimed or submitted while it isn't known.
			admit(store, "fares", "evt_2");
			const again = restart().coordinator;
			await again.tick();
			expect(host.calls("submit")).toBe(1);
			clock.now += 15 * MINUTE;
			const report = await again.tick();
			expect(report.reconciled).toEqual([item.operationId]);
			// Accepted, and asked about in the same tick.
			expect(again.run(item.operationId)).toMatchObject({ phase: "queued", receipt: "receipt-1" });
			expect(store.outbox("fares")[0]).toMatchObject({ status: "done" });
			// Made again once more, it follows the run it knows and hands the next event on when that run ends.
			host.finishAll();
			clock.now += MINUTE;
			await restart().coordinator.tick();
			expect(host.calls("submit")).toBe(2);
			expect(host.reserved).toBe(2);
			expect(host.submissions.has(item.operationId)).toBe(true);
		});
	});

	it("settles an event whose outcome the store lost track of by asking the host, only when it hands events on", async () => {
		await withDispatch(async ({ store, host, clock, restart }) => {
			create(store, "taken", eventSpec());
			create(store, "never", eventSpec());
			admit(store, "taken", "evt_1");
			admit(store, "never", "evt_1");
			const taken = store.outbox("taken")[0]!;
			const never = store.outbox("never")[0]!;
			// An earlier deliverer's leases ran out at every attempt; the first may have been submitted.
			host.submissions.set(taken.operationId, { receipt: "receipt-old", chatId: "chat-1", instruction: "Tell me about cheap fares.", evidence: {} as TriggerEvidence });
			host.runs.set("receipt-old", "running");
			for (let attempt = 0; attempt < 5; attempt++) {
				for (const id of ["taken", "never"]) expect(store.claim({ leaseMs: SECOND, triggerId: id })).toBeDefined();
				clock.now += SECOND;
			}
			for (const id of ["taken", "never"]) expect(store.claim({ leaseMs: SECOND, triggerId: id })).toBeUndefined();
			expect([store.outbox("taken")[0]?.status, store.outbox("never")[0]?.status]).toEqual(["outcome_unknown", "outcome_unknown"]);

			// Not handing events on, it leaves them as they are and asks nothing.
			const off = restart({ connectorEvents: false }).coordinator;
			await off.tick();
			expect(host.log).toEqual([]);
			expect(off.runs("taken")).toEqual([]);

			const on = restart().coordinator;
			await on.tick();
			expect(on.run(taken.operationId)).toMatchObject({ phase: "running", receipt: "receipt-old", chatState: "unknown" });
			expect(on.run(never.operationId)).toMatchObject({ phase: "not_submitted" });
			expect(store.outbox("taken")[0]?.status).toBe("done");
			expect(store.occurrences("taken")[0]?.status).toBe("delivered");
			expect(store.outbox("never")[0]?.status).toBe("failed");
			expect(host.calls("submit")).toBe(0);
		});
	});

	it("hands nothing on for a trigger paused, deleted or edited before its submission, and keeps what was submitted before an edit", async () => {
		await withDispatch(async ({ store, coordinator, host, clock }) => {
			for (const id of ["paused", "edited", "deleted"]) {
				create(store, id, eventSpec());
				admit(store, id, "evt_1");
			}
			const gate = deferred();
			host.hooks.preflight = [() => gate.promise, () => gate.promise, () => gate.promise];
			const running = coordinator.tick();
			await settle();
			expect(host.calls("preflight")).toBe(3);
			expect(store.setLifecycle({ id: "paused", to: "paused" })).toMatchObject({ ok: true });
			expect(store.update({ id: "edited", expectedRevision: 1, spec: eventSpec({ instruction: "Book the cheapest fare." }) })).toMatchObject({ ok: true, trigger: { revision: 2, generation: 1 } });
			expect(store.remove({ id: "deleted" })).toEqual({ ok: true });
			gate.resolve();
			await running;
			expect(host.calls("submit")).toBe(0);
			expect(host.calls("createChat")).toBe(0);
			const runOf = (id: string) => coordinator.run(store.outbox(id)[0]!.operationId);
			expect(runOf("paused")).toMatchObject({ phase: "preparing", dispatchUntil: null, lastError: "paused before it was handed on" });
			expect(store.outbox("paused")[0]).toMatchObject({ status: "pending" });
			expect(runOf("edited")).toMatchObject({ phase: "not_submitted", lastError: EDITED });
			expect(store.outbox("edited")[0]).toMatchObject({ status: "failed" });
			expect(store.occurrences("edited")[0]?.status).toBe("failed");
			// The deletion made its claim's outcome unknown, so the late answer does nothing; the next tick closes it.
			expect(runOf("deleted")).toMatchObject({ phase: "preparing" });
			expect(store.outbox("deleted")[0]).toMatchObject({ status: "outcome_unknown" });

			// Enabled again as it was, the paused one's event is handed on; the edited one's next event goes with its new revision.
			expect(store.setLifecycle({ id: "paused", to: "enabled", expectedRevision: 1 })).toMatchObject({ ok: true });
			admit(store, "edited", "evt_2");
			const report = await coordinator.tick();
			expect(report.handedOn.sort()).toEqual([store.outbox("edited")[1]!.operationId, store.outbox("paused")[0]!.operationId].sort());
			expect(host.submissions.get(store.outbox("edited")[1]!.operationId)).toMatchObject({ instruction: "Book the cheapest fare.", evidence: { revision: 2, eventId: "evt_2" } });
			expect(host.calls("submit")).toBe(2);
			expect(runOf("deleted")).toMatchObject({ phase: "not_submitted", lastError: "never submitted; its occurrence was outcome_unknown" });
			expect(store.outbox("deleted")[0]).toMatchObject({ status: "failed" });

			// Edited while it waited, paused or not, and enabled again: never handed on, and the host isn't asked.
			create(store, "waited", eventSpec());
			create(store, "moved", eventSpec());
			admit(store, "waited", "evt_1");
			admit(store, "moved", "evt_1");
			store.setLifecycle({ id: "waited", to: "paused" });
			store.update({ id: "waited", expectedRevision: 1, spec: eventSpec({ label: "Cheap fares" }) });
			store.setLifecycle({ id: "waited", to: "enabled", expectedRevision: 2 });
			// A new source starts a new generation, and the event taken in under the old one is stale.
			store.update({ id: "moved", expectedRevision: 1, spec: eventSpec({ source: { kind: "connector_event", connectorId: "travel", event: "flight.cancelled" } }) });
			const preflights = host.calls("preflight");
			const closed = await coordinator.tick();
			expect(closed.notSubmitted.sort()).toEqual([store.outbox("moved")[0]!.operationId, store.outbox("waited")[0]!.operationId].sort());
			expect(host.calls("preflight")).toBe(preflights);
			for (const id of ["waited", "moved"]) expect(coordinator.run(store.outbox(id)[0]!.operationId)).toMatchObject({ phase: "not_submitted", lastError: EDITED, revision: 1 });

			// Edited once its submission began: what happened is kept, with the revision it was made under.
			create(store, "late", eventSpec());
			admit(store, "late", "evt_1");
			const answer = deferred();
			host.hooks.submit = [() => answer.promise];
			clock.now += MINUTE;
			const submitting = coordinator.tick();
			await settle();
			expect(host.calls("submit")).toBe(3);
			store.update({ id: "late", expectedRevision: 1, spec: eventSpec({ instruction: "Something else." }) });
			answer.resolve();
			await submitting;
			const late = store.outbox("late")[0]!;
			expect(late.status).toBe("done");
			expect(coordinator.run(late.operationId)).toMatchObject({ phase: "accepted", revision: 1 });
			expect(host.submissions.get(late.operationId)).toMatchObject({ instruction: "Tell me about cheap fares.", evidence: { revision: 1 } });
		});
	});

	it("hands on no event when it isn't made to, and no other source's event when it is, and doesn't wake for them", async () => {
		await withDispatch(async ({ store, host, clock, restart }) => {
			const off = restart({ connectorEvents: false }).coordinator;
			create(store, "fares", eventSpec());
			admit(store, "fares", "evt_1");
			create(store, "brief", { ...base, label: "Brief", source: { kind: "time", schedule: "once", at: START + MINUTE } });
			clock.now = START + MINUTE;
			const report = await off.tick();
			expect(report.handedOn).toHaveLength(1);
			expect(host.log.every((entry) => !entry.includes(store.outbox("fares")[0]!.operationId))).toBe(true);
			expect(host.sources).toEqual(["time"]);
			expect(store.outbox("fares")[0]).toMatchObject({ status: "pending", attempts: 0 });
			host.finishAll();
			clock.now += MINUTE;
			await off.tick();
			expect(off.nextWakeAt()).toBeNull();

			// A process's exit is an event too, of a source on the computer: it is never handed on, and nothing waits on it.
			const { store: granted, coordinator: on } = restart({ storeOptions: { authorize: () => ({ ok: true }) } });
			const process = granted.create({ id: "exit", spec: { ...base, source: { kind: "process", handle: "proc-1", expiresAt: clock.now + HOUR }, authorizationRef: "approval-1" }, lifecycle: "enabled" });
			expect(process).toMatchObject({ ok: true });
			expect(granted.admit({ id: "exit", generation: 1, eventId: "exit", observedAt: clock.now, payload: { exitCode: 1, signal: null } })).toMatchObject({ status: "accepted", occurrence: { status: "pending" } });
			const wake = on.nextWakeAt();
			const handed = await on.tick();
			expect(handed.handedOn).toEqual([store.outbox("fares")[0]!.operationId]);
			expect(granted.outbox("exit")[0]).toMatchObject({ status: "pending", attempts: 0 });
			expect(wake).toBe(clock.now);
			host.finishAll();
			clock.now += MINUTE;
			await on.tick();
			expect(on.nextWakeAt()).toBeNull();
		});
	});

	it("hands on a bounded batch per tick, within the space's compute, and wakes again for the rest", async () => {
		await withDispatch(
			async ({ store, coordinator, host, clock }) => {
				const ids = ["a", "b", "c", "d", "e", "f"];
				for (const id of ids) {
					create(store, id, eventSpec());
					admit(store, id, "evt_1");
				}
				const first = await coordinator.tick();
				expect(first.handedOn).toHaveLength(2);
				expect(first.nextWakeAt).toBe(START);
				expect((await coordinator.tick()).handedOn).toHaveLength(2);
				// Four runs hold compute: nothing more until one ends, and the next wake is when to ask about them.
				const full = await coordinator.tick();
				expect(full.handedOn).toEqual([]);
				expect(full.nextWakeAt).toBe(START + MINUTE);
				expect(host.calls("preflight")).toBe(4);
				host.finishAll();
				clock.now += MINUTE;
				expect((await coordinator.tick()).handedOn).toHaveLength(2);
				expect(ids.map((id) => store.outbox(id)[0]!.status).sort()).toEqual(["done", "done", "done", "done", "done", "done"]);
			},
			{ batch: { handoffs: 2 }, maxRunning: 4 },
		);
	});
});

const sqlOf = (pim: Pim) => (pim as unknown as { ctx: DurableObjectState }).ctx.storage.sql;

describe("connector events in Pim, handed on by a coordinator made with them", () => {
	const inSpace = <T>(work: (pim: Pim) => T | Promise<T>) => runInDurableObject(env.Pim.getByName(OWNER), work);
	/** One tick of a coordinator made with connector events over the engine's own store and Pim's host, on the triggers' clock. */
	const dispatch = () =>
		inSpace((pim) => {
			const engine = pim.triggerEngine()!;
			const transaction = <T>(work: () => T): T => (pim as unknown as { ctx: DurableObjectState }).ctx.storage.transactionSync(work);
			return new TriggerCoordinator(sqlOf(pim), { store: engine.store, host: engine.host, transaction, now: () => Date.now() + triggerClock.offset, connectorEvents: true }).tick();
		});

	beforeAll(() => {
		triggerClock.offset = 0;
	});

	it("is left pending by Pim's own engine, and goes through Pim's runs as the trigger's agent, where its actions still wait for approval", async () => {
		expect(await inSpace((pim) => pim.enableTriggerEngine())).toBe(true);
		const agent = await inSpace((pim) => pim.agents.majordomo().id);
		expect((await api("/settings", { method: "PUT", body: JSON.stringify({ approvalPolicy: "explicit" }) })).status).toBe(200);
		try {
			const observedAt = Date.now() - MINUTE;
			await inSpace((pim) => {
				const store = pim.triggerEngine()!.store;
				const spec = eventSpec({ owningAgentId: agent, originChatId: "1", instruction: "Post the fare to the team.", destination: { type: "new_chat" } });
				expect(store.create({ id: "fares", spec, lifecycle: "enabled" })).toMatchObject({ ok: true });
				expect(store.admit({ id: "fares", generation: 1, eventId: "evt_1", observedAt, payload: { price: 481.37, note: SECRET } })).toMatchObject({ status: "accepted" });
			});
			// Pim's own engine hands no event on.
			await inSpace((pim) => pim.runTriggerTick());
			expect(await inSpace((pim) => pim.triggerEngine()!.store.outbox("fares"))).toMatchObject([{ status: "pending", attempts: 0 }]);

			faux.setResponses([toolUse("http_request", { method: "POST", url: "https://hooks.example.test/fares" }), toolUse("send_to_user", { message: "I didn't post it." })]);
			expect((await dispatch()).handedOn).toHaveLength(1);
			const approval = await pendingApproval();
			const started = await inSpace((pim) => pim.triggerEngine()!.coordinator.runs("fares")[0]!);
			expect(started).toMatchObject({ phase: "accepted", chatState: "pinned" });
			const chat = started.chatId!;
			expect(await inSpace((pim) => pim.agents.ofSession(chat).id)).toBe(agent);
			const shown = await inSpace((pim) => pim.store.publicId(chat));
			expect(await messagesOf(shown, "user")).toEqual([`[Trigger "Fares" fares] Post the fare to the team.\n\n(On ${EVENT} from travel at ${iso(observedAt)}, event evt_1. What the event carried isn't kept or passed on.)`]);

			// The trigger approved nothing: the request waits for the person, and the run holds its trigger meanwhile.
			await dispatch();
			expect(await inSpace((pim) => pim.triggerEngine()!.coordinator.run(started.operationId)?.phase)).toBe("waiting_approval");
			expect((await api(`/approvals/${approval.id}`)).body).toMatchObject({ status: "pending", decidedBy: null });
			expect((await post(`/approvals/${approval.id}/deny`)).body).toMatchObject({ status: "denied", decidedBy: "user" });
			await settled(shown);
			triggerClock.offset += 2 * MINUTE;
			await dispatch();
			expect(await inSpace((pim) => pim.triggerEngine()!.coordinator.run(started.operationId)?.phase)).toBe("completed");

			// Nothing the event carried is in the chat or the person's export.
			const transcript = JSON.stringify((await api(`/sessions/${shown}/messages`)).body);
			const exported = await inSpace((pim) => pim.exportData());
			expect(exported).toContain("evt_1");
			for (const carried of [SECRET, "481.37"]) {
				expect(transcript).not.toContain(carried);
				expect(exported).not.toContain(carried);
			}
		} finally {
			await api("/settings", { method: "PUT", body: JSON.stringify({ approvalPolicy: null }) });
			await inSpace((pim) => pim.disableTriggerEngine());
		}
	});
});
