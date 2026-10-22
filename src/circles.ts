import { EVERYONE_SCOPE } from "./extensions/optmem/store";

/**
 * The people a space's owner lets message it, in circles: Family, Close
 * friends, Acquaintances. Each circle has its own tool permissions (in
 * `pim_tool_permissions`, by the circle's id), and anything a circle wasn't
 * given is off. A person is in at most one circle.
 *
 * Guests never run anything here: their conversations with this space run in
 * their own space (see ./visits.ts), on their own usage, and every tool they
 * use comes back here through `Pim.guestCall`, which checks the circle and
 * the tool's permission each time. A circle reads the memory scopes the
 * owner ticked for it, and no others.
 */

export type Circle = {
	readonly id: string;
	readonly name: string;
	/** Off: nobody in the circle can message the space, until it is on again. */
	readonly enabled: boolean;
	/** The owner's memory scopes it reads, by key: everyone's, or ones the owner named. */
	readonly memoryScopes: readonly string[];
	readonly createdAt: number;
};

/** Someone the owner put in a circle. */
export type Member = {
	/** Their space's owner ID: who a guest call is from. */
	readonly ownerId: string;
	readonly username: string;
	readonly circle: string;
	readonly addedAt: number;
};

/** A guest's tool call, as the owner sees it afterwards. */
export type GuestActivity = {
	readonly id: number;
	readonly at: number;
	readonly username: string;
	readonly circle: string;
	/** The tool, as `<app>_<tool>`, or `memory`. */
	readonly tool: string;
	/** `ran`: used without asking; `asked`: filed an approval; `refused`: the circle doesn't have it. */
	readonly outcome: "ran" | "asked" | "refused";
	readonly summary: string;
};

/** Who is calling: a guest's space, as the Worker or the guest's own agent vouches. */
export type Guest = { readonly ownerId: string; readonly username: string };

const SCHEMA = `
CREATE TABLE IF NOT EXISTS pim_circles (
	id TEXT PRIMARY KEY,
	name TEXT NOT NULL,
	enabled INTEGER NOT NULL,
	created_at INTEGER NOT NULL,
	memory_scopes TEXT NOT NULL DEFAULT '[]'
);
CREATE TABLE IF NOT EXISTS pim_circle_members (
	owner_id TEXT PRIMARY KEY,
	username TEXT NOT NULL,
	circle_id TEXT NOT NULL,
	added_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS pim_guest_calls (
	owner_id TEXT NOT NULL,
	day TEXT NOT NULL,
	calls INTEGER NOT NULL,
	PRIMARY KEY (owner_id, day)
);
CREATE TABLE IF NOT EXISTS pim_guest_activity (
	id INTEGER PRIMARY KEY AUTOINCREMENT,
	at INTEGER NOT NULL,
	username TEXT NOT NULL,
	circle_id TEXT NOT NULL,
	tool TEXT NOT NULL,
	outcome TEXT NOT NULL,
	summary TEXT NOT NULL
);
`;

/** Guest calls the activity log keeps, newest first. */
const ACTIVITY_KEPT = 500;
export const MAX_CIRCLES = 20;
/** People in all circles together. */
export const MAX_MEMBERS = 200;
/** Tool calls one guest may make in a UTC day: their model is theirs, but the owner's apps and their limits are the owner's. */
export const GUEST_CALLS_PER_DAY = 200;
export const MAX_CIRCLE_NAME = 40;

type Row = Record<string, SqlStorageValue>;

const circleOf = (row: Row): Circle => ({
	id: String(row.id),
	name: String(row.name),
	enabled: Number(row.enabled) === 1,
	memoryScopes: JSON.parse(String(row.memory_scopes)) as string[],
	createdAt: Number(row.created_at),
});

const memberOf = (row: Row): Member => ({
	ownerId: String(row.owner_id),
	username: String(row.username),
	circle: String(row.circle_id),
	addedAt: Number(row.added_at),
});

export class CircleStore {
	readonly #sql: SqlStorage;

	constructor(sql: SqlStorage) {
		this.#sql = sql;
		this.#sql.exec(SCHEMA);
		const columns = this.#sql.exec("PRAGMA table_info(pim_circles)").toArray().map((row) => String(row.name));
		if (!columns.includes("memory_scopes")) {
			this.#sql.exec("ALTER TABLE pim_circles ADD COLUMN memory_scopes TEXT NOT NULL DEFAULT '[]'");
			// Memory was once one switch, which let a circle read all of it: such a circle reads everyone's scope now.
			const tables = this.#sql.exec("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'pim_tool_permissions'").toArray();
			if (tables.length > 0) {
				this.#sql.exec(
					`UPDATE pim_circles SET memory_scopes = '["${EVERYONE_SCOPE}"]' WHERE id IN (SELECT audience FROM pim_tool_permissions WHERE app = '' AND tool = 'memory' AND permission = 'on')`,
				);
				this.#sql.exec("DELETE FROM pim_tool_permissions WHERE app = '' AND tool = 'memory'");
			}
		}
	}

	circles(): Circle[] {
		return this.#sql.exec("SELECT * FROM pim_circles ORDER BY created_at, id").toArray().map(circleOf);
	}

	circle(id: string): Circle | undefined {
		const [row] = this.#sql.exec("SELECT * FROM pim_circles WHERE id = ?", id).toArray();
		return row ? circleOf(row) : undefined;
	}

	createCircle(name: string): Circle {
		const id = `c_${crypto.randomUUID().replaceAll("-", "").slice(0, 12)}`;
		this.#sql.exec("INSERT INTO pim_circles (id, name, enabled, created_at) VALUES (?, ?, 1, ?)", id, name, Date.now());
		return this.circle(id)!;
	}

	updateCircle(id: string, change: { name?: string; enabled?: boolean; memoryScopes?: readonly string[] }): void {
		if (change.name !== undefined) this.#sql.exec("UPDATE pim_circles SET name = ? WHERE id = ?", change.name, id);
		if (change.enabled !== undefined) this.#sql.exec("UPDATE pim_circles SET enabled = ? WHERE id = ?", change.enabled ? 1 : 0, id);
		if (change.memoryScopes !== undefined) this.#sql.exec("UPDATE pim_circles SET memory_scopes = ? WHERE id = ?", JSON.stringify(change.memoryScopes), id);
	}

	/** No circle reads a memory scope any more, as when it is deleted. */
	dropMemoryScope(key: string): void {
		for (const circle of this.circles()) {
			if (circle.memoryScopes.includes(key)) this.updateCircle(circle.id, { memoryScopes: circle.memoryScopes.filter((other) => other !== key) });
		}
	}

	/** Deletes the circle and lets go of its members; returns them. Its permissions are the caller's to clear. */
	deleteCircle(id: string): Member[] {
		const members = this.members(id);
		this.#sql.exec("DELETE FROM pim_circle_members WHERE circle_id = ?", id);
		this.#sql.exec("DELETE FROM pim_circles WHERE id = ?", id);
		return members;
	}

	/** Everyone in circles, or in one. */
	members(circle?: string): Member[] {
		const rows =
			circle === undefined
				? this.#sql.exec("SELECT * FROM pim_circle_members ORDER BY username")
				: this.#sql.exec("SELECT * FROM pim_circle_members WHERE circle_id = ? ORDER BY username", circle);
		return rows.toArray().map(memberOf);
	}

	member(ownerId: string): Member | undefined {
		const [row] = this.#sql.exec("SELECT * FROM pim_circle_members WHERE owner_id = ?", ownerId).toArray();
		return row ? memberOf(row) : undefined;
	}

	/** Puts someone in a circle, moving them from any other. */
	addMember(circle: string, guest: Guest): Member {
		this.#sql.exec(
			"INSERT INTO pim_circle_members (owner_id, username, circle_id, added_at) VALUES (?, ?, ?, ?) ON CONFLICT (owner_id) DO UPDATE SET circle_id = excluded.circle_id, username = excluded.username",
			guest.ownerId,
			guest.username,
			circle,
			Date.now(),
		);
		return this.member(guest.ownerId)!;
	}

	/** False when they were in no circle. */
	removeMember(ownerId: string): boolean {
		return this.#sql.exec("DELETE FROM pim_circle_members WHERE owner_id = ?", ownerId).rowsWritten > 0;
	}

	/**
	 * Counts a guest's call against today's allowance, in one synchronous
	 * step; false, and not counted, once it is used up.
	 */
	countCall(ownerId: string, now = Date.now()): boolean {
		const day = new Date(now).toISOString().slice(0, 10);
		const [row] = this.#sql.exec("SELECT calls FROM pim_guest_calls WHERE owner_id = ? AND day = ?", ownerId, day).toArray();
		if (Number(row?.calls ?? 0) >= GUEST_CALLS_PER_DAY) return false;
		this.#sql.exec(
			"INSERT INTO pim_guest_calls (owner_id, day, calls) VALUES (?, ?, 1) ON CONFLICT (owner_id, day) DO UPDATE SET calls = calls + 1",
			ownerId,
			day,
		);
		this.#sql.exec("DELETE FROM pim_guest_calls WHERE day < ?", new Date(now - 7 * 86_400_000).toISOString().slice(0, 10));
		return true;
	}

	logActivity(entry: Omit<GuestActivity, "id" | "at">): void {
		this.#sql.exec(
			"INSERT INTO pim_guest_activity (at, username, circle_id, tool, outcome, summary) VALUES (?, ?, ?, ?, ?, ?)",
			Date.now(),
			entry.username,
			entry.circle,
			entry.tool,
			entry.outcome,
			entry.summary,
		);
		this.#sql.exec(
			"DELETE FROM pim_guest_activity WHERE id <= (SELECT id FROM pim_guest_activity ORDER BY id DESC LIMIT 1 OFFSET ?)",
			ACTIVITY_KEPT,
		);
	}

	activity(limit = 100): GuestActivity[] {
		return this.#sql
			.exec("SELECT * FROM pim_guest_activity ORDER BY id DESC LIMIT ?", limit)
			.toArray()
			.map((row) => ({
				id: Number(row.id),
				at: Number(row.at),
				username: String(row.username),
				circle: String(row.circle_id),
				tool: String(row.tool),
				outcome: String(row.outcome) as GuestActivity["outcome"],
				summary: String(row.summary),
			}));
	}
}
