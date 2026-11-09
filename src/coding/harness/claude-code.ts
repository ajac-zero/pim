import { StreamJsonParser } from "./stream-json";
import type { CliHarness, HarnessTurn } from "./types";

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

/** A failed run's result that says the CLI isn't signed in, as it prints it ("Invalid API key · Please run /login", "Not logged in"). */
const LOGIN_RESULT = /please run \/login|not logged in|invalid api key|oauth token has expired/i;

/** Reads Claude Code's stream-json (./stream-json.ts). */
export class ClaudeStreamParser extends StreamJsonParser {
	constructor() {
		super({ provider: "claude-code", model: "claude", loginFailure: LOGIN_RESULT });
	}
}
