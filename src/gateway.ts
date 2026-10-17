import { getAgentByName } from "agents";
import pimConfig from "../pim.config";
import { accountApi, adminApi, clientIp, handleRegistration, limited, pimOrigin, resolveAccount, siteFor, sites, socialApi } from "./accounts";
import { APPS_CALLBACK_PATH, AUTHORIZED_HEADER, MCP_CALLBACK_PATH, MCP_CLIENT_PATH, MCP_EVENTS_PATH, MCP_SERVER_PATH, OWNER_HEADER } from "./pim";
import { currentSession, fromAnotherSite, handleAuth, sessionClaim, tokenOwner } from "./auth";
import type { Account } from "./directory";
import { themes as ownThemes } from "./extensions/themes";
import { type McpAccess, type McpGrant, serveConsent, serveOAuth } from "./mcp-auth";
import { PimThemes } from "./themes";

/**
 * Serves a Pim: everyone's web app, sign-in, API and app callbacks, on one
 * hostname.
 *
 * - `/api/*`: the signed-in person's own Pim. The request names its owner:
 *   browsers by their session's cookie, other clients by their API
 *   token, which is `pim_<owner>_<secret>`. Either is checked against that
 *   owner's own sign-in before anything else.
 * - `/api/themes`, `/api/themes.css`: public, the color themes of Pim's
 *   own and of the deployment's extensions, which the app needs before
 *   anyone signs in.
 * - `/auth/*`: registration (./accounts.ts) and sign-in (./auth): passkeys, and
 *   accounts at Google, GitHub or a single sign-on provider.
 * - `/mcp`: the person's Pim as an MCP server (./mcp-server.ts), for MCP
 *   clients such as Claude or ChatGPT, opened by an OAuth access token or an
 *   API token. `/oauth/*` and `/.well-known/*` sign those clients in, and
 *   `/authorize` is the app's page where the person lets them
 *   (./mcp-auth.ts).
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

/** Whose request this is, and whether it came with a browser's session (some things an API token can't do). */
type Caller = { readonly account: Account; readonly viaSession: boolean };

/** Why an account opens nothing, if it doesn't. */
function closed(account: Account): Response | undefined {
	if (account.status === "deleted" || account.status === "deleting") return fail(410, "This account was deleted.");
	if (account.status === "suspended") return fail(403, "This account is suspended.");
	if (account.status !== "active") return fail(401, "Unauthorized");
	return undefined;
}

/** Who may call the API: a token holder, or a signed-in browser. */
async function authorize(request: Request, env: Env): Promise<Caller | Response> {
	const token = givenToken(request);
	const tokenAccount = token && tokenOwner(token) ? await resolveAccount(env, tokenOwner(token)!) : null;
	if (token && tokenAccount) {
		const refused = closed(tokenAccount);
		if (refused) return refused;
		if (await siteFor(env, tokenAccount).store.checkToken(token, Date.now())) return { account: tokenAccount, viaSession: false };
	}
	const account = await signedIn(request, env);
	if (account) return account instanceof Response ? account : { account, viaSession: true };
	return fail(401, "Unauthorized");
}

/** The account a browser's session signs in, if it does, or why it opens nothing. */
async function signedIn(request: Request, env: Env): Promise<Account | Response | null> {
	const claim = await sessionClaim(request, env);
	const account = claim ? await resolveAccount(env, claim.owner) : null;
	if (!account) return null;
	const refused = closed(account);
	if (refused) return refused;
	if (!(await currentSession(request, env, siteFor(env, account)))) return null;
	// A cookie rides along on requests other sites trigger; a token can't.
	if (fromAnotherSite(request)) return fail(403, "Requests must come from this app");
	return account;
}

/** Whether `account` may make a request now: heavy use is slowed down per person. */
async function throttled(env: Env, account: Account): Promise<Response | undefined> {
	if (!(await limited(env.API_LIMITER, account.ownerId))) return undefined;
	console.log(JSON.stringify({ event: "pim.rate_limited", limit: "api", owner: account.ownerId }));
	return fail(429, "Too many requests. Slow down a little.");
}

/** Whose request this is, if they may make it now. */
async function admit(request: Request, env: Env): Promise<Caller | Response> {
	const caller = await authorize(request, env);
	if (caller instanceof Response) return caller;
	return (await throttled(env, caller.account)) ?? caller;
}

/** The MCP server, for the person an OAuth grant or API token names, checked as the API is. */
const mcpAccess: McpAccess = {
	server: {
		async fetch(request, env, ctx) {
			const account = await resolveAccount(env, (ctx.props as McpGrant).owner);
			if (!account) return fail(410, "This account was deleted.");
			const refused = closed(account) ?? (await throttled(env, account));
			if (refused) return refused;
			return toAgent(request, env, account.ownerId, MCP_SERVER_PATH, true);
		},
	},
	async apiTokenOwner(token, env) {
		const account = tokenOwner(token) ? await resolveAccount(env, tokenOwner(token)!) : null;
		if (!account || closed(account)) return null;
		return (await siteFor(env, account).store.checkToken(token, Date.now())) ? account.ownerId : null;
	},
};

const under = (pathname: string, prefix: string) => pathname === prefix || pathname.startsWith(`${prefix}/`);

/** Hands a request to an owner's Pim, `path` being its path in the Pim's API. */
export async function toAgent(request: Request, env: Env, owner: string, path: string, authorized: boolean): Promise<Response> {
	const agent = await getAgentByName(env.Pim, owner);
	const url = new URL(request.url);
	url.pathname = path;
	// Bodies are small JSON; buffering them lets the Pim answer without reading one.
	const forwarded = new Request(url, request.body === null ? request : new Request(request, { body: await request.arrayBuffer() }));
	// Tells the Pim the request was authorized, so it can trust details like the origin.
	forwarded.headers.delete(AUTHORIZED_HEADER);
	if (authorized) forwarded.headers.set(AUTHORIZED_HEADER, "1");
	// The Pim checks it is the one this owner's requests are for.
	forwarded.headers.set(OWNER_HEADER, owner);
	try {
		return await agent.fetch(forwarded);
	} catch (error) {
		// The Pim's instance ended under the request (a restart, or an erasure, after which a retry gets 410).
		if ((error as { durableObjectReset?: boolean })?.durableObjectReset) {
			return Response.json({ error: "Pim restarted while answering. Try again." }, { status: 503 });
		}
		throw error;
	}
}

/** Paths of the API answered before the Pim: an authorized request for `path` under `/api`. */
export type ApiExtension = (path: string, request: Request) => Promise<Response | undefined>;

/**
 * An app's callback or event delivery: `/mcp/callback/<owner>` (GET, the
 * OAuth sign-in's redirect, which the Pim matches against the callback URL
 * it gave), `/mcp/callback/apps` (GET, the same for the apps extensions
 * implement, whose `state` starts with the owner), or
 * `/mcp/events/<owner>/<watch>` (POST, which the Pim answers as `/mcp/events/<watch>`).
 * Also `/mcp/client/<owner>` (GET): Pim's client metadata document for that
 * owner's sign-ins, for services that take one instead of registering clients.
 */
async function serveApp(request: Request, env: Env, pathname: string): Promise<Response | undefined> {
	const client = new RegExp(`^${MCP_CLIENT_PATH}/([^/]+)$`).exec(pathname);
	if (client) {
		if (request.method !== "GET") return fail(405, `${pathname} takes GET`);
		if (!(await resolveAccount(env, decodeURIComponent(client[1]!)))) return fail(404, "Not found");
		const { origin } = new URL(request.url);
		// The same metadata Pim registers with elsewhere; its id is this document's URL.
		return Response.json({
			client_id: `${origin}${pathname}`,
			client_name: "Pim",
			redirect_uris: [`${origin}${MCP_CALLBACK_PATH}/${client[1]}`],
			grant_types: ["authorization_code", "refresh_token"],
			response_types: ["code"],
			token_endpoint_auth_method: "none",
		});
	}
	const callback = new RegExp(`^${MCP_CALLBACK_PATH}/([^/]+)$`).exec(pathname);
	const events = new RegExp(`^${MCP_EVENTS_PATH}([^/]+)/([^/]+)$`).exec(pathname);
	if (!callback && !events) return undefined;
	const method = callback ? "GET" : "POST";
	if (request.method !== method) return fail(405, `${pathname} takes ${method}`);
	const owner = pathname === APPS_CALLBACK_PATH ? (new URL(request.url).searchParams.get("state") ?? "").split(".")[0]! : decodeURIComponent((callback ?? events)![1]!);
	const account = await resolveAccount(env, owner);
	if (!account) return fail(404, "Not found");
	const refused = closed(account);
	if (refused) return refused;
	return toAgent(request, env, account.ownerId, callback ? pathname : `${MCP_EVENTS_PATH}${events![2]}`, false);
}

/**
 * An image a model provider fetches: `/images/<owner>/<id>?expires=…&signature=…`,
 * which the Pim checks and answers as `/public-images/<id>`.
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

let deployedThemes: PimThemes | undefined;

/** The color themes, listed (`/themes`) or as the stylesheet the app loads before it draws (`/themes.css`). */
function serveThemes(request: Request, path: string): Response {
	if (request.method !== "GET") return fail(405, `/api${path} takes GET`);
	deployedThemes ??= new PimThemes([ownThemes, ...pimConfig.extensions], pimConfig.defaultTheme);
	// Small, and they change with a deploy: the browser asks again every time.
	const headers = { "Cache-Control": "no-cache" };
	if (path === "/themes") return Response.json(deployedThemes.list(), { headers });
	return new Response(deployedThemes.stylesheet(), { headers: { ...headers, "Content-Type": "text/css; charset=utf-8" } });
}

export async function serve(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
	const { pathname } = new URL(request.url);
	if (pathname === "/health") return withCors(Response.json({ name: "pim", ok: true }));

	if (under(pathname, "/auth") || under(pathname, "/oauth")) {
		// Guessing at passkeys, recovery codes and tokens, and registering clients, is slowed down per address.
		if (request.method !== "GET" && request.method !== "OPTIONS" && (await limited(env.AUTH_LIMITER, clientIp(request)))) {
			console.log(JSON.stringify({ event: "pim.rate_limited", limit: "auth" }));
			return fail(429, "Too many attempts. Wait a minute and try again.");
		}
	}

	if (pathname === "/mcp" || under(pathname, "/oauth") || under(pathname, "/.well-known")) {
		return serveOAuth(request, env, ctx, pimOrigin(request, env), mcpAccess);
	}

	if (pathname === "/auth/authorize" || under(pathname, "/auth/connections")) {
		// Only the person, in the app, lets clients in and sees which they let in.
		const account = await signedIn(request, env);
		if (!account) return fail(401, "Sign in to Pim");
		if (account instanceof Response) return account;
		return serveConsent(request, env, account.ownerId, pimOrigin(request, env), mcpAccess);
	}

	if (under(pathname, "/auth")) return (await handleRegistration(request, env)) ?? handleAuth(request, env, sites(env));

	if (pathname === "/authorize") {
		// The app's page where the person lets an MCP client in, which no other site may frame.
		const asset = await env.ASSETS.fetch(request);
		const page = new Response(asset.body, asset);
		page.headers.set("Content-Security-Policy", "frame-ancestors 'none'");
		page.headers.set("X-Frame-Options", "DENY");
		page.headers.set("Cache-Control", "no-store");
		return page;
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
	if (path === "/themes" || path === "/themes.css") return withCors(serveThemes(request, path));
	const caller = await admit(request, env);
	if (caller instanceof Response) return withCors(caller);
	const { account, viaSession } = caller;
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
	// The Pim accepts sockets on any path; keep them on one.
	const upgrade = request.headers.get("Upgrade")?.toLowerCase() === "websocket";
	if (upgrade !== (path === "/ws")) {
		return withCors(fail(upgrade ? 404 : 426, upgrade ? "WebSockets connect at /api/ws" : "/api/ws expects a WebSocket upgrade"));
	}
	return withCors(await toAgent(request, env, account.ownerId, path, true));
}
