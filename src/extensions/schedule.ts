import { Type } from "@earendil-works/pi-ai";
import { defineExtension, defineTool, type ToolExecutionApi } from "@earendil-works/pi-durable";
import type { Agent } from "../agents";
import type { Role } from "../tasks";
import { API_LIMITS, PERSON, type TriggerActor, type TriggerApi, TriggerApiError } from "../triggers/api";
import { TRIGGER_LIMITS, type TriggerSpec } from "../triggers/spec";
import { definePimExtension } from "./define";
import { json, text } from "./services";

/**
 * Scheduled tasks: work an agent gives itself for later, once or on a cron
 * schedule. Each is a time trigger (../triggers/), made, listed and
 * cancelled through the triggers' API as the agent of the chat it is asked
 * in, so the triggers' engine fires it and the person sees it among their
 * triggers. The majordomo can also schedule work for another of the
 * person's agents: each firing then starts a new chat with that agent.
 *
 * A trigger `schedule_task` made is recorded here with the label it was
 * given, so its firings read "[Scheduled task ...]" and notify the person,
 * as schedules always did.
 */

export const SCHEDULE_EXTENSION = "pim.schedule";

/** A trigger as the triggers' API shows it. */
type TriggerView = ReturnType<TriggerApi["get"]>;

type TimeSource = Extract<TriggerSpec["source"], { kind: "time" }>;

const TABLE = "pim_scheduled_tasks";
const SCHEMA = `CREATE TABLE IF NOT EXISTS ${TABLE} (trigger_id TEXT PRIMARY KEY, label TEXT, at INTEGER NOT NULL DEFAULT 0)`;

/** The triggers `schedule_task` made, with the label each was given, if any, and whether it was given a time (`at`) rather than a delay. Its table is made with the first. */
export class ScheduledTasks {
	readonly #sql: SqlStorage;
	#made = false;

	constructor(sql: SqlStorage) {
		this.#sql = sql;
	}

	mark(triggerId: string, label: string | null, at = false): void {
		this.#sql.exec(SCHEMA);
		this.#made = true;
		this.#sql.exec(`INSERT OR IGNORE INTO ${TABLE} (trigger_id, label, at) VALUES (?, ?, ?)`, triggerId, label, at ? 1 : 0);
	}

	/** The task a trigger is, if `schedule_task` made it. */
	of(triggerId: string): { readonly label: string | null; readonly at: boolean } | undefined {
		this.#made ||= this.#sql.exec("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?", TABLE).toArray().length > 0;
		if (!this.#made) return undefined;
		const [row] = this.#sql.exec(`SELECT label, at FROM ${TABLE} WHERE trigger_id = ?`, triggerId).toArray();
		return row ? { label: row.label === null ? null : String(row.label), at: row.at === 1 } : undefined;
	}
}

/** What a scheduled task's firing reads as, as its schedules always did. */
export function scheduledTaskText(triggerId: string, label: string | null, instruction: string): string {
	return `[Scheduled task${label ? ` "${label}"` : ""} ${triggerId}] ${instruction}`;
}

/** What the tools, the widget and Pim's routes need of the space. */
export type ScheduleHost = {
	/** The triggers' API, where the space's triggers are on; null otherwise, and then nothing is scheduled. */
	api(): TriggerApi | null;
	tasks(): ScheduledTasks;
	roleOf(session: string): Role;
	agentOf(id: string): Agent | undefined;
	/** The most scheduled tasks the space may have; null for no limit. */
	limit(): number | null;
	/** The triggers' clock. */
	now(): number;
	/** The agent of a chat, by its public id; null for none. */
	chatAgent(chat: string): string | null;
	/** The conversation a chat's public id names; null for none. */
	sessionOf(chat: string): string | null;
	/** The trigger a schedule made before triggers moved to, by the schedule's id; the id itself otherwise. */
	triggerOf(id: string): string;
};

/** The enabled time triggers the actor may see, oldest first: its scheduled tasks. */
export function scheduledTriggers(api: TriggerApi, actor: TriggerActor): TriggerView[] {
	const found: TriggerView[] = [];
	let cursor: string | null = null;
	do {
		const page: ReturnType<TriggerApi["list"]> = api.list(actor, { lifecycle: "enabled", sourceKind: "time", limit: API_LIMITS.pageMax, ...(cursor === null ? {} : { cursor }) });
		found.push(...page.triggers);
		cursor = page.nextCursor;
	} while (cursor !== null);
	return found;
}

/** A scheduled task as the API, the export and the model see it, its chat by its public id. */
export function describeTask(host: Pick<ScheduleHost, "tasks" | "chatAgent">, trigger: TriggerView) {
	const source = trigger.source as unknown as TimeSource;
	const session = trigger.origin.type === "chat" ? (trigger.origin.chatId ?? null) : null;
	const newChat = trigger.destination.type === "new_chat";
	const next = (trigger.schedule?.nextFiringAt ?? null) as number | null;
	const task = host.tasks().of(trigger.id);
	return {
		id: trigger.id,
		// As the agents SDK typed schedules: one given a time is "scheduled", any other one-time task "delayed".
		type: source.schedule === "once" ? (task?.at ? "scheduled" : "delayed") : source.schedule,
		next: next === null ? null : new Date(next).toISOString(),
		...(source.schedule === "cron" ? { cron: source.expression, ...(source.timeZone === "UTC" ? {} : { timeZone: source.timeZone }) } : {}),
		...(source.schedule === "interval" ? { intervalSeconds: source.everyMs / 1000 } : {}),
		session,
		label: task ? task.label : trigger.label,
		instruction: trigger.instruction,
		newChat,
		// Named when its chats are with another agent than the chat that scheduled it.
		...(newChat && (session === null || host.chatAgent(session) !== trigger.agentId) ? { agent: trigger.agentId } : {}),
	};
}

/** Cancels the scheduled task `id`, a time trigger the actor may see; false where there is none. */
export async function cancelTask(api: TriggerApi, actor: TriggerActor, id: string): Promise<boolean> {
	let trigger: TriggerView;
	try {
		trigger = api.get(actor, id);
	} catch (error) {
		if (error instanceof TriggerApiError && error.code === "not_found") return false;
		throw error;
	}
	if (trigger.lifecycle === "deleted" || (trigger.source as unknown as { kind: string }).kind !== "time") return false;
	await api.remove(actor, trigger.id);
	return true;
}

/** A trigger's label for a task: its own label or else its instruction, on one line and within the spec's length. */
function labelOf(label: string | undefined, instruction: string): string {
	const line =
		(label || instruction)
			.split(/\r?\n/)
			.map((part) => part.replace(/[\u0000-\u001f\u007f]/g, " ").trim())
			.find((part) => part !== "") ?? "Scheduled task";
	return line.length > TRIGGER_LIMITS.labelLength ? `${line.slice(0, TRIGGER_LIMITS.labelLength - 1).trimEnd()}…` : line;
}

/** The scheduling tools, each acting as the agent of the chat it is called in. */
export function scheduleExtension(host: ScheduleHost) {
	const actorOf = (call: ToolExecutionApi): Extract<TriggerActor, { kind: "agent" }> => {
		const chatId = String(call.conversationId);
		const { agent } = host.roleOf(chatId);
		return { kind: "agent", agentId: agent.id, majordomo: agent.majordomo, chatId };
	};

	const scheduleTask = defineTool({
		name: "schedule_task",
		description:
			"Wake yourself up later with an instruction, to follow up, check progress, send a reminder, or do recurring work. Give exactly one of delay_seconds, at (ISO 8601 with offset), or cron (5 fields, UTC). The instruction arrives as a message starting with \"[Scheduled task]\": in this conversation, or with new_chat in a new chat each time it fires.",
		parameters: Type.Object({
			instruction: Type.String({ minLength: 1, description: "What to do when it fires, written to your future self." }),
			label: Type.Optional(Type.String({ description: "Short name shown to the user, and the title of each new chat." })),
			delay_seconds: Type.Optional(Type.Integer({ minimum: 1 })),
			at: Type.Optional(Type.String()),
			cron: Type.Optional(Type.String()),
			new_chat: Type.Optional(
				Type.Boolean({
					description:
						"Start a new chat with you each time it fires, instead of continuing this one: for recurring work read on its own, such as a daily briefing. The new chat doesn't see this conversation, so make the instruction complete.",
				}),
			),
			agent: Type.Optional(
				Type.String({
					description:
						"For the majordomo only: the id of another of the person's agents, from your_agents, to do the work. Each firing starts a new chat with that agent, as with new_chat, so write the instruction to it.",
				}),
			),
		}),
		replay: "safe",
		async execute({ instruction, label, delay_seconds, at, cron, new_chat, agent }, call, context) {
			const given = [delay_seconds, at, cron].filter((value) => value !== undefined);
			if (given.length !== 1) return text("Give exactly one of delay_seconds, at, or cron.", true);
			const actor = actorOf(call);
			const self = host.roleOf(actor.chatId);
			const other = agent === self.agent.id ? undefined : agent;
			if (other !== undefined) {
				if (!self.agent.majordomo) return text("Only the majordomo schedules work for other agents. Leave out agent.", true);
				if (!host.agentOf(other)) return text(`No agent has the id ${other}. Use an id from your_agents.`, true);
			}
			const api = host.api();
			if (!api) return text("Scheduling isn't available in this space.", true);
			let when: number | string;
			if (at !== undefined) {
				const date = new Date(at);
				if (Number.isNaN(date.getTime())) return text(`Cannot read ${JSON.stringify(at)} as a date.`, true);
				when = date.getTime();
			} else {
				when = delay_seconds === undefined ? cron! : host.now() + delay_seconds * 1000;
			}
			// A replay after an eviction asks for the time its first run worked out, under the same key: the trigger that run made.
			const first = await call.memo<number | string>("schedule_when", context);
			if (first === undefined) {
				if (at !== undefined && (when as number) <= host.now()) return text(`${at} is in the past.`, true);
				const limit = host.limit();
				if (limit !== null && scheduledTriggers(api, PERSON).length >= limit) return text(`The limit of ${limit} scheduled tasks is reached. Cancel one first.`, true);
				when = await call.memo("schedule_when", when, context);
			} else {
				when = first;
			}
			const source = typeof when === "number" ? { kind: "time", schedule: "once", at: when } : { kind: "time", schedule: "cron", expression: when, timeZone: "UTC" };
			try {
				const { trigger } = await api.create(
					actor,
					{
						label: labelOf(label, instruction),
						instruction,
						source,
						...(new_chat || other ? { destination: { type: "new_chat" } } : {}),
						...(other ? { agentId: other } : {}),
						enabled: true,
					},
					`schedule_task:${call.conversationId}:${call.taskId}`,
				);
				host.tasks().mark(trigger.id, label || null, at !== undefined);
				return json(describeTask(host, trigger));
			} catch (error) {
				// Such as a task's conversation, or another agent's group chat, which no trigger delivers to.
				if (error instanceof TriggerApiError && error.code === "chat_unavailable") return text("Scheduled work can't come back to this conversation. Use new_chat, so each run starts a new chat.", true);
				if (error instanceof TriggerApiError) return text(error.message, true);
				throw error;
			}
		},
	});

	const listScheduled = defineTool({
		name: "list_scheduled_tasks",
		description: "List your pending scheduled tasks.",
		parameters: Type.Object({}),
		replay: "safe",
		async execute(_args, call) {
			const api = host.api();
			return json(api ? scheduledTriggers(api, actorOf(call)).map((trigger) => describeTask(host, trigger)) : []);
		},
	});

	const cancelScheduled = defineTool({
		name: "cancel_scheduled_task",
		description: "Cancel a scheduled task by its id.",
		parameters: Type.Object({ id: Type.String() }),
		replay: "safe",
		async execute({ id }, call) {
			const api = host.api();
			try {
				if (api && (await cancelTask(api, actorOf(call), host.triggerOf(id)))) return text("Cancelled.");
			} catch (error) {
				if (error instanceof TriggerApiError) return text(error.message, true);
				throw error;
			}
			return text(`No scheduled task with id ${id}.`, true);
		},
	});

	return defineExtension({ name: SCHEDULE_EXTENSION, tools: [scheduleTask, listScheduled, cancelScheduled] });
}

/** The space's scheduled tasks, soonest first. */
export function scheduleWidgets(host: Pick<ScheduleHost, "api" | "tasks" | "chatAgent" | "sessionOf">) {
	return definePimExtension({
		id: SCHEDULE_EXTENSION,
		name: "Schedules",
		description: "Work Pim does later, once or on a schedule.",
		widgets: {
			upcoming: {
				title: { en: "Coming up", es: "Próximamente" },
				description: "The next scheduled tasks in this space, soonest first, with when each runs.",
				empty: { en: "Nothing scheduled. Ask for a reminder or a recurring check-in.", es: "Nada programado. Pide un recordatorio o un seguimiento periódico." },
				load: async ({ agent, chatOf }) => {
					const api = host.api();
					return {
						kind: "list",
						items: (api ? scheduledTriggers(api, PERSON) : [])
							.map((trigger) => ({ trigger, task: describeTask(host, trigger) }))
							.flatMap(({ trigger, task }) => (task.next === null ? [] : [{ trigger, task, next: task.next }]))
							.sort((a, b) => a.next.localeCompare(b.next))
							.flatMap(({ trigger, task, next }) => {
								// Its chat: the one it runs in, or for a task that starts new chats, the one that scheduled it.
								const shown = trigger.destination.type === "existing_chat" ? (trigger.destination.chatId ?? null) : task.session;
								const session = shown === null ? null : host.sessionOf(shown);
								const chat = session === null ? null : chatOf(session);
								// A task that starts new chats shows in the chats of the agent it starts them with, without a link unless that agent scheduled it.
								const startsHere = task.newChat && trigger.agentId === agent.id;
								if (chat === null && !startsHere) return [];
								const title = task.label ?? task.instruction;
								return [
									{
										title: title.length > 120 ? `${title.slice(0, 119)}…` : title,
										time: next,
										...(chat === null ? {} : { link: { chat } }),
									},
								];
							})
							.slice(0, 5),
					};
				},
			},
		},
	});
}
