import type { CodingCreator } from "./api";
import type { CodingHarness, CodingThreadState } from "./thread-store";

/**
 * A space's list of its coding threads, in its scheduler's Durable Object
 * (./scheduler-do.ts), beside the queue. Whoever starts a thread enters it
 * here first, with who started it and its task (`register`); the thread's
 * own object then keeps its row up to date as its state changes
 * (`record`), each time with all of it, so a repeat changes nothing. A
 * thread is the space's only if its row is here: the API and the agents'
 * tools look a thread up here before anything else, and a thread of
 * another space is not found.
 */

export type IndexedThread = {
	readonly threadId: string;
	readonly createdBy: CodingCreator;
	readonly parent: string | null;
	/** The chat it was started from, which the chat list shows it under as a subthread; null for one started elsewhere. */
	readonly chat: string | null;
	readonly harness: CodingHarness;
	readonly task: string;
	readonly repo: string;
	readonly ref: string;
	readonly branch: string;
	readonly state: CodingThreadState;
	readonly stateReason: string | null;
	readonly spentUsd: number;
	/** The thread's budget; null when none was set. Stored as 0. */
	readonly budgetUsd: number | null;
	readonly createdAt: number;
	readonly updatedAt: number;
	/** When its latest turn ended, the last time it had new output; null before its first. */
	readonly lastTurnEndedAt: number | null;
	/** When the person last viewed it; null if never. A thread is unread while its last turn ended after this. */
	readonly lastSeenAt: number | null;
};

/** What a thread enters before it starts. */
export type ThreadRegistration = Pick<IndexedThread, "threadId" | "createdBy" | "parent" | "chat" | "harness" | "task" | "repo" | "ref" | "budgetUsd" | "createdAt">;

/** What the thread's object says of itself as its state changes. */
export type ThreadRecord = Pick<IndexedThread, "threadId" | "repo" | "ref" | "branch" | "state" | "stateReason" | "spentUsd" | "budgetUsd" | "createdAt" | "updatedAt" | "lastTurnEndedAt">;

/** The most of a task the list keeps. */
export const MAX_TASK_CHARS = 2000;

export const THREAD_INDEX_SCHEMA = `
CREATE TABLE IF NOT EXISTS pim_coding_threads (
	thread_id TEXT PRIMARY KEY,
	created_by TEXT NOT NULL,
	parent TEXT,
	chat TEXT,
	harness TEXT NOT NULL DEFAULT 'pi',
	task TEXT NOT NULL,
	repo TEXT NOT NULL,
	ref TEXT NOT NULL,
	branch TEXT NOT NULL DEFAULT '',
	state TEXT NOT NULL DEFAULT 'provisioning',
	state_reason TEXT,
	spent_usd REAL NOT NULL DEFAULT 0,
	budget_usd REAL NOT NULL,
	created_at INTEGER NOT NULL,
	updated_at INTEGER NOT NULL DEFAULT 0,
	last_turn_ended_at INTEGER,
	last_seen_at INTEGER
);
`;

export class CodingThreadIndex {
	readonly #sql: SqlStorage;

	constructor(sql: SqlStorage) {
		this.#sql = sql;
		sql.exec(THREAD_INDEX_SCHEMA);
		// Columns added after the first schema.
		const columns = new Set(sql.exec("PRAGMA table_info(pim_coding_threads)").toArray().map((column) => column.name));
		if (!columns.has("chat")) sql.exec("ALTER TABLE pim_coding_threads ADD COLUMN chat TEXT");
		if (!columns.has("harness")) sql.exec("ALTER TABLE pim_coding_threads ADD COLUMN harness TEXT NOT NULL DEFAULT 'pi'");
		if (!columns.has("last_turn_ended_at")) sql.exec("ALTER TABLE pim_coding_threads ADD COLUMN last_turn_ended_at INTEGER");
		if (!columns.has("last_seen_at")) sql.exec("ALTER TABLE pim_coding_threads ADD COLUMN last_seen_at INTEGER");
	}

	/** Enters a thread about to start; one entered already stays as it is. */
	register(thread: ThreadRegistration): void {
		this.#sql.exec(
			"INSERT INTO pim_coding_threads (thread_id, created_by, parent, chat, harness, task, repo, ref, budget_usd, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT (thread_id) DO NOTHING",
			thread.threadId,
			JSON.stringify(thread.createdBy),
			thread.parent,
			thread.chat,
			thread.harness,
			thread.task.slice(0, MAX_TASK_CHARS),
			thread.repo,
			thread.ref,
			thread.budgetUsd ?? 0,
			thread.createdAt,
		);
	}

	/** Takes back a thread whose start failed before it recorded anything. */
	forget(threadId: string): void {
		this.#sql.exec("DELETE FROM pim_coding_threads WHERE thread_id = ?", threadId);
	}

	/** Brings a thread's row up to date, unless it has a newer one already. A thread never entered stays out. */
	record(thread: ThreadRecord): void {
		this.#sql.exec(
			`UPDATE pim_coding_threads SET repo = ?, ref = ?, branch = ?, state = ?, state_reason = ?, spent_usd = ?, budget_usd = ?, created_at = ?, updated_at = ?, last_turn_ended_at = COALESCE(?, last_turn_ended_at)
			WHERE thread_id = ? AND updated_at <= ?`,
			thread.repo,
			thread.ref,
			thread.branch,
			thread.state,
			thread.stateReason,
			thread.spentUsd,
			thread.budgetUsd ?? 0,
			thread.createdAt,
			thread.updatedAt,
			thread.lastTurnEndedAt,
			thread.threadId,
			thread.updatedAt,
		);
	}

	/** The person viewed the thread at `at`; false for a thread that isn't in the list. */
	markSeen(threadId: string, at: number): boolean {
		this.#sql.exec("UPDATE pim_coding_threads SET last_seen_at = MAX(COALESCE(last_seen_at, 0), ?) WHERE thread_id = ?", at, threadId);
		return this.get(threadId) !== null;
	}

	get(threadId: string): IndexedThread | null {
		const row = this.#sql.exec("SELECT * FROM pim_coding_threads WHERE thread_id = ?", threadId).toArray()[0];
		return row ? indexedOf(row) : null;
	}

	/** Every thread, newest first. */
	list(): IndexedThread[] {
		return this.#sql.exec("SELECT * FROM pim_coding_threads ORDER BY created_at DESC, thread_id").toArray().map(indexedOf);
	}
}

function indexedOf(row: Record<string, SqlStorageValue>): IndexedThread {
	return {
		threadId: String(row.thread_id),
		createdBy: JSON.parse(String(row.created_by)) as CodingCreator,
		parent: row.parent === null ? null : String(row.parent),
		chat: row.chat === null ? null : String(row.chat),
		harness: String(row.harness) as CodingHarness,
		task: String(row.task),
		repo: String(row.repo),
		ref: String(row.ref),
		branch: String(row.branch),
		state: String(row.state) as CodingThreadState,
		stateReason: row.state_reason === null ? null : String(row.state_reason),
		spentUsd: Number(row.spent_usd),
		budgetUsd: Number(row.budget_usd) || null,
		createdAt: Number(row.created_at),
		updatedAt: Number(row.updated_at),
		lastTurnEndedAt: row.last_turn_ended_at === null ? null : Number(row.last_turn_ended_at),
		lastSeenAt: row.last_seen_at === null ? null : Number(row.last_seen_at),
	};
}
