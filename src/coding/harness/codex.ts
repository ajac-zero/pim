import type { AssistantMessage, ImageContent, JsonObject, TextContent, ThinkingContent, ToolCall, ToolResultMessage } from "@earendil-works/pi-ai";
import { HARNESS_HOME } from "../vault/inject";
import type { CliHarness, HarnessEvent, HarnessParser, HarnessTurn, HarnessUsage } from "./types";

/**
 * Codex (`codex`): OpenAI's `codex` CLI, unmodified, run headless with
 * `codex exec --json` (https://developers.openai.com/codex/noninteractive)
 * and read as its JSONL events. It signs in with the person's own ChatGPT
 * plan through its own device-code login, kept in `$CODEX_HOME/auth.json`.
 *
 * The repository is untrusted. `codex exec` loads a project's
 * `.codex/config.toml` (its MCP servers, hooks and exec policies) only for a
 * trusted project, but a run whose sandbox may write the checkout marks the
 * project trusted by itself, saves that to `config.toml`, and loads the
 * project's config in the same run: with `--sandbox danger-full-access`
 * alone, a repository's MCP server was started (checked with 0.167.0). So
 * every turn runs with
 *
 * - `-c projects={"/workspace/repo"={trust_level="untrusted"}}`: the
 *   checkout is untrusted, so its config, hooks and rules stay off and
 *   nothing is written to mark it trusted;
 * - `--ignore-user-config`: `$CODEX_HOME/config.toml` isn't read either (the
 *   login in `auth.json` still is), so nothing saved there, by an earlier
 *   run or a sign-in, adds MCP servers, hooks, a provider or trust;
 * - `--ignore-rules`: no execpolicy `.rules` files, the person's or the
 *   project's.
 *
 * Permissions: the workspace is a gVisor sandbox of the thread's own with an
 * egress allowlist, holding no credential but the CLI's login, and the work
 * is reviewed as a diff before anything is pushed. Codex's own sandbox
 * (`workspace-write`) is bubblewrap in a user namespace, which a container
 * can't make ("No permissions to create a new namespace" in the workspace
 * image), so every command would fail; and it would cut the network the
 * agent installs packages and fetches with. So the container is the
 * sandbox: `--sandbox danger-full-access` and `approval_policy="never"`,
 * since nobody is there to approve. `--dangerously-bypass-approvals-and-
 * sandbox` isn't used: it also skips the check that `-C` is a git checkout.
 */

/** Where the repository is checked out, which Codex works in. */
const REPO = `${HARNESS_HOME}/repo`;

/** The CLI's flags that are the same every turn: JSONL output, and the trust and permission settings above. */
export const CODEX_FLAGS: readonly string[] = [
	"--json",
	"--ignore-user-config",
	"--ignore-rules",
	"--sandbox",
	"danger-full-access",
	"-c",
	'approval_policy="never"',
	"-c",
	`projects={${JSON.stringify(REPO)}={trust_level="untrusted"}}`,
	// No usage analytics, so the workspace needs no host for them.
	"-c",
	"analytics.enabled=false",
	"-C",
	REPO,
];

/** The file `-o` writes the turn's last message to, named by the session so the turn's process can be found by it. */
export const lastMessageFile = (sessionId: string) => `/tmp/pim-codex-${sessionId}.txt`;

export const codex: CliHarness = {
	id: "codex",
	name: "Codex",
	buildCommand(turn: HarnessTurn): string[] {
		return [
			"codex",
			"exec",
			...CODEX_FLAGS,
			// Codex names a new session itself, after it starts; this puts the id Pim gave the turn on its command line, so
			// `signalCommand` finds a first turn's process too.
			"-o",
			lastMessageFile(turn.sessionId),
			...(turn.model ? ["-m", turn.model] : []),
			// A TOML string: JSON's escapes are TOML's, so the text is never read as another type.
			"-c",
			`developer_instructions=${JSON.stringify(turn.instructions)}`,
			...(turn.resume ? ["resume", turn.sessionId] : []),
			// The prompt last, after `--`, so a prompt that starts with a dash is never read as a flag.
			"--",
			turn.prompt,
		];
	},
	parser: (turn) => new CodexJsonParser(turn),
	reportsCost: false,
	shellTool: "shell",
	env: {},
	// ChatGPT's Codex backend (chatgpt.com/backend-api/codex), where a ChatGPT login's turns go; the API, where an API key's
	// go; and OpenAI's sign-in, where the login is made and refreshed (auth.openai.com/oauth/token).
	egress: ["auth.openai.com", "chatgpt.com", "api.openai.com"],
	signalCommand: (sessionId, signal) => ["pkill", `-${signal}`, "-f", sessionId],
	login: {
		mode: "device_code",
		// Codex won't start without its config directory; the workspace is new, so it is made first.
		command: ["sh", "-c", 'mkdir -p "$CODEX_HOME" && exec codex login --device-auth'],
		authorizationUrl(output: string): string | null {
			for (const [url] of plain(output).matchAll(/https:\/\/[^\s"'<>]+/g)) {
				try {
					if (LOGIN_HOSTS.includes(new URL(url).hostname)) return url;
				} catch {}
			}
			return null;
		},
		userCode(output: string): string | null {
			// "2. Enter this one-time code (expires in 15 minutes)", then the code on a line of its own.
			const match = /Enter this one-time code[^\n]*\n\s*([A-Z0-9]+(?:-[A-Z0-9]+)+)\s*\n/i.exec(plain(output));
			return match?.[1] ?? null;
		},
	},
};

/** The host Codex's device-code page is on (https://auth.openai.com/codex/device). */
const LOGIN_HOSTS = ["auth.openai.com"];

const ANSI = /\u001b\[[0-9;?]*[ -/]*[@-~]/g;
const plain = (output: string) => output.replace(ANSI, "");

type Json = Record<string, unknown>;

const isObject = (value: unknown): value is Json => typeof value === "object" && value !== null && !Array.isArray(value);
const num = (value: unknown) => (typeof value === "number" && Number.isFinite(value) ? value : 0);
const str = (value: unknown) => (typeof value === "string" ? value : null);

/**
 * What a failed turn says when the CLI's login is missing, expired or
 * revoked: Codex's refresh errors ("Your access token could not be
 * refreshed… Please log out and sign in again."), and the API's 401 when it
 * has no login at all ("unexpected status 401 Unauthorized: Missing bearer
 * or basic authentication in header").
 */
const LOGIN_FAILURE = /could not be refreshed|sign in again|401 Unauthorized|missing bearer|not logged in|incorrect api key|invalid api key/i;

/** A retry Codex reports as an error event: "Reconnecting... 2/5 (unexpected status 503 …)". */
const RECONNECTING = /^Reconnecting\.\.\.\s*(\d+)\/(\d+)\s*\(([\s\S]*)\)$/;

/**
 * Reads `codex exec --json`, one line at a time: `thread.started` (the
 * session), `turn.started`, `turn.completed` (with the session's tokens so
 * far) or `turn.failed`, `item.started`, `item.updated` and `item.completed`
 * of each thing the agent did, and `error`. The schema is `ThreadEvent` in
 * codex-rs/exec/src/exec_events.rs.
 *
 * Items become the transcript's messages: an agent message is text,
 * reasoning is thinking, and a command, file change, MCP tool call, web
 * search or plan update is a tool call with its result. A non-fatal error
 * item is a notice. Subagents' items (`collab_tool_call`) are skipped. Lines
 * of any other type are skipped; a line that isn't JSON is `unparsed`.
 */
export class CodexJsonParser implements HarnessParser {
	readonly #model: string;
	#threadId: string | null = null;
	#lastText: string | null = null;
	/** Items whose tool call is already in the transcript, waiting for their result. */
	readonly #called = new Set<string>();
	/** How many times each plan was shown, so each showing has its own call id. */
	readonly #plans = new Map<string, number>();

	/** Reads the output of `turn`: the model it asked for, and the session it resumes, which `thread.started` names again. */
	constructor(turn?: Pick<HarnessTurn, "model" | "sessionId" | "resume">) {
		this.#model = turn?.model ?? "codex";
		this.#threadId = turn?.resume ? turn.sessionId : null;
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
			case "thread.started": {
				const sessionId = str(value.thread_id);
				if (!sessionId) return [];
				this.#threadId = sessionId;
				return [{ type: "session", sessionId, model: null }];
			}
			case "turn.completed":
				return [
					{ type: "usage", usage: usageOf(value.usage) },
					{ type: "result", ok: true, reason: null, sessionId: this.#threadId, sessionCostUsd: null, text: this.#lastText, errors: [] },
				];
			case "turn.failed": {
				const message = (isObject(value.error) ? str(value.error.message) : null) ?? "The turn failed";
				const events: HarnessEvent[] = [];
				if (LOGIN_FAILURE.test(message)) events.push({ type: "auth_failed", message });
				events.push({ type: "result", ok: false, reason: "error", sessionId: this.#threadId, sessionCostUsd: null, text: null, errors: [message] });
				return events;
			}
			case "error":
				return this.#error(str(value.message) ?? "");
			case "item.started":
			case "item.updated":
			case "item.completed":
				return isObject(value.item) && typeof value.item.id === "string" ? this.#item(value.type, value.item) : [];
			default:
				return [];
		}
	}

	#error(message: string): HarnessEvent[] {
		const retry = RECONNECTING.exec(message);
		if (!retry) return message ? [{ type: "notice", message }] : [];
		const status = /status (\d{3})\b/.exec(retry[3]!);
		return [{ type: "retry", attempt: Number(retry[1]), maxRetries: Number(retry[2]), delayMs: 0, error: retry[3]!, status: status ? Number(status[1]) : null }];
	}

	#item(phase: "item.started" | "item.updated" | "item.completed", item: Json): HarnessEvent[] {
		const id = item.id as string;
		const done = phase === "item.completed";
		switch (item.type) {
			case "agent_message": {
				const text = str(item.text);
				if (!done || text === null) return [];
				this.#lastText = text;
				return [this.#assistant(id, [{ type: "text", text }])];
			}
			case "reasoning": {
				const thinking = str(item.text);
				return done && thinking ? [this.#assistant(id, [{ type: "thinking", thinking }])] : [];
			}
			case "command_execution": {
				const call = () => ({ name: "shell", arguments: { command: shellScript(str(item.command) ?? "") } });
				if (!done) return phase === "item.started" ? this.#call(id, call()) : [];
				const exitCode = typeof item.exit_code === "number" ? item.exit_code : null;
				const ok = item.status === "completed" && (exitCode ?? 0) === 0;
				const output = str(item.aggregated_output) ?? "";
				return [...this.#callOnce(id, call()), this.#result(id, "shell", [{ type: "text", text: output || (item.status === "declined" ? "Declined" : "") }], !ok, exitCode)];
			}
			case "file_change": {
				if (!done) return [];
				const changes = (Array.isArray(item.changes) ? item.changes : []).filter(isObject).map((change) => ({ path: str(change.path) ?? "", kind: str(change.kind) ?? "update" }));
				const failed = item.status === "failed";
				const said = changes.map((change) => `${change.kind} ${change.path}`).join("\n");
				return [...this.#callOnce(id, { name: "apply_patch", arguments: { changes } }), this.#result(id, "apply_patch", [{ type: "text", text: failed ? `Failed: ${said}` : said }], failed)];
			}
			case "mcp_tool_call": {
				const name = `mcp__${str(item.server) ?? "server"}__${str(item.tool) ?? "tool"}`;
				const call = () => ({ name, arguments: (isObject(item.arguments) ? item.arguments : {}) as JsonObject });
				if (!done) return phase === "item.started" ? this.#call(id, call()) : [];
				const failed = item.status === "failed";
				const error = isObject(item.error) ? str(item.error.message) : null;
				const content = failed || !isObject(item.result) ? [{ type: "text" as const, text: error ?? "" }] : mcpContent(item.result.content);
				return [...this.#callOnce(id, call()), this.#result(id, name, content, failed)];
			}
			case "web_search": {
				const query = str(item.query) ?? "";
				if (!done) return phase === "item.started" ? this.#call(id, { name: "web_search", arguments: { query } }) : [];
				return [...this.#callOnce(id, { name: "web_search", arguments: { query } }), this.#result(id, "web_search", [{ type: "text", text: `Searched the web for: ${query}` }], false)];
			}
			case "todo_list": {
				// Codex shows its plan when it makes it and each time it changes, and completes it at the turn's end.
				if (done && this.#plans.has(id)) return [];
				const shown = this.#plans.get(id) ?? 0;
				this.#plans.set(id, shown + 1);
				const plan = (Array.isArray(item.items) ? item.items : []).filter(isObject).map((step) => ({ text: str(step.text) ?? "", completed: step.completed === true }));
				const callId = `${id}-${shown}`;
				return [...this.#call(callId, { name: "update_plan", arguments: { plan } }), this.#result(callId, "update_plan", [{ type: "text", text: "Plan updated" }], false)];
			}
			case "error": {
				const message = str(item.message);
				return done && message ? [{ type: "notice", message }] : [];
			}
			default:
				return [];
		}
	}

	#assistant(id: string, content: (TextContent | ThinkingContent | ToolCall)[]): HarnessEvent {
		const message: AssistantMessage = {
			role: "assistant",
			content,
			api: "openai-codex-responses",
			provider: "codex",
			model: this.#model,
			// Codex reports tokens only for the whole session, at the turn's end (`usage`).
			usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
			stopReason: content.some((part) => part.type === "toolCall") ? "toolUse" : "stop",
			timestamp: Date.now(),
		};
		return { type: "assistant", message, messageId: id };
	}

	/** The assistant's call of a tool, for an item that just started. */
	#call(id: string, call: { name: string; arguments: JsonObject }): HarnessEvent[] {
		this.#called.add(id);
		return [this.#assistant(id, [{ type: "toolCall", id, ...call }])];
	}

	/** The call, for a completed item whose start wasn't printed. */
	#callOnce(id: string, call: { name: string; arguments: JsonObject }): HarnessEvent[] {
		if (this.#called.delete(id)) return [];
		return [this.#assistant(id, [{ type: "toolCall", id, ...call }])];
	}

	#result(id: string, toolName: string, content: (TextContent | ImageContent)[], isError: boolean, exitCode?: number | null): HarnessEvent {
		const message: ToolResultMessage = { role: "toolResult", toolCallId: id, toolName, content, isError, timestamp: Date.now() };
		return exitCode === undefined ? { type: "tool_result", message } : { type: "tool_result", message, exitCode };
	}
}

/**
 * The session's tokens as Pim counts them: OpenAI's `input_tokens` include
 * the cached ones, which Pim counts apart, as it does for Anthropic's.
 */
function usageOf(value: unknown): HarnessUsage {
	const usage = isObject(value) ? value : {};
	const cacheRead = num(usage.cached_input_tokens);
	return { input: Math.max(0, num(usage.input_tokens) - cacheRead), output: num(usage.output_tokens), cacheRead, cacheWrite: num(usage.cache_write_input_tokens) };
}

/** An MCP tool's result content as pi-ai has it: text and images. */
function mcpContent(content: unknown): (TextContent | ImageContent)[] {
	if (!Array.isArray(content)) return [];
	const parts: (TextContent | ImageContent)[] = [];
	for (const block of content) {
		if (!isObject(block)) continue;
		if (block.type === "text" && typeof block.text === "string") parts.push({ type: "text", text: block.text });
		else if (block.type === "image" && typeof block.data === "string") parts.push({ type: "image", data: block.data, mimeType: str(block.mimeType) ?? "image/png" });
	}
	return parts;
}

/**
 * The script of a command Codex ran through a shell, as the agent wrote it:
 * Codex prints the command line shell-quoted (`/bin/bash -lc 'npm test'`).
 * Any other command line is kept as it is.
 */
export function shellScript(command: string): string {
	const words = shellWords(command);
	if (words && words.length === 3 && /^(?:\/(?:usr\/)?bin\/)?(?:ba|z|da)?sh$/.test(words[0]!) && /^-l?c$/.test(words[1]!)) return words[2]!;
	return command;
}

/** Splits a POSIX-quoted command line into words, or null if it isn't one. */
function shellWords(line: string): string[] | null {
	const words: string[] = [];
	let word: string | null = null;
	for (let i = 0; i < line.length; i++) {
		const char = line[i]!;
		if (char === "'") {
			const end = line.indexOf("'", i + 1);
			if (end < 0) return null;
			word = (word ?? "") + line.slice(i + 1, end);
			i = end;
		} else if (char === '"') {
			let text = "";
			for (i++; i < line.length && line[i] !== '"'; i++) text += line[i] === "\\" && i + 1 < line.length && '"\\$`'.includes(line[i + 1]!) ? line[++i] : line[i];
			if (i >= line.length) return null;
			word = (word ?? "") + text;
		} else if (char === "\\" && i + 1 < line.length) {
			word = (word ?? "") + line[++i];
		} else if (/\s/.test(char)) {
			if (word !== null) words.push(word);
			word = null;
		} else word = (word ?? "") + char;
	}
	if (word !== null) words.push(word);
	return words;
}
