import type { OAuthCredential } from "@earendil-works/pi-ai";
import type { SqlCredentialStore } from "./credentials";
import type { ImageModel } from "./extensions/image-generation";
import { HttpError } from "./http";
import type { PimStore } from "./store";

/**
 * Images from the person's ChatGPT plan, the way Codex makes them. OpenAI's
 * plan sharing (see ./chatgpt.ts) doesn't include image generation, but
 * ChatGPT's own Codex backend does, for anyone signed in with Codex's public
 * client. That is an internal API OpenAI hasn't documented, so it can change.
 * It picks the model, size and quality itself; the canvas follows the shape
 * the prompt asks for.
 *
 * The sign-in is a second, separate one from the plan's: the same paste-back
 * dance, since the client's only redirect is a loopback address.
 */

export const CODEX_IMAGES_PROVIDER = "chatgpt-images";
export const CODEX_IMAGE_MODEL = "gpt-image-2";

const CLIENT_ID = "app_EMoamEEZ73f0CkXaXp7hrann";
const AUTHORIZE_URL = "https://auth.openai.com/oauth/authorize";
const TOKEN_URL = "https://auth.openai.com/oauth/token";
const IMAGES_URL = "https://chatgpt.com/backend-api/codex/images/generations";
const REDIRECT_URI = "http://localhost:1455/auth/callback";
const SCOPE = "openid profile email offline_access";
const ORIGINATOR = "pim";
const LOGIN_TTL_MS = 15 * 60 * 1000;
/** Refresh this long before expiry. Refresh tokens are single-use, so a refresh runs inside the credential store's lock. */
const EXPIRY_MARGIN_MS = 5 * 60 * 1000;
const PENDING_KEY = "codex_images_login";

type Credential = OAuthCredential & { readonly accountId: string; readonly email: string | null };

type Pending = { readonly state: string; readonly verifier: string; readonly startedAt: number };

export type CodexImagesStatus = { readonly connected: boolean; readonly email: string | null };

/** The shape each image is asked for, as a line on the prompt: the service ignores its own `size`. */
const CANVAS = {
	square: "Aspect ratio: 1:1, square canvas.",
	landscape: "Aspect ratio: 3:2, wide landscape (horizontal) canvas.",
	portrait: "Aspect ratio: 2:3, tall vertical portrait canvas.",
} as const;

function base64url(bytes: Uint8Array): string {
	let binary = "";
	for (const byte of bytes) binary += String.fromCharCode(byte);
	return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function random(): string {
	return base64url(crypto.getRandomValues(new Uint8Array(32)));
}

/** A JWT's claims. The tokens come straight from OpenAI's token endpoint over TLS, so their signatures aren't checked. */
function claims(jwt: string): Record<string, unknown> {
	const base64 = (jwt.split(".")[1] ?? "").replace(/-/g, "+").replace(/_/g, "/");
	try {
		return JSON.parse(new TextDecoder().decode(Uint8Array.from(atob(base64 + "=".repeat((4 - (base64.length % 4)) % 4)), (c) => c.charCodeAt(0))));
	} catch {
		return {};
	}
}

type Tokens = { access_token?: unknown; refresh_token?: unknown; id_token?: unknown };

async function requestToken(body: Record<string, string>, form: boolean): Promise<Tokens> {
	const response = await fetch(TOKEN_URL, {
		method: "POST",
		headers: { accept: "application/json", "content-type": form ? "application/x-www-form-urlencoded" : "application/json" },
		body: form ? new URLSearchParams(body) : JSON.stringify(body),
	});
	if (!response.ok) throw new Error(`OpenAI token request failed (${response.status}): ${(await response.text().catch(() => "")) || response.statusText}`);
	return (await response.json()) as Tokens;
}

/** A credential from a token response, keeping what a refresh doesn't send again. */
function credentialOf(tokens: Tokens, previous?: Credential): Credential {
	if (typeof tokens.access_token !== "string") throw new Error("OpenAI's token response has no access token");
	const refresh = typeof tokens.refresh_token === "string" ? tokens.refresh_token : previous?.refresh;
	if (!refresh) throw new Error("OpenAI's token response has no refresh token");
	const access = claims(tokens.access_token);
	if (typeof access.exp !== "number") throw new Error("OpenAI's access token has no expiry");
	const id = typeof tokens.id_token === "string" ? claims(tokens.id_token) : {};
	const auth = (id["https://api.openai.com/auth"] ?? access["https://api.openai.com/auth"]) as { chatgpt_account_id?: unknown } | undefined;
	const accountId = typeof auth?.chatgpt_account_id === "string" ? auth.chatgpt_account_id : previous?.accountId;
	if (!accountId) throw new Error("OpenAI's token names no ChatGPT account");
	return {
		type: "oauth",
		access: tokens.access_token,
		refresh,
		expires: access.exp * 1000 - EXPIRY_MARGIN_MS,
		accountId,
		email: typeof id.email === "string" ? id.email : (previous?.email ?? null),
	};
}

export class CodexImages {
	readonly #store: PimStore;
	readonly #credentials: SqlCredentialStore;

	constructor(store: PimStore, credentials: SqlCredentialStore) {
		this.#store = store;
		this.#credentials = credentials;
	}

	/** Whether a sign-in is saved. */
	connected(): boolean {
		return this.#store.credential(CODEX_IMAGES_PROVIDER) !== undefined;
	}

	async status(): Promise<CodexImagesStatus> {
		const saved = (await this.#credentials.read(CODEX_IMAGES_PROVIDER)) as Credential | undefined;
		return { connected: saved !== undefined, email: saved?.email ?? null };
	}

	/** Starts a sign-in; the person opens `url`. A new start replaces an unfinished one. */
	async startLogin(): Promise<{ url: string }> {
		const pending: Pending = { state: random(), verifier: random(), startedAt: Date.now() };
		this.#store.setMeta(PENDING_KEY, JSON.stringify(pending));
		const challenge = base64url(new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(pending.verifier))));
		const url = new URL(AUTHORIZE_URL);
		url.search = new URLSearchParams({
			response_type: "code",
			client_id: CLIENT_ID,
			redirect_uri: REDIRECT_URI,
			scope: SCOPE,
			code_challenge: challenge,
			code_challenge_method: "S256",
			id_token_add_organizations: "true",
			codex_cli_simplified_flow: "true",
			state: pending.state,
			originator: ORIGINATOR,
		}).toString();
		return { url: url.toString() };
	}

	/** Finishes the sign-in from the address the browser landed on. */
	async finishLogin(callbackUrl: string): Promise<CodexImagesStatus> {
		const json = this.#store.meta(PENDING_KEY);
		const pending = json === undefined ? undefined : (JSON.parse(json) as Pending);
		if (!pending || Date.now() - pending.startedAt > LOGIN_TTL_MS) throw new HttpError(409, "No sign-in is waiting. Start again.");
		let url: URL;
		try {
			url = new URL(callbackUrl.trim());
		} catch {
			throw new HttpError(400, "Paste the whole address from the browser, starting with http://localhost");
		}
		const expected = new URL(REDIRECT_URI);
		if (url.origin !== expected.origin || url.pathname !== expected.pathname) throw new HttpError(400, `The address must start with ${REDIRECT_URI}`);
		if (url.searchParams.get("state") !== pending.state) throw new HttpError(400, "That address is from another sign-in. Start again.");
		const error = url.searchParams.get("error");
		if (error === "missing_codex_entitlement") throw new HttpError(403, "Codex isn't enabled for that ChatGPT workspace.");
		if (error) throw new HttpError(400, `ChatGPT sign-in failed: ${error}`);
		const code = url.searchParams.get("code");
		if (!code) throw new HttpError(400, "The address has no authorization code");
		// A code is single-use: whatever happens next, this sign-in is spent.
		this.#store.deleteMeta(PENDING_KEY);

		let credential: Credential;
		try {
			credential = credentialOf(
				await requestToken({ grant_type: "authorization_code", client_id: CLIENT_ID, code, code_verifier: pending.verifier, redirect_uri: REDIRECT_URI }, true),
			);
		} catch (error) {
			throw new HttpError(502, error instanceof Error ? error.message : String(error));
		}
		await this.#credentials.modify(CODEX_IMAGES_PROVIDER, async () => credential);
		return { connected: true, email: credential.email };
	}

	async logout(): Promise<void> {
		this.#store.deleteMeta(PENDING_KEY);
		await this.#credentials.delete(CODEX_IMAGES_PROVIDER);
	}

	/** A token that stays good for the next few minutes, refreshed if need be. */
	async #credential(): Promise<Credential> {
		const saved = (await this.#credentials.read(CODEX_IMAGES_PROVIDER)) as Credential | undefined;
		if (!saved) throw new Error("ChatGPT isn't connected for images. Sign in again in Settings.");
		if (saved.expires > Date.now()) return saved;
		try {
			return (await this.#credentials.modify(CODEX_IMAGES_PROVIDER, async (current) => {
				const latest = current as Credential;
				// Another request may have refreshed it while this one waited its turn.
				if (latest.expires > Date.now()) return latest;
				return credentialOf(await requestToken({ client_id: CLIENT_ID, grant_type: "refresh_token", refresh_token: latest.refresh }, false), latest);
			})) as Credential;
		} catch (error) {
			throw new Error(`The ChatGPT sign-in for images has lapsed (${error instanceof Error ? error.message : String(error)}). Sign in again in Settings.`);
		}
	}

	model(): ImageModel {
		return {
			id: CODEX_IMAGE_MODEL,
			generate: async (prompt, { width, height }, signal) => {
				const { access, accountId } = await this.#credential();
				const canvas = width === height ? CANVAS.square : width > height ? CANVAS.landscape : CANVAS.portrait;
				const response = await fetch(IMAGES_URL, {
					method: "POST",
					signal,
					headers: {
						authorization: `Bearer ${access}`,
						"chatgpt-account-id": accountId,
						originator: ORIGINATOR,
						"user-agent": `${ORIGINATOR}/1`,
						"content-type": "application/json",
						accept: "application/json",
					},
					body: JSON.stringify({ prompt: `${prompt}\n\n${canvas}`, background: "auto", model: CODEX_IMAGE_MODEL, quality: "auto", size: "auto" }),
				});
				if (!response.ok) {
					const body = await response.text().catch(() => "");
					if (response.status === 429) throw new Error("The ChatGPT plan's usage limit is reached. Try again after it resets.");
					if (response.status === 401) throw new Error("ChatGPT turned the sign-in down. Sign in again in Settings.");
					// A page rather than JSON is usually Cloudflare in front of ChatGPT turning the Worker away: say so, with its ray.
					const page = /<title>([^<]*)<\/title>/i.exec(body)?.[1]?.trim();
					const mitigated = response.headers.get("cf-mitigated");
					const detail = page || mitigated ? `a web page "${page ?? ""}"${mitigated ? ` (cf-mitigated: ${mitigated})` : ""}, ray ${response.headers.get("cf-ray") ?? "unknown"}` : body.slice(0, 300);
					throw new Error(`ChatGPT's image service answered ${response.status}${detail ? `: ${detail}` : ""}`);
				}
				const image = ((await response.json()) as { data?: { b64_json?: unknown }[] }).data?.[0]?.b64_json;
				if (typeof image !== "string") throw new Error("ChatGPT's image service answered without an image.");
				return Uint8Array.from(atob(image), (c) => c.charCodeAt(0));
			},
		};
	}
}
