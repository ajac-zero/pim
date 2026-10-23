import type { EntryRecord } from "@earendil-works/pi-durable";
import { type ShownWidget, shownWidgets } from "./extensions/define";
import { plainReply, SEND_TO_USER } from "./extensions/messaging";
import { DELIVERY_REMINDER, INTRODUCTION, NOTICE_PREFIXES, ROOM_POST } from "./transcript";

/**
 * Public links to chats. A link shows a copy of the conversation made when
 * the person made the link, or last updated it, to anyone who has it, with
 * no account. The copy is what the person read in the chat: what they said
 * and what their agent sent them, with the widgets that went with its
 * messages. Pim's own inputs, private notes, reasoning and tool activity
 * are never in it, and what was said after it isn't either.
 */

/** One message in a chat's public copy. */
export type SharedMessage =
	/** What the person said; `images` counts the images they attached, which the copy leaves out. */
	| { readonly role: "user"; readonly text: string; readonly images: number; readonly at: number }
	/** What their agent sent them in the chat, and the widgets that went with it, as they were; in a group chat, `from` names another agent than the chat's. */
	| { readonly role: "agent"; readonly text: string; readonly widgets: readonly ShownWidget[]; readonly at: number; readonly from?: string };

/** A chat's public copy: what its link shows. */
export type SharedChat = {
	readonly title: string | null;
	/** The agent the chat is with, by name and look; an uploaded icon isn't public, so its symbol stands in. */
	readonly agent: { readonly name: string; readonly symbol: string | null; readonly color: string | null };
	/** When the copy was made. */
	readonly sharedAt: number;
	readonly messages: readonly SharedMessage[];
};

/** A chat's link, as its owner sees it. */
export type ChatLink = { readonly id: string; readonly sharedAt: number; readonly messages: number };

/** At most this much JSON in one copy, well under what a row can hold. */
export const MAX_SHARED_BYTES = 1_000_000;

const SCHEMA = `
CREATE TABLE IF NOT EXISTS pim_chat_links (
	id TEXT PRIMARY KEY,
	session TEXT NOT NULL UNIQUE,
	chat TEXT NOT NULL,
	shared_at INTEGER NOT NULL
);
`;

/** A link's id: 22 random base32 characters (110 bits), lowercase so it is safe in paths. */
function newLinkId(): string {
	const alphabet = "0123456789abcdefghjkmnpqrstvwxyz";
	return [...crypto.getRandomValues(new Uint8Array(22))].map((byte) => alphabet[byte & 31]).join("");
}

export const LINK_ID = /^[0-9a-z]{22}$/;

function textOf(content: string | readonly { type: string; text?: string }[]): string {
	return typeof content === "string" ? content : content.flatMap((part) => (part.type === "text" && part.text !== undefined ? [part.text] : [])).join("");
}

/** A widget without its rows' links, which go to the owner's own chats and artifacts. */
function unlinked(widget: ShownWidget): ShownWidget {
	if ("failed" in widget) return widget;
	return { ...widget, items: widget.items.map(({ link: _, ...item }) => item) } as ShownWidget;
}

/**
 * The messages a chat shows, from pi's entries: like the app, only those
 * since the newest reset, and of the agent's messages only its successful
 * sends to this chat (an email went to the person's inbox instead).
 */
export function sharedMessages(entries: readonly EntryRecord[]): SharedMessage[] {
	const shown = entries.slice(entries.findLastIndex((entry) => entry.kind === "pi.reset") + 1);
	const results = new Map<string, { text: string; isError: boolean }>();
	for (const entry of shown) {
		const message = entry.model?.[0];
		if (message?.role === "toolResult") results.set(message.toolCallId, { text: textOf(message.content), isError: message.isError });
	}
	const messages: SharedMessage[] = [];
	for (const entry of shown) {
		const message = entry.model?.[0];
		if (entry.kind === "pi.system" || message === undefined) continue;
		if (message.role === "user") {
			const text = textOf(message.content);
			if (text === DELIVERY_REMINDER || text.startsWith(INTRODUCTION) || NOTICE_PREFIXES.some(([prefix]) => prefix.test(text))) continue;
			// What another agent in a group chat said there; its images' copies are the owner's too.
			const post = ROOM_POST.exec(text);
			if (post) {
				messages.push({ role: "agent", text: plainReply(text.slice(post[0].length)), widgets: [], at: message.timestamp, from: post[1]! });
				continue;
			}
			const images = typeof message.content === "string" ? 0 : message.content.filter((part) => part.type === "image").length;
			messages.push({ role: "user", text, images, at: message.timestamp });
		} else if (message.role === "assistant") {
			for (const part of message.content) {
				if (part.type !== "toolCall" || part.name !== SEND_TO_USER) continue;
				const result = results.get(part.id);
				const { message: text, channel } = part.arguments as { message?: unknown; channel?: unknown };
				if (!result || result.isError || typeof text !== "string" || text.trim() === "" || channel === "email") continue;
				// Its cards as text: their images' copies are the owner's.
				messages.push({ role: "agent", text: plainReply(text), widgets: shownWidgets(result.text).map(unlinked), at: message.timestamp + (message.durationMs ?? 0) });
			}
		}
	}
	return messages;
}

/** The public links to the owner's chats, at most one per chat. */
export class ChatLinkStore {
	readonly #sql: SqlStorage;

	constructor(sql: SqlStorage) {
		this.#sql = sql;
		this.#sql.exec(SCHEMA);
	}

	/** A chat's link, if it has one. */
	of(session: string): ChatLink | undefined {
		const [row] = this.#sql
			.exec("SELECT id, shared_at, json_array_length(chat, '$.messages') AS messages FROM pim_chat_links WHERE session = ?", session)
			.toArray();
		return row && { id: String(row.id), sharedAt: Number(row.shared_at), messages: Number(row.messages) };
	}

	/** The copy a link shows, if there is such a link. */
	chat(id: string): SharedChat | undefined {
		const [row] = this.#sql.exec("SELECT chat FROM pim_chat_links WHERE id = ?", id).toArray();
		return row && (JSON.parse(String(row.chat)) as SharedChat);
	}

	/** Makes a chat's link show `chat`: a new link, or the one it has, which keeps its address. */
	save(session: string, chat: SharedChat): ChatLink {
		this.#sql.exec(
			"INSERT INTO pim_chat_links (id, session, chat, shared_at) VALUES (?, ?, ?, ?) ON CONFLICT (session) DO UPDATE SET chat = excluded.chat, shared_at = excluded.shared_at",
			newLinkId(),
			session,
			JSON.stringify(chat),
			chat.sharedAt,
		);
		return this.of(session)!;
	}

	/** Turns a chat's link off; says whether it had one. */
	delete(session: string): boolean {
		return this.#sql.exec("DELETE FROM pim_chat_links WHERE session = ?", session).rowsWritten > 0;
	}
}
