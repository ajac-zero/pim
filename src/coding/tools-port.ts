import type { JsonValue } from "@earendil-works/pi-ai";
import type { ToolRegistration } from "@earendil-works/pi-durable";
import type { Workspace } from "./workspace/types";

/**
 * Where a coding thread's Durable Object (./thread-do.ts) meets the tools its
 * model is offered. The tools themselves (`createCodingTools` in
 * ./tools/) are built separately; until they land, this file declares the
 * signature the thread calls and a stub that offers no tools, so the thread
 * builds and runs with any model. Integration swaps the stub's import for
 * the real one and deletes it.
 */

/** How one tool call ended, as the journal keeps it. */
export type ToolJournalOutcome = { readonly status: "ok" | "error"; readonly result: JsonValue };

/** A tool call the journal knows of. `outcome` is absent while it hasn't ended, such as when an eviction cut it off. */
export type ToolJournalEntry = {
	readonly callId: string;
	readonly tool: string;
	readonly args: JsonValue;
	readonly startedAt: number;
	readonly outcome?: ToolJournalOutcome;
	readonly endedAt?: number;
};

/**
 * Each tool call's intent and outcome, kept by the thread in its own
 * database (`coding_tool_journal`). A tool records a call before it touches
 * the workspace and its outcome once it ends, so after an eviction a rerun
 * of the same call (by pi's call id) can find what it already did instead of
 * doing it twice.
 */
export interface ToolJournal {
	/** The call, if it was recorded before. */
	get(callId: string): ToolJournalEntry | null;
	/** Records that a call starts. Recording a call already recorded changes nothing. */
	begin(callId: string, tool: string, args: JsonValue): void;
	/** Records how a call ended. */
	end(callId: string, outcome: ToolJournalOutcome): void;
}

/** One run of the repository's tests, as a tool reports it. Counts are absent when the runner's output didn't say. */
export type TestRunReport = {
	readonly command: string;
	readonly exitCode: number | null;
	readonly passed?: number;
	readonly failed?: number;
	readonly durationMs: number;
	/** The end of the output, for the person to read; capped by the tool. */
	readonly summary: string;
};

export type CodingToolsDeps = {
	/** The thread's workspace, made and cloned on first use. Its `exec` is killed when the thread is aborted. */
	readonly workspace: () => Promise<Workspace>;
	readonly journal: ToolJournal;
	/** Told of each test run, which the thread keeps for `tests()`. */
	readonly onTestRun?: (run: TestRunReport) => void | Promise<void>;
};

/** The model-facing tools of a coding thread. A stub: it offers none until the real tools replace it. */
export function createCodingTools(_deps: CodingToolsDeps): ToolRegistration[] {
	return [];
}
