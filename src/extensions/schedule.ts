import { Type } from "@earendil-works/pi-ai";
import { defineExtension, defineTool } from "@earendil-works/pi-durable";
import type { Schedule } from "agents";
import { type PimServices, type ScheduledTaskPayload, json, text } from "./services";

export function describeSchedule(schedule: Schedule<ScheduledTaskPayload>) {
	return {
		id: schedule.id,
		type: schedule.type,
		next: new Date(schedule.time * 1000).toISOString(),
		...(schedule.type === "cron" ? { cron: schedule.cron } : {}),
		...(schedule.type === "interval" ? { intervalSeconds: schedule.intervalSeconds } : {}),
		session: schedule.payload.session,
		label: schedule.payload.label ?? null,
		instruction: schedule.payload.instruction,
	};
}

export function scheduleExtension(services: PimServices) {
	const scheduleTask = defineTool({
		name: "schedule_task",
		description:
			"Wake yourself up later with an instruction, to follow up, check progress, send a reminder, or do recurring work. Give exactly one of delay_seconds, at (ISO 8601 with offset), or cron (5 fields, UTC). The instruction arrives in this conversation as a message starting with \"[Scheduled task]\".",
		parameters: Type.Object({
			instruction: Type.String({ minLength: 1, description: "What to do when it fires, written to your future self." }),
			label: Type.Optional(Type.String({ description: "Short name shown to the user." })),
			delay_seconds: Type.Optional(Type.Integer({ minimum: 1 })),
			at: Type.Optional(Type.String()),
			cron: Type.Optional(Type.String()),
		}),
		replay: "safe",
		async execute({ instruction, label, delay_seconds, at, cron }, api, context) {
			const given = [delay_seconds, at, cron].filter((value) => value !== undefined);
			if (given.length !== 1) return text("Give exactly one of delay_seconds, at, or cron.", true);
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
				if (known) return json(describeSchedule(known));
			}
			const payload: ScheduledTaskPayload = {
				session: String(api.conversationId),
				instruction,
				...(label ? { label } : {}),
			};
			const schedule = await services.schedule(when, payload);
			await api.memo("schedule", schedule.id, context);
			return json(describeSchedule(schedule));
		},
	});

	const listScheduled = defineTool({
		name: "list_scheduled_tasks",
		description: "List your pending scheduled tasks.",
		parameters: Type.Object({}),
		replay: "safe",
		async execute() {
			return json((await services.listSchedules()).map(describeSchedule));
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

	return defineExtension({ name: "pim.schedule", tools: [scheduleTask, listScheduled, cancelScheduled] });
}
