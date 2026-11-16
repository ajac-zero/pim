import { createHash } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import { migrationOwner, parseMigrationFile, validateMigrationFiles } from "@pim/v2-contracts/db";
import type { Pool } from "pg";

const DIR = new URL("../migrations/", import.meta.url);

/**
 * Applies this workstream's migrations (band 0300-0399) once each, in order, recording them in the shared
 * ledger `public.pim_schema_migrations` with their checksum. The foundation migration must be applied first
 * (it creates the schema, the roles and `pim_current_owner_id()`); an applied file that has since changed fails.
 */
export async function migrate(pool: Pool): Promise<string[]> {
	const files = readdirSync(DIR).filter((name) => name.endsWith(".sql")).sort();
	const problems = validateMigrationFiles("live", files);
	if (problems.length > 0) throw new Error(`Bad migration files: ${problems.join("; ")}`);
	const client = await pool.connect();
	const applied: string[] = [];
	try {
		await client.query("SELECT pg_advisory_lock(hashtext('pim.migrate.live'))");
		const ledger = await client.query<{ number: number; checksum: string }>("SELECT number, checksum FROM public.pim_schema_migrations");
		const done = new Map(ledger.rows.map((row) => [row.number, row.checksum]));
		if (!done.has(1)) throw new Error("0001_foundation has not been applied");
		for (const file of files) {
			const { number, name } = parseMigrationFile(file)!;
			if (migrationOwner(number) !== "live") continue;
			const sql = readFileSync(new URL(file, DIR), "utf8");
			const checksum = createHash("sha256").update(sql).digest("hex");
			const before = done.get(number);
			if (before !== undefined) {
				if (before !== checksum) throw new Error(`${file} changed after it was applied`);
				continue;
			}
			await client.query("BEGIN");
			try {
				await client.query(sql);
				await client.query("INSERT INTO public.pim_schema_migrations (number, name, checksum) VALUES ($1, $2, $3)", [number, name, checksum]);
				await client.query("COMMIT");
			} catch (error) {
				await client.query("ROLLBACK");
				throw error;
			}
			applied.push(file);
		}
	} finally {
		await client.query("SELECT pg_advisory_unlock(hashtext('pim.migrate.live'))").catch(() => {});
		client.release();
	}
	return applied;
}
