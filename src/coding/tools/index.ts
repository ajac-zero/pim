// The tools a coding thread's agent works with: a shell, files, search, git and test runs, all inside the thread's workspace and reached only through `Workspace`, so they work the same on every backend. The coding thread's Durable Object builds them with `createCodingTools` and installs them as a pi extension.
//
// A tool call can be cut off when the Durable Object is evicted, and the harness runs a tool again on recovery only when the tool says that is safe. Every tool here says so, and each makes it true in its own way: tools that only read simply run again; `write` and `edit` record what they are about to write in the journal first, so a rerun returns the recorded result when the file already holds it and writes again only when the file is still as it was; `bash`, `test` and the git subcommands that change things record that they started, and a rerun reports that the call was interrupted without running anything.

import type { Context, JsonValue } from "@earendil-works/chord";
import { type TSchema, Type } from "@earendil-works/pi-ai";
import { defineTool, type ToolExecutionApi, type ToolExecutionResult, type ToolRegistration } from "@earendil-works/pi-durable";
import { WORKSPACE_ROOT, type Workspace, WorkspaceFileError, WorkspaceLimitError, WorkspacePathError } from "../workspace/types";
import { Capture, LineStream, redact } from "./output";
import { parseTestSummary, type TestSummary } from "./test-results";

export { type TestSummary, parseTestSummary } from "./test-results";

/** Where the repository is checked out, and where commands run and relative paths start. */
export const REPO_DIR = `${WORKSPACE_ROOT}/repo`;

const DEFAULT_TIMEOUT_S = 120;
const MAX_TIMEOUT_S = 900;
const SEARCH_TIMEOUT_MS = 60_000;
const MAX_READ_BYTES = 5 * 1024 * 1024;
const MAX_WRITE_BYTES = 5 * 1024 * 1024;
const MAX_READ_LINES = 2_000;
const MAX_LINE_CHARS = 2_000;
const DEFAULT_MATCHES = 100;
const MAX_MATCHES = 500;
/** What the harness keeps of a call's live output and its result; above every tool's own caps, so it never cuts them again. */
const OUTPUT_LIMITS = { maxBytes: 40_000, maxLines: 3_000 } as const;

/**
 * What a call wrote in the journal. `running`: a command started and has not
 * finished. `done`: it finished with this result. `file`: `write` or `edit`
 * is about to change `path` from the content hashed `before` (null when the
 * file did not exist) to the content hashed `after`, and reports `text`.
 */
export type JournalEntry =
	| { state: "running"; tool: string }
	| { state: "done"; tool: string; text: string; isError: boolean; details?: JsonValue }
	| { state: "file"; tool: "write" | "edit"; path: string; before: string | null; after: string; text: string };

/**
 * Where calls record what they did, by the call's task id, so a call run again
 * after an interruption knows what its first run did. The coding thread's
 * Durable Object keeps it in SQLite; it must be durable by the time `put`
 * returns, since a command starts right after.
 */
export interface ToolJournal {
	get(key: string): JournalEntry | undefined | Promise<JournalEntry | undefined>;
	put(key: string, entry: JournalEntry): void | Promise<void>;
}

/** A journal held in memory, for tests and for hosts that never resume a call. */
export class MemoryToolJournal implements ToolJournal {
	readonly entries = new Map<string, JournalEntry>();
	get(key: string) {
		return this.entries.get(key);
	}
	put(key: string, entry: JournalEntry) {
		this.entries.set(key, structuredClone(entry));
	}
}

/** One run of the `test` tool, as it is reported to `onTestRun`. `exitCode` is null when the command was killed; `output` is the end of what it printed. */
export type TestRun = {
	command: string;
	exitCode: number | null;
	timedOut: boolean;
	startedAt: number;
	durationMs: number;
	summary: TestSummary | null;
	output: string;
};

/** Output of a running `bash` or `test` call, a line at a time and redacted, for a live view outside the transcript. */
export type CodingOutputEvent = { tool: "bash" | "test"; callId: string; data: string };

export type CodingToolsDeps = {
	/** The thread's workspace, made or woken as needed; called once per tool call. */
	workspace: () => Promise<Workspace>;
	journal: ToolJournal;
	/** Told of every test run that finished, passed or not. */
	onTestRun?: (run: TestRun) => void;
	/** Told of output as `bash` and `test` print it. */
	sink?: (event: CodingOutputEvent) => void;
	/** Activity of a raw output chunk, even before a full line can be safely redacted and streamed. No content is passed. */
	onActivity?: (callId: string) => void;
	/** Who commits made with `git` are by. */
	gitIdentity?: { name: string; email: string };
};

/** A mistake in what the model asked for, reported back to it as an error result. */
class ToolInputError extends Error {}

const text = (value: string, isError = false): ToolExecutionResult => ({ content: [{ type: "text", text: value }], ...(isError ? { isError } : {}) });

const textOf = (result: ToolExecutionResult) => (result.content ?? []).map((part) => (part.type === "text" ? part.text : "")).join("");

const encode = (value: string) => new TextEncoder().encode(value);

const interrupted = (tool: string) =>
	text(
		`${tool} was interrupted, state unknown: inspect before retrying. The call was cut off while it ran and was not run again, so it may have done some, all or none of its work. Look at the workspace (git status, read, ls) to see what happened before you run it again.`,
		true,
	);

/** An absolute path under the workspace root for `path`, which is absolute or relative to the repository. Refuses paths that leave the root. */
export function resolvePath(path: string): string {
	if (path.trim() === "" || path.includes("\0")) throw new ToolInputError("The path is empty or malformed.");
	const parts: string[] = [];
	for (const part of (path.startsWith("/") ? path : `${REPO_DIR}/${path}`).split("/")) {
		if (part === "" || part === ".") continue;
		if (part === "..") {
			if (parts.pop() === undefined) throw new ToolInputError(`${path} is outside ${WORKSPACE_ROOT}; every path must be inside it.`);
		} else parts.push(part);
	}
	if (parts[0] !== WORKSPACE_ROOT.slice(1)) throw new ToolInputError(`${path} is outside ${WORKSPACE_ROOT}; every path must be inside it.`);
	return `/${parts.join("/")}`;
}

/** The path arguments that make ripgrep, started in the repository, search `path`: none for the repository itself, so it prints paths without a leading `./`. */
function searchTarget(path: string): string[] {
	if (path === REPO_DIR) return [];
	return [path.startsWith(`${REPO_DIR}/`) ? path.slice(REPO_DIR.length + 1) : path];
}

async function sha256(data: Uint8Array): Promise<string> {
	const digest = await crypto.subtle.digest("SHA-256", data);
	return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

/** `bytes` as text, or null when they look binary: a NUL byte or invalid UTF-8. */
function decodeText(bytes: Uint8Array): string | null {
	if (bytes.includes(0)) return null;
	try {
		return new TextDecoder("utf-8", { fatal: true, ignoreBOM: false }).decode(bytes);
	} catch {
		return null;
	}
}

/** Bounded, redacted text: the beginning of `value` with a notice of what was left out. */
function bounded(value: string): string {
	const capture = new Capture("head");
	capture.push(value);
	return capture.render();
}

type Exit = { code: number | null; signal?: string; timedOut: boolean };

/** Runs a command to its end, handing each piece of output to `onOutput`. */
async function run(
	workspace: Workspace,
	argv: string[],
	options: { timeoutMs: number; signal?: AbortSignal; env?: Record<string, string>; onOutput: (data: string, stream: "stdout" | "stderr") => void },
): Promise<Exit> {
	let exit: Exit = { code: null, timedOut: false };
	for await (const event of workspace.exec(argv, { cwd: REPO_DIR, timeoutMs: options.timeoutMs, signal: options.signal, env: options.env })) {
		if (event.type === "exit") exit = { code: event.code, signal: event.signal, timedOut: event.timedOut === true };
		else options.onOutput(event.data, event.type);
	}
	return exit;
}

function exitLine(exit: Exit, timeoutS: number): string {
	if (exit.timedOut) return `[Timed out after ${timeoutS} s; the command was killed.]`;
	if (exit.code === null) return `[Killed${exit.signal ? ` by ${exit.signal}` : ""}.]`;
	return `[Exit code ${exit.code}]`;
}

/** Throws the abort when the call was aborted, so the harness settles it as aborted rather than as a result. */
function throwIfAborted(context: Context) {
	const signal = context.abortSignal;
	if (signal?.aborted) throw signal.reason ?? new Error("Aborted");
}

/** Turns mistakes in the request and failures of file operations into error results the model can act on. */
async function guarded(context: Context, body: () => Promise<ToolExecutionResult>): Promise<ToolExecutionResult> {
	try {
		return await body();
	} catch (error) {
		throwIfAborted(context);
		if (error instanceof ToolInputError || error instanceof WorkspacePathError || error instanceof WorkspaceFileError || error instanceof WorkspaceLimitError) {
			return text(redact(error.message), true);
		}
		throw error;
	}
}

const journalKey = (api: ToolExecutionApi) => String(api.taskId);

/** Runs a call that must not run twice: a rerun returns the first run's result when it finished, and otherwise reports it interrupted. */
async function once(journal: ToolJournal, api: ToolExecutionApi, tool: string, body: () => Promise<ToolExecutionResult>): Promise<ToolExecutionResult> {
	const key = journalKey(api);
	const prior = await journal.get(key);
	if (prior?.state === "done") return { ...text(prior.text, prior.isError), ...(prior.details === undefined ? {} : { details: prior.details }) };
	if (prior) return interrupted(tool);
	await journal.put(key, { state: "running", tool });
	const result = await body();
	await journal.put(key, { state: "done", tool, text: textOf(result), isError: result.isError === true, ...(result.details === undefined ? {} : { details: result.details }) });
	return result;
}

/** A file as it is now: its bytes and permission bits, or null when there is none. */
async function current(workspace: Workspace, path: string, shown: string): Promise<{ bytes: Uint8Array; mode: number } | null> {
	let info: Awaited<ReturnType<Workspace["stat"]>>;
	try {
		info = await workspace.stat(path);
	} catch (error) {
		if (error instanceof WorkspaceFileError) return null;
		throw error;
	}
	if (info.type === "dir") throw new ToolInputError(`${shown} is a directory.`);
	return { bytes: await workspace.readFile(path), mode: info.mode & 0o7777 };
}

/**
 * Changes one file at most once per call. `change` gets the file as it is
 * (null when missing) and returns what to write and what to report. What is
 * about to be written goes in the journal first, so a rerun returns the
 * recorded result when the file already holds it, writes again when the file
 * is still as it was, and otherwise refuses.
 */
async function changeFile(
	deps: CodingToolsDeps,
	api: ToolExecutionApi,
	tool: "write" | "edit",
	shown: string,
	change: (before: Uint8Array | null) => { data: Uint8Array; text: string },
): Promise<ToolExecutionResult> {
	const path = resolvePath(shown);
	const workspace = await deps.workspace();
	const file = await current(workspace, path, shown);
	const before = file ? await sha256(file.bytes) : null;
	const key = journalKey(api);
	const prior = await deps.journal.get(key);
	if (prior) {
		if (prior.state !== "file") return interrupted(tool);
		if (before === prior.after) return text(prior.text);
		if (before !== prior.before)
			return text(`${tool} on ${shown} was interrupted, state unknown: inspect before retrying. The file changed after the call began, so it was not changed again; read it to see what it holds now.`, true);
	}
	const next = change(file?.bytes ?? null);
	await deps.journal.put(key, { state: "file", tool, path, before, after: await sha256(next.data), text: next.text });
	await workspace.writeFile(path, next.data, file?.mode);
	return text(next.text);
}

const timeoutParameter = Type.Optional(
	Type.Integer({ minimum: 1, maximum: MAX_TIMEOUT_S, description: `Seconds before the command is killed; ${DEFAULT_TIMEOUT_S} by default, at most ${MAX_TIMEOUT_S}.` }),
);

const bashParameters = Type.Object({
	command: Type.String({ minLength: 1, description: "The command, run with sh -c in the repository's directory." }),
	timeout: timeoutParameter,
});

const readParameters = Type.Object({
	path: Type.String({ description: `The file, relative to the repository (${REPO_DIR}) or absolute under ${WORKSPACE_ROOT}.` }),
	offset: Type.Optional(Type.Integer({ minimum: 1, description: "The first line to read, counting from 1." })),
	limit: Type.Optional(Type.Integer({ minimum: 1, maximum: MAX_READ_LINES, description: `How many lines to read; ${MAX_READ_LINES} by default.` })),
});

const writeParameters = Type.Object({
	path: Type.String({ description: `The file, relative to the repository (${REPO_DIR}) or absolute under ${WORKSPACE_ROOT}.` }),
	content: Type.String({ description: "The file's whole new content." }),
});

const editParameters = Type.Object({
	path: Type.String({ description: `The file, relative to the repository (${REPO_DIR}) or absolute under ${WORKSPACE_ROOT}.` }),
	old_string: Type.String({ description: "The exact text to replace, as it is in the file, including whitespace and indentation." }),
	new_string: Type.String({ description: "The text to put in its place." }),
	replace_all: Type.Optional(Type.Boolean({ description: "Replace every occurrence instead of requiring exactly one." })),
});

const grepParameters = Type.Object({
	pattern: Type.String({ minLength: 1, description: "A regular expression in Rust regex syntax, as ripgrep takes it." }),
	path: Type.Optional(Type.String({ description: "The file or directory to search; the repository by default." })),
	glob: Type.Optional(Type.String({ description: "Only search files matching this glob, such as *.ts or src/**/*.py." })),
	ignore_case: Type.Optional(Type.Boolean({ description: "Match regardless of case." })),
	fixed_strings: Type.Optional(Type.Boolean({ description: "Treat pattern as plain text, not a regular expression." })),
	max_results: Type.Optional(Type.Integer({ minimum: 1, maximum: MAX_MATCHES, description: `The most matching lines to return; ${DEFAULT_MATCHES} by default.` })),
});

const globParameters = Type.Object({
	pattern: Type.String({ minLength: 1, description: "A glob, such as **/*.ts or src/*/index.js." }),
	path: Type.Optional(Type.String({ description: "The directory to look in; the repository by default." })),
});

const READ_ONLY_GIT = ["status", "diff", "log", "show"] as const;
const MUTATING_GIT = ["add", "commit", "checkout", "branch", "stash"] as const;
type GitSubcommand = (typeof READ_ONLY_GIT)[number] | (typeof MUTATING_GIT)[number];

const gitParameters = Type.Object({
	subcommand: Type.Union(
		[...READ_ONLY_GIT, ...MUTATING_GIT].map((name) => Type.Literal(name)),
		{ description: "The git subcommand." },
	),
	args: Type.Optional(Type.Array(Type.String(), { maxItems: 100, description: 'Its arguments, one per item, such as ["-m", "Fix the parser"] for commit.' })),
});

const testParameters = Type.Object({
	command: Type.String({ minLength: 1, description: "The command that runs the tests, run with sh -c in the repository's directory, such as pnpm vitest run or pytest -q." }),
	timeout: timeoutParameter,
	junit_report: Type.Optional(Type.String({ description: "A JUnit XML file the command writes, to read the results from instead of its output." })),
});

/** Options no subcommand may take: they write outside the repository, run other programs, reach remotes, or set who a commit is by. Git takes any unambiguous start of a long option, so a start of one of these is refused too. */
const BLOCKED_GIT_OPTIONS = [
	"--output",
	"--ext-diff",
	"--textconv",
	"--no-index",
	"--exec",
	"--upload-pack",
	"--receive-pack",
	"--author",
	"--set-upstream",
	"--set-upstream-to",
	"--unset-upstream",
	"--edit-description",
	"--git-dir",
	"--work-tree",
	"--namespace",
	"--config",
	"--template",
	"--repo",
];

/** Why git may not run with these arguments, or null when it may. */
function gitRefusal(subcommand: string, args: readonly string[]): string | null {
	if (![...READ_ONLY_GIT, ...MUTATING_GIT].includes(subcommand as GitSubcommand)) return `git ${subcommand} is not allowed here. Allowed: ${[...READ_ONLY_GIT, ...MUTATING_GIT].join(", ")}.`;
	for (const arg of args) {
		const option = arg.split("=")[0] ?? "";
		if (option.length > 3 && option.startsWith("--") && BLOCKED_GIT_OPTIONS.some((blocked) => blocked.startsWith(option))) return `git ${subcommand} may not take ${option} here.`;
		if (subcommand === "branch" && /^-[a-zA-Z]*u/.test(arg) && !arg.startsWith("--")) return "git branch may not set an upstream here.";
	}
	if (subcommand === "checkout") {
		const [flag, name, start, ...rest] = args;
		if (flag !== "-b" || !name || name.startsWith("-") || start?.startsWith("-") || rest.length > 0) {
			return "Only git checkout -b NAME [START_POINT] is allowed, to start a new branch. To see another revision use show or diff.";
		}
	}
	return null;
}

/**
 * The coding tools, in the shape pi's harness installs: `bash`, `read`,
 * `write`, `edit`, `grep`, `glob`, `git` and `test`. Each call gets the
 * workspace from `deps.workspace`, so they can be built before it exists.
 */
export function createCodingTools(deps: CodingToolsDeps): ToolRegistration[] {
	const identity = deps.gitIdentity ?? { name: "Pim", email: "pim@users.noreply.pim" };

	/** Runs a shell command for `bash` or `test`, streaming its output, and returns what it printed and how it ended. */
	async function shell(tool: "bash" | "test", command: string, timeoutS: number, api: ToolExecutionApi, context: Context) {
		const workspace = await deps.workspace();
		const tail = new Capture("tail");
		// More of the end than the model sees, so a summary printed before a long trailer is still found.
		const forSummary = tool === "test" ? new Capture("tail", 256 * 1024, 20_000) : null;
		const live = new LineStream((data) => {
			api.output(data);
			deps.sink?.({ tool, callId: api.callId, data });
		});
		const startedAt = Date.now();
		const exit = await run(workspace, ["sh", "-c", command], {
			timeoutMs: timeoutS * 1000,
			signal: context.abortSignal,
			onOutput: (data) => {
				deps.onActivity?.(api.callId);
				tail.push(data);
				forSummary?.push(data);
				live.push(data);
			},
		});
		live.flush();
		throwIfAborted(context);
		return { workspace, exit, startedAt, durationMs: Date.now() - startedAt, output: tail.render(), forSummary };
	}

	/** Lines a ripgrep search printed, at most `max`; it is stopped once there are more. */
	async function ripgrep(argv: string[], max: number, context: Context) {
		const workspace = await deps.workspace();
		const stop = new AbortController();
		const signal = context.abortSignal ? AbortSignal.any([context.abortSignal, stop.signal]) : stop.signal;
		const lines: string[] = [];
		let pending = "";
		let more = false;
		const errors = new Capture("head", 4_000, 20);
		const exit = await run(workspace, argv, {
			timeoutMs: SEARCH_TIMEOUT_MS,
			signal,
			onOutput: (data, stream) => {
				if (stream === "stderr") return errors.push(data);
				if (more) return;
				const parts = (pending + data).split("\n");
				pending = parts.pop() ?? "";
				for (const line of parts) {
					if (lines.length === max) {
						more = true;
						stop.abort();
						return;
					}
					lines.push(line);
				}
			},
		});
		throwIfAborted(context);
		if (pending && !more) {
			if (lines.length < max) lines.push(pending);
			else more = true;
		}
		return { lines, more, exit, errors: errors.render().trim() };
	}

	const bash = defineTool({
		name: "bash",
		description: `Run a shell command in the workspace with sh -c, in the repository's directory (${REPO_DIR}). Returns its combined output and exit code. Output longer than about 30 KB keeps only its end. Commands are killed after ${DEFAULT_TIMEOUT_S} s unless you give a longer timeout (at most ${MAX_TIMEOUT_S} s). Prefer read, write, edit, grep, glob, git and test where they fit. There is no terminal: don't start interactive programs or servers that never exit. If a call was interrupted it is never rerun; inspect the workspace before retrying.`,
		parameters: bashParameters,
		replay: "safe",
		executionMode: "sequential",
		outputLimits: { ...OUTPUT_LIMITS, retain: "tail" },
		execute: (args, api, context) =>
			guarded(context, () =>
				once(deps.journal, api, "bash", async () => {
					const timeoutS = args.timeout ?? DEFAULT_TIMEOUT_S;
					const { exit, durationMs, output } = await shell("bash", args.command, timeoutS, api, context);
					const body = output === "" ? "(no output)\n" : output.endsWith("\n") ? output : `${output}\n`;
					return { ...text(`${body}${exitLine(exit, timeoutS)}`, exit.code !== 0), details: { exitCode: exit.code, timedOut: exit.timedOut, durationMs } };
				}),
			),
	});

	const read = defineTool({
		name: "read",
		description: `Read a text file in the workspace. Paths are relative to the repository (${REPO_DIR}) or absolute under ${WORKSPACE_ROOT}. Returns up to ${MAX_READ_LINES} lines or about 30 KB from offset (line 1 by default), and says how to read on when there is more. Lines longer than ${MAX_LINE_CHARS} characters are cut. Refuses binary files and files over ${MAX_READ_BYTES / 1024 / 1024} MB. Values that look like secrets are shown as [REDACTED].`,
		parameters: readParameters,
		replay: "safe",
		outputLimits: OUTPUT_LIMITS,
		execute: (args, _api, context) =>
			guarded(context, async () => {
				const path = resolvePath(args.path);
				const workspace = await deps.workspace();
				const info = await workspace.stat(path);
				if (info.type === "dir") throw new ToolInputError(`${args.path} is a directory. Use glob to list the files in it.`);
				if (info.size > MAX_READ_BYTES) {
					throw new ToolInputError(`${args.path} is ${info.size} bytes, more than read takes. Use grep to find what you need in it, or bash with head, tail or sed -n.`);
				}
				const content = decodeText(await workspace.readFile(path));
				if (content === null) throw new ToolInputError(`${args.path} looks like a binary file, which read does not show. Use bash with file or xxd to look at it.`);
				if (content === "") return text(`${args.path} is empty.`);
				const lines = content.split("\n");
				if (content.endsWith("\n")) lines.pop();
				const start = args.offset ?? 1;
				if (start > lines.length) throw new ToolInputError(`offset ${start} is past the end of ${args.path}, which has ${lines.length} lines.`);
				const limit = args.limit ?? MAX_READ_LINES;
				const kept: string[] = [];
				let bytes = 0;
				for (const line of lines.slice(start - 1, start - 1 + limit)) {
					const shown = line.length > MAX_LINE_CHARS ? `${line.slice(0, MAX_LINE_CHARS)}… [line cut at ${MAX_LINE_CHARS} characters]` : line;
					bytes += encode(shown).byteLength + 1;
					if (bytes > 30_000 && kept.length > 0) break;
					kept.push(shown);
				}
				const end = start + kept.length - 1;
				const rest = end < lines.length ? `\n\n[Lines ${start}-${end} of ${lines.length}. Use offset=${end + 1} to read on.]` : "";
				return text(`${redact(kept.join("\n"))}${rest}`);
			}),
	});

	const write = defineTool({
		name: "write",
		description: `Write a whole file in the workspace, creating it and its directories or replacing what it held. Paths are relative to the repository (${REPO_DIR}) or absolute under ${WORKSPACE_ROOT}. To change part of a file, use edit instead. An existing file keeps its permissions.`,
		parameters: writeParameters,
		// Journaled: a rerun returns what the first run reported.
		replay: "safe",
		executionMode: "sequential",
		outputLimits: OUTPUT_LIMITS,
		execute: (args, api, context) =>
			guarded(context, async () => {
				const data = encode(args.content);
				if (data.byteLength > MAX_WRITE_BYTES) throw new ToolInputError(`That content is ${data.byteLength} bytes, more than write takes (${MAX_WRITE_BYTES}).`);
				return changeFile(deps, api, "write", args.path, (before) => ({
					data,
					text: `${before ? "Replaced" : "Created"} ${args.path} (${data.byteLength} bytes).`,
				}));
			}),
	});

	const edit = defineTool({
		name: "edit",
		description: `Replace exact text in a file in the workspace. old_string must match the file exactly, including whitespace and indentation, and must occur exactly once unless replace_all is set; include a few surrounding lines to make it unique. Read the file first and copy the text from it. To create a file or rewrite it whole, use write.`,
		parameters: editParameters,
		// Journaled: a rerun returns what the first run reported.
		replay: "safe",
		executionMode: "sequential",
		outputLimits: OUTPUT_LIMITS,
		execute: (args, api, context) =>
			guarded(context, () =>
				changeFile(deps, api, "edit", args.path, (before) => {
					if (before === null) throw new ToolInputError(`${args.path} does not exist. Use write to create it.`);
					const content = decodeText(before);
					if (content === null) throw new ToolInputError(`${args.path} looks like a binary file, which edit does not change.`);
					if (args.old_string === "") throw new ToolInputError("old_string is empty. Give the exact text to replace; to create a file, use write.");
					if (args.old_string === args.new_string) throw new ToolInputError("old_string and new_string are the same, so there is nothing to change.");
					const count = content.split(args.old_string).length - 1;
					if (count === 0) {
						throw new ToolInputError(
							`old_string was not found in ${args.path}. It must match the file exactly, including whitespace, indentation and line endings: read the file and copy the text from it.`,
						);
					}
					if (count > 1 && !args.replace_all) {
						throw new ToolInputError(`old_string occurs ${count} times in ${args.path}. Include more of the surrounding lines so it matches exactly once, or set replace_all to replace every occurrence.`);
					}
					const line = content.slice(0, content.indexOf(args.old_string)).split("\n").length;
					const updated = args.replace_all ? content.split(args.old_string).join(args.new_string) : content.replace(args.old_string, () => args.new_string);
					const replaced = args.replace_all ? count : 1;
					return { data: encode(updated), text: `Edited ${args.path}: replaced ${replaced} occurrence${replaced === 1 ? "" : "s"}, the first at line ${line}.` };
				}),
			),
	});

	const grep = defineTool({
		name: "grep",
		description: `Search file contents in the workspace with ripgrep. Returns matching lines as path:line:text, at most ${DEFAULT_MATCHES} by default (max_results up to ${MAX_MATCHES}). Searches the repository unless you give a path, skips files that .gitignore ignores and hidden files, and cuts lines at 300 characters.`,
		parameters: grepParameters,
		replay: "safe",
		outputLimits: OUTPUT_LIMITS,
		execute: (args, _api, context) =>
			guarded(context, async () => {
				const target = searchTarget(resolvePath(args.path ?? REPO_DIR));
				const max = args.max_results ?? DEFAULT_MATCHES;
				const argv = [
					"rg",
					"--line-number",
					"--no-heading",
					"--with-filename",
					"--color=never",
					"--max-columns=300",
					"--max-columns-preview",
					...(args.ignore_case ? ["--ignore-case"] : []),
					...(args.fixed_strings ? ["--fixed-strings"] : []),
					...(args.glob ? [`--glob=${args.glob}`] : []),
					"-e",
					args.pattern,
					"--",
					...target,
				];
				const { lines, more, exit, errors } = await ripgrep(argv, max, context);
				if (lines.length === 0) {
					if (exit.code === 1) return text("No matches.");
					return text(`The search failed${errors ? `: ${errors}` : `, ${exitLine(exit, SEARCH_TIMEOUT_MS / 1000)}`}`, true);
				}
				const notes = [
					more ? `[Showing the first ${max} matches; there are more. Narrow the pattern, path or glob.]` : "",
					exit.code === 2 && errors ? `[Some files could not be searched: ${errors}]` : "",
					exit.timedOut ? "[The search timed out; these are the matches found before it stopped.]" : "",
				].filter(Boolean);
				return text(bounded([...lines, ...notes].join("\n")));
			}),
	});

	const glob = defineTool({
		name: "glob",
		description: `Find files in the workspace whose paths match a glob, such as **/*.ts, sorted by path. Looks in the repository unless you give a path, and skips files that .gitignore ignores and hidden files. Returns at most ${MAX_MATCHES} paths.`,
		parameters: globParameters,
		replay: "safe",
		outputLimits: OUTPUT_LIMITS,
		execute: (args, _api, context) =>
			guarded(context, async () => {
				const target = searchTarget(resolvePath(args.path ?? REPO_DIR));
				const { lines, more, exit, errors } = await ripgrep(["rg", "--files", "--color=never", "--sort=path", `--glob=${args.pattern}`, "--", ...target], MAX_MATCHES, context);
				if (lines.length === 0) {
					if (exit.code === 1 || exit.code === 0) return text("No files match.");
					return text(`The search failed${errors ? `: ${errors}` : `, ${exitLine(exit, SEARCH_TIMEOUT_MS / 1000)}`}`, true);
				}
				const notes = more ? [`[Showing the first ${MAX_MATCHES} paths; there are more. Use a narrower pattern or path.]`] : [];
				return text(bounded([...lines, ...notes].join("\n")));
			}),
	});

	const git = defineTool({
		name: "git",
		description: `Run git in the repository. Allowed: ${READ_ONLY_GIT.join(", ")}, ${MUTATING_GIT.join(", ")} (checkout only as checkout -b NAME [START_POINT]). Not allowed: push, pull, fetch, remote, config, or setting a commit's author; the tool sets who commits are by. Commit with -m, as no editor is available. Output longer than about 30 KB keeps only its beginning. If a call that changes things (add, commit, checkout, branch, stash) was interrupted, it is never rerun; inspect with status before retrying.`,
		parameters: gitParameters,
		// Reading subcommands simply run again; the others are journaled and never rerun.
		replay: "safe",
		executionMode: "sequential",
		outputLimits: OUTPUT_LIMITS,
		execute: (args, api, context) =>
			guarded(context, async () => {
				const subcommand = args.subcommand as GitSubcommand;
				const gitArgs = args.args ?? [];
				const refusal = gitRefusal(subcommand, gitArgs);
				if (refusal) throw new ToolInputError(refusal);
				const body = async () => {
					const workspace = await deps.workspace();
					const output = new Capture("head");
					const exit = await run(workspace, ["git", "--no-pager", subcommand, ...gitArgs], {
						timeoutMs: DEFAULT_TIMEOUT_S * 1000,
						signal: context.abortSignal,
						env: {
							GIT_AUTHOR_NAME: identity.name,
							GIT_AUTHOR_EMAIL: identity.email,
							GIT_COMMITTER_NAME: identity.name,
							GIT_COMMITTER_EMAIL: identity.email,
							GIT_EDITOR: "true",
							GIT_PAGER: "cat",
							GIT_TERMINAL_PROMPT: "0",
						},
						onOutput: (data) => output.push(data),
					});
					throwIfAborted(context);
					const shown = output.render();
					const ending = exit.code === 0 ? "" : `${shown && !shown.endsWith("\n") ? "\n" : ""}${exitLine(exit, DEFAULT_TIMEOUT_S)}`;
					return text(shown === "" && ending === "" ? "(no output)" : `${shown}${ending}`, exit.code !== 0);
				};
				return (READ_ONLY_GIT as readonly string[]).includes(subcommand) ? body() : once(deps.journal, api, `git ${subcommand}`, body);
			}),
	});

	const test = defineTool({
		name: "test",
		description: `Run the project's tests with a command, such as pnpm vitest run, pytest -q or cargo test, in the repository's directory. Returns the end of the output, the exit code and how long it took, and the pass and fail counts when it can read them from JUnit XML, TAP, vitest, pytest or cargo output. If the runner writes a JUnit XML report, give its path as junit_report. Killed after ${DEFAULT_TIMEOUT_S} s unless you give a longer timeout (at most ${MAX_TIMEOUT_S} s). If a call was interrupted it is never rerun; inspect before retrying.`,
		parameters: testParameters,
		replay: "safe",
		executionMode: "sequential",
		outputLimits: { ...OUTPUT_LIMITS, retain: "tail" },
		execute: (args, api, context) =>
			guarded(context, async () => {
				const report = args.junit_report === undefined ? undefined : resolvePath(args.junit_report);
				return once(deps.journal, api, "test", async () => {
					const timeoutS = args.timeout ?? DEFAULT_TIMEOUT_S;
					const { workspace, exit, startedAt, durationMs, output, forSummary } = await shell("test", args.command, timeoutS, api, context);
					let summary = parseTestSummary(forSummary?.result().text ?? "") ?? null;
					let reportNote = "";
					if (report) {
						const file = await current(workspace, report, args.junit_report ?? report).catch(() => null);
						const xml = file && file.bytes.byteLength <= MAX_READ_BYTES ? decodeText(file.bytes) : null;
						const fromReport = xml === null ? undefined : parseTestSummary(xml);
						if (fromReport) summary = fromReport;
						else reportNote = `[No JUnit results could be read from ${args.junit_report}.]\n`;
					}
					const testRun: TestRun = { command: args.command, exitCode: exit.code, timedOut: exit.timedOut, startedAt, durationMs, summary, output };
					deps.onTestRun?.(testRun);
					const counts = summary
						? `[Tests: ${summary.failed} failed, ${summary.passed} passed, ${summary.skipped} skipped (${summary.total} total), read from ${summary.format} output.]\n`
						: "[No test counts could be read from the output.]\n";
					const body = output === "" ? "(no output)\n" : output.endsWith("\n") ? output : `${output}\n`;
					return {
						...text(`${body}${exitLine(exit, timeoutS)} [Took ${(durationMs / 1000).toFixed(1)} s.]\n${reportNote}${counts}`.trimEnd(), exit.code !== 0),
						details: { exitCode: exit.code, timedOut: exit.timedOut, durationMs, summary },
					};
				});
			}),
	});

	return [bash, read, write, edit, grep, glob, git, test] as ToolRegistration<TSchema>[];
}
