// What `codex exec --json` prints, for the Codex harness (src/coding/harness/codex.ts). `login` and `expired` are real:
// what Codex 0.167.0 printed with Pim's flags (docs/coding-codex.md) and no login, and with a ChatGPT login whose
// refresh token OpenAI refused. `turn` and `failed` are written from its documented schema, `ThreadEvent` in
// codex-rs/exec/src/exec_events.rs at rust-v0.167.0: `turn` is a whole turn with a notice, a retry, reasoning, a plan, a
// failing and a passing test run, a file change, an MCP tool call, a web search, its answer and its usage; `failed` ends
// in an error that isn't the login's.

// Vite reads the fixtures as text when it builds the test.
declare global {
	interface ImportMeta {
		glob(patterns: string[], options: { query: "?raw"; import: "default"; eager: true }): Record<string, string>;
	}
}

const files = import.meta.glob(["./codex/*.jsonl"], { query: "?raw", import: "default", eager: true });

type Name = "turn" | "failed" | "login" | "expired";

/** A fixture's text. */
export const codexFixture = (name: Name) => files[`./codex/${name}.jsonl`]!;

/** A fixture's lines. */
export const codexLines = (name: Name) => codexFixture(name).trimEnd().split("\n");

/** The session `turn` and `failed` are of. */
export const CODEX_SESSION = "019a5f3e-7c21-7d40-9b8e-2f4a6c8d0e12";
