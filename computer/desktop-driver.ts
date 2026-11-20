#!/usr/bin/env node
/**
 * Pim's own desktop driver: the tools the agents' desktop tools call (`desktop_look`, `desktop_read` and `desktop_act` in @pim/v2-server's computer-tools.ts), served for one X
 * display the way Cua's per-display driver (`cua-env-driver`) serves them, so a computer without Cua's binaries, such as the computer image (deploy/Dockerfile.computer), has desktop
 * tools too. displayd starts it for each display it runs (`DISPLAYD_DRIVER_BIN`), in that display's environment:
 *
 *   desktop-driver.ts serve --listen 127.0.0.1:3220 --token-file /run/pim/displays/<id>/driver-token
 *
 * It is an MCP server over streamable HTTP at `/mcp`, behind the bearer token in the token file, with Cua Driver's tool names: `get_desktop_state` (a screenshot and the windows),
 * `list_apps`, `get_window_state` (an app's window as its accessibility tree, numbered, with a snapshot id the numbers' element tokens start with), and the actions `launch_app`,
 * `click`, `double_click`, `right_click`, `type_text`, `press_key`, `hotkey`, `scroll`, `set_value` and `kill_app`. What it reads of the apps goes through the display's
 * accessibility bus (AT-SPI) and GDK, in desktop-atspi.py; the windows come from the window manager (`wmctrl`), and the pointer and keys from `xdotool`. Coordinates are the
 * screen's pixels, as `get_desktop_state`'s screenshot shows them. It does not stream the display: the stream's gRPC-Web methods answer UNIMPLEMENTED.
 */
import { execFile, spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import * as fs from "node:fs/promises";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

type Content = { type: "text"; text: string } | { type: "image"; data: string; mimeType: string };
export type ToolResult = { content: Content[]; isError?: boolean };
type Args = Record<string, unknown>;

/** The element tokens of this many reads are kept; an older token asks the agent to read again. */
const SNAPSHOTS = 20;
const HELPER_MS = 30_000;
const MAX_ELEMENTS = 400;
const HELPER = path.join(path.dirname(fileURLToPath(import.meta.url)), "desktop-atspi.py");

/** Key names as agents and Cua Driver write them, as xdotool's keysyms. */
const KEYS: Record<string, string> = {
	enter: "Return", return: "Return", esc: "Escape", escape: "Escape", tab: "Tab", space: "space", backspace: "BackSpace", delete: "Delete", del: "Delete", insert: "Insert",
	up: "Up", down: "Down", left: "Left", right: "Right", home: "Home", end: "End", pageup: "Prior", page_up: "Prior", pagedown: "Next", page_down: "Next",
	ctrl: "ctrl", control: "ctrl", alt: "alt", option: "alt", shift: "shift", cmd: "super", command: "super", super: "super", meta: "super", win: "super",
};
const keysym = (key: string) => KEYS[key.toLowerCase()] ?? (/^f\d{1,2}$/i.test(key) ? key.toUpperCase() : key);
const SCROLL = { up: 4, down: 5, left: 6, right: 7 } as const;

class ToolError extends Error {}

/** A window the window manager shows. */
export type Window = { id: number; pid: number; x: number; y: number; w: number; h: number; title: string };

/** Parses `wmctrl -lpG`: id, desktop, pid, x, y, width, height, host, title. */
export function parseWindows(listing: string): Window[] {
	return listing.split("\n").flatMap((line) => {
		const m = /^(0x[0-9a-f]+)\s+-?\d+\s+(\d+)\s+(-?\d+)\s+(-?\d+)\s+(\d+)\s+(\d+)\s+\S+\s?(.*)$/i.exec(line.trim());
		return m ? [{ id: Number.parseInt(m[1]!, 16), pid: Number(m[2]), x: Number(m[3]), y: Number(m[4]), w: Number(m[5]), h: Number(m[6]), title: m[7]! }] : [];
	});
}

type Element = { path: number[]; role: string; name: string; value?: string; states: string[]; actions: string[]; x: number; y: number; w: number; h: number };
type Snapshot = { pid: number; elements: Element[] };

/** How the driver reaches the display: programs it runs, and processes it starts. Tests give their own. */
export type DesktopHost = {
	run(command: string, args: string[], input?: string): Promise<string>;
	start(command: string, args: string[]): Promise<{ pid: number; exited: Promise<number | null>; said(): string }>;
	env: Record<string, string | undefined>;
};

const realHost = (env: Record<string, string | undefined> = process.env): DesktopHost => ({
	env,
	run: (command, args, input) =>
		new Promise((resolve, reject) => {
			const child = execFile(command, args, { env: env as NodeJS.ProcessEnv, timeout: HELPER_MS, maxBuffer: 32 * 1024 * 1024 }, (error, stdout, stderr) => {
				if (error) reject(new ToolError(`${path.basename(command)} failed: ${(stderr || error.message).trim().split("\n").slice(-3).join(" ")}`));
				else resolve(stdout);
			});
			child.stdin?.end(input ?? "");
		}),
	start: async (command, args) => {
		const child = spawn(command, args, { env: env as NodeJS.ProcessEnv, detached: true, stdio: ["ignore", "ignore", "pipe"] });
		await new Promise<void>((resolve, reject) => {
			child.once("spawn", resolve);
			child.once("error", (error) => reject(new ToolError(`Couldn't start ${command}: ${error.message}`)));
		});
		child.unref();
		// What the app says first, for when it fails at once; the rest is read and dropped for as long as it runs, so it never blocks on a full pipe.
		let said = "";
		child.stderr!.on("data", (chunk: Buffer) => {
			if (said.length < 2_000) said += chunk.toString("utf8");
		});
		(child.stderr as unknown as { unref?: () => void }).unref?.();
		return { pid: child.pid!, exited: new Promise((resolve) => child.once("exit", (code) => resolve(code))), said: () => said.trim() };
	},
});

/** The desktop driver's tools, for one display. */
export function desktopDriver(host: DesktopHost = realHost()) {
	const snapshots = new Map<string, Snapshot>();
	let taken = 0;

	const helper = async <T>(command: string, args: Args = {}): Promise<T> => {
		const answer = JSON.parse(await host.run("python3", [HELPER, command], JSON.stringify(args))) as { ok?: T; error?: string };
		if (answer.error !== undefined) throw new ToolError(answer.error);
		return answer.ok as T;
	};
	const xdotool = (...args: string[]) => host.run("xdotool", args);
	const windows = async () => parseWindows(await host.run("wmctrl", ["-lpG"]).catch(() => ""));
	const activeWindow = async () => Number((await xdotool("getactivewindow").catch(() => "")).trim()) || undefined;
	const describe = (w: Window, active?: number) => `- window_id ${w.id}, pid ${w.pid}: ${JSON.stringify(w.title)} at (${w.x}, ${w.y}), ${w.w}×${w.h}${w.id === active ? " (active)" : ""}`;

	/** Brings the window the call names, or the first of its app's, to the front, so keys and clicks reach it. */
	const focus = async (args: Args) => {
		const all = await windows();
		const target = typeof args.window_id === "number" ? all.find((w) => w.id === args.window_id) : typeof args.pid === "number" ? all.find((w) => w.pid === args.pid) : undefined;
		if (typeof args.window_id === "number" && !target) throw new ToolError(`There is no window ${args.window_id}: desktop_look lists them.`);
		if (target) await xdotool("windowactivate", "--sync", String(target.id)).catch(() => xdotool("windowfocus", "--sync", String(target.id)).catch(() => ""));
	};

	/** The element a token names, checked to be still there, with where it is now. */
	const element = async (token: unknown) => {
		const m = typeof token === "string" ? /^(s\d+):(\d+)$/.exec(token) : null;
		const snapshot = m ? snapshots.get(m[1]!) : undefined;
		if (!m || !snapshot) throw new ToolError(`${String(token)} is not an element of a recent read: read the window again with desktop_read.`);
		const el = snapshot.elements[Number(m[2]) - 1];
		if (!el) throw new ToolError(`${token} is not an element of that read.`);
		const at = await helper<{ x: number; y: number; w: number; h: number }>("act", { pid: snapshot.pid, path: el.path, role: el.role, name: el.name, op: "extents" });
		const visible = at.w > 0 && at.h > 0 && at.x + at.w > 0 && at.y + at.h > 0;
		return { pid: snapshot.pid, el, center: visible ? { x: Math.round(at.x + at.w / 2), y: Math.round(at.y + at.h / 2) } : undefined };
	};
	const act = (target: Awaited<ReturnType<typeof element>>, op: string, value?: string) => helper<{ done: unknown }>("act", { pid: target.pid, path: target.el.path, role: target.el.role, name: target.el.name, op, ...(value === undefined ? {} : { value }) });

	/** The point a call names: an element's middle, or x and y. */
	const point = async (args: Args): Promise<{ x: number; y: number; target?: Awaited<ReturnType<typeof element>> }> => {
		if (args.element_token !== undefined) {
			const target = await element(args.element_token);
			if (target.center) return { ...target.center, target };
			return { x: Number.NaN, y: Number.NaN, target };
		}
		if (typeof args.x === "number" && typeof args.y === "number") return { x: Math.round(args.x), y: Math.round(args.y) };
		throw new ToolError("Name what to act on: an element_token from desktop_read, or x and y on the screen.");
	};

	const click = async (args: Args, button: 1 | 3, times: 1 | 2) => {
		await focus(args);
		const at = await point(args);
		if (Number.isNaN(at.x)) {
			// An element without a place on the screen is pressed through its accessible action, where it has one.
			if (button !== 1 || times !== 1 || !at.target) throw new ToolError("That element isn't on the screen: scroll to it, or read the window again.");
			const done = await act(at.target, "press");
			return `Pressed ${at.target.el.role} ${JSON.stringify(at.target.el.name)} (${String(done.done)}).`;
		}
		await xdotool("mousemove", "--sync", String(at.x), String(at.y), "click", ...(times === 2 ? ["--repeat", "2", "--delay", "80"] : []), String(button));
		const what = at.target ? `${at.target.el.role} ${JSON.stringify(at.target.el.name)} at (${at.x}, ${at.y})` : `(${at.x}, ${at.y})`;
		return `${times === 2 ? "Double-clicked" : button === 3 ? "Right-clicked" : "Clicked"} ${what}.`;
	};

	/** The command a launch runs: an app's desktop entry by its name (the web browser's for urls alone), or a program on the PATH, given the URLs to open. */
	const launchCommand = async (name: string | undefined, urls: string[]): Promise<string[]> => {
		if (!name && urls.length === 0) throw new ToolError("Name the app to open, or the urls.");
		const dirs = [path.join(host.env.HOME ?? "/", ".local/share/applications"), "/usr/local/share/applications", "/usr/share/applications"];
		const entries: { file: string; name: string; exec: string; browser: boolean }[] = [];
		for (const dir of dirs) {
			for (const file of await fs.readdir(dir).catch(() => [] as string[])) {
				if (!file.endsWith(".desktop")) continue;
				const text = await fs.readFile(path.join(dir, file), "utf8").catch(() => "");
				const main = text.split(/^\[/m).find((part) => part.startsWith("Desktop Entry]")) ?? "";
				const field = (key: string) => new RegExp(`^${key}=(.*)$`, "m").exec(main)?.[1]?.trim();
				const exec = field("Exec");
				if (exec && field("NoDisplay") !== "true") entries.push({ file: file.slice(0, -".desktop".length).toLowerCase(), name: (field("Name") ?? "").toLowerCase(), exec, browser: /x-scheme-handler\/https?/.test(field("MimeType") ?? "") });
			}
		}
		const wanted = name?.trim().toLowerCase();
		const entry = wanted ? (entries.find((e) => e.name === wanted || e.file === wanted) ?? entries.find((e) => e.name.includes(wanted) || e.file.endsWith(`.${wanted}`))) : entries.find((e) => e.browser);
		if (entry) {
			const words = (entry.exec.match(/"[^"]*"|\S+/g) ?? []).map((w) => w.replace(/^"|"$/g, ""));
			const command = words.flatMap((w) => (/^%[uUfF]$/.test(w) ? urls : /^%[a-zA-Z]$/.test(w) ? [] : [w]));
			// Chromium shows its pages' elements on the accessibility bus only when asked.
			if (/chrom(e|ium)/.test(path.basename(command[0] ?? ""))) command.splice(1, 0, "--force-renderer-accessibility");
			return command;
		}
		if (wanted && /^[\w.+-]+$/.test(wanted)) {
			for (const dir of (host.env.PATH ?? "/usr/local/bin:/usr/bin:/bin").split(":")) {
				const program = path.join(dir, name!.trim());
				if (await fs.access(program, fs.constants.X_OK).then(() => true, () => false)) return [program, ...urls];
			}
		}
		throw new ToolError(name ? `There is no app called ${name} on this computer. list_apps shows what runs; an app installed with shell can be opened by its program's name.` : "This computer has no web browser to open the urls with.");
	};

	const tools: Record<string, (args: Args) => Promise<ToolResult>> = {
		async get_desktop_state() {
			const [shot, all, active] = await Promise.all([helper<{ width: number; height: number; jpeg: string }>("screenshot", { quality: 70 }), windows(), activeWindow()]);
			const listed = all.length ? all.map((w) => describe(w, active)).join("\n") : "- none";
			return {
				content: [
					{ type: "image", data: shot.jpeg, mimeType: "image/jpeg" },
					{ type: "text", text: `The desktop, ${shot.width}×${shot.height}; x and y in desktop_act are this screenshot's pixels.\nWindows:\n${listed}` },
				],
			};
		},
		async list_apps() {
			const [apps, all] = await Promise.all([helper<{ name: string; pid: number; windows: { name: string }[] }[]>("apps"), windows()]);
			const lines = apps.filter((a) => a.windows.length > 0 || all.some((w) => w.pid === a.pid)).map((a) => `- ${a.name || "(unnamed)"}, pid ${a.pid}: ${a.windows.map((w) => JSON.stringify(w.name)).join(", ") || "no windows"}`);
			// Apps that aren't on the accessibility bus are still on the screen: they are used by their windows' places.
			for (const pid of new Set(all.map((w) => w.pid))) {
				if (apps.some((a) => a.pid === pid)) continue;
				const name = (await fs.readFile(`/proc/${pid}/comm`, "utf8").catch(() => "")).trim() || "(unknown)";
				lines.push(`- ${name}, pid ${pid}: ${all.filter((w) => w.pid === pid).map((w) => JSON.stringify(w.title)).join(", ")} (no accessibility tree: act by x and y)`);
			}
			return { content: [{ type: "text", text: lines.length ? `Apps:\n${lines.join("\n")}` : "No apps are open. Open one with desktop_act launch_app." }] };
		},
		async get_window_state(args) {
			if (typeof args.pid !== "number") throw new ToolError("pid names the app: list_apps or desktop_look shows it.");
			const title = typeof args.window_id === "number" ? (await windows()).find((w) => w.id === args.window_id)?.title : undefined;
			const tree = await helper<{ app: string; window: string; elements: Element[]; cut: boolean }>("tree", { pid: args.pid, ...(title ? { title } : {}), limit: MAX_ELEMENTS });
			const id = `s${++taken}`;
			snapshots.set(id, { pid: args.pid, elements: tree.elements });
			for (const old of snapshots.keys()) if (snapshots.size > SNAPSHOTS) snapshots.delete(old);
			const query = typeof args.query === "string" && args.query.trim() !== "" ? args.query.trim().toLowerCase() : undefined;
			const lines = tree.elements.flatMap((el, i) => {
				if (query && ![el.role, el.name, el.value ?? ""].some((s) => s.toLowerCase().includes(query))) return [];
				const value = el.value !== undefined && el.value !== el.name ? ` = ${JSON.stringify(el.value.slice(0, 200))}` : "";
				const states = el.states.length ? ` (${el.states.join(", ")})` : "";
				return [`[${i + 1}] ${el.role} ${JSON.stringify(el.name)}${value}${states} at (${el.x}, ${el.y}) ${el.w}×${el.h}`];
			});
			const head = `Snapshot ${id}: ${JSON.stringify(tree.window)} of ${tree.app || "the app"}, pid ${args.pid}. An element's token is ${id}:N, such as ${id}:1.`;
			const tail = tree.cut ? `\n(Only the first ${MAX_ELEMENTS} elements; give a query to find others.)` : "";
			return { content: [{ type: "text", text: `${head}\n${lines.join("\n") || (query ? `No element matches ${JSON.stringify(query)}.` : "No elements.")}${tail}` }] };
		},
		click: async (args) => text(await click(args, 1, 1)),
		double_click: async (args) => text(await click(args, 1, 2)),
		right_click: async (args) => text(await click(args, 3, 1)),
		async type_text(args) {
			if (typeof args.text !== "string" || args.text === "") throw new ToolError("text is what to type.");
			await focus(args);
			if (args.element_token !== undefined) await click(args, 1, 1);
			await xdotool("type", "--delay", "8", "--", args.text);
			return text(`Typed ${args.text.length} characters.`);
		},
		async press_key(args) {
			if (typeof args.key !== "string" || args.key === "") throw new ToolError("key is the key to press, such as enter.");
			await focus(args);
			await xdotool("key", "--clearmodifiers", "--", args.key.split("+").map(keysym).join("+"));
			return text(`Pressed ${args.key}.`);
		},
		async hotkey(args) {
			const keys = Array.isArray(args.keys) ? args.keys.filter((k): k is string => typeof k === "string" && k !== "") : [];
			if (keys.length === 0) throw new ToolError("keys are the keys to press together, such as [\"ctrl\", \"s\"].");
			await focus(args);
			await xdotool("key", "--clearmodifiers", "--", keys.map(keysym).join("+"));
			return text(`Pressed ${keys.join("+")}.`);
		},
		async scroll(args) {
			const direction = (typeof args.direction === "string" ? args.direction : "down") as keyof typeof SCROLL;
			if (!(direction in SCROLL)) throw new ToolError("direction is up, down, left or right.");
			const amount = Math.min(50, Math.max(1, Math.round(Number(args.amount ?? 3)) || 3));
			await focus(args);
			let at: { x: number; y: number } | undefined;
			if (args.element_token !== undefined || args.x !== undefined) {
				const p = await point(args);
				if (!Number.isNaN(p.x)) at = p;
			} else if (typeof args.window_id === "number" || typeof args.pid === "number") {
				const w = (await windows()).find((one) => one.id === args.window_id || (args.window_id === undefined && one.pid === args.pid));
				if (w) at = { x: Math.round(w.x + w.w / 2), y: Math.round(w.y + w.h / 2) };
			}
			await xdotool(...(at ? ["mousemove", "--sync", String(at.x), String(at.y)] : []), "click", "--repeat", String(amount), "--delay", "30", String(SCROLL[direction]));
			return text(`Scrolled ${direction} ${amount}${at ? ` at (${at.x}, ${at.y})` : ""}.`);
		},
		async set_value(args) {
			if (typeof args.value !== "string") throw new ToolError("value is what to set.");
			if (args.element_token === undefined) throw new ToolError("set_value needs an element_token from desktop_read.");
			const target = await element(args.element_token);
			const name = `${target.el.role} ${JSON.stringify(target.el.name)}`;
			if (target.el.states.includes("editable") || /text|entry|terminal|document/.test(target.el.role)) {
				await act(target, "set_text", args.value);
				return text(`Set ${name} to ${JSON.stringify(args.value.slice(0, 200))}.`);
			}
			await act(target, "set_value", args.value);
			return text(`Set ${name} to ${args.value}.`);
		},
		async launch_app(args) {
			const urls = Array.isArray(args.urls) ? args.urls.filter((u): u is string => typeof u === "string" && u !== "") : [];
			const command = await launchCommand(typeof args.name === "string" && args.name.trim() !== "" ? args.name : undefined, urls);
			const started = await host.start(command[0]!, command.slice(1));
			// An app that fails at once (a missing library, no display) says so now rather than leaving the agent to look for a window that never comes.
			const code = await Promise.race([started.exited, new Promise<"running">((resolve) => setTimeout(() => resolve("running"), 1_500).unref())]);
			if (code !== "running" && code !== 0) throw new ToolError(`${path.basename(command[0]!)} exited at once (code ${code})${started.said() ? `: ${started.said().split("\n").slice(-5).join("\n")}` : "."}`);
			return text(`Opened ${path.basename(command[0]!)}${urls.length ? ` with ${urls.join(", ")}` : ""}, pid ${started.pid}. Its window may take a moment: desktop_look shows it.`);
		},
		async kill_app(args) {
			if (typeof args.pid !== "number") throw new ToolError("pid names the app to force-quit.");
			const apps = await helper<{ pid: number }[]>("apps").catch(() => []);
			// Only an app of this display: never the display's own processes, nor anything else of the computer.
			if (!(await windows()).some((w) => w.pid === args.pid) && !apps.some((a) => a.pid === args.pid)) throw new ToolError(`${args.pid} is not an app on this desktop: list_apps shows them.`);
			try {
				process.kill(args.pid, "SIGKILL");
			} catch (error) {
				throw new ToolError(`Couldn't force-quit ${args.pid}: ${(error as Error).message}`);
			}
			return text(`Force-quit ${args.pid}.`);
		},
	};

	let queue: Promise<unknown> = Promise.resolve();
	return {
		tools: Object.keys(tools),
		/** Runs one tool; calls run one at a time, since the display has one pointer and one keyboard. */
		call(name: string, args: Args): Promise<ToolResult> {
			const tool = tools[name];
			const run = async (): Promise<ToolResult> => {
				if (!tool) return { content: [{ type: "text", text: `This desktop has no tool ${name}.` }], isError: true };
				try {
					return await tool(args);
				} catch (error) {
					return { content: [{ type: "text", text: error instanceof Error ? error.message : String(error) }], isError: true };
				}
			};
			const result = queue.then(run, run);
			queue = result.catch(() => undefined);
			return result;
		},
	};
}

const text = (s: string): ToolResult => ({ content: [{ type: "text", text: s }] });

/** The driver's MCP server: JSON-RPC over POST /mcp, answered as JSON, behind the bearer token. */
export function driverServer(token: string, driver: ReturnType<typeof desktopDriver>): Server {
	const send = (res: ServerResponse, status: number, body?: unknown, headers: Record<string, string> = {}) => {
		res.writeHead(status, { ...(body === undefined ? {} : { "content-type": "application/json" }), ...headers });
		res.end(body === undefined ? undefined : JSON.stringify(body));
	};
	return createServer(async (req: IncomingMessage, res: ServerResponse) => {
		if (req.headers.authorization !== `Bearer ${token}`) return send(res, 401, { error: "unauthorized" });
		const chunks: Buffer[] = [];
		for await (const chunk of req) chunks.push(chunk as Buffer);
		if (req.url !== "/mcp") {
			// cua-env-driver also streams its display over gRPC-Web; this one doesn't.
			res.writeHead(200, { "content-type": "application/grpc-web+proto", "grpc-status": "12", "grpc-message": encodeURIComponent("Pim's desktop driver doesn't stream the display: watch the chat's browser instead.") });
			return res.end();
		}
		if (req.method !== "POST") return send(res, 405);
		let message: { id?: number | string; method?: string; params?: { name?: string; arguments?: Args } };
		try {
			message = JSON.parse(Buffer.concat(chunks).toString("utf8"));
		} catch {
			return send(res, 400, { jsonrpc: "2.0", id: null, error: { code: -32700, message: "Parse error" } });
		}
		const reply = (result: unknown, headers?: Record<string, string>) => send(res, 200, { jsonrpc: "2.0", id: message.id, result }, headers);
		switch (message.method) {
			case "initialize":
				return reply({ protocolVersion: "2025-06-18", capabilities: { tools: {} }, serverInfo: { name: "pim-desktop-driver", version: "1" } }, { "mcp-session-id": randomUUID() });
			case "tools/list":
				return reply({ tools: driver.tools.map((name) => ({ name, inputSchema: { type: "object" } })) });
			case "tools/call":
				return reply(await driver.call(String(message.params?.name ?? ""), message.params?.arguments ?? {}));
			default:
				if (message.id === undefined) return send(res, 202);
				return send(res, 200, { jsonrpc: "2.0", id: message.id, error: { code: -32601, message: `Unknown method ${message.method}` } });
		}
	});
}

async function main(argv: string[]): Promise<void> {
	const option = (name: string) => {
		const at = argv.indexOf(name);
		return at >= 0 ? argv[at + 1] : undefined;
	};
	if (argv[0] !== "serve") {
		console.error("usage: desktop-driver.ts serve --listen 127.0.0.1:PORT --token-file FILE");
		process.exit(2);
	}
	const [hostName = "127.0.0.1", port = "3220"] = (option("--listen") ?? "").split(":");
	const tokenFile = option("--token-file");
	const token = tokenFile ? (await fs.readFile(tokenFile, "utf8")).trim() : (process.env.PIM_DRIVER_TOKEN ?? "");
	if (!token) {
		console.error("desktop-driver: no token: give --token-file");
		process.exit(2);
	}
	const server = driverServer(token, desktopDriver());
	server.listen(Number(port), hostName, () => console.log(`desktop-driver listening on ${hostName}:${port} for display ${process.env.DISPLAY ?? "(none)"}`));
	for (const signal of ["SIGTERM", "SIGINT"] as const) process.on(signal, () => server.close(() => process.exit(0)));
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await main(process.argv.slice(2));
