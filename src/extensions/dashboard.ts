import { Type } from "@earendil-works/pi-ai";
import { defineExtension, defineTool } from "@earendil-works/pi-durable";
import type { Agent } from "../agents";
import { json, text } from "./services";

export const UPDATE_DASHBOARD = "update_dashboard";

/** What a dashboard holds at most. */
export const MAX_DASHBOARD = 12;

/**
 * The sizes an artifact's widget comes in, as on a phone's home screen: a
 * square a quarter of the dashboard's width (half on phones), a tile as tall
 * and twice as wide, and one twice as tall as that.
 */
export const WIDGET_SIZES = ["small", "medium", "large"] as const;
export type WidgetSize = (typeof WIDGET_SIZES)[number];
/** The size a widget is pinned at, unless the agent or the person chooses another. */
export const DEFAULT_WIDGET_SIZE: WidgetSize = "medium";

/** What the dashboard tool needs from the space. */
export type DashboardHost = {
	/** The agent whose dashboard a conversation changes; null where none may, such as a visit. */
	agentOf(session: string): Agent | null;
	/**
	 * Pins and unpins items, by an artifact's id or a widget's name, and sizes
	 * artifacts' widgets, and answers with what the dashboard shows then, and
	 * the widgets it could; throws what it refuses.
	 */
	change(agent: Agent, changes: { pin: readonly string[]; unpin: readonly string[]; sizes: Readonly<Record<string, WidgetSize>> }): unknown;
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
			"The widget is a tile that shouldn't scroll, in one of three sizes, as on a phone: small, a square about 200 pixels (170 on phones) for one figure or a ring; medium, the default, as tall and about 420 wide (360 on phones) for a figure with a small chart or the next three items; large, about 420 by 460 (360 by 390 on phones), for a chart or a short list. " +
			"Choose the size that fits with `sizes`; the person can change it, so make the widget fit every size, showing more as it grows: `pim.size` says which it is, and the page reloads when it changes. Never fit the whole app in it. " +
			"Give it a background of its own that fills the tile, and leave headings out: its title shows under it. " +
			"It shares the artifact's files and window.pim data, so it shows what the full artifact keeps; `pim.open()` opens the full artifact, so make the widget open it when tapped, " +
			"or let the person tap an item to talk about it with `pim.chat(text)`. " +
			"A pinned artifact always shows its latest version and runs live, so it can keep its own data and call the person's app tools through window.pim; " +
			"to keep one current with what only you can fetch, such as news, update the artifact on a schedule with `schedule_task`. " +
			"You can also pin a widget by its name. Unpin what they no longer want. Call it with nothing to see what it shows now. Pin only what the person asked for.",
		parameters: Type.Object({
			pin: Type.Optional(Type.Array(Type.String({ description: "An artifact's id, or a widget's name such as pim.goals/active." }), { maxItems: MAX_DASHBOARD })),
			unpin: Type.Optional(Type.Array(Type.String({ description: "An artifact's id or a widget's name now on the dashboard." }), { maxItems: MAX_DASHBOARD })),
			sizes: Type.Optional(
				Type.Record(Type.String(), Type.Union(WIDGET_SIZES.map((size) => Type.Literal(size))), {
					description: "The size of artifacts' widgets you pin, or that are on the dashboard already, by artifact id, such as {\"<id>\": \"small\"}. Left out, a new one is medium and one already there keeps its size.",
				}),
			),
		}),
		replay: "safe",
		async execute({ pin, unpin, sizes }, api) {
			const agent = host.agentOf(String(api.conversationId));
			if (!agent) return text("There is no dashboard of yours to change here.", true);
			try {
				return json(host.change(agent, { pin: pin ?? [], unpin: unpin ?? [], sizes: sizes ?? {} }));
			} catch (error) {
				return text(error instanceof Error ? error.message : String(error), true);
			}
		},
	});
	return defineExtension({ name: "pim.dashboard", tools: [updateDashboard] });
}
