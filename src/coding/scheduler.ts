/**
 * The slots of a space's coding sessions. A coding thread needs a workspace
 * (a container or sandbox) while it works, and a space may hold only so many
 * at once: its limit. A thread asks for a slot (`request`) and either gets
 * one or waits in a queue; when it gives its slot back (`release`), the
 * queue's head takes it. The queue is ordered by priority, highest first,
 * then by when each thread asked; every thread has priority 0 unless its
 * caller says otherwise, so the queue is first come, first served.
 *
 * Everything is kept in the space's SQLite database, and every change that
 * admits a thread is one transaction (`options.transaction`), so a crash
 * leaves all of it or none, and admission never takes more slots than the
 * limit. The one exception is `reconcile`, which, after a restart, takes on
 * workspaces that are still running even if they are more than the limit:
 * it never stops a running session to get back under it.
 *
 * A free slot isn't always enough: when the machine that runs workspaces is
 * low on disk, or the space has reached its spending cap, starting another
 * session would fail. Before admitting a thread, the scheduler asks each of
 * its admission gates in order, and the first that refuses keeps the thread
 * in the queue. A refused head holds up the whole queue, even threads a gate
 * would let through, so the queue stays first come, first served. The
 * threads a free slot is waiting for are told the refusal's reason, such as
 * `low_disk`, and the rest `slots_full`: a gate's reason is shown only when
 * a slot is actually free, so with every slot taken everyone waits for
 * `slots_full` whatever the gates say. Gates decide from
 * the conditions the caller last set (`setConditions`), which are kept in the
 * database with the rest, so admission stays one transaction and a restart
 * doesn't forget the disk is full.
 *
 * Every queued thread has a deadline, 6 hours unless it or the options say
 * otherwise; `tick` takes out the threads past theirs, each with the reason
 * it was last waiting for, and admits into whatever that frees.
 *
 * Nothing here knows about providers or starts a workspace. Nothing in Pim
 * constructs a scheduler yet.
 */

const SCHEMA = `
CREATE TABLE IF NOT EXISTS pim_coding_queue (
	seq INTEGER PRIMARY KEY AUTOINCREMENT,
	thread_id TEXT NOT NULL UNIQUE,
	provider TEXT NOT NULL,
	queued_at INTEGER NOT NULL,
	reason TEXT NOT NULL,
	priority INTEGER NOT NULL DEFAULT 0,
	deadline_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS pim_coding_queue_by_order ON pim_coding_queue (priority DESC, queued_at, seq);
CREATE TABLE IF NOT EXISTS pim_coding_slots (
	thread_id TEXT PRIMARY KEY,
	provider TEXT,
	acquired_at INTEGER NOT NULL,
	state TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS pim_coding_config (
	id INTEGER PRIMARY KEY CHECK (id = 1),
	slot_limit INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS pim_coding_durations (
	seq INTEGER PRIMARY KEY AUTOINCREMENT,
	ms INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS pim_coding_conditions (
	id INTEGER PRIMARY KEY CHECK (id = 1),
	low_disk INTEGER NOT NULL,
	budget_capped INTEGER NOT NULL,
	detail TEXT
);
`;

/** Every table the scheduler keeps. */
export const CODING_SCHEDULER_TABLES = ["pim_coding_queue", "pim_coding_slots", "pim_coding_config", "pim_coding_durations", "pim_coding_conditions"] as const;

const ORDER = "ORDER BY priority DESC, queued_at, seq";

/** How long a thread waits in the queue when neither it nor the options say (6 hours). */
const DEFAULT_DEADLINE_MS = 6 * 60 * 60 * 1000;

/** How many of the latest sessions' durations an estimate is made from, and how few it needs. */
const DURATION_WINDOW = 20;
const MIN_DURATIONS = 5;

/** What the scheduler needs of a database: a Durable Object's `ctx.storage.sql` has it. */
export type CodingSql = Pick<SqlStorage, "exec">;

export type CodingSchedulerOptions = {
	/** Runs `work` as one transaction of the database: all its writes, or none when it throws (a Durable Object's `transactionSync`). */
	readonly transaction: <T>(work: () => T) => T;
	readonly now: () => number;
	/** The limit until `setLimit` sets one (1). */
	readonly defaultLimit?: number;
	/** How long a thread may wait in the queue when its request doesn't say (6 hours). */
	readonly defaultDeadlineMs?: number;
	/** Asked in order before each admission ([lowDiskGate, budgetCapGate]). */
	readonly gates?: readonly AdmissionGate[];
};

/** What the caller knows of the world outside the scheduler, from the workspace manager's health and the space's spending caps. */
export type AdmissionConditions = {
	readonly lowDisk: boolean;
	readonly budgetCapped: boolean;
	/** Said to the person alongside the reason, such as "9% of the disk free". */
	readonly detail?: string;
};

/** A refusal's reason is what the thread waits for, such as `low_disk` or `budget_cap`. */
export type AdmissionVerdict = { readonly ok: true } | { readonly ok: false; readonly reason: string; readonly detail?: string };

/** Decides whether the queue's head may take a free slot, from the entry and the conditions the caller last set. It must not wait on anything, so admission stays one transaction. */
export type AdmissionGate = { readonly check: (entry: QueueEntry, conditions: AdmissionConditions) => AdmissionVerdict };

/** Refuses while the workspace manager is low on disk. */
export const lowDiskGate: AdmissionGate = { check: (_entry, conditions) => refuseIf(conditions.lowDisk, "low_disk", conditions) };

/** Refuses while the space is at its spending cap. */
export const budgetCapGate: AdmissionGate = { check: (_entry, conditions) => refuseIf(conditions.budgetCapped, "budget_cap", conditions) };

export type SlotRequest = {
	readonly provider: string;
	/** Why the thread is waiting while every slot is taken, as its caller would tell the person ("slots_full"). A gate's reason takes its place while that gate holds the thread up. */
	readonly reason?: string;
	/** How long it may wait in the queue before `expire` takes it out (the options' `defaultDeadlineMs`). */
	readonly deadlineMs?: number;
	/** Higher goes first; threads of the same priority are first come, first served (0). */
	readonly priority?: number;
};

/** A queued thread's place, from 1 at the queue's head, and what it is waiting for now. */
export type QueuePlace = { readonly position: number; readonly reason: string; readonly detail?: string };

export type RequestResult = { readonly status: "admitted" } | ({ readonly status: "queued" } & QueuePlace);

/** A slot taken: `admitted` from the queue, or `adopted` by `reconcile` from a workspace found running, whose provider may be unknown. */
export type Slot = { readonly threadId: string; readonly provider: string | null; readonly acquiredAt: number; readonly state: "admitted" | "adopted" };

export type QueueEntry = {
	readonly threadId: string;
	readonly provider: string;
	/** What it is waiting for now: the reason a gate refuses the queue's head when a free slot waits for this thread, otherwise its request's. When it expires, what it was last waiting for. */
	readonly reason: string;
	readonly detail?: string;
	readonly priority: number;
	readonly queuedAt: number;
	readonly deadlineAt: number;
};

export type SchedulerSnapshot = { readonly limit: number; readonly running: Slot[]; readonly queued: QueueEntry[] };

export type Reconciliation = {
	/** Slots whose thread wasn't live, now free. */
	readonly released: string[];
	/** Live threads that had no slot, now holding one. */
	readonly adopted: string[];
	/** Queued threads admitted into the slots that freed up. */
	readonly admitted: string[];
};

export type Tick = {
	/** Threads whose deadline came, in queue order, each with the reason it was last waiting for. */
	readonly expired: QueueEntry[];
	/** Queued threads admitted afterwards. */
	readonly admitted: string[];
};

type Row = Record<string, SqlStorageValue>;

type Refusal = Extract<AdmissionVerdict, { ok: false }>;

/** A head the gates refuse, and how many slots are free behind it. */
type HeldUp = { readonly free: number; readonly refusal: Refusal };

export class CodingScheduler {
	readonly #sql: CodingSql;
	readonly #options: CodingSchedulerOptions;

	constructor(sql: CodingSql, options: CodingSchedulerOptions) {
		if (options.defaultLimit !== undefined) count(options.defaultLimit, "defaultLimit");
		if (options.defaultDeadlineMs !== undefined) duration(options.defaultDeadlineMs, "defaultDeadlineMs");
		this.#sql = sql;
		this.#options = options;
		this.#sql.exec(SCHEMA);
	}

	/**
	 * Gives the thread a slot if one is free, no one is ahead of it and the
	 * gates let it through, or puts it in the queue. Asking again changes
	 * nothing: a thread with a slot is told it's admitted, and a queued one
	 * keeps its place, reason and deadline.
	 */
	request(threadId: string, request: SlotRequest): RequestResult {
		if (request.deadlineMs !== undefined) duration(request.deadlineMs, "deadlineMs");
		if (request.priority !== undefined && !Number.isSafeInteger(request.priority)) throw new RangeError("priority must be an integer");
		return this.#options.transaction((): RequestResult => {
			if (this.#slot(threadId)) return { status: "admitted" };
			if (!this.#entry(threadId)) {
				const now = this.#options.now();
				this.#sql.exec(
					"INSERT INTO pim_coding_queue (thread_id, provider, queued_at, reason, priority, deadline_at) VALUES (?, ?, ?, ?, ?, ?)",
					threadId,
					request.provider,
					now,
					request.reason ?? "slots_full",
					request.priority ?? 0,
					now + (request.deadlineMs ?? this.#options.defaultDeadlineMs ?? DEFAULT_DEADLINE_MS),
				);
			}
			this.#admit();
			const entry = this.#entry(threadId);
			return entry ? { status: "queued", ...this.#placeOf(entry) } : { status: "admitted" };
		});
	}

	/** Frees the thread's slot, if it has one, and admits the queue's head while slots are free. Returns the threads admitted. */
	release(threadId: string): string[] {
		return this.#options.transaction(() => {
			this.#sql.exec("DELETE FROM pim_coding_slots WHERE thread_id = ?", threadId);
			return this.#admit();
		});
	}

	/** Takes the thread out of the queue. False when it wasn't queued, such as when it holds a slot, which only `release` frees. */
	cancel(threadId: string): boolean {
		return this.#options.transaction(() => this.#sql.exec("DELETE FROM pim_coding_queue WHERE thread_id = ?", threadId).rowsWritten > 0);
	}

	/** The thread's place in the queue and what it is waiting for, or null when it isn't queued. */
	position(threadId: string): QueuePlace | null {
		const entry = this.#entry(threadId);
		return entry ? this.#placeOf(entry) : null;
	}

	snapshot(): SchedulerSnapshot {
		return this.#options.transaction(() => ({
			limit: this.#limit(),
			running: this.#sql
				.exec("SELECT * FROM pim_coding_slots ORDER BY acquired_at, thread_id")
				.toArray()
				.map((row) => ({
					threadId: String(row.thread_id),
					provider: row.provider === null ? null : String(row.provider),
					acquiredAt: Number(row.acquired_at),
					state: String(row.state) as Slot["state"],
				})),
			queued: this.#queue(),
		}));
	}

	/** Sets how many slots the space has. Raising it admits from the queue; lowering it stops no one, and admits no one until enough slots are released. Returns the threads admitted. */
	setLimit(limit: number): string[] {
		count(limit, "limit");
		return this.#options.transaction(() => {
			this.#sql.exec("INSERT INTO pim_coding_config (id, slot_limit) VALUES (1, ?) ON CONFLICT (id) DO UPDATE SET slot_limit = excluded.slot_limit", limit);
			return this.#admit();
		});
	}

	/**
	 * Sets the conditions the gates decide from, and admits whoever they now
	 * let through. The caller sets `lowDisk` while the workspace manager's
	 * `/health` reports under 15% of its disk free or it refuses a workspace
	 * with `low_disk`, and `budgetCapped` while the space is at a spending
	 * cap. Returns the threads admitted.
	 */
	setConditions(conditions: AdmissionConditions): string[] {
		return this.#options.transaction(() => {
			this.#sql.exec(
				"INSERT INTO pim_coding_conditions (id, low_disk, budget_capped, detail) VALUES (1, ?, ?, ?) ON CONFLICT (id) DO UPDATE SET low_disk = excluded.low_disk, budget_capped = excluded.budget_capped, detail = excluded.detail",
				conditions.lowDisk ? 1 : 0,
				conditions.budgetCapped ? 1 : 0,
				conditions.detail ?? null,
			);
			return this.#admit();
		});
	}

	/** Takes out of the queue every thread whose deadline is at or before `now`, and returns them, in queue order, for the caller to tell. */
	expire(now = this.#options.now()): QueueEntry[] {
		return this.#options.transaction(() => this.#expire(now));
	}

	/**
	 * What the caller runs every so often: expires the threads whose deadline
	 * has come, then admits whoever can go, such as the threads behind a head
	 * a gate refused that has just expired or been cancelled. One transaction.
	 */
	tick(now = this.#options.now()): Tick {
		return this.#options.transaction(() => ({ expired: this.#expire(now), admitted: this.#admit() }));
	}

	/**
	 * Brings the slots in line with the workspaces actually running, after a
	 * restart: a slot whose thread isn't in `liveThreadIds` is released, and a
	 * live thread without a slot is given one, out of the queue if it was
	 * queued, even past the limit. Then the queue's head takes any slot free.
	 */
	reconcile(liveThreadIds: readonly string[]): Reconciliation {
		return this.#options.transaction((): Reconciliation => {
			const live = new Set(liveThreadIds);
			const released: string[] = [];
			for (const row of this.#sql.exec("SELECT thread_id FROM pim_coding_slots ORDER BY acquired_at, thread_id").toArray()) {
				const threadId = String(row.thread_id);
				if (live.has(threadId)) continue;
				this.#sql.exec("DELETE FROM pim_coding_slots WHERE thread_id = ?", threadId);
				released.push(threadId);
			}
			const adopted: string[] = [];
			const now = this.#options.now();
			for (const threadId of live) {
				if (this.#slot(threadId)) continue;
				const entry = this.#entry(threadId);
				this.#sql.exec("DELETE FROM pim_coding_queue WHERE thread_id = ?", threadId);
				this.#sql.exec("INSERT INTO pim_coding_slots (thread_id, provider, acquired_at, state) VALUES (?, ?, ?, 'adopted')", threadId, entry ? entry.provider : null, now);
				adopted.push(threadId);
			}
			return { released, adopted, admitted: this.#admit() };
		});
	}

	/** Records how long a finished session held its slot, for `etaMs`. Only the latest 20 are kept. */
	recordDuration(ms: number): void {
		if (!(Number.isFinite(ms) && ms >= 0)) throw new RangeError("a duration must be a non-negative number");
		this.#options.transaction(() => {
			this.#sql.exec("INSERT INTO pim_coding_durations (ms) VALUES (?)", Math.round(ms));
			this.#sql.exec(`DELETE FROM pim_coding_durations WHERE seq NOT IN (SELECT seq FROM pim_coding_durations ORDER BY seq DESC LIMIT ${DURATION_WINDOW})`);
		});
	}

	/**
	 * About how long the thread at `position` will wait: the median of the
	 * latest sessions' durations, times its position, over the limit. Null
	 * with fewer than 5 durations recorded, or with no slots at all.
	 */
	etaMs(position: number): number | null {
		if (!(Number.isSafeInteger(position) && position >= 1)) throw new RangeError("position must be an integer from 1");
		const limit = this.#limit();
		const durations = this.#sql
			.exec("SELECT ms FROM pim_coding_durations ORDER BY seq DESC LIMIT ?", DURATION_WINDOW)
			.toArray()
			.map((row) => Number(row.ms))
			.sort((a, b) => a - b);
		if (durations.length < MIN_DURATIONS || limit === 0) return null;
		const middle = durations.length >> 1;
		const median = durations.length % 2 === 1 ? durations[middle]! : (durations[middle - 1]! + durations[middle]!) / 2;
		return Math.round((median * position) / limit);
	}

	/**
	 * Moves the queue's head into slots while any are free and the gates let
	 * it through. A head a gate refuses stays, and no one behind it goes
	 * ahead. Its callers run it in their transaction.
	 */
	#admit(): string[] {
		const free = this.#free();
		if (free <= 0) return [];
		const now = this.#options.now();
		const conditions = this.#conditions();
		const admitted: string[] = [];
		for (const row of this.#sql.exec(`SELECT * FROM pim_coding_queue ${ORDER} LIMIT ?`, free).toArray()) {
			const entry = entryOf(row);
			if (refusalOf(this.#gates(), entry, conditions)) break;
			this.#sql.exec("DELETE FROM pim_coding_queue WHERE thread_id = ?", entry.threadId);
			this.#sql.exec("INSERT INTO pim_coding_slots (thread_id, provider, acquired_at, state) VALUES (?, ?, ?, 'admitted')", entry.threadId, entry.provider, now);
			admitted.push(entry.threadId);
		}
		return admitted;
	}

	#expire(now: number): QueueEntry[] {
		// Each with the reason it is waiting for until now, read before any leaves the queue.
		const expired = this.#queue().filter((entry) => entry.deadlineAt <= now);
		for (const entry of expired) this.#sql.exec("DELETE FROM pim_coding_queue WHERE thread_id = ?", entry.threadId);
		return expired;
	}

	/** The queue in order, each entry with what it is waiting for now. */
	#queue(): QueueEntry[] {
		const heldUp = this.#heldUp();
		return this.#sql
			.exec(`SELECT * FROM pim_coding_queue ${ORDER}`)
			.toArray()
			.map((row, index) => waiting(entryOf(row), index + 1, heldUp));
	}

	/**
	 * Why the queue's head isn't admitted though slots are free, and how many
	 * are: undefined when every slot is taken or no gate refuses it.
	 * Admission leaves a slot free with a thread queued only when a gate
	 * refuses the head, so this is the gate that last held it up.
	 */
	#heldUp(): HeldUp | undefined {
		const free = this.#free();
		if (free <= 0) return undefined;
		const head = this.#sql.exec(`SELECT * FROM pim_coding_queue ${ORDER} LIMIT 1`).toArray()[0];
		const refusal = head && refusalOf(this.#gates(), entryOf(head), this.#conditions());
		return refusal ? { free, refusal } : undefined;
	}

	#free(): number {
		return this.#limit() - Number(this.#sql.exec("SELECT COUNT(*) AS n FROM pim_coding_slots").one().n);
	}

	#gates(): readonly AdmissionGate[] {
		return this.#options.gates ?? [lowDiskGate, budgetCapGate];
	}

	#conditions(): AdmissionConditions {
		const row = this.#sql.exec("SELECT * FROM pim_coding_conditions WHERE id = 1").toArray()[0];
		if (!row) return { lowDisk: false, budgetCapped: false };
		return { lowDisk: row.low_disk === 1, budgetCapped: row.budget_capped === 1, ...(row.detail === null ? {} : { detail: String(row.detail) }) };
	}

	#limit(): number {
		const row = this.#sql.exec("SELECT slot_limit FROM pim_coding_config WHERE id = 1").toArray()[0];
		return row ? Number(row.slot_limit) : (this.#options.defaultLimit ?? 1);
	}

	#slot(threadId: string): Row | undefined {
		return this.#sql.exec("SELECT * FROM pim_coding_slots WHERE thread_id = ?", threadId).toArray()[0];
	}

	#entry(threadId: string): Row | undefined {
		return this.#sql.exec("SELECT * FROM pim_coding_queue WHERE thread_id = ?", threadId).toArray()[0];
	}

	#placeOf(row: Row): QueuePlace {
		const position = this.#positionOf(row);
		const { reason, detail } = waiting(entryOf(row), position, this.#heldUp());
		return { position, reason, ...(detail === undefined ? {} : { detail }) };
	}

	#positionOf(entry: Row): number {
		const ahead = this.#sql
			.exec(
				"SELECT COUNT(*) AS n FROM pim_coding_queue WHERE priority > ? OR (priority = ? AND (queued_at < ? OR (queued_at = ? AND seq < ?)))",
				entry.priority,
				entry.priority,
				entry.queued_at,
				entry.queued_at,
				entry.seq,
			)
			.one().n;
		return Number(ahead) + 1;
	}
}

function entryOf(row: Row): QueueEntry {
	return {
		threadId: String(row.thread_id),
		provider: String(row.provider),
		reason: String(row.reason),
		priority: Number(row.priority),
		queuedAt: Number(row.queued_at),
		deadlineAt: Number(row.deadline_at),
	};
}

/** The entry at `position` with what it is waiting for: the held-up head's refusal when a free slot waits for it, otherwise its request's reason. */
function waiting(entry: QueueEntry, position: number, heldUp: HeldUp | undefined): QueueEntry {
	if (!heldUp || position > heldUp.free) return entry;
	const { reason, detail } = heldUp.refusal;
	return { ...entry, reason, ...(detail === undefined ? {} : { detail }) };
}

/** The first gate's refusal, in order, or undefined when every gate lets the entry through. */
function refusalOf(gates: readonly AdmissionGate[], entry: QueueEntry, conditions: AdmissionConditions): Refusal | undefined {
	for (const gate of gates) {
		const verdict = gate.check(entry, conditions);
		if (!verdict.ok) return verdict;
	}
	return undefined;
}

function refuseIf(refused: boolean, reason: string, conditions: AdmissionConditions): AdmissionVerdict {
	if (!refused) return { ok: true };
	return conditions.detail === undefined ? { ok: false, reason } : { ok: false, reason, detail: conditions.detail };
}

function duration(value: number, name: string): void {
	if (!(Number.isFinite(value) && value >= 0)) throw new RangeError(`${name} must be a non-negative number`);
}

function count(value: number, name: string): void {
	if (!(Number.isSafeInteger(value) && value >= 0)) throw new RangeError(`${name} must be a non-negative integer`);
}
