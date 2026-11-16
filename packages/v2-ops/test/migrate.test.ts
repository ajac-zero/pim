import { describe, expect, it } from "vitest";
import { MigrationChecksumError, loadMigrations, migrate } from "../src/pg/migrate.ts";
import { usePostgres } from "./support/pg.ts";

const db = usePostgres();

describe("the versioned SQL runner", () => {
	it("applies every file once, in order, and does nothing the second time", async () => {
		const pool = await db.freshDatabase({ migrated: false });
		const migrations = await loadMigrations();
		expect(migrations.map((m) => m.version)).toEqual(["0500", "0501", "0502"]);
		expect(await migrate(pool, migrations)).toEqual(["0500", "0501", "0502"]);
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
