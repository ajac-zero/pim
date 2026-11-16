import type { Pool } from "pg";
import { inTransaction } from "../pg/migrate.ts";

export type PostRestoreInput = {
	readonly restoreId: string;
	readonly backupId?: string;
	readonly targetTime?: string;
	/** Effects known to have happened that the restored database may not remember, as `tenant|idempotencyKey`: from the provider's side, an outbox log or the failed database's last rows. */
	readonly knownEffects?: readonly { tenantId: string; idempotencyKey: string }[];
	readonly now?: number;
};

export type PostRestoreSummary = {
	readonly inFlightQuarantined: number;
	readonly pendingQuarantined: number;
	readonly knownEffectsRecorded: number;
	readonly toolTasksHeld: number;
	readonly schedulesRecomputed: number;
};

/**
 * The post-restore safety pass. A restored database is older than the world: effects that happened after the restore point are
 * not in it, and operations it shows as in flight may have finished or half-finished. So before any Runner claims work this moves
 * every operation that could re-run a side effect (HTTP calls, purchases, messages, sandbox launches, remote starts) to
 * `needs_reconciliation`, which no Runner executes; holds unfinished tool tasks; and moves every schedule whose next time has
 * passed to `recompute` with the missed time recorded, so nothing fires as a catch-up. It then marks the restore reconciled.
 * Idempotent: running it twice changes nothing the second time.
 */
export async function postRestoreSafetyPass(pool: Pool, input: PostRestoreInput): Promise<PostRestoreSummary> {
	const now = input.now ?? Date.now();
	const client = await pool.connect();
	try {
		return await inTransaction(client, async () => {
			await client.query("INSERT INTO pim.ops_restore (restore_id, backup_id, target_time, state) VALUES ($1, $2, $3, 'restored') ON CONFLICT DO NOTHING", [input.restoreId, input.backupId ?? null, input.targetTime ?? null]);
			let known = 0;
			for (const effect of input.knownEffects ?? []) {
				const r = await client.query(
					"UPDATE pim.external_operations SET status = 'needs_reconciliation', reason = 'The effect is known to have happened after the restore point; the restored database does not remember it.', updated_at = now() WHERE tenant_id = $1 AND idempotency_key = $2 AND status IN ('pending','in_flight','failed')",
					[effect.tenantId, effect.idempotencyKey],
				);
				known += r.rowCount ?? 0;
			}
			const inFlight = await client.query("UPDATE pim.external_operations SET status = 'needs_reconciliation', reason = 'In flight at the restore point: it may have finished, half-finished or never started.', updated_at = now() WHERE status = 'in_flight'");
			const pending = await client.query("UPDATE pim.external_operations SET status = 'needs_reconciliation', reason = 'Pending at the restore point: it may already have run after the backup was taken.', updated_at = now() WHERE status = 'pending'");
			const tools = await client.query("UPDATE pim.pi_tasks SET hold = 'needs_reconciliation' WHERE kind = 'pi.tool' AND status <> 'terminal' AND hold IS NULL");
			const due = await client.query("UPDATE pim.due_work SET state = 'recompute', missed = missed || to_jsonb(next_due_at_ms), skip_before_ms = GREATEST(skip_before_ms, $1), next_due_at_ms = NULL WHERE state = 'armed' AND next_due_at_ms <= $1", [now]);
			await client.query("UPDATE pim.due_work SET skip_before_ms = GREATEST(skip_before_ms, $1) WHERE state = 'armed'", [now]);
			const summary: PostRestoreSummary = { inFlightQuarantined: inFlight.rowCount ?? 0, pendingQuarantined: pending.rowCount ?? 0, knownEffectsRecorded: known, toolTasksHeld: tools.rowCount ?? 0, schedulesRecomputed: due.rowCount ?? 0 };
			await client.query("UPDATE pim.ops_restore SET state = 'reconciled', summary = $2::jsonb WHERE restore_id = $1", [input.restoreId, JSON.stringify(summary)]);
			return summary;
		});
	} finally {
		client.release();
	}
}

/** What a Runner checks at boot: it may claim work only when no restore is waiting for its safety pass. */
export async function runnerMayStart(pool: Pool): Promise<boolean> {
	const { rows } = await pool.query("SELECT state FROM pim.ops_restore ORDER BY restored_at DESC LIMIT 1");
	return rows.length === 0 || rows[0].state === "reconciled";
}

/** Written by the restore procedure as soon as the restored server accepts connections, before any Runner can start. */
export async function markRestored(pool: Pool, restoreId: string, backupId?: string, targetTime?: string): Promise<void> {
	await pool.query("INSERT INTO pim.ops_restore (restore_id, backup_id, target_time, state) VALUES ($1, $2, $3, 'restored') ON CONFLICT DO NOTHING", [restoreId, backupId ?? null, targetTime ?? null]);
}
