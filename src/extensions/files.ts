import { createPiTools } from "@cloudflare/computer/tools/pi-ai";
import { type TSchema, Type } from "@earendil-works/pi-ai";
import { defineExtension, type ToolExecutionResult, type ToolRegistration } from "@earendil-works/pi-durable";
import { type Computer, DEFAULT_COMMAND_MS, FileConflictError, MAX_COMMAND_MS } from "../computer";
import { sha256Hex } from "../file-changes";
import { FILES_ROOT, filesPath } from "../files";
import { defineGatedAction, type GatedAction } from "./approvals";
import { text } from "./services";

/**
 * The person's computer as tools (see ../computer.ts). Their files, under
 * `FILES_ROOT`, are `@cloudflare/computer`'s file tools under Pim's names,
 * working on the computer's folder; the person sees the same files as Files
 * in the app. `shell` runs commands on the computer. Both ask first where
 * what they do can't be undone or reaches past the files: `file_delete`
 * (files keep no earlier versions) and `shell` are gated actions. Writing and
 * editing files don't ask.
 */
export const FILES_EXTENSION = "pim.files";
export const SHELL = "shell";

/** Pim's name for each of the Workspace's tools. */
const NAMES = {
	read: "file_read",
	ls: "file_list",
	find: "file_find",
	grep: "file_search",
	write: "file_write",
	edit: "file_edit",
	delete: "file_delete",
} as const;

type WorkspaceTool = keyof typeof NAMES;

/** Tools that change files: a space being erased refuses them. */
const CHANGES: ReadonlySet<WorkspaceTool> = new Set(["write", "edit", "delete"]);
/** Running these again after an eviction does what the first run did; `edit` would apply its edits twice. */
const REPLAY_SAFE: ReadonlySet<WorkspaceTool> = new Set(["read", "ls", "find", "grep", "write", "delete"]);

const WHERE = `The person's files are under ${FILES_ROOT}, a folder on their computer; files they attach to a message are saved under ${FILES_ROOT}/uploads, and the message links each one by its path. Paths outside ${FILES_ROOT} are refused: use shell for the rest of the computer. To share a file in chat, use a Markdown link to its absolute path, such as [Download the report](${FILES_ROOT}/report.csv). Pim opens it in the file viewer; do not use sandbox: or file: URLs.`;

export type FileServices = {
	readonly computer: Computer;
	/** Throws once the space is being erased: work still under way then writes nothing. */
	assertOpen(): void;
	/** A chat's agent just read, wrote, edited or deleted `path`; `sha256` is the file as it read it. Remembering what it saw lets the person's later changes be shown to it (../file-changes.ts). Best effort: a failure is ignored. */
	saw?(session: string, path: string, sha256?: string): Promise<void>;
};

/** Says what's wrong with a call's path or folder, or null when each is under `FILES_ROOT`. */
function outside(args: Record<string, unknown>): string | null {
	for (const key of ["path", "cwd"] as const) {
		if (args[key] === undefined || filesPath(args[key]) !== null) continue;
		return `${String(args[key])} is not one of the person's files. Use an absolute path under ${FILES_ROOT}.`;
	}
	return null;
}

const EXPECTED_HASH = {
	type: "string",
	description: `The sha256 of the file as you last read it (file_read gives it), or "absent" to only create a new file. If the file has changed since, nothing is written and the result is a conflict: read the file again and redo the change.`,
} as const;

function definitions(services: FileServices) {
	const declared = createPiTools({ workspace: { fs: { ...services.computer.fs, writeFile: async () => {} } }, root: FILES_ROOT, exec: {} }).tools;
	const run = async (name: WorkspaceTool, args: Record<string, unknown>, id: string, signal?: AbortSignal, session?: string): Promise<ToolExecutionResult> => {
		const problem = outside(args);
		if (problem) return text(problem, true);
		if (CHANGES.has(name)) services.assertOpen();
		const { expectedHash, ...rest } = args;
		const given = typeof expectedHash === "string" && expectedHash !== "" ? expectedHash : undefined;
		// The library's tools write through this file system: each write is held to the hash the call gave, or, for an edit, to that of the bytes it read.
		const fs = services.computer.fs;
		let read: string | undefined;
		let conflict: FileConflictError | undefined;
		const { execute } = createPiTools({
			workspace: {
				fs: {
					...fs,
					readFile: async (path: string, options?: { byteOffset?: number; byteLength?: number }) => {
						const stream = await fs.readFile(path, options);
						if (name !== "edit" || options) return stream;
						const bytes = new Uint8Array(await new Response(stream).arrayBuffer());
						read = await sha256Hex(bytes);
						return new Response(bytes).body!;
					},
					writeFile: async (path: string, content: Uint8Array | string, options: { mode?: number } = {}): Promise<void> => {
						const expected = given ?? (name === "edit" ? read : undefined);
						try {
							await fs.writeFile(path, content, expected === undefined ? options : { ...options, expectedHash: expected });
						} catch (error) {
							if (error instanceof FileConflictError) conflict = error;
							throw error;
						}
					},
				},
			},
			root: FILES_ROOT,
			exec: {},
		});
		try {
			// A read says which file it saw, for a later write to name; the hash is taken first, so a change in between shows as a conflict then.
			const sha256 = name === "read" ? await fs.stat(rest.path as string).then((stat) => stat.sha256, () => null) : null;
			const result = await execute({ id, name, arguments: rest }, { abortSignal: signal });
			if (conflict) return text(JSON.stringify(conflict.conflict), true);
			if (session && services.saw && (name === "read" || name === "write" || name === "edit" || name === "delete") && !result.isError) {
				await services.saw(session, filesPath(rest.path)!, sha256 ?? undefined).catch(() => undefined);
			}
			const content = result.content as ToolExecutionResult["content"];
			if (sha256 !== null && !result.isError) return { content: [...(content ?? []), { type: "text", text: `sha256 of the whole file: ${sha256}` }] };
			return { content, ...(result.isError ? { isError: true } : {}) };
		} catch (error) {
			return text(error instanceof Error ? error.message : String(error), true);
		}
	};
	const tools = declared
		.filter((tool): tool is typeof tool & { name: WorkspaceTool } => tool.name in NAMES)
		.map((tool) => {
			if (tool.name !== "write" && tool.name !== "edit") return tool;
			const parameters = tool.parameters as unknown as { properties: Record<string, unknown> };
			return { ...tool, parameters: { ...parameters, properties: { ...parameters.properties, expectedHash: EXPECTED_HASH } } };
		});
	return { tools, run };
}

/** The file tools, while the person has a computer; without one, the extension is there with none, so chats get them once it's paired. */
export function filesExtension(services: FileServices) {
	if (!services.computer.paired()) return defineExtension({ name: FILES_EXTENSION, tools: [] });
	const { tools, run } = definitions(services);
	const registrations = tools
		.filter((tool) => tool.name !== "delete")
		.map(
			(tool): ToolRegistration => ({
				name: NAMES[tool.name],
				description: `${tool.description} ${WHERE}`,
				parameters: tool.parameters as unknown as TSchema,
				replay: REPLAY_SAFE.has(tool.name) ? "safe" : "unsafe",
				execute: (args, api, context) => run(tool.name, args as Record<string, unknown>, api.callId, context.abortSignal, String(api.conversationId)),
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
		async run(args, { session }) {
			const result = await run("delete", args as Record<string, unknown>, crypto.randomUUID(), undefined, session);
			const said = (result.content ?? []).flatMap((part) => (part.type === "text" ? [part.text] : [])).join("\n");
			if (result.isError) throw new Error(said || "The file could not be deleted.");
			return said || "Deleted.";
		},
	});
}

/** Running a command on the computer: it can do anything there, so the person approves it unless they let it run. */
export function shellAction(computer: Computer): GatedAction {
	return defineGatedAction({
		name: SHELL,
		description: `Run a command on the person's computer, in a bash login shell, as the user pim-computer runs as there. It starts in their files' folder, which the file tools call ${FILES_ROOT}; in commands, $PIM_WORKSPACE is that folder's path on the computer. Use it to install and run programs, use git, convert or process files, or reach what the computer can reach. Returns the exit code and output (up to 64 KB of each). A command is stopped after timeout_seconds; to leave a program running, start it detached with its output in a file, such as \`nohup server > server.log 2>&1 &\`.`,
		parameters: Type.Object({
			command: Type.String({ minLength: 1, description: "The command, as you would type it in a terminal." }),
			cwd: Type.Optional(Type.String({ description: `Where to run it: a folder under ${FILES_ROOT}. Defaults to ${FILES_ROOT}.` })),
			timeout_seconds: Type.Optional(
				Type.Integer({ minimum: 1, maximum: MAX_COMMAND_MS / 1000, description: `How long it may run, in seconds: ${DEFAULT_COMMAND_MS / 1000} unless set.` }),
			),
		}),
		// The approval request lists the command itself; a notice in a chat only says that one ran.
		summarize: () => "Run a command",
		async run({ command, cwd, timeout_seconds }, { session }) {
			if (cwd !== undefined && filesPath(cwd) === null) throw new Error(`${cwd} is not a folder under ${FILES_ROOT}.`);
			const result = await computer.exec(command, { thread: session, ...(cwd ? { cwd } : {}), ...(timeout_seconds ? { timeoutMs: timeout_seconds * 1000 } : {}) });
			const status = result.timedOut
				? `Stopped after ${timeout_seconds ?? DEFAULT_COMMAND_MS / 1000} seconds`
				: result.exitCode === null
					? `Ended by ${result.signal ?? "a signal"}`
					: `Exit code ${result.exitCode}`;
			const parts = [status];
			if (result.stdout) parts.push(`stdout:\n${result.stdout}`);
			if (result.stderr) parts.push(`stderr:\n${result.stderr}`);
			if (!result.stdout && !result.stderr) parts.push("(no output)");
			return parts.join("\n");
		},
	});
}
