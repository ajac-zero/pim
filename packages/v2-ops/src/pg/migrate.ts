import { createHash } from "node:crypto";
import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import type { Pool, PoolClient } from "pg";

/** The directory of versioned SQL files this package ships (migrations 0500-0599). */
export const SQL_DIR = new URL("../../sql/", import.meta.url).pathname;

export type Migration = { readonly version: string; readonly name: string; readonly sql: string; readonly checksum: string };

export const sha256Hex = (data: string | Uint8Array) => createHash("sha256").update(data).digest("hex");

/** Reads `NNNN_name.sql` files in version order. */
export async function loadMigrations(dir = SQL_DIR): Promise<Migration[]> {
	const files = (await readdir(dir)).filter((file) => /^\d{4}_[a-z0-9_]+\.sql$/.test(file)).sort();
	const migrations: Migration[] = [];
	for (const file of files) {
		const sql = await readFile(join(dir, file), "utf8");
		migrations.push({ version: file.slice(0, 4), name: file.slice(5, -4), sql, checksum: sha256Hex(sql) });
	}
	return migrations;
}

/** An applied migration whose file has changed since: a database must never be migrated from edited history. */
export class MigrationChecksumError extends Error {}

const LOCK_KEY = 0x70696d6f; // "pimo"

/**
 * The one-shot versioned SQL runner the `migrator` role runs. Takes a session advisory lock so two migrators never
 * interleave, runs each pending file in its own transaction, records its checksum, and refuses a changed applied file.
 * Returns the versions applied by this call.
 */
export async function migrate(pool: Pool, migrations: readonly Migration[]): Promise<string[]> {
	const client = await pool.connect();
	const applied: string[] = [];
	try {
		await client.query("SELECT pg_advisory_lock($1)", [LOCK_KEY]);
		await client.query("CREATE SCHEMA IF NOT EXISTS pim");
		await client.query(
			"CREATE TABLE IF NOT EXISTS pim.ops_migrations (version text PRIMARY KEY, name text NOT NULL, checksum text NOT NULL, applied_at timestamptz NOT NULL DEFAULT now())",
		);
		const done = new Map((await client.query<{ version: string; checksum: string }>("SELECT version, checksum FROM pim.ops_migrations")).rows.map((row) => [row.version, row.checksum]));
		for (const migration of migrations) {
			const checksum = done.get(migration.version);
			if (checksum !== undefined) {
				if (checksum !== migration.checksum) throw new MigrationChecksumError(`Migration ${migration.version}_${migration.name} was edited after it was applied`);
				continue;
			}
			await inTransaction(client, async () => {
				await client.query(migration.sql);
				await client.query("INSERT INTO pim.ops_migrations (version, name, checksum) VALUES ($1, $2, $3)", [migration.version, migration.name, migration.checksum]);
			});
			applied.push(migration.version);
		}
	} finally {
		await client.query("SELECT pg_advisory_unlock($1)", [LOCK_KEY]).catch(() => undefined);
		client.release();
	}
	return applied;
}

export async function inTransaction<T>(client: PoolClient, work: () => Promise<T>): Promise<T> {
	await client.query("BEGIN");
	try {
		const result = await work();
		await client.query("COMMIT");
		return result;
	} catch (error) {
		await client.query("ROLLBACK").catch(() => undefined);
		throw error;
	}
}
