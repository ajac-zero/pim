import type { Principal } from "@pim/v2-contracts/identity";
import { type ExternalOperationRecord, type ExternalOperationState, operationSettled } from "@pim/v2-contracts/runtime-seam";
import { ConflictError, NotFoundError } from "./errors.ts";
import { Authorizer } from "./authz.ts";
import type { Db, Tx } from "./db.ts";
import { newId } from "./ids.ts";

/**
 * Durable tool operations (what the Tools worker keeps), as the contracts' `ExternalOperationRecord`. An operation that may have had an effect
 * outside Pim and whose outcome is unknown is never run again by the system: a call whose provider does not honour its idempotency key (a plain
 * HTTP POST, a purchase, a message) goes to `needs_reconciliation` and waits for a person or the provider's own answer. One whose provider does
 * honour the key may be retried with that same key.
 */
export class Operations {
	constructor(private readonly db: Db, private readonly authz = new Authorizer(db)) {}

	async create(p: Principal, input: { partitionId: string; taskId: string; toolName: string; capability: string; idempotent: boolean; deadlineMs?: number; now?: Date }): Promise<ExternalOperationRecord> {
		await this.authz.enforce(p, "api:write");
		const operationId = newId("op");
		const now = input.now ?? new Date();
		await this.db.owner(p.ownerId, (tx) =>
			tx.query("INSERT INTO pim_app.external_operations (operation_id, owner_id, partition_id, task_id, tool_name, capability, idempotency_key, idempotent, deadline_at) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)", [
				operationId, p.ownerId, input.partitionId, input.taskId, input.toolName, input.capability, `pim-${operationId}`, input.idempotent, input.deadlineMs ? new Date(now.getTime() + input.deadlineMs) : null,
			]),
		);
		return (await this.get(p.ownerId, operationId))!;
	}

	async get(ownerId: string, operationId: string): Promise<(ExternalOperationRecord & { idempotent: boolean; attempts: number }) | null> {
		return this.db.owner(ownerId, async (tx) => {
			const r = (await tx.query("SELECT * FROM pim_app.external_operations WHERE operation_id = $1", [operationId])).rows[0];
			return r ? { operationId: r.operation_id, ownerId: r.owner_id, partitionId: r.partition_id, taskId: r.task_id, toolName: r.tool_name, capability: r.capability, idempotencyKey: r.idempotency_key, state: r.state, receipt: r.receipt, earlySignal: r.early_signal, idempotent: r.idempotent, attempts: r.attempts } : null;
		});
	}

	async #transition(ownerId: string, id: string, from: ExternalOperationState[], to: ExternalOperationState, extra: { receipt?: unknown; error?: string; bump?: boolean } = {}): Promise<void> {
		const n = await this.db.owner(ownerId, async (tx) =>
			(await tx.query("UPDATE pim_app.external_operations SET state = $3, receipt = coalesce($4, receipt), error = coalesce($5, error), attempts = attempts + $6, updated_at = now() WHERE operation_id = $1 AND state = ANY($2)", [id, from, to, extra.receipt === undefined ? null : JSON.stringify(extra.receipt), extra.error ?? null, extra.bump ? 1 : 0])).rowCount,
		);
		if (!n) {
			const cur = await this.get(ownerId, id);
			throw cur ? new ConflictError(`An operation that is ${cur.state} cannot become ${to}`, "bad_operation_state") : new NotFoundError("No such operation");
		}
	}

	start(ownerId: string, id: string) {
		return this.#transition(ownerId, id, ["pending"], "running", { bump: true });
	}
	complete(ownerId: string, id: string, receipt: unknown) {
		return this.#transition(ownerId, id, ["running", "needs_reconciliation", "cancel_requested", "cancel_uncertain"], "completed", { receipt: receipt ?? {} });
	}
	fail(ownerId: string, id: string, error: string) {
		return this.#transition(ownerId, id, ["running", "pending", "needs_reconciliation", "cancel_uncertain"], "failed", { error });
	}

	/** Retrying is allowed only when the provider honours the idempotency key and nothing awaits reconciliation; it reuses the key. */
	async retry(ownerId: string, id: string): Promise<{ idempotencyKey: string }> {
		const op = await this.get(ownerId, id);
		if (!op) throw new NotFoundError("No such operation");
		if (!op.idempotent) throw new ConflictError("This operation has outside effects and cannot be retried blind; reconcile it", "retry_unsafe");
		if (operationSettled(op.state)) throw new ConflictError(`It is already ${op.state}`, "bad_operation_state");
		await this.#transition(ownerId, id, ["running", "pending", "failed"], "pending");
		return { idempotencyKey: op.idempotencyKey };
	}

	/** Operations still running past their deadline: idempotent ones go back to pending, the rest wait for reconciliation. */
	async sweep(ownerId: string, now: Date): Promise<{ requeued: number; needsReconciliation: number }> {
		return this.db.owner(ownerId, async (tx) => {
			const a = await tx.query("UPDATE pim_app.external_operations SET state = 'pending', updated_at = $1 WHERE state = 'running' AND idempotent AND deadline_at <= $1", [now]);
			const b = await tx.query("UPDATE pim_app.external_operations SET state = 'needs_reconciliation', updated_at = $1 WHERE state = 'running' AND NOT idempotent AND deadline_at <= $1", [now]);
			return { requeued: a.rowCount ?? 0, needsReconciliation: b.rowCount ?? 0 };
		});
	}

	/** Cancellation is a request until the provider confirms (`cancelled`); if the provider cannot say, it is `cancel_uncertain` and a person reconciles it. */
	async cancel(ownerId: string, id: string, outcome: "requested" | "confirmed" | "uncertain"): Promise<void> {
		const to: ExternalOperationState = outcome === "requested" ? "cancel_requested" : outcome === "confirmed" ? "cancelled" : "cancel_uncertain";
		await this.#transition(ownerId, id, ["pending", "running", "cancel_requested", "needs_reconciliation"], to).catch((error) => {
			if (error instanceof ConflictError) throw new ConflictError("Only an operation still in flight can be canceled", "bad_operation_state");
			throw error;
		});
	}

	/** A decision or result that arrived before the task parked is kept and delivered when it does. */
	async recordEarlySignal(ownerId: string, id: string, signal: Record<string, unknown>): Promise<void> {
		await this.db.owner(ownerId, (tx) => tx.query("UPDATE pim_app.external_operations SET early_signal = $2 WHERE operation_id = $1", [id, JSON.stringify(signal)]));
	}
}

/** Human approvals. A standing approval (an auditable record) stands in for the person; without one a gated call files an approval and waits. */
export class Approvals {
	constructor(private readonly db: Db, private readonly authz = new Authorizer(db)) {}

	/** Authorizes `action`. Returns "allowed" (with the standing approval that covered it, if any), or the id of a waiting approval a person must decide. */
	async gate(p: Principal, input: { action: string; resource?: Record<string, string>; chatId?: string; args?: object; timeoutMs?: number; onTimeout?: "deny" | "approve"; explicit?: boolean; now?: Date }): Promise<{ outcome: "allowed"; viaStandingApproval?: string } | { outcome: "waiting"; approvalId: string }> {
		const decision = await this.authz.authorize({ principal: p, ownerId: p.ownerId, action: input.action, ...(input.resource ? { resource: input.resource } : {}) });
		if (decision.outcome === "allow") return { outcome: "allowed", ...(decision.viaStandingApproval ? { viaStandingApproval: decision.viaStandingApproval } : {}) };
		const id = newId("ap");
		const now = input.now ?? new Date();
		// The person's approval policy. `auto` approves what is not answered within the timeout (30 seconds unless they set another); `majordomo` has the majordomo review it
		// (`reviewApprovals`, in the Runner). An explicit action, one a person must always answer for (a tool its connector marks destructive), ignores both.
		const settings = new Map((await this.db.owner(p.ownerId, async (tx) => (await tx.query("SELECT key, value FROM pim_app.owner_settings WHERE key IN ('settings.approvalPolicy', 'settings.approvalTimeoutSeconds')")).rows)).map((r) => [r.key as string, r.value as unknown]));
		const policy = (settings.get("settings.approvalPolicy") as string | undefined) ?? process.env.PIM_APPROVAL_POLICY ?? "majordomo";
		const auto = policy === "auto" && !input.explicit;
		const seconds = settings.get("settings.approvalTimeoutSeconds");
		const timeoutMs = auto ? (typeof seconds === "number" && seconds > 0 ? seconds : 30) * 1000 : input.timeoutMs;
		await this.db.owner(p.ownerId, (tx) =>
			tx.query("INSERT INTO pim_app.approvals (id, owner_id, public_chat_id, tool, args, timeout_policy, expires_at) VALUES ($1,$2,$3,$4,$5,$6,$7)", [id, p.ownerId, input.chatId ?? null, input.action, JSON.stringify({ ...input.args, resource: input.resource ?? {}, ...(input.explicit ? { explicit: true } : {}) }), auto ? "approve" : (input.onTimeout ?? "deny"), timeoutMs ? new Date(now.getTime() + timeoutMs) : null]),
		);
		return { outcome: "waiting", approvalId: id };
	}

	/** The majordomo's answer to an approval it reviewed: approved or denied, recorded as its own decision, or handed back to the person (`escalate`), who then answers as usual. */
	async review(ownerId: string, approvalId: string, outcome: "approve" | "deny" | "escalate", note: string): Promise<boolean> {
		return this.db.owner(ownerId, async (tx) => {
			const review = JSON.stringify({ review: { status: outcome === "escalate" ? "escalated" : "decided", note: note.slice(0, 1000), at: new Date().toISOString() } });
			if (outcome === "escalate") return ((await tx.query("UPDATE pim_app.approvals SET args = args || $2::jsonb WHERE id = $1 AND state = 'waiting'", [approvalId, review])).rowCount ?? 0) > 0;
			return ((await tx.query("UPDATE pim_app.approvals SET state = $2, decided_by = 'majordomo', decided_at = now(), args = args || $3::jsonb WHERE id = $1 AND state = 'waiting'", [approvalId, outcome === "approve" ? "approved" : "denied", review])).rowCount ?? 0) > 0;
		});
	}

	/** A person decides, and may leave a note the agent reads with the decision. An agent cannot approve its own request. A late decision after a timeout is a conflict. */
	async decide(p: Principal, approvalId: string, approve: boolean, note?: string): Promise<void> {
		await this.authz.enforce(p, "approval:decide");
		const by = p.kind === "user" ? p.sessionId : p.kind === "token" ? p.tokenId : p.kind;
		const n = await this.db.owner(p.ownerId, async (tx) =>
			(await tx.query("UPDATE pim_app.approvals SET state = $2, decided_by = $3, decided_at = now(), args = args || $4::jsonb WHERE id = $1 AND state = 'waiting'", [approvalId, approve ? "approved" : "denied", `${p.kind}:${by}`, JSON.stringify(note?.trim() ? { note: note.trim().slice(0, 1000) } : {})])).rowCount,
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

