import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import pg from "pg";
import { describe, expect, it } from "vitest";
import { MigrationChecksumError, loadAllMigrations, loadMigrations, migrate } from "../src/pg/migrate.ts";
import { usePostgres } from "./support/pg.ts";

const db = usePostgres();

describe("the versioned SQL runner", () => {
	it("applies the foundation and the operations band once each, in order, into canonical's ledger", async () => {
		const pool = await db.freshDatabase({ migrated: false });
		const migrations = await loadAllMigrations();
		expect(migrations.map((m) => m.number)).toEqual([1, 500, 501, 502, 503]);
		expect(await migrate(pool, migrations)).toEqual([1, 500, 501, 502, 503]);
		expect(await migrate(pool, migrations)).toEqual([]);
		expect((await pool.query("SELECT number FROM public.pim_schema_migrations ORDER BY number")).rows.map((r) => r.number)).toEqual([1, 500, 501, 502, 503]);
		for (const schema of ["pim_app", "pim_runtime", "pim_forge", "pim_projection", "pim_ops"]) expect((await pool.query("SELECT 1 FROM pg_namespace WHERE nspname = $1", [schema])).rowCount, schema).toBe(1);
		expect((await pool.query("SELECT rolname FROM pg_roles WHERE rolname LIKE 'pim\\_%' ORDER BY 1")).rows.map((r) => r.rolname)).toEqual(expect.arrayContaining(["pim_gate", "pim_live", "pim_maintenance", "pim_forge", "pim_runtime"]));
		await pool.end();
	});

	it("refuses an applied migration that was edited, a file outside the operations band, and rolls back a failing one", async () => {
		const pool = await db.freshDatabase({ migrated: false });
		const all = await loadAllMigrations();
		await migrate(pool, all.slice(0, 2));
		await expect(migrate(pool, [all[0]!, { ...all[1]!, sql: `${all[1]!.sql}\n-- edited`, checksum: "x" }])).rejects.toBeInstanceOf(MigrationChecksumError);
		await expect(migrate(pool, [...all.slice(0, 2), { number: 900, name: "bad", sql: "CREATE TABLE pim_ops.half (a int); SELECT nope();", checksum: "y" }])).rejects.toThrow();
		expect((await pool.query("SELECT to_regclass('pim_ops.half') AS t")).rows[0].t).toBeNull();
		const dir = await mkdtemp(join(tmpdir(), "pim-band-"));
		await writeFile(join(dir, "0150_x.sql"), "SELECT 1");
		await expect(loadMigrations(dir)).rejects.toThrow(/outside operations's band 500-599/);
		await expect(loadMigrations(dir, "runtime")).resolves.toHaveLength(1);
		await pool.end();
	});
});

describe("role grants", () => {
	it("gives each process role exactly its access, as 0001 defines the roles", async () => {
		const pool = await db.freshDatabase();
		await pool.query("INSERT INTO pim_ops.tenants (owner_id, username, role, status, created_at_ms) VALUES ('o_t1', 't1', 'member', 'active', 0)");
		await pool.query("INSERT INTO pim_ops.secret_envelopes (owner_id, name, purpose, envelope, legacy_format) VALUES ('o_t1', 's', 'p', '{}', 'plain')");
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
		expect((await as("pim_gate", "SELECT count(*) n FROM pim_ops.tenants")).rows[0].n).toBe("1");
		expect((await as("pim_gate", "SELECT count(*) n FROM pim_ops.secret_envelopes")).rows[0].n).toBe("1");
		await expect(as("pim_gate", "DELETE FROM pim_ops.tenants")).rejects.toThrow(/permission denied/);
		await expect(as("pim_live", "SELECT * FROM pim_ops.secret_envelopes")).rejects.toThrow(/permission denied/);
		await expect(as("pim_live", "SELECT * FROM pim_ops.external_operations")).rejects.toThrow(/permission denied/);
		await expect(as("pim_forge", "SELECT * FROM pim_ops.tenants")).rejects.toThrow(/permission denied/);
		await expect(as("pim_runtime", "CREATE TABLE pim_ops.x (a int)")).rejects.toThrow(/permission denied/);
		await expect(as("pim_runtime", "UPDATE pim_ops.ops_restore SET state = 'reconciled'")).rejects.toThrow(/permission denied/);
		expect((await as("pim_runtime", "UPDATE pim_ops.due_work SET state = 'done' RETURNING 1")).rowCount).toBe(0);
		expect((await as("pim_maintenance", "UPDATE pim_ops.tenants SET status = 'active' RETURNING 1")).rowCount).toBe(1);
		// The owner helper from the foundation is callable by every process role and null when unset.
		expect((await as("pim_gate", "SELECT public.pim_current_owner_id() AS o")).rows[0].o).toBeNull();
		await pool.end();
	});
});
