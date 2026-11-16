import { createHash } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import pg from "pg";

const dir = join(import.meta.dirname, "..", "migrations");

/** Applies the pending migrations in order, once each, under an advisory lock. Run it as the schema owner, never as the app role. */
export async function migrate(connectionString: string): Promise<string[]> {
	const client = new pg.Client({ connectionString });
	await client.connect();
	const applied: string[] = [];
	try {
		await client.query("SELECT pg_advisory_lock(hashtext('pim_app.migrate'))");
		await client.query("CREATE SCHEMA IF NOT EXISTS pim_migrations");
		await client.query("CREATE TABLE IF NOT EXISTS pim_migrations.applied (name text PRIMARY KEY, checksum text NOT NULL, at timestamptz NOT NULL DEFAULT now())");
		for (const file of readdirSync(dir).filter((f) => f.endsWith(".sql")).sort()) {
			const sql = readFileSync(join(dir, file), "utf8");
			const checksum = createHash("sha256").update(sql).digest("hex");
			const done = await client.query("SELECT checksum FROM pim_migrations.applied WHERE name = $1", [file]);
			if (done.rows[0]) {
				if (done.rows[0].checksum !== checksum) throw new Error(`Migration ${file} changed after it was applied`);
				continue;
			}
			await client.query("BEGIN");
			try {
				await client.query(sql);
				await client.query("INSERT INTO pim_migrations.applied (name, checksum) VALUES ($1, $2)", [file, checksum]);
				await client.query("COMMIT");
			} catch (error) {
				await client.query("ROLLBACK");
				throw error;
			}
			applied.push(file);
		}
	} finally {
		await client.query("SELECT pg_advisory_unlock(hashtext('pim_app.migrate'))").catch(() => undefined);
		await client.end();
	}
	return applied;
}
