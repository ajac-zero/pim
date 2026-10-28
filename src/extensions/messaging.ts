import { Type } from "@earendil-works/pi-ai";
import { defineExtension, defineTool, GenerationTask, hook, section } from "@earendil-works/pi-durable";
import { DELIVERY_REMINDER } from "../transcript";
import { widgetMarkdown } from "./define";
import { type PimServices, text } from "./services";

/** Why a run fails when the agent keeps answering without send_to_user: trying the model again wouldn't help. */
export const NOT_DELIVERED = "The agent did not deliver its reply with send_to_user.";

/** The tool Pim speaks with: the person sees what it sends, and nothing else it writes. */
export const SEND_TO_USER = "send_to_user";
export const MESSAGING_EXTENSION = "pim.messaging";

/** How many widgets one message can carry. */
export const MAX_WIDGETS = 4;

/** How many images one message can show, in all its blocks. */
export const MAX_REPLY_IMAGES = 12;
/** Something a reply shows, as the agent wrote it in a block. */
export type ReplyItem = { title?: string; url?: string; image?: string; meta?: string; text?: string; caption?: string };

/** A YouTube video id: exactly eleven of these characters. */
const YOUTUBE_ID = /^[\w-]{11}$/;
const YOUTUBE_HOSTS = new Set(["youtube.com", "www.youtube.com", "m.youtube.com"]);

/**
 * The id of the video a YouTube watch, youtu.be or shorts address names, or
 * null for any other address. The app builds the player's address from this
 * id alone, never from the address the agent wrote.
 */
export function youtubeId(address: string): string | null {
	let url: URL;
	try {
		url = new URL(address);
	} catch {
		return null;
	}
	if ((url.protocol !== "https:" && url.protocol !== "http:") || url.username || url.password || url.port) return null;
	const host = url.hostname.toLowerCase();
	let id: string | null = null;
	if (host === "youtu.be") id = /^\/([^/]+)\/?$/.exec(url.pathname)?.[1] ?? null;
	else if (YOUTUBE_HOSTS.has(host)) {
		if (url.pathname === "/watch") id = url.searchParams.get("v");
		else id = /^\/shorts\/([^/]+)\/?$/.exec(url.pathname)?.[1] ?? null;
	}
	return id !== null && YOUTUBE_ID.test(id) ? id : null;
}

/**
 * The fenced blocks of a reply's Markdown that the app draws itself, each a
 * JSON array of items: `cards`, things the agent found, such as products,
 * places or pages, as rows with their images; `gallery`, images in a grid;
 * `videos`, YouTube videos that play in the chat once the person chooses.
 */
const KINDS = {
	cards: { fields: ["title", "url", "image", "meta", "text"], required: "title", max: 10, shape: "{ title, url?, image?, meta?, text? }" },
	gallery: { fields: ["image", "caption", "url"], required: "image", max: 8, shape: "{ image, caption?, url? }" },
	videos: { fields: ["url", "title"], required: "url", max: 6, shape: "{ url, title? }, where url is a YouTube watch, youtu.be or shorts address" },
} as const;
type ReplyKind = keyof typeof KINDS;

export type ReplyBlock = { kind: ReplyKind; items: ReplyItem[] };

/** A block's fence, alone on its lines. */
const BLOCK = /^```(cards|gallery|videos)[ \t]*\r?\n([\s\S]*?)\r?\n```[ \t]*$/gm;
const WEB_ADDRESS = /^https?:\/\/\S+$/i;
/** How long each text field may be; the addresses are any length. */
const TEXT_LIMITS: Record<string, number> = { title: 200, meta: 200, caption: 200, text: 1000 };

function readItem(kind: ReplyKind, value: unknown): ReplyItem | string {
	const { fields, required } = KINDS[kind];
	if (typeof value !== "object" || value === null || Array.isArray(value)) return "each item must be an object";
	const item = value as Record<string, unknown>;
	const unknown = Object.keys(item).filter((key) => !(fields as readonly string[]).includes(key));
	if (unknown.length > 0) return `an item has no ${unknown.join(", ")}`;
	if (item[required] === undefined) return `each item needs its ${required}`;
	for (const [key, field] of Object.entries(item)) {
		if (typeof field !== "string" || field.trim() === "") return `an item's ${key} must be text`;
		if (key === "url" || key === "image") {
			if (!WEB_ADDRESS.test(field)) return `an item's ${key} must be an http(s) address`;
			if (kind === "videos" && youtubeId(field) === null) return "an item's url must be a YouTube watch, youtu.be or shorts address with a valid video id";
		} else if (field.length > TEXT_LIMITS[key]!) return `an item's ${key} must be at most ${TEXT_LIMITS[key]} characters`;
	}
	return item as ReplyItem;
}

/**
 * The blocks a reply's Markdown draws, or what's wrong with one, for the
 * model to fix.
 */
export function replyBlocks(message: string): ReplyBlock[] | { error: string } {
	const blocks: ReplyBlock[] = [];
	for (const [, name, body] of message.matchAll(BLOCK)) {
		const kind = name as ReplyKind;
		const { max, shape } = KINDS[kind];
		let parsed: unknown;
		try {
			parsed = JSON.parse(body!);
		} catch {
			parsed = null;
		}
		if (!Array.isArray(parsed) || parsed.length === 0 || parsed.length > max) {
			return { error: `a \`\`\`${kind} block must be a JSON array of 1 to ${max} items, each ${shape}` };
		}
		const items = parsed.map((item) => readItem(kind, item));
		const wrong = items.find((item) => typeof item === "string");
		if (wrong !== undefined) return { error: `in a \`\`\`${kind} block, ${wrong}` };
		blocks.push({ kind, items: items as ReplyItem[] });
	}
	return blocks;
}

/** The images a reply's blocks show, each once. */
export function blockImages(blocks: readonly ReplyBlock[]): string[] {
	return [...new Set(blocks.flatMap((block) => block.items.flatMap((item) => (item.image ? [item.image] : []))))];
}

/** A block as a list of links. */
function blockMarkdown({ kind, items }: ReplyBlock): string {
	return items
		.map((item) => {
			if (kind === "gallery") return `- [${item.caption ?? "Image"}](${item.url ?? item.image})`;
			if (kind === "videos") return `- [${item.title ?? "Video"}](${item.url})`;
			const title = item.url ? `[${item.title}](${item.url})` : item.title;
			const head = [`**${title}**`, item.meta].filter(Boolean).join(" · ");
			return item.text ? `- ${head}\n  ${item.text.replace(/\s*\n\s*/g, " ")}` : `- ${head}`;
		})
		.join("\n");
}

/**
 * A reply as plain Markdown, for where its blocks can't be drawn: an email,
 * a push notification, an API client's reply or a chat's public copy. Its
 * blocks become lists of links.
 */
export function plainReply(message: string): string {
	return message.replace(BLOCK, (fence) => {
		const blocks = replyBlocks(fence);
		return "error" in blocks || blocks.length === 0 ? fence : blockMarkdown(blocks[0]!);
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
				"To show pictures, such as an image search's results, put a ```gallery block: a JSON array of { image, caption?, url? }, where url is the page it's from. " +
				"To show a video, such as an exercise demonstration, put a ```videos block: a JSON array of { url, title? } of YouTube watch, youtu.be or shorts addresses of real videos a tool's result gave you, never made up; it plays in the chat only when the person chooses, and other links stay ordinary Markdown links. " +
				"To draw a diagram, such as a flowchart, a sequence or a timeline, put a ```mermaid block of Mermaid source in it; the person sees it drawn. " +
				"An image must be an address a tool's result in this chat gave you, such as a page's image from fetch_url, never one you made up; Pim shows a copy of it.",
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
			if (channel !== "email") await services.posted(session, message, responseAt, images);
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
					const session = String(api.conversationId);
					let required = false;
					let reminders = 0;
					/** Sends that finish a turn, by call: one that went through answered what was owed. */
					const finishing = new Set<string>();
					for (const message of messages) {
						if (message.role === "assistant") {
							for (const part of message.content) {
								if (part.type === "toolCall" && part.name === SEND_TO_USER && part.arguments?.complete !== false) finishing.add(part.id);
							}
						} else if (message.role === "toolResult") {
							if (finishing.has(message.toolCallId) && !message.isError) required = false;
						} else if (message.role === "user") {
							const input = typeof message.content === "string" ? message.content : message.content.flatMap((part) => part.type === "text" ? [part.text] : []).join("");
							if (input === DELIVERY_REMINDER) {
								reminders++;
								continue;
							}
							// What others said in a room that wasn't for this agent leaves what it owes as it was.
							if (services.maySkip(session, input)) continue;
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
						answer.errorMessage = NOT_DELIVERED;
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
