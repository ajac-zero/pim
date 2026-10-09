import { useSyncExternalStore } from "react";
import {
  type Approval,
  type PimNotification,
  pim,
  type ServerMessage,
} from "~/lib/pim-api";
import {
  EMPTY_STREAM,
  reduceAll,
  type SessionView,
  type StreamState,
} from "~/lib/pim-view";

/**
 * The live connection to the session on screen. It lives outside React so
 * it survives route changes, and reconnects with backoff: Pim's socket
 * starts every connection with a snapshot, so there is nothing to resume.
 */

export type ConnectionState = "connecting" | "open" | "closed";

export type ClientState = {
  session: string | null;
  connection: ConnectionState;
  view: SessionView;
  /** A message sent but not yet in the transcript. */
  pendingText: string | null;
};

export type ClientHandlers = {
  onNotification?: (notification: PimNotification) => void;
  onApproval?: (approval: Approval) => void;
  /** A run started or ended, so lists (titles, order) may have changed. */
  onActivity?: (session: string) => void;
};

const MAX_BACKOFF_MS = 15_000;

class PimClient {
  #state: ClientState = {
    session: null,
    connection: "closed",
    view: EMPTY_STREAM.view,
    pendingText: null,
  };
  #stream: StreamState = EMPTY_STREAM;
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
    this.close();
    this.#stream = EMPTY_STREAM;
    this.#set({
      session,
      view: EMPTY_STREAM.view,
      pendingText: null,
      connection: "connecting",
    });
    this.#connect();
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
        const before = this.#stream.view;
        this.#stream = reduceAll(this.#stream, message.events);
        const view = this.#stream.view;
        // The sent message is in the transcript now, or the run started with it.
        const placed =
          view.entries.length > before.entries.length || view.running;
        this.#set({
          view,
          ...(placed && this.#state.pendingText !== null
            ? { pendingText: null }
            : {}),
        });
        if (before.running !== view.running) {
          this.handlers.onActivity?.(message.session);
        }
        return;
      }
      case "notification":
        this.handlers.onNotification?.(message.notification);
        return;
      case "approval":
        this.handlers.onApproval?.(message.approval);
        return;
      default:
        return;
    }
  }

  /** Sends a message to the session on screen; it shows at once, until Pim places it. */
  async send(text: string) {
    const session = this.#state.session;
    if (!session) return;
    this.#set({ pendingText: text });
    try {
      await pim.send(session, text);
      this.handlers.onActivity?.(session);
    } catch (error) {
      this.#set({ pendingText: null });
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
