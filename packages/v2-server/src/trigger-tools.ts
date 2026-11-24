/**
 * The agent's tools for triggers, ported from v1's `src/triggers/tools.ts` and `grant-action.ts`: one tool, `trigger`, whose `action` is create, update, pause, resume, delete, get, list,
 * runs, test or sources, and `trigger_computer_grant`, which asks the person to let a computer source run and stays apart because its approval parks the call until the person decides.
 * A trigger is typed (what `create`, `update` and `test` take is what a trigger is, as a record the model can read, not a spec it must learn from refusals), with `expectedRevision` so a
 * stale edit is refused. Two kinds of source that were tools of their own are sources here: a time source given as `delay_seconds`, `at` or `cron` is a scheduled task (v1's
 * `schedule_task`, kept by the schedule engine, which wakes the chat with a message starting "[Scheduled task"), and a connector event is a watch (v1's `watch_connector_event`,
 * `./watch-tools.ts`). An agent works only with its own triggers; the majordomo, with everyone's. What Pim fills in (the spec's version, its owner, its origin chat, its destination)
 * is not the agent's to say, so it cannot make a trigger for another agent, or one that reads as another's.
 */
import { Type } from "typebox";
import type { ToolRegistration } from "@earendil-works/pi-durable";
import { FILE_EVENTS, runsOnComputer, type TriggerSpec, TRIGGER_LIFECYCLES } from "@pim/triggers/spec";
import type { App } from "@pim/v2-app/app";
import { BadRequestError, PimError } from "@pim/v2-app/errors";
import type { Principal } from "@pim/v2-contracts/identity";
import type { Db as RuntimeDb } from "@pim/v2-runtime/db";
import { rosterOf } from "./agent-team-tools.ts";
import { contextOf, instants, load, sourcesOf, viewOf } from "./compat/chat-triggers.ts";
import { askFirst, recordResult } from "./tool-approval.ts";
import type { WatchOps } from "./watch-tools.ts";
import { recordComputerGrant, sourceConfigHash } from "./computer-triggers.ts";

type Result = { output: { type: "text"; text: string }[]; isError?: boolean };
type Call = { chat: string | null; p: Principal; api: any; agentId: string | null; context: any };
type Define = (name: string, description: string, parameters: any, run: (app: App, call: Call, args: any) => Promise<Result>) => ToolRegistration;

const text = (s: string, isError = false): Result => ({ output: [{ type: "text", text: s }], ...(isError ? { isError } : {}) });
const json = (v: unknown): Result => text(JSON.stringify(v, null, 1));

/** What a refusal of a trigger answers an agent: the code and message as JSON, as v1's API did. */
const failure = (status: number, code: string, message: string, extra: object = {}): Result => text(JSON.stringify({ error: { status, code, message, ...extra } }), true);

const Instant = Type.Union([Type.Integer({ description: "Milliseconds since 1970 (UTC)." }), Type.String({ description: "ISO 8601 with an offset, such as 2026-11-09T09:00:00-05:00." })]);
const literal = <T extends string>(value: T) => Type.Literal(value);
const optionalInteger = (description: string) => Type.Optional(Type.Integer({ description }));

/** A trigger's source: one of these shapes, told apart by `kind` (and a time source's `schedule`). */
const Source = Type.Union(
	[
		Type.Object({ kind: literal("time"), schedule: literal("once"), at: Instant, maxLatenessMs: optionalInteger("How late it may still run; 1 hour by default.") }),
		Type.Object({
			kind: literal("time"),
			schedule: literal("cron"),
			expression: Type.String({ description: "Five cron fields: minute, hour, day of month, month, day of week." }),
			timeZone: Type.String({ description: "An IANA time zone, such as Europe/Lisbon, or UTC." }),
			catchUpMs: optionalInteger("How late the latest missed firing may still run; 1 hour by default."),
		}),
		Type.Object({
			kind: literal("time"),
			schedule: literal("interval"),
			everyMs: Type.Integer({ description: "At least a minute." }),
			anchorAt: Instant,
			catchUpMs: optionalInteger("How late the latest missed firing may still run; 1 hour by default."),
		}),
		// A scheduled task: exactly one of these, in place of `schedule`. It wakes this chat, or with newChat a new one each time, with a message starting "[Scheduled task".
		Type.Object({ kind: literal("time"), delay_seconds: Type.Integer({ minimum: 1, description: "Once, this many seconds from now." }) }),
		Type.Object({ kind: literal("time"), at: Type.String({ description: "Once, at this time: ISO 8601 with an offset." }) }),
		Type.Object({ kind: literal("time"), cron: Type.String({ description: "Repeatedly: five cron fields, in UTC." }) }),
		Type.Object({ kind: literal("connector_event"), connectorId: Type.String(), event: Type.String(), arguments: Type.Optional(Type.Record(Type.String(), Type.Unknown(), { description: "The event's arguments, a JSON object, as sources (kind connector_event) describes the event." })) }),
		Type.Object({ kind: literal("poll"), command: Type.String(), cwd: Type.Optional(Type.Union([Type.String(), Type.Null()])), intervalMs: optionalInteger("1 minute to 1 day; 5 minutes by default."), deadlineMs: optionalInteger("1 to 30 seconds.") }),
		Type.Object({ kind: literal("stream"), command: Type.String(), cwd: Type.Optional(Type.Union([Type.String(), Type.Null()])) }),
		Type.Object({ kind: literal("process"), handle: Type.String(), expiresAt: Instant }),
		Type.Object({ kind: literal("file"), path: Type.String(), events: Type.Array(Type.Union(FILE_EVENTS.map(literal))), recursive: Type.Optional(Type.Boolean()) }),
	],
	{ description: "What it watches. Ask with action sources which kinds this space can run." },
);

/** A condition is a JSON object, never code; it may also be written out as JSON text. */
const conditionKinds = [Type.Object({}, { additionalProperties: true }), Type.String({ description: "The same object written out as JSON text." })];
const conditionNote = 'Optional; a JSON object, never code: {"when": <test>}, where a test is such as {"op": "compare", "path": ["price"], "cmp": "lt", "value": 500}. A time source takes none; a poll needs one.';
const Condition = Type.Union(conditionKinds, { description: conditionNote });

/** Any JSON value, which a sample's value may be. */
const JsonValue = Type.Union([Type.String(), Type.Number(), Type.Boolean(), Type.Null(), Type.Array(Type.Any()), Type.Object({}, { additionalProperties: true })], { description: "What the source reported: any JSON value, usually an object." });

const draftFields = {
	label: Type.String({ description: "A short name the person sees, up to 120 characters." }),
	instruction: Type.String({ description: "What to do each time it fires, written to your future self." }),
	source: Source,
	condition: Type.Optional(Condition),
	newChat: Type.Optional(Type.Boolean({ description: "Start a new chat each time it fires, instead of continuing this one. Always so for another agent's trigger." })),
	agentId: Type.Optional(Type.String({ description: "For the majordomo only: another of the person's agents, from your_agents, whose work it is." })),
	maxPendingEvents: optionalInteger("For sources of events: how many may wait to be handed on, 1 to 100; 20 by default."),
	enabled: Type.Optional(Type.Boolean({ description: "Start it now; otherwise it is kept as a draft." })),
};
const Draft = Type.Object(draftFields);

/** A condition written out as JSON text means the object it parses to; anything else is left for the spec's check to refuse. */
function conditionOf(value: unknown): unknown {
	if (typeof value !== "string") return value;
	try {
		const parsed: unknown = JSON.parse(value);
		return typeof parsed === "object" && parsed !== null && !Array.isArray(parsed) ? parsed : value;
	} catch {
		return value;
	}
}

type DraftArgs = { label?: string; instruction?: string; source?: unknown; condition?: unknown; newChat?: boolean; agentId?: string; maxPendingEvents?: number; enabled?: boolean };
type Actor = { self: string; majordomo: boolean; agents: Set<string> };

const COMPUTER_GRANT_NOTE = "A poll, stream or process source runs on the person's computer, as their own user: it needs their grant (trigger_computer_grant) before it is enabled, and a changed source needs it again.";

function every(ms: number): string {
	if (ms % 3_600_000 === 0) return ms === 3_600_000 ? "every hour" : `every ${ms / 3_600_000} hours`;
	if (ms % 60_000 === 0) return ms === 60_000 ? "every minute" : `every ${ms / 60_000} minutes`;
	return `every ${ms / 1000} seconds`;
}

/** What the person reads to decide: what runs, how often, and that it runs as them, with their access. */
function grantSummary(label: string, source: TriggerSpec["source"]): string {
	const as = "It runs as your own user on the computer, with everything that user can reach, until you revoke it or the trigger stops.";
	switch (source.kind) {
		case "poll":
			return `Let the trigger "${label}" run \`${source.command}\`${source.cwd ? ` in ${source.cwd}` : ""} on your computer ${every(source.intervalMs)}. ${as}`;
		case "stream":
			return `Let the trigger "${label}" keep \`${source.command}\`${source.cwd ? ` in ${source.cwd}` : ""} running on your computer and read what it prints. ${as}`;
		case "process":
			return `Let the trigger "${label}" watch on your computer for the process ${source.handle} to exit, until ${new Date(source.expiresAt).toISOString()}.`;
		default:
			return `Let the trigger "${label}" run on your computer.`;
	}
}

type TriggerArgs = DraftArgs & { action: (typeof ACTIONS)[number]; id?: string; expectedRevision?: number; lifecycle?: string; sourceKind?: string; cursor?: string; limit?: number; trigger?: DraftArgs; samples?: unknown[]; count?: number; kind?: string };

const ACTIONS = ["create", "update", "pause", "resume", "delete", "get", "list", "runs", "test", "sources"] as const;

export function triggerTools(deps: { ownerId: string; runtime: RuntimeDb; read: Define; write: Define; watch: WatchOps; now: () => number }): ToolRegistration[] {
	const { ownerId, runtime, read, watch } = deps;
	const S = Type.String;
	const O = Type.Optional;

	/** Who is asking: the agent that answers the chat, and whether it is the majordomo. */
	const actorOf = async (chat: string | null): Promise<Actor> => {
		const roster = await rosterOf(runtime, ownerId, chat);
		return { self: roster.self ?? "", majordomo: roster.majordomo, agents: new Set(roster.agents.map((a) => a.id)) };
	};
	/** A trigger the asking agent may see: its own, or any for the majordomo. Another agent's is reported as missing. */
	const visible = async (app: App, call: Call, actor: Actor, id: string) => {
		const found = await load(app, call.p, id);
		if (!actor.majordomo && found.row.spec.owningAgentId !== actor.self) throw new PimError(404, "not_found", "No such trigger");
		return found;
	};
	/** Triggers as the model reads them, a connector event's with how its watch stands at the connector. */
	const viewsOf = async (app: App, call: Call, rows: Parameters<typeof viewOf>[1][], ctx: Parameters<typeof viewOf>[2]) => {
		const views = await Promise.all(rows.map((row) => viewOf(app, row, ctx)));
		const watching = await watch.info(views.filter((v) => v.source.kind === "connector_event").map((v) => v.id));
		return views.map((v) => (watching.has(v.id) ? { ...v, watch: watching.get(v.id) } : v));
	};
	const view = async (app: App, call: Call, id: string) => {
		const { row, ctx } = await load(app, call.p, id);
		return (await viewsOf(app, call, [row], ctx))[0]!;
	};
	const revisionConflict = (row: { updated_at: Date }, expected: number | undefined) => (expected === undefined ? failure(400, "revision_required", "expectedRevision is required: the revision get gave") : expected === row.updated_at.getTime() ? null : failure(409, "revision_conflict", "The trigger was changed since that revision: read it again", { currentRevision: row.updated_at.getTime() }));

	/** Where a trigger's work goes: this chat for the agent's own, a new chat each time for another agent's or when asked. */
	const destinationOf = (actor: Actor, call: Call, owner: string, newChat: boolean | undefined): TriggerSpec["destination"] => {
		const own = owner === actor.self;
		if (newChat === false && !own) throw new BadRequestError("A trigger for another agent starts new chats");
		if (newChat === true || !own) return { type: "new_chat" };
		if (!call.chat) throw new BadRequestError("A trigger that continues a chat needs a chat: use newChat");
		return { type: "existing_chat", chatId: call.chat };
	};

	/** A time source given as a scheduled task: `delay_seconds`, `at` or `cron`, with no `schedule`. */
	const scheduledTask = (source: unknown): boolean => (source as { kind?: string; schedule?: unknown } | undefined)?.kind === "time" && (source as { schedule?: unknown }).schedule === undefined;

	/** A draft as the spec it is: what the model says, and what Pim fills in. */
	const specOf = (actor: Actor, call: Call, d: DraftArgs): TriggerSpec => {
		if (scheduledTask(d.source)) throw new BadRequestError("A scheduled task (delay_seconds, at or cron) can't be tested or changed: use schedule once, cron or interval for a trigger that can");
		const owner = d.agentId ?? actor.self;
		if (owner !== actor.self && !actor.majordomo) throw new PimError(403, "forbidden", "Only the majordomo makes triggers for other agents");
		if (!actor.agents.has(owner)) throw new PimError(422, "unknown_agent", "No such agent");
		return {
			version: 1,
			owningAgentId: owner,
			originChatId: call.chat ?? "api",
			label: d.label,
			instruction: d.instruction,
			source: instants(d.source),
			condition: d.condition === undefined ? null : conditionOf(d.condition),
			destination: destinationOf(actor, call, owner, d.newChat),
			delivery: d.maxPendingEvents === undefined ? undefined : { maxPendingEvents: d.maxPendingEvents },
			authorizationRef: null,
		} as unknown as TriggerSpec;
	};

	/** A scheduled task as the model sees it, in v1's shape: its kind, when it is next due, its chat and what it is to do. */
	const taskOf = (s: { id: string; kind: string; spec: string; nextRunAt: Date | null; chatId: string | null; label: string | null; prompt: string; target: string; agentId: string | null }) => ({
		id: s.id,
		type: s.kind === "cron" ? "cron" : s.kind === "at" ? "scheduled" : "delayed",
		next: s.nextRunAt?.toISOString() ?? null,
		...(s.kind === "cron" ? { cron: s.spec } : {}),
		session: s.chatId,
		label: s.label,
		instruction: s.prompt,
		newChat: s.target === "new_chat",
		...(s.target === "new_chat" && s.agentId ? { agent: s.agentId } : {}),
	});

	/** Runs `work`, answering a trigger's refusals as the structured errors v1's API gave. */
	const guarded = async (work: () => Promise<Result>): Promise<Result> => {
		try {
			return await work();
		} catch (error) {
			if (error instanceof PimError) return failure(error.status, (error as { code?: string }).code ?? "invalid_request", error.message);
			const e = error as { name?: string; message?: string };
			if (e?.name === "CapabilityUnavailableError") return failure(409, "source_not_wired", e.message ?? "It needs a paired computer");
			throw error;
		}
	};

	const page = (cursor: string | undefined) => {
		const offset = cursor === undefined ? 0 : Number(cursor);
		return Number.isInteger(offset) && offset >= 0 ? offset : null;
	};
	const needsId = (a: { id?: string }) => (a.id === undefined ? failure(400, "invalid_request", "id is required") : null);
	const notATrigger = (id: string) => failure(400, "not_a_trigger", `${id} is a scheduled task (made with delay_seconds, at or cron): it can be read, listed and deleted, not paused, resumed or changed. Delete it and make it again to change it.`);

	/** A scheduled task, v1's `schedule_task`: the schedule engine wakes this chat (or a new chat each time, with another agent's work for the majordomo) with the instruction. */
	const scheduleTask = async (app: App, call: Call, actor: Actor, a: TriggerArgs): Promise<Result> => {
		const given = a.source as { delay_seconds?: number; at?: string; cron?: string };
		if ([given.delay_seconds, given.at, given.cron].filter((v) => v !== undefined).length !== 1) return text("Give exactly one of delay_seconds, at, or cron.", true);
		if (!a.instruction) return text("instruction is required: what to do when it fires, written to your future self.", true);
		const other = a.agentId === undefined || a.agentId === actor.self ? undefined : a.agentId;
		if (other !== undefined) {
			if (!actor.majordomo) return text("Only the majordomo schedules work for other agents. Leave out agentId.", true);
			if (!actor.agents.has(other)) return text(`No agent has the id ${other}. Use an id from your_agents.`, true);
		}
		let kind: "cron" | "at" | "delay" = "cron";
		let spec: string = given.cron ?? "";
		if (given.at !== undefined) {
			const date = new Date(given.at);
			if (Number.isNaN(date.getTime())) return text(`Cannot read ${JSON.stringify(given.at)} as a date.`, true);
			if (date.getTime() <= deps.now()) return text(`${given.at} is in the past.`, true);
			[kind, spec] = ["at", date.toISOString()];
		} else if (given.delay_seconds !== undefined) [kind, spec] = ["delay", String(given.delay_seconds * 1000)];
		const here = !a.newChat && other === undefined;
		if (here && !call.chat) return text("Scheduled work can't come back to this conversation. Use newChat, so each run starts a new chat.", true);
		// The call's own id makes the schedule's: a rerun after an eviction finds the schedule it made.
		const id = await app.schedules.create(call.p, { kind, spec, prompt: a.instruction, ...(a.label ? { label: a.label } : {}), target: here ? "same_chat" : "new_chat", ...(here && call.chat ? { chatId: call.chat } : {}), ...((other ?? call.agentId) ? { agentId: (other ?? call.agentId)! } : {}), now: new Date(deps.now()), key: `schedule_task:${call.api.taskId}:${call.api.callId}` });
		const made = (await app.schedules.list(call.p)).find((s) => s.id === id);
		return json({ id, type: kind === "cron" ? "cron" : kind === "at" ? "scheduled" : "delayed", next: made?.nextRunAt?.toISOString() ?? null, ...(kind === "cron" ? { cron: spec } : {}), label: a.label ?? null, instruction: a.instruction, newChat: !here, ...(other ? { agent: other } : {}) });
	};

	// What the model calls: replay-safe as a whole, because each action is idempotent or fails closed when run twice: a creation has its call's own key (a scheduled task, a watch and a
	// trigger each find what the replayed call made), a change is guarded by its revision, and pause, resume and delete reach the same end however often they run.
	return [
		read(
			"trigger",
			`Work you do when something happens, such as at a time or when a connector reports an event. action: create (kept as a draft unless enabled; a scheduled task or a watch is on at once), update, pause, resume, delete, get, list, runs (a trigger's runs), test (a dry run, changing nothing and running nothing), sources (which kinds of source this space can run; with kind connector_event, the events your connectors can notify you about). Work runs in this chat, or with newChat in a new chat each time. A time source given as delay_seconds, at or cron is a scheduled task that wakes you with a message starting "[Scheduled task"; other times use schedule once, cron or interval. A connector_event source is a watch: each event arrives as a message starting "[Connector event]", and subscribing needs no approval. Calling create again after a restart gives the same trigger. ${COMPUTER_GRANT_NOTE}`,
			Type.Object({
				action: Type.Union(ACTIONS.map(literal)),
				id: O(S({ description: "The trigger's id, or a scheduled task's: for every action but create, list, test (without one) and sources." })),
				expectedRevision: optionalInteger("update and resume: the revision get gave; a trigger changed since is refused. delete may give it too."),
				label: O(draftFields.label),
				instruction: O(draftFields.instruction),
				source: O(Source),
				condition: O(Type.Union([...conditionKinds, Type.Null()], { description: `${conditionNote} update: null takes it off.` })),
				newChat: draftFields.newChat,
				agentId: O(S({ description: "create: for the majordomo only, another of the person's agents, from your_agents, whose work it is. list: only that agent's triggers (the majordomo)." })),
				maxPendingEvents: draftFields.maxPendingEvents,
				enabled: O(Type.Boolean({ description: "create: start it now; otherwise it is kept as a draft. A watch is on at once unless this is false." })),
				lifecycle: O(Type.Union(TRIGGER_LIFECYCLES.map(literal), { description: "list: only triggers in this state." })),
				sourceKind: O(S({ description: "list: only triggers with this kind of source." })),
				cursor: O(S({ description: "list, runs: nextCursor from the page before." })),
				limit: O(Type.Integer({ minimum: 1, maximum: 50 })),
				trigger: O(Draft),
				samples: O(Type.Array(Type.Object({ value: JsonValue, observedAt: optionalInteger("Milliseconds; now by default."), gap: O(Type.Boolean()) }), { maxItems: 10 })),
				count: O(Type.Integer({ minimum: 1, maximum: 10, description: "test: how many next firings." })),
				kind: O(S({ description: "sources: connector_event adds the events your connectors can notify you about." })),
			}),
			(app, call, a: TriggerArgs) =>
				guarded(async () => {
					const actor = await actorOf(call.chat);
					const missing = ["update", "pause", "resume", "delete", "get", "runs"].includes(a.action) ? needsId(a) : null;
					if (missing) return missing;
					const tg = a.id?.startsWith("tg_") === true;
					switch (a.action) {
						case "create": {
							if (scheduledTask(a.source)) return scheduleTask(app, call, actor, a);
							const draft = a as DraftArgs;
							if (draft.instruction === undefined || (draft.label === undefined && (draft.source as { kind?: string } | undefined)?.kind !== "connector_event")) return failure(400, "invalid_request", "label and instruction are required");
							const spec = specOf(actor, call, draft);
							// The tool call's own identity is the creation key, so a replayed call makes nothing new.
							const key = `tool:${call.api.taskId}:${call.api.callId}`;
							if (spec.source.kind === "connector_event" && a.enabled !== false) return await watch.start(call.p, call.chat, spec, key);
							const made = await app.triggers.create(call.p, { spec, key });
							if (a.enabled === true && !made.replayed) await app.triggers.setLifecycle(call.p, made.id, "enabled");
							return json({ trigger: await view(app, call, made.id), replayed: made.replayed === true });
						}
						case "update": {
							if (!tg) return notATrigger(a.id!);
							const { row } = await visible(app, call, actor, a.id!);
							const stale = revisionConflict(row, a.expectedRevision);
							if (stale) return stale;
							const before = row.spec;
							const changed = a.source !== undefined && (a.source as { kind?: string }).kind !== before.source.kind;
							if (scheduledTask(a.source)) return failure(400, "invalid_request", "A trigger's time source is schedule once, cron or interval: delay_seconds, at and cron make a scheduled task of their own");
							const spec: Record<string, unknown> = {
								...before,
								...(a.label === undefined ? {} : { label: a.label }),
								...(a.instruction === undefined ? {} : { instruction: a.instruction }),
								...(a.source === undefined ? {} : { source: instants(a.source) }),
								...(a.condition === undefined ? {} : { condition: a.condition === null ? null : conditionOf(a.condition) }),
								...(a.newChat === undefined ? {} : { destination: destinationOf(actor, call, before.owningAgentId, a.newChat) }),
								...(a.maxPendingEvents === undefined ? {} : { delivery: { maxPendingEvents: a.maxPendingEvents } }),
							};
							// Delivery follows the source's kind: a source of another kind starts from its own defaults, not the old one's.
							if (changed && a.maxPendingEvents === undefined) delete spec.delivery;
							await app.triggers.update(call.p, a.id!, { spec });
							return json({ trigger: await view(app, call, a.id!) });
						}
						case "pause":
							if (!tg) return notATrigger(a.id!);
							await visible(app, call, actor, a.id!);
							await app.triggers.setLifecycle(call.p, a.id!, "paused");
							return json({ trigger: await view(app, call, a.id!) });
						case "resume": {
							if (!tg) return notATrigger(a.id!);
							const { row } = await visible(app, call, actor, a.id!);
							const stale = revisionConflict(row, a.expectedRevision);
							if (stale) return stale;
							await app.triggers.setLifecycle(call.p, a.id!, "enabled");
							return json({ trigger: await view(app, call, a.id!) });
						}
						case "delete": {
							if (!tg) {
								// A scheduled task: the schedule engine's own.
								await app.schedules.remove(call.p, a.id!).catch((error) => {
									if (error instanceof PimError && error.status === 404) throw new PimError(404, "not_found", `No scheduled task with id ${a.id}.`);
									throw error;
								});
								return json({ deleted: true, id: a.id });
							}
							const { row } = await visible(app, call, actor, a.id!);
							if (a.expectedRevision !== undefined) {
								const stale = revisionConflict(row, a.expectedRevision);
								if (stale) return stale;
							}
							// A watch is unsubscribed while its connector can still be asked, then the trigger goes.
							if (row.spec.source.kind === "connector_event") await watch.stop(a.id!);
							await app.triggers.setLifecycle(call.p, a.id!, "deleted");
							return json({ deleted: true, id: a.id });
						}
						case "get": {
							if (!tg) {
								const task = (await app.schedules.list(call.p)).find((s) => s.id === a.id);
								return task ? json({ scheduled: taskOf(task) }) : failure(404, "not_found", `No trigger or scheduled task with id ${a.id}`);
							}
							const { row, ctx } = await visible(app, call, actor, a.id!);
							return json({ trigger: (await viewsOf(app, call, [row], ctx))[0], runs: (await app.triggers.runs(call.p, a.id!, 5)).map((r) => ({ id: r.id, phase: r.phase, at: r.at, detail: r.detail })) });
						}
						case "list": {
							const limit = a.limit ?? 20;
							const offset = page(a.cursor);
							if (offset === null) return failure(400, "invalid_cursor", "cursor is what a page gave as nextCursor");
							// An agent other than the majordomo sees only its own.
							if (!actor.majordomo && a.agentId !== undefined && a.agentId !== actor.self) return json({ triggers: [], nextCursor: null });
							const agentId = actor.majordomo ? a.agentId : actor.self;
							const rows = await app.triggers.list(call.p, { ...(a.lifecycle ? { lifecycle: a.lifecycle } : {}), ...(a.sourceKind ? { sourceKind: a.sourceKind } : {}), ...(agentId ? { agentId } : {}), limit: limit + 1, offset });
							const ctx = await app.db.owner(call.p.ownerId, (tx) => contextOf(tx));
							const shown = rows.slice(0, limit);
							const triggers = await viewsOf(app, call, await Promise.all(shown.map(async (t) => (await load(app, call.p, t.id)).row)), ctx);
							// What was made with delay_seconds, at or cron is pending beside them, on the first page of a list that could hold it.
							const holds = offset === 0 && (a.sourceKind === undefined || a.sourceKind === "time") && (a.lifecycle === undefined || a.lifecycle === "enabled") && (agentId === undefined || agentId === actor.self);
							const scheduled = holds ? (await app.schedules.list(call.p)).filter((s) => s.enabled && s.nextRunAt && (actor.majordomo || s.agentId === call.agentId)).map(taskOf) : [];
							return json({ triggers, ...(scheduled.length > 0 ? { scheduled } : {}), nextCursor: rows.length > limit ? String(offset + limit) : null });
						}
						case "runs": {
							if (!tg) return notATrigger(a.id!);
							await visible(app, call, actor, a.id!);
							const limit = a.limit ?? 20;
							const offset = page(a.cursor);
							if (offset === null) return failure(400, "invalid_cursor", "cursor is what a page gave as nextCursor");
							const runs = await app.triggers.runs(call.p, a.id!, limit + 1, offset);
							return json({ runs: runs.slice(0, limit), nextCursor: runs.length > limit ? String(offset + limit) : null });
						}
						case "test": {
							if (a.id !== undefined) await visible(app, call, actor, a.id);
							return json(await app.triggers.test(call.p, a.id ?? null, { ...(a.count ? { count: a.count } : {}), ...(a.trigger ? { spec: specOf(actor, call, a.trigger) } : {}), ...(a.samples ? { samples: a.samples } : {}) }));
						}
						case "sources": {
							const sources = sourcesOf(await app.db.owner(call.p.ownerId, (tx) => contextOf(tx)));
							return json(a.kind === "connector_event" ? { sources, connectorEvents: await watch.events(call.chat) } : { sources });
						}
					}
				}),
		),
		// Replay-safe: it parks until the person decides and runs again, and recording the grant twice is recording it once.
		read(
			"trigger_computer_grant",
			"Asks the person to let a trigger's source (a poll, a stream or a process watch) run on their computer, exactly as the trigger has it now. It runs as their own user, with that user's access. A changed source needs asking again. Only the person can answer: no standing approval or majordomo does. Then trigger with action resume enables it.",
			Type.Object({ triggerId: S({ description: "The trigger's id." }) }),
			(app, call, a) =>
				guarded(async () => {
					const actor = await actorOf(call.chat);
					const { row } = await visible(app, call, actor, a.triggerId);
					const spec = row.spec;
					if (!runsOnComputer(spec.source)) return text(`The trigger "${spec.label}" doesn't run on the computer, so it needs no grant.`, true);
					if (spec.source.kind === "file") return text("Nothing on the computer watches files yet, so a file source can't be granted.", true);
					if (row.lifecycle === "ended") return text(`The trigger "${spec.label}" has ended.`, true);
					if (!(await app.db.owner(call.p.ownerId, async (tx) => (await tx.query("SELECT 1 FROM pim_app.computers WHERE revoked_at IS NULL LIMIT 1")).rowCount))) return text("No computer is paired, so there is nothing to grant this on. The person can pair one in Settings → Computer.", true);
					const hash = sourceConfigHash(spec.source);
					const refused = await askFirst({ app, runtime, ownerId }, call, { action: "trigger:computer_grant", tool: "trigger_computer_grant", resource: { trigger: row.id, source: hash }, summary: grantSummary(spec.label, spec.source), args: { trigger: row.id, configHash: hash }, explicit: true, denied: "The person did not approve running it on their computer, so nothing was granted." });
					if (refused) return refused;
					// The person approved exactly this source: the grant is that approval, recorded. A source changed since is not what they read.
					const now = (await load(app, call.p, row.id)).row;
					if (sourceConfigHash(now.spec.source) !== hash) return text("The person approved, but the trigger has changed since, so the grant covers nothing it runs now. Ask again for what it is now.", true);
					await recordComputerGrant(app, call.p.ownerId, row.id, "approval");
					const done = `Granted: the trigger "${spec.label}" may run its source on the person's computer${row.lifecycle === "enabled" ? "" : " once it is enabled (trigger action resume)"}. The person can revoke this at any time.`;
					await recordResult(app, ownerId, "trigger:computer_grant", String(call.api.taskId), done);
					return text(done);
				}),
		),
	];
}
