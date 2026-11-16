import { randomUUID } from "node:crypto";
import pg from "pg";
import { Db } from "../../src/db.ts";
import { migrate } from "../../src/migrate.ts";

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

/** A fresh, migrated database; the role pim_runtime_app exists before the migrations so they grant it. */
export async function createTestDatabase(): Promise<TestDatabase> {
	const admin = new pg.Client({ connectionString: adminUrl() });
	await admin.connect();
	const name = `rt_${randomUUID().replaceAll("-", "").slice(0, 16)}`;
	await admin.query(`CREATE DATABASE ${name}`);
	await admin.query("DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'pim_runtime_app') THEN CREATE ROLE pim_runtime_app LOGIN; END IF; END $$");
	await admin.end();
	const url = new URL(adminUrl());
	url.pathname = `/${name}`;
	const db = Db.connect({ connectionString: url.toString(), max: 20 });
	await migrate(db.pool);
	const appPools: pg.Pool[] = [];
	return {
		url: url.toString(),
		name,
		db,
		appPool() {
			const appUrl = new URL(url);
			appUrl.username = "pim_runtime_app";
			const pool = new pg.Pool({ connectionString: appUrl.toString(), max: 5 });
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
