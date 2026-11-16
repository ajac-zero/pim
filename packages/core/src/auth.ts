import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import type pg from "pg";
import { withTenant } from "./db.ts";

/** The digest stored for a secret: unsalted SHA-256 hex of the whole token, the same one the legacy API tokens used, so a migrated token keeps working. */
export const hashToken = (token: string): string => createHash("sha256").update(token).digest("hex");

/** What a request is allowed to be: who, through what, and with which scopes. A session carries every scope; a token only its own. */
export interface Principal {
	tenantId: string;
	userId: string;
	role: "admin" | "member" | "guest";
	via: "session" | "token";
	scopes: ReadonlySet<string>;
	/** The id of the session or token, for revocation and audit. */
	credentialId: string;
}

const SESSION_TTL_MS = 30 * 24 * 3600_000;

export async function createSession(pool: pg.Pool, tenantId: string, userId: string, ttlMs = SESSION_TTL_MS): Promise<string> {
	const secret = `pims_${tenantId}.${randomBytes(32).toString("base64url")}`;
	await withTenant(pool, tenantId, (q) => q.run("INSERT INTO app.sessions (tenant_id, token_hash, user_id, expires_at) VALUES ($1, $2, $3, now() + $4::interval)", tenantId, hashToken(secret), userId, `${ttlMs} milliseconds`));
	return secret;
}

/** Creates a scoped API token. The secret is returned once; only its digest is stored. */
export async function createApiToken(pool: pg.Pool, input: { tenantId: string; userId: string; name: string; scopes: string[]; ttlMs?: number }): Promise<{ tokenId: string; secret: string }> {
	const tokenId = randomBytes(8).toString("hex");
	const secret = `pim_${input.tenantId}_${randomBytes(32).toString("base64url")}`;
	await withTenant(pool, input.tenantId, (q) =>
		q.run("INSERT INTO app.api_tokens (tenant_id, token_id, token_hash, user_id, name, scopes, expires_at) VALUES ($1, $2, $3, $4, $5, $6, CASE WHEN $7::bigint IS NULL THEN NULL ELSE now() + ($7::bigint || ' milliseconds')::interval END)", input.tenantId, tokenId, hashToken(secret), input.userId, input.name, input.scopes, input.ttlMs ?? null),
	);
	return { tokenId, secret };
}

/** The tenant a presented credential belongs to is read from the credential, never trusted from the request. Sessions are `pims_<tenant>.<secret>`; legacy API tokens are `pim_<owner>_<secret>`. */
export function tenantOfToken(token: string): string | undefined {
	const match = /^pims_([A-Za-z0-9_-]{1,64})\./.exec(token) ?? /^pim_([A-Za-z0-9-]{1,64})_/.exec(token);
	return match?.[1];
}

/**
 * Resolves a bearer secret to a principal, or undefined. Revocation, expiry, a suspended user and a suspended tenant
 * all fail here, on every request: a revoked credential does not keep working until a cache expires.
 */
export async function authenticate(pool: pg.Pool, tenantId: string, secret: string): Promise<Principal | undefined> {
	const hash = hashToken(secret);
	return withTenant(
		pool,
		tenantId,
		async (q) => {
			const live = `u.status = 'active' AND t.status = 'active'`;
			const session = await q.get<{ user_id: string; role: Principal["role"] }>(
				`SELECT s.user_id, u.role FROM app.sessions s JOIN app.users u ON u.tenant_id = s.tenant_id AND u.user_id = s.user_id JOIN app.tenants t ON t.tenant_id = s.tenant_id
				 WHERE s.token_hash = $1 AND s.tenant_id = $2 AND s.revoked_at IS NULL AND s.expires_at > now() AND ${live}`,
				hash,
				tenantId,
			);
			if (session) return { tenantId, userId: session.user_id, role: session.role, via: "session" as const, scopes: new Set(["*"]), credentialId: hash };
			const token = await q.get<{ token_id: string; user_id: string; role: Principal["role"]; scopes: string[] }>(
				`SELECT k.token_id, k.user_id, u.role, k.scopes FROM app.api_tokens k JOIN app.users u ON u.tenant_id = k.tenant_id AND u.user_id = k.user_id JOIN app.tenants t ON t.tenant_id = k.tenant_id
				 WHERE k.token_hash = $1 AND k.tenant_id = $2 AND k.revoked_at IS NULL AND (k.expires_at IS NULL OR k.expires_at > now()) AND ${live}`,
				hash,
				tenantId,
			);
			if (token) return { tenantId, userId: token.user_id, role: token.role, via: "token" as const, scopes: new Set(token.scopes), credentialId: token.token_id };
			return undefined;
		},
		{ readOnly: true },
	);
}

export async function revokeSession(pool: pg.Pool, tenantId: string, userId: string, secretOrAll: string | "all"): Promise<number> {
	return withTenant(pool, tenantId, (q) =>
		secretOrAll === "all"
			? q.run("UPDATE app.sessions SET revoked_at = now() WHERE tenant_id = $1 AND user_id = $2 AND revoked_at IS NULL", tenantId, userId)
			: q.run("UPDATE app.sessions SET revoked_at = now() WHERE tenant_id = $1 AND user_id = $2 AND token_hash = $3 AND revoked_at IS NULL", tenantId, userId, hashToken(secretOrAll)),
	);
}

export async function revokeToken(pool: pg.Pool, tenantId: string, tokenId: string): Promise<boolean> {
	return (await withTenant(pool, tenantId, (q) => q.run("UPDATE app.api_tokens SET revoked_at = now() WHERE tenant_id = $1 AND token_id = $2 AND revoked_at IS NULL", tenantId, tokenId))) === 1;
}

const RECOVERY_ALPHABET = "abcdefghjkmnpqrstuvwxyz23456789";
export function newRecoveryCodes(count = 8): string[] {
	return Array.from({ length: count }, () => Array.from(randomBytes(16), (b) => RECOVERY_ALPHABET[b % RECOVERY_ALPHABET.length]).join("").replace(/(.{4})(?=.)/g, "$1-"));
}

export async function storeRecoveryCodes(pool: pg.Pool, tenantId: string, userId: string, codes: string[]): Promise<void> {
	await withTenant(pool, tenantId, async (q) => {
		await q.run("DELETE FROM app.recovery_codes WHERE tenant_id = $1 AND user_id = $2", tenantId, userId);
		for (const code of codes) await q.run("INSERT INTO app.recovery_codes (tenant_id, user_id, code_hash) VALUES ($1, $2, $3)", tenantId, userId, hashToken(code));
	});
}

/** Spends a recovery code (once) and returns a fresh session: the sign-in path when the passkey is lost. */
export async function signInWithRecoveryCode(pool: pg.Pool, tenantId: string, username: string, code: string): Promise<string | undefined> {
	const userId = await withTenant(pool, tenantId, async (q) => {
		const row = await q.get<{ user_id: string }>(
			`UPDATE app.recovery_codes c SET used_at = now() FROM app.users u
			 WHERE c.tenant_id = $1 AND c.code_hash = $2 AND c.used_at IS NULL AND u.tenant_id = c.tenant_id AND u.user_id = c.user_id AND u.username = $3 AND u.status = 'active'
			 RETURNING c.user_id`,
			tenantId,
			hashToken(code),
			username,
		);
		return row?.user_id;
	});
	return userId === undefined ? undefined : createSession(pool, tenantId, userId);
}

export const constantTimeEqual = (a: string, b: string): boolean => {
	const x = Buffer.from(a);
	const y = Buffer.from(b);
	return x.length === y.length && timingSafeEqual(x, y);
};
