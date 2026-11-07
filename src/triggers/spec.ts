/**
 * What a trigger is: work an agent does when something happens, such as at
 * a time, on a connector's event, or when something it watches on the
 * person's computer changes. Triggers will replace schedules
 * (../extensions/schedule.ts) and connector watches (../extensions/app-events.ts);
 * for now nothing in Pim uses this module. See docs/triggers.md.
 *
 * A trigger's spec is what the person or agent configured, kept as
 * immutable revisions (./store.ts). Its lifecycle, health and generation
 * live beside the spec and are not part of a revision. The space a trigger
 * belongs to is the Durable Object that stores it, never a field: nothing
 * an event carries can move a trigger to another space.
 */

import { type Condition, type ConditionMode, parseCondition } from "./condition";
import { type JsonObject, TriggerValidationError, absolutePath, flag, integer, jsonObject, opaqueId, oneOf, record, text } from "./validate";

/** The version of the spec's shape; a stored spec says which it was written in. */
export const TRIGGER_SPEC_VERSION = 1;

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

/**
 * The defaults, and the bounds, a spec is read with. The defaults are
 * written into the stored spec, so a later change of default never changes
 * an existing trigger.
 */
export const TRIGGER_DEFAULTS = {
	/** A one-time trigger that runs later than this is missed rather than run. */
	onceMaxLatenessMs: HOUR,
	/** A recurring trigger runs its latest due firing if it is at most this late; older ones are missed. */
	recurringCatchUpMs: HOUR,
	maxLatenessMs: 7 * DAY,
	minIntervalMs: MINUTE,
	maxIntervalMs: 366 * DAY,
	pollMinIntervalMs: MINUTE,
	pollIntervalMs: 5 * MINUTE,
	pollMaxIntervalMs: DAY,
	/** How long one poll may take; also the most it may be set to. */
	pollDeadlineMs: 30_000,
	pollMinDeadlineMs: 1_000,
	/** Undelivered occurrences a trigger on events holds before it refuses more (the source retries). */
	maxPendingEvents: 20,
	maxPendingEventsLimit: 100,
} as const;

export const TRIGGER_LIMITS = {
	labelLength: 120,
	instructionLength: 10_000,
	commandLength: 4_000,
	nameLength: 128,
	/** The longest a process watch may run: a process's exit is watched for at most this long. */
	maxProcessWatchMs: 7 * 24 * 60 * 60_000,
	cronLength: 128,
	timeZoneLength: 64,
	authorizationRefLength: 256,
	connectorArguments: { maxBytes: 4_096, maxDepth: 6 },
	/** 2000-01-01 and 2100-01-01: a one-time trigger's time is within these. */
	earliestAt: 946_684_800_000,
	latestAt: 4_102_444_800_000,
} as const;

export const TRIGGER_LIFECYCLES = ["draft", "enabled", "paused", "ended", "deleted"] as const;
/** What the person wants of a trigger. `deleted` is a tombstone: the trigger and what it recorded are gone. */
export type TriggerLifecycle = (typeof TRIGGER_LIFECYCLES)[number];

export const TRIGGER_HEALTHS = ["unknown", "healthy", "waiting_computer", "reconnecting", "gap", "auth_required", "budget_blocked", "configuration_error"] as const;
/** How the trigger's source is doing, apart from what the person wants of it. */
export type TriggerHealth = (typeof TRIGGER_HEALTHS)[number];

export type OnceSource = { readonly kind: "time"; readonly schedule: "once"; readonly at: number; readonly maxLatenessMs: number };
/** Five cron fields read in `timeZone`; triggers moved from today's schedules keep `UTC`. */
export type CronSource = { readonly kind: "time"; readonly schedule: "cron"; readonly expression: string; readonly timeZone: string; readonly catchUpMs: number };
/** Every `everyMs` from `anchorAt` on. */
export type IntervalSource = { readonly kind: "time"; readonly schedule: "interval"; readonly everyMs: number; readonly anchorAt: number; readonly catchUpMs: number };
export type TimeSource = OnceSource | CronSource | IntervalSource;

/** One event type of a connected connector, subscribed to with `arguments`. */
export type ConnectorEventSource = { readonly kind: "connector_event"; readonly connectorId: string; readonly event: string; readonly arguments: JsonObject };
/** A shell command on the person's computer, run every `intervalMs`; what it prints, as JSON, is the observation. */
export type PollSource = { readonly kind: "poll"; readonly command: string; readonly cwd: string | null; readonly intervalMs: number; readonly deadlineMs: number };
/** A shell command on the person's computer that keeps running; each line it prints, as a JSON object, is an event. */
export type StreamSource = { readonly kind: "stream"; readonly command: string; readonly cwd: string | null };
/**
 * The exit of one process instance on the person's computer, named by the
 * `handle` pim-computer gave it when it started the process: one event,
 * `{ exitCode, signal }`, after which the trigger ends. Watched until
 * `expiresAt` at the latest. Matching processes by name, which can't tell
 * one run from the next, is not supported.
 */
export type ProcessSource = { readonly kind: "process"; readonly handle: string; readonly expiresAt: number };
export const FILE_EVENTS = ["created", "modified", "deleted"] as const;
/** Changes to a file, or a folder's files, on the person's computer. */
export type FileSource = { readonly kind: "file"; readonly path: string; readonly events: readonly (typeof FILE_EVENTS)[number][]; readonly recursive: boolean };

export type TriggerSource = TimeSource | ConnectorEventSource | PollSource | StreamSource | ProcessSource | FileSource;
export const SOURCE_KINDS = ["time", "connector_event", "poll", "stream", "process", "file"] as const;
export type SourceKind = TriggerSource["kind"];

/** Where each occurrence goes: on in a chat that exists (the trigger's own, by default), or a new chat with the owning agent each time. */
export type TriggerDestination = { readonly type: "existing_chat"; readonly chatId: string } | { readonly type: "new_chat" };

export type DeliveryPolicy = {
	/**
	 * Keeping what was observed with an occurrence. Not supported yet, so
	 * always false: an occurrence keeps why it fired, when, and which fields
	 * the condition found, never their values or an event's body.
	 */
	readonly rawSamples: false;
	/** For sources of events: how many undelivered occurrences it holds. Null for the rest, which hold one pending snapshot. */
	readonly maxPendingEvents: number | null;
};

export type TriggerSpec = {
	readonly version: typeof TRIGGER_SPEC_VERSION;
	/** The agent whose work it is. Fixed for the trigger's life. */
	readonly owningAgentId: string;
	/** The chat it was made in. Fixed for the trigger's life. */
	readonly originChatId: string;
	readonly label: string;
	readonly instruction: string;
	readonly source: TriggerSource;
	readonly condition: Condition | null;
	readonly destination: TriggerDestination;
	readonly delivery: DeliveryPolicy;
	/**
	 * The approval or grant that lets this source run, such as an approval's
	 * id. Sources that run on the person's computer need one, which the
	 * host's check accepts (./store.ts), to be enabled, and a new one when
	 * their source changes. The reference alone proves nothing.
	 */
	readonly authorizationRef: string | null;
};

/** Sources that run commands or read files on the person's computer, as the user who runs pim-computer. */
export function runsOnComputer(source: TriggerSource): boolean {
	return source.kind === "poll" || source.kind === "stream" || source.kind === "process" || source.kind === "file";
}

/** How the source's observations become occurrences; null for time, which takes no condition. */
export function conditionMode(source: TriggerSource): ConditionMode | null {
	if (source.kind === "time") return null;
	return source.kind === "poll" ? "edge" : "filter";
}

/** Reads a spec, filling in the defaults; throws a `TriggerValidationError` naming the first field that is wrong. */
export function parseTriggerSpec(value: unknown): TriggerSpec {
	const given = record(value, "spec", ["version", "owningAgentId", "originChatId", "label", "instruction", "source", "condition", "destination", "delivery", "authorizationRef"]);
	if (given.version !== TRIGGER_SPEC_VERSION) throw new TriggerValidationError("spec.version", `must be ${TRIGGER_SPEC_VERSION}`);
	const source = parseSource(given.source);
	const mode = conditionMode(source);
	let condition: Condition | null = null;
	if (given.condition !== undefined && given.condition !== null) {
		if (mode === null) throw new TriggerValidationError("spec.condition", "a time source takes no condition");
		condition = parseCondition(given.condition, mode, "spec.condition");
		// A state checked every interval goes stale after two of them unless the spec says otherwise.
		if (mode === "edge" && condition.staleAfterMs === null && source.kind === "poll") {
			condition = { ...condition, staleAfterMs: 2 * source.intervalMs };
		}
	}
	if (mode === "edge" && condition === null) {
		throw new TriggerValidationError("spec.condition", `a ${source.kind} source needs a condition; for work on a timetable, use a time source`);
	}
	return {
		version: TRIGGER_SPEC_VERSION,
		owningAgentId: opaqueId(given.owningAgentId, "spec.owningAgentId"),
		originChatId: opaqueId(given.originChatId, "spec.originChatId"),
		label: text(given.label, "spec.label", TRIGGER_LIMITS.labelLength),
		instruction: text(given.instruction, "spec.instruction", TRIGGER_LIMITS.instructionLength, { multiline: true }),
		source,
		condition,
		destination: parseDestination(given.destination),
		delivery: parseDelivery(given.delivery, mode),
		authorizationRef: given.authorizationRef === undefined || given.authorizationRef === null ? null : text(given.authorizationRef, "spec.authorizationRef", TRIGGER_LIMITS.authorizationRefLength),
	};
}

function parseSource(value: unknown): TriggerSource {
	const path = "spec.source";
	const kind = oneOf((record(value, path, ["kind", "schedule", "at", "maxLatenessMs", "expression", "timeZone", "catchUpMs", "everyMs", "anchorAt", "connectorId", "event", "arguments", "command", "cwd", "intervalMs", "deadlineMs", "handle", "expiresAt", "path", "events", "recursive"]) as { kind?: unknown }).kind, `${path}.kind`, SOURCE_KINDS);
	const at = (field: string) => `${path}.${field}`;
	switch (kind) {
		case "time": {
			const schedule = oneOf((value as { schedule?: unknown }).schedule, at("schedule"), ["once", "cron", "interval"] as const);
			if (schedule === "once") {
				const given = record(value, path, ["kind", "schedule", "at", "maxLatenessMs"]);
				return {
					kind,
					schedule,
					at: integer(given.at, at("at"), TRIGGER_LIMITS.earliestAt, TRIGGER_LIMITS.latestAt),
					maxLatenessMs: given.maxLatenessMs === undefined ? TRIGGER_DEFAULTS.onceMaxLatenessMs : integer(given.maxLatenessMs, at("maxLatenessMs"), 0, TRIGGER_DEFAULTS.maxLatenessMs),
				};
			}
			const catchUp = (given: Record<string, unknown>) =>
				given.catchUpMs === undefined ? TRIGGER_DEFAULTS.recurringCatchUpMs : integer(given.catchUpMs, at("catchUpMs"), 0, TRIGGER_DEFAULTS.maxLatenessMs);
			if (schedule === "cron") {
				const given = record(value, path, ["kind", "schedule", "expression", "timeZone", "catchUpMs"]);
				return { kind, schedule, expression: parseCron(given.expression, at("expression")), timeZone: parseTimeZone(given.timeZone, at("timeZone")), catchUpMs: catchUp(given) };
			}
			const given = record(value, path, ["kind", "schedule", "everyMs", "anchorAt", "catchUpMs"]);
			return {
				kind,
				schedule,
				everyMs: integer(given.everyMs, at("everyMs"), TRIGGER_DEFAULTS.minIntervalMs, TRIGGER_DEFAULTS.maxIntervalMs),
				anchorAt: integer(given.anchorAt, at("anchorAt"), TRIGGER_LIMITS.earliestAt, TRIGGER_LIMITS.latestAt),
				catchUpMs: catchUp(given),
			};
		}
		case "connector_event": {
			const given = record(value, path, ["kind", "connectorId", "event", "arguments"]);
			return {
				kind,
				connectorId: opaqueId(given.connectorId, at("connectorId")),
				event: text(given.event, at("event"), TRIGGER_LIMITS.nameLength),
				arguments: given.arguments === undefined ? {} : jsonObject(given.arguments, at("arguments"), TRIGGER_LIMITS.connectorArguments),
			};
		}
		case "poll": {
			const given = record(value, path, ["kind", "command", "cwd", "intervalMs", "deadlineMs"]);
			const intervalMs = given.intervalMs === undefined ? TRIGGER_DEFAULTS.pollIntervalMs : integer(given.intervalMs, at("intervalMs"), TRIGGER_DEFAULTS.pollMinIntervalMs, TRIGGER_DEFAULTS.pollMaxIntervalMs);
			const deadlineMs = given.deadlineMs === undefined ? TRIGGER_DEFAULTS.pollDeadlineMs : integer(given.deadlineMs, at("deadlineMs"), TRIGGER_DEFAULTS.pollMinDeadlineMs, TRIGGER_DEFAULTS.pollDeadlineMs);
			return { kind, command: text(given.command, at("command"), TRIGGER_LIMITS.commandLength, { multiline: true }), cwd: optionalPath(given.cwd, at("cwd")), intervalMs, deadlineMs };
		}
		case "stream": {
			const given = record(value, path, ["kind", "command", "cwd"]);
			return { kind, command: text(given.command, at("command"), TRIGGER_LIMITS.commandLength, { multiline: true }), cwd: optionalPath(given.cwd, at("cwd")) };
		}
		case "process": {
			const given = record(value, path, ["kind", "handle", "expiresAt"]);
			return {
				kind,
				handle: opaqueId(given.handle, at("handle")),
				expiresAt: integer(given.expiresAt, at("expiresAt"), TRIGGER_LIMITS.earliestAt, TRIGGER_LIMITS.latestAt),
			};
		}
		case "file": {
			const given = record(value, path, ["kind", "path", "events", "recursive"]);
			if (!Array.isArray(given.events) || given.events.length === 0 || given.events.length > FILE_EVENTS.length) {
				throw new TriggerValidationError(at("events"), `must list some of ${FILE_EVENTS.join(", ")}`);
			}
			const events = given.events.map((event, index) => oneOf(event, `${at("events")}[${index}]`, FILE_EVENTS));
			if (new Set(events).size !== events.length) throw new TriggerValidationError(at("events"), "must not repeat an event");
			return { kind, path: absolutePath(given.path, at("path")), events, recursive: given.recursive === undefined ? false : flag(given.recursive, at("recursive")) };
		}
	}
}

function optionalPath(value: unknown, path: string): string | null {
	return value === undefined || value === null ? null : absolutePath(value, path);
}

function parseDestination(value: unknown): TriggerDestination {
	const path = "spec.destination";
	const type = oneOf((record(value, path, ["type", "chatId"]) as { type?: unknown }).type, `${path}.type`, ["existing_chat", "new_chat"] as const);
	if (type === "new_chat") {
		record(value, path, ["type"]);
		return { type };
	}
	return { type, chatId: opaqueId((value as { chatId?: unknown }).chatId, `${path}.chatId`) };
}

function parseDelivery(value: unknown, mode: ConditionMode | null): DeliveryPolicy {
	const path = "spec.delivery";
	const given = value === undefined ? {} : record(value, path, ["rawSamples", "maxPendingEvents"]);
	if (given.rawSamples !== undefined && flag(given.rawSamples, `${path}.rawSamples`)) {
		throw new TriggerValidationError(`${path}.rawSamples`, "keeping what was observed is not supported yet");
	}
	const rawSamples = false;
	if (mode !== "filter") {
		if (given.maxPendingEvents !== undefined) throw new TriggerValidationError(`${path}.maxPendingEvents`, "applies only to sources of events; the rest hold one pending snapshot");
		return { rawSamples, maxPendingEvents: null };
	}
	const maxPendingEvents = given.maxPendingEvents === undefined ? TRIGGER_DEFAULTS.maxPendingEvents : integer(given.maxPendingEvents, `${path}.maxPendingEvents`, 1, TRIGGER_DEFAULTS.maxPendingEventsLimit);
	return { rawSamples, maxPendingEvents };
}

/** An IANA zone name (`Europe/Lisbon`) or `UTC`; offsets such as `+01:00` are refused, since they ignore daylight saving time. */
function parseTimeZone(value: unknown, path: string): string {
	const zone = text(value, path, TRIGGER_LIMITS.timeZoneLength);
	if (zone !== "UTC" && !/^[A-Za-z][A-Za-z_]*(\/[A-Za-z0-9_+-]+){1,2}$/.test(zone)) throw new TriggerValidationError(path, "must be an IANA time zone such as Europe/Lisbon, or UTC");
	try {
		new Intl.DateTimeFormat("en-US", { timeZone: zone });
	} catch {
		throw new TriggerValidationError(path, `${zone} is not a time zone this runtime knows`);
	}
	return zone;
}

const CRON_FIELDS = [
	{ name: "minute", min: 0, max: 59 },
	{ name: "hour", min: 0, max: 23 },
	{ name: "day of month", min: 1, max: 31 },
	{ name: "month", min: 1, max: 12 },
	{ name: "day of week", min: 0, max: 7 },
] as const;

/** Days in each month at most (February in a leap year). */
const MONTH_DAYS = [31, 29, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];

/**
 * Five cron fields, each `*`, a number, a range `a-b`, either with a step
 * `/n`, or a comma-separated list of those. Names (`MON`), `?`, `L`, `W`,
 * `#`, seconds and macros such as `@daily` are refused rather than guessed
 * at, and so is an expression that names no date that exists.
 */
export function parseCron(value: unknown, path: string): string {
	const expression = text(value, path, TRIGGER_LIMITS.cronLength);
	const fields = expression.trim().split(/\s+/);
	if (fields.length !== 5) throw new TriggerValidationError(path, "must have five fields: minute, hour, day of month, month, day of week");
	const sets = fields.map((field, index) => cronField(field, CRON_FIELDS[index]!, path));
	const [, , days, months] = sets as [Set<number>, Set<number>, Set<number>, Set<number>, Set<number>];
	// With a restricted day of week, cron fires on either match, so only a day of month alone can name nothing.
	if (fields[4] === "*" && fields[2] !== "*" && ![...months].some((month) => [...days].some((day) => day <= MONTH_DAYS[month - 1]!))) {
		throw new TriggerValidationError(path, "names no day that exists in its months");
	}
	return fields.join(" ");
}

function cronField(field: string, bounds: (typeof CRON_FIELDS)[number], path: string): Set<number> {
	const values = new Set<number>();
	const items = field.split(",");
	if (items.length > 60) throw new TriggerValidationError(path, `has too many items in its ${bounds.name} field`);
	for (const item of items) {
		const match = /^(\*|(\d{1,2})(?:-(\d{1,2}))?)(?:\/(\d{1,2}))?$/.exec(item);
		if (!match) throw new TriggerValidationError(path, `can't read ${JSON.stringify(item)} in its ${bounds.name} field: use *, a number, a range a-b, a step /n, or a list`);
		const [, , low, high, step] = match;
		const from = low === undefined ? bounds.min : Number(low);
		// `a/n` alone means from a to the end, as in Vixie cron.
		const to = high !== undefined ? Number(high) : low === undefined || step !== undefined ? bounds.max : from;
		const by = step === undefined ? 1 : Number(step);
		if (from < bounds.min || to > bounds.max || from > to) throw new TriggerValidationError(path, `has ${JSON.stringify(item)} outside ${bounds.min}-${bounds.max} in its ${bounds.name} field`);
		if (by < 1 || by > bounds.max) throw new TriggerValidationError(path, `has a step outside 1-${bounds.max} in its ${bounds.name} field`);
		for (let value = from; value <= to; value += by) values.add(value);
	}
	return values;
}
