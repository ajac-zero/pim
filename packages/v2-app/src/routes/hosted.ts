import { createHmac } from "node:crypto";
import type { IncomingMessage } from "node:http";
import type { App } from "../app.ts";
import { readCookie, readBody, type Reply, route, type Route, setCookie } from "../http.ts";
import { NotFoundError } from "../errors.ts";
import type { AppHttpRequest } from "../relay.ts";

/** The headers a backend gets: what a page's request needs, never Pim's cookies or credentials (the apps' own cookies go through at their own address). */
const FORWARD = ["accept", "accept-language", "content-type", "if-none-match", "if-modified-since", "range", "user-agent", "x-requested-with"];
/** Headers a visitor must not be able to send a backend as if Pim had. */
const PIM_HEADERS = /^x-pim-/i;
/** Pim's rules for a page reached through its token: it may load and call only its own address. */
export const HOSTED_CSP = "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; connect-src 'self'; frame-ancestors 'self'";
const APP_COOKIE = "pim_app";
const APP_COOKIE_S = 12 * 3600;

function toRequest(req: IncomingMessage, path: string, body: Uint8Array | undefined, extra: Record<string, string> = {}, allowCookies = false): AppHttpRequest {
	const headers: Record<string, string> = {};
	for (const [k, v] of Object.entries(req.headers)) {
		const name = k.toLowerCase();
		if (typeof v !== "string" || PIM_HEADERS.test(name)) continue;
		if (FORWARD.includes(name)) headers[name] = v;
		else if (allowCookies && (name === "authorization" || name === "cookie")) headers[name] = name === "cookie" ? v.split(";").map((c) => c.trim()).filter((c) => !c.startsWith(`${APP_COOKIE}=`)).join("; ") : v;
	}
	return { method: req.method ?? "GET", path, headers: { ...headers, ...extra }, ...(body?.length ? { body } : {}) };
}

/** What the backend may answer with: no cookies on Pim's own address, and none of the headers that would bind the hosts around it. */
function toReply(r: { status: number; headers: Record<string, string>; body: Uint8Array }, own: { cookies: boolean; csp: boolean }): Reply {
	const headers: Record<string, string | string[]> = {};
	for (const [k, v] of Object.entries(r.headers)) {
		const name = k.toLowerCase();
		if (["content-length", "transfer-encoding", "connection", "strict-transport-security", "clear-site-data"].includes(name)) continue;
		if (name === "set-cookie") {
			if (!own.cookies) continue;
			// A cookie is kept to the app's own address: its Domain goes, and the one Pim keeps is dropped.
			const kept = (Array.isArray(v) ? v : [v]).map((c) => c.replace(/;\s*domain=[^;]*/i, "")).filter((c) => !c.trim().startsWith(`${APP_COOKIE}=`));
			if (kept.length) headers["set-cookie"] = kept;
			continue;
		}
		if (own.csp && ["content-security-policy", "x-frame-options"].includes(name)) continue;
		headers[name] = v;
	}
	if (own.csp) headers["content-security-policy"] = HOSTED_CSP;
	headers["x-content-type-options"] = "nosniff";
	return { status: r.status, headers, raw: r.body };
}

const METHODS = ["GET", "HEAD", "POST", "PUT", "PATCH", "DELETE"] as const;

/**
 * `/hosted/<owner>/<id>/<token>/…`: an app's page and API reached through a token that opens that app and nothing else, relayed to its backend on
 * the owner's computer. A suspended owner's app does not run (403), a deleted owner's is gone (410), and with no computer connected it is 503.
 * The page carries no cookies, so every address it uses is relative; `x-forwarded-prefix` tells the backend where it is mounted.
 */
export const hostedRoutes: Route[] = [
	...METHODS.flatMap((method) => [
		route(method, "/hosted/:owner/:id/:token/", async (ctx) => hosted(ctx.app, ctx.req, ctx.params as [string, string, string], "/", ctx.url.search)),
		route(method, "/hosted/:owner/:id/:token", async (ctx) => hosted(ctx.app, ctx.req, ctx.params as [string, string, string], "", ctx.url.search)),
		route(method, "/hosted/:owner/:id/:token/*", async (ctx) => hosted(ctx.app, ctx.req, ctx.params as [string, string, string, string], `/${ctx.params[3] ?? ""}`, ctx.url.search)),
	]),
	// A person asks to open an app at its own address: the answer is a minute-long code that address trades for its cookie.
	route("GET", "/hosted/enter", async ({ app, principal, url, appsOrigin }) => {
		if (!appsOrigin) throw new NotFoundError();
		const label = url.searchParams.get("app") ?? "";
		const code = await app.apps.enter(await principal(), label);
		const target = new URL(appsOrigin);
		target.hostname = `${label}.${target.hostname}`;
		target.searchParams.set("pim_enter", code);
		return { status: 302, headers: { location: target.toString() } };
	}),
];

async function hosted(app: App, req: IncomingMessage, [owner, id, token]: [string, string, string, string?], path: string, search: string): Promise<Reply> {
	if (path === "" ) path = "/";
	await app.apps.authorizeHosted(owner, id, token);
	const body = ["GET", "HEAD"].includes(req.method ?? "GET") ? undefined : await readBody(req, 1_048_576);
	const r = await app.relay.appHttp(owner, id, toRequest(req, path + search, body, { "x-forwarded-prefix": `/hosted/${owner}/${id}/${token}` }));
	return toReply(r, { cookies: false, csp: true });
}

/**
 * A request to `<label>.<apps origin>`: an origin of its own for an app with a backend, so absolute addresses work and its cookies and storage are its
 * own. Who may open it is the app's access: `public` anyone; `circles` its owner and the people in the circles it is shared with, who sign in to Pim
 * first (`/hosted/enter`) and arrive with a one-minute code that is traded for an `HttpOnly` cookie good for twelve hours, checked on every request.
 */
export async function serveAppOrigin(app: App, req: IncomingMessage, url: URL, label: string, opts: { origin: string; appsOrigin?: string }): Promise<Reply> {
	const found = await app.apps.byLabel(label);
	if (!found) throw new NotFoundError();
	const secure = (opts.appsOrigin ?? "").startsWith("https:");
	const enter = url.searchParams.get("pim_enter");
	if (enter) {
		const value = await app.apps.exchangeEnter(label, enter);
		url.searchParams.delete("pim_enter");
		return { status: 302, headers: { location: url.pathname + url.search, "set-cookie": setCookie(APP_COOKIE, value, APP_COOKIE_S, secure, "Lax") } };
	}
	const visitor = await app.apps.cookieVisitor(label, readCookie(req, APP_COOKIE));
	if (!(await app.apps.mayOpen(found, visitor))) {
		if (visitor === null && found.access !== "public") return { status: 302, headers: { location: `${opts.origin}/hosted/enter?app=${encodeURIComponent(label)}` } };
		throw new NotFoundError();
	}
	const body = ["GET", "HEAD"].includes(req.method ?? "GET") ? undefined : await readBody(req, 1_048_576);
	const extra: Record<string, string> = { "x-forwarded-host": req.headers.host ?? "", "x-forwarded-proto": secure ? "https" : "http" };
	if (visitor) {
		const who = await app.identity.authz.account(visitor);
		const time = String(Date.now());
		extra["x-pim-user"] = who?.username ?? "";
		extra["x-pim-user-id"] = visitor;
		extra["x-pim-time"] = time;
		extra["x-pim-signature"] = createHmac("sha256", app.relay.appSecret(found.ownerId, found.id)).update(`${visitor}.${time}`).digest("base64url");
	}
	const r = await app.relay.appHttp(found.ownerId, found.id, toRequest(req, url.pathname + url.search, body, extra, true));
	return toReply(r, { cookies: true, csp: false });
}

