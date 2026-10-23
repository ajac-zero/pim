// Runs deploy/celld/caddy/Caddyfile as it is, in front of a stand-in for celld that reports what
// reached it, and checks what the proxy promises: every request carries the ingress secret and
// the connection's address as Pim's celld runtime expects, whatever the client sends; Pim gets
// the public scheme and host; streams aren't held back; WebSockets connect; the content host
// serves only published pages; and celld's own health path stays private.
//
//   CADDY=/path/to/caddy node --test deploy/celld/test/proxy.check.mjs
//
// Needs the Caddy pinned in versions.env (run-scratch.sh fetches it); skips without CADDY.

import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { createServer, request as httpRequest } from "node:http";
import { request as httpsRequest } from "node:https";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";
import assert from "node:assert/strict";

const caddyfile = new URL("../caddy/Caddyfile", import.meta.url).pathname;
const CADDY = process.env.CADDY;
const PIM = "pim.localhost";
const SECRET = `proxy-check-${"x".repeat(40)}`;
const CONTENT = "pim-content.localhost";
const port = () => 20000 + Math.floor(Math.random() * 20000);

let backend, caddy, home, httpsPort, adminPort, ipv6;
const seen = [];

/** The stand-in for celld: answers with the headers it got, streams on /sse, and echoes one WebSocket message. */
function startBackend() {
	const server = createServer((req, res) => {
		seen.push({ url: req.url, headers: req.headers });
		if (req.url === "/sse") {
			res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
			res.write("data: first\n\n");
			setTimeout(() => res.end("data: last\n\n"), 1500);
			return;
		}
		if (req.url === "/index.html") {
			res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
			res.end(`<!doctype html>${"<p>Pim</p>".repeat(500)}`);
			return;
		}
		res.writeHead(200, { "content-type": "application/json" });
		res.end(JSON.stringify({ url: req.url, headers: req.headers, rawHeaders: req.rawHeaders }));
	});
	server.on("upgrade", (req, socket) => {
		seen.push({ url: req.url, headers: req.headers });
		const accept = createHash("sha1").update(`${req.headers["sec-websocket-key"]}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`).digest("base64");
		socket.write(`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`);
		socket.once("data", (frame) => {
			// One short masked text frame from the client; send its text back unmasked.
			const length = frame[1] & 0x7f;
			const mask = frame.subarray(2, 6);
			const text = Buffer.from(frame.subarray(6, 6 + length).map((byte, i) => byte ^ mask[i % 4]));
			socket.write(Buffer.concat([Buffer.from([0x81, text.length]), text]));
		});
	});
	return new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve(server)));
}

/** A request to Caddy as a browser on `host` would make it, from `from` (IPv4 or IPv6 loopback). */
function get(host, path, headers = {}, from = "127.0.0.1") {
	return new Promise((resolve, reject) => {
		const started = Date.now();
		const req = httpsRequest(
			{ host: from, port: httpsPort, path, servername: host, rejectUnauthorized: false, headers: { host, ...headers } },
			(res) => {
				const chunks = [];
				let firstAt;
				res.on("data", (chunk) => {
					firstAt ??= Date.now() - started;
					chunks.push(chunk);
				});
				res.on("end", () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks).toString(), firstAt, total: Date.now() - started }));
			},
		);
		req.on("error", reject);
		req.end();
	});
}

before(async (t) => {
	if (!CADDY) return;
	backend = await startBackend();
	home = mkdtempSync(join(tmpdir(), "pim-caddy-"));
	httpsPort = port();
	adminPort = port();
	caddy = spawn(CADDY, ["run", "--config", caddyfile, "--adapter", "caddyfile"], {
		env: {
			PATH: process.env.PATH,
			HOME: home,
			XDG_DATA_HOME: home,
			XDG_CONFIG_HOME: home,
			PIM_HOST: PIM,
			PIM_CONTENT_HOST: CONTENT,
			CELLD_ADDR: `127.0.0.1:${backend.address().port}`,
			CADDY_HTTPS_PORT: String(httpsPort),
			CADDY_HTTP_PORT: String(port()),
			CADDY_ADMIN: `localhost:${adminPort}`,
			PIM_INGRESS_SECRET: SECRET,
		},
		stdio: ["ignore", "ignore", "pipe"],
	});
	let log = "";
	caddy.stderr.on("data", (chunk) => (log += chunk));
	for (let i = 0; i < 100; i++) {
		const up = await get(PIM, "/health").catch(() => null);
		if (up?.status === 200) {
			ipv6 = (await get(PIM, "/health", {}, "::1").catch(() => null))?.status === 200;
			return;
		}
		await new Promise((resolve) => setTimeout(resolve, 100));
	}
	throw new Error(`Caddy didn't start:\n${log}`);
});

after(() => {
	caddy?.kill();
	backend?.close();
	if (home) rmSync(home, { recursive: true, force: true });
});

const skip = CADDY ? false : "set CADDY to the pinned Caddy binary";

test("a client can't claim another address or forge the secret, and Pim gets the public scheme and host", { skip }, async () => {
	const spoofed = "203.0.113.9";
	const res = await get(PIM, "/api/whoami", {
		"X-Pim-Client-IP": spoofed,
		"X-Pim-Ingress-Secret": "forged",
		"CF-Connecting-IP": spoofed,
		"CF-Connecting-IPv6": "2001:db8::9",
		"True-Client-IP": spoofed,
		"X-Real-IP": spoofed,
		"X-Client-IP": spoofed,
		"X-Forwarded-For": spoofed,
		"X-Forwarded-Host": "evil.example",
		"X-Forwarded-Proto": "http",
		Forwarded: `for=${spoofed};proto=http;host=evil.example`,
		"CF-IPCountry": "XX",
	});
	assert.equal(res.status, 200);
	const { headers, rawHeaders } = JSON.parse(res.body);
	assert.equal(headers["x-pim-client-ip"], "127.0.0.1");
	assert.equal(headers["x-pim-ingress-secret"], SECRET);
	// One value each, not the client's beside the proxy's.
	assert.equal(rawHeaders.filter((name, i) => i % 2 === 0 && /^x-pim-/i.test(name)).length, 2);
	assert.equal(headers["x-forwarded-for"], "127.0.0.1");
	assert.equal(headers["x-forwarded-proto"], "https");
	assert.equal(headers["x-forwarded-host"], PIM);
	assert.equal(headers.host, PIM);
	for (const name of ["cf-connecting-ip", "cf-connecting-ipv6", "true-client-ip", "x-real-ip", "x-client-ip", "forwarded", "cf-ipcountry"]) {
		assert.equal(headers[name], undefined, `${name} reached celld`);
	}
	assert.ok(!JSON.stringify(headers).includes(spoofed), "the spoofed address reached celld");
	assert.ok(!JSON.stringify(headers).includes("evil.example"), "the spoofed host reached celld");
	assert.ok(!JSON.stringify(headers).includes("forged"), "the forged secret reached celld");
});

test("an IPv6 client's address arrives bare: no brackets, no port, not a list", { skip }, async (t) => {
	if (!ipv6) return t.skip("no IPv6 loopback here");
	const res = await get(PIM, "/api/whoami", { "X-Pim-Client-IP": "2001:db8::1" }, "::1");
	const { headers } = JSON.parse(res.body);
	assert.equal(headers["x-pim-client-ip"], "::1");
	assert.equal(headers["x-pim-ingress-secret"], SECRET);
});

test("the admin API's config never holds the secret, which Caddy reads at request time", { skip }, async () => {
	const config = await adminGet("/config/");
	assert.ok(!config.includes(SECRET), "the secret is in Caddy's config");
	assert.match(config, /\{env\.PIM_INGRESS_SECRET\}/);
});

test("an event stream's first event arrives before the stream ends", { skip }, async () => {
	const res = await get(PIM, "/sse", { "Accept-Encoding": "gzip, zstd" });
	assert.equal(res.status, 200);
	assert.equal(res.headers["content-encoding"], undefined);
	assert.match(res.body, /first[\s\S]*last/);
	assert.ok(res.total >= 1400, `the stream ended after ${res.total} ms`);
	assert.ok(res.firstAt < 1000, `the first event took ${res.firstAt} ms: the proxy held it back`);
});

test("a WebSocket connects through the proxy and carries messages", { skip }, async () => {
	const echoed = await new Promise((resolve, reject) => {
		const req = httpsRequest({
			host: "127.0.0.1",
			port: httpsPort,
			path: "/api/ws",
			servername: PIM,
			rejectUnauthorized: false,
			headers: { host: PIM, connection: "Upgrade", upgrade: "websocket", "sec-websocket-version": "13", "sec-websocket-key": "dGhlIHNhbXBsZSBub25jZQ==" },
		});
		req.on("upgrade", (res, socket) => {
			assert.equal(res.statusCode, 101);
			const text = Buffer.from("hello pim");
			const mask = Buffer.from([1, 2, 3, 4]);
			socket.write(Buffer.concat([Buffer.from([0x81, 0x80 | text.length]), mask, text.map((byte, i) => byte ^ mask[i % 4])]));
			socket.once("data", (frame) => {
				resolve(frame.subarray(2, 2 + frame[1]).toString());
				socket.destroy();
			});
		});
		req.on("response", (res) => reject(new Error(`no upgrade: ${res.statusCode}`)));
		req.on("error", reject);
		req.end();
	});
	assert.equal(echoed, "hello pim");
	assert.equal(seen.at(-1).headers["x-pim-client-ip"], "127.0.0.1");
	assert.equal(seen.at(-1).headers["x-pim-ingress-secret"], SECRET);
});

test("the content host serves only published pages and their scripts", { skip }, async () => {
	const before = seen.length;
	const page = JSON.parse((await get(CONTENT, "/p/abc", { "X-Pim-Ingress-Secret": "forged" })).body);
	assert.equal(page.headers["x-pim-ingress-secret"], SECRET);
	assert.equal((await get(CONTENT, "/artifact-runtime/react.js")).status, 200);
	assert.equal(seen.length, before + 2);
	for (const path of ["/", "/api/account", "/auth/register", "/health", "/assets/index.js"]) {
		assert.equal((await get(CONTENT, path)).status, 404, path);
	}
	assert.equal(seen.length, before + 2, "the content host passed something else to celld");
});

test("celld's own health path isn't public, Pim's is, and the web app is compressed", { skip }, async () => {
	const before = seen.length;
	assert.equal((await get(PIM, "/.well-known/celld/health")).status, 404);
	assert.equal(seen.length, before);
	assert.equal((await get(PIM, "/.well-known/oauth-authorization-server")).status, 200);
	assert.equal(seen.length, before + 1);
	assert.equal((await get(PIM, "/index.html", { "Accept-Encoding": "gzip" })).headers["content-encoding"], "gzip");
	assert.equal((await get(PIM, "/api/whoami", { "Accept-Encoding": "gzip" })).headers["content-encoding"], undefined);
});

const adminGet = (path) =>
	new Promise((resolve, reject) =>
		httpRequest({ host: "127.0.0.1", port: adminPort, path, headers: { host: `localhost:${adminPort}` } }, (res) => {
			let body = "";
			res.on("data", (chunk) => (body += chunk)).on("end", () => resolve(body));
		})
			.on("error", reject)
			.end(),
	);

test("the admin API answers only on loopback", { skip }, async () => {
	assert.equal(JSON.parse(await adminGet("/config/admin")).listen, `localhost:${adminPort}`);
});
