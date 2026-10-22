import { type Block, buildableBlocks } from "./cover";

/** One memory: a line in the append-only log. */
export type MemoryEntry = {
	readonly id: number;
	/** YYYY-MM-DD in the user's time zone. */
	readonly date: string;
	/** Empty once forgotten. */
	readonly text: string;
	readonly forgotten: boolean;
	/** The conversation that noted it, or null when it came from outside one (the API). */
	readonly source: string | null;
	/** The scope it is kept in: who may read it is the host's to say. */
	readonly scope: string;
};

/** One summarized block of a scope's tree. */
export type MemorySummary = { readonly scope: string; readonly lo: number; readonly hi: number; readonly text: string };

/** What a nap needs to compress one block. */
export type NapInput = {
	readonly scope: string;
	readonly block: Block;
	/** The lines to compress: raw memories, or the two half summaries. */
	readonly lines: readonly string[];
	/** Forget generation the lines were read at; a summary of older lines is stale. */
	readonly epoch: number;
};

/** A scope the person named, such as Work, for the agents they choose. */
export type NamedScope = { readonly key: string; readonly name: string; readonly createdAt: number };

/** The longest one memory or summary may be, in UTF-8 bytes. */
export const ENTRY_BYTES = 280;

export const FORGOTTEN = "(forgotten at the user's request)";
const MOVED = "(moved to another scope)";

/** The longest a scope's name may be, in characters. */
export const MAX_SCOPE_NAME = 40;

/** Named scopes one person may have. */
export const MAX_NAMED_SCOPES = 20;

/** Memories from before scopes are in this one: the host's most private. */
export const PRIVATE_SCOPE = "private";

/** The scope the host lets every reader read. */
export const EVERYONE_SCOPE = "everyone";

const SCHEMA = `
CREATE TABLE IF NOT EXISTS optmem_log (
	id INTEGER PRIMARY KEY,
	key TEXT UNIQUE,
	date TEXT NOT NULL,
	text TEXT NOT NULL,
	forgotten INTEGER NOT NULL DEFAULT 0,
	source TEXT,
	scope TEXT NOT NULL DEFAULT '${PRIVATE_SCOPE}',
	pos INTEGER,
	moved INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS optmem_tree (
	scope TEXT NOT NULL,
	size INTEGER NOT NULL,
	lo INTEGER NOT NULL,
	text TEXT NOT NULL,
	PRIMARY KEY (scope, size, lo)
);
CREATE TABLE IF NOT EXISTS optmem_meta (
	key TEXT PRIMARY KEY,
	value TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS optmem_scopes (
	key TEXT PRIMARY KEY,
	name TEXT NOT NULL,
	created_at INTEGER NOT NULL
);
`;

type Row = Record<string, SqlStorageValue>;

function entryOf(row: Row): MemoryEntry {
	return {
		id: Number(row.id),
		date: String(row.date),
		text: String(row.text),
		forgotten: Number(row.forgotten) === 1,
		source: row.source === null ? null : String(row.source),
		scope: String(row.scope),
	};
}

/** `#id date text`: how a raw memory is shown to the model. */
export function entryLine(entry: MemoryEntry): string {
	return `#${entry.id} ${entry.date} ${entry.forgotten ? FORGOTTEN : entry.text === "" ? MOVED : entry.text}`;
}

export function byteLength(text: string): number {
	return new TextEncoder().encode(text).length;
}

/**
 * The log is canonical and append-only: a memory keeps its id forever, and
 * forgetting blanks its text rather than removing it, so ids never shift.
 *
 * Each memory is kept in one scope, and each scope is a log of its own: its
 * memories have places 0, 1, 2, ... in it (`pos`), and its tree of
 * summaries is built over those places, so no summary mixes scopes. Moving
 * a memory to another scope appends it there as a new memory and leaves its
 * old place empty, as forgetting does. The trees are a cache of summaries,
 * rebuildable from the log.
 */
export class OptMemStore {
	readonly #sql: SqlStorage;

	constructor(sql: SqlStorage) {
		this.#sql = sql;
		this.#sql.exec(SCHEMA);
		this.#addScopes();
		this.#sql.exec("CREATE UNIQUE INDEX IF NOT EXISTS optmem_places ON optmem_log (scope, pos)");
	}

	/**
	 * Memories from before scopes all go to the most private one, in the
	 * order they were noted, so its tree is the one they had.
	 */
	#addScopes(): void {
		const columns = (table: string) => new Set(this.#sql.exec(`PRAGMA table_info(${table})`).toArray().map((row) => String(row.name)));
		if (!columns("optmem_log").has("scope")) {
			this.#sql.exec(`ALTER TABLE optmem_log ADD COLUMN scope TEXT NOT NULL DEFAULT '${PRIVATE_SCOPE}'`);
			this.#sql.exec("ALTER TABLE optmem_log ADD COLUMN pos INTEGER");
			this.#sql.exec("ALTER TABLE optmem_log ADD COLUMN moved INTEGER NOT NULL DEFAULT 0");
			this.#sql.exec("UPDATE optmem_log SET pos = id");
		}
		if (!columns("optmem_tree").has("scope")) {
			this.#sql.exec("ALTER TABLE optmem_tree RENAME TO optmem_tree_unscoped");
			this.#sql.exec(SCHEMA);
			this.#sql.exec(`INSERT INTO optmem_tree (scope, size, lo, text) SELECT '${PRIVATE_SCOPE}', size, lo, text FROM optmem_tree_unscoped`);
			this.#sql.exec("DROP TABLE optmem_tree_unscoped");
		}
	}

	/** Memories in all scopes, those forgotten too, but not the places left by moves. */
	count(): number {
		return Number(this.#sql.exec("SELECT COUNT(*) AS n FROM optmem_log WHERE moved = 0").one().n);
	}

	/** Memories in each scope that has any, as `count` counts them. */
	counts(): Map<string, number> {
		return new Map(
			this.#sql
				.exec("SELECT scope, COUNT(*) AS n FROM optmem_log WHERE moved = 0 GROUP BY scope")
				.toArray()
				.map((row) => [String(row.scope), Number(row.n)]),
		);
	}

	/** Places in a scope's log: its memories, and those moved out of it. */
	size(scope: string): number {
		return Number(this.#sql.exec("SELECT COUNT(*) AS n FROM optmem_log WHERE scope = ?", scope).one().n);
	}

	/**
	 * Appends one memory to a scope and returns it. Idempotent on `key`: the
	 * same key again returns the memory it already saved.
	 */
	append(text: string, date: string, options: { key?: string; source?: string | null; scope: string }): MemoryEntry {
		const key = options.key ?? crypto.randomUUID();
		const known = this.keyed(key);
		if (known) return known;
		const id = Number(this.#sql.exec("SELECT COUNT(*) AS n FROM optmem_log").one().n);
		this.#sql.exec(
			"INSERT INTO optmem_log (id, key, date, text, source, scope, pos) VALUES (?, ?, ?, ?, ?, ?, ?)",
			id,
			key,
			date,
			text,
			options.source ?? null,
			options.scope,
			this.size(options.scope),
		);
		return this.entry(id)!;
	}

	/**
	 * Memories at or after the given place of each scope that are not
	 * forgotten and were not noted by conversation `except`, oldest first.
	 */
	since(from: ReadonlyMap<string, number>, except: string): MemoryEntry[] {
		return [...from]
			.flatMap(([scope, pos]) =>
				this.#sql
					.exec(
						"SELECT * FROM optmem_log WHERE scope = ? AND pos >= ? AND forgotten = 0 AND moved = 0 AND (source IS NULL OR source != ?)",
						scope,
						pos,
						except,
					)
					.toArray()
					.map(entryOf),
			)
			.sort((a, b) => a.id - b.id);
	}

	/** The memory saved with an `append` key, if one was. */
	keyed(key: string): MemoryEntry | undefined {
		const [row] = this.#sql.exec("SELECT * FROM optmem_log WHERE key = ?", key).toArray();
		return row ? entryOf(row) : undefined;
	}

	/** A memory by its id; undefined for none, or for the place a move left. */
	entry(id: number): MemoryEntry | undefined {
		const [row] = this.#sql.exec("SELECT * FROM optmem_log WHERE id = ? AND moved = 0", id).toArray();
		return row ? entryOf(row) : undefined;
	}

	/** The memory at one place of a scope's log, or what a move left there. */
	at(scope: string, pos: number): MemoryEntry | undefined {
		const [row] = this.#sql.exec("SELECT * FROM optmem_log WHERE scope = ? AND pos = ?", scope, pos).toArray();
		return row ? entryOf(row) : undefined;
	}

	/** Whether a move emptied that place. */
	moved(scope: string, pos: number): boolean {
		const [row] = this.#sql.exec("SELECT moved FROM optmem_log WHERE scope = ? AND pos = ?", scope, pos).toArray();
		return Number(row?.moved) === 1;
	}

	/** A scope's places [lo, hi), oldest first. */
	entries(scope: string, lo: number, hi: number): MemoryEntry[] {
		return this.#sql
			.exec("SELECT * FROM optmem_log WHERE scope = ? AND pos >= ? AND pos < ? ORDER BY pos", scope, lo, hi)
			.toArray()
			.map(entryOf);
	}

	/** Newest first, optionally before an id and only in some scopes, for paging. */
	page(limit: number, before?: number, scopes?: readonly string[]): MemoryEntry[] {
		return this.#sql
			.exec(
				`SELECT * FROM optmem_log WHERE moved = 0 AND id < ?${scopes === undefined ? "" : ` AND scope IN (SELECT value FROM json_each(?))`} ORDER BY id DESC LIMIT ?`,
				...[before ?? Number.MAX_SAFE_INTEGER, ...(scopes === undefined ? [] : [JSON.stringify(scopes)]), limit],
			)
			.toArray()
			.map(entryOf);
	}

	/** Newest matches of `pattern` among memories not forgotten, optionally only in some scopes, and how many matched in all. */
	search(pattern: RegExp, limit: number, scopes?: readonly string[]): { matches: MemoryEntry[]; total: number } {
		const matches: MemoryEntry[] = [];
		let total = 0;
		const among = scopes === undefined ? null : new Set(scopes);
		// Streamed newest first: the whole log is never held in memory.
		for (const row of this.#sql.exec("SELECT * FROM optmem_log WHERE forgotten = 0 AND moved = 0 ORDER BY id DESC")) {
			const entry = entryOf(row);
			if (among !== null && !among.has(entry.scope)) continue;
			if (!pattern.test(`${entry.date} ${entry.text}`)) continue;
			total++;
			if (matches.length < limit) matches.push(entry);
		}
		return { matches, total };
	}

	summary(scope: string, [lo, hi]: Block): string | undefined {
		const [row] = this.#sql.exec("SELECT text FROM optmem_tree WHERE scope = ? AND size = ? AND lo = ?", scope, hi - lo, lo).toArray();
		return row ? String(row.text) : undefined;
	}

	/** Blocks that can be built and are not, in every scope, smallest first. */
	pending(limit = Number.POSITIVE_INFINITY): { scope: string; block: Block }[] {
		const built = new Set(
			this.#sql
				.exec("SELECT scope, size, lo FROM optmem_tree")
				.toArray()
				.map((row) => `${row.scope}:${row.size}:${row.lo}`),
		);
		const sizes = this.#sql.exec("SELECT scope, COUNT(*) AS n FROM optmem_log GROUP BY scope ORDER BY scope").toArray();
		const out: { scope: string; block: Block }[] = [];
		for (const row of sizes) {
			const scope = String(row.scope);
			for (const block of buildableBlocks(Number(row.n))) {
				if (!built.has(`${scope}:${block[1] - block[0]}:${block[0]}`)) out.push({ scope, block });
			}
		}
		// Stable: within one size, scopes keep their order and blocks theirs.
		out.sort((a, b) => a.block[1] - a.block[0] - (b.block[1] - b.block[0]));
		return out.slice(0, limit);
	}

	/**
	 * What compressing a scope's block needs, or undefined when it cannot be
	 * done now: already built, or a half it is built from is still missing.
	 */
	napInput(scope: string, block: Block, rawMax: number): NapInput | undefined {
		const [lo, hi] = block;
		if (this.summary(scope, block) !== undefined || hi > this.size(scope)) return undefined;
		const epoch = this.epoch();
		if (hi - lo <= rawMax) return { scope, block, lines: this.entries(scope, lo, hi).map(entryLine), epoch };
		const lines: string[] = [];
		const mid = (lo + hi) / 2;
		for (const half of [
			[lo, mid],
			[mid, hi],
		] as const) {
			const text = this.summary(scope, half);
			if (text === undefined) return undefined;
			lines.push(`#${half[0]}-${half[1] - 1} ${text}`);
		}
		return { scope, block, lines, epoch };
	}

	/**
	 * Stores a summary, unless one is there already or a memory was forgotten
	 * or moved since its lines were read: such a summary may still hold it.
	 */
	putSummary(scope: string, block: Block, text: string, epoch: number): boolean {
		if (epoch !== this.epoch()) return false;
		return (
			this.#sql.exec(
				"INSERT OR IGNORE INTO optmem_tree (scope, size, lo, text) VALUES (?, ?, ?, ?)",
				scope,
				block[1] - block[0],
				block[0],
				text,
			).rowsWritten > 0
		);
	}

	/** Blanks a memory's place and drops every summary built over it; naps rebuild them without it. */
	#blank(entry: MemoryEntry, column: "forgotten" | "moved"): void {
		const [row] = this.#sql.exec("SELECT pos FROM optmem_log WHERE id = ?", entry.id).toArray();
		const pos = Number(row!.pos);
		this.#sql.exec(`UPDATE optmem_log SET text = '', ${column} = 1 WHERE id = ?`, entry.id);
		this.#sql.exec("DELETE FROM optmem_tree WHERE scope = ? AND lo <= ? AND ? < lo + size", entry.scope, pos, pos);
		this.#sql.exec(
			"INSERT INTO optmem_meta (key, value) VALUES ('epoch', '1') ON CONFLICT (key) DO UPDATE SET value = CAST(value AS INTEGER) + 1",
		);
	}

	/**
	 * Blanks one memory and drops every summary built over it; naps rebuild
	 * them without it. False when there is no such memory.
	 */
	forget(id: number): boolean {
		const entry = this.entry(id);
		if (!entry) return false;
		this.#blank(entry, "forgotten");
		return true;
	}

	/**
	 * Moves a memory to another scope: it is appended there, with the date it
	 * was noted, as a new memory, which this returns, and its old place is
	 * emptied, as forgetting empties it.
	 */
	move(id: number, scope: string, options: { key?: string; source?: string | null } = {}): MemoryEntry {
		const entry = this.entry(id)!;
		const moved = this.append(entry.text, entry.date, { ...options, scope });
		this.#blank(entry, "moved");
		return moved;
	}

	/** Drops one summary of a scope and every summary built on it; the log is untouched. */
	dropSummary(scope: string, [lo, hi]: Block): number {
		return this.#sql.exec("DELETE FROM optmem_tree WHERE scope = ? AND size >= ? AND lo <= ? AND ? < lo + size", scope, hi - lo, lo, lo)
			.rowsWritten;
	}

	epoch(): number {
		const [row] = this.#sql.exec("SELECT value FROM optmem_meta WHERE key = 'epoch'").toArray();
		return row ? Number(row.value) : 0;
	}

	meta(key: string): string | undefined {
		const [row] = this.#sql.exec("SELECT value FROM optmem_meta WHERE key = ?", key).toArray();
		return row ? String(row.value) : undefined;
	}

	setMeta(key: string, value: string): void {
		this.#sql.exec(
			"INSERT INTO optmem_meta (key, value) VALUES (?, ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value",
			key,
			value,
		);
	}

	/** The scopes the person named, oldest first. */
	namedScopes(): NamedScope[] {
		return this.#sql
			.exec("SELECT * FROM optmem_scopes ORDER BY created_at, key")
			.toArray()
			.map((row) => ({ key: String(row.key), name: String(row.name), createdAt: Number(row.created_at) }));
	}

	createScope(name: string): NamedScope {
		const key = `s_${crypto.randomUUID().replaceAll("-", "").slice(0, 12)}`;
		this.#sql.exec("INSERT INTO optmem_scopes (key, name, created_at) VALUES (?, ?, ?)", key, name, Date.now());
		return this.namedScopes().find((scope) => scope.key === key)!;
	}

	renameScope(key: string, name: string): void {
		this.#sql.exec("UPDATE optmem_scopes SET name = ? WHERE key = ?", name, key);
	}

	/** Deletes a named scope; its memories stay where they are, for the host to say who reads them. */
	deleteScope(key: string): boolean {
		return this.#sql.exec("DELETE FROM optmem_scopes WHERE key = ?", key).rowsWritten > 0;
	}
}
