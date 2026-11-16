/**
 * The migrator: foundation `0001`, then every workstream's band in number order (runtime 0100, application 0200, live 0300,
 * forge 0400, operations 0500) and the integration band (0600), into one ledger, `public.pim_schema_migrations`. It runs as the
 * schema owner, never as a role the services use, once per deploy (the Compose `migrator`, a Kubernetes Job).
 */
import { loadAllMigrations, migrate as run } from "@pim/v2-ops/pg/migrate";
import type { Pool } from "pg";

const dir = (workspacePackage: string) => new URL(`../../${workspacePackage}/migrations/`, import.meta.url).pathname;

export const bands = [
	{ dir: dir("v2-runtime"), owner: "runtime" },
	{ dir: dir("v2-app"), owner: "application" },
	{ dir: dir("v2-live"), owner: "live" },
	{ dir: dir("v2-forge"), owner: "forge" },
	{ dir: dir("v2-server"), owner: "integration" },
] as const;

/** Applies what is pending; the numbers applied by this call. Safe to run twice, and from two places at once (an advisory lock serializes them). */
export async function migrateAll(pool: Pool): Promise<number[]> {
	return run(pool, await loadAllMigrations(bands));
}
