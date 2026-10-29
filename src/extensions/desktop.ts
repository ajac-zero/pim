import { type ImageContent, type TSchema, Type } from "@earendil-works/pi-ai";
import { defineExtension, defineTool, type ToolExecutionApi, type ToolRegistration } from "@earendil-works/pi-durable";
import type { NativeOutcome } from "../../computer/native-outcome";
import type { BindResult, DispatchResult, NativeBinding, NativeIdentityClaim } from "../cua-native-identity";
import { approvalNote, defineGatedAction, fileApproval, type GatedAction, ownToolPermission } from "./approvals";
import { type PimServices, text } from "./services";

/**
 * The desktop's native apps, as agents use them on an operator's Cua
 * computer (docs/cua-native-mcp.md): the curated native-app tools, each one
 * call of `Computer.native` inside one request the control state admits.
 *
 * Every call is bound first (`NativeIdentityBinder`, ./cua-native-identity.ts)
 * to who makes it: the space, the agent, the tool task, its call and its run,
 * as an authority vouches for them, never the model. Reading the desktop is
 * then sent at once, as the call's own request. Acting on it (raising a
 * window, clicking, typing, keys and scrolling) files an approval for the
 * binding, like `shell`, and is sent only when the approval is decided, under
 * the lease it was filed under.
 *
 * There is no tool that starts an app: `launch_app` runs any program
 * (docs/cua-native-mcp.md). An agent starts one with `shell`, which asks the
 * person as any command does.
 *
 * Pim offers these tools only where its own code gives an authority, and
 * none does yet: the harness publishes no run identity a call can be checked
 * against (docs/cua-native-identity.md, docs/pi-durable-run-identity.md).
 */

export const DESKTOP_EXTENSION = "pim.desktop";

const pid = Type.Integer({ minimum: 1, maximum: 4_194_304, description: "The app's process ID, from desktop_list_apps or desktop_list_windows." });
const windowId = Type.Optional(Type.Integer({ minimum: 0, maximum: 0xffff_ffff, description: "One of the process's windows, from desktop_list_windows." }));
const pixel = (axis: string) => Type.Optional(Type.Number({ minimum: 0, maximum: 16_384, description: `The ${axis} pixel in the window's screenshot.` }));
const elementToken = Type.Optional(Type.String({ maxLength: 32, description: "An element from desktop_window_state, such as s0a1b2c3d:12; instead of x and y." }));
const deliveryMode = Type.Optional(Type.Union([Type.Literal("background"), Type.Literal("foreground")]));
const target = { pid, window_id: windowId, element_token: elementToken, x: pixel("x"), y: pixel("y"), delivery_mode: deliveryMode };

/** Each tool agents see, by the curated native-app tool it calls; reads are sent at once, actions after approval. */
const TOOLS = {
	desktop_list_apps: {
		native: "list_apps",
		read: true,
		description: "List the desktop's running and installed apps, with their process IDs.",
		parameters: Type.Object({}),
	},
	desktop_list_windows: {
		native: "list_windows",
		read: true,
		description: "List the desktop's top-level windows, with their process and window IDs.",
		parameters: Type.Object({ pid: Type.Optional(pid), app: Type.Optional(Type.String({ maxLength: 256 })), on_screen_only: Type.Optional(Type.Boolean()) }),
	},
	desktop_window_state: {
		native: "get_window_state",
		read: true,
		description: "Read one app window: its accessibility tree, with element tokens to act on, and a screenshot.",
		parameters: Type.Object({
			pid,
			window_id: windowId,
			include_accessibility_tree: Type.Optional(Type.Boolean()),
			include_screenshot: Type.Optional(Type.Boolean()),
			query: Type.Optional(Type.String({ maxLength: 256, description: "Only elements matching this." })),
			max_elements: Type.Optional(Type.Integer({ minimum: 1, maximum: 5000 })),
			max_depth: Type.Optional(Type.Integer({ minimum: 1, maximum: 256 })),
			timeout_ms: Type.Optional(Type.Integer({ minimum: 100, maximum: 30_000 })),
			tree_format: Type.Optional(Type.Union([Type.Literal("markdown"), Type.Literal("elements"), Type.Literal("both")])),
			since: Type.Optional(Type.String({ maxLength: 16, description: "latest, or a snapshot ID, to see what changed." })),
		}),
	},
	desktop_bring_to_front: {
		native: "bring_to_front",
		read: false,
		description: "Bring an app's window to the front of the desktop.",
		parameters: Type.Object({ pid, window_id: windowId }),
	},
	desktop_click: {
		native: "click",
		read: false,
		description: "Click in an app's window, at a pixel or on an element.",
		parameters: Type.Object({
			...target,
			button: Type.Optional(Type.Union([Type.Literal("left"), Type.Literal("right"), Type.Literal("middle")])),
			count: Type.Optional(Type.Integer({ minimum: 1, maximum: 3 })),
		}),
	},
	desktop_type_text: {
		native: "type_text",
		read: false,
		description: "Type text into an app's window. Typed into a terminal, it runs as commands.",
		parameters: Type.Object({ ...target, text: Type.String({ minLength: 1, maxLength: 4096 }) }),
	},
	desktop_press_key: {
		native: "press_key",
		read: false,
		description: "Press one key in an app's window, with modifiers if given.",
		parameters: Type.Object({
			...target,
			key: Type.String({ minLength: 1, maxLength: 32, description: "Such as Return, Tab, Escape or a." }),
			modifiers: Type.Optional(Type.Array(Type.Union([Type.Literal("ctrl"), Type.Literal("shift"), Type.Literal("alt"), Type.Literal("super")]), { maxItems: 4 })),
		}),
	},
	desktop_hotkey: {
		native: "hotkey",
		read: false,
		description: "Press a chord of keys together in an app's window, such as ctrl and s.",
		parameters: Type.Object({ ...target, keys: Type.Array(Type.String({ minLength: 1, maxLength: 32 }), { minItems: 2, maxItems: 5 }) }),
	},
	desktop_scroll: {
		native: "scroll",
		read: false,
		description: "Scroll in an app's window.",
		parameters: Type.Object({
			...target,
			direction: Type.Union([Type.Literal("up"), Type.Literal("down"), Type.Literal("left"), Type.Literal("right")]),
			by: Type.Optional(Type.Union([Type.Literal("line"), Type.Literal("page")])),
			amount: Type.Optional(Type.Integer({ minimum: 1, maximum: 50 })),
		}),
	},
} satisfies Record<string, { native: string; read: boolean; description: string; parameters: TSchema }>;

type DesktopTool = keyof typeof TOOLS;

/** The actions agents ask to take on the desktop, each filed as an approval. */
export const DESKTOP_ACTIONS: ReadonlySet<string> = new Set(Object.entries(TOOLS).flatMap(([name, tool]) => (tool.read ? [] : [name])));

const SHARED =
	"Only apps already running can be used: start one with shell, detached, such as `setsid gedit >/dev/null 2>&1 &`, which asks the person as any command does.";

export type DesktopServices = {
	/** Binds a call to who makes it, before anything is filed or sent. */
	bind(claim: NativeIdentityClaim, tool: string, args: unknown): Promise<BindResult>;
	/** Sends a bound read now, as the call's own request. */
	read(binding: NativeBinding): Promise<DispatchResult>;
};

/** What an approval for a desktop action holds: the binding, and its frozen call, which is what is shown and sent. */
type ActionArgs = { binding: string; tool: string; arguments: Record<string, unknown> };
const ActionArgs = Type.Object({ binding: Type.String(), tool: Type.String(), arguments: Type.Record(Type.String(), Type.Unknown()) });

/** The call's claim, from the harness's own invocation, never from its arguments. */
const claimOf = (api: ToolExecutionApi): NativeIdentityClaim => ({ conversationId: String(api.conversationId), toolTaskId: String(api.taskId), callId: api.callId });

/** One line the person reads to decide. */
function summarize(tool: string, args: Record<string, unknown>): string {
	const where = `in the window of process ${args.pid}`;
	const at = typeof args.element_token === "string" ? ` on element ${args.element_token}` : args.x !== undefined ? ` at (${args.x}, ${args.y})` : "";
	switch (tool) {
		case "bring_to_front":
			return `Bring the window of process ${args.pid} to the front of the desktop`;
		case "click":
			return `Click${at} ${where}`;
		case "type_text":
			return `Type “${args.text}”${at} ${where}`;
		case "press_key":
			return `Press ${[...((args.modifiers as string[] | undefined) ?? []), args.key].join("+")} ${where}`;
		case "hotkey":
			return `Press ${(args.keys as string[]).join("+")} ${where}`;
		case "scroll":
			return `Scroll ${args.direction}${at} ${where}`;
		default:
			return `${tool} ${where}`;
	}
}

/** What the model hears of a native call's outcome. Nothing the computer said is passed on but the tool's own bounded answer. */
export function describeOutcome(outcome: NativeOutcome): { text: string; images: ImageContent[]; isError: boolean } {
	switch (outcome.status) {
		case "completed": {
			const said = outcome.content.flatMap((item) => (item.type === "text" ? [item.text] : [])).join("\n");
			const images = outcome.content.flatMap((item): ImageContent[] => (item.type === "image" ? [{ type: "image", data: item.data, mimeType: item.mimeType }] : []));
			const left = outcome.presentation.length > 0 ? `\n(Some of the answer was cut or left out: ${outcome.presentation.length} part(s).)` : "";
			if (outcome.isError) return { text: `The app refused or failed${outcome.code ? ` (${outcome.code})` : ""}: ${said || "it said nothing more"}${left}`, images, isError: true };
			return { text: `${said || "Done."}${left}`, images, isError: false };
		}
		case "rpc_error":
			return { text: `The desktop refused the call before running it (code ${outcome.code}).`, images: [], isError: true };
		case "rejected":
			return { text: `Nothing was sent to the desktop (${outcome.reason}).`, images: [], isError: true };
		case "unknown":
			return {
				text: `The call may have run on the desktop, and nothing says whether it did (${outcome.reason}). Nothing more is sent for this run, and the computer takes no agent's request until the person's operator settles it.`,
				images: [],
				isError: true,
			};
	}
}

/**
 * The actions an approval can be for, one per desktop tool that acts. `decide`
 * dispatches the approved binding (in ./pim.ts, under the approval's lease).
 */
export function desktopActions(decide: (bindingId: string, request: { readonly session: string; readonly approval?: string }) => Promise<string>): GatedAction[] {
	return [...DESKTOP_ACTIONS].map((name) =>
		defineGatedAction({
			name,
			description: TOOLS[name as DesktopTool].description,
			parameters: ActionArgs,
			internal: true,
			summarize: (args: ActionArgs) => summarize(args.tool, args.arguments),
			run: (args: ActionArgs, request) => decide(args.binding, request),
		}) as GatedAction,
	);
}

/** The desktop's tools: reads, and actions the person can switch off or let run without asking, as `shell`. */
export function desktopExtension(services: PimServices, desktop: DesktopServices) {
	const tools: ToolRegistration[] = [];
	for (const [name, tool] of Object.entries(TOOLS) as [DesktopTool, (typeof TOOLS)[DesktopTool]][]) {
		if (tool.read) {
			tools.push(
				defineTool({
					name,
					description: `${tool.description} ${SHARED}`,
					parameters: tool.parameters as TSchema,
					replay: "safe",
					async execute(args, api) {
						const bound = await desktop.bind(claimOf(api), tool.native, args);
						if (!bound.ok) return text(bound.message, true);
						const sent = await desktop.read(bound.binding);
						if (!sent.ok) return text(sent.message, true);
						const said = describeOutcome(sent.outcome);
						return { content: [{ type: "text", text: said.text }, ...said.images], ...(said.isError ? { isError: true } : {}) };
					},
				}),
			);
			continue;
		}
		const { permission } = ownToolPermission(services.store, name);
		if (permission === "off") continue;
		tools.push(
			defineTool({
				name,
				description: `${tool.description} ${SHARED}${permission === "ask" ? ` ${approvalNote(services)}` : ""}`,
				parameters: tool.parameters as TSchema,
				replay: "safe",
				async execute(args, api, context) {
					// Bound once: run again (woken by its decision, or after a restart), the call files the approval it filed.
					let memo = await api.memo<string>(name, context);
					if (memo === undefined) {
						const result = await desktop.bind(claimOf(api), tool.native, args);
						if (!result.ok) return text(result.message, true);
						memo = await api.memo(name, JSON.stringify({ binding: result.binding.id, arguments: result.binding.arguments }), context);
					}
					const bound = JSON.parse(memo) as { binding: string; arguments: Record<string, unknown> };
					const filed: ActionArgs = { binding: bound.binding, tool: tool.native, arguments: bound.arguments };
					return fileApproval(services, api, context, { action: name, tool: name, args: filed, summary: summarize(tool.native, bound.arguments) });
				},
			}),
		);
	}
	return defineExtension({ name: DESKTOP_EXTENSION, tools });
}
