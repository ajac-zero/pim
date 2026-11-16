/**
 * Where the projector reads committed runtime truth from. A source turns the runtime's own tables into commits: one
 * per `commitSeq` of a partition, each with the events Live projects, so a commit that changed several things is
 * projected in one transaction and the watermark moves once.
 */
import type { PartitionId } from "@pim/v2-contracts/identity";
import type { Pool } from "pg";
import type { RuntimeOutboxEvent } from "../contracts.ts";
import { withOwner } from "../owner-tx.ts";

/** A commit of one partition and its events, possibly none. */
export type CommitUnit = { commitSeq: bigint; committedAt: Date; events: RuntimeOutboxEvent[] };

export interface OutboxSource {
	/** Every (owner, partition) that has commits: read across owners, so the source's database role must be allowed that and nothing more. */
	partitions(version: number): Promise<{ ownerId: string; partitionId: string }[]>;
	/** One owner's partitions. */
	partitionsOf(ownerId: string, version: number): Promise<string[]>;
	/** Up to `limit` commits of the partition after `after`, in order. The projector checks they follow on without a hole. */
	commitsAfter(ownerId: string, partitionId: string, version: number, after: number, limit: number): Promise<CommitUnit[]>;
	/** The newest commit of each partition, for lag. */
	heads(version: number): Promise<{ ownerId: string; partitionId: string; maxSeq: number }[]>;
	/** When the oldest commit after `after` was made, if any. */
	oldestAfter(ownerId: string, partitionId: string, version: number, after: number): Promise<Date | null>;
}

const IDENTIFIER = /^[a-z_][a-z0-9_]*(\.[a-z_][a-z0-9_]*)?$/;

type Row = { partition_id: string; commit_seq: string; projection_version: number; owner_id: string; public_chat_id: string; conversation_id: number; event_kind: string; payload: Record<string, unknown>; committed_at: Date };

/**
 * A table whose rows are already Live's events, one per commit (`RuntimeOutboxEvent` in snake_case, `payload` JSONB).
 * It is what Live's own tests feed; the runtime's real outbox holds references instead and is read by the runtime source in `@pim/v2-server`.
 */
export function tableOutboxSource(pool: Pool, table = "pim_runtime.runtime_outbox"): OutboxSource {
	if (!IDENTIFIER.test(table)) throw new Error(`Not an identifier: ${table}`);
	return {
		async partitions(version) {
			const { rows } = await pool.query<{ owner_id: string; partition_id: string }>(`SELECT DISTINCT owner_id, partition_id FROM ${table} WHERE projection_version = $1 ORDER BY owner_id, partition_id`, [version]);
			return rows.map((row) => ({ ownerId: row.owner_id, partitionId: row.partition_id }));
		},
		async partitionsOf(ownerId, version) {
			return withOwner(pool, ownerId, async (client) => {
				const { rows } = await client.query<{ partition_id: string }>(`SELECT DISTINCT partition_id FROM ${table} WHERE owner_id = $1 AND projection_version = $2 ORDER BY partition_id`, [ownerId, version]);
				return rows.map((row) => row.partition_id);
			});
		},
		async commitsAfter(ownerId, partitionId, version, after, limit) {
			const { rows } = await withOwner(pool, ownerId, (client) => client.query<Row>(`SELECT * FROM ${table} WHERE partition_id = $1 AND projection_version = $2 AND commit_seq > $3 ORDER BY commit_seq LIMIT $4`, [partitionId, version, after, limit]));
			return rows.map((row) => ({
				commitSeq: BigInt(row.commit_seq),
				committedAt: row.committed_at,
				events: [
					{
						partitionId: row.partition_id as PartitionId,
						commitSeq: BigInt(row.commit_seq),
						projectionVersion: row.projection_version,
						ownerId: row.owner_id as RuntimeOutboxEvent["ownerId"],
						publicChatId: row.public_chat_id as RuntimeOutboxEvent["publicChatId"],
						conversationId: row.conversation_id,
						eventKind: row.event_kind,
						payload: row.payload,
						committedAt: row.committed_at.toISOString(),
					},
				],
			}));
		},
		async heads(version) {
			const { rows } = await pool.query<{ owner_id: string; partition_id: string; max_seq: string }>(`SELECT owner_id, partition_id, max(commit_seq) AS max_seq FROM ${table} WHERE projection_version = $1 GROUP BY owner_id, partition_id ORDER BY owner_id, partition_id`, [version]);
			return rows.map((row) => ({ ownerId: row.owner_id, partitionId: row.partition_id, maxSeq: Number(row.max_seq) }));
		},
		async oldestAfter(ownerId, partitionId, version, after) {
			return withOwner(pool, ownerId, async (client) => {
				const { rows } = await client.query<{ oldest: Date | null }>(`SELECT min(committed_at) AS oldest FROM ${table} WHERE partition_id = $1 AND projection_version = $2 AND commit_seq > $3`, [partitionId, version, after]);
				return rows[0]?.oldest ?? null;
			});
		},
	};
}
