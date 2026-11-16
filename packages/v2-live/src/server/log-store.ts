import type { JsonValue } from "@earendil-works/pi-ai";
import type { PartitionId } from "@pim/v2-contracts/identity";
import type { ProjectionCursor } from "@pim/v2-contracts/live-seam";
import type { Pool } from "pg";
import type { LiveEvent } from "../contracts.ts";
import { withOwner } from "../owner-tx.ts";

type Row = { topic: string; stream_seq: string; partition_id: string; commit_seq: string; projection_version: number; event_kind: string; replaceable_key: string | null; payload: JsonValue };
const COLUMNS = "topic, stream_seq, partition_id, commit_seq, projection_version, event_kind, replaceable_key, payload";

export const eventOf = (row: Row): LiveEvent => ({
	topic: row.topic,
	seq: Number(row.stream_seq),
	cursor: { partitionId: row.partition_id as PartitionId, projectionVersion: row.projection_version, commitSeq: BigInt(row.commit_seq) },
	kind: row.event_kind,
	replaceableKey: row.replaceable_key,
	data: row.payload,
});

/** Reads of the live event log. Every read runs as one owner (`pim.owner_id`), so row-level security, not the query, keeps another owner's rows out. */
export class LogStore {
	readonly #pool: Pool;

	constructor(pool: Pool) {
		this.#pool = pool;
	}

	/** The newest seq of a topic (0 when it has none) and the oldest seq still in the log (null when empty). */
	bounds(ownerId: string, topic: string): Promise<{ head: number; min: number | null }> {
		return withOwner(this.#pool, ownerId, async (client) => {
			const head = await client.query<{ head_seq: string }>("SELECT head_seq FROM pim_projection.live_stream_heads WHERE owner_id = $1 AND topic = $2", [ownerId, topic]);
			const min = await client.query<{ min: string | null }>("SELECT min(stream_seq) AS min FROM pim_projection.live_event_log WHERE owner_id = $1 AND topic = $2", [ownerId, topic]);
			return { head: Number(head.rows[0]?.head_seq ?? 0), min: min.rows[0]?.min == null ? null : Number(min.rows[0].min) };
		});
	}

	/** The committed events of a topic after `after`, oldest first. */
	read(ownerId: string, topic: string, after: number, limit: number): Promise<LiveEvent[]> {
		return withOwner(this.#pool, ownerId, async (client) => {
			const { rows } = await client.query<Row>(`SELECT ${COLUMNS} FROM pim_projection.live_event_log WHERE owner_id = $1 AND topic = $2 AND stream_seq > $3 ORDER BY stream_seq LIMIT $4`, [ownerId, topic, after, limit]);
			return rows.map(eventOf);
		});
	}

	/** The newest seq of each of the topics that have events: one cheap query for a whole connection's heartbeat. */
	heads(ownerId: string, topics: string[]): Promise<Map<string, number>> {
		return withOwner(this.#pool, ownerId, async (client) => {
			const { rows } = await client.query<{ topic: string; head_seq: string }>("SELECT topic, head_seq FROM pim_projection.live_stream_heads WHERE owner_id = $1 AND topic = ANY($2)", [ownerId, topics]);
			return new Map(rows.map((row) => [row.topic, Number(row.head_seq)]));
		});
	}

	/** Where a client's cursor is in a topic: its row's seq, or why there is none. */
	resolve(ownerId: string, topic: string, cursor: ProjectionCursor): Promise<{ seq: number } | { missing: "projection_version" | "expired" }> {
		return withOwner(this.#pool, ownerId, async (client) => {
			const exact = await client.query<{ stream_seq: string }>(
				"SELECT stream_seq FROM pim_projection.live_event_log WHERE owner_id = $1 AND topic = $2 AND partition_id = $3 AND projection_version = $4 AND commit_seq = $5",
				[ownerId, topic, cursor.partitionId, cursor.projectionVersion, cursor.commitSeq.toString()],
			);
			if (exact.rows[0]) return { seq: Number(exact.rows[0].stream_seq) };
			// A cursor of another projection version of this partition: the views were rebuilt since.
			const other = await client.query("SELECT 1 FROM pim_projection.live_event_log WHERE owner_id = $1 AND topic = $2 AND partition_id = $3 AND projection_version <> $4 LIMIT 1", [ownerId, topic, cursor.partitionId, cursor.projectionVersion]);
			return { missing: other.rows.length > 0 ? "projection_version" : "expired" };
		});
	}

	/** Drops one owner's log rows older than `maxAgeMs`, keeping the newest `keep` of each topic. Clients behind what is kept are told to take a snapshot. */
	prune(ownerId: string, maxAgeMs: number, keep: number): Promise<number> {
		return withOwner(this.#pool, ownerId, async (client) => {
			const { rowCount } = await client.query(
				`DELETE FROM pim_projection.live_event_log l USING pim_projection.live_stream_heads h
				 WHERE h.owner_id = l.owner_id AND h.topic = l.topic AND l.stream_seq <= h.head_seq - $2 AND l.created_at < now() - ($1 || ' milliseconds')::interval`,
				[String(maxAgeMs), keep],
			);
			return rowCount ?? 0;
		});
	}
}
