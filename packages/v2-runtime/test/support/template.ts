import { randomUUID } from "node:crypto";
import pg from "pg";

/**
 * Builds a template database once per run, so each test database is a `CREATE DATABASE ... TEMPLATE` copy (about a tenth of a second)
 * instead of the foundation and every band migrated again. `build` receives a connection string to the new database and does what the
 * fixture would have done to a blank one. The name goes into `env` for the fixtures, which copy it with `databaseFromTemplate`.
 * Roles are cluster-wide, so a fixture's logins and memberships belong in `build`, not in the copy. Nothing may stay connected to a
 * template while it is copied, so the database is marked a template that refuses connections and `build` must close what it opens.
 * Returns the teardown that drops it.
 */
export async function buildTemplate(env: string, build: (url: string) => Promise<void>): Promise<() => Promise<void>> {
	const base = process.env.PIM_V2_PG_URL;
	if (!base) throw new Error("PIM_V2_PG_URL is not set; the global setup starts PostgreSQL");
	const name = `tpl_${randomUUID().replaceAll("-", "").slice(0, 12)}`;
	const root = new pg.Client({ connectionString: base });
	await root.connect();
	try {
		await root.query(`CREATE DATABASE ${name}`);
		const url = new URL(base);
		url.pathname = `/${name}`;
		await build(url.toString());
		await root.query(`ALTER DATABASE ${name} WITH IS_TEMPLATE true ALLOW_CONNECTIONS false`);
	} finally {
		await root.end();
	}
	process.env[env] = name;
	return async () => {
		const cleanup = new pg.Client({ connectionString: base });
		await cleanup.connect();
		await cleanup.query(`ALTER DATABASE ${name} WITH IS_TEMPLATE false`);
		await cleanup.query(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`);
		await cleanup.end();
	};
}

/** A new empty-named database that is a copy of the template named by `env`; its name. */
export async function databaseFromTemplate(env: string, prefix: string): Promise<string> {
	const template = process.env[env];
	if (!template) throw new Error(`${env} is not set; the global setup builds the template database`);
	const base = process.env.PIM_V2_PG_URL;
	const name = `${prefix}_${randomUUID().replaceAll("-", "").slice(0, 16)}`;
	const root = new pg.Client({ connectionString: base });
	await root.connect();
	try {
		await root.query(`CREATE DATABASE ${name} TEMPLATE ${template}`);
	} finally {
		await root.end();
	}
	return name;
}
