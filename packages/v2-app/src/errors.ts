import { ApprovalRequiredError, CapabilityUnavailableError, ForbiddenError } from "@pim/v2-contracts/authz";

export { ApprovalRequiredError, CapabilityUnavailableError, ForbiddenError };

/** The HTTP status of an error services throw: the contracts' authorization errors and the typed errors below. Anything else is a 500. */
export function httpStatus(error: unknown): { status: number; code: string } | null {
	if (error instanceof PimError) return { status: error.status, code: error.code };
	if (error instanceof ForbiddenError) return { status: 403, code: error.reason };
	if (error instanceof ApprovalRequiredError) return { status: 403, code: "approval_required" };
	if (error instanceof CapabilityUnavailableError) return { status: 501, code: "capability_unavailable" };
	return null;
}
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
/** A rule of the product refuses this (registration closed, last admin, an invalid claim): 403 with a code tests and clients can match. */
export class RefusedError extends PimError {
	constructor(message: string, code: string) {
		super(403, code, message);
	}
}
export class GoneError extends PimError {
	constructor(message = "This account has been deleted") {
		super(410, "gone", message);
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
