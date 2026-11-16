import { createHash } from "node:crypto";
import type pg from "pg";
import { type Q, withTenant } from "./db.ts";
import type { Principal } from "./auth.ts";

/**
 * The one authorization layer. The UI's routes, the HTTP API and an agent's tools all ask `authorize`, so no surface
 * has a rule another lacks. It separates four things that used to blur:
 *
 *  1. who is acting (a person's session or scoped token, or an agent acting for that person),
 *  2. what an agent's own tool permission allows (the agent is only ever as powerful as the person it acts for),
 *  3. coding, compute and repository authority, which is an explicit grant record, never implied by role or by an agent permission,
 *  4. a person's approval of one action, which is evidence for one action and never grows into authority.
 *
 * Everything sensitive is read from the database at the moment of use, so a revoked token, a suspended person, a
 * revoked grant or an exhausted quota stops the next action, not the next cache refresh.
 */
export type ExecutionKind = "coding" | "compute" | "repo_push" | "repo_merge";

const EXECUTION_ACTIONS: Record<string, ExecutionKind> = { "coding.run": "coding", "compute.use": "compute", "repo.push": "repo_push", "repo.merge": "repo_merge" };

export interface Actor {
	principal: Principal;
	/** Set when an agent is acting for the principal. */
	agent?: { agentId: string; /** The tools the agent may call at all. */ tools: ReadonlySet<string>; /** How many delegations deep it is: 0 for the agent the person talks to. */ delegationDepth: number };
}

export interface Resource {
	tenantId: string;
	/** The owner of a chat or file, when the action is on one. */
	ownerUserId?: string;
	/** People the resource is shared with, for a guest or a member who is not the owner. */
	sharedWith?: readonly string[];
	pool?: string;
	repo?: string;
	/** For agent actions: the tool name. */
	tool?: string;
	/** An approval for exactly this action, if the person gave one. */
	approvalId?: string;
	costCents?: number;
}

export interface Decision {
	allow: boolean;
	reason: string;
	/** For an execution action, the grant that authorizes it. */
	grantId?: string;
}

const deny = (reason: string): Decision => ({ allow: false, reason });

export class Forbidden extends Error {
	constructor(readonly decision: Decision) {
		super(`Forbidden: ${decision.reason}`);
	}
}

const scopeAllows = (scopes: ReadonlySet<string>, action: string): boolean => {
	if (scopes.has("*") || scopes.has(action)) return true;
	const [domain] = action.split(".");
	return scopes.has(`${domain}.*`);
};

/** The digest an approval binds to: the action and its resource, so an approval for one push cannot authorize another. */
export const actionDigest = (action: string, resource: Resource): string =>
	createHash("sha256").update(JSON.stringify([action, resource.tenantId, resource.pool ?? null, resource.repo ?? null, resource.tool ?? null])).digest("hex");

/** Whether the principal's credential and person are still live. Called on every sensitive use, not cached. */
export async function stillValid(q: Q, principal: Principal): Promise<boolean> {
	const user = await q.get("SELECT 1 FROM app.users u JOIN app.tenants t ON t.tenant_id = u.tenant_id WHERE u.tenant_id = $1 AND u.user_id = $2 AND u.status = 'active' AND t.status = 'active'", principal.tenantId, principal.userId);
	if (user === undefined) return false;
	const credential =
		principal.via === "session"
			? await q.get("SELECT 1 FROM app.sessions WHERE token_hash = $1 AND tenant_id = $2 AND revoked_at IS NULL AND expires_at > now()", principal.credentialId, principal.tenantId)
			: await q.get("SELECT 1 FROM app.api_tokens WHERE token_id = $1 AND tenant_id = $2 AND revoked_at IS NULL AND (expires_at IS NULL OR expires_at > now())", principal.credentialId, principal.tenantId);
	return credential !== undefined;
}

export async function authorize(pool: pg.Pool, actor: Actor, action: string, resource: Resource): Promise<Decision> {
	const { principal } = actor;
	if (resource.tenantId !== principal.tenantId) return deny("tenant mismatch");
	const decision = await withTenant(
		pool,
		principal.tenantId,
		async (q) => {
			if (!(await stillValid(q, principal))) return deny("credential or person is no longer active");
			if (!scopeAllows(principal.scopes, action)) return deny(`credential scope does not include ${action}`);
			if (actor.agent !== undefined) {
				if (resource.tool === undefined) return deny("an agent action must name its tool");
				if (!actor.agent.tools.has(resource.tool)) return deny(`agent has no permission for tool ${resource.tool}`);
			}
			const execution = EXECUTION_ACTIONS[action];
			if (execution !== undefined) return executionDecision(q, actor, action, execution, resource);
			if (action.startsWith("admin.") && principal.role !== "admin") return deny("admin role required");
			if (principal.role === "guest") {
				const guestAllowed = action === "chat.read" || action === "chat.send";
				const shared = resource.ownerUserId === principal.userId || resource.sharedWith?.includes(principal.userId) === true;
				if (!guestAllowed || !shared) return deny("a guest may only use chats shared with them");
			}
			if (principal.role === "member" && resource.ownerUserId !== undefined && resource.ownerUserId !== principal.userId && !(resource.sharedWith?.includes(principal.userId) ?? false)) return deny("not the owner and not shared");
			return { allow: true, reason: "allowed" } satisfies Decision;
		},
		{ readOnly: true },
	);
	return decision;
}

async function executionDecision(q: Q, actor: Actor, action: string, kind: ExecutionKind, resource: Resource): Promise<Decision> {
	const { principal } = actor;
	// Role is deliberately not consulted: an admin manages grants but must hold one to run.
	const grants = await q.all<{ grant_id: string; pools: string[]; repos: string[]; standing: boolean; allow_delegates: boolean; quota_runs: number | null; spend_cap_cents: number | null; spent_cents: number }>(
		`SELECT grant_id, pools, repos, standing, allow_delegates, quota_runs, spend_cap_cents, spent_cents FROM app.execution_grants
		 WHERE tenant_id = $1 AND subject_user = $2 AND kind = $3 AND revoked_at IS NULL AND (expires_at IS NULL OR expires_at > now()) ORDER BY created_at`,
		principal.tenantId,
		principal.userId,
		kind,
	);
	if (grants.length === 0) return deny(`no ${kind} grant`);
	let lastReason = "no grant matches";
	for (const grant of grants) {
		if (resource.pool !== undefined && !grant.pools.includes(resource.pool)) {
			lastReason = `pool ${resource.pool} is not granted`;
			continue;
		}
		// Push and merge always name a granted repository; a coding grant that lists repositories limits the run to them too.
		if (((kind === "repo_push" || kind === "repo_merge") || (kind === "coding" && grant.repos.length > 0)) && (resource.repo === undefined || !grant.repos.includes(resource.repo))) {
			lastReason = `repository ${resource.repo ?? "(none)"} is not granted`;
			continue;
		}
		if (grant.spend_cap_cents !== null && grant.spent_cents + (resource.costCents ?? 0) > grant.spend_cap_cents) {
			lastReason = "spend cap reached";
			continue;
		}
		if (grant.quota_runs !== null) {
			const used = await q.get<{ n: number }>("SELECT count(*)::int AS n FROM app.audit WHERE tenant_id = $1 AND actor = $2 AND action = $3 AND outcome = $4", principal.tenantId, principal.userId, action, `grant:${grant.grant_id}`);
			if ((used?.n ?? 0) >= grant.quota_runs) {
				lastReason = "run quota reached";
				continue;
			}
		}
		if (actor.agent !== undefined) {
			// No laundering: an agent, and above all a delegated one, exercises a person's authority only where the record says so.
			if (actor.agent.delegationDepth > 0 && !grant.allow_delegates) {
				lastReason = "the grant does not extend to delegated agents";
				continue;
			}
			if (!grant.standing) {
				// A one-off authority needs the person's approval of exactly this action.
				const approved = resource.approvalId === undefined ? undefined : await q.get("SELECT 1 FROM app.approvals WHERE tenant_id = $1 AND approval_id = $2 AND status = 'approved' AND decided_by = $3 AND action_digest = $4", principal.tenantId, resource.approvalId, principal.userId, actionDigest(action, resource));
				if (approved === undefined) {
					lastReason = "needs the person's approval of this action";
					continue;
				}
			}
		}
		return { allow: true, reason: grant.standing ? "standing grant" : "grant", grantId: grant.grant_id };
	}
	return deny(lastReason);
}

/** Authorize and record the decision. Denials and execution authority are audited. */
export async function enforce(pool: pg.Pool, actor: Actor, action: string, resource: Resource): Promise<Decision> {
	const decision = await authorize(pool, actor, action, resource);
	if (!decision.allow || EXECUTION_ACTIONS[action] !== undefined) {
		await withTenant(pool, actor.principal.tenantId, (q) =>
			q.run("INSERT INTO app.audit (tenant_id, actor, action, resource, outcome) VALUES ($1, $2, $3, $4, $5)", actor.principal.tenantId, actor.principal.userId, action, resource.repo ?? resource.pool ?? resource.tool ?? null, decision.allow ? `grant:${decision.grantId}` : `denied:${decision.reason}`),
		).catch(() => undefined);
	}
	if (!decision.allow) throw new Forbidden(decision);
	return decision;
}

/** Admin: grant, and revoke, execution authority. Always an explicit record. */
export async function createGrant(pool: pg.Pool, admin: Principal, input: { grantId: string; subjectUser: string; kind: ExecutionKind; pools?: string[]; repos?: string[]; standing?: boolean; allowDelegates?: boolean; quotaRuns?: number; spendCapCents?: number; expiresInMs?: number }): Promise<void> {
	if (admin.role !== "admin") throw new Forbidden(deny("admin role required"));
	await withTenant(pool, admin.tenantId, async (q) => {
		if (!(await stillValid(q, admin))) throw new Forbidden(deny("credential is no longer active"));
		await q.run(
			`INSERT INTO app.execution_grants (tenant_id, grant_id, subject_user, kind, pools, repos, standing, allow_delegates, quota_runs, spend_cap_cents, granted_by, expires_at)
			 VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, CASE WHEN $12::bigint IS NULL THEN NULL ELSE now() + ($12::bigint || ' milliseconds')::interval END)`,
			admin.tenantId,
			input.grantId,
			input.subjectUser,
			input.kind,
			input.pools ?? [],
			input.repos ?? [],
			input.standing ?? false,
			input.allowDelegates ?? false,
			input.quotaRuns ?? null,
			input.spendCapCents ?? null,
			admin.userId,
			input.expiresInMs ?? null,
		);
		await q.run("INSERT INTO app.audit (tenant_id, actor, action, resource, outcome) VALUES ($1, $2, 'grant.create', $3, 'ok')", admin.tenantId, admin.userId, input.grantId);
	});
}

export async function revokeGrant(pool: pg.Pool, admin: Principal, grantId: string): Promise<boolean> {
	if (admin.role !== "admin") throw new Forbidden(deny("admin role required"));
	return withTenant(pool, admin.tenantId, async (q) => {
		const n = await q.run("UPDATE app.execution_grants SET revoked_at = now() WHERE tenant_id = $1 AND grant_id = $2 AND revoked_at IS NULL", admin.tenantId, grantId);
		await q.run("INSERT INTO app.audit (tenant_id, actor, action, resource, outcome) VALUES ($1, $2, 'grant.revoke', $3, 'ok')", admin.tenantId, admin.userId, grantId);
		return n === 1;
	});
}
