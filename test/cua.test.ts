import * as fs from "node:fs/promises";
import { posix } from "node:path";
import type { Message } from "@earendil-works/pi-ai";
import { env, runInDurableObject } from "cloudflare:test";
import { exports } from "cloudflare:workers";
import { getAgentByName } from "agents";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { type ExecArgs, globPattern } from "../computer/pim-computer";
import { CUA_BRIDGE_AUTH_HEADER, CuaEvaluation, readCuaConfig } from "../src/cua";
import type { Approval } from "../src/store";
import { api, apiUrl, connectTestComputer, OWNER, pendingApproval, post, say, signedIn, TOKEN, toolUse } from "./helpers";
import { cuaEnvironment, faux, type Pim } from "./worker";

/**
 * The Cua evaluation (src/cua.ts) against a stand-in for pim-cua-bridge: the
 * bridge's HTTP API, with pim-computer's own file calls over a folder in
 * /tmp behind it, and a scripted cua-driver for the browser. The real
 * Worker, the real tool registration and approvals; no network, no Cua.
 */

const BRIDGE = "https://cua-eval.ajac-zero.com";
const BRIDGE_TOKEN = `pimcb_${"Q7".repeat(24)}`;
/** A 1×1 PNG. */
const PNG = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==";
const PAIRED_ROOT = `/tmp/paired-${crypto.randomUUID()}`;

const agent = () => env.Pim.getByName(OWNER);

/** The Cua computer's /workspace, kept in memory: the bridge is called from the space, whose /tmp is its own. */
const files = new Map<string, Uint8Array>();
const folders = new Set(["/workspace"]);
const text = (path: string) => new TextDecoder().decode(files.get(path));

/** pim-computer's file calls (computer/pim-computer.ts's `handle`), on `files` and `folders`. */
function fileCall(op: string, args: Record<string, any>): unknown {
	const at = (value: unknown) => {
		const path = posix.normalize(String(value ?? "/workspace"));
		if (path !== "/workspace" && !path.startsWith("/workspace/")) throw Object.assign(new Error(`${String(value)} is outside /workspace`), { code: "EACCES" });
		return path;
	};
	const missing = (path: string) => Object.assign(new Error(`ENOENT: no such file or directory '${path}'`), { code: "ENOENT" });
	const statOf = (path: string) => {
		if (folders.has(path)) return { name: posix.basename(path), size: 0, mtime: 0, mode: 0o40755, isFile: false, isDirectory: true, isSymbolicLink: false };
		const bytes = files.get(path);
		if (!bytes) throw missing(path);
		return { name: posix.basename(path), size: bytes.byteLength, mtime: 0, mode: 0o100644, isFile: true, isDirectory: false, isSymbolicLink: false };
	};
	const under = (folder: string) => [...folders, ...files.keys()].filter((path) => path.startsWith(`${folder}/`)).sort();
	const path = at(args.path);
	switch (op) {
		case "stat":
			return statOf(path);
		case "read": {
			const bytes = files.get(path);
			if (!bytes) throw missing(path);
			const offset = args.offset ?? 0;
			return { data: Buffer.from(bytes.subarray(offset, offset + (args.length ?? 1_048_576))).toString("base64"), size: bytes.byteLength };
		}
		case "write": {
			if (!folders.has(posix.dirname(path))) throw missing(path);
			const data = new Uint8Array(Buffer.from(args.data, "base64"));
			const before = args.append ? (files.get(path) ?? new Uint8Array()) : new Uint8Array();
			files.set(path, new Uint8Array([...before, ...data]));
			return null;
		}
		case "mkdir":
			for (let folder = path; folder !== "/"; folder = posix.dirname(folder)) folders.add(folder);
			return null;
		case "rm":
			if (!files.delete(path) && !folders.has(path) && !args.force) throw missing(path);
			for (const inside of under(path)) {
				files.delete(inside);
				folders.delete(inside);
			}
			folders.delete(path);
			return null;
		case "rename": {
			const [from, to] = [at(args.from), at(args.to)];
			files.set(to, files.get(from)!);
			files.delete(from);
			return null;
		}
		case "readdir":
			if (!folders.has(path)) throw missing(path);
			return under(path)
				.filter((inside) => posix.dirname(inside) === path)
				.map((inside) => ({ ...statOf(inside), parentPath: path }));
		case "find": {
			const glob = globPattern(String(args.pattern ?? "**"));
			return under(path)
				.filter((inside) => glob.test(inside.slice(path.length + 1)))
				.map((inside) => ({ path: inside, type: folders.has(inside) ? "dir" : "file" }));
		}
		case "grep": {
			const query = String(args.query).toLowerCase();
			return under(path)
				.filter((inside) => files.has(inside))
				.flatMap((inside) =>
					text(inside)
						.split("\n")
						.flatMap((line, index) => ((args.ignoreCase ? line.toLowerCase() : line).includes(args.ignoreCase ? query : args.query) ? [{ path: inside, line: index + 1, text: line }] : [])),
				);
		}
		default:
			throw new Error(`The test bridge has no call ${op}`);
	}
}

/** What the bridge was asked, the driver's state, and the switches tests turn. */
const bridge = {
	seen: [] as { route: string; body: Record<string, any> }[],
	ran: [] as ExecArgs[],
	/** What the bridge says it has under way, as after a restart of the space. */
	inflight: 0,
	/** Holds `call`s for `op` until released. */
	gate: null as { op: string; arrived: () => void; release: Promise<void> } | null,
	/** The next answer, in place of the bridge's own, made where the space reads it. */
	answerWith: null as { status: number; body: string; headers?: Record<string, string> } | null,
	driver: { snapshot: 0, bound: false, url: "about:blank", title: "", clicked: [] as string[], typed: [] as Record<string, unknown>[] },
};

function driverAnswer(tool: string, args: Record<string, any>) {
	const ok = (structured: Record<string, unknown>, image: string | null = null) => ({ structured: { status: "ok", ...structured }, text: "ok", image, isError: false });
	const refused = (code: string) => ({ structured: { status: "refused", refusal: { code, message: `${code} (test)` } }, text: `refused (${code})`, image: null, isError: false });
	const driver = bridge.driver;
	expect(args.session ?? "pim").toBe("pim");
	switch (tool) {
		case "start_session":
			return ok({});
		case "browser_prepare":
			expect(args).toEqual({ session: "pim", allow_launch: true, profile: { mode: "isolated_named", name: "pim" } });
			return ok({ prepared: true, prepared_pid: 4242 });
		case "list_windows":
			expect(args).toEqual({ pid: 4242 });
			return ok({ windows: [{ window_id: 9, pid: 4242, z_index: 0 }, { window_id: 10, pid: 4242, z_index: 3 }] });
		case "get_browser_state": {
			if (args.pid !== undefined) {
				expect(args).toEqual({ session: "pim", pid: 4242, window_id: 10 });
				driver.bound = true;
				return ok({ mode: "bind", target_id: "tg-1", binding_quality: "exact", tabs: [{ tab_id: "tab-0", active: false }, { tab_id: "tab-1", active: true }] });
			}
			if (!driver.bound) return refused("browser_binding_stale");
			expect(args).toMatchObject({ target_id: "tg-1", tab_id: "tab-1", snapshot_format: "semantic_v2" });
			const n = ++driver.snapshot;
			return ok(
				{
					mode: "snapshot",
					page: { url: driver.url, title: driver.title },
					outline: `- heading "${driver.title}"\n- text "Tomato, 4 €."`,
					refs: [
						{ ref: `p${n}:1`, role: "textbox", name: "Name", actions: ["type"] },
						{ ref: `p${n}:2`, role: "button", name: "Order", actions: ["click"] },
					],
				},
				args.include_screenshot ? PNG : null,
			);
		}
		case "browser_navigate":
			if (!driver.bound) return refused("browser_binding_stale");
			driver.url = args.url;
			driver.title = "Order soup";
			return ok({});
		case "browser_click":
			if (!String(args.ref).startsWith(`p${driver.snapshot}:`)) return refused("browser_ref_stale");
			expect(args.delivery_mode).toBe("foreground");
			driver.clicked.push(args.ref);
			driver.title = "Ordered";
			return ok({});
		case "browser_type":
			if (!String(args.ref).startsWith(`p${driver.snapshot}:`)) return refused("browser_ref_stale");
			driver.typed.push(args);
			return ok({});
		case "end_session":
			driver.bound = false;
			return ok({});
		default:
			throw new Error(`The test driver has no ${tool}`);
	}
}

/** The bridge's API, as pim_cua_bridge.py answers it. */
function standInBridge() {
	vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
		const request = new Request(input, init);
		const url = new URL(request.url);
		if (url.origin !== BRIDGE) throw new Error(`This test reaches only the Cua bridge, not ${url}`);
		expect(request.method).toBe("POST");
		expect(request.redirect).toBe("manual");
		expect(url.search).toBe("");
		expect(request.headers.get(CUA_BRIDGE_AUTH_HEADER)).toBe(`Bearer ${BRIDGE_TOKEN}`);
		expect(request.headers.get("authorization")).toBeNull();
		const route = url.pathname.replace("/pim-bridge/v1/", "");
		const body = (await request.json()) as Record<string, any>;
		bridge.seen.push({ route, body });
		const answer = bridge.answerWith;
		if (answer) {
			bridge.answerWith = null;
			return new Response(answer.body || null, { status: answer.status, headers: answer.headers ?? {} });
		}
		switch (route) {
			case "status":
				return Response.json({ ok: true, inflight: bridge.inflight, version: "test" });
			case "viewer":
				return Response.json({ viewerPath: `/viewer/#ticket=${"V".repeat(32)}`, expiresAt: 1_793_000_000 });
			case "driver":
				return Response.json(driverAnswer(body.tool, body.arguments));
			case "call": {
				const gate = bridge.gate;
				if (gate && gate.op === body.op) {
					bridge.gate = null;
					gate.arrived();
					await gate.release;
				}
				try {
					if (body.op !== "exec") return Response.json({ result: fileCall(body.op, body.args) });
					bridge.ran.push(body.args);
					return Response.json({ result: { exitCode: 0, signal: null, stdout: `ran ${body.args.command}\n`, stderr: "", timedOut: false, truncated: false } });
				} catch (error) {
					return Response.json({ error: { message: (error as Error).message, code: (error as { code?: string }).code ?? null } });
				}
			}
			default:
				return Response.json({ error: { message: "Not found" } }, { status: 404 });
		}
	});
}

/** Holds the bridge's next `op` call until `release` is called; `arrived` settles once it has reached the bridge. */
function holdNext(op: string) {
	let release!: () => void;
	let arrived!: () => void;
	const reached = new Promise<void>((resolve) => {
		arrived = resolve;
	});
	bridge.gate = { op, arrived, release: new Promise<void>((resolve) => (release = resolve)) };
	return { reached, release };
}

function lastToolResult(messages: readonly Message[]): { text: string; isError: boolean } {
	const result = messages.findLast((message) => message.role === "toolResult");
	if (!result || result.role !== "toolResult") throw new Error("no tool result");
	return { text: result.content.flatMap((part) => (part.type === "text" ? [part.text] : [])).join(""), isError: result.isError === true };
}

async function callTool(name: string, args: Record<string, unknown>) {
	let result = { text: "", isError: false };
	faux.setResponses([
		toolUse(name, args as never),
		(context) => {
			result = lastToolResult(context.messages);
			return toolUse("send_to_user", { message: "Done." });
		},
	]);
	await say(`Please use ${name}`);
	return result;
}

async function offeredTools(): Promise<string[]> {
	let names: string[] = [];
	faux.setResponses([
		(context) => {
			const tools = new Set<string>();
			for (const message of context.messages) {
				if (message.role !== "system") continue;
				for (const tool of message.toolsAdded ?? []) tools.add(tool.name);
				for (const tool of message.toolsRemoved ?? []) tools.delete(tool.name);
			}
			names = [...tools];
			return toolUse("send_to_user", { message: "Here." });
		},
	]);
	await say("What can you use?");
	return names;
}

const setPermission = (tool: string, permission: string | null) => api("/permissions", { method: "PUT", body: JSON.stringify({ app: null, tool, permission }) });

let cookie = "";

/** A request from the person's own browser, signed in, from the app's origin. */
async function asPerson<T = any>(path: string, method = "GET", body?: unknown, headers: Record<string, string> = {}) {
	const response = await exports.default.fetch(
		new Request(apiUrl(path), {
			method,
			headers: { cookie, origin: "https://pim.test", "content-type": "application/json", ...headers },
			...(body === undefined ? {} : { body: JSON.stringify(body) }),
		}),
	);
	return { status: response.status, headers: response.headers, body: (await response.json()) as T };
}

const status = async () => (await asPerson("/cua")).body;

function useEvaluation(owner = OWNER) {
	Object.assign(cuaEnvironment, { CUA_EVAL_BRIDGE_URL: BRIDGE, CUA_EVAL_BRIDGE_TOKEN: BRIDGE_TOKEN, CUA_EVAL_OWNER: owner });
}

beforeAll(async () => {
	cookie = await signedIn();
});

// Every test reaches the stand-in bridge, and nothing else, through `fetch`.
beforeEach(() => standInBridge());

afterEach(() => {
	bridge.seen = [];
});

afterAll(() => {
	for (const key of Object.keys(cuaEnvironment)) delete cuaEnvironment[key];
});

describe("the Cua evaluation's settings", () => {
	it("are off unless the deployment sets them all, soundly, for one owner", () => {
		expect(readCuaConfig({})).toBeNull();
		const good = { CUA_EVAL_BRIDGE_URL: BRIDGE, CUA_EVAL_BRIDGE_TOKEN: BRIDGE_TOKEN, CUA_EVAL_OWNER: "o_01j00000000000000000000000" };
		expect(readCuaConfig(good)).toEqual({ base: BRIDGE, token: BRIDGE_TOKEN, owner: good.CUA_EVAL_OWNER });
		for (const [change, problem] of [
			[{ CUA_EVAL_BRIDGE_URL: "http://cua-eval.ajac-zero.com" }, "https://"],
			[{ CUA_EVAL_BRIDGE_URL: "https://cua-eval.ajac-zero.com.evil.test" }, "must be at"],
			[{ CUA_EVAL_BRIDGE_URL: "https://169.254.169.254" }, "must be at"],
			[{ CUA_EVAL_BRIDGE_URL: "https://localhost" }, "must be at"],
			[{ CUA_EVAL_BRIDGE_URL: "https://user:pass@cua-eval.ajac-zero.com" }, "origin alone"],
			[{ CUA_EVAL_BRIDGE_URL: "https://cua-eval.ajac-zero.com:3211" }, "origin alone"],
			[{ CUA_EVAL_BRIDGE_URL: "https://cua-eval.ajac-zero.com/mcp" }, "origin alone"],
			[{ CUA_EVAL_BRIDGE_URL: "https://cua-eval.ajac-zero.com/?next=http://evil.test" }, "origin alone"],
			[{ CUA_EVAL_BRIDGE_TOKEN: "short-and-guessable" }, "CUA_EVAL_BRIDGE_TOKEN"],
			[{ CUA_EVAL_BRIDGE_TOKEN: `${BRIDGE_TOKEN} ` + "x" }, "CUA_EVAL_BRIDGE_TOKEN"],
			[{ CUA_EVAL_OWNER: "" }, "CUA_EVAL_OWNER"],
			[{ CUA_EVAL_OWNER: "tester" }, "CUA_EVAL_OWNER"],
		] as const) {
			expect(() => readCuaConfig({ ...good, ...change })).toThrow(problem);
			try {
				readCuaConfig({ ...good, ...change });
			} catch (error) {
				expect(String(error)).not.toContain(BRIDGE_TOKEN);
			}
		}
	});

	it("offer nothing where they aren't set: the space keeps no computer and no tools that need one", async () => {
		expect(await status()).toEqual({ offered: false });
		expect((await asPerson("/cua", "POST")).status).toBe(404);
		expect((await asPerson("/cua/pause", "POST")).status).toBe(404);
		expect((await asPerson("/cua/viewer", "POST")).status).toBe(404);
		expect((await api("/computer")).body.state).toBe("none");
		expect(await offeredTools()).not.toContain("file_read");
	});

	it("offer it to the allowlisted owner only", async () => {
		useEvaluation("o_01j00000000000000000000000");
		expect(await status()).toEqual({ offered: false });
		expect((await asPerson("/cua", "POST")).status).toBe(404);
		useEvaluation();
		expect(await status()).toEqual({ offered: true, enabled: false, mode: "agents", generation: 0, pending: 0, host: "cua-eval.ajac-zero.com" });
		// Offered isn't on: nothing changes until the person turns it on.
		expect((await api("/computer")).body.state).toBe("none");
	});
});

describe("turning the Cua evaluation on", () => {
	it("is for the person, signed in, from the app: not an API token, another site, or another owner", async () => {
		expect((await post("/cua")).status).toBe(403);
		expect((await asPerson("/cua", "POST", {}, { origin: "https://evil.test" })).status).toBe(403);
		const noOrigin = await exports.default.fetch(new Request(apiUrl("/cua"), { method: "POST", headers: { cookie } }));
		expect(noOrigin.status).toBe(403);
		// Another person, signed in to their own space, reaches only theirs, which isn't offered it.
		const directory = env.Directory.getByName("directory");
		const registered = await directory.register({ username: "bob", ip: "192.0.2.9", policy: { mode: "open", maxAccounts: null, perAddressPerDay: 100 } });
		if (!registered.ok) throw new Error(registered.error);
		const bob = registered.account.ownerId;
		await directory.activate(bob);
		await (await getAgentByName(env.Pim, bob)).provision({ ownerId: bob, username: "bob" });
		const bobs = await signedIn(bob);
		for (const path of ["/cua", "/cua/pause", "/cua/viewer"]) {
			const response = await exports.default.fetch(new Request(apiUrl(path), { method: "POST", headers: { cookie: bobs, origin: "https://pim.test" } }));
			expect(response.status).toBe(404);
		}
		expect((await status()).enabled).toBe(false);
		expect(bridge.seen).toEqual([]);
	});

	it("puts the Cua computer in place of the space's paired one, whose files stay where they are", async () => {
		// A paired pim-computer, as the person had before.
		const paired = await post<{ token: string }>("/computer");
		await connectTestComputer(paired.body.token, PAIRED_ROOT, async () => {
			throw new Error("The paired computer runs no commands here.");
		});
		await fs.writeFile(`${PAIRED_ROOT}/notes.md`, "on the paired computer");

		const on = await asPerson("/cua", "POST");
		expect(on.status).toBe(200);
		expect(on.body).toMatchObject({ enabled: true, mode: "agents" });
		expect(JSON.stringify(on.body)).not.toContain(BRIDGE_TOKEN);
		expect((await api("/computer")).body).toMatchObject({ state: "online", provider: "cua", computer: { hostname: "cua-eval.ajac-zero.com", browser: "cua-driver" } });
		const tools = await offeredTools();
		for (const tool of ["file_read", "file_write", "file_search", "shell", "browser_open", "browser_click", "browser_type"]) expect(tools).toContain(tool);

		// The agents' files are the Cua computer's now.
		expect((await callTool("file_write", { path: "/workspace/notes.md", content: "on the Cua computer" })).isError).toBe(false);
		expect(text("/workspace/notes.md")).toBe("on the Cua computer");
		expect(await fs.readFile(`${PAIRED_ROOT}/notes.md`, "utf8")).toBe("on the paired computer");
		expect(bridge.seen).toContainEqual({ route: "call", body: { op: "write", args: { path: "/workspace/notes.md", data: expect.any(String) } } });
		// Larger files go in parts small enough for the bridge, as one file.
		const big = "x".repeat(200_000);
		expect((await callTool("file_write", { path: "/workspace/big.txt", content: big })).isError).toBe(false);
		expect(text("/workspace/big.txt")).toBe(big);
		const parts = bridge.seen.filter((seen) => seen.route === "call" && seen.body.op === "write" && seen.body.args.path !== "/workspace/notes.md");
		expect(parts.length).toBe(4);
		expect(Math.max(...parts.map((part) => Buffer.from(part.body.args.data, "base64").byteLength))).toBe(64 * 1024);
		const searched = JSON.parse((await callTool("file_search", { query: "cua computer" , ignoreCase: true })).text);
		expect(searched.matches).toEqual([expect.objectContaining({ path: "/workspace/notes.md", line: 1 })]);
		// The app's Files are the same.
		expect((await api("/files")).body.entries.map((entry: { name: string }) => entry.name)).toEqual(["big.txt", "notes.md"]);

		// Paths outside the files are refused before the bridge is asked.
		const asked = bridge.seen.length;
		expect((await callTool("file_read", { path: "/etc/passwd" })).text).toContain("not one of the person's files");
		expect(bridge.seen.length).toBe(asked);
	});
});

describe("the agents on the Cua computer", () => {
	it("run commands only once the person approves, and not at all where the person turned shell off", async () => {
		faux.setResponses([toolUse("shell", { command: "uname -a", cwd: "/workspace" }), toolUse("send_to_user", { message: "Ran." })]);
		const running = say("What machine is this?");
		const approval = await pendingApproval();
		expect(approval.summary).toBe("Run on your computer: uname -a");
		expect(bridge.ran).toEqual([]);
		await post(`/approvals/${approval.id}/approve`);
		expect(await running).toMatchObject({ status: "done" });
		expect(bridge.ran).toEqual([{ command: "uname -a", cwd: "/workspace", timeoutMs: 120_000, maxBytes: 64_000 }]);

		await setPermission("shell", "off");
		await setPermission("browser_click", "off");
		const tools = await offeredTools();
		expect(tools).not.toContain("shell");
		expect(tools).not.toContain("browser_click");
		expect(tools).toContain("browser_type");
		await setPermission("shell", null);
		await setPermission("browser_click", null);
	});

	it("browse with cua-driver's typed tools, reading pages with numbers and asking before clicking or typing", async () => {
		const page = await callTool("browser_open", { url: "https://soup.example/menu" });
		expect(page.isError).toBe(false);
		expect(page.text).toContain("Page: Order soup\nURL: https://soup.example/menu");
		expect(page.text).toContain('- text "Tomato, 4 €."');
		const order = Number(/\[(\d+) button “Order”\]/.exec(page.text)![1]);
		const name = Number(/\[(\d+) textbox “Name”\]/.exec(page.text)![1]);
		// The window bound is the frontmost, by its tab that is active; nothing went over DevTools.
		expect(bridge.seen.filter((seen) => seen.route === "driver").map((seen) => seen.body.tool)).toEqual([
			"start_session",
			"browser_prepare",
			"list_windows",
			"get_browser_state",
			"browser_navigate",
			"get_browser_state",
		]);
		expect(bridge.seen.filter((seen) => seen.route === "call").map((seen) => seen.body.op)).toEqual([]);

		faux.setResponses([toolUse("browser_type", { ref: name, text: "Ada", submit: true }), toolUse("send_to_user", { message: "Typed." })]);
		const typing = say("Put my name in.");
		const typed = await pendingApproval();
		expect(typed.summary).toBe("On soup.example, type “Ada” into the textbox “Name” and press Enter");
		await post<Approval>(`/approvals/${typed.id}/approve`);
		await typing;
		expect(bridge.driver.typed.map(({ text, replace, mode }) => ({ text, replace, mode }))).toEqual([
			{ text: "Ada", replace: true, mode: undefined },
			{ text: "\n", replace: undefined, mode: "keystrokes" },
		]);

		// The page was read again after typing: the number from before is gone, and nothing is asked about it.
		expect((await callTool("browser_click", { ref: order })).text).toContain(`There is no [${order}] on the page now`);
		expect((await api("/approvals?status=pending")).body.approvals).toEqual([]);
		const read = await callTool("browser_read", {});
		const fresh = Number(/\[(\d+) button “Order”\]/.exec(read.text)![1]);
		expect(fresh).toBeGreaterThan(order);
		faux.setResponses([toolUse("browser_click", { ref: fresh }), toolUse("send_to_user", { message: "Ordered." })]);
		const ordering = say("Order it.");
		const clicking = await pendingApproval();
		expect(clicking.summary).toBe("On soup.example, click the button “Order”");
		expect((await post<Approval>(`/approvals/${clicking.id}/approve`)).body.result).toContain("Page: Ordered");
		await ordering;
		expect(bridge.driver.clicked).toEqual([`p${bridge.driver.snapshot - 1}:2`]);

		// Pages of the agent's own HTML aren't for this browser.
		expect((await callTool("browser_open", { url: "data:text/html,<p>hi</p>" })).text).toContain("http(s) addresses only");
		// A screenshot is saved to the files; the app shows the page's address, and leaves pictures to the viewer.
		expect((await callTool("browser_screenshot", { path: "/workspace/soup.png" })).text).toBe("Saved to /workspace/soup.png.");
		expect([...files.get("/workspace/soup.png")!.subarray(0, 4)]).toEqual([0x89, 0x50, 0x4e, 0x47]);
		expect((await api("/browser")).body).toEqual({ available: true, provider: "cua", page: { url: "https://soup.example/menu", title: "Ordered" } });
		expect((await api("/browser/screenshot")).status).toBe(404);
		const live = await exports.default.fetch(new Request(apiUrl("/browser/live"), { headers: { Upgrade: "websocket", Authorization: `Bearer ${TOKEN}` } }));
		const said = new Promise<string>((resolve) => live.webSocket!.addEventListener("message", (event) => resolve(String(event.data))));
		live.webSocket!.accept();
		expect(await said).toContain("Cua evaluation");
	});
});

describe("pausing the agents for the person", () => {
	it("waits for an agent's work under way, and opens the viewer only once it's done", async () => {
		const held = holdNext("read");
		const reading = callTool("file_read", { path: "/workspace/notes.md" });
		await held.reached;
		const pausing = await asPerson("/cua/pause", "POST");
		expect(pausing.body).toMatchObject({ mode: "pausing", pending: 1 });
		const generation = pausing.body.generation;
		// Nothing new starts meanwhile, and the viewer stays closed.
		expect((await api("/files")).status).toBe(423);
		expect((await asPerson("/cua/viewer", "POST")).status).toBe(409);
		expect(bridge.seen.some((seen) => seen.route === "viewer")).toBe(false);

		held.release();
		expect((await reading).text).toContain("on the Cua computer");
		await vi.waitFor(async () => expect(await status()).toMatchObject({ mode: "paused", generation, pending: 0 }));
		const viewer = await asPerson("/cua/viewer", "POST");
		expect(viewer.status).toBe(200);
		expect(viewer.body).toEqual({ url: `${BRIDGE}/viewer/#ticket=${"V".repeat(32)}`, expiresAt: 1_793_000_000_000 });
		expect(viewer.headers.get("cache-control")).toBe("no-store, private");
		expect(viewer.headers.get("referrer-policy")).toBe("no-referrer");
		expect(JSON.stringify(viewer.body)).not.toContain(BRIDGE_TOKEN);
		// An API token gets no viewer.
		expect((await post("/cua/viewer")).status).toBe(403);
	});

	it("refuses every agent call while paused, whether asked for before or after, read or write", async () => {
		const before = bridge.seen.length;
		for (const [tool, args] of [
			["file_read", { path: "/workspace/notes.md" }],
			["file_write", { path: "/workspace/later.md", content: "x" }],
			["browser_read", {}],
			["browser_open", { url: "https://soup.example/" }],
			["browser_screenshot", {}],
		] as const) {
			const result = await callTool(tool, args);
			expect(result.text).toContain("paused agents on their Cua evaluation computer");
		}
		expect(bridge.seen.length).toBe(before);
		expect(files.has("/workspace/later.md")).toBe(false);
	});

	it("doesn't let an approval given during a pause run what it approved", async () => {
		const generation = (await status()).generation;
		expect((await asPerson("/cua/resume", "POST", { generation })).body.mode).toBe("agents");
		faux.setResponses([toolUse("shell", { command: "rm -rf /workspace/notes.md" }), toolUse("send_to_user", { message: "Tried." })]);
		const asking = say("Clean up.");
		const approval = await pendingApproval();
		// The person pauses while the request waits, then approves it.
		expect((await asPerson("/cua/pause", "POST")).body.mode).toBe("paused");
		const ran = bridge.ran.length;
		const decided = await post<Approval>(`/approvals/${approval.id}/approve`);
		expect(JSON.stringify(decided.body)).toContain("paused agents on their Cua evaluation computer");
		await asking;
		expect(bridge.ran.length).toBe(ran);
		expect(text("/workspace/notes.md")).toBe("on the Cua computer");
	});

	it("resumes only for the person, and only the pause they saw", async () => {
		const { generation } = await status();
		expect((await post("/cua/resume", { generation })).status).toBe(403);
		expect((await asPerson("/cua/resume", "POST", { generation: generation - 1 })).status).toBe(409);
		expect((await asPerson("/cua/resume", "POST", {})).status).toBe(409);
		expect((await status()).mode).toBe("paused");
		// Closing the viewer resumes nothing: only this does.
		const resumed = await asPerson("/cua/resume", "POST", { generation });
		expect(resumed.body).toMatchObject({ mode: "agents", generation: generation + 1 });
		expect((await asPerson("/cua/resume", "POST", { generation })).status).toBe(409);
		expect((await asPerson("/cua/viewer", "POST")).status).toBe(409);
		expect((await callTool("file_read", { path: "/workspace/notes.md" })).text).toContain("on the Cua computer");
	});

	it("stays paused across a restart, and waits for what the bridge still has under way", async () => {
		await runInDurableObject(agent(), async (instance: Pim) => {
			instance.store.setMeta("cua_control", JSON.stringify({ mode: "pausing", generation: 40, at: 0 }));
			// A new instance on the same storage, as after a restart: it has nothing of its own under way.
			const restarted = new CuaEvaluation({ meta: instance.store, config: () => readCuaConfig(cuaEnvironment), owner: () => OWNER, changed: () => {} });
			await expect(restarted.hold(async () => "ran")).rejects.toThrow("paused agents");
			bridge.inflight = 1;
			expect((await restarted.settle()).mode).toBe("pausing");
			await expect(restarted.viewer()).rejects.toThrow("still finishing");
			bridge.inflight = 0;
			expect((await restarted.settle()).mode).toBe("paused");
			await expect(restarted.hold(async () => "ran")).rejects.toThrow("paused agents");
		});
		expect(await status()).toMatchObject({ mode: "paused", generation: 40 });
		// Without the bridge, a pause can't be shown complete, and stays pausing.
		await runInDurableObject(agent(), (instance: Pim) => instance.store.setMeta("cua_control", JSON.stringify({ mode: "pausing", generation: 41, at: 0 })));
		bridge.answerWith = { status: 502, body: JSON.stringify({ error: { message: "down" } }) };
		expect(await status()).toMatchObject({ mode: "pausing", problem: "down" });
		expect((await asPerson("/cua/resume", "POST", { generation: 41 })).body.mode).toBe("agents");
	});
});

describe("the bridge's answers", () => {
	it("are followed nowhere, capped, and say nothing of Pim's credential", async () => {
		bridge.answerWith = { status: 302, body: "", headers: { location: "https://evil.test/steal" } };
		expect((await callTool("file_read", { path: "/workspace/notes.md" })).text).toContain("redirect, which Pim doesn't follow");
		bridge.answerWith = { status: 200, body: JSON.stringify({ result: { data: "A".repeat(13 * 1024 * 1024), size: 1 } }) };
		expect((await callTool("file_read", { path: "/workspace/notes.md" })).text).toContain("too large");
		bridge.answerWith = { status: 502, body: JSON.stringify({ error: { message: `upstream said ${BRIDGE_TOKEN}` } }) };
		const scrubbed = await callTool("file_read", { path: "/workspace/notes.md" });
		expect(scrubbed.text).toContain("upstream said [redacted]");
		expect(scrubbed.text).not.toContain(BRIDGE_TOKEN);
		bridge.answerWith = { status: 401, body: JSON.stringify({ error: { message: "Unauthorized" } }) };
		expect((await callTool("file_read", { path: "/workspace/notes.md" })).text).toContain("refused Pim's credential");
		expect(bridge.seen.every((seen) => seen.route !== "steal")).toBe(true);
	});
});

describe("turning the Cua evaluation off", () => {
	it("gives the agents back the space's own computer, as it was", async () => {
		expect((await asPerson("/cua", "DELETE")).body).toMatchObject({ enabled: false });
		expect((await api("/computer")).body).toMatchObject({ state: "online", computer: { hostname: "test-box" } });
		expect((await api("/computer")).body.provider).toBeUndefined();
		expect((await callTool("file_read", { path: "/workspace/notes.md" })).text).toContain("on the paired computer");
		expect((await api("/browser")).body.provider).toBeUndefined();
		expect(bridge.seen).toEqual([]);
	});
});
