/**
 * The bounded, paginated HTTP reads every page loads from, with or without a WebSocket. Each page is read in
 * one repeatable-read transaction together with its stream's head, so `liveCursor` is exactly the position
 * the page reflects: subscribing with it replays nothing twice and misses nothing.
 */
import type { TranscriptMessage } from "@pim/shared/transcript";
import type { Pool } from "pg";
import { SIDEBAR_STREAM, chatStream, codingStream } from "../contracts.ts";

export const MAX_PAGE = 200;

export type TranscriptPage = {
	messages: (TranscriptMessage & { partial: boolean; uiState: Record<string, unknown> })[];
	/** Pass as `before` for the page of older messages; null when this page starts the transcript. */
	nextBefore: string | null;
	liveCursor: number;
};

export type SidebarPage = {
	sessions: { chatId: string; title: string | null; busy: boolean; unread: boolean; stalled: boolean; updatedAt: number; summary: unknown }[];
	coding: { threadId: string; title: string | null; harness: string | null; state: string; running: boolean; unread: boolean; updatedAt: number; summary: unknown }[];
	/** Pass as `after` for the next page: `<updatedAt>:<id>` of the last session; null at the end. */
	nextAfter: string | null;
	liveCursor: number;
};

const clamp = (limit: number | undefined) => Math.max(1, Math.min(MAX_PAGE, Math.floor(limit ?? 50)));

async function readOnly<T>(pool: Pool, work: (query: Pool["query"]) => Promise<T>): Promise<T> {
	const client = await pool.connect();
	try {
		await client.query("BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY");
		const result = await work(client.query.bind(client) as Pool["query"]);
		await client.query("COMMIT");
		return result;
	} catch (error) {
		await client.query("ROLLBACK").catch(() => {});
		throw error;
	} finally {
		client.release();
	}
}

const headOf = async (query: Pool["query"], tenantId: string, stream: string) => {
	const { rows } = await query("SELECT head_seq FROM pim_projection.live_stream_heads WHERE tenant_id = $1 AND stream_key = $2", [tenantId, stream]);
	return Number(rows[0]?.head_seq ?? 0);
};

/** The newest `limit` messages of a chat or coding thread (older than `before`, a position), oldest first. */
export function transcriptPage(pool: Pool, tenantId: string, id: string, options: { kind?: "chat" | "coding"; before?: string | null; limit?: number } = {}): Promise<TranscriptPage> {
	const kind = options.kind ?? "chat";
	const limit = clamp(options.limit);
	return readOnly(pool, async (query) => {
		const { rows } = await query(
			`SELECT message, partial, ui_state, position FROM pim_projection.chat_transcript_projection
			 WHERE tenant_id = $1 AND stream_kind = $2 AND chat_id = $3 AND ($4::bigint IS NULL OR position < $4::bigint)
			 ORDER BY position DESC LIMIT $5`,
			[tenantId, kind, id, options.before ?? null, limit + 1],
		);
		const more = rows.length > limit;
		const page = rows.slice(0, limit).reverse();
		return {
			messages: page.map((row) => ({ ...(row.message as TranscriptMessage), partial: row.partial as boolean, uiState: row.ui_state as Record<string, unknown> })),
			nextBefore: more ? String(page[0]!.position) : null,
			liveCursor: await headOf(query, tenantId, kind === "chat" ? chatStream(id) : codingStream(id)),
		};
	});
}

/** The most recently active chats and coding threads, with the sidebar stream's cursor. */
export function sidebarPage(pool: Pool, tenantId: string, options: { after?: string | null; limit?: number } = {}): Promise<SidebarPage> {
	const limit = clamp(options.limit);
	const [afterAt, afterId] = options.after ? [Number(options.after.slice(0, options.after.indexOf(":"))), options.after.slice(options.after.indexOf(":") + 1)] : [null, null];
	return readOnly(pool, async (query) => {
		const sessions = await query(
			`SELECT chat_id, title, busy, unread, stalled, updated_at, summary FROM pim_projection.sidebar_session_projection
			 WHERE tenant_id = $1 AND ($2::bigint IS NULL OR (updated_at, chat_id) < ($2::bigint, $3::text))
			 ORDER BY updated_at DESC, chat_id DESC LIMIT $4`,
			[tenantId, afterAt, afterId, limit + 1],
		);
		const more = sessions.rows.length > limit;
		const shown = sessions.rows.slice(0, limit);
		const coding = options.after
			? { rows: [] }
			: await query("SELECT thread_id, title, harness, state, running, unread, updated_at, summary FROM pim_projection.coding_thread_projection WHERE tenant_id = $1 ORDER BY updated_at DESC, thread_id DESC LIMIT $2", [tenantId, limit]);
		const last = shown.at(-1);
		return {
			sessions: shown.map((row) => ({ chatId: row.chat_id, title: row.title, busy: row.busy, unread: row.unread, stalled: row.stalled, updatedAt: Number(row.updated_at), summary: row.summary })),
			coding: coding.rows.map((row) => ({ threadId: row.thread_id, title: row.title, harness: row.harness, state: row.state, running: row.running, unread: row.unread, updatedAt: Number(row.updated_at), summary: row.summary })),
			nextAfter: more && last ? `${last.updated_at}:${last.chat_id}` : null,
			liveCursor: await headOf(query, tenantId, SIDEBAR_STREAM),
		};
	});
}
