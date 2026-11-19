/**
 * What a chat's public link shows: a copy of what the person read in it, made from the projected transcript when the link is made or updated. It is what they
 * said (their images only counted) and what their agent sent them with `send_to_user`, with the widgets that went with each message. Pim's own inputs, the model's
 * reasoning, tool calls and their results, and image bytes are never in it.
 */
import { INTRODUCTION, isDeliveryReminder, NOTICE_PREFIXES, ROOM_POST, type MessagePart, type TranscriptMessage } from "@pim/shared/transcript";
import { compile } from "@pim/ui-lang";
import type { SharedMessage } from "@pim/v2-app/sharing";

const SEND_TO_USER = "send_to_user";
/** A ```ui fence, alone on its lines. */
const UI_BLOCK = /```ui[ \t]*\r?\n([\s\S]*?)\r?\n```[ \t]*(?:\r?\n|$)/g;

export const textOf = (parts: readonly MessagePart[]) => parts.flatMap((part) => (part.type === "text" ? [part.text] : [])).join("");

/** A reply as plain Markdown, where its ```ui blocks can't be drawn: they become the readable pieces the app drew from them. */
export function plainReply(message: string): string {
	return message.replace(UI_BLOCK, (fence, body: string) => {
		const fallback = compile(body).fallbackMarkdown;
		return fallback.trim() === "" ? fence : fallback;
	});
}

/** A widget as Markdown, for a client that can't draw it. */
export function widgetMarkdown(widget: { title?: unknown; empty?: unknown; kind?: string; failed?: true; items?: { title?: string; detail?: string; time?: string; value?: number; max?: number }[] }): string {
	const said = (text: unknown) => (typeof text === "string" ? text : ((text as { en?: string } | undefined)?.en ?? ""));
	const title = `**${said(widget.title)}**`;
	if (widget.failed || !widget.items) return `${title}\n(Couldn't load.)`;
	if (widget.items.length === 0) return `${title}\n${said(widget.empty)}`;
	const lines = widget.kind === "list" ? widget.items.map((i) => [i.title, i.detail, i.time].filter(Boolean).join(" · ")) : widget.items.map((i) => [`${i.title} (${i.value}/${i.max})`, i.detail].filter(Boolean).join(" · "));
	return [title, ...lines.map((line) => `- ${line}`)].join("\n");
}

/** The widgets a `send_to_user` result says went with the message, without their rows' links, which go to the owner's own chats and apps. */
export function widgetsOf(result: string): unknown[] {
	if (!result.startsWith("{")) return [];
	try {
		const { widgets } = JSON.parse(result) as { widgets?: unknown };
		if (!Array.isArray(widgets)) return [];
		return widgets
			.filter((w): w is Record<string, unknown> => typeof w === "object" && w !== null && typeof w.id === "string" && ("failed" in w || Array.isArray(w.items)))
			.map((w) => (Array.isArray(w.items) ? { ...w, items: (w.items as Record<string, unknown>[]).map(({ link: _, ...item }) => item) } : w));
	} catch {
		return [];
	}
}

/** The messages a chat shows: only those since the newest reset, and of the agent's messages only its successful sends to this chat (an email went to the person's inbox instead). */
export function sharedMessages(transcript: readonly TranscriptMessage[]): SharedMessage[] {
	const reset = transcript.findLastIndex((m) => m.role === "notice" && !m.compaction && textOf(m.parts) === "Context reset");
	const shown = transcript.slice(reset + 1).filter((m) => !(m as { partial?: boolean }).partial);
	const results = new Map<string, { text: string; error: boolean }>();
	for (const m of shown) {
		for (const part of m.parts) if (part.type === "tool-result") results.set(part.id, { text: textOf(part.content), error: part.error });
	}
	const messages: SharedMessage[] = [];
	for (const m of shown) {
		if (m.role === "user") {
			const text = textOf(m.parts);
			if (isDeliveryReminder(text) || text.startsWith(INTRODUCTION) || NOTICE_PREFIXES.some(([prefix]) => prefix.test(text))) continue;
			// What another agent in a group chat said there.
			const post = ROOM_POST.exec(text);
			if (post) {
				messages.push({ role: "agent", text: plainReply(text.slice(post[0].length)), widgets: [], at: m.timestamp, from: post[1]! });
				continue;
			}
			messages.push({ role: "user", text, images: m.parts.filter((part) => part.type === "image").length, at: m.timestamp });
		} else if (m.role === "assistant") {
			for (const part of m.parts) {
				if (part.type !== "tool-call" || part.name !== SEND_TO_USER) continue;
				const result = results.get(part.id);
				const { message, channel } = (part.arguments ?? {}) as { message?: unknown; channel?: unknown };
				if (!result || result.error || typeof message !== "string" || message.trim() === "" || channel === "email") continue;
				messages.push({ role: "agent", text: plainReply(message), widgets: widgetsOf(result.text), at: m.timestamp });
			}
		}
	}
	return messages;
}
