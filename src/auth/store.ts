import { DurableObject } from "cloudflare:workers";
import { base64UrlEncode } from "./encoding";
import type { PublicKey } from "./webauthn";

/**
 * Who may use this Pim: its passkeys, the one-time setup code that creates a
 * passkey without one, and the key that signs session cookies. It lives in
 * its own Durable Object, apart from the agent, so signing in never wakes the
 * agent. One object also makes "use the setup code once" a single step.
 */

export type Passkey = {
	readonly id: string;
	/** Where it was made, such as "Chrome on macOS". */
	readonly name: string;
	readonly createdAt: number;
	readonly lastUsedAt: number;
};

export type SetupCode = { readonly code: string; readonly expiresAt: number };

/** How long a setup link works. */
export const SETUP_CODE_MS = 60 * 60 * 1000;

const SCHEMA = `
CREATE TABLE IF NOT EXISTS auth_passkeys (
	id TEXT PRIMARY KEY,
	spki TEXT NOT NULL,
	algorithm INTEGER NOT NULL,
	name TEXT NOT NULL,
	created_at INTEGER NOT NULL,
	last_used_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS auth_meta (
	key TEXT PRIMARY KEY,
	value TEXT NOT NULL
);
`;

const randomCode = () => base64UrlEncode(crypto.getRandomValues(new Uint8Array(32)));

/** Compares digests, so the time taken says nothing about `expected`. */
async function sameSecret(given: string, expected: string): Promise<boolean> {
	const digest = (text: string) => crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
	return crypto.subtle.timingSafeEqual(await digest(given), await digest(expected));
}

export class Auth extends DurableObject<Env> {
	constructor(ctx: DurableObjectState, env: Env) {
		super(ctx, env);
		ctx.storage.sql.exec(SCHEMA);
	}

	#meta(key: string): string | null {
		const row = this.ctx.storage.sql.exec("SELECT value FROM auth_meta WHERE key = ?", key).toArray()[0];
		return row ? String(row.value) : null;
	}

	#setMeta(key: string, value: string | null) {
		if (value === null) this.ctx.storage.sql.exec("DELETE FROM auth_meta WHERE key = ?", key);
		else this.ctx.storage.sql.exec("INSERT OR REPLACE INTO auth_meta (key, value) VALUES (?, ?)", key, value);
	}

	/** The HMAC key for session cookies, made on first use. */
	cookieKey(): string {
		let key = this.#meta("cookie_key");
		if (!key) this.#setMeta("cookie_key", (key = randomCode()));
		return key;
	}

	publicKey(id: string): PublicKey | null {
		const row = this.ctx.storage.sql.exec("SELECT spki, algorithm FROM auth_passkeys WHERE id = ?", id).toArray()[0];
		return row ? { spki: String(row.spki), algorithm: Number(row.algorithm) } : null;
	}

	hasPasskey(id: string): boolean {
		return this.ctx.storage.sql.exec("SELECT 1 FROM auth_passkeys WHERE id = ?", id).toArray().length > 0;
	}

	passkeys(): Passkey[] {
		return this.ctx.storage.sql
			.exec("SELECT id, name, created_at, last_used_at FROM auth_passkeys ORDER BY created_at")
			.toArray()
			.map((row) => ({
				id: String(row.id),
				name: String(row.name),
				createdAt: Number(row.created_at),
				lastUsedAt: Number(row.last_used_at),
			}));
	}

	addPasskey(id: string, key: PublicKey, name: string, now: number): Passkey {
		this.ctx.storage.sql.exec(
			"INSERT INTO auth_passkeys (id, spki, algorithm, name, created_at, last_used_at) VALUES (?, ?, ?, ?, ?, ?)",
			id,
			key.spki,
			key.algorithm,
			name,
			now,
			now,
		);
		return { id, name, createdAt: now, lastUsedAt: now };
	}

	usePasskey(id: string, now: number) {
		this.ctx.storage.sql.exec("UPDATE auth_passkeys SET last_used_at = ? WHERE id = ?", now, id);
	}

	removePasskey(id: string) {
		this.ctx.storage.sql.exec("DELETE FROM auth_passkeys WHERE id = ?", id);
	}

	#activeSetupCode(now: number): SetupCode | null {
		const stored = this.#meta("setup_code");
		const active = stored ? (JSON.parse(stored) as SetupCode) : null;
		return active && active.expiresAt > now ? active : null;
	}

	/**
	 * The setup code, made when none is active. Asking again returns the same
	 * one until it expires or is used, so asking can't replace the owner's.
	 */
	setupCode(now: number): SetupCode {
		const active = this.#activeSetupCode(now);
		if (active) return active;
		const fresh = { code: randomCode(), expiresAt: now + SETUP_CODE_MS };
		this.#setMeta("setup_code", JSON.stringify(fresh));
		return fresh;
	}

	async isSetupCode(code: string, now: number): Promise<boolean> {
		const active = this.#activeSetupCode(now);
		return active !== null && (await sameSecret(code, active.code));
	}

	/** Uses up the setup code if `code` is it: true for one caller only. */
	async useSetupCode(code: string, now: number): Promise<boolean> {
		const active = this.#activeSetupCode(now);
		if (!active || !(await sameSecret(code, active.code))) return false;
		// Another call may have used it while this one compared: check and use
		// it with no await in between, so only one of them gets it.
		if (this.#activeSetupCode(now)?.code !== active.code) return false;
		this.#setMeta("setup_code", null);
		return true;
	}
}
