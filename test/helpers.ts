import type { JsonValue, Message } from "@earendil-works/pi-ai";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import { exports } from "cloudflare:workers";
import { afterEach, expect, vi } from "vitest";
import type { TranscriptMessage } from "../src/transcript";
import { faux } from "./worker";

/**
 * Each test file gets its own storage, so each file starts with a fresh
 * agent; tests within a file share it.
 */
export const TOKEN = "test-token";

export function url(path: string) {
	return `https://pim.test${path}`;
}

export async function api<T = any>(path: string, init: RequestInit = {}): Promise<{ status: number; body: T }> {
	const response = await exports.default.fetch(
		new Request(url(path), {
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
export async function say(content: string, session = "1") {
	const { status, body } = await post(`/sessions/${session}/messages`, { content, wait: true });
	expect(status).toBe(200);
	return body as { status: string; text?: string; reason?: string };
}

/** Opens the WebSocket and collects every message the server sends. */
export async function connect(session?: string) {
	const query = new URLSearchParams({ token: TOKEN, ...(session ? { session } : {}) });
	const upgrade = await exports.default.fetch(url(`/ws?${query}`), { headers: { Upgrade: "websocket" } });
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
	// Every scripted model response was used: the agent did what the test expected.
	expect(faux.getPendingResponseCount()).toBe(0);
});
