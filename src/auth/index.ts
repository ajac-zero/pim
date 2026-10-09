/**
 * Signing in to the web app with passkeys.
 *
 * Passkeys live in the Auth Durable Object (./store.ts). Signing in sets a
 * session cookie the Worker signs with a key kept there, and removing a
 * passkey signs out the sessions it started. A new passkey takes one of:
 *
 * - a signed-in session;
 * - the claim window: in the first minutes after a deploy, a Pim that has
 *   never had a passkey lets whoever opens it create the first one, so a
 *   fresh deploy needs nothing but a click;
 * - a setup link, for a lost passkey or a missed window: a one-time code the
 *   Worker writes to its own logs when the sign-in screen asks. Reading those
 *   logs takes the Cloudflare account's login, which proves its holder owns
 *   this Pim.
 */

import { base64UrlDecode, base64UrlEncode } from "./encoding";
import type { Passkey } from "./store";
import { ALGORITHMS, type Assertion, type Registration, verifyAssertion, verifyRegistration } from "./webauthn";

export { Auth } from "./store";

export type Session = { readonly passkey: string };

const SESSION_COOKIE = "__Host-pim-session";
const CHALLENGE_COOKIE = "__Host-pim-challenge";
const SESSION_SECONDS = 30 * 24 * 60 * 60;
const CHALLENGE_SECONDS = 5 * 60;
/** How long after a deploy an unclaimed Pim takes its first passkey without a link. */
export const CLAIM_WINDOW_MS = 15 * 60 * 1000;
/** One person per deployment, so one WebAuthn user: "pim". */
const USER_ID = base64UrlEncode(new TextEncoder().encode("pim"));

/** What the Worker signs into cookies, by kind. */
type Sealed = {
	session: Session;
	challenge: {
		challenge: string;
		ceremony: "create" | "get";
		/** The setup code that allowed this passkey, if one did. */
		setup?: string;
		/** Set when the claim window allowed this passkey. */
		claim?: true;
	};
};

const encoder = new TextEncoder();

const authStore = (env: Env) => env.Auth.getByName("auth");

let signingKey: Promise<CryptoKey> | undefined;

/** The cookie-signing key, read from the Auth object once per isolate. */
function cookieKey(env: Env): Promise<CryptoKey> {
	signingKey ??= authStore(env)
		.cookieKey()
		.then((key) => crypto.subtle.importKey("raw", base64UrlDecode(key), { name: "HMAC", hash: "SHA-256" }, false, ["sign", "verify"]));
	signingKey.catch(() => (signingKey = undefined));
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

/** The passkey session `request` carries, if it is still good. */
export async function currentSession(request: Request, env: Env, now = Date.now()): Promise<Session | null> {
	const sealed = await unseal(env, "session", readCookie(request, SESSION_COOKIE), now);
	return sealed && (await authStore(env).hasPasskey(sealed.passkey)) ? sealed : null;
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

/** Whether an unclaimed Pim still takes its first passkey from anyone: the window after this version was deployed. */
async function claimOpen(env: Env, now: number): Promise<boolean> {
	const deployed = Date.parse(env.CF_VERSION_METADATA?.timestamp ?? "");
	if (!(now >= deployed && now < deployed + CLAIM_WINDOW_MS)) return false;
	return !(await authStore(env).claimed());
}

async function challengeCookie(env: Env, ceremony: "create" | "get", now: number, allowedBy: { setup?: string; claim?: true } = {}) {
	const challenge = base64UrlEncode(crypto.getRandomValues(new Uint8Array(32)));
	const sealed = await seal(env, "challenge", { challenge, ceremony, ...allowedBy }, CHALLENGE_SECONDS, now);
	return { challenge, cookie: setCookie(CHALLENGE_COOKIE, sealed, CHALLENGE_SECONDS) };
}

async function sessionCookie(env: Env, passkey: string, now: number) {
	return setCookie(SESSION_COOKIE, await seal(env, "session", { passkey }, SESSION_SECONDS, now), SESSION_SECONDS);
}

/** Answers `/auth/*`: sign-in, sign-out, setup links, and managing passkeys. */
export async function handleAuth(request: Request, env: Env, now = Date.now()): Promise<Response> {
	if (fromAnotherSite(request)) return fail(403, "Requests must come from this app");
	const url = new URL(request.url);
	const path = url.pathname.slice("/auth".length);
	// Passkeys belong to the hostname the app is served from.
	const site = { rpId: url.hostname, origin: url.origin };
	const route = `${request.method} ${path}`;
	const store = authStore(env);
	const pendingChallenge = () => unseal(env, "challenge", readCookie(request, CHALLENGE_COOKIE), now);

	if (route === "GET /session") {
		const [session, passkeys, canClaim] = await Promise.all([currentSession(request, env, now), store.passkeys(), claimOpen(env, now)]);
		return json({
			signedIn: session !== null,
			method: session ? "passkey" : null,
			passkey: session?.passkey ?? null,
			hasPasskeys: passkeys.length > 0,
			canClaim,
		});
	}

	if (route === "POST /setup-link") {
		// Anyone may ask; only the account's owner can read the logs it lands in.
		const { code, expiresAt } = await store.setupCode(now);
		const until = new Date(expiresAt).toISOString();
		console.log(`Pim setup link. Open it to create a passkey; it works once, until ${until}: ${site.origin}/#setup=${code}`);
		return json({ expiresAt: until });
	}

	if (route === "POST /sign-in/options") {
		const { challenge, cookie } = await challengeCookie(env, "get", now);
		return json({ challenge, rpId: site.rpId, userVerification: "required", timeout: CHALLENGE_SECONDS * 1000 }, 200, [cookie]);
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
		const valid = key && (await verifyAssertion(assertion, key, { ...site, challenge: pending.challenge }));
		if (!assertion || !valid) return fail(401, "That passkey isn't one of this Pim's.");
		await store.usePasskey(assertion.id, now);
		return json({ ok: true }, 200, [await sessionCookie(env, assertion.id, now), clearCookie(CHALLENGE_COOKIE)]);
	}

	if (route === "POST /sign-out") {
		return json({ ok: true }, 200, [clearCookie(SESSION_COOKIE)]);
	}

	if (route === "POST /passkeys/options") {
		const body = (await request.json().catch(() => null)) as { setup?: unknown } | null;
		const signedIn = (await currentSession(request, env, now)) !== null;
		const setup = !signedIn && typeof body?.setup === "string" ? body.setup : undefined;
		let allowedBy: { setup?: string; claim?: true } = {};
		if (!signedIn) {
			if (setup && (await store.isSetupCode(setup, now))) allowedBy = { setup };
			else if (!setup && (await claimOpen(env, now))) allowedBy = { claim: true };
			else if (setup) return fail(401, "This setup link has expired or was already used. Get a new one from the sign-in screen.");
			else return fail(401, "Sign in to add a passkey.");
		}
		const { challenge, cookie } = await challengeCookie(env, "create", now, allowedBy);
		const existing = await store.passkeys();
		return json(
			{
				challenge,
				rp: { id: site.rpId, name: "Pim" },
				user: { id: USER_ID, name: "pim", displayName: "Pim" },
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
		// Only issued above, to someone signed in or holding a setup link.
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
		const key = await verifyRegistration(registration, { ...site, challenge: pending.challenge });
		if (!key) return fail(400, "Couldn't verify the passkey.");
		// Two tabs could have started with the same link; only one finishes.
		if (pending.setup && !(await store.useSetupCode(pending.setup, now))) {
			return fail(401, "This setup link was already used.");
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
		// A browser already signed in with a passkey stays on its own.
		const session = await currentSession(request, env, now);
		const cookies = [clearCookie(CHALLENGE_COOKIE)];
		if (!session) cookies.push(await sessionCookie(env, registration.id, now));
		return json(passkey, 200, cookies);
	}

	if (path === "/passkeys" || path.startsWith("/passkeys/")) {
		const session = await currentSession(request, env, now);
		if (!session) return fail(401, "Sign in to Pim");
		if (route === "GET /passkeys") return json({ passkeys: await store.passkeys() });
		if (request.method === "DELETE" && path.startsWith("/passkeys/")) {
			const id = decodeURIComponent(path.slice("/passkeys/".length));
			await store.removePasskey(id);
			return json({ ok: true }, 200, session.passkey === id ? [clearCookie(SESSION_COOKIE)] : []);
		}
	}

	return fail(404, "Not found");
}
