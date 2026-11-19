import { randomUUID } from "node:crypto";
import { OwnerId, type Principal } from "@pim/v2-contracts/identity";
import { type Account, Authorizer, readAccount } from "./authz.ts";
import type { Db, Tx } from "./db.ts";
import { BadRequestError, ConflictError, NotFoundError, PimError, RefusedError, UnauthorizedError } from "./errors.ts";
import { digest, newId, newOwnerId, secret } from "./ids.ts";
import { PENDING_MS, registrationPolicy, usernameProblem } from "./registration.ts";

/** API tokens one person may have. */
export const MAX_TOKENS = 20;
export const SESSION_MS = 30 * 24 * 3600_000;

/** `guestOf` makes a guest account of a live bot's link (`Guests.liveBot` has checked it): allowed whatever the registration mode, with no invite. */
export type Registration = { username: string; invite?: string; address?: string; bootstrap?: string; now?: Date; guestOf?: { botId: string; host: string }; /** The account is `pending` until its first passkey (`activate`), and lapses after a day without one. */ pending?: boolean; /** Joins whatever the registration policy says and without the bootstrap claim: the development sign-in's (`PIM_DEV_SIGN_IN`), never a route of a deployment. */ trusted?: boolean };
export type ConsumerKind = "computer" | "host" | "mcp_client" | "mcp_grant" | "mcp_refresh";
const CONSUMER_PREFIX: Record<ConsumerKind, string> = { computer: "pimc_", host: "pimh_", mcp_client: "pimmc_", mcp_grant: "pimmg_", mcp_refresh: "pimmr_" };

/** Accounts, credentials, browser sessions, API tokens and the token consumers. Each secret is returned once and kept as a digest. */
export class Identity {
	readonly authz: Authorizer;
	/** `env` is the deployment's variables, read each time, for its registration policy (`PIM_REGISTRATION`, `PIM_MAX_ACCOUNTS`, `PIM_REGISTRATIONS_PER_ADDRESS`). */
	constructor(private readonly db: Db, private readonly env: () => Readonly<Record<string, string | undefined>> = () => process.env) {
		this.authz = new Authorizer(db);
	}

	// ---- accounts ----

	/**
	 * Creates an account. The very first is the admin and needs a bootstrap claim code; later ones join as the deployment's policy says: with an
	 * invite, freely, or not at all (`closed`), while a cap on accounts and a limit of registrations a day per address hold in every mode.
	 */
	async register(input: Registration): Promise<Account> {
		const username = input.username.trim().toLowerCase();
		const problem = usernameProblem(username);
		if (problem) throw new BadRequestError(problem);
		const ownerId = newOwnerId();
		const now = input.now ?? new Date();
		const guest = input.guestOf;
		// Lapsed registrations hold no username, place or invite.
		await this.releaseLapsed(now);
		const first = !guest && (await this.db.anonymous(async (tx) => (await tx.query("SELECT NOT EXISTS (SELECT 1 FROM pim_app.accounts) AS first")).rows[0].first as boolean));
		const stored = await this.db.anonymous(async (tx) => (await tx.query("SELECT value FROM pim_app.instance_settings WHERE key = 'registration_open'")).rows[0]?.value === true);
		const policy = registrationPolicy(this.env(), stored);
		const spendsInvite = !first && !guest && policy.mode === "invite" && !input.trusted;
		if (input.trusted) {
			// The development sign-in makes the account without a claim code or an invite.
		} else if (guest) {
			// A bot's link is open to anyone while it is live, whatever the registration mode; the cap and the per-address limit still hold.
		} else if (first) {
			if (!input.bootstrap) throw new RefusedError("This Pim needs its bootstrap claim code to create the first account", "bootstrap_required");
			await this.#redeemClaim(input.bootstrap, "bootstrap", now);
		} else if (policy.mode === "closed") throw new RefusedError("Registration is closed.", "registration_closed");
		else if (spendsInvite && !input.invite) throw new RefusedError("Registration is closed. Joining needs an invite.", "registration_closed");
		const role = first ? "admin" : guest ? "guest" : "member";
		const pending = input.pending === true;
		await this.db.owner(ownerId, async (tx) => {
			// Counting and taking a place is one step, whoever else registers at the same moment.
			await tx.query("SELECT pg_advisory_xact_lock(hashtext('pim_app.registration'))");
			if (input.address && !input.trusted) {
				const recent = (await tx.query("SELECT count(*)::int AS n FROM pim_app.registration_attempts WHERE address = $1 AND at > $2", [input.address, new Date(now.getTime() - 24 * 3600_000)])).rows[0].n as number;
				if (recent >= policy.perAddressPerDay) throw new PimError(429, "rate_limited", "Too many registrations from this network today. Try again tomorrow.");
			}
			if (!first && !input.trusted && policy.maxAccounts !== null && (await tx.query("SELECT count(*)::int AS n FROM pim_app.accounts WHERE status <> 'deleted'")).rows[0].n >= policy.maxAccounts) throw new PimError(503, "full", "This Pim is full for now. Ask the person who runs it.");
			try {
				await tx.query("INSERT INTO pim_app.usernames (username, owner_id) VALUES ($1, $2)", [username, ownerId]);
			} catch (error) {
				if ((error as { code?: string }).code === "23505") throw new ConflictError("That username is taken, now or in the past", "username_taken");
				throw error;
			}
			await tx.query("INSERT INTO pim_app.accounts (owner_id, username, role, status, activated_at, pending_until, bot) VALUES ($1, $2, $3, $4, $5, $6, $7)", [ownerId, username, role, pending ? "pending" : "active", pending ? null : now, pending ? new Date(now.getTime() + PENDING_MS) : null, !!guest]);
			await tx.query("INSERT INTO pim_app.partitions (partition_id, owner_id, home, next_conversation_id) VALUES ($1, $2, true, 2)", [randomUUID(), ownerId]);
			if (input.address) await tx.query("INSERT INTO pim_app.registration_attempts (address, at) VALUES ($1, $2)", [input.address, now]);
			// The invite is spent in the same transaction as the account, so a failed registration never burns it.
			if (spendsInvite) {
				const spent = await tx.query("UPDATE pim_app.invites SET used_by = $1, used_at = $2 WHERE code_hash = $3 AND (used_at IS NULL OR NOT EXISTS (SELECT 1 FROM pim_app.accounts WHERE owner_id = invites.used_by))", [ownerId, now, digest(input.invite?.trim() ?? "")]);
				if (!spent.rowCount) throw new RefusedError("Joining needs an invite, and that one isn't valid.", "invite_invalid");
			}
		}, digest(input.invite?.trim() ?? ""));
		return { ownerId: OwnerId.parse(ownerId), username, role, status: pending ? "pending" : "active", bot: !!guest };
	}

	/** The account's first passkey was made, or a client that has none starts with a session: it is the owner's now. A lapsed registration cannot be. */
	async activate(ownerId: string, now = new Date()): Promise<void> {
		await this.db.owner(ownerId, (tx) => tx.query("UPDATE pim_app.accounts SET status = 'active', activated_at = $2, pending_until = NULL WHERE owner_id = $1 AND status = 'pending' AND pending_until > $2", [ownerId, now]));
	}

	/** Gives back every registration whose day ran out without a passkey: its username, its invite and its place, and erases what it made. */
	async releaseLapsed(now = new Date()): Promise<number> {
		const lapsed = (await this.db.anonymous((tx) => tx.query("SELECT owner_id FROM pim_app.accounts WHERE status = 'pending' AND pending_until <= $1", [now]))).rows.map((r) => r.owner_id as string);
		for (const ownerId of lapsed) await this.releaseRegistration(ownerId);
		return lapsed.length;
	}

	/** Gives a registration that was not finished back at once, whatever time it has left: one that could not be set up. Only a pending account goes. */
	async releaseRegistration(ownerId: string): Promise<void> {
		await this.db.owner(ownerId, async (tx) => {
			if ((await tx.query("SELECT status FROM pim_app.accounts WHERE owner_id = $1 FOR UPDATE", [ownerId])).rows[0]?.status !== "pending") return;
			await this.#erase(tx, ownerId);
			await tx.query("DELETE FROM pim_app.usernames WHERE owner_id = $1", [ownerId]);
			await tx.query("DELETE FROM pim_app.accounts WHERE owner_id = $1 AND status = 'pending'", [ownerId]);
		});
	}

	/** Empties every table that holds an owner's rows but the identity facts, in passes until the foreign keys let go of the rest. */
	async #erase(tx: Tx, ownerId: string): Promise<number> {
		const keep = new Set(["accounts", "usernames", "audit_log"]);
		const tables = (await tx.query("SELECT table_name FROM information_schema.columns WHERE table_schema = 'pim_app' AND column_name = 'owner_id'")).rows.map((r) => r.table_name as string).filter((t) => !keep.has(t));
		let pending = [...tables];
		let deleted = 0;
		for (let pass = 0; pass < 6 && pending.length; pass++) {
			const next: string[] = [];
			for (const table of pending) {
				await tx.query("SAVEPOINT purge");
				try {
					deleted += (await tx.query(`DELETE FROM pim_app.${table} WHERE owner_id = $1`, [ownerId])).rowCount ?? 0;
					await tx.query("RELEASE SAVEPOINT purge");
				} catch (error) {
					if ((error as { code?: string }).code !== "23503") throw error;
					await tx.query("ROLLBACK TO SAVEPOINT purge");
					next.push(table);
				}
			}
			pending = next;
		}
		if (pending.length) throw new Error(`Could not purge ${pending.join(", ")}`);
		return deleted;
	}

	async setRegistrationOpen(admin: Principal, open: boolean): Promise<void> {
		await this.authz.enforce(admin, "admin:settings");
		if (registrationPolicy(this.env()).fixed) throw new RefusedError("This deployment sets registration with PIM_REGISTRATION; change it there.", "registration_fixed");
		await this.db.anonymous((tx) => tx.query("INSERT INTO pim_app.instance_settings (key, value) VALUES ('registration_open', $1) ON CONFLICT (key) DO UPDATE SET value = $1", [JSON.stringify(open)]));
	}

	async createInvite(admin: Principal, note = ""): Promise<string> {
		await this.authz.enforce(admin, "admin:invites");
		const code = secret(16);
		await this.db.owner(admin.ownerId, (tx) => tx.query("INSERT INTO pim_app.invites (code_hash, owner_id, note) VALUES ($1, $2, $3)", [digest(code), admin.ownerId, note]));
		return code;
	}

	/** Issues a one-time claim code (stored as a hash). `bootstrap` creates the first admin; `admin_recovery` is the operator's path back in. Run by the operator CLI, never over HTTP. */
	async issueClaim(kind: "bootstrap" | "admin_recovery", ownerId: string | null, ttlMs: number, now = new Date()): Promise<string> {
		const code = secret(16);
		await this.db.anonymous((tx) => tx.query("INSERT INTO pim_app.claim_codes (code_hash, kind, owner_id, expires_at) VALUES ($1, $2, $3, $4)", [digest(code), kind, ownerId, new Date(now.getTime() + ttlMs)]));
		return code;
	}

	async #redeemClaim(code: string, kind: string, now: Date): Promise<string | null> {
		const { rows } = await this.db.anonymous((tx) =>
			tx.query("UPDATE pim_app.claim_codes SET used_at = $3 WHERE code_hash = $1 AND kind = $2 AND used_at IS NULL AND expires_at > $3 RETURNING owner_id", [digest(code), kind, now]),
		);
		if (!rows[0]) throw new RefusedError("That claim code is not valid", "claim_invalid");
		return rows[0].owner_id;
	}

	/** The admin recovery path: redeems a claim code, reactivates the admin if needed and returns a session. Anibal keeps his way back in. */
	async recoverAdmin(code: string, now = new Date()): Promise<{ session: string; account: Account }> {
		const ownerId = await this.#redeemClaim(code, "admin_recovery", now);
		if (!ownerId) throw new RefusedError("That claim code names no account", "claim_invalid");
		const account = await this.db.owner(ownerId, async (tx) => {
			await tx.query("UPDATE pim_app.accounts SET status = 'active', role = 'admin', status_reason = 'admin recovery', status_changed_at = $2 WHERE owner_id = $1 AND status IN ('active', 'suspended')", [ownerId, now]);
			return readAccount(tx, ownerId);
		});
		if (!account || account.status !== "active") throw new RefusedError("That account cannot be recovered", "claim_invalid");
		return { session: await this.createSession(ownerId, { now }), account };
	}

	async setStatus(admin: Principal, ownerId: string, status: "active" | "suspended" | "deleting" | "deleted", reason = ""): Promise<void> {
		await this.authz.enforce(admin, "admin:accounts");
		await this.db.owner(ownerId, async (tx) => {
			const { rowCount } = await tx.query("UPDATE pim_app.accounts SET status = $2, status_reason = $3, status_changed_at = now() WHERE owner_id = $1 AND status <> 'deleted'", [ownerId, status, reason]);
			if (!rowCount) throw new NotFoundError("No such live account");
			if (status === "deleting" || status === "deleted") {
				for (const table of ["browser_sessions", "api_tokens", "token_consumers"]) await tx.query(`UPDATE pim_app.${table} SET revoked_at = coalesce(revoked_at, now()) WHERE owner_id = $1`, [ownerId]);
			}
		}).catch((error) => {
			if ((error as { code?: string }).code === "P0002") throw new RefusedError("The last admin cannot be demoted, suspended or deleted", "last_admin");
			throw error;
		});
	}

	/** A person deletes their own account (session only). It is gone to every surface at once (410); `purgeOwner` then removes what it held. */
	async deleteSelf(session: Principal): Promise<void> {
		await this.authz.enforce(session, "account:delete");
		await this.db.owner(session.ownerId, async (tx) => {
			await tx.query("UPDATE pim_app.accounts SET status = 'deleting', status_reason = 'deleted by owner', status_changed_at = now() WHERE owner_id = $1 AND status IN ('active', 'suspended', 'pending')", [session.ownerId]);
			for (const table of ["browser_sessions", "api_tokens", "token_consumers"]) await tx.query(`UPDATE pim_app.${table} SET revoked_at = coalesce(revoked_at, now()) WHERE owner_id = $1`, [session.ownerId]);
		}).catch((error) => {
			if ((error as { code?: string }).code === "P0002") throw new RefusedError("The last admin cannot delete their account.", "last_admin");
			throw error;
		});
	}

	/**
	 * Removes everything a `deleting` account held, then tombstones it: the account row and its username stay, so the name is never reused. Run by
	 * maintenance, repeatable. Tables are emptied in passes until the foreign keys let go of the rest.
	 */
	async purgeOwner(ownerId: string): Promise<{ deleted: number }> {
		return this.db.owner(ownerId, async (tx) => {
			const status = (await tx.query("SELECT status FROM pim_app.accounts WHERE owner_id = $1", [ownerId])).rows[0]?.status;
			if (status !== "deleting" && status !== "deleted") throw new RefusedError("Only a deleting account is purged.", "not_deleting");
			const deleted = await this.#erase(tx, ownerId);
			await tx.query("UPDATE pim_app.accounts SET status = 'deleted', status_changed_at = now() WHERE owner_id = $1", [ownerId]);
			return { deleted };
		});
	}

	async setRole(admin: Principal, ownerId: string, role: "admin" | "member" | "guest"): Promise<void> {
		await this.authz.enforce(admin, "admin:accounts");
		await this.db.owner(ownerId, (tx) => tx.query("UPDATE pim_app.accounts SET role = $2 WHERE owner_id = $1", [ownerId, role])).catch((error) => {
			if ((error as { code?: string }).code === "P0002") throw new RefusedError("The last admin cannot be demoted", "last_admin");
			throw error;
		});
	}

	// ---- sessions ----

	async createSession(ownerId: string, opts: { credentialId?: string; userAgent?: string; now?: Date } = {}): Promise<string> {
		const token = `pims_${secret()}`;
		const now = opts.now ?? new Date();
		await this.db.owner(ownerId, (tx) =>
			tx.query("INSERT INTO pim_app.browser_sessions (id, owner_id, token_hash, credential_id, user_agent, created_at, expires_at) VALUES ($1, $2, $3, $4, $5, $6, $7)", [
				newId("s"), ownerId, digest(token), opts.credentialId ?? null, opts.userAgent ?? null, now, new Date(now.getTime() + SESSION_MS),
			]),
		);
		return token;
	}

	async listSessions(ownerId: string): Promise<{ id: string; createdAt: Date; revokedAt: Date | null }[]> {
		return this.db.owner(ownerId, async (tx) => (await tx.query("SELECT id, created_at, revoked_at FROM pim_app.browser_sessions ORDER BY created_at")).rows.map((r) => ({ id: r.id, createdAt: r.created_at, revokedAt: r.revoked_at })));
	}

	async revokeSession(ownerId: string, id: string): Promise<void> {
		await this.db.owner(ownerId, (tx) => tx.query("UPDATE pim_app.browser_sessions SET revoked_at = coalesce(revoked_at, now()) WHERE id = $1", [id]));
	}

	// ---- API tokens and consumers ----

	/** A scoped API token. Its scopes are what it may do, never more than its owner may. */
	async createToken(session: Principal, input: { name: string; scopes: string[]; expiresAt?: Date }): Promise<{ id: string; token: string }> {
		await this.authz.enforce(session, "token:create");
		const token = `pim_${session.ownerId}_${secret()}`;
		const id = newId("t");
		await this.db.owner(session.ownerId, async (tx) => {
			await tx.query("SELECT pg_advisory_xact_lock(hashtext($1))", [`tokens:${session.ownerId}`]);
			if ((await tx.query("SELECT count(*)::int AS n FROM pim_app.api_tokens WHERE revoked_at IS NULL")).rows[0].n >= MAX_TOKENS) throw new PimError(429, "limit", `You can have up to ${MAX_TOKENS} tokens. Revoke one first.`);
			await tx.query("INSERT INTO pim_app.api_tokens (id, owner_id, name, token_hash, scopes, expires_at) VALUES ($1, $2, $3, $4, $5, $6)", [id, session.ownerId, input.name, digest(token), input.scopes, input.expiresAt ?? null]);
		});
		return { id, token };
	}

	/** Imports a legacy token by its hash so old tokens keep working; legacy tokens were unscoped, so they keep '*'. */
	async importLegacyToken(ownerId: string, name: string, tokenHash: string): Promise<void> {
		await this.db.owner(ownerId, (tx) => tx.query("INSERT INTO pim_app.api_tokens (id, owner_id, name, token_hash, scopes, legacy) VALUES ($1, $2, $3, $4, '{*}', true) ON CONFLICT DO NOTHING", [newId("t"), ownerId, name, tokenHash]));
	}

	async revokeToken(session: Principal, id: string): Promise<void> {
		await this.authz.enforce(session, "token:revoke");
		await this.db.owner(session.ownerId, (tx) => tx.query("UPDATE pim_app.api_tokens SET revoked_at = coalesce(revoked_at, now()) WHERE id = $1", [id]));
	}

	/** Issues a computer, host or MCP bearer. `reissueFrom` revokes the old one in the same step so a rotated secret never leaves two live. */
	async issueConsumer(ownerId: string, kind: ConsumerKind, opts: { label?: string; scopes?: string[]; metadata?: object; reissueFrom?: string; expiresAt?: Date } = {}): Promise<{ id: string; token: string }> {
		// A computer's token names its owner, `pimc_<owner>_<secret>`, because the triggers runtime on the computer binds to that space from its token alone.
		const token = `${CONSUMER_PREFIX[kind]}${kind === "computer" ? `${ownerId}_` : ""}${secret()}`;
		const id = newId("tc");
		await this.db.owner(ownerId, async (tx) => {
			if (opts.reissueFrom) await tx.query("UPDATE pim_app.token_consumers SET revoked_at = coalesce(revoked_at, now()) WHERE id = $1", [opts.reissueFrom]);
			await tx.query("INSERT INTO pim_app.token_consumers (id, owner_id, kind, token_hash, label, scopes, metadata, reissued_from, expires_at) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)", [
				id, ownerId, kind, digest(token), opts.label ?? null, opts.scopes ?? [], JSON.stringify(opts.metadata ?? {}), opts.reissueFrom ?? null, opts.expiresAt ?? null,
			]);
		});
		return { id, token };
	}

	// ---- authentication: turn a bearer into a principal. The Authorizer then decides on every action, so a suspended owner stops here too ----

	async authenticate(bearer: string | undefined, now = new Date()): Promise<Principal> {
		if (!bearer) throw new UnauthorizedError();
		const hash = digest(bearer);
		type Found = { kind: "session" | "token"; ownerId: string; id: string; scopes: string[] };
		let found: Found | null = null;
		if (bearer.startsWith("pims_")) {
			found = await this.db.lookup(hash, async (tx) => {
				const { rows } = await tx.query("SELECT id, owner_id FROM pim_app.browser_sessions WHERE token_hash = $1 AND revoked_at IS NULL AND expires_at > $2", [hash, now]);
				return rows[0] ? { kind: "session", ownerId: rows[0].owner_id, id: rows[0].id, scopes: [] } : null;
			});
		} else if (bearer.startsWith("pim_")) {
			found = await this.db.lookup(hash, async (tx) => {
				const { rows } = await tx.query("UPDATE pim_app.api_tokens SET last_used_at = $2 WHERE token_hash = $1 AND revoked_at IS NULL AND (expires_at IS NULL OR expires_at > $2) RETURNING id, owner_id, scopes", [hash, now]);
				return rows[0] ? { kind: "token", ownerId: rows[0].owner_id, id: rows[0].id, scopes: rows[0].scopes } : null;
			});
		} else {
			// Computer, host and MCP bearers are tokens whose scopes name what the consumer may do.
			found = await this.db.lookup(hash, async (tx) => {
				const { rows } = await tx.query("SELECT id, owner_id, scopes FROM pim_app.token_consumers WHERE token_hash = $1 AND revoked_at IS NULL AND (expires_at IS NULL OR expires_at > $2)", [hash, now]);
				return rows[0] ? { kind: "token", ownerId: rows[0].owner_id, id: rows[0].id, scopes: rows[0].scopes } : null;
			});
		}
		if (!found) throw new UnauthorizedError("Invalid or revoked credential");
		const account = await this.authz.requireLive(found.ownerId);
		const ownerId = OwnerId.parse(found.ownerId);
		return found.kind === "session" ? { kind: "user", ownerId, role: account.role, sessionId: found.id } : { kind: "token", ownerId, role: account.role, tokenId: found.id, scopes: found.scopes };
	}
}
