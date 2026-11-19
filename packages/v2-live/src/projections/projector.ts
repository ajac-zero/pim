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
import { serializeCursor } from "@pim/v2-contracts/live-seam";
import type { PoolClient, Pool } from "pg";
import { type OutboxPayloads, type OwnerId, type RuntimeOutboxEvent, SIDEBAR_TOPIC, PROJECTED_KINDS, chatTopic, codingTopic } from "../contracts.ts";
import { withOwner } from "../owner-tx.ts";
import { type CommitUnit, type OutboxSource, tableOutboxSource } from "./outbox-source.ts";
import type { Pulse } from "../server/pulse.ts";

const TABLES = ["chat_transcript_projection", "sidebar_session_projection", "coding_thread_projection", "live_event_log", "live_stream_heads", "projection_applied", "projection_watermarks"];

export type ProjectorOptions = {
	/** Announces new events after they commit. Optional: a Live service finds them in PostgreSQL either way. */
	pulse?: Pulse;
	/** The projection's version: the outbox events it projects are those stamped with it. Bumped when a projection's logic changes. */
	projectionVersion?: number;
	/** Where committed runtime truth is read from. Default: the rows of `pim_runtime.runtime_outbox` taken as Live's events. */
	source?: OutboxSource;
	now?: () => number;
};

export type Lag = { ownerId: string; partitionId: string; maxCommitSeq: number; projectedSeq: number; lagCommits: number; oldestUnprojectedAgeMs: number };

type Emitted = { kind: string; data: JsonValue; replaceableKey: string | null };

const num = (value: string | number | null | undefined) => (value === null || value === undefined ? 0 : Number(value));

/**
 * `value` without U+0000, which PostgreSQL's text and jsonb refuse. The runtime keeps records as text that may hold one, such as a tool's dump of a
 * PDF; projecting it as is would fail that commit on every attempt and leave its partition's chats frozen.
 */
function withoutNul(value: unknown): unknown {
	if (typeof value === "string") return value.includes("\u0000") ? value.replaceAll("\u0000", "") : value;
	if (Array.isArray(value)) return value.map(withoutNul);
	if (typeof value === "object" && value !== null && !(value instanceof Date)) return Object.fromEntries(Object.entries(value).map(([k, v]) => [withoutNul(k), withoutNul(v)]));
	return value;
}

export class Projector {
	readonly version: number;
	readonly #pool: Pool;
	readonly #pulse: Pulse | undefined;
	readonly #source: OutboxSource;
	readonly #now: () => number;

	constructor(pool: Pool, options: ProjectorOptions = {}) {
		this.#pool = pool;
		this.#pulse = options.pulse;
		this.version = options.projectionVersion ?? 1;
		this.#source = options.source ?? tableOutboxSource(pool);
		this.#now = options.now ?? Date.now;
	}

	/** Projects the commits of one partition after its watermark, in order, until the source has none next; how many were applied. */
	async drain(ownerId: string, partitionId: string, batch = 200): Promise<number> {
		let applied = 0;
		for (;;) {
			const mark = await withOwner(this.#pool, ownerId, async (client) => {
				const marked = await client.query<{ projected_seq: string }>("SELECT projected_seq FROM pim_projection.projection_watermarks WHERE partition_id = $1 AND projection_version = $2", [partitionId, this.version]);
				return num(marked.rows[0]?.projected_seq);
			});
			const commits = await this.#source.commitsAfter(ownerId, partitionId, this.version, mark, batch);
			let expected = mark;
			for (const commit of commits) {
				// Gapless: the next commit is the next number. A hole is a commit not visible yet; it is waited for.
				if (Number(commit.commitSeq) !== expected + 1) return applied;
				if (await this.#applyCommit(ownerId, partitionId, commit)) applied++;
				expected++;
			}
			if (commits.length < batch) return applied;
		}
	}

	/** Projects every partition the source has commits for. A partition that fails waits for the next pass without holding back the others, whose failures are thrown together after them. */
	async drainAll(): Promise<number> {
		let applied = 0;
		const failures: unknown[] = [];
		for (const { ownerId, partitionId } of await this.#source.partitions(this.version)) {
			try {
				applied += await this.drain(ownerId, partitionId);
			} catch (error) {
				failures.push(error);
			}
		}
		if (failures.length === 1) throw failures[0];
		if (failures.length > 1) throw new AggregateError(failures, `${failures.length} partitions could not be projected`);
		return applied;
	}

	/** Applies one event as a commit of its own; false when it was applied before or is not one Live projects. */
	async apply(event: RuntimeOutboxEvent): Promise<boolean> {
		return this.#applyCommit(event.ownerId, event.partitionId, { commitSeq: event.commitSeq, committedAt: new Date(event.committedAt), events: [event] });
	}

	/** Applies every event of a commit in one transaction; false when the commit was applied before. */
	async #applyCommit(ownerId: string, partitionId: string, commit: CommitUnit): Promise<boolean> {
		const events = commit.events.filter((event) => event.projectionVersion === this.version);
		if (events.length === 0 && commit.events.length > 0) return false;
		const hints: { topic: string; cursor: string }[] = [];
		const done = await withOwner(this.#pool, ownerId, async (client) => {
			// One projector at a time per partition: the watermark row is the lock.
			await client.query("INSERT INTO pim_projection.projection_watermarks (owner_id, partition_id, projection_version) VALUES ($1, $2, $3) ON CONFLICT DO NOTHING", [ownerId, partitionId, this.version]);
			await client.query("SELECT 1 FROM pim_projection.projection_watermarks WHERE partition_id = $1 AND projection_version = $2 FOR UPDATE", [partitionId, this.version]);
			const fresh = await client.query("INSERT INTO pim_projection.projection_applied (owner_id, partition_id, commit_seq, projection_version) VALUES ($1, $2, $3, $4) ON CONFLICT DO NOTHING", [ownerId, partitionId, commit.commitSeq.toString(), this.version]);
			if (fresh.rowCount === 0) return false;
			// A commit has one cursor, so a topic gets one row per commit: several events for it fold into a batch.
			const emitted = new Map<string, Emitted[]>();
			for (const event of events) if (PROJECTED_KINDS.includes(event.eventKind)) await this.#project(client, { ...event, payload: withoutNul(event.payload) as RuntimeOutboxEvent["payload"] }, emitted);
			for (const [topic, list] of emitted) hints.push(await this.#log(client, ownerId, partitionId, commit.commitSeq, topic, list));
			await client.query("UPDATE pim_projection.projection_watermarks SET projected_seq = greatest(projected_seq, $3), updated_at = now() WHERE partition_id = $1 AND projection_version = $2", [partitionId, this.version, commit.commitSeq.toString()]);
			return true;
		});
		// After the commit, and only a hint: if this is lost, Live finds the rows in PostgreSQL.
		if (done && this.#pulse) for (const { topic, cursor } of hints) await this.#pulse.publish(topic, { ownerId: ownerId as OwnerId, cursor }).catch(() => {});
		return done;
	}

	async #project(client: PoolClient, event: RuntimeOutboxEvent, emitted: Map<string, Emitted[]>): Promise<void> {
		const { ownerId, partitionId, commitSeq } = event;
		const version = this.version;
		const seq = commitSeq.toString();
		const emit = async (topic: string, kind: string, data: JsonValue, replaceableKey: string | null) => {
			const list = emitted.get(topic) ?? [];
			list.push({ kind, data, replaceableKey });
			emitted.set(topic, list);
		};
		switch (event.eventKind) {
			case "chat.entry": {
				const payload = event.payload as OutboxPayloads["chat.entry"];
				const stream = payload.stream ?? "chat";
				const id = stream === "chat" ? event.publicChatId : (payload.threadId ?? event.publicChatId);
				const partial = payload.partial === true;
				// A final message takes the place of the partial that showed it while it streamed.
				if (payload.replaces !== undefined) await client.query("DELETE FROM pim_projection.chat_transcript_projection WHERE owner_id = $1 AND stream_kind = $2 AND chat_id = $3 AND entry_id = $4 AND partial", [ownerId, stream, id, payload.replaces]);
				for (const message of payload.message ? [payload.message] : projectEntries([payload.entry!])) {
					await client.query(
						`INSERT INTO pim_projection.chat_transcript_projection (owner_id, stream_kind, chat_id, entry_id, position, partial, message, partition_id, commit_seq, projection_version)
						 VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
						 ON CONFLICT (owner_id, stream_kind, chat_id, entry_id) DO UPDATE SET partial = excluded.partial, message = excluded.message, partition_id = excluded.partition_id, commit_seq = excluded.commit_seq, projection_version = excluded.projection_version
						 WHERE chat_transcript_projection.commit_seq <= excluded.commit_seq`,
						[ownerId, stream, id, message.id, payload.position ?? Number(message.id), partial, JSON.stringify(message), partitionId, seq, version],
					);
					// Streaming partials of one message replace each other; the committed message is canonical.
					await emit(stream === "chat" ? chatTopic(id) : codingTopic(id), partial ? "message.partial" : "message", { message, partial, ...(payload.replaces === undefined ? {} : { replaces: payload.replaces }) } as unknown as JsonValue, partial ? `entry:${message.id}` : null);
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
					`INSERT INTO pim_projection.sidebar_session_projection (owner_id, chat_id, title, busy, unread, stalled, updated_at, summary, partition_id, commit_seq, projection_version, queue)
					 VALUES ($1, $2, $3::text, coalesce($4::boolean, false), coalesce($5::boolean, false), coalesce($6::boolean, false), coalesce($7::bigint, 0), $8::jsonb, $9, $10, $11, coalesce($13::jsonb, '[]'::jsonb))
					 ON CONFLICT (owner_id, chat_id) DO UPDATE SET
					   title = CASE WHEN $12::boolean THEN excluded.title ELSE sidebar_session_projection.title END,
					   busy = coalesce($4::boolean, sidebar_session_projection.busy), unread = coalesce($5::boolean, sidebar_session_projection.unread), stalled = coalesce($6::boolean, sidebar_session_projection.stalled),
					   updated_at = greatest(sidebar_session_projection.updated_at, coalesce($7::bigint, 0)), summary = sidebar_session_projection.summary || excluded.summary,
					   queue = coalesce($13::jsonb, sidebar_session_projection.queue),
					   partition_id = excluded.partition_id, commit_seq = excluded.commit_seq, projection_version = excluded.projection_version
					 WHERE sidebar_session_projection.commit_seq <= excluded.commit_seq OR sidebar_session_projection.partition_id <> excluded.partition_id
					 RETURNING chat_id, title, busy, unread, stalled, updated_at, summary`,
					[ownerId, event.publicChatId, p.title ?? null, p.busy ?? null, p.unread ?? null, p.stalled ?? null, p.updatedAt ?? null, JSON.stringify(p.summary ?? {}), partitionId, seq, version, p.title !== undefined, p.queue === undefined ? null : JSON.stringify(p.queue)],
				);
				// The chat on screen shows its queue, and what changed in it.
				if (p.queue !== undefined) await emit(chatTopic(event.publicChatId), "queue", { items: p.queue } as unknown as JsonValue, "queue");
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
	 * Writes what a commit emitted to one topic as the topic's single row for that commit (a cursor names one row per
	 * topic). Several events fold into one `batch`, in the order they were emitted; one goes out as it is.
	 */
	async #log(client: PoolClient, ownerId: string, partitionId: string, commitSeq: bigint, topic: string, list: Emitted[]): Promise<{ topic: string; cursor: string }> {
		const only = list.length === 1 ? list[0]! : undefined;
		const kind = only ? only.kind : "batch";
		const data = only ? only.data : ({ events: list.map((e) => ({ kind: e.kind, data: e.data })) } as JsonValue);
		const key = only ? only.replaceableKey : null;
		const { rows } = await client.query<{ head_seq: string }>(
			"INSERT INTO pim_projection.live_stream_heads (owner_id, topic, head_seq) VALUES ($1, $2, 1) ON CONFLICT (owner_id, topic) DO UPDATE SET head_seq = live_stream_heads.head_seq + 1 RETURNING head_seq",
			[ownerId, topic],
		);
		await client.query(
			"INSERT INTO pim_projection.live_event_log (owner_id, topic, stream_seq, partition_id, commit_seq, projection_version, replaceable_key, event_kind, payload) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)",
			[ownerId, topic, rows[0]!.head_seq, partitionId, commitSeq.toString(), this.version, key, kind, JSON.stringify(data)],
		);
		return { topic, cursor: serializeCursor({ partitionId: partitionId as never, projectionVersion: this.version, commitSeq }) };
	}

	/**
	 * Forgets one owner's views and log and projects their partitions' outbox again, in commit order. Clients with
	 * cursors into the old rows are served from the new ones where their row exists, and told to take a snapshot where it doesn't.
	 */
	async rebuild(ownerId: string): Promise<number> {
		await withOwner(this.#pool, ownerId, async (client) => {
			for (const table of TABLES) await client.query(`DELETE FROM pim_projection.${table}`);
		});
		let applied = 0;
		for (const partitionId of await this.#source.partitionsOf(ownerId, this.version)) applied += await this.drain(ownerId, partitionId);
		return applied;
	}

	/** How far behind the outbox each partition's projection is, in commits and in the age of its oldest unprojected commit. */
	async lag(): Promise<Lag[]> {
		const lags: Lag[] = [];
		for (const group of await this.#source.heads(this.version)) {
			const projected = await withOwner(this.#pool, group.ownerId, async (client) => {
				const mark = await client.query<{ projected_seq: string }>("SELECT projected_seq FROM pim_projection.projection_watermarks WHERE partition_id = $1 AND projection_version = $2", [group.partitionId, this.version]);
				return num(mark.rows[0]?.projected_seq);
			});
			const oldest = await this.#source.oldestAfter(group.ownerId, group.partitionId, this.version, projected);
			lags.push({ ownerId: group.ownerId, partitionId: group.partitionId, maxCommitSeq: group.maxSeq, projectedSeq: projected, lagCommits: Math.max(0, group.maxSeq - projected), oldestUnprojectedAgeMs: oldest ? Math.max(0, this.#now() - oldest.getTime()) : 0 });
		}
		return lags;
	}
}
