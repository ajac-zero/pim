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
 * connection too (`spacesdScreen`), and the agents use its apps with Cua
 * Driver's tools (`spacesdDriver`).
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
import type { ChildProcess } from "node:child_process";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { type FSWatcher, realpathSync, statSync, watch } from "node:fs";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { pathToFileURL } from "node:url";
import type { TriggersHost, TriggersHostOptions } from "./triggers-host.ts";

export const VERSION = "0.2.0";

/**
 * The revision of what the space and this computer say to each other. 2 is
 * where writes became conditional (`expectedHash`), `write` took `from`, and
 * `stat` gave a file's sha256 and `watch` existed; a computer that says less
 * is worked with through fallbacks, and asked to update.
 */
export const PROTOCOL_VERSION = 2;

/** The folder the space's file calls name; it is `root` on this machine. */
export const WORKSPACE = "/workspace";

/** The close code a connection gets when another computer connects in its place. */
export const REPLACED = 4409;

/** The close code the space gives a connection whose computer speaks an older protocol: it should update itself, then connect again. */
export const OUTDATED = 4410;

/** The most bytes one read returns; larger files are read in parts. */
export const MAX_READ_BYTES = 1_048_576;

/** A failure the space gets back, with a code like Node's (`ENOENT`) where there is one. */
export class CallError extends Error {
	readonly code: string | undefined;
	/** Set when a write's condition wasn't met: the space turns it into a typed conflict. */
	readonly conflict: FileConflict | undefined;
	constructor(message: string, code?: string, conflict?: FileConflict) {
		super(message);
		this.code = code;
		this.conflict = conflict;
	}
}

/** The largest file whose sha256 `stat` and `write` give: the hash is the whole file's bytes, so bigger files have none. */
export const HASH_MAX_BYTES = 5 * 1_048_576;

/** Why a conditional write didn't happen, with what the file is now (null where it isn't there, or has no hash). */
export type FileConflict = {
	readonly error: "conflict";
	readonly code: "hash_mismatch" | "missing" | "exists";
	readonly path: string;
	readonly expectedHash: string;
	readonly currentHash: string | null;
	readonly currentSize: number | null;
	readonly currentMtime: number | null;
};

/** What a write gives back: the file as it is now. */
export type WriteResult = { readonly path: string; readonly sha256: string | null; readonly size: number; readonly mtime: number };

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

export type ExecArgs = { readonly command: string; readonly cwd?: string; readonly timeoutMs?: number; readonly maxBytes?: number; readonly thread?: string; readonly env?: Readonly<Record<string, string>>; /** Variables taken out of the process environment before `env` is added. */ readonly unset?: readonly string[]; /** Hears the output as it comes, stdout and stderr together. */ readonly onOutput?: (text: string) => void };

/** Where this computer keeps the space's files, how it runs commands, and its browser (tests give their own). */
export type Machine = {
	/** The real path of the folder `/workspace` stands for. */
	readonly root: string;
	exec(args: ExecArgs, cwd: string): Promise<ExecResult>;
	/** The primary browser, where the person signs in, or none where this computer has no Chrome. */
	readonly browser?: BrowserHost;
	/** Each agent's browser, a context of its own in one shared headless Chrome; without it, a call that names a thread gets the primary one (tests give theirs). */
	readonly agentBrowsers?: AgentBrowsers;
	/** Its desktop, for the person to see and use, or none where nothing streams it. */
	readonly screen?: ScreenHost;
	/** Cua Driver, for the agents to use its desktop's apps, or none where cua-spacesd doesn't run. */
	readonly driver?: DriverHost;
	/** Where this computer's displayd leases each thread its own display, or none (tests give their own). */
	readonly displays?: DisplayHost;
	/** The backends of the space's apps that run here, or none where nothing supervises them (tests give their own). */
	readonly apps?: Apps;
	/** What each thread's commands printed, for the person to watch; none where nobody keeps it (tests give their own). */
	readonly terminals?: Terminals;
};

/**
 * Cua Driver's tools on this computer (Cua's MCP server for using a
 * desktop: windows, apps' accessibility trees, pointer and keys, which act
 * without taking the person's pointer or focus), as cua-spacesd serves them.
 * A call names one of its tools; the answer is the tool's MCP result.
 */
export type DriverHost = {
	call(tool: string, args: Record<string, unknown>): Promise<DriverResult>;
};

export type DriverResult = { readonly content: readonly unknown[]; readonly structuredContent?: unknown; readonly isError?: boolean };

/**
 * The computer's desktop as a stream the person's app plays: Cua's media
 * plane (rcdp wire v2), whose messages pass through this program and the
 * space unread, text as text and video as binary.
 */
export type ScreenHost = {
	/** Opens a stream of the desktop, with the person's input going back into it. */
	open(onMessage: (data: string | Uint8Array) => void, onClose: () => void): Promise<ScreenChannel>;
	/** The text on the desktop's clipboard, for the person to copy back out; empty when there is none. */
	clipboard(): Promise<string>;
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

/** A DevTools connection to a browser; the note, when there is one, is what the agent should read first (as that no sign-ins were copied in). */
export type BrowserChannel = { send(data: string): void; close(): void; readonly note?: string };

/**
 * One connection to the space: answers its calls, and carries DevTools
 * messages between it and the browsers, and the desktop's stream between it
 * and the person's app. The space has one DevTools connection for each
 * thread (and one for calls that name none); opening another for the same
 * one closes the one before, which may have been left by a space that went
 * to sleep. It may have several streams of the desktop,
 * one for each app showing it.
 */
export class Link {
	readonly #machine: Machine;
	readonly #send: (message: string | Uint8Array) => void;
	/** The DevTools connections, by the thread they're for ("" for the primary browser). */
	readonly #channels = new Map<string, { id: number; browser: BrowserChannel }>();
	#next = 1;
	readonly #screens = new Map<number, ScreenChannel>();
	/** The files the space watches, whose changes go to it as `event` messages. */
	readonly #watches: Watches;

	constructor(machine: Machine, send: (message: string | Uint8Array) => void) {
		this.#machine = machine;
		this.#send = send;
		this.#watches = new Watches(machine, (event) => this.#send(JSON.stringify(event)));
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
			const channel = [...this.#channels.values()].find((one) => one.id === message.channel);
			if (channel && typeof message.data === "string") channel.browser.send(message.data);
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
			(error: CallError) => this.#send(JSON.stringify({ type: "reply", id, error: { message: error.message, code: error.code, ...(error.conflict ? { conflict: error.conflict } : {}) } })),
		);
	}

	/** The space went away: its DevTools connection and the desktop's streams close, and the browser goes on running. */
	close(): void {
		for (const key of [...this.#channels.keys()]) this.#closeChannel(key);
		for (const screen of this.#screens.values()) screen.close();
		this.#screens.clear();
		this.#watches.closeAll();
	}

	#closeChannel(key: string): void {
		const channel = this.#channels.get(key);
		this.#channels.delete(key);
		channel?.browser.close();
	}

	/**
	 * Opens a stream of the desktop on the channel the space numbered, so it
	 * knows the stream's first messages. Its text messages go to the space
	 * as `screen` messages; its binary ones as binary, after the channel's
	 * number in four bytes.
	 */
	async #openScreen(channel: unknown, display?: string): Promise<null> {
		const screen = display ? await this.#displayScreen(display) : this.#machine.screen;
		if (!screen) throw new CallError("This computer doesn't stream its desktop: it needs Cua's cua-spacesd.", "ENOSYS");
		if (typeof channel !== "number" || !Number.isInteger(channel) || channel < 1 || channel > 0xffffffff || this.#screens.has(channel)) {
			throw new CallError(`${String(channel)} isn't a channel for a new stream`, "EINVAL");
		}
		let closed = false;
		let timer: ReturnType<typeof setInterval> | undefined;
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
				clearInterval(timer);
				this.#screens.delete(channel);
				this.#send(JSON.stringify({ type: "screen_closed", channel }));
			},
		);
		let watched: ScreenChannel = opened;
		if (!closed && display) {
			// A watched display must not idle out: the person's viewing is a touch, every 30 seconds while the stream is open.
			const touch = () => void this.#machine.displays?.touchViewer?.(display).catch(() => undefined);
			touch();
			timer = setInterval(touch, VIEWER_TOUCH_MS);
			watched = {
				send: (data) => opened.send(data),
				close: () => {
					clearInterval(timer);
					opened.close();
				},
			};
		}
		if (!closed) this.#screens.set(channel, watched);
		return null;
	}

	/** The stream source of the display a thread holds now, never leasing one. */
	async #displayScreen(display: string): Promise<ScreenHost> {
		const displays = this.#machine.displays;
		if (!displays?.screenOf) throw new CallError(NO_DISPLAY, "ENOSYS");
		return displays.screenOf(display);
	}

	async #call(op: string, args: Args): Promise<unknown> {
		if (op === "driver" && typeof args.thread === "string" && args.thread !== "") {
			if (!this.#machine.displays) throw new CallError(NO_DISPLAY, "ENOSYS");
			if (typeof args.tool !== "string") throw new CallError("tool must name one of Cua Driver's tools", "EINVAL");
			return this.#machine.displays.call(args.thread, args.tool, (args.arguments ?? {}) as Args);
		}
		if (op === "driver") {
			const driver = this.#machine.driver;
			if (!driver) throw new CallError("This computer has no desktop tools: they need Cua's cua-spacesd.", "ENOSYS");
			if (typeof args.tool !== "string") throw new CallError("tool must name one of Cua Driver's tools", "EINVAL");
			return driver.call(args.tool, (args.arguments ?? {}) as Args);
		}
		if (op.startsWith("app_")) return appCall(this.#machine, op, args);
		// The space times its round trip to here, for the Computer dialog.
		if (op === "ping") return null;
		if (op === "watch") return this.#watches.watch(args.path);
		if (op === "unwatch") return this.#watches.unwatch(args.path);
		if (op === "unwatch_all") return this.#watches.reset();
		if (op === "write") {
			const written = await handle(this.#machine, op, args);
			if (written) await this.#watches.noteWrite(args.path, written as WriteResult);
			return written;
		}
		const display = typeof args.display === "string" && args.display !== "" ? args.display : undefined;
		if (op === "screen_open") return this.#openScreen(args.channel, display);
		if (op === "displays_list") {
			if (!this.#machine.displays?.list) throw new CallError(NO_DISPLAY, "ENOSYS");
			return this.#machine.displays.list();
		}
		if (op === "display_control") {
			if (!this.#machine.displays?.control) throw new CallError(NO_DISPLAY, "ENOSYS");
			if (typeof args.thread !== "string" || args.thread === "") throw new CallError("thread must name the thread whose display it is", "EINVAL");
			if (args.mode !== "user" && args.mode !== "agent") throw new CallError("mode must be 'user' or 'agent'", "EINVAL");
			return this.#machine.displays.control(args.thread, args.mode);
		}
		if (op === "screen_clipboard") {
			const screen = display ? await this.#displayScreen(display) : this.#machine.screen;
			if (!screen) throw new CallError("This computer doesn't stream its desktop: it needs Cua's cua-spacesd.", "ENOSYS");
			return screen.clipboard();
		}
		if (op === "screen_close") {
			const screen = this.#screens.get(Number(args.channel));
			this.#screens.delete(Number(args.channel));
			screen?.close();
			return null;
		}
		if (!op.startsWith("browser_")) return handle(this.#machine, op, args);
		const browser = this.#machine.browser;
		// A call that names a thread is for the browser of the agent it names (or, from a viewer, of the agent the thread browses as); never the primary one.
		const thread = typeof args.thread === "string" && args.thread !== "" ? args.thread : undefined;
		const agent = typeof args.agent === "string" && args.agent !== "" ? args.agent : undefined;
		const agentBrowsers = thread === undefined ? undefined : this.#machine.agentBrowsers;
		// A viewer of a thread's window (which names no agent) has a channel beside the agent's own, so watching doesn't cut the agent off.
		const key = thread === undefined ? "" : agentBrowsers && !agent ? `view ${thread}` : thread;
		if (op === "browser_status") {
			const running = agentBrowsers ? await agentBrowsers.running(thread!, agent) : browser ? await browser.running() : false;
			// `agents` says the agents browse in a browser of their own here, never in the primary one.
			return { available: browser !== undefined, running, ...(this.#machine.agentBrowsers ? { agents: true } : {}) };
		}
		if (!browser) throw new CallError("This computer has no browser: install Google Chrome or Chromium there, or name one with PIM_CHROME, and restart pim-computer.", "ENOSYS");
		switch (op) {
			case "browser_connect": {
				this.#closeChannel(key);
				const id = this.#next++;
				const onMessage = (data: string) => {
					if (this.#channels.get(key)?.id === id) this.#send(JSON.stringify({ type: "cdp", channel: id, data }));
				};
				const onClose = () => {
					if (this.#channels.get(key)?.id !== id) return;
					this.#channels.delete(key);
					this.#send(JSON.stringify({ type: "cdp_closed", channel: id }));
				};
				const link: BrowserChannel & { context?: string } = await (agentBrowsers ? agentBrowsers.connect(thread!, agent, onMessage, onClose) : browser.connect(onMessage, onClose));
				this.#channels.set(key, { id, browser: link });
				return { channel: id, ...(link.context ? { context: link.context } : {}), ...(link.note ? { note: link.note } : {}) };
			}
			case "browser_disconnect": {
				// By the channel it names, whoever it was opened for.
				const open = [...this.#channels].find(([, one]) => one.id === args.channel);
				if (open) this.#closeChannel(open[0]);
				return null;
			}
			case "browser_stop":
				if (!agentBrowsers) this.#closeChannel(key);
				await (agentBrowsers ? agentBrowsers.stop(thread!, agent) : browser.stop());
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

function sha256(bytes: Uint8Array): string {
	return createHash("sha256").update(bytes).digest("hex");
}

/**
 * Puts a file at `file` that nothing sees half written: its content goes to a
 * file beside it, which is synced and then renamed over it, with the mode the
 * file had (or `mode` for a new one). A link there is followed, so the
 * link's target is the one replaced. `expected` is a condition on what's
 * there: a sha256 it must have, or "absent" for a file that mustn't exist; the
 * file is read again right before the rename. A writer that renames its own
 * file between that read and the rename is the race left: the compare and the
 * rename are two steps, as a file system has no compare-and-swap.
 */
async function replace(virtual: string, file: string, source: { data: Buffer } | { temp: string }, expected: string | undefined, mode: number | undefined): Promise<WriteResult> {
	// A dangling link has no target to follow: it is replaced, not written through.
	const target = await fs.realpath(file).catch((error) => {
		if ((error as { code?: string }).code === "ENOENT") return file;
		throw error;
	});
	const temp = "temp" in source ? source.temp : path.join(path.dirname(target), `.${path.basename(target)}.pim-${randomUUID()}`);
	try {
		if (!("temp" in source)) {
			const handle = await fs.open(temp, "wx", mode ?? 0o666);
			try {
				await handle.writeFile(source.data);
				await handle.sync();
			} finally {
				await handle.close();
			}
		}
		const before = await fs.stat(target).catch((error) => {
			if ((error as { code?: string }).code === "ENOENT") return null;
			throw error;
		});
		if (before?.isDirectory()) throw new CallError(`EISDIR: is a directory, open '${virtual}'`, "EISDIR");
		if (expected !== undefined) {
			const now = before;
			const hash = now && now.size <= HASH_MAX_BYTES ? sha256(await fs.readFile(target)) : null;
			const code = now === null ? (expected === "absent" ? undefined : "missing") : expected === "absent" ? "exists" : hash === expected ? undefined : "hash_mismatch";
			if (code) {
				const conflict: FileConflict = { error: "conflict", code, path: virtual, expectedHash: expected, currentHash: hash, currentSize: now?.size ?? null, currentMtime: now?.mtimeMs ?? null };
				throw new CallError(`${virtual} ${code === "exists" ? "already exists" : code === "missing" ? "is gone" : "changed since it was read"}`, "conflict", conflict);
			}
		}
		if (before) await fs.chmod(temp, before.mode & 0o7777);
		const written = await fs.stat(temp);
		const hash = written.size <= HASH_MAX_BYTES ? sha256("data" in source ? source.data : await fs.readFile(temp)) : null;
		await fs.rename(temp, target);
		return { path: virtual, sha256: hash, size: written.size, mtime: written.mtimeMs };
	} catch (error) {
		await fs.rm(temp, { force: true }).catch(() => undefined);
		throw error;
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

/** How long a file must be quiet before its change is reported: a burst of writes is one event. */
export const WATCH_DEBOUNCE_MS = 100;
/** The most files one connection may watch at once; the next `watch` fails with `EWATCHLIMIT`. */
export const MAX_WATCHES = 64;
/** How many watched files are read and hashed at once; a burst across many files waits its turn. */
const MAX_CONCURRENT_HASHES = 4;

/** What the space hears when a file it watches changes (or its watcher fails); `path` is the one the space named. */
export type WatchEvent =
	| { readonly type: "event"; readonly event: "file_changed"; readonly path: string; readonly kind: "modified" | "created" | "deleted" | "renamed"; readonly sha256: string | null; readonly size: number | null; readonly mtime: number | null }
	| { readonly type: "event"; readonly event: "watch_error"; readonly path: string; readonly code: string | null };

type FileState = { readonly exists: boolean; readonly ino: number | null; readonly sha256: string | null; readonly size: number | null; readonly mtime: number | null };

/** What changes in a file, as far as the space cares: its bytes (or, past the hash limit, its size and time). */
function signature(state: FileState): string {
	return state.exists ? (state.sha256 ?? `${state.size}:${state.mtime}`) : "gone";
}

let hashing = 0;
const hashQueue: (() => void)[] = [];

async function fileState(file: string): Promise<FileState> {
	while (hashing >= MAX_CONCURRENT_HASHES) await new Promise<void>((resolve) => hashQueue.push(resolve));
	hashing++;
	try {
		return await readState(file);
	} finally {
		hashing--;
		hashQueue.shift()?.();
	}
}

async function readState(file: string): Promise<FileState> {
	try {
		const stat = await fs.stat(file);
		const hash = stat.isFile() && stat.size <= HASH_MAX_BYTES ? sha256(await fs.readFile(file)) : null;
		return { exists: true, ino: stat.ino, sha256: hash, size: stat.size, mtime: stat.mtimeMs };
	} catch {
		return { exists: false, ino: null, sha256: null, size: null, mtime: null };
	}
}

type Watched = {
	refs: number;
	/** The path as the space first named it, which its events carry. */
	virtual: string;
	file: string;
	folder: Folder;
	timer: ReturnType<typeof setTimeout> | undefined;
	/** What was last reported (or seeded by `watch`, or written by this computer): events only come from a different state. */
	last: FileState;
	/** The checks run one after another. */
	chain: Promise<void>;
	closed: boolean;
};

/** The one OS watch on a folder, shared by every watched file in it. */
type Folder = {
	dir: string;
	watcher: FSWatcher;
	/** The folder's inode when it was watched: a folder deleted and made again (or renamed over) is a different one, and the OS watch on the old goes quiet without an error. */
	ino: number;
	timer: ReturnType<typeof setTimeout> | undefined;
	/** The OS named the folder itself in an event, as it does when the folder is deleted or moved: its watch is made again even when a new folder has the same inode, which is common. */
	named: boolean;
	entries: Set<Watched>;
};

/**
 * The files a space watches. The folder holding each file is what's watched,
 * by name, rather than the file: a write that renames a new file over it (as
 * every write of ours does) leaves a watcher on the file itself on the old
 * one, and a file that isn't there yet is seen when it's made. Files in one
 * folder share its watcher. A watch counts how many times it was asked for,
 * and its file is let go with the last. When a folder's events come, the
 * folder is looked at again once they are quiet: if it is no longer the same
 * folder, the watch is made again on the new one, or, with no folder there,
 * each of its files sends `watch_error` once and is dropped.
 */
class Watches {
	readonly #watched = new Map<string, Watched>();
	readonly #folders = new Map<string, Folder>();
	readonly #machine: Machine;
	readonly #emit: (event: WatchEvent) => void;

	constructor(machine: Machine, emit: (event: WatchEvent) => void) {
		this.#machine = machine;
		this.#emit = emit;
	}

	/** Where a file is for certain: a link is followed, as a write does, and a file that isn't there is in its folder as it is now. */
	async #resolve(virtual: unknown): Promise<string> {
		const file = await local(this.#machine, virtual);
		try {
			return await fs.realpath(file);
		} catch (error) {
			if ((error as { code?: string }).code !== "ENOENT") throw failure(error, String(virtual));
		}
		try {
			return path.join(await fs.realpath(path.dirname(file)), path.basename(file));
		} catch (error) {
			throw failure(error, String(virtual));
		}
	}

	async watch(virtual: unknown): Promise<{ watching: true; sha256: string | null; size: number | null; exists: boolean }> {
		const file = await this.#resolve(virtual);
		const known = this.#watched.get(file);
		if (known) {
			known.refs++;
			await known.chain;
			return this.#answer(known.last);
		}
		if ((await fs.stat(file).catch(() => null))?.isDirectory()) throw new CallError(`${String(virtual)} is a directory: only files can be watched`, "EISDIR");
		// Another watch for the file may have got here while it was looked at.
		if (this.#watched.has(file)) return this.watch(virtual);
		if (this.#watched.size >= MAX_WATCHES) throw new CallError(`At most ${MAX_WATCHES} files can be watched at once`, "EWATCHLIMIT");
		const made: Watched = { refs: 1, virtual: String(virtual), file, folder: undefined as never, timer: undefined, last: { exists: false, ino: null, sha256: null, size: null, mtime: null }, chain: Promise.resolve(), closed: false };
		try {
			made.folder = this.#folder(path.dirname(file));
		} catch (error) {
			throw failure(error, String(virtual));
		}
		made.folder.entries.add(made);
		this.#watched.set(file, made);
		// The file is read after the watcher starts, so a change in between is not missed; checks wait for it.
		made.chain = fileState(file).then((state) => void (made.last = state));
		await made.chain;
		return this.#answer(made.last);
	}

	/** The shared watch on a folder, made when its first file is watched. */
	#folder(dir: string): Folder {
		const known = this.#folders.get(dir);
		if (known) return known;
		const folder: Folder = { dir, watcher: undefined as never, ino: 0, timer: undefined, named: false, entries: new Set() };
		this.#arm(folder);
		this.#folders.set(dir, folder);
		return folder;
	}

	#arm(folder: Folder): void {
		const watcher = watch(folder.dir, { persistent: false }, (_event, name) => {
			for (const entry of folder.entries) if (name === null || name === undefined || String(name) === path.basename(entry.file)) this.#touched(entry);
			// An event that may be the folder itself going away or being replaced is looked at once things are quiet.
			if (name !== null && name !== undefined && String(name) === path.basename(folder.dir)) folder.named = true;
			clearTimeout(folder.timer);
			folder.timer = setTimeout(() => void this.#revalidate(folder), WATCH_DEBOUNCE_MS);
		});
		// The error listener comes first, and a watcher that can't be set up completely is closed, so none is left running unowned.
		watcher.on("error", (error) => this.#fail(folder, (error as { code?: string }).code ?? null));
		try {
			folder.ino = statSync(folder.dir).ino;
		} catch (error) {
			watcher.close();
			throw error;
		}
		folder.watcher = watcher;
	}

	#fail(folder: Folder, code: string | null): void {
		for (const entry of [...folder.entries]) {
			this.#emit({ type: "event", event: "watch_error", path: entry.virtual, code });
			this.#release(entry);
		}
	}

	async #revalidate(folder: Folder): Promise<void> {
		if (this.#folders.get(folder.dir) !== folder) return;
		const now = await fs.stat(folder.dir).catch(() => null);
		if (this.#folders.get(folder.dir) !== folder || (now && now.ino === folder.ino && !folder.named)) return;
		folder.named = false;
		folder.watcher.close();
		try {
			if (!now) throw Object.assign(new Error("The folder is gone"), { code: "ENOENT" });
			this.#arm(folder);
		} catch (error) {
			this.#fail(folder, (error as { code?: string }).code ?? null);
			return;
		}
		// The files may have changed while nothing was watching.
		for (const entry of folder.entries) this.#touched(entry);
	}

	#answer(state: FileState): { watching: true; sha256: string | null; size: number | null; exists: boolean } {
		return { watching: true, sha256: state.sha256, size: state.size, exists: state.exists };
	}

	async unwatch(virtual: unknown): Promise<{ watching: boolean }> {
		let file: string;
		try {
			file = await this.#resolve(virtual);
		} catch {
			return { watching: false };
		}
		const entry = this.#watched.get(file);
		if (!entry) return { watching: false };
		if (--entry.refs > 0) return { watching: true };
		this.#release(entry);
		return { watching: false };
	}

	/** This computer wrote the file: what it wrote is known, so it isn't a change to report. */
	async noteWrite(virtual: unknown, written: WriteResult): Promise<void> {
		let file: string;
		try {
			file = await this.#resolve(virtual);
		} catch {
			return;
		}
		const entry = this.#watched.get(file);
		if (!entry) return;
		// Its inode is kept, so the next change from outside is told from a rename by comparing with the file we wrote.
		const ino = (await fs.stat(file).catch(() => null))?.ino ?? null;
		entry.last = { exists: true, ino, sha256: written.sha256, size: written.size, mtime: written.mtime };
	}

	/** Lets every watch go: the space asks again for the ones it still has. */
	reset(): { watching: false } {
		this.closeAll();
		return { watching: false };
	}

	closeAll(): void {
		for (const entry of [...this.#watched.values()]) this.#release(entry);
	}

	#release(entry: Watched): void {
		entry.closed = true;
		clearTimeout(entry.timer);
		if (this.#watched.get(entry.file) === entry) this.#watched.delete(entry.file);
		const folder = entry.folder;
		folder.entries.delete(entry);
		if (folder.entries.size === 0) {
			clearTimeout(folder.timer);
			folder.watcher.close();
			if (this.#folders.get(folder.dir) === folder) this.#folders.delete(folder.dir);
		}
	}

	#touched(entry: Watched): void {
		clearTimeout(entry.timer);
		entry.timer = setTimeout(() => {
			entry.chain = entry.chain.then(() => this.#check(entry)).catch(() => undefined);
		}, WATCH_DEBOUNCE_MS);
	}

	async #check(entry: Watched): Promise<void> {
		if (entry.closed) return;
		const now = await fileState(entry.file);
		if (entry.closed) return;
		const before = entry.last;
		if (signature(now) === signature(before)) {
			entry.last = { ...now, ino: now.ino ?? before.ino };
			return;
		}
		entry.last = now;
		const kind = !before.exists ? "created" : !now.exists ? "deleted" : before.ino !== null && before.ino !== now.ino ? "renamed" : "modified";
		this.#emit({ type: "event", event: "file_changed", path: entry.virtual, kind, sha256: now.sha256, size: now.size, mtime: now.exists ? now.mtime : null });
	}
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
					sha256: stat.isFile() && stat.size <= HASH_MAX_BYTES ? sha256(await fs.readFile(file)) : null,
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
				if (args.append === true) {
					await fs.appendFile(file, data);
					return null;
				}
				const expected = args.expectedHash === undefined || args.expectedHash === null ? undefined : String(args.expectedHash);
				// `from` is a file beside the target that was written in parts: it takes the target's place, under the same condition.
				const from = typeof args.from === "string" ? await local(machine, args.from) : undefined;
				return await replace(String(args.path), file, from === undefined ? { data } : { temp: from }, expected, mode);
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
				// A thread that already holds a display runs its commands in it; a plain command never makes one. Without one, the
				// person's own display is taken out of its environment, so a GUI program fails instead of landing on their screen.
				const env = typeof args.thread === "string" && machine.displays ? await machine.displays.envOf(args.thread) : undefined;
				const unset = typeof args.thread === "string" && machine.displays && !env ? DISPLAY_VARIABLES : undefined;
				// The person watches a thread's commands as they run (`terminal_read`).
				const shown = typeof args.thread === "string" ? machine.terminals?.start(args.thread, args.command, typeof args.cwd === "string" ? args.cwd : WORKSPACE) : undefined;
				try {
					const result = await machine.exec({ ...(args as ExecArgs), ...(env ? { env } : {}), ...(unset ? { unset } : {}), ...(shown ? { onOutput: shown.write } : {}) }, cwd);
					shown?.end(result);
					return result;
				} catch (error) {
					shown?.end({ exitCode: null, signal: null, timedOut: false });
					throw error;
				}
			}
			case "terminal_read":
				if (typeof args.thread !== "string" || args.thread === "") throw new CallError("thread must name the thread whose commands to read", "EINVAL");
				return machine.terminals?.read(args.thread, typeof args.version === "number" ? args.version : undefined) ?? { version: 0, commands: [] };
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

/** One command a thread ran, as its terminal shows it. */
export type TerminalCommand = { id: number; command: string; cwd: string; startedAt: number; endedAt: number | null; exitCode: number | null; signal: string | null; timedOut: boolean; output: string };

/** How many of a thread's commands its terminal keeps, how much of each one's output (its end), and how many threads' terminals are kept. */
const TERMINAL_COMMANDS = 20;
const TERMINAL_OUTPUT_CHARS = 32_000;
const TERMINAL_THREADS = 100;

/**
 * What each thread's commands printed, as they run: the last twenty commands of each of the last hundred
 * threads to run one, with the end of their output, kept in memory for the person to watch. `version`
 * counts every change to a thread's terminal, so a reader that has seen it gets no copy again.
 */
export class Terminals {
	readonly #threads = new Map<string, { version: number; next: number; commands: TerminalCommand[] }>();
	readonly #now: () => number;

	constructor(now: () => number = Date.now) {
		this.#now = now;
	}

	/** A command the thread starts: `write` adds to what it printed, `end` says how it ended. */
	start(thread: string, command: string, cwd: string): { write(text: string): void; end(result: Pick<ExecResult, "exitCode" | "signal" | "timedOut">): void } {
		let terminal = this.#threads.get(thread);
		this.#threads.delete(thread);
		terminal ??= { version: 0, next: 1, commands: [] };
		this.#threads.set(thread, terminal);
		while (this.#threads.size > TERMINAL_THREADS) this.#threads.delete(this.#threads.keys().next().value!);
		const entry: TerminalCommand = { id: terminal.next++, command, cwd, startedAt: this.#now(), endedAt: null, exitCode: null, signal: null, timedOut: false, output: "" };
		terminal.commands.push(entry);
		if (terminal.commands.length > TERMINAL_COMMANDS) terminal.commands.shift();
		terminal.version++;
		const live = terminal;
		return {
			write: (text) => {
				if (!text) return;
				entry.output += text;
				if (entry.output.length > TERMINAL_OUTPUT_CHARS) entry.output = entry.output.slice(-TERMINAL_OUTPUT_CHARS);
				live.version++;
			},
			end: (result) => {
				entry.endedAt = this.#now();
				entry.exitCode = result.exitCode;
				entry.signal = result.signal;
				entry.timedOut = result.timedOut;
				live.version++;
			},
		};
	}

	/** The thread's commands, oldest first, or only its version when that is `seen`. */
	read(thread: string, seen?: number): { version: number; commands?: TerminalCommand[] } {
		const terminal = this.#threads.get(thread);
		if (!terminal) return { version: 0, commands: [] };
		return seen === terminal.version ? { version: terminal.version } : { version: terminal.version, commands: terminal.commands };
	}
}

/** What points a program at the primary display. */
const DISPLAY_VARIABLES = ["DISPLAY", "XAUTHORITY", "WAYLAND_DISPLAY", "DBUS_SESSION_BUS_ADDRESS"] as const;

/** Runs a command in a login shell, in its own process group, killed with it at the timeout. `$PIM_WORKSPACE` is the root. */
export async function runCommand({ command, timeoutMs = 120_000, maxBytes = 64_000, env, unset, onOutput }: ExecArgs, cwd: string, root: string): Promise<ExecResult> {
	const { spawn } = await import("node:child_process");
	const { StringDecoder } = await import("node:string_decoder");
	const shell = process.env.SHELL || "/bin/bash";
	const base = { ...process.env };
	for (const name of unset ?? []) delete base[name];
	const child = spawn(shell, ["-lc", command], { cwd, detached: true, stdio: ["ignore", "pipe", "pipe"], env: { ...base, ...env, PIM_WORKSPACE: root } });
	const stdout = new Output(maxBytes);
	const stderr = new Output(maxBytes);
	// A decoder for each stream, so a character split across chunks is shown whole.
	const decoders = [new StringDecoder("utf8"), new StringDecoder("utf8")];
	child.stdout!.on("data", (chunk: Buffer) => (stdout.add(chunk), onOutput?.(decoders[0]!.write(chunk))));
	child.stderr!.on("data", (chunk: Buffer) => (stderr.add(chunk), onOutput?.(decoders[1]!.write(chunk))));
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

/** What an app's backend is started with. */
export type AppSpec = {
	readonly id: string;
	/** The real path of the release folder, where the backend runs. */
	readonly cwd: string;
	readonly command: string;
	readonly install?: string;
	readonly port: number;
	/** The real path of the folder the app keeps its data in. */
	readonly data: string;
	readonly env: Readonly<Record<string, string>>;
	/** The real path of the root, as `$PIM_WORKSPACE`. */
	readonly root: string;
};

export type AppState = "starting" | "running" | "crashed" | "failed" | "stopped";

/** Timings of the supervisor, in milliseconds; tests shorten them. */
export type AppsOptions = {
	/** The wait before the first restart; each next one doubles it. */
	backoffMs?: number;
	/** The longest wait before a restart. */
	maxBackoffMs?: number;
	/** How long a run must last to count as a good one, which resets the restarts it's owed. */
	stableMs?: number;
	/** How long a backend has to start listening. */
	readyMs?: number;
	/** How often it's tried while it starts. */
	pollMs?: number;
	/** How long a stopped backend has to end before its process group is killed outright. */
	killMs?: number;
};

type AppRun = { readonly pid: number | undefined; readonly child: ChildProcess; exited: boolean };

type App = {
	readonly spec: AppSpec;
	state: AppState;
	since: number;
	restarts: number;
	/** Restarts in a row after runs shorter than `stableMs`. */
	failures: number;
	startedAt: number;
	run: AppRun | undefined;
	timer: ReturnType<typeof setTimeout> | undefined;
	log: Buffer;
};

const APP_LOG_BYTES = 256 * 1024;
const APP_MAX_RESTARTS = 8;
const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/** Whether any process is left in a process group. */
function groupAlive(pid: number): boolean {
	try {
		process.kill(-pid, 0);
		return true;
	} catch {
		return false;
	}
}

function killGroup(pid: number | undefined, signal: NodeJS.Signals): void {
	if (pid === undefined) return;
	try {
		process.kill(-pid, signal);
	} catch {}
}

/**
 * The backends of apps that run on this computer: started in a login shell
 * of their own process group, restarted with growing waits when they die,
 * and kept running when the space disconnects, since they belong to this
 * process and not to a connection.
 */
export class Apps {
	readonly #apps = new Map<string, App>();
	readonly #options: Required<AppsOptions>;

	constructor(options: AppsOptions = {}) {
		this.#options = { backoffMs: 1_000, maxBackoffMs: 60_000, stableMs: 30_000, readyMs: 30_000, pollMs: 200, killMs: 5_000, ...options };
	}

	/** Installs and starts the app, stopping one of the same id first, and answers once it listens. */
	async start(spec: AppSpec): Promise<{ state: "running"; pid: number | undefined }> {
		await this.stop(spec.id);
		if (spec.install) {
			const result = await runCommand({ command: spec.install, timeoutMs: 300_000 }, spec.cwd, spec.root);
			if (result.exitCode !== 0) {
				const why = result.timedOut ? "took more than 5 minutes" : `failed${result.exitCode === null ? "" : ` with exit code ${result.exitCode}`}`;
				throw new CallError(`The install command ${why}:\n${result.stdout}${result.stderr}`, "EINSTALL");
			}
		}
		const app: App = { spec, state: "starting", since: Date.now(), restarts: 0, failures: 0, startedAt: Date.now(), run: undefined, timer: undefined, log: Buffer.alloc(0) };
		this.#apps.set(spec.id, app);
		try {
			await this.#launch(app);
		} catch (error) {
			await this.#end(app.run);
			if (app.state === "starting") {
				app.run = undefined;
				this.#set(app, "failed");
			}
			throw error;
		}
		return { state: "running", pid: app.run?.pid };
	}

	/** Ends the app's process group, and any restart it was owed. */
	async stop(id: string): Promise<void> {
		const app = this.#apps.get(id);
		if (!app) return;
		clearTimeout(app.timer);
		app.timer = undefined;
		const run = app.run;
		app.run = undefined;
		this.#set(app, "stopped");
		await this.#end(run);
	}

	/** Ends every app, as this process does. */
	async stopAll(): Promise<void> {
		await Promise.all([...this.#apps.keys()].map((id) => this.stop(id)));
	}

	/** Kills every process group at once, for a process that is exiting and can't wait. */
	killAll(): void {
		for (const app of this.#apps.values()) {
			clearTimeout(app.timer);
			app.state = "stopped";
			killGroup(app.run?.pid, "SIGKILL");
		}
	}

	status(id?: string): { id: string; state: AppState; pid: number | null; restarts: number; since: number; port: number }[] {
		const apps = id === undefined ? [...this.#apps.entries()] : this.#apps.has(id) ? [[id, this.#apps.get(id)!] as const] : [];
		return apps.map(([id, app]) => ({ id, state: app.state, pid: app.run?.pid ?? null, restarts: app.restarts, since: app.since, port: app.spec.port }));
	}

	get(id: string): { state: AppState; port: number } | undefined {
		const app = this.#apps.get(id);
		return app && { state: app.state, port: app.spec.port };
	}

	logs(id: string, bytes: number): string | undefined {
		return this.#apps.get(id)?.log.subarray(-bytes).toString("utf8");
	}

	#set(app: App, state: AppState): void {
		app.state = state;
		app.since = Date.now();
	}

	/** Starts the process and waits until it accepts connections; a failure says what it printed. */
	async #launch(app: App): Promise<void> {
		const { spawn } = await import("node:child_process");
		const { spec } = app;
		const shell = process.env.SHELL || "/bin/bash";
		const env = { ...process.env, PIM_WORKSPACE: spec.root, ...spec.env, PORT: String(spec.port), PIM_APP_ID: spec.id, PIM_APP_DATA: spec.data };
		const child = spawn(shell, ["-lc", spec.command], { cwd: spec.cwd, detached: true, stdio: ["ignore", "pipe", "pipe"], env });
		const run: AppRun = { pid: child.pid, child, exited: false };
		app.run = run;
		app.startedAt = Date.now();
		this.#set(app, "starting");
		const add = (chunk: Buffer) => {
			app.log = Buffer.concat([app.log, chunk]).subarray(-APP_LOG_BYTES);
		};
		child.stdout!.on("data", add);
		child.stderr!.on("data", add);
		const ended = () => {
			if (run.exited) return;
			run.exited = true;
			// A backend that dies while it runs is restarted; one that dies as it starts is the start's to report.
			if (app.run === run && app.state === "running") this.#crashed(app);
		};
		child.on("error", (error) => {
			add(Buffer.from(`${error.message}\n`));
			ended();
		});
		child.on("exit", ended);
		const deadline = Date.now() + this.#options.readyMs;
		while (!(await this.#listening(spec.port))) {
			if (app.run !== run || app.state !== "starting") throw new CallError("The app was stopped as it started.", "ECANCELED");
			const tail = () => app.log.subarray(-2_000).toString("utf8");
			if (run.exited) {
				await sleep(50);
				throw new CallError(`The app exited as it started:\n${tail()}`, "ESTART");
			}
			if (Date.now() >= deadline) throw new CallError(`The app didn't listen on port ${spec.port} within ${this.#options.readyMs / 1000} s:\n${tail()}`, "ESTART");
			await sleep(this.#options.pollMs);
		}
		if (app.run !== run || app.state !== "starting") throw new CallError("The app was stopped as it started.", "ECANCELED");
		this.#set(app, "running");
	}

	async #listening(port: number): Promise<boolean> {
		const net = await import("node:net");
		return new Promise((resolve) => {
			const socket = net.connect({ host: "127.0.0.1", port });
			socket.setTimeout(1_000);
			const done = (listening: boolean) => {
				socket.destroy();
				resolve(listening);
			};
			socket.on("connect", () => done(true));
			socket.on("error", () => done(false));
			socket.on("timeout", () => done(false));
		});
	}

	/** Marks a backend that died on its own, and restarts it after a wait that doubles, or gives up. */
	#crashed(app: App): void {
		killGroup(app.run?.pid, "SIGKILL");
		app.run = undefined;
		if (Date.now() - app.startedAt >= this.#options.stableMs) app.failures = 0;
		app.failures++;
		if (app.failures > APP_MAX_RESTARTS) {
			this.#set(app, "failed");
			return;
		}
		this.#set(app, "crashed");
		const wait = Math.min(this.#options.backoffMs * 2 ** (app.failures - 1), this.#options.maxBackoffMs);
		app.timer = setTimeout(() => {
			app.timer = undefined;
			app.restarts++;
			this.#launch(app).catch(async () => {
				// One that stopped meanwhile has no one waiting for it; one that failed to start counts as a short run.
				if (app.state !== "starting") return;
				await this.#end(app.run);
				this.#crashed(app);
			});
		}, wait);
	}

	/** Asks a process group to end, and kills what is left of it after `killMs`. */
	async #end(run: AppRun | undefined): Promise<void> {
		if (!run?.pid) return;
		killGroup(run.pid, "SIGTERM");
		for (const deadline = Date.now() + this.#options.killMs; groupAlive(run.pid) && Date.now() < deadline; ) await sleep(25);
		killGroup(run.pid, "SIGKILL");
	}
}

const APP_ID = /^[0-9a-f-]{8,64}$/i;
const HOP_BY_HOP = new Set(["connection", "keep-alive", "transfer-encoding", "upgrade", "te", "trailer", "host"]);
const MAX_APP_REQUEST = 1_048_576;
const MAX_APP_RESPONSE = 4_194_304;

/** The calls about apps: starting and stopping their backends, reading them, and relaying a request to one. */
async function appCall(machine: Machine, op: string, args: Args): Promise<unknown> {
	const apps = machine.apps;
	if (!apps) throw new CallError("This computer doesn't run apps: update pim-computer.", "ENOSYS");
	if (op === "app_status" && args.id === undefined ? false : typeof args.id !== "string" || !APP_ID.test(args.id)) {
		throw new CallError("id must be an app's id", "EINVAL");
	}
	const id = args.id as string;
	switch (op) {
		case "app_start": {
			const { port, command } = args;
			if (typeof port !== "number" || !Number.isInteger(port) || port < 1024 || port > 65535) throw new CallError("port must be an integer from 1024 to 65535", "EINVAL");
			if (typeof command !== "string" || command.trim() === "") throw new CallError("command must be a shell command", "EINVAL");
			if (args.install !== undefined && (typeof args.install !== "string" || args.install.trim() === "")) throw new CallError("install must be a shell command", "EINVAL");
			if (args.env !== undefined && (typeof args.env !== "object" || args.env === null || Array.isArray(args.env))) throw new CallError("env must be an object of strings", "EINVAL");
			const env: Record<string, string> = {};
			for (const [name, value] of Object.entries(args.env ?? {})) {
				if (typeof value !== "string") throw new CallError(`env.${name} must be a string`, "EINVAL");
				env[name] = value;
			}
			const cwd = await local(machine, args.dir);
			if (!(await fs.stat(cwd).catch(() => null))?.isDirectory()) throw new CallError(`${String(args.dir)} is not a folder`, "ENOENT");
			const data = await local(machine, args.data ?? `${WORKSPACE}/.pim/apps/${id}/data`);
			await fs.mkdir(data, { recursive: true });
			return await apps.start({ id, cwd, command, ...(args.install ? { install: args.install as string } : {}), port, data, env, root: machine.root });
		}
		case "app_stop":
			await apps.stop(id);
			return { state: "stopped" };
		case "app_status":
			return { apps: apps.status(args.id as string | undefined) };
		case "app_logs": {
			const bytes = args.bytes === undefined ? 16_000 : Math.min(Number(args.bytes), 64_000);
			if (!(bytes >= 1)) throw new CallError("bytes must be a positive number", "EINVAL");
			const text = apps.logs(id, Math.floor(bytes));
			if (text === undefined) throw new CallError(`No app ${id} is known here.`, "ENOENT");
			return { text };
		}
		case "app_http":
			return relay(apps, id, args);
		default:
			throw new CallError(`This computer doesn't know the call ${op}. Update pim-computer.`, "ENOSYS");
	}
}

/** Sends one request to a running app's backend on this computer's loopback, and answers with its response as it came. */
async function relay(apps: Apps, id: string, args: Args): Promise<unknown> {
	const app = apps.get(id);
	if (!app) throw new CallError(`No app ${id} is known here.`, "ENOTRUNNING");
	if (app.state !== "running") throw new CallError(`App ${id} is ${app.state}, not running.`, "ENOTRUNNING");
	const { method, path: target, headers, body } = args;
	if (typeof method !== "string" || !/^[A-Z]+$/.test(method)) throw new CallError("method must be an uppercase HTTP method", "EINVAL");
	if (typeof target !== "string" || !target.startsWith("/") || target.length > 8_192 || /[\s\0]/.test(target)) throw new CallError("path must start with / and be at most 8 KB", "EINVAL");
	if (!Array.isArray(headers) || headers.some((pair) => !Array.isArray(pair) || pair.length !== 2 || typeof pair[0] !== "string" || typeof pair[1] !== "string")) {
		throw new CallError("headers must be an array of [name, value] pairs of strings", "EINVAL");
	}
	if (body !== undefined && typeof body !== "string") throw new CallError("body must be base64", "EINVAL");
	if ((body?.length ?? 0) > Math.ceil(MAX_APP_REQUEST / 3) * 4) throw new CallError("body is more than 1 MiB", "EFBIG");
	const payload = body === undefined ? undefined : Buffer.from(body, "base64");
	if (payload && payload.length > MAX_APP_REQUEST) throw new CallError("body is more than 1 MiB", "EFBIG");
	const sent: [string, string][] = [["host", `127.0.0.1:${app.port}`]];
	for (const [name, value] of headers as [string, string][]) {
		const lower = name.toLowerCase();
		if (!HOP_BY_HOP.has(lower) && !lower.startsWith("proxy-")) sent.push([name, value]);
	}
	if (payload) sent.push(["content-length", String(payload.length)]);
	const http = await import("node:http");
	return new Promise((resolve, reject) => {
		const timer = setTimeout(() => request.destroy(new CallError("The app didn't answer within 60 seconds.", "ETIMEDOUT")), 60_000);
		const fail = (error: Error) => {
			clearTimeout(timer);
			const code = (error as { code?: string }).code;
			if (error instanceof CallError) reject(error);
			else if (code === "ECONNREFUSED") reject(new CallError(`App ${id} refused the connection on port ${app.port}: it should listen on 127.0.0.1.`, "ECONNREFUSED"));
			else reject(new CallError(error.message, code === "ERR_INVALID_CHAR" || code === "ERR_INVALID_HTTP_TOKEN" ? "EINVAL" : code));
		};
		let request: import("node:http").ClientRequest;
		try {
			// No agent, so no connection outlives its request; headers go as the list gives them, so duplicates stay.
			request = http.request({ host: "127.0.0.1", port: app.port, method, path: target, agent: false, setHost: false, headers: sent.flat() as unknown as Record<string, string> });
		} catch (error) {
			return fail(error as Error);
		}
		request.on("error", fail);
		request.on("response", (response) => {
			const chunks: Buffer[] = [];
			let size = 0;
			response.on("data", (chunk: Buffer) => {
				size += chunk.length;
				if (size > MAX_APP_RESPONSE) request.destroy(new CallError("The app's response is more than 4 MiB.", "EFBIG"));
				else chunks.push(chunk);
			});
			response.on("error", fail);
			response.on("aborted", () => fail(new CallError("The app closed the connection mid-response.", "ECONNRESET")));
			response.on("end", () => {
				clearTimeout(timer);
				const pairs: [string, string][] = [];
				for (let i = 0; i < response.rawHeaders.length; i += 2) pairs.push([response.rawHeaders[i]!, response.rawHeaders[i + 1]!]);
				resolve({ status: response.statusCode, headers: pairs, body: Buffer.concat(chunks).toString("base64") });
			});
		});
		request.end(payload);
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
 * the person, is used as it is. Without `restore` it opens none of the
 * pages it had, as the agents' shared Chrome, whose windows are in contexts
 * that end with it.
 */
function localBrowser(executable: string, profile: string, headful: boolean, log: (line: string) => void, restore = true): BrowserHost {
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
		if (restore) await keepSessions(profile);
		const args = [
			"--remote-debugging-port=0",
			// Chrome started with the flag above tells pages it's automated (`navigator.webdriver`), and Google's sign-in turns it away.
			"--disable-blink-features=AutomationControlled",
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

/** How many agents at a time may be signed in to a site, and the domains (with their subdomains) whose cookies are its sign-in. */
export type SiteLimit = { max: number; domains: string[] };

/** A computer's per-thread displays: calls a thread's driver tool on its own display, and finds the environment of the one it holds. */
export type DisplayHost = Pick<DisplayClient, "call" | "envOf"> & Partial<Pick<DisplayClient, "list" | "control" | "touchViewer" | "screenOf">>;

/** How often a stream of a thread's display tells displayd its person is watching. */
const VIEWER_TOUCH_MS = 30_000;

/** What the app lists of a display: who holds it, how it is, and for a queued thread, where it stands. */
export type DisplaySummary = {
	threadId: string;
	state: string;
	control: "agent" | "user";
	idleSec: number;
	position?: number;
	estimatedWaitSec?: number;
};

/** The space id displayd records its leases under: one computer serves one person. */
const SPACE = "pim-computer";
const NO_DISPLAY = "no display allocated: displayd is not reachable on this computer";

/** The tools that act with the keyboard or pointer, which a display's driver only delivers in the foreground. */
const INPUT_TOOLS = new Set(["click", "double_click", "right_click", "type_text", "press_key", "hotkey", "set_value", "scroll", "drag"]);

/** The text of a retryable error for a thread still waiting in displayd's queue for a display. */
function queuedMessage(lease: Lease): string {
	const holders = Array.isArray(lease.holders) ? (lease.holders as { threadId: string; idleSec: number; state: string }[]) : [];
	const place = typeof lease.position === "number" ? `position ${lease.position} in the queue` : "in the queue";
	const wait = typeof lease.estimatedWaitSec === "number" ? `, estimated wait ${lease.estimatedWaitSec} s` : "";
	const held = holders.length ? ` Displays are held by: ${holders.map((h) => `${h.threadId} (${h.state}, idle ${h.idleSec} s)`).join(", ")}.` : "";
	return `display_queued No display is free yet: ${place}${wait}.${held} Try again shortly.`;
}

type Lease = { state: string; id?: string; control?: string; env?: Record<string, string>; cdpPort?: number; driver?: { base: string; tokenFile: string }; [key: string]: unknown };

/** What a thread's lease gives, or the retryable text for why it isn't a display to use yet. */
export type Acquired = { lease: Lease & { driver: { base: string; tokenFile: string } } } | { error: string };

/**
 * displayd's per-thread displays (see ../displayd/README.md): a thread's
 * desktop calls go to the Cua Driver of the display it holds, which is
 * leased on first use and kept alive by each call. Never the primary
 * desktop's driver: a display that isn't active yet, or no displayd, is an
 * error the agent can retry.
 */
export class DisplayClient {
	readonly #url: string;
	readonly #token: () => Promise<string>;
	readonly #drivers = new Map<string, DriverHost>();
	readonly #makeDriver: (base: string, tokenFile: string) => DriverHost;
	readonly #screens = new Map<string, ScreenHost>();
	readonly #makeScreen: (base: string, tokenFile: string) => ScreenHost;

	constructor(options: { url?: string; token?: string; tokenFile?: string; driver?: (base: string, tokenFile: string) => DriverHost; screen?: (base: string, tokenFile: string) => ScreenHost } = {}) {
		this.#makeScreen = options.screen ?? spacesdScreen;
		this.#url = options.url ?? "http://127.0.0.1:9900";
		// The token is made by the displayd installer, which may still be running when pim-computer starts: look for it on each request, in the system place and then the user's own.
		this.#token = async () => {
			if (options.token) return options.token;
			const files = options.tokenFile ? [options.tokenFile] : ["/etc/displayd/token", path.join((process.env.HOME ?? ""), ".displayd", "token")];
			let failure: unknown;
			for (const file of files) {
				try {
					return (await fs.readFile(file, "utf8")).trim();
				} catch (error) {
					failure = error;
				}
			}
			throw failure;
		};
		this.#makeDriver = options.driver ?? spacesdDriver;
	}

	async #request(method: string, path: string, body?: unknown, timeoutMs = 10_000): Promise<{ status: number; body: any }> {
		let response: Response;
		try {
			response = await fetch(new URL(path, this.#url), {
				method,
				headers: { authorization: `Bearer ${await this.#token()}`, ...(body === undefined ? {} : { "content-type": "application/json" }) },
				...(body === undefined ? {} : { body: JSON.stringify(body) }),
				signal: AbortSignal.timeout(timeoutMs),
			});
		} catch {
			throw new CallError(NO_DISPLAY, "ENODISPLAY");
		}
		return { status: response.status, body: await response.json().catch(() => ({})) };
	}

	/** Every lease displayd has, or none when it can't be asked. */
	async leases(): Promise<Lease[] | undefined> {
		try {
			const { status, body } = await this.#request("GET", "/displays");
			if (status !== 200) return undefined;
			return Array.isArray(body) ? body : Array.isArray(body?.displays) ? body.displays : [];
		} catch {
			return undefined;
		}
	}

	/** The displays in use and the threads queued for one, in queue order after the displays; gone and timed-out leases are left out. */
	async list(): Promise<{ displays: DisplaySummary[]; queue: DisplaySummary[] }> {
		const leases = await this.leases();
		if (!leases) throw new CallError(NO_DISPLAY, "ENODISPLAY");
		const now = Date.now();
		const shown = leases
			.filter((lease) => ["queued", "starting", "active", "idle"].includes(lease.state))
			.map((lease): DisplaySummary => ({
				threadId: String(lease.threadId),
				state: lease.state,
				control: lease.control === "user" ? "user" : "agent",
				idleSec: lease.control === "user" ? 0 : Math.max(0, Math.floor((now - Number(lease.lastTouch ?? now)) / 1000)),
				...(typeof lease.position === "number" ? { position: lease.position } : {}),
				...(typeof lease.estimatedWaitSec === "number" ? { estimatedWaitSec: lease.estimatedWaitSec } : {}),
			}));
		return {
			displays: shown.filter((one) => one.state !== "queued"),
			queue: shown.filter((one) => one.state === "queued").sort((a, b) => (a.position ?? 0) - (b.position ?? 0)),
		};
	}

	/** The stream source of the display a thread holds now (active or idle); an unknown or queued one is an error, and none is leased. */
	async screenOf(thread: string): Promise<ScreenHost> {
		const leases = await this.leases();
		if (!leases) throw new CallError(NO_DISPLAY, "ENODISPLAY");
		const lease = leases.find((one) => one.threadId === thread && one.state !== "gone" && one.state !== "timeout" && one.state !== "reaping");
		if (!lease) throw new CallError(`No display is held by thread ${thread}.`, "ENODISPLAY");
		if (lease.state === "queued") throw new CallError(`The display of thread ${thread} is still queued.`, "ENODISPLAY");
		if ((lease.state !== "active" && lease.state !== "idle") || !lease.driver) throw new CallError(`The display of thread ${thread} is ${lease.state}, not ready to show yet.`, "ENODISPLAY");
		const key = `${lease.driver.base} ${lease.driver.tokenFile}`;
		let screen = this.#screens.get(key);
		if (!screen) this.#screens.set(key, (screen = this.#makeScreen(lease.driver.base, lease.driver.tokenFile)));
		return screen;
	}

	/** Tells displayd the person is watching the thread's display, so it doesn't idle out. */
	async touchViewer(thread: string): Promise<void> {
		await this.#request("POST", "/touch", { threadId: thread, viewer: true });
	}

	/** Takes the thread's display over for the person (`user`, which pauses the agent's driver calls) or hands it back (`agent`). */
	async control(thread: string, mode: "user" | "agent"): Promise<{ control: "agent" | "user" }> {
		const { status, body } = await this.#request("POST", "/control", { threadId: thread, mode });
		if (status === 404) throw new CallError(`No display is held by thread ${thread}.`, "ENODISPLAY");
		if (status !== 200) throw new CallError(`displayd refused: HTTP ${status} ${JSON.stringify(body)}`, "ENODISPLAY");
		return { control: body?.lease?.control === "user" ? "user" : "agent" };
	}

	/** The sites whose sign-ins are limited to a number of agents at a time, with their domains, as displayd's sites.json sets them; undefined when displayd can't say. */
	async sites(): Promise<Record<string, SiteLimit> | undefined> {
		try {
			const { status, body } = await this.#request("GET", "/sites");
			return status === 200 && body?.sites && typeof body.sites === "object" ? body.sites : undefined;
		} catch {
			return undefined;
		}
	}

	/** The environment of the display the thread holds, if it does: it never leases one. */
	async envOf(thread: string): Promise<Record<string, string> | undefined> {
		const lease = (await this.leases())?.find((one) => one.threadId === thread && (one.state === "active" || one.state === "idle"));
		return lease?.env;
	}

	/** Keeps the thread's display alive; `browser` marks it as one with a browser, which displayd keeps longer. */
	async touch(thread: string, options: { browser?: boolean } = {}): Promise<void> {
		await this.#request("POST", "/touch", { threadId: thread, ...(options.browser ? { browser: true } : {}) }).catch(() => undefined);
	}

	/** Leases the thread a display, or the retryable reason it has none yet: queued, starting, or taken over by the person. */
	async acquire(thread: string): Promise<Acquired> {
		const acquired = await this.#request("POST", "/acquire", { threadId: thread, spaceId: SPACE, waitMs: 60_000 }, 70_000);
		const lease = (acquired.body?.lease ?? undefined) as Lease | undefined;
		if (!lease || (lease.state !== "active" && lease.state !== "idle") || !lease.driver) {
			const state = lease?.state ?? "unknown";
			if (lease && state === "queued") return { error: queuedMessage(lease) };
			const why = acquired.status >= 400 ? `HTTP ${acquired.status} ${JSON.stringify(acquired.body)}` : JSON.stringify({ state, ...(lease ? { lease: { ...lease, env: undefined } } : {}) });
			const label = state === "starting" ? "display_starting" : state === "timeout" ? "display_timeout" : state === "gone" ? "display_gone" : "display_unavailable";
			const hint = state === "timeout" ? "It waited too long in the queue; try again to queue afresh." : state === "gone" ? "Its display was taken for another thread; try again to queue for a new one." : "The display isn't ready yet; try again shortly.";
			return { error: `${label} ${why}. ${hint}` };
		}
		// A person has taken the display over: the agent's calls would fight them for it, so wait.
		if (lease.control === "user") {
			return { error: "display_user_controlled The person is using this display themselves right now. Wait and try again in a minute, or tell them you need the display." };
		}
		return { lease: lease as Lease & { driver: { base: string; tokenFile: string } } };
	}

	/** Calls one of Cua Driver's tools on the thread's display. */
	async call(thread: string, tool: string, args: Args): Promise<Awaited<ReturnType<DriverHost["call"]>>> {
		const acquired = await this.acquire(thread);
		if ("error" in acquired) return { content: [{ type: "text", text: acquired.error }], isError: true };
		const { lease } = acquired;
		await this.touch(thread);
		const key = `${lease.driver.base} ${lease.driver.tokenFile}`;
		let driver = this.#drivers.get(key);
		if (!driver) this.#drivers.set(key, (driver = this.#makeDriver(lease.driver.base, lease.driver.tokenFile)));
		// Focus is private to a display, and its driver refuses background delivery.
		const sent = INPUT_TOOLS.has(tool) && args.delivery_mode === undefined ? { ...args, delivery_mode: "foreground" } : args;
		return driver.call(tool, sent);
	}
}

/** A DevTools connection as `AgentBrowsers` uses it: text in and out, as over a WebSocket. */
export type DevToolsSocket = {
	send(data: string): void;
	onMessage(listener: (data: string) => void): void;
	onClose(listener: () => void): void;
	close(): void;
};

/** A DevTools connection to one of this computer's browsers, opened through its `BrowserHost` (which starts it first when it isn't running). */
async function hostSocket(host: BrowserHost): Promise<DevToolsSocket> {
	const messages: ((data: string) => void)[] = [];
	const closes: (() => void)[] = [];
	const channel = await host.connect(
		(data) => messages.forEach((listener) => listener(data)),
		() => closes.forEach((listener) => listener()),
	);
	return { send: (data) => channel.send(data), onMessage: (listener) => void messages.push(listener), onClose: (listener) => void closes.push(listener), close: () => channel.close() };
}

type Cookie = Record<string, unknown>;

/** What the signed-in primary browser had at some moment. */
type Snapshot = { cookies: Cookie[]; takenAt: number };

/** The sentence an agent reads when its browser has no sign-ins to start with. */
export const SIGNED_OUT = "The primary browser has no saved sign-ins; ask the person to sign in on the Primary desktop in Computer; never ask for credentials in chat.";

/** The sites whose sign-ins only so many agents may use at a time, where displayd can't say (as where it doesn't run): the same as displayd's own default. */
export const DEFAULT_SITES: Record<string, SiteLimit> = { "linkedin.com": { max: 1, domains: ["linkedin.com", "licdn.com"] } };

/** How old a snapshot of the primary browser's sign-ins may be before a new browser takes a fresh one. */
const SNAPSHOT_MAX_AGE_MS = 5 * 60_000;
/** How often an agent's sign-ins are saved while it's connected; they're saved too when its last connection closes. */
const SAVE_EVERY_MS = 5 * 60_000;
/** How long an agent's browser stays open with nobody connected to it, before its context (and its windows) close; its sign-ins are saved. */
const AGENT_BROWSER_IDLE_MS = 20 * 60_000;

/** The folder name for an agent or thread: its id where that is a plain name, else a hash of it. */
export function threadFolder(thread: string): string {
	if (/^[A-Za-z0-9][A-Za-z0-9._-]{0,79}$/.test(thread)) return thread;
	return `${thread.replace(/[^A-Za-z0-9._-]/g, "_").replace(/^[._-]+/, "").slice(0, 40)}-${createHash("sha256").update(thread).digest("hex").slice(0, 12)}`;
}

/** A call on a browser's DevTools, with its answer. */
class Rpc {
	readonly #socket: DevToolsSocket;
	readonly #pending = new Map<number, { resolve(value: any): void; reject(error: Error): void }>();
	#next = 1;

	constructor(socket: DevToolsSocket) {
		this.#socket = socket;
		socket.onMessage((data) => {
			const message = JSON.parse(data) as { id?: number; sessionId?: string; result?: unknown; error?: { message?: string } };
			const pending = message.id === undefined ? undefined : this.#pending.get(message.id);
			if (!pending) return;
			this.#pending.delete(message.id!);
			if (message.error) pending.reject(new Error(message.error.message ?? "DevTools refused"));
			else pending.resolve(message.result ?? {});
		});
		socket.onClose(() => {
			for (const pending of this.#pending.values()) pending.reject(new Error("DevTools closed"));
			this.#pending.clear();
		});
	}

	call<T = any>(method: string, params: Record<string, unknown> = {}, sessionId?: string): Promise<T> {
		const id = this.#next++;
		return new Promise<T>((resolve, reject) => {
			const timer = setTimeout(() => reject(new Error(`${method} timed out`)), 15_000);
			this.#pending.set(id, {
				resolve: (value) => (clearTimeout(timer), resolve(value)),
				reject: (error) => (clearTimeout(timer), reject(error)),
			});
			this.#socket.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }));
		});
	}

	close(): void {
		this.#socket.close();
	}
}

/** What an agent's browser is: its context in the shared Chrome, and the connections to it. */
type AgentBrowser = {
	context: string;
	connections: number;
	syncedAt: number;
	/** The limited sites whose slot this agent holds, and those it was refused: their cookies were not copied. */
	claimed: Set<string>;
	withheld: Set<string>;
	saver?: ReturnType<typeof setInterval>;
	idle?: ReturnType<typeof setTimeout>;
};

export type AgentBrowsersOptions = {
	/** The one headless Chrome the agents share, each in a browser context of its own. */
	shared: BrowserHost;
	/** Where each agent's sign-ins are kept between runs: `~/.pim-computer/agents`. */
	root: string;
	/** The primary browser's profile, whose sign-ins are copied in, and the browser itself (started when it isn't running, to read them). */
	primaryProfile: string;
	primary: BrowserHost;
	/** The file listing the origins whose localStorage is copied too: `~/.displayd/storage-origins.json`. */
	storageOrigins: string;
	/** The limited sites, as displayd's sites.json sets them; undefined where displayd can't say, and the default applies. */
	sites: () => Promise<Record<string, SiteLimit> | undefined>;
	log: (line: string) => void;
	now?: () => number;
};

/**
 * Each agent's browser: a browser context of its own in one headless
 * Chrome that the agents share, so no agent needs a display to browse and
 * the computer runs one Chrome however many agents browse. A context is a
 * separate cookie jar and storage, so what one agent is signed in to is not
 * signed in for another; every chat of the agent shares it, each in a
 * window of its own. The agent's cookies are saved to
 * `<root>/<agent>/cookies.json` (only the person can read it) and restored
 * when its context is made again, after the Chrome quit or this program
 * restarted; the person's sign-ins in the primary browser are copied on
 * top, so theirs win. Sites limited to a number of agents at a time
 * (displayd's sites.json, or `DEFAULT_SITES`) are counted here: an agent
 * over the limit gets none of that site's cookies until another lets go.
 *
 * The connections pass through unread, but for three messages: a window or
 * a download setting the space asks for goes in the agent's context, and the
 * list of targets shows only that context's (a viewer, which names no agent,
 * sees only the windows its chat opened). Closing a chat's browser closes its
 * windows; an agent's context closes once it has no window left and nobody
 * connected, or after twenty minutes with nobody connected.
 */
export class AgentBrowsers {
	readonly #o: AgentBrowsersOptions;
	readonly #agents = new Map<string, AgentBrowser>();
	readonly #starting = new Map<string, Promise<{ browser: AgentBrowser; note?: string }>>();
	/** The agent each thread browses as, as the space last said. */
	readonly #threads = new Map<string, string>();
	/** The windows each thread opened. */
	readonly #windows = new Map<string, Set<string>>();
	/** The agents that hold a slot of each limited site. */
	readonly #holders = new Map<string, Set<string>>();
	#snapshot: Snapshot | undefined;

	constructor(options: AgentBrowsersOptions) {
		this.#o = options;
	}

	#now(): number {
		return (this.#o.now ?? Date.now)();
	}

	/** The agent a call is for: the one it names, else (for a viewer) the one its thread last browsed as. */
	#ownerOf(thread: string, agent?: string): string | undefined {
		return agent ?? this.#threads.get(thread);
	}

	/** Whether the agent's browser is running, without starting it. */
	async running(thread: string, agent?: string): Promise<boolean> {
		const owner = this.#ownerOf(thread, agent);
		if (owner === undefined || !this.#agents.has(owner)) return false;
		if (await this.#o.shared.running()) return true;
		this.#forgetAll();
		return false;
	}

	/**
	 * Opens a DevTools connection to the agent's browser for one of its threads, starting the shared Chrome and
	 * making the agent's context first when they aren't there. `agent` is undefined for a viewer of the thread's window.
	 */
	async connect(thread: string, agent: string | undefined, onMessage: (data: string) => void, onClose: () => void): Promise<BrowserChannel & { context: string; note?: string }> {
		const owner = this.#ownerOf(thread, agent);
		if (owner === undefined) throw new CallError("This chat has no browser open.", "EBROWSER");
		this.#threads.set(thread, owner);
		const { browser, note } = await this.#ensure(owner);
		const socket = await hostSocket(this.#o.shared).catch(() => {
			throw new CallError("Couldn't connect to the browser.", "EBROWSER");
		});
		browser.connections++;
		clearTimeout(browser.idle);
		browser.saver ??= setInterval(() => void this.#save(owner).catch(() => {}), SAVE_EVERY_MS);
		browser.saver.unref?.();
		let open = true;
		const closed = () => {
			if (!open) return;
			open = false;
			if (--browser.connections === 0 && this.#agents.get(owner) === browser) {
				clearInterval(browser.saver);
				browser.saver = undefined;
				void this.#save(owner).catch((error) => this.#o.log(`Couldn't save the sign-ins of agent ${owner}: ${(error as Error).message}`));
				browser.idle = setTimeout(() => {
					this.#o.log(`Nobody has used the browser of agent ${owner} for a while, so it closes.`);
					void this.#close(owner);
				}, AGENT_BROWSER_IDLE_MS);
				browser.idle.unref?.();
			}
			onClose();
		};
		// What the space asks for, kept to the agent's context; the list of targets it asks for, and the windows it opens, answered from it.
		// Keyed by session and id: the space may send these on a session it attached to the browser.
		const pending = new Map<string, "create" | "list">();
		const windows = this.#windows.get(thread) ?? this.#windows.set(thread, new Set()).get(thread)!;
		socket.onMessage((data) => {
			if (pending.size > 0) {
				const message = JSON.parse(data) as { id?: number; sessionId?: string; result?: { targetId?: string; targetInfos?: { targetId: string; browserContextId?: string }[] } };
				const key = `${message.sessionId ?? ""} ${message.id}`;
				const kind = message.id === undefined ? undefined : pending.get(key);
				if (kind) {
					pending.delete(key);
					if (kind === "create" && message.result?.targetId) windows.add(message.result.targetId);
					if (kind === "list" && message.result?.targetInfos) {
						const own = message.result.targetInfos.filter((target) => target.browserContextId === browser.context);
						for (const id of windows) if (!own.some((target) => target.targetId === id)) windows.delete(id);
						// A viewer sees the windows its chat opened, where it opened any.
						const shown = agent === undefined && windows.size > 0 ? own.filter((target) => windows.has(target.targetId)) : own;
						return onMessage(JSON.stringify({ ...message, result: { ...message.result, targetInfos: shown } }));
					}
				}
			}
			onMessage(data);
		});
		socket.onClose(closed);
		return {
			context: browser.context,
			...(note ? { note } : {}),
			send: (data) => {
				const message = JSON.parse(data) as { id?: number; method?: string; params?: Record<string, unknown>; sessionId?: string };
				if (message.id !== undefined) {
					const key = `${message.sessionId ?? ""} ${message.id}`;
					if (message.method === "Target.createTarget" || message.method === "Browser.setDownloadBehavior") {
						if (message.method === "Target.createTarget") pending.set(key, "create");
						return socket.send(JSON.stringify({ ...message, params: { ...message.params, browserContextId: browser.context } }));
					}
					if (message.method === "Target.getTargets") pending.set(key, "list");
				}
				socket.send(data);
			},
			close: () => {
				socket.close();
				closed();
			},
		};
	}

	/** The agent's context, made (with its sign-ins) when it has none, or its sign-ins brought up to date. */
	async #ensure(owner: string): Promise<{ browser: AgentBrowser; note?: string }> {
		const starting = this.#starting.get(owner);
		if (starting) return starting;
		const ensuring = (async () => {
			const rpc = new Rpc(await hostSocket(this.#o.shared));
			try {
				let browser = this.#agents.get(owner);
				// The shared Chrome quit (after a while unused) since: its contexts went with it.
				if (browser && !(await rpc.call<{ browserContextIds: string[] }>("Target.getBrowserContexts")).browserContextIds.includes(browser.context)) {
					this.#forgetAll();
					browser = undefined;
				}
				if (!browser) {
					const { browserContextId } = await rpc.call<{ browserContextId: string }>("Target.createBrowserContext", { disposeOnDetach: false });
					browser = { context: browserContextId, connections: 0, syncedAt: this.#now(), claimed: new Set(), withheld: new Set() };
					// The agent's own sign-ins, and then the person's, go in before anyone drives the browser.
					const note = await this.#copySignIns(owner, browser, rpc, true, await this.#saved(owner));
					this.#agents.set(owner, browser);
					return { browser, ...(note ? { note } : {}) };
				}
				let note: string | undefined;
				if (await this.#primaryIsNewer(browser.syncedAt)) {
					note = await this.#copySignIns(owner, browser, rpc, true, []);
					browser.syncedAt = this.#now();
				} else if (browser.withheld.size > 0) {
					// A site refused before may be free now: only its cookies are copied, so the others keep what the pages have made of them.
					note = await this.#copySignIns(owner, browser, rpc, false, await this.#saved(owner), new Set(browser.withheld));
				}
				return { browser, ...(note ? { note } : {}) };
			} finally {
				rpc.close();
			}
		})().finally(() => this.#starting.delete(owner));
		this.#starting.set(owner, ensuring);
		return ensuring;
	}

	/**
	 * Closes the thread's windows. When that leaves its agent with no window and nobody connected, the agent's
	 * context closes too, and lets go of its limited sites.
	 */
	async stop(thread: string, agent?: string): Promise<void> {
		const owner = this.#ownerOf(thread, agent);
		const browser = owner === undefined ? undefined : this.#agents.get(owner);
		if (!owner || !browser || !(await this.#o.shared.running())) return;
		const rpc = new Rpc(await hostSocket(this.#o.shared));
		try {
			for (const id of this.#windows.get(thread) ?? []) await rpc.call("Target.closeTarget", { targetId: id }).catch(() => {});
			this.#windows.delete(thread);
			const { targetInfos } = await rpc.call<{ targetInfos: { type: string; browserContextId?: string }[] }>("Target.getTargets");
			const left = targetInfos.some((target) => target.type === "page" && target.browserContextId === browser.context);
			if (!left && browser.connections === 0) await this.#close(owner);
		} finally {
			rpc.close();
		}
	}

	/** Closes the agent's context, with its windows in every chat; its sign-ins are saved first, and stay. */
	async #close(owner: string): Promise<void> {
		const browser = this.#agents.get(owner);
		if (!browser) return;
		await this.#save(owner).catch(() => {});
		this.#forget(owner);
		if (!(await this.#o.shared.running())) return;
		const rpc = new Rpc(await hostSocket(this.#o.shared));
		try {
			await rpc.call("Target.disposeBrowserContext", { browserContextId: browser.context });
		} catch {
		} finally {
			rpc.close();
		}
	}

	/** Saves every agent's sign-ins and quits the shared Chrome, as this program ends. */
	async endAll(): Promise<void> {
		await Promise.allSettled([...this.#agents.keys()].map((owner) => this.#save(owner)));
		this.#forgetAll();
		await this.#o.shared.stop();
	}

	#forget(owner: string): void {
		const browser = this.#agents.get(owner);
		if (browser) clearInterval(browser.saver), clearTimeout(browser.idle);
		this.#agents.delete(owner);
		for (const held of this.#holders.values()) held.delete(owner);
		for (const [thread, of] of this.#threads) if (of === owner) this.#windows.delete(thread);
	}

	#forgetAll(): void {
		for (const owner of [...this.#agents.keys()]) this.#forget(owner);
	}

	#jar(owner: string): string {
		return path.join(this.#o.root, threadFolder(owner), "cookies.json");
	}

	/** The cookies the agent's browser had when they were last saved, without those that have expired since. */
	async #saved(owner: string): Promise<Cookie[]> {
		try {
			const cookies = JSON.parse(await fs.readFile(this.#jar(owner), "utf8")) as Cookie[];
			const now = this.#now() / 1000;
			return Array.isArray(cookies) ? cookies.filter((cookie) => !(typeof cookie.expires === "number" && cookie.expires > 0 && cookie.expires < now)) : [];
		} catch {
			return [];
		}
	}

	/** Saves the cookies of the agent's browser, readable by the person only. */
	async #save(owner: string): Promise<void> {
		const browser = this.#agents.get(owner);
		if (!browser || !(await this.#o.shared.running())) return;
		const rpc = new Rpc(await hostSocket(this.#o.shared));
		let cookies: Cookie[];
		try {
			({ cookies } = await rpc.call<{ cookies: Cookie[] }>("Storage.getCookies", { browserContextId: browser.context }));
		} finally {
			rpc.close();
		}
		const file = this.#jar(owner);
		await fs.mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
		await fs.writeFile(`${file}.tmp`, JSON.stringify(cookies), { mode: 0o600 });
		await fs.rename(`${file}.tmp`, file);
	}

	async #primaryIsNewer(since: number): Promise<boolean> {
		const stamps = await Promise.all(["Default/Cookies", "Default/Network/Cookies"].map((file) => fs.stat(path.join(this.#o.primaryProfile, file)).then((stat) => stat.mtimeMs, () => 0)));
		return Math.max(...stamps) > since;
	}

	/** What the primary browser has now: its cookies, taken afresh when `fresh` or when the last were old or the browser has changed since. */
	async #cookies(fresh: boolean): Promise<Snapshot | undefined> {
		const known = this.#snapshot;
		if (known && !fresh && this.#now() - known.takenAt < SNAPSHOT_MAX_AGE_MS && !(await this.#primaryIsNewer(known.takenAt))) return known;
		const rpc = new Rpc(await hostSocket(this.#o.primary));
		try {
			const { cookies } = await rpc.call<{ cookies: Cookie[] }>("Storage.getCookies");
			return (this.#snapshot = { cookies, takenAt: this.#now() });
		} finally {
			rpc.close();
		}
	}

	/** Takes the agent a slot of a limited site, where fewer agents than its limit hold one. */
	#claim(owner: string, site: string, max: number): boolean {
		const held = this.#holders.get(site) ?? this.#holders.set(site, new Set()).get(site)!;
		if (!held.has(owner) && held.size >= max) return false;
		held.add(owner);
		return true;
	}

	/**
	 * Copies `own` (the agent's saved cookies) and then the person's sign-ins from the primary browser into the
	 * agent's context; the note for the agent when the person has none, or when a limited site is held by as many
	 * other agents as it allows: that site's cookies stay out, so one account isn't used from several browsers at
	 * once. `only` names the sites to retry, whose cookies are the only ones copied.
	 */
	async #copySignIns(owner: string, browser: AgentBrowser, rpc: Rpc, fresh: boolean, own: Cookie[], only?: Set<string>): Promise<string | undefined> {
		let snapshot: Snapshot | undefined;
		try {
			snapshot = await this.#cookies(fresh);
		} catch (error) {
			this.#o.log(`Couldn't read the primary browser's sign-ins: ${(error as Error).message}`);
		}
		const limits = (await this.#o.sites().catch(() => undefined)) ?? DEFAULT_SITES;
		const bySite = new Map<string, Cookie[]>();
		const free: Cookie[] = [];
		for (const cookie of [...own, ...(snapshot?.cookies ?? [])]) {
			const host = String(cookie.domain ?? "").toLowerCase().replace(/^\./, "");
			const site = Object.keys(limits).find((name) => limits[name]!.domains.some((domain) => host === domain || host.endsWith(`.${domain}`)));
			if (site === undefined) free.push(cookie);
			else bySite.set(site, [...(bySite.get(site) ?? []), cookie]);
		}
		const copy = only ? [] : free;
		const notes: string[] = [];
		for (const [site, cookies] of bySite) {
			if (only && !only.has(site)) continue;
			if (this.#claim(owner, site, limits[site]!.max)) {
				browser.claimed.add(site);
				browser.withheld.delete(site);
				copy.push(...cookies);
			} else {
				browser.withheld.add(site);
				notes.push(`Signed-in access to ${site} is limited to ${limits[site]!.max} agent(s) at a time to avoid account flags, and another agent holds it. Use the Primary desktop for ${site} (ask the person to do the task there or wait), or retry later; never ask for credentials in chat.`);
			}
		}
		try {
			if (copy.length > 0) await rpc.call("Storage.setCookies", { cookies: copy.map(cookieParam), browserContextId: browser.context });
			if (!only && snapshot && snapshot.cookies.length > 0) await this.#copyStorage(rpc, browser.context).catch((error) => this.#o.log(`Couldn't copy localStorage: ${(error as Error).message}`));
		} catch (error) {
			this.#o.log(`Couldn't copy the sign-ins into the browser of agent ${owner}: ${(error as Error).message}`);
		}
		if (!snapshot) notes.unshift(`The primary browser couldn't be read, so its sign-ins weren't copied. ${SIGNED_OUT.replace(/^The primary browser has no saved sign-ins; /, "")}`);
		else if (!only && snapshot.cookies.length === 0 && own.length === 0) return SIGNED_OUT;
		return notes.length > 0 ? notes.join("\n") : undefined;
	}

	/** Copies the localStorage of the origins in `storage-origins.json` (none by default), from the primary browser into the agent's context. */
	async #copyStorage(to: Rpc, context: string): Promise<void> {
		let origins: string[] = [];
		try {
			const listed = JSON.parse(await fs.readFile(this.#o.storageOrigins, "utf8"));
			if (Array.isArray(listed)) origins = listed.filter((origin): origin is string => typeof origin === "string" && /^https?:\/\/[^/]+$/.test(origin));
		} catch {}
		if (origins.length === 0) return;
		const from = new Rpc(await hostSocket(this.#o.primary));
		try {
			for (const origin of origins) {
				const items = await onOrigin(from, origin, `JSON.stringify(Object.entries(localStorage))`);
				const entries = JSON.parse(String(items)) as [string, string][];
				if (entries.length === 0) continue;
				await onOrigin(to, origin, `(${JSON.stringify(entries)}).forEach(([key, value]) => localStorage.setItem(key, value))`, context);
			}
		} finally {
			from.close();
		}
	}
}

/** A cookie as Chrome reports it, in the form `Storage.setCookies` takes. */
function cookieParam(cookie: Cookie): Cookie {
	const { name, value, domain, path: cookiePath, secure, httpOnly, sameSite, priority, sourceScheme, sourcePort, partitionKey, session, expires } = cookie;
	return {
		name,
		value,
		domain,
		path: cookiePath,
		secure,
		httpOnly,
		...(sameSite === undefined ? {} : { sameSite }),
		...(priority === undefined ? {} : { priority }),
		...(sourceScheme === undefined ? {} : { sourceScheme }),
		...(sourcePort === undefined ? {} : { sourcePort }),
		...(partitionKey === undefined ? {} : { partitionKey }),
		...(session === true || typeof expires !== "number" || expires <= 0 ? {} : { expires }),
	};
}

/** Evaluates `expression` in a page of `origin`, opened for it in a tab of its own and closed after: the page is what has the origin's storage. */
async function onOrigin(rpc: Rpc, origin: string, expression: string, browserContextId?: string): Promise<unknown> {
	const { targetId } = await rpc.call<{ targetId: string }>("Target.createTarget", { url: `${origin}/`, background: true, ...(browserContextId ? { browserContextId } : {}) });
	try {
		const { sessionId } = await rpc.call<{ sessionId: string }>("Target.attachToTarget", { targetId, flatten: true });
		for (let waited = 0; waited < 10_000; waited += 250) {
			const { result } = await rpc.call("Runtime.evaluate", { expression: `document.readyState !== "loading" && location.origin === ${JSON.stringify(origin)}`, returnByValue: true }, sessionId);
			if (result?.value === true) break;
			await new Promise((resolve) => setTimeout(resolve, 250));
		}
		const { result, exceptionDetails } = await rpc.call("Runtime.evaluate", { expression, returnByValue: true }, sessionId);
		if (exceptionDetails) throw new Error(`${origin}: ${exceptionDetails.text ?? "its storage couldn't be used"}`);
		return result?.value;
	} finally {
		await rpc.call("Target.closeTarget", { targetId }).catch(() => {});
	}
}

/**
 * Cua Driver as Cua's cua-spacesd on this computer serves it, at `base`
 * with the token in `tokenFile`: its MCP server, over streamable HTTP at
 * `/mcp`, in one session, which opens again if cua-spacesd forgets it (as
 * after it restarted). Only the result goes back to the space, which gets
 * the structured part only when there's no other.
 */
export function spacesdDriver(base: string, tokenFile: string): DriverHost {
	let session: Promise<string> | null = null;
	let next = 1;
	const post = async (body: unknown, sessionId?: string): Promise<Response> => {
		let token: string;
		try {
			token = (await fs.readFile(tokenFile, "utf8")).trim();
		} catch {
			throw new CallError(`This computer has no desktop tools: there's no cua-spacesd token at ${tokenFile}.`, "ENOSYS");
		}
		return fetch(new URL("/mcp", base), {
			method: "POST",
			headers: {
				authorization: `Bearer ${token}`,
				"content-type": "application/json",
				accept: "application/json, text/event-stream",
				...(sessionId ? { "mcp-session-id": sessionId } : {}),
			},
			body: JSON.stringify(body),
			signal: AbortSignal.timeout(120_000),
		}).catch((error: Error) => {
			throw new CallError(`cua-spacesd isn't answering at ${base}: ${error.message}`, "ESPACESD");
		});
	};
	// The answer to a request, sent as JSON or as an event stream whose last message with an id is it.
	const answer = async (response: Response): Promise<{ result?: Record<string, unknown>; error?: { message?: string } }> => {
		const body = await response.text();
		if (!(response.headers.get("content-type") ?? "").includes("text/event-stream")) return JSON.parse(body);
		const messages = body
			.split(/\r?\n/)
			.filter((line) => line.startsWith("data:"))
			.map((line) => JSON.parse(line.slice(5)) as Record<string, unknown>);
		const reply = messages.reverse().find((message) => "id" in message);
		if (!reply) throw new CallError("cua-spacesd's desktop tools sent no answer.", "ESPACESD");
		return reply;
	};
	const open = async (): Promise<string> => {
		const response = await post({
			jsonrpc: "2.0",
			id: next++,
			method: "initialize",
			params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "pim-computer", version: VERSION } },
		});
		await response.text();
		if (!response.ok) throw new CallError(`cua-spacesd refused its desktop tools: HTTP ${response.status}`, "ESPACESD");
		const id = response.headers.get("mcp-session-id") ?? "";
		await (await post({ jsonrpc: "2.0", method: "notifications/initialized" }, id)).text();
		return id;
	};
	return {
		async call(tool, args) {
			for (let attempt = 1; ; attempt++) {
				const opening = (session ??= open().catch((error: unknown) => {
					session = null;
					throw error;
				}));
				const id = await opening;
				// Cua Driver keeps a session for the MCP session that began it, and refuses it to another until it ends
				// (idle, minutes on), so one this program began before it restarted, or before its MCP session, is out
				// of reach: each MCP session's are its own.
				const sent = typeof args.session === "string" ? { ...args, session: `${args.session}-${id.slice(0, 8)}` } : args;
				const response = await post({ jsonrpc: "2.0", id: next++, method: "tools/call", params: { name: tool, arguments: sent } }, id);
				// A session it no longer knows: open another, once.
				if (response.status >= 400 && response.status < 500 && response.status !== 401 && attempt === 1) {
					await response.text();
					if (session === opening) session = null;
					continue;
				}
				if (!response.ok) throw new CallError(`cua-spacesd refused ${tool}: HTTP ${response.status}`, "ESPACESD");
				const reply = await answer(response);
				if (reply.error) throw new CallError(`${tool}: ${reply.error.message ?? "failed"}`, "EINVAL");
				const result = reply.result ?? {};
				const content = Array.isArray(result.content) ? result.content : [];
				return {
					content,
					...(content.length === 0 && result.structuredContent !== undefined ? { structuredContent: result.structuredContent } : {}),
					...(result.isError === true ? { isError: true } : {}),
				};
			}
		},
	};
}

/**
 * The desktop as Cua's cua-spacesd on this computer streams it, at `base`
 * with the token in `tokenFile` (Cua's images keep one readable by the
 * desktop's user: see `main`). Each stream is a media session of its
 * own: H.264 of the whole display, with the person's input allowed to
 * activate windows, as at the computer itself.
 */
export function spacesdScreen(base: string, tokenFile: string): ScreenHost {
	return {
		async clipboard() {
			const token = (await fs.readFile(tokenFile, "utf8").catch(() => "")).trim();
			if (!token) throw new CallError(`This computer doesn't stream its desktop: there's no cua-spacesd token at ${tokenFile}.`, "ENOSYS");
			// GetClipboardResponse: its content (1), whose text is its first field.
			let failure: unknown;
			try {
				const content = protoFields(await grpcWeb(base, token, "cua.env.v1.ComputerService/GetClipboard", [])).get(1);
				const text = new TextDecoder().decode(content ? protoFields(content).get(1) : undefined);
				if (text) return text;
			} catch (error) {
				failure = error;
			}
			// cua-spacesd reads the clipboard on Wayland only; an X11 desktop, such as Xfce, is read with the tools there.
			for (const args of [["xclip", "-o", "-selection", "clipboard"], ["xsel", "-b", "-o"], ["wl-paste", "-n"]]) {
				const read = await quietly(args[0]!, args.slice(1));
				if (read.code === 0 && read.output) return read.output;
			}
			if (failure) throw failure;
			return "";
		},
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
	// Displays for the threads' desktops, which never stops the install.
	await ensureDisplayd(url, (line) => console.log(line));
	const root = values.root ? path.resolve(values.root as string) : path.join(os.homedir(), "pim");
	console.log(`pim-computer ${VERSION} is installed and running, connecting to ${url}, with your files in ${root}.`);
	if (kind === "systemd" && !atBoot && !service.desktop) {
		console.log(`It runs while you're signed in. To run it from boot, without signing in: sudo loginctl enable-linger ${os.userInfo().username}`);
	}
	if (kind === "loop") console.log("This machine has no systemd for you, so it runs in the background until the machine restarts: run `pim-computer install` again then.");
	console.log(`Manage it with: pim-computer status | logs | update | uninstall${bin ? ` (add ${bin} to your PATH)` : ""}`);
}

/** Where displayd listens on a computer, and where its token is kept when the user may write /etc. */
const DISPLAYD_TOKEN_FILE = "/etc/displayd/token";

/** What `displaydUnit` and `displaydSetupScript` need to know about the computer. */
export type DisplaydSetup = {
	/** The Pim's address, which serves displayd's bundle at /displayd.tar.gz. */
	url: string;
	/** The computer's user, whose displays these are. */
	user: string;
	home: string;
	/** The Node.js that runs it. */
	node: string;
};

/**
 * displayd's systemd unit, for computers with systemd as root. It runs as the computer's user, so the
 * displays' cookies and sockets are readable by the programs pim-computer starts in them. KillMode=process
 * and a preserved runtime directory mean restarting it leaves the running displays alone: the next start
 * re-adopts them.
 */
export function displaydUnit({ user, home, node }: DisplaydSetup): string {
	return `[Unit]
Description=Pim display daemon
After=network.target

[Service]
Type=simple
User=${user}
Environment="HOME=${home}"
Environment="PATH=/usr/local/bin:/usr/bin:/bin"
Environment="DISPLAYD_TOKEN_FILE=${DISPLAYD_TOKEN_FILE}"
Environment="DISPLAYD_STATE_DIR=${home}/.displayd/state"
Environment="DISPLAYD_CONTEXT_DIR=/run/pim/displays"
ExecStart=${node} ${home}/.displayd/app/src/main.js
SyslogIdentifier=displayd
Restart=always
RestartSec=5
RuntimeDirectory=pim
RuntimeDirectoryMode=0755
RuntimeDirectoryPreserve=yes
# A restart of displayd must not end the displays: they run in their own process groups, and the next start re-adopts them.
KillMode=process

[Install]
WantedBy=multi-user.target
`;
}

/** The POSIX sh that ensures displayd, with @NAME@ where `displaydSetupScript` puts a value. It has no `${`, so it needs no escaping here. */
const DISPLAYD_SETUP = String.raw`# Ensures displayd on this computer: its packages, its files from the Pim, a token, and a service.
# It can be run again at any time, and never fails: what it can't do it says, and goes on.
URL=@URL@
ME=@USER@
HOME_DIR=@HOME@
NODE=@NODE@
D="$HOME_DIR/.displayd"
warn() { echo "displayd: $*" >&2; }
[ "$(uname -s)" = Linux ] || exit 0
# Only Cua's computers (or where PIM_DISPLAYD=1 says so) get displays: PIM_DISPLAYD=0 turns it off.
if [ "$PIM_DISPLAYD" = 0 ]; then exit 0; fi
if [ "$PIM_DISPLAYD" != 1 ] && [ ! -r /usr/local/bin/cua-spacesd ]; then exit 0; fi
mkdir -p "$D" && chmod 700 "$D" || { warn "can't make $D"; exit 0; }
if command -v flock >/dev/null 2>&1; then
	exec 9>"$D/setup.lock"
	flock -n 9 || { echo "displayd is being set up by another run."; exit 0; }
fi
if [ "$(id -u)" = 0 ]; then SUDO=""; CAN=1
elif sudo -n true 2>/dev/null; then SUDO="sudo -n"; CAN=1
else SUDO=""; CAN=0; fi
as_root() { if [ "$CAN" = 1 ]; then $SUDO "$@"; else return 1; fi; }
GROUP="$(id -gn)"

# 1. Its packages.
PACKAGES="tigervnc-standalone-server openbox dbus-x11 at-spi2-core xdotool xclip"
missing=0
for pkg in $PACKAGES; do
	dpkg -s "$pkg" 2>/dev/null | grep -q '^Status: install ok installed' || missing=1
done
if [ "$missing" = 1 ]; then
	if [ "$CAN" != 1 ]; then warn "some of $PACKAGES are missing, and there's no sudo to install them."
	elif ! command -v apt-get >/dev/null 2>&1; then warn "some of $PACKAGES are missing, and there's no apt-get to install them."
	else
		as_root env DEBIAN_FRONTEND=noninteractive apt-get install -y $PACKAGES >"$D/apt.log" 2>&1 ||
			{ as_root env DEBIAN_FRONTEND=noninteractive apt-get update >>"$D/apt.log" 2>&1 && as_root env DEBIAN_FRONTEND=noninteractive apt-get install -y $PACKAGES >>"$D/apt.log" 2>&1; } ||
			warn "couldn't install $PACKAGES; see $D/apt.log"
	fi
fi
command -v Xvnc >/dev/null 2>&1 && command -v openbox >/dev/null 2>&1 || { warn "Xvnc or openbox is missing, so displayd isn't set up."; exit 0; }

# 2. Its files, from the Pim's own copy.
changed=0
if curl -fsSL --retry 3 --max-time 60 "$URL/displayd.tar.gz" -o "$D/bundle.new" 2>/dev/null && tar -tzf "$D/bundle.new" 2>/dev/null | grep -qx src/main.js; then
	sum="$(sha256sum "$D/bundle.new" | cut -d' ' -f1)"
	if [ ! -f "$D/app/src/main.js" ] || [ "$sum" != "$(cat "$D/bundle.sha256" 2>/dev/null)" ]; then
		rm -rf "$D/app.new" "$D/app.old"
		mkdir "$D/app.new" && tar -xzf "$D/bundle.new" -C "$D/app.new" || { warn "couldn't unpack displayd's files"; rm -rf "$D/app.new"; exit 0; }
		if [ -d "$D/app" ]; then mv "$D/app" "$D/app.old"; fi
		mv "$D/app.new" "$D/app"
		rm -rf "$D/app.old"
		echo "$sum" >"$D/bundle.sha256"
		changed=1
	fi
else
	warn "couldn't get displayd's files from $URL"
fi
rm -f "$D/bundle.new"
[ -f "$D/app/src/main.js" ] || { warn "displayd's files aren't here, so it isn't set up."; exit 0; }

# 3. Its token, made once, which the computer's user can read; and its folders.
if [ "$CAN" = 1 ]; then
	TOKEN=@TOKEN_FILE@
	CONTEXT=/run/pim/displays
	as_root install -d -m 1777 /tmp/.X11-unix
	as_root install -d -o "$ME" -g "$GROUP" -m 0755 /run/pim
	as_root install -d -o "$ME" -g "$GROUP" -m 0700 /run/pim/displays
	if [ ! -s "$TOKEN" ] || [ ! -r "$TOKEN" ]; then
		head -c 24 /dev/urandom | od -An -tx1 | tr -d ' \n' | as_root sh -c 'umask 077 && install -d -m 0755 "$(dirname "$1")" && cat >"$1" && chown "$2" "$1" && chmod 0640 "$1"' sh "$TOKEN" "$ME:$GROUP" ||
			warn "couldn't make $TOKEN"
	fi
else
	TOKEN="$D/token"
	CONTEXT="$D/displays"
	warn "no sudo, so its token and displays are kept in $D."
	if [ ! -s "$TOKEN" ]; then (umask 077 && head -c 24 /dev/urandom | od -An -tx1 | tr -d ' \n' >"$TOKEN"); fi
fi
[ -s "$TOKEN" ] && [ -r "$TOKEN" ] || { warn "it has no token, so isn't started."; exit 0; }

# 4. A service: systemd's, where there is systemd and root, or else a loop of the user's.
if [ "$CAN" = 1 ] && [ -d /run/systemd/system ] && command -v systemctl >/dev/null 2>&1; then
	cat >"$D/unit.new" <<'UNIT'
@UNIT@
UNIT
	if ! cmp -s "$D/unit.new" /etc/systemd/system/displayd.service; then
		as_root install -m 0644 "$D/unit.new" /etc/systemd/system/displayd.service && as_root systemctl daemon-reload && changed=1
	fi
	rm -f "$D/unit.new"
	as_root systemctl enable displayd.service >/dev/null 2>&1
	# A restart leaves the displays running (KillMode=process), and the new one re-adopts them.
	if [ "$changed" = 1 ]; then as_root systemctl restart displayd.service; else as_root systemctl start displayd.service; fi || warn "systemd didn't start displayd."
else
	cat >"$D/start" <<RUN
#!/bin/sh
export HOME='$HOME_DIR' DISPLAYD_TOKEN_FILE='$TOKEN' DISPLAYD_STATE_DIR='$D/state' DISPLAYD_CONTEXT_DIR='$CONTEXT'
if [ '$CAN' = 1 ] && [ ! -d /run/pim/displays ]; then
	$SUDO install -d -m 1777 /tmp/.X11-unix
	$SUDO install -d -o '$ME' -g '$GROUP' -m 0755 /run/pim
	$SUDO install -d -o '$ME' -g '$GROUP' -m 0700 /run/pim/displays
fi
echo \$\$ >'$D/displayd.pid'
exec '$NODE' '$D/app/src/main.js'
RUN
	chmod 755 "$D/start"
	printf '#!/bin/sh\necho $$ >"%s/loop.pid"\nwhile :; do "%s/start"; sleep 5; done\n' "$D" "$D" >"$D/loop"
	chmod 755 "$D/loop"
	loop="$(cat "$D/loop.pid" 2>/dev/null)"
	if [ -n "$loop" ] && kill -0 "$loop" 2>/dev/null && tr '\0' ' ' <"/proc/$loop/cmdline" 2>/dev/null | grep -q "$D/loop"; then
		# Only displayd itself ends: the loop starts it again, and the displays are in groups of their own.
		if [ "$changed" = 1 ]; then kill "$(cat "$D/displayd.pid" 2>/dev/null)" 2>/dev/null; fi
	elif command -v setsid >/dev/null 2>&1; then setsid sh "$D/loop" >>"$D/log" 2>&1 </dev/null 9>&- &
	else nohup sh "$D/loop" >>"$D/log" 2>&1 </dev/null 9>&- &
	fi
fi

# 5. Whether it answers.
for _ in 1 2 3 4 5 6 7 8 9 10 11 12 13 14 15; do
	if curl -fsS -m 3 -H "authorization: Bearer $(cat "$TOKEN")" http://127.0.0.1:9900/health >/dev/null 2>&1; then echo "displayd is healthy on 127.0.0.1:9900."; exit 0; fi
	sleep 1
done
warn "it did not answer /health with its token; see journalctl -u displayd, or $D/log."
exit 0
`;

/** The sh that ensures displayd on this computer (see `DISPLAYD_SETUP`), for `setup`. */
export function displaydSetupScript(setup: DisplaydSetup): string {
	const values: Record<string, string> = {
		URL: shellQuote(setup.url.replace(/\/+$/, "")),
		USER: shellQuote(setup.user),
		HOME: shellQuote(setup.home),
		NODE: shellQuote(setup.node),
		TOKEN_FILE: shellQuote(DISPLAYD_TOKEN_FILE),
		UNIT: displaydUnit(setup).trimEnd(),
	};
	return DISPLAYD_SETUP.replace(/@([A-Z_]+)@/g, (_, name: string) => values[name] ?? "");
}

/**
 * Ensures displayd (../displayd) runs on this computer, so each thread can have a display of its own:
 * `displaydSetupScript`, run with sh. It never throws, so it can't stop pim-computer or its install;
 * what it says is passed to `say`.
 */
export async function ensureDisplayd(url: string, say: (line: string) => void): Promise<void> {
	try {
		const os = await import("node:os");
		const script = displaydSetupScript({ url, user: os.userInfo().username, home: os.homedir(), node: process.execPath });
		const { spawn } = await import("node:child_process");
		await new Promise<void>((resolve) => {
			const child = spawn("/bin/sh", ["-c", script], { stdio: ["ignore", "pipe", "pipe"], timeout: 600_000 });
			const lines = (chunk: Buffer) => chunk.toString("utf8").split("\n").filter(Boolean).forEach(say);
			child.stdout.on("data", lines);
			child.stderr.on("data", lines);
			child.on("error", (error) => {
				say(`displayd: couldn't be set up: ${error.message}`);
				resolve();
			});
			child.on("close", () => resolve());
		});
	} catch (error) {
		say(`displayd: couldn't be set up: ${(error as Error).message}`);
	}
}

/**
 * displayd inside the container image (deploy/Dockerfile.computer), which sets `PIM_DISPLAYD_EMBEDDED=1`: there is no systemd and no root there, so pim-computer starts displayd itself as a
 * child, with its state and token in the computer's home (the token file where `DisplayClient` looks for it) and its displays' contexts in /tmp, and starts it again if it exits. The
 * displays are processes of their own, which the next displayd re-adopts. Returns null where this isn't asked for or the display's programs (Xvnc, openbox, dbus-daemon, xauth) are
 * not installed, saying why; it never throws.
 */
export async function startEmbeddedDisplayd(options: { env?: NodeJS.ProcessEnv; home?: string; node?: string; say: (line: string) => void; spawnProcess?: (command: string, args: string[], options: { env: NodeJS.ProcessEnv; stdio: ["ignore", "pipe", "pipe"] }) => ChildProcess; restartMs?: number }): Promise<{ stop(): void } | null> {
	const env = options.env ?? process.env;
	if (env.PIM_DISPLAYD_EMBEDDED !== "1") return null;
	const { say } = options;
	try {
		const main = env.PIM_DISPLAYD_MAIN ?? "/app/displayd/src/main.js";
		await fs.access(main);
		for (const program of ["Xvnc", "openbox", "dbus-daemon", "xauth"]) {
			const found = await Promise.all((env.PATH ?? "/usr/local/bin:/usr/bin:/bin").split(":").map((dir) => fs.access(path.join(dir, program)).then(() => true, () => false)));
			if (!found.some(Boolean)) {
				say(`displayd: ${program} is missing in this image, so there are no displays of their own.`);
				return null;
			}
		}
		const home = options.home ?? env.HOME ?? "/home/node";
		const dir = path.join(home, ".displayd");
		await fs.mkdir(path.join(dir, "state"), { recursive: true, mode: 0o700 });
		const tokenFile = path.join(dir, "token");
		if (!(await fs.readFile(tokenFile, "utf8").catch(() => "")).trim()) await fs.writeFile(tokenFile, `${randomBytes(24).toString("hex")}\n`, { mode: 0o600 });
		// Xvnc's sockets: the directory X expects, which a read-only root has only in /tmp.
		await fs.mkdir("/tmp/.X11-unix", { recursive: true, mode: 0o1777 }).catch(() => {});
		const childEnv = { ...env, DISPLAYD_TOKEN_FILE: tokenFile, DISPLAYD_STATE_DIR: path.join(dir, "state"), DISPLAYD_CONTEXT_DIR: env.DISPLAYD_CONTEXT_DIR ?? "/tmp/pim-displays", DISPLAYD_HOST: "127.0.0.1" };
		const start = options.spawnProcess ?? (await import("node:child_process")).spawn;
		let stopped = false;
		let child: ChildProcess | undefined;
		const run = () => {
			child = start(options.node ?? process.execPath, [main], { env: childEnv, stdio: ["ignore", "pipe", "pipe"] });
			const lines = (chunk: Buffer) => chunk.toString("utf8").split("\n").filter(Boolean).forEach((line) => say(`displayd: ${line}`));
			child.stdout?.on("data", lines);
			child.stderr?.on("data", lines);
			child.on("error", (error) => say(`displayd: couldn't start: ${error.message}`));
			child.on("exit", (code) => {
				if (stopped) return;
				say(`displayd: exited (${code}); starting it again.`);
				setTimeout(() => !stopped && run(), options.restartMs ?? 2_000).unref();
			});
		};
		run();
		return { stop: () => ((stopped = true), void child?.kill("SIGTERM")) };
	} catch (error) {
		say(`displayd: couldn't be started: ${error instanceof Error ? error.message : String(error)}`);
		return null;
	}
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
                    with its token in the file PIM_SPACESD_TOKEN_FILE names (/run/cua-env/env-token or /run/cua/env-token)

install takes the same options, which the service then runs with, and --desktop, to start with the desktop's
session rather than at login or boot. The browser keeps its profile, with what you sign in to there, in
~/.pim-computer/browser.`;

/**
 * The triggers runtime's modules (./triggers-host.ts and what it imports),
 * which the Pim serves beside this file (web/vite.config.ts). The Pim's
 * install and update download this file alone, so an installed computer
 * gets these from the Pim as it starts (`loadTriggers`).
 */
export const TRIGGERS_MODULES = [
	"triggers-host.ts",
	"triggers-runtime.ts",
	"triggers-adapters/index.ts",
	"triggers-adapters/managed.ts",
	"triggers-adapters/poll.ts",
	"triggers-adapters/process.ts",
	"triggers-adapters/stream.ts",
] as const;

/**
 * Where the triggers runtime's modules are: beside this file, as in Pim's
 * own source; or else the Pim's newest copy, which this gets into
 * `stateDir/triggers-runtime` each time it starts, all of them or none, and
 * the copy from before when it can't. Null with neither.
 */
async function triggersModules(url: string | undefined, stateDir: string, log: (line: string) => void): Promise<string | null> {
	const { fileURLToPath } = await import("node:url");
	const exists = (folder: string) => fs.access(path.join(folder, "triggers-host.ts")).then(() => true, () => false);
	const here = path.dirname(fileURLToPath(import.meta.url));
	if (await exists(here)) return here;
	const folder = path.join(stateDir, "triggers-runtime");
	if (url) {
		const next = `${folder}.next`;
		try {
			await fs.rm(next, { recursive: true, force: true });
			for (const file of TRIGGERS_MODULES) {
				const response = await fetch(`${url.replace(/\/+$/, "")}/${file}`, { signal: AbortSignal.timeout(30_000) });
				// A Pim without the file answers with its app's page.
				if (!response.ok || response.headers.get("content-type")?.startsWith("text/html")) throw new Error(`${file}: ${response.status}`);
				await fs.mkdir(path.dirname(path.join(next, file)), { recursive: true, mode: 0o700 });
				await fs.writeFile(path.join(next, file), Buffer.from(await response.arrayBuffer()), { mode: 0o600 });
			}
			await fs.rm(folder, { recursive: true, force: true });
			await fs.rename(next, folder);
		} catch (error) {
			await fs.rm(next, { recursive: true, force: true }).catch(() => {});
			log(`Couldn't get the triggers runtime from your Pim (${(error as Error).message}), so this uses the copy from before, if there is one.`);
		}
	}
	return (await exists(folder)) ? folder : null;
}

/**
 * The triggers host (./triggers-host.ts), from the runtime's modules
 * (`triggersModules`); null, with nothing of triggers made or listened
 * for, when they can't be had or the host can't start here.
 */
export async function loadTriggers(options: TriggersHostOptions & { readonly url?: string }): Promise<TriggersHost | null> {
	try {
		const folder = await triggersModules(options.url, options.stateDir, options.log);
		if (!folder) throw new Error("no runtime");
		const { startTriggers } = (await import(pathToFileURL(path.join(folder, "triggers-host.ts")).href)) as typeof import("./triggers-host.ts");
		return await startTriggers(options);
	} catch {
		options.log("The triggers runtime couldn't start here, so this computer runs no triggers.");
		return null;
	}
}

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
	// Cua's containers keep it readable by the desktop's user at /run/cua/env-token; its VMs keep that one root's
	// own and a copy for the desktop's user at /run/cua-env/env-token, which appears a moment after cua-spacesd starts.
	const readable = (file: string) => fs.access(file, fs.constants.R_OK).then(() => true, () => false);
	const tokenFiles = env.PIM_SPACESD_TOKEN_FILE ? [env.PIM_SPACESD_TOKEN_FILE] : ["/run/cua-env/env-token", "/run/cua/env-token"];
	const cuaImage = await readable("/usr/local/bin/cua-spacesd");
	let spacesdTokenFile: string | undefined;
	for (let waited = 0; ; waited += 1_000) {
		for (const file of tokenFiles) if (!spacesdTokenFile && (await readable(file))) spacesdTokenFile = file;
		if (spacesdTokenFile || !cuaImage || waited >= 60_000) break;
		await new Promise((resolve) => setTimeout(resolve, 1_000));
	}
	if (cuaImage && !spacesdTokenFile) log(`cua-spacesd is here, but none of ${tokenFiles.join(", ")} is readable: the desktop won't stream, and the agents can't use its apps.`);
	const spacesd = values.spacesd ?? env.PIM_SPACESD_URL ?? "http://127.0.0.1:3211";
	const screen = spacesdTokenFile ? spacesdScreen(spacesd, spacesdTokenFile) : undefined;
	const driver = spacesdTokenFile ? spacesdDriver(spacesd, spacesdTokenFile) : undefined;
	// Triggers' observers, like apps, outlast a dropped connection until the space's lease ends, and end with this process.
	const triggers = await loadTriggers({ url, token: token!, stateDir: path.join(os.homedir(), ".pim-computer"), root, log });
	// Apps keep running when the connection to the space drops; they end with this process.
	const apps = new Apps();
	process.on("exit", () => apps.killAll());
	if (triggers) process.on("exit", () => triggers.killOwned());
	// Set once the agents' browser exists: saves their sign-ins and quits it before the program exits.
	let endBrowsers: () => Promise<unknown> = async () => {};
	const stop = () => Promise.allSettled([apps.stopAll(), endBrowsers(), ...(triggers ? [triggers.close()] : [])]).finally(() => process.exit(0));
	for (const signal of ["SIGTERM", "SIGINT"] as const) process.on(signal, () => void stop());
	const displays = new DisplayClient({
		url: env.DISPLAYD_URL ?? "http://127.0.0.1:9900",
		...(env.DISPLAYD_TOKEN
			? { token: env.DISPLAYD_TOKEN }
			: env.DISPLAYD_TOKEN_FILE
				? { tokenFile: env.DISPLAYD_TOKEN_FILE }
				: {}),
	});
	// The agents browse in one headless Chrome of their own, each agent in a context with its own sign-ins and the person's copied in.
	const agentBrowsers =
		chrome && browser
			? new AgentBrowsers({
					shared: localBrowser(chrome, path.join(os.homedir(), ".pim-computer", "agents-browser"), false, log, false),
					root: path.join(os.homedir(), ".pim-computer", "agents"),
					primaryProfile: path.join(os.homedir(), ".pim-computer", "browser"),
					primary: browser,
					storageOrigins: path.join(os.homedir(), ".displayd", "storage-origins.json"),
					sites: () => displays.sites(),
					log,
				})
			: undefined;
	if (agentBrowsers) endBrowsers = () => agentBrowsers.endAll();
	const machine: Machine = {
		root,
		exec: (args, cwd) => runCommand(args, cwd, root),
		...(browser ? { browser } : {}),
		...(agentBrowsers ? { agentBrowsers } : {}),
		...(screen ? { screen } : {}),
		...(driver ? { driver } : {}),
		displays,
		apps,
		terminals: new Terminals(),
	};
	// An update of pim-computer is how an older computer gets displayd, which runs on in the background and never stops this.
	const embedded = await startEmbeddedDisplayd({ say: log });
	if (embedded) process.on("exit", () => embedded.stop());
	else void ensureDisplayd(url, log);
	const hello = {
		type: "hello",
		version: PROTOCOL_VERSION,
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
		desktop: driver !== undefined,
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
			triggers?.attach(socket);
		});
		socket.addEventListener("message", (event) => {
			if (typeof event.data !== "string" || event.data === "pong") return;
			if (triggers?.receive(socket, event.data)) return;
			logRun(event.data);
			link.receive(event.data);
		});
		socket.addEventListener("close", (event) => {
			clearInterval(ping);
			link.close();
			triggers?.detach(socket);
			if (event.code === REPLACED) {
				log("Another computer connected with this token, so this one stops.");
				if (!triggers) process.exit(1);
				void triggers.close().finally(() => process.exit(1));
				return;
			}
			const retry = () => {
				log(`${ping ? "Disconnected" : "Couldn't connect"}${event.reason ? ` (${event.reason})` : ""}; trying again in ${wait / 1000} s.`);
				setTimeout(connect, wait);
				wait = Math.min(wait * 2, 60_000);
			};
			if (event.code === OUTDATED) {
				// Where something restarts this process (the installed service, whose `run` fetches the newest program at each start, or a container), exiting is the update, when there is a newer one; in a terminal it isn't. The space asks once in a while: a computer that can't update goes on, and works as an older one does.
				void (async () => {
					const running = realpathSync(process.argv[1]!);
					const how = supervision(env, process.pid, await fs.access("/.dockerenv").then(() => true, () => false));
					const next = how ? await newerProgram(url, running) : null;
					if (next === null) {
						log("Your Pim has a newer pim-computer; run 'pim-computer update' to update.");
						return retry();
					}
					// A container's restart policy starts it again, usually by fetching the program, and the copy written here covers one that doesn't.
					if (how === "container") {
						await fs.writeFile(`${running}.next`, next).then(() => fs.rename(`${running}.next`, running)).catch(() => undefined);
					}
					log("Your Pim has a newer pim-computer; restarting to update.");
					await stop();
				})();
				return;
			}
			// A token Pim doesn't know is refused before the connection opens, which looks the same as being offline.
			retry();
		});
		socket.addEventListener("error", () => {
			// "close" follows, and tries again.
		});
	};
	connect();
}

/**
 * What restarts this process when it exits: the installed service, a container
 * (its restart policy), or nothing, as in a terminal, where exiting would end it.
 */
export function supervision(env: Record<string, string | undefined>, pid: number, container: boolean): "service" | "container" | null {
	if (env.PIM_COMPUTER_TOKEN_FILE) return "service";
	return container || pid === 1 ? "container" : null;
}

/**
 * What your Pim serves as pim-computer, when it isn't the program in `running`
 * (a file): the program text. Null when it is the same, or what the Pim
 * answered isn't a program, so a computer asked to update restarts only when
 * restarting would run something new.
 */
export async function newerProgram(url: string, running: string, fetcher: typeof fetch = fetch): Promise<string | null> {
	try {
		const response = await fetcher(`${url.replace(/\/+$/, "")}/pim-computer.ts`, { signal: AbortSignal.timeout(30_000) });
		if (!response.ok) return null;
		const text = await response.text();
		if (text.trim() === "" || text.trimStart().startsWith("<")) return null;
		const current = await fs.readFile(running);
		return sha256(Buffer.from(text)) === sha256(current) ? null : text;
	} catch {
		return null;
	}
}

// Run as a program, not when tests import `handle`.
if (typeof process !== "undefined" && process.argv?.[1] && import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href) void main();
