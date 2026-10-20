import { type ImageContent, type TextContent, type TSchema, Type } from "@earendil-works/pi-ai";
import { defineExtension, defineTool, section, type ToolRegistration } from "@earendil-works/pi-durable";
import { OWNER, type PimStore, type ToolPermission } from "../store";
import type { AppCatalog } from "./app-catalog";
import { type DirectoryApp, describeFound, findApps } from "./app-directory";
import { defineGatedAction, type GatedAction, type ResolvedPermission, resolvePermission } from "./approvals";
import type { ToolWidget } from "./define";
import { json, type PimServices, text } from "./services";

/**
 * Remote MCP servers as pi tools: the apps the user connects (calendar, mail,
 * notes...). The `agents` SDK's MCP client owns connections, OAuth and
 * reconnecting after a wake; this module turns its catalog into a pi
 * extension, which the space reinstalls whenever the catalog changes. pi
 * picks up the new tools from the next request, as a live reload.
 */

/** Which of a server's tools need the user's approval before each call. */
export type McpApproval =
	/** Tools that do not declare themselves read-only (the default). */
	| "writes"
	| "all"
	| "none";

export const MCP_APPROVALS: readonly McpApproval[] = ["writes", "all", "none"];

export type McpServerInfo = {
	readonly id: string;
	/** The app an extension implements that it connects, `<extension>/<app>`; MCP servers have none. */
	readonly app?: string;
	readonly name: string;
	readonly url: string;
	readonly state: string;
	readonly error: string | null;
	readonly authUrl: string | null;
	readonly instructions: string | null;
	readonly approval: McpApproval;
};

export type McpToolInfo = {
	readonly serverId: string;
	readonly name: string;
	readonly description?: string;
	readonly inputSchema: Record<string, unknown>;
	readonly annotations?: { readonly readOnlyHint?: boolean; readonly destructiveHint?: boolean; readonly title?: string };
};

type McpContent =
	| { type: "text"; text: string }
	| { type: "image"; data: string; mimeType: string }
	| { type: string; [key: string]: unknown };

export type McpCallResult = {
	readonly content?: readonly McpContent[];
	readonly structuredContent?: unknown;
	readonly isError?: boolean;
	/** What the result shows the person, from an app an extension implements. */
	readonly widget?: ToolWidget;
};

/** What the bridge needs from the host's MCP client. */
export type McpBridge = {
	servers(): readonly McpServerInfo[];
	tools(): readonly McpToolInfo[];
	call(serverId: string, name: string, args: Record<string, unknown>): Promise<McpCallResult>;
	/** Connects one of the directory's apps; `authUrl` when the user must sign in first. */
	connect(app: DirectoryApp): Promise<{ id: string; state: string; authUrl?: string }>;
	/** The server's capabilities from its handshake, or undefined while it is not connected. */
	capabilities(serverId: string): McpCapabilities | undefined;
	/** A raw JSON-RPC request, for MCP extensions the client SDK does not implement yet. */
	request(serverId: string, method: string, params: Record<string, unknown>): Promise<unknown>;
	readResource(serverId: string, uri: string): Promise<{ readonly contents: readonly McpResourceContent[] }>;
};

export type McpCapabilities = {
	readonly extensions?: Record<string, unknown>;
	readonly events?: unknown;
	readonly [key: string]: unknown;
};

export type McpResourceContent = {
	readonly uri: string;
	readonly mimeType?: string;
	readonly text?: string;
	readonly blob?: string;
};

const MAX_RESULT_CHARS = 20_000;
const MAX_INSTRUCTION_CHARS = 2_000;

/** Lowercase letters, digits and underscores, as a stable server id and tool-name prefix. */
export function slug(value: string): string {
	return (
		value
			.toLowerCase()
			.replace(/[^a-z0-9]+/g, "_")
			.replace(/^_+|_+$/g, "")
			.slice(0, 24) || "app"
	);
}

/** The pi tool name of an MCP tool: `<server>_<tool>`, within providers' 64-character limit. */
export function toolName(serverId: string, name: string): string {
	const full = `${serverId}_${name}`.replace(/[^a-zA-Z0-9_-]/g, "_");
	if (full.length <= 64) return full;
	let hash = 0;
	for (const char of full) hash = (hash * 31 + char.charCodeAt(0)) >>> 0;
	return `${full.slice(0, 55)}_${hash.toString(36).slice(0, 8)}`;
}

export function needsApproval(tool: McpToolInfo, approval: McpApproval): boolean {
	if (tool.annotations?.destructiveHint === true) return true;
	if (approval === "all") return true;
	if (approval === "none") return false;
	return tool.annotations?.readOnlyHint !== true;
}

/** JSON with object keys sorted, so equal values give equal text. */
function canonicalJson(value: unknown): string {
	return JSON.stringify(value, (_key, item: unknown) =>
		item && typeof item === "object" && !Array.isArray(item)
			? Object.fromEntries(Object.entries(item).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)))
			: item,
	);
}

/** What a permission is given to: what the model reads about the tool, its inputs, and what it says about itself. */
export function toolDefinition(tool: McpToolInfo): string {
	return canonicalJson({
		description: tool.description ?? null,
		inputSchema: tool.inputSchema ?? null,
		annotations: tool.annotations ?? null,
	});
}

/**
 * An app tool's permission for the owner (`OWNER`) or a circle: the user's
 * choice, or else, for the owner, the app's approval policy (`writes`:
 * read-only tools run, others ask), and for a circle, off.
 */
export function appToolPermission(
	store: PimStore,
	server: McpServerInfo,
	tool: McpToolInfo,
	audience: string = OWNER,
): ResolvedPermission {
	const fallback = audience !== OWNER ? "off" : needsApproval(tool, server.approval) ? "ask" : "on";
	const resolved = resolvePermission(store, audience, server.id, tool.name, fallback, toolDefinition(tool));
	return tool.annotations?.destructiveHint === true && resolved.permission === "on" ? { ...resolved, permission: "ask" } : resolved;
}

/** Whom one of the owner's agents' switches are given to, in the permissions an audience holds. */
export const agentAudience = (agentId: string) => `agent:${agentId}`;

/**
 * An app tool's switch in one of the owner's agents: on, the agent uses it
 * without asking; off, it isn't offered the tool. The person's choice for
 * that agent, held to the tool as it was when they switched it on, as a
 * circle's is; else what they chose for every agent before switches were
 * each agent's (asking counts as off); else on, unless the app marks the
 * tool destructive or asks before every call.
 */
export function agentToolPermission(store: PimStore, agentId: string, server: McpServerInfo, tool: McpToolInfo): ResolvedPermission {
	const definition = toolDefinition(tool);
	const before = resolvePermission(store, OWNER, server.id, tool.name, "on", definition);
	const fallback =
		before.chosen !== null ? (before.permission === "on" ? "on" : "off") : tool.annotations?.destructiveHint === true || server.approval === "all" ? "off" : "on";
	return resolvePermission(store, agentAudience(agentId), server.id, tool.name, fallback, definition);
}

function clip(value: string, limit: number): string {
	return value.length > limit ? `${value.slice(0, limit)}\n[... ${value.length - limit} more characters]` : value;
}

/** An MCP tool result as pi tool content: text and images kept, anything else as JSON. */
export function toContent(result: McpCallResult): (TextContent | ImageContent)[] {
	const content: (TextContent | ImageContent)[] = [];
	for (const part of result.content ?? []) {
		if (part.type === "text" && typeof part.text === "string") content.push({ type: "text", text: clip(part.text, MAX_RESULT_CHARS) });
		else if (part.type === "image" && typeof part.data === "string" && typeof part.mimeType === "string") {
			content.push({ type: "image", data: part.data, mimeType: part.mimeType });
		} else content.push({ type: "text", text: clip(JSON.stringify(part), MAX_RESULT_CHARS) });
	}
	if (content.length === 0 && result.structuredContent !== undefined) {
		content.push({ type: "text", text: clip(JSON.stringify(result.structuredContent), MAX_RESULT_CHARS) });
	}
	if (content.length === 0) content.push({ type: "text", text: "(no content)" });
	return content;
}

/** An MCP tool result as text, for reporting an approved call back to the conversation. */
export function toText(result: McpCallResult): string {
	const body = toContent(result)
		.map((part) => (part.type === "text" ? part.text : `[image ${part.mimeType}]`))
		.join("\n");
	return result.isError ? `The tool reported an error:\n${body}` : body;
}

export function summarizeCall(server: string, tool: string, args: Record<string, unknown>): string {
	const shown = JSON.stringify(args);
	return `${server}: ${tool} ${shown.length > 300 ? `${shown.slice(0, 300)}…` : shown}`;
}

/** Gated actions the MCP bridge files approvals for. */
export function mcpActions(bridge: McpBridge): GatedAction[] {
	const call = defineGatedAction({
		name: "mcp_call",
		description: "Call a tool of a connected app.",
		internal: true,
		parameters: Type.Object({
			server: Type.String(),
			tool: Type.String(),
			arguments: Type.Record(Type.String(), Type.Unknown()),
		}),
		summarize: ({ server, tool, arguments: args }) => summarizeCall(server, tool, args),
		async run({ server, tool, arguments: args }) {
			if (!bridge.servers().some((candidate) => candidate.id === server)) {
				return `The app ${server} is no longer connected.`;
			}
			return toText(await bridge.call(server, tool, args));
		},
	});

	return [call as GatedAction];
}

/** Each connected app's tools are a pi extension of their own; a chat selects those of the apps its agent works with. */
export const APP_PREFIX = "pim.app.";
export const appExtensionName = (serverId: string) => `${APP_PREFIX}${serverId}`;

/** The person's connection to an app of the directory: the one to its server, or to the app its extension implements. */
export function serverFor(servers: readonly McpServerInfo[], app: Pick<DirectoryApp, "ref" | "url">): McpServerInfo | undefined {
	return servers.find((server) => (app.url === null ? server.app === app.ref : server.url === app.url));
}

/**
 * The connected apps as pi extensions, rebuilt whenever the catalog changes:
 * `apps`, which every chat has (the `connected_apps` section and the tools
 * that find, list and connect apps), and one extension per ready app with its
 * tools, which only the chats of agents that list the app select.
 *
 * pi sends tools and sections in registry order and re-sends all of them when
 * one appears out of order, so the parts that come and go must sit at the end:
 * `apps` (always present) goes anywhere, the apps' own tools go last. A newly
 * connected app's tools are then appended to what the provider has cached.
 */
export function mcpExtensions(
	bridge: McpBridge,
	services: PimServices,
	extras: { catalog: AppCatalog; tools: readonly ToolRegistration[] },
	/** The apps a conversation's agent works with: its blueprint's, then the person's own. */
	appsOf: (session: string) => readonly DirectoryApp[],
	/** Every app the person can connect. */
	directory: () => readonly DirectoryApp[],
	/** Whether a conversation's agent may use an app's tool, as its switch is now. */
	permissionIn: (session: string, server: McpServerInfo, tool: McpToolInfo) => ToolPermission,
) {
	const all = bridge.servers();
	const servers = new Map(all.map((server) => [server.id, server]));
	const byServer = new Map<string, ToolRegistration[]>();
	for (const tool of bridge.tools()) {
		const server = servers.get(tool.serverId);
		if (!server || server.state !== "ready") continue;
		const name = toolName(server.id, tool.name);
		const tools = byServer.get(server.id) ?? [];
		byServer.set(server.id, tools);
		tools.push(
			defineTool({
				name,
				description: `[${server.name}] ${tool.description ?? tool.annotations?.title ?? tool.name}`,
				// MCP input schemas are JSON Schema, which pi validates as given.
				parameters: { type: "object", ...tool.inputSchema } as unknown as TSchema,
				// A call is replay-safe only if the app says the tool only reads.
				replay: tool.annotations?.readOnlyHint === true ? "safe" : "unsafe",
				async execute(args, api) {
					const call = { server: server.id, tool: tool.name, arguments: (args ?? {}) as Record<string, unknown> };
					// Checked again as the app and the agent's switch are now: a tool switched off, or changed by its app,
					// since the conversation's tools were chosen is refused.
					const now = bridge.tools().find((candidate) => candidate.serverId === server.id && candidate.name === tool.name);
					if (!now) return text(`${server.name} doesn't offer ${tool.name} right now.`, true);
					if (permissionIn(String(api.conversationId), server, now) === "off") {
						return text(`The person switched ${name} off for this agent. Do not try it another way.`, true);
					}
					const result = await bridge.call(server.id, tool.name, call.arguments);
					const content = toContent(result);
					// What the result shows is kept for this chat, for the model to put under a message.
					if (result.widget && !result.isError) {
						const ref = services.keepWidget(String(api.conversationId), result.widget);
						content.push({ type: "text", text: `To show the person this result, add "${ref}" to send_to_user's widgets.` });
					}
					return { content, ...(result.isError ? { isError: true } : {}) };
				},
			}) as ToolRegistration,
		);
	}

	const listApps = defineTool({
		name: "list_apps",
		description: "List the apps this agent works with, whether each is connected, and their tools.",
		parameters: Type.Object({}),
		replay: "safe",
		async execute(_args, api) {
			const catalog = bridge.tools();
			return json(
				appsOf(String(api.conversationId)).map((app) => {
					const server = serverFor(all, app);
					return {
						id: app.ref,
						name: app.name,
						state: server?.state ?? "not connected",
						...(server?.error ? { error: server.error } : {}),
						tools: server ? catalog.filter((tool) => tool.serverId === server.id).map((tool) => toolName(server.id, tool.name)) : [],
					};
				}),
			);
		},
	});

	const connectApp = defineTool({
		name: "connect_app",
		description:
			"Connect one of the apps this agent works with that isn't connected yet, giving you its tools. If the person must sign in first, you get a link to give them. Only the apps listed in connected_apps can be connected.",
		parameters: Type.Object({ app: Type.String({ description: "The app's id or name, as connected_apps lists it." }) }),
		replay: "safe",
		async execute({ app: wanted }, api) {
			const mine = appsOf(String(api.conversationId));
			const app = mine.find((candidate) => candidate.ref === wanted.trim() || candidate.name.toLowerCase() === wanted.trim().toLowerCase());
			if (!app) {
				const names = mine.map((candidate) => candidate.name).join(", ");
				return text(
					`This agent doesn't work with ${wanted}${names ? `; its apps are ${names}` : ""}. If manage_apps is available, request adding it there by its id from find_app; approval adds and connects it. Otherwise the person can add it in Your agents.`,
					true,
				);
			}
			const existing = serverFor(bridge.servers(), app);
			if (existing?.state === "ready") return text(`${app.name} is already connected.`);
			try {
				const result = await bridge.connect(app);
				if (result.authUrl) {
					return text(`${app.name} needs the person to sign in before it can be used. Give them this link: ${result.authUrl}`);
				}
				const tools = bridge.tools().filter((tool) => tool.serverId === result.id);
				return text(`Connected ${app.name}. Its tools: ${tools.map((tool) => toolName(result.id, tool.name)).join(", ") || "none"}.`);
			} catch (error) {
				return text(error instanceof Error ? error.message : String(error), true);
			}
		},
	});

	const findApp = defineTool({
		name: "find_app",
		description:
			"Find an app this Pim offers by what the person calls it, for its id, which manage_apps adds. Only apps this Pim offers can be connected.",
		parameters: Type.Object({
			app: Type.String({ minLength: 2, maxLength: 60, description: "The app's name, like Linear or Notion, or what it does." }),
		}),
		replay: "safe",
		async execute({ app }) {
			return text(describeFound(app, findApps(directory(), app)));
		},
	});

	const apps = defineExtension({
		name: "pim.apps",
		tools: [listApps, connectApp, findApp, ...extras.tools],
		sections: [
			// Always present, so it never appears out of order (which makes pi re-send every section).
			section("connected_apps", ({ conversationId }) => {
				const mine = appsOf(String(conversationId));
				if (mine.length === 0) {
					return "This agent works with no apps. When the person wants one, find it with find_app, then use manage_apps if available to request adding and connecting it with their approval. If app management is off, the person can add apps in Your agents.";
				}
				return mine
					.map((app) => {
						const server = serverFor(all, app);
						if (server?.state !== "ready") {
							const why = server?.state === "authenticating" ? "waiting for the person to sign in" : "not connected";
							return `## ${app.name} [id: ${app.ref}]\n(${why}: connect_app connects it)`;
						}
						const lines = [`## ${app.name} [id: ${app.ref}]`];
						if (server.instructions) lines.push(clip(server.instructions, MAX_INSTRUCTION_CHARS));
						// Skills come from the app and are untrusted like its instructions; they load with read_skill.
						const skills = extras.catalog.skills(server.id);
						if (skills.length > 0) {
							lines.push(
								`Skills from ${server.name} (load with read_skill):`,
								...skills.map((skill) => `- ${skill.name}: ${clip(skill.description, 300)}`),
							);
						}
						const events = extras.catalog.events(server.id);
						if (events.length > 0) {
							lines.push(`Events you can watch (watch_app_event): ${events.map((event) => event.name).join(", ")}`);
						}
						return lines.join("\n");
					})
					.join("\n\n");
			}),
		],
	});

	return {
		apps,
		tools: [...byServer].map(([id, tools]) => defineExtension({ name: appExtensionName(id), tools })),
	};
}
