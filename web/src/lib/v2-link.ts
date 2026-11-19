import {
  LiveClient,
  type LiveSocket,
  type LiveStatus,
  type LiveUpdate,
  SnapshotRefused,
} from "@pim/shared/live-client";
import type { Session } from "~/lib/pim-api";
import type { StreamState } from "~/lib/pim-view";
import { EMPTY_STREAM } from "~/lib/pim-view";
import {
  applyBusy,
  applyMessage,
  applyProgress,
  applyQueue,
  type SidebarRow,
  sessionOf,
  streamOf,
  type V2Message,
  type V2Queued,
} from "~/lib/v2-view";

/**
 * What a page of Pim v2 reads and listens to: HTTP snapshots first, the Live socket after. The chat on screen and the sidebar are the only topics
 * followed. Nothing here waits for the socket: a chat is drawn from its snapshot the moment it arrives, and the socket only keeps it current.
 */

/** How many messages of a chat the first snapshot holds, and how many chats the sidebar loads (a few pages). */
const CHAT_PAGE = 100;
const SIDEBAR_PAGE = 50;
const SIDEBAR_MAX = 300;

type Fetch = typeof fetch;

async function getJson<T>(url: string, fetchImpl: Fetch): Promise<T> {
  const response = await fetchImpl(url, {
    redirect: "manual",
    headers: { accept: "application/json" },
  });
  if (response.type === "opaqueredirect") throw new SnapshotRefused(401);
  if (!response.ok) {
    if ([401, 403, 410].includes(response.status)) {
      throw new SnapshotRefused(response.status);
    }
    throw new Error(`Pim answered ${response.status}`);
  }
  return (await response.json()) as T;
}

type SidebarPage = {
  sessions: SidebarRow[];
  coding: unknown[];
  nextAfter: string | null;
  liveCursor: string | null;
};

/** The sidebar's snapshot, a few bounded pages of it, and the cursor to follow it from (that of its first page: later pages are older). */
export async function fetchSidebar(
  fetchImpl: Fetch = fetch,
): Promise<{ sessions: Session[]; liveCursor: string | null }> {
  const first = await getJson<SidebarPage>(
    `/api/snapshot/sidebar?limit=${SIDEBAR_PAGE}`,
    fetchImpl,
  );
  const rows = [...first.sessions];
  let after = first.nextAfter;
  while (after && rows.length < SIDEBAR_MAX) {
    const page = await getJson<SidebarPage>(
      `/api/snapshot/sidebar?limit=${SIDEBAR_PAGE}&after=${encodeURIComponent(after)}`,
      fetchImpl,
    );
    rows.push(...page.sessions);
    after = page.nextAfter;
  }
  return { sessions: rows.map(sessionOf), liveCursor: first.liveCursor };
}

type ChatPage = {
  messages: V2Message[];
  /** The person's messages queued behind the running turn, as of the cursor. */
  queue?: V2Queued[];
  nextBefore: string | null;
  liveCursor: string | null;
};

export type V2Handlers = {
  /** Reads the sidebar's snapshot into the app's lists; resolves with the cursor to follow it from and the chats it holds, which say which are at work. */
  loadSidebar(): Promise<{
    liveCursor: string | null;
    sessions: readonly Pick<Session, "id" | "busy">[];
  }>;
  onSidebarSummary(row: SidebarRow): void;
  onCodingSummary(): void;
  onUnauthorized(): void;
  /** Something happened in the person's space that the app should react to now: `kind` is a notification, an approval, a setting, a computer, tasks, visits, a file or a canvas request. */
  onNotice(kind: string, data: unknown): void;
  /** The Live socket is back after it dropped: what notices said meanwhile was missed, so what they stand for is read again. */
  onReconnected(): void;
};

export type V2Chat = {
  session: string;
  stream: StreamState;
  /** The server holds older messages than those loaded. */
  earlier: boolean;
};

export class V2Link {
  readonly #handlers: V2Handlers;
  readonly #fetch: Fetch;
  readonly #live: LiveClient;
  #chat: {
    id: string;
    messages: V2Message[];
    queue: V2Queued[];
    /** The lines said of the work, by tool call: they are not in any message, so a stream drawn again from the messages is given them again. */
    lines: Record<string, string>;
    nextBefore: string | null;
    stream: StreamState;
  } | null = null;
  #sidebar = false;
  /** Which chats the sidebar last said are at work. A chat's own messages can't say so while a long tool call writes nothing, so every view of a chat is settled by this. */
  readonly #busy = new Map<string, boolean>();
  readonly #onChat: (chat: V2Chat) => void;
  #everLive = false;
  #dropped = false;

  constructor(options: {
    handlers: V2Handlers;
    onChat: (chat: V2Chat) => void;
    onStatus: (status: LiveStatus) => void;
    openSocket?: () => LiveSocket;
    fetch?: Fetch;
  }) {
    this.#handlers = options.handlers;
    this.#onChat = options.onChat;
    this.#fetch = options.fetch ?? ((...args) => fetch(...args));
    this.#live = new LiveClient({
      openSocket:
        options.openSocket ??
        (() =>
          new WebSocket(
            `${location.protocol === "https:" ? "wss" : "ws"}://${location.host}/api/ws`,
          ) as unknown as LiveSocket),
      loadSnapshot: (topic) => this.#snapshot(topic),
      onUpdate: (update) => this.#update(update),
      onNotice: ({ kind, data }) => {
        // What the agent is doing now, in a few words, for the tool calls of its latest step: only the chat on screen shows it.
        if (kind === "progress") this.#progress(data);
        else this.#handlers.onNotice(kind, data);
      },
      onStatus: (status) => {
        if (status === "live" && this.#dropped) {
          this.#dropped = false;
          this.#handlers.onReconnected();
        } else if (status !== "live" && this.#everLive) this.#dropped = true;
        if (status === "live") this.#everLive = true;
        options.onStatus(status);
      },
      onUnauthorized: () => this.#handlers.onUnauthorized(),
    });
  }

  get status(): LiveStatus {
    return this.#live.status;
  }

  /** Follows this chat (null: none) and, while the app is open, the sidebar. */
  followChat(id: string | null): void {
    this.#chat = id
      ? {
          id,
          messages: [],
          queue: [],
          lines: {},
          nextBefore: null,
          stream: EMPTY_STREAM,
        }
      : null;
    this.#follow();
  }

  followSidebar(on: boolean): void {
    this.#sidebar = on;
    this.#follow();
  }

  #follow(): void {
    this.#live.follow([
      ...(this.#sidebar ? ["sidebar"] : []),
      ...(this.#chat ? [`chat:${this.#chat.id}`] : []),
    ]);
  }

  stop(): void {
    this.#live.stop();
  }

  /** Asks the server for something that is not a topic, such as watching a file; false when the socket is not open. */
  say(kind: string, data?: unknown): boolean {
    return this.#live.say(kind, data);
  }

  async #snapshot(topic: string): Promise<{ liveCursor: string | null }> {
    if (topic === "sidebar") {
      const { liveCursor, sessions } = await this.#handlers.loadSidebar();
      for (const row of sessions) this.#busy.set(row.id, row.busy);
      const open = this.#chat;
      const busy = open ? this.#busy.get(open.id) : undefined;
      if (open && busy !== undefined) {
        open.stream = applyBusy(open.stream, busy);
        this.#publish();
      }
      return { liveCursor };
    }
    const chat = this.#chat;
    const id = topic.slice("chat:".length);
    const page = await getJson<ChatPage>(
      `/api/snapshot/chat/${encodeURIComponent(id)}?limit=${CHAT_PAGE}`,
      this.#fetch,
    );
    // Opened another chat while this one loaded: it is not on screen.
    if (!chat || this.#chat !== chat || chat.id !== id) {
      return { liveCursor: page.liveCursor };
    }
    chat.messages = page.messages;
    chat.queue = page.queue ?? [];
    chat.nextBefore = page.nextBefore;
    chat.stream = this.#drawn(chat);
    this.#publish();
    return { liveCursor: page.liveCursor };
  }

  /** Older messages of the chat on screen, a page at a time. */
  async loadEarlier(): Promise<void> {
    const chat = this.#chat;
    if (!chat?.nextBefore) return;
    const page = await getJson<ChatPage>(
      `/api/snapshot/chat/${encodeURIComponent(chat.id)}?limit=${CHAT_PAGE}&before=${encodeURIComponent(chat.nextBefore)}`,
      this.#fetch,
    );
    if (this.#chat !== chat) return;
    const known = new Set(chat.messages.map((m) => m.id));
    chat.messages = [
      ...page.messages.filter((m) => !known.has(m.id)),
      ...chat.messages,
    ];
    chat.nextBefore = page.nextBefore;
    chat.stream = this.#drawn(chat);
    this.#publish();
  }

  #progress(data: unknown): void {
    const said = data as { session?: string; calls?: unknown; text?: unknown };
    const chat = this.#chat;
    if (!chat || said?.session !== chat.id || typeof said.text !== "string") {
      return;
    }
    if (!Array.isArray(said.calls)) return;
    const calls = said.calls.filter(
      (call): call is string => typeof call === "string",
    );
    for (const call of calls) chat.lines[call] = said.text;
    chat.stream = applyProgress(chat.stream, calls, said.text);
    this.#publish();
  }

  /** A chat drawn from its messages, at work as the sidebar last said: a reload or a page of older messages in the middle of a long tool call still shows the turn going on. */
  #drawn(chat: {
    id: string;
    messages: V2Message[];
    queue: V2Queued[];
    lines: Record<string, string>;
  }): StreamState {
    const drawn = streamOf(chat.messages, chat.queue);
    const stream = { ...drawn, view: { ...drawn.view, lines: chat.lines } };
    const busy = this.#busy.get(chat.id);
    return busy === undefined ? stream : applyBusy(stream, busy);
  }

  #publish(): void {
    const chat = this.#chat;
    if (chat) {
      this.#onChat({
        session: chat.id,
        stream: chat.stream,
        earlier: chat.nextBefore !== null,
      });
    }
  }

  /** What a live frame carries: one event, or a batch of a commit's. */
  #events(update: LiveUpdate): { kind: string; data: unknown }[] {
    const data = update.data as { events?: { kind: string; data: unknown }[] };
    if (update.kind === "batch" && Array.isArray(data?.events))
      return data.events;
    return [
      {
        kind: update.kind === "progress" ? "message.partial" : update.kind,
        data: update.data,
      },
    ];
  }

  #update(update: LiveUpdate): void {
    for (const event of this.#events(update)) {
      if (update.topic === "sidebar") {
        if (event.kind === "sidebar.summary") {
          const row = event.data as SidebarRow;
          this.#busy.set(row.chatId, row.busy);
          this.#handlers.onSidebarSummary(row);
          const chat = this.#chat;
          // The sidebar says whether the chat on screen is at work.
          if (chat && row.chatId === chat.id) {
            chat.stream = applyBusy(chat.stream, row.busy);
            this.#publish();
          }
        } else if (event.kind === "coding.summary") {
          this.#handlers.onCodingSummary();
        }
        continue;
      }
      const chat = this.#chat;
      if (!chat || update.topic !== `chat:${chat.id}`) continue;
      if (event.kind === "queue") {
        chat.queue = (event.data as { items?: V2Queued[] }).items ?? [];
        chat.stream = applyQueue(chat.stream, chat.queue);
      } else if (event.kind === "message" || event.kind === "message.partial") {
        const { message, partial } = event.data as {
          message: V2Message;
          partial: boolean;
        };
        const m = { ...message, partial };
        if (!partial) {
          if (
            chat.messages.some((known) => known.id === m.id && !known.partial)
          )
            continue;
          chat.messages = [
            ...chat.messages.filter((known) => known.id !== m.id),
            m,
          ];
        }
        chat.stream = applyMessage(chat.stream, m);
      }
    }
    this.#publish();
  }
}
