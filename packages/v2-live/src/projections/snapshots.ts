/**
 * The bounded, paginated HTTP reads every page loads from, with or without a WebSocket. Each page is read in
 * one repeatable-read transaction, as the owner, together with its topic's newest log row, so `liveCursor` is
 * exactly the position the page reflects: subscribing with it replays nothing twice and misses nothing. It is
 * null when the topic has no events yet; subscribing without a cursor then replays from the start.
 */
import type { TranscriptMessage } from "@pim/shared/transcript";
import { serializeCursor } from "@pim/v2-contracts/live-seam";
import type { PartitionId } from "@pim/v2-contracts/identity";
import type { Pool, PoolClient } from "pg";
import { SIDEBAR_TOPIC, chatTopic, codingTopic } from "../contracts.ts";
import { withOwner } from "../owner-tx.ts";

export const MAX_PAGE = 200;

export type TranscriptPage = {
	messages: (TranscriptMessage & { partial: boolean; uiState: Record<string, unknown> })[];
	/** Pass as `before` for the page of older messages; null when this page starts the transcript. */
	nextBefore: string | null;
	liveCursor: string | null;
};

export type SidebarPage = {
	sessions: { chatId: string; title: string | null; busy: boolean; unread: boolean; stalled: boolean; updatedAt: number; summary: unknown }[];
	coding: { threadId: string; title: string | null; harness: string | null; state: string; running: boolean; unread: boolean; updatedAt: number; summary: unknown }[];
	/** Pass as `after` for the next page: `<updatedAt>:<id>` of the last session; null at the end. */
	nextAfter: string | null;
	liveCursor: string | null;
};

const clamp = (limit: number | undefined) => Math.max(1, Math.min(MAX_PAGE, Math.floor(limit ?? 50)));

/** The cursor of a topic's newest row, as a client subscribes from it. */
async function liveCursor(client: PoolClient, ownerId: string, topic: string): Promise<string | null> {
	const { rows } = await client.query<{ partition_id: string; projection_version: number; commit_seq: string }>(
		"SELECT partition_id, projection_version, commit_seq FROM pim_projection.live_event_log WHERE owner_id = $1 AND topic = $2 ORDER BY stream_seq DESC LIMIT 1",
		[ownerId, topic],
	);
	const row = rows[0];
	return row ? serializeCursor({ partitionId: row.partition_id as PartitionId, projectionVersion: row.projection_version, commitSeq: BigInt(row.commit_seq) }) : null;
}

/** The newest `limit` messages of a chat or coding thread (older than `before`, a position), oldest first. */
export function transcriptPage(pool: Pool, ownerId: string, id: string, options: { kind?: "chat" | "coding"; before?: string | null; limit?: number } = {}): Promise<TranscriptPage> {
	const kind = options.kind ?? "chat";
	const limit = clamp(options.limit);
	return withOwner(
		pool,
		ownerId,
		async (client) => {
			const { rows } = await client.query(
				`SELECT message, partial, ui_state, position FROM pim_projection.chat_transcript_projection
				 WHERE owner_id = $1 AND stream_kind = $2 AND chat_id = $3 AND ($4::bigint IS NULL OR position < $4::bigint)
				 ORDER BY position DESC LIMIT $5`,
				[ownerId, kind, id, options.before ?? null, limit + 1],
			);
			const more = rows.length > limit;
			const page = rows.slice(0, limit).reverse();
			return {
				messages: page.map((row) => ({ ...(row.message as TranscriptMessage), partial: row.partial as boolean, uiState: row.ui_state as Record<string, unknown> })),
				nextBefore: more ? String(page[0]!.position) : null,
				liveCursor: await liveCursor(client, ownerId, kind === "chat" ? chatTopic(id) : codingTopic(id)),
			};
		},
		{ snapshot: true },
	);
}

/** The most recently active chats and coding threads, with the sidebar topic's cursor. */
export function sidebarPage(pool: Pool, ownerId: string, options: { after?: string | null; limit?: number } = {}): Promise<SidebarPage> {
	const limit = clamp(options.limit);
	const [afterAt, afterId] = options.after ? [Number(options.after.slice(0, options.after.indexOf(":"))), options.after.slice(options.after.indexOf(":") + 1)] : [null, null];
	return withOwner(
		pool,
		ownerId,
		async (client) => {
			const sessions = await client.query(
				`SELECT chat_id, title, busy, unread, stalled, updated_at, summary FROM pim_projection.sidebar_session_projection
				 WHERE owner_id = $1 AND ($2::bigint IS NULL OR (updated_at, chat_id) < ($2::bigint, $3::text))
				 ORDER BY updated_at DESC, chat_id DESC LIMIT $4`,
				[ownerId, afterAt, afterId, limit + 1],
			);
			const more = sessions.rows.length > limit;
			const shown = sessions.rows.slice(0, limit);
			const coding = options.after
				? { rows: [] }
				: await client.query("SELECT thread_id, title, harness, state, running, unread, updated_at, summary FROM pim_projection.coding_thread_projection WHERE owner_id = $1 ORDER BY updated_at DESC, thread_id DESC LIMIT $2", [ownerId, limit]);
			const last = shown.at(-1);
			return {
				sessions: shown.map((row) => ({ chatId: row.chat_id, title: row.title, busy: row.busy, unread: row.unread, stalled: row.stalled, updatedAt: Number(row.updated_at), summary: row.summary })),
				coding: coding.rows.map((row) => ({ threadId: row.thread_id, title: row.title, harness: row.harness, state: row.state, running: row.running, unread: row.unread, updatedAt: Number(row.updated_at), summary: row.summary })),
				nextAfter: more && last ? `${last.updated_at}:${last.chat_id}` : null,
				liveCursor: await liveCursor(client, ownerId, SIDEBAR_TOPIC),
			};
		},
		{ snapshot: true },
	);
}
