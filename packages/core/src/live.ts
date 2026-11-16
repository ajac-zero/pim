import type pg from "pg";
import type { Principal } from "./auth.ts";
import { withTenant } from "./db.ts";

/**
 * Live: authorized, account-isolated subscriptions that replay from durable cursors.
 *
 * Nothing here is canonical and nothing is buffered per subscriber beyond a cursor. A subscriber is a cursor into a
 * stream that already exists in PostgreSQL (a family's commits, or the tenant's list events); every delivery reads from
 * that cursor, so a gap is repaired by reading again, a slow client costs a cursor not a queue, and a restarted Live
 * loses nothing. A client gets a consistent start from an HTTP snapshot that names its high-water cursor, then
 * subscribes from it; events at or before the cursor it already has are dropped by their stable ids.
 */
export interface LiveEvent {
	/** Stable across replays: `partition:seq` or the list event id. */
	eventId: string;
	cursor: number;
	version: 1;
	kind: string;
	payload: unknown;
}

export type ResolvedStream = { kind: "chat"; partitionId: string; ownerUserId: string; chatId: string } | { kind: "list" };

export class StreamSource {
	constructor(readonly pool: pg.Pool) {}

	async resolve(tenantId: string, stream: string): Promise<ResolvedStream | undefined> {
		if (stream === "list") return { kind: "list" };
		const match = /^chat:([A-Za-z0-9_-]{1,64})$/.exec(stream);
		if (!match) return undefined;
		const row = await withTenant(this.pool, tenantId, (q) => q.get<{ partition_id: string; created_by: string }>("SELECT partition_id, created_by FROM app.chats WHERE tenant_id = $1 AND chat_id = $2", tenantId, match[1]), { readOnly: true });
		return row === undefined ? undefined : { kind: "chat", partitionId: row.partition_id, ownerUserId: row.created_by, chatId: match[1]! };
	}

	async highWater(tenantId: string, stream: ResolvedStream): Promise<number> {
		return withTenant(
			this.pool,
			tenantId,
			async (q) => {
				if (stream.kind === "chat") return (await q.get<{ n: number }>("SELECT next_seq - 1 AS n FROM rt.partitions WHERE partition_id = $1", stream.partitionId))!.n;
				return ((await q.get<{ n: number }>("SELECT next_cursor - 1 AS n FROM app.view_streams WHERE tenant_id = $1 AND stream = 'list'", tenantId))?.n ?? 0) as number;
			},
			{ readOnly: true },
		);
	}

	/** Events after `cursor`, oldest first, plus the oldest cursor still retained (events before it were pruned). */
	async readAfter(tenantId: string, stream: ResolvedStream, cursor: number, limit: number): Promise<{ events: LiveEvent[]; oldest: number | null }> {
		return withTenant(
			this.pool,
			tenantId,
			async (q) => {
				if (stream.kind === "chat") {
					const rows = await q.all<{ seq: number; summary: unknown }>("SELECT seq, summary FROM rt.commits WHERE partition_id = $1 AND seq > $2 ORDER BY seq LIMIT $3", stream.partitionId, cursor, limit);
					const oldest = (await q.get<{ n: number | null }>("SELECT min(seq) AS n FROM rt.commits WHERE partition_id = $1", stream.partitionId))?.n ?? null;
					return { events: rows.map((row) => ({ eventId: `${stream.partitionId}:${row.seq}`, cursor: row.seq, version: 1 as const, kind: "commit", payload: row.summary })), oldest };
				}
				const rows = await q.all<{ cursor: number; event_id: string; version: 1; kind: string; payload: unknown }>("SELECT cursor, event_id, version, kind, payload FROM app.view_events WHERE tenant_id = $1 AND stream = 'list' AND cursor > $2 ORDER BY cursor LIMIT $3", tenantId, cursor, limit);
				const oldest = (await q.get<{ n: number | null }>("SELECT min(cursor) AS n FROM app.view_events WHERE tenant_id = $1 AND stream = 'list'", tenantId))?.n ?? null;
				return { events: rows.map((row) => ({ eventId: row.event_id, cursor: row.cursor, version: 1 as const, kind: row.kind, payload: row.payload })), oldest };
			},
			{ readOnly: true },
		);
	}
}

export type ServerMessage =
	| { type: "subscribed"; stream: string; cursor: number }
	| { type: "snapshot_required"; stream: string; highWater: number; reason: "no_cursor" | "retention" | "ahead" }
	| { type: "events"; stream: string; events: LiveEvent[]; cursor: number; coalesced?: boolean }
	| { type: "error"; stream?: string; code: string; message: string };

export interface SessionOptions {
	/** The most streams one connection may follow: only what is visible is live. */
	maxStreams?: number;
	batch?: number;
	/** True while the connection's send buffer is full: the cursor does not advance and nothing is queued. */
	backpressured?: () => boolean;
	/** Whether this person may read the stream. */
	mayRead: (principal: Principal, stream: ResolvedStream) => Promise<boolean>;
}

interface Sub {
	stream: string;
	resolved: ResolvedStream;
	cursor: number;
	reading: boolean;
}

/** One connection's subscriptions. Transport-agnostic: `send` is a WebSocket, a test or an SSE writer. */
export class LiveSession {
	readonly subs = new Map<string, Sub>();
	closed = false;

	constructor(
		readonly source: StreamSource,
		readonly principal: Principal,
		readonly send: (message: ServerMessage) => void,
		readonly options: SessionOptions,
	) {}

	/** With a cursor the client already holds a snapshot at it; without, it is told to fetch one and where it ends. */
	async subscribe(stream: string, cursor?: number): Promise<void> {
		const { tenantId } = this.principal;
		if (!this.subs.has(stream) && this.subs.size >= (this.options.maxStreams ?? 25)) return this.send({ type: "error", stream, code: "too_many_streams", message: "Unsubscribe from a stream you are not showing first" });
		const resolved = await this.source.resolve(tenantId, stream);
		// A stream another account owns resolves to nothing: its existence is not revealed.
		if (resolved === undefined || !(await this.options.mayRead(this.principal, resolved))) return this.send({ type: "error", stream, code: "not_found", message: "No such stream" });
		const high = await this.source.highWater(tenantId, resolved);
		if (cursor === undefined) return this.send({ type: "snapshot_required", stream, highWater: high, reason: "no_cursor" });
		if (cursor > high) return this.send({ type: "snapshot_required", stream, highWater: high, reason: "ahead" });
		this.subs.set(stream, { stream, resolved, cursor, reading: false });
		this.send({ type: "subscribed", stream, cursor });
		await this.pump(stream);
	}

	unsubscribe(stream: string): void {
		this.subs.delete(stream);
	}

	close(): void {
		this.closed = true;
		this.subs.clear();
	}

	/** Reads from the durable cursor and sends. Safe to call from any wake-up, any number of times. */
	async pump(stream?: string): Promise<void> {
		const subs = stream === undefined ? [...this.subs.values()] : [this.subs.get(stream)].filter((s): s is Sub => s !== undefined);
		for (const sub of subs) {
			if (this.closed || sub.reading || this.options.backpressured?.()) continue;
			sub.reading = true;
			try {
				for (;;) {
					if (this.closed || this.options.backpressured?.() || this.subs.get(sub.stream) !== sub) break;
					const { events, oldest } = await this.source.readAfter(this.principal.tenantId, sub.resolved, sub.cursor, (this.options.batch ?? 200) + 1);
					// Pruned past our cursor: nothing can repair the gap by replay, so the client re-snapshots.
					if (oldest !== null && sub.cursor + 1 < oldest) {
						this.subs.delete(sub.stream);
						this.send({ type: "snapshot_required", stream: sub.stream, highWater: await this.source.highWater(this.principal.tenantId, sub.resolved), reason: "retention" });
						break;
					}
					if (events.length === 0) break;
					const more = events.length > (this.options.batch ?? 200);
					const page = more ? events.slice(0, -1) : events;
					// A full page means the client is behind by at least a page: merge it, so catching up costs one event per page.
					const coalesce = more ? coalesced(page) : undefined;
					const out = coalesce ?? page;
					sub.cursor = page.at(-1)!.cursor;
					this.send({ type: "events", stream: sub.stream, events: out, cursor: sub.cursor, ...(coalesce ? { coalesced: true } : {}) });
					if (!more) break;
				}
			} finally {
				sub.reading = false;
			}
		}
	}
}

type Change = { t: string; id: number; c?: number; s?: string };

/** Merges a long run of commit events into one: the union of what changed (latest state per record) at the last cursor. Lossless at the level of "which records to re-read". */
export function coalesced(events: LiveEvent[]): LiveEvent[] {
	const first = events[0]!;
	const last = events.at(-1)!;
	if (events.some((e) => e.kind !== "commit")) return events;
	const latest = new Map<string, Change>();
	for (const event of events) for (const change of event.payload as Change[]) latest.set(`${change.t}:${change.id}`, change);
	return [{ eventId: `${first.eventId}..${last.eventId}`, cursor: last.cursor, version: 1, kind: "commit.coalesced", payload: { from: first.cursor, to: last.cursor, changes: [...latest.values()] } }];
}

/**
 * Polls the distinct streams that have subscribers, one cheap high-water read per stream per tick, and pumps the
 * sessions that are behind. A hint (NATS) calls `wake()` to make that happen sooner; without hints the poll alone is correct.
 */
export class LiveHub {
	readonly sessions = new Set<LiveSession>();
	#timer: ReturnType<typeof setInterval> | undefined;
	#busy = false;

	constructor(
		readonly source: StreamSource,
		readonly pollMs = 250,
	) {}

	start(): void {
		this.#timer = setInterval(() => void this.tick(), this.pollMs);
	}

	stop(): void {
		if (this.#timer) clearInterval(this.#timer);
	}

	wake(): void {
		void this.tick();
	}

	async tick(): Promise<void> {
		if (this.#busy) return;
		this.#busy = true;
		try {
			const marks = new Map<string, number>();
			for (const session of this.sessions) {
				for (const sub of session.subs.values()) {
					const key = `${session.principal.tenantId}\u0000${sub.stream}`;
					let high = marks.get(key);
					if (high === undefined) {
						high = await this.source.highWater(session.principal.tenantId, sub.resolved).catch(() => -1);
						marks.set(key, high);
					}
					if (high > sub.cursor) await session.pump(sub.stream).catch(() => undefined);
				}
			}
		} finally {
			this.#busy = false;
		}
	}
}

/** The default rule: a person reads their own chats and the list of them; sharing extends it through the authorization layer. */
export const ownerMayRead: SessionOptions["mayRead"] = async (principal, stream) => stream.kind === "list" || stream.ownerUserId === principal.userId;
