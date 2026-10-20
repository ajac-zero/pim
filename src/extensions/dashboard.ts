import { Type } from "@earendil-works/pi-ai";
import { defineExtension, defineTool } from "@earendil-works/pi-durable";
import type { Agent } from "../agents";
import { json, text } from "./services";

export const UPDATE_DASHBOARD = "update_dashboard";

/** What a dashboard holds at most. */
export const MAX_DASHBOARD = 12;

/** What the dashboard tool needs from the space. */
export type DashboardHost = {
	/** The agent whose dashboard a conversation changes; null where none may, such as a visit. */
	agentOf(session: string): Agent | null;
	/**
	 * Pins and unpins items, by an artifact's id or a widget's name, and
	 * answers with what the dashboard shows then, and the widgets it could;
	 * throws what it refuses.
	 */
	change(agent: Agent, changes: { pin: readonly string[]; unpin: readonly string[] }): unknown;
};

/**
 * Lets an agent change its own dashboard, the screen where the person starts
 * a chat with it: pin what the person asked to see there, an artifact it made
 * or a widget, and take things off. It changes only the person's own screen,
 * so it needs no approval.
 */
export function dashboardExtension(host: DashboardHost) {
	const updateDashboard = defineTool({
		name: UPDATE_DASHBOARD,
		description:
			"Change your dashboard: the screen the person sees when they open you to start a chat, empty until they ask for something there. " +
			"Pin what they ask to see there, such as a chart of their spending, today's headlines or a habit tracker. " +
			"Like a phone's home screen, the dashboard shows each artifact as its widget, a small view of it, and opens the whole artifact from there. " +
			"So make it an html or jsx artifact (a jsx artifact can draw charts with recharts) with a widget file beside its main one, widget.html for a page or Widget.jsx for an app (`export default function Widget() { ... }`), then pin its id; an artifact without one can't be pinned. " +
			"The widget is a tile about 420 by 180 pixels (the whole width, about 360, on phones) that shouldn't scroll: the figure that matters, a small chart, the next three items, never the whole app. " +
			"Give it a background of its own that fills the tile, and leave headings out: its title shows under it. " +
			"It shares the artifact's files and window.pim data, so it shows what the full artifact keeps; `pim.open()` opens the full artifact, so make the widget open it when tapped, " +
			"or let the person tap an item to talk about it with `pim.chat(text)`. " +
			"A pinned artifact always shows its latest version and runs live, so it can keep its own data and call the person's app tools through window.pim; " +
			"to keep one current with what only you can fetch, such as news, update the artifact on a schedule with `schedule_task`. " +
			"You can also pin a widget by its name. Unpin what they no longer want. Call it with nothing to see what it shows now. Pin only what the person asked for.",
		parameters: Type.Object({
			pin: Type.Optional(Type.Array(Type.String({ description: "An artifact's id, or a widget's name such as pim.goals/active." }), { maxItems: MAX_DASHBOARD })),
			unpin: Type.Optional(Type.Array(Type.String({ description: "An artifact's id or a widget's name now on the dashboard." }), { maxItems: MAX_DASHBOARD })),
		}),
		replay: "safe",
		async execute({ pin, unpin }, api) {
			const agent = host.agentOf(String(api.conversationId));
			if (!agent) return text("There is no dashboard of yours to change here.", true);
			try {
				return json(host.change(agent, { pin: pin ?? [], unpin: unpin ?? [] }));
			} catch (error) {
				return text(error instanceof Error ? error.message : String(error), true);
			}
		},
	});
	return defineExtension({ name: "pim.dashboard", tools: [updateDashboard] });
}
