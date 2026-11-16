import type pg from "pg";
import { withTenant } from "./db.ts";

/**
 * Projects commits into the tenant's list stream and the chat list rows. A projection is derived: it reads
 * committed receipts, never drives a tool, model or delivery, and can be rebuilt by resetting the cursors. Each batch
 * writes its events with stable ids, advances the cursor in the same transaction, and so is idempotent on replay.
 */
export async function projectOnce(pools: { steward: pg.Pool; runtime: pg.Pool }, limit = 100): Promise<number> {
	const due = await withTenant(
		pools.steward,
		null,
		(q) =>
			q.all<{ partition_id: string; tenant_id: string; last: number }>(
				`SELECT p.partition_id, p.tenant_id, COALESCE(c.last_seq, 0) AS last
				 FROM rt.partitions p LEFT JOIN app.projector_cursors c ON c.partition_id = p.partition_id
				 WHERE EXISTS (SELECT 1 FROM rt.commits k WHERE k.partition_id = p.partition_id AND k.seq > COALESCE(c.last_seq, 0))
				 LIMIT $1`,
				limit,
			),
		{ readOnly: true },
	);
	let projected = 0;
	for (const row of due) {
		projected += await withTenant(pools.runtime, row.tenant_id, async (q) => {
			// Lock the cursor row so two projectors never project one family at once.
			await q.run("INSERT INTO app.projector_cursors (partition_id, tenant_id) VALUES ($1, $2) ON CONFLICT DO NOTHING", row.partition_id, row.tenant_id);
			const cursor = (await q.get<{ last_seq: number }>("SELECT last_seq FROM app.projector_cursors WHERE partition_id = $1 FOR UPDATE", row.partition_id))!.last_seq;
			const commits = await q.all<{ seq: number }>("SELECT seq FROM rt.commits WHERE partition_id = $1 AND seq > $2 ORDER BY seq LIMIT 500", row.partition_id, cursor);
			if (commits.length === 0) return 0;
			const to = commits.at(-1)!.seq;
			const chats = await q.all<{ chat_id: string }>("SELECT chat_id FROM app.chats WHERE tenant_id = $1 AND partition_id = $2 ORDER BY chat_id", row.tenant_id, row.partition_id);
			if (chats.length > 0) {
				const next = (await q.get<{ next_cursor: number }>(
					"INSERT INTO app.view_streams (tenant_id, stream, next_cursor) VALUES ($1, 'list', 2) ON CONFLICT (tenant_id, stream) DO UPDATE SET next_cursor = app.view_streams.next_cursor + 1 RETURNING next_cursor - 1 AS next_cursor",
					row.tenant_id,
				))!.next_cursor;
				await q.run(
					"INSERT INTO app.view_events (tenant_id, stream, cursor, event_id, kind, payload) VALUES ($1, 'list', $2, $3, 'chat.updated', $4) ON CONFLICT DO NOTHING",
					row.tenant_id,
					next,
					`list:${row.partition_id}:${to}`,
					JSON.stringify({ chatIds: chats.map((c) => c.chat_id), from: cursor + 1, to }),
				);
				await q.run("UPDATE app.chats SET last_seq = $3, updated_at = now() WHERE tenant_id = $1 AND partition_id = $2", row.tenant_id, row.partition_id, to);
			}
			await q.run("UPDATE app.projector_cursors SET last_seq = $2 WHERE partition_id = $1", row.partition_id, to);
			return commits.length;
		});
	}
	return projected;
}

/** Deletes commit receipts and list events older than `keepForMs` that the projector has passed. A client behind them re-snapshots. */
export async function pruneStreams(maint: pg.Pool, keepForMs: number): Promise<{ commits: number; events: number }> {
	return withTenant(maint, null, async (q) => {
		const commits = await q.run(
			`DELETE FROM rt.commits k USING app.projector_cursors c
			 WHERE c.partition_id = k.partition_id AND k.seq <= c.last_seq AND k.committed_at < now() - $1::interval
			   AND k.seq < (SELECT max(seq) FROM rt.commits m WHERE m.partition_id = k.partition_id)`,
			`${Math.trunc(keepForMs)} milliseconds`,
		);
		const events = await q.run("DELETE FROM app.view_events WHERE created_at < now() - $1::interval AND cursor < (SELECT max(cursor) FROM app.view_events e WHERE e.tenant_id = view_events.tenant_id AND e.stream = view_events.stream)", `${Math.trunc(keepForMs)} milliseconds`);
		return { commits, events };
	});
}
