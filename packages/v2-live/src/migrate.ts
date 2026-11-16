import { readdirSync, readFileSync } from "node:fs";
import type { Pool } from "pg";

const DIR = new URL("../migrations/", import.meta.url);

/** Applies this package's migrations (0300-0399) once each, in order, recording them in pim_projection.schema_migrations. */
export async function migrate(pool: Pool): Promise<string[]> {
	const client = await pool.connect();
	const applied: string[] = [];
	try {
		await client.query("SELECT pg_advisory_lock(hashtext('pim_projection.migrate'))");
		await client.query("CREATE SCHEMA IF NOT EXISTS pim_projection");
		await client.query("CREATE TABLE IF NOT EXISTS pim_projection.schema_migrations (name text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())");
		const done = new Set((await client.query<{ name: string }>("SELECT name FROM pim_projection.schema_migrations")).rows.map((row) => row.name));
		for (const file of readdirSync(DIR).filter((name) => /^03\d\d_.*\.sql$/.test(name)).sort()) {
			if (done.has(file)) continue;
			await client.query("BEGIN");
			try {
				await client.query(readFileSync(new URL(file, DIR), "utf8"));
				await client.query("INSERT INTO pim_projection.schema_migrations (name) VALUES ($1)", [file]);
				await client.query("COMMIT");
			} catch (error) {
				await client.query("ROLLBACK");
				throw error;
			}
			applied.push(file);
		}
	} finally {
		await client.query("SELECT pg_advisory_unlock(hashtext('pim_projection.migrate'))").catch(() => {});
		client.release();
	}
	return applied;
}
