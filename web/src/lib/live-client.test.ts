import { describe, expect, it, vi } from "vitest";
import {
  LiveClient,
  type LiveEventFrame,
  type LiveSocket,
  type LiveStatus,
  SnapshotRefused,
} from "~/lib/live-client";

class FakeSocket implements LiveSocket {
  sent: Record<string, unknown>[] = [];
  closedWith: number | undefined;
  onopen: (() => void) | null = null;
  onmessage: ((event: { data: unknown }) => void) | null = null;
  onclose: ((event: { code: number }) => void) | null = null;
  send(data: string) {
    this.sent.push(JSON.parse(data));
  }
  close(code?: number) {
    this.closedWith = code;
  }
  open() {
    this.onopen?.();
  }
  say(frame: object) {
    this.onmessage?.({ data: JSON.stringify(frame) });
  }
  drop(code = 1006) {
    this.onclose?.({ code });
  }
}

function setup(
  snapshot: (stream: string) => Promise<{ liveCursor: number }> = async () => ({
    liveCursor: 10,
  }),
) {
  const sockets: FakeSocket[] = [];
  const events: LiveEventFrame[] = [];
  const statuses: LiveStatus[] = [];
  const timers: { fn: () => void; ms: number }[] = [];
  const unauthorized = vi.fn();
  const loads: string[] = [];
  const client = new LiveClient({
    openSocket: () => {
      const socket = new FakeSocket();
      sockets.push(socket);
      return socket;
    },
    loadSnapshot: (stream) => {
      loads.push(stream);
      return snapshot(stream);
    },
    onEvent: (event) => events.push(event),
    onStatus: (status) => statuses.push(status),
    onUnauthorized: unauthorized,
    schedule: (fn, ms) => timers.push({ fn, ms }),
    cancel: () => {},
    random: () => 0.5,
  });
  const ev = (stream: string, seq: number, extra: object = {}) => ({
    type: "event",
    stream,
    seq,
    kind: "message",
    replaceableKey: null,
    payload: seq,
    ...extra,
  });
  const flush = () => new Promise((resolve) => setTimeout(resolve, 0));
  return {
    client,
    sockets,
    events,
    statuses,
    timers,
    unauthorized,
    loads,
    ev,
    flush,
  };
}

describe("LiveClient", () => {
  it("loads the HTTP snapshot first and subscribes from its cursor, applying only the next seqs", async () => {
    const t = setup();
    t.client.follow(["chat:a"]);
    // The snapshot is requested before the socket is even open: reads never wait on it.
    expect(t.loads).toEqual(["chat:a"]);
    await t.flush();
    expect(t.client.status).toBe("syncing");
    t.sockets[0]!.open();
    expect(t.sockets[0]!.sent).toEqual([
      { type: "subscribe", stream: "chat:a", cursor: 10 },
    ]);
    expect(t.client.status).toBe("live");
    const s = t.sockets[0]!;
    s.say(t.ev("chat:a", 11));
    s.say(t.ev("chat:a", 11)); // duplicate
    s.say(t.ev("chat:a", 10)); // replayed
    s.say(t.ev("chat:a", 12));
    expect(t.events.map((event) => event.seq)).toEqual([11, 12]);
  });

  it("resubscribes from its cursor on a gap, but accepts the skip a coalescing server announces", async () => {
    const t = setup();
    t.client.follow(["chat:a"]);
    await t.flush();
    const s = t.sockets[0]!;
    s.open();
    s.sent.length = 0;
    s.say(t.ev("chat:a", 11));
    s.say(t.ev("chat:a", 14)); // lost frames: not announced
    expect(t.events.map((event) => event.seq)).toEqual([11]);
    expect(s.sent).toEqual([
      { type: "subscribe", stream: "chat:a", cursor: 11 },
    ]);
    s.say(t.ev("chat:a", 14, { coalesced: true })); // slow-reader skip
    expect(t.events.map((event) => event.seq)).toEqual([11, 14]);
    expect(t.client.cursor("chat:a")).toBe(14);
  });

  it("takes a fresh snapshot on snapshot_required and subscribes from the new cursor", async () => {
    let cursor = 10;
    const t = setup(async () => ({ liveCursor: cursor }));
    t.client.follow(["chat:a"]);
    await t.flush();
    const s = t.sockets[0]!;
    s.open();
    s.sent.length = 0;
    cursor = 500;
    s.say({
      type: "snapshot_required",
      stream: "chat:a",
      head: 500,
      reason: "slow_client",
    });
    expect(t.client.cursor("chat:a")).toBeNull();
    s.say(t.ev("chat:a", 11)); // from before the snapshot: not applied
    await t.flush();
    expect(t.loads).toEqual(["chat:a", "chat:a"]);
    expect(s.sent).toEqual([
      { type: "subscribe", stream: "chat:a", cursor: 500 },
    ]);
    expect(t.events).toHaveLength(0);
  });

  it("follows only what is on screen: others are unsubscribed and their events ignored", async () => {
    const t = setup();
    t.client.follow(["sidebar", "chat:a"]);
    await t.flush();
    const s = t.sockets[0]!;
    s.open();
    t.client.follow(["sidebar", "chat:b"]);
    expect(s.sent.at(-1)).toEqual({ type: "unsubscribe", stream: "chat:a" });
    s.say(t.ev("chat:a", 11));
    expect(t.events).toHaveLength(0);
    expect(t.loads).toEqual(["sidebar", "chat:a", "chat:b"]);
  });

  it("shows syncing, not offline, while the socket is down, and resumes from its cursors", async () => {
    const t = setup();
    t.client.follow(["chat:a"]);
    await t.flush();
    const s = t.sockets[0]!;
    s.open();
    s.say(t.ev("chat:a", 11));
    s.drop();
    expect(t.client.status).toBe("syncing");
    expect(t.timers).toHaveLength(1);
    t.timers[0]!.fn();
    const next = t.sockets[1]!;
    next.open();
    expect(next.sent).toEqual([
      { type: "subscribe", stream: "chat:a", cursor: 11 },
    ]);
    expect(t.client.status).toBe("live");
    // Backoff grows but is capped.
    for (let i = 0; i < 12; i++) {
      t.sockets.at(-1)!.drop();
      t.timers.at(-1)!.fn();
    }
    expect(Math.max(...t.timers.map((timer) => timer.ms))).toBeLessThanOrEqual(
      15_000,
    );
  });

  it("stops everything and reports it on 4003 or a refused snapshot (401, 403, 410)", async () => {
    const a = setup();
    a.client.follow(["chat:a"]);
    await a.flush();
    a.sockets[0]!.open();
    a.sockets[0]!.drop(4003);
    expect(a.unauthorized).toHaveBeenCalledTimes(1);
    expect(a.client.status).toBe("offline");
    expect(a.timers).toHaveLength(0);
    a.client.follow(["chat:b"]);
    expect(a.loads).toEqual(["chat:a"]);
    for (const status of [401, 403, 410]) {
      const b = setup(async () => {
        throw new SnapshotRefused(status);
      });
      b.client.follow(["sidebar"]);
      await b.flush();
      expect(b.unauthorized).toHaveBeenCalledTimes(1);
      expect(b.client.status).toBe("offline");
    }
  });

  it("retries a snapshot that failed for another reason, without giving up the page", async () => {
    let fail = true;
    const t = setup(async () => {
      if (fail) throw new Error("offline");
      return { liveCursor: 3 };
    });
    t.client.follow(["chat:a"]);
    await t.flush();
    expect(t.unauthorized).not.toHaveBeenCalled();
    fail = false;
    t.timers.at(-1)!.fn();
    await t.flush();
    t.sockets[0]!.open();
    expect(t.sockets[0]!.sent).toEqual([
      { type: "subscribe", stream: "chat:a", cursor: 3 },
    ]);
  });
});
