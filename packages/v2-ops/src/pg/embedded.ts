// A real PostgreSQL for tests, rehearsals and benchmarks, run from the `embedded-postgres` binaries with
// the durability settings a production server has (fsync, full_page_writes, synchronous_commit all on).
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import pg from "pg";

export type EmbeddedPostgres = {
	readonly port: number;
	readonly dataDir: string;
	/** A connection string for a database on this server. */
	url(database?: string, user?: string): string;
	/** A new empty database. */
	createDatabase(name: string): Promise<void>;
	stop(): Promise<void>;
};

export type EmbeddedOptions = {
	readonly dataDir?: string;
	/** Extra `-c key=value` server settings; the durability ones cannot be turned off here. */
	readonly settings?: Readonly<Record<string, string>>;
	readonly keepData?: boolean;
};

const FORBIDDEN = new Set(["fsync", "full_page_writes", "synchronous_commit"]);

export async function startEmbeddedPostgres(options: EmbeddedOptions = {}): Promise<EmbeddedPostgres> {
	for (const key of Object.keys(options.settings ?? {})) if (FORBIDDEN.has(key)) throw new Error(`${key} is a durability setting and stays on`);
	const { default: EmbeddedPg } = await import("embedded-postgres");
	const dataDir = options.dataDir ?? (await mkdtemp(join(tmpdir(), "pim-pg-")));
	const port = 20000 + Math.floor(Math.random() * 20000);
	const server = new EmbeddedPg({
		databaseDir: join(dataDir, "data"),
		user: "postgres",
		password: "postgres",
		port,
		persistent: true,
		postgresFlags: ["-c", "fsync=on", "-c", "full_page_writes=on", "-c", "synchronous_commit=on", ...Object.entries(options.settings ?? {}).flatMap(([key, value]) => ["-c", `${key}=${value}`])],
		onLog: () => undefined,
		onError: () => undefined,
	});
	await server.initialise();
	await server.start();
	const url = (database = "postgres", user = "postgres") => `postgres://${user}:postgres@127.0.0.1:${port}/${database}`;
	return {
		port,
		dataDir,
		url,
		async createDatabase(name) {
			const admin = new pg.Client({ connectionString: url() });
			await admin.connect();
			try {
				await admin.query(`CREATE DATABASE "${name.replace(/[^a-z0-9_]/gi, "")}"`);
			} finally {
				await admin.end();
			}
		},
		async stop() {
			await server.stop();
			if (!options.keepData) await rm(dataDir, { recursive: true, force: true });
		},
	};
}
