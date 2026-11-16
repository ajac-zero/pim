// What Forge refuses with, in the codes Pim's coding API already has (src/coding/api.ts), plus the two the authorization overhaul separates.

export type ForgeErrorCode =
	| "invalid"
	| "unsupported"
	| "forbidden"
	| "not_found"
	| "archived"
	| "budget_spent"
	| "quota"
	| "not_cancellable"
	| "workspace_not_running"
	| "nothing_to_push"
	| "push_refused"
	| "not_pushed"
	| "approval_required"
	| "conflict"
	| "lease_lost";

const STATUS: Record<ForgeErrorCode, number> = {
	invalid: 400,
	unsupported: 400,
	forbidden: 403,
	not_found: 404,
	archived: 409,
	budget_spent: 409,
	quota: 429,
	not_cancellable: 409,
	workspace_not_running: 409,
	nothing_to_push: 409,
	push_refused: 403,
	not_pushed: 409,
	approval_required: 202,
	conflict: 409,
	lease_lost: 409,
};

export class ForgeError extends Error {
	readonly status: number;
	constructor(
		readonly code: ForgeErrorCode,
		message: string,
	) {
		super(message);
		this.name = "ForgeError";
		this.status = STATUS[code];
	}
}

/** The contracts' errors: a missing grant or repository permission is 403, a deployment with no coding pool or Amp credential is 503. */
export { CapabilityUnavailableError, ForbiddenError, ApprovalRequiredError } from "@pim/v2-contracts/authz";

/** The HTTP status an error answers with. */
export function httpStatus(error: unknown): number {
	if (error instanceof ForgeError) return error.status;
	const code = (error as { code?: string } | null)?.code;
	return code === "forbidden" ? 403 : code === "capability_unavailable" ? 503 : code === "approval_required" ? 202 : 500;
}

/** Another worker holds the thread's lease at a newer epoch; this worker must stop stepping it. */
export class LeaseLostError extends ForgeError {
	constructor(threadId: string) {
		super("lease_lost", `This worker no longer holds the lease on coding thread ${threadId}`);
		this.name = "LeaseLostError";
	}
}
