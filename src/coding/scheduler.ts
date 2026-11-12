import { closedPool, poolAvailable, poolResult, reservePool, type PoolBreaker } from "./pool-breaker";

/**
 * The slots of a space's coding sessions. A coding thread needs a workspace
 * (a container or sandbox) while it works, and a space may hold only so many
 * at once in each of its sandbox pools: the pool's limit. A thread asks
 * for a slot (`request`) and either gets one or waits in a queue; when it
 * gives its slot back (`release`), the queue's head takes it. The queue is
 * ordered by priority, highest first, then by when each thread asked; every
 * thread has priority 0 unless its caller says otherwise, so the queue is
 * first come, first served.
 *
 * Slots are counted per pool: a thread in one pool never takes a slot of
 * another's. Several pools may share one provider (the workspace backend
 * behind them, ./pools.ts); the scheduler knows a pool only by its id, its
 * size and its provider, as the caller last set them (`setPools`).
 * A thread names the pool it would take a slot in and, when it may run
 * elsewhere, its overflow: the pools to take a slot on instead, in order,
 * when its own has none free. It waits in the queue only when none of them
 * has a slot for it, and takes the first that frees.
 *
 * Each pool has the space's limit, capped by its own size and by its
 * provider's own limit (`setLimit` with a pool or a provider, or the
 * options' `limits`); a pool the registry doesn't name is limited as its key
 * was before pools, which is what the fallback runs on: one pool per
 * provider, its id the provider's, and each provider's limit its own.
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
 * in the queue. A refused thread holds up the pool it was refused for, even
 * for threads behind it a gate would let through, so each pool's share of the
 * queue stays first come, first served; other pools go on admitting. The
 * threads a free slot is waiting for are told the refusal's reason, such as
 * `low_disk`, and the rest `slots_full`: a gate's reason is shown only when a
 * slot is actually free, so with every slot taken everyone waits for
 * `slots_full` whatever the gates say. Gates decide from the conditions the
 * caller last set (`setConditions`), for the space or for one provider, such
 * as the disk of the sandbox manager's machine; pools on one provider share
 * its conditions. They are kept in the database with the rest, so admission
 * stays one transaction and a restart doesn't forget the disk is full.
 *
 * Every queued thread has a deadline, 6 hours unless it or the options say
 * otherwise; `tick` takes out the threads past theirs, each with the reason
 * it was last waiting for, and admits into whatever that frees.
 *
 * A slot is for work, so the scheduler also knows what each slot's thread is
 * doing (`setActivity`): `running` a turn, `idle` between turns, or `waiting`
 * for the person, for an answer or an approval. A slot starts `running`. A
 * thread idle for 10 minutes gives its slot back. A thread waiting for the
 * person keeps it for 5 minutes, and after that only until the queue has a
 * thread that slot would admit: then the thread that has waited longest is
 * preempted, and only as many as the queue can put to work on each
 * provider, so none is preempted for a queue a gate holds up or for slots
 * still over the limit after a restart. A running thread is never stopped.
 * `sweep` (and `tick`) does both and says which threads lost their slot and
 * why; the caller
 * checkpoints an idle or preempted thread's work before
 * destroying it, and later asks again for the preempted thread with
 * `PREEMPT_RESUME_PRIORITY`.
 *
 * Nothing here starts a workspace; a pool's provider is a name the caller
 * set. Each space's
 * scheduler lives in its own Durable Object (./scheduler-do.ts), which ticks
 * it and tells threads what happened to them.
 */

const SCHEMA = `
CREATE TABLE IF NOT EXISTS pim_coding_pool_breakers (
	pool TEXT PRIMARY KEY,
	state TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS pim_coding_queue (
	seq INTEGER PRIMARY KEY AUTOINCREMENT,
	thread_id TEXT NOT NULL UNIQUE,
	pool TEXT NOT NULL,
	queued_at INTEGER NOT NULL,
	reason TEXT NOT NULL,
	priority INTEGER NOT NULL DEFAULT 0,
	deadline_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS pim_coding_queue_by_order ON pim_coding_queue (priority DESC, queued_at, seq);
CREATE TABLE IF NOT EXISTS pim_coding_slots (
	thread_id TEXT PRIMARY KEY,
	pool TEXT,
	acquired_at INTEGER NOT NULL,
	state TEXT NOT NULL,
	activity TEXT NOT NULL,
	activity_since INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS pim_coding_pools (
	pool TEXT PRIMARY KEY,
	provider TEXT NOT NULL,
	size INTEGER NOT NULL,
	priority INTEGER NOT NULL
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
CREATE TABLE IF NOT EXISTS pim_coding_provider_limits (
	provider TEXT PRIMARY KEY,
	slot_limit INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS pim_coding_provider_conditions (
	provider TEXT PRIMARY KEY,
	low_disk INTEGER NOT NULL,
	budget_capped INTEGER NOT NULL,
	detail TEXT
);
`;

/** Every table the scheduler keeps. */
export const CODING_SCHEDULER_TABLES = [
	"pim_coding_pool_breakers",
	"pim_coding_queue",
	"pim_coding_slots",
	"pim_coding_pools",
	"pim_coding_config",
	"pim_coding_durations",
	"pim_coding_conditions",
	"pim_coding_provider_limits",
	"pim_coding_provider_conditions",
] as const;

const ORDER = "ORDER BY priority DESC, queued_at, seq";

/** How long a thread waits in the queue when neither it nor the options say (6 hours). */
const DEFAULT_DEADLINE_MS = 6 * 60 * 60 * 1000;

/** How long a slot's thread may be idle before it gives the slot back, and how long one waiting for the person keeps it before it may be preempted, when the options don't say (10 and 5 minutes). */
const DEFAULT_IDLE_MS = 10 * 60 * 1000;
const DEFAULT_WAITING_GRACE_MS = 5 * 60 * 1000;

/**
 * The priority a preempted thread asks again with, to go to the head of the
 * queue: ahead of every thread at the usual priority 0, and, as threads of
 * the same priority are first come, first served, behind the threads
 * preempted before it.
 */
export const PREEMPT_RESUME_PRIORITY = 1000;

const ACTIVITIES: readonly string[] = ["running", "idle", "waiting"] satisfies SlotActivity[];

/** How many of the latest sessions' durations an estimate is made from, and how few it needs. */
const DURATION_WINDOW = 20;
const MIN_DURATIONS = 5;

/** What the scheduler needs of a database: a Durable Object's `ctx.storage.sql` has it. */
export type CodingSql = Pick<SqlStorage, "exec">;

export type CodingSchedulerOptions = {
	/** Runs `work` as one transaction of the database: all its writes, or none when it throws (a Durable Object's `transactionSync`). */
	readonly transaction: <T>(work: () => T) => T;
	readonly now: () => number;
	/** The space's limit until `setLimit` sets one (1). */
	readonly defaultLimit?: number;
	/** The limits of the providers named here until `setLimit` sets one for them; the others have the space's. */
	readonly limits?: Readonly<Record<string, number>>;
	/** How long a thread may wait in the queue when its request doesn't say (6 hours). */
	readonly defaultDeadlineMs?: number;
	/** Asked in order before each admission ([lowDiskGate, budgetCapGate]). */
	readonly gates?: readonly AdmissionGate[];
	/** How long a slot's thread may be idle before `sweep` releases the slot (10 minutes). */
	readonly idleMs?: number;
	/** How long a thread waiting for the person keeps its slot before `sweep` may preempt it for the queue (5 minutes). */
	readonly waitingGraceMs?: number;
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

/** Decides whether a queued thread may take a free slot in `entry.pool`, from the entry and the conditions the caller last set for that pool's provider. It must not wait on anything, so admission stays one transaction. */
export type AdmissionGate = { readonly check: (entry: QueueEntry, conditions: AdmissionConditions) => AdmissionVerdict };

/** Refuses while the workspace manager is low on disk. */
export const lowDiskGate: AdmissionGate = { check: (_entry, conditions) => refuseIf(conditions.lowDisk, "low_disk", conditions) };

/** Refuses while the space is at its spending cap. */
export const budgetCapGate: AdmissionGate = { check: (_entry, conditions) => refuseIf(conditions.budgetCapped, "budget_cap", conditions) };

/** A pool the scheduler counts slots by, as the caller last read the registry (./pools.ts): its id, the provider behind it, how many threads may hold a slot in it at once, and where it stands among the pools. */
export type SchedulerPool = {
	readonly id: string;
	readonly provider: string;
	readonly size: number;
	readonly priority: number;
};

export type SlotRequest = {
	/** The pool the thread would take a slot in. */
	readonly pool: string;
	/** Where else it may run, in order, when `pool` has no free slot for it (none). */
	readonly overflow?: readonly string[];
	/** Why the thread is waiting while every slot is taken, as its caller would tell the person ("slots_full"). A gate's reason takes its place while that gate holds the thread up. */
	readonly reason?: string;
	/** How long it may wait in the queue before `expire` takes it out (the options' `defaultDeadlineMs`). */
	readonly deadlineMs?: number;
	/** Higher goes first; threads of the same priority are first come, first served (0). */
	readonly priority?: number;
};

/** A queued thread's place, from 1 at the queue's head, and what it is waiting for now. */
export type QueuePlace = { readonly position: number; readonly reason: string; readonly detail?: string };

/** Admitted, with the pool the slot is in: the one asked for, one of its overflow, or, for a thread that held a slot already, that slot's. */
export type RequestResult = { readonly status: "admitted"; readonly pool: string } | ({ readonly status: "queued" } & QueuePlace);

/** A slot taken: `admitted` from the queue, or `adopted` by `reconcile` from a workspace found running, whose pool may be unknown: such a slot counts against every pool's limit, as it may be any's. */
export type Slot = {
	readonly threadId: string;
	readonly pool: string | null;
	readonly acquiredAt: number;
	readonly state: "admitted" | "adopted";
	/** What its thread is doing, as its caller last said, and since when; `running` since `acquiredAt` until then. */
	readonly activity: SlotActivity;
	readonly activitySince: number;
};

/** What a slot's thread is doing: `running` a turn, `idle` between turns, or `waiting` for the person, for an answer or an approval. */
export type SlotActivity = "running" | "idle" | "waiting";

/** A slot `sweep` took back: from a thread `idle` too long, or `preempted` from one waiting for the person past its grace, for a queued thread. */
export type Released = { readonly threadId: string; readonly why: "idle" | "preempted" };

export type Sweep = {
	/** Idle threads first, then preempted ones, each oldest first. */
	readonly released: Released[];
	/** Queued threads admitted into the slots that freed up. */
	readonly admitted: string[];
};

export type QueueEntry = {
	readonly threadId: string;
	readonly pool: string;
	/** Where else it may run, in order; left out when nowhere. */
	readonly overflow?: readonly string[];
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
	/** Slots taken back by the sweep, as `sweep` says. */
	readonly released: Released[];
};

type Row = Record<string, SqlStorageValue>;

type Refusal = Extract<AdmissionVerdict, { ok: false }>;

/** What admission would do now: the threads it would admit, each with the pool its slot is in, and why the threads a free slot waits for are held up. */
type Plan = { readonly admitted: { readonly entry: QueueEntry; readonly pool: string }[]; readonly refused: ReadonlyMap<string, Refusal> };

export class CodingScheduler {
	readonly #sql: CodingSql;
	readonly #options: CodingSchedulerOptions;

	constructor(sql: CodingSql, options: CodingSchedulerOptions) {
		if (options.defaultLimit !== undefined) count(options.defaultLimit, "defaultLimit");
		if (options.defaultDeadlineMs !== undefined) duration(options.defaultDeadlineMs, "defaultDeadlineMs");
		if (options.idleMs !== undefined) duration(options.idleMs, "idleMs");
		if (options.waitingGraceMs !== undefined) duration(options.waitingGraceMs, "waitingGraceMs");
		for (const [provider, limit] of Object.entries(options.limits ?? {})) count(limit, `the limit of ${provider}`);
		this.#sql = sql;
		this.#options = options;
		this.#sql.exec(SCHEMA);
		// Queues from before overflow have no column for it.
		const columns = new Set(this.#sql.exec("PRAGMA table_info(pim_coding_queue)").toArray().map((row) => String(row.name)));
		if (!columns.has("overflow")) this.#sql.exec("ALTER TABLE pim_coding_queue ADD COLUMN overflow TEXT");
		// Slots and queues from before pools are keyed by provider; the same column keeps them, named for the pool it holds now, so a thread running or waiting through the change keeps its place.
		for (const table of ["pim_coding_queue", "pim_coding_slots"]) {
			const keyed = new Set(this.#sql.exec(`PRAGMA table_info(${table})`).toArray().map((row) => String(row.name)));
			if (keyed.has("provider") && !keyed.has("pool")) this.#sql.exec(`ALTER TABLE ${table} RENAME COLUMN provider TO pool`);
			// A table that has both columns, a `provider` that is NOT NULL and so refuses every insert of a pool, loses the old one: its pool column holds the place.
			else if (keyed.has("provider") && keyed.has("pool")) {
				this.#sql.exec(`UPDATE ${table} SET pool = provider WHERE pool IS NULL`);
				this.#sql.exec(`ALTER TABLE ${table} DROP COLUMN provider`);
			}
		}
	}

	/**
	 * Gives the thread a slot in its pool, or else in the first of its
	 * overflow, where one is free, no one ahead of it waits for that pool and
	 * the gates let it through; or puts it in the queue. Asking again changes
	 * nothing: a thread with a slot is told it's admitted, in that slot's
	 * pool, and a queued one keeps its place, pools, reason and deadline.
	 */
	request(threadId: string, request: SlotRequest): RequestResult {
		if (request.deadlineMs !== undefined) duration(request.deadlineMs, "deadlineMs");
		if (request.priority !== undefined && !Number.isSafeInteger(request.priority)) throw new RangeError("priority must be an integer");
		return this.#options.transaction((): RequestResult => {
			const held = this.#slot(threadId);
			if (held) return { status: "admitted", pool: held.pool === null ? request.pool : String(held.pool) };
			if (!this.#entry(threadId)) {
				const now = this.#options.now();
				const overflow = (request.overflow ?? []).filter((pool, index, all) => pool !== request.pool && all.indexOf(pool) === index);
				this.#sql.exec(
					"INSERT INTO pim_coding_queue (thread_id, pool, overflow, queued_at, reason, priority, deadline_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
					threadId,
					request.pool,
					overflow.length === 0 ? null : JSON.stringify(overflow),
					now,
					request.reason ?? "slots_full",
					request.priority ?? 0,
					now + (request.deadlineMs ?? this.#options.defaultDeadlineMs ?? DEFAULT_DEADLINE_MS),
				);
			}
			this.#admit();
			const entry = this.#entry(threadId);
			if (entry) return { status: "queued", ...this.#placeOf(entry) };
			return { status: "admitted", pool: String(this.#slot(threadId)!.pool) };
		});
	}

	/** The thread's slot, or null when it holds none. */
	slot(threadId: string): Slot | null {
		const row = this.#slot(threadId);
		return row ? slotOf(row) : null;
	}

	/**
	 * Moves the thread's slot to the first of `pools` with a slot free that
	 * the gates let it take, as when its pool turned out to be full after all,
	 * and admits the queue into the slot it leaves. Returns the pool it moved
	 * to, or null when none had room or it holds no slot, which changes
	 * nothing.
	 */
	move(threadId: string, pools: readonly string[]): { readonly pool: string | null; readonly admitted: string[] } {
		return this.#options.transaction(() => {
			const slot = this.#slot(threadId);
			if (!slot) return { pool: null, admitted: [] };
			const now = this.#options.now();
			for (const pool of pools) {
				if (pool === slot.pool || this.#free(pool) <= 0 || !poolAvailable(this.#breaker(pool), now)) continue;
				// A thread queued for this pool would have taken its free slot, unless a gate refused it, as it refuses this one.
				const entry: QueueEntry = { threadId, pool, reason: "slots_full", priority: 0, queuedAt: now, deadlineAt: now };
				if (refusalOf(this.#gates(), entry, this.#conditions(pool))) continue;
				this.#saveBreaker(String(slot.pool), poolResult(this.#breaker(String(slot.pool)), threadId, "ignored", now));
				this.#reservePool(pool, threadId);
				this.#sql.exec("UPDATE pim_coding_slots SET pool = ? WHERE thread_id = ?", pool, threadId);
				return { pool, admitted: this.#admit() };
			}
			return { pool: null, admitted: [] };
		});
	}

	/** Pools placement must skip now, including one whose probe is in flight. */
	unhealthyPools(pools: readonly string[]): string[] {
		return pools.filter((pool) => !poolAvailable(this.#breaker(pool), this.#options.now()));
	}

	/** Records workspace infrastructure outcomes, not repository or harness errors. */
	workspaceResult(threadId: string, result: "success" | "failure" | "ignored"): string[] {
		return this.#options.transaction(() => {
			const slot = this.#slot(threadId);
			if (slot?.pool) {
				const pool = String(slot.pool);
				this.#saveBreaker(pool, poolResult(this.#breaker(pool), threadId, result, this.#options.now()));
			}
			return this.#admit();
		});
	}

	#breaker(pool: string): PoolBreaker {
		const row = this.#sql.exec("SELECT state FROM pim_coding_pool_breakers WHERE pool = ?", pool).toArray()[0];
		return row ? JSON.parse(String(row.state)) as PoolBreaker : closedPool();
	}

	#saveBreaker(pool: string, state: PoolBreaker): void {
		this.#sql.exec("INSERT INTO pim_coding_pool_breakers (pool, state) VALUES (?, ?) ON CONFLICT (pool) DO UPDATE SET state = excluded.state", pool, JSON.stringify(state));
	}

	#reservePool(pool: string, threadId: string): void {
		this.#saveBreaker(pool, reservePool(this.#breaker(pool), threadId));
	}

	/** Frees the thread's slot, if it has one, and admits the queue's head while slots are free. Returns the threads admitted. */
	release(threadId: string): string[] {
		return this.#options.transaction(() => {
			const slot = this.#slot(threadId);
			if (slot?.pool) this.#saveBreaker(String(slot.pool), poolResult(this.#breaker(String(slot.pool)), threadId, "ignored", this.#options.now()));
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
			running: this.#sql.exec("SELECT * FROM pim_coding_slots ORDER BY acquired_at, thread_id").toArray().map(slotOf),
			queued: this.#queue(),
		}));
	}

	/**
	 * Sets how many slots the space has on each provider without a limit of
	 * its own, or, with a pool or a provider, that one's own: a pool's size
	 * and its provider's limit each cap its own slots. Raising it admits from
	 * the queue; lowering it stops no one, and admits no one until enough
	 * slots are released. Returns the threads admitted.
	 */
	setLimit(limit: number, poolOrProvider?: string): string[] {
		count(limit, "limit");
		return this.#options.transaction(() => {
			const provider = poolOrProvider === undefined ? undefined : this.#providerOf(poolOrProvider);
			if (provider === undefined) this.#sql.exec("INSERT INTO pim_coding_config (id, slot_limit) VALUES (1, ?) ON CONFLICT (id) DO UPDATE SET slot_limit = excluded.slot_limit", limit);
			else this.#sql.exec("INSERT INTO pim_coding_provider_limits (provider, slot_limit) VALUES (?, ?) ON CONFLICT (provider) DO UPDATE SET slot_limit = excluded.slot_limit", provider, limit);
			return this.#admit();
		});
	}

	/**
	 * Sets the conditions the gates decide from, for every provider without
	 * conditions of its own or, with a pool or a provider, for that one, and
	 * admits whoever they now let through. The caller sets `lowDisk` for the
	 * sandbox manager's provider while its `/health` reports under 15% of its
	 * disk free or it refuses a workspace with `low_disk`, and `budgetCapped`
	 * while the space is at a spending cap. Returns the threads admitted.
	 */
	setConditions(conditions: AdmissionConditions, poolOrProvider?: string): string[] {
		return this.#options.transaction(() => {
			const provider = poolOrProvider === undefined ? undefined : this.#providerOf(poolOrProvider);
			const values = [conditions.lowDisk ? 1 : 0, conditions.budgetCapped ? 1 : 0, conditions.detail ?? null];
			if (provider === undefined) {
				this.#sql.exec(
					"INSERT INTO pim_coding_conditions (id, low_disk, budget_capped, detail) VALUES (1, ?, ?, ?) ON CONFLICT (id) DO UPDATE SET low_disk = excluded.low_disk, budget_capped = excluded.budget_capped, detail = excluded.detail",
					...values,
				);
			} else {
				this.#sql.exec(
					"INSERT INTO pim_coding_provider_conditions (provider, low_disk, budget_capped, detail) VALUES (?, ?, ?, ?) ON CONFLICT (provider) DO UPDATE SET low_disk = excluded.low_disk, budget_capped = excluded.budget_capped, detail = excluded.detail",
					provider,
					...values,
				);
			}
			return this.#admit();
		});
	}

	/** The conditions the gates decide from for `poolOrProvider`'s provider, or for every provider without its own, as `setConditions` last set them: none hold the queue up until it is called. */
	conditions(poolOrProvider?: string): AdmissionConditions {
		return this.#conditions(poolOrProvider);
	}

	/** Takes out of the queue every thread whose deadline is at or before `now`, and returns them, in queue order, for the caller to tell. */
	expire(now = this.#options.now()): QueueEntry[] {
		return this.#options.transaction(() => this.#expire(now));
	}

	/**
	 * Says what the slot's thread is doing now, from now on: `running` when a
	 * turn starts, `idle` when it ends, `waiting` when it asks the person or
	 * waits for an approval. Saying what it is already doing changes nothing,
	 * so repeated reports can't put off its release or preemption. False when
	 * the thread holds no slot.
	 */
	setActivity(threadId: string, activity: SlotActivity): boolean {
		if (!ACTIVITIES.includes(activity)) throw new RangeError("activity must be running, idle or waiting");
		return this.#options.transaction(() => {
			const slot = this.#slot(threadId);
			if (!slot) return false;
			if (slot.activity !== activity) this.#sql.exec("UPDATE pim_coding_slots SET activity = ?, activity_since = ? WHERE thread_id = ?", activity, this.#options.now(), threadId);
			return true;
		});
	}

	/**
	 * Takes back the slots of threads idle for `idleMs` or longer, and of
	 * threads waiting for the person past `waitingGraceMs` when the queue has
	 * threads those slots would admit: the longest waiting first, one for each
	 * such thread. Admits into what it frees. Never touches a running thread.
	 */
	sweep(now = this.#options.now()): Sweep {
		return this.#options.transaction(() => this.#sweep(now));
	}

	/**
	 * What the caller runs every so often: expires the threads whose deadline
	 * has come, sweeps, then admits whoever can go, such as the threads behind
	 * a head a gate refused that has just expired or been cancelled. One
	 * transaction.
	 */
	tick(now = this.#options.now()): Tick {
		return this.#options.transaction(() => {
			const expired = this.#expire(now);
			const { released, admitted } = this.#sweep(now);
			return { expired, admitted, released };
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
				this.#sql.exec(
					"INSERT INTO pim_coding_slots (thread_id, pool, acquired_at, state, activity, activity_since) VALUES (?, ?, ?, 'adopted', 'running', ?)",
					threadId,
					entry ? entry.pool : null,
					now,
					now,
				);
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
	 * Moves queued threads into slots, in queue order, while their pools have
	 * slots free and the gates let them through. A thread a gate refuses
	 * stays, and no one behind it goes ahead of it on that pool. Its callers
	 * run it in their transaction.
	 */
	#admit(): string[] {
		const now = this.#options.now();
		// A sweep or reconciliation may have removed the probe's slot.
		for (const row of this.#sql.exec("SELECT pool, state FROM pim_coding_pool_breakers").toArray()) {
			const state = JSON.parse(String(row.state)) as PoolBreaker;
			if (state.probe !== null && !this.#slot(state.probe)) this.#saveBreaker(String(row.pool), poolResult(state, state.probe, "ignored", now));
		}
		return this.#plan().admitted.map(({ entry, pool }) => {
			this.#reservePool(pool, entry.threadId);
			this.#sql.exec("DELETE FROM pim_coding_queue WHERE thread_id = ?", entry.threadId);
			this.#sql.exec(
				"INSERT INTO pim_coding_slots (thread_id, pool, acquired_at, state, activity, activity_since) VALUES (?, ?, ?, 'admitted', 'running', ?)",
				entry.threadId,
				pool,
				now,
				now,
			);
			return entry.threadId;
		});
	}

	/**
	 * What admission would do with `extra` more slots free on the pools it
	 * names: each queued thread, in order, takes a slot in the first of its
	 * pools with one free whose gates let it through. A pool whose gates refuse
	 * a thread is held up for everyone behind it, and the free slot waits for
	 * that thread: the threads a free slot waits for are told the gate's
	 * reason, and the rest wait for a slot.
	 */
	#plan(extra: ReadonlyMap<string, number> = new Map()): Plan {
		const free = new Map<string, number>();
		const probes = new Set<string>();
		const freeOf = (pool: string) => free.get(pool) ?? this.#free(pool) + (extra.get(pool) ?? 0);
		const conditions = new Map<string, AdmissionConditions>();
		const held = new Map<string, Refusal>();
		const admitted: Plan["admitted"] = [];
		const refused = new Map<string, Refusal>();
		for (const row of this.#sql.exec(`SELECT * FROM pim_coding_queue ${ORDER}`).toArray()) {
			const entry = entryOf(row);
			let waitsOn: { pool: string; refusal: Refusal } | undefined;
			let takes: string | undefined;
			for (const pool of [entry.pool, ...(entry.overflow ?? [])]) {
				if (!poolAvailable(this.#breaker(pool), this.#options.now()) || probes.has(pool)) {
					waitsOn ??= { pool, refusal: { ok: false, reason: "unhealthy" } };
					continue;
				}
				if (freeOf(pool) <= 0) continue;
				if (!conditions.has(pool)) conditions.set(pool, this.#conditions(pool));
				const refusal = held.get(pool) ?? refusalOf(this.#gates(), { ...entry, pool }, conditions.get(pool)!);
				if (!refusal) {
					takes = pool;
					break;
				}
				held.set(pool, refusal);
				waitsOn ??= { pool, refusal };
			}
			if (takes !== undefined) {
				if (this.#breaker(takes).retryAt !== null) probes.add(takes);
				free.set(takes, freeOf(takes) - 1);
				admitted.push({ entry, pool: takes });
			} else if (waitsOn) {
				free.set(waitsOn.pool, freeOf(waitsOn.pool) - 1);
				refused.set(entry.threadId, waitsOn.refusal);
			}
		}
		return { admitted, refused };
	}

	#sweep(now: number): Sweep {
		const released: Released[] = [];
		const idle = this.#sql
			.exec("SELECT thread_id FROM pim_coding_slots WHERE activity = 'idle' AND activity_since <= ? ORDER BY activity_since, thread_id", now - (this.#options.idleMs ?? DEFAULT_IDLE_MS))
			.toArray();
		for (const row of idle) {
			this.#sql.exec("DELETE FROM pim_coding_slots WHERE thread_id = ?", row.thread_id);
			released.push({ threadId: String(row.thread_id), why: "idle" });
		}
		const admitted = this.#admit();
		const stale = this.#sql
			.exec(
				"SELECT thread_id, pool FROM pim_coding_slots WHERE activity = 'waiting' AND activity_since <= ? ORDER BY activity_since, acquired_at, thread_id",
				now - (this.#options.waitingGraceMs ?? DEFAULT_WAITING_GRACE_MS),
			)
			.toArray()
			.filter((row) => row.pool !== null);
		if (stale.length === 0) return { released, admitted };
		// Admission leaves no slot free with an admissible thread queued, so a preempted slot goes to a queued thread only when that pool's slots are exactly full; over the limit after a restart, it would go to no one.
		const extra = new Map<string, number>();
		for (const row of stale) {
			const pool = String(row.pool);
			if (this.#free(pool) === 0) extra.set(pool, (extra.get(pool) ?? 0) + 1);
		}
		// How many of the queue would go to work on each full pool were its stale slots free: as many are preempted, the longest waiting first.
		const wanted = new Map<string, number>();
		for (const { pool } of this.#plan(extra).admitted) if (extra.has(pool)) wanted.set(pool, (wanted.get(pool) ?? 0) + 1);
		for (const row of stale) {
			const pool = String(row.pool);
			const left = wanted.get(pool) ?? 0;
			if (left <= 0) continue;
			wanted.set(pool, left - 1);
			this.#sql.exec("DELETE FROM pim_coding_slots WHERE thread_id = ?", row.thread_id);
			released.push({ threadId: String(row.thread_id), why: "preempted" });
		}
		return { released, admitted: [...admitted, ...this.#admit()] };
	}

	#expire(now: number): QueueEntry[] {
		// Each with the reason it is waiting for until now, read before any leaves the queue.
		const expired = this.#queue().filter((entry) => entry.deadlineAt <= now);
		for (const entry of expired) this.#sql.exec("DELETE FROM pim_coding_queue WHERE thread_id = ?", entry.threadId);
		return expired;
	}

	/** The queue in order, each entry with what it is waiting for now. */
	#queue(): QueueEntry[] {
		const { refused } = this.#plan();
		return this.#sql
			.exec(`SELECT * FROM pim_coding_queue ${ORDER}`)
			.toArray()
			.map((row) => waiting(entryOf(row), refused));
	}

	/** How many slots `pool` has free: its limit less the slots in it and those whose pool isn't known, which may be in it. Below zero after a restart adopted more than the limit. */
	#free(pool: string): number {
		return this.#limitOf(pool) - Number(this.#sql.exec("SELECT COUNT(*) AS n FROM pim_coding_slots WHERE pool = ? OR pool IS NULL", pool).one().n);
	}

	#gates(): readonly AdmissionGate[] {
		return this.#options.gates ?? [lowDiskGate, budgetCapGate];
	}

	/**
	 * The conditions set for `pool`'s provider, or else for every provider:
	 * pools on one provider share its machine's conditions.
	 */
	#conditions(pool?: string): AdmissionConditions {
		const own = pool === undefined ? undefined : this.#sql.exec("SELECT * FROM pim_coding_provider_conditions WHERE provider = ?", this.#providerOf(pool)).toArray()[0];
		const row = own ?? this.#sql.exec("SELECT * FROM pim_coding_conditions WHERE id = 1").toArray()[0];
		if (!row) return { lowDisk: false, budgetCapped: false };
		return { lowDisk: row.low_disk === 1, budgetCapped: row.budget_capped === 1, ...(row.detail === null ? {} : { detail: String(row.detail) }) };
	}

	/** The space's limit: each provider's without one of its own. */
	#limit(): number {
		const row = this.#sql.exec("SELECT slot_limit FROM pim_coding_config WHERE id = 1").toArray()[0];
		return row ? Number(row.slot_limit) : (this.#options.defaultLimit ?? 1);
	}

	/**
	 * How many slots `pool` has: its own size, capped by its provider's limit
	 * (the manager's, or the space's), when the registry names it; otherwise
	 * the limit of its key, which before pools was its provider's.
	 */
	#limitOf(pool: string): number {
		const own = this.#poolRow(pool);
		const provider = own ? String(own.provider) : pool;
		const row = this.#sql.exec("SELECT slot_limit FROM pim_coding_provider_limits WHERE provider = ?", provider).toArray()[0];
		const capped = row ? Number(row.slot_limit) : this.#options.limits && Object.hasOwn(this.#options.limits, provider) ? this.#options.limits[provider]! : this.#limit();
		if (own) return Math.min(Number(own.size), capped);
		return capped;
	}

	/** The registry's row for `pool`, or undefined when it names none: the fallback's keys have none. */
	#poolRow(pool: string): Row | undefined {
		return this.#sql.exec("SELECT * FROM pim_coding_pools WHERE pool = ?", pool).toArray()[0];
	}

	/** The provider behind `pool`: the registry's when it names the pool, and otherwise the key itself, as before pools. */
	#providerOf(pool: string): string {
		const row = this.#poolRow(pool);
		return row ? String(row.provider) : pool;
	}

	/**
	 * Brings the pool registry (./pools.ts) up to date with what the caller
	 * read: each pool's size is its limit, and the pools resolve to their
	 * providers, so the conditions and limits set per provider reach every
	 * pool on it. An empty list is the fallback: one pool per provider, its
	 * id the provider's, limited as before pools. Growing a pool admits from
	 * the queue; shrinking stops no one. Returns the threads admitted.
	 */
	setPools(pools: readonly SchedulerPool[]): string[] {
		for (const pool of pools) {
			if (!isKey(pool.id) || !isKey(pool.provider)) throw new RangeError("a pool's id and provider must be non-empty text");
			count(pool.size, `the size of ${pool.id}`);
		}
		return this.#options.transaction(() => {
			this.#setPools(pools);
			return this.#admit();
		});
	}

	/**
	 * Brings the pool registry up to date with what the caller read: each
	 * pool's size is its limit, and the pools resolve to their providers. A
	 * key from before the registry — a provider's id, when a pool was its
	 * provider — becomes that provider's first pool, so no slot held or place
	 * in the queue through the change is stranded; a key that names no pool
	 * and no provider stays, counted against no pool, until `reconcile`
	 * releases it. Its callers run it in their transaction.
	 */
	#setPools(pools: readonly SchedulerPool[]): void {
		const ids = new Set(pools.map((pool) => pool.id));
		const firstOfProvider = new Map<string, string>();
		for (const pool of [...pools].sort((a, b) => a.priority - b.priority || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))) {
			if (!firstOfProvider.has(pool.provider)) firstOfProvider.set(pool.provider, pool.id);
		}
		if (pools.length > 0) {
			for (const table of ["pim_coding_queue", "pim_coding_slots"] as const) {
				for (const [provider, to] of firstOfProvider) {
					if (ids.has(provider)) continue;
					this.#sql.exec(`UPDATE ${table} SET pool = ? WHERE pool = ?`, to, provider);
				}
			}
		}
		this.#sql.exec("DELETE FROM pim_coding_pools");
		for (const pool of pools) this.#sql.exec("INSERT INTO pim_coding_pools (pool, provider, size, priority) VALUES (?, ?, ?, ?)", pool.id, pool.provider, pool.size, pool.priority);
	}

	#slot(threadId: string): Row | undefined {
		return this.#sql.exec("SELECT * FROM pim_coding_slots WHERE thread_id = ?", threadId).toArray()[0];
	}

	#entry(threadId: string): Row | undefined {
		return this.#sql.exec("SELECT * FROM pim_coding_queue WHERE thread_id = ?", threadId).toArray()[0];
	}

	#placeOf(row: Row): QueuePlace {
		const position = this.#positionOf(row);
		const { reason, detail } = waiting(entryOf(row), this.#plan().refused);
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
	const overflow = row.overflow === null || row.overflow === undefined ? [] : (JSON.parse(String(row.overflow)) as string[]);
	return {
		threadId: String(row.thread_id),
		pool: String(row.pool),
		...(overflow.length === 0 ? {} : { overflow }),
		reason: String(row.reason),
		priority: Number(row.priority),
		queuedAt: Number(row.queued_at),
		deadlineAt: Number(row.deadline_at),
	};
}

function slotOf(row: Row): Slot {
	return {
		threadId: String(row.thread_id),
		pool: row.pool === null ? null : String(row.pool),
		acquiredAt: Number(row.acquired_at),
		state: String(row.state) as Slot["state"],
		activity: String(row.activity) as SlotActivity,
		activitySince: Number(row.activity_since),
	};
}

/** The entry with what it is waiting for: the gate's refusal when a free slot waits for it, otherwise its request's reason. */
function waiting(entry: QueueEntry, refused: ReadonlyMap<string, Refusal>): QueueEntry {
	const refusal = refused.get(entry.threadId);
	if (!refusal) return entry;
	const { reason, detail } = refusal;
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

/** A pool's id or its provider: short non-empty text, so the scheduler's tables stay well-formed. */
const isKey = (value: string) => value.length > 0 && value.length <= 128;

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
