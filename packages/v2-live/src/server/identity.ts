import type { IncomingMessage } from "node:http";
import type { Principal } from "@pim/v2-contracts/identity";

/**
 * How Live learns who a connection is. Gate owns sessions and tokens; Live only needs two answers from it.
 * What a principal may follow is decided by the canonical `Authorizer`, not here.
 */
export interface LiveIdentity {
	/** The principal of a connection request (cookie or token), or null when it has none. */
	authenticate(request: IncomingMessage): Promise<Principal | null>;
	/** Whether the principal is still allowed to hold a connection: its session or token is not revoked or expired and its account is neither suspended nor deleted. */
	stillValid(principal: Principal): Promise<boolean>;
}

/** The id Live knows a connection's session by, for revocation: a user's session, a token's id, otherwise the owner. */
export function sessionKey(principal: Principal): string | undefined {
	return principal.kind === "user" ? principal.sessionId : principal.kind === "token" ? principal.tokenId : undefined;
}
