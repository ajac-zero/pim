/**
 * What `@pim/v2-live`'s projector reads from the runtime. The runtime's outbox says which records a commit changed
 * (`pim_runtime.runtime_outbox`: one row per conversation, `payload` a list of references); Live projects the records
 * themselves. This reads them, as the owner, from the runtime's canonical tables and turns each commit into the events
 * Live projects:
 *
 * - a committed entry becomes `chat.entry`, and an assistant entry replaces the partial that showed it streaming;
 * - a change of the conversation's live document becomes the in-flight answer as a partial `chat.entry`, and `chat.meta` with `busy`;
 * - a forked conversation's first commit adds the entries it inherits from its parent as `chat.entry` too;
 * - every conversation a commit touched gets `chat.meta` with when it last changed;
 * - a commit that answers, compacts or resets a conversation says in `chat.meta` how many tokens its context holds now (`contextTokens`), and which model answered (`contextModel`).
 *
 * A commit is a row of `pim_runtime.commit_receipts`, which every commit writes, so commits are gapless even when one
 * changed no conversation and has no outbox row: it is returned with no events and the watermark still moves.
 */
import type { EntryRecord } from "@earendil-works/pi-durable";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import type { Message } from "@earendil-works/pi-ai";
import { calculateContextTokens, estimateMessageTokens } from "@earendil-works/pi-ai/utils/estimate";
import { OwnerId, type PartitionId, type PublicChatId } from "@pim/v2-contracts/identity";
import type { RuntimeOutboxEvent } from "@pim/v2-contracts/runtime-seam";
import { Db } from "@pim/v2-runtime/db";
import { PgPiStorage } from "@pim/v2-runtime/storage";
import { ROOM_POST, type Provenance } from "@pim/shared/transcript";
import { onlyNative, provenanceOfEntry } from "./send-provenance.ts";
import { withOwner } from "@pim/v2-live/owner-tx";
import type { CommitUnit, OutboxSource } from "@pim/v2-live/projections/outbox-source";
import type { Pool } from "pg";

type OutboxRow = { commit_seq: string; ordinal: number; public_chat_id: string; conversation_id: string; payload: string };
type Change = { type: string; id: number; conversationId?: number; kind?: string };

/** The id a streaming answer's partial has in the transcript: negative, so it can't be an entry's, and one per conversation. */
export const partialId = (conversationId: number) => -conversationId;

const isAssistant = (entry: EntryRecord) => (entry.model?.[0] as { role?: string } | undefined)?.role === "assistant";

/** Messages that pi-durable leaves out of the context a model is sent: an answer that failed or was cut off. */
const counts = (message: Message) => !(message.role === "assistant" && (message.stopReason === "error" || message.stopReason === "aborted" || message.stopReason === "deferred"));

/**
 * How many tokens a request over these entries would hold, as pi-durable counts them when it decides to compact (`estimateContext`): what the newest answer after `after` reported
 * as the size of its request and its reply, plus an estimate of what was added since. Without such an answer, an estimate of every message, when `entries` are the whole context;
 * otherwise (a few entries of a commit) undefined, since what came before them is not known.
 */
export function contextTokens(entries: readonly EntryRecord[], { after = Number.NEGATIVE_INFINITY, whole = false } = {}): number | undefined {
	let trailing = 0;
	for (let index = entries.length - 1; index >= 0; index--) {
		const messages = (entries[index]!.model ?? []).filter(counts);
		const measured = entries[index]!.id > after ? messages.findLastIndex((m) => m.role === "assistant" && calculateContextTokens(m.usage) > 0) : -1;
		const estimate = (list: readonly Message[]) => list.reduce((sum, m) => sum + estimateMessageTokens(m), 0);
		if (measured >= 0) return calculateContextTokens((messages[measured] as Extract<Message, { role: "assistant" }>).usage) + estimate(messages.slice(measured + 1)) + trailing;
		trailing += estimate(messages);
	}
	return whole ? trailing : undefined;
}

/** The runtime source over a pool that connects as a member of `pim_live`. */
export function runtimeOutboxSource(pool: Pool): OutboxSource {
	const db = new Db(pool);
	return {
		async partitions() {
			const { rows } = await pool.query<{ owner_id: string; partition_id: string }>("SELECT owner_id, partition_id FROM pim_runtime.live_partitions()");
			return rows.map((row) => ({ ownerId: row.owner_id, partitionId: row.partition_id }));
		},
		async partitionsOf(ownerId) {
			return withOwner(pool, ownerId, async (client) => {
				const { rows } = await client.query<{ partition_id: string }>("SELECT DISTINCT partition_id FROM pim_runtime.commit_receipts WHERE owner_id = $1 ORDER BY partition_id", [ownerId]);
				return rows.map((row) => row.partition_id);
			});
		},
		async heads() {
			const { rows } = await pool.query<{ owner_id: string; partition_id: string; last_seq: string }>("SELECT owner_id, partition_id, last_seq FROM pim_runtime.live_partitions()");
			return rows.map((row) => ({ ownerId: row.owner_id, partitionId: row.partition_id, maxSeq: Number(row.last_seq) }));
		},
		async oldestAfter(ownerId, partitionId, _version, after) {
			return withOwner(pool, ownerId, async (client) => {
				const { rows } = await client.query<{ oldest: Date | null }>("SELECT min(committed_at) AS oldest FROM pim_runtime.commit_receipts WHERE owner_id = $1 AND partition_id = $2 AND commit_seq > $3", [ownerId, partitionId, after]);
				return rows[0]?.oldest ?? null;
			});
		},
		async commitsAfter(ownerId, partitionId, version, after, limit) {
			const owner = OwnerId.parse(ownerId);
			const { receipts, outbox } = await withOwner(pool, ownerId, async (client) => {
				const receipts = await client.query<{ commit_seq: string; committed_at: Date }>(
					"SELECT commit_seq, committed_at FROM pim_runtime.commit_receipts WHERE owner_id = $1 AND partition_id = $2 AND commit_seq > $3 ORDER BY commit_seq LIMIT $4",
					[ownerId, partitionId, after, limit],
				);
				if (receipts.rows.length === 0) return { receipts: receipts.rows, outbox: [] as OutboxRow[] };
				const last = receipts.rows[receipts.rows.length - 1]!.commit_seq;
				const outbox = await client.query<OutboxRow>(
					"SELECT commit_seq, ordinal, public_chat_id, conversation_id, payload FROM pim_runtime.runtime_outbox WHERE owner_id = $1 AND partition_id = $2 AND projection_version = $3 AND commit_seq > $4 AND commit_seq <= $5 ORDER BY commit_seq, ordinal",
					[ownerId, partitionId, version, after, last],
				);
				return { receipts: receipts.rows, outbox: outbox.rows };
			});
			const byCommit = new Map<string, OutboxRow[]>();
			for (const row of outbox) byCommit.set(row.commit_seq, [...(byCommit.get(row.commit_seq) ?? []), row]);
			const storage = PgPiStorage.forReading(db, owner, partitionId);
			const commits: CommitUnit[] = [];
			for (const receipt of receipts) {
				const events: RuntimeOutboxEvent[] = [];
				for (const row of byCommit.get(receipt.commit_seq) ?? []) {
					events.push(...(await translate(pool, storage, owner, partitionId as PartitionId, version, BigInt(receipt.commit_seq), receipt.committed_at, row)));
				}
				commits.push({ commitSeq: BigInt(receipt.commit_seq), committedAt: receipt.committed_at, events });
			}
			return commits;
		},
	};
}

/** The events of one outbox row: the conversation one commit changed. */
async function translate(pool: Pool, storage: PgPiStorage, ownerId: OwnerId, partitionId: PartitionId, version: number, commitSeq: bigint, committedAt: Date, row: OutboxRow): Promise<RuntimeOutboxEvent[]> {
	const conversationId = Number(row.conversation_id);
	const changes = (JSON.parse(row.payload) as { changes: Change[] }).changes;
	const event = (eventKind: string, payload: Record<string, unknown>): RuntimeOutboxEvent => ({
		partitionId,
		commitSeq,
		projectionVersion: version,
		ownerId,
		publicChatId: row.public_chat_id as PublicChatId,
		conversationId,
		eventKind,
		payload,
		committedAt: committedAt.toISOString(),
	});
	const events: RuntimeOutboxEvent[] = [];
	/** What a committed entry carries beyond itself, worked out where it was written: who is behind each send of an answer, and behind another agent's post in a group chat. */
	const provenanceOf = async (entry: EntryRecord, conversation: number, partial = false): Promise<{ provenance?: Record<string, Provenance>; post?: Provenance }> => {
		const read = (sql: string, params: unknown[]) => withOwner(pool, ownerId, (client) => client.query(sql, params));
		if (isAssistant(entry)) {
			const provenance = await provenanceOfEntry(read, ownerId, conversation, entry, partial);
			return Object.keys(provenance).length > 0 ? { provenance } : {};
		}
		const message = entry.model?.[0];
		const text = message?.role === "user" ? (typeof message.content === "string" ? message.content : message.content.flatMap((part) => (part.type === "text" ? [part.text] : [])).join("\n")) : "";
		if (partial || !ROOM_POST.test(text)) return {};
		const post = (await read("SELECT pim_app.live_post_provenance($1, $2, $3) AS post", [ownerId, conversation, entry.id])).rows[0]?.post as Provenance | null | undefined;
		return post ? { post } : {};
	};
	// A fork starts with what its parent said up to the entry it forked at, which is none of its own entries: the transcript it shows is made of them.
	if (changes.some((c) => c.type === "conversation")) {
		const forked = await withOwner(pool, ownerId, (client) =>
			client.query<{ parent_at: string }>("SELECT parent_at FROM pim_runtime.conversations WHERE owner_id = $1 AND partition_id = $2 AND id = $3 AND parent_conversation_id IS NOT NULL", [ownerId, partitionId, conversationId]),
		);
		if (forked.rows[0]) {
			let cursor: never | undefined;
			do {
				const page = await storage.scanEntries({ conversationId: conversationId as never, order: "ascending", maxEntryId: Number(forked.rows[0].parent_at) as never }, 500, cursor, BACKGROUND_CONTEXT);
				// What the parent's entries recorded is kept only for those the runtime committed itself: an imported entry's model is not known to be the one that answered.
				const own = await onlyNative((sql, params) => withOwner(pool, ownerId, (client) => client.query(sql, params)), ownerId, page.items);
				for (const entry of own) events.push(event("chat.entry", { entry, ...(await provenanceOf(entry, Number(entry.conversationId))) }));
				cursor = page.next as never;
			} while (cursor !== undefined);
		}
	}
	const entryIds = changes.filter((c) => c.type === "entry").map((c) => c.id);
	const written: EntryRecord[] = [];
	if (entryIds.length > 0) {
		const records = await withOwner(pool, ownerId, (client) =>
			client.query<{ record: string }>("SELECT record FROM pim_runtime.entries WHERE owner_id = $1 AND partition_id = $2 AND id = ANY($3::bigint[]) ORDER BY id", [ownerId, partitionId, entryIds]),
		);
		for (const { record } of records.rows) {
			const entry = JSON.parse(record) as EntryRecord;
			written.push(entry);
			events.push(event("chat.entry", { entry, ...(isAssistant(entry) ? { replaces: String(partialId(conversationId)) } : {}), ...(await provenanceOf(entry, conversationId)) }));
		}
	}
	let busy: boolean | undefined;
	let queue: unknown[] | undefined;
	for (const change of changes.filter((c) => c.type === "document.change")) {
		const kind = await documentKind(pool, ownerId, partitionId, change.id);
		// The messages queued behind a run are the conversation's inbox document; the person sees theirs and can change them.
		if (kind === "pi.inbox") {
			queue = ((await storage.document(change.id as never, "current", BACKGROUND_CONTEXT))?.value as { items?: { mode: string }[] } | undefined)?.items?.filter((item) => item.mode !== "write") ?? [];
			continue;
		}
		if (kind !== "pi.live") continue;
		const live = (await storage.document(change.id as never, "current", BACKGROUND_CONTEXT))?.value as LiveState | undefined;
		if (live === undefined) continue;
		busy = live.run !== undefined;
		const message = live.generation?.message;
		if (message !== undefined) {
			const top = await withOwner(pool, ownerId, (client) => client.query<{ top: string | null }>("SELECT max(id) AS top FROM pim_runtime.entries WHERE owner_id = $1 AND conversation_id = $2", [ownerId, conversationId]));
			// The partial sorts after everything committed so far; the answer's own entry takes its place when it commits.
			const partial = { id: partialId(conversationId), kind: "pi.assistant", model: [message] } as unknown as EntryRecord;
			events.push(event("chat.entry", { entry: partial, partial: true, position: Number(top.rows[0]?.top ?? 0) + 1, ...(await provenanceOf(partial, conversationId, true)) }));
		}
	}
	const context = await contextOf(storage, conversationId, written);
	const summary = { ...(queue === undefined ? {} : { queued: queue.length }), ...context };
	if (events.length > 0 || busy !== undefined || queue !== undefined) {
		events.push(event("chat.meta", { updatedAt: committedAt.getTime(), ...(busy === undefined ? {} : { busy }), ...(queue === undefined ? {} : { queue }), ...(Object.keys(summary).length === 0 ? {} : { summary }) }));
	}
	return events;
}

/**
 * What a commit's entries say of the conversation's context: its size, and which model answered last. An answer says how large its request was; a compaction or a reset (an entry that
 * names the first entry of the context, its `head`) changes what the context holds, so the context is read again from there.
 */
async function contextOf(storage: PgPiStorage, conversationId: number, written: readonly EntryRecord[]): Promise<{ contextTokens: number; contextModel?: { provider: string; id: string } } | undefined> {
	const marker = written.findLast((entry) => entry.head !== undefined);
	let tokens: number | undefined;
	if (marker) {
		const entries: EntryRecord[] = [];
		let cursor: never | undefined;
		do {
			const page = await storage.scanEntries({ conversationId: conversationId as never, order: "ascending", minEntryId: marker.head as never }, 500, cursor, BACKGROUND_CONTEXT);
			entries.push(...page.items.filter((entry) => entry.head === undefined || entry.id === marker.id));
			cursor = page.next as never;
		} while (cursor !== undefined);
		tokens = contextTokens(entries, { after: marker.id, whole: true });
	} else tokens = contextTokens(written);
	if (tokens === undefined) return undefined;
	const answer = written.flatMap((entry) => entry.model ?? []).findLast((m): m is Extract<Message, { role: "assistant" }> => m.role === "assistant" && counts(m) && calculateContextTokens(m.usage) > 0);
	return { contextTokens: tokens, ...(answer ? { contextModel: { provider: answer.provider, id: answer.model } } : {}) };
}

type LiveState = { run?: unknown; generation?: { message?: unknown } };

/** What kind of document `id` is (`pi.live`, `pi.inbox`), when it is not retired. */
async function documentKind(pool: Pool, ownerId: OwnerId, partitionId: PartitionId, id: number): Promise<string | undefined> {
	const found = await withOwner(pool, ownerId, (client) =>
		client.query<{ kind: string }>("SELECT record::jsonb->>'kind' AS kind FROM pim_runtime.documents WHERE owner_id = $1 AND partition_id = $2 AND id = $3 AND retired_at IS NULL", [ownerId, partitionId, id]),
	);
	return found.rows[0]?.kind;
}
