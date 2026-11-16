/**
 * The client of Pim's Live service: a cursor per followed stream over one WebSocket, with HTTP snapshots
 * underneath, so what is on screen never waits on the socket.
 *
 * - Only the streams the person is looking at are followed: the open chat or coding thread and the compact
 *   sidebar. Never every running agent.
 * - Every stream loads from a bounded HTTP snapshot first, whether or not the socket is up; its
 *   `liveCursor` is where the subscription starts, so the two never overlap or leave a hole.
 * - A frame is applied only if it is the next seq of its stream, or follows seqs the server said it skipped
 *   (`coalesced`: replaceable progress for a slow reader). Anything else is a duplicate (dropped) or a gap
 *   (the stream resubscribes from its cursor).
 * - `snapshot_required` means the cursor can't be replayed: the snapshot is fetched again.
 * - 4003, or a snapshot refused with 401, 403 or 410, ends the session's access: nothing reconnects and
 *   `onUnauthorized` wipes what this device kept.
 * - A socket that drops reconnects with backoff; the state is "syncing", which the app shows as a small
 *   indicator without blocking navigation or reads.
 */

export type LiveStatus = "live" | "syncing" | "offline";

type Frame =
  | { type: "hello" }
  | { type: "subscribed"; stream: string; cursor: number; head: number }
  | {
      type: "event";
      stream: string;
      seq: number;
      kind: string;
      replaceableKey: string | null;
      payload: unknown;
      coalesced?: true;
    }
  | { type: "snapshot_required"; stream: string; head: number; reason: string }
  | { type: "unsubscribed"; stream: string }
  | { type: "pong" }
  | { type: "error"; stream?: string; message: string };

export type LiveEventFrame = Extract<Frame, { type: "event" }>;

/** The part of a WebSocket the client uses, so tests can stand in for it. */
export interface LiveSocket {
  send(data: string): void;
  close(code?: number): void;
  onopen: (() => void) | null;
  onmessage: ((event: { data: unknown }) => void) | null;
  onclose: ((event: { code: number }) => void) | null;
}

/** What loading a stream's first page told: where to subscribe from. A refused read has a status. */
export type Snapshot = { liveCursor: number };

export class SnapshotRefused extends Error {
  constructor(readonly status: number) {
    super(`Snapshot refused: ${status}`);
  }
}

export type LiveClientOptions = {
  openSocket: () => LiveSocket;
  /** Fetches and shows a stream's bounded page over HTTP; resolves with its cursor. */
  loadSnapshot: (stream: string) => Promise<Snapshot>;
  onEvent: (event: LiveEventFrame) => void;
  onStatus?: (status: LiveStatus) => void;
  /** Access ended: wipe this device's kept views and show the sign-in screen. */
  onUnauthorized: () => void;
  now?: () => number;
  schedule?: (fn: () => void, ms: number) => unknown;
  cancel?: (handle: unknown) => void;
  random?: () => number;
};

const MAX_BACKOFF_MS = 15_000;
const WIPE_STATUSES = new Set([401, 403, 410]);

type Stream = {
  /** The last seq applied; null until its snapshot has been taken. */
  cursor: number | null;
  /** Counts snapshots asked for, so an answer to an older ask is ignored. */
  ask: number;
  subscribed: boolean;
};

export class LiveClient {
  readonly #options: LiveClientOptions;
  readonly #streams = new Map<string, Stream>();
  #socket: LiveSocket | null = null;
  #open = false;
  #attempt = 0;
  #retry: unknown = null;
  #status: LiveStatus = "syncing";
  #ended = false;

  constructor(options: LiveClientOptions) {
    this.#options = options;
  }

  get status(): LiveStatus {
    return this.#status;
  }

  /** The followed streams' cursors, for tests and diagnostics. */
  cursor(stream: string): number | null {
    return this.#streams.get(stream)?.cursor ?? null;
  }

  /** Follows exactly these streams: the ones that are on screen. Others are let go. */
  follow(streams: readonly string[]): void {
    if (this.#ended) return;
    const wanted = new Set(streams);
    for (const [name] of this.#streams) {
      if (wanted.has(name)) continue;
      this.#streams.delete(name);
      if (this.#open) this.#send({ type: "unsubscribe", stream: name });
    }
    for (const name of wanted) {
      if (this.#streams.has(name)) continue;
      this.#streams.set(name, { cursor: null, ask: 0, subscribed: false });
      void this.#snapshot(name);
    }
    if (wanted.size > 0 && !this.#socket && !this.#retry) this.#connect();
    if (wanted.size === 0) this.#hangUp();
    this.#refresh();
  }

  /** Signing out, or access ended: nothing more is read or opened. */
  stop(): void {
    this.#ended = true;
    this.#streams.clear();
    this.#hangUp();
    this.#setStatus("offline");
  }

  async #snapshot(name: string): Promise<void> {
    const stream = this.#streams.get(name);
    if (!stream) return;
    const ask = ++stream.ask;
    stream.subscribed = false;
    stream.cursor = null;
    let snapshot: Snapshot;
    try {
      snapshot = await this.#options.loadSnapshot(name);
    } catch (error) {
      if (error instanceof SnapshotRefused && WIPE_STATUSES.has(error.status))
        return this.#unauthorized();
      // Not loaded: try again soon. The page keeps what it showed.
      this.#later(() => {
        if (this.#streams.get(name)?.ask === ask) void this.#snapshot(name);
      }, this.#backoff());
      return;
    }
    if (this.#streams.get(name) !== stream || stream.ask !== ask) return;
    stream.cursor = snapshot.liveCursor;
    this.#subscribe(name);
    this.#refresh();
  }

  #subscribe(name: string): void {
    const stream = this.#streams.get(name);
    if (!stream || !this.#open || stream.cursor === null) return;
    stream.subscribed = true;
    this.#send({ type: "subscribe", stream: name, cursor: stream.cursor });
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
      for (const name of this.#streams.keys()) this.#subscribe(name);
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
      for (const stream of this.#streams.values()) stream.subscribed = false;
      if (event.code === 4003) return this.#unauthorized();
      this.#refresh();
      if (this.#streams.size > 0) this.#reconnectLater();
    };
  }

  #receive(frame: Frame): void {
    switch (frame.type) {
      case "event": {
        const stream = this.#streams.get(frame.stream);
        if (!stream || stream.cursor === null || !stream.subscribed) return;
        // Delivered already, by a replay or an earlier frame.
        if (frame.seq <= stream.cursor) return;
        // A skip the server did not announce is a hole: ask again from the cursor.
        if (frame.seq !== stream.cursor + 1 && !frame.coalesced) {
          this.#subscribe(frame.stream);
          return;
        }
        stream.cursor = frame.seq;
        this.#options.onEvent(frame);
        return;
      }
      case "snapshot_required":
        if (this.#streams.has(frame.stream)) void this.#snapshot(frame.stream);
        this.#refresh();
        return;
      case "subscribed":
      case "unsubscribed":
        this.#refresh();
        return;
      default:
    }
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
    if (this.#retry !== null)
      (this.#options.cancel ?? ((handle) => clearTimeout(handle as number)))(
        this.#retry,
      );
    this.#retry = null;
    const socket = this.#socket;
    this.#socket = null;
    this.#open = false;
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

  /** Live when the socket is up and every followed stream is subscribed from a snapshot; offline once access ended; otherwise syncing. */
  #refresh(): void {
    if (this.#ended) return;
    const synced =
      this.#open &&
      [...this.#streams.values()].every((stream) => stream.subscribed);
    this.#setStatus(synced ? "live" : "syncing");
  }

  #setStatus(status: LiveStatus): void {
    if (status === this.#status) return;
    this.#status = status;
    this.#options.onStatus?.(status);
  }
}
