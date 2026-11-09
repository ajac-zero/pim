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
	deadline_at INTEGER
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
`;

/** Every table the scheduler keeps. */
export const CODING_SCHEDULER_TABLES = ["pim_coding_queue", "pim_coding_slots", "pim_coding_config", "pim_coding_durations"] as const;

const ORDER = "ORDER BY priority DESC, queued_at, seq";

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
};

export type SlotRequest = {
	readonly provider: string;
	/** Why the thread is waiting, as its caller would tell the person ("capacity"). */
	readonly reason?: string;
	/** How long it may wait in the queue before `expire` takes it out. */
	readonly deadlineMs?: number;
	/** Higher goes first; threads of the same priority are first come, first served (0). */
	readonly priority?: number;
};

export type RequestResult = { readonly status: "admitted" } | { readonly status: "queued"; readonly position: number; readonly reason: string };

/** A slot taken: `admitted` from the queue, or `adopted` by `reconcile` from a workspace found running, whose provider may be unknown. */
export type Slot = { readonly threadId: string; readonly provider: string | null; readonly acquiredAt: number; readonly state: "admitted" | "adopted" };

export type QueueEntry = {
	readonly threadId: string;
	readonly provider: string;
	readonly reason: string;
	readonly priority: number;
	readonly queuedAt: number;
	readonly deadlineAt: number | null;
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

type Row = Record<string, SqlStorageValue>;

export class CodingScheduler {
	readonly #sql: CodingSql;
	readonly #options: CodingSchedulerOptions;

	constructor(sql: CodingSql, options: CodingSchedulerOptions) {
		if (options.defaultLimit !== undefined) count(options.defaultLimit, "defaultLimit");
		this.#sql = sql;
		this.#options = options;
		this.#sql.exec(SCHEMA);
	}

	/**
	 * Gives the thread a slot if one is free and no one is ahead of it, or
	 * puts it in the queue. Asking again changes nothing: a thread with a slot
	 * is told it's admitted, and a queued one keeps its place, reason and
	 * deadline.
	 */
	request(threadId: string, request: SlotRequest): RequestResult {
		if (request.deadlineMs !== undefined && !(Number.isFinite(request.deadlineMs) && request.deadlineMs >= 0)) throw new RangeError("deadlineMs must be a non-negative number");
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
					request.reason ?? "capacity",
					request.priority ?? 0,
					request.deadlineMs === undefined ? null : now + request.deadlineMs,
				);
			}
			this.#admit();
			const entry = this.#entry(threadId);
			return entry ? { status: "queued", position: this.#positionOf(entry), reason: String(entry.reason) } : { status: "admitted" };
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

	/** The thread's place in the queue, from 1 at its head, or null when it isn't queued. */
	position(threadId: string): number | null {
		const entry = this.#entry(threadId);
		return entry ? this.#positionOf(entry) : null;
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
			queued: this.#sql.exec(`SELECT * FROM pim_coding_queue ${ORDER}`).toArray().map(entryOf),
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

	/** Takes out of the queue every thread whose deadline is at or before `now`, and returns them, in queue order, for the caller to tell. */
	expire(now = this.#options.now()): QueueEntry[] {
		return this.#options.transaction(() => {
			const expired = this.#sql.exec(`SELECT * FROM pim_coding_queue WHERE deadline_at IS NOT NULL AND deadline_at <= ? ${ORDER}`, now).toArray().map(entryOf);
			for (const entry of expired) this.#sql.exec("DELETE FROM pim_coding_queue WHERE thread_id = ?", entry.threadId);
			return expired;
		});
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

	/** Moves the queue's head into slots while any are free. Its callers run it in their transaction. */
	#admit(): string[] {
		const free = this.#limit() - Number(this.#sql.exec("SELECT COUNT(*) AS n FROM pim_coding_slots").one().n);
		if (free <= 0) return [];
		const now = this.#options.now();
		const heads = this.#sql.exec(`SELECT thread_id, provider FROM pim_coding_queue ${ORDER} LIMIT ?`, free).toArray();
		for (const row of heads) {
			this.#sql.exec("DELETE FROM pim_coding_queue WHERE thread_id = ?", row.thread_id);
			this.#sql.exec("INSERT INTO pim_coding_slots (thread_id, provider, acquired_at, state) VALUES (?, ?, ?, 'admitted')", row.thread_id, row.provider, now);
		}
		return heads.map((row) => String(row.thread_id));
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
		deadlineAt: row.deadline_at === null ? null : Number(row.deadline_at),
	};
}

function count(value: number, name: string): void {
	if (!(Number.isSafeInteger(value) && value >= 0)) throw new RangeError(`${name} must be a non-negative integer`);
}
