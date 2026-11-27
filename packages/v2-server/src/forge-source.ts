/**
 * Forge's side of what Live projects: a coding thread's card (`coding.thread`: created, changed state, archived) and its
 * transcript (`chat.entry` of the `coding` stream). Forge writes them to its outbox in the same transaction as the
 * change; migration 0601 numbers each owner's rows without gaps and gives Live functions to read them. An owner's rows
 * are one stream, a pseudo-partition with a stable id, so the projector's watermark, cursors and rebuild work as for the runtime's.
 */
import { createHash } from "node:crypto";
import { eventMessages } from "@pim/v2-forge/event-messages";
import type { TranscriptMessage } from "@pim/shared/transcript";
import { OwnerId, type PartitionId, type PublicChatId } from "@pim/v2-contracts/identity";
import type { RuntimeOutboxEvent } from "@pim/v2-contracts/runtime-seam";
import type { CommitUnit, OutboxSource } from "@pim/v2-live/projections/outbox-source";
import type { Pool } from "pg";

/** The stream id of an owner's Forge feed: a UUID (version 5 layout) derived from the owner, so every process agrees on it. */
export function forgePartitionId(ownerId: string): PartitionId {
	const hex = createHash("sha256").update(`pim forge projection\n${ownerId}`).digest("hex");
	return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-5${hex.slice(13, 16)}-8${hex.slice(17, 20)}-${hex.slice(20, 32)}` as PartitionId;
}

type FeedRow = { owner_seq: string; topic: string; payload: { type?: string; threadId?: string; seq?: number }; created_at: Date; thread_id: string | null; task: string | null; harness: string | null; state: string | null; updated_at: Date | null; role: string | null; data: Record<string, any> | null; event_at: Date | null };

/** A thread's messages in the shared transcript shape, as Forge's own transcript reads them: a message, and each tool result it carries. */
function messagesOf(row: FeedRow): TranscriptMessage[] {
	if (row.role === null || row.data === null) return [];
	return eventMessages({ seq: row.payload.seq, role: row.role, data: row.data, at: row.event_at ?? row.created_at });
}

const firstLine = (task: string | null) => (task ?? "").split("\n", 1)[0]!.trim().slice(0, 120);

export function forgeOutboxSource(pool: Pool): OutboxSource {
	/** Owners Forge has rows for and Live can project: an id that is not an owner's is skipped, so one bad row never stops the others. */
	const heads = async () =>
		(await pool.query<{ owner_id: string; last_seq: string }>("SELECT owner_id, last_seq FROM pim_forge.live_forge_heads()")).rows.filter((r) => OwnerId.safeParse(r.owner_id).success).map((r) => ({ ownerId: r.owner_id, partitionId: forgePartitionId(r.owner_id), maxSeq: Number(r.last_seq) }));
	return {
		partitions: async () => (await heads()).map(({ ownerId, partitionId }) => ({ ownerId, partitionId })),
		partitionsOf: async (ownerId) => (await heads()).filter((h) => h.ownerId === ownerId).map((h) => h.partitionId),
		heads,
		async oldestAfter(ownerId, partitionId, _version, after) {
			if (partitionId !== forgePartitionId(ownerId)) return null;
			return (await pool.query<{ oldest: Date | null }>("SELECT pim_forge.live_forge_oldest($1, $2) AS oldest", [ownerId, after])).rows[0]?.oldest ?? null;
		},
		async commitsAfter(ownerId, partitionId, version, after, limit) {
			if (partitionId !== forgePartitionId(ownerId)) return [];
			const owner = OwnerId.parse(ownerId);
			const { rows } = await pool.query<FeedRow>("SELECT * FROM pim_forge.live_forge_feed($1, $2, $3)", [ownerId, after, limit]);
			return rows.map((row): CommitUnit => {
				const commitSeq = BigInt(row.owner_seq);
				const threadId = row.payload.threadId ?? row.thread_id ?? "";
				const event = (eventKind: string, payload: Record<string, unknown>): RuntimeOutboxEvent => ({ partitionId: partitionId as PartitionId, commitSeq, projectionVersion: version, ownerId: owner, publicChatId: threadId as PublicChatId, conversationId: 0, eventKind, payload, committedAt: row.created_at.toISOString() });
				const events: RuntimeOutboxEvent[] = [];
				if (row.topic === "projection" && row.thread_id !== null) {
					const type = row.payload.type;
					if (type === "coding.event") {
						for (const message of messagesOf(row)) events.push(event("chat.entry", { stream: "coding", threadId, message, position: Number(row.payload.seq) }));
					} else if (type === "coding.created" || type === "coding.state" || type === "coding.archived") {
						const state = type === "coding.archived" ? "archived" : (row.state ?? "idle");
						events.push(event("coding.thread", { threadId, title: firstLine(row.task), harness: row.harness ?? undefined, state, running: state === "running", updatedAt: (row.updated_at ?? row.created_at).getTime() }));
					}
				}
				return { commitSeq, committedAt: row.created_at, events };
			});
		},
	};
}

/** Several sources as one: each answers for its own partitions and returns nothing for another's. */
export function combineSources(...sources: OutboxSource[]): OutboxSource {
	return {
		partitions: async (v) => (await Promise.all(sources.map((s) => s.partitions(v)))).flat(),
		partitionsOf: async (o, v) => (await Promise.all(sources.map((s) => s.partitionsOf(o, v)))).flat(),
		commitsAfter: async (o, p, v, a, l) => (await Promise.all(sources.map((s) => s.commitsAfter(o, p, v, a, l)))).flat(),
		heads: async (v) => (await Promise.all(sources.map((s) => s.heads(v)))).flat(),
		oldestAfter: async (o, p, v, a) => {
			const all = (await Promise.all(sources.map((s) => s.oldestAfter(o, p, v, a)))).filter((d): d is Date => d !== null);
			return all.length === 0 ? null : new Date(Math.min(...all.map((d) => d.getTime())));
		},
	};
}
