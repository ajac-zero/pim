import type { ImageContent, JsonValue, Message, TextContent } from "@earendil-works/pi-ai";
import { isRetryableAssistantError } from "@earendil-works/pi-ai/utils/retry";
import type { EntryRecord } from "@earendil-works/pi-durable";

/** Private harness continuation, never a message from the person. */
export const DELIVERY_REMINDER = "[Delivery required] Use send_to_user to deliver your answer now. Your ordinary text is private and is not shown to the person. If sending failed, fix the call or explain the problem with a chat message.";

/** What the harness says after an answer was cut off at the output limit, once: a different instruction, since repeating the delivery reminder cannot help a truncated answer. */
export const LENGTH_REMINDER = "[Delivery required] Your previous output was cut off at the output limit, so nothing from it was sent or run. Deliver a much shorter message with send_to_user now, and do not think at length. Put anything long in smaller pieces, such as an app in several app_create calls.";

/** Whether a user-role message is one of the harness's delivery reminders, not something the person said. */
export function isDeliveryReminder(text: string): boolean {
	return text === DELIVERY_REMINDER || text === LENGTH_REMINDER;
}

/** Why a run fails when the agent keeps answering without send_to_user: trying the model again wouldn't help. */
export const NOT_DELIVERED = "The agent did not deliver its reply with send_to_user.";

/**
 * How the error starts when an answer was cut off at the output limit twice in a row: the model ran out of output
 * tokens (reasoning counts) before it finished. Not retried, since another request ends the same way; the rest of the message
 * says the limit it hit, so the person can raise the model's longest answer or pick another model.
 */
export const OUT_OF_OUTPUT_TOKENS = "The model ran out of output tokens before finishing";

/** The error for an answer cut off at `limit` output tokens, with what the person can do. */
export function outOfOutputTokens(limit: number): string {
	const base = `${OUT_OF_OUTPUT_TOKENS}, twice`;
	const advice = "Ask for something smaller, use a model with a longer output limit or less reasoning, or set the model's longest answer in its provider settings.";
	const message = limit > 0 ? `${base} (limit ${limit}). ${advice}` : `${base}. ${advice}`;
	// A number such as 4500 would read as an HTTP status to pi's retry check; fail without it rather than retry.
	return isRetryableAssistantError({ stopReason: "error", errorMessage: message } as Parameters<typeof isRetryableAssistantError>[0]) ? `${base}. ${advice}` : message;
}

/**
 * Whether the agent owes the person a reply, from the transcript a request is about to send: the last real input that is not background work (which may stay silent) and
 * not skipped (`skip`: what others said in a room that was not for this agent), unless a finishing, successful `send_to_user` has answered it since. Also how many delivery
 * and length reminders came after that input.
 */
export function deliveryOwed(messages: readonly Message[], skip: (input: string) => boolean = () => false): { required: boolean; reminders: number; truncations: number } {
	let required = false;
	let reminders = 0;
	let truncations = 0;
	/** Sends that finish a turn, by call: one that went through answered what was owed. */
	const finishing = new Set<string>();
	for (const message of messages) {
		if (message.role === "assistant") {
			for (const part of message.content) {
				if (part.type === "toolCall" && part.name === "send_to_user" && part.arguments?.complete !== false) finishing.add(part.id);
			}
		} else if (message.role === "toolResult") {
			if (finishing.has(message.toolCallId) && !message.isError) required = false;
		} else if (message.role === "user") {
			const input = typeof message.content === "string" ? message.content : message.content.flatMap((part) => part.type === "text" ? [part.text] : []).join("");
			if (input === DELIVERY_REMINDER) {
				reminders++;
				continue;
			}
			if (input === LENGTH_REMINDER) {
				truncations++;
				continue;
			}
			if (skip(input)) continue;
			// Background work may deliberately stay silent.
			required = !/^\[(?:Scheduled task|Approval |Connector event\]|Team:|Chat with |Coding thread [^\]\n]+\] Stalled:)/.test(input);
			reminders = 0;
			truncations = 0;
		}
	}
	return { required, reminders, truncations };
}

/**
 * What an answer to a request that owes the person a reply turns into: pi runs no tool of an answer that stopped on length, so a half-written call never executes, and one
 * shorter try is allowed; a second cut-off ends the run with its own error. After two delivery reminders a plain stop becomes a failure that is not retried, so the person sees
 * it, with Try again, instead of silence. (Hook throws are reported and ignored by pi, hence the answer is changed rather than a throw.)
 */
export function enforceDelivery(answer: { stopReason: string; errorMessage?: string; content: readonly { type: string }[]; usage: { output: number } }, state: { reminders: number; truncations: number }): void {
	if (answer.stopReason === "length") {
		if (state.truncations >= 1) {
			answer.stopReason = "error";
			answer.errorMessage = outOfOutputTokens(answer.usage.output);
		}
		return;
	}
	if (state.reminders < 2) return;
	if (answer.stopReason === "stop" || (answer.stopReason === "toolUse" && !answer.content.some((part) => part.type === "toolCall"))) {
		answer.stopReason = "error";
		answer.errorMessage = NOT_DELIVERED;
	}
}

/** How the message starts that has the majordomo open its first chat by introducing itself (see ../majordomo.ts); apps don't show it. */
export const INTRODUCTION = "[Introduction]";

/** How the messages start that Pim gives an agent itself, not the person: an approval's decision, a scheduled task or a trigger firing, a connector event, tasks' answers. */
export const NOTICE_PREFIXES = [
	[/^\[Approval ([^\]]+)\]\s*/, "approval"],
	[/^\[Scheduled task[^\]]*\]\s*/, "schedule"],
	[/^\[Trigger "[^\n]*" [^\]\s]+\]\s*/, "schedule"],
	[/^\[(?:Connector|App) event\]\s*/, "event"],
	[/^\[Task update\]\s*/, "task"],
	[/^\[Room\]\s*/, "room"],
	[/^\[Coding thread [^\]\n]+\]\s*/, "coding"],
] as const;

/** How a message starts that tells an agent a coding thread it started ended a turn (see ./coding/supervisor.ts). */
export const CODING_EVENT = /^\[Coding thread /;

/** How a message starts that another agent in a group chat said, with its name (see ./rooms.ts). */
export const ROOM_POST = /^\[From ([^\]\n]+)\]\n?/;

/** How the text part starts that Pim puts before the person's message when files the agent saw changed since its last turn (see ./file-changes.ts); the person's own message follows it, and the app shows only that. */
export const FILE_CHANGES = "[Files you changed since your last turn]";

/** The person's message without Pim's block of file changes. */
export function withoutFileChanges<T extends string | readonly (TextContent | ImageContent)[]>(content: T): T {
	if (typeof content === "string") return content;
	return (content as readonly (TextContent | ImageContent)[]).filter((part) => !(part.type === "text" && part.text.startsWith(FILE_CHANGES))) as unknown as T;
}

/** Whether a user-role message's text is the person's own, rather than something Pim or another agent gave the agent. */
export function fromPerson(text: string): boolean {
	if (isDeliveryReminder(text) || text.startsWith(INTRODUCTION) || ROOM_POST.test(text)) return false;
	return NOTICE_PREFIXES.every(([prefix]) => !prefix.test(text));
}

/**
 * The headings of a model's summarized reasoning, in order. OpenAI's models
 * summarize theirs as sections that each start with a bold line, such as
 * "**Comparing flight prices**"; raw reasoning from other models has none.
 */
export function reasoningHeadings(thinking: string): string[] {
	return [...thinking.matchAll(/^\*\*([^*\n]+)\*\*[ \t]*$/gm)].map((match) => match[1]!.trim()).filter((heading) => heading !== "");
}

/**
 * A display-ready transcript message, projected from pi's entries for the
 * REST API. Streaming clients receive pi's own agent events instead and fold
 * them the same way.
 */
export type MessagePart =
	| TextContent
	| ImageContent
	| { readonly type: "thinking"; readonly text: string }
	| { readonly type: "tool-call"; readonly id: string; readonly name: string; readonly arguments: JsonValue }
	| {
			readonly type: "tool-result";
			readonly id: string;
			readonly name: string;
			readonly content: readonly (TextContent | ImageContent)[];
			readonly error: boolean;
	  };

export type TranscriptMessage = {
	/** The pi entry id. */
	readonly id: string;
	readonly role: "user" | "assistant" | "tool" | "notice";
	readonly parts: readonly MessagePart[];
	readonly timestamp: number;
	readonly stopReason?: string;
	readonly error?: string;
	/** A notice that is the summary of what the chat said before it was compacted. */
	readonly compaction?: true;
};

/** What pi puts before a compaction's summary and after it, in the message that carries it. */
export const SUMMARY_PREFIX = "The conversation history before this point was compacted into the following summary:\n\n<summary>\n";
export const SUMMARY_SUFFIX = "\n</summary>";

/** The summary a compaction entry's message holds, without the words pi wraps it in. */
export function compactionSummaryText(text: string): string {
	const trimmed = text.trim();
	if (!trimmed.startsWith(SUMMARY_PREFIX.trim()) || !trimmed.endsWith(SUMMARY_SUFFIX.trim())) return trimmed;
	return trimmed.slice(SUMMARY_PREFIX.trim().length, trimmed.length - SUMMARY_SUFFIX.trim().length).trim();
}

/** The text of the message a compaction entry carries. */
export function compactionText(message: Message | undefined): string {
	if (message?.role !== "user") return "";
	const text = typeof message.content === "string" ? message.content : message.content.flatMap((part) => (part.type === "text" ? [part.text] : [])).join("\n");
	return compactionSummaryText(text);
}

function projectMessage(message: Message, id: string): TranscriptMessage | undefined {
	switch (message.role) {
		case "user":
			return {
				id,
				role: "user",
				parts: typeof message.content === "string" ? [{ type: "text", text: message.content }] : withoutFileChanges(message.content),
				timestamp: message.timestamp,
			};
		case "assistant":
			// An answer that stopped with nothing in it (a lone newline, an empty thinking block, as a model leaves after `send_to_user`) says nothing, so it is not shown.
			if (message.stopReason === "stop" && message.content.every((part) => (part.type === "text" ? part.text.trim() === "" : part.type === "thinking" && part.thinking.trim() === ""))) return undefined;
			return {
				id,
				role: "assistant",
				parts: message.content.map((part): MessagePart => {
					switch (part.type) {
						case "text":
							return { type: "text", text: part.text };
						case "thinking":
							return { type: "thinking", text: part.thinking };
						case "toolCall":
							return { type: "tool-call", id: part.id, name: part.name, arguments: part.arguments as JsonValue };
					}
				}),
				timestamp: message.timestamp,
				stopReason: message.stopReason,
				...(message.errorMessage === undefined ? {} : { error: message.errorMessage }),
			};
		case "toolResult":
			return {
				id,
				role: "tool",
				parts: [
					{
						type: "tool-result",
						id: message.toolCallId,
						name: message.toolName,
						content: message.content,
						error: message.isError,
					},
				],
				timestamp: message.timestamp,
			};
		default:
			// System prompt changes are bookkeeping, not conversation.
			return undefined;
	}
}

/**
 * The entry a fork of a transcript ends at, by a message's entry id: an
 * agent's message with the results of the tools it called, so the fork asks
 * nothing left unanswered, or, `before` a person's message, the entry just
 * before it, so it can be sent again changed. Null when nothing comes before
 * that message, and undefined when `id` names no such message.
 */
export function forkPoint(entries: readonly EntryRecord[], id: string, before: boolean): EntryRecord | null | undefined {
	const index = entries.findIndex((entry) => String(entry.id) === id);
	const message = entries[index]?.model?.[0];
	if (before) return message?.role === "user" ? (entries[index - 1] ?? null) : undefined;
	if (message?.role !== "assistant") return undefined;
	const calls = new Set(message.content.flatMap((part) => (part.type === "toolCall" ? [part.id] : [])));
	let end = index;
	while (calls.size > 0) {
		const result = entries[end + 1]?.model?.[0];
		if (result?.role !== "toolResult" || !calls.delete(result.toolCallId)) break;
		end++;
	}
	return entries[end];
}

export function projectEntries(entries: readonly EntryRecord[]): TranscriptMessage[] {
	return entries.flatMap((entry) => {
		if (entry.kind === "pi.reset") {
			return [{ id: String(entry.id), role: "notice" as const, parts: [{ type: "text" as const, text: "Context reset" }], timestamp: 0 }];
		}
		if (entry.kind === "pi.compaction") {
			return [{ id: String(entry.id), role: "notice" as const, parts: [{ type: "text" as const, text: compactionText(entry.model?.[0]) }], timestamp: entry.model?.[0]?.timestamp ?? 0, compaction: true as const }];
		}
		const message = entry.model?.[0];
		if (entry.kind === "pi.system" || message === undefined) return [];
		const projected = projectMessage(message, String(entry.id));
		return projected ? [projected] : [];
	});
}
