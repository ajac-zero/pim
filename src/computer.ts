import { Buffer } from "node:buffer";
import { posix } from "node:path";
import type { Connection } from "agents";
import type { ExecArgs, ExecResult, FileConflict, WatchEvent, WriteResult } from "../computer/pim-computer";
import { digestHex } from "./auth/store";
import { HttpError } from "./http";

/**
 * The person's computer: a machine running `pim-computer`
 * (../computer/pim-computer.ts), which their agents use to run commands,
 * keep files and browse (its Chrome, driven over DevTools through the same
 * connection: `connectBrowser`), and whose desktop the person can use from
 * the app, where it streams one (`openScreen`). It connects out with a token,
 * `pimc_<owner>_<secret>`, to `/api/computer/connect` over a WebSocket, which
 * the Worker hands to this space as `COMPUTER_PATH`, and answers the space's
 * calls on it. The space keeps only the token's digest, and what the
 * computer last said about itself.
 *
 * It is either the person's own, a server, a VM or a box at home that
 * Settings → Computer pairs by making a token, or the one this Pim's
 * computer host keeps for the space (`provide`): an Ubuntu desktop, a VM
 * or a container, on the operator's machine, made with Cua (../computer/pim-host.ts), which the
 * host gives the token to. That one is permanent: it runs all the time, and
 * goes only with the space.
 *
 * A space has at most one computer. It is paired from when the token is made
 * until it is forgotten, and online while it is connected: the tools that
 * use it are offered while it is paired, so a computer that drops off for a
 * moment doesn't change what agents can do, and they hear it's offline when
 * they try.
 */

/** Where the space takes the computer's connection, behind the Worker's `/api/computer/connect`. */
export const COMPUTER_PATH = "/computer/connect";
/** The header the Worker passes the computer's token in. */
export const COMPUTER_TOKEN_HEADER = "x-pim-computer-token";
/** The tag of the computer's connection among the space's sockets. */
export const COMPUTER_TAG = "computer";
/** Where the person's app connects to see and use the computer's desktop, behind the Worker's `/api/computer/screen`. */
export const COMPUTER_SCREEN_PATH = "/computer/screen";
/** The tag of the sockets of the apps showing the desktop. */
export const SCREEN_TAG = "screen";
/**
 * How a message from an app showing the desktop begins when it times its
 * round trips, which the space answers itself (with its own round trip to
 * the computer) rather than passing it on to the stream.
 */
export const SCREEN_PING = '{"type":"pim_ping"';
/** What the app sends, as text, to read what the person copied on the computer; answered by the space, like a ping. */
export const SCREEN_CLIPBOARD = '{"type":"pim_clipboard"';
/** The close code an old connection gets when another one replaces it (pim-computer's `REPLACED`). */
const REPLACED = 4409;
/** The most bytes the computer gives in one read (pim-computer's `MAX_READ_BYTES`), and the most this sends in one write. */
const CHUNK_BYTES = 1_048_576;
/** How long a file call may take. */
const FILE_CALL_MS = 30_000;
/** What a command may take by default, and at most. */
export const DEFAULT_COMMAND_MS = 120_000;
export const MAX_COMMAND_MS = 600_000;
/** How much of each of a command's outputs comes back. */
const COMMAND_OUTPUT_BYTES = 64_000;

const TOKEN_KEY = "computer_token";
/** The name of the machine the computer host keeps for the space, when it keeps one. */
const MACHINE_KEY = "computer_machine";
/** Why the computer host couldn't set that machine up, the last time it tried. */
const SETUP_ERROR_KEY = "computer_setup_error";
const PAIRED_AT_KEY = "computer_paired_at";
const INFO_KEY = "computer_info";
/** How long one of Cua Driver's tools may take: it waits for windows and pages itself. */
const DRIVER_CALL_MS = 120_000;
/** How long the computer may take to answer a ping before it counts as no answer. */
const PING_MS = 5_000;

/** The owner a computer's token names. Whether it is really theirs is for their space to say. */
export function computerTokenOwner(token: string): string | null {
	return /^pimc_(o_[0-9a-z]{26})_[\w-]+$/.exec(token)?.[1] ?? null;
}

/** What the computer said about itself when it last connected. */
export type ComputerInfo = {
	readonly agent: string;
	readonly hostname: string;
	readonly platform: string;
	readonly arch: string;
	readonly user: string;
	/** The folder on it that is `/workspace`. */
	readonly root: string;
	/** The Chrome the agents browse with there, or null where it has none. */
	readonly browser: string | null;
	/** Whether it streams its desktop, for the person to use from the app. */
	readonly screen: boolean;
	/** Whether its agents can use its desktop's apps, with Cua Driver's tools. */
	readonly desktop: boolean;
	readonly connectedAt: number;
};

export type ComputerState = "none" | "offline" | "online";

export type ComputerStatus = {
	readonly state: ComputerState;
	/** Whether it's the one this Pim's computer host keeps for the space: permanent, and set up by the host. */
	readonly managed: boolean;
	readonly pairedAt: number | null;
	readonly computer: ComputerInfo | null;
	/** Why the computer host couldn't set it up, until it connects. */
	readonly error: string | null;
};

type Meta = {
	meta(key: string): string | undefined;
	setMeta(key: string, value: string): void;
	deleteMeta(key: string): void;
};

/** A DevTools connection to the computer's browser, as puppeteer's `ConnectionTransport`. */
export type BrowserTransport = {
	send(message: string): void;
	close(): void;
	onmessage?: (message: string) => void;
	onclose?: () => void;
	/** What the computer says the agent should know of this browser first, such as that no sign-ins were copied into it. */
	note?: string;
};

/** The most files the space watches at once, and the most listeners of each kind it keeps. */
export const MAX_WATCHED_PATHS = 64;
export const MAX_FILE_LISTENERS = 32;

/** What `watch` says of a file when it starts being watched: the file as it is then. */
export type WatchState = { readonly path: string; readonly sha256: string | null; readonly size: number | null; readonly exists: boolean };

/** A change to a watched file, or the failure of its watcher, as the computer pushes it. */
export type FileEvent = WatchEvent extends infer E ? (E extends unknown ? Omit<E, "type"> : never) : never;

type Pending = { resolve(value: unknown): void; reject(error: Error): void; timer: ReturnType<typeof setTimeout> };

/** One of the computer's per-thread displays, as its displayd reports it. */
export type ComputerDisplay = {
	threadId: string;
	state: "queued" | "starting" | "active" | "idle";
	control: "agent" | "user";
	idleSec: number;
	position?: number;
	estimatedWaitSec?: number;
};

/** A conditional write that didn't happen because the file isn't what the writer expected; the API answers it 409 with `conflict` as its body. */
export class FileConflictError extends HttpError {
	constructor(readonly conflict: FileConflict) {
		super(409, `${conflict.path} is not as expected (${conflict.code})`, conflict);
	}
}

/** A failure the computer reported, with its code (`ENOENT`…), which the file tools read. */
function remoteError(error: { message?: unknown; code?: unknown; conflict?: unknown }): Error {
	if (error.code === "conflict" && error.conflict) return new FileConflictError(error.conflict as FileConflict);
	return Object.assign(new Error(String(error.message ?? "The computer failed")), typeof error.code === "string" ? { code: error.code } : {});
}

export class Computer {
	readonly #meta: Meta;
	readonly #sockets: () => Connection[];
	readonly #pending = new Map<string, Pending>();
	/** The DevTools connections to the computer's browsers, one for each thread (and one for calls without a thread), by thread. */
	readonly #browsers = new Map<string, { channel: number; transport: BrowserTransport }>();
	/** Where the desktop's streams go: what a channel's stream says, as text or binary, or null once it's closed. */
	readonly #screen: (channel: number, data: string | ArrayBuffer | null) => void;
	/** The files watched, with how many times each was asked for. The computer keeps the same counts for a connection, so they are asked for again when it reconnects. */
	readonly #watching = new Map<string, number>();
	/** Watch operations that must not overlap: a reconnect's asking again and a person's `watch`. */
	#queue: Promise<void> = Promise.resolve();
	/** While a reconnect asks for the watches again: how many of each path's the computer has been asked for so far. */
	readonly #resuming = new Map<string, number>();
	readonly #fileListeners = new Set<(event: FileEvent) => void>();
	readonly #resumedListeners = new Set<(state: WatchState) => void>();

	constructor(options: { meta: Meta; sockets: () => Connection[]; screen: (channel: number, data: string | ArrayBuffer | null) => void }) {
		this.#meta = options.meta;
		this.#sockets = options.sockets;
		this.#screen = options.screen;
	}

	/** The machine the computer host keeps for the space, or null for a computer the person brought. */
	machine(): string | null {
		return this.#meta.meta(MACHINE_KEY) ?? null;
	}

	/**
	 * The computer is now the machine the computer host keeps for the space,
	 * `name`, in place of any other: the token it connects with is returned,
	 * for the host to give it, and only its digest is kept.
	 */
	async provide(owner: string, name: string, now: number): Promise<string> {
		const token = await this.pair(owner, now);
		this.#meta.setMeta(MACHINE_KEY, name);
		return token;
	}

	/** The computer host couldn't set the machine up: the person hears why until it connects. */
	setupFailed(message: string): void {
		if (this.machine()) this.#meta.setMeta(SETUP_ERROR_KEY, message.slice(0, 500));
	}

	/** Whether a computer is paired, online or not: one the person brought, or the one the computer host keeps. */
	paired(): boolean {
		return this.#meta.meta(TOKEN_KEY) !== undefined;
	}

	#socket(): Connection | undefined {
		return this.#sockets().find((socket) => socket.readyState === WebSocket.OPEN);
	}

	status(): ComputerStatus {
		if (!this.paired()) return { state: "none", managed: false, pairedAt: null, computer: null, error: null };
		const info = this.#meta.meta(INFO_KEY);
		return {
			state: this.#socket() ? "online" : "offline",
			managed: this.machine() !== null,
			pairedAt: Number(this.#meta.meta(PAIRED_AT_KEY)),
			computer: info ? (JSON.parse(info) as ComputerInfo) : null,
			error: this.#meta.meta(SETUP_ERROR_KEY) ?? null,
		};
	}

	/** Pairs a new computer, in place of any other: the token is returned only here, and only its digest is kept. */
	async pair(owner: string, now: number): Promise<string> {
		const secret = Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString("base64url");
		const token = `pimc_${owner}_${secret}`;
		this.#meta.setMeta(TOKEN_KEY, await digestHex(token));
		this.#meta.setMeta(PAIRED_AT_KEY, String(now));
		this.#meta.deleteMeta(INFO_KEY);
		this.#meta.deleteMeta(MACHINE_KEY);
		this.#meta.deleteMeta(SETUP_ERROR_KEY);
		this.disconnect("A new computer was paired");
		return token;
	}

	/**
	 * Forgets a Fly.io Sprite that Pim started for the space before it kept
	 * computers with a host: a machine with no token, which nothing reaches
	 * anymore. Its name, for the operator to delete it, or null when the
	 * space has none.
	 */
	forgetSprite(): string | null {
		const name = this.machine();
		if (name === null || this.paired()) return null;
		this.forget();
		return name;
	}

	/** Forgets the computer: its token stops working, and it is disconnected. Its files stay on it. */
	forget(): void {
		this.#meta.deleteMeta(TOKEN_KEY);
		this.#meta.deleteMeta(PAIRED_AT_KEY);
		this.#meta.deleteMeta(INFO_KEY);
		this.#meta.deleteMeta(MACHINE_KEY);
		this.#meta.deleteMeta(SETUP_ERROR_KEY);
		this.disconnect("The computer was removed");
	}

	disconnect(reason: string): void {
		for (const socket of this.#sockets()) socket.close(REPLACED, reason);
		this.#failPending();
	}

	/** The digest of the paired computer's token, as kept; null with none paired. Triggers on the computer name its runtime by it. */
	tokenDigest(): string | null {
		return this.#meta.meta(TOKEN_KEY) ?? null;
	}

	async checkToken(token: string | null): Promise<boolean> {
		const known = this.#meta.meta(TOKEN_KEY);
		return token !== null && known !== undefined && (await digestHex(token)) === known;
	}

	/**
	 * A computer connected: it takes the place of any other connection. What
	 * went over the one before ends now, since this one knows nothing of it:
	 * its calls fail, and the browser's DevTools connection closes. A
	 * computer that lost its connection may connect again before the space
	 * hears the old one close.
	 */
	connected(connection: Connection): void {
		for (const socket of this.#sockets()) {
			if (socket.id !== connection.id) socket.close(REPLACED, "Another computer connected with this token");
		}
		this.#failPending();
	}

	/** The connection closed: calls waiting on it fail now rather than at their timeouts. */
	disconnected(): void {
		if (this.#socket()) return;
		this.#failPending();
	}

	#failPending(): void {
		for (const thread of [...this.#browsers.keys()]) this.#browserClosed(thread);
		for (const [id, pending] of this.#pending) {
			clearTimeout(pending.timer);
			pending.reject(new HttpError(503, "The computer disconnected before it answered."));
			this.#pending.delete(id);
		}
	}

	/** A message from the computer: what it is, an answer to a call, or what one of the desktop's streams says. */
	receive(raw: string | ArrayBuffer): void {
		if (typeof raw !== "string") {
			// The desktop's video: its channel in the first four bytes.
			if (raw.byteLength > 4) this.#screen(new DataView(raw).getUint32(0), raw.slice(4));
			return;
		}
		let message: { type?: unknown; id?: unknown; result?: unknown; error?: { message?: unknown; code?: unknown } };
		try {
			message = JSON.parse(raw);
		} catch {
			return;
		}
		if (message.type === "hello") {
			const hello = message as Record<string, unknown>;
			const info: ComputerInfo = {
				agent: String(hello.agent ?? ""),
				hostname: String(hello.hostname ?? ""),
				platform: String(hello.platform ?? ""),
				arch: String(hello.arch ?? ""),
				user: String(hello.user ?? ""),
				root: String(hello.root ?? ""),
				browser: typeof hello.browser === "string" ? hello.browser : null,
				screen: hello.screen === true,
				desktop: hello.desktop === true,
				connectedAt: Date.now(),
			};
			this.#meta.setMeta(INFO_KEY, JSON.stringify(info));
			this.#meta.deleteMeta(SETUP_ERROR_KEY);
			void this.#rewatch();
			return;
		}
		if (message.type === "event") {
			const event = message as { event?: unknown; path?: unknown };
			// Events of kinds this doesn't know are for a newer computer, and are ignored.
			if ((event.event !== "file_changed" && event.event !== "watch_error") || typeof event.path !== "string") return;
			if (event.event === "watch_error") this.#watching.delete(event.path);
			const { type: _type, ...rest } = message as { type: unknown } & FileEvent;
			for (const listener of [...this.#fileListeners]) listener(rest as FileEvent);
			return;
		}
		if (message.type === "screen" || message.type === "screen_closed") {
			const { channel, data } = message as { channel?: unknown; data?: unknown };
			if (typeof channel !== "number") return;
			if (message.type === "screen_closed") this.#screen(channel, null);
			else if (typeof data === "string") this.#screen(channel, data);
			return;
		}
		if (message.type === "cdp" || message.type === "cdp_closed") {
			const channel = (message as { channel?: unknown }).channel;
			const found = [...this.#browsers].find(([, browser]) => browser.channel === channel);
			if (!found) return;
			if (message.type === "cdp_closed") this.#browserClosed(found[0]);
			else found[1].transport.onmessage?.(String((message as { data?: unknown }).data));
			return;
		}
		if (message.type !== "reply" || typeof message.id !== "string") return;
		const pending = this.#pending.get(message.id);
		if (!pending) return;
		this.#pending.delete(message.id);
		clearTimeout(pending.timer);
		if (message.error) pending.reject(remoteError(message.error));
		else pending.resolve(message.result ?? null);
	}

	/** Calls the computer and waits for its answer. */
	async call<T = unknown>(op: string, args: Record<string, unknown>, timeoutMs = FILE_CALL_MS): Promise<T> {
		if (!this.paired()) throw new HttpError(404, "No computer is connected. The person can connect one in Settings → Computer.");
		const socket = this.#socket();
		if (!socket) {
			throw new HttpError(
				503,
				this.machine()
					? "The computer is offline: it's starting, or its host is down. Try again in a few minutes."
					: "The computer is offline: pim-computer isn't connected. Ask the person to start it again.",
			);
		}
		const id = crypto.randomUUID();
		return new Promise<T>((resolve, reject) => {
			const timer = setTimeout(() => {
				this.#pending.delete(id);
				reject(new HttpError(504, `The computer didn't answer within ${Math.round(timeoutMs / 1000)} seconds.`));
			}, timeoutMs);
			this.#pending.set(id, { resolve: resolve as (value: unknown) => void, reject, timer });
			socket.send(JSON.stringify({ type: "call", id, op, args }));
		});
	}

	/**
	 * Opens a stream of the computer's desktop on `channel`, which the space
	 * numbers so it knows the stream's first messages; they go to the
	 * `screen` given to the constructor.
	 */
	async openScreen(channel: number, display?: string): Promise<void> {
		await this.call("screen_open", { channel, ...(display ? { display } : {}) });
	}

	/** The computer's per-thread displays, and the threads queued for one; the primary desktop isn't among them. */
	async displays(): Promise<{ displays: ComputerDisplay[]; queue: ComputerDisplay[] }> {
		return this.call("displays_list", {});
	}

	/** Takes a thread's display over for the person (`user`, which pauses its agent) or hands it back (`agent`). */
	async displayControl(thread: string, mode: "user" | "agent"): Promise<{ control: "agent" | "user" }> {
		return this.call("display_control", { thread, mode });
	}

	/** The person's input to a stream of the desktop, as the stream's own text messages. */
	screenInput(channel: number, data: string): void {
		this.#socket()?.send(JSON.stringify({ type: "screen", channel, data }));
	}

	/** The round trip between the space and the computer, in milliseconds, or null when it didn't answer. */
	async ping(): Promise<number | null> {
		const start = Date.now();
		try {
			await this.call("ping", {}, PING_MS);
		} catch {
			return null;
		}
		return Date.now() - start;
	}

	/** The text on the computer's clipboard. */
	async clipboard(display?: string): Promise<string> {
		return (await this.call("screen_clipboard", display ? { display } : {})) as string;
	}

	/**
	 * Starts watching a file on the computer, which may not exist yet: its
	 * changes come to `onFileEvent`'s listeners. Watching a file again counts,
	 * and each `unwatch` takes one away. The file as it is now comes back.
	 */
	async watch(path: string): Promise<WatchState> {
		// Watching waits for a reconnect's watches to be asked for again, so the two never count the same watch.
		return this.#serial(async () => {
			if (!this.#watching.has(path) && this.#watching.size >= MAX_WATCHED_PATHS) throw Object.assign(new Error(`At most ${MAX_WATCHED_PATHS} files can be watched at once`), { code: "EWATCHLIMIT" });
			const state = await this.call<Omit<WatchState, "path"> & { watching: true }>("watch", { path });
			this.#watching.set(path, (this.#watching.get(path) ?? 0) + 1);
			return { path, sha256: state.sha256, size: state.size, exists: state.exists };
		});
	}

	/** Takes one watch of a file away; with none left the computer stops watching it. Whether the file is still watched. */
	async unwatch(path: string): Promise<boolean> {
		const count = this.#watching.get(path);
		if (count === undefined) return false;
		if (count > 1) this.#watching.set(path, count - 1);
		else this.#watching.delete(path);
		// A watch that a reconnect hasn't asked the computer for yet is just forgotten; an offline computer has dropped its watches already.
		const issued = this.#resuming.get(path);
		if (issued !== undefined && issued < count) return count > 1;
		if (issued !== undefined) this.#resuming.set(path, issued - 1);
		if (this.#socket()) await this.call("unwatch", { path }).catch(() => undefined);
		return count > 1;
	}

	/** Runs `work` after the watch operations before it, one at a time. */
	#serial<T>(work: () => Promise<T>): Promise<T> {
		const run = this.#queue.then(work);
		this.#queue = run.then(
			() => undefined,
			() => undefined,
		);
		return run;
	}

	/** Hears of changes to the watched files, and of watchers that failed (which are no longer watched). Returns how to stop. */
	onFileEvent(listener: (event: FileEvent) => void): () => void {
		if (this.#fileListeners.size >= MAX_FILE_LISTENERS) throw new Error(`At most ${MAX_FILE_LISTENERS} listeners can hear file events`);
		this.#fileListeners.add(listener);
		return () => void this.#fileListeners.delete(listener);
	}

	/**
	 * Hears of each file watched again after the computer reconnected, with
	 * the file as it is then: changes made while it was away weren't seen.
	 */
	onWatchResumed(listener: (state: WatchState) => void): () => void {
		if (this.#resumedListeners.size >= MAX_FILE_LISTENERS) throw new Error(`At most ${MAX_FILE_LISTENERS} listeners can hear resumed watches`);
		this.#resumedListeners.add(listener);
		return () => void this.#resumedListeners.delete(listener);
	}

	/**
	 * The computer connected, with no watches: the space's are asked for again,
	 * as many times as it asked, from its live set. A watch the computer
	 * refuses is dropped, with the refs it did take given back; when the
	 * connection fails the rest is kept and asked for on the next reconnect.
	 */
	#rewatch(): Promise<void> {
		return this.#serial(async () => {
			// The space's set is the truth: whatever the computer holds from before (a watch whose reply was lost) is let go first. A computer that doesn't know the op has nothing to let go of.
			await this.call("unwatch_all", {}).catch(() => undefined);
			for (const path of this.#watching.keys()) this.#resuming.set(path, 0);
			try {
				for (const path of [...this.#resuming.keys()]) {
					// Read again each time: the space may have let it go since.
					let count = this.#watching.get(path);
					let state: Omit<WatchState, "path"> | undefined;
					try {
						while (count !== undefined && (this.#resuming.get(path) ?? 0) < count) {
							state = await this.call("watch", { path });
							this.#resuming.set(path, (this.#resuming.get(path) ?? 0) + 1);
							count = this.#watching.get(path);
						}
					} catch (error) {
						// The connection failed, not the watch: the space still wants it.
						if (error instanceof HttpError) return;
						// Not watched now: the refs taken are given back, and the listeners hear it as a watcher that failed.
						for (let each = this.#resuming.get(path) ?? 0; each > 0; each--) await this.call("unwatch", { path }).catch(() => undefined);
						this.#watching.delete(path);
						const code = (error as { code?: unknown }).code;
						for (const listener of [...this.#fileListeners]) listener({ event: "watch_error", path, code: typeof code === "string" ? code : null });
						continue;
					} finally {
						this.#resuming.delete(path);
					}
					if (state && this.#watching.has(path)) for (const listener of [...this.#resumedListeners]) listener({ path, sha256: state.sha256, size: state.size, exists: state.exists });
				}
			} finally {
				this.#resuming.clear();
			}
		});
	}

	/** Closes a stream of the desktop. */
	closeScreen(channel: number): void {
		if (this.#socket()) void this.call("screen_close", { channel }).catch(() => undefined);
	}

	/**
	 * Whether agents can use the computer's desktop: the one the computer host
	 * keeps, which runs Cua Driver, or one of the person's own that said it
	 * can when it last connected.
	 */
	desktop(): boolean {
		return this.paired() && (this.machine() !== null || this.status().computer?.desktop === true);
	}

	/** Calls one of Cua Driver's tools on the computer's desktop, and returns its MCP result. */
	driver(
		tool: string,
		args: Record<string, unknown>,
		thread?: string,
	): Promise<{ content?: unknown[]; structuredContent?: unknown; isError?: boolean }> {
		// With a thread, pim-computer uses that thread's own display rather than the computer's primary one.
		return this.call("driver", { tool, arguments: args, ...(thread ? { thread } : {}) }, DRIVER_CALL_MS);
	}

	/**
	 * Whether the computer has a browser, and whether it's running; neither
	 * while the computer is offline. With a `thread`, that thread's own
	 * browser, on its own display: asking never starts or leases anything.
	 */
	async browserStatus(thread?: string): Promise<{ available: boolean; running: boolean }> {
		if (!this.#socket()) return { available: false, running: false };
		return this.call<{ available: boolean; running: boolean }>("browser_status", thread ? { thread } : {});
	}

	/**
	 * Connects to a browser on the computer over DevTools, starting it there
	 * first when it isn't running. With a `thread`, the thread's own browser,
	 * on its own display and with the person's sign-ins copied in; without
	 * one, the computer's primary browser. Its messages go through the
	 * computer's connection; a connection made before this one for the same
	 * thread is closed.
	 */
	async connectBrowser(thread?: string): Promise<BrowserTransport> {
		const key = thread ?? "";
		const { channel, note } = await this.call<{ channel: number; note?: string }>("browser_connect", thread ? { thread } : {}, 120_000);
		this.#browserClosed(key);
		const transport: BrowserTransport = {
			...(note ? { note } : {}),
			send: (data) => {
				if (this.#browsers.get(key)?.channel !== channel) return;
				this.#socket()?.send(JSON.stringify({ type: "cdp", channel, data }));
			},
			close: () => {
				if (this.#browsers.get(key)?.channel !== channel) return;
				this.#browsers.delete(key);
				void this.call("browser_disconnect", { channel, ...(thread ? { thread } : {}) }).catch(() => undefined);
			},
		};
		this.#browsers.set(key, { channel, transport });
		return transport;
	}

	/** Quits a browser of the computer: the thread's own, which ends with its display, or the primary one. Its profile, with what's signed in there, stays. */
	async stopBrowser(thread?: string): Promise<void> {
		await this.call("browser_stop", thread ? { thread } : {});
	}

	#browserClosed(key: string): void {
		const browser = this.#browsers.get(key);
		this.#browsers.delete(key);
		browser?.transport.onclose?.();
	}

	/**
	 * Where a file or folder in `/workspace` is on the computer itself, for
	 * its programs to open: the browser uploads from it and downloads to it.
	 * It must exist, and be in `/workspace` once links are followed.
	 */
	async localPath(path: string): Promise<string> {
		await this.fs.stat(path);
		const root = this.status().computer?.root;
		if (!root) throw new Error("The computer is offline.");
		const rest = posix.relative("/workspace", posix.resolve(path));
		if (rest === "") return root;
		const sep = root.includes("\\") ? "\\" : "/";
		return `${root.replace(/[\\/]$/, "")}${sep}${rest.split("/").join(sep)}`;
	}

	/** Runs a shell command on the computer. */
	exec(command: string, options: { cwd?: string; timeoutMs?: number; thread?: string } = {}): Promise<ExecResult> {
		const timeoutMs = Math.min(options.timeoutMs ?? DEFAULT_COMMAND_MS, MAX_COMMAND_MS);
		const args: ExecArgs = { command, timeoutMs, maxBytes: COMMAND_OUTPUT_BYTES, ...(options.cwd ? { cwd: options.cwd } : {}), ...(options.thread ? { thread: options.thread } : {}) };
		return this.call<ExecResult>("exec", args, timeoutMs + 15_000);
	}

	/**
	 * The computer's `/workspace` as the file tools of `@cloudflare/computer`
	 * use a Workspace's (its `WorkspaceLike`): each call goes to the computer,
	 * and large files go in parts.
	 */
	readonly fs = {
		stat: (path: string) =>
			this.call<{ size: number; mtime: number; mode: number; sha256: string | null; isFile: boolean; isDirectory: boolean; isSymbolicLink: boolean }>("stat", { path }),
		readFile: async (path: string, options: { byteOffset?: number; byteLength?: number } = {}): Promise<ReadableStream<Uint8Array>> => {
			let offset = options.byteOffset ?? 0;
			const end = options.byteLength === undefined ? Number.POSITIVE_INFINITY : offset + options.byteLength;
			const read = async () => {
				const { data, size } = await this.call<{ data: string; size: number }>("read", { path, offset, length: Math.min(CHUNK_BYTES, end - offset) });
				const bytes = new Uint8Array(Buffer.from(data, "base64"));
				offset += bytes.byteLength;
				return { bytes, done: bytes.byteLength === 0 || offset >= Math.min(size, end) };
			};
			// The first part is read now, so a missing file fails here and not in the stream.
			const first = await read();
			let done = first.done;
			return new ReadableStream<Uint8Array>({
				start(controller) {
					if (first.bytes.byteLength > 0) controller.enqueue(first.bytes);
					if (done) controller.close();
				},
				async pull(controller) {
					const next = await read();
					done = next.done;
					if (next.bytes.byteLength > 0) controller.enqueue(next.bytes);
					if (done) controller.close();
				},
			});
		},
		/**
		 * Replaces a file, whole or not at all. With `expectedHash`, only if the
		 * file's sha256 is that, or with "absent", only if there is no file; a
		 * file that isn't as expected throws a `FileConflictError`.
		 */
		writeFile: async (path: string, content: Uint8Array | string, options: { mode?: number; expectedHash?: string } = {}): Promise<WriteResult> => {
			const bytes = typeof content === "string" ? new TextEncoder().encode(content) : content;
			const mode = options.mode === undefined ? {} : { mode: options.mode };
			const condition = options.expectedHash === undefined ? {} : { expectedHash: options.expectedHash };
			if (bytes.byteLength <= CHUNK_BYTES) {
				return this.call<WriteResult>("write", { path, data: Buffer.from(bytes).toString("base64"), ...mode, ...condition });
			}
			// In parts, to a file beside it that takes its place once whole.
			const slash = path.lastIndexOf("/");
			const temporary = `${path.slice(0, slash)}/.${path.slice(slash + 1)}.pim-${crypto.randomUUID()}`;
			try {
				for (let start = 0; start < bytes.byteLength; start += CHUNK_BYTES) {
					const data = Buffer.from(bytes.subarray(start, start + CHUNK_BYTES)).toString("base64");
					await this.call("write", { path: temporary, data, append: start > 0, ...mode });
				}
				return await this.call<WriteResult>("write", { path, from: temporary, ...mode, ...condition });
			} catch (error) {
				await this.call("rm", { path: temporary, force: true }).catch(() => undefined);
				throw error;
			}
		},
		mkdir: async (path: string, options: { recursive?: boolean } = {}): Promise<void> => {
			await this.call("mkdir", { path, recursive: options.recursive === true });
		},
		rm: async (path: string, options: { recursive?: boolean; force?: boolean } = {}): Promise<void> => {
			await this.call("rm", { path, recursive: options.recursive === true, force: options.force === true });
		},
		readdir: (path: string, options: { limit?: number; offset?: number } = {}) =>
			this.call<{ name: string; size: number; mtime: number; isFile: boolean; isDirectory: boolean; isSymbolicLink: boolean }[]>("readdir", { path, ...options }),
		find: (directory: string, pattern?: string, options: { limit?: number; offset?: number; exclude?: string[] } = {}) =>
			this.call<{ path: string; type: "file" | "dir" }[]>("find", { path: directory, pattern, ...options }),
		grep: (
			query: string,
			path: string,
			options: { regex?: boolean; ignoreCase?: boolean; context?: number; limit?: number; offset?: number; include?: string; exclude?: string[] } = {},
		) =>
			this.call<{ path: string; line: number; text: string; context?: { line: number; text: string; isMatch: boolean }[] }[]>("grep", {
				query,
				path,
				...options,
			}),
	};
}
