/**
 * Client-safe Open Responses (openresponses.org) domain model.
 *
 * Parley persists agent items verbatim (lossless round-tripping is required
 * by the spec) and treats unknown item/event types as opaque extensions, so
 * these types intentionally model the common core plus escape hatches.
 */

export type ItemStatus = "in_progress" | "completed" | "incomplete";

export const A2UI_ITEM_TYPE = "ajac-zero:a2ui";
export const ARTIFACT_ITEM_TYPE = "ajac-zero:artifact";

/* ----------------------------- content parts ----------------------------- */

export interface InputTextPart {
  type: "input_text";
  text: string;
}

export interface InputImagePart {
  type: "input_image";
  image_url?: string;
  detail?: "low" | "high" | "auto";
}

export interface InputFilePart {
  type: "input_file";
  filename?: string;
  file_data?: string;
  file_url?: string;
}

export interface OutputTextPart {
  type: "output_text";
  text: string;
  annotations?: Array<Record<string, unknown>>;
}

export interface RefusalPart {
  type: "refusal";
  refusal: string;
}

export interface SummaryTextPart {
  type: "summary_text";
  text: string;
}

export interface ReasoningTextPart {
  type: "reasoning_text";
  text: string;
}

export interface UnknownPart {
  type: string;
  [key: string]: unknown;
}

export type ContentPart =
  | InputTextPart
  | InputImagePart
  | InputFilePart
  | OutputTextPart
  | RefusalPart
  | SummaryTextPart
  | ReasoningTextPart
  | UnknownPart;

/* --------------------------------- items --------------------------------- */

export type MessageRole = "user" | "assistant" | "system" | "developer";

export interface MessageItem {
  type: "message";
  id?: string;
  role: MessageRole;
  status?: ItemStatus;
  content: string | ContentPart[];
  phase?: "commentary" | "final_answer";
}

export interface FunctionCallItem {
  type: "function_call";
  id?: string;
  call_id: string;
  name: string;
  arguments: string;
  status?: ItemStatus;
}

export interface FunctionCallOutputItem {
  type: "function_call_output";
  id?: string;
  call_id: string;
  output: string | ContentPart[];
  status?: ItemStatus;
}

export interface ReasoningItem {
  type: "reasoning";
  id?: string;
  status?: ItemStatus;
  summary?: SummaryTextPart[];
  content?: Array<ReasoningTextPart | OutputTextPart>;
  encrypted_content?: string | null;
}

export interface CompactionItem {
  type: "compaction";
  id?: string;
  encrypted_content: string;
}

export interface ParleyAttachmentItem {
  type: "parley:attachment";
  id: string;
  status: "completed";
  filename: string;
  mime_type: string;
  size: number;
  file_url: string;
  provider_artifact?: { id: string };
}

export interface A2uiPresentationItem {
  type: typeof A2UI_ITEM_TYPE;
  id: string;
  status: "completed";
  call_id: string;
  mime_type: "application/a2ui+json";
  uri: string;
  fallback_text?: string;
  messages: Array<Record<string, unknown>>;
}

export interface DownloadableArtifactItem {
  type: typeof ARTIFACT_ITEM_TYPE;
  id: string;
  status: "completed";
  call_id?: string;
  filename: string;
  mime_type: string;
  size: number;
  content_url: string;
}

export interface UnknownItem {
  type: string;
  id?: string;
  status?: string;
  [key: string]: unknown;
}

export type ORItem =
  | MessageItem
  | FunctionCallItem
  | FunctionCallOutputItem
  | ReasoningItem
  | CompactionItem
  | ParleyAttachmentItem
  | A2uiPresentationItem
  | DownloadableArtifactItem
  | UnknownItem;

export const isMessageItem = (item: ORItem): item is MessageItem =>
  item.type === "message";
export const isFunctionCallItem = (item: ORItem): item is FunctionCallItem =>
  item.type === "function_call";
export const isFunctionCallOutputItem = (
  item: ORItem,
): item is FunctionCallOutputItem => item.type === "function_call_output";
export const isReasoningItem = (item: ORItem): item is ReasoningItem =>
  item.type === "reasoning";

/** Concatenated plain text of a message item (output_text/input_text parts). */
export function messageText(item: MessageItem): string {
  if (typeof item.content === "string") return item.content;
  return item.content
    .map((part) => {
      if (part.type === "output_text" || part.type === "input_text") {
        return (part as OutputTextPart | InputTextPart).text;
      }
      return "";
    })
    .join("");
}

export function reasoningSummaryText(item: ReasoningItem): string {
  const fromSummary = (item.summary ?? [])
    .map((p) => p.text ?? "")
    .join("\n\n");
  if (fromSummary.trim().length > 0) return fromSummary;
  return (item.content ?? []).map((p) => p.text ?? "").join("\n\n");
}

/** Removes platform-only presentation items from provider replay. */
export function portableInputItem(item: ORItem): ORItem | null {
  if (
    item.type === "parley:attachment" ||
    item.type === A2UI_ITEM_TYPE ||
    item.type === ARTIFACT_ITEM_TYPE
  ) {
    return null;
  }
  return item;
}

/* ------------------------------ stream events ---------------------------- */

/** Any Open Responses streaming event (extensions included). */
export interface ORStreamEvent {
  type: string;
  sequence_number?: number;
  [key: string]: unknown;
}

export interface ResponseSnapshot {
  id?: string;
  status?: string;
  output?: ORItem[];
  usage?: Record<string, unknown> | null;
  error?: { code?: string; message?: string } | null;
  incomplete_details?: { reason?: string } | null;
  [key: string]: unknown;
}

/* ------------------------- turn stream reducer --------------------------- */

export type TurnStatus =
  | "pending"
  | "streaming"
  | "completed"
  | "incomplete"
  | "failed"
  | "cancelled";

export interface TurnStreamState {
  responseId: string | null;
  status: "idle" | "in_progress" | "completed" | "incomplete" | "failed";
  /** Items indexed by output_index. May contain holes while streaming. */
  items: ORItem[];
  usage: Record<string, unknown> | null;
  error: { code?: string; message: string } | null;
}

export const initialTurnStreamState: TurnStreamState = {
  responseId: null,
  status: "idle",
  items: [],
  usage: null,
  error: null,
};

const asRecord = (value: unknown): Record<string, unknown> =>
  typeof value === "object" && value !== null
    ? (value as Record<string, unknown>)
    : {};

const num = (value: unknown, fallback = 0): number =>
  typeof value === "number" && Number.isFinite(value) ? value : fallback;

const str = (value: unknown): string =>
  typeof value === "string" ? value : "";

function withItem(
  state: TurnStreamState,
  index: number,
  update: (item: ORItem) => ORItem,
): TurnStreamState {
  const existing = state.items[index];
  if (existing === undefined) return state;
  const items = state.items.slice();
  items[index] = update(existing);
  return { ...state, items };
}

function updatePart(
  item: ORItem,
  contentIndex: number,
  update: (part: ContentPart) => ContentPart,
): ORItem {
  const record = item as unknown as Record<string, unknown>;
  const content = Array.isArray(record.content)
    ? (record.content as ContentPart[]).slice()
    : [];
  const part = content[contentIndex];
  if (part === undefined) return item;
  content[contentIndex] = update(part);
  return { ...record, content } as unknown as ORItem;
}

function appendTextToPart(part: ContentPart, delta: string): ContentPart {
  const existing = str((part as { text?: unknown }).text);
  return { ...part, text: existing + delta } as ContentPart;
}

/**
 * Applies one Open Responses streaming event to the accumulated turn state.
 * Pure and immutable: used by the web UI for live rendering and by the server
 * for persisting partial output when a stream is cancelled or fails midway.
 * Unknown event types are ignored, as the spec requires.
 */
export function reduceORevent(
  state: TurnStreamState,
  event: ORStreamEvent,
): TurnStreamState {
  switch (event.type) {
    case "response.created":
    case "response.queued":
    case "response.in_progress": {
      const response = asRecord(event.response);
      return {
        ...state,
        status: "in_progress",
        responseId: str(response.id) || state.responseId,
      };
    }

    case "response.output_item.added": {
      const index = num(event.output_index, state.items.length);
      const items = state.items.slice();
      items[index] = asRecord(event.item) as unknown as ORItem;
      return { ...state, items };
    }

    case "response.output_item.done": {
      const index = num(event.output_index, state.items.length);
      const items = state.items.slice();
      items[index] = asRecord(event.item) as unknown as ORItem;
      return { ...state, items };
    }

    case "response.content_part.added": {
      const index = num(event.output_index);
      const contentIndex = num(event.content_index);
      return withItem(state, index, (item) => {
        const record = item as unknown as Record<string, unknown>;
        const content = Array.isArray(record.content)
          ? (record.content as ContentPart[]).slice()
          : [];
        content[contentIndex] = asRecord(event.part) as ContentPart;
        return { ...record, content } as unknown as ORItem;
      });
    }

    case "response.content_part.done": {
      const index = num(event.output_index);
      const contentIndex = num(event.content_index);
      return withItem(state, index, (item) =>
        updatePart(
          item,
          contentIndex,
          () => asRecord(event.part) as ContentPart,
        ),
      );
    }

    case "response.output_text.delta":
    case "response.refusal.delta": {
      const index = num(event.output_index);
      const contentIndex = num(event.content_index);
      const delta = str(event.delta);
      const key = event.type === "response.refusal.delta" ? "refusal" : "text";
      return withItem(state, index, (item) =>
        updatePart(item, contentIndex, (part) => {
          if (key === "refusal") {
            const existing = str((part as { refusal?: unknown }).refusal);
            return { ...part, refusal: existing + delta } as ContentPart;
          }
          return appendTextToPart(part, delta);
        }),
      );
    }

    case "response.output_text.done": {
      const index = num(event.output_index);
      const contentIndex = num(event.content_index);
      return withItem(state, index, (item) =>
        updatePart(item, contentIndex, (part) => ({
          ...part,
          text: str(event.text),
        })),
      );
    }

    case "response.output_text.annotation.added": {
      const index = num(event.output_index);
      const contentIndex = num(event.content_index);
      const annotationIndex = event.annotation_index;
      const annotation = event.annotation;
      if (
        !Number.isSafeInteger(annotationIndex) ||
        (annotationIndex as number) < 0 ||
        typeof annotation !== "object" ||
        annotation === null
      ) {
        return state;
      }
      return withItem(state, index, (item) =>
        updatePart(item, contentIndex, (part) => {
          const annotations = Array.isArray(
            (part as { annotations?: unknown }).annotations,
          )
            ? [
                ...((part as OutputTextPart).annotations as Array<
                  Record<string, unknown>
                >),
              ]
            : [];
          if ((annotationIndex as number) > annotations.length) return part;
          annotations[annotationIndex as number] = annotation as Record<
            string,
            unknown
          >;
          return { ...part, annotations } as ContentPart;
        }),
      );
    }

    case "response.refusal.done": {
      const index = num(event.output_index);
      const contentIndex = num(event.content_index);
      return withItem(state, index, (item) =>
        updatePart(item, contentIndex, (part) => ({
          ...part,
          refusal: str(event.refusal),
        })),
      );
    }

    case "response.function_call_arguments.delta": {
      const index = num(event.output_index);
      return withItem(state, index, (item) => {
        const record = item as unknown as Record<string, unknown>;
        return {
          ...record,
          arguments: str(record.arguments) + str(event.delta),
        } as unknown as ORItem;
      });
    }

    case "response.function_call_arguments.done": {
      const index = num(event.output_index);
      return withItem(state, index, (item) => {
        const record = item as unknown as Record<string, unknown>;
        return {
          ...record,
          arguments: str(event.arguments),
        } as unknown as ORItem;
      });
    }

    case "response.reasoning_summary_part.added":
    case "response.reasoning_summary_part.done": {
      const index = num(event.output_index);
      const summaryIndex = num(event.summary_index);
      return withItem(state, index, (item) => {
        const record = item as unknown as Record<string, unknown>;
        const summary = Array.isArray(record.summary)
          ? (record.summary as SummaryTextPart[]).slice()
          : [];
        summary[summaryIndex] = asRecord(
          event.part,
        ) as unknown as SummaryTextPart;
        return { ...record, summary } as unknown as ORItem;
      });
    }

    case "response.reasoning_summary_text.delta": {
      const index = num(event.output_index);
      const summaryIndex = num(event.summary_index);
      return withItem(state, index, (item) => {
        const record = item as unknown as Record<string, unknown>;
        const summary = Array.isArray(record.summary)
          ? (record.summary as SummaryTextPart[]).slice()
          : [];
        const part = summary[summaryIndex] ?? {
          type: "summary_text",
          text: "",
        };
        summary[summaryIndex] = {
          ...part,
          text: str(part.text) + str(event.delta),
        };
        return { ...record, summary } as unknown as ORItem;
      });
    }

    case "response.reasoning_summary_text.done": {
      const index = num(event.output_index);
      const summaryIndex = num(event.summary_index);
      return withItem(state, index, (item) => {
        const record = item as unknown as Record<string, unknown>;
        const summary = Array.isArray(record.summary)
          ? (record.summary as SummaryTextPart[]).slice()
          : [];
        const part = summary[summaryIndex] ?? {
          type: "summary_text",
          text: "",
        };
        summary[summaryIndex] = { ...part, text: str(event.text) };
        return { ...record, summary } as unknown as ORItem;
      });
    }

    case "response.reasoning.delta":
    case "response.reasoning_text.delta": {
      const index = num(event.output_index);
      const contentIndex = num(event.content_index);
      return withItem(state, index, (item) => {
        const record = item as unknown as Record<string, unknown>;
        const content = Array.isArray(record.content)
          ? (record.content as ContentPart[]).slice()
          : [];
        const part = content[contentIndex] ?? {
          type: "reasoning_text",
          text: "",
        };
        content[contentIndex] = appendTextToPart(part, str(event.delta));
        return { ...record, content } as unknown as ORItem;
      });
    }

    case "response.reasoning.done":
    case "response.reasoning_text.done": {
      const index = num(event.output_index);
      const contentIndex = num(event.content_index);
      return withItem(state, index, (item) =>
        updatePart(item, contentIndex, (part) => ({
          ...part,
          text: str(event.text),
        })),
      );
    }

    case "response.completed": {
      const response = asRecord(event.response) as ResponseSnapshot;
      return {
        ...state,
        status: "completed",
        responseId: str(response.id) || state.responseId,
        items: Array.isArray(response.output) ? response.output : state.items,
        usage: (response.usage as Record<string, unknown>) ?? state.usage,
      };
    }

    case "response.incomplete": {
      const response = asRecord(event.response) as ResponseSnapshot;
      return {
        ...state,
        status: "incomplete",
        responseId: str(response.id) || state.responseId,
        items: Array.isArray(response.output) ? response.output : state.items,
        usage: (response.usage as Record<string, unknown>) ?? state.usage,
      };
    }

    case "response.failed": {
      const response = asRecord(event.response) as ResponseSnapshot;
      const error = response.error
        ? {
            code: response.error.code,
            message: response.error.message ?? "The agent reported a failure.",
          }
        : state.error;
      return {
        ...state,
        status: "failed",
        responseId: str(response.id) || state.responseId,
        items: Array.isArray(response.output) ? response.output : state.items,
        usage: (response.usage as Record<string, unknown>) ?? state.usage,
        error,
      };
    }

    case "error": {
      const err = asRecord(event.error);
      const message =
        str(event.message) ||
        str(err.message) ||
        "The agent stream reported an error.";
      const code = str(event.code) || str(err.code) || undefined;
      return { ...state, status: "failed", error: { code, message } };
    }

    default:
      return state;
  }
}

/** Marks any still-in-progress items as incomplete (used on cancellation). */
export function finalizePartialItems(items: ORItem[]): ORItem[] {
  return items
    .filter((item): item is ORItem => item !== undefined && item !== null)
    .map((item) => {
      const record = item as unknown as Record<string, unknown>;
      if (record.status === "in_progress") {
        return { ...record, status: "incomplete" } as unknown as ORItem;
      }
      return item;
    });
}

/* ------------------------- platform (Parley) events ---------------------- */

export interface ParleyTurnStarted {
  type: "parley.turn.started";
  turn_id: string;
  conversation_id: string;
  /** The persisted user input items for this turn (with platform ids). */
  user_items: Array<{ id: string; payload: ORItem }>;
}

export interface ParleyConversationUpdated {
  type: "parley.conversation.updated";
  conversation_id: string;
  title: string;
}

export interface ParleyTurnFinished {
  type: "parley.turn.finished";
  turn_id: string;
  status: TurnStatus;
  /** Finalized agent output after platform transformations. */
  items: ORItem[];
  usage?: Record<string, unknown> | null;
  error?: { code?: string; message: string } | null;
}

export type ParleyEvent =
  | ParleyTurnStarted
  | ParleyConversationUpdated
  | ParleyTurnFinished;
