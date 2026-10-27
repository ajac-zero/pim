import { getAgentByName } from "agents";
import pimConfig from "../pim.config";
import { diagramPage } from "./artifacts";
import { deploymentSettings } from "./deployment";
import { accountApi, adminApi, contentOrigin, handleRegistration, resolveAccount, servePublicArtifact, siteFor, sites, socialApi } from "./accounts";
import { COMPUTER_PATH, COMPUTER_TOKEN_HEADER, computerTokenOwner } from "./computer";
import { BROWSER_LIVE_PATH } from "./browser";
import { observationResponse } from "./cua-observation";
import { readBounded } from "./cua-viewer";
import { APPS_CALLBACK_PATH, MCP_CALLBACK_PATH, MCP_CLIENT_PATH, MCP_EVENTS_PATH, MCP_SERVER_PATH, OWNER_HEADER, SIGNED_IN_HEADER } from "./pim";
import { currentSession, fromAnotherSite, handleAuth, sessionClaim, tokenOwner } from "./auth";
import type { Account } from "./directory";
import { base64UrlEncode } from "./auth/encoding";
import { isNativeApp } from "./extensions/define";
import { themes as ownThemes } from "./extensions/themes";
import { type McpAccess, type McpGrant, serveConsent, serveOAuth } from "./mcp-auth";
import { admitIngress, limited } from "./runtime";
import { PimThemes } from "./themes";

/**
 * Serves a Pim: everyone's web app, sign-in, API and app callbacks, on one
 * hostname. Before anything else, the runtime vouches for where a request
 * came from (./runtime.ts).
 *
 * - `/api/*`: the signed-in person's own space. The request names its owner:
 *   browsers by their session's cookie, other clients by their API
 *   token, which is `pim_<owner>_<secret>`. Either is checked against that
 *   owner's own sign-in before anything else.
 * - `/api/themes`, `/api/themes.css`: public, the color themes of Pim's
 *   own and of the deployment's extensions, which the app needs before
 *   anyone signs in.
 * - `/api/shared/<owner>/<link>`: public, what a chat's public link shows
 *   (./chat-links.ts), which the app's page at `/shared/<owner>/<link>` draws.
 * - `/auth/*`: registration (./accounts.ts) and sign-in (./auth): passkeys, and
 *   accounts at Google, GitHub or a single sign-on provider.
 * - `/mcp`: the person's space as an MCP server (./mcp-server.ts), for MCP
 *   clients such as Claude or ChatGPT, opened by an OAuth access token or an
 *   API token. `/oauth/*` and `/.well-known/*` sign those clients in, and
 *   `/authorize` is the app's page where the person lets them
 *   (./mcp-auth.ts).
 * - `/api/computer/connect`: the person's computer (./computer.ts), which
 *   connects with its own token, `pimc_<owner>_<secret>`. The token opens only
 *   this connection, and the owner's space checks it.
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
	if (!(await limited(env, "api", account.ownerId))) return undefined;
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
			return toAgent(request, env, account.ownerId, MCP_SERVER_PATH);
		},
	},
	async apiTokenOwner(token, env) {
		const account = tokenOwner(token) ? await resolveAccount(env, tokenOwner(token)!) : null;
		if (!account || closed(account)) return null;
		return (await siteFor(env, account).store.checkToken(token, Date.now())) ? account.ownerId : null;
	},
};

const under = (pathname: string, prefix: string) => pathname === prefix || pathname.startsWith(`${prefix}/`);

/** Hands a request to an owner's space, `path` being its path in the space's API; `signedIn` when it came with their browser's session. */
export async function toAgent(request: Request, env: Env, owner: string, path: string, signedIn = false): Promise<Response> {
	const agent = await getAgentByName(env.Pim, owner);
	const url = new URL(request.url);
	url.pathname = path;
	// Bodies are small JSON; buffering them lets the space answer without reading one.
	const forwarded = new Request(url, request.body === null ? request : new Request(request, { body: await request.arrayBuffer() }));
	// The space checks it is the one this owner's requests are for.
	forwarded.headers.set(OWNER_HEADER, owner);
	// Only the Worker says how the caller signed in: a header sent from outside is dropped.
	if (signedIn) forwarded.headers.set(SIGNED_IN_HEADER, "1");
	else forwarded.headers.delete(SIGNED_IN_HEADER);
	try {
		return await agent.fetch(forwarded);
	} catch (error) {
		// The space's instance ended under the request (a restart, or an erasure, after which a retry gets 410).
		if ((error as { durableObjectReset?: boolean })?.durableObjectReset) {
			return Response.json({ error: "The space restarted while answering. Try again." }, { status: 503 });
		}
		throw error;
	}
}

/** Paths of the API answered before the space: an authorized request for `path` under `/api`. */
export type ApiExtension = (path: string, request: Request) => Promise<Response | undefined>;

/**
 * An app's callback or event delivery: `/mcp/callback/<owner>` (GET, the
 * OAuth sign-in's redirect, which the space matches against the callback URL
 * it gave), `/mcp/callback/apps` (the same for the apps extensions
 * implement, whose `state` starts with the owner: see `serveAppReturn`), or
 * `/mcp/events/<owner>/<watch>` (POST, which the space answers as `/mcp/events/<watch>`).
 * Also `/mcp/client/<owner>` (GET): Pim's client metadata document for that
 * owner's sign-ins, for services that take one instead of registering clients.
 */
async function serveApp(request: Request, env: Env, pathname: string): Promise<Response | undefined> {
	if (pathname === APPS_CALLBACK_PATH) return serveAppReturn(request, env);
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
	const account = await resolveAccount(env, decodeURIComponent((callback ?? events)![1]!));
	if (!account) return fail(404, "Not found");
	const refused = closed(account);
	if (refused) return refused;
	return toAgent(request, env, account.ownerId, callback ? pathname : `${MCP_EVENTS_PATH}${events![2]}`);
}

/** What the page that posts a sign-in's return back runs; its hash is the page's only allowed script. */
const RESUBMIT = "document.forms[0].submit()";
let resubmitHash: Promise<string> | undefined;

const escapeHtml = (text: string) => text.replace(/[&<>"']/g, (character) => `&#${character.charCodeAt(0)};`);

function appReturnPage(status: number, body: string, script = ""): Response {
	return new Response(`<!doctype html><meta charset="utf-8"><title>Pim</title>${body}`, {
		status,
		headers: {
			"content-type": "text/html; charset=utf-8",
			"cache-control": "no-store",
			// The address holds the sign-in's code: it goes nowhere else. (Not `no-referrer`: the form's post must say it comes from Pim.)
			"referrer-policy": "same-origin",
			"content-security-policy": `default-src 'none'; script-src ${script || "'none'"}; form-action 'self'; frame-ancestors 'none'; base-uri 'none'`,
		},
	});
}

/**
 * The person's return from signing in to an app an extension implements,
 * at `/mcp/callback/apps`. The service sends the browser back with a GET
 * from its own site, which doesn't carry Pim's session cookie (it is
 * SameSite=Strict), so the page answering it posts the same parameters
 * from Pim's own origin, which does. The post is handed on to the space
 * that `state` names only from a browser signed in as that owner: a sign-in
 * someone else started, such as a consent link sent to the person, can't
 * connect their account to another space. One that isn't signed in can sign
 * in and reload: the sign-in is still there.
 */
async function serveAppReturn(request: Request, env: Env): Promise<Response> {
	if (request.method === "GET") {
		const fields = [...new URL(request.url).searchParams].slice(0, 32);
		resubmitHash ??= crypto.subtle
			.digest("SHA-256", new TextEncoder().encode(RESUBMIT))
			.then((digest) => `'sha256-${btoa(String.fromCharCode(...new Uint8Array(digest)))}'`);
		return appReturnPage(
			200,
			`<form method="post" action="${APPS_CALLBACK_PATH}">${fields.map(([name, value]) => `<input type="hidden" name="${escapeHtml(name)}" value="${escapeHtml(value)}">`).join("")}<p>Finishing signing in…</p><noscript><button>Continue</button></noscript></form><script>${RESUBMIT}</script>`,
			await resubmitHash,
		);
	}
	if (request.method !== "POST") return fail(405, `${APPS_CALLBACK_PATH} takes GET and POST`);
	if (Number(request.headers.get("content-length") ?? 0) > 16_384) return fail(413, "Too large");
	const state = (await request.clone().formData().catch(() => null))?.get("state");
	const account = typeof state === "string" ? await resolveAccount(env, state.split(".")[0]!) : null;
	if (!account) return fail(404, "Not found");
	const refused = closed(account);
	if (refused) return refused;
	const browser = await signedIn(request, env);
	if (!browser || browser instanceof Response || browser.ownerId !== account.ownerId) {
		return appReturnPage(403, "<p>Sign in to Pim in this browser, as the person who is connecting the app, then reload this page.</p>");
	}
	return toAgent(request, env, account.ownerId, APPS_CALLBACK_PATH, true);
}

/**
 * An app's page for the person (`NativeAppDefinition.page`), such as
 * Drive's file picker: `/app-pages/<extension>/<app>`. The page holds
 * nothing of anyone's; what it does goes through the app's actions, which
 * check the person's session. It runs under the app's own content security
 * policy, in no frame, and its address goes nowhere else.
 */
function serveAppPage(request: Request, pathname: string): Response {
	const match = /^\/app-pages\/([^/]+)\/([^/]+)$/.exec(pathname);
	const app = match ? pimConfig.extensions.find((extension) => extension.id === match[1])?.apps?.find((candidate) => candidate.id === match[2]) : undefined;
	if (!app || !isNativeApp(app) || !app.page) return fail(404, "Not found");
	if (request.method !== "GET") return fail(405, `${pathname} takes GET`);
	const nonce = base64UrlEncode(crypto.getRandomValues(new Uint8Array(16)));
	const page = app.page(nonce);
	return new Response(page.html, {
		headers: {
			"content-type": "text/html; charset=utf-8",
			"cache-control": "no-store",
			"content-security-policy": page.contentSecurityPolicy,
			"x-frame-options": "DENY",
			"x-content-type-options": "nosniff",
			// Not `no-referrer`: the page's posts must say they come from Pim.
			"referrer-policy": "same-origin",
		},
	});
}

/**
 * An image a model provider fetches: `/images/<owner>/<id>?expires=…&signature=…`,
 * which the space checks and answers as `/public-images/<id>`.
 */
async function serveImage(request: Request, env: Env, pathname: string): Promise<Response> {
	const match = /^\/images\/([^/]+)\/([\w-]+)$/.exec(pathname);
	if (!match) return fail(404, "Not found");
	if (request.method !== "GET") return fail(405, `${pathname} takes GET`);
	const account = await resolveAccount(env, decodeURIComponent(match[1]!));
	if (!account) return fail(404, "Not found");
	const refused = closed(account);
	if (refused) return refused;
	return toAgent(request, env, account.ownerId, `/public-images/${match[2]}`);
}

/**
 * A chat's public link: `/api/shared/<owner>/<link>`, the copy of the chat
 * the link shows, for anyone who has it, with no token. The owner's space
 * answers it as `/shared/<link>`. Every way it isn't there, including an
 * account that is suspended or gone, is the same `404`.
 */
async function serveSharedChat(request: Request, env: Env, pathname: string, address: string): Promise<Response> {
	const notFound = () => Response.json({ error: "This link doesn't exist, or was turned off." }, { status: 404, headers: { "cache-control": "no-store" } });
	if (request.method !== "GET" && request.method !== "HEAD") return fail(405, `${pathname} takes GET`);
	// Nobody signs in to read it, so it is slowed down per address.
	if (await limited(env, "public", address)) return fail(429, "Too many requests. Slow down a little.");
	const match = /^\/api\/shared\/([^/]+)\/([^/]+)$/.exec(pathname);
	const account = match ? await resolveAccount(env, decodeURIComponent(match[1]!)) : null;
	if (!account || closed(account)) return notFound();
	const answer = await toAgent(new Request(request.url, { method: "GET" }), env, account.ownerId, `/shared/${match![2]}`);
	if (!answer.ok) return answer.status >= 500 ? answer : notFound();
	// The copy changes only when its owner updates the link, so browsers and caches may keep it a minute.
	return new Response(answer.body, {
		headers: { "content-type": "application/json", "cache-control": "public, max-age=60", "x-robots-tag": "noindex" },
	});
}

/**
 * The person's computer connecting: a WebSocket with the computer's token,
 * which names its owner. The owner's space checks the token, so it opens
 * nothing else, and an API token or a session doesn't open this.
 */
async function serveComputer(request: Request, env: Env): Promise<Response> {
	const token = givenToken(request);
	const owner = token ? computerTokenOwner(token) : null;
	const account = owner ? await resolveAccount(env, owner) : null;
	if (!account) return fail(401, "Unauthorized");
	const refused = closed(account) ?? (await throttled(env, account));
	if (refused) return refused;
	const forwarded = new Request(request);
	forwarded.headers.delete("Authorization");
	forwarded.headers.set(COMPUTER_TOKEN_HEADER, token!);
	return toAgent(forwarded, env, account.ownerId, COMPUTER_PATH);
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

/**
 * Routes a composition adds to the API, which a deployment doesn't have: it
 * passes none (./index.ts). Only the preview mounts `observations`
 * (preview/worker.ts, docs/cua-viewer-first-preview.md).
 */
export type Mounts = { readonly observations?: boolean };

/** The one observation path that takes a WebSocket: the viewer's media socket. */
const OBSERVATION_MEDIA = /^\/observations\/[A-Za-z0-9_-]{16,64}\/media$/;
/** The most an observation request's body may be: a viewer call is at most 4 KiB, management has none. */
const MAX_OBSERVATION_BODY = 4096;
/** How long an observation request's body has to arrive; past it, the request is refused unread. */
const OBSERVATION_BODY_MS = 10_000;

/**
 * The person watching their Cua desktop, where mounted: `/api/observations/…`,
 * for their browser's session only, handed to their space with its full path,
 * which admits each request against its ledger (src/cua-observation-runtime.ts).
 * Only the media socket upgrades, bodies are bounded, and no answer is kept.
 * This is no proxy: the space answers only its own management routes and the
 * viewer's allowlisted files, calls and socket.
 */
async function serveObservation(request: Request, env: Env, owner: string, viaSession: boolean, path: string): Promise<Response> {
	if (!viaSession) return observationResponse(fail(401, "Only your signed-in browser can watch your desktop."));
	if (request.headers.get("Upgrade")?.toLowerCase() === "websocket" && !OBSERVATION_MEDIA.test(path)) return observationResponse(fail(404, "Not found"));
	let forwarded = request;
	if (request.body) {
		const length = request.headers.get("content-length");
		if (length !== null && !(Number(length) <= MAX_OBSERVATION_BODY)) {
			void request.body.cancel().catch(() => undefined);
			return observationResponse(fail(413, "Too large"));
		}
		// Bounded in time as in size: a body that stalls is cut off, and the timer is cleared however the read ends.
		const giveUp = new AbortController();
		const timer = setTimeout(() => giveUp.abort(), OBSERVATION_BODY_MS);
		let read: Awaited<ReturnType<typeof readBounded>>;
		try {
			read = await readBounded(request.body, MAX_OBSERVATION_BODY, giveUp.signal);
		} finally {
			clearTimeout(timer);
		}
		if (read.kind === "too_big") return observationResponse(fail(413, "Too large"));
		if (read.kind === "stopped") return observationResponse(fail(408, "The request's body didn't arrive in time."));
		if (read.kind === "failed") return observationResponse(fail(400, "The request's body couldn't be read."));
		forwarded = new Request(request, { body: read.bytes });
	}
	return observationResponse(await toAgent(forwarded, env, owner, `/api${path}`, true));
}

export async function serve(arrived: Request, env: Env, ctx: ExecutionContext, mounts: Mounts = {}): Promise<Response> {
	const admitted = await admitIngress(arrived, env);
	if (admitted instanceof Response) return admitted;
	const { request, address } = admitted;
	const { pathname, origin } = new URL(request.url);
	if (origin === contentOrigin(env)) {
		// Nobody signs in here, so pages are slowed down per address.
		if (await limited(env, "public", address)) return fail(429, "Too many requests. Slow down a little.");
		return servePublicArtifact(request, env, pathname);
	}
	if (pathname === "/health") return withCors(Response.json({ name: "pim", ok: true }));
	// The app's look, which the page asking for an address needs too.
	if (pathname === "/api/themes" || pathname === "/api/themes.css") return withCors(serveThemes(request, pathname.slice("/api".length)));

	// Passkeys, sessions and apps' callbacks all belong to one address, which the deployment sets.
	const { publicUrl } = deploymentSettings(env);
	if (!publicUrl) {
		// `missing` lets the web app show how to set it.
		const error = "This Pim has no address yet: add PIM_PUBLIC_URL to the Worker's variables, the address people will use, such as https://pim.example.com.";
		return Response.json({ error, missing: "PIM_PUBLIC_URL" }, { status: 503 });
	}
	// The web app goes to the address it names; nothing is served at any other.
	if (origin !== publicUrl) return Response.json({ error: `This Pim is at ${publicUrl}`, url: publicUrl }, { status: 421 });
	// The page diagrams in agents' messages are drawn in, which holds nothing of anyone's.
	if (pathname === "/api/diagram") return request.method === "GET" ? diagramPage(publicUrl) : fail(405, "/api/diagram takes GET");

	if (under(pathname, "/auth") || under(pathname, "/oauth")) {
		// Guessing at passkeys, recovery codes and tokens, and registering clients, is slowed down per address.
		if (request.method !== "GET" && request.method !== "OPTIONS" && (await limited(env, "auth", address))) {
			console.log(JSON.stringify({ event: "pim.rate_limited", limit: "auth" }));
			return fail(429, "Too many attempts. Wait a minute and try again.");
		}
	}

	if (pathname === "/mcp" || under(pathname, "/oauth") || under(pathname, "/.well-known")) {
		return serveOAuth(request, env, ctx, publicUrl, mcpAccess);
	}

	if (pathname === "/auth/authorize" || under(pathname, "/auth/connections")) {
		// Only the person, in the app, lets clients in and sees which they let in.
		const account = await signedIn(request, env);
		if (!account) return fail(401, "Sign in to Pim");
		if (account instanceof Response) return account;
		return serveConsent(request, env, account.ownerId, publicUrl, mcpAccess);
	}

	if (under(pathname, "/auth")) return (await handleRegistration(request, env, address)) ?? handleAuth(request, env, sites(env));

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
	if (under(pathname, "/app-pages")) return serveAppPage(request, pathname);

	if (under(pathname, "/api/shared")) return withCors(await serveSharedChat(request, env, pathname, address));
	if (under(pathname, "/shared")) {
		// The app's page for a chat's public link, which search engines should leave out.
		const asset = await env.ASSETS.fetch(request);
		const page = new Response(asset.body, asset);
		page.headers.set("X-Robots-Tag", "noindex");
		page.headers.set("Referrer-Policy", "no-referrer");
		return page;
	}

	if (under(pathname, "/mcp")) {
		const app = await serveApp(request, env, pathname);
		if (app) return withCors(app);
	}

	if (!under(pathname, "/api")) return env.ASSETS.fetch(request);
	if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: CORS_HEADERS });
	const path = pathname.slice("/api".length) || "/";
	if (path === "/health") return withCors(Response.json({ name: "pim", ok: true }));
	if (path === "/computer/connect") return serveComputer(request, env);
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
	if (mounts.observations && under(path, "/observations")) return serveObservation(request, env, account.ownerId, viaSession, path);
	// The space accepts sockets on any path; keep them on one.
	const upgrade = request.headers.get("Upgrade")?.toLowerCase() === "websocket";
	if (upgrade !== (path === "/ws" || path === BROWSER_LIVE_PATH)) {
		return withCors(fail(upgrade ? 404 : 426, upgrade ? "WebSockets connect at /api/ws" : "/api/ws expects a WebSocket upgrade"));
	}
	return withCors(await toAgent(request, env, account.ownerId, path, viaSession));
}
