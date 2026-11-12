#!/usr/bin/env node
// Finds where a WebSocket breaks inside a coding workspace. Run it in the sandbox, on Compose and on Cloudflare, and compare:
//
//   node sandbox-ws-check.mjs                        # ampcode.com, the host Amp's CLI opens its thread WebSocket to
//   node sandbox-ws-check.mjs --ws-url wss://host/p  # any other wss endpoint that answers 101 (a Pim computer endpoint, an echo server)
//   node sandbox-ws-check.mjs --idle 120             # if the upgrade succeeds, keep the socket open this long, pinging every 15 s
//   node sandbox-ws-check.mjs --amp                  # also run `amp --execute` (needs AMP_API_KEY) and read its log
//
// It needs Node 22 and nothing else. It does HTTP/1.1 by hand so that every header on the way in and out is visible, and it
// goes through HTTPS_PROXY (Compose's egress proxy, by CONNECT) when that is set, and straight out otherwise (Cloudflare's
// transparent intercept). Each step prints PASS, FAIL or INFO; the last lines say which layer broke. Exit code 1 on any FAIL.
import { createHash, randomBytes } from "node:crypto";
import dns from "node:dns/promises";
import { spawnSync } from "node:child_process";
import net from "node:net";
import tls from "node:tls";

const args = process.argv.slice(2);
const flag = (name) => args.includes(`--${name}`);
const option = (name, fallback) => (args.includes(`--${name}`) ? args[args.indexOf(`--${name}`) + 1] : fallback);
const wsUrl = new URL(option("ws-url", "wss://ampcode.com/"));
const idleSeconds = Number(option("idle", 0));
const host = wsUrl.hostname;
const proxy = process.env.HTTPS_PROXY || process.env.https_proxy || "";
let failed = false;
const say = (status, text) => {
	if (status === "FAIL") failed = true;
	console.log(`${status.padEnd(4)} ${text}`);
};

/** Opens a TLS connection to host:443, through the CONNECT proxy when one is set. */
async function connect() {
	let socket;
	if (proxy) {
		const url = new URL(proxy);
		socket = net.connect(Number(url.port || 80), url.hostname);
		await new Promise((resolve, reject) => socket.once("connect", resolve).once("error", reject));
		socket.write(`CONNECT ${host}:443 HTTP/1.1\r\nhost: ${host}:443\r\n\r\n`);
		const reply = await new Promise((resolve, reject) => {
			let buffer = "";
			socket.on("data", function onData(chunk) {
				buffer += chunk.toString("latin1");
				if (buffer.includes("\r\n\r\n")) {
					socket.off("data", onData);
					resolve(buffer.split("\r\n")[0]);
				}
			});
			socket.once("error", reject);
			socket.once("close", () => reject(new Error("proxy closed the connection")));
		});
		if (!/ 200 /.test(reply)) throw new Error(`proxy answered "${reply}"`);
		say("PASS", `CONNECT ${host}:443 through ${url.host}: ${reply}`);
	}
	const secure = tls.connect({ ...(socket ? { socket } : { host, port: 443 }), servername: host, ALPNProtocols: ["http/1.1"] });
	await new Promise((resolve, reject) => secure.once("secureConnect", resolve).once("error", reject));
	return secure;
}

/** Sends one HTTP/1.1 request and returns the raw status line, headers and whatever followed them. */
async function exchange(socket, request) {
	socket.write(request);
	return await new Promise((resolve, reject) => {
		let buffer = Buffer.alloc(0);
		const timer = setTimeout(() => reject(new Error("no response within 15 s")), 15_000);
		const done = (error) => {
			clearTimeout(timer);
			socket.off("data", onData);
			error ? reject(error) : resolve(parse(buffer));
		};
		const onData = (chunk) => {
			buffer = Buffer.concat([buffer, chunk]);
			if (buffer.includes("\r\n\r\n")) done();
		};
		socket.on("data", onData);
		socket.once("error", done);
		socket.once("close", () => done(buffer.length ? undefined : new Error("connection closed with no response")));
	});
}
function parse(buffer) {
	const end = buffer.indexOf("\r\n\r\n");
	const [statusLine, ...lines] = buffer.subarray(0, end).toString("latin1").split("\r\n");
	const headers = Object.fromEntries(lines.map((line) => [line.slice(0, line.indexOf(":")).toLowerCase(), line.slice(line.indexOf(":") + 1).trim()]));
	return { statusLine, status: Number(statusLine.split(" ")[1]), headers, rest: buffer.subarray(end + 4) };
}

// 1. Environment: what routes traffic and what is trusted.
say("INFO", `HTTPS_PROXY=${proxy || "(unset: direct, as on Cloudflare's transparent intercept)"} NODE_EXTRA_CA_CERTS=${process.env.NODE_EXTRA_CA_CERTS || "-"} SSL_CERT_FILE=${process.env.SSL_CERT_FILE || "-"}`);

// 2. Name resolution. Cloudflare answers only for intercepted names, with a placeholder address.
try {
	const addresses = (await dns.lookup(host, { all: true })).map((a) => a.address);
	say("PASS", `DNS ${host} -> ${addresses.join(", ")}`);
} catch (error) {
	say(proxy ? "INFO" : "FAIL", `DNS ${host}: ${error.code ?? error.message}${proxy ? " (the proxy resolves for us)" : ""}`);
}

// 3. TLS: the certificate must verify against the system store. On Cloudflare it is signed by the intercept's CA.
let socket;
try {
	socket = await connect();
	const cert = socket.getPeerCertificate();
	say(socket.authorized ? "PASS" : "FAIL", `TLS ${host}: ${socket.authorized ? "trusted" : socket.authorizationError}; issuer ${cert.issuer?.O ?? cert.issuer?.CN ?? "?"}, ${socket.getProtocol()}`);
} catch (error) {
	say("FAIL", `TCP/TLS to ${host}:443: ${error.code ?? error.message}`);
	process.exit(1);
}

// 4. Plain HTTPS over the same kind of connection.
try {
	const response = await exchange(socket, `GET / HTTP/1.1\r\nhost: ${host}\r\nuser-agent: sandbox-ws-check\r\naccept: */*\r\nconnection: close\r\n\r\n`);
	say(response.status < 500 ? "PASS" : "FAIL", `HTTPS GET https://${host}/ -> ${response.statusLine}`);
} catch (error) {
	say("FAIL", `HTTPS GET https://${host}/: ${error.message}`);
}
socket.destroy();

// 5. The upgrade, twice: as Bun's WebSocket (the Amp CLI's) sends it, with permessage-deflate, and bare. A difference points at
// extension negotiation; a response that is not 101 shows what happened to Upgrade/Connection on the way.
async function upgrade(extensions) {
	const key = randomBytes(16).toString("base64");
	const secure = await connect();
	const request = [
		`GET ${wsUrl.pathname}${wsUrl.search} HTTP/1.1`,
		`Host: ${wsUrl.host}`,
		"Connection: Upgrade",
		"Upgrade: websocket",
		`Sec-WebSocket-Key: ${key}`,
		"Sec-WebSocket-Version: 13",
		...(extensions ? ["Sec-WebSocket-Extensions: permessage-deflate; client_max_window_bits"] : []),
		"User-Agent: sandbox-ws-check",
		"\r\n",
	].join("\r\n");
	const response = await exchange(secure, request);
	const accept = createHash("sha1").update(`${key}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`).digest("base64");
	return { secure, response, acceptOk: response.headers["sec-websocket-accept"] === accept };
}
let open;
for (const extensions of [true, false]) {
	const label = extensions ? "with permessage-deflate" : "without extensions";
	try {
		const { secure, response, acceptOk } = await upgrade(extensions);
		const shown = ["upgrade", "connection", "sec-websocket-accept", "sec-websocket-extensions", "server", "via", "content-type"].filter((name) => response.headers[name]).map((name) => `${name}: ${response.headers[name]}`);
		if (response.status === 101) {
			say(acceptOk ? "PASS" : "FAIL", `Upgrade ${label}: ${response.statusLine}${acceptOk ? "" : " but Sec-WebSocket-Accept is wrong (a middlebox rewrote the handshake)"}; ${shown.join("; ")}`);
			open ??= { secure, extensions: response.headers["sec-websocket-extensions"] };
			if (open.secure !== secure) secure.destroy();
		} else {
			say("INFO", `Upgrade ${label}: ${response.statusLine}; ${shown.join("; ")} (not 101: expected if ${wsUrl.pathname} wants credentials; a 403 with no server header, or a 200 page, means the upgrade was refused or stripped before it reached ${host})`);
			secure.destroy();
		}
	} catch (error) {
		say("FAIL", `Upgrade ${label}: ${error.message}`);
	}
}

// 6. A live socket: ping until --idle seconds pass, which shows idle timeouts and frames the intercept mangles.
if (open && idleSeconds > 0) {
	const { secure } = open;
	const frame = (opcode) => Buffer.concat([Buffer.from([0x80 | opcode, 0x80]), randomBytes(4)]); // empty, masked
	let opened = Date.now();
	let pongs = 0;
	secure.on("data", (chunk) => {
		for (let i = 0; i < chunk.length; ) {
			const opcode = chunk[i] & 0x0f;
			if (opcode === 0x0a) pongs++;
			if (opcode === 0x08) say("FAIL", `server closed the socket after ${Math.round((Date.now() - opened) / 1000)} s`);
			i += 2 + (chunk[i + 1] & 0x7f);
		}
	});
	secure.on("close", () => (opened = null));
	for (let waited = 0; waited < idleSeconds && opened; waited += 15) {
		secure.write(frame(0x09));
		await new Promise((resolve) => setTimeout(resolve, Math.min(15, idleSeconds - waited) * 1000));
	}
	say(opened ? "PASS" : "FAIL", `socket ${opened ? "stayed open" : "dropped"} for ${idleSeconds} s; ${pongs} pongs`);
	secure.destroy();
} else open?.secure.destroy();

// 7. The CLI itself. Its log names the failing layer; its exit says whether a turn can run at all.
if (flag("amp")) {
	if (!process.env.AMP_API_KEY) say("INFO", "--amp skipped: it needs AMP_API_KEY in the environment");
	else {
		const log = `/tmp/sandbox-ws-check-amp.log`;
		const run = spawnSync("amp", ["--no-ide", "--no-notifications", "--no-color", "--log-file", log, "--visibility", "private", "--mode", "low", "--execute=Reply with the single word ok. Do not use tools."], { encoding: "utf8", timeout: 120_000 });
		const output = `${run.stdout}${run.stderr}`.trim().split("\n").pop();
		say(run.status === 0 ? "PASS" : "FAIL", `amp --execute exited ${run.status}: ${output}`);
		say("INFO", `its log is ${log}; \`grep -E '"level":"(WARN|ERROR)"' ${log}\` shows each failed connection attempt`);
	}
}

console.log(
	failed
		? "\nA FAIL above is the first broken layer: DNS/TCP (egress allowlist or intercept), TLS (CA not trusted), the upgrade (handshake stripped or refused), or the live socket (idle or frame problem)."
		: "\nNo layer failed here. If Amp still says \"WebSocket connection failed\", run with --amp and read its log.",
);
process.exit(failed ? 1 : 0);
