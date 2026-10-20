import { Buffer } from "node:buffer";
import {
	type Api,
	type Context,
	createAssistantMessageEventStream,
	type ImageContent,
	type Message,
	type Model,
	type TextContent,
} from "@earendil-works/pi-ai";
import type { Models } from "@earendil-works/pi-ai/models";
import type { UserInput } from "@earendil-works/pi-durable";
import { HttpError } from "./http";
import { failedResponse, wrapStreams } from "./usage";

/**
 * Images people send with their messages. Each is kept in R2, one object per
 * image under its owner's prefix, and a message keeps only the image's URL
 * (`/api/images/<id>`). At each model request (see `resolving`), a model
 * whose API fetches images itself gets a signed public URL to each one;
 * any other gets its bytes, inline. Nothing either adds is stored.
 */

/** Types every vision model takes. */
export const IMAGE_TYPES = ["image/png", "image/jpeg", "image/webp", "image/gif"];
export const MAX_MESSAGE_IMAGES = 4;
/** One image's size: the most any provider takes (Anthropic's 5 MB). */
export const MAX_IMAGE_BYTES = 5_000_000;
const BASE64 = /^[A-Za-z0-9+/]+={0,2}$/;
/** APIs that fetch an image from its URL (pi-ai is patched to send `url`). Workers AI takes only inline images. */
const URL_APIS = new Set(["openai-responses", "openai-codex-responses", "azure-openai-responses", "anthropic-messages"]);
/** How long a provider has to fetch an image from its signed URL. */
const SIGNED_URL_MS = 15 * 60_000;
const SECRET_KEY = "images_signing_key";

/** An image as a message keeps it: its URL, and no bytes. */
export type StoredImage = ImageContent & { readonly url: string };

type Part = TextContent | ImageContent;

const SCHEMA = `
CREATE TABLE IF NOT EXISTS pim_images (
	id TEXT PRIMARY KEY,
	session TEXT NOT NULL,
	type TEXT NOT NULL,
	bytes INTEGER NOT NULL,
	created_at INTEGER NOT NULL
);
`;

const imageId = (url: string) => /^\/api\/images\/([\w-]+)$/.exec(url)?.[1];

const isStored = (part: Part): part is StoredImage => part.type === "image" && typeof (part as StoredImage).url === "string";
const hasStored = (message: Message) => message.role === "user" && typeof message.content !== "string" && message.content.some(isStored);
const signed = (id: string, expires: number) => new TextEncoder().encode(`${id}:${expires}`);

/** `origin` if providers can reach it: HTTPS, and not this machine. */
function publicOrigin(origin: string | undefined): string | undefined {
	if (!origin) return undefined;
	const { protocol, hostname } = new URL(origin);
	if (protocol !== "https:" || hostname === "localhost" || hostname.endsWith(".localhost") || hostname === "127.0.0.1" || hostname === "[::1]") {
		return undefined;
	}
	return new URL(origin).origin;
}

/**
 * What a person sends, checked: text, or pi's content parts, which add images
 * as base64 with their type. It needs some text or an image.
 */
export function userInput(value: unknown): UserInput {
	if (typeof value === "string") {
		if (value.trim() === "") throw new HttpError(400, "content must not be empty");
		return value;
	}
	if (!Array.isArray(value)) throw new HttpError(400, "content must be a string or an array of text and image parts");
	let images = 0;
	let text = "";
	const parts = value.map((part: unknown): Part => {
		const { type, text: partText, data, mimeType } = (part ?? {}) as Record<string, unknown>;
		if (type === "text" && typeof partText === "string") {
			text += partText;
			return { type: "text", text: partText };
		}
		if (type === "image" && typeof data === "string" && typeof mimeType === "string") {
			if (!IMAGE_TYPES.includes(mimeType)) throw new HttpError(415, "An image must be a PNG, JPEG, WebP or GIF.");
			if (!BASE64.test(data)) throw new HttpError(400, "An image's data must be base64");
			if (Math.floor((data.length * 3) / 4) > MAX_IMAGE_BYTES) {
				throw new HttpError(413, `An image must be at most ${MAX_IMAGE_BYTES} bytes`);
			}
			images++;
			return { type: "image", data, mimeType };
		}
		throw new HttpError(400, 'Each part must be { type: "text", text } or { type: "image", data, mimeType }');
	});
	if (images > MAX_MESSAGE_IMAGES) throw new HttpError(400, `A message can carry at most ${MAX_MESSAGE_IMAGES} images`);
	if (images === 0 && text.trim() === "") throw new HttpError(400, "content must have text or an image");
	return parts;
}

type ImageStoreOptions = {
	readonly sql: SqlStorage;
	readonly bucket: R2Bucket;
	/** The owner's ID: their images' prefix, and their part of public URLs. */
	readonly owner: () => string;
	/** Where providers can reach this Pim, if anywhere. */
	readonly publicOrigin: () => string | undefined;
	readonly meta: { get(key: string): string | undefined; set(key: string, value: string): void };
};

export class ImageStore {
	readonly #sql: SqlStorage;
	readonly #bucket: R2Bucket;
	readonly #owner: () => string;
	readonly #options: ImageStoreOptions;

	constructor(options: ImageStoreOptions) {
		this.#options = options;
		this.#sql = options.sql;
		this.#bucket = options.bucket;
		this.#owner = options.owner;
		options.sql.exec(SCHEMA);
	}

	#key(id: string): string {
		return `${this.#owner()}/${id}`;
	}

	/** Uploads a message's images, giving back the message with their URLs instead, and their ids. */
	async keep(session: string, content: UserInput): Promise<{ content: UserInput; ids: string[] }> {
		if (typeof content === "string" || !content.some((part) => part.type === "image" && !isStored(part))) {
			return { content, ids: [] };
		}
		const ids: string[] = [];
		const kept = await Promise.all(
			content.map(async (part): Promise<Part> => {
				if (part.type !== "image" || isStored(part)) return part;
				const id = crypto.randomUUID();
				const bytes = Buffer.from(part.data, "base64");
				await this.#bucket.put(this.#key(id), bytes, { httpMetadata: { contentType: part.mimeType } });
				this.#sql.exec(
					"INSERT INTO pim_images (id, session, type, bytes, created_at) VALUES (?, ?, ?, ?, ?)",
					id,
					session,
					part.mimeType,
					bytes.byteLength,
					Date.now(),
				);
				ids.push(id);
				const stored: StoredImage = { type: "image", data: "", mimeType: part.mimeType, url: `/api/images/${id}` };
				return stored;
			}),
		);
		return { content: kept, ids };
	}

	/**
	 * Keeps a copy of an image on the web for a reply in `session` to show:
	 * its URL here, or null when the address doesn't give a PNG, JPEG, WebP or
	 * GIF of at most `MAX_IMAGE_BYTES`, or of at most `room` bytes.
	 */
	async keepFrom(session: string, url: string, room: number | null): Promise<string | null> {
		let response: Response;
		try {
			response = await fetch(url, {
				headers: { accept: IMAGE_TYPES.join(", "), "user-agent": "pim-agent/0.1" },
				redirect: "follow",
				signal: AbortSignal.timeout(10_000),
			});
		} catch {
			return null;
		}
		const type = (response.headers.get("content-type") ?? "").split(";")[0]!.trim().toLowerCase();
		const limit = Math.min(MAX_IMAGE_BYTES, room ?? MAX_IMAGE_BYTES);
		if (!response.ok || !IMAGE_TYPES.includes(type) || Number(response.headers.get("content-length") ?? 0) > limit) {
			await response.body?.cancel();
			return null;
		}
		const bytes = new Uint8Array(await response.arrayBuffer());
		if (bytes.byteLength === 0 || bytes.byteLength > limit) return null;
		const id = crypto.randomUUID();
		await this.#bucket.put(this.#key(id), bytes, { httpMetadata: { contentType: type } });
		this.#sql.exec("INSERT INTO pim_images (id, session, type, bytes, created_at) VALUES (?, ?, ?, ?, ?)", id, session, type, bytes.byteLength, Date.now());
		return `/api/images/${id}`;
	}

	/** One of the owner's images, or null. */
	async read(id: string): Promise<{ body: ReadableStream; type: string } | null> {
		const row = this.#sql.exec<{ type: string }>("SELECT type FROM pim_images WHERE id = ?", id).toArray()[0];
		if (!row) return null;
		const object = await this.#bucket.get(this.#key(id));
		return object ? { body: object.body, type: row.type } : null;
	}

	/**
	 * `messages` as `model` takes them: each kept image with a signed public
	 * URL when its API fetches images and this Pim is public, else with its
	 * bytes. A deleted one becomes a note.
	 */
	async #resolve(model: Model<Api>, messages: readonly Message[]): Promise<Message[]> {
		const origin = URL_APIS.has(model.api) ? publicOrigin(this.#options.publicOrigin()) : undefined;
		return Promise.all(
			messages.map(async (message): Promise<Message> => {
				if (message.role !== "user" || typeof message.content === "string" || !message.content.some(isStored)) return message;
				const content = await Promise.all(
					message.content.map(async (part): Promise<Part> => {
						if (!isStored(part)) return part;
						const id = imageId(part.url);
						const known = id !== undefined && this.#sql.exec("SELECT 1 FROM pim_images WHERE id = ?", id).toArray().length > 0;
						if (known && origin) return { type: "image", data: "", mimeType: part.mimeType, url: await this.#signedUrl(origin, id!) };
						const object = known ? await this.#bucket.get(this.#key(id!)) : null;
						if (!object) return { type: "text", text: "(An image the person sent here was deleted.)" };
						return { type: "image", data: Buffer.from(await object.arrayBuffer()).toString("base64"), mimeType: part.mimeType };
					}),
				);
				return { ...message, content };
			}),
		);
	}

	/**
	 * `models` with kept images resolved in every request (see `#resolve`). A
	 * model that can't see images gets them as they are: pi-ai replaces them
	 * with a note.
	 */
	resolving(models: Models): Models {
		return wrapStreams(models, (stream) => (model, context, options) => {
			const { messages } = context as Context;
			if (!model.input.includes("image") || !messages.some(hasStored)) return stream(model, context, options);
			const events = createAssistantMessageEventStream();
			void (async () => {
				let inner: ReturnType<typeof stream>;
				try {
					inner = stream(model, { ...(context as Context), messages: await this.#resolve(model, messages) }, options);
				} catch (error) {
					const message = failedResponse(model, `Couldn't load the chat's images: ${error instanceof Error ? error.message : String(error)}`);
					events.push({ type: "error", reason: "error", error: message });
					events.end(message);
					return;
				}
				for await (const event of inner) events.push(event);
				events.end(await inner.result());
			})();
			return events;
		});
	}

	/** A URL anyone can fetch the image from, for a while: what a provider fetches. */
	async #signedUrl(origin: string, id: string): Promise<string> {
		const expires = Date.now() + SIGNED_URL_MS;
		const signature = Buffer.from(await crypto.subtle.sign("HMAC", await this.#signingKey(), signed(id, expires))).toString("hex");
		return `${origin}/images/${encodeURIComponent(this.#owner())}/${id}?expires=${expires}&signature=${signature}`;
	}

	/** One of the owner's images, through a signed URL that hasn't expired; else null. */
	async readSigned(id: string, url: URL): Promise<{ body: ReadableStream; type: string } | null> {
		const expires = Number(url.searchParams.get("expires"));
		const signature = url.searchParams.get("signature") ?? "";
		if (!Number.isSafeInteger(expires) || expires < Date.now() || !/^[0-9a-f]{64}$/.test(signature)) return null;
		const valid = await crypto.subtle.verify("HMAC", await this.#signingKey(), Buffer.from(signature, "hex"), signed(id, expires));
		return valid ? this.read(id) : null;
	}

	async #signingKey(): Promise<CryptoKey> {
		let secret = this.#options.meta.get(SECRET_KEY);
		if (secret === undefined) {
			secret = Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString("base64");
			this.#options.meta.set(SECRET_KEY, secret);
		}
		return crypto.subtle.importKey("raw", Buffer.from(secret, "base64"), { name: "HMAC", hash: "SHA-256" }, false, ["sign", "verify"]);
	}

	/** Deletes the images sent in `session`. */
	async deleteSession(session: string): Promise<void> {
		const ids = this.#sql.exec<{ id: string }>("SELECT id FROM pim_images WHERE session = ?", session).toArray().map((row) => row.id);
		await this.delete(ids);
	}

	async delete(ids: readonly string[]): Promise<void> {
		// R2 deletes at most 1000 keys at once.
		for (let start = 0; start < ids.length; start += 1000) {
			const batch = ids.slice(start, start + 1000);
			await this.#bucket.delete(batch.map((id) => this.#key(id)));
			for (const id of batch) this.#sql.exec("DELETE FROM pim_images WHERE id = ?", id);
		}
	}

	/**
	 * Deletes everything under the owner's prefix: every image, including any
	 * a lost write left unrecorded, and the space's stored files (see ./files.ts),
	 * which share it.
	 */
	async deleteAll(): Promise<void> {
		let cursor: string | undefined;
		do {
			const listed = await this.#bucket.list({ prefix: `${this.#owner()}/`, ...(cursor ? { cursor } : {}) });
			if (listed.objects.length > 0) await this.#bucket.delete(listed.objects.map((object) => object.key));
			cursor = listed.truncated ? listed.cursor : undefined;
		} while (cursor);
		this.#sql.exec("DELETE FROM pim_images");
	}

	/** Whether any image or stored file is left in R2 under the owner's prefix. */
	async any(): Promise<boolean> {
		return (await this.#bucket.list({ prefix: `${this.#owner()}/`, limit: 1 })).objects.length > 0;
	}

	/** What the images take, in bytes: they count against the storage quota. */
	bytes(): number {
		return Number(this.#sql.exec("SELECT COALESCE(SUM(bytes), 0) AS bytes FROM pim_images").one().bytes);
	}

}
