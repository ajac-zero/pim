import type { ModelThinkingLevel } from "@earendil-works/pi-ai";
import { GITHUB_INSTANCE_ID } from "./git-broker/provider";
import { type CodingEnvironment, NO_ENVIRONMENT } from "./environment-cache";
import type { RunRecord } from "./harness/runner";
import type { HarnessUsage } from "./harness/types";
import type { JournalEntry, TestRun as ToolTestRun, TestSummary } from "./tools";
import type { WorkspaceRef } from "./workspace/types";

/**
 * A coding thread's own tables, in its Durable Object's SQLite database next
 * to pi's (which are prefixed `pi_`). There is one thread per object, so
 * `coding_thread` has one row. Model credentials are never written here:
 * the agent profile names a provider by id only (see ./thread-do.ts).
 */

/** Where a thread is: getting a workspace ready, waiting for a slot, between turns, in a turn, waiting for the person, stopped by a failure, or done. */
export type CodingThreadState = "provisioning" | "queued" | "idle" | "running" | "waiting_input" | "failed" | "archived";

/** Which coding agent runs a thread: pi, the one Pim has built in, or one of the other harnesses. */
export type CodingHarness = "pi" | "claude-code" | "codex" | "mistral-vibe" | "amp";

export const CODING_HARNESSES: readonly CodingHarness[] = ["pi", "claude-code", "codex", "mistral-vibe", "amp"];

/** Which model a thread runs on, by the space's provider id (such as `own:anthropic`) and the model's id there. */
export type AgentProfile = { readonly providerId: string; readonly model: string; readonly thinking?: ModelThinkingLevel };

/** How far a thread's workspace may go, as the workspace spec takes it. `wallClockMin` is a turn's time limit in minutes, null for none: threads have none unless given one. */
export type CodingLimits = { readonly cpu: number; readonly memMiB: number; readonly diskMiB: number; readonly pids: number; readonly wallClockMin: number | null };

/** Whether the thread holds a slot of its space's scheduler, waits in its queue for one, or neither. */
export type SlotHold = "none" | "queued" | "held";

/**
 * The workspace's session, for a backend that caps how long one lasts (`capabilities.sessionMaxMin`). The thread
 * moves to a new session before the cap: it commits a checkpoint, suspends the workspace, resumes it or makes a new
 * one, restores the checkout and goes on. `state` is "continuing" while that happens.
 */
export type CodingSession = {
	readonly state: "active" | "continuing";
	/** When the current session began; null until the thread has a workspace. */
	readonly startedAt: number | null;
	/** How many times the thread moved to a new session. */
	readonly continuations: number;
	/** The latest checkpoint when a turn was last restarted for a session that ended, and how many restarts in a row committed nothing new since: too many fail the thread. */
	readonly restartCheckpoint: string | null;
	readonly unproductiveRestarts: number;
	/** The latest move: how the turn went on in the new session, or that it was restarted from its transcript (`turn_restarted`) because it couldn't go on. */
	readonly last: { readonly at: number; readonly mode: "resumed" | "created" | "turn_restarted"; readonly reason: string } | null;
};

export const NO_SESSION: CodingSession = { state: "active", startedAt: null, continuations: 0, restartCheckpoint: null, unproductiveRestarts: 0, last: null };

export type CodingThreadRow = {
	readonly threadId: string;
	readonly space: string;
	readonly repoUrl: string;
	/** The git provider instance `repoUrl` is on (./git-broker/provider.ts); threads stored before instances existed are GitHub's. */
	readonly providerInstance: string;
	readonly baseRef: string;
	/** The commit `baseRef` named when the repository was cloned; diffs start here. Null until then. */
	readonly baseSha: string | null;
	readonly branch: string;
	readonly profile: AgentProfile;
	readonly harness: CodingHarness;
	/** The workspace provider's id: where the thread runs, or would first try to while it has made no workspace. */
	readonly providerId: string;
	/** Whether the thread stays on its provider: once it made a workspace there, whose files and environment are kept there, or when it was started on that provider by name. Until then it may run on another provider when its own is full. */
	readonly placed: boolean;
	readonly workspaceRef: WorkspaceRef | null;
	readonly state: CodingThreadState;
	/** Why the thread failed, such as `budget`, `no_backend` or `queue_expired`; null otherwise. */
	readonly stateReason: string | null;
	/** What to tell the person about it, such as how to set a backend up; null when the reason says enough. */
	readonly stateDetail: string | null;
	readonly createdBy: string;
	readonly parentThread: string | null;
	readonly limits: CodingLimits;
	/** The most the thread may spend on its model; null when none was set. Stored as 0, which an explicit budget never is. */
	readonly budgetUsd: number | null;
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
	/** The repository's prepared environment in the thread's workspace (./environment-cache.ts). */
	readonly environment: CodingEnvironment;
	/** How many consecutive interruptions (restarts) have been auto-resumed for this thread. Resets to 0 when a turn completes normally. */
	readonly consecutiveInterrupts: number;
	/** The workspace's session: when it began and how often the thread moved to a new one. */
	readonly session: CodingSession;
	/** The pull request opened from the thread's branch (`coding_open_pull_request`); null until one is. */
	readonly pullRequest: { readonly url: string; readonly number: number } | null;
	readonly createdAt: number;
	readonly updatedAt: number;
};

export type Checkpoint = { readonly seq: number; readonly sha: string; readonly message: string; readonly operationId: string | null; readonly createdAt: number };

/** One run of the `test` tool, as the thread keeps it. */
export type TestRun = {
	readonly seq: number;
	readonly command: string;
	readonly exitCode: number | null;
	readonly timedOut: boolean;
	readonly startedAt: number;
	readonly durationMs: number;
	readonly summary: TestSummary | null;
	/** The end of what it printed. */
	readonly output: string;
};

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
	provider_instance TEXT NOT NULL DEFAULT 'github',
	base_ref TEXT NOT NULL,
	base_sha TEXT,
	branch TEXT NOT NULL,
	agent_profile TEXT NOT NULL,
	harness TEXT NOT NULL DEFAULT 'pi',
	provider_id TEXT NOT NULL,
	workspace_ref TEXT,
	state TEXT NOT NULL,
	state_reason TEXT,
	state_detail TEXT,
	created_by TEXT NOT NULL,
	parent_thread TEXT,
	limits TEXT NOT NULL,
	budget_usd REAL NOT NULL DEFAULT 0,
	spent_usd REAL NOT NULL DEFAULT 0,
	start_operation TEXT NOT NULL,
	slot TEXT NOT NULL DEFAULT 'none',
	slot_since INTEGER,
	resume_priority INTEGER NOT NULL DEFAULT 0,
	current_operation TEXT,
	budget_stopped INTEGER NOT NULL DEFAULT 0,
	consecutive_interrupts INTEGER NOT NULL DEFAULT 0,
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
	timed_out INTEGER NOT NULL,
	started_at INTEGER NOT NULL,
	duration_ms INTEGER NOT NULL,
	summary TEXT,
	output TEXT NOT NULL
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
	key TEXT PRIMARY KEY,
	tool TEXT NOT NULL,
	entry TEXT NOT NULL,
	updated_at INTEGER NOT NULL
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
CREATE TABLE IF NOT EXISTS coding_harness_session (
	id INTEGER PRIMARY KEY CHECK (id = 1),
	session_id TEXT NOT NULL,
	cost_usd REAL NOT NULL DEFAULT 0,
	usage TEXT
);
CREATE TABLE IF NOT EXISTS coding_harness_run (
	id INTEGER PRIMARY KEY CHECK (id = 1),
	record TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS coding_autosave (
	id INTEGER PRIMARY KEY CHECK (id = 1),
	head TEXT NOT NULL,
	tree TEXT NOT NULL,
	commit_sha TEXT NOT NULL,
	bundle BLOB,
	saved_at INTEGER NOT NULL
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
	"coding_harness_session",
	"coding_harness_run",
	"coding_autosave",
] as const;

/**
 * The thread's latest autosave of its work (./thread-do.ts): the branch's
 * commit then (`head`), the tree of everything in the checkout, committed
 * or not, and the commit on top of `head` that holds it, which the workspace
 * keeps as `refs/pim/autosave`. `bundle` is a git bundle of everything from
 * the thread's base to that commit, kept here so the work outlives the
 * workspace's volume; null when it was too big to keep.
 */
export type Autosave = { readonly head: string; readonly tree: string; readonly commit: string; readonly bundle: Uint8Array | null; readonly savedAt: number };

/** The CLI harness's session a thread goes on with (./harness/), and its whole cost, or its whole usage for a CLI that reports only that, as the CLI last reported it. */
export type HarnessSession = { readonly sessionId: string; readonly costUsd: number; readonly usage: HarnessUsage | null };

type Row = Record<string, SqlStorageValue>;

const text = (value: SqlStorageValue | undefined) => (value === null || value === undefined ? null : String(value));

export class CodingThreadStore {
	readonly #sql: SqlStorage;
	readonly #now: () => number;
	readonly #changed: () => void;

	/** `changed` hears of each change to the thread's row, its spend included. */
	constructor(sql: SqlStorage, now: () => number = Date.now, changed: () => void = () => {}) {
		this.#sql = sql;
		this.#now = now;
		this.#changed = changed;
		this.#sql.exec(SCHEMA);
		this.#migrate();
	}

	/** Brings an older thread's tables up to date. Columns added after the first schema go here, as `ALTER TABLE` behind a check. */
	#migrate(): void {
		const columns = new Set(this.#sql.exec("PRAGMA table_info(coding_thread)").toArray().map((row) => String(row.name)));
		if (!columns.has("harness")) this.#sql.exec("ALTER TABLE coding_thread ADD COLUMN harness TEXT NOT NULL DEFAULT 'pi'");
		// The nonce the thread's model gateway tokens carry (./model-gateway.ts): null until one is minted, and again once they are revoked.
		if (!columns.has("gateway_nonce")) this.#sql.exec("ALTER TABLE coding_thread ADD COLUMN gateway_nonce TEXT");
		// The prepared environment, as JSON: null until the thread first readies one.
		if (!columns.has("environment")) this.#sql.exec("ALTER TABLE coding_thread ADD COLUMN environment TEXT");
		// A CLI harness's session's whole usage, for one that reports only that (Codex).
		const session = new Set(this.#sql.exec("PRAGMA table_info(coding_harness_session)").toArray().map((row) => String(row.name)));
		if (!session.has("usage")) this.#sql.exec("ALTER TABLE coding_harness_session ADD COLUMN usage TEXT");
		// Which git provider instance the repository is on; rows from before instances existed are GitHub's.
		if (!columns.has("provider_instance")) this.#sql.exec("ALTER TABLE coding_thread ADD COLUMN provider_instance TEXT NOT NULL DEFAULT 'github'");
		// Consecutive interruptions counter for auto-resume.
		if (!columns.has("consecutive_interrupts")) this.#sql.exec("ALTER TABLE coding_thread ADD COLUMN consecutive_interrupts INTEGER NOT NULL DEFAULT 0");
		// The pull request opened from the thread's branch.
		if (!columns.has("pull_request_url")) this.#sql.exec("ALTER TABLE coding_thread ADD COLUMN pull_request_url TEXT");
		// The workspace's session, as JSON.
		if (!columns.has("session")) this.#sql.exec("ALTER TABLE coding_thread ADD COLUMN session TEXT");
		if (!columns.has("pull_request_number")) this.#sql.exec("ALTER TABLE coding_thread ADD COLUMN pull_request_number INTEGER");
		// Whether the thread stays on its provider; threads from before overflow stay where they are.
		if (!columns.has("placed")) this.#sql.exec("ALTER TABLE coding_thread ADD COLUMN placed INTEGER NOT NULL DEFAULT 1");
	}

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

	create(
		thread: Omit<CodingThreadRow, "baseSha" | "workspaceRef" | "stateReason" | "stateDetail" | "spentUsd" | "slot" | "slotSince" | "resumePriority" | "currentOperation" | "budgetStopped" | "environment" | "consecutiveInterrupts" | "pullRequest" | "session" | "createdAt" | "updatedAt" | "providerInstance" | "placed"> & {
			consecutiveInterrupts?: number;
			providerInstance?: string;
			placed?: boolean;
		},
	): void {
		const now = this.#now();
		this.#sql.exec(
			`INSERT INTO coding_thread (thread_id, space, repo_url, provider_instance, base_ref, branch, agent_profile, harness, provider_id, placed, state, created_by, parent_thread, limits, budget_usd, start_operation, consecutive_interrupts, created_at, updated_at)
			VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
			thread.threadId,
			thread.space,
			thread.repoUrl,
			thread.providerInstance ?? GITHUB_INSTANCE_ID,
			thread.baseRef,
			thread.branch,
			JSON.stringify(thread.profile),
			thread.harness,
			thread.providerId,
			thread.placed ? 1 : 0,
			thread.state,
			thread.createdBy,
			thread.parentThread,
			JSON.stringify(thread.limits),
			thread.budgetUsd ?? 0,
			thread.startOperation,
			thread.consecutiveInterrupts ?? 0,
			now,
			now,
		);
		this.#changed();
	}

	/** Sets the given fields of the thread's row. */
	update(
		change: Partial<Pick<CodingThreadRow, "state" | "stateReason" | "stateDetail" | "providerId" | "placed" | "baseSha" | "workspaceRef" | "slot" | "slotSince" | "resumePriority" | "currentOperation" | "budgetStopped" | "budgetUsd" | "environment" | "consecutiveInterrupts" | "pullRequest" | "session">>,
	): void {
		const columns: Record<string, SqlStorageValue> = {};
		if (change.state !== undefined) columns.state = change.state;
		if (change.stateReason !== undefined) columns.state_reason = change.stateReason;
		if (change.stateDetail !== undefined) columns.state_detail = change.stateDetail;
		if (change.providerId !== undefined) columns.provider_id = change.providerId;
		if (change.placed !== undefined) columns.placed = change.placed ? 1 : 0;
		if (change.baseSha !== undefined) columns.base_sha = change.baseSha;
		if (change.workspaceRef !== undefined) columns.workspace_ref = change.workspaceRef === null ? null : JSON.stringify(change.workspaceRef);
		if (change.slot !== undefined) columns.slot = change.slot;
		if (change.slotSince !== undefined) columns.slot_since = change.slotSince;
		if (change.resumePriority !== undefined) columns.resume_priority = change.resumePriority ? 1 : 0;
		if (change.currentOperation !== undefined) columns.current_operation = change.currentOperation;
		if (change.budgetStopped !== undefined) columns.budget_stopped = change.budgetStopped ? 1 : 0;
		if (change.budgetUsd !== undefined) columns.budget_usd = change.budgetUsd ?? 0;
		if (change.environment !== undefined) columns.environment = JSON.stringify(change.environment);
		if (change.session !== undefined) columns.session = JSON.stringify(change.session);
		if (change.consecutiveInterrupts !== undefined) columns.consecutive_interrupts = change.consecutiveInterrupts;
		if (change.pullRequest !== undefined) {
			columns.pull_request_url = change.pullRequest?.url ?? null;
			columns.pull_request_number = change.pullRequest?.number ?? null;
		}
		const names = Object.keys(columns);
		if (names.length === 0) return;
		this.#sql.exec(`UPDATE coding_thread SET ${names.map((name) => `${name} = ?`).join(", ")}, updated_at = ?`, ...Object.values(columns), this.#now());
		this.#changed();
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

	/** Records a model call's usage and cost, and adds the cost to what the thread has spent. `data` says more of it, such as that it went through the model gateway. */
	recordModelCall(provider: string, model: string, usage: { input: number; output: number; cacheRead: number; cacheWrite: number }, costUsd: number, data: EventData | null = null): void {
		this.#sql.exec(
			"INSERT INTO coding_event (kind, at, provider, model, input, output, cache_read, cache_write, cost_usd, data) VALUES ('model_call', ?, ?, ?, ?, ?, ?, ?, ?, ?)",
			this.#now(),
			provider,
			model,
			usage.input,
			usage.output,
			usage.cacheRead,
			usage.cacheWrite,
			costUsd,
			data === null ? null : JSON.stringify(data),
		);
		this.#sql.exec("UPDATE coding_thread SET spent_usd = spent_usd + ?", costUsd);
		this.#changed();
	}

	/** The nonce the thread's live gateway tokens carry, or null when none are. */
	gatewayNonce(): string | null {
		return text(this.#sql.exec("SELECT gateway_nonce FROM coding_thread LIMIT 1").toArray()[0]?.gateway_nonce);
	}

	/** Sets the nonce gateway tokens must carry; null revokes every token minted. */
	setGatewayNonce(nonce: string | null): void {
		this.#sql.exec("UPDATE coding_thread SET gateway_nonce = ?", nonce);
	}

	recordEvent(kind: string, data: EventData): CodingEvent {
		const seq = this.#sql.exec("INSERT INTO coding_event (kind, at, data) VALUES (?, ?, ?) RETURNING seq", kind, this.#now(), JSON.stringify(data)).one().seq;
		return this.events(Number(seq) - 1, 1)[0]!;
	}

	/** Whether Pim has pushed `branch` of the thread's repository, as the log records it. */
	hasPushed(branch: string): boolean {
		return this.#sql
			.exec("SELECT data FROM coding_event WHERE kind = 'thread.pushed'")
			.toArray()
			.some((row) => (JSON.parse(String(row.data)) as { branch?: unknown }).branch === branch);
	}

	/** The log after `since`, oldest first. */
	/** When the latest turn ended, or null if none has. */
	lastTurnEndedAt(): number | null {
		const at = this.#sql.exec("SELECT MAX(at) AS at FROM coding_event WHERE kind = 'thread.turn_ended'").one().at;
		return at === null ? null : Number(at);
	}

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

	addTestRun(run: ToolTestRun): void {
		this.#sql.exec(
			"INSERT INTO coding_test_run (command, exit_code, timed_out, started_at, duration_ms, summary, output) VALUES (?, ?, ?, ?, ?, ?, ?)",
			run.command,
			run.exitCode,
			run.timedOut ? 1 : 0,
			run.startedAt,
			Math.round(run.durationMs),
			run.summary === null ? null : JSON.stringify(run.summary),
			run.output,
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
				timedOut: row.timed_out === 1,
				startedAt: Number(row.started_at),
				durationMs: Number(row.duration_ms),
				summary: row.summary === null ? null : (JSON.parse(String(row.summary)) as TestSummary),
				output: String(row.output),
			}));
	}

	/** The CLI harness's session, once the CLI started one. */
	harnessSession(): HarnessSession | null {
		const row = this.#sql.exec("SELECT session_id, cost_usd, usage FROM coding_harness_session WHERE id = 1").toArray()[0];
		return row ? { sessionId: String(row.session_id), costUsd: Number(row.cost_usd), usage: row.usage === null ? null : (JSON.parse(String(row.usage)) as HarnessUsage) } : null;
	}

	setHarnessSession(session: HarnessSession | null): void {
		if (!session) this.#sql.exec("DELETE FROM coding_harness_session");
		else {
			this.#sql.exec(
				"INSERT INTO coding_harness_session (id, session_id, cost_usd, usage) VALUES (1, ?, ?, ?) ON CONFLICT (id) DO UPDATE SET session_id = excluded.session_id, cost_usd = excluded.cost_usd, usage = excluded.usage",
				session.sessionId,
				session.costUsd,
				session.usage === null ? null : JSON.stringify(session.usage),
			);
		}
	}

	autosave(): Autosave | null {
		const row = this.#sql.exec("SELECT head, tree, commit_sha, bundle, saved_at FROM coding_autosave WHERE id = 1").toArray()[0];
		if (!row) return null;
		return { head: String(row.head), tree: String(row.tree), commit: String(row.commit_sha), bundle: row.bundle === null ? null : new Uint8Array(row.bundle as ArrayBuffer), savedAt: Number(row.saved_at) };
	}

	saveAutosave(autosave: Autosave): void {
		this.#sql.exec(
			"INSERT INTO coding_autosave (id, head, tree, commit_sha, bundle, saved_at) VALUES (1, ?, ?, ?, ?, ?) ON CONFLICT (id) DO UPDATE SET head = excluded.head, tree = excluded.tree, commit_sha = excluded.commit_sha, bundle = excluded.bundle, saved_at = excluded.saved_at",
			autosave.head,
			autosave.tree,
			autosave.commit,
			autosave.bundle,
			autosave.savedAt,
		);
	}

	/** The CLI harness's run under way, as the runner keeps it. */
	harnessRun(): RunRecord | null {
		const row = this.#sql.exec("SELECT record FROM coding_harness_run WHERE id = 1").toArray()[0];
		return row ? (JSON.parse(String(row.record)) as RunRecord) : null;
	}

	saveHarnessRun(record: RunRecord | null): void {
		if (!record) this.#sql.exec("DELETE FROM coding_harness_run");
		else this.#sql.exec("INSERT INTO coding_harness_run (id, record) VALUES (1, ?) ON CONFLICT (id) DO UPDATE SET record = excluded.record", JSON.stringify(record));
	}

	/** What a tool call recorded in the journal, by its key (the call's task id). */
	journalEntry(key: string): JournalEntry | undefined {
		const row = this.#sql.exec("SELECT entry FROM coding_tool_journal WHERE key = ?", key).toArray()[0];
		return row ? (JSON.parse(String(row.entry)) as JournalEntry) : undefined;
	}

	recordJournal(key: string, entry: JournalEntry): void {
		this.#sql.exec(
			"INSERT INTO coding_tool_journal (key, tool, entry, updated_at) VALUES (?, ?, ?, ?) ON CONFLICT (key) DO UPDATE SET tool = excluded.tool, entry = excluded.entry, updated_at = excluded.updated_at",
			key,
			entry.tool,
			JSON.stringify(entry),
			this.#now(),
		);
	}
}

function threadOf(row: Row): CodingThreadRow {
	return {
		threadId: String(row.thread_id),
		space: String(row.space),
		repoUrl: String(row.repo_url),
		providerInstance: text(row.provider_instance) ?? GITHUB_INSTANCE_ID,
		baseRef: String(row.base_ref),
		baseSha: text(row.base_sha),
		branch: String(row.branch),
		profile: JSON.parse(String(row.agent_profile)) as AgentProfile,
		harness: String(row.harness) as CodingHarness,
		providerId: String(row.provider_id),
		placed: row.placed === 1,
		workspaceRef: row.workspace_ref === null ? null : (JSON.parse(String(row.workspace_ref)) as WorkspaceRef),
		state: String(row.state) as CodingThreadState,
		stateReason: text(row.state_reason),
		stateDetail: text(row.state_detail),
		createdBy: String(row.created_by),
		parentThread: text(row.parent_thread),
		limits: readLimits(String(row.limits)),
		budgetUsd: Number(row.budget_usd) || null,
		spentUsd: Number(row.spent_usd),
		startOperation: String(row.start_operation),
		slot: String(row.slot) as SlotHold,
		slotSince: row.slot_since === null ? null : Number(row.slot_since),
		resumePriority: row.resume_priority === 1,
		currentOperation: text(row.current_operation),
		budgetStopped: row.budget_stopped === 1,
		environment: row.environment === null || row.environment === undefined ? NO_ENVIRONMENT : { ...NO_ENVIRONMENT, ...(JSON.parse(String(row.environment)) as Partial<CodingEnvironment>) },
		consecutiveInterrupts: Number(row.consecutive_interrupts),
		session: row.session === null || row.session === undefined ? NO_SESSION : { ...NO_SESSION, ...(JSON.parse(String(row.session)) as Partial<CodingSession>) },
		pullRequest: row.pull_request_url === null || row.pull_request_url === undefined ? null : { url: String(row.pull_request_url), number: Number(row.pull_request_number) },
		createdAt: Number(row.created_at),
		updatedAt: Number(row.updated_at),
	};
}

/** A thread's stored limits. Threads made while turns were limited to 240 minutes by default carry that as their limit; it is read as none. */
function readLimits(json: string): CodingLimits {
	const limits = JSON.parse(json) as Omit<CodingLimits, "wallClockMin"> & { wallClockMin?: number | null };
	return { ...limits, wallClockMin: limits.wallClockMin === 240 ? null : (limits.wallClockMin ?? null) };
}
