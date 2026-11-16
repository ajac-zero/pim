// PostgreSQL access: the smallest surface Forge needs, so a pg Pool in production and a single client in tests both fit.
import { createHash } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import { parseMigrationFile, validateMigrationFiles } from "@pim/v2-contracts/db";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";

export type Row = Record<string, any>;

/** What a connection offers: a parameterized query. */
export interface Queryable {
	query<R extends Row = Row>(text: string, values?: readonly unknown[]): Promise<{ rows: R[]; rowCount: number | null }>;
}

/** A pool that can also hand out one connection for a transaction. */
export interface Db extends Queryable {
	connect(): Promise<Queryable & { release(): void }>;
}

export const createDb = (connectionString: string): pg.Pool => new pg.Pool({ connectionString, max: 20 });

/** Runs `fn` in one transaction; commits when it returns, rolls back when it throws. */
export async function tx<T>(db: Db, fn: (q: Queryable) => Promise<T>): Promise<T> {
	const client = await db.connect();
	try {
		await client.query("begin");
		const out = await fn(client);
		await client.query("commit");
		return out;
	} catch (error) {
		await client.query("rollback").catch(() => {});
		throw error;
	} finally {
		client.release();
	}
}

const MIGRATIONS = join(dirname(fileURLToPath(import.meta.url)), "..", "migrations");
const FOUNDATION = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "v2-contracts", "migrations");

/** Applies one directory's migrations once each, recording them in the shared `public.pim_schema_migrations` ledger. */
async function applyDir(client: Queryable, dir: string, only: (number: number) => boolean, applied: string[]) {
	const done = new Set((await client.query<{ number: number }>("select number from public.pim_schema_migrations")).rows.map((r) => r.number));
	for (const file of readdirSync(dir).sort()) {
		const parsed = parseMigrationFile(file);
		if (!parsed || !only(parsed.number) || done.has(parsed.number)) continue;
		const sql = readFileSync(join(dir, file), "utf8");
		await client.query("begin");
		try {
			await client.query(sql);
			await client.query("insert into public.pim_schema_migrations (number, name, checksum) values ($1,$2,$3)", [parsed.number, parsed.name, createHash("sha256").update(sql).digest("hex")]);
			await client.query("commit");
		} catch (error) {
			await client.query("rollback");
			throw error;
		}
		applied.push(file);
	}
}

/**
 * Applies Forge's migrations (band 0400–0499) once each, in order, under one advisory lock so concurrent workers don't race.
 * The foundation migration is canonical's and is applied first only when the ledger lacks it, so a bare database works too.
 */
export async function migrate(db: Db): Promise<string[]> {
	const problems = validateMigrationFiles("forge", readdirSync(MIGRATIONS));
	if (problems.length) throw new Error(`Forge migrations are malformed: ${problems.join("; ")}`);
	const client = await db.connect();
	const applied: string[] = [];
	try {
		await client.query("select pg_advisory_lock(hashtext('pim_forge.migrate'))");
		await client.query("create table if not exists public.pim_schema_migrations (number integer primary key, name text not null, checksum text not null, applied_at timestamptz not null default now())");
		await applyDir(client, FOUNDATION, (n) => n === 1, applied);
		await applyDir(client, MIGRATIONS, (n) => n >= 400 && n <= 499, applied);
	} finally {
		await client.query("select pg_advisory_unlock(hashtext('pim_forge.migrate'))").catch(() => {});
		client.release();
	}
	return applied;
}
