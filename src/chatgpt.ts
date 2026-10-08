import type { Model, Api, Models, OAuthAuth, OAuthCredential, Provider } from "@earendil-works/pi-ai";
import { openaiProvider } from "@earendil-works/pi-ai/providers/openai";
import { HttpError } from "./http";
import type { PimStore } from "./store";

/**
 * Sign in with ChatGPT, so Pim's requests use the person's ChatGPT plan
 * (https://developers.openai.com/siwc/token-sharing-open-source).
 *
 * OpenAI only redirects to a loopback address, which cannot reach a Worker.
 * So Pim starts the sign-in, the person approves it in their browser, and the
 * browser lands on a `http://127.0.0.1:1455/...` page that does not load;
 * they paste that address back, and Pim finishes the exchange itself. Pim
 * keeps its own agent host ID, and refreshes the tokens from then on.
 *
 * pi-ai's own flow runs a local callback server and is loaded through an
 * import bundlers cannot follow, so it cannot run in a Worker; this is the
 * same protocol over `fetch`.
 */

export const CHATGPT_PROVIDER = "openai";

const ISSUER = "https://auth.openai.com";
const AUTHORIZE_URL = `${ISSUER}/api/accounts/authorize`;
const TOKEN_URL = `${ISSUER}/api/accounts/oauth/token`;
const JWKS_URL = `${ISSUER}/.well-known/jwks.json`;
const MODELS_URL = "https://api.openai.com/v1/models";
const RESOURCE = "https://api.openai.com/v1";
const REDIRECT_URI = "http://127.0.0.1:1455/auth/callback";
const DYNAMIC_CLIENT_ID = "dynamic_agent_client";
const AGENT_NAME = "Pim";
const PLAN_SCOPE = "chatgpt.tokens.use.direct";
const SCOPE = `openid profile email offline_access resource.invoke ${PLAN_SCOPE}`;
/** A started sign-in can be finished for this long. */
const LOGIN_TTL_MS = 15 * 60 * 1000;
/** Refresh this long before expiry, so no request starts with a token about to lapse. */
const EXPIRY_MARGIN_MS = 3 * 60 * 1000;

const HOST_ID_KEY = "chatgpt_host_id";
const PENDING_KEY = "chatgpt_login";

/** pi-ai's OAuth credential, plus what Pim keeps about the account. */
export type ChatGPTCredential = OAuthCredential & {
	readonly clientId: string;
	readonly scopes: readonly string[];
	readonly idToken: string;
	readonly subject: string;
	readonly email: string | null;
};

export type ChatGPTStatus = {
	readonly connected: boolean;
	readonly email: string | null;
};

type PendingLogin = {
	readonly state: string;
	readonly nonce: string;
	readonly verifier: string;
	/** The account's issued client, for a returning sign-in. */
	readonly clientId: string | null;
	readonly startedAt: number;
};

type TokenResponse = {
	access_token?: unknown;
	refresh_token?: unknown;
	id_token?: unknown;
	scope?: unknown;
	expires_in?: unknown;
};

/** Where the credential lives: pi-ai's store, so `Models` refreshes it. */
export type ChatGPTCredentials = {
	read(): Promise<ChatGPTCredential | undefined>;
	write(credential: ChatGPTCredential): Promise<void>;
	delete(): Promise<void>;
};

function base64url(bytes: ArrayBuffer | Uint8Array): string {
	const array = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
	let binary = "";
	for (const byte of array) binary += String.fromCharCode(byte);
	return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function fromBase64url(part: string): Uint8Array<ArrayBuffer> {
	const base64 = part.replace(/-/g, "+").replace(/_/g, "/");
	const padded = base64 + "=".repeat((4 - (base64.length % 4)) % 4);
	return Uint8Array.from(atob(padded), (c) => c.charCodeAt(0));
}

function randomValue(): string {
	return base64url(crypto.getRandomValues(new Uint8Array(32)));
}

async function challengeOf(verifier: string): Promise<string> {
	return base64url(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier)));
}

async function requestToken(body: URLSearchParams): Promise<TokenResponse> {
	const response = await fetch(TOKEN_URL, {
		method: "POST",
		headers: { accept: "application/json", "content-type": "application/x-www-form-urlencoded" },
		body,
	});
	if (!response.ok) {
		const text = await response.text().catch(() => "");
		throw new Error(`OpenAI token request failed (${response.status}): ${text || response.statusText}`);
	}
	return (await response.json()) as TokenResponse;
}

type IdClaims = { sub: string; email: string | null };

/** Checks an ID token's signature against OpenAI's keys, and its claims. */
export async function verifyIdToken(
	token: string,
	expected: { clientId: string; nonce?: string },
	now = Date.now(),
): Promise<IdClaims> {
	const parts = token.split(".");
	if (parts.length !== 3) throw new Error("The ID token is malformed");
	const [headerPart, payloadPart, signaturePart] = parts as [string, string, string];
	const decode = (part: string) => JSON.parse(new TextDecoder().decode(fromBase64url(part))) as Record<string, unknown>;
	const header = decode(headerPart);
	const claims = decode(payloadPart);
	if (header.alg !== "RS256") throw new Error("The ID token is not RS256");

	const response = await fetch(JWKS_URL);
	if (!response.ok) throw new Error(`OpenAI's keys answered ${response.status}`);
	const { keys } = (await response.json()) as { keys: (JsonWebKey & { kid?: string })[] };
	const jwk = keys.find((key) => key.kid === header.kid);
	if (!jwk) throw new Error("The ID token is signed with an unknown key");
	const key = await crypto.subtle.importKey("jwk", jwk, { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" }, false, [
		"verify",
	]);
	const valid = await crypto.subtle.verify(
		"RSASSA-PKCS1-v1_5",
		key,
		fromBase64url(signaturePart),
		new TextEncoder().encode(`${headerPart}.${payloadPart}`),
	);
	if (!valid) throw new Error("The ID token's signature is invalid");

	const audiences = Array.isArray(claims.aud) ? claims.aud : [claims.aud];
	if (claims.iss !== ISSUER) throw new Error("The ID token is from another issuer");
	if (!audiences.includes(expected.clientId)) throw new Error("The ID token is for another client");
	if (typeof claims.exp !== "number" || claims.exp * 1000 <= now) throw new Error("The ID token has expired");
	if (expected.nonce !== undefined && claims.nonce !== expected.nonce) throw new Error("The ID token's nonce does not match");
	if (typeof claims.sub !== "string" || claims.sub === "") throw new Error("The ID token has no subject");
	return { sub: claims.sub, email: typeof claims.email === "string" ? claims.email : null };
}

function scopesOf(token: TokenResponse, fallback: readonly string[]): string[] {
	return typeof token.scope === "string" ? token.scope.trim().split(/\s+/).filter(Boolean) : [...fallback];
}

function expiresAt(token: TokenResponse): number {
	if (typeof token.expires_in !== "number" || !(token.expires_in > 0)) {
		throw new Error("OpenAI's token response has no valid expires_in");
	}
	return Date.now() + token.expires_in * 1000 - EXPIRY_MARGIN_MS;
}

/** The address the person pastes back, read into the authorization result. */
function callbackResult(input: string, pending: PendingLogin): { code: string; clientId: string } {
	let url: URL;
	try {
		url = new URL(input.trim());
	} catch {
		throw new HttpError(400, "Paste the whole address from the browser, starting with http://127.0.0.1");
	}
	const expected = new URL(REDIRECT_URI);
	if (url.origin !== expected.origin || url.pathname !== expected.pathname) {
		throw new HttpError(400, `The address must start with ${REDIRECT_URI}`);
	}
	if (url.searchParams.get("state") !== pending.state) {
		throw new HttpError(400, "That address is from another sign-in. Start again.");
	}
	const error = url.searchParams.get("error");
	if (error === "access_denied") {
		throw new HttpError(400, "ChatGPT plan use was not approved. Start again and allow it to use Pim.");
	}
	if (error) throw new HttpError(400, `ChatGPT sign-in failed: ${error}`);
	const code = url.searchParams.get("code");
	if (!code) throw new HttpError(400, "The address has no authorization code");
	const issued = url.searchParams.get("client_id")?.trim() || null;
	if (pending.clientId !== null && issued !== null && issued !== pending.clientId) {
		throw new HttpError(400, "The address is for another ChatGPT registration. Start again.");
	}
	const clientId = pending.clientId ?? issued;
	if (!clientId) throw new HttpError(400, "The address has no client_id, so registration did not finish. Start again.");
	return { code, clientId };
}

export class ChatGPT {
	readonly #store: PimStore;
	readonly #credentials: ChatGPTCredentials;

	constructor(store: PimStore, credentials: ChatGPTCredentials) {
		this.#store = store;
		this.#credentials = credentials;
	}

	/** This deployment, to OpenAI: one agent host, the same across sign-ins. */
	hostId(): string {
		let id = this.#store.meta(HOST_ID_KEY);
		if (id === undefined) {
			id = `urn:uuid:${crypto.randomUUID()}`;
			this.#store.setMeta(HOST_ID_KEY, id);
		}
		return id;
	}

	async status(): Promise<ChatGPTStatus> {
		const credential = await this.#credentials.read();
		return { connected: credential !== undefined, email: credential?.email ?? null };
	}

	/** Starts a sign-in; the person opens `url`. A new start replaces an unfinished one. */
	async startLogin(): Promise<{ url: string }> {
		const saved = await this.#credentials.read();
		const pending: PendingLogin = {
			state: randomValue(),
			nonce: randomValue(),
			verifier: randomValue(),
			clientId: saved?.clientId ?? null,
			startedAt: Date.now(),
		};
		this.#store.setMeta(PENDING_KEY, JSON.stringify(pending));
		const url = new URL(AUTHORIZE_URL);
		url.search = new URLSearchParams({
			client_id: pending.clientId ?? DYNAMIC_CLIENT_ID,
			...(pending.clientId === null ? { agent_name_hint: AGENT_NAME } : { id_token_hint: saved!.idToken }),
			ext_agent_host_id: this.hostId(),
			response_type: "code",
			redirect_uri: REDIRECT_URI,
			resource: RESOURCE,
			scope: SCOPE,
			state: pending.state,
			nonce: pending.nonce,
			code_challenge: await challengeOf(pending.verifier),
			code_challenge_method: "S256",
		}).toString();
		return { url: url.toString() };
	}

	/** Finishes the sign-in from the address the browser landed on. */
	async finishLogin(callbackUrl: string): Promise<ChatGPTStatus> {
		const json = this.#store.meta(PENDING_KEY);
		const pending = json === undefined ? undefined : (JSON.parse(json) as PendingLogin);
		if (!pending || Date.now() - pending.startedAt > LOGIN_TTL_MS) {
			throw new HttpError(409, "No sign-in is waiting. Start again.");
		}
		const { code, clientId } = callbackResult(callbackUrl, pending);
		// A code is single-use: whatever happens next, this sign-in is spent.
		this.#store.deleteMeta(PENDING_KEY);

		let token: TokenResponse;
		try {
			token = await requestToken(
				new URLSearchParams({
					grant_type: "authorization_code",
					client_id: clientId,
					code,
					code_verifier: pending.verifier,
					redirect_uri: REDIRECT_URI,
					resource: RESOURCE,
				}),
			);
		} catch (error) {
			throw new HttpError(502, error instanceof Error ? error.message : String(error));
		}
		if (typeof token.access_token !== "string" || typeof token.refresh_token !== "string") {
			throw new HttpError(502, "OpenAI's token response is missing tokens");
		}
		if (typeof token.id_token !== "string") throw new HttpError(502, "OpenAI's token response has no ID token");
		const scopes = scopesOf(token, []);
		if (!scopes.includes(PLAN_SCOPE)) {
			throw new HttpError(403, "ChatGPT signed you in, but did not allow Pim to use your plan. Check your plan includes it.");
		}
		let identity: IdClaims;
		try {
			identity = await verifyIdToken(token.id_token, { clientId, nonce: pending.nonce });
		} catch (error) {
			throw new HttpError(502, error instanceof Error ? error.message : String(error));
		}
		const saved = await this.#credentials.read();
		if (saved && saved.clientId === clientId && saved.subject !== identity.sub) {
			throw new HttpError(409, "That is a different ChatGPT account. Disconnect the current one first.");
		}
		await this.#credentials.write({
			type: "oauth",
			access: token.access_token,
			refresh: token.refresh_token,
			expires: expiresAt(token),
			clientId,
			scopes,
			idToken: token.id_token,
			subject: identity.sub,
			email: identity.email,
		});
		return { connected: true, email: identity.email };
	}

	async logout(): Promise<void> {
		this.#store.deleteMeta(PENDING_KEY);
		await this.#credentials.delete();
	}

	/** The OAuth method pi-ai calls to refresh and apply the token. */
	readonly oauth: OAuthAuth = {
		name: "OpenAI (ChatGPT plan)",
		isSubscription: true,
		loginLabel: "Continue with ChatGPT",
		login: async () => {
			throw new Error("Sign in to ChatGPT through Pim's API: POST /chatgpt/login");
		},
		refresh: async (credential) => {
			const current = credential as ChatGPTCredential;
			const token = await requestToken(
				new URLSearchParams({
					grant_type: "refresh_token",
					client_id: current.clientId,
					refresh_token: current.refresh,
					resource: RESOURCE,
				}),
			);
			if (typeof token.access_token !== "string") throw new Error("OpenAI's refresh response has no access token");
			const refreshed: ChatGPTCredential = {
				...current,
				access: token.access_token,
				// Rotated when present; otherwise the old one stays valid.
				refresh: typeof token.refresh_token === "string" ? token.refresh_token : current.refresh,
				expires: expiresAt(token),
				scopes: scopesOf(token, current.scopes),
				idToken: typeof token.id_token === "string" ? token.id_token : current.idToken,
			};
			return refreshed;
		},
		toAuth: async (credential) => ({ apiKey: credential.access }),
	};

	/** pi-ai's OpenAI provider, authenticated only by the ChatGPT plan. */
	provider(): Provider {
		return { ...openaiProvider(), auth: { oauth: this.oauth } };
	}

	/**
	 * The models the signed-in account can use that pi-ai knows how to call,
	 * in OpenAI's order. Empty when not signed in.
	 */
	async models(models: Models): Promise<Model<Api>[]> {
		const auth = await models.getAuth(CHATGPT_PROVIDER);
		const token = auth?.auth.apiKey;
		if (!token) return [];
		const response = await fetch(MODELS_URL, { headers: { authorization: `Bearer ${token}` } });
		if (!response.ok) throw new Error(`OpenAI's model list answered ${response.status}`);
		const body = (await response.json()) as {
			models?: { slug?: string; visibility?: string }[];
			data?: { id?: string }[];
		};
		const slugs = body.models
			? body.models.filter((entry) => entry.visibility === undefined || entry.visibility === "list").map((entry) => entry.slug)
			: (body.data ?? []).map((entry) => entry.id);
		return slugs.flatMap((slug) => {
			const model = slug === undefined ? undefined : models.getModel(CHATGPT_PROVIDER, slug);
			return model ? [model] : [];
		});
	}
}

/** The ChatGPT credential, kept in pi-ai's store under the provider id. */
export function chatgptCredentials(store: {
	read(id: string): Promise<unknown>;
	modify(id: string, fn: () => Promise<OAuthCredential>): Promise<unknown>;
	delete(id: string): Promise<void>;
}): ChatGPTCredentials {
	return {
		read: async () => (await store.read(CHATGPT_PROVIDER)) as ChatGPTCredential | undefined,
		write: async (credential) => {
			await store.modify(CHATGPT_PROVIDER, async () => credential);
		},
		delete: () => store.delete(CHATGPT_PROVIDER),
	};
}
