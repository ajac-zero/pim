/**
 * Live's core, independent of any socket library: the bridge from Pulse hints to gap-free, replayable
 * delivery from PostgreSQL, one authenticated connection at a time.
 *
 * Nothing here is owned by a Harness and nothing is sticky: a connection's whole state is its cursors, so any
 * replica can serve a reconnect. Clients speak the canonical frames and cursors of @pim/v2-contracts; a cursor
 * (`partition:projectionVersion:commitSeq`) names one row of a topic's log, whose private dense `stream_seq` is
 * how this service tells a hole from a quiet topic.
 *
 * The bridge for one subscription (cursor C):
 *   1. subscribe to Pulse and note its hints,
 *   2. resolve C to its row and replay everything after it from PostgreSQL,
 *   3. every later hint, once replay has finished, reads the rows after the last delivered one: a hint at or
 *      below what was delivered is a duplicate and costs nothing, a hint beyond it (including one that follows a
 *      lost hint) is repaired by the read, in order,
 *   4. every heartbeat, compare the topic's head with the last delivered row and read if behind, so even with
 *      Pulse down Live catches up within one heartbeat and never leaves a client stale.
 */
import { randomUUID } from "node:crypto";
import { ForbiddenError } from "@pim/v2-contracts/authz";
import { type PulseHint, ClientFrame, parseCursor } from "@pim/v2-contracts/live-seam";
import { type Authorizer, CLOSE_SLOW, CLOSE_UNAUTHORIZED, type LiveEvent, type Principal, type ServerFrame, parseTopic, serializeCursor } from "../contracts.ts";
import { type LiveIdentity, sessionKey } from "./identity.ts";
import { type LogStore } from "./log-store.ts";
import { OutboundQueue } from "./outbound-queue.ts";
import type { Pulse } from "./pulse.ts";

/** What a connection writes to: a WebSocket, or a fake in tests. */
export interface Transport {
	send(data: string): void;
	/** Bytes accepted by `send` but not yet written to the network. */
	buffered(): number;
	close(code: number, reason: string): void;
}

export type HubOptions = {
	/** How often each connection compares its topics' heads with what it delivered: the bound on staleness when Pulse is down. */
	heartbeatMs?: number;
	/** How often each connection's principal is checked again; revocations announced on Pulse do not wait for it. */
	revalidateMs?: number;
	/** The most events a cursor may lag by and still be replayed; beyond it the client takes a snapshot. */
	maxReplay?: number;
	replayPage?: number;
	/** How many topics one connection may follow: what is on screen, not every running agent. */
	maxTopics?: number;
	maxQueueBytes?: number;
	/** The socket's own buffer above which nothing more is written to it. */
	highWaterBytes?: number;
	pumpMs?: number;
	/** A connection that has had queued events but moved none for this long is closed. */
	stallCloseMs?: number;
};

const DEFAULTS = { heartbeatMs: 1_000, revalidateMs: 5_000, maxReplay: 5_000, replayPage: 500, maxTopics: 8, maxQueueBytes: 1_048_576, highWaterBytes: 65_536, pumpMs: 5, stallCloseMs: 30_000 };

export class LiveHub {
	readonly options: Required<HubOptions>;
	readonly log: LogStore;
	readonly pulse: Pulse;
	readonly identity: LiveIdentity;
	readonly authorizer: Authorizer;
	readonly #connections = new Set<LiveConnection>();
	readonly #stopRevocations: () => void;

	constructor(log: LogStore, pulse: Pulse, identity: LiveIdentity, authorizer: Authorizer, options: HubOptions = {}) {
		this.log = log;
		this.pulse = pulse;
		this.identity = identity;
		this.authorizer = authorizer;
		this.options = { ...DEFAULTS, ...options };
		this.#stopRevocations = pulse.onRevocation(({ ownerId, sessionId }) => {
			for (const connection of [...this.#connections]) {
				if (connection.principal.ownerId === ownerId && (sessionId === undefined || sessionKey(connection.principal) === sessionId)) connection.unauthorized("revoked");
			}
		});
	}

	get connections(): number {
		return this.#connections.size;
	}

	/** Bytes waiting in every connection's outbound queue: what a slow reader costs this replica. */
	get queuedBytes(): number {
		let bytes = 0;
		for (const connection of this.#connections) bytes += connection.queue.bytes;
		return bytes;
	}

	/** Starts serving an authenticated connection. */
	connect(principal: Principal, transport: Transport): LiveConnection {
		const connection = new LiveConnection(this, principal, transport, () => this.#connections.delete(connection));
		this.#connections.add(connection);
		return connection;
	}

	async close(): Promise<void> {
		this.#stopRevocations();
		for (const connection of [...this.#connections]) connection.close(1001, "going away");
	}
}

export class LiveConnection {
	readonly id = randomUUID();
	readonly queue: OutboundQueue;
	/** The newest cursor the client acknowledged, per topic: where a reconnect would resume. */
	readonly acked = new Map<string, string>();
	readonly #hub: LiveHub;
	readonly #transport: Transport;
	readonly #control: ServerFrame[] = [];
	readonly #bridges = new Map<string, Bridge>();
	readonly #timers: ReturnType<typeof setInterval>[] = [];
	#pump: ReturnType<typeof setTimeout> | null = null;
	#progress = Date.now();
	#closed = false;
	readonly #done: () => void;

	constructor(
		hub: LiveHub,
		readonly principal: Principal,
		transport: Transport,
		done: () => void,
	) {
		this.#hub = hub;
		this.#transport = transport;
		this.#done = done;
		this.queue = new OutboundQueue(hub.options.maxQueueBytes);
		this.#timers.push(setInterval(() => void this.#heartbeat(), hub.options.heartbeatMs), setInterval(() => void this.#revalidate(), hub.options.revalidateMs));
		for (const timer of this.#timers) timer.unref?.();
	}

	get ownerId(): string {
		return this.principal.ownerId;
	}

	get closed(): boolean {
		return this.#closed;
	}

	get topics(): string[] {
		return [...this.#bridges.keys()];
	}

	/** One text frame from the client. */
	async receive(raw: string): Promise<void> {
		if (this.#closed) return;
		let json: unknown;
		try {
			json = JSON.parse(raw);
		} catch {
			return this.error("bad_frame", "Malformed JSON");
		}
		const parsed = ClientFrame.safeParse(json);
		if (!parsed.success) return this.error("bad_frame", "Not a Live client frame");
		const frame = parsed.data;
		if (frame.type === "ack") {
			// Where this client would resume, per topic; the topic of a cursor is whichever bridge delivered it.
			for (const [topic, bridge] of this.#bridges) if (bridge.delivered(frame.cursor)) this.acked.set(topic, frame.cursor);
			return;
		}
		if (frame.type === "unsubscribe") {
			this.#drop(frame.topic);
			return;
		}
		await this.#subscribe(frame.topic, frame.cursor);
	}

	async #subscribe(topic: string, cursorText: string | undefined): Promise<void> {
		if (!parseTopic(topic)) return this.error("bad_topic", `Not a topic: ${topic.slice(0, 80)}`);
		let cursor;
		try {
			cursor = cursorText === undefined ? null : parseCursor(cursorText);
		} catch {
			return this.error("bad_cursor", "Not a cursor");
		}
		if (!this.#bridges.has(topic) && this.#bridges.size >= this.#hub.options.maxTopics) return this.error("too_many_topics", `At most ${this.#hub.options.maxTopics} topics per connection`);
		// The principal is checked on every subscription, not only when the socket opened, and what it may follow is the Authorizer's to say.
		try {
			if (!(await this.#hub.identity.stillValid(this.principal))) return this.unauthorized("revoked");
			await this.#hub.authorizer.authorize({ principal: this.principal, ownerId: this.principal.ownerId, action: "live:subscribe", resource: { topic } });
		} catch (error) {
			if (error instanceof ForbiddenError) return this.unauthorized("not allowed");
			return this.error("authorization_unavailable", "Authorization is unavailable");
		}
		if (this.#closed) return;
		this.#drop(topic);
		const bridge = new Bridge(this.#hub, this, topic);
		this.#bridges.set(topic, bridge);
		await bridge.start(cursor);
	}

	#drop(topic: string): void {
		this.#bridges.get(topic)?.dispose();
		this.#bridges.delete(topic);
		this.queue.drop(topic);
	}

	error(code: string, message: string): void {
		this.control({ type: "error", code, message });
	}

	/** A frame that skips the event queue: control traffic is small and goes first. */
	control(frame: ServerFrame): void {
		if (this.#closed) return;
		this.#control.push(frame);
		this.#flush();
	}

	/** Queues a committed event for the client. */
	deliver(event: LiveEvent): void {
		if (this.#closed) return;
		if (!this.queue.push(event)) {
			// The client can't keep up: it takes a snapshot and subscribes again, and nothing is silently missing.
			for (const [topic, bridge] of [...this.#bridges]) {
				bridge.dispose();
				this.#bridges.delete(topic);
				this.control({ type: "snapshot_required", topic, reason: "expired" });
			}
			return;
		}
		this.#flush();
	}

	/** Called by a bridge that cannot serve its cursor from the log. */
	snapshotRequired(topic: string, reason: "gap" | "projection_version" | "expired"): void {
		this.#drop(topic);
		this.control({ type: "snapshot_required", topic, reason });
	}

	#flush(): void {
		if (this.#closed) return;
		const high = this.#hub.options.highWaterBytes;
		for (;;) {
			if (this.#transport.buffered() > high) break;
			const frame = this.#control.shift() ?? this.queue.shift();
			if (!frame) break;
			try {
				this.#transport.send(JSON.stringify(frame));
			} catch {
				this.close(1011, "send failed");
				return;
			}
			this.#progress = Date.now();
		}
		if (this.#control.length === 0 && this.queue.length === 0) {
			this.#progress = Date.now();
			return;
		}
		if (Date.now() - this.#progress > this.#hub.options.stallCloseMs) {
			this.close(CLOSE_SLOW, "slow client");
			return;
		}
		this.#pump ??= setTimeout(() => {
			this.#pump = null;
			this.#flush();
		}, this.#hub.options.pumpMs);
		this.#pump.unref?.();
	}

	async #heartbeat(): Promise<void> {
		if (this.#closed || this.#bridges.size === 0) return;
		try {
			const heads = await this.#hub.log.heads(this.ownerId, [...this.#bridges.keys()]);
			for (const [topic, bridge] of [...this.#bridges]) if ((heads.get(topic) ?? 0) > bridge.lastSeq) void bridge.repair();
		} catch {
			// PostgreSQL is unavailable: the next heartbeat tries again, and nothing is delivered that was not read.
		}
	}

	async #revalidate(): Promise<void> {
		if (this.#closed) return;
		try {
			if (!(await this.#hub.identity.stillValid(this.principal))) this.unauthorized("revoked");
		} catch {
			// An identity service that can't answer is not a revocation; the next check asks again.
		}
	}

	/** The connection's access ended: no event is delivered after this, and it closes with 4003. */
	unauthorized(reason: string): void {
		this.close(CLOSE_UNAUTHORIZED, `unauthorized: ${reason}`);
	}

	close(code: number, reason: string): void {
		if (this.#closed) return;
		this.#closed = true;
		for (const timer of this.#timers) clearInterval(timer);
		if (this.#pump) clearTimeout(this.#pump);
		for (const bridge of this.#bridges.values()) bridge.dispose();
		this.#bridges.clear();
		this.queue.clear();
		this.#control.length = 0;
		this.#done();
		try {
			this.#transport.close(code, reason.slice(0, 120));
		} catch {
			// Closed already.
		}
	}
}

/** One subscription's bridge from hints to the log. */
class Bridge {
	/** The `stream_seq` of the last row delivered. */
	lastSeq = 0;
	#live = false;
	#disposed = false;
	#unsubscribe: (() => void) | null = null;
	#chain: Promise<void> = Promise.resolve();
	#wanted = false;
	/** The newest commit delivered, per partition: a hint at or below it has nothing new. */
	readonly #seen = new Map<string, bigint>();

	constructor(
		private readonly hub: LiveHub,
		private readonly connection: LiveConnection,
		private readonly topic: string,
	) {}

	/** Whether `cursor` is one this bridge delivered or started from. */
	delivered(cursor: string): boolean {
		try {
			const parsed = parseCursor(cursor);
			return (this.#seen.get(parsed.partitionId) ?? -1n) >= parsed.commitSeq;
		} catch {
			return false;
		}
	}

	/** Serializes this bridge's reads and deliveries, so rows go out in order. */
	#run(task: () => Promise<void>): Promise<void> {
		const next = this.#chain.then(task).catch(() => {
			// A failed read (PostgreSQL unavailable) leaves lastSeq where it was; the heartbeat repairs it.
		});
		this.#chain = next;
		return next;
	}

	async start(cursor: { partitionId: string; projectionVersion: number; commitSeq: bigint } | null): Promise<void> {
		const ownerId = this.connection.ownerId;
		// Subscribe before reading: whatever commits after the read is announced, and read again.
		this.#unsubscribe = this.hub.pulse.subscribe(ownerId, this.topic, (hint) => this.#hint(hint));
		await this.#run(async () => {
			if (this.#disposed) return;
			const options = this.hub.options;
			let from = 0;
			if (cursor) {
				const found = await this.hub.log.resolve(ownerId, this.topic, cursor as never);
				if (this.#disposed) return;
				if ("missing" in found) return this.connection.snapshotRequired(this.topic, found.missing);
				from = found.seq;
				this.#seen.set(cursor.partitionId, cursor.commitSeq);
				this.connection.control({ type: "ack", cursor: serializeCursor(cursor as never) });
			}
			const { head, min } = await this.hub.log.bounds(ownerId, this.topic);
			if (this.#disposed) return;
			if (head - from > options.maxReplay) return this.connection.snapshotRequired(this.topic, "expired");
			// The first row to replay must be the next one: rows after the cursor were pruned otherwise.
			if (from < head && (min === null || min > from + 1)) return this.connection.snapshotRequired(this.topic, "gap");
			this.lastSeq = from;
			if (from < head) {
				const [last] = await this.hub.log.read(ownerId, this.topic, head - 1, 1);
				if (this.#disposed) return;
				if (last) this.connection.control({ type: "cursor_replay", topic: this.topic, from: cursor ? serializeCursor(cursor as never) : "start", to: serializeCursor(last.cursor) });
			}
			if (!(await this.#catchUp())) return;
			this.#live = true;
			// Anything announced during the replay is in what the replay read or the read below.
			if (this.#wanted) await this.#catchUp();
		});
	}

	#hint(hint: PulseHint): void {
		if (this.#disposed) return;
		try {
			const cursor = parseCursor(hint.cursor);
			// Already delivered, from a replay or an earlier repair: a duplicate.
			if (this.#live && (this.#seen.get(cursor.partitionId) ?? -1n) >= cursor.commitSeq) return;
		} catch {
			return;
		}
		if (!this.#live) {
			this.#wanted = true;
			return;
		}
		void this.#run(async () => void (await this.#catchUp()));
	}

	/** Delivers every committed row after `lastSeq`. False when the topic cannot be served (and the client was told). */
	async #catchUp(): Promise<boolean> {
		const ownerId = this.connection.ownerId;
		const page = this.hub.options.replayPage;
		this.#wanted = false;
		for (;;) {
			const rows = await this.hub.log.read(ownerId, this.topic, this.lastSeq, page);
			if (this.#disposed) return false;
			for (const row of rows) {
				if (row.seq !== this.lastSeq + 1) {
					// A hole in the log itself: retention removed rows after this cursor.
					this.connection.snapshotRequired(this.topic, "gap");
					return false;
				}
				this.lastSeq = row.seq;
				const seen = this.#seen.get(row.cursor.partitionId) ?? -1n;
				if (row.cursor.commitSeq > seen) this.#seen.set(row.cursor.partitionId, row.cursor.commitSeq);
				this.connection.deliver(row);
				if (this.#disposed) return false;
			}
			if (rows.length < page) return true;
		}
	}

	/** Reads what Pulse did not announce. */
	repair(): Promise<void> {
		return this.#run(async () => void (await this.#catchUp()));
	}

	dispose(): void {
		this.#disposed = true;
		this.#live = false;
		this.#unsubscribe?.();
		this.#unsubscribe = null;
	}
}
