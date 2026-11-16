/**
 * Idempotent projection of committed runtime truth into the read models and the live event log.
 *
 * The projector reads `runtime_outbox` and writes only `pim_projection`. It has no handle on tools, models
 * or billing, so replaying history cannot repeat an effect. Each outbox commit is applied in one
 * transaction guarded by `(partition_id, commit_seq, projection_version)`, so applying it twice, or from
 * two projector processes, changes nothing the second time.
 */
import type { JsonValue } from "@earendil-works/pi-ai";
import { projectEntries } from "@pim/shared/transcript";
import type { Pool, PoolClient } from "pg";
import { type LiveEvent, type MessagePayload, type OutboxCommit, type OutboxEvent, type PulseHint, SIDEBAR_STREAM, chatStream, codingStream } from "../contracts.ts";
import type { Pulse } from "../server/pulse.ts";

const IDENTIFIER = /^[a-z_][a-z0-9_]*(\.[a-z_][a-z0-9_]*)?$/;

export type ProjectorOptions = {
	/** Announces new events after they commit. Optional: a Live service finds them in PostgreSQL either way. */
	pulse?: Pulse;
	/** Bumped when a projection's logic changes, so old and new rows can be told apart. */
	projectionVersion?: number;
	/** The outbox table, owned by v2-runtime. */
	outboxTable?: string;
	/** Events larger than this are announced by seq only; the Live service reads them from the log. */
	maxHintBytes?: number;
	now?: () => number;
};

export type Lag = { partitionId: string; maxCommitSeq: number; projectedSeq: number; lagCommits: number; oldestUnprojectedAgeMs: number };

/** Commit sequences are bigints in PostgreSQL; they stay within a safe integer here. */
const num = (value: string | number | null | undefined) => (value === null || value === undefined ? 0 : Number(value));

export class Projector {
	readonly version: number;
	readonly #pool: Pool;
	readonly #pulse: Pulse | undefined;
	readonly #outbox: string;
	readonly #maxHint: number;
	readonly #now: () => number;

	constructor(pool: Pool, options: ProjectorOptions = {}) {
		this.#pool = pool;
		this.#pulse = options.pulse;
		this.version = options.projectionVersion ?? 1;
		this.#outbox = options.outboxTable ?? "pim_runtime.runtime_outbox";
		if (!IDENTIFIER.test(this.#outbox)) throw new Error(`Not an identifier: ${this.#outbox}`);
		this.#maxHint = options.maxHintBytes ?? 16_384;
		this.#now = options.now ?? Date.now;
	}

	/** Projects every outbox commit of `partitionId` after its watermark, oldest first; how many were applied. */
	async drain(partitionId: string, batch = 200): Promise<number> {
		let applied = 0;
		for (;;) {
			const { rows: mark } = await this.#pool.query<{ projected_seq: string }>("SELECT projected_seq FROM pim_projection.projection_watermarks WHERE partition_id = $1 AND projection_version = $2", [partitionId, this.version]);
			const after = num(mark[0]?.projected_seq);
			const commits = await this.#read(partitionId, after, batch);
			for (const commit of commits) if (await this.apply(commit)) applied++;
			if (commits.length < batch) return applied;
		}
	}

	/** Projects every partition that has outbox rows. */
	async drainAll(): Promise<number> {
		const { rows } = await this.#pool.query<{ partition_id: string }>(`SELECT DISTINCT partition_id FROM ${this.#outbox}`);
		let applied = 0;
		for (const row of rows) applied += await this.drain(row.partition_id);
		return applied;
	}

	async #read(partitionId: string, after: number, limit: number): Promise<OutboxCommit[]> {
		const { rows } = await this.#pool.query(
			`SELECT partition_id, commit_seq, tenant_id, payload, created_at FROM ${this.#outbox} WHERE partition_id = $1 AND commit_seq > $2 ORDER BY commit_seq LIMIT $3`,
			[partitionId, after, limit],
		);
		return rows.map((row) => ({ partitionId: row.partition_id, commitSeq: num(row.commit_seq), tenantId: row.tenant_id, events: (row.payload as { events: OutboxEvent[] }).events, createdAt: row.created_at }));
	}

	/** Applies one commit; false when it was applied before. */
	async apply(commit: OutboxCommit): Promise<boolean> {
		const client = await this.#pool.connect();
		const hints: PulseHint[] = [];
		try {
			await client.query("BEGIN");
			// One projector at a time per partition: the watermark row is the lock.
			await client.query("INSERT INTO pim_projection.projection_watermarks (partition_id, projection_version) VALUES ($1, $2) ON CONFLICT DO NOTHING", [commit.partitionId, this.version]);
			await client.query("SELECT 1 FROM pim_projection.projection_watermarks WHERE partition_id = $1 AND projection_version = $2 FOR UPDATE", [commit.partitionId, this.version]);
			const fresh = await client.query("INSERT INTO pim_projection.projection_applied (partition_id, commit_seq, projection_version) VALUES ($1, $2, $3) ON CONFLICT DO NOTHING", [commit.partitionId, commit.commitSeq, this.version]);
			if (fresh.rowCount === 0) {
				await client.query("ROLLBACK");
				return false;
			}
			for (const event of commit.events) await this.#event(client, commit, event, hints);
			await client.query("UPDATE pim_projection.projection_watermarks SET projected_seq = greatest(projected_seq, $3), updated_at = now() WHERE partition_id = $1 AND projection_version = $2", [commit.partitionId, this.version, commit.commitSeq]);
			await client.query("COMMIT");
		} catch (error) {
			await client.query("ROLLBACK").catch(() => {});
			throw error;
		} finally {
			client.release();
		}
		// After the commit, and only a hint: if this is lost, Live finds the rows in PostgreSQL.
		if (this.#pulse) {
			for (const hint of hints) await this.#pulse.publish(hint).catch(() => {});
		}
		return true;
	}

	async #event(client: PoolClient, commit: OutboxCommit, event: OutboxEvent, hints: PulseHint[]): Promise<void> {
		const { tenantId, partitionId, commitSeq } = commit;
		const version = this.version;
		const emit = async (streamKey: string, kind: string, payload: JsonValue, replaceableKey: string | null) => {
			const { rows } = await client.query<{ head_seq: string }>(
				"INSERT INTO pim_projection.live_stream_heads (tenant_id, stream_key, head_seq) VALUES ($1, $2, 1) ON CONFLICT (tenant_id, stream_key) DO UPDATE SET head_seq = live_stream_heads.head_seq + 1 RETURNING head_seq",
				[tenantId, streamKey],
			);
			const seq = num(rows[0]!.head_seq);
			await client.query(
				"INSERT INTO pim_projection.live_event_log (tenant_id, stream_key, stream_seq, partition_id, commit_seq, projection_version, replaceable_key, event_kind, payload) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)",
				[tenantId, streamKey, seq, partitionId, commitSeq, version, replaceableKey, kind, JSON.stringify(payload)],
			);
			const live: LiveEvent = { streamKey, seq, commitSeq, kind, replaceableKey, payload };
			hints.push({ tenantId, streamKey, seq, ...(JSON.stringify(live).length <= this.#maxHint ? { event: live } : {}) });
		};
		switch (event.kind) {
			case "chat.entry": {
				const kind = event.stream ?? "chat";
				for (const message of projectEntries([event.entry])) {
					const partial = event.partial === true;
					await client.query(
						`INSERT INTO pim_projection.chat_transcript_projection (tenant_id, stream_kind, chat_id, entry_id, position, partial, message, partition_id, commit_seq, projection_version)
						 VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
						 ON CONFLICT (tenant_id, stream_kind, chat_id, entry_id) DO UPDATE SET partial = excluded.partial, message = excluded.message, partition_id = excluded.partition_id, commit_seq = excluded.commit_seq, projection_version = excluded.projection_version
						 WHERE chat_transcript_projection.commit_seq <= excluded.commit_seq`,
						[tenantId, kind, event.chatId, message.id, Number(event.entry.id), partial, JSON.stringify(message), partitionId, commitSeq, version],
					);
					const payload: MessagePayload = { message, partial };
					// Streaming partials of one message replace each other; the committed message is canonical.
					await emit(kind === "chat" ? chatStream(event.chatId) : codingStream(event.chatId), partial ? "message.partial" : "message", payload as unknown as JsonValue, partial ? `entry:${message.id}` : null);
				}
				return;
			}
			case "chat.ui_state": {
				await client.query(
					"UPDATE pim_projection.chat_transcript_projection SET ui_state = ui_state || $4::jsonb WHERE tenant_id = $1 AND stream_kind = 'chat' AND chat_id = $2 AND entry_id = $3",
					[tenantId, event.chatId, event.entryId, JSON.stringify({ [event.block]: event.state })],
				);
				await emit(chatStream(event.chatId), "ui_state", { entryId: event.entryId, block: event.block, state: event.state }, `ui:${event.entryId}:${event.block}`);
				return;
			}
			case "chat.meta": {
				const { rows } = await client.query(
					`INSERT INTO pim_projection.sidebar_session_projection (tenant_id, chat_id, title, busy, unread, stalled, updated_at, summary, partition_id, commit_seq, projection_version)
					 VALUES ($1, $2, $3::text, coalesce($4::boolean, false), coalesce($5::boolean, false), coalesce($6::boolean, false), coalesce($7::bigint, 0), $8::jsonb, $9, $10, $11)
					 ON CONFLICT (tenant_id, chat_id) DO UPDATE SET
					   title = CASE WHEN $12::boolean THEN excluded.title ELSE sidebar_session_projection.title END,
					   busy = coalesce($4::boolean, sidebar_session_projection.busy), unread = coalesce($5::boolean, sidebar_session_projection.unread), stalled = coalesce($6::boolean, sidebar_session_projection.stalled),
					   updated_at = greatest(sidebar_session_projection.updated_at, coalesce($7::bigint, 0)), summary = sidebar_session_projection.summary || excluded.summary,
					   partition_id = excluded.partition_id, commit_seq = excluded.commit_seq, projection_version = excluded.projection_version
					 WHERE sidebar_session_projection.commit_seq <= excluded.commit_seq
					 RETURNING chat_id, title, busy, unread, stalled, updated_at, summary`,
					[tenantId, event.chatId, event.title ?? null, event.busy ?? null, event.unread ?? null, event.stalled ?? null, event.updatedAt ?? null, JSON.stringify(event.summary ?? {}), partitionId, commitSeq, version, event.title !== undefined],
				);
				const row = rows[0];
				if (row) await emit(SIDEBAR_STREAM, "sidebar.summary", sidebarRow(row), `chat:${event.chatId}`);
				return;
			}
			case "coding.thread": {
				const { rows } = await client.query(
					`INSERT INTO pim_projection.coding_thread_projection (tenant_id, thread_id, title, harness, state, running, unread, updated_at, summary, partition_id, commit_seq, projection_version)
					 VALUES ($1, $2, $3::text, $4::text, coalesce($5::text, 'idle'), coalesce($6::boolean, false), coalesce($7::boolean, false), coalesce($8::bigint, 0), $9::jsonb, $10, $11, $12)
					 ON CONFLICT (tenant_id, thread_id) DO UPDATE SET
					   title = CASE WHEN $13::boolean THEN excluded.title ELSE coding_thread_projection.title END, harness = coalesce($4::text, coding_thread_projection.harness),
					   state = coalesce($5::text, coding_thread_projection.state), running = coalesce($6::boolean, coding_thread_projection.running), unread = coalesce($7::boolean, coding_thread_projection.unread),
					   updated_at = greatest(coding_thread_projection.updated_at, coalesce($8::bigint, 0)), summary = coding_thread_projection.summary || excluded.summary,
					   partition_id = excluded.partition_id, commit_seq = excluded.commit_seq, projection_version = excluded.projection_version
					 WHERE coding_thread_projection.commit_seq <= excluded.commit_seq
					 RETURNING thread_id, title, harness, state, running, unread, updated_at, summary`,
					[tenantId, event.threadId, event.title ?? null, event.harness ?? null, event.state ?? null, event.running ?? null, event.unread ?? null, event.updatedAt ?? null, JSON.stringify(event.summary ?? {}), partitionId, commitSeq, version, event.title !== undefined],
				);
				const row = rows[0];
				if (!row) return;
				const payload = { threadId: row.thread_id, title: row.title, harness: row.harness, state: row.state, running: row.running, unread: row.unread, updatedAt: num(row.updated_at), summary: row.summary } as JsonValue;
				await emit(codingStream(event.threadId), "coding.thread", payload, "thread");
				// The compact line the sidebar shows for it, coalesced like a chat's.
				await emit(SIDEBAR_STREAM, "coding.summary", payload, `coding:${event.threadId}`);
				return;
			}
		}
	}

	/** Forgets every view and the log, then projects all of the outbox again. Clients with cursors into the old log are told to take a snapshot. */
	async rebuild(): Promise<number> {
		const client = await this.#pool.connect();
		try {
			await client.query("SELECT pg_advisory_lock(hashtext('pim_projection.rebuild'))");
			await client.query(
				"TRUNCATE pim_projection.chat_transcript_projection, pim_projection.sidebar_session_projection, pim_projection.coding_thread_projection, pim_projection.live_event_log, pim_projection.live_stream_heads, pim_projection.projection_applied, pim_projection.projection_watermarks",
			);
		} finally {
			await client.query("SELECT pg_advisory_unlock(hashtext('pim_projection.rebuild'))").catch(() => {});
			client.release();
		}
		return this.drainAll();
	}

	/** How far behind the outbox each partition's projection is, in commits and in the age of its oldest unprojected commit. */
	async lag(): Promise<Lag[]> {
		const { rows } = await this.#pool.query(
			`SELECT o.partition_id, max(o.commit_seq) AS max_seq, coalesce(w.projected_seq, 0) AS projected,
			        min(o.created_at) FILTER (WHERE o.commit_seq > coalesce(w.projected_seq, 0)) AS oldest
			 FROM ${this.#outbox} o LEFT JOIN pim_projection.projection_watermarks w ON w.partition_id = o.partition_id AND w.projection_version = $1
			 GROUP BY o.partition_id, w.projected_seq ORDER BY o.partition_id`,
			[this.version],
		);
		return rows.map((row) => ({
			partitionId: row.partition_id,
			maxCommitSeq: num(row.max_seq),
			projectedSeq: num(row.projected),
			lagCommits: Math.max(0, num(row.max_seq) - num(row.projected)),
			oldestUnprojectedAgeMs: row.oldest ? Math.max(0, this.#now() - new Date(row.oldest).getTime()) : 0,
		}));
	}
}

function sidebarRow(row: { chat_id: string; title: string | null; busy: boolean; unread: boolean; stalled: boolean; updated_at: string; summary: JsonValue }): JsonValue {
	return { chatId: row.chat_id, title: row.title, busy: row.busy, unread: row.unread, stalled: row.stalled, updatedAt: num(row.updated_at), summary: row.summary };
}
