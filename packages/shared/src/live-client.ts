/**
 * The client of Pim's Live service, speaking the canonical frames and cursors of `@pim/v2-contracts`
 * (`live-seam`): a cursor per followed topic over one WebSocket, with HTTP snapshots underneath, so what is on
 * screen never waits on the socket.
 *
 * - Only the topics the person is looking at are followed: the open chat or coding thread and the compact
 *   sidebar. Never every running agent. A topic let go is unsubscribed on the same socket, so switching chats
 *   keeps the connection.
 * - Every topic loads from a bounded HTTP snapshot first, whether or not the socket is up; its `liveCursor`
 *   (`partition:projectionVersion:commitSeq`, or null when the topic had no events) is where the subscription
 *   starts, so the two never overlap or leave a hole.
 * - A cursor names a commit, not a position in the topic, so holes are Live's to detect: it replays what is
 *   missing from its log, or says `snapshot_required` (`gap`, `projection_version`, `expired`), and the
 *   snapshot is fetched again. The client drops what it has already applied, per partition.
 * - `coalesced_progress` is the latest of replaceable progress a slow reader skipped over (`skipped` of them).
 * - 4003, or a snapshot refused with 401, 403 or 410, ends the session's access: nothing reconnects and
 *   `onUnauthorized` wipes what this device kept.
 * - A socket that drops reconnects with backoff, resuming from each topic's last cursor; the state is
 *   "syncing", which the app shows as a small indicator without blocking navigation or reads.
 */

export type LiveStatus = "live" | "syncing" | "offline";

type Frame =
	| { type: "ack"; cursor: string }
	| { type: "cursor_replay"; topic: string; from: string; to: string }
	| {
			type: "event";
			topic: string;
			cursor: string;
			kind: string;
			data: unknown;
		}
	| {
			type: "coalesced_progress";
			topic: string;
			cursor: string;
			skipped: number;
			data: unknown;
		}
	| {
			type: "snapshot_required";
			topic: string;
			reason: "gap" | "projection_version" | "expired";
		}
	| { type: "error"; code: string; message: string };

/** What the page is told of each frame that carries state. */
export type LiveUpdate = {
	topic: string;
	cursor: string;
	/** `progress` for a coalesced update, standing for `skipped` before it. */
	kind: string;
	data: unknown;
	skipped?: number;
};

/** The part of a WebSocket the client uses, so tests can stand in for it. */
export interface LiveSocket {
	send(data: string): void;
	close(code?: number): void;
	onopen: (() => void) | null;
	onmessage: ((event: { data: unknown }) => void) | null;
	onclose: ((event: { code: number }) => void) | null;
}

/** What loading a topic's first page told: where to subscribe from (null: from the start). A refused read has a status. */
export type Snapshot = { liveCursor: string | null };

export class SnapshotRefused extends Error {
	constructor(readonly status: number) {
		super(`Snapshot refused: ${status}`);
	}
}

export type LiveClientOptions = {
	openSocket: () => LiveSocket;
	/** Fetches and shows a topic's bounded page over HTTP; resolves with its cursor. */
	loadSnapshot: (topic: string) => Promise<Snapshot>;
	onUpdate: (update: LiveUpdate) => void;
	onStatus?: (status: LiveStatus) => void;
	/** Access ended: wipe this device's kept views and show the sign-in screen. */
	onUnauthorized: () => void;
	schedule?: (fn: () => void, ms: number) => unknown;
	cancel?: (handle: unknown) => void;
	random?: () => number;
};

const MAX_BACKOFF_MS = 15_000;
const WIPE_STATUSES = new Set([401, 403, 410]);

type Topic = {
	/** Where a subscription starts: the last cursor applied, else the snapshot's. Undefined until the snapshot is taken. */
	cursor: string | null | undefined;
	/** The newest commit applied, per partition: a frame at or below it is a duplicate. */
	seen: Map<string, bigint>;
	/** Counts snapshots asked for, so an answer to an older ask is ignored. */
	ask: number;
	subscribed: boolean;
};

function commitOf(
	cursor: string,
): { partition: string; commit: bigint } | null {
	const match = /^([^:]+):\d+:(\d+)$/.exec(cursor);
	return match
		? { partition: match[1] as string, commit: BigInt(match[2] as string) }
		: null;
}

export class LiveClient {
	readonly #options: LiveClientOptions;
	readonly #topics = new Map<string, Topic>();
	#socket: LiveSocket | null = null;
	#open = false;
	#attempt = 0;
	#retry: unknown = null;
	#status: LiveStatus = "syncing";
	#ended = false;
	#acks = new Set<string>();
	#ackQueued = false;

	constructor(options: LiveClientOptions) {
		this.#options = options;
	}

	get status(): LiveStatus {
		return this.#status;
	}

	/** The cursor a topic would resume from, for tests and diagnostics. */
	cursor(topic: string): string | null | undefined {
		return this.#topics.get(topic)?.cursor;
	}

	/** Follows exactly these topics: the ones that are on screen. Others are let go. */
	follow(topics: readonly string[]): void {
		if (this.#ended) return;
		const wanted = new Set(topics);
		for (const name of [...this.#topics.keys()]) {
			if (wanted.has(name)) continue;
			const topic = this.#topics.get(name);
			this.#topics.delete(name);
			if (topic?.subscribed) this.#send({ type: "unsubscribe", topic: name });
		}
		for (const name of wanted) {
			if (this.#topics.has(name)) continue;
			this.#topics.set(name, {
				cursor: undefined,
				seen: new Map(),
				ask: 0,
				subscribed: false,
			});
			void this.#snapshot(name);
		}
		if (wanted.size > 0 && !this.#socket && this.#retry === null) {
			this.#connect();
		}
		if (wanted.size === 0) this.#hangUp();
		this.#refresh();
	}

	/** Signing out, or access ended: nothing more is read or opened. */
	stop(): void {
		this.#ended = true;
		this.#topics.clear();
		this.#hangUp();
		this.#setStatus("offline");
	}

	async #snapshot(name: string): Promise<void> {
		const topic = this.#topics.get(name);
		if (!topic) return;
		const ask = ++topic.ask;
		topic.subscribed = false;
		topic.cursor = undefined;
		topic.seen.clear();
		let snapshot: Snapshot;
		try {
			snapshot = await this.#options.loadSnapshot(name);
		} catch (error) {
			if (error instanceof SnapshotRefused && WIPE_STATUSES.has(error.status)) {
				return this.#unauthorized();
			}
			// Not loaded: try again soon. The page keeps what it showed.
			this.#later(() => {
				if (this.#topics.get(name)?.ask === ask) void this.#snapshot(name);
			}, this.#backoff());
			return;
		}
		if (this.#topics.get(name) !== topic || topic.ask !== ask) return;
		topic.cursor = snapshot.liveCursor;
		const at = snapshot.liveCursor ? commitOf(snapshot.liveCursor) : null;
		if (at) topic.seen.set(at.partition, at.commit);
		this.#subscribe(name);
		this.#refresh();
	}

	#subscribe(name: string): void {
		const topic = this.#topics.get(name);
		if (!topic || !this.#open || topic.cursor === undefined) return;
		topic.subscribed = true;
		this.#send({
			type: "subscribe",
			topic: name,
			...(topic.cursor ? { cursor: topic.cursor } : {}),
		});
	}

	#connect(): void {
		this.#retry = null;
		if (this.#ended) return;
		const socket = this.#options.openSocket();
		this.#socket = socket;
		socket.onopen = () => {
			if (this.#socket !== socket) return;
			this.#open = true;
			this.#attempt = 0;
			for (const name of this.#topics.keys()) this.#subscribe(name);
			this.#refresh();
		};
		socket.onmessage = (event) => {
			if (this.#socket !== socket) return;
			let frame: Frame;
			try {
				frame = JSON.parse(String(event.data)) as Frame;
			} catch {
				return;
			}
			this.#receive(frame);
		};
		socket.onclose = (event) => {
			if (this.#socket !== socket) return;
			this.#socket = null;
			this.#open = false;
			for (const topic of this.#topics.values()) topic.subscribed = false;
			if (event.code === 4003) return this.#unauthorized();
			this.#refresh();
			if (this.#topics.size > 0) this.#reconnectLater();
		};
	}

	#receive(frame: Frame): void {
		switch (frame.type) {
			case "event":
			case "coalesced_progress": {
				const topic = this.#topics.get(frame.topic);
				if (!topic || !topic.subscribed) return;
				const at = commitOf(frame.cursor);
				if (!at) return;
				// Delivered already, by a replay or an earlier frame.
				if ((topic.seen.get(at.partition) ?? -1n) >= at.commit) return;
				topic.seen.set(at.partition, at.commit);
				topic.cursor = frame.cursor;
				this.#options.onUpdate(
					frame.type === "event"
						? {
								topic: frame.topic,
								cursor: frame.cursor,
								kind: frame.kind,
								data: frame.data,
							}
						: {
								topic: frame.topic,
								cursor: frame.cursor,
								kind: "progress",
								data: frame.data,
								skipped: frame.skipped,
							},
				);
				this.#acks.add(frame.cursor);
				this.#queueAck();
				return;
			}
			case "snapshot_required":
				if (this.#topics.has(frame.topic)) void this.#snapshot(frame.topic);
				this.#refresh();
				return;
			default:
				this.#refresh();
		}
	}

	/** Tells Live how far this client has applied, once per turn however many frames arrived. */
	#queueAck(): void {
		if (this.#ackQueued) return;
		this.#ackQueued = true;
		queueMicrotask(() => {
			this.#ackQueued = false;
			const last = [...this.#acks].at(-1);
			this.#acks.clear();
			if (last) this.#send({ type: "ack", cursor: last });
		});
	}

	#unauthorized(): void {
		if (this.#ended) return;
		this.stop();
		this.#options.onUnauthorized();
	}

	#send(frame: object): void {
		try {
			this.#socket?.send(JSON.stringify(frame));
		} catch {
			// Closing: the close handler reconnects.
		}
	}

	#hangUp(): void {
		if (this.#retry !== null) {
			(this.#options.cancel ?? ((handle) => clearTimeout(handle as number)))(
				this.#retry,
			);
		}
		this.#retry = null;
		const socket = this.#socket;
		this.#socket = null;
		this.#open = false;
		for (const topic of this.#topics.values()) topic.subscribed = false;
		if (socket) {
			socket.onclose = null;
			socket.close(1000);
		}
	}

	#later(fn: () => void, ms: number): unknown {
		if (this.#ended) return null;
		return (this.#options.schedule ?? ((f, m) => setTimeout(f, m)))(fn, ms);
	}

	/** The socket connects again after a backoff; one wait at a time. */
	#reconnectLater(): void {
		if (this.#retry !== null) return;
		this.#retry = this.#later(() => this.#connect(), this.#backoff());
	}

	#backoff(): number {
		const random = this.#options.random ?? Math.random;
		const ms = Math.min(MAX_BACKOFF_MS, 500 * 2 ** this.#attempt++);
		return Math.round(ms / 2 + (random() * ms) / 2);
	}

	/** Live when the socket is up and every followed topic is subscribed from a snapshot; offline once access ended; otherwise syncing. */
	#refresh(): void {
		if (this.#ended) return;
		const synced =
			this.#open &&
			[...this.#topics.values()].every((topic) => topic.subscribed);
		this.#setStatus(synced ? "live" : "syncing");
	}

	#setStatus(status: LiveStatus): void {
		if (status === this.#status) return;
		this.#status = status;
		this.#options.onStatus?.(status);
	}
}
