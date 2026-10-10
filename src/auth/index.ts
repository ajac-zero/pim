/**
 * Signing in to the web app with passkeys.
 *
 * Passkeys live in the owner's Auth Durable Object (./store.ts). Signing in
 * sets a session cookie the Worker signs with a key kept there, and removing
 * a passkey signs out the sessions it started. A session names the owner it
 * was made for, so it opens only that owner's Pim. A new passkey takes one of:
 *
 * - a signed-in session;
 * - a setup code: self-hosted, a one-time code the Worker writes to its own
 *   logs when the sign-in screen asks (reading those logs takes the Cloudflare
 *   account's login, which proves its holder owns this Pim); hosted, the code
 *   registration hands out, or one the operator issues;
 * - self-hosted only, the claim window: in the first minutes after a deploy,
 *   a Pim that has never had a passkey lets whoever opens it create the
 *   first one, so a fresh deploy needs nothing but a click;
 * - hosted only, a recovery code: the person got ten when they registered;
 * - a device link: a browser signed in with a passkey makes one, to open on
 *   the person's other device (a phone), which then makes its own passkey.
 */

import { base64UrlDecode, base64UrlEncode } from "./encoding";
import { type Auth, digestHex, normalizeRecoveryCode, type Passkey } from "./store";
import { ALGORITHMS, type Assertion, type Registration, verifyAssertion, verifyRegistration } from "./webauthn";

export { Auth } from "./store";

/**
 * Whose sign-in a request is for, and how that Pim is run. The Worker builds
 * it from the stable owner ID it resolved, never from the hostname alone: the
 * hostname only picks which owner's credentials a request must carry.
 */
export type AuthSite = {
	/** The owner's stable ID. Sessions are sealed to it. */
	readonly owner: string;
	/** The owner's Auth Durable Object. */
	readonly store: DurableObjectStub<Auth>;
	/**
	 * `self-hosted`: one owner per deployment, claimed after a deploy, setup
	 * links in the Worker's logs, and `PIM_API_TOKEN`. `hosted`: none of those;
	 * registration's setup code and recovery codes instead.
	 */
	readonly mode: "self-hosted" | "hosted";
	/** The WebAuthn user passkeys are made for. */
	readonly user: { readonly id: string; readonly name: string; readonly displayName: string };
	/** Shown to the web app (hosted: the account's username). */
	readonly account?: { readonly username: string };
	/** Runs after a passkey is made without a session (a setup code, a recovery code or a claim): hosted, it activates the account. */
	readonly onPasskeyCreated?: () => Promise<void>;
};

export type Session = { readonly passkey: string; readonly owner: string };

const SESSION_COOKIE = "__Host-pim-session";
const CHALLENGE_COOKIE = "__Host-pim-challenge";
const SESSION_SECONDS = 30 * 24 * 60 * 60;
const CHALLENGE_SECONDS = 5 * 60;
/** How long after a deploy an unclaimed Pim takes its first passkey without a link. */
export const CLAIM_WINDOW_MS = 15 * 60 * 1000;

/** The WebAuthn user of a self-hosted Pim: one person per deployment, "pim". */
export const SELF_HOSTED_USER = { id: base64UrlEncode(new TextEncoder().encode("pim")), name: "pim", displayName: "Pim" };

/** What the Worker signs into cookies, by kind. */
type Sealed = {
	/** `owner` is missing from sessions made before owners existed: those are a self-hosted Pim's. */
	session: { passkey: string; owner?: string };
	challenge: {
		challenge: string;
		ceremony: "create" | "get";
		/** The owner the ceremony was started for. */
		owner?: string;
		/** The setup code that allowed this passkey, if one did. */
		setup?: string;
		/** The digest of the recovery code that allowed this passkey, if one did. */
		recovery?: string;
		/** The device link that allowed this passkey, if one did. */
		device?: string;
		/** Set when the claim window allowed this passkey. */
		claim?: true;
	};
};

const encoder = new TextEncoder();

/** Cookie-signing keys, read from each owner's Auth object once per isolate. */
const signingKeys = new Map<string, Promise<CryptoKey>>();
/** Plenty for the owners one isolate serves at once; beyond it, keys are read again. */
const MAX_CACHED_KEYS = 1000;

function cookieKey(site: AuthSite): Promise<CryptoKey> {
	let key = signingKeys.get(site.owner);
	if (!key) {
		if (signingKeys.size >= MAX_CACHED_KEYS) signingKeys.clear();
		key = site.store
			.cookieKey()
			.then((raw) => crypto.subtle.importKey("raw", base64UrlDecode(raw), { name: "HMAC", hash: "SHA-256" }, false, ["sign", "verify"]));
		signingKeys.set(site.owner, key);
		key.catch(() => signingKeys.delete(site.owner));
	}
	return key;
}

/** Forgets an owner's cached key, after their Auth object was wiped. */
export function forgetSigningKey(owner: string): void {
	signingKeys.delete(owner);
}

async function seal<K extends keyof Sealed>(site: AuthSite, kind: K, value: Sealed[K], seconds: number, now: number): Promise<string> {
	const exp = Math.floor(now / 1000) + seconds;
	const body = base64UrlEncode(encoder.encode(JSON.stringify({ kind, exp, value })));
	const mac = await crypto.subtle.sign("HMAC", await cookieKey(site), encoder.encode(body));
	return `${body}.${base64UrlEncode(new Uint8Array(mac))}`;
}

async function unseal<K extends keyof Sealed>(site: AuthSite, kind: K, token: string | null, now: number): Promise<Sealed[K] | null> {
	const [body, mac, ...rest] = token?.split(".") ?? [];
	if (!body || !mac || rest.length > 0) return null;
	try {
		const valid = await crypto.subtle.verify("HMAC", await cookieKey(site), base64UrlDecode(mac), encoder.encode(body));
		if (!valid) return null;
		const payload = JSON.parse(new TextDecoder().decode(base64UrlDecode(body)));
		if (payload.kind !== kind) return null;
		if (typeof payload.exp !== "number" || payload.exp <= now / 1000) return null;
		return payload.value as Sealed[K];
	} catch {
		return null;
	}
}

/** The owner a sealed value was made for: older self-hosted cookies name none, and are that one owner's. */
function sealedOwner(site: AuthSite, value: { owner?: string }): string | null {
	return value.owner ?? (site.mode === "self-hosted" ? site.owner : null);
}

function readCookie(request: Request, name: string): string | null {
	for (const part of (request.headers.get("cookie") ?? "").split(";")) {
		const [key, ...value] = part.trim().split("=");
		if (key === name) return value.join("=");
	}
	return null;
}

function setCookie(name: string, value: string, seconds: number): string {
	return `${name}=${value}; Path=/; Secure; HttpOnly; SameSite=Strict; Max-Age=${seconds}`;
}

const clearCookie = (name: string) => setCookie(name, "", 0);

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

/** The passkey session `request` carries for this owner, if it is still good. */
export async function currentSession(request: Request, site: AuthSite, now = Date.now()): Promise<Session | null> {
	const sealed = await unseal(site, "session", readCookie(request, SESSION_COOKIE), now);
	if (!sealed || sealedOwner(site, sealed) !== site.owner) return null;
	return (await site.store.hasPasskey(sealed.passkey)) ? { passkey: sealed.passkey, owner: site.owner } : null;
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

/** Whether an unclaimed self-hosted Pim still takes its first passkey from anyone: the window after this version was deployed. */
async function claimOpen(env: Env, site: AuthSite, now: number): Promise<boolean> {
	if (site.mode !== "self-hosted") return false;
	const deployed = Date.parse(env.CF_VERSION_METADATA?.timestamp ?? "");
	if (!(now >= deployed && now < deployed + CLAIM_WINDOW_MS)) return false;
	return !(await site.store.claimed());
}

type AllowedBy = { setup?: string; recovery?: string; device?: string; claim?: true };

async function challengeCookie(site: AuthSite, ceremony: "create" | "get", now: number, allowedBy: AllowedBy = {}) {
	const challenge = base64UrlEncode(crypto.getRandomValues(new Uint8Array(32)));
	const sealed = await seal(site, "challenge", { challenge, ceremony, owner: site.owner, ...allowedBy }, CHALLENGE_SECONDS, now);
	return { challenge, cookie: setCookie(CHALLENGE_COOKIE, sealed, CHALLENGE_SECONDS) };
}

async function sessionCookie(site: AuthSite, passkey: string, now: number) {
	return setCookie(SESSION_COOKIE, await seal(site, "session", { passkey, owner: site.owner }, SESSION_SECONDS, now), SESSION_SECONDS);
}

/** Answers `/auth/*`: sign-in, sign-out, setup links, recovery codes, API tokens, and managing passkeys. */
export async function handleAuth(request: Request, env: Env, site: AuthSite, now = Date.now()): Promise<Response> {
	if (fromAnotherSite(request)) return fail(403, "Requests must come from this app");
	const url = new URL(request.url);
	const path = url.pathname.slice("/auth".length);
	// Passkeys belong to the hostname the app is served from.
	const ceremonySite = { rpId: url.hostname, origin: url.origin };
	const route = `${request.method} ${path}`;
	const store = site.store;
	const hosted = site.mode === "hosted";
	const pendingChallenge = async () => {
		const challenge = await unseal(site, "challenge", readCookie(request, CHALLENGE_COOKIE), now);
		return challenge && sealedOwner(site, challenge) === site.owner ? challenge : null;
	};

	if (route === "GET /session") {
		const [session, passkeys, canClaim] = await Promise.all([currentSession(request, site, now), store.passkeys(), claimOpen(env, site, now)]);
		return json({
			signedIn: session !== null,
			method: session ? "passkey" : null,
			passkey: session?.passkey ?? null,
			hasPasskeys: passkeys.length > 0,
			canClaim,
			// How someone without a passkey gets one: a setup link from the logs, or a recovery code.
			recovery: hosted ? "codes" : "logs",
			account: session && site.account ? site.account : null,
			// Whose Pim this is, for screens shown before signing in: the hostname says it already.
			host: url.host,
		});
	}

	if (route === "POST /setup-link") {
		// Hosted, the logs are the operator's, not the owner's: a link there would let the operator in.
		if (hosted) return fail(404, "Use one of your recovery codes to add a passkey.");
		// Anyone may ask; only the account's owner can read the logs it lands in.
		const { code, expiresAt } = await store.setupCode(now);
		const until = new Date(expiresAt).toISOString();
		console.log(`Pim setup link. Open it to create a passkey; it works once, until ${until}: ${ceremonySite.origin}/#setup=${code}`);
		return json({ expiresAt: until });
	}

	if (route === "POST /sign-in/options") {
		const { challenge, cookie } = await challengeCookie(site, "get", now);
		return json({ challenge, rpId: ceremonySite.rpId, userVerification: "required", timeout: CHALLENGE_SECONDS * 1000 }, 200, [cookie]);
	}

	if (route === "POST /sign-in") {
		const pending = await pendingChallenge();
		if (pending?.ceremony !== "get") return fail(400, "Signing in took too long. Try again.");
		const assertion = await readBody<Assertion>(request, {
			id: "string",
			clientDataJSON: "string",
			authenticatorData: "string",
			signature: "string",
		});
		const key = assertion && (await store.publicKey(assertion.id));
		const valid = key && (await verifyAssertion(assertion, key, { ...ceremonySite, challenge: pending.challenge }));
		if (!assertion || !valid) return fail(401, "That passkey isn't one of this Pim's.");
		await store.usePasskey(assertion.id, now);
		return json({ ok: true }, 200, [await sessionCookie(site, assertion.id, now), clearCookie(CHALLENGE_COOKIE)]);
	}

	if (route === "POST /sign-out") {
		// A link this browser made for another device dies with its session.
		const session = await currentSession(request, site, now);
		if (session) await store.voidDeviceLinks(session.passkey);
		return json({ ok: true }, 200, [clearCookie(SESSION_COOKIE)]);
	}

	if (route === "POST /passkeys/options") {
		const body = (await request.json().catch(() => null)) as { setup?: unknown; recovery?: unknown; device?: unknown } | null;
		const signedIn = (await currentSession(request, site, now)) !== null;
		let allowedBy: AllowedBy = {};
		if (!signedIn) {
			const setup = typeof body?.setup === "string" ? body.setup : undefined;
			const recovery = hosted && typeof body?.recovery === "string" ? await digestHex(normalizeRecoveryCode(body.recovery)) : undefined;
			const device = typeof body?.device === "string" ? body.device : undefined;
			if (setup && (await store.isSetupCode(setup, now))) allowedBy = { setup };
			else if (recovery && (await store.isRecoveryCode(recovery))) allowedBy = { recovery };
			else if (device && (await store.isDeviceLink(device, now))) allowedBy = { device };
			else if (!setup && !recovery && !device && (await claimOpen(env, site, now))) allowedBy = { claim: true };
			else if (setup) return fail(401, "This setup link has expired or was already used. Get a new one from the sign-in screen.");
			else if (recovery) return fail(401, "That recovery code isn't valid, or it was already used.");
			else if (device) return fail(401, "This link has expired or was already used. Make a new one on a device that's signed in.");
			else return fail(401, "Sign in to add a passkey.");
		}
		const { challenge, cookie } = await challengeCookie(site, "create", now, allowedBy);
		const existing = await store.passkeys();
		return json(
			{
				challenge,
				rp: { id: ceremonySite.rpId, name: hosted ? "Pimling" : "Pim" },
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
		// Only issued above, to someone signed in or holding a setup link or recovery code.
		const pending = await pendingChallenge();
		if (pending?.ceremony !== "create") return fail(400, "Creating the passkey took too long. Try again.");
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
		let passkey: Passkey | null;
		if (pending.claim) {
			// Two visitors could have opened the window at once; only one claims it.
			passkey = await store.claim(registration.id, key, name, now);
			if (!passkey) return fail(401, "This Pim already has a passkey. Sign in with it.");
			console.log(`Pim's first passkey was created: ${name}, at ${new Date(now).toISOString()}.`);
		} else {
			passkey = await store.addPasskey(registration.id, key, name, now);
		}
		if (pending.setup || pending.recovery || pending.device || pending.claim) {
			const by = pending.recovery ? "recovery" : pending.device ? "device_link" : pending.claim ? "claim" : "setup";
			console.log(JSON.stringify({ event: "pim.passkey_created", owner: site.owner, by }));
			await site.onPasskeyCreated?.();
		}
		// A browser already signed in with a passkey stays on its own.
		const session = await currentSession(request, site, now);
		const cookies = [clearCookie(CHALLENGE_COOKIE)];
		if (!session) cookies.push(await sessionCookie(site, registration.id, now));
		return json(passkey, 200, cookies);
	}

	// Everything below needs a passkey session: an API token can't manage sign-in.
	const signedIn = async () => currentSession(request, site, now);

	if (path === "/passkeys" || path.startsWith("/passkeys/")) {
		const session = await signedIn();
		if (!session) return fail(401, "Sign in to Pim");
		if (route === "GET /passkeys") return json({ passkeys: await store.passkeys() });
		if (request.method === "DELETE" && path.startsWith("/passkeys/")) {
			const id = decodeURIComponent(path.slice("/passkeys/".length));
			await store.removePasskey(id);
			return json({ ok: true }, 200, session.passkey === id ? [clearCookie(SESSION_COOKIE)] : []);
		}
	}

	if (route === "POST /device-link") {
		// A passkey session only: an API token can't hand out sign-in to a new device.
		const session = await signedIn();
		if (!session) return fail(401, "Sign in to Pim");
		const { code, expiresAt } = await store.newDeviceLink(session.passkey, now);
		console.log(JSON.stringify({ event: "pim.device_link_issued", owner: site.owner }));
		// The code goes in the fragment, so it never reaches a server's logs or a Referer header.
		return json({ url: `${ceremonySite.origin}/#device=${code}`, expiresAt: new Date(expiresAt).toISOString() }, 201);
	}

	if (route === "DELETE /device-link") {
		// Done or changed one's mind: the link this browser made stops working now, not in ten minutes.
		const session = await signedIn();
		if (!session) return fail(401, "Sign in to Pim");
		await store.voidDeviceLinks(session.passkey);
		return json({ ok: true });
	}

	if (path === "/recovery-codes" && hosted) {
		if (!(await signedIn())) return fail(401, "Sign in to Pim");
		if (route === "GET /recovery-codes") return json({ left: await store.recoveryCodesLeft() });
		if (route === "POST /recovery-codes") {
			console.log(JSON.stringify({ event: "pim.recovery_codes_replaced", owner: site.owner }));
			return json({ codes: await store.newRecoveryCodes(now) });
		}
	}

	if (path === "/tokens" || path.startsWith("/tokens/")) {
		if (!(await signedIn())) return fail(401, "Sign in to Pim");
		if (route === "GET /tokens") return json({ tokens: await store.tokens() });
		if (route === "POST /tokens") {
			const body = (await request.json().catch(() => null)) as { name?: unknown } | null;
			const name = typeof body?.name === "string" ? body.name.trim().slice(0, 64) : "";
			if (name === "") return fail(400, "Give the token a name, such as the app that will use it.");
			if ((await store.tokens()).length >= MAX_TOKENS) return fail(429, `You can have up to ${MAX_TOKENS} tokens. Revoke one first.`);
			return json(await store.createToken(name, now), 201);
		}
		if (request.method === "DELETE" && path.startsWith("/tokens/")) {
			const id = decodeURIComponent(path.slice("/tokens/".length));
			return (await store.revokeToken(id)) ? json({ ok: true }) : fail(404, `No token ${id}`);
		}
	}

	return fail(404, "Not found");
}

/** API tokens one Pim may have. */
const MAX_TOKENS = 20;

/** Whether `token` is one this owner made in Settings. */
export async function ownerToken(site: AuthSite, token: string, now = Date.now()): Promise<boolean> {
	return token.startsWith("pim_") && (await site.store.checkToken(token, now));
}
