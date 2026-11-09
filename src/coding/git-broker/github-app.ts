import { base64UrlEncode } from "../../auth/encoding";
import type { RepoRef } from "./broker";
import type { GitHubAppConfig } from "./config";

/**
 * The deployment's GitHub App, as the git broker uses it: it signs the App's
 * JWT with its private key (RS256, with WebCrypto), finds the installation
 * that has a repository, and gets that installation's tokens, each for that
 * one repository and no other, with the least it needs: `contents: read` to
 * clone and fetch, `contents: write` only to push. A token is kept until 5
 * minutes before GitHub says it expires, and nothing else is kept. Tokens go
 * only to github.com, from Pim; never to a workspace, a log, or an error.
 */

export type Fetch = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;

/** What a token may do with the repository's contents. */
export type Access = "read" | "write";

export type InstallationToken = { readonly token: string; readonly expiresAt: number };

export const GITHUB_API = "https://api.github.com";

/** How long before its expiry a token is no longer used. */
export const TOKEN_MARGIN_MS = 5 * 60_000;

/** GitHub refused or failed a request of the App's; the message holds no secret. */
export class GitHubAppError extends Error {
	override readonly name = "GitHubAppError";
	constructor(
		message: string,
		readonly status: number | null,
	) {
		super(message);
	}
}

/** The App isn't installed on the repository (or can't see it). */
export class RepoNotInstalledError extends GitHubAppError {
	constructor(repo: RepoRef) {
		super(`The GitHub App isn't installed on ${repo.fullName}`, 404);
	}
}

/** DER: a tag, its length, its content. */
function der(tag: number, content: Uint8Array): Uint8Array {
	const length = content.length;
	const lengthBytes: number[] = [];
	if (length < 0x80) lengthBytes.push(length);
	else {
		for (let rest = length; rest > 0; rest = Math.floor(rest / 256)) lengthBytes.unshift(rest % 256);
		lengthBytes.unshift(0x80 | lengthBytes.length);
	}
	const out = new Uint8Array(1 + lengthBytes.length + length);
	out[0] = tag;
	out.set(lengthBytes, 1);
	out.set(content, 1 + lengthBytes.length);
	return out;
}

const concat = (...parts: Uint8Array[]) => {
	const out = new Uint8Array(parts.reduce((sum, part) => sum + part.length, 0));
	let at = 0;
	for (const part of parts) {
		out.set(part, at);
		at += part.length;
	}
	return out;
};

/** PKCS #8's `AlgorithmIdentifier` for RSA: rsaEncryption, with no parameters. */
const RSA_ALGORITHM = Uint8Array.of(0x30, 0x0d, 0x06, 0x09, 0x2a, 0x86, 0x48, 0x86, 0xf7, 0x0d, 0x01, 0x01, 0x01, 0x05, 0x00);

/**
 * The App's private key, for signing. GitHub gives it as PKCS #1, which
 * WebCrypto can't import, so it is wrapped as PKCS #8 first. The error
 * never quotes the key.
 */
export async function importPrivateKey(pem: string): Promise<CryptoKey> {
	const match = /-----BEGIN (RSA )?PRIVATE KEY-----([\s\S]+?)-----END \1?PRIVATE KEY-----/.exec(pem);
	try {
		if (!match) throw new Error();
		const body = Uint8Array.from(atob(match[2]!.replace(/\s+/g, "")), (c) => c.charCodeAt(0));
		const pkcs8 = match[1] ? der(0x30, concat(Uint8Array.of(0x02, 0x01, 0x00), RSA_ALGORITHM, der(0x04, body))) : body;
		return await crypto.subtle.importKey("pkcs8", pkcs8, { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" }, false, ["sign"]);
	} catch {
		throw new GitHubAppError("PIM_GITHUB_APP_PRIVATE_KEY isn't an RSA private key in PEM", null);
	}
}

const encoder = new TextEncoder();
const segment = (value: unknown) => base64UrlEncode(encoder.encode(JSON.stringify(value)));

/**
 * The App's JWT, which GitHub takes for 10 minutes at most: issued a minute
 * in the past, against clock drift, and good for 9 minutes from now.
 */
export async function appJwt(key: CryptoKey, appId: string, now = Date.now()): Promise<string> {
	const seconds = Math.floor(now / 1000);
	const unsigned = `${segment({ alg: "RS256", typ: "JWT" })}.${segment({ iat: seconds - 60, exp: seconds + 9 * 60, iss: appId })}`;
	const signature = await crypto.subtle.sign("RSASSA-PKCS1-v1_5", key, encoder.encode(unsigned));
	return `${unsigned}.${base64UrlEncode(new Uint8Array(signature))}`;
}

/** The headers of every request to GitHub's API. */
export function apiHeaders(authorization: string): Record<string, string> {
	return {
		Accept: "application/vnd.github+json",
		Authorization: authorization,
		"User-Agent": "pim-git-broker",
		"X-GitHub-Api-Version": "2022-11-28",
	};
}

export class GitHubApp {
	readonly #config: GitHubAppConfig;
	readonly #fetch: Fetch;
	readonly #now: () => number;
	#key: Promise<CryptoKey> | null = null;
	readonly #tokens = new Map<string, InstallationToken>();

	constructor(config: GitHubAppConfig, options: { fetch?: Fetch; now?: () => number } = {}) {
		this.#config = config;
		this.#fetch = options.fetch ?? ((input, init) => fetch(input, init));
		this.#now = options.now ?? Date.now;
	}

	/** A fresh JWT for the App itself. */
	async jwt(): Promise<string> {
		if (!this.#key) {
			const key = importPrivateKey(this.#config.privateKey);
			this.#key = key;
			key.catch(() => {
				if (this.#key === key) this.#key = null;
			});
		}
		return appJwt(await this.#key, this.#config.appId, this.#now());
	}

	async #api(path: string, init: { method?: string; body?: unknown } = {}): Promise<Response> {
		try {
			return await this.#fetch(`${GITHUB_API}${path}`, {
				method: init.method ?? "GET",
				headers: { ...apiHeaders(`Bearer ${await this.jwt()}`), ...(init.body === undefined ? {} : { "Content-Type": "application/json" }) },
				...(init.body === undefined ? {} : { body: JSON.stringify(init.body) }),
				redirect: "manual",
				signal: AbortSignal.timeout(30_000),
			});
		} catch (error) {
			if (error instanceof GitHubAppError) throw error;
			throw new GitHubAppError("GitHub's API couldn't be reached", null);
		}
	}

	/** The installation that has `repo`: the configured one, or the one GitHub names. */
	async installationFor(repo: RepoRef): Promise<string> {
		if (this.#config.installationId !== null) return this.#config.installationId;
		const response = await this.#api(`/repos/${repo.owner}/${repo.name}/installation`);
		if (response.status === 404) throw new RepoNotInstalledError(repo);
		if (!response.ok) throw new GitHubAppError(`GitHub answered HTTP ${response.status} when asked for the App's installation on ${repo.fullName}`, response.status);
		const { id } = (await response.json()) as { id?: unknown };
		if (typeof id !== "number" && typeof id !== "string") throw new GitHubAppError("GitHub didn't name the App's installation", response.status);
		return String(id);
	}

	/**
	 * A token for `repo` alone, with `contents` at `access` and nothing else
	 * (GitHub adds `metadata: read`, which every token has). A token from
	 * before is used again until `TOKEN_MARGIN_MS` before it expires.
	 */
	async installationToken(repo: RepoRef, access: Access): Promise<InstallationToken> {
		const cacheKey = `${repo.fullName.toLowerCase()}:${access}`;
		const now = this.#now();
		const cached = this.#tokens.get(cacheKey);
		if (cached && cached.expiresAt - TOKEN_MARGIN_MS > now) return cached;
		this.#tokens.delete(cacheKey);
		const installation = await this.installationFor(repo);
		const response = await this.#api(`/app/installations/${installation}/access_tokens`, {
			method: "POST",
			body: { repositories: [repo.name], permissions: { contents: access } },
		});
		// GitHub answers 422 when the installation can't see the repository.
		if (response.status === 404 || response.status === 422) throw new RepoNotInstalledError(repo);
		if (!response.ok) throw new GitHubAppError(`GitHub answered HTTP ${response.status} when asked for a token for ${repo.fullName}`, response.status);
		const body = (await response.json()) as { token?: unknown; expires_at?: unknown };
		const expiresAt = typeof body.expires_at === "string" ? Date.parse(body.expires_at) : Number.NaN;
		if (typeof body.token !== "string" || body.token === "" || !Number.isFinite(expiresAt)) throw new GitHubAppError("GitHub's token answer was malformed", response.status);
		const token = { token: body.token, expiresAt };
		if (expiresAt - TOKEN_MARGIN_MS > now) this.#tokens.set(cacheKey, token);
		return token;
	}
}
