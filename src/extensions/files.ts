import type { Workspace } from "@cloudflare/computer";
import { createPiTools } from "@cloudflare/computer/tools/pi-ai";
import type { TSchema } from "@earendil-works/pi-ai";
import { defineExtension, type ToolExecutionResult, type ToolRegistration } from "@earendil-works/pi-durable";
import { FILES_ROOT, filesPath } from "../files";
import { defineGatedAction, type GatedAction } from "./approvals";
import { text } from "./services";

/**
 * The person's files as tools: `@cloudflare/computer`'s file tools under
 * Pim's names, held to `FILES_ROOT`, which the person sees as Files in the
 * app. Deleting asks first (`file_delete` is a gated action): files keep no
 * earlier versions. Writing and editing don't, and a full Pim refuses them.
 * Where the deployment can run code (a Worker Loader binding), `run_javascript`
 * runs JavaScript over the same files, with no network.
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

/** Tools that change files: a Pim being erased, or out of storage, refuses them. */
const CHANGES: ReadonlySet<WorkspaceTool> = new Set(["write", "edit", "delete", "exec"]);
/** Running these again after an eviction does what the first run did. `edit` would apply its edits twice, and code could do anything twice. */
const REPLAY_SAFE: ReadonlySet<WorkspaceTool> = new Set(["read", "ls", "find", "grep", "write", "delete"]);

const WHERE = `The person's files are under ${FILES_ROOT}; they see the same files under Files in the app, and can add their own there. Paths outside ${FILES_ROOT} are refused.`;

/** What `run_javascript` is for, before the backend's own description of the language and modules. */
const CODE = `Run JavaScript to work with the person's files: analyse data, convert formats, compute, or make files such as CSV, JSON, SVG charts or HTML. Each run starts fresh, has no network (use http_request or fetch_url for that), and stops after a minute. Write what the person should keep to a file under ${FILES_ROOT}; return what you need to read in the result.`;

export type FileServices = {
	readonly workspace: () => Workspace;
	/** The id of the Workspace's JavaScript backend, or null when this deployment can't run code. */
	readonly codeBackend: () => string | null;
	/** Throws once the Pim is being erased: work still under way then writes nothing. */
	assertOpen(): void;
	/** Why the Pim can't store more now, or null when it can. */
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

function definitions(services: FileServices) {
	const code = services.codeBackend();
	const { tools, execute } = createPiTools({
		workspace: services.workspace(),
		root: FILES_ROOT,
		exec: code ? { [code]: { description: CODE } } : {},
	});
	const run = async (name: WorkspaceTool, args: Record<string, unknown>, id: string, signal?: AbortSignal): Promise<ToolExecutionResult> => {
		const problem = outside(args);
		if (problem) return text(problem, true);
		if (CHANGES.has(name)) {
			services.assertOpen();
			const refusal = services.storageRefusal();
			if (refusal) return text(refusal, true);
		}
		const result = await execute({ id, name, arguments: args }, { abortSignal: signal });
		const content = (name === "exec" ? result.content.map(withoutSource) : result.content) as ToolExecutionResult["content"];
		return { content, ...(result.isError ? { isError: true } : {}) };
	};
	return { tools: tools.filter((tool): tool is typeof tool & { name: WorkspaceTool } => tool.name in NAMES), run };
}

export function filesExtension(services: FileServices) {
	const { tools, run } = definitions(services);
	const registrations = tools
		.filter((tool) => tool.name !== "delete")
		.map(
			(tool): ToolRegistration => ({
				name: NAMES[tool.name],
				description: tool.name === "exec" ? tool.description : `${tool.description} ${WHERE}`,
				parameters: tool.parameters as unknown as TSchema,
				replay: REPLAY_SAFE.has(tool.name) ? "safe" : "unsafe",
				execute: (args, api, context) => run(tool.name, args as Record<string, unknown>, api.callId, context.abortSignal),
			}),
		);
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
