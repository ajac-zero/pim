import { getAgentByName } from "agents";
import { AGENT_NAME, AUTHORIZED_HEADER, MCP_CALLBACK_PATH, MCP_EVENTS_PATH } from "./agent";

export { Pim } from "./agent";

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
 * Every API request needs the deployment's API token, as a bearer token or,
 * for browser WebSockets that cannot set headers, a `token` query parameter.
 */
async function authorize(request: Request, env: Env): Promise<Response | undefined> {
	const expected = env.PIM_API_TOKEN;
	if (!expected) return Response.json({ error: "PIM_API_TOKEN is not configured" }, { status: 503 });
	const header = request.headers.get("Authorization");
	const given = header?.startsWith("Bearer ") ? header.slice(7) : new URL(request.url).searchParams.get("token");
	// Hashing first makes the comparison constant-time regardless of length.
	if (given && crypto.subtle.timingSafeEqual(await digest(given), await digest(expected))) return undefined;
	return Response.json({ error: "Unauthorized" }, { status: 401 });
}

export default {
	async fetch(request, env): Promise<Response> {
		if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: CORS_HEADERS });
		const { pathname } = new URL(request.url);
		if (pathname === "/health") return withCors(Response.json({ name: "pim", ok: true }));
		// Two paths are public, each checked another way: an app's sign-in page redirects the
		// user's browser to the callback (the MCP client checks the OAuth state), and apps deliver
		// event webhooks (checked against the watch's signing secret).
		const isPublic =
			(pathname === MCP_CALLBACK_PATH && request.method === "GET") ||
			(pathname.startsWith(MCP_EVENTS_PATH) && request.method === "POST");
		const denied = isPublic ? undefined : await authorize(request, env);
		if (denied) return withCors(denied);
		// The agent accepts sockets on any path; keep them on one.
		const upgrade = request.headers.get("Upgrade")?.toLowerCase() === "websocket";
		if (upgrade !== (pathname === "/ws")) {
			return withCors(Response.json({ error: upgrade ? "WebSockets connect at /ws" : "/ws expects a WebSocket upgrade" }, { status: upgrade ? 404 : 426 }));
		}
		const agent = await getAgentByName(env.Pim, AGENT_NAME);
		// Bodies are small JSON; buffering them lets the agent answer without reading one.
		const forwarded = request.body === null ? new Request(request) : new Request(request, { body: await request.arrayBuffer() });
		// Tells the agent the request carried the token, so it can trust details like the origin.
		forwarded.headers.delete(AUTHORIZED_HEADER);
		if (!isPublic) forwarded.headers.set(AUTHORIZED_HEADER, "1");
		return withCors(await agent.fetch(forwarded));
	},
} satisfies ExportedHandler<Env>;
