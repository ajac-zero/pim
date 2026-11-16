import { randomUUID } from "node:crypto";
import pg from "pg";
import { createPool, migrate } from "../../src/db.ts";

export interface TestDb {
	url: (user: string) => string;
	admin: pg.Pool;
	runtime: pg.Pool;
	gate: pg.Pool;
	live: pg.Pool;
	steward: pg.Pool;
	maint: pg.Pool;
	close(): Promise<void>;
}

const LOGINS = { runtime: "pim_runtime", gate: "pim_gate", live: "pim_live", steward: "pim_steward", maint: "pim_maint" } as const;

/** A fresh, migrated database plus one pool per scoped role. The login roles are real NOBYPASSRLS members, so RLS is in force in every test. */
export async function createTestDb(max = 10): Promise<TestDb> {
	const base = process.env.PIM_TEST_PG;
	if (!base) throw new Error("PIM_TEST_PG is not set: the global setup did not start PostgreSQL");
	const name = `t_${randomUUID().replaceAll("-", "").slice(0, 16)}`;
	const root = new pg.Client({ connectionString: `${base}/postgres` });
	await root.connect();
	await root.query(`CREATE DATABASE ${name}`);
	await root.end();
	const url = (user: string) => `postgres://${user}:pw@${base.split("@")[1]}/${name}`;
	const admin = createPool({ connectionString: url("postgres"), max: 4 });
	await migrate(admin);
	for (const [key, group] of Object.entries(LOGINS)) {
		const login = `login_${key}`;
		const exists = (await admin.query("SELECT 1 FROM pg_roles WHERE rolname = $1", [login])).rowCount;
		if (!exists) await admin.query(`CREATE ROLE ${login} LOGIN PASSWORD 'pw' IN ROLE ${group}`);
	}
	const pools = Object.fromEntries(Object.keys(LOGINS).map((key) => [key, createPool({ connectionString: url(`login_${key}`), max })])) as Record<keyof typeof LOGINS, pg.Pool>;
	return {
		url,
		admin,
		...pools,
		async close() {
			for (const pool of [...Object.values(pools), admin]) await pool.end();
			const r = new pg.Client({ connectionString: `${base}/postgres` });
			await r.connect();
			await r.query(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`);
			await r.end();
		},
	};
}
