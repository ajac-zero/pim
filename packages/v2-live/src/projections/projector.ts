/**
 * Idempotent projection of committed runtime truth into the read models and the live event log.
 *
 * The projector reads `pim_runtime.runtime_outbox` (one `RuntimeOutboxEvent` per commit, `commitSeq` gapless per
 * partition) and writes only `pim_projection`. It has no handle on tools, models or billing, so replaying history
 * cannot repeat an effect. Each commit is applied in one transaction, as its owner, guarded by
 * `(partition_id, commit_seq, projection_version)`: applying it twice, or from two projector processes, changes
 * nothing the second time. A commit is applied only when it is the next one of its partition; a gap waits (and
 * shows as lag) rather than being skipped.
 */
import type { JsonValue } from "@earendil-works/pi-ai";
import { projectEntries } from "@pim/shared/transcript";
import type { PartitionId } from "@pim/v2-contracts/identity";
import { serializeCursor } from "@pim/v2-contracts/live-seam";
import type { PoolClient, Pool } from "pg";
import { type OutboxPayloads, type RuntimeOutboxEvent, SIDEBAR_TOPIC, PROJECTED_KINDS, chatTopic, codingTopic } from "../contracts.ts";
import { withOwner } from "../owner-tx.ts";
import type { Pulse } from "../server/pulse.ts";

const IDENTIFIER = /^[a-z_][a-z0-9_]*(\.[a-z_][a-z0-9_]*)?$/;
const TABLES = ["chat_transcript_projection", "sidebar_session_projection", "coding_thread_projection", "live_event_log", "live_stream_heads", "projection_applied", "projection_watermarks"];

export type ProjectorOptions = {
	/** Announces new events after they commit. Optional: a Live service finds them in PostgreSQL either way. */
	pulse?: Pulse;
	/** The projection's version: the outbox events it projects are those stamped with it. Bumped when a projection's logic changes. */
	projectionVersion?: number;
	/** The outbox table, owned by v2-runtime. */
	outboxTable?: string;
	now?: () => number;
};

export type Lag = { ownerId: string; partitionId: string; maxCommitSeq: number; projectedSeq: number; lagCommits: number; oldestUnprojectedAgeMs: number };

const num = (value: string | number | null | undefined) => (value === null || value === undefined ? 0 : Number(value));

type OutboxRow = { partition_id: string; commit_seq: string; projection_version: number; owner_id: string; public_chat_id: string; conversation_id: number; event_kind: string; payload: Record<string, unknown>; committed_at: Date };
const rowOf = (row: OutboxRow): RuntimeOutboxEvent => ({
	partitionId: row.partition_id as PartitionId,
	commitSeq: BigInt(row.commit_seq),
	projectionVersion: row.projection_version,
	ownerId: row.owner_id as RuntimeOutboxEvent["ownerId"],
	publicChatId: row.public_chat_id as RuntimeOutboxEvent["publicChatId"],
	conversationId: row.conversation_id,
	eventKind: row.event_kind,
	payload: row.payload,
	committedAt: row.committed_at.toISOString(),
});

export class Projector {
	readonly version: number;
	readonly #pool: Pool;
	readonly #pulse: Pulse | undefined;
	readonly #outbox: string;
	readonly #now: () => number;

	constructor(pool: Pool, options: ProjectorOptions = {}) {
		this.#pool = pool;
		this.#pulse = options.pulse;
		this.version = options.projectionVersion ?? 1;
		this.#outbox = options.outboxTable ?? "pim_runtime.runtime_outbox";
		if (!IDENTIFIER.test(this.#outbox)) throw new Error(`Not an identifier: ${this.#outbox}`);
		this.#now = options.now ?? Date.now;
	}

	/** Projects the commits of one partition after its watermark, in order, until the outbox has none next; how many were applied. */
	async drain(ownerId: string, partitionId: string, batch = 200): Promise<number> {
		let applied = 0;
		for (;;) {
			const { mark, rows } = await withOwner(this.#pool, ownerId, async (client) => {
				const marked = await client.query<{ projected_seq: string }>("SELECT projected_seq FROM pim_projection.projection_watermarks WHERE partition_id = $1 AND projection_version = $2", [partitionId, this.version]);
				const mark = num(marked.rows[0]?.projected_seq);
				const read = await client.query<OutboxRow>(`SELECT * FROM ${this.#outbox} WHERE partition_id = $1 AND projection_version = $2 AND commit_seq > $3 ORDER BY commit_seq LIMIT $4`, [partitionId, this.version, mark, batch]);
				return { mark, rows: read.rows };
			});
			let expected = mark;
			for (const row of rows) {
				// Gapless: the next commit is the next number. A hole is a commit not visible yet; it is waited for.
				if (num(row.commit_seq) !== expected + 1) return applied;
				if (await this.apply(rowOf(row))) applied++;
				expected++;
			}
			if (rows.length < batch) return applied;
		}
	}

	/** Every (owner, partition) with outbox rows: read unscoped, which the runtime's grants must allow Live's role. */
	async #partitions(): Promise<{ owner_id: string; partition_id: string }[]> {
		const { rows } = await this.#pool.query<{ owner_id: string; partition_id: string }>(`SELECT DISTINCT owner_id, partition_id FROM ${this.#outbox} WHERE projection_version = $1 ORDER BY owner_id, partition_id`, [this.version]);
		return rows;
	}

	/** Projects every partition that has outbox rows. */
	async drainAll(): Promise<number> {
		let applied = 0;
		for (const { owner_id, partition_id } of await this.#partitions()) applied += await this.drain(owner_id, partition_id);
		return applied;
	}

	/** Applies one commit; false when it was applied before or is not one Live projects. */
	async apply(event: RuntimeOutboxEvent): Promise<boolean> {
		if (event.projectionVersion !== this.version) return false;
		const hints: { topic: string; cursor: string }[] = [];
		const done = await withOwner(this.#pool, event.ownerId, async (client) => {
			// One projector at a time per partition: the watermark row is the lock.
			await client.query("INSERT INTO pim_projection.projection_watermarks (owner_id, partition_id, projection_version) VALUES ($1, $2, $3) ON CONFLICT DO NOTHING", [event.ownerId, event.partitionId, this.version]);
			await client.query("SELECT 1 FROM pim_projection.projection_watermarks WHERE partition_id = $1 AND projection_version = $2 FOR UPDATE", [event.partitionId, this.version]);
			const fresh = await client.query("INSERT INTO pim_projection.projection_applied (owner_id, partition_id, commit_seq, projection_version) VALUES ($1, $2, $3, $4) ON CONFLICT DO NOTHING", [event.ownerId, event.partitionId, event.commitSeq.toString(), this.version]);
			if (fresh.rowCount === 0) return false;
			if (PROJECTED_KINDS.includes(event.eventKind)) await this.#project(client, event, hints);
			await client.query("UPDATE pim_projection.projection_watermarks SET projected_seq = greatest(projected_seq, $3), updated_at = now() WHERE partition_id = $1 AND projection_version = $2", [event.partitionId, this.version, event.commitSeq.toString()]);
			return true;
		});
		// After the commit, and only a hint: if this is lost, Live finds the rows in PostgreSQL.
		if (done && this.#pulse) for (const { topic, cursor } of hints) await this.#pulse.publish(topic, { ownerId: event.ownerId, cursor }).catch(() => {});
		return done;
	}

	async #project(client: PoolClient, event: RuntimeOutboxEvent, hints: { topic: string; cursor: string }[]): Promise<void> {
		const { ownerId, partitionId, commitSeq } = event;
		const version = this.version;
		const cursor = serializeCursor({ partitionId, projectionVersion: version, commitSeq });
		const seq = commitSeq.toString();
		const emit = async (topic: string, kind: string, data: JsonValue, replaceableKey: string | null) => {
			const { rows } = await client.query<{ head_seq: string }>(
				"INSERT INTO pim_projection.live_stream_heads (owner_id, topic, head_seq) VALUES ($1, $2, 1) ON CONFLICT (owner_id, topic) DO UPDATE SET head_seq = live_stream_heads.head_seq + 1 RETURNING head_seq",
				[ownerId, topic],
			);
			await client.query(
				"INSERT INTO pim_projection.live_event_log (owner_id, topic, stream_seq, partition_id, commit_seq, projection_version, replaceable_key, event_kind, payload) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)",
				[ownerId, topic, rows[0]!.head_seq, partitionId, seq, version, replaceableKey, kind, JSON.stringify(data)],
			);
			hints.push({ topic, cursor });
		};
		switch (event.eventKind) {
			case "chat.entry": {
				const payload = event.payload as OutboxPayloads["chat.entry"];
				const stream = payload.stream ?? "chat";
				const id = stream === "chat" ? event.publicChatId : (payload.threadId ?? event.publicChatId);
				const partial = payload.partial === true;
				for (const message of projectEntries([payload.entry])) {
					await client.query(
						`INSERT INTO pim_projection.chat_transcript_projection (owner_id, stream_kind, chat_id, entry_id, position, partial, message, partition_id, commit_seq, projection_version)
						 VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
						 ON CONFLICT (owner_id, stream_kind, chat_id, entry_id) DO UPDATE SET partial = excluded.partial, message = excluded.message, partition_id = excluded.partition_id, commit_seq = excluded.commit_seq, projection_version = excluded.projection_version
						 WHERE chat_transcript_projection.commit_seq <= excluded.commit_seq`,
						[ownerId, stream, id, message.id, Number(payload.entry.id), partial, JSON.stringify(message), partitionId, seq, version],
					);
					// Streaming partials of one message replace each other; the committed message is canonical.
					await emit(stream === "chat" ? chatTopic(id) : codingTopic(id), partial ? "message.partial" : "message", { message, partial } as unknown as JsonValue, partial ? `entry:${message.id}` : null);
				}
				return;
			}
			case "chat.ui_state": {
				const payload = event.payload as OutboxPayloads["chat.ui_state"];
				await client.query("UPDATE pim_projection.chat_transcript_projection SET ui_state = ui_state || $4::jsonb WHERE owner_id = $1 AND stream_kind = 'chat' AND chat_id = $2 AND entry_id = $3", [ownerId, event.publicChatId, payload.entryId, JSON.stringify({ [payload.block]: payload.state })]);
				await emit(chatTopic(event.publicChatId), "ui_state", { entryId: payload.entryId, block: payload.block, state: payload.state }, `ui:${payload.entryId}:${payload.block}`);
				return;
			}
			case "chat.meta": {
				const p = event.payload as OutboxPayloads["chat.meta"];
				const { rows } = await client.query(
					`INSERT INTO pim_projection.sidebar_session_projection (owner_id, chat_id, title, busy, unread, stalled, updated_at, summary, partition_id, commit_seq, projection_version)
					 VALUES ($1, $2, $3::text, coalesce($4::boolean, false), coalesce($5::boolean, false), coalesce($6::boolean, false), coalesce($7::bigint, 0), $8::jsonb, $9, $10, $11)
					 ON CONFLICT (owner_id, chat_id) DO UPDATE SET
					   title = CASE WHEN $12::boolean THEN excluded.title ELSE sidebar_session_projection.title END,
					   busy = coalesce($4::boolean, sidebar_session_projection.busy), unread = coalesce($5::boolean, sidebar_session_projection.unread), stalled = coalesce($6::boolean, sidebar_session_projection.stalled),
					   updated_at = greatest(sidebar_session_projection.updated_at, coalesce($7::bigint, 0)), summary = sidebar_session_projection.summary || excluded.summary,
					   partition_id = excluded.partition_id, commit_seq = excluded.commit_seq, projection_version = excluded.projection_version
					 WHERE sidebar_session_projection.commit_seq <= excluded.commit_seq OR sidebar_session_projection.partition_id <> excluded.partition_id
					 RETURNING chat_id, title, busy, unread, stalled, updated_at, summary`,
					[ownerId, event.publicChatId, p.title ?? null, p.busy ?? null, p.unread ?? null, p.stalled ?? null, p.updatedAt ?? null, JSON.stringify(p.summary ?? {}), partitionId, seq, version, p.title !== undefined],
				);
				const row = rows[0];
				if (row) await emit(SIDEBAR_TOPIC, "sidebar.summary", { chatId: row.chat_id, title: row.title, busy: row.busy, unread: row.unread, stalled: row.stalled, updatedAt: num(row.updated_at), summary: row.summary }, `chat:${event.publicChatId}`);
				return;
			}
			case "coding.thread": {
				const p = event.payload as OutboxPayloads["coding.thread"];
				const { rows } = await client.query(
					`INSERT INTO pim_projection.coding_thread_projection (owner_id, thread_id, title, harness, state, running, unread, updated_at, summary, partition_id, commit_seq, projection_version)
					 VALUES ($1, $2, $3::text, $4::text, coalesce($5::text, 'idle'), coalesce($6::boolean, false), coalesce($7::boolean, false), coalesce($8::bigint, 0), $9::jsonb, $10, $11, $12)
					 ON CONFLICT (owner_id, thread_id) DO UPDATE SET
					   title = CASE WHEN $13::boolean THEN excluded.title ELSE coding_thread_projection.title END, harness = coalesce($4::text, coding_thread_projection.harness),
					   state = coalesce($5::text, coding_thread_projection.state), running = coalesce($6::boolean, coding_thread_projection.running), unread = coalesce($7::boolean, coding_thread_projection.unread),
					   updated_at = greatest(coding_thread_projection.updated_at, coalesce($8::bigint, 0)), summary = coding_thread_projection.summary || excluded.summary,
					   partition_id = excluded.partition_id, commit_seq = excluded.commit_seq, projection_version = excluded.projection_version
					 WHERE coding_thread_projection.commit_seq <= excluded.commit_seq OR coding_thread_projection.partition_id <> excluded.partition_id
					 RETURNING thread_id, title, harness, state, running, unread, updated_at, summary`,
					[ownerId, p.threadId, p.title ?? null, p.harness ?? null, p.state ?? null, p.running ?? null, p.unread ?? null, p.updatedAt ?? null, JSON.stringify(p.summary ?? {}), partitionId, seq, version, p.title !== undefined],
				);
				const row = rows[0];
				if (!row) return;
				const data = { threadId: row.thread_id, title: row.title, harness: row.harness, state: row.state, running: row.running, unread: row.unread, updatedAt: num(row.updated_at), summary: row.summary } as JsonValue;
				await emit(codingTopic(p.threadId), "coding.thread", data, "thread");
				// The compact line the sidebar shows for it, coalesced like a chat's.
				await emit(SIDEBAR_TOPIC, "coding.summary", data, `coding:${p.threadId}`);
				return;
			}
		}
	}

	/**
	 * Forgets one owner's views and log and projects their partitions' outbox again, in commit order. Clients with
	 * cursors into the old rows are served from the new ones where their row exists, and told to take a snapshot where it doesn't.
	 */
	async rebuild(ownerId: string): Promise<number> {
		const partitions = await withOwner(this.#pool, ownerId, async (client) => {
			for (const table of TABLES) await client.query(`DELETE FROM pim_projection.${table}`);
			const { rows } = await client.query<{ partition_id: string }>(`SELECT DISTINCT partition_id FROM ${this.#outbox} WHERE owner_id = $1 AND projection_version = $2 ORDER BY partition_id`, [ownerId, this.version]);
			return rows;
		});
		let applied = 0;
		for (const { partition_id } of partitions) applied += await this.drain(ownerId, partition_id);
		return applied;
	}

	/** How far behind the outbox each partition's projection is, in commits and in the age of its oldest unprojected commit. */
	async lag(): Promise<Lag[]> {
		const { rows } = await this.#pool.query<{ owner_id: string; partition_id: string; max_seq: string }>(`SELECT owner_id, partition_id, max(commit_seq) AS max_seq FROM ${this.#outbox} WHERE projection_version = $1 GROUP BY owner_id, partition_id ORDER BY owner_id, partition_id`, [this.version]);
		const lags: Lag[] = [];
		for (const group of rows) {
			const { projected, oldest } = await withOwner(this.#pool, group.owner_id, async (client) => {
				const mark = await client.query<{ projected_seq: string }>("SELECT projected_seq FROM pim_projection.projection_watermarks WHERE partition_id = $1 AND projection_version = $2", [group.partition_id, this.version]);
				const projected = num(mark.rows[0]?.projected_seq);
				const age = await client.query<{ oldest: Date | null }>(`SELECT min(committed_at) AS oldest FROM ${this.#outbox} WHERE partition_id = $1 AND projection_version = $2 AND commit_seq > $3`, [group.partition_id, this.version, projected]);
				return { projected, oldest: age.rows[0]?.oldest ?? null };
			});
			lags.push({ ownerId: group.owner_id, partitionId: group.partition_id, maxCommitSeq: num(group.max_seq), projectedSeq: projected, lagCommits: Math.max(0, num(group.max_seq) - projected), oldestUnprojectedAgeMs: oldest ? Math.max(0, this.#now() - oldest.getTime()) : 0 });
		}
		return lags;
	}
}
