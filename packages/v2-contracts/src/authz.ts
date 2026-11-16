import type { OwnerId, Principal } from "./identity.ts";

/** The coding actions an admin grants explicitly. None is implied by a role. */
export const CODING_PERMISSIONS = ["coding:start", "coding:steer", "coding:push", "coding:pr", "coding:merge"] as const;
export type CodingPermission = (typeof CODING_PERMISSIONS)[number];

/** A grant an admin manages. Absence of a grant is a refusal. */
export interface CodingGrant {
	readonly grantId: string;
	readonly ownerId: OwnerId;
	readonly permissions: readonly CodingPermission[];
	/** Compute pools the owner may run on; empty means none. */
	readonly pools: readonly string[];
	/** Repositories as `host/owner/name`, or `host/owner/*`; empty means none. */
	readonly repositories: readonly string[];
	readonly quota: ResourceQuota;
	readonly grantedBy: OwnerId;
	readonly grantedAt: string;
	readonly revokedAt?: string;
}

/** Per-owner or per-tenant limits; an absent field is unlimited only when an admin left it out on purpose. */
export interface ResourceQuota {
	readonly maxConcurrentThreads?: number;
	readonly maxCpuSecondsPerDay?: number;
	readonly maxStorageBytes?: number;
	/** Spend in micro-dollars per UTC day. */
	readonly maxSpendMicrosPerDay?: number;
}

/**
 * A standing approval: a recorded decision that a kind of gated action may go ahead without asking again.
 * It is an auditable record with an author and an optional expiry, never a bypass in code.
 */
export interface StandingApproval {
	readonly approvalId: string;
	readonly ownerId: OwnerId;
	readonly action: string;
	/** What the approval is limited to, such as `{ repository: "github.com/org/repo", branch: "main" }`; every key must match. */
	readonly scope: Readonly<Record<string, string>>;
	readonly grantedBy: OwnerId;
	readonly grantedAt: string;
	readonly expiresAt?: string;
	readonly revokedAt?: string;
}

/** What a caller wants to do. */
export interface AuthzRequest {
	readonly principal: Principal;
	/** The owner whose resources are touched. */
	readonly ownerId: OwnerId;
	readonly action: string;
	readonly resource?: Readonly<Record<string, string>>;
}

/** Permission and approval are separate answers: `allow` may still need a person. */
export type AuthzDecision =
	| { readonly outcome: "allow"; readonly viaStandingApproval?: string }
	| { readonly outcome: "approval_required"; readonly approvalKey: string };

/**
 * The one authorizer every workstream calls. It throws `ForbiddenError` when the principal lacks permission,
 * `CapabilityUnavailableError` when the capability is absent, and returns `approval_required` when a person
 * must still decide. It decides on `effectivePrincipal(request.principal)`.
 */
export interface Authorizer {
	authorize(request: AuthzRequest): Promise<AuthzDecision>;
}

export type AuthzErrorCode = "forbidden" | "capability_unavailable" | "approval_required";

/** The principal may not do this, whatever a person says. */
export class ForbiddenError extends Error {
	readonly code = "forbidden" as const;
	constructor(
		readonly action: string,
		readonly reason: string,
	) {
		super(`Not permitted: ${action} (${reason})`);
		this.name = "ForbiddenError";
	}
}

/** The principal may, but nothing exists to do it with, such as no personal computer or no coding pool. */
export class CapabilityUnavailableError extends Error {
	readonly code = "capability_unavailable" as const;
	constructor(
		readonly capability: string,
		readonly reason: string,
	) {
		super(`Unavailable: ${capability} (${reason})`);
		this.name = "CapabilityUnavailableError";
	}
}

/** Permitted, but a person must approve first. */
export class ApprovalRequiredError extends Error {
	readonly code = "approval_required" as const;
	constructor(
		readonly action: string,
		readonly approvalKey: string,
	) {
		super(`Approval required: ${action}`);
		this.name = "ApprovalRequiredError";
	}
}

export type AuthzError = ForbiddenError | CapabilityUnavailableError | ApprovalRequiredError;

/** Whether a repository (`host/owner/name`) is covered by an allowlist whose entries may end in `/*`. */
export function repositoryAllowed(allowlist: readonly string[], repository: string): boolean {
	return allowlist.some((entry) => (entry.endsWith("/*") ? repository.startsWith(entry.slice(0, -1)) : entry === repository));
}

/** Whether a standing approval covers an action at a time: not revoked, not expired, and every scope key matching. */
export function standingApprovalCovers(approval: StandingApproval, action: string, resource: Readonly<Record<string, string>>, now: Date): boolean {
	if (approval.revokedAt || approval.action !== action) return false;
	if (approval.expiresAt && Date.parse(approval.expiresAt) <= now.getTime()) return false;
	return Object.entries(approval.scope).every(([key, value]) => resource[key] === value);
}
