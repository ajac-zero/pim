import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import EmbeddedPostgres from "embedded-postgres";
import type { TestProject } from "vitest/node";

declare module "vitest" {
	export interface ProvidedContext {
		pgAdminUrl: string;
	}
}

/** Starts one real PostgreSQL for the whole run, in a temporary directory, on a free port. Each test file makes its own database in it. */
export default async function setup(project: TestProject) {
	const dir = mkdtempSync(join(tmpdir(), "pim-v2-app-pg-"));
	const port = 40000 + Math.floor(Math.random() * 20000);
	const pg = new EmbeddedPostgres({ databaseDir: join(dir, "data"), user: "pim", password: "pim", port, persistent: false, initdbFlags: ["--locale=C", "--lc-messages=C", "--encoding=UTF8"], onLog: () => {}, onError: () => {} });
	await pg.initialise();
	await pg.start();
	project.provide("pgAdminUrl", `postgres://pim:pim@localhost:${port}/postgres`);
	return async () => {
		await pg.stop();
		rmSync(dir, { recursive: true, force: true });
	};
}
