import { describe, expect, it, vi } from "vitest";
import { CLAUDE_CODE_FLAGS, ClaudeStreamParser, claudeCode } from "../src/coding/harness/claude-code";
import { AMP_FLAGS, amp, ampLogFile } from "../src/coding/harness/amp";
import { authEnv } from "../src/coding/harness/auth";
import { CODEX_FLAGS, CodexJsonParser, codex, shellScript } from "../src/coding/harness/codex";
import { cliHarness } from "../src/coding/harness/index";
import { type HarnessAuth, HarnessRunner, LineBuffer, type RunRecord, recoverRun, type RunnerDeps } from "../src/coding/harness/runner";
import type { CliHarness, HarnessEvent, HarnessFiles, HarnessTurn } from "../src/coding/harness/types";
import { mistralVibe, VIBE_FLAGS, VIBE_SESSIONS, VibeStreamParser, vibeRunDir } from "../src/coding/harness/vibe";
import type { CodingThreadRow } from "../src/coding/thread-store";
import type { TestRun } from "../src/coding/tools";
import type { Restored } from "../src/coding/vault/inject";
import { type ExecEvent, type ExecOptions, type Workspace, WorkspaceFileError } from "../src/coding/workspace/types";
import { AMP_SESSION, ampFixture, ampLines } from "./fixtures/amp";
import { CLAUDE_SESSION, claudeFixture, claudeLines } from "./fixtures/claude-code";
import { CODEX_SESSION, codexFixture, codexLines } from "./fixtures/codex";
import { VIBE_META, VIBE_SESSION, vibeExport, vibeLines, vibeOutput } from "./fixtures/vibe";

// The CLI harness framework (src/coding/harness/) on its own: Claude Code's command line and stream-json parser against
// stream-json written from its documented schema (test/fixtures/claude-code/), and the runner against a workspace whose
// `claude` is a script. How a coding thread uses them is in test/coding-thread-do.test.ts.

const fixture = claudeFixture;
const SESSION = CLAUDE_SESSION;

const parse = (text: string) => {
	const parser = new ClaudeStreamParser();
	return text.split("\n").flatMap((line) => parser.parseLine(line));
};

const TURN: HarnessTurn = { prompt: "Fix the greeting test", sessionId: SESSION, resume: false, maxBudgetUsd: 2.999, maxTokens: null, model: null, instructions: "Don't push.", sessionBefore: { costUsd: 0, usage: null } };

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

/** The turn the Vibe fixtures were captured with: a new session, so Pim's id names its run directory. */
const VIBE_TURN: HarnessTurn = { ...TURN, sessionId: "5d3c7a9e-1b2f-4c6d-8e0a-9f1b2c3d4e5f" };
const VIBE_DIR = vibeRunDir(VIBE_TURN.sessionId);

/** The workspace's files as `finish` reads them, and what it removed. */
function vibeFiles(entries: Record<string, string>) {
	const files = new Map(Object.entries(entries));
	const removed: string[] = [];
	const access: HarnessFiles = {
		read: async (path) => files.get(path) ?? null,
		remove: async (path) => {
			removed.push(path);
			for (const each of [...files.keys()]) if (each === path || each.startsWith(`${path}/`)) files.delete(each);
		},
	};
	return { access, files, removed };
}

/** A run's export where Vibe writes it, and the journal's meta.json beside it. */
const exported = (name: Parameters<typeof vibeExport>[0], dir = VIBE_DIR, meta = true): Record<string, string> => ({
	[`${dir}/out/export.json`]: vibeExport(name),
	...(meta ? { [`${dir}/out/session/meta.json`]: VIBE_META } : {}),
});

/** What a run printed and left, as the parser reads it. */
async function readVibe(name: Parameters<typeof vibeExport>[0], turn: HarnessTurn = VIBE_TURN) {
	const parser = new VibeStreamParser(turn);
	const printed = vibeLines(name).flatMap((line) => parser.parseLine(line));
	const { access, removed } = vibeFiles(exported(name, vibeRunDir(turn.sessionId)));
	const finished = await parser.finish(access);
	return { printed, finished, events: [...printed, ...finished], removed };
}

describe("Mistral Vibe's streaming output", () => {
	type Of<T extends HarnessEvent["type"]> = Extract<HarnessEvent, { type: T }>;
	const of = <T extends HarnessEvent["type"]>(events: HarnessEvent[], type: T) => events.filter((event): event is Of<T> => event.type === type);
	const messagesOf = (events: HarnessEvent[]) =>
		events.flatMap((event) => (event.type === "assistant" ? [event.message.content.map((part) => (part.type === "toolCall" ? `call:${part.name}` : part.type)).join(",")] : event.type === "tool_result" ? [`result:${event.message.toolName}`] : []));

	it("is read into the session, the transcript's messages with their tools, and, from export.json, the model, the run's tokens and its cost", async () => {
		const { printed, finished, removed } = await readVibe("turn");
		expect(of(printed, "unparsed")).toEqual([]);
		// The session once, from the first entry; Vibe prints whole entries, never deltas.
		expect(printed[0]).toEqual({ type: "session", sessionId: VIBE_SESSION, model: null });
		expect(of(printed, "session")).toHaveLength(1);
		expect(of(printed, "delta")).toEqual([]);
		// The person's own message isn't the assistant's: the thread wrote it already.
		expect(messagesOf(printed)).toEqual([
			"thinking",
			"text",
			"call:file_system.bash",
			"result:file_system.bash",
			// `grep` run through bash, which Vibe shows as a search.
			"call:grep",
			"result:grep",
			"call:file_system.edit",
			"result:file_system.edit",
			"call:file_system.bash",
			"result:file_system.bash",
			"text",
		]);
		const assistants = of(printed, "assistant");
		expect(assistants[0]!.message.content).toEqual([{ type: "thinking", thinking: "The greeting test fails; run it first." }]);
		expect(assistants[2]!.message).toMatchObject({ provider: "mistral-vibe", stopReason: "toolUse", content: [{ type: "toolCall", name: "file_system.bash", arguments: { command: "npm test" } }] });
		expect(assistants[4]!.message.content[0]).toMatchObject({ name: "file_system.edit", arguments: { filePath: "greet.js", oldString: "Hello, ${name}`", newString: "Hello, ${name}!`" } });
		expect(assistants.at(-1)!.message).toMatchObject({ stopReason: "stop", content: [{ type: "text", text: "Fixed `greet` to end with an exclamation mark; the greeting test passes now." }] });
		// Each call's result has the call's id; a failing command is an error, and a file edit, which prints nothing, says what it did.
		const results = of(printed, "tool_result").map((event) => event.message);
		expect(results.map((result) => result.toolCallId)).toEqual(assistants.filter((event) => event.message.stopReason === "toolUse").map((event) => event.messageId));
		expect(results.map((result) => result.isError)).toEqual([true, false, false, false]);
		expect(results[0]!.content[0]).toMatchObject({ text: expect.stringContaining("Tests  1 failed | 3 passed (4)") });
		expect(results[1]!.content[0]).toMatchObject({ text: expect.stringContaining("./greet.js:1:") });
		expect(results[2]!.content).toEqual([{ type: "text", text: "Edited greet.js" }]);
		expect(results[3]!.content[0]).toMatchObject({ text: expect.stringContaining("Tests  4 passed (4)") });
		// Vibe reports no tokens per message; the export has the run's, cached input apart, its model and its cost.
		expect(assistants.every((event) => event.message.usage.input === 0)).toBe(true);
		expect(finished).toEqual([
			{ type: "session", sessionId: VIBE_SESSION, model: "mistral-vibe-cli-latest" },
			{ type: "usage", usage: { input: 15000 - 12500, output: 200, cacheRead: 12500, cacheWrite: 0 } },
			{ type: "result", ok: true, reason: null, sessionId: VIBE_SESSION, sessionCostUsd: 0.007125, text: null, errors: [] },
		]);
		expect(removed).toEqual([VIBE_DIR]);
	});

	it("adds a resumed run's cost and tokens to what the session cost and used before, as export.json counts that run alone", async () => {
		const before = { costUsd: 0.007125, usage: { input: 2500, output: 200, cacheRead: 12500, cacheWrite: 0 } };
		const { printed, finished } = await readVibe("resume", { ...VIBE_TURN, sessionId: VIBE_SESSION, resume: true, sessionBefore: before });
		// Only the new run is printed.
		expect(messagesOf(printed)).toEqual(["text"]);
		expect(of(finished, "usage")).toEqual([{ type: "usage", usage: { input: 2500 + (4000 - 3500), output: 200 + 40, cacheRead: 12500 + 3500, cacheWrite: 0 } }]);
		const [result] = of(finished, "result");
		expect(result).toMatchObject({ ok: true, sessionId: VIBE_SESSION });
		expect(result!.sessionCostUsd).toBeCloseTo(0.007125 + 0.001575, 12);
		// A session Pim knew no tokens of before counts this run's.
		const fresh = await readVibe("resume", { ...VIBE_TURN, sessionId: VIBE_SESSION, resume: true, sessionBefore: { costUsd: 0.5, usage: null } });
		expect(of(fresh.finished, "usage")[0]!.usage).toEqual({ input: 500, output: 40, cacheRead: 3500, cacheWrite: 0 });
		expect(of(fresh.finished, "result")[0]!.sessionCostUsd).toBeCloseTo(0.501575, 12);
	});

	it("says when Vibe refused a tool call nobody approved, and the call's result says so", async () => {
		const parser = new VibeStreamParser(VIBE_TURN);
		const events = vibeLines("denied").flatMap((line) => parser.parseLine(line));
		const command = "echo 'Tests: 3 passed'; npm --version >/dev/null 2>&1; echo ok";
		expect(of(events, "permission_denied")).toEqual([{ type: "permission_denied", tool: "file_system.bash", message: `bash: ${command}` }]);
		expect(of(events, "tool_result")[0]!.message).toMatchObject({ toolName: "file_system.bash", isError: true, content: [{ type: "text", text: "Tool execution denied by approval callback" }] });
		expect(messagesOf(events)).toEqual(["text", "call:file_system.bash", "result:file_system.bash", "text"]);
	});

	it("ends a run stopped by its budget, an API error, a refused key, an interrupt or a session Vibe doesn't have as failed, saying why", async () => {
		const price = await readVibe("price");
		expect(of(price.finished, "result")).toEqual([{ type: "result", ok: false, reason: "budget", sessionId: "710915ed-6170-1736-b727-0b03b03e8754", sessionCostUsd: 1.35, text: null, errors: ["Mistral Vibe stopped: price limit"] }]);
		// The call it stopped before running is cancelled, which its result says.
		expect(of(price.printed, "tool_result")[0]!.message).toMatchObject({ isError: true, content: [{ type: "text", text: "client interrupt" }] });

		const error = await readVibe("error");
		expect(of(error.events, "auth_failed")).toEqual([]);
		expect(of(error.finished, "result")[0]).toMatchObject({ ok: false, reason: "error", sessionCostUsd: 0, errors: [expect.stringContaining("Invalid model: mock-broken")] });

		// What api.mistral.ai said to a made-up key: the thread waits for the person to connect Vibe again.
		const auth = await readVibe("auth");
		const message = "Invalid API key (from env var MISTRAL_API_KEY). Please check your API key and try again.";
		expect(of(auth.finished, "auth_failed")).toEqual([{ type: "auth_failed", message }]);
		expect(of(auth.finished, "result")[0]).toMatchObject({ ok: false, reason: "error", errors: [message] });
		const missingKey = new VibeStreamParser(VIBE_TURN);
		const none = await missingKey.finish(vibeFiles({ [`${VIBE_DIR}/out/export.json`]: JSON.stringify({ outcome: "config_error", error: { message: "Missing MISTRAL_API_KEY environment variable for mistral provider", code: null } }) }).access);
		expect(of(none, "auth_failed")).toHaveLength(1);

		// SIGINT: the run's cost so far is still counted.
		const interrupted = await readVibe("interrupted");
		expect(of(interrupted.finished, "result")[0]).toMatchObject({ ok: false, reason: "error", sessionCostUsd: 0.000714, errors: ["Mistral Vibe stopped: terminated"] });
		expect(of(interrupted.printed, "tool_result")[0]!.message).toMatchObject({ isError: true, content: [{ type: "text", text: "client interrupt" }] });

		// A session Vibe doesn't have: nothing printed, and no session, so the thread lets it go and starts a new one.
		const missing = await readVibe("missing", { ...VIBE_TURN, sessionId: "0b0b0b0b-0000-4000-8000-00000000dead", resume: true, sessionBefore: { costUsd: 0.25, usage: null } });
		expect(vibeOutput("missing")).toBe("");
		expect(missing.events).toEqual([{ type: "result", ok: false, reason: "error", sessionId: null, sessionCostUsd: null, text: null, errors: ["Session not found: 0b0b0b0b-0000-4000-8000-00000000dead"] }]);
	});

	it("removes the run's directory whatever it found, and says nothing more without an export", async () => {
		const parser = new VibeStreamParser(VIBE_TURN);
		parser.parseLine(vibeLines("turn")[0]!);
		const empty = vibeFiles({});
		expect(await parser.finish(empty.access)).toEqual([]);
		expect(empty.removed).toEqual([VIBE_DIR]);
		const cut = vibeFiles({ [`${VIBE_DIR}/out/export.json`]: '{"outcome": "fini' });
		expect(await new VibeStreamParser(VIBE_TURN).finish(cut.access)).toEqual([{ type: "unparsed", line: '{"outcome": "fini' }]);
		expect(cut.removed).toEqual([VIBE_DIR]);
		// Without the journal's meta.json, the model is the one the export's config pins, or none.
		const pinned = JSON.stringify({ ...JSON.parse(vibeExport("turn")), config: { active_model: "devstral", models: { devstral: { name: "devstral-2512" } } } });
		const alone = await new VibeStreamParser(VIBE_TURN).finish(vibeFiles({ [`${VIBE_DIR}/out/export.json`]: pinned }).access);
		expect(alone[0]).toEqual({ type: "session", sessionId: VIBE_SESSION, model: "devstral-2512" });
		const unpinned = await new VibeStreamParser(VIBE_TURN).finish(vibeFiles(exported("turn", VIBE_DIR, false)).access);
		expect(unpinned[0]).toEqual({ type: "session", sessionId: VIBE_SESSION, model: null });
	});

	it("keeps a line that isn't JSON as unparsed; skips the person's messages, entries still being written, discarded answers and types it doesn't know", () => {
		const parser = new VibeStreamParser(VIBE_TURN);
		const [user, , answer] = vibeLines("turn");
		const effect = vibeLines("turn")[3]!;
		expect(parser.parseLine("")).toEqual([]);
		expect(parser.parseLine("Warning: /workspace/repo is not trusted")).toEqual([{ type: "unparsed", line: "Warning: /workspace/repo is not trusted" }]);
		expect(parser.parseLine("[1,2]")).toMatchObject([{ type: "unparsed" }]);
		expect(parser.parseLine(user!)).toEqual([{ type: "session", sessionId: VIBE_SESSION, model: null }]);
		const entry = JSON.parse(answer!);
		expect(parser.parseLine(JSON.stringify({ ...entry, generationStatus: "in_progress" }))).toEqual([]);
		expect(parser.parseLine(JSON.stringify({ ...entry, outcome: { type: "discarded", cause: "output_limit" } }))).toEqual([]);
		expect(parser.parseLine(JSON.stringify({ ...entry, type: "checkpoint", kind: "turn" }))).toEqual([]);
		expect(parser.parseLine(JSON.stringify({ ...entry, type: "notice", level: "warning", message: "Context is almost full", detail: { kind: "agent_changed", agentName: "x" } }))).toEqual([{ type: "notice", message: "Context is almost full" }]);
		// An effect still running is written once it settles, and once only.
		const running = JSON.parse(effect);
		expect(parser.parseLine(JSON.stringify({ ...running, state: { status: "running" } }))).toEqual([]);
		expect(parser.parseLine(effect).map((event) => event.type)).toEqual(["assistant", "tool_result"]);
		expect(parser.parseLine(effect)).toEqual([]);
	});
});

describe("Mistral Vibe's command line", () => {
	const flag = (command: string[], name: string) => command[command.indexOf(name) + 1];

	it("starts Vibe through a shell that makes the run's directory anew, with Pim's instructions in its new home and the prompt in a file", () => {
		const command = mistralVibe.buildCommand(VIBE_TURN);
		expect(command.slice(0, 2)).toEqual(["/bin/sh", "-c"]);
		const script = command[2]!;
		expect(script).toContain('rm -rf "$d" && mkdir -p "$d/home"');
		expect(script).toContain('> "$d/home/AGENTS.md"');
		expect(script).toContain('VIBE_HOME="$d/home" exec "$@"');
		// $0, then the directory, the instructions and the prompt, then Vibe's own command line.
		expect(command.slice(3, 5)).toEqual(["vibe", VIBE_DIR]);
		expect(command[5]).toMatch(/^Don't push\.\n\nThe repository's own AGENTS\.md files and \.vibe\/ configuration aren't loaded for you/);
		expect(command[6]).toBe("Fix the greeting test");
		const vibe = command.slice(7);
		expect(vibe.slice(0, 1 + VIBE_FLAGS.length)).toEqual(["vibe", "--output", "streaming", "--auto-approve"]);
		expect(flag(vibe, "--workdir")).toBe("/workspace/repo");
		expect(flag(vibe, "--output-dir")).toBe(`${VIBE_DIR}/out`);
		// The budget left, rounded down, so Vibe never stops later than the thread would.
		expect(flag(vibe, "--max-price")).toBe("2.99");
		expect(vibe.slice(-2)).toEqual(["--prompt-file", `${VIBE_DIR}/prompt.md`]);
		// The checkout is never trusted, and a new session runs Vibe's own model.
		for (const absent of ["--trust", "--resume", "--model", "--yolo", "-p", "--prompt"]) expect(vibe).not.toContain(absent);
		expect(vibe).not.toContain("Fix the greeting test");
	});

	it("resumes Vibe's session after the first turn without --model, which Vibe refuses there, and asks for the model on a new session", () => {
		const resumed = mistralVibe.buildCommand({ ...VIBE_TURN, sessionId: VIBE_SESSION, resume: true, model: "devstral", prompt: "--help me", maxBudgetUsd: -1 });
		expect(flag(resumed, "--resume")).toBe(VIBE_SESSION);
		expect(resumed).not.toContain("--model");
		expect(flag(resumed, "--max-price")).toBe("0.00");
		expect(flag(resumed, "--output-dir")).toBe(`${vibeRunDir(VIBE_SESSION)}/out`);
		// A prompt that looks like a flag is only ever the prompt file's text.
		expect(resumed[6]).toBe("--help me");
		expect(resumed.slice(7)).not.toContain("--help me");
		const fresh = mistralVibe.buildCommand({ ...VIBE_TURN, model: "devstral" });
		expect(flag(fresh, "--model")).toBe("devstral");
		expect(vibeRunDir("../../etc")).toBe("/workspace/.pim-vibe/______etc");
	});

	it("signals the turn's process by its run directory, keeps the key off the command line, and turns off what a run doesn't need", () => {
		const command = mistralVibe.buildCommand(VIBE_TURN);
		expect(mistralVibe.signalCommand(VIBE_TURN.sessionId, "INT")).toEqual(["pkill", "-INT", "-f", `${VIBE_DIR}/out`]);
		// Only Vibe's own command line, after the shell's `exec`, carries it.
		expect(command.slice(7).join(" ")).toContain(`${VIBE_DIR}/out`);
		expect(mistralVibe).toMatchObject({ id: "mistral-vibe", name: "Mistral Vibe", apiKeyEnv: "MISTRAL_API_KEY", shellTool: "file_system.bash", egress: ["api.mistral.ai"] });
		expect(mistralVibe.login).toBeUndefined();
		expect(mistralVibe.env).toEqual({
			VIBE_SESSION_LOGGING__SAVE_DIR: VIBE_SESSIONS,
			VIBE_ENABLE_MCP: "false",
			VIBE_ENABLE_CONNECTORS: "false",
			VIBE_ENABLE_SUBAGENTS: "false",
			VIBE_DISABLED_SKILLS: '["*"]',
			VIBE_ENABLE_TELEMETRY: "false",
			VIBE_EXPERIMENTS__ENABLE: "false",
			VIBE_ENABLE_UPDATE_CHECKS: "false",
			VIBE_ENABLE_AUTO_UPDATE: "false",
			VIBE_SHOW_GREETING: "false",
			VIBE_ENABLE_NOTIFICATIONS: "false",
		});
		expect(VIBE_SESSIONS).toBe("/workspace/.vibe-sessions");
		expect(JSON.stringify(command)).not.toContain("MISTRAL_API_KEY");
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

/**
 * A workspace whose `claude`, `codex`, `amp` and `vibe` (started by `/bin/sh`) run `script`, and whose `pkill` sends
 * what it is given. Its files are `files`, by path, which a script may write. Everything it runs is recorded.
 */
function scripted(script: Script, files = new Map<string, string>()) {
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
			const name = cmd[0] === "/bin/sh" ? cmd[7] : cmd[0] === "sh" ? cmd[4] : cmd[0];
			if (name !== "claude" && name !== "codex" && name !== "amp" && name !== "vibe") throw new Error(`no ${cmd[0]}`);
			log.push(name);
			yield* script(options, signals);
		},
		async readFile(path: string) {
			const text = files.get(path);
			if (text === undefined) throw new WorkspaceFileError(`No such file: ${path}`);
			return new TextEncoder().encode(text);
		},
		async remove(path: string) {
			const gone = [...files.keys()].filter((each) => each === path || each.startsWith(`${path}/`));
			if (gone.length === 0) throw new WorkspaceFileError(`No such file: ${path}`);
			for (const each of gone) files.delete(each);
			log.push(`remove ${path}`);
		},
	} as unknown as Workspace;
	return { workspace, signals, commands, log, files };
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

	it("stops a turn with SIGINT once its tokens reach `maxTokens`, the ceiling of a CLI that estimates no cost, and says it reached its budget", async () => {
		const turn = lines("turn");
		// The turn's first message, of 2,114 tokens in, 184 out, 13,008 read from the cache and 5,120 written to it: 20,426.
		const printed = [turn[0]!, turn.find((line) => JSON.parse(line).type === "assistant")!, turn.at(-1)!];
		const run = async (maxTokens: number) => {
			const { workspace, log, signals } = scripted(() => prints(printed));
			const result = await (await prepared(deps(workspace, log).options)).run({ ...TURN, maxTokens }, 60_000);
			return { result, signals: signals.sent };
		};
		expect(await run(20_426)).toEqual({ result: expect.objectContaining({ status: "unanswered", reason: "budget", detail: "The turn reached the thread's token ceiling" }), signals: ["INT"] });
		expect(await run(20_427)).toEqual({ result: expect.objectContaining({ status: "done" }), signals: [] });
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

describe("a Mistral Vibe run", () => {
	const KEY = "TESTMISTRALKEY0123456789abcdef";
	const auth: HarnessAuth = { mode: "env", env: { MISTRAL_API_KEY: KEY }, secrets: [KEY] };
	const vibeDeps = (workspace: Workspace, log: string[], overrides: Partial<RunnerDeps> = {}) => deps(workspace, log, { harness: mistralVibe, auth, ...overrides });

	it("hands Vibe the key in its environment alone, reads its transcript, test runs, tokens and cost, and removes the run's directory", async () => {
		// Vibe printed the key in a test's output and a warning of its export.
		const output = vibeLines("turn").map((line) => line.replaceAll("> node test.js", `> node test.js ${KEY}`));
		const files = new Map<string, string>();
		const { workspace, commands, log } = scripted(async function* () {
			// What Vibe leaves when it exits.
			files.set(`${VIBE_DIR}/out/export.json`, JSON.stringify({ ...JSON.parse(vibeExport("turn")), warnings: [{ message: `Ignored ${KEY} in .env` }] }));
			files.set(`${VIBE_DIR}/out/session/meta.json`, VIBE_META);
			yield* prints(output);
		}, files);
		const { options, events, tests, records } = vibeDeps(workspace, log);
		const runner = new HarnessRunner(options);
		expect(await runner.prepare("op-1", { sessionId: VIBE_TURN.sessionId, resume: false })).toEqual({ status: "ready" });
		const result = await runner.run(VIBE_TURN, 60_000);
		expect(result).toEqual({
			status: "done",
			sessionId: VIBE_SESSION,
			sessionCostUsd: 0.007125,
			usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			sessionUsage: { input: 2500, output: 200, cacheRead: 12500, cacheWrite: 0 },
			model: "mistral-vibe-cli-latest",
			lines: 8,
		});
		// No login and no lock, the key only in the environment, and the run's directory gone after.
		expect(log).toEqual(["vibe", `remove ${VIBE_DIR}`]);
		expect(files.size).toBe(0);
		expect(commands[0]!.cmd).toEqual(mistralVibe.buildCommand(VIBE_TURN));
		expect(commands[0]!.options).toMatchObject({ cwd: "/workspace/repo", env: { HOME: "/workspace", MISTRAL_API_KEY: KEY, VIBE_ENABLE_MCP: "false", VIBE_SESSION_LOGGING__SAVE_DIR: VIBE_SESSIONS } });
		expect(JSON.stringify(commands.map((command) => command.cmd))).not.toContain(KEY);
		// Vibe says whether a command succeeded, not its exit code: a failing test run is 1.
		expect(tests.map((run) => [run.command, run.exitCode, run.summary?.failed])).toEqual([
			["npm test", 1, 1],
			["npm test", 0, 0],
		]);
		expect(tests[0]!.output).toContain("> node test.js [redacted]");
		expect(events.find((event) => event.type === "notice")).toEqual({ type: "notice", message: "Ignored [redacted] in .env" });
		expect(JSON.stringify({ events, tests, records, result })).not.toContain(KEY);
		expect(records.at(-1)).toBeNull();
	});

	it("stops on abort with SIGINT to the process its run directory names, and still counts what the run cost", async () => {
		const files = new Map<string, string>();
		const [user, said, cancelled] = vibeLines("interrupted");
		const interruptedTurn = { ...VIBE_TURN, sessionId: "9b1f2c3d-0000-4000-8000-000000000003" };
		const dir = vibeRunDir(interruptedTurn.sessionId);
		const { workspace, log, commands } = scripted(async function* (options, signals) {
			yield { type: "stdout", data: `${user}\n${said}\n` };
			await signals.wait("INT", options.signal);
			// Vibe 3.1.0 cancels the running call, writes its export and exits 3.
			files.set(`${dir}/out/export.json`, vibeExport("interrupted"));
			yield { type: "stdout", data: `${cancelled}\n` };
			yield { type: "exit", code: 3 };
		}, files);
		const { options } = vibeDeps(workspace, log);
		const runner = new HarnessRunner(options);
		await runner.prepare("op-1", { sessionId: interruptedTurn.sessionId, resume: false });
		const running = runner.run(interruptedTurn, 60_000);
		await new Promise((resolve) => setTimeout(resolve, 10));
		await runner.abort();
		expect(await running).toMatchObject({ status: "unanswered", reason: "aborted", sessionId: "16de5c1a-4022-7ca5-0d04-fab0919b1e65", sessionCostUsd: 0.000714 });
		expect(commands.find((command) => command.cmd[0] === "pkill")!.cmd).toEqual(["pkill", "-INT", "-f", `${dir}/out`]);
		expect(log).toEqual(["vibe", "signal -INT", `remove ${dir}`]);
	});

	it("ends without a result when what Vibe left can't be read, keeping the transcript", async () => {
		const { workspace, log } = scripted(() => prints(vibeLines("turn")));
		const broken = { ...workspace, exec: workspace.exec, readFile: async () => Promise.reject(new Error("connection reset")) } as unknown as Workspace;
		const { options, events } = vibeDeps(broken, log);
		const result = await (await prepared(options)).run(VIBE_TURN, 60_000);
		expect(result).toMatchObject({ status: "unanswered", reason: "harness_error", detail: "Mistral Vibe exited 0 without a result", sessionId: VIBE_SESSION, sessionCostUsd: null });
		expect(events.filter((event) => event.type === "assistant")).toHaveLength(7);
	});
});

describe("a run signed in with an API key", () => {
	// The CLI here is Claude Code's script under the name and sign-in of a harness with an API key: what is checked is
	// what the runner does with the key, whatever the CLI. Amp's own runs are below.
	const KEY = "sgamp_user_TESTKEY0123456789abcdefXYZ";
	const harness: CliHarness = { ...claudeCode, id: "amp", name: "Amp", login: undefined, apiKeyEnv: "AMP_API_KEY" };
	const auth: HarnessAuth = { mode: "env", env: { AMP_API_KEY: KEY }, secrets: [KEY] };

	it("hands the key to the CLI in its environment alone, restores and locks nothing, and takes it out of all the CLI printed", async () => {
		// The CLI printed the key in its text, a test's output, a retry and a refusal.
		const leaky = lines("turn").map((line) =>
			line
				.replaceAll("tests first.", `tests first with ${KEY}.`)
				.replace("Duration  412ms", `Duration  412ms ${KEY}`)
				.replace('"error": "overloaded"', `"error": "overloaded for ${KEY}"`)
				.replace("Permission to use WebFetch", `Permission for ${KEY} to use WebFetch`),
		);
		const { workspace, commands, log } = scripted(() => prints(leaky));
		const { options, records, events, tests } = deps(workspace, log, { harness, auth });
		const runner = await prepared(options);
		const result = await runner.run(TURN, 60_000);
		expect(result.status).toBe("done");
		expect(log).toEqual(["claude"]);
		// The key is in the CLI's environment, never on its command line, which `ps` shows.
		expect(commands[0]!.options.env).toMatchObject({ AMP_API_KEY: KEY, HOME: "/workspace" });
		expect(commands[0]!.options.env).not.toHaveProperty("CLAUDE_CONFIG_DIR");
		expect(JSON.stringify(commands.map((command) => command.cmd))).not.toContain(KEY);
		// Nothing the CLI printed reaches the thread with the key in it: not its transcript, log, test runs, result or records.
		const handed = JSON.stringify({ events, tests, records, result });
		expect(handed).not.toContain(KEY);
		expect(handed).not.toContain("TESTKEY");
		expect(events.find((event) => event.type === "delta" && event.text.startsWith("tests first"))).toEqual({ type: "delta", kind: "text", text: "tests first with [redacted]." });
		expect(events.find((event) => event.type === "retry")).toMatchObject({ error: "overloaded for [redacted]" });
		expect(events.find((event) => event.type === "permission_denied")).toMatchObject({ message: expect.stringContaining("Permission for [redacted] to use") });
		expect(tests[0]!.output).toContain("412ms [redacted]");
		expect(records.every((record) => record === null || (record.restored === null && !record.locked))).toBe(true);
	});

	it("takes the key out of the CLI's error output too, though it came in pieces", async () => {
		const { workspace, log } = scripted(async function* () {
			yield { type: "stderr", data: `Error: invalid key ${KEY.slice(0, 10)}` };
			yield { type: "stderr", data: `${KEY.slice(10)} was refused\n` };
			yield { type: "exit", code: 1 };
		});
		const { options } = deps(workspace, log, { harness, auth });
		const result = await (await prepared(options)).run(TURN, 60_000);
		expect(result).toMatchObject({ status: "unanswered", reason: "harness_error", detail: "Amp exited 1 without a result: Error: invalid key [redacted] was refused" });
		expect(JSON.stringify(result)).not.toContain("TESTKEY");
	});

	it("waits for the person's key when they have given none, touching nothing", async () => {
		const { workspace, commands, log } = scripted(() => prints(lines("turn")));
		const { options, records } = deps(workspace, log, { harness, auth: { mode: "signed_out" } });
		expect(await new HarnessRunner(options).prepare("op-1", { sessionId: SESSION, resume: false })).toEqual({ status: "login_required" });
		expect(commands).toEqual([]);
		expect(log).toEqual([]);
		expect(records).toEqual([]);
	});

	it("is how `authEnv` signs in a harness that declares its key's variable, with the person's key or none", async () => {
		const thread = {} as CodingThreadRow;
		const asked: string[] = [];
		const keys = async (id: string) => {
			asked.push(id);
			return id === "amp" ? KEY : null;
		};
		expect(await authEnv(thread, claudeCode, keys)).toEqual({ mode: "subscription" });
		expect(await authEnv(thread, codex, keys)).toEqual({ mode: "subscription" });
		expect(await authEnv(thread, amp, keys)).toEqual({ mode: "env", env: { AMP_API_KEY: KEY }, secrets: [KEY] });
		expect(await authEnv(thread, mistralVibe, keys)).toEqual({ mode: "signed_out" });
		expect(asked).toEqual(["amp", "mistral-vibe"]);
	});

	it("lists Amp and Mistral Vibe among the CLI harnesses, with the variable and hosts each needs", () => {
		expect(cliHarness("amp")).toBe(amp);
		expect(cliHarness("mistral-vibe")).toBe(mistralVibe);
		expect(amp).toMatchObject({ name: "Amp", apiKeyEnv: "AMP_API_KEY", egress: ["ampcode.com", "*.ampcode.com"] });
		expect(mistralVibe).toMatchObject({ name: "Mistral Vibe", apiKeyEnv: "MISTRAL_API_KEY", egress: ["api.mistral.ai"] });
		expect(amp.login).toBeUndefined();
		expect(mistralVibe.login).toBeUndefined();
	});
});

describe("Amp's stream-json", () => {
	const read = (text: string, parser = amp.parser(TURN)) => text.split("\n").flatMap((line) => parser.parseLine(line));

	it("is read into the thread, the transcript's messages with their tools, a failed background subagent, a refusal and the result", () => {
		const events = read(ampFixture("turn.jsonl"), amp.parser({ ...TURN, model: "high" }));
		expect(events.filter((event) => event.type === "unparsed")).toEqual([]);
		// The session is Amp's thread, and the model the mode Amp says it runs.
		expect(events[0]).toEqual({ type: "session", sessionId: AMP_SESSION, model: "high" });
		// Amp prints messages whole: nothing as it is written.
		expect(events.some((event) => event.type === "delta")).toBe(false);
		const messages = events.flatMap((event) => (event.type === "assistant" || event.type === "tool_result" ? [event.message] : []));
		expect(messages.map((message) => (message.role === "assistant" ? message.content.map((part) => (part.type === "toolCall" ? part.name : part.type)) : [`result:${message.toolName}`]))).toEqual([
			["text", "shell_command"],
			["result:shell_command"],
			["edit_file"],
			["result:edit_file"],
			// The subagent's own call and result aren't the thread's; what it found comes back as the Task call's result.
			["Task"],
			["result:Task"],
			["Task"],
			["result:Task"],
			["shell_command"],
			["result:shell_command"],
			["text"],
		]);
		const first = events.find((event): event is Extract<HarnessEvent, { type: "assistant" }> => event.type === "assistant")!;
		expect(first.message.content[1]).toEqual({ type: "toolCall", id: "toolu_01Shell", name: "shell_command", arguments: { command: "npm test" } });
		// Its tokens as Amp counted them, with no message id: each line is a model response of its own.
		expect(first).toMatchObject({ messageId: null, message: { provider: "amp", model: "high", stopReason: "toolUse", usage: { input: 10, output: 99, cacheRead: 0, cacheWrite: 16256 } } });
		expect(messages[1]).toMatchObject({ toolCallId: "toolu_01Shell", isError: true, content: [{ type: "text", text: expect.stringContaining("Tests  1 failed | 3 passed (4)") }] });
		expect(events.filter((event) => event.type === "notice")).toEqual([{ type: "notice", message: "A background subagent (toolu_01Bg) failed" }]);
		expect(events.filter((event) => event.type === "permission_denied")).toEqual([{ type: "permission_denied", tool: "shell_command", message: "" }]);
		// Amp reports tokens, never dollars.
		expect(events.at(-1)).toEqual({ type: "result", ok: true, reason: null, sessionId: AMP_SESSION, sessionCostUsd: null, text: "Fixed `greet` to include the name; the greeting test passes now.", errors: [] });
		expect(events.some((event) => event.type === "auth_failed")).toBe(false);
	});

	it("says why a run failed: its most turns, an error with no result after it, credits, and a refused token", () => {
		expect(read(ampFixture("max-turns.jsonl")).at(-1)).toMatchObject({ type: "result", ok: false, reason: "max_turns", sessionCostUsd: null, errors: ["Reached the maximum number of turns"] });
		expect(read(ampFixture("failed.jsonl")).at(-1)).toEqual({ type: "result", ok: false, reason: "error", sessionId: AMP_SESSION, sessionCostUsd: null, text: null, errors: ["Model provider returned an error: overloaded"] });
		const credits = read(ampFixture("credits.jsonl"));
		expect(credits.at(-1)).toMatchObject({ ok: false, reason: "error", errors: ["You are out of credits. Add paid credits or choose a paid tier."] });
		expect(credits.some((event) => event.type === "auth_failed")).toBe(false);
		// The CLI's own words for a refused token, in a failed result rather than on its error output.
		const refused = `{"type":"result","subtype":"error_during_execution","is_error":true,"num_turns":0,"error":"${ampLines("login.stderr")[0]}","session_id":"${AMP_SESSION}"}`;
		expect(read(refused).map((event) => event.type)).toEqual(["auth_failed", "result"]);
	});
});

describe("Amp's command line", () => {
	const NEW = "5d3c7a9e-1b2f-4c6d-8e0a-9f1b2c3d4e5f";
	const help = ampFixture("help.txt");

	it("starts a private thread in execute mode with stream-json, Pim's instructions opening its first message, and nothing past the workspace", () => {
		const cmd = amp.buildCommand({ ...TURN, sessionId: NEW });
		expect(cmd).toEqual([
			"sh",
			"-c",
			'mkdir -p "$TMPDIR" && exec "$@"',
			"amp",
			"amp",
			"--stream-json",
			"--no-ide",
			"--no-notifications",
			"--no-color",
			"--no-remote-control-terminal",
			"--log-file",
			`/workspace/.cache/amp/logs/pim-${NEW}.log`,
			"--visibility",
			"private",
			"--mode",
			"medium",
			`--execute=<instructions from="Pim">\nDon't push.\n</instructions>\n\nFix the greeting test`,
		]);
		// Every flag is one the pinned CLI's `amp --help` lists.
		for (const flag of [...AMP_FLAGS, "--log-file", "--visibility", "--mode", "--execute"]) expect(help).toMatch(new RegExp(`^ {2}(?:-\\w+, )?${flag}\\b`, "m"));
		expect(help).toContain("continue                           [alias: c] Continue an existing thread");
		expect(help).toContain("AMP_API_KEY");
		expect(ampLogFile(NEW)).toContain(NEW);
		// Bun unpacks its addon into the temp dir and dlopens it: not the noexec /tmp.
		expect(amp.env).toMatchObject({ TMPDIR: "/workspace/.cache/amp-tmp", BUN_TMPDIR: "/workspace/.cache/amp-tmp" });
	});

	it("goes on with Amp's thread after the first turn, asks for one of Amp's modes, and keeps a prompt that looks like a flag a prompt", () => {
		expect(amp.buildCommand({ ...TURN, sessionId: AMP_SESSION, resume: true, prompt: "--help me" })).toEqual([
			"sh",
			"-c",
			'mkdir -p "$TMPDIR" && exec "$@"',
			"amp",
			"amp",
			"threads",
			"continue",
			AMP_SESSION,
			...AMP_FLAGS,
			"--log-file",
			`/workspace/.cache/amp/logs/pim-${AMP_SESSION}.log`,
			"--execute=--help me",
		]);
		// A new thread with a mode in its profile uses that mode.
		expect(amp.buildCommand({ ...TURN, sessionId: NEW, model: "High" })).toEqual(expect.arrayContaining(["--mode", "high"]));
		// A new thread without a mode gets medium explicitly.
		expect(amp.buildCommand({ ...TURN, sessionId: NEW })).toEqual(expect.arrayContaining(["--mode", "medium"]));
		// A thread's mode is fixed when Amp makes it, so continued threads aren't given one again.
		expect(amp.buildCommand({ ...TURN, sessionId: AMP_SESSION, resume: true, model: "high" })).not.toContain("--mode");
		expect(() => amp.buildCommand({ ...TURN, model: "claude-opus-5" })).toThrow('Amp has no mode "claude-opus-5": ask for low, medium, high, ultra');
	});

	it("signs in with the token in AMP_API_KEY, needs only Amp's hosts, estimates no cost, and is signalled by the turn's id", () => {
		expect(cliHarness("amp")).toBe(amp);
		expect(amp).toMatchObject({ name: "Amp", apiKeyEnv: "AMP_API_KEY", egress: ["ampcode.com", "*.ampcode.com"], reportsCost: false, shellTool: "shell_command", env: { AMP_SKIP_UPDATE_CHECK: "1" } });
		expect(amp.login).toBeUndefined();
		expect(amp.signalCommand(NEW, "INT")).toEqual(["pkill", "-INT", "-f", NEW]);
		expect(amp.loginFailure!.test(ampFixture("login.stderr"))).toBe(true);
		expect(amp.loginFailure!.test(ampFixture("unreachable.stderr"))).toBe(false);
	});
});

describe("an Amp run", () => {
	const KEY = "sgamp_user_AMPRUNKEY0123456789abcdef";
	const auth: HarnessAuth = { mode: "env", env: { AMP_API_KEY: KEY }, secrets: [KEY] };
	const AMP_TURN: HarnessTurn = { ...TURN, sessionId: "5d3c7a9e-1b2f-4c6d-8e0a-9f1b2c3d4e5f", maxTokens: 3_000_000 };
	const ampDeps = (workspace: Workspace, log: string[]) => deps(workspace, log, { harness: amp, auth });
	const ready = async (options: RunnerDeps) => {
		const runner = new HarnessRunner(options);
		expect(await runner.prepare("op-1", { sessionId: AMP_TURN.sessionId, resume: false })).toEqual({ status: "ready" });
		return runner;
	};

	it("runs Amp in the checkout with the token in its environment alone, and reports its thread, tokens and test runs, with no cost", async () => {
		const { workspace, commands, log } = scripted(() => prints(ampLines("turn.jsonl")));
		const { options, tests, events } = ampDeps(workspace, log);
		const result = await (await ready(options)).run(AMP_TURN, 60_000);
		expect(result).toMatchObject({ status: "done", sessionId: AMP_SESSION, sessionCostUsd: null, sessionUsage: null, model: "high" });
		// Each model response's tokens, the subagent's left out as its messages are.
		expect(result.usage).toEqual({ input: 45, output: 477, cacheRead: 84518, cacheWrite: 17323 });
		// No login restored or written back, and no lock: only Amp ran.
		expect(log).toEqual(["amp"]);
		expect(commands[0]!.cmd).toEqual(amp.buildCommand(AMP_TURN));
		expect(commands[0]!.options).toMatchObject({ cwd: "/workspace/repo", env: { HOME: "/workspace", AMP_API_KEY: KEY, AMP_SKIP_UPDATE_CHECK: "1" } });
		expect(JSON.stringify(commands.map((command) => command.cmd))).not.toContain(KEY);
		expect(tests).toEqual([
			expect.objectContaining({ command: "npm test", exitCode: 1, summary: { format: "vitest", passed: 3, failed: 1, skipped: 0, total: 4 } }),
			expect.objectContaining({ command: "npm test", exitCode: 0, summary: { format: "vitest", passed: 4, failed: 0, skipped: 0, total: 4 } }),
		]);
		expect(events.find((event) => event.type === "permission_denied")).toMatchObject({ tool: "shell_command" });
	});

	it("never reports a turn as done without a successful result: a refused token, no server, no credits, its most turns, an error", async () => {
		const stderr = (name: "login.stderr" | "unreachable.stderr") =>
			async function* (): AsyncGenerator<ExecEvent> {
				// As the real CLI did: nothing on its output, its error on the error output, exit 1.
				yield { type: "stderr", data: ampFixture(name) };
				yield { type: "exit", code: 1 };
			};
		const cases: [Script, Partial<Awaited<ReturnType<HarnessRunner["run"]>>>][] = [
			[stderr("login.stderr"), { status: "unanswered", reason: "login_required", detail: "Amp isn't signed in: connect it again", sessionId: null }],
			[stderr("unreachable.stderr"), { status: "unanswered", reason: "harness_error", detail: expect.stringMatching(/^Amp exited 1 without a result: Error: Couldn't connect to the Amp server at https:\/\/unreachable\.invalid\./) }],
			[() => prints(ampLines("credits.jsonl"), 1), { status: "unanswered", reason: "harness_error", detail: "Amp usage limit reached: You are out of credits. Add paid credits or choose a paid tier." }],
			[() => prints(ampLines("max-turns.jsonl"), 1), { status: "unanswered", reason: "max_turns", sessionId: AMP_SESSION }],
			[() => prints(ampLines("failed.jsonl"), 1), { status: "unanswered", reason: "harness_error", detail: "Model provider returned an error: overloaded" }],
			[() => prints(ampLines("turn.jsonl").slice(0, -1), 0), { status: "unanswered", reason: "harness_error", detail: "Amp exited 0 without a result" }],
		];
		for (const [script, expected] of cases) {
			const { workspace, log } = scripted(script);
			expect(await (await ready(ampDeps(workspace, log).options)).run(AMP_TURN, 60_000)).toMatchObject(expected);
		}
	});

	it("is stopped with SIGINT, by the id on its command line, once its tokens reach what is left of the thread's ceiling", async () => {
		const { workspace, log, commands, signals } = scripted(async function* (options, signals) {
			// The first model response's 16,365 tokens, then the CLI waits, as one mid-turn does.
			for (const line of ampLines("turn.jsonl").slice(0, 3)) yield { type: "stdout", data: `${line}\n` };
			await signals.wait("INT", options.signal);
			yield { type: "exit", code: 130 };
		});
		const result = await (await ready(ampDeps(workspace, log).options)).run({ ...AMP_TURN, maxTokens: 16_000 }, 60_000);
		expect(result).toMatchObject({ status: "unanswered", reason: "budget", sessionId: AMP_SESSION, usage: { input: 10, output: 99, cacheRead: 0, cacheWrite: 16256 } });
		expect(commands.find((command) => command.cmd[0] === "pkill")!.cmd).toEqual(["pkill", "-INT", "-f", AMP_TURN.sessionId]);
		expect(commands[0]!.cmd.join(" ")).toContain(AMP_TURN.sessionId);
		expect(signals.sent).toEqual(["INT"]);
	});
});
