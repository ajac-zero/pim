// Runs in Node: each agent's browser as a context of its own in one shared Chrome, against a fake Chrome that keeps contexts, windows and cookies as DevTools does.
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { AgentBrowsers, type BrowserHost, Link, SIGNED_OUT, threadFolder } from "../pim-computer";

type Cookie = Record<string, unknown>;

let dir: string;
beforeEach(async () => {
	dir = await fs.mkdtemp(path.join(os.tmpdir(), "agent-browsers-"));
});
afterEach(async () => {
	await fs.rm(dir, { recursive: true, force: true });
});

const COOKIES = [
	{ name: "sid", value: "abc", domain: ".example.com", path: "/", secure: true, httpOnly: true, sameSite: "Lax", session: false, expires: 1_900_000_000, size: 6 },
	{ name: "tmp", value: "1", domain: "app.example.com", path: "/", secure: false, httpOnly: false, session: true, expires: -1 },
];

/** A fake Chrome: browser contexts with their cookies, and windows (targets) in them. `cookies` is what its default context has, as the primary browser's. */
function fakeChrome(name: string, cookies: Cookie[] = [], storage: [string, string][] = []) {
	const state = { running: false, starts: 0, nextContext: 1, nextTarget: 1 };
	const contexts = new Map<string, Cookie[]>();
	const targets: { targetId: string; type: string; url: string; browserContextId: string }[] = [];
	const calls: { method: string; params: any }[] = [];
	const host: BrowserHost = {
		running: async () => state.running,
		stop: async () => {
			state.running = false;
			contexts.clear();
			targets.length = 0;
		},
		async connect(onMessage) {
			if (!state.running) (state.running = true), state.starts++;
			return {
				send(data) {
					const { id, method, params = {}, sessionId } = JSON.parse(data);
					calls.push({ method, params });
					let result: unknown = {};
					if (method === "Target.createBrowserContext") contexts.set((result = { browserContextId: `${name}-ctx${state.nextContext++}` }).browserContextId, []);
					else if (method === "Target.getBrowserContexts") result = { browserContextIds: [...contexts.keys()] };
					else if (method === "Target.disposeBrowserContext") {
						contexts.delete(params.browserContextId);
						for (let i = targets.length - 1; i >= 0; i--) if (targets[i]!.browserContextId === params.browserContextId) targets.splice(i, 1);
					} else if (method === "Storage.setCookies") contexts.get(params.browserContextId)?.push(...params.cookies);
					else if (method === "Storage.getCookies") result = { cookies: params.browserContextId ? (contexts.get(params.browserContextId) ?? []) : cookies };
					else if (method === "Target.createTarget") {
						const target = { targetId: `${name}-t${state.nextTarget++}`, type: "page", url: params.url, browserContextId: params.browserContextId ?? "default" };
						targets.push(target);
						result = { targetId: target.targetId };
					} else if (method === "Target.closeTarget") {
						const at = targets.findIndex((t) => t.targetId === params.targetId);
						if (at >= 0) targets.splice(at, 1);
					} else if (method === "Target.getTargets") result = { targetInfos: targets };
					else if (method === "Target.attachToTarget") result = { sessionId: "s1" };
					else if (method === "Runtime.evaluate") {
						const expression = String(params.expression);
						result = { result: { value: expression.includes("readyState") ? true : expression.includes("Object.entries") ? JSON.stringify(storage) : null } };
					}
					queueMicrotask(() => onMessage(JSON.stringify({ id, result, ...(sessionId ? { sessionId } : {}) })));
				},
				close: () => {},
			};
		},
	};
	return { host, state, contexts, targets, calls };
}

async function setup(options: { cookies?: Cookie[]; storage?: [string, string][]; origins?: string[]; sites?: Record<string, { max: number; domains: string[] }> } = {}) {
	const shared = fakeChrome("shared");
	const primary = fakeChrome("primary", options.cookies ?? COOKIES, options.storage);
	const primaryProfile = path.join(dir, "primary");
	await fs.mkdir(primaryProfile, { recursive: true });
	const storageOrigins = path.join(dir, "storage-origins.json");
	if (options.origins) await fs.writeFile(storageOrigins, JSON.stringify(options.origins));
	const root = path.join(dir, "agents");
	const browsers = new AgentBrowsers({ shared: shared.host, root, primaryProfile, primary: primary.host, storageOrigins, sites: async () => options.sites, log: () => {} });
	const sent: any[] = [];
	const link = new Link({ root: dir, exec: async () => { throw new Error("no"); }, browser: { connect: async () => { throw new Error("the primary must not be used"); }, running: async () => false, stop: async () => {} }, agentBrowsers: browsers }, (message) => sent.push(JSON.parse(String(message))));
	let next = 0;
	const call = async (op: string, args: Record<string, unknown>) => {
		const id = `c${next++}`;
		link.receive(JSON.stringify({ type: "call", id, op, args }));
		for (let waited = 0; !sent.some((message) => message.id === id) && waited < 2_000; waited += 5) await new Promise((resolve) => setTimeout(resolve, 5));
		const reply = sent.find((message) => message.id === id);
		if (reply.error) throw new Error(reply.error.message);
		return reply.result;
	};
	/** Sends a DevTools command on a channel and waits for its answer. */
	const cdp = async (channel: number, method: string, params: Record<string, unknown> = {}, sessionId?: string) => {
		const id = 1000 + next++;
		link.receive(JSON.stringify({ type: "cdp", channel, data: JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }) }));
		for (let waited = 0; waited < 2_000; waited += 5) {
			const answer = sent.find((message) => message.type === "cdp" && message.channel === channel && JSON.parse(message.data).id === id);
			if (answer) return JSON.parse(answer.data).result;
			await new Promise((resolve) => setTimeout(resolve, 5));
		}
		throw new Error(`no answer to ${method}`);
	};
	return { shared, primary, browsers, root, primaryProfile, link, call, cdp };
}

const names = (cookies: Cookie[] | undefined) => (cookies ?? []).map((cookie) => cookie.name).sort();

describe("a browser for each agent", () => {
	it("gives each agent a context of its own in one shared Chrome, which all its chats share, with the person's sign-ins copied in", async () => {
		const { shared, call } = await setup();
		expect(await call("browser_status", { thread: "chat-1", agent: "ada" })).toEqual({ available: true, running: false, agents: true });
		const one = await call("browser_connect", { thread: "chat-1", agent: "ada" });
		const two = await call("browser_connect", { thread: "chat-2", agent: "ada" });
		const other = await call("browser_connect", { thread: "chat-3", agent: "bob" });
		expect(shared.state.starts).toBe(1);
		expect(one.context).toBe(two.context);
		expect(other.context).not.toBe(one.context);
		expect([...shared.contexts.keys()].sort()).toEqual([one.context, other.context].sort());
		// Session cookies go in without an expiry.
		expect(shared.contexts.get(one.context)).toEqual([
			{ name: "sid", value: "abc", domain: ".example.com", path: "/", secure: true, httpOnly: true, sameSite: "Lax", expires: 1_900_000_000 },
			{ name: "tmp", value: "1", domain: "app.example.com", path: "/", secure: false, httpOnly: false },
		]);
		expect(names(shared.contexts.get(other.context))).toEqual(["sid", "tmp"]);
		expect(await call("browser_status", { thread: "chat-1", agent: "ada" })).toEqual({ available: true, running: true, agents: true });
		// A chat of an agent with no browser yet: not running, though another agent's is.
		expect((await call("browser_status", { thread: "chat-4", agent: "cy" })).running).toBe(false);
	});

	it("keeps an agent's windows and downloads in its context, and shows a chat's viewer only that chat's windows", async () => {
		const { shared, call, cdp } = await setup();
		const ada1 = await call("browser_connect", { thread: "chat-1", agent: "ada" });
		const { targetId: mine } = await cdp(ada1.channel, "Target.createTarget", { url: "https://one.example/" });
		await cdp(ada1.channel, "Browser.setDownloadBehavior", { behavior: "allow", downloadPath: "/tmp/d" });
		const ada2 = await call("browser_connect", { thread: "chat-2", agent: "ada" });
		// Puppeteer opens a window on a session it attached to the browser.
		const { targetId: sibling } = await cdp(ada2.channel, "Target.createTarget", { url: "https://two.example/" }, "browser-session");
		const bob = await call("browser_connect", { thread: "chat-3", agent: "bob" });
		const { targetId: bobs } = await cdp(bob.channel, "Target.createTarget", { url: "https://bob.example/" });
		expect(shared.targets.find((t) => t.targetId === mine)!.browserContextId).toBe(ada1.context);
		expect(shared.targets.find((t) => t.targetId === sibling)!.browserContextId).toBe(ada1.context);
		expect(shared.targets.find((t) => t.targetId === bobs)!.browserContextId).toBe(bob.context);
		expect(shared.calls.find((c) => c.method === "Browser.setDownloadBehavior")!.params.browserContextId).toBe(ada1.context);
		// The agent sees all its own windows, and none of another agent's.
		const listed = (await cdp(ada2.channel, "Target.getTargets")).targetInfos.map((t: any) => t.targetId);
		expect(listed.sort()).toEqual([mine, sibling].sort());
		// A viewer of chat-1 (it names no agent) sees chat-1's window alone, beside the agent's own channel, which goes on.
		const viewer = await call("browser_connect", { thread: "chat-1" });
		expect(viewer.context).toBe(ada1.context);
		expect((await cdp(viewer.channel, "Target.getTargets")).targetInfos.map((t: any) => t.targetId)).toEqual([mine]);
		expect((await cdp(ada1.channel, "Target.getTargets")).targetInfos.map((t: any) => t.targetId).sort()).toEqual([mine, sibling].sort());
		// The viewer leaves, by its channel; the agent's stays.
		await call("browser_disconnect", { thread: "chat-1", channel: viewer.channel });
		expect((await cdp(ada1.channel, "Target.getTargets")).targetInfos).toHaveLength(2);
		expect((await call("browser_status", { thread: "chat-1" })).running).toBe(true);
		// A thread nobody browsed in has no browser to view.
		expect((await call("browser_status", { thread: "chat-9" })).running).toBe(false);
	});

	it("saves an agent's sign-ins when its last connection closes, and restores them under the person's after the shared Chrome quit", async () => {
		const { shared, call, root } = await setup();
		const first = await call("browser_connect", { thread: "chat-1", agent: "ada" });
		// The agent signs in somewhere the person never did, and to example.com as someone else.
		shared.contexts.get(first.context)!.push({ name: "own", value: "x", domain: ".agent-only.example", path: "/", expires: 2_000_000_000 }, { name: "sid", value: "agent", domain: ".example.com", path: "/", expires: 2_000_000_000 }, { name: "old", value: "x", domain: ".gone.example", path: "/", expires: 1 });
		await call("browser_disconnect", { thread: "chat-1", channel: first.channel });
		await new Promise((resolve) => setTimeout(resolve, 50));
		const jar = path.join(root, "ada", "cookies.json");
		expect((await fs.stat(jar)).mode & 0o777).toBe(0o600);
		expect((await fs.stat(path.dirname(jar))).mode & 0o777).toBe(0o700);
		expect(names(JSON.parse(await fs.readFile(jar, "utf8")))).toEqual(["old", "own", "sid", "sid", "tmp"]);

		// The shared Chrome quits after a while unused, and its contexts go with it.
		await shared.host.stop();
		expect((await call("browser_status", { thread: "chat-1", agent: "ada" })).running).toBe(false);
		const again = await call("browser_connect", { thread: "chat-5", agent: "ada" });
		const restored = shared.contexts.get(again.context)!;
		// The expired one stays out; the agent's own come first, so the person's sid, set after, wins.
		expect(restored.some((cookie) => cookie.name === "old")).toBe(false);
		expect(restored.some((cookie) => cookie.name === "own")).toBe(true);
		expect(restored.filter((cookie) => cookie.name === "sid").at(-1)!.value).toBe("abc");
		// Another agent has none of it.
		const bob = await call("browser_connect", { thread: "chat-6", agent: "bob" });
		expect(names(shared.contexts.get(bob.context))).toEqual(["sid", "tmp"]);
	});

	it("closes a chat's windows on stop, and its agent's context once it has no window left and nobody connected, saving its sign-ins first", async () => {
		const { shared, call, cdp, root } = await setup();
		const ada1 = await call("browser_connect", { thread: "chat-1", agent: "ada" });
		const { targetId: first } = await cdp(ada1.channel, "Target.createTarget", { url: "https://one.example/" });
		const ada2 = await call("browser_connect", { thread: "chat-2", agent: "ada" });
		const { targetId: second } = await cdp(ada2.channel, "Target.createTarget", { url: "https://two.example/" });
		const bob = await call("browser_connect", { thread: "chat-3", agent: "bob" });
		// As the web app's Close, which names no agent: only chat-1's window closes.
		await call("browser_stop", { thread: "chat-1" });
		expect(shared.targets.map((t) => t.targetId)).toEqual([second]);
		expect(shared.targets.some((t) => t.targetId === first)).toBe(false);
		expect(shared.contexts.has(ada1.context)).toBe(true);
		// Ada's connections close; closing its last window closes its context, and Bob's stays.
		await call("browser_disconnect", { thread: "chat-1", channel: ada1.channel });
		await call("browser_disconnect", { thread: "chat-2", channel: ada2.channel });
		await call("browser_stop", { thread: "chat-2", agent: "ada" });
		expect([...shared.contexts.keys()]).toEqual([bob.context]);
		expect(names(JSON.parse(await fs.readFile(path.join(root, "ada", "cookies.json"), "utf8")))).toEqual(["sid", "tmp"]);
		expect((await call("browser_status", { thread: "chat-1", agent: "ada" })).running).toBe(false);
	});

	it("tells the agent when there are no sign-ins anywhere, and copies nothing", async () => {
		const { shared, call } = await setup({ cookies: [] });
		const channel = await call("browser_connect", { thread: "chat-1", agent: "ada" });
		expect(channel.note).toBe(SIGNED_OUT);
		expect(SIGNED_OUT).toContain("ask the person to sign in on the Primary desktop in Computer; never ask for credentials in chat");
		expect(shared.calls.some((c) => c.method === "Storage.setCookies")).toBe(false);
	});

	it("lets one agent at a time have a limited site's cookies (LinkedIn by default), and the next once the first lets go", async () => {
		const cookies = [
			{ name: "li_at", value: "1", domain: ".www.linkedin.com", path: "/", secure: true, httpOnly: true },
			{ name: "bcookie", value: "2", domain: ".licdn.com", path: "/", secure: true, httpOnly: false },
			{ name: "notlinkedin", value: "3", domain: ".evilinkedin.com", path: "/", secure: false, httpOnly: false },
			{ name: "sid", value: "abc", domain: ".example.com", path: "/", secure: true, httpOnly: true },
		];
		const { shared, call } = await setup({ cookies });
		const ada = await call("browser_connect", { thread: "chat-1", agent: "ada" });
		expect(ada.note).toBeUndefined();
		expect(names(shared.contexts.get(ada.context))).toEqual(["bcookie", "li_at", "notlinkedin", "sid"]);
		// Another chat of the same agent shares its slot.
		const ada2 = await call("browser_connect", { thread: "chat-2", agent: "ada" });
		expect(ada2.note).toBeUndefined();

		const refused = "Signed-in access to linkedin.com is limited to 1 agent(s) at a time to avoid account flags, and another agent holds it. Use the Primary desktop for linkedin.com (ask the person to do the task there or wait), or retry later; never ask for credentials in chat.";
		const bob = await call("browser_connect", { thread: "chat-3", agent: "bob" });
		expect(bob.note).toBe(refused);
		expect(names(shared.contexts.get(bob.context))).toEqual(["notlinkedin", "sid"]);
		expect((await call("browser_connect", { thread: "chat-3", agent: "bob" })).note).toBe(refused);
		expect(names(shared.contexts.get(bob.context))).toEqual(["notlinkedin", "sid"]);

		// Ada's browser closes; Bob connects again and gets LinkedIn's cookies alone, once.
		for (const [thread, channel] of [["chat-1", ada.channel], ["chat-2", ada2.channel]]) await call("browser_disconnect", { thread, channel });
		await call("browser_stop", { thread: "chat-1", agent: "ada" });
		expect((await call("browser_connect", { thread: "chat-3", agent: "bob" })).note).toBeUndefined();
		expect(names(shared.contexts.get(bob.context))).toEqual(["bcookie", "li_at", "notlinkedin", "sid"]);
		expect((await call("browser_connect", { thread: "chat-1", agent: "ada" })).note).toBe(refused);
	});

	it("takes the limited sites from displayd where it lists them, and copies every cookie when it lists none", async () => {
		const { shared, call } = await setup({ cookies: [{ name: "li_at", value: "1", domain: ".linkedin.com", path: "/" }], sites: {} });
		await call("browser_connect", { thread: "chat-1", agent: "ada" });
		const bob = await call("browser_connect", { thread: "chat-2", agent: "bob" });
		expect(bob.note).toBeUndefined();
		expect(names(shared.contexts.get(bob.context))).toEqual(["li_at"]);
	});

	it("copies the localStorage of the listed origins only, into the agent's context", async () => {
		const without = await setup({ storage: [["theme", "dark"]] });
		await without.call("browser_connect", { thread: "chat-1", agent: "ada" });
		expect(without.shared.calls.some((c) => c.method === "Target.createTarget")).toBe(false);
		const withOrigins = await setup({ storage: [["theme", "dark"]], origins: ["https://example.com"] });
		const ada = await withOrigins.call("browser_connect", { thread: "chat-1", agent: "ada" });
		expect(withOrigins.primary.calls.find((c) => c.method === "Target.createTarget")!.params.url).toBe("https://example.com/");
		const made = withOrigins.shared.calls.find((c) => c.method === "Target.createTarget")!;
		expect(made.params).toMatchObject({ url: "https://example.com/", browserContextId: ada.context });
		const written = withOrigins.shared.calls.find((c) => c.method === "Runtime.evaluate" && String(c.params.expression).includes("setItem"));
		expect(written!.params.expression).toContain('[["theme","dark"]]');
	});

	it("reads the primary browser again when the person has signed in since", async () => {
		const { primary, call, primaryProfile } = await setup();
		await call("browser_connect", { thread: "chat-1", agent: "ada" });
		await call("browser_connect", { thread: "chat-1", agent: "ada" });
		const reads = () => primary.calls.filter((c) => c.method === "Storage.getCookies").length;
		expect(reads()).toBe(1);
		await fs.mkdir(path.join(primaryProfile, "Default"), { recursive: true });
		await fs.writeFile(path.join(primaryProfile, "Default", "Cookies"), "");
		const later = new Date(Date.now() + 10_000);
		await fs.utimes(path.join(primaryProfile, "Default", "Cookies"), later, later);
		await call("browser_connect", { thread: "chat-1", agent: "ada" });
		expect(reads()).toBe(2);
	});

	it("refuses a viewer of a chat that hasn't browsed, without making a context for it", async () => {
		const { shared, call } = await setup();
		await expect(call("browser_connect", { thread: "chat-1" })).rejects.toThrow("This chat has no browser open.");
		expect(shared.state.starts).toBe(0);
	});

	it("names an agent's folder safely", () => {
		expect(threadFolder("conv_123")).toBe("conv_123");
		expect(threadFolder("../../etc")).toMatch(/^etc-[0-9a-f]{12}$/);
		expect(threadFolder("../../etc")).not.toBe(threadFolder("../../Etc"));
		expect(threadFolder("a/b")).not.toContain("/");
	});
});
