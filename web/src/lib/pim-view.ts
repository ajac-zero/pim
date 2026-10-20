import type {
  AssistantMessage,
  Message,
  UserMessage,
} from "@earendil-works/pi-ai";
import type {
  AgentEvent,
  EntryRecord,
  MessageChange,
} from "@earendil-works/pi-durable";
import {
  type FunctionCallItem,
  type FunctionCallOutputItem,
  type MessageItem,
  messageText,
  type ORItem,
  type ReasoningItem,
} from "~/lib/openresponses";
import type { AgentTask } from "~/lib/pim-api";
import {
  DELIVERY_REMINDER,
  INTRODUCTION,
  NOTICE_PREFIXES,
  reasoningHeadings,
} from "../../../src/transcript";

/**
 * Folds Pim's WebSocket stream (pi's agent events: a snapshot, then one batch
 * per commit) into what the chat shows. Pure, so it is tested without a
 * browser. pi's transcript entries become the Open Responses items parley's
 * components render: text → message, thinking → reasoning, tool calls →
 * function_call / function_call_output.
 */

/** Something Pim fed itself: an approval decision, a scheduled task, an app event, tasks' answers, a reset. */
export type PimNotice = {
  kind: "approval" | "schedule" | "event" | "task" | "reset";
  /** One line, without the machine prefix. */
  title: string;
  /** The full text Pim received. */
  text: string;
  /** For an approval decision, the approval's id. */
  approval?: string;
};

export type ThreadEntry =
  | {
      key: string;
      kind: "item";
      item: ORItem;
      source: "user" | "agent";
      /** When it was said, in ms: when the person sent it, or when the agent finished writing it. */
      at: number;
    }
  /** `at` is when Pim gave it, except for a reset. */
  | { key: string; kind: "notice"; notice: PimNotice; at?: number };

export type RunningTool = { callId: string; name: string; output: string };

/** Connects each handoff and its later answers, without treating a waiting task as answered. */
export function taskHistory(
  entries: readonly ThreadEntry[],
  tasks: readonly AgentTask[],
) {
  const delegations = new Map<string, AgentTask[]>();
  const notices = new Map<string, AgentTask[]>();
  const completions = new Map<string, string>();
  const calls = new Set(
    entries.flatMap((entry) =>
      entry.kind === "item" &&
      entry.item.type === "function_call" &&
      entry.item.name === "delegate"
        ? [entry.item.call_id as string]
        : [],
    ),
  );
  for (const entry of entries) {
    if (
      entry.kind === "item" &&
      entry.item.type === "function_call_output" &&
      calls.has(entry.item.call_id as string)
    ) {
      const output = entry.item as FunctionCallOutputItem;
      if (output.status === "incomplete" || typeof output.output !== "string")
        continue;
      // These lines are the delegate tool's receipt, not the model's arguments.
      const ids = new Set(
        [...output.output.matchAll(/^Task (\S+): /gm)].map((match) => match[1]),
      );
      const group = tasks.filter((task) => ids.has(task.id));
      // Descendants work in their own transcripts, but belong under this handoff.
      for (const task of group) {
        group.push(...tasks.filter((child) => child.parent === task.id));
      }
      if (group.length > 0) delegations.set(output.call_id, group);
    }
    if (entry.kind === "notice" && entry.notice.kind === "task") {
      const ids = new Set(
        [
          ...entry.notice.text.matchAll(
            /^(?:.+ (?:finished|didn't finish) task (\S+):|Task (\S+) for .+ was canceled:)/gm,
          ),
        ].map((match) => match[1] ?? match[2]),
      );
      const answered = tasks.filter((task) => ids.has(task.id));
      notices.set(entry.key, answered);
      for (const task of answered) completions.set(task.id, entry.key);
    }
  }
  const placed = new Set(
    [...delegations.values()].flat().map((task) => task.id),
  );
  return {
    delegations,
    completions,
    notices: new Map(
      [...notices].map(([key, answered]) => [
        key,
        answered.filter((task) => placed.has(task.id)),
      ]),
    ),
  };
}

export type SessionView = {
  /** The committed transcript, since the newest reset. */
  entries: readonly ThreadEntry[];
  /** The assistant message being streamed, as entries. */
  live: readonly ThreadEntry[];
  running: boolean;
  tools: readonly RunningTool[];
  /** Messages queued behind the running work. */
  queued: number;
  retry: { at: number } | null;
  error: ViewError | null;
  /**
   * The utility model's line for each tool call it described, by call id
   * (see src/progress.ts). Lines aren't stored: they last as long as the app.
   */
  lines: Readonly<Record<string, string>>;
};

/**
 * Why a model request failed, read from its error text. The text itself is
 * never shown: it is the provider's response, which can echo the request.
 */
export type ModelProblem =
  | "usage_limit"
  | "quota"
  | "sign_in"
  | "too_long"
  | "busy"
  | "other";

export type ViewError =
  /** A failed or faulted model request. */
  | { problem: ModelProblem }
  /** Any other faulted task, such as a tool's. Its message is never shown. */
  | { taskFailed: true }
  /** pi's code for any other unanswered input. */
  | { reason: string };

/** The task kinds whose work is a model request. */
const MODEL_TASKS = new Set(["pi.generation", "pi.compaction"]);

/** First match wins. */
const MODEL_PROBLEMS: ReadonlyArray<[ModelProblem, RegExp]> = [
  // Sign in with ChatGPT: the plan's usage, or Pim's own App limit, is used up.
  ["usage_limit", /subscription_sharing_usage_limit_exceeded/],
  // Pim's own daily limits (QUOTA_MESSAGE in src/usage.ts).
  ["quota", /^Pim usage quota exceeded\b/],
  [
    "sign_in",
    /OpenAI token request failed|refresh response|Sign in to ChatGPT|invalid_grant|\b401\b|unauthori[sz]ed/i,
  ],
  [
    "too_long",
    /context.?(length|window)|maximum context|too many tokens|prompt is too long/i,
  ],
  [
    "busy",
    /rate.?limit|too many requests|\b429\b|overloaded|capacity|\b50[0234]\b|unavailable|timed? ?out|network|fetch failed|connection/i,
  ],
];

export function modelProblem(text: string): ModelProblem {
  return (
    MODEL_PROBLEMS.find(([, pattern]) => pattern.test(text))?.[0] ?? "other"
  );
}

export const EMPTY_VIEW: SessionView = {
  entries: [],
  live: [],
  running: false,
  tools: [],
  queued: 0,
  retry: null,
  error: null,
  lines: {},
};

function textOf(content: Message["content"]): string {
  if (typeof content === "string") return content;
  return content
    .flatMap((part) => (part.type === "text" ? [part.text] : []))
    .join("");
}

/** A user-role message Pim submitted itself, recognized by its prefix. */
export function noticeOf(text: string): PimNotice | null {
  for (const [prefix, kind] of NOTICE_PREFIXES) {
    const match = prefix.exec(text);
    if (match) {
      const line = text.slice(match[0].length).split("\n")[0]?.trim() ?? "";
      return {
        kind,
        title: line.length > 120 ? `${line.slice(0, 119)}…` : line,
        text,
        ...(kind === "approval" && match[1] ? { approval: match[1] } : {}),
      };
    }
  }
  return null;
}

/** What the person sent, as an item: its text, then its images. */
export function userItem(
  content: UserMessage["content"],
  id?: string,
): MessageItem {
  const parts = typeof content === "string" ? [] : content;
  return {
    type: "message",
    ...(id === undefined ? {} : { id }),
    role: "user",
    content: [
      { type: "input_text", text: textOf(content) },
      ...parts.flatMap((part) =>
        part.type === "image"
          ? [
              {
                type: "input_image" as const,
                // A sent image is kept by URL; one not yet sent is still inline.
                image_url:
                  "url" in part && typeof part.url === "string"
                    ? part.url
                    : `data:${part.mimeType};base64,${part.data}`,
              },
            ]
          : [],
      ),
    ],
  };
}

/** One assistant content block as an item. */
function blockItem(
  block: AssistantMessage["content"][number],
  id: string,
): ORItem | null {
  switch (block.type) {
    case "text":
      return {
        type: "message",
        id,
        role: "assistant",
        content: [{ type: "output_text", text: block.text }],
      } satisfies MessageItem;
    case "thinking":
      return {
        type: "reasoning",
        id,
        summary: [{ type: "summary_text", text: block.thinking }],
      } satisfies ReasoningItem;
    case "toolCall":
      return {
        type: "function_call",
        id,
        call_id: block.id,
        name: block.name,
        arguments: JSON.stringify(block.arguments ?? {}),
      } satisfies FunctionCallItem;
    default:
      return null;
  }
}

/** One pi message as thread entries, keyed under `key`. */
export function projectMessage(message: Message, key: string): ThreadEntry[] {
  switch (message.role) {
    case "user": {
      const text = textOf(message.content);
      // Pim's own prompts: the majordomo's introduction starts with its message.
      if (text === DELIVERY_REMINDER || text.startsWith(INTRODUCTION))
        return [];
      const notice = noticeOf(text);
      if (notice)
        return [{ key, kind: "notice", notice, at: message.timestamp }];
      return [
        {
          key,
          kind: "item",
          source: "user",
          item: userItem(message.content, key),
          at: message.timestamp,
        },
      ];
    }
    case "assistant": {
      // Its timestamp is when the request started; a response being written has no duration yet.
      const at = message.timestamp + (message.durationMs ?? 0);
      return message.content.flatMap((block, index): ThreadEntry[] => {
        // Empty text blocks are placeholders while a block starts.
        if (block.type === "text" && block.text === "") return [];
        const item = blockItem(block, `${key}:${index}`);
        return item
          ? [
              {
                key: `${key}:${index}`,
                kind: "item",
                source: "agent",
                item,
                at,
              },
            ]
          : [];
      });
    }
    case "toolResult":
      return [
        {
          key,
          kind: "item",
          source: "agent",
          item: {
            type: "function_call_output",
            id: key,
            call_id: message.toolCallId,
            output: textOf(message.content),
            status: message.isError ? "incomplete" : "completed",
          } satisfies FunctionCallOutputItem,
          at: message.timestamp,
        },
      ];
    default:
      // System prompt changes are bookkeeping.
      return [];
  }
}

export function projectEntry(entry: EntryRecord): ThreadEntry[] {
  const key = String(entry.id);
  if (entry.kind === "pi.reset") {
    return [
      {
        key,
        kind: "notice",
        notice: { kind: "reset", title: "New context", text: "" },
      },
    ];
  }
  if (entry.kind === "pi.system") return [];
  const message = entry.model?.[0];
  return message ? projectMessage(message, key) : [];
}

function appendEntry(view: SessionView, entry: EntryRecord): SessionView {
  const projected = projectEntry(entry);
  if (projected.length === 0) return view;
  // A reset starts a new context; the view shows only the active one.
  if (entry.kind === "pi.reset") return { ...view, entries: projected };
  const known = new Set(view.entries.map((existing) => existing.key));
  const fresh = projected.filter((candidate) => !known.has(candidate.key));
  return fresh.length === 0
    ? view
    : { ...view, entries: [...view.entries, ...fresh] };
}

const LIVE = "live";

function emptyAssistant(): AssistantMessage {
  return {
    role: "assistant",
    content: [],
    api: "",
    provider: "",
    model: "",
    usage: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 0,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    stopReason: "stop",
    timestamp: 0,
  } as AssistantMessage;
}

/** `value` with `delta` appended to the string at `path`, copying only what changes. */
function appendAt(
  value: unknown,
  path: readonly (string | number)[],
  delta: string,
): unknown {
  if (path.length === 0)
    return (typeof value === "string" ? value : "") + delta;
  const [key, ...rest] = path as [string | number, ...(string | number)[]];
  if (Array.isArray(value)) {
    const copy = [...value];
    copy[key as number] = appendAt(copy[key as number], rest, delta);
    return copy;
  }
  const object = (value ?? {}) as Record<string, unknown>;
  return { ...object, [key]: appendAt(object[key], rest, delta) };
}

/** Applies streamed changes to the message being generated. */
export function applyChanges(
  message: AssistantMessage | null,
  changes: readonly MessageChange[],
): AssistantMessage | null {
  let current = message;
  for (const change of changes) {
    if (change.type === "message") {
      current = change.message;
      continue;
    }
    const base = current ?? emptyAssistant();
    const content = [...base.content];
    const previous = content[change.contentIndex];
    switch (change.type) {
      case "text_start":
      case "thinking_start":
      case "toolcall_start":
      case "block":
        content[change.contentIndex] = change.block;
        break;
      case "text_delta":
        content[change.contentIndex] = {
          type: "text",
          text: (previous?.type === "text" ? previous.text : "") + change.delta,
        };
        break;
      case "thinking_delta":
        content[change.contentIndex] = {
          ...(previous?.type === "thinking" ? previous : {}),
          type: "thinking",
          thinking:
            (previous?.type === "thinking" ? previous.thinking : "") +
            change.delta,
        };
        break;
      case "toolcall_delta":
        // Text appended to one string in the call's arguments, such as the
        // message `send_to_user` is writing.
        if (previous?.type === "toolCall") {
          content[change.contentIndex] = {
            ...previous,
            arguments: appendAt(
              previous.arguments,
              change.path,
              change.delta,
            ) as typeof previous.arguments,
          };
        }
        break;
    }
    current = { ...base, content };
  }
  return current;
}

/** The message being streamed lives outside the view, so deltas can apply to it. */
export type StreamState = {
  view: SessionView;
  message: AssistantMessage | null;
};

export const EMPTY_STREAM: StreamState = { view: EMPTY_VIEW, message: null };

function withLive(
  state: StreamState,
  message: AssistantMessage | null,
): StreamState {
  return {
    message,
    view: {
      ...state.view,
      live: message ? projectMessage(message, LIVE) : [],
    },
  };
}

export function reduce(state: StreamState, event: AgentEvent): StreamState {
  const { view } = state;
  switch (event.type) {
    case "snapshot": {
      const message = event.generation?.message ?? null;
      return {
        message,
        view: {
          entries: event.entries.reduce(
            (next, entry) => appendEntry(next, entry),
            EMPTY_VIEW,
          ).entries,
          live: message ? projectMessage(message, LIVE) : [],
          running: event.run !== undefined,
          tools: event.tools
            .filter((slot) => slot.status === "running")
            .map((slot) => ({
              callId: slot.callId,
              name: slot.name,
              output: slot.output ?? "",
            })),
          queued: event.inbox.length,
          retry: event.generation?.retry
            ? { at: event.generation.retry.at }
            : null,
          error: null,
          lines: view.lines,
        },
      };
    }
    case "run_start":
      return { ...state, view: { ...view, running: true, error: null } };
    case "run_end":
      return withLive(
        { ...state, view: { ...view, running: false, tools: [], retry: null } },
        null,
      );
    case "message_start":
      return event.message.role === "assistant"
        ? withLive(state, event.message)
        : state;
    case "message_update":
      return withLive(state, applyChanges(state.message, event.changes));
    case "message_end": {
      const next = { ...state, view: appendEntry(view, event.entry) };
      return event.entry.model?.[0]?.role === "assistant"
        ? withLive(next, null)
        : next;
    }
    case "entry_appended":
      return { ...state, view: appendEntry(view, event.entry) };
    case "tool_execution_start":
      return {
        ...state,
        view: {
          ...view,
          tools: [
            ...view.tools.filter((tool) => tool.callId !== event.toolCallId),
            { callId: event.toolCallId, name: event.toolName, output: "" },
          ],
        },
      };
    case "tool_execution_update": {
      const output = event.output;
      if (!output) return state;
      return {
        ...state,
        view: {
          ...view,
          tools: view.tools.map((tool) => {
            if (tool.callId !== event.toolCallId) return tool;
            if ("set" in output) return { ...tool, output: output.set };
            return {
              ...tool,
              output:
                tool.output.slice(output.trimStart ?? 0) +
                (output.append ?? ""),
            };
          }),
        },
      };
    }
    case "tool_execution_end": {
      const next = {
        ...view,
        tools: view.tools.filter((tool) => tool.callId !== event.toolCallId),
      };
      return {
        ...state,
        view: event.entry ? appendEntry(next, event.entry) : next,
      };
    }
    case "inbox_update":
      return { ...state, view: { ...view, queued: event.items.length } };
    case "auto_retry_start":
      return {
        ...state,
        view: { ...view, retry: { at: event.at } },
      };
    case "auto_retry_end":
      return { ...state, view: { ...view, retry: null } };
    case "task_failed": {
      // A fault's message can be a provider's or OpenAI's raw response.
      const error: ViewError = MODEL_TASKS.has(event.kind)
        ? { problem: modelProblem(event.message) }
        : { taskFailed: true };
      return { ...state, view: { ...view, error } };
    }
    case "submission": {
      const record = event.record;
      if (
        record.status === "unanswered" &&
        record.reason !== "aborted" &&
        record.reason !== "withdrawn"
      ) {
        // A model error's detail is the provider's error text, and says
        // what happened to this input.
        if (record.reason === "model_error") {
          const detail = typeof record.detail === "string" ? record.detail : "";
          return {
            ...state,
            view: { ...view, error: { problem: modelProblem(detail) } },
          };
        }
        // Another reason, such as "faulted", follows the task_failed of the
        // same commit, which already said more.
        if (view.error !== null) return state;
        return {
          ...state,
          view: { ...view, error: { reason: record.reason } },
        };
      }
      return state;
    }
    default:
      return state;
  }
}

export function reduceAll(
  state: StreamState,
  events: readonly AgentEvent[],
): StreamState {
  return events.reduce(reduce, state);
}

/** The tool Pim speaks with: its calls are the messages the person reads. */
export const SEND_TO_USER = "send_to_user";

/** What a `send_to_user` call sends; partial while it streams. */
export type Sent = {
  message: string;
  /** Where it went: this conversation, or the person's inbox. */
  channel: "chat" | "email";
  title: string | null;
  /** The widgets asked to go with it, by name; what they showed comes in the call's result. */
  widgets: string[];
};

export function sentOf(call: FunctionCallItem): Sent | null {
  if (call.name !== SEND_TO_USER) return null;
  let args: Record<string, unknown> = {};
  try {
    args = JSON.parse(call.arguments || "{}") as Record<string, unknown>;
  } catch {
    // Not whole yet.
  }
  return {
    message: typeof args.message === "string" ? args.message : "",
    channel: args.channel === "email" ? "email" : "chat",
    title: typeof args.title === "string" ? args.title : null,
    widgets: Array.isArray(args.widgets)
      ? args.widgets.filter((ref): ref is string => typeof ref === "string")
      : [],
  };
}

/**
 * One step of an agent's work the person doesn't read: a heading of its
 * summarized reasoning (`text` alone), or a tool it called (`tool`), with
 * the utility model's line for the call as `text` when there is one; the
 * app names the others.
 */
export type WorkStep = { tool: string | null; text: string | null };

/** One row of the chat as the person reads it. */
export type ThreadRow =
  /** Something they said, a notice, or a user-facing approval or artifact. */
  | { kind: "entry"; key: string; entry: ThreadEntry }
  /** A message Pim sent them. */
  | {
      kind: "sent";
      key: string;
      call: FunctionCallItem;
      sent: Sent;
      /** When it was sent, in ms. */
      at: number;
    }
  /** The work the agent did before the next row, or is doing now (`live`). */
  | {
      kind: "work";
      key: string;
      steps: WorkStep[];
      /** How long it took, in ms; null while it goes on, or when it's unknown where it began. */
      ms: number | null;
      live: boolean;
    };

/**
 * The steps an assistant block shows: its reasoning's headings, or a tool it
 * called other than to send, as the utility model's line for it if there is one.
 */
function stepsOf(
  item: ORItem,
  lines: Readonly<Record<string, string>>,
): WorkStep[] {
  if (item.type === "reasoning") {
    return reasoningHeadings(
      ((item as ReasoningItem).summary ?? [])
        .map((part) => part.text)
        .join("\n\n"),
    ).map((text) => ({ tool: null, text }));
  }
  if (item.type === "function_call") {
    const call = item as FunctionCallItem;
    if (call.name === SEND_TO_USER) return [];
    return [{ tool: call.name, text: lines[call.call_id] ?? null }];
  }
  return [];
}

/**
 * Lays the thread out as the person reads it: what they said and what Pim sent
 * them. `shown` picks user-facing approvals and artifacts, never raw tool calls.
 *
 * Only explicit send_to_user calls are presented as assistant text. Ordinary
 * assistant text, raw reasoning, tool arguments and results are private, even
 * without a send. With `work`, the agent's work before each row is a work row
 * of its steps: its reasoning's headings, and the tools it used, or the
 * utility model's `lines` for them. While it is `running`, the work after the
 * last row is a live work row, which grows as it goes.
 */
export function layoutThread(
  entries: readonly ThreadEntry[],
  options: {
    shown: (call: FunctionCallItem) => boolean;
    /** A `send_to_user` call the tool refused (an unknown widget, an email that couldn't go): nothing reached the person. */
    refused?: (call: FunctionCallItem) => boolean;
    work?: { running: boolean; lines?: Readonly<Record<string, string>> };
  },
): ThreadRow[] {
  const rows: ThreadRow[] = [];
  let steps: WorkStep[] = [];
  let workKey = "";
  /** When the last row was said, where the work after it began. */
  let since: number | null = null;
  /** When the work's latest step ended. */
  let until: number | null = null;
  const lines = options.work?.lines ?? {};
  const fold = (end: number | null, live = false) => {
    if (options.work && steps.length > 0) {
      rows.push({
        kind: "work",
        key: `work:${workKey}`,
        steps,
        ms:
          !live && since !== null && end !== null
            ? Math.max(0, end - since)
            : null,
        live,
      });
    }
    steps = [];
  };
  const own = (entry: ThreadEntry) => {
    fold(until);
    rows.push({ kind: "entry", key: entry.key, entry });
    since = entry.at ?? null;
  };
  for (const entry of entries) {
    if (entry.kind === "notice") {
      own(entry);
      continue;
    }
    const { item } = entry;
    switch (item.type) {
      case "message":
      case "reasoning":
        if ((item as MessageItem).role === "user") own(entry);
        else if (entry.source === "agent") {
          if (steps.length === 0) workKey = entry.key;
          steps.push(...stepsOf(item, lines));
          until = entry.at;
        }
        break;
      case "function_call": {
        const call = item as FunctionCallItem;
        const message = sentOf(call);
        if (message) {
          // Failed sends stay private too: nothing reached the person.
          if (options.refused?.(call)) break;
          // Nothing to read until its message starts streaming.
          if (message.message === "") break;
          fold(entry.at);
          rows.push({
            kind: "sent",
            key: entry.key,
            call,
            sent: message,
            at: entry.at,
          });
          since = entry.at;
        } else if (options.shown(call)) own(entry);
        else {
          if (steps.length === 0) workKey = entry.key;
          steps.push(...stepsOf(item, lines));
          until = entry.at;
        }
        break;
      }
      case "function_call_output":
        // Shown with its call; the step it ends lasted until it came.
        until = entry.at;
        break;
      default:
        // Unknown internal items are not a user-facing message either.
        break;
    }
  }
  fold(until, options.work?.running);
  return rows;
}

/** The readable conversation as Markdown, never the agent's private working transcript. */
export function conversationMarkdown(
  entries: readonly ThreadEntry[],
  agent: string,
): string {
  const refused = new Set(
    entries.flatMap((entry) =>
      entry.kind === "item" &&
      entry.item.type === "function_call_output" &&
      entry.item.status === "incomplete"
        ? [entry.item.call_id]
        : [],
    ),
  );
  // Names are headings, not Markdown supplied by the conversation.
  const name = agent
    .replace(/[\r\n]+/g, " ")
    .replace(/[\\`*_{}[\]<>()#!|]/g, "\\$&");
  return layoutThread(entries, {
    shown: () => false,
    refused: (call) => refused.has(call.call_id),
  })
    .flatMap((row) => (row.kind === "work" ? [] : [row]))
    .map((row) => {
      if (row.kind === "sent") {
        const email = row.sent.channel === "email" ? " (email)" : "";
        return `## Agent: ${name}${email}\n\n${row.sent.message}`;
      }
      const { entry } = row;
      if (entry.kind === "notice") {
        return `## System\n\n${entry.notice.text || entry.notice.title}`;
      }
      const item = entry.item as MessageItem;
      const images =
        typeof item.content === "string"
          ? []
          : item.content
              .filter((part) => part.type === "input_image")
              .map(() => "[Attached image]");
      return `## User\n\n${[messageText(item), ...images].filter(Boolean).join("\n\n")}`;
    })
    .join("\n\n---\n\n");
}
