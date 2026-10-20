import { Type } from "@earendil-works/pi-ai";
import { defineExtension, defineTool } from "@earendil-works/pi-durable";
import type { Schedule } from "agents";
import { definePimExtension } from "./define";
import type { Agent } from "../agents";
import type { PimStore } from "../store";
import type { Role } from "../tasks";
import { type PimServices, type ScheduledTaskPayload, json, text } from "./services";

/** A schedule as the API and the model see it, its chat by its public id. */
export function describeSchedule(schedule: Schedule<ScheduledTaskPayload>, store: Pick<PimStore, "publicId">) {
	return {
		id: schedule.id,
		type: schedule.type,
		next: new Date(schedule.time * 1000).toISOString(),
		...(schedule.type === "cron" ? { cron: schedule.cron } : {}),
		...(schedule.type === "interval" ? { intervalSeconds: schedule.intervalSeconds } : {}),
		session: store.publicId(schedule.payload.session),
		label: schedule.payload.label ?? null,
		instruction: schedule.payload.instruction,
		newChat: schedule.payload.newChat === true,
		...(schedule.payload.agent ? { agent: schedule.payload.agent } : {}),
	};
}

export const SCHEDULE_EXTENSION = "pim.schedule";

/**
 * Scheduling for later. The majordomo can also schedule work for another of
 * the person's agents: each firing then starts a new chat with that agent.
 */
export function scheduleExtension(services: PimServices, roleOf: (session: string) => Role, agentOf: (id: string) => Agent | undefined) {
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
		async execute({ instruction, label, delay_seconds, at, cron, new_chat, agent }, api, context) {
			const given = [delay_seconds, at, cron].filter((value) => value !== undefined);
			if (given.length !== 1) return text("Give exactly one of delay_seconds, at, or cron.", true);
			const self = roleOf(String(api.conversationId));
			const other = agent === self.agent.id ? undefined : agent;
			if (other !== undefined) {
				if (!self.agent.majordomo || self.member) return text("Only the majordomo schedules work for other agents. Leave out agent.", true);
				if (!agentOf(other)) return text(`No agent has the id ${other}. Use an id from your_agents.`, true);
			}
			let when: Date | number | string;
			if (at !== undefined) {
				const date = new Date(at);
				if (Number.isNaN(date.getTime())) return text(`Cannot read ${JSON.stringify(at)} as a date.`, true);
				if (date.getTime() <= Date.now()) return text(`${at} is in the past.`, true);
				when = date;
			} else {
				when = delay_seconds ?? cron!;
			}
			// A replay after an eviction returns the schedule the first run made.
			const existing = await api.memo<string>("schedule", context);
			if (existing !== undefined) {
				const known = (await services.listSchedules()).find((schedule) => schedule.id === existing);
				if (known) return json(describeSchedule(known, services.store));
			}
			const payload: ScheduledTaskPayload = {
				session: String(api.conversationId),
				instruction,
				...(label ? { label } : {}),
				...(new_chat || other ? { newChat: true } : {}),
				...(other ? { agent: other } : {}),
			};
			const schedule = await services.schedule(when, payload);
			await api.memo("schedule", schedule.id, context);
			return json(describeSchedule(schedule, services.store));
		},
	});

	const listScheduled = defineTool({
		name: "list_scheduled_tasks",
		description: "List your pending scheduled tasks.",
		parameters: Type.Object({}),
		replay: "safe",
		async execute() {
			return json((await services.listSchedules()).map((schedule) => describeSchedule(schedule, services.store)));
		},
	});

	const cancelScheduled = defineTool({
		name: "cancel_scheduled_task",
		description: "Cancel a scheduled task by its id.",
		parameters: Type.Object({ id: Type.String() }),
		replay: "safe",
		async execute({ id }) {
			return (await services.cancelSchedule(id)) ? text("Cancelled.") : text(`No scheduled task with id ${id}.`, true);
		},
	});

	return defineExtension({ name: SCHEDULE_EXTENSION, tools: [scheduleTask, listScheduled, cancelScheduled] });
}

/** On a dashboard: the space's scheduled tasks, soonest first. */
export function scheduleWidgets(listSchedules: PimServices["listSchedules"]) {
	return definePimExtension({
		id: SCHEDULE_EXTENSION,
		name: "Schedules",
		description: "Work Pim does later, once or on a schedule.",
		widgets: {
			upcoming: {
				title: { en: "Coming up", es: "Próximamente" },
				description: "The next scheduled tasks in this space, soonest first, with when each runs.",
				empty: { en: "Nothing scheduled. Ask for a reminder or a recurring check-in.", es: "Nada programado. Pide un recordatorio o un seguimiento periódico." },
				load: async ({ agent, chatOf, ofAgent }) => ({
					kind: "list",
					items: (await listSchedules())
						.sort((a, b) => a.time - b.time)
						.flatMap((schedule) => {
							const chat = chatOf(schedule.payload.session);
							// A task that starts new chats shows on the dashboard of the agent it starts them with, without a link unless that agent scheduled it.
							const startsHere = schedule.payload.newChat && (schedule.payload.agent ? schedule.payload.agent === agent.id : ofAgent(schedule.payload.session));
							if (chat === null && !startsHere) return [];
							const title = schedule.payload.label ?? schedule.payload.instruction;
							return [
								{
									title: title.length > 120 ? `${title.slice(0, 119)}…` : title,
									time: new Date(schedule.time * 1000).toISOString(),
									...(chat === null ? {} : { link: { chat } }),
								},
							];
						})
						.slice(0, 5),
				}),
			},
		},
	});
}
