import { describe, expect, it, vi } from "vitest";
import { CLAUDE_CODE_FLAGS, ClaudeStreamParser, claudeCode } from "../src/coding/harness/claude-code";
import { CODEX_FLAGS, CodexJsonParser, codex, shellScript } from "../src/coding/harness/codex";
import { type HarnessAuth, HarnessRunner, LineBuffer, type RunRecord, recoverRun, type RunnerDeps } from "../src/coding/harness/runner";
import type { HarnessEvent, HarnessTurn } from "../src/coding/harness/types";
import type { TestRun } from "../src/coding/tools";
import type { Restored } from "../src/coding/vault/inject";
import type { ExecEvent, ExecOptions, Workspace } from "../src/coding/workspace/types";
import { CLAUDE_SESSION, claudeFixture, claudeLines } from "./fixtures/claude-code";
import { CODEX_SESSION, codexFixture, codexLines } from "./fixtures/codex";

// The CLI harness framework (src/coding/harness/) on its own: Claude Code's command line and stream-json parser against
// stream-json written from its documented schema (test/fixtures/claude-code/), and the runner against a workspace whose
// `claude` is a script. How a coding thread uses them is in test/coding-thread-do.test.ts.

const fixture = claudeFixture;
const SESSION = CLAUDE_SESSION;

const parse = (text: string) => {
	const parser = new ClaudeStreamParser();
	return text.split("\n").flatMap((line) => parser.parseLine(line));
};

const TURN: HarnessTurn = { prompt: "Fix the greeting test", sessionId: SESSION, resume: false, maxBudgetUsd: 2.999, model: null, instructions: "Don't push." };

describe("Claude Code's stream-json", () => {
	it("is read into the session, the text as it is written, messages with their tools, retries, refusals and the result", () => {
		const events = parse(fixture("turn"));
		expect(events.filter((event) => event.type === "unparsed")).toEqual([]);
		expect(events[0]).toEqual({ type: "session", sessionId: SESSION, model: "claude-sonnet-5" });
		// The model's stream as it is written: thinking and text, not the signature or the tool's input.
		expect(events.filter((event) => event.type === "delta")).toEqual([
			{ type: "delta", kind: "thinking", text: "The greeting test fails; " },
			{ type: "delta", kind: "thinking", text: "run it first." },
			{ type: "delta", kind: "text", text: "I'll run the " },
			{ type: "delta", kind: "text", text: "tests first." },
		]);
		const messages = events.flatMap((event) => (event.type === "assistant" || event.type === "tool_result" ? [event.message] : []));
		expect(messages.map((message) => (message.role === "assistant" ? message.content.map((part) => part.type) : [`result:${message.toolName}`]))).toEqual([
			["thinking"],
			["text"],
			["toolCall"],
			["result:Bash"],
			["toolCall"],
			["result:Edit"],
			["toolCall"],
			// The subagent's own call and result aren't the thread's; what it found comes back as the Task call's result.
			["result:Task"],
			["text"],
		]);
		const assistants = events.filter((event): event is Extract<HarnessEvent, { type: "assistant" }> => event.type === "assistant");
		expect(assistants[2]!.message.content[0]).toEqual({ type: "toolCall", id: "toolu_01Bash", name: "Bash", arguments: { command: "npm test", description: "Run the tests" } });
		expect(assistants[2]!.message).toMatchObject({ provider: "claude-code", model: "claude-sonnet-5", stopReason: "toolUse", usage: { input: 2114, output: 184, cacheRead: 13008, cacheWrite: 5120 } });
		expect(assistants.map((event) => event.messageId)).toEqual(["msg_01A", "msg_01A", "msg_01A", "msg_01B", "msg_01C", "msg_01D"]);
		expect(assistants.at(-1)!.message.stopReason).toBe("stop");
		const bash = messages[3]!;
		expect(bash).toMatchObject({ role: "toolResult", toolCallId: "toolu_01Bash", toolName: "Bash", isError: true });
		expect(bash.role === "toolResult" && bash.content[0]).toMatchObject({ type: "text", text: expect.stringContaining("Tests  1 failed | 3 passed (4)") });
		expect(events.find((event) => event.type === "retry")).toEqual({ type: "retry", attempt: 1, maxRetries: 10, delayMs: 1200, error: "overloaded", status: 529 });
		expect(events.find((event) => event.type === "permission_denied")).toMatchObject({ type: "permission_denied", tool: "WebFetch" });
		expect(events.at(-1)).toEqual({
			type: "result",
			ok: true,
			reason: null,
			sessionId: SESSION,
			sessionCostUsd: 0.0841,
			text: "Fixed `greet` to include the name; the greeting test passes now.",
			errors: [],
		});
		expect(events.some((event) => event.type === "auth_failed")).toBe(false);
	});

	it("says when the run stopped at its budget, and when the CLI isn't signed in, though its result says success", () => {
		expect(parse(fixture("budget")).at(-1)).toMatchObject({ type: "result", ok: false, reason: "budget", sessionCostUsd: 1.2034, errors: ["Reached maximum budget ($1.20)"] });
		const login = parse(fixture("login"));
		expect(login.filter((event) => event.type === "auth_failed")).toHaveLength(2);
		expect(login.find((event) => event.type === "assistant")).toMatchObject({ message: { stopReason: "error", errorMessage: "Not logged in · Please run /login" } });
		expect(login.at(-1)).toMatchObject({ type: "result", ok: false, reason: "error" });
	});

	it("keeps a line that isn't JSON, or isn't a message, as unparsed and goes on; types it doesn't know are skipped", () => {
		const parser = new ClaudeStreamParser();
		expect(parser.parseLine("")).toEqual([]);
		expect(parser.parseLine("Waiting for background work to finish")).toEqual([{ type: "unparsed", line: "Waiting for background work to finish" }]);
		expect(parser.parseLine('{"type":"assistant","message":{"content":[{"type":"text","text":"cut')).toMatchObject([{ type: "unparsed" }]);
		expect(parser.parseLine("[1,2]")).toMatchObject([{ type: "unparsed" }]);
		expect(parser.parseLine('{"type":"rate_limit_event","session_id":"s"}')).toEqual([]);
		expect(parser.parseLine('{"type":"system","subtype":"hook_started","session_id":"s"}')).toEqual([]);
		// A tool result whose call it never saw still says what it was.
		expect(parser.parseLine('{"type":"user","message":{"role":"user","content":[{"type":"tool_result","tool_use_id":"x","content":"ok"}]},"parent_tool_use_id":null}')).toMatchObject([
			{ type: "tool_result", message: { toolName: "tool", content: [{ type: "text", text: "ok" }], isError: false } },
		]);
		expect(parser.parseLine('{"type":"system","subtype":"init","session_id":"s2","model":"claude-opus-5"}')).toEqual([{ type: "session", sessionId: "s2", model: "claude-opus-5" }]);
	});

	it("is read the same however its output is split into chunks, a last line without a newline included", () => {
		const text = fixture("turn").trimEnd();
		const whole = parse(text);
		for (const size of [1, 7, 64, 4096]) {
			const parser = new ClaudeStreamParser();
			const buffer = new LineBuffer();
			const events: HarnessEvent[] = [];
			for (let at = 0; at < text.length; at += size) for (const line of buffer.push(text.slice(at, at + size))) events.push(...parser.parseLine(line));
			for (const line of buffer.flush()) events.push(...parser.parseLine(line));
			expect(events.map((event) => event.type)).toEqual(whole.map((event) => event.type));
			expect(events.at(-1)).toEqual(whole.at(-1));
		}
	});
});

describe("Claude Code's command line", () => {
	it("runs -p headless with stream-json, a new session, the budget left and the trust settings, the prompt last", () => {
		const command = claudeCode.buildCommand(TURN);
		expect(command.slice(0, 2)).toEqual(["claude", "-p"]);
		expect(command).not.toContain("--bare");
		const flag = (name: string) => command[command.indexOf(name) + 1];
		expect(flag("--output-format")).toBe("stream-json");
		expect(command).toContain("--verbose");
		expect(command).toContain("--include-partial-messages");
		expect(flag("--session-id")).toBe(SESSION);
		expect(command).not.toContain("--resume");
		// The budget left, rounded down, so the CLI never stops later than the thread would.
		expect(flag("--max-budget-usd")).toBe("2.99");
		expect(flag("--permission-mode")).toBe("acceptEdits");
		expect(flag("--allowedTools")).toBe("Bash");
		expect(flag("--permission-prompts")).toBe("none");
		expect(flag("--setting-sources")).toBe("user");
		expect(JSON.parse(flag("--settings")!)).toEqual({ disableAllHooks: true });
		expect(command).toContain("--strict-mcp-config");
		expect(flag("--disallowedTools")).toBe("mcp__*");
		expect(command).not.toContain("--mcp-config");
		expect(command).not.toContain("--model");
		expect(flag("--append-system-prompt")).toBe("Don't push.");
		expect(command.slice(-2)).toEqual(["--", "Fix the greeting test"]);
		expect(command.slice(2, 2 + CLAUDE_CODE_FLAGS.length)).toEqual(CLAUDE_CODE_FLAGS);
	});

	it("resumes the session after the first turn, asks for a model when given one, and keeps a prompt that looks like a flag a prompt", () => {
		const command = claudeCode.buildCommand({ ...TURN, resume: true, model: "opus", prompt: "--help me", maxBudgetUsd: -1 });
		expect(command[command.indexOf("--resume") + 1]).toBe(SESSION);
		expect(command).not.toContain("--session-id");
		expect(command[command.indexOf("--model") + 1]).toBe("opus");
		expect(command[command.indexOf("--max-budget-usd") + 1]).toBe("0.00");
		expect(command.slice(-2)).toEqual(["--", "--help me"]);
	});

	it("signals the turn's process by its session, and finds the sign-in URL in what `claude auth login` prints", () => {
		expect(claudeCode.signalCommand(SESSION, "INT")).toEqual(["pkill", "-INT", "-f", SESSION]);
		expect(claudeCode.login!.command).toEqual(["claude", "auth", "login"]);
		const url = "https://claude.ai/oauth/authorize?code=true&client_id=9d1c250a&response_type=code&redirect_uri=https%3A%2F%2Fplatform.claude.com%2Foauth%2Fcode%2Fcallback&scope=user%3Ainference&state=abc";
		expect(claudeCode.login!.authorizationUrl("Opening browser to sign in…\n")).toBeNull();
		expect(claudeCode.login!.authorizationUrl(`\u001b[1mBrowser didn't open? Use the url below to sign in:\u001b[22m\n\n${url}\n\nPaste code here if prompted > `)).toBe(url);
		expect(claudeCode.login!.authorizationUrl("See https://evil.example/oauth for help")).toBeNull();
		// What Claude Code 2.1.311 printed with its stdin a pipe, as in Pim's sign-in.
		const printed = "https://claude.com/cai/oauth/authorize?code=true&client_id=9d1c250a-e61b-44d9-88ed-5944d1962f5e&response_type=code&redirect_uri=https%3A%2F%2Fplatform.claude.com%2Foauth%2Fcode%2Fcallback&scope=org%3Acreate_api_key+user%3Aprofile+user%3Ainference&code_challenge=oqqhCAcs&code_challenge_method=S256&state=tziRlIhp";
		expect(claudeCode.login!.authorizationUrl(`Opening browser to sign in…\nIf the browser didn't open, visit: ${printed}\nPaste code here if prompted > `)).toBe(printed);
		expect(claudeCode.env).toMatchObject({ CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1", DISABLE_TELEMETRY: "1", DISABLE_ERROR_REPORTING: "1" });
		expect(claudeCode.egress).toEqual(["api.anthropic.com", "claude.ai", "platform.claude.com"]);
	});
});

describe("Codex's JSONL", () => {
	const read = (text: string, parser = new CodexJsonParser()) => text.split("\n").flatMap((line) => parser.parseLine(line));
	type Of<T extends HarnessEvent["type"]> = Extract<HarnessEvent, { type: T }>;
	const messagesOf = (events: HarnessEvent[]) =>
		events.flatMap((event) => (event.type === "assistant" ? [event.message.content.map((part) => (part.type === "toolCall" ? `call:${part.name}` : part.type)).join(",")] : event.type === "tool_result" ? [`result:${event.message.toolName}`] : []));

	it("is read into the session, notices, retries, the transcript's messages with their tools, the session's tokens and the result", () => {
		const events = read(codexFixture("turn"));
		expect(events.filter((event) => event.type === "unparsed")).toEqual([]);
		expect(events[0]).toEqual({ type: "session", sessionId: CODEX_SESSION, model: null });
		expect(events.filter((event) => event.type === "notice")).toEqual([{ type: "notice", message: expect.stringContaining("Falling back from WebSockets") }]);
		expect(events.find((event) => event.type === "retry")).toEqual({ type: "retry", attempt: 1, maxRetries: 5, delayMs: 0, error: expect.stringContaining("upstream connect error"), status: 503 });
		expect(messagesOf(events)).toEqual([
			"thinking",
			"call:update_plan",
			"result:update_plan",
			"call:shell",
			"result:shell",
			"call:update_plan",
			"result:update_plan",
			"call:apply_patch",
			"result:apply_patch",
			"call:mcp__docs__search",
			"result:mcp__docs__search",
			"call:web_search",
			"result:web_search",
			// A command whose start wasn't printed still gets its call, once.
			"call:shell",
			"result:shell",
			"call:update_plan",
			"result:update_plan",
			// The plan's completion at the turn's end repeats what was shown, so it isn't shown again.
			"text",
		]);
		const assistants = events.filter((event): event is Of<"assistant"> => event.type === "assistant");
		const results = events.filter((event): event is Of<"tool_result"> => event.type === "tool_result");
		// The shell's command as the agent wrote it, not as Codex quoted it for `bash -lc`.
		const calls = assistants.flatMap((event) => event.message.content.filter((part) => part.type === "toolCall"));
		expect(calls.filter((call) => call.name === "shell").map((call) => call.arguments)).toEqual([{ command: "npm test" }, { command: "npx vitest run test/greet.test.ts && echo 'all good'" }]);
		expect(calls.find((call) => call.name === "apply_patch")!.arguments).toEqual({ changes: [{ path: "/workspace/repo/greet.ts", kind: "update" }] });
		expect(calls.filter((call) => call.name === "update_plan").map((call) => call.id)).toEqual(["item_2-0", "item_2-1", "item_2-2"]);
		expect(calls.at(-1)!.arguments).toEqual({ plan: [{ text: "Run the tests", completed: true }, { text: "Fix greet", completed: true }] });
		// Each result answers its call, and a shell's carries the command's own exit code.
		const shell = results.filter((event) => event.message.toolName === "shell");
		expect(shell.map((event) => [event.message.toolCallId, event.message.isError, event.exitCode])).toEqual([
			["item_3", true, 1],
			["item_7", false, 0],
		]);
		expect(shell[0]!.message.content[0]).toMatchObject({ type: "text", text: expect.stringContaining("Tests  1 failed | 3 passed (4)") });
		expect(results.find((event) => event.message.toolName === "mcp__docs__search")!.message.content).toEqual([{ type: "text", text: "test.each(table)(name, fn)" }]);
		expect(assistants.at(-1)!.message).toMatchObject({ provider: "codex", model: "codex", stopReason: "stop", content: [{ type: "text", text: "Fixed `greet` to include the name; the greeting test passes now." }] });
		expect(assistants.find((event) => event.message.content.some((part) => part.type === "toolCall"))!.message.stopReason).toBe("toolUse");
		// OpenAI's input tokens include the cached ones, which are counted apart.
		expect(events.at(-2)).toEqual({ type: "usage", usage: { input: 24310 - 19200, output: 1180, cacheRead: 19200, cacheWrite: 0 } });
		expect(events.at(-1)).toEqual({ type: "result", ok: true, reason: null, sessionId: CODEX_SESSION, sessionCostUsd: null, text: "Fixed `greet` to include the name; the greeting test passes now.", errors: [] });
		expect(events.some((event) => event.type === "auth_failed")).toBe(false);
	});

	it("says when the CLI isn't signed in or its login expired, as real Codex 0.167.0 printed it, and otherwise why the turn failed", () => {
		const login = read(codexFixture("login"));
		expect(login.filter((event) => event.type === "unparsed")).toEqual([]);
		// Codex's retries mention the 401 too, but only the turn's failure says the login is missing.
		expect(login.filter((event) => event.type === "retry")).toHaveLength(9);
		expect(login.filter((event) => event.type === "auth_failed")).toHaveLength(1);
		expect(login.at(-2)!.type).toBe("auth_failed");
		expect(login.at(-1)).toMatchObject({ type: "result", ok: false, reason: "error", sessionId: "01a1c152-02a4-78b1-96e1-ff9573c99a94", sessionCostUsd: null });
		const expired = read(codexFixture("expired"));
		expect(expired.map((event) => event.type)).toEqual(["session", "notice", "auth_failed", "result"]);
		expect(expired[2]).toEqual({ type: "auth_failed", message: "Your access token could not be refreshed. Please log out and sign in again." });
		const failed = read(codexFixture("failed"));
		expect(failed.some((event) => event.type === "auth_failed")).toBe(false);
		expect(failed.at(-1)).toMatchObject({ type: "result", ok: false, reason: "error", errors: [expect.stringContaining("exceeds the context window")] });
	});

	it("keeps a line that isn't JSON, or isn't an event, as unparsed and goes on; what it doesn't know is skipped", () => {
		const parser = new CodexJsonParser();
		expect(parser.parseLine("")).toEqual([]);
		expect(parser.parseLine("Reading additional input from stdin...")).toEqual([{ type: "unparsed", line: "Reading additional input from stdin..." }]);
		expect(parser.parseLine('{"type":"item.completed","item":{"id":"item_1","type":"agent_message","text":"cut')).toMatchObject([{ type: "unparsed" }]);
		expect(parser.parseLine("[1,2]")).toMatchObject([{ type: "unparsed" }]);
		expect(parser.parseLine('{"no":"type"}')).toMatchObject([{ type: "unparsed" }]);
		expect(parser.parseLine('{"type":"turn.started"}')).toEqual([]);
		expect(parser.parseLine('{"type":"thread.archived","thread_id":"x"}')).toEqual([]);
		expect(parser.parseLine('{"type":"item.completed"}')).toEqual([]);
		expect(parser.parseLine('{"type":"item.completed","item":{"id":"item_9","type":"collab_tool_call","tool":"spawn_agent","status":"completed"}}')).toEqual([]);
		// A reasoning item with nothing in it, and an agent message still being written, are nothing yet.
		expect(parser.parseLine('{"type":"item.completed","item":{"id":"item_9","type":"reasoning","text":""}}')).toEqual([]);
		expect(parser.parseLine('{"type":"item.started","item":{"id":"item_9","type":"agent_message","text":"Hel"}}')).toEqual([]);
		// A failed MCP call's result is its error; a declined command says so.
		parser.parseLine('{"type":"item.started","item":{"id":"m","type":"mcp_tool_call","server":"s","tool":"t","arguments":{},"status":"in_progress"}}');
		expect(parser.parseLine('{"type":"item.completed","item":{"id":"m","type":"mcp_tool_call","server":"s","tool":"t","arguments":{},"result":null,"error":{"message":"server gone"},"status":"failed"}}')).toMatchObject([
			{ type: "tool_result", message: { toolCallId: "m", isError: true, content: [{ type: "text", text: "server gone" }] } },
		]);
		expect(parser.parseLine('{"type":"item.completed","item":{"id":"c","type":"command_execution","command":"rm -rf /","aggregated_output":"","exit_code":null,"status":"declined"}}')).toMatchObject([
			{ type: "assistant" },
			{ type: "tool_result", message: { isError: true, content: [{ type: "text", text: "Declined" }] }, exitCode: null },
		]);
		// A turn that ended without naming its session is of the session it resumed.
		const resumed = new CodexJsonParser({ model: "gpt-5.5-codex", sessionId: CODEX_SESSION, resume: true });
		expect(resumed.parseLine('{"type":"turn.completed","usage":{"input_tokens":10,"cached_input_tokens":0,"output_tokens":2,"reasoning_output_tokens":0}}').at(-1)).toMatchObject({ sessionId: CODEX_SESSION });
		expect(resumed.parseLine('{"type":"item.completed","item":{"id":"a","type":"agent_message","text":"ok"}}')).toMatchObject([{ message: { model: "gpt-5.5-codex" } }]);
	});

	it("is read the same however its output is split into chunks, a last line without a newline included", () => {
		const text = codexFixture("turn").trimEnd();
		const whole = read(text);
		for (const size of [1, 7, 64, 4096]) {
			const parser = new CodexJsonParser();
			const buffer = new LineBuffer();
			const events: HarnessEvent[] = [];
			for (let at = 0; at < text.length; at += size) for (const line of buffer.push(text.slice(at, at + size))) events.push(...parser.parseLine(line));
			for (const line of buffer.flush()) events.push(...parser.parseLine(line));
			expect(events.map((event) => event.type)).toEqual(whole.map((event) => event.type));
			expect(events.at(-1)).toEqual(whole.at(-1));
		}
	});

	it("unwraps a shell's script from the command line Codex prints, keeping any other as it is", () => {
		expect(shellScript("/bin/bash -lc 'npm test'")).toBe("npm test");
		expect(shellScript(`bash -lc 'echo '"'"'hi'"'"' && ls'`)).toBe("echo 'hi' && ls");
		expect(shellScript('/usr/bin/zsh -c "go test ./... | tee \\"out\\""')).toBe('go test ./... | tee "out"');
		expect(shellScript("git status")).toBe("git status");
		expect(shellScript("bash -lc 'unterminated")).toBe("bash -lc 'unterminated");
		expect(shellScript("python -c 'print(1)'")).toBe("python -c 'print(1)'");
	});
});

describe("Codex's command line", () => {
	const CODEX_TURN: HarnessTurn = { ...TURN, sessionId: "5d3c7a9e-1b2f-4c6d-8e0a-9f1b2c3d4e5f" };

	it("runs `codex exec --json` in the checkout, untrusted, without the person's config, rules or Codex's own sandbox, the prompt last", () => {
		const command = codex.buildCommand(CODEX_TURN);
		expect(command).toEqual([
			"codex",
			"exec",
			"--json",
			"--ignore-user-config",
			"--ignore-rules",
			"--sandbox",
			"danger-full-access",
			"-c",
			'approval_policy="never"',
			"-c",
			'projects={"/workspace/repo"={trust_level="untrusted"}}',
			"-c",
			"analytics.enabled=false",
			"-C",
			"/workspace/repo",
			// The id Pim gave the turn is on its command line, for `pkill -f`, before Codex names its session.
			"-o",
			`/tmp/pim-codex-${CODEX_TURN.sessionId}.txt`,
			"-c",
			'developer_instructions="Don\'t push."',
			"--",
			"Fix the greeting test",
		]);
		expect(command.slice(2, 2 + CODEX_FLAGS.length)).toEqual(CODEX_FLAGS);
		expect(command).not.toContain("resume");
		expect(command).not.toContain("--skip-git-repo-check");
		expect(command).not.toContain("--dangerously-bypass-approvals-and-sandbox");
	});

	it("resumes Codex's session after the first turn, asks for a model when given one, and quotes instructions as a TOML string", () => {
		const instructions = 'Say "done".\nThen stop. \\o/ true';
		const command = codex.buildCommand({ ...TURN, sessionId: CODEX_SESSION, resume: true, model: "gpt-5.5-codex", prompt: "--help me", instructions });
		expect(command.slice(-4)).toEqual(["resume", CODEX_SESSION, "--", "--help me"]);
		expect(command[command.indexOf("-m") + 1]).toBe("gpt-5.5-codex");
		expect(command).toContain(`/tmp/pim-codex-${CODEX_SESSION}.txt`);
		const setting = command.find((arg) => arg.startsWith("developer_instructions="))!;
		// A TOML basic string reads back as the text: JSON's escapes are TOML's.
		expect(JSON.parse(setting.slice("developer_instructions=".length))).toBe(instructions);
	});

	it("signals the turn's process by its session, and finds the device-code page and code in what `codex login --device-auth` prints", () => {
		expect(codex.signalCommand(CODEX_SESSION, "INT")).toEqual(["pkill", "-INT", "-f", CODEX_SESSION]);
		expect(codex.login!.mode).toBe("device_code");
		expect(codex.login!.command).toEqual(["sh", "-c", 'mkdir -p "$CODEX_HOME" && exec codex login --device-auth']);
		// What Codex 0.167.0 printed, with its code replaced.
		const printed =
			"\nWelcome to Codex [v\u001b[90m0.167.0\u001b[0m]\n\u001b[90mOpenAI's command-line coding agent\u001b[0m\n\nFollow these steps to sign in with ChatGPT using device code authorization:\n\n1. Open this link in your browser and sign in to your account\n   \u001b[94mhttps://auth.openai.com/codex/device\u001b[0m\n\n2. Enter this one-time code \u001b[90m(expires in 15 minutes)\u001b[0m\n   \u001b[94mK7QM-4XT9P\u001b[0m\n\n\u001b[90mContinue only if you started this login in Codex. If a website or another person gave you this code, cancel.\u001b[0m\n";
		const halfway = printed.slice(0, printed.indexOf("2. Enter"));
		expect(codex.login!.authorizationUrl(halfway)).toBe("https://auth.openai.com/codex/device");
		expect(codex.login!.userCode!(halfway)).toBeNull();
		expect(codex.login!.userCode!(printed.slice(0, printed.indexOf("K7QM") + 6))).toBeNull();
		expect(codex.login!.userCode!(printed)).toBe("K7QM-4XT9P");
		expect(codex.login!.authorizationUrl("Open https://evil.example/codex/device")).toBeNull();
		expect(codex.env).toEqual({});
		expect(codex.egress).toEqual(["auth.openai.com", "chatgpt.com", "api.openai.com"]);
	});
});

/* The runner, with a scripted workspace. */

type Script = (options: ExecOptions, signals: Signals) => AsyncGenerator<ExecEvent>;

/** The signals `pkill` sent, and a way for a script to wait for one. */
class Signals {
	readonly sent: string[] = [];
	readonly #waiting: { name: string; resolve: () => void }[] = [];

	send(name: string) {
		this.sent.push(name);
		for (const waiter of this.#waiting.filter((each) => each.name === name)) waiter.resolve();
	}

	/** Resolves when `name` is sent, or the command is killed. */
	wait(name: string, abort?: AbortSignal): Promise<"signal" | "killed"> {
		return new Promise((resolve) => {
			if (this.sent.includes(name)) return resolve("signal");
			this.#waiting.push({ name, resolve: () => resolve("signal") });
			abort?.addEventListener("abort", () => resolve("killed"));
		});
	}
}

/** A workspace whose `claude` and `codex` run `script`, and whose `pkill` sends what it is given. Everything it runs is recorded. */
function scripted(script: Script) {
	const signals = new Signals();
	const commands: { cmd: string[]; options: ExecOptions }[] = [];
	const log: string[] = [];
	const workspace = {
		async *exec(cmd: string[], options: ExecOptions): AsyncGenerator<ExecEvent> {
			commands.push({ cmd, options });
			if (cmd[0] === "pkill") {
				log.push(`signal ${cmd[1]}`);
				signals.send(cmd[1]!.slice(1));
				yield { type: "exit", code: 0 };
				return;
			}
			if (cmd[0] !== "claude" && cmd[0] !== "codex") throw new Error(`no ${cmd[0]}`);
			log.push(cmd[0]);
			yield* script(options, signals);
		},
	} as unknown as Workspace;
	return { workspace, signals, commands, log };
}

/** `lines` as the CLI prints them, then its exit. */
async function* prints(lines: readonly string[], code = 0): AsyncGenerator<ExecEvent> {
	for (const line of lines) yield { type: "stdout", data: `${line}\n` };
	yield { type: "exit", code };
}

const lines = claudeLines;

const RESTORED: Restored = { userId: "ada", sessionId: "thread-1", harness: "claude-code", version: 3, connected: true, fingerprint: "f" };

/** The runner's other parts, each recording what happens to it in `log`. */
function deps(workspace: Workspace, log: string[], overrides: Partial<RunnerDeps> & { connected?: boolean; free?: boolean } = {}) {
	const records: (RunRecord | null)[] = [];
	const events: HarnessEvent[] = [];
	const tests: TestRun[] = [];
	const options: RunnerDeps = {
		harness: claudeCode,
		workspace,
		auth: { mode: "subscription" },
		credentials: {
			restore: async () => {
				log.push("restore");
				return { ...RESTORED, connected: overrides.connected ?? true };
			},
			writeBack: async () => {
				log.push("write back");
			},
		},
		lock: {
			acquire: async () => {
				log.push("lock");
				return overrides.free ?? true;
			},
			release: async () => {
				log.push("unlock");
			},
		},
		journal: { save: (record) => records.push(record), clear: () => records.push(null) },
		onEvent: (event) => {
			events.push(event);
		},
		onTestRun: (run) => tests.push(run),
		graceMs: 50,
		...overrides,
	};
	return { options, records, events, tests };
}

async function prepared(options: RunnerDeps, resume = false) {
	const runner = new HarnessRunner(options);
	expect(await runner.prepare("op-1", { sessionId: SESSION, resume })).toEqual({ status: "ready" });
	return runner;
}

describe("a CLI harness run", () => {
	it("restores the login, runs the CLI in the checkout, hands on its events and test runs, and writes the login back after", async () => {
		const { workspace, commands, log } = scripted(() => prints(lines("turn")));
		const { options, records, events, tests } = deps(workspace, log);
		const runner = await prepared(options);
		const result = await runner.run(TURN, 60_000);
		expect(result).toMatchObject({ status: "done", sessionId: SESSION, sessionCostUsd: 0.0841, model: "claude-sonnet-5", lines: 32 });
		// Each model response counted once, though the CLI printed msg_01A three times.
		expect(result.usage).toEqual({ input: 2114 + 431 + 12 + 12, output: 184 + 96 + 58 + 58, cacheRead: 13008 + 20242 + 20673 + 20673, cacheWrite: 5120 + 0 + 620 + 620 });
		expect(log).toEqual(["lock", "restore", "claude", "write back", "unlock"]);
		const [run] = commands;
		expect(run!.cmd).toEqual(claudeCode.buildCommand(TURN));
		expect(run!.options).toMatchObject({ cwd: "/workspace/repo", env: { HOME: "/workspace", CLAUDE_CONFIG_DIR: "/workspace/.claude", DISABLE_TELEMETRY: "1" } });
		expect(run!.options.timeoutMs).toBeGreaterThan(60_000);
		expect(events.map((event) => event.type)).toEqual(parse(fixture("turn")).map((event) => event.type));
		// `npm test` printed vitest's summary and failed with its exit code.
		expect(tests).toEqual([expect.objectContaining({ command: "npm test", exitCode: 1, timedOut: false, summary: { format: "vitest", passed: 3, failed: 1, skipped: 0, total: 4 } })]);
		// The run was kept with its login and lock while it went on, and its progress line by line; then forgotten.
		expect(records[1]).toMatchObject({ operationId: "op-1", sessionId: SESSION, resume: false, restored: RESTORED, locked: true, lines: 0 });
		expect(records.at(-2)).toMatchObject({ lines: 32 });
		expect(records.at(-1)).toBeNull();
	});

	it("waits for the person's login when there is none, clearing the workspace and letting the lock go without running", async () => {
		const { workspace, commands, log } = scripted(() => prints([]));
		const { options, records } = deps(workspace, log, { connected: false });
		expect(await new HarnessRunner(options).prepare("op-1", { sessionId: SESSION, resume: false })).toEqual({ status: "login_required" });
		expect(log).toEqual(["lock", "restore", "write back", "unlock"]);
		expect(commands).toEqual([]);
		expect(records.at(-1)).toBeNull();
	});

	it("runs one at a time per person: busy while another run holds the lock, touching nothing", async () => {
		const { workspace, log } = scripted(() => prints([]));
		const { options, records } = deps(workspace, log, { free: false });
		expect(await new HarnessRunner(options).prepare("op-1", { sessionId: SESSION, resume: false })).toEqual({ status: "busy" });
		expect(log).toEqual(["lock"]);
		expect(records).toEqual([]);
	});

	it("neither restores a login nor locks when signed in through its environment, which it runs with", async () => {
		const { workspace, commands, log } = scripted(() => prints(lines("turn")));
		const auth: HarnessAuth = { mode: "env", env: { ANTHROPIC_BASE_URL: "https://gateway.example" } };
		const { options } = deps(workspace, log, { auth });
		const runner = await prepared(options);
		expect((await runner.run(TURN, 60_000)).status).toBe("done");
		expect(log).toEqual(["claude"]);
		expect(commands[0]!.options.env).toMatchObject({ ANTHROPIC_BASE_URL: "https://gateway.example" });
	});

	it("never reports a turn without a successful result as done: no result, a failed result, a crash, a lost login", async () => {
		const cases: [Script, Partial<ReturnType<HarnessRunner["run"]> extends Promise<infer R> ? R : never>][] = [
			[() => prints(lines("turn").slice(0, -1), 0), { status: "unanswered", reason: "harness_error", detail: "Claude Code exited 0 without a result" }],
			[() => prints(lines("budget"), 1), { status: "unanswered", reason: "budget", sessionCostUsd: 1.2034 }],
			[() => prints(lines("login"), 1), { status: "unanswered", reason: "login_required" }],
			[() => prints(["not json"], 2), { status: "unanswered", reason: "harness_error" }],
			[
				async function* () {
					yield { type: "stderr", data: "Error: No conversation found with session ID: 0b7f\n" };
					yield { type: "exit", code: 1 };
				},
				{ status: "unanswered", reason: "harness_error", detail: "Claude Code exited 1 without a result: Error: No conversation found with session ID: 0b7f" },
			],
		];
		for (const [script, expected] of cases) {
			const { workspace, log } = scripted(script);
			const { options } = deps(workspace, log);
			expect(await (await prepared(options)).run(TURN, 60_000)).toMatchObject(expected);
			// The login is written back and the lock let go whatever happened.
			expect(log.slice(-2)).toEqual(["write back", "unlock"]);
		}
	});

	it("writes the login back and lets the lock go when the workspace fails mid-run, and when handing an event on fails", async () => {
		const { workspace, log } = scripted(async function* () {
			yield { type: "stdout", data: `${lines("turn")[0]}\n` };
			throw new Error("The workspace manager went away");
		});
		const { options, records } = deps(workspace, log, {
			onEvent: () => {
				throw new Error("The transcript is full");
			},
		});
		await expect((await prepared(options)).run(TURN, 60_000)).rejects.toThrow("went away");
		expect(log).toEqual(["lock", "restore", "claude", "write back", "unlock"]);
		expect(records.at(-1)).toBeNull();
	});

	it("still lets the lock go and forgets the run when the write-back fails", async () => {
		const { workspace, log } = scripted(() => prints(lines("turn")));
		const { options, records } = deps(workspace, log, {
			credentials: {
				restore: async () => RESTORED,
				writeBack: async () => {
					throw new Error("vault down");
				},
			},
		});
		expect((await (await prepared(options)).run(TURN, 60_000)).status).toBe("done");
		expect(log).toEqual(["lock", "claude", "unlock"]);
		expect(records.at(-1)).toBeNull();
	});

	it("stops on abort with SIGINT, which the CLI ends its turn on, and reports the turn aborted", async () => {
		const { workspace, log, signals } = scripted(async function* (options, signals) {
			yield { type: "stdout", data: `${lines("turn")[0]}\n` };
			await signals.wait("INT", options.signal);
			yield* prints(['{"type":"result","subtype":"error_during_execution","is_error":true,"session_id":"0b7f4c52-9a1e-4d3b-8c2f-5e6a7b8c9d01","total_cost_usd":0.02,"errors":["Interrupted"]}'], 130);
		});
		const { options } = deps(workspace, log);
		const runner = await prepared(options);
		const running = runner.run(TURN, 60_000);
		await new Promise((resolve) => setTimeout(resolve, 10));
		await runner.abort();
		expect(await running).toMatchObject({ status: "unanswered", reason: "aborted", sessionCostUsd: 0.02 });
		expect(signals.sent).toEqual(["INT"]);
		expect(log).toEqual(["lock", "restore", "claude", "signal -INT", "write back", "unlock"]);
	});

	it("kills a CLI that ignores SIGINT after the grace, on abort and when the turn runs out of time", async () => {
		for (const how of ["abort", "timeout"] as const) {
			const { workspace, log, signals } = scripted(async function* (options, signals) {
				await signals.wait("KILL", options.signal);
				// Killed by the workspace: no exit code, and no result.
				yield { type: "exit", code: null, signal: "SIGTERM" };
			});
			const { options } = deps(workspace, log);
			const runner = await prepared(options);
			const started = Date.now();
			const running = runner.run(TURN, how === "timeout" ? 30 : 60_000);
			if (how === "abort") await runner.abort();
			const result = await running;
			expect(result).toMatchObject({ status: "unanswered", reason: how === "abort" ? "aborted" : "timeout" });
			await vi.waitFor(() => expect(signals.sent).toEqual(["INT", "KILL"]));
			expect(Date.now() - started).toBeLessThan(5_000);
			expect(log.filter((entry) => !entry.startsWith("signal"))).toEqual(["lock", "restore", "claude", "write back", "unlock"]);
		}
	});

	it("stops before running when aborted while getting ready", async () => {
		const { workspace, commands, log } = scripted(() => prints(lines("turn")));
		const { options } = deps(workspace, log);
		const runner = await prepared(options);
		await runner.abort();
		expect(await runner.run(TURN, 60_000)).toMatchObject({ status: "unanswered", reason: "aborted" });
		expect(commands).toEqual([]);
		expect(log).toEqual(["lock", "restore", "write back", "unlock"]);
	});

	it("finishes off a run a restart cut off: the CLI killed, the login written back, the lock let go, the turn interrupted", async () => {
		const { workspace, log, signals } = scripted(() => prints([]));
		const { options, records } = deps(workspace, log);
		const record: RunRecord = { operationId: "op-1", sessionId: SESSION, resume: true, startedAt: 0, lines: 12, restored: RESTORED, locked: true };
		const result = await recoverRun(options, record);
		expect(result).toMatchObject({ status: "unanswered", reason: "interrupted", sessionCostUsd: null, lines: 12 });
		expect(result.detail).toContain("after 12 lines");
		expect(signals.sent).toEqual(["KILL"]);
		expect(log).toEqual(["signal -KILL", "write back", "unlock"]);
		expect(records).toEqual([null]);
		// One restored before its run started holds no lock to let go.
		const before = scripted(() => prints([]));
		await recoverRun(deps(before.workspace, before.log).options, { ...record, restored: null, locked: false });
		expect(before.log).toEqual(["signal -KILL"]);
	});
});

describe("a Codex run", () => {
	const CODEX_TURN: HarnessTurn = { ...TURN, sessionId: "5d3c7a9e-1b2f-4c6d-8e0a-9f1b2c3d4e5f" };
	const codexDeps = (workspace: Workspace, log: string[], overrides: Partial<RunnerDeps> & { connected?: boolean } = {}) =>
		deps(workspace, log, { harness: codex, credentials: { restore: async () => (log.push("restore"), { ...RESTORED, harness: "codex", connected: overrides.connected ?? true }), writeBack: async () => void log.push("write back") }, ...overrides });

	it("restores the login, runs Codex in the checkout with its config directory, and reports the session's tokens and test runs", async () => {
		const { workspace, commands, log } = scripted(() => prints(codexLines("turn")));
		const { options, tests, events } = codexDeps(workspace, log);
		const runner = new HarnessRunner(options);
		expect(await runner.prepare("op-1", { sessionId: CODEX_TURN.sessionId, resume: false })).toEqual({ status: "ready" });
		const result = await runner.run(CODEX_TURN, 60_000);
		expect(result).toMatchObject({ status: "done", sessionId: CODEX_SESSION, sessionCostUsd: null, model: "codex", lines: codexLines("turn").length });
		// Codex reports no tokens per message, only the session's at the turn's end.
		expect(result.usage).toEqual({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0 });
		expect(result.sessionUsage).toEqual({ input: 5110, output: 1180, cacheRead: 19200, cacheWrite: 0 });
		expect(log).toEqual(["lock", "restore", "codex", "write back", "unlock"]);
		expect(commands[0]!.cmd).toEqual(codex.buildCommand(CODEX_TURN));
		expect(commands[0]!.options).toMatchObject({ cwd: "/workspace/repo", env: { HOME: "/workspace", CODEX_HOME: "/workspace/.codex" } });
		expect(commands[0]!.options.env).not.toHaveProperty("CLAUDE_CONFIG_DIR");
		expect(events.filter((event) => event.type === "notice")).toHaveLength(1);
		// Both shell commands ran tests: the failing run with vitest's summary, the passing one with its exit code.
		expect(tests).toEqual([
			expect.objectContaining({ command: "npm test", exitCode: 1, summary: { format: "vitest", passed: 3, failed: 1, skipped: 0, total: 4 } }),
			expect.objectContaining({ command: "npx vitest run test/greet.test.ts && echo 'all good'", exitCode: 0, summary: { format: "vitest", passed: 4, failed: 0, skipped: 0, total: 4 } }),
		]);
	});

	it("takes a shell command's exit code from Codex, not from whether it failed", async () => {
		const line = '{"type":"item.completed","item":{"id":"t","type":"command_execution","command":"/bin/bash -lc pytest","aggregated_output":"interrupted","exit_code":2,"status":"failed"}}';
		const { workspace, log } = scripted(() => prints([codexLines("turn")[0]!, line, codexLines("turn").at(-1)!]));
		const { options, tests } = codexDeps(workspace, log);
		await (await prepared(options)).run(CODEX_TURN, 60_000);
		expect(tests).toEqual([expect.objectContaining({ command: "pytest", exitCode: 2 })]);
	});

	it("resumes Codex's session on a later turn, and asks for the thread's model", async () => {
		const { workspace, commands, log } = scripted(() => prints(codexLines("turn")));
		const { options } = codexDeps(workspace, log);
		const turn = { ...TURN, sessionId: CODEX_SESSION, resume: true, model: "gpt-5.5-codex" };
		const result = await (await prepared(options, true)).run(turn, 60_000);
		expect(result).toMatchObject({ status: "done", sessionId: CODEX_SESSION, model: "gpt-5.5-codex" });
		expect(commands[0]!.cmd.slice(-4)).toEqual(["resume", CODEX_SESSION, "--", TURN.prompt]);
	});

	it("never reports a turn as done without `turn.completed`: a lost login, a failure, a session Codex no longer has, a crash", async () => {
		const cases: [Script, Partial<Awaited<ReturnType<HarnessRunner["run"]>>>][] = [
			[() => prints(codexLines("login"), 1), { status: "unanswered", reason: "login_required", detail: "Codex isn't signed in: connect it again" }],
			[() => prints(codexLines("expired"), 1), { status: "unanswered", reason: "login_required" }],
			[() => prints(codexLines("failed"), 1), { status: "unanswered", reason: "harness_error", sessionId: CODEX_SESSION, detail: expect.stringContaining("exceeds the context window") }],
			[() => prints(codexLines("turn").slice(0, -1), 0), { status: "unanswered", reason: "harness_error", detail: "Codex exited 0 without a result", sessionUsage: null }],
			[
				async function* () {
					// What 0.167.0 prints when it resumes a session it doesn't have.
					yield { type: "stderr", data: "Error: thread/resume: thread/resume failed: no rollout found for thread id 019a0000-0000-7000-8000-000000000000 (code -32600)\n" };
					yield { type: "exit", code: 1 };
				},
				{ status: "unanswered", reason: "harness_error", sessionId: null, detail: expect.stringContaining("Codex exited 1 without a result: Error: thread/resume") },
			],
		];
		for (const [script, expected] of cases) {
			const { workspace, log } = scripted(script);
			const { options } = codexDeps(workspace, log);
			expect(await (await prepared(options)).run(CODEX_TURN, 60_000)).toMatchObject(expected);
			expect(log.slice(-2)).toEqual(["write back", "unlock"]);
		}
	});

	it("stops on abort with SIGINT to the process its first turn's id names, and reports the turn aborted", async () => {
		const { workspace, log, commands, signals } = scripted(async function* (options, signals) {
			yield { type: "stdout", data: `${codexLines("turn")[0]}\n` };
			await signals.wait("INT", options.signal);
			// Codex 0.167.0 prints nothing more when interrupted, and exits 1.
			yield { type: "exit", code: 1 };
		});
		const { options } = codexDeps(workspace, log);
		const runner = new HarnessRunner(options);
		await runner.prepare("op-1", { sessionId: CODEX_TURN.sessionId, resume: false });
		const running = runner.run(CODEX_TURN, 60_000);
		await new Promise((resolve) => setTimeout(resolve, 10));
		await runner.abort();
		expect(await running).toMatchObject({ status: "unanswered", reason: "aborted", sessionId: CODEX_SESSION });
		expect(signals.sent).toEqual(["INT"]);
		const pkill = commands.find((command) => command.cmd[0] === "pkill")!.cmd;
		expect(pkill).toEqual(["pkill", "-INT", "-f", CODEX_TURN.sessionId]);
		expect(commands[0]!.cmd.join(" ")).toContain(CODEX_TURN.sessionId);
		expect(log).toEqual(["lock", "restore", "codex", "signal -INT", "write back", "unlock"]);
	});

	it("waits for the person's login when there is none, without running Codex", async () => {
		const { workspace, commands, log } = scripted(() => prints([]));
		const { options } = codexDeps(workspace, log, { connected: false });
		expect(await new HarnessRunner(options).prepare("op-1", { sessionId: CODEX_TURN.sessionId, resume: false })).toEqual({ status: "login_required" });
		expect(commands).toEqual([]);
		expect(log).toEqual(["lock", "restore", "write back", "unlock"]);
	});
});
