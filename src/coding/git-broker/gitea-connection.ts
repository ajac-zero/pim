import { base64UrlDecode, base64UrlEncode } from "../../auth/encoding";
import { GitBrokerError } from "./broker";
import type { GiteaConfig } from "./config";
import type { Fetch } from "./github-app";
import type { GiteaRecord, GiteaWriteResult } from "./gitea-store";

/**
 * Pim's connection to a Gitea instance: one account of the deployment's own,
 * signed in through a Gitea OAuth2 application (a confidential client), whose
 * tokens coding threads' git work uses. This is the OAuth half of
 * ./gitea-provider.ts: it starts the sign-in (`authorizeUrl`), finishes it
 * (`complete`), hands out a working access token (`accessToken`), says what
 * it can without a secret (`status`), and lets go (`disconnect`).
 *
 * The tokens are sealed here, with AES-GCM under a key derived from the
 * Directory's own key and bound to the instance, before they reach the
 * Directory's database (./gitea-store.ts), so it only holds ciphertext.
 *
 * Gitea rotates the refresh token on every refresh, so a refresh token may
 * be spent once. Refreshes are therefore serial: within an isolate, callers
 * share one in-flight refresh, and across isolates the one that takes the
 * store's lease refreshes while the others wait and read what it stored.
 * The new pair is stored with a compare-and-set on the version read, in one
 * write. A refresh Gitea refuses ends the connection until someone signs in
 * again (`needsReconnect`), unless the tokens had already been replaced.
 */

/** Where the connection is kept, wherever that is: the Directory in a deployment. Each call names the instance. */
export interface GiteaBackend {
	read(instance: string): Promise<GiteaRecord>;
	write(instance: string, sealed: Uint8Array, login: string, expectedVersion: number): Promise<GiteaWriteResult>;
	claimRefresh(instance: string, version: number, leaseMs: number): Promise<boolean>;
	releaseRefresh(instance: string, version: number): Promise<void>;
	markNeedsReconnect(instance: string, expectedVersion: number): Promise<GiteaWriteResult>;
	disconnect(instance: string): Promise<void>;
	createState(hash: string, ownerId: string, ttlMs: number): Promise<void>;
	consumeState(hash: string): Promise<string | null>;
}

export type GiteaState = "not_configured" | "not_connected" | "needs_reconnect" | "connected";

/** Gitea can't be used now: not configured, not connected, or connected but in need of a new sign-in. The message holds no secret. */
export class GiteaNotConnectedError extends GitBrokerError {
	readonly state: Exclude<GiteaState, "connected">;

	constructor(state: Exclude<GiteaState, "connected">) {
		super(
			409,
			state === "not_configured"
				? "Gitea not configured: ask the Pim owner to set up its OAuth application"
				: state === "needs_reconnect"
					? "Gitea not connected: the connection needs to be signed in again, ask the Pim owner to reconnect it"
					: "Gitea not connected: ask the Pim owner to connect it",
		);
		this.state = state;
	}
}

/** What may be said of the connection: never a token or the client's secret. */
export type GiteaStatus = { readonly configured: boolean; readonly connected: boolean; readonly login: string | null; readonly needsReconnect: boolean };

type Tokens = { readonly accessToken: string; readonly refreshToken: string; readonly expiresAt: number };

/** A sign-in attempt lasts 10 minutes. */
export const STATE_TTL_MS = 10 * 60_000;
/** An access token is refreshed once it has this long or less to live. */
export const REFRESH_MARGIN_MS = 5 * 60_000;
/** How long a refresh may hold the lease before another may take over. */
export const REFRESH_LEASE_MS = 30_000;
/** What Gitea is assumed to give an access token that says nothing: its own default, an hour. */
const DEFAULT_LIFETIME_MS = 60 * 60_000;

const encoder = new TextEncoder();
const FORMAT = 1;

/** The key tokens are sealed with, derived from `secret` (the Directory's key) for this use alone. */
export async function giteaKey(secret: Uint8Array): Promise<CryptoKey> {
	const base = await crypto.subtle.importKey("raw", secret as BufferSource, "HKDF", false, ["deriveKey"]);
	return crypto.subtle.deriveKey(
		{ name: "HKDF", hash: "SHA-256", salt: new Uint8Array(0), info: encoder.encode("pim gitea connection v1") },
		base,
		{ name: "AES-GCM", length: 256 },
		false,
		["encrypt", "decrypt"],
	);
}

/** `raw` as the Directory's `cookieKey` gives it, as a key for `GiteaConnection`. */
export const giteaKeyFrom = (raw: string) => giteaKey(base64UrlDecode(raw));

const aad = (instance: string) => encoder.encode(JSON.stringify(["pim.gitea", FORMAT, instance]));

async function seal(key: CryptoKey, instance: string, tokens: Tokens): Promise<Uint8Array> {
	const nonce = crypto.getRandomValues(new Uint8Array(12));
	const sealed = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv: nonce, additionalData: aad(instance) }, key, encoder.encode(JSON.stringify(tokens))));
	return Uint8Array.from([FORMAT, ...nonce, ...sealed]);
}

/** The tokens in a sealed blob, or null when it doesn't open (tampered with, another instance's, or sealed under another key). */
async function open(key: CryptoKey, instance: string, sealed: Uint8Array): Promise<Tokens | null> {
	try {
		if (sealed[0] !== FORMAT) return null;
		const plain = await crypto.subtle.decrypt({ name: "AES-GCM", iv: sealed.slice(1, 13), additionalData: aad(instance) }, key, sealed.slice(13));
		const tokens = JSON.parse(new TextDecoder().decode(plain)) as Partial<Tokens>;
		return typeof tokens.accessToken === "string" && typeof tokens.refreshToken === "string" && typeof tokens.expiresAt === "number" ? (tokens as Tokens) : null;
	} catch {
		return null;
	}
}

async function sha256(text: string): Promise<string> {
	return base64UrlEncode(new Uint8Array(await crypto.subtle.digest("SHA-256", encoder.encode(text))));
}

/** A request to Gitea that failed: `retryable` when it says nothing about the grant (Gitea is down), else the grant is dead. */
class TokenRequestError extends Error {
	constructor(
		message: string,
		readonly retryable: boolean,
	) {
		super(message);
	}
}

/** Refreshes in flight in this isolate, by instance. */
const inflight = new Map<string, Promise<string>>();

export type GiteaConnectionOptions = {
	readonly instanceId: string;
	/** The OAuth client; null while the deployment hasn't set it up. */
	readonly config: GiteaConfig | null;
	readonly backend: GiteaBackend;
	readonly key: () => Promise<CryptoKey>;
	readonly fetch?: Fetch;
	readonly now?: () => number;
	readonly sleep?: (ms: number) => Promise<void>;
};

export class GiteaConnection {
	readonly #o: GiteaConnectionOptions;

	constructor(options: GiteaConnectionOptions) {
		this.#o = options;
	}

	get configured(): boolean {
		return this.#o.config !== null;
	}

	#now() {
		return (this.#o.now ?? Date.now)();
	}

	#config(): GiteaConfig {
		if (!this.#o.config) throw new GiteaNotConnectedError("not_configured");
		return this.#o.config;
	}

	async #send(url: string, init: RequestInit): Promise<Response> {
		try {
			return await (this.#o.fetch ?? ((input, options) => fetch(input, options)))(url, { ...init, redirect: "manual", signal: AbortSignal.timeout(30_000) });
		} catch {
			throw new TokenRequestError("Gitea couldn't be reached", true);
		}
	}

	async status(): Promise<GiteaStatus> {
		if (!this.#o.config) return { configured: false, connected: false, login: null, needsReconnect: false };
		const record = await this.#o.backend.read(this.#o.instanceId);
		return { configured: true, connected: record.sealed !== null, login: record.login, needsReconnect: record.needsReconnect };
	}

	/** The page on Gitea that asks the person to let Pim in, for `ownerId`, the signed-in Pim user the attempt is bound to. */
	async authorizeUrl(ownerId: string, redirectUri: string): Promise<string> {
		const config = this.#config();
		const state = base64UrlEncode(crypto.getRandomValues(new Uint8Array(32)));
		await this.#o.backend.createState(await sha256(state), ownerId, STATE_TTL_MS);
		const url = new URL(`${config.baseUrl}/login/oauth/authorize`);
		url.searchParams.set("response_type", "code");
		url.searchParams.set("client_id", config.clientId);
		url.searchParams.set("redirect_uri", redirectUri);
		url.searchParams.set("state", state);
		return url.toString();
	}

	/**
	 * Finishes a sign-in: `state` must be one this Pim made, still open, for
	 * `ownerId`; the code is traded for tokens, which are sealed and stored
	 * in place of any connection there was. Returns the Gitea login.
	 */
	async complete(ownerId: string, state: string, code: string, redirectUri: string): Promise<string> {
		const config = this.#config();
		const owner = typeof state === "string" && state !== "" ? await this.#o.backend.consumeState(await sha256(state)) : null;
		if (owner === null || owner !== ownerId) throw new GitBrokerError(400, "This Gitea sign-in has expired or isn't yours: start it again");
		if (typeof code !== "string" || code === "") throw new GitBrokerError(400, "Gitea sent no code");
		let tokens: Tokens;
		let login: string;
		try {
			tokens = await this.#tokens({ grant_type: "authorization_code", code, redirect_uri: redirectUri }, config);
			login = await this.#login(tokens.accessToken, config);
		} catch (error) {
			if (!(error instanceof TokenRequestError)) throw error;
			throw new GitBrokerError(502, error.message);
		}
		const instance = this.#o.instanceId;
		const sealed = await seal(await this.#o.key(), instance, tokens);
		for (let attempt = 0; attempt < 3; attempt++) {
			const { version } = await this.#o.backend.read(instance);
			if ((await this.#o.backend.write(instance, sealed, login, version)).ok) return login;
		}
		throw new GitBrokerError(409, "Gitea's connection kept changing: try again");
	}

	async disconnect(): Promise<void> {
		await this.#o.backend.disconnect(this.#o.instanceId);
	}

	async #tokens(grant: Record<string, string>, config: GiteaConfig): Promise<Tokens> {
		const response = await this.#send(`${config.baseUrl}/login/oauth/access_token`, {
			method: "POST",
			headers: { "Content-Type": "application/x-www-form-urlencoded", Accept: "application/json" },
			body: new URLSearchParams({ ...grant, client_id: config.clientId, client_secret: config.clientSecret }),
		});
		if (!response.ok) {
			await response.body?.cancel();
			// A 4xx is Gitea refusing the grant; anything else says nothing about it.
			const refused = response.status >= 400 && response.status < 500 && response.status !== 429;
			throw new TokenRequestError(`Gitea answered HTTP ${response.status} to the token request`, !refused);
		}
		const body = (await response.json().catch(() => null)) as { access_token?: unknown; refresh_token?: unknown; expires_in?: unknown } | null;
		if (!body || typeof body.access_token !== "string" || typeof body.refresh_token !== "string") throw new TokenRequestError("Gitea's token answer was malformed", false);
		const lifetime = typeof body.expires_in === "number" && body.expires_in > 0 ? body.expires_in * 1000 : DEFAULT_LIFETIME_MS;
		return { accessToken: body.access_token, refreshToken: body.refresh_token, expiresAt: this.#now() + lifetime };
	}

	async #login(accessToken: string, config: GiteaConfig): Promise<string> {
		const response = await this.#send(`${config.baseUrl}/api/v1/user`, { headers: { Authorization: `Bearer ${accessToken}`, Accept: "application/json" } });
		const user = response.ok ? ((await response.json().catch(() => null)) as { login?: unknown } | null) : null;
		if (typeof user?.login !== "string" || user.login === "") throw new TokenRequestError("Gitea didn't say who signed in", false);
		return user.login;
	}

	/**
	 * An access token that works for at least five minutes more, refreshing it
	 * first when it doesn't. Throws `GiteaNotConnectedError` when Gitea isn't
	 * configured or connected, or the connection needs a new sign-in.
	 */
	async accessToken(): Promise<string> {
		const config = this.#config();
		const instance = this.#o.instanceId;
		const sleep = this.#o.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
		for (let attempt = 0; attempt < 120; attempt++) {
			const record = await this.#o.backend.read(instance);
			if (record.sealed === null) throw new GiteaNotConnectedError(record.needsReconnect ? "needs_reconnect" : "not_connected");
			const tokens = await open(await this.#o.key(), instance, record.sealed);
			if (!tokens) {
				// Tokens that don't open, under another key, are as good as none.
				await this.#o.backend.markNeedsReconnect(instance, record.version);
				throw new GiteaNotConnectedError("needs_reconnect");
			}
			if (tokens.expiresAt - this.#now() > REFRESH_MARGIN_MS) return tokens.accessToken;
			const shared = inflight.get(instance);
			if (shared) return shared;
			if (!(await this.#o.backend.claimRefresh(instance, record.version, REFRESH_LEASE_MS))) {
				// Another isolate is refreshing, or already has: look again shortly.
				await sleep(250);
				continue;
			}
			const refreshing = this.#refresh(config, record, tokens).finally(() => inflight.delete(instance));
			inflight.set(instance, refreshing);
			return refreshing;
		}
		throw new GitBrokerError(502, "Gitea's token couldn't be refreshed in time");
	}

	async #refresh(config: GiteaConfig, record: GiteaRecord, old: Tokens): Promise<string> {
		const instance = this.#o.instanceId;
		let fresh: Tokens;
		try {
			fresh = await this.#tokens({ grant_type: "refresh_token", refresh_token: old.refreshToken }, config);
		} catch (error) {
			if (!(error instanceof TokenRequestError)) throw error;
			if (error.retryable) {
				await this.#o.backend.releaseRefresh(instance, record.version);
				throw new GitBrokerError(502, error.message);
			}
			// Refused: unless the tokens were replaced meanwhile, the connection is over.
			const now = await this.#o.backend.read(instance);
			if (now.version === record.version) await this.#o.backend.markNeedsReconnect(instance, record.version);
			else if (now.sealed !== null) {
				const current = await open(await this.#o.key(), instance, now.sealed);
				if (current) return current.accessToken;
			}
			console.error(JSON.stringify({ event: "pim.gitea.refresh_failed", instance }));
			throw new GiteaNotConnectedError("needs_reconnect");
		}
		const written = await this.#o.backend.write(instance, await seal(await this.#o.key(), instance, fresh), record.login ?? "", record.version);
		// Losing the write means the person signed in again meanwhile, whose tokens win.
		return written.ok ? fresh.accessToken : this.accessToken();
	}
}
