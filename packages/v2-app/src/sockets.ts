import type { IncomingMessage, Server } from "node:http";
import type { Duplex } from "node:stream";
import * as decoding from "lib0/decoding";
import * as encoding from "lib0/encoding";
import type { Principal } from "@pim/v2-contracts/identity";
import { WebSocket, WebSocketServer } from "ws";
import * as syncProtocol from "y-protocols/sync";
import * as Y from "yjs";
import type { App } from "./app.ts";
import { type GateOptions, originOf } from "./gate.ts";
import { fromAnotherSite, bearerOf } from "./http.ts";
import { httpStatus, NotFoundError } from "./errors.ts";
import type { ComputerConnection } from "./relay.ts";

/** The paths the Gate upgrades to WebSockets. */
export const COMPUTER_CONNECT = "/api/computer/connect";
export const COMPUTER_SCREEN = "/api/computer/screen";
export const BROWSER_LIVE = "/api/browser/live";
export const NOTES_LIVE = "/api/notes/live";

/** How a message from an app showing the desktop begins when it times its round trips, which the Relay answers itself. */
const SCREEN_PING = '{"type":"pim_ping"';
const SCREEN_CLIPBOARD = '{"type":"pim_clipboard"';
const MAX_NOTE_MESSAGE = 2_000_000;
/** Messages of a note's socket, numbered as y-websocket does. */
const SYNC = 0;
const AWARENESS = 1;

function refuse(socket: Duplex, status: number, message: string): void {
	socket.write(`HTTP/1.1 ${status} ${message.replace(/[\r\n]/g, " ").slice(0, 80)}\r\nconnection: close\r\ncontent-length: 0\r\n\r\n`);
	socket.destroy();
}

/**
 * The Gate's WebSockets, handled by the Relay and Canvas rather than the request router: a computer connecting (`/api/computer/connect`, `pimc_` token),
 * the app showing its desktop (`/api/computer/screen`), taking its browser over (`/api/browser/live`) and editing a note live (`/api/notes/live`).
 * Screen and browser media go straight between the computer's socket and the viewer's, never through the Runner or the chat bus. A browser's
 * socket must come from this app's own origin, and its credential is the session cookie (or `?token=`, which only an upgrade may use).
 */
export function attachSockets(server: Server, app: App, options: GateOptions = {}): { close(): void } {
	const wss = new WebSocketServer({ noServer: true, maxPayload: 8 * 1024 * 1024 });
	const noteRooms = new Map<string, NoteRoom>();
	const stopCanvas = app.canvas.onUpdate((noteId, update, origin) => {
		// What agents wrote reaches the editors open on the note; what an editor wrote already did.
		if (origin.startsWith("user:")) return;
		for (const room of noteRooms.values()) if (room.noteId === noteId) room.agentUpdate(update);
	});
	const sweeper = setInterval(() => void app.relay.sweep().catch(() => undefined), 30_000);
	sweeper.unref();

	server.on("upgrade", (req: IncomingMessage, socket: Duplex, head: Buffer) => {
		void (async () => {
			try {
				const origin = originOf(req, options);
				const url = new URL(req.url ?? "/", origin);
				const secure = origin.startsWith("https:");
				if (url.pathname === COMPUTER_CONNECT) {
					const token = req.headers.authorization?.startsWith("Bearer ") ? req.headers.authorization.slice(7) : undefined;
					if (!token?.startsWith("pimc_")) return refuse(socket, 401, "Unauthorized");
					// Authorized before the upgrade completes, so a refusal is an HTTP status the computer can read.
					await app.identity.authenticate(token);
					wss.handleUpgrade(req, socket, head, (ws) => void attachComputer(app, token, ws));
					return;
				}
				// An app's own WebSocket, relayed to its backend: by its token path, or at its own address.
				const hostedPath = /^\/hosted\/([^/]+)\/([^/]+)\/([^/]+)(\/.*)?$/.exec(url.pathname);
				const appsHost = options.appsOrigin ? new URL(options.appsOrigin).hostname : null;
				const host = (req.headers.host ?? "").split(":")[0] ?? "";
				if (hostedPath || (appsHost && host.endsWith(`.${appsHost}`))) {
					const target = await authorizeAppSocket(app, req, url, hostedPath, appsHost ? host.slice(0, -(appsHost.length + 1)) : null);
					await app.relay.acquire(target.ownerId, "hosted app backend");
					wss.handleUpgrade(req, socket, head, (ws) => void proxyAppSocket(app, target, ws));
					return;
				}
				if (![COMPUTER_SCREEN, BROWSER_LIVE, NOTES_LIVE].includes(url.pathname)) return refuse(socket, 404, "Not found");
				if (fromAnotherSite(req)) return refuse(socket, 403, "Requests must come from this app");
				const { bearer } = bearerOf(req, url, secure);
				const p = await app.identity.authenticate(bearer);
				await app.identity.authz.enforce(p, "api:read");
				// The desktop takes input as if at the computer itself: only the person, signed in in their browser, uses it.
				if (url.pathname === COMPUTER_SCREEN) await app.identity.authz.enforce(p, "computer:screen");
				// Before upgrading: no computer, in this process or any other, is a clean refusal.
				if (url.pathname === COMPUTER_SCREEN) await app.relay.acquire(p.ownerId, "desktop_screen");
				if (url.pathname === BROWSER_LIVE) await app.relay.acquire(p.ownerId, "browser_live");
				wss.handleUpgrade(req, socket, head, (ws) => {
					if (url.pathname === COMPUTER_SCREEN) void viewScreen(app, p, ws, url);
					else if (url.pathname === BROWSER_LIVE) void viewBrowser(app, p, ws, url);
					else void openNote(app, noteRooms, p, ws, url);
				});
			} catch (error) {
				const known = httpStatus(error);
				refuse(socket, known?.status ?? 500, known ? (error as Error).message : "Something went wrong");
			}
		})();
	});
	return { close: () => (clearInterval(sweeper), stopCanvas(), [...wss.clients].forEach((c) => c.terminate()), wss.close()) };
}

type AppTarget = { ownerId: string; appId: string; path: string; headers: Record<string, string> };

/** Who may open an app's socket is who may open its page: a token path, or the cookie at its own address. Never `?token=`: published and app paths are strict. */
async function authorizeAppSocket(app: App, req: IncomingMessage, url: URL, byToken: RegExpExecArray | null, label: string | null): Promise<AppTarget> {
	const headers: Record<string, string> = {};
	for (const name of ["sec-websocket-protocol", "user-agent", "accept-language"]) if (typeof req.headers[name] === "string") headers[name] = req.headers[name] as string;
	if (byToken) {
		const [, owner, id, token, rest] = byToken as unknown as [string, string, string, string, string | undefined];
		await app.apps.authorizeHosted(decodeURIComponent(owner), decodeURIComponent(id), decodeURIComponent(token));
		return { ownerId: decodeURIComponent(owner), appId: decodeURIComponent(id), path: (rest ?? "/") + url.search, headers: { ...headers, "x-forwarded-prefix": `/hosted/${owner}/${id}/${token}` } };
	}
	const found = await app.apps.byLabel(label ?? "");
	if (!found) throw new NotFoundError();
	const cookie = /(?:^|;\s*)pim_app=([^;]+)/.exec(req.headers.cookie ?? "")?.[1];
	if (!(await app.apps.mayOpen(found, await app.apps.cookieVisitor(label!, cookie)))) throw new NotFoundError();
	return { ownerId: found.ownerId, appId: found.id, path: url.pathname + url.search, headers };
}

async function proxyAppSocket(app: App, target: AppTarget, ws: WebSocket): Promise<void> {
	try {
		const backend = await (await app.relay.acquire(target.ownerId, "hosted app backend")).openAppSocket(target.appId, target.path, target.headers, (data) => {
			if (data === null) return ws.close(1001, "The app closed the connection");
			if (ws.readyState === WebSocket.OPEN) ws.send(data, { binary: typeof data !== "string" });
		});
		ws.on("message", (data, isBinary) => backend.send(isBinary ? new Uint8Array(Array.isArray(data) ? Buffer.concat(data) : (data as Buffer)) : data.toString()));
		ws.on("close", () => backend.close());
	} catch (error) {
		ws.close(1013, (error as Error).message.slice(0, 100));
	}
	ws.on("error", () => undefined);
}

async function attachComputer(app: App, token: string, ws: WebSocket): Promise<void> {
	// A computer says hello the moment it connects, before the Relay has finished registering it: nothing it sends may be lost.
	let conn: ComputerConnection | null = null;
	const early: (string | Uint8Array)[] = [];
	ws.on("message", (data, isBinary) => {
		const bytes = Array.isArray(data) ? Buffer.concat(data) : Buffer.from(data as Buffer);
		const frame = isBinary ? new Uint8Array(bytes) : bytes.toString("utf8");
		if (conn) conn.receive(frame);
		else early.push(frame);
	});
	ws.on("error", () => undefined);
	try {
		conn = await app.relay.connect(token, ws);
	} catch (error) {
		ws.close(4003, (error as Error).message.slice(0, 100));
		return;
	}
	const connected = conn;
	ws.on("close", () => app.relay.disconnected(connected));
	if (ws.readyState !== WebSocket.OPEN) app.relay.disconnected(connected);
	for (const frame of early) connected.receive(frame);
}

/** The app showing the computer's desktop: a stream opens on a channel of its own, what it says goes to the viewer as it is, and what the viewer sends goes to the stream. */
async function viewScreen(app: App, p: Principal, ws: WebSocket, url: URL): Promise<void> {
	const conn = await app.relay.acquire(p.ownerId, "desktop_screen");
	const channel = (Math.floor(Math.random() * 0xfffffffe) + 1) >>> 0;
	const display = url.searchParams.get("display") || undefined;
	try {
		await conn.openScreen(channel, (data) => {
			if (data === null) return ws.close(1001, "The computer closed the stream");
			if (ws.readyState === WebSocket.OPEN) ws.send(data, { binary: typeof data !== "string" });
		}, display);
	} catch (error) {
		ws.close(1011, (error as Error).message.slice(0, 100));
		return;
	}
	ws.on("message", async (data, isBinary) => {
		if (isBinary) return;
		const raw = data.toString();
		if (raw.startsWith(SCREEN_PING)) {
			const payload = (JSON.parse(raw) as { payload?: object }).payload ?? {};
			const ms = await conn.ping();
			if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type: "pim_pong", payload: { ...payload, computer_ms: ms } }));
		} else if (raw.startsWith(SCREEN_CLIPBOARD)) {
			let payload: { text: string; error?: string };
			try {
				payload = { text: await conn.call<string>("screen_clipboard", display ? { display } : {}) };
			} catch (error) {
				payload = { text: "", error: (error as Error).message };
			}
			if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type: "pim_clipboard_text", payload }));
		} else conn.screenInput(channel, raw);
	});
	ws.on("close", () => conn.closeScreen(channel));
	ws.on("error", () => undefined);
}

/**
 * Taking the agent's browser over: the page as JPEG frames (`{type:"frame"}`), the page's address and title (`{type:"page"}`), and the viewer's mouse
 * and keyboard as DevTools input. The Relay speaks DevTools itself over the computer's `cdp` channel, so no Runner or Harness is in this path.
 */
async function viewBrowser(app: App, p: Principal, ws: WebSocket, url: URL): Promise<void> {
	const conn = await app.relay.acquire(p.ownerId, "browser_live");
	const thread = url.searchParams.get("session") || undefined;
	let nextId = 0;
	let sessionId: string | undefined;
	const waiting = new Map<number, (result: any) => void>();
	const send = (message: object) => ws.readyState === WebSocket.OPEN && ws.send(JSON.stringify(message));
	const open = (t: string | undefined) => conn.openBrowser((raw) => {
		if (raw === null) return ws.close(1001, "The browser closed");
		const m = JSON.parse(raw) as { id?: number; result?: unknown; method?: string; params?: any; sessionId?: string };
		if (m.id !== undefined) return waiting.get(m.id)?.(m.result), void waiting.delete(m.id);
		if (m.sessionId !== sessionId) return;
		if (m.method === "Page.screencastFrame") {
			send({ type: "frame", data: m.params.data, width: m.params.metadata?.deviceWidth ?? 0, height: m.params.metadata?.deviceHeight ?? 0 });
			void command("Page.screencastFrameAck", { sessionId: m.params.sessionId });
		} else if (m.method === "Page.frameNavigated" && !m.params.frame.parentId) send({ type: "page", url: m.params.frame.url, title: "" });
		else if (m.method === "Target.targetInfoChanged") send({ type: "page", url: m.params.targetInfo.url, title: m.params.targetInfo.title });
	}, t);
	// A computer without displayd has one browser, which the chats share: a chat with no display of its own takes that one over.
	const transport = await open(thread).catch((error: Error) => (/no display allocated|displayd is not reachable/.test(error.message) ? open(undefined) : Promise.reject(error))).catch((error: Error) => (send({ type: "error", message: error.message }), ws.close(1011, "No browser"), null));
	if (!transport) return;
	const command = (method: string, params: object = {}, session = sessionId): Promise<any> =>
		new Promise((resolve) => {
			const id = ++nextId;
			waiting.set(id, resolve);
			transport.send(JSON.stringify({ id, method, params, ...(session ? { sessionId: session } : {}) }));
		});
	const { targetInfos } = await command("Target.getTargets", {}, undefined);
	const page = (targetInfos as { type: string; targetId: string }[]).find((t) => t.type === "page");
	if (!page) return void (send({ type: "error", message: "The browser has no page open." }), ws.close(1011, "No page"));
	sessionId = (await command("Target.attachToTarget", { targetId: page.targetId, flatten: true }, undefined)).sessionId;
	await command("Page.enable");
	await command("Page.startScreencast", { format: "jpeg", quality: 60, everyNthFrame: 1 });
	ws.on("message", (data) => {
		let input: any;
		try {
			input = JSON.parse(data.toString());
		} catch {
			return;
		}
		if (input.type === "mouse") void command("Input.dispatchMouseEvent", { type: input.event, x: input.x, y: input.y, button: input.button ?? "none", clickCount: input.clickCount ?? 0, deltaX: input.deltaX ?? 0, deltaY: input.deltaY ?? 0, modifiers: input.modifiers ?? 0 });
		else if (input.type === "key") void command("Input.dispatchKeyEvent", { type: input.event, key: input.key, code: input.code, ...(input.text ? { text: input.text } : {}), windowsVirtualKeyCode: input.keyCode ?? 0, modifiers: input.modifiers ?? 0 });
		else if (input.type === "text" && typeof input.text === "string") void command("Input.insertText", { text: input.text });
		else if (input.type === "navigate" && typeof input.url === "string") void command("Page.navigate", { url: input.url });
		else if (input.type === "reload") void command("Page.reload");
		else if (input.type === "back" || input.type === "forward") {
			void command("Page.getNavigationHistory").then((history) => {
				const entry = history?.entries?.[history.currentIndex + (input.type === "back" ? -1 : 1)];
				if (entry) void command("Page.navigateToHistoryEntry", { entryId: entry.id });
			});
		}
	});
	ws.on("close", () => transport.close());
	ws.on("error", () => undefined);
}

// ---- notes ----

/** One live note in this process: its document, and the editors on it. Persistence goes through Canvas, which fences writers across processes. */
class NoteRoom {
	readonly doc = new Y.Doc();
	readonly peers = new Map<WebSocket, { id: string; awareness: Uint8Array | null }>();
	/** Fires when typing has paused, to keep what was written as a version. */
	pause?: ReturnType<typeof setTimeout>;
	constructor(readonly ownerId: string, readonly noteId: string) {}

	broadcast(message: Uint8Array, except?: WebSocket) {
		for (const peer of this.peers.keys()) if (peer !== except && peer.readyState === WebSocket.OPEN) peer.send(message);
	}

	/** An agent's edit, already in the log, reaches the editors. */
	agentUpdate(update: Uint8Array) {
		Y.applyUpdate(this.doc, update, "agent");
		const enc = encoding.createEncoder();
		encoding.writeVarUint(enc, SYNC);
		syncProtocol.writeUpdate(enc, update);
		this.broadcast(encoding.toUint8Array(enc));
	}
}

async function openNote(app: App, rooms: Map<string, NoteRoom>, p: Principal, ws: WebSocket, url: URL): Promise<void> {
	const noteId = url.searchParams.get("note") ?? "";
	const key = `${p.ownerId}/${noteId}`;
	let room = rooms.get(key);
	try {
		if (!room) {
			const fresh = new NoteRoom(p.ownerId, noteId);
			const { update } = await app.canvas.state(p.ownerId, noteId);
			Y.applyUpdate(fresh.doc, update);
			room = rooms.get(key) ?? fresh;
			rooms.set(key, room);
		}
	} catch {
		ws.close(4004, `No note ${noteId}`.slice(0, 120));
		return;
	}
	const joined = room;
	const peer = { id: `${p.ownerId}:${Math.random().toString(36).slice(2)}`, awareness: null as Uint8Array | null };
	joined.peers.set(ws, peer);
	// The editor gets the document's state step and who else is there.
	const hello = encoding.createEncoder();
	encoding.writeVarUint(hello, SYNC);
	syncProtocol.writeSyncStep1(hello, joined.doc);
	ws.send(encoding.toUint8Array(hello));
	for (const [other, o] of joined.peers) if (other !== ws && o.awareness) ws.send(o.awareness);

	ws.on("message", async (data, isBinary) => {
		const bytes = new Uint8Array(Array.isArray(data) ? Buffer.concat(data) : (data as Buffer));
		if (!isBinary) return;
		if (bytes.byteLength > MAX_NOTE_MESSAGE) return ws.close(1009, "The message is too large");
		try {
			// Writing needs the account to be alive and allowed each time: a suspended person's open editor stops, it does not just stop reading.
			const decoder = decoding.createDecoder(bytes);
			const type = decoding.readVarUint(decoder);
			if (type === SYNC) {
				const reply = encoding.createEncoder();
				encoding.writeVarUint(reply, SYNC);
				const peerOrigin = {};
				const updates: Uint8Array[] = [];
				const collect = (update: Uint8Array, origin: unknown) => {
					if (origin === peerOrigin) updates.push(update);
				};
				joined.doc.on("update", collect);
				try {
					syncProtocol.readSyncMessage(decoder, reply, joined.doc, peerOrigin);
				} finally {
					joined.doc.off("update", collect);
				}
				if (encoding.length(reply) > 1) ws.send(encoding.toUint8Array(reply));
				for (const update of updates) {
					await app.identity.authz.enforce(p, "api:write");
					await app.canvas.applyLive(p.ownerId, noteId, peer.id, update);
					clearTimeout(joined.pause);
					joined.pause = setTimeout(() => void app.canvas.keep(p.ownerId, noteId, "person").catch(() => undefined), app.canvas.pauseMs);
					const fan = encoding.createEncoder();
					encoding.writeVarUint(fan, SYNC);
					syncProtocol.writeUpdate(fan, update);
					joined.broadcast(encoding.toUint8Array(fan), ws);
				}
			} else if (type === AWARENESS) {
				peer.awareness = bytes;
				joined.broadcast(bytes, ws);
			}
		} catch (error) {
			if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type: "error", message: (error as Error).message }));
			const status = httpStatus(error)?.status;
			if (status === 403 || status === 410) return void ws.close(4003, "Not allowed");
			// A write that did not reach the log must not stay in the live document: everyone on the note reloads from the log.
			rooms.delete(key);
			for (const other of joined.peers.keys()) other.close(4010, "Reconnect to resync");
		}
	});
	ws.on("close", () => {
		joined.peers.delete(ws);
		if (joined.peers.size === 0) {
			rooms.delete(key);
			// Closing the note keeps what was written, without waiting for a pause.
			if (joined.pause) {
				clearTimeout(joined.pause);
				void app.canvas.keep(p.ownerId, noteId, "person").catch(() => undefined);
			}
		}
	});
	ws.on("error", () => undefined);
}
