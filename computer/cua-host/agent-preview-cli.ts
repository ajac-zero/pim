/**
 * The entry point for the first read-only diagnosis of an agent-driven
 * preview (docs/agent-preview.md):
 *
 *   --origin <https origin>  --credential-file <absolute path>
 *   --deadline <ISO time, the evaluation's>  --playwright-dir <runtime directory>
 *
 * Nothing secret is an argument: the credential is in the protected file.
 * It prints one JSON line of metadata (`agent-preview.diagnosis`) and exits 0,
 * or prints one fixed failure line to standard error and exits 1; wrong
 * arguments print the usage and exit 2. It never prints a path, a response
 * body, a cookie or the credential. It does one thing, `diagnoseObservations`:
 * it lists the observations and loads `/`, and starts nothing.
 *
 * The exchange adapter is the auth branch's, so `run` takes it as a parameter.
 * The executable wrapper that passes the real adapter is added with that
 * contract; until then nothing can run this against a preview.
 */

import { parseArgs } from "node:util";
import { AgentPreviewError, type BrowserLauncher, diagnoseObservations, type ExchangeAdapter, openAgentPreview, playwrightChromium } from "./agent-preview.ts";

export const USAGE = "usage: agent-preview --origin <https origin> --credential-file <absolute path> --deadline <ISO time> --playwright-dir <absolute path>";

export interface Streams {
	out(line: string): void;
	err(line: string): void;
}

/** Runs the diagnosis and returns the exit code. `launcher` is only for tests; otherwise Playwright from `--playwright-dir`. */
export async function run(argv: readonly string[], adapter: ExchangeAdapter, streams: Streams, launcher?: BrowserLauncher): Promise<number> {
	let values: Record<string, string | undefined>;
	try {
		({ values } = parseArgs({ args: [...argv], options: { origin: { type: "string" }, "credential-file": { type: "string" }, deadline: { type: "string" }, "playwright-dir": { type: "string" } }, strict: true }));
	} catch {
		streams.err(USAGE);
		return 2;
	}
	const deadline = Date.parse(values.deadline ?? "");
	if (!values.origin || !values["credential-file"] || !values["playwright-dir"] || !Number.isFinite(deadline) || Date.now() >= deadline) {
		streams.err(USAGE);
		return 2;
	}
	try {
		const session = await openAgentPreview({ origin: values.origin, credentialFile: values["credential-file"], adapter, deadline, launcher: launcher ?? playwrightChromium(values["playwright-dir"]) });
		const meta = session.metadata();
		const result = await diagnoseObservations(session);
		streams.out(JSON.stringify({ event: "agent-preview.diagnosis", session: meta, ...result }));
		return 0;
	} catch (error) {
		const known = error instanceof AgentPreviewError;
		streams.err(JSON.stringify({ event: "agent-preview.failed", code: known ? error.code : "harness", status: known ? error.status ?? null : null, message: known ? error.message : "The harness failed." }));
		return 1;
	}
}
