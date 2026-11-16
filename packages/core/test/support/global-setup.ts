import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import EmbeddedPostgres from "embedded-postgres";

/** One real PostgreSQL for the whole run; each test file makes its own database in it. */
export default async function setup(): Promise<() => Promise<void>> {
	const dir = mkdtempSync(join(tmpdir(), "pim-pg-"));
	const port = 54000 + Math.floor(Math.random() * 900);
	const server = new EmbeddedPostgres({
		databaseDir: join(dir, "data"),
		user: "postgres",
		password: "pw",
		port,
		persistent: false,
		postgresFlags: ["-c", "max_connections=400", "-c", "fsync=on", "-c", "full_page_writes=on", "-c", "synchronous_commit=on"],
		onLog: () => {},
		onError: () => {},
	});
	await server.initialise();
	await server.start();
	process.env.PIM_TEST_PG = `postgres://postgres:pw@localhost:${port}`;
	return async () => {
		await server.stop();
		rmSync(dir, { recursive: true, force: true });
	};
}
