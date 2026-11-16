/**
 * What the summary a chat is carried on with is made from: the prompt pi-durable's own compaction uses,
 * and the conversation written out as the text it summarizes.
 */
import type { Message } from "@earendil-works/pi-ai";
import { SUMMARY_PREFIX, SUMMARY_SUFFIX } from "@pim/shared/transcript";

// It opens as pi's compaction prompt does, which is how a call to summarize is told apart as background work (`callTags`).
export const SUMMARIZATION_SYSTEM_PROMPT = `You are a context summarization assistant. Your task is to read a conversation between a user and an AI assistant, then produce a structured summary following the exact format specified.

Do NOT continue the conversation. Do NOT respond to any questions in the conversation. ONLY output the structured summary.`;

const SUMMARIZATION_PROMPT = `The messages above are a conversation to summarize. Create a structured context checkpoint summary that another LLM will use to continue the work. If the conversation starts with an earlier summary, preserve its information and fold the newer messages into it.

Use this EXACT format:

## Goal
[What is the user trying to accomplish? Can be multiple items if the session covers different tasks.]

## Constraints & Preferences
- [Any constraints, preferences, or requirements mentioned by user]
- [Or "(none)" if none were mentioned]

## Progress
### Done
- [x] [Completed tasks/changes]

### In Progress
- [ ] [Current work]

### Blocked
- [Issues preventing progress, if any]

## Key Decisions
- **[Decision]**: [Brief rationale]

## Next Steps
1. [Ordered list of what should happen next]

## Critical Context
- [Any data, examples, or references needed to continue]
- [Or "(none)" if not applicable]

Keep each section concise. Preserve exact file paths, function names, and error messages.`;

const TOOL_RESULT_MAX_CHARS = 2_000;

const contentText = (content: string | readonly { type: string; text?: string }[]): string =>
	typeof content === "string" ? content : content.flatMap((part) => (part.type === "text" && part.text !== undefined ? [part.text] : [])).join("\n");

/** The messages as a transcript the summarizer reads instead of continuing it. */
export function serializeMessages(messages: readonly Message[]): string {
	const parts: string[] = [];
	for (const message of messages) {
		if (message.role === "user") {
			const text = contentText(message.content);
			if (text !== "") parts.push(`[User]: ${text}`);
		} else if (message.role === "assistant") {
			const text = message.content.flatMap((part) => (part.type === "text" ? [part.text] : []));
			const calls = message.content.flatMap((part) =>
				part.type === "toolCall"
					? [
							`${part.name}(${Object.entries(part.arguments)
								.map(([key, value]) => `${key}=${JSON.stringify(value)}`)
								.join(", ")})`,
						]
					: [],
			);
			if (text.length > 0) parts.push(`[Assistant]: ${text.join("\n")}`);
			if (calls.length > 0) parts.push(`[Assistant tool calls]: ${calls.join("; ")}`);
		} else if (message.role === "toolResult") {
			const text = contentText(message.content);
			if (text !== "") parts.push(`[Tool result]: ${text.length > TOOL_RESULT_MAX_CHARS ? `${text.slice(0, TOOL_RESULT_MAX_CHARS)}\n\n[... ${text.length - TOOL_RESULT_MAX_CHARS} more characters truncated]` : text}`);
		}
	}
	return parts.join("\n\n");
}

/** What the summarizer is asked, from a conversation that is cut to its latest `limit` characters when it is longer. */
export function summaryRequest(messages: readonly Message[], limit: number): string {
	const text = serializeMessages(messages);
	const conversation = text.length > limit ? `[... earlier messages left out]\n\n${text.slice(text.length - limit)}` : text;
	return `<conversation>\n${conversation}\n</conversation>\n\n${SUMMARIZATION_PROMPT}`;
}

/** The message a continuation opens with, as pi's own compaction words it. */
export const wrapSummary = (summary: string): string => `${SUMMARY_PREFIX}${summary}${SUMMARY_SUFFIX}`;
