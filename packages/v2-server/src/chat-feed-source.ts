/**
 * The application's side of what Live projects of a chat: what the runtime doesn't know (its title, whether it is unread or archived, its agent and
 * model), as `chat.meta`. Migration 0711 announces each change in a feed numbered per owner and gives Live functions to read it, so, as with Forge's
 * feed, an owner's rows are one stream, a pseudo-partition with a stable id, and the projector's watermark, cursors and rebuild work as for the runtime's.
 */
import { createHash } from "node:crypto";
import { OwnerId, type PartitionId, type PublicChatId } from "@pim/v2-contracts/identity";
import type { RuntimeOutboxEvent } from "@pim/v2-contracts/runtime-seam";
import type { CommitUnit, OutboxSource } from "@pim/v2-live/projections/outbox-source";
import type { Pool } from "pg";
import { type ChatColumns, chatSummary } from "./chat-summary.ts";

/** The stream id of an owner's chat feed: a UUID (version 5 layout) derived from the owner, so every process agrees on it. */
export function chatFeedPartitionId(ownerId: string): PartitionId {
	const hex = createHash("sha256").update(`pim chat feed projection\n${ownerId}`).digest("hex");
	return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-5${hex.slice(13, 16)}-8${hex.slice(17, 20)}-${hex.slice(20, 32)}` as PartitionId;
}

type FeedRow = ChatColumns & { owner_seq: string; announced_at: Date; chat_id: string; found: boolean; deleted: boolean; seat: boolean; title: string | null; unread: boolean; updated_at: Date | null };

export function chatFeedSource(pool: Pool): OutboxSource {
	/** Owners with a feed that Live can project: an id that is not an owner's is skipped, so one bad row never stops the others. */
	const heads = async () =>
		(await pool.query<{ owner_id: string; last_seq: string }>("SELECT owner_id, last_seq FROM pim_app.live_chat_heads()")).rows
			.filter((r) => OwnerId.safeParse(r.owner_id).success)
			.map((r) => ({ ownerId: r.owner_id, partitionId: chatFeedPartitionId(r.owner_id), maxSeq: Number(r.last_seq) }));
	return {
		partitions: async () => (await heads()).map(({ ownerId, partitionId }) => ({ ownerId, partitionId })),
		partitionsOf: async (ownerId) => (await heads()).filter((h) => h.ownerId === ownerId).map((h) => h.partitionId),
		heads,
		async oldestAfter(ownerId, partitionId, _version, after) {
			if (partitionId !== chatFeedPartitionId(ownerId)) return null;
			return (await pool.query<{ oldest: Date | null }>("SELECT pim_app.live_chat_oldest($1, $2) AS oldest", [ownerId, after])).rows[0]?.oldest ?? null;
		},
		async commitsAfter(ownerId, partitionId, version, after, limit) {
			if (partitionId !== chatFeedPartitionId(ownerId)) return [];
			const owner = OwnerId.parse(ownerId);
			const { rows } = await pool.query<FeedRow>("SELECT * FROM pim_app.live_chat_feed($1, $2, $3)", [ownerId, after, limit]);
			return rows.map((row): CommitUnit => {
				const commitSeq = BigInt(row.owner_seq);
				// A chat that was deleted, or is a room member's seat, is no row of the sidebar: its announcement only moves the watermark.
				const listed = row.found && !row.deleted && !row.seat;
				const events: RuntimeOutboxEvent[] = listed
					? [{
						partitionId: partitionId as PartitionId,
						commitSeq,
						projectionVersion: version,
						ownerId: owner,
						publicChatId: row.chat_id as PublicChatId,
						conversationId: 0,
						eventKind: "chat.meta",
						payload: { title: row.title, unread: row.unread, ...(row.updated_at ? { updatedAt: row.updated_at.getTime() } : {}), summary: chatSummary(row) },
						committedAt: row.announced_at.toISOString(),
					}]
					: [];
				return { commitSeq, committedAt: row.announced_at, events };
			});
		},
	};
}
