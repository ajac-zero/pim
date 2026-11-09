/**
 * Agents' tools for triggers: the API (./api.ts) as tools, acting as the
 * agent of the chat they are called in. Pim installs them only in a space
 * whose trigger engine is on (./engine.ts), which no deployment allows, and
 * never in a guest's space; chats select them (`#selectAbilities` in
 * ../pim.ts), so where triggers are off no chat has them. Schedules'
 * (`schedule_task`) and watches' tools are untouched.
 */

import { type TSchema, Type } from "@earendil-works/pi-ai";
import { defineExtension, defineTool, type ToolExecutionApi, type ToolExecutionResult } from "@earendil-works/pi-durable";
import { json, text } from "../extensions/services";
import type { Role } from "../tasks";
import { type TriggerActor, type TriggerApi, TriggerApiError } from "./api";
import { FILE_EVENTS, TRIGGER_LIFECYCLES } from "./spec";

export const TRIGGERS_EXTENSION = "pim.triggers";

/** Every tool the extension has, in order. */
export const TRIGGER_TOOLS = [
	"create_trigger",
	"update_trigger",
	"list_triggers",
	"get_trigger",
	"pause_trigger",
	"resume_trigger",
	"delete_trigger",
	"list_trigger_runs",
	"test_trigger",
	"list_trigger_sources",
	"list_trigger_migration",
] as const;

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
		Type.Object({ kind: literal("connector_event"), connectorId: Type.String(), event: Type.String(), arguments: Type.Optional(Type.Record(Type.String(), Type.Unknown(), { description: "The event's arguments, a JSON object, as list_trigger_sources describes the event." })) }),
		Type.Object({ kind: literal("poll"), command: Type.String(), cwd: Type.Optional(Type.Union([Type.String(), Type.Null()])), intervalMs: optionalInteger("1 minute to 1 day; 5 minutes by default."), deadlineMs: optionalInteger("1 to 30 seconds.") }),
		Type.Object({ kind: literal("stream"), command: Type.String(), cwd: Type.Optional(Type.Union([Type.String(), Type.Null()])) }),
		Type.Object({ kind: literal("process"), handle: Type.String(), expiresAt: Instant }),
		Type.Object({ kind: literal("file"), path: Type.String(), events: Type.Array(Type.Union(FILE_EVENTS.map(literal))), recursive: Type.Optional(Type.Boolean()) }),
	],
	{ description: "What it watches. Ask list_trigger_sources which kinds this space can run." },
);

/** A condition is a JSON object, never code; `draft` also takes one written out as JSON text. */
const conditionKinds = [Type.Object({}, { additionalProperties: true }), Type.String({ description: "The same object written out as JSON text." })];
const conditionNote = 'Optional; a JSON object, never code: {"when": <test>}, where a test is such as {"op": "compare", "path": ["price"], "cmp": "lt", "value": 500}. A time source takes none; a poll needs one.';
const Condition = Type.Union(conditionKinds, { description: conditionNote });

/** Any JSON value, which a sample's value may be. */
const JsonValue = Type.Union([Type.String(), Type.Number(), Type.Boolean(), Type.Null(), Type.Array(Type.Any()), Type.Object({}, { additionalProperties: true })], {
	description: "What the source reported: any JSON value, usually an object.",
});

/** A condition written out as JSON text means the object it parses to; anything else is left for the API to refuse. */
function conditionOf(value: unknown): unknown {
	if (typeof value !== "string") return value;
	try {
		const parsed: unknown = JSON.parse(value);
		return typeof parsed === "object" && parsed !== null && !Array.isArray(parsed) ? parsed : value;
	} catch {
		return value;
	}
}

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

/** What a tool's arguments say of a trigger, as the API takes it. */
function draft(args: { label?: string; instruction?: string; source?: unknown; condition?: unknown; newChat?: boolean; agentId?: string; maxPendingEvents?: number; enabled?: boolean }) {
	return {
		...(args.label === undefined ? {} : { label: args.label }),
		...(args.instruction === undefined ? {} : { instruction: args.instruction }),
		...(args.source === undefined ? {} : { source: args.source }),
		...(args.condition === undefined ? {} : { condition: conditionOf(args.condition) }),
		...(args.newChat === undefined ? {} : { destination: { type: args.newChat ? "new_chat" : "existing_chat" } }),
		...(args.maxPendingEvents === undefined ? {} : { delivery: { maxPendingEvents: args.maxPendingEvents } }),
		...(args.agentId === undefined ? {} : { agentId: args.agentId }),
		...(args.enabled === undefined ? {} : { enabled: args.enabled }),
	};
}

export type TriggerToolsHost = {
	/** The API, while the space's triggers are on; null once they are off. */
	readonly api: () => TriggerApi | null;
	readonly roleOf: (session: string) => Role;
};

/** The tools, each acting as the agent of the chat it is called in. */
export function triggersExtension(host: TriggerToolsHost) {
	const tool = <P extends TSchema>(name: (typeof TRIGGER_TOOLS)[number], description: string, parameters: P, run: (api: TriggerApi, actor: TriggerActor, args: any, call: ToolExecutionApi) => unknown) =>
		defineTool({
			name,
			description,
			parameters,
			replay: "safe",
			async execute(args, call): Promise<ToolExecutionResult> {
				const api = host.api();
				if (!api) return text(JSON.stringify(new TriggerApiError(404, "not_found", "Triggers are off in this space").body()), true);
				const chat = String(call.conversationId);
				const { agent } = host.roleOf(chat);
				const actor: TriggerActor = { kind: "agent", agentId: agent.id, majordomo: agent.majordomo, chatId: chat };
				try {
					return json(await run(api, actor, args, call));
				} catch (error) {
					if (error instanceof TriggerApiError) return text(JSON.stringify(error.body()), true);
					throw error;
				}
			},
		});

	return defineExtension({
		name: TRIGGERS_EXTENSION,
		tools: [
			tool(
				"create_trigger",
				"Make a trigger: work you do when something happens, such as at a time. It runs in this chat, or with newChat in a new chat each time. Kept as a draft unless enabled. Calling again after a restart gives the same trigger.",
				Draft,
				// The tool call's durable identity is the creation key, so a replayed call makes nothing new.
				(api, actor, args, call) => api.create(actor, draft(args), `tool:${call.conversationId}:${call.taskId}`),
			),
			tool(
				"update_trigger",
				"Change a trigger's label, instruction, source, condition or chat, only if it is still at expectedRevision (from get_trigger). condition: null takes the condition off. A changed computer source needs the person's grant again.",
				Type.Object({
					id: Type.String(),
					expectedRevision: Type.Integer({ minimum: 1 }),
					label: Type.Optional(draftFields.label),
					instruction: Type.Optional(draftFields.instruction),
					source: Type.Optional(Source),
					condition: Type.Optional(Type.Union([...conditionKinds, Type.Null()], { description: `${conditionNote} null takes it off.` })),
					newChat: draftFields.newChat,
					maxPendingEvents: draftFields.maxPendingEvents,
				}),
				(api, actor, { id, expectedRevision, ...rest }) => {
					const { enabled: _enabled, agentId: _agentId, ...changes } = draft(rest);
					return api.update(actor, id, expectedRevision, changes);
				},
			),
			tool(
				"list_triggers",
				"List your triggers (the majordomo: everyone's), oldest first, a page at a time.",
				Type.Object({
					lifecycle: Type.Optional(Type.Union(TRIGGER_LIFECYCLES.map(literal))),
					sourceKind: Type.Optional(Type.String()),
					agentId: Type.Optional(Type.String()),
					cursor: Type.Optional(Type.String({ description: "nextCursor from the page before." })),
					limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 50 })),
				}),
				(api, actor, args) => api.list(actor, args),
			),
			tool("get_trigger", "One trigger, with its revision, lifecycle, health, next firing and what may stop it.", Type.Object({ id: Type.String() }), (api, actor, { id }) => api.get(actor, id)),
			tool("pause_trigger", "Pause a trigger: nothing new is handed on until it is resumed. A run already going goes on.", Type.Object({ id: Type.String() }), (api, actor, { id }) => api.pause(actor, id)),
			tool(
				"resume_trigger",
				"Enable a draft or paused trigger, exactly as it is at expectedRevision.",
				Type.Object({ id: Type.String(), expectedRevision: Type.Integer({ minimum: 1 }) }),
				(api, actor, { id, expectedRevision }) => api.resume(actor, id, expectedRevision),
			),
			tool(
				"delete_trigger",
				"Delete a trigger for good; its history stays. It doesn't stop a run already going.",
				Type.Object({ id: Type.String(), expectedRevision: Type.Optional(Type.Integer({ minimum: 1 })) }),
				(api, actor, { id, expectedRevision }) => api.remove(actor, id, expectedRevision),
			),
			tool(
				"list_trigger_runs",
				"A trigger's runs, newest first, a page at a time, each with what is known of it.",
				Type.Object({ id: Type.String(), cursor: Type.Optional(Type.String()), limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 50 })) }),
				(api, actor, { id, cursor, limit }) => api.runs(actor, id, { cursor, limit }),
			),
			tool(
				"test_trigger",
				"A dry run, changing nothing and running nothing: whether a trigger (by id, or as you would make it) is valid, what would stop it being enabled, a time source's next firings, or what its condition says of each sample.",
				Type.Object({
					id: Type.Optional(Type.String()),
					trigger: Type.Optional(Draft),
					samples: Type.Optional(
						Type.Array(Type.Object({ value: JsonValue, observedAt: optionalInteger("Milliseconds; now by default."), gap: Type.Optional(Type.Boolean()) }), { maxItems: 10 }),
					),
					count: Type.Optional(Type.Integer({ minimum: 1, maximum: 10 })),
				}),
				(api, actor, { trigger, ...rest }) => api.test(actor, { ...rest, ...(trigger === undefined ? {} : { trigger: draft(trigger) }) }),
			),
			tool(
				"list_trigger_sources",
				"Which kinds of source this space can run now, which only as drafts, and the connector events you may use.",
				Type.Object({ agentId: Type.Optional(Type.String({ description: "For the majordomo: another agent's connectors." })) }),
				(api, actor, { agentId }) => api.sources(actor, { agentId }),
			),
			tool(
				"list_trigger_migration",
				"Where each scheduled task and connector watch stands in its move to triggers (yours; the majordomo: everyone's), a page at a time: migrated, migratable, deferred, unsupported or given back, which side delivers it, why, and its trigger's id. Reads only.",
				Type.Object({
					cursor: Type.Optional(Type.String({ description: "nextCursor from the page before." })),
					limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 50 })),
				}),
				(api, actor, { cursor, limit }) => api.migration(actor, { cursor, limit }),
			),
		],
	});
}
