import { MAX_NATIVE_BINDINGS } from "./cua-native-identity";

/**
 * Pim's side of fencing native-app calls (docs/cua-native-fence-obligations.md):
 * for each run whose calls may have been sent, a durable record of whether
 * the broker that sends them has been asked to send nothing more of that run,
 * and whether it said so. A fence concerns only new sends by the broker of
 * that run. It doesn't say the desktop stopped, or that a call already sent
 * didn't run, and it doesn't touch any other program on the desktop.
 *
 * A run gets a record (`open`) when one of its calls is admitted, before the
 * control state admits it and before its send is authorized, so no call is
 * sent without one. A Stop that marked the run, an end the call can't be sure
 * of, or a restart that finds a call of the run unknown requires its fence
 * (`pending`); an acknowledgement from the broker instance the run's calls
 * were admitted under, recorded durably, confirms it (`confirmed`). One that
 * can't be had is `unconfirmed`, never success. A run whose fence was
 * required admits nothing more, for good.
 *
 * There is no broker yet: the transport is a seam that only tests give a
 * scripted stand-in for (`Pim.nativeFenceTransport`). Without one, every
 * fence is `unconfirmed`.
 *
 * Records live in the space's SQL storage, apart from the harness's, so no
 * write here is in a transaction with a harness commit. Every write is
 * followed by `sync`. A write or sync that fails latches this object: it
 * admits nothing and records nothing more for as long as the process lives.
 * A new process admits nothing until `reconcile` has rebuilt what the durable
 * binder records require, from records every possible send was claimed in
 * before it left (./cua-native-identity.ts).
 */

/** Asks a broker instance to send nothing more of a run. */
export type NativeFenceRequest = Readonly<{ fenceId: string; run: string; instance: string }>;

/** How Pim reaches the broker for fences. Nothing in Pim implements it; tests give a scripted one. */
export type NativeFenceTransport = {
	/** The broker instance this transport reaches now, or null when it can't name one. */
	instance(): string | null;
	/** Asks `request.instance` to fence `request.run`. Resolves with its acknowledgement, which is `request` itself, echoed. */
	fence(request: NativeFenceRequest): Promise<unknown>;
};

/**
 * `open`: calls of the run were admitted and no fence is required. `pending`:
 * required and asked for, not acknowledged. `confirmed`: acknowledged by the
 * instance it was asked of, durably recorded. `unconfirmed`: required, and no
 * acknowledgement could be had or counted.
 */
export type NativeFenceState = "open" | "pending" | "confirmed" | "unconfirmed";
/** Why a fence was required: a Stop that marked its run, a call whose end is unknown, or a restart that found one. */
export type NativeFenceReason = "stop" | "unknown" | "recovered";
export type NativeFenceRecord = Readonly<{
	run: string;
	/** The broker instance the run's calls were admitted under, or null when there was none to name. */
	instance: string | null;
	state: NativeFenceState;
	fenceId: string | null;
	reason: NativeFenceReason | null;
	requiredAt: number | null;
	confirmedAt: number | null;
}>;

/**
 * The most runs on record. Every record is the run of a binding the binder
 * accepted, and the binder accepts at most `MAX_NATIVE_BINDINGS` over the
 * space's life, so this bound is only reached by a store that is wrong; past
 * it, admission is refused and nothing is let go.
 */
export const MAX_NATIVE_FENCES = MAX_NATIVE_BINDINGS;

const SCHEMA = `
CREATE TABLE IF NOT EXISTS pim_native_fences (
	run TEXT PRIMARY KEY,
	instance TEXT,
	state TEXT NOT NULL,
	fence_id TEXT UNIQUE,
	reason TEXT,
	required_at INTEGER,
	confirmed_at INTEGER
)`;

export class NativeFences {
	readonly #sql: SqlStorage;
	readonly #sync: () => Promise<void>;
	readonly #transport: () => NativeFenceTransport | null;
	readonly #newId: () => string;
	readonly #now: () => number;
	#schema = false;
	/** Why a write failed in this process; never cleared in it. */
	#fault: string | null = null;
	/** Whether this process has rebuilt what the durable binder records require (`reconcile`). */
	#ready = false;
	#reconciling: Promise<string | null> | undefined;
	/** Fences being asked for now, so one isn't asked twice at once. */
	readonly #asking = new Set<string>();

	constructor(options: { sql: SqlStorage; sync: () => Promise<void>; transport: () => NativeFenceTransport | null; newId?: () => string; now?: () => number }) {
		this.#sql = options.sql;
		this.#sync = options.sync;
		this.#transport = options.transport;
		this.#newId = options.newId ?? (() => crypto.randomUUID());
		this.#now = options.now ?? Date.now;
	}

	/** Every record, by run. Creates the table the first time, which nothing does where the desktop's tools are off. */
	list(): NativeFenceRecord[] {
		return this.#rows("SELECT * FROM pim_native_fences ORDER BY run");
	}

	/** Why nothing is admitted in this process, or null. */
	blocked(): string | null {
		return this.#fault ?? (this.#ready ? null : "the native fences haven't been reconciled since the space started");
	}

	/**
	 * Rebuilds, once per process and before anything is admitted, the fences
	 * the durable binder records require: every run with a call whose end is
	 * unknown, which includes every call claimed by a process that ended.
	 * `unknownRuns` reads them (`NativeIdentityBinder.unknownRuns`) and
	 * answers why it can't, as text. Fences required before and not
	 * confirmed are asked for again, by the same fence ID: asking again for a
	 * fence's status is not sending a call again. Resolves with why nothing
	 * may be admitted, or null.
	 */
	reconcile(unknownRuns: () => Promise<readonly string[] | string>): Promise<string | null> {
		if (this.#fault) return Promise.resolve(this.#fault);
		if (this.#ready) return Promise.resolve(null);
		this.#reconciling ??= (async () => {
			let runs: readonly string[] | string;
			try {
				runs = await unknownRuns();
			} catch {
				runs = "the native bindings couldn't be read";
			}
			if (typeof runs === "string") {
				// Nothing was learned, so a later admission tries again.
				this.#reconciling = undefined;
				return runs;
			}
			if (!(await this.#require(runs, "recovered"))) return this.#fault ?? "the native fences couldn't be stored";
			this.#ready = true;
			this.#askAll();
			return null;
		})();
		return this.#reconciling;
	}

	/**
	 * Admits a call of `run`, before the control state does and before its
	 * send is authorized: its run's record is stored, under the broker
	 * instance the transport names now, and synced. Refused, with why, if
	 * this process hasn't reconciled or can't write, if the run's fence was
	 * required, if the run's calls were admitted under another instance, or
	 * if no record more can be kept.
	 */
	async admit(run: string): Promise<string | null> {
		const blocked = this.blocked();
		if (blocked) return blocked;
		let instance: string | null;
		try {
			instance = this.#transport()?.instance() ?? null;
		} catch {
			return "the broker's instance can't be named";
		}
		try {
			const row = this.#row(run);
			if (row && row.state !== "open") return "a fence was required for this run, which sends nothing more";
			if (row && row.instance !== instance) return "this run's calls were admitted under another broker instance";
			if (!row) {
				if (this.#count() >= MAX_NATIVE_FENCES) return "no more runs' fences can be kept";
				this.#sql.exec("INSERT INTO pim_native_fences (run, instance, state) VALUES (?, ?, 'open')", run, instance);
			}
			await this.#sync();
		} catch {
			return this.#latch("a native fence record couldn't be stored");
		}
		return this.#fault;
	}

	/**
	 * Requires the fence of each of `runs` that has a record: from a Stop,
	 * the runs its marking commit reported (`ConversationAbortEffect.marked`);
	 * from a call whose end is unknown, its run. A run without a record had
	 * no call admitted, so none sent, and gets none from a Stop. Each run has
	 * one fence, whatever asks for it again. Stored and synced, then asked
	 * for. Never throws: a failure latches this object.
	 */
	async require(runs: readonly string[], reason: Exclude<NativeFenceReason, "recovered">): Promise<void> {
		await this.#require(runs, reason);
		this.#askAll();
	}

	async #require(runs: readonly string[], reason: NativeFenceReason): Promise<boolean> {
		if (this.#fault) return false;
		try {
			for (const run of new Set(runs)) {
				let row = this.#row(run);
				if (!row) {
					// A Stop needs none for a run nothing was admitted in. A call of the run that may have been sent needs one regardless.
					if (reason === "stop") continue;
					if (this.#count() >= MAX_NATIVE_FENCES) {
						this.#latch("no more runs' fences can be kept");
						return false;
					}
					this.#sql.exec("INSERT INTO pim_native_fences (run, instance, state) VALUES (?, NULL, 'open')", run);
					row = this.#row(run)!;
				}
				if (row.state !== "open") continue;
				// With no instance to ask, nothing can acknowledge it.
				const state: NativeFenceState = row.instance === null ? "unconfirmed" : "pending";
				this.#sql.exec(
					"UPDATE pim_native_fences SET state = ?, fence_id = ?, reason = ?, required_at = ? WHERE run = ? AND state = 'open'",
					state,
					this.#newId(),
					reason,
					this.#now(),
					run,
				);
			}
			await this.#sync();
			return true;
		} catch {
			this.#latch("a native fence couldn't be stored");
			return false;
		}
	}

	/** Asks for every fence required and not confirmed, each once at a time. */
	#askAll(): void {
		if (this.#fault) return;
		let rows: NativeFenceRecord[];
		try {
			rows = this.#rows("SELECT * FROM pim_native_fences WHERE state IN ('pending', 'unconfirmed')");
		} catch {
			this.#latch("the native fences couldn't be read");
			return;
		}
		for (const row of rows) {
			if (row.fenceId === null || this.#asking.has(row.fenceId)) continue;
			this.#asking.add(row.fenceId);
			void this.#ask(row).finally(() => this.#asking.delete(row.fenceId!));
		}
	}

	/**
	 * Asks the instance the run's calls were admitted under for its fence. A
	 * transport that reaches another instance, or none, can't confirm it:
	 * a new instance doesn't show the old one sends nothing more.
	 */
	async #ask(row: NativeFenceRecord): Promise<void> {
		const transport = this.#transport();
		let now: string | null = null;
		try {
			now = transport?.instance() ?? null;
		} catch {
			now = null;
		}
		if (!transport || row.instance === null || now !== row.instance) return this.#lapse(row.fenceId!);
		const request: NativeFenceRequest = Object.freeze({ fenceId: row.fenceId!, run: row.run, instance: row.instance });
		let answer: unknown;
		try {
			answer = await transport.fence(request);
		} catch {
			// The answer is lost, or the instance refused: unconfirmed until it is asked again and answers.
			return this.#lapse(request.fenceId);
		}
		if (!sameRequest(answer, request)) return this.#lapse(request.fenceId);
		await this.#confirm(request);
	}

	/** Counts an acknowledgement `#ask` checked against its request: only while its fence is still required, and only once synced. */
	async #confirm(request: NativeFenceRequest): Promise<void> {
		if (this.#fault) return;
		let before: NativeFenceRecord | undefined;
		try {
			before = this.#row(request.run);
			if (!before || before.fenceId !== request.fenceId || (before.state !== "pending" && before.state !== "unconfirmed")) return;
			this.#sql.exec("UPDATE pim_native_fences SET state = 'confirmed', confirmed_at = ? WHERE run = ? AND fence_id = ?", this.#now(), request.run, request.fenceId);
			await this.#sync();
		} catch {
			// Not counted: what this process reads goes back to what it was, and nothing more is recorded here.
			try {
				if (before) this.#sql.exec("UPDATE pim_native_fences SET state = ?, confirmed_at = NULL WHERE run = ? AND fence_id = ?", before.state, request.run, request.fenceId);
			} catch {
				// The latch below stands either way.
			}
			this.#latch("a native fence's acknowledgement couldn't be stored");
		}
	}

	/** A fence still pending that can't be acknowledged now is unconfirmed; a later acknowledgement may still confirm it. */
	async #lapse(fenceId: string): Promise<void> {
		if (this.#fault) return;
		try {
			this.#sql.exec("UPDATE pim_native_fences SET state = 'unconfirmed' WHERE fence_id = ? AND state = 'pending'", fenceId);
			await this.#sync();
		} catch {
			this.#latch("a native fence couldn't be stored");
		}
	}

	#latch(why: string): string {
		this.#fault ??= why;
		return this.#fault;
	}

	#row(run: string): NativeFenceRecord | undefined {
		return this.#rows("SELECT * FROM pim_native_fences WHERE run = ?", run)[0];
	}

	#count(): number {
		this.#ensure();
		return Number(this.#sql.exec("SELECT COUNT(*) AS n FROM pim_native_fences").one().n);
	}

	#rows(query: string, ...bindings: unknown[]): NativeFenceRecord[] {
		this.#ensure();
		return this.#sql
			.exec(query, ...bindings)
			.toArray()
			.map((row) => ({
				run: String(row.run),
				instance: row.instance === null ? null : String(row.instance),
				state: String(row.state) as NativeFenceState,
				fenceId: row.fence_id === null ? null : String(row.fence_id),
				reason: row.reason === null ? null : (String(row.reason) as NativeFenceReason),
				requiredAt: row.required_at === null ? null : Number(row.required_at),
				confirmedAt: row.confirmed_at === null ? null : Number(row.confirmed_at),
			}));
	}

	#ensure(): void {
		if (this.#schema) return;
		this.#sql.exec(SCHEMA);
		this.#schema = true;
	}
}

/** Whether `value` is exactly `request`, as a plain object of its three strings. */
function sameRequest(value: unknown, request: NativeFenceRequest): boolean {
	if (typeof value !== "object" || value === null || Array.isArray(value) || Object.getPrototypeOf(value) !== Object.prototype) return false;
	const keys = Object.keys(value);
	return keys.length === 3 && (["fenceId", "run", "instance"] as const).every((key) => Object.hasOwn(value, key) && (value as Record<string, unknown>)[key] === request[key]);
}
