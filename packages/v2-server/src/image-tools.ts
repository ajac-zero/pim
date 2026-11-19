/**
 * `generate_image`, ported from v1 (`src/extensions/image-generation.ts`): an agent draws an image from a description and it is saved to the person's files, where the
 * chat shows it under the call. v1 drew it with Workers AI or, for someone signed in with ChatGPT for images, through Codex's image service. V2 has no Workers AI; it draws
 * with, in this order:
 *
 * 1. the person's ChatGPT images sign-in (`./codex-images.ts`), when they connected it in Settings;
 * 2. the image model the deployment names in `PIM_IMAGE_MODEL`, as `<provider>/<model>`, on an OpenAI-compatible `/images/generations` endpoint: `openai` (the person's own
 *    key or `OPENAI_API_KEY`, at `PIM_OPENAI_BASE_URL` or OpenAI's), `gateway` (`PIM_AI_GATEWAY_URL`), or one of the person's own OpenAI-compatible providers by id;
 * 3. with no `PIM_IMAGE_MODEL`, `openai/gpt-image-1` when an OpenAI key is configured.
 *
 * With none of these the tool answers, honestly, that images are not available and how to enable them; `PIM_IMAGE_MODEL=off` leaves the tool out altogether, as in v1.
 *
 * An image is an external operation like `http_request`: it costs money and is not repeatable, so it is recorded first, a replay returns the saved file, and one whose outcome
 * cannot be known is not drawn again. The file is an object at `<owner>/files/workspace/images/...` (purpose `file`), the same store as the Files screen.
 */
import { posix } from "node:path";
import { Type } from "typebox";
import { defineTool, type ToolRegistration } from "@earendil-works/pi-durable";
import type { App } from "@pim/v2-app/app";
import { openString, type KeyringCrypto } from "@pim/v2-app/crypto";
import { sniffImage } from "@pim/v2-app/objects";
import { OwnerId, PartitionId, type Principal } from "@pim/v2-contracts/identity";
import type { Db as RuntimeDb } from "@pim/v2-runtime/db";
import type { ExternalOperations } from "@pim/v2-runtime/external";
import { type CodexImagesClient, CODEX_IMAGE_MODEL, type Shape } from "./codex-images.ts";

const FILES_ROOT = "/workspace";
const SIZES: Record<Shape, string> = { square: "1024x1024", landscape: "1536x1024", portrait: "1024x1536" };
const EXTENSIONS: Record<string, string> = { "image/png": "png", "image/jpeg": "jpg", "image/webp": "webp", "image/gif": "gif" };
const REQUEST_MS = 120_000;
const MAX_IMAGE_BYTES = 25_000_000;

export type ImageEndpoint = { id: string; /** What `PIM_IMAGE_MODEL` may call it besides its id: a person's provider is named in Settings. */ name?: string; baseUrl: string; key: string | undefined };
/** What the Runner offers the tool: where an owner's images can be drawn. */
export type ImageSources = {
	/** `PIM_IMAGE_MODEL` as `<provider>/<model>`, or undefined for the default. */
	model: string | undefined;
	codex(): CodexImagesClient | undefined;
	endpoints(): Promise<ImageEndpoint[]>;
};

type Part = { type: "text"; text: string };
type Result = { output: Part[]; isError?: boolean };
const text = (s: string, isError = false): Result => ({ output: [{ type: "text", text: s }], ...(isError ? { isError } : {}) });

/** The endpoints an owner's providers and the deployment's environment make available, with their keys opened. */
export async function imageEndpoints(db: RuntimeDb, crypto: KeyringCrypto | undefined, env: Record<string, string | undefined>, ownerId: string): Promise<ImageEndpoint[]> {
	const rows = (await db.read<{ p: { id: string; kind: string; config: Record<string, any>; secret: string | null }[] }>(ownerId, "SELECT pim_app.runner_providers($1) AS p", [ownerId]).catch(() => ({ rows: [{ p: [] }] }))).rows[0]!.p;
	const open = async (row: { id: string; secret: string | null }) => {
		if (!row.secret || !crypto) return undefined;
		return openString(crypto, row.secret, `provider:${ownerId}/${row.id}`).catch(() => undefined);
	};
	const found: ImageEndpoint[] = [];
	const openai = await open(rows.find((r) => r.kind === "openai" && r.secret) ?? { id: "", secret: null }).then((key) => key ?? env.OPENAI_API_KEY);
	if (openai) found.push({ id: "openai", baseUrl: (env.PIM_OPENAI_BASE_URL ?? "https://api.openai.com/v1").replace(/\/+$/, ""), key: openai });
	if (env.PIM_AI_GATEWAY_URL) found.push({ id: "gateway", baseUrl: env.PIM_AI_GATEWAY_URL.replace(/\/+$/, ""), key: env.PIM_AI_GATEWAY_KEY });
	for (const row of rows) {
		const url = row.config.baseUrl ?? row.config.url;
		if (["openai_compatible", "custom"].includes(row.kind) && typeof url === "string") found.push({ id: row.id, name: String(row.config.name ?? row.id), baseUrl: url.replace(/\/+$/, ""), key: await open(row) });
	}
	return found;
}

/** Draws on an OpenAI-compatible `/images/generations` endpoint. */
async function generateOnEndpoint(fetcher: typeof fetch, endpoint: ImageEndpoint, model: string, prompt: string, shape: Shape, signal: AbortSignal | undefined): Promise<Uint8Array> {
	const timeout = AbortSignal.timeout(REQUEST_MS);
	const response = await fetcher(`${endpoint.baseUrl}/images/generations`, {
		method: "POST",
		headers: { "content-type": "application/json", ...(endpoint.key ? { authorization: `Bearer ${endpoint.key}` } : {}) },
		body: JSON.stringify({ model, prompt, n: 1, size: SIZES[shape], ...(model.startsWith("gpt-image") ? {} : { response_format: "b64_json" }) }),
		signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
	});
	const body = await response.text();
	if (!response.ok) throw new Error(`${endpoint.id} answered ${response.status}${body ? `: ${body.replace(/\s+/g, " ").slice(0, 300)}` : ""}`);
	const first = (JSON.parse(body) as { data?: { b64_json?: unknown; url?: unknown }[] }).data?.[0];
	if (typeof first?.b64_json === "string") return new Uint8Array(Buffer.from(first.b64_json, "base64"));
	if (typeof first?.url === "string") {
		const image = await fetcher(first.url, { signal: timeout });
		if (!image.ok) throw new Error(`The image could not be fetched (${image.status})`);
		return new Uint8Array(await image.arrayBuffer());
	}
	throw new Error("The image model answered without an image.");
}

export type ImageToolDeps = {
	ownerId: string;
	partitionId: string;
	runtime: RuntimeDb;
	app: App | undefined;
	images: ImageSources;
	fetch: typeof fetch;
	now: () => number;
	chatOf(conversationId: number | string): Promise<string | null>;
};
export type ImageToolKit = { ops: ExternalOperations; principalOf(app: App, chat: string | null): Promise<Principal> };

const NOT_AVAILABLE =
	"Images are not available on this Pim. The person can connect their ChatGPT plan for images in Settings, under Model, or the admin can set PIM_IMAGE_MODEL (for example openai/gpt-image-1) with an OpenAI-compatible provider that draws images.";

/** `path` as an absolute path under /workspace, or null. */
function filesPath(path: unknown): string | null {
	if (typeof path !== "string" || !path.startsWith("/") || path.includes("\0")) return null;
	const resolved = posix.normalize(path).replace(/\/+$/, "") || "/";
	return resolved.startsWith(`${FILES_ROOT}/`) ? resolved : null;
}

export function imageTools(deps: ImageToolDeps, kit: ImageToolKit): ToolRegistration[] {
	const owner = OwnerId.parse(deps.ownerId);
	const sources = deps.images;
	const describe =
		"Describe what to draw in detail, in English: the subject, the setting, the style (photo, illustration, watercolor...), composition, lighting and colors, and any words it should show, in quotes. Make one image unless they ask for more: each one costs. It can't change an existing image; describe a new one instead.";

	/** Who draws: the person's ChatGPT sign-in, else the named or default image model on a configured endpoint. */
	async function pick(): Promise<{ id: string; draw: (prompt: string, shape: Shape, signal?: AbortSignal) => Promise<Uint8Array> } | undefined> {
		const codex = sources.codex();
		if (codex && (await codex.connected().catch(() => false))) return { id: CODEX_IMAGE_MODEL, draw: (prompt, shape, signal) => codex.generate(prompt, shape, signal) };
		const endpoints = await sources.endpoints();
		const [provider, ...rest] = (sources.model ?? "openai/gpt-image-1").split("/");
		const endpoint = endpoints.find((e) => e.id === provider) ?? endpoints.find((e) => e.name?.toLowerCase() === provider?.toLowerCase());
		const model = rest.join("/");
		if (!endpoint || model === "") return undefined;
		return { id: `${provider}/${model}`, draw: (prompt, shape, signal) => generateOnEndpoint(deps.fetch, endpoint, model, prompt, shape, signal) };
	}

	const generate = defineTool({
		name: "generate_image",
		description: `Make an image from a description, and save it to the person's files; the chat shows it to them as soon as it's made, so don't link or describe it again. ${describe}`,
		parameters: Type.Object({
			prompt: Type.String({ minLength: 1, maxLength: 2_000, description: "What to draw, in detail." }),
			shape: Type.Optional(Type.Union([Type.Literal("square"), Type.Literal("landscape"), Type.Literal("portrait")], { description: "The image's shape; square by default." })),
			path: Type.Optional(Type.String({ description: `Where to save it, under ${FILES_ROOT}, such as ${FILES_ROOT}/images/birthday-card.png. Defaults to ${FILES_ROOT}/images/, named by the time.` })),
		}),
		replay: "safe",
		async execute(args: { prompt: string; shape?: Shape; path?: string }, api: any, context: any): Promise<Result> {
			const app = deps.app;
			if (!app) return text("This Runner has no application database (PIM_APP_DATABASE_URL), so it cannot do that.", true);
			if (args.path !== undefined && filesPath(args.path) === null) return text(`${args.path} is not one of the person's files. Use an absolute path under ${FILES_ROOT}.`, true);
			try {
				const chat = await deps.chatOf(api.conversationId);
				const p = await kit.principalOf(app, chat);
				const who = await pick();
				if (!who) return text(NOT_AVAILABLE, true);
				const taskId = String(api.taskId);
				const operationId = `image:${deps.partitionId}:${taskId}:${api.callId}`;
				const op = await kit.ops.begin({ operationId, ownerId: owner, partitionId: PartitionId.parse(deps.partitionId), taskId, toolName: "generate_image", capability: "images", idempotencyKey: `pim-image-${deps.ownerId}-${deps.partitionId}-${taskId}-${api.callId}` });
				if (op.state === "completed") return text(String((op.receipt as any)?.summary ?? "Done."));
				if (op.state === "failed" || op.state === "cancelled") return text(`The image wasn't made: ${String((op.receipt as any)?.error ?? op.state)}`, true);
				if (op.state !== "pending") return text(`The image was being made, but what became of it is not known (${op.state}). It was not drawn again; look in the person's files before asking again.`, true);
				await kit.ops.transition(deps.ownerId, operationId, "running");
				try {
					const bytes = await who.draw(args.prompt, args.shape ?? "square", context?.abortSignal);
					const type = sniffImage(bytes);
					if (!type || bytes.length > MAX_IMAGE_BYTES) throw new Error("The image model answered with something that isn't an image.");
					const stamp = new Date(deps.now()).toISOString().replace(/[:.]/g, "-");
					const named = args.path !== undefined ? args.path : `${FILES_ROOT}/images/${stamp}`;
					const path = /\.(png|jpe?g|webp|gif)$/i.test(named) ? named : `${named}.${EXTENSIONS[type]}`;
					await app.objects.put(p, { bytes, contentType: type, purpose: "file", key: `${deps.ownerId}/files${path}` });
					const summary = JSON.stringify({ image: { path, model: who.id, type, bytes: bytes.length }, note: "The person sees it in the chat now, and in Files." });
					await kit.ops.transition(deps.ownerId, operationId, "completed", { summary, path });
					await deps.runtime.read(deps.ownerId, "SELECT pim_app.record_model_call($1, $2, 'chat', NULL, $3, $4, 0, 0, 0)", [deps.ownerId, `mc_img_${operationId}`.slice(0, 120), "images", who.id]).catch(() => undefined);
					return text(summary);
				} catch (error) {
					const message = error instanceof Error ? error.message : String(error);
					await kit.ops.transition(deps.ownerId, operationId, "failed", { error: message });
					return text(`The image wasn't made: ${message}`, true);
				}
			} catch (error) {
				return text(`The image wasn't made: ${error instanceof Error ? error.message : String(error)}`, true);
			}
		},
	} as never) as ToolRegistration;
	return [generate];
}
