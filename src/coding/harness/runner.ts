import { redact } from "../tools/output";
import { parseTestSummary, type TestRun } from "../tools";
import type { Restored } from "../vault/inject";
import { harnessEnv, HARNESS_HOME } from "../vault/inject";
import { type Workspace, WorkspaceFileError } from "../workspace/types";
import type { CliHarness, HarnessEvent, HarnessFiles, HarnessTurn, HarnessUsage } from "./types";

/**
 * Runs one turn of a CLI harness (./types.ts) in a coding thread's
 * workspace: the CLI's command streamed through `Workspace.exec` in the
 * repository's checkout, each line it prints parsed and handed on as it
 * arrives, and how the turn ended said honestly. A turn is complete only
 * when the CLI itself reported success; an abort, a timeout, a crash, a
 * missing result or a restart of the thread never counts as one.
 *
 * With a subscription (`HarnessAuth`), the person's login is put into the
 * workspace before the CLI runs (`credentials.restore`) and what the CLI
 * changed of it is kept afterwards (`credentials.writeBack`, which also
 * removes it from the workspace), whatever happened in between. Only one
 * such run per person and harness goes on at a time (`lock`), since two
 * CLIs refreshing one login would race.
 *
 * What the thread keeps of the run while it goes on (`RunRecord`, in its
 * `journal`) is enough for a thread that restarted mid-run to finish it off
 * (`recoverRun`): the CLI is killed, the login written back and the lock
 * let go, and the turn ends `interrupted`. Workspace commands can't be
 * re-attached to after the stream reading them is gone.
 */

/**
 * How the CLI is signed in, as `authEnv` in ./auth.ts decides: with the
 * person's own subscription login, from the vault; with environment
 * variables that carry a key (the API-key or gateway mode), whose
 * `secrets` the runner takes out of everything the CLI prints before
 * anything else reads it; or not at all, for a harness that signs in with
 * an API key the person hasn't given (`signed_out`).
 */
export type HarnessAuth =
	| { readonly mode: "subscription" }
	| { readonly mode: "env"; readonly env: Readonly<Record<string, string>>; readonly secrets?: readonly string[] }
	| { readonly mode: "signed_out" };

/** What a secret is replaced with wherever the CLI printed it. */
const REDACTED = "[redacted]";

/** A run as the thread keeps it while it goes on. Plain data, stored as JSON. */
export type RunRecord = {
	readonly operationId: string;
	readonly sessionId: string;
	readonly resume: boolean;
	readonly startedAt: number;
	/** How many lines of the CLI's output were handled. */
	readonly lines: number;
	/** The login put into the workspace, to write back; null when none was. */
	readonly restored: Restored | null;
	/** Whether the run holds the person's lock for the harness. */
	readonly locked: boolean;
};

/** Where the thread keeps its `RunRecord`: written before each step it records is relied on. */
export interface RunJournal {
	save(record: RunRecord): void;
	clear(): void;
}

export type RunnerDeps = {
	readonly harness: CliHarness;
	readonly workspace: Workspace;
	readonly auth: HarnessAuth;
	/** The person's login for the harness, put in and written back for this workspace (../vault/inject.ts). */
	readonly credentials: { restore(): Promise<Restored>; writeBack(restored: Restored): Promise<unknown> };
	/** The person's one run at a time for the harness; `acquire` is false while another run holds it. */
	readonly lock: { acquire(): Promise<boolean>; release(): Promise<void> };
	readonly journal: RunJournal;
	/** Each event the CLI's output meant, in order. */
	readonly onEvent?: (event: HarnessEvent) => void | Promise<void>;
	/** A test command the agent ran, read from its shell tool's call and result. */
	readonly onTestRun?: (run: TestRun) => void;
	readonly now?: () => number;
	/** How long the CLI has to end its turn after SIGINT before it is killed. */
	readonly graceMs?: number;
	/** How long a turn may go without any output before it is stopped as stalled (`STALL_MS`). While a tool call is under way, which prints nothing until it ends, it may be silent four times as long. */
	readonly stallMs?: number;
	/** How often the person's lock is renewed while the turn runs (`LOCK_RENEW_MS`). */
	readonly lockRenewMs?: number;
};

/** Why a turn didn't complete. */
export type RunFailure = "aborted" | "timeout" | "stalled" | "budget" | "max_turns" | "login_required" | "harness_error" | "interrupted";

/** How a turn ended, with what it cost as the CLI reported it. */
export type RunResult = {
	readonly status: "done" | "unanswered";
	readonly reason?: RunFailure;
	/** What to tell the person about a failure. */
	readonly detail?: string;
	/** The session the CLI ran, once it said so. */
	readonly sessionId: string | null;
	/** The session's whole cost so far as the CLI estimates it, from its result; null without one. */
	readonly sessionCostUsd: number | null;
	/** The turn's tokens: each model response counted once. */
	readonly usage: HarnessUsage;
	/** The session's whole usage so far, from a CLI that reports only that (`usage` events); null from one that doesn't. */
	readonly sessionUsage: HarnessUsage | null;
	readonly model: string | null;
	readonly lines: number;
};

/** What `prepare` found: ready to run, another run holds the person's lock, or the person has no login for the harness. */
export type Prepared = { readonly status: "ready" } | { readonly status: "busy" } | { readonly status: "login_required" };

/** The default grace after SIGINT. */
export const INTERRUPT_GRACE_MS = 15_000;

/** How long a turn may make no progress, with no output at all, before it is stopped. A turn that is working is never cut off, however long it runs. */
export const STALL_MS = 30 * 60_000;

/** How often a running turn renews the person's lock, which is leased for a while at a time so a thread that is gone can't keep it. */
export const LOCK_RENEW_MS = 10 * 60_000;

/** What a turn with no time limit asks of the workspace as its command's timeout: a week, which no turn reaches. */
export const UNLIMITED_EXEC_MS = 7 * 24 * 60 * 60_000;

/** The most of the CLI's error output a failure keeps. */
const STDERR_TAIL = 2000;

const NO_USAGE: HarnessUsage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };

/** Splits a stream of text into lines, keeping a partial last line until it is completed. */
export class LineBuffer {
	#rest = "";

	push(chunk: string): string[] {
		const text = this.#rest + chunk;
		const lines = text.split("\n");
		this.#rest = lines.pop() ?? "";
		return lines;
	}

	/** What is left after the stream ended: a last line without its newline. */
	flush(): string[] {
		const rest = this.#rest;
		this.#rest = "";
		return rest.trim() ? [rest] : [];
	}
}

/** Commands that run tests, for the thread's test runs. */
const TEST_COMMAND = /(?:^|[\s;&|(])(?:(?:npm|pnpm|yarn|bun)\s+(?:run\s+)?test\b|npx\s+(?:vitest|jest|mocha)\b|vitest\b|jest\b|pytest\b|python3?\s+-m\s+(?:pytest|unittest)\b|go\s+test\b|cargo\s+test\b|mvn\s+test\b|gradle\w*\s+test\b|rspec\b|phpunit\b|ctest\b|make\s+test\b|deno\s+test\b)/;

/** The exit code Claude Code's Bash tool writes at the head of a failed command's result ("Exit code 1"), for a CLI that doesn't report it apart. */
const EXIT_CODE = /^(?:Error:\s*)?Exit code (\d+)/m;

export class HarnessRunner {
	readonly #deps: RunnerDeps;
	readonly #now: () => number;
	#record: RunRecord | null = null;
	#controller = new AbortController();
	#aborted = false;
	#timedOut = false;
	#stalled = false;
	#running = false;
	#interrupted: Promise<void> | null = null;
	/** Resolves when the run under way has ended. */
	#ended: Promise<void> = Promise.resolve();

	constructor(deps: RunnerDeps) {
		this.#deps = deps;
		this.#now = deps.now ?? Date.now;
	}

	/**
	 * Gets the run ready, before its turn starts: takes the person's lock for
	 * the harness and puts their login into the workspace. Without a login
	 * the workspace is cleared again and the lock let go. Signed in through
	 * its environment, it needs neither; signed out, it touches nothing.
	 */
	async prepare(operationId: string, session: { sessionId: string; resume: boolean }): Promise<Prepared> {
		const { auth, credentials, lock, journal } = this.#deps;
		if (auth.mode === "signed_out") return { status: "login_required" };
		const record: RunRecord = { operationId, ...session, startedAt: this.#now(), lines: 0, restored: null, locked: auth.mode === "subscription" };
		if (auth.mode !== "subscription") {
			this.#keep(record);
			return { status: "ready" };
		}
		if (!(await lock.acquire())) return { status: "busy" };
		this.#keep(record);
		let restored: Restored;
		try {
			restored = await credentials.restore();
		} catch (error) {
			await this.#finish();
			throw error;
		}
		this.#keep({ ...record, restored });
		if (!restored.connected) {
			await this.#finish();
			return { status: "login_required" };
		}
		return { status: "ready" };
	}

	/** Runs the prepared turn to its end, then writes the login back and lets the lock go, whatever happened. */
	async run(turn: HarnessTurn, timeoutMs: number | null): Promise<RunResult> {
		const record = this.#record;
		if (!record) throw new Error("The harness run wasn't prepared");
		this.#running = true;
		let ended = () => {};
		this.#ended = new Promise((resolve) => {
			ended = resolve;
		});
		try {
			return await this.#execute(record, turn, timeoutMs);
		} finally {
			this.#running = false;
			ended();
			await this.#finish();
		}
	}

	/**
	 * Stops the turn: SIGINT, so the CLI ends it the way it records, then,
	 * if it still runs after the grace, kills it.
	 */
	abort(): Promise<void> {
		this.#aborted = true;
		return this.#interrupt();
	}

	async #execute(record: RunRecord, turn: HarnessTurn, timeoutMs: number | null): Promise<RunResult> {
		const { harness, workspace, auth } = this.#deps;
		const parser = harness.parser(turn);
		// A key the CLI was given never goes further than its process: what it prints is read without it.
		const secrets = auth.mode === "env" ? (auth.secrets ?? []).filter((secret) => secret.length > 0) : [];
		const scrub = (text: string) => secrets.reduce((clean, secret) => clean.replaceAll(secret, REDACTED), text);
		const lines = new LineBuffer();
		const usage = new Map<string, HarnessUsage>();
		const calls = new Map<string, { command: string; startedAt: number }>();
		let unnamed = 0;
		// Tool calls the CLI made that haven't ended: it prints nothing while one runs.
		const pending = new Set<string>();
		// What the output said so far: who, what it cost, and how it ended.
		const seen = {
			sessionId: null as string | null,
			model: null as string | null,
			result: null as Extract<HarnessEvent, { type: "result" }> | null,
			sessionUsage: null as HarnessUsage | null,
			authFailed: null as string | null,
			stderr: "",
			exit: null as { code: number | null; timedOut?: boolean } | null,
			lines: record.lines,
		};

		const handle = async (events: readonly HarnessEvent[]) => {
			for (const event of events) {
				switch (event.type) {
					case "session":
						seen.sessionId = event.sessionId;
						seen.model = event.model ?? seen.model;
						break;
					case "assistant":
						usage.set(event.messageId ?? `unnamed-${unnamed++}`, event.message.usage);
						seen.model = event.message.model;
						for (const part of event.message.content) {
							if (part.type === "toolCall") pending.add(part.id);
							if (part.type === "toolCall" && part.name === harness.shellTool && typeof part.arguments.command === "string") calls.set(part.id, { command: part.arguments.command, startedAt: this.#now() });
						}
						break;
					case "tool_result":
						pending.delete(event.message.toolCallId);
						this.#testRun(calls.get(event.message.toolCallId), event.message, event.exitCode);
						break;
					case "usage":
						seen.sessionUsage = event.usage;
						break;
					case "auth_failed":
						seen.authFailed = event.message;
						break;
					case "result":
						seen.result = event;
						seen.sessionId = event.sessionId ?? seen.sessionId;
						break;
				}
				try {
					await this.#deps.onEvent?.(event);
				} catch (error) {
					console.warn(JSON.stringify({ event: "pim.coding.harness_event_failed", harness: harness.id, error: String(error) }));
				}
			}
		};
		const line = async (text: string) => {
			await handle(parser.parseLine(scrub(text)));
			seen.lines++;
			this.#keep({ ...this.#record!, lines: seen.lines });
		};
		// What the CLI left in the workspace, read as it reads its output: never with the key in it.
		const files: HarnessFiles = {
			read: async (path) => {
				try {
					return scrub(new TextDecoder().decode(await workspace.readFile(path)));
				} catch (error) {
					if (error instanceof WorkspaceFileError) return null;
					throw error;
				}
			},
			remove: async (path) => {
				try {
					await workspace.remove(path);
				} catch (error) {
					if (!(error instanceof WorkspaceFileError)) throw error;
				}
			},
		};

		const startedAt = Date.now();
		if (!this.#aborted) {
			const env = { HOME: HARNESS_HOME, ...harnessEnv(harness.id), ...harness.env, ...(auth.mode === "env" ? auth.env : {}) };
			const grace = this.#deps.graceMs ?? INTERRUPT_GRACE_MS;
			// The turn's own time limit, only when the thread has one.
			const timer =
				timeoutMs === null
					? undefined
					: setTimeout(() => {
							this.#timedOut = true;
							void this.#interrupt();
						}, timeoutMs);
			// A turn that prints nothing for too long is stalled, and stopped; any output starts the wait again.
			const stallMs = this.#deps.stallMs ?? STALL_MS;
			let stall: ReturnType<typeof setTimeout> | undefined;
			const watch = () => {
				clearTimeout(stall);
				stall = setTimeout(() => {
					this.#stalled = true;
					void this.#interrupt();
				}, pending.size > 0 ? 4 * stallMs : stallMs);
			};
			watch();
			// The person's lock is leased, and renewed for as long as the turn runs.
			const renew = record.locked ? setInterval(() => void this.#deps.lock.acquire().catch(() => {}), this.#deps.lockRenewMs ?? LOCK_RENEW_MS) : undefined;
			try {
				// The workspace's own timeout is the last resort, past the grace the CLI gets after SIGINT.
				const execMs = timeoutMs === null ? UNLIMITED_EXEC_MS : timeoutMs + 2 * grace;
				for await (const event of workspace.exec(harness.buildCommand(turn), { cwd: `${HARNESS_HOME}/repo`, env, timeoutMs: execMs, signal: this.#controller.signal })) {
					if (event.type === "stdout") for (const text of lines.push(event.data)) await line(text);
					// Scrubbed as a whole before it is cut, so a secret split across chunks is found too.
					else if (event.type === "stderr") seen.stderr = scrub(seen.stderr + event.data).slice(-STDERR_TAIL);
					else if (event.type === "exit") seen.exit = event;
					watch();
				}
				for (const text of lines.flush()) await line(text);
				// A failure to read what the CLI left behind loses only what it says: the turn ends as far as the output tells.
				if (parser.finish) {
					await handle(
						await parser.finish(files).catch((error) => {
							console.warn(JSON.stringify({ event: "pim.coding.harness_finish_failed", harness: harness.id, error: String(error) }));
							return [];
						}),
					);
				}
			} finally {
				clearTimeout(timer);
				clearTimeout(stall);
				clearInterval(renew);
			}
		}

		const { sessionId, model, result, authFailed, stderr, exit, sessionUsage, lines: count } = seen;
		const ended = (reason: RunFailure, detail: string): RunResult => ({ status: "unanswered", reason, detail, sessionId, sessionCostUsd: result?.sessionCostUsd ?? null, usage: sum(usage), sessionUsage, model, lines: count });
		if (this.#aborted) return ended("aborted", "Stopped");
		if (this.#timedOut) return ended("timeout", `The turn ran out of time after ${Math.round((timeoutMs ?? 0) / 60_000)} minutes`);
		// A command the workspace itself cut off, short of any limit of the turn's: say how long it really ran, not what the turn's limit was.
		if (exit?.timedOut) return ended("timeout", `The workspace stopped the turn's command after ${Math.max(1, Math.round((Date.now() - startedAt) / 60_000))} minutes, short of any limit of the turn's`);
		if (this.#stalled) return ended("stalled", `The turn made no progress for ${Math.round((this.#deps.stallMs ?? STALL_MS) / 60_000)} minutes, so it was stopped`);
		if (authFailed !== null || (!result && harness.loginFailure?.test(stderr))) return ended("login_required", `${harness.name} isn't signed in: connect it again`);
		if (result) {
			if (result.ok) return { status: "done", sessionId, sessionCostUsd: result.sessionCostUsd, usage: sum(usage), sessionUsage, model, lines: count };
			if (result.reason === "budget") return ended("budget", "The turn reached its budget");
			if (result.reason === "max_turns") return ended("max_turns", "The turn reached its most steps");
			const text = redact([...result.errors, result.text ?? ""].join("\n").trim()).slice(0, 500);
			// A subscription's usage cap isn't a fault: say so, keeping the vendor's own words (they name when it resets).
			if (/usage limit|hit your limit|limit reached|resets? (at|in|on)|out of credits|no paid credits/i.test(text)) return ended("harness_error", `${harness.name} usage limit reached: ${text}`);
			return ended("harness_error", text || `${harness.name} reported an error`);
		}
		const how = exit === null ? "ended without an exit" : exit.code === null ? "was killed" : `exited ${exit.code}`;
		return ended("harness_error", `${harness.name} ${how} without a result${stderr.trim() ? `: ${redact(stderr.trim()).slice(-500)}` : ""}`);
	}

	/** Records a run of tests: a shell command that runs a test runner, or printed a test summary. */
	#testRun(call: { command: string; startedAt: number } | undefined, message: { content: readonly { type: string; text?: string }[]; isError: boolean }, exitCode: number | null | undefined): void {
		if (!call || !this.#deps.onTestRun) return;
		const output = message.content.flatMap((part) => (part.type === "text" && typeof part.text === "string" ? [part.text] : [])).join("\n");
		const summary = parseTestSummary(output) ?? null;
		if (!summary && !TEST_COMMAND.test(call.command)) return;
		const code = EXIT_CODE.exec(output);
		this.#deps.onTestRun({
			command: call.command,
			exitCode: typeof exitCode === "number" ? exitCode : code ? Number(code[1]) : message.isError ? 1 : 0,
			timedOut: false,
			startedAt: call.startedAt,
			durationMs: Math.max(0, this.#now() - call.startedAt),
			summary,
			output: redact(output).slice(-8000),
		});
	}

	/** SIGINT to the CLI, then, after the grace, the command killed outright. Once per run. */
	#interrupt(): Promise<void> {
		this.#interrupted ??= (async () => {
			const record = this.#record;
			if (!record || !this.#running) {
				this.#controller.abort();
				return;
			}
			await signal(this.#deps, record.sessionId, "INT");
			const grace = this.#deps.graceMs ?? INTERRUPT_GRACE_MS;
			let timer: ReturnType<typeof setTimeout> | undefined;
			await Promise.race([new Promise((resolve) => (timer = setTimeout(resolve, grace))), this.#ended]);
			clearTimeout(timer);
			if (!this.#running) return;
			this.#controller.abort(new Error("The harness didn't stop after SIGINT"));
			await signal(this.#deps, record.sessionId, "KILL");
		})();
		return this.#interrupted;
	}

	#keep(record: RunRecord): void {
		this.#record = record;
		this.#deps.journal.save(record);
	}

	/** Writes the login back and lets the lock go, each even if the one before failed, then forgets the run. */
	async #finish(): Promise<void> {
		const record = this.#record;
		if (!record) return;
		try {
			await cleanUp(this.#deps, record);
		} finally {
			this.#record = null;
		}
	}
}

/**
 * Finishes a run that a restart of the thread cut off: the CLI, which may
 * still be running in the workspace, is killed, the login written back and
 * the lock let go. The turn ended `interrupted`: whatever the CLI did after
 * the thread stopped reading it isn't known, and isn't claimed.
 */
export async function recoverRun(deps: Pick<RunnerDeps, "harness" | "workspace" | "credentials" | "lock" | "journal">, record: RunRecord): Promise<RunResult> {
	await signal(deps, record.sessionId, "KILL");
	await cleanUp(deps, record);
	return {
		status: "unanswered",
		reason: "interrupted",
		detail: `The thread restarted while ${deps.harness.name} ran, after ${record.lines} lines of its output; its turn was stopped`,
		sessionId: null,
		sessionCostUsd: null,
		usage: NO_USAGE,
		sessionUsage: null,
		model: null,
		lines: record.lines,
	};
}

async function cleanUp(deps: Pick<RunnerDeps, "harness" | "credentials" | "lock" | "journal">, record: RunRecord): Promise<void> {
	try {
		if (record.restored) await deps.credentials.writeBack(record.restored);
	} catch (error) {
		console.warn(JSON.stringify({ event: "pim.coding.harness_write_back_failed", harness: deps.harness.id, error: error instanceof Error ? error.name : "unknown" }));
	} finally {
		try {
			if (record.locked) await deps.lock.release();
		} finally {
			deps.journal.clear();
		}
	}
}

/** Sends a signal to the CLI by its session id; best-effort, as the process may be gone. */
async function signal(deps: Pick<RunnerDeps, "harness" | "workspace">, sessionId: string, name: "INT" | "KILL"): Promise<void> {
	try {
		for await (const _ of deps.workspace.exec(deps.harness.signalCommand(sessionId, name), { timeoutMs: 10_000 })) {
		}
	} catch (error) {
		console.warn(JSON.stringify({ event: "pim.coding.harness_signal_failed", harness: deps.harness.id, signal: name, error: String(error) }));
	}
}


function sum(usage: Map<string, HarnessUsage>): HarnessUsage {
	let total = NO_USAGE;
	for (const each of usage.values()) {
		total = { input: total.input + each.input, output: total.output + each.output, cacheRead: total.cacheRead + each.cacheRead, cacheWrite: total.cacheWrite + each.cacheWrite };
	}
	return total;
}
