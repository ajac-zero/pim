import pg from "pg";
import { buildTemplate } from "../../../v2-runtime/test/support/template.ts";
import { migrateAll } from "../../src/migrate.ts";

export const LOGIN_KINDS = ["gate", "runtime", "live", "forge", "maintenance"] as const;

/** The integration tests' template: every band migrated by the real migrator, and one login per process role, none a superuser or BYPASSRLS, as the deployments create them. */
export default async function setup(): Promise<() => Promise<void>> {
	return buildTemplate("PIM_V2_TEMPLATE_SERVER", async (url) => {
		const root = new pg.Pool({ connectionString: process.env.PIM_V2_PG_URL, max: 1 });
		for (const kind of LOGIN_KINDS) await root.query(`DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'srv_${kind}_login') THEN CREATE ROLE srv_${kind}_login LOGIN NOSUPERUSER NOBYPASSRLS; END IF; END $$`);
		await root.end();
		const admin = new pg.Pool({ connectionString: url, max: 2 });
		await migrateAll(admin);
		for (const kind of LOGIN_KINDS) await admin.query(`GRANT pim_${kind} TO srv_${kind}_login`);
		await admin.end();
	});
}
