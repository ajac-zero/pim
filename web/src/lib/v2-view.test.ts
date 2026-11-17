import { describe, expect, it } from "vitest";
import { EMPTY_STREAM } from "~/lib/pim-view";
import {
  applyBusy,
  applyMessage,
  entryOf,
  sessionOf,
  streamOf,
  upsertSession,
  type V2Message,
} from "~/lib/v2-view";

const user = (id: number, text: string): V2Message => ({
  id: String(id),
  role: "user",
  parts: [{ type: "text", text }],
  timestamp: 1000 + id,
});
const assistant = (
  id: number,
  text: string,
  extra: V2Message["parts"] = [],
  partial = false,
): V2Message => ({
  id: String(id),
  role: "assistant",
  parts: [{ type: "text", text }, ...extra],
  timestamp: 1000 + id,
  stopReason: "stop",
  partial,
});
const result = (id: number, call: string): V2Message => ({
  id: String(id),
  role: "tool",
  parts: [
    {
      type: "tool-result",
      id: call,
      name: "send_to_user",
      content: [{ type: "text", text: "ok" }],
      error: false,
    },
  ],
  timestamp: 1000 + id,
});

const kinds = (stream: ReturnType<typeof streamOf>) =>
  stream.view.entries.map((entry) =>
    entry.kind === "item"
      ? `${entry.source}:${entry.item.type}`
      : entry.kind === "notice"
        ? `notice:${entry.notice.kind}`
        : entry.kind,
  );

describe("a v2 chat drawn by the same reducer as v1's", () => {
  it("puts each projected message back as the pi entry it came from", () => {
    expect(entryOf(user(3, "hi"))).toMatchObject({
      id: 3,
      kind: "pi.message",
      model: [{ role: "user" }],
    });
    const call = assistant(4, "x", [
      {
        type: "tool-call",
        id: "c1",
        name: "send_to_user",
        arguments: { a: 1 },
      },
    ]);
    expect(entryOf(call)!.model![0]).toMatchObject({
      role: "assistant",
      content: [
        { type: "text", text: "x" },
        {
          type: "toolCall",
          id: "c1",
          name: "send_to_user",
          arguments: { a: 1 },
        },
      ],
    });
    expect(entryOf(result(5, "c1"))!.model![0]).toMatchObject({
      role: "toolResult",
      toolCallId: "c1",
      toolName: "send_to_user",
      isError: false,
    });
    const notice: V2Message = {
      id: "6",
      role: "notice",
      parts: [{ type: "text", text: "They said hello." }],
      timestamp: 7,
      compaction: true,
    };
    expect(entryOf(notice)).toMatchObject({ kind: "pi.compaction" });
    expect(
      entryOf({ id: "7", role: "notice", parts: [], timestamp: 0 }),
    ).toMatchObject({ kind: "pi.reset" });
  });

  it("builds the view of a snapshot: messages, a compaction summary, and an answer still being written", () => {
    const stream = streamOf([
      user(1, "hello"),
      assistant(2, "Hi there", [
        { type: "tool-call", id: "c1", name: "send_to_user", arguments: {} },
      ]),
      result(3, "c1"),
      {
        id: "4",
        role: "notice",
        parts: [{ type: "text", text: "They said hello." }],
        timestamp: 9,
        compaction: true,
      },
      assistant(5, "Writing the answ", [], true),
    ]);
    expect(kinds(stream)).toEqual([
      "user:message",
      "agent:message",
      "agent:function_call",
      "agent:function_call_output",
      "notice:compaction",
    ]);
    expect(stream.view.running).toBe(true);
    expect(stream.view.live.length).toBeGreaterThan(0);
    // A partial whose final message is in the snapshot too is not "being written".
    const settled = streamOf([
      user(1, "q"),
      assistant(2, "partial", [], true),
      assistant(2, "partial and done"),
    ]);
    expect(settled.view.running).toBe(false);
    expect(settled.view.live).toEqual([]);
  });

  it("follows a turn: a partial grows in place, and the committed message replaces it", () => {
    let stream = streamOf([user(1, "hi")]);
    expect(stream.view.running).toBe(false);
    stream = applyMessage(stream, assistant(2, "He", [], true));
    expect(stream.view.running).toBe(true);
    const first = JSON.stringify(stream.view.live);
    stream = applyMessage(stream, assistant(2, "Hello, wor", [], true));
    expect(JSON.stringify(stream.view.live)).not.toBe(first);
    expect(stream.view.entries).toHaveLength(1);
    stream = applyMessage(stream, assistant(2, "Hello, world"));
    expect(stream.view.live).toEqual([]);
    expect(stream.view.entries).toHaveLength(2);
    // The same commit twice changes nothing.
    expect(
      applyMessage(stream, assistant(2, "Hello, world")).view.entries,
    ).toHaveLength(2);
    // A person's message while the answer is written does not end it.
    const mid = applyMessage(
      applyMessage(EMPTY_STREAM, assistant(9, "typing", [], true)),
      user(10, "and another"),
    );
    expect(mid.view.live.length).toBeGreaterThan(0);
    // The sidebar says the chat is at rest: that ends the run, and saying so again changes nothing.
    const rest = applyBusy(stream, false);
    expect(rest.view.running).toBe(false);
    expect(applyBusy(rest, false)).toBe(rest);
    expect(applyBusy(mid, false).view.running).toBe(false);
  });

  it("maps the sidebar's rows onto the app's sessions, most recently active first", () => {
    const a = sessionOf({
      chatId: "a",
      title: "A",
      busy: true,
      unread: false,
      updatedAt: 5,
      summary: { agent: { id: "m", name: "Majordomo" }, archived: false },
    });
    expect(a).toMatchObject({
      id: "a",
      title: "A",
      busy: true,
      unread: false,
      updatedAt: 5,
      createdAt: 5,
      responseAt: null,
      agent: { id: "m", name: "Majordomo" },
    });
    const b = sessionOf({
      chatId: "b",
      title: null,
      busy: false,
      unread: true,
      updatedAt: 9,
    });
    expect(upsertSession(undefined, a).map((s) => s.id)).toEqual(["a"]);
    expect(upsertSession([a], b).map((s) => s.id)).toEqual(["b", "a"]);
    expect(
      upsertSession([b, a], { ...a, updatedAt: 20, busy: false }).map((s) => [
        s.id,
        s.busy,
      ]),
    ).toEqual([
      ["a", false],
      ["b", false],
    ]);
  });

  it("keeps a chat's own model and agent when a live row, which carries neither, replaces its row", () => {
    const pinned = sessionOf({
      chatId: "a",
      title: "A",
      busy: false,
      unread: false,
      updatedAt: 5,
      summary: {
        agent: { id: "m", name: "Majordomo" },
        model: {
          model: { provider: "gateway", id: "u1", name: "u1", images: false },
          override: true,
        },
      },
    });
    const live = sessionOf({
      chatId: "a",
      title: "A",
      busy: true,
      unread: false,
      updatedAt: 9,
    });
    expect(upsertSession([pinned], live)[0]).toMatchObject({
      busy: true,
      agent: { id: "m" },
      model: { override: true, model: { id: "u1" } },
    });
  });
});
