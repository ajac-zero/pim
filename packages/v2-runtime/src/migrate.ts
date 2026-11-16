import { createHash } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { type MigrationOwner, parseMigrationFile, validateMigrationFiles } from "@pim/v2-contracts/db";
import type pg from "pg";

const MIGRATIONS_DIR = join(dirname(fileURLToPath(import.meta.url)), "..", "migrations");
// One advisory-lock key for every migrator, so Runners starting together apply each migration once.
const LOCK_KEY = 7_100_100;

export type MigrationResult = { applied: string[]; current: string | undefined };

/**
 * Apply a workstream's pending migrations, each in its own transaction, under an advisory lock, recording them in the
 * canonical ledger `public.pim_schema_migrations`. File names are checked against the workstream's band
 * (`validateMigrationFiles`); a file that changed after it was applied is an error. Every band but the foundation needs
 * `0001_foundation.sql` applied first, which creates the schemas, the roles, the ledger and `pim_current_owner_id()`.
 */
export async function applyMigrations(pool: pg.Pool, directory: string, owner: MigrationOwner): Promise<MigrationResult> {
	const files = (await readdir(directory)).filter((name) => name.endsWith(".sql")).sort();
	const problems = validateMigrationFiles(owner, files);
	if (problems.length > 0) throw new Error(`Migrations of ${owner} are invalid: ${problems.join("; ")}`);
	const client = await pool.connect();
	const applied: string[] = [];
	try {
		await client.query("SELECT pg_advisory_lock($1)", [LOCK_KEY]);
		const ledgerExists = (await client.query("SELECT to_regclass('public.pim_schema_migrations') AS t")).rows[0]?.t !== null;
		const done = new Map<number, string>();
		if (ledgerExists) {
			for (const row of (await client.query<{ number: number; checksum: string }>("SELECT number, checksum FROM public.pim_schema_migrations")).rows) done.set(row.number, row.checksum);
		}
		if (owner !== "foundation" && !done.has(1)) throw new Error("0001_foundation.sql has not been applied; apply the foundation migration first");
		for (const file of files) {
			const parsed = parseMigrationFile(file);
			if (parsed === null) continue;
			const sql = await readFile(join(directory, file), "utf8");
			const checksum = createHash("sha256").update(sql).digest("hex");
			const existing = done.get(parsed.number);
			if (existing !== undefined) {
				if (existing !== checksum) throw new Error(`Migration ${file} changed after it was applied`);
				continue;
			}
			try {
				await client.query("BEGIN");
				await client.query(sql);
				await client.query("INSERT INTO public.pim_schema_migrations (number, name, checksum) VALUES ($1, $2, $3)", [parsed.number, parsed.name, checksum]);
				await client.query("COMMIT");
			} catch (error) {
				await client.query("ROLLBACK").catch(() => {});
				throw new Error(`Migration ${file} failed`, { cause: error });
			}
			applied.push(file);
		}
		return { applied, current: files.at(-1) };
	} finally {
		await client.query("SELECT pg_advisory_unlock($1)", [LOCK_KEY]).catch(() => {});
		client.release();
	}
}

/** Apply the runtime's migrations, 0100-0199. */
export function migrate(pool: pg.Pool, directory: string = MIGRATIONS_DIR): Promise<MigrationResult> {
	return applyMigrations(pool, directory, "runtime");
}
