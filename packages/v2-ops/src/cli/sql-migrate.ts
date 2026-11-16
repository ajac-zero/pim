import { parseArgs } from "node:util";
import pg from "pg";
import { loadMigrations, migrate } from "../pg/migrate.ts";
import { need } from "./common.ts";

// The migrator role's one-shot: applies this package's migrations (0500-0599) and any other directories of `NNNN_name.sql` files named with --dir, in version order, under one ledger.
const { values } = parseArgs({ options: { "database-url": { type: "string" }, dir: { type: "string", multiple: true, default: [] } } });
const pool = new pg.Pool({ connectionString: need(values["database-url"] ?? process.env.PIM_DATABASE_URL, "--database-url or PIM_DATABASE_URL"), max: 1 });
try {
	const all = [...(await loadMigrations()), ...(await Promise.all(values.dir!.map((dir) => loadMigrations(dir)))).flat()].sort((a, b) => (a.version < b.version ? -1 : 1));
	const seen = new Set<string>();
	for (const m of all) {
		if (seen.has(m.version)) throw new Error(`Two migrations share version ${m.version}: workstreams own separate ranges`);
		seen.add(m.version);
	}
	const applied = await migrate(pool, all);
	console.log(applied.length ? `Applied ${applied.join(", ")}` : "Schema is up to date");
} finally {
	await pool.end();
}
