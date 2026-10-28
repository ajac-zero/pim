/**
 * The entry point for the one-use launch evaluator (docs/launch-evaluator.md):
 *
 *   node launch-evaluator-cli.ts --origin <Pim's https origin> --viewer-origin <the bridge's https origin> \
 *     --config-file <absolute path> --deadline <ISO time, the evaluation's> \
 *     --playwright-dir <runtime directory> [--browser-channel chrome]
 *
 * It is a separate command from agent-preview-cli.ts, which stays read only.
 * Nothing secret is an argument, and no argument names an observation: the
 * only observation it touches is the one its launch creates. Every option is
 * given at most once, and there is no other: no executable path, launch
 * argument, profile, storage state or CDP endpoint. It prints one JSON line
 * (`launch-evaluator.result`) and exits 0 only when the viewer qualified and
 * its End was accepted, 1 for any other outcome or a failure before the launch
 * (one fixed line on standard error), and 2 with the usage for wrong arguments.
 * Nothing is retried, and running it again launches nothing: the Worker spends
 * the grant at the first launch.
 */

import { parseArgs } from "node:util";
import { AgentPreviewError } from "./agent-preview.ts";
import { evaluateLaunch, evaluatorChromium, type EvaluatorLauncher } from "./launch-evaluator.ts";

export const USAGE =
	"usage: launch-evaluator-cli --origin <https origin> --viewer-origin <https origin> --config-file <absolute path> --deadline <ISO time> --playwright-dir <absolute path> [--browser-channel chrome]";

export interface Streams {
	out(line: string): void;
	err(line: string): void;
}

const OPTIONS = { origin: { type: "string" }, "viewer-origin": { type: "string" }, "config-file": { type: "string" }, deadline: { type: "string" }, "playwright-dir": { type: "string" }, "browser-channel": { type: "string" } } as const;

/** Runs the evaluation and returns the exit code. `launcher` is only for tests; otherwise Playwright from `--playwright-dir`. */
export async function run(argv: readonly string[], streams: Streams, launcher?: EvaluatorLauncher, observeMs?: number): Promise<number> {
	let values: Record<string, string | undefined>;
	try {
		const parsed = parseArgs({ args: [...argv], options: OPTIONS, strict: true, allowPositionals: false, tokens: true });
		// parseArgs keeps only the last of a repeated option, so any repeat is refused here rather than silently resolved.
		const names = parsed.tokens.filter((token) => token.kind === "option").map((token) => token.name);
		if (new Set(names).size !== names.length) throw new Error("repeated");
		values = parsed.values;
	} catch {
		streams.err(USAGE);
		return 2;
	}
	const deadline = Date.parse(values.deadline ?? "");
	const channel = values["browser-channel"];
	// Only the exact word "chrome" selects the system Chrome; anything else, even an empty value, is refused before a browser is considered.
	if (!values.origin || !values["viewer-origin"] || !values["config-file"] || !values["playwright-dir"] || !Number.isFinite(deadline) || Date.now() >= deadline || (channel !== undefined && channel !== "chrome")) {
		streams.err(USAGE);
		return 2;
	}
	try {
		const report = await evaluateLaunch({
			configFile: values["config-file"],
			origin: values.origin,
			viewerOrigin: values["viewer-origin"],
			deadline,
			launcher: launcher ?? evaluatorChromium(values["playwright-dir"], channel),
			...(observeMs === undefined ? {} : { observeMs }),
		});
		streams.out(JSON.stringify({ event: "launch-evaluator.result", ...report }));
		return report.outcome === "qualified" ? 0 : 1;
	} catch (error) {
		const known = error instanceof AgentPreviewError;
		streams.err(JSON.stringify({ event: "launch-evaluator.failed", code: known ? error.code : "harness", message: known ? error.message : "The evaluator failed; nothing is retried." }));
		return 1;
	}
}

if (import.meta.main) {
	process.exitCode = await run(process.argv.slice(2), { out: (line) => console.log(line), err: (line) => console.error(line) });
}
