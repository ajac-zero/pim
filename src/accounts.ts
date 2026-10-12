import { getAgentByName } from "agents";
import { type AuthSite, clearCookie, fromAnotherSite, ownedCode, SESSION_COOKIE, type Sites, userHandle } from "./auth";
import type { ApiExtension } from "./gateway";
import { HttpError } from "./http";
import { parseLimits, UNLIMITED } from "./usage";
import { type Account, type AccountStatus, type CleanupResult, PENDING_MS, type RegistrationPolicy } from "./directory";
import { usernameProblem } from "./usernames";

/**
 * The people on a Pim: registering and claiming, finding someone's
 * sign-in, their account, what they share with each other, and the admin's
 * view of everyone. ./gateway.ts decides whose request it is and calls in
 * here; ./directory.ts keeps the accounts.
 *
 * Every person has their own Pim and Auth Durable Objects, named after their
 * owner ID, so one person's sessions, tokens, credentials and data are never
 * in another's.
 */

/** How long a Worker trusts what it read about an account. Suspensions reach the agent at once regardless. */
const ACCOUNT_CACHE_MS = 30_000;
const accounts = new Map<string, { account: Account | null; at: number }>();

/** How long after a deploy a Pim with no admin lets whoever opens it become the admin. */
export const CLAIM_WINDOW_MS = 15 * 60 * 1000;

const directory = (env: Env) => env.Directory.getByName("directory");
const gallery = (env: Env) => env.Gallery.getByName("gallery");
const agentOf = (env: Env, ownerId: string) => getAgentByName(env.Pim, ownerId);
const authOf = (env: Env, ownerId: string) => env.Auth.getByName(ownerId);

/** An owner's account, cached for a moment. */
export async function resolveAccount(env: Env, ownerId: string): Promise<Account | null> {
	const cached = accounts.get(ownerId);
	if (cached && Date.now() - cached.at < ACCOUNT_CACHE_MS) return cached.account;
	const account = await directory(env).account(ownerId);
	if (accounts.size > 10_000) accounts.clear();
	accounts.set(ownerId, { account, at: Date.now() });
	return account;
}

const forget = (ownerId: string) => accounts.delete(ownerId);

function log(event: string, fields: Record<string, unknown>): void {
	console.log(JSON.stringify({ event: `pim.${event}`, ...fields }));
}

const json = (body: unknown, status = 200, headers?: HeadersInit) => Response.json(body, { status, headers });
const fail = (status: number, error: string) => json({ error }, status);

/** The client's address, as Cloudflare reports it. */
export const clientIp = (request: Request) => request.headers.get("CF-Connecting-IP") ?? "unknown";

/** A rate limit, if the deployment binds one; `key` is what it counts by. */
export async function limited(limiter: RateLimit | undefined, key: string): Promise<boolean> {
	if (!limiter) return false;
	return !(await limiter.limit({ key })).success;
}

function integerVar(value: string | undefined, fallback: number | null): number | null {
	if (value === undefined || value.trim() === "") return fallback;
	const parsed = Number(value);
	return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : fallback;
}

function registrationPolicy(env: Env): RegistrationPolicy {
	const given: string = env.PIM_REGISTRATION;
	const mode = given === "open" || given === "closed" ? given : "invite";
	return {
		mode,
		maxAccounts: integerVar(env.PIM_MAX_ACCOUNTS, null),
		perAddressPerDay: integerVar(env.PIM_REGISTRATIONS_PER_ADDRESS, 3) ?? 3,
	};
}

/** Whether this version of the Worker was deployed less than `CLAIM_WINDOW_MS` ago. */
function claimWindowOpen(env: Env, now: number): boolean {
	const deployed = Date.parse(env.CF_VERSION_METADATA?.timestamp ?? "");
	return now >= deployed && now < deployed + CLAIM_WINDOW_MS;
}

/** This Pim's address: `PIM_PUBLIC_URL`, or the one the request came to. */
const origin = (request: Request, env: Env) => (env.PIM_PUBLIC_URL ? new URL(env.PIM_PUBLIC_URL).origin : new URL(request.url).origin);

/** A person's sign-in, as ./auth uses it. */
export function siteFor(env: Env, account: Account): AuthSite {
	return {
		owner: account.ownerId,
		store: authOf(env, account.ownerId),
		status: account.status === "pending" || account.status === "suspended" ? account.status : "active",
		user: { id: userHandle(account.ownerId), name: account.username, displayName: account.username },
		account: { username: account.username, role: account.role },
		onPasskeyCreated: async () => {
			if (account.status !== "pending") return;
			await directory(env).activate(account.ownerId);
			forget(account.ownerId);
			log("activated", { owner: account.ownerId, username: account.username, role: account.role });
		},
	};
}

/** Accounts that can still sign in or be set up; deleted ones have no sign-in. */
const live = (account: Account | null): account is Account =>
	account !== null && (account.status === "pending" || account.status === "active" || account.status === "suspended");

export function sites(env: Env): Sites {
	return {
		async byOwner(owner) {
			const account = await resolveAccount(env, owner);
			return live(account) ? siteFor(env, account) : null;
		},
		async byUsername(username) {
			const account = usernameProblem(username) === null ? await directory(env).resolve(username) : null;
			return live(account) ? siteFor(env, account) : null;
		},
		async signedOut() {
			const claimed = (await directory(env).admin()) !== null;
			return { claimed, canClaim: !claimed && claimWindowOpen(env, Date.now()), registration: registrationPolicy(env).mode };
		},
	};
}

/**
 * Deletes an account: it stops opening anything at once, then the Directory
 * erases the agent and its sign-in, now if it can and on its alarm until it
 * has. Done only once both were checked empty. Safe to run again, to retry a
 * deletion that hasn't finished.
 */
async function deleteAccount(env: Env, account: Account, by: string): Promise<CleanupResult> {
	const dir = directory(env);
	await dir.requestDeletion(account.ownerId, by);
	forget(account.ownerId);
	return dir.runCleanup(account.ownerId);
}

/** What a deletion's caller is told: erased, or closed and still being erased. */
function deletionResponse(result: CleanupResult, headers?: HeadersInit): Response {
	if (result.done) return json({ deleted: true }, 200, headers);
	return json(
		{
			deleted: false,
			status: "deleting",
			message: "The account is closed and can't be used. Erasing its data didn't finish yet; it is retried automatically.",
			nextAttemptAt: new Date(result.nextAttemptAt).toISOString(),
		},
		202,
		headers,
	);
}

/**
 * `/auth/register`, `/auth/username` and `/auth/setup-link`: joining the Pim,
 * claiming one that has no admin, and the setup link the Worker writes to its
 * logs. Anything else under `/auth` is ./auth's. The gateway slows down
 * attempts from one address before either.
 */
export async function handleRegistration(request: Request, env: Env, now = Date.now()): Promise<Response | undefined> {
	const url = new URL(request.url);
	const route = `${request.method} ${url.pathname}`;

	if (route === "GET /auth/username") {
		const name = (url.searchParams.get("name") ?? "").trim().toLowerCase();
		const problem = usernameProblem(name);
		if (problem) return json({ available: false, reason: problem });
		const taken = (await directory(env).resolve(name)) !== null;
		return json(taken ? { available: false, reason: "That username is taken." } : { available: true });
	}

	if (route === "POST /auth/setup-link") {
		if (fromAnotherSite(request)) return fail(403, "Requests must come from this app");
		// Anyone may ask; only someone signed in to the Cloudflare account can read the logs it lands in.
		const dir = directory(env);
		const admin = await dir.admin(now);
		if (!admin) {
			const { code, expiresAt } = await dir.claimCode(now);
			const until = new Date(expiresAt).toISOString();
			console.log(`Pim setup link. Open it to set this Pim up and become its admin; it works once, until ${until}: ${origin(request, env)}/#claim=${code}`);
			return json({ expiresAt: until });
		}
		const { code, expiresAt } = await authOf(env, admin.ownerId).setupCode(now);
		const until = new Date(expiresAt).toISOString();
		console.log(
			`Pim setup link for ${admin.username}, the admin. Open it to add a passkey; it works once, until ${until}: ${origin(request, env)}/#setup=${ownedCode(admin.ownerId, code)}`,
		);
		return json({ expiresAt: until });
	}

	if (route === "POST /auth/register") return register(request, env, now);
	return undefined;
}

/** Makes an account, and hands back its setup code, to make its first passkey with, and its recovery codes. */
async function register(request: Request, env: Env, now: number): Promise<Response> {
	if (fromAnotherSite(request)) return fail(403, "Requests must come from this app");
	const body = (await request.json().catch(() => null)) as { username?: unknown; invite?: unknown; claim?: unknown; timeZone?: unknown } | null;
	const username = typeof body?.username === "string" ? body.username.trim().toLowerCase() : "";
	const problem = usernameProblem(username);
	if (problem) return fail(400, problem);
	const policy = registrationPolicy(env);
	const dir = directory(env);
	const result = await dir.register({
		username,
		ip: clientIp(request),
		policy,
		claim: { window: claimWindowOpen(env, now), ...(typeof body?.claim === "string" ? { code: body.claim } : {}) },
		...(typeof body?.invite === "string" ? { invite: body.invite } : {}),
		now,
	});
	if (!result.ok) {
		log("registration_refused", { username, status: result.status, error: result.error });
		return fail(result.status, result.error);
	}
	const { account } = result;
	forget(account.ownerId);
	const auth = authOf(env, account.ownerId);
	let setup: { code: string; expiresAt: number };
	let recoveryCodes: string[];
	try {
		[setup, recoveryCodes] = await Promise.all([auth.issueSetupCode(now, PENDING_MS), auth.newRecoveryCodes(now)]);
		const agent = await agentOf(env, account.ownerId);
		await agent.provision({ ownerId: account.ownerId, username, publicUrl: origin(request, env) });
		// The deployment's limits are for members: the admin pays for the deployment.
		if (account.role === "admin") await agent.setLimits(UNLIMITED);
		// Everyone starts with a copy of the Pim the admin chose, or a plain one when they chose none.
		const everyone = await gallery(env).defaultPim();
		if (everyone) {
			const { author, name, description, instructions, apps, team, base } = everyone;
			await agent.adoptDefaultPim({ author, name, description, instructions, apps, team, base });
		}
		if (typeof body?.timeZone === "string") {
			// The browser's zone, a good first guess; a bad one is just not applied.
			await agent.applySettings({ timeZone: body.timeZone }).catch(() => undefined);
		}
	} catch (error) {
		// Half a registration helps nobody: give the username and invite back now, not in a day. The Directory erases what was made.
		await dir.abandon(account.ownerId);
		forget(account.ownerId);
		console.error(JSON.stringify({ event: "pim.registration_failed", owner: account.ownerId, username, error: String(error) }));
		return fail(500, "Your account couldn't be set up. Try again in a moment.");
	}
	log("registered", { owner: account.ownerId, username, role: account.role, mode: policy.mode });
	return json(
		{
			username,
			role: account.role,
			// Makes the first passkey; it works once, for a day.
			setup: ownedCode(account.ownerId, setup.code),
			setupExpiresAt: new Date(setup.expiresAt).toISOString(),
			recoveryCodes,
		},
		201,
	);
}

/** `/api/account`: the person's account, answered here because the agent doesn't know about accounts. */
export function accountApi(env: Env, account: Account, site: AuthSite, request: Request, viaSession: boolean): ApiExtension {
	return async (path) => {
		if (path !== "/account" && !path.startsWith("/account/")) return undefined;
		const route = `${request.method} ${path}`;
		if (route === "GET /account") {
			const agent = await agentOf(env, account.ownerId);
			const [usage, recoveryCodesLeft] = await Promise.all([agent.usageReport(), site.store.recoveryCodesLeft()]);
			return json({
				username: account.username,
				ownerId: account.ownerId,
				role: account.role,
				status: account.status,
				createdAt: account.createdAt,
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
					"content-disposition": `attachment; filename="pim-${account.username}-${new Date().toISOString().slice(0, 10)}.json"`,
				},
			});
		}
		if (route === "DELETE /account") {
			// An API token can do a lot, but not this: deleting takes the person, signed in with a passkey.
			if (!viaSession) return fail(403, "Deleting your account needs you signed in with a passkey.");
			const body = (await request.json().catch(() => null)) as { confirm?: unknown } | null;
			if (body?.confirm !== account.username) return fail(400, `To delete your account, send { "confirm": "${account.username}" }.`);
			const result = await deleteAccount(env, account, "owner");
			return deletionResponse(result, { "set-cookie": clearCookie(SESSION_COOKIE) });
		}
		return fail(404, "Not found");
	};
}

/** An error a Durable Object threw across RPC, as the API answers it: its message, with the status its words imply. */
function rpcFailure(error: unknown): Response {
	const message = error instanceof Error ? error.message : String(error);
	const status = /^No (circle|Pim|template)/.test(message) ? 404 : /up to \d+/.test(message) ? 429 : 400;
	return fail(status, message);
}

/**
 * The parts of a person's API that need the whole instance, answered here:
 * adding someone to a circle by username (only the Directory knows whose
 * Pim a username is), their profile, other people's, and the gallery of
 * published Pims. Everything else is their own Pim's.
 */
export function socialApi(env: Env, account: Account, request: Request): ApiExtension {
	return async (path) => {
		const route = `${request.method} ${path}`;
		const body = async () => ((await request.json().catch(() => null)) ?? {}) as Record<string, unknown>;
		const agent = () => agentOf(env, account.ownerId);
		const someone = async (username: string) => {
			const found = usernameProblem(username) === null ? await directory(env).resolve(username) : null;
			return found?.status === "active" ? found : null;
		};
		try {
			const member = /^\/circles\/([^/]+)\/members$/.exec(path);
			if (member && request.method === "POST") {
				const given = (await body()).username;
				const username = typeof given === "string" ? given.trim().toLowerCase().replace(/^@/, "") : "";
				const guest = await someone(username);
				if (!guest) return fail(404, `There's nobody called ${username || "that"} on this Pim.`);
				if (guest.ownerId === account.ownerId) return fail(400, "You can't add yourself to a circle.");
				const added = await (await agent()).addCircleMember(decodeURIComponent(member[1]!), { ownerId: guest.ownerId, username: guest.username });
				log("circle_member_added", { owner: account.ownerId, member: guest.ownerId });
				return json(added, 201);
			}

			if (route === "GET /profile") return json(await gallery(env).profile(account.username));
			if (route === "PUT /profile") return json(await gallery(env).setProfile(account.ownerId, account.username, await body()));

			const person = /^\/people\/([^/]+)$/.exec(path);
			if (person && request.method === "GET") {
				const username = decodeURIComponent(person[1]!).toLowerCase();
				if (!(await someone(username))) return fail(404, `There's nobody called ${username} on this Pim.`);
				const [profile, templates] = await Promise.all([gallery(env).profile(username), gallery(env).templates({ author: username })]);
				return json({ ...profile, templates });
			}

			if (route === "GET /templates") {
				const url = new URL(request.url);
				return json({ templates: await gallery(env).templates({ query: url.searchParams.get("q") ?? undefined }) });
			}
			const template = /^\/templates\/([^/]+)(\/use)?$/.exec(path);
			if (template) {
				const found = await gallery(env).template(decodeURIComponent(template[1]!));
				if (!found) return fail(404, "No such template. It may have been unpublished.");
				if (!template[2] && request.method === "GET") return json(found);
				if (template[2] && request.method === "POST") {
					const persona = await (await agent()).adoptTemplate(found);
					if (found.author !== account.username) await gallery(env).used(found.id);
					log("template_used", { owner: account.ownerId, template: found.id });
					return json(persona, 201);
				}
				return undefined;
			}

			const publish = /^\/personas\/([^/]+)\/publish$/.exec(path);
			if (publish) {
				const id = decodeURIComponent(publish[1]!);
				const persona = await (await agent()).personaToPublish(id);
				if (!persona) return fail(404, `No Pim ${id}`);
				if (request.method === "POST") {
					const published = await gallery(env).publish(account.ownerId, account.username, persona);
					await (await agent()).setPersonaPublished(id, published.id);
					log("template_published", { owner: account.ownerId, template: published.id });
					return json(published, 201);
				}
				if (request.method === "DELETE") {
					await gallery(env).unpublish(account.ownerId, id);
					await (await agent()).setPersonaPublished(id, null);
					return json({ deleted: true });
				}
				return undefined;
			}
			// A deleted Pim leaves the gallery too; the agent deletes it after.
			const deleted = /^\/personas\/([^/]+)$/.exec(path);
			if (deleted && request.method === "DELETE") await gallery(env).unpublish(account.ownerId, decodeURIComponent(deleted[1]!));
		} catch (error) {
			return rpcFailure(error);
		}
		return undefined;
	};
}

/**
 * `/api/admin/*`: the admin's view of everyone, with a passkey session only.
 * An API token can't run the instance.
 */
export function adminApi(env: Env, admin: Account, request: Request, viaSession: boolean): ApiExtension {
	return async (path) => {
		if (path !== "/admin" && !path.startsWith("/admin/")) return undefined;
		if (admin.role !== "admin") return fail(403, "Only the admin can do that.");
		if (!viaSession) return fail(403, "Running this Pim needs you signed in with a passkey.");
		const url = new URL(request.url);
		const route = `${request.method} ${path.slice("/admin".length)}`;
		const dir = directory(env);
		const body = async () => ((await request.json().catch(() => ({}))) ?? {}) as Record<string, unknown>;
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
			if (route === "GET /default-pim") return json({ pim: await gallery(env).defaultPim() });
			if (route === "PUT /default-pim") {
				const id = (await body()).pim;
				if (typeof id !== "string") return fail(400, "pim must be the id of one of your Pims");
				const persona = await (await agentOf(env, admin.ownerId)).personaToPublish(id);
				if (!persona) return fail(404, `No Pim ${id}`);
				const chosen = await gallery(env).setDefaultPim(admin.ownerId, admin.username, persona);
				log("default_pim_set", { by: admin.ownerId, pim: id });
				return json({ pim: chosen });
			}
			if (route === "DELETE /default-pim") {
				await gallery(env).clearDefaultPim();
				log("default_pim_set", { by: admin.ownerId, pim: null });
				return json({ pim: null });
			}
			const template = /^\/admin\/templates\/([^/]+)$/.exec(path);
			if (template && request.method === "DELETE") {
				const removed = await gallery(env).remove(decodeURIComponent(template[1]!));
				if (!removed) return fail(404, "No such template");
				log("template_removed", { template: template[1], by: admin.ownerId });
				return json({ deleted: true });
			}
			if (route === "POST /invites") {
				const given = await body();
				const count = typeof given.count === "number" && Number.isInteger(given.count) && given.count > 0 && given.count <= 100 ? given.count : 1;
				const codes = await dir.createInvites(count, typeof given.note === "string" ? given.note.slice(0, 200) : null);
				log("invites_created", { count, by: admin.ownerId });
				const base = origin(request, env);
				return json({ codes, links: codes.map((code) => `${base}/#invite=${code}`) }, 201);
			}
			const match = /^\/admin\/accounts\/([^/]+)(\/[a-z-]+)?$/.exec(path);
			if (!match) return fail(404, "Not found");
			const username = decodeURIComponent(match[1]!);
			const action = match[2] ?? "";
			const account = await dir.resolve(username);
			if (!account) return fail(404, `No account ${username}`);
			const agent = () => agentOf(env, account.ownerId);
			const gone = account.status === "deleted" || account.status === "deleting";
			const self = account.ownerId === admin.ownerId;

			if (request.method === "GET" && action === "") {
				const usage = gone ? null : await (await agent()).usageReport();
				return json({ account, usage, cleanup: await dir.cleanup(account.ownerId) });
			}
			if (request.method === "POST" && (action === "/suspend" || action === "/unsuspend")) {
				if (self) return fail(409, "You can't suspend yourself.");
				if (account.status !== "active" && account.status !== "suspended") return fail(409, `${username} is ${account.status}`);
				const status = action === "/suspend" ? "suspended" : "active";
				const reason = (await body()).reason;
				const updated = await dir.setStatus(account.ownerId, status, typeof reason === "string" ? reason : null);
				// The agent stops at once, whatever other Workers still have cached.
				await (await agent()).setStatus(status);
				forget(account.ownerId);
				log(status === "suspended" ? "suspended" : "unsuspended", { owner: account.ownerId, username, reason, by: admin.ownerId });
				return json({ account: updated });
			}
			if (request.method === "PUT" && action === "/limits") {
				if (gone) return fail(409, `${username} is ${account.status}`);
				const { limits } = await body();
				const parsed = limits === null ? null : parseLimits(limits);
				const applied = await (await agent()).setLimits(parsed);
				log("limits_changed", { owner: account.ownerId, username, limits: parsed, by: admin.ownerId });
				return json({ limits: applied });
			}
			if (request.method === "POST" && action === "/setup-link") {
				// For someone who lost every passkey and recovery code, after the admin checked who they are.
				if (gone) return fail(409, `${username} is ${account.status}`);
				const { code, expiresAt } = await authOf(env, account.ownerId).issueSetupCode(Date.now(), 60 * 60 * 1000);
				log("setup_link_issued", { owner: account.ownerId, username, by: admin.ownerId });
				return json({ setupUrl: `${origin(request, env)}/#setup=${ownedCode(account.ownerId, code)}`, expiresAt: new Date(expiresAt).toISOString() });
			}
			if (request.method === "DELETE" && action === "") {
				if (self) return fail(409, "Delete your own account from Settings.");
				const reason = (await body()).reason;
				return deletionResponse(await deleteAccount(env, account, typeof reason === "string" ? `admin: ${reason}` : "admin"));
			}
			return fail(404, "Not found");
		} catch (error) {
			if (error instanceof HttpError) return fail(error.status, error.message);
			throw error;
		}
	};
}
