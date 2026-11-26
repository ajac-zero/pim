/**
 * Who is behind a message an agent sent: read from the conversation's own entries by `sendProvenance` (`@pim/shared/transcript`), where the work toward it is defined, and kept with the
 * message when it is projected, so a reload, a page of older messages or a compaction cannot change it. Entries are read newest first, a page at a time, until the work toward the message
 * is settled by what opened it. The same answer goes with an agent's post in a group chat to the chats that hear it (`./rooms.ts`).
 */
import type { EntryRecord } from "@earendil-works/pi-durable";
import { type Provenance, sendProvenance } from "@pim/shared/transcript";

/** Runs a query over `pim_runtime` as the owner the entries belong to. */
export type Read = (sql: string, params: unknown[]) => Promise<{ rows: Record<string, unknown>[] }>;

/**
 * An entry the runtime did not commit itself: one imported from the Cloudflare version, which is stored verbatim with its old commit sequence and has no commit receipt. What its requests
 * recorded of the model is not known to be the model that answered, so it is read as recording none: its work is counted, as unknown, and no identity from it reaches a message.
 */
export const NATIVE = "EXISTS (SELECT 1 FROM pim_runtime.commit_receipts r WHERE r.owner_id = e.owner_id AND r.partition_id = e.partition_id AND r.commit_seq = e.commit_seq)";

/** The entry as if its answers had recorded no model. */
export function unrecorded(entry: EntryRecord): EntryRecord {
	if (!entry.model?.some((m) => m.role === "assistant")) return entry;
	return { ...entry, model: entry.model.map((m) => (m.role === "assistant" ? { ...m, provider: "", model: "", responseModel: undefined } : m)) } as EntryRecord;
}

/** These entries, with those the runtime did not commit itself read as recording no model. */
export async function onlyNative(read: Read, ownerId: string, entries: readonly EntryRecord[]): Promise<EntryRecord[]> {
	if (entries.length === 0) return [];
	const native = new Set((await read(`SELECT e.id FROM pim_runtime.entries e WHERE e.owner_id = $1 AND e.id = ANY($2::bigint[]) AND ${NATIVE}`, [ownerId, entries.map((entry) => Number(entry.id))])).rows.map((row) => Number(row.id)));
	return entries.map((entry) => (native.has(Number(entry.id)) ? entry : unrecorded(entry)));
}

const PAGE = 200;
/** The work of one turn this long is not read back further: the list then says it may be missing models. */
const MAX_ENTRIES = 2_000;

/** What of a conversation's entries before `top` was read for the answer being written, so each partial of it need not read them again. */
const kept = new Map<string, { top: number; older: EntryRecord[]; edge: "start" | "cut" | "more" }>();
const KEPT = 200;

const sendsOf = (entry: EntryRecord) => (entry.model?.[0] as { role?: string; content?: { type: string; name?: string }[] } | undefined)?.content?.some((part) => part.type === "toolCall" && part.name === "send_to_user") === true && (entry.model?.[0] as { role?: string }).role === "assistant";

/**
 * The provenance of each `send_to_user` call of `entry`, by call id; empty when it makes none. A committed entry is in `pim_runtime.entries`; the answer still being written is not (`partial`),
 * and goes after the newest committed entry.
 */
export async function provenanceOfEntry(read: Read, ownerId: string, conversationId: number, entry: EntryRecord, partial = false): Promise<Record<string, Provenance>> {
	if (!sendsOf(entry)) return {};
	const rows = async (before: number, limit: number) => (await read(`SELECT e.record, ${NATIVE} AS native FROM pim_runtime.entries e WHERE e.owner_id = $1 AND e.conversation_id = $2 AND e.id < $3 ORDER BY e.id DESC LIMIT $4`, [ownerId, conversationId, before, limit])).rows.map((row) => (row.native ? (JSON.parse(row.record as string) as EntryRecord) : unrecorded(JSON.parse(row.record as string) as EntryRecord)));
	const key = `${ownerId}\u0000${conversationId}`;
	let target = entry;
	if (partial) {
		const top = Number(((await read("SELECT max(id) AS top FROM pim_runtime.entries WHERE owner_id = $1 AND conversation_id = $2", [ownerId, conversationId])).rows[0]?.top ?? 0) as number | string);
		target = { ...entry, id: top + 1 } as EntryRecord;
		const cached = kept.get(key);
		const found = cached?.top === top ? sendProvenance([...cached.older, target], cached.edge) : undefined;
		if (found) return found;
		const read_ = await history(rows, await forked(read, ownerId, conversationId), target);
		kept.set(key, { top, older: read_.older, edge: read_.edge });
		if (kept.size > KEPT) kept.delete(kept.keys().next().value as string);
		return read_.found;
	}
	return (await history(rows, await forked(read, ownerId, conversationId), target)).found;
}

/** Reads the entries before `target` back, a page at a time, until the work toward it is settled. */
async function history(rows: (before: number, limit: number) => Promise<EntryRecord[]>, fork: boolean, target: EntryRecord) {
	let older: EntryRecord[] = [];
	for (;;) {
		const page = await rows(older.length > 0 ? Number(older[0]!.id) : Number(target.id), PAGE);
		older = [...page.reverse(), ...older];
		const edge = page.length < PAGE ? (fork ? "cut" : "start") : older.length >= MAX_ENTRIES ? "cut" : "more";
		const found = sendProvenance([...older, target], edge);
		if (found) return { older, edge, found } as const;
	}
}

/** Whether a conversation continues a parent's, whose entries it does not hold. */
async function forked(read: Read, ownerId: string, conversationId: number): Promise<boolean> {
	return (await read("SELECT 1 FROM pim_runtime.conversations WHERE owner_id = $1 AND id = $2 AND parent_conversation_id IS NOT NULL", [ownerId, conversationId])).rows.length > 0;
}

/** The provenance of one `send_to_user` call, by its id: the answer that made it is found among the conversation's entries. Undefined when no such answer is stored. */
export async function provenanceOfCall(read: Read, ownerId: string, conversationId: number, callId: string): Promise<Provenance | undefined> {
	const row = (await read("SELECT record FROM pim_runtime.entries WHERE owner_id = $1 AND conversation_id = $2 AND record LIKE '%\"role\":\"assistant\"%' AND strpos(record, $3) > 0 AND strpos(record, '\"send_to_user\"') > 0 ORDER BY id DESC LIMIT 1", [ownerId, conversationId, JSON.stringify(callId)])).rows[0];
	if (!row) return undefined;
	return (await provenanceOfEntry(read, ownerId, conversationId, JSON.parse(row.record as string) as EntryRecord))[callId];
}
