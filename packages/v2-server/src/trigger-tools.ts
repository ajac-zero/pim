/**
 * The agent's tools for triggers, ported from v1's `src/triggers/tools.ts` and `grant-action.ts`: the same typed draft (`create_trigger`, `update_trigger` and `test_trigger` take what a
 * trigger is as a record the model can read, not a spec it must learn from refusals), `expectedRevision` so a stale edit is refused, and `trigger_computer_grant`, which asks the person to
 * let a computer source run. An agent works only with its own triggers; the majordomo, with everyone's. What Pim fills in (the spec's version, its owner, its origin chat, its destination)
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
		Type.Object({ kind: literal("connector_event"), connectorId: Type.String(), event: Type.String(), arguments: Type.Optional(Type.Record(Type.String(), Type.Unknown(), { description: "The event's arguments, a JSON object, as list_connector_events describes the event." })) }),
		Type.Object({ kind: literal("poll"), command: Type.String(), cwd: Type.Optional(Type.Union([Type.String(), Type.Null()])), intervalMs: optionalInteger("1 minute to 1 day; 5 minutes by default."), deadlineMs: optionalInteger("1 to 30 seconds.") }),
		Type.Object({ kind: literal("stream"), command: Type.String(), cwd: Type.Optional(Type.Union([Type.String(), Type.Null()])) }),
		Type.Object({ kind: literal("process"), handle: Type.String(), expiresAt: Instant }),
		Type.Object({ kind: literal("file"), path: Type.String(), events: Type.Array(Type.Union(FILE_EVENTS.map(literal))), recursive: Type.Optional(Type.Boolean()) }),
	],
	{ description: "What it watches. Ask list_trigger_sources which kinds this space can run." },
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

export function triggerTools(deps: { ownerId: string; runtime: RuntimeDb; read: Define; write: Define }): ToolRegistration[] {
	const { ownerId, runtime, read, write } = deps;
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
	const view = async (app: App, call: Call, id: string) => {
		const { row, ctx } = await load(app, call.p, id);
		return viewOf(app, row, ctx);
	};
	const revisionConflict = (row: { updated_at: Date }, expected: number) => (expected === row.updated_at.getTime() ? null : failure(409, "revision_conflict", "The trigger was changed since that revision: read it again", { currentRevision: row.updated_at.getTime() }));

	/** Where a trigger's work goes: this chat for the agent's own, a new chat each time for another agent's or when asked. */
	const destinationOf = (actor: Actor, call: Call, owner: string, newChat: boolean | undefined): TriggerSpec["destination"] => {
		const own = owner === actor.self;
		if (newChat === false && !own) throw new BadRequestError("A trigger for another agent starts new chats");
		if (newChat === true || !own) return { type: "new_chat" };
		if (!call.chat) throw new BadRequestError("A trigger that continues a chat needs a chat: use newChat");
		return { type: "existing_chat", chatId: call.chat };
	};

	/** A draft as the spec it is: what the model says, and what Pim fills in. */
	const specOf = (actor: Actor, call: Call, d: DraftArgs): unknown => {
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
		};
	};

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

	return [
		write(
			"create_trigger",
			`Make a trigger: work you do when something happens, such as at a time. It runs in this chat, or with newChat in a new chat each time. Kept as a draft unless enabled. Calling again after a restart gives the same trigger. ${COMPUTER_GRANT_NOTE}`,
			Draft,
			(app, call, a: DraftArgs) =>
				guarded(async () => {
					const actor = await actorOf(call.chat);
					// The tool call's own identity is the creation key, so a replayed call makes nothing new.
					const made = await app.triggers.create(call.p, { spec: specOf(actor, call, a), key: `tool:${call.api.taskId}:${call.api.callId}` });
					if (a.enabled === true && !made.replayed) await app.triggers.setLifecycle(call.p, made.id, "enabled");
					return json({ trigger: await view(app, call, made.id), replayed: made.replayed === true });
				}),
		),
		write(
			"update_trigger",
			"Change a trigger's label, instruction, source, condition or chat, only if it is still at expectedRevision (from get_trigger). condition: null takes the condition off. A changed computer source needs the person's grant again.",
			Type.Object({
				id: S(),
				expectedRevision: Type.Integer({ minimum: 1 }),
				label: O(draftFields.label),
				instruction: O(draftFields.instruction),
				source: O(Source),
				condition: O(Type.Union([...conditionKinds, Type.Null()], { description: `${conditionNote} null takes it off.` })),
				newChat: draftFields.newChat,
				maxPendingEvents: draftFields.maxPendingEvents,
			}),
			(app, call, a) =>
				guarded(async () => {
					const actor = await actorOf(call.chat);
					const { row } = await visible(app, call, actor, a.id);
					const stale = revisionConflict(row, a.expectedRevision);
					if (stale) return stale;
					const before = row.spec;
					const changed = a.source !== undefined && (a.source as { kind?: string }).kind !== before.source.kind;
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
					await app.triggers.update(call.p, a.id, { spec });
					return json({ trigger: await view(app, call, a.id) });
				}),
		),
		read(
			"list_triggers",
			"List your triggers (the majordomo: everyone's), newest first, a page at a time.",
			Type.Object({
				lifecycle: O(Type.Union(TRIGGER_LIFECYCLES.map(literal))),
				sourceKind: O(S()),
				agentId: O(S()),
				cursor: O(S({ description: "nextCursor from the page before." })),
				limit: O(Type.Integer({ minimum: 1, maximum: 50 })),
			}),
			(app, call, a) =>
				guarded(async () => {
					const actor = await actorOf(call.chat);
					const limit = a.limit ?? 20;
					const offset = a.cursor === undefined ? 0 : Number(a.cursor);
					if (!Number.isInteger(offset) || offset < 0) return failure(400, "invalid_cursor", "cursor is what a page gave as nextCursor");
					// An agent other than the majordomo sees only its own.
					if (!actor.majordomo && a.agentId !== undefined && a.agentId !== actor.self) return json({ triggers: [], nextCursor: null });
					const agentId = actor.majordomo ? a.agentId : actor.self;
					const rows = await app.triggers.list(call.p, { ...(a.lifecycle ? { lifecycle: a.lifecycle } : {}), ...(a.sourceKind ? { sourceKind: a.sourceKind } : {}), ...(agentId ? { agentId } : {}), limit: limit + 1, offset });
					const ctx = await app.db.owner(call.p.ownerId, (tx) => contextOf(tx));
					const page = rows.slice(0, limit);
					return json({ triggers: await Promise.all(page.map(async (t) => viewOf(app, (await load(app, call.p, t.id)).row, ctx))), nextCursor: rows.length > limit ? String(offset + limit) : null });
				}),
		),
		read("get_trigger", "One trigger, with its revision, lifecycle, next firing and what may stop it, and its latest runs.", Type.Object({ id: S() }), (app, call, a) =>
			guarded(async () => {
				const { row, ctx } = await visible(app, call, await actorOf(call.chat), a.id);
				return json({ trigger: await viewOf(app, row, ctx), runs: (await app.triggers.runs(call.p, a.id, 5)).map((r) => ({ id: r.id, phase: r.phase, at: r.at, detail: r.detail })) });
			}),
		),
		write("pause_trigger", "Pause a trigger: nothing new is handed on until it is resumed. A run already going goes on.", Type.Object({ id: S() }), (app, call, a) =>
			guarded(async () => {
				await visible(app, call, await actorOf(call.chat), a.id);
				await app.triggers.setLifecycle(call.p, a.id, "paused");
				return json({ trigger: await view(app, call, a.id) });
			}),
		),
		write("resume_trigger", `Enable a draft or paused trigger, exactly as it is at expectedRevision. ${COMPUTER_GRANT_NOTE}`, Type.Object({ id: S(), expectedRevision: Type.Integer({ minimum: 1 }) }), (app, call, a) =>
			guarded(async () => {
				const { row } = await visible(app, call, await actorOf(call.chat), a.id);
				const stale = revisionConflict(row, a.expectedRevision);
				if (stale) return stale;
				await app.triggers.setLifecycle(call.p, a.id, "enabled");
				return json({ trigger: await view(app, call, a.id) });
			}),
		),
		write("delete_trigger", "Delete a trigger for good; its history stays. It doesn't stop a run already going.", Type.Object({ id: S(), expectedRevision: O(Type.Integer({ minimum: 1 })) }), (app, call, a) =>
			guarded(async () => {
				const { row } = await visible(app, call, await actorOf(call.chat), a.id);
				if (a.expectedRevision !== undefined) {
					const stale = revisionConflict(row, a.expectedRevision);
					if (stale) return stale;
				}
				await app.triggers.setLifecycle(call.p, a.id, "deleted");
				return json({ deleted: true, id: a.id });
			}),
		),
		read("list_trigger_runs", "A trigger's runs, newest first, a page at a time, each with what is known of it.", Type.Object({ id: S(), cursor: O(S()), limit: O(Type.Integer({ minimum: 1, maximum: 50 })) }), (app, call, a) =>
			guarded(async () => {
				await visible(app, call, await actorOf(call.chat), a.id);
				const limit = a.limit ?? 20;
				const offset = a.cursor === undefined ? 0 : Number(a.cursor);
				if (!Number.isInteger(offset) || offset < 0) return failure(400, "invalid_cursor", "cursor is what a page gave as nextCursor");
				const runs = await app.triggers.runs(call.p, a.id, limit + 1, offset);
				return json({ runs: runs.slice(0, limit), nextCursor: runs.length > limit ? String(offset + limit) : null });
			}),
		),
		read(
			"test_trigger",
			"A dry run, changing nothing and running nothing: whether a trigger (by id, or as you would make it) is valid, what would stop it being enabled, a time source's next firings, or what its condition says of each sample.",
			Type.Object({
				id: O(S()),
				trigger: O(Draft),
				samples: O(Type.Array(Type.Object({ value: JsonValue, observedAt: optionalInteger("Milliseconds; now by default."), gap: O(Type.Boolean()) }), { maxItems: 10 })),
				count: O(Type.Integer({ minimum: 1, maximum: 10 })),
			}),
			(app, call, a) =>
				guarded(async () => {
					const actor = await actorOf(call.chat);
					if (a.id !== undefined) await visible(app, call, actor, a.id);
					return json(await app.triggers.test(call.p, a.id ?? null, { ...(a.count ? { count: a.count } : {}), ...(a.trigger ? { spec: specOf(actor, call, a.trigger) } : {}), ...(a.samples ? { samples: a.samples } : {}) }));
				}),
		),
		read(
			"list_trigger_sources",
			"Which kinds of source this space can run now, which only as drafts, and what each needs. Which connector events you may use: list_connector_events.",
			Type.Object({ agentId: O(S({ description: "For the majordomo: another agent's connectors." })) }),
			(app, call) => guarded(async () => json({ sources: sourcesOf(await app.db.owner(call.p.ownerId, (tx) => contextOf(tx))) })),
		),
		// Replay-safe: it parks until the person decides and runs again, and recording the grant twice is recording it once.
		read(
			"trigger_computer_grant",
			"Asks the person to let a trigger's source (a poll, a stream or a process watch) run on their computer, exactly as the trigger has it now. It runs as their own user, with that user's access. A changed source needs asking again. Only the person can answer: no standing approval or majordomo does. Then resume_trigger enables it.",
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
					const done = `Granted: the trigger "${spec.label}" may run its source on the person's computer${row.lifecycle === "enabled" ? "" : " once it is enabled (resume_trigger)"}. The person can revoke this at any time.`;
					await recordResult(app, ownerId, "trigger:computer_grant", String(call.api.taskId), done);
					return text(done);
				}),
		),
	];
}
