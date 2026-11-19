import { Type } from "typebox";
import { fenced, type GmailContent, type GmailSummary, mimeGmailContent } from "./gmail-adapter.ts";
import { GOOGLE_AUTHORIZE_PARAMS, GOOGLE_SCOPES, GoogleApiError, GoogleTooLarge, googleCheck, googleJson } from "./google.ts";
import type { NativeApp, NativeTool, ToolContext } from "./native.ts";

/**
 * Gmail, read-only (the `gmail.readonly` scope): search the person's mail, and read a message or a thread. Nothing here sends, drafts, labels, moves or deletes mail, or downloads an
 * attachment. The handlers talk to Gmail within bounds on what they ask for and how much of the answer they read; a `GmailContent` adapter turns the answers into what the model
 * reads, within the MIME normalizer's own bounds on the work and the text (`gmail-content.ts`).
 */

/** How many results one search returns, at most. */
export const GMAIL_MAX_RESULTS = 20;
/** The most bytes of Gmail's answer read: a list, a search result's headers, a message, a thread. */
export const GMAIL_LIST_BYTES = 256 * 1024;
export const GMAIL_MESSAGE_BYTES = 8 * 1024 * 1024;
export const GMAIL_THREAD_BYTES = 16 * 1024 * 1024;
/** How many messages a search reads the headers of at once. */
const CONCURRENCY = 5;

const ID = /^[A-Za-z0-9_-]{1,256}$/;

/** A message or thread ID as a path segment, checked here as well as by the tool's schema. */
function segment(id: string, what: string): string {
	if (!ID.test(id)) throw new Error(`${id.slice(0, 40)} isn't a Gmail ${what} ID.`);
	return encodeURIComponent(id);
}

/** A message or thread Gmail doesn't have, said plainly. */
function missing(error: unknown, what: string): never {
	if (error instanceof GoogleApiError && (error.status === 404 || error.status === 400)) throw new Error(`Gmail has no ${what}.`);
	throw error;
}

const TOO_LARGE = "[Gmail's copy of this is too large for Pim to read whole: only its headers are shown.]";

/** The Gmail connector, reading mail through `content`. */
export function makeGmail(content: GmailContent): NativeApp {
	const api = (c: ToolContext) => c.endpoints.gmailApi;
	/** A message or thread in the adapter's format; one too large for that, in `metadata`, said so. */
	async function fetchFor(c: ToolContext, path: string, maxBytes: number): Promise<{ json: unknown; whole: boolean }> {
		const get = (format: string, bytes: number) => googleJson(c, api(c), `${api(c)}/${path}`, { query: { format }, maxBytes: bytes });
		if (content.format === "metadata") return { json: await get("metadata", GMAIL_LIST_BYTES * 4), whole: true };
		try {
			return { json: await get("full", maxBytes), whole: true };
		} catch (error) {
			if (!(error instanceof GoogleTooLarge)) throw error;
			return { json: await get("metadata", GMAIL_LIST_BYTES * 4), whole: false };
		}
	}

	const search: NativeTool = {
		name: "search",
		description: `Search the person's Gmail as Gmail's search box does (from:, to:, subject:, after:2025/01/31, before:, has:attachment, label:, is:unread, newer_than:7d…). Answers up to ${GMAIL_MAX_RESULTS} messages, newest first, with their IDs for get_message and get_thread, and a page token for more. Spam and trash are left out.`,
		parameters: Type.Object({ query: Type.String({ minLength: 1, maxLength: 500 }), maxResults: Type.Optional(Type.Integer({ minimum: 1, maximum: GMAIL_MAX_RESULTS })), pageToken: Type.Optional(Type.String({ pattern: ID.source })) }),
		readOnly: true,
		async execute({ query, maxResults, pageToken }, c) {
			const limit = Math.min(Math.max(1, maxResults ?? 10), GMAIL_MAX_RESULTS);
			if (pageToken !== undefined && !ID.test(pageToken)) throw new Error("That isn't a page token from search.");
			const list = content.list(await googleJson(c, api(c), `${api(c)}/messages`, { query: { q: String(query).slice(0, 500), maxResults: limit, pageToken, includeSpamTrash: false }, maxBytes: GMAIL_LIST_BYTES }), limit);
			if (list.messages.length === 0) return `No messages match "${query}".`;
			const found: GmailSummary[] = new Array(list.messages.length);
			let next = 0;
			const worker = async () => {
				while (next < list.messages.length) {
					const index = next++;
					const raw = await googleJson(c, api(c), `${api(c)}/messages/${segment(list.messages[index]!.id, "message")}`, { query: { format: "metadata", metadataHeaders: ["From", "To", "Subject", "Date"] }, maxBytes: GMAIL_LIST_BYTES });
					found[index] = content.summary(raw);
				}
			};
			await Promise.all(Array.from({ length: Math.min(CONCURRENCY, list.messages.length) }, worker));
			const lines = found.flatMap((message) => [`- Message ${message.id} (thread ${message.threadId ?? "?"})`, `  ${message.date ?? ""} · From: ${message.from || "?"} · Subject: ${message.subject || "(none)"}`, ...(message.snippet ? [`  ${message.snippet}`] : [])]);
			return [fenced("results", lines), list.nextPageToken ? `More results: search again with pageToken ${list.nextPageToken}.` : "No more results."].join("\n");
		},
	};

	const getMessage: NativeTool = {
		name: "get_message",
		description: "Read one message, by its ID from search: its headers and what Pim can read of it. Attachments aren't downloaded.",
		parameters: Type.Object({ id: Type.String({ pattern: ID.source }) }),
		readOnly: true,
		async execute({ id }, c) {
			const { json, whole } = await fetchFor(c, `messages/${segment(id, "message")}`, GMAIL_MESSAGE_BYTES).catch((error) => missing(error, `message ${id}`));
			const text = content.messageText(json);
			return whole ? text : `${text}\n${TOO_LARGE}`;
		},
	};

	const getThread: NativeTool = {
		name: "get_thread",
		description: "Read a conversation, by its thread ID from search: its most recent messages, oldest first. Attachments aren't downloaded.",
		parameters: Type.Object({ id: Type.String({ pattern: ID.source }) }),
		readOnly: true,
		async execute({ id }, c) {
			const { json, whole } = await fetchFor(c, `threads/${segment(id, "thread")}`, GMAIL_THREAD_BYTES).catch((error) => missing(error, `thread ${id}`));
			const text = content.threadText(json);
			return whole ? text : `${text}\n${TOO_LARGE}`;
		},
	};

	return {
		ref: "google/gmail",
		name: "Gmail",
		description: "Searches and reads your mail. Never sends, changes or deletes it.",
		category: "productivity",
		client: { id: "GOOGLE_GMAIL_CLIENT_ID", secret: "GOOGLE_GMAIL_CLIENT_SECRET" },
		scopes: [GOOGLE_SCOPES.gmailReadonly],
		authorizeUrl: (e) => e.googleAuth,
		tokenUrl: (e) => e.googleToken,
		revokeUrl: (e) => e.googleRevoke,
		authorizeParams: GOOGLE_AUTHORIZE_PARAMS,
		check: googleCheck("Gmail", [GOOGLE_SCOPES.gmailReadonly]),
		tools: [search, getMessage, getThread],
	};
}

export const gmailApp = makeGmail(mimeGmailContent);
