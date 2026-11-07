import * as decoding from "lib0/decoding";
import * as encoding from "lib0/encoding";
import * as awarenessProtocol from "y-protocols/awareness";
import * as sync from "y-protocols/sync";
import * as Y from "yjs";

/*
 * A note's live text, synced with the space over a socket of its own
 * (`/api/notes/live?note=<id>`), with y-websocket's sync and awareness
 * messages. The document outlives a dropped connection: what the person
 * types meanwhile is sent once it's back, and the space, which keeps the
 * same document, merges it in.
 */

const SYNC = 0;
const AWARENESS = 1;
/** Tells the space the person paused, so what they wrote since becomes a version. */
const CHECKPOINT = 2;

/** How long after the person's last keystroke what they wrote becomes a version. */
const PAUSE_MS = 30_000;
const MAX_BACKOFF_MS = 10_000;

/** The shared text in a note's document, as the space names it. */
export const NOTE_TEXT = "markdown";

export type NoteStatus = "connecting" | "synced" | "gone";

export type NoteEvents = {
  /** Whether the editor is in sync with the space, or the note is gone. */
  status: (status: NoteStatus) => void;
  /** A new version was made, by the person's pause or the agent's change. */
  version: (version: number) => void;
  /** A version couldn't be made, such as at the app's version limit; the text is kept anyway. */
  error: (message: string) => void;
};

export class NoteLive {
  readonly doc = new Y.Doc();
  readonly text = this.doc.getText(NOTE_TEXT);
  readonly awareness = new awarenessProtocol.Awareness(this.doc);
  readonly #note: string;
  readonly #events: NoteEvents;
  #socket: WebSocket | null = null;
  #attempt = 0;
  #retry: ReturnType<typeof setTimeout> | null = null;
  #pause: ReturnType<typeof setTimeout> | null = null;
  #closed = false;

  constructor(note: string, events: NoteEvents) {
    this.#note = note;
    this.#events = events;
    this.doc.on("update", this.#onUpdate);
    this.awareness.on("update", this.#onAwareness);
    this.#connect();
  }

  /** Stops syncing; the space keeps what was written as a version once no editor has the note open. */
  close(): void {
    this.#closed = true;
    if (this.#retry) clearTimeout(this.#retry);
    if (this.#pause) clearTimeout(this.#pause);
    awarenessProtocol.removeAwarenessStates(
      this.awareness,
      [this.doc.clientID],
      "close",
    );
    this.doc.off("update", this.#onUpdate);
    this.awareness.off("update", this.#onAwareness);
    this.#socket?.close(1000);
    this.#socket = null;
    this.awareness.destroy();
    this.doc.destroy();
  }

  #connect(): void {
    const scheme = location.protocol === "https:" ? "wss" : "ws";
    const socket = new WebSocket(
      `${scheme}://${location.host}/api/notes/live?note=${encodeURIComponent(this.#note)}`,
    );
    socket.binaryType = "arraybuffer";
    this.#socket = socket;
    this.#events.status("connecting");
    socket.addEventListener("open", () => {
      if (this.#socket !== socket) return;
      this.#attempt = 0;
      this.#send((encoder) => {
        encoding.writeVarUint(encoder, SYNC);
        sync.writeSyncStep1(encoder, this.doc);
      });
      this.#send((encoder) => {
        encoding.writeVarUint(encoder, AWARENESS);
        encoding.writeVarUint8Array(
          encoder,
          awarenessProtocol.encodeAwarenessUpdate(this.awareness, [
            this.doc.clientID,
          ]),
        );
      });
    });
    socket.addEventListener("message", (event) => {
      if (this.#socket !== socket) return;
      if (typeof event.data === "string") {
        const notice = JSON.parse(event.data) as
          | { type: "version"; version: number }
          | { type: "error"; message: string };
        if (notice.type === "version") this.#events.version(notice.version);
        else this.#events.error(notice.message);
        return;
      }
      this.#receive(new Uint8Array(event.data as ArrayBuffer));
    });
    socket.addEventListener("close", (event) => {
      if (this.#socket !== socket) return;
      this.#socket = null;
      // Others' cursors are stale once the connection is gone.
      awarenessProtocol.removeAwarenessStates(
        this.awareness,
        [...this.awareness.getStates().keys()].filter(
          (client) => client !== this.doc.clientID,
        ),
        "connection",
      );
      if (this.#closed) return;
      if (event.code === 4004) {
        this.#events.status("gone");
        return;
      }
      this.#events.status("connecting");
      const delay = Math.min(1000 * 2 ** this.#attempt, MAX_BACKOFF_MS);
      this.#attempt++;
      this.#retry = setTimeout(() => this.#connect(), delay);
    });
  }

  #receive(data: Uint8Array): void {
    const decoder = decoding.createDecoder(data);
    const type = decoding.readVarUint(decoder);
    if (type === SYNC) {
      const encoder = encoding.createEncoder();
      encoding.writeVarUint(encoder, SYNC);
      const kind = sync.readSyncMessage(decoder, encoder, this.doc, this);
      if (encoding.length(encoder) > 1)
        this.#socket?.send(encoding.toUint8Array(encoder));
      // The space's answer to this editor's state: everything it had is here now.
      if (kind === sync.messageYjsSyncStep2) this.#events.status("synced");
    } else if (type === AWARENESS) {
      awarenessProtocol.applyAwarenessUpdate(
        this.awareness,
        decoding.readVarUint8Array(decoder),
        this,
      );
    }
  }

  #send(write: (encoder: encoding.Encoder) => void): void {
    if (this.#socket?.readyState !== WebSocket.OPEN) return;
    const encoder = encoding.createEncoder();
    write(encoder);
    this.#socket.send(encoding.toUint8Array(encoder));
  }

  /** The person's own changes go to the space; a while after the last one, it keeps them as a version. */
  readonly #onUpdate = (update: Uint8Array, origin: unknown) => {
    if (origin === this) return;
    this.#send((encoder) => {
      encoding.writeVarUint(encoder, SYNC);
      sync.writeUpdate(encoder, update);
    });
    if (this.#pause) clearTimeout(this.#pause);
    this.#pause = setTimeout(
      () => this.#send((encoder) => encoding.writeVarUint(encoder, CHECKPOINT)),
      PAUSE_MS,
    );
  };

  readonly #onAwareness = (
    {
      added,
      updated,
      removed,
    }: { added: number[]; updated: number[]; removed: number[] },
    origin: unknown,
  ) => {
    if (origin === this) return;
    const changed = [...added, ...updated, ...removed].filter(
      (client) => client === this.doc.clientID,
    );
    if (changed.length === 0) return;
    this.#send((encoder) => {
      encoding.writeVarUint(encoder, AWARENESS);
      encoding.writeVarUint8Array(
        encoder,
        awarenessProtocol.encodeAwarenessUpdate(this.awareness, changed),
      );
    });
  };
}
