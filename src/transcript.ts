import type { ImageContent, JsonValue, Message, TextContent } from "@earendil-works/pi-ai";
import type { EntryRecord } from "@earendil-works/pi-durable";

/** Private harness continuation, never a message from the person. */
export const DELIVERY_REMINDER = "[Delivery required] Use send_to_user to deliver your answer now. Your ordinary text is private and is not shown to the person. If sending failed, fix the call or explain the problem with a chat message.";

/** How the message starts that has the majordomo open its first chat by introducing itself (see ../majordomo.ts); apps don't show it. */
export const INTRODUCTION = "[Introduction]";

/** How the messages start that Pim gives an agent itself, not the person: an approval's decision, a scheduled task, a connector event, tasks' answers. */
export const NOTICE_PREFIXES = [
	[/^\[Approval ([^\]]+)\]\s*/, "approval"],
	[/^\[Scheduled task[^\]]*\]\s*/, "schedule"],
	[/^\[(?:Connector|App) event\]\s*/, "event"],
	[/^\[Task update\]\s*/, "task"],
	[/^\[Room\]\s*/, "room"],
] as const;

/** How a message starts that another agent in a group chat said, with its name (see ./rooms.ts). */
export const ROOM_POST = /^\[From ([^\]\n]+)\]\n?/;

/** Whether a user-role message's text is the person's own, rather than something Pim or another agent gave the agent. */
export function fromPerson(text: string): boolean {
	if (text === DELIVERY_REMINDER || text.startsWith(INTRODUCTION) || ROOM_POST.test(text)) return false;
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
};

function projectMessage(message: Message, id: string): TranscriptMessage | undefined {
	switch (message.role) {
		case "user":
			return {
				id,
				role: "user",
				parts: typeof message.content === "string" ? [{ type: "text", text: message.content }] : message.content,
				timestamp: message.timestamp,
			};
		case "assistant":
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
		const message = entry.model?.[0];
		if (entry.kind === "pi.system" || message === undefined) return [];
		const projected = projectMessage(message, String(entry.id));
		return projected ? [projected] : [];
	});
}
