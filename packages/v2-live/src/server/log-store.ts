import type { JsonValue } from "@earendil-works/pi-ai";
import type { Pool } from "pg";
import type { LiveEvent } from "../contracts.ts";

/** Reads of the live event log. Every query is bound to the tenant of the connection asking, whatever stream or subject it names. */
export class LogStore {
	readonly #pool: Pool;

	constructor(pool: Pool) {
		this.#pool = pool;
	}

	/** The newest seq of a stream (0 when it has none) and the oldest seq still in the log (null when empty). */
	async bounds(tenantId: string, streamKey: string): Promise<{ head: number; min: number | null }> {
		const head = await this.#pool.query<{ head_seq: string }>("SELECT head_seq FROM pim_projection.live_stream_heads WHERE tenant_id = $1 AND stream_key = $2", [tenantId, streamKey]);
		const min = await this.#pool.query<{ min: string | null }>("SELECT min(stream_seq) AS min FROM pim_projection.live_event_log WHERE tenant_id = $1 AND stream_key = $2", [tenantId, streamKey]);
		return { head: Number(head.rows[0]?.head_seq ?? 0), min: min.rows[0]?.min == null ? null : Number(min.rows[0].min) };
	}

	/** The committed events of a stream after `after`, oldest first. */
	async read(tenantId: string, streamKey: string, after: number, limit: number): Promise<LiveEvent[]> {
		const { rows } = await this.#pool.query(
			"SELECT stream_key, stream_seq, commit_seq, event_kind, replaceable_key, payload FROM pim_projection.live_event_log WHERE tenant_id = $1 AND stream_key = $2 AND stream_seq > $3 ORDER BY stream_seq LIMIT $4",
			[tenantId, streamKey, after, limit],
		);
		return rows.map((row) => ({ streamKey: row.stream_key, seq: Number(row.stream_seq), commitSeq: Number(row.commit_seq), kind: row.event_kind, replaceableKey: row.replaceable_key, payload: row.payload as JsonValue }));
	}

	/** The newest seq of each of the streams that have events: one cheap query for a whole connection's heartbeat. */
	async heads(tenantId: string, streamKeys: string[]): Promise<Map<string, number>> {
		const { rows } = await this.#pool.query<{ stream_key: string; head_seq: string }>("SELECT stream_key, head_seq FROM pim_projection.live_stream_heads WHERE tenant_id = $1 AND stream_key = ANY($2)", [tenantId, streamKeys]);
		return new Map(rows.map((row) => [row.stream_key, Number(row.head_seq)]));
	}

	/** Drops log rows older than `maxAgeMs`, keeping the newest `keep` of each stream. Clients behind what is kept are told to take a snapshot. */
	async prune(maxAgeMs: number, keep: number): Promise<number> {
		const { rowCount } = await this.#pool.query(
			`DELETE FROM pim_projection.live_event_log l USING pim_projection.live_stream_heads h
			 WHERE h.tenant_id = l.tenant_id AND h.stream_key = l.stream_key AND l.stream_seq <= h.head_seq - $2 AND l.created_at < now() - ($1 || ' milliseconds')::interval`,
			[String(maxAgeMs), keep],
		);
		return rowCount ?? 0;
	}
}
