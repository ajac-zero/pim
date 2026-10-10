import { getAgentByName } from "agents";
import { type AuthSite, currentSession, forgetSigningKey, fromAnotherSite } from "../auth";
import { base64UrlEncode } from "../auth/encoding";
import { type ApiExtension, type PimSite, servePim, withCors } from "../gateway";
import { HttpError } from "../http";
import { parseLimits } from "../usage";
import { type Account, type AccountStatus, type Directory, PENDING_MS, type RegistrationPolicy } from "./directory";
import { usernameProblem } from "./usernames";

export { Pim } from "../agent";
export { Auth } from "../auth";
export { Directory } from "./directory";

/**
 * Pimling: hosted Pims, one per person, each at `<username>.<PIMLING_DOMAIN>`.
 *
 * - The domain itself is the front door: registration, and the operator's
 *   admin API.
 * - `<username>.<domain>` is that person's Pim, exactly as a self-hosted one
 *   serves it (see ../gateway.ts), plus `/api/account`. The username picks
 *   which owner's credentials a request must carry; it authorizes nothing.
 *   Every owner has their own Pim and Auth Durable Objects, named after their
 *   owner ID, so one person's sessions, tokens, credentials and data are
 *   never in another's.
 *
 * Nothing here runs code that a person or their agent wrote.
 */

type HostedEnv = Env & {
	readonly Directory: DurableObjectNamespace<Directory>;
	readonly PIMLING_DOMAIN: string;
};

/** How long a Worker trusts what it read about an account. Suspensions reach the agent at once regardless. */
const ACCOUNT_CACHE_MS = 30_000;
const accounts = new Map<string, { account: Account | null; at: number }>();

const directory = (env: HostedEnv) => env.Directory.getByName("directory");

async function resolveAccount(env: HostedEnv, username: string): Promise<Account | null> {
	const cached = accounts.get(username);
	if (cached && Date.now() - cached.at < ACCOUNT_CACHE_MS) return cached.account;
	const account = await directory(env).resolve(username);
	if (accounts.size > 10_000) accounts.clear();
	accounts.set(username, { account, at: Date.now() });
	return account;
}

const forget = (username: string) => accounts.delete(username);

function log(event: string, fields: Record<string, unknown>): void {
	console.log(JSON.stringify({ event: `pimling.${event}`, ...fields }));
}

const json = (body: unknown, status = 200, headers?: HeadersInit) => Response.json(body, { status, headers });
const fail = (status: number, error: string) => json({ error }, status);

/** The client's address, as Cloudflare reports it. */
const clientIp = (request: Request) => request.headers.get("CF-Connecting-IP") ?? "unknown";

/** A rate limit, if the deployment binds one; `key` is what it counts by. */
async function limited(limiter: RateLimit | undefined, key: string): Promise<boolean> {
	if (!limiter) return false;
	return !(await limiter.limit({ key })).success;
}

function integerVar(value: string | undefined, fallback: number | null): number | null {
	if (value === undefined || value.trim() === "") return fallback;
	const parsed = Number(value);
	return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : fallback;
}

function registrationPolicy(env: Env): RegistrationPolicy {
	const mode = env.PIMLING_REGISTRATION === "open" || env.PIMLING_REGISTRATION === "closed" ? env.PIMLING_REGISTRATION : "invite";
	return {
		mode,
		maxAccounts: integerVar(env.PIMLING_MAX_ACCOUNTS, null),
		perAddressPerDay: integerVar(env.PIMLING_REGISTRATIONS_PER_ADDRESS, 3) ?? 3,
	};
}

/** `https://alice.pimling.com`, from the front door's own URL, so local development keeps its scheme and port. */
function pimUrl(request: Request, env: HostedEnv, username: string): string {
	const url = new URL(request.url);
	return `${url.protocol}//${username}.${env.PIMLING_DOMAIN}${url.port ? `:${url.port}` : ""}`;
}

const agentOf = (env: HostedEnv, ownerId: string) => getAgentByName(env.Pim, ownerId);
const authOf = (env: HostedEnv, ownerId: string) => env.Auth.getByName(ownerId);

/** One person's Pim, as the gateway serves it. */
function siteFor(env: HostedEnv, account: Account): PimSite {
	return {
		owner: account.ownerId,
		agent: account.ownerId,
		store: authOf(env, account.ownerId),
		mode: "hosted",
		user: {
			id: base64UrlEncode(new TextEncoder().encode(account.ownerId)),
			name: account.username,
			displayName: `${account.username} (Pimling)`,
		},
		account: { username: account.username },
		onPasskeyCreated: async () => {
			if (account.status !== "pending") return;
			await directory(env).activate(account.ownerId);
			forget(account.username);
			log("activated", { owner: account.ownerId, username: account.username });
		},
	};
}

/**
 * Deletes an account: the username stops working first, then the agent and
 * its sign-in are wiped. Safe to run again on an account already deleted, to
 * finish a deletion that was interrupted.
 */
async function deleteAccount(env: HostedEnv, account: Account, by: string): Promise<void> {
	await directory(env).markDeleted(account.ownerId, by);
	forget(account.username);
	try {
		await (await agentOf(env, account.ownerId)).deleteEverything();
	} catch (error) {
		// Destroying an agent ends its isolate, which can cut off the call that asked; its storage is already gone.
		console.warn(JSON.stringify({ event: "pimling.delete_agent_ended", owner: account.ownerId, error: String(error) }));
	}
	await authOf(env, account.ownerId).deleteEverything();
	forgetSigningKey(account.ownerId);
	log("deleted", { owner: account.ownerId, username: account.username, by });
}

/** `/api/account`: the person's account, answered here because the agent doesn't know about accounts. */
function accountApi(env: HostedEnv, account: Account, site: AuthSite, request: Request): ApiExtension {
	return async (path) => {
		if (path !== "/account" && !path.startsWith("/account/")) return undefined;
		const route = `${request.method} ${path}`;
		if (route === "GET /account") {
			const agent = await agentOf(env, account.ownerId);
			const [usage, recoveryCodesLeft] = await Promise.all([agent.usageReport(), site.store.recoveryCodesLeft()]);
			return json({
				username: account.username,
				ownerId: account.ownerId,
				status: account.status,
				createdAt: account.createdAt,
				url: pimUrl(request, env, account.username),
				usage,
				recoveryCodesLeft,
			});
		}
		if (route === "GET /account/export") {
			const agent = await agentOf(env, account.ownerId);
			const [data, passkeys, tokens] = await Promise.all([agent.exportData(), site.store.passkeys(), site.store.tokens()]);
			log("exported", { owner: account.ownerId });
			const body = JSON.stringify(
				{ account: { username: account.username, ownerId: account.ownerId, createdAt: account.createdAt }, passkeys, tokens, pim: JSON.parse(data) },
				null,
				2,
			);
			return new Response(body, {
				headers: {
					"content-type": "application/json",
					"content-disposition": `attachment; filename="pimling-${account.username}-${new Date().toISOString().slice(0, 10)}.json"`,
				},
			});
		}
		if (route === "DELETE /account") {
			// An API token can do a lot, but not this: deleting takes the person, signed in with a passkey.
			if (!(await currentSession(request, site))) return fail(403, "Deleting your account needs you signed in with a passkey.");
			const body = (await request.json().catch(() => null)) as { confirm?: unknown } | null;
			if (body?.confirm !== account.username) return fail(400, `To delete your account, send { "confirm": "${account.username}" }.`);
			await deleteAccount(env, account, "owner");
			return json({ deleted: true }, 200, { "set-cookie": "__Host-pim-session=; Path=/; Secure; HttpOnly; SameSite=Strict; Max-Age=0" });
		}
		return fail(404, "Not found");
	};
}

/** `<username>.<domain>`: one person's Pim. */
async function servePerson(request: Request, env: HostedEnv, username: string): Promise<Response> {
	const { pathname } = new URL(request.url);
	const account = usernameProblem(username) === null ? await resolveAccount(env, username) : null;
	const forApi = pathname.startsWith("/api") || pathname.startsWith("/auth") || pathname.startsWith("/mcp/");
	if (!account || account.status === "deleted") {
		const status = account ? 410 : 404;
		const message = account ? "This Pimling was deleted." : "There's no Pimling here.";
		if (forApi) return withCors(fail(status, message));
		return new Response(`<!doctype html><meta name="viewport" content="width=device-width"><title>Pimling</title><p>${message}</p>`, {
			status,
			headers: { "content-type": "text/html; charset=utf-8" },
		});
	}
	if (account.status === "suspended") return withCors(fail(403, "This Pimling is suspended."));

	// Guessing at passkeys, recovery codes and tokens is slowed down per address; heavy use, per owner.
	if (pathname.startsWith("/auth/") && request.method !== "GET" && (await limited(env.AUTH_LIMITER, `${clientIp(request)}`))) {
		log("rate_limited", { limit: "auth", owner: account.ownerId });
		return fail(429, "Too many attempts. Wait a minute and try again.");
	}
	if (pathname.startsWith("/api/") && (await limited(env.API_LIMITER, account.ownerId))) {
		log("rate_limited", { limit: "api", owner: account.ownerId });
		return withCors(fail(429, "Too many requests. Slow down a little."));
	}
	const site = siteFor(env, account);
	return servePim(request, env, site, accountApi(env, account, site, request));
}

/** The domain itself: registration. */
async function register(request: Request, env: HostedEnv): Promise<Response> {
	if (fromAnotherSite(request)) return fail(403, "Requests must come from this site");
	if (await limited(env.AUTH_LIMITER, clientIp(request))) return fail(429, "Too many attempts. Wait a minute and try again.");
	const body = (await request.json().catch(() => null)) as { username?: unknown; invite?: unknown; timeZone?: unknown } | null;
	const username = typeof body?.username === "string" ? body.username.trim().toLowerCase() : "";
	const problem = usernameProblem(username);
	if (problem) return fail(400, problem);
	const policy = registrationPolicy(env);
	const result = await directory(env).register({
		username,
		ip: clientIp(request),
		policy,
		...(typeof body?.invite === "string" ? { invite: body.invite } : {}),
	});
	if (!result.ok) {
		log("registration_refused", { username, status: result.status, error: result.error });
		return fail(result.status, result.error);
	}
	const { account, released } = result;
	forget(username);
	if (released) {
		// A registration nobody finished: its sign-in can go. Its agent never ran.
		await authOf(env, released).deleteEverything();
		forgetSigningKey(released);
	}
	const now = Date.now();
	const url = pimUrl(request, env, username);
	const auth = authOf(env, account.ownerId);
	let setup: { code: string; expiresAt: number };
	let recoveryCodes: string[];
	try {
		[setup, recoveryCodes] = await Promise.all([auth.issueSetupCode(now, PENDING_MS), auth.newRecoveryCodes(now)]);
		const agent = await agentOf(env, account.ownerId);
		await agent.provision({ ownerId: account.ownerId, username, publicUrl: url });
		if (typeof body?.timeZone === "string") {
			// The browser's zone, a good first guess; a bad one is just not applied.
			await agent.applySettings({ timeZone: body.timeZone }).catch(() => undefined);
		}
	} catch (error) {
		// Half a registration helps nobody: give the username back now, not in a day.
		await directory(env).abandon(account.ownerId);
		forget(username);
		await auth.deleteEverything().catch(() => undefined);
		console.error(JSON.stringify({ event: "pimling.registration_failed", owner: account.ownerId, username, error: String(error) }));
		return fail(500, "Your Pimling couldn't be set up. Try again in a moment.");
	}
	const { code, expiresAt } = setup;
	log("registered", { owner: account.ownerId, username, mode: policy.mode });
	return json(
		{
			username,
			url,
			// Opening it creates the first passkey; it works once, for a day.
			setupUrl: `${url}/#setup=${code}`,
			setupExpiresAt: new Date(expiresAt).toISOString(),
			recoveryCodes,
		},
		201,
	);
}

/** The operator's API, with `PIMLING_ADMIN_TOKEN`. Off when no token is set. */
async function admin(request: Request, env: HostedEnv, path: string): Promise<Response> {
	const expected = env.PIMLING_ADMIN_TOKEN;
	if (!expected) return fail(404, "Not found");
	const given = request.headers.get("Authorization")?.replace(/^Bearer /, "") ?? "";
	const digest = (text: string) => crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
	if (!crypto.subtle.timingSafeEqual(await digest(given), await digest(expected))) {
		log("admin_refused", { path });
		return fail(401, "Unauthorized");
	}
	const url = new URL(request.url);
	const route = `${request.method} ${path}`;
	const dir = directory(env);
	try {
		if (route === "GET /stats") return json(await dir.stats());
		if (route === "GET /accounts") {
			const status = url.searchParams.get("status") as AccountStatus | null;
			return json({
				accounts: await dir.list({
					...(status ? { status } : {}),
					...(url.searchParams.get("after") ? { after: url.searchParams.get("after")! } : {}),
					limit: Number(url.searchParams.get("limit")) || 100,
				}),
			});
		}
		if (route === "POST /invites") {
			const body = (await request.json().catch(() => ({}))) as { count?: unknown; note?: unknown };
			const count = typeof body.count === "number" && Number.isInteger(body.count) && body.count > 0 && body.count <= 100 ? body.count : 1;
			const codes = await dir.createInvites(count, typeof body.note === "string" ? body.note : null);
			log("invites_created", { count });
			return json({ codes }, 201);
		}
		const match = /^\/accounts\/([^/]+)(\/[a-z-]+)?$/.exec(path);
		if (!match) return fail(404, "Not found");
		const username = decodeURIComponent(match[1]!);
		const action = match[2] ?? "";
		const account = await dir.resolve(username);
		if (!account) return fail(404, `No account ${username}`);
		const agent = () => agentOf(env, account.ownerId);
		const body = async () => ((await request.json().catch(() => ({}))) ?? {}) as Record<string, unknown>;

		if (route === `GET /accounts/${match[1]}`) {
			const usage = account.status === "deleted" ? null : await (await agent()).usageReport();
			return json({ account, usage });
		}
		if (route === `POST /accounts/${match[1]}/suspend` || route === `POST /accounts/${match[1]}/unsuspend`) {
			if (account.status === "deleted" || account.status === "pending") return fail(409, `${username} is ${account.status}`);
			const status = action === "/suspend" ? "suspended" : "active";
			const reason = (await body()).reason;
			const updated = await dir.setStatus(account.ownerId, status, typeof reason === "string" ? reason : null);
			// The agent stops at once, whatever other Workers still have cached.
			await (await agent()).setStatus(status);
			forget(username);
			log(status === "suspended" ? "suspended" : "unsuspended", { owner: account.ownerId, username, reason });
			return json({ account: updated });
		}
		if (route === `PUT /accounts/${match[1]}/limits`) {
			const { limits } = await body();
			const parsed = limits === null ? null : parseLimits(limits);
			const applied = await (await agent()).setLimits(parsed);
			log("limits_changed", { owner: account.ownerId, username, limits: parsed });
			return json({ limits: applied });
		}
		if (route === `POST /accounts/${match[1]}/setup-link`) {
			// For someone who lost every passkey and recovery code, after the operator checked who they are.
			if (account.status === "deleted") return fail(409, `${username} is deleted`);
			const { code, expiresAt } = await authOf(env, account.ownerId).issueSetupCode(Date.now(), 60 * 60 * 1000);
			log("setup_link_issued", { owner: account.ownerId, username });
			return json({ setupUrl: `${pimUrl(request, env, username)}/#setup=${code}`, expiresAt: new Date(expiresAt).toISOString() });
		}
		if (route === `DELETE /accounts/${match[1]}`) {
			const reason = (await body()).reason;
			await deleteAccount(env, account, typeof reason === "string" ? `operator: ${reason}` : "operator");
			return json({ deleted: true });
		}
		return fail(404, "Not found");
	} catch (error) {
		if (error instanceof HttpError) return fail(error.status, error.message);
		throw error;
	}
}

async function serveFrontDoor(request: Request, env: HostedEnv): Promise<Response> {
	const url = new URL(request.url);
	const route = `${request.method} ${url.pathname}`;
	if (url.pathname === "/health") return json({ name: "pimling", ok: true });
	if (url.pathname.startsWith("/admin/")) return admin(request, env, url.pathname.slice("/admin".length));
	if (route === "GET /auth/session") {
		// The web app shows registration here instead of a Pim.
		return json({ site: "accounts", domain: env.PIMLING_DOMAIN, registration: registrationPolicy(env).mode });
	}
	if (route === "GET /auth/username") {
		const name = (url.searchParams.get("name") ?? "").trim().toLowerCase();
		const problem = usernameProblem(name);
		if (problem) return json({ available: false, reason: problem });
		const taken = (await directory(env).resolve(name)) !== null;
		return json(taken ? { available: false, reason: "That username is taken." } : { available: true });
	}
	if (route === "POST /auth/register") return register(request, env);
	if (url.pathname.startsWith("/auth/") || url.pathname.startsWith("/api/")) return fail(404, "Not found");
	return env.ASSETS.fetch(request);
}

export default {
	async fetch(request, env): Promise<Response> {
		const hosted = env as HostedEnv;
		if (!hosted.PIMLING_DOMAIN || !hosted.Directory) return fail(500, "PIMLING_DOMAIN and the Directory binding must be configured");
		// Deployment-wide, it would send every person's notifications to one address.
		if (env.PIM_NOTIFY_WEBHOOK) return fail(500, "PIM_NOTIFY_WEBHOOK must not be set for Pimling: each person sets their own in Settings");
		const host = new URL(request.url).hostname.toLowerCase();
		const domain = hosted.PIMLING_DOMAIN.toLowerCase();
		if (host === domain || host === `www.${domain}`) return serveFrontDoor(request, hosted);
		if (host.endsWith(`.${domain}`)) {
			const label = host.slice(0, -(domain.length + 1));
			// One label only: nothing is served at deeper names.
			if (!label.includes(".")) return servePerson(request, hosted, label);
		}
		return fail(404, "Unknown host");
	},
} satisfies ExportedHandler<Env>;
