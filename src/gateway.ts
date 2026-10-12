import { getAgentByName } from "agents";
import { accountApi, adminApi, clientIp, handleRegistration, limited, resolveAccount, siteFor, sites, socialApi } from "./accounts";
import { AUTHORIZED_HEADER, MCP_CALLBACK_PATH, MCP_EVENTS_PATH, OWNER_HEADER } from "./agent";
import { currentSession, fromAnotherSite, handleAuth, sessionClaim, tokenOwner } from "./auth";
import type { Account } from "./directory";

/**
 * Serves a Pim: everyone's web app, sign-in, API and app callbacks, on one
 * hostname.
 *
 * - `/api/*`: the signed-in person's own Pim. The request names its owner:
 *   browsers by their passkey session's cookie, other clients by their API
 *   token, which is `pim_<owner>_<secret>`. Either is checked against that
 *   owner's own sign-in before anything else.
 * - `/auth/*`: registration (./accounts.ts) and passkey sign-in (./auth).
 * - `/mcp/callback/<owner>`, `/mcp/events/<owner>/<watch>`: public, for
 *   connected apps. Each is checked another way: the OAuth state, and the
 *   watch's signing secret.
 * - Everything else: the web app (`web/`, built to `web/dist`).
 */

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

const fail = (status: number, error: string) => Response.json({ error }, { status });

/** The token a request carries, as a bearer token or, for WebSockets from clients that cannot set headers, a `token` query parameter. */
function givenToken(request: Request): string | null {
	const header = request.headers.get("Authorization");
	return header?.startsWith("Bearer ") ? header.slice(7) : new URL(request.url).searchParams.get("token");
}

/** Whose request this is, and whether it came with a passkey session (some things an API token can't do). */
type Caller = { readonly account: Account; readonly viaSession: boolean };

/** Why an account opens nothing, if it doesn't. */
function closed(account: Account): Response | undefined {
	if (account.status === "deleted" || account.status === "deleting") return fail(410, "This account was deleted.");
	if (account.status === "suspended") return fail(403, "This account is suspended.");
	if (account.status !== "active") return fail(401, "Unauthorized");
	return undefined;
}

/** Who may call the API: a token holder, or a browser signed in with a passkey. */
async function authorize(request: Request, env: Env): Promise<Caller | Response> {
	const token = givenToken(request);
	const tokenAccount = token && tokenOwner(token) ? await resolveAccount(env, tokenOwner(token)!) : null;
	if (token && tokenAccount) {
		const refused = closed(tokenAccount);
		if (refused) return refused;
		if (await siteFor(env, tokenAccount).store.checkToken(token, Date.now())) return { account: tokenAccount, viaSession: false };
	}
	const claim = await sessionClaim(request, env);
	const account = claim ? await resolveAccount(env, claim.owner) : null;
	if (account) {
		const refused = closed(account);
		if (refused) return refused;
		if (await currentSession(request, env, siteFor(env, account))) {
			// A cookie rides along on requests other sites trigger; a token can't.
			if (fromAnotherSite(request)) return fail(403, "Requests must come from this app");
			return { account, viaSession: true };
		}
	}
	return fail(401, "Unauthorized");
}

const under = (pathname: string, prefix: string) => pathname === prefix || pathname.startsWith(`${prefix}/`);

/** Hands a request to an owner's agent, `path` being its path in the agent's API. */
export async function toAgent(request: Request, env: Env, owner: string, path: string, authorized: boolean): Promise<Response> {
	const agent = await getAgentByName(env.Pim, owner);
	const url = new URL(request.url);
	url.pathname = path;
	// Bodies are small JSON; buffering them lets the agent answer without reading one.
	const forwarded = new Request(url, request.body === null ? request : new Request(request, { body: await request.arrayBuffer() }));
	// Tells the agent the request was authorized, so it can trust details like the origin.
	forwarded.headers.delete(AUTHORIZED_HEADER);
	if (authorized) forwarded.headers.set(AUTHORIZED_HEADER, "1");
	// The agent checks it is the one this owner's requests are for.
	forwarded.headers.set(OWNER_HEADER, owner);
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

/** Paths of the API answered before the agent: an authorized request for `path` under `/api`. */
export type ApiExtension = (path: string, request: Request) => Promise<Response | undefined>;

/**
 * An app's callback or event delivery: `/mcp/callback/<owner>` (GET, the
 * OAuth sign-in's redirect, which the agent matches against the callback URL
 * it gave) or `/mcp/events/<owner>/<watch>` (POST, which the agent answers as
 * `/mcp/events/<watch>`).
 */
async function serveApp(request: Request, env: Env, pathname: string): Promise<Response | undefined> {
	const callback = new RegExp(`^${MCP_CALLBACK_PATH}/([^/]+)$`).exec(pathname);
	const events = new RegExp(`^${MCP_EVENTS_PATH}([^/]+)/([^/]+)$`).exec(pathname);
	if (!callback && !events) return undefined;
	const method = callback ? "GET" : "POST";
	if (request.method !== method) return fail(405, `${pathname} takes ${method}`);
	const account = await resolveAccount(env, decodeURIComponent((callback ?? events)![1]!));
	if (!account) return fail(404, "Not found");
	const refused = closed(account);
	if (refused) return refused;
	return toAgent(request, env, account.ownerId, callback ? pathname : `${MCP_EVENTS_PATH}${events![2]}`, false);
}

/**
 * An image a model provider fetches: `/images/<owner>/<id>?expires=…&signature=…`,
 * which the agent checks and answers as `/public-images/<id>`.
 */
async function serveImage(request: Request, env: Env, pathname: string): Promise<Response> {
	const match = /^\/images\/([^/]+)\/([\w-]+)$/.exec(pathname);
	if (!match) return fail(404, "Not found");
	if (request.method !== "GET") return fail(405, `${pathname} takes GET`);
	const account = await resolveAccount(env, decodeURIComponent(match[1]!));
	if (!account) return fail(404, "Not found");
	const refused = closed(account);
	if (refused) return refused;
	return toAgent(request, env, account.ownerId, `/public-images/${match[2]}`, false);
}

export async function serve(request: Request, env: Env): Promise<Response> {
	const { pathname } = new URL(request.url);
	if (pathname === "/health") return withCors(Response.json({ name: "pim", ok: true }));

	if (under(pathname, "/auth")) {
		// Guessing at passkeys, recovery codes and tokens is slowed down per address.
		if (request.method !== "GET" && (await limited(env.AUTH_LIMITER, clientIp(request)))) {
			console.log(JSON.stringify({ event: "pim.rate_limited", limit: "auth" }));
			return fail(429, "Too many attempts. Wait a minute and try again.");
		}
		return (await handleRegistration(request, env)) ?? handleAuth(request, env, sites(env));
	}

	if (under(pathname, "/images")) return serveImage(request, env, pathname);

	if (under(pathname, "/mcp")) {
		const app = await serveApp(request, env, pathname);
		if (app) return withCors(app);
	}

	if (!under(pathname, "/api")) return env.ASSETS.fetch(request);
	if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: CORS_HEADERS });
	const path = pathname.slice("/api".length) || "/";
	if (path === "/health") return withCors(Response.json({ name: "pim", ok: true }));
	const caller = await authorize(request, env);
	if (caller instanceof Response) return withCors(caller);
	const { account, viaSession } = caller;
	// Heavy use is slowed down per person.
	if (await limited(env.API_LIMITER, account.ownerId)) {
		console.log(JSON.stringify({ event: "pim.rate_limited", limit: "api", owner: account.ownerId }));
		return withCors(fail(429, "Too many requests. Slow down a little."));
	}
	const site = siteFor(env, account);
	const extensions = [
		accountApi(env, account, site, request, viaSession),
		adminApi(env, account, request, viaSession),
		socialApi(env, account, request),
	];
	for (const extension of extensions) {
		const answered = await extension(path, request);
		if (answered) return withCors(answered);
	}
	// The agent accepts sockets on any path; keep them on one.
	const upgrade = request.headers.get("Upgrade")?.toLowerCase() === "websocket";
	if (upgrade !== (path === "/ws")) {
		return withCors(fail(upgrade ? 404 : 426, upgrade ? "WebSockets connect at /api/ws" : "/api/ws expects a WebSocket upgrade"));
	}
	return withCors(await toAgent(request, env, account.ownerId, path, true));
}
