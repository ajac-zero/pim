// What Amp's CLI (`@ampcode/cli` 0.0.1794240032-ga42e06) prints, for the Amp harness (src/coding/harness/amp.ts).
//
// Captured from the real CLI, in the workspace image built from this repository, without a valid key:
// - `help.txt`: `amp --help`, with HOME=/workspace.
// - `login.stderr`: what `amp … --execute=…` printed on its error output, and nothing on its output, exiting 1, with a
//   fake `AMP_API_KEY` that the server (a local stand-in answering 401) refused.
// - `unreachable.stderr`: the same, exiting 1, when it couldn't reach its server.
//
// Documented, not captured (no Amp key in CI): written from Amp's documented stream-json schema
// (https://ampcode.com/docs/cli/streaming-json), with the tools `amp tools list` of the pinned CLI names.
// - `turn.jsonl`: a whole turn, with a failing and a passing test run, an edit, a subagent and its own messages, a
//   background subagent that failed, the answer and a refused call.
// - `orb-start.jsonl`: the same shape, a start of an Amp Orb thread (`-ox`) as the orb client reads it
//   (src/coding/orb/amp-cli.ts): the person's words, the agent's, a subagent's that stay out, and the result.
// - `max-turns.jsonl`: a run that reached Amp's most turns (`error_max_turns`).
// - `failed.jsonl`: an error printed as a `system` message, with no result after it.
// - `credits.jsonl`: a run refused for want of credits, its text one the CLI holds ("You are out of credits…").

// Vite reads the fixtures as text when it builds the test.
declare global {
	interface ImportMeta {
		glob(patterns: string[], options: { query: "?raw"; import: "default"; eager: true }): Record<string, string>;
	}
}

const files = import.meta.glob(["./amp/*"], { query: "?raw", import: "default", eager: true });

type Name = "turn.jsonl" | "orb-start.jsonl" | "max-turns.jsonl" | "failed.jsonl" | "credits.jsonl" | "login.stderr" | "unreachable.stderr" | "help.txt";

/** A fixture's text. */
export const ampFixture = (name: Name) => files[`./amp/${name}`]!;

/** A fixture's lines. */
export const ampLines = (name: Name) => ampFixture(name).trimEnd().split("\n");

/** The Amp thread the stream-json fixtures are of. */
export const AMP_SESSION = "T-3f9a2c71-8b4e-4d1a-9c6f-5e2b7a8d0c14";
