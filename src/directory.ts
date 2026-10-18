import { getAgentByName } from "agents";
import { DurableObject } from "cloudflare:workers";
import { base64UrlEncode } from "./auth/encoding";
import { digestHex } from "./auth/store";

/**
 * The accounts on this Pim: which owner each username belongs to, who the
 * admin is, and whether each account works. One Durable Object for the
 * instance, so a username is taken exactly once, there is one admin, and
 * registration limits are exact. It also keeps the key that seals sign-in
 * cookies, the setup code that lets the instance be claimed from its logs,
 * and whose each linked identity is, so one account at Google or GitHub
 * signs in to one person here.
 *
 * The first account is the admin's. It is made by whoever opens the Pim in
 * the minutes after a deploy, or with a link from the Worker's logs, which
 * only someone signed in to the Cloudflare account can read. Everyone else
 * joins with an invite the admin makes, unless registration is open.
 *
 * An owner ID is random and never changes; the person's space and sign-in
 * are named after it, never after the username. A username is never reused
 * once its account is active, even after deletion, so nobody inherits what
 * others knew by that name. Only a registration that never made a passkey
 * gives its username back: when setting it up fails, or a day later.
 *
 * Erasing an owner's space and sign-in is a cleanup job kept here, so it
 * survives failures: it is tried at once, retried on this object's alarm
 * until it succeeds, and counts as done only when the space is marked
 * erased (it then refuses every request, however late) and both objects are
 * checked empty. An account being deleted is `deleting` until then, and
 * already opens nothing.
 */

export type AccountStatus = "pending" | "active" | "suspended" | "deleting" | "deleted";

export type Role = "admin" | "member";

export type Account = {
	readonly ownerId: string;
	readonly username: string;
	readonly role: Role;
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
	| { readonly ok: true; readonly account: Account }
	| { readonly ok: false; readonly status: number; readonly error: string };

export type RegistrationPolicy = {
	/** How members join once there is an admin. */
	readonly mode: "open" | "invite" | "closed";
	/** Accounts allowed in all, deleted ones not counted; null for no cap. */
	readonly maxAccounts: number | null;
	/** Registrations one IP address may make in a day. */
	readonly perAddressPerDay: number;
};

/** How someone may claim a Pim that has no admin: in the window after a deploy, or with the setup code from the logs. */
export type Claim = { readonly window: boolean; readonly code?: string };

/** The setup code that claims a Pim with no admin, as the Worker writes it to its logs. */
export type ClaimCode = { readonly code: string; readonly expiresAt: number };

/** How long a claim link from the logs works. */
const CLAIM_CODE_MS = 60 * 60 * 1000;

/** A job that erases an owner's space and sign-in: of a deleted account, or of a registration that never finished. */
export type Cleanup = {
	readonly ownerId: string;
	readonly kind: "deletion" | "release";
	readonly requestedAt: number;
	readonly attempts: number;
	readonly nextAttemptAt: number;
	readonly lastError: string | null;
};

export type CleanupResult = { readonly done: true } | { readonly done: false; readonly error: string; readonly nextAttemptAt: number };

/** How long a registration may go without a passkey before its username is given back. */
export const PENDING_MS = 24 * 60 * 60 * 1000;
const DAY_MS = 24 * 60 * 60 * 1000;
/** Waits between cleanup attempts: a minute, five, half an hour, two hours, then every six. */
const RETRY_MS = [60_000, 5 * 60_000, 30 * 60_000, 2 * 60 * 60_000, 6 * 60 * 60_000];
/** Cleanups one alarm runs, so a backlog can't hold the Directory for long. */
const CLEANUPS_PER_ALARM = 20;

const SCHEMA = `
CREATE TABLE IF NOT EXISTS accounts (
	owner_id TEXT PRIMARY KEY,
	username TEXT NOT NULL UNIQUE,
	role TEXT NOT NULL DEFAULT 'member',
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
CREATE TABLE IF NOT EXISTS cleanups (
	owner_id TEXT PRIMARY KEY,
	kind TEXT NOT NULL,
	requested_at INTEGER NOT NULL,
	attempts INTEGER NOT NULL DEFAULT 0,
	next_attempt_at INTEGER NOT NULL,
	last_error TEXT
);
CREATE TABLE IF NOT EXISTS identities (
	issuer TEXT NOT NULL,
	subject TEXT NOT NULL,
	owner_id TEXT NOT NULL,
	PRIMARY KEY (issuer, subject)
);
CREATE INDEX IF NOT EXISTS identities_by_owner ON identities (owner_id);
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
		role: row.role === "admin" ? "admin" : "member",
		status: String(row.status) as AccountStatus,
		createdAt: Number(row.created_at),
		activatedAt: optionalNumber(row.activated_at),
		pendingUntil: optionalNumber(row.pending_until),
		statusReason: row.status_reason === null ? null : String(row.status_reason),
		statusChangedAt: optionalNumber(row.status_changed_at),
	};
}

function cleanupOf(row: Row): Cleanup {
	return {
		ownerId: String(row.owner_id),
		kind: String(row.kind) as Cleanup["kind"],
		requestedAt: Number(row.requested_at),
		attempts: Number(row.attempts),
		nextAttemptAt: Number(row.next_attempt_at),
		lastError: row.last_error === null ? null : String(row.last_error),
	};
}

/** A lowercase random ID, safe in paths, tokens and object names: `o_` and 26 base32 characters (130 bits). */
function newOwnerId(): string {
	const alphabet = "0123456789abcdefghjkmnpqrstvwxyz";
	return `o_${[...crypto.getRandomValues(new Uint8Array(26))].map((byte) => alphabet[byte & 31]).join("")}`;
}

function log(event: string, fields: Record<string, unknown>): void {
	console.log(JSON.stringify({ event: `pim.${event}`, ...fields }));
}

export class Directory extends DurableObject<Env> {
	/** Cleanups running in this instance, so the alarm and a request don't run one twice at once. */
	readonly #running = new Map<string, Promise<CleanupResult>>();

	constructor(ctx: DurableObjectState, env: Env) {
		super(ctx, env);
		ctx.storage.sql.exec(SCHEMA);
	}

	#sql(query: string, ...bindings: unknown[]) {
		return this.ctx.storage.sql.exec(query, ...bindings);
	}

	#meta(key: string): string | null {
		const row = this.#sql("SELECT value FROM directory_meta WHERE key = ?", key).toArray()[0];
		return row ? String(row.value) : null;
	}

	#setMeta(key: string, value: string | null): void {
		if (value === null) this.#sql("DELETE FROM directory_meta WHERE key = ?", key);
		else this.#sql("INSERT OR REPLACE INTO directory_meta (key, value) VALUES (?, ?)", key, value);
	}

	/** The HMAC key that seals sign-in cookies for everyone on this Pim, made on first use. */
	cookieKey(): string {
		let key = this.#meta("cookie_key");
		if (!key) this.#setMeta("cookie_key", (key = base64UrlEncode(crypto.getRandomValues(new Uint8Array(32)))));
		return key;
	}

	/** Whose a linked identity is, if anyone's. */
	identityOwner(issuer: string, subject: string): string | null {
		const row = this.#sql("SELECT owner_id FROM identities WHERE issuer = ? AND subject = ?", issuer, subject).toArray()[0];
		return row ? String(row.owner_id) : null;
	}

	/** Takes an identity for `ownerId`: true unless it is someone else's. */
	claimIdentity(issuer: string, subject: string, ownerId: string): boolean {
		this.#sql("INSERT INTO identities (issuer, subject, owner_id) VALUES (?, ?, ?) ON CONFLICT DO NOTHING", issuer, subject, ownerId);
		return this.identityOwner(issuer, subject) === ownerId;
	}

	/** Lets an identity go, if it is `ownerId`'s, so another account may link it. */
	releaseIdentity(issuer: string, subject: string, ownerId: string): void {
		this.#sql("DELETE FROM identities WHERE issuer = ? AND subject = ? AND owner_id = ?", issuer, subject, ownerId);
	}

	/** The admin's account, unless there is none yet: a claim that lapsed or an admin who deleted their account leaves the Pim to be claimed again. */
	admin(now = Date.now()): Account | null {
		const row = this.#sql(
			"SELECT * FROM accounts WHERE role = 'admin' AND (status IN ('active', 'suspended') OR (status = 'pending' AND pending_until > ?))",
			now,
		).toArray()[0];
		return row ? accountOf(row) : null;
	}

	/**
	 * The setup code that claims this Pim while it has no admin, made when none
	 * is active. Asking again returns the same one until it expires or is used,
	 * so asking can't replace the one the operator is about to open.
	 */
	claimCode(now = Date.now()): ClaimCode {
		const stored = this.#meta("claim_code");
		const active = stored ? (JSON.parse(stored) as ClaimCode) : null;
		if (active && active.expiresAt > now) return active;
		const fresh = { code: base64UrlEncode(crypto.getRandomValues(new Uint8Array(32))), expiresAt: now + CLAIM_CODE_MS };
		this.#setMeta("claim_code", JSON.stringify(fresh));
		return fresh;
	}

	async #isClaimCode(code: string, now: number): Promise<boolean> {
		const stored = this.#meta("claim_code");
		const active = stored ? (JSON.parse(stored) as ClaimCode) : null;
		if (!active || active.expiresAt <= now) return false;
		const digest = (text: string) => crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
		return crypto.subtle.timingSafeEqual(await digest(code), await digest(active.code));
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

	/** Whether anyone but this owner has an active account: alone, there is nobody to share with or publish for. */
	hasOthers(ownerId: string): boolean {
		return this.#sql("SELECT 1 FROM accounts WHERE status = 'active' AND owner_id != ? LIMIT 1", ownerId).toArray().length > 0;
	}

	/**
	 * Gives back a registration that never made a passkey: its username, its
	 * place under `maxAccounts`, and the invite it used, which works again.
	 * Its objects are erased by a cleanup job. Synchronous, so it can sit
	 * inside registration's single step.
	 */
	#release(ownerId: string, now: number, why: string): void {
		const removed = this.#sql("DELETE FROM accounts WHERE owner_id = ? AND status = 'pending'", ownerId).rowsWritten > 0;
		if (!removed) return;
		this.#sql("UPDATE invites SET used_by = NULL, used_at = NULL WHERE used_by = ?", ownerId);
		this.#sql("DELETE FROM identities WHERE owner_id = ?", ownerId);
		this.#enqueue(ownerId, "release", now);
		log("registration_released", { owner: ownerId, why });
	}

	/** Releases every registration whose day ran out without a passkey. */
	#releaseLapsed(now: number): void {
		const lapsed = this.#sql("SELECT owner_id FROM accounts WHERE status = 'pending' AND pending_until <= ?", now).toArray();
		for (const row of lapsed) this.#release(String(row.owner_id), now, "lapsed");
	}

	/**
	 * Takes `username` for a new owner. While the Pim has no admin, only a
	 * claim makes an account, and it is the admin's. After that, members join
	 * as the policy says, within the address's recent registrations.
	 */
	async register(input: {
		username: string;
		ip: string;
		invite?: string;
		claim?: Claim;
		policy: RegistrationPolicy;
		now?: number;
	}): Promise<Registration> {
		const now = input.now ?? Date.now();
		const address = await this.#address(input.ip);
		const invite = input.policy.mode === "invite" && input.invite ? await digestHex(input.invite.trim()) : null;
		const claimCode = input.claim?.code ? await this.#isClaimCode(input.claim.code, now) : false;
		// No awaits from here on: checking and taking the username, the invite, the admin's place and a place is one step.
		const result = this.#takeUsername(input.username, address, invite, Boolean(input.claim?.window) || claimCode, input.policy, now);
		if (result.ok && result.account.role === "admin" && claimCode) this.#setMeta("claim_code", null);
		await this.#scheduleAlarm();
		return result;
	}

	#takeUsername(username: string, address: string, invite: string | null, claim: boolean, policy: RegistrationPolicy, now: number): Registration {
		this.#sql("DELETE FROM registrations WHERE at < ?", now - DAY_MS);
		const recent = Number(this.#sql("SELECT COUNT(*) AS n FROM registrations WHERE address = ?", address).one().n);
		if (recent >= policy.perAddressPerDay) {
			return { ok: false, status: 429, error: "Too many registrations from this network today. Try again tomorrow." };
		}
		// Lapsed registrations hold no username, place, invite or claim.
		this.#releaseLapsed(now);
		const role: Role = this.admin(now) === null ? "admin" : "member";
		if (role === "admin" && !claim) {
			return {
				ok: false,
				status: 403,
				error: "This Pim isn't set up yet. Open it within 15 minutes of deploying it, or use the setup link from the Worker's logs.",
			};
		}
		if (role === "member") {
			if (policy.mode === "closed") return { ok: false, status: 403, error: "Registration is closed." };
			if (policy.mode === "invite") {
				const unused = invite && this.#sql("SELECT 1 FROM invites WHERE hash = ? AND used_at IS NULL", invite).toArray().length > 0;
				if (!unused) return { ok: false, status: 403, error: "Joining needs an invite, and that one isn't valid." };
			}
			if (policy.maxAccounts !== null) {
				const live = Number(this.#sql("SELECT COUNT(*) AS n FROM accounts WHERE status != 'deleted'").one().n);
				if (live >= policy.maxAccounts) return { ok: false, status: 503, error: "This Pim is full for now. Ask the person who runs it." };
			}
		}
		if (this.#byUsername(username)) return { ok: false, status: 409, error: "That username is taken." };
		const ownerId = newOwnerId();
		this.#sql(
			"INSERT INTO accounts (owner_id, username, role, status, created_at, pending_until, status_changed_at) VALUES (?, ?, ?, 'pending', ?, ?, ?)",
			ownerId,
			username,
			role,
			now,
			now + PENDING_MS,
			now,
		);
		this.#sql("INSERT INTO registrations (address, at) VALUES (?, ?)", address, now);
		if (role === "member" && invite) this.#sql("UPDATE invites SET used_by = ?, used_at = ? WHERE hash = ?", ownerId, now, invite);
		return { ok: true, account: this.account(ownerId)! };
	}

	/** Gives back a registration that could not be set up, invite included, so the person can try again at once. */
	async abandon(ownerId: string, now = Date.now()): Promise<void> {
		this.#release(ownerId, now, "setup failed");
		await this.#scheduleAlarm();
	}

	/** The account's first passkey was made: it is the owner's now, for good. A lapsed registration can't be. */
	activate(ownerId: string, now = Date.now()): Account | null {
		this.#sql(
			"UPDATE accounts SET status = 'active', activated_at = ?, pending_until = NULL, status_changed_at = ? WHERE owner_id = ? AND status = 'pending' AND pending_until > ?",
			now,
			now,
			ownerId,
			now,
		);
		return this.account(ownerId);
	}

	/** Suspends or restores an account; one being deleted stays so. */
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

	// Cleanups: erasing owners' spaces and sign-ins, until it is done.

	#enqueue(ownerId: string, kind: Cleanup["kind"], now: number): void {
		this.#sql(
			"INSERT INTO cleanups (owner_id, kind, requested_at, next_attempt_at) VALUES (?, ?, ?, ?) ON CONFLICT (owner_id) DO UPDATE SET next_attempt_at = MIN(next_attempt_at, excluded.next_attempt_at)",
			ownerId,
			kind,
			now,
			now,
		);
	}

	cleanup(ownerId: string): Cleanup | null {
		const row = this.#sql("SELECT * FROM cleanups WHERE owner_id = ?", ownerId).toArray()[0];
		return row ? cleanupOf(row) : null;
	}

	/**
	 * Starts deleting an account: it stops opening anything, and a cleanup
	 * job will erase it. The username stays taken. Run `runCleanup` to try now.
	 */
	async requestDeletion(ownerId: string, by: string, now = Date.now()): Promise<Account | null> {
		const account = this.account(ownerId);
		if (!account) return null;
		if (account.status !== "deleted") {
			this.#sql(
				"UPDATE accounts SET status = 'deleting', status_reason = ?, status_changed_at = ?, pending_until = NULL WHERE owner_id = ?",
				by,
				now,
				ownerId,
			);
		}
		// Its linked identities may sign up again, or be linked to someone else.
		this.#sql("DELETE FROM identities WHERE owner_id = ?", ownerId);
		// Asked again for a deleted account, it erases once more: harmless, and it finishes anything left behind.
		this.#enqueue(ownerId, "deletion", now);
		log("deletion_requested", { owner: ownerId, username: account.username, by });
		await this.#scheduleAlarm();
		return this.account(ownerId);
	}

	/** Runs an owner's cleanup now, if one is queued. Done means both objects were checked empty. */
	async runCleanup(ownerId: string): Promise<CleanupResult> {
		const running = this.#running.get(ownerId);
		if (running) return running;
		const attempt = this.#attempt(ownerId).finally(() => this.#running.delete(ownerId));
		this.#running.set(ownerId, attempt);
		return attempt;
	}

	async #attempt(ownerId: string): Promise<CleanupResult> {
		const job = this.cleanup(ownerId);
		if (!job) return { done: true };
		try {
			await this.#erase(ownerId);
		} catch (error) {
			const now = Date.now();
			const attempts = job.attempts + 1;
			const nextAttemptAt = now + RETRY_MS[Math.min(attempts, RETRY_MS.length) - 1]!;
			const message = error instanceof Error ? error.message : String(error);
			this.#sql(
				"UPDATE cleanups SET attempts = ?, next_attempt_at = ?, last_error = ? WHERE owner_id = ?",
				attempts,
				nextAttemptAt,
				message,
				ownerId,
			);
			console.error(JSON.stringify({ event: "pim.cleanup_failed", owner: ownerId, kind: job.kind, attempts, error: message }));
			await this.#scheduleAlarm();
			return { done: false, error: message, nextAttemptAt };
		}
		this.#sql("DELETE FROM cleanups WHERE owner_id = ?", ownerId);
		if (job.kind === "deletion") {
			this.#sql("UPDATE accounts SET status = 'deleted', status_changed_at = ? WHERE owner_id = ?", Date.now(), ownerId);
			log("deleted", { owner: ownerId, attempts: job.attempts + 1 });
		} else {
			log("released", { owner: ownerId });
		}
		return { done: true };
	}

	/**
	 * Erases the owner's space, then their sign-in, and checks each is empty.
	 * Destroying a space ends the call that asked, so that call's error says
	 * nothing either way: the check afterwards decides.
	 */
	async #erase(ownerId: string): Promise<void> {
		let ended: unknown;
		try {
			await (await getAgentByName(this.env.Pim, ownerId)).deleteEverything();
		} catch (error) {
			ended = error;
		}
		const { sealed, remaining } = await this.#erasure(ownerId);
		if (!sealed || remaining.length > 0) {
			const why = ended instanceof Error ? ended.message : ended === undefined ? "" : String(ended);
			const what = remaining.length > 0 ? `still holds ${remaining.join(", ")}` : "is not marked erased";
			throw new Error(`The agent ${what}${why ? ` (${why})` : ""}`);
		}
		// What they showed others: their profile and published agents.
		const gallery = this.env.Gallery?.getByName("gallery");
		if (gallery) {
			await gallery.forgetOwner(ownerId);
			if (await gallery.holds(ownerId)) throw new Error("The gallery still holds their profile or published agents");
		}
		const auth = this.env.Auth.getByName(ownerId);
		await auth.deleteEverything();
		const [passkeys, identities, tokens, codes] = await Promise.all([auth.passkeys(), auth.identities(), auth.tokens(), auth.recoveryCodesLeft()]);
		if (passkeys.length + identities.length + tokens.length + codes > 0) {
			throw new Error("The sign-in still holds passkeys, linked accounts, tokens or recovery codes");
		}
	}

	/**
	 * Whether the space is marked erased and what it still holds, asked of a
	 * fresh instance. An erased space's instance takes a moment to go: calls
	 * reaching it meanwhile fail, so they are retried briefly before the
	 * attempt counts as failed.
	 */
	async #erasure(ownerId: string): Promise<{ sealed: boolean; remaining: string[] }> {
		for (let attempt = 1; ; attempt++) {
			try {
				return await (await getAgentByName(this.env.Pim, ownerId)).erasure();
			} catch (error) {
				if (attempt === 5) throw error;
				await new Promise((resolve) => setTimeout(resolve, attempt * 100));
			}
		}
	}

	/** Releases lapsed registrations, then runs the cleanups that are due. */
	override async alarm(): Promise<void> {
		const now = Date.now();
		this.#releaseLapsed(now);
		const due = this.#sql("SELECT owner_id FROM cleanups WHERE next_attempt_at <= ? ORDER BY next_attempt_at LIMIT ?", now, CLEANUPS_PER_ALARM)
			.toArray()
			.map((row) => String(row.owner_id));
		for (const ownerId of due) await this.runCleanup(ownerId);
		await this.#scheduleAlarm(true);
	}

	/** Wakes for the next cleanup or registration to lapse, whichever is first. */
	async #scheduleAlarm(replace = false): Promise<void> {
		const next = this.#sql(
			`SELECT MIN(at) AS at FROM (
				SELECT MIN(next_attempt_at) AS at FROM cleanups
				UNION ALL SELECT MIN(pending_until) AS at FROM accounts WHERE status = 'pending'
			)`,
		).one().at;
		if (next === null) return;
		const current = await this.ctx.storage.getAlarm();
		if (replace || current === null || Number(next) < current) await this.ctx.storage.setAlarm(Math.max(Number(next), Date.now()));
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
		const cleanups = this.#sql("SELECT COUNT(*) AS queued, SUM(CASE WHEN attempts > 0 THEN 1 ELSE 0 END) AS failing FROM cleanups").one();
		return {
			accounts: { pending: 0, active: 0, suspended: 0, deleting: 0, deleted: 0, ...byStatus },
			registrationsLastDay: Number(this.#sql("SELECT COUNT(*) AS n FROM accounts WHERE created_at >= ?", now - DAY_MS).one().n),
			invitesUnused: Number(this.#sql("SELECT COUNT(*) AS n FROM invites WHERE used_at IS NULL").one().n),
			cleanups: { queued: Number(cleanups.queued), failing: Number(cleanups.failing ?? 0) },
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
