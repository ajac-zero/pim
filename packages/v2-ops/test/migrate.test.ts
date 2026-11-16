import pg from "pg";
import { describe, expect, it } from "vitest";
import { MigrationChecksumError, loadMigrations, migrate } from "../src/pg/migrate.ts";
import { usePostgres } from "./support/pg.ts";

const db = usePostgres();

describe("the versioned SQL runner", () => {
	it("applies every file once, in order, and does nothing the second time", async () => {
		const pool = await db.freshDatabase({ migrated: false });
		const migrations = await loadMigrations();
		expect(migrations.map((m) => m.version)).toEqual(["0500", "0501", "0502", "0503"]);
		expect(await migrate(pool, migrations)).toEqual(["0500", "0501", "0502", "0503"]);
		expect(await migrate(pool, migrations)).toEqual([]);
		await pool.end();
	});

	it("refuses an applied migration that was edited, and rolls back a failing one", async () => {
		const pool = await db.freshDatabase({ migrated: false });
		const [first] = await loadMigrations();
		await migrate(pool, [first!]);
		await expect(migrate(pool, [{ ...first!, sql: `${first!.sql}\n-- edited` , checksum: "x" }])).rejects.toBeInstanceOf(MigrationChecksumError);
		await expect(migrate(pool, [first!, { version: "0900", name: "bad", sql: "CREATE TABLE pim.half (a int); SELECT nope();", checksum: "y" }])).rejects.toThrow();
		const { rows } = await pool.query("SELECT to_regclass('pim.half') AS t");
		expect(rows[0].t).toBeNull();
		await pool.end();
	});
});

describe("role grants", () => {
	it("gives the scoped roles exactly their access: the read-only role cannot read secrets or write, the runtime role cannot touch the ledger", async () => {
		const admin = new pg.Pool({ connectionString: db.server.url(), max: 1 });
		for (const role of ["pim_app_role", "pim_runtime_role", "pim_readonly_role"]) await admin.query(`DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = '${role}') THEN CREATE ROLE ${role} LOGIN PASSWORD 'x' NOSUPERUSER NOBYPASSRLS; END IF; END $$`);
		await admin.end();
		const pool = await db.freshDatabase();
		await pool.query("INSERT INTO pim.tenants (tenant_id, username, role, status, created_at_ms) VALUES ('t1', 't1', 'member', 'active', 0)");
		await pool.query("INSERT INTO pim.secret_envelopes (tenant_id, name, purpose, envelope, legacy_format) VALUES ('t1', 's', 'p', '{}', 'plain')");
		const as = async (role: string, sql: string) => {
			const client = await pool.connect();
			try {
				await client.query(`SET ROLE ${role}`);
				return await client.query(sql);
			} finally {
				await client.query("RESET ROLE").catch(() => undefined);
				client.release();
			}
		};
		expect((await as("pim_readonly_role", "SELECT count(*) n FROM pim.tenants")).rows[0].n).toBe("1");
		await expect(as("pim_readonly_role", "SELECT * FROM pim.secret_envelopes")).rejects.toThrow(/permission denied/);
		await expect(as("pim_readonly_role", "DELETE FROM pim.tenants")).rejects.toThrow(/permission denied/);
		await expect(as("pim_runtime_role", "SELECT * FROM pim.ops_migrations")).rejects.toThrow(/permission denied/);
		await expect(as("pim_runtime_role", "CREATE TABLE pim.x (a int)")).rejects.toThrow(/permission denied/);
		expect((await as("pim_runtime_role", "UPDATE pim.tenants SET status = 'active' RETURNING 1")).rowCount).toBe(1);
		await pool.end();
	});
});
