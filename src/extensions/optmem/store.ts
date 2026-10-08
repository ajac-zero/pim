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
};

/** One summarized block of the tree. */
export type MemorySummary = { readonly lo: number; readonly hi: number; readonly text: string };

/** What a nap needs to compress one block. */
export type NapInput = {
	readonly block: Block;
	/** The lines to compress: raw memories, or the two half summaries. */
	readonly lines: readonly string[];
	/** Forget generation the lines were read at; a summary of older lines is stale. */
	readonly epoch: number;
};

/** The longest one memory or summary may be, in UTF-8 bytes. */
export const ENTRY_BYTES = 280;

export const FORGOTTEN = "(forgotten at the user's request)";

type Row = Record<string, SqlStorageValue>;

const SCHEMA = `
CREATE TABLE IF NOT EXISTS optmem_log (
	id INTEGER PRIMARY KEY,
	key TEXT UNIQUE,
	date TEXT NOT NULL,
	text TEXT NOT NULL,
	forgotten INTEGER NOT NULL DEFAULT 0,
	source TEXT
);
CREATE TABLE IF NOT EXISTS optmem_tree (
	size INTEGER NOT NULL,
	lo INTEGER NOT NULL,
	text TEXT NOT NULL,
	PRIMARY KEY (size, lo)
);
CREATE TABLE IF NOT EXISTS optmem_meta (
	key TEXT PRIMARY KEY,
	value TEXT NOT NULL
);
`;

function entryOf(row: Row): MemoryEntry {
	return {
		id: Number(row.id),
		date: String(row.date),
		text: String(row.text),
		forgotten: Number(row.forgotten) === 1,
		source: row.source === null ? null : String(row.source),
	};
}

/** `#id date text`: how a raw memory is shown to the model. */
export function entryLine(entry: MemoryEntry): string {
	return `#${entry.id} ${entry.date} ${entry.forgotten ? FORGOTTEN : entry.text}`;
}

export function byteLength(text: string): number {
	return new TextEncoder().encode(text).length;
}

/**
 * The log is canonical and append-only: a memory keeps its id forever, and
 * forgetting blanks its text rather than removing it, so ids never shift.
 * The tree is a cache of summaries, rebuildable from the log.
 */
export class OptMemStore {
	readonly #sql: SqlStorage;

	constructor(sql: SqlStorage) {
		this.#sql = sql;
		this.#sql.exec(SCHEMA);
	}

	count(): number {
		return Number(this.#sql.exec("SELECT COUNT(*) AS n FROM optmem_log").one().n);
	}

	/**
	 * Appends one memory and returns it. Idempotent on `key`: the same key
	 * again returns the memory it already saved.
	 */
	append(text: string, date: string, options: { key?: string; source?: string | null } = {}): MemoryEntry {
		const key = options.key ?? crypto.randomUUID();
		const [known] = this.#sql.exec("SELECT * FROM optmem_log WHERE key = ?", key).toArray();
		if (known) return entryOf(known);
		const id = this.count();
		this.#sql.exec(
			"INSERT INTO optmem_log (id, key, date, text, source) VALUES (?, ?, ?, ?, ?)",
			id,
			key,
			date,
			text,
			options.source ?? null,
		);
		return this.entry(id)!;
	}

	/** Memories from `from` on that are not forgotten and were not noted by conversation `except`, oldest first. */
	since(from: number, except: string): MemoryEntry[] {
		return this.#sql
			.exec(
				"SELECT * FROM optmem_log WHERE id >= ? AND forgotten = 0 AND (source IS NULL OR source != ?) ORDER BY id",
				from,
				except,
			)
			.toArray()
			.map(entryOf);
	}

	entry(id: number): MemoryEntry | undefined {
		const [row] = this.#sql.exec("SELECT * FROM optmem_log WHERE id = ?", id).toArray();
		return row ? entryOf(row) : undefined;
	}

	/** Memories [lo, hi), oldest first. */
	entries(lo: number, hi: number): MemoryEntry[] {
		return this.#sql
			.exec("SELECT * FROM optmem_log WHERE id >= ? AND id < ? ORDER BY id", lo, hi)
			.toArray()
			.map(entryOf);
	}

	/** Newest first, optionally before an id, for paging. */
	page(limit: number, before?: number): MemoryEntry[] {
		return this.#sql
			.exec("SELECT * FROM optmem_log WHERE id < ? ORDER BY id DESC LIMIT ?", before ?? Number.MAX_SAFE_INTEGER, limit)
			.toArray()
			.map(entryOf);
	}

	/** Newest matches of `pattern` among memories not forgotten, and how many matched in all. */
	search(pattern: RegExp, limit: number): { matches: MemoryEntry[]; total: number } {
		const matches: MemoryEntry[] = [];
		let total = 0;
		// Streamed newest first: the whole log is never held in memory.
		for (const row of this.#sql.exec("SELECT * FROM optmem_log WHERE forgotten = 0 ORDER BY id DESC")) {
			const entry = entryOf(row);
			if (!pattern.test(`${entry.date} ${entry.text}`)) continue;
			total++;
			if (matches.length < limit) matches.push(entry);
		}
		return { matches, total };
	}

	summary([lo, hi]: Block): string | undefined {
		const [row] = this.#sql.exec("SELECT text FROM optmem_tree WHERE size = ? AND lo = ?", hi - lo, lo).toArray();
		return row ? String(row.text) : undefined;
	}

	summaries(): MemorySummary[] {
		return this.#sql
			.exec("SELECT * FROM optmem_tree ORDER BY size, lo")
			.toArray()
			.map((row) => ({ lo: Number(row.lo), hi: Number(row.lo) + Number(row.size), text: String(row.text) }));
	}

	/** Blocks that can be built and are not, smallest first. */
	pending(limit = Number.POSITIVE_INFINITY): Block[] {
		const total = this.count();
		const built = new Set(
			this.#sql
				.exec("SELECT size, lo FROM optmem_tree")
				.toArray()
				.map((row) => `${row.size}:${row.lo}`),
		);
		const out: Block[] = [];
		for (const block of buildableBlocks(total)) {
			if (built.has(`${block[1] - block[0]}:${block[0]}`)) continue;
			out.push(block);
			if (out.length >= limit) break;
		}
		return out;
	}

	/**
	 * What compressing `block` needs, or undefined when it cannot be done now:
	 * already built, or a half it is built from is still missing.
	 */
	napInput(block: Block, rawMax: number): NapInput | undefined {
		const [lo, hi] = block;
		if (this.summary(block) !== undefined || hi > this.count()) return undefined;
		const epoch = this.epoch();
		if (hi - lo <= rawMax) return { block, lines: this.entries(lo, hi).map(entryLine), epoch };
		const lines: string[] = [];
		const mid = (lo + hi) / 2;
		for (const half of [
			[lo, mid],
			[mid, hi],
		] as const) {
			const text = this.summary(half);
			if (text === undefined) return undefined;
			lines.push(`#${half[0]}-${half[1] - 1} ${text}`);
		}
		return { block, lines, epoch };
	}

	/**
	 * Stores a summary, unless one is there already or a memory was forgotten
	 * since its lines were read: such a summary may still hold what was forgotten.
	 */
	putSummary(block: Block, text: string, epoch: number): boolean {
		if (epoch !== this.epoch()) return false;
		return (
			this.#sql.exec(
				"INSERT OR IGNORE INTO optmem_tree (size, lo, text) VALUES (?, ?, ?)",
				block[1] - block[0],
				block[0],
				text,
			).rowsWritten > 0
		);
	}

	/**
	 * Blanks one memory and drops every summary built over it; naps rebuild
	 * them without it. False when there is no such memory.
	 */
	forget(id: number): boolean {
		if (!this.entry(id)) return false;
		this.#sql.exec("UPDATE optmem_log SET text = '', forgotten = 1 WHERE id = ?", id);
		this.#sql.exec("DELETE FROM optmem_tree WHERE lo <= ? AND ? < lo + size", id, id);
		this.#sql.exec(
			"INSERT INTO optmem_meta (key, value) VALUES ('epoch', '1') ON CONFLICT (key) DO UPDATE SET value = CAST(value AS INTEGER) + 1",
		);
		return true;
	}

	/** Drops one summary and every summary built on it; the log is untouched. */
	dropSummary([lo, hi]: Block): number {
		return this.#sql.exec("DELETE FROM optmem_tree WHERE size >= ? AND lo <= ? AND ? < lo + size", hi - lo, lo, lo)
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
}
