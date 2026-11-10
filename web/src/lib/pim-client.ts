import type { AgentEvent } from "@earendil-works/pi-durable";
import { useSyncExternalStore } from "react";
import { type MessageItem, messageText } from "~/lib/openresponses";
import {
  ApiError,
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
 * A socket can look open long after the network under it is gone, so it is
 * pinged, and one that stops answering is replaced; coming back online or
 * to the page checks it at once.
 * Opening another chat moves the open socket to it rather than connecting
 * again, and a chat opened before shows as it was left until its snapshot
 * arrives, so switching between chats doesn't wait on the network. A chat
 * about to be opened is warmed: its snapshot is fetched without following
 * it, so it opens as it is now rather than as it was left.
 */

/** `stale`: open, but a ping has gone unanswered for a while. */
export type ConnectionState = "connecting" | "open" | "stale" | "closed";

/** A message the person sent that the chat doesn't show yet. */
export type PendingSend = {
  content: UserContent;
  /** Pim places a message sent again under the same id only once. */
  operationId: string;
  /**
   * `sending`: on its way. `sent`: Pim has it, and it is about to show.
   * `failed`: it didn't go, and waits for the person to retry or discard it.
   */
  status: "sending" | "sent" | "failed";
  /** The chat's last entry when it was sent: anything after it is newer. */
  after: string | null;
  /** The queue when it was sent, by id: the messages in it then aren't this one. */
  queued: readonly number[];
};

export type ClientState = {
  session: string | null;
  connection: ConnectionState;
  view: SessionView;
  /** Whether `view` shows the followed session: as its snapshot has it, or as it was left. */
  loaded: boolean;
  /** Whether the followed session's snapshot has arrived, so `view` is current. */
  synced: boolean;
  /** The followed session's messages sent but not yet in the transcript, oldest first. */
  pending: readonly PendingSend[];
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
  /** Your computer was connected or removed, came online or went offline. */
  onComputer?: () => void;
  onSettings?: () => void;
};

const MAX_BACKOFF_MS = 15_000;
/** How often an open socket is pinged. Pim answers without waking. */
const HEARTBEAT_MS = 20_000;
/** A socket that says nothing this long after a ping is dead, however open it looks. */
const PING_TIMEOUT_MS = 10_000;
/** Back online or on the page again, the person is waiting: the check is quicker. */
const WAKE_TIMEOUT_MS = 4_000;
/** A ping unanswered this long shows the connection as stale. */
const STALE_MS = 3_000;
/** A socket that says nothing this long after connecting is given up and tried again. */
const CONNECT_TIMEOUT_MS = 15_000;
/** How long sending a message may take before it is tried again. */
const SEND_TIMEOUT_MS = 20_000;
/** The waits before each try again of a message that didn't go. */
const SEND_RETRY_MS = [1_000, 3_000];
/** How many chats' last views are kept, most recently followed first. */
const REMEMBERED_VIEWS = 10;
/** A chat warmed this recently, and not opened and left since, isn't fetched again: the pointer can pass over a tab many times. */
const WARM_INTERVAL_MS = 5_000;
/** Warming asks for a snapshot with this before the session as the command's id. */
const WARM_ID = "warm:";

export class PimClient {
  #state: ClientState = {
    session: null,
    connection: "closed",
    view: EMPTY_STREAM.view,
    loaded: false,
    synced: false,
    pending: [],
  };
  #stream: StreamState = EMPTY_STREAM;
  /** The last stream state of chats followed before, by session. */
  #remembered = new Map<string, StreamState>();
  /** When each chat was last warmed. */
  #warmed = new Map<string, number>();
  #socket: WebSocket | null = null;
  #retry: ReturnType<typeof setTimeout> | null = null;
  #attempt = 0;
  #heartbeat: ReturnType<typeof setInterval> | null = null;
  /** Drops the socket unless it says something first; `#due` is when. */
  #deadline: ReturnType<typeof setTimeout> | null = null;
  #due = 0;
  #stale: ReturnType<typeof setTimeout> | null = null;
  #listening = false;
  /** Messages not yet in their chat's transcript, by session, so they wait there while another chat is open. */
  #pending = new Map<string, readonly PendingSend[]>();
  /** The request of each message on its way, by operation id. */
  #sending = new Map<string, AbortController>();
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
    this.#listen();
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
      pending: this.#pending.get(session) ?? [],
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
    this.#drop();
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
    // Until the new socket's snapshot, its events could land on an older view.
    this.#set({ connection: "connecting", synced: false });
    this.#expect(socket, CONNECT_TIMEOUT_MS);
    socket.addEventListener("open", () => {
      if (this.#socket !== socket) return;
      this.#attempt = 0;
      this.#set({ connection: "open" });
      this.#heartbeat = setInterval(
        () => this.#check(PING_TIMEOUT_MS),
        HEARTBEAT_MS,
      );
    });
    socket.addEventListener("message", (event) => {
      if (this.#socket !== socket) return;
      this.#heard();
      if (event.data === "pong") return;
      this.#receive(JSON.parse(String(event.data)) as ServerMessage);
    });
    socket.addEventListener("close", () => this.#lost(socket));
  }

  /** The socket closed or went quiet: it is let go, and another connects after a backoff. */
  #lost(socket: WebSocket) {
    if (this.#socket !== socket) return;
    this.#drop();
    this.#set({ connection: "connecting" });
    const delay = Math.min(1000 * 2 ** this.#attempt, MAX_BACKOFF_MS);
    this.#attempt++;
    // Jittered, so the sockets one deploy dropped don't all come back at once.
    this.#retry = setTimeout(
      () => {
        this.#retry = null;
        this.#connect();
      },
      delay / 2 + (Math.random() * delay) / 2,
    );
  }

  /** Lets the socket go, with its timers; its events are ignored from now on. */
  #drop() {
    const socket = this.#socket;
    this.#socket = null;
    if (this.#heartbeat) clearInterval(this.#heartbeat);
    if (this.#deadline) clearTimeout(this.#deadline);
    if (this.#stale) clearTimeout(this.#stale);
    this.#heartbeat = this.#deadline = this.#stale = null;
    socket?.close();
  }

  /** Gives `socket` until `timeout` from now to say something, or it is dropped as dead. */
  #expect(socket: WebSocket, timeout: number) {
    const due = Date.now() + timeout;
    if (this.#deadline && this.#due <= due) return;
    if (this.#deadline) clearTimeout(this.#deadline);
    this.#due = due;
    this.#deadline = setTimeout(() => this.#lost(socket), timeout);
  }

  /** Anything the socket says shows it is alive. */
  #heard() {
    if (this.#deadline) clearTimeout(this.#deadline);
    if (this.#stale) clearTimeout(this.#stale);
    this.#deadline = this.#stale = null;
    if (this.#state.connection === "stale") this.#set({ connection: "open" });
  }

  /** Pings an open socket, which must answer within `timeout`. */
  #check(timeout: number) {
    const socket = this.#socket;
    if (socket?.readyState !== WebSocket.OPEN) return;
    socket.send("ping");
    this.#expect(socket, timeout);
    this.#stale ??= setTimeout(
      () => {
        if (this.#socket === socket) this.#set({ connection: "stale" });
      },
      Math.min(STALE_MS, timeout),
    );
  }

  /**
   * Checks the socket when it may have died unseen: back online, on the
   * page again, or about to be needed. An open one is pinged; without one,
   * the next waits for no backoff.
   */
  #wake() {
    if (!this.#state.session) return;
    const socket = this.#socket;
    if (socket?.readyState === WebSocket.OPEN) {
      this.#check(WAKE_TIMEOUT_MS);
      return;
    }
    // A connection on its way has its own deadline.
    if (socket?.readyState === WebSocket.CONNECTING) return;
    this.#drop();
    if (this.#retry) clearTimeout(this.#retry);
    this.#retry = null;
    this.#attempt = 0;
    this.#connect();
  }

  #listen() {
    if (this.#listening || typeof window === "undefined") return;
    this.#listening = true;
    window.addEventListener("online", () => this.#wake());
    // Shown again, or brought back from the back-forward cache.
    window.addEventListener("pageshow", () => this.#wake());
    document.addEventListener("visibilitychange", () => {
      if (document.visibilityState === "visible") this.#wake();
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
        this.#set({
          view,
          loaded: true,
          synced: true,
          pending: this.#placed(message.session, before),
        });
        // A run held for the person to try again isn't at work, though it is still running.
        const held = (state: SessionView) => state.retry?.at === 0;
        if (before.running !== view.running || held(before) !== held(view)) {
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
      case "computer":
        this.handlers.onComputer?.();
        return;
      case "settings":
        this.handlers.onSettings?.();
        return;
      default:
        return;
    }
  }

  /**
   * Takes the messages the chat now shows, in its transcript or its queue,
   * out of its pending ones, and returns the rest.
   */
  #placed(session: string, before: SessionView): readonly PendingSend[] {
    const sends = this.#pending.get(session) ?? [];
    if (sends.length === 0) return sends;
    const view = this.#stream.view;
    // A message Pim has is taken to be in the longer transcript, or the run it started.
    const grew = view.entries.length > before.entries.length || view.running;
    const claimed = new Set<string>();
    const left = sends.filter((send) => {
      if (!shows(view, send, claimed) && !(send.status === "sent" && grew)) {
        return true;
      }
      this.#sending.get(send.operationId)?.abort();
      return false;
    });
    if (left.length === sends.length) return sends;
    this.#pending.set(session, left);
    return left;
  }

  #setPending(session: string, sends: readonly PendingSend[]) {
    this.#pending.set(session, sends);
    if (session === this.#state.session) this.#set({ pending: sends });
  }

  #findPending(session: string, operationId: string) {
    return this.#pending
      .get(session)
      ?.find((send) => send.operationId === operationId);
  }

  #updatePending(
    session: string,
    operationId: string,
    patch: Partial<PendingSend>,
  ) {
    const sends = this.#pending.get(session) ?? [];
    this.#setPending(
      session,
      sends.map((send) =>
        send.operationId === operationId ? { ...send, ...patch } : send,
      ),
    );
  }

  /** Sends a message to the session on screen; it shows at once, until Pim places it. */
  async send(content: UserContent) {
    const session = this.#state.session;
    if (!session) return;
    const send: PendingSend = {
      content,
      operationId: crypto.randomUUID(),
      status: "sending",
      ...this.#position(),
    };
    this.#setPending(session, [...(this.#pending.get(session) ?? []), send]);
    await this.#deliver(session, send);
  }

  /** Sends a message that didn't go again, as the person asked, wherever the chat is now. */
  async retry(operationId: string) {
    const session = this.#state.session;
    if (
      !session ||
      this.#findPending(session, operationId)?.status !== "failed"
    ) {
      return;
    }
    this.#updatePending(session, operationId, {
      status: "sending",
      ...this.#position(),
    });
    const send = this.#findPending(session, operationId);
    if (send) await this.#deliver(session, send);
  }

  /** Gives up on a pending message, and returns what it said, to be written again. */
  discard(operationId: string): UserContent | null {
    const session = this.#state.session;
    const send = session && this.#findPending(session, operationId);
    if (!session || !send) return null;
    this.#sending.get(operationId)?.abort();
    this.#setPending(
      session,
      (this.#pending.get(session) ?? []).filter((other) => other !== send),
    );
    return send.content;
  }

  /**
   * Sends a message over HTTP, trying again under the same operation id when
   * it times out or doesn't reach Pim, so it is placed once. It isn't tried
   * again after the chat moved on without it: the person decides then, as it
   * would land after what came since.
   */
  async #deliver(session: string, send: PendingSend) {
    const { operationId } = send;
    // The reply comes over the socket, so a socket not known to be well is checked.
    this.#wake();
    let failure: unknown;
    for (let attempt = 0; attempt <= SEND_RETRY_MS.length; attempt++) {
      if (attempt > 0) {
        await new Promise((resolve) =>
          setTimeout(resolve, SEND_RETRY_MS[attempt - 1]),
        );
        const now = this.#findPending(session, operationId);
        // Placed or discarded meanwhile.
        if (!now) return;
        if (this.#movedOn(session, now)) break;
      }
      const controller = new AbortController();
      this.#sending.set(operationId, controller);
      const timer = setTimeout(
        () => controller.abort(new SendTimeout()),
        SEND_TIMEOUT_MS,
      );
      try {
        await pim.send(session, send.content, {
          operationId,
          signal: controller.signal,
        });
        const now = this.#findPending(session, operationId);
        // Pim has it: in a chat that went on or is at work, it is already there or queued.
        if (now && (this.#movedOn(session, now) || this.#state.view.running)) {
          this.#setPending(
            session,
            (this.#pending.get(session) ?? []).filter((other) => other !== now),
          );
        } else if (now) {
          this.#updatePending(session, operationId, { status: "sent" });
        }
        this.handlers.onActivity?.(session);
        return;
      } catch (error) {
        if (!this.#findPending(session, operationId)) return;
        failure = error;
        if (!retryable(error)) break;
        this.#wake();
      } finally {
        clearTimeout(timer);
        if (this.#sending.get(operationId) === controller) {
          this.#sending.delete(operationId);
        }
      }
    }
    this.#updatePending(session, operationId, { status: "failed" });
    throw failure;
  }

  /** Where the chat on screen is now, for a message sent from here. */
  #position(): Pick<PendingSend, "after" | "queued"> {
    const { entries, queue } = this.#stream.view;
    return {
      after: entries.at(-1)?.key ?? null,
      queued: queue.map((item) => item.id),
    };
  }

  /** Whether the chat has entries after where `send` was sent, or isn't on screen to tell. */
  #movedOn(session: string, send: PendingSend) {
    if (session !== this.#state.session) return true;
    const entries = this.#stream.view.entries;
    if (send.after === null) return entries.length > 0;
    const at = entries.findIndex((entry) => entry.key === send.after);
    return at === -1 || at < entries.length - 1;
  }

  async stop() {
    const session = this.#state.session;
    if (session) await pim.abort(session);
  }
}

/** Sending took too long: Pim, or the network to it, didn't answer. */
class SendTimeout extends Error {
  constructor() {
    super("Pim didn't answer in time. Check your connection and try again.");
  }
}

/** Whether a send that failed this way may have failed for the network, so trying again can help. */
function retryable(error: unknown) {
  return (
    error instanceof SendTimeout ||
    // fetch's network failure.
    error instanceof TypeError ||
    (error instanceof ApiError && error.status >= 500)
  );
}

/** The text of what a person sends, without its images. */
export function textOf(content: UserContent): string {
  if (typeof content === "string") return content;
  return content
    .flatMap((part) => (part.type === "text" ? [part.text] : []))
    .join("");
}

/**
 * Whether the view shows `send`: one of the person's messages with its text,
 * in the transcript after where it was sent, or in the queue and not there
 * before, that no other pending message has `claimed`. When where it was
 * sent is gone, as after a reset, the transcript isn't searched: a false
 * match would drop a message that was never placed, while a miss only
 * leaves it to be sent again under its id, which Pim places once.
 */
function shows(view: SessionView, send: PendingSend, claimed: Set<string>) {
  const text = textOf(send.content);
  const at =
    send.after === null
      ? -1
      : view.entries.findIndex((entry) => entry.key === send.after);
  const entry =
    send.after !== null && at === -1
      ? undefined
      : view.entries
          .slice(at + 1)
          .find(
            (entry) =>
              entry.kind === "item" &&
              entry.source === "user" &&
              entry.item.type === "message" &&
              !claimed.has(entry.key) &&
              messageText(entry.item as MessageItem) === text,
          );
  const queued = view.queue.find(
    (item) =>
      !send.queued.includes(item.id) &&
      !claimed.has(`queue:${item.id}`) &&
      item.text === text,
  );
  const key = entry?.key ?? (queued ? `queue:${queued.id}` : undefined);
  if (key === undefined) return false;
  claimed.add(key);
  return true;
}

export const pimClient = new PimClient();

export function usePimClient<T>(select: (state: ClientState) => T): T {
  return useSyncExternalStore(pimClient.subscribe, () =>
    select(pimClient.getState()),
  );
}
