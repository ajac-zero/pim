import * as fs from "node:fs/promises";
import type { JsonValue, Message } from "@earendil-works/pi-ai";
import { type FauxResponseFactory, fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import { getAgentByName } from "agents";
import { env } from "cloudflare:test";
import { exports } from "cloudflare:workers";
import { afterAll, afterEach, beforeAll, beforeEach, expect, vi } from "vitest";
import { type BrowserHost, type ExecArgs, type ExecResult, Link, type Machine } from "../computer/pim-computer";
import { ownedCode } from "../src/auth";
import type { Approval } from "../src/store";
import type { TranscriptMessage } from "../src/transcript";
import { faux } from "./worker";
import { requestLabel, Waits } from "./waits";
import { Authenticator } from "./webauthn";

/**
 * Each test file gets its own storage, so each file starts with a fresh
 * Pim; tests within a file share it. Before they run, the file's Pim gets
 * its admin, whose space the tests talk to with an API token: `OWNER` names
 * that space, and `TOKEN` opens it.
 */
export let OWNER = "";
export let TOKEN = "";
/** The public id of the space's root session, where API clients talk by default. */
export let ROOT = "";

/**
 * The waits of the setup or test under way (./waits.ts). A failed test
 * reports them, as they stood when it ran out of time if it did, and setup
 * that never finished reports its own. After each test, the work it started
 * through `waits().start` must finish within `SETTLE_MS` of its gates
 * opening, or the test fails.
 */
let current = new Waits("setup");
const SETTLE_MS = 5_000;

/** The current setup's or test's waits. */
export function waits(): Waits {
	return current;
}

/** Starts recording a `beforeAll`'s waits, so setup that never finishes says where it stopped. */
export function recordSetup(): void {
	current = new Waits("setup");
}

const report = () => current.report({ fauxPending: faux.getPendingResponseCount() });

beforeAll(async () => {
	recordSetup();
	const directory = env.Directory.getByName("directory");
	const registered = await current.watch(
		"setup: register",
		directory.register({
			username: "tester",
			ip: "192.0.2.1",
			claim: { window: true },
			policy: { mode: "open", maxAccounts: null, perAddressPerDay: 100 },
		}),
	);
	if (!registered.ok) throw new Error(registered.error);
	OWNER = registered.account.ownerId;
	await current.watch("setup: activate", directory.activate(OWNER));
	const agent = await current.watch("setup: space", getAgentByName(env.Pim, OWNER));
	await current.watch("setup: provision", agent.provision({ ownerId: OWNER, username: "tester" }));
	TOKEN = (await current.watch("setup: token", env.Auth.getByName(OWNER).createToken(OWNER, "tests", Date.now()))).token;
	ROOT = (await api("/")).body.rootSession;
});

beforeEach((context) => {
	current = new Waits("test", context.signal);
	// Taken as the test runs out of time, before its gates are opened after it; printed once its afterEach hooks have run.
	let atTimeout: string | undefined;
	context.signal.addEventListener("abort", () => void (atTimeout = report()), { once: true });
	context.onTestFailed(() => console.error(atTimeout ?? report()));
});

afterAll(() => {
	// Setup that never finished, which the test runner reports only as a hook that ran out of time.
	if (current.scope === "setup" && current.waiting) throw new Error(`Setup never finished: ${report()}`);
});

export function url(path: string) {
	return `https://pim.test${path}`;
}

/** A path in the space's API, which the Worker serves under `/api`. */
export function apiUrl(path: string) {
	return url(`/api${path}`);
}

export async function api<T = any>(path: string, init: RequestInit = {}): Promise<{ status: number; body: T }> {
	const request = new Request(apiUrl(path), {
		...init,
		headers: { Authorization: `Bearer ${TOKEN}`, "content-type": "application/json", ...init.headers },
	});
	const response = await current.watch(requestLabel(request), exports.default.fetch(request));
	return { status: response.status, body: (await response.json()) as T };
}

export function post<T = any>(path: string, body: unknown = {}) {
	return api<T>(path, { method: "POST", body: JSON.stringify(body) });
}

/** The session cookie of a browser signed in as `owner`, with a passkey of its own. */
export async function signedIn(owner = OWNER): Promise<string> {
	const call = (path: string, body: unknown, cookie?: string) =>
		exports.default.fetch(
			new Request(url(`/auth${path}`), {
				method: "POST",
				headers: { origin: "https://pim.test", "content-type": "application/json", "CF-Connecting-IP": "192.0.2.80", ...(cookie ? { cookie } : {}) },
				body: JSON.stringify(body),
			}),
		);
	const cookies = (response: Response) => response.headers.getSetCookie().map((cookie) => cookie.split(";")[0]).join("; ");
	const { code } = await env.Auth.getByName(owner).issueSetupCode(Date.now(), 60_000);
	const options = await call("/passkeys/options", { setup: ownedCode(owner, code) });
	const authenticator = await Authenticator.make();
	const created = await call("/passkeys", { ...(await authenticator.register((await options.json()) as { challenge: string })), name: "Tests" }, cookies(options));
	expect(created.status).toBe(200);
	return cookies(created);
}

/**
 * Comes back from a service as a browser does: the service's redirect, a
 * GET, which carries no cookie of Pim's; then the post the page it gets
 * makes from Pim's own origin, with the browser's cookie, if any.
 */
export async function comeBack(params: Record<string, string>, cookie?: string): Promise<Response> {
	const page = await exports.default.fetch(url(`/mcp/callback/apps?${new URLSearchParams(params)}`));
	expect(page.status).toBe(200);
	const fields = [...(await page.text()).matchAll(/<input type="hidden" name="([^"]*)" value="([^"]*)">/g)].map((match) => [match[1]!, match[2]!]);
	expect(Object.fromEntries(fields)).toEqual(params);
	return exports.default.fetch(
		new Request(url("/mcp/callback/apps"), {
			method: "POST",
			headers: { origin: "https://pim.test", "content-type": "application/x-www-form-urlencoded", ...(cookie ? { cookie } : {}) },
			body: new URLSearchParams(fields),
		}),
	);
}

/** Sends a message and waits for the answer. */
export async function say(content: string, session = ROOT) {
	const { status, body } = await post(`/sessions/${session}/messages`, { content, wait: true });
	expect(status).toBe(200);
	return body as { status: string; text?: string; reason?: string };
}

/** The approval waiting for the user. */
export async function pendingApproval() {
	return current.watch(
		"pending approval",
		vi.waitFor(async () => {
			const [approval] = (await api<{ approvals: Approval[] }>("/approvals?status=pending")).body.approvals;
			expect(approval).toBeDefined();
			return approval!;
		}),
	);
}

/** Opens the WebSocket and collects every message the server sends. */
export async function connect(session?: string) {
	const query = new URLSearchParams({ token: TOKEN, ...(session ? { session } : {}) });
	const upgrade = await exports.default.fetch(apiUrl(`/ws?${query}`), { headers: { Upgrade: "websocket" } });
	expect(upgrade.status).toBe(101);
	const socket = upgrade.webSocket!;
	const received: any[] = [];
	socket.addEventListener("message", (event) => {
		received.push(JSON.parse(event.data as string));
	});
	socket.accept();
	return { socket, received };
}

export function systemPrompt(messages: readonly Message[]): string {
	return JSON.stringify(messages.filter((message) => message.role === "system"));
}

export function lastUserText(messages: readonly Message[]): string {
	const user = messages.findLast((message) => message.role === "user");
	if (!user) return "";
	return typeof user.content === "string"
		? user.content
		: user.content.flatMap((part) => (part.type === "text" ? [part.text] : [])).join("");
}

export function textOf(message: TranscriptMessage): string {
	return message.parts.flatMap((part) => (part.type === "text" ? [part.text] : [])).join("");
}

export const toolUse = (name: string, args: Record<string, JsonValue>) =>
	fauxAssistantMessage(fauxToolCall(name, args), { stopReason: "toolUse" });

type Context = Parameters<FauxResponseFactory>[0];

/**
 * Who a request is from, by its prompt: an agent at work on a task, by name;
 * the majordomo reviewing an approval; or the agent a chat is with (`lead`).
 */
export function speaker(context: Context): string {
	const prompt = systemPrompt(context.messages);
	if (/the majordomo of one person/.test(prompt)) return "review";
	return /You are \\"([^"\\]+)\\", working on a task/.exec(prompt)?.[1] ?? "lead";
}

/**
 * Answers each request with the script of whoever asked, in order: agents
 * work at the same time, so the order of their requests isn't fixed. The
 * agent a chat is with answers with its own script, by name, if it has one,
 * or else with `lead`'s.
 */
export function scripts(byRole: Record<string, ((context: Context) => ReturnType<FauxResponseFactory>)[]>) {
	const count = Object.values(byRole).reduce((sum, list) => sum + list.length, 0);
	const route = (context: Context) => {
		const agent = /In this conversation you are \\"([^"\\]+)\\"/.exec(systemPrompt(context.messages))?.[1];
		const role = speaker(context) === "lead" && agent !== undefined && agent in byRole ? agent : speaker(context);
		const next = byRole[role]?.shift();
		if (!next) throw new Error(`No response left for ${role}`);
		return next(context);
	};
	faux.setResponses(Array.from({ length: count }, () => route));
}

/** Waits until every scripted response is used, the chat's tasks are done, and the chat is idle: the work begun there is over. */
export async function settled(session = ROOT) {
	await vi.waitFor(
		async () => {
			expect(faux.getPendingResponseCount()).toBe(0);
			const { tasks } = (await api<{ tasks: { state: string }[] }>(`/sessions/${session}/tasks`)).body;
			expect(tasks.filter((task) => task.state === "working" || task.state === "auth-required")).toEqual([]);
			const { sessions } = (await api<{ sessions: { id: string; busy: boolean }[] }>("/sessions")).body;
			expect(sessions.find((info) => info.id === session)?.busy).toBe(false);
		},
		{ timeout: 10_000 },
	);
}

/** The text of a chat's messages from `role`, in order. */
export async function messagesOf(session: string, role: "user" | "assistant" | "tool") {
	const { messages } = (await api<{ messages: TranscriptMessage[] }>(`/sessions/${session}/messages`)).body;
	return messages.filter((message) => message.role === role).map(textOf);
}

afterEach(async () => {
	// Before the test's stand-ins are restored, which what it started may still use.
	const unsettled = await current.settle(SETTLE_MS).then(
		() => null,
		(error: unknown) => error,
	);
	vi.restoreAllMocks();
	if (unsettled) throw unsettled;
	// Every scripted model response was used: the space did what the test expected.
	expect(faux.getPendingResponseCount()).toBe(0);
});

/** Opens a WebSocket at `path` in the API with `token`. */
export const opens = (path: string, token: string) =>
	exports.default.fetch(new Request(apiUrl(path), { headers: { Upgrade: "websocket", Authorization: `Bearer ${token}` } }));

/**
 * The tests' Chrome as a computer's browser: wrangler's local Chrome, which
 * stands in for Browser Run, reached through its binding. Each connection
 * is a DevTools socket to one session it keeps until stopped.
 */
export function testBrowser(): BrowserHost {
	const binding = (env as unknown as { BROWSER: Fetcher }).BROWSER;
	let session: string | undefined;
	const open = async (id: string) => {
		const response = await binding.fetch(`https://fake.host/v1/devtools/browser/${id}`, { headers: { Upgrade: "websocket" } });
		const socket = response.webSocket!;
		socket.accept();
		return socket;
	};
	return {
		async connect(onMessage, onClose) {
			if (!session) {
				const acquired = await binding.fetch("https://fake.host/v1/devtools/browser?keep_alive=600000", { method: "POST" });
				session = ((await acquired.json()) as { sessionId: string }).sessionId;
			}
			const socket = await open(session);
			socket.addEventListener("message", (event) => onMessage(String(event.data)));
			socket.addEventListener("close", () => onClose());
			return { send: (data) => socket.send(data), close: () => socket.close() };
		},
		running: async () => session !== undefined,
		async stop() {
			if (!session) return;
			const socket = await open(session);
			session = undefined;
			socket.send(JSON.stringify({ id: 1, method: "Browser.close" }));
			socket.close();
		},
	};
}

/** A DevTools message as it reached the fixture's browser. */
export type Packet = { id: number; method: string; sessionId?: string; params: Record<string, unknown> };

type Page = { targetId: string; sessionId: string; loaderId: number; url: string; context: number; world: string | null };

/**
 * A browser for tests that is no browser: an in-process DevTools peer that
 * answers what puppeteer asks with fixed values and records every message
 * that reached it. Nothing runs and no page exists; its one page reads as
 * a heading, a button and a text box. Tests hold back answers to methods
 * (`hold`), answer them with protocol errors (`fail`), send messages of
 * their own (`inject`) and close the connection (`drop`).
 */
export function fakeChrome() {
	const packets: Packet[] = [];
	const hold = new Set<string>();
	const fail = new Set<string>();
	const pages = new Map<string, Page>();
	let link: { send(message: unknown): void; close(): void } | null = null;
	let running = false;
	let next = 1;

	const browserInfo = { targetId: "browser", type: "browser", title: "", url: "", attached: true, canAccessOpener: false };
	const infoOf = (page: Page) => ({ targetId: page.targetId, type: "page", title: "Fixture", url: page.url, attached: true, canAccessOpener: false, browserContextId: "default" });
	const frameOf = (page: Page) => ({ id: page.targetId, loaderId: `L${page.loaderId}`, url: page.url, domainAndRegistry: "", securityOrigin: "", mimeType: "text/html", secureContextType: "Secure", crossOriginIsolatedContextType: "NotIsolated", gatedAPIFeatures: [] });
	const contexts = (page: Page) => {
		const send = (id: number, name: string, isDefault: boolean) =>
			link?.send({ method: "Runtime.executionContextCreated", sessionId: page.sessionId, params: { context: { id, origin: "", name, uniqueId: `u${id}`, auxData: { frameId: page.targetId, isDefault, type: isDefault ? "default" : "isolated" } } } });
		page.context = next++;
		send(page.context, "", true);
		if (page.world) send(next++, page.world, false);
	};
	const attach = (page: Page) => link?.send({ method: "Target.attachedToTarget", params: { sessionId: page.sessionId, targetInfo: infoOf(page), waitingForDebugger: false } });

	/** What the page answers to a script, by what the script is. */
	function evaluate(params: Record<string, unknown>) {
		const source = String(params.expression ?? params.functionDeclaration ?? "");
		const byValue = params.returnByValue === true;
		if (source.includes("INTERACTIVE")) {
			const first = Number(/\(\[(\d+),/.exec(source)?.[1] ?? 1);
			return { result: { type: "object", value: { text: `# Fixture\n[${first} button “Go”] [${first + 1} textbox “Name”]`, truncated: false, next: first + 2 } } };
		}
		if (source.includes("data-pim-ref=\"' + ref")) return { result: { type: "string", value: "the button “Go”" } };
		if (source.includes("document.title")) return { result: { type: "string", value: "Fixture" } };
		if (source.includes("documentWidth")) return { result: { type: "object", value: { documentWidth: 1280, documentHeight: 800 } } };
		if (source.includes("getClientRects")) return { result: { type: "object", value: [{ x: 10, y: 10, width: 100, height: 30 }] } };
		if (byValue) return { result: { type: "undefined" } };
		return { result: { type: "object", subtype: "node", className: "HTMLElement", description: "button", objectId: `object-${next++}` } };
	}

	function answer(packet: Packet): unknown {
		const page = [...pages.values()].find((candidate) => candidate.sessionId === packet.sessionId);
		const params = packet.params;
		switch (packet.method) {
			case "Target.getBrowserContexts":
				return { browserContextIds: [] };
			case "Target.setDiscoverTargets":
				link?.send({ method: "Target.targetCreated", params: { targetInfo: browserInfo } });
				for (const each of pages.values()) link?.send({ method: "Target.targetCreated", params: { targetInfo: infoOf(each) } });
				return {};
			case "Target.setAutoAttach":
				if (!packet.sessionId) for (const each of pages.values()) attach(each);
				return {};
			case "Target.attachToTarget": {
				const sessionId = `browser-session-${next++}`;
				link?.send({ method: "Target.attachedToTarget", params: { sessionId, targetInfo: browserInfo, waitingForDebugger: false } });
				return { sessionId };
			}
			case "Target.createTarget": {
				const id = next++;
				const created: Page = { targetId: `page-${id}`, sessionId: `page-session-${id}`, loaderId: 1, url: String(params.url), context: 0, world: null };
				pages.set(created.targetId, created);
				link?.send({ method: "Target.targetCreated", params: { targetInfo: infoOf(created) } });
				attach(created);
				return { targetId: created.targetId };
			}
			case "Target.closeTarget": {
				const closed = pages.get(String(params.targetId));
				if (closed) {
					pages.delete(closed.targetId);
					link?.send({ method: "Target.detachedFromTarget", params: { sessionId: closed.sessionId, targetId: closed.targetId } });
					link?.send({ method: "Target.targetDestroyed", params: { targetId: closed.targetId } });
				}
				return { success: true };
			}
			case "Browser.getVersion":
				return { protocolVersion: "1.3", product: "Chrome/0", revision: "0", userAgent: "Mozilla/5.0 Chrome/0", jsVersion: "0" };
			case "Page.getFrameTree":
				return { frameTree: { frame: frameOf(page!), childFrames: [] } };
			case "Runtime.enable":
				queueMicrotask(() => contexts(page!));
				return {};
			case "Page.createIsolatedWorld":
				page!.world = String(params.worldName);
				return { executionContextId: next++ };
			case "Page.navigate": {
				page!.loaderId++;
				page!.url = String(params.url);
				setTimeout(() => {
					const at = { frameId: page!.targetId, loaderId: `L${page!.loaderId}`, timestamp: 0 };
					link?.send({ method: "Runtime.executionContextsCleared", sessionId: page!.sessionId, params: {} });
					link?.send({ method: "Page.frameNavigated", sessionId: page!.sessionId, params: { frame: frameOf(page!), type: "Navigation" } });
					contexts(page!);
					for (const name of ["init", "DOMContentLoaded", "load", "networkIdle"]) link?.send({ method: "Page.lifecycleEvent", sessionId: page!.sessionId, params: { ...at, name } });
				}, 0);
				return { frameId: page!.targetId, loaderId: `L${page!.loaderId}` };
			}
			case "Runtime.evaluate":
			case "Runtime.callFunctionOn":
				return evaluate(params);
			case "DOM.getContentQuads":
				return { quads: [[10, 10, 110, 10, 110, 40, 10, 40]] };
			case "DOM.describeNode":
				return { node: { nodeId: 1, backendNodeId: 1, nodeType: 1, nodeName: "BUTTON", localName: "button", nodeValue: "" } };
			case "DOM.resolveNode":
				return { object: { type: "object", subtype: "node", objectId: `object-${next++}` } };
			case "Page.getLayoutMetrics": {
				const viewport = { pageX: 0, pageY: 0, clientWidth: 1280, clientHeight: 800, offsetX: 0, offsetY: 0, scale: 1, zoom: 1 };
				return { layoutViewport: viewport, visualViewport: viewport, cssLayoutViewport: viewport, cssVisualViewport: viewport, contentSize: { x: 0, y: 0, width: 1280, height: 800 }, cssContentSize: { x: 0, y: 0, width: 1280, height: 800 } };
			}
			case "Page.captureScreenshot":
				return { data: btoa(String.fromCharCode(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a)) };
			default:
				return {};
		}
	}

	const host: BrowserHost = {
		async connect(onMessage, onClose) {
			running = true;
			const channel = {
				send: (message: unknown) => onMessage(JSON.stringify(message)),
				close: () => {
					if (link !== channel) return;
					link = null;
					onClose();
				},
			};
			link = channel;
			return {
				send(data) {
					const packet = JSON.parse(data) as Packet;
					packet.params ??= {};
					packets.push(packet);
					if (hold.has(packet.method)) return;
					const reply = { id: packet.id, ...(packet.sessionId ? { sessionId: packet.sessionId } : {}) };
					if (fail.has(packet.method)) channel.send({ ...reply, error: { code: -32000, message: "The fixture refuses this." } });
					else {
						const result = answer(packet);
						channel.send({ ...reply, result });
					}
				},
				close() {
					if (link === channel) link = null;
				},
			};
		},
		running: async () => running,
		async stop() {
			running = false;
			pages.clear();
			link?.close();
		},
	};

	return {
		host,
		packets,
		hold,
		fail,
		/** Messages that reached it with `method`, from `since` on. */
		sent: (method: string, since = 0) => packets.slice(since).filter((packet) => packet.method === method),
		/** Sends a message of the test's own, as if the browser had: an answer nobody asked for, or a late one. */
		inject: (message: unknown) => link?.send(message),
		/** The browser closes the connection, answering nothing more. */
		drop: () => link?.close(),
	};
}

/**
 * A computer as pim-computer is one: its own `Link`, over a folder in this
 * test's /tmp, connected with `token`. Commands go to `exec`: tests can't
 * start processes. Its browser, if it has one, is `testBrowser`'s.
 */
export async function connectTestComputer(token: string, root: string, exec: (args: ExecArgs) => Promise<ExecResult>, browser?: BrowserHost) {
	await fs.mkdir(root, { recursive: true });
	const machine: Machine = { root: await fs.realpath(root), exec, ...(browser ? { browser } : {}) };
	const response = await opens("/computer/connect", token);
	expect(response.status).toBe(101);
	const socket = response.webSocket!;
	const closed = new Promise<CloseEvent>((resolve) => socket.addEventListener("close", resolve));
	const link = new Link(machine, (message) => socket.send(message));
	socket.addEventListener("message", (event) => link.receive(event.data as string));
	socket.addEventListener("close", () => link.close());
	socket.accept();
	socket.send(
		JSON.stringify({
			type: "hello",
			version: 1,
			agent: "pim-computer/test",
			hostname: "test-box",
			platform: "linux",
			arch: "x64",
			user: "ada",
			root: machine.root,
			browser: browser ? "chrome" : null,
		}),
	);
	await vi.waitFor(async () => expect((await api("/computer")).body.state).toBe("online"));
	return { socket, closed, root: machine.root };
}

/** Pairs a computer with the space and connects it, over a fresh folder, with the tests' Chrome; it runs no commands. */
export async function pairTestComputer() {
	const { body } = await post<{ token: string }>("/computer");
	return connectTestComputer(
		body.token,
		`/tmp/computer-${crypto.randomUUID()}`,
		async () => {
			throw new Error("This test's computer runs no commands.");
		},
		testBrowser(),
	);
}
