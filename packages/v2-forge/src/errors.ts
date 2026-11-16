// What Forge refuses with, in the codes Pim's coding API already has (src/coding/api.ts), plus the two the authorization overhaul separates.

export type ForgeErrorCode =
	| "invalid"
	| "unsupported"
	| "forbidden"
	| "unavailable"
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
	unavailable: 503,
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

/** The person (or the agent acting for them) lacks a coding grant or a repository's permission: 403. */
export class ForbiddenError extends ForgeError {
	constructor(message: string) {
		super("forbidden", message);
		this.name = "ForbiddenError";
	}
}

/** The deployment has no coding pool or Amp credential configured: 503, while normal Pim keeps working. */
export class CapabilityUnavailableError extends ForgeError {
	constructor(message: string) {
		super("unavailable", message);
		this.name = "CapabilityUnavailableError";
	}
}

/** Another worker holds the thread's lease at a newer epoch; this worker must stop stepping it. */
export class LeaseLostError extends ForgeError {
	constructor(threadId: string) {
		super("lease_lost", `This worker no longer holds the lease on coding thread ${threadId}`);
		this.name = "LeaseLostError";
	}
}
