/**
 * The Cua bridge's Node host (../host.ts), over real loopback sockets: a
 * Node HTTPS server with a certificate made for the run by `openssl`, and
 * clients that are `ws`'s WebSocket or raw TLS sockets writing HTTP by hand.
 * What stands in: every session, which a test's `OpenSession` makes in
 * memory and which runs nothing; and Pim, whose own client (a Worker's
 * `fetch`) is not here. Nothing leaves 127.0.0.1.
 *
 *   pnpm --filter pim-cua-host test
 */

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as https from "node:https";
import * as net from "node:net";
import * as os from "node:os";
import * as path from "node:path";
import type { Duplex } from "node:stream";
import { after, before, describe, it } from "node:test";
import * as tls from "node:tls";
import { WebSocket } from "ws";
import { type LogEntry, MAX_MESSAGE_CHARS, type OpenSession, REPLACED, Relay, SPACE_HEADER, type Session, type SessionEvents } from "../../cua-bridge.ts";
import { createHost, type Limits } from "../host.ts";

const SPACE = "o_0123456789abcdefghijklmnop";
const OTHER = "o_zyxwvutsrqponmlkjihgfedcba";
const TOKEN = "cua-node-host-test-token-0123456789abcdef";
const HELLO = JSON.stringify({ type: "hello", version: 1, agent: "pim-computer/test", hostname: "cua-vm", platform: "linux", arch: "x64", user: "desktop", root: "/workspace", browser: null });

let tlsDir: string;
let cert: string;
let key: string;

before(() => {
	tlsDir = fs.mkdtempSync(path.join(os.tmpdir(), "cua-host-tls-"));
	execFileSync("openssl", [
		"req", "-x509", "-newkey", "ec", "-pkeyopt", "ec_paramgen_curve:prime256v1", "-nodes", "-days", "1",
		"-subj", "/CN=127.0.0.1", "-addext", "subjectAltName=IP:127.0.0.1",
		"-keyout", path.join(tlsDir, "key.pem"), "-out", path.join(tlsDir, "cert.pem"),
	], { stdio: "ignore" });
	cert = fs.readFileSync(path.join(tlsDir, "cert.pem"), "utf8");
	key = fs.readFileSync(path.join(tlsDir, "key.pem"), "utf8");
});

after(() => fs.rmSync(tlsDir, { recursive: true, force: true }));

/** A session as its fixture sees it: what it was handed, and how often it was closed. */
type Made = { events: SessionEvents; signal: AbortSignal; received: string[]; closes: number };

function deferred<T>() {
	let resolve!: (value: T) => void;
	const promise = new Promise<T>((res) => {
		resolve = res;
	});
	return { promise, resolve };
}

const tick = (ms = 20) => new Promise((resolve) => setTimeout(resolve, ms));

async function until(condition: () => boolean, what: string, ms = 5_000) {
	const deadline = Date.now() + ms;
	while (!condition()) {
		if (Date.now() > deadline) throw new Error(`Timed out waiting for ${what}.`);
		await tick(5);
	}
}

/**
 * A relay and its host on 127.0.0.1. By default each session says hello at
 * once, as pim-computer does, and answers each call with a reply naming its
 * ID; `open` replaces that. `order` records when sessions open and close.
 */
async function serve(options: { open?: OpenSession; limits?: Partial<Limits>; transport?: "https" | "loopback-http" } = {}) {
	const made: Made[] = [];
	const order: string[] = [];
	const relayLog: LogEntry[] = [];
	const hostLog: LogEntry[] = [];
	let opens = 0;
	const standard: OpenSession = async (events, signal) => {
		const index = made.length;
		const session: Made = { events, signal, received: [], closes: 0 };
		made.push(session);
		order.push(`open ${index}`);
		events.message(HELLO);
		return {
			send(message) {
				session.received.push(message);
				const call = JSON.parse(message) as { id: number };
				events.message(JSON.stringify({ type: "reply", id: call.id, ok: true, value: `ran ${call.id}` }));
			},
			close() {
				session.closes++;
				order.push(`close ${index}`);
			},
		};
	};
	const open: OpenSession = (events, signal) => {
		opens++;
		return (options.open ?? standard)(events, signal);
	};
	const relay = new Relay({ space: SPACE, token: TOKEN, path: "/pim", open, log: (entry) => relayLog.push(entry) });
	const kind = options.transport ?? "https";
	const host = createHost({
		relay,
		transport: kind === "https" ? { kind, cert, key, host: "127.0.0.1", port: 0 } : { kind, host: "127.0.0.1", port: 0 },
		log: (entry) => hostLog.push(entry),
		...(options.limits ? { limits: options.limits } : {}),
	});
	const { port } = await host.listen();
	return { host, port, made, order, relayLog, hostLog, opens: () => opens, scheme: kind === "https" ? "wss" : "ws" };
}

type Served = Awaited<ReturnType<typeof serve>>;

const pimHeaders = (changes: Record<string, string> = {}) => ({ authorization: `Bearer ${TOKEN}`, [SPACE_HEADER]: SPACE, ...changes });

/** Pim's side, as `ws`'s client: what the handshake answered, what arrives, and how it closed. */
function connect(served: Served, options: { path?: string; headers?: Record<string, string> } = {}) {
	const socket = new WebSocket(`${served.scheme}://127.0.0.1:${served.port}${options.path ?? "/pim"}`, {
		headers: options.headers ?? pimHeaders(),
		ca: cert,
		perMessageDeflate: false,
		followRedirects: false,
		handshakeTimeout: 5_000,
	});
	const seen = {
		status: null as number | null,
		headers: null as Record<string, string | string[] | undefined> | null,
		messages: [] as string[],
		closed: null as { code: number; reason: string } | null,
		failed: false,
	};
	const opened = new Promise<boolean>((resolve) => {
		socket.on("upgrade", (response) => {
			seen.status = response.statusCode ?? null;
			seen.headers = response.headers;
		});
		socket.on("unexpected-response", (_request, response) => {
			seen.status = response.statusCode ?? null;
			seen.headers = response.headers;
			response.resume();
			socket.terminate();
			resolve(false);
		});
		socket.on("open", () => resolve(true));
		socket.on("error", () => {
			seen.failed = true;
			resolve(false);
		});
	});
	socket.on("message", (data, isBinary) => {
		if (!isBinary) seen.messages.push(data.toString());
	});
	const closed = new Promise<{ code: number; reason: string }>((resolve) => {
		socket.on("close", (code, reason) => {
			seen.closed = { code, reason: reason.toString() };
			resolve(seen.closed);
		});
	});
	return { socket, seen, opened, closed };
}

/** Writes `text` on a raw TLS (or TCP) connection to the host, and answers everything that comes back until it closes. */
function raw(served: Served, text: string | Buffer, options: { keepOpen?: boolean } = {}): Promise<string> {
	return new Promise((resolve) => {
		const socket: Duplex = served.scheme === "wss" ? tls.connect({ host: "127.0.0.1", port: served.port, ca: cert }) : net.connect(served.port, "127.0.0.1");
		const chunks: Buffer[] = [];
		socket.on("data", (chunk: Buffer) => chunks.push(chunk));
		socket.on("error", () => {});
		socket.on("close", () => resolve(Buffer.concat(chunks).toString("latin1")));
		socket.write(text);
		if (!options.keepOpen) setTimeout(() => socket.destroy(), 3_000).unref();
	});
}

const handshake = (lines: string[]) => `${lines.join("\r\n")}\r\n\r\n`;
const upgradeHeaders = ["Host: 127.0.0.1", "Upgrade: websocket", "Connection: Upgrade", "Sec-WebSocket-Version: 13", "Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ=="];

describe("refusing a request before anything is opened", () => {
	const cases: { name: string; text: string; status: number }[] = [
		{ name: "a wrong bearer token", text: handshake(["GET /pim HTTP/1.1", ...upgradeHeaders, `Authorization: Bearer ${"x".repeat(40)}`, `${SPACE_HEADER}: ${SPACE}`]), status: 401 },
		{ name: "no Authorization", text: handshake(["GET /pim HTTP/1.1", ...upgradeHeaders, `${SPACE_HEADER}: ${SPACE}`]), status: 401 },
		{ name: "another space", text: handshake(["GET /pim HTTP/1.1", ...upgradeHeaders, `Authorization: Bearer ${TOKEN}`, `${SPACE_HEADER}: ${OTHER}`]), status: 403 },
		{ name: "another path", text: handshake(["GET /other HTTP/1.1", ...upgradeHeaders, `Authorization: Bearer ${TOKEN}`, `${SPACE_HEADER}: ${SPACE}`]), status: 404 },
		{ name: "a path that only normalizes to the bridge's", text: handshake(["GET /x/../pim HTTP/1.1", ...upgradeHeaders, `Authorization: Bearer ${TOKEN}`, `${SPACE_HEADER}: ${SPACE}`]), status: 404 },
		{ name: "the token in a query", text: handshake([`GET /pim?token=${TOKEN} HTTP/1.1`, ...upgradeHeaders, `Authorization: Bearer ${TOKEN}`, `${SPACE_HEADER}: ${SPACE}`]), status: 404 },
		{ name: "an absolute-form target", text: handshake(["GET https://127.0.0.1/pim HTTP/1.1", ...upgradeHeaders, `Authorization: Bearer ${TOKEN}`, `${SPACE_HEADER}: ${SPACE}`]), status: 404 },
		{ name: "another method", text: handshake(["POST /pim HTTP/1.1", ...upgradeHeaders, `Authorization: Bearer ${TOKEN}`, `${SPACE_HEADER}: ${SPACE}`, "Content-Length: 0"]), status: 405 },
		{ name: "a method Request won't make", text: handshake(["TRACE /pim HTTP/1.1", ...upgradeHeaders, `Authorization: Bearer ${TOKEN}`, `${SPACE_HEADER}: ${SPACE}`]), status: 400 },
		{ name: "two Authorization headers", text: handshake(["GET /pim HTTP/1.1", ...upgradeHeaders, `Authorization: Bearer ${TOKEN}`, `Authorization: Bearer ${TOKEN}`, `${SPACE_HEADER}: ${SPACE}`]), status: 400 },
		{ name: "two space headers", text: handshake(["GET /pim HTTP/1.1", ...upgradeHeaders, `Authorization: Bearer ${TOKEN}`, `${SPACE_HEADER}: ${SPACE}`, `${SPACE_HEADER}: ${SPACE}`]), status: 400 },
		{ name: "no upgrade", text: handshake(["GET /pim HTTP/1.1", "Host: 127.0.0.1", `Authorization: Bearer ${TOKEN}`, `${SPACE_HEADER}: ${SPACE}`]), status: 426 },
		{ name: "Upgrade without Connection: upgrade", text: handshake(["GET /pim HTTP/1.1", "Host: 127.0.0.1", "Upgrade: websocket", `Authorization: Bearer ${TOKEN}`, `${SPACE_HEADER}: ${SPACE}`]), status: 426 },
		{ name: "a handshake without a key", text: handshake(["GET /pim HTTP/1.1", "Host: 127.0.0.1", "Upgrade: websocket", "Connection: Upgrade", "Sec-WebSocket-Version: 13", `Authorization: Bearer ${TOKEN}`, `${SPACE_HEADER}: ${SPACE}`]), status: 400 },
		{ name: "headers past the limit", text: handshake(["GET /pim HTTP/1.1", ...upgradeHeaders, `Authorization: Bearer ${TOKEN}`, `${SPACE_HEADER}: ${SPACE}`, `X-Padding: ${"p".repeat(20_000)}`]), status: 431 },
	];
	for (const { name, text, status } of cases) {
		it(`answers ${status} to ${name}, with no session asked for and nothing of the request repeated`, async () => {
			const served = await serve();
			try {
				const answer = await raw(served, text);
				assert.match(answer, new RegExp(`^HTTP/1\\.1 ${status} `));
				assert.doesNotMatch(answer, /\r\nlocation:/i);
				assert.ok(!answer.includes(TOKEN), "the token isn't repeated");
				assert.ok(!answer.includes(OTHER), "the space asked for isn't repeated");
				assert.ok(!/^x-pim-space:/im.test(answer), "no space is named back");
				assert.equal(served.opens(), 0);
				assert.equal(served.made.length, 0);
				assert.ok(![...served.relayLog, ...served.hostLog].some((entry) => JSON.stringify(entry).includes(TOKEN)));
			} finally {
				await served.host.close();
			}
		});
	}

	it("refuses an upgrade while too many are opening, before checking it", async () => {
		const waiting = deferred<Session>();
		const served = await serve({ open: () => waiting.promise, limits: { maxPendingUpgrades: 1 } });
		try {
			const first = connect(served);
			await until(() => served.opens() === 1, "the first session to be asked for");
			const second = connect(served);
			assert.equal(await second.opened, false);
			assert.equal(second.seen.status, 503);
			assert.equal(served.opens(), 1);
			first.socket.terminate();
		} finally {
			await served.host.close();
		}
	});

	it("ends a connection that sends before 101, without asking for a session", async () => {
		const served = await serve();
		try {
			const frame = Buffer.from([0x81, 0x82, 0, 0, 0, 0, 0x7b, 0x7d]);
			const text = handshake(["GET /pim HTTP/1.1", ...upgradeHeaders, `Authorization: Bearer ${TOKEN}`, `${SPACE_HEADER}: ${SPACE}`]);
			const answer = await raw(served, Buffer.concat([Buffer.from(text), frame]));
			assert.equal(answer, "");
			assert.equal(served.opens(), 0);
			assert.ok(served.hostLog.some((entry) => entry.reason === "early-data"));
		} finally {
			await served.host.close();
		}
	});
});

describe("serving Pim's connection", () => {
	it("answers 101 naming the space, carries the session's hello, and relays a call and its reply unchanged", async () => {
		const served = await serve();
		try {
			const pim = connect(served);
			assert.equal(await pim.opened, true);
			assert.equal(pim.seen.status, 101);
			assert.equal(pim.seen.headers?.[SPACE_HEADER], SPACE);
			await until(() => pim.seen.messages.length === 1, "the hello");
			assert.deepEqual(pim.seen.messages, [HELLO]);
			const call = JSON.stringify({ type: "call", id: 7, method: "stat", params: { path: "/workspace" } });
			pim.socket.send(call);
			await until(() => pim.seen.messages.length === 2, "the reply");
			assert.deepEqual(served.made[0]!.received, [call]);
			assert.deepEqual(JSON.parse(pim.seen.messages[1]!), { type: "reply", id: 7, ok: true, value: "ran 7" });
			pim.socket.close(1000);
			await pim.closed;
			await until(() => served.made[0]!.closes === 1, "the session to close");
			assert.ok(served.relayLog.some((entry) => entry.event === "bridge.ended" && entry.reason === "client-closed"));
		} finally {
			await served.host.close();
		}
	});

	it("serves plain HTTP only on a loopback address", async () => {
		const relay = new Relay({ space: SPACE, token: TOKEN, path: "/pim", open: async () => ({ send() {}, close() {} }), log: () => {} });
		for (const host of ["0.0.0.0", "::", "localhost", "192.168.1.10", "::ffff:192.168.1.10", "127.0.0.1.nip.io"]) {
			assert.throws(() => createHost({ relay, transport: { kind: "loopback-http", host, port: 0 } }), /loopback/);
		}
		assert.throws(() => createHost({ relay, transport: { kind: "https", cert: "not a certificate", key: "not a key", host: "127.0.0.1", port: 0 } }));
		const served = await serve({ transport: "loopback-http" });
		try {
			const pim = connect(served);
			assert.equal(await pim.opened, true);
			assert.equal(pim.seen.headers?.[SPACE_HEADER], SPACE);
			await until(() => pim.seen.messages.length === 1, "the hello");
			pim.socket.terminate();
			await until(() => served.made[0]!.closes === 1, "the session to close");
		} finally {
			await served.host.close();
		}
	});

	it("ends the older connection (4409) and closes its session before the newer one's is asked for", async () => {
		const served = await serve();
		try {
			const first = connect(served);
			assert.equal(await first.opened, true);
			const second = connect(served);
			assert.equal(await second.opened, true);
			assert.deepEqual(await first.closed, { code: REPLACED, reason: "Replaced" });
			assert.deepEqual(served.order, ["open 0", "close 0", "open 1"]);
			await until(() => second.seen.messages.length === 1, "the second hello");
			second.socket.send(JSON.stringify({ type: "call", id: 1 }));
			await until(() => second.seen.messages.length === 2, "the reply");
			assert.deepEqual(served.made[0]!.received, []);
			assert.equal(served.made[1]!.received.length, 1);
			second.socket.terminate();
		} finally {
			await served.host.close();
		}
	});

	it("gives up a session still opening when Pim does, and closes it once, unused, when it comes late", async () => {
		const late = deferred<Session>();
		let signal: AbortSignal | null = null;
		const served = await serve({
			open: (_events, given) => {
				signal = given;
				return late.promise;
			},
		});
		try {
			const pim = connect(served);
			await until(() => signal !== null, "the session to be asked for");
			pim.socket.terminate();
			assert.equal(await pim.opened, false);
			await until(() => signal!.aborted, "the factory's signal to abort");
			assert.equal(pim.seen.status, null, "no 101");
			let closes = 0;
			const sent: string[] = [];
			late.resolve({ send: (message) => sent.push(message), close: () => closes++ });
			await until(() => closes === 1, "the late session to close");
			await tick(50);
			assert.equal(closes, 1);
			assert.deepEqual(sent, []);
			assert.ok(served.relayLog.some((entry) => entry.reason === "abandoned"));
		} finally {
			await served.host.close();
		}
	});

	it("answers 504 when the session doesn't open in time, and closes it once when it comes after", async () => {
		const late = deferred<Session>();
		let signal: AbortSignal | null = null;
		const served = await serve({
			open: (_events, given) => {
				signal = given;
				return late.promise;
			},
			limits: { openingMs: 200 },
		});
		try {
			const pim = connect(served);
			assert.equal(await pim.opened, false);
			assert.equal(pim.seen.status, 504);
			assert.equal(pim.seen.headers?.[SPACE_HEADER], undefined);
			assert.equal(signal!.aborted, true);
			let closes = 0;
			late.resolve({ send: () => assert.fail("a late session is never sent to"), close: () => closes++ });
			await until(() => closes === 1, "the late session to close");
		} finally {
			await served.host.close();
		}
	});

	it("answers 502 when the session fails to open, or ends while it opens", async () => {
		for (const open of [async () => Promise.reject(new Error(`secret ${TOKEN}`)), async (events: SessionEvents) => (events.closed(), { send() {}, close() {} })] as OpenSession[]) {
			const served = await serve({ open });
			try {
				const pim = connect(served);
				assert.equal(await pim.opened, false);
				assert.equal(pim.seen.status, 502);
				assert.ok(![...served.relayLog, ...served.hostLog].some((entry) => JSON.stringify(entry).includes(TOKEN)));
			} finally {
				await served.host.close();
			}
		}
	});

	it("ends the connection on a binary message, a line break or an oversized message, sending the session nothing", async () => {
		const cases: { send: string | Buffer; code: number }[] = [
			{ send: Buffer.from("{}"), code: 1003 },
			{ send: '{"type":\n"call"}', code: 1007 },
			{ send: "x".repeat(MAX_MESSAGE_CHARS + 1), code: 1009 },
		];
		for (const { send, code } of cases) {
			const served = await serve();
			try {
				const pim = connect(served);
				assert.equal(await pim.opened, true);
				pim.socket.send(send, { binary: typeof send !== "string" });
				assert.equal((await pim.closed).code, code);
				await until(() => served.made[0]!.closes === 1, "the session to close");
				assert.deepEqual(served.made[0]!.received, []);
			} finally {
				await served.host.close();
			}
		}
	});

	/**
	 * A session that, once Pim sends it anything, says `total` messages of
	 * 64 KiB, one per turn of the event loop, so the network can take them as
	 * they come; it stops when closed.
	 */
	function talkative(total: number) {
		const state = { emitted: 0, closed: false };
		const open: OpenSession = async (events) => {
			const pump = () => {
				if (state.closed || state.emitted >= total) return;
				events.message(JSON.stringify({ type: "cdp", data: "y".repeat(64 * 1024 - 32) }));
				state.emitted++;
				setImmediate(pump);
			};
			return {
				send: () => setImmediate(pump),
				close: () => {
					state.closed = true;
				},
			};
		};
		return { state, open };
	}

	it("ends the connection, and its session, rather than hold more than its limit for a peer that doesn't read", async (t) => {
		const session = talkative(2048);
		const served = await serve({ limits: { maxOutboundBytes: 1024 * 1024 }, open: session.open });
		try {
			// Pim's side upgrades, then never reads.
			const upgraded = await new Promise<Duplex>((resolve, reject) => {
				const request = https.request({ host: "127.0.0.1", port: served.port, path: "/pim", ca: cert, headers: { ...pimHeaders(), connection: "Upgrade", upgrade: "websocket", "sec-websocket-version": "13", "sec-websocket-key": "dGhlIHNhbXBsZSBub25jZQ==" } });
				request.on("upgrade", (response, socket) => {
					assert.equal(response.headers[SPACE_HEADER], SPACE);
					socket.pause();
					resolve(socket);
				});
				request.on("response", () => reject(new Error("not upgraded")));
				request.end();
			});
			// A masked text frame for the session's `send`, which starts it talking.
			upgraded.write(Buffer.from([0x81, 0x82, 0, 0, 0, 0, 0x7b, 0x7d]));
			await until(() => session.state.closed, "the session to be closed", 20_000);
			const at = session.state.emitted;
			await tick(100);
			assert.equal(session.state.emitted, at, "nothing more is asked of a closed session");
			assert.ok(at < 2048, `the session was stopped after ${at} of 2048 messages`);
			assert.ok(served.relayLog.some((entry) => entry.event === "bridge.ended" && entry.reason === "client-send"));
			t.diagnostic(`stopped after ${at} messages of 64 KiB: what the kernel's buffers took, and 1 MiB more`);
			upgraded.destroy();
		} finally {
			await served.host.close();
		}
	});

	it("keeps a connection whose peer reads, with the same limit and the same session", async () => {
		const session = talkative(256);
		const served = await serve({ limits: { maxOutboundBytes: 1024 * 1024 }, open: session.open });
		try {
			const pim = connect(served);
			assert.equal(await pim.opened, true);
			pim.socket.send("{}");
			await until(() => pim.seen.messages.length === 256, "every message", 20_000);
			assert.equal(session.state.closed, false);
			assert.equal(pim.seen.closed, null);
			pim.socket.close(1000);
			await until(() => session.state.closed, "the session to close");
		} finally {
			await served.host.close();
		}
	});

	it("ends every connection, and its session, when it stops", async () => {
		const served = await serve();
		const pim = connect(served);
		assert.equal(await pim.opened, true);
		await served.host.close();
		await pim.closed;
		await until(() => served.made[0]!.closes === 1, "the session to close");
	});
});
