import type { Pool } from "pg";

/** The outside world: a provider that records every real execution of an effect, whatever any database remembers. */
export class FakeProvider {
	readonly executions = new Map<string, number>();
	execute(key: string) {
		this.executions.set(key, (this.executions.get(key) ?? 0) + 1);
	}
	get duplicates() {
		return [...this.executions].filter(([, n]) => n > 1).map(([key]) => key);
	}
}

/**
 * What a Runner does with external operations, reduced to its contract: claim `pending` ones, mark them in flight, perform the
 * effect, record success. It never touches `needs_reconciliation`, `succeeded` or `reconciled`.
 */
export async function runPendingOperations(pool: Pool, provider: FakeProvider): Promise<string[]> {
	const done: string[] = [];
	for (;;) {
		const client = await pool.connect();
		try {
			await client.query("BEGIN");
			const { rows } = await client.query("SELECT id, idempotency_key FROM pim.external_operations WHERE status = 'pending' ORDER BY id LIMIT 1 FOR UPDATE SKIP LOCKED");
			if (rows.length === 0) {
				await client.query("COMMIT");
				return done;
			}
			await client.query("UPDATE pim.external_operations SET status = 'in_flight' WHERE id = $1", [rows[0].id]);
			provider.execute(rows[0].idempotency_key);
			await client.query("UPDATE pim.external_operations SET status = 'succeeded', updated_at = now() WHERE id = $1", [rows[0].id]);
			await client.query("COMMIT");
			done.push(rows[0].idempotency_key);
		} finally {
			client.release();
		}
	}
}
