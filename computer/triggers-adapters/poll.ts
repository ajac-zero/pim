/**
 * The `poll` observer: runs a source's shell command on a fixed cadence, one
 * invocation at a time, and emits what it prints, one bounded JSON object,
 * as a state observation. Its contract is in docs/triggers-adapters.md.
 *
 * Inert. Nothing imports this module into pim-computer or its service; only
 * tests construct it.
 *
 * The command runs as the user who runs pim-computer, with that user's
 * access. The runtime's host checks the grant before this adapter is ever
 * made; what this adapter enforces is only the lifecycle and resources of
 * its own child: one at a time, a deadline, bounded output, and a process
 * group it started and signals only while that group is provably its own.
 * It confines nothing else, and a command that leaves its process group
 * (with `setsid`, say) leaves this adapter's reach as well.
 */

import { Buffer } from "node:buffer";
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import type { AdapterConfig, AdapterHealth, ComputerSource, Emit, JsonObject, ObserverAdapter, Observed, RuntimeClock, StopReason } from "../triggers-runtime.ts";

/**
 * The bounds a poll is run with. The timing bounds are the space's own
 * (`TRIGGER_DEFAULTS` in src/triggers/spec.ts: at least a minute between
 * polls, at most a day, and a deadline from 1 to 30 seconds), checked again
 * here because the runtime reads a source's shape and leaves its bounds to
 * the space. The data bounds are what the runtime and the store take.
 */
export const POLL_LIMITS = {
	minIntervalMs: 60_000,
	defaultIntervalMs: 300_000,
	maxIntervalMs: 86_400_000,
	minDeadlineMs: 1_000,
	maxDeadlineMs: 30_000,
	commandLength: 4_000,
	stdoutBytes: 65_536,
	stderrBytes: 16_384,
	dataBytes: 16_384,
	dataDepth: 8,
	dataValues: 16_384,
	/** The most a poll may be moved later than its slot. */
	maxJitterMs: 30_000,
} as const;

/** The system's clock, for when no clock is given. */
export const systemClock: RuntimeClock = {
	now: () => Date.now(),
	setTimer: (ms, run) => {
		const timer = setTimeout(run, ms);
		return () => clearTimeout(timer);
	},
};

export type ChildExit = { readonly code: number | null; readonly signal: string | null; readonly failed: boolean };
export type ChildEvents = {
	stdout(chunk: Uint8Array): void;
	stderr(chunk: Uint8Array): void;
	/** Called once, when the child's leader has exited and its output is closed, or it could not be started (`failed`). */
	exit(result: ChildExit): void;
};
/** One child a launcher started for this adapter, and only that one. */
export interface OwnedChild {
	/** Signals the child's own process group; false, with nothing sent, once its leader has exited. */
	signal(name: "SIGTERM" | "SIGKILL"): boolean;
	/** Stops reading its output and lets go of its pipes. */
	release(): void;
}
/** Starts a poll's command. Injected, so tests run the adapter on a fake one. */
export interface ChildLauncher {
	launch(request: { readonly command: string; readonly cwd: string | null }, events: ChildEvents): OwnedChild;
}

export type PollAdapterOptions = {
	readonly launcher: ChildLauncher;
	readonly clock?: RuntimeClock;
	/** A number in [0, 1), for jitter. */
	readonly random?: () => number;
	/** The share of the interval a poll may be moved later than its slot, up to `maxJitterMs`: 0.1 unless set, at most 0.5. */
	readonly jitterRatio?: number;
	/** How long a child has after SIGTERM before SIGKILL. */
	readonly graceMs?: number;
	/** How long a child has after SIGKILL to be reaped before the adapter says so and polls no more. */
	readonly reapMs?: number;
	/** The first wait before an emission the runtime couldn't take yet is tried again; it doubles up to `maxRetryMs`. */
	readonly retryMs?: number;
	readonly maxRetryMs?: number;
};

export class PollConfigError extends Error {
	readonly code: string;
	constructor(code: string) {
		super(code);
		this.code = code;
	}
}

type PollSource = Extract<ComputerSource, { kind: "poll" }>;

/** Reads a poll source's bounds as the space does; throws a `PollConfigError` on any it doesn't meet. */
export function checkPollSource(source: ComputerSource): PollSource {
	if (source.kind !== "poll") throw new PollConfigError("poll_wrong_kind");
	const within = (value: number, min: number, max: number) => Number.isSafeInteger(value) && value >= min && value <= max;
	if (!within(source.intervalMs, POLL_LIMITS.minIntervalMs, POLL_LIMITS.maxIntervalMs)) throw new PollConfigError("poll_interval_out_of_bounds");
	if (!within(source.deadlineMs, POLL_LIMITS.minDeadlineMs, POLL_LIMITS.maxDeadlineMs)) throw new PollConfigError("poll_deadline_out_of_bounds");
	if (typeof source.command !== "string" || source.command.trim() === "" || source.command.length > POLL_LIMITS.commandLength) throw new PollConfigError("poll_command_invalid");
	if (source.cwd !== null && (typeof source.cwd !== "string" || !source.cwd.startsWith("/") || source.cwd.includes("\0"))) throw new PollConfigError("poll_cwd_invalid");
	return source;
}

export type PollOutput = { readonly ok: true; readonly data: JsonObject } | { readonly ok: false; readonly code: "poll_invalid_output" | "poll_output_too_large" };

/**
 * Reads what a poll printed: UTF-8, one JSON object and nothing else, at
 * most 8 levels below it and 16,384 values, and at most 16 KiB as JSON.
 * It is only ever parsed as JSON, never run or interpreted otherwise.
 */
export function readPollOutput(bytes: Uint8Array): PollOutput {
	let value: unknown;
	try {
		value = JSON.parse(new TextDecoder("utf-8", { fatal: true, ignoreBOM: false }).decode(bytes));
	} catch {
		return { ok: false, code: "poll_invalid_output" };
	}
	if (typeof value !== "object" || value === null || Array.isArray(value)) return { ok: false, code: "poll_invalid_output" };
	const budget = { values: 0 };
	const fits = (item: unknown, depth: number): boolean => {
		if (++budget.values > POLL_LIMITS.dataValues || depth > POLL_LIMITS.dataDepth) return false;
		if (typeof item !== "object" || item === null) return true;
		return Object.values(item).every((child) => fits(child, depth + 1));
	};
	if (!fits(value, 0)) return { ok: false, code: "poll_invalid_output" };
	if (Buffer.byteLength(JSON.stringify(value)) > POLL_LIMITS.dataBytes) return { ok: false, code: "poll_output_too_large" };
	return { ok: true, data: value as JsonObject };
}

type Invocation = {
	readonly slot: number;
	child: OwnedChild | null;
	stdout: Buffer[];
	stdoutBytes: number;
	stderrBytes: number;
	/** Why the adapter ended it, if it did. */
	ended: "timeout" | "too_large" | "stopped" | null;
	exited: boolean;
	timers: (() => void)[];
	readonly done: Promise<void>;
	finish: () => void;
};

/**
 * One poll observer. Its first poll is due at the instant `start` returns
 * plus jitter, and each next one an interval later than the slot before,
 * plus that slot's own jitter: the cadence is anchored to the start, not to
 * when polls end. A slot that comes while the last invocation is still
 * running, while the runtime has paused it, or while an observation waits to
 * be taken is skipped, and a wake later than a slot (after the computer
 * slept, say) runs one poll and moves on to the next future slot, never a
 * burst of the missed ones.
 */
export class PollAdapter implements ObserverAdapter {
	readonly #launcher: ChildLauncher;
	readonly #clock: RuntimeClock;
	readonly #random: () => number;
	readonly #jitterRatio: number;
	readonly #graceMs: number;
	readonly #reapMs: number;
	readonly #retryMs: number;
	readonly #maxRetryMs: number;
	/** Makes each observation's key this adapter's own, so a retry of the same one is the same event. */
	readonly #nonce = randomUUID();
	#source: PollSource | null = null;
	#emit: Emit | null = null;
	#health: ((report: AdapterHealth) => void) | null = null;
	#fenced = false;
	#paused = false;
	#anchor = 0;
	#slot = 0;
	#cadence: (() => void) | null = null;
	#run: Invocation | null = null;
	/** An observation the runtime couldn't take yet: kept, and tried again, before anything newer is sampled. */
	#retained: Observed | null = null;
	#retry: (() => void) | null = null;
	#retryWait: number;
	#emitting = false;
	/** The failure last reported, so a recovery is reported once and a repeat isn't. */
	#failing: string | null = null;

	constructor(options: PollAdapterOptions) {
		this.#launcher = options.launcher;
		this.#clock = options.clock ?? systemClock;
		this.#random = options.random ?? Math.random;
		const bounded = (name: string, value: number, min: number, max: number) => {
			if (!Number.isFinite(value) || value < min || value > max) throw new RangeError(`${name} must be from ${min} to ${max}`);
			return value;
		};
		this.#jitterRatio = bounded("jitterRatio", options.jitterRatio ?? 0.1, 0, 0.5);
		this.#graceMs = bounded("graceMs", options.graceMs ?? 2_000, 10, 5_000);
		this.#reapMs = bounded("reapMs", options.reapMs ?? 2_000, 10, 5_000);
		this.#retryMs = bounded("retryMs", options.retryMs ?? 1_000, 10, 60_000);
		this.#maxRetryMs = bounded("maxRetryMs", options.maxRetryMs ?? 30_000, this.#retryMs, 600_000);
		this.#retryWait = this.#retryMs;
	}

	async start(config: AdapterConfig, emit: Emit, health: (report: AdapterHealth) => void): Promise<void> {
		this.#source = checkPollSource(config.source);
		this.#emit = emit;
		this.#health = health;
		if (config.signal.aborted) return this.#fence();
		config.signal.addEventListener("abort", () => this.#fence(), { once: true });
		this.#anchor = this.#clock.now();
		this.#schedule();
	}

	async stop(_reason: StopReason): Promise<void> {
		this.#fence();
		const run = this.#run;
		if (!run) return;
		// Bounded: SIGTERM, the grace, SIGKILL and the wait to be reaped, and a little over.
		let cancel = () => {};
		await Promise.race([run.done, new Promise<void>((resolve) => (cancel = this.#clock.setTimer(this.#graceMs + this.#reapMs + 100, resolve)))]);
		cancel();
		run.child?.release();
	}

	pause(): void {
		this.#paused = true;
	}

	resume(): void {
		this.#paused = false;
		if (this.#retained) void this.#deliver();
	}

	/** From now on nothing more is polled or emitted, and its own child, if one runs, is ended. */
	#fence(): void {
		if (this.#fenced) return;
		this.#fenced = true;
		this.#cadence?.();
		this.#cadence = null;
		this.#retry?.();
		this.#retry = null;
		this.#retained = null;
		if (this.#run) this.#end(this.#run, "stopped");
	}

	#schedule(): void {
		const source = this.#source as PollSource;
		const jitter = Math.floor(Math.min(1, Math.max(0, this.#random())) * Math.min(POLL_LIMITS.maxJitterMs, source.intervalMs * this.#jitterRatio));
		const due = this.#anchor + this.#slot * source.intervalMs + Math.min(jitter, source.intervalMs - 1);
		this.#cadence = this.#clock.setTimer(Math.max(0, due - this.#clock.now()), () => this.#due());
	}

	#due(): void {
		this.#cadence = null;
		if (this.#fenced) return;
		const source = this.#source as PollSource;
		const now = this.#clock.now();
		const slot = this.#slot;
		if (!this.#paused && !this.#run && !this.#retained) this.#launch(slot);
		// The next slot is the first that is still to come: missed ones are skipped, never run in a burst.
		const next = Math.max(slot + 1, Math.floor((now - this.#anchor) / source.intervalMs) + 1);
		if (next > slot + 1) this.#report("degraded", "poll_skipped");
		this.#slot = next;
		this.#schedule();
	}

	#launch(slot: number): void {
		const source = this.#source as PollSource;
		let finish = () => {};
		const done = new Promise<void>((resolve) => (finish = resolve));
		const run: Invocation = { slot, child: null, stdout: [], stdoutBytes: 0, stderrBytes: 0, ended: null, exited: false, timers: [], done, finish };
		this.#run = run;
		try {
			run.child = this.#launcher.launch(
				{ command: source.command, cwd: source.cwd },
				{
					stdout: (chunk) => {
						if (run.exited || run.ended) return;
						run.stdoutBytes += chunk.byteLength;
						if (run.stdoutBytes > POLL_LIMITS.stdoutBytes) return this.#end(run, "too_large");
						run.stdout.push(Buffer.from(chunk));
					},
					// What a poll writes to stderr is counted and dropped, never kept, logged or sent.
					stderr: (chunk) => {
						if (run.exited || run.ended) return;
						run.stderrBytes += chunk.byteLength;
						if (run.stderrBytes > POLL_LIMITS.stderrBytes) this.#end(run, "too_large");
					},
					exit: (result) => this.#exited(run, result),
				},
			);
		} catch {
			run.exited = true;
			this.#run = null;
			finish();
			this.#report("error", "poll_spawn_failed");
			return;
		}
		if (!run.exited) run.timers.push(this.#clock.setTimer(source.deadlineMs, () => this.#end(run, "timeout")));
	}

	/** Ends its own child: SIGTERM to its group, SIGKILL after the grace, and a report if it still isn't reaped after that. */
	#end(run: Invocation, why: NonNullable<Invocation["ended"]>): void {
		if (run.exited || run.ended) return;
		run.ended = why;
		run.stdout = [];
		run.child?.signal("SIGTERM");
		run.timers.push(
			this.#clock.setTimer(this.#graceMs, () => {
				if (run.exited) return;
				run.child?.signal("SIGKILL");
				run.timers.push(
					this.#clock.setTimer(this.#reapMs, () => {
						// It stays this adapter's one invocation, so nothing else is started beside it.
						if (!run.exited) this.#report("error", "poll_unreaped");
					}),
				);
			}),
		);
	}

	#exited(run: Invocation, result: ChildExit): void {
		if (run.exited) return;
		run.exited = true;
		for (const cancel of run.timers) cancel();
		run.child?.release();
		if (this.#run === run) this.#run = null;
		run.finish();
		if (this.#fenced) return;
		const at = this.#clock.now();
		if (run.ended === "timeout") return this.#report("degraded", "poll_timeout");
		if (run.ended === "too_large") return this.#report("degraded", "poll_output_too_large");
		if (result.failed) return this.#report("error", "poll_spawn_failed");
		if (result.code !== 0 || result.signal !== null) return this.#report("degraded", "poll_failed");
		const output = readPollOutput(Buffer.concat(run.stdout));
		run.stdout = [];
		if (!output.ok) return this.#report("degraded", output.code);
		this.#retained = { occurredAt: at, data: output.data, checkpoint: null, key: `poll:${this.#nonce}:${run.slot}` };
		void this.#deliver();
	}

	async #deliver(): Promise<void> {
		const observed = this.#retained;
		if (!observed || this.#emitting || this.#fenced || this.#retry) return;
		this.#emitting = true;
		let result: Awaited<ReturnType<Emit>>;
		try {
			result = await (this.#emit as Emit)(observed);
		} catch {
			result = { ok: false, reason: "spool_unavailable" };
		}
		this.#emitting = false;
		if (this.#fenced || this.#retained !== observed) return;
		if (result.ok) {
			this.#retained = null;
			this.#retryWait = this.#retryMs;
			if (this.#failing) {
				this.#failing = null;
				this.#health?.({ status: "ok", code: "poll_ok" });
			}
			return;
		}
		switch (result.reason) {
			case "not_started":
			case "spool_unavailable": {
				// Nothing of it was kept and the runtime counted no gap: keep it, and try again.
				const wait = this.#retryWait;
				this.#retryWait = Math.min(this.#maxRetryMs, wait * 2);
				this.#retry = this.#clock.setTimer(wait, () => {
					this.#retry = null;
					void this.#deliver();
				});
				return;
			}
			case "backpressure":
				// The runtime counted it in an `overflow` gap; the next sample after `resume` takes its place.
				this.#retained = null;
				this.#paused = true;
				return;
			case "too_large":
				this.#retained = null;
				return this.#report("degraded", "poll_output_too_large");
			case "invalid":
				this.#retained = null;
				return this.#report("degraded", "poll_invalid_output");
			case "stopped":
				this.#retained = null;
				this.#fence();
				return;
		}
	}

	#report(status: AdapterHealth["status"], code: string): void {
		if (this.#fenced) return;
		this.#failing = code;
		this.#health?.({ status, code });
	}
}

/** What a poll's shell gets of pim-computer's environment: these names only, so its token and anything else it holds stay out. */
export const POLL_ENVIRONMENT = ["PATH", "HOME", "USER", "LOGNAME", "SHELL", "LANG", "LC_ALL", "LC_CTYPE", "TZ", "TMPDIR"] as const;

export type NodeChildLauncherOptions = {
	/** The working folder of a poll whose source names none. */
	readonly defaultCwd: string;
	/** The shell that runs a command with `-c`; `/bin/sh` unless set. */
	readonly shell?: string;
	/** The whole environment a poll gets; `POLL_ENVIRONMENT` of this process's unless set. */
	readonly env?: Readonly<Record<string, string>>;
	/** How long after the leader exits its output may still be read. */
	readonly drainMs?: number;
};

/**
 * Runs a command with `shell -c` in a process group of its own, with stdin
 * closed. It signals that group only while the group's leader, its own
 * child, hasn't been reaped: until then the leader's process id is taken,
 * and so is the group's, so no other process can have it. Node reaps a
 * child and records its exit in the same step of its event loop, so
 * `exitCode` and `signalCode` both still null means not yet reaped. When the
 * leader exits, whatever is left in its group is killed at once, since a
 * poll is over when its command is, and the group's id is never signalled
 * again after that.
 */
export class NodeChildLauncher implements ChildLauncher {
	readonly #defaultCwd: string;
	readonly #shell: string;
	readonly #env: Readonly<Record<string, string>>;
	readonly #drainMs: number;

	constructor(options: NodeChildLauncherOptions) {
		if (!options.defaultCwd.startsWith("/")) throw new RangeError("defaultCwd must be an absolute path");
		this.#defaultCwd = options.defaultCwd;
		this.#shell = options.shell ?? "/bin/sh";
		this.#env = options.env ?? pollEnvironment(process.env);
		this.#drainMs = options.drainMs ?? 250;
	}

	launch(request: { readonly command: string; readonly cwd: string | null }, events: ChildEvents): OwnedChild {
		const child = spawn(this.#shell, ["-c", request.command], { cwd: request.cwd ?? this.#defaultCwd, detached: true, stdio: ["ignore", "pipe", "pipe"], env: { ...this.#env }, windowsHide: true });
		const pid = child.pid;
		let released = false;
		let reported = false;
		let drain: ReturnType<typeof setTimeout> | undefined;
		const release = () => {
			released = true;
			child.stdout?.destroy();
			child.stderr?.destroy();
		};
		const finish = (result: ChildExit) => {
			if (reported) return;
			reported = true;
			clearTimeout(drain);
			release();
			events.exit(result);
		};
		child.stdout?.on("data", (chunk: Buffer) => {
			if (!released) events.stdout(chunk);
		});
		child.stderr?.on("data", (chunk: Buffer) => {
			if (!released) events.stderr(chunk);
		});
		child.stdout?.on("error", () => {});
		child.stderr?.on("error", () => {});
		child.on("error", () => {
			// Only a child that never started gets here without an exit: nothing of it runs.
			if (pid === undefined) finish({ code: null, signal: null, failed: true });
		});
		child.on("exit", (code, signal) => {
			// What is left of its group goes with it. The group's id is still reserved while any member lives.
			if (pid !== undefined) killGroup(pid, "SIGKILL");
			drain = setTimeout(() => finish({ code, signal, failed: false }), this.#drainMs);
			child.once("close", () => finish({ code, signal, failed: false }));
		});
		return {
			signal: (name) => {
				if (pid === undefined || child.exitCode !== null || child.signalCode !== null) return false;
				return killGroup(pid, name);
			},
			release,
		};
	}
}

export function pollEnvironment(env: NodeJS.ProcessEnv): Record<string, string> {
	const kept: Record<string, string> = {};
	for (const name of POLL_ENVIRONMENT) {
		const value = env[name];
		if (typeof value === "string") kept[name] = value;
	}
	kept.PATH ??= "/usr/local/bin:/usr/bin:/bin";
	return kept;
}

function killGroup(pid: number, signal: NodeJS.Signals): boolean {
	try {
		process.kill(-pid, signal);
		return true;
	} catch {
		return false;
	}
}
