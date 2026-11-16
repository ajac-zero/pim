import { parseArgs } from "node:util";
import type { MigrationOwner } from "@pim/v2-contracts/db";
import pg from "pg";
import { loadAllMigrations, migrate } from "../pg/migrate.ts";
import { need } from "./common.ts";

// The migrator's one-shot: applies the foundation migration, this package's band (0500-0599) and any other workstream's directory named with
// --dir <owner>=<path> (owner: runtime, application, live, forge), in number order, in public.pim_schema_migrations. Each directory is checked against its band.
const { values } = parseArgs({ options: { "database-url": { type: "string" }, dir: { type: "string", multiple: true, default: [] } } });
const pool = new pg.Pool({ connectionString: need(values["database-url"] ?? process.env.PIM_DATABASE_URL, "--database-url or PIM_DATABASE_URL"), max: 1 });
try {
	const extra = values.dir!.map((entry) => {
		const [owner, dir] = entry.split("=") as [MigrationOwner, string];
		return { owner, dir };
	});
	const applied = await migrate(pool, await loadAllMigrations(extra));
	console.log(applied.length ? `Applied ${applied.map((n) => String(n).padStart(4, "0")).join(", ")}` : "Schema is up to date");
} finally {
	await pool.end();
}
