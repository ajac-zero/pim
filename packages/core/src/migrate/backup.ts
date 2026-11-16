import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, readdirSync, writeFileSync, createWriteStream } from "node:fs";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { createReadStream } from "node:fs";
import type pg from "pg";

/**
 * A logical backup of the whole database: every table of `app` and `rt` as NDJSON, with a per-table digest, the
 * migrations applied, and an inventory of what is not in the database (key versions in use, object bodies' checksums).
 * It complements, and does not replace, physical backup with WAL archiving (docs/v2/operations.md): it is what the
 * restore rehearsal and the import toolkit can check, table by table, and it works on any PostgreSQL.
 * The role that runs it needs BYPASSRLS (a dedicated backup login, never a service's): row-level security applies to everyone else.
 */
export interface BackupManifest {
	format: "pim-backup/1";
	createdAt: string;
	migrations: string[];
	tables: Record<string, { rows: number; sha256: string }>;
	keyVersionsInUse: number[];
	objects: { count: number; bytes: number };
}

const qualify = (schema: string, name: string) => `${schema}.${name}`;

async function tables(pool: pg.Pool): Promise<string[]> {
	return (await pool.query("SELECT table_schema, table_name FROM information_schema.tables WHERE table_schema IN ('app', 'rt') AND table_type = 'BASE TABLE' ORDER BY 1, 2")).rows.map((r) => qualify(r.table_schema, r.table_name));
}

/** Streams a table's rows as JSON text lines through a server-side cursor, in a stable order. */
async function* rows(pool: pg.Pool, table: string): AsyncGenerator<string> {
	const client = await pool.connect();
	try {
		await client.query("BEGIN READ ONLY");
		await client.query(`DECLARE c NO SCROLL CURSOR FOR SELECT row_to_json(t)::text AS j FROM ${table} t ORDER BY 1`);
		for (;;) {
			const batch = (await client.query("FETCH 2000 FROM c")).rows as { j: string }[];
			if (batch.length === 0) break;
			for (const row of batch) yield row.j;
		}
		await client.query("COMMIT");
	} finally {
		client.release();
	}
}

export async function digestTable(pool: pg.Pool, table: string): Promise<{ rows: number; sha256: string }> {
	const hash = createHash("sha256");
	let n = 0;
	for await (const line of rows(pool, table)) {
		hash.update(`${line}\n`);
		n++;
	}
	return { rows: n, sha256: hash.digest("hex") };
}

export async function backupDatabase(pool: pg.Pool, dir: string): Promise<BackupManifest> {
	mkdirSync(join(dir, "tables"), { recursive: true });
	const manifestTables: BackupManifest["tables"] = {};
	for (const table of await tables(pool)) {
		const hash = createHash("sha256");
		let n = 0;
		const out = createWriteStream(join(dir, "tables", `${table}.ndjson`));
		for await (const line of rows(pool, table)) {
			hash.update(`${line}\n`);
			out.write(`${line}\n`);
			n++;
		}
		await new Promise<void>((resolve) => out.end(() => resolve()));
		manifestTables[table] = { rows: n, sha256: hash.digest("hex") };
	}
	const migrations = (await pool.query("SELECT name FROM public.pim_migrations ORDER BY name")).rows.map((r) => r.name as string);
	const versions = (await pool.query("SELECT DISTINCT key_version FROM app.secrets ORDER BY 1")).rows.map((r) => r.key_version as number);
	const objects = (await pool.query("SELECT count(*)::int AS n, COALESCE(sum(size_bytes), 0)::bigint AS b FROM app.objects")).rows[0];
	const manifest: BackupManifest = { format: "pim-backup/1", createdAt: new Date().toISOString(), migrations, tables: manifestTables, keyVersionsInUse: versions, objects: { count: objects.n, bytes: Number(objects.b) } };
	writeFileSync(join(dir, "manifest.json"), `${JSON.stringify(manifest, null, 1)}\n`);
	return manifest;
}

async function* lines(path: string): AsyncGenerator<string> {
	for await (const line of createInterface({ input: createReadStream(path, { encoding: "utf8" }), crlfDelay: Infinity })) if (line) yield line;
}

/** Restores into an empty, migrated database. Refuses a target that has rows. Constraints and triggers are off for the load, and every table is verified against the manifest after. */
export async function restoreDatabase(pool: pg.Pool, dir: string): Promise<{ restored: number; mismatches: string[] }> {
	const manifest = JSON.parse(readFileSync(join(dir, "manifest.json"), "utf8")) as BackupManifest;
	const target = (await pool.query("SELECT name FROM public.pim_migrations ORDER BY name")).rows.map((r) => r.name as string);
	if (JSON.stringify(target) !== JSON.stringify(manifest.migrations)) throw new Error(`The target's schema (${target.join(", ")}) differs from the backup's (${manifest.migrations.join(", ")})`);
	for (const table of Object.keys(manifest.tables)) {
		const n = (await pool.query(`SELECT count(*)::int AS n FROM ${table}`)).rows[0].n;
		if (n > 0) throw new Error(`The target is not empty: ${table} has ${n} rows`);
	}
	const client = await pool.connect();
	let restored = 0;
	try {
		await client.query("BEGIN");
		await client.query("SET LOCAL session_replication_role = replica");
		for (const table of Object.keys(manifest.tables)) {
			let batch: string[] = [];
			const flush = async () => {
				if (batch.length === 0) return;
				await client.query(`INSERT INTO ${table} OVERRIDING SYSTEM VALUE SELECT * FROM json_populate_recordset(null::${table}, $1::json)`, [`[${batch.join(",")}]`]);
				restored += batch.length;
				batch = [];
			};
			for await (const line of lines(join(dir, "tables", `${table}.ndjson`))) {
				batch.push(line);
				if (batch.length >= 1000) await flush();
			}
			await flush();
		}
		// Identity columns continue after what was restored.
		const seqs = (await client.query("SELECT table_schema, table_name, column_name FROM information_schema.columns WHERE table_schema IN ('app', 'rt') AND is_identity = 'YES'")).rows;
		for (const s of seqs) await client.query(`SELECT setval(pg_get_serial_sequence('${s.table_schema}.${s.table_name}', '${s.column_name}'), COALESCE((SELECT max(${s.column_name}) FROM ${s.table_schema}.${s.table_name}), 0) + 1, false)`);
		await client.query("COMMIT");
	} catch (error) {
		await client.query("ROLLBACK");
		throw error;
	} finally {
		client.release();
	}
	return { restored, mismatches: await verifyAgainstManifest(pool, manifest) };
}

export async function verifyAgainstManifest(pool: pg.Pool, manifest: BackupManifest): Promise<string[]> {
	const mismatches: string[] = [];
	for (const [table, expected] of Object.entries(manifest.tables)) {
		const actual = await digestTable(pool, table);
		if (actual.rows !== expected.rows || actual.sha256 !== expected.sha256) mismatches.push(`${table}: ${actual.rows} rows ${actual.sha256.slice(0, 12)}, expected ${expected.rows} rows ${expected.sha256.slice(0, 12)}`);
	}
	return mismatches;
}

export const readBackupManifest = (dir: string): BackupManifest => JSON.parse(readFileSync(join(dir, "manifest.json"), "utf8")) as BackupManifest;
void readdirSync;
