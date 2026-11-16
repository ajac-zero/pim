import { createHmac } from "node:crypto";
import { ApprovalRequiredError, CapabilityUnavailableError } from "@pim/v2-contracts/authz";
import type { Principal } from "@pim/v2-contracts/identity";
import { Authorizer } from "./authz.ts";
import type { Db } from "./db.ts";
import { NotFoundError, PimError } from "./errors.ts";
import { Identity } from "./identity.ts";
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

/**
 * One connected `pim-computer`. It speaks the `pim-computer` wire protocol: JSON text frames `hello` (what it is, and which protocol revision),
 * `call`/`reply` (the Relay's calls and its answers), `event` (file changes and watcher failures), `screen` and `cdp` streams on numbered
 * channels, and binary frames whose first four bytes are a screen channel. Protocol 1 (a computer that does not say its version) and 2 both connect.
 */
export class ComputerConnection {
	info: ComputerInfo | null = null;
	readonly #pending = new Map<string, { resolve: (v: unknown) => void; reject: (e: Error) => void; timer: NodeJS.Timeout }>();
	readonly #screens = new Map<number, (data: string | Uint8Array | null) => void>();
	readonly #cdp = new Map<number, (data: string | null) => void>();
	readonly #appSockets = new Map<number, (data: Uint8Array | string | null) => void>();
	#serial: Promise<unknown> = Promise.resolve();
	#closed = false;

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

	/** The socket closed: calls waiting on it fail now rather than at their timeouts. */
	closed(): void {
		this.#closed = true;
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

export type AppHttpRequest = { method: string; path: string; headers: Record<string, string>; body?: Uint8Array };
export type AppHttpResponse = { status: number; headers: Record<string, string>; body: Uint8Array };

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
	}

	async status(p: Principal) {
		await this.authz.enforce(p, "api:read");
		const row = await this.db.owner(p.ownerId, async (tx) => (await tx.query("SELECT id, name, protocol, last_seen_at FROM pim_app.computers WHERE revoked_at IS NULL")).rows[0]);
		const link = this.#links.get(p.ownerId);
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
		const previous = this.#links.get(p.ownerId);
		this.#links.set(p.ownerId, conn);
		previous?.close(REPLACED, "Another computer connected with this token");
		return conn;
	}

	/** The socket closed. A replaced connection does not remove its successor. */
	disconnected(conn: ComputerConnection): void {
		conn.closed();
		if (this.#links.get(conn.ownerId) === conn) this.#links.delete(conn.ownerId);
	}

	disconnect(ownerId: string, code = 1000, reason = "Unpaired"): void {
		const link = this.#links.get(ownerId);
		this.#links.delete(ownerId);
		link?.close(code, reason);
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
		return this.require(p.ownerId, capability).call<T>(op, args, timeoutMs);
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
	async deployApp(p: Principal, app: { id: string; version: number; files: Record<string, string>; manifest: { backend: { command: string; install?: string }; access: string } }): Promise<unknown> {
		const decision = await this.authz.authorize({ principal: p, ownerId: p.ownerId, action: "app:deploy", resource: { app: app.id, access: app.manifest.access } });
		if (decision.outcome === "approval_required" && p.kind !== "user") throw new ApprovalRequiredError("app:deploy", decision.approvalKey);
		const link = this.require(p.ownerId, "app_deploy");
		return link.call("app_start", { id: app.id, version: app.version, files: app.files, backend: app.manifest.backend, env: { PIM_APP_ID: app.id, PIM_APP_SECRET: this.appSecret(p.ownerId, app.id) } }, 15 * 60_000);
	}

	async appLogs(p: Principal, appId: string) {
		return this.call(p, "app_logs", "app_logs", { id: appId });
	}

	async stopApp(p: Principal, appId: string) {
		return this.call(p, "app_stop", "app_stop", { id: appId });
	}

	/**
	 * Relays one HTTP request to an app's backend on the computer's loopback (`app_http`), so the computer needs no open port. At most 1 MiB in and
	 * 4 MiB out, within 60 seconds. The owner must be live: a suspended owner's apps do not run (403), a deleted one's are gone (410). Offline: 503.
	 */
	async appHttp(ownerId: string, appId: string, request: AppHttpRequest): Promise<AppHttpResponse> {
		await this.authz.requireLive(ownerId, "hosted:run");
		if ((request.body?.length ?? 0) > 1_048_576) throw new PimError(413, "too_large", "A request to an app is at most 1 MiB");
		const link = this.require(ownerId, "hosted app backend");
		const r = await link.call<{ status: number; headers: Record<string, string>; body: string }>("app_http", { id: appId, method: request.method, path: request.path, headers: request.headers, ...(request.body ? { body: Buffer.from(request.body).toString("base64") } : {}) }, 60_000);
		const body = new Uint8Array(Buffer.from(r.body ?? "", "base64"));
		if (body.length > 4_194_304) throw new PimError(502, "too_large", "The app's response was over 4 MiB");
		return { status: r.status, headers: r.headers ?? {}, body };
	}
}
