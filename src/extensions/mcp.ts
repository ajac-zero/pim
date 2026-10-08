import { type ImageContent, type TextContent, type TSchema, Type } from "@earendil-works/pi-ai";
import { defineExtension, defineTool, section, type ToolRegistration } from "@earendil-works/pi-durable";
import type { AppCatalog } from "./app-catalog";
import { APPROVAL_NOTE, defineGatedAction, fileApproval, type GatedAction } from "./approvals";
import { json, type PimServices, text } from "./services";

/**
 * Remote MCP servers as pi tools: the apps the user connects (calendar, mail,
 * notes...). The `agents` SDK's MCP client owns connections, OAuth and
 * reconnecting after a wake; this module turns its catalog into a pi
 * extension, which the agent reinstalls whenever the catalog changes. pi
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
	readonly annotations?: { readonly readOnlyHint?: boolean; readonly title?: string };
};

type McpContent =
	| { type: "text"; text: string }
	| { type: "image"; data: string; mimeType: string }
	| { type: string; [key: string]: unknown };

export type McpCallResult = {
	readonly content?: readonly McpContent[];
	readonly structuredContent?: unknown;
	readonly isError?: boolean;
};

/** What the bridge needs from the host's MCP client. */
export type McpBridge = {
	servers(): readonly McpServerInfo[];
	tools(): readonly McpToolInfo[];
	call(serverId: string, name: string, args: Record<string, unknown>): Promise<McpCallResult>;
	/** Adds and connects a server; `authUrl` when the user must sign in first. */
	connect(name: string, url: string): Promise<{ id: string; state: string; authUrl?: string }>;
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
	if (approval === "all") return true;
	if (approval === "none") return false;
	return tool.annotations?.readOnlyHint !== true;
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

function summarizeCall(server: string, tool: string, args: Record<string, unknown>): string {
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

	const connect = defineGatedAction({
		name: "connect_app",
		description:
			"Connect an app through its remote MCP server URL, giving you its tools. Use the URL the app's documentation gives for its MCP server.",
		parameters: Type.Object({
			name: Type.String({ minLength: 1, maxLength: 40, description: "Short name, like Calendar or Linear." }),
			url: Type.String({ pattern: "^https://" }),
		}),
		summarize: ({ name, url }) => `Connect ${name} (${url}) and let me use its tools`,
		async run({ name, url }) {
			const result = await bridge.connect(name, url);
			if (result.authUrl) {
				return `The app needs the user to sign in before it can be used. Give them this link: ${result.authUrl}`;
			}
			const tools = bridge.tools().filter((tool) => tool.serverId === result.id);
			return `Connected ${name}. Its tools: ${tools.map((tool) => toolName(result.id, tool.name)).join(", ") || "none"}.`;
		},
	});

	return [call as GatedAction, connect as GatedAction];
}

/**
 * The connected apps, as two pi extensions rebuilt whenever the catalog changes.
 *
 * pi sends tools and sections in registry order and re-sends all of them when
 * one appears out of order, so the parts that come and go must sit at the end:
 * `apps` (always present: the `connected_apps` section and `list_apps`) goes
 * anywhere, `tools` (the apps' own tools, no sections) goes last. A newly
 * connected app's tools are then appended to what the provider has cached.
 */
export function mcpExtensions(
	bridge: McpBridge,
	services: PimServices,
	extras: { catalog: AppCatalog; tools: readonly ToolRegistration[] },
) {
	const servers = new Map(bridge.servers().map((server) => [server.id, server]));
	const tools: ToolRegistration[] = [];
	for (const tool of bridge.tools()) {
		const server = servers.get(tool.serverId);
		if (!server || server.state !== "ready") continue;
		const name = toolName(server.id, tool.name);
		const gated = needsApproval(tool, server.approval);
		const description = `[${server.name}] ${tool.description ?? tool.annotations?.title ?? tool.name}`;
		tools.push(
			defineTool({
				name,
				description: gated ? `${description} ${APPROVAL_NOTE}` : description,
				// MCP input schemas are JSON Schema, which pi validates as given.
				parameters: { type: "object", ...tool.inputSchema } as unknown as TSchema,
				// Filing an approval is replay-safe; a direct call is only if the app says it is read-only.
				replay: gated || tool.annotations?.readOnlyHint === true ? "safe" : "unsafe",
				async execute(args, api, context) {
					const call = { server: server.id, tool: tool.name, arguments: (args ?? {}) as Record<string, unknown> };
					if (gated) {
						return fileApproval(services, api, context, {
							action: "mcp_call",
							args: call,
							summary: summarizeCall(server.name, tool.name, call.arguments),
						});
					}
					const result = await bridge.call(server.id, tool.name, call.arguments);
					return { content: toContent(result), ...(result.isError ? { isError: true } : {}) };
				},
			}) as ToolRegistration,
		);
	}

	const listApps = defineTool({
		name: "list_apps",
		description: "List the apps connected to you, their state, and their tools.",
		parameters: Type.Object({}),
		replay: "safe",
		async execute() {
			const catalog = bridge.tools();
			return json(
				bridge.servers().map((server) => ({
					name: server.name,
					state: server.state,
					...(server.error ? { error: server.error } : {}),
					tools: catalog.filter((tool) => tool.serverId === server.id).map((tool) => toolName(server.id, tool.name)),
				})),
			);
		},
	});

	const apps = defineExtension({
		name: "pim.apps",
		tools: [listApps, ...extras.tools],
		sections: [
			// Always present, so it never appears out of order (which makes pi re-send every section).
			section("connected_apps", () => {
				const ready = [...servers.values()].filter((server) => server.state === "ready");
				if (ready.length === 0) return "No apps are connected. The user can connect one, or ask you to with connect_app.";
				return ready
					.map((server) => {
						const lines = [`## ${server.name}`];
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

	return { apps, tools: defineExtension({ name: "pim.mcp", tools }) };
}
