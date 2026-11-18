/**
 * Who a Live connection is, and what the Gate tells Live when that changes. The Live process is the `pim_live` role and reads no application
 * table: it asks two SECURITY DEFINER functions (migration 0602) that return a credential's owner and whether it is still valid.
 */
import { createHash } from "node:crypto";
import type { IncomingMessage } from "node:http";
import { type AuthzRequest, type Authorizer, ForbiddenError } from "@pim/v2-contracts/authz";
import { OwnerId, type Principal } from "@pim/v2-contracts/identity";
import type { App } from "@pim/v2-app/app";
import { bearerOf } from "@pim/v2-app/http";
import type { LiveIdentity } from "@pim/v2-live/server/identity";
import type { Pulse } from "@pim/v2-live/server/pulse";
import type { Pool } from "pg";

const sha256 = (text: string) => createHash("sha256").update(text).digest("hex");

export class AppLiveIdentity implements LiveIdentity {
	constructor(
		private readonly pool: Pool,
		private readonly secure: boolean,
	) {}

	async authenticate(request: IncomingMessage): Promise<Principal | null> {
		const { bearer } = bearerOf(request, new URL(request.url ?? "/", "http://live"), this.secure);
		if (!bearer) return null;
		const kind = bearer.startsWith("pims_") ? "session" : bearer.startsWith("pim_") ? "token" : "consumer";
		const { rows } = await this.pool.query<{ kind: string; owner_id: string; id: string; scopes: string[]; role: "admin" | "member" | "guest"; status: string }>("SELECT * FROM pim_app.live_authenticate($1, $2)", [sha256(bearer), kind]);
		const row = rows[0];
		if (!row || row.status !== "active") return null;
		const ownerId = OwnerId.parse(row.owner_id);
		return row.kind === "session" ? { kind: "user", ownerId, role: row.role, sessionId: row.id } : { kind: "token", ownerId, role: row.role, tokenId: row.id, scopes: row.scopes };
	}

	async stillValid(principal: Principal): Promise<boolean> {
		if (principal.kind !== "user" && principal.kind !== "token") return false;
		const id = principal.kind === "user" ? principal.sessionId : principal.tokenId;
		const { rows } = await this.pool.query<{ ok: boolean }>("SELECT pim_app.live_valid($1, $2, $3) AS ok", [principal.kind, principal.ownerId, id]);
		return rows[0]?.ok === true;
	}
}

/**
 * What a principal may follow on Live. Every topic is read as the principal's own owner and row-level security shows nothing else, so the question
 * left is whether this credential may read at all: a session always, a token only with a scope that reads.
 */
export class LiveAuthorizer implements Authorizer {
	async authorize(request: AuthzRequest) {
		const p = request.principal;
		if (p.kind === "token" && !p.scopes.some((s) => s === "*" || s === "api:*" || s === "api:read" || s === "live:*" || s === "live:subscribe")) throw new ForbiddenError(request.action, "the token's scopes do not read");
		return { outcome: "allow" as const };
	}
}

/**
 * Tells Live the moment access ends, instead of leaving it to the next periodic check: suspending, deleting or revoking publishes a Pulse
 * revocation after the Gate's own change committed. Wraps the identity service in place; a failed publish never fails the change.
 */
export function publishRevocations(app: App, pulse: Pulse): void {
	const identity = app.identity;
	const tell = (ownerId: string, sessionId?: string) => void pulse.publishRevocation(ownerId, sessionId).catch(() => undefined);
	const setStatus = identity.setStatus.bind(identity);
	identity.setStatus = async (admin, ownerId, status, reason) => {
		await setStatus(admin, ownerId, status, reason);
		if (status !== "active") tell(ownerId);
	};
	const revokeSession = identity.revokeSession.bind(identity);
	identity.revokeSession = async (ownerId, id) => {
		await revokeSession(ownerId, id);
		tell(ownerId, id);
	};
	const revokeToken = identity.revokeToken.bind(identity);
	identity.revokeToken = async (session, id) => {
		await revokeToken(session, id);
		tell(session.ownerId, id);
	};
	const deleteSelf = identity.deleteSelf.bind(identity);
	identity.deleteSelf = async (session) => {
		await deleteSelf(session);
		tell(session.ownerId);
	};
}

/**
 * A person's decision on a parked call reaches the runtime. The Gate records the decision; the chat's task is parked in the runtime, and
 * only an `approval_decision` command wakes it. The approval names its task and chat in the arguments the tool filed it with; the command id is
 * the approval's, so deciding twice is one command.
 */
export function deliverApprovalDecisions(app: App): void {
	const decide = app.approvals.decide.bind(app.approvals);
	app.approvals.decide = async (p, approvalId, approve) => {
		await decide(p, approvalId, approve);
		const row = await app.db.owner(p.ownerId, async (tx) => (await tx.query("SELECT public_chat_id, args FROM pim_app.approvals WHERE id = $1", [approvalId])).rows[0]);
		const taskId = row?.args?.taskId;
		// A guest's call that asked the host: the parked task is in the guest's own chat, so the decision is admitted there, as the guest's.
		if (row?.args?.guestOwner && row.args.guestChat && taskId !== undefined) {
			await app.conversations.admit({ kind: "user", ownerId: row.args.guestOwner, role: "guest", sessionId: "guest-approval" }, { commandId: `approval:${approvalId}`, kind: "approval_decision", chatId: row.args.guestChat, payload: { taskId, approved: approve, approvalId } });
		} else if (row?.public_chat_id && taskId !== undefined) {
			await app.conversations.admit(p, { commandId: `approval:${approvalId}`, kind: "approval_decision", chatId: row.public_chat_id, payload: { taskId, approved: approve, approvalId } });
		}
	};
}

/** `host/owner/name` as Forge names a repository: `owner/name`; a wildcard keeps its star. */
const forgeRepo = (repository: string) => (repository.split("/").length >= 3 ? repository.split("/").slice(1).join("/") : repository);
/** The permissions a Forge grant stands for: steering a thread includes aborting it, as Forge names the two. */
const forgePermissions = (permission: string) => (permission === "coding:steer" ? ["coding:steer", "coding:abort"] : [permission]);

/**
 * One source of coding authority. An admin manages grants and standing approvals through the application's `Authorizer` (the Gate's admin routes); Forge enforces its own
 * tables, so each change the application records is written to Forge in the same call, and a failure in either leaves the admin an error, never a half grant that
 * silently permits. Permission and approval stay apart: push, pr and merge need a person's yes unless a standing approval covers them (`requires_approval`).
 */
export function mirrorCodingGrants(app: App, forge: { grant(g: { subjectType: "user"; subjectId: string; permission: never; repos?: string[] | null; pools?: string[] | null; requiresApproval?: boolean; grantedBy: string; sourceGrantId?: string }): Promise<number>; revokeSource(sourceGrantId: string, legacy: { ownerId: string; permissions: string[]; repos: string[] | null; pools: string[] | null }): Promise<void>; grantStanding(a: { approvalId: string; ownerId: string; action: never; scope: Record<string, string>; grantedBy: string; expiresAt?: Date }): Promise<void>; revokeStanding(id: string): Promise<void> }): void {
	const authz = app.identity.authz;
	const grantCoding = authz.grantCoding.bind(authz);
	authz.grantCoding = async (admin, input) => {
		const id = await grantCoding(admin, input);
		for (const permission of input.permissions) {
			for (const mapped of forgePermissions(permission)) {
				await forge.grant({ subjectType: "user", subjectId: input.ownerId, permission: mapped as never, repos: input.repositories?.length ? input.repositories.map(forgeRepo) : null, pools: input.pools?.length ? input.pools : null, requiresApproval: ["coding:push", "coding:pr", "coding:merge"].includes(permission), grantedBy: admin.ownerId, sourceGrantId: id });
			}
		}
		return id;
	};
	// Revoking takes Forge's rows back first: were the Gate's row revoked and Forge's failure left standing, the coding API would keep permitting what the admin took away.
	const revokeCoding = authz.revokeCoding.bind(authz);
	authz.revokeCoding = async (admin, ownerId, grantId) => {
		await authz.enforce(admin, "admin:grants");
		const grant = (await authz.codingGrants(ownerId)).find((g) => g.grantId === grantId);
		if (!grant) return revokeCoding(admin, ownerId, grantId);
		await forge.revokeSource(grantId, { ownerId, permissions: grant.permissions.flatMap(forgePermissions), repos: grant.repositories.length ? grant.repositories.map(forgeRepo) : null, pools: grant.pools.length ? [...grant.pools] : null });
		return revokeCoding(admin, ownerId, grantId);
	};
	const grantStanding = authz.grantStanding.bind(authz);
	authz.grantStanding = async (admin, input) => {
		const id = await grantStanding(admin, input);
		await forge.grantStanding({ approvalId: id, ownerId: input.ownerId, action: input.action as never, scope: input.scope, grantedBy: admin.ownerId, ...(input.expiresAt ? { expiresAt: input.expiresAt } : {}) });
		return id;
	};
	const revokeStanding = authz.revokeStanding.bind(authz);
	authz.revokeStanding = async (admin, ownerId, approvalId) => {
		await revokeStanding(admin, ownerId, approvalId);
		await forge.revokeStanding(approvalId);
	};
}
