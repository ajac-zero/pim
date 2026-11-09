import type { CodingCreator } from "./api";
import type { CodingThreadState } from "./thread-store";

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
	readonly task: string;
	readonly repo: string;
	readonly ref: string;
	readonly branch: string;
	readonly state: CodingThreadState;
	readonly stateReason: string | null;
	readonly spentUsd: number;
	readonly budgetUsd: number;
	readonly createdAt: number;
	readonly updatedAt: number;
};

/** What a thread enters before it starts. */
export type ThreadRegistration = Pick<IndexedThread, "threadId" | "createdBy" | "parent" | "task" | "repo" | "ref" | "budgetUsd" | "createdAt">;

/** What the thread's object says of itself as its state changes. */
export type ThreadRecord = Pick<IndexedThread, "threadId" | "repo" | "ref" | "branch" | "state" | "stateReason" | "spentUsd" | "budgetUsd" | "createdAt" | "updatedAt">;

/** The most of a task the list keeps. */
export const MAX_TASK_CHARS = 2000;

export const THREAD_INDEX_SCHEMA = `
CREATE TABLE IF NOT EXISTS pim_coding_threads (
	thread_id TEXT PRIMARY KEY,
	created_by TEXT NOT NULL,
	parent TEXT,
	task TEXT NOT NULL,
	repo TEXT NOT NULL,
	ref TEXT NOT NULL,
	branch TEXT NOT NULL DEFAULT '',
	state TEXT NOT NULL DEFAULT 'provisioning',
	state_reason TEXT,
	spent_usd REAL NOT NULL DEFAULT 0,
	budget_usd REAL NOT NULL,
	created_at INTEGER NOT NULL,
	updated_at INTEGER NOT NULL DEFAULT 0
);
`;

export class CodingThreadIndex {
	readonly #sql: SqlStorage;

	constructor(sql: SqlStorage) {
		this.#sql = sql;
		sql.exec(THREAD_INDEX_SCHEMA);
	}

	/** Enters a thread about to start; one entered already stays as it is. */
	register(thread: ThreadRegistration): void {
		this.#sql.exec(
			"INSERT INTO pim_coding_threads (thread_id, created_by, parent, task, repo, ref, budget_usd, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT (thread_id) DO NOTHING",
			thread.threadId,
			JSON.stringify(thread.createdBy),
			thread.parent,
			thread.task.slice(0, MAX_TASK_CHARS),
			thread.repo,
			thread.ref,
			thread.budgetUsd,
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
			`UPDATE pim_coding_threads SET repo = ?, ref = ?, branch = ?, state = ?, state_reason = ?, spent_usd = ?, budget_usd = ?, created_at = ?, updated_at = ?
			WHERE thread_id = ? AND updated_at <= ?`,
			thread.repo,
			thread.ref,
			thread.branch,
			thread.state,
			thread.stateReason,
			thread.spentUsd,
			thread.budgetUsd,
			thread.createdAt,
			thread.updatedAt,
			thread.threadId,
			thread.updatedAt,
		);
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
		task: String(row.task),
		repo: String(row.repo),
		ref: String(row.ref),
		branch: String(row.branch),
		state: String(row.state) as CodingThreadState,
		stateReason: row.state_reason === null ? null : String(row.state_reason),
		spentUsd: Number(row.spent_usd),
		budgetUsd: Number(row.budget_usd),
		createdAt: Number(row.created_at),
		updatedAt: Number(row.updated_at),
	};
}
