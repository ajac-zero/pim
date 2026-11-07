/**
 * The `stream` observer: runs a source's shell command once, for as long as
 * it keeps running, and emits each line it prints, one bounded JSON object,
 * as an event. Its contract is in docs/triggers-stream.md.
 *
 * Behind a gate. `observerAdapters` (./index.ts) offers it when given stream
 * options, and only the triggers host (../triggers-host.ts) gives them,
 * which pim-computer loads only when `PIM_COMPUTER_TRIGGERS` is `internal`,
 * which nothing sets.
 *
 * The command runs as the user who runs pim-computer, with that user's
 * access. The runtime's host checks the grant before this adapter is ever
 * made; what this adapter enforces is only the lifecycle and resources of
 * its own child: one child, never started again, bounded buffers, and a
 * process group it started and signals only while that group is provably
 * its own. It confines nothing else.
 *
 * What it delivers is a prefix of what the command printed: every line, in
 * order, as one event each, until the stream ends; it never skips a line
 * and goes on. A line it can't deliver, a buffer it can't hold, an exit, or
 * anything else that ends the stream is reported as a code, and the stream
 * stays ended: nothing restarts the command but a new adapter.
 */

import { Buffer } from "node:buffer";
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import type { Readable } from "node:stream";
import {
	type AdapterConfig,
	type AdapterHealth,
	type ComputerSource,
	DEFAULT_LIMITS,
	type Emit,
	type EmitResult,
	type EndCoverage,
	type EndCoverageResult,
	type ObserverAdapter,
	type Observed,
	type RuntimeClock,
	type StopReason,
} from "../triggers-runtime.ts";
import { type ChildExit, POLL_LEADER, POLL_LIMITS, STOP_SLACK_MS, pollEnvironment, readPollOutput, systemClock } from "./poll.ts";

/**
 * The bounds a stream is read with. A command's length is the space's own
 * (`TRIGGER_LIMITS.commandLength`); an event's data is what the runtime and
 * the store take, as a poll's is.
 */
export const STREAM_LIMITS = {
	commandLength: 4_000,
	/** The most bytes one line may have, without its newline. */
	lineBytes: 65_536,
	/** The most bytes read and not yet emitted the adapter holds; past this it ends the stream. */
	bufferBytes: 1_048_576,
	/** Reading stops while this many bytes are held, so the command waits on its pipe instead. */
	readHighBytes: 131_072,
	dataBytes: POLL_LIMITS.dataBytes,
	dataDepth: POLL_LIMITS.dataDepth,
	dataValues: POLL_LIMITS.dataValues,
	/** The most bytes of stderr in one `stderrWindowMs`; past this the stream is ended. */
	stderrBytes: 65_536,
	stderrWindowMs: 60_000,
} as const;

export type StreamChildEvents = {
	stdout(chunk: Uint8Array): void;
	/** stdout reached its end: everything any writer printed has been passed to `stdout`. */
	stdoutEnd(): void;
	stderr(chunk: Uint8Array): void;
	/** Called once, when the child's leader has exited, or it could not be started (`failed`). */
	exit(result: ChildExit): void;
};
/** The one child a launcher started for this adapter. */
export interface StreamChild {
	/** Signals the child's own process group; false, with nothing sent, once its leader has exited. */
	signal(name: "SIGTERM" | "SIGKILL"): boolean;
	/** Stops reading stdout, so the command blocks on its pipe once the pipe is full. */
	pauseOutput(): void;
	resumeOutput(): void;
	/** Stops reading its output and lets go of its pipes. */
	release(): void;
}
/** Starts a stream's command. Injected, so tests run the adapter on a fake one. */
export interface StreamLauncher {
	launch(request: { readonly command: string; readonly cwd: string | null }, events: StreamChildEvents): StreamChild;
}

export type StreamAdapterOptions = {
	readonly launcher: StreamLauncher;
	readonly clock?: RuntimeClock;
	/** How long a child has after SIGTERM before SIGKILL. */
	readonly graceMs?: number;
	/** How long a child has after SIGKILL to be reaped before the adapter says it isn't. */
	readonly reapMs?: number;
	/** The runtime's `stopTimeoutMs` (10 s unless set). `stop` returns within `graceMs + reapMs + STOP_SLACK_MS`, which must be less than this. */
	readonly stopTimeoutMs?: number;
	/** How long, once the leader has exited, stdout is still read while some other process holds it open. */
	readonly drainMs?: number;
	/** The first wait before an emission the runtime couldn't take yet is tried again; it doubles up to `maxRetryMs`. */
	readonly retryMs?: number;
	readonly maxRetryMs?: number;
};

export class StreamConfigError extends Error {
	readonly code: string;
	constructor(code: string) {
		super(code);
		this.code = code;
	}
}

type StreamSource = Extract<ComputerSource, { kind: "stream" }>;

/** Reads a stream source's bounds as the space does; throws a `StreamConfigError` on any it doesn't meet. */
export function checkStreamSource(source: ComputerSource): StreamSource {
	if (source.kind !== "stream") throw new StreamConfigError("stream_wrong_kind");
	if (typeof source.command !== "string" || source.command.trim() === "" || source.command.length > STREAM_LIMITS.commandLength) throw new StreamConfigError("stream_command_invalid");
	if (source.cwd !== null && (typeof source.cwd !== "string" || !source.cwd.startsWith("/") || source.cwd.includes("\0"))) throw new StreamConfigError("stream_cwd_invalid");
	return source;
}

/** The longest an ended stream waits before saying so again. */
export const STREAM_REASSERT_MS = 60_000;

const NEWLINE = 0x0a;
const blank = (bytes: Uint8Array) => bytes.every((byte) => byte === 0x20 || byte === 0x09 || byte === 0x0d);

/**
 * One stream observer: one run of its command, started once `start` has
 * returned and never again. Each line it prints is parsed only when the
 * event before it has been taken, so at most one event waits to be emitted,
 * and only what the command printed is held besides, within
 * `STREAM_LIMITS.bufferBytes`; while that is high, or the runtime has paused
 * it, stdout isn't read and the command waits on its pipe.
 *
 * Each event's key is this adapter's own random nonce and the line's place
 * in the stream (`stream:<nonce>:<n>`), so a retry of the same line is the
 * same event and no two lines share one. A later adapter, with another
 * nonce, can't name the lines of this one: the command it runs again is a
 * new stream.
 */
export class StreamAdapter implements ObserverAdapter {
	readonly #launcher: StreamLauncher;
	readonly #clock: RuntimeClock;
	readonly #graceMs: number;
	readonly #reapMs: number;
	readonly #drainMs: number;
	readonly #retryMs: number;
	readonly #maxRetryMs: number;
	readonly #nonce = randomUUID();
	#sequence = 0;
	#source: StreamSource | null = null;
	#emit: Emit | null = null;
	#health: ((report: AdapterHealth) => void) | null = null;
	#endCoverage: EndCoverage | null = null;
	/** Set at stop or abort: from then on nothing is read, emitted or reported. */
	#fenced = false;
	#paused = false;
	/** How many times `resume` was called, so a `backpressure` answer that crossed a resume isn't waited on. */
	#resumes = 0;
	/** Timers of reading and delivery, cancelled at the fence. */
	readonly #timers = new Set<() => void>();
	/** Timers that end the child, which outlive the fence and stop once it has exited. */
	readonly #killTimers = new Set<() => void>();
	#child: StreamChild | null = null;
	/** Whether the leader has exited and been reaped, or never started. */
	#exited = false;
	readonly #done: Promise<void>;
	#finish: () => void = () => {};
	/** Whether nothing more of stdout will be taken: it ended, or the adapter stopped taking it. */
	#eof = false;
	/** Whether the adapter itself ended the stream, and so takes no trailing record without a newline. */
	#closed = false;
	#reading = true;
	#released = false;
	#killing = false;
	#unreaped = false;
	/** What was read and not yet parsed, with when each chunk arrived. */
	#held: { bytes: Buffer; at: number }[] = [];
	#heldBytes = 0;
	/** Bytes held after the last newline: the line still being printed. */
	#tail = 0;
	#stderrSince = 0;
	#stderrBytes = 0;
	/** The one event parsed and not yet taken by the runtime. */
	#retained: Observed | null = null;
	#emitting = false;
	#retrying = false;
	#retryWait: number;
	/** When coverage ended, and why: set once. */
	#ended: { readonly at: number; readonly code: string } | null = null;
	/** Where recording the end stands: `refused` when the runtime called it invalid, after which only health tells of it. */
	#coverage: "open" | "recording" | "waiting" | "recorded" | "refused" = "open";
	#reassertWait = 1_000;
	/** Set once cleanup is unknown: that code stays the last thing reported. */
	#sticky = false;
	#last: string | null = null;

	constructor(options: StreamAdapterOptions) {
		this.#launcher = options.launcher;
		this.#clock = options.clock ?? systemClock;
		const bounded = (name: string, value: number, min: number, max: number) => {
			if (!Number.isFinite(value) || value < min || value > max) throw new RangeError(`${name} must be from ${min} to ${max}`);
			return value;
		};
		this.#graceMs = bounded("graceMs", options.graceMs ?? 2_000, 10, 5_000);
		this.#reapMs = bounded("reapMs", options.reapMs ?? 2_000, 10, 5_000);
		const stopTimeoutMs = options.stopTimeoutMs ?? DEFAULT_LIMITS.stopTimeoutMs;
		if (this.#graceMs + this.#reapMs + STOP_SLACK_MS >= stopTimeoutMs) throw new RangeError(`graceMs + reapMs + ${STOP_SLACK_MS} must be less than stopTimeoutMs (${stopTimeoutMs})`);
		this.#drainMs = bounded("drainMs", options.drainMs ?? 1_000, 10, 5_000);
		this.#retryMs = bounded("retryMs", options.retryMs ?? 1_000, 10, 60_000);
		this.#maxRetryMs = bounded("maxRetryMs", options.maxRetryMs ?? 30_000, this.#retryMs, 600_000);
		this.#retryWait = this.#retryMs;
		this.#done = new Promise<void>((resolve) => (this.#finish = resolve));
	}

	async start(config: AdapterConfig, emit: Emit, health: (report: AdapterHealth) => void): Promise<void> {
		this.#source = checkStreamSource(config.source);
		this.#emit = emit;
		this.#health = health;
		this.#endCoverage = config.endCoverage ?? null;
		if (config.signal.aborted) return this.#fence();
		config.signal.addEventListener("abort", () => this.#fence(), { once: true });
		// The command starts once `start` has returned, never inside it.
		this.#later(0, () => this.#launch());
	}

	async stop(_reason: StopReason): Promise<void> {
		this.#fence();
		const child = this.#child;
		if (!child || this.#exited) return;
		// Bounded: SIGTERM, the grace, SIGKILL and the wait to be reaped, and a little over, within the runtime's own bound.
		let cancel = () => {};
		await Promise.race([this.#done, new Promise<void>((resolve) => (cancel = this.#clock.setTimer(this.#graceMs + this.#reapMs + STOP_SLACK_MS, resolve)))]);
		cancel();
		this.#release();
	}

	pause(): void {
		this.#paused = true;
		this.#flow();
	}

	resume(): void {
		this.#paused = false;
		this.#resumes++;
		this.#flow();
		this.#pump();
	}

	/** From now on nothing is read, emitted or reported, everything held is dropped, and its own child, if it runs, is ended. */
	#fence(): void {
		if (this.#fenced) return;
		this.#fenced = true;
		for (const cancel of this.#timers) cancel();
		this.#timers.clear();
		this.#retained = null;
		this.#discard();
		this.#closed = true;
		this.#eof = true;
		if (this.#exited) this.#release();
		else this.#kill();
	}

	#later(ms: number, run: () => void): void {
		const cancel = this.#clock.setTimer(ms, () => {
			this.#timers.delete(cancel);
			if (!this.#fenced) run();
		});
		this.#timers.add(cancel);
	}

	#launch(): void {
		const source = this.#source as StreamSource;
		this.#stderrSince = this.#clock.now();
		try {
			this.#child = this.#launcher.launch(
				{ command: source.command, cwd: source.cwd },
				{
					stdout: (chunk) => this.#read(chunk),
					stdoutEnd: () => this.#readEnd(),
					// What a stream writes to stderr is counted and dropped, never kept, logged or sent.
					stderr: (chunk) => this.#readStderr(chunk),
					exit: (result) => this.#exit(result),
				},
			);
		} catch {
			this.#exited = true;
			this.#eof = true;
			this.#finish();
			this.#endWith("stream_spawn_failed", this.#clock.now());
			return this.#settle();
		}
		if (this.#released) this.#child.release();
		else if (this.#fenced && !this.#exited) this.#kill();
		this.#flow();
	}

	#read(chunk: Uint8Array): void {
		if (this.#fenced || this.#eof) return;
		const at = this.#clock.now();
		if (this.#heldBytes + chunk.byteLength > STREAM_LIMITS.bufferBytes) {
			this.#close("stream_output_overflow", at);
			return this.#pump();
		}
		const bytes = Buffer.from(chunk);
		const newline = bytes.lastIndexOf(NEWLINE);
		this.#tail = newline === -1 ? this.#tail + bytes.byteLength : bytes.byteLength - newline - 1;
		this.#held.push({ bytes, at });
		this.#heldBytes += bytes.byteLength;
		if (this.#tail > STREAM_LIMITS.lineBytes) this.#close("stream_line_too_large", at);
		this.#flow();
		this.#pump();
	}

	#readEnd(): void {
		if (this.#fenced || this.#eof) return;
		this.#eof = true;
		const at = this.#clock.now();
		// A command that closes its output and runs on prints no more events: unless it exits soon, as it does at its end, it is ended.
		if (!this.#exited)
			this.#later(this.#drainMs, () => {
				if (this.#exited) return;
				this.#endWith("stream_output_closed", at);
				this.#kill();
			});
		this.#pump();
	}

	#readStderr(chunk: Uint8Array): void {
		if (this.#fenced || this.#closed) return;
		const now = this.#clock.now();
		if (now - this.#stderrSince >= STREAM_LIMITS.stderrWindowMs) {
			this.#stderrSince = now;
			this.#stderrBytes = 0;
		}
		this.#stderrBytes += chunk.byteLength;
		if (this.#stderrBytes > STREAM_LIMITS.stderrBytes) {
			this.#close("stream_stderr_flood", now);
			this.#pump();
		}
	}

	#exit(result: ChildExit): void {
		if (this.#exited) return;
		this.#exited = true;
		for (const cancel of this.#killTimers) cancel();
		this.#killTimers.clear();
		this.#finish();
		if (this.#fenced) return this.#release();
		const at = this.#clock.now();
		// A child that never started printed nothing, and its pipes may never report an end.
		if (result.failed) this.#eof = true;
		if (!result.cleaned) {
			// What is left of its group may still run, and can't be signalled safely. Nothing is reported after this.
			this.#report("error", "stream_cleanup_unknown");
			this.#sticky = true;
		}
		if (!this.#ended) this.#endWith(result.failed ? "stream_spawn_failed" : result.code === 0 && result.signal === null ? "stream_ended" : "stream_failed", at);
		else if (this.#unreaped) this.#report("error", this.#ended.code);
		if (!this.#eof) {
			// Its group is gone; what it printed may still be in the pipe. Read it to its end, or for `drainMs` while something outside the group holds it open.
			this.#later(this.#drainMs, () => {
				if (this.#eof) return;
				this.#close("stream_output_unclosed", this.#clock.now());
				this.#pump();
			});
		}
		this.#flow();
		this.#pump();
	}

	/**
	 * The adapter ends the stream: nothing more is read, the line being
	 * printed is dropped, and its child is ended. Complete lines read before
	 * it are still emitted.
	 */
	#close(code: string, at: number): void {
		this.#endWith(code, at);
		if (this.#closed) return;
		this.#closed = true;
		this.#eof = true;
		this.#dropTail();
		this.#flow();
		this.#kill();
	}

	/** Coverage ends here, the first time; every end is reported, as its own code. */
	#endWith(code: string, at: number): void {
		if (!this.#ended) {
			this.#ended = { at, code };
			this.#reassert();
		}
		this.#report("error", code);
	}

	/**
	 * Says again, after 1 s, doubling to a minute, and until it is stopped,
	 * the last code it reported. The runtime drops health before an observer
	 * is installed and while no connection is reconciled, so the one report
	 * of an end could be lost, and the stream look as if it were listening.
	 */
	#reassert(): void {
		const wait = this.#reassertWait;
		this.#reassertWait = Math.min(STREAM_REASSERT_MS, wait * 2);
		this.#later(wait, () => {
			// Once the runtime has the end durably (`endCoverage`), it says `ended` on every reconcile, and health need not repeat it.
			if (this.#coverage === "recorded") return;
			if (this.#last) this.#health?.({ status: "error", code: this.#last });
			this.#reassert();
		});
	}

	#dropTail(): void {
		let drop = this.#tail;
		while (drop > 0) {
			const last = this.#held.at(-1) as { bytes: Buffer; at: number };
			const cut = Math.min(drop, last.bytes.byteLength);
			if (cut === last.bytes.byteLength) this.#held.pop();
			else last.bytes = last.bytes.subarray(0, last.bytes.byteLength - cut);
			this.#heldBytes -= cut;
			drop -= cut;
		}
		this.#tail = 0;
	}

	#discard(): void {
		this.#held = [];
		this.#heldBytes = 0;
		this.#tail = 0;
	}

	/** Reads stdout only while there is room and the runtime hasn't paused it; once its leader has exited, until its end, whatever the pause. */
	#flow(): void {
		const want = !this.#eof && (this.#exited || (!this.#paused && this.#heldBytes < STREAM_LIMITS.readHighBytes));
		if (!this.#child || this.#released || want === this.#reading) return;
		this.#reading = want;
		if (want) this.#child.resumeOutput();
		else this.#child.pauseOutput();
	}

	/** The next complete line, with when it was complete; at a natural end, the record left without a newline. */
	#take(): { bytes: Buffer; at: number } | null {
		let scanned = 0;
		for (let index = 0; index < this.#held.length; index++) {
			const chunk = this.#held[index] as { bytes: Buffer; at: number };
			const newline = chunk.bytes.indexOf(NEWLINE);
			if (newline === -1) {
				scanned += chunk.bytes.byteLength;
				continue;
			}
			const parts = this.#held.slice(0, index).map((held) => held.bytes);
			parts.push(chunk.bytes.subarray(0, newline));
			const rest = chunk.bytes.subarray(newline + 1);
			this.#held = rest.byteLength > 0 ? [{ bytes: rest, at: chunk.at }, ...this.#held.slice(index + 1)] : this.#held.slice(index + 1);
			this.#heldBytes -= scanned + newline + 1;
			return { bytes: Buffer.concat(parts), at: chunk.at };
		}
		if (!this.#eof || this.#closed || !this.#exited || this.#held.length === 0) return null;
		const at = (this.#held.at(-1) as { at: number }).at;
		const bytes = Buffer.concat(this.#held.map((held) => held.bytes));
		this.#discard();
		return { bytes, at };
	}

	/** Parses lines until one is an event waiting to be emitted, then emits it; ends the stream at the first line that can't be one. */
	#pump(): void {
		while (!this.#fenced && this.#retained === null) {
			const line = this.#take();
			if (!line) break;
			if (blank(line.bytes)) continue;
			const output = line.bytes.byteLength > STREAM_LIMITS.lineBytes ? { ok: false as const, code: "line" as const } : readPollOutput(line.bytes);
			if (!output.ok) {
				// What follows it is never emitted: the stream is a prefix of what was printed, or nothing.
				this.#discard();
				this.#close(output.code === "line" ? "stream_line_too_large" : output.code === "poll_output_too_large" ? "stream_event_too_large" : "stream_invalid_output", line.at);
				break;
			}
			this.#retained = { occurredAt: line.at, data: output.data, checkpoint: null, key: `stream:${this.#nonce}:${this.#sequence++}` };
		}
		this.#flow();
		if (this.#retained) void this.#deliver();
		else this.#settle();
	}

	async #deliver(): Promise<void> {
		const observed = this.#retained;
		if (!observed || this.#emitting || this.#retrying || this.#fenced || this.#paused) return;
		this.#emitting = true;
		const resumes = this.#resumes;
		let result: EmitResult;
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
			return this.#pump();
		}
		switch (result.reason) {
			case "not_started":
			case "spool_unavailable": {
				// Nothing of it was kept: keep it, read no further than the buffers allow, and try again as the same event.
				const wait = this.#retryWait;
				this.#retryWait = Math.min(this.#maxRetryMs, wait * 2);
				this.#retrying = true;
				return this.#later(wait, () => {
					this.#retrying = false;
					void this.#deliver();
				});
			}
			case "backpressure":
				// Kept, and emitted again, the same event, once the runtime resumes it; meanwhile nothing more is read. A resume that came while it was refused counts.
				if (resumes === this.#resumes) this.#paused = true;
				this.#flow();
				return void this.#deliver();
			case "stopped":
				return this.#fence();
			default:
				// `too_large` or `invalid`: this event is lost, so the stream ends before it.
				this.#retained = null;
				this.#discard();
				this.#close(result.reason === "too_large" ? "stream_event_too_large" : "stream_event_refused", observed.occurredAt);
				return this.#pump();
		}
	}

	/** Once the child has exited and its output is done with, lets go of its pipes; once everything read has been emitted, records where coverage ended. */
	#settle(): void {
		if (this.#fenced || !this.#exited || !this.#eof) return;
		this.#release();
		if (this.#retained || this.#emitting || this.#held.length > 0) return;
		void this.#recordEnd();
	}

	#release(): void {
		if (this.#released) return;
		this.#released = true;
		this.#child?.release();
	}

	async #recordEnd(): Promise<void> {
		const ended = this.#ended;
		const endCoverage = this.#endCoverage;
		if (!ended || !endCoverage || this.#coverage !== "open") return;
		this.#coverage = "recording";
		let result: EndCoverageResult;
		try {
			result = await endCoverage({ at: ended.at, code: ended.code });
		} catch {
			result = "unavailable";
		}
		if (this.#fenced) return;
		if (result === "recorded") {
			this.#coverage = "recorded";
			return;
		}
		if (result === "stopped") return this.#fence();
		if (result === "invalid") {
			this.#coverage = "refused";
			return;
		}
		this.#coverage = "waiting";
		const wait = this.#retryWait;
		this.#retryWait = Math.min(this.#maxRetryMs, wait * 2);
		this.#later(wait, () => {
			this.#coverage = "open";
			void this.#recordEnd();
		});
	}

	/** Ends its own child: SIGTERM to its group, SIGKILL after the grace, and a report if it still isn't reaped after that. */
	#kill(): void {
		const child = this.#child;
		if (!child || this.#killing || this.#exited) return;
		this.#killing = true;
		child.signal("SIGTERM");
		const later = (ms: number, run: () => void) => {
			const cancel = this.#clock.setTimer(ms, () => {
				this.#killTimers.delete(cancel);
				if (!this.#exited) run();
			});
			this.#killTimers.add(cancel);
		};
		later(this.#graceMs, () => {
			child.signal("SIGKILL");
			later(this.#reapMs, () => {
				this.#unreaped = true;
				this.#report("error", "stream_unreaped");
			});
		});
	}

	#report(status: AdapterHealth["status"], code: string): void {
		if (this.#fenced || this.#sticky || this.#last === code) return;
		this.#last = code;
		this.#health?.({ status, code });
	}
}

export type NodeStreamLauncherOptions = {
	/** The working folder of a stream whose source names none. */
	readonly defaultCwd: string;
	/** The shell that runs a command with `-c`, under the leader; `/bin/sh` unless set. */
	readonly shell?: string;
	/** The whole environment a stream gets; `POLL_ENVIRONMENT` of this process's unless set. */
	readonly env?: Readonly<Record<string, string>>;
	/** How long after the leader exits its status may still be read. */
	readonly statusMs?: number;
	/** Sends a signal; `process.kill` unless set. Tests watch it. */
	readonly kill?: (pid: number, signal: NodeJS.Signals) => void;
};

/**
 * Runs a command under the poll's leader (`POLL_LEADER`), in a process group
 * of its own, with stdin closed, as `NodeChildLauncher` does, and with the
 * same rule for signals: the group is signalled only by the leader before it
 * exits, and by `signal` only while the leader, this launcher's own child,
 * is unreaped. Once Node has reaped it (`exitCode` or `signalCode` set) the
 * group is never signalled from here again. What this launcher adds is flow
 * control: stdout can be paused, so a command that prints faster than its
 * events are taken waits on its pipe, and `exit` doesn't wait for stdout's
 * end, which is reported apart, so the adapter reads it to its end at its
 * own pace.
 */
export class NodeStreamLauncher implements StreamLauncher {
	readonly #defaultCwd: string;
	readonly #shell: string;
	readonly #env: Readonly<Record<string, string>>;
	readonly #statusMs: number;
	readonly #kill: (pid: number, signal: NodeJS.Signals) => void;

	constructor(options: NodeStreamLauncherOptions) {
		if (!options.defaultCwd.startsWith("/")) throw new RangeError("defaultCwd must be an absolute path");
		this.#defaultCwd = options.defaultCwd;
		this.#shell = options.shell ?? "/bin/sh";
		this.#env = options.env ?? pollEnvironment(process.env);
		this.#statusMs = options.statusMs ?? 250;
		this.#kill = options.kill ?? ((pid, signal) => process.kill(pid, signal));
	}

	launch(request: { readonly command: string; readonly cwd: string | null }, events: StreamChildEvents): StreamChild {
		const child = spawn("/bin/sh", ["-c", POLL_LEADER, "pim-stream", this.#shell, request.command], {
			cwd: request.cwd ?? this.#defaultCwd,
			detached: true,
			stdio: ["ignore", "pipe", "pipe", "pipe"],
			env: { ...this.#env },
			windowsHide: true,
		});
		const pid = child.pid;
		const statusPipe = child.stdio[3] as Readable | null;
		let status = "";
		let statusClosed = false;
		/** Set once SIGKILL reached the whole group while its leader was still this launcher's. */
		let killed = false;
		let released = false;
		let reported = false;
		let wait: ReturnType<typeof setTimeout> | undefined;
		const release = () => {
			released = true;
			child.stdout?.destroy();
			child.stderr?.destroy();
			statusPipe?.destroy();
		};
		const finish = (result: ChildExit) => {
			if (reported) return;
			reported = true;
			clearTimeout(wait);
			statusPipe?.destroy();
			events.exit(result);
		};
		/** The command's own exit, when the leader lived to report it; otherwise how the leader ended. Cleanup counts as done as `NodeChildLauncher` counts it. */
		const exited = (code: number | null, signal: NodeJS.Signals | null): ChildExit => {
			const told = /^([0-9]{1,3})\n$/.exec(status);
			if (told && Number(told[1]) <= 255) return { code: Number(told[1]), signal: null, failed: false, cleaned: signal === "SIGKILL" || killed };
			return { code, signal, failed: false, cleaned: killed };
		};
		child.stdout?.on("data", (chunk: Buffer) => {
			if (!released) events.stdout(chunk);
		});
		child.stdout?.on("end", () => {
			if (!released) events.stdoutEnd();
		});
		child.stderr?.on("data", (chunk: Buffer) => {
			if (!released) events.stderr(chunk);
		});
		statusPipe?.on("data", (chunk: Buffer) => {
			if (status.length < 8) status += chunk.toString("latin1").slice(0, 8);
		});
		statusPipe?.on("close", () => {
			statusClosed = true;
		});
		for (const stream of [child.stdout, child.stderr, statusPipe]) stream?.on("error", () => {});
		child.on("error", () => {
			// Only a child that never started gets here without an exit: nothing of it runs.
			if (pid === undefined) finish({ code: null, signal: null, failed: true, cleaned: true });
		});
		child.on("exit", (code, signal) => {
			// Reaped: its group is never signalled from here again. Its status, written before it exited, is read first.
			if (statusClosed || !statusPipe) return finish(exited(code, signal));
			wait = setTimeout(() => finish(exited(code, signal)), this.#statusMs);
			statusPipe.once("close", () => finish(exited(code, signal)));
		});
		return {
			signal: (name) => {
				if (pid === undefined || child.exitCode !== null || child.signalCode !== null) return false;
				try {
					this.#kill(-pid, name);
					if (name === "SIGKILL") killed = true;
					return true;
				} catch {
					return false;
				}
			},
			pauseOutput: () => {
				child.stdout?.pause();
			},
			resumeOutput: () => {
				if (!released) child.stdout?.resume();
			},
			release,
		};
	}
}
