import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import pg from "pg";

/** pi ids and sequences are JavaScript safe integers, so bigint columns come back as numbers, and a value outside that range is an error. */
const parseInt8 = (value: string): number => {
	const parsed = Number(value);
	if (!Number.isSafeInteger(parsed)) throw new RangeError(`bigint ${value} is outside the safe integer range`);
	return parsed;
};

export const types = { getTypeParser: (oid: number, format?: "text" | "binary") => (oid === 20 ? parseInt8 : pg.types.getTypeParser(oid, format as "text")) } as pg.CustomTypesConfig;

/** A tenant id is a short token; it is passed to set_config as a bound parameter. */
export const TENANT_ID = /^[A-Za-z0-9_-]{1,64}$/;

export type Row = Record<string, any>;

/** What a transaction offers its callback: positional parameters, rows back. */
export interface Q {
	all<R extends Row = Row>(sql: string, ...params: unknown[]): Promise<R[]>;
	get<R extends Row = Row>(sql: string, ...params: unknown[]): Promise<R | undefined>;
	/** Rows affected. */
	run(sql: string, ...params: unknown[]): Promise<number>;
	readonly client: pg.PoolClient;
}

export function createPool(options: { connectionString: string; max?: number; applicationName?: string; statementTimeoutMs?: number; onError?: (error: Error) => void }): pg.Pool {
	// An idle connection the server dropped (failover, restart) emits here; without a listener it would crash the process.
	const pool = new pg.Pool({
		connectionString: options.connectionString,
		max: options.max ?? 10,
		application_name: options.applicationName ?? "pim",
		statement_timeout: options.statementTimeoutMs ?? 30_000,
		idleTimeoutMillis: 30_000,
		types,
	});
	pool.on("error", (error) => options.onError?.(error));
	return pool;
}

export function wrap(client: pg.PoolClient): Q {
	return {
		client,
		async all(sql, ...params) {
			return (await client.query(sql, params as unknown[])).rows;
		},
		async get(sql, ...params) {
			return (await client.query(sql, params as unknown[])).rows[0];
		},
		async run(sql, ...params) {
			return (await client.query(sql, params as unknown[])).rowCount ?? 0;
		},
	};
}

export interface TxOptions {
	readOnly?: boolean;
	statementTimeoutMs?: number;
}

/**
 * Runs `fn` in one transaction with `pim.tenant_id` set for that transaction only (`set_config(..., true)`), so a
 * pooled connection carries no tenant between uses and the context survives PgBouncer in transaction mode.
 * Pass `null` for the cross-tenant roles (steward, maint), which see rows by policy, not by tenant.
 */
export async function withTenant<T>(pool: pg.Pool, tenantId: string | null, fn: (q: Q) => Promise<T>, options: TxOptions = {}): Promise<T> {
	if (tenantId !== null && !TENANT_ID.test(tenantId)) throw new TypeError("Invalid tenant id");
	const client = await pool.connect();
	const ignore = () => undefined;
	client.on("error", ignore);
	let broken = false;
	try {
		await client.query(`BEGIN${options.readOnly ? " READ ONLY" : ""}`);
		await client.query("SELECT set_config('pim.tenant_id', $1, true)", [tenantId ?? ""]);
		if (options.statementTimeoutMs) await client.query(`SET LOCAL statement_timeout = ${Math.trunc(options.statementTimeoutMs)}`);
		const result = await fn(wrap(client));
		await client.query("COMMIT");
		return result;
	} catch (error) {
		try {
			await client.query("ROLLBACK");
		} catch {
			broken = true;
		}
		throw error;
	} finally {
		client.off("error", ignore);
		client.release(broken ? true : undefined);
	}
}

/** Applies every `migrations/*.sql` once, in order, in one transaction each, recorded in `public.pim_migrations`. Run as the owning role. */
export async function migrate(pool: pg.Pool, dir = join(import.meta.dirname, "../migrations")): Promise<string[]> {
	const files = readdirSync(dir).filter((file) => file.endsWith(".sql")).sort();
	const client = await pool.connect();
	const applied: string[] = [];
	try {
		await client.query("CREATE TABLE IF NOT EXISTS public.pim_migrations (name text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())");
		// One migrator at a time across processes.
		await client.query("SELECT pg_advisory_lock(7040001)");
		try {
			const done = new Set((await client.query("SELECT name FROM public.pim_migrations")).rows.map((row) => row.name as string));
			for (const file of files) {
				if (done.has(file)) continue;
				await client.query("BEGIN");
				try {
					await client.query(readFileSync(join(dir, file), "utf8"));
					await client.query("INSERT INTO public.pim_migrations (name) VALUES ($1)", [file]);
					await client.query("COMMIT");
				} catch (error) {
					await client.query("ROLLBACK");
					throw new Error(`Migration ${file} failed: ${(error as Error).message}`, { cause: error });
				}
				applied.push(file);
			}
		} finally {
			await client.query("SELECT pg_advisory_unlock(7040001)");
		}
	} finally {
		client.release();
	}
	return applied;
}

/** The durability settings a deployment declares: refuse to run with fewer guarantees than configured. */
export interface DurabilityRequirement {
	fsync?: boolean;
	fullPageWrites?: boolean;
	/** The weakest acceptable synchronous_commit, as PostgreSQL names it. */
	synchronousCommit?: "on" | "remote_write" | "remote_apply" | "local";
}

const COMMIT_STRENGTH: Record<string, number> = { off: 0, local: 1, remote_write: 2, on: 3, remote_apply: 4 };

export async function checkDurability(pool: pg.Pool, required: DurabilityRequirement): Promise<{ ok: boolean; observed: Record<string, string>; problems: string[] }> {
	const rows = (await pool.query("SELECT name, setting FROM pg_settings WHERE name IN ('fsync', 'full_page_writes', 'synchronous_commit', 'synchronous_standby_names')")).rows as { name: string; setting: string }[];
	const observed = Object.fromEntries(rows.map((row) => [row.name, row.setting]));
	const problems: string[] = [];
	if (required.fsync !== false && observed.fsync !== "on") problems.push("fsync is off");
	if (required.fullPageWrites !== false && observed.full_page_writes !== "on") problems.push("full_page_writes is off");
	const want = required.synchronousCommit ?? "on";
	if ((COMMIT_STRENGTH[observed.synchronous_commit ?? "off"] ?? 0) < (COMMIT_STRENGTH[want] ?? 3)) problems.push(`synchronous_commit is ${observed.synchronous_commit}, below ${want}`);
	return { ok: problems.length === 0, observed, problems };
}
