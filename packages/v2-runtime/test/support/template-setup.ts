import { fileURLToPath } from "node:url";
import { Db } from "../../src/db.ts";
import { applyMigrations, migrate } from "../../src/migrate.ts";
import { buildTemplate } from "./template.ts";

const FOUNDATION_DIR = fileURLToPath(new URL("../../../v2-contracts/migrations/", import.meta.url));

/** The runtime tests' template: the canonical foundation and the runtime migrations, with `pim_runtime_app` a login member of `pim_runtime`. */
export default async function setup(): Promise<() => Promise<void>> {
	return buildTemplate("PIM_V2_TEMPLATE_RUNTIME", async (url) => {
		const root = Db.connect({ connectionString: process.env.PIM_V2_PG_URL!, max: 1 });
		// Created before the foundation grants its roles; a member of pim_runtime reaches the tables only through its privileges.
		await root.pool.query("DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'pim_runtime_app') THEN CREATE ROLE pim_runtime_app LOGIN; END IF; END $$");
		await root.close();
		const db = Db.connect({ connectionString: url, max: 2 });
		await applyMigrations(db.pool, FOUNDATION_DIR, "foundation");
		await db.pool.query("GRANT pim_runtime TO pim_runtime_app");
		await migrate(db.pool);
		await db.close();
	});
}
