import { type Static, Type } from "@earendil-works/pi-ai";
import { defineExtension, defineTool, type ToolExecutionResult } from "@earendil-works/pi-durable";
import type { Computer } from "../computer";
import { defineGatedAction, type GatedAction } from "./approvals";
import { type McpCallResult, toContent, toText } from "./mcp";
import { text } from "./services";

/**
 * The computer's desktop as tools, where it runs Cua Driver (see
 * ../computer.ts's `desktop`): the computers Pim's host keeps, and the
 * person's own where they run Cua's cua-spacesd. Agents look at the
 * desktop, read a window's accessibility tree, and act in its apps, which
 * Cua Driver does without taking the person's pointer or focus, so the
 * person can go on using the desktop from Computer meanwhile. Looking and
 * reading run at once. Acting can do anything the person could at the
 * computer, so it's a gated action, as `shell` is.
 */
export const DESKTOP_EXTENSION = "pim.desktop";
export const DESKTOP_ACT = "desktop_act";

const ABOUT = `The person's computer has a desktop, which they can watch and use from Computer in the app while you work there. Use the desktop tools for its apps; for web pages, use the browser tools, whose windows are on the same desktop. desktop_look shows the screen with its windows, each with its pid and window_id; desktop_read lists a window's elements, numbered [N] in a snapshot; desktop_act acts on an element by its element_token, which is \`<snapshot id>:N\`, or at a point only for what has no element. Read again after the window changes: a snapshot's tokens stop working.`;

/** The label Cua Driver keeps a conversation's cursor and snapshots under. */
const sessionOf = (conversation: string) => `pim-${conversation.replace(/[^\w-]/g, "").slice(0, 24)}`;

async function driverCall(computer: Computer, tool: string, args: Record<string, unknown>): Promise<ToolExecutionResult> {
	try {
		const result = (await computer.driver(tool, args)) as McpCallResult;
		return { content: toContent(result), ...(result.isError ? { isError: true } : {}) };
	} catch (error) {
		return text(error instanceof Error ? error.message : String(error), true);
	}
}

const Pid = Type.Integer({ description: "The app's process, as desktop_look or desktop_read shows it." });
const WindowId = Type.Integer({ description: "The window, as desktop_look or desktop_read shows it." });

const ActArgs = Type.Object({
	action: Type.Union(
		[
			Type.Literal("launch_app"),
			Type.Literal("click"),
			Type.Literal("double_click"),
			Type.Literal("right_click"),
			Type.Literal("type_text"),
			Type.Literal("press_key"),
			Type.Literal("hotkey"),
			Type.Literal("scroll"),
			Type.Literal("set_value"),
			Type.Literal("kill_app"),
		],
		{
			description:
				"launch_app: open an app by `name` (or `urls` in their app). click, double_click, right_click: an element, or a point. type_text: type `text` into the window's focused field, or an element's. press_key: one `key`, such as enter, tab or escape. hotkey: `keys` together, such as [\"ctrl\", \"s\"]. scroll: `direction`, `amount` lines. set_value: set an element's `value`. kill_app: force-quit `pid`, losing what isn't saved.",
		},
	),
	pid: Type.Optional(Pid),
	window_id: Type.Optional(WindowId),
	element_token: Type.Optional(Type.String({ description: "An element from desktop_read: `<snapshot id>:N`." })),
	x: Type.Optional(Type.Number({ description: "A point in the window, in the pixels of its screenshot, for what has no element." })),
	y: Type.Optional(Type.Number()),
	text: Type.Optional(Type.String({ maxLength: 5_000 })),
	key: Type.Optional(Type.String()),
	keys: Type.Optional(Type.Array(Type.String(), { maxItems: 5 })),
	value: Type.Optional(Type.String({ maxLength: 5_000 })),
	direction: Type.Optional(Type.Union([Type.Literal("up"), Type.Literal("down"), Type.Literal("left"), Type.Literal("right")])),
	amount: Type.Optional(Type.Integer({ minimum: 1, maximum: 50 })),
	name: Type.Optional(Type.String({ description: "For launch_app: the app's name or command, as desktop_read without a pid lists them." })),
	urls: Type.Optional(Type.Array(Type.String(), { maxItems: 10 })),
	foreground: Type.Optional(
		Type.Boolean({
			description:
				"Bring the window to the front and give it the focus to act, as at the computer itself, where acting in the background is refused (on some desktops keys can only go to the focused window). Input of the person's at the same time may land there too.",
		}),
	),
});

/** What an action does, as the person reads it to decide. */
function summarize(args: Static<typeof ActArgs>): string {
	const where = args.element_token ? `element ${args.element_token}` : args.x !== undefined ? `(${args.x}, ${args.y})` : "the window";
	const app = args.pid !== undefined ? ` in app ${args.pid}` : "";
	switch (args.action) {
		case "launch_app":
			return `Open ${args.name ?? args.urls?.join(", ") ?? "an app"} on your computer`;
		case "type_text":
			return `Type “${(args.text ?? "").slice(0, 300)}” on your computer${app}`;
		case "press_key":
			return `Press ${args.key ?? "a key"} on your computer${app}`;
		case "hotkey":
			return `Press ${(args.keys ?? []).join("+")} on your computer${app}`;
		case "scroll":
			return `Scroll ${args.direction ?? ""} on your computer${app}`;
		case "set_value":
			return `Set ${where} to “${(args.value ?? "").slice(0, 300)}” on your computer${app}`;
		case "kill_app":
			return `Force-quit app ${args.pid} on your computer, losing what isn't saved`;
		default:
			return `${args.action === "click" ? "Click" : args.action === "double_click" ? "Double-click" : "Right-click"} ${where} on your computer${app}`;
	}
}

/** Acting in the desktop's apps, once the person approved it, or lets it run without asking. */
export function desktopAction(computer: Computer): GatedAction {
	return defineGatedAction({
		name: DESKTOP_ACT,
		description: `Act in an app on the person's computer's desktop: open apps, click, type, press keys, scroll. ${ABOUT} Returns what changed.`,
		parameters: ActArgs,
		summarize,
		async run({ action, foreground, ...args }, { session }) {
			const delivery = foreground ? { delivery_mode: "foreground" } : {};
			return toText((await computer.driver(action, { ...args, ...delivery, session: sessionOf(session) })) as McpCallResult);
		},
	}) as GatedAction;
}

/** Looking at the desktop and reading its windows, while the computer has one agents can use. */
export function desktopExtension(computer: Computer) {
	const look = defineTool({
		name: "desktop_look",
		description: `See the person's computer's desktop: a screenshot, with its windows, each with its app's pid and its window_id. ${ABOUT}`,
		parameters: Type.Object({}),
		replay: "safe",
		async execute(_args, api) {
			return driverCall(computer, "get_desktop_state", { session: sessionOf(String(api.conversationId)) });
		},
	});

	const read = defineTool({
		name: "desktop_read",
		description:
			"Read a window of an app on the person's computer: its elements from the accessibility tree, each numbered [N], with the snapshot id their element_token starts with. Give a `query` to list only matching elements, such as Save. Without a pid, lists the apps, running and installed, with what desktop_act's launch_app takes.",
		parameters: Type.Object({
			pid: Type.Optional(Pid),
			window_id: Type.Optional(WindowId),
			query: Type.Optional(Type.String({ description: "Words the elements to list match." })),
		}),
		replay: "safe",
		async execute(args, api) {
			const session = sessionOf(String(api.conversationId));
			return args.pid === undefined ? driverCall(computer, "list_apps", { session }) : driverCall(computer, "get_window_state", { ...args, session });
		},
	});

	return defineExtension({ name: DESKTOP_EXTENSION, tools: [look, read] });
}
