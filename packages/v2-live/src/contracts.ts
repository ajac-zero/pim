/**
 * What this package shares with the runtime outbox it reads and the clients it serves.
 *
 * The outbox shapes are this workstream's assumption of what `v2-runtime` and Forge commit; they are kept
 * in one place so aligning with `@pim/v2-contracts` is a change to this file.
 */
import type { EntryRecord } from "@earendil-works/pi-durable";
import type { JsonValue } from "@earendil-works/pi-ai";
import type { TranscriptMessage } from "@pim/shared/transcript";

/** One event a runtime or Forge commit announced. Projecting it is the only thing done with it. */
export type OutboxEvent =
	/** A message committed to a chat or coding thread; `partial` while it is still streaming (the final commit replaces it). */
	| { kind: "chat.entry"; stream?: "chat" | "coding"; chatId: string; entry: EntryRecord; partial?: boolean }
	/** What the sidebar shows of a chat: a merge into its summary. */
	| { kind: "chat.meta"; chatId: string; title?: string | null; busy?: boolean; unread?: boolean; stalled?: boolean; updatedAt?: number; summary?: Record<string, JsonValue> }
	/** The state a person gave an interactive block (`ui` blocks), keyed by the message that holds it. */
	| { kind: "chat.ui_state"; chatId: string; entryId: string; block: string; state: JsonValue }
	| { kind: "coding.thread"; threadId: string; title?: string | null; harness?: string; state?: string; running?: boolean; unread?: boolean; updatedAt?: number; summary?: Record<string, JsonValue> };

/** A row of `runtime_outbox`: one commit of one partition. Commit sequences increase but may have gaps. */
export type OutboxCommit = {
	partitionId: string;
	commitSeq: number;
	tenantId: string;
	events: OutboxEvent[];
	createdAt: Date;
};

/** A row of `live_event_log`, as a client replays it. */
export type LiveEvent = {
	streamKey: string;
	seq: number;
	commitSeq: number;
	kind: string;
	replaceableKey: string | null;
	payload: JsonValue;
};

/** What `chat:<id>` events carry: the projected message, as `projectEntries` shows it. */
export type MessagePayload = { message: TranscriptMessage; partial: boolean };

export const SIDEBAR_STREAM = "sidebar";
export const chatStream = (chatId: string) => `chat:${chatId}`;
export const codingStream = (threadId: string) => `coding:${threadId}`;

/** What Pulse carries: a hint that a stream has a new event, with the event itself when it is small. */
export type PulseHint = { tenantId: string; streamKey: string; seq: number; event?: LiveEvent };

/** The messages of the Live WebSocket protocol. */
export type ClientFrame =
	| { type: "subscribe"; stream: string; cursor: number | null }
	| { type: "unsubscribe"; stream: string }
	| { type: "ping"; id?: string };

export type ServerFrame =
	| { type: "hello"; connectionId: string; heartbeatMs: number }
	| { type: "subscribed"; stream: string; cursor: number; head: number }
	/** `coalesced`: replaceable progress between the previous frame of this stream and this one was skipped for a slow reader. */
	| { type: "event"; stream: string; seq: number; commitSeq: number; kind: string; replaceableKey: string | null; payload: JsonValue; coalesced?: true }
	/** The cursor cannot be served from the log: fetch an HTTP snapshot and subscribe again with its `liveCursor`. */
	| { type: "snapshot_required"; stream: string; head: number; reason: "cursor_ahead" | "cursor_expired" | "replay_window" | "slow_client" | "log_pruned" }
	| { type: "unsubscribed"; stream: string; reason?: string }
	| { type: "pong"; id?: string }
	| { type: "error"; stream?: string; message: string };

/** Close codes. 4003 is the unauthorized close; the web app wipes its cache on it. */
export const CLOSE_UNAUTHORIZED = 4003;
export const CLOSE_SLOW = 4009;
