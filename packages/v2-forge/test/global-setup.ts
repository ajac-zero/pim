// One real PostgreSQL (the embedded binary) for the whole run; each test file gets its own database.
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import EmbeddedPostgres from "embedded-postgres";
import type { TestProject } from "vitest/node";

export default async function setup(project: TestProject) {
	const dir = mkdtempSync(join(tmpdir(), "forge-pg-"));
	const port = 20000 + Math.floor(Math.random() * 20000);
	const pg = new EmbeddedPostgres({ databaseDir: join(dir, "data"), user: "forge", password: "forge", port, persistent: false, onLog: () => {}, onError: () => {} });
	await pg.initialise();
	await pg.start();
	project.provide("pgUrl" as never, `postgres://forge:forge@127.0.0.1:${port}/postgres` as never);
	return async () => {
		await pg.stop();
		rmSync(dir, { recursive: true, force: true });
	};
}
