import { createHash } from "node:crypto";
import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import { type MigrationOwner, parseMigrationFile, validateMigrationFiles } from "@pim/v2-contracts/db";
import type { Pool, PoolClient } from "pg";

/** The migrations this package ships: the operations band, 0500-0599. */
export const SQL_DIR = new URL("../../sql/", import.meta.url).pathname;
/** The foundation migration, canonical's: schemas, roles, the ledger and pim_current_owner_id(). It runs before everything else. */
export const FOUNDATION_DIR = new URL("../../../v2-contracts/migrations/", import.meta.url).pathname;

export type Migration = { readonly number: number; readonly name: string; readonly sql: string; readonly checksum: string };

export const sha256Hex = (data: string | Uint8Array) => createHash("sha256").update(data).digest("hex");

/** Reads `NNNN_name.sql` files in number order, refusing any outside the owner's band (src/db.ts of @pim/v2-contracts). */
export async function loadMigrations(dir = SQL_DIR, owner: MigrationOwner = "operations"): Promise<Migration[]> {
	const names = (await readdir(dir)).filter((file) => file.endsWith(".sql")).sort();
	const problems = validateMigrationFiles(owner, names);
	if (problems.length > 0) throw new Error(`Bad migrations in ${dir}: ${problems.join("; ")}`);
	const migrations: Migration[] = [];
	for (const file of names) {
		const parsed = parseMigrationFile(file)!;
		const sql = await readFile(join(dir, file), "utf8");
		migrations.push({ number: parsed.number, name: parsed.name, sql, checksum: sha256Hex(sql) });
	}
	return migrations;
}

/** Foundation first, then the operations band: what a database needs from this package. Other workstreams' directories are added by the caller. */
export async function loadAllMigrations(extra: readonly { dir: string; owner: MigrationOwner }[] = []): Promise<Migration[]> {
	const all = [...(await loadMigrations(FOUNDATION_DIR, "foundation")), ...(await Promise.all(extra.map((e) => loadMigrations(e.dir, e.owner)))).flat(), ...(await loadMigrations())];
	const seen = new Set<number>();
	for (const m of all) {
		if (seen.has(m.number)) throw new Error(`Two migrations share number ${m.number}: workstreams own separate bands`);
		seen.add(m.number);
	}
	return all.sort((a, b) => a.number - b.number);
}

/** An applied migration whose file has changed since: a database must never be migrated from edited history. */
export class MigrationChecksumError extends Error {}

const LOCK_KEY = 0x70696d6f; // "pimo"

/**
 * The one-shot versioned SQL runner the migrator runs. It records in canonical's ledger, `public.pim_schema_migrations` (created by 0001), under a session
 * advisory lock so two migrators never interleave; runs each pending file in its own transaction; and refuses a file edited after it was applied.
 * Returns the numbers applied by this call.
 */
export async function migrate(pool: Pool, migrations: readonly Migration[]): Promise<number[]> {
	const client = await pool.connect();
	const applied: number[] = [];
	try {
		await client.query("SELECT pg_advisory_lock($1)", [LOCK_KEY]);
		const exists = (await client.query("SELECT to_regclass('public.pim_schema_migrations') AS t")).rows[0].t !== null;
		const done = new Map<number, string>();
		if (exists) for (const row of (await client.query<{ number: number; checksum: string }>("SELECT number, checksum FROM public.pim_schema_migrations")).rows) done.set(row.number, row.checksum);
		for (const migration of [...migrations].sort((a, b) => a.number - b.number)) {
			const checksum = done.get(migration.number);
			if (checksum !== undefined) {
				if (checksum !== migration.checksum) throw new MigrationChecksumError(`Migration ${migration.number}_${migration.name} was edited after it was applied`);
				continue;
			}
			await inTransaction(client, async () => {
				await client.query(migration.sql);
				await client.query("INSERT INTO public.pim_schema_migrations (number, name, checksum) VALUES ($1, $2, $3)", [migration.number, migration.name, migration.checksum]);
			});
			applied.push(migration.number);
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
