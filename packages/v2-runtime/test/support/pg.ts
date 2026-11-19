import pg from "pg";
import { Db } from "../../src/db.ts";
import { databaseFromTemplate } from "./template.ts";

const adminUrl = (): string => {
	const url = process.env.PIM_V2_PG_URL;
	if (!url) throw new Error("PIM_V2_PG_URL is not set; the global setup starts PostgreSQL");
	return url;
};

export type TestDatabase = {
	readonly url: string;
	readonly name: string;
	readonly db: Db;
	/** A pool for a non-superuser role, which row-level security applies to. */
	appPool(): pg.Pool;
	drop(): Promise<void>;
};

/** A fresh database: a copy of the template the global setup built (the canonical foundation and the runtime migrations); `pim_runtime_app` is a login member of the `pim_runtime` role. */
export async function createTestDatabase(): Promise<TestDatabase> {
	const name = await databaseFromTemplate("PIM_V2_TEMPLATE_RUNTIME", "rt");
	const url = new URL(adminUrl());
	url.pathname = `/${name}`;
	const db = Db.connect({ connectionString: url.toString(), max: 20 });
	const appPools: pg.Pool[] = [];
	return {
		url: url.toString(),
		name,
		db,
		appPool() {
			const appUrl = new URL(url);
			appUrl.username = "pim_runtime_app";
			const pool = new pg.Pool({ connectionString: appUrl.toString(), max: 5 }).on("error", () => {});
			appPools.push(pool);
			return pool;
		},
		async drop() {
			await Promise.all(appPools.map((pool) => pool.end()));
			await db.close();
			const cleanup = new pg.Client({ connectionString: adminUrl() });
			await cleanup.connect();
			await cleanup.query(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`);
			await cleanup.end();
		},
	};
}
