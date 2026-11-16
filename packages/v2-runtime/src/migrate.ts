import { readdir, readFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type pg from "pg";
import { SCHEMA } from "./db.ts";

const MIGRATIONS_DIR = join(dirname(fileURLToPath(import.meta.url)), "..", "migrations");
// One advisory-lock key for every migrator, so concurrent Runners starting together apply each migration once.
const LOCK_KEY = 7_100_100;

export type MigrationResult = { applied: string[]; current: string | undefined };

/**
 * Apply the pending migrations, each in its own transaction, under an advisory lock. A migration file that changed
 * after it was applied is an error: the schema would no longer be what the code expects.
 */
export async function migrate(pool: pg.Pool, directory: string = MIGRATIONS_DIR): Promise<MigrationResult> {
	const files = (await readdir(directory)).filter((name) => /^\d{4}_.+\.sql$/.test(name)).sort();
	const client = await pool.connect();
	const applied: string[] = [];
	try {
		await client.query("SELECT pg_advisory_lock($1)", [LOCK_KEY]);
		await client.query(`CREATE SCHEMA IF NOT EXISTS ${SCHEMA}`);
		await client.query(
			`CREATE TABLE IF NOT EXISTS ${SCHEMA}.schema_migrations (name text PRIMARY KEY, checksum text NOT NULL, applied_at timestamptz NOT NULL DEFAULT now())`,
		);
		const done = new Map<string, string>(
			(await client.query<{ name: string; checksum: string }>(`SELECT name, checksum FROM ${SCHEMA}.schema_migrations`)).rows.map((row) => [row.name, row.checksum]),
		);
		for (const file of files) {
			const sql = await readFile(join(directory, file), "utf8");
			const checksum = createHash("sha256").update(sql).digest("hex");
			const existing = done.get(file);
			if (existing !== undefined) {
				if (existing !== checksum) throw new Error(`Migration ${file} changed after it was applied`);
				continue;
			}
			try {
				await client.query("BEGIN");
				await client.query(sql);
				await client.query(`INSERT INTO ${SCHEMA}.schema_migrations (name, checksum) VALUES ($1, $2)`, [file, checksum]);
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
