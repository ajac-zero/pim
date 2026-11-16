import type { IncomingMessage } from "node:http";
import type { Pool } from "pg";

/** Who a WebSocket is: set once when it authenticates, checked again on a schedule and on revocation. */
export type Identity = { tenantId: string; userId: string; sessionId: string };

/**
 * The shared Authorizer's part in Live. NATS subject names are never authorization: a subscription is
 * allowed only because this says so, and every PostgreSQL read is bound to `identity.tenantId`.
 */
export interface Authorizer {
	/** The identity of a connection request (cookie or token), or null when it has none. */
	authenticate(request: IncomingMessage): Promise<Identity | null>;
	/** Whether the identity is still allowed: its session is not revoked or expired and its account is neither suspended nor deleted. */
	validate(identity: Identity): Promise<boolean>;
	/** Whether the identity may follow a stream (a shared chat, a guest's view). The tenant check is the floor. */
	canSubscribe(identity: Identity, streamKey: string): Promise<boolean>;
}

/**
 * The PostgreSQL tenant check, over the identity schema's accounts and sessions:
 * `pim_identity.sessions(session_id, tenant_id, user_id, revoked_at, expires_at)` and
 * `pim_identity.accounts(tenant_id, status)`.
 */
export class PgAuthorizer implements Authorizer {
	readonly #pool: Pool;
	readonly #sessionOf: (request: IncomingMessage) => string | null;

	constructor(pool: Pool, sessionOf: (request: IncomingMessage) => string | null) {
		this.#pool = pool;
		this.#sessionOf = sessionOf;
	}

	async authenticate(request: IncomingMessage): Promise<Identity | null> {
		const sessionId = this.#sessionOf(request);
		if (!sessionId) return null;
		const identity = await this.#lookup(sessionId);
		return identity && (await this.validate(identity)) ? identity : null;
	}

	async #lookup(sessionId: string): Promise<Identity | null> {
		const { rows } = await this.#pool.query<{ tenant_id: string; user_id: string }>("SELECT tenant_id, user_id FROM pim_identity.sessions WHERE session_id = $1", [sessionId]);
		return rows[0] ? { tenantId: rows[0].tenant_id, userId: rows[0].user_id, sessionId } : null;
	}

	async validate(identity: Identity): Promise<boolean> {
		const { rows } = await this.#pool.query(
			`SELECT 1 FROM pim_identity.sessions s JOIN pim_identity.accounts a ON a.tenant_id = s.tenant_id
			 WHERE s.session_id = $1 AND s.tenant_id = $2 AND s.revoked_at IS NULL AND (s.expires_at IS NULL OR s.expires_at > now()) AND a.status = 'active'`,
			[identity.sessionId, identity.tenantId],
		);
		return rows.length > 0;
	}

	async canSubscribe(identity: Identity, _streamKey: string): Promise<boolean> {
		return this.validate(identity);
	}
}
