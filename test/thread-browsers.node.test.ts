// Runs in Node: each thread's browser on its own display, against a fake displayd (over real HTTP), fake DevTools endpoints and a fake Chrome launcher.
import * as fs from "node:fs/promises";
import * as http from "node:http";
import type { AddressInfo } from "node:net";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { type ChromeLaunch, type ChromeProcess, DisplayClient, type DevToolsSocket, Link, type Machine, SIGNED_OUT, ThreadBrowsers, threadFolder } from "../computer/pim-computer";

const DAY = 24 * 60 * 60_000;
const PRIMARY_PORT = 9222;

type Lease = { id: string; threadId: string; state: string; cdpPort?: number; env?: Record<string, string>; driver?: { base: string; tokenFile: string }; [key: string]: unknown };

let dir: string;
let servers: http.Server[] = [];
beforeEach(async () => {
	dir = await fs.mkdtemp(path.join(os.tmpdir(), "thread-browsers-"));
	await fs.writeFile(path.join(dir, "token"), "secret\n");
});
afterEach(async () => {
	for (const server of servers.splice(0)) server.close();
	await fs.rm(dir, { recursive: true, force: true });
});

/** A fake displayd that hands out the leases it's given, and records what it's asked. */
async function displayd(leases: Record<string, Lease | (() => Lease)>) {
	const seen: { url: string; body: any }[] = [];
	const server = http.createServer((req, res) => {
		const chunks: Buffer[] = [];
		req.on("data", (chunk) => chunks.push(chunk));
		req.on("end", () => {
			const body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString()) : undefined;
			seen.push({ url: req.url!, body });
			res.writeHead(200, { "content-type": "application/json" });
			const resolve = (one: Lease | (() => Lease)) => (typeof one === "function" ? one() : one);
			if (req.url === "/acquire") res.end(JSON.stringify({ lease: resolve(leases[body.threadId]!) }));
			else if (req.url === "/displays") res.end(JSON.stringify({ displays: Object.values(leases).map(resolve) }));
			else res.end("{}");
		});
	});
	servers.push(server);
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
	return { seen, client: new DisplayClient({ url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, tokenFile: path.join(dir, "token") }) };
}

const lease = (thread: string, slot: number, extra: Partial<Lease> = {}): Lease => ({
	id: `lease-${thread}`,
	threadId: thread,
	state: "active",
	cdpPort: 9320 + slot,
	env: { DISPLAY: `:${100 + slot}`, XAUTHORITY: `/run/pim/displays/${thread}/Xauthority` },
	driver: { base: "http://127.0.0.1:1", tokenFile: path.join(dir, "token") },
	...extra,
});

const COOKIES = [
	{ name: "sid", value: "abc", domain: ".example.com", path: "/", secure: true, httpOnly: true, sameSite: "Lax", session: false, expires: 1_900_000_000, size: 6 },
	{ name: "tmp", value: "1", domain: "app.example.com", path: "/", secure: false, httpOnly: false, session: true, expires: -1 },
];

/** Fake DevTools endpoints by port: the primary one holds the person's sign-ins, a thread's answers once its Chrome was launched. */
function fakeWorld(primary: { cookies: unknown[]; storage?: [string, string][] }) {
	const up = new Set<number>([PRIMARY_PORT]);
	const calls: { port: number; method: string; params: any }[] = [];
	const launches: ChromeLaunch[] = [];
	const kills: { profile: string; signal?: string }[] = [];
	const channels: { port: number; sent: string[]; emit: (data: string) => void }[] = [];
	const devTools = async (port: number): Promise<DevToolsSocket> => {
		if (!up.has(port)) throw new Error(`nothing on ${port}`);
		let listener: (data: string) => void = () => {};
		const record = { port, sent: [] as string[], emit: (data: string) => listener(data) };
		channels.push(record);
		return {
			send(data) {
				record.sent.push(data);
				const { id, method, params } = JSON.parse(data);
				calls.push({ port, method, params });
				let result: unknown = {};
				if (method === "Storage.getCookies") result = { cookies: primary.cookies };
				else if (method === "Target.createTarget") result = { targetId: "t1" };
				else if (method === "Target.attachToTarget") result = { sessionId: "s1" };
				else if (method === "Runtime.evaluate") {
					const expression = String(params.expression);
					result = { result: { value: expression.includes("readyState") ? true : expression.includes("Object.entries") ? JSON.stringify(primary.storage ?? []) : null } };
				}
				queueMicrotask(() => listener(JSON.stringify({ id, result })));
			},
			onMessage: (l) => void (listener = l),
			onClose: () => {},
			close: () => {},
		};
	};
	const launch = async (spec: ChromeLaunch): Promise<ChromeProcess> => {
		launches.push(spec);
		up.add(Number(spec.args.find((arg) => arg.startsWith("--remote-debugging-port="))!.split("=")[1]));
		return { kill: (signal) => void kills.push({ profile: spec.profile, ...(signal ? { signal } : {}) }), onExit: () => {}, stderr: () => "" };
	};
	return { devTools, launch, calls, launches, kills, channels };
}

async function setup(options: { leases: Record<string, Lease | (() => Lease)>; cookies?: unknown[]; storage?: [string, string][]; origins?: string[]; now?: () => number }) {
	const world = fakeWorld({ cookies: options.cookies ?? COOKIES, ...(options.storage ? { storage: options.storage } : {}) });
	const primaryProfile = path.join(dir, "primary");
	await fs.mkdir(primaryProfile, { recursive: true });
	await fs.writeFile(path.join(primaryProfile, "DevToolsActivePort"), `${PRIMARY_PORT}\n/devtools/browser/x\n`);
	const storageOrigins = path.join(dir, "storage-origins.json");
	if (options.origins) await fs.writeFile(storageOrigins, JSON.stringify(options.origins));
	const fake = await displayd(options.leases);
	const root = path.join(dir, "threads");
	const primaryConnects: number[] = [];
	const browsers = new ThreadBrowsers({
		executable: "/usr/bin/chrome",
		root,
		primaryProfile,
		primary: { connect: async () => (primaryConnects.push(1), { send: () => {}, close: () => {} }), running: async () => true, stop: async () => {} },
		storageOrigins,
		displays: fake.client,
		log: () => {},
		devTools: world.devTools,
		launch: world.launch,
		startMs: 500,
		...(options.now ? { now: options.now } : {}),
	});
	return { ...world, browsers, displayd: fake, root, primaryProfile, primaryConnects };
}

describe("a browser for each thread", () => {
	it("starts a Chrome for each thread on its own display, port and clean profile, and copies the person's cookies into each", async () => {
		const { browsers, launches, calls, displayd: fake, root } = await setup({ leases: { a: lease("a", 0), b: lease("b", 1) } });
		const noop = () => {};
		const one = await browsers.connect("a", noop, noop);
		const two = await browsers.connect("b", noop, noop);
		expect(launches).toHaveLength(2);
		const [a, b] = launches as [ChromeLaunch, ChromeLaunch];
		expect(a.profile).toBe(path.join(root, "a", "chrome"));
		expect(b.profile).toBe(path.join(root, "b", "chrome"));
		expect(a.args).toContain(`--user-data-dir=${a.profile}`);
		expect(b.args).toContain(`--user-data-dir=${b.profile}`);
		expect(a.args).toContain("--remote-debugging-port=9320");
		expect(b.args).toContain("--remote-debugging-port=9321");
		expect(a.args).toContain("--disable-blink-features=AutomationControlled");
		expect(a.args.some((arg) => arg.startsWith("--password-store"))).toBe(false);
		expect(a.args.some((arg) => arg.startsWith("--headless"))).toBe(false);
		expect(a.env).toMatchObject({ DISPLAY: ":100", XAUTHORITY: "/run/pim/displays/a/Xauthority" });
		expect(b.env).toMatchObject({ DISPLAY: ":101", XAUTHORITY: "/run/pim/displays/b/Xauthority" });
		expect((await fs.stat(a.profile)).mode & 0o777).toBe(0o700);
		expect((await fs.stat(path.dirname(a.profile))).mode & 0o777).toBe(0o700);
		// The cookies came from the primary browser and went into each thread's, session cookies without an expiry.
		expect(calls.filter((call) => call.port === PRIMARY_PORT && call.method === "Storage.getCookies")).toHaveLength(2);
		for (const port of [9320, 9321]) {
			const set = calls.filter((call) => call.port === port && call.method === "Storage.setCookies");
			expect(set).toHaveLength(1);
			expect(set[0]!.params.cookies).toEqual([
				{ name: "sid", value: "abc", domain: ".example.com", path: "/", secure: true, httpOnly: true, sameSite: "Lax", expires: 1_900_000_000 },
				{ name: "tmp", value: "1", domain: "app.example.com", path: "/", secure: false, httpOnly: false },
			]);
		}
		// Before anyone drives it: the cookies were set before the channel was opened.
		expect(calls.findIndex((call) => call.port === 9320 && call.method === "Storage.setCookies")).toBeGreaterThanOrEqual(0);
		expect(one.note).toBeUndefined();
		expect(two.note).toBeUndefined();
		expect(fake.seen.filter((r) => r.url === "/touch").map((r) => r.body)).toEqual([
			{ threadId: "a", browser: true },
			{ threadId: "b", browser: true },
		]);
	});

	it("keeps one browser for a thread across connections, and each thread has its own channel in the link", async () => {
		const { browsers, launches, channels } = await setup({ leases: { a: lease("a", 0), b: lease("b", 1) } });
		const sent: any[] = [];
		const link = new Link({ root: dir, exec: async () => { throw new Error("no"); }, browser: { connect: async () => { throw new Error("primary must not be used"); }, running: async () => false, stop: async () => {} }, threadBrowsers: browsers }, (message) => sent.push(JSON.parse(String(message))));
		const call = async (id: string, op: string, args: Record<string, unknown>) => {
			link.receive(JSON.stringify({ type: "call", id, op, args }));
			for (let waited = 0; !sent.some((message) => message.id === id) && waited < 2_000; waited += 10) await new Promise((resolve) => setTimeout(resolve, 10));
			return sent.find((message) => message.id === id);
		};
		expect((await call("s0", "browser_status", { thread: "a" })).result).toEqual({ available: true, running: false });
		const a = (await call("c1", "browser_connect", { thread: "a" })).result.channel;
		const b = (await call("c2", "browser_connect", { thread: "b" })).result.channel;
		expect(a).not.toBe(b);
		expect(launches).toHaveLength(2);
		expect((await call("s1", "browser_status", { thread: "a" })).result.running).toBe(true);
		// A DevTools message goes to the browser of the channel it names, and back from it under that channel.
		const open = channels.filter((one) => one.port === 9320 || one.port === 9321);
		link.receive(JSON.stringify({ type: "cdp", channel: b, data: '{"id":9,"method":"Page.enable"}' }));
		expect(open.find((one) => one.port === 9321 && one.sent.includes('{"id":9,"method":"Page.enable"}'))).toBeTruthy();
		expect(open.some((one) => one.port === 9320 && one.sent.includes('{"id":9,"method":"Page.enable"}'))).toBe(false);
		open.filter((one) => one.port === 9320).at(-1)!.emit("from-a");
		expect(sent.filter((message) => message.type === "cdp")).toEqual([{ type: "cdp", channel: a, data: "from-a" }]);
		// A second connection for the same thread reuses its browser, and replaces its channel.
		const again = (await call("c3", "browser_connect", { thread: "a" })).result.channel;
		expect(again).not.toBe(a);
		expect(launches).toHaveLength(2);
		await call("x", "browser_stop", { thread: "a" });
		expect((await call("s2", "browser_status", { thread: "a" })).result.running).toBe(false);
		expect((await call("s3", "browser_status", { thread: "b" })).result.running).toBe(true);
	});

	it("tells the agent when the primary browser has no sign-ins, and copies nothing", async () => {
		const { browsers, calls } = await setup({ leases: { a: lease("a", 0) }, cookies: [] });
		const channel = await browsers.connect("a", () => {}, () => {});
		expect(channel.note).toBe(SIGNED_OUT);
		expect(SIGNED_OUT).toContain("ask the person to sign in on the Primary desktop in Computer; never ask for credentials in chat");
		expect(calls.some((call) => call.method === "Storage.setCookies")).toBe(false);
	});

	it("copies the localStorage of the listed origins only", async () => {
		// With no list, which is the default, none is copied.
		const without = await setup({ leases: { a: lease("a", 0) }, storage: [["theme", "dark"]] });
		await without.browsers.connect("a", () => {}, () => {});
		expect(without.calls.some((call) => call.method === "Target.createTarget")).toBe(false);
		const withOrigins = await setup({ leases: { a: lease("a", 0) }, storage: [["theme", "dark"]], origins: ["https://example.com"] });
		await withOrigins.browsers.connect("a", () => {}, () => {});
		const created = withOrigins.calls.filter((call) => call.method === "Target.createTarget").map((call) => `${call.port} ${call.params.url}`);
		expect(created).toEqual([`${PRIMARY_PORT} https://example.com/`, "9320 https://example.com/"]);
		const written = withOrigins.calls.find((call) => call.port === 9320 && call.method === "Runtime.evaluate" && String(call.params.expression).includes("setItem"));
		expect(written!.params.expression).toContain('[["theme","dark"]]');
	});

	it("reads the primary browser again when the person has signed in since", async () => {
		const world = await setup({ leases: { a: lease("a", 0) } });
		await world.browsers.connect("a", () => {}, () => {});
		await world.browsers.connect("a", () => {}, () => {});
		expect(world.calls.filter((call) => call.method === "Storage.getCookies")).toHaveLength(1);
		await fs.mkdir(path.join(world.primaryProfile, "Default"), { recursive: true });
		await fs.writeFile(path.join(world.primaryProfile, "Default", "Cookies"), "");
		const later = new Date(Date.now() + 10_000);
		await fs.utimes(path.join(world.primaryProfile, "Default", "Cookies"), later, later);
		await world.browsers.connect("a", () => {}, () => {});
		expect(world.calls.filter((call) => call.method === "Storage.getCookies")).toHaveLength(2);
		expect(world.launches).toHaveLength(1);
	});

	it("surfaces a queued display as a retryable error, and never starts a browser or falls back to the primary one", async () => {
		const { browsers, launches, primaryConnects } = await setup({ leases: { a: { id: "q", threadId: "a", state: "queued", position: 2 } } });
		const sent: any[] = [];
		const link = new Link({ root: dir, exec: async () => { throw new Error("no"); }, browser: { connect: async () => { throw new Error("primary must not be used"); }, running: async () => true, stop: async () => {} }, threadBrowsers: browsers }, (message) => sent.push(JSON.parse(String(message))));
		link.receive(JSON.stringify({ type: "call", id: "1", op: "browser_connect", args: { thread: "a" } }));
		await new Promise((resolve) => setTimeout(resolve, 200));
		expect(sent[0].error.message).toMatch(/^display_queued .*position 2 in the queue/);
		expect(launches).toEqual([]);
		expect(primaryConnects).toEqual([]);
	});

	it("starts a thread's browser again on a new display, and ends it when its display is gone", async () => {
		let current = lease("a", 0);
		const { browsers, launches, kills, root } = await setup({ leases: { a: () => current } });
		await browsers.connect("a", () => {}, () => {});
		current = lease("a", 1, { id: "lease-a2" });
		await browsers.connect("a", () => {}, () => {});
		expect(launches.map((launch) => launch.args.find((arg) => arg.startsWith("--remote-debugging-port=")))).toEqual(["--remote-debugging-port=9320", "--remote-debugging-port=9321"]);
		expect(kills.map((kill) => kill.signal)).toContain("SIGTERM");
		current = { ...current, state: "gone" };
		await browsers.check();
		expect(browsers.running("a")).toBe(false);
		expect(Number(await fs.readFile(path.join(root, "a", "ended"), "utf8"))).toBeGreaterThan(0);
	});
});

describe("the sweep of thread profiles", () => {
	it("removes a profile a day after its display went, and not before", async () => {
		let now = 1_000_000_000_000;
		const { browsers, root } = await setup({ leases: { live: lease("live", 0) }, now: () => now });
		for (const name of ["young", "old", "unseen", "live"]) await fs.mkdir(path.join(root, name, "chrome"), { recursive: true });
		await fs.writeFile(path.join(root, "young", "ended"), String(now - DAY + 60_000));
		await fs.writeFile(path.join(root, "old", "ended"), String(now - DAY - 60_000));
		await fs.writeFile(path.join(root, "live", "ended"), String(now - 5 * DAY));
		await browsers.sweep();
		const left = (await fs.readdir(root)).sort();
		expect(left).toEqual(["live", "unseen", "young"]);
		// The one it hadn't seen go starts its day now; the one with a display is kept and unmarked.
		expect(Number(await fs.readFile(path.join(root, "unseen", "ended"), "utf8"))).toBe(now);
		await expect(fs.stat(path.join(root, "live", "ended"))).rejects.toThrow();
		now += DAY + 1;
		await browsers.sweep();
		expect((await fs.readdir(root)).sort()).toEqual(["live"]);
	});

	it("names a thread's folder safely", () => {
		expect(threadFolder("conv_123")).toBe("conv_123");
		expect(threadFolder("../../etc")).toMatch(/^etc-[0-9a-f]{12}$/);
		expect(threadFolder("../../etc")).not.toBe(threadFolder("../../Etc"));
		expect(threadFolder("a/b")).not.toContain("/");
	});
});
