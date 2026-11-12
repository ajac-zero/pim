import type { CodingHarness } from "../thread-store";
import { claudeCode } from "./claude-code";
import { codex } from "./codex";
import type { CliHarness } from "./types";
import { mistralVibe } from "./vibe";

/**
 * The CLI harnesses coding threads can run (./types.ts), by the thread's
 * `harness`. Pi isn't one: it is Pim's own agent loop (../thread-do.ts).
 */
export const CLI_HARNESSES: Partial<Record<CodingHarness, CliHarness>> = { "claude-code": claudeCode, codex, "mistral-vibe": mistralVibe };

/** The CLI harness that runs a thread, or null for Pi. */
export function cliHarness(harness: CodingHarness): CliHarness | null {
	return CLI_HARNESSES[harness] ?? null;
}

export type { CliHarness, HarnessEvent, HarnessTurn } from "./types";
