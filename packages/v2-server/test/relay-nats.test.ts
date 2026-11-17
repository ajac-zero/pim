// The Relay across processes: a personal computer's socket is held by one process (a `relay` container), and a Gate in another process, with no
// connection of its own, serves `/hosted/*` and calls the computer for a Runner, through NATS. Two real processes (their own HTTP servers), real
// PostgreSQL (the shared stack) and a real nats-server; the computer is a software `pim-computer`.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { WebSocket } from "ws";
import { App } from "@pim/v2-app/app";
import { connect as connectApp } from "@pim/v2-app/db";
import { MemoryObjectStore } from "@pim/v2-app/objects";
import { OwnerId, type Principal } from "@pim/v2-contracts/identity";
import { NatsPulse } from "@pim/v2-live/server/pulse";
import { startProcess, type Process } from "../src/main.ts";
import { acquireRemote, natsRelayBus, relaySubjects } from "../src/relay-bus.ts";
import { type Deployment, base, envFor, start, startS3 } from "./support/processes.ts";
import { createStack, describeWith, freePort, hasNats, startNats } from "./support/stack.ts";

const real = describeWith(hasNats());
const INGRESS = "ingress";

async function until<T>(what: string, fn: () => T | undefined | false | Promise<T | undefined | false>, ms = 10_000): Promise<T> {
	const end = Date.now() + ms;
	for (;;) {
		const value = await fn();
		if (value) return value;
		if (Date.now() > end) throw new Error(`Timed out waiting for ${what}`);
		await new Promise((r) => setTimeout(r, 25));
	}
}

/** A software pim-computer: connects with its token to one process, says hello, answers calls from `handlers`, and records what it was asked and sent. */
class FakeComputer {
	readonly calls: { op: string; args: any }[] = [];
	readonly frames: any[] = [];
	readonly binary: Buffer[] = [];
	closed: { code: number } | null = null;
	readonly handlers = new Map<string, (args: any) => unknown>();
	ws!: WebSocket;
	constructor(
		private readonly port: number,
		private readonly token: string,
		readonly name = "box",
	) {}

	async connect(): Promise<this> {
		this.ws = new WebSocket(`ws://127.0.0.1:${this.port}/api/computer/connect`, { headers: { Authorization: `Bearer ${this.token}`, "x-pim-ingress-secret": INGRESS } });
		this.ws.on("message", (data, isBinary) => {
			if (isBinary) return void this.binary.push(data as Buffer);
			const m = JSON.parse(data.toString());
			this.frames.push(m);
			if (m.type !== "call") return;
			this.calls.push({ op: m.op, args: m.args });
			const handler = this.handlers.get(m.op);
			try {
				if (!handler && !["unwatch_all", "ping"].includes(m.op)) return this.ws.send(JSON.stringify({ type: "reply", id: m.id, error: { message: `unknown op ${m.op}`, code: "EUNKNOWN" } }));
				this.ws.send(JSON.stringify({ type: "reply", id: m.id, result: handler ? handler(m.args) : {} }));
			} catch (error) {
				this.ws.send(JSON.stringify({ type: "reply", id: m.id, error: { message: (error as Error).message, ...(error as { remote?: object }).remote } }));
			}
		});
		this.ws.on("close", (code) => (this.closed = { code }));
		await new Promise<void>((resolve, reject) => (this.ws.once("open", () => resolve()), this.ws.once("error", reject)));
		this.ws.send(JSON.stringify({ type: "hello", agent: "pim-computer", hostname: this.name, platform: "linux", arch: "x64", user: "me", root: "/home/me", browser: "/usr/bin/chrome", screen: true, desktop: false, version: 2 }));
		return this;
	}
}

const MESSAGE = (code: number) => (c: { closed: { code: number } | null }) => c.closed?.code === code;

real("the Relay across processes, over NATS", () => {
	let d: Deployment;
	let gate: Process; // serves the people's requests, and holds no computer
	let relay: Process; // the `relay` container: the computer connects here
	let pulse: NatsPulse; // a Runner's connection to the bus
	let admin: App;
	let principal: Principal;
	let ownerId: string;
	let token: string;
	let appId: string;
	let hostedPath: string;
	const everyone: Process[] = [];
	const computers: FakeComputer[] = [];
	const connect = async (port: number, name?: string) => {
		const c = await new FakeComputer(port, token, name).connect();
		computers.push(c);
		return c;
	};

	beforeAll(async () => {
		const stack = await createStack();
		d = { stack, nats: await startNats(), s3: await startS3(), gatePort: await freePort(), ingressSecret: INGRESS };
		admin = new App(connectApp(stack.url("gate"), 4), new MemoryObjectStore());
		gate = await start(d, "gate");
		relay = await startProcess("relay", envFor(d, "gate", { PIM_HTTP_PORT: "0" }));
		everyone.push(gate, relay);
		pulse = await NatsPulse.connect(d.nats.url);
		const claim = await admin.identity.issueClaim("bootstrap", null, 3_600_000);
		const account = await admin.identity.register({ username: "ada", bootstrap: claim });
		ownerId = account.ownerId;
		principal = { kind: "user", ownerId: OwnerId.parse(ownerId), role: "admin", sessionId: "ada-session" };
		token = (await admin.relay.pair(principal, "laptop", 2)).token;
		appId = (await admin.apps.create(principal, { title: "Notes", kind: "backend", files: { "pim.app.json": JSON.stringify({ backend: { command: "node server.js" }, access: "owner" }), "server.js": "x" } })).id;
		hostedPath = (await admin.apps.openHosted(principal, appId)).path;
	}, 180_000);
	afterAll(async () => {
		for (const c of computers) c.ws?.terminate();
		await pulse?.close();
		await Promise.allSettled(everyone.map((p) => p.close()));
		await admin?.db.end();
		d?.nats.stop();
		await d?.s3.stop();
		await d?.stack.drop();
	}, 60_000);

	const http = (path: string, init: RequestInit = {}) => fetch(`${base(gate)}${path}`, { redirect: "manual", ...init, headers: { "x-pim-ingress-secret": INGRESS, ...(init.headers as object) } });
	const bus = () => natsRelayBus(pulse);
	const remote = (capability = "files") => acquireRemote(bus(), ownerId, capability);

	it("says so cleanly while no process holds a computer: a hosted app is 501, a Runner's call is CapabilityUnavailableError, a socket is refused", async () => {
		expect((await http(hostedPath)).status).toBe(501);
		await expect(remote("shell")).rejects.toMatchObject({ name: "CapabilityUnavailableError", capability: "shell" });
		const refused = await new Promise<number>((resolve) => {
			const ws = new WebSocket(`ws://127.0.0.1:${gate.host.port}${hostedPath}socket`, { headers: { "x-pim-ingress-secret": INGRESS } });
			ws.on("unexpected-response", (_req, res) => resolve(res.statusCode ?? 0));
			ws.on("error", () => undefined);
		});
		expect(refused).toBe(501);
		expect(relaySubjects.rpc(ownerId)).toBe(`pim.v2.relay.${ownerId}.rpc`);
	});

	it("relays a hosted app's HTTP request from the Gate to the computer on the relay process, under the same rules as in one process", async () => {
		const first = await connect(relay.host.port, "on-relay");
		first.handlers.set("app_http", (a) => ({ status: 201, headers: { "content-type": "application/json", "set-cookie": "sid=1", "content-security-policy": "default-src *" }, body: Buffer.from(JSON.stringify(a)).toString("base64") }));
		const response = await until("the gate to reach the computer", async () => {
			const r = await http(`${hostedPath}api/items?x=1`, { method: "POST", body: "payload", headers: { cookie: "pim_session=SECRET", "x-pim-user": "forged", accept: "application/json" } });
			return r.status === 501 ? undefined : r;
		});
		expect(response.status).toBe(201);
		const seen = JSON.parse(await response.text());
		expect(seen).toMatchObject({ id: appId, method: "POST", path: "/api/items?x=1", body: Buffer.from("payload").toString("base64") });
		expect(Object.keys(seen.headers)).toEqual(expect.arrayContaining(["accept", "x-forwarded-prefix"]));
		expect(Object.keys(seen.headers).filter((h) => /cookie|authorization|^x-pim-/.test(h))).toEqual([]); // never Pim's cookie or a forged x-pim-*
		expect(response.headers.get("set-cookie")).toBeNull();
		expect(response.headers.get("content-security-policy")).toContain("default-src 'self'");
		// The call went to the computer on the relay process, not to a connection of the Gate's own.
		expect(first.calls.map((c) => c.op)).toContain("app_http");
		expect(gate.roles.length).toBe(1);
	});

	it("relays a hosted app's WebSocket, text and binary, in both directions", async () => {
		const c = computers[0]!;
		c.handlers.set("app_ws_open", () => ({ channel: 9 }));
		c.handlers.set("app_ws_close", () => ({}));
		const ws = new WebSocket(`ws://127.0.0.1:${gate.host.port}${hostedPath}socket?room=1`, { headers: { "x-pim-ingress-secret": INGRESS } });
		const got: (string | Buffer)[] = [];
		ws.on("message", (data, isBinary) => got.push(isBinary ? (data as Buffer) : data.toString()));
		await new Promise<void>((resolve, reject) => (ws.once("open", () => resolve()), ws.once("error", reject)));
		await until("the computer to be asked to open it", () => c.calls.find((x) => x.op === "app_ws_open"));
		expect(c.calls.find((x) => x.op === "app_ws_open")!.args).toMatchObject({ id: appId, path: "/socket?room=1" });
		ws.send("hello");
		ws.send(Buffer.from([1, 2, 3]));
		await until("both frames to reach the computer", () => c.frames.filter((f) => f.type === "app_ws").length === 2);
		expect(c.frames.filter((f) => f.type === "app_ws")).toEqual([
			{ type: "app_ws", channel: 9, data: "hello", binary: false },
			{ type: "app_ws", channel: 9, data: Buffer.from([1, 2, 3]).toString("base64"), binary: true },
		]);
		c.ws.send(JSON.stringify({ type: "app_ws", channel: 9, data: "pong" }));
		c.ws.send(JSON.stringify({ type: "app_ws", channel: 9, data: Buffer.from("bin").toString("base64"), binary: true }));
		await until("both answers to reach the viewer", () => got.length === 2);
		expect([got[0], Buffer.from(got[1] as Buffer).toString()]).toEqual(["pong", "bin"]);
		ws.close();
		await until("the computer to be told it closed", () => c.calls.some((x) => x.op === "app_ws_close"));
	});

	it("runs a Runner's computer calls across processes: results, the computer's own errors, timeouts, and file watches", async () => {
		const c = computers[0]!;
		const files = await remote("files");
		expect(files.info).toMatchObject({ hostname: "on-relay", protocol: 2, root: "/home/me" });
		c.handlers.set("file_read", (a) => ({ content: `contents of ${a.path}`, sha256: "abc" }));
		expect(await files.call("file_read", { path: "/a.txt" })).toEqual({ content: "contents of /a.txt", sha256: "abc" });
		c.handlers.set("shell", (a) => ({ stdout: `ran ${a.command}`, code: 0 }));
		expect(await files.call("shell", { command: "ls" })).toEqual({ stdout: "ran ls", code: 0 });
		// The computer's refusal keeps its code.
		c.handlers.set("file_write", () => {
			throw Object.assign(new Error("The file changed"), { remote: { code: "hash_mismatch", currentHash: "def" } });
		});
		await expect(files.call("file_write", { path: "/a.txt", expectedHash: "abc" })).rejects.toMatchObject({ status: 502, remote: { code: "hash_mismatch", currentHash: "def" } });
		// A call the computer never answers fails at its own timeout.
		c.handlers.set("hang", () => {
			throw new Error("unused");
		});
		const quiet = c.ws.listeners("message")[0] as (...args: unknown[]) => void;
		c.ws.removeAllListeners("message");
		await expect(files.call("hang", {}, 150)).rejects.toMatchObject({ status: 504 });
		c.ws.on("message", quiet as never);
		// A watch is counted on the computer's own process; its events reach the one that asked.
		c.handlers.set("watch", (a) => ({ exists: true, sha256: "s", size: 1, path: a.path }));
		const events: any[] = [];
		const stop = files.onFileEvent((e) => events.push(e));
		await files.watch("/notes.md");
		c.ws.send(JSON.stringify({ type: "event", event: "file_changed", path: "/notes.md", kind: "modified" }));
		await until("the file event to cross", () => events.length === 1);
		expect(events[0]).toMatchObject({ event: "file_changed", path: "/notes.md", kind: "modified" });
		stop();
		expect(await files.unwatch("/notes.md")).toBe(false);
		expect(await files.ping()).not.toBeNull();
	});

	it("streams the desktop and the browser across processes: frames down, input up, and the computer is told when a viewer leaves", async () => {
		const c = computers[0]!;
		const files = await remote("desktop_screen");
		c.handlers.set("screen_open", () => ({}));
		c.handlers.set("screen_close", () => ({}));
		const screen: (string | Uint8Array | null)[] = [];
		await files.openScreen(77, (data) => screen.push(data));
		c.ws.send(JSON.stringify({ type: "screen", channel: 77, data: "hello-frame" }));
		const video = Buffer.alloc(8);
		video.writeUInt32BE(77, 0);
		video.set([5, 6, 7, 8], 4);
		c.ws.send(video);
		await until("both frames", () => screen.length === 2);
		expect(screen[0]).toBe("hello-frame");
		expect([...(screen[1] as Uint8Array)]).toEqual([5, 6, 7, 8]);
		files.screenInput(77, '{"type":"mouse"}');
		await until("the input to reach the computer", () => c.frames.some((f) => f.type === "screen" && f.data === '{"type":"mouse"}'));
		files.closeScreen(77);
		await until("the computer to be told", () => c.calls.some((x) => x.op === "screen_close" && x.args.channel === 77));
		// A browser: its DevTools messages go both ways on a channel of the computer's choosing.
		c.handlers.set("browser_connect", () => ({ channel: 5 }));
		c.handlers.set("browser_disconnect", () => ({}));
		const cdp: (string | null)[] = [];
		const browser = await (await remote("browser_live")).openBrowser((data) => cdp.push(data));
		c.ws.send(JSON.stringify({ type: "cdp", channel: 5, data: '{"id":1}' }));
		await until("a DevTools message", () => cdp.length === 1);
		expect(cdp[0]).toBe('{"id":1}');
		browser.send('{"method":"Page.enable"}');
		await until("the message to reach the browser", () => c.frames.some((f) => f.type === "cdp" && f.data === '{"method":"Page.enable"}'));
		// The computer ends the stream: the viewer hears it end.
		c.ws.send(JSON.stringify({ type: "cdp_closed", channel: 5 }));
		await until("the end", () => cdp.at(-1) === null);
	});

	it("closes the older connection with 4409 when the computer connects to another process, and calls follow the newer", async () => {
		const older = computers[0]!;
		const newer = await connect(gate.host.port, "on-gate");
		await until("the relay's connection to be replaced", () => MESSAGE(4409)(older));
		newer.handlers.set("file_read", () => ({ content: "from the gate's own socket", sha256: "z" }));
		const files = await until("the call to follow the new connection", async () => {
			const f = await remote().catch(() => undefined);
			return f?.info?.hostname === "on-gate" ? f : undefined;
		});
		expect(await files.call("file_read", { path: "/x" })).toEqual({ content: "from the gate's own socket", sha256: "z" });
		// Now it is the gate that holds the socket, and the relay process that asks it: a hosted request on the relay process reaches it.
		newer.handlers.set("app_http", () => ({ status: 200, headers: {}, body: Buffer.from("served from the gate's socket").toString("base64") }));
		const r = await fetch(`${base(relay)}${hostedPath}`, { headers: { "x-pim-ingress-secret": INGRESS } });
		expect(r.status).toBe(200);
		expect(await r.text()).toBe("served from the gate's socket");
		expect(newer.closed).toBeNull();
	});

	it("does not close a connection newer than the announcement, and the replaced computer reconnecting wins in turn", async () => {
		const back = await connect(relay.host.port, "back-on-relay");
		await until("the gate's connection to be replaced", () => MESSAGE(4409)(computers[1]!));
		expect(back.closed).toBeNull();
		await until("calls to reach the relay again", async () => ((await remote().catch(() => undefined))?.info?.hostname === "back-on-relay" ? true : undefined));
	});

	it("is a clean CapabilityUnavailableError again once the computer disconnects, and its streams end", async () => {
		const c = computers.at(-1)!;
		c.handlers.set("screen_open", () => ({}));
		const ended: (string | Uint8Array | null)[] = [];
		const files = await remote("desktop_screen");
		await files.openScreen(3, (data) => ended.push(data));
		c.ws.close();
		await until("the viewer's stream to end", () => ended.at(-1) === null);
		await until("no process to hold it", async () => (await remote("shell").then(() => false, (e) => e.name === "CapabilityUnavailableError")) || undefined);
		await expect(remote("shell")).rejects.toMatchObject({ name: "CapabilityUnavailableError" });
		expect((await http(hostedPath)).status).toBe(501);
		await expect(files.call("file_read", { path: "/a" })).rejects.toMatchObject({ name: "CapabilityUnavailableError" });
	});
});
