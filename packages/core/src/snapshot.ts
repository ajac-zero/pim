import type pg from "pg";
import { withTenant } from "./db.ts";
import type { IdAllocator } from "./ids.ts";
import { PgStorage } from "./storage.ts";

export interface ChatSnapshot {
	chatId: string;
	conversationId: number | null;
	/** Subscribe to the chat's stream from this cursor to continue without a gap. Read before the entries, so replay can only overlap. */
	highWater: number;
	entries: unknown[];
	hasMore: boolean;
}

/**
 * An HTTP snapshot of a chat, read straight from PostgreSQL. It needs no Live, no Runner and no owner: ordinary chat
 * navigation works while every other role is down. The storage here never holds a lease, so it can read and cannot write.
 */
export async function chatSnapshot(pool: pg.Pool, ids: IdAllocator, tenantId: string, chatId: string, limit = 50): Promise<ChatSnapshot | undefined> {
	const chat = await withTenant(pool, tenantId, (q) => q.get<{ partition_id: string; conversation_id: number | null }>("SELECT partition_id, conversation_id FROM app.chats WHERE tenant_id = $1 AND chat_id = $2", tenantId, chatId), { readOnly: true });
	if (chat === undefined) return undefined;
	const highWater = await withTenant(pool, tenantId, async (q) => (await q.get<{ n: number }>("SELECT next_seq - 1 AS n FROM rt.partitions WHERE partition_id = $1", chat.partition_id))!.n, { readOnly: true });
	if (chat.conversation_id === null) return { chatId, conversationId: null, highWater, entries: [], hasMore: false };
	const reader = new PgStorage({ pool, tenantId, partitionId: chat.partition_id, ownerId: "reader", epoch: 0, home: false, ids });
	try {
		const page = (await reader.scanEntries({ conversationId: chat.conversation_id, order: "descending" }, limit)) as { items: unknown[]; next?: unknown };
		return { chatId, conversationId: chat.conversation_id, highWater, entries: page.items.reverse(), hasMore: page.next !== undefined };
	} finally {
		await reader.close();
	}
}
