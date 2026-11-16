/** Real PostgreSQL and NATS for the tests, each started on a private port and removed afterwards; skipped when the binaries are absent. */
import { execFileSync, spawn, type ChildProcess } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";
import { migrate } from "../../src/migrate.ts";

const which = (name: string): string | null => {
	try {
		return execFileSync("which", [name], { encoding: "utf8" }).trim() || null;
	} catch {
		return null;
	}
};

function postgresBin(): string | null {
	const found = which("initdb");
	if (found) return found.replace(/\/initdb$/, "");
	if (!existsSync("/usr/lib/postgresql")) return null;
	const versions = readdirSync("/usr/lib/postgresql").sort((a, b) => Number(b) - Number(a));
	return versions.length > 0 ? `/usr/lib/postgresql/${versions[0]}/bin` : null;
}

export const POSTGRES = postgresBin();
export const NATS_SERVER = process.env.NATS_SERVER ?? which("nats-server");

function freePort(): Promise<number> {
	return new Promise((resolve, reject) => {
		const probe = createServer();
		probe.listen(0, "127.0.0.1", () => {
			const { port } = probe.address() as { port: number };
			probe.close(() => resolve(port));
		});
		probe.on("error", reject);
	});
}

/** `admin` is the superuser that sets the fixtures up; `pool` connects as a member of `pim_live`, so row-level security applies to it as it would in production. */
export type Database = { pool: pg.Pool; admin: pg.Pool; stop(): Promise<void> };

const FOUNDATION = fileURLToPath(new URL("../../../v2-contracts/migrations/0001_foundation.sql", import.meta.url));

/** A fresh cluster with the canonical foundation migration, this package's migrations and the fixtures of what it reads: the runtime outbox and a stand-in for Gate's sessions. */
export async function startPostgres(): Promise<Database> {
	if (!POSTGRES) throw new Error("PostgreSQL is not installed");
	const dir = mkdtempSync(join(tmpdir(), "pim-live-pg-"));
	const port = await freePort();
	execFileSync(join(POSTGRES, "initdb"), ["-D", join(dir, "data"), "-A", "trust", "-U", "postgres", "--no-sync"], { stdio: "ignore" });
	execFileSync(join(POSTGRES, "pg_ctl"), ["-D", join(dir, "data"), "-o", `-p ${port} -k ${dir} -c listen_addresses=127.0.0.1 -c fsync=off -c max_connections=200`, "-w", "-l", join(dir, "log"), "start"], { stdio: "ignore" });
	const admin = new pg.Pool({ connectionString: `postgres://postgres@127.0.0.1:${port}/postgres`, max: 10 });
	const foundation = readFileSync(FOUNDATION, "utf8");
	await admin.query(foundation);
	await admin.query("INSERT INTO public.pim_schema_migrations (number, name, checksum) VALUES (1, 'foundation', $1)", [createHash("sha256").update(foundation).digest("hex")]);
	await migrate(admin);
	await admin.query(`
		CREATE TABLE pim_runtime.runtime_outbox (
			partition_id uuid NOT NULL, commit_seq bigint NOT NULL, projection_version integer NOT NULL, owner_id text NOT NULL, public_chat_id uuid NOT NULL,
			conversation_id integer NOT NULL, event_kind text NOT NULL, payload jsonb NOT NULL, committed_at timestamptz NOT NULL DEFAULT now(), PRIMARY KEY (partition_id, commit_seq));
		CREATE TABLE pim_runtime.effects_ledger (id bigserial PRIMARY KEY, what text NOT NULL);
		GRANT SELECT ON pim_runtime.runtime_outbox TO pim_live;
		CREATE SCHEMA test_identity;
		CREATE TABLE test_identity.accounts (owner_id text PRIMARY KEY, status text NOT NULL DEFAULT 'active');
		CREATE TABLE test_identity.sessions (session_id text PRIMARY KEY, owner_id text NOT NULL, revoked_at timestamptz);
		CREATE ROLE live_app LOGIN IN ROLE pim_live;
	`);
	const pool = new pg.Pool({ connectionString: `postgres://live_app@127.0.0.1:${port}/postgres`, max: 40 });
	return {
		pool,
		admin,
		async stop() {
			await pool.end().catch(() => {});
			await admin.end().catch(() => {});
			try {
				execFileSync(join(POSTGRES, "pg_ctl"), ["-D", join(dir, "data"), "-m", "immediate", "-w", "stop"], { stdio: "ignore" });
			} finally {
				rmSync(dir, { recursive: true, force: true });
			}
		},
	};
}

export type Nats = { url: string; process: ChildProcess; stop(): Promise<void> };

export async function startNats(): Promise<Nats> {
	if (!NATS_SERVER) throw new Error("nats-server is not installed");
	const port = await freePort();
	const child = spawn(NATS_SERVER, ["-a", "127.0.0.1", "-p", String(port)], { stdio: "ignore" });
	for (let attempt = 0; attempt < 100; attempt++) {
		const up = await new Promise<boolean>((resolve) => {
			import("node:net").then(({ connect }) => {
				const socket = connect(port, "127.0.0.1", () => (socket.destroy(), resolve(true)));
				socket.on("error", () => resolve(false));
			});
		});
		if (up) break;
		await new Promise((resolve) => setTimeout(resolve, 50));
	}
	return { url: `127.0.0.1:${port}`, process: child, async stop() { child.kill("SIGKILL"); } };
}

/** Polls until `check` holds. */
export async function until(check: () => boolean | Promise<boolean>, what: string, ms = 10_000): Promise<void> {
	const end = Date.now() + ms;
	while (Date.now() < end) {
		if (await check()) return;
		await new Promise((resolve) => setTimeout(resolve, 10));
	}
	throw new Error(`Timed out waiting for ${what}`);
}

/** A repeatable random source. */
export function seeded(seed: number): () => number {
	let state = seed >>> 0;
	return () => {
		state = (state + 0x6d2b79f5) >>> 0;
		let t = state;
		t = Math.imul(t ^ (t >>> 15), t | 1);
		t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
		return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
	};
}
