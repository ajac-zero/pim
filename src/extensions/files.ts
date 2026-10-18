import { Buffer } from "node:buffer";
import type { Workspace } from "@cloudflare/computer";
import { createPiTools } from "@cloudflare/computer/tools/pi-ai";
import { type TSchema, Type } from "@earendil-works/pi-ai";
import { defineExtension, type ToolExecutionResult, type ToolRegistration } from "@earendil-works/pi-durable";
import { FILES_ROOT, type Files, filesPath, LOADED_ROOT, type StoredFile } from "../files";
import { IMAGE_TYPES, MAX_IMAGE_BYTES } from "../images";
import { defineGatedAction, type GatedAction } from "./approvals";
import { text } from "./services";

/**
 * The person's files as tools: `@cloudflare/computer`'s file tools under
 * Pim's names, held to `FILES_ROOT`, which the person sees as Files in the
 * app. Deleting asks first (`file_delete` is a gated action): files keep no
 * earlier versions. Writing and editing don't, and a full space refuses them.
 * Where the deployment can run code (a Worker Loader binding), `run_javascript`
 * runs JavaScript over the same files, with no network, and `file_load`
 * copies stored files in for it.
 *
 * The Workspace holds only text; stored files (see ../files.ts) are added
 * here: listings and searches by name include them, `file_read` shows the
 * images among them, and deleting and writing over them reach R2.
 */
export const FILES_EXTENSION = "pim.files";

/** Pim's name for each of the Workspace's tools. */
const NAMES = {
	read: "file_read",
	ls: "file_list",
	find: "file_find",
	grep: "file_search",
	write: "file_write",
	edit: "file_edit",
	delete: "file_delete",
	exec: "run_javascript",
} as const;

type WorkspaceTool = keyof typeof NAMES;

/** Tools that change files: a space being erased, or out of storage, refuses them. */
const CHANGES: ReadonlySet<WorkspaceTool> = new Set(["write", "edit", "delete", "exec"]);
/** Running these again after an eviction does what the first run did. `edit` would apply its edits twice, and code could do anything twice. */
const REPLAY_SAFE: ReadonlySet<WorkspaceTool> = new Set(["read", "ls", "find", "grep", "write", "delete"]);

const WHERE = `The person's files are under ${FILES_ROOT}; they see the same files under Files in the app, and can add their own there. Paths outside ${FILES_ROOT} are refused.`;

/** How stored files look to agents, with or without code to open them. */
function storedNote(code: boolean): string {
	const load = code ? " run_javascript sees them only once file_load copies them in." : "";
	return `Files that aren't text, such as PDFs, images and audio, are stored apart: file_list and file_find mark them "stored", file_read shows the images among them, and file_search can't look inside them.${load}`;
}

/** What `run_javascript` is for, before the backend's own description of the language and modules. */
const CODE = `Run JavaScript to work with the person's files: analyse data, convert formats, compute, or make files such as CSV, JSON, SVG charts or HTML. Each run starts fresh, has no network (use http_request or fetch_url for that), and stops after a minute. Write what the person should keep to a file under ${FILES_ROOT}; return what you need to read in the result. Code sees only files that are text: to open a stored file (a PDF, image or audio file that listings mark "stored"), file_load it first and open the copy. Files the code writes that aren't text become stored files when it ends.`;

const LOAD = `Copy one of the person's stored files (those file_list and file_find mark "stored": PDFs, images, audio and other files that aren't text) into ${LOADED_ROOT}, so run_javascript can open it, and get the copy's path. The copy is temporary: older copies are dropped to make room, and changing it doesn't change the original, so write what you make to a new file.`;

export type FileServices = {
	readonly workspace: () => Workspace;
	/** The person's files, stored ones included. */
	readonly files: Files;
	/** The id of the Workspace's JavaScript backend, or null when this deployment can't run code. */
	readonly codeBackend: () => string | null;
	/** Throws once the space is being erased: work still under way then writes nothing. */
	assertOpen(): void;
	/** Why the space can't store more now, or null when it can. */
	storageRefusal(): string | null;
};

/** Says what's wrong with a call's path or folder, or null when each is under `FILES_ROOT`. */
function outside(args: Record<string, unknown>): string | null {
	for (const key of ["path", "cwd"] as const) {
		if (args[key] === undefined || filesPath(args[key]) !== null) continue;
		return `${String(args[key])} is not one of the person's files. Use an absolute path under ${FILES_ROOT}.`;
	}
	return null;
}

/** A run's result without the code the model just wrote, which it would otherwise read back in full. */
function withoutSource<T extends { type: string }>(part: T): T {
	if (part.type !== "text") return part;
	try {
		const { command: _, ...rest } = JSON.parse((part as unknown as { text: string }).text);
		return { ...part, text: JSON.stringify(rest) };
	} catch {
		return part;
	}
}

/** A glob as the Workspace's `find` reads it: `*` within a segment, `**` across them, `?` one character. */
function globPattern(glob: string): RegExp {
	let source = "";
	for (let index = 0; index < glob.length; index++) {
		const char = glob[index]!;
		if (char === "*" && glob[index + 1] === "*") {
			index++;
			if (glob[index + 1] === "/") {
				index++;
				source += "(?:.*/)?";
			} else source += ".*";
		} else if (char === "*") source += "[^/]*";
		else if (char === "?") source += "[^/]";
		else source += char.replace(/[.+^${}()|[\]\\]/g, "\\$&");
	}
	return new RegExp(`^${source}$`);
}

/** The stored files under `folder` that `find` with these globs would give, as it gives them. */
function storedMatches(files: Files, folder: string, pattern: string, exclude: unknown): { path: string; type: "file"; stored: true }[] {
	const included = globPattern(pattern);
	const excluded = (Array.isArray(exclude) ? exclude : exclude === undefined ? [] : [exclude]).map((glob) => globPattern(String(glob)));
	return files
		.storedUnder(folder)
		.filter((file) => {
			const relative = file.path.slice(folder.length + 1);
			if (!included.test(relative)) return false;
			// An excluded folder leaves out everything below it, as in `find`.
			const parts = relative.split("/");
			return !parts.some((_, index) => excluded.some((glob) => glob.test(parts.slice(0, index + 1).join("/"))));
		})
		.map((file) => ({ path: file.path, type: "file", stored: true }));
}

/** A stored file as `file_read` gives it: an image models take, else what it is. */
async function readStored(files: Files, file: StoredFile, code: boolean): Promise<ToolExecutionResult> {
	const about = `${file.path} is ${file.type}, ${file.bytes} bytes`;
	if (IMAGE_TYPES.includes(file.type) && file.bytes <= MAX_IMAGE_BYTES) {
		const object = await files.storedBody(file);
		if (!object) return text(`${file.path} is gone.`, true);
		return {
			content: [
				{ type: "text", text: `${about}.` },
				{ type: "image", data: Buffer.from(await object.arrayBuffer()).toString("base64"), mimeType: file.type },
			],
		};
	}
	const load = code ? " To work with it in code, file_load it." : "";
	return text(`${about}, stored apart because it isn't text, so it can't be shown here.${load}`);
}

/** Adds to a page of the Workspace's results: stored files go on the last page, so paging shows each once. */
function withStored(result: ToolExecutionResult, add: (page: { count: number; entries: unknown[] }) => unknown[]): ToolExecutionResult {
	const part = result.content?.[0];
	if (result.isError || part?.type !== "text") return result;
	const page = JSON.parse(part.text) as { count: number; entries: unknown[]; nextOffset?: number };
	if (page.nextOffset !== undefined) return result;
	const entries = [...page.entries, ...add(page)];
	return { ...result, content: [{ type: "text", text: JSON.stringify({ ...page, count: entries.length, entries }) }] };
}

function definitions(services: FileServices) {
	const code = services.codeBackend();
	const { tools, execute } = createPiTools({
		workspace: services.workspace(),
		root: FILES_ROOT,
		exec: code ? { [code]: { description: CODE } } : {},
	});
	const { files } = services;
	const run = async (name: WorkspaceTool, args: Record<string, unknown>, id: string, signal?: AbortSignal): Promise<ToolExecutionResult> => {
		const problem = outside(args);
		if (problem) return text(problem, true);
		if (CHANGES.has(name)) {
			services.assertOpen();
			const refusal = services.storageRefusal();
			if (refusal) return text(refusal, true);
		}
		const path = args.path === undefined ? null : filesPath(args.path);
		const stored = path === null ? null : files.stored(path);
		if (name === "read" && stored) return readStored(files, stored, code !== null);
		if (name === "edit" && stored) return text(`${path} is ${stored.type}, stored apart because it isn't text, so it can't be edited.`, true);
		if (name === "delete" && path !== null && !stored && args.recursive !== true && files.storedUnder(path).length > 0) {
			return text(`${path} is a folder with files in it. Set recursive to delete it with everything in it.`, true);
		}
		const started = Date.now();
		const result = await execute({ id, name, arguments: args }, { abortSignal: signal });
		// Code that failed may still have written files.
		if (name === "exec") await files.afterCode(started);
		if (!result.isError && path !== null && (name === "write" || name === "delete")) await files.removeStored(path);
		const content = (name === "exec" ? result.content.map(withoutSource) : result.content) as ToolExecutionResult["content"];
		const settled: ToolExecutionResult = { content, ...(result.isError ? { isError: true } : {}) };
		if (name === "ls" && path !== null) {
			return withStored(settled, () =>
				files.storedIn(path).map((file) => ({ name: file.path.slice(path.length + 1), size: file.bytes, mtime: file.updatedAt, isFile: true, isDirectory: false, stored: true })),
			);
		}
		if (name === "find") {
			const folder = path ?? FILES_ROOT;
			return withStored(settled, () => storedMatches(files, folder, String(args.pattern ?? ""), args.exclude));
		}
		return settled;
	};
	return { tools: tools.filter((tool): tool is typeof tool & { name: WorkspaceTool } => tool.name in NAMES), run, code };
}

/** `file_load`: a stored file copied in for code. Only where the deployment runs code. */
function loadTool(services: FileServices): ToolRegistration {
	return {
		name: "file_load",
		description: LOAD,
		parameters: Type.Object({ path: Type.String({ description: `Absolute path of the stored file, under ${FILES_ROOT}.` }) }),
		replay: "safe",
		async execute(args) {
			const problem = outside(args as Record<string, unknown>);
			if (problem) return text(problem, true);
			services.assertOpen();
			const refusal = services.storageRefusal();
			if (refusal) return text(refusal, true);
			const path = filesPath((args as { path: string }).path)!;
			try {
				const copy = await services.files.load(path);
				return text(`Copied ${path} to ${copy}. Open the copy in run_javascript; to keep what you make, write it to a new file.`);
			} catch (error) {
				return text(error instanceof Error ? error.message : String(error), true);
			}
		},
	};
}

export function filesExtension(services: FileServices) {
	const { tools, run, code } = definitions(services);
	const registrations = tools
		.filter((tool) => tool.name !== "delete")
		.map(
			(tool): ToolRegistration => ({
				name: NAMES[tool.name],
				description: tool.name === "exec" ? tool.description : `${tool.description} ${WHERE} ${storedNote(code !== null)}`,
				parameters: tool.parameters as unknown as TSchema,
				replay: REPLAY_SAFE.has(tool.name) ? "safe" : "unsafe",
				execute: (args, api, context) => run(tool.name, args as Record<string, unknown>, api.callId, context.abortSignal),
			}),
		);
	if (code) registrations.push(loadTool(services));
	return defineExtension({ name: FILES_EXTENSION, tools: registrations });
}

/** Deleting a file or folder: the person approves it, as they would any action that can't be undone. */
export function fileDeleteAction(services: FileServices): GatedAction {
	const { tools, run } = definitions(services);
	const tool = tools.find((candidate) => candidate.name === "delete")!;
	return defineGatedAction({
		name: NAMES.delete,
		description: `${tool.description} ${WHERE}`,
		parameters: tool.parameters as unknown as TSchema,
		summarize: (args) => {
			const { path, recursive } = args as { path?: unknown; recursive?: unknown };
			return `Delete ${String(path)}${recursive === true ? " and everything in it" : ""}`;
		},
		async run(args) {
			const result = await run("delete", args as Record<string, unknown>, crypto.randomUUID());
			const said = (result.content ?? []).flatMap((part) => (part.type === "text" ? [part.text] : [])).join("\n");
			if (result.isError) throw new Error(said || "The file could not be deleted.");
			return said || "Deleted.";
		},
	});
}
