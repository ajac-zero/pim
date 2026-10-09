import { getAgentByName } from "agents";
import { AGENT_NAME, AUTHORIZED_HEADER, MCP_CALLBACK_PATH, MCP_EVENTS_PATH } from "./agent";
import { currentSession, fromAnotherSite, handleAuth } from "./auth";

export { Pim } from "./agent";
export { Auth } from "./auth";

/**
 * One Worker serves all of Pim:
 *
 * - `/api/*`: the agent's API. Browsers sign in with a passkey (a session
 *   cookie); other clients send the API token, if one is set.
 * - `/auth/*`: passkey sign-in and setup links (./auth).
 * - `/mcp/callback`, `/mcp/events/*`: public, for connected apps.
 * - Everything else: the web app (`web/`, built to `web/dist`).
 */

const CORS_HEADERS: Record<string, string> = {
	"Access-Control-Allow-Origin": "*",
	"Access-Control-Allow-Methods": "GET, POST, PUT, DELETE, OPTIONS",
	"Access-Control-Allow-Headers": "Authorization, Content-Type",
	"Access-Control-Max-Age": "86400",
};

function withCors(response: Response): Response {
	// WebSocket upgrades must be returned as they are.
	if (response.webSocket) return response;
	const headers = new Headers(response.headers);
	for (const [name, value] of Object.entries(CORS_HEADERS)) headers.set(name, value);
	return new Response(response.body, { status: response.status, statusText: response.statusText, headers });
}

async function digest(value: string): Promise<ArrayBuffer> {
	return crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
}

/**
 * Whether the request carries the API token, as a bearer token or, for
 * WebSockets from clients that cannot set headers, a `token` query parameter.
 * With no PIM_API_TOKEN set, only passkey sessions get in.
 */
async function hasToken(request: Request, env: Env): Promise<boolean> {
	const expected = env.PIM_API_TOKEN;
	if (!expected) return false;
	const header = request.headers.get("Authorization");
	const given = header?.startsWith("Bearer ") ? header.slice(7) : new URL(request.url).searchParams.get("token");
	// Hashing first makes the comparison constant-time regardless of length.
	return !!given && crypto.subtle.timingSafeEqual(await digest(given), await digest(expected));
}

/** Who may call the API: a token holder, or a browser signed in here. */
async function authorize(request: Request, env: Env): Promise<Response | undefined> {
	if (await hasToken(request, env)) return undefined;
	if (await currentSession(request, env)) {
		// A cookie rides along on requests other sites trigger; a token can't.
		if (fromAnotherSite(request)) return Response.json({ error: "Requests must come from this app" }, { status: 403 });
		return undefined;
	}
	return Response.json({ error: "Unauthorized" }, { status: 401 });
}

const under = (pathname: string, prefix: string) => pathname === prefix || pathname.startsWith(`${prefix}/`);

/** Hands a request to the one agent, `path` being its path in the agent's API. */
async function toAgent(request: Request, env: Env, path: string, authorized: boolean): Promise<Response> {
	const agent = await getAgentByName(env.Pim, AGENT_NAME);
	const url = new URL(request.url);
	url.pathname = path;
	// Bodies are small JSON; buffering them lets the agent answer without reading one.
	const forwarded = new Request(url, request.body === null ? request : new Request(request, { body: await request.arrayBuffer() }));
	// Tells the agent the request was authorized, so it can trust details like the origin.
	forwarded.headers.delete(AUTHORIZED_HEADER);
	if (authorized) forwarded.headers.set(AUTHORIZED_HEADER, "1");
	return agent.fetch(forwarded);
}

export default {
	async fetch(request, env): Promise<Response> {
		const { pathname } = new URL(request.url);
		if (pathname === "/health") return withCors(Response.json({ name: "pim", ok: true }));
		if (under(pathname, "/auth")) return handleAuth(request, env);

		// Two paths are public, each checked another way: an app's sign-in page redirects the
		// user's browser to the callback (the MCP client checks the OAuth state), and apps deliver
		// event webhooks (checked against the watch's signing secret).
		const publicMethod = pathname === MCP_CALLBACK_PATH ? "GET" : pathname.startsWith(MCP_EVENTS_PATH) ? "POST" : null;
		if (publicMethod) {
			if (request.method !== publicMethod) return withCors(Response.json({ error: `${pathname} takes ${publicMethod}` }, { status: 405 }));
			return withCors(await toAgent(request, env, pathname, false));
		}

		if (!under(pathname, "/api")) return env.ASSETS.fetch(request);
		if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: CORS_HEADERS });
		const path = pathname.slice("/api".length) || "/";
		if (path === "/health") return withCors(Response.json({ name: "pim", ok: true }));
		const denied = await authorize(request, env);
		if (denied) return withCors(denied);
		// The agent accepts sockets on any path; keep them on one.
		const upgrade = request.headers.get("Upgrade")?.toLowerCase() === "websocket";
		if (upgrade !== (path === "/ws")) {
			return withCors(Response.json({ error: upgrade ? "WebSockets connect at /api/ws" : "/api/ws expects a WebSocket upgrade" }, { status: upgrade ? 404 : 426 }));
		}
		return withCors(await toAgent(request, env, path, true));
	},
} satisfies ExportedHandler<Env>;
