import { ApprovalRequiredError, ForbiddenError, GoneError, UnauthorizedError } from "./errors.ts";
import type { Db, Tx } from "./db.ts";
import { newId } from "./ids.ts";
import { type Principal, principalKey, scopeAllows } from "./principal.ts";

export type Account = { ownerId: string; username: string; role: "admin" | "member"; status: "pending" | "active" | "suspended" | "deleting" | "deleted"; bot: boolean };

/** Actions only a browser session may take; a token, even an unscoped one, cannot (B1 gap 3). */
const SESSION_ONLY = new Set(["token:create", "token:revoke", "session:revoke_all", "passkey:manage", "account:delete"]);
/** Actions that need an admin owner. */
const ADMIN_PREFIX = "admin:";
/** Actions that need an active capability grant for the resource (repository, pool, computer). */
const CAPABILITY: Record<string, "coding" | "compute" | "repository"> = {
	"coding:start": "coding",
	"coding:push": "repository",
	"coding:merge": "repository",
	"coding:pr": "repository",
	"computer:use": "compute",
	"trigger:computer": "compute",
};
/** Actions with effects outside Pim that a human approves each time, unless a standing grant covers the principal. */
const NEEDS_APPROVAL = new Set(["coding:push", "coding:merge"]);

const globMatch = (pattern: string, value: string) => pattern === "*" || pattern === value || (pattern.endsWith("*") && value.startsWith(pattern.slice(0, -1)));

/**
 * The one place that decides. HTTP routes, WebSocket subscriptions, the MCP server and agent tools all call `authorize`, which checks
 * in order: the owner is alive (suspended: 403, deleting or deleted: 410, on every surface alike), the token scope allows the action,
 * the owner's own role and grants allow it, and, for effects that need approval, a standing grant covers the principal. A delegated
 * principal must pass every check for itself and for the principal that originated it.
 */
export class Authorizer {
	constructor(private readonly db: Db) {}

	async account(ownerId: string): Promise<Account | null> {
		return this.db.owner(ownerId, (tx) => readAccount(tx, ownerId));
	}

	/** Throws unless the owner may act at all. Public hosted-app execution and triggers call this before running anything for an owner. */
	async requireLive(ownerId: string): Promise<Account> {
		const account = await this.account(ownerId);
		if (!account) throw new UnauthorizedError("Unknown account");
		if (account.status === "deleting" || account.status === "deleted") throw new GoneError();
		if (account.status === "suspended") throw new ForbiddenError("This account is suspended", "suspended");
		if (account.status === "pending") throw new ForbiddenError("This account is not active yet", "pending");
		return account;
	}

	async authorize(principal: Principal, action: string, resource = "*"): Promise<void> {
		try {
			const chain: Principal[] = [];
			for (let p: Principal | undefined = principal; p; p = p.origin) chain.push(p);
			for (const p of chain) await this.#check(p, action, resource);
		} catch (error) {
			await this.#audit(principal, action, resource, error instanceof ApprovalRequiredError ? "approval_required" : "denied").catch(() => undefined);
			throw error;
		}
		await this.#audit(principal, action, resource, "allowed").catch(() => undefined);
	}

	async #check(p: Principal, action: string, resource: string): Promise<void> {
		const account = await this.requireLive(p.ownerId);
		if (!scopeAllows(p.scopes, action)) throw new ForbiddenError(`This ${p.kind} may not "${action}"`, "scope");
		if (SESSION_ONLY.has(action) && p.kind !== "session") throw new ForbiddenError(`"${action}" needs a browser session`, "session_only");
		if (action.startsWith(ADMIN_PREFIX) && account.role !== "admin") throw new ForbiddenError("Admins only", "admin_only");
		const capability = CAPABILITY[action];
		if (capability) {
			const granted = await this.db.owner(p.ownerId, async (tx) => {
				const { rows } = await tx.query("SELECT resource FROM pim_app.capability_grants WHERE capability = $1 AND revoked_at IS NULL", [capability]);
				return rows.some((r) => globMatch(r.resource, resource));
			});
			if (!granted) throw new ForbiddenError(`No ${capability} grant covers ${resource}`, "no_grant");
		}
		if (NEEDS_APPROVAL.has(action) && !(await this.#standing(p, action, resource))) throw new ApprovalRequiredError(action);
	}

	async #standing(p: Principal, action: string, resource: string): Promise<boolean> {
		return this.db.owner(p.ownerId, async (tx) => {
			const { rows } = await tx.query(
				"SELECT resource FROM pim_app.standing_approvals WHERE principal = $1 AND action = $2 AND revoked_at IS NULL AND (expires_at IS NULL OR expires_at > now())",
				[principalKey(p), action],
			);
			return rows.some((r) => globMatch(r.resource, resource));
		});
	}

	#audit(p: Principal, action: string, resource: string, decision: string): Promise<void> {
		return this.db.owner(p.ownerId, async (tx) => {
			await tx.query("INSERT INTO pim_app.audit_log (owner_id, actor, action, resource, decision) VALUES ($1, $2, $3, $4, $5)", [p.ownerId, principalKey(p), action, resource, decision]);
		});
	}

	/** An admin records that `principal` may take `action` on `resource` without per-call approval. The grant is a row, not a flag. */
	async grantStanding(admin: Principal, input: { ownerId: string; principal: string; action: string; resource?: string; reason: string; expiresAt?: Date }): Promise<string> {
		await this.authorize(admin, "admin:grants");
		const id = newId("sg");
		await this.db.owner(input.ownerId, (tx) =>
			tx.query(
				"INSERT INTO pim_app.standing_approvals (id, owner_id, principal, action, resource, reason, granted_by, expires_at) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)",
				[id, input.ownerId, input.principal, input.action, input.resource ?? "*", input.reason, principalKey(admin), input.expiresAt ?? null],
			),
		);
		return id;
	}

	async grantCapability(admin: Principal, input: { ownerId: string; capability: "coding" | "compute" | "repository"; resource?: string; quota?: object }): Promise<string> {
		await this.authorize(admin, "admin:grants");
		const id = newId("cg");
		await this.db.owner(input.ownerId, (tx) =>
			tx.query("INSERT INTO pim_app.capability_grants (id, owner_id, capability, resource, quota, granted_by) VALUES ($1, $2, $3, $4, $5, $6)", [
				id,
				input.ownerId,
				input.capability,
				input.resource ?? "*",
				JSON.stringify(input.quota ?? {}),
				principalKey(admin),
			]),
		);
		return id;
	}

	async revokeStanding(admin: Principal, ownerId: string, id: string): Promise<void> {
		await this.authorize(admin, "admin:grants");
		await this.db.owner(ownerId, (tx) => tx.query("UPDATE pim_app.standing_approvals SET revoked_at = now() WHERE id = $1", [id]));
	}
}

export async function readAccount(tx: Tx, ownerId: string): Promise<Account | null> {
	const { rows } = await tx.query("SELECT owner_id, username, role, status, bot FROM pim_app.accounts WHERE owner_id = $1", [ownerId]);
	const r = rows[0];
	return r ? { ownerId: r.owner_id, username: r.username, role: r.role, status: r.status, bot: r.bot } : null;
}
