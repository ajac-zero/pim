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
 * Where it runs Cua's cua-spacesd, as the computers a Pim's host keeps do
 * (./pim-host.ts), its desktop is streamed to the person through this
 * connection too (`spacesdScreen`).
 *
 * Runs on Node.js 22.18 or later. The Pim's install script, which Settings
 * shows with the token, gets Node.js where it's missing and runs `install`,
 * which keeps this running as the user's own service (`Service`):
 *
 *   curl -fsSL https://pim.example.com/install.sh | sh -s -- computer pimc_…
 *
 * Or run it in the foreground:
 *
 *   PIM_URL=https://pim.example.com PIM_COMPUTER_TOKEN=pimc_… node pim-computer.ts
 *
 * Settings take flags too: `--url`, `--token`, `--root`, `--chrome`. The token can also
 * be in a file named by `PIM_COMPUTER_TOKEN_FILE`.
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
	/** Its desktop, for the person to see and use, or none where nothing streams it. */
	readonly screen?: ScreenHost;
};

/**
 * The computer's desktop as a stream the person's app plays: Cua's media
 * plane (rcdp wire v2), whose messages pass through this program and the
 * space unread, text as text and video as binary.
 */
export type ScreenHost = {
	/** Opens a stream of the desktop, with the person's input going back into it. */
	open(onMessage: (data: string | Uint8Array) => void, onClose: () => void): Promise<ScreenChannel>;
};

export type ScreenChannel = { send(data: string): void; close(): void };

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
 * messages between it and the browser, and the desktop's stream between it
 * and the person's app. The space has one DevTools connection at a time;
 * opening another closes the one before, which may have been left by a
 * space that went to sleep. It may have several streams of the desktop,
 * one for each app showing it.
 */
export class Link {
	readonly #machine: Machine;
	readonly #send: (message: string | Uint8Array) => void;
	#channel: { id: number; browser: BrowserChannel } | null = null;
	#next = 1;
	readonly #screens = new Map<number, ScreenChannel>();

	constructor(machine: Machine, send: (message: string | Uint8Array) => void) {
		this.#machine = machine;
		this.#send = send;
	}

	/** A message from the space: a call, which gets a reply, a DevTools message for the browser, or the person's input to the desktop. */
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
		if (message.type === "screen") {
			if (typeof message.data === "string") this.#screens.get(Number(message.channel))?.send(message.data);
			return;
		}
		if (message.type !== "call" || typeof message.id !== "string" || typeof message.op !== "string") return;
		const { id } = message;
		this.#call(message.op, (message.args ?? {}) as Args).then(
			(result) => this.#send(JSON.stringify({ type: "reply", id, result })),
			(error: CallError) => this.#send(JSON.stringify({ type: "reply", id, error: { message: error.message, code: error.code } })),
		);
	}

	/** The space went away: its DevTools connection and the desktop's streams close, and the browser goes on running. */
	close(): void {
		this.#channel?.browser.close();
		this.#channel = null;
		for (const screen of this.#screens.values()) screen.close();
		this.#screens.clear();
	}

	/**
	 * Opens a stream of the desktop on the channel the space numbered, so it
	 * knows the stream's first messages. Its text messages go to the space
	 * as `screen` messages; its binary ones as binary, after the channel's
	 * number in four bytes.
	 */
	async #openScreen(channel: unknown): Promise<null> {
		const screen = this.#machine.screen;
		if (!screen) throw new CallError("This computer doesn't stream its desktop: it needs Cua's cua-spacesd.", "ENOSYS");
		if (typeof channel !== "number" || !Number.isInteger(channel) || channel < 1 || channel > 0xffffffff || this.#screens.has(channel)) {
			throw new CallError(`${String(channel)} isn't a channel for a new stream`, "EINVAL");
		}
		let closed = false;
		const opened = await screen.open(
			(data) => {
				if (closed) return;
				if (typeof data === "string") {
					this.#send(JSON.stringify({ type: "screen", channel, data }));
					return;
				}
				const framed = new Uint8Array(data.byteLength + 4);
				new DataView(framed.buffer).setUint32(0, channel);
				framed.set(data, 4);
				this.#send(framed);
			},
			() => {
				if (closed) return;
				closed = true;
				this.#screens.delete(channel);
				this.#send(JSON.stringify({ type: "screen_closed", channel }));
			},
		);
		if (!closed) this.#screens.set(channel, opened);
		return null;
	}

	async #call(op: string, args: Args): Promise<unknown> {
		if (op === "screen_open") return this.#openScreen(args.channel);
		if (op === "screen_close") {
			const screen = this.#screens.get(Number(args.channel));
			this.#screens.delete(Number(args.channel));
			screen?.close();
			return null;
		}
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
 * it, headless unless asked otherwise. Headless, it quits after
 * `BROWSER_IDLE_MS` with nobody connected; with its windows on a desktop,
 * where the person may be using it too, it stays open. A Chrome running
 * with the profile, left by an earlier run of this program or opened by
 * the person, is used as it is.
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
				if (--connections === 0 && !headful) {
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

/** A protobuf field's key: its number and wire type. */
function protoKey(field: number, wire: number): number[] {
	return protoVarint(field * 8 + wire);
}

function protoVarint(value: number): number[] {
	const bytes = [];
	while (value > 127) {
		bytes.push((value % 128) | 128);
		value = Math.floor(value / 128);
	}
	bytes.push(value);
	return bytes;
}

/** A length-delimited field: a string or a message. */
function protoBytes(field: number, bytes: number[] | Uint8Array): number[] {
	return [...protoKey(field, 2), ...protoVarint(bytes.length), ...bytes];
}

/** The fields of a protobuf message that are strings or messages, by number; the last of each. */
function protoFields(message: Uint8Array): Map<number, Uint8Array> {
	const fields = new Map<number, Uint8Array>();
	let at = 0;
	const varint = () => {
		let value = 0;
		for (let scale = 1; ; scale *= 128) {
			const byte = message[at++];
			if (byte === undefined) throw new Error("A cut-off protobuf message");
			value += (byte & 127) * scale;
			if (byte < 128) return value;
		}
	};
	while (at < message.length) {
		const key = varint();
		const wire = key % 8;
		if (wire === 0) varint();
		else if (wire === 1) at += 8;
		else if (wire === 5) at += 4;
		else if (wire === 2) {
			const length = varint();
			fields.set(Math.floor(key / 8), message.subarray(at, at + length));
			at += length;
		} else throw new Error(`A protobuf wire type this doesn't read: ${wire}`);
	}
	return fields;
}

/** Calls a method of cua-spacesd over gRPC-Web, with a message already encoded; its answer, encoded. */
async function grpcWeb(base: string, token: string, method: string, message: number[]): Promise<Uint8Array> {
	const body = new Uint8Array(5 + message.length);
	new DataView(body.buffer).setUint32(1, message.length);
	body.set(message, 5);
	const response = await fetch(new URL(`/${method}`, base), {
		method: "POST",
		headers: { "content-type": "application/grpc-web+proto", "x-grpc-web": "1", authorization: `Bearer ${token}` },
		body,
		signal: AbortSignal.timeout(15_000),
	});
	const bytes = new Uint8Array(await response.arrayBuffer());
	let answer: Uint8Array | undefined;
	let trailers = response.headers.get("grpc-status") === null ? "" : `grpc-status:${response.headers.get("grpc-status")}\r\ngrpc-message:${response.headers.get("grpc-message") ?? ""}`;
	for (let at = 0; at + 5 <= bytes.length; ) {
		const length = new DataView(bytes.buffer, bytes.byteOffset + at + 1, 4).getUint32(0);
		const part = bytes.subarray(at + 5, at + 5 + length);
		if ((bytes[at]! & 0x80) !== 0) trailers = new TextDecoder().decode(part);
		else answer = part;
		at += 5 + length;
	}
	const status = /grpc-status:\s*(\d+)/.exec(trailers)?.[1];
	if (!response.ok || status !== "0" || !answer) {
		const why = decodeURIComponent(/grpc-message:\s*([^\r\n]*)/.exec(trailers)?.[1] ?? "") || `HTTP ${response.status}`;
		throw new CallError(`cua-spacesd refused ${method}: ${why}`, "ESPACESD");
	}
	return answer;
}

/**
 * The desktop as Cua's cua-spacesd on this computer streams it, at `base`
 * with the token in `tokenFile` (Cua's images keep it at /run/cua/env-token,
 * readable by the desktop's user). Each stream is a media session of its
 * own: H.264 of the whole display, with the person's input allowed to
 * activate windows, as at the computer itself.
 */
export function spacesdScreen(base: string, tokenFile: string): ScreenHost {
	return {
		async open(onMessage, onClose) {
			let token: string;
			try {
				token = (await fs.readFile(tokenFile, "utf8")).trim();
			} catch {
				throw new CallError(`This computer doesn't stream its desktop: there's no cua-spacesd token at ${tokenFile}.`, "ENOSYS");
			}
			// OpenMediaRequest: the primary display, H.264, at most 30 frames a second and 3 Mbit/s,
			// input that may activate windows, and a minute to attach.
			const request = [
				...protoBytes(1, protoBytes(1, new TextEncoder().encode("primary"))),
				...protoKey(2, 0),
				1,
				...protoKey(3, 0),
				30,
				...protoKey(5, 0),
				...protoVarint(3000),
				...protoKey(6, 0),
				3,
				...protoBytes(8, [...protoKey(1, 0), 60]),
			];
			const opened = protoFields(await grpcWeb(base, token, "cua.env.v1.StreamService/OpenMedia", request));
			const session = new TextDecoder().decode(opened.get(1));
			const path = new TextDecoder().decode(opened.get(4));
			const closeSession = () => {
				const message = protoBytes(1, new TextEncoder().encode(session));
				void grpcWeb(base, token, "cua.env.v1.StreamService/CloseMedia", message).catch(() => undefined);
			};
			const socket = new WebSocket(new URL(path, base.replace(/^http/, "ws")).href, ["rcdp.v2"]);
			socket.binaryType = "arraybuffer";
			// The stream speaks first, as soon as it's open, so it's listened to from the start.
			socket.addEventListener("message", (event) => onMessage(typeof event.data === "string" ? event.data : new Uint8Array(event.data as ArrayBuffer)));
			socket.addEventListener("error", () => {});
			await new Promise<void>((resolve, reject) => {
				socket.addEventListener("open", () => resolve(), { once: true });
				socket.addEventListener("close", () => {
					closeSession();
					reject(new CallError("cua-spacesd closed the desktop's stream as it opened.", "ESPACESD"));
					onClose();
				});
			});
			return {
				send: (data) => {
					if (socket.readyState === WebSocket.OPEN) socket.send(data);
				},
				close: () => socket.close(1000),
			};
		},
	};
}

/**
 * A program of Pim's kept running as the user's own service, which starts it
 * at login (or boot, where systemd lets the user linger) and again whenever
 * it stops: a systemd user service, a launchd agent on macOS, or else a loop
 * in the background, which nothing starts again after the machine restarts.
 * The service runs `run`, a script in the program's folder that gets the
 * Pim's newest copy of the program and starts it. pim-host.ts, which the
 * Pim serves beside this, keeps itself running with these too.
 */
export type Service = {
	readonly name: string;
	readonly description: string;
	/** Its folder, where `run`, `log` (where systemd doesn't keep it) and `loop.pid` are. */
	readonly dir: string;
	/** Started with the desktop's session, as on the computers a Pim's host keeps, rather than at login or boot. */
	readonly desktop?: boolean;
};

type ServiceKind = "systemd" | "launchd" | "loop";

/** Runs a command, quietly; how it exited, and what it said. */
export async function quietly(command: string, args: string[]): Promise<{ code: number; output: string }> {
	const { spawn } = await import("node:child_process");
	return new Promise((resolve) => {
		const child = spawn(command, args, { stdio: ["ignore", "pipe", "pipe"] });
		let output = "";
		child.stdout.on("data", (chunk: Buffer) => (output += chunk.toString("utf8")));
		child.stderr.on("data", (chunk: Buffer) => (output += chunk.toString("utf8")));
		child.on("error", (error) => resolve({ code: -1, output: error.message }));
		child.on("close", (code) => resolve({ code: code ?? -1, output }));
	});
}

/** Writes `content` to `file` unless it's there already; whether it changed. */
export async function writeChanged(file: string, content: string, mode = 0o644): Promise<boolean> {
	const before = await fs.readFile(file, "utf8").catch(() => null);
	if (before === content) return false;
	await fs.mkdir(path.dirname(file), { recursive: true });
	await fs.writeFile(file, content, { mode });
	await fs.chmod(file, mode);
	return true;
}

export const shellQuote = (value: string) => `'${value.replaceAll("'", `'"'"'`)}'`;

async function serviceKind(): Promise<ServiceKind> {
	if (process.platform === "darwin") return "launchd";
	if (process.platform === "linux" && (await quietly("systemctl", ["--user", "show-environment"])).code === 0) return "systemd";
	return "loop";
}

const unitFile = (service: Service, home: string) => path.join(home, ".config", "systemd", "user", `${service.name}.service`);
const plistFile = (service: Service, home: string) => path.join(home, "Library", "LaunchAgents", `dev.pim.${service.name}.plist`);
const launchdTarget = (service: Service) => `gui/${process.getuid?.()}/dev.pim.${service.name}`;

/** Whether the background loop runs, by its process group. */
async function loopRunning(service: Service): Promise<number | null> {
	const pid = Number(await fs.readFile(path.join(service.dir, "loop.pid"), "utf8").catch(() => ""));
	if (!pid) return null;
	try {
		process.kill(pid, 0);
		return pid;
	} catch {
		return null;
	}
}

/**
 * Sets the service up to run `service.dir/run`, and starts it: again, when
 * `restart` (what it runs changed), or else only if it isn't running. Which
 * kind it is, and whether it starts again after the machine restarts.
 */
export async function startService(service: Service, restart: boolean): Promise<{ kind: ServiceKind; atBoot: boolean }> {
	const os = await import("node:os");
	const home = os.homedir();
	const run = path.join(service.dir, "run");
	const kind = await serviceKind();
	if (kind === "systemd") {
		const changed = await writeChanged(
			unitFile(service, home),
			`[Unit]
Description=${service.description}
${service.desktop ? "After=graphical-session.target\nPartOf=graphical-session.target\n" : ""}
[Service]
ExecStart=${run}
Restart=always
RestartSec=5
# A browser it starts goes on running across its restarts, and the new one uses it.
KillMode=process

[Install]
WantedBy=${service.desktop ? "graphical-session.target" : "default.target"}
`,
		);
		if (changed) await quietly("systemctl", ["--user", "daemon-reload"]);
		await quietly("systemctl", ["--user", "enable", `${service.name}.service`]);
		const started = await quietly("systemctl", ["--user", restart || changed ? "restart" : "start", `${service.name}.service`]);
		if (started.code !== 0) throw new Error(`systemd didn't start ${service.name}: ${started.output.trim()}`);
		// Lingering runs the user's services from boot, without signing in; the desktop's session starts its own.
		const user = os.userInfo().username;
		const lingers = async () => (await quietly("loginctl", ["show-user", user, "--property=Linger"])).output.includes("Linger=yes");
		if (!service.desktop && !(await lingers())) await quietly("loginctl", ["enable-linger", user]);
		return { kind, atBoot: service.desktop === true || (await lingers()) };
	}
	if (kind === "launchd") {
		const changed = await writeChanged(
			plistFile(service, home),
			`<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
	<key>Label</key><string>dev.pim.${service.name}</string>
	<key>ProgramArguments</key><array><string>${run}</string></array>
	<key>RunAtLoad</key><true/>
	<key>KeepAlive</key><true/>
	<key>StandardOutPath</key><string>${path.join(service.dir, "log")}</string>
	<key>StandardErrorPath</key><string>${path.join(service.dir, "log")}</string>
</dict>
</plist>
`,
		);
		const loaded = (await quietly("launchctl", ["print", launchdTarget(service)])).code === 0;
		if (loaded && (restart || changed)) await quietly("launchctl", ["bootout", launchdTarget(service)]);
		if (!loaded || restart || changed) {
			const started = await quietly("launchctl", ["bootstrap", `gui/${process.getuid?.()}`, plistFile(service, home)]);
			// The agent belongs to the desktop's login session, which an SSH session alone doesn't have.
			if (started.code !== 0) throw new Error(`launchd didn't start ${service.name}: sign in to this Mac's desktop, then run this again. (${started.output.trim()})`);
		}
		return { kind, atBoot: false };
	}
	await startLoop(service, restart);
	return { kind, atBoot: false };
}

/** Starts the background loop, in a process group of its own, unless it runs and needn't restart. */
async function startLoop(service: Service, restart: boolean): Promise<void> {
	const running = await loopRunning(service);
	if (running && !restart) return;
	if (running) process.kill(-running, "SIGTERM");
	const { spawn } = await import("node:child_process");
	const log = await fs.open(path.join(service.dir, "log"), "a");
	const loop = `echo $$ >${shellQuote(path.join(service.dir, "loop.pid"))}; while :; do ${shellQuote(path.join(service.dir, "run"))}; sleep 5; done`;
	// What it runs with is `run`'s to say, not what this was started with.
	const env = Object.fromEntries(Object.entries(process.env).filter(([name]) => !name.startsWith("PIM_")));
	spawn("/bin/sh", ["-c", loop], { detached: true, env, stdio: ["ignore", log.fd, log.fd] }).unref();
	await log.close();
}

/** Restarts the service as it's set up, which gets the Pim's newest copy of the program. */
export async function restartService(service: Service): Promise<boolean> {
	const state = await serviceState(service);
	if (!state) return false;
	if (state.kind === "systemd") await quietly("systemctl", ["--user", "restart", `${service.name}.service`]);
	else if (state.kind === "launchd") await quietly("launchctl", ["kickstart", "-k", launchdTarget(service)]);
	else await startLoop(service, true);
	return true;
}

/** Whether the service is set up, which kind it is, and whether it runs. */
export async function serviceState(service: Service): Promise<{ kind: ServiceKind; running: boolean } | null> {
	const os = await import("node:os");
	const kind = await serviceKind();
	if (kind === "systemd") {
		if (!(await fs.stat(unitFile(service, os.homedir())).catch(() => null))) return (await loopRunning(service)) ? { kind: "loop", running: true } : null;
		return { kind, running: (await quietly("systemctl", ["--user", "is-active", `${service.name}.service`])).output.trim() === "active" };
	}
	if (kind === "launchd") {
		if (!(await fs.stat(plistFile(service, os.homedir())).catch(() => null))) return null;
		return { kind, running: /state = running/.test((await quietly("launchctl", ["print", launchdTarget(service)])).output) };
	}
	const running = await loopRunning(service);
	return running ? { kind, running: true } : null;
}

/** Stops the service and removes it. */
export async function removeService(service: Service): Promise<void> {
	const os = await import("node:os");
	const home = os.homedir();
	const kind = await serviceKind();
	if (kind === "systemd" && (await fs.stat(unitFile(service, home)).catch(() => null))) {
		await quietly("systemctl", ["--user", "disable", "--now", `${service.name}.service`]);
		await fs.rm(unitFile(service, home));
		await quietly("systemctl", ["--user", "daemon-reload"]);
	}
	if (kind === "launchd") {
		await quietly("launchctl", ["bootout", launchdTarget(service)]);
		await fs.rm(plistFile(service, home), { force: true });
	}
	const loop = await loopRunning(service);
	if (loop) process.kill(-loop, "SIGTERM");
}

/** Shows the service's log: the last lines, and what comes next too when someone's watching. */
export async function showLog(service: Service): Promise<void> {
	const { spawn } = await import("node:child_process");
	const follow = process.stdout.isTTY ? ["-f"] : [];
	const state = await serviceState(service);
	const [command, args] =
		state?.kind === "systemd"
			? ["journalctl", ["--user", "--unit", `${service.name}.service`, "--lines", "100", "--no-pager", ...follow]]
			: ["tail", ["-n", "100", ...follow, path.join(service.dir, "log")]];
	await new Promise((resolve) => spawn(command, args as string[], { stdio: "inherit" }).on("close", resolve));
}

/** A command named `name` on the PATH, in ~/.local/bin, that runs this program with this Node.js. */
export async function installCommand(name: string, program: string): Promise<string | null> {
	const os = await import("node:os");
	const bin = path.join(os.homedir(), ".local", "bin");
	await writeChanged(path.join(bin, name), `#!/bin/sh\nexec ${shellQuote(process.execPath)} ${shellQuote(program)} "$@"\n`, 0o755);
	return (process.env.PATH ?? "").split(":").includes(bin) ? null : bin;
}

const computerService = async (desktop = false): Promise<Service> => {
	const os = await import("node:os");
	return { name: "pim-computer", description: "pim-computer: this computer's connection to its Pim", dir: path.join(os.homedir(), ".pim-computer"), desktop };
};

/**
 * `pim-computer install`: pim-computer as the user's service (see
 * `Service`), connecting with `token` (or the one it has), and a
 * `pim-computer` command to manage it. Running it again sets it up again,
 * and restarts it if what it runs with changed.
 */
async function install(values: Record<string, string | boolean | undefined>): Promise<void> {
	const os = await import("node:os");
	const env = process.env;
	const service = await computerService(values.desktop === true);
	const dir = service.dir;
	const url = (values.url as string | undefined) ?? env.PIM_URL;
	if (!url) throw new Error("Give your Pim's address with --url.");
	await fs.mkdir(dir, { recursive: true, mode: 0o700 });
	const tokenFile = path.join(dir, "token");
	const token = (values.token as string | undefined) || env.PIM_COMPUTER_TOKEN || (await fs.readFile(tokenFile, "utf8").catch(() => "")).trim();
	if (!token) throw new Error("Give the token from Settings → Computer with --token.");
	// The program lives in its folder, where `run` updates it; one run from elsewhere is copied there.
	const program = path.join(dir, "pim-computer.ts");
	const self = realpathSync(process.argv[1]!);
	if (self !== program) await fs.copyFile(self, program);
	const settings: [string, string | undefined][] = [
		["PIM_URL", url],
		["PIM_COMPUTER_TOKEN_FILE", tokenFile],
		// Commands run with the PATH of whoever installed it, as in their terminal, not the service manager's short one.
		["PATH", env.PATH],
		["PIM_COMPUTER_ROOT", values.root ? path.resolve(values.root as string) : undefined],
		["PIM_CHROME", values.chrome as string | undefined],
		["PIM_BROWSER_HEADFUL", values.headful ? "1" : undefined],
		["PIM_SPACESD_URL", values.spacesd as string | undefined],
	];
	const changed = [
		await writeChanged(tokenFile, `${token}\n`, 0o600),
		await writeChanged(
			path.join(dir, "env"),
			settings
				.filter(([, value]) => value)
				.map(([name, value]) => `${name}=${shellQuote(value!)}\n`)
				.join(""),
			0o600,
		),
		await writeChanged(
			path.join(dir, "run"),
			`#!/bin/sh
# Starts pim-computer with the Pim's newest copy, when it can be had, in the desktop's session where there is one.
DIR=${shellQuote(dir)}
[ -r /run/cua-desktop/desktop.env ] && { set -a; . /run/cua-desktop/desktop.env; set +a; }
set -a; . "$DIR/env"; set +a
curl -fsSL --max-time 30 "$PIM_URL/pim-computer.ts" -o "$DIR/next.ts" && mv "$DIR/next.ts" "$DIR/pim-computer.ts"
exec ${shellQuote(process.execPath)} "$DIR/pim-computer.ts"
`,
			0o755,
		),
	].some(Boolean);
	const { kind, atBoot } = await startService(service, changed);
	const bin = await installCommand("pim-computer", program);
	const root = values.root ? path.resolve(values.root as string) : path.join(os.homedir(), "pim");
	console.log(`pim-computer ${VERSION} is installed and running, connecting to ${url}, with your files in ${root}.`);
	if (kind === "systemd" && !atBoot && !service.desktop) {
		console.log(`It runs while you're signed in. To run it from boot, without signing in: sudo loginctl enable-linger ${os.userInfo().username}`);
	}
	if (kind === "loop") console.log("This machine has no systemd for you, so it runs in the background until the machine restarts: run `pim-computer install` again then.");
	console.log(`Manage it with: pim-computer status | logs | update | uninstall${bin ? ` (add ${bin} to your PATH)` : ""}`);
}

/** `pim-computer status`: whether it's installed and runs, where it connects, and its last words. */
async function status(): Promise<void> {
	const service = await computerService();
	const state = await serviceState(service);
	if (!state) {
		console.log("pim-computer isn't installed here: run the command Settings → Computer gives.");
		process.exitCode = 1;
		return;
	}
	const env = await fs.readFile(path.join(service.dir, "env"), "utf8").catch(() => "");
	const url = /^PIM_URL='(.*)'$/m.exec(env)?.[1];
	const how = { systemd: "a systemd user service", launchd: "a launchd agent", loop: "a loop in the background" }[state.kind];
	console.log(`pim-computer ${VERSION}, for ${url ?? "no Pim"}: ${state.running ? "running" : "not running"}, as ${how}.`);
	if (!state.running) process.exitCode = 1;
}

/** `pim-computer uninstall`: stops it, and removes it and its token, browser profile and command; the files stay. */
async function uninstall(): Promise<void> {
	const os = await import("node:os");
	const service = await computerService();
	await removeService(service);
	await fs.rm(service.dir, { recursive: true, force: true });
	await fs.rm(path.join(os.homedir(), ".local", "bin", "pim-computer"), { force: true });
	console.log("pim-computer is uninstalled: this computer no longer connects to your Pim. Your files are still where they were; remove the computer in Settings → Computer too.");
}

const USAGE = `pim-computer ${VERSION}: connects this machine to your Pim, for your agents to use.

  curl -fsSL https://pim.example.com/install.sh | sh -s -- computer pimc_…

installs it as your service, which keeps it running, and a pim-computer command:

  pim-computer status      Whether it's running, and for which Pim
  pim-computer logs        What it did lately
  pim-computer update      Restart it with your Pim's newest pim-computer
  pim-computer uninstall   Stop it and remove it (your files stay)

Or run it yourself:

  PIM_URL=https://pim.example.com PIM_COMPUTER_TOKEN=pimc_… node pim-computer.ts

Options (or the environment variables in brackets):
  --url <address>   Your Pim's address (PIM_URL)
  --token <token>   The token from Settings → Computer (PIM_COMPUTER_TOKEN, or a file named by PIM_COMPUTER_TOKEN_FILE)
  --root <folder>   The folder your files are kept in (PIM_COMPUTER_ROOT; ~/pim unless set)
  --chrome <path>   The Chrome or Chromium your agents browse with (PIM_CHROME; found where it usually is unless set)
  --headful         Show the browser's windows rather than running it headless (PIM_BROWSER_HEADFUL=1)
  --spacesd <url>   Where Cua's cua-spacesd streams this computer's desktop (PIM_SPACESD_URL; http://127.0.0.1:3211),
                    with its token in the file PIM_SPACESD_TOKEN_FILE names (/run/cua/env-token)

install takes the same options, which the service then runs with, and --desktop, to start with the desktop's
session rather than at login or boot. The browser keeps its profile, with what you sign in to there, in
~/.pim-computer/browser.`;

async function main(): Promise<void> {
	const { parseArgs } = await import("node:util");
	const os = await import("node:os");
	const { values, positionals } = parseArgs({
		allowPositionals: true,
		options: {
			url: { type: "string" },
			token: { type: "string" },
			root: { type: "string" },
			chrome: { type: "string" },
			headful: { type: "boolean" },
			spacesd: { type: "string" },
			desktop: { type: "boolean" },
			help: { type: "boolean" },
		},
	});
	const command = positionals[0];
	if (command && !values.help) {
		const commands: Record<string, () => Promise<void>> = {
			install: () => install(values),
			status,
			logs: async () => showLog(await computerService()),
			update: async () => {
				if (!(await restartService(await computerService()))) throw new Error("pim-computer isn't installed here.");
				console.log("pim-computer restarted with your Pim's newest copy.");
			},
			uninstall,
		};
		if (!commands[command]) {
			console.log(USAGE);
			process.exit(1);
		}
		try {
			await commands[command]();
		} catch (error) {
			console.error((error as Error).message);
			process.exit(1);
		}
		return;
	}
	const env = process.env;
	const tokenFile = env.PIM_COMPUTER_TOKEN_FILE;
	const url = values.url ?? env.PIM_URL;
	const token = values.token ?? env.PIM_COMPUTER_TOKEN ?? (tokenFile ? (await fs.readFile(tokenFile, "utf8")).trim() : undefined);
	if (values.help || !url || !token) {
		console.log(USAGE);
		process.exit(values.help ? 0 : 1);
	}
	const folder = path.resolve(values.root ?? env.PIM_COMPUTER_ROOT ?? path.join(os.homedir(), "pim"));
	await fs.mkdir(folder, { recursive: true });
	const root = await fs.realpath(folder);
	const log = (line: string) => console.log(`${new Date().toISOString()} ${line}`);
	const chrome = values.chrome ?? env.PIM_CHROME ?? (await findChrome());
	const headful = values.headful === true || env.PIM_BROWSER_HEADFUL === "1";
	const browser = chrome ? localBrowser(chrome, path.join(os.homedir(), ".pim-computer", "browser"), headful, log) : undefined;
	if (!chrome) log("No Chrome or Chromium found, so your agents have no browser here. Install one, or name it with --chrome.");
	// The desktop streams where cua-spacesd runs, as it does on the computers a Pim's host keeps: its token is the sign.
	const spacesdTokenFile = env.PIM_SPACESD_TOKEN_FILE ?? "/run/cua/env-token";
	const screen = await fs
		.access(spacesdTokenFile, fs.constants.R_OK)
		.then(() => spacesdScreen(values.spacesd ?? env.PIM_SPACESD_URL ?? "http://127.0.0.1:3211", spacesdTokenFile))
		.catch(() => undefined);
	const machine: Machine = { root, exec: (args, cwd) => runCommand(args, cwd, root), ...(browser ? { browser } : {}), ...(screen ? { screen } : {}) };
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
		screen: screen !== undefined,
	};
	const logRun = (message: string) => {
		if (message.startsWith('{"type":"call"') && message.includes('"op":"exec"')) {
			const call = JSON.parse(message) as { args?: { command?: unknown } };
			log(`Running: ${String(call.args?.command)}`);
		}
	};
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
