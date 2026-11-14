import type { AgentEvent, EntryRecord } from "@earendil-works/pi-durable";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { pim } from "~/lib/pim-api";
import { PimClient } from "~/lib/pim-client";

/** A browser WebSocket the test plays the server of. Closing it says nothing, as a half-open socket's doesn't. */
class FakeSocket extends EventTarget {
  static CONNECTING = 0;
  static OPEN = 1;
  static CLOSING = 2;
  static CLOSED = 3;
  static all: FakeSocket[] = [];
  readyState = FakeSocket.CONNECTING;
  sent: string[] = [];
  constructor(readonly url: string) {
    super();
    FakeSocket.all.push(this);
  }
  send(data: string) {
    this.sent.push(data);
  }
  close() {
    this.readyState = FakeSocket.CLOSING;
  }
  say(data: unknown) {
    this.dispatchEvent(
      new MessageEvent("message", {
        data: typeof data === "string" ? data : JSON.stringify(data),
      }),
    );
  }
  /** Opens, and sends what Pim sends a new socket: hello, then the chat's snapshot. */
  serve(entries: EntryRecord[] = []) {
    this.readyState = FakeSocket.OPEN;
    this.dispatchEvent(new Event("open"));
    this.say({ type: "hello", session: "s1", tools: [] });
    this.say(events(snapshot(entries)));
  }
  pings() {
    return this.sent.filter((data) => data === "ping").length;
  }
}

const latest = () => FakeSocket.all.at(-1) as FakeSocket;

const user = (id: number, text: string): EntryRecord =>
  ({
    id,
    kind: "pi.message",
    model: [{ role: "user", content: [{ type: "text", text }], timestamp: 0 }],
  }) as unknown as EntryRecord;

const reply = (id: number, text: string): EntryRecord =>
  ({
    id,
    kind: "pi.message",
    model: [{ role: "assistant", content: [{ type: "text", text }] }],
  }) as unknown as EntryRecord;

const snapshot = (entries: EntryRecord[]) =>
  ({
    type: "snapshot",
    entries,
    tools: [],
    compactions: [],
    inbox: [],
    agent: {},
    usage: {},
  }) as unknown as AgentEvent;

const events = (...list: AgentEvent[]) => ({
  type: "events",
  session: "s1",
  events: list,
});

/** pim.send as a request that never answers, failing only when aborted. */
function hangingSend() {
  return vi
    .spyOn(pim, "send")
    .mockImplementation(
      (_session, _content, { signal } = {}) =>
        new Promise((_resolve, reject) =>
          signal?.addEventListener("abort", () => reject(signal.reason)),
        ),
    );
}

const operationIds = (send: ReturnType<typeof hangingSend>) =>
  send.mock.calls.map(([, , options]) => options?.operationId);

let page: { visibilityState: string } & EventTarget;

beforeEach(() => {
  vi.useFakeTimers();
  FakeSocket.all = [];
  page = Object.assign(new EventTarget(), { visibilityState: "visible" });
  vi.stubGlobal("WebSocket", FakeSocket);
  vi.stubGlobal("window", new EventTarget());
  vi.stubGlobal("document", page);
  vi.stubGlobal("location", { protocol: "https:", host: "pim.test" });
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("the live connection", () => {
  it("pings every 20s, and replaces a socket that stops answering though it looks open", async () => {
    const client = new PimClient();
    client.open("s1");
    const first = latest();
    first.serve([user(1, "hi")]);
    expect(client.getState()).toMatchObject({
      connection: "open",
      synced: true,
    });

    await vi.advanceTimersByTimeAsync(20_000);
    expect(first.pings()).toBe(1);
    first.say("pong");
    await vi.advanceTimersByTimeAsync(20_000);
    expect(first.pings()).toBe(2);
    expect(FakeSocket.all).toHaveLength(1);

    // Silent: stale after 3s, given up after 10s, and another connects after a backoff of at most 1s.
    await vi.advanceTimersByTimeAsync(3_000);
    expect(client.getState().connection).toBe("stale");
    await vi.advanceTimersByTimeAsync(7_000);
    expect(first.readyState).toBe(FakeSocket.CLOSING);
    expect(client.getState().connection).toBe("connecting");
    await vi.advanceTimersByTimeAsync(1_000);
    expect(FakeSocket.all).toHaveLength(2);

    // The new socket's events before its snapshot are an older follow's, so they're dropped.
    const second = latest();
    expect(client.getState().synced).toBe(false);
    second.readyState = FakeSocket.OPEN;
    second.dispatchEvent(new Event("open"));
    second.say(events({ type: "entry_appended", entry: reply(9, "old") }));
    expect(client.getState().view.entries).toHaveLength(1);
    second.say(events(snapshot([user(1, "hi"), reply(2, "hello")])));
    expect(client.getState()).toMatchObject({
      connection: "open",
      synced: true,
    });
    expect(client.getState().view.entries).toHaveLength(2);
  });

  it("checks the socket when the page comes back online or into view, and connects at once without one", async () => {
    const client = new PimClient();
    client.open("s1");
    const first = latest();
    first.serve();

    // Answered: the socket stays.
    window.dispatchEvent(new Event("pageshow"));
    expect(first.pings()).toBe(1);
    first.say("pong");
    await vi.advanceTimersByTimeAsync(10_000);
    expect(FakeSocket.all).toHaveLength(1);

    // Unanswered: replaced within the quicker check after a wake.
    window.dispatchEvent(new Event("online"));
    expect(first.pings()).toBe(2);
    await vi.advanceTimersByTimeAsync(4_000);
    expect(first.readyState).toBe(FakeSocket.CLOSING);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(FakeSocket.all).toHaveLength(2);

    // Closed while hidden and waiting out a long backoff: shown again, it connects without waiting.
    const second = latest();
    second.serve();
    second.dispatchEvent(new Event("close"));
    page.visibilityState = "hidden";
    page.dispatchEvent(new Event("visibilitychange"));
    expect(FakeSocket.all).toHaveLength(2);
    page.visibilityState = "visible";
    page.dispatchEvent(new Event("visibilitychange"));
    expect(FakeSocket.all).toHaveLength(3);
    expect(client.getState().connection).toBe("connecting");
  });
});

describe("watching files", () => {
  const sent = (socket: FakeSocket) =>
    socket.sent
      .filter((data) => data !== "ping")
      .map((data) => JSON.parse(data));

  it("asks Pim to watch a file for as long as someone here does, and tells them of its changes", () => {
    const client = new PimClient();
    client.open("s1");
    const socket = latest();
    socket.serve();
    const first = vi.fn();
    const second = vi.fn();
    const stopFirst = client.watchFile("/workspace/./a.ts", first);
    const stopSecond = client.watchFile("/workspace/a.ts", second);
    // One watch for both, under the path Pim names.
    expect(sent(socket)).toEqual([
      { type: "watch_file", path: "/workspace/a.ts" },
    ]);
    socket.say({
      type: "file_changed",
      path: "/workspace/a.ts",
      kind: "modified",
      sha256: "h1",
      size: 3,
    });
    expect(first).toHaveBeenCalledWith({
      kind: "modified",
      sha256: "h1",
      size: 3,
    });
    expect(second).toHaveBeenCalledTimes(1);
    socket.say({
      type: "file_changed",
      path: "/workspace/other.ts",
      kind: "modified",
      sha256: "h2",
      size: 3,
    });
    expect(first).toHaveBeenCalledTimes(1);

    // The watch is let go with the last listener.
    stopFirst();
    expect(sent(socket)).toHaveLength(1);
    stopSecond();
    expect(sent(socket).at(-1)).toEqual({
      type: "unwatch_file",
      path: "/workspace/a.ts",
    });
  });

  it("watches again on a new connection and when Pim asks", async () => {
    const client = new PimClient();
    client.open("s1");
    const first = latest();
    first.serve();
    client.watchFile("/workspace/a.ts", () => {});
    first.dispatchEvent(new Event("close"));
    await vi.advanceTimersByTimeAsync(1_000);
    const second = latest();
    expect(second).not.toBe(first);
    second.serve();
    expect(sent(second)).toEqual([
      { type: "watch_file", path: "/workspace/a.ts" },
    ]);
    second.say({ type: "file_resync" });
    expect(sent(second)).toHaveLength(2);
  });

  it("passes on what agents ask of the canvas of the chat on screen, and answers", () => {
    const client = new PimClient();
    client.open("s1");
    const socket = latest();
    socket.serve();
    const asked = vi.fn();
    client.listenCanvas(asked);
    socket.say({
      type: "canvas_open",
      session: "s1",
      path: "/workspace/a.ts",
      line: 4,
    });
    socket.say({
      type: "canvas_query",
      session: "s1",
      request: "r1",
      what: "tabs",
    });
    // Another chat's asks aren't this canvas's.
    socket.say({ type: "canvas_open", session: "s2", path: "/workspace/b.ts" });
    expect(asked.mock.calls).toEqual([
      [{ type: "open", path: "/workspace/a.ts", line: 4 }],
      [{ type: "query", request: "r1", what: "tabs" }],
    ]);
    client.answerCanvas("r1", { tabs: [], active: null });
    expect(sent(socket).at(-1)).toEqual({
      type: "canvas_answer",
      request: "r1",
      tabs: [],
      active: null,
    });
  });
});

describe("sending a message", () => {
  it("tries a send that times out again under the same operation id, then shows it failed until the person retries", async () => {
    const send = hangingSend();
    const client = new PimClient();
    client.open("s1");
    latest().serve([user(1, "hi")]);

    const sent = client.send("hello").catch((error: Error) => error);
    expect(client.getState().pending).toMatchObject([
      { content: "hello", status: "sending" },
    ]);
    // 20s each, with 1s then 3s between.
    await vi.advanceTimersByTimeAsync(20_000 + 1_000 + 20_000 + 3_000 + 20_000);
    expect(send).toHaveBeenCalledTimes(3);
    const [id, ...again] = operationIds(send);
    expect(id).toEqual(expect.any(String));
    expect(again).toEqual([id, id]);
    expect(((await sent) as Error).message).toMatch(/didn't answer/);
    expect(client.getState().pending).toMatchObject([
      { content: "hello", operationId: id, status: "failed" },
    ]);

    // The person's retry is the same message: Pim places it once.
    send.mockResolvedValueOnce({ operationId: id as string, accepted: true });
    await client.retry(id as string);
    expect(operationIds(send)).toEqual([id, id, id, id]);
    expect(client.getState().pending).toMatchObject([
      { operationId: id, status: "sent" },
    ]);
  });

  it("doesn't send a message again by itself once the chat moved on without it", async () => {
    const send = hangingSend();
    const client = new PimClient();
    client.open("s1");
    const socket = latest();
    socket.serve([user(1, "hi")]);

    const sent = client.send("hello").catch((error: Error) => error);
    socket.say("pong");
    socket.say(
      events({ type: "entry_appended", entry: reply(2, "meanwhile") }),
    );
    await vi.advanceTimersByTimeAsync(20_000 + 1_000 + 20_000);
    expect(send).toHaveBeenCalledTimes(1);
    expect(await sent).toBeInstanceOf(Error);
    expect(client.getState().pending).toMatchObject([
      { content: "hello", status: "failed" },
    ]);

    // Discarded, it gives back what it said.
    const operationId = client.getState().pending[0]?.operationId ?? "";
    expect(client.discard(operationId)).toBe("hello");
    expect(client.getState().pending).toEqual([]);
  });

  it("drops a send the reconnected socket's snapshot shows placed, rather than sending it twice", async () => {
    const send = hangingSend();
    const client = new PimClient();
    client.open("s1");
    const first = latest();
    first.serve([user(1, "hi")]);

    // The socket is dead, so sending checks it, and it is replaced.
    const sent = client.send("hello");
    await vi.advanceTimersByTimeAsync(5_000);
    expect(FakeSocket.all).toHaveLength(2);
    latest().serve([user(1, "hi"), user(2, "hello")]);
    expect(client.getState().pending).toEqual([]);
    expect(client.getState().view.entries).toHaveLength(2);

    await vi.advanceTimersByTimeAsync(60_000);
    expect(send).toHaveBeenCalledTimes(1);
    await expect(sent).resolves.toBeUndefined();
  });
});
