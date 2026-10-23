// What run-scratch.sh checks of a Pim running on celld, through the TLS proxy as a browser would
// reach it. Two phases, so the same checks run again after a restart and after a restore:
//
//   node smoke.mjs setup   the static app, the API, claiming the Pim from celld's log, a passkey,
//                          a token, a model provider, a chat with an image (R2), a goal, a WebSocket
//   node smoke.mjs verify  everything `setup` made is still there, and the Pim still takes writes
//
// Environment: PIM_URL (the proxy's origin, also PIM_PUBLIC_URL), PROXY_PORT, CELLD_URL (celld's
// public listener), CELLD_LOG (its log file), MOCK_MODEL_URL, WEB_DIST, STATE (a JSON file the two
// phases share), INGRESS_SECRET, and RUNTIME=1 when the Worker has Pim's celld runtime. The
// proxy's certificate is Caddy's own local CA's, so TLS isn't verified here.

import { createHash, webcrypto } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { request as httpRequest } from "node:http";
import { request as httpsRequest } from "node:https";
import assert from "node:assert/strict";

const { PIM_URL, PROXY_PORT, CELLD_URL, CELLD_LOG, MOCK_MODEL_URL, WEB_DIST, STATE, INGRESS_SECRET, RUNTIME } = process.env;
const pim = new URL(PIM_URL);
const step = (what) => console.log(`  ✓ ${what}`);

/** One request to `base` (the proxy, or celld itself), as a browser on PIM_URL would send it. */
function call(method, path, { headers = {}, body, base = PIM_URL } = {}) {
	const target = new URL(base);
	const tls = target.protocol === "https:";
	const payload = body === undefined ? undefined : typeof body === "string" || Buffer.isBuffer(body) ? body : JSON.stringify(body);
	return new Promise((resolve, reject) => {
		const req = (tls ? httpsRequest : httpRequest)(
			{
				host: "127.0.0.1",
				port: tls ? PROXY_PORT : target.port,
				method,
				path,
				...(tls ? { servername: target.hostname, rejectUnauthorized: false } : {}),
				headers: { host: pim.host, ...(payload !== undefined && typeof body === "object" && !Buffer.isBuffer(body) ? { "content-type": "application/json" } : {}), ...headers },
			},
			(res) => {
				const chunks = [];
				res.on("data", (chunk) => chunks.push(chunk));
				res.on("end", () => {
					const bytes = Buffer.concat(chunks);
					const text = bytes.toString();
					let json;
					try {
						json = JSON.parse(text);
					} catch {}
					resolve({ status: res.statusCode, headers: res.headers, bytes, text, json });
				});
			},
		);
		req.on("error", reject);
		req.end(payload);
	});
}

const b64url = (bytes) => Buffer.from(bytes).toString("base64url");
const sha256 = (bytes) => new Uint8Array(createHash("sha256").update(bytes).digest());

/** A software passkey for PIM_URL, as test/webauthn.ts makes them for the Worker's tests. */
async function makePasskey(challenge) {
	const keys = await webcrypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, ["sign", "verify"]);
	const id = webcrypto.getRandomValues(new Uint8Array(16));
	const authenticatorData = Buffer.concat([sha256(pim.hostname), Buffer.from([0x45, 0, 0, 0, 0]), Buffer.alloc(16), Buffer.from([0, id.length]), id, Buffer.from([0xa0])]);
	return {
		id: b64url(id),
		clientDataJSON: b64url(Buffer.from(JSON.stringify({ type: "webauthn.create", challenge, origin: pim.origin }))),
		authenticatorData: b64url(authenticatorData),
		publicKey: b64url(new Uint8Array(await webcrypto.subtle.exportKey("spki", keys.publicKey))),
		publicKeyAlgorithm: -7,
		name: "Scratch passkey",
	};
}

const cookiesOf = (res) => (res.headers["set-cookie"] ?? []).map((cookie) => cookie.split(";")[0]).join("; ");
// The smallest PNG: one transparent pixel.
const PIXEL = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=";

async function waitForLog(pattern) {
	for (let i = 0; i < 100; i++) {
		const match = pattern.exec(readFileSync(CELLD_LOG, "utf8"));
		if (match) return match;
		await new Promise((resolve) => setTimeout(resolve, 100));
	}
	throw new Error(`${pattern} never appeared in ${CELLD_LOG}`);
}

async function setup() {
	const health = await call("GET", "/health");
	assert.deepEqual([health.status, health.json], [200, { name: "pim", ok: true }]);
	step("/health answers through the proxy");

	const index = readFileSync(`${WEB_DIST}/index.html`);
	const root = await call("GET", "/", { headers: { accept: "text/html" } });
	assert.equal(root.status, 200);
	assert.ok(root.bytes.equals(index), "/ isn't the build's index.html");
	const nav = await call("GET", "/settings/members", { headers: { accept: "text/html", "sec-fetch-mode": "navigate" } });
	assert.ok(nav.status === 200 && nav.bytes.equals(index), "a page of the app isn't index.html (single-page fallback)");
	const script = /src="(\/assets\/[^"]+\.js)"/.exec(index.toString())[1];
	const asset = await call("GET", script);
	assert.equal(asset.status, 200);
	assert.ok(asset.bytes.equals(readFileSync(`${WEB_DIST}${script}`)), `${script} isn't the build's`);
	step(`the web app is served from the build: /, a page of the app, ${script}`);

	const anonymous = await call("GET", "/api/account");
	assert.equal(anonymous.status, 401);
	assert.ok(anonymous.json, "/api/account answered with the app, not the Worker");
	step("/api/* goes to the Worker first (401 without a session)");

	// Straight to celld, past the proxy, as anything else on the machine could.
	const direct = (headers) => call("GET", "/api/account", { base: CELLD_URL, headers: { "x-forwarded-proto": "https", "x-forwarded-host": pim.host, ...headers } });
	if (RUNTIME === "1") {
		assert.equal((await direct({})).status, 403, "no ingress secret");
		assert.equal((await direct({ "x-pim-ingress-secret": "x".repeat(64), "x-pim-client-ip": "203.0.113.5" })).status, 403, "a wrong ingress secret");
		const secret = { "x-pim-ingress-secret": INGRESS_SECRET };
		for (const ip of ["203.0.113.5, 198.51.100.7", "[2001:db8::1]", "203.0.113.5:443", "not-an-ip", ""]) {
			assert.equal((await direct({ ...secret, "x-pim-client-ip": ip })).status, 400, `client address ${JSON.stringify(ip)}`);
		}
		assert.equal((await direct({ ...secret, "x-pim-client-ip": "2001:db8::1" })).status, 401, "the secret and an IPv6 address");
		assert.equal((await direct({ ...secret, "x-pim-client-ip": "203.0.113.5", "x-forwarded-proto": "http" })).status, 421, "http:// isn't PIM_PUBLIC_URL");
		step("past the proxy, Pim refuses a missing or wrong secret (403) and a bad client address (400), and needs https:// from the forwarded headers (421)");
	} else {
		assert.equal((await direct({ "x-forwarded-proto": "http" })).status, 421, "celld without the proxy's X-Forwarded-Proto isn't https://");
		step("without the proxy's forwarded headers Pim refuses the request (421); this Worker predates the celld runtime, so its ingress checks are skipped");
	}

	const asked = await call("POST", "/auth/setup-link", { headers: { origin: pim.origin }, body: {} });
	assert.equal(asked.status, 200, asked.text);
	const [, claim] = await waitForLog(/Pim setup link\. .*\/#claim=(\S+)/);
	step("the setup link to claim the Pim is in celld's log");

	const registered = await call("POST", "/auth/register", { headers: { origin: pim.origin }, body: { username: "ada", claim, timeZone: "UTC" } });
	assert.equal(registered.status, 201, registered.text);
	assert.equal(registered.json.role, "admin");
	const options = await call("POST", "/auth/passkeys/options", { headers: { origin: pim.origin }, body: { setup: registered.json.setup } });
	assert.equal(options.status, 200, options.text);
	const created = await call("POST", "/auth/passkeys", {
		headers: { origin: pim.origin, cookie: cookiesOf(options) },
		body: await makePasskey(options.json.challenge),
	});
	assert.equal(created.status, 200, created.text);
	const session = cookiesOf(created);
	const minted = await call("POST", "/auth/tokens", { headers: { origin: pim.origin, cookie: session }, body: { name: "scratch" } });
	assert.equal(minted.status, 201, minted.text);
	const token = minted.json.token;
	assert.match(token, /^pim_/);
	step("claimed as @ada, the admin, with a passkey; made an API token");

	const auth = { authorization: `Bearer ${token}` };
	const provider = await call("POST", "/api/providers", { headers: auth, body: { name: "Mock", url: MOCK_MODEL_URL } });
	assert.equal(provider.status, 200, provider.text);
	const chat = await call("POST", "/api/sessions", { headers: auth, body: {} });
	assert.equal(chat.status, 200, chat.text);
	const id = chat.json.id;
	const said = await call("POST", `/api/sessions/${id}/messages`, {
		headers: auth,
		body: { content: [{ type: "text", text: "hello from celld" }, { type: "image", data: PIXEL, mimeType: "image/png" }], wait: true },
	});
	assert.equal(said.status, 200, said.text);
	assert.match(said.text, /You said: hello from celld/);
	step("a chat answers through a model provider (the mock model), with an image");

	const transcript = await call("GET", `/api/sessions/${id}/messages`, { headers: auth });
	const image = /"url":"(\/api\/images\/[\w-]+)"/.exec(transcript.text)?.[1];
	assert.ok(image, "the message keeps no image URL");
	const stored = await call("GET", image, { headers: auth });
	assert.equal(stored.status, 200);
	assert.ok(stored.bytes.equals(Buffer.from(PIXEL, "base64")), "the image read back from R2 differs");
	step(`the image is kept in R2 (BLOBS) and reads back: ${image}`);

	const goal = await call("POST", `/api/sessions/${id}/messages`, {
		headers: auth,
		body: { content: '/tool create_goal {"title": "Run a 5k on celld", "steps": ["Run 2k"]}', wait: true },
	});
	assert.equal(goal.status, 200, goal.text);
	const goals = await call("GET", "/api/goals", { headers: auth });
	assert.ok(goals.json.goals.some((g) => g.title === "Run a 5k on celld"), goals.text);
	step("the agent made a goal");

	const socket = await webSocket(token);
	step(`a WebSocket to /api/ws opens through the proxy and the space speaks on it (${socket.length} bytes)`);

	writeFileSync(STATE, JSON.stringify({ token, session: id, image }));
}

/** Opens /api/ws through the proxy, and returns the first frame the space sends. */
function webSocket(token) {
	return new Promise((resolve, reject) => {
		const req = httpsRequest({
			host: "127.0.0.1",
			port: PROXY_PORT,
			path: "/api/ws",
			servername: pim.hostname,
			rejectUnauthorized: false,
			headers: { host: pim.host, origin: pim.origin, authorization: `Bearer ${token}`, connection: "Upgrade", upgrade: "websocket", "sec-websocket-version": "13", "sec-websocket-key": b64url(webcrypto.getRandomValues(new Uint8Array(16))) },
		});
		const timer = setTimeout(() => reject(new Error("the socket said nothing in 10 s")), 10_000);
		req.on("upgrade", (res, socket) => {
			assert.equal(res.statusCode, 101);
			socket.once("data", (frame) => {
				clearTimeout(timer);
				socket.destroy();
				resolve(frame);
			});
		});
		req.on("response", (res) => reject(new Error(`no upgrade: ${res.statusCode}`)));
		req.on("error", reject);
		req.end();
	});
}

async function verify() {
	const { token, session, image } = JSON.parse(readFileSync(STATE, "utf8"));
	const auth = { authorization: `Bearer ${token}` };
	const health = await call("GET", "/health");
	assert.equal(health.status, 200);
	const account = await call("GET", "/api/account", { headers: auth });
	assert.equal(account.status, 200, account.text);
	assert.match(account.text, /"ada"/);
	step("the token still opens @ada's account (Directory, Auth)");
	const transcript = await call("GET", `/api/sessions/${session}/messages`, { headers: auth });
	assert.match(transcript.text, /hello from celld/);
	step("the chat is still there (Pim)");
	const stored = await call("GET", image, { headers: auth });
	assert.ok(stored.status === 200 && stored.bytes.equals(Buffer.from(PIXEL, "base64")), "the image is gone from R2");
	step("the image still reads back (R2)");
	const goals = await call("GET", "/api/goals", { headers: auth });
	assert.ok(goals.json.goals.some((g) => g.title === "Run a 5k on celld"), goals.text);
	step("the goal is still there");
	const again = await call("POST", `/api/sessions/${session}/messages`, { headers: auth, body: { content: "still here?", wait: true } });
	assert.equal(again.status, 200, again.text);
	assert.match(again.text, /You said: still here\?/);
	step("it still takes writes: a new message is answered");
	await webSocket(token);
	step("WebSockets still open");
}

const phase = process.argv[2];
await (phase === "setup" ? setup() : phase === "verify" ? verify() : Promise.reject(new Error("usage: smoke.mjs setup|verify")));
