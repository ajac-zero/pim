import type { JsonValue, Message } from "@earendil-works/pi-ai";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import { getAgentByName } from "agents";
import { env } from "cloudflare:test";
import { exports } from "cloudflare:workers";
import { afterEach, beforeAll, expect, vi } from "vitest";
import type { Approval } from "../src/store";
import type { TranscriptMessage } from "../src/transcript";
import { faux } from "./worker";

/**
 * Each test file gets its own storage, so each file starts with a fresh
 * Pim; tests within a file share it. Before they run, the file's Pim gets
 * its admin, whose Pim the tests talk to with an API token: `OWNER` names
 * that Pim, and `TOKEN` opens it.
 */
export let OWNER = "";
export let TOKEN = "";
/** The public id of the Pim's root session, where API clients talk by default. */
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

/** A path in the Pim's API, which the Worker serves under `/api`. */
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

/** The run an approval's decision started in its conversation, once settled. */
export async function decisionRun(approval: Approval) {
	const { body } = await api(`/sessions/${approval.session}/operations/${encodeURIComponent(`approval:${approval.id}`)}`);
	return body as { status: string; replies: string[]; text?: string };
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

afterEach(() => {
	vi.restoreAllMocks();
	// Every scripted model response was used: the Pim did what the test expected.
	expect(faux.getPendingResponseCount()).toBe(0);
});
