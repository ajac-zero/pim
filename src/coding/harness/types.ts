import type { AssistantMessage, ToolResultMessage } from "@earendil-works/pi-ai";
import type { Harness } from "../vault/harnesses";

/**
 * The contract between a coding thread and a vendor's coding agent CLI that
 * runs inside the thread's workspace (a "CLI harness"), such as Claude Code.
 * The CLI is the vendor's own, unmodified: Pim only builds its command line,
 * reads what it prints, line by line, and maps that into the thread's
 * transcript, log and test runs (./runner.ts, ../thread-do.ts).
 */

/** What one turn asks of the CLI. */
export type HarnessTurn = {
	/** What the person (or the thread's start) said: the turn's prompt. */
	readonly prompt: string;
	/** The CLI's session to go on with (`--resume`), or the new one this turn starts (`resume: false`). */
	readonly sessionId: string;
	readonly resume: boolean;
	/** The most the turn may spend, in dollars, as the CLI estimates it: the thread's budget left. Null when the thread has no budget, and for a CLI that estimates no cost, which can't be held to one. */
	readonly maxBudgetUsd: number | null;
	/** The model to ask for, or null for the CLI's own default. */
	readonly model: string | null;
	/** Text appended to the CLI's own system prompt: what Pim tells every coding agent. */
	readonly instructions: string;
	/**
	 * What the session cost, and the tokens it used, before this turn, as the
	 * thread recorded them; nothing for a new session. A CLI that reports only
	 * what one run cost and used (Mistral Vibe) adds its run's to these, so its
	 * `result` and `usage` count the whole session, as the other CLIs' do.
	 */
	readonly sessionBefore: { readonly costUsd: number; readonly usage: HarnessUsage | null };
};

/** How a CLI's usage is counted: tokens of one model response. */
export type HarnessUsage = { readonly input: number; readonly output: number; readonly cacheRead: number; readonly cacheWrite: number };

/**
 * What a CLI's output means to Pim, whatever the CLI: one or more of these
 * per line it prints. Messages are pi-ai's, so they go into the thread's
 * transcript as the Pi harness's do.
 */
export type HarnessEvent =
	/** The CLI started (or resumed) a session. */
	| { readonly type: "session"; readonly sessionId: string; readonly model: string | null }
	/** Text or thinking being written, before the message it belongs to is complete. */
	| { readonly type: "delta"; readonly kind: "text" | "thinking"; readonly text: string }
	/** A complete assistant message, with its usage when the CLI reports one; `messageId` names the model response it is part of. */
	| { readonly type: "assistant"; readonly message: AssistantMessage; readonly messageId: string | null }
	/** Results of tool calls the assistant made; `exitCode` when the CLI reports a shell command's own. */
	| { readonly type: "tool_result"; readonly message: ToolResultMessage; readonly exitCode?: number | null }
	/**
	 * The tokens of the CLI's whole session so far, from a CLI that doesn't
	 * report each model response's: Codex reports the session's, Mistral Vibe
	 * the run's, which its parser adds to `sessionBefore`. A turn's usage is
	 * how much it grew.
	 */
	| { readonly type: "usage"; readonly usage: HarnessUsage }
	/** Something the CLI warned of that didn't stop the turn, such as a configuration it ignored. */
	| { readonly type: "notice"; readonly message: string }
	/** The CLI is retrying a failed model request. */
	| { readonly type: "retry"; readonly attempt: number; readonly maxRetries: number; readonly delayMs: number; readonly error: string; readonly status: number | null }
	/** The CLI refused a tool call no rule allowed. */
	| { readonly type: "permission_denied"; readonly tool: string; readonly message: string }
	/** The CLI can't reach the model because its login is missing or expired. */
	| { readonly type: "auth_failed"; readonly message: string }
	/**
	 * The turn's end, as the CLI reports it: whether it succeeded, why not
	 * (`budget`, `max_turns`, `error`), and the session's cost so far as the
	 * CLI estimates it. `sessionCostUsd` counts every turn of the session;
	 * null from a CLI that doesn't estimate one.
	 */
	| {
			readonly type: "result";
			readonly ok: boolean;
			readonly reason: "budget" | "max_turns" | "error" | null;
			readonly sessionId: string | null;
			readonly sessionCostUsd: number | null;
			readonly text: string | null;
			readonly errors: readonly string[];
	  }
	/** A line Pim couldn't read; kept for the operator, never shown as the agent's words. */
	| { readonly type: "unparsed"; readonly line: string };

/** Reads a CLI's output one line at a time. Stateful: it remembers what it needs across lines, such as which tool each call was. */
export interface HarnessParser {
	parseLine(line: string): HarnessEvent[];
	/**
	 * Reads what the CLI left in the workspace once it exited, for what its
	 * output didn't say, such as Mistral Vibe's summary of the run with what
	 * it cost. Its events come after all of the output's, as if it were the
	 * output's end. Without it, the output says everything.
	 */
	finish?(files: HarnessFiles): Promise<HarnessEvent[]>;
}

/** The workspace's files, as a parser's `finish` reads them. */
export type HarnessFiles = {
	/** A file's text, with the run's secrets taken out as from the CLI's output; null when there is no such file. */
	read(path: string): Promise<string | null>;
	/** Removes a file, or a directory with everything in it; nothing when there is no such path. */
	remove(path: string): Promise<void>;
};

/**
 * The CLI's own sign-in, inside a workspace, in one of two ways:
 *
 * - `paste_code`: the command prints a URL for the person to open, then
 *   reads the code the page shows them, which they paste into Pim, on its
 *   standard input (Claude Code).
 * - `device_code`: the command prints a URL and a code the person enters on
 *   that page, then polls the vendor until they have, and exits 0 once
 *   signed in (Codex's device-code login). Nothing is handed back to it.
 */
export type HarnessLoginFlow = {
	readonly mode: "paste_code" | "device_code";
	/** The sign-in command. With `paste_code`, its standard input is the code the person pastes, followed by a newline. */
	readonly command: readonly string[];
	/** The URL to send the person to, once the command has printed it; null until then. */
	authorizationUrl(output: string): string | null;
	/** With `device_code`: the code the person enters on that page, once the command has printed it; null until then. */
	userCode?(output: string): string | null;
};

/** One vendor CLI that can run a coding thread's turns. */
export interface CliHarness {
	/** The harness's id: the thread's `harness` and the vault's entry. */
	readonly id: Harness;
	/** The name people see. */
	readonly name: string;
	/** The command line of one turn, run in the repository's checkout. */
	buildCommand(turn: HarnessTurn): string[];
	/** A parser for one turn's output. */
	parser(turn: HarnessTurn): HarnessParser;
	/**
	 * Whether the CLI estimates what its session cost in dollars
	 * (`sessionCostUsd`). One that doesn't has its spend unmetered: it reads
	 * as not metered, not $0, and a budget isn't enforced against it. Its
	 * tokens are no stand-in: they say too little about what it charges (Amp
	 * counts the whole context again on every response).
	 */
	readonly reportsCost: boolean;
	/** The name of the CLI's shell tool in the transcript, whose commands may be test runs. */
	readonly shellTool: string;
	/** Environment the CLI always runs with, besides its config directory: such as turning its telemetry off. */
	readonly env: Readonly<Record<string, string>>;
	/** The hosts a workspace running it must reach, besides the git broker and package registries. */
	readonly egress: readonly string[];
	/**
	 * The command that sends `signal` to the turn's CLI process, found by its
	 * session id on its command line: SIGINT ends the turn the way a person
	 * pressing Ctrl-C does, so the CLI records it; SIGKILL when it doesn't.
	 */
	signalCommand(sessionId: string, signal: "INT" | "KILL"): string[];
	/**
	 * For a CLI that keeps its sessions open on the vendor's site (Amp): the
	 * command that closes the session's there, run in the workspace with the
	 * CLI's usual environment when the coding thread ends. Best-effort; a later
	 * turn reopens the session itself.
	 */
	archiveCommand?(sessionId: string): string[];
	/**
	 * What the CLI prints on its error output when it exits without a result
	 * because its login or key was refused, for a CLI that says so only
	 * there (Amp).
	 */
	readonly loginFailure?: RegExp;
	/** The CLI's own sign-in with a subscription, where it has one Pim can relay. */
	readonly login?: HarnessLoginFlow;
	/**
	 * With API-key sign-in, in place of `login`: the environment variable the
	 * CLI reads its key from, such as `MISTRAL_API_KEY`. A run sets it to the
	 * person's key from the vault (./auth.ts), and the runner takes the key
	 * out of everything the CLI prints (./runner.ts).
	 */
	readonly apiKeyEnv?: string;
}
