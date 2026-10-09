import type { AssistantMessage, Message } from "@earendil-works/pi-ai";
import type {
  AgentEvent,
  EntryRecord,
  MessageChange,
} from "@earendil-works/pi-durable";
import type {
  FunctionCallItem,
  FunctionCallOutputItem,
  MessageItem,
  ORItem,
  ReasoningItem,
} from "~/lib/openresponses";

/**
 * Folds Pim's WebSocket stream (pi's agent events: a snapshot, then one batch
 * per commit) into what the chat shows. Pure, so it is tested without a
 * browser. pi's transcript entries become the Open Responses items parley's
 * components render: text → message, thinking → reasoning, tool calls →
 * function_call / function_call_output.
 */

/** Something Pim fed itself: an approval decision, a scheduled task, an app event, a reset. */
export type PimNotice = {
  kind: "approval" | "schedule" | "event" | "reset";
  /** One line, without the machine prefix. */
  title: string;
  /** The full text Pim received. */
  text: string;
  /** For an approval decision, the approval's id. */
  approval?: string;
};

export type ThreadEntry =
  | { key: string; kind: "item"; item: ORItem; source: "user" | "agent" }
  | { key: string; kind: "notice"; notice: PimNotice };

export type RunningTool = { callId: string; name: string; output: string };

export type SessionView = {
  /** The committed transcript, since the newest reset. */
  entries: readonly ThreadEntry[];
  /** The assistant message being streamed, as entries. */
  live: readonly ThreadEntry[];
  running: boolean;
  tools: readonly RunningTool[];
  /** Messages queued behind the running work. */
  queued: number;
  retry: { at: number; error: string } | null;
  error: string | null;
};

export const EMPTY_VIEW: SessionView = {
  entries: [],
  live: [],
  running: false,
  tools: [],
  queued: 0,
  retry: null,
  error: null,
};

const NOTICE_PREFIXES: ReadonlyArray<[RegExp, PimNotice["kind"]]> = [
  [/^\[Approval ([^\]]+)\]\s*/, "approval"],
  [/^\[Scheduled task[^\]]*\]\s*/, "schedule"],
  [/^\[App event\]\s*/, "event"],
];

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
      const notice = noticeOf(text);
      if (notice) return [{ key, kind: "notice", notice }];
      return [
        {
          key,
          kind: "item",
          source: "user",
          item: {
            type: "message",
            id: key,
            role: "user",
            content: [{ type: "input_text", text }],
          } satisfies MessageItem,
        },
      ];
    }
    case "assistant":
      return message.content.flatMap((block, index): ThreadEntry[] => {
        // Empty text blocks are placeholders while a block starts.
        if (block.type === "text" && block.text === "") return [];
        const item = blockItem(block, `${key}:${index}`);
        return item
          ? [{ key: `${key}:${index}`, kind: "item", source: "agent", item }]
          : [];
      });
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
        // Partial argument JSON; the call shows once its block completes.
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
          retry: event.generation?.retry ?? null,
          error: null,
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
        view: { ...view, retry: { at: event.at, error: event.errorMessage } },
      };
    case "auto_retry_end":
      return { ...state, view: { ...view, retry: null } };
    case "task_failed":
      return { ...state, view: { ...view, error: event.message } };
    case "submission": {
      const record = event.record;
      if (
        record.status === "unanswered" &&
        record.reason !== "aborted" &&
        record.reason !== "withdrawn"
      ) {
        return {
          ...state,
          view: { ...view, error: `Not answered: ${record.reason}` },
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
