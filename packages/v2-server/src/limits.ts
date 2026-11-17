/**
 * What the Gate checks before a route answers, beyond what the route itself authorizes:
 *
 * - **Rate limits** (v1's three): `auth` 30 a minute per address for sign-in and registration writes (`/auth/*`, `/oauth/*`), `api` 600 a minute per owner for the API once
 *   signed in, and `public` 600 a minute per address for what anyone may open (shared chats, bot links, published and hosted apps). Counted in PostgreSQL (`RateLimits`), so
 *   every Gate process shares one count. A deployment sets its own with `PIM_RATE_AUTH`, `PIM_RATE_API` and `PIM_RATE_PUBLIC` (a number that cannot be read becomes 0,
 *   so a mistake never lifts a limit); 0 refuses everything. The address is the one the proxy sets (`x-pim-client-ip`) when the ingress secret is configured, else the socket's.
 * - **A guest's allow-list.** A guest joined through a bot's link and only chats with that bot: what its account may call is chats, files, goals, schedules and notifications
 *   of its own, its agent, its settings and its account. Anything else is 403 whatever the route.
 * - **A guest's daily messages**, which the bot's host set, counted when a message is admitted.
 */
import type { App } from "@pim/v2-app/app";
import { PimError } from "@pim/v2-app/errors";
import type { Ctx, Reply, Route } from "@pim/v2-app/http";
import { disabledBuiltins } from "./compat/admin-directory.ts";

type Env = Readonly<Record<string, string | undefined>>;
const WINDOW_MS = 60_000;
const limitOf = (raw: string | undefined, fallback: number) => (raw === undefined || raw.trim() === "" ? fallback : Number.isInteger(Number(raw)) && Number(raw) >= 0 ? Number(raw) : 0);

/** The caller's address, IPv6 reduced to its /64 so one host cannot spread across its own range. */
export function clientAddress(req: Ctx["req"], env: Env): string {
	const forwarded = env.PIM_INGRESS_SECRET ? req.headers["x-pim-client-ip"] : undefined;
	const raw = String(Array.isArray(forwarded) ? forwarded[0] : (forwarded ?? req.socket.remoteAddress ?? "unknown")).trim();
	const v4 = raw.replace(/^::ffff:/i, "");
	if (/^\d+\.\d+\.\d+\.\d+$/.test(v4)) return v4;
	if (raw.includes(":")) return raw.toLowerCase().split(":").slice(0, 4).join(":");
	return raw;
}

const GUEST_ALLOWED: { methods: string[] | "all"; path: RegExp }[] = [
	{ methods: ["GET"], path: /^\/api\/(usage|bot|majordomo|model|profile|extensions|app-directory|browser|ws|agents(\/[^/]+(\/icon)?)?|images\/[^/]+|account\/export|artifacts(\/.*)?|session|username)$/ },
	{ methods: ["GET", "DELETE"], path: /^\/api\/account$/ },
	{ methods: ["GET", "PUT"], path: /^\/api\/settings$/ },
	{ methods: ["POST"], path: /^\/api\/(prompts\/improve|app-actions\/.*|artifacts\/.*)$/ },
	{ methods: "all", path: /^\/api\/(sessions(\/.*)?|approvals(\/.*)?|files(\/.*)?|notifications(\/.*)?|push(\/.*)?|goals(\/.*)?|schedules(\/.*)?|snapshot\/.*|chats(\/.*)?|tasks(\/.*)?)$/ },
];
const guestMayCall = (method: string, path: string) => GUEST_ALLOWED.some((a) => (a.methods === "all" || a.methods.includes(method)) && a.path.test(path));

const PUBLIC = /^\/(api\/shared\/|api\/bots\/|p\/|hosted\/)/;

const tooMany = (message: string): Reply => ({ status: 429, headers: { "retry-after": "60" }, body: { error: "rate_limited", message } });

export function gateBefore(app: App, env: Env): (ctx: Ctx, route: Route) => Promise<Reply | undefined> {
	const auth = limitOf(env.PIM_RATE_AUTH, 30);
	const api = limitOf(env.PIM_RATE_API, 600);
	const publicLimit = limitOf(env.PIM_RATE_PUBLIC, 600);
	return async (ctx) => {
		const { req, url } = ctx;
		const method = req.method ?? "GET";
		const path = url.pathname;
		if ((path.startsWith("/auth/") || path.startsWith("/oauth/")) && method !== "GET" && method !== "OPTIONS") {
			return (await app.limits.hit("auth", clientAddress(req, env), auth, WINDOW_MS)) ? undefined : tooMany("Too many attempts. Wait a minute and try again.");
		}
		if (PUBLIC.test(path)) {
			return (await app.limits.hit("public", clientAddress(req, env), publicLimit, WINDOW_MS)) ? undefined : tooMany("Too many requests. Slow down a little.");
		}
		if (!path.startsWith("/api/")) return undefined;
		if (path.startsWith("/api/notes") && (await disabledBuiltins(app)).includes("notes")) return { status: 404, body: { error: "not_found", message: "Notes are turned off for everyone by this Pim's admin." } };
		const p = await ctx.maybePrincipal().catch(() => null);
		if (!p) return undefined;
		if ((p.kind === "user" || p.kind === "token") && p.role === "guest" && !guestMayCall(method, path)) {
			return { status: 403, body: { error: "guest", message: "A guest's account only chats with the bot it joined through." } };
		}
		// Snapshots are the web app's reads of what a person already has (it polls them), and they are scoped to the owner; the limit is for what writes and searches.
		if (path.startsWith("/api/snapshot/")) return undefined;
		return (await app.limits.hit("api", p.ownerId, api, WINDOW_MS)) ? undefined : tooMany("Too many requests. Slow down a little.");
	};
}

/** A bot's guest may send only the messages its bot allows a day: counted as each is admitted. */
export function limitGuestMessages(app: App): void {
	const admit = app.conversations.admit.bind(app.conversations);
	app.conversations.admit = async (p, input) => {
		if (input.kind === "user_message" && (p.kind === "user" || p.kind === "token") && p.role === "guest" && !(await app.guests.countMessage(p.ownerId))) {
			throw new PimError(429, "daily_limit", "You've used the messages this bot allows a day. They reset at midnight UTC.");
		}
		return admit(p, input);
	};
}
