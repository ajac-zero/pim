import { Buffer } from "node:buffer";
import type { Connection } from "agents";
import type { ExecArgs, ExecResult } from "../computer/pim-computer";
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
 * computer host keeps for the space (`provide`): an Omarchy VM on the
 * operator's machine, made with Cua (../computer/pim-host.ts), which the
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
};

type Pending = { resolve(value: unknown): void; reject(error: Error): void; timer: ReturnType<typeof setTimeout> };

/** A failure the computer reported, with its code (`ENOENT`…), which the file tools read. */
function remoteError(error: { message?: unknown; code?: unknown }): Error {
	return Object.assign(new Error(String(error.message ?? "The computer failed")), typeof error.code === "string" ? { code: error.code } : {});
}

export class Computer {
	readonly #meta: Meta;
	readonly #sockets: () => Connection[];
	readonly #pending = new Map<string, Pending>();
	/** The DevTools connection to the computer's browser, of which there is one at a time. */
	#browser: { channel: number; transport: BrowserTransport } | null = null;
	/** Where the desktop's streams go: what a channel's stream says, as text or binary, or null once it's closed. */
	readonly #screen: (channel: number, data: string | ArrayBuffer | null) => void;

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

	async checkToken(token: string | null): Promise<boolean> {
		const known = this.#meta.meta(TOKEN_KEY);
		return token !== null && known !== undefined && (await digestHex(token)) === known;
	}

	/** A computer connected: it takes the place of any other connection. */
	connected(connection: Connection): void {
		for (const socket of this.#sockets()) {
			if (socket.id !== connection.id) socket.close(REPLACED, "Another computer connected with this token");
		}
	}

	/** The connection closed: calls waiting on it fail now rather than at their timeouts. */
	disconnected(): void {
		if (this.#socket()) return;
		this.#failPending();
	}

	#failPending(): void {
		this.#browserClosed();
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
				connectedAt: Date.now(),
			};
			this.#meta.setMeta(INFO_KEY, JSON.stringify(info));
			this.#meta.deleteMeta(SETUP_ERROR_KEY);
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
			const browser = this.#browser;
			if (!browser || browser.channel !== (message as { channel?: unknown }).channel) return;
			if (message.type === "cdp_closed") this.#browserClosed();
			else browser.transport.onmessage?.(String((message as { data?: unknown }).data));
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
	async openScreen(channel: number): Promise<void> {
		await this.call("screen_open", { channel });
	}

	/** The person's input to a stream of the desktop, as the stream's own text messages. */
	screenInput(channel: number, data: string): void {
		this.#socket()?.send(JSON.stringify({ type: "screen", channel, data }));
	}

	/** Closes a stream of the desktop. */
	closeScreen(channel: number): void {
		if (this.#socket()) void this.call("screen_close", { channel }).catch(() => undefined);
	}

	/** Whether the computer has a browser, and whether it's running; neither while the computer is offline. */
	async browserStatus(): Promise<{ available: boolean; running: boolean }> {
		if (!this.#socket()) return { available: false, running: false };
		return this.call<{ available: boolean; running: boolean }>("browser_status", {});
	}

	/**
	 * Connects to the computer's browser over DevTools, starting it there
	 * first when it isn't running. Its messages go through the computer's
	 * connection; a connection made before this one is closed.
	 */
	async connectBrowser(): Promise<BrowserTransport> {
		const { channel } = await this.call<{ channel: number }>("browser_connect", {}, 60_000);
		this.#browserClosed();
		const transport: BrowserTransport = {
			send: (data) => {
				if (this.#browser?.channel !== channel) return;
				this.#socket()?.send(JSON.stringify({ type: "cdp", channel, data }));
			},
			close: () => {
				if (this.#browser?.channel !== channel) return;
				this.#browser = null;
				void this.call("browser_disconnect", { channel }).catch(() => undefined);
			},
		};
		this.#browser = { channel, transport };
		return transport;
	}

	/** Quits the computer's browser; its profile, with what's signed in there, stays. */
	async stopBrowser(): Promise<void> {
		await this.call("browser_stop", {});
	}

	#browserClosed(): void {
		const browser = this.#browser;
		this.#browser = null;
		browser?.transport.onclose?.();
	}

	/** Runs a shell command on the computer. */
	exec(command: string, options: { cwd?: string; timeoutMs?: number } = {}): Promise<ExecResult> {
		const timeoutMs = Math.min(options.timeoutMs ?? DEFAULT_COMMAND_MS, MAX_COMMAND_MS);
		const args: ExecArgs = { command, timeoutMs, maxBytes: COMMAND_OUTPUT_BYTES, ...(options.cwd ? { cwd: options.cwd } : {}) };
		return this.call<ExecResult>("exec", args, timeoutMs + 15_000);
	}

	/**
	 * The computer's `/workspace` as the file tools of `@cloudflare/computer`
	 * use a Workspace's (its `WorkspaceLike`): each call goes to the computer,
	 * and large files go in parts.
	 */
	readonly fs = {
		stat: (path: string) =>
			this.call<{ size: number; mtime: number; mode: number; isFile: boolean; isDirectory: boolean; isSymbolicLink: boolean }>("stat", { path }),
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
		writeFile: async (path: string, content: Uint8Array | string, options: { mode?: number } = {}): Promise<void> => {
			const bytes = typeof content === "string" ? new TextEncoder().encode(content) : content;
			const mode = options.mode === undefined ? {} : { mode: options.mode };
			if (bytes.byteLength <= CHUNK_BYTES) {
				await this.call("write", { path, data: Buffer.from(bytes).toString("base64"), ...mode });
				return;
			}
			// In parts, to a file beside it that takes its place once whole.
			const slash = path.lastIndexOf("/");
			const temporary = `${path.slice(0, slash)}/.${path.slice(slash + 1)}.pim-${crypto.randomUUID()}`;
			try {
				for (let start = 0; start < bytes.byteLength; start += CHUNK_BYTES) {
					const data = Buffer.from(bytes.subarray(start, start + CHUNK_BYTES)).toString("base64");
					await this.call("write", { path: temporary, data, append: start > 0, ...mode });
				}
				await this.call("rename", { from: temporary, to: path });
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
