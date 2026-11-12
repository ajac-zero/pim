import type { TranscriptMessage } from "../transcript";
import { redact } from "./tools/output";

/**
 * A coding thread's transcript as an agent reads it (../extensions/coding.ts):
 * the page `coding_transcript` cuts out of it, and the whole of one message
 * `coding_transcript_output` reads back. Everything these return is redacted,
 * as the thread's own tools' output is (./tools/output.ts): a transcript can
 * hold anything a command printed, and it leaves the thread's workspace to
 * reach an agent's chat.
 */

/** How many messages a page shows by default, and the most it may. */
export const TRANSCRIPT_PAGE = 20;
export const TRANSCRIPT_MAX_PAGE = 50;
/** How much of one message a page shows, and of the first line of it in a summary. */
export const MESSAGE_CHARS = 400;
export const SUMMARY_CHARS = 80;
/** How many lines of one message `coding_transcript_output` shows at once, and the most a line of it may hold. */
export const OUTPUT_LINES = 2_000;
export const OUTPUT_LINE_CHARS = 2_000;
/** How much of one message `coding_transcript_output` shows at once. */
export const OUTPUT_CHARS = 30_000;

/** A message as a page shows it: its id, for reading it whole, and text cut to what fits. */
export type PagedTranscriptMessage = {
	readonly id: string;
	readonly role: TranscriptMessage["role"];
	readonly text: string;
};

/** A page of a transcript: what it shows, how many messages there are in all, and where the next page starts when there is one. */
export type PagedTranscript = {
	readonly messages: readonly PagedTranscriptMessage[];
	readonly total: number;
	readonly next_offset?: number;
};

/** One message's whole text: what the person or the agent said, a tool call as its name and arguments, a tool result as what it printed. */
export function transcriptText(message: TranscriptMessage): string {
	const parts: string[] = [];
	for (const part of message.parts) {
		switch (part.type) {
			case "text":
				parts.push(part.text);
				break;
			case "thinking":
				parts.push(`[Thinking] ${part.text}`);
				break;
			case "tool-call":
				parts.push(`${part.name}(${JSON.stringify(part.arguments)})`);
				break;
			case "tool-result":
				parts.push(part.content.map((piece) => (piece.type === "text" ? piece.text : "[image]")).join("\n"));
				break;
			case "image":
				parts.push("[image]");
				break;
		}
	}
	return parts.join("\n\n").trim();
}

/** `text` cut to `max` characters, with a note of what was left out when something was. */
function cut(text: string, max: number): string {
	if (text.length <= max) return text;
	return `${text.slice(0, max)}… [${text.length - max} more characters, coding_transcript_output reads the whole message]`;
}

/**
 * The page of a transcript the model reads: `offset` messages in (the oldest
 * first), at most `limit` of them, of one `role` only when asked, each cut to
 * what fits. In a summary each message is its first line, cut short, so the
 * page shows the shape of the conversation.
 */
export function pageTranscript(messages: readonly TranscriptMessage[], want: { offset?: number; limit?: number; role?: TranscriptMessage["role"]; summary?: boolean } = {}): PagedTranscript {
	const ofRole = want.role === undefined ? messages : messages.filter((message) => message.role === want.role);
	const offset = Math.max(0, want.offset ?? 0);
	const limit = Math.min(TRANSCRIPT_MAX_PAGE, Math.max(1, want.limit ?? TRANSCRIPT_PAGE));
	const page = ofRole.slice(offset, offset + limit);
	const shown = page.map((message) => {
		const full = redact(transcriptText(message));
		const text = want.summary ? full.split("\n")[0]!.trim() : full;
		return { id: message.id, role: message.role, text: cut(text, want.summary ? SUMMARY_CHARS : MESSAGE_CHARS) };
	});
	return {
		messages: shown,
		total: ofRole.length,
		...(offset + page.length < ofRole.length ? { next_offset: offset + page.length } : {}),
	};
}

/**
 * One message's whole text, redacted and paged by lines as read pages a
 * file: up to `limit` lines from `offset` (line 1 by default), with a note of
 * how to read on when there is more. Null when `id` names no message.
 */
export function transcriptOutput(messages: readonly TranscriptMessage[], id: string, want: { offset?: number; limit?: number } = {}): string | null {
	const message = messages.find((candidate) => candidate.id === id);
	if (message === undefined) return null;
	const text = redact(transcriptText(message));
	if (text === "") return "(nothing in that message)";
	const lines = text.split("\n");
	const start = Math.min(Math.max(1, want.offset ?? 1), lines.length);
	const limit = Math.min(OUTPUT_LINES, Math.max(1, want.limit ?? OUTPUT_LINES));
	const kept: string[] = [];
	let bytes = 0;
	for (const line of lines.slice(start - 1, start - 1 + limit)) {
		const shown = line.length > OUTPUT_LINE_CHARS ? `${line.slice(0, OUTPUT_LINE_CHARS)}… [line cut at ${OUTPUT_LINE_CHARS} characters]` : line;
		bytes += new TextEncoder().encode(shown).byteLength + 1;
		if (bytes > OUTPUT_CHARS && kept.length > 0) break;
		kept.push(shown);
	}
	const end = start + kept.length - 1;
	const rest = end < lines.length ? `\n\n[Lines ${start}-${end} of ${lines.length}. Use offset=${end + 1} to read on.]` : "";
	return `${kept.join("\n")}${rest}`;
}
