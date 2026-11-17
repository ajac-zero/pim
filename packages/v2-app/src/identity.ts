import { randomUUID } from "node:crypto";
import { OwnerId, type Principal } from "@pim/v2-contracts/identity";
import { type Account, Authorizer, readAccount } from "./authz.ts";
import type { Db } from "./db.ts";
import { BadRequestError, ConflictError, NotFoundError, RefusedError, UnauthorizedError } from "./errors.ts";
import { digest, newId, newOwnerId, secret } from "./ids.ts";

const USERNAME = /^[a-z][a-z0-9-]{1,31}$/;
export const SESSION_MS = 30 * 24 * 3600_000;

export type Registration = { username: string; invite?: string; address?: string; bootstrap?: string; now?: Date };
export type ConsumerKind = "computer" | "host" | "mcp_client" | "mcp_grant" | "mcp_refresh";
const CONSUMER_PREFIX: Record<ConsumerKind, string> = { computer: "pimc_", host: "pimh_", mcp_client: "pimmc_", mcp_grant: "pimmg_", mcp_refresh: "pimmr_" };

/** Accounts, credentials, browser sessions, API tokens and the token consumers. Each secret is returned once and kept as a digest. */
export class Identity {
	readonly authz: Authorizer;
	constructor(private readonly db: Db) {
		this.authz = new Authorizer(db);
	}

	// ---- accounts ----

	/** Creates an account. The very first is the admin and needs a bootstrap claim code; later ones need open registration or an invite. */
	async register(input: Registration): Promise<Account> {
		const username = input.username.toLowerCase();
		if (!USERNAME.test(username)) throw new BadRequestError("Usernames are 2 to 32 lowercase letters, digits or dashes, starting with a letter");
		const ownerId = newOwnerId();
		const now = input.now ?? new Date();
		const first = await this.db.anonymous(async (tx) => (await tx.query("SELECT NOT EXISTS (SELECT 1 FROM pim_app.accounts) AS first")).rows[0].first as boolean);
		const open = await this.db.anonymous(async (tx) => (await tx.query("SELECT value FROM pim_app.instance_settings WHERE key = 'registration_open'")).rows[0]?.value === true);
		if (first) {
			if (!input.bootstrap) throw new RefusedError("This Pim needs its bootstrap claim code to create the first account", "bootstrap_required");
			await this.#redeemClaim(input.bootstrap, "bootstrap", now);
		} else if (!open && !input.invite) throw new RefusedError("Registration is closed", "registration_closed");
		if (input.address) await this.#limit(input.address, now);
		await this.db.owner(ownerId, async (tx) => {
			try {
				await tx.query("INSERT INTO pim_app.usernames (username, owner_id) VALUES ($1, $2)", [username, ownerId]);
			} catch (error) {
				if ((error as { code?: string }).code === "23505") throw new ConflictError("That username is taken, now or in the past", "username_taken");
				throw error;
			}
			await tx.query("INSERT INTO pim_app.accounts (owner_id, username, role, status, activated_at) VALUES ($1, $2, $3, 'active', $4)", [ownerId, username, first ? "admin" : "member", now]);
			await tx.query("INSERT INTO pim_app.partitions (partition_id, owner_id, home, next_conversation_id) VALUES ($1, $2, true, 2)", [randomUUID(), ownerId]);
			// The invite is spent in the same transaction as the account, so a failed registration never burns it.
			if (!first && !open) {
				const spent = await tx.query("UPDATE pim_app.invites SET used_by = $1, used_at = $2 WHERE code_hash = $3 AND used_at IS NULL", [ownerId, now, digest(input.invite ?? "")]);
				if (!spent.rowCount) throw new RefusedError("That invite is not valid", "invite_invalid");
			}
		}, digest(input.invite ?? ""));
		return { ownerId: OwnerId.parse(ownerId), username, role: first ? "admin" : "member", status: "active", bot: false };
	}

	async #limit(address: string, now: Date, max = 5, windowMs = 3600_000): Promise<void> {
		await this.db.anonymous(async (tx) => {
			const { rows } = await tx.query("SELECT count(*)::int AS n FROM pim_app.registration_attempts WHERE address = $1 AND at > $2", [address, new Date(now.getTime() - windowMs)]);
			if (rows[0].n >= max) throw new RefusedError("Too many registrations from this address", "rate_limited");
			await tx.query("INSERT INTO pim_app.registration_attempts (address, at) VALUES ($1, $2)", [address, now]);
		});
	}

	async setRegistrationOpen(admin: Principal, open: boolean): Promise<void> {
		await this.authz.enforce(admin, "admin:settings");
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
		await this.db.owner(session.ownerId, (tx) =>
			tx.query("INSERT INTO pim_app.api_tokens (id, owner_id, name, token_hash, scopes, expires_at) VALUES ($1, $2, $3, $4, $5, $6)", [id, session.ownerId, input.name, digest(token), input.scopes, input.expiresAt ?? null]),
		);
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
