import * as fs from "node:fs/promises";
import type { JsonValue, Message } from "@earendil-works/pi-ai";
import { type FauxResponseFactory, fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import { getAgentByName } from "agents";
import { env } from "cloudflare:test";
import { exports } from "cloudflare:workers";
import { afterEach, beforeAll, expect, vi } from "vitest";
import { type BrowserHost, type ExecArgs, type ExecResult, Link, type Machine, type ScreenHost } from "../computer/pim-computer";
import { ownedCode } from "../src/auth";
import type { Approval } from "../src/store";
import type { TranscriptMessage } from "../src/transcript";
import { faux } from "./worker";
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

beforeAll(async () => {
	const directory = env.Directory.getByName("directory");
	const registered = await directory.register({
		username: "tester",
		ip: "192.0.2.1",
		claim: { window: true },
		policy: { mode: "open", maxAccounts: null, perAddressPerDay: 100 },
	});
	if (!registered.ok) throw new Error(registered.error);
	OWNER = registered.account.ownerId;
	await directory.activate(OWNER);
	const agent = await getAgentByName(env.Pim, OWNER);
	await agent.provision({ ownerId: OWNER, username: "tester" });
	TOKEN = (await env.Auth.getByName(OWNER).createToken(OWNER, "tests", Date.now())).token;
	ROOT = (await api("/")).body.rootSession;
});

export function url(path: string) {
	return `https://pim.test${path}`;
}

/** A path in the space's API, which the Worker serves under `/api`. */
export function apiUrl(path: string) {
	return url(`/api${path}`);
}

export async function api<T = any>(path: string, init: RequestInit = {}): Promise<{ status: number; body: T }> {
	const response = await exports.default.fetch(
		new Request(apiUrl(path), {
			...init,
			headers: { Authorization: `Bearer ${TOKEN}`, "content-type": "application/json", ...init.headers },
		}),
	);
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
	return vi.waitFor(async () => {
		const [approval] = (await api<{ approvals: Approval[] }>("/approvals?status=pending")).body.approvals;
		expect(approval).toBeDefined();
		return approval!;
	});
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

afterEach(() => {
	vi.restoreAllMocks();
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

/**
 * A computer as pim-computer is one: its own `Link`, over a folder in this
 * test's /tmp, connected with `token`. Commands go to `exec`: tests can't
 * start processes. Its browser, if it has one, is `testBrowser`'s, and its
 * desktop, if it streams one, the `screen` the test gives.
 */
export async function connectTestComputer(token: string, root: string, exec: (args: ExecArgs) => Promise<ExecResult>, browser?: BrowserHost, screen?: ScreenHost) {
	await fs.mkdir(root, { recursive: true });
	const machine: Machine = { root: await fs.realpath(root), exec, ...(browser ? { browser } : {}), ...(screen ? { screen } : {}) };
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
			screen: screen !== undefined,
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
