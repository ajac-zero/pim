/**
 * What the model-call ledger keeps of each request besides its tokens (v1's `src/model-calls.ts` and `src/usage.ts`): how it ended, how long it took, the provider's own error, where its time
 * went (`./model-phases.ts`), what it was for, and how large it was. The failover (`./provider-failover.ts`) is where every request of a chat is seen, with its attempts, but not whose chat
 * it is; the hook that records the request (`./agent-host.ts`) knows the chat and the agent but not the attempts. So the failover leaves what it saw here, under the answer it produced, and
 * the hook takes it from here: a map with a bound, for a request whose hook never came, such as one that was cut off.
 *
 * Only facts are kept: sizes, times, status codes and the provider's error without credentials. Never a prompt, an address or a key.
 */
import { redactSecrets } from "@pim/shared/redact";
import { isDeliveryReminder, NOTICE_PREFIXES } from "@pim/shared/transcript";
import { CallPhases, type ModelPhases } from "./model-phases.ts";

/** A call this slow is reported as unusual, and keeps its request and phases. */
export const SLOW_CALL_MS = 60_000;
const ERROR_KEEP = 4_000;
const KEPT = 500;

/** What a request was for: the person's message, a schedule or trigger firing, or a task another agent gave. */
export type RunKind = "chat" | "scheduled" | "trigger" | "task";

export type CallDetail = {
	stopReason: string;
	latencyMs: number;
	error?: string;
	/** The request without its content, and where its time went; kept for a call that failed or was slow. */
	request?: Record<string, unknown>;
	turnIndex: number;
	toolCount: number;
	promptBytes: number;
	runKind: RunKind;
};
/** An attempt that failed and was tried again on the next model of the chat's list. */
export type FailedAttempt = { provider: string; model: string; detail: CallDetail };
export type KeptCall = CallDetail & { failures: FailedAttempt[] };

const kept = new Map<string, KeptCall>();
const keyOf = (ownerId: string, message: { provider?: string; model?: string; timestamp?: number }) => `${ownerId}\u0000${message.provider}/${message.model}/${message.timestamp}`;

/** Leaves what was seen of the request that produced `message`. */
export function keepCall(ownerId: string, message: { provider?: string; model?: string; timestamp?: number }, call: KeptCall): void {
	kept.set(keyOf(ownerId, message), call);
	if (kept.size > KEPT) kept.delete(kept.keys().next().value as string);
}

/** Takes it back, once. */
export function takeCall(ownerId: string, message: { provider?: string; model?: string; timestamp?: number }): KeptCall | undefined {
	const key = keyOf(ownerId, message);
	const call = kept.get(key);
	kept.delete(key);
	return call;
}

/** A request without its content: its settings, such as thinking and token limits, and how many messages and tools it carried. */
function requestShape(value: unknown, depth = 0): Record<string, unknown> | undefined {
	if (typeof value !== "object" || value === null) return undefined;
	const shape: Record<string, unknown> = {};
	for (const [key, entry] of Object.entries(value)) {
		if (key === "metadata") continue;
		if (Array.isArray(entry)) shape[key] = `${entry.length} items`;
		else if (typeof entry === "string") shape[key] = entry.length <= 40 ? entry : `${entry.length} characters`;
		else if (typeof entry === "object" && entry !== null) shape[key] = depth < 2 ? requestShape(entry, depth + 1) : "object";
		else shape[key] = entry;
	}
	return shape;
}

/** What of a request's body is worth knowing beside its settings: how many tools it carried and how large their schemas were, how large the whole was, and how many cache breakpoints it set. */
function payloadFacts(payload: unknown): Record<string, unknown> {
	try {
		const text = JSON.stringify(payload) ?? "";
		const tools = (payload as { tools?: unknown } | null)?.tools;
		return {
			payload_bytes: new TextEncoder().encode(text).byteLength,
			cache_control_breakpoints: text.split('"cache_control"').length - 1,
			...(Array.isArray(tools) ? { tool_count: tools.length, tool_schema_bytes: new TextEncoder().encode(JSON.stringify(tools)).byteLength } : {}),
		};
	} catch {
		return {};
	}
}

const textOf = (message: { content?: unknown }) => (typeof message.content === "string" ? message.content : Array.isArray(message.content) ? message.content.flatMap((part: { type?: string; text?: string }) => (part.type === "text" ? [part.text ?? ""] : [])).join("") : "");

/** What the request is for, from the message that began the turn: Pim's notice of a schedule, a trigger or a task, else the person. */
function runKindOf(messages: readonly { role?: string; content?: unknown }[]): RunKind {
	const started = messages.findLast((m) => m.role === "user" && !isDeliveryReminder(textOf(m)));
	const text = started ? textOf(started) : "";
	const notice = NOTICE_PREFIXES.find(([prefix]) => prefix.test(text))?.[1];
	return notice === "schedule" ? "scheduled" : notice === "event" ? "trigger" : notice === "task" ? "task" : "chat";
}

/** How large the request was, JSON characters standing for bytes: the transcript, how many tools it offered, and how deep into the conversation it is (the answers already in it). */
function shapeOf(context: { messages?: readonly any[] } | undefined): Pick<CallDetail, "turnIndex" | "toolCount" | "promptBytes" | "runKind"> {
	const messages = Array.isArray(context?.messages) ? context!.messages! : [];
	// A transcript carries its tools in its system messages.
	const tools = new Map<string, true>();
	for (const message of messages) {
		if (message?.role !== "system") continue;
		for (const tool of message.toolsRemoved ?? []) tools.delete(tool.name);
		for (const tool of message.toolsAdded ?? []) tools.set(tool.name, true);
	}
	let promptBytes = 0;
	try {
		promptBytes = (JSON.stringify(messages) ?? "").length;
	} catch {
		// A transcript that cannot be measured has no size.
	}
	return { promptBytes, toolCount: tools.size, turnIndex: messages.filter((m) => m?.role === "assistant").length, runKind: runKindOf(messages) };
}

/**
 * Watches one attempt of a request. `options` are the request's, with its `fetch`, the payload and the provider's stream events watched (a provider whose adapter refuses a `fetch` of its
 * own, Google's, has its first event's time and no more); `finish` says how it went once its answer is known.
 */
export function trackAttempt(model: { api?: string }, context: { messages?: readonly any[] } | undefined, options: any, now: () => number) {
	const started = now();
	const phases = new CallPhases(started, now);
	let sent: Record<string, unknown> | undefined;
	const watched = {
		...options,
		onPayload: async (payload: unknown, m: unknown) => {
			sent = { ...requestShape(payload), ...payloadFacts(payload) };
			return options?.onPayload?.(payload, m);
		},
		...(model.api === "google-generative-ai" || model.api === "google-vertex" ? {} : { fetch: phases.fetch(options?.fetch) }),
		onProviderStreamEvent: async (data: unknown, m: unknown) => {
			phases.event();
			return options?.onProviderStreamEvent?.(data, m);
		},
	};
	return {
		options: watched,
		finish(message: { stopReason?: string; errorMessage?: string }): CallDetail {
			const latencyMs = Math.max(0, now() - started);
			const failed = message.stopReason === "error" || message.stopReason === "aborted";
			const phase: ModelPhases = phases.finish();
			return {
				stopReason: message.stopReason ?? "stop",
				latencyMs,
				...(failed && message.errorMessage ? { error: redactSecrets(message.errorMessage).slice(0, ERROR_KEEP) } : {}),
				// A slow call keeps its request and phases too: they are what says where the time went.
				...(failed || latencyMs >= SLOW_CALL_MS ? { request: { phases: phase, ...sent } } : {}),
				...shapeOf(context),
			};
		},
	};
}
