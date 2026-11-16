import { createHash } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { parseMigrationFile, validateMigrationFiles } from "@pim/v2-contracts/db";
import pg from "pg";

const own = join(import.meta.dirname, "..", "migrations");
const foundation = join(import.meta.dirname, "..", "..", "v2-contracts", "migrations");

/**
 * Applies the foundation (canonical's 0001) and then this package's band (0200 to 0299), once each, in number order, under an advisory lock,
 * recording them in `public.pim_schema_migrations`. Run it as the schema owner, never as the application login.
 */
export async function migrate(connectionString: string, dirs: { foundation: string; application: string } = { foundation, application: own }): Promise<number[]> {
	const problems = validateMigrationFiles("application", readdirSync(dirs.application).filter((f) => f.endsWith(".sql")));
	if (problems.length) throw new Error(`Bad migration files: ${problems.join("; ")}`);
	const files = [dirs.foundation, dirs.application]
		.flatMap((dir) => readdirSync(dir).filter((f) => f.endsWith(".sql")).map((file) => ({ dir, file, ...parseMigrationFile(file)! })))
		.sort((a, b) => a.number - b.number);
	const client = new pg.Client({ connectionString });
	await client.connect();
	const applied: number[] = [];
	try {
		await client.query("SELECT pg_advisory_lock(hashtext('pim.migrate'))");
		await client.query("CREATE TABLE IF NOT EXISTS public.pim_schema_migrations (number integer PRIMARY KEY, name text NOT NULL, checksum text NOT NULL, applied_at timestamptz NOT NULL DEFAULT now())");
		for (const { dir, file, number, name } of files) {
			const sql = readFileSync(join(dir, file), "utf8");
			const checksum = createHash("sha256").update(sql).digest("hex");
			const done = await client.query("SELECT checksum FROM public.pim_schema_migrations WHERE number = $1", [number]);
			if (done.rows[0]) {
				if (done.rows[0].checksum !== checksum) throw new Error(`Migration ${file} changed after it was applied`);
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
			applied.push(number);
		}
	} finally {
		await client.query("SELECT pg_advisory_unlock(hashtext('pim.migrate'))").catch(() => undefined);
		await client.end();
	}
	return applied;
}
