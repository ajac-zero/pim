/**
 * The public contract of a space's triggers: what agents' tools (./tools.ts)
 * and the space's HTTP routes (`/triggers`, `/trigger-runs` in ../pim.ts)
 * call, so a later screen and the agents read and change triggers the same
 * way. It sits over the engine (./engine.ts) and exists only where the
 * engine does, in a person's own space, never a guest's. Elsewhere Pim
 * builds none of it, its routes answer as
 * any unknown path, and no agent is offered its tools. See docs/triggers.md,
 * "The API".
 *
 * Who may do what is decided here, the same for both paths. The person may
 * read and change every trigger of their space. An agent sees and changes
 * only triggers it owns; the majordomo, every trigger, and only it makes
 * triggers for other agents, which then start new chats, as schedules do.
 * Anything an actor may not see is `not_found`, exactly as one that doesn't
 * exist.
 *
 * Nothing secret or observed leaves it: no webhook secret, cursor, grant
 * material, payload value, sample or host error text is in a response or
 * an error. A test (`test`) is a pure dry run: it writes nothing, starts no
 * agent turn, and runs no script or request.
 */

import { createHash } from "node:crypto";
import { type Condition, type ConditionState, evaluate, lookup, referencedPaths } from "./condition";
import { DELIVERY_TTL_MS, type RunPhase, type TriggerRun } from "./coordinator";
import type { TriggerEngine } from "./engine";
import { type MigrationRecord, type MigrationRuns, type MigrationStatusItem, migrationRecordOf } from "./migration";
import { conditionMode, parseTriggerSpec, runsOnComputer, SOURCE_KINDS, type SourceKind, TRIGGER_LIFECYCLES, type TriggerLifecycle, type TriggerSpec } from "./spec";
import { ADMISSION_LIMITS, DEFAULT_RETENTION, type Evidence, type Occurrence, type Refusal, type Trigger } from "./store";
import { previewFirings, TIME_LIMITS } from "./time";
import { flag, integer, json, type JsonValue, oneOf, opaqueId, record, TriggerValidationError } from "./validate";

/** Creation keys, made the first time a trigger is made with one. Holds digests only. */
export const API_TABLES = ["pim_trigger_api_creations"] as const;

const SCHEMA = `
CREATE TABLE IF NOT EXISTS pim_trigger_api_creations (
	key TEXT PRIMARY KEY,
	trigger_id TEXT NOT NULL,
	digest TEXT NOT NULL,
	created_at INTEGER NOT NULL
);
`;

export const API_LIMITS = {
	/** Items on a page when the caller asks for none, and the most it may ask for. */
	pageDefault: 20,
	pageMax: 50,
	idempotencyKeyLength: 128,
	/** Samples one dry run evaluates, in order. */
	testSamples: 10,
	/** Firings a dry run previews when it isn't told how many, and the most. */
	previewDefault: 5,
	previewMax: TIME_LIMITS.maxPreviewCount,
} as const;

/** `originChatId` of a trigger the person made through the API, which was made in no chat. */
export const API_ORIGIN = "api";

/**
 * Who is asking: the person, through the HTTP API, or an agent, through
 * its tools in one of its chats (`chatId`, the internal id).
 */
export type TriggerActor = { readonly kind: "person" } | { readonly kind: "agent"; readonly agentId: string; readonly majordomo: boolean; readonly chatId: string };

export const PERSON: TriggerActor = { kind: "person" };

/** What a source kind can do in this space now. */
export type SourceStatus = "available" | "draft_only" | "unavailable";

export type GrantState = "not_required" | "missing" | "pending_approval" | "current" | "not_current";

/** What the API reads of the space around it. Chat ids are internal unless named public. */
export type TriggerApiHost = {
	readonly agentExists: (id: string) => boolean;
	readonly majordomoId: () => string;
	/** The agent a chat is with, read only; null for none. */
	readonly chatAgent: (chatId: string) => string | null;
	/** Whether a chat is one a trigger may deliver to, as the host's preflight checks it. */
	readonly chatOpen: (chatId: string) => Promise<boolean>;
	readonly publicChat: (chatId: string) => string;
	/** The chat a public id names, if any. */
	readonly chatOf: (publicId: string) => string | null;
	/** The connectors an agent works with (every connected one, for null) and the events their catalogs list. */
	readonly connectors: (agentId: string | null) => readonly { readonly connectorId: string; readonly name: string; readonly events: readonly string[] }[];
	/** Where the space's schedules and watches stand in their move to triggers, in the plan's order, and the migration's runs as this instance knows them. Read only. */
	readonly migration: () => Promise<{ readonly items: readonly MigrationStatusItem[]; readonly runs: MigrationRuns }>;
	/** Whether a computer is paired, which computer sources run on. */
	readonly computer: () => { readonly paired: boolean };
	/** Where a computer source's grant stands, for a trigger whose source runs on the computer. */
	readonly grant: (trigger: { readonly id: string; readonly spec: TriggerSpec }) => GrantState;
};

export type TriggerApiOptions = {
	readonly engine: TriggerEngine;
	readonly transaction: <T>(work: () => T) => T;
	readonly now: () => number;
	readonly host: TriggerApiHost;
	/**
	 * Told after every change the API made, through either path, so the
	 * space's trigger wake is set for what is due now. Awaited before the
	 * change answers; a failure is logged and never fails the change.
	 */
	readonly changed: () => Promise<void>;
	/**
	 * Ends the schedule or watch a trigger was made from (./migration.ts),
	 * and the trigger with it: what deleting such a trigger does, since the
	 * person is stopping that work wherever they see it. Without it, such a
	 * trigger can't be deleted through the API.
	 */
	readonly endMigrated?: (record: MigrationRecord) => Promise<void>;
};

export type TriggerErrorCode =
	| "invalid_request"
	| "invalid_cursor"
	| "forbidden"
	| "not_found"
	| "revision_conflict"
	| "invalid_transition"
	| "trigger_deleted"
	| "owned_elsewhere"
	| "grant_required"
	| "grant_not_current"
	| "schedule_exhausted"
	| "source_not_wired"
	| "idempotency_conflict"
	| "unknown_agent"
	| "chat_unavailable"
	| "source_unavailable"
	| "revision_required";

/** A refusal with a fixed code and a message that names fields, never values. */
export class TriggerApiError extends Error {
	constructor(
		readonly status: number,
		readonly code: TriggerErrorCode,
		message: string,
		readonly extra: Readonly<Record<string, JsonValue>> = {},
	) {
		super(message);
		this.name = "TriggerApiError";
	}

	body(): Record<string, JsonValue> {
		return { error: this.message, code: this.code, ...this.extra };
	}
}

const notFound = () => new TriggerApiError(404, "not_found", "No such trigger");

const CREATE_FIELDS = ["label", "instruction", "source", "condition", "destination", "delivery", "agentId", "enabled"] as const;
const UPDATE_FIELDS = ["label", "instruction", "source", "condition", "destination", "delivery"] as const;
const TEST_FIELDS = ["id", "trigger", "samples", "count"] as const;
const SAMPLE_FIELDS = ["value", "observedAt", "gap"] as const;

/** What creating takes. `source`, `condition` and `delivery` are the spec's (docs/triggers.md); instants may also be ISO 8601 text with an offset. */
export type CreateInput = Record<string, unknown>;

/** A run's state, as honest as what is known of it (docs/triggers.md, "The API"). */
export type RunState =
	| "pending"
	| "preparing"
	| "submitting"
	| "accepted"
	| "queued"
	| "running"
	| "waiting_approval"
	| "completed"
	| "failed"
	| "cancelled"
	| "not_submitted"
	| "missed"
	| "superseded"
	| "outcome_unknown";

const KNOWN_OUTCOMES: readonly RunState[] = ["completed", "failed", "cancelled", "not_submitted", "missed", "superseded"];

export class TriggerApi {
	readonly #sql: SqlStorage;
	readonly #options: TriggerApiOptions;

	constructor(sql: SqlStorage, options: TriggerApiOptions) {
		this.#sql = sql;
		this.#options = options;
	}

	get engine(): TriggerEngine {
		return this.#options.engine;
	}

	get #store() {
		return this.#options.engine.store;
	}

	get #host() {
		return this.#options.host;
	}

	// Reading

	/** One page of the triggers the actor may see, oldest first. Deleted ones only when asked for by `lifecycle`. */
	list(actor: TriggerActor, query: { lifecycle?: unknown; agentId?: unknown; sourceKind?: unknown; cursor?: unknown; limit?: unknown }) {
		const lifecycle = query.lifecycle === undefined ? null : field(() => oneOf(query.lifecycle, "lifecycle", TRIGGER_LIFECYCLES));
		const sourceKind = query.sourceKind === undefined ? null : field(() => oneOf(query.sourceKind, "sourceKind", SOURCE_KINDS));
		let agentId = query.agentId === undefined ? null : field(() => opaqueId(query.agentId, "agentId"));
		// An agent other than the majordomo sees only its own.
		if (actor.kind === "agent" && !actor.majordomo) {
			if (agentId !== null && agentId !== actor.agentId) return { triggers: [], nextCursor: null };
			agentId = actor.agentId;
		}
		const limit = pageSize(query.limit);
		const after = query.cursor === undefined ? null : readCursor(query.cursor, "triggers", "");
		// In the order they were made: rows are never removed but by erasing the space, so their order holds.
		const rows = this.#sql
			.exec(
				`SELECT t.rowid AS position, t.id AS id FROM pim_triggers t JOIN pim_trigger_revisions r ON r.trigger_id = t.id AND r.revision = t.revision
				WHERE ${lifecycle === null ? "t.lifecycle != 'deleted'" : "t.lifecycle = ?"}
				AND (? IS NULL OR json_extract(r.spec, '$.owningAgentId') = ?)
				AND (? IS NULL OR json_extract(r.spec, '$.source.kind') = ?)
				AND t.rowid > ?
				ORDER BY t.rowid LIMIT ?`,
				...(lifecycle === null ? [] : [lifecycle]),
				agentId,
				agentId,
				sourceKind,
				sourceKind,
				after ?? 0,
				limit + 1,
			)
			.toArray();
		const page = rows.slice(0, limit);
		const last = page.at(-1);
		return {
			triggers: page.map((row) => this.#view(this.#store.get(String(row.id))!)),
			nextCursor: rows.length > limit && last ? writeCursor("triggers", "", Number(last.position)) : null,
		};
	}

	/** One trigger, deleted ones included, with its ETag's revision. */
	get(actor: TriggerActor, id: unknown) {
		return this.#view(this.#visible(actor, id));
	}

	/** One page of a trigger's runs, newest first. */
	runs(actor: TriggerActor, id: unknown, query: { cursor?: unknown; limit?: unknown }) {
		const trigger = this.#visible(actor, id);
		const limit = pageSize(query.limit);
		const after = query.cursor === undefined ? null : readCursor(query.cursor, "runs", trigger.id);
		// Newest first, in the order they were taken in; pruning removes only the oldest.
		const rows = this.#sql
			.exec(
				"SELECT rowid AS position, id FROM pim_trigger_occurrences WHERE trigger_id = ? AND (? IS NULL OR rowid < ?) ORDER BY rowid DESC LIMIT ?",
				trigger.id,
				after,
				after,
				limit + 1,
			)
			.toArray();
		const page = rows.slice(0, limit);
		const last = page.at(-1);
		return {
			runs: page.map((row) => this.#runView(this.#store.occurrence(String(row.id))!)),
			nextCursor: rows.length > limit && last ? writeCursor("runs", trigger.id, Number(last.position)) : null,
		};
	}

	/** One run, by its id (its occurrence's), if the actor may see its trigger. */
	run(actor: TriggerActor, runId: unknown) {
		const id = typeof runId === "string" && runId.length > 0 && runId.length <= 128 ? runId : null;
		const occurrence = id === null ? undefined : this.#store.occurrence(id);
		if (!occurrence) throw new TriggerApiError(404, "not_found", "No such run");
		try {
			this.#visible(actor, occurrence.triggerId);
		} catch {
			throw new TriggerApiError(404, "not_found", "No such run");
		}
		return this.#runView(occurrence);
	}

	/**
	 * Where the space's schedules and watches stand in their move to
	 * triggers (./migration.ts, `migrationStatus`), a page at a time, in a
	 * stable order, with what this instance knows of the migration's runs.
	 * An agent other than the majordomo sees only its own items. Writes
	 * nothing; no instruction, secret, URL or cursor is in it.
	 */
	async migration(actor: TriggerActor, query: { cursor?: unknown; limit?: unknown }) {
		const limit = pageSize(query.limit);
		const after = query.cursor === undefined ? null : readKeyCursor(query.cursor, "migration");
		const { items, runs } = await this.#host.migration();
		const visible = items
			// An item with a live trigger is that trigger's agent's.
			.map((item) => ({ ...item, agentId: (item.triggerId === null ? undefined : this.#store.get(item.triggerId)?.spec.owningAgentId) ?? item.agentId }))
			.filter((item) => actor.kind === "person" || actor.majordomo || item.agentId === actor.agentId);
		const key = (item: MigrationStatusItem) => `${item.kind}:${item.legacyId}`;
		const rest = after === null ? visible : visible.filter((item) => key(item) > after);
		const page = rest.slice(0, limit);
		const last = page.at(-1);
		return {
			runs,
			items: page,
			nextCursor: rest.length > limit && last ? writeKeyCursor("migration", key(last)) : null,
		};
	}

	/** Every source kind, with what it can do in this space now, and the connector events the agent may use. */
	sources(actor: TriggerActor, query: { agentId?: unknown } = {}) {
		let agentId: string | null = query.agentId === undefined ? null : field(() => opaqueId(query.agentId, "agentId"));
		if (actor.kind === "agent" && (!actor.majordomo || agentId === null)) agentId = actor.agentId;
		if (agentId !== null && !this.#host.agentExists(agentId)) throw new TriggerApiError(422, "unknown_agent", "No such agent");
		const computer = this.#host.computer();
		return {
			sources: SOURCE_KINDS.map((kind) => {
				const { status, reason } = this.#capability(kind);
				const base = { kind, status, delivers: status === "available", reason };
				if (kind === "time") return { ...base, schedules: ["once", "cron", "interval"] };
				if (kind === "connector_event") {
					return { ...base, connectors: this.#host.connectors(agentId).map(({ connectorId, name, events }) => ({ connectorId, name, events: [...events] })) };
				}
				if (kind === "file") return base;
				return { ...base, requiresGrant: true, computerPaired: computer.paired };
			}),
		};
	}

	// Changing

	/**
	 * Makes a trigger, as a draft unless `enabled`. With `key`, making it is
	 * idempotent: the same key with the same request gives the trigger made
	 * the first time (`replayed`), and with another request is refused.
	 */
	async create(actor: TriggerActor, input: unknown, key: string | null = null): Promise<{ trigger: ReturnType<TriggerApi["get"]>; replayed: boolean }> {
		const given = fields(input, CREATE_FIELDS);
		const enabled = given.enabled === undefined ? false : field(() => flag(given.enabled, "enabled"));
		const owner = this.#owner(actor, given.agentId);
		const { destination, origin } = await this.#destination(actor, owner, given.destination, null);
		const spec = parse(
			{
				version: 1,
				owningAgentId: owner,
				originChatId: origin,
				label: given.label,
				instruction: given.instruction,
				source: instants(given.source),
				condition: given.condition,
				destination,
				delivery: given.delivery,
				authorizationRef: null,
			},
			input,
		);
		this.#checkSource(spec);
		if (enabled) this.#checkWired(spec);
		const lifecycle = enabled ? "enabled" : "draft";
		const digest = sha256(canonical({ spec, lifecycle }));
		const keyed = key === null ? null : sha256(`${actor.kind === "agent" ? `agent:${actor.agentId}` : "person"}\n${key}`);
		const made = this.#options.transaction(() => {
			if (keyed !== null) {
				this.#sql.exec(SCHEMA);
				const [prior] = this.#sql.exec("SELECT trigger_id, digest FROM pim_trigger_api_creations WHERE key = ?", keyed).toArray();
				if (prior) {
					if (String(prior.digest) !== digest) throw new TriggerApiError(409, "idempotency_conflict", "This key was used to make another trigger");
					return { trigger: this.#view(this.#store.get(String(prior.trigger_id))!), replayed: true };
				}
			}
			const made = attempt(() => this.#store.create({ spec, lifecycle }), input);
			if (!made.ok) throw refusal(made);
			if (keyed !== null) this.#sql.exec("INSERT INTO pim_trigger_api_creations (key, trigger_id, digest, created_at) VALUES (?, ?, ?, ?)", keyed, made.trigger.id, digest, this.#options.now());
			return { trigger: this.#view(made.trigger), replayed: false };
		});
		// A replay too: the wake its first time set may have failed.
		await this.#changed();
		return made;
	}

	/** Changes a trigger's spec, only while it is still at `expectedRevision`. Absent fields stay as they are; `condition: null` takes it off. */
	async update(actor: TriggerActor, id: unknown, expectedRevision: unknown, input: unknown) {
		const trigger = this.#changeable(actor, id);
		const expected = revisionOf(expectedRevision);
		const given = fields(input, UPDATE_FIELDS);
		if (trigger.revision !== expected) throw conflict(trigger);
		const before = trigger.spec;
		const { destination } = given.destination === undefined ? { destination: before.destination } : await this.#destination(actor, before.owningAgentId, given.destination, before);
		const source = given.source === undefined ? before.source : instants(given.source);
		const kept = given.delivery === undefined && sameMode(source, before);
		const read = parse(
			{
				...before,
				label: given.label === undefined ? before.label : given.label,
				instruction: given.instruction === undefined ? before.instruction : given.instruction,
				source,
				condition: given.condition === undefined ? before.condition : given.condition,
				destination,
				// A source of another mode takes its own defaults unless the caller says otherwise.
				delivery: given.delivery === undefined ? (kept ? before.delivery : undefined) : given.delivery,
			},
			input,
		);
		const sourceChanged = canonical(read.source) !== canonical(before.source);
		// A grant covers the source it was given for: a computer source changed needs asking again.
		const spec: TriggerSpec = sourceChanged ? { ...read, authorizationRef: null } : read;
		if (sourceChanged) this.#checkSource(spec);
		if (trigger.lifecycle === "enabled") this.#checkWired(spec);
		const changed = attempt(() => this.#store.update({ id: trigger.id, expectedRevision: expected, spec }), input);
		if (!changed.ok) throw refusal(changed);
		await this.#changed();
		return this.#view(changed.trigger);
	}

	/** Pauses an enabled trigger; with `expectedRevision`, only at that revision. */
	async pause(actor: TriggerActor, id: unknown, expectedRevision?: unknown) {
		const trigger = this.#changeable(actor, id);
		const changed = this.#store.setLifecycle({ id: trigger.id, to: "paused", ...(expectedRevision === undefined ? {} : { expectedRevision: revisionOf(expectedRevision) }) });
		if (!changed.ok) throw refusal(changed);
		await this.#changed();
		return this.#view(changed.trigger);
	}

	/** Enables a draft or paused trigger at exactly `expectedRevision`, which it must name. */
	async resume(actor: TriggerActor, id: unknown, expectedRevision: unknown) {
		const trigger = this.#changeable(actor, id);
		const expected = revisionOf(expectedRevision);
		if (trigger.revision !== expected) throw conflict(trigger);
		this.#checkWired(trigger.spec);
		const changed = this.#store.setLifecycle({ id: trigger.id, to: "enabled", expectedRevision: expected });
		if (!changed.ok) throw refusal(changed);
		await this.#changed();
		return this.#view(changed.trigger);
	}

	/**
	 * Deletes a trigger for good, keeping its history; with
	 * `expectedRevision`, only at that revision. A trigger made from a
	 * schedule or watch ends that schedule or watch with it, whichever of
	 * the two delivers it (`endMigrated`). A stop asked for, not proof
	 * anything was cancelled.
	 */
	async remove(actor: TriggerActor, id: unknown, expectedRevision?: unknown) {
		const trigger = this.#changeable(actor, id, { migrated: this.#options.endMigrated !== undefined });
		const record = migrationRecordOf(this.#sql, trigger.id);
		if (record?.phase === "shadow" && this.#options.endMigrated) {
			if (expectedRevision !== undefined && revisionOf(expectedRevision) !== trigger.revision) throw conflict(trigger);
			await this.#options.endMigrated(record);
		} else {
			const removed = this.#store.remove({ id: trigger.id, ...(expectedRevision === undefined ? {} : { expectedRevision: revisionOf(expectedRevision) }) });
			if (!removed.ok) throw refusal(removed);
		}
		await this.#changed();
		return { deleted: true, trigger: this.#view(this.#store.get(trigger.id)!) };
	}

	/** Tells the space of a change made, so its wake is set for what is due now; a failure is logged and the change still answers. */
	async #changed(): Promise<void> {
		try {
			await this.#options.changed();
		} catch (error) {
			console.warn("setting the trigger wake failed", error);
		}
	}

	/**
	 * A dry run of a trigger as it is (`id`) or as it would be made
	 * (`trigger`, what `create` takes): whether it is valid, what would stop
	 * it being enabled, its next firings for a time source, and for other
	 * sources what its condition says of each sample, in order, from a fresh
	 * start. Writes nothing, starts no run, and runs nothing; a sample's
	 * values are never in the answer, only whether the fields the condition
	 * reads were there.
	 */
	async test(actor: TriggerActor, input: unknown) {
		const given = fields(input, TEST_FIELDS);
		if ((given.id === undefined) === (given.trigger === undefined)) throw new TriggerApiError(400, "invalid_request", "Give exactly one of id or trigger", { field: "id" });
		const now = this.#options.now();
		let spec: TriggerSpec;
		let trigger: Trigger | null = null;
		let lifecycle: TriggerLifecycle | null = null;
		if (given.id !== undefined) {
			trigger = this.#visible(actor, given.id);
			spec = trigger.spec;
			lifecycle = trigger.lifecycle;
		} else {
			const draft = fields(given.trigger, CREATE_FIELDS, "trigger");
			const owner = this.#owner(actor, draft.agentId);
			const { destination, origin } = await this.#destination(actor, owner, draft.destination, null);
			spec = parse(
				{ version: 1, owningAgentId: owner, originChatId: origin, label: draft.label, instruction: draft.instruction, source: instants(draft.source), condition: draft.condition, destination, delivery: draft.delivery, authorizationRef: null },
				input,
			);
			this.#checkSource(spec);
		}
		const count = given.count === undefined ? API_LIMITS.previewDefault : field(() => integer(given.count, "count", 1, API_LIMITS.previewMax));
		const blockers: TriggerErrorCode[] = [];
		const capability = this.#capability(spec.source.kind);
		if (capability.status !== "available") blockers.push("source_not_wired");
		const grant = runsOnComputer(spec.source) ? (trigger ? this.#host.grant(trigger) : "missing") : "not_required";
		if (grant === "missing" || grant === "pending_approval") blockers.push("grant_required");
		if (grant === "not_current") blockers.push("grant_not_current");
		if (trigger && migrationRecordOf(this.#sql, trigger.id)?.owner === "legacy") blockers.push("owned_elsewhere");
		const result: Record<string, JsonValue> = {
			dryRun: true,
			valid: true,
			...(trigger ? { id: trigger.id, revision: trigger.revision, lifecycle } : {}),
			sourceKind: spec.source.kind,
			capability: { status: capability.status, reason: capability.reason },
			grant: { required: runsOnComputer(spec.source), state: grant },
			policies: policies(spec),
		};
		const samples = given.samples === undefined ? [] : this.#samples(given.samples, now);
		if (spec.source.kind === "time") {
			if (samples.length > 0) throw new TriggerApiError(400, "invalid_request", "samples: a time source observes nothing", { field: "samples" });
			const preview = previewFirings(spec.source, { now, count });
			if (preview.firings.length === 0) blockers.push("schedule_exhausted");
			result.firings = preview.firings.map((firing) => ({ ...firing }));
			result.skipped = preview.skipped.map((skipped) => ({ ...skipped }));
			result.skippedCount = preview.skippedCount;
			result.exhausted = preview.exhausted;
		} else {
			result.evaluations = evaluations(spec, samples, now);
		}
		result.blockers = [...new Set(blockers)];
		return result;
	}

	// What the actor may see and change

	/** The trigger `id`, if the actor may see it; `not_found` otherwise, as one that doesn't exist. */
	#visible(actor: TriggerActor, id: unknown): Trigger {
		if (typeof id !== "string" || id.length === 0 || id.length > 256) throw notFound();
		const trigger = this.#store.get(id);
		if (!trigger) throw notFound();
		if (actor.kind === "agent" && !actor.majordomo && trigger.spec.owningAgentId !== actor.agentId) throw notFound();
		return trigger;
	}

	/**
	 * A trigger the actor may change: not deleted, and not a shadow, which
	 * only the migration changes, whichever side owns it; with `migrated`, a
	 * shadow too, for deleting it with its schedule or watch.
	 */
	#changeable(actor: TriggerActor, id: unknown, options: { readonly migrated?: boolean } = {}): Trigger {
		const trigger = this.#visible(actor, id);
		if (trigger.lifecycle === "deleted") throw new TriggerApiError(409, "trigger_deleted", "The trigger was deleted");
		const record = migrationRecordOf(this.#sql, trigger.id);
		if (record?.phase === "shadow" && options.migrated !== true) {
			throw new TriggerApiError(
				409,
				"owned_elsewhere",
				record.owner === "trigger"
					? "This trigger took over a schedule or watch: it can't be changed or paused, only deleted, which ends that schedule or watch too"
					: "A schedule or watch still delivers this trigger's work: it can't be changed or turned on, only deleted, which ends that schedule or watch too",
			);
		}
		return trigger;
	}

	/** The agent a new trigger is for: the actor itself, or another only for the majordomo; the person's default is the majordomo. */
	#owner(actor: TriggerActor, given: unknown): string {
		const named = given === undefined || given === null ? null : field(() => opaqueId(given, "agentId"));
		const owner = named ?? (actor.kind === "agent" ? actor.agentId : this.#host.majordomoId());
		if (actor.kind === "agent" && owner !== actor.agentId && !actor.majordomo) throw new TriggerApiError(403, "forbidden", "Only the majordomo makes triggers for other agents");
		if (!this.#host.agentExists(owner)) throw new TriggerApiError(422, "unknown_agent", "No such agent", { field: "agentId" });
		return owner;
	}

	/**
	 * Where a trigger's occurrences go, and the chat it is made in. An agent
	 * delivers to the chat it asks from, or to new chats; for another agent,
	 * only to new chats. The person names an existing chat by its public id,
	 * which must be one a trigger may deliver to and be with the owning agent.
	 */
	async #destination(actor: TriggerActor, owner: string, given: unknown, before: TriggerSpec | null): Promise<{ destination: TriggerSpec["destination"]; origin: string }> {
		const own = actor.kind === "agent" && owner === actor.agentId;
		const origin = before?.originChatId ?? (actor.kind === "agent" ? actor.chatId : API_ORIGIN);
		const asked = given === undefined ? null : fields(given, ["type", "chatId"], "destination");
		const type = asked === null ? (own ? "existing_chat" : "new_chat") : field(() => oneOf(asked.type, "destination.type", ["existing_chat", "new_chat"] as const));
		if (type === "new_chat") {
			if (asked?.chatId !== undefined) throw new TriggerApiError(400, "invalid_request", "destination.chatId: a new chat takes no chat id", { field: "destination.chatId" });
			return { destination: { type }, origin: origin };
		}
		let chat: string;
		if (actor.kind === "agent") {
			if (!own) throw new TriggerApiError(403, "forbidden", "A trigger for another agent starts new chats");
			if (asked?.chatId !== undefined && this.#host.chatOf(String(asked.chatId)) !== actor.chatId) throw new TriggerApiError(403, "forbidden", "An agent's trigger delivers to the chat it was asked from, or to new chats");
			chat = actor.chatId;
		} else {
			const named = asked?.chatId === undefined ? null : this.#host.chatOf(field(() => opaqueId(asked.chatId, "destination.chatId")));
			if (named === null) throw new TriggerApiError(422, "chat_unavailable", "No chat a trigger may deliver to", { field: "destination.chatId" });
			chat = named;
		}
		if (this.#host.chatAgent(chat) !== owner || !(await this.#host.chatOpen(chat))) {
			throw new TriggerApiError(422, "chat_unavailable", "No chat a trigger may deliver to", { field: "destination.chatId" });
		}
		return { destination: { type, chatId: chat }, origin: actor.kind === "person" && before === null ? chat : origin };
	}

	/** Refuses a source this space can't have: a kind it doesn't offer, or a connector event its agent doesn't work with. */
	#checkSource(spec: TriggerSpec): void {
		const { status } = this.#capability(spec.source.kind);
		if (status === "unavailable") throw new TriggerApiError(422, "source_unavailable", "This kind of source isn't available here", { field: "source.kind" });
		if (spec.source.kind === "connector_event") {
			const { connectorId, event } = spec.source;
			const connector = this.#host.connectors(spec.owningAgentId).find((candidate) => candidate.connectorId === connectorId);
			if (!connector?.events.includes(event)) throw new TriggerApiError(422, "source_unavailable", "The agent works with no connector that has this event", { field: "source.event" });
		}
	}

	/** Refuses enabling a source nothing in this space delivers. */
	#checkWired(spec: TriggerSpec): void {
		const { status, reason } = this.#capability(spec.source.kind);
		if (status === "available") return;
		if (reason === "computer_not_paired") throw new TriggerApiError(409, "source_not_wired", "No computer is paired to run this source: pair one first; until then it can be kept only as a draft");
		throw new TriggerApiError(409, "source_not_wired", "Nothing delivers this kind of source yet: it can be kept only as a draft");
	}

	/**
	 * What a kind of source can do here, honestly: time triggers and a
	 * connector's events run; a poll, stream or process watch runs on the
	 * paired computer, so with none it is a draft only until one is paired;
	 * and files never yet.
	 */
	#capability(kind: SourceKind): { status: SourceStatus; reason: string | null } {
		if (kind === "time" || kind === "connector_event") return { status: "available", reason: null };
		if (kind === "file") return { status: "unavailable", reason: "not_wired" };
		return this.#host.computer().paired ? { status: "available", reason: null } : { status: "draft_only", reason: "computer_not_paired" };
	}

	#samples(value: unknown, now: number): { value: JsonValue; observedAt: number; gap: boolean }[] {
		if (!Array.isArray(value) || value.length > API_LIMITS.testSamples) {
			throw new TriggerApiError(400, "invalid_request", `samples: must be a list of at most ${API_LIMITS.testSamples}`, { field: "samples" });
		}
		return value.map((item, index) => {
			const sample = fields(item, SAMPLE_FIELDS, `samples[${index}]`);
			return {
				// The sample's values are read, and never named in an error.
				value: field(() => json(sample.value ?? null, `samples[${index}].value`, ADMISSION_LIMITS.payload), item),
				observedAt: sample.observedAt === undefined ? now : field(() => integer(sample.observedAt, `samples[${index}].observedAt`, 0, now + ADMISSION_LIMITS.futureSkewMs)),
				gap: sample.gap === undefined ? false : field(() => flag(sample.gap, `samples[${index}].gap`)),
			};
		});
	}

	// Views

	#view(trigger: Trigger) {
		const spec = trigger.spec;
		const now = this.#options.now();
		const record = migrationRecordOf(this.#sql, trigger.id);
		const capability = this.#capability(spec.source.kind);
		const grant = runsOnComputer(spec.source) ? this.#host.grant(trigger) : "not_required";
		const live = trigger.lifecycle !== "deleted" && trigger.lifecycle !== "ended";
		let schedule: Record<string, JsonValue> | null = null;
		if (spec.source.kind === "time") {
			let nextFiringAt: number | null = null;
			try {
				nextFiringAt = live ? (previewFirings(spec.source, { now, count: 1 }).firings[0]?.at ?? null) : null;
			} catch {
				// A clock outside what time.ts takes in has no next firing to show.
			}
			const state = this.#store.sourceState(trigger.id);
			schedule = { nextFiringAt, nextCheckAt: trigger.lifecycle === "enabled" ? (state?.nextWakeAt ?? null) : null };
		}
		return {
			id: trigger.id,
			revision: trigger.revision,
			lifecycle: trigger.lifecycle,
			health: trigger.health,
			healthDetail: trigger.healthDetail,
			agentId: spec.owningAgentId,
			label: spec.label,
			instruction: spec.instruction,
			source: spec.source as unknown as JsonValue,
			condition: spec.condition as unknown as JsonValue,
			destination: spec.destination.type === "new_chat" ? { type: "new_chat" } : { type: "existing_chat", chatId: this.#host.publicChat(spec.destination.chatId) },
			origin: spec.originChatId === API_ORIGIN ? { type: "api" } : { type: "chat", chatId: this.#host.publicChat(spec.originChatId) },
			policies: policies(spec),
			schedule,
			capability: { status: capability.status, delivers: capability.status === "available", reason: capability.reason },
			grant: { required: runsOnComputer(spec.source), state: grant },
			migration: record === null ? null : { kind: record.kind, legacyId: record.legacyId, owner: record.owner, phase: record.phase, enableable: record.owner === "trigger", ownerSince: record.ownerSince },
			createdAt: trigger.createdAt,
			updatedAt: trigger.updatedAt,
		};
	}

	#runView(occurrence: Occurrence) {
		const run = this.#runOf(occurrence.id);
		const state = runState(occurrence, run);
		return {
			id: occurrence.id,
			triggerId: occurrence.triggerId,
			revision: occurrence.revision,
			state,
			outcomeKnown: KNOWN_OUTCOMES.includes(state),
			occurrenceStatus: occurrence.status,
			phase: run?.phase ?? null,
			dueAt: occurrence.dueAt,
			evidence: evidenceView(occurrence.evidence),
			chatId: run?.chatId && run.chatState === "pinned" ? this.#host.publicChat(run.chatId) : null,
			deliverBy: run?.deliverBy ?? null,
			submittedAt: run?.submittedAt ?? null,
			acceptedAt: run?.acceptedAt ?? null,
			endedAt: run?.endedAt ?? null,
			deferrals: run?.deferrals ?? 0,
			unknownAnswers: run?.unknownAnswers ?? 0,
			createdAt: occurrence.createdAt,
			updatedAt: Math.max(occurrence.updatedAt, run?.updatedAt ?? 0),
		};
	}

	/** The coordinator's run of an occurrence, through its outbox item: at most one. */
	#runOf(occurrenceId: string): TriggerRun | undefined {
		const [row] = this.#sql
			.exec("SELECT r.operation_id AS operation_id FROM pim_trigger_outbox x JOIN pim_trigger_runs r ON r.outbox_id = x.id WHERE x.occurrence_id = ?", occurrenceId)
			.toArray();
		return row ? this.engine.coordinator.run(String(row.operation_id)) : undefined;
	}
}

/**
 * A run's state: what the coordinator last knew of it, or, before it
 * claimed the occurrence or where it never will, what the store says. A
 * submission never stands for a finished run, and an unknown is never
 * called a success or a failure.
 */
function runState(occurrence: Occurrence, run: TriggerRun | undefined): RunState {
	if (run && (run.phase !== "preparing" || occurrence.status === "pending")) return run.phase satisfies RunPhase;
	switch (occurrence.status) {
		case "pending":
			return "pending";
		case "delivered":
			return "accepted";
		case "failed":
		case "cancelled":
			return "not_submitted";
		case "superseded":
		case "missed":
		case "outcome_unknown":
			return occurrence.status;
	}
}

/** What an occurrence keeps of why it fired: times, and which fields the condition read were there. Never a value. */
function evidenceView(evidence: Evidence): JsonValue {
	if (evidence.reason === "time") {
		return { reason: "time", scheduledFor: evidence.scheduledFor, ...(evidence.older ? { older: { ...evidence.older } } : {}) };
	}
	return { reason: evidence.reason, truth: evidence.truth, observedAt: evidence.observedAt, fields: evidence.fields.map((found) => ({ path: [...found.path], present: found.present })) };
}

/** The policies in effect for a trigger, with every default written in, as the store and coordinator apply them. */
function policies(spec: TriggerSpec): JsonValue {
	const source = spec.source;
	return {
		lateness:
			source.kind !== "time"
				? null
				: source.schedule === "once"
					? { maxLatenessMs: source.maxLatenessMs, missed: "recorded" }
					: { catchUpMs: source.catchUpMs, coalesce: "latest_due" },
		maxPendingEvents: spec.delivery.maxPendingEvents,
		pendingSnapshots: spec.delivery.maxPendingEvents === null ? 1 : null,
		rawSamples: false,
		runsAtOnce: 1,
		deliveryTtlMs: DELIVERY_TTL_MS,
		replayHorizonMs: conditionMode(source) === null ? null : DEFAULT_RETENTION.dedupHorizonMs,
		staleAfterMs: spec.condition?.staleAfterMs ?? null,
	};
}

/** What a condition says of each sample, from a fresh start, in order: truth, whether it would fire, and which fields it read were there. */
function evaluations(spec: TriggerSpec, samples: readonly { value: JsonValue; observedAt: number; gap: boolean }[], now: number): JsonValue {
	const mode = conditionMode(spec.source)!;
	const condition: Condition | null = spec.condition;
	let state: ConditionState | null = null;
	return samples.map((sample, index) => {
		if (condition === null) return { index, truth: "true", fires: true, stale: false, fields: [] };
		const result = evaluate(condition, mode, state, { value: sample.value, observedAt: sample.observedAt, gap: sample.gap }, now);
		state = result.state;
		return {
			index,
			truth: result.truth,
			fires: result.fire,
			stale: result.stale,
			fields: referencedPaths(condition.when).map((path) => {
				const found = lookup(sample.value, path);
				return { path: [...path], present: found !== undefined && found !== null };
			}),
		};
	});
}

// Reading requests

/** A request object with only `allowed` fields. */
function fields<const K extends string>(value: unknown, allowed: readonly K[], path = "request"): Partial<Record<K, unknown>> {
	return field(() => record(value, path, allowed), value) as Partial<Record<K, unknown>>;
}

/** Runs a reader, turning a validation error into `invalid_request` that names the field and never a value from `input`. */
function field<T>(read: () => T, input?: unknown): T {
	try {
		return read();
	} catch (error) {
		if (error instanceof TriggerValidationError) throw invalid(error, input);
		throw error;
	}
}

function parse(spec: Record<string, unknown>, input: unknown): TriggerSpec {
	return field(() => parseTriggerSpec(spec), input);
}

/** A store call that may refuse what it is given, such as a time source with no firing left. */
function attempt<T>(work: () => T, input: unknown): T {
	return field(work, input);
}

function invalid(error: TriggerValidationError, input: unknown): TriggerApiError {
	let path = error.path.replace(/^spec\./, "");
	// A connector's arguments and a sample's value are the caller's own keys: the field names where they start.
	path = path.replace(/^(source\.arguments|samples\[\d+\]\.value|trigger\.source\.arguments)[.[].*$/, "$1");
	let reason = error.message.slice(error.path.length + 2).replace(/^has no field .*?; it takes/, "has a field it doesn't take; it takes");
	if (reason.includes('"') || leaks(reason, input)) reason = "is not valid";
	return new TriggerApiError(400, "invalid_request", `${path}: ${reason}`, { field: path });
}

/** Whether `text` repeats any string or key of `input` long enough to say something. */
function leaks(text: string, input: unknown): boolean {
	const found: string[] = [];
	const visit = (node: unknown, depth: number) => {
		if (depth > 12) return;
		if (typeof node === "string") found.push(node);
		else if (Array.isArray(node)) for (const item of node) visit(item, depth + 1);
		else if (typeof node === "object" && node !== null)
			for (const [key, item] of Object.entries(node)) {
				found.push(key);
				visit(item, depth + 1);
			}
	};
	visit(input, 0);
	return found.some((value) => value.length >= 3 && text.includes(value));
}

/** Instants of a source given as ISO 8601 text with an offset, as milliseconds; anything else is left for the spec to read. */
function instants(source: unknown): unknown {
	if (typeof source !== "object" || source === null || Array.isArray(source)) return source;
	const copy: Record<string, unknown> = { ...(source as Record<string, unknown>) };
	for (const key of ["at", "anchorAt", "expiresAt"]) {
		const value = copy[key];
		if (typeof value === "string" && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d{1,3})?)?(Z|[+-]\d{2}:\d{2})$/.test(value)) {
			const at = Date.parse(value);
			if (Number.isFinite(at)) copy[key] = at;
		}
	}
	return copy;
}

/** Whether a source as given turns observations into occurrences as `before`'s does, so its delivery policy still applies. */
function sameMode(source: unknown, before: TriggerSpec): boolean {
	const kind = (source as { kind?: unknown } | null)?.kind;
	if (!SOURCE_KINDS.includes(kind as SourceKind)) return true;
	return conditionMode({ kind } as TriggerSpec["source"]) === conditionMode(before.source);
}

/** A revision named to change at: a whole number from 1. */
function revisionOf(value: unknown): number {
	if (value === undefined || value === null) throw new TriggerApiError(428, "revision_required", "Name the revision this change is for (If-Match, or expectedRevision)");
	return field(() => integer(value, "expectedRevision", 1, Number.MAX_SAFE_INTEGER));
}

function pageSize(value: unknown): number {
	if (value === undefined) return API_LIMITS.pageDefault;
	return field(() => integer(value, "limit", 1, API_LIMITS.pageMax));
}

/** An opaque cursor for a listing in the order of its items' keys: the key its page ended at. */
function writeKeyCursor(kind: "migration", key: string): string {
	return Buffer.from(JSON.stringify([kind, key])).toString("base64url");
}

function readKeyCursor(value: unknown, kind: "migration"): string {
	const fail = () => new TriggerApiError(400, "invalid_cursor", "The cursor isn't one this listing gave", { field: "cursor" });
	if (typeof value !== "string" || value.length === 0 || value.length > 1_024 || !/^[A-Za-z0-9_-]+$/.test(value)) throw fail();
	let parsed: unknown;
	try {
		parsed = JSON.parse(Buffer.from(value, "base64url").toString("utf8"));
	} catch {
		throw fail();
	}
	if (!Array.isArray(parsed) || parsed.length !== 2 || parsed[0] !== kind || typeof parsed[1] !== "string" || parsed[1].length === 0) throw fail();
	return parsed[1];
}

/** An opaque cursor: where a page ended, for one listing only. */
function writeCursor(kind: "triggers" | "runs", scope: string, position: number): string {
	return Buffer.from(JSON.stringify([kind, scope, position])).toString("base64url");
}

function readCursor(value: unknown, kind: "triggers" | "runs", scope: string): number {
	const fail = () => new TriggerApiError(400, "invalid_cursor", "The cursor isn't one this listing gave", { field: "cursor" });
	if (typeof value !== "string" || value.length === 0 || value.length > 1_024 || !/^[A-Za-z0-9_-]+$/.test(value)) throw fail();
	let parsed: unknown;
	try {
		parsed = JSON.parse(Buffer.from(value, "base64url").toString("utf8"));
	} catch {
		throw fail();
	}
	if (!Array.isArray(parsed) || parsed.length !== 3) throw fail();
	const [k, s, position] = parsed as unknown[];
	if (k !== kind || s !== scope || typeof position !== "number" || !Number.isSafeInteger(position) || position < 1) throw fail();
	return position;
}

function conflict(trigger: Trigger): TriggerApiError {
	return new TriggerApiError(409, "revision_conflict", "The trigger was changed since that revision", { currentRevision: trigger.revision });
}

/** A store's refusal as the API's error. */
function refusal(refused: Refusal): TriggerApiError {
	switch (refused.reason) {
		case "not_found":
			return notFound();
		case "deleted":
			return new TriggerApiError(409, "trigger_deleted", "The trigger was deleted");
		case "revision_mismatch":
			return refused.current ? conflict(refused.current) : new TriggerApiError(409, "revision_conflict", "The trigger was changed since that revision");
		case "invalid_transition":
			return new TriggerApiError(409, "invalid_transition", "The trigger can't go to that state from where it is", refused.current ? { lifecycle: refused.current.lifecycle } : {});
		case "owned_elsewhere":
			return new TriggerApiError(409, "owned_elsewhere", "A schedule or watch still delivers this trigger's work");
		case "authorization_required":
			return new TriggerApiError(409, "grant_required", "The person must grant this source on their computer first");
		case "authorization_denied":
			return new TriggerApiError(409, "grant_not_current", "The grant for this source isn't current");
		case "schedule_exhausted":
			return new TriggerApiError(409, "schedule_exhausted", "The schedule has no firing left");
		case "exists":
		case "immutable_field":
			// The API names neither an id nor these fields; reaching here is a fault, not the caller's.
			throw new Error(`the store refused: ${refused.reason}`);
	}
}

function sha256(text: string): string {
	return createHash("sha256").update(text).digest("hex");
}

function canonical(value: unknown): string {
	if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
	if (typeof value === "object" && value !== null) {
		const object = value as Record<string, unknown>;
		return `{${Object.keys(object)
			.sort()
			.map((key) => `${JSON.stringify(key)}:${canonical(object[key])}`)
			.join(",")}}`;
	}
	return JSON.stringify(value);
}

// The HTTP side of the contract, which ../pim.ts routes

/** The paths of triggers' routes, which exist only where the API does. */
export const TRIGGER_PATHS = /^\/(triggers|trigger-runs)(\/|$)/;

/** What a route answers: its body, its status (200), and the revision its ETag names. */
export type TriggerAnswer = { readonly status?: number; readonly body: unknown; readonly revision?: number };

/** The largest body a triggers' route reads. */
const BODY_LIMIT = 65_536;

/** The query parameters a listing takes; `limit` as a number when it is one. Others are ignored. */
export function queryOf(url: URL, names: readonly string[]): Record<string, unknown> {
	return Object.fromEntries(
		names.flatMap((name) => {
			const value = url.searchParams.get(name);
			if (value === null) return [];
			return [[name, name === "limit" && /^\d{1,4}$/.test(value) ? Number(value) : value]];
		}),
	);
}

/** A request's JSON body; empty is `{}`. */
export async function triggerBody(request: Request): Promise<unknown> {
	const raw = await request.text();
	if (raw.length > BODY_LIMIT) throw new TriggerApiError(413, "invalid_request", `request: must be at most ${BODY_LIMIT} bytes`, { field: "request" });
	if (raw.trim() === "") return {};
	try {
		return JSON.parse(raw);
	} catch {
		throw new TriggerApiError(400, "invalid_request", "request: must be JSON", { field: "request" });
	}
}

/** The revision `If-Match` names (`"3"`, or 3); undefined without one. A weak or other ETag is refused. */
export function ifMatch(request: Request): number | undefined {
	const header = request.headers.get("if-match");
	if (header === null) return undefined;
	const match = /^\s*(?:"(\d{1,15})"|(\d{1,15}))\s*$/.exec(header);
	if (!match) throw new TriggerApiError(400, "invalid_request", 'If-Match: must name a revision, such as "3"', { field: "If-Match" });
	return Number(match[1] ?? match[2]);
}

/** The `Idempotency-Key` a creation is made under; null without one. */
export function idempotencyKey(request: Request): string | null {
	const key = request.headers.get("idempotency-key");
	if (key === null) return null;
	if (key.length === 0 || key.length > API_LIMITS.idempotencyKeyLength || !/^[A-Za-z0-9._:-]+$/.test(key)) {
		throw new TriggerApiError(400, "invalid_request", `Idempotency-Key: must be 1 to ${API_LIMITS.idempotencyKeyLength} letters, digits or . _ : -`, { field: "Idempotency-Key" });
	}
	return key;
}
