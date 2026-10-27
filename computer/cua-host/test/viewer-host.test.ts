/**
 * The bridge's viewer side: the Node host's routes to a viewer
 * (../host.ts `ViewerRoutes`) and the viewer host's own pieces
 * (../viewer-host.ts). What stands in: the launch manager and the adapter
 * in the routing tests, which are recorders; spacesd in the viewer host
 * tests, which is a `fetch` and a `openMedia` that fail the test if they
 * are called; and every file, which is in memory (./fake-journal-files.ts).
 * The routing tests serve plain HTTP on 127.0.0.1 in this process and talk to
 * it with `node:http` and `ws`; no certificate, no other process, nothing
 * leaves the machine. No desktop, spacesd, browser or Pim is involved.
 */

import assert from "node:assert/strict";
import * as http from "node:http";
import { after, describe, it } from "node:test";
import { WebSocket } from "ws";
import { Relay } from "../../cua-bridge.ts";
import { createHost, type Host, type ViewerRoutes } from "../host.ts";
import { checkedOrigin, createViewerHost, MAX_ROOT_TOKEN_BYTES, readRootToken } from "../viewer-host.ts";
import type { MediaEvents, MediaSocket, MediaUpgrade } from "../viewer-adapter.ts";
import { FakeFiles, OWNER_UID } from "./fake-journal-files.ts";

const SPACE = "o_0123456789abcdefghijklmnop";
const OTHER = "o_zyxwvutsrqponmlkjihgfedcba";
const TOKEN = "viewer-routes-test-token-0123456789abcdef";
const LAUNCH = "AAAAAAAAAAAAAAAAAAAAAA";
const ATTACH = "B".repeat(43);
const CREDENTIAL = "C".repeat(43);

type Reply = { status: number; headers: http.IncomingHttpHeaders; body: string };

function request(port: number, options: { method?: string; path: string; headers?: Record<string, string>; body?: string }): Promise<Reply> {
	return new Promise((resolve, reject) => {
		const req = http.request({ host: "127.0.0.1", port, method: options.method ?? "GET", path: options.path, headers: options.headers }, (res) => {
			const chunks: Buffer[] = [];
			res.on("data", (chunk: Buffer) => chunks.push(chunk));
			res.on("end", () => resolve({ status: res.statusCode ?? 0, headers: res.headers, body: Buffer.concat(chunks).toString("utf8") }));
		});
		req.on("error", reject);
		req.end(options.body);
	});
}

const authorized = { authorization: `Bearer ${TOKEN}`, "x-pim-space": SPACE, "content-type": "application/json" };

/** What the recorders saw. */
type Recorded = {
	manager: { action: string; body: unknown }[];
	adapter: { method: string; path: string; headers: Record<string, string>; body: string }[];
	media: { target: string; protocols: readonly string[] }[];
};

const hosts: Host[] = [];
after(async () => {
	for (const host of hosts) await host.close();
});

async function serve(options: { viewer?: boolean; fetch?: (request: Request) => Response | Promise<Response>; media?: (target: string, protocols: readonly string[]) => MediaUpgrade } = {}) {
	const seen: Recorded = { manager: [], adapter: [], media: [] };
	const routes: ViewerRoutes = {
		manager: {
			launch: async (body) => {
				seen.manager.push({ action: "launch", body });
				return { outcome: "refused", reason: "blocked" };
			},
			end: async (body) => {
				seen.manager.push({ action: "end", body });
				return { outcome: "not_found" };
			},
			status: async (body) => {
				seen.manager.push({ action: "status", body });
				return { outcome: "not_found" };
			},
		},
		adapter: {
			fetch: async (req) => {
				const headers: Record<string, string> = {};
				req.headers.forEach((value, name) => {
					headers[name] = value;
				});
				seen.adapter.push({ method: req.method, path: new URL(req.url).pathname, headers, body: req.method === "POST" ? await req.text() : "" });
				return options.fetch ? options.fetch(req) : new Response("viewer", { status: 200, headers: { "content-type": "text/html" } });
			},
			media: (target, protocols) => {
				seen.media.push({ target, protocols });
				return options.media ? options.media(target, protocols) : { status: 404 };
			},
		},
	};
	const relay = new Relay({
		space: SPACE,
		token: TOKEN,
		path: "/pim",
		open: async () => {
			throw new Error("no session");
		},
		log: () => undefined,
	});
	const host = createHost({ relay, ...(options.viewer === false ? {} : { viewer: routes }), transport: { kind: "loopback-http", host: "127.0.0.1", port: 0 }, log: () => undefined });
	hosts.push(host);
	const { port } = await host.listen();
	return { port, seen };
}

describe("the management API", () => {
	it("answers only a POST with the bridge's token and space, before it reads the body, and passes the manager what it was sent", async () => {
		const { port, seen } = await serve();
		const body = JSON.stringify({ key: "k".repeat(16), owner: SPACE, notAfter: 1_800_000_000_000 });
		const send = (extra: { method?: string; headers?: Record<string, string>; path?: string; body?: string }) =>
			request(port, { method: "POST", path: "/pim/observations/launch", headers: authorized, body, ...extra });

		assert.equal((await send({ headers: { ...authorized, authorization: "" } })).status, 401);
		assert.equal((await send({ headers: { ...authorized, authorization: `Bearer ${TOKEN}x` } })).status, 401);
		assert.equal((await send({ headers: { ...authorized, "x-pim-space": OTHER } })).status, 403);
		assert.equal((await send({ method: "GET" })).status, 405);
		assert.equal((await send({ path: "/pim/observations/other" })).status, 404);
		assert.equal((await send({ path: "/pim/observations/launch?x=1" })).status, 404);
		assert.equal((await send({ headers: { ...authorized, "content-type": "text/plain" } })).status, 415);
		assert.equal((await send({ body: "not json" })).status, 400);
		assert.equal((await send({ body: "[]" })).status, 400);
		assert.equal((await send({ body: JSON.stringify({ key: "k".repeat(16), owner: OTHER, notAfter: 1 }) })).status, 403);
		assert.equal((await send({ body: JSON.stringify({ owner: SPACE, padding: "x".repeat(5000) }) })).status, 413);
		assert.deepEqual(seen.manager, []);

		const ok = await send({});
		assert.equal(ok.status, 200);
		assert.equal(ok.headers["content-type"], "application/json");
		assert.equal(ok.headers["cache-control"], "no-store");
		assert.deepEqual(JSON.parse(ok.body), { outcome: "refused", reason: "blocked" });
		assert.deepEqual(seen.manager, [{ action: "launch", body: JSON.parse(body) }]);
	});

	it("routes end and status to the manager with the same checks", async () => {
		const { port, seen } = await serve();
		const body = JSON.stringify({ owner: SPACE, key: "k".repeat(16), generation: "g" });
		for (const action of ["end", "status"]) {
			assert.equal((await request(port, { method: "POST", path: `/pim/observations/${action}`, headers: { ...authorized, authorization: "Bearer nope" }, body })).status, 401);
			assert.equal((await request(port, { method: "POST", path: `/pim/observations/${action}`, headers: authorized, body })).status, 200);
		}
		assert.deepEqual(seen.manager.map((call) => call.action), ["end", "status"]);
	});

	it("is not served by a host with no viewer", async () => {
		const { port, seen } = await serve({ viewer: false });
		assert.equal((await request(port, { method: "POST", path: "/pim/observations/launch", headers: authorized, body: "{}" })).status, 404);
		assert.equal((await request(port, { path: `/${LAUNCH}/viewer/` })).status, 404);
		assert.deepEqual(seen.manager, []);
		assert.deepEqual(seen.adapter, []);
	});

	it("refuses a relay path that looks like a launch's", () => {
		const relay = new Relay({ space: SPACE, token: TOKEN, path: `/${LAUNCH}`, open: async () => { throw new Error("no session"); }, log: () => undefined });
		assert.throws(() => createHost({ relay, viewer: { manager: {} as never, adapter: {} as never }, transport: { kind: "loopback-http", host: "127.0.0.1", port: 0 } }));
	});
});

describe("the adapter's routes", () => {
	it("hand the adapter only the headers it reads and carry no bridge token", async () => {
		const { port, seen } = await serve();
		const page = await request(port, { path: `/${LAUNCH}/viewer/`, headers: { cookie: "a=b", "x-pim-space": SPACE, "x-other": "1" } });
		assert.equal(page.status, 200);
		assert.equal(page.body, "viewer");
		const call = await request(port, {
			method: "POST",
			path: `/${LAUNCH}/cua.env.v1.SystemService/GetCapabilities`,
			headers: { "content-type": "application/grpc-web+proto", "x-cua-env-authorization": `Bearer ${CREDENTIAL}`, authorization: "Bearer from-a-browser", cookie: "a=b", "x-other": "1" },
			body: "\u0000\u0000\u0000\u0000\u0000",
		});
		assert.equal(call.status, 200);
		assert.equal(seen.adapter[0]!.headers.cookie, undefined);
		assert.equal(seen.adapter[0]!.headers["x-other"], undefined);
		assert.equal(seen.adapter[0]!.headers["x-pim-space"], undefined);
		assert.equal(seen.adapter[1]!.path, `/${LAUNCH}/cua.env.v1.SystemService/GetCapabilities`);
		assert.equal(seen.adapter[1]!.headers["x-cua-env-authorization"], `Bearer ${CREDENTIAL}`);
		// An authorization header is handed on, for the adapter to refuse; the host never takes it for the bridge's.
		assert.equal(seen.adapter[1]!.headers.authorization, "Bearer from-a-browser");
		assert.equal(seen.adapter[1]!.body, "\u0000\u0000\u0000\u0000\u0000");
		assert.equal((await request(port, { method: "PUT", path: `/${LAUNCH}/viewer/` })).status, 405);
		assert.equal((await request(port, { method: "POST", path: `/${LAUNCH}/x`, headers: { "content-type": "a" } })).status, 200);
	});

	it("end the adapter's stream when the client goes away", async () => {
		let cancelled!: () => void;
		const done = new Promise<void>((resolve) => {
			cancelled = resolve;
		});
		const { port } = await serve({
			fetch: () =>
				new Response(
					new ReadableStream<Uint8Array>({
						start(controller) {
							controller.enqueue(new TextEncoder().encode("one"));
						},
						cancel: () => cancelled(),
					}),
					{ status: 200, headers: { "content-type": "application/grpc-web+proto" } },
				),
		});
		await new Promise<void>((resolve, reject) => {
			const req = http.request({ host: "127.0.0.1", port, method: "POST", path: `/${LAUNCH}/cua.env.v1.PresenceService/Join`, headers: { "content-type": "application/grpc-web+proto" } }, (res) => {
				res.once("data", () => {
					req.destroy();
					resolve();
				});
			});
			req.on("error", () => undefined);
			req.end("x");
			setTimeout(() => reject(new Error("no first chunk")), 5_000).unref();
		});
		await done;
	});
});

describe("the media socket", () => {
	const target = `/${LAUNCH}/media?ticket=${ATTACH}`;
	const refused = (port: number, protocols?: string) =>
		new Promise<number>((resolve, reject) => {
			const ws = new WebSocket(`ws://127.0.0.1:${port}${target}`, protocols === undefined ? [] : [protocols]);
			ws.on("unexpected-response", (_req, res) => {
				res.resume();
				resolve(res.statusCode ?? 0);
			});
			ws.on("open", () => reject(new Error("opened")));
			ws.on("error", () => undefined);
		});

	it("is refused as the adapter refuses it, and attached only once the adapter lets it", async () => {
		const { port, seen } = await serve({ media: () => ({ status: 404 }) });
		assert.equal(await refused(port, "rcdp.v2"), 404);
		assert.deepEqual(seen.media, [{ target, protocols: ["rcdp.v2"] }]);

		let attached = 0;
		const late = await serve({ media: () => ({ status: 101, protocol: "rcdp.v2", attach: () => (attached++, 401) }) });
		assert.equal(await refused(late.port, "rcdp.v2"), 401);
		assert.equal(attached, 1);
		// Not a media target, not the adapter's: the relay's own refusal, and nothing asked of the adapter.
		const before = late.seen.media.length;
		assert.equal(await new Promise<number>((resolve) => {
			const ws = new WebSocket(`ws://127.0.0.1:${late.port}/${LAUNCH}/media?ticket=short`, ["rcdp.v2"]);
			ws.on("unexpected-response", (_req, res) => resolve(res.statusCode ?? 0));
			ws.on("error", () => undefined);
		}), 404);
		assert.equal(late.seen.media.length, before);
	});

	it("carries messages both ways once attached, and reports its closure", async () => {
		let socket: MediaSocket | undefined;
		const got: (string | Uint8Array)[] = [];
		const closed: (number | undefined)[] = [];
		const { port } = await serve({
			media: () => ({
				status: 101,
				protocol: "rcdp.v2",
				attach: (open: (events: MediaEvents) => MediaSocket) => {
					socket = open({ message: (data) => got.push(data), closed: (code) => closed.push(code) });
					return 101;
				},
			}),
		});
		const ws = new WebSocket(`ws://127.0.0.1:${port}${target}`, ["rcdp.v2"]);
		const received = new Promise<string>((resolve) => ws.once("message", (data) => resolve(data.toString())));
		await new Promise<void>((resolve, reject) => {
			ws.once("open", () => resolve());
			ws.once("error", reject);
		});
		assert.equal(ws.protocol, "rcdp.v2");
		socket!.send("hello");
		assert.equal(await received, "hello");
		ws.send('{"type":"frame_ack"}');
		while (got.length === 0) await new Promise((resolve) => setTimeout(resolve, 5));
		assert.deepEqual(got, ['{"type":"frame_ack"}']);
		ws.close(1000);
		while (closed.length === 0) await new Promise((resolve) => setTimeout(resolve, 5));
		assert.deepEqual(closed, [1000]);
	});
});

describe("the viewer host's root token", () => {
	const FILE = "/etc/pim-viewer/root-token";
	const token = "t".repeat(40);
	const read = (prepare: (files: FakeFiles) => void) => {
		const files = new FakeFiles();
		prepare(files);
		return readRootToken(FILE, files);
	};

	it("is read from a checked file of this account's, with at most one newline after it", () => {
		assert.equal(read((files) => files.file(FILE, token)), token);
		assert.equal(read((files) => files.file(FILE, `${token}\n`)), token);
		assert.equal(read((files) => files.file(FILE, `${token}\n`, 0o400)), token);
		assert.equal(read((files) => files.file(FILE, "a".repeat(MAX_ROOT_TOKEN_BYTES) + "\n")), "a".repeat(MAX_ROOT_TOKEN_BYTES));
	});

	it("is none when the file is missing, another's, readable by others, linked, empty, too long or not printable", () => {
		assert.equal(read(() => undefined), undefined);
		assert.equal(read((files) => files.file(FILE, token, 0o640)), undefined);
		assert.equal(read((files) => files.file(FILE, token, 0o604)), undefined);
		assert.equal(read((files) => files.file(FILE, token, 0o600, OWNER_UID + 1)), undefined);
		assert.equal(read((files) => files.link(FILE)), undefined);
		assert.equal(read((files) => (files.file(FILE, token), (files.nodes.get(FILE)!.nlink = 2))), undefined);
		assert.equal(read((files) => files.file(FILE, "")), undefined);
		assert.equal(read((files) => files.file(FILE, "\n")), undefined);
		assert.equal(read((files) => files.file(FILE, "a".repeat(MAX_ROOT_TOKEN_BYTES + 1))), undefined);
		assert.equal(read((files) => files.file(FILE, `${token}\n\n`)), undefined);
		assert.equal(read((files) => files.file(FILE, `${token} x`)), undefined);
		assert.equal(read((files) => files.file(FILE, `${token}\r\n`)), undefined);
		assert.equal(readRootToken(FILE, Object.assign(new FakeFiles(), { user: undefined })), undefined);
	});

	it("is read afresh for each call, and its file's contents are in no error", () => {
		const files = new FakeFiles();
		files.file(FILE, token);
		assert.equal(readRootToken(FILE, files), token);
		files.nodes.get(FILE)!.data = Buffer.from("u".repeat(40));
		assert.equal(readRootToken(FILE, files), "u".repeat(40));
		files.nodes.delete(FILE);
		assert.equal(readRootToken(FILE, files), undefined);
	});
});

describe("the viewer host", () => {
	const DIR = "/var/lib/pim-viewer";
	const ROOT = "/etc/pim-viewer/root-token";
	const noSpacesd = {
		fetch: async () => {
			throw new Error("spacesd must not be asked");
		},
		openMedia: async () => {
			throw new Error("spacesd must not be asked");
		},
	};
	const launch = { key: "k".repeat(16), owner: SPACE, notAfter: Date.now() + 3_600_000 };
	const make = (files: FakeFiles) => createViewerHost({ origin: "http://127.0.0.1:3211", displayId: "primary", journalDirectory: DIR, rootTokenFile: ROOT, files, upstream: noSpacesd, generation: "host-test" });

	it("takes only an origin that is https, or http on a loopback address", () => {
		assert.equal(checkedOrigin("https://desktop.example"), true);
		assert.equal(checkedOrigin("https://desktop.example:8443"), true);
		assert.equal(checkedOrigin("http://127.0.0.1:3211"), true);
		assert.equal(checkedOrigin("http://[::1]:3211"), true);
		for (const bad of ["http://desktop.example", "http://localhost:3211", "https://u:p@desktop.example", "https://desktop.example/path", "https://desktop.example/?q", "ftp://127.0.0.1", "nonsense"]) {
			assert.equal(checkedOrigin(bad), false, bad);
		}
	});

	it("refuses every launch, and creates no journal, when the store can't be opened or there is no journal", async () => {
		// No directory at all.
		const none = new FakeFiles();
		const missing = await make(none);
		assert.ok(missing.blockers().some((reason) => reason.includes("journal store")));
		assert.deepEqual(await missing.routes.manager.launch(launch), { outcome: "refused", reason: "blocked" });
		assert.equal([...none.nodes.keys()].length, 0);

		// A directory with a lock left by a host that died: refused, the lock left alone.
		const locked = new FakeFiles();
		locked.directory(DIR);
		locked.file(`${DIR}/journal.json`, "{}");
		locked.file(`${DIR}/journal.lock`, "dead");
		const stale = await make(locked);
		assert.ok(stale.blockers().length > 0);
		assert.deepEqual(await stale.routes.manager.launch(launch), { outcome: "refused", reason: "blocked" });
		assert.equal(locked.text(`${DIR}/journal.lock`), "dead");
		assert.equal(locked.text(`${DIR}/journal.json`), "{}");

		// A directory with no journal in it: nothing is created, and the launch is blocked.
		const empty = new FakeFiles();
		empty.directory(DIR);
		empty.file(ROOT, "r".repeat(40));
		const unprovisioned = await make(empty);
		assert.ok(unprovisioned.blockers().length > 0);
		assert.deepEqual(await unprovisioned.routes.manager.launch(launch), { outcome: "refused", reason: "blocked" });
		assert.equal(empty.nodes.has(`${DIR}/journal.json`), false);
		unprovisioned.close();
	});

	it("refuses a launch with no root token before anything is stored or spacesd is asked", async () => {
		const files = new FakeFiles();
		files.directory(DIR);
		files.file(`${DIR}/journal.json`, JSON.stringify({ version: 1, revision: 1, generation: "provisioned", initialized: "a test", entries: [] }));
		const viewer = await make(files);
		assert.deepEqual(viewer.blockers(), []);
		assert.deepEqual(await viewer.routes.manager.launch(launch), { outcome: "refused", reason: "no_credential" });
		assert.deepEqual((JSON.parse(files.text(`${DIR}/journal.json`)!) as { entries: unknown[] }).entries, []);
		viewer.close();
		assert.equal(files.nodes.has(`${DIR}/journal.lock`), false);
	});
});
