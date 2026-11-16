import { createHash } from "node:crypto";
import { OwnerId, type Principal } from "@pim/v2-contracts/identity";
import type { Conversations } from "./conversations.ts";
import type { Db } from "./db.ts";
import { BadRequestError, NotFoundError, RefusedError } from "./errors.ts";
import { digest, newId, secret } from "./ids.ts";
import type { Identity } from "./identity.ts";
import { pkceChallenge } from "./oauth.ts";
import type { SignIn } from "./signin.ts";

export const ACCESS_TOKEN_S = 3600;
export const GRANT_DAYS = 30;
const CODE_MS = 10 * 60_000;
const CONSENT_MS = 10 * 60_000;

const isLoopback = (url: URL) => ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);
const oauthError = (error: string, description: string) => Object.assign(new BadRequestError(description), { oauth: error });

/**
 * Pim as the OAuth 2.1 authorization server for its own MCP endpoint (so Claude, ChatGPT and others connect with the person's consent): discovery,
 * dynamic client registration, authorization codes with PKCE (S256 required), one-hour access tokens and thirty-day refresh tokens. Grants and
 * tokens are rows of `token_consumers` (`mcp_grant` access tokens, `mcp_refresh` refresh tokens), so revoking one takes effect on the next call
 * and an owner's suspension or deletion stops every one. Guests may not connect.
 */
export class McpOAuth {
	constructor(private readonly db: Db, private readonly identity: Identity, private readonly signin: SignIn, private readonly conversations: Conversations) {}

	authorizationServerMetadata(origin: string) {
		return {
			issuer: origin,
			authorization_endpoint: `${origin}/authorize`,
			token_endpoint: `${origin}/oauth/token`,
			registration_endpoint: `${origin}/oauth/register`,
			response_types_supported: ["code"],
			grant_types_supported: ["authorization_code", "refresh_token"],
			code_challenge_methods_supported: ["S256"],
			token_endpoint_auth_methods_supported: ["none"],
		};
	}

	protectedResourceMetadata(origin: string) {
		return { resource: `${origin}/mcp`, resource_name: "Pim", authorization_servers: [origin], bearer_methods_supported: ["header"] };
	}

	/** RFC 7591 dynamic registration of a public client. Redirects must be https or loopback. */
	async register(body: Record<string, any>): Promise<Record<string, unknown>> {
		const uris: unknown = body.redirect_uris;
		if (!Array.isArray(uris) || !uris.length || uris.length > 10) throw oauthError("invalid_redirect_uri", "redirect_uris is required");
		for (const u of uris) {
			let url: URL;
			try {
				url = new URL(String(u));
			} catch {
				throw oauthError("invalid_redirect_uri", `${String(u)} is not a URL`);
			}
			const web = url.protocol === "http:" || url.protocol === "https:";
			// https, loopback http (a desktop client), or a custom scheme (a native app): never plain http to another host.
			if (web && url.protocol === "http:" && !isLoopback(url)) throw oauthError("invalid_redirect_uri", "Redirects must use https, or loopback http");
			if (web && url.hash) throw oauthError("invalid_redirect_uri", "A redirect has no fragment");
		}
		const clientId = `mcpc_${secret(12)}`;
		const metadata = { client_name: String(body.client_name ?? "MCP client").slice(0, 100), redirect_uris: uris.map(String), token_endpoint_auth_method: "none", grant_types: ["authorization_code", "refresh_token"], response_types: ["code"] };
		await this.db.anonymous((tx) => tx.query("INSERT INTO pim_app.oauth_clients (client_id, metadata) VALUES ($1, $2)", [clientId, JSON.stringify(metadata)]));
		return { client_id: clientId, ...metadata, client_id_issued_at: Math.floor(Date.now() / 1000) };
	}

	async #client(clientId: string) {
		const row = await this.db.anonymous(async (tx) => (await tx.query("SELECT metadata FROM pim_app.oauth_clients WHERE client_id = $1", [clientId])).rows[0]);
		return row ? (row.metadata as { client_name: string; redirect_uris: string[] }) : null;
	}

	/** What the app's /authorize page shows: who asks and where access would go, with a handle the answer must bring. */
	async describeConsent(session: Principal, query: URLSearchParams, now = new Date()): Promise<{ handle: string; client: { name: string; redirectHost: string; local: boolean } } | { redirectTo: string }> {
		const account = await this.identity.authz.requireLive(session.ownerId);
		if (account.role === "guest") throw new RefusedError("Guests cannot connect MCP clients.", "guest");
		const client = await this.#client(query.get("client_id") ?? "");
		const redirect = query.get("redirect_uri") ?? "";
		if (!client || !client.redirect_uris.includes(redirect)) throw new BadRequestError("This sign-in request isn't valid: unknown client or redirect.");
		const back = (error: string, description: string) => {
			const to = new URL(redirect);
			to.searchParams.set("error", error);
			to.searchParams.set("error_description", description);
			if (query.get("state")) to.searchParams.set("state", query.get("state")!);
			return { redirectTo: to.toString() };
		};
		if (query.get("response_type") !== "code") return back("unsupported_response_type", "Only response_type=code is supported.");
		if (!query.get("code_challenge") || query.get("code_challenge_method") !== "S256") return back("invalid_request", "PKCE with S256 is required.");
		const url = new URL(redirect);
		const handle = await this.signin.startFlow("consent", { clientId: query.get("client_id"), redirect, challenge: query.get("code_challenge"), state: query.get("state"), scope: query.get("scope") ?? "", owner: session.ownerId }, CONSENT_MS, now);
		return { handle, client: { name: client.client_name, redirectHost: url.host, local: isLoopback(url) } };
	}

	/** The person's answer: a code for the client, or a refusal, and where the browser goes next. */
	async answerConsent(session: Principal, handle: string, allow: boolean, now = new Date()): Promise<{ redirectTo: string }> {
		const flow = await this.signin.flow<{ clientId: string; redirect: string; challenge: string; state: string | null; scope: string; owner: string }>(handle, "consent", { consume: true, now });
		if (!flow || flow.owner !== session.ownerId) throw new BadRequestError("This sign-in request expired or came from another browser.");
		const account = await this.identity.authz.requireLive(session.ownerId);
		if (account.role === "guest") throw new RefusedError("Guests cannot connect MCP clients.", "guest");
		const to = new URL(flow.redirect);
		if (flow.state) to.searchParams.set("state", flow.state);
		if (!allow) {
			to.searchParams.set("error", "access_denied");
			return { redirectTo: to.toString() };
		}
		const code = await this.signin.startFlow("code", { owner: session.ownerId, clientId: flow.clientId, redirect: flow.redirect, challenge: flow.challenge, scope: flow.scope }, CODE_MS, now);
		to.searchParams.set("code", code);
		return { redirectTo: to.toString() };
	}

	/** `/oauth/token`: a code (with its PKCE verifier) or a refresh token for an access token and a rotated refresh token. */
	async token(body: URLSearchParams, now = new Date()): Promise<Record<string, unknown>> {
		const type = body.get("grant_type");
		if (type === "authorization_code") {
			const flow = await this.signin.flow<{ owner: string; clientId: string; redirect: string; challenge: string; scope: string }>(body.get("code") ?? undefined, "code", { consume: true, now });
			if (!flow || flow.clientId !== body.get("client_id") || flow.redirect !== body.get("redirect_uri")) throw oauthError("invalid_grant", "The code is invalid, expired or was already used.");
			if ((await pkceChallenge(body.get("code_verifier") ?? "")) !== flow.challenge) throw oauthError("invalid_grant", "The PKCE verifier does not match.");
			const client = await this.#client(flow.clientId);
			return this.#issue(flow.owner, flow.clientId, client?.client_name ?? flow.clientId, null, flow.scope, now);
		}
		if (type === "refresh_token") {
			const raw = body.get("refresh_token") ?? "";
			const hash = digest(raw);
			const row = await this.db.lookup(hash, async (tx) => (await tx.query("UPDATE pim_app.token_consumers SET revoked_at = $2 WHERE token_hash = $1 AND kind = 'mcp_refresh' AND revoked_at IS NULL AND (expires_at IS NULL OR expires_at > $2) RETURNING id, owner_id, metadata", [hash, now])).rows[0]);
			if (!row || row.metadata.clientId !== body.get("client_id")) throw oauthError("invalid_grant", "The refresh token is invalid, expired or was revoked.");
			return this.#issue(row.owner_id, row.metadata.clientId, row.metadata.client, row.metadata.connection as string, row.metadata.scope ?? "", now);
		}
		throw oauthError("unsupported_grant_type", "Use authorization_code or refresh_token.");
	}

	async #issue(ownerId: string, clientId: string, clientName: string, connection: string | null, scope: string, now: Date) {
		const account = await this.identity.authz.requireLive(ownerId); // a suspended or deleted owner gets nothing new
		if (account.role === "guest") throw new RefusedError("Guests cannot connect MCP clients.", "guest");
		const conn = connection ?? newId("conn");
		const refresh = await this.identity.issueConsumer(ownerId, "mcp_refresh", { label: clientName, scopes: ["mcp:refresh"], metadata: { clientId, client: clientName, connection: conn, scope }, expiresAt: new Date(now.getTime() + GRANT_DAYS * 86_400_000) });
		const access = await this.identity.issueConsumer(ownerId, "mcp_grant", { label: clientName, scopes: ["mcp:call"], metadata: { clientId, connection: conn }, expiresAt: new Date(now.getTime() + ACCESS_TOKEN_S * 1000) });
		return { access_token: access.token, token_type: "Bearer", expires_in: ACCESS_TOKEN_S, refresh_token: refresh.token, ...(scope ? { scope } : {}) };
	}

	/** Settings' list of connected clients. */
	async connections(ownerId: string) {
		return this.db.owner(ownerId, async (tx) => (await tx.query("SELECT metadata->>'connection' AS id, label, created_at, expires_at FROM pim_app.token_consumers WHERE kind = 'mcp_refresh' AND revoked_at IS NULL AND (expires_at IS NULL OR expires_at > now()) ORDER BY created_at DESC")).rows.map((r) => ({ id: r.id as string, name: r.label as string, createdAt: r.created_at as Date, expiresAt: r.expires_at as Date | null })));
	}

	/** Disconnects a client: its refresh and access tokens stop working at once. */
	async disconnect(ownerId: string, connection: string): Promise<void> {
		const n = await this.db.owner(ownerId, async (tx) => (await tx.query("UPDATE pim_app.token_consumers SET revoked_at = coalesce(revoked_at, now()) WHERE metadata->>'connection' = $1", [connection])).rowCount);
		if (!n) throw new NotFoundError("No such connection");
	}

	// ---- the MCP endpoint ----

	/**
	 * `/mcp`: JSON-RPC 2.0 over HTTP (initialize, ping, tools/list, tools/call) with one tool, `pim`, a message to the person's majordomo. Every call
	 * re-checks the bearer, the account's status and the `mcp:call` scope, and refuses guests. The tool accepts the message into the command inbox and
	 * answers at once with the chat it went to: it never waits on a model.
	 */
	async rpc(bearer: string | undefined, message: any): Promise<{ status: number; body?: unknown }> {
		const p = await this.identity.authenticate(bearer);
		await this.identity.authz.enforce(p, "mcp:call");
		if (!message || message.jsonrpc !== "2.0") return { status: 400, body: { jsonrpc: "2.0", id: null, error: { code: -32600, message: "Invalid request" } } };
		const ok = (result: unknown) => ({ status: 200, body: { jsonrpc: "2.0", id: message.id, result } });
		const fail = (code: number, text: string) => ({ status: 200, body: { jsonrpc: "2.0", id: message.id, error: { code, message: text } } });
		switch (message.method) {
			case "initialize":
				return ok({ protocolVersion: "2025-06-18", capabilities: { tools: {} }, serverInfo: { name: "Pim", version: "2.0.0" }, instructions: "Talk with the person's majordomo in Pim through the pim tool." });
			case "ping":
				return ok({});
			case "notifications/initialized":
				return { status: 202 };
			case "tools/list":
				return ok({ tools: [PIM_TOOL] });
			case "tools/call": {
				if (message.params?.name !== "pim") return fail(-32602, "Unknown tool");
				const { message: text, conversation } = message.params.arguments ?? {};
				if (typeof text !== "string" || !text) return ok({ content: [{ type: "text", text: "message is required" }], isError: true });
				const agent: Principal = { kind: "agent", ownerId: OwnerId.parse(p.ownerId), agentId: "mcp" };
				let chat = typeof conversation === "string" ? conversation : undefined;
				if (chat) await this.conversations.get(p.ownerId, chat).catch(() => { chat = undefined; throw new BadRequestError("That conversation doesn't exist."); });
				else chat = await this.conversations.create(agent, { title: text.slice(0, 60) });
				const commandId = `mcp:${createHash("sha256").update(`${p.ownerId}\n${chat}\n${text}\n${Date.now()}\n${Math.random()}`).digest("hex").slice(0, 24)}`;
				await this.conversations.admit(agent, { commandId, kind: "user_message", chatId: chat!, payload: { text, via: "mcp" } });
				const said = "Pim accepted your message and is working on it. Ask again in this conversation to hear how it went.";
				return ok({ content: [{ type: "text", text: `${said}\n\n[conversation: ${chat}]` }], structuredContent: { conversation: chat, reply: said }, isError: false });
			}
			default:
				return fail(-32601, "Method not found");
		}
	}
}

const PIM_TOOL = {
	name: "pim",
	title: "Message Pim",
	description: "Send a message to the person's majordomo in Pim. Each call starts a new conversation unless you pass back the one an earlier reply named.",
	inputSchema: { type: "object", properties: { message: { type: "string", minLength: 1 }, conversation: { type: "string" } }, required: ["message"] },
	annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
};
