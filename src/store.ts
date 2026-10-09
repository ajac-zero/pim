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
	/** The tool call that filed it, so a client can show the two as one. */
	readonly callId: string | null;
	/** When it is approved automatically if still pending. */
	readonly expiresAt: number | null;
};

export type Notification = {
	readonly id: string;
	readonly session: string | null;
	readonly title: string;
	readonly body: string;
	readonly createdAt: number;
	readonly readAt: number | null;
};

/** A subscription to one event type of a connected app, and what to do when it fires. */
export type AppWatch = {
	readonly id: string;
	readonly serverId: string;
	readonly event: string;
	readonly arguments: Record<string, unknown>;
	readonly instruction: string;
	/** The session events are delivered to. */
	readonly session: string;
	/** Standard Webhooks secret (`whsec_...`) the app signs deliveries with. */
	readonly secret: string;
	/** The callback URL the app delivers to. */
	readonly url: string;
	readonly remoteId: string | null;
	readonly cursor: string | null;
	/** When the subscription must be renewed (ms), or null when it does not expire. */
	readonly refreshBefore: number | null;
	readonly status: "pending" | "active" | "ended";
	readonly lastError: string | null;
	readonly lastEventAt: number | null;
	readonly createdAt: number;
};

/** A session's name and activity, for listing conversations. */
export type SessionInfo = {
	readonly id: string;
	/** Null until named: by the first message the user sends, or by renaming. */
	readonly title: string | null;
	readonly createdAt: number;
	readonly updatedAt: number;
};

type Row = Record<string, SqlStorageValue>;

function watchOf(row: Row): AppWatch {
	return {
		id: String(row.id),
		serverId: String(row.server_id),
		event: String(row.event),
		arguments: JSON.parse(String(row.arguments)) as Record<string, unknown>,
		instruction: String(row.instruction),
		session: String(row.session),
		secret: String(row.secret),
		url: String(row.url),
		remoteId: row.remote_id === null ? null : String(row.remote_id),
		cursor: row.cursor === null ? null : String(row.cursor),
		refreshBefore: row.refresh_before === null ? null : Number(row.refresh_before),
		status: String(row.status) as AppWatch["status"],
		lastError: row.last_error === null ? null : String(row.last_error),
		lastEventAt: row.last_event_at === null ? null : Number(row.last_event_at),
		createdAt: Number(row.created_at),
	};
}

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
	decided_at INTEGER,
	call_id TEXT,
	expires_at INTEGER
);
CREATE TABLE IF NOT EXISTS pim_mcp_servers (
	id TEXT PRIMARY KEY,
	approval TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS pim_app_catalog (
	server_id TEXT NOT NULL,
	kind TEXT NOT NULL,
	data TEXT NOT NULL,
	expires_at INTEGER NOT NULL,
	PRIMARY KEY (server_id, kind)
);
CREATE TABLE IF NOT EXISTS pim_app_watches (
	id TEXT PRIMARY KEY,
	server_id TEXT NOT NULL,
	event TEXT NOT NULL,
	arguments TEXT NOT NULL,
	instruction TEXT NOT NULL,
	session TEXT NOT NULL,
	secret TEXT NOT NULL,
	url TEXT NOT NULL,
	remote_id TEXT,
	cursor TEXT,
	refresh_before INTEGER,
	status TEXT NOT NULL,
	last_error TEXT,
	last_event_at INTEGER,
	created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS pim_sessions (
	id TEXT PRIMARY KEY,
	title TEXT,
	created_at INTEGER NOT NULL,
	updated_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS pim_meta (
	key TEXT PRIMARY KEY,
	value TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS pim_credentials (
	provider TEXT PRIMARY KEY,
	credential TEXT NOT NULL
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
		callId: row.call_id === null ? null : String(row.call_id),
		expiresAt: row.expires_at === null ? null : Number(row.expires_at),
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
		// Approvals made before these columns existed have neither.
		const columns = this.#sql.exec("PRAGMA table_info(pim_approvals)").toArray().map((row) => String(row.name));
		if (!columns.includes("call_id")) this.#sql.exec("ALTER TABLE pim_approvals ADD COLUMN call_id TEXT");
		if (!columns.includes("expires_at")) this.#sql.exec("ALTER TABLE pim_approvals ADD COLUMN expires_at INTEGER");
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
	requestApproval(input: {
		id: string;
		session: string;
		action: string;
		args: unknown;
		summary: string;
		callId: string;
		expiresAt: number;
	}): Approval {
		this.#sql.exec(
			"INSERT OR IGNORE INTO pim_approvals (id, session, action, args, summary, status, created_at, call_id, expires_at) VALUES (?, ?, ?, ?, ?, 'pending', ?, ?, ?)",
			input.id,
			input.session,
			input.action,
			JSON.stringify(input.args),
			input.summary,
			Date.now(),
			input.callId,
			input.expiresAt,
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

	// Connected apps: the MCP client stores the servers; this is pim's policy for each.

	mcpApproval(id: string): string | undefined {
		const [row] = this.#sql.exec("SELECT approval FROM pim_mcp_servers WHERE id = ?", id).toArray();
		return row ? String(row.approval) : undefined;
	}

	setMcpApproval(id: string, approval: string): void {
		this.#sql.exec(
			"INSERT INTO pim_mcp_servers (id, approval) VALUES (?, ?) ON CONFLICT (id) DO UPDATE SET approval = excluded.approval",
			id,
			approval,
		);
	}

	deleteMcpApproval(id: string): void {
		this.#sql.exec("DELETE FROM pim_mcp_servers WHERE id = ?", id);
	}

	// What connected apps offer beyond tools: skills and event types, cached per app.

	catalog<T>(serverId: string, kind: "skills" | "events"): { data: T; expiresAt: number } | undefined {
		const [row] = this.#sql
			.exec("SELECT data, expires_at FROM pim_app_catalog WHERE server_id = ? AND kind = ?", serverId, kind)
			.toArray();
		return row ? { data: JSON.parse(String(row.data)) as T, expiresAt: Number(row.expires_at) } : undefined;
	}

	setCatalog(serverId: string, kind: "skills" | "events", data: unknown, expiresAt: number): void {
		this.#sql.exec(
			"INSERT INTO pim_app_catalog (server_id, kind, data, expires_at) VALUES (?, ?, ?, ?) ON CONFLICT (server_id, kind) DO UPDATE SET data = excluded.data, expires_at = excluded.expires_at",
			serverId,
			kind,
			JSON.stringify(data),
			expiresAt,
		);
	}

	deleteCatalog(serverId: string): void {
		this.#sql.exec("DELETE FROM pim_app_catalog WHERE server_id = ?", serverId);
	}

	// Event watches: subscriptions to connected apps' events.

	addWatch(watch: Omit<AppWatch, "remoteId" | "cursor" | "refreshBefore" | "status" | "lastError" | "lastEventAt" | "createdAt">): AppWatch {
		this.#sql.exec(
			"INSERT OR IGNORE INTO pim_app_watches (id, server_id, event, arguments, instruction, session, secret, url, status, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?)",
			watch.id,
			watch.serverId,
			watch.event,
			JSON.stringify(watch.arguments),
			watch.instruction,
			watch.session,
			watch.secret,
			watch.url,
			Date.now(),
		);
		return this.watch(watch.id)!;
	}

	watch(id: string): AppWatch | undefined {
		const [row] = this.#sql.exec("SELECT * FROM pim_app_watches WHERE id = ?", id).toArray();
		return row ? watchOf(row) : undefined;
	}

	watches(serverId?: string): AppWatch[] {
		const rows =
			serverId === undefined
				? this.#sql.exec("SELECT * FROM pim_app_watches ORDER BY created_at, rowid")
				: this.#sql.exec("SELECT * FROM pim_app_watches WHERE server_id = ? ORDER BY created_at, rowid", serverId);
		return rows.toArray().map(watchOf);
	}

	updateWatch(
		id: string,
		change: Partial<Pick<AppWatch, "remoteId" | "cursor" | "refreshBefore" | "status" | "lastError" | "lastEventAt">>,
	): void {
		const watch = this.watch(id);
		if (!watch) return;
		const next = { ...watch, ...change };
		this.#sql.exec(
			"UPDATE pim_app_watches SET remote_id = ?, cursor = ?, refresh_before = ?, status = ?, last_error = ?, last_event_at = ? WHERE id = ?",
			next.remoteId,
			next.cursor,
			next.refreshBefore,
			next.status,
			next.lastError,
			next.lastEventAt,
			id,
		);
	}

	deleteWatch(id: string): boolean {
		return this.#sql.exec("DELETE FROM pim_app_watches WHERE id = ?", id).rowsWritten > 0;
	}

	// Sessions: what a sidebar shows. pi owns the conversations; this is their title and activity.

	sessionInfo(id: string): SessionInfo | undefined {
		const [row] = this.#sql.exec("SELECT * FROM pim_sessions WHERE id = ?", id).toArray();
		return row
			? { id, title: row.title === null ? null : String(row.title), createdAt: Number(row.created_at), updatedAt: Number(row.updated_at) }
			: undefined;
	}

	/** Records activity in a session; `title` names it only if it has no name yet. */
	touchSession(id: string, title?: string): void {
		const now = Date.now();
		this.#sql.exec(
			"INSERT INTO pim_sessions (id, title, created_at, updated_at) VALUES (?, ?, ?, ?) ON CONFLICT (id) DO UPDATE SET updated_at = excluded.updated_at, title = COALESCE(pim_sessions.title, excluded.title)",
			id,
			title ?? null,
			now,
			now,
		);
	}

	renameSession(id: string, title: string): void {
		this.touchSession(id);
		this.#sql.exec("UPDATE pim_sessions SET title = ? WHERE id = ?", title, id);
	}

	meta(key: string): string | undefined {
		const [row] = this.#sql.exec("SELECT value FROM pim_meta WHERE key = ?", key).toArray();
		return row ? String(row.value) : undefined;
	}

	setMeta(key: string, value: string): void {
		this.#sql.exec(
			"INSERT INTO pim_meta (key, value) VALUES (?, ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value",
			key,
			value,
		);
	}

	// Model credentials, as pi-ai's JSON, by provider id

	credential(provider: string): string | undefined {
		const [row] = this.#sql.exec("SELECT credential FROM pim_credentials WHERE provider = ?", provider).toArray();
		return row ? String(row.credential) : undefined;
	}

	credentialProviders(): string[] {
		return this.#sql
			.exec("SELECT provider FROM pim_credentials ORDER BY provider")
			.toArray()
			.map((row) => String(row.provider));
	}

	putCredential(provider: string, credential: string): void {
		this.#sql.exec(
			"INSERT INTO pim_credentials (provider, credential) VALUES (?, ?) ON CONFLICT (provider) DO UPDATE SET credential = excluded.credential",
			provider,
			credential,
		);
	}

	deleteCredential(provider: string): void {
		this.#sql.exec("DELETE FROM pim_credentials WHERE provider = ?", provider);
	}

	deleteMeta(key: string): void {
		this.#sql.exec("DELETE FROM pim_meta WHERE key = ?", key);
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
