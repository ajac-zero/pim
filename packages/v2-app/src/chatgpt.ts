import { createHash, randomUUID } from "node:crypto";
import type { EnvelopeCrypto } from "@pim/v2-contracts/platform";
import type { Principal } from "@pim/v2-contracts/identity";
import { Authorizer } from "./authz.ts";
import { openString, sealString } from "./crypto.ts";
import type { Db } from "./db.ts";
import { BadRequestError, ConflictError, PimError } from "./errors.ts";

/**
 * Sign in with ChatGPT, so an owner's model requests use their ChatGPT plan (https://developers.openai.com/siwc/token-sharing-open-source).
 *
 * OpenAI only redirects to a loopback address, which a deployment cannot receive. So Pim starts the sign-in, the person approves it in their browser, the browser
 * lands on a `http://127.0.0.1:1455/...` page that does not load, and they paste that address back; Pim finishes the exchange itself and refreshes the tokens from then on.
 * The credential is sealed with the deployment's key ring, bound to its owner, in `pim_app.chatgpt_credentials`; no route returns it. The Runner reads and refreshes it
 * through the definer functions of migration 0610 (`refreshChatGPT` below is the protocol it uses, under the row's lock).
 */

/** The provider id of the models that run on the plan. */
export const CHATGPT_PROVIDER = "openai";

export type ChatGPTEndpoints = { issuer: string; modelsUrl: string; resource: string };
export const OPENAI_ENDPOINTS: ChatGPTEndpoints = { issuer: "https://auth.openai.com", modelsUrl: "https://api.openai.com/v1/models", resource: "https://api.openai.com/v1" };

const REDIRECT_URI = "http://127.0.0.1:1455/auth/callback";
const DYNAMIC_CLIENT_ID = "dynamic_agent_client";
const AGENT_NAME = "Pim";
const PLAN_SCOPE = "chatgpt.tokens.use.direct";
const SCOPE = `openid profile email offline_access resource.invoke ${PLAN_SCOPE}`;
/** A started sign-in can be finished for this long. */
const LOGIN_TTL_MS = 15 * 60 * 1000;
/** Tokens count as expired this long before they are, so no request starts with one about to lapse. */
const EXPIRY_MARGIN_MS = 3 * 60 * 1000;

export type ChatGPTCredential = {
	type: "oauth";
	access: string;
	refresh: string;
	/** Epoch milliseconds, already short of the real expiry by the margin. */
	expires: number;
	clientId: string;
	scopes: string[];
	idToken: string;
	subject: string;
	email: string | null;
};
export type ChatGPTStatus = { connected: boolean; email: string | null };
type Pending = { state: string; nonce: string; verifier: string; clientId: string | null; startedAt: number };
type TokenResponse = { access_token?: unknown; refresh_token?: unknown; id_token?: unknown; scope?: unknown; expires_in?: unknown };
type Fetch = typeof fetch;

const b64u = (bytes: Uint8Array) => Buffer.from(bytes).toString("base64url");
const randomValue = () => b64u(crypto.getRandomValues(new Uint8Array(32)));
const challengeOf = (verifier: string) => createHash("sha256").update(verifier).digest("base64url");
export const chatgptContext = (ownerId: string) => `chatgpt:${ownerId}`;

async function requestToken(fetcher: Fetch, issuer: string, body: URLSearchParams): Promise<TokenResponse> {
	const response = await fetcher(`${issuer}/api/accounts/oauth/token`, { method: "POST", headers: { accept: "application/json", "content-type": "application/x-www-form-urlencoded" }, body, signal: AbortSignal.timeout(30_000) });
	if (!response.ok) throw new Error(`OpenAI token request failed (${response.status}): ${(await response.text().catch(() => "")) || response.statusText}`);
	return (await response.json()) as TokenResponse;
}

const scopesOf = (token: TokenResponse, fallback: readonly string[]) => (typeof token.scope === "string" ? token.scope.trim().split(/\s+/).filter(Boolean) : [...fallback]);

function expiresAt(token: TokenResponse, now: number): number {
	if (typeof token.expires_in !== "number" || !(token.expires_in > 0)) throw new Error("OpenAI's token response has no valid expires_in");
	return now + token.expires_in * 1000 - EXPIRY_MARGIN_MS;
}

/** Trades a credential's refresh token for new tokens. A rotated refresh token replaces the old one; otherwise the old one stays valid. */
export async function refreshChatGPT(current: ChatGPTCredential, options: { fetch?: Fetch | undefined; endpoints?: ChatGPTEndpoints | undefined; now?: number | undefined } = {}): Promise<ChatGPTCredential> {
	const endpoints = options.endpoints ?? OPENAI_ENDPOINTS;
	const token = await requestToken(options.fetch ?? fetch, endpoints.issuer, new URLSearchParams({ grant_type: "refresh_token", client_id: current.clientId, refresh_token: current.refresh, resource: endpoints.resource }));
	if (typeof token.access_token !== "string") throw new Error("OpenAI's refresh response has no access token");
	return {
		...current,
		access: token.access_token,
		refresh: typeof token.refresh_token === "string" ? token.refresh_token : current.refresh,
		expires: expiresAt(token, options.now ?? Date.now()),
		scopes: scopesOf(token, current.scopes),
		idToken: typeof token.id_token === "string" ? token.id_token : current.idToken,
	};
}

/** Checks an ID token's signature against the issuer's keys, and its claims. */
async function verifyIdToken(fetcher: Fetch, issuer: string, token: string, expected: { clientId: string; nonce: string }, now: number): Promise<{ sub: string; email: string | null }> {
	const parts = token.split(".");
	if (parts.length !== 3) throw new Error("The ID token is malformed");
	const [headerPart, payloadPart, signaturePart] = parts as [string, string, string];
	const decode = (part: string) => JSON.parse(Buffer.from(part, "base64url").toString()) as Record<string, unknown>;
	const header = decode(headerPart);
	const claims = decode(payloadPart);
	if (header.alg !== "RS256") throw new Error("The ID token is not RS256");
	const response = await fetcher(`${issuer}/.well-known/jwks.json`, { signal: AbortSignal.timeout(30_000) });
	if (!response.ok) throw new Error(`OpenAI's keys answered ${response.status}`);
	const { keys } = (await response.json()) as { keys: (Record<string, unknown> & { kid?: string })[] };
	const jwk = keys.find((key) => key.kid === header.kid);
	if (!jwk) throw new Error("The ID token is signed with an unknown key");
	const key = await crypto.subtle.importKey("jwk", jwk as never, { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" }, false, ["verify"]);
	if (!(await crypto.subtle.verify("RSASSA-PKCS1-v1_5", key, Buffer.from(signaturePart, "base64url"), new TextEncoder().encode(`${headerPart}.${payloadPart}`)))) throw new Error("The ID token's signature is invalid");
	const audiences = Array.isArray(claims.aud) ? claims.aud : [claims.aud];
	if (claims.iss !== issuer) throw new Error("The ID token is from another issuer");
	if (!audiences.includes(expected.clientId)) throw new Error("The ID token is for another client");
	if (typeof claims.exp !== "number" || claims.exp * 1000 <= now) throw new Error("The ID token has expired");
	if (claims.nonce !== expected.nonce) throw new Error("The ID token's nonce does not match");
	if (typeof claims.sub !== "string" || claims.sub === "") throw new Error("The ID token has no subject");
	return { sub: claims.sub, email: typeof claims.email === "string" ? claims.email : null };
}

/** The address the person pastes back, read into the authorization result. */
function callbackResult(input: string, pending: Pending): { code: string; clientId: string } {
	let url: URL;
	try {
		url = new URL(input.trim());
	} catch {
		throw new BadRequestError("Paste the whole address from the browser, starting with http://127.0.0.1");
	}
	const expected = new URL(REDIRECT_URI);
	if (url.origin !== expected.origin || url.pathname !== expected.pathname) throw new BadRequestError(`The address must start with ${REDIRECT_URI}`);
	if (url.searchParams.get("state") !== pending.state) throw new BadRequestError("That address is from another sign-in. Start again.");
	const error = url.searchParams.get("error");
	if (error === "access_denied") throw new BadRequestError("ChatGPT plan use was not approved. Start again and allow it to use Pim.");
	if (error) throw new BadRequestError(`ChatGPT sign-in failed: ${error}`);
	const code = url.searchParams.get("code");
	if (!code) throw new BadRequestError("The address has no authorization code");
	const issued = url.searchParams.get("client_id")?.trim() || null;
	if (pending.clientId !== null && issued !== null && issued !== pending.clientId) throw new BadRequestError("The address is for another ChatGPT registration. Start again.");
	const clientId = pending.clientId ?? issued;
	if (!clientId) throw new BadRequestError("The address has no client_id, so registration did not finish. Start again.");
	return { code, clientId };
}

export type ChatGPTOptions = { fetch?: Fetch | undefined; endpoints?: ChatGPTEndpoints | undefined; now?: (() => number) | undefined };

export class ChatGPT {
	readonly #fetch: Fetch;
	readonly #endpoints: ChatGPTEndpoints;
	readonly #now: () => number;
	constructor(private readonly db: Db, private readonly crypto: EnvelopeCrypto, options: ChatGPTOptions = {}, private readonly authz = new Authorizer(db)) {
		this.#fetch = options.fetch ?? fetch;
		this.#endpoints = options.endpoints ?? OPENAI_ENDPOINTS;
		this.#now = options.now ?? Date.now;
	}

	async #credential(ownerId: string): Promise<ChatGPTCredential | undefined> {
		const secret = await this.db.owner(ownerId, async (tx) => (await tx.query("SELECT secret FROM pim_app.chatgpt_credentials WHERE secret IS NOT NULL")).rows[0]?.secret as string | undefined);
		return secret ? (JSON.parse(await openString(this.crypto, secret, chatgptContext(ownerId))) as ChatGPTCredential) : undefined;
	}

	/**
	 * A token for calling OpenAI on the owner's plan from the Gate (the utility model's side jobs), and where to call; null when they are not signed in. A token near its
	 * expiry is refreshed under the credential row's lock, as the Runner does, so a rotated refresh token is never spent twice.
	 */
	async access(ownerId: string): Promise<{ token: string; resource: string } | null> {
		const credential = await this.db.owner(ownerId, async (tx) => {
			const sealed = (await tx.query("SELECT secret FROM pim_app.chatgpt_credentials WHERE secret IS NOT NULL FOR UPDATE")).rows[0]?.secret as string | undefined;
			if (!sealed) return undefined;
			const current = JSON.parse(await openString(this.crypto, sealed, chatgptContext(ownerId))) as ChatGPTCredential;
			if (current.expires > this.#now()) return current;
			const next = await refreshChatGPT(current, { fetch: this.#fetch, endpoints: this.#endpoints, now: this.#now() });
			await tx.query("UPDATE pim_app.chatgpt_credentials SET secret = $1, version = version + 1, updated_at = now()", [await sealString(this.crypto, JSON.stringify(next), chatgptContext(ownerId))]);
			return next;
		});
		return credential ? { token: credential.access, resource: this.#endpoints.resource } : null;
	}

	async status(p: Principal): Promise<ChatGPTStatus> {
		await this.authz.enforce(p, "api:read");
		const email = await this.db.owner(p.ownerId, async (tx) => (await tx.query("SELECT email FROM pim_app.chatgpt_credentials WHERE secret IS NOT NULL")).rows[0]);
		return { connected: email !== undefined, email: email?.email ?? null };
	}

	/** Starts a sign-in; the person opens `url`. A new start replaces an unfinished one. */
	async startLogin(p: Principal): Promise<{ url: string }> {
		await this.authz.enforce(p, "api:write");
		const saved = await this.#credential(p.ownerId);
		const pending: Pending = { state: randomValue(), nonce: randomValue(), verifier: randomValue(), clientId: saved?.clientId ?? null, startedAt: this.#now() };
		const sealed = await sealString(this.crypto, JSON.stringify(pending), chatgptContext(p.ownerId));
		const hostId = await this.db.owner(p.ownerId, async (tx) =>
			(await tx.query("INSERT INTO pim_app.chatgpt_credentials (owner_id, host_id, pending) VALUES ($1, $2, $3) ON CONFLICT (owner_id) DO UPDATE SET pending = $3 RETURNING host_id", [p.ownerId, `urn:uuid:${randomUUID()}`, sealed])).rows[0].host_id as string,
		);
		const url = new URL(`${this.#endpoints.issuer}/api/accounts/authorize`);
		url.search = new URLSearchParams({
			client_id: pending.clientId ?? DYNAMIC_CLIENT_ID,
			...(pending.clientId === null ? { agent_name_hint: AGENT_NAME } : { id_token_hint: saved!.idToken }),
			ext_agent_host_id: hostId,
			response_type: "code",
			redirect_uri: REDIRECT_URI,
			resource: this.#endpoints.resource,
			scope: SCOPE,
			state: pending.state,
			nonce: pending.nonce,
			code_challenge: challengeOf(pending.verifier),
			code_challenge_method: "S256",
		}).toString();
		return { url: url.toString() };
	}

	/** Finishes the sign-in from the address the browser landed on. */
	async finishLogin(p: Principal, callbackUrl: string): Promise<ChatGPTStatus> {
		await this.authz.enforce(p, "api:write");
		if (typeof callbackUrl !== "string" || callbackUrl.trim() === "") throw new BadRequestError("url must be the address the browser landed on");
		// A code is single-use: taking the pending sign-in out of its row is what spends it, whatever happens next.
		const taken = await this.db.owner(p.ownerId, async (tx) => {
			const found = (await tx.query("SELECT pending FROM pim_app.chatgpt_credentials WHERE pending IS NOT NULL FOR UPDATE")).rows[0]?.pending as string | undefined;
			if (found) await tx.query("UPDATE pim_app.chatgpt_credentials SET pending = NULL");
			return found;
		});
		const pending = taken ? (JSON.parse(await openString(this.crypto, taken, chatgptContext(p.ownerId))) as Pending) : undefined;
		if (!pending || this.#now() - pending.startedAt > LOGIN_TTL_MS) throw new ConflictError("No sign-in is waiting. Start again.");
		const { code, clientId } = callbackResult(callbackUrl, pending);
		const fail = (status: number, message: string) => new PimError(status, status === 403 ? "forbidden" : "bad_gateway", message);
		let token: TokenResponse;
		try {
			token = await requestToken(this.#fetch, this.#endpoints.issuer, new URLSearchParams({ grant_type: "authorization_code", client_id: clientId, code, code_verifier: pending.verifier, redirect_uri: REDIRECT_URI, resource: this.#endpoints.resource }));
		} catch (error) {
			throw fail(502, error instanceof Error ? error.message : String(error));
		}
		if (typeof token.access_token !== "string" || typeof token.refresh_token !== "string") throw fail(502, "OpenAI's token response is missing tokens");
		if (typeof token.id_token !== "string") throw fail(502, "OpenAI's token response has no ID token");
		const scopes = scopesOf(token, []);
		if (!scopes.includes(PLAN_SCOPE)) throw fail(403, "ChatGPT signed you in, but did not allow Pim to use your plan. Check your plan includes it.");
		let identity: { sub: string; email: string | null };
		let expires: number;
		try {
			identity = await verifyIdToken(this.#fetch, this.#endpoints.issuer, token.id_token, { clientId, nonce: pending.nonce }, this.#now());
			expires = expiresAt(token, this.#now());
		} catch (error) {
			throw fail(502, error instanceof Error ? error.message : String(error));
		}
		const saved = await this.#credential(p.ownerId);
		if (saved && saved.clientId === clientId && saved.subject !== identity.sub) throw new ConflictError("That is a different ChatGPT account. Disconnect the current one first.");
		const credential: ChatGPTCredential = { type: "oauth", access: token.access_token, refresh: token.refresh_token, expires, clientId, scopes, idToken: token.id_token, subject: identity.sub, email: identity.email };
		const sealed = await sealString(this.crypto, JSON.stringify(credential), chatgptContext(p.ownerId));
		await this.db.owner(p.ownerId, (tx) => tx.query("UPDATE pim_app.chatgpt_credentials SET secret = $1, email = $2, version = version + 1, updated_at = now()", [sealed, identity.email]));
		return { connected: true, email: identity.email };
	}

	async logout(p: Principal): Promise<ChatGPTStatus> {
		await this.authz.enforce(p, "api:write");
		await this.db.owner(p.ownerId, (tx) => tx.query("UPDATE pim_app.chatgpt_credentials SET secret = NULL, email = NULL, pending = NULL, version = version + 1, updated_at = now()"));
		return { connected: false, email: null };
	}
}
