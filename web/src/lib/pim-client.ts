import type { AgentEvent } from "@earendil-works/pi-durable";
import { useSyncExternalStore } from "react";
import {
  type Approval,
  type PimNotification,
  pim,
  type ServerMessage,
  type UserContent,
} from "~/lib/pim-api";
import {
  EMPTY_STREAM,
  reduce,
  reduceAll,
  type SessionView,
  type StreamState,
} from "~/lib/pim-view";

/**
 * The live connection to the session on screen. It lives outside React so
 * it survives route changes, and reconnects with backoff: Pim's socket
 * starts every connection with a snapshot, so there is nothing to resume.
 * Opening another chat moves the open socket to it rather than connecting
 * again, and a chat opened before shows as it was left until its snapshot
 * arrives, so switching between chats doesn't wait on the network. A chat
 * about to be opened is warmed: its snapshot is fetched without following
 * it, so it opens as it is now rather than as it was left.
 */

export type ConnectionState = "connecting" | "open" | "closed";

export type ClientState = {
  session: string | null;
  connection: ConnectionState;
  view: SessionView;
  /** Whether `view` shows the followed session: as its snapshot has it, or as it was left. */
  loaded: boolean;
  /** Whether the followed session's snapshot has arrived, so `view` is current. */
  synced: boolean;
  /** A message sent but not yet in the transcript. */
  pending: UserContent | null;
};

export type ClientHandlers = {
  onNotification?: (notification: PimNotification) => void;
  onApproval?: (approval: Approval) => void;
  /** Someone shared their space with you, or took it back. */
  onVisits?: () => void;
  /** A run started or ended, so lists (titles, order) may have changed. */
  onActivity?: (session: string) => void;
  /** The session list changed outside a run: a chat got its title. */
  onSessions?: () => void;
  /** The tasks a chat led to changed. */
  onTasks?: (session: string) => void;
};

const MAX_BACKOFF_MS = 15_000;
/** How many chats' last views are kept, most recently followed first. */
const REMEMBERED_VIEWS = 10;
/** A chat warmed this recently, and not opened and left since, isn't fetched again: the pointer can pass over a tab many times. */
const WARM_INTERVAL_MS = 5_000;
/** Warming asks for a snapshot with this before the session as the command's id. */
const WARM_ID = "warm:";

class PimClient {
  #state: ClientState = {
    session: null,
    connection: "closed",
    view: EMPTY_STREAM.view,
    loaded: false,
    synced: false,
    pending: null,
  };
  #stream: StreamState = EMPTY_STREAM;
  /** The last stream state of chats followed before, by session. */
  #remembered = new Map<string, StreamState>();
  /** When each chat was last warmed. */
  #warmed = new Map<string, number>();
  #socket: WebSocket | null = null;
  #retry: ReturnType<typeof setTimeout> | null = null;
  #attempt = 0;
  #listeners = new Set<() => void>();
  handlers: ClientHandlers = {};

  subscribe = (listener: () => void) => {
    this.#listeners.add(listener);
    return () => {
      this.#listeners.delete(listener);
    };
  };

  getState = () => this.#state;

  #set(patch: Partial<ClientState>) {
    this.#state = { ...this.#state, ...patch };
    for (const listener of this.#listeners) listener();
  }

  /** Follows `session`, dropping whatever was followed before. */
  open(session: string) {
    if (this.#state.session === session && this.#socket) return;
    // The chat left behind starts to age: it can be warmed again at once.
    if (this.#state.session) this.#warmed.delete(this.#state.session);
    const remembered = this.#remembered.get(session);
    this.#stream = remembered ?? EMPTY_STREAM;
    const following = {
      session,
      view: this.#stream.view,
      loaded: remembered !== undefined,
      synced: false,
      pending: null,
    };
    const socket = this.#socket;
    if (socket?.readyState === WebSocket.OPEN) {
      // The old session's events still on their way are dropped: they name it.
      this.#set(following);
      socket.send(JSON.stringify({ type: "follow", session }));
      return;
    }
    this.close();
    this.#set({ ...following, connection: "connecting" });
    this.#connect();
  }

  /**
   * Fetches a chat's snapshot ahead of opening it, as the pointer rests on
   * a link to it, over the socket that's already open.
   */
  warm(session: string) {
    const socket = this.#socket;
    if (session === this.#state.session) return;
    if (socket?.readyState !== WebSocket.OPEN) return;
    if (Date.now() - (this.#warmed.get(session) ?? 0) < WARM_INTERVAL_MS) {
      return;
    }
    this.#warmed.set(session, Date.now());
    socket.send(
      JSON.stringify({ type: "snapshot", id: `${WARM_ID}${session}`, session }),
    );
  }

  #remember(session: string, stream: StreamState) {
    this.#remembered.delete(session);
    this.#remembered.set(session, stream);
    if (this.#remembered.size > REMEMBERED_VIEWS) {
      const [oldest] = this.#remembered.keys();
      if (oldest !== undefined) this.#remembered.delete(oldest);
    }
  }

  close() {
    if (this.#retry) clearTimeout(this.#retry);
    this.#retry = null;
    const socket = this.#socket;
    this.#socket = null;
    socket?.close();
    this.#set({ session: null, connection: "closed" });
  }

  #connect() {
    const session = this.#state.session;
    if (!session) return;
    const scheme = location.protocol === "https:" ? "wss" : "ws";
    const socket = new WebSocket(
      `${scheme}://${location.host}/api/ws?session=${encodeURIComponent(session)}`,
    );
    this.#socket = socket;
    socket.addEventListener("open", () => {
      if (this.#socket !== socket) return;
      this.#attempt = 0;
      this.#set({ connection: "open" });
    });
    socket.addEventListener("message", (event) => {
      if (this.#socket !== socket) return;
      this.#receive(JSON.parse(String(event.data)) as ServerMessage);
    });
    socket.addEventListener("close", () => {
      if (this.#socket !== socket) return;
      this.#socket = null;
      this.#set({ connection: "connecting" });
      const delay = Math.min(1000 * 2 ** this.#attempt, MAX_BACKOFF_MS);
      this.#attempt++;
      this.#retry = setTimeout(() => this.#connect(), delay);
    });
  }

  #receive(message: ServerMessage) {
    switch (message.type) {
      case "events": {
        if (message.session !== this.#state.session) return;
        // Until the snapshot, events may be from an earlier follow of this session.
        if (!this.#state.synced && message.events[0]?.type !== "snapshot") {
          return;
        }
        const before = this.#stream.view;
        this.#stream = reduceAll(this.#stream, message.events);
        const view = this.#stream.view;
        this.#remember(message.session, this.#stream);
        // The sent message is in the transcript now, or the run started with it.
        const placed =
          view.entries.length > before.entries.length || view.running;
        this.#set({
          view,
          loaded: true,
          synced: true,
          ...(placed && this.#state.pending !== null ? { pending: null } : {}),
        });
        if (before.running !== view.running) {
          this.handlers.onActivity?.(message.session);
        }
        return;
      }
      case "progress": {
        if (message.session !== this.#state.session) return;
        const lines = { ...this.#stream.view.lines };
        for (const call of message.calls) lines[call] = message.text;
        this.#stream = {
          ...this.#stream,
          view: { ...this.#stream.view, lines },
        };
        this.#remember(message.session, this.#stream);
        this.#set({ view: this.#stream.view });
        return;
      }
      case "result": {
        if (!message.id.startsWith(WARM_ID)) return;
        const session = message.id.slice(WARM_ID.length);
        // Onto what was remembered, so the lines written while it was open stay.
        const stream = reduce(
          this.#remembered.get(session) ?? EMPTY_STREAM,
          message.result as AgentEvent,
        );
        // The live stream of the chat on screen is newer than any snapshot.
        if (session === this.#state.session && this.#state.synced) return;
        this.#remember(session, stream);
        // Opened before its own snapshot came: show the warm one meanwhile.
        if (session === this.#state.session) {
          this.#stream = stream;
          this.#set({ view: stream.view, loaded: true });
        }
        return;
      }
      case "notification":
        this.handlers.onNotification?.(message.notification);
        return;
      case "approval":
        this.handlers.onApproval?.(message.approval);
        return;
      case "visits":
        this.handlers.onVisits?.();
        return;
      case "sessions":
        this.handlers.onSessions?.();
        return;
      case "tasks":
        this.handlers.onTasks?.(message.session);
        return;
      default:
        return;
    }
  }

  /** Sends a message to the session on screen; it shows at once, until Pim places it. */
  async send(content: UserContent) {
    const session = this.#state.session;
    if (!session) return;
    this.#set({ pending: content });
    try {
      await pim.send(session, content);
      this.handlers.onActivity?.(session);
    } catch (error) {
      this.#set({ pending: null });
      throw error;
    }
  }

  async stop() {
    const session = this.#state.session;
    if (session) await pim.abort(session);
  }
}

export const pimClient = new PimClient();

export function usePimClient<T>(select: (state: ClientState) => T): T {
  return useSyncExternalStore(pimClient.subscribe, () =>
    select(pimClient.getState()),
  );
}
