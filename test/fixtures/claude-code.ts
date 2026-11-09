// Claude Code's stream-json, as `claude -p --output-format stream-json --verbose --include-partial-messages` prints it,
// written from its documented schema (https://code.claude.com/docs/en/agent-sdk/typescript, "Message Types"):
// `turn` is a whole turn with thinking, text, tools, a subagent, a retry, a refusal and its result; `budget` stops at
// `--max-budget-usd`. `login` is real: what Claude Code 2.1.311 printed when run with Pim's flags and no login.

// Vite reads the fixtures as text when it builds the test.
declare global {
	interface ImportMeta {
		glob(patterns: string[], options: { query: "?raw"; import: "default"; eager: true }): Record<string, string>;
	}
}

const files = import.meta.glob(["./claude-code/*.jsonl"], { query: "?raw", import: "default", eager: true });

/** A fixture's text. */
export const claudeFixture = (name: "turn" | "budget" | "login") => files[`./claude-code/${name}.jsonl`]!;

/** A fixture's lines. */
export const claudeLines = (name: "turn" | "budget" | "login") => claudeFixture(name).trimEnd().split("\n");

/** The session every fixture is of. */
export const CLAUDE_SESSION = "0b7f4c52-9a1e-4d3b-8c2f-5e6a7b8c9d01";
