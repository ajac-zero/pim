import { Buffer } from "node:buffer";
import { Type } from "@earendil-works/pi-ai";
import { defineExtension, defineTool } from "@earendil-works/pi-durable";
import { FILES_ROOT, filesPath, imageType } from "../files";
import { text } from "./services";

/**
 * Making images: `generate_image` draws one from a description with the
 * deployment's image model (`PIM_IMAGE_MODEL`, on Workers AI) and saves it to
 * the person's files, where the chat shows it under the call. Each image
 * counts as a model request against the space's daily limit, and is billed to
 * the deployment's Cloudflare account like any Workers AI request.
 *
 * The ChatGPT plan can't make images: OpenAI's plan sharing serves the
 * Responses API without its image generation tool.
 */
export const IMAGES_EXTENSION = "pim.images";
export const GENERATE_IMAGE = "generate_image";

/** The shapes the tool offers, in sizes every Workers AI text-to-image model takes. */
const SHAPES = {
	square: { width: 1024, height: 1024 },
	landscape: { width: 1280, height: 768 },
	portrait: { width: 768, height: 1280 },
} as const;

type Size = { readonly width: number; readonly height: number };

/** A model that makes an image from a prompt, and gives back its bytes. */
export type ImageModel = {
	readonly id: string;
	generate(prompt: string, size: Size, signal?: AbortSignal): Promise<Uint8Array>;
};

const EXTENSIONS: Record<string, string> = { "image/png": "png", "image/jpeg": "jpg", "image/webp": "webp", "image/gif": "gif" };

/** What a Workers AI image model answered, as bytes: base64 in JSON, or the image itself. */
async function imageBytes(output: unknown): Promise<Uint8Array> {
	if (output instanceof ReadableStream) return new Uint8Array(await new Response(output).arrayBuffer());
	if (output instanceof Uint8Array) return output;
	if (output instanceof ArrayBuffer) return new Uint8Array(output);
	const image = (output as { image?: unknown } | null)?.image;
	if (typeof image === "string") return new Uint8Array(Buffer.from(image, "base64"));
	throw new Error("The image model answered without an image.");
}

/**
 * A Workers AI text-to-image model, through the `AI` binding. FLUX.2 models
 * take multipart form data; FLUX.1 [schnell] takes only a prompt and steps,
 * and always draws a square; the others take a prompt and a size as JSON.
 */
export function workersAiImageModel(ai: Ai, id: string): ImageModel {
	return {
		id,
		async generate(prompt, { width, height }, signal) {
			let input: unknown;
			if (id.startsWith("@cf/black-forest-labs/flux-2-")) {
				const form = new FormData();
				form.set("prompt", prompt);
				form.set("width", String(width));
				form.set("height", String(height));
				// Serialized through a Response, which makes the boundary the content type names.
				const body = new Response(form);
				input = { multipart: { body: body.body, contentType: body.headers.get("content-type") } };
			} else if (id === "@cf/black-forest-labs/flux-1-schnell") {
				input = { prompt, steps: 8 };
			} else {
				input = { prompt, width, height };
			}
			const output = await (ai.run as (model: string, input: unknown, options: AiOptions) => Promise<unknown>)(id, input, { signal });
			return imageBytes(output);
		},
	};
}

export type ImageServices = {
	readonly model: ImageModel;
	/** Why the space can't make an image now (storage full, today's model requests used up), or null; null also counts the request. */
	reserve(): string | null;
	/** Saves an image to the person's files at `path`, and gives back where. */
	save(path: string, bytes: Uint8Array): Promise<string>;
};

export function imageGenerationExtension({ model, reserve, save }: ImageServices) {
	const generateImage = defineTool({
		name: GENERATE_IMAGE,
		description: `Make an image from a description, and save it to the person's files; the chat shows it to them as soon as it's made, so don't link or describe it again. Describe what to draw in detail, in English: the subject, the setting, the style (photo, illustration, watercolor...), composition, lighting and colors, and any words it should show, in quotes. Make one image unless they ask for more: each one costs. It can't change an existing image; describe a new one instead.`,
		parameters: Type.Object({
			prompt: Type.String({ minLength: 1, maxLength: 2_000, description: "What to draw, in detail." }),
			shape: Type.Optional(
				Type.Union([Type.Literal("square"), Type.Literal("landscape"), Type.Literal("portrait")], { description: "The image's shape; square by default." }),
			),
			path: Type.Optional(
				Type.String({ description: `Where to save it, under ${FILES_ROOT}, such as ${FILES_ROOT}/images/birthday-card.png. Defaults to ${FILES_ROOT}/images/, named by the time.` }),
			),
		}),
		replay: "safe",
		async execute({ prompt, shape, path }, api, context) {
			if (path !== undefined && filesPath(path) === null) return text(`${path} is not one of the person's files. Use an absolute path under ${FILES_ROOT}.`, true);
			// A call run again after an eviction saves to the same place.
			const target = await api.memo("path", path ?? `${FILES_ROOT}/images/${new Date().toISOString().replace(/[:.]/g, "-")}`, context);
			const refusal = reserve();
			if (refusal) return text(refusal, true);
			try {
				const bytes = await model.generate(prompt, SHAPES[shape ?? "square"], context.abortSignal);
				const type = imageType(bytes);
				if (!type) throw new Error("The image model answered with something that isn't an image.");
				const named = /\.(png|jpe?g|webp|gif)$/i.test(target) ? target : `${target}.${EXTENSIONS[type]}`;
				const saved = await save(named, bytes);
				return text(
					JSON.stringify({
						image: { path: saved, model: model.id, type, bytes: bytes.byteLength },
						note: "The person sees it in the chat now, and in Files. To look at it yourself, file_read it.",
					}),
				);
			} catch (error) {
				return text(`The image wasn't made: ${error instanceof Error ? error.message : String(error)}`, true);
			}
		},
	});
	return defineExtension({ name: IMAGES_EXTENSION, tools: [generateImage] });
}
