import { DurableObject } from "cloudflare:workers";
import { base64UrlEncode } from "../auth/encoding";
import { digestHex } from "../auth/store";

/**
 * Pimling's accounts: which owner each username belongs to, and whether the
 * account works. One Durable Object for the whole service, so a username is
 * taken exactly once and registration limits are exact.
 *
 * An owner ID is random and never changes; the person's agent and sign-in
 * are named after it, never after the username. A username is never reused,
 * even after its account is deleted: apps and sign-ins were sent to its
 * hostname, and a new owner must not receive them. Only a registration that
 * never made a passkey gives its username back, a day later.
 */

export type AccountStatus = "pending" | "active" | "suspended" | "deleted";

export type Account = {
	readonly ownerId: string;
	readonly username: string;
	readonly status: AccountStatus;
	readonly createdAt: number;
	/** When the first passkey was made. */
	readonly activatedAt: number | null;
	/** A pending registration's username is given back after this. */
	readonly pendingUntil: number | null;
	readonly statusReason: string | null;
	readonly statusChangedAt: number | null;
};

export type Registration =
	| { readonly ok: true; readonly account: Account; /** A pending registration that lapsed and gave its username up: its objects can be cleared. */ readonly released: string | null }
	| { readonly ok: false; readonly status: number; readonly error: string };

export type RegistrationPolicy = {
	readonly mode: "open" | "invite" | "closed";
	/** Accounts allowed in all, deleted ones not counted; null for no cap. */
	readonly maxAccounts: number | null;
	/** Registrations one IP address may make in a day. */
	readonly perAddressPerDay: number;
};

/** How long a registration may go without a passkey before its username is given back. */
export const PENDING_MS = 24 * 60 * 60 * 1000;
const DAY_MS = 24 * 60 * 60 * 1000;

const SCHEMA = `
CREATE TABLE IF NOT EXISTS accounts (
	owner_id TEXT PRIMARY KEY,
	username TEXT NOT NULL UNIQUE,
	status TEXT NOT NULL,
	created_at INTEGER NOT NULL,
	activated_at INTEGER,
	pending_until INTEGER,
	status_reason TEXT,
	status_changed_at INTEGER
);
CREATE INDEX IF NOT EXISTS accounts_by_status ON accounts (status, created_at);
CREATE TABLE IF NOT EXISTS registrations (
	address TEXT NOT NULL,
	at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS registrations_by_address ON registrations (address, at);
CREATE TABLE IF NOT EXISTS invites (
	hash TEXT PRIMARY KEY,
	note TEXT,
	created_at INTEGER NOT NULL,
	used_by TEXT,
	used_at INTEGER
);
CREATE TABLE IF NOT EXISTS directory_meta (
	key TEXT PRIMARY KEY,
	value TEXT NOT NULL
);
`;

type Row = Record<string, SqlStorageValue>;

const optionalNumber = (value: SqlStorageValue | undefined) => (value === null || value === undefined ? null : Number(value));

function accountOf(row: Row): Account {
	return {
		ownerId: String(row.owner_id),
		username: String(row.username),
		status: String(row.status) as AccountStatus,
		createdAt: Number(row.created_at),
		activatedAt: optionalNumber(row.activated_at),
		pendingUntil: optionalNumber(row.pending_until),
		statusReason: row.status_reason === null ? null : String(row.status_reason),
		statusChangedAt: optionalNumber(row.status_changed_at),
	};
}

/** A lowercase random ID, safe in hostnames, paths and object names: `o_` and 26 base32 characters (130 bits). */
function newOwnerId(): string {
	const alphabet = "0123456789abcdefghjkmnpqrstvwxyz";
	return `o_${[...crypto.getRandomValues(new Uint8Array(26))].map((byte) => alphabet[byte & 31]).join("")}`;
}

export class Directory extends DurableObject<Env> {
	constructor(ctx: DurableObjectState, env: Env) {
		super(ctx, env);
		ctx.storage.sql.exec(SCHEMA);
	}

	#sql(query: string, ...bindings: unknown[]) {
		return this.ctx.storage.sql.exec(query, ...bindings);
	}

	/** Addresses are kept only as salted digests, and only for a day. */
	async #address(ip: string): Promise<string> {
		let salt = this.#sql("SELECT value FROM directory_meta WHERE key = 'salt'").toArray()[0]?.value as string | undefined;
		if (!salt) {
			salt = base64UrlEncode(crypto.getRandomValues(new Uint8Array(32)));
			this.#sql("INSERT INTO directory_meta (key, value) VALUES ('salt', ?)", salt);
		}
		return digestHex(`${salt}:${ip}`);
	}

	#byUsername(username: string): Account | null {
		const row = this.#sql("SELECT * FROM accounts WHERE username = ?", username).toArray()[0];
		return row ? accountOf(row) : null;
	}

	/** The account a username names, if it has one; a lapsed registration has none. */
	resolve(username: string, now = Date.now()): Account | null {
		const account = this.#byUsername(username);
		if (account?.status === "pending" && (account.pendingUntil ?? 0) <= now) return null;
		return account;
	}

	account(ownerId: string): Account | null {
		const row = this.#sql("SELECT * FROM accounts WHERE owner_id = ?", ownerId).toArray()[0];
		return row ? accountOf(row) : null;
	}

	/** Takes `username` for a new owner, if the policy and the address's recent registrations allow it. */
	async register(input: { username: string; ip: string; invite?: string; policy: RegistrationPolicy; now?: number }): Promise<Registration> {
		const now = input.now ?? Date.now();
		const { policy } = input;
		if (policy.mode === "closed") return { ok: false, status: 403, error: "Registration is closed." };
		const address = await this.#address(input.ip);
		const invite = policy.mode === "invite" && input.invite ? await digestHex(input.invite.trim()) : null;
		// No awaits from here on: checking and taking the username is one step.
		this.#sql("DELETE FROM registrations WHERE at < ?", now - DAY_MS);
		const recent = Number(this.#sql("SELECT COUNT(*) AS n FROM registrations WHERE address = ?", address).one().n);
		if (recent >= policy.perAddressPerDay) {
			return { ok: false, status: 429, error: "Too many registrations from this network today. Try again tomorrow." };
		}
		if (policy.mode === "invite") {
			const unused = invite && this.#sql("SELECT 1 FROM invites WHERE hash = ? AND used_at IS NULL", invite).toArray().length > 0;
			if (!unused) return { ok: false, status: 403, error: "Registration needs an invite code, and that one isn't valid." };
		}
		if (policy.maxAccounts !== null) {
			const live = Number(this.#sql("SELECT COUNT(*) AS n FROM accounts WHERE status != 'deleted'").one().n);
			if (live >= policy.maxAccounts) return { ok: false, status: 503, error: "Pimling is full for now. Try again later." };
		}
		let released: string | null = null;
		const existing = this.#byUsername(input.username);
		if (existing) {
			const lapsed = existing.status === "pending" && (existing.pendingUntil ?? 0) <= now;
			if (!lapsed) return { ok: false, status: 409, error: "That username is taken." };
			this.#sql("DELETE FROM accounts WHERE owner_id = ?", existing.ownerId);
			released = existing.ownerId;
		}
		const ownerId = newOwnerId();
		this.#sql(
			"INSERT INTO accounts (owner_id, username, status, created_at, pending_until, status_changed_at) VALUES (?, ?, 'pending', ?, ?, ?)",
			ownerId,
			input.username,
			now,
			now + PENDING_MS,
			now,
		);
		this.#sql("INSERT INTO registrations (address, at) VALUES (?, ?)", address, now);
		if (invite) this.#sql("UPDATE invites SET used_by = ?, used_at = ? WHERE hash = ?", ownerId, now, invite);
		return { ok: true, account: this.account(ownerId)!, released };
	}

	/** The account's first passkey was made: it is the owner's now, for good. */
	activate(ownerId: string, now = Date.now()): Account | null {
		this.#sql(
			"UPDATE accounts SET status = 'active', activated_at = ?, pending_until = NULL, status_changed_at = ? WHERE owner_id = ? AND status = 'pending'",
			now,
			now,
			ownerId,
		);
		return this.account(ownerId);
	}

	/** Suspends or restores an account; a deleted one stays deleted. */
	setStatus(ownerId: string, status: "active" | "suspended", reason: string | null, now = Date.now()): Account | null {
		this.#sql(
			"UPDATE accounts SET status = ?, status_reason = ?, status_changed_at = ? WHERE owner_id = ? AND status IN ('active', 'suspended')",
			status,
			reason,
			now,
			ownerId,
		);
		return this.account(ownerId);
	}

	/** The account is gone; its username stays taken so nobody inherits what was sent to its hostname. */
	markDeleted(ownerId: string, reason: string, now = Date.now()): Account | null {
		this.#sql(
			"UPDATE accounts SET status = 'deleted', status_reason = ?, status_changed_at = ?, pending_until = NULL WHERE owner_id = ?",
			reason,
			now,
			ownerId,
		);
		return this.account(ownerId);
	}

	list(options: { status?: AccountStatus; after?: string; limit?: number } = {}): Account[] {
		const limit = Math.min(Math.max(options.limit ?? 100, 1), 500);
		return this.#sql(
			`SELECT * FROM accounts WHERE (? IS NULL OR status = ?) AND username > ? ORDER BY username LIMIT ?`,
			options.status ?? null,
			options.status ?? null,
			options.after ?? "",
			limit,
		)
			.toArray()
			.map(accountOf);
	}

	stats(now = Date.now()) {
		const byStatus = Object.fromEntries(
			this.#sql("SELECT status, COUNT(*) AS n FROM accounts GROUP BY status")
				.toArray()
				.map((row) => [String(row.status), Number(row.n)]),
		);
		return {
			accounts: { pending: 0, active: 0, suspended: 0, deleted: 0, ...byStatus },
			registrationsLastDay: Number(this.#sql("SELECT COUNT(*) AS n FROM accounts WHERE created_at >= ?", now - DAY_MS).one().n),
			invitesUnused: Number(this.#sql("SELECT COUNT(*) AS n FROM invites WHERE used_at IS NULL").one().n),
		};
	}

	/** Single-use invite codes; only their digests are kept. */
	async createInvites(count: number, note: string | null, now = Date.now()): Promise<string[]> {
		const codes = Array.from({ length: count }, () => `inv_${base64UrlEncode(crypto.getRandomValues(new Uint8Array(15)))}`);
		const hashes = await Promise.all(codes.map((code) => digestHex(code)));
		for (const hash of hashes) this.#sql("INSERT INTO invites (hash, note, created_at) VALUES (?, ?, ?)", hash, note, now);
		return codes;
	}
}
