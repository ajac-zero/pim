import { AuthorizationError, getOAuthApi, type OAuthHelpers, OAuthProvider, type OAuthProviderOptions } from "@cloudflare/workers-oauth-provider";

/**
 * Signing MCP clients in to a person's Pim, so Claude, ChatGPT and others
 * connect to `/mcp` (./mcp-server.ts) with the person's consent instead of a
 * pasted token. Pim is the OAuth authorization server for its own MCP
 * server, and @cloudflare/workers-oauth-provider speaks the protocol, as the
 * MCP authorization spec asks:
 *
 * - discovery metadata at `/.well-known/oauth-protected-resource/mcp` and
 *   `/.well-known/oauth-authorization-server`;
 * - dynamic client registration at `/oauth/register`;
 * - codes for tokens (PKCE required) and revocation at `/oauth/token`;
 * - grants, clients and hashed tokens in the `OAUTH_KV` namespace.
 *
 * Pim owns the part with the person: the app's `/authorize` page
 * (web/src/routes/authorize.tsx), which shows who is asking and where access
 * goes, and asks through `/auth/authorize` here, signed in to the app. A grant
 * opens one person's Pim, named by its props. Access tokens last an hour; a
 * grant lasts 30 days from its last refresh, so a client in use stays
 * connected, and Settings lists and disconnects them (`/auth/connections`).
 */

/** What a grant opens: one person's Pim. */
export type McpGrant = { readonly owner: string };

/** The MCP server for whoever a grant or API token names, and the API tokens it also takes. */
export type McpAccess = {
	readonly server: Required<Pick<ExportedHandler<Env>, "fetch">>;
	/** The owner a Pim API token belongs to, if it is still good. */
	apiTokenOwner(token: string, env: Env): Promise<string | null>;
};

const DAY_SECONDS = 86_400;

const servers = new Map<string, { provider: OAuthProvider<Env>; options: OAuthProviderOptions<Env> }>();

/** The authorization server for this Pim's address, `origin`, whose `/mcp` its tokens open. */
function server(origin: string, access: McpAccess) {
	let found = servers.get(origin);
	if (!found) {
		const resource = `${origin}/mcp`;
		const options: OAuthProviderOptions<Env> = {
			apiRoute: "/mcp",
			apiHandler: access.server,
			// Paths of its own it doesn't answer, such as other `/.well-known` files, are the app's.
			defaultHandler: { fetch: (request, env) => env.ASSETS.fetch(request) },
			authorizeEndpoint: "/authorize",
			tokenEndpoint: "/oauth/token",
			clientRegistrationEndpoint: "/oauth/register",
			resourceMetadata: { resource, resource_name: "Pim" },
			refreshTokenTTL: 30 * DAY_SECONDS,
			refreshTokenIdleTTL: 30 * DAY_SECONDS,
			// API tokens from Settings work too, for clients without OAuth.
			resolveExternalToken: async ({ token, env }) => {
				const owner = await access.apiTokenOwner(token, env);
				return owner ? { props: { owner } satisfies McpGrant, audience: resource } : null;
			},
		};
		found = { provider: new OAuthProvider(options), options };
		servers.set(origin, found);
	}
	return found;
}

/** Answers `/mcp`, `/oauth/*` and `/.well-known/*` for the Pim at `origin`. */
export function serveOAuth(request: Request, env: Env, ctx: ExecutionContext, origin: string, access: McpAccess): Promise<Response> {
	return server(origin, access).provider.fetch(request, env, ctx);
}

/**
 * The consent API the app's `/authorize` page and Settings use, for a person
 * signed in to the app:
 *
 * - `GET /auth/authorize?<the client's authorization request>`: the client and
 *   where access would go, with a `handle` for the answer; or `redirectTo`,
 *   back to the client with an error, or `error` when the request can't go
 *   back to it.
 * - `POST /auth/authorize` `{ handle, allow }`: `{ redirectTo }`, back to the
 *   client with a code or with `access_denied`.
 * - `GET /auth/connections`: `{ connections: [{ id, name, createdAt, expiresAt }] }`.
 * - `DELETE /auth/connections/:id`: disconnects one, revoking its tokens.
 */
export async function serveConsent(request: Request, env: Env, owner: string, origin: string, access: McpAccess): Promise<Response> {
	const { options } = server(origin, access);
	const oauth = getOAuthApi(options, env);
	const { pathname } = new URL(request.url);
	try {
		if (pathname === "/auth/authorize" && request.method === "GET") return await describe(oauth, request, origin);
		if (pathname === "/auth/authorize" && request.method === "POST") return await answer(oauth, request, owner);
		if (pathname === "/auth/connections" && request.method === "GET") {
			const { items } = await oauth.listUserGrants(owner);
			const connections = items.map((grant) => ({
				id: grant.id,
				name: typeof grant.metadata?.client === "string" ? grant.metadata.client : grant.clientId,
				createdAt: grant.createdAt * 1000,
				expiresAt: grant.expiresAt ? grant.expiresAt * 1000 : null,
			}));
			return Response.json({ connections: connections.sort((a, b) => b.createdAt - a.createdAt) });
		}
		const connection = /^\/auth\/connections\/([^/]+)$/.exec(pathname);
		if (connection && request.method === "DELETE") {
			await oauth.revokeGrant(decodeURIComponent(connection[1]!), owner);
			return Response.json({ ok: true });
		}
	} catch (error) {
		// The page expired, was used, or came from another browser, or the client's request was bad.
		if (error instanceof AuthorizationError) {
			if (error.redirectTo) return Response.json({ redirectTo: error.redirectTo });
			return Response.json({ error: error.description ?? "This sign-in request isn't valid." }, { status: 400 });
		}
		throw error;
	}
	return Response.json({ error: "Not found" }, { status: 404 });
}

/** The client asking, for the consent page, with the handle its answer must bring. */
async function describe(oauth: OAuthHelpers, request: Request, origin: string): Promise<Response> {
	// The library checks the request arrived at the authorization endpoint it advertises: the page's.
	const page = new URL(`${origin}/authorize`);
	page.search = new URL(request.url).search;
	const authRequest = await oauth.parseAuthRequest(new Request(page));
	const client = await oauth.describeConsent(authRequest);
	const consent = await oauth.beginConsent(authRequest);
	consent.headers.set("Content-Type", "application/json");
	const body = { handle: consent.handle, client: { name: client.clientName, redirectHost: client.redirectHost, local: client.redirectIsLoopback } };
	return new Response(JSON.stringify(body), { headers: consent.headers });
}

/** The person's answer: a grant of their Pim to the client, or a refusal, and where the browser goes next. */
async function answer(oauth: OAuthHelpers, request: Request, owner: string): Promise<Response> {
	const body = (await request.json().catch(() => null)) as { handle?: unknown; allow?: unknown } | null;
	if (typeof body?.handle !== "string") return Response.json({ error: "handle is required" }, { status: 400 });
	if (body.allow !== true) {
		const denied = await oauth.denyConsent(request, body.handle);
		denied.headers.delete("Location");
		denied.headers.set("Content-Type", "application/json");
		return new Response(JSON.stringify({ redirectTo: denied.redirectTo }), { headers: denied.headers });
	}
	const approved = await oauth.approveConsent(request, body.handle);
	const client = await oauth.lookupClient(approved.request.clientId);
	const grant: McpGrant = { owner };
	const { redirectTo } = await oauth.completeAuthorization({
		request: approved.request,
		userId: owner,
		// Kept beside the grant, for Settings to name it after the client has gone.
		metadata: { client: client?.clientName?.trim() || approved.request.clientId },
		scope: approved.request.scope,
		props: grant,
	});
	approved.headers.set("Content-Type", "application/json");
	return new Response(JSON.stringify({ redirectTo }), { headers: approved.headers });
}
