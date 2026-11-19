/**
 * What `send_to_user` checks in a reply's Markdown besides its ```ui blocks (`./agent-widgets.ts`), ported from v1 (`src/extensions/messaging.ts`): the fenced blocks the web app draws itself,
 * `cards` (things the agent found, as rows with their images), `gallery` (images in a grid) and `videos` (YouTube videos that play in the chat once the person chooses), each a JSON array
 * of items; the images they show, which must have come from a tool's result in the chat; and the copies Pim keeps of them (`keepImages`), so a reply never loads from a third party.
 * It also reads which ```ui blocks a message holds, for `ui_state` and the route that keeps a block's state.
 */
import { createHash } from "node:crypto";
import { closedUiSources, compile, uiBlockIds, type UiProgram } from "@pim/ui-lang";

/** How many images one message can show, in all its blocks. */
export const MAX_REPLY_IMAGES = 12;
/** The most one kept image may weigh, as in v1. */
const MAX_IMAGE_BYTES = 5_000_000;
const IMAGE_TYPES = ["image/png", "image/jpeg", "image/webp", "image/gif"];

/** Something a reply shows, as the agent wrote it in a block. */
export type ReplyItem = { title?: string; url?: string; image?: string; meta?: string; text?: string; caption?: string };

/** A YouTube video id: exactly eleven of these characters. */
const YOUTUBE_ID = /^[\w-]{11}$/;
const YOUTUBE_HOSTS = new Set(["youtube.com", "www.youtube.com", "m.youtube.com"]);

/** The id of the video a YouTube watch, youtu.be or shorts address names, or null for any other address. The app builds the player's address from this id alone. */
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

/** The blocks a reply's Markdown draws, or what is wrong with one, for the model to fix. */
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
		if (!Array.isArray(parsed) || parsed.length === 0 || parsed.length > max) return { error: `a \`\`\`${kind} block must be a JSON array of 1 to ${max} items, each ${shape}` };
		const items = parsed.map((item) => readItem(kind, item));
		const wrong = items.find((item) => typeof item === "string");
		if (wrong !== undefined) return { error: `in a \`\`\`${kind} block, ${wrong}` };
		blocks.push({ kind, items: items as ReplyItem[] });
	}
	return blocks;
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

/** A reply's ```cards, ```gallery and ```videos blocks as lists of links, for where they can't be drawn, such as an email. */
export function blocksAsMarkdown(message: string): string {
	return message.replace(BLOCK, (fence) => {
		const blocks = replyBlocks(fence);
		return "error" in blocks || blocks.length === 0 ? fence : blockMarkdown(blocks[0]!);
	});
}

/** The images a reply's blocks show, each once. */
export const blockImages = (blocks: readonly ReplyBlock[]): string[] => [...new Set(blocks.flatMap((block) => block.items.flatMap((item) => (item.image ? [item.image] : []))))];

/** How an agent is told to write these blocks, as part of `send_to_user`'s message parameter (v1's words). */
export const REPLY_BLOCKS_GUIDANCE =
	"To show things you found, such as products, places or pages, put a ```cards block in it, alone on its lines: a JSON array of { title, url?, image?, meta?, text? }, where meta is a short line such as its maker and price. " +
	"To show pictures, such as an image search's results, put a ```gallery block: a JSON array of { image, caption?, url? }, where url is the page it's from. " +
	"To show a video, such as an exercise demonstration, put a ```videos block: a JSON array of { url, title? } of YouTube watch, youtu.be or shorts addresses of real videos a tool's result gave you, never made up; it plays in the chat only when the person chooses, and other links stay ordinary Markdown links. " +
	"To draw a diagram, such as a flowchart, a sequence or a timeline, put a ```mermaid block of Mermaid source in it; the person sees it drawn. " +
	"An image must be an address a tool's result in this chat gave you, such as a page's image from fetch_url, never one you made up; Pim shows a copy of it.";

/** The id under which Pim keeps the copy of an image in a chat: the same image of the same chat is the same object, so a replayed send keeps one. */
export const imageCopyId = (chat: string, url: string): string => `img-${createHash("sha256").update(`${chat}\n${url}`).digest("hex").slice(0, 32)}`;

/**
 * Fetches an image for a copy: public addresses only, redirects followed by hand so each hop is checked, a PNG, JPEG, WebP or GIF of at most 5 MB. Null when it is none of that.
 */
export async function fetchImage(url: string, check: (raw: string) => Promise<URL>, fetcher: typeof fetch): Promise<{ bytes: Uint8Array; type: string } | null> {
	try {
		let target = await check(url);
		for (let hops = 0; hops < 4; hops++) {
			const response = await fetcher(target, { headers: { accept: IMAGE_TYPES.join(", "), "user-agent": "pim-agent/0.1" }, redirect: "manual", signal: AbortSignal.timeout(10_000) });
			const where = response.headers.get("location");
			if (response.status >= 300 && response.status < 400 && where) {
				await response.body?.cancel();
				target = await check(new URL(where, target).href);
				continue;
			}
			const type = (response.headers.get("content-type") ?? "").split(";")[0]!.trim().toLowerCase();
			if (!response.ok || !IMAGE_TYPES.includes(type) || Number(response.headers.get("content-length") ?? 0) > MAX_IMAGE_BYTES) {
				await response.body?.cancel();
				return null;
			}
			const reader = response.body?.getReader();
			if (!reader) return null;
			const chunks: Uint8Array[] = [];
			let size = 0;
			for (;;) {
				const { done, value } = await reader.read();
				if (done) break;
				size += value.length;
				if (size > MAX_IMAGE_BYTES) {
					await reader.cancel();
					return null;
				}
				chunks.push(value);
			}
			return size === 0 ? null : { bytes: Buffer.concat(chunks), type };
		}
		return null;
	} catch {
		return null;
	}
}

/** What a block is called to an agent: its forms by title or id, else the start of what it shows. */
export function uiBlockLabel(program: UiProgram): string {
	const forms = Object.values(program.forms).map((form) => (form.title ? `${form.title} (form ${form.id})` : `form ${form.id}`));
	if (forms.length > 0) return forms.join(", ");
	const first = program.fallbackMarkdown.split(/\r?\n/).map((line) => line.replace(/^[#>*\-\s|]+/, "").trim()).find((line) => line !== "");
	return first === undefined ? "ui block" : first.length > 60 ? `${first.slice(0, 59)}…` : first;
}

/** The most a ui_state result may be, characters: a block's state may be 32 KB, and a message has several blocks. */
export const MAX_UI_STATE_CHARS = 8000;

/**
 * The ```ui blocks a projected transcript message holds, by block id, compiled: what the agent sent in its `send_to_user` calls, in order. Empty for a message that sent none.
 * `parts` are the message's parts as `@pim/shared/transcript` projects them.
 */
export function uiProgramsOf(parts: readonly { type: string; name?: string; arguments?: unknown }[]): Map<string, UiProgram> {
	const sources = parts.flatMap((part) => (part.type === "tool-call" && part.name === "send_to_user" && typeof (part.arguments as { message?: unknown } | undefined)?.message === "string" ? closedUiSources((part.arguments as { message: string }).message) : []));
	const ids = uiBlockIds(sources);
	return new Map(sources.map((source, index) => [ids[index]!, compile(source)]));
}
