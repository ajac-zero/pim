/**
 * The read-only dump a maintenance/export runtime offers for one Durable Object's SQLite database. It reads
 * `sqlite_master` and pages every table by rowid, so it needs no knowledge of the old product's code and cannot write.
 * The Cloudflare shell (export-worker/) and the tests use this same function.
 */
export interface SqlLike {
	exec(query: string, ...bindings: unknown[]): { toArray(): Record<string, unknown>[] };
}

const IDENT = /^[A-Za-z_][A-Za-z0-9_]*$/;
/** Tables an export never copies: the agents framework's scheduler rows are old-runtime state, and the erasure marker must not travel. */
export const SKIPPED_TABLES = new Set(["cf_agents_jobs", "cf_agents_schedules", "cf_agents_state", "cf_agents_queues", "cf_agents_workflows", "pim_erased", "sqlite_sequence", "_cf_KV"]);

export function listTables(sql: SqlLike): { name: string; rows: number }[] {
	const names = sql.exec("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name").toArray().map((r) => String(r.name));
	return names.map((name) => ({ name, rows: SKIPPED_TABLES.has(name) || !IDENT.test(name) ? -1 : Number(sql.exec(`SELECT count(*) AS n FROM "${name}"`).toArray()[0]!.n) }));
}

/** One page of rows, by rowid, with the rowid cursor to continue from. A row's values come back as JSON-safe values (blobs as base64). */
export function readRows(sql: SqlLike, table: string, after: number, limit: number): { rows: Record<string, unknown>[]; next: number | null } {
	if (!IDENT.test(table) || SKIPPED_TABLES.has(table)) throw new Error("Table not exportable");
	const known = sql.exec("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?", table).toArray();
	if (known.length === 0) throw new Error("Unknown table");
	const page = sql.exec(`SELECT rowid AS __rowid, * FROM "${table}" WHERE rowid > ? ORDER BY rowid LIMIT ?`, after, Math.min(limit, 5000)).toArray();
	const rows = page.map(({ __rowid, ...row }) => Object.fromEntries(Object.entries(row).map(([k, v]) => [k, v instanceof ArrayBuffer ? { $base64: Buffer.from(v).toString("base64") } : v])));
	const last = page.at(-1);
	return { rows, next: page.length === Math.min(limit, 5000) && last ? Number(last.__rowid) : null };
}
