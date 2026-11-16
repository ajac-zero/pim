/**
 * What this package shares with the runtime outbox it reads and the clients it serves. The frames, cursors,
 * Pulse subjects and the outbox event are `@pim/v2-contracts`'; this file adds only what that package leaves to
 * Live: the vocabulary of `eventKind`s Live projects, and topic names.
 */
import type { JsonValue } from "@earendil-works/pi-ai";
import type { EntryRecord } from "@earendil-works/pi-durable";
import type { OwnerId } from "@pim/v2-contracts/identity";
import { type ProjectionCursor, pulseSubjects } from "@pim/v2-contracts/live-seam";

export { type Authorizer, ForbiddenError } from "@pim/v2-contracts/authz";
export { type OwnerId, type Principal } from "@pim/v2-contracts/identity";
export { type ClientFrame, type ProjectionCursor, type PulseHint, type ServerFrame, compareCursors, parseCursor, serializeCursor } from "@pim/v2-contracts/live-seam";
export type { RuntimeOutboxEvent } from "@pim/v2-contracts/runtime-seam";

/** `eventKind`s of a `RuntimeOutboxEvent` that Live projects, and their `payload`s. Other kinds are skipped. */
export type OutboxPayloads = {
	/** A message committed to a chat or coding thread (`publicChatId`, or `payload.threadId` for coding); `partial` while it streams. The final commit replaces the partial. */
	"chat.entry": { entry: EntryRecord; partial?: boolean; stream?: "chat" | "coding"; threadId?: string; /** Where the message sorts, when its entry id does not say (a streaming partial has no entry yet). */ position?: number; /** The id of the partial message this one replaces, which is dropped from the transcript. */ replaces?: string };
	/** What the sidebar shows of a chat: a merge into its summary. */
	"chat.meta": { title?: string | null; busy?: boolean; unread?: boolean; stalled?: boolean; updatedAt?: number; summary?: Record<string, JsonValue> };
	/** The state a person gave an interactive `ui` block, keyed by the message that holds it. */
	"chat.ui_state": { entryId: string; block: string; state: JsonValue };
	"coding.thread": { threadId: string; title?: string | null; harness?: string; state?: string; running?: boolean; unread?: boolean; updatedAt?: number; summary?: Record<string, JsonValue> };
};
export const PROJECTED_KINDS: readonly string[] = ["chat.entry", "chat.meta", "chat.ui_state", "coding.thread"];

/** A topic of the Live WebSocket: `sidebar`, `chat:<public chat id>` or `coding:<thread id>`. Ids are restricted so a topic can't carry a NATS wildcard or separator. */
export const SIDEBAR_TOPIC = "sidebar";
export const chatTopic = (chatId: string) => `chat:${chatId}`;
export const codingTopic = (threadId: string) => `coding:${threadId}`;
const TOPIC = /^(?:(sidebar)|(chat|coding):([A-Za-z0-9_-]{1,64}))$/;

export function parseTopic(topic: string): { kind: "sidebar" | "chat" | "coding"; id: string | null } | null {
	const match = TOPIC.exec(topic);
	if (!match) return null;
	return match[1] ? { kind: "sidebar", id: null } : { kind: match[2] as "chat" | "coding", id: match[3]! };
}

/** The NATS subject of a topic: the canonical `pulseSubjects`. */
export function subjectOf(ownerId: OwnerId, topic: string): string {
	const parsed = parseTopic(topic);
	if (!parsed) throw new Error(`Not a topic: ${topic}`);
	return parsed.kind === "sidebar" ? pulseSubjects.sidebar(ownerId) : parsed.kind === "chat" ? pulseSubjects.chat(ownerId, parsed.id!) : pulseSubjects.coding(ownerId, parsed.id!);
}

/** A row of `live_event_log`, as a client replays it. `seq` is Live's private dense counter; clients see `cursor`. */
export type LiveEvent = {
	topic: string;
	seq: number;
	cursor: ProjectionCursor;
	kind: string;
	replaceableKey: string | null;
	data: JsonValue;
};

export const CLOSE_UNAUTHORIZED = 4003;
export const CLOSE_SLOW = 4009;
