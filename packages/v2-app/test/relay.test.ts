import { createHmac } from "node:crypto";
import { type Server, request as httpRequest } from "node:http";
import * as decoding from "lib0/decoding";
import * as encoding from "lib0/encoding";
import { OwnerId, type Principal } from "@pim/v2-contracts/identity";
import { WebSocket } from "ws";
import * as syncProtocol from "y-protocols/sync";
import * as Y from "yjs";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { App } from "../src/app.ts";
import { connect } from "../src/db.ts";
import { createGate } from "../src/gate.ts";
import { MemoryObjectStore } from "../src/objects.ts";
import { attachSockets } from "../src/sockets.ts";
import { bootstrap, freshDatabase, member } from "./support/fixture.ts";

let app: App;
let admin: Awaited<ReturnType<typeof bootstrap>>;
let server: Server;
let base: string;
let wsBase: string;
let sockets: { close(): void };

beforeAll(async () => {
	const urls = await freshDatabase();
	app = new App(connect(urls.appUrl, 10), new MemoryObjectStore(), { appKey: "test-app-key" });
	admin = await bootstrap(app, "root");
	await app.identity.setRegistrationOpen(admin.principal, true);
	const options = { appsOrigin: "http://apps.test", publicUrl: "http://pim.test" };
	server = createGate(app, options);
	sockets = attachSockets(server, app, options);
	await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
	const port = (server.address() as { port: number }).port;
	base = `http://127.0.0.1:${port}`;
	wsBase = `ws://127.0.0.1:${port}`;
});
afterAll(async () => {
	sockets.close();
	server.closeAllConnections();
	await new Promise<void>((r) => server.close(() => r()));
	await app.db.end();
});

const mk = async (name: string) => {
	const m = await member(app, admin.principal, name);
	const session = await app.identity.createSession(m.account.ownerId);
	return { ...m, session, cookie: `pim_session=${session}` };
};
type User = Awaited<ReturnType<typeof mk>>;

/** A software pim-computer: connects with its token, says hello, answers the Relay's calls from `handlers`, and records what it was asked. */
class FakeComputer {
	readonly calls: { op: string; args: any }[] = [];
	readonly frames: any[] = [];
	closed: { code: number; reason: string } | null = null;
	readonly handlers = new Map<string, (args: any) => unknown>();
	ws!: WebSocket;
	constructor(private readonly token: string, private readonly version: number | null = 2) {}

	async connect(): Promise<this> {
		this.ws = new WebSocket(`${wsBase}/api/computer/connect`, { headers: { Authorization: `Bearer ${this.token}` } });
		this.ws.on("message", (data) => {
			const m = JSON.parse(data.toString());
			this.frames.push(m);
			if (m.type !== "call") return;
			this.calls.push({ op: m.op, args: m.args });
			const handler = this.handlers.get(m.op);
			try {
				const result = handler ? handler(m.args) : m.op === "unwatch_all" || m.op === "ping" ? {} : undefined;
				if (result === undefined && !handler && !["unwatch_all", "ping"].includes(m.op)) return this.ws.send(JSON.stringify({ type: "reply", id: m.id, error: { message: `unknown op ${m.op}`, code: "EUNKNOWN" } }));
				this.ws.send(JSON.stringify({ type: "reply", id: m.id, result }));
			} catch (error) {
				this.ws.send(JSON.stringify({ type: "reply", id: m.id, error: { message: (error as Error).message, ...(error as { remote?: object }).remote } }));
			}
		});
		this.ws.on("close", (code, reason) => (this.closed = { code, reason: reason.toString() }));
		await new Promise<void>((resolve, reject) => {
			this.ws.once("open", () => resolve());
			this.ws.once("unexpected-response", (_req, res) => reject(Object.assign(new Error(`HTTP ${res.statusCode}`), { status: res.statusCode })));
			this.ws.once("error", reject);
		});
		this.ws.send(JSON.stringify({ type: "hello", agent: "pim-computer", hostname: "box", platform: "linux", arch: "x64", user: "me", root: "/home/me/files", browser: "/usr/bin/chrome", screen: true, desktop: false, ...(this.version === null ? {} : { version: this.version }) }));
		await until(() => app.relay.require !== undefined && this.helloSeen());
		return this;
	}

	helloSeen(): boolean {
		try {
			return [...(this.owner ? [this.owner] : [])].every((o) => app.relay.require(o, "x").info !== null);
		} catch {
			return false;
		}
	}
	owner = "";
	reply(id: string, result: unknown) {
		this.ws.send(JSON.stringify({ type: "reply", id, result }));
	}
	waitClosed = () => until(() => this.closed !== null, 3000);
}

async function until(fn: () => boolean | Promise<boolean>, ms = 2000) {
	const start = Date.now();
	while (!(await fn())) {
		if (Date.now() - start > ms) throw new Error("timed out waiting");
		await new Promise((r) => setTimeout(r, 15));
	}
}

async function pairAndConnect(u: User, version: number | null = 2) {
	const { token, computerId } = await app.relay.pair(u.principal, "laptop", version === 2 ? 2 : 1);
	const c = new FakeComputer(token, version);
	c.owner = u.account.ownerId;
	await c.connect();
	return { c, token, computerId };
}

describe("pairing and the computer's connection", () => {
	it("connects a protocol 2 computer and answers calls, mapping its errors", async () => {
		const u = await mk("rl-basic");
		expect(await app.relay.status(u.principal)).toMatchObject({ state: "none", computer: null });
		const { c } = await pairAndConnect(u);
		expect(await app.relay.status(u.principal)).toMatchObject({ state: "online", computer: { name: "laptop", info: { protocol: 2, hostname: "box", root: "/home/me/files", browser: "/usr/bin/chrome" } } });
		c.handlers.set("file_read", (a) => ({ content: `contents of ${a.path}`, sha256: "abc" }));
		expect(await app.relay.call(u.principal, "files", "file_read", { path: "/a.txt" })).toEqual({ content: "contents of /a.txt", sha256: "abc" });
		// A compare-and-swap write that lost: the computer's conflict comes back with its code, not as a generic failure.
		c.handlers.set("file_write", () => {
			throw Object.assign(new Error("The file changed"), { remote: { code: "hash_mismatch", path: "/a.txt", currentHash: "def" } });
		});
		await expect(app.relay.call(u.principal, "files", "file_write", { path: "/a.txt", expectedHash: "abc" })).rejects.toMatchObject({ status: 502, remote: { code: "hash_mismatch", currentHash: "def" } });
		// A call the computer never answers fails at its own timeout, not forever.
		c.handlers.set("hang", () => { throw new Error("unused"); });
		c.ws.removeAllListeners("message");
		await expect(app.relay.require(u.account.ownerId, "x").call("hang", {}, 80)).rejects.toMatchObject({ status: 504 });
		c.ws.close();
		await until(() => { try { app.relay.require(u.account.ownerId, "x"); return false; } catch { return true; } });
		// Offline is a clean, named absence; nothing else of the space is affected.
		await expect(app.relay.call(u.principal, "shell", "exec", {})).rejects.toMatchObject({ name: "CapabilityUnavailableError", capability: "shell" });
		await expect(app.relay.appHttp(u.account.ownerId, "a", { method: "GET", path: "/", headers: {} })).rejects.toMatchObject({ name: "CapabilityUnavailableError" });
		expect((await app.conversations.create(u.principal, {})).length).toBeGreaterThan(10);
	});

	it("lets an older protocol 1 computer connect and asks it, once it is idle, to update", async () => {
		const u = await mk("rl-v1");
		const { c } = await pairAndConnect(u, null);
		expect(app.relay.require(u.account.ownerId, "x").info).toMatchObject({ protocol: 1 });
		await c.waitClosed();
		expect(c.closed!.code).toBe(4410); // OUTDATED: pim-computer fetches the newer script and reconnects
		// A computer already at the current protocol is left alone.
		const v2 = await mk("rl-v2");
		const { c: current } = await pairAndConnect(v2, 2);
		await new Promise((r) => setTimeout(r, 1300));
		expect(current.closed).toBeNull();
	});

	it("replaces a connection that another one with the same token supersedes, and keeps the newer one", async () => {
		const u = await mk("rl-replace");
		const { c: first, token } = await pairAndConnect(u);
		const second = new FakeComputer(token);
		second.owner = u.account.ownerId;
		await second.connect();
		await first.waitClosed();
		expect(first.closed).toMatchObject({ code: 4409 });
		await new Promise((r) => setTimeout(r, 50));
		expect(app.relay.require(u.account.ownerId, "x")).toBeDefined(); // the old socket closing did not unseat the new one
		second.handlers.set("ping", () => ({}));
		expect(await app.relay.require(u.account.ownerId, "x").ping()).not.toBeNull();
	});

	it("asks for watches again when a computer reconnects, as often as they were counted", async () => {
		const u = await mk("rl-watch");
		const { c, token } = await pairAndConnect(u);
		c.handlers.set("watch", (a) => ({ exists: true, sha256: "s", size: 1, path: a.path }));
		const conn = app.relay.require(u.account.ownerId, "x");
		const events: any[] = [];
		conn.onFileEvent((e) => events.push(e));
		await conn.watch("/notes.md");
		await conn.watch("/notes.md");
		await conn.watch("/other.md");
		await conn.unwatch("/other.md");
		c.ws.send(JSON.stringify({ type: "event", event: "file_changed", path: "/notes.md", kind: "modified" }));
		await until(() => events.length === 1);
		expect(events[0]).toMatchObject({ event: "file_changed", path: "/notes.md" });
		c.ws.close();
		await c.waitClosed();
		const again = new FakeComputer(token);
		again.owner = u.account.ownerId;
		again.handlers.set("watch", (a) => ({ exists: true, sha256: "s", size: 1, path: a.path }));
		await again.connect();
		await until(() => again.calls.filter((x) => x.op === "watch").length === 2);
		expect(again.calls.map((x) => x.op)).toEqual(["unwatch_all", "watch", "watch"]); // the Relay's set is the truth: let go of any, then each as counted
		expect(again.calls.filter((x) => x.op === "watch").map((x) => x.args.path)).toEqual(["/notes.md", "/notes.md"]);
		// A watch the computer refuses is dropped and the listeners are told.
		again.handlers.set("watch", () => { throw Object.assign(new Error("no"), { remote: { code: "ENOENT" } }); });
		again.ws.close();
		await again.waitClosed();
		const third = new FakeComputer(token);
		third.owner = u.account.ownerId;
		third.handlers.set("watch", () => { throw Object.assign(new Error("no"), { remote: { code: "EACCES" } }); });
		await third.connect();
		await until(() => events.some((e) => e.event === "watch_error"));
		expect(events.find((e) => e.event === "watch_error")).toMatchObject({ path: "/notes.md", code: "EACCES" });
	});
});

describe("refusing and cutting off computers", () => {
	it("refuses a token that is not a computer's, a revoked one, a suspended owner (403) and a deleted one (410)", async () => {
		const u = await mk("rl-cut");
		const api = await app.identity.createToken(u.principal, { name: "t", scopes: ["*"] });
		await expect(new FakeComputer(api.token).connect()).rejects.toMatchObject({ status: 401 }); // not a pimc_ token
		await expect(new FakeComputer("pimc_unknown").connect()).rejects.toMatchObject({ status: 401 });
		const { c, token } = await pairAndConnect(u);
		await app.identity.setStatus(admin.principal, u.account.ownerId, "suspended");
		expect(await app.relay.sweep()).toBe(1); // what the Relay holds open for a suspended owner is closed
		await c.waitClosed();
		expect(c.closed!.code).toBe(4003);
		await expect(new FakeComputer(token).connect()).rejects.toMatchObject({ status: 403 });
		await app.identity.setStatus(admin.principal, u.account.ownerId, "active");
		await app.identity.setStatus(admin.principal, u.account.ownerId, "deleted");
		await expect(new FakeComputer(token).connect()).rejects.toMatchObject({ status: 401 }); // its tokens were revoked with it
	});

	it("closes the socket and refuses the token when the person unpairs, and a new pairing replaces the old computer", async () => {
		const u = await mk("rl-unpair");
		const { c, token } = await pairAndConnect(u);
		await app.relay.unpair(u.principal);
		await c.waitClosed();
		await expect(new FakeComputer(token).connect()).rejects.toMatchObject({ status: 401 });
		const second = await pairAndConnect(u);
		const third = await app.relay.pair(u.principal, "desktop", 2);
		await second.c.waitClosed(); // one computer per space
		await expect(new FakeComputer(second.token).connect()).rejects.toMatchObject({ status: 401 });
		expect(third.token).not.toBe(second.token);
	});
});

const wsOpen = (path: string, headers: Record<string, string> = {}) =>
	new Promise<WebSocket>((resolve, reject) => {
		const ws = new WebSocket(`${wsBase}${path}`, { headers });
		ws.once("open", () => resolve(ws));
		ws.once("unexpected-response", (_r, res) => reject(Object.assign(new Error(`HTTP ${res.statusCode}`), { status: res.statusCode })));
		ws.once("error", reject);
	});

describe("the desktop and the browser, relayed", () => {
	it("streams the desktop between the computer and the viewer, isolated from other people's", async () => {
		const u = await mk("rl-screen");
		const other = await mk("rl-screen2");
		await expect(wsOpen("/api/computer/screen", { cookie: u.cookie })).rejects.toMatchObject({ status: 501 }); // no computer: a clean refusal
		const { c } = await pairAndConnect(u);
		c.handlers.set("screen_open", () => ({}));
		c.handlers.set("screen_close", () => ({}));
		c.handlers.set("screen_clipboard", () => "copied text");
		await expect(wsOpen("/api/computer/screen")).rejects.toMatchObject({ status: 401 });
		await expect(wsOpen("/api/computer/screen", { cookie: u.cookie, origin: "https://evil.example" })).rejects.toMatchObject({ status: 403 });
		await expect(wsOpen("/api/computer/screen", { cookie: other.cookie })).rejects.toMatchObject({ status: 501 }); // theirs is not connected
		const viewer = await wsOpen(`/api/computer/screen?token=${u.session}`); // ?token= is what a browser WebSocket may use
		await until(() => c.calls.some((x) => x.op === "screen_open"));
		const channel = c.calls.find((x) => x.op === "screen_open")!.args.channel as number;
		const got: (string | Buffer)[] = [];
		viewer.on("message", (d, bin) => got.push(bin ? (d as Buffer) : d.toString()));
		// Binary video frames carry their channel in the first four bytes; the viewer gets the rest.
		const frame = Buffer.concat([Buffer.alloc(4), Buffer.from("VIDEO")]);
		frame.writeUInt32BE(channel, 0);
		c.ws.send(frame);
		c.ws.send(JSON.stringify({ type: "screen", channel, data: '{"offer":"sdp"}' }));
		await until(() => got.length === 2);
		expect(Buffer.from(got[0] as Buffer).toString()).toBe("VIDEO");
		expect(got[1]).toBe('{"offer":"sdp"}');
		// The viewer's input goes to the stream; its pings and clipboard reads are answered by the Relay itself.
		viewer.send('{"type":"key","k":"a"}');
		await until(() => c.frames.some((f) => f.type === "screen" && f.data === '{"type":"key","k":"a"}'));
		viewer.send('{"type":"pim_ping","payload":{"n":1}}');
		await until(() => got.length === 3);
		viewer.send('{"type":"pim_clipboard"}');
		await until(() => got.length === 4);
		expect(JSON.parse(got[2] as string)).toMatchObject({ type: "pim_pong", payload: { n: 1, computer_ms: expect.any(Number) } });
		expect(JSON.parse(got[3] as string)).toEqual({ type: "pim_clipboard_text", payload: { text: "copied text" } });
		// The computer ending the stream ends the viewer's socket; the viewer leaving closes the stream.
		viewer.close();
		await until(() => c.calls.some((x) => x.op === "screen_close" && x.args.channel === channel));
	});

	it("takes the browser over through DevTools on the computer's cdp channel", async () => {
		const u = await mk("rl-browser");
		const { c } = await pairAndConnect(u);
		const sent: any[] = [];
		c.handlers.set("browser_connect", () => ({ channel: 77 }));
		c.handlers.set("browser_disconnect", () => ({}));
		c.ws.on("message", (data) => {
			const m = JSON.parse(data.toString());
			if (m.type !== "cdp") return;
			const cdp = JSON.parse(m.data);
			sent.push(cdp);
			const answer = (result: unknown) => c.ws.send(JSON.stringify({ type: "cdp", channel: 77, data: JSON.stringify({ id: cdp.id, result }) }));
			if (cdp.method === "Target.getTargets") answer({ targetInfos: [{ type: "page", targetId: "T1" }] });
			else if (cdp.method === "Target.attachToTarget") answer({ sessionId: "S1" });
			else if (cdp.method === "Page.startScreencast") {
				answer({});
				c.ws.send(JSON.stringify({ type: "cdp", channel: 77, data: JSON.stringify({ sessionId: "S1", method: "Page.screencastFrame", params: { data: "JPEGDATA", sessionId: 5, metadata: { deviceWidth: 800, deviceHeight: 600 } } }) }));
				c.ws.send(JSON.stringify({ type: "cdp", channel: 77, data: JSON.stringify({ sessionId: "S1", method: "Page.frameNavigated", params: { frame: { url: "https://example.com/" } } }) }));
			} else if (cdp.method === "Page.getNavigationHistory") answer({ currentIndex: 1, entries: [{ id: 7 }, { id: 8 }] });
			else answer({});
		});
		const viewer = await wsOpen("/api/browser/live?session=chat1", { cookie: u.cookie });
		const got: any[] = [];
		viewer.on("message", (d) => got.push(JSON.parse(d.toString())));
		await until(() => got.length === 2);
		expect(got).toEqual([{ type: "frame", data: "JPEGDATA", width: 800, height: 600 }, { type: "page", url: "https://example.com/", title: "" }]);
		expect(c.calls.find((x) => x.op === "browser_connect")!.args).toEqual({ thread: "chat1" });
		await until(() => sent.some((s) => s.method === "Page.screencastFrameAck" && s.params.sessionId === 5));
		viewer.send(JSON.stringify({ type: "mouse", event: "mousePressed", x: 10, y: 20, button: "left", clickCount: 1 }));
		await until(() => sent.some((s) => s.method === "Input.dispatchMouseEvent"));
		expect(sent.find((s) => s.method === "Input.dispatchMouseEvent")).toMatchObject({ sessionId: "S1", params: { type: "mousePressed", x: 10, y: 20, button: "left", clickCount: 1 } });
		viewer.send(JSON.stringify({ type: "key", event: "keyDown", key: "a", code: "KeyA", text: "a", keyCode: 65 }));
		await until(() => sent.some((s) => s.method === "Input.dispatchKeyEvent"));
		// What the browser screen sends besides the pointer and keys: typed text, an address, and back, forward and reload.
		viewer.send(JSON.stringify({ type: "text", text: "hello" }));
		viewer.send(JSON.stringify({ type: "navigate", url: "https://example.org/" }));
		viewer.send(JSON.stringify({ type: "reload" }));
		await until(() => sent.some((s) => s.method === "Page.reload"));
		expect(sent.find((s) => s.method === "Input.insertText")).toMatchObject({ sessionId: "S1", params: { text: "hello" } });
		expect(sent.find((s) => s.method === "Page.navigate")).toMatchObject({ sessionId: "S1", params: { url: "https://example.org/" } });
		viewer.send(JSON.stringify({ type: "back" }));
		await until(() => sent.some((s) => s.method === "Page.navigateToHistoryEntry"));
		expect(sent.find((s) => s.method === "Page.navigateToHistoryEntry")!.params).toEqual({ entryId: 7 });
		viewer.close();
		await until(() => c.calls.some((x) => x.op === "browser_disconnect"));
	});

	it("takes over the shared browser when the computer has no displayd to give the chat one", async () => {
		const u = await mk("rl-browser-shared");
		const { c } = await pairAndConnect(u);
		c.handlers.set("browser_connect", (args: any) => {
			if (args.thread) throw Object.assign(new Error("no display allocated: displayd is not reachable on this computer"), { code: "ENODISPLAY" });
			return { channel: 78 };
		});
		c.handlers.set("browser_disconnect", () => ({}));
		c.ws.on("message", (data) => {
			const m = JSON.parse(data.toString());
			if (m.type !== "cdp") return;
			const cdp = JSON.parse(m.data);
			const answer = (result: unknown) => c.ws.send(JSON.stringify({ type: "cdp", channel: 78, data: JSON.stringify({ id: cdp.id, result }) }));
			if (cdp.method === "Target.getTargets") answer({ targetInfos: [{ type: "page", targetId: "T1" }] });
			else if (cdp.method === "Target.attachToTarget") answer({ sessionId: "S1" });
			else answer({});
		});
		const viewer = await wsOpen("/api/browser/live?session=chat1", { cookie: u.cookie });
		await until(() => c.calls.filter((x) => x.op === "browser_connect").length === 2);
		expect(c.calls.filter((x) => x.op === "browser_connect").map((x) => x.args)).toEqual([{ thread: "chat1" }, {}]);
		viewer.close();
	});
});

/** A y-websocket-style editor: syncs a Y.Doc over the socket. */
async function editor(ws: WebSocket, doc: Y.Doc) {
	ws.on("message", (data) => {
		const decoder = decoding.createDecoder(new Uint8Array(data as Buffer));
		if (decoding.readVarUint(decoder) !== 0) return;
		const reply = encoding.createEncoder();
		encoding.writeVarUint(reply, 0);
		syncProtocol.readSyncMessage(decoder, reply, doc, "server");
		if (encoding.length(reply) > 1) ws.send(encoding.toUint8Array(reply));
	});
	doc.on("update", (update: Uint8Array, origin: unknown) => {
		if (origin === "server" || ws.readyState !== WebSocket.OPEN) return;
		const enc = encoding.createEncoder();
		encoding.writeVarUint(enc, 0);
		syncProtocol.writeUpdate(enc, update);
		ws.send(encoding.toUint8Array(enc));
	});
	const hello = encoding.createEncoder();
	encoding.writeVarUint(hello, 0);
	syncProtocol.writeSyncStep1(hello, doc);
	ws.send(encoding.toUint8Array(hello));
}

describe("live notes over WebSocket", () => {
	it("syncs editors with each other and with agents' edits, and persists every update through Canvas", async () => {
		const u = await mk("rl-notes");
		const note = await app.canvas.create(u.principal, "n", "Hello");
		const docA = new Y.Doc();
		const docB = new Y.Doc();
		const a = await wsOpen(`/api/notes/live?note=${note}`, { cookie: u.cookie });
		const b = await wsOpen(`/api/notes/live?note=${note}`, { cookie: u.cookie });
		await editor(a, docA);
		await editor(b, docB);
		await until(() => docA.getText("markdown").toString() === "Hello" && docB.getText("markdown").toString() === "Hello");
		// A types at the end; B sees it, and the log has it.
		docA.getText("markdown").insert(5, " world");
		await until(() => docB.getText("markdown").toString() === "Hello world");
		await until(async () => (await app.canvas.read(u.account.ownerId, note)).text === "Hello world");
		// An agent edits at the current version; both open editors receive it, with what B typed meanwhile kept.
		docB.getText("markdown").insert(0, ">> ");
		await until(async () => (await app.canvas.read(u.account.ownerId, note)).text === ">> Hello world");
		const version = await app.canvas.keep(u.account.ownerId, note, "person");
		await app.canvas.edit(u.principal, note, version, "world", "there");
		await until(() => docA.getText("markdown").toString() === ">> Hello there" && docB.getText("markdown").toString() === ">> Hello there");
		expect((await app.canvas.read(u.account.ownerId, note)).text).toBe(">> Hello there");
		// Someone else's note, and a note that is not there, are not opened.
		const other = await mk("rl-notes2");
		const refused = await wsOpen(`/api/notes/live?note=${note}`, { cookie: other.cookie });
		const closed = await new Promise<number>((r) => refused.once("close", (code) => r(code)));
		expect(closed).toBe(4004);
		await expect(wsOpen(`/api/notes/live?note=${note}`)).rejects.toMatchObject({ status: 401 });
		// A suspended person's open editor is cut off at its next write, and that write does not reach the log.
		await app.identity.setStatus(admin.principal, u.account.ownerId, "suspended");
		const closedA = new Promise<number>((r) => a.once("close", (code) => r(code)));
		docA.getText("markdown").insert(0, "SPAM");
		expect(await closedA).toBe(4003);
		expect((await app.canvas.read(u.account.ownerId, note)).text).toBe(">> Hello there");
		b.close();
	});

	it("keeps one version when typing pauses, and one when the note is closed, not one per update", async () => {
		const u = await mk("rl-notes-kept");
		const note = await app.canvas.create(u.principal, "n", "Hi");
		const kept = async () => (await app.canvas.versions(u.account.ownerId, note)).map((v) => v.text);
		app.canvas.pauseMs = 100;
		const doc = new Y.Doc();
		const ws = await wsOpen(`/api/notes/live?note=${note}`, { cookie: u.cookie });
		// The server listens once it has loaded the note; a message sent before that is dropped.
		await new Promise((r) => setTimeout(r, 200));
		await editor(ws, doc);
		await until(() => doc.getText("markdown").toString() === "Hi");
		for (const ch of " you") doc.getText("markdown").insert(doc.getText("markdown").length, ch);
		await until(async () => (await kept()).length === 2);
		expect(await kept()).toEqual(["Hi you", "Hi"]);
		doc.getText("markdown").insert(0, "Oh, ");
		await until(async () => (await app.canvas.read(u.account.ownerId, note)).text === "Oh, Hi you");
		ws.close();
		await until(async () => (await kept()).length === 3);
		expect((await kept())[0]).toBe("Oh, Hi you");
		app.canvas.pauseMs = 5_000;
	});
});

const call = (host: string, path: string, headers: Record<string, string> = {}, method = "GET", body?: string) =>
	new Promise<{ status: number; headers: Record<string, string | string[] | undefined>; body: string }>((resolve, reject) => {
		const port = (server.address() as { port: number }).port;
		const req = httpRequest({ host: "127.0.0.1", port, path, method, headers: { host, ...headers } }, (res) => {
			const chunks: Buffer[] = [];
			res.on("data", (c) => chunks.push(c));
			res.on("end", () => resolve({ status: res.statusCode!, headers: res.headers, body: Buffer.concat(chunks).toString() }));
		});
		req.on("error", reject);
		req.end(body);
	});

const backend = (files: Record<string, string> = {}, access: "owner" | "circles" | "public" = "owner") => ({ title: "Notes", kind: "backend" as const, files: { "pim.app.json": JSON.stringify({ backend: { command: "node server.js" }, access }), "server.js": "x", ...files } });

describe("apps with a backend, through the computer", () => {
	it("deploys only with a person's approval or a standing one, and only where a computer is connected", async () => {
		const u = await mk("rl-deploy");
		const ref = await app.apps.create(u.principal, backend());
		const manifest = { backend: { command: "node server.js" }, access: "owner" };
		const deploy = (p: Principal) => app.relay.deployApp(p, { id: ref.id, version: 1, files: { "server.js": "x" }, manifest });
		const agent: Principal = { kind: "agent", ownerId: OwnerId.parse(u.account.ownerId), agentId: "builder" };
		await expect(deploy(u.principal)).rejects.toMatchObject({ name: "CapabilityUnavailableError", capability: "app_deploy" }); // a person approved by asking, but nothing is connected
		const { c } = await pairAndConnect(u);
		c.handlers.set("app_start", () => ({ running: true }));
		await expect(deploy(agent)).rejects.toMatchObject({ name: "ApprovalRequiredError", action: "app:deploy" });
		expect(await deploy(u.principal)).toEqual({ running: true });
		const start = c.calls.find((x) => x.op === "app_start")!.args;
		expect(start).toMatchObject({ id: ref.id, version: 1, backend: { command: "node server.js" }, env: { PIM_APP_ID: ref.id, PIM_APP_SECRET: app.relay.appSecret(u.account.ownerId, ref.id) } });
		await app.identity.authz.grantStanding(admin.principal, { ownerId: u.account.ownerId, action: "app:deploy", scope: { app: ref.id, access: "owner" } });
		expect(await deploy(agent)).toEqual({ running: true }); // the standing approval stands in for the person
		// Another app's secret is another secret.
		expect(app.relay.appSecret(u.account.ownerId, "other")).not.toBe(app.relay.appSecret(u.account.ownerId, ref.id));
	});

	it("relays a token path to the backend with Pim's rules: no cookies in or out, a policy of its own, and the owner's status", async () => {
		const u = await mk("rl-token");
		const ref = await app.apps.create(u.principal, backend());
		const { path } = await app.apps.openHosted(u.principal, ref.id);
		expect((await call("127.0.0.1", path)).status).toBe(501); // no computer is connected: the page says its backend isn't running
		expect((await call("127.0.0.1", path.replace(/\/[^/]+\/$/, "/bogus/"))).status).toBe(404);
		const { c } = await pairAndConnect(u);
		c.handlers.set("app_http", (a) => ({ status: 200, headers: { "content-type": "application/json", "set-cookie": "sid=1; Path=/", "strict-transport-security": "max-age=1", "content-security-policy": "default-src *" }, body: Buffer.from(JSON.stringify(a)).toString("base64") }));
		const r = await call("127.0.0.1", `${path}api/items?x=1`, { cookie: "pim_session=SECRET; other=1", authorization: "Bearer SECRET", "user-agent": "t", "x-pim-user": "forged", accept: "application/json" }, "POST", "payload");
		expect(r.status).toBe(200);
		const seen = JSON.parse(r.body);
		expect(seen).toMatchObject({ id: ref.id, method: "POST", path: "/api/items?x=1", body: Buffer.from("payload").toString("base64") });
		expect(seen.headers).toEqual({ "user-agent": "t", accept: "application/json", "x-forwarded-prefix": path.replace(/\/$/, "") }); // never Pim's cookies, authorization, or forged x-pim-*
		expect(r.headers["set-cookie"]).toBeUndefined();
		expect(r.headers["strict-transport-security"]).toBeUndefined();
		expect(r.headers["content-security-policy"]).toContain("default-src 'self'");
		expect(r.headers["content-security-policy"]).not.toContain("*");
		// Too-large requests are refused, a hung-up computer is 503, and the owner's status governs.
		expect((await call("127.0.0.1", path, {}, "POST", "x".repeat(1_048_577))).status).toBe(400);
		await app.identity.setStatus(admin.principal, u.account.ownerId, "suspended");
		expect((await call("127.0.0.1", path)).status).toBe(403);
		await app.identity.setStatus(admin.principal, u.account.ownerId, "active");
		expect((await call("127.0.0.1", path)).status).toBe(200);
		await app.identity.setStatus(admin.principal, u.account.ownerId, "deleted");
		expect((await call("127.0.0.1", path)).status).toBe(410); // gone, however the address was reached
	});

	it("serves an app at <label>.<apps origin>: public to anyone, circles only to members after /hosted/enter, owner-only otherwise", async () => {
		const owner = await mk("rl-own");
		const friend = await mk("rl-friend");
		const stranger = await mk("rl-stranger");
		const { c } = await pairAndConnect(owner);
		c.handlers.set("app_http", (a) => ({ status: 200, headers: { "set-cookie": ["a=1; Domain=apps.test; Path=/", "pim_app=hijack"] }, body: Buffer.from(JSON.stringify(a.headers)).toString("base64") }));
		const pub = await app.apps.create(owner.principal, backend({}, "public"));
		const label = (await app.apps.byLabel((await (async () => (await import("../src/apps.ts")).appLabel(owner.account.ownerId, pub.id))())))!;
		expect(label).toMatchObject({ id: pub.id, access: "private" }); // the manifest's access is a statement of intent: sharing is set explicitly
		const host = (await import("../src/apps.ts")).appLabel(owner.account.ownerId, pub.id) + ".apps.test";
		await app.apps.setAccess(owner.principal, pub.id, "public");
		const open = await call(host, "/page?x=1");
		expect(open.status).toBe(200);
		expect(JSON.parse(open.body)).toMatchObject({ "x-forwarded-host": host, "x-forwarded-proto": "http" });
		expect(JSON.parse(open.body)["x-pim-user"]).toBeUndefined(); // nobody known: no identity headers
		expect(open.headers["set-cookie"]).toEqual(["a=1; Path=/"]); // its own cookie kept to its own address; Domain removed; the one Pim keeps dropped
		expect((await call("nobody-here.apps.test", "/")).status).toBe(404);

		// Circles: no cookie sends the visitor to Pim to sign in; Pim answers a signed-in member with a one-minute code that the app trades for its cookie.
		await app.apps.setAccess(owner.principal, pub.id, "circles", [(await app.sharing.createCircle(owner.principal, "Friends")).id]);
		const circle = (await app.sharing.circles(owner.principal))[0]!;
		await app.apps.setAccess(owner.principal, pub.id, "circles", [circle.id]);
		await app.sharing.addMember(owner.principal, circle.id, "rl-friend");
		const anon = await call(host, "/");
		expect(anon.status).toBe(302);
		expect(anon.headers.location).toBe(`http://pim.test/hosted/enter?app=${encodeURIComponent(host.split(".")[0]!)}`);
		const label0 = host.split(".")[0]!;
		const enter = await call("127.0.0.1", `/hosted/enter?app=${label0}`, { cookie: friend.cookie });
		expect(enter.status).toBe(302);
		const to = new URL(enter.headers.location as string);
		expect(to.hostname).toBe(host);
		const code = to.searchParams.get("pim_enter")!;
		const exchanged = await call(host, `/dash?pim_enter=${code}`);
		expect(exchanged.status).toBe(302);
		expect(exchanged.headers.location).toBe("/dash");
		const appCookie = String(exchanged.headers["set-cookie"]).split(";")[0]!;
		expect(String(exchanged.headers["set-cookie"])).toMatch(/HttpOnly; SameSite=Lax/);
		expect((await call(host, `/dash?pim_enter=${code}`)).status).toBe(404); // a code answers once
		const member = await call(host, "/dash", { cookie: `${appCookie}; theme=dark` });
		expect(member.status).toBe(200);
		const headers = JSON.parse(member.body);
		expect(headers).toMatchObject({ "x-pim-user": "rl-friend", "x-pim-user-id": friend.account.ownerId, cookie: "theme=dark" }); // the app's own cookies pass; Pim's does not
		// The signature is the HMAC of <user id>.<time> under the app's own secret, which a backend can check.
		expect(headers["x-pim-signature"]).toBe(createHmac("sha256", app.relay.appSecret(owner.account.ownerId, pub.id)).update(`${friend.account.ownerId}.${headers["x-pim-time"]}`).digest("base64url"));
		// A stranger is not let in; taking the friend out of the circle stops them at their next request.
		expect((await call("127.0.0.1", `/hosted/enter?app=${label0}`, { cookie: stranger.cookie })).status).toBe(404);
		await app.sharing.removeMember(owner.principal, circle.id, friend.account.ownerId);
		expect((await call(host, "/dash", { cookie: appCookie })).status).toBe(404);
		// Back in, but suspended: the app does not run for anyone while its owner is suspended.
		await app.sharing.addMember(owner.principal, circle.id, "rl-friend");
		expect((await call(host, "/dash", { cookie: appCookie })).status).toBe(200);
		await app.identity.setStatus(admin.principal, owner.account.ownerId, "suspended");
		expect((await call(host, "/dash", { cookie: appCookie })).status).toBe(403);
		await app.identity.setStatus(admin.principal, owner.account.ownerId, "active");
		// Guests never open an app.
		await app.identity.setRole(admin.principal, friend.account.ownerId, "guest");
		expect((await call(host, "/dash", { cookie: appCookie })).status).toBe(404);
	});

	it("relays an app's WebSocket through the computer, by token path and at its own address, after the same checks", async () => {
		const u = await mk("rl-appws");
		const ref = await app.apps.create(u.principal, backend());
		const { path } = await app.apps.openHosted(u.principal, ref.id);
		await expect(wsOpen(`${path}socket`)).rejects.toMatchObject({ status: 501 }); // no computer
		const { c } = await pairAndConnect(u);
		c.handlers.set("app_ws_open", () => ({ channel: 9 }));
		c.handlers.set("app_ws_close", () => ({}));
		await expect(wsOpen(`${path.replace(/\/[^/]+\/$/, "/bogus/")}socket`)).rejects.toMatchObject({ status: 404 });
		const ws = await wsOpen(`${path}socket?room=1`);
		await until(() => c.calls.some((x) => x.op === "app_ws_open"));
		expect(c.calls.find((x) => x.op === "app_ws_open")!.args).toMatchObject({ id: ref.id, path: "/socket?room=1", headers: { "x-forwarded-prefix": path.replace(/\/$/, "") } });
		const got: (string | Buffer)[] = [];
		ws.on("message", (d, bin) => got.push(bin ? (d as Buffer) : d.toString()));
		ws.send("hello");
		ws.send(Buffer.from([1, 2, 3]));
		await until(() => c.frames.filter((f) => f.type === "app_ws").length === 2);
		expect(c.frames.filter((f) => f.type === "app_ws")).toEqual([{ type: "app_ws", channel: 9, data: "hello", binary: false }, { type: "app_ws", channel: 9, data: Buffer.from([1, 2, 3]).toString("base64"), binary: true }]);
		c.ws.send(JSON.stringify({ type: "app_ws", channel: 9, data: "pong" }));
		c.ws.send(JSON.stringify({ type: "app_ws", channel: 9, data: Buffer.from("bin").toString("base64"), binary: true }));
		await until(() => got.length === 2);
		expect([got[0], Buffer.from(got[1] as Buffer).toString()]).toEqual(["pong", "bin"]);
		ws.close();
		await until(() => c.calls.some((x) => x.op === "app_ws_close"));
		await app.identity.setStatus(admin.principal, u.account.ownerId, "suspended");
		await expect(wsOpen(`${path}socket`)).rejects.toMatchObject({ status: 403 });
	});
});
