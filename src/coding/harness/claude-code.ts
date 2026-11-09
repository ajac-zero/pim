import type { AssistantMessage, ImageContent, JsonObject, StopReason, TextContent, ThinkingContent, ToolCall, ToolResultMessage } from "@earendil-works/pi-ai";
import type { CliHarness, HarnessEvent, HarnessParser, HarnessTurn } from "./types";

/**
 * Claude Code (`claude-code`): Anthropic's `claude` CLI, unmodified, run
 * headless with `-p` and read as stream-json
 * (https://code.claude.com/docs/en/headless). It signs in with the person's
 * own subscription through its own login, so it runs without `--bare`,
 * which never reads that login.
 *
 * The repository is untrusted: a `-p` run uses the hooks of a project's
 * `.claude/settings.json` and connects the servers of its `.mcp.json`
 * without asking (https://code.claude.com/docs/en/permissions, "What runs
 * before you trust a folder"). So every turn runs with
 *
 * - `--setting-sources user`: neither the project's settings files (their
 *   hooks, `env`, permission rules and plugins) nor its `.mcp.json`, nor its
 *   skills, commands and subagents, only the person's own settings;
 * - `--settings '{"disableAllHooks":true}'`: no hooks at all, the person's
 *   own included, since nobody watches them run;
 * - `--strict-mcp-config` with no `--mcp-config`, and `--disallowedTools
 *   mcp__*`: no MCP server and no MCP tool.
 *
 * Permissions: the workspace is a gVisor sandbox of the thread's own, with
 * an egress allowlist and no credentials but the CLI's login, and the work
 * is reviewed as a diff before anything is pushed. So the agent may edit
 * files (`--permission-mode acceptEdits`) and run any shell command
 * (`--allowedTools Bash`) without asking; anything else that would ask,
 * such as fetching a web page, is denied, and the CLI tells the model not
 * to retry it (`--permission-prompts none`), since nobody is there to
 * answer. `bypassPermissions` isn't used: it would also skip the CLI's own
 * checks that no mode skips.
 */

/** The CLI's flags that are the same every turn: stream-json output and the trust settings above. */
export const CLAUDE_CODE_FLAGS: readonly string[] = [
	"--output-format",
	"stream-json",
	"--verbose",
	"--include-partial-messages",
	"--permission-mode",
	"acceptEdits",
	"--allowedTools",
	"Bash",
	"--disallowedTools",
	"mcp__*",
	"--permission-prompts",
	"none",
	"--setting-sources",
	"user",
	"--settings",
	JSON.stringify({ disableAllHooks: true }),
	"--strict-mcp-config",
];

export const claudeCode: CliHarness = {
	id: "claude-code",
	name: "Claude Code",
	buildCommand(turn: HarnessTurn): string[] {
		return [
			"claude",
			"-p",
			...CLAUDE_CODE_FLAGS,
			...(turn.resume ? ["--resume", turn.sessionId] : ["--session-id", turn.sessionId]),
			"--max-budget-usd",
			(Math.floor(Math.max(0, turn.maxBudgetUsd) * 100) / 100).toFixed(2),
			...(turn.model ? ["--model", turn.model] : []),
			"--append-system-prompt",
			turn.instructions,
			// The prompt last, after `--`, so a prompt that starts with a dash is never read as a flag.
			"--",
			turn.prompt,
		];
	},
	parser: () => new ClaudeStreamParser(),
	shellTool: "Bash",
	// Only what the CLI needs to talk to the model and sign in: no telemetry, error reports, surveys or self-updates.
	env: {
		CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1",
		DISABLE_TELEMETRY: "1",
		DISABLE_ERROR_REPORTING: "1",
		DISABLE_AUTOUPDATER: "1",
	},
	// The API, and the hosts a claude.ai login is made and refreshed at (https://code.claude.com/docs/en/network-config).
	egress: ["api.anthropic.com", "claude.ai", "platform.claude.com"],
	signalCommand: (sessionId, signal) => ["pkill", `-${signal}`, "-f", sessionId],
	login: {
		mode: "paste_code",
		// Since v2.1.126 it prints the URL and reads the code the browser shows from standard input when the browser can't reach it.
		command: ["claude", "auth", "login"],
		authorizationUrl(output: string): string | null {
			const text = output.replace(ANSI, "");
			for (const [url] of text.matchAll(/https:\/\/[^\s"'<>]+/g)) {
				try {
					if (LOGIN_HOSTS.includes(new URL(url).hostname)) return url;
				} catch {}
			}
			return null;
		},
	},
};

/** The hosts Claude Code's sign-in page is on. */
const LOGIN_HOSTS = ["claude.ai", "claude.com", "platform.claude.com", "console.anthropic.com"];

const ANSI = /\u001b\[[0-9;?]*[ -/]*[@-~]/g;

type Json = Record<string, unknown>;

const isObject = (value: unknown): value is Json => typeof value === "object" && value !== null && !Array.isArray(value);
const num = (value: unknown) => (typeof value === "number" && Number.isFinite(value) ? value : 0);
const str = (value: unknown) => (typeof value === "string" ? value : null);

/** The errors an assistant message carries when the CLI's login is missing, expired or not allowed. */
const AUTH_ERRORS = ["authentication_failed", "oauth_org_not_allowed"];

/** A failed run's result that says the CLI isn't signed in, as it prints it ("Invalid API key · Please run /login", "Not logged in"). */
const LOGIN_RESULT = /please run \/login|not logged in|invalid api key|oauth token has expired/i;

/**
 * Reads Claude Code's stream-json, one line at a time: `system` (`init`,
 * `api_retry`, `permission_denied`), `stream_event` (the model's stream as
 * it is written), `assistant` and `user` messages, and the closing
 * `result`. Messages of subagents (`parent_tool_use_id` set) stay out of the
 * thread's transcript: what the subagent found comes back as its tool call's
 * result. Lines of any other type are skipped; a line that isn't JSON is
 * `unparsed`.
 */
export class ClaudeStreamParser implements HarnessParser {
	/** Each tool call's tool, by call id, for its result. */
	readonly #tools = new Map<string, string>();
	#model = "claude";

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
			provider: "claude-code",
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
		if (!ok && [text ?? "", ...errors].some((said) => LOGIN_RESULT.test(said))) events.push({ type: "auth_failed", message: text ?? errors[0] ?? "" });
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
