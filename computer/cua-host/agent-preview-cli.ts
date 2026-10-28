/**
 * The entry point for the first read-only diagnosis of an agent-driven
 * preview (docs/agent-preview.md):
 *
 *   node agent-preview-cli.ts --origin <https origin> --config-file <absolute path> \
 *     --deadline <ISO time, the evaluation's> --playwright-dir <runtime directory> \
 *     [--browser-channel chrome]
 *
 * Nothing secret is an argument: the credential is a field of the protected
 * configuration file (agent-preview-automation.ts), and `--origin` must equal
 * the file's own, so a file for another preview is refused. It prints one JSON
 * line of metadata (`agent-preview.diagnosis`) and exits 0, or prints one
 * fixed failure line to standard error and exits 1; wrong arguments print the
 * usage and exit 2. It never prints a path, a response body, a cookie or the
 * credential. It does one thing, `diagnoseObservations`: it lists the
 * observations and loads `/`, and starts, ends and sets up nothing.
 */

import { parseArgs } from "node:util";
import { AgentPreviewError, type BrowserLauncher, diagnoseObservations, openAgentPreview, playwrightChromium } from "./agent-preview.ts";
import { parseAutomationConfig } from "./agent-preview-automation.ts";

export const USAGE = "usage: agent-preview-cli --origin <https origin> --config-file <absolute path> --deadline <ISO time> --playwright-dir <absolute path> [--browser-channel chrome]";

export interface Streams {
	out(line: string): void;
	err(line: string): void;
}

/** Runs the diagnosis and returns the exit code. `launcher` is only for tests; otherwise Playwright from `--playwright-dir`. */
export async function run(argv: readonly string[], streams: Streams, launcher?: BrowserLauncher): Promise<number> {
	let values: Record<string, string | undefined>;
	try {
		({ values } = parseArgs({ args: [...argv], options: { origin: { type: "string" }, "config-file": { type: "string" }, deadline: { type: "string" }, "playwright-dir": { type: "string" }, "browser-channel": { type: "string" } }, strict: true }));
	} catch {
		streams.err(USAGE);
		return 2;
	}
	const deadline = Date.parse(values.deadline ?? "");
	if (!values.origin || !values["config-file"] || !values["playwright-dir"] || !Number.isFinite(deadline) || Date.now() >= deadline) {
		streams.err(USAGE);
		return 2;
	}
	// Only the exact word "chrome" selects the system Chrome; anything else, even an empty value, is refused before a browser is considered.
	const channel = values["browser-channel"];
	if (channel !== undefined && channel !== "chrome") {
		streams.err(USAGE);
		return 2;
	}
	const expected = values.origin;
	try {
		const session = await openAgentPreview({
			configFile: values["config-file"],
			parse: (text) => {
				const parsed = parseAutomationConfig(text);
				if (parsed.origin !== expected) throw new AgentPreviewError("config", "The configuration file is for another origin.");
				return parsed;
			},
			deadline,
			launcher: launcher ?? playwrightChromium(values["playwright-dir"], channel),
		});
		const meta = session.metadata();
		const result = await diagnoseObservations(session);
		streams.out(JSON.stringify({ event: "agent-preview.diagnosis", session: meta, ...result }));
		return 0;
	} catch (error) {
		const known = error instanceof AgentPreviewError;
		streams.err(JSON.stringify({ event: "agent-preview.failed", code: known ? error.code : "harness", status: known ? (error.status ?? null) : null, message: known ? error.message : "The harness failed." }));
		return 1;
	}
}

if (import.meta.main) {
	process.exitCode = await run(process.argv.slice(2), { out: (line) => console.log(line), err: (line) => console.error(line) });
}
