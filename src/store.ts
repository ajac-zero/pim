/**
 * Pim's own state, in the Durable Object's SQLite database next to pi's
 * tables (pi's are prefixed `pi_`, the SDK's `cf_`, long-term memory's
 * `optmem_`). A deployment has one
 * agent, so everything here belongs to the person who deployed it.
 */

export type GoalStatus = "active" | "paused" | "done" | "abandoned";

export type GoalStep = { readonly text: string; readonly done: boolean };

export type GoalNote = { readonly at: number; readonly text: string };

export type Goal = {
	readonly id: string;
	readonly title: string;
	readonly status: GoalStatus;
	readonly steps: readonly GoalStep[];
	readonly notes: readonly GoalNote[];
	/** The session the goal was created in; scheduled check-ins go there. */
	readonly session: string;
	readonly createdAt: number;
	readonly updatedAt: number;
};

export type ApprovalStatus = "pending" | "approved" | "denied";

export type Approval = {
	readonly id: string;
	readonly session: string;
	/** The gated action's name, such as `http_request`. */
	readonly action: string;
	readonly args: unknown;
	/** One line the user reads to decide. */
	readonly summary: string;
	readonly status: ApprovalStatus;
	readonly note: string | null;
	readonly result: string | null;
	readonly createdAt: number;
	readonly decidedAt: number | null;
};

export type Notification = {
	readonly id: string;
	readonly session: string | null;
	readonly title: string;
	readonly body: string;
	readonly createdAt: number;
	readonly readAt: number | null;
};

type Row = Record<string, SqlStorageValue>;

const SCHEMA = `
CREATE TABLE IF NOT EXISTS pim_goals (
	id TEXT PRIMARY KEY,
	title TEXT NOT NULL,
	status TEXT NOT NULL,
	steps TEXT NOT NULL,
	notes TEXT NOT NULL,
	session TEXT NOT NULL,
	created_at INTEGER NOT NULL,
	updated_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS pim_approvals (
	id TEXT PRIMARY KEY,
	session TEXT NOT NULL,
	action TEXT NOT NULL,
	args TEXT NOT NULL,
	summary TEXT NOT NULL,
	status TEXT NOT NULL,
	note TEXT,
	result TEXT,
	created_at INTEGER NOT NULL,
	decided_at INTEGER
);
CREATE TABLE IF NOT EXISTS pim_notifications (
	id TEXT PRIMARY KEY,
	session TEXT,
	title TEXT NOT NULL,
	body TEXT NOT NULL,
	created_at INTEGER NOT NULL,
	read_at INTEGER
);
`;

function goalOf(row: Row): Goal {
	return {
		id: String(row.id),
		title: String(row.title),
		status: String(row.status) as GoalStatus,
		steps: JSON.parse(String(row.steps)) as GoalStep[],
		notes: JSON.parse(String(row.notes)) as GoalNote[],
		session: String(row.session),
		createdAt: Number(row.created_at),
		updatedAt: Number(row.updated_at),
	};
}

function approvalOf(row: Row): Approval {
	return {
		id: String(row.id),
		session: String(row.session),
		action: String(row.action),
		args: JSON.parse(String(row.args)) as unknown,
		summary: String(row.summary),
		status: String(row.status) as ApprovalStatus,
		note: row.note === null ? null : String(row.note),
		result: row.result === null ? null : String(row.result),
		createdAt: Number(row.created_at),
		decidedAt: row.decided_at === null ? null : Number(row.decided_at),
	};
}

function notificationOf(row: Row): Notification {
	return {
		id: String(row.id),
		session: row.session === null ? null : String(row.session),
		title: String(row.title),
		body: String(row.body),
		createdAt: Number(row.created_at),
		readAt: row.read_at === null ? null : Number(row.read_at),
	};
}

export class PimStore {
	readonly #sql: SqlStorage;

	constructor(sql: SqlStorage) {
		this.#sql = sql;
		this.#sql.exec(SCHEMA);
	}

	// Goals

	createGoal(input: { title: string; steps: readonly string[]; session: string; id?: string }): Goal {
		const id = input.id ?? crypto.randomUUID();
		const now = Date.now();
		const steps: GoalStep[] = input.steps.map((text) => ({ text, done: false }));
		this.#sql.exec(
			"INSERT OR IGNORE INTO pim_goals (id, title, status, steps, notes, session, created_at, updated_at) VALUES (?, ?, 'active', ?, '[]', ?, ?, ?)",
			id,
			input.title,
			JSON.stringify(steps),
			input.session,
			now,
			now,
		);
		return this.goal(id)!;
	}

	goal(id: string): Goal | undefined {
		const [row] = this.#sql.exec("SELECT * FROM pim_goals WHERE id = ?", id).toArray();
		return row ? goalOf(row) : undefined;
	}

	goals(status?: GoalStatus): Goal[] {
		const rows =
			status === undefined
				? this.#sql.exec("SELECT * FROM pim_goals ORDER BY created_at DESC, rowid DESC")
				: this.#sql.exec("SELECT * FROM pim_goals WHERE status = ? ORDER BY created_at DESC, rowid DESC", status);
		return rows.toArray().map(goalOf);
	}

	updateGoal(
		id: string,
		change: {
			status?: GoalStatus;
			/** 1-based step numbers to mark done. */
			completeSteps?: readonly number[];
			addSteps?: readonly string[];
			note?: string;
		},
	): Goal | undefined {
		const goal = this.goal(id);
		if (!goal) return undefined;
		const complete = new Set(change.completeSteps ?? []);
		const steps = [
			...goal.steps.map((step, index) => (complete.has(index + 1) ? { ...step, done: true } : step)),
			...(change.addSteps ?? []).map((text) => ({ text, done: false })),
		];
		const now = Date.now();
		const notes = change.note ? [...goal.notes, { at: now, text: change.note }] : goal.notes;
		this.#sql.exec(
			"UPDATE pim_goals SET status = ?, steps = ?, notes = ?, updated_at = ? WHERE id = ?",
			change.status ?? goal.status,
			JSON.stringify(steps),
			JSON.stringify(notes),
			now,
			id,
		);
		return this.goal(id);
	}

	deleteGoal(id: string): boolean {
		return this.#sql.exec("DELETE FROM pim_goals WHERE id = ?", id).rowsWritten > 0;
	}

	// Approvals

	/** Idempotent on `id`: a replayed tool call finds the request it already made. */
	requestApproval(input: { id: string; session: string; action: string; args: unknown; summary: string }): Approval {
		this.#sql.exec(
			"INSERT OR IGNORE INTO pim_approvals (id, session, action, args, summary, status, created_at) VALUES (?, ?, ?, ?, ?, 'pending', ?)",
			input.id,
			input.session,
			input.action,
			JSON.stringify(input.args),
			input.summary,
			Date.now(),
		);
		return this.approval(input.id)!;
	}

	approval(id: string): Approval | undefined {
		const [row] = this.#sql.exec("SELECT * FROM pim_approvals WHERE id = ?", id).toArray();
		return row ? approvalOf(row) : undefined;
	}

	approvals(status?: ApprovalStatus): Approval[] {
		const rows =
			status === undefined
				? this.#sql.exec("SELECT * FROM pim_approvals ORDER BY created_at DESC, rowid DESC")
				: this.#sql.exec("SELECT * FROM pim_approvals WHERE status = ? ORDER BY created_at DESC, rowid DESC", status);
		return rows.toArray().map(approvalOf);
	}

	/** Moves a pending approval to its decision. False when it was not pending. */
	decideApproval(id: string, status: "approved" | "denied", note: string | null): boolean {
		return (
			this.#sql.exec(
				"UPDATE pim_approvals SET status = ?, note = ?, decided_at = ? WHERE id = ? AND status = 'pending'",
				status,
				note,
				Date.now(),
				id,
			).rowsWritten > 0
		);
	}

	recordApprovalResult(id: string, result: string): void {
		this.#sql.exec("UPDATE pim_approvals SET result = ? WHERE id = ?", result, id);
	}

	// Notifications

	addNotification(input: { id: string; session: string | null; title: string; body: string }): Notification {
		this.#sql.exec(
			"INSERT OR IGNORE INTO pim_notifications (id, session, title, body, created_at) VALUES (?, ?, ?, ?, ?)",
			input.id,
			input.session,
			input.title,
			input.body,
			Date.now(),
		);
		return this.notification(input.id)!;
	}

	notification(id: string): Notification | undefined {
		const [row] = this.#sql.exec("SELECT * FROM pim_notifications WHERE id = ?", id).toArray();
		return row ? notificationOf(row) : undefined;
	}

	notifications(options: { unread?: boolean; limit?: number } = {}): Notification[] {
		const where = options.unread ? "WHERE read_at IS NULL" : "";
		return this.#sql
			.exec(`SELECT * FROM pim_notifications ${where} ORDER BY created_at DESC, rowid DESC LIMIT ?`, options.limit ?? 100)
			.toArray()
			.map(notificationOf);
	}

	markNotificationRead(id: string): boolean {
		return (
			this.#sql.exec("UPDATE pim_notifications SET read_at = ? WHERE id = ? AND read_at IS NULL", Date.now(), id)
				.rowsWritten > 0
		);
	}
}
