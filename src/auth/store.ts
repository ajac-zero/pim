import { DurableObject } from "cloudflare:workers";
import { base64UrlEncode } from "./encoding";
import type { PublicKey } from "./webauthn";

/**
 * Who may use one Pim: its passkeys, whether it has ever had one (so the
 * first can be claimed only once), the one-time setup code that creates a
 * passkey without one, recovery codes, API tokens, and the key that signs
 * session cookies. It lives in its own Durable Object, apart from the agent,
 * so signing in never wakes the agent. One object also makes "use the setup
 * code once" a single step. A hosted service has one per owner.
 */

export type Passkey = {
	readonly id: string;
	/** Where it was made, such as "Chrome on macOS". */
	readonly name: string;
	readonly createdAt: number;
	readonly lastUsedAt: number;
};

export type SetupCode = { readonly code: string; readonly expiresAt: number };

/** An API token as listed: its secret is shown once, when it is made. */
export type ApiToken = { readonly id: string; readonly name: string; readonly createdAt: number; readonly lastUsedAt: number | null };

/** How many recovery codes a set has. */
export const RECOVERY_CODES = 10;

/** How long a link that adds another device works. */
export const DEVICE_LINK_MS = 10 * 60 * 1000;

/** A link to add another device, made by a signed-in browser: it makes one passkey, once, before it expires. */
export type DeviceLink = { readonly code: string; readonly expiresAt: number };

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
CREATE TABLE IF NOT EXISTS auth_tokens (
	id TEXT PRIMARY KEY,
	name TEXT NOT NULL,
	hash TEXT NOT NULL UNIQUE,
	created_at INTEGER NOT NULL,
	last_used_at INTEGER
);
CREATE TABLE IF NOT EXISTS auth_recovery_codes (
	hash TEXT PRIMARY KEY,
	created_at INTEGER NOT NULL,
	used_at INTEGER
);
CREATE TABLE IF NOT EXISTS auth_device_links (
	hash TEXT PRIMARY KEY,
	passkey TEXT NOT NULL,
	created_at INTEGER NOT NULL,
	expires_at INTEGER NOT NULL
);
`;

const randomCode = () => base64UrlEncode(crypto.getRandomValues(new Uint8Array(32)));

/** SHA-256 in hex: how tokens and recovery codes are stored. They are random, so the digest alone is safe to keep. */
export async function digestHex(text: string): Promise<string> {
	const bytes = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text)));
	return [...bytes].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

/** Crockford's base32, without the letters people misread. */
const CODE_ALPHABET = "0123456789abcdefghjkmnpqrstvwxyz";

/** A recovery code as people write it: 15 characters (75 bits) in groups of five, like `k7m2q-9fxc3-hdp4w`. */
function recoveryCode(): string {
	const chars = [...crypto.getRandomValues(new Uint8Array(15))].map((byte) => CODE_ALPHABET[byte & 31]);
	return [0, 5, 10].map((start) => chars.slice(start, start + 5).join("")).join("-");
}

/** A recovery code as typed: any case, with or without dashes and spaces. */
export function normalizeRecoveryCode(code: string): string {
	return code.toLowerCase().replace(/[\s-]/g, "");
}

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

	/** Whether this Pim has ever had a passkey, even if all were removed since. */
	claimed(): boolean {
		return this.#meta("claimed") !== null;
	}

	/** Adds the first passkey ever, or nothing if this Pim was claimed already. */
	claim(id: string, key: PublicKey, name: string, now: number): Passkey | null {
		return this.claimed() ? null : this.addPasskey(id, key, name, now);
	}

	addPasskey(id: string, key: PublicKey, name: string, now: number): Passkey {
		this.#setMeta("claimed", String(now));
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
		// Links that passkey's browser issued go with it.
		this.ctx.storage.sql.exec("DELETE FROM auth_device_links WHERE passkey = ?", id);
	}

	#activeSetupCode(now: number): SetupCode | null {
		const stored = this.#meta("setup_code");
		const active = stored ? (JSON.parse(stored) as SetupCode) : null;
		return active && active.expiresAt > now ? active : null;
	}

	/**
	 * A new setup code that replaces any active one, for whoever was trusted to
	 * hand it out: a hosted service's registration, or its operator helping a
	 * person who lost every passkey and recovery code.
	 */
	issueSetupCode(now: number, ttlMs: number): SetupCode {
		const fresh = { code: randomCode(), expiresAt: now + ttlMs };
		this.#setMeta("setup_code", JSON.stringify(fresh));
		return fresh;
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

	// Device links: a signed-in browser hands one to the person's other device.

	/**
	 * A new link to add a device, issued for the passkey that signed in the
	 * browser asking. It works once, for `DEVICE_LINK_MS`, and only while that
	 * passkey is still one of this Pim's: removing the passkey, or signing out
	 * everywhere by removing it, voids the links it issued. Making a new link
	 * voids that passkey's older ones, so only the latest is live. Only its
	 * digest is kept. It is separate from the setup code, so issuing one never
	 * replaces a link registration or the operator gave out.
	 */
	async newDeviceLink(passkey: string, now: number): Promise<DeviceLink> {
		const code = randomCode();
		const hash = await digestHex(code);
		const expiresAt = now + DEVICE_LINK_MS;
		this.ctx.storage.transactionSync(() => {
			this.ctx.storage.sql.exec("DELETE FROM auth_device_links WHERE expires_at <= ? OR passkey = ?", now, passkey);
			this.ctx.storage.sql.exec(
				"INSERT INTO auth_device_links (hash, passkey, created_at, expires_at) VALUES (?, ?, ?, ?)",
				hash,
				passkey,
				now,
				expiresAt,
			);
		});
		return { code, expiresAt };
	}

	/** Voids the links a passkey's browser issued, when it signs out. */
	voidDeviceLinks(passkey: string): void {
		this.ctx.storage.sql.exec("DELETE FROM auth_device_links WHERE passkey = ?", passkey);
	}

	/** Whether `code` is a live device link: unexpired, unused, and its issuing passkey still here. */
	async isDeviceLink(code: string, now: number): Promise<boolean> {
		const hash = await digestHex(code);
		return this.#liveDeviceLink(hash, now);
	}

	#liveDeviceLink(hash: string, now: number): boolean {
		return (
			this.ctx.storage.sql
				.exec(
					"SELECT 1 FROM auth_device_links l JOIN auth_passkeys p ON p.id = l.passkey WHERE l.hash = ? AND l.expires_at > ?",
					hash,
					now,
				)
				.toArray().length > 0
		);
	}

	/** Uses up a device link: true for one caller only. */
	async useDeviceLink(code: string, now: number): Promise<boolean> {
		const hash = await digestHex(code);
		// Checked and deleted with no await in between, so two tabs can't both use it.
		if (!this.#liveDeviceLink(hash, now)) return false;
		return this.ctx.storage.sql.exec("DELETE FROM auth_device_links WHERE hash = ?", hash).rowsWritten > 0;
	}

	// Recovery codes: each makes one passkey once, for someone who lost theirs.

	/** A new set of recovery codes, replacing the old set. Only their digests are kept: the codes are shown once. */
	async newRecoveryCodes(now: number): Promise<string[]> {
		const codes = Array.from({ length: RECOVERY_CODES }, recoveryCode);
		const hashes = await Promise.all(codes.map((code) => digestHex(normalizeRecoveryCode(code))));
		this.ctx.storage.transactionSync(() => {
			this.ctx.storage.sql.exec("DELETE FROM auth_recovery_codes");
			for (const hash of hashes) this.ctx.storage.sql.exec("INSERT INTO auth_recovery_codes (hash, created_at) VALUES (?, ?)", hash, now);
		});
		return codes;
	}

	recoveryCodesLeft(): number {
		return Number(this.ctx.storage.sql.exec("SELECT COUNT(*) AS n FROM auth_recovery_codes WHERE used_at IS NULL").one().n);
	}

	isRecoveryCode(hash: string): boolean {
		return this.ctx.storage.sql.exec("SELECT 1 FROM auth_recovery_codes WHERE hash = ? AND used_at IS NULL", hash).toArray().length > 0;
	}

	/** Uses up a recovery code: true for one caller only. */
	useRecoveryCode(hash: string, now: number): boolean {
		return this.ctx.storage.sql.exec("UPDATE auth_recovery_codes SET used_at = ? WHERE hash = ? AND used_at IS NULL", now, hash).rowsWritten > 0;
	}

	// API tokens, for clients other than the web app.

	/** A new token; its secret is returned only here. */
	async createToken(name: string, now: number): Promise<ApiToken & { token: string }> {
		const id = base64UrlEncode(crypto.getRandomValues(new Uint8Array(9)));
		const token = `pim_${randomCode()}`;
		this.ctx.storage.sql.exec(
			"INSERT INTO auth_tokens (id, name, hash, created_at) VALUES (?, ?, ?, ?)",
			id,
			name,
			await digestHex(token),
			now,
		);
		return { id, name, createdAt: now, lastUsedAt: null, token };
	}

	tokens(): ApiToken[] {
		return this.ctx.storage.sql
			.exec("SELECT id, name, created_at, last_used_at FROM auth_tokens ORDER BY created_at")
			.toArray()
			.map((row) => ({
				id: String(row.id),
				name: String(row.name),
				createdAt: Number(row.created_at),
				lastUsedAt: row.last_used_at === null ? null : Number(row.last_used_at),
			}));
	}

	revokeToken(id: string): boolean {
		return this.ctx.storage.sql.exec("DELETE FROM auth_tokens WHERE id = ?", id).rowsWritten > 0;
	}

	/** Whether `token` is one of this Pim's; notes when it was used, at most once a minute. */
	async checkToken(token: string, now: number): Promise<boolean> {
		const hash = await digestHex(token);
		const row = this.ctx.storage.sql.exec("SELECT last_used_at FROM auth_tokens WHERE hash = ?", hash).toArray()[0];
		if (!row) return false;
		if (row.last_used_at === null || now - Number(row.last_used_at) > 60_000) {
			this.ctx.storage.sql.exec("UPDATE auth_tokens SET last_used_at = ? WHERE hash = ?", now, hash);
		}
		return true;
	}

	/**
	 * Forgets everything: passkeys, codes, tokens and the cookie key, so no
	 * session or token works again. What is left is an empty Auth that can't
	 * be claimed without a setup code.
	 */
	async deleteEverything(): Promise<void> {
		await this.ctx.storage.deleteAll();
		this.ctx.storage.sql.exec(SCHEMA);
	}
}
