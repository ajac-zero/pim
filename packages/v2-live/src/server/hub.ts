/**
 * Live's core, independent of any socket library: the bridge from Pulse hints to gap-free, replayable
 * delivery from PostgreSQL, one authenticated connection at a time.
 *
 * Nothing here is owned by a Harness and nothing is sticky: a connection's whole state is its cursors, so
 * any replica can serve a reconnect.
 *
 * The bridge for one subscription (cursor C):
 *   1. subscribe to Pulse and buffer its hints,
 *   2. read the stream's head H and replay the committed rows (C, H] from PostgreSQL,
 *   3. drain the buffered hints: one at or below the last delivered seq is a duplicate and dropped; the next
 *      seq with its event is delivered from the hint; any other (a gap, a hint without its event) is repaired
 *      by reading the rows from PostgreSQL,
 *   4. every heartbeat, compare the stream's head with the last delivered seq and repair if behind, so even
 *      with Pulse down Live catches up within one heartbeat and never leaves a client stale.
 */
import { randomUUID } from "node:crypto";
import { type ClientFrame, CLOSE_SLOW, CLOSE_UNAUTHORIZED, type LiveEvent, type PulseHint, type ServerFrame } from "../contracts.ts";
import type { Authorizer, Identity } from "./authorizer.ts";
import type { LogStore } from "./log-store.ts";
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
	/** How often each connection compares its streams' heads with what it delivered: the bound on staleness when Pulse is down. */
	heartbeatMs?: number;
	/** How often each connection's identity is checked again; revocations announced on Pulse do not wait for it. */
	revalidateMs?: number;
	/** The most events a cursor may lag by and still be replayed; beyond it the client takes a snapshot. */
	maxReplay?: number;
	replayPage?: number;
	/** How many streams one connection may follow: what is on screen, not every running agent. */
	maxStreams?: number;
	maxQueueBytes?: number;
	/** The socket's own buffer above which nothing more is written to it. */
	highWaterBytes?: number;
	pumpMs?: number;
	/** A connection that has had queued events but moved none for this long is closed. */
	stallCloseMs?: number;
	/** Hints buffered during one subscription's replay; beyond it the replay ends with a read from PostgreSQL. */
	maxBufferedHints?: number;
};

const DEFAULTS = { heartbeatMs: 1_000, revalidateMs: 5_000, maxReplay: 5_000, replayPage: 500, maxStreams: 8, maxQueueBytes: 1_048_576, highWaterBytes: 65_536, pumpMs: 5, stallCloseMs: 30_000, maxBufferedHints: 10_000 };

export class LiveHub {
	readonly options: Required<HubOptions>;
	readonly log: LogStore;
	readonly pulse: Pulse;
	readonly authorizer: Authorizer;
	readonly #connections = new Set<LiveConnection>();
	readonly #stopRevocations: () => void;

	constructor(log: LogStore, pulse: Pulse, authorizer: Authorizer, options: HubOptions = {}) {
		this.log = log;
		this.pulse = pulse;
		this.authorizer = authorizer;
		this.options = { ...DEFAULTS, ...options };
		this.#stopRevocations = pulse.onRevocation(({ tenantId, sessionId }) => {
			for (const connection of [...this.#connections]) {
				if (connection.identity.tenantId === tenantId && (sessionId === undefined || connection.identity.sessionId === sessionId)) connection.unauthorized("revoked");
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
	connect(identity: Identity, transport: Transport): LiveConnection {
		const connection = new LiveConnection(this, identity, transport, () => this.#connections.delete(connection));
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
		readonly identity: Identity,
		transport: Transport,
		done: () => void,
	) {
		this.#hub = hub;
		this.#transport = transport;
		this.#done = done;
		this.queue = new OutboundQueue(hub.options.maxQueueBytes);
		this.#control.push({ type: "hello", connectionId: this.id, heartbeatMs: hub.options.heartbeatMs });
		this.#timers.push(setInterval(() => void this.#heartbeat(), hub.options.heartbeatMs), setInterval(() => void this.#revalidate(), hub.options.revalidateMs));
		for (const timer of this.#timers) timer.unref?.();
		this.#flush();
	}

	get closed(): boolean {
		return this.#closed;
	}

	get streams(): string[] {
		return [...this.#bridges.keys()];
	}

	/** One text frame from the client. */
	async receive(raw: string): Promise<void> {
		if (this.#closed) return;
		let frame: ClientFrame;
		try {
			frame = JSON.parse(raw) as ClientFrame;
		} catch {
			this.control({ type: "error", message: "Malformed JSON" });
			return;
		}
		switch (frame?.type) {
			case "ping":
				this.control({ type: "pong", ...(frame.id === undefined ? {} : { id: frame.id }) });
				return;
			case "unsubscribe":
				this.#drop(String(frame.stream));
				this.control({ type: "unsubscribed", stream: String(frame.stream) });
				return;
			case "subscribe":
				await this.#subscribe(frame);
				return;
			default:
				this.control({ type: "error", message: "Unknown frame type" });
		}
	}

	async #subscribe(frame: Extract<ClientFrame, { type: "subscribe" }>): Promise<void> {
		const stream = frame.stream;
		const cursor = frame.cursor;
		if (typeof stream !== "string" || stream.length === 0 || stream.length > 200 || !(cursor === null || (Number.isSafeInteger(cursor) && cursor >= 0))) {
			this.control({ type: "error", message: "Bad subscribe" });
			return;
		}
		if (!this.#bridges.has(stream) && this.#bridges.size >= this.#hub.options.maxStreams) {
			this.control({ type: "error", stream, message: `At most ${this.#hub.options.maxStreams} streams per connection` });
			return;
		}
		// The identity is checked on every subscription, not only when the socket opened.
		let allowed: boolean;
		try {
			allowed = (await this.#hub.authorizer.validate(this.identity)) && (await this.#hub.authorizer.canSubscribe(this.identity, stream));
		} catch {
			this.control({ type: "error", stream, message: "Authorization is unavailable" });
			return;
		}
		if (this.#closed) return;
		if (!allowed) return this.unauthorized("not allowed");
		this.#drop(stream);
		const bridge = new Bridge(this.#hub, this, stream);
		this.#bridges.set(stream, bridge);
		await bridge.start(cursor);
	}

	#drop(stream: string): void {
		this.#bridges.get(stream)?.dispose();
		this.#bridges.delete(stream);
		this.queue.drop(stream);
	}

	/** A frame that skips the event queue: control traffic is small and goes first. */
	control(frame: ServerFrame): void {
		if (this.#closed) return;
		this.#control.push(frame);
		this.#flush();
	}

	/** Queues a committed event for the client. */
	deliver(stream: string, event: LiveEvent): void {
		if (this.#closed) return;
		if (!this.queue.push(stream, event)) {
			// The client can't keep up: it takes a snapshot and subscribes again, and nothing is silently missing.
			for (const [name, bridge] of [...this.#bridges]) {
				bridge.dispose();
				this.#bridges.delete(name);
				this.control({ type: "snapshot_required", stream: name, head: bridge.lastSeq, reason: "slow_client" });
			}
			return;
		}
		this.#flush();
	}

	/** Called by a bridge that cannot serve its cursor from the log. */
	snapshotRequired(stream: string, head: number, reason: Extract<ServerFrame, { type: "snapshot_required" }>["reason"]): void {
		this.#drop(stream);
		this.control({ type: "snapshot_required", stream, head, reason });
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
		const waiting = this.#control.length > 0 || this.queue.length > 0;
		if (!waiting) {
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
			const heads = await this.#hub.log.heads(this.identity.tenantId, [...this.#bridges.keys()]);
			for (const [stream, bridge] of [...this.#bridges]) if ((heads.get(stream) ?? 0) > bridge.lastSeq) void bridge.repair();
		} catch {
			// PostgreSQL is unavailable: the next heartbeat tries again, and nothing is delivered that was not read.
		}
	}

	async #revalidate(): Promise<void> {
		if (this.#closed) return;
		try {
			if (!(await this.#hub.authorizer.validate(this.identity))) this.unauthorized("revoked");
		} catch {
			// An authorizer that can't answer is not a revocation; the next check asks again.
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
	lastSeq = 0;
	#live = false;
	#disposed = false;
	#unsubscribe: (() => void) | null = null;
	#buffer: PulseHint[] = [];
	#overflowed = false;
	#chain: Promise<void> = Promise.resolve();

	constructor(
		private readonly hub: LiveHub,
		private readonly connection: LiveConnection,
		private readonly stream: string,
	) {}

	/** Serializes this bridge's reads and deliveries, so seqs go out in order. */
	#run(task: () => Promise<void>): Promise<void> {
		const next = this.#chain.then(task).catch(() => {
			// A failed read (PostgreSQL unavailable) leaves lastSeq where it was; the heartbeat repairs it.
		});
		this.#chain = next;
		return next;
	}

	async start(cursor: number | null): Promise<void> {
		const { tenantId } = this.connection.identity;
		// Subscribe before reading the head: whatever commits after the head is read is announced, and is buffered meanwhile.
		this.#unsubscribe = this.hub.pulse.subscribe(tenantId, this.stream, (hint) => this.#hint(hint));
		await this.#run(async () => {
			if (this.#disposed) return;
			const from = cursor ?? 0;
			const { head, min } = await this.hub.log.bounds(tenantId, this.stream);
			if (this.#disposed) return;
			const options = this.hub.options;
			if (from > head) return this.connection.snapshotRequired(this.stream, head, "cursor_ahead");
			if (head - from > options.maxReplay) return this.connection.snapshotRequired(this.stream, head, "replay_window");
			if (from < head && (min === null || from < min - 1)) return this.connection.snapshotRequired(this.stream, head, min === null ? "log_pruned" : "cursor_expired");
			this.lastSeq = from;
			this.connection.queue.startAt(this.stream, from);
			this.connection.control({ type: "subscribed", stream: this.stream, cursor: from, head });
			if (!(await this.#catchUp())) return;
			this.#live = true;
			const buffered = this.#buffer.sort((a, b) => a.seq - b.seq);
			this.#buffer = [];
			for (const hint of buffered) if (!(await this.#accept(hint))) return;
			if (this.#overflowed) {
				this.#overflowed = false;
				await this.#catchUp();
			}
		});
	}

	#hint(hint: PulseHint): void {
		if (this.#disposed || hint.streamKey !== this.stream) return;
		if (!this.#live) {
			if (this.#buffer.length < this.hub.options.maxBufferedHints) this.#buffer.push(hint);
			else this.#overflowed = true;
			return;
		}
		void this.#run(async () => void (await this.#accept(hint)));
	}

	async #accept(hint: PulseHint): Promise<boolean> {
		if (this.#disposed) return false;
		// Already delivered, from a replay or an earlier repair: a duplicate.
		if (hint.seq <= this.lastSeq) return true;
		if (hint.event && hint.seq === this.lastSeq + 1 && hint.event.seq === hint.seq) {
			this.lastSeq = hint.seq;
			this.connection.deliver(this.stream, hint.event);
			return true;
		}
		// A seq beyond the next: Pulse missed one. The rows come from PostgreSQL, in order.
		return this.#catchUp();
	}

	/** Delivers every committed row after `lastSeq`. False when the stream cannot be served (and the client was told). */
	async #catchUp(): Promise<boolean> {
		const { tenantId } = this.connection.identity;
		const page = this.hub.options.replayPage;
		for (;;) {
			const rows = await this.hub.log.read(tenantId, this.stream, this.lastSeq, page);
			if (this.#disposed) return false;
			for (const row of rows) {
				if (row.seq !== this.lastSeq + 1) {
					// A hole in the log itself: retention removed rows after this cursor.
					this.connection.snapshotRequired(this.stream, row.seq, "log_pruned");
					return false;
				}
				this.lastSeq = row.seq;
				this.connection.deliver(this.stream, row);
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
		this.#buffer = [];
	}
}
