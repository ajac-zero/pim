import type { CodingHarness } from "../thread-store";
import { claudeCode } from "./claude-code";
import type { CliHarness } from "./types";

/**
 * The CLI harnesses coding threads can run (./types.ts), by the thread's
 * `harness`. Pi isn't one: it is Pim's own agent loop (../thread-do.ts).
 * Codex isn't here until its adapter is.
 */
export const CLI_HARNESSES: Partial<Record<CodingHarness, CliHarness>> = { "claude-code": claudeCode };

/** The CLI harness that runs a thread, or null for Pi or one without an adapter yet. */
export function cliHarness(harness: CodingHarness): CliHarness | null {
	return CLI_HARNESSES[harness] ?? null;
}

export type { CliHarness, HarnessEvent, HarnessTurn } from "./types";
