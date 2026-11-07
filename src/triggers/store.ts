/**
 * Triggers' durable state, in a space's SQLite database: each trigger with
 * its immutable revisions, its source's checkpoint and condition state, the
 * events it has taken in, its occurrences, the outbox that hands them on,
 * and tombstones of deleted triggers. Every method that changes more than
 * one row does it in one transaction (`options.transaction`), so a crash
 * leaves all of a step or none of it.
 *
 * Nothing in Pim constructs this store yet: its tables exist only where a
 * test makes one. See docs/triggers.md for the contract and what is left.
 *
 * What it guarantees is about this database only. An occurrence's outbox
 * item keeps one `operationId` through every attempt, so a deliverer that
 * passes it on (as `submitTo` takes an operation id) makes a retried
 * submission one run; nothing here makes an outside effect happen exactly
 * once. Nothing here keeps what a source observed, either: an occurrence
 * keeps why it fired, when, and which fields its condition found.
 */

import { type Condition, type ConditionState, type Truth, evaluate, lookup, referencedPaths } from "./condition";
import { type TriggerHealth, type TriggerLifecycle, type TriggerSpec, TRIGGER_HEALTHS, TRIGGER_LIMITS, conditionMode, parseTriggerSpec, runsOnComputer } from "./spec";
import { type JsonValue, TriggerValidationError, integer, json, oneOf, opaqueId, text } from "./validate";

const SCHEMA = `
CREATE TABLE IF NOT EXISTS pim_triggers (
	id TEXT PRIMARY KEY,
	revision INTEGER NOT NULL,
	lifecycle TEXT NOT NULL,
	health TEXT NOT NULL,
	health_detail TEXT,
	generation INTEGER NOT NULL,
	created_at INTEGER NOT NULL,
	updated_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS pim_trigger_revisions (
	trigger_id TEXT NOT NULL,
	revision INTEGER NOT NULL,
	spec TEXT NOT NULL,
	created_at INTEGER NOT NULL,
	PRIMARY KEY (trigger_id, revision)
);
CREATE TRIGGER IF NOT EXISTS pim_trigger_revisions_immutable BEFORE UPDATE ON pim_trigger_revisions
BEGIN SELECT RAISE(ABORT, 'trigger revisions are immutable'); END;
CREATE TABLE IF NOT EXISTS pim_trigger_sources (
	trigger_id TEXT PRIMARY KEY,
	source_revision INTEGER NOT NULL,
	position INTEGER,
	cursor TEXT,
	last_observed_at INTEGER,
	gap_pending INTEGER NOT NULL,
	condition_state TEXT,
	updated_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS pim_trigger_inbox (
	source TEXT NOT NULL,
	event_id TEXT NOT NULL,
	trigger_id TEXT NOT NULL,
	generation INTEGER NOT NULL,
	outcome TEXT NOT NULL,
	received_at INTEGER NOT NULL,
	PRIMARY KEY (source, event_id)
);
CREATE INDEX IF NOT EXISTS pim_trigger_inbox_by_trigger ON pim_trigger_inbox (trigger_id, received_at);
CREATE TABLE IF NOT EXISTS pim_trigger_occurrences (
	id TEXT PRIMARY KEY,
	trigger_id TEXT NOT NULL,
	occurrence_key TEXT NOT NULL,
	revision INTEGER NOT NULL,
	generation INTEGER NOT NULL,
	status TEXT NOT NULL,
	evidence TEXT,
	due_at INTEGER NOT NULL,
	created_at INTEGER NOT NULL,
	updated_at INTEGER NOT NULL,
	UNIQUE (trigger_id, occurrence_key)
);
CREATE TRIGGER IF NOT EXISTS pim_trigger_occurrences_fixed BEFORE UPDATE OF id, trigger_id, occurrence_key, revision, generation, evidence, due_at ON pim_trigger_occurrences
BEGIN SELECT RAISE(ABORT, 'an occurrence keeps its revision and evidence'); END;
CREATE TABLE IF NOT EXISTS pim_trigger_outbox (
	id TEXT PRIMARY KEY,
	seq INTEGER NOT NULL UNIQUE,
	occurrence_id TEXT NOT NULL UNIQUE,
	trigger_id TEXT NOT NULL,
	operation_id TEXT NOT NULL UNIQUE,
	status TEXT NOT NULL,
	attempts INTEGER NOT NULL,
	available_at INTEGER NOT NULL,
	lease_until INTEGER,
	last_error TEXT,
	created_at INTEGER NOT NULL,
	updated_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS pim_trigger_outbox_by_trigger ON pim_trigger_outbox (trigger_id, status, seq);
CREATE TABLE IF NOT EXISTS pim_trigger_tombstones (
	trigger_id TEXT PRIMARY KEY,
	generation INTEGER NOT NULL,
	deleted_at INTEGER NOT NULL
);
`;

/** Every table this store keeps, for erasing a space (`eraseAll`) and for listing what it holds. */
export const TRIGGER_TABLES = ["pim_triggers", "pim_trigger_revisions", "pim_trigger_sources", "pim_trigger_inbox", "pim_trigger_occurrences", "pim_trigger_outbox", "pim_trigger_tombstones"] as const;

const DAY = 24 * 60 * 60_000;

export const ADMISSION_LIMITS = {
	eventIdLength: 256,
	cursorLength: 1_024,
	payload: { maxBytes: 16_384, maxDepth: 8 },
	errorLength: 1_000,
	healthDetailLength: 500,
	/** How far ahead of the store's clock an observation's time may be. */
	futureSkewMs: 5 * 60_000,
	maxLeaseMs: 60 * 60_000,
	/** Attempts at handing on one occurrence, failed or with leases run out, before it fails or its outcome is unknown. */
	maxAttempts: 5,
	/** The shortest replay horizon a store may be given. */
	minDedupHorizonMs: 7 * DAY,
} as const;

export type Retention = {
	/**
	 * How long an event id is remembered, so a replay of it is a duplicate.
	 * An event or observation older than this is refused (`too_old`), since
	 * whether it was taken in before can no longer be told. At least 7 days.
	 */
	readonly dedupHorizonMs: number;
	/** The most event ids one trigger remembers within the horizon; past it, admissions are refused (`inbox_full`) until old ones expire. */
	readonly inboxCap: number;
	/** How many finished occurrences one trigger keeps past the horizon; within the horizon, all are kept. */
	readonly occurrences: number;
};

export const DEFAULT_RETENTION: Retention = {
	dedupHorizonMs: 7 * DAY,
	// Room for a poll every minute for the whole horizon (10,080), and twice that.
	inboxCap: 20_000,
	occurrences: 200,
};

export type Trigger = {
	readonly id: string;
	readonly revision: number;
	readonly spec: TriggerSpec;
	readonly lifecycle: TriggerLifecycle;
	readonly health: TriggerHealth;
	readonly healthDetail: string | null;
	/**
	 * Which run of the source's observers is current. It goes up with every
	 * lifecycle change and every change of source or condition, and an
	 * observation from any other generation is refused.
	 */
	readonly generation: number;
	readonly createdAt: number;
	readonly updatedAt: number;
};

export type SourceState = {
	/** The revision the current source was set in; with the trigger's id, the source's identity for taking in events. */
	readonly sourceRevision: number;
	readonly identity: string;
	/** Where the source resumes from: a position that only goes up, and the source's own cursor at it. */
	readonly position: number | null;
	readonly cursor: string | null;
	readonly lastObservedAt: number | null;
	/** The next observation follows a gap, so a condition's continuity starts again. */
	readonly gapPending: boolean;
	readonly conditionState: ConditionState | null;
};

/** `outcome_unknown`: its leases ran out too often to tell whether it was handed on; `reconcile` settles it. */
export type OccurrenceStatus = "pending" | "delivered" | "failed" | "superseded" | "missed" | "cancelled" | "outcome_unknown";

export type Occurrence = {
	readonly id: string;
	readonly triggerId: string;
	/** Unique per trigger: `event:<source identity>:<eventId>` or `time:<scheduledFor>`. */
	readonly key: string;
	/** The spec revision it happened under, and is handed on with. */
	readonly revision: number;
	readonly generation: number;
	readonly status: OccurrenceStatus;
	/** Why it fired, when, and which fields its condition found (see `Evidence`); never what was observed. */
	readonly evidence: Evidence;
	/** When it happened: the observation's time, or the time it was scheduled for. */
	readonly dueAt: number;
	readonly createdAt: number;
	readonly updatedAt: number;
};

/** What an occurrence keeps of what caused it. Values and bodies are never kept. */
export type Evidence =
	| { readonly reason: "time"; readonly scheduledFor: number }
	| { readonly reason: "event" | "condition"; readonly truth: Truth; readonly observedAt: number; readonly fields: readonly { readonly path: readonly string[]; readonly present: boolean }[] };

export type OutboxStatus = "pending" | "leased" | "done" | "failed" | "superseded" | "cancelled" | "outcome_unknown";

export type OutboxItem = {
	readonly id: string;
	readonly occurrenceId: string;
	readonly triggerId: string;
	/** The same for every attempt: what a deliverer passes on so a retried submission is one run. */
	readonly operationId: string;
	readonly status: OutboxStatus;
	readonly attempts: number;
	readonly availableAt: number;
	readonly leaseUntil: number | null;
	readonly lastError: string | null;
	readonly createdAt: number;
	readonly updatedAt: number;
};

/** One claimed attempt: the item, its occurrence, and the spec as it was at the occurrence's revision. */
export type Delivery = { readonly item: OutboxItem; readonly occurrence: Occurrence; readonly spec: TriggerSpec; readonly attempt: number };

/**
 * What the host checks before a source on the person's computer may run:
 * that `authorizationRef` names a real grant, still current, given for
 * exactly this source. The store never takes a reference on trust.
 */
export type AuthorizationRequest = { readonly triggerId: string; readonly spec: TriggerSpec; readonly authorizationRef: string; readonly now: number };
export type AuthorizationVerdict = { readonly ok: true } | { readonly ok: false; readonly reason: string };

export type Refusal = {
	readonly ok: false;
	readonly reason: "not_found" | "deleted" | "exists" | "revision_mismatch" | "invalid_transition" | "authorization_required" | "authorization_denied" | "immutable_field";
	/** Why an authorization was denied, as the host's check said. */
	readonly detail?: string;
	readonly current?: Trigger;
};

export type Changed = { readonly ok: true; readonly trigger: Trigger };

/** Why an observation or firing was not taken in. Nothing was written for any of these. */
export type AdmissionRefusal = {
	readonly status:
		| "not_found"
		| "deleted"
		| "stale_generation"
		| "not_enabled"
		| "wrong_source"
		| "duplicate"
		| "out_of_order"
		| "too_old"
		| "expired"
		| "backpressure"
		| "inbox_full"
		| "not_due"
		| "schedule_mismatch";
};

export type Admitted = {
	readonly status: "accepted";
	/** What the condition said; `true` without a condition. */
	readonly truth: Truth;
	readonly stale: boolean;
	/** The occurrence it made, if it fired (or was missed, for a firing too late to run). */
	readonly occurrence: Occurrence | null;
	/** Pending occurrences the new one replaced, for sources that hold one pending snapshot. */
	readonly superseded: readonly string[];
};

export type Admission = Admitted | AdmissionRefusal;

export type TriggerStoreOptions = {
	/** Runs `work` as one transaction of the database: all its writes, or none when it throws (a Durable Object's `transactionSync`). */
	readonly transaction: <T>(work: () => T) => T;
	readonly now: () => number;
	readonly newId?: () => string;
	/** The host's check of a computer source's grant. Without one, no computer source can be enabled. */
	readonly authorize?: (request: AuthorizationRequest) => AuthorizationVerdict;
	readonly retention?: Partial<Retention>;
};

type Row = Record<string, SqlStorageValue>;

const TRANSITIONS: Record<"enabled" | "paused" | "ended", readonly TriggerLifecycle[]> = {
	enabled: ["draft", "paused"],
	paused: ["enabled"],
	ended: ["draft", "enabled", "paused"],
};

export class TriggerStore {
	readonly #sql: SqlStorage;
	readonly #options: TriggerStoreOptions;
	readonly #retention: Retention;

	constructor(sql: SqlStorage, options: TriggerStoreOptions) {
		this.#sql = sql;
		this.#options = options;
		this.#retention = { ...DEFAULT_RETENTION, ...options.retention };
		if (this.#retention.dedupHorizonMs < ADMISSION_LIMITS.minDedupHorizonMs) throw new TriggerValidationError("retention.dedupHorizonMs", "must be at least 7 days");
		this.#sql.exec(SCHEMA);
	}

	#id(): string {
		return this.#options.newId?.() ?? crypto.randomUUID();
	}

	// Triggers and revisions

	/** A trigger, deleted ones included (`lifecycle: "deleted"`), whose revisions and occurrences are kept. */
	get(id: string): Trigger | undefined {
		const row = this.#sql.exec("SELECT * FROM pim_triggers WHERE id = ?", id).toArray()[0];
		return row ? this.#triggerOf(row) : undefined;
	}

	/** The triggers that aren't deleted. */
	list(): Trigger[] {
		return this.#sql
			.exec("SELECT * FROM pim_triggers WHERE lifecycle != 'deleted' ORDER BY created_at, id")
			.toArray()
			.map((row) => this.#triggerOf(row));
	}

	/** The spec as it was at `revision`. Revisions are never changed. */
	revision(id: string, revision: number): TriggerSpec | undefined {
		const row = this.#sql.exec("SELECT spec FROM pim_trigger_revisions WHERE trigger_id = ? AND revision = ?", id, revision).toArray()[0];
		return row ? (JSON.parse(String(row.spec)) as TriggerSpec) : undefined;
	}

	/**
	 * Makes a trigger at revision 1, as a draft or enabled. A source that runs
	 * on the person's computer is enabled only once the host's check accepts
	 * its `authorizationRef`. An id is never reused, even after the trigger
	 * is deleted.
	 */
	create(input: { id?: string; spec: unknown; lifecycle?: "draft" | "enabled" }): Changed | Refusal {
		const spec = parseTriggerSpec(input.spec);
		const id = input.id === undefined ? this.#id() : opaqueId(input.id, "id");
		const lifecycle = input.lifecycle ?? "draft";
		return this.#options.transaction((): Changed | Refusal => {
			const existing = this.get(id);
			if (existing) return { ok: false, reason: existing.lifecycle === "deleted" ? "deleted" : "exists" };
			const now = this.#options.now();
			this.#checkWatch(spec, now);
			if (lifecycle === "enabled") {
				const denied = this.#authorization(id, spec, now);
				if (denied) return denied;
			}
			this.#sql.exec("INSERT INTO pim_triggers (id, revision, lifecycle, health, health_detail, generation, created_at, updated_at) VALUES (?, 1, ?, 'unknown', NULL, 1, ?, ?)", id, lifecycle, now, now);
			this.#sql.exec("INSERT INTO pim_trigger_revisions (trigger_id, revision, spec, created_at) VALUES (?, 1, ?, ?)", id, JSON.stringify(spec), now);
			this.#sql.exec("INSERT INTO pim_trigger_sources (trigger_id, source_revision, gap_pending, updated_at) VALUES (?, 1, 0, ?)", id, now);
			return { ok: true, trigger: this.get(id)! };
		});
	}

	/**
	 * Replaces the spec with a new revision if the trigger is still at
	 * `expectedRevision`. The owning agent and origin chat never change. A
	 * new source or a new condition starts a new generation, so observations
	 * made under the old ones are refused, and the condition starts over. A
	 * new source also gets a new identity and checkpoint, and a computer
	 * source a new `authorizationRef`, which an enabled trigger's host must
	 * accept. The same spec again changes nothing.
	 */
	update(input: { id: string; expectedRevision: number; spec: unknown }): Changed | Refusal {
		const spec = parseTriggerSpec(input.spec);
		return this.#options.transaction((): Changed | Refusal => {
			const current = this.#live(input.id);
			if (!current.ok) return current;
			const trigger = current.trigger;
			if (trigger.revision !== input.expectedRevision) return { ok: false, reason: "revision_mismatch", current: trigger };
			if (trigger.lifecycle === "ended") return { ok: false, reason: "invalid_transition", current: trigger };
			const before = trigger.spec;
			if (spec.owningAgentId !== before.owningAgentId || spec.originChatId !== before.originChatId) return { ok: false, reason: "immutable_field", current: trigger };
			if (JSON.stringify(spec) === JSON.stringify(before)) return { ok: true, trigger };
			const now = this.#options.now();
			const sourceChanged = JSON.stringify(spec.source) !== JSON.stringify(before.source);
			const conditionChanged = JSON.stringify(spec.condition) !== JSON.stringify(before.condition);
			if (sourceChanged) this.#checkWatch(spec, now);
			// A grant covers the source it was given for, not whatever the source becomes: a new command, path or interval needs a new one.
			if (sourceChanged && runsOnComputer(spec.source) && spec.authorizationRef !== null && spec.authorizationRef === before.authorizationRef) {
				return { ok: false, reason: "authorization_required", current: trigger };
			}
			if (trigger.lifecycle === "enabled") {
				const denied = this.#authorization(input.id, spec, now);
				if (denied) return { ...denied, current: trigger };
			}
			const revision = trigger.revision + 1;
			this.#sql.exec("INSERT INTO pim_trigger_revisions (trigger_id, revision, spec, created_at) VALUES (?, ?, ?, ?)", input.id, revision, JSON.stringify(spec), now);
			this.#sql.exec("UPDATE pim_triggers SET revision = ?, updated_at = ? WHERE id = ?", revision, now, input.id);
			if (sourceChanged || conditionChanged) this.#nextGeneration(input.id, now, sourceChanged ? revision : null);
			return { ok: true, trigger: this.get(input.id)! };
		});
	}

	/**
	 * Enables, pauses or ends a trigger. Each change starts a new generation,
	 * so observers of the old one are refused, and is a break in what the
	 * source saw: the condition starts over, and a trigger enabled again
	 * fires only on a true after a known false it sees from then on.
	 * Enabling turns on whatever the current revision says, so it names the
	 * revision it means, and a computer source's grant is checked again.
	 * Pausing and ending are always safe and may leave it out. A paused
	 * trigger keeps its undelivered occurrences for when it is enabled again;
	 * an ended one still hands on what it already took in.
	 */
	setLifecycle(input: { id: string; to: "enabled"; expectedRevision: number } | { id: string; to: "paused" | "ended"; expectedRevision?: number }): Changed | Refusal {
		return this.#options.transaction((): Changed | Refusal => {
			const current = this.#live(input.id);
			if (!current.ok) return current;
			const trigger = current.trigger;
			if (input.expectedRevision !== undefined && trigger.revision !== input.expectedRevision) return { ok: false, reason: "revision_mismatch", current: trigger };
			if (!TRANSITIONS[input.to].includes(trigger.lifecycle)) return { ok: false, reason: "invalid_transition", current: trigger };
			const now = this.#options.now();
			if (input.to === "enabled") {
				const denied = this.#authorization(input.id, trigger.spec, now);
				if (denied) return { ...denied, current: trigger };
			}
			this.#sql.exec("UPDATE pim_triggers SET lifecycle = ?, updated_at = ? WHERE id = ?", input.to, now, input.id);
			this.#nextGeneration(input.id, now, null);
			return { ok: true, trigger: this.get(input.id)! };
		});
	}

	/**
	 * Deletes a trigger: it stops, for good. Occurrences no attempt has
	 * claimed are cancelled. One with an attempt under way may already have
	 * been handed on, so it is not called cancelled: its outcome is unknown,
	 * the attempt can no longer settle it, and `reconcile` records what
	 * happened once that is known. Deleting asks for a stop; it doesn't undo
	 * or cancel anything already handed on. Its id, and anything its
	 * observers send later, are refused. Its revisions and occurrences stay,
	 * as the record of what it did, until `eraseAll`. Its source state and
	 * inbox, which only served taking in events, go.
	 */
	remove(input: { id: string; expectedRevision?: number }): { ok: true } | Refusal {
		return this.#options.transaction((): { ok: true } | Refusal => {
			const current = this.#live(input.id);
			if (!current.ok) return current;
			if (input.expectedRevision !== undefined && current.trigger.revision !== input.expectedRevision) return { ok: false, reason: "revision_mismatch", current: current.trigger };
			const now = this.#options.now();
			const generation = current.trigger.generation + 1;
			this.#sql.exec("UPDATE pim_triggers SET lifecycle = 'deleted', generation = ?, health = 'unknown', health_detail = NULL, updated_at = ? WHERE id = ?", generation, now, input.id);
			this.#sql.exec("INSERT INTO pim_trigger_tombstones (trigger_id, generation, deleted_at) VALUES (?, ?, ?)", input.id, generation, now);
			const unsettled = this.#sql.exec("SELECT id, status FROM pim_trigger_outbox WHERE trigger_id = ? AND status IN ('pending', 'leased')", input.id).toArray();
			for (const item of unsettled) {
				if (item.status === "pending") this.#settle(String(item.id), "cancelled", "cancelled", now);
				else this.#settle(String(item.id), "outcome_unknown", "outcome_unknown", now);
			}
			this.#sql.exec("DELETE FROM pim_trigger_sources WHERE trigger_id = ?", input.id);
			this.#sql.exec("DELETE FROM pim_trigger_inbox WHERE trigger_id = ?", input.id);
			return { ok: true };
		});
	}

	/** Erases every trigger of the space and everything they recorded, tombstones included: for erasing the space, not for deleting one trigger. */
	eraseAll(): void {
		this.#options.transaction(() => {
			for (const table of TRIGGER_TABLES) this.#sql.exec(`DELETE FROM ${table}`);
		});
	}

	/** Records how the source is doing, as its observer of `generation` sees it. */
	setHealth(input: { id: string; generation: number; health: TriggerHealth; detail?: string | null }): { ok: boolean } {
		const health = oneOf(input.health, "health", TRIGGER_HEALTHS);
		const detail = input.detail === undefined || input.detail === null ? null : text(input.detail, "detail", ADMISSION_LIMITS.healthDetailLength, { multiline: true });
		const written = this.#sql.exec(
			"UPDATE pim_triggers SET health = ?, health_detail = ?, updated_at = ? WHERE id = ? AND generation = ? AND lifecycle != 'deleted'",
			health,
			detail,
			this.#options.now(),
			input.id,
			input.generation,
		).rowsWritten;
		return { ok: written > 0 };
	}

	// Sources

	sourceState(id: string): SourceState | undefined {
		const row = this.#sql.exec("SELECT * FROM pim_trigger_sources WHERE trigger_id = ?", id).toArray()[0];
		if (!row) return undefined;
		return {
			sourceRevision: Number(row.source_revision),
			identity: identity(id, Number(row.source_revision)),
			position: row.position === null ? null : Number(row.position),
			cursor: row.cursor === null ? null : String(row.cursor),
			lastObservedAt: row.last_observed_at === null ? null : Number(row.last_observed_at),
			gapPending: Number(row.gap_pending) === 1,
			conditionState: row.condition_state === null ? null : (JSON.parse(String(row.condition_state)) as ConditionState),
		};
	}

	/** Marks that the source may have missed observations, such as while the computer was away: the next one starts continuity again. */
	recordGap(input: { id: string; generation: number }): { ok: boolean } {
		return this.#options.transaction(() => {
			const trigger = this.get(input.id);
			if (!trigger || trigger.lifecycle === "deleted" || trigger.generation !== input.generation) return { ok: false };
			this.#sql.exec("UPDATE pim_trigger_sources SET gap_pending = 1, updated_at = ? WHERE trigger_id = ?", this.#options.now(), input.id);
			return { ok: true };
		});
	}

	/**
	 * Takes in one observation or event from the observer of `generation`, in
	 * one transaction: the inbox entry, the checkpoint, the condition's state,
	 * and the occurrence with its outbox item if it fires. Anything refused
	 * writes nothing, so the source may send it again.
	 *
	 * - An event id is taken once per source identity (`duplicate`) within
	 *   the replay horizon; anything observed before the horizon is refused
	 *   (`too_old`). `observedAt` must be the event's own time, the same on
	 *   every delivery of it.
	 * - Past the inbox cap within the horizon, admissions are refused
	 *   (`inbox_full`), never let in by forgetting ids still in the horizon.
	 * - The checkpoint moves only to a higher `position`.
	 * - A source that reports a state refuses an observation no newer than
	 *   the last one (`out_of_order`); events are taken in any order.
	 * - Events wait in a bounded queue: past `maxPendingEvents` undelivered
	 *   occurrences, an event is refused (`backpressure`), never dropped or
	 *   merged. A state keeps one pending snapshot: a newer occurrence
	 *   supersedes an undelivered older one, which is marked so.
	 * - A process source takes one event, its exit, and then ends.
	 */
	admit(input: { id: string; generation: number; eventId: string; observedAt: number; payload: unknown; checkpoint?: { position: number; cursor: string | null }; gap?: boolean }): Admission {
		const now = this.#options.now();
		const eventId = text(input.eventId, "eventId", ADMISSION_LIMITS.eventIdLength);
		const observedAt = integer(input.observedAt, "observedAt", 0, now + ADMISSION_LIMITS.futureSkewMs);
		const payload = json(input.payload, "payload", ADMISSION_LIMITS.payload);
		const checkpoint =
			input.checkpoint === undefined
				? undefined
				: {
						position: integer(input.checkpoint.position, "checkpoint.position", 0, Number.MAX_SAFE_INTEGER),
						cursor: input.checkpoint.cursor === null ? null : text(input.checkpoint.cursor, "checkpoint.cursor", ADMISSION_LIMITS.cursorLength),
					};
		return this.#options.transaction((): Admission => {
			const guard = this.#guard(input.id, input.generation);
			if ("status" in guard) return guard;
			const { trigger, source } = guard;
			const spec = trigger.spec;
			const mode = conditionMode(spec.source);
			if (mode === null) return { status: "wrong_source" };
			if (spec.source.kind === "process" && now > spec.source.expiresAt) return { status: "expired" };
			if (observedAt < now - this.#retention.dedupHorizonMs) return { status: "too_old" };
			this.#forget(input.id, now);
			const key = `event:${source.identity}:${eventId}`;
			if (this.#sql.exec("SELECT 1 FROM pim_trigger_inbox WHERE source = ? AND event_id = ?", source.identity, eventId).toArray().length > 0) return { status: "duplicate" };
			if (this.#sql.exec("SELECT 1 FROM pim_trigger_occurrences WHERE trigger_id = ? AND occurrence_key = ?", input.id, key).toArray().length > 0) return { status: "duplicate" };
			if (mode === "edge" && source.lastObservedAt !== null && observedAt <= source.lastObservedAt) return { status: "out_of_order" };
			if (Number(this.#sql.exec("SELECT COUNT(*) AS n FROM pim_trigger_inbox WHERE trigger_id = ?", input.id).one().n) >= this.#retention.inboxCap) return { status: "inbox_full" };
			const condition = spec.condition;
			const gap = input.gap === true || source.gapPending;
			const evaluation = condition === null ? null : evaluate(condition, mode, source.conditionState, { value: payload, observedAt, gap }, now);
			const truth: Truth = evaluation?.truth ?? "true";
			const fires = evaluation === null ? true : evaluation.fire;
			let occurrence: Occurrence | null = null;
			let superseded: string[] = [];
			if (fires) {
				if (mode === "filter") {
					const pending = Number(this.#sql.exec("SELECT COUNT(*) AS n FROM pim_trigger_outbox WHERE trigger_id = ? AND status = 'pending'", input.id).one().n);
					if (pending >= (spec.delivery.maxPendingEvents ?? 1)) return { status: "backpressure" };
				} else {
					superseded = this.#supersede(input.id, now);
				}
				const evidence: Evidence = { reason: condition === null ? "event" : "condition", truth, observedAt, fields: fieldsOf(condition, payload) };
				occurrence = this.#occur(trigger, key, "pending", evidence, observedAt, now);
			}
			this.#sql.exec(
				"INSERT INTO pim_trigger_inbox (source, event_id, trigger_id, generation, outcome, received_at) VALUES (?, ?, ?, ?, ?, ?)",
				source.identity,
				eventId,
				input.id,
				input.generation,
				fires ? "fired" : evaluation?.stale ? "stale" : `not_fired:${truth}`,
				now,
			);
			const advance = checkpoint !== undefined && (source.position === null || checkpoint.position > source.position);
			this.#sql.exec(
				"UPDATE pim_trigger_sources SET position = ?, cursor = ?, last_observed_at = ?, gap_pending = ?, condition_state = ?, updated_at = ? WHERE trigger_id = ?",
				advance ? checkpoint.position : source.position,
				advance ? checkpoint.cursor : source.cursor,
				Math.max(observedAt, source.lastObservedAt ?? observedAt),
				// A stale observation is a gap; any other observation an edge condition evaluated has taken up the pending one.
				evaluation?.stale ? 1 : mode === "edge" ? 0 : source.gapPending ? 1 : 0,
				evaluation === null || mode === "filter" ? (source.conditionState === null ? null : JSON.stringify(source.conditionState)) : JSON.stringify(evaluation.state),
				now,
				input.id,
			);
			if (spec.source.kind === "process") {
				this.#sql.exec("UPDATE pim_triggers SET lifecycle = 'ended', updated_at = ? WHERE id = ?", now, input.id);
				this.#nextGeneration(input.id, now, null);
			}
			this.#prune(input.id, now);
			return { status: "accepted", truth, stale: evaluation?.stale ?? false, occurrence, superseded };
		});
	}

	/**
	 * Takes in a time trigger's firing for `scheduledFor`, as its scheduler of
	 * `generation` computed it. A firing later than the source allows is
	 * recorded as `missed`, with nothing to hand on. A one-time trigger ends
	 * with its firing, run or missed. A recurring trigger refuses a firing no
	 * later than one it already took (`out_of_order`), so only its latest due
	 * firing runs; the scheduler, not this store, works out which instants a
	 * cron expression names in its time zone.
	 */
	admitTimeFiring(input: { id: string; generation: number; scheduledFor: number }): Admission {
		const scheduledFor = integer(input.scheduledFor, "scheduledFor", 0, Number.MAX_SAFE_INTEGER);
		return this.#options.transaction((): Admission => {
			const guard = this.#guard(input.id, input.generation);
			if ("status" in guard) return guard;
			const { trigger, source } = guard;
			const time = trigger.spec.source;
			if (time.kind !== "time") return { status: "wrong_source" };
			if (time.schedule === "once" && scheduledFor !== time.at) return { status: "schedule_mismatch" };
			if (time.schedule === "interval" && (scheduledFor < time.anchorAt || (scheduledFor - time.anchorAt) % time.everyMs !== 0)) return { status: "schedule_mismatch" };
			const now = this.#options.now();
			if (scheduledFor > now) return { status: "not_due" };
			const key = `time:${scheduledFor}`;
			if (this.#sql.exec("SELECT 1 FROM pim_trigger_occurrences WHERE trigger_id = ? AND occurrence_key = ?", input.id, key).toArray().length > 0) return { status: "duplicate" };
			if (source.lastObservedAt !== null && scheduledFor <= source.lastObservedAt) return { status: "out_of_order" };
			const late = now - scheduledFor > (time.schedule === "once" ? time.maxLatenessMs : time.catchUpMs);
			const superseded = late ? [] : this.#supersede(input.id, now);
			const occurrence = this.#occur(trigger, key, late ? "missed" : "pending", { reason: "time", scheduledFor }, scheduledFor, now);
			this.#sql.exec("UPDATE pim_trigger_sources SET last_observed_at = ?, updated_at = ? WHERE trigger_id = ?", scheduledFor, now, input.id);
			if (time.schedule === "once") {
				this.#sql.exec("UPDATE pim_triggers SET lifecycle = 'ended', updated_at = ? WHERE id = ?", now, input.id);
				this.#nextGeneration(input.id, now, null);
			}
			this.#prune(input.id, now);
			return { status: "accepted", truth: "true", stale: false, occurrence, superseded };
		});
	}

	// Occurrences and the outbox

	occurrences(id: string): Occurrence[] {
		return this.#sql.exec("SELECT * FROM pim_trigger_occurrences WHERE trigger_id = ? ORDER BY created_at, rowid", id).toArray().map(occurrenceOf);
	}

	outbox(id: string): OutboxItem[] {
		return this.#sql.exec("SELECT * FROM pim_trigger_outbox WHERE trigger_id = ? ORDER BY seq", id).toArray().map(outboxOf);
	}

	/**
	 * Claims the next attempt at handing on an occurrence, for `leaseMs`: the
	 * oldest unsettled item of a trigger that is enabled or ended, when it is
	 * ready (or its lease ran out) and no older item of the same trigger is
	 * unsettled. So each trigger has at most one attempt under way, and hands
	 * on its occurrences in order. Each claim is a new attempt with the same
	 * operation id. An item whose leases ran out `maxAttempts` times is not
	 * tried again: its outcome is unknown until `reconcile` settles it.
	 */
	claim(input: { leaseMs: number }): Delivery | undefined {
		const leaseMs = integer(input.leaseMs, "leaseMs", 1_000, ADMISSION_LIMITS.maxLeaseMs);
		return this.#options.transaction(() => {
			const now = this.#options.now();
			for (;;) {
				const row = this.#sql
					.exec(
						`SELECT o.* FROM pim_trigger_outbox o JOIN pim_triggers t ON t.id = o.trigger_id
						WHERE t.lifecycle IN ('enabled', 'ended')
						AND o.seq = (SELECT MIN(h.seq) FROM pim_trigger_outbox h WHERE h.trigger_id = o.trigger_id AND h.status IN ('pending', 'leased'))
						AND ((o.status = 'pending' AND o.available_at <= ?) OR (o.status = 'leased' AND o.lease_until <= ?))
						ORDER BY o.available_at, o.seq LIMIT 1`,
						now,
						now,
					)
					.toArray()[0];
				if (!row) return undefined;
				const id = String(row.id);
				if (Number(row.attempts) >= ADMISSION_LIMITS.maxAttempts) {
					this.#settle(id, "outcome_unknown", "outcome_unknown", now);
					continue;
				}
				const attempt = Number(row.attempts) + 1;
				this.#sql.exec("UPDATE pim_trigger_outbox SET status = 'leased', attempts = ?, lease_until = ?, updated_at = ? WHERE id = ?", attempt, now + leaseMs, now, id);
				const item = outboxOf(this.#sql.exec("SELECT * FROM pim_trigger_outbox WHERE id = ?", id).one());
				const occurrence = occurrenceOf(this.#sql.exec("SELECT * FROM pim_trigger_occurrences WHERE id = ?", item.occurrenceId).one());
				const spec = this.revision(item.triggerId, occurrence.revision)!;
				return { item, occurrence, spec, attempt };
			}
		});
	}

	/**
	 * Records that the attempt handed the occurrence on: the submission was
	 * accepted. It says nothing of the run that follows, which may still be
	 * going or fail. Only the attempt that still holds the item counts: after
	 * a later claim, or a deletion, this is a no-op.
	 */
	complete(input: { outboxId: string; attempt: number }): { ok: boolean } {
		return this.#options.transaction(() => {
			const item = this.#leased(input.outboxId, input.attempt);
			if (!item) return { ok: false };
			const now = this.#options.now();
			this.#settle(item.id, "done", "delivered", now);
			this.#prune(item.triggerId, now);
			return { ok: true };
		});
	}

	/**
	 * Records a failed attempt that is known not to have handed the
	 * occurrence on: tried again, with the same operation id, from `retryAt`,
	 * or failed for good when `retryAt` is null or the attempts are used up.
	 */
	fail(input: { outboxId: string; attempt: number; retryAt: number | null; error: string }): { ok: boolean; retrying: boolean } {
		const error = text(input.error, "error", ADMISSION_LIMITS.errorLength, { multiline: true });
		const retryAt = input.retryAt === null ? null : integer(input.retryAt, "retryAt", 0, Number.MAX_SAFE_INTEGER);
		return this.#options.transaction(() => {
			const item = this.#leased(input.outboxId, input.attempt);
			if (!item) return { ok: false, retrying: false };
			const now = this.#options.now();
			const retrying = retryAt !== null && item.attempts < ADMISSION_LIMITS.maxAttempts;
			this.#sql.exec("UPDATE pim_trigger_outbox SET last_error = ? WHERE id = ?", error, item.id);
			if (retrying) {
				this.#sql.exec("UPDATE pim_trigger_outbox SET status = 'pending', available_at = ?, lease_until = NULL, updated_at = ? WHERE id = ?", Math.max(retryAt, now), now, item.id);
			} else {
				this.#settle(item.id, "failed", "failed", now);
				this.#prune(item.triggerId, now);
			}
			return { ok: true, retrying };
		});
	}

	/**
	 * Settles an item whose outcome was unknown, once the deliverer has found
	 * out (such as from the operation id's record). It works for a deleted
	 * trigger's items too, and records only what happened: it never claims
	 * anything or brings the trigger back.
	 */
	reconcile(input: { outboxId: string; outcome: "delivered" | "failed" }): { ok: boolean } {
		return this.#options.transaction(() => {
			const row = this.#sql.exec("SELECT trigger_id FROM pim_trigger_outbox WHERE id = ? AND status = 'outcome_unknown'", input.outboxId).toArray()[0];
			if (!row) return { ok: false };
			const now = this.#options.now();
			this.#settle(input.outboxId, input.outcome === "delivered" ? "done" : "failed", input.outcome, now);
			this.#prune(String(row.trigger_id), now);
			return { ok: true };
		});
	}

	// Helpers, each inside a caller's transaction

	#triggerOf(row: Row): Trigger {
		const id = String(row.id);
		const revision = Number(row.revision);
		return {
			id,
			revision,
			spec: this.revision(id, revision)!,
			lifecycle: String(row.lifecycle) as TriggerLifecycle,
			health: String(row.health) as TriggerHealth,
			healthDetail: row.health_detail === null ? null : String(row.health_detail),
			generation: Number(row.generation),
			createdAt: Number(row.created_at),
			updatedAt: Number(row.updated_at),
		};
	}

	#live(id: string): Changed | Refusal {
		const trigger = this.get(id);
		if (!trigger) return { ok: false, reason: "not_found" };
		return trigger.lifecycle === "deleted" ? { ok: false, reason: "deleted" } : { ok: true, trigger };
	}

	/** Null when `spec` may run; else why not. A computer source needs a reference the host's check accepts, and with no check, none is accepted. */
	#authorization(id: string, spec: TriggerSpec, now: number): Refusal | null {
		if (!runsOnComputer(spec.source)) return null;
		if (spec.authorizationRef === null) return { ok: false, reason: "authorization_required" };
		const verdict = this.#options.authorize?.({ triggerId: id, spec, authorizationRef: spec.authorizationRef, now }) ?? { ok: false, reason: "no authorization check is configured" };
		return verdict.ok ? null : { ok: false, reason: "authorization_denied", detail: verdict.reason };
	}

	/** A process is watched for a bounded time from now. */
	#checkWatch(spec: TriggerSpec, now: number): void {
		if (spec.source.kind !== "process") return;
		if (spec.source.expiresAt <= now || spec.source.expiresAt > now + TRIGGER_LIMITS.maxProcessWatchMs) {
			throw new TriggerValidationError("spec.source.expiresAt", "must be in the future, and at most 7 days from now");
		}
	}

	/**
	 * Starts a new generation: observers of the old one are refused, and the
	 * condition starts over, as after a gap. With `sourceRevision`, the source
	 * is new as well: a new identity, and no checkpoint.
	 */
	#nextGeneration(id: string, now: number, sourceRevision: number | null): void {
		this.#sql.exec("UPDATE pim_triggers SET generation = generation + 1, health = 'unknown', health_detail = NULL, updated_at = ? WHERE id = ?", now, id);
		if (sourceRevision === null) {
			this.#sql.exec("UPDATE pim_trigger_sources SET gap_pending = 0, condition_state = NULL, updated_at = ? WHERE trigger_id = ?", now, id);
		} else {
			this.#sql.exec(
				"UPDATE pim_trigger_sources SET source_revision = ?, position = NULL, cursor = NULL, last_observed_at = NULL, gap_pending = 0, condition_state = NULL, updated_at = ? WHERE trigger_id = ?",
				sourceRevision,
				now,
				id,
			);
		}
	}

	/** The checks every admission starts with, in order: the trigger exists, isn't deleted, the generation is current, and it is enabled. */
	#guard(id: string, generation: number): { trigger: Trigger; source: SourceState } | AdmissionRefusal {
		const trigger = this.get(id);
		if (!trigger) return { status: "not_found" };
		if (trigger.lifecycle === "deleted") return { status: "deleted" };
		if (trigger.generation !== generation) return { status: "stale_generation" };
		if (trigger.lifecycle !== "enabled") return { status: "not_enabled" };
		return { trigger, source: this.sourceState(id)! };
	}

	#occur(trigger: Trigger, key: string, status: "pending" | "missed", evidence: Evidence, dueAt: number, now: number): Occurrence {
		const id = this.#id();
		this.#sql.exec(
			"INSERT INTO pim_trigger_occurrences (id, trigger_id, occurrence_key, revision, generation, status, evidence, due_at, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
			id,
			trigger.id,
			key,
			trigger.revision,
			trigger.generation,
			status,
			JSON.stringify(evidence),
			dueAt,
			now,
			now,
		);
		if (status === "pending") {
			const seq = Number(this.#sql.exec("SELECT COALESCE(MAX(seq), 0) + 1 AS seq FROM pim_trigger_outbox").one().seq);
			this.#sql.exec(
				"INSERT INTO pim_trigger_outbox (id, seq, occurrence_id, trigger_id, operation_id, status, attempts, available_at, lease_until, last_error, created_at, updated_at) VALUES (?, ?, ?, ?, ?, 'pending', 0, ?, NULL, NULL, ?, ?)",
				this.#id(),
				seq,
				id,
				trigger.id,
				`trigger:${trigger.id}:${id}`,
				now,
				now,
				now,
			);
		}
		return occurrenceOf(this.#sql.exec("SELECT * FROM pim_trigger_occurrences WHERE id = ?", id).one());
	}

	/** Marks a trigger's undelivered, unclaimed occurrence superseded; an attempt under way is left to finish. */
	#supersede(id: string, now: number): string[] {
		const replaced = this.#sql
			.exec("SELECT id FROM pim_trigger_outbox WHERE trigger_id = ? AND status = 'pending'", id)
			.toArray()
			.map((row) => String(row.id));
		return replaced.map((item) => this.#settle(item, "superseded", "superseded", now));
	}

	/** Gives an outbox item and its occurrence their final statuses; returns the occurrence's id. */
	#settle(outboxId: string, item: OutboxStatus, occurrence: OccurrenceStatus, now: number): string {
		const occurrenceId = String(this.#sql.exec("SELECT occurrence_id FROM pim_trigger_outbox WHERE id = ?", outboxId).one().occurrence_id);
		this.#sql.exec("UPDATE pim_trigger_outbox SET status = ?, lease_until = NULL, updated_at = ? WHERE id = ?", item, now, outboxId);
		this.#sql.exec("UPDATE pim_trigger_occurrences SET status = ?, updated_at = ? WHERE id = ?", occurrence, now, occurrenceId);
		return occurrenceId;
	}

	#leased(outboxId: string, attempt: number): OutboxItem | undefined {
		const row = this.#sql.exec("SELECT * FROM pim_trigger_outbox WHERE id = ? AND status = 'leased' AND attempts = ?", outboxId, attempt).toArray()[0];
		return row ? outboxOf(row) : undefined;
	}

	/**
	 * Forgets a trigger's event ids from before the replay horizon, with a
	 * margin for observation times ahead of the clock, so no id an
	 * admission could still be a replay of is forgotten.
	 */
	#forget(id: string, now: number): void {
		this.#sql.exec("DELETE FROM pim_trigger_inbox WHERE trigger_id = ? AND received_at < ?", id, now - this.#retention.dedupHorizonMs - ADMISSION_LIMITS.futureSkewMs);
	}

	/**
	 * Of a trigger's settled occurrences from before the replay horizon,
	 * keeps the newest `retention.occurrences`. Nothing within the horizon,
	 * and nothing unsettled, goes.
	 */
	#prune(id: string, now: number): void {
		const old = this.#sql
			.exec(
				"SELECT id FROM pim_trigger_occurrences WHERE trigger_id = ? AND status NOT IN ('pending', 'outcome_unknown') AND updated_at < ? ORDER BY updated_at DESC, rowid DESC LIMIT -1 OFFSET ?",
				id,
				now - this.#retention.dedupHorizonMs - ADMISSION_LIMITS.futureSkewMs,
				this.#retention.occurrences,
			)
			.toArray()
			.map((row) => String(row.id));
		for (const occurrence of old) {
			this.#sql.exec("DELETE FROM pim_trigger_outbox WHERE occurrence_id = ?", occurrence);
			this.#sql.exec("DELETE FROM pim_trigger_occurrences WHERE id = ?", occurrence);
		}
	}
}

/** A source's identity for taking in events: the trigger, and the revision its source was set in. */
function identity(id: string, sourceRevision: number): string {
	return `${id}#${sourceRevision}`;
}

/** Which fields the condition read were there: their paths, never their values. */
function fieldsOf(condition: Condition | null, payload: JsonValue): { path: string[]; present: boolean }[] {
	if (condition === null) return [];
	return referencedPaths(condition.when).map((path) => {
		const found = lookup(payload, path);
		return { path: [...path], present: found !== undefined && found !== null };
	});
}

function occurrenceOf(row: Row): Occurrence {
	return {
		id: String(row.id),
		triggerId: String(row.trigger_id),
		key: String(row.occurrence_key),
		revision: Number(row.revision),
		generation: Number(row.generation),
		status: String(row.status) as OccurrenceStatus,
		evidence: JSON.parse(String(row.evidence)) as Evidence,
		dueAt: Number(row.due_at),
		createdAt: Number(row.created_at),
		updatedAt: Number(row.updated_at),
	};
}

function outboxOf(row: Row): OutboxItem {
	return {
		id: String(row.id),
		occurrenceId: String(row.occurrence_id),
		triggerId: String(row.trigger_id),
		operationId: String(row.operation_id),
		status: String(row.status) as OutboxStatus,
		attempts: Number(row.attempts),
		availableAt: Number(row.available_at),
		leaseUntil: row.lease_until === null ? null : Number(row.lease_until),
		lastError: row.last_error === null ? null : String(row.last_error),
		createdAt: Number(row.created_at),
		updatedAt: Number(row.updated_at),
	};
}
