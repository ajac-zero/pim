import { afterAll, beforeAll } from "vitest";
import pg from "pg";
import { loadAllMigrations, migrate } from "../../src/pg/migrate.ts";
import { type EmbeddedPostgres, startEmbeddedPostgres } from "../../src/pg/embedded.ts";

let server: EmbeddedPostgres | undefined;
let counter = 0;
const pools: pg.Pool[] = [];

/** One PostgreSQL per test file; `freshDatabase` gives each test a migrated, empty database of its own. */
export function usePostgres() {
	beforeAll(async () => {
		server = await startEmbeddedPostgres();
	});
	afterAll(async () => {
		await Promise.all(pools.splice(0).map((pool) => pool.end().catch(() => undefined)));
		await server?.stop();
	});
	return {
		get server() {
			return server!;
		},
		async freshDatabase(options: { migrated?: boolean } = {}): Promise<pg.Pool> {
			const name = `t${Date.now().toString(36)}_${counter++}`;
			await server!.createDatabase(name);
			const pool = new pg.Pool({ connectionString: server!.url(name), max: 8 });
			pool.on("error", () => undefined);
			pools.push(pool);
			if (options.migrated !== false) await migrate(pool, await loadAllMigrations());
			return pool;
		},
	};
}
