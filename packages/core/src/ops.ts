import type pg from "pg";
import { type Q, withTenant } from "./db.ts";
import type { Lease } from "./partitions.ts";

/**
 * Cross-domain external operations: intent -> effect -> result.
 *
 * - The intent is committed before anything leaves the system, under a stable operation id that is also the
 *   idempotency key the other side sees.
 * - Moving to `effecting` re-checks, in the same transaction, that the owner's lease is still live and that the
 *   capability (an execution grant) has not been revoked: a stale owner or a revoked grant cannot start an effect.
 * - An external handle (a remote coding session, a payment id) is persisted before control is relinquished.
 * - A crash while `effecting` is resolved on restart: an operation with a handle is adopted, an idempotent one is
 *   re-sent under the same key, and a non-idempotent one with neither becomes `reconciliation_needed`. Nothing
 *   non-idempotent is ever sent twice.
 */
export type OpState = "intent" | "effecting" | "succeeded" | "failed" | "reconciliation_needed" | "cancel_requested" | "cancelled" | "cancel_uncertain";

export interface OpSpec {
	tenantId: string;
	opId: string;
	kind: string;
	partitionId?: string;
	idempotent: boolean;
	request: Record<string, unknown>;
	/** The execution grant that authorizes it, revalidated when the effect starts. */
	grantId?: string;
}

export interface OpRecord {
	op_id: string;
	state: OpState;
	idempotent: boolean;
	grant_id: string | null;
	handle: Record<string, unknown> | null;
	receipt: Record<string, unknown> | null;
	attempts: number;
	request: Record<string, unknown>;
}

/** The effect definitely did not happen. */
export class EffectFailed extends Error {}

export interface OpDeps {
	pool: pg.Pool;
	/** The owner's live lease check, `PartitionHost.mayDispatch`. */
	lease?: Lease;
}

const terminal = new Set<OpState>(["succeeded", "failed", "cancelled"]);

export async function beginOp(q: Q, spec: OpSpec): Promise<OpRecord> {
	await q.run(
		"INSERT INTO app.external_ops (tenant_id, op_id, kind, partition_id, idempotent, grant_id, request) VALUES ($1, $2, $3, $4, $5, $6, $7) ON CONFLICT DO NOTHING",
		spec.tenantId,
		spec.opId,
		spec.kind,
		spec.partitionId ?? null,
		spec.idempotent,
		spec.grantId ?? null,
		JSON.stringify(spec.request),
	);
	return (await q.get<OpRecord>("SELECT op_id, state, idempotent, grant_id, handle, receipt, attempts, request FROM app.external_ops WHERE tenant_id = $1 AND op_id = $2", spec.tenantId, spec.opId))!;
}

export async function getOp(pool: pg.Pool, tenantId: string, opId: string): Promise<OpRecord | undefined> {
	return withTenant(pool, tenantId, (q) => q.get<OpRecord>("SELECT op_id, state, idempotent, grant_id, handle, receipt, attempts, request FROM app.external_ops WHERE tenant_id = $1 AND op_id = $2", tenantId, opId), { readOnly: true });
}

/**
 * Moves intent (or a crashed `effecting`) to `effecting` if the owner and the capability are still current.
 * Returns what the caller may do next.
 */
async function startEffect(deps: OpDeps, spec: OpSpec): Promise<{ action: "send" | "adopt" | "reconcile" | "denied" | "done"; op: OpRecord }> {
	return withTenant(deps.pool, spec.tenantId, async (q) => {
		const op = await beginOp(q, spec);
		if (terminal.has(op.state)) return { action: "done" as const, op };
		if (op.state === "reconciliation_needed" || op.state === "cancel_uncertain") return { action: "reconcile" as const, op };
		if (deps.lease !== undefined) {
			const live = await q.get("SELECT 1 FROM rt.partitions WHERE partition_id = $1 AND owner_id = $2 AND epoch = $3 AND lease_until > clock_timestamp() + interval '500 milliseconds'", deps.lease.partitionId, deps.lease.ownerId, deps.lease.epoch);
			if (live === undefined) throw new Error("Ownership lost: the effect was not started");
		}
		if (op.grant_id !== null) {
			const grant = await q.get("SELECT 1 FROM app.execution_grants WHERE tenant_id = $1 AND grant_id = $2 AND revoked_at IS NULL AND (expires_at IS NULL OR expires_at > now())", spec.tenantId, op.grant_id);
			if (grant === undefined) {
				await q.run("UPDATE app.external_ops SET state = 'failed', receipt = $3, updated_at = now() WHERE tenant_id = $1 AND op_id = $2", spec.tenantId, spec.opId, JSON.stringify({ denied: "grant_revoked_or_expired" }));
				return { action: "denied" as const, op: { ...op, state: "failed" as const, receipt: { denied: "grant_revoked_or_expired" } } };
			}
		}
		if (op.state === "effecting") {
			// A previous attempt died somewhere between sending and recording the result.
			if (op.handle !== null) return { action: "adopt" as const, op };
			if (!op.idempotent) {
				await q.run("UPDATE app.external_ops SET state = 'reconciliation_needed', updated_at = now() WHERE tenant_id = $1 AND op_id = $2", spec.tenantId, spec.opId);
				return { action: "reconcile" as const, op: { ...op, state: "reconciliation_needed" as const } };
			}
		}
		await q.run("UPDATE app.external_ops SET state = 'effecting', fence_epoch = $3, attempts = attempts + 1, updated_at = now() WHERE tenant_id = $1 AND op_id = $2", spec.tenantId, spec.opId, deps.lease?.epoch ?? null);
		return { action: "send" as const, op: { ...op, state: "effecting" as const } };
	});
}

export async function recordHandle(pool: pg.Pool, tenantId: string, opId: string, handle: Record<string, unknown>): Promise<void> {
	await withTenant(pool, tenantId, (q) => q.run("UPDATE app.external_ops SET handle = $3, updated_at = now() WHERE tenant_id = $1 AND op_id = $2 AND state IN ('effecting', 'cancel_requested')", tenantId, opId, JSON.stringify(handle)));
}

async function finish(pool: pg.Pool, tenantId: string, opId: string, state: OpState, receipt: Record<string, unknown> | null): Promise<void> {
	await withTenant(pool, tenantId, (q) => q.run("UPDATE app.external_ops SET state = $3, receipt = COALESCE($4::jsonb, receipt), updated_at = now() WHERE tenant_id = $1 AND op_id = $2 AND state NOT IN ('succeeded', 'failed', 'cancelled')", tenantId, opId, state, receipt === null ? null : JSON.stringify(receipt)));
}

export interface Effector {
	/** Performs the effect. `key` is the operation id: send it as the idempotency key. May return a handle to persist at once. */
	send(key: string, request: Record<string, unknown>, recordHandle: (handle: Record<string, unknown>) => Promise<void>): Promise<Record<string, unknown>>;
	/** Looks a remote operation up by its persisted handle, to adopt it instead of starting another. */
	adopt?(handle: Record<string, unknown>): Promise<{ state: "running" | "succeeded" | "failed"; receipt?: Record<string, unknown> }>;
}

/** Runs one external operation to a result, or to the honest state that it cannot be known. */
export async function runOp(deps: OpDeps, spec: OpSpec, effector: Effector): Promise<{ state: OpState; receipt: Record<string, unknown> | null; handle: Record<string, unknown> | null }> {
	const started = await startEffect(deps, spec);
	const { tenantId, opId } = spec;
	if (started.action === "done" || started.action === "denied" || started.action === "reconcile") return { state: started.op.state, receipt: started.op.receipt, handle: started.op.handle };
	try {
		if (started.action === "adopt") {
			if (effector.adopt === undefined) {
				await finish(deps.pool, tenantId, opId, "reconciliation_needed", null);
				return { state: "reconciliation_needed", receipt: null, handle: started.op.handle };
			}
			const remote = await effector.adopt(started.op.handle!);
			if (remote.state === "running") return { state: "effecting", receipt: null, handle: started.op.handle };
			const state = remote.state === "succeeded" ? "succeeded" : "failed";
			await finish(deps.pool, tenantId, opId, state, remote.receipt ?? {});
			return { state, receipt: remote.receipt ?? {}, handle: started.op.handle };
		}
		let handle: Record<string, unknown> | null = null;
		const receipt = await effector.send(opId, started.op.request, async (h) => {
			handle = h;
			await recordHandle(deps.pool, tenantId, opId, h);
		});
		await finish(deps.pool, tenantId, opId, "succeeded", receipt);
		return { state: "succeeded", receipt, handle };
	} catch (error) {
		if (error instanceof EffectFailed) {
			await finish(deps.pool, tenantId, opId, "failed", { error: error.message });
			return { state: "failed", receipt: { error: error.message }, handle: null };
		}
		// The effect may or may not have happened. An idempotent one stays `effecting` for a re-send under the same key;
		// a non-idempotent one is reconciliation-needed, never retried.
		const state: OpState = spec.idempotent ? "effecting" : "reconciliation_needed";
		if (state === "reconciliation_needed") await finish(deps.pool, tenantId, opId, state, { uncertain: String((error as Error).message) });
		return { state, receipt: null, handle: null };
	}
}

/** Cancellation is its own small state machine: requested, then confirmed by the other side or left uncertain. */
export async function requestCancel(pool: pg.Pool, tenantId: string, opId: string): Promise<OpState | undefined> {
	return withTenant(pool, tenantId, async (q) => {
		const row = await q.get<{ state: OpState }>(
			"UPDATE app.external_ops SET state = 'cancel_requested', updated_at = now() WHERE tenant_id = $1 AND op_id = $2 AND state IN ('intent', 'effecting', 'reconciliation_needed') RETURNING state",
			tenantId,
			opId,
		);
		if (row) return row.state;
		return (await q.get<{ state: OpState }>("SELECT state FROM app.external_ops WHERE tenant_id = $1 AND op_id = $2", tenantId, opId))?.state;
	});
}

export async function settleCancel(pool: pg.Pool, tenantId: string, opId: string, outcome: "confirmed" | "uncertain" | "too_late", receipt: Record<string, unknown> = {}): Promise<OpState | undefined> {
	const state: OpState = outcome === "confirmed" ? "cancelled" : outcome === "uncertain" ? "cancel_uncertain" : "succeeded";
	await withTenant(pool, tenantId, (q) => q.run("UPDATE app.external_ops SET state = $3, receipt = $4, updated_at = now() WHERE tenant_id = $1 AND op_id = $2 AND state = 'cancel_requested'", tenantId, opId, state, JSON.stringify(receipt)));
	return (await getOp(pool, tenantId, opId))?.state;
}

/** Operations a reconciler must look at: they are never retried blindly. */
export async function listUnresolved(pool: pg.Pool, tenantId: string): Promise<OpRecord[]> {
	return withTenant(pool, tenantId, (q) => q.all<OpRecord>("SELECT op_id, state, idempotent, grant_id, handle, receipt, attempts, request FROM app.external_ops WHERE tenant_id = $1 AND state IN ('intent', 'effecting', 'reconciliation_needed', 'cancel_requested', 'cancel_uncertain') ORDER BY created_at", tenantId), { readOnly: true });
}

/** An operator or a reconciler records what the other side says. */
export async function resolveOp(pool: pg.Pool, tenantId: string, opId: string, outcome: "succeeded" | "failed", receipt: Record<string, unknown>): Promise<void> {
	await withTenant(pool, tenantId, (q) => q.run("UPDATE app.external_ops SET state = $3, receipt = $4, updated_at = now() WHERE tenant_id = $1 AND op_id = $2 AND state IN ('reconciliation_needed', 'cancel_uncertain', 'effecting', 'cancel_requested')", tenantId, opId, outcome, JSON.stringify(receipt)));
}
