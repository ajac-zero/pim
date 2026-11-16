// Coding authorization. Chatting with a normal agent grants nothing here: running code needs an admin-issued grant, a repository the deployment and the grant both allow, and (where policy says so) a person's approval.
// REST routes and agent tools both call `check`, at start and again before every privileged action, so they cannot drift apart.
import { type Db, type Row, tx } from "./db";
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

export type Decision = { readonly grantId: number; readonly standing: boolean; readonly requiresApproval: boolean };

export type Policy = {
	/** Repositories (`owner/name`, `owner/*`, `*`) this deployment lets coding touch at all. Empty denies every repository. */
	readonly allowedRepos: readonly string[];
	/** Pushes are confined to this prefix; the default branch is only ever reached by coding_merge. */
	readonly branchPrefix: string;
};

export const DEFAULT_POLICY: Policy = { allowedRepos: [], branchPrefix: "pim/" };

/** `owner/name` from a GitHub or Gitea repository URL, `.git` suffix and trailing slash dropped; null when it is not one. */
export function repoName(repo: string): string | null {
	const url = /^https?:\/\/[^/\s]+\/([^/\s]+)\/([^/\s?#]+?)(?:\.git)?\/?(?:[?#].*)?$/.exec(repo.trim());
	if (url) return `${url[1]}/${url[2]}`.toLowerCase();
	const plain = /^([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+)$/.exec(repo.trim());
	return plain ? `${plain[1]}/${plain[2]}`.toLowerCase() : null;
}

export function repoMatches(patterns: readonly string[], repo: string): boolean {
	const name = repoName(repo);
	if (!name) return false;
	return patterns.some((raw) => {
		const p = raw.toLowerCase();
		return p === "*" || p === name || (p.endsWith("/*") && name.startsWith(p.slice(0, -1)));
	});
}

export class Authz {
	constructor(
		private readonly db: Db,
		readonly policy: Policy = DEFAULT_POLICY,
	) {}

	/** Throws ForbiddenError unless some live grant lets the actor do this to the repository (and pool); otherwise says whether a person must also approve. */
	async check(actor: Actor, permission: Permission, target: { repo: string; pool?: string | null }): Promise<Decision> {
		if (actor.role === "guest") throw new ForbiddenError("Guests can't use coding threads");
		const owner = (await this.db.query<Row>("select suspended_at from pim_forge.forge_owners where owner_id = $1", [actor.ownerId])).rows[0];
		if (owner?.suspended_at) throw new ForbiddenError("This account is suspended");
		if (!repoMatches(this.policy.allowedRepos, target.repo)) throw new ForbiddenError(`The deployment doesn't allow coding on ${target.repo}`);
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
		if (!fit.length) throw new ForbiddenError(grants.length ? `No grant of ${permission} covers ${target.repo}${target.pool ? ` on pool ${target.pool}` : ""}` : `You have no ${permission} grant`);
		// Ordered by requires_approval, so an unconditional grant wins over a conditional one.
		const best = fit[0]!;
		return { grantId: Number(best.grant_id), standing: best.standing, requiresApproval: best.requires_approval };
	}

	async grant(g: { subjectType: "user" | "tenant" | "agent"; subjectId: string; permission: Permission; repos?: string[] | null; pools?: string[] | null; requiresApproval?: boolean; standing?: boolean; grantedBy: string }): Promise<number> {
		const r = await this.db.query<Row>(
			`insert into pim_forge.forge_grants (subject_type, subject_id, permission, repos, pools, requires_approval, standing, granted_by) values ($1,$2,$3,$4,$5,$6,$7,$8) returning grant_id`,
			[g.subjectType, g.subjectId, g.permission, g.repos ?? null, g.pools ?? null, g.requiresApproval ?? false, g.standing ?? false, g.grantedBy],
		);
		return Number(r.rows[0]!.grant_id);
	}

	/** Revokes at once: the next check of any thread by that subject fails. */
	async revoke(grantId: number): Promise<void> {
		await this.db.query("update pim_forge.forge_grants set revoked_at = now() where grant_id = $1 and revoked_at is null", [grantId]);
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
		return id;
	}

	/** Only the thread's owner approves, as a person: an agent of the space cannot approve for them. */
	async decide(approvalId: string, by: Actor, approve: boolean): Promise<void> {
		if (by.agent) throw new ForbiddenError("An agent can't approve its own request");
		await tx(this.db, async (q) => {
			const row = (await q.query<Row>("select a.*, t.owner_id from pim_forge.forge_approvals a join pim_forge.forge_threads t using (thread_id) where approval_id = $1 for update of a", [approvalId])).rows[0];
			if (!row) throw new ForgeError("not_found", `No approval ${approvalId}`);
			if (row.owner_id !== by.ownerId) throw new ForbiddenError("Only the thread's owner decides this approval");
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
		if (!ampConfigured) throw new CapabilityUnavailableError("This deployment has no Amp credential configured");
		return;
	}
	const pools = (await db.query<Row>("select pool_id from pim_forge.forge_pools where enabled and ($1::text is null or pool_id = $1)", [pool ?? null])).rows;
	if (!pools.length) throw new CapabilityUnavailableError(pool ? `Coding pool ${pool} isn't available` : "This deployment has no coding pool configured");
}

/** Branch rules for Pim-side pushes: only `<prefix>*`, and never the default branch, which only coding_merge reaches. */
export function assertPushBranch(policy: Policy, branch: string, defaultBranch: string): void {
	if (branch === defaultBranch || !branch.startsWith(policy.branchPrefix) || branch === policy.branchPrefix) {
		throw new ForgeError("push_refused", `Coding threads push only to ${policy.branchPrefix}* branches, never to ${defaultBranch}; use coding_merge to integrate`);
	}
}
