/**
 * The Node host's routes to a viewer (../host.ts `ViewerRoutes`) over real
 * loopback sockets: plain HTTP on 127.0.0.1 and `ws` clients in this process.
 * The launch manager and the adapter are recorders; no certificate, no other
 * process, nothing leaves the machine. **These tests are outside the
 * mocked-lifecycle boundary** (docs/cua-viewer-first-preview.md): they are
 * not on the stand-in allowlist, and are not run until they are separately
 * authorized. Cancellation of a management request is exercised here too,
 * with raw sockets.
 */

import assert from "node:assert/strict";
import * as http from "node:http";
import * as net from "node:net";
import { after, describe, it } from "node:test";
import { WebSocket } from "ws";
import { Relay } from "../../cua-bridge.ts";
import { createHost, type Host, type Limits, type ViewerRoutes } from "../host.ts";
import type { MediaEvents, MediaSocket, MediaUpgrade } from "../viewer-adapter.ts";

const SPACE = "o_0123456789abcdefghijklmnop";
const OTHER = "o_zyxwvutsrqponmlkjihgfedcba";
const TOKEN = "viewer-routes-test-token-0123456789abcdef";
const LAUNCH = "AAAAAAAAAAAAAAAAAAAAAA";
const ATTACH = "B".repeat(43);
const CREDENTIAL = "C".repeat(43);
const PUBLIC = "https://bridge.example";
const PIM = "https://pim.example";

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

async function serve(options: { viewer?: boolean; fetch?: (request: Request) => Response | Promise<Response>; media?: (target: string, protocols: readonly string[]) => MediaUpgrade; limits?: Partial<Limits>; embed?: boolean } = {}) {
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
		publicOrigin: PUBLIC,
		...(options.embed ? { embedOrigin: PIM } : {}),
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
	const host = createHost({ relay, ...(options.viewer === false ? {} : { viewer: routes }), transport: { kind: "loopback-http", host: "127.0.0.1", port: 0 }, ...(options.limits ? { limits: options.limits } : {}), log: () => undefined });
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

describe("a management request whose client goes away", () => {
	/** Sends a request's head, with a body of `declared` bytes of which `sent` are sent, over a raw socket. */
	const partial = (port: number, action: string, declared: number, sent: string) =>
		new Promise<net.Socket>((resolve) => {
			const socket = net.connect(port, "127.0.0.1", () => {
				socket.write(
					[`POST /pim/observations/${action} HTTP/1.1`, "host: x", `authorization: Bearer ${TOKEN}`, `x-pim-space: ${SPACE}`, "content-type: application/json", `content-length: ${declared}`, "", sent].join("\r\n"),
				);
				resolve(socket);
			});
			socket.on("error", () => undefined);
		});
	const closed = (socket: net.Socket) => new Promise<void>((resolve) => socket.once("close", () => resolve()));

	it("asks the manager for nothing when it leaves mid-body", async () => {
		const { port, seen } = await serve();
		const socket = await partial(port, "launch", 100, '{"owner":"' + SPACE + '"');
		await new Promise((resolve) => setTimeout(resolve, 50));
		socket.destroy();
		await closed(socket);
		await new Promise((resolve) => setTimeout(resolve, 100));
		assert.deepEqual(seen.manager, []);
	});

	it("cuts off a body that is too slow, and asks the manager for nothing", async () => {
		const { port, seen } = await serve({ limits: { headersMs: 200 } });
		const socket = await partial(port, "launch", 100, '{"owner":"' + SPACE + '"');
		await closed(socket);
		assert.deepEqual(seen.manager, []);
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

	it("refuse another origin and answer no CORS, and frame-ancestors and a permissions policy go on every answer", async () => {
		const { port, seen } = await serve({ embed: true });
		const path = `/${LAUNCH}/cua.env.v1.SystemService/GetCapabilities`;
		const headers = { "content-type": "application/grpc-web+proto", "x-cua-env-authorization": `Bearer ${CREDENTIAL}` };
		const refusedOrigin = await request(port, { method: "POST", path, headers: { ...headers, origin: "https://evil.example" }, body: "x" });
		assert.equal(refusedOrigin.status, 403);
		// A refusal on a viewer route carries the same policy as an answer, whether the host or the adapter made it.
		for (const refusal of [refusedOrigin, await request(port, { method: "PUT", path: `/${LAUNCH}/viewer/` })]) {
			assert.ok([refusal.headers["content-security-policy"]].flat().join(",").includes(`frame-ancestors ${PIM}`));
			assert.ok(String(refusal.headers["permissions-policy"]).includes("clipboard-read=()"));
		}
		assert.equal((await request(port, { method: "POST", path, headers: { ...headers, origin: PIM }, body: "x" })).status, 403, "framing is not calling");
		assert.equal((await request(port, { method: "OPTIONS", path, headers: { origin: "https://evil.example", "access-control-request-method": "POST" } })).status, 405, "a preflight is not answered");
		assert.deepEqual(seen.adapter, []);
		const ok = await request(port, { method: "POST", path, headers: { ...headers, origin: PUBLIC }, body: "x" });
		assert.equal(ok.status, 200);
		assert.equal(Object.keys(ok.headers).some((name) => name.startsWith("access-control-")), false);
		assert.ok([ok.headers["content-security-policy"]].flat().join(",").includes(`frame-ancestors ${PIM}`));
		assert.ok(String(ok.headers["permissions-policy"]).includes("clipboard-read=()"));
		const same = await request(port, { path: `/${LAUNCH}/viewer/` });
		assert.equal(same.status, 200, "a same-origin page load sends no Origin");
		const closed = await serve();
		assert.ok([(await request(closed.port, { path: `/${LAUNCH}/viewer/` })).headers["content-security-policy"]].flat().join(",").includes("frame-ancestors 'none'"));
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
	const refused = (port: number, protocols?: string, origin: string | null = PUBLIC) =>
		new Promise<number>((resolve, reject) => {
			const ws = new WebSocket(`ws://127.0.0.1:${port}${target}`, protocols === undefined ? [] : [protocols], origin === null ? {} : { headers: { origin } });
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

	it("fails closed without exactly the public origin, before the adapter learns the token", async () => {
		let attached = 0;
		const { port, seen } = await serve({ media: () => ({ status: 101, protocol: "rcdp.v2", attach: () => (attached++, 101) }) });
		assert.equal(await refused(port, "rcdp.v2", null), 403, "no Origin");
		assert.equal(await refused(port, "rcdp.v2", PIM), 403, "the Pim app's origin");
		assert.equal(await refused(port, "rcdp.v2", "https://bridge.example:8444"), 403, "another port");
		assert.equal(await refused(port, "rcdp.v2", "null"), 403);
		assert.deepEqual(seen.media, []);
		assert.equal(attached, 0);
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
		const ws = new WebSocket(`ws://127.0.0.1:${port}${target}`, ["rcdp.v2"], { headers: { origin: PUBLIC } });
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

