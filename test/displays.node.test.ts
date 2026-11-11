// Runs in Node: the computer's display routing talks to a fake displayd and fake Cua Drivers over real HTTP.
import * as fs from "node:fs/promises";
import * as http from "node:http";
import type { AddressInfo } from "node:net";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { DisplayClient, handle, Link, type Machine, runCommand } from "../computer/pim-computer";

type Req = { method: string; url: string; body: any; auth?: string };

function serve(handler: (req: Req) => { status?: number; json: unknown }) {
	const seen: Req[] = [];
	const server = http.createServer((req, res) => {
		const chunks: Buffer[] = [];
		req.on("data", (c) => chunks.push(c));
		req.on("end", () => {
			const text = Buffer.concat(chunks).toString();
			const r: Req = { method: req.method!, url: req.url!, body: text ? JSON.parse(text) : undefined, auth: req.headers.authorization };
			seen.push(r);
			const out = handler(r);
			res.writeHead(out.status ?? 200, { "content-type": "application/json" });
			res.end(JSON.stringify(out.json));
		});
	});
	return new Promise<{ base: string; seen: Req[]; close: () => void }>((resolve) =>
		server.listen(0, "127.0.0.1", () => resolve({ base: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, seen, close: () => server.close() })),
	);
}

/** A fake Cua Driver MCP server: it answers every tool call with its own name and what it received. */
const fakeDriver = (name: string) =>
	serve((r) => {
		if (r.body.method === "initialize") return { json: { jsonrpc: "2.0", id: r.body.id, result: {} } };
		if (r.body.method === "tools/call") {
			return { json: { jsonrpc: "2.0", id: r.body.id, result: { content: [{ type: "text", text: JSON.stringify({ driver: name, ...r.body.params }) }] } } };
		}
		return { json: {} };
	});

const closers: (() => void)[] = [];
let dir: string;
beforeEach(async () => {
	dir = await fs.mkdtemp(path.join(os.tmpdir(), "displays-"));
	await fs.writeFile(path.join(dir, "token"), "secret\n");
});
afterEach(async () => {
	for (const close of closers.splice(0)) close();
	await fs.rm(dir, { recursive: true, force: true });
});
const start = async <T extends { close: () => void }>(server: Promise<T>) => {
	const s = await server;
	closers.push(s.close);
	return s;
};
const tokenFile = () => path.join(dir, "token");

const lease = (thread: string, driver: { base: string }, state = "active") => ({
	threadId: thread,
	state,
	env: { DISPLAY: `:${thread === "a" ? 100 : 101}`, XAUTHORITY: "/x" },
	driver: { base: driver.base, tokenFile: tokenFile() },
});
const text = (result: any) => result.content[0].text as string;

async function setup(leases: (thread: string) => { status?: number; json: unknown }) {
	const primary = await start(fakeDriver("primary"));
	const displayd = await start(serve((r) => (r.url === "/acquire" ? leases(r.body.threadId) : r.url === "/touch" ? { json: {} } : { json: { displays: [] } })));
	const machine = (extra: Partial<Machine> = {}): Machine => ({
		root: dir,
		exec: async (args) => ({ exitCode: 0, signal: null, stdout: JSON.stringify(args.env ?? null), stderr: "", timedOut: false, truncated: false }),
		displays: new DisplayClient({ url: displayd.base, tokenFile: tokenFile() }),
		...extra,
	});
	return { primary, displayd, machine };
}

describe("driver calls with a thread", () => {
	it("routes two threads to their own displays, touches them, and defaults input to the foreground", async () => {
		const a = await start(fakeDriver("a"));
		const b = await start(fakeDriver("b"));
		const { primary, displayd, machine } = await setup((t) => ({ json: { lease: lease(t, t === "a" ? a : b) } }));
		const m = machine();
		const one = await (m.displays as DisplayClient).call("a", "click", { x: 1 });
		const two = await (m.displays as DisplayClient).call("b", "get_desktop_state", { session: "pim-b" });
		expect(JSON.parse(text(one))).toMatchObject({ driver: "a", name: "click", arguments: { x: 1, delivery_mode: "foreground" } });
		const sent = JSON.parse(text(two));
		expect(sent).toMatchObject({ driver: "b", name: "get_desktop_state" });
		expect(sent.arguments.delivery_mode).toBeUndefined();
		expect(sent.arguments.session).toMatch(/^pim-b-/);
		expect(displayd.seen.filter((r) => r.url === "/touch").map((r) => r.body.threadId)).toEqual(["a", "b"]);
		expect(displayd.seen[0]!.auth).toBe("Bearer secret");
		expect(displayd.seen[0]!.body).toMatchObject({ threadId: "a", waitMs: 60_000 });
		expect(primary.seen).toEqual([]);
		// An explicit delivery mode is kept.
		const kept = await (m.displays as DisplayClient).call("a", "click", { delivery_mode: "background" });
		expect(JSON.parse(text(kept)).arguments.delivery_mode).toBe("background");
	});

	it("surfaces a queued display as a retryable error, not the primary driver", async () => {
		const { primary, machine } = await setup(() => ({ status: 202, json: { lease: { threadId: "a", state: "queued" } } }));
		const result = (await (machine().displays as DisplayClient).call("a", "click", {})) as any;
		expect(result.isError).toBe(true);
		expect(text(result)).toMatch(/^display_queued /);
		expect(primary.seen).toEqual([]);
	});

	it("tells a queued thread its position, estimated wait and who holds the displays", async () => {
		const queue = { position: 2, estimatedWaitSec: 90, holders: [{ threadId: "h1", idleSec: 30, state: "active" }, { threadId: "h2", idleSec: 5, state: "idle" }] };
		const { primary, machine } = await setup(() => ({ status: 202, json: { lease: { threadId: "a", state: "queued", ...queue } } }));
		const result = (await (machine().displays as DisplayClient).call("a", "click", {})) as any;
		expect(result.isError).toBe(true);
		expect(text(result)).toMatch(/^display_queued /);
		expect(text(result)).toContain("position 2");
		expect(text(result)).toContain("estimated wait 90 s");
		expect(text(result)).toContain("h1 (active, idle 30 s)");
		expect(text(result)).toContain("h2 (idle, idle 5 s)");
		expect(text(result)).toMatch(/try again/i);
		expect(primary.seen).toEqual([]);
	});

	it("reports a timeout and a preempted display as retryable errors", async () => {
		const states = { a: { state: "timeout" }, b: { state: "gone", reason: "preempted" } } as const;
		const { machine } = await setup((t) => ({ status: 202, json: { lease: { threadId: t, ...states[t as "a" | "b"] } } }));
		const m = machine().displays as DisplayClient;
		expect(text(await m.call("a", "click", {}))).toMatch(/^display_timeout .*try again/);
		const gone = (await m.call("b", "click", {})) as any;
		expect(gone.isError).toBe(true);
		expect(text(gone)).toMatch(/^display_gone .*preempted.*try again/);
	});

	it("does not call the driver while a person controls the display", async () => {
		const a = await start(fakeDriver("a"));
		const { displayd, machine } = await setup((t) => ({ json: { lease: { ...lease(t, a), control: "user" } } }));
		const result = (await (machine().displays as DisplayClient).call("a", "click", {})) as any;
		expect(result.isError).toBe(true);
		expect(text(result)).toMatch(/^display_user_controlled .*(wait|try again)/i);
		expect(a.seen).toEqual([]);
		expect(displayd.seen.some((r) => r.url === "/touch")).toBe(false);
		// Handed back, the same call goes through.
		const back = await setup((t) => ({ json: { lease: { ...lease(t, a), control: "agent" } } }));
		expect(JSON.parse(text(await (back.machine().displays as DisplayClient).call("a", "click", {}))).driver).toBe("a");
	});

	it("says display_starting while the display comes up", async () => {
		const { machine } = await setup(() => ({ status: 202, json: { lease: { threadId: "a", state: "starting" } } }));
		expect(text(await (machine().displays as DisplayClient).call("a", "click", {}))).toMatch(/^display_starting /);
	});

	it("errors when displayd is unreachable, without touching the primary driver", async () => {
		const primary = await start(fakeDriver("primary"));
		const calls: string[] = [];
		const machine: Machine = {
			root: dir,
			exec: async () => ({}) as never,
			driver: { call: async (tool) => (calls.push(tool), { content: [] }) },
			displays: new DisplayClient({ url: "http://127.0.0.1:1", tokenFile: tokenFile() }),
		};
		const replies: any[] = [];
		const link = new Link(machine, (m) => replies.push(JSON.parse(m as string)));
		link.receive(JSON.stringify({ type: "call", id: "1", op: "driver", args: { tool: "click", arguments: {}, thread: "a" } }));
		await new Promise((r) => setTimeout(r, 200));
		expect(replies[0].error.message).toBe("no display allocated: displayd is not reachable on this computer");
		expect(calls).toEqual([]);
		expect(primary.seen).toEqual([]);
	});

	it("uses the primary driver for a call without a thread", async () => {
		const { machine } = await setup(() => ({ json: {} }));
		const calls: string[] = [];
		const replies: any[] = [];
		const link = new Link(machine({ driver: { call: async (tool) => (calls.push(tool), { content: [] }) } }), (m) => replies.push(JSON.parse(m as string)));
		link.receive(JSON.stringify({ type: "call", id: "1", op: "driver", args: { tool: "list_apps", arguments: {} } }));
		await new Promise((r) => setTimeout(r, 100));
		expect(calls).toEqual(["list_apps"]);
	});
});

describe("exec with a thread", () => {
	it("merges the display's environment only when the thread already holds one, and never acquires", async () => {
		const displayd = await start(
			serve((r) => ({ json: r.url === "/displays" ? { displays: [{ threadId: "a", state: "active", env: { DISPLAY: ":100" } }, { threadId: "q", state: "queued" }] } : {} })),
		);
		const machine: Machine = {
			root: dir,
			exec: async (args) => ({ exitCode: 0, signal: null, stdout: JSON.stringify(args.env ?? null), stderr: "", timedOut: false, truncated: false }),
			displays: new DisplayClient({ url: displayd.base, tokenFile: tokenFile() }),
		};
		const run = async (thread?: string) => JSON.parse(((await handle(machine, "exec", { command: "echo", ...(thread ? { thread } : {}) })) as any).stdout);
		expect(await run("a")).toEqual({ DISPLAY: ":100" });
		expect(await run("other")).toBeNull();
		expect(await run("q")).toBeNull();
		expect(await run()).toBeNull();
		expect(displayd.seen.some((r) => r.url === "/acquire")).toBe(false);
	});
});

describe("exec's display environment", () => {
	it("takes the primary display out for a thread without a lease, and leaves other calls alone", async () => {
		const saved = { DISPLAY: process.env.DISPLAY, XAUTHORITY: process.env.XAUTHORITY };
		process.env.DISPLAY = ":1";
		process.env.XAUTHORITY = "/tmp/primary-auth";
		try {
		const displayd = await start(serve((r) => ({ json: r.url === "/displays" ? { displays: [{ threadId: "a", state: "active", env: { DISPLAY: ":100" } }] } : {} })));
		const machine: Machine = {
			root: dir,
			exec: (args, cwd) => runCommand(args, cwd, dir),
			displays: new DisplayClient({ url: displayd.base, tokenFile: tokenFile() }),
		};
		const printed = async (thread?: string) => ((await handle(machine, "exec", { command: "printenv DISPLAY XAUTHORITY", ...(thread ? { thread } : {}) })) as any).stdout;
		expect(await printed("none")).toBe("");
		expect(await printed("a")).toBe(":100\n/tmp/primary-auth\n");
		expect(await printed()).toBe(":1\n/tmp/primary-auth\n");
		displayd.close();
		expect(await printed("none")).toBe("");
		} finally {
			for (const [name, value] of Object.entries(saved)) {
				if (value === undefined) delete process.env[name];
				else process.env[name] = value;
			}
		}
	});
});
