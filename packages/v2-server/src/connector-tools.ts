/**
 * What an agent can do with its owner's connected MCP servers on the portable stack. The Runner reads the owner's connectors and their tool permissions through the
 * application's SECURITY DEFINER functions (migration 0620), opens the sealed credential with the deployment's keys (refreshing an OAuth one when it has expired), lists
 * a server's tools over streamable HTTP, and offers the agent the tools its owner has not switched off: `connector_tools` shows them with their inputs, and
 * `connector_call` calls one. A tool set to On runs; a tool set to Ask files an approval and parks until a person decides (as `http_request` does); a tool set to Off is
 * neither offered nor callable. A call that is not read-only is sent once: its outcome is on an external operation, so a replay does not send it again.
 */
import { Type } from "@earendil-works/pi-ai";
import { defineTool, type PromptSection, type ToolRegistration } from "@earendil-works/pi-durable";
import type { App } from "@pim/v2-app/app";
import type { Tool as DiscoveredTool, ToolFetcher } from "@pim/v2-app/connectors";
import { openString, sealString } from "@pim/v2-app/crypto";
import { PartitionId, type Principal } from "@pim/v2-contracts/identity";
import type { EnvelopeCrypto } from "@pim/v2-contracts/platform";
import type { ExternalOperations } from "@pim/v2-runtime/external";
import type { Db as RuntimeDb } from "@pim/v2-runtime/db";

export type McpTool = { name: string; description?: string; inputSchema?: Record<string, unknown>; annotations?: { readOnlyHint?: boolean; destructiveHint?: boolean; title?: string } };
export type Approval = "writes" | "all" | "none";
export type ConnectorRow = { id: string; kind: string; name: string; url: string; status: string; credential: string | null; enabledTools: string[]; approval: Approval };
export type Permission = "off" | "ask" | "on";
export type PermissionRow = { audience: string; app: string; tool: string; permission: Permission };

export const agentAudience = (agentId: string) => `agent:${agentId}`;

/** Whether a tool must ask first under its connector's approval policy. */
export function needsApproval(tool: Pick<McpTool, "annotations">, approval: Approval): boolean {
	if (tool.annotations?.destructiveHint === true) return true;
	if (approval === "all") return true;
	if (approval === "none") return false;
	return tool.annotations?.readOnlyHint !== true;
}

/**
 * A tool's permission for an owner: their choice, or else off until the tool is enabled, then the connector's policy (a read-only tool runs, any other asks). A tool
 * the connector marks destructive never runs without asking. One agent's switch can only turn it off.
 */
export function resolvePermission(connector: Pick<ConnectorRow, "id" | "enabledTools" | "approval">, tool: McpTool, permissions: readonly PermissionRow[], agentId?: string) {
	const find = (audience: string) => permissions.find((p) => p.audience === audience && p.app === connector.id && p.tool === tool.name)?.permission ?? null;
	const fallback: Permission = connector.enabledTools.includes(tool.name) ? (needsApproval(tool, connector.approval) ? "ask" : "on") : "off";
	const chosen = find("owner");
	const base = chosen ?? fallback;
	const agentChosen = agentId ? find(agentAudience(agentId)) : null;
	let permission: Permission = agentChosen === "off" ? "off" : base;
	if (tool.annotations?.destructiveHint === true && permission === "on") permission = "ask";
	return { permission, default: fallback, chosen, agentChosen };
}

// ---- credentials ----

type OAuthBundle = { access_token: string; refresh_token?: string; expires_at?: number; token_endpoint?: string; client_id?: string; client_secret?: string };
/** A stored credential is a bearer token, or a JSON object of an OAuth sign-in that can be refreshed. */
export function parseCredential(stored: string): { bearer: string; bundle: OAuthBundle | null } {
	if (stored.startsWith("{")) {
		try {
			const b = JSON.parse(stored) as OAuthBundle;
			if (typeof b.access_token === "string") return { bearer: b.access_token, bundle: b };
		} catch {
			// A token that merely begins with a brace is a bearer.
		}
	}
	return { bearer: stored, bundle: null };
}

/**
 * Where an MCP server's sign-in takes refresh tokens, found the way the MCP authorization spec says: the server's protected-resource metadata names its authorization server
 * (the server's own origin when it names none), whose metadata names the token endpoint. A credential brought from another Pim holds tokens but not this, since that Pim dropped it once
 * the sign-in finished.
 */
export async function discoverTokenEndpoint(serverUrl: string, transport: Transport): Promise<string | null> {
	// What the server names is as untrusted as the server: a private address is refused unless the deployment allows them.
	const reach = async (url: string) => (transport.allowPrivate ? new URL(url) : await transport.check(url));
	const get = async (url: string): Promise<Record<string, unknown> | null> => {
		const response = await reach(url).then((target) => transport.fetch(target, { headers: { accept: "application/json" }, signal: AbortSignal.timeout(10_000), redirect: "manual" })).catch(() => null);
		return response?.ok ? ((await response.json().catch(() => null)) as Record<string, unknown> | null) : null;
	};
	const origin = new URL(serverUrl).origin;
	const resource = await get(`${origin}/.well-known/oauth-protected-resource${new URL(serverUrl).pathname.replace(/\/$/, "")}`) ?? (await get(`${origin}/.well-known/oauth-protected-resource`));
	const issuers = Array.isArray(resource?.authorization_servers) ? (resource.authorization_servers as unknown[]).filter((x): x is string => typeof x === "string") : [];
	for (const issuer of issuers.length > 0 ? issuers : [origin]) {
		const root = new URL(issuer);
		const path = root.pathname.replace(/\/$/, "");
		const metadata = (await get(`${root.origin}/.well-known/oauth-authorization-server${path}`)) ?? (await get(`${root.origin}/.well-known/openid-configuration${path}`));
		if (typeof metadata?.token_endpoint === "string") return metadata.token_endpoint;
	}
	return null;
}

async function refresh(bundle: OAuthBundle, transport: Transport, now: number, serverUrl: string): Promise<OAuthBundle | null> {
	if (!bundle.refresh_token) return null;
	const tokenEndpoint = bundle.token_endpoint ?? (await discoverTokenEndpoint(serverUrl, transport));
	if (!tokenEndpoint) return null;
	const body = new URLSearchParams({ grant_type: "refresh_token", refresh_token: bundle.refresh_token, ...(bundle.client_id ? { client_id: bundle.client_id } : {}), ...(bundle.client_secret ? { client_secret: bundle.client_secret } : {}) });
	const response = await transport.fetch(transport.allowPrivate ? new URL(tokenEndpoint) : await transport.check(tokenEndpoint), { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded", accept: "application/json" }, body, signal: AbortSignal.timeout(15_000), redirect: "manual" });
	if (!response.ok) return null;
	const t = (await response.json().catch(() => null)) as { access_token?: string; refresh_token?: string; expires_in?: number } | null;
	if (!t?.access_token) return null;
	return { ...bundle, token_endpoint: tokenEndpoint, access_token: t.access_token, refresh_token: t.refresh_token ?? bundle.refresh_token, ...(t.expires_in ? { expires_at: now + t.expires_in * 1000 } : {}) };
}

// ---- the MCP client (streamable HTTP) ----

const PROTOCOL = "2025-06-18";
export class McpAuthError extends Error {}

/** How a server is reached: with what `fetch`, and whether a private address may be (a deployment's own network, tests). `check` refuses private addresses otherwise. */
export type Transport = { fetch: typeof fetch; allowPrivate: boolean; check: (url: string) => Promise<URL> };

async function readReply(response: Response, id: number): Promise<any> {
	const type = response.headers.get("content-type") ?? "";
	const raw = await response.text();
	if (type.includes("text/event-stream")) {
		for (const event of raw.split(/\r?\n\r?\n/)) {
			const data = event.split(/\r?\n/).filter((l) => l.startsWith("data:")).map((l) => l.slice(5).trimStart()).join("\n");
			if (!data) continue;
			try {
				const message = JSON.parse(data);
				if (message.id === id) return message;
			} catch {
				// Not a message.
			}
		}
		throw new Error("The server's reply held no answer");
	}
	try {
		return JSON.parse(raw);
	} catch {
		throw new Error("The server did not answer with JSON");
	}
}

/** One MCP session: `initialize`, then the calls, in the bounds given. A server that wants no session simply sends none. */
export async function withSession<T>(transport: Transport, url: string, bearer: string | null, body: (rpc: (method: string, params?: unknown) => Promise<any>) => Promise<T>, timeoutMs = 20_000): Promise<T> {
	const target = transport.allowPrivate ? new URL(url) : await transport.check(url);
	let session: string | undefined;
	let next = 0;
	const send = async (message: object, id?: number) => {
		const response = await transport.fetch(target, { method: "POST", redirect: "manual", signal: AbortSignal.timeout(timeoutMs), headers: { "content-type": "application/json", accept: "application/json, text/event-stream", "mcp-protocol-version": PROTOCOL, ...(session ? { "mcp-session-id": session } : {}), ...(bearer ? { authorization: `Bearer ${bearer}` } : {}) }, body: JSON.stringify(message) });
		if (response.status === 401 || response.status === 403) throw new McpAuthError(`The server refused the connector's credential (${response.status})`);
		if (response.status >= 300) throw new Error(`The server answered ${response.status}`);
		session = response.headers.get("mcp-session-id") ?? session;
		if (id === undefined) {
			await response.arrayBuffer().catch(() => undefined);
			return undefined;
		}
		const reply = await readReply(response, id);
		if (reply.error) throw new Error(String(reply.error.message ?? "The server reported an error"));
		return reply.result;
	};
	const rpc = (method: string, params?: unknown) => send({ jsonrpc: "2.0", id: ++next, method, ...(params === undefined ? {} : { params }) }, next);
	await rpc("initialize", { protocolVersion: PROTOCOL, capabilities: {}, clientInfo: { name: "Pim", version: "2.0.0" } });
	await send({ jsonrpc: "2.0", method: "notifications/initialized" });
	try {
		return await body(rpc);
	} finally {
		if (session) void transport.fetch(target, { method: "DELETE", headers: { "mcp-session-id": session, ...(bearer ? { authorization: `Bearer ${bearer}` } : {}) }, signal: AbortSignal.timeout(3000), redirect: "manual" }).then((r) => r.arrayBuffer()).catch(() => {});
	}
}

export async function listTools(transport: Transport, url: string, bearer: string | null): Promise<McpTool[]> {
	return withSession(transport, url, bearer, async (rpc) => {
		const tools: McpTool[] = [];
		let cursor: string | undefined;
		for (let page = 0; page < 5; page++) {
			const r = await rpc("tools/list", cursor ? { cursor } : {});
			for (const t of r?.tools ?? []) if (typeof t?.name === "string") tools.push({ name: t.name, ...(t.description ? { description: String(t.description) } : {}), inputSchema: typeof t.inputSchema === "object" && t.inputSchema ? t.inputSchema : { type: "object", properties: {} }, ...(t.annotations ? { annotations: t.annotations } : {}) });
			cursor = r?.nextCursor;
			if (!cursor) break;
		}
		return tools;
	});
}

/** The Gate's tool discovery, over a real MCP session; what a server says about each tool (read-only, destructive) is kept for the permissions screen. */
export function mcpFetchTools(transport: Transport): ToolFetcher {
	return async (url, credential) =>
		(await listTools(transport, url, credential ? parseCredential(credential).bearer : null)).map((t): DiscoveredTool => ({
			name: t.name,
			...(t.description ? { description: t.description.slice(0, 500) } : {}),
			...(t.annotations ? { annotations: { ...(t.annotations.readOnlyHint !== undefined ? { readOnlyHint: t.annotations.readOnlyHint } : {}), ...(t.annotations.destructiveHint !== undefined ? { destructiveHint: t.annotations.destructiveHint } : {}) } } : {}),
		}));
}

/** An MCP tool's result as text for the model. */
export function resultText(result: any): string {
	const parts: string[] = [];
	for (const c of result?.content ?? []) {
		if (c?.type === "text" && typeof c.text === "string") parts.push(c.text);
		else if (c?.type === "image") parts.push(`[image ${c.mimeType ?? ""}]`);
		else parts.push(JSON.stringify(c));
	}
	if (parts.length === 0 && result?.structuredContent !== undefined) parts.push(JSON.stringify(result.structuredContent));
	const out = parts.join("\n");
	return out.length > 100_000 ? `${out.slice(0, 100_000)}\n[... ${out.length - 100_000} more characters]` : out;
}

// ---- the agent's tools ----

type Result = { content: { type: "text"; text: string }[]; isError?: boolean };
const text = (s: string, isError = false): Result => ({ content: [{ type: "text", text: s }], ...(isError ? { isError } : {}) });

export type ConnectorToolsDeps = {
	ownerId: string;
	partitionId: string;
	runtime: RuntimeDb;
	app: App | undefined;
	crypto: EnvelopeCrypto | undefined;
	transport: Transport;
	ops: ExternalOperations;
	owner: unknown;
	now: () => number;
	chatOf(conversationId: number | string): Promise<string | null>;
	principalOf(app: App, chat: string | null): Promise<Principal>;
};

const LISTED_FOR_MS = 30_000;

export function connectorToolset(deps: ConnectorToolsDeps): { tools: ToolRegistration[]; sections: PromptSection[] } {
	const { ownerId, runtime, crypto } = deps;
	const listed = new Map<string, { at: number; tools: Promise<McpTool[]> }>();

	/** The credential, opened; an OAuth one that has expired is refreshed first and the new one kept sealed. */
	async function bearerOf(c: ConnectorRow, force = false): Promise<string | null> {
		if (!c.credential) return null;
		if (!crypto) throw new Error("This Runner has no keys (PIM_KEK_<id> and PIM_KEK_CURRENT), so it cannot open a connector's credential.");
		const { bearer, bundle } = parseCredential(await openString(crypto, c.credential, `connector:${ownerId}/${c.id}`));
		if (bundle && (force || (bundle.expires_at !== undefined && bundle.expires_at <= deps.now() + 30_000))) {
			const renewed = await refresh(bundle, deps.transport, deps.now(), c.url).catch(() => null);
			if (renewed) {
				const sealed = await sealString(crypto, JSON.stringify(renewed), `connector:${ownerId}/${c.id}`);
				await runtime.read(ownerId, "SELECT pim_app.runner_set_connector_credential($1, $2, $3)", [ownerId, c.id, sealed]);
				return renewed.access_token;
			}
		}
		return bearer;
	}
	async function withBearer<T>(c: ConnectorRow, run: (bearer: string | null) => Promise<T>): Promise<T> {
		try {
			return await run(await bearerOf(c));
		} catch (error) {
			if (!(error instanceof McpAuthError)) throw error;
			return run(await bearerOf(c, true));
		}
	}

	const connectors = async (): Promise<ConnectorRow[]> => (await runtime.read<{ c: ConnectorRow[] }>(ownerId, "SELECT pim_app.runner_connectors($1) AS c", [ownerId])).rows[0]!.c.filter((c) => c.status === "connected" || c.credential === null);
	const permissions = async (): Promise<PermissionRow[]> => (await runtime.read<{ p: PermissionRow[] }>(ownerId, "SELECT pim_app.runner_tool_permissions($1) AS p", [ownerId])).rows[0]!.p;
	const toolsOf = (c: ConnectorRow): Promise<McpTool[]> => {
		const key = `${c.id}\u0000${c.url}`;
		const held = listed.get(key);
		if (held && deps.now() - held.at < LISTED_FOR_MS) return held.tools;
		const tools = withBearer(c, (bearer) => listTools(deps.transport, c.url, bearer));
		listed.set(key, { at: deps.now(), tools });
		tools.catch(() => listed.delete(key));
		return tools;
	};

	type Offered = { connector: ConnectorRow; tool: McpTool; permission: Permission };
	/** Every tool the owner has not switched off. A server that cannot be reached offers nothing this time. */
	async function offered(agentId: string | undefined): Promise<{ offered: Offered[]; unreachable: string[] }> {
		const [cs, perms] = await Promise.all([connectors(), permissions()]);
		const unreachable: string[] = [];
		const out: Offered[] = [];
		await Promise.all(cs.map(async (c) => {
			try {
				for (const tool of await toolsOf(c)) {
					const { permission } = resolvePermission(c, tool, perms, agentId);
					if (permission !== "off") out.push({ connector: c, tool, permission });
				}
			} catch {
				unreachable.push(c.name);
			}
		}));
		out.sort((a, b) => a.connector.name.localeCompare(b.connector.name) || a.tool.name.localeCompare(b.tool.name));
		return { offered: out, unreachable };
	}
	const agentOf = async (conversationId: number | string): Promise<string | undefined> => {
		if (!deps.app) return undefined;
		const p = await deps.principalOf(deps.app, await deps.chatOf(conversationId));
		return p.kind === "agent" && p.agentId !== "pim" ? p.agentId : undefined;
	};

	const list = defineTool({
		name: "connector_tools",
		description: "The tools of the person's connected services (MCP servers) that you may use, with what each takes. A tool marked asksFirst waits for the person's approval when you call it. Call one with connector_call.",
		parameters: Type.Object({}),
		replay: "safe",
		async execute(_args: unknown, api: any) {
			const { offered: tools, unreachable } = await offered(await agentOf(api.conversationId));
			if (tools.length === 0) return text(unreachable.length ? `No tools are available: ${unreachable.join(", ")} could not be reached.` : "You have no connector tools. The person can connect a service and switch its tools on in Settings.");
			return text(JSON.stringify({ tools: tools.map((o) => ({ connector: o.connector.id, service: o.connector.name, tool: o.tool.name, description: o.tool.description ?? null, inputSchema: o.tool.inputSchema, readOnly: o.tool.annotations?.readOnlyHint === true, asksFirst: o.permission === "ask" })), ...(unreachable.length ? { unreachable } : {}) }, null, 1));
		},
	} as never) as unknown as ToolRegistration;

	const redact = (value: unknown) => JSON.parse(JSON.stringify(value ?? {}), (k, v) => (/token|secret|password|authorization|api[_-]?key/i.test(k) ? "[redacted]" : v));

	const call = defineTool({
		name: "connector_call",
		description: "Call a tool of a connected service (see connector_tools for what is available). Arguments are the tool's own. A tool with effects may wait for the person's approval first, and is sent once.",
		parameters: Type.Object({ connector: Type.String({ minLength: 1 }), tool: Type.String({ minLength: 1 }), arguments: Type.Optional(Type.Record(Type.String(), Type.Any())) }),
		// Safe to replay because a call with effects is made once through its external operation, and a parked call must be replay-safe.
		replay: "safe",
		async execute(args: { connector: string; tool: string; arguments?: Record<string, unknown> }, api: any) {
			try {
				const agentId = await agentOf(api.conversationId);
				const [cs, perms] = await Promise.all([connectors(), permissions()]);
				const c = cs.find((x) => x.id === args.connector);
				if (!c) return text(`There is no connected service ${args.connector}.`, true);
				const tool = (await toolsOf(c)).find((t) => t.name === args.tool);
				if (!tool) return text(`${c.name} has no tool ${args.tool}.`, true);
				const { permission } = resolvePermission(c, tool, perms, agentId);
				if (permission === "off") return text(`The tool ${args.tool} of ${c.name} is switched off, so it was not called.`, true);
				const readOnly = tool.annotations?.readOnlyHint === true;
				const taskId = String(api.taskId);
				if (permission === "ask") {
					const app = deps.app;
					if (!app) return text("This Runner has no application database (PIM_APP_DATABASE_URL), so it cannot ask a person for approval.", true);
					const chat = await deps.chatOf(api.conversationId);
					const p = await deps.principalOf(app, chat);
					// A person's decision, delivered as a signal that wakes this task; or a standing approval, which stands in for it.
					const signal = (await runtime.read<{ payload: { approved?: boolean } }>(ownerId, "SELECT payload FROM pim_runtime.durable_signals WHERE owner_id = $1 AND task_id = $2 AND kind = 'approval' ORDER BY signal_id DESC LIMIT 1", [ownerId, taskId])).rows[0];
					if (signal && signal.payload.approved !== true) return text("A person did not approve this call, so it was not made.", true);
					if (!signal) {
						const waiting = { content: [{ type: "text", text: "Waiting for a person's approval." }], control: { suspend: true } } as never;
						const filed = await app.db.owner(ownerId, async (tx) => (await tx.query("SELECT id FROM pim_app.approvals WHERE tool = 'connector:call' AND args->>'taskId' = $1 LIMIT 1", [taskId])).rows[0]?.id as string | undefined);
						if (filed) return waiting;
						const gate = await app.approvals.gate(p, { action: "connector:call", resource: { connector: c.id, tool: tool.name }, ...(chat ? { chatId: chat } : {}), args: { taskId, callId: api.callId, connector: c.id, service: c.name, tool: tool.name, readOnly, arguments: redact(args.arguments) }, timeoutMs: 24 * 3600_000, onTimeout: "deny" });
						if (gate.outcome === "waiting") return waiting;
					}
				}
				const run = () => withBearer(c, (bearer) => withSession(deps.transport, c.url, bearer, (rpc) => rpc("tools/call", { name: tool.name, arguments: args.arguments ?? {} }), 30_000));
				if (readOnly) {
					const result = await run();
					return text(resultText(result), result?.isError === true);
				}
				// A call with effects, once: its outcome is on the operation, so a replay or a new owner finds it there, and one in flight is reconciled, not made again.
				const operationId = `connector:${deps.partitionId}:${taskId}`;
				const op = await deps.ops.begin({ operationId, ownerId: deps.owner, partitionId: PartitionId.parse(deps.partitionId), taskId, toolName: "connector_call", capability: `connector:${c.id}`, idempotencyKey: `pim-${ownerId}-${deps.partitionId}-${taskId}` } as never);
				if (op.state === "completed") return text(String((op.receipt as any)?.summary ?? "Done."));
				if (op.state === "failed" || op.state === "cancelled") return text(`The call did not go through: ${String((op.receipt as any)?.error ?? op.state)}`, true);
				if (op.state !== "pending") return text(`The call was started, but what became of it is not known (${op.state}). It was not made again; check with ${c.name} before asking again.`, true);
				await deps.ops.transition(ownerId, operationId, "running");
				try {
					const result = await run();
					const summary = resultText(result);
					await deps.ops.transition(ownerId, operationId, result?.isError === true ? "failed" : "completed", result?.isError === true ? { error: summary } : { summary });
					return text(summary, result?.isError === true);
				} catch (error) {
					const message = error instanceof Error ? error.message : String(error);
					await deps.ops.transition(ownerId, operationId, "needs_reconciliation", { error: message });
					return text(`The call may or may not have reached ${c.name} (${message}). It was not made again; check with them before asking again.`, true);
				}
			} catch (error) {
				return text(error instanceof Error ? error.message : String(error), true);
			}
		},
	} as never) as unknown as ToolRegistration;

	const section = {
		key: "connectors",
		async render(input: { conversationId: number | string }) {
			const agentId = await agentOf(input.conversationId).catch(() => undefined);
			const { offered: tools } = await offered(agentId).catch(() => ({ offered: [] as Offered[] }));
			if (tools.length === 0) return undefined;
			return `Tools of the person's connected services, called with connector_call (connector, tool, arguments); connector_tools shows what each takes.\n${tools.slice(0, 60).map((o) => `- ${o.connector.name} (${o.connector.id}) ${o.tool.name}${o.permission === "ask" ? " [asks first]" : ""}${o.tool.description ? `: ${o.tool.description.slice(0, 160)}` : ""}`).join("\n")}`;
		},
	} as unknown as PromptSection;
	return { tools: [list, call], sections: [section] };
}
