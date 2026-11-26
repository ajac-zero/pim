// A small Chrome DevTools Protocol client for the web-perf scripts: starts a headless Chrome with a fresh profile, signs in through the preview's
// development route, and gives back `send`, `evalJs`, the requests the page made, and `close`. Needs Node's WebSocket (Node 22+) and Chrome:
// set CHROME, or it looks for the one `agent-browser` installs and then for `google-chrome` and `chromium` on the PATH.
import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";

export const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function chromePath() {
	if (process.env.CHROME) return process.env.CHROME;
	const browsers = join(homedir(), ".agent-browser", "browsers");
	if (existsSync(browsers)) {
		for (const name of readdirSync(browsers)) if (existsSync(join(browsers, name, "chrome"))) return join(browsers, name, "chrome");
	}
	for (const name of ["google-chrome", "chromium", "chromium-browser"]) if (spawnSync("which", [name]).status === 0) return name;
	throw new Error("No Chrome found: set CHROME");
}

/**
 * @param {{ base: string, user?: string, throttle?: { rtt: number, mbps: number } | null, bypassServiceWorker?: boolean }} options
 */
export async function launch({ base, user = "perf", throttle = { rtt: 60, mbps: 20 }, bypassServiceWorker = false }) {
	const port = 9300 + Math.floor(Math.random() * 500);
	const dir = mkdtempSync(join(tmpdir(), "pim-web-perf-"));
	const chrome = spawn(chromePath(), [`--remote-debugging-port=${port}`, `--user-data-dir=${dir}`, "--headless=new", "--no-sandbox", "--disable-gpu", "--no-first-run", "about:blank"], { stdio: "ignore" });
	let targets;
	for (let i = 0; i < 50 && !targets; i++) {
		try {
			targets = await (await fetch(`http://127.0.0.1:${port}/json`)).json();
		} catch {
			await sleep(200);
		}
	}
	const ws = new WebSocket(targets.find((t) => t.type === "page").webSocketDebuggerUrl);
	await new Promise((resolve) => (ws.onopen = resolve));
	let id = 0;
	const waiting = new Map();
	const listeners = [];
	ws.onmessage = (event) => {
		const message = JSON.parse(event.data);
		if (message.id && waiting.has(message.id)) {
			waiting.get(message.id)(message);
			waiting.delete(message.id);
		} else for (const listener of listeners) listener(message);
	};
	const send = (method, params = {}) =>
		new Promise((resolve, reject) => {
			const n = ++id;
			waiting.set(n, (message) => (message.error ? reject(new Error(JSON.stringify(message.error))) : resolve(message.result)));
			ws.send(JSON.stringify({ id: n, method, params }));
		});
	const evalJs = async (expression) => (await send("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true })).result.value;

	/** The requests since `reset()`: url, status, bytes on the wire, whether the cache or the service worker answered, and the cache headers. */
	let requests = new Map();
	const sockets = { created: 0, closed: 0 };
	listeners.push((message) => {
		const p = message.params;
		if (message.method === "Network.requestWillBeSent") requests.set(p.requestId, { url: p.request.url, type: p.type, bytes: 0, status: null, cached: false });
		if (message.method === "Network.requestServedFromCache" && requests.has(p.requestId)) requests.get(p.requestId).cached = true;
		if (message.method === "Network.responseReceived" && requests.has(p.requestId)) {
			const r = requests.get(p.requestId);
			r.status = p.response.status;
			r.fromSW = p.response.fromServiceWorker;
			r.headers = p.response.headers;
		}
		if (message.method === "Network.loadingFinished" && requests.has(p.requestId)) requests.get(p.requestId).bytes = p.encodedDataLength;
		if (message.method === "Network.webSocketCreated") sockets.created++;
		if (message.method === "Network.webSocketClosed") sockets.closed++;
	});
	await send("Network.enable");
	await send("Page.enable");
	await send("Runtime.enable");
	await send("Emulation.setDeviceMetricsOverride", { width: 1280, height: 800, deviceScaleFactor: 1, mobile: false });
	if (bypassServiceWorker) await send("Network.setBypassServiceWorker", { bypass: true });
	const signIn = await fetch(`${base}/__dev/sign-in/${user}`, { redirect: "manual" });
	for (const cookie of signIn.headers.getSetCookie()) {
		const [pair] = cookie.split(";");
		const [name, ...value] = pair.split("=");
		await send("Network.setCookie", { name, value: value.join("="), url: base, httpOnly: true });
	}
	if (throttle) await send("Network.emulateNetworkConditions", { offline: false, latency: throttle.rtt, downloadThroughput: (throttle.mbps * 1e6) / 8, uploadThroughput: (10 * 1e6) / 8 });
	const waitFor = async (expression, timeout = 30_000) => {
		const t = Date.now();
		while (Date.now() - t < timeout) {
			if (await evalJs(expression)) return Date.now() - t;
			await sleep(25);
		}
		throw new Error(`timeout waiting for ${expression}`);
	};
	return {
		send,
		evalJs,
		waitFor,
		sockets,
		reset: () => (requests = new Map()),
		requests: () => [...requests.values()],
		async close() {
			ws.close();
			chrome.kill();
			await sleep(300);
			try {
				rmSync(dir, { recursive: true, force: true, maxRetries: 5 });
			} catch {}
		},
	};
}
