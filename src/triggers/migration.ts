/**
 * Moving schedules (`schedule_task`, ../extensions/schedule.ts) and
 * connector watches (../extensions/app-events.ts) to triggers, without
 * changing how either is delivered. See "Moving schedules and watches" in
 * docs/triggers.md.
 *
 * Three parts:
 *
 * - **Mapping** (`planMigration`), pure and deterministic: each schedule or
 *   watch becomes the spec of a trigger that would do the same work, or is
 *   reported as unsupported with the reason. Nothing that can't be
 *   represented exactly is approximated. What the trigger would do
 *   differently once it delivers is listed with each item, and what must be
 *   built before it may deliver at all is listed as its cutover blockers.
 * - **Preview**: the plan, read without writing anything: Pim's
 *   `previewTriggerMigration` reads the legacy items and the records below
 *   (without making their table) and maps them.
 * - **Apply and rollback** (`TriggerMigration`), behind an internal gate
 *   nothing sets (`PIM_TRIGGERS_MIGRATION`), and only in a space whose
 *   trigger engine is on: each item's record and its trigger, made as a
 *   draft (the shadow), in one transaction, so a crash at any step leaves
 *   the item as it was and applying again finishes it. Rollback deletes the
 *   shadow and leaves the item with its schedule or watch.
 *
 * **One owner.** Each record names the system that delivers its item
 * (`owner`). Applying writes `legacy`, and nothing in this module writes
 * anything else: the schedule or watch keeps delivering exactly as before,
 * and the store refuses to enable a trigger whose record says `legacy`
 * (`ownedElsewhere`, wired by ./engine.ts), so its shadow never fires. The
 * cutover, the step that would hand an item to its trigger, is not built.
 *
 * Nothing secret is copied: a watch's Standard Webhooks secret stays in its
 * watch. A record keeps the legacy item's kind and id, its trigger's id,
 * the owner and the phase; a plan keeps the spec and the binding a cutover
 * would adopt, by reference to the watch.
 */

import type { Schedule } from "agents";
import type { ScheduledTaskPayload } from "../extensions/services";
import type { AppWatch } from "../store";
import type { ConnectorSubscription } from "./connector";
import { type TriggerSpec, TRIGGER_DEFAULTS, TRIGGER_LIMITS, cronFields, parseTriggerSpec } from "./spec";
import type { Refusal, TriggerStore } from "./store";
import { isScheduledFiring, previewFirings } from "./time";
import { TriggerValidationError } from "./validate";

/** The deployment's gate for applying a migration: unset, or anything but `internal`, and nothing is applied. No deployment sets it. */
export const MIGRATION_VARIABLE = "PIM_TRIGGERS_MIGRATION";

/** Whether this deployment lets a space's schedules and watches be moved to shadow triggers. */
export function migrationAllowed(env: unknown): boolean {
	return (env as Record<string, unknown> | null)?.[MIGRATION_VARIABLE] === "internal";
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS pim_trigger_migrations (
	legacy_kind TEXT NOT NULL CHECK (legacy_kind IN ('schedule', 'watch')),
	legacy_id TEXT NOT NULL,
	attempt INTEGER NOT NULL,
	trigger_id TEXT NOT NULL UNIQUE,
	owner TEXT NOT NULL CHECK (owner IN ('legacy', 'trigger')),
	phase TEXT NOT NULL CHECK (phase IN ('shadow', 'rolled_back')),
	created_at INTEGER NOT NULL,
	updated_at INTEGER NOT NULL,
	PRIMARY KEY (legacy_kind, legacy_id)
);
`;

/** The migration's table, made only by applying or rolling back. */
export const MIGRATION_TABLES = ["pim_trigger_migrations"] as const;

/** The schedule `schedule_task` makes, as the agents SDK keeps it. */
export type LegacySchedule = Pick<Schedule<ScheduledTaskPayload>, "id" | "payload"> &
	(
		| { readonly type: "scheduled"; readonly time: number }
		| { readonly type: "delayed"; readonly time: number; readonly delayInSeconds: number }
		| { readonly type: "cron"; readonly time: number; readonly cron: string }
		| { readonly type: "interval"; readonly time: number; readonly intervalSeconds: number }
	);

export type LegacyKind = "schedule" | "watch";

/** What the mapping reads of the space, resolved beforehand so the mapping itself is pure. */
export type MigrationContext = {
	/** The triggers' clock. */
	readonly now: number;
	/** The space's owner, as watches' callbacks name it. */
	readonly owner: string;
	/** The deployment's public origin, which watches' callback URLs were built on; null if unknown. */
	readonly publicUrl: string | null;
	readonly agentExists: (agentId: string) => boolean;
	/** The agent of a chat, as Pim says (`agents.ofSession`); null where it doesn't exist yet. */
	readonly chatAgent: (chatId: string) => string | null;
	/** Whether a chat is one a trigger may deliver to, as the trigger host's preflight checks it (`TriggerSpace.chatOpen`). */
	readonly chatOpen: (chatId: string) => boolean;
};

/** What a migrated trigger would do differently from its schedule or watch once it delivers; accepted, and documented. */
export type MigrationDifference =
	/** The run is told `[Trigger "<label>" <id>]` and when it was due, not `[Scheduled task …]` or `[Connector event] …`. */
	| "run_text"
	/** A firing more than 7 days late (`maxLatenessMs`, `catchUpMs`) is recorded as missed; a schedule runs however late its alarm is. */
	| "lateness_bound"
	/** A run the run limit or a suspension refuses is tried again until `deliverBy`; a schedule's firing is skipped, and the person told once a day. */
	| "refused_runs_retry"
	/** The agent is fixed when migrated; a schedule resolves it at each firing (its chat's agent, or the majordomo's choice while that agent exists). */
	| "agent_fixed"
	/** The schedule or watch had no label, so the trigger's is made from its instruction's first line or its event's name. */
	| "label_derived";

/** What must be built before a migrated item may be handed to its trigger; until then its schedule or watch stays its owner. */
export type CutoverBlocker =
	/** Each schedule's firing notifies open apps (`kind: "scheduled"`); a trigger's handoff doesn't yet. */
	| "firing_notification"
	/** A watch's run reads what the event carried; a trigger's run is told only its name, id and time. */
	| "event_contents"
	/** The ingress adapter is stricter than a watch's receiver (`X-MCP-Subscription-Id`, `webhook-id` equal to `eventId`, a `timestamp`); each connector must be checked against it. */
	| "stricter_ingress"
	/** An event a watch took in before the cutover and the provider sends again after it must be a duplicate: the trigger must honor the watch's operation ids (`event:<watch>:<eventId>`), which nothing does yet. */
	| "legacy_event_ids"
	/** Nothing yet routes `/mcp/events/<owner>/<watch>` to the ingress adapter, or adopts the watch's binding in the subscription manager. */
	| "binding_adoption";

/** Why a schedule or watch can't be moved. Nothing is written for it. */
export type UnsupportedReason =
	/** `interval` schedules: `schedule_task` never makes them, and their timing in the agents SDK isn't matched. */
	| "interval_schedule"
	/** A one-time schedule whose time has come or passed: its alarm is due, and it stays with it. */
	| "one_time_due"
	/** A cron expression triggers can't read the same way: names, `@daily`, seconds, `L`, `W` or `#` (`cron_syntax`), a step from a single value (`5/15`, which the agents SDK reads as `5`), or day fields the SDK combines differently. */
	| "cron_syntax"
	| "cron_semantics"
	/** No firing from now within the supported range and the search horizon. */
	| "schedule_exhausted"
	/** The chat it delivers to is deleted, or isn't one a trigger may deliver to (another agent's seat in a group chat, an old task's conversation, a visit). */
	| "chat_unavailable"
	/** The agent it would be owned by doesn't exist yet: a space whose majordomo was never made. */
	| "agent_unavailable"
	/** A field the spec can't hold as it is: too long, control characters, arguments past 4 KB or 6 levels. */
	| "invalid_field"
	/** A watch that ended. */
	| "watch_ended"
	/** A watch whose connector hasn't given a subscription id yet: there is no provider subscription to adopt. */
	| "watch_not_subscribed"
	/** A watch whose callback URL isn't the one its owner and id would make now: adopting it would subscribe a new URL. */
	| "callback_changed";

/** The connector binding a watch's trigger would adopt at cutover, by reference: nothing here is secret. */
export type BindingAdoption = {
	/** The callback's key: the watch's id, so its URL stays `/mcp/events/<owner>/<watch id>`. */
	readonly key: string;
	readonly callbackPath: string;
	/** The watch's `remoteId`: no new provider subscription is made. */
	readonly providerSubscriptionId: string;
	/** The secret stays in the watch's row, and the binding reads it from there; it is never copied. */
	readonly secret: "kept_in_watch";
	/** Whether the watch has a cursor, which becomes the source's checkpoint cursor. Its value isn't copied here. */
	readonly cursor: "kept" | "none";
	readonly refreshBefore: number | null;
	/** The operation id a watch submitted each event under, with `<eventId>` in place of the event's id. */
	readonly legacyOperationId: string;
};

export type MigrationRecord = {
	readonly kind: LegacyKind;
	readonly legacyId: string;
	/** Which time it was applied: each rollback and new apply makes a new trigger, since a deleted trigger's id is never reused. */
	readonly attempt: number;
	readonly triggerId: string;
	/** The system that delivers the item. Only `legacy` is ever written. */
	readonly owner: "legacy" | "trigger";
	readonly phase: "shadow" | "rolled_back";
	readonly createdAt: number;
	readonly updatedAt: number;
};

type ItemBase = { readonly kind: LegacyKind; readonly legacyId: string; readonly record: MigrationRecord | null };

export type MigratableItem = ItemBase & {
	readonly status: "migratable";
	/** The id its trigger has, or would have when applied now. */
	readonly triggerId: string;
	readonly spec: TriggerSpec;
	readonly differences: readonly MigrationDifference[];
	readonly cutoverBlockers: readonly CutoverBlocker[];
	readonly binding: BindingAdoption | null;
};

export type UnsupportedItem = ItemBase & { readonly status: "unsupported"; readonly reason: UnsupportedReason; readonly detail: string };

export type PlanItem = MigratableItem | UnsupportedItem;

export type MigrationPlan = {
	readonly items: readonly PlanItem[];
	/** Records whose schedule or watch no longer exists, such as a one-time schedule that has fired since. Kept, as their shadows are, until rolled back. */
	readonly orphans: readonly MigrationRecord[];
};

/** The id a migrated item's trigger has at `attempt`. */
export function migratedTriggerId(kind: LegacyKind, legacyId: string, attempt: number): string {
	return `legacy:${kind}:${legacyId}:${attempt}`;
}

/** The operation id a watch submitted an event under, which a cutover must honor so an event isn't run twice. As app-events.ts makes it. */
export function legacyEventOperationId(watchId: string, eventId: string): string {
	return `event:${watchId}:${eventId}`;
}

/**
 * The binding a watch's trigger reads at cutover, as the ingress adapter
 * takes it: the watch's own key, secret and provider subscription id, for
 * the trigger at its generation then. Built from the live watch when it is
 * needed, never stored. Nothing calls it in Pim yet.
 */
export function adoptedSubscription(watch: AppWatch, trigger: { readonly id: string; readonly generation: number; readonly sourceRevision: number }): ConnectorSubscription {
	return {
		key: watch.id,
		triggerId: trigger.id,
		sourceRevision: trigger.sourceRevision,
		generation: trigger.generation,
		connectorId: watch.serverId,
		event: watch.event,
		providerSubscriptionId: watch.remoteId,
		secret: watch.secret,
		status: watch.status === "ended" ? "revoked" : "active",
	};
}

/** Maps every schedule and watch, with what is already recorded. Pure: the same input and context give the same plan. */
export function planMigration(
	input: { readonly schedules: readonly LegacySchedule[]; readonly watches: readonly AppWatch[]; readonly records: readonly MigrationRecord[] },
	context: MigrationContext,
): MigrationPlan {
	const records = new Map(input.records.map((record) => [`${record.kind}:${record.legacyId}`, record]));
	const recordOf = (kind: LegacyKind, id: string) => records.get(`${kind}:${id}`) ?? null;
	const items = [
		...[...input.schedules].sort((a, b) => compare(a.id, b.id)).map((schedule) => mapSchedule(schedule, context, recordOf("schedule", schedule.id))),
		...[...input.watches].sort((a, b) => compare(a.id, b.id)).map((watch) => mapWatch(watch, context, recordOf("watch", watch.id))),
	];
	const live = new Set(items.map((item) => `${item.kind}:${item.legacyId}`));
	const orphans = input.records.filter((record) => !live.has(`${record.kind}:${record.legacyId}`)).sort((a, b) => compare(`${a.kind}:${a.legacyId}`, `${b.kind}:${b.legacyId}`));
	return { items, orphans };
}

const compare = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);

/** The attempt an item is at: its record's, or the next one after a rollback. */
function attemptOf(record: MigrationRecord | null): number {
	if (!record) return 1;
	return record.phase === "rolled_back" ? record.attempt + 1 : record.attempt;
}

/** A schedule as a time trigger, or why it can't be one. */
export function mapSchedule(schedule: LegacySchedule, context: MigrationContext, record: MigrationRecord | null = null): PlanItem {
	const base = { kind: "schedule" as const, legacyId: schedule.id, record };
	const unsupported = (reason: UnsupportedReason, detail: string): UnsupportedItem => ({ ...base, status: "unsupported", reason, detail });
	const payload = schedule.payload;
	const differences: MigrationDifference[] = ["run_text", "lateness_bound", "refused_runs_retry", "agent_fixed"];

	let source: unknown = null;
	switch (schedule.type) {
		case "interval":
			return unsupported("interval_schedule", "schedule_task never makes interval schedules, and their timing isn't matched");
		case "scheduled":
		case "delayed": {
			// A delay is kept as the instant it ends at, which the agents SDK fires it at.
			const at = schedule.time * 1000;
			if (at <= context.now) return unsupported("one_time_due", "its time has come; its alarm runs it");
			source = { kind: "time", schedule: "once", at, maxLatenessMs: TRIGGER_DEFAULTS.maxLatenessMs };
			break;
		}
		case "cron": {
			const problem = cronMismatch(schedule.cron);
			if (problem) return unsupported(problem.reason, problem.detail);
			// The agents SDK reads cron in the runtime's zone, which on Workers is UTC: kept as it is, in UTC.
			source = { kind: "time", schedule: "cron", expression: schedule.cron, timeZone: "UTC", catchUpMs: TRIGGER_DEFAULTS.maxLatenessMs };
			break;
		}
	}

	const newChat = payload.newChat === true;
	if (!newChat && !context.chatOpen(payload.session)) return unsupported("chat_unavailable", "its chat is deleted, or isn't one a trigger may deliver to");
	// The agent as runScheduledTask resolves it now: the majordomo's choice while it exists, else the chat's.
	const agent = newChat && payload.agent && context.agentExists(payload.agent) ? payload.agent : context.chatAgent(payload.session);
	if (agent === null) return unsupported("agent_unavailable", "the agent of its chat doesn't exist yet");
	let label = payload.label;
	if (label === undefined || label === "") {
		label = firstLine(payload.instruction);
		differences.push("label_derived");
	}
	const triggerId = migratedTriggerId("schedule", schedule.id, attemptOf(record));
	const parsed = parse(
		{
			version: 1,
			owningAgentId: agent,
			originChatId: payload.session,
			label,
			instruction: payload.instruction,
			source,
			condition: null,
			destination: newChat ? { type: "new_chat" } : { type: "existing_chat", chatId: payload.session },
			delivery: { rawSamples: false },
			authorizationRef: null,
		},
		triggerId,
	);
	if (!("spec" in parsed)) return unsupported(parsed.reason, parsed.detail);
	if (parsed.spec.source.kind === "time" && !firesFrom(parsed.spec, context.now)) return unsupported("schedule_exhausted", "no firing from now within the supported range");
	return { ...base, status: "migratable", triggerId, spec: parsed.spec, differences, cutoverBlockers: ["firing_notification"], binding: null };
}

/** A watch as a trigger on its connector's event, with the binding it would adopt, or why it can't be one. */
export function mapWatch(watch: AppWatch, context: MigrationContext, record: MigrationRecord | null = null): PlanItem {
	const base = { kind: "watch" as const, legacyId: watch.id, record };
	const unsupported = (reason: UnsupportedReason, detail: string): UnsupportedItem => ({ ...base, status: "unsupported", reason, detail });
	if (watch.status === "ended") return unsupported("watch_ended", "the watch ended");
	if (watch.status !== "active" || watch.remoteId === null) return unsupported("watch_not_subscribed", "the connector hasn't given a subscription id to adopt");
	const callbackPath = `/mcp/events/${context.owner}/${watch.id}`;
	if (context.publicUrl === null || watch.url !== `${context.publicUrl.replace(/\/$/, "")}${callbackPath}`) {
		return unsupported("callback_changed", "its callback URL isn't the one Pim would make for it now");
	}
	if (!context.chatOpen(watch.session)) return unsupported("chat_unavailable", "its chat is deleted, or isn't one a trigger may deliver to");
	const agent = context.chatAgent(watch.session);
	if (agent === null) return unsupported("agent_unavailable", "the agent of its chat doesn't exist yet");
	const triggerId = migratedTriggerId("watch", watch.id, attemptOf(record));
	const parsed = parse(
		{
			version: 1,
			owningAgentId: agent,
			originChatId: watch.session,
			label: `Connector event ${watch.event}`.slice(0, TRIGGER_LIMITS.labelLength),
			instruction: watch.instruction,
			source: { kind: "connector_event", connectorId: watch.serverId, event: watch.event, arguments: watch.arguments },
			condition: null,
			destination: { type: "existing_chat", chatId: watch.session },
			delivery: { rawSamples: false },
			authorizationRef: null,
		},
		triggerId,
	);
	if (!("spec" in parsed)) return unsupported(parsed.reason, parsed.detail);
	return {
		...base,
		status: "migratable",
		triggerId,
		spec: parsed.spec,
		differences: ["run_text", "agent_fixed", "label_derived"],
		cutoverBlockers: ["event_contents", "stricter_ingress", "legacy_event_ids", "binding_adoption"],
		binding: {
			key: watch.id,
			callbackPath,
			providerSubscriptionId: watch.remoteId,
			secret: "kept_in_watch",
			cursor: watch.cursor === null ? "none" : "kept",
			refreshBefore: watch.refreshBefore,
			legacyOperationId: legacyEventOperationId(watch.id, "<eventId>"),
		},
	};
}

/** Reads a spec as the store would, naming the field it can't take. */
function parse(spec: unknown, triggerId: string): { spec: TriggerSpec } | { reason: UnsupportedReason; detail: string } {
	if (triggerId.length > 128 || /\s/.test(triggerId)) return { reason: "invalid_field", detail: "its id is too long to name a trigger" };
	try {
		return { spec: parseTriggerSpec(spec) };
	} catch (error) {
		if (!(error instanceof TriggerValidationError)) throw error;
		const path = error.path;
		if (path.startsWith("spec.source.expression")) return { reason: "cron_syntax", detail: error.message };
		// The field, never its value: a field's text may be the person's.
		return { reason: "invalid_field", detail: `${path} can't be kept as it is` };
	}
}

/** A label from an instruction, as Pim titles a schedule's chats: its first line, cut to the spec's length. */
function firstLine(instruction: string): string {
	const line = instruction.trim().split(/\r?\n/)[0]!.trim();
	return line.length > TRIGGER_LIMITS.labelLength ? `${line.slice(0, TRIGGER_LIMITS.labelLength - 1).trimEnd()}…` : line;
}

/** Whether a time spec fires from `now` on, as the store checks it when it is saved. */
function firesFrom(spec: TriggerSpec, now: number): boolean {
	if (spec.source.kind !== "time") return true;
	try {
		const first = isScheduledFiring(spec.source, now) ? now : previewFirings(spec.source, { now, count: 1 }).firings[0]?.at;
		return first !== undefined && first <= TRIGGER_LIMITS.latestAt;
	} catch {
		return false;
	}
}

/**
 * Where triggers would read a schedule's cron expression differently from
 * the agents SDK (cron-schedule), which fired it: null when they read it
 * the same, for every minute of every day.
 *
 * - Triggers refuse what the SDK also accepts: names, macros, a seconds
 *   field (`cron_syntax`).
 * - The SDK reads `a/n` as `a` alone; triggers read it as from `a` on.
 * - The SDK takes a day field as restricted unless it names every value;
 *   triggers, unless it starts with `*`. Both then match a day on either
 *   field when both are restricted, and on both fields otherwise. The two
 *   readings are compared on every day of the month and of the week.
 */
export function cronMismatch(expression: string): { reason: "cron_syntax" | "cron_semantics"; detail: string } | null {
	let fields: ReturnType<typeof cronFields>;
	try {
		fields = cronFields(expression, "cron");
	} catch (error) {
		if (error instanceof TriggerValidationError) return { reason: "cron_syntax", detail: error.message };
		throw error;
	}
	if (
		fields.expression
			.split(" ")
			.flatMap((field) => field.split(","))
			.some((item) => /^\d+\/\d+$/.test(item))
	) {
		return { reason: "cron_semantics", detail: "cron: a step from a single value (a/n), which the schedule reads as a alone" };
	}
	const legacyDays = fields.days.size !== 31;
	const legacyWeekdays = fields.weekdays.size !== 7;
	for (let day = 1; day <= 31; day++) {
		for (let weekday = 0; weekday <= 6; weekday++) {
			const onDay = fields.days.has(day);
			const onWeekday = fields.weekdays.has(weekday);
			const legacy = legacyDays && legacyWeekdays ? onDay || onWeekday : legacyDays ? onDay : legacyWeekdays ? onWeekday : true;
			const triggers = fields.daysAndWeekdays ? onDay && onWeekday : onDay || onWeekday;
			if (legacy !== triggers) return { reason: "cron_semantics", detail: "cron: its day of month and day of week combine differently in triggers" };
		}
	}
	return null;
}

type Row = Record<string, SqlStorageValue>;

const recordOf = (row: Row): MigrationRecord => ({
	kind: String(row.legacy_kind) as LegacyKind,
	legacyId: String(row.legacy_id),
	attempt: Number(row.attempt),
	triggerId: String(row.trigger_id),
	owner: String(row.owner) as MigrationRecord["owner"],
	phase: String(row.phase) as MigrationRecord["phase"],
	createdAt: Number(row.created_at),
	updatedAt: Number(row.updated_at),
});

function hasTable(sql: SqlStorage): boolean {
	return sql.exec("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?", MIGRATION_TABLES[0]).toArray().length > 0;
}

/** Every record, read without making the table: none where nothing was ever applied. */
export function migrationRecords(sql: SqlStorage): MigrationRecord[] {
	if (!hasTable(sql)) return [];
	return sql.exec("SELECT * FROM pim_trigger_migrations ORDER BY legacy_kind, legacy_id").toArray().map(recordOf);
}

/** The record of the item trigger `id` shadows, if it is one; read without making the table. */
export function migrationRecordOf(sql: SqlStorage, id: string): MigrationRecord | null {
	if (!hasTable(sql)) return null;
	const [row] = sql.exec("SELECT * FROM pim_trigger_migrations WHERE trigger_id = ?", id).toArray();
	return row ? recordOf(row) : null;
}

/**
 * Whether a schedule or watch still delivers the work of trigger `id`, so
 * enabling the trigger would deliver it twice: the store's
 * `ownedElsewhere`. Read without making the table.
 */
export function ownedByLegacy(sql: SqlStorage, id: string): boolean {
	if (!hasTable(sql)) return false;
	const [row] = sql.exec("SELECT owner FROM pim_trigger_migrations WHERE trigger_id = ?", id).toArray();
	return row !== undefined && String(row.owner) !== "trigger";
}

export type ApplyOutcome =
	| { readonly kind: LegacyKind; readonly legacyId: string; readonly outcome: "created" | "already"; readonly triggerId: string }
	| { readonly kind: LegacyKind; readonly legacyId: string; readonly outcome: "unsupported"; readonly reason: UnsupportedReason }
	/** The store refused its trigger (such as an id another trigger took); nothing was written for it. */
	| { readonly kind: LegacyKind; readonly legacyId: string; readonly outcome: "refused"; readonly reason: string };

export type RollbackOutcome = { readonly kind: LegacyKind; readonly legacyId: string; readonly triggerId: string; readonly outcome: "rolled_back" | "already" };

export type TriggerMigrationOptions = {
	readonly store: Pick<TriggerStore, "create" | "get" | "remove">;
	/** The database's transactions (`transactionSync`); they nest. */
	readonly transaction: <T>(work: () => T) => T;
	readonly now: () => number;
};

/** Thrown inside an item's transaction to undo it when the store refuses its trigger. */
class Refused extends Error {
	constructor(readonly reason: string) {
		super(reason);
	}
}

/**
 * Applies a plan and rolls it back, in a space whose trigger engine is on
 * and where the deployment allows it. Makes its table when constructed.
 */
export class TriggerMigration {
	readonly #sql: SqlStorage;
	readonly #options: TriggerMigrationOptions;

	constructor(sql: SqlStorage, options: TriggerMigrationOptions) {
		this.#sql = sql;
		this.#options = options;
		this.#sql.exec(SCHEMA);
	}

	records(): MigrationRecord[] {
		return migrationRecords(this.#sql);
	}

	#record(kind: LegacyKind, legacyId: string): MigrationRecord | null {
		const [row] = this.#sql.exec("SELECT * FROM pim_trigger_migrations WHERE legacy_kind = ? AND legacy_id = ?", kind, legacyId).toArray();
		return row ? recordOf(row) : null;
	}

	/**
	 * Makes each migratable item's shadow: its record, owned by its schedule
	 * or watch, and its trigger as a draft, in one transaction per item. An
	 * item already shadowed is left as it is; one rolled back is made again
	 * as a new trigger. Unsupported items are reported, with nothing written.
	 * Idempotent, and resumable after a crash at any point.
	 */
	apply(plan: MigrationPlan): ApplyOutcome[] {
		return plan.items.map((item): ApplyOutcome => {
			const { kind, legacyId } = item;
			if (item.status === "unsupported") {
				const shadow = this.#record(kind, legacyId);
				if (shadow?.phase === "shadow") return { kind, legacyId, outcome: "already", triggerId: shadow.triggerId };
				return { kind, legacyId, outcome: "unsupported", reason: item.reason };
			}
			try {
				return this.#options.transaction((): ApplyOutcome => {
					const record = this.#record(kind, legacyId);
					if (record?.phase === "shadow") return { kind, legacyId, outcome: "already", triggerId: record.triggerId };
					const attempt = attemptOf(record);
					const triggerId = migratedTriggerId(kind, legacyId, attempt);
					const now = this.#options.now();
					// The record first, so the trigger is owned by its schedule or watch from the moment it exists.
					this.#sql.exec(
						"INSERT INTO pim_trigger_migrations (legacy_kind, legacy_id, attempt, trigger_id, owner, phase, created_at, updated_at) VALUES (?, ?, ?, ?, 'legacy', 'shadow', ?, ?) ON CONFLICT (legacy_kind, legacy_id) DO UPDATE SET attempt = excluded.attempt, trigger_id = excluded.trigger_id, owner = 'legacy', phase = 'shadow', updated_at = excluded.updated_at",
						kind,
						legacyId,
						attempt,
						triggerId,
						now,
						now,
					);
					let created: ReturnType<TriggerStore["create"]>;
					try {
						created = this.#options.store.create({ id: triggerId, spec: item.spec, lifecycle: "draft" });
					} catch (error) {
						if (error instanceof TriggerValidationError) throw new Refused(error.path);
						throw error;
					}
					if (!created.ok) throw new Refused((created as Refusal).reason);
					return { kind, legacyId, outcome: "created", triggerId };
				});
			} catch (error) {
				if (error instanceof Refused) return { kind, legacyId, outcome: "refused", reason: error.reason };
				throw error;
			}
		});
	}

	/**
	 * Gives each shadowed item back to its schedule or watch for good: its
	 * trigger is deleted, which keeps its record as any deleted trigger's,
	 * and its record says `legacy`, `rolled_back`. Only `which` when given.
	 * Idempotent, and each item is one transaction.
	 */
	rollback(which?: readonly { readonly kind: LegacyKind; readonly legacyId: string }[]): RollbackOutcome[] {
		const wanted = which ? new Set(which.map((item) => `${item.kind}:${item.legacyId}`)) : null;
		return this.records()
			.filter((record) => wanted === null || wanted.has(`${record.kind}:${record.legacyId}`))
			.map((record) =>
				this.#options.transaction((): RollbackOutcome => {
					const current = this.#record(record.kind, record.legacyId)!;
					const result = { kind: current.kind, legacyId: current.legacyId, triggerId: current.triggerId };
					if (current.phase === "rolled_back") return { ...result, outcome: "already" };
					const trigger = this.#options.store.get(current.triggerId);
					if (trigger && trigger.lifecycle !== "deleted") {
						const removed = this.#options.store.remove({ id: current.triggerId });
						if (!removed.ok) throw new Error(`the shadow trigger could not be deleted: ${removed.reason}`);
					}
					this.#sql.exec(
						"UPDATE pim_trigger_migrations SET owner = 'legacy', phase = 'rolled_back', updated_at = ? WHERE legacy_kind = ? AND legacy_id = ?",
						this.#options.now(),
						current.kind,
						current.legacyId,
					);
					return { ...result, outcome: "rolled_back" };
				}),
			);
	}
}
