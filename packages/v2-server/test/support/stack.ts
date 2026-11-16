import { describe } from "vitest";
import { randomUUID } from "node:crypto";
import { execFileSync, spawn, type ChildProcess } from "node:child_process";
import { createServer, connect } from "node:net";
import { fileURLToPath } from "node:url";
import pg from "pg";
import { Db } from "@pim/v2-runtime/db";
import { applyMigrations, migrate as migrateRuntime } from "@pim/v2-runtime/migrate";
import { migrate as migrateLive } from "@pim/v2-live/migrate";
import { migrate as migrateForge, type Db as ForgeDb } from "@pim/v2-forge/db";

const FOUNDATION = fileURLToPath(new URL("../../../v2-contracts/migrations/", import.meta.url));
const INTEGRATION = fileURLToPath(new URL("../../migrations/", import.meta.url));

/** `describe` when nats-server is installed, and skipped without it, unless CI says it must be there (PIM_V2_REQUIRE_INFRA): then its absence fails the run. */
export function describeWith(available: boolean) {
	if (!available && process.env.PIM_V2_REQUIRE_INFRA) throw new Error("nats-server is required here (PIM_V2_REQUIRE_INFRA is set) but is not installed");
	return describe.skipIf(!available);
}

export const hasNats = (): boolean => {
	try {
		execFileSync("nats-server", ["--version"], { stdio: "ignore" });
		return true;
	} catch {
		return false;
	}
};

const freePort = () =>
	new Promise<number>((resolve, reject) => {
		const probe = createServer();
		probe.listen(0, "127.0.0.1", () => {
			const { port } = probe.address() as { port: number };
			probe.close(() => resolve(port));
		});
		probe.on("error", reject);
	});

export type Nats = { url: string; stop(): void };

export async function startNats(): Promise<Nats> {
	const port = await freePort();
	const child: ChildProcess = spawn("nats-server", ["-a", "127.0.0.1", "-p", String(port)], { stdio: "ignore" });
	for (let attempt = 0; attempt < 100; attempt++) {
		const up = await new Promise<boolean>((resolve) => {
			const socket = connect(port, "127.0.0.1", () => (socket.destroy(), resolve(true)));
			socket.on("error", () => resolve(false));
		});
		if (up) break;
		await new Promise((resolve) => setTimeout(resolve, 50));
	}
	return { url: `127.0.0.1:${port}`, stop: () => void child.kill("SIGKILL") };
}

export type Stack = {
	/** The superuser, for fixtures and for looking at what the roles cannot. */
	admin: pg.Pool;
	/** The runtime's database: a member of `pim_runtime`, so row-level security applies. */
	runtime: Db;
	/** Live's pool: a member of `pim_live`. */
	live: pg.Pool;
	drop(): Promise<void>;
};

/** A fresh database with every band migrated in order (foundation, runtime, live, integration), and one login per role. */
export async function createStack(): Promise<Stack> {
	const base = process.env.PIM_V2_PG_URL;
	if (!base) throw new Error("PIM_V2_PG_URL is not set; the global setup starts PostgreSQL");
	const name = `srv_${randomUUID().replaceAll("-", "").slice(0, 16)}`;
	const root = new pg.Client({ connectionString: base });
	await root.connect();
	await root.query(`CREATE DATABASE ${name}`);
	for (const role of ["srv_runtime_app", "srv_live_app"]) await root.query(`DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = '${role}') THEN CREATE ROLE ${role} LOGIN; END IF; END $$`);
	await root.end();
	const urlFor = (user?: string) => {
		const url = new URL(base);
		url.pathname = `/${name}`;
		if (user) url.username = user;
		return url.toString();
	};
	const admin = new pg.Pool({ connectionString: urlFor(), max: 5 });
	await applyMigrations(admin, FOUNDATION, "foundation");
	await migrateRuntime(admin);
	await migrateLive(admin);
	await migrateForge(admin as unknown as ForgeDb);
	await applyMigrations(admin, INTEGRATION, "integration");
	await admin.query("GRANT pim_runtime TO srv_runtime_app");
	await admin.query("GRANT pim_live TO srv_live_app");
	const runtime = Db.connect({ connectionString: urlFor("srv_runtime_app"), max: 10 });
	const live = new pg.Pool({ connectionString: urlFor("srv_live_app"), max: 10 });
	return {
		admin,
		runtime,
		live,
		async drop() {
			await live.end();
			await runtime.close();
			await admin.end();
			const cleanup = new pg.Client({ connectionString: base });
			await cleanup.connect();
			await cleanup.query(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`);
			await cleanup.end();
		},
	};
}
