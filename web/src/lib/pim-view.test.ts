import type { AgentEvent, EntryRecord } from "@earendil-works/pi-durable";
import { describe, expect, it } from "vitest";
import type { FunctionCallItem } from "~/lib/openresponses";
import {
  EMPTY_STREAM,
  layoutThread,
  noticeOf,
  reduceAll,
  type StreamState,
  type ThreadEntry,
} from "~/lib/pim-view";
import { DELIVERY_REMINDER } from "../../../src/transcript";

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
  it("hides private delivery corrections without hiding the person's message", () => {
    const state = run([
      snapshot({
        entries: [user(1, "Please answer."), user(2, DELIVERY_REMINDER)],
      }),
    ]);
    expect(describeEntries(state.view.entries)).toEqual([
      "1 user: Please answer.",
    ]);
  });

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

  it("keeps the images the person sent, after their text, by URL once kept", () => {
    const state = run([
      snapshot({
        entries: [
          {
            id: 1,
            kind: "pi.message",
            model: [
              {
                role: "user",
                content: [
                  {
                    type: "image",
                    data: "",
                    mimeType: "image/png",
                    url: "/api/images/a1",
                  },
                  { type: "text", text: "What is this?" },
                  {
                    type: "image",
                    data: "iVBORw0KGgo=",
                    mimeType: "image/png",
                  },
                ],
                timestamp: 0,
              },
            ],
          } as unknown as EntryRecord,
        ],
      }),
    ]);
    const [entry] = state.view.entries;
    expect(entry).toMatchObject({
      kind: "item",
      source: "user",
      item: {
        role: "user",
        content: [
          { type: "input_text", text: "What is this?" },
          { type: "input_image", image_url: "/api/images/a1" },
          {
            type: "input_image",
            image_url: "data:image/png;base64,iVBORw0KGgo=",
          },
        ],
      },
    });
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

describe("streaming a message Pim sends", () => {
  it("grows send_to_user's message as its arguments stream", () => {
    const state = run([
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
            type: "toolcall_start",
            contentIndex: 0,
            block: {
              type: "toolCall",
              id: "c1",
              name: "send_to_user",
              arguments: { notify: true, message: "Hel" },
            },
          },
          {
            type: "toolcall_delta",
            contentIndex: 0,
            path: ["message"],
            delta: "lo ",
          },
        ],
      }),
      event({
        type: "message_update",
        changes: [
          {
            type: "toolcall_delta",
            contentIndex: 0,
            path: ["message"],
            delta: "there",
          },
        ],
      }),
    ]);
    expect(describeEntries(state.view.live)).toEqual([
      'live:0 call c1 send_to_user({"notify":true,"message":"Hello there"})',
    ]);
  });
});

/** Rows as compact strings: the entries each holds, by key. */
function describeRows(rows: ReturnType<typeof layoutThread>): string[] {
  return rows.map((row) =>
    row.kind === "sent"
      ? `sent ${row.key}: ${row.sent.message}`
      : `${row.kind} ${row.key}`,
  );
}

const layout = (
  entries: EntryRecord[],
  shown: (call: FunctionCallItem) => boolean = () => false,
) =>
  describeRows(
    layoutThread(run([snapshot({ entries })]).view.entries, { shown }),
  );

describe("layoutThread", () => {
  const search = {
    type: "toolCall",
    id: "s",
    name: "web_search",
    arguments: { query: "Private search terms" },
  };
  const send = (id: string, message: string) => ({
    type: "toolCall",
    id,
    name: "send_to_user",
    arguments: { message },
  });

  it("shows explicit sends, but never private text, tool calls, or results", () => {
    expect(
      layout([
        user(1, "Weather?"),
        assistant(2, [{ type: "text", text: "Let me look." }, search]),
        toolResult(3, "s", "sunny"),
        assistant(4, [send("m", "It's sunny.")]),
        toolResult(5, "m", "Sent."),
        assistant(6, [{ type: "text", text: "Told them." }]),
      ]),
    ).toEqual(["entry 1", "sent 4:0: It's sunny."]);
  });

  it("never uses private text or tool activity as a fallback when no message was sent", () => {
    const entries = [
      user(1, "Weather?"),
      assistant(2, [
        { type: "thinking", thinking: "Private thought." },
        { type: "text", text: "Looking." },
        search,
      ]),
      toolResult(3, "s", "sunny"),
      assistant(4, [{ type: "text", text: "Sunny." }]),
    ];
    expect(layout(entries)).toEqual(["entry 1"]);
    const rows = layoutThread(run([snapshot({ entries })]).view.entries, {
      shown: () => false,
    });
    expect(JSON.stringify(rows)).not.toContain("Private thought");
    expect(JSON.stringify(rows)).not.toContain("Sunny.");
    expect(JSON.stringify(rows)).not.toContain("Looking.");
    expect(JSON.stringify(rows)).not.toContain("Private search terms");
    expect(JSON.stringify(rows)).not.toContain("sunny");
  });

  it("filters tool activity, private text, and reasoning from a live generation too", () => {
    const state = run([
      snapshot({
        entries: [user(1, "hi")],
        run: { inputs: ["s1"] },
        generation: {
          attempt: 1,
          message: {
            role: "assistant",
            content: [
              { type: "thinking", thinking: "Do not expose this." },
              { type: "text", text: "Nor this." },
              search,
            ],
          },
        },
      }),
    ]);
    expect(
      describeRows(layoutThread(state.view.live, { shown: () => false })),
    ).toEqual([]);
  });

  it("keeps a progress send followed by tool work, but hides the private final answer", () => {
    expect(
      layout([
        user(1, "Find the answer."),
        assistant(2, [send("m", "I’ll look into it.")]),
        toolResult(3, "m", "Sent."),
        assistant(4, [search]),
        toolResult(5, "s", "Found it."),
        assistant(6, [
          { type: "thinking", thinking: "Compose the final." },
          { type: "text", text: "The answer is 42." },
        ]),
      ]),
    ).toEqual(["entry 1", "sent 2:0: I’ll look into it."]);
  });

  it("lets work Pim gave itself stay silent", () => {
    expect(
      layout([
        user(1, "Watch the price."),
        assistant(2, [send("m", "Will do.")]),
        toolResult(3, "m", "Sent."),
        user(4, "[Scheduled task] Check the price."),
        assistant(5, [{ type: "text", text: "Unchanged; nothing to say." }]),
      ]),
    ).toEqual(["entry 1", "sent 2:0: Will do.", "entry 4"]);
  });

  it("hides a message the tool refused: it never reached the person", () => {
    const entries = run([
      snapshot({
        entries: [
          user(1, "My bills?"),
          assistant(2, [send("a", "Bills:")]),
          toolResult(
            3,
            "a",
            "Not sent: ledger/bills isn't a widget you can show.",
            true,
          ),
          assistant(4, [send("b", "No ledger here.")]),
          toolResult(5, "b", "Sent."),
        ],
      }),
    ]).view.entries;
    // As the chat decides it: a call whose result is an error was refused.
    const failed = new Set(
      entries.flatMap((entry) =>
        entry.kind === "item" &&
        entry.item.type === "function_call_output" &&
        entry.item.status === "incomplete"
          ? [entry.item.call_id]
          : [],
      ),
    );
    expect(
      describeRows(
        layoutThread(entries, {
          shown: () => false,
          refused: (call) => failed.has(call.call_id),
        }),
      ),
    ).toEqual(["entry 1", "sent 4:0: No ledger here."]);
  });

  it("keeps user-facing approval and artifact surfaces without exposing surrounding tool work", () => {
    const gated = {
      type: "toolCall",
      id: "h",
      name: "http_request",
      arguments: {},
    };
    const artifact = {
      type: "toolCall",
      id: "a",
      name: "artifact_create",
      arguments: { title: "Dinner plan" },
    };
    expect(
      layout(
        [
          user(1, "Plan dinner and order a pizza."),
          assistant(2, [search, gated, search, artifact]),
        ],
        (call) => ["http_request", "artifact_create"].includes(call.name),
      ),
    ).toEqual(["entry 1", "entry 2:1", "entry 2:3"]);
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
  const unanswered = (reason: string, detail?: string) =>
    run([
      snapshot(),
      event({
        type: "submission",
        record: { id: "s1", status: "unanswered", reason, detail },
      }),
    ]);

  it("reports unanswered submissions, except ones the user stopped", () => {
    expect(unanswered("no_model").view.error).toEqual({ reason: "no_model" });
    expect(unanswered("aborted").view.error).toBeNull();
    expect(unanswered("withdrawn").view.error).toBeNull();
  });

  it("names the ChatGPT usage limit, though it arrives as a 429", () => {
    const detail = `OpenAI API error (429): {"error":{"code":"subscription_sharing_usage_limit_exceeded","message":"The ChatGPT user has reached their Subscription Sharing usage limit."}}
Check your ChatGPT usage: https://chatgpt.com/settings/usage`;
    expect(unanswered("model_error", detail).view.error).toEqual({
      problem: "usage_limit",
    });
    expect(
      unanswered(
        "model_error",
        "Pim usage quota exceeded: today's 300 model requests are used up. It resets at midnight UTC.",
      ).view.error,
    ).toEqual({ problem: "quota" });
    expect(
      unanswered(
        "model_error",
        "OpenAI API error (503): upstream connect error",
      ).view.error,
    ).toEqual({ problem: "busy" });
  });

  it("keeps no provider text, which can echo the request", () => {
    const leaky = `OpenAI API error (400): Invalid input near "alice@example.com"; Authorization: Bearer sk-secret-token; see https://api.openai.com/v1/responses?key=abc`;
    const failed = unanswered("model_error", leaky);
    const faulted = run([
      snapshot(),
      event({
        type: "task_failed",
        taskId: "t",
        kind: "pi.generation",
        message: leaky,
      }),
    ]);
    expect(failed.view.error).toEqual({ problem: "other" });
    expect(faulted.view.error).toEqual({ problem: "other" });
    const states = [
      failed,
      faulted,
      run([
        snapshot({
          generation: { attempt: 1, retry: { at: 5, error: leaky } },
        }),
      ]),
      run([
        snapshot(),
        event({ type: "auto_retry_start", at: 5, errorMessage: leaky }),
      ]),
    ];
    for (const state of states) {
      const shown = JSON.stringify(state.view);
      for (const secret of [
        "alice@example.com",
        "sk-secret-token",
        "https://",
      ]) {
        expect(shown).not.toContain(secret);
      }
    }
  });

  it("reads a fault as a model problem only for model tasks", () => {
    const fault = (kind: string, message: string) =>
      event({ type: "task_failed", taskId: "t", kind, message });
    const unauthorized =
      "Request failed (401): Bearer sk-secret-token for alice@example.com at https://tools.example.com/x";
    for (const kind of ["pi.tool", "pim.schedule"]) {
      const state = run([snapshot(), fault(kind, unauthorized)]);
      expect(state.view.error).toEqual({ taskFailed: true });
      expect(JSON.stringify(state.view)).not.toContain("sk-secret-token");
    }
    expect(
      run([snapshot(), fault("pi.generation", unauthorized)]).view.error,
    ).toEqual({ problem: "sign_in" });
    expect(
      run([
        snapshot(),
        fault("pi.compaction", "subscription_sharing_usage_limit_exceeded"),
      ]).view.error,
    ).toEqual({ problem: "usage_limit" });
  });

  it("keeps a fault's problem over the input's later reason, but not over its model error", () => {
    const settle = (reason: string, detail?: string) =>
      event({
        type: "submission",
        record: { id: "s1", status: "unanswered", reason, detail },
      });
    const fault = (kind: string, message: string) =>
      event({ type: "task_failed", taskId: "t", kind, message });
    expect(
      run([
        snapshot(),
        fault("pi.generation", "OpenAI API error (401): unauthorized"),
        settle("faulted"),
      ]).view.error,
    ).toEqual({ problem: "sign_in" });
    expect(
      run([
        snapshot(),
        fault("pi.tool", "boom"),
        settle("model_error", "subscription_sharing_usage_limit_exceeded"),
      ]).view.error,
    ).toEqual({ problem: "usage_limit" });
  });

  it("clears the error when the next run starts", () => {
    const state = run([
      snapshot(),
      event({ type: "task_failed", taskId: "t", kind: "run", message: "boom" }),
    ]);
    expect(state.view.error).toEqual({ taskFailed: true });
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
