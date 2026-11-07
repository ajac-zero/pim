/**
 * The `process` observer: reports the completion of one managed process,
 * named by the handle it was launched under, from the durable receipt its
 * supervisor wrote. Its contract is in docs/triggers-adapters.md.
 *
 * Inert. Nothing imports this module into pim-computer or its service; only
 * tests construct it. Pim has no managed launcher yet: nothing in
 * pim-computer starts a process under a handle, so in production no handle
 * resolves and every watch fails to start.
 *
 * It observes and nothing more. It never starts a process, never signals
 * one, and never looks a process up by name or by process id alone: a
 * handle resolves only to the launch intent a supervisor recorded, which
 * pins that supervisor by boot, process id and start time. A completion is
 * the supervisor's receipt for that same identity, or, when the supervisor
 * is gone without one, an outcome reported as unknown, never a guessed exit
 * code. Expiry, stopping, deleting the trigger and losing the lease end the
 * watch, never the process.
 */

import type { AdapterConfig, AdapterHealth, ComputerSource, Emit, ObserverAdapter, Observed, RuntimeClock, StopReason } from "../triggers-runtime.ts";
import { systemClock } from "./poll.ts";

export const PROCESS_WATCH = {
	/** How long a watch should last when whoever sets one has no reason to choose: what a planner offers by default. */
	defaultMs: 24 * 60 * 60_000,
	/** The longest a watch may last from when it starts (`TRIGGER_LIMITS.maxProcessWatchMs`). */
	maxMs: 7 * 24 * 60 * 60_000,
	/** How often the receipt and the supervisor are checked. */
	checkMs: 5_000,
} as const;

/** A handle is a random UUID, in lower case; anything else, a name above all, names no managed process. */
export const HANDLE_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/** One process instance: the boot it ran in, its process id, and its start time in that boot (Linux's `/proc/<pid>/stat` field 22). */
export type ProcessIdentity = { readonly bootId: string; readonly pid: number; readonly startTime: string };
/** What a supervisor records before it starts the job: that this handle is its own. */
export type LaunchIntent = { readonly version: 1; readonly handle: string; readonly supervisor: ProcessIdentity; readonly launchedAt: number };
/** What a supervisor records once its job has ended: how, and nothing it printed. */
export type CompletionReceipt = {
	readonly version: 1;
	readonly handle: string;
	readonly supervisor: ProcessIdentity;
	/** Set when the job exited; null when a signal ended it. */
	readonly exitCode: number | null;
	readonly signal: string | null;
	readonly endedAt: number;
};
export type ManagedRecord = { readonly intent: LaunchIntent; readonly receipt: CompletionReceipt | null };
/** Whether a supervisor still runs: `pid_reused` and `other_boot` are as gone as `exited`. */
export type Liveness = "running" | "exited" | "pid_reused" | "other_boot";

/**
 * Where managed processes' records come from. It reads; it can't start,
 * signal or stop anything, so neither can the adapter.
 */
export interface ManagedProcessProvider {
	/** The handle's intent and its receipt, if one was written; null for a handle never launched here. Throws when the records can't be read or are malformed. */
	read(handle: string): Promise<ManagedRecord | null>;
	/** Whether the process `identity` names runs now: in this boot, with that process id and that start time. */
	liveness(identity: ProcessIdentity): Promise<Liveness>;
}

export type ProcessAdapterOptions = {
	readonly provider: ManagedProcessProvider;
	readonly clock?: RuntimeClock;
	readonly checkMs?: number;
	/** The first wait before a completion the runtime couldn't take yet is tried again; it doubles up to `maxRetryMs`. */
	readonly retryMs?: number;
	readonly maxRetryMs?: number;
};

export class ProcessWatchError extends Error {
	readonly code: string;
	constructor(code: string) {
		super(code);
		this.code = code;
	}
}

export function sameIdentity(a: ProcessIdentity, b: ProcessIdentity): boolean {
	return a.bootId === b.bootId && a.pid === b.pid && a.startTime === b.startTime;
}

/** A receipt counts only for the handle and the supervisor its intent names. */
export function receiptMatches(intent: LaunchIntent, receipt: CompletionReceipt): boolean {
	return receipt.handle === intent.handle && sameIdentity(receipt.supervisor, intent.supervisor);
}

/**
 * One watch of one managed process. `start` resolves the handle to its
 * intent and pins it, or fails; then the receipt, and the supervisor's
 * liveness, are checked every `checkMs` until a completion is taken, the
 * watch expires, or it is stopped. The completion's key is the handle and
 * the supervisor's identity, so it is one event however often it is read,
 * by this watch or a later one.
 */
export class ProcessWatchAdapter implements ObserverAdapter {
	readonly #provider: ManagedProcessProvider;
	readonly #clock: RuntimeClock;
	readonly #checkMs: number;
	readonly #retryMs: number;
	readonly #maxRetryMs: number;
	#emit: Emit | null = null;
	#health: ((report: AdapterHealth) => void) | null = null;
	#handle = "";
	#expiresAt = 0;
	#intent: LaunchIntent | null = null;
	#fenced = false;
	#paused = false;
	/** Set once the watch has its answer, or none will come: nothing is checked after. */
	#settled = false;
	#timer: (() => void) | null = null;
	#completion: Observed | null = null;
	#emitting = false;
	#retryWait: number;
	#failing: string | null = null;

	constructor(options: ProcessAdapterOptions) {
		this.#provider = options.provider;
		this.#clock = options.clock ?? systemClock;
		const bounded = (name: string, value: number, min: number, max: number) => {
			if (!Number.isFinite(value) || value < min || value > max) throw new RangeError(`${name} must be from ${min} to ${max}`);
			return value;
		};
		this.#checkMs = bounded("checkMs", options.checkMs ?? PROCESS_WATCH.checkMs, 10, 60_000);
		this.#retryMs = bounded("retryMs", options.retryMs ?? 1_000, 10, 60_000);
		this.#maxRetryMs = bounded("maxRetryMs", options.maxRetryMs ?? 30_000, this.#retryMs, 600_000);
		this.#retryWait = this.#retryMs;
	}

	async start(config: AdapterConfig, emit: Emit, health: (report: AdapterHealth) => void): Promise<void> {
		const source: ComputerSource = config.source;
		if (source.kind !== "process") throw new ProcessWatchError("process_wrong_kind");
		if (!HANDLE_PATTERN.test(source.handle)) throw new ProcessWatchError("process_handle_invalid");
		const now = this.#clock.now();
		if (!Number.isSafeInteger(source.expiresAt) || source.expiresAt <= now) throw new ProcessWatchError("process_watch_expired");
		if (source.expiresAt - now > PROCESS_WATCH.maxMs) throw new ProcessWatchError("process_watch_too_long");
		const record = await this.#provider.read(source.handle);
		if (record === null) throw new ProcessWatchError("process_unknown_handle");
		if (record.intent.handle !== source.handle) throw new ProcessWatchError("process_identity_mismatch");
		this.#handle = source.handle;
		this.#expiresAt = source.expiresAt;
		this.#intent = record.intent;
		this.#emit = emit;
		this.#health = health;
		if (config.signal.aborted) return this.#fence();
		config.signal.addEventListener("abort", () => this.#fence(), { once: true });
		// The first check runs once `start` has returned, never inside it.
		this.#later(0, () => this.#check());
	}

	async stop(_reason: StopReason): Promise<void> {
		this.#fence();
	}

	pause(): void {
		this.#paused = true;
	}

	resume(): void {
		this.#paused = false;
		if (this.#completion && !this.#timer) void this.#deliver();
	}

	#fence(): void {
		this.#fenced = true;
		this.#settled = true;
		this.#timer?.();
		this.#timer = null;
		this.#completion = null;
	}

	#later(ms: number, run: () => void): void {
		this.#timer?.();
		this.#timer = this.#clock.setTimer(ms, () => {
			this.#timer = null;
			if (!this.#fenced) run();
		});
	}

	async #check(): Promise<void> {
		if (this.#settled) return;
		const intent = this.#intent as LaunchIntent;
		const now = this.#clock.now();
		const final = now >= this.#expiresAt;
		try {
			let record = await this.#provider.read(this.#handle);
			if (this.#settled) return;
			if (!record && !final) return this.#finish("error", "process_record_lost");
			if (record?.receipt) return this.#fromReceipt(record);
			if (final) return this.#finish("degraded", "process_watch_expired");
			const liveness = await this.#provider.liveness(intent.supervisor);
			if (this.#settled) return;
			if (liveness === "running") {
				this.#clear();
				return this.#later(Math.min(this.#checkMs, Math.max(0, this.#expiresAt - now)), () => this.#check());
			}
			// The supervisor is gone. Its receipt, written before it exited, may have landed since the first read.
			record = await this.#provider.read(this.#handle);
			if (this.#settled) return;
			if (record?.receipt) return this.#fromReceipt(record);
			if (!record) return this.#finish("error", "process_record_lost");
			this.#complete({ outcome: "unknown", exitCode: null, signal: null }, this.#clock.now());
		} catch {
			if (this.#settled) return;
			if (final) return this.#finish("degraded", "process_watch_expired");
			this.#report("degraded", "process_read_failed");
			this.#later(Math.min(this.#checkMs, Math.max(0, this.#expiresAt - now)), () => this.#check());
		}
	}

	#fromReceipt(record: ManagedRecord): void {
		const intent = this.#intent as LaunchIntent;
		const receipt = record.receipt as CompletionReceipt;
		if (record.intent.handle !== intent.handle || !sameIdentity(record.intent.supervisor, intent.supervisor) || !receiptMatches(intent, receipt)) {
			return this.#finish("error", "process_identity_mismatch");
		}
		// An end after the watch's time is not reported: the watch had expired by then.
		if (receipt.endedAt > this.#expiresAt) return this.#finish("degraded", "process_watch_expired");
		const outcome = receipt.signal === null ? "exited" : "signalled";
		this.#complete({ outcome, exitCode: receipt.exitCode, signal: receipt.signal }, receipt.endedAt);
	}

	#complete(status: { outcome: "exited" | "signalled" | "unknown"; exitCode: number | null; signal: string | null }, occurredAt: number): void {
		const supervisor = (this.#intent as LaunchIntent).supervisor;
		this.#settled = true;
		this.#completion = {
			occurredAt,
			data: { handle: this.#handle, outcome: status.outcome, exitCode: status.exitCode, signal: status.signal },
			checkpoint: null,
			key: `process:${this.#handle}:${supervisor.bootId}:${supervisor.pid}:${supervisor.startTime}`,
		};
		void this.#deliver();
	}

	async #deliver(): Promise<void> {
		const observed = this.#completion;
		if (!observed || this.#emitting || this.#fenced || this.#paused) return;
		this.#emitting = true;
		let result: Awaited<ReturnType<Emit>>;
		try {
			result = await (this.#emit as Emit)(observed);
		} catch {
			result = { ok: false, reason: "spool_unavailable" };
		}
		this.#emitting = false;
		if (this.#fenced || this.#completion !== observed) return;
		if (result.ok) {
			this.#completion = null;
			return;
		}
		switch (result.reason) {
			case "not_started":
			case "spool_unavailable": {
				const wait = this.#retryWait;
				this.#retryWait = Math.min(this.#maxRetryMs, wait * 2);
				return this.#later(wait, () => void this.#deliver());
			}
			case "backpressure":
				// An event is never given up for room: it waits for `resume`, and is emitted again, as the same event.
				this.#paused = true;
				return;
			case "stopped":
				return this.#fence();
			default:
				this.#completion = null;
				return this.#report("error", "process_completion_refused");
		}
	}

	/** Ends the watch without a completion. The process, whatever it is doing, is left alone. */
	#finish(status: AdapterHealth["status"], code: string): void {
		this.#settled = true;
		this.#timer?.();
		this.#timer = null;
		this.#report(status, code);
	}

	#clear(): void {
		if (this.#failing) {
			this.#failing = null;
			this.#health?.({ status: "ok", code: "process_watching" });
		}
	}

	#report(status: AdapterHealth["status"], code: string): void {
		if (this.#fenced || this.#failing === code) return;
		this.#failing = code;
		this.#health?.({ status, code });
	}
}
