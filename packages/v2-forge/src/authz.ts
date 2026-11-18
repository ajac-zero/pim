// Coding authorization. Chatting with a normal agent grants nothing here: running code needs an admin-issued grant, a repository the deployment and the grant both allow, and (where policy says so) a person's approval.
// REST routes and agent tools both call `check`, at start and again before every privileged action, so they cannot drift apart.
import { type Db, type Row, tx } from "./db";
import { effectivePrincipal, type Principal } from "@pim/v2-contracts/identity";
import { type Authorizer, type AuthzDecision, type AuthzRequest, standingApprovalCovers, repositoryAllowed } from "@pim/v2-contracts/authz";
import { CapabilityUnavailableError, ForbiddenError, ForgeError } from "./errors";
import { HARNESSES } from "./harnesses";

export type Permission = "coding:start" | "coding:steer" | "coding:abort" | "coding:push" | "coding:pr" | "coding:merge";

/** Who is asking: a person's session or token, or an agent acting inside that person's space. */
export type Actor = {
	readonly ownerId: string;
	readonly tenantId?: string | null;
	readonly role: "admin" | "member" | "guest";
	/** Set when an agent of the space, not the person, makes the call. */
	readonly agent?: string | null;
};

export type Decision = { readonly grantId: number; readonly standing: boolean; readonly requiresApproval: boolean; /** The standing approval that stood in for a person's yes. */ readonly viaStandingApproval?: string };

export type Policy = {
	/** Repositories (`owner/name`, `owner/*`, `*`) this deployment lets coding touch at all. Empty denies every repository. */
	readonly allowedRepos: readonly string[];
	/** Pushes are confined to this prefix; the default branch is only ever reached by coding_merge. */
	readonly branchPrefix: string;
};

export const DEFAULT_POLICY: Policy = { allowedRepos: [], branchPrefix: "pim/" };

const URL_REPO = /^https?:\/\/([^/\s]+)\/([^/\s]+)\/([^/\s?#]+?)(?:\.git)?\/?(?:[?#].*)?$/;

/** `owner/name` from a GitHub or Gitea repository URL (`.git` and a trailing slash dropped), or from `owner/name` itself; null when it is neither. */
export function repoName(repo: string): string | null {
	const url = URL_REPO.exec(repo.trim());
	if (url) return `${url[2]}/${url[3]}`.toLowerCase();
	const plain = /^([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+)$/.exec(repo.trim());
	return plain ? `${plain[1]}/${plain[2]}`.toLowerCase() : null;
}

/** `host/owner/name`, the form the contracts' grants and standing approvals use; null for a bare `owner/name`. */
export function repoRef(repo: string): string | null {
	const url = URL_REPO.exec(repo.trim());
	return url ? `${url[1]}/${url[2]}/${url[3]}`.toLowerCase() : null;
}

/** Whether `repo` is covered by patterns: `*`, `owner/name`, `owner/*`, or the host-qualified `host/owner/name` and `host/owner/*`, however `repo` is spelled (see `repositoryAllowed`). */
export function repoMatches(patterns: readonly string[], repo: string): boolean {
	return repoName(repo) !== null && repositoryAllowed(patterns, repo);
}

/** What a deployment is told when Forge files an approval: the thread's owner and chat, and what is being approved. */
export type ApprovalFiled = { approvalId: string; ownerId: string; chatId: string | null; action: string; repo: string };

export class Authz {
	constructor(
		private readonly db: Db,
		readonly policy: Policy = DEFAULT_POLICY,
		/** Called each time Forge asks for an approval, so the person can be shown it where they answer approvals; it must not file the same one twice. */
		readonly onFiled?: (filed: ApprovalFiled) => Promise<void>,
	) {}

	/** Throws ForbiddenError unless some live grant lets the actor do this to the repository (and pool); otherwise says whether a person must also approve. */
	async check(actor: Actor, permission: Permission, target: { repo: string; pool?: string | null; branch?: string }): Promise<Decision> {
		if (actor.role === "guest") throw new ForbiddenError(permission, "guests can't use coding threads");
		const owner = (await this.db.query<Row>("select suspended_at from pim_forge.forge_owners where owner_id = $1", [actor.ownerId])).rows[0];
		if (owner?.suspended_at) throw new ForbiddenError(permission, "this account is suspended");
		if (!repoMatches(this.policy.allowedRepos, target.repo)) throw new ForbiddenError(permission, `the deployment doesn't allow coding on ${target.repo}`);
		const subjects: [string, string][] = [["user", actor.ownerId]];
		if (actor.tenantId) subjects.push(["tenant", actor.tenantId]);
		if (actor.agent) subjects.push(["agent", actor.agent]);
		const grants = (
			await this.db.query<Row>(
				`select * from pim_forge.forge_grants where revoked_at is null and permission = $1
				 and (subject_type, subject_id) in (${subjects.map((_, i) => `($${i * 2 + 2}, $${i * 2 + 3})`).join(", ")})
				 order by requires_approval, grant_id`,
				[permission, ...subjects.flat()],
			)
		).rows;
		const fit = grants.filter((g) => (g.repos === null || repoMatches(g.repos, target.repo)) && (g.pools === null || !target.pool || g.pools.includes(target.pool)));
		if (!fit.length) throw new ForbiddenError(permission, grants.length ? `no grant covers ${target.repo}${target.pool ? ` on pool ${target.pool}` : ""}` : "no grant");
		// Ordered by requires_approval, so an unconditional grant wins over a conditional one.
		const best = fit[0]!;
		if (best.requires_approval) {
			const via = await this.standingApproval(actor.ownerId, permission, { repository: repoRef(target.repo) ?? target.repo, ...(target.branch ? { branch: target.branch } : {}) });
			if (via) return { grantId: Number(best.grant_id), standing: best.standing, requiresApproval: false, viaStandingApproval: via };
		}
		return { grantId: Number(best.grant_id), standing: best.standing, requiresApproval: best.requires_approval };
	}

	/** The id of a live standing approval covering this action and resource, or null. */
	async standingApproval(ownerId: string, action: string, resource: Record<string, string>): Promise<string | null> {
		const rows = (await this.db.query<Row>("select * from pim_forge.forge_standing_approvals where owner_id = $1 and action = $2 and revoked_at is null", [ownerId, action])).rows;
		const hit = rows.find((r) => standingApprovalCovers({ approvalId: r.approval_id, ownerId: r.owner_id, action: r.action, scope: r.scope, grantedBy: r.granted_by, grantedAt: new Date(r.granted_at).toISOString(), ...(r.expires_at ? { expiresAt: new Date(r.expires_at).toISOString() } : {}) } as never, action, resource, new Date()));
		return hit ? (hit.approval_id as string) : null;
	}

	/** Records a standing approval: an author, an optional expiry, and a scope every key of which must match. */
	async grantStanding(a: { approvalId: string; ownerId: string; action: Permission; scope: Record<string, string>; grantedBy: string; expiresAt?: Date }): Promise<void> {
		await this.db.query("insert into pim_forge.forge_standing_approvals (approval_id, owner_id, action, scope, granted_by, expires_at) values ($1,$2,$3,$4,$5,$6)", [a.approvalId, a.ownerId, a.action, a.scope, a.grantedBy, a.expiresAt ?? null]);
	}

	async revokeStanding(approvalId: string): Promise<void> {
		await this.db.query("update pim_forge.forge_standing_approvals set revoked_at = now() where approval_id = $1", [approvalId]);
	}

	async grant(g: { subjectType: "user" | "tenant" | "agent"; subjectId: string; permission: Permission; repos?: string[] | null; pools?: string[] | null; requiresApproval?: boolean; standing?: boolean; grantedBy: string; /** The Gate's grant this one follows, so revoking that revokes this. */ sourceGrantId?: string }): Promise<number> {
		const r = await this.db.query<Row>(
			`insert into pim_forge.forge_grants (subject_type, subject_id, permission, repos, pools, requires_approval, standing, granted_by, source_grant_id) values ($1,$2,$3,$4,$5,$6,$7,$8,$9) returning grant_id`,
			[g.subjectType, g.subjectId, g.permission, g.repos ?? null, g.pools ?? null, g.requiresApproval ?? false, g.standing ?? false, g.grantedBy, g.sourceGrantId ?? null],
		);
		return Number(r.rows[0]!.grant_id);
	}

	/** Revokes at once: the next check of any thread by that subject fails. */
	async revoke(grantId: number): Promise<void> {
		await this.db.query("update pim_forge.forge_grants set revoked_at = now() where grant_id = $1 and revoked_at is null", [grantId]);
	}

	/**
	 * Revokes the rows that follow one of the Gate's grants. A grant made before rows were linked to it has none, so its rows are found by what they say: the person,
	 * the permissions and the same repositories and pools (`legacy`).
	 */
	async revokeSource(sourceGrantId: string, legacy: { ownerId: string; permissions: string[]; repos: string[] | null; pools: string[] | null }): Promise<void> {
		await this.db.query(
			`update pim_forge.forge_grants set revoked_at = now() where revoked_at is null and (source_grant_id = $1
			 or (source_grant_id is null and subject_type = 'user' and subject_id = $2 and permission = any($3) and repos is not distinct from $4::text[] and pools is not distinct from $5::text[]))`,
			[sourceGrantId, legacy.ownerId, legacy.permissions, legacy.repos, legacy.pools],
		);
	}

	async setSuspended(ownerId: string, suspended: boolean, tenantId: string | null = null): Promise<void> {
		await this.db.query(
			`insert into pim_forge.forge_owners (owner_id, tenant_id, suspended_at) values ($1, $2, case when $3 then now() end)
			 on conflict (owner_id) do update set suspended_at = case when $3 then coalesce(pim_forge.forge_owners.suspended_at, now()) end`,
			[ownerId, tenantId, suspended],
		);
	}

	async suspended(ownerId: string): Promise<boolean> {
		return (await this.db.query("select 1 from pim_forge.forge_owners where owner_id = $1 and suspended_at is not null", [ownerId])).rows.length > 0;
	}

	/** Files a human approval for an action; the same action again is the same approval. */
	async requestApproval(threadId: string, action: string, payload: object = {}): Promise<string> {
		const id = `cp-${threadId.slice(0, 8)}-${action}`;
		await this.db.query("insert into pim_forge.forge_approvals (approval_id, thread_id, action, payload) values ($1,$2,$3,$4) on conflict (approval_id) do nothing", [id, threadId, action, payload]);
		const thread = (await this.db.query<Row>("select owner_id, chat_id, repo from pim_forge.forge_threads where thread_id = $1", [threadId])).rows[0];
		if (thread) await this.onFiled?.({ approvalId: id, ownerId: thread.owner_id as string, chatId: (thread.chat_id as string | null) ?? null, action, repo: thread.repo as string });
		return id;
	}

	/** Only the thread's owner approves, as a person: an agent of the space cannot approve for them. */
	async decide(approvalId: string, by: Actor, approve: boolean): Promise<void> {
		if (by.agent) throw new ForbiddenError("approve", "an agent can't approve its own request");
		await tx(this.db, async (q) => {
			const row = (await q.query<Row>("select a.*, t.owner_id from pim_forge.forge_approvals a join pim_forge.forge_threads t using (thread_id) where approval_id = $1 for update of a", [approvalId])).rows[0];
			if (!row) throw new ForgeError("not_found", `No approval ${approvalId}`);
			if (row.owner_id !== by.ownerId) throw new ForbiddenError("approve", "only the thread's owner decides this approval");
			await q.query("update pim_forge.forge_approvals set status = $2, decided_by = $3 where approval_id = $1", [approvalId, approve ? "approved" : "denied", by.ownerId]);
		});
	}

	async approved(threadId: string, action: string): Promise<boolean> {
		return (await this.db.query("select 1 from pim_forge.forge_approvals where thread_id = $1 and action = $2 and status = 'approved'", [threadId, action])).rows.length > 0;
	}

	async consumeApproval(threadId: string, action: string): Promise<void> {
		await this.db.query("delete from pim_forge.forge_approvals where thread_id = $1 and action = $2 and status = 'approved'", [threadId, action]);
	}
}

/** The deployment can run coding at all: a pool for sandbox harnesses, an Amp credential for amp. Missing is 503, distinct from a person lacking a grant. */
export async function assertCapability(db: Db, harness: string, ampConfigured: boolean, pool?: string | null): Promise<void> {
	if (!(HARNESSES as readonly string[]).includes(harness)) throw new ForgeError("invalid", `Unknown harness ${harness}`);
	if (harness === "amp") {
		if (!ampConfigured) throw new CapabilityUnavailableError("coding:amp", "this deployment has no Amp credential configured");
		return;
	}
	const pools = (await db.query<Row>("select pool_id from pim_forge.forge_pools where enabled and ($1::text is null or pool_id = $1)", [pool ?? null])).rows;
	if (!pools.length) throw new CapabilityUnavailableError("coding:pool", pool ? `coding pool ${pool} isn't available` : "this deployment has no coding pool configured");
}

/** Branch rules for Pim-side pushes: only `<prefix>*`, and never the default branch, which only coding_merge reaches. */
export function assertPushBranch(policy: Policy, branch: string, defaultBranch: string): void {
	if (branch === defaultBranch || !branch.startsWith(policy.branchPrefix) || branch === policy.branchPrefix) {
		throw new ForgeError("push_refused", `Coding threads push only to ${policy.branchPrefix}* branches, never to ${defaultBranch}; use coding_merge to integrate`);
	}
}

const PERMISSIONS: readonly string[] = ["coding:start", "coding:steer", "coding:abort", "coding:push", "coding:pr", "coding:merge"];

/** The contracts' `Authorizer` for coding actions, so every workstream asks the same question the same way. Decides on the origin of a delegation chain. */
export class ForgeAuthorizer implements Authorizer {
	constructor(private readonly authz: Authz) {}

	async authorize(request: AuthzRequest): Promise<AuthzDecision> {
		const { action } = request;
		if (!PERMISSIONS.includes(action)) throw new ForbiddenError(action, "not a coding action");
		const principal = effectivePrincipal(request.principal as Principal);
		if (principal.ownerId !== request.ownerId) throw new ForbiddenError(action, "the principal doesn't act for this owner");
		if (principal.kind === "token" && principal.scopes.length && !principal.scopes.some((s) => s === action || s === "coding:*" || s === "*")) throw new ForbiddenError(action, "the token lacks this scope");
		const actor: Actor = principal.kind === "agent" ? { ownerId: principal.ownerId, role: "member", agent: principal.agentId } : { ownerId: principal.ownerId, role: principal.role };
		const repository = request.resource?.repository;
		if (!repository) throw new ForbiddenError(action, "no repository named");
		const decision = await this.authz.check(actor, action as Permission, { repo: /^https?:/.test(repository) ? repository : repoName(repository) === repository.toLowerCase() ? repository : `https://${repository}`, pool: request.resource?.pool ?? null, branch: request.resource?.branch });
		return decision.requiresApproval ? { outcome: "approval_required", approvalKey: `${action}:${repository}` } : { outcome: "allow", ...(decision.viaStandingApproval ? { viaStandingApproval: decision.viaStandingApproval } : {}) };
	}
}
