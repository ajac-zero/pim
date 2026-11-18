import { describe } from "vitest";
import { randomUUID } from "node:crypto";
import { execFileSync, spawn, type ChildProcess } from "node:child_process";
import { createServer, connect } from "node:net";
import { fileURLToPath } from "node:url";
import pg from "pg";
import { Db } from "@pim/v2-runtime/db";
import { databaseFromTemplate } from "../../../v2-runtime/test/support/template.ts";


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

export const freePort = () =>
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
	/** The connection string of a login that is a member of one process role (`gate`, `runtime`, `live`, `forge`, `maintenance`), as that process connects. `super` is the schema owner. */
	url(role: "super" | "gate" | "runtime" | "live" | "forge" | "maintenance"): string;
	drop(): Promise<void>;
};

/** A fresh database: a copy of the template the global setup built, with every band migrated by the real migrator (foundation, runtime, application, live, forge, operations, integration) and one login per role. */
export async function createStack(): Promise<Stack> {
	const base = process.env.PIM_V2_PG_URL;
	if (!base) throw new Error("PIM_V2_PG_URL is not set; the global setup starts PostgreSQL");
	const name = await databaseFromTemplate("PIM_V2_TEMPLATE_SERVER", "srv");
	const urlFor = (user?: string) => {
		const url = new URL(base);
		url.pathname = `/${name}`;
		if (user) url.username = user;
		return url.toString();
	};
	// An idle connection that the server drops (the database is dropped under it at teardown) is not a test failure.
	const admin = new pg.Pool({ connectionString: urlFor(), max: 5 }).on("error", () => {});
	const runtime = Db.connect({ connectionString: urlFor("srv_runtime_login"), max: 10 });
	const live = new pg.Pool({ connectionString: urlFor("srv_live_login"), max: 10 }).on("error", () => {});
	return {
		admin,
		runtime,
		live,
		url: (role) => (role === "super" ? urlFor() : urlFor(`srv_${role}_login`)),
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
