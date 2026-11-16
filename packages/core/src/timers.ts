import type pg from "pg";
import { withTenant } from "./db.ts";
import { insertSignal } from "./commands.ts";

/**
 * Time-based work outside pi: approval expiry, review expiry, trigger ticks, scheduled pushes. One table, claimed
 * with SKIP LOCKED by any Runner or Steward, and firing writes the same durable signals as any other writer. It is a
 * table and a polling loop, not a workflow engine: a firing that is lost mid-way is claimed again after its claim expires.
 */
export async function scheduleTimer(q: { run(sql: string, ...p: unknown[]): Promise<number> }, input: { tenantId: string; kind: string; ref: string; partitionId?: string; dueInMs: number }): Promise<void> {
	await q.run(
		"INSERT INTO app.timers (tenant_id, kind, ref, partition_id, due_at) VALUES ($1, $2, $3, $4, clock_timestamp() + $5::interval) ON CONFLICT (tenant_id, kind, ref) DO UPDATE SET due_at = excluded.due_at, done_at = NULL, claimed_by = NULL",
		input.tenantId,
		input.kind,
		input.ref,
		input.partitionId ?? null,
		`${Math.trunc(input.dueInMs)} milliseconds`,
	);
}

export type TimerHandler = (timer: { tenantId: string; kind: string; ref: string; partitionId: string | null }, tx: { pool: pg.Pool }) => Promise<void>;

/** Claims due timers and runs their handlers. A handler is idempotent (it writes signals with stable operation ids). */
export async function runTimersOnce(steward: pg.Pool, handlers: Record<string, TimerHandler>, options: { ownerId: string; claimMs?: number; limit?: number }): Promise<number> {
	const claimed = await withTenant(steward, null, (q) =>
		q.all<{ timer_id: number; tenant_id: string; kind: string; ref: string; partition_id: string | null }>(
			`UPDATE app.timers SET claimed_by = $1, claim_until = clock_timestamp() + $2::interval
			 WHERE timer_id IN (SELECT timer_id FROM app.timers WHERE done_at IS NULL AND due_at <= clock_timestamp() AND (claim_until IS NULL OR claim_until < clock_timestamp()) ORDER BY due_at FOR UPDATE SKIP LOCKED LIMIT $3)
			 RETURNING timer_id, tenant_id, kind, ref, partition_id`,
			options.ownerId,
			`${options.claimMs ?? 30_000} milliseconds`,
			options.limit ?? 50,
		),
	);
	for (const timer of claimed) {
		const handler = handlers[timer.kind];
		if (!handler) continue;
		await handler({ tenantId: timer.tenant_id, kind: timer.kind, ref: timer.ref, partitionId: timer.partition_id }, { pool: steward });
		await withTenant(steward, null, (q) => q.run("UPDATE app.timers SET done_at = now() WHERE timer_id = $1", timer.timer_id));
	}
	return claimed.length;
}

/** Built-in: a pending approval expires, and the family is told so its tool can finish as denied. */
export const approvalExpiry = (runtime: pg.Pool): TimerHandler => async (timer, { pool }) => {
	void pool;
	await withTenant(runtime, timer.tenantId, async (q) => {
		const row = await q.get<{ partition_id: string }>("UPDATE app.approvals SET status = 'expired', decided_at = now() WHERE tenant_id = $1 AND approval_id = $2 AND status = 'pending' RETURNING partition_id", timer.tenantId, timer.ref);
		if (row) await insertSignal(q, timer.tenantId, row.partition_id, "approval", `approval-expiry:${timer.ref}`, { approvalId: timer.ref });
	});
};
