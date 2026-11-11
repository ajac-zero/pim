import type { ComputeQuota } from "./compute";

/**
 * What each person's sandboxes have run, and the check that keeps them within
 * their quota. One row for each stretch a workspace runs: it starts when a
 * provider makes or resumes the workspace (`begin`) and ends when the thread
 * stops it, suspends it (keeping its files) or loses it (`end`). Minutes are
 * the length of those stretches, by provider.
 *
 * The monthly reset needs no job: minutes are counted inside a UTC calendar
 * month, so a stretch that crosses midnight on the 1st counts toward each
 * month by the time it ran in it, and a new month starts at zero. A person's
 * past months stay in their history for a year.
 *
 * A stretch counts as running until it ends, whatever its session limit
 * says: `cap_at` is when the limit means it should end, which its thread
 * enforces by stopping the workspace (./coding/thread-do.ts), and a limit
 * nothing enforced must not hide a workspace from the concurrency and monthly
 * checks. A stretch whose thread lost track of it is ended by that thread's
 * next look at its workspace (`end` with reason `lost`).
 *
 * `begin` checks and records in one step, so threads that start together
 * can't all take the last of a quota.
 */

const SCHEMA = `
CREATE TABLE IF NOT EXISTS compute_usage (
	id INTEGER PRIMARY KEY AUTOINCREMENT,
	user_id TEXT NOT NULL,
	thread_id TEXT NOT NULL,
	provider TEXT NOT NULL,
	started_at INTEGER NOT NULL,
	ended_at INTEGER,
	end_reason TEXT,
	cap_at INTEGER
);
CREATE INDEX IF NOT EXISTS compute_usage_by_user ON compute_usage (user_id, started_at);
CREATE INDEX IF NOT EXISTS compute_usage_open ON compute_usage (thread_id) WHERE ended_at IS NULL;
`;

const MINUTE_MS = 60_000;
/** How many months of history a person's view shows, this one included. */
const HISTORY_MONTHS = 12;

/** Why a stretch ended: the thread stopped the workspace, suspended it keeping its files, lost it, or the provider never made it. */
export type EndReason = "stop" | "suspend" | "lost" | "failed";

export type Admission =
	| {
			readonly ok: true;
			/** The most minutes the workspace may run. Null: no limit. */
			readonly wallClockMin: number | null;
			/** When the workspace must be stopped for running that long, in ms since the epoch. Null: never. */
			readonly capAt: number | null;
	  }
	| { readonly ok: false; readonly code: "concurrent" | "monthly" | "session"; readonly message: string };

export type ProviderMinutes = { readonly provider: string; readonly minutes: number; readonly running: number };

/** One person's compute this month, and the months before it. */
export type ComputeUsage = {
	/** The UTC month the minutes are of, such as `2026-11`. */
	readonly month: string;
	readonly minutes: number;
	/** Workspaces running now. */
	readonly running: number;
	readonly byProvider: readonly ProviderMinutes[];
	/** Minutes in each of the last twelve months, oldest first. */
	readonly history: readonly { readonly month: string; readonly minutes: number }[];
};

/** Everyone's compute this month, for the admin. */
export type ComputeDeploymentUsage = {
	readonly month: string;
	readonly minutes: number;
	readonly running: number;
	readonly byProvider: readonly ProviderMinutes[];
	/** The people who used the most, most first. */
	readonly top: readonly { readonly userId: string; readonly minutes: number; readonly running: number }[];
};

const monthStart = (at: number): number => {
	const date = new Date(at);
	return Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), 1);
};
const monthsFrom = (at: number, offset: number): number => {
	const date = new Date(at);
	return Date.UTC(date.getUTCFullYear(), date.getUTCMonth() + offset, 1);
};
export const monthName = (at: number): string => new Date(at).toISOString().slice(0, 7);
const round = (minutes: number): number => Math.round(minutes * 10) / 10;
const toMinutes = (ms: number): number => round(ms / MINUTE_MS);

export class ComputeLedger {
	readonly #sql: Pick<SqlStorage, "exec">;

	constructor(sql: Pick<SqlStorage, "exec">) {
		this.#sql = sql;
		sql.exec(SCHEMA);
	}

	/**
	 * A workspace is about to run for `thread`: checks the person's quota, when
	 * given, and records the start. A thread already running is let be, so a
	 * restart that finds its workspace doesn't count it twice. Without a quota
	 * the start is recorded without checking, as for a workspace that is
	 * running already.
	 */
	begin(o: { userId: string; threadId: string; provider: string; now: number; quota: ComputeQuota | null }): Admission {
		const running = this.open(o.threadId);
		if (running) return { ok: true, wallClockMin: null, capAt: running.capAt };
		return this.#start(o, null);
	}

	/**
	 * The thread's workspace moves to a new session: ends its running stretch
	 * (as `suspend`) and begins the next after checking the quota again, in
	 * one step, so nothing else can take the place the first leaves. The
	 * session limit carries over: the new stretch ends when the chain's did
	 * (or sooner, if the month's minutes run out), so moving doesn't buy
	 * another limit's worth of time. Only a stretch begun afresh, when the
	 * person continues the thread, gets a limit of its own. A refusal leaves
	 * the first stretch ended.
	 */
	renew(o: { userId: string; threadId: string; provider: string; now: number; quota: ComputeQuota | null }): Admission {
		const prior = this.open(o.threadId);
		this.end(o.threadId, "suspend", o.now);
		return this.#start(o, prior?.capAt ?? null);
	}

	/** Checks the quota and records a stretch that ends no later than `inherited`, when given. */
	#start(o: { userId: string; threadId: string; provider: string; now: number; quota: ComputeQuota | null }, inherited: number | null): Admission {
		const { userId, threadId, provider, now, quota } = o;
		let wallClockMin: number | null = null;
		if (quota) {
			const refused = this.#refusal(userId, quota, now);
			if (refused) return refused;
			const { maxSessionMinutes: session, monthlySandboxMinutes: monthly } = quota;
			const remaining = monthly === null ? null : Math.max(1, Math.ceil(monthly - this.#minutes(userId, monthStart(now), monthsFrom(now, 1), now)));
			wallClockMin = session === null ? remaining : remaining === null ? session : Math.min(session, remaining);
		}
		let capAt = wallClockMin === null ? null : now + wallClockMin * MINUTE_MS;
		if (inherited !== null) {
			capAt = capAt === null ? inherited : Math.min(capAt, inherited);
			wallClockMin = Math.max(1, Math.ceil((capAt - now) / MINUTE_MS));
		}
		this.#sql.exec("INSERT INTO compute_usage (user_id, thread_id, provider, started_at, cap_at) VALUES (?, ?, ?, ?, ?)", userId, threadId, provider, now, capAt);
		this.#sql.exec("DELETE FROM compute_usage WHERE ended_at IS NOT NULL AND ended_at < ?", monthsFrom(now, -HISTORY_MONTHS - 1));
		return { ok: true, wallClockMin, capAt };
	}

	/** Deletes every stretch of the person's, running or not: they are erased. */
	forget(userId: string): void {
		this.#sql.exec("DELETE FROM compute_usage WHERE user_id = ?", userId);
	}

	/** The thread's workspace as the ledger has it running, or null when it has none. */
	open(threadId: string): { capAt: number | null } | null {
		const [row] = this.#sql.exec("SELECT cap_at FROM compute_usage WHERE thread_id = ? AND ended_at IS NULL", threadId).toArray();
		return row ? { capAt: row.cap_at === null ? null : Number(row.cap_at) } : null;
	}

	/** Ends the stretches that are running for threads named `prefix…` and not in `keep`: the ones whose owner no longer has what they counted. */
	endExcept(prefix: string, keep: readonly string[], reason: EndReason, now: number): number {
		let ended = 0;
		const rows = this.#sql.exec("SELECT thread_id FROM compute_usage WHERE ended_at IS NULL AND substr(thread_id, 1, ?) = ?", prefix.length, prefix).toArray();
		for (const { thread_id } of rows) if (!keep.includes(String(thread_id)) && this.end(String(thread_id), reason, now)) ended++;
		return ended;
	}

	/** The thread's workspace stopped running. False when it wasn't recorded as running. */
	end(threadId: string, reason: EndReason, now: number): boolean {
		return this.#sql.exec("UPDATE compute_usage SET ended_at = ?, end_reason = ? WHERE thread_id = ? AND ended_at IS NULL", now, reason, threadId).rowsWritten > 0;
	}

	/** One person's minutes this month and in the months before. */
	usage(userId: string, now: number): ComputeUsage {
		const from = monthStart(now);
		const rows = this.#byProvider(userId, from, monthsFrom(now, 1), now);
		const history = [];
		for (let back = HISTORY_MONTHS - 1; back >= 0; back--) {
			const start = monthsFrom(now, -back);
			history.push({ month: monthName(start), minutes: round(this.#minutes(userId, start, monthsFrom(start, 1), now)) });
		}
		return {
			month: monthName(from),
			minutes: toMinutes(rows.reduce((sum, row) => sum + row.ms, 0)),
			running: this.#runningFor(userId),
			byProvider: rows.map(({ provider, ms, running }) => ({ provider, minutes: toMinutes(ms), running })),
			history,
		};
	}

	/** Everyone's minutes this month. */
	deployment(now: number, top = 20): ComputeDeploymentUsage {
		const from = monthStart(now);
		const rows = this.#byProvider(null, from, monthsFrom(now, 1), now);
		const people = this.#sql
			.exec(`${windowSelect("user_id")} GROUP BY user_id ORDER BY ms DESC LIMIT ?`, ...bindings(now, from, monthsFrom(now, 1), null), top)
			.toArray()
			.map((row) => ({ userId: String(row.user_id), minutes: toMinutes(Number(row.ms)), running: Number(row.running) }));
		return {
			month: monthName(from),
			minutes: toMinutes(rows.reduce((sum, row) => sum + row.ms, 0)),
			running: rows.reduce((sum, row) => sum + row.running, 0),
			byProvider: rows.map(({ provider, ms, running }) => ({ provider, minutes: toMinutes(ms), running })),
			top: people,
		};
	}

	#runningFor(userId: string): number {
		return Number(this.#sql.exec("SELECT COUNT(*) AS n FROM compute_usage WHERE user_id = ? AND ended_at IS NULL", userId).one().n);
	}

	#minutes(userId: string, from: number, until: number, now: number): number {
		return this.#byProvider(userId, from, until, now).reduce((sum, row) => sum + row.ms, 0) / MINUTE_MS;
	}

	#byProvider(userId: string | null, from: number, until: number, now: number): { provider: string; ms: number; running: number }[] {
		return this.#sql
			.exec(`${windowSelect("provider")} GROUP BY provider ORDER BY ms DESC, provider`, ...bindings(now, from, until, userId))
			.toArray()
			.map((row) => ({ provider: String(row.provider), ms: Number(row.ms), running: Number(row.running) }));
	}

	/** Why the person can't start another workspace, or null. */
	#refusal(userId: string, quota: ComputeQuota, now: number): Extract<Admission, { ok: false }> | null {
		const { maxConcurrentWorkspaces: concurrent, monthlySandboxMinutes: monthly, maxSessionMinutes: session } = quota;
		const running = this.#runningFor(userId);
		if (concurrent !== null && running >= concurrent) {
			return {
				ok: false,
				code: "concurrent",
				message: `You already have ${running} sandbox workspace${running === 1 ? "" : "s"} running, which is the most this Pim lets you have at once (${concurrent}). Wait for one to finish or archive one, then continue this thread.`,
			};
		}
		if (session !== null && session <= 0) {
			return { ok: false, code: "session", message: "This Pim doesn't let you run sandbox workspaces: your session length limit is 0 minutes. Ask its admin to raise it." };
		}
		if (monthly !== null) {
			const used = this.#minutes(userId, monthStart(now), monthsFrom(now, 1), now);
			if (used >= monthly) {
				return {
					ok: false,
					code: "monthly",
					message: `You've used your ${monthly} sandbox minutes for ${monthName(now)} (${Math.ceil(used)} used). They reset at the start of next month (UTC); ask this Pim's admin if you need more now.`,
				};
			}
		}
		return null;
	}
}

/** Each `column`'s minutes inside a window: every stretch clipped to it and, while it runs, to now. Bind it with `bindings`. */
const windowSelect = (column: "user_id" | "provider") => `SELECT ${column}, SUM(MAX(0, MIN(COALESCE(ended_at, ?), ?) - MAX(started_at, ?))) AS ms, SUM(CASE WHEN ended_at IS NULL THEN 1 ELSE 0 END) AS running
FROM compute_usage WHERE started_at < ? AND COALESCE(ended_at, ?) > ? AND (? IS NULL OR user_id = ?)`;

/** The bindings of `windowSelect`, in order. */
const bindings = (now: number, from: number, until: number, userId: string | null): (string | number | null)[] => [now, until, from, until, now, from, userId, userId];
