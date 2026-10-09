import type { AgentEvent, EntryRecord } from "@earendil-works/pi-durable";
import { describe, expect, it } from "vitest";
import {
  approvalIdOf,
  EMPTY_STREAM,
  noticeOf,
  reduceAll,
  type StreamState,
  type ThreadEntry,
} from "~/lib/pim-view";

/* Event and entry builders. Casts keep fixtures to the fields the view reads. */

const user = (id: number, text: string): EntryRecord =>
  ({
    id,
    kind: "pi.message",
    model: [{ role: "user", content: [{ type: "text", text }], timestamp: 0 }],
  }) as unknown as EntryRecord;

const assistant = (id: number, content: unknown[]): EntryRecord =>
  ({
    id,
    kind: "pi.message",
    model: [{ role: "assistant", content }],
  }) as unknown as EntryRecord;

const toolResult = (
  id: number,
  toolCallId: string,
  text: string,
  isError = false,
): EntryRecord =>
  ({
    id,
    kind: "pi.message",
    model: [
      {
        role: "toolResult",
        toolCallId,
        toolName: "web_fetch",
        content: [{ type: "text", text }],
        isError,
      },
    ],
  }) as unknown as EntryRecord;

const snapshot = (fields: Record<string, unknown> = {}): AgentEvent =>
  ({
    type: "snapshot",
    entries: [],
    tools: [],
    compactions: [],
    inbox: [],
    agent: {},
    usage: {},
    ...fields,
  }) as unknown as AgentEvent;

const event = (fields: Record<string, unknown>) =>
  fields as unknown as AgentEvent;

/** Entries as compact strings, so expectations read like the thread. */
function describeEntries(entries: readonly ThreadEntry[]): string[] {
  return entries.map((entry) => {
    if (entry.kind === "notice") {
      return `${entry.key} notice:${entry.notice.kind} ${entry.notice.title}`;
    }
    const item = entry.item as unknown as Record<string, unknown>;
    switch (item.type) {
      case "message": {
        const [part] = item.content as Array<{ text: string }>;
        return `${entry.key} ${item.role}: ${part?.text}`;
      }
      case "reasoning": {
        const [part] = item.summary as Array<{ text: string }>;
        return `${entry.key} reasoning: ${part?.text}`;
      }
      case "function_call":
        return `${entry.key} call ${item.call_id} ${item.name}(${item.arguments})`;
      case "function_call_output":
        return `${entry.key} output ${item.call_id} [${item.status}]: ${item.output}`;
      default:
        return `${entry.key} ${String(item.type)}`;
    }
  });
}

const run = (events: AgentEvent[], from: StreamState = EMPTY_STREAM) =>
  reduceAll(from, events);

describe("snapshot", () => {
  it("projects the transcript, Pim's own inputs, and in-flight work", () => {
    const state = run([
      snapshot({
        entries: [
          { id: 0, kind: "pi.system" },
          user(1, "What's on the HN front page?"),
          assistant(2, [
            { type: "thinking", thinking: "I should fetch it." },
            { type: "text", text: "" },
            {
              type: "toolCall",
              id: "call-a",
              name: "web_fetch",
              arguments: { url: "https://news.ycombinator.com" },
            },
          ]),
          toolResult(3, "call-a", "<html>…</html>"),
          user(4, "[Scheduled task 9] Morning briefing\nSummarize my day."),
        ],
        run: { inputs: ["s1"] },
        generation: {
          attempt: 1,
          message: {
            role: "assistant",
            content: [{ type: "text", text: "Here's" }],
          },
        },
        tools: [
          { callId: "call-b", name: "memory_note", status: "running" },
          { callId: "call-c", name: "web_fetch", status: "done" },
        ],
        inbox: [
          { id: "s2", mode: "followUp" },
          { id: "s3", mode: "steer" },
        ],
      }),
    ]);

    expect(describeEntries(state.view.entries)).toEqual([
      "1 user: What's on the HN front page?",
      "2:0 reasoning: I should fetch it.",
      '2:2 call call-a web_fetch({"url":"https://news.ycombinator.com"})',
      "3 output call-a [completed]: <html>…</html>",
      "4 notice:schedule Morning briefing",
    ]);
    expect(describeEntries(state.view.live)).toEqual([
      "live:0 assistant: Here's",
    ]);
    expect(state.view.running).toBe(true);
    expect(state.view.tools).toEqual([
      { callId: "call-b", name: "memory_note", output: "" },
    ]);
    expect(state.view.queued).toBe(2);
  });

  it("replaces everything a previous snapshot showed", () => {
    const first = run([
      snapshot({ entries: [user(1, "old")], run: { inputs: ["s1"] } }),
    ]);
    const second = run([snapshot({ entries: [user(5, "new")] })], first);
    expect(describeEntries(second.view.entries)).toEqual(["5 user: new"]);
    expect(second.view.running).toBe(false);
  });
});

describe("streaming", () => {
  it("builds the live message from deltas, then files it under its entry", () => {
    const streaming = run([
      snapshot({ entries: [user(1, "hi")] }),
      event({ type: "run_start", inputs: ["s1"] }),
      event({
        type: "message_start",
        message: { role: "assistant", content: [] },
      }),
      event({
        type: "message_update",
        changes: [
          {
            type: "thinking_start",
            contentIndex: 0,
            block: { type: "thinking", thinking: "" },
          },
          { type: "thinking_delta", contentIndex: 0, delta: "Greet " },
          { type: "thinking_delta", contentIndex: 0, delta: "back." },
          {
            type: "text_start",
            contentIndex: 1,
            block: { type: "text", text: "" },
          },
          { type: "text_delta", contentIndex: 1, delta: "Hel" },
        ],
      }),
      event({
        type: "message_update",
        changes: [{ type: "text_delta", contentIndex: 1, delta: "lo!" }],
      }),
    ]);

    expect(describeEntries(streaming.view.live)).toEqual([
      "live:0 reasoning: Greet back.",
      "live:1 assistant: Hello!",
    ]);
    expect(streaming.view.running).toBe(true);

    const done = run(
      [
        event({
          type: "message_end",
          entry: assistant(2, [
            { type: "thinking", thinking: "Greet back." },
            { type: "text", text: "Hello!" },
          ]),
        }),
        event({ type: "run_end", inputs: ["s1"] }),
      ],
      streaming,
    );
    expect(describeEntries(done.view.entries)).toEqual([
      "1 user: hi",
      "2:0 reasoning: Greet back.",
      "2:1 assistant: Hello!",
    ]);
    expect(done.view.live).toEqual([]);
    expect(done.view.running).toBe(false);
  });

  it("files the user's message without touching the live assistant message", () => {
    const state = run([
      snapshot(),
      event({
        type: "message_start",
        message: { role: "assistant", content: [] },
      }),
      event({
        type: "message_update",
        changes: [
          {
            type: "text_start",
            contentIndex: 0,
            block: { type: "text", text: "Wor" },
          },
        ],
      }),
      event({ type: "message_end", entry: user(7, "and another thing") }),
    ]);
    expect(describeEntries(state.view.entries)).toEqual([
      "7 user: and another thing",
    ]);
    expect(describeEntries(state.view.live)).toEqual(["live:0 assistant: Wor"]);
  });
});

describe("tools", () => {
  it("follows streamed output: append, front trim, replace", () => {
    const update = (output: unknown) =>
      event({
        type: "tool_execution_update",
        toolCallId: "call-a",
        toolName: "bash",
        output,
      });
    const states: string[] = [];
    let state = run([
      snapshot(),
      event({
        type: "tool_execution_start",
        toolCallId: "call-a",
        toolName: "bash",
        args: {},
      }),
    ]);
    for (const output of [
      { append: "abc" },
      { trimStart: 1, append: "de" },
      { trimStart: 2 },
      { set: "fresh" },
    ]) {
      state = run([update(output)], state);
      states.push(state.view.tools[0]?.output ?? "");
    }
    expect(states).toEqual(["abc", "bcde", "de", "fresh"]);

    const ended = run(
      [
        event({
          type: "tool_execution_end",
          toolCallId: "call-a",
          toolName: "bash",
          entry: toolResult(3, "call-a", "exit 1", true),
        }),
      ],
      state,
    );
    expect(ended.view.tools).toEqual([]);
    expect(describeEntries(ended.view.entries)).toEqual([
      "3 output call-a [incomplete]: exit 1",
    ]);
  });
});

describe("entries", () => {
  it("shows an entry once, however many events carry it", () => {
    const entry = user(1, "hi");
    const state = run([
      snapshot({ entries: [entry] }),
      event({ type: "entry_appended", entry }),
      event({ type: "message_end", entry }),
    ]);
    expect(describeEntries(state.view.entries)).toEqual(["1 user: hi"]);
  });

  it("shows only the context after a reset", () => {
    const state = run([
      snapshot({
        entries: [
          user(1, "before"),
          assistant(2, [{ type: "text", text: "ok" }]),
        ],
      }),
      event({ type: "entry_appended", entry: { id: 3, kind: "pi.reset" } }),
      event({ type: "message_end", entry: user(4, "after") }),
    ]);
    expect(describeEntries(state.view.entries)).toEqual([
      "3 notice:reset New context",
      "4 user: after",
    ]);
  });
});

describe("errors", () => {
  it("reports unanswered submissions, except ones the user stopped", () => {
    const unanswered = (reason: string) =>
      run([
        snapshot(),
        event({
          type: "submission",
          record: { id: "s1", status: "unanswered", reason },
        }),
      ]).view.error;
    expect(unanswered("failed")).toBe("Not answered: failed");
    expect(unanswered("aborted")).toBeNull();
    expect(unanswered("withdrawn")).toBeNull();
  });

  it("clears the error when the next run starts", () => {
    const state = run([
      snapshot(),
      event({ type: "task_failed", taskId: "t", kind: "run", message: "boom" }),
    ]);
    expect(state.view.error).toBe("boom");
    expect(
      run([event({ type: "run_start", inputs: [] })], state).view.error,
    ).toBeNull();
  });
});

describe("noticeOf", () => {
  it("recognizes Pim's prefixes only at the start", () => {
    expect(
      noticeOf("[Approval a1] Approved: send the email\nResult: sent"),
    ).toEqual({
      kind: "approval",
      title: "Approved: send the email",
      text: "[Approval a1] Approved: send the email\nResult: sent",
      approval: "a1",
    });
    expect(noticeOf("[App event] github: issue opened")?.kind).toBe("event");
    expect(noticeOf("Please check [Approval a1] for me")).toBeNull();
    expect(noticeOf("[Approval]")).toBeNull();
  });

  it("clips long titles to 120 characters", () => {
    const title = noticeOf(`[App event] ${"x".repeat(200)}`)?.title ?? "";
    expect(title).toHaveLength(120);
    expect(title.endsWith("…")).toBe(true);
  });
});

describe("approvalIdOf", () => {
  it("reads the id from the result of a gated call", () => {
    expect(
      approvalIdOf(
        "Approval requested (id 3f1c9a2e-7b4d-4e1a-9c0f-2d8e6b5a1c47): POST https://hooks.example.com/x (deploy)\nThe user has been asked.",
      ),
    ).toBe("3f1c9a2e-7b4d-4e1a-9c0f-2d8e6b5a1c47");
  });

  it("ignores other tool results that mention approvals", () => {
    expect(
      approvalIdOf("Page text: Approval requested (id x1): ..."),
    ).toBeNull();
    expect(approvalIdOf("[Approval a1] The user approved: x")).toBeNull();
  });
});
