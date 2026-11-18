/**
 * Pictures a model is shown: the ones a person attaches to a message and the ones `file_read` opens. A picture reaches a model as an image part, so
 * it is made to fit what the providers take (their longest side and size) and what the transcript and the message bus carry, whatever its size on the person's phone.
 */
import { Buffer } from "node:buffer";
import { BadRequestError } from "@pim/v2-app/errors";
import { sniffImage } from "@pim/v2-app/objects";
import sharp from "sharp";

export type ImagePart = { type: "image"; data: string; mimeType: string };
type Part = { type: "text"; text: string } | ImagePart;

export const MAX_MESSAGE_IMAGES = 4;
/** What a person may attach before it is made smaller. */
export const MAX_ATTACHED_BYTES = 5_000_000;
/** The longest side a model sees any use of: a larger picture only costs more in every later request of the chat. */
const MAX_EDGE = 1568;
/** What one picture weighs after fitting. Base64 makes it a third more, which stays under a message bus left at NATS's default 1 MB. */
const MAX_FITTED_BYTES = 700_000;
const BASE64 = /^[A-Za-z0-9+/]+={0,2}$/;

/** `bytes` as a picture a model takes: as it is when it is already small, else a JPEG scaled down until it fits. Null when the bytes are not a picture sharp can read. */
export async function fitImage(bytes: Uint8Array): Promise<ImagePart | null> {
	const type = sniffImage(bytes);
	if (!type) return null;
	try {
		const source = sharp(bytes, { failOn: "none" });
		const { width = 0, height = 0 } = await source.metadata();
		if (bytes.length <= MAX_FITTED_BYTES && Math.max(width, height) <= MAX_EDGE) return { type: "image", data: Buffer.from(bytes).toString("base64"), mimeType: type };
		let edge = Math.min(MAX_EDGE, Math.max(width, height));
		for (;;) {
			// Rotated by its EXIF orientation, which a phone photo carries and the JPEG written here does not; clear pixels become white, as JPEG has no transparency.
			const out = await sharp(bytes, { failOn: "none" }).rotate().resize({ width: edge, height: edge, fit: "inside", withoutEnlargement: true }).flatten({ background: "#fff" }).jpeg({ quality: 85 }).toBuffer();
			if (out.length <= MAX_FITTED_BYTES || edge <= 64) return { type: "image", data: out.toString("base64"), mimeType: "image/jpeg" };
			edge = Math.floor(edge * 0.75);
		}
	} catch {
		return null;
	}
}

/**
 * The content parts of a message that carries pictures, each picture checked and fitted; undefined for text alone, which the message's `text` already says.
 * A person's message with a picture the server cannot read is refused, so it never reaches the model as something else.
 */
export async function messageParts(content: unknown): Promise<Part[] | undefined> {
	if (!Array.isArray(content) || !content.some((part) => part?.type === "image")) return undefined;
	const parts: Part[] = [];
	for (const part of content as Record<string, unknown>[]) {
		if (part?.type === "text" && typeof part.text === "string") parts.push({ type: "text", text: part.text });
		else if (part?.type === "image" && typeof part.data === "string") {
			if (parts.filter((p) => p.type === "image").length >= MAX_MESSAGE_IMAGES) throw new BadRequestError(`A message can carry at most ${MAX_MESSAGE_IMAGES} images`);
			if (!BASE64.test(part.data)) throw new BadRequestError("An image's data must be base64");
			const bytes = Buffer.from(part.data, "base64");
			if (bytes.length > MAX_ATTACHED_BYTES) throw new BadRequestError(`An image must be at most ${MAX_ATTACHED_BYTES} bytes`);
			const fitted = await fitImage(bytes);
			if (!fitted) throw new BadRequestError("An image must be a PNG, JPEG, WebP or GIF");
			parts.push(fitted);
		} else throw new BadRequestError('Each part must be { type: "text", text } or { type: "image", data, mimeType }');
	}
	return parts;
}
