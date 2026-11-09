// What Mistral Vibe 3.1.0 printed with `--output streaming` (`*.jsonl`) and wrote to `export.json` (`*.export.json`),
// for the Vibe harness (src/coding/harness/vibe.ts). All are real: the real `vibe` in the workspace image, run by Pim's
// runner with its command line, against a mock of Mistral's chat completions API, except `auth`, which is the real
// api.mistral.ai refusing a made-up key. Only the mock's scenario markers were taken out of the prompts, and each
// export's `config` was cut down to the models; `turn.meta.json` is the `config` of the copy of the session's journal
// the export points to. (docs/coding-vibe.md says how they were made.)
//
// - `turn`: a new session that thinks, says what it will do, runs a failing `npm test`, greps (which Vibe shows as a
//   search), edits a file, runs the tests again, passing, and answers.
// - `resume`: the next turn of that session: only the new run is printed, and the export counts that run alone.
// - `denied`: the same command without `--auto-approve`, which Pim never runs: Vibe refuses the shell command itself.
// - `price`: stopped by `--max-price` after the first answer, its tool call cancelled.
// - `error`: the API refused the request (`infrastructure_failure`).
// - `interrupted`: SIGINT, as Pim's `signalCommand` sends it, during a shell command.
// - `missing`: `--resume` of a session Vibe doesn't have; it printed nothing.
// - `auth`: a key Mistral refused.

// Vite reads the fixtures as text when it builds the test.
declare global {
	interface ImportMeta {
		glob(patterns: string[], options: { query: "?raw"; import: "default"; eager: true }): Record<string, string>;
	}
}

const files = import.meta.glob(["./vibe/*.jsonl", "./vibe/*.json"], { query: "?raw", import: "default", eager: true });

type Run = "turn" | "resume" | "denied" | "price" | "error" | "interrupted" | "missing" | "auth";

/** What a run printed: nothing for `missing`. */
export const vibeOutput = (name: Run) => files[`./vibe/${name}.jsonl`] ?? "";

/** What a run printed, a line each. */
export const vibeLines = (name: Run) => vibeOutput(name).split("\n").filter(Boolean);

/** A run's export.json. */
export const vibeExport = (name: Run) => files[`./vibe/${name}.export.json`]!;

/** The journal's meta.json of `turn`'s session. */
export const VIBE_META = files["./vibe/turn.meta.json"]!;

/** The session `turn` and `resume` are of. */
export const VIBE_SESSION = "aa2bb910-a052-d3c0-f50e-e44caccb6d0e";
