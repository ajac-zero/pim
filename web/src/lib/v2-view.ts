import type { AssistantMessage, Message } from "@earendil-works/pi-ai";
import type { AgentEvent, EntryRecord } from "@earendil-works/pi-durable";
import type { TranscriptMessage } from "@pim/shared/transcript";
import type { Session } from "~/lib/pim-api";
import { EMPTY_STREAM, reduce, type StreamState } from "~/lib/pim-view";

/**
 * Pim v2 shows a chat as the projected messages of its snapshot and live updates (`@pim/shared/transcript`'s `TranscriptMessage`), not pi's own events.
 * The chat view is built from pi's entries, so each message is put back in the shape it was projected from, and the same reducer that folds v1's
 * events folds these: both versions draw one chat the same way.
 */
export type V2Message = TranscriptMessage & { partial?: boolean };

/** A message of the transcript as the pi message it was projected from. */
function piMessage(m: V2Message): Message | null {
  if (m.role === "user") {
    return {
      role: "user",
      content: m.parts.filter(
        (part) => part.type === "text" || part.type === "image",
      ) as never,
      timestamp: m.timestamp,
      // What another agent's post carries, for the chat to show who is behind it.
      ...(m.provenance ? { provenance: m.provenance } : {}),
    } as Message;
  }
  if (m.role === "assistant") return assistantOf(m);
  if (m.role === "tool") {
    const result = m.parts.find((part) => part.type === "tool-result");
    if (result?.type !== "tool-result") return null;
    return {
      role: "toolResult",
      toolCallId: result.id,
      toolName: result.name,
      content: result.content as never,
      isError: result.error,
      timestamp: m.timestamp,
    };
  }
  return null;
}

export function assistantOf(m: V2Message): AssistantMessage {
  return {
    role: "assistant",
    content: m.parts.flatMap((part): AssistantMessage["content"] => {
      if (part.type === "text")
        return [{ type: "text" as const, text: part.text }];
      if (part.type === "thinking") {
        return [{ type: "thinking" as const, thinking: part.text }];
      }
      if (part.type === "tool-call") {
        return [
          {
            type: "toolCall" as const,
            id: part.id,
            name: part.name,
            arguments: part.arguments as never,
            ...(part.provenance ? { provenance: part.provenance } : {}),
          },
        ];
      }
      return [];
    }),
    api: "",
    // What the request recorded, or nothing: a message stored without its model stays unknown here.
    provider: m.model?.provider ?? "",
    model: m.model?.model ?? "",
    ...(m.model?.served === undefined ? {} : { responseModel: m.model.served }),
    usage: {} as never,
    stopReason: (m.stopReason ?? "stop") as never,
    ...(m.error === undefined ? {} : { errorMessage: m.error }),
    timestamp: m.timestamp,
  } as AssistantMessage;
}

/** The pi entry a projected message came from; null for a message the view doesn't draw. */
export function entryOf(m: V2Message): EntryRecord | null {
  const id = Number(m.id);
  if (m.role === "notice") {
    if (m.compaction) {
      return {
        id,
        kind: "pi.compaction",
        model: [
          {
            role: "user",
            content: m.parts
              .map((p) => (p.type === "text" ? p.text : ""))
              .join(""),
            timestamp: m.timestamp,
          },
        ],
      } as unknown as EntryRecord;
    }
    return { id, kind: "pi.reset" } as unknown as EntryRecord;
  }
  const message = piMessage(m);
  return message
    ? ({ id, kind: "pi.message", model: [message] } as unknown as EntryRecord)
    : null;
}

const asEvent = (event: object) => event as unknown as AgentEvent;

/** A pi inbox item: an input queued behind the running turn. */
export type V2Queued = {
  id: number;
  mode: "steer" | "followUp";
  content: unknown;
};

/** A chat's view from the messages of a snapshot: the committed ones, and the answer still being written, if any, and the messages queued behind it. */
export function streamOf(
  messages: readonly V2Message[],
  queue: readonly V2Queued[] = [],
): StreamState {
  const final = new Set(messages.filter((m) => !m.partial).map((m) => m.id));
  const entries = messages.flatMap((m) => {
    const entry = m.partial ? null : entryOf(m);
    return entry ? [entry] : [];
  });
  const writing = messages.findLast(
    (m) => m.partial && m.role === "assistant" && !final.has(m.id),
  );
  const state = reduce(
    EMPTY_STREAM,
    asEvent({
      type: "snapshot",
      entries,
      run: writing ? {} : undefined,
      tools: [],
      inbox: queue,
      generation: writing ? { message: assistantOf(writing) } : undefined,
    }),
  );
  // A chat whose last word is a failed model request shows why, as v1's view did from the failed task.
  const last = messages.findLast((m) => !m.partial);
  return last ? failed(state, last) : state;
}

/** The view's error for a committed assistant message that ended in a model error: a stalled stream, a refused credential, a provider's failure. */
function failed(state: StreamState, m: V2Message): StreamState {
  if (m.role !== "assistant" || m.stopReason !== "error" || !m.error) {
    return state;
  }
  return reduce(
    state,
    asEvent({ type: "task_failed", kind: "pi.generation", message: m.error }),
  );
}

/** One more message, from the live stream: a committed one is appended (and ends the answer being written); a partial replaces the one being written. */
export function applyMessage(state: StreamState, m: V2Message): StreamState {
  if (m.partial) {
    if (m.role !== "assistant") return state;
    const started = state.view.running
      ? state
      : reduce(state, asEvent({ type: "run_start" }));
    return reduce(
      started,
      asEvent({ type: "message_start", message: assistantOf(m) }),
    );
  }
  const entry = entryOf(m);
  if (!entry) return state;
  return failed(
    reduce(
      state,
      asEvent({
        type: m.role === "assistant" ? "message_end" : "entry_appended",
        entry,
      }),
    ),
    m,
  );
}

/** The utility model's line for tool calls of the work in progress; lines last as long as the app does. */
export function applyProgress(
  state: StreamState,
  calls: readonly string[],
  text: string,
): StreamState {
  const lines = { ...state.view.lines };
  for (const call of calls) lines[call] = text;
  return { ...state, view: { ...state.view, lines } };
}

/** The messages queued behind the chat's running turn changed. */
export function applyQueue(
  state: StreamState,
  queue: readonly V2Queued[],
): StreamState {
  return reduce(state, asEvent({ type: "inbox_update", items: queue }));
}

/** Whether the chat is at work, as the sidebar's summary says: it ends the answer being written when it is not. */
export function applyBusy(state: StreamState, busy: boolean): StreamState {
  if (state.view.running === busy) return state;
  return reduce(state, asEvent({ type: busy ? "run_start" : "run_end" }));
}

/** A row of the sidebar's snapshot, and what its live summaries carry. */
export type SidebarRow = {
  chatId: string;
  title: string | null;
  busy: boolean;
  unread: boolean;
  stalled?: boolean;
  updatedAt: number;
  summary?: Record<string, unknown> | null;
};

/** The sidebar's row as the app's own `Session`. */
export function sessionOf(row: SidebarRow): Session {
  const summary = row.summary ?? {};
  const agent = summary.agent;
  return {
    id: row.chatId,
    title: row.title,
    busy: row.busy,
    createdAt:
      typeof summary.createdAt === "number" ? summary.createdAt : row.updatedAt,
    updatedAt: row.updatedAt,
    responseAt:
      typeof summary.responseAt === "number" ? summary.responseAt : null,
    unread: row.unread,
    archived: summary.archived === true,
    ...(typeof summary.contextTokens === "number"
      ? { contextTokens: summary.contextTokens }
      : {}),
    ...(typeof summary.model === "object" && summary.model !== null
      ? { model: summary.model as Session["model"] }
      : {}),
    agent:
      typeof agent === "object" && agent !== null
        ? (agent as { id: string; name: string })
        : null,
    // A chat an agent started for a task says who started it, so the sidebar lists it under that chat.
    ...(typeof summary.startedBy === "object" && summary.startedBy !== null
      ? { startedBy: summary.startedBy as Session["startedBy"] }
      : {}),
    // A group chat's room rides in the row's summary, like its agent.
    ...(typeof summary.room === "object" && summary.room !== null
      ? { room: summary.room as Session["room"] }
      : {}),
  };
}

/** The list with one session put in its place, most recently active first. */
export function upsertSession(
  list: readonly Session[] | undefined,
  next: Session,
): Session[] {
  const others = (list ?? []).filter((s) => s.id !== next.id);
  // A live row does not carry the chat's agent or own model; it keeps the ones the list had.
  const before = list?.find((s) => s.id === next.id);
  const model = next.model ?? before?.model;
  const agent = next.agent ?? before?.agent;
  return [
    ...others,
    { ...next, ...(model ? { model } : {}), ...(agent ? { agent } : {}) },
  ].sort((a, b) => (b.updatedAt ?? 0) - (a.updatedAt ?? 0));
}
