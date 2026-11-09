import type { AssistantMessage, ImageContent, JsonObject, StopReason, TextContent, ThinkingContent, ToolCall, ToolResultMessage } from "@earendil-works/pi-ai";
import type { HarnessEvent, HarnessParser } from "./types";

/**
 * Claude Code's stream-json (https://code.claude.com/docs/en/headless), as
 * Claude Code prints it with `--output-format stream-json`: one JSON message
 * a line, `system`, `stream_event`, `assistant` and `user` messages, and a
 * closing `result`.
 */

/** What tells one CLI's stream-json from another's. */
export type StreamJsonDialect = {
	/** The provider the CLI's messages name in the transcript, such as `claude-code`. */
	readonly provider: string;
	/** The model its messages name until the CLI says which it runs. */
	readonly model: string;
	/** What a failed result says when the CLI isn't signed in, or its login or key was refused. */
	readonly loginFailure: RegExp;
};

type Json = Record<string, unknown>;

const isObject = (value: unknown): value is Json => typeof value === "object" && value !== null && !Array.isArray(value);
const num = (value: unknown) => (typeof value === "number" && Number.isFinite(value) ? value : 0);
const str = (value: unknown) => (typeof value === "string" ? value : null);

/** The errors an assistant message carries when the CLI's login is missing, expired or not allowed. */
const AUTH_ERRORS = ["authentication_failed", "oauth_org_not_allowed"];

/**
 * Reads stream-json, one line at a time: `system` (`init`, `api_retry`,
 * `permission_denied`), `stream_event` (the model's stream as it is
 * written), `assistant` and `user` messages, and the closing `result`.
 * Messages of subagents (`parent_tool_use_id` set) stay out of the thread's
 * transcript: what the subagent found comes back as its tool call's result.
 * Lines of any other type are skipped; a line that isn't JSON is
 * `unparsed`.
 */
export class StreamJsonParser implements HarnessParser {
	readonly #dialect: StreamJsonDialect;
	/** Each tool call's tool, by call id, for its result. */
	readonly #tools = new Map<string, string>();
	#model: string;

	constructor(dialect: StreamJsonDialect) {
		this.#dialect = dialect;
		this.#model = dialect.model;
	}

	parseLine(line: string): HarnessEvent[] {
		const text = line.trim();
		if (!text) return [];
		let value: unknown;
		try {
			value = JSON.parse(text);
		} catch {
			return [{ type: "unparsed", line: text.slice(0, 500) }];
		}
		if (!isObject(value) || typeof value.type !== "string") return [{ type: "unparsed", line: text.slice(0, 500) }];
		switch (value.type) {
			case "system":
				return this.#system(value);
			case "stream_event":
				return value.parent_tool_use_id ? [] : this.#streamEvent(value.event);
			case "assistant":
				return value.parent_tool_use_id ? [] : this.#assistant(value);
			case "user":
				return value.parent_tool_use_id ? [] : this.#user(value);
			case "result":
				return this.#result(value);
			default:
				return [];
		}
	}

	#system(value: Json): HarnessEvent[] {
		switch (value.subtype) {
			case "init": {
				const sessionId = str(value.session_id);
				if (!sessionId) return [];
				const model = str(value.model);
				if (model) this.#model = model;
				return [{ type: "session", sessionId, model }];
			}
			case "api_retry":
				return [
					{
						type: "retry",
						attempt: num(value.attempt),
						maxRetries: num(value.max_retries),
						delayMs: num(value.retry_delay_ms),
						error: str(value.error) ?? "unknown",
						status: typeof value.error_status === "number" ? value.error_status : null,
					},
				];
			case "permission_denied":
				return [{ type: "permission_denied", tool: str(value.tool_name) ?? "tool", message: str(value.message) ?? "" }];
			default:
				return [];
		}
	}

	#streamEvent(event: unknown): HarnessEvent[] {
		if (!isObject(event) || event.type !== "content_block_delta" || !isObject(event.delta)) return [];
		const delta = event.delta;
		if (delta.type === "text_delta" && typeof delta.text === "string") return [{ type: "delta", kind: "text", text: delta.text }];
		if (delta.type === "thinking_delta" && typeof delta.thinking === "string") return [{ type: "delta", kind: "thinking", text: delta.thinking }];
		return [];
	}

	#assistant(value: Json): HarnessEvent[] {
		const message = isObject(value.message) ? value.message : {};
		const blocks = Array.isArray(message.content) ? message.content : [];
		const content: (TextContent | ThinkingContent | ToolCall)[] = [];
		for (const block of blocks) {
			if (!isObject(block)) continue;
			if (block.type === "text" && typeof block.text === "string") content.push({ type: "text", text: block.text });
			else if (block.type === "thinking" && typeof block.thinking === "string") content.push({ type: "thinking", thinking: block.thinking });
			else if (block.type === "tool_use" && typeof block.id === "string" && typeof block.name === "string") {
				this.#tools.set(block.id, block.name);
				content.push({ type: "toolCall", id: block.id, name: block.name, arguments: (isObject(block.input) ? block.input : {}) as JsonObject });
			}
		}
		const model = str(message.model) ?? this.#model;
		const usage = isObject(message.usage) ? message.usage : {};
		const error = str(value.error);
		const input = num(usage.input_tokens);
		const output = num(usage.output_tokens);
		const cacheRead = num(usage.cache_read_input_tokens);
		const cacheWrite = num(usage.cache_creation_input_tokens);
		const assistant: AssistantMessage = {
			role: "assistant",
			content,
			api: "anthropic-messages",
			provider: this.#dialect.provider,
			model,
			usage: { input, output, cacheRead, cacheWrite, totalTokens: input + output + cacheRead + cacheWrite, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
			stopReason: error ? "error" : stopReason(str(message.stop_reason), content),
			timestamp: Date.now(),
			...(error ? { errorMessage: assistantText(content) || error } : {}),
		};
		const events: HarnessEvent[] = [];
		if (content.length > 0 || error) events.push({ type: "assistant", message: assistant, messageId: str(message.id) });
		if (error && AUTH_ERRORS.includes(error)) events.push({ type: "auth_failed", message: assistantText(content) || error });
		return events;
	}

	#user(value: Json): HarnessEvent[] {
		const message = isObject(value.message) ? value.message : {};
		if (!Array.isArray(message.content)) return [];
		const events: HarnessEvent[] = [];
		for (const block of message.content) {
			if (!isObject(block) || block.type !== "tool_result" || typeof block.tool_use_id !== "string") continue;
			const result: ToolResultMessage = {
				role: "toolResult",
				toolCallId: block.tool_use_id,
				toolName: this.#tools.get(block.tool_use_id) ?? "tool",
				content: resultContent(block.content),
				isError: block.is_error === true,
				timestamp: Date.now(),
			};
			events.push({ type: "tool_result", message: result });
		}
		return events;
	}

	#result(value: Json): HarnessEvent[] {
		const subtype = str(value.subtype);
		const ok = subtype === "success" && value.is_error !== true;
		const reason = ok ? null : subtype === "error_max_budget_usd" ? "budget" : subtype === "error_max_turns" ? "max_turns" : "error";
		const text = str(value.result);
		const errors = Array.isArray(value.errors) ? value.errors.filter((error): error is string => typeof error === "string") : [];
		const events: HarnessEvent[] = [];
		if (!ok && [text ?? "", ...errors].some((said) => this.#dialect.loginFailure.test(said))) events.push({ type: "auth_failed", message: text ?? errors[0] ?? "" });
		events.push({ type: "result", ok, reason, sessionId: str(value.session_id), sessionCostUsd: num(value.total_cost_usd), text, errors });
		return events;
	}
}

function stopReason(given: string | null, content: readonly { type: string }[]): StopReason {
	switch (given) {
		case "tool_use":
			return "toolUse";
		case "max_tokens":
			return "length";
		case "end_turn":
		case "stop_sequence":
			return "stop";
		default:
			return content.some((part) => part.type === "toolCall") ? "toolUse" : "stop";
	}
}

const assistantText = (content: readonly (TextContent | ThinkingContent | ToolCall)[]) =>
	content
		.flatMap((part) => (part.type === "text" ? [part.text] : []))
		.join("\n")
		.trim();

/** A tool result's content as pi-ai has it: text and images. */
function resultContent(content: unknown): (TextContent | ImageContent)[] {
	if (typeof content === "string") return [{ type: "text", text: content }];
	if (!Array.isArray(content)) return [];
	const parts: (TextContent | ImageContent)[] = [];
	for (const block of content) {
		if (!isObject(block)) continue;
		if (block.type === "text" && typeof block.text === "string") parts.push({ type: "text", text: block.text });
		else if (block.type === "image" && isObject(block.source) && typeof block.source.data === "string") {
			parts.push({ type: "image", data: block.source.data, mimeType: str(block.source.media_type) ?? "image/png" });
		}
	}
	return parts;
}
