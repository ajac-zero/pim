import { ApprovalRequiredError, ConflictError, NotFoundError } from "./errors.ts";
import { Authorizer } from "./authz.ts";
import type { Db } from "./db.ts";
import { newId } from "./ids.ts";
import type { Principal } from "./principal.ts";

export type OperationState = "pending" | "running" | "completed" | "failed" | "needs_reconciliation";

/**
 * Durable tool operations (what the Tools worker keeps). An operation that may have had an effect outside Pim and whose outcome is
 * unknown is never run again by the system: a non-idempotent HTTP call, purchase or message goes to `needs_reconciliation` and waits for
 * a person or the provider's own answer. Idempotent ones carry a provider idempotency key and may be retried with it.
 */
export class Operations {
	constructor(private readonly db: Db, private readonly authz = new Authorizer(db)) {}

	async create(p: Principal, input: { tool: string; idempotent: boolean; deadlineMs?: number; now?: Date }): Promise<{ id: string; providerKey: string | null }> {
		await this.authz.authorize(p, "api:write");
		const id = newId("op");
		const providerKey = input.idempotent ? `pim-${id}` : null;
		const now = input.now ?? new Date();
		await this.db.owner(p.ownerId, (tx) =>
			tx.query("INSERT INTO pim_app.external_operations (id, owner_id, tool, idempotent, provider_idempotency_key, deadline_at) VALUES ($1,$2,$3,$4,$5,$6)", [id, p.ownerId, input.tool, input.idempotent, providerKey, input.deadlineMs ? new Date(now.getTime() + input.deadlineMs) : null]),
		);
		return { id, providerKey };
	}

	async #transition(ownerId: string, id: string, from: OperationState[], to: OperationState, extra: { result?: unknown; error?: string; bump?: boolean } = {}): Promise<void> {
		const n = await this.db.owner(ownerId, async (tx) =>
			(await tx.query("UPDATE pim_app.external_operations SET state = $3, result = coalesce($4, result), error = coalesce($5, error), attempts = attempts + $6, updated_at = now() WHERE id = $1 AND state = ANY($2)", [id, from, to, extra.result === undefined ? null : JSON.stringify(extra.result), extra.error ?? null, extra.bump ? 1 : 0])).rowCount,
		);
		if (!n) {
			const cur = await this.state(ownerId, id);
			throw cur ? new ConflictError(`An operation that is ${cur.state} cannot become ${to}`, "bad_operation_state") : new NotFoundError("No such operation");
		}
	}

	start(ownerId: string, id: string) {
		return this.#transition(ownerId, id, ["pending"], "running", { bump: true });
	}
	complete(ownerId: string, id: string, result: unknown) {
		return this.#transition(ownerId, id, ["running", "needs_reconciliation"], "completed", { result: result ?? {} });
	}
	fail(ownerId: string, id: string, error: string) {
		return this.#transition(ownerId, id, ["running", "pending", "needs_reconciliation"], "failed", { error });
	}

	/** Retrying is allowed only for an idempotent operation that is not waiting on reconciliation; it reuses the provider key. */
	async retry(ownerId: string, id: string): Promise<{ providerKey: string }> {
		const op = await this.state(ownerId, id);
		if (!op) throw new NotFoundError("No such operation");
		if (!op.idempotent || !op.providerKey) throw new ConflictError("This operation has outside effects and cannot be retried blind; reconcile it", "retry_unsafe");
		if (op.state === "completed") throw new ConflictError("It already completed", "bad_operation_state");
		await this.#transition(ownerId, id, ["running", "failed", "pending"], "pending");
		return { providerKey: op.providerKey };
	}

	/** Operations still running past their deadline: idempotent ones go back to pending, the rest wait for reconciliation. */
	async sweep(ownerId: string, now: Date): Promise<{ requeued: number; needsReconciliation: number }> {
		return this.db.owner(ownerId, async (tx) => {
			const a = await tx.query("UPDATE pim_app.external_operations SET state = 'pending', updated_at = $1 WHERE state = 'running' AND idempotent AND deadline_at <= $1", [now]);
			const b = await tx.query("UPDATE pim_app.external_operations SET state = 'needs_reconciliation', updated_at = $1 WHERE state = 'running' AND NOT idempotent AND deadline_at <= $1", [now]);
			return { requeued: a.rowCount ?? 0, needsReconciliation: b.rowCount ?? 0 };
		});
	}

	/** Cancellation is a request until the provider confirms; if the provider cannot say, the outcome is uncertain and a person reconciles it. */
	async cancel(ownerId: string, id: string, outcome: "requested" | "confirmed" | "uncertain"): Promise<void> {
		await this.db.owner(ownerId, async (tx) => {
			const state = outcome === "confirmed" ? "failed" : outcome === "uncertain" ? "needs_reconciliation" : null;
			const n = await tx.query("UPDATE pim_app.external_operations SET cancellation = $2, state = coalesce($3, state), error = CASE WHEN $2 = 'confirmed' THEN 'canceled' ELSE error END, updated_at = now() WHERE id = $1 AND state IN ('pending', 'running', 'needs_reconciliation')", [id, outcome, state]);
			if (!n.rowCount) throw new ConflictError("Only an operation still in flight can be canceled", "bad_operation_state");
		});
	}

	async state(ownerId: string, id: string) {
		return this.db.owner(ownerId, async (tx) => {
			const { rows } = await tx.query("SELECT state, idempotent, provider_idempotency_key, attempts, cancellation FROM pim_app.external_operations WHERE id = $1", [id]);
			const r = rows[0];
			return r ? { state: r.state as OperationState, idempotent: r.idempotent as boolean, providerKey: r.provider_idempotency_key as string | null, attempts: r.attempts as number, cancellation: r.cancellation as string | null } : null;
		});
	}
}

/** Human approvals. A standing grant (an auditable record) can stand in for the human; without one a gated call files an approval and waits. */
export class Approvals {
	constructor(private readonly db: Db, private readonly authz = new Authorizer(db)) {}

	/** Authorizes `action` for the principal. Returns "allowed" under a standing grant, or the id of a waiting approval a person must decide. */
	async gate(p: Principal, input: { action: string; resource?: string; chatId?: string; args?: object; timeoutMs?: number; onTimeout?: "deny" | "approve"; now?: Date }): Promise<{ outcome: "allowed" } | { outcome: "waiting"; approvalId: string }> {
		try {
			await this.authz.authorize(p, input.action, input.resource);
			return { outcome: "allowed" };
		} catch (error) {
			if (!(error instanceof ApprovalRequiredError)) throw error;
		}
		const id = newId("ap");
		const now = input.now ?? new Date();
		await this.db.owner(p.ownerId, (tx) =>
			tx.query("INSERT INTO pim_app.approvals (id, owner_id, public_chat_id, tool, args, timeout_policy, expires_at) VALUES ($1,$2,$3,$4,$5,$6,$7)", [id, p.ownerId, input.chatId ?? null, input.action, JSON.stringify(input.args ?? {}), input.onTimeout ?? "deny", input.timeoutMs ? new Date(now.getTime() + input.timeoutMs) : null]),
		);
		return { outcome: "waiting", approvalId: id };
	}

	/** A person decides. Only a session can: a token or agent cannot approve its own request. A late decision after a timeout is a conflict. */
	async decide(p: Principal, approvalId: string, approve: boolean): Promise<void> {
		await this.authz.authorize(p, "approval:decide");
		const n = await this.db.owner(p.ownerId, async (tx) =>
			(await tx.query("UPDATE pim_app.approvals SET state = $2, decided_by = $3, decided_at = now() WHERE id = $1 AND state = 'waiting'", [approvalId, approve ? "approved" : "denied", `${p.kind}:${p.subject}`])).rowCount,
		);
		if (!n) throw new ConflictError("That approval is not waiting", "approval_closed");
	}

	/** Applies timeout policies. `approve` only ever turns a still-waiting call into approved; `deny` is the default. */
	async sweep(ownerId: string, now: Date): Promise<{ denied: number; approved: number }> {
		return this.db.owner(ownerId, async (tx) => {
			const denied = await tx.query("UPDATE pim_app.approvals SET state = 'timed_out_denied', decided_at = $1 WHERE state = 'waiting' AND timeout_policy = 'deny' AND expires_at <= $1", [now]);
			const approved = await tx.query("UPDATE pim_app.approvals SET state = 'timed_out_approved', decided_at = $1 WHERE state = 'waiting' AND timeout_policy = 'approve' AND expires_at <= $1", [now]);
			return { denied: denied.rowCount ?? 0, approved: approved.rowCount ?? 0 };
		});
	}

	async state(ownerId: string, id: string): Promise<string | null> {
		return this.db.owner(ownerId, async (tx) => (await tx.query("SELECT state FROM pim_app.approvals WHERE id = $1", [id])).rows[0]?.state ?? null);
	}
}
