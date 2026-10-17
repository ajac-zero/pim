/**
 * Signing in to the web app with passkeys, or with an account at Google,
 * GitHub or a single sign-on provider the admin set up (./oauth.ts).
 *
 * Every person on a Pim has their own Auth Durable Object (./store.ts) with
 * their passkeys, linked identities, recovery codes and API tokens. One
 * hostname serves them all, so a request names its owner itself:
 *
 * - a session cookie, sealed with the instance's key, names the owner and the
 *   credential (passkey or linked identity) it was made with, and opens
 *   nothing once that credential is gone;
 * - a sign-in names its owner in the passkey's user handle, which is the
 *   owner ID the passkey was made for; the passkey must be one of theirs;
 * - a sign-in with another account finds its owner in the Directory, which
 *   knows whose each identity is; it must be one of theirs too;
 * - links that make a passkey (setup links, device links) carry their owner
 *   before the code, as `<owner>.<code>`; a recovery code comes with the
 *   person's username.
 *
 * A new passkey takes one of the following, and linking an identity one of
 * the first two:
 *
 * - a signed-in session;
 * - a setup code: the one registration hands out, one an admin issues for a
 *   member, or, for the admin, one the Worker writes to its own logs (reading
 *   those logs takes the Cloudflare account's login);
 * - a recovery code: the person got ten when they registered;
 * - a device link: a signed-in browser makes one, to open on
 *   the person's other device (a phone), which then makes its own passkey.
 */

import { base64UrlDecode, base64UrlEncode } from "./encoding";
import { type Auth, digestHex, normalizeRecoveryCode, type Passkey } from "./store";
import { authorizationUrl, exchangeCode, type Identity, isProviderId, type ProviderId, type ProviderSettings, providerName, randomValue } from "./oauth";
import { ALGORITHMS, type Assertion, type Registration, verifyAssertion, verifyRegistration } from "./webauthn";

export { Auth } from "./store";

export type Role = "admin" | "member";

/** One person's sign-in, as the Worker resolved it from their stable owner ID. */
export type AuthSite = {
	/** The owner's stable ID. Sessions, links and tokens name it. */
	readonly owner: string;
	/** The owner's Auth Durable Object. */
	readonly store: DurableObjectStub<Auth>;
	/** `pending` until the first passkey or identity is added; only setup codes work then. */
	readonly status: "pending" | "active" | "suspended";
	/** The WebAuthn user passkeys are made for: its ID is the owner ID, which sign-ins hand back. */
	readonly user: { readonly id: string; readonly name: string; readonly displayName: string };
	/** Shown to the web app. */
	readonly account: { readonly username: string; readonly role: Role };
	/** Runs after a credential is added without a session (a setup code or a recovery code): it activates a pending account. */
	readonly onCredentialAdded?: () => Promise<void>;
};

/** How the Worker finds people's sign-ins: deleted accounts have none. */
export type Sites = {
	byOwner(owner: string): Promise<AuthSite | null>;
	byUsername(username: string): Promise<AuthSite | null>;
	/** What the sign-in screen needs to know about the instance: whether it is set up, and how people join. */
	signedOut(request: Request): Promise<Record<string, unknown>>;
	/** The sign-in providers the admin set up. */
	providers(): Promise<Partial<Record<ProviderId, ProviderSettings>>>;
	/** Whose a linked identity is, instance-wide. */
	identityOwner(identity: Identity): Promise<string | null>;
	/** Takes an identity for an owner: false when it is someone else's. */
	claimIdentity(identity: Identity, owner: string): Promise<boolean>;
	releaseIdentity(identity: Pick<Identity, "issuer" | "subject">, owner: string): Promise<void>;
};

/** A browser's sign-in: whose, and the passkey or linked identity it was made with. */
export type Session = { readonly credential: string; readonly owner: string };

export const SESSION_COOKIE = "__Host-pim-session";
const CHALLENGE_COOKIE = "__Host-pim-challenge";
const OAUTH_COOKIE = "__Host-pim-oauth";
/** How long someone may take at a provider's sign-in page. */
const OAUTH_SECONDS = 10 * 60;
const SESSION_SECONDS = 30 * 24 * 60 * 60;
const CHALLENGE_SECONDS = 5 * 60;

/** The WebAuthn user handle for an owner: their owner ID's bytes, base64url. */
export function userHandle(owner: string): string {
	return base64UrlEncode(new TextEncoder().encode(owner));
}

function ownerOfHandle(handle: string): string | null {
	try {
		return new TextDecoder("utf-8", { fatal: true, ignoreBOM: false }).decode(base64UrlDecode(handle));
	} catch {
		return null;
	}
}

/** `<owner>.<code>`, as setup and device links carry them. */
export const ownedCode = (owner: string, code: string) => `${owner}.${code}`;

function splitOwnedCode(value: unknown): { owner: string; code: string } | null {
	if (typeof value !== "string") return null;
	const dot = value.indexOf(".");
	if (dot <= 0 || dot === value.length - 1) return null;
	return { owner: value.slice(0, dot), code: value.slice(dot + 1) };
}

/** What the Worker signs into cookies, by kind. */
type Sealed = {
	/** `passkey` is what sessions sealed before linked identities named their credential. */
	session: { credential?: string; passkey?: string; owner: string };
	challenge: {
		challenge: string;
		ceremony: "create" | "get";
		/** The owner a passkey is being made for; a sign-in learns it from the passkey. */
		owner?: string;
		/** The setup code that allowed this passkey, if one did. */
		setup?: string;
		/** The digest of the recovery code that allowed this passkey, if one did. */
		recovery?: string;
		/** The device link that allowed this passkey, if one did. */
		device?: string;
	};
	/** A sign-in at a provider, under way; the provider sends the browser back with `state`. */
	oauth: {
		provider: ProviderId;
		state: string;
		nonce: string;
		verifier: string;
		redirectUri: string;
		/** Linking to a signed-in person's account: the session's credential must still be theirs on return. */
		link?: { owner: string; credential: string };
		/** Adding the first credential with a setup code, or one after losing the rest. */
		setup?: { owner: string; code: string };
	};
};

const encoder = new TextEncoder();

/** The instance's cookie-signing key, kept in the Directory and read once per isolate. */
let signingKey: Promise<CryptoKey> | null = null;

function cookieKey(env: Env): Promise<CryptoKey> {
	if (!signingKey) {
		const key = env.Directory.getByName("directory")
			.cookieKey()
			.then((raw) => crypto.subtle.importKey("raw", base64UrlDecode(raw), { name: "HMAC", hash: "SHA-256" }, false, ["sign", "verify"]));
		signingKey = key;
		key.catch(() => {
			if (signingKey === key) signingKey = null;
		});
	}
	return signingKey;
}

async function seal<K extends keyof Sealed>(env: Env, kind: K, value: Sealed[K], seconds: number, now: number): Promise<string> {
	const exp = Math.floor(now / 1000) + seconds;
	const body = base64UrlEncode(encoder.encode(JSON.stringify({ kind, exp, value })));
	const mac = await crypto.subtle.sign("HMAC", await cookieKey(env), encoder.encode(body));
	return `${body}.${base64UrlEncode(new Uint8Array(mac))}`;
}

async function unseal<K extends keyof Sealed>(env: Env, kind: K, token: string | null, now: number): Promise<Sealed[K] | null> {
	const [body, mac, ...rest] = token?.split(".") ?? [];
	if (!body || !mac || rest.length > 0) return null;
	try {
		const valid = await crypto.subtle.verify("HMAC", await cookieKey(env), base64UrlDecode(mac), encoder.encode(body));
		if (!valid) return null;
		const payload = JSON.parse(new TextDecoder().decode(base64UrlDecode(body)));
		if (payload.kind !== kind) return null;
		if (typeof payload.exp !== "number" || payload.exp <= now / 1000) return null;
		return payload.value as Sealed[K];
	} catch {
		return null;
	}
}

function readCookie(request: Request, name: string): string | null {
	for (const part of (request.headers.get("cookie") ?? "").split(";")) {
		const [key, ...value] = part.trim().split("=");
		if (key === name) return value.join("=");
	}
	return null;
}

function setCookie(name: string, value: string, seconds: number, sameSite: "Strict" | "Lax" = "Strict"): string {
	return `${name}=${value}; Path=/; Secure; HttpOnly; SameSite=${sameSite}; Max-Age=${seconds}`;
}

export const clearCookie = (name: string) => setCookie(name, "", 0);

function json(body: unknown, status = 200, cookies: string[] = []) {
	const response = Response.json(body, { status });
	for (const cookie of cookies) response.headers.append("set-cookie", cookie);
	return response;
}

const fail = (status: number, error: string) => json({ error }, status);

async function readBody<T extends Record<string, unknown>>(
	request: Request,
	fields: { [K in keyof T]: "string" | "number" },
): Promise<T | null> {
	const body = (await request.json().catch(() => null)) as Record<string, unknown> | null;
	if (!body || typeof body !== "object") return null;
	for (const [field, type] of Object.entries(fields)) {
		if (typeof body[field] !== type) return null;
	}
	return body as T;
}

/** The owner and credential a request's session cookie names, if the instance sealed it and it hasn't expired. Not yet checked against their credentials. */
export async function sessionClaim(request: Request, env: Env, now = Date.now()): Promise<Session | null> {
	const sealed = await unseal(env, "session", readCookie(request, SESSION_COOKIE), now);
	const credential = sealed?.credential ?? sealed?.passkey;
	return sealed && typeof sealed.owner === "string" && typeof credential === "string" ? { credential, owner: sealed.owner } : null;
}

/** The session `request` carries for this owner, if it is still good: its passkey or linked identity must still be one of theirs. */
export async function currentSession(request: Request, env: Env, site: AuthSite, now = Date.now()): Promise<Session | null> {
	const claim = await sessionClaim(request, env, now);
	if (!claim || claim.owner !== site.owner) return null;
	return (await site.store.hasCredential(claim.credential)) ? claim : null;
}

/**
 * Whether another site is using the browser's cookies. Browsers send Origin
 * on every write and WebSocket, so those must come from this app's origin.
 */
export function fromAnotherSite(request: Request): boolean {
	const origin = request.headers.get("origin");
	const reads = ["GET", "HEAD"].includes(request.method);
	const socket = request.headers.get("upgrade")?.toLowerCase() === "websocket";
	if (origin === null) return !reads || socket;
	return origin !== new URL(request.url).origin;
}

type AllowedBy = { setup?: string; recovery?: string; device?: string };

async function challengeCookie(env: Env, ceremony: "create" | "get", now: number, owner?: string, allowedBy: AllowedBy = {}) {
	const challenge = base64UrlEncode(crypto.getRandomValues(new Uint8Array(32)));
	const sealed = await seal(env, "challenge", { challenge, ceremony, ...(owner ? { owner } : {}), ...allowedBy }, CHALLENGE_SECONDS, now);
	return { challenge, cookie: setCookie(CHALLENGE_COOKIE, sealed, CHALLENGE_SECONDS) };
}

async function sessionCookie(env: Env, site: AuthSite, credential: string, now: number) {
	return setCookie(SESSION_COOKIE, await seal(env, "session", { credential, owner: site.owner }, SESSION_SECONDS, now), SESSION_SECONDS);
}

/** Linked identities' IDs start so; passkeys' are the authenticator's. */
const isIdentity = (credential: string) => credential.startsWith("idp_");

/** The providers set up, as the web app shows their buttons. */
async function providerButtons(sites: Sites) {
	const providers = await sites.providers();
	return Object.entries(providers).map(([id, settings]) => ({ id, name: providerName(id as ProviderId, settings) }));
}

/** Answers `/auth/*` but registration: sign-in, sign-out, passkeys, linked identities, device links, recovery codes and API tokens. */
export async function handleAuth(request: Request, env: Env, sites: Sites, now = Date.now()): Promise<Response> {
	const url = new URL(request.url);
	const path = url.pathname.slice("/auth".length);
	// A provider sends the browser back here from its own site; the sealed state is what makes it this browser's.
	const callback = /^\/oauth\/([a-z]+)\/callback$/.exec(path);
	if (callback && request.method === "GET") return finishOAuth(request, env, sites, callback[1]!, now);
	if (fromAnotherSite(request)) return fail(403, "Requests must come from this app");
	// Passkeys belong to the hostname the app is served from.
	const ceremonySite = { rpId: url.hostname, origin: url.origin };
	const route = `${request.method} ${path}`;

	/** The signed-in person, whose account still works. */
	const signedIn = async (): Promise<{ site: AuthSite; session: Session } | null> => {
		const claim = await sessionClaim(request, env, now);
		const site = claim ? await sites.byOwner(claim.owner) : null;
		if (!site || site.status !== "active") return null;
		const session = await currentSession(request, env, site, now);
		return session ? { site, session } : null;
	};

	if (route === "GET /session") {
		const [current, providers] = await Promise.all([signedIn(), providerButtons(sites)]);
		if (!current) {
			return json({ signedIn: false, method: null, passkey: null, credential: null, account: null, providers, ...(await sites.signedOut(request)) });
		}
		const { credential } = current.session;
		const identity = isIdentity(credential);
		// What an account they linked calls them, so the app needn't ask their name.
		const name = (await current.site.store.identities()).find((linked) => linked.name !== null)?.name ?? null;
		return json({
			signedIn: true,
			method: identity ? "identity" : "passkey",
			passkey: identity ? null : credential,
			credential,
			account: current.site.account,
			name,
			providers,
		});
	}

	if (route === "POST /sign-in/options") {
		const { challenge, cookie } = await challengeCookie(env, "get", now);
		return json({ challenge, rpId: ceremonySite.rpId, userVerification: "required", timeout: CHALLENGE_SECONDS * 1000 }, 200, [cookie]);
	}

	const pendingChallenge = () => unseal(env, "challenge", readCookie(request, CHALLENGE_COOKIE), now);

	if (route === "POST /sign-in") {
		const pending = await pendingChallenge();
		if (pending?.ceremony !== "get") return fail(400, "Signing in took too long. Try again.");
		const assertion = await readBody<Assertion & { userHandle: string }>(request, {
			id: "string",
			clientDataJSON: "string",
			authenticatorData: "string",
			signature: "string",
			userHandle: "string",
		});
		const owner = assertion ? ownerOfHandle(assertion.userHandle) : null;
		const site = owner ? await sites.byOwner(owner) : null;
		const key = site && assertion && (await site.store.publicKey(assertion.id));
		const valid = key && (await verifyAssertion(assertion, key, { ...ceremonySite, challenge: pending.challenge }));
		if (!site || !assertion || !valid) return fail(401, "That passkey isn't one of this Pim's.");
		if (site.status === "suspended") return fail(403, "Your account is suspended. Ask the person who runs this Pim.");
		if (site.status !== "active") return fail(401, "That passkey isn't one of this Pim's.");
		await site.store.usePasskey(assertion.id, now);
		return json({ ok: true }, 200, [await sessionCookie(env, site, assertion.id, now), clearCookie(CHALLENGE_COOKIE)]);
	}

	if (route === "POST /sign-out") {
		// A link this browser made for another device dies with its session.
		const current = await signedIn();
		if (current) await current.site.store.voidDeviceLinks(current.session.credential);
		return json({ ok: true }, 200, [clearCookie(SESSION_COOKIE)]);
	}

	if (route === "POST /passkeys/options") {
		const body = (await request.json().catch(() => null)) as { setup?: unknown; recovery?: unknown; username?: unknown; device?: unknown } | null;
		const current = await signedIn();
		let site = current?.site ?? null;
		let allowedBy: AllowedBy = {};
		if (!site) {
			const setup = splitOwnedCode(body?.setup);
			const device = splitOwnedCode(body?.device);
			const recovery = typeof body?.recovery === "string" && typeof body?.username === "string" ? body.recovery : null;
			if (setup) {
				site = await sites.byOwner(setup.owner);
				// A pending account's only way in is its setup code.
				if (site && site.status !== "suspended" && (await site.store.isSetupCode(setup.code, now))) allowedBy = { setup: setup.code };
				else return fail(401, "This setup link has expired or was already used.");
			} else if (recovery) {
				site = await sites.byUsername(String(body!.username).trim().toLowerCase().replace(/^@/, ""));
				const digest = await digestHex(normalizeRecoveryCode(recovery));
				// A pending account may finish setting up with one, instead of its setup link.
				if (site && site.status !== "suspended" && (await site.store.isRecoveryCode(digest))) allowedBy = { recovery: digest };
				else return fail(401, "That username and recovery code don't go together, or the code was already used.");
			} else if (device) {
				site = await sites.byOwner(device.owner);
				if (site?.status === "active" && (await site.store.isDeviceLink(device.code, now))) allowedBy = { device: device.code };
				else return fail(401, "This link has expired or was already used. Make a new one on a device that's signed in.");
			} else {
				return fail(401, "Sign in to add a passkey.");
			}
		}
		const { challenge, cookie } = await challengeCookie(env, "create", now, site.owner, allowedBy);
		const existing = await site.store.passkeys();
		return json(
			{
				challenge,
				rp: { id: ceremonySite.rpId, name: "Pim" },
				user: site.user,
				pubKeyCredParams: ALGORITHMS.map((alg) => ({ type: "public-key", alg })),
				authenticatorSelection: { residentKey: "required", requireResidentKey: true, userVerification: "required" },
				attestation: "none",
				timeout: CHALLENGE_SECONDS * 1000,
				excludeCredentials: existing.map(({ id }) => ({ type: "public-key", id })),
			},
			200,
			[cookie],
		);
	}

	if (route === "POST /passkeys") {
		// Only issued above, to someone signed in or holding a setup link, recovery code or device link.
		const pending = await pendingChallenge();
		if (pending?.ceremony !== "create" || !pending.owner) return fail(400, "Creating the passkey took too long. Try again.");
		const site = await sites.byOwner(pending.owner);
		if (!site || site.status === "suspended") return fail(403, "This account can't add passkeys.");
		const registration = await readBody<Registration & { name: string }>(request, {
			id: "string",
			clientDataJSON: "string",
			authenticatorData: "string",
			publicKey: "string",
			publicKeyAlgorithm: "number",
			name: "string",
		});
		if (!registration || registration.id.length > 1400) return fail(400, "Couldn't read the passkey.");
		const key = await verifyRegistration(registration, { ...ceremonySite, challenge: pending.challenge });
		if (!key) return fail(400, "Couldn't verify the passkey.");
		const store = site.store;
		const viaLink = Boolean(pending.setup || pending.recovery || pending.device);
		// Without a link, only the person signed in when the options were given may finish.
		const session = await currentSession(request, env, site, now);
		if (!viaLink && !session) return fail(401, "Sign in to add a passkey.");
		// Two tabs could have started with the same link or code; only one finishes.
		if (pending.setup && !(await store.useSetupCode(pending.setup, now))) {
			return fail(401, "This setup link was already used.");
		}
		if (pending.recovery && !(await store.useRecoveryCode(pending.recovery, now))) {
			return fail(401, "That recovery code was already used.");
		}
		if (pending.device && !(await store.useDeviceLink(pending.device, now))) {
			return fail(401, "This link has expired or was already used. Make a new one on a device that's signed in.");
		}
		const name = registration.name.trim().slice(0, 64) || "Passkey";
		const passkey: Passkey = await store.addPasskey(registration.id, key, name, now);
		if (viaLink) {
			const by = pending.recovery ? "recovery" : pending.device ? "device_link" : "setup";
			console.log(JSON.stringify({ event: "pim.passkey_created", owner: site.owner, by }));
			await site.onCredentialAdded?.();
		}
		// A browser already signed in stays on its own session.
		const cookies = [clearCookie(CHALLENGE_COOKIE)];
		if (!session) cookies.push(await sessionCookie(env, site, registration.id, now));
		return json(passkey, 200, cookies);
	}

	const start = /^\/oauth\/([a-z]+)$/.exec(path);
	if (start && request.method === "POST") {
		const provider = start[1]!;
		const settings = isProviderId(provider) ? (await sites.providers())[provider] : undefined;
		if (!isProviderId(provider) || !settings) return fail(404, "That sign-in method isn't set up on this Pim.");
		const body = (await request.json().catch(() => null)) as { setup?: unknown } | null;
		const flow: Sealed["oauth"] = {
			provider,
			state: randomValue(),
			nonce: randomValue(),
			verifier: randomValue(),
			redirectUri: `${url.origin}/auth/oauth/${provider}/callback`,
		};
		const current = await signedIn();
		const setup = splitOwnedCode(body?.setup);
		if (current) {
			flow.link = { owner: current.site.owner, credential: current.session.credential };
		} else if (setup) {
			const site = await sites.byOwner(setup.owner);
			if (!site || site.status === "suspended" || !(await site.store.isSetupCode(setup.code, now))) {
				return fail(401, "This setup link has expired or was already used.");
			}
			flow.setup = setup;
		}
		let location: string;
		try {
			location = await authorizationUrl(provider, settings, flow);
		} catch (error) {
			return fail(502, error instanceof Error ? error.message : String(error));
		}
		// Lax, unlike the others: the provider's redirect back is a navigation from another site, and must bring it.
		const cookie = setCookie(OAUTH_COOKIE, await seal(env, "oauth", flow, OAUTH_SECONDS, now), OAUTH_SECONDS, "Lax");
		return json({ url: location }, 200, [cookie]);
	}

	// Everything below needs a signed-in browser: an API token can't manage sign-in.
	const current = await signedIn();
	if (!current) return fail(401, "Sign in to Pim");
	const { site, session } = current;
	const store = site.store;

	if (route === "GET /passkeys") return json({ passkeys: await store.passkeys() });
	if (request.method === "DELETE" && path.startsWith("/passkeys/")) {
		const id = decodeURIComponent(path.slice("/passkeys/".length));
		await store.removePasskey(id);
		return json({ ok: true }, 200, session.credential === id ? [clearCookie(SESSION_COOKIE)] : []);
	}

	if (route === "GET /identities") {
		const identities = (await store.identities()).map(({ id, provider, label, createdAt, lastUsedAt }) => ({ id, provider, label, createdAt, lastUsedAt }));
		return json({ identities });
	}
	if (request.method === "DELETE" && path.startsWith("/identities/")) {
		const id = decodeURIComponent(path.slice("/identities/".length));
		const removed = await store.removeIdentity(id);
		if (!removed) return fail(404, "That account isn't linked.");
		await sites.releaseIdentity(removed, site.owner);
		console.log(JSON.stringify({ event: "pim.identity_unlinked", owner: site.owner, provider: removed.provider }));
		return json({ ok: true }, 200, session.credential === id ? [clearCookie(SESSION_COOKIE)] : []);
	}

	if (route === "POST /device-link") {
		const { code, expiresAt } = await store.newDeviceLink(session.credential, now);
		console.log(JSON.stringify({ event: "pim.device_link_issued", owner: site.owner }));
		// The code goes in the fragment, so it never reaches a server's logs or a Referer header.
		return json({ url: `${ceremonySite.origin}/#device=${ownedCode(site.owner, code)}`, expiresAt: new Date(expiresAt).toISOString() }, 201);
	}

	if (route === "DELETE /device-link") {
		// Done or changed one's mind: the link this browser made stops working now, not in ten minutes.
		await store.voidDeviceLinks(session.credential);
		return json({ ok: true });
	}

	if (route === "GET /recovery-codes") return json({ left: await store.recoveryCodesLeft() });
	if (route === "POST /recovery-codes") {
		console.log(JSON.stringify({ event: "pim.recovery_codes_replaced", owner: site.owner }));
		return json({ codes: await store.newRecoveryCodes(now) });
	}

	if (route === "GET /tokens") return json({ tokens: await store.tokens() });
	if (route === "POST /tokens") {
		const body = (await request.json().catch(() => null)) as { name?: unknown } | null;
		const name = typeof body?.name === "string" ? body.name.trim().slice(0, 64) : "";
		if (name === "") return fail(400, "Give the token a name, such as the app that will use it.");
		if ((await store.tokens()).length >= MAX_TOKENS) return fail(429, `You can have up to ${MAX_TOKENS} tokens. Revoke one first.`);
		return json(await store.createToken(site.owner, name, now), 201);
	}
	if (request.method === "DELETE" && path.startsWith("/tokens/")) {
		const id = decodeURIComponent(path.slice("/tokens/".length));
		return (await store.revokeToken(id)) ? json({ ok: true }) : fail(404, `No token ${id}`);
	}

	return fail(404, "Not found");
}

/**
 * Where a provider sends the browser back: signs it in, adds the account's
 * first credential with a setup code, or links the identity to whoever was
 * signed in when it started. Answers with a redirect into the app, with any
 * error for it to show in the fragment.
 */
async function finishOAuth(request: Request, env: Env, sites: Sites, provider: string, now: number): Promise<Response> {
	const url = new URL(request.url);
	const flow = await unseal(env, "oauth", readCookie(request, OAUTH_COOKIE), now);
	const back = (to: string, error?: string, cookies: string[] = []) => {
		const response = new Response(null, { status: 302, headers: { location: error ? `${to}#auth-error=${encodeURIComponent(error)}` : to } });
		for (const cookie of [clearCookie(OAUTH_COOKIE), ...cookies]) response.headers.append("set-cookie", cookie);
		return response;
	};
	if (!flow || flow.provider !== provider || flow.state !== url.searchParams.get("state")) {
		return back("/", "Signing in took too long, or started in another browser. Try again.");
	}
	// Linking started in Settings, so it ends there, on the tab with your sign-ins.
	const to = flow.link ? "/?dialog=settings&tab=account" : "/";
	const settings = (await sites.providers())[flow.provider];
	const name = providerName(flow.provider, settings);
	if (!settings) return back(to, `Signing in with ${name} isn't set up on this Pim anymore.`);
	const refused = url.searchParams.get("error");
	// Choosing not to sign in there needs no message.
	if (refused) return back(to, refused === "access_denied" ? undefined : `${name} didn't sign you in: ${url.searchParams.get("error_description") ?? refused}.`);
	let identity: Identity;
	try {
		identity = await exchangeCode(flow.provider, settings, { redirectUri: flow.redirectUri, code: url.searchParams.get("code") ?? "", verifier: flow.verifier, nonce: flow.nonce }, now);
	} catch (error) {
		return back(to, error instanceof Error ? error.message : String(error));
	}
	const taken = `That ${name} account already signs in to someone else on this Pim.`;
	const log = (event: string, owner: string) => console.log(JSON.stringify({ event: `pim.${event}`, owner, provider: flow.provider }));

	if (flow.link) {
		const site = await sites.byOwner(flow.link.owner);
		// Signed out, or that credential removed, while away at the provider.
		if (site?.status !== "active" || !(await site.store.hasCredential(flow.link.credential))) return back("/", "Sign in again to link an account.");
		if (!(await sites.claimIdentity(identity, site.owner))) return back(to, taken);
		await site.store.linkIdentity(flow.provider, identity.issuer, identity.subject, identity.label, identity.name, now);
		log("identity_linked", site.owner);
		return back(to);
	}

	if (flow.setup) {
		const site = await sites.byOwner(flow.setup.owner);
		if (!site || site.status === "suspended") return back(to, "This account can't sign in.");
		if (!(await sites.claimIdentity(identity, site.owner))) return back(to, taken);
		// Two tabs could have started with the same link; only one finishes.
		if (!(await site.store.useSetupCode(flow.setup.code, now))) {
			if (!(await site.store.identity(identity.issuer, identity.subject))) await sites.releaseIdentity(identity, site.owner);
			return back(to, "This setup link has expired or was already used.");
		}
		const linked = await site.store.linkIdentity(flow.provider, identity.issuer, identity.subject, identity.label, identity.name, now);
		log("identity_linked", site.owner);
		await site.onCredentialAdded?.();
		return back(to, undefined, [await sessionCookie(env, site, linked.id, now)]);
	}

	const owner = await sites.identityOwner(identity);
	const site = owner ? await sites.byOwner(owner) : null;
	const linked = site ? await site.store.identity(identity.issuer, identity.subject) : null;
	if (!site || !linked || site.status === "pending") {
		return back(to, `Nobody on this Pim signs in with that ${name} account. Sign in another way and link it in Settings, or join first.`);
	}
	if (site.status === "suspended") return back(to, "Your account is suspended. Ask the person who runs this Pim.");
	await site.store.useIdentity(linked.id, identity.label, identity.name, now);
	return back(to, undefined, [await sessionCookie(env, site, linked.id, now)]);
}

/** API tokens one person may have. */
const MAX_TOKENS = 20;

/** The owner an API token names: tokens are `pim_<owner>_<secret>`. Whether it is really theirs is for their Auth to say. */
export function tokenOwner(token: string): string | null {
	return /^pim_(o_[0-9a-z]{26})_[\w-]+$/.exec(token)?.[1] ?? null;
}
