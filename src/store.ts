/**
 * The space's own state, in the Durable Object's SQLite database next to pi's
 * tables (pi's are prefixed `pi_`, the SDK's `cf_`, long-term memory's
 * `optmem_`). Each space has its own database, so everything here belongs
 * to its one owner.
 */

import type { PushSubscription } from "./push";

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
	/** The tool "always approve" remembers; null when every call needs explicit approval, or for older requests. */
	readonly tool: string | null;
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
	/** When the timeout decides it, if still pending. */
	readonly expiresAt: number | null;
	/** What the timeout decides: `approve` (the `auto` policy, and approvals filed before policies) or `deny` (a guest's, after a day). */
	readonly onTimeout: "approve" | "deny";
	/** Who decided: the user, the timeout, or the user's "always approve"; null while pending and for older approvals. */
	readonly decidedBy: ApprovalDecider | null;
	/** A guest who asked, from their own space, through one of the owner's circles; null when Pim asked for the owner. */
	readonly requestedBy: ApprovalRequester | null;
	/**
	 * An agent at work on a task asked, another agent or a member of a team:
	 * its `session` is then the task's conversation, where the decision goes,
	 * and the person sees the request in the chat the work began in.
	 */
	readonly member: ApprovalMember | null;
	/**
	 * The majordomo looking at it for the person, under the `majordomo`
	 * policy: `reviewing` while it decides, `escalated` once it asked the
	 * person, with what it told them. Null when the person was asked directly.
	 */
	readonly review: ApprovalReview | null;
};

export type ApprovalReview = { readonly status: "reviewing" | "escalated"; readonly note: string | null };

/** The agent at work on a task whose call filed an approval, by name, and the chat the work began in. */
export type ApprovalMember = { readonly name: string; readonly session: string };

/** A guest whose call filed an approval. Its `session` is then the guest's conversation, in the guest's space. */
export type ApprovalRequester = {
	readonly ownerId: string;
	readonly username: string;
	readonly circle: string;
	readonly circleName: string;
};

export type ApprovalDecider = "user" | "timeout" | "always" | "majordomo";

/** Whether Pim may use a tool: not at all, after asking the user, or without asking. */
export type ToolPermission = "off" | "ask" | "on";

export const TOOL_PERMISSIONS: readonly ToolPermission[] = ["off", "ask", "on"];

/** Whose permissions: the owner's (`OWNER`), or a circle's, by its id. */
export const OWNER = "";

/** A permission the user set for one tool. */
export type ToolPermissionChoice = {
	/** `OWNER`, or the id of the circle the permission is for. */
	readonly audience: string;
	/** The connected app's id; empty for Pim's own tools. */
	readonly app: string;
	/** The tool's own name: the app's name for it, not the `<app>_<tool>` name the model sees. */
	readonly tool: string;
	readonly permission: ToolPermission;
	/** An app tool's definition when the user chose, so a tool the app changes since is noticed; null for Pim's own. */
	readonly definition: string | null;
	readonly updatedAt: number;
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
	readonly responseAt: number | null;
	readonly unread: boolean;
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

/** How many widgets from tool results a chat keeps for its messages. */
const KEPT_WIDGETS = 20;

const ERASED_SCHEMA = "CREATE TABLE IF NOT EXISTS pim_erased (erased_at INTEGER NOT NULL)";

const SCHEMA = `
CREATE TABLE IF NOT EXISTS pim_emails (
	id TEXT PRIMARY KEY,
	session TEXT,
	subject TEXT NOT NULL,
	sent_at INTEGER NOT NULL
);
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
	expires_at INTEGER,
	tool TEXT,
	on_timeout TEXT,
	decided_by TEXT,
	requested_by TEXT,
	member TEXT,
	review TEXT
);
CREATE TABLE IF NOT EXISTS pim_always_approved (
	tool TEXT PRIMARY KEY,
	created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS pim_tool_permissions (
	audience TEXT NOT NULL,
	app TEXT NOT NULL,
	tool TEXT NOT NULL,
	permission TEXT NOT NULL,
	definition TEXT,
	updated_at INTEGER NOT NULL,
	PRIMARY KEY (audience, app, tool)
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
	updated_at INTEGER NOT NULL,
	deleted_at INTEGER,
	summary TEXT,
	summary_of TEXT
);
CREATE TABLE IF NOT EXISTS pim_session_ids (
	id TEXT PRIMARY KEY,
	session TEXT NOT NULL UNIQUE
);
CREATE TABLE IF NOT EXISTS pim_meta (
	key TEXT PRIMARY KEY,
	value TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS pim_tool_widgets (
	id TEXT PRIMARY KEY,
	session TEXT NOT NULL,
	widget TEXT NOT NULL,
	created_at INTEGER NOT NULL
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
CREATE TABLE IF NOT EXISTS pim_push_subscriptions (
	endpoint TEXT PRIMARY KEY,
	p256dh TEXT NOT NULL,
	auth TEXT NOT NULL,
	created_at INTEGER NOT NULL
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
		tool: row.tool === null ? null : String(row.tool),
		args: JSON.parse(String(row.args)) as unknown,
		summary: String(row.summary),
		status: String(row.status) as ApprovalStatus,
		note: row.note === null ? null : String(row.note),
		result: row.result === null ? null : String(row.result),
		createdAt: Number(row.created_at),
		decidedAt: row.decided_at === null ? null : Number(row.decided_at),
		callId: row.call_id === null ? null : String(row.call_id),
		expiresAt: row.expires_at === null ? null : Number(row.expires_at),
		onTimeout: row.on_timeout === "deny" ? "deny" : "approve",
		decidedBy: row.decided_by === null || row.decided_by === undefined ? null : (String(row.decided_by) as ApprovalDecider),
		requestedBy: row.requested_by ? (JSON.parse(String(row.requested_by)) as ApprovalRequester) : null,
		member: row.member ? (JSON.parse(String(row.member)) as ApprovalMember) : null,
		review: row.review ? (JSON.parse(String(row.review)) as ApprovalReview) : null,
	};
}

function toolPermissionOf(row: Row): ToolPermissionChoice {
	return {
		audience: String(row.audience),
		app: String(row.app),
		tool: String(row.tool),
		permission: String(row.permission) as ToolPermission,
		definition: row.definition === null ? null : String(row.definition),
		updatedAt: Number(row.updated_at),
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

	/**
	 * When this space was erased, or null. The mark is written right after
	 * the wipe and is the only thing an erased agent keeps: it refuses every
	 * request from then on, so nothing can be written to it again.
	 */
	erasedAt(): number | null {
		const row = this.#sql.exec("SELECT erased_at FROM pim_erased LIMIT 1").toArray()[0];
		return row ? Number(row.erased_at) : null;
	}

	/** Marks the space erased; after `deleteAll`, so it makes its own table. */
	markErased(now: number): void {
		this.#sql.exec(ERASED_SCHEMA);
		this.#sql.exec("INSERT INTO pim_erased (erased_at) VALUES (?)", now);
	}

	/**
	 * Which kinds of the person's data this database still holds, by table:
	 * none once the space is erased. Conversations are pi's (`pi_entries`).
	 */
	remainingData(): string[] {
		const remaining: string[] = [];
		const tables: Record<string, string> = {
			pim_goals: "goals",
			pim_approvals: "approvals",
			pim_always_approved: "always-approved tools",
			pim_tool_permissions: "tool permissions",
			pim_circles: "circles",
			pim_circle_members: "circle members",
			pim_guest_activity: "guest activity",
			pim_guest_calls: "guest calls",
			pim_agents: "Agents",
			pim_team_runs: "Agents' team work",
			pim_agent_sessions: "Agents' chats",
			pim_shares: "Spaces shared with them",
			pim_mcp_servers: "apps",
			pim_app_watches: "watches",
			pim_sessions: "chats",
			pim_session_ids: "chat ids",
			pim_chat_links: "public links to chats",
			pim_credentials: "credentials",
			pim_app_connections: "app connections",
			pim_tool_widgets: "widgets from apps' results",
			pim_notifications: "notifications",
			pim_emails: "emails sent",
			pim_push_subscriptions: "push subscriptions",
			pim_artifacts: "artifacts",
			pim_artifact_versions: "artifact versions",
			pim_artifact_deleted: "deleted artifact ids",
			pim_artifact_data: "what artifacts keep",
			pim_artifact_grants: "what artifacts may use",
			pim_artifact_circles: "artifacts' circles",
			pi_entries: "conversations",
		};
		const existing = new Set(
			this.#sql.exec("SELECT name FROM sqlite_master WHERE type = 'table'").toArray().map((row) => String(row.name)),
		);
		for (const [table, kind] of Object.entries(tables)) {
			if (existing.has(table) && this.#sql.exec(`SELECT 1 FROM ${table} LIMIT 1`).toArray().length > 0) remaining.push(kind);
		}
		if (this.meta("owner") !== undefined) remaining.push("owner profile");
		return remaining;
	}

	constructor(sql: SqlStorage) {
		this.#sql = sql;
		this.#sql.exec(SCHEMA);
		this.#sql.exec(ERASED_SCHEMA);
		// Approvals made before these columns existed have neither.
		const columns = this.#sql.exec("PRAGMA table_info(pim_approvals)").toArray().map((row) => String(row.name));
		if (!columns.includes("call_id")) this.#sql.exec("ALTER TABLE pim_approvals ADD COLUMN call_id TEXT");
		if (!columns.includes("expires_at")) this.#sql.exec("ALTER TABLE pim_approvals ADD COLUMN expires_at INTEGER");
		if (!columns.includes("tool")) this.#sql.exec("ALTER TABLE pim_approvals ADD COLUMN tool TEXT");
		if (!columns.includes("on_timeout")) this.#sql.exec("ALTER TABLE pim_approvals ADD COLUMN on_timeout TEXT");
		if (!columns.includes("decided_by")) this.#sql.exec("ALTER TABLE pim_approvals ADD COLUMN decided_by TEXT");
		if (!columns.includes("requested_by")) this.#sql.exec("ALTER TABLE pim_approvals ADD COLUMN requested_by TEXT");
		if (!columns.includes("member")) this.#sql.exec("ALTER TABLE pim_approvals ADD COLUMN member TEXT");
		if (!columns.includes("review")) this.#sql.exec("ALTER TABLE pim_approvals ADD COLUMN review TEXT");
		const sessionColumns = this.#sql.exec("PRAGMA table_info(pim_sessions)").toArray().map((row) => String(row.name));
		if (!sessionColumns.includes("deleted_at")) this.#sql.exec("ALTER TABLE pim_sessions ADD COLUMN deleted_at INTEGER");
		if (!sessionColumns.includes("summary")) this.#sql.exec("ALTER TABLE pim_sessions ADD COLUMN summary TEXT");
		if (!sessionColumns.includes("summary_of")) this.#sql.exec("ALTER TABLE pim_sessions ADD COLUMN summary_of TEXT");
		if (!sessionColumns.includes("response_at")) this.#sql.exec("ALTER TABLE pim_sessions ADD COLUMN response_at INTEGER");
		if (!sessionColumns.includes("read_at")) this.#sql.exec("ALTER TABLE pim_sessions ADD COLUMN read_at INTEGER");
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
		tool: string | null;
		args: unknown;
		summary: string;
		callId: string;
		createdAt: number;
		/** Null: it waits for an answer however long. */
		expiresAt: number | null;
		onTimeout: "approve" | "deny";
		requestedBy?: ApprovalRequester;
		member?: ApprovalMember | null;
	}): Approval {
		this.#sql.exec(
			"INSERT OR IGNORE INTO pim_approvals (id, session, action, tool, args, summary, status, created_at, call_id, expires_at, on_timeout, requested_by, member) VALUES (?, ?, ?, ?, ?, ?, 'pending', ?, ?, ?, ?, ?, ?)",
			input.id,
			input.session,
			input.action,
			input.tool,
			JSON.stringify(input.args),
			input.summary,
			input.createdAt,
			input.callId,
			input.expiresAt,
			input.onTimeout,
			input.requestedBy === undefined ? null : JSON.stringify(input.requestedBy),
			input.member ? JSON.stringify(input.member) : null,
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
	decideApproval(id: string, status: "approved" | "denied", note: string | null, decidedBy: ApprovalDecider = "user"): boolean {
		return (
			this.#sql.exec(
				"UPDATE pim_approvals SET status = ?, note = ?, decided_at = ?, decided_by = ? WHERE id = ? AND status = 'pending'",
				status,
				note,
				Date.now(),
				decidedBy,
				id,
			).rowsWritten > 0
		);
	}

	setApprovalReview(id: string, review: ApprovalReview): void {
		this.#sql.exec("UPDATE pim_approvals SET review = ? WHERE id = ?", JSON.stringify(review), id);
	}

	recordApprovalResult(id: string, result: string): void {
		this.#sql.exec("UPDATE pim_approvals SET result = ? WHERE id = ?", result, id);
	}

	// Tool permissions the user set. A tool without one follows its default.

	toolPermission(audience: string, app: string, tool: string): ToolPermissionChoice | undefined {
		const [row] = this.#sql
			.exec("SELECT * FROM pim_tool_permissions WHERE audience = ? AND app = ? AND tool = ?", audience, app, tool)
			.toArray();
		return row ? toolPermissionOf(row) : undefined;
	}

	/** One audience's permissions, or every audience's. */
	toolPermissions(audience?: string): ToolPermissionChoice[] {
		const rows =
			audience === undefined
				? this.#sql.exec("SELECT * FROM pim_tool_permissions ORDER BY audience, app, tool")
				: this.#sql.exec("SELECT * FROM pim_tool_permissions WHERE audience = ? ORDER BY app, tool", audience);
		return rows.toArray().map(toolPermissionOf);
	}

	setToolPermission(audience: string, app: string, tool: string, permission: ToolPermission, definition: string | null): void {
		this.#sql.exec(
			"INSERT INTO pim_tool_permissions (audience, app, tool, permission, definition, updated_at) VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT (audience, app, tool) DO UPDATE SET permission = excluded.permission, definition = excluded.definition, updated_at = excluded.updated_at",
			audience,
			app,
			tool,
			permission,
			definition,
			Date.now(),
		);
	}

	/** Back to the tool's default. False when the user had not set one. */
	clearToolPermission(audience: string, app: string, tool: string): boolean {
		return (
			this.#sql.exec("DELETE FROM pim_tool_permissions WHERE audience = ? AND app = ? AND tool = ?", audience, app, tool)
				.rowsWritten > 0
		);
	}

	/** Forgets one audience's permissions: a circle that is gone. */
	clearAudience(audience: string): void {
		this.#sql.exec("DELETE FROM pim_tool_permissions WHERE audience = ?", audience);
	}

	/**
	 * Tools the user chose "Always approve" for before tool permissions, by
	 * the name the model sees. Each becomes an `on` permission once the
	 * agent can tell which tool the name belongs to.
	 */
	legacyAlwaysApproved(): string[] {
		return this.#sql
			.exec("SELECT tool FROM pim_always_approved ORDER BY tool")
			.toArray()
			.map((row) => String(row.tool));
	}

	forgetLegacyAlwaysApproved(tool: string): void {
		this.#sql.exec("DELETE FROM pim_always_approved WHERE tool = ?", tool);
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

	/** Forgets an app's policy and the permissions set for its tools. */
	deleteMcpApproval(id: string): void {
		this.#sql.exec("DELETE FROM pim_mcp_servers WHERE id = ?", id);
		this.#sql.exec("DELETE FROM pim_tool_permissions WHERE app = ?", id);
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

	// Sessions: what a sidebar shows. pi owns the conversations; this is their ids, titles and activity.

	/**
	 * The id a conversation goes by outside the space: in the app's addresses,
	 * the API, links, and what agents read. pi numbers its conversations
	 * from a counter it shares with everything else it stores, so those
	 * numbers stay inside; each conversation gets a random id the first time
	 * it is shown, and keeps it.
	 */
	publicId(session: string): string {
		this.#sql.exec("INSERT OR IGNORE INTO pim_session_ids (id, session) VALUES (?, ?)", crypto.randomUUID(), session);
		return String(this.#sql.exec("SELECT id FROM pim_session_ids WHERE session = ?", session).one().id);
	}

	/** The conversation a public id names, if any (see `publicId`). */
	sessionOf(id: string): string | undefined {
		const [row] = this.#sql.exec("SELECT session FROM pim_session_ids WHERE id = ?", id).toArray();
		return row ? String(row.session) : undefined;
	}

	sessionInfo(id: string): SessionInfo | undefined {
		const [row] = this.#sql.exec("SELECT * FROM pim_sessions WHERE id = ?", id).toArray();
		return row
			? {
				id,
				title: row.title === null ? null : String(row.title),
				createdAt: Number(row.created_at),
				updatedAt: Number(row.updated_at),
				responseAt: row.response_at === null ? null : Number(row.response_at),
				unread: Number(row.response_at ?? 0) > Number(row.read_at ?? 0),
			}
			: undefined;
	}

	/**
	 * Records activity in a session; `title` names it only if it has no name yet.
	 * A deleted session that gets a message (the root, which API clients use by default) is listed again.
	 */
	touchSession(id: string, title?: string): void {
		const now = Date.now();
		this.#sql.exec(
			"INSERT INTO pim_sessions (id, title, created_at, updated_at) VALUES (?, ?, ?, ?) ON CONFLICT (id) DO UPDATE SET updated_at = excluded.updated_at, title = COALESCE(pim_sessions.title, excluded.title), deleted_at = NULL",
			id,
			title ?? null,
			now,
			now,
		);
	}

	/** A delivered reply is unread until a client acknowledges that reply, not a later one. */
	recordResponse(id: string, at: number): void {
		this.touchSession(id);
		this.#sql.exec("UPDATE pim_sessions SET response_at = MAX(COALESCE(response_at, 0), ?) WHERE id = ?", at, id);
	}

	readSession(id: string, through: number): void {
		this.#sql.exec("UPDATE pim_sessions SET read_at = MAX(COALESCE(read_at, 0), MIN(COALESCE(response_at, 0), ?)) WHERE id = ?", through, id);
	}

	/** pi cannot delete a conversation, so a deleted session is only hidden: from the list and from the API. */
	deleteSession(id: string): void {
		const now = Date.now();
		this.#sql.exec(
			"INSERT INTO pim_sessions (id, title, created_at, updated_at, deleted_at) VALUES (?, NULL, ?, ?, ?) ON CONFLICT (id) DO UPDATE SET deleted_at = excluded.deleted_at",
			id,
			now,
			now,
			now,
		);
	}

	deletedSessions(): Set<string> {
		return new Set(
			this.#sql
				.exec("SELECT id FROM pim_sessions WHERE deleted_at IS NOT NULL")
				.toArray()
				.map((row) => String(row.id)),
		);
	}

	/** Renames a session only if it is still called `from`, so a rename meanwhile stays; says whether it did. */
	retitleSession(id: string, from: string, title: string): boolean {
		return this.#sql.exec("UPDATE pim_sessions SET title = ? WHERE id = ? AND title = ?", title, id, from).rowsWritten > 0;
	}

	/** A session's last summary, if it summarized the conversation `of` names (a hash of it), so it is still current. */
	sessionSummary(id: string, of: string): string | undefined {
		const [row] = this.#sql.exec("SELECT summary FROM pim_sessions WHERE id = ? AND summary_of = ?", id, of).toArray();
		return row?.summary == null ? undefined : String(row.summary);
	}

	setSessionSummary(id: string, summary: string, of: string): void {
		this.#sql.exec("UPDATE pim_sessions SET summary = ?, summary_of = ? WHERE id = ?", summary, of, id);
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

	// What app tools' results showed, kept for their chat to put under a message: the latest few of each

	keepWidget(session: string, widget: unknown): string {
		const id = `tool:${crypto.randomUUID().replaceAll("-", "").slice(0, 12)}`;
		this.#sql.exec("INSERT INTO pim_tool_widgets (id, session, widget, created_at) VALUES (?, ?, ?, ?)", id, session, JSON.stringify(widget), Date.now());
		// A message keeps its own copy of what it showed: older results needn't stay.
		this.#sql.exec(
			"DELETE FROM pim_tool_widgets WHERE session = ? AND id NOT IN (SELECT id FROM pim_tool_widgets WHERE session = ? ORDER BY created_at DESC, rowid DESC LIMIT ?)",
			session,
			session,
			KEPT_WIDGETS,
		);
		return id;
	}

	keptWidgets(session: string): string[] {
		return this.#sql
			.exec("SELECT id FROM pim_tool_widgets WHERE session = ? ORDER BY created_at, rowid", session)
			.toArray()
			.map((row) => String(row.id));
	}

	keptWidget<T>(session: string, id: string): T | undefined {
		const [row] = this.#sql.exec("SELECT widget FROM pim_tool_widgets WHERE session = ? AND id = ?", session, id).toArray();
		return row ? (JSON.parse(String(row.widget)) as T) : undefined;
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

	// Emails Pim sent: its messages (by session), and confirmation codes (no session)

	emailSent(id: string): boolean {
		return this.#sql.exec("SELECT 1 FROM pim_emails WHERE id = ?", id).toArray().length > 0;
	}

	recordEmail(input: { id: string; session: string | null; subject: string }): void {
		this.#sql.exec(
			"INSERT OR IGNORE INTO pim_emails (id, session, subject, sent_at) VALUES (?, ?, ?, ?)",
			input.id,
			input.session,
			input.subject,
			Date.now(),
		);
	}

	/** Emails sent since `since` (ms): Pim's messages, or confirmation codes. */
	emailsSince(since: number, kind: "messages" | "codes"): number {
		const [row] = this.#sql
			.exec(`SELECT COUNT(*) AS count FROM pim_emails WHERE sent_at >= ? AND session IS ${kind === "codes" ? "" : "NOT "}NULL`, since)
			.toArray();
		return Number(row?.count ?? 0);
	}

	// Web Push subscriptions, one per browser that turned notifications on

	pushSubscriptions(): PushSubscription[] {
		return this.#sql
			.exec("SELECT endpoint, p256dh, auth FROM pim_push_subscriptions ORDER BY created_at")
			.toArray()
			.map((row) => ({ endpoint: String(row.endpoint), p256dh: String(row.p256dh), auth: String(row.auth) }));
	}

	putPushSubscription(subscription: PushSubscription): void {
		this.#sql.exec(
			"INSERT INTO pim_push_subscriptions (endpoint, p256dh, auth, created_at) VALUES (?, ?, ?, ?) ON CONFLICT (endpoint) DO UPDATE SET p256dh = excluded.p256dh, auth = excluded.auth",
			subscription.endpoint,
			subscription.p256dh,
			subscription.auth,
			Date.now(),
		);
	}

	deletePushSubscription(endpoint: string): void {
		this.#sql.exec("DELETE FROM pim_push_subscriptions WHERE endpoint = ?", endpoint);
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
