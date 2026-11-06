// These run in Node, not in workerd, because they start real processes: the apps' backends on pim-computer.
import { Buffer } from "node:buffer";
import * as fs from "node:fs/promises";
import * as net from "node:net";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Apps, type AppsOptions, Link, type Machine } from "../computer/pim-computer";

const ID = "0a1b2c3d-0000-4000-8000-000000000001";
const OTHER = "0a1b2c3d-0000-4000-8000-000000000002";

/** A backend: it answers with what it was asked and what it was started with, and has routes for what the tests need it to do. */
const SERVER = `
const http = require("node:http");
const fs = require("node:fs");
const server = http.createServer((req, res) => {
	const chunks = [];
	req.on("data", (chunk) => chunks.push(chunk));
	req.on("end", () => {
		if (req.url === "/big") return res.end(Buffer.alloc(5 * 1024 * 1024, 97));
		if (req.url === "/redirect") return res.writeHead(302, { location: "/elsewhere" }).end();
		if (req.url === "/unlisten") return server.close(() => {}), res.end("closed");
		if (req.url === "/die") process.exit(3);
		res.setHeader("set-cookie", ["a=1; Path=/", "b=2; HttpOnly"]);
		res.setHeader("content-type", "application/json");
		res.end(JSON.stringify({ method: req.method, url: req.url, headers: req.headers, body: Buffer.concat(chunks).toString("base64"), env: process.env, cwd: process.cwd() }));
	});
});
if (process.env.IGNORE_TERM) process.on("SIGTERM", () => {});
server.listen(Number(process.env.PORT), "127.0.0.1", () => {
	console.log("listening " + process.env.PORT);
	if (process.env.DIE_AFTER) setTimeout(() => process.exit(1), Number(process.env.DIE_AFTER));
	// One that crashes once, and stays up when it starts again.
	if (process.env.CRASH_ONCE && !fs.existsSync(process.env.CRASH_ONCE)) {
		fs.writeFileSync(process.env.CRASH_ONCE, "x");
		setTimeout(() => process.exit(1), 300);
	}
});
setInterval(() => {}, 1000);
`;

const node = JSON.stringify(process.execPath);
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function freePort(): Promise<number> {
	return new Promise((resolve) => {
		const server = net.createServer().listen(0, "127.0.0.1", () => {
			const { port } = server.address() as net.AddressInfo;
			server.close(() => resolve(port));
		});
	});
}

const alive = (pid: number) => {
	try {
		process.kill(pid, 0);
		return true;
	} catch {
		return false;
	}
};

async function until<T>(read: () => T | Promise<T>, done: (value: T) => boolean, ms = 10_000): Promise<T> {
	for (const end = Date.now() + ms; ; await sleep(20)) {
		const value = await read();
		if (done(value) || Date.now() > end) return value;
	}
}

type Reply = { result?: any; error?: { message: string; code?: string } };

let root: string;
let apps: Apps;
let call: (op: string, args?: Record<string, unknown>) => Promise<Reply>;

/** A computer with its own supervisor, as pim-computer has, reached over a `Link` as the space does. */
function connect(options: AppsOptions = {}) {
	apps = new Apps(options);
	const machine: Machine = { root, exec: async () => ({ exitCode: 0, signal: null, stdout: "", stderr: "", timedOut: false, truncated: false }), apps };
	const waiting = new Map<string, (reply: Reply) => void>();
	const link = new Link(machine, (message) => {
		const reply = JSON.parse(String(message));
		waiting.get(reply.id)?.(reply);
	});
	let next = 0;
	call = (op, args = {}) =>
		new Promise((resolve) => {
			const id = String(++next);
			waiting.set(id, resolve);
			link.receive(JSON.stringify({ type: "call", id, op, args }));
		});
}

/** A release folder holding the backend, as `/workspace/<name>`. */
async function release(name = "release", server = SERVER) {
	await fs.mkdir(path.join(root, name), { recursive: true });
	await fs.writeFile(path.join(root, name, "server.js"), server);
	return `/workspace/${name}`;
}

async function start(args: Record<string, unknown> = {}) {
	const port = await freePort();
	const reply = await call("app_start", { id: ID, dir: await release(), command: `${node} server.js`, port, ...args });
	return { reply, port };
}

const get = (path = "/", extra: Record<string, unknown> = {}) => call("app_http", { id: ID, method: "GET", path, headers: [], ...extra });
const echoed = (reply: Reply) => JSON.parse(Buffer.from(reply.result.body, "base64").toString("utf8"));

beforeEach(async () => {
	root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "pim-apps-")));
	connect();
});

afterEach(async () => {
	await apps.stopAll();
	await fs.rm(root, { recursive: true, force: true });
});

describe("an app's backend on the computer", () => {
	it("answers a GET and a POST with a body, keeping every set-cookie", async () => {
		const { reply, port } = await start();
		expect(reply.error).toBeUndefined();
		expect(reply.result.state).toBe("running");
		expect(alive(reply.result.pid)).toBe(true);

		const got = await get("/hello?x=1&y=%C3%A9");
		expect(got.result.status).toBe(200);
		const cookies = got.result.headers.filter(([name]: string[]) => name?.toLowerCase() === "set-cookie").map(([, value]: string[]) => value);
		expect(cookies).toEqual(["a=1; Path=/", "b=2; HttpOnly"]);
		expect(echoed(got)).toMatchObject({ method: "GET", url: "/hello?x=1&y=%C3%A9", body: "" });
		expect(echoed(got).headers.host).toBe(`127.0.0.1:${port}`);

		const bytes = Uint8Array.from([0, 255, 10, 13, 128]);
		const posted = await call("app_http", { id: ID, method: "POST", path: "/submit", headers: [["content-type", "application/octet-stream"], ["x-a", "1"], ["x-a", "2"]], body: Buffer.from(bytes).toString("base64") });
		expect(posted.result.status).toBe(200);
		const seen = echoed(posted);
		expect(seen.method).toBe("POST");
		expect([...Buffer.from(seen.body, "base64")]).toEqual([...bytes]);
		expect(seen.headers["x-a"]).toBe("1, 2");
		expect(seen.headers["content-length"]).toBe("5");
	});

	it("doesn't follow redirects, and drops hop-by-hop headers and the caller's host", async () => {
		await start();
		const redirect = await get("/redirect");
		expect(redirect.result.status).toBe(302);
		expect(redirect.result.headers).toContainEqual(["location", "/elsewhere"]);

		const seen = echoed(
			await get("/", {
				headers: [["Host", "evil.example"], ["Connection", "upgrade"], ["Upgrade", "websocket"], ["Proxy-Authorization", "x"], ["TE", "trailers"], ["Keep-Alive", "5"], ["X-Kept", "yes"]],
			}),
		);
		expect(seen.headers["x-kept"]).toBe("yes");
		for (const name of ["upgrade", "proxy-authorization", "te", "keep-alive"]) expect(seen.headers[name]).toBeUndefined();
		expect(seen.headers.host).toMatch(/^127\.0\.0\.1:\d+$/);
		expect(seen.headers.connection).not.toMatch(/upgrade/);
	});

	it("gives the app PORT, PIM_APP_ID, PIM_APP_DATA and PIM_WORKSPACE, and its folder as the working directory, and doesn't let env override the first three", async () => {
		const { port } = await start({ env: { MINE: "yes", PORT: "1", PIM_APP_ID: "x", PIM_APP_DATA: "/tmp/elsewhere", PIM_WORKSPACE: "/custom" } });
		const { env, cwd } = echoed(await get());
		expect(env.PORT).toBe(String(port));
		expect(env.PIM_APP_ID).toBe(ID);
		expect(env.PIM_APP_DATA).toBe(path.join(root, ".pim", "apps", ID, "data"));
		expect((await fs.stat(env.PIM_APP_DATA)).isDirectory()).toBe(true);
		expect(env.MINE).toBe("yes");
		expect(env.PIM_WORKSPACE).toBe("/custom");
		expect(cwd).toBe(path.join(root, "release"));
	});

	it("keeps data where it's told, and the workspace as $PIM_WORKSPACE", async () => {
		await start({ data: "/workspace/mydata/here" });
		const { env } = echoed(await get());
		expect(env.PIM_APP_DATA).toBe(path.join(root, "mydata", "here"));
		expect(env.PIM_WORKSPACE).toBe(root);
	});

	it("runs install first, in the folder, and refuses to start when it fails, with its output", async () => {
		const dir = await release();
		const ok = await start({ dir, install: `echo installed > marker.txt` });
		expect(ok.reply.error).toBeUndefined();
		expect(await fs.readFile(path.join(root, "release", "marker.txt"), "utf8")).toBe("installed\n");
		// The app started after the install: the file was there to read.
		expect((await get()).result.status).toBe(200);

		const bad = await start({ dir, install: "echo out-text; echo err-text >&2; exit 7", command: `echo should-not-run > ran.txt; ${node} server.js` });
		expect(bad.reply.error?.message).toContain("exit code 7");
		expect(bad.reply.error?.message).toContain("out-text");
		expect(bad.reply.error?.message).toContain("err-text");
		await expect(fs.stat(path.join(root, "release", "ran.txt"))).rejects.toThrow();
		// The app it replaced was stopped first.
		expect((await get()).error?.code).toBe("ENOTRUNNING");
	});

	it("fails a start whose process exits first, or never listens, with what it printed, and leaves nothing running", async () => {
		const exited = await start({ command: "echo boom-text; exit 2" });
		expect(exited.reply.error?.message).toContain("boom-text");
		expect((await call("app_status", { id: ID })).result.apps[0].state).toBe("failed");

		connect({ readyMs: 600, pollMs: 20 });
		const silent = await start({ command: `echo $$ > pid.txt; echo waiting-text; exec sleep 300` });
		expect(silent.reply.error?.message).toContain("waiting-text");
		expect(silent.reply.error?.message).toContain("didn't listen");
		const pid = Number(await fs.readFile(path.join(root, "release", "pid.txt"), "utf8"));
		expect(await until(() => alive(pid), (up) => !up)).toBe(false);
	});

	it("restarts one that crashes, counting the restarts, and gives up on one that keeps dying", async () => {
		connect({ backoffMs: 20, maxBackoffMs: 40, pollMs: 20 });
		const marker = path.join(root, "crashed-once");
		const { reply } = await start({ env: { CRASH_ONCE: marker } });
		const first = reply.result.pid;
		const status = await until(
			async () => (await call("app_status", { id: ID })).result.apps[0],
			(app) => app.restarts === 1 && app.state === "running",
		);
		expect(status).toMatchObject({ state: "running", restarts: 1 });
		expect(status.pid).not.toBe(first);
		expect(alive(first)).toBe(false);
		expect((await get()).result.status).toBe(200);

		const failing = await start({ env: { DIE_AFTER: "100" } });
		expect(failing.reply.error).toBeUndefined();
		const gaveUp = await until(
			async () => (await call("app_status", { id: ID })).result.apps[0],
			(app) => app.state === "failed",
			20_000,
		);
		expect(gaveUp).toMatchObject({ state: "failed", restarts: 8, pid: null, port: failing.port });
		expect(gaveUp.since).toBeGreaterThan(Date.now() - 20_000);
		expect((await get()).error?.code).toBe("ENOTRUNNING");
		expect((await get()).error?.message).toContain("failed");
	}, 30_000);

	it("doesn't give up on one whose runs are long enough, however often it restarts", async () => {
		connect({ backoffMs: 5, maxBackoffMs: 5, stableMs: 1, pollMs: 20 });
		await start({ env: { DIE_AFTER: "150" } });
		const app = await until(
			async () => (await call("app_status", { id: ID })).result.apps[0],
			(app) => app.restarts >= 11 || app.state === "failed",
			20_000,
		);
		expect(app.restarts).toBeGreaterThanOrEqual(11);
		expect(app.state).not.toBe("failed");
	}, 30_000);

	it("doubles its wait between restarts, up to a cap", async () => {
		connect({ backoffMs: 600, maxBackoffMs: 700, pollMs: 20 });
		await start({ env: { DIE_AFTER: "50" } });
		const times: number[] = [];
		let last = 0;
		await until(
			async () => (await call("app_status", { id: ID })).result.apps[0],
			(app) => {
				if (app.restarts !== last) {
					last = app.restarts;
					times.push(Date.now());
				}
				return app.restarts >= 3;
			},
			10_000,
		);
		// The gaps are the waits (600, then 700 as 1200 is capped), plus the time the app lived and whatever a slow machine adds.
		expect(times[1]! - times[0]!).toBeGreaterThanOrEqual(590);
		expect(times[2]! - times[1]!).toBeGreaterThanOrEqual(690);
		expect(times[2]! - times[1]!).toBeLessThan(1150);
	}, 15_000);

	it("stops the whole process group, children included, and then refuses requests", async () => {
		const { reply } = await start({ command: `sleep 300 & echo $! > child.pid; ${node} server.js` });
		const pid = reply.result.pid;
		const child = Number(await fs.readFile(path.join(root, "release", "child.pid"), "utf8"));
		expect(alive(child)).toBe(true);

		expect((await call("app_stop", { id: ID })).result).toEqual({ state: "stopped" });
		expect(alive(pid)).toBe(false);
		expect(alive(child)).toBe(false);
		const status = (await call("app_status", { id: ID })).result.apps[0];
		expect(status).toMatchObject({ state: "stopped", pid: null });
		const refused = await get();
		expect(refused.error?.code).toBe("ENOTRUNNING");
		expect(refused.error?.message).toContain("stopped");
		// Stopped stays stopped: nothing restarts it.
		await sleep(1_500);
		expect((await call("app_status", { id: ID })).result.apps[0]).toMatchObject({ state: "stopped", restarts: 0 });
		// Stopping what isn't running is fine.
		expect((await call("app_stop", { id: ID })).error).toBeUndefined();
		expect((await call("app_stop", { id: OTHER })).error).toBeUndefined();
	});

	it("kills what ignores SIGTERM once the time to end is up", async () => {
		connect({ killMs: 400, pollMs: 20 });
		const { reply } = await start({ env: { IGNORE_TERM: "1" } });
		const began = Date.now();
		await call("app_stop", { id: ID });
		expect(Date.now() - began).toBeGreaterThanOrEqual(350);
		expect(await until(() => alive(reply.result.pid), (up) => !up)).toBe(false);
	});

	it("replaces an app started again under the same id", async () => {
		const first = (await start()).reply.result.pid;
		const second = await start();
		expect(second.reply.result.pid).not.toBe(first);
		expect(alive(first)).toBe(false);
		expect((await call("app_status", {})).result.apps).toHaveLength(1);
		expect(echoed(await get()).env.PORT).toBe(String(second.port));
	});

	it("lists every app, or one", async () => {
		await start();
		const second = await freePort();
		await call("app_start", { id: OTHER, dir: await release(), command: `${node} server.js`, port: second });
		const all = (await call("app_status", {})).result.apps;
		expect(all.map((app: { id: string }) => app.id).sort()).toEqual([ID, OTHER]);
		expect((await call("app_status", { id: OTHER })).result.apps).toEqual([expect.objectContaining({ id: OTHER, state: "running", port: second, restarts: 0 })]);
		expect((await call("app_status", { id: "0a1b2c3d-0000-4000-8000-0000000000ff" })).result.apps).toEqual([]);
	});

	it("refuses folders outside /workspace, links out of it, and bad arguments", async () => {
		const port = await freePort();
		const good = { id: ID, dir: await release(), command: "true", port };
		const refused = async (change: Record<string, unknown>, code: string) => expect((await call("app_start", { ...good, ...change })).error?.code).toBe(code);
		await refused({ dir: "/workspace/../etc" }, "EACCES");
		await refused({ dir: "/etc" }, "EACCES");
		await refused({ dir: "release" }, "EINVAL");
		await refused({ dir: "/workspace/missing" }, "ENOENT");
		await refused({ data: "/workspace/../tmp/x" }, "EACCES");
		await fs.symlink(os.tmpdir(), path.join(root, "out"));
		await refused({ dir: "/workspace/out" }, "EACCES");
		await refused({ id: "../x" }, "EINVAL");
		await refused({ id: "short" }, "EINVAL");
		await refused({ id: undefined }, "EINVAL");
		await refused({ port: 80 }, "EINVAL");
		await refused({ port: 65536 }, "EINVAL");
		await refused({ port: 8080.5 }, "EINVAL");
		await refused({ port: "8080" }, "EINVAL");
		await refused({ command: "" }, "EINVAL");
		await refused({ env: { A: 1 } }, "EINVAL");
		await refused({ env: "A=1" }, "EINVAL");
		expect((await call("app_status", {})).result.apps).toEqual([]);
		expect((await call("app_stop", { id: "x" })).error?.code).toBe("EINVAL");
		expect((await call("app_logs", { id: "x" })).error?.code).toBe("EINVAL");
		expect((await call("app_http", { id: "x", method: "GET", path: "/", headers: [] })).error?.code).toBe("EINVAL");
	});

	it("refuses requests that are malformed, or too big, and answers EFBIG to a response that's too big", async () => {
		await start();
		const refused = async (change: Record<string, unknown>, code: string) => expect((await get("/", change)).error?.code).toBe(code);
		await refused({ method: "get" }, "EINVAL");
		await refused({ method: "GET /x HTTP/1.1\r\nX:" }, "EINVAL");
		await refused({ path: "x" }, "EINVAL");
		await refused({ path: "/a b" }, "EINVAL");
		await refused({ headers: [["a"]] }, "EINVAL");
		await refused({ headers: [["a", 1]] }, "EINVAL");
		await refused({ headers: "a: b" }, "EINVAL");
		await refused({ body: 5 }, "EINVAL");
		await refused({ headers: [["bad name", "x"]] }, "EINVAL");
		expect((await get(`/${"a".repeat(8_192)}`)).error?.code).toBe("EINVAL");

		const tooBig = Buffer.alloc(1_048_576 + 1).toString("base64");
		expect((await get("/", { method: "POST", body: tooBig })).error?.code).toBe("EFBIG");
		const largest = await get("/", { method: "POST", body: Buffer.alloc(1_048_576, 98).toString("base64") });
		expect(Buffer.from(echoed(largest).body, "base64").toString()).toBe("b".repeat(1_048_576));
		expect((await get(`/${"a".repeat(8_191)}`)).result.status).toBe(200);

		expect((await get("/big")).error?.code).toBe("EFBIG");
		// The app is fine after.
		expect((await get()).result.status).toBe(200);
	});

	it("answers ECONNREFUSED when a running app has closed its port", async () => {
		await start();
		expect((await get("/unlisten")).result.status).toBe(200);
		const refused = await get();
		expect(refused.error?.code).toBe("ECONNREFUSED");
	});

	it("shows an app that's marked crashed while it waits to restart", async () => {
		connect({ backoffMs: 1_500, maxBackoffMs: 1_500, pollMs: 20 });
		await start();
		await get("/die").catch(() => {});
		const app = await until(
			async () => (await call("app_status", { id: ID })).result.apps[0],
			(app) => app.state === "crashed",
		);
		expect(app).toMatchObject({ state: "crashed", pid: null });
		expect((await get()).error?.code).toBe("ENOTRUNNING");
		expect((await get()).error?.message).toContain("crashed");
	});

	it("gives the end of its output, from its stdout and stderr together, at most 64,000 bytes", async () => {
		await start({ command: `echo first-line; echo err-line >&2; head -c 300000 /dev/zero | tr '\\0' 'z'; echo; echo last-line; ${node} server.js` });
		// The port can accept connections a moment before the app's "listening" line reaches the log.
		const logs = await until(
			async () => (await call("app_logs", { id: ID })).result.text as string,
			(text) => text.includes("listening"),
		);
		expect(logs.length).toBeLessThanOrEqual(16_000);
		expect(logs).toContain("last-line");
		expect(logs).toContain("listening");
		expect(logs).not.toContain("first-line");

		const small = (await call("app_logs", { id: ID, bytes: 30 })).result.text as string;
		expect(small).toHaveLength(30);
		expect(logs.endsWith(small)).toBe(true);
		expect(((await call("app_logs", { id: ID, bytes: 1_000_000 })).result.text as string).length).toBe(64_000);
		expect((await call("app_logs", { id: OTHER })).error?.code).toBe("ENOENT");
	});

	it("shows the output of both streams in order, and keeps it after the app stopped", async () => {
		await start({ command: `echo one; echo two >&2; ${node} server.js` });
		await call("app_stop", { id: ID });
		const text = (await call("app_logs", { id: ID })).result.text as string;
		expect(text).toMatch(/one\ntwo\n/);
	});

	it("is not in every machine: one without a supervisor says so", async () => {
		const machine: Machine = { root, exec: async () => ({ exitCode: 0, signal: null, stdout: "", stderr: "", timedOut: false, truncated: false }) };
		let reply: Reply = {};
		const link = new Link(machine, (message) => (reply = JSON.parse(String(message))));
		link.receive(JSON.stringify({ type: "call", id: "1", op: "app_status", args: {} }));
		await until(() => reply, (value) => value.error !== undefined, 1_000);
		expect(reply.error?.code).toBe("ENOSYS");
	});

	it("keeps running when its link closes", async () => {
		const machine: Machine = { root, exec: async () => ({ exitCode: 0, signal: null, stdout: "", stderr: "", timedOut: false, truncated: false }), apps };
		const link = new Link(machine, () => {});
		const { reply } = await start();
		link.close();
		expect(alive(reply.result.pid)).toBe(true);
		expect((await get()).result.status).toBe(200);
	});
});
