import { Buffer } from "node:buffer";
import type { Connection } from "agents";
import type { ExecArgs, ExecResult } from "../computer/pim-computer";
import { digestHex } from "./auth/store";
import { HttpError } from "./http";
import type { SpriteLink } from "./sprites";

/**
 * The person's computer: a machine of theirs (a server, a VM, a box at home)
 * running `pim-computer` (../computer/pim-computer.ts), which their agents use
 * to run commands, keep files and browse (its Chrome, driven over DevTools
 * through the same connection: `connectBrowser`). Settings → Computer pairs one with the space
 * by making a token, `pimc_<owner>_<secret>`; the program connects out with it
 * to `/api/computer/connect` over a WebSocket, which the Worker hands to this
 * space as `COMPUTER_PATH`, and answers the space's calls on it. The space
 * keeps only the token's digest, and what the computer last said about itself.
 *
 * A space has at most one computer. It is paired from when the token is made
 * until the person forgets it, and online while it is connected: the tools
 * that use it are offered while it is paired, so a computer that drops off
 * for a moment doesn't change what agents can do, and they hear it's offline
 * when they try.
 *
 * A computer Pim started (./sprites.ts) has no token: the space starts
 * pim-computer there when it's needed, which wakes it, and lets go of it
 * once it has gone unused for `IDLE_MS`, so it sleeps.
 */

/** Where the space takes the computer's connection, behind the Worker's `/api/computer/connect`. */
export const COMPUTER_PATH = "/computer/connect";
/** The header the Worker passes the computer's token in. */
export const COMPUTER_TOKEN_HEADER = "x-pim-computer-token";
/** The tag of the computer's connection among the space's sockets. */
export const COMPUTER_TAG = "computer";
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

/** How long a computer Pim started may take to wake and start pim-computer. */
const WAKE_MS = 90_000;
/** How long a computer Pim started goes unused before the space lets go of it, and it sleeps. */
export const IDLE_MS = 5 * 60_000;

const TOKEN_KEY = "computer_token";
const MACHINE_KEY = "computer_machine";
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
	readonly connectedAt: number;
};

export type ComputerState = "none" | "offline" | "online";

export type ComputerStatus = {
	readonly state: ComputerState;
	/** Set while another kind of computer stands in for this one: the Cua evaluation (./cua.ts). */
	readonly provider?: "cua";
	/** Whether Pim started it (./sprites.ts): it sleeps when unused, and wakes when it's needed. */
	readonly managed: boolean;
	readonly pairedAt: number | null;
	readonly computer: ComputerInfo | null;
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

/**
 * Another way to reach a computer, which stands in for pim-computer's
 * connection while it's active: the Cua evaluation (./cua.ts). It takes
 * the file and command calls; it has no DevTools browser.
 */
export type ComputerProvider = {
	active(): boolean;
	status(): ComputerStatus;
	call<T>(op: string, args: Record<string, unknown>, timeoutMs: number): Promise<T>;
	/** Runs several calls as one piece of work, which a pause waits for. */
	hold<T>(work: () => Promise<T>): Promise<T>;
	/** The most bytes one write sends. */
	readonly chunkBytes: number;
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
	/** Starts pim-computer on the computer Pim started, which wakes it, when a call finds it asleep. */
	readonly #wake: () => Promise<SpriteLink>;
	/** Whether the space is using the computer in a way it doesn't see itself, such as someone watching its browser. */
	readonly #inUse: () => boolean;
	/** pim-computer on the computer Pim started, while the space holds on to it. */
	#link: SpriteLink | null = null;
	#waking: Promise<void> | undefined;
	/** What waits for pim-computer on the computer Pim started to say what it is, or to stop before it has. */
	#arrivals: ((hello: boolean) => void)[] = [];
	#usedAt = 0;
	#idle: ReturnType<typeof setTimeout> | undefined;
	readonly #provider: ComputerProvider | undefined;

	constructor(options: { meta: Meta; sockets: () => Connection[]; wake: () => Promise<SpriteLink>; inUse: () => boolean; provider?: ComputerProvider }) {
		this.#meta = options.meta;
		this.#sockets = options.sockets;
		this.#wake = options.wake;
		this.#inUse = options.inUse;
		this.#provider = options.provider;
	}

	/** The computer standing in for this one now, if any. */
	#standIn(): ComputerProvider | undefined {
		return this.#provider?.active() ? this.#provider : undefined;
	}

	/** The machine of the computer Pim started, or null for one the person brought. */
	machine(): string | null {
		return this.#meta.meta(MACHINE_KEY) ?? null;
	}

	/** The computer is now the machine Pim started, `name`, in place of any other. */
	started(name: string, now: number): void {
		this.forget();
		this.#meta.setMeta(MACHINE_KEY, name);
		this.#meta.setMeta(PAIRED_AT_KEY, String(now));
	}

	/** Whether it's doing something for the space now: answering a call, or with its browser connected. */
	busy(): boolean {
		return this.#pending.size > 0 || this.#browser !== null;
	}

	#use(): void {
		this.#usedAt = Date.now();
	}

	/**
	 * Lets go of the computer Pim started once it has gone unused for
	 * `IDLE_MS` (by `now`), so it sleeps; one in use is looked at again later.
	 */
	letGoIfIdle(now = Date.now()): void {
		clearTimeout(this.#idle);
		const link = this.#link;
		if (!link || link.readyState !== WebSocket.OPEN) return;
		const idle = now - this.#usedAt;
		if (idle < IDLE_MS || this.busy() || this.#inUse()) {
			this.#idle = setTimeout(() => this.letGoIfIdle(), Math.max(IDLE_MS - idle, 60_000));
			return;
		}
		this.#link = null;
		link.close();
		this.#failPending();
	}

	/** Whether a computer is paired, online or not: one the person brought, with its token, or one Pim started; or one stands in. */
	paired(): boolean {
		return this.#standIn() !== undefined || this.#meta.meta(TOKEN_KEY) !== undefined || this.machine() !== null;
	}

	#socket(): Pick<Connection, "send"> | undefined {
		if (this.#link?.readyState === WebSocket.OPEN) return this.#link;
		return this.#sockets().find((socket) => socket.readyState === WebSocket.OPEN);
	}

	status(): ComputerStatus {
		const standIn = this.#standIn();
		if (standIn) return standIn.status();
		if (!this.paired()) return { state: "none", managed: false, pairedAt: null, computer: null };
		const info = this.#meta.meta(INFO_KEY);
		return {
			state: this.#socket() ? "online" : "offline",
			managed: this.machine() !== null,
			pairedAt: Number(this.#meta.meta(PAIRED_AT_KEY)),
			computer: info ? (JSON.parse(info) as ComputerInfo) : null,
		};
	}

	/** Pairs a new computer, in place of any other: the token is returned only here, and only its digest is kept. */
	async pair(owner: string, now: number): Promise<string> {
		const secret = Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString("base64url");
		const token = `pimc_${owner}_${secret}`;
		this.#meta.setMeta(TOKEN_KEY, await digestHex(token));
		this.#meta.setMeta(PAIRED_AT_KEY, String(now));
		this.#meta.deleteMeta(INFO_KEY);
		this.disconnect("A new computer was paired");
		return token;
	}

	/** Forgets the computer: its token stops working, and it is disconnected. Its files stay on it. */
	forget(): void {
		this.#meta.deleteMeta(TOKEN_KEY);
		this.#meta.deleteMeta(PAIRED_AT_KEY);
		this.#meta.deleteMeta(INFO_KEY);
		this.#meta.deleteMeta(MACHINE_KEY);
		this.disconnect("The computer was removed");
	}

	disconnect(reason: string): void {
		for (const socket of this.#sockets()) socket.close(REPLACED, reason);
		this.#link?.close();
		this.#link = null;
		clearTimeout(this.#idle);
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
		for (const arrival of this.#arrivals.splice(0)) arrival(false);
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

	/** A message from the computer: what it is, or an answer to a call. */
	receive(raw: string): void {
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
				connectedAt: Date.now(),
			};
			this.#meta.setMeta(INFO_KEY, JSON.stringify(info));
			for (const arrived of this.#arrivals.splice(0)) arrived(true);
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

	/** Calls the computer and waits for its answer; one Pim started wakes first, if it's asleep. */
	async call<T = unknown>(op: string, args: Record<string, unknown>, timeoutMs = FILE_CALL_MS, counts = true): Promise<T> {
		const standIn = this.#standIn();
		if (standIn) return standIn.call<T>(op, args, timeoutMs);
		if (!this.paired()) throw new HttpError(404, "No computer is connected. The person can connect one in Settings → Computer.");
		await this.wake();
		const socket = this.#socket();
		if (!socket) throw new HttpError(503, "The computer is offline: pim-computer isn't connected. Ask the person to start it again.");
		if (counts) this.#use();
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
	 * Wakes the computer Pim started, if it's asleep, by starting
	 * pim-computer there, and waits until it says what it is; once for every
	 * call that finds it asleep.
	 */
	wake(): Promise<void> {
		if (this.#standIn() || this.#socket() || !this.machine()) return Promise.resolve();
		this.#waking ??= (async () => {
			const arrived = new Promise<boolean>((resolve) => {
				const timer = setTimeout(() => resolve(false), WAKE_MS);
				this.#arrivals.push((hello) => {
					clearTimeout(timer);
					resolve(hello);
				});
			});
			try {
				this.#link = await this.#wake();
			} catch (error) {
				for (const arrival of this.#arrivals.splice(0)) arrival(false);
				throw error;
			}
			if (!(await arrived)) {
				this.#link?.close();
				this.#link = null;
				throw new HttpError(504, "The computer didn't wake up. Try again in a minute.");
			}
			this.#use();
			this.letGoIfIdle();
		})().finally(() => {
			this.#waking = undefined;
		});
		return this.#waking;
	}

	/** Whether the computer has a browser, and whether it's running; neither while the computer is offline or asleep. */
	async browserStatus(): Promise<{ available: boolean; running: boolean }> {
		if (!this.#socket()) return { available: false, running: false };
		// Asking doesn't count as using it, so an app watching the browser lets a computer sleep.
		return this.call<{ available: boolean; running: boolean }>("browser_status", {}, FILE_CALL_MS, false);
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
				this.#use();
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
			const standIn = this.#standIn();
			const chunk = standIn?.chunkBytes ?? CHUNK_BYTES;
			if (bytes.byteLength <= chunk) {
				await this.call("write", { path, data: Buffer.from(bytes).toString("base64"), ...mode });
				return;
			}
			// In parts, to a file beside it that takes its place once whole: one piece of work, which a pause waits for.
			const slash = path.lastIndexOf("/");
			const temporary = `${path.slice(0, slash)}/.${path.slice(slash + 1)}.pim-${crypto.randomUUID()}`;
			const write = async () => {
				try {
					for (let start = 0; start < bytes.byteLength; start += chunk) {
						const data = Buffer.from(bytes.subarray(start, start + chunk)).toString("base64");
						await this.call("write", { path: temporary, data, append: start > 0, ...mode });
					}
					await this.call("rename", { from: temporary, to: path });
				} catch (error) {
					await this.call("rm", { path: temporary, force: true }).catch(() => undefined);
					throw error;
				}
			};
			await (standIn ? standIn.hold(write) : write());
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
