/**
 * Images from a person's ChatGPT plan, the way Codex makes them (v1's `src/codex-images.ts`). OpenAI's plan sharing (see `@pim/v2-app/chatgpt`) does not include image
 * generation, but ChatGPT's Codex backend does, for anyone signed in with Codex's public client. That is an internal API OpenAI has not documented, so it can change.
 * It picks the model, size and quality itself; the canvas follows the shape the prompt asks for.
 *
 * The sign-in is a second one, apart from the plan's: the same paste-back, since the client's only redirect is a loopback address. The credential is sealed per owner in
 * `pim_app.chatgpt_image_credentials` (migration 0645). The Gate signs in and out; a Runner reads and refreshes it under the row's lock and makes the request itself
 * (v1 had to send it from the person's computer, because ChatGPT's firewall turned Cloudflare Workers away; a Runner is not one).
 *
 * `PIM_CODEX_AUTH_URL` and `PIM_CODEX_IMAGES_URL` move the endpoints, for a proxy or a stand-in.
 */
import { createHash } from "node:crypto";
import type { Principal } from "@pim/v2-contracts/identity";
import type { App } from "@pim/v2-app/app";
import { openString, sealString, type KeyringCrypto } from "@pim/v2-app/crypto";
import type { Db as RuntimeDb } from "@pim/v2-runtime/db";
import { BadRequestError, ConflictError, PimError } from "@pim/v2-app/errors";

export const CODEX_IMAGE_MODEL = "gpt-image-2";
const CLIENT_ID = "app_EMoamEEZ73f0CkXaXp7hrann";
const REDIRECT_URI = "http://localhost:1455/auth/callback";
const SCOPE = "openid profile email offline_access";
const ORIGINATOR = "pim";
const LOGIN_TTL_MS = 15 * 60 * 1000;
/** Refresh this long before expiry. Refresh tokens are single-use, so a refresh runs inside the row's lock. */
const EXPIRY_MARGIN_MS = 5 * 60 * 1000;
const REQUEST_MS = 120_000;

type Env = Record<string, string | undefined>;
type Fetch = typeof fetch;
export type CodexEndpoints = { authorize: string; token: string; images: string };
export const codexEndpoints = (env: Env): CodexEndpoints => {
	const auth = (env.PIM_CODEX_AUTH_URL ?? "https://auth.openai.com").replace(/\/+$/, "");
	return { authorize: `${auth}/oauth/authorize`, token: `${auth}/oauth/token`, images: env.PIM_CODEX_IMAGES_URL ?? "https://chatgpt.com/backend-api/codex/images/generations" };
};

export type CodexCredential = { type: "oauth"; access: string; refresh: string; expires: number; accountId: string; email: string | null };
export type CodexImagesStatus = { connected: boolean; email: string | null };
type Pending = { state: string; verifier: string; startedAt: number };
type Tokens = { access_token?: unknown; refresh_token?: unknown; id_token?: unknown };

export const codexContext = (ownerId: string) => `chatgpt-images:${ownerId}`;
const random = () => Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString("base64url");

/** A JWT's claims. The tokens come straight from OpenAI's token endpoint over TLS, so their signatures are not checked. */
function claims(jwt: string): Record<string, any> {
	try {
		return JSON.parse(Buffer.from(jwt.split(".")[1] ?? "", "base64url").toString());
	} catch {
		return {};
	}
}

async function requestToken(fetcher: Fetch, url: string, body: Record<string, string>, form: boolean): Promise<Tokens> {
	const response = await fetcher(url, {
		method: "POST",
		headers: { accept: "application/json", "content-type": form ? "application/x-www-form-urlencoded" : "application/json" },
		body: form ? new URLSearchParams(body) : JSON.stringify(body),
		signal: AbortSignal.timeout(30_000),
	});
	if (!response.ok) throw new Error(`OpenAI token request failed (${response.status}): ${(await response.text().catch(() => "")) || response.statusText}`);
	return (await response.json()) as Tokens;
}

/** A credential from a token response, keeping what a refresh does not send again. */
function credentialOf(tokens: Tokens, previous?: CodexCredential): CodexCredential {
	if (typeof tokens.access_token !== "string") throw new Error("OpenAI's token response has no access token");
	const refresh = typeof tokens.refresh_token === "string" ? tokens.refresh_token : previous?.refresh;
	if (!refresh) throw new Error("OpenAI's token response has no refresh token");
	const access = claims(tokens.access_token);
	if (typeof access.exp !== "number") throw new Error("OpenAI's access token has no expiry");
	const id = typeof tokens.id_token === "string" ? claims(tokens.id_token) : {};
	const auth = (id["https://api.openai.com/auth"] ?? access["https://api.openai.com/auth"]) as { chatgpt_account_id?: unknown } | undefined;
	const accountId = typeof auth?.chatgpt_account_id === "string" ? auth.chatgpt_account_id : previous?.accountId;
	if (!accountId) throw new Error("OpenAI's token names no ChatGPT account");
	return { type: "oauth", access: tokens.access_token, refresh, expires: access.exp * 1000 - EXPIRY_MARGIN_MS, accountId, email: typeof id.email === "string" ? id.email : (previous?.email ?? null) };
}

/** The sign-in as the Gate does it: start, finish from the pasted address, status, sign out. */
export class CodexImagesSignIn {
	readonly #fetch: Fetch;
	readonly #endpoints: CodexEndpoints;
	readonly #now: () => number;
	constructor(private readonly app: App, env: Env, options: { fetch?: Fetch; now?: () => number } = {}) {
		this.#fetch = options.fetch ?? fetch;
		this.#endpoints = codexEndpoints(env);
		this.#now = options.now ?? Date.now;
	}

	async status(p: Principal): Promise<CodexImagesStatus> {
		await this.app.identity.authz.enforce(p, "api:read");
		const row = await this.app.db.owner(p.ownerId, async (tx) => (await tx.query("SELECT email FROM pim_app.chatgpt_image_credentials WHERE secret IS NOT NULL")).rows[0]);
		return { connected: row !== undefined, email: row?.email ?? null };
	}

	/** Starts a sign-in; the person opens `url`. A new start replaces an unfinished one. */
	async start(p: Principal): Promise<{ url: string }> {
		await this.app.identity.authz.enforce(p, "api:write");
		const pending: Pending = { state: random(), verifier: random(), startedAt: this.#now() };
		const sealed = await sealString(this.app.crypto, JSON.stringify(pending), codexContext(p.ownerId));
		await this.app.db.owner(p.ownerId, (tx) => tx.query("INSERT INTO pim_app.chatgpt_image_credentials (owner_id, pending) VALUES ($1, $2) ON CONFLICT (owner_id) DO UPDATE SET pending = $2", [p.ownerId, sealed]));
		const url = new URL(this.#endpoints.authorize);
		url.search = new URLSearchParams({
			response_type: "code", client_id: CLIENT_ID, redirect_uri: REDIRECT_URI, scope: SCOPE, code_challenge: createHash("sha256").update(pending.verifier).digest("base64url"), code_challenge_method: "S256",
			id_token_add_organizations: "true", codex_cli_simplified_flow: "true", state: pending.state, originator: ORIGINATOR,
		}).toString();
		return { url: url.toString() };
	}

	/** Finishes the sign-in from the address the browser landed on. */
	async finish(p: Principal, callbackUrl: unknown): Promise<CodexImagesStatus> {
		await this.app.identity.authz.enforce(p, "api:write");
		if (typeof callbackUrl !== "string" || callbackUrl.trim() === "") throw new BadRequestError("url must be the address the browser landed on");
		// A code is single-use: taking the pending sign-in out of its row is what spends it, whatever happens next.
		const taken = await this.app.db.owner(p.ownerId, async (tx) => {
			const found = (await tx.query("SELECT pending FROM pim_app.chatgpt_image_credentials WHERE pending IS NOT NULL FOR UPDATE")).rows[0]?.pending as string | undefined;
			if (found) await tx.query("UPDATE pim_app.chatgpt_image_credentials SET pending = NULL");
			return found;
		});
		const pending = taken ? (JSON.parse(await openString(this.app.crypto, taken, codexContext(p.ownerId))) as Pending) : undefined;
		if (!pending || this.#now() - pending.startedAt > LOGIN_TTL_MS) throw new ConflictError("No sign-in is waiting. Start again.");
		let url: URL;
		try {
			url = new URL(callbackUrl.trim());
		} catch {
			throw new BadRequestError("Paste the whole address from the browser, starting with http://localhost");
		}
		const expected = new URL(REDIRECT_URI);
		if (url.origin !== expected.origin || url.pathname !== expected.pathname) throw new BadRequestError(`The address must start with ${REDIRECT_URI}`);
		if (url.searchParams.get("state") !== pending.state) throw new BadRequestError("That address is from another sign-in. Start again.");
		const error = url.searchParams.get("error");
		if (error === "missing_codex_entitlement") throw new PimError(403, "forbidden", "Codex isn't enabled for that ChatGPT workspace.");
		if (error) throw new BadRequestError(`ChatGPT sign-in failed: ${error}`);
		const code = url.searchParams.get("code");
		if (!code) throw new BadRequestError("The address has no authorization code");
		let credential: CodexCredential;
		try {
			credential = credentialOf(await requestToken(this.#fetch, this.#endpoints.token, { grant_type: "authorization_code", client_id: CLIENT_ID, code, code_verifier: pending.verifier, redirect_uri: REDIRECT_URI }, true));
		} catch (cause) {
			throw new PimError(502, "bad_gateway", cause instanceof Error ? cause.message : String(cause));
		}
		const sealed = await sealString(this.app.crypto, JSON.stringify(credential), codexContext(p.ownerId));
		await this.app.db.owner(p.ownerId, (tx) => tx.query("UPDATE pim_app.chatgpt_image_credentials SET secret = $1, email = $2, version = version + 1, updated_at = now()", [sealed, credential.email]));
		return { connected: true, email: credential.email };
	}

	async logout(p: Principal): Promise<CodexImagesStatus> {
		await this.app.identity.authz.enforce(p, "api:write");
		await this.app.db.owner(p.ownerId, (tx) => tx.query("UPDATE pim_app.chatgpt_image_credentials SET secret = NULL, email = NULL, pending = NULL, version = version + 1, updated_at = now()"));
		return { connected: false, email: null };
	}
}

/** The shape each image is asked for, as a line on the prompt: the service ignores its own `size`. */
const CANVAS = { square: "Aspect ratio: 1:1, square canvas.", landscape: "Aspect ratio: 3:2, wide landscape (horizontal) canvas.", portrait: "Aspect ratio: 2:3, tall vertical portrait canvas." } as const;
export type Shape = keyof typeof CANVAS;

/** The Runner's side: the owner's credential, kept fresh, and the request. */
export class CodexImagesClient {
	readonly #endpoints: CodexEndpoints;
	readonly #fetch: Fetch;
	readonly #now: () => number;
	constructor(private readonly db: RuntimeDb, private readonly crypto: KeyringCrypto, private readonly ownerId: string, env: Env, options: { fetch?: Fetch; now?: () => number } = {}) {
		this.#endpoints = codexEndpoints(env);
		this.#fetch = options.fetch ?? fetch;
		this.#now = options.now ?? Date.now;
	}

	async #open(sealed: string | null | undefined) {
		return sealed ? (JSON.parse(await openString(this.crypto, sealed, codexContext(this.ownerId))) as CodexCredential) : undefined;
	}

	/** Whether the owner signed in for images. */
	async connected(): Promise<boolean> {
		return (await this.db.read<{ s: string | null }>(this.ownerId, "SELECT pim_app.runner_chatgpt_images($1) AS s", [this.ownerId])).rows[0]?.s != null;
	}

	/** A token good for the next few minutes, refreshed under the row's lock if need be: of several Runners only the first refreshes, the others read what it wrote. */
	async #credential(): Promise<CodexCredential> {
		const saved = await this.#open((await this.db.read<{ s: string | null }>(this.ownerId, "SELECT pim_app.runner_chatgpt_images($1) AS s", [this.ownerId])).rows[0]?.s);
		if (!saved) throw new Error("ChatGPT isn't connected for images. Connect it in Settings, under Model.");
		if (saved.expires > this.#now()) return saved;
		try {
			return await this.db.transaction(this.ownerId, async (client) => {
				const latest = await this.#open((await client.query("SELECT pim_app.runner_chatgpt_images_lock($1) AS s", [this.ownerId])).rows[0]?.s);
				if (!latest) throw new Error("ChatGPT images was disconnected");
				if (latest.expires > this.#now()) return latest;
				const next = credentialOf(await requestToken(this.#fetch, this.#endpoints.token, { client_id: CLIENT_ID, grant_type: "refresh_token", refresh_token: latest.refresh }, false), latest);
				const written = (await client.query("SELECT pim_app.runner_chatgpt_images_put($1, $2) AS ok", [this.ownerId, await sealString(this.crypto, JSON.stringify(next), codexContext(this.ownerId))])).rows[0]?.ok;
				return written ? next : latest;
			});
		} catch (error) {
			throw new Error(`The ChatGPT sign-in for images has lapsed (${error instanceof Error ? error.message : String(error)}). Connect it again in Settings.`);
		}
	}

	async generate(prompt: string, shape: Shape, signal?: AbortSignal): Promise<Uint8Array> {
		const { access, accountId } = await this.#credential();
		const timeout = AbortSignal.timeout(REQUEST_MS);
		const response = await this.#fetch(this.#endpoints.images, {
			method: "POST",
			headers: { authorization: `Bearer ${access}`, "chatgpt-account-id": accountId, originator: ORIGINATOR, "user-agent": `${ORIGINATOR}/1`, "content-type": "application/json", accept: "application/json" },
			body: JSON.stringify({ prompt: `${prompt}\n\n${CANVAS[shape]}`, background: "auto", model: CODEX_IMAGE_MODEL, quality: "auto", size: "auto" }),
			signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
		});
		const body = await response.text();
		if (response.status === 429) throw new Error("The ChatGPT plan's usage limit is reached. Try again after it resets.");
		if (response.status === 401) throw new Error("ChatGPT turned the sign-in down. Connect it again in Settings.");
		if (response.status !== 200) throw new Error(`ChatGPT's image service answered ${response.status}${body ? `: ${body.replace(/\s+/g, " ").slice(0, 300)}` : ""}`);
		const image = (JSON.parse(body) as { data?: { b64_json?: unknown }[] }).data?.[0]?.b64_json;
		if (typeof image !== "string") throw new Error("ChatGPT's image service answered without an image.");
		return new Uint8Array(Buffer.from(image, "base64"));
	}
}
