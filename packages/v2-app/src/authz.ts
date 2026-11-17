import { type AuthzDecision, type AuthzRequest, type Authorizer as AuthorizerContract, ApprovalRequiredError, CapabilityUnavailableError, CODING_PERMISSIONS, type CodingGrant, type CodingPermission, ForbiddenError, type ResourceQuota, repositoryAllowed, type StandingApproval, standingApprovalCovers } from "@pim/v2-contracts/authz";
import { type AccountRole, type AccountStatus, effectivePrincipal, OwnerId, type Principal } from "@pim/v2-contracts/identity";
import type { Db, Tx } from "./db.ts";
import { GoneError, UnauthorizedError } from "./errors.ts";
import { newId } from "./ids.ts";

export type Account = { ownerId: OwnerId; username: string; role: AccountRole; status: AccountStatus; bot: boolean };

/** Actions only a browser session may take; a token, agent or delegate cannot, whatever its scopes (audit B1 gap 3). */
const SESSION_ONLY = new Set(["token:create", "token:revoke", "session:revoke", "passkey:manage", "account:delete"]);
/** Actions a guest never takes. */
const GUEST_DENIED = /^(admin:|coding:|computer:|token:|mcp:|app:deploy|trigger:computer)/;
/** What an agent acting in its owner's space may do. It never decides approvals (its scopes omit approval:), administers, or touches credentials. */
const AGENT_SCOPES = ["api:*", "app:*", "coding:*", "computer:*", "trigger:*", "http:*", "connector:*"];
/** Coding actions: the permission an admin's CodingGrant must list. */
const CODING_ACTIONS = new Set<string>(CODING_PERMISSIONS);
/** Coding actions, an HTTP request that writes, deploying an app's backend onto a personal computer, what an agent does there (a shell command, deleting a file, acting in the desktop, sending a form in its browser), and a connector's tool that asks, have effects outside Pim that a person approves each time unless a StandingApproval covers them. */
const NEEDS_APPROVAL = new Set<string>(["coding:push", "coding:pr", "coding:merge", "app:deploy", "http:request", "computer:shell", "computer:file_delete", "computer:desktop", "computer:browser_submit", "connector:call"]);

export const principalId = (p: Principal): string => {
	switch (p.kind) {
		case "user": return p.sessionId;
		case "token": return p.tokenId;
		case "agent": return p.agentId;
		case "delegated": return p.delegateId;
	}
};
export const principalKey = (p: Principal): string => `${p.kind}:${principalId(p)}`;

const scopeAllows = (scopes: readonly string[], action: string) => scopes.some((s) => s === "*" || s === action || (s.endsWith(":*") && action.startsWith(s.slice(0, -1))));

/**
 * The one place that decides, as `@pim/v2-contracts` defines it. HTTP routes, WebSocket subscriptions, the MCP server and agent tools all
 * call it. On the effective principal (the origin of a delegation chain) it checks, in order: every owner in the chain is alive (suspended:
 * 403, deleting or deleted: 410, on every surface alike), the token scope allows the action, the owner's role allows it, a CodingGrant covers
 * coding actions, and then whether a person must still approve: a StandingApproval record stands in for them, otherwise `approval_required`.
 * Permission and approval stay separate answers.
 */
export class Authorizer implements AuthorizerContract {
	constructor(private readonly db: Db, private readonly now: () => Date = () => new Date()) {}

	async account(ownerId: string): Promise<Account | null> {
		return this.db.owner(ownerId, (tx) => readAccount(tx, ownerId));
	}

	/** Throws unless the owner may act at all. Public hosted-app execution and triggers call this before running anything for an owner. */
	async requireLive(ownerId: string, action = "act"): Promise<Account> {
		const account = await this.account(ownerId);
		if (!account) throw new UnauthorizedError("Unknown account");
		if (account.status === "deleting" || account.status === "deleted") throw new GoneError();
		if (account.status === "suspended") throw new ForbiddenError(action, "suspended");
		if (account.status === "pending") throw new ForbiddenError(action, "pending");
		return account;
	}

	async authorize(request: AuthzRequest): Promise<AuthzDecision> {
		let decision: AuthzDecision;
		try {
			decision = await this.#decide(request);
		} catch (error) {
			await this.#audit(request, error instanceof CapabilityUnavailableError ? "unavailable" : "denied").catch(() => undefined);
			throw error;
		}
		await this.#audit(request, decision.outcome === "allow" ? "allowed" : "approval_required").catch(() => undefined);
		return decision;
	}

	/** Like `authorize`, for a caller with no way to ask a person: approval_required becomes ApprovalRequiredError. The owner is the principal's. */
	async enforce(principal: Principal, action: string, resource?: Readonly<Record<string, string>>): Promise<void> {
		const decision = await this.authorize({ principal, ownerId: principal.ownerId, action, ...(resource ? { resource } : {}) });
		if (decision.outcome === "approval_required") throw new ApprovalRequiredError(action, decision.approvalKey);
	}

	async #decide(request: AuthzRequest): Promise<AuthzDecision> {
		const { principal, action } = request;
		const resource = request.resource ?? {};
		// Everyone in the chain, and the owner whose resources are touched, must be alive: an origin that was suspended stops what it started.
		const owners = new Set<string>([request.ownerId]);
		for (let p: Principal = principal; ; p = p.originPrincipal) {
			owners.add(p.ownerId);
			if (p.kind !== "delegated") break;
		}
		let account: Account | null = null;
		for (const owner of owners) {
			const a = await this.requireLive(owner, action);
			if (owner === effectivePrincipal(principal).ownerId) account = a;
		}
		const eff = effectivePrincipal(principal);
		if (eff.ownerId !== request.ownerId) throw new ForbiddenError(action, "another-owner");
		const role = account!.role;
		if (eff.kind === "token" && !scopeAllows(eff.scopes, action)) throw new ForbiddenError(action, "scope");
		if (eff.kind === "agent" && !scopeAllows(AGENT_SCOPES, action)) throw new ForbiddenError(action, "agent-scope");
		if (SESSION_ONLY.has(action) && eff.kind !== "user") throw new ForbiddenError(action, "session-only");
		if (action.startsWith("admin:") && role !== "admin") throw new ForbiddenError(action, "admin-only");
		if (role === "guest" && GUEST_DENIED.test(action)) throw new ForbiddenError(action, "guest");
		if (CODING_ACTIONS.has(action)) await this.#codingGrant(request, action as CodingPermission, resource);
		if (NEEDS_APPROVAL.has(action)) {
			const standing = await this.#standing(request.ownerId, action, resource);
			if (standing) return { outcome: "allow", viaStandingApproval: standing };
			return { outcome: "approval_required", approvalKey: `${action}:${JSON.stringify(Object.entries(resource).sort())}` };
		}
		return { outcome: "allow" };
	}

	async #codingGrant(request: AuthzRequest, action: CodingPermission, resource: Readonly<Record<string, string>>): Promise<void> {
		const grants = await this.codingGrants(request.ownerId);
		const covering = grants.filter((g) => g.permissions.includes(action));
		if (!covering.length) throw new ForbiddenError(action, "no-coding-grant");
		if (action === "coding:start" && !covering.some((g) => g.pools.length)) throw new CapabilityUnavailableError("coding", "no compute pool is granted or configured for this owner");
		if (resource.repository && !covering.some((g) => repositoryAllowed(g.repositories, resource.repository!))) throw new ForbiddenError(action, "repository-not-granted");
		if (resource.pool && !covering.some((g) => g.pools.includes(resource.pool!))) throw new ForbiddenError(action, "pool-not-granted");
	}

	async codingGrants(ownerId: string): Promise<CodingGrant[]> {
		return this.db.owner(ownerId, async (tx) =>
			(await tx.query("SELECT * FROM pim_app.coding_grants WHERE revoked_at IS NULL")).rows.map((r) => ({
				grantId: r.grant_id, ownerId: r.owner_id, permissions: r.permissions, pools: r.pools, repositories: r.repositories, quota: r.quota as ResourceQuota, grantedBy: r.granted_by, grantedAt: r.granted_at.toISOString(),
			})),
		);
	}

	async #standing(ownerId: string, action: string, resource: Readonly<Record<string, string>>): Promise<string | null> {
		const now = this.now();
		const approvals = await this.db.owner(ownerId, async (tx): Promise<StandingApproval[]> =>
			(await tx.query("SELECT * FROM pim_app.standing_approvals WHERE action = $1 AND revoked_at IS NULL", [action])).rows.map((r) => ({
				approvalId: r.approval_id, ownerId: r.owner_id, action: r.action, scope: r.scope, grantedBy: r.granted_by, grantedAt: r.granted_at.toISOString(), ...(r.expires_at ? { expiresAt: r.expires_at.toISOString() } : {}),
			})),
		);
		return approvals.find((a) => standingApprovalCovers(a, action, resource, now))?.approvalId ?? null;
	}

	#audit(request: AuthzRequest, decision: string): Promise<void> {
		return this.db.owner(request.ownerId, async (tx) => {
			await tx.query("INSERT INTO pim_app.audit_log (owner_id, actor, action, resource, decision) VALUES ($1, $2, $3, $4, $5)", [request.ownerId, principalKey(request.principal), request.action, JSON.stringify(request.resource ?? {}), decision]);
		});
	}

	/** An admin gives `ownerId` a coding grant. Absence of a grant is a refusal. */
	async grantCoding(admin: Principal, input: { ownerId: string; permissions: CodingPermission[]; pools?: string[]; repositories?: string[]; quota?: ResourceQuota }): Promise<string> {
		await this.enforce(admin, "admin:grants");
		const grantId = newId("cg");
		await this.db.owner(input.ownerId, (tx) =>
			tx.query("INSERT INTO pim_app.coding_grants (grant_id, owner_id, permissions, pools, repositories, quota, granted_by) VALUES ($1,$2,$3,$4,$5,$6,$7)", [
				grantId, input.ownerId, input.permissions, input.pools ?? [], input.repositories ?? [], JSON.stringify(input.quota ?? {}), admin.ownerId,
			]),
		);
		return grantId;
	}

	/** An admin records that a kind of gated action may go ahead without asking again, within `scope` and until `expiresAt`. */
	async grantStanding(admin: Principal, input: { ownerId: string; action: string; scope: Record<string, string>; expiresAt?: Date }): Promise<string> {
		await this.enforce(admin, "admin:grants");
		const approvalId = newId("sa");
		await this.db.owner(input.ownerId, (tx) =>
			tx.query("INSERT INTO pim_app.standing_approvals (approval_id, owner_id, action, scope, granted_by, expires_at) VALUES ($1,$2,$3,$4,$5,$6)", [approvalId, input.ownerId, input.action, JSON.stringify(input.scope), admin.ownerId, input.expiresAt ?? null]),
		);
		return approvalId;
	}

	async revokeStanding(admin: Principal, ownerId: string, approvalId: string): Promise<void> {
		await this.enforce(admin, "admin:grants");
		await this.db.owner(ownerId, (tx) => tx.query("UPDATE pim_app.standing_approvals SET revoked_at = now() WHERE approval_id = $1", [approvalId]));
	}
}

export async function readAccount(tx: Tx, ownerId: string): Promise<Account | null> {
	const { rows } = await tx.query("SELECT owner_id, username, role, status, bot FROM pim_app.accounts WHERE owner_id = $1", [ownerId]);
	const r = rows[0];
	return r ? { ownerId: OwnerId.parse(r.owner_id), username: r.username, role: r.role, status: r.status, bot: r.bot } : null;
}
