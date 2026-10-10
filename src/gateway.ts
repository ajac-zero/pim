import { getAgentByName } from "agents";
import { AGENT_NAME, AUTHORIZED_HEADER, MCP_CALLBACK_PATH, MCP_EVENTS_PATH, OWNER_HEADER } from "./agent";
import { type AuthSite, currentSession, fromAnotherSite, handleAuth, ownerToken, SELF_HOSTED_USER } from "./auth";

/**
 * Serves one owner's Pim: its web app, sign-in, API and app callbacks.
 *
 * - `/api/*`: the agent's API. Browsers sign in with a passkey (a session
 *   cookie); other clients send an API token.
 * - `/auth/*`: passkey sign-in, recovery, and API tokens (./auth).
 * - `/mcp/callback`, `/mcp/events/*`: public, for connected apps.
 * - Everything else: the web app (`web/`, built to `web/dist`).
 *
 * The entry module decides whose Pim a request is for (self-hosted: always
 * the one; hosted: the account the hostname names) and passes it as `site`.
 */

/** One owner's Pim, as the Worker resolved it. */
export type PimSite = AuthSite & {
	/** The name of the owner's Pim Durable Object. */
	readonly agent: string;
};

/** A self-hosted Pim's one owner, whose agent and sign-in keep the Durable Object names they have always had. */
export function selfHostedSite(env: Env): PimSite {
	return { owner: AGENT_NAME, agent: AGENT_NAME, store: env.Auth.getByName("auth"), mode: "self-hosted", user: SELF_HOSTED_USER };
}

const CORS_HEADERS: Record<string, string> = {
	"Access-Control-Allow-Origin": "*",
	"Access-Control-Allow-Methods": "GET, POST, PUT, DELETE, OPTIONS",
	"Access-Control-Allow-Headers": "Authorization, Content-Type",
	"Access-Control-Max-Age": "86400",
};

export function withCors(response: Response): Response {
	// WebSocket upgrades must be returned as they are.
	if (response.webSocket) return response;
	const headers = new Headers(response.headers);
	for (const [name, value] of Object.entries(CORS_HEADERS)) headers.set(name, value);
	return new Response(response.body, { status: response.status, statusText: response.statusText, headers });
}

async function digest(value: string): Promise<ArrayBuffer> {
	return crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
}

/** The token a request carries, as a bearer token or, for WebSockets from clients that cannot set headers, a `token` query parameter. */
function givenToken(request: Request): string | null {
	const header = request.headers.get("Authorization");
	return header?.startsWith("Bearer ") ? header.slice(7) : new URL(request.url).searchParams.get("token");
}

/**
 * Whether the request carries a token for this owner: one they made in
 * Settings, or, self-hosted only, `PIM_API_TOKEN`. A hosted service never
 * reads that variable: it would open every owner's Pim.
 */
async function hasToken(request: Request, env: Env, site: PimSite): Promise<boolean> {
	const given = givenToken(request);
	if (!given) return false;
	if (site.mode === "self-hosted" && env.PIM_API_TOKEN) {
		// Hashing first makes the comparison constant-time regardless of length.
		if (crypto.subtle.timingSafeEqual(await digest(given), await digest(env.PIM_API_TOKEN))) return true;
	}
	return ownerToken(site, given);
}

/** Who may call the API: a token holder, or a browser signed in to this owner's Pim. */
async function authorize(request: Request, env: Env, site: PimSite): Promise<Response | undefined> {
	if (await hasToken(request, env, site)) return undefined;
	if (await currentSession(request, site)) {
		// A cookie rides along on requests other sites trigger; a token can't.
		if (fromAnotherSite(request)) return Response.json({ error: "Requests must come from this app" }, { status: 403 });
		return undefined;
	}
	return Response.json({ error: "Unauthorized" }, { status: 401 });
}

const under = (pathname: string, prefix: string) => pathname === prefix || pathname.startsWith(`${prefix}/`);

/** Hands a request to the owner's agent, `path` being its path in the agent's API. */
export async function toAgent(request: Request, env: Env, site: PimSite, path: string, authorized: boolean): Promise<Response> {
	const agent = await getAgentByName(env.Pim, site.agent);
	const url = new URL(request.url);
	url.pathname = path;
	// Bodies are small JSON; buffering them lets the agent answer without reading one.
	const forwarded = new Request(url, request.body === null ? request : new Request(request, { body: await request.arrayBuffer() }));
	// Tells the agent the request was authorized, so it can trust details like the origin.
	forwarded.headers.delete(AUTHORIZED_HEADER);
	if (authorized) forwarded.headers.set(AUTHORIZED_HEADER, "1");
	// The agent checks it is the one this owner's requests are for.
	forwarded.headers.set(OWNER_HEADER, site.agent);
	try {
		return await agent.fetch(forwarded);
	} catch (error) {
		// The agent's instance ended under the request (a restart, or an erasure, after which a retry gets 410).
		if ((error as { durableObjectReset?: boolean })?.durableObjectReset) {
			return Response.json({ error: "Pim restarted while answering. Try again." }, { status: 503 });
		}
		throw error;
	}
}

/** Paths of the API a hosting service answers itself, before the agent: an authorized request for `path` under `/api`. */
export type ApiExtension = (path: string, request: Request) => Promise<Response | undefined>;

export async function servePim(request: Request, env: Env, site: PimSite, extension?: ApiExtension): Promise<Response> {
	const { pathname } = new URL(request.url);
	if (pathname === "/health") return withCors(Response.json({ name: "pim", ok: true }));
	if (under(pathname, "/auth")) return handleAuth(request, env, site);

	// Two paths are public, each checked another way: an app's sign-in page redirects the
	// user's browser to the callback (the MCP client checks the OAuth state), and apps deliver
	// event webhooks (checked against the watch's signing secret).
	const publicMethod = pathname === MCP_CALLBACK_PATH ? "GET" : pathname.startsWith(MCP_EVENTS_PATH) ? "POST" : null;
	if (publicMethod) {
		if (request.method !== publicMethod) return withCors(Response.json({ error: `${pathname} takes ${publicMethod}` }, { status: 405 }));
		return withCors(await toAgent(request, env, site, pathname, false));
	}

	if (!under(pathname, "/api")) return env.ASSETS.fetch(request);
	if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: CORS_HEADERS });
	const path = pathname.slice("/api".length) || "/";
	if (path === "/health") return withCors(Response.json({ name: "pim", ok: true }));
	const denied = await authorize(request, env, site);
	if (denied) return withCors(denied);
	const extended = await extension?.(path, request);
	if (extended) return withCors(extended);
	// The agent accepts sockets on any path; keep them on one.
	const upgrade = request.headers.get("Upgrade")?.toLowerCase() === "websocket";
	if (upgrade !== (path === "/ws")) {
		return withCors(Response.json({ error: upgrade ? "WebSockets connect at /api/ws" : "/api/ws expects a WebSocket upgrade" }, { status: upgrade ? 404 : 426 }));
	}
	return withCors(await toAgent(request, env, site, path, true));
}
