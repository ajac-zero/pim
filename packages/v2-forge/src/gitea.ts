// The deployment's one Gitea account, connected by the admin through OAuth (PKCE). Its tokens are sealed with `EnvelopeCrypto` and refreshed here; a refresh Gitea refuses marks the connection `needs_reconnect`.
import { createHash, randomBytes } from "node:crypto";
import type { EnvelopeCrypto, Sealed } from "@pim/v2-contracts/platform";
import { type Db, type Row, tx } from "./db";
import { ForgeError } from "./errors";

export type GiteaConfig = { baseUrl: string; clientId: string; clientSecret: string; redirectUri: string };
type Tokens = { accessToken: string; refreshToken: string | null; expiresAt: number | null };
const CTX = "pim forge gitea v1";
const STATE_TTL_MS = 10 * 60_000;

const seal = async (c: EnvelopeCrypto, v: object, ctx: string): Promise<Buffer> => {
	const s = await c.seal(new TextEncoder().encode(JSON.stringify(v)), ctx);
	return Buffer.from(JSON.stringify({ k: s.keyId, v: s.version, n: Buffer.from(s.nonce).toString("base64"), c: Buffer.from(s.ciphertext).toString("base64") }));
};
const open = async <T>(c: EnvelopeCrypto, b: Uint8Array, ctx: string): Promise<T> => {
	const j = JSON.parse(Buffer.from(b).toString("utf8"));
	const sealed: Sealed = { keyId: j.k, version: j.v, nonce: Buffer.from(j.n, "base64"), ciphertext: Buffer.from(j.c, "base64") };
	return JSON.parse(new TextDecoder().decode(await c.open(sealed, ctx)));
};

export class GiteaConnection {
	constructor(
		private readonly db: Db,
		private readonly crypto: EnvelopeCrypto,
		readonly config: GiteaConfig,
		private readonly doFetch: typeof fetch = fetch,
		private readonly now: () => number = Date.now,
	) {}

	/** The page the admin is sent to, with a one-use state that remembers who asked and the PKCE verifier. */
	async authorizeUrl(ownerId: string): Promise<string> {
		const state = randomBytes(24).toString("base64url");
		const verifier = randomBytes(32).toString("base64url");
		await this.db.query("delete from pim_forge.forge_gitea_oauth_state where expires_at < $1", [new Date(this.now())]);
		await this.db.query("insert into pim_forge.forge_gitea_oauth_state (state, owner_id, sealed_verifier, expires_at) values ($1,$2,$3,$4)", [state, ownerId, await seal(this.crypto, { verifier }, `${CTX}:state:${state}`), new Date(this.now() + STATE_TTL_MS)]);
		const u = new URL("/login/oauth/authorize", this.config.baseUrl);
		u.search = new URLSearchParams({ client_id: this.config.clientId, redirect_uri: this.config.redirectUri, response_type: "code", state, code_challenge: createHash("sha256").update(verifier).digest("base64url"), code_challenge_method: "S256" }).toString();
		return u.href;
	}

	/** Trades the code for tokens. The state is single-use, belongs to the admin who asked, and expires. */
	async complete(ownerId: string, state: string, code: string): Promise<{ login: string }> {
		const row = await tx(this.db, async (q) => (await q.query<Row>("delete from pim_forge.forge_gitea_oauth_state where state = $1 returning *", [state])).rows[0]);
		if (!row || row.owner_id !== ownerId || new Date(row.expires_at).getTime() < this.now()) throw new ForgeError("invalid", "That Gitea sign-in expired or isn't yours; start again");
		const { verifier } = await open<{ verifier: string }>(this.crypto, row.sealed_verifier, `${CTX}:state:${state}`);
		const tokens = await this.token({ grant_type: "authorization_code", code, redirect_uri: this.config.redirectUri, code_verifier: verifier });
		const me = await this.doFetch(new URL("/api/v1/user", this.config.baseUrl), { headers: { authorization: `Bearer ${tokens.accessToken}` } });
		if (!me.ok) throw new ForgeError("invalid", "Gitea didn't say who signed in");
		const login = String(((await me.json()) as { login?: string }).login ?? "");
		await this.db.query(
			"insert into pim_forge.forge_gitea_connection (singleton, login, sealed, needs_reconnect, connected_by) values (true,$1,$2,false,$3) on conflict (singleton) do update set login = $1, sealed = $2, needs_reconnect = false, connected_by = $3, updated_at = now()",
			[login, await seal(this.crypto, tokens, CTX), ownerId],
		);
		return { login };
	}

	private async token(extra: Record<string, string>): Promise<Tokens> {
		const res = await this.doFetch(new URL("/login/oauth/access_token", this.config.baseUrl), {
			method: "POST",
			headers: { "content-type": "application/json", accept: "application/json" },
			body: JSON.stringify({ client_id: this.config.clientId, client_secret: this.config.clientSecret, ...extra }),
		});
		const j = (await res.json().catch(() => ({}))) as { access_token?: string; refresh_token?: string; expires_in?: number };
		if (!res.ok || !j.access_token) throw new ForgeError("invalid", "Gitea refused the sign-in");
		return { accessToken: j.access_token, refreshToken: j.refresh_token ?? null, expiresAt: j.expires_in ? this.now() + j.expires_in * 1000 : null };
	}

	async status(): Promise<{ connected: boolean; login: string | null; needsReconnect: boolean; baseUrl: string }> {
		const r = (await this.db.query<Row>("select login, needs_reconnect from pim_forge.forge_gitea_connection")).rows[0];
		return { connected: !!r && !r.needs_reconnect, login: r?.login ?? null, needsReconnect: !!r?.needs_reconnect, baseUrl: this.config.baseUrl };
	}

	async disconnect(): Promise<void> {
		await this.db.query("delete from pim_forge.forge_gitea_connection");
	}

	/** An access token for the host's API and git, refreshed when it is about to expire; null when none is connected or the connection needs the admin again. */
	async accessToken(): Promise<string | null> {
		const r = (await this.db.query<Row>("select sealed, needs_reconnect from pim_forge.forge_gitea_connection")).rows[0];
		if (!r || r.needs_reconnect) return null;
		const t = await open<Tokens>(this.crypto, r.sealed, CTX);
		if (!t.expiresAt || t.expiresAt - this.now() > 60_000) return t.accessToken;
		if (!t.refreshToken) return t.accessToken;
		try {
			const next = await this.token({ grant_type: "refresh_token", refresh_token: t.refreshToken });
			await this.db.query("update pim_forge.forge_gitea_connection set sealed = $1, updated_at = now() where sealed = $2", [await seal(this.crypto, next, CTX), r.sealed]);
			return next.accessToken;
		} catch {
			await this.db.query("update pim_forge.forge_gitea_connection set needs_reconnect = true, updated_at = now()");
			return null;
		}
	}
}
