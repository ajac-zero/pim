import { createHmac } from "node:crypto";
import { ApprovalRequiredError, CapabilityUnavailableError } from "@pim/v2-contracts/authz";
import type { Principal } from "@pim/v2-contracts/identity";
import { Authorizer } from "./authz.ts";
import type { Db } from "./db.ts";
import { NotFoundError, PimError } from "./errors.ts";
import { Identity } from "./identity.ts";
import { computerAppId, runBackend } from "./hosted-run.ts";
import { newId, secret } from "./ids.ts";

/** What the Relay needs of a computer's socket: `ws`'s WebSocket satisfies it, and so does a fake. */
export interface ComputerSocket {
	send(data: string | Uint8Array): void;
	close(code?: number, reason?: string): void;
}

/** The close code an old connection gets when another one replaces it (pim-computer's `REPLACED`). */
export const REPLACED = 4409;
/** The close code that asks a computer running an older protocol to update itself (pim-computer's `OUTDATED`). */
export const OUTDATED = 4410;
/** The protocol revision of the Relay's calls (pim-computer's `PROTOCOL_VERSION`); a computer that says less is older. */
export const PROTOCOL_VERSION = 2;
const FILE_CALL_MS = 30_000;
/** How every message of the triggers runtime on a computer begins, both ways (computer/triggers-host.ts): the Relay hands them to the space's side of it, not to its own reading of the connection. */
export const TRIGGERS_ENVELOPE = '{"type":"triggers","frame":';
/** The space's side of the triggers runtime a computer carries (the Gate gives the Relay one): started on each connection a computer makes. */
export interface ComputerTriggersHost {
	open(connection: { readonly ownerId: string; readonly computerId: string; sendRaw(text: string): void }, token: string): { receive(raw: string): void; close(): void };
}
const OUTDATED_RETRY_MS = 10 * 60_000;
const MAX_WATCHED_PATHS = 200;

/** A failure of a call on a computer: 503 when it is gone or hung up, 504 when it did not answer, else what it said. */
export class ComputerError extends PimError {
	constructor(status: number, message: string, readonly remote?: { code?: string; [key: string]: unknown }) {
		super(status, status === 503 ? "computer_offline" : status === 504 ? "computer_timeout" : "computer_error", message);
	}
}

export type ComputerInfo = { agent: string; hostname: string; platform: string; arch: string; user: string; root: string; browser: string | null; screen: boolean; desktop: boolean; protocol: number; connectedAt: number };
export type FileEvent = { event: "file_changed"; path: string; [key: string]: unknown } | { event: "watch_error"; path: string; code: string | null };

/** What a caller needs of a paired computer, wherever its socket is held: in this process (`ComputerConnection`) or in another one, over the bus (`RemoteComputer`). */
export interface Computer {
	readonly info: ComputerInfo | null;
	readonly protocol: number;
	call<T = unknown>(op: string, args?: Record<string, unknown>, timeoutMs?: number): Promise<T>;
	watch(path: string): Promise<unknown>;
	unwatch(path: string): Promise<boolean>;
	onFileEvent(listener: (event: FileEvent) => void): () => void;
	openScreen(channel: number, handler: (data: string | Uint8Array | null) => void, display?: string): Promise<void>;
	screenInput(channel: number, data: string): void;
	closeScreen(channel: number): void;
	openBrowser(handler: (data: string | null) => void, thread?: string): Promise<{ send(data: string): void; close(): void }>;
	openAppSocket(appId: string, path: string, headers: Record<string, string>, handler: (data: Uint8Array | string | null) => void): Promise<{ send(data: Uint8Array | string): void; close(): void }>;
	ping(): Promise<number | null>;
}

/**
 * The calls one process makes of another that holds a computer's socket. `pim.v2.relay.<owner>.rpc` is request/reply; `pim.v2.relay.<owner>.stream`
 * carries the frames of open streams and the notices of the owner's relay. Only a process that holds the owner's live socket answers, so no answer is
 * "no computer is connected".
 */
export type RelayRequest =
	| { op: "info" }
	| { op: "call"; name: string; args: Record<string, unknown>; timeoutMs?: number }
	| { op: "watch" | "unwatch"; path: string }
	| { op: "screen_open"; id: string; channel: number; display?: string }
	| { op: "browser_open"; id: string; thread?: string }
	| { op: "appws_open"; id: string; appId: string; path: string; headers: Record<string, string> };
export type RelayReply = { ok: true; result?: unknown } | { ok: false; unavailable?: boolean; status?: number; message: string; remote?: { code?: string; [key: string]: unknown } };
export type RelayStreamMessage =
	/** A replica accepted the owner's computer: any older connection held elsewhere is closed (REPLACED). */
	| { k: "connected"; holder: string; at: number }
	| { k: "file_event"; event: FileEvent }
	/** A frame of stream `id`: `down` from the computer to the viewer, `up` the other way. Binary frames are base64. */
	| { k: "data"; id: string; dir: "up" | "down"; binary: boolean; data: string }
	| { k: "end"; id: string; dir: "up" | "down" };

/** The bus between processes. `@pim/v2-server`'s `relay-bus.ts` is the NATS implementation; this package knows nothing of NATS. */
export interface RelayBus {
	/** Answers the owner's rpc and hears its stream, for as long as the caller holds the owner's live computer socket. */
	serve(ownerId: string, handlers: { rpc(request: RelayRequest): Promise<RelayReply>; stream(message: RelayStreamMessage): void }): () => void;
	/** Asks whichever process serves the owner. Rejects with `RelayNobody` when none does. */
	request(ownerId: string, request: RelayRequest, timeoutMs: number): Promise<RelayReply>;
	publish(ownerId: string, message: RelayStreamMessage): void;
	subscribe(ownerId: string, handler: (message: RelayStreamMessage) => void): () => void;
}

/** No process holds a live computer socket for the owner. */
export class RelayNobody extends Error {
	constructor() {
		super("No process holds the computer's connection");
	}
}

/**
 * One connected `pim-computer`. It speaks the `pim-computer` wire protocol: JSON text frames `hello` (what it is, and which protocol revision),
 * `call`/`reply` (the Relay's calls and its answers), `event` (file changes and watcher failures), `screen` and `cdp` streams on numbered
 * channels, and binary frames whose first four bytes are a screen channel. Protocol 1 (a computer that does not say its version) and 2 both connect.
 */
export class ComputerConnection implements Computer {
	info: ComputerInfo | null = null;
	readonly connectedAt = Date.now();
	readonly #pending = new Map<string, { resolve: (v: unknown) => void; reject: (e: Error) => void; timer: NodeJS.Timeout }>();
	readonly #screens = new Map<number, (data: string | Uint8Array | null) => void>();
	readonly #cdp = new Map<number, (data: string | null) => void>();
	readonly #appSockets = new Map<number, (data: Uint8Array | string | null) => void>();
	#serial: Promise<unknown> = Promise.resolve();
	#closed = false;
	/** The space's side of the triggers runtime on this computer (`ComputerTriggers`), once the Relay is given one. */
	triggers: { receive(raw: string): void; close(): void } | null = null;

	constructor(
		readonly ownerId: string,
		readonly computerId: string,
		readonly consumerId: string,
		private readonly socket: ComputerSocket,
		/** What outlives a connection: the files the space watches (with counts) and who hears of changes. The Relay keeps one per owner, so a reconnect asks for them again. */
		private readonly state: { watching: Map<string, number>; listeners: Set<(event: FileEvent) => void> },
		private readonly onHello: (connection: ComputerConnection) => void = () => undefined,
	) {}

	get #watching() {
		return this.state.watching;
	}

	get #fileListeners() {
		return this.state.listeners;
	}

	get protocol(): number {
		return this.info?.protocol ?? PROTOCOL_VERSION;
	}

	get idle(): boolean {
		return this.#pending.size === 0 && this.#screens.size === 0 && this.#cdp.size === 0 && this.#appSockets.size === 0;
	}

	/** A frame from the computer. */
	receive(raw: string | Uint8Array): void {
		if (typeof raw !== "string") {
			// The desktop's video: its channel in the first four bytes.
			if (raw.byteLength > 4) this.#screens.get(new DataView(raw.buffer, raw.byteOffset, raw.byteLength).getUint32(0))?.(raw.slice(4));
			return;
		}
		// Triggers frames come first, before anything else reads the message: their `hello` is not the computer's own.
		if (raw.startsWith(TRIGGERS_ENVELOPE)) return this.triggers?.receive(raw);
		let m: { type?: unknown; id?: unknown; result?: unknown; error?: { message?: unknown; code?: unknown }; channel?: unknown; data?: unknown; event?: unknown; path?: unknown };
		try {
			m = JSON.parse(raw);
		} catch {
			return;
		}
		if (m.type === "hello") {
			const h = m as Record<string, unknown>;
			this.info = {
				agent: String(h.agent ?? ""), hostname: String(h.hostname ?? ""), platform: String(h.platform ?? ""), arch: String(h.arch ?? ""), user: String(h.user ?? ""), root: String(h.root ?? ""),
				browser: typeof h.browser === "string" ? h.browser : null, screen: h.screen === true, desktop: h.desktop === true,
				protocol: typeof h.version === "number" && Number.isInteger(h.version) && h.version > 0 ? h.version : 1, connectedAt: Date.now(),
			};
			this.onHello(this);
			// The Relay's watches are asked for again; a computer that asks to update reconnects and says hello again.
			void this.#rewatch();
		} else if (m.type === "event") {
			if ((m.event !== "file_changed" && m.event !== "watch_error") || typeof m.path !== "string") return; // a newer computer's event
			if (m.event === "watch_error") this.#watching.delete(m.path);
			const { type: _t, ...event } = m as Record<string, unknown>;
			for (const l of [...this.#fileListeners]) l(event as FileEvent);
		} else if (m.type === "screen" || m.type === "screen_closed") {
			if (typeof m.channel !== "number") return;
			const handler = this.#screens.get(m.channel);
			if (m.type === "screen_closed") {
				this.#screens.delete(m.channel);
				handler?.(null);
			} else if (typeof m.data === "string") handler?.(m.data);
		} else if (m.type === "cdp" || m.type === "cdp_closed") {
			if (typeof m.channel !== "number") return;
			const handler = this.#cdp.get(m.channel);
			if (m.type === "cdp_closed") {
				this.#cdp.delete(m.channel);
				handler?.(null);
			} else handler?.(String(m.data));
		} else if (m.type === "app_ws" || m.type === "app_ws_closed") {
			if (typeof m.channel !== "number") return;
			const handler = this.#appSockets.get(m.channel);
			if (m.type === "app_ws_closed") {
				this.#appSockets.delete(m.channel);
				handler?.(null);
			} else if (typeof m.data === "string") handler?.((m as { binary?: unknown }).binary === true ? new Uint8Array(Buffer.from(m.data, "base64")) : m.data);
		} else if (m.type === "reply" && typeof m.id === "string") {
			const p = this.#pending.get(m.id);
			if (!p) return;
			this.#pending.delete(m.id);
			clearTimeout(p.timer);
			if (m.error) p.reject(new ComputerError(502, String(m.error.message ?? "The computer failed"), { ...(typeof m.error.code === "string" ? { code: m.error.code } : {}), ...(m.error as object) }));
			else p.resolve(m.result ?? null);
		}
	}

	/** Sends a message as it is, for protocols that carry their own framing over this connection. */
	sendRaw(text: string): void {
		this.socket.send(text);
	}

	/** The socket closed: calls waiting on it fail now rather than at their timeouts. */
	closed(): void {
		this.#closed = true;
		this.triggers?.close();
		for (const [id, p] of this.#pending) {
			clearTimeout(p.timer);
			p.reject(new ComputerError(503, "The computer disconnected before it answered."));
			this.#pending.delete(id);
		}
		for (const [c, h] of this.#screens) h(null), this.#screens.delete(c);
		for (const [c, h] of this.#cdp) h(null), this.#cdp.delete(c);
		for (const [c, h] of this.#appSockets) h(null), this.#appSockets.delete(c);
	}

	close(code?: number, reason?: string): void {
		this.socket.close(code, reason);
	}

	/** Calls the computer and waits for its answer. */
	call<T = unknown>(op: string, args: Record<string, unknown> = {}, timeoutMs = FILE_CALL_MS): Promise<T> {
		if (this.#closed) return Promise.reject(new ComputerError(503, "The computer is offline."));
		const id = newId("call");
		return new Promise<T>((resolve, reject) => {
			const timer = setTimeout(() => {
				this.#pending.delete(id);
				reject(new ComputerError(504, `The computer didn't answer within ${Math.round(timeoutMs / 1000)} seconds.`));
			}, timeoutMs);
			this.#pending.set(id, { resolve: resolve as (v: unknown) => void, reject, timer });
			this.socket.send(JSON.stringify({ type: "call", id, op, args }));
		});
	}

	// ---- file watches (counted, so each `unwatch` takes one away; asked for again when the computer reconnects) ----

	#run<T>(work: () => Promise<T>): Promise<T> {
		const next = this.#serial.then(work, work);
		this.#serial = next.catch(() => undefined);
		return next;
	}

	watch(path: string): Promise<unknown> {
		return this.#run(async () => {
			if (!this.#watching.has(path) && this.#watching.size >= MAX_WATCHED_PATHS) throw new ComputerError(429, `At most ${MAX_WATCHED_PATHS} files can be watched at once`);
			const state = await this.call("watch", { path });
			this.#watching.set(path, (this.#watching.get(path) ?? 0) + 1);
			return state;
		});
	}

	unwatch(path: string): Promise<boolean> {
		return this.#run(async () => {
			const n = this.#watching.get(path);
			if (n === undefined) return false;
			if (n > 1) this.#watching.set(path, n - 1);
			else this.#watching.delete(path);
			await this.call("unwatch", { path }).catch(() => undefined);
			return this.#watching.has(path);
		});
	}

	onFileEvent(listener: (event: FileEvent) => void): () => void {
		this.#fileListeners.add(listener);
		return () => this.#fileListeners.delete(listener);
	}

	/** The computer connected with none of its watches: the Relay's are the truth, so whatever it holds is let go first, then each is asked for as often as it was counted. */
	#rewatch(): Promise<void> {
		return this.#run(async () => {
			await this.call("unwatch_all", {}).catch(() => undefined); // a computer that doesn't know the op has nothing to let go of
			for (const [path, count] of [...this.#watching]) {
				try {
					for (let i = 0; i < count; i++) await this.call("watch", { path });
				} catch (error) {
					if (error instanceof ComputerError && error.status >= 503) return; // the connection failed; the rest is asked for on the next reconnect
					this.#watching.delete(path);
					for (const l of [...this.#fileListeners]) l({ event: "watch_error", path, code: (error as ComputerError).remote?.code ?? null });
				}
			}
		});
	}

	/** Watched paths with their counts: what a reconnect asks for again. */
	get watched(): ReadonlyMap<string, number> {
		return this.#watching;
	}

	// ---- streams ----

	/** Opens a stream of the desktop on `channel`; frames go to `handler` until it is closed (null). */
	async openScreen(channel: number, handler: (data: string | Uint8Array | null) => void, display?: string): Promise<void> {
		await this.call("screen_open", { channel, ...(display ? { display } : {}) });
		this.#screens.set(channel, handler);
	}

	screenInput(channel: number, data: string): void {
		if (!this.#closed) this.socket.send(JSON.stringify({ type: "screen", channel, data }));
	}

	closeScreen(channel: number): void {
		this.#screens.delete(channel);
		if (!this.#closed) void this.call("screen_close", { channel }).catch(() => undefined);
	}

	/** A DevTools connection to the computer's browser: its messages go to `handler`, and `send` writes to it. */
	async openBrowser(handler: (data: string | null) => void, thread?: string): Promise<{ send(data: string): void; close(): void }> {
		const { channel } = await this.call<{ channel: number }>("browser_connect", thread ? { thread } : {}, 120_000);
		this.#cdp.set(channel, handler);
		return {
			send: (data) => {
				if (this.#cdp.has(channel) && !this.#closed) this.socket.send(JSON.stringify({ type: "cdp", channel, data }));
			},
			close: () => {
				if (!this.#cdp.delete(channel)) return;
				void this.call("browser_disconnect", { channel, ...(thread ? { thread } : {}) }).catch(() => undefined);
			},
		};
	}

	/** A WebSocket to an app's backend on the computer's loopback: frames go both ways on one channel. A computer that does not know the op answers an error, and the viewer is closed. */
	async openAppSocket(appId: string, path: string, headers: Record<string, string>, handler: (data: Uint8Array | string | null) => void): Promise<{ send(data: Uint8Array | string): void; close(): void }> {
		const { channel } = await this.call<{ channel: number }>("app_ws_open", { id: appId, path, headers });
		this.#appSockets.set(channel, handler);
		return {
			send: (data) => {
				if (this.#appSockets.has(channel) && !this.#closed) this.socket.send(JSON.stringify({ type: "app_ws", channel, data: typeof data === "string" ? data : Buffer.from(data).toString("base64"), binary: typeof data !== "string" }));
			},
			close: () => {
				if (!this.#appSockets.delete(channel)) return;
				void this.call("app_ws_close", { channel }).catch(() => undefined);
			},
		};
	}

	async ping(): Promise<number | null> {
		const start = Date.now();
		try {
			await this.call("ping", {}, 5_000);
			return Date.now() - start;
		} catch {
			return null;
		}
	}
}

const b64 = (data: Uint8Array) => Buffer.from(data).toString("base64");

/** A reply that says no: its failure, as the caller of a local connection would have seen it. */
function failure(reply: Extract<RelayReply, { ok: false }>, capability: string): Error {
	return reply.unavailable ? new CapabilityUnavailableError(capability, "it needs a paired personal computer, and none is connected") : new ComputerError(reply.status ?? 502, reply.message, reply.remote);
}

/**
 * A computer whose socket another process holds: every call is a request on the bus, and every stream is frames on it. It looks like a local
 * connection to its caller. What the owning process cannot do for it (the socket went away between the check and the call) comes back as
 * `CapabilityUnavailableError`, the same as no computer at all.
 */
export class RemoteComputer implements Computer {
	readonly protocol: number;
	readonly #streams = new Map<string, (message: RelayStreamMessage) => void>();
	readonly #channels = new Map<number, string>();
	readonly #files = new Set<(event: FileEvent) => void>();
	#listening: (() => void) | null = null;

	constructor(
		private readonly bus: RelayBus,
		readonly ownerId: string,
		readonly info: ComputerInfo | null,
		private readonly capability: string,
	) {
		this.protocol = info?.protocol ?? PROTOCOL_VERSION;
	}

	/** One subscription to the owner's stream subject serves every stream and file listener this object has. */
	#listen(): void {
		if (this.#listening) return;
		this.#listening = this.bus.subscribe(this.ownerId, (m) => {
			if (m.k === "file_event") for (const l of [...this.#files]) l(m.event);
			else if (m.k === "data" || m.k === "end") if (m.dir === "down") this.#streams.get(m.id)?.(m);
		});
	}

	#maybeUnlisten(): void {
		if (this.#streams.size === 0 && this.#files.size === 0) {
			this.#listening?.();
			this.#listening = null;
		}
	}

	async #ask(request: RelayRequest, timeoutMs: number): Promise<RelayReply & { ok: true }> {
		let reply: RelayReply;
		try {
			reply = await this.bus.request(this.ownerId, request, timeoutMs);
		} catch (error) {
			if (error instanceof RelayNobody) throw new CapabilityUnavailableError(this.capability, "it needs a paired personal computer, and none is connected");
			throw new ComputerError(504, `The computer didn't answer within ${Math.round(timeoutMs / 1000)} seconds.`);
		}
		if (!reply.ok) throw failure(reply, this.capability);
		return reply;
	}

	async call<T = unknown>(op: string, args: Record<string, unknown> = {}, timeoutMs = FILE_CALL_MS): Promise<T> {
		// The owning process times the call itself; the request outlasts it, so its answer is the computer's timeout rather than ours.
		return (await this.#ask({ op: "call", name: op, args, timeoutMs }, timeoutMs + 3_000)).result as T;
	}

	async watch(path: string): Promise<unknown> {
		return (await this.#ask({ op: "watch", path }, FILE_CALL_MS + 3_000)).result;
	}

	async unwatch(path: string): Promise<boolean> {
		return (await this.#ask({ op: "unwatch", path }, FILE_CALL_MS + 3_000)).result === true;
	}

	onFileEvent(listener: (event: FileEvent) => void): () => void {
		this.#files.add(listener);
		this.#listen();
		return () => {
			this.#files.delete(listener);
			this.#maybeUnlisten();
		};
	}

	/** Registers stream `id` before it is opened, so no frame the computer sends first is lost; undone when the open fails. */
	async #open(id: string, request: RelayRequest, handler: (m: RelayStreamMessage) => void, timeoutMs: number): Promise<void> {
		this.#streams.set(id, handler);
		this.#listen();
		try {
			await this.#ask(request, timeoutMs);
		} catch (error) {
			this.#streams.delete(id);
			this.#maybeUnlisten();
			throw error;
		}
	}

	#end(id: string): void {
		if (!this.#streams.delete(id)) return;
		this.bus.publish(this.ownerId, { k: "end", id, dir: "up" });
		this.#maybeUnlisten();
	}

	async openScreen(channel: number, handler: (data: string | Uint8Array | null) => void, display?: string): Promise<void> {
		const id = newId("rs");
		await this.#open(id, { op: "screen_open", id, channel, ...(display ? { display } : {}) }, (m) => this.#down(id, m, handler), 30_000 + 3_000);
		this.#channels.set(channel, id);
	}

	screenInput(channel: number, data: string): void {
		const id = this.#channels.get(channel);
		if (id) this.bus.publish(this.ownerId, { k: "data", id, dir: "up", binary: false, data });
	}

	closeScreen(channel: number): void {
		const id = this.#channels.get(channel);
		this.#channels.delete(channel);
		if (id) this.#end(id);
	}

	#down(id: string, m: RelayStreamMessage, handler: (data: string | Uint8Array | null) => void): void {
		if (m.k === "end") {
			this.#streams.delete(id);
			this.#maybeUnlisten();
			handler(null);
		} else if (m.k === "data") handler(m.binary ? new Uint8Array(Buffer.from(m.data, "base64")) : m.data);
	}

	async openBrowser(handler: (data: string | null) => void, thread?: string): Promise<{ send(data: string): void; close(): void }> {
		const id = newId("rb");
		await this.#open(id, { op: "browser_open", id, ...(thread ? { thread } : {}) }, (m) => this.#down(id, m, (d) => handler(d === null ? null : String(d))), 120_000 + 3_000);
		return { send: (data) => this.#streams.has(id) && this.bus.publish(this.ownerId, { k: "data", id, dir: "up", binary: false, data }), close: () => this.#end(id) };
	}

	async openAppSocket(appId: string, path: string, headers: Record<string, string>, handler: (data: Uint8Array | string | null) => void): Promise<{ send(data: Uint8Array | string): void; close(): void }> {
		const id = newId("ra");
		await this.#open(id, { op: "appws_open", id, appId, path, headers }, (m) => this.#down(id, m, handler), FILE_CALL_MS + 3_000);
		return {
			send: (data) => this.#streams.has(id) && this.bus.publish(this.ownerId, { k: "data", id, dir: "up", binary: typeof data !== "string", data: typeof data === "string" ? data : b64(data) }),
			close: () => this.#end(id),
		};
	}

	async ping(): Promise<number | null> {
		const start = Date.now();
		try {
			await this.call("ping", {}, 5_000);
			return Date.now() - start;
		} catch {
			return null;
		}
	}
}

/**
 * The owner's computer as seen from a process that may not hold its socket (a Runner calling `file_*` or `shell`, a Gate relaying a hosted app): asks
 * the bus who does. No process holding a live `pimc_` connection is `CapabilityUnavailableError`, cleanly, as is a bus that is not configured.
 */
export async function acquireRemote(bus: RelayBus | null, ownerId: string, capability: string): Promise<RemoteComputer> {
	if (!bus) throw new CapabilityUnavailableError(capability, "it needs a paired personal computer, and none is connected");
	let reply: RelayReply;
	try {
		reply = await bus.request(ownerId, { op: "info" }, 2_000);
	} catch {
		throw new CapabilityUnavailableError(capability, "it needs a paired personal computer, and none is connected");
	}
	if (!reply.ok) throw failure(reply, capability);
	return new RemoteComputer(bus, ownerId, (reply.result as ComputerInfo | null) ?? null, capability);
}

export type AppHttpRequest = { method: string; path: string; headers: Record<string, string>; body?: Uint8Array };
export type AppHttpResponse = { status: number; headers: Record<string, string | string[]>; body: Uint8Array };

/**
 * Relay: the personal computers paired with this Pim, and what runs through them. Pairing issues a `pimc_` token; the computer connects out with it
 * (so it needs no open port), and everything a space does on a computer, its files, commands, browser, desktop and the backends of its apps,
 * is a call on that connection. Screen and media never pass through the Runner or the chat bus. With no computer paired or connected, `require`
 * says so with `CapabilityUnavailableError`, and nothing that does not need one is affected.
 */
export class Relay {
	readonly #links = new Map<string, ComputerConnection>();
	readonly #askedToUpdate = new Map<string, number>();
	readonly #states = new Map<string, { watching: Map<string, number>; listeners: Set<(event: FileEvent) => void> }>();
	#bus: RelayBus | null = null;
	/** Set by the Gate, so a computer's triggers frames have somewhere to go. */
	computerTriggers: ComputerTriggersHost | null = null;
	/** Told when an owner's computer is paired, forgotten, connects or drops, so their open apps show it (set by the Gate; the Live service carries it on). */
	changed: ((ownerId: string) => void) | null = null;
	/** Names this process on the bus, so it hears its own notices as its own. */
	#holder = newId("relay");
	/** The owners whose computer this process holds, with what it does on the bus for them while it does. */
	readonly #serving = new Map<string, { stop: () => void; unfile: () => void }>();
	/** The streams other processes opened on computers this process holds: frames from the viewer go to `up`, and `close` ends them. */
	readonly #hosted = new Map<string, { up(data: string | Uint8Array): void; close(): void }>();

	#state(ownerId: string) {
		let s = this.#states.get(ownerId);
		if (!s) this.#states.set(ownerId, (s = { watching: new Map(), listeners: new Set() }));
		return s;
	}

	constructor(
		private readonly db: Db,
		private readonly identity = new Identity(db),
		private readonly authz = new Authorizer(db),
		/** The key app backends' request signatures are made from, as the space's own key is for the Worker; one per process unless configured. */
		private readonly appKey: string = secret(),
	) {}

	async pair(p: Principal, name: string, protocol: 1 | 2): Promise<{ computerId: string; token: string }> {
		await this.authz.enforce(p, "computer:use");
		const computerId = newId("pc");
		const consumer = await this.identity.issueConsumer(p.ownerId, "computer", { label: name, scopes: ["computer:connect"], metadata: { computerId } });
		await this.db.owner(p.ownerId, async (tx) => {
			// A space has at most one computer: pairing another replaces the one before.
			await tx.query("UPDATE pim_app.computers SET revoked_at = now() WHERE revoked_at IS NULL");
			await tx.query("UPDATE pim_app.token_consumers SET revoked_at = coalesce(revoked_at, now()) WHERE kind = 'computer' AND id <> $1", [consumer.id]);
			await tx.query("INSERT INTO pim_app.computers (id, owner_id, name, protocol, consumer_id) VALUES ($1,$2,$3,$4,$5)", [computerId, p.ownerId, name, protocol, consumer.id]);
		});
		this.disconnect(p.ownerId);
		this.changed?.(p.ownerId);
		return { computerId, token: consumer.token };
	}

	/** Forgets the computer: its token stops working and its socket closes. */
	async unpair(p: Principal): Promise<void> {
		await this.authz.enforce(p, "computer:use");
		await this.db.owner(p.ownerId, async (tx) => {
			await tx.query("UPDATE pim_app.computers SET revoked_at = now() WHERE revoked_at IS NULL");
			await tx.query("UPDATE pim_app.token_consumers SET revoked_at = coalesce(revoked_at, now()) WHERE kind = 'computer'");
		});
		this.disconnect(p.ownerId);
		this.changed?.(p.ownerId);
	}

	async status(p: Principal) {
		await this.authz.enforce(p, "api:read");
		const row = await this.db.owner(p.ownerId, async (tx) => (await tx.query("SELECT id, name, protocol, last_seen_at FROM pim_app.computers WHERE revoked_at IS NULL")).rows[0]);
		const link: Computer | null = !row ? null : (this.#links.get(p.ownerId) ?? (await this.acquire(p.ownerId, "status").catch(() => null)));
		return { state: !row ? ("none" as const) : link ? ("online" as const) : ("offline" as const), computer: row ? { id: row.id as string, name: row.name as string, lastSeenAt: row.last_seen_at as Date | null, info: link?.info ?? null } : null };
	}

	/**
	 * A computer connects with its `pimc_` token. A revoked token, an owner who is suspended (403) or deleted (410), and a token that is not a computer's
	 * are refused before anything is kept. A second connection with the same token replaces the first, which is closed with REPLACED.
	 */
	async connect(token: string, socket: ComputerSocket): Promise<ComputerConnection> {
		const p = await this.identity.authenticate(token);
		if (p.kind !== "token" || !p.scopes.includes("computer:connect")) throw new NotFoundError("Not a computer token");
		await this.authz.enforce(p, "computer:connect");
		const computerId = await this.db.owner(p.ownerId, async (tx) => {
			const c = (await tx.query("SELECT id FROM pim_app.computers WHERE consumer_id = $1 AND revoked_at IS NULL", [p.tokenId])).rows[0];
			if (!c) throw new NotFoundError("This computer is no longer paired");
			await tx.query("UPDATE pim_app.computers SET last_seen_at = now() WHERE id = $1", [c.id]);
			return c.id as string;
		});
		const conn = new ComputerConnection(p.ownerId, computerId, p.tokenId, socket, this.#state(p.ownerId), (c) => {
			this.#maybeAskUpdate(c);
			void this.db.owner(p.ownerId, (tx) => tx.query("UPDATE pim_app.computers SET protocol = $2, last_seen_at = now() WHERE id = $1", [computerId, Math.min(c.protocol, 2)])).catch(() => undefined);
		});
		conn.triggers = this.computerTriggers?.open(conn, token) ?? null;
		const previous = this.#links.get(p.ownerId);
		this.#links.set(p.ownerId, conn);
		previous?.close(REPLACED, "Another computer connected with this token");
		this.#serve(p.ownerId, conn);
		this.changed?.(p.ownerId);
		return conn;
	}

	/** The socket closed. A replaced connection does not remove its successor. */
	disconnected(conn: ComputerConnection): void {
		conn.closed();
		if (this.#links.get(conn.ownerId) === conn) {
			this.#unlink(conn.ownerId);
			this.changed?.(conn.ownerId);
		}
	}

	disconnect(ownerId: string, code = 1000, reason = "Unpaired"): void {
		const link = this.#links.get(ownerId);
		this.#unlink(ownerId);
		link?.close(code, reason);
	}

	#unlink(ownerId: string): void {
		this.#links.delete(ownerId);
		const serving = this.#serving.get(ownerId);
		this.#serving.delete(ownerId);
		serving?.stop();
		serving?.unfile();
	}

	// ---- across processes ----

	/**
	 * Lets other processes reach computers this one holds: the Gate serving `/hosted/*` or a Runner calling `file_*` and `shell` asks on the bus,
	 * and the one process that holds the owner's socket answers. Without a bus, a computer is reachable only from the process that holds it.
	 */
	useBus(bus: RelayBus): void {
		this.#bus = bus;
	}

	/** This process holds the owner's computer: it answers for it on the bus until it does not, and tells the others, so a connection one of them holds for the owner is closed. */
	#serve(ownerId: string, conn: ComputerConnection): void {
		const bus = this.#bus;
		if (!bus) return;
		if (!this.#serving.has(ownerId)) {
			const forward = (event: FileEvent) => bus.publish(ownerId, { k: "file_event", event });
			this.#state(ownerId).listeners.add(forward);
			const stop = bus.serve(ownerId, { rpc: (request) => this.#answer(ownerId, request), stream: (message) => this.#heard(ownerId, message) });
			this.#serving.set(ownerId, { stop, unfile: () => this.#state(ownerId).listeners.delete(forward) });
		}
		bus.publish(ownerId, { k: "connected", holder: this.#holder, at: conn.connectedAt });
	}

	/** Another process accepted the owner's computer: the older of the two connections is the stale one, and closes. */
	#heard(ownerId: string, m: RelayStreamMessage): void {
		if (m.k === "connected") {
			const link = this.#links.get(ownerId);
			if (m.holder === this.#holder || !link) return;
			if (link.connectedAt < m.at || (link.connectedAt === m.at && this.#holder < m.holder)) {
				this.#unlink(ownerId);
				link.close(REPLACED, "Another computer connected with this token");
			}
			return;
		}
		if (m.k === "data" && m.dir === "up") this.#hosted.get(m.id)?.up(m.binary ? new Uint8Array(Buffer.from(m.data, "base64")) : m.data);
		else if (m.k === "end" && m.dir === "up") this.#hosted.get(m.id)?.close();
	}

	/** One request from another process, run on the computer this one holds. */
	async #answer(ownerId: string, request: RelayRequest): Promise<RelayReply> {
		const link = this.#links.get(ownerId);
		if (!link) return { ok: false, unavailable: true, message: "No computer is connected here" };
		const bus = this.#bus!;
		const down = (id: string, data: string | Uint8Array | null) => {
			if (data === null) {
				this.#hosted.delete(id);
				bus.publish(ownerId, { k: "end", id, dir: "down" });
			} else bus.publish(ownerId, { k: "data", id, dir: "down", binary: typeof data !== "string", data: typeof data === "string" ? data : b64(data) });
		};
		try {
			switch (request.op) {
				case "info":
					return { ok: true, result: link.info };
				case "call":
					return { ok: true, result: await link.call(request.name, request.args, request.timeoutMs) };
				case "watch":
					return { ok: true, result: await link.watch(request.path) };
				case "unwatch":
					return { ok: true, result: await link.unwatch(request.path) };
				case "screen_open":
					await link.openScreen(request.channel, (data) => down(request.id, data), request.display);
					this.#hosted.set(request.id, { up: (data) => link.screenInput(request.channel, String(data)), close: () => (this.#hosted.delete(request.id), link.closeScreen(request.channel)) });
					return { ok: true };
				case "browser_open": {
					const transport = await link.openBrowser((data) => down(request.id, data), request.thread);
					this.#hosted.set(request.id, { up: (data) => transport.send(String(data)), close: () => (this.#hosted.delete(request.id), transport.close()) });
					return { ok: true };
				}
				case "appws_open": {
					const transport = await link.openAppSocket(request.appId, request.path, request.headers, (data) => down(request.id, data));
					this.#hosted.set(request.id, { up: (data) => transport.send(data), close: () => (this.#hosted.delete(request.id), transport.close()) });
					return { ok: true };
				}
			}
		} catch (error) {
			if (error instanceof ComputerError) return { ok: false, status: error.status, message: error.message, ...(error.remote ? { remote: error.remote } : {}) };
			return { ok: false, status: 500, message: (error as Error).message };
		}
	}

	/**
	 * The owner's computer for a tool that needs one, wherever its socket is: this process's own, else the process that holds it, over the bus.
	 * `CapabilityUnavailableError` when no process holds a live connection.
	 */
	async acquire(ownerId: string, capability: string): Promise<Computer> {
		const link = this.#links.get(ownerId);
		if (link) return link;
		return acquireRemote(this.#bus, ownerId, capability);
	}

	/** A computer that speaks an older protocol is asked to update itself (once in ten minutes), when it is idle; one that cannot stays connected on the older protocol. */
	#maybeAskUpdate(conn: ComputerConnection): void {
		if (conn.protocol >= PROTOCOL_VERSION) return;
		setTimeout(() => {
			const last = this.#askedToUpdate.get(conn.computerId) ?? 0;
			if (!conn.idle || Date.now() - last < OUTDATED_RETRY_MS || this.#links.get(conn.ownerId) !== conn) return;
			this.#askedToUpdate.set(conn.computerId, Date.now());
			conn.close(OUTDATED, "Update pim-computer");
		}, 1_000).unref();
	}

	/** Closes the sockets of owners who are no longer live (suspended or deleted) or whose token was revoked, so nothing keeps running for them. */
	async sweep(): Promise<number> {
		let closed = 0;
		for (const [ownerId, conn] of [...this.#links]) {
			const live = await this.authz.requireLive(ownerId).then(() => true, () => false);
			const paired = live && (await this.db.owner(ownerId, async (tx) => !!(await tx.query("SELECT 1 FROM pim_app.token_consumers WHERE id = $1 AND revoked_at IS NULL", [conn.consumerId])).rowCount));
			if (!paired) {
				this.disconnect(ownerId, 4003, "Not allowed");
				closed++;
			}
		}
		return closed;
	}

	/** The owner's connected computer for a tool that needs one. */
	require(ownerId: string, capability: string): ComputerConnection {
		const link = this.#links.get(ownerId);
		if (!link) throw new CapabilityUnavailableError(capability, "it needs a paired personal computer, and none is connected");
		return link;
	}

	/** A call on the computer for `p`, after the owner is checked alive. */
	async call<T = unknown>(p: Principal, capability: string, op: string, args: Record<string, unknown> = {}, timeoutMs?: number): Promise<T> {
		await this.authz.enforce(p, "computer:use");
		return (await this.acquire(p.ownerId, capability)).call<T>(op, args, timeoutMs);
	}

	// ---- apps with a backend ----

	/** The key a backend checks `x-pim-signature` against: made from the Relay's key, one per app. */
	appSecret(ownerId: string, appId: string): string {
		return createHmac("sha256", this.appKey).update(`${ownerId}\n${appId}`).digest("base64url");
	}

	/**
	 * `app_deploy`: puts a version's files on the computer and runs the backend there. A gated action: a person at their own keyboard is the approval,
	 * anyone else (an agent, a token) needs a standing approval or gets `ApprovalRequiredError`. Without a computer: `CapabilityUnavailableError`.
	 */
	async deployApp(p: Principal, app: { id: string; version: number; files: Record<string, string>; manifest: { backend: { command: string; install?: string }; access: string }; port: number }): Promise<unknown> {
		const decision = await this.authz.authorize({ principal: p, ownerId: p.ownerId, action: "app:deploy", resource: { app: app.id, access: app.manifest.access } });
		if (decision.outcome === "approval_required" && p.kind !== "user") throw new ApprovalRequiredError("app:deploy", decision.approvalKey);
		const link = await this.acquire(p.ownerId, "app_deploy");
		return runBackend(link, { id: app.id, version: app.version, files: app.files, backend: app.manifest.backend, port: app.port, secret: this.appSecret(p.ownerId, app.id) });
	}

	/** What the computer says of an app's backend, or null while it cannot say (offline, or never run). */
	async appStatus(ownerId: string, appId: string): Promise<{ state: string; restarts: number; since: number | null } | null> {
		try {
			const { apps } = await (await this.acquire(ownerId, "app_status")).call<{ apps: { id: string; state: string; restarts: number; since: number }[] }>("app_status", { id: computerAppId(appId) });
			const mine = apps.find((a) => a.id === computerAppId(appId));
			return mine ? { state: mine.state, restarts: mine.restarts, since: mine.since } : { state: "stopped", restarts: 0, since: null };
		} catch {
			return null;
		}
	}

	async appLogs(p: Principal, appId: string, bytes?: number): Promise<{ text: string }> {
		return this.call(p, "app_logs", "app_logs", { id: computerAppId(appId), ...(bytes ? { bytes } : {}) });
	}

	async stopApp(p: Principal, appId: string) {
		return this.call(p, "app_stop", "app_stop", { id: computerAppId(appId) });
	}

	/**
	 * Relays one HTTP request to an app's backend on the computer's loopback (`app_http`), so the computer needs no open port. At most 1 MiB in and
	 * 4 MiB out, within 60 seconds. The owner must be live: a suspended owner's apps do not run (403), a deleted one's are gone (410). Offline: 503.
	 */
	async appHttp(ownerId: string, appId: string, request: AppHttpRequest): Promise<AppHttpResponse> {
		await this.authz.requireLive(ownerId, "hosted:run");
		if ((request.body?.length ?? 0) > 1_048_576) throw new PimError(413, "too_large", "A request to an app is at most 1 MiB");
		const link = await this.acquire(ownerId, "hosted app backend");
		// The computer takes and gives headers as [name, value] pairs, so a header that repeats (set-cookie) keeps each of its values.
		const r = await link.call<{ status: number; headers: [string, string][] | Record<string, string | string[]>; body: string }>("app_http", { id: computerAppId(appId), method: request.method, path: request.path, headers: Object.entries(request.headers), ...(request.body ? { body: Buffer.from(request.body).toString("base64") } : {}) }, 60_000);
		const body = new Uint8Array(Buffer.from(r.body ?? "", "base64"));
		if (body.length > 4_194_304) throw new PimError(502, "too_large", "The app's response was over 4 MiB");
		const headers: Record<string, string | string[]> = {};
		for (const [name, value] of Array.isArray(r.headers) ? r.headers : Object.entries(r.headers ?? {}).flatMap(([n, v]) => (Array.isArray(v) ? v : [v]).map((x): [string, string] => [n, x]))) {
			const key = name.toLowerCase();
			const held = headers[key];
			headers[key] = held === undefined ? value : Array.isArray(held) ? [...held, value] : [held, value];
		}
		return { status: r.status, headers, body };
	}
}
