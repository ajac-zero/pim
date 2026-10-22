import { getAgentByName } from "agents";
import { configuredProviders, PROVIDER_IDS, providerName, providerSecrets } from "./auth/oauth";
import { type AuthSite, clearCookie, fromAnotherSite, ownedCode, SESSION_COOKIE, type Sites, userHandle } from "./auth";
import type { ApiExtension } from "./gateway";
import { deploymentSettings, readDeployment } from "./deployment";
import { FRAMED_KINDS, framePage, RUNTIME_PATH, ENTRY_FILES, readFiles, textOf } from "./artifacts";
import type { PublishedArtifact } from "./gallery";
import { HttpError } from "./http";
import { providerInfo } from "./providers";
import { parseLimits, UNLIMITED } from "./usage";
import { type Account, type AccountStatus, type CleanupResult, PENDING_MS, type RegistrationPolicy } from "./directory";
import { usernameProblem } from "./usernames";

/**
 * The people on a Pim: registering and claiming, finding someone's
 * sign-in, their account, what they share with each other, and the admin's
 * view of everyone. ./gateway.ts decides whose request it is and calls in
 * here; ./directory.ts keeps the accounts.
 *
 * Every person's space has its own Pim and Auth Durable Objects, named after their
 * owner ID, so one person's sessions, tokens, credentials and data are never
 * in another's.
 */

/** How long a Worker trusts what it read about an account. Suspensions reach the space at once regardless. */
const ACCOUNT_CACHE_MS = 30_000;
const accounts = new Map<string, { account: Account | null; at: number }>();

/** How long after a deploy a Pim with no admin lets whoever opens it become the admin. */
export const CLAIM_WINDOW_MS = 15 * 60 * 1000;

const directory = (env: Env) => env.Directory.getByName("directory");
const gallery = (env: Env) => env.Gallery.getByName("gallery");
const pimOf = (env: Env, ownerId: string) => getAgentByName(env.Pim, ownerId);
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
/** An answer that carries an artifact or what it keeps, which no cache may keep. */
const noStore = (value: unknown, status = 200) =>
	Response.json(value, { status, headers: { "cache-control": "no-store, private", "x-content-type-options": "nosniff" } });

/** The client's address, as Cloudflare reports it. */
export const clientIp = (request: Request) => request.headers.get("CF-Connecting-IP") ?? "unknown";

/** A rate limit, if the deployment binds one; `key` is what it counts by. */
export async function limited(limiter: RateLimit | undefined, key: string): Promise<boolean> {
	if (!limiter) return false;
	return !(await limiter.limit({ key })).success;
}

function registrationPolicy(env: Env): RegistrationPolicy {
	const { registration, maxAccounts, registrationsPerAddress } = deploymentSettings(env);
	return { mode: registration, maxAccounts, perAddressPerDay: registrationsPerAddress };
}

/** Whether this version of the Worker was deployed less than `CLAIM_WINDOW_MS` ago. */
function claimWindowOpen(env: Env, now: number): boolean {
	const deployed = Date.parse(env.CF_VERSION_METADATA?.timestamp ?? "");
	return now >= deployed && now < deployed + CLAIM_WINDOW_MS;
}

/**
 * The origin public artifact links are served from, `PIM_CONTENT_ORIGIN`:
 * another host, routed to this Worker, that serves nothing but published
 * artifacts' pages and their scripts, and has no session, cookie or API.
 * Null when it isn't set, and links are off.
 */
export const contentOrigin = (env: Env) => deploymentSettings(env).contentOrigin;

/** What an author sees of an artifact they published: also its public link, if it has one, and whether it can. */
function publication(env: Env, published: PublishedArtifact) {
	const content = contentOrigin(env);
	const linkable = content !== null && FRAMED_KINDS.includes(published.kind);
	return { ...published, linkable, link: linkable && published.public ? `${content}/p/${published.id}` : null };
}

/**
 * A request to the content origin. It answers only `/p/<id>`, a published
 * artifact its author lets anyone with the link see, as the same sandboxed
 * page Pim frames, whose bridge refuses every call (no space is there to
 * answer), and the runtime scripts such pages load. Nothing else.
 */
export async function servePublicArtifact(request: Request, env: Env, pathname: string): Promise<Response> {
	if (request.method !== "GET" && request.method !== "HEAD") return new Response("Not found", { status: 404 });
	if (pathname.startsWith(RUNTIME_PATH)) return env.ASSETS.fetch(request);
	const id = /^\/p\/(pa_[0-9a-f]{16})$/.exec(pathname)?.[1];
	const found = id ? await gallery(env).publicArtifact(id) : null;
	if (!found) return new Response("Not found", { status: 404, headers: { "cache-control": "no-store" } });
	const page = framePage(found.kind, await readFiles(env.ARTIFACTS, found.owner, found.files), contentOrigin(env)!);
	page.headers.set("x-robots-tag", "noindex");
	return page;
}

/** This Pim's address, `PIM_PUBLIC_URL`, which `serve` answers nothing without. */
export const pimOrigin = (env: Env) => deploymentSettings(env).publicUrl!;

/** A person's sign-in, as ./auth uses it. */
export function siteFor(env: Env, account: Account): AuthSite {
	return {
		owner: account.ownerId,
		store: authOf(env, account.ownerId),
		status: account.status === "pending" || account.status === "suspended" ? account.status : "active",
		user: { id: userHandle(account.ownerId), name: account.username, displayName: account.username },
		account: { username: account.username, role: account.role },
		onCredentialAdded: async () => {
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
		providers: async () => configuredProviders(env).providers,
		identityOwner: ({ issuer, subject }) => directory(env).identityOwner(issuer, subject),
		claimIdentity: ({ issuer, subject }, owner) => directory(env).claimIdentity(issuer, subject, owner),
		releaseIdentity: ({ issuer, subject }, owner) => directory(env).releaseIdentity(issuer, subject, owner),
	};
}

/**
 * Deletes an account: it stops opening anything at once, then the Directory
 * erases the space and its sign-in, now if it can and on its alarm until it
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
			console.log(`Pim setup link. Open it to set this Pim up and become its admin; it works once, until ${until}: ${pimOrigin(env)}/#claim=${code}`);
			return json({ expiresAt: until });
		}
		const { code, expiresAt } = await authOf(env, admin.ownerId).setupCode(now);
		const until = new Date(expiresAt).toISOString();
		console.log(
			`Pim setup link for ${admin.username}, the admin. Open it to add a passkey; it works once, until ${until}: ${pimOrigin(env)}/#setup=${ownedCode(admin.ownerId, code)}`,
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
		const pim = await pimOf(env, account.ownerId);
		await pim.provision({ ownerId: account.ownerId, username });
		// The deployment's limits are for members: the admin pays for the deployment.
		if (account.role === "admin") await pim.setLimits(UNLIMITED);
		// Everyone gets a copy of the agent the admin chose, if they chose one, besides the majordomo they name next.
		const everyone = await gallery(env).defaultAgent();
		if (everyone) {
			const { author, name, role, description, instructions, apps, contacts, bundle, blueprint, symbol, color } = everyone;
			const image = everyone.icon ? await gallery(env).defaultAgentIcon() : null;
			const icons = await gallery(env).bundleIcons("default");
			const withIcons = bundle.map(({ icon: _icon, ...agent }, position) => ({ ...agent, image: icons[position] ?? null }));
			await pim.adoptEveryonesAgent({ author, name, role, description, instructions, apps, contacts, bundle: withIcons, blueprint, symbol, color, image });
		}
		if (typeof body?.timeZone === "string") {
			// The browser's zone, a good first guess; a bad one is just not applied.
			await pim.applySettings({ timeZone: body.timeZone }).catch(() => undefined);
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

/** `/api/account`: the person's account, answered here because the space doesn't know about accounts. */
export function accountApi(env: Env, account: Account, site: AuthSite, request: Request, viaSession: boolean): ApiExtension {
	return async (path) => {
		if (path !== "/account" && !path.startsWith("/account/")) return undefined;
		const route = `${request.method} ${path}`;
		if (route === "GET /account") {
			const pim = await pimOf(env, account.ownerId);
			const [usage, recoveryCodesLeft, others] = await Promise.all([
				pim.usageReport(),
				site.store.recoveryCodesLeft(),
				directory(env).hasOthers(account.ownerId),
			]);
			return json({
				username: account.username,
				ownerId: account.ownerId,
				role: account.role,
				status: account.status,
				createdAt: account.createdAt,
				usage,
				recoveryCodesLeft,
				// Nobody else is here yet: the app hides Sharing, Discover and publishing until someone is.
				alone: !others,
			});
		}
		if (route === "GET /account/export") {
			const pim = await pimOf(env, account.ownerId);
			const [data, passkeys, identities, tokens] = await Promise.all([pim.exportData(), site.store.passkeys(), site.store.identities(), site.store.tokens()]);
			log("exported", { owner: account.ownerId });
			const body = JSON.stringify(
				{ account: { username: account.username, ownerId: account.ownerId, createdAt: account.createdAt }, passkeys, identities, tokens, pim: JSON.parse(data) },
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
			// An API token can do a lot, but not this: deleting takes the person, signed in.
			if (!viaSession) return fail(403, "Deleting your account needs you signed in to the app.");
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
	const status = /^No (circle|agent|template)/.test(message) ? 404 : /up to \d+/.test(message) ? 429 : 400;
	return fail(status, message);
}

/**
 * Every sign-in provider Pim knows, as the admin's settings show it: whether
 * the deployment's secrets turn it on, which secrets do, and the callback URL
 * to give the provider. Never the secrets' values.
 */
function signInProviders(env: Env, origin: string) {
	const { providers, problems } = configuredProviders(env);
	return PROVIDER_IDS.map((id) => ({
		id,
		name: providerName(id, providers[id]),
		enabled: providers[id] !== undefined,
		// Set only halfway: what's missing.
		problem: problems[id] ?? null,
		secrets: providerSecrets(id),
		callbackUrl: `${origin}/auth/oauth/${id}/callback`,
	}));
}

/**
 * The parts of a person's API that need the whole instance, answered here:
 * adding someone to a circle by username (only the Directory knows whose
 * space a username is), their profile, other people's, and the gallery of
 * published agents. Everything else is their own space's.
 */
export function socialApi(env: Env, account: Account, request: Request): ApiExtension {
	return async (path) => {
		const route = `${request.method} ${path}`;
		const body = async () => ((await request.json().catch(() => null)) ?? {}) as Record<string, unknown>;
		const pim = () => pimOf(env, account.ownerId);
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
				const added = await (await pim()).addCircleMember(decodeURIComponent(member[1]!), { ownerId: guest.ownerId, username: guest.username });
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
			const template = /^\/templates\/([^/]+)(\/use|\/icon|\/agents\/(\d+)\/icon)?$/.exec(path);
			if (template) {
				const found = await gallery(env).template(decodeURIComponent(template[1]!));
				if (!found) return fail(404, "No such template. It may have been unpublished.");
				if (!template[2] && request.method === "GET") return json(found);
				if (template[2]?.endsWith("/icon") && request.method === "GET") {
					// Its own icon, or that of one of the agents that come with it, by its place in `bundle`.
					const icon = template[3] === undefined ? await gallery(env).templateIcon(found.id) : await gallery(env).bundleIcon(found.id, Number(template[3]));
					if (!icon) return fail(404, "This template has no icon");
					return new Response(icon.data, {
						headers: { "content-type": icon.type, "x-content-type-options": "nosniff", "cache-control": "private, max-age=31536000, immutable" },
					});
				}
				if (template[2] === "/use" && request.method === "POST") {
					const image = found.icon === null ? null : await gallery(env).templateIcon(found.id);
					const icons = await gallery(env).bundleIcons(found.id);
					const bundle = found.bundle.map(({ icon: _icon, ...agent }, position) => ({ ...agent, image: icons[position] ?? null }));
					const agent = await (await pim()).adoptTemplate({ ...found, bundle, image });
					if (found.author !== account.username) await gallery(env).used(found.id);
					log("template_used", { owner: account.ownerId, template: found.id });
					return json(agent, 201);
				}
				return undefined;
			}

			// Artifacts published to everyone: read from the gallery, run with the viewer's own space.
			if (path === "/published-artifacts" || path.startsWith("/published-artifacts/") || /^\/artifacts\/[^/]+(\/publish)?$/.test(path)) {
				if (new URL(request.url).searchParams.has("token")) return fail(400, "Send the API token in the Authorization header, not the address");
			}
			if (route === "GET /published-artifacts") {
				const url = new URL(request.url);
				return noStore({ artifacts: await gallery(env).publishedArtifacts({ query: url.searchParams.get("q") ?? undefined }) });
			}
			const published = /^\/published-artifacts\/([^/]+)(?:\/(use)|\/versions\/(\d+)(?:\/(frame|bridge|grants))?)?$/.exec(path);
			if (published) {
				const [, id, use, version, part] = published;
				const found = await gallery(env).publishedArtifact(decodeURIComponent(id!));
				if (!found) return fail(404, "No such artifact. It may have been unpublished.");
				if (!use && !version && request.method === "GET") return noStore(found);
				if (use && request.method === "POST") {
					const stored = await gallery(env).publishedFiles(found.id);
					if (stored === null) return fail(404, "No such artifact. It may have been unpublished.");
					const artifact = await (await pim()).adoptArtifact({ title: found.title, kind: found.kind, ...stored });
					if (found.author !== account.username) await gallery(env).artifactUsed(found.id);
					log("published_artifact_used", { owner: account.ownerId, artifact: found.id });
					return noStore(artifact, 201);
				}
				if (!version) return undefined;
				if (Number(version) !== found.version) return fail(404, `Only version ${found.version} is published`);
				if (request.method === "GET" && (!part || part === "frame")) {
					const stored = await gallery(env).publishedFiles(found.id);
					if (stored === null) return fail(404, "No such artifact. It may have been unpublished.");
					const files = await readFiles(env.ARTIFACTS, stored.owner, stored.files);
					if (part === "frame") return framePage(found.kind, files, new URL(request.url).origin);
					return noStore({ ...found, latest: found.version, files: stored.files, content: textOf(files.get(ENTRY_FILES[found.kind])!.bytes) });
				}
				if (request.method === "POST" && part === "bridge") {
					const { op, args } = await body();
					const answer = (await (await pim()).publishedArtifactCall(found, {
						op,
						args: args && typeof args === "object" ? (args as Record<string, unknown>) : {},
					})) as { ok: true; answer: unknown } | { ok: false; status: number; reason: string };
					if (!answer.ok) return fail(answer.status, answer.reason);
					return noStore(answer.answer);
				}
				if (request.method === "POST" && part === "grants") {
					const answer = await (await pim()).publishedArtifactGrant(found, (await body()).capability);
					if (!answer.ok) return fail(answer.status, answer.reason);
					return noStore({ granted: answer.granted }, 201);
				}
				return undefined;
			}
			const publishArtifact = /^\/artifacts\/([^/]+)\/publish$/.exec(path);
			if (publishArtifact) {
				const id = decodeURIComponent(publishArtifact[1]!);
				if (request.method === "GET") {
					const found = await gallery(env).publishedArtifactOf(account.ownerId, id);
					return found ? noStore(publication(env, found)) : fail(404, "Not published");
				}
				if (request.method === "POST") {
					const artifact = await (await pim()).artifactToPublish(id);
					if (!artifact) return fail(404, `No artifact ${id}`);
					const open = (await body()).public;
					if (open !== undefined && typeof open !== "boolean") return fail(400, "public must be true or false");
					if (open && contentOrigin(env) === null) return fail(400, "This Pim has no content origin for public links (PIM_CONTENT_ORIGIN).");
					if (open && !FRAMED_KINDS.includes(artifact.kind)) return fail(400, "Only pages, React apps, drawings and diagrams can have a public link.");
					const done = await gallery(env).publishArtifact(account.ownerId, account.username, artifact, open);
					log("artifact_published", { owner: account.ownerId, artifact: done.id, public: done.public });
					return noStore(publication(env, done), 201);
				}
				if (request.method === "DELETE") return noStore({ deleted: await gallery(env).unpublishArtifact(account.ownerId, id) });
				return undefined;
			}
			// A deleted artifact leaves the gallery too; the owner's space deletes it after.
			const deletedArtifact = /^\/artifacts\/([^/]+)$/.exec(path);
			if (deletedArtifact && request.method === "DELETE") await gallery(env).unpublishArtifact(account.ownerId, decodeURIComponent(deletedArtifact[1]!));

			const publish = /^\/agents\/([^/]+)\/publish$/.exec(path);
			if (publish) {
				const id = decodeURIComponent(publish[1]!);
				const agent = await (await pim()).agentToPublish(id);
				if (!agent) return fail(404, `No agent ${id}`);
				if (request.method === "POST") {
					const published = await gallery(env).publish(account.ownerId, account.username, agent);
					await (await pim()).setAgentPublished(id, published.id);
					log("template_published", { owner: account.ownerId, template: published.id });
					return json(published, 201);
				}
				if (request.method === "DELETE") {
					await gallery(env).unpublish(account.ownerId, id);
					await (await pim()).setAgentPublished(id, null);
					return json({ deleted: true });
				}
				return undefined;
			}
			// A deleted agent leaves the gallery too; the space deletes it after.
			const deleted = /^\/agents\/([^/]+)$/.exec(path);
			if (deleted && request.method === "DELETE") await gallery(env).unpublish(account.ownerId, decodeURIComponent(deleted[1]!));
		} catch (error) {
			return rpcFailure(error);
		}
		return undefined;
	};
}

/**
 * `/api/admin/*`: the admin's view of everyone, and which sign-in providers
 * are on, with a signed-in browser only. An API token can't run the instance.
 */
export function adminApi(env: Env, admin: Account, request: Request, viaSession: boolean): ApiExtension {
	return async (path) => {
		if (path !== "/admin" && !path.startsWith("/admin/")) return undefined;
		if (admin.role !== "admin") return fail(403, "Only the admin can do that.");
		if (!viaSession) return fail(403, "Running this Pim needs you signed in to the app.");
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
			if (route === "GET /sign-in") return json({ providers: signInProviders(env, url.origin) });
			if (route === "GET /deployment") return json(readDeployment(env));
			if (route === "GET /default-agent") return json({ agent: await gallery(env).defaultAgent() });
			if (route === "PUT /default-agent") {
				const id = (await body()).agent;
				if (typeof id !== "string") return fail(400, "agent must be the id of one of your agents");
				const agent = await (await pimOf(env, admin.ownerId)).agentToPublish(id);
				if (!agent) return fail(404, `No agent ${id}`);
				const chosen = await gallery(env).setDefaultAgent(admin.ownerId, admin.username, agent);
				log("default_agent_set", { by: admin.ownerId, agent: id });
				return json({ agent: chosen });
			}
			if (route === "DELETE /default-agent") {
				await gallery(env).clearDefaultAgent();
				log("default_agent_set", { by: admin.ownerId, agent: null });
				return json({ agent: null });
			}
			const template = /^\/admin\/templates\/([^/]+)$/.exec(path);
			if (template && request.method === "DELETE") {
				const removed = await gallery(env).remove(decodeURIComponent(template[1]!));
				if (!removed) return fail(404, "No such template");
				log("template_removed", { template: template[1], by: admin.ownerId });
				return json({ deleted: true });
			}
			const publishedArtifact = /^\/admin\/published-artifacts\/([^/]+)$/.exec(path);
			if (publishedArtifact && request.method === "DELETE") {
				const removed = await gallery(env).removeArtifact(decodeURIComponent(publishedArtifact[1]!));
				if (!removed) return fail(404, "No such artifact");
				log("published_artifact_removed", { artifact: publishedArtifact[1], by: admin.ownerId });
				return json({ deleted: true });
			}
			if (route === "POST /apps") {
				const given = await body();
				const app = await gallery(env)
					.addCustomApp(given)
					.catch((error: unknown) => rpcFailure(error));
				if (app instanceof Response) return app;
				log("app_added", { app: app.id, by: admin.ownerId });
				return json({ app }, 201);
			}
			const customApp = /^\/admin\/apps\/([^/]+)$/.exec(path);
			if (customApp && request.method === "PUT") {
				const app = await gallery(env)
					.setCustomAppIcon(decodeURIComponent(customApp[1]!), await body())
					.catch((error: unknown) => rpcFailure(error));
				if (app instanceof Response) return app;
				if (!app) return fail(404, "No such app");
				log("app_changed", { app: app.id, by: admin.ownerId });
				return json({ app });
			}
			if (customApp && request.method === "DELETE") {
				if (!(await gallery(env).removeCustomApp(decodeURIComponent(customApp[1]!)))) return fail(404, "No such app");
				log("app_removed", { app: customApp[1], by: admin.ownerId });
				return json({ deleted: true });
			}
			// Model providers for everyone (./providers.ts). People's spaces read them from the gallery.
			const sharedProvider = /^\/admin\/providers\/([^/]+)$/.exec(path);
			if (route === "POST /providers" || (sharedProvider && request.method === "PUT")) {
				const id = sharedProvider ? decodeURIComponent(sharedProvider[1]!) : null;
				const provider = await gallery(env)
					.putSharedProvider(id, await body())
					.catch((error: unknown) => rpcFailure(error));
				if (provider instanceof Response) return provider;
				if (!provider) return fail(404, "No such provider");
				log(id ? "provider_changed" : "provider_added", { provider: provider.id, by: admin.ownerId });
				return json({ provider: providerInfo(provider) }, id ? 200 : 201);
			}
			if (sharedProvider && request.method === "DELETE") {
				if (!(await gallery(env).removeSharedProvider(decodeURIComponent(sharedProvider[1]!)))) return fail(404, "No such provider");
				log("provider_removed", { provider: sharedProvider[1], by: admin.ownerId });
				return json({ deleted: true });
			}
			if (route === "POST /invites") {
				const given = await body();
				const count = typeof given.count === "number" && Number.isInteger(given.count) && given.count > 0 && given.count <= 100 ? given.count : 1;
				const codes = await dir.createInvites(count, typeof given.note === "string" ? given.note.slice(0, 200) : null);
				log("invites_created", { count, by: admin.ownerId });
				const base = pimOrigin(env);
				return json({ codes, links: codes.map((code) => `${base}/#invite=${code}`) }, 201);
			}
			const match = /^\/admin\/accounts\/([^/]+)(\/[a-z-]+)?$/.exec(path);
			if (!match) return fail(404, "Not found");
			const username = decodeURIComponent(match[1]!);
			const action = match[2] ?? "";
			const account = await dir.resolve(username);
			if (!account) return fail(404, `No account ${username}`);
			const pim = () => pimOf(env, account.ownerId);
			const gone = account.status === "deleted" || account.status === "deleting";
			const self = account.ownerId === admin.ownerId;

			if (request.method === "GET" && action === "") {
				const usage = gone ? null : await (await pim()).usageReport();
				return json({ account, usage, cleanup: await dir.cleanup(account.ownerId) });
			}
			if (request.method === "POST" && (action === "/suspend" || action === "/unsuspend")) {
				if (self) return fail(409, "You can't suspend yourself.");
				if (account.status !== "active" && account.status !== "suspended") return fail(409, `${username} is ${account.status}`);
				const status = action === "/suspend" ? "suspended" : "active";
				const reason = (await body()).reason;
				const updated = await dir.setStatus(account.ownerId, status, typeof reason === "string" ? reason : null);
				// The space stops at once, whatever other Workers still have cached.
				await (await pim()).setStatus(status);
				forget(account.ownerId);
				log(status === "suspended" ? "suspended" : "unsuspended", { owner: account.ownerId, username, reason, by: admin.ownerId });
				return json({ account: updated });
			}
			if (request.method === "PUT" && action === "/limits") {
				if (gone) return fail(409, `${username} is ${account.status}`);
				const { limits } = await body();
				const parsed = limits === null ? null : parseLimits(limits);
				const applied = await (await pim()).setLimits(parsed);
				log("limits_changed", { owner: account.ownerId, username, limits: parsed, by: admin.ownerId });
				return json({ limits: applied });
			}
			if (request.method === "POST" && action === "/setup-link") {
				// For someone who lost every passkey and recovery code, after the admin checked who they are.
				if (gone) return fail(409, `${username} is ${account.status}`);
				const { code, expiresAt } = await authOf(env, account.ownerId).issueSetupCode(Date.now(), 60 * 60 * 1000);
				log("setup_link_issued", { owner: account.ownerId, username, by: admin.ownerId });
				return json({ setupUrl: `${pimOrigin(env)}/#setup=${ownedCode(account.ownerId, code)}`, expiresAt: new Date(expiresAt).toISOString() });
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
