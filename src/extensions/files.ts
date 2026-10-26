import { createPiTools } from "@cloudflare/computer/tools/pi-ai";
import { type TSchema, Type } from "@earendil-works/pi-ai";
import { defineExtension, type ToolExecutionResult, type ToolRegistration } from "@earendil-works/pi-durable";
import { ControlRefused } from "../computer-control-runtime";
import { type Computer, DEFAULT_COMMAND_MS, MAX_COMMAND_MS } from "../computer";
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

const WHERE = `The person's files are under ${FILES_ROOT}, a folder on their computer; they see the same files under Files in the app, and can add their own there. Paths outside ${FILES_ROOT} are refused: use shell for the rest of the computer. To share a file in chat, use a Markdown link to its absolute path, such as [Download the report](${FILES_ROOT}/report.csv). Pim opens it in the file viewer; do not use sandbox: or file: URLs.`;

export type FileServices = {
	readonly computer: Computer;
	/** Throws once the space is being erased: work still under way then writes nothing. */
	assertOpen(): void;
	/**
	 * Runs an agent's call to the computer for `session` and `callId`, if the
	 * control state admits it (see ../computer-control-runtime.ts); a space that
	 * hasn't opted in runs it as is. Refuses with a `ControlRefused`, sending nothing.
	 */
	controlled<T>(session: string, callId: string, send: () => Promise<T>): Promise<T>;
};

/** Says what's wrong with a call's path or folder, or null when each is under `FILES_ROOT`. */
function outside(args: Record<string, unknown>): string | null {
	for (const key of ["path", "cwd"] as const) {
		if (args[key] === undefined || filesPath(args[key]) !== null) continue;
		return `${String(args[key])} is not one of the person's files. Use an absolute path under ${FILES_ROOT}.`;
	}
	return null;
}

function definitions(services: FileServices) {
	const { tools, execute } = createPiTools({ workspace: { fs: services.computer.fs }, root: FILES_ROOT, exec: {} });
	const run = async (name: WorkspaceTool, args: Record<string, unknown>, id: string, signal?: AbortSignal): Promise<ToolExecutionResult> => {
		const problem = outside(args);
		if (problem) return text(problem, true);
		if (CHANGES.has(name)) services.assertOpen();
		try {
			const result = await execute({ id, name, arguments: args }, { abortSignal: signal });
			return { content: result.content as ToolExecutionResult["content"], ...(result.isError ? { isError: true } : {}) };
		} catch (error) {
			return text(error instanceof Error ? error.message : String(error), true);
		}
	};
	return { tools: tools.filter((tool): tool is typeof tool & { name: WorkspaceTool } => tool.name in NAMES), run };
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
				execute: (args, api, context) =>
					services
						.controlled(String(api.conversationId), api.callId, () => run(tool.name, args as Record<string, unknown>, api.callId, context.abortSignal))
						.catch((error) => {
							if (error instanceof ControlRefused) return text(error.message, true);
							throw error;
						}),
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

/** The longest command the person reads in an approval request; the rest is cut. */
const MAX_SUMMARY_COMMAND = 500;

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
		summarize: ({ command }) => {
			const shown = command.length > MAX_SUMMARY_COMMAND ? `${command.slice(0, MAX_SUMMARY_COMMAND)}…` : command;
			return `Run on your computer: ${shown}`;
		},
		async run({ command, cwd, timeout_seconds }) {
			if (cwd !== undefined && filesPath(cwd) === null) throw new Error(`${cwd} is not a folder under ${FILES_ROOT}.`);
			const result = await computer.exec(command, { ...(cwd ? { cwd } : {}), ...(timeout_seconds ? { timeoutMs: timeout_seconds * 1000 } : {}) });
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
