import type { AgentEvent, EntryRecord } from "@earendil-works/pi-durable";
import { describe, expect, it } from "vitest";
import {
  type CodingStreamMessage,
  type CodingThreadState,
  type CodingThreadSummary,
  codingByChat,
  codingStateBadge,
  EMPTY_LIVE,
  type LiveTranscript,
  ndjson,
  parseDiff,
  reduceLive,
  startInput,
  startProblems,
  stateReasonKey,
  transcriptRows,
  writingMessage,
} from "~/lib/coding";

const user = (id: string, text: string) =>
  ({
    id,
    conversationId: "c",
    kind: "pi.message",
    model: [{ role: "user", content: text, timestamp: 1 }],
  }) as unknown as EntryRecord;

const assistant = (id: string, content: unknown[]) =>
  ({
    id,
    conversationId: "c",
    kind: "pi.message",
    model: [
      {
        role: "assistant",
        content,
        api: "faux",
        provider: "faux",
        model: "faux",
        stopReason: "stop",
        timestamp: 2,
        usage: {},
      },
    ],
  }) as unknown as EntryRecord;

const toolResult = (
  id: string,
  callId: string,
  text: string,
  isError = false,
) =>
  ({
    id,
    conversationId: "c",
    kind: "pi.message",
    model: [
      {
        role: "toolResult",
        toolCallId: callId,
        toolName: "test",
        content: [{ type: "text", text }],
        isError,
        timestamp: 3,
      },
    ],
  }) as unknown as EntryRecord;

const snapshot = (entries: EntryRecord[], extra = {}): CodingStreamMessage =>
  ({
    type: "snapshot",
    entries,
    tools: [],
    compactions: [],
    inbox: [],
    agent: {},
    usage: {},
    ...extra,
  }) as unknown as CodingStreamMessage;

const events = (...list: unknown[]): CodingStreamMessage => ({
  type: "events",
  events: list as AgentEvent[],
});

const fold = (messages: CodingStreamMessage[]): LiveTranscript =>
  messages.reduce(reduceLive, EMPTY_LIVE);

describe("the live transcript", () => {
  const task = user("1", "Fix the flaky date test");
  const call = assistant("2", [
    { type: "text", text: "Running the tests first." },
    {
      type: "toolCall",
      id: "call-1",
      name: "test",
      arguments: { command: "pnpm test" },
    },
  ]);
  const result = toolResult("3", "call-1", "1 failed, 12 passed", true);

  it("keeps one row per entry however often the stream repeats it, reconnects included", () => {
    const live = fold([
      snapshot([task, call]),
      events({ type: "message_end", entry: call }),
      events({
        type: "tool_execution_end",
        toolCallId: "call-1",
        toolName: "test",
        entry: result,
      }),
      // A reconnect's snapshot names every entry again.
      snapshot([task, call, result]),
      events({ type: "entry_appended", entry: result }),
    ]);
    expect(live.messages.map((message) => message.id)).toEqual(["1", "2", "3"]);
    const rows = transcriptRows(live.messages);
    expect(rows.map((row) => row.kind)).toEqual(["task", "text", "tool"]);
    // The result rides on its call rather than being a row of its own.
    expect(rows[2]).toMatchObject({
      kind: "tool",
      name: "test",
      result: { error: true },
    });
  });

  it("calls the person's later messages steers", () => {
    const rows = transcriptRows(
      fold([snapshot([task, call, user("4", "Only touch src/date.ts")])])
        .messages,
    );
    expect(rows.filter((row) => row.kind === "task")).toHaveLength(1);
    expect(rows.at(-1)).toMatchObject({
      kind: "steer",
      text: "Only touch src/date.ts",
    });
  });

  it("shows a budget stop as a notice", () => {
    const stop = {
      id: "5",
      conversationId: "c",
      kind: "app.budget_stop",
      data: { budgetUsd: 3, spentUsd: 3.0123 },
    } as unknown as EntryRecord;
    const rows = transcriptRows(fold([snapshot([task, stop])]).messages);
    expect(rows[1]).toEqual({
      key: "5",
      kind: "notice",
      text: "Stopped: the thread spent $3.01 of its $3 budget.",
    });
    // A CLI harness that estimates no cost is stopped at its token ceiling, and says so in tokens, not dollars.
    const ceiling = {
      ...stop,
      data: {
        budgetUsd: 3,
        spentUsd: 0,
        tokens: 3_012_345,
        tokenCeiling: 3_000_000,
      },
    } as unknown as EntryRecord;
    expect(
      transcriptRows(fold([snapshot([task, ceiling])]).messages)[1],
    ).toMatchObject({
      text: "Stopped: the thread used 3,012,345 of the 3,000,000 tokens its $3 budget allows.",
    });
  });

  it("follows a message being written and drops it once written", () => {
    const started = fold([
      snapshot([task]),
      events(
        { type: "run_start", inputs: [] },
        {
          type: "message_start",
          message: { role: "assistant", content: [], timestamp: 2 },
        },
        {
          type: "message_update",
          changes: [
            {
              type: "text_start",
              contentIndex: 0,
              block: { type: "text", text: "" },
            },
            { type: "text_delta", contentIndex: 0, delta: "Look" },
            { type: "text_delta", contentIndex: 0, delta: "ing" },
          ],
        },
      ),
    ]);
    expect(started.running).toBe(true);
    const writing = writingMessage(started.writing);
    expect(transcriptRows(started.messages, writing).at(-1)).toMatchObject({
      kind: "text",
      text: "Looking",
      writing: true,
    });
    const done = reduceLive(
      started,
      events({
        type: "message_end",
        entry: assistant("2", [{ type: "text", text: "Looking" }]),
      }),
    );
    expect(done.writing).toBeNull();
    expect(transcriptRows(done.messages).at(-1)).toMatchObject({
      writing: false,
    });
  });

  it("collects what a command prints until it ends", () => {
    const running = fold([
      events({
        type: "tool_execution_start",
        toolCallId: "call-1",
        toolName: "bash",
        args: {},
      }),
      { type: "output", tool: "bash", callId: "call-1", data: "line 1\n" },
      { type: "output", tool: "bash", callId: "call-1", data: "line 2\n" },
    ]);
    expect(running.tools).toEqual([
      { callId: "call-1", name: "bash", output: "line 1\nline 2\n" },
    ]);
    const ended = reduceLive(
      running,
      events({
        type: "tool_execution_end",
        toolCallId: "call-1",
        toolName: "bash",
      }),
    );
    expect(ended.tools).toEqual([]);
  });

  it("builds a CLI harness's message from its pieces until the whole message is appended", () => {
    const writing = fold([
      { type: "partial", kind: "thinking", text: "The test " },
      { type: "partial", kind: "thinking", text: "uses local time." },
      { type: "partial", kind: "text", text: "Pinning " },
      { type: "partial", kind: "text", text: "the zone." },
    ]);
    expect(writing.writing?.content).toEqual([
      { type: "thinking", thinking: "The test uses local time." },
      { type: "text", text: "Pinning the zone." },
    ]);
    const appended = reduceLive(
      writing,
      events({
        type: "entry_appended",
        entry: assistant("2", [{ type: "text", text: "Pinning the zone." }]),
      }),
    );
    expect(appended.writing).toBeNull();
    expect(transcriptRows(appended.messages).at(-1)).toMatchObject({
      kind: "text",
      text: "Pinning the zone.",
      writing: false,
    });
  });
});

describe("the stream's lines", () => {
  it("reads objects split across chunks, skips a bad line, and keeps a last line without a newline", async () => {
    const encoder = new TextEncoder();
    const chunks = [
      '{"type":"a"}\n{"ty',
      'pe":"b"}\nnot json\n\n',
      '{"type":"c"}',
    ];
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        for (const chunk of chunks) controller.enqueue(encoder.encode(chunk));
        controller.close();
      },
    });
    const seen: unknown[] = [];
    for await (const value of ndjson(body)) seen.push(value);
    expect(seen).toEqual([{ type: "a" }, { type: "b" }, { type: "c" }]);
  });
});

describe("the diff", () => {
  it("splits it by file and counts lines added and removed, not the file headers", () => {
    const diff = [
      "diff --git a/src/date.ts b/src/date.ts",
      "index 1..2 100644",
      "--- a/src/date.ts",
      "+++ b/src/date.ts",
      "@@ -1,3 +1,3 @@",
      " keep",
      "-old",
      "+new",
      "+newer",
      "diff --git a/old.txt b/old.txt",
      "deleted file mode 100644",
      "--- a/old.txt",
      "+++ /dev/null",
      "@@ -1 +0,0 @@",
      "-gone",
      "",
    ].join("\n");
    const files = parseDiff(diff);
    expect(
      files.map(({ path, added, removed }) => ({ path, added, removed })),
    ).toEqual([
      { path: "src/date.ts", added: 2, removed: 1 },
      { path: "old.txt", added: 0, removed: 1 },
    ]);
    expect(files[1]?.lines.at(-1)).toBe("-gone");
  });

  it("has no files for an empty diff", () => {
    expect(parseDiff("")).toEqual([]);
  });
});

describe("the start form", () => {
  const form = {
    repo: "https://github.com/acme/widgets",
    ref: "",
    task: "Fix the flaky date test",
    budget: "",
  };

  it("asks for a GitHub repository and a task", () => {
    expect(startProblems({ ...form, repo: "", task: " " })).toEqual({
      repo: "codingRepoMissing",
      task: "codingTaskMissing",
    });
    for (const repo of [
      "acme/widgets",
      "https://gitlab.com/acme/widgets",
      "http://github.com/acme/widgets",
      "https://github.com/acme",
      "https://github.com/acme/widgets/tree/main",
    ]) {
      expect(startProblems({ ...form, repo }).repo).toBe("codingRepoInvalid");
    }
    expect(
      startProblems({ ...form, repo: "https://github.com/acme/widgets/" }),
    ).toEqual({});
    expect(startProblems({ ...form, task: "x".repeat(2001) }).task).toBe(
      "codingTaskTooLong",
    );
  });

  it("takes a budget only above zero", () => {
    for (const budget of ["0", "-1", "abc"]) {
      expect(startProblems({ ...form, budget }).budget).toBe(
        "codingBudgetInvalid",
      );
    }
    expect(startProblems({ ...form, budget: "0.5" })).toEqual({});
  });

  it("sends only what was given, trimmed", () => {
    expect(
      startInput(
        {
          repo: " https://github.com/acme/widgets/ ",
          ref: " ",
          task: " Fix it ",
          budget: "5",
        },
        "op-1",
      ),
    ).toEqual({
      repo: "https://github.com/acme/widgets",
      task: "Fix it",
      budgetUsd: 5,
      operationId: "op-1",
    });
    const base = {
      repo: "https://github.com/acme/widgets",
      ref: "",
      task: "Fix it",
      budget: "",
    };
    expect(startInput({ ...base, harness: "pi" }, "op-2")).not.toHaveProperty(
      "harness",
    );
    expect(
      startInput({ ...base, harness: "claude-code" }, "op-3"),
    ).toMatchObject({ harness: "claude-code" });
  });
});

describe("why a thread stopped", () => {
  it("names what an expired wait was for", () => {
    expect(stateReasonKey("queue_expired:low_disk")).toEqual({
      key: "codingReasonQueueExpired",
      reason: "low_disk",
    });
    expect(stateReasonKey(null)).toBeNull();
  });
});

describe("codingStateBadge", () => {
  it("maps each state onto the mark a chat's icon has", () => {
    const states: Record<CodingThreadState, string | null> = {
      provisioning: "working",
      queued: "working",
      running: "working",
      waiting_input: "attention",
      failed: "error",
      idle: null,
      archived: null,
    };
    for (const [state, mark] of Object.entries(states)) {
      expect(codingStateBadge(state as CodingThreadState)).toBe(mark);
    }
  });
});

describe("codingByChat", () => {
  const thread = (id: string, chat: string | null, createdAt: number) =>
    ({ id, chat, createdAt }) as CodingThreadSummary;

  it("groups threads under the chat that started them, oldest first, and leaves out the rest", () => {
    const byChat = codingByChat([
      thread("late", "a", 30),
      thread("other", "b", 20),
      thread("alone", null, 15),
      thread("early", "a", 10),
    ]);
    expect([...byChat.keys()].sort()).toEqual(["a", "b"]);
    expect(byChat.get("a")?.map((t) => t.id)).toEqual(["early", "late"]);
  });
});
