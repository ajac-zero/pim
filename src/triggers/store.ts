/**
 * Triggers' durable state, in a space's SQLite database: each trigger with
 * its immutable revisions, its source's checkpoint and condition state, the
 * events it has taken in, its occurrences, the outbox that delivers them,
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
 * delivery one run; nothing here makes an outside effect happen exactly once.
 */

import { type Condition, type ConditionState, type Truth, evaluate, lookup, referencedPaths } from "./condition";
import { type TriggerHealth, type TriggerLifecycle, type TriggerSpec, TRIGGER_HEALTHS, conditionMode, parseTriggerSpec, runsOnComputer } from "./spec";
import { type JsonValue, integer, json, oneOf, opaqueId, text } from "./validate";

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

/** Every table this store keeps, for erasing a space and for listing what it holds. */
export const TRIGGER_TABLES = ["pim_triggers", "pim_trigger_revisions", "pim_trigger_sources", "pim_trigger_inbox", "pim_trigger_occurrences", "pim_trigger_outbox", "pim_trigger_tombstones"] as const;

export const ADMISSION_LIMITS = {
	eventIdLength: 256,
	cursorLength: 1_024,
	payload: { maxBytes: 16_384, maxDepth: 8 },
	errorLength: 1_000,
	healthDetailLength: 500,
	/** How far ahead of the store's clock an observation's time may be. */
	futureSkewMs: 5 * 60_000,
	maxLeaseMs: 60 * 60_000,
	/** Attempts at delivering one occurrence before it fails for good. */
	maxAttempts: 5,
} as const;

export type Trigger = {
	readonly id: string;
	readonly revision: number;
	readonly spec: TriggerSpec;
	readonly lifecycle: Exclude<TriggerLifecycle, "deleted">;
	readonly health: TriggerHealth;
	readonly healthDetail: string | null;
	/**
	 * Which run of the source's observers is current. It goes up with every
	 * lifecycle change and every change of source, and an observation from
	 * any other generation is refused.
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

export type OccurrenceStatus = "pending" | "delivered" | "failed" | "superseded" | "missed";

export type Occurrence = {
	readonly id: string;
	readonly triggerId: string;
	/** Unique per trigger: `event:<eventId>` or `time:<scheduledFor>`. */
	readonly key: string;
	/** The spec revision it happened under, and is delivered with. */
	readonly revision: number;
	readonly generation: number;
	readonly status: OccurrenceStatus;
	readonly evidence: JsonValue | null;
	/** When it happened: the observation's time, or the time it was scheduled for. */
	readonly dueAt: number;
	readonly createdAt: number;
	readonly updatedAt: number;
};

export type OutboxStatus = "pending" | "leased" | "done" | "failed" | "superseded";

export type OutboxItem = {
	readonly id: string;
	readonly occurrenceId: string;
	readonly triggerId: string;
	/** The same for every attempt: what a deliverer passes on so a retried delivery is one run. */
	readonly operationId: string;
	readonly status: OutboxStatus;
	readonly attempts: number;
	readonly availableAt: number;
	readonly leaseUntil: number | null;
	readonly lastError: string | null;
	readonly createdAt: number;
	readonly updatedAt: number;
};

/** One claimed delivery: the item, its occurrence, and the spec as it was at the occurrence's revision. */
export type Delivery = { readonly item: OutboxItem; readonly occurrence: Occurrence; readonly spec: TriggerSpec; readonly attempt: number };

export type Refusal = {
	readonly ok: false;
	readonly reason: "not_found" | "deleted" | "exists" | "revision_mismatch" | "invalid_transition" | "authorization_required" | "immutable_field";
	readonly current?: Trigger;
};

export type Changed = { readonly ok: true; readonly trigger: Trigger };

/** Why an observation or firing was not taken in. Nothing was written for any of these. */
export type AdmissionRefusal = {
	readonly status: "not_found" | "deleted" | "stale_generation" | "not_enabled" | "wrong_source" | "duplicate" | "out_of_order" | "backpressure" | "not_due" | "schedule_mismatch";
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
	/** How many inbox entries, and finished occurrences, each trigger keeps; the oldest go first. */
	readonly retention?: { readonly inbox: number; readonly occurrences: number };
};

type Row = Record<string, SqlStorageValue>;

const TRANSITIONS: Record<"enabled" | "paused" | "ended", readonly Trigger["lifecycle"][]> = {
	enabled: ["draft", "paused"],
	paused: ["enabled"],
	ended: ["draft", "enabled", "paused"],
};

export class TriggerStore {
	readonly #sql: SqlStorage;
	readonly #options: TriggerStoreOptions;
	readonly #retention: { inbox: number; occurrences: number };

	constructor(sql: SqlStorage, options: TriggerStoreOptions) {
		this.#sql = sql;
		this.#options = options;
		this.#retention = options.retention ?? { inbox: 1_000, occurrences: 200 };
		this.#sql.exec(SCHEMA);
	}

	#id(): string {
		return this.#options.newId?.() ?? crypto.randomUUID();
	}

	// Triggers and revisions

	get(id: string): Trigger | undefined {
		const row = this.#sql.exec("SELECT * FROM pim_triggers WHERE id = ?", id).toArray()[0];
		return row ? this.#triggerOf(row) : undefined;
	}

	list(): Trigger[] {
		return this.#sql.exec("SELECT * FROM pim_triggers ORDER BY created_at, id").toArray().map((row) => this.#triggerOf(row));
	}

	/** The spec as it was at `revision`. Revisions are never changed. */
	revision(id: string, revision: number): TriggerSpec | undefined {
		const row = this.#sql.exec("SELECT spec FROM pim_trigger_revisions WHERE trigger_id = ? AND revision = ?", id, revision).toArray()[0];
		return row ? (JSON.parse(String(row.spec)) as TriggerSpec) : undefined;
	}

	isDeleted(id: string): boolean {
		return this.#sql.exec("SELECT 1 FROM pim_trigger_tombstones WHERE trigger_id = ?", id).toArray().length > 0;
	}

	/**
	 * Makes a trigger at revision 1, as a draft or enabled. A source that runs
	 * on the person's computer is enabled only with an `authorizationRef`.
	 * An id is never reused, even after the trigger is deleted.
	 */
	create(input: { id?: string; spec: unknown; lifecycle?: "draft" | "enabled" }): Changed | Refusal {
		const spec = parseTriggerSpec(input.spec);
		const id = input.id === undefined ? this.#id() : opaqueId(input.id, "id");
		const lifecycle = input.lifecycle ?? "draft";
		if (lifecycle === "enabled" && !authorized(spec)) return { ok: false, reason: "authorization_required" };
		return this.#options.transaction(() => {
			if (this.isDeleted(id)) return { ok: false, reason: "deleted" } as const;
			if (this.get(id)) return { ok: false, reason: "exists" } as const;
			const now = this.#options.now();
			this.#sql.exec("INSERT INTO pim_triggers (id, revision, lifecycle, health, health_detail, generation, created_at, updated_at) VALUES (?, 1, ?, 'unknown', NULL, 1, ?, ?)", id, lifecycle, now, now);
			this.#sql.exec("INSERT INTO pim_trigger_revisions (trigger_id, revision, spec, created_at) VALUES (?, 1, ?, ?)", id, JSON.stringify(spec), now);
			this.#sql.exec("INSERT INTO pim_trigger_sources (trigger_id, source_revision, gap_pending, updated_at) VALUES (?, 1, 0, ?)", id, now);
			return { ok: true, trigger: this.get(id)! } as const;
		});
	}

	/**
	 * Replaces the spec with a new revision if the trigger is still at
	 * `expectedRevision`. The owning agent and origin chat never change. A new
	 * source starts over: a new generation, identity, checkpoint and condition
	 * state, and a computer source needs a new `authorizationRef`. A new
	 * condition alone resets only the condition's state. The same spec again
	 * changes nothing.
	 */
	update(input: { id: string; expectedRevision: number; spec: unknown }): Changed | Refusal {
		const spec = parseTriggerSpec(input.spec);
		return this.#options.transaction(() => {
			const current = this.#live(input.id);
			if (!current.ok) return current;
			const trigger = current.trigger;
			if (trigger.revision !== input.expectedRevision) return { ok: false, reason: "revision_mismatch", current: trigger } as const;
			if (trigger.lifecycle === "ended") return { ok: false, reason: "invalid_transition", current: trigger } as const;
			const before = trigger.spec;
			if (spec.owningAgentId !== before.owningAgentId || spec.originChatId !== before.originChatId) return { ok: false, reason: "immutable_field", current: trigger } as const;
			if (JSON.stringify(spec) === JSON.stringify(before)) return { ok: true, trigger } as const;
			const sourceChanged = JSON.stringify(spec.source) !== JSON.stringify(before.source);
			// An approval covers the source it was given for, not whatever the source becomes.
			if (sourceChanged && runsOnComputer(spec.source) && spec.authorizationRef !== null && spec.authorizationRef === before.authorizationRef) {
				return { ok: false, reason: "authorization_required", current: trigger } as const;
			}
			if (trigger.lifecycle === "enabled" && !authorized(spec)) return { ok: false, reason: "authorization_required", current: trigger } as const;
			const now = this.#options.now();
			const revision = trigger.revision + 1;
			this.#sql.exec("INSERT INTO pim_trigger_revisions (trigger_id, revision, spec, created_at) VALUES (?, ?, ?, ?)", input.id, revision, JSON.stringify(spec), now);
			if (sourceChanged) {
				this.#sql.exec("UPDATE pim_triggers SET revision = ?, generation = generation + 1, health = 'unknown', health_detail = NULL, updated_at = ? WHERE id = ?", revision, now, input.id);
				this.#sql.exec(
					"UPDATE pim_trigger_sources SET source_revision = ?, position = NULL, cursor = NULL, last_observed_at = NULL, gap_pending = 0, condition_state = NULL, updated_at = ? WHERE trigger_id = ?",
					revision,
					now,
					input.id,
				);
			} else {
				this.#sql.exec("UPDATE pim_triggers SET revision = ?, updated_at = ? WHERE id = ?", revision, now, input.id);
				if (JSON.stringify(spec.condition) !== JSON.stringify(before.condition)) {
					this.#sql.exec("UPDATE pim_trigger_sources SET condition_state = NULL, updated_at = ? WHERE trigger_id = ?", now, input.id);
				}
			}
			return { ok: true, trigger: this.get(input.id)! } as const;
		});
	}

	/**
	 * Enables, pauses or ends a trigger; each change starts a new generation,
	 * so observers of the old one are refused. Enabling turns on whatever the
	 * current revision says, so it names the revision it means; pausing and
	 * ending are always safe and may leave it out. A paused trigger keeps its
	 * undelivered occurrences for when it is enabled again; an ended one
	 * still delivers what it already took in.
	 */
	setLifecycle(input: { id: string; to: "enabled"; expectedRevision: number } | { id: string; to: "paused" | "ended"; expectedRevision?: number }): Changed | Refusal {
		return this.#options.transaction(() => {
			const current = this.#live(input.id);
			if (!current.ok) return current;
			const trigger = current.trigger;
			if (input.expectedRevision !== undefined && trigger.revision !== input.expectedRevision) return { ok: false, reason: "revision_mismatch", current: trigger } as const;
			if (!TRANSITIONS[input.to].includes(trigger.lifecycle)) return { ok: false, reason: "invalid_transition", current: trigger } as const;
			if (input.to === "enabled" && !authorized(trigger.spec)) return { ok: false, reason: "authorization_required", current: trigger } as const;
			this.#sql.exec(
				"UPDATE pim_triggers SET lifecycle = ?, generation = generation + 1, health = 'unknown', health_detail = NULL, updated_at = ? WHERE id = ?",
				input.to,
				this.#options.now(),
				input.id,
			);
			return { ok: true, trigger: this.get(input.id)! } as const;
		});
	}

	/**
	 * Deletes a trigger and everything it recorded, leaving a tombstone: its
	 * id is refused from then on, and so is anything its observers or an
	 * in-flight delivery send later.
	 */
	remove(input: { id: string; expectedRevision?: number }): { ok: true } | Refusal {
		return this.#options.transaction(() => {
			const current = this.#live(input.id);
			if (!current.ok) return current;
			if (input.expectedRevision !== undefined && current.trigger.revision !== input.expectedRevision) return { ok: false, reason: "revision_mismatch", current: current.trigger } as const;
			this.#sql.exec("INSERT INTO pim_trigger_tombstones (trigger_id, generation, deleted_at) VALUES (?, ?, ?)", input.id, current.trigger.generation + 1, this.#options.now());
			for (const table of ["pim_trigger_revisions", "pim_trigger_sources", "pim_trigger_inbox", "pim_trigger_occurrences", "pim_trigger_outbox"]) {
				this.#sql.exec(`DELETE FROM ${table} WHERE trigger_id = ?`, input.id);
			}
			this.#sql.exec("DELETE FROM pim_triggers WHERE id = ?", input.id);
			return { ok: true } as const;
		});
	}

	/** Records how the source is doing, as its observer of `generation` sees it. */
	setHealth(input: { id: string; generation: number; health: TriggerHealth; detail?: string | null }): { ok: boolean } {
		const health = oneOf(input.health, "health", TRIGGER_HEALTHS);
		const detail = input.detail === undefined || input.detail === null ? null : text(input.detail, "detail", ADMISSION_LIMITS.healthDetailLength, { multiline: true });
		const written = this.#sql.exec(
			"UPDATE pim_triggers SET health = ?, health_detail = ?, updated_at = ? WHERE id = ? AND generation = ?",
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
			if (!trigger || trigger.generation !== input.generation) return { ok: false };
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
	 * - An event id is taken once per source identity (`duplicate`).
	 * - The checkpoint moves only to a higher `position`.
	 * - A source that reports a state refuses an observation no newer than
	 *   the last one (`out_of_order`); events are taken in any order.
	 * - Events wait in a bounded queue: past `maxPendingEvents` undelivered
	 *   occurrences, an event is refused (`backpressure`), never dropped or
	 *   merged. A state keeps one pending snapshot: a newer occurrence
	 *   supersedes an undelivered older one, which is marked so.
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
			const mode = conditionMode(trigger.spec.source);
			if (mode === null) return { status: "wrong_source" };
			if (this.#sql.exec("SELECT 1 FROM pim_trigger_inbox WHERE source = ? AND event_id = ?", source.identity, eventId).toArray().length > 0) return { status: "duplicate" };
			if (mode === "edge" && source.lastObservedAt !== null && observedAt <= source.lastObservedAt) return { status: "out_of_order" };
			const condition = trigger.spec.condition;
			const gap = input.gap === true || source.gapPending;
			const evaluation = condition === null ? null : evaluate(condition, mode, source.conditionState, { value: payload, observedAt, gap }, now);
			const truth: Truth = evaluation?.truth ?? "true";
			const fires = evaluation === null ? true : evaluation.fire;
			let occurrence: Occurrence | null = null;
			let superseded: string[] = [];
			if (fires) {
				if (mode === "filter") {
					const pending = Number(this.#sql.exec("SELECT COUNT(*) AS n FROM pim_trigger_outbox WHERE trigger_id = ? AND status = 'pending'", input.id).one().n);
					if (pending >= (trigger.spec.delivery.maxPendingEvents ?? 1)) return { status: "backpressure" };
				} else {
					superseded = this.#supersede(input.id, now);
				}
				const evidence = mode === "filter" || trigger.spec.delivery.rawSamples ? payload : summary(condition!, payload, observedAt);
				occurrence = this.#occur(trigger, `event:${eventId}`, "pending", evidence, observedAt, now);
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
			this.#prune(input.id);
			return { status: "accepted", truth, stale: evaluation?.stale ?? false, occurrence, superseded };
		});
	}

	/**
	 * Takes in a time trigger's firing for `scheduledFor`, as its scheduler of
	 * `generation` computed it. A firing later than the source allows is
	 * recorded as `missed`, with nothing to deliver. A one-time trigger ends
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
			const occurrence = this.#occur(trigger, key, late ? "missed" : "pending", null, scheduledFor, now);
			this.#sql.exec("UPDATE pim_trigger_sources SET last_observed_at = ?, updated_at = ? WHERE trigger_id = ?", scheduledFor, now, input.id);
			if (time.schedule === "once") {
				this.#sql.exec("UPDATE pim_triggers SET lifecycle = 'ended', generation = generation + 1, updated_at = ? WHERE id = ?", now, input.id);
			}
			this.#prune(input.id);
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
	 * Claims the next delivery for `leaseMs`: the oldest undelivered item of
	 * a trigger that is enabled or ended, when it is ready (or its earlier
	 * lease ran out) and no older item of the same trigger is waiting. So
	 * each trigger has at most one delivery under way and delivers in order.
	 * Each claim is a new attempt with the same operation id.
	 */
	claim(input: { leaseMs: number }): Delivery | undefined {
		const leaseMs = integer(input.leaseMs, "leaseMs", 1_000, ADMISSION_LIMITS.maxLeaseMs);
		return this.#options.transaction(() => {
			const now = this.#options.now();
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
			const attempt = Number(row.attempts) + 1;
			this.#sql.exec("UPDATE pim_trigger_outbox SET status = 'leased', attempts = ?, lease_until = ?, updated_at = ? WHERE id = ?", attempt, now + leaseMs, now, String(row.id));
			const item = outboxOf(this.#sql.exec("SELECT * FROM pim_trigger_outbox WHERE id = ?", String(row.id)).one());
			const occurrence = occurrenceOf(this.#sql.exec("SELECT * FROM pim_trigger_occurrences WHERE id = ?", item.occurrenceId).one());
			const spec = this.revision(item.triggerId, occurrence.revision)!;
			return { item, occurrence, spec, attempt };
		});
	}

	/** Records a delivery done, if `attempt` still holds the item: a later claim's attempt, or a deleted trigger, makes this a no-op. */
	complete(input: { outboxId: string; attempt: number }): { ok: boolean } {
		return this.#options.transaction(() => {
			const item = this.#leased(input.outboxId, input.attempt);
			if (!item) return { ok: false };
			const now = this.#options.now();
			this.#sql.exec("UPDATE pim_trigger_outbox SET status = 'done', lease_until = NULL, updated_at = ? WHERE id = ?", now, item.id);
			this.#sql.exec("UPDATE pim_trigger_occurrences SET status = 'delivered', updated_at = ? WHERE id = ?", now, item.occurrenceId);
			this.#prune(item.triggerId);
			return { ok: true };
		});
	}

	/**
	 * Records a failed attempt: tried again, with the same operation id, from
	 * `retryAt`, or failed for good when `retryAt` is null or the attempts
	 * are used up.
	 */
	fail(input: { outboxId: string; attempt: number; retryAt: number | null; error: string }): { ok: boolean; retrying: boolean } {
		const error = text(input.error, "error", ADMISSION_LIMITS.errorLength, { multiline: true });
		const retryAt = input.retryAt === null ? null : integer(input.retryAt, "retryAt", 0, Number.MAX_SAFE_INTEGER);
		return this.#options.transaction(() => {
			const item = this.#leased(input.outboxId, input.attempt);
			if (!item) return { ok: false, retrying: false };
			const now = this.#options.now();
			const retrying = retryAt !== null && item.attempts < ADMISSION_LIMITS.maxAttempts;
			if (retrying) {
				this.#sql.exec("UPDATE pim_trigger_outbox SET status = 'pending', available_at = ?, lease_until = NULL, last_error = ?, updated_at = ? WHERE id = ?", Math.max(retryAt, now), error, now, item.id);
			} else {
				this.#sql.exec("UPDATE pim_trigger_outbox SET status = 'failed', lease_until = NULL, last_error = ?, updated_at = ? WHERE id = ?", error, now, item.id);
				this.#sql.exec("UPDATE pim_trigger_occurrences SET status = 'failed', updated_at = ? WHERE id = ?", now, item.occurrenceId);
				this.#prune(item.triggerId);
			}
			return { ok: true, retrying };
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
			lifecycle: String(row.lifecycle) as Trigger["lifecycle"],
			health: String(row.health) as TriggerHealth,
			healthDetail: row.health_detail === null ? null : String(row.health_detail),
			generation: Number(row.generation),
			createdAt: Number(row.created_at),
			updatedAt: Number(row.updated_at),
		};
	}

	#live(id: string): Changed | Refusal {
		if (this.isDeleted(id)) return { ok: false, reason: "deleted" };
		const trigger = this.get(id);
		return trigger ? { ok: true, trigger } : { ok: false, reason: "not_found" };
	}

	/** The checks every admission starts with, in order: the trigger exists, the generation is current, and it is enabled. */
	#guard(id: string, generation: number): { trigger: Trigger; source: SourceState } | AdmissionRefusal {
		if (this.isDeleted(id)) return { status: "deleted" };
		const trigger = this.get(id);
		if (!trigger) return { status: "not_found" };
		if (trigger.generation !== generation) return { status: "stale_generation" };
		if (trigger.lifecycle !== "enabled") return { status: "not_enabled" };
		return { trigger, source: this.sourceState(id)! };
	}

	#occur(trigger: Trigger, key: string, status: "pending" | "missed", evidence: JsonValue | null, dueAt: number, now: number): Occurrence {
		const id = this.#id();
		this.#sql.exec(
			"INSERT INTO pim_trigger_occurrences (id, trigger_id, occurrence_key, revision, generation, status, evidence, due_at, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
			id,
			trigger.id,
			key,
			trigger.revision,
			trigger.generation,
			status,
			evidence === null ? null : JSON.stringify(evidence),
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

	/** Marks a trigger's undelivered, unclaimed occurrence superseded; a delivery under way is left to finish. */
	#supersede(id: string, now: number): string[] {
		const replaced = this.#sql
			.exec("SELECT occurrence_id FROM pim_trigger_outbox WHERE trigger_id = ? AND status = 'pending'", id)
			.toArray()
			.map((row) => String(row.occurrence_id));
		for (const occurrence of replaced) {
			this.#sql.exec("UPDATE pim_trigger_outbox SET status = 'superseded', updated_at = ? WHERE occurrence_id = ?", now, occurrence);
			this.#sql.exec("UPDATE pim_trigger_occurrences SET status = 'superseded', updated_at = ? WHERE id = ?", now, occurrence);
		}
		return replaced;
	}

	#leased(outboxId: string, attempt: number): OutboxItem | undefined {
		const row = this.#sql.exec("SELECT * FROM pim_trigger_outbox WHERE id = ? AND status = 'leased' AND attempts = ?", outboxId, attempt).toArray()[0];
		return row ? outboxOf(row) : undefined;
	}

	/** Keeps the newest inbox entries and finished occurrences of a trigger, within `retention`. */
	#prune(id: string): void {
		this.#sql.exec(
			"DELETE FROM pim_trigger_inbox WHERE trigger_id = ? AND rowid NOT IN (SELECT rowid FROM pim_trigger_inbox WHERE trigger_id = ? ORDER BY received_at DESC, rowid DESC LIMIT ?)",
			id,
			id,
			this.#retention.inbox,
		);
		const finished = this.#sql
			.exec(
				"SELECT id FROM pim_trigger_occurrences WHERE trigger_id = ? AND status NOT IN ('pending') ORDER BY updated_at DESC, rowid DESC LIMIT -1 OFFSET ?",
				id,
				this.#retention.occurrences,
			)
			.toArray()
			.map((row) => String(row.id));
		for (const occurrence of finished) {
			this.#sql.exec("DELETE FROM pim_trigger_outbox WHERE occurrence_id = ?", occurrence);
			this.#sql.exec("DELETE FROM pim_trigger_occurrences WHERE id = ?", occurrence);
		}
	}
}

/** Whether a spec may be enabled: a source on the person's computer needs an authorization. */
function authorized(spec: TriggerSpec): boolean {
	return !runsOnComputer(spec.source) || spec.authorizationRef !== null;
}

/** A source's identity for taking in events: the trigger, and the revision its source was set in. */
function identity(id: string, sourceRevision: number): string {
	return `${id}#${sourceRevision}`;
}

/** What an occurrence of a state keeps without raw samples: the fields its condition read, and when. */
function summary(condition: Condition, payload: JsonValue, observedAt: number): JsonValue {
	return {
		observedAt,
		fields: referencedPaths(condition.when).map((path) => {
			const found = lookup(payload, path);
			const value = typeof found === "string" ? found.slice(0, 256) : typeof found === "number" || typeof found === "boolean" ? found : null;
			return { path: [...path], value };
		}),
	};
}

function occurrenceOf(row: Row): Occurrence {
	return {
		id: String(row.id),
		triggerId: String(row.trigger_id),
		key: String(row.occurrence_key),
		revision: Number(row.revision),
		generation: Number(row.generation),
		status: String(row.status) as OccurrenceStatus,
		evidence: row.evidence === null ? null : (JSON.parse(String(row.evidence)) as JsonValue),
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

