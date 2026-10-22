import { Type } from "@earendil-works/pi-ai";
import { type AppToolContext, defineAppTool, type NativeAppDefinition } from "./define";
import { fenced, type GmailContent, type GmailSummary, mimeGmailContent } from "./gmail-adapter";
import { GOOGLE_SCOPES, GoogleApiError, googleApp, googleJson, GoogleTooLarge } from "./google";

/**
 * Gmail, read-only (the `gmail.readonly` scope): search the person's mail,
 * and read a message or a thread. Nothing here sends, drafts, labels,
 * moves or deletes mail, or downloads an attachment.
 *
 * These handlers talk to Gmail, within bounds on what they ask for and how
 * much of Gmail's answer they read (which bounds memory and parsing); a
 * `GmailContent` adapter (./gmail-adapter.ts) turns the answers into what
 * the model reads, within the MIME normalizer's own bounds on the work and
 * the text (./gmail-content.ts).
 *
 * Its secrets: an OAuth client in a Google Cloud project of its own
 * (`GOOGLE_GMAIL_CLIENT_ID`, `GOOGLE_GMAIL_CLIENT_SECRET`).
 */

const API = "https://gmail.googleapis.com/gmail/v1/users/me";

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

/** The Gmail app, reading mail through `content`. */
export function gmailApp(content: GmailContent): NativeAppDefinition {
	/** A message or thread in the adapter's format; one too large for that, in `metadata`, said so. */
	async function fetchFor(context: AppToolContext, path: string, maxBytes: number): Promise<{ json: unknown; whole: boolean }> {
		const get = (format: string, bytes: number) => googleJson(context, `${API}/${path}`, { query: { format }, maxBytes: bytes });
		if (content.format === "metadata") return { json: await get("metadata", GMAIL_LIST_BYTES * 4), whole: true };
		try {
			return { json: await get("full", maxBytes), whole: true };
		} catch (error) {
			if (!(error instanceof GoogleTooLarge)) throw error;
			return { json: await get("metadata", GMAIL_LIST_BYTES * 4), whole: false };
		}
	}

	const search = defineAppTool({
		name: "search",
		description: `Search the person's Gmail as Gmail's search box does (from:, to:, subject:, after:2025/01/31, before:, has:attachment, label:, is:unread, newer_than:7d…). Answers up to ${GMAIL_MAX_RESULTS} messages, newest first, with their IDs for get_message and get_thread, and a page token for more. Spam and trash are left out.`,
		parameters: Type.Object({
			query: Type.String({ minLength: 1, maxLength: 500 }),
			maxResults: Type.Optional(Type.Integer({ minimum: 1, maximum: GMAIL_MAX_RESULTS })),
			pageToken: Type.Optional(Type.String({ pattern: ID.source })),
		}),
		readOnly: true,
		async execute({ query, maxResults, pageToken }, context) {
			const limit = Math.min(Math.max(1, maxResults ?? 10), GMAIL_MAX_RESULTS);
			if (pageToken !== undefined && !ID.test(pageToken)) throw new Error("That isn't a page token from search.");
			const list = content.list(
				await googleJson(context, `${API}/messages`, { query: { q: query.slice(0, 500), maxResults: limit, pageToken, includeSpamTrash: false }, maxBytes: GMAIL_LIST_BYTES }),
				limit,
			);
			if (list.messages.length === 0) return `No messages match "${query}".`;
			const found: GmailSummary[] = new Array(list.messages.length);
			let next = 0;
			const worker = async () => {
				while (next < list.messages.length) {
					const index = next++;
					const json = await googleJson(context, `${API}/messages/${segment(list.messages[index]!.id, "message")}`, {
						query: { format: "metadata", metadataHeaders: ["From", "To", "Subject", "Date"] },
						maxBytes: GMAIL_LIST_BYTES,
					});
					found[index] = content.summary(json);
				}
			};
			await Promise.all(Array.from({ length: Math.min(CONCURRENCY, list.messages.length) }, worker));
			const lines = found.flatMap((message) => [
				`- Message ${message.id} (thread ${message.threadId ?? "?"})`,
				`  ${message.date ?? ""} · From: ${message.from || "?"} · Subject: ${message.subject || "(none)"}`,
				...(message.snippet ? [`  ${message.snippet}`] : []),
			]);
			return {
				text: [fenced("results", lines), list.nextPageToken ? `More results: search again with pageToken ${list.nextPageToken}.` : "No more results."].join("\n"),
				widget: {
					title: { en: `Mail for “${query.slice(0, 60)}”`, es: `Correo para «${query.slice(0, 60)}»` },
					kind: "list",
					items: found.map((message) => ({ title: message.subject || "(no subject)", detail: message.from, ...(message.date ? { time: message.date } : {}) })),
				},
			};
		},
	});

	const getMessage = defineAppTool({
		name: "get_message",
		description: "Read one message, by its ID from search: its headers and what Pim can read of it. Attachments aren't downloaded.",
		parameters: Type.Object({ id: Type.String({ pattern: ID.source }) }),
		readOnly: true,
		async execute({ id }, context) {
			const { json, whole } = await fetchFor(context, `messages/${segment(id, "message")}`, GMAIL_MESSAGE_BYTES).catch((error) => missing(error, `message ${id}`));
			const text = content.messageText(json);
			return whole ? text : `${text}\n${TOO_LARGE}`;
		},
	});

	const getThread = defineAppTool({
		name: "get_thread",
		description: "Read a conversation, by its thread ID from search: its most recent messages, oldest first. Attachments aren't downloaded.",
		parameters: Type.Object({ id: Type.String({ pattern: ID.source }) }),
		readOnly: true,
		async execute({ id }, context) {
			const { json, whole } = await fetchFor(context, `threads/${segment(id, "thread")}`, GMAIL_THREAD_BYTES).catch((error) => missing(error, `thread ${id}`));
			const text = content.threadText(json);
			return whole ? text : `${text}\n${TOO_LARGE}`;
		},
	});

	return googleApp({
		id: "gmail",
		name: "Gmail",
		description: "Searches and reads your mail. Never sends, changes or deletes it.",
		category: "productivity",
		client: { id: "GOOGLE_GMAIL_CLIENT_ID", secret: "GOOGLE_GMAIL_CLIENT_SECRET" },
		scopes: [GOOGLE_SCOPES.gmailReadonly],
		tools: [search, getMessage, getThread],
	});
}

/** Gmail as this Pim offers it, reading mail through the MIME normalizer. */
export const gmail = gmailApp(mimeGmailContent);
