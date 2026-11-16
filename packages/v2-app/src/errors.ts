/** Errors the Gate maps to HTTP statuses. Services throw these; nothing else leaks a status code. */
export class PimError extends Error {
	constructor(
		readonly status: number,
		readonly code: string,
		message: string,
	) {
		super(message);
		this.name = new.target.name;
	}
}
export class UnauthorizedError extends PimError {
	constructor(message = "Sign in required") {
		super(401, "unauthorized", message);
	}
}
/** The caller is known but may not do this: a token scope, a suspended owner, a missing grant. */
export class ForbiddenError extends PimError {
	constructor(message = "Not allowed", code = "forbidden") {
		super(403, code, message);
	}
}
/** The owner is deleting or deleted: what they had is gone, and it stays gone for every surface. */
export class GoneError extends PimError {
	constructor(message = "This account has been deleted") {
		super(410, "gone", message);
	}
}
/** The action is allowed in principle but a human must approve this call. */
export class ApprovalRequiredError extends PimError {
	constructor(readonly action: string, message = `"${action}" needs approval`) {
		super(403, "approval_required", message);
	}
}
export class NotFoundError extends PimError {
	constructor(message = "Not found") {
		super(404, "not_found", message);
	}
}
export class ConflictError extends PimError {
	constructor(message: string, code = "conflict") {
		super(409, code, message);
	}
}
export class BadRequestError extends PimError {
	constructor(message: string) {
		super(400, "bad_request", message);
	}
}
/** A tool needs something this deployment has not configured (a personal computer, a coding pool, a connector). */
export class CapabilityUnavailableError extends PimError {
	constructor(readonly capability: string, message = `${capability} is not available here`) {
		super(501, "capability_unavailable", message);
	}
}
