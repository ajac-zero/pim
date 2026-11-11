import { Type } from "@earendil-works/pi-ai";
import { defineTool, section } from "@earendil-works/pi-durable";
import { DEFAULT_LIMIT, DIAGNOSTIC_KINDS, EVENT_KEEP, MAX_LIMIT, scrub } from "../diagnostics";
import { definePimExtension } from "./define";
import { json, text } from "./services";

/**
 * Diagnostics for the admin's majordomo: tools that read, and never change,
 * what has gone wrong in this space and how this Pim is doing, so it can debug
 * Pim without the web app. What they read is the data the space already keeps
 * (see ../diagnostics.ts), with secrets, addresses and emails taken out.
 *
 * Only the majordomo of the admin's space is offered them, and each call
 * checks that again: being offered is no permission.
 */

const PROMPT = `You can debug this Pim, which you run for its admin, without the web app. Both tools only read:
- pim_diagnostics: what went wrong lately, by kind: ${DIAGNOSTIC_KINDS.join(", ")}. Give since (an ISO time or how long back, such as 6h or 2d; a day unless given), kind to read one, and limit (${DEFAULT_LIMIT} unless given, ${MAX_LIMIT} at most). turns says how long the agents' turns took and where the time went: the model, tools, or waiting for approvals; give chat to read one chat's turns step by step, as when the person asks why an agent took so long. Its events are the last ${EVENT_KEEP} warnings the space logged, such as slow requests.
- pim_health: this Pim's version, its Durable Object, how many agents, chats, triggers and schedules it holds, and how the deployment is set.
Secrets, addresses and emails are already taken out of what they say. Start with pim_diagnostics without a kind, follow what stands out, and report what you found and what you would do about it.`;

export const metaDiagnostics = definePimExtension({
	id: "meta-diagnostics",
	name: "Diagnostics",
	description: "The admin's majordomo reads what went wrong in this Pim, and how it is doing, to debug it without the web app.",
	ability: (context) => {
		const { conversationOf, diagnostics } = context;
		/** Whether the conversation is the admin's majordomo's. */
		const allowed = (conversationId: unknown) => context.admin && conversationOf(String(conversationId)).agent.majordomo;
		const refused = () => text("Only the admin's majordomo can read this Pim's diagnostics.", true);
		const answer = async (work: () => Promise<unknown>) => {
			try {
				return json(await work());
			} catch (error) {
				return text(JSON.stringify({ error: scrub(error instanceof Error ? error.message : String(error)) }), true);
			}
		};
		return {
			offeredTo: (agent) => context.admin && agent.majordomo,
			sections: [section("diagnostics", ({ conversationId }) => (allowed(conversationId) ? PROMPT : undefined))],
			tools: [
				defineTool({
					name: "pim_diagnostics",
					description:
						"What went wrong in this Pim lately, read only: chats at work now, what each waits on and since when, how long turns took and where the time went, failed runs and tasks, triggers' health and failed runs, model call errors and unusual calls, subscriptions cooling down after their usage limit, coding threads that failed or wait, connectors that aren't ready, approvals waiting, and the log of recent warnings such as slow requests.",
					parameters: Type.Object({
						since: Type.Optional(Type.String({ description: "An ISO 8601 time, or how long back, such as 90m, 6h or 2d. A day unless given." })),
						kind: Type.Optional(Type.Union(DIAGNOSTIC_KINDS.map((kind) => Type.Literal(kind)), { description: "Read one kind only; every kind unless given." })),
						limit: Type.Optional(Type.Integer({ minimum: 1, maximum: MAX_LIMIT, description: `The most items of each kind, ${DEFAULT_LIMIT} unless given.` })),
						chat: Type.Optional(Type.String({ description: "A chat's id, as the other kinds give it: turns then lists that chat's turns step by step." })),
					}),
					async execute(args, api) {
						if (!allowed(api.conversationId)) return refused();
						return answer(() => diagnostics.report(args));
					},
				}),
				defineTool({
					name: "pim_health",
					description: "How this Pim is doing, read only: its version, its Durable Object, how many agents, chats, triggers and schedules it holds, and how the deployment is set (without addresses or keys).",
					parameters: Type.Object({}),
					async execute(_args, api) {
						if (!allowed(api.conversationId)) return refused();
						return answer(() => diagnostics.health());
					},
				}),
			],
		};
	},
});
