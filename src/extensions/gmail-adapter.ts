import {
	GMAIL_MESSAGE_LIMITS,
	GMAIL_THREAD_LIMITS,
	GMAIL_UNTRUSTED_NOTICE,
	type GmailMessageLimits,
	type GmailThreadLimits,
	gmailMessageText,
	gmailThreadText,
	normalizeGmailMessage,
	normalizeGmailMessageList,
	normalizeGmailThread,
} from "./gmail-content";

/**
 * The seam between Gmail's handlers (./gmail.ts) and whatever reads Gmail's
 * messages: `GmailContent`. The handlers fetch from Gmail, within their
 * bounds on bytes, which limit memory and parsing; an adapter turns Gmail's
 * JSON into what the model reads, within its own bounds on the work and
 * the text.
 *
 * Gmail uses `mimeGmailContent` below, over the MIME normalizer in
 * ./gmail-content.ts: plain text before HTML, HTML reduced to text,
 * attachments listed but never fetched, and limits on depth, parts, decoded
 * bytes and characters. Tests pass `gmailApp` an adapter of their own.
 */

/** A message, as a search lists it. */
export type GmailRef = { readonly id: string; readonly threadId: string | null };

/** A search result's line: the headers worth showing, and Gmail's preview. */
export type GmailSummary = GmailRef & {
	readonly from: string;
	readonly subject: string;
	/** When Gmail received it, ISO 8601; null when Gmail didn't say. */
	readonly date: string | null;
	readonly snippet: string;
};

export type GmailContent = {
	/** The Gmail format `get_message` and `get_thread` fetch: `full` to read bodies, `metadata` for headers only. */
	readonly format: "full" | "metadata";
	/** `users.messages.list`'s answer: at most `max` messages, and the token for the next page. */
	list(json: unknown, max: number): { readonly messages: readonly GmailRef[]; readonly nextPageToken: string | null };
	/** A message fetched in `metadata` format, for a search result. Throws when it isn't a message. */
	summary(json: unknown): GmailSummary;
	/** A message fetched in `format` (or `metadata`, when it was too large), as text for the model, fenced as untrusted. */
	messageText(json: unknown): string;
	/** A thread fetched in `format` (or `metadata`), as text for the model, fenced as untrusted. */
	threadText(json: unknown): string;
};

/** `lines` between fences the mail inside can't know ahead of time, introduced as untrusted. */
export function fenced(what: string, lines: readonly string[]): string {
	const mark = crypto.randomUUID().slice(0, 8);
	return [`${GMAIL_UNTRUSTED_NOTICE} The mail is between [${what} ${mark}] and [end of ${what} ${mark}].`, `[${what} ${mark}]`, ...lines, `[end of ${what} ${mark}]`].join("\n");
}

/** One message's limits: the normalizer's, with header values shorter than its default. */
export const MESSAGE_LIMITS: GmailMessageLimits = { ...GMAIL_MESSAGE_LIMITS, maxHeaderChars: 500 };
/**
 * A thread's limits. Its totals bound bodies, parts and attachments, but
 * headers repeat for every message kept, so each value is held shorter:
 * 25 messages of six headers at 200 characters is at most 30,000.
 */
export const THREAD_LIMITS: GmailThreadLimits = { ...GMAIL_THREAD_LIMITS, maxHeaderChars: 200 };
/** A search result reads headers only: no parts, bytes or attachments. */
const SUMMARY_LIMITS: Partial<GmailMessageLimits> = { maxHeaderChars: 300, maxParts: 1, maxDecodedBytes: 0, maxAttachments: 0 };

/** Mail read through the MIME normalizer, fetched in Gmail's `full` format. */
export const mimeGmailContent: GmailContent = {
	format: "full",
	list(json, max) {
		const { messages, nextPageToken } = normalizeGmailMessageList(json, max);
		return { messages, nextPageToken };
	},
	summary(json) {
		const message = normalizeGmailMessage(json, SUMMARY_LIMITS);
		return {
			id: message.id,
			threadId: message.threadId,
			from: message.headers.from ?? "",
			subject: message.headers.subject ?? "",
			date: message.internalDate,
			snippet: message.snippet,
		};
	},
	messageText(json) {
		return gmailMessageText(normalizeGmailMessage(json, MESSAGE_LIMITS));
	},
	threadText(json) {
		return gmailThreadText(normalizeGmailThread(json, THREAD_LIMITS));
	},
};
