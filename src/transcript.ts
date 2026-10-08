import type { ImageContent, JsonValue, Message, TextContent } from "@earendil-works/pi-ai";
import type { EntryRecord } from "@earendil-works/pi-durable";

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
