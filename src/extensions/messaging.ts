import { Type } from "@earendil-works/pi-ai";
import { defineExtension, defineTool, GenerationTask, hook, section } from "@earendil-works/pi-durable";
import { DELIVERY_REMINDER } from "../transcript";
import { widgetMarkdown } from "./define";
import { type PimServices, text } from "./services";

/** The tool Pim speaks with: the person sees what it sends, and nothing else it writes. */
export const SEND_TO_USER = "send_to_user";
export const MESSAGING_EXTENSION = "pim.messaging";

/** How many widgets one message can carry. */
export const MAX_WIDGETS = 4;

/** How many images one message can show, in all its blocks. */
export const MAX_REPLY_IMAGES = 12;
/** How many cards one block can hold. */
const MAX_CARDS = 10;

/** Something a reply shows it found, such as a product, a place or a page: drawn by the app as a row with its image. */
export type ReplyCard = { title: string; url?: string; image?: string; meta?: string; text?: string };

/** A fenced block of a reply's Markdown that the app draws itself. */
export type ReplyBlock = { kind: "cards"; cards: ReplyCard[] };

/** A ```cards fence, alone on its lines. */
const BLOCK = /^```(cards)[ \t]*\r?\n([\s\S]*?)\r?\n```[ \t]*$/gm;
const WEB_ADDRESS = /^https?:\/\/\S+$/i;

function readCard(value: unknown): ReplyCard | string {
	if (typeof value !== "object" || value === null || Array.isArray(value)) return "each card must be an object";
	const card = value as Record<string, unknown>;
	const unknown = Object.keys(card).filter((key) => !["title", "url", "image", "meta", "text"].includes(key));
	if (unknown.length > 0) return `a card has no ${unknown.join(", ")}`;
	if (typeof card.title !== "string" || card.title.trim() === "" || card.title.length > 200) return "each card needs a title of at most 200 characters";
	for (const key of ["url", "image"] as const) {
		if (card[key] !== undefined && (typeof card[key] !== "string" || !WEB_ADDRESS.test(card[key]))) return `a card's ${key} must be an http(s) address`;
	}
	if (card.meta !== undefined && (typeof card.meta !== "string" || card.meta.length > 200)) return "a card's meta must be text of at most 200 characters";
	if (card.text !== undefined && (typeof card.text !== "string" || card.text.length > 1000)) return "a card's text must be at most 1000 characters";
	return card as ReplyCard;
}

/**
 * The blocks a reply's Markdown draws, or what's wrong with one, for the
 * model to fix: a ```cards block is a JSON array of cards.
 */
export function replyBlocks(message: string): ReplyBlock[] | { error: string } {
	const blocks: ReplyBlock[] = [];
	for (const [, , body] of message.matchAll(BLOCK)) {
		let parsed: unknown;
		try {
			parsed = JSON.parse(body!);
		} catch {
			return { error: "a ```cards block must be a JSON array of { title, url?, image?, meta?, text? }" };
		}
		if (!Array.isArray(parsed) || parsed.length === 0 || parsed.length > MAX_CARDS) return { error: `a \`\`\`cards block must be a JSON array of 1 to ${MAX_CARDS} cards` };
		const cards = parsed.map(readCard);
		const wrong = cards.find((card) => typeof card === "string");
		if (wrong !== undefined) return { error: `in a \`\`\`cards block, ${wrong}` };
		blocks.push({ kind: "cards", cards: cards as ReplyCard[] });
	}
	return blocks;
}

/** The images a reply's blocks show, each once. */
export function blockImages(blocks: readonly ReplyBlock[]): string[] {
	return [...new Set(blocks.flatMap((block) => block.cards.flatMap((card) => (card.image ? [card.image] : []))))];
}

/**
 * A reply as plain Markdown, for where its blocks can't be drawn: an email,
 * a push notification, an API client's reply or a chat's public copy. Cards
 * become a list of links.
 */
export function plainReply(message: string): string {
	return message.replace(BLOCK, (fence) => {
		const blocks = replyBlocks(fence);
		if ("error" in blocks || blocks.length === 0) return fence;
		return blocks[0]!.cards
			.map((card) => {
				const title = card.url ? `[${card.title}](${card.url})` : card.title;
				const head = [`**${title}**`, card.meta].filter(Boolean).join(" · ");
				return card.text ? `- ${head}\n  ${card.text.replace(/\s*\n\s*/g, " ")}` : `- ${head}`;
			})
			.join("\n");
	});
}

/** An email's subject when the model gives none: the message's first line. */
function headline(message: string): string {
	const line = message.trim().split(/\r?\n/)[0]!.replace(/^[#>*\-\s]+/, "").trim();
	return line.length > 120 ? `${line.slice(0, 119)}…` : line || "Pim";
}

export function messagingExtension(services: PimServices) {
	const fields = {
		message: Type.String({
			minLength: 1,
			maxLength: 20_000,
			description:
				"What they read, in Markdown. To show things you found, such as products, places or pages, put a ```cards block in it, alone on its lines: a JSON array of { title, url?, image?, meta?, text? }, where meta is a short line such as its maker and price. " +
				"A card's image must be an address a tool's result in this chat gave you, such as a page's image from fetch_url, never one you made up; Pim shows a copy of it.",
		}),
		complete: Type.Optional(Type.Boolean({ description: "Finish this turn (default true). Set false only for a progress update; send the final answer in a separate call with no other tools." })),
		widgets: Type.Optional(
			Type.Array(Type.String(), {
				maxItems: MAX_WIDGETS,
				description:
					"Widgets to show under the message, from the ones your prompt lists or an app tool's result offers, by name. They show the person's data, drawn by the app: use one instead of retyping what it shows.",
			}),
		),
	};
	const withEmail = Type.Object({
		...fields,
		title: Type.Optional(
			Type.String({ maxLength: 120, description: "The email's subject; else the message's first line." }),
		),
		channel: Type.Optional(
			Type.Union([Type.Literal("chat"), Type.Literal("email")], {
				description:
					'Where it goes: "chat" (the default), this conversation; "email", their inbox, when they ask for email or for something they will want to keep, such as a report. The conversation shows that it was emailed.',
			}),
		),
	});
	const sendToUser = defineTool({
		name: SEND_TO_USER,
		description:
			"Send the person a message. It is the only way they see anything you write: the rest of your text is private working notes.",
		// Email is a channel only where the deployment can send it.
		parameters: services.emailEnabled ? withEmail : (Type.Object(fields) as unknown as typeof withEmail),
		replay: "safe",
		async execute(args, api, context) {
			const { message, channel, title } = args;
			const session = String(api.conversationId);
			const headed = title?.trim() || headline(message);
			// A widget this chat can't show is a mistake the model can fix: say so, and send nothing.
			const wanted = [...new Set(args.widgets ?? [])];
			const available = [...services.widgetsFor(session).map((widget) => widget.ref), ...services.keptWidgets(session)];
			const unknown = wanted.filter((ref) => !available.includes(ref));
			if (unknown.length > 0) {
				const offer = available.length > 0 ? `The widgets you can show here: ${available.join(", ")}.` : "No widgets can be shown here.";
				return text(`Not sent: ${unknown.join(", ")} ${unknown.length === 1 ? "isn't a widget" : "aren't widgets"} you can show. ${offer}`, true);
			}
			// So is a block it wrote wrong, or an image no tool gave it, which it may have made up.
			const blocks = replyBlocks(message);
			if ("error" in blocks) return text(`Not sent: ${blocks.error}.`, true);
			const pictured = blockImages(blocks);
			if (pictured.length > MAX_REPLY_IMAGES) return text(`Not sent: a message can show at most ${MAX_REPLY_IMAGES} images.`, true);
			const unseen = await services.unseenImages(session, pictured);
			if (unseen.length > 0) {
				return text(`Not sent: no tool's result in this chat gave ${unseen.join(", ")}. Use only images a tool found, or leave the image out.`, true);
			}
			// Loaded once, as sent: the message and what it shows stay together.
			const shown = await Promise.all(wanted.map((ref) => services.showWidget(session, ref)));
			// Copies of the images, kept once, so a replayed send shows the same ones. An inbox gets the cards as text.
			let images = pictured.length > 0 && channel !== "email" ? await api.memo<Record<string, string>>("images", context) : {};
			images ??= await api.memo("images", await services.keepImages(session, pictured), context);
			let sent = "Sent.";
			if (channel === "email") {
				const id = await api.memo("email", crypto.randomUUID(), context);
				// An inbox can't draw widgets: they go as text.
				const body = [plainReply(message), ...shown.map((widget) => widgetMarkdown(widget))].join("\n\n");
				const emailed = await services.sendEmail({ id, session, subject: headed, text: body });
				if ("error" in emailed) return text(`Not sent: ${emailed.error}`, true);
				sent = `Emailed it to ${emailed.to}.`;
			}
			// Replaying a delivered reply must not make it unread again.
			const responseAt = await api.memo("responseAt", Math.max(Date.now(), (services.store.sessionInfo(session)?.responseAt ?? 0) + 1), context);
			// A reply that went to their inbox needs no push.
			await services.responseSent(session, responseAt, channel === "email" ? undefined : plainReply(message));
			// What the widgets showed, and where the images' copies are, go back to the model too, so it knows what the person saw; the app draws them from here.
			const missing = channel === "email" ? [] : pictured.filter((url) => !images[url]);
			const result = {
				sent,
				...(shown.length > 0 ? { widgets: shown } : {}),
				...(Object.keys(images).length > 0 ? { images } : {}),
				...(missing.length > 0 ? { notShown: `${missing.join(", ")}: not an image Pim could load` } : {}),
			};
			return { ...text(Object.keys(result).length === 1 ? sent : JSON.stringify(result)), ...(args.complete === false ? {} : { control: { terminate: true as const } }) };
		},
	});

	return defineExtension({
		name: MESSAGING_EXTENSION,
		tools: [sendToUser],
		hooks: [
			hook(GenerationTask, {
				async beforeRequest({ messages }, api, context) {
					let required = false;
					let reminders = 0;
					for (const message of messages) {
						if (message.role === "user") {
							const input = typeof message.content === "string" ? message.content : message.content.flatMap((part) => part.type === "text" ? [part.text] : []).join("");
							if (input === DELIVERY_REMINDER) {
								reminders++;
								continue;
							}
							// Background work may deliberately stay silent.
							required = !/^\[(?:Scheduled task|Approval |App event\]|Team:|Chat with )/.test(input);
							reminders = 0;
						}
					}
					await api.memo("delivery", { required, reminders }, context);
				},
				async afterResponse(answer, api, context) {
					const state = await api.memo<{ required: boolean; reminders: number }>("delivery", context);
					if (!state?.required || state.reminders < 2) return;
					if (answer.stopReason === "stop" || answer.stopReason === "length" || (answer.stopReason === "toolUse" && !answer.content.some((part) => part.type === "toolCall"))) {
						// Hook throws are reported and ignored by pi; classify this as a non-retryable failure instead.
						answer.stopReason = "error";
						answer.errorMessage = "The agent did not deliver its reply with send_to_user.";
					}
				},
				async onYield(_answer, api, context) {
					const state = await api.memo<{ required: boolean; reminders: number }>("delivery", context);
					if (!state?.required) return;
					// Continuations create new generation tasks: count in the transcript, not a task-local counter.
					return { continue: DELIVERY_REMINDER };
				},
			}),
		],
		sections: [
			// Always present, so it never appears later out of order and makes pi re-send every section.
			section("widgets", ({ conversationId }) => {
				const widgets = services.widgetsFor(String(conversationId));
				if (widgets.length === 0) return "No widgets can be shown in this conversation.";
				return [
					"Widgets you can show with a message, by name in send_to_user's widgets:",
					...widgets.map((widget) => `- ${widget.ref}: ${widget.description}`),
				].join("\n");
			}),
		],
	});
}
