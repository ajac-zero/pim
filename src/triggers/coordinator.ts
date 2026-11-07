/**
 * The coordinator for time triggers: on each tick it admits the firings that
 * are due (./store.ts, with ./time.ts), and hands each admitted occurrence
 * to the owning agent through a host it is given, keeping one agent run per
 * trigger at a time. Nothing in Pim constructs it: there is no alarm, tool,
 * route or real host behind it yet, and only tests make one with a fake
 * host. See docs/triggers.md.
 *
 * Handing on is not atomic with the world outside this database, so the
 * coordinator never pretends it is. Each occurrence is one operation with
 * a stable id (the outbox item's `operationId`), and its record here, a
 * run, says what is known of it. Its destination chat is pinned before
 * anything is submitted, and a new chat is made under the operation's key
 * and looked up, never made again blind. Submitting is recorded as begun
 * before the host is called, so after a crash the coordinator asks the host
 * whether the submission happened before it would submit again. A
 * submission's acceptance is only that: the agent's run is tracked
 * separately, from what the host says of it, and the trigger's slot stays
 * taken until the host says the run ended. A thrown error is never taken as
 * an acceptance or as a refusal.
 *
 * Only time sources are handed on. An occurrence of any other source, which
 * the store can admit, stays pending: the context it would carry, and the
 * grant it would need, have no contract yet.
 */

import type { TimeSource, TriggerDestination } from "./spec";
import type { Delivery, TriggerStore } from "./store";
import type { OlderFirings } from "./time";
import { TriggerValidationError, integer, oneOf } from "./validate";

const SCHEMA = `
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
	first_dispatch_at INTEGER,
	last_dispatch_at INTEGER,
	submitted_at INTEGER,
	accepted_at INTEGER,
	ended_at INTEGER,
	check_at INTEGER,
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
`;

/** The coordinator's tables, beside the store's (`TRIGGER_TABLES`), for erasing a space. */
export const COORDINATOR_TABLES = ["pim_trigger_runs"] as const;

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;

/**
 * Where one operation stands:
 *
 * - `preparing`: claimed, nothing submitted. Its chat may be pinned, or
 *   being made (`chatState`). A deferred one waits here for its retry.
 * - `submitting`: the host was asked to submit it, and whether it accepted
 *   isn't known. Only `lookupSubmission` moves it on.
 * - `accepted`: the host accepted the submission; how the run is doing
 *   isn't known yet. `queued`, `running` and `waiting_approval` are what
 *   the host said of it since.
 * - `completed`, `failed`, `cancelled`: the host said the run ended so.
 * - `not_submitted`: known never to have been handed on, and it won't be:
 *   refused, denied, superseded, cancelled, or out of time or attempts.
 */
export type RunPhase = "preparing" | "submitting" | "accepted" | "queued" | "running" | "waiting_approval" | "completed" | "failed" | "cancelled" | "not_submitted";

/** Phases that hold the trigger's one run slot: whatever may be running, or may have been submitted. */
const SLOT_PHASES = ["submitting", "accepted", "queued", "running", "waiting_approval"] as const;
/** Phases that hold one of the space's compute slots. A run waiting for an approval holds its trigger's slot but no compute. */
const COMPUTE_PHASES = ["submitting", "accepted", "queued", "running"] as const;
const ACTIVE_PHASES = ["accepted", "queued", "running", "waiting_approval"] as const;
const TERMINAL_PHASES = ["completed", "failed", "cancelled", "not_submitted"] as const;

const inList = (phases: readonly string[]) => phases.map((phase) => `'${phase}'`).join(", ");

export type TriggerRun = {
	/** The outbox item's `operationId`: the key for its chat, its submission and its run. */
	readonly operationId: string;
	readonly triggerId: string;
	readonly outboxId: string;
	readonly occurrenceId: string;
	/** The spec revision it is handed on with: its occurrence's, whatever the trigger has become since. */
	readonly revision: number;
	readonly agentId: string;
	/** The chat it goes to, pinned before anything is submitted and never changed. */
	readonly chatId: string | null;
	/** `pinned`; `needed` (a new chat, not asked for yet); `creating` (asked for, outcome unknown until looked up); `unknown` (adopted from before, see `tick`). */
	readonly chatState: "pinned" | "needed" | "creating" | "unknown";
	readonly phase: RunPhase;
	/** The host's receipt for the accepted submission, which names the run. */
	readonly receipt: string | null;
	readonly scheduledFor: number;
	/** When the firing was admitted, apart from when it was handed on. */
	readonly admittedAt: number;
	/** The last instant it may still be submitted, fixed at its first claim: deferring never moves it, and the source's lateness never cancels it. */
	readonly deliverBy: number;
	readonly firstDispatchAt: number | null;
	readonly lastDispatchAt: number | null;
	readonly submittedAt: number | null;
	readonly acceptedAt: number | null;
	readonly endedAt: number | null;
	/** When to ask the host about it next, while its submission or run is unsettled. */
	readonly checkAt: number | null;
	readonly deferrals: number;
	readonly lastError: string | null;
	readonly createdAt: number;
	readonly updatedAt: number;
};

/**
 * What a run is told of why it started: the firing's times and the
 * schedule as the pinned revision had it. Nothing observed, since a time
 * source observes nothing.
 */
export type TimeEvidence = {
	readonly kind: "time";
	readonly triggerId: string;
	readonly revision: number;
	readonly label: string;
	readonly scheduledFor: number;
	readonly admittedAt: number;
	readonly schedule: { readonly schedule: "once"; readonly at: number } | { readonly schedule: "cron"; readonly expression: string; readonly timeZone: string } | { readonly schedule: "interval"; readonly everyMs: number; readonly anchorAt: number };
	/** Older firings that were due with it and won't run; a count, never a list. */
	readonly older: OlderFirings | null;
};

export type HostPreflight = { readonly ok: true } | { readonly ok: false; readonly reason: string; readonly retryable: boolean };
export type ChatLookup = { readonly status: "found"; readonly chatId: string } | { readonly status: "absent" } | { readonly status: "unknown" };
export type ChatCreation = { readonly status: "created"; readonly chatId: string } | { readonly status: "denied"; readonly reason: string };
export type SubmissionLookup = { readonly status: "accepted"; readonly receipt: string } | { readonly status: "absent" } | { readonly status: "unknown" };
export type SubmitResult =
	/** Accepted now, or before under the same key (`duplicate`, whose reservation the host gave back). */
	| { readonly status: "accepted" | "duplicate"; readonly receipt: string }
	/** Refused by the run limit, with nothing reserved; may say when to try again. */
	| { readonly status: "budget_blocked"; readonly reason: string; readonly retryAt?: number | null }
	/** The space is suspended; nothing was submitted. */
	| { readonly status: "suspended"; readonly reason: string }
	/** Known not accepted, and never will be: the chat or agent is gone, or the input was refused. */
	| { readonly status: "failed"; readonly reason: string }
	/** Whether it was accepted isn't known. */
	| { readonly status: "uncertain"; readonly reason: string };
const RUN_STATUSES = ["queued", "running", "waiting_approval", "completed", "failed", "cancelled", "unknown"] as const;
export type RunStatus = (typeof RUN_STATUSES)[number];

/**
 * What the coordinator needs of the space, injected. Pim has no
 * implementation yet: the real one, over `submitTo`, is the next reviewed
 * integration. Each method may throw; a throw is taken as "not known",
 * never as a success or a refusal.
 */
export interface TriggerAgentHost {
	/**
	 * Before each new handoff, whether it may go ahead: the agent still
	 * exists, an existing chat is still that agent's, and the space is
	 * active. A refusal that isn't `retryable` ends the operation; the host
	 * must never substitute another agent or chat. It grants nothing: the
	 * run's actions still go through approvals.
	 */
	preflight(input: { readonly triggerId: string; readonly operationId: string; readonly agentId: string; readonly destination: TriggerDestination; readonly sourceKind: "time" }): Promise<HostPreflight>;
	/** The chat made for `operationId`, if one was. */
	findChat(input: { readonly operationId: string }): Promise<ChatLookup>;
	/** Makes a chat with `agentId` keyed by `operationId`: asked again with the same key, it gives the same chat. */
	createChat(input: { readonly operationId: string; readonly agentId: string; readonly title: string }): Promise<ChatCreation>;
	/** Whether a submission with this key was accepted. `absent` must mean it wasn't, and that a submission under the key may still be made. */
	lookupSubmission(input: { readonly operationId: string }): Promise<SubmissionLookup>;
	/** Submits the instruction to the chat, at most once per `idempotencyKey`, reserving the run budget only for a new acceptance. */
	submit(input: { readonly idempotencyKey: string; readonly chatId: string; readonly agentId: string; readonly instruction: string; readonly evidence: TimeEvidence }): Promise<SubmitResult>;
	/** How the run a receipt names is doing. */
	lookupRun(input: { readonly operationId: string; readonly receipt: string }): Promise<RunStatus>;
}

export type CoordinatorBatch = {
	/** Time triggers looked at per tick. */
	readonly admissions: number;
	/** New handoffs per tick. */
	readonly handoffs: number;
	/** Questions to the host about submissions and runs per tick, each kind. */
	readonly lookups: number;
};

export type TriggerCoordinatorOptions = {
	readonly store: TriggerStore;
	readonly host: TriggerAgentHost;
	/** The database's transactions, as the store is given (`transactionSync`); they nest. */
	readonly transaction: <T>(work: () => T) => T;
	readonly now: () => number;
	/** How long one handoff attempt holds its occurrence (5 minutes). */
	readonly leaseMs?: number;
	/** How long after admission an occurrence may still be submitted, when deferred by the run limit or a suspension (24 hours). */
	readonly deliveryTtlMs?: number;
	/** How long to wait before trying again after a deferral, or asking again after an unknown answer (15 minutes). */
	readonly retryMs?: number;
	/** How often to ask how an accepted run is doing (1 minute). */
	readonly runCheckMs?: number;
	/** Runs of the space's triggers that may hold compute at once (4). */
	readonly maxRunning?: number;
	readonly batch?: Partial<CoordinatorBatch>;
};

/** What one tick did, by occurrence or operation id. */
export type TickReport = {
	readonly admitted: string[];
	readonly missed: string[];
	readonly handedOn: string[];
	readonly deferred: string[];
	readonly notSubmitted: string[];
	readonly reconciled: string[];
	/** When to tick next, for the host's alarm; null when nothing is waiting. */
	nextWakeAt: number | null;
};

type Row = Record<string, SqlStorageValue>;

/** Thrown inside a transaction to undo a claim the coordinator won't hand on. */
class Rollback extends Error {}

const DEFAULT_BATCH: CoordinatorBatch = { admissions: 16, handoffs: 4, lookups: 16 };

export class TriggerCoordinator {
	readonly #sql: SqlStorage;
	readonly #store: TriggerStore;
	readonly #host: TriggerAgentHost;
	readonly #transaction: <T>(work: () => T) => T;
	readonly #now: () => number;
	readonly #leaseMs: number;
	readonly #deliveryTtlMs: number;
	readonly #retryMs: number;
	readonly #runCheckMs: number;
	readonly #maxRunning: number;
	readonly #batch: CoordinatorBatch;
	/** Operations this instance is waiting on the host for, by trigger: not claimed or asked about again meanwhile. */
	readonly #inflight = new Map<string, string>();

	constructor(sql: SqlStorage, options: TriggerCoordinatorOptions) {
		this.#sql = sql;
		this.#store = options.store;
		this.#host = options.host;
		this.#transaction = options.transaction;
		this.#now = options.now;
		this.#leaseMs = integer(options.leaseMs ?? 5 * MINUTE, "leaseMs", 1_000, HOUR);
		this.#deliveryTtlMs = integer(options.deliveryTtlMs ?? 24 * HOUR, "deliveryTtlMs", MINUTE, 7 * 24 * HOUR);
		this.#retryMs = integer(options.retryMs ?? 15 * MINUTE, "retryMs", 1_000, 24 * HOUR);
		this.#runCheckMs = integer(options.runCheckMs ?? MINUTE, "runCheckMs", 1_000, HOUR);
		this.#maxRunning = integer(options.maxRunning ?? 4, "maxRunning", 1, 64);
		const batch = { ...DEFAULT_BATCH, ...options.batch };
		this.#batch = {
			admissions: integer(batch.admissions, "batch.admissions", 1, 256),
			handoffs: integer(batch.handoffs, "batch.handoffs", 1, 64),
			lookups: integer(batch.lookups, "batch.lookups", 1, 256),
		};
		this.#sql.exec(SCHEMA);
	}

	/**
	 * One bounded pass, safe to run again at any time, after a crash, or
	 * while another is waiting on the host: it admits due firings, settles
	 * what it can learn from the host, and hands on what is ready. It returns
	 * when to tick next.
	 */
	async tick(): Promise<TickReport> {
		const report: TickReport = { admitted: [], missed: [], handedOn: [], deferred: [], notSubmitted: [], reconciled: [], nextWakeAt: null };
		this.#admit(report);
		this.#tidy(report);
		await this.#reconcileSubmissions(report);
		await this.#refreshRuns();
		await this.#dispatch(report);
		report.nextWakeAt = this.nextWakeAt();
		return report;
	}

	/**
	 * The host says how a run is doing, unasked. Only the run its receipt
	 * names is changed, and only while it hasn't ended: a callback for an
	 * older receipt, an unknown operation or an ended run changes nothing.
	 */
	runStatusChanged(input: { operationId: string; receipt: string; status: RunStatus }): { ok: boolean } {
		const status = oneOf(input.status, "status", RUN_STATUSES);
		return this.#transaction(() => ({ ok: this.#applyRunStatus(input.operationId, input.receipt, status) }));
	}

	run(operationId: string): TriggerRun | undefined {
		const row = this.#sql.exec("SELECT * FROM pim_trigger_runs WHERE operation_id = ?", operationId).toArray()[0];
		return row ? runOf(row) : undefined;
	}

	/** A trigger's runs, oldest first; kept after it is deleted, as its history. */
	runs(triggerId: string): TriggerRun[] {
		return this.#sql.exec("SELECT * FROM pim_trigger_runs WHERE trigger_id = ? ORDER BY created_at, rowid", triggerId).toArray().map(runOf);
	}

	/** Erases every run record, with the store's `eraseAll`, for erasing the space. */
	eraseAll(): void {
		this.#transaction(() => {
			for (const table of COORDINATOR_TABLES) this.#sql.exec(`DELETE FROM ${table}`);
		});
	}

	/**
	 * When the next tick has work: a time trigger's wake, a submission or
	 * run to ask about, or an occurrence ready to hand on to a trigger whose
	 * slot is free while the space has compute free. Null when nothing waits.
	 */
	nextWakeAt(): number | null {
		const now = this.#now();
		const times: (number | null)[] = [this.#store.nextTimeWake()];
		// What this instance is waiting on the host for is passed over, so a slow answer doesn't make the alarm spin.
		const busy = new Set(this.#inflight.keys());
		const checks = this.#sql
			.exec(`SELECT operation_id, check_at FROM pim_trigger_runs WHERE phase IN (${inList(SLOT_PHASES)}) AND check_at IS NOT NULL ORDER BY check_at LIMIT ?`, busy.size + 1)
			.toArray()
			.find((row) => !busy.has(String(row.operation_id)));
		times.push(nullable(checks?.check_at));
		if (this.#adoptable(1).length > 0 || this.#closable(busy.size + 1).some((row) => !busy.has(String(row.operation_id)))) times.push(now);
		if (this.#computeFree() > 0) {
			const waiting = new Set(this.#inflight.values());
			const ready = this.#sql
				.exec(`SELECT o.trigger_id, CASE o.status WHEN 'pending' THEN o.available_at ELSE o.lease_until END AS at ${CANDIDATES} ORDER BY at LIMIT ?`, waiting.size + 1)
				.toArray()
				.find((row) => !waiting.has(String(row.trigger_id)));
			times.push(nullable(ready?.at));
		}
		const known = times.filter((time): time is number => time !== null);
		// Work already due is due now.
		return known.length === 0 ? null : Math.max(now, Math.min(...known));
	}

	// Admission

	#admit(report: TickReport): void {
		for (const due of this.#store.dueTimeTriggers({ now: this.#now(), limit: this.#batch.admissions })) {
			const tick = this.#store.admitDueTime({ id: due.id, generation: due.generation });
			if (!("occurrence" in tick) || tick.occurrence === null) continue;
			(tick.status === "admitted" ? report.admitted : report.missed).push(tick.occurrence.id);
		}
	}

	// Settling what is known

	/**
	 * Adopts time occurrences whose outcome the store lost track of (leases
	 * run out too often, or a deletion while one was claimed) with no run
	 * here, as possibly submitted, so the host is asked; and closes runs that
	 * never submitted whose occurrence was superseded, cancelled or failed.
	 * Prunes ended runs whose occurrence the store's history let go.
	 */
	#tidy(report: TickReport): void {
		const now = this.#now();
		for (const row of this.#adoptable(this.#batch.lookups)) {
			this.#transaction(() => {
				const spec = this.#store.revision(String(row.trigger_id), Number(row.revision));
				this.#sql.exec(
					`INSERT OR IGNORE INTO pim_trigger_runs (operation_id, trigger_id, outbox_id, occurrence_id, revision, agent_id, chat_id, chat_state, phase, receipt, scheduled_for, admitted_at, deliver_by, check_at, deferrals, created_at, updated_at)
					VALUES (?, ?, ?, ?, ?, ?, NULL, 'unknown', 'submitting', NULL, ?, ?, ?, ?, 0, ?, ?)`,
					String(row.operation_id),
					String(row.trigger_id),
					String(row.id),
					String(row.occurrence_id),
					Number(row.revision),
					spec?.owningAgentId ?? "unknown",
					Number(row.due_at),
					Number(row.created_at),
					Number(row.created_at) + this.#deliveryTtlMs,
					now,
					now,
					now,
				);
			});
		}
		for (const row of this.#closable(this.#batch.lookups)) {
			const operationId = String(row.operation_id);
			if (this.#inflight.has(operationId)) continue;
			this.#transaction(() => {
				const status = row.status === null ? "pruned" : String(row.status);
				if (status === "outcome_unknown") this.#store.reconcile({ outboxId: String(row.outbox_id), outcome: "failed" });
				this.#end(operationId, "not_submitted", `never submitted; its occurrence was ${status}`, now);
				report.notSubmitted.push(operationId);
			});
		}
		this.#sql.exec(
			`DELETE FROM pim_trigger_runs WHERE operation_id IN (SELECT r.operation_id FROM pim_trigger_runs r WHERE r.phase IN (${inList(TERMINAL_PHASES)}) AND NOT EXISTS (SELECT 1 FROM pim_trigger_occurrences c WHERE c.id = r.occurrence_id) LIMIT ?)`,
			this.#batch.lookups,
		);
	}

	#adoptable(limit: number): Row[] {
		return this.#sql
			.exec(
				`SELECT o.id, o.operation_id, o.trigger_id, o.occurrence_id, c.revision, c.due_at, c.created_at FROM pim_trigger_outbox o JOIN pim_trigger_occurrences c ON c.id = o.occurrence_id
				WHERE o.status = 'outcome_unknown' AND c.occurrence_key LIKE 'time:%' AND NOT EXISTS (SELECT 1 FROM pim_trigger_runs r WHERE r.operation_id = o.operation_id)
				ORDER BY o.updated_at, o.seq LIMIT ?`,
				limit,
			)
			.toArray();
	}

	#closable(limit: number): Row[] {
		return this.#sql
			.exec(
				`SELECT r.operation_id, r.outbox_id, o.status FROM pim_trigger_runs r LEFT JOIN pim_trigger_outbox o ON o.id = r.outbox_id
				WHERE r.phase = 'preparing' AND (o.id IS NULL OR o.status IN ('superseded', 'cancelled', 'failed', 'outcome_unknown'))
				ORDER BY r.updated_at LIMIT ?`,
				limit,
			)
			.toArray();
	}

	/**
	 * Asks the host about submissions whose outcome isn't known: begun before
	 * a crash, answered `uncertain`, or adopted. Accepted, it is recorded with
	 * its receipt, and its occurrence delivered. Absent, it was never handed
	 * on: tried again under the same key, unless its occurrence can no longer
	 * be (a deleted trigger's), when it is settled as failed.
	 */
	async #reconcileSubmissions(report: TickReport): Promise<void> {
		const rows = this.#sql
			.exec("SELECT * FROM pim_trigger_runs WHERE phase = 'submitting' AND check_at <= ? ORDER BY check_at, operation_id LIMIT ?", this.#now(), this.#batch.lookups + this.#inflight.size)
			.toArray()
			.map(runOf)
			.filter((run) => !this.#inflight.has(run.operationId))
			.slice(0, this.#batch.lookups);
		for (const run of rows) {
			const answer = await this.#ask(run, () => this.#host.lookupSubmission({ operationId: run.operationId }), { status: "unknown" } as SubmissionLookup);
			this.#transaction(() => {
				const now = this.#now();
				const current = this.run(run.operationId);
				if (current?.phase !== "submitting") return;
				if (answer.status === "accepted") {
					this.#accepted(current, answer.receipt, now);
					report.reconciled.push(run.operationId);
					return;
				}
				if (answer.status === "unknown") {
					this.#sql.exec("UPDATE pim_trigger_runs SET check_at = ?, updated_at = ? WHERE operation_id = ?", now + this.#retryMs, now, run.operationId);
					return;
				}
				const item = this.#store.outboxItem(run.outboxId);
				if (item?.status === "leased") {
					this.#sql.exec("UPDATE pim_trigger_runs SET phase = 'preparing', check_at = NULL, last_error = ?, updated_at = ? WHERE operation_id = ?", "not submitted, as the host says; tried again", now, run.operationId);
					this.#store.fail({ outboxId: item.id, attempt: item.attempts, retryAt: now, error: "not submitted; tried again under the same operation id" });
				} else if (item?.status === "outcome_unknown") {
					this.#store.reconcile({ outboxId: item.id, outcome: "failed" });
					this.#end(run.operationId, "not_submitted", "never submitted, as the host says, and no longer to be handed on", now);
				} else if (item === undefined || item.status === "failed" || item.status === "superseded" || item.status === "cancelled") {
					this.#end(run.operationId, "not_submitted", "never submitted, as the host says", now);
				} else {
					// A pending item is claimed again as usual; a delivered one the host has no record of is a contradiction to look at again later.
					this.#sql.exec("UPDATE pim_trigger_runs SET phase = ?, check_at = ?, updated_at = ? WHERE operation_id = ?", item.status === "pending" ? "preparing" : "submitting", item.status === "pending" ? null : now + this.#retryMs, now, run.operationId);
					return;
				}
				report.reconciled.push(run.operationId);
			});
		}
	}

	/** Asks the host how accepted runs are doing, so a trigger's slot frees only when the host says its run ended. */
	async #refreshRuns(): Promise<void> {
		const rows = this.#sql
			.exec(`SELECT * FROM pim_trigger_runs WHERE phase IN (${inList(ACTIVE_PHASES)}) AND check_at <= ? ORDER BY check_at, operation_id LIMIT ?`, this.#now(), this.#batch.lookups)
			.toArray()
			.map(runOf);
		for (const run of rows) {
			const status = await this.#ask(run, () => this.#host.lookupRun({ operationId: run.operationId, receipt: run.receipt! }), "unknown" as RunStatus);
			this.#transaction(() => this.#applyRunStatus(run.operationId, run.receipt!, status));
		}
	}

	#applyRunStatus(operationId: string, receipt: string, status: RunStatus): boolean {
		const run = this.run(operationId);
		if (!run || run.receipt !== receipt || !(ACTIVE_PHASES as readonly string[]).includes(run.phase)) return false;
		const now = this.#now();
		if (status === "completed" || status === "failed" || status === "cancelled") {
			this.#end(operationId, status, null, now);
		} else if (status === "queued" || status === "running" || status === "waiting_approval") {
			this.#sql.exec("UPDATE pim_trigger_runs SET phase = ?, check_at = ?, updated_at = ? WHERE operation_id = ?", status, now + this.#runCheckMs, now, operationId);
		} else {
			this.#sql.exec("UPDATE pim_trigger_runs SET check_at = ?, updated_at = ? WHERE operation_id = ?", now + this.#runCheckMs, now, operationId);
		}
		return true;
	}

	// Handing on

	#computeFree(): number {
		const running = Number(this.#sql.exec(`SELECT COUNT(*) AS n FROM pim_trigger_runs WHERE phase IN (${inList(COMPUTE_PHASES)})`).one().n);
		return this.#maxRunning - running;
	}

	/**
	 * Hands on up to a batch of occurrences, one per trigger, fairly: the
	 * triggers handed on to longest ago go first. A trigger whose run may
	 * still be going, or whose next occurrence isn't a time firing, is
	 * passed over.
	 */
	async #dispatch(report: TickReport): Promise<void> {
		const free = Math.min(this.#batch.handoffs, this.#computeFree());
		if (free <= 0) return;
		const now = this.#now();
		const busy = new Set(this.#inflight.values());
		const triggers = this.#sql
			.exec(
				`SELECT o.trigger_id ${CANDIDATES} AND ((o.status = 'pending' AND o.available_at <= ?) OR (o.status = 'leased' AND o.lease_until <= ?))
				ORDER BY (SELECT MAX(r.last_dispatch_at) FROM pim_trigger_runs r WHERE r.trigger_id = o.trigger_id), o.available_at, o.seq LIMIT ?`,
				now,
				now,
				free + busy.size,
			)
			.toArray()
			.map((row) => String(row.trigger_id))
			.filter((id) => !busy.has(id))
			.slice(0, free);
		for (const triggerId of triggers) {
			const begun = this.#begin(triggerId);
			if (begun) await this.#handOff(begun.run, begun.delivery, report);
		}
	}

	/** Claims a trigger's next occurrence and records its run, pinned to the occurrence's revision, agent and, for an existing chat, chat. */
	#begin(triggerId: string): { run: TriggerRun; delivery: Delivery } | null {
		try {
			return this.#transaction(() => {
				const delivery = this.#store.claim({ leaseMs: this.#leaseMs, triggerId });
				if (!delivery) return null;
				// Only time firings are handed on; anything else is left as it was.
				if (delivery.spec.source.kind !== "time" || delivery.occurrence.evidence.reason !== "time") throw new Rollback();
				const now = this.#now();
				const operationId = delivery.item.operationId;
				const existing = this.run(operationId);
				if (existing && existing.phase !== "preparing") throw new Rollback();
				if (!existing) {
					const destination = delivery.spec.destination;
					this.#sql.exec(
						`INSERT INTO pim_trigger_runs (operation_id, trigger_id, outbox_id, occurrence_id, revision, agent_id, chat_id, chat_state, phase, receipt, scheduled_for, admitted_at, deliver_by, deferrals, created_at, updated_at)
						VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'preparing', NULL, ?, ?, ?, 0, ?, ?)`,
						operationId,
						triggerId,
						delivery.item.id,
						delivery.occurrence.id,
						delivery.occurrence.revision,
						delivery.spec.owningAgentId,
						destination.type === "existing_chat" ? destination.chatId : null,
						destination.type === "existing_chat" ? "pinned" : "needed",
						delivery.occurrence.dueAt,
						delivery.occurrence.createdAt,
						delivery.occurrence.createdAt + this.#deliveryTtlMs,
						now,
						now,
					);
				}
				this.#sql.exec("UPDATE pim_trigger_runs SET first_dispatch_at = COALESCE(first_dispatch_at, ?), last_dispatch_at = ?, updated_at = ? WHERE operation_id = ?", now, now, now, operationId);
				return { run: this.run(operationId)!, delivery };
			});
		} catch (error) {
			if (error instanceof Rollback) return null;
			throw error;
		}
	}

	async #handOff(run: TriggerRun, delivery: Delivery, report: TickReport): Promise<void> {
		const operationId = run.operationId;
		const attempt = delivery.attempt;
		this.#inflight.set(operationId, run.triggerId);
		try {
			if (this.#now() > run.deliverBy) return this.#notSubmitted(run, attempt, "the time to hand it on ran out", null, report);
			// Checked again before every new handoff; an accepted run is never checked again here.
			const preflight = await this.#call(
				() => this.#host.preflight({ triggerId: run.triggerId, operationId, agentId: run.agentId, destination: delivery.spec.destination, sourceKind: "time" }),
				(reason): HostPreflight => ({ ok: false, reason: `the host's check failed: ${reason}`, retryable: true }),
			);
			if (!preflight.ok) {
				if (preflight.retryable) return this.#defer(run, attempt, preflight.reason, null, null, report);
				return this.#notSubmitted(run, attempt, preflight.reason, "configuration_error", report);
			}
			const chatId = run.chatId ?? (await this.#chat(run, attempt, delivery.spec.label, report));
			if (chatId === null) return;
			const gate = this.#transaction(() => {
				const now = this.#now();
				const current = this.run(operationId);
				const item = this.#store.outboxItem(run.outboxId);
				if (current?.phase !== "preparing" || item?.status !== "leased" || item.attempts !== attempt) return "superseded";
				// Paused meanwhile: nothing new goes out until it is enabled again, and the occurrence waits for then.
				if (this.#store.get(run.triggerId)?.lifecycle === "paused") {
					this.#store.fail({ outboxId: item.id, attempt, retryAt: now, error: "paused before it was handed on" });
					return "paused";
				}
				this.#sql.exec("UPDATE pim_trigger_runs SET phase = 'submitting', submitted_at = ?, check_at = ?, updated_at = ? WHERE operation_id = ?", now, now + this.#leaseMs, now, operationId);
				return "submit";
			});
			if (gate !== "submit") return;
			const result = await this.#call(
				() => this.#host.submit({ idempotencyKey: operationId, chatId, agentId: run.agentId, instruction: delivery.spec.instruction, evidence: evidenceOf(delivery) }),
				(reason): SubmitResult => ({ status: "uncertain", reason }),
			);
			switch (result.status) {
				case "accepted":
				case "duplicate":
					this.#transaction(() => this.#accepted(this.run(operationId)!, result.receipt, this.#now()));
					report.handedOn.push(operationId);
					return;
				case "budget_blocked":
					return this.#defer(run, attempt, result.reason, result.retryAt ?? null, "budget_blocked", report);
				case "suspended":
					return this.#defer(run, attempt, result.reason, null, null, report);
				case "failed":
					return this.#notSubmitted(run, attempt, result.reason, null, report);
				case "uncertain": {
					// Not known either way: it holds the slot until `lookupSubmission` says.
					const now = this.#now();
					this.#sql.exec("UPDATE pim_trigger_runs SET last_error = ?, check_at = ?, updated_at = ? WHERE operation_id = ? AND phase = 'submitting'", clip(result.reason), now + this.#retryMs, now, operationId);
					return;
				}
			}
		} finally {
			this.#inflight.delete(operationId);
		}
	}

	/**
	 * The run's new chat, pinned before anything is submitted to it. A chat
	 * asked for before whose outcome wasn't recorded is looked up first, and
	 * made only when the host says there is none, so a retry never makes a
	 * second chat. Null when the handoff can't go on now.
	 */
	async #chat(run: TriggerRun, attempt: number, title: string, report: TickReport): Promise<string | null> {
		const operationId = run.operationId;
		if (run.chatState === "creating" || run.chatState === "unknown") {
			const found = await this.#call(() => this.#host.findChat({ operationId }), (): ChatLookup => ({ status: "unknown" }));
			if (found.status === "found") return this.#pin(operationId, found.chatId);
			if (found.status === "unknown") {
				this.#defer(run, attempt, "whether its chat was made isn't known yet", null, null, report);
				return null;
			}
		}
		this.#sql.exec("UPDATE pim_trigger_runs SET chat_state = 'creating', updated_at = ? WHERE operation_id = ? AND chat_id IS NULL", this.#now(), operationId);
		let created: ChatCreation;
		try {
			created = await this.#host.createChat({ operationId, agentId: run.agentId, title });
		} catch (error) {
			this.#defer(run, attempt, `whether its chat was made isn't known: ${errorText(error)}`, null, null, report);
			return null;
		}
		if (created.status === "denied") {
			this.#notSubmitted(run, attempt, created.reason, "configuration_error", report);
			return null;
		}
		return this.#pin(operationId, created.chatId);
	}

	#pin(operationId: string, chatId: string): string {
		const now = this.#now();
		this.#sql.exec("UPDATE pim_trigger_runs SET chat_id = ?, chat_state = 'pinned', updated_at = ? WHERE operation_id = ? AND chat_id IS NULL", chatId, now, operationId);
		return this.run(operationId)!.chatId!;
	}

	/** Records an accepted submission and delivers its occurrence, however the store holds it now (claimed, or unknown after a deletion). */
	#accepted(run: TriggerRun, receipt: string, now: number): void {
		if (run.phase !== "preparing" && run.phase !== "submitting") return;
		this.#sql.exec(
			"UPDATE pim_trigger_runs SET phase = 'accepted', receipt = ?, accepted_at = ?, check_at = ?, last_error = NULL, updated_at = ? WHERE operation_id = ?",
			clip(receipt),
			now,
			now,
			now,
			run.operationId,
		);
		const item = this.#store.outboxItem(run.outboxId);
		if (item?.status === "leased") this.#store.complete({ outboxId: item.id, attempt: item.attempts });
		else if (item?.status === "outcome_unknown") this.#store.reconcile({ outboxId: item.id, outcome: "delivered" });
		const trigger = this.#store.get(run.triggerId);
		if (trigger?.health === "budget_blocked") this.#store.setHealth({ id: trigger.id, generation: trigger.generation, health: "healthy" });
	}

	/**
	 * Puts off an operation that is known not to have been handed on, to try
	 * again with the same key: after `retryMs`, or the host's `retryAt` if
	 * later. Out of time (`deliverBy`) or attempts, it is never submitted.
	 */
	#defer(run: TriggerRun, attempt: number, reason: string, retryAt: number | null, health: "budget_blocked" | null, report: TickReport): void {
		this.#transaction(() => {
			const now = this.#now();
			const current = this.run(run.operationId);
			if (!current || (current.phase !== "preparing" && current.phase !== "submitting")) return;
			this.#sql.exec("UPDATE pim_trigger_runs SET phase = 'preparing', check_at = NULL, deferrals = deferrals + 1, last_error = ?, updated_at = ? WHERE operation_id = ?", clip(reason), now, run.operationId);
			const item = this.#store.outboxItem(run.outboxId);
			if (item?.status === "outcome_unknown") {
				this.#store.reconcile({ outboxId: item.id, outcome: "failed" });
				this.#end(run.operationId, "not_submitted", `${reason}; and its trigger was deleted`, now);
				report.notSubmitted.push(run.operationId);
				return;
			}
			if (item?.status !== "leased" || item.attempts !== attempt) return;
			const at = Math.max(now + this.#retryMs, retryAt ?? 0);
			if (at > current.deliverBy) {
				this.#store.fail({ outboxId: item.id, attempt, retryAt: null, error: clip(`${reason}; the time to hand it on ran out`) });
				this.#end(run.operationId, "not_submitted", `${reason}; the time to hand it on ran out`, now);
				report.notSubmitted.push(run.operationId);
				return;
			}
			const failed = this.#store.fail({ outboxId: item.id, attempt, retryAt: at, error: clip(reason) });
			if (failed.retrying) report.deferred.push(run.operationId);
			else {
				this.#end(run.operationId, "not_submitted", `${reason}; out of attempts`, now);
				report.notSubmitted.push(run.operationId);
			}
			const trigger = this.#store.get(run.triggerId);
			if (health && trigger && trigger.lifecycle !== "deleted") this.#store.setHealth({ id: trigger.id, generation: trigger.generation, health, detail: clip(reason, 500) });
		});
	}

	/** Ends an operation that is known never to have been handed on, and won't be. */
	#notSubmitted(run: TriggerRun, attempt: number, reason: string, health: "configuration_error" | null, report: TickReport): void {
		this.#transaction(() => {
			const now = this.#now();
			const current = this.run(run.operationId);
			if (!current || (current.phase !== "preparing" && current.phase !== "submitting")) return;
			const item = this.#store.outboxItem(run.outboxId);
			if (item?.status === "leased" && item.attempts === attempt) this.#store.fail({ outboxId: item.id, attempt, retryAt: null, error: clip(reason) });
			else if (item?.status === "outcome_unknown") this.#store.reconcile({ outboxId: item.id, outcome: "failed" });
			this.#end(run.operationId, "not_submitted", reason, now);
			report.notSubmitted.push(run.operationId);
			const trigger = this.#store.get(run.triggerId);
			if (health && trigger && trigger.lifecycle !== "deleted") this.#store.setHealth({ id: trigger.id, generation: trigger.generation, health, detail: clip(reason, 500) });
		});
	}

	#end(operationId: string, phase: (typeof TERMINAL_PHASES)[number], reason: string | null, now: number): void {
		this.#sql.exec(
			"UPDATE pim_trigger_runs SET phase = ?, ended_at = ?, check_at = NULL, last_error = COALESCE(?, last_error), updated_at = ? WHERE operation_id = ?",
			phase,
			now,
			reason === null ? null : clip(reason),
			now,
			operationId,
		);
	}

	/** Asks the host something about a run, holding it in flight meanwhile; a throw is `fallback`. */
	async #ask<T>(run: TriggerRun, question: () => Promise<T>, fallback: T): Promise<T> {
		this.#inflight.set(run.operationId, run.triggerId);
		try {
			return await question();
		} catch {
			return fallback;
		} finally {
			this.#inflight.delete(run.operationId);
		}
	}

	async #call<T>(call: () => Promise<T>, fallback: (reason: string) => T): Promise<T> {
		try {
			return await call();
		} catch (error) {
			return fallback(errorText(error));
		}
	}
}

/**
 * The occurrences a trigger could hand on next: the head of each trigger's
 * outbox, when it is a time firing of an enabled or ended trigger whose
 * slot is free. Read from the store's tables, in the same database.
 */
const CANDIDATES = `FROM pim_trigger_outbox o
	JOIN pim_triggers t ON t.id = o.trigger_id
	JOIN pim_trigger_occurrences c ON c.id = o.occurrence_id
	WHERE t.lifecycle IN ('enabled', 'ended')
	AND o.seq = (SELECT MIN(h.seq) FROM pim_trigger_outbox h WHERE h.trigger_id = o.trigger_id AND h.status IN ('pending', 'leased'))
	AND c.occurrence_key LIKE 'time:%'
	AND NOT EXISTS (SELECT 1 FROM pim_trigger_runs r WHERE r.trigger_id = o.trigger_id AND r.phase IN (${inList(SLOT_PHASES)}))`;

function evidenceOf(delivery: Delivery): TimeEvidence {
	const source = delivery.spec.source as TimeSource;
	const evidence = delivery.occurrence.evidence;
	if (evidence.reason !== "time") throw new TriggerValidationError("occurrence", "is not a time firing");
	return {
		kind: "time",
		triggerId: delivery.item.triggerId,
		revision: delivery.occurrence.revision,
		label: delivery.spec.label,
		scheduledFor: evidence.scheduledFor,
		admittedAt: delivery.occurrence.createdAt,
		schedule:
			source.schedule === "once"
				? { schedule: "once", at: source.at }
				: source.schedule === "cron"
					? { schedule: "cron", expression: source.expression, timeZone: source.timeZone }
					: { schedule: "interval", everyMs: source.everyMs, anchorAt: source.anchorAt },
		older: evidence.older ?? null,
	};
}

function runOf(row: Row): TriggerRun {
	return {
		operationId: String(row.operation_id),
		triggerId: String(row.trigger_id),
		outboxId: String(row.outbox_id),
		occurrenceId: String(row.occurrence_id),
		revision: Number(row.revision),
		agentId: String(row.agent_id),
		chatId: row.chat_id === null ? null : String(row.chat_id),
		chatState: String(row.chat_state) as TriggerRun["chatState"],
		phase: String(row.phase) as RunPhase,
		receipt: row.receipt === null ? null : String(row.receipt),
		scheduledFor: Number(row.scheduled_for),
		admittedAt: Number(row.admitted_at),
		deliverBy: Number(row.deliver_by),
		firstDispatchAt: nullable(row.first_dispatch_at),
		lastDispatchAt: nullable(row.last_dispatch_at),
		submittedAt: nullable(row.submitted_at),
		acceptedAt: nullable(row.accepted_at),
		endedAt: nullable(row.ended_at),
		checkAt: nullable(row.check_at),
		deferrals: Number(row.deferrals),
		lastError: row.last_error === null ? null : String(row.last_error),
		createdAt: Number(row.created_at),
		updatedAt: Number(row.updated_at),
	};
}

function nullable(value: SqlStorageValue | undefined): number | null {
	return value === null || value === undefined ? null : Number(value);
}

function clip(value: string, max = 1_000): string {
	return value.length > max ? `${value.slice(0, max - 1)}…` : value;
}

function errorText(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}
