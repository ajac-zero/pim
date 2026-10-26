/**
 * pim-computer: connects a machine of the person's (a server, a VM, a box at
 * home) to their space on a Pim, so their agents can use it: run commands
 * with `shell`, and keep their files there. Pim shows that folder as Files.
 *
 * It connects out to `<Pim>/api/computer/connect` over a WebSocket with the
 * token Settings → Computer gives, and answers the space's calls; it needs no
 * open port. The calls are this file's `handle`. File calls name paths under
 * `/workspace`, which is the folder `--root` names here (`~/pim` unless set),
 * and never reach outside it, through `..` or a link. Commands run as the user
 * who runs this, with that folder as their working directory. Where the
 * computer has Chrome or Chromium, it is the agents' browser too: the space
 * drives it over the DevTools protocol, through this connection (`Link`).
 *
 * Runs on Node.js 22.18 or later, with nothing to install:
 *
 *   PIM_URL=https://pim.example.com PIM_COMPUTER_TOKEN=pimc_… node pim-computer.ts
 *
 * Settings take flags too: `--url`, `--token`, `--root`, `--chrome`. The token can also
 * be in a file named by `PIM_COMPUTER_TOKEN_FILE`.
 *
 * With `--stdio`, it connects nowhere: it speaks the same messages, a line
 * each, over its input and output. The space starts it so on a computer Pim
 * started (src/sprites.ts), and it quits when its input ends.
 */

import { Buffer } from "node:buffer";
import { realpathSync } from "node:fs";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { pathToFileURL } from "node:url";

export const VERSION = "0.1.0";

/** The folder the space's file calls name; it is `root` on this machine. */
export const WORKSPACE = "/workspace";

/** The close code a connection gets when another computer connects in its place. */
export const REPLACED = 4409;

/** The most bytes one read returns; larger files are read in parts. */
export const MAX_READ_BYTES = 1_048_576;

/** A failure the space gets back, with a code like Node's (`ENOENT`) where there is one. */
export class CallError extends Error {
	readonly code: string | undefined;
	constructor(message: string, code?: string) {
		super(message);
		this.code = code;
	}
}

/** What a command run gives back. */
export type ExecResult = {
	readonly exitCode: number | null;
	readonly signal: string | null;
	readonly stdout: string;
	readonly stderr: string;
	readonly timedOut: boolean;
	/** Output past `maxBytes` was cut from the middle. */
	readonly truncated: boolean;
};

export type ExecArgs = { readonly command: string; readonly cwd?: string; readonly timeoutMs?: number; readonly maxBytes?: number };

/** Where this computer keeps the space's files, how it runs commands, and its browser (tests give their own). */
export type Machine = {
	/** The real path of the folder `/workspace` stands for. */
	readonly root: string;
	exec(args: ExecArgs, cwd: string): Promise<ExecResult>;
	/** The browser the space's agents use, or none where this computer has no Chrome. */
	readonly browser?: BrowserHost;
	/**
	 * Answers a native-app call (`native_tool`), for an embedder that has a
	 * native-app dispatcher. Absent, the call is unknown here (ENOSYS), as
	 * before. Only code that builds a `Machine` can give it: no flag or
	 * environment variable does. It is called once per call, never retried,
	 * and gets only the request. What it returns must be a `NativeOutcome`
	 * (./native-outcome.ts), which this file can't import: it is served alone.
	 * `handle` checks only the outer shape of one of its four kinds; the
	 * space reads the whole of it, and treats anything else as unknown whether
	 * the app was acted on. A throw or a bad result is answered as an error with
	 * a fixed message, which the space also treats as unknown.
	 */
	readonly native?: (request: NativeCall) => unknown;
};

/** The args of a `native_tool` call, as the space makes them (`NativeRequest` in ./native-outcome.ts); `handle` has checked only their shape. */
export type NativeCall = {
	readonly owner: string;
	readonly agentId: string;
	readonly runId: string;
	readonly callId: string;
	readonly tool: string;
	readonly arguments: Readonly<Record<string, unknown>>;
};

/** Whether `outcome` has the outer shape of one of the four `NativeOutcome` kinds: exact keys, and a reason a short lower-case word. The space checks the rest, content included. */
function looksLikeOutcome(outcome: unknown): boolean {
	if (!isPlain(outcome)) return false;
	const keys = Object.keys(outcome).sort().join();
	const word = (value: unknown) => typeof value === "string" && /^[a-z_]{1,32}$/.test(value);
	switch (outcome.status) {
		case "rejected":
		case "unknown":
			return keys === "reason,status" && word(outcome.reason);
		case "rpc_error":
			return keys === "code,status" && Number.isSafeInteger(outcome.code);
		case "completed":
			return (
				keys === "code,content,isError,presentation,status" &&
				typeof outcome.isError === "boolean" &&
				(outcome.code === null || typeof outcome.code === "string") &&
				Array.isArray(outcome.content) &&
				Array.isArray(outcome.presentation)
			);
		default:
			return false;
	}
}
const NATIVE_KEYS = ["owner", "agentId", "runId", "callId", "tool", "arguments"];

const isPlain = (value: unknown): value is Record<string, unknown> =>
	typeof value === "object" && value !== null && !Array.isArray(value) && Object.getPrototypeOf(value) === Object.prototype;

/** Hands one native-app call to the machine's dispatcher, if it has one, and returns what it answers as plain JSON data. */
async function nativeTool(machine: Machine, args: Args): Promise<unknown> {
	if (!machine.native) throw new CallError("This computer doesn't know the call native_tool. Update pim-computer.", "ENOSYS");
	const keys = Object.keys(args);
	const shaped =
		keys.length === NATIVE_KEYS.length &&
		NATIVE_KEYS.every((key) => keys.includes(key)) &&
		["owner", "agentId", "runId", "callId", "tool"].every((key) => typeof args[key] === "string") &&
		isPlain(args.arguments);
	if (!shaped) throw new CallError("The native-app call is malformed, so nothing was done.", "EINVAL");
	let text: unknown;
	try {
		text = JSON.stringify(await machine.native(args as unknown as NativeCall));
	} catch {
		// Nothing of what it threw is passed on: it may hold what the app showed.
		throw new CallError("The native-app dispatcher failed, so whether it acted is unknown.", "EIO");
	}
	const outcome = typeof text === "string" ? (JSON.parse(text) as unknown) : undefined;
	if (!looksLikeOutcome(outcome)) {
		throw new CallError("The native-app dispatcher's answer couldn't be read, so whether it acted is unknown.", "EIO");
	}
	return outcome;
}

/**
 * A Chrome on this computer, which the space drives over the DevTools
 * protocol: its messages pass through this program unread, so the space
 * works the browser as if it ran beside it.
 */
export type BrowserHost = {
	/** Opens a DevTools connection to the browser, starting it first when it isn't running. */
	connect(onMessage: (data: string) => void, onClose: () => void): Promise<BrowserChannel>;
	/** Whether the browser is running, without starting it. */
	running(): Promise<boolean>;
	/** Quits the browser. Its profile stays, with what's signed in there. */
	stop(): Promise<void>;
};

export type BrowserChannel = { send(data: string): void; close(): void };

/**
 * One connection to the space: answers its calls, and carries DevTools
 * messages between it and the browser. The space has one DevTools
 * connection at a time; opening another closes the one before, which may
 * have been left by a space that went to sleep.
 */
export class Link {
	readonly #machine: Machine;
	readonly #send: (message: string) => void;
	#channel: { id: number; browser: BrowserChannel } | null = null;
	#next = 1;

	constructor(machine: Machine, send: (message: string) => void) {
		this.#machine = machine;
		this.#send = send;
	}

	/** A message from the space: a call, which gets a reply, or a DevTools message for the browser. */
	receive(raw: string): void {
		let message: { type?: unknown; id?: unknown; op?: unknown; args?: unknown; channel?: unknown; data?: unknown };
		try {
			message = JSON.parse(raw);
		} catch {
			return;
		}
		if (message.type === "cdp") {
			if (this.#channel && message.channel === this.#channel.id && typeof message.data === "string") this.#channel.browser.send(message.data);
			return;
		}
		if (message.type !== "call" || typeof message.id !== "string" || typeof message.op !== "string") return;
		const { id } = message;
		this.#call(message.op, (message.args ?? {}) as Args).then(
			(result) => this.#send(JSON.stringify({ type: "reply", id, result })),
			(error: CallError) => this.#send(JSON.stringify({ type: "reply", id, error: { message: error.message, code: error.code } })),
		);
	}

	/** The space went away: its DevTools connection closes, and the browser goes on running. */
	close(): void {
		this.#channel?.browser.close();
		this.#channel = null;
	}

	async #call(op: string, args: Args): Promise<unknown> {
		if (!op.startsWith("browser_")) return handle(this.#machine, op, args);
		const browser = this.#machine.browser;
		if (op === "browser_status") return { available: browser !== undefined, running: browser ? await browser.running() : false };
		if (!browser) throw new CallError("This computer has no browser: install Google Chrome or Chromium there, or name one with PIM_CHROME, and restart pim-computer.", "ENOSYS");
		switch (op) {
			case "browser_connect": {
				this.close();
				const id = this.#next++;
				const link = await browser.connect(
					(data) => {
						if (this.#channel?.id === id) this.#send(JSON.stringify({ type: "cdp", channel: id, data }));
					},
					() => {
						if (this.#channel?.id !== id) return;
						this.#channel = null;
						this.#send(JSON.stringify({ type: "cdp_closed", channel: id }));
					},
				);
				this.#channel = { id, browser: link };
				return { channel: id };
			}
			case "browser_disconnect":
				if (this.#channel?.id === args.channel) this.close();
				return null;
			case "browser_stop":
				this.close();
				await browser.stop();
				return null;
			default:
				throw new CallError(`This computer doesn't know the call ${op}. Update pim-computer.`, "ENOSYS");
		}
	}
}

/** `/workspace/a/b` as a path relative to the root (`a/b`), or a refusal for anything outside it. */
function relative(virtual: unknown): string {
	if (typeof virtual !== "string" || !virtual.startsWith("/") || virtual.includes("\0")) {
		throw new CallError(`${String(virtual)} is not an absolute path under ${WORKSPACE}`, "EINVAL");
	}
	const resolved = path.posix.resolve(virtual);
	if (resolved === WORKSPACE) return "";
	if (!resolved.startsWith(`${WORKSPACE}/`)) throw new CallError(`${virtual} is outside ${WORKSPACE}`, "EACCES");
	return resolved.slice(WORKSPACE.length + 1);
}

/** A path on this machine as the space names it. */
function virtualOf(machine: Machine, local: string): string {
	const rest = path.relative(machine.root, local);
	return rest === "" ? WORKSPACE : `${WORKSPACE}/${rest.split(path.sep).join("/")}`;
}

/**
 * The local path for a space's path, checked to be in the root after links
 * are followed: the deepest part of it that exists must resolve inside.
 */
async function local(machine: Machine, virtual: unknown): Promise<string> {
	const rest = relative(virtual);
	const target = rest === "" ? machine.root : path.join(machine.root, ...rest.split("/"));
	let existing = target;
	while (true) {
		try {
			const real = await fs.realpath(existing);
			if (real !== machine.root && !real.startsWith(`${machine.root}${path.sep}`)) {
				throw new CallError(`${String(virtual)} leads outside ${WORKSPACE}`, "EACCES");
			}
			return target;
		} catch (error) {
			if ((error as { code?: string }).code !== "ENOENT" || existing === machine.root) throw failure(error, String(virtual));
			existing = path.dirname(existing);
		}
	}
}

/** A Node error as the space reads it: its code, and the space's path instead of this machine's. */
function failure(error: unknown, virtual: string): CallError {
	if (error instanceof CallError) return error;
	const code = (error as { code?: string }).code;
	const syscall = (error as { syscall?: string }).syscall;
	const reasons: Record<string, string> = {
		ENOENT: "no such file or directory",
		EEXIST: "file already exists",
		ENOTDIR: "not a directory",
		EISDIR: "is a directory",
		ENOTEMPTY: "directory not empty",
		EACCES: "permission denied",
		EPERM: "operation not permitted",
	};
	if (code && reasons[code]) return new CallError(`${code}: ${reasons[code]}${syscall ? `, ${syscall}` : ""} '${virtual}'`, code);
	return new CallError(error instanceof Error ? error.message : String(error), code);
}

/** A glob as the tools read it: `*` within a segment, `**` across them, `?` one character. */
export function globPattern(glob: string): RegExp {
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

function globs(value: unknown): RegExp[] {
	const list = Array.isArray(value) ? value : value === undefined || value === null ? [] : [value];
	return list.map((glob) => globPattern(String(glob)));
}

/**
 * Everything under `folder`, depth first in name order, as paths relative to
 * it. Excluded paths are skipped with everything below them; links are listed
 * but not followed.
 */
async function* walk(folder: string, exclude: RegExp[], prefix = ""): AsyncGenerator<{ relative: string; local: string; directory: boolean }> {
	let entries;
	try {
		entries = await fs.readdir(folder, { withFileTypes: true });
	} catch (error) {
		if ((error as { code?: string }).code === "EACCES") return;
		throw error;
	}
	entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
	for (const entry of entries) {
		const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
		if (exclude.some((glob) => glob.test(rel))) continue;
		const full = path.join(folder, entry.name);
		yield { relative: rel, local: full, directory: entry.isDirectory() };
		if (entry.isDirectory()) yield* walk(full, exclude, rel);
	}
}

function page<T>(items: T[], args: { offset?: unknown; limit?: unknown }): T[] {
	const offset = Number(args.offset ?? 0);
	const limit = args.limit === undefined ? items.length : Number(args.limit);
	return items.slice(offset, offset + limit);
}

/** How much of a file decides whether it is text. */
const SNIFF_BYTES = 8192;
/** Files larger than this aren't searched. */
const MAX_GREP_FILE_BYTES = 10_000_000;

async function grepFile(file: string, matcher: RegExp, context: number): Promise<{ line: number; text: string; context?: { line: number; text: string; isMatch: boolean }[] }[]> {
	const stat = await fs.stat(file);
	if (stat.size > MAX_GREP_FILE_BYTES) return [];
	const bytes = await fs.readFile(file);
	if (bytes.subarray(0, SNIFF_BYTES).includes(0)) return [];
	const lines = bytes.toString("utf8").split(/\r?\n/);
	const found = [];
	for (let index = 0; index < lines.length; index++) {
		matcher.lastIndex = 0;
		if (!matcher.test(lines[index]!)) continue;
		const match: { line: number; text: string; context?: { line: number; text: string; isMatch: boolean }[] } = { line: index + 1, text: lines[index]! };
		if (context > 0) {
			match.context = [];
			for (let near = Math.max(0, index - context); near <= Math.min(lines.length - 1, index + context); near++) {
				matcher.lastIndex = 0;
				match.context.push({ line: near + 1, text: lines[near]!, isMatch: matcher.test(lines[near]!) });
			}
		}
		found.push(match);
	}
	return found;
}

type Args = Record<string, unknown>;

/** Answers one of the space's calls. */
export async function handle(machine: Machine, op: string, args: Args): Promise<unknown> {
	const at = String(args.path ?? WORKSPACE);
	try {
		switch (op) {
			case "stat": {
				const file = await local(machine, args.path);
				const stat = await fs.stat(file);
				const link = await fs.lstat(file);
				return {
					name: path.basename(file),
					inode: stat.ino,
					mode: stat.mode,
					mtime: stat.mtimeMs,
					size: stat.size,
					isFile: stat.isFile(),
					isDirectory: stat.isDirectory(),
					isSymbolicLink: link.isSymbolicLink(),
				};
			}
			case "read": {
				const file = await local(machine, args.path);
				const offset = Number(args.offset ?? 0);
				const length = Math.min(Number(args.length ?? MAX_READ_BYTES), MAX_READ_BYTES);
				const handle = await fs.open(file, "r");
				try {
					const { size } = await handle.stat();
					const buffer = Buffer.alloc(Math.max(0, Math.min(length, size - offset)));
					const { bytesRead } = buffer.length === 0 ? { bytesRead: 0 } : await handle.read(buffer, 0, buffer.length, offset);
					return { data: buffer.subarray(0, bytesRead).toString("base64"), size };
				} finally {
					await handle.close();
				}
			}
			case "write": {
				const file = await local(machine, args.path);
				const data = Buffer.from(String(args.data ?? ""), "base64");
				const mode = typeof args.mode === "number" ? args.mode & 0o777 : undefined;
				if (args.append === true) await fs.appendFile(file, data);
				else await fs.writeFile(file, data, mode === undefined ? {} : { mode });
				return null;
			}
			case "mkdir": {
				await fs.mkdir(await local(machine, args.path), { recursive: args.recursive === true });
				return null;
			}
			case "rm": {
				const file = await local(machine, args.path);
				if (file === machine.root) throw new CallError(`${WORKSPACE} itself can't be deleted`, "EPERM");
				await fs.rm(file, { recursive: args.recursive === true, force: args.force === true });
				return null;
			}
			case "rename": {
				const from = await local(machine, args.from);
				const to = await local(machine, args.to);
				await fs.rename(from, to);
				return null;
			}
			case "readdir": {
				const folder = await local(machine, args.path);
				const names = (await fs.readdir(folder)).sort();
				const entries = [];
				for (const name of page(names, args)) {
					const full = path.join(folder, name);
					const link = await fs.lstat(full);
					// A link's size and type are its target's, when it has one.
					const stat = link.isSymbolicLink() ? await fs.stat(full).catch(() => link) : link;
					entries.push({
						name,
						parentPath: virtualOf(machine, folder),
						size: stat.isDirectory() ? 0 : stat.size,
						mtime: stat.mtimeMs,
						isFile: stat.isFile(),
						isDirectory: stat.isDirectory(),
						isSymbolicLink: link.isSymbolicLink(),
					});
				}
				return entries;
			}
			case "find": {
				const folder = await local(machine, args.path ?? WORKSPACE);
				const pattern = globPattern(String(args.pattern ?? "**"));
				const found = [];
				const end = Number(args.offset ?? 0) + Number(args.limit ?? Number.POSITIVE_INFINITY);
				for await (const entry of walk(folder, globs(args.exclude))) {
					if (!pattern.test(entry.relative)) continue;
					found.push({ path: virtualOf(machine, entry.local), type: entry.directory ? "dir" : "file" });
					if (found.length >= end) break;
				}
				return page(found, args);
			}
			case "grep": {
				const target = await local(machine, args.path ?? WORKSPACE);
				const query = String(args.query ?? "");
				const flags = args.ignoreCase === true ? "i" : "";
				const matcher = args.regex === true ? new RegExp(query, flags) : new RegExp(query.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), flags);
				const context = Math.min(Number(args.context ?? 0), 10);
				const include = args.include === undefined ? null : globs(args.include);
				const end = Number(args.offset ?? 0) + Number(args.limit ?? Number.POSITIVE_INFINITY);
				const files: string[] = [];
				if ((await fs.stat(target)).isDirectory()) {
					for await (const entry of walk(target, globs(args.exclude))) {
						if (entry.directory || (include && !include.some((glob) => glob.test(entry.relative)))) continue;
						files.push(entry.local);
					}
				} else files.push(target);
				const matches = [];
				for (const file of files) {
					for (const match of await grepFile(file, matcher, context).catch(() => [])) {
						matches.push({ path: virtualOf(machine, file), ...match });
					}
					if (matches.length >= end) break;
				}
				return page(matches, args);
			}
			case "exec": {
				if (typeof args.command !== "string" || args.command.trim() === "") throw new CallError("command must be a shell command", "EINVAL");
				const cwd = args.cwd === undefined ? machine.root : await local(machine, args.cwd);
				return await machine.exec(args as ExecArgs, cwd);
			}
			case "native_tool":
				return await nativeTool(machine, args);
			default:
				throw new CallError(`This computer doesn't know the call ${op}. Update pim-computer.`, "ENOSYS");
		}
	} catch (error) {
		throw failure(error, at);
	}
}

/** Keeps a stream's first and last `max / 2` bytes, and says whether it dropped any in between. */
class Output {
	readonly #half: number;
	#head = Buffer.alloc(0);
	#tail: Buffer[] = [];
	#tailBytes = 0;
	dropped = false;

	constructor(max: number) {
		this.#half = Math.floor(max / 2);
	}

	add(chunk: Buffer): void {
		if (this.#head.length < this.#half) {
			const room = this.#half - this.#head.length;
			this.#head = Buffer.concat([this.#head, chunk.subarray(0, room)]);
			chunk = chunk.subarray(room);
		}
		if (chunk.length === 0) return;
		this.#tail.push(chunk);
		this.#tailBytes += chunk.length;
		while (this.#tailBytes - (this.#tail[0]?.length ?? 0) >= this.#half) {
			this.#tailBytes -= this.#tail.shift()!.length;
			this.dropped = true;
		}
	}

	text(): string {
		let tail = Buffer.concat(this.#tail);
		if (tail.length > this.#half) {
			tail = tail.subarray(tail.length - this.#half);
			this.dropped = true;
		}
		const head = this.#head.toString("utf8");
		return this.dropped ? `${head}\n[… output cut …]\n${tail.toString("utf8")}` : head + tail.toString("utf8");
	}
}

/** Runs a command in a login shell, in its own process group, killed with it at the timeout. `$PIM_WORKSPACE` is the root. */
async function runCommand({ command, timeoutMs = 120_000, maxBytes = 64_000 }: ExecArgs, cwd: string, root: string): Promise<ExecResult> {
	const { spawn } = await import("node:child_process");
	const shell = process.env.SHELL || "/bin/bash";
	const child = spawn(shell, ["-lc", command], { cwd, detached: true, stdio: ["ignore", "pipe", "pipe"], env: { ...process.env, PIM_WORKSPACE: root } });
	const stdout = new Output(maxBytes);
	const stderr = new Output(maxBytes);
	child.stdout!.on("data", (chunk: Buffer) => stdout.add(chunk));
	child.stderr!.on("data", (chunk: Buffer) => stderr.add(chunk));
	let timedOut = false;
	const timer = setTimeout(() => {
		timedOut = true;
		try {
			process.kill(-child.pid!, "SIGKILL");
		} catch {
			child.kill("SIGKILL");
		}
	}, timeoutMs);
	return new Promise((resolve) => {
		child.on("error", (error) => {
			clearTimeout(timer);
			resolve({ exitCode: null, signal: null, stdout: "", stderr: error.message, timedOut: false, truncated: false });
		});
		child.on("close", (exitCode, signal) => {
			clearTimeout(timer);
			resolve({ exitCode, signal, stdout: stdout.text(), stderr: stderr.text(), timedOut, truncated: stdout.dropped || stderr.dropped });
		});
	});
}

/** How long the browser runs with nobody connected to it before it quits; its profile stays. */
const BROWSER_IDLE_MS = 30 * 60_000;

/** Chrome or Chromium on this computer, where it's in the usual places or on the PATH. */
async function findChrome(): Promise<string | undefined> {
	const candidates =
		process.platform === "darwin"
			? ["/Applications/Google Chrome.app/Contents/MacOS/Google Chrome", "/Applications/Chromium.app/Contents/MacOS/Chromium"]
			: (process.env.PATH ?? "")
					.split(path.delimiter)
					.filter(Boolean)
					.flatMap((folder) => ["google-chrome-stable", "google-chrome", "chromium", "chromium-browser", "chrome"].map((name) => path.join(folder, name)));
	for (const candidate of candidates) {
		try {
			await fs.access(candidate, fs.constants.X_OK);
			return candidate;
		} catch {}
	}
	return undefined;
}

/**
 * Chrome keeps the cookies of sign-ins that last only "for the session"
 * when it restores the last session on starting, so it's set to; and a
 * browser that was ended without quitting starts as if it had quit.
 */
async function keepSessions(profile: string): Promise<void> {
	const file = path.join(profile, "Default", "Preferences");
	let preferences: { session?: Record<string, unknown>; profile?: Record<string, unknown> } = {};
	try {
		preferences = JSON.parse(await fs.readFile(file, "utf8"));
	} catch {}
	preferences.session = { ...preferences.session, restore_on_startup: 1 };
	preferences.profile = { ...preferences.profile, exit_type: "Normal", exited_cleanly: true };
	await fs.mkdir(path.dirname(file), { recursive: true });
	await fs.writeFile(file, JSON.stringify(preferences));
}

/**
 * The computer's own Chrome, with a profile of its own that keeps what's
 * signed in there between runs. It starts when the space first connects to
 * it, headless unless asked otherwise, and quits after `BROWSER_IDLE_MS`
 * with nobody connected. A Chrome left running with the profile, by an
 * earlier run of this program, is used as it is.
 */
function localBrowser(executable: string, profile: string, headful: boolean, log: (line: string) => void): BrowserHost {
	let child: import("node:child_process").ChildProcess | undefined;
	let starting: Promise<string> | undefined;
	let connections = 0;
	let idle: ReturnType<typeof setTimeout> | undefined;
	const portFile = path.join(profile, "DevToolsActivePort");

	/** The DevTools address of the browser running with the profile, or undefined when none is. */
	const running = async (): Promise<string | undefined> => {
		let lines: string[];
		try {
			lines = (await fs.readFile(portFile, "utf8")).split("\n");
		} catch {
			return undefined;
		}
		try {
			const response = await fetch(`http://127.0.0.1:${lines[0]}/json/version`, { signal: AbortSignal.timeout(2_000) });
			const { webSocketDebuggerUrl } = (await response.json()) as { webSocketDebuggerUrl: string };
			return webSocketDebuggerUrl;
		} catch {
			return undefined;
		}
	};

	const start = async (): Promise<string> => {
		const { spawn } = await import("node:child_process");
		await fs.mkdir(profile, { recursive: true });
		await fs.rm(portFile, { force: true });
		await keepSessions(profile);
		const args = [
			"--remote-debugging-port=0",
			`--user-data-dir=${profile}`,
			"--no-first-run",
			"--no-default-browser-check",
			"--password-store=basic",
			"--use-mock-keychain",
			"--disable-dev-shm-usage",
			"--window-size=1280,800",
			...(headful ? [] : ["--headless=new"]),
			// Chrome's sandbox can't run as root, as in a container.
			...(process.getuid?.() === 0 ? ["--no-sandbox"] : []),
			// No page to open: it opens the pages it had (`keepSessions`), which another page would join each time.
		];
		log(`Starting the browser: ${executable}`);
		const started = spawn(executable, args, { stdio: ["ignore", "ignore", "pipe"] });
		child = started;
		let errors = "";
		started.stderr!.on("data", (chunk: Buffer) => {
			errors = (errors + chunk.toString("utf8")).slice(-2_000);
		});
		let exited = false;
		started.on("exit", () => {
			exited = true;
			if (child === started) child = undefined;
		});
		for (let waited = 0; waited < 30_000; waited += 100) {
			if (exited) throw new CallError(`The browser quit as it started: ${errors.trim() || "it said nothing"}`, "EBROWSER");
			const address = await running();
			if (address) return address;
			await new Promise((resolve) => setTimeout(resolve, 100));
		}
		started.kill("SIGKILL");
		throw new CallError("The browser didn't start within 30 seconds.", "EBROWSER");
	};

	const stop = async () => {
		clearTimeout(idle);
		const address = await running();
		if (address) {
			// Asked to quit, it saves the profile, cookies and all, and goes; it's ended if it hasn't after a while.
			const socket = new WebSocket(address);
			socket.addEventListener("open", () => socket.send(JSON.stringify({ id: 1, method: "Browser.close" })));
			socket.addEventListener("error", () => {});
			for (let waited = 0; waited < 15_000 && (child ? child.exitCode === null && child.signalCode === null : (await running()) !== undefined); waited += 200) {
				await new Promise((resolve) => setTimeout(resolve, 200));
			}
		}
		child?.kill("SIGKILL");
		child = undefined;
		await fs.rm(portFile, { force: true });
	};

	return {
		running: async () => (await running()) !== undefined,
		stop,
		async connect(onMessage, onClose) {
			clearTimeout(idle);
			const address = (await running()) ?? (await (starting ??= start().finally(() => (starting = undefined))));
			const socket = new WebSocket(address);
			await new Promise<void>((resolve, reject) => {
				socket.addEventListener("open", () => resolve(), { once: true });
				socket.addEventListener("error", () => reject(new CallError("Couldn't connect to the browser.", "EBROWSER")), { once: true });
			});
			connections++;
			let open = true;
			const closed = () => {
				if (!open) return;
				open = false;
				if (--connections === 0) {
					clearTimeout(idle);
					idle = setTimeout(() => {
						log("Nobody has used the browser for a while, so it quits.");
						void stop();
					}, BROWSER_IDLE_MS);
				}
				onClose();
			};
			socket.addEventListener("message", (event) => onMessage(String(event.data)));
			socket.addEventListener("close", closed);
			return {
				send: (data) => {
					if (socket.readyState === WebSocket.OPEN) socket.send(data);
				},
				close: () => {
					socket.close();
					closed();
				},
			};
		},
	};
}

const USAGE = `pim-computer ${VERSION}: connects this machine to your Pim, for your agents to use.

  PIM_URL=https://pim.example.com PIM_COMPUTER_TOKEN=pimc_… node pim-computer.ts

Options (or the environment variables in brackets):
  --url <address>   Your Pim's address (PIM_URL)
  --token <token>   The token from Settings → Computer (PIM_COMPUTER_TOKEN, or a file named by PIM_COMPUTER_TOKEN_FILE)
  --root <folder>   The folder your files are kept in (PIM_COMPUTER_ROOT; ~/pim unless set)
  --chrome <path>   The Chrome or Chromium your agents browse with (PIM_CHROME; found where it usually is unless set)
  --headful         Show the browser's window rather than running it headless (PIM_BROWSER_HEADFUL=1)
  --stdio           Speak with the space over standard input and output, as Pim starts it on computers it starts

The browser keeps its profile, with what you sign in to there, in ~/.pim-computer/browser.`;

async function main(): Promise<void> {
	const { parseArgs } = await import("node:util");
	const os = await import("node:os");
	const { values } = parseArgs({
		options: {
			url: { type: "string" },
			token: { type: "string" },
			root: { type: "string" },
			chrome: { type: "string" },
			headful: { type: "boolean" },
			stdio: { type: "boolean" },
			help: { type: "boolean" },
		},
	});
	const env = process.env;
	const tokenFile = env.PIM_COMPUTER_TOKEN_FILE;
	const url = values.url ?? env.PIM_URL;
	const token = values.token ?? env.PIM_COMPUTER_TOKEN ?? (tokenFile ? (await fs.readFile(tokenFile, "utf8")).trim() : undefined);
	if (values.help || (!values.stdio && (!url || !token))) {
		console.log(USAGE);
		process.exit(values.help ? 0 : 1);
	}
	const folder = path.resolve(values.root ?? env.PIM_COMPUTER_ROOT ?? path.join(os.homedir(), "pim"));
	await fs.mkdir(folder, { recursive: true });
	const root = await fs.realpath(folder);
	// Standard output is the space's, with --stdio.
	const log = (line: string) => (values.stdio ? console.error : console.log)(`${new Date().toISOString()} ${line}`);
	const chrome = values.chrome ?? env.PIM_CHROME ?? (await findChrome());
	const headful = values.headful === true || env.PIM_BROWSER_HEADFUL === "1";
	const browser = chrome ? localBrowser(chrome, path.join(os.homedir(), ".pim-computer", "browser"), headful, log) : undefined;
	if (!chrome) log("No Chrome or Chromium found, so your agents have no browser here. Install one, or name it with --chrome.");
	const machine: Machine = { root, exec: (args, cwd) => runCommand(args, cwd, root), ...(browser ? { browser } : {}) };
	const hello = {
		type: "hello",
		version: 1,
		agent: `pim-computer/${VERSION}`,
		hostname: os.hostname(),
		platform: os.platform(),
		arch: os.arch(),
		release: os.release(),
		user: os.userInfo().username,
		root: machine.root,
		shell: env.SHELL || "/bin/bash",
		browser: chrome ?? null,
	};
	const logRun = (message: string) => {
		if (message.startsWith('{"type":"call"') && message.includes('"op":"exec"')) {
			const call = JSON.parse(message) as { args?: { command?: unknown } };
			log(`Running: ${String(call.args?.command)}`);
		}
	};
	if (values.stdio) {
		const link = new Link(machine, (message) => process.stdout.write(`${message}\n`));
		process.stdout.write(`${JSON.stringify(hello)}\n`);
		const { createInterface } = await import("node:readline");
		const lines = createInterface({ input: process.stdin, crlfDelay: Number.POSITIVE_INFINITY });
		lines.on("line", (line) => {
			logRun(line);
			link.receive(line);
		});
		// The space let go: the browser quits, so what's signed in there is saved, and so does this.
		lines.on("close", async () => {
			link.close();
			await browser?.stop().catch(() => undefined);
			process.exit(0);
		});
		return;
	}
	const address = new URL("/api/computer/connect", url!.replace(/^http/, "ws"));
	let wait = 1_000;
	const connect = () => {
		// Node's WebSocket (undici) takes headers, so the token stays out of the address.
		const socket = new (WebSocket as unknown as new (url: URL, init: unknown) => WebSocket)(address, { headers: { Authorization: `Bearer ${token}` } });
		let ping: ReturnType<typeof setInterval> | undefined;
		const link = new Link(machine, (message) => {
			if (socket.readyState === WebSocket.OPEN) socket.send(message);
		});
		socket.addEventListener("open", () => {
			wait = 1_000;
			log(`Connected to ${url}, with ${machine.root} as ${WORKSPACE}.`);
			socket.send(JSON.stringify(hello));
			// The space answers "ping" without waking; it keeps the connection through proxies and NATs.
			ping = setInterval(() => socket.send("ping"), 30_000);
		});
		socket.addEventListener("message", (event) => {
			if (typeof event.data !== "string" || event.data === "pong") return;
			logRun(event.data);
			link.receive(event.data);
		});
		socket.addEventListener("close", (event) => {
			clearInterval(ping);
			link.close();
			if (event.code === REPLACED) {
				log("Another computer connected with this token, so this one stops.");
				process.exit(1);
			}
			// A token Pim doesn't know is refused before the connection opens, which looks the same as being offline.
			log(`${ping ? "Disconnected" : "Couldn't connect"}${event.reason ? ` (${event.reason})` : ""}; trying again in ${wait / 1000} s.`);
			setTimeout(connect, wait);
			wait = Math.min(wait * 2, 60_000);
		});
		socket.addEventListener("error", () => {
			// "close" follows, and tries again.
		});
	};
	connect();
}

// Run as a program, not when tests import `handle`.
if (typeof process !== "undefined" && process.argv?.[1] && import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href) void main();
