import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PimClient } from "~/lib/pim-client";
import {
  resetServerGeneration,
  setServerGeneration,
} from "~/lib/server-capabilities";
import type { V2Message } from "~/lib/v2-view";

const P = "11111111-1111-4111-8111-111111111111";
const at = (commit: number) => `${P}:1:${commit}`;

/** The Live service's socket, which the test plays: it stays CONNECTING until it opens it. */
class LiveSocket {
  static all: LiveSocket[] = [];
  sent: Record<string, unknown>[] = [];
  onopen: (() => void) | null = null;
  onmessage: ((event: { data: unknown }) => void) | null = null;
  onclose: ((event: { code: number }) => void) | null = null;
  constructor(readonly url: string) {
    LiveSocket.all.push(this);
  }
  send(data: string) {
    this.sent.push(JSON.parse(data));
  }
  close() {}
  open() {
    this.onopen?.();
  }
  say(frame: object) {
    this.onmessage?.({ data: JSON.stringify(frame) });
  }
  drop(code = 1006) {
    this.onclose?.({ code });
  }
  get subs() {
    return this.sent.filter(
      (frame) => frame.type === "subscribe" || frame.type === "unsubscribe",
    );
  }
}

const user = (id: number, text: string): V2Message => ({
  id: String(id),
  role: "user",
  parts: [{ type: "text", text }],
  timestamp: id,
});
const assistant = (id: number, text: string): V2Message => ({
  id: String(id),
  role: "assistant",
  parts: [{ type: "text", text }],
  timestamp: id,
  stopReason: "stop",
});

type Pages = Record<
  string,
  {
    messages: V2Message[];
    nextBefore: string | null;
    liveCursor: string | null;
  }
>;

function server(pages: Pages) {
  const requests: string[] = [];
  const fetchImpl = vi.fn(async (input: RequestInfo | URL) => {
    const url = String(input);
    requests.push(url);
    const chat = /^\/api\/snapshot\/chat\/([^?]+)(?:\?(.*))?$/.exec(url);
    if (!chat)
      return {
        ok: false,
        status: 404,
        type: "basic",
        json: async () => ({}),
      } as Response;
    const page =
      pages[chat[1]! + (chat[2]?.includes("before=") ? ":older" : "")];
    return {
      ok: true,
      status: 200,
      type: "basic",
      json: async () => page,
    } as Response;
  });
  return { fetchImpl, requests };
}

const flush = () => new Promise((resolve) => setTimeout(resolve, 0));
const textOf = (client: PimClient) =>
  client
    .getState()
    .view.entries.map((entry) =>
      entry.kind === "item" && entry.item.type === "message"
        ? JSON.stringify(entry.item.content)
        : entry.kind,
    );

beforeEach(() => {
  LiveSocket.all = [];
  setServerGeneration("v2");
  vi.stubGlobal("WebSocket", LiveSocket);
  vi.stubGlobal("location", { protocol: "http:", host: "pim.test" });
});
afterEach(() => {
  vi.unstubAllGlobals();
  resetServerGeneration();
});

describe("a chat and the sidebar on Pim v2, with the socket still connecting", () => {
  it("draws the chat from its HTTP snapshot at once: loaded, in sync, with the socket syncing and no connection held up", async () => {
    const { fetchImpl } = server({
      c1: {
        messages: [user(1, "hello"), assistant(2, "Hi there")],
        nextBefore: null,
        liveCursor: at(2),
      },
    });
    vi.stubGlobal("fetch", fetchImpl);
    const client = new PimClient();
    client.open("c1");
    // Before anything arrives: nothing to show, and the socket is connecting.
    expect(client.getState()).toMatchObject({
      session: "c1",
      loaded: false,
      connection: "connecting",
    });
    await flush();
    const state = client.getState();
    expect(state).toMatchObject({
      loaded: true,
      synced: true,
      connection: "connecting",
    });
    expect(state.view.entries).toHaveLength(2);
    // The socket has not opened, and the chat is on screen.
    expect(LiveSocket.all).toHaveLength(1);
    expect(LiveSocket.all[0]!.subs).toEqual([]);
    // What the chat's page shows: the transcript, with a small syncing indicator in place of a blank "Connecting…".
    const Page = ({ client }: { client: PimClient }) => {
      const s = client.getState();
      return (
        <main>
          {s.loaded ? (
            <ol>
              {s.view.entries.map((e) => (
                <li key={e.key}>{e.key}</li>
              ))}
            </ol>
          ) : (
            <p>Connecting…</p>
          )}
          {s.connection !== "open" && <small data-sync>Syncing</small>}
        </main>
      );
    };
    const html = renderToStaticMarkup(<Page client={client} />);
    expect(html).toContain("<li>1</li><li>2:0</li>");
    expect(html).toContain("data-sync");
    expect(html).not.toContain("Connecting…");
    // Then the socket opens and subscribes from the snapshot's cursor.
    LiveSocket.all[0]!.open();
    expect(LiveSocket.all[0]!.subs).toEqual([
      { type: "subscribe", topic: "chat:c1", cursor: at(2) },
    ]);
    expect(client.getState().connection).toBe("open");
  });

  it("streams a partial answer, replaces it as it grows, and commits it, as the socket delivers", async () => {
    const { fetchImpl } = server({
      c1: { messages: [user(1, "hi")], nextBefore: null, liveCursor: at(1) },
    });
    vi.stubGlobal("fetch", fetchImpl);
    const activity = vi.fn();
    const client = new PimClient();
    client.handlers.onActivity = activity;
    client.open("c1");
    await flush();
    const socket = LiveSocket.all[0]!;
    socket.open();
    const partial = (text: string) => ({
      message: assistant(2, text),
      partial: true,
    });
    socket.say({
      type: "event",
      topic: "chat:c1",
      cursor: at(2),
      kind: "message.partial",
      data: partial("Hel"),
    });
    expect(client.getState().view).toMatchObject({ running: true });
    expect(client.getState().view.live.length).toBeGreaterThan(0);
    expect(activity).toHaveBeenCalledWith("c1");
    // A slow reader gets the latest: a coalesced update standing for those before it.
    socket.say({
      type: "coalesced_progress",
      topic: "chat:c1",
      cursor: at(40),
      skipped: 37,
      data: partial("Hello, wor"),
    });
    expect(JSON.stringify(client.getState().view.live)).toContain("Hello, wor");
    socket.say({
      type: "event",
      topic: "chat:c1",
      cursor: at(41),
      kind: "message",
      data: { message: assistant(2, "Hello, world"), partial: false },
    });
    const view = client.getState().view;
    expect(view.live).toEqual([]);
    expect(textOf(client).at(-1)).toContain("Hello, world");
    expect(view.entries).toHaveLength(2);
    // A duplicate of what was applied changes nothing.
    socket.say({
      type: "event",
      topic: "chat:c1",
      cursor: at(41),
      kind: "message",
      data: { message: assistant(2, "Hello, world"), partial: false },
    });
    expect(client.getState().view.entries).toHaveLength(2);
  });

  it("keeps the chat on screen while the socket drops and reconnects, and resumes from where it was", async () => {
    const { fetchImpl } = server({
      c1: {
        messages: [user(1, "hi"), assistant(2, "hello")],
        nextBefore: null,
        liveCursor: at(2),
      },
    });
    vi.stubGlobal("fetch", fetchImpl);
    vi.useFakeTimers({ toFake: ["setTimeout"] });
    try {
      const client = new PimClient();
      client.open("c1");
      await vi.advanceTimersByTimeAsync(0);
      const first = LiveSocket.all[0]!;
      first.open();
      first.say({
        type: "event",
        topic: "chat:c1",
        cursor: at(3),
        kind: "message",
        data: { message: user(3, "more"), partial: false },
      });
      first.drop();
      expect(client.getState()).toMatchObject({
        connection: "connecting",
        loaded: true,
        synced: true,
      });
      expect(client.getState().view.entries).toHaveLength(3);
      await vi.advanceTimersByTimeAsync(20_000);
      const second = LiveSocket.all[1]!;
      second.open();
      expect(second.subs).toEqual([
        { type: "subscribe", topic: "chat:c1", cursor: at(3) },
      ]);
      expect(client.getState().connection).toBe("open");
    } finally {
      vi.useRealTimers();
    }
  });

  it("switches chats on the same socket: the old topic is let go, the new one is drawn from its own snapshot", async () => {
    const { fetchImpl, requests } = server({
      c1: {
        messages: [user(1, "first chat")],
        nextBefore: null,
        liveCursor: at(1),
      },
      c2: {
        messages: [user(1, "second chat")],
        nextBefore: null,
        liveCursor: `${P}:1:7`,
      },
    });
    vi.stubGlobal("fetch", fetchImpl);
    const client = new PimClient();
    client.open("c1");
    await flush();
    LiveSocket.all[0]!.open();
    client.open("c2");
    expect(client.getState()).toMatchObject({ session: "c2", loaded: false });
    await flush();
    expect(JSON.stringify(textOf(client))).toContain("second chat");
    expect(
      requests.filter((url) => url.startsWith("/api/snapshot/chat/")),
    ).toHaveLength(2);
    expect(LiveSocket.all).toHaveLength(1);
    expect(LiveSocket.all[0]!.subs).toEqual([
      { type: "subscribe", topic: "chat:c1", cursor: at(1) },
      { type: "unsubscribe", topic: "chat:c1" },
      { type: "subscribe", topic: "chat:c2", cursor: `${P}:1:7` },
    ]);
    // Coming back to the first draws it as it was left, before its snapshot.
    client.open("c1");
    expect(client.getState()).toMatchObject({ session: "c1", loaded: true });
  });

  it("pages a long chat: the snapshot holds the newest messages, and older ones come on request", async () => {
    const { fetchImpl } = server({
      c1: {
        messages: [user(3, "newer"), assistant(4, "newest")],
        nextBefore: "3",
        liveCursor: at(4),
      },
      "c1:older": {
        messages: [user(1, "oldest"), assistant(2, "older")],
        nextBefore: null,
        liveCursor: at(4),
      },
    });
    vi.stubGlobal("fetch", fetchImpl);
    const client = new PimClient();
    client.open("c1");
    await flush();
    expect(client.getState()).toMatchObject({ earlier: true });
    expect(client.getState().view.entries.map((e) => e.key)).toEqual([
      "3",
      "4:0",
    ]);
    await client.loadEarlier();
    expect(client.getState().view.entries.map((e) => e.key)).toEqual([
      "1",
      "2:0",
      "3",
      "4:0",
    ]);
    expect(client.getState().earlier).toBe(false);
  });

  it("keeps the sidebar current with the live service's summaries, one chat's line at a time", async () => {
    const { fetchImpl } = server({});
    vi.stubGlobal("fetch", fetchImpl);
    const loadSidebar = vi.fn(async () => at(5));
    const onSidebarSummary = vi.fn();
    const client = new PimClient();
    client.handlers = { loadSidebar, onSidebarSummary };
    client.followSidebar(true);
    await flush();
    expect(loadSidebar).toHaveBeenCalledTimes(1);
    const socket = LiveSocket.all[0]!;
    socket.open();
    expect(socket.subs).toEqual([
      { type: "subscribe", topic: "sidebar", cursor: at(5) },
    ]);
    const row = {
      chatId: "c9",
      title: "New",
      busy: true,
      unread: false,
      updatedAt: 10,
    };
    socket.say({
      type: "event",
      topic: "sidebar",
      cursor: at(6),
      kind: "sidebar.summary",
      data: row,
    });
    expect(onSidebarSummary).toHaveBeenCalledWith(row);
    // A commit's several events arrive together, as one batch.
    socket.say({
      type: "event",
      topic: "sidebar",
      cursor: at(7),
      kind: "batch",
      data: {
        events: [
          { kind: "sidebar.summary", data: { ...row, chatId: "c8" } },
          { kind: "sidebar.summary", data: { ...row, chatId: "c7" } },
        ],
      },
    });
    expect(onSidebarSummary.mock.calls.map(([r]) => r.chatId)).toEqual([
      "c9",
      "c8",
      "c7",
    ]);
    // No chat is open: the page makes no request for one.
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("wipes what was kept when access ends: 4003 stops the connection and tells the app", async () => {
    const { fetchImpl } = server({
      c1: { messages: [], nextBefore: null, liveCursor: null },
    });
    vi.stubGlobal("fetch", fetchImpl);
    const onUnauthorized = vi.fn();
    const client = new PimClient();
    client.handlers = { onUnauthorized };
    client.open("c1");
    await flush();
    LiveSocket.all[0]!.open();
    LiveSocket.all[0]!.drop(4003);
    expect(onUnauthorized).toHaveBeenCalledTimes(1);
    expect(client.getState().connection).toBe("closed");
  });
});
