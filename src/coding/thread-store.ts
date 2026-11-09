import type { JsonValue, ModelThinkingLevel } from "@earendil-works/pi-ai";
import type { TestRunReport, ToolJournal, ToolJournalEntry, ToolJournalOutcome } from "./tools-port";
import type { WorkspaceRef } from "./workspace/types";

/**
 * A coding thread's own tables, in its Durable Object's SQLite database next
 * to pi's (which are prefixed `pi_`). There is one thread per object, so
 * `coding_thread` has one row. Model credentials are never written here:
 * the agent profile names a provider by id only (see ./thread-do.ts).
 */

/** Where a thread is: getting a workspace ready, waiting for a slot, between turns, in a turn, waiting for the person, stopped by a failure, or done. */
export type CodingThreadState = "provisioning" | "queued" | "idle" | "running" | "waiting_input" | "failed" | "archived";

/** Which model a thread runs on, by the space's provider id (such as `own:anthropic`) and the model's id there. */
export type AgentProfile = { readonly providerId: string; readonly model: string; readonly thinking?: ModelThinkingLevel };

/** How far a thread's workspace may go, as the workspace spec takes it. */
export type CodingLimits = { readonly cpu: number; readonly memMiB: number; readonly diskMiB: number; readonly pids: number; readonly wallClockMin: number };

/** Whether the thread holds a slot of its space's scheduler, waits in its queue for one, or neither. */
export type SlotHold = "none" | "queued" | "held";

export type CodingThreadRow = {
	readonly threadId: string;
	readonly space: string;
	readonly repoUrl: string;
	readonly baseRef: string;
	/** The commit `baseRef` named when the repository was cloned; diffs start here. Null until then. */
	readonly baseSha: string | null;
	readonly branch: string;
	readonly profile: AgentProfile;
	/** The workspace provider's id. */
	readonly providerId: string;
	readonly workspaceRef: WorkspaceRef | null;
	readonly state: CodingThreadState;
	/** Why the thread failed, such as `budget` or `queue_expired`; null otherwise. */
	readonly stateReason: string | null;
	readonly createdBy: string;
	readonly parentThread: string | null;
	readonly limits: CodingLimits;
	readonly budgetUsd: number;
	readonly spentUsd: number;
	/** The `start` operation that made the thread, which repeats of it are recognized by. */
	readonly startOperation: string;
	readonly slot: SlotHold;
	readonly slotSince: number | null;
	/** Ask for the next slot ahead of the queue: the last one was taken back while the thread waited for the person. */
	readonly resumePriority: boolean;
	/** The pi operation whose turn is under way, or null between turns. */
	readonly currentOperation: string | null;
	/** Set before a model call is refused for the budget, so the turn that ends with it stops the thread. */
	readonly budgetStopped: boolean;
	readonly createdAt: number;
	readonly updatedAt: number;
};

export type Checkpoint = { readonly seq: number; readonly sha: string; readonly message: string; readonly operationId: string | null; readonly createdAt: number };

export type TestRun = TestRunReport & { readonly seq: number; readonly createdAt: number };

/** One line of a thread's log: a model call with its usage and cost, a turn's end, or a stop. */
export type CodingEvent = {
	readonly seq: number;
	readonly kind: string;
	readonly at: number;
	readonly provider: string | null;
	readonly model: string | null;
	readonly input: number;
	readonly output: number;
	readonly cacheRead: number;
	readonly cacheWrite: number;
	readonly costUsd: number;
	/** The event itself, for events other than model calls: flat, so it crosses RPC with its type. */
	readonly data: EventData | null;
};

/** What an event in the log says besides its kind. */
export type EventData = Readonly<Record<string, string | number | boolean | null>>;

/** A thread's input waiting for its turn: the task, a message the person sent between turns, or a request to go on. */
export type InboxItem = { readonly seq: number; readonly operationId: string; readonly text: string };

const SCHEMA = `
CREATE TABLE IF NOT EXISTS coding_thread (
	thread_id TEXT PRIMARY KEY,
	space TEXT NOT NULL,
	repo_url TEXT NOT NULL,
	base_ref TEXT NOT NULL,
	base_sha TEXT,
	branch TEXT NOT NULL,
	agent_profile TEXT NOT NULL,
	provider_id TEXT NOT NULL,
	workspace_ref TEXT,
	state TEXT NOT NULL,
	state_reason TEXT,
	created_by TEXT NOT NULL,
	parent_thread TEXT,
	limits TEXT NOT NULL,
	budget_usd REAL NOT NULL DEFAULT 3,
	spent_usd REAL NOT NULL DEFAULT 0,
	start_operation TEXT NOT NULL,
	slot TEXT NOT NULL DEFAULT 'none',
	slot_since INTEGER,
	resume_priority INTEGER NOT NULL DEFAULT 0,
	current_operation TEXT,
	budget_stopped INTEGER NOT NULL DEFAULT 0,
	created_at INTEGER NOT NULL,
	updated_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS coding_checkpoint (
	seq INTEGER PRIMARY KEY AUTOINCREMENT,
	sha TEXT NOT NULL,
	message TEXT NOT NULL,
	operation_id TEXT,
	created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS coding_diff (
	since TEXT NOT NULL,
	head TEXT NOT NULL,
	diff TEXT NOT NULL,
	truncated INTEGER NOT NULL,
	PRIMARY KEY (since, head)
);
CREATE TABLE IF NOT EXISTS coding_test_run (
	seq INTEGER PRIMARY KEY AUTOINCREMENT,
	command TEXT NOT NULL,
	exit_code INTEGER,
	passed INTEGER,
	failed INTEGER,
	duration_ms INTEGER NOT NULL,
	summary TEXT NOT NULL,
	created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS coding_event (
	seq INTEGER PRIMARY KEY AUTOINCREMENT,
	kind TEXT NOT NULL,
	at INTEGER NOT NULL,
	provider TEXT,
	model TEXT,
	input INTEGER NOT NULL DEFAULT 0,
	output INTEGER NOT NULL DEFAULT 0,
	cache_read INTEGER NOT NULL DEFAULT 0,
	cache_write INTEGER NOT NULL DEFAULT 0,
	cost_usd REAL NOT NULL DEFAULT 0,
	data TEXT
);
CREATE TABLE IF NOT EXISTS coding_tool_journal (
	call_id TEXT PRIMARY KEY,
	tool TEXT NOT NULL,
	args TEXT NOT NULL,
	status TEXT,
	result TEXT,
	started_at INTEGER NOT NULL,
	ended_at INTEGER
);
CREATE TABLE IF NOT EXISTS coding_inbox (
	seq INTEGER PRIMARY KEY AUTOINCREMENT,
	operation_id TEXT NOT NULL UNIQUE,
	text TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS coding_notice (
	key TEXT PRIMARY KEY,
	received_at INTEGER NOT NULL
);
`;

/** Every table a thread keeps besides pi's. */
export const CODING_THREAD_TABLES = [
	"coding_thread",
	"coding_checkpoint",
	"coding_diff",
	"coding_test_run",
	"coding_event",
	"coding_tool_journal",
	"coding_inbox",
	"coding_notice",
] as const;

type Row = Record<string, SqlStorageValue>;

const text = (value: SqlStorageValue | undefined) => (value === null || value === undefined ? null : String(value));

export class CodingThreadStore implements ToolJournal {
	readonly #sql: SqlStorage;
	readonly #now: () => number;

	constructor(sql: SqlStorage, now: () => number = Date.now) {
		this.#sql = sql;
		this.#now = now;
		this.#sql.exec(SCHEMA);
		this.#migrate();
	}

	/** Brings an older thread's tables up to date. Columns added after the first schema go here, as `ALTER TABLE` behind a check. */
	#migrate(): void {}

	thread(): CodingThreadRow | null {
		const row = this.#sql.exec("SELECT * FROM coding_thread LIMIT 1").toArray()[0];
		return row ? threadOf(row) : null;
	}

	/** The thread's row; throws when the thread was never started. */
	required(): CodingThreadRow {
		const thread = this.thread();
		if (!thread) throw new Error("This coding thread was never started");
		return thread;
	}

	create(thread: Omit<CodingThreadRow, "baseSha" | "workspaceRef" | "stateReason" | "spentUsd" | "slot" | "slotSince" | "resumePriority" | "currentOperation" | "budgetStopped" | "createdAt" | "updatedAt">): void {
		const now = this.#now();
		this.#sql.exec(
			`INSERT INTO coding_thread (thread_id, space, repo_url, base_ref, branch, agent_profile, provider_id, state, created_by, parent_thread, limits, budget_usd, start_operation, created_at, updated_at)
			VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
			thread.threadId,
			thread.space,
			thread.repoUrl,
			thread.baseRef,
			thread.branch,
			JSON.stringify(thread.profile),
			thread.providerId,
			thread.state,
			thread.createdBy,
			thread.parentThread,
			JSON.stringify(thread.limits),
			thread.budgetUsd,
			thread.startOperation,
			now,
			now,
		);
	}

	/** Sets the given fields of the thread's row. */
	update(change: Partial<Pick<CodingThreadRow, "state" | "stateReason" | "baseSha" | "workspaceRef" | "slot" | "slotSince" | "resumePriority" | "currentOperation" | "budgetStopped" | "budgetUsd">>): void {
		const columns: Record<string, SqlStorageValue> = {};
		if (change.state !== undefined) columns.state = change.state;
		if (change.stateReason !== undefined) columns.state_reason = change.stateReason;
		if (change.baseSha !== undefined) columns.base_sha = change.baseSha;
		if (change.workspaceRef !== undefined) columns.workspace_ref = change.workspaceRef === null ? null : JSON.stringify(change.workspaceRef);
		if (change.slot !== undefined) columns.slot = change.slot;
		if (change.slotSince !== undefined) columns.slot_since = change.slotSince;
		if (change.resumePriority !== undefined) columns.resume_priority = change.resumePriority ? 1 : 0;
		if (change.currentOperation !== undefined) columns.current_operation = change.currentOperation;
		if (change.budgetStopped !== undefined) columns.budget_stopped = change.budgetStopped ? 1 : 0;
		if (change.budgetUsd !== undefined) columns.budget_usd = change.budgetUsd;
		const names = Object.keys(columns);
		if (names.length === 0) return;
		this.#sql.exec(`UPDATE coding_thread SET ${names.map((name) => `${name} = ?`).join(", ")}, updated_at = ?`, ...Object.values(columns), this.#now());
	}

	/** Records a scheduler notice by its key; false when it was recorded before, so it is ignored. */
	firstNotice(key: string): boolean {
		return this.#sql.exec("INSERT INTO coding_notice (key, received_at) VALUES (?, ?) ON CONFLICT (key) DO NOTHING", key, this.#now()).rowsWritten > 0;
	}

	/** Adds an input to wait for the thread's next turn; an operation already added isn't added again. */
	enqueue(operationId: string, text: string): void {
		this.#sql.exec("INSERT INTO coding_inbox (operation_id, text) VALUES (?, ?) ON CONFLICT (operation_id) DO NOTHING", operationId, text);
	}

	nextInput(): InboxItem | null {
		const row = this.#sql.exec("SELECT * FROM coding_inbox ORDER BY seq LIMIT 1").toArray()[0];
		return row ? { seq: Number(row.seq), operationId: String(row.operation_id), text: String(row.text) } : null;
	}

	dequeue(seq: number): void {
		this.#sql.exec("DELETE FROM coding_inbox WHERE seq = ?", seq);
	}

	inboxSize(): number {
		return Number(this.#sql.exec("SELECT COUNT(*) AS n FROM coding_inbox").one().n);
	}

	/** Records a model call's usage and cost, and adds the cost to what the thread has spent. */
	recordModelCall(provider: string, model: string, usage: { input: number; output: number; cacheRead: number; cacheWrite: number }, costUsd: number): void {
		this.#sql.exec(
			"INSERT INTO coding_event (kind, at, provider, model, input, output, cache_read, cache_write, cost_usd) VALUES ('model_call', ?, ?, ?, ?, ?, ?, ?, ?)",
			this.#now(),
			provider,
			model,
			usage.input,
			usage.output,
			usage.cacheRead,
			usage.cacheWrite,
			costUsd,
		);
		this.#sql.exec("UPDATE coding_thread SET spent_usd = spent_usd + ?", costUsd);
	}

	recordEvent(kind: string, data: EventData): CodingEvent {
		const seq = this.#sql.exec("INSERT INTO coding_event (kind, at, data) VALUES (?, ?, ?) RETURNING seq", kind, this.#now(), JSON.stringify(data)).one().seq;
		return this.events(Number(seq) - 1, 1)[0]!;
	}

	/** The log after `since`, oldest first. */
	events(since = 0, limit = 500): CodingEvent[] {
		return this.#sql
			.exec("SELECT * FROM coding_event WHERE seq > ? ORDER BY seq LIMIT ?", since, limit)
			.toArray()
			.map((row) => ({
				seq: Number(row.seq),
				kind: String(row.kind),
				at: Number(row.at),
				provider: text(row.provider),
				model: text(row.model),
				input: Number(row.input),
				output: Number(row.output),
				cacheRead: Number(row.cache_read),
				cacheWrite: Number(row.cache_write),
				costUsd: Number(row.cost_usd),
				data: row.data === null ? null : (JSON.parse(String(row.data)) as EventData),
			}));
	}

	addCheckpoint(sha: string, message: string, operationId: string | null): Checkpoint {
		const seq = this.#sql
			.exec("INSERT INTO coding_checkpoint (sha, message, operation_id, created_at) VALUES (?, ?, ?, ?) RETURNING seq", sha, message, operationId, this.#now())
			.one().seq;
		return this.checkpoints().find((checkpoint) => checkpoint.seq === Number(seq))!;
	}

	checkpoints(): Checkpoint[] {
		return this.#sql
			.exec("SELECT * FROM coding_checkpoint ORDER BY seq")
			.toArray()
			.map((row) => ({ seq: Number(row.seq), sha: String(row.sha), message: String(row.message), operationId: text(row.operation_id), createdAt: Number(row.created_at) }));
	}

	latestCheckpoint(): Checkpoint | null {
		return this.checkpoints().at(-1) ?? null;
	}

	cachedDiff(since: string, head: string): { diff: string; truncated: boolean } | null {
		const row = this.#sql.exec("SELECT diff, truncated FROM coding_diff WHERE since = ? AND head = ?", since, head).toArray()[0];
		return row ? { diff: String(row.diff), truncated: row.truncated === 1 } : null;
	}

	cacheDiff(since: string, head: string, diff: string, truncated: boolean): void {
		this.#sql.exec(
			"INSERT INTO coding_diff (since, head, diff, truncated) VALUES (?, ?, ?, ?) ON CONFLICT (since, head) DO UPDATE SET diff = excluded.diff, truncated = excluded.truncated",
			since,
			head,
			diff,
			truncated ? 1 : 0,
		);
	}

	addTestRun(run: TestRunReport): void {
		this.#sql.exec(
			"INSERT INTO coding_test_run (command, exit_code, passed, failed, duration_ms, summary, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
			run.command,
			run.exitCode,
			run.passed ?? null,
			run.failed ?? null,
			Math.round(run.durationMs),
			run.summary,
			this.#now(),
		);
	}

	testRuns(): TestRun[] {
		return this.#sql
			.exec("SELECT * FROM coding_test_run ORDER BY seq")
			.toArray()
			.map((row) => ({
				seq: Number(row.seq),
				command: String(row.command),
				exitCode: row.exit_code === null ? null : Number(row.exit_code),
				...(row.passed === null ? {} : { passed: Number(row.passed) }),
				...(row.failed === null ? {} : { failed: Number(row.failed) }),
				durationMs: Number(row.duration_ms),
				summary: String(row.summary),
				createdAt: Number(row.created_at),
			}));
	}

	get(callId: string): ToolJournalEntry | null {
		const row = this.#sql.exec("SELECT * FROM coding_tool_journal WHERE call_id = ?", callId).toArray()[0];
		if (!row) return null;
		return {
			callId,
			tool: String(row.tool),
			args: JSON.parse(String(row.args)) as JsonValue,
			startedAt: Number(row.started_at),
			...(row.status === null ? {} : { outcome: { status: String(row.status) as ToolJournalOutcome["status"], result: JSON.parse(String(row.result)) as JsonValue } }),
			...(row.ended_at === null ? {} : { endedAt: Number(row.ended_at) }),
		};
	}

	begin(callId: string, tool: string, args: JsonValue): void {
		this.#sql.exec(
			"INSERT INTO coding_tool_journal (call_id, tool, args, started_at) VALUES (?, ?, ?, ?) ON CONFLICT (call_id) DO NOTHING",
			callId,
			tool,
			JSON.stringify(args),
			this.#now(),
		);
	}

	end(callId: string, outcome: ToolJournalOutcome): void {
		this.#sql.exec("UPDATE coding_tool_journal SET status = ?, result = ?, ended_at = ? WHERE call_id = ?", outcome.status, JSON.stringify(outcome.result), this.#now(), callId);
	}
}

function threadOf(row: Row): CodingThreadRow {
	return {
		threadId: String(row.thread_id),
		space: String(row.space),
		repoUrl: String(row.repo_url),
		baseRef: String(row.base_ref),
		baseSha: text(row.base_sha),
		branch: String(row.branch),
		profile: JSON.parse(String(row.agent_profile)) as AgentProfile,
		providerId: String(row.provider_id),
		workspaceRef: row.workspace_ref === null ? null : (JSON.parse(String(row.workspace_ref)) as WorkspaceRef),
		state: String(row.state) as CodingThreadState,
		stateReason: text(row.state_reason),
		createdBy: String(row.created_by),
		parentThread: text(row.parent_thread),
		limits: JSON.parse(String(row.limits)) as CodingLimits,
		budgetUsd: Number(row.budget_usd),
		spentUsd: Number(row.spent_usd),
		startOperation: String(row.start_operation),
		slot: String(row.slot) as SlotHold,
		slotSince: row.slot_since === null ? null : Number(row.slot_since),
		resumePriority: row.resume_priority === 1,
		currentOperation: text(row.current_operation),
		budgetStopped: row.budget_stopped === 1,
		createdAt: Number(row.created_at),
		updatedAt: Number(row.updated_at),
	};
}
