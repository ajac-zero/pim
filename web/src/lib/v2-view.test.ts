import { codingWakeText } from "@pim/shared/coding-wake";
import { DELIVERY_REMINDER, NOT_DELIVERED } from "@pim/shared/transcript";
import { describe, expect, it } from "vitest";
import { codingNoticeOf, EMPTY_STREAM, layoutThread } from "~/lib/pim-view";
import {
  applyBusy,
  applyMessage,
  applyQueue,
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
    expect(entryOf(call)?.model?.[0]).toMatchObject({
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
    expect(entryOf(result(5, "c1"))?.model?.[0]).toMatchObject({
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

  it("leaves the harness's delivery reminders out of the chat and shows an undelivered reply as the error", () => {
    const failed: V2Message = {
      ...assistant(4, ""),
      parts: [],
      stopReason: "error",
      error: NOT_DELIVERED,
    };
    const stream = streamOf([
      user(1, "find my homework"),
      assistant(2, "Found it."),
      user(3, DELIVERY_REMINDER),
      failed,
    ]);
    expect(JSON.stringify(stream.view.entries)).not.toContain(
      "Delivery required",
    );
    expect(JSON.stringify(stream.view.entries)).toContain("find my homework");
    expect(JSON.stringify(stream)).toContain(NOT_DELIVERED);
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

  it("keeps a photo sent with a message as an image of the user's item, for the chat to show", () => {
    const stream = streamOf([
      {
        id: "1",
        role: "user",
        parts: [
          { type: "text", text: "How about now?" },
          { type: "image", data: "AAEC", mimeType: "image/jpeg" },
        ],
        timestamp: 1001,
      },
    ]);
    const entry = stream.view.entries[0];
    expect(entry?.kind === "item" ? entry.item : null).toMatchObject({
      role: "user",
      content: [
        { type: "input_text", text: "How about now?" },
        { type: "input_image", image_url: "data:image/jpeg;base64,AAEC" },
      ],
    });
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

  it("keeps working through a progress note and a long tool call, until the sidebar says the turn is over", () => {
    const call = (
      id: number,
      name: string,
      callId: string,
      args: Record<string, string | boolean>,
    ) =>
      assistant(id, "", [
        { type: "tool-call", id: callId, name, arguments: args },
      ]);
    let stream = applyBusy(streamOf([user(1, "export a PDF")]), true);
    for (const m of [
      assistant(2, "I'll make a clean PDF", [], true),
      call(2, "send_to_user", "c1", {
        message: "I'll make a PDF",
        complete: false,
      }),
      result(3, "c1"),
      call(4, "shell", "c2", { command: "pandoc" }),
    ]) {
      stream = applyMessage(stream, m);
      expect(stream.view.running).toBe(true);
    }
    // The sidebar's word ends it.
    expect(applyBusy(stream, false).view.running).toBe(false);
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

  it("reads how many tokens a chat's context holds from its summary", () => {
    const row = {
      chatId: "a",
      title: "A",
      busy: false,
      unread: false,
      updatedAt: 5,
    };
    expect(
      sessionOf({ ...row, summary: { contextTokens: 61_000 } }),
    ).toMatchObject({
      contextTokens: 61_000,
    });
    expect(sessionOf(row)).not.toHaveProperty("contextTokens");
  });

  it("reads who started a chat made for a task from its summary", () => {
    const startedBy = {
      session: "a",
      agent: { id: "m", name: "Majordomo" },
      task: "t1",
      state: "working",
    };
    const row = {
      chatId: "b",
      title: "B",
      busy: false,
      unread: false,
      updatedAt: 5,
    };
    expect(sessionOf({ ...row, summary: { startedBy } }).startedBy).toEqual(
      startedBy,
    );
    expect(
      sessionOf({ ...row, summary: { startedBy: null } }),
    ).not.toHaveProperty("startedBy");
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

describe("the messages queued behind a running turn", () => {
  const queued = [
    { id: 7, mode: "followUp" as const, content: "and then this" },
    {
      id: 8,
      mode: "steer" as const,
      content: [
        { type: "text", text: "now" },
        { type: "image", data: "x", mimeType: "image/png" },
      ],
    },
    // What Pim queued for itself, and what is not the person's, is not theirs to change.
    { id: 9, mode: "followUp" as const, content: "[Task update] done" },
  ];

  it("shows the person's own, from a snapshot and as the live queue changes", () => {
    const state = streamOf([user(1, "go"), assistant(2, "", [], true)], queued);
    expect(state.view.queue).toEqual([
      { id: 7, text: "and then this", images: 0, steer: false },
      { id: 8, text: "now", images: 1, steer: true },
    ]);
    // A message that joined the run, or was taken back, leaves the queue; the transcript is not touched by it.
    const later = applyQueue(state, queued.slice(0, 1));
    expect(later.view.queue.map((item) => item.id)).toEqual([7]);
    expect(later.view.entries).toEqual(state.view.entries);
    // A committed message keeps the queue as it is.
    expect(
      applyMessage(later, user(3, "and then this")).view.queue.map(
        (item) => item.id,
      ),
    ).toEqual([7]);
  });
});

describe("a model request that failed", () => {
  const failedAnswer = (id: number): V2Message => ({
    id: String(id),
    role: "assistant",
    parts: [],
    timestamp: 1000 + id,
    stopReason: "error",
    error: "The model timed out: it sent nothing for 120 seconds",
    partial: false,
  });

  it("shows why in the view, from a snapshot and from the live stream, until the next run starts", () => {
    const snapshot = streamOf([user(1, "hi"), failedAnswer(2)]);
    expect(snapshot.view.error).toMatchObject({ problem: "busy" });
    const live = applyMessage(streamOf([user(1, "hi")]), failedAnswer(2));
    expect(live.view.error).not.toBeNull();
    expect(applyBusy(live, true).view.error).toBeNull();
    // An answer that went well after the failure leaves nothing to show.
    expect(
      streamOf([user(1, "hi"), failedAnswer(2), assistant(3, "ok")]).view.error,
    ).toBeNull();
  });
});

describe("a coding thread's wake in a v2 chat", () => {
  const facts = {
    threadId: "d3e06eed",
    state: "idle",
    spentUsd: 1.5,
    budgetUsd: 5,
    origin: "https://pim.example/",
  } as const;

  it("is read by codingNoticeOf with the state and link, for a completed and a failed thread", () => {
    const done = codingWakeText({
      ...facts,
      outcome: "completed",
      said: "Opened PR",
    });
    expect(codingNoticeOf(done)).toEqual({
      threadId: "d3e06eed",
      outcome: "finished its turn",
      state: "idle",
      link: "https://pim.example/coding/d3e06eed",
      said: "Opened PR",
    });
    const failed = codingWakeText({
      ...facts,
      outcome: "failed",
      state: "failed",
      origin: null,
      detail: "boom",
    });
    expect(codingNoticeOf(failed)).toMatchObject({
      outcome: "stopped with an error",
      state: "failed",
      link: "/coding/d3e06eed",
    });
    expect(failed).toContain("Detail: boom");
    expect(codingWakeText({ ...facts, outcome: "cancelled" })).toContain(
      "It was cancelled.",
    );
  });

  it("is drawn as a coding notice card, not as the person's message", () => {
    const text = codingWakeText({ ...facts, outcome: "completed" });
    const stream = streamOf([user(1, text)]);
    expect(stream.view.entries).toHaveLength(1);
    expect(stream.view.entries[0]).toMatchObject({
      kind: "notice",
      notice: { kind: "coding", coding: { state: "idle" } },
    });
  });
});

describe("the provenance a message carries", () => {
  const neon = { provider: "ai-gateway", model: "gemini-4-neon" };
  const sol = { provider: "openai", model: "gpt-6-sol" };
  const kept = { emitter: neon, contributors: [sol, neon], complete: true };
  const send = (id: number, provenance?: typeof kept, partial = false) =>
    assistant(
      id,
      "",
      [
        {
          type: "tool-call",
          id: `c${id}`,
          name: "send_to_user",
          arguments: { message: "Hello" },
          ...(provenance ? { provenance } : {}),
        },
      ],
      partial,
    );
  const provenances = (entries: Parameters<typeof layoutThread>[0]) =>
    layoutThread(entries, { shown: () => false }).flatMap((row) =>
      row.kind === "sent" ? [row.provenance] : [],
    );

  it("reaches a message loaded from history and one still streaming, and is unknown for one that kept none", () => {
    const history = streamOf([user(1, "Hi"), send(2, kept), send(3)]);
    expect(provenances(history.view.entries)).toEqual([
      kept,
      { emitter: null, contributors: [], complete: false },
    ]);
    const live = applyMessage(streamOf([user(1, "Hi")]), send(-1, kept, true));
    expect(provenances(live.view.live)).toEqual([kept]);
  });

  it("reaches a post another agent made in a group chat, carried beside its text", () => {
    const post: V2Message = {
      ...user(5, "[From Ada]\nOver to you"),
      provenance: kept,
    };
    const [entry] = streamOf([post]).view.entries;
    expect(entry).toMatchObject({
      kind: "post",
      from: "Ada",
      provenance: kept,
    });
  });
});

describe("a model that was asked again or replaced", () => {
  const retry = { kind: "retry", model: "gemini-4-neon" } as const;

  it("is told before the answer it came with, after a reload as when it was live", () => {
    const answered: V2Message = {
      ...assistant(2, "from sol"),
      notices: [retry],
    };
    const loaded = streamOf([user(1, "hi"), answered]);
    expect(kinds(loaded)).toEqual([
      "user:message",
      "notice:model",
      "agent:message",
    ]);
    const live = applyMessage(streamOf([user(1, "hi")]), answered);
    expect(kinds(live)).toEqual(kinds(loaded));
    expect(live.view.entries[1]).toMatchObject({
      kind: "notice",
      notice: { kind: "model", model: retry },
    });
  });

  it("is still told by a request that answered with nothing, and is no message of the agent's", () => {
    const alone: V2Message = {
      id: "3",
      role: "notice",
      parts: [],
      timestamp: 1_003,
      notices: [retry],
    };
    expect(entryOf(alone)).toMatchObject({
      id: 3,
      kind: "pi.message",
      model: [{ role: "assistant", content: [], modelNotices: [retry] }],
    });
    const state = streamOf([user(1, "hi"), alone]);
    expect(kinds(state)).toEqual(["user:message", "notice:model"]);
    expect(applyMessage(streamOf([user(1, "hi")]), alone).view.entries).toEqual(
      state.view.entries,
    );
  });
});
