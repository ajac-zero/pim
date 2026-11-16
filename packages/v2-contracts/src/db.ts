import { OwnerId } from "./identity.ts";

/** The PostgreSQL schemas, one per workstream; a workstream writes only its own. */
export const SCHEMAS = { app: "pim_app", runtime: "pim_runtime", forge: "pim_forge", projection: "pim_projection" } as const;

export type MigrationOwner = "foundation" | "runtime" | "application" | "live" | "forge" | "operations";

/** The inclusive range of migration numbers each workstream owns. `0001_foundation.sql` is canonical's alone. */
export const MIGRATION_BANDS: Readonly<Record<MigrationOwner, readonly [number, number]>> = {
	foundation: [1, 99],
	runtime: [100, 199],
	application: [200, 299],
	live: [300, 399],
	forge: [400, 499],
	operations: [500, 599],
};

/** The schema each band's migrations create tables in; foundation creates all of them, and operations only maintains. */
export const BAND_SCHEMAS: Readonly<Partial<Record<MigrationOwner, string>>> = {
	runtime: SCHEMAS.runtime,
	application: SCHEMAS.app,
	live: SCHEMAS.projection,
	forge: SCHEMAS.forge,
};

const FILE = /^(\d{4})_([a-z0-9][a-z0-9_]*)\.sql$/;

/** The number and name in a migration's file name, or null when it isn't `NNNN_name.sql`. */
export function parseMigrationFile(file: string): { number: number; name: string } | null {
	const match = FILE.exec(file);
	return match ? { number: Number(match[1]), name: match[2]! } : null;
}

export function migrationOwner(number: number): MigrationOwner | null {
	for (const [owner, [low, high]] of Object.entries(MIGRATION_BANDS) as [MigrationOwner, readonly [number, number]][]) {
		if (number >= low && number <= high) return owner;
	}
	return null;
}

/** The problems with a workstream's migration file names: a bad name, a number outside its band, or a duplicate number. */
export function validateMigrationFiles(owner: MigrationOwner, files: readonly string[]): string[] {
	const [low, high] = MIGRATION_BANDS[owner];
	const problems: string[] = [];
	const seen = new Set<number>();
	for (const file of files) {
		const parsed = parseMigrationFile(file);
		if (!parsed) problems.push(`${file}: not NNNN_name.sql`);
		else if (parsed.number < low || parsed.number > high) problems.push(`${file}: ${parsed.number} is outside ${owner}'s band ${low}-${high}`);
		else if (seen.has(parsed.number)) problems.push(`${file}: number ${parsed.number} is used twice`);
		else seen.add(parsed.number);
	}
	return problems;
}

/** The pools a process opens, each bounded so one kind of work cannot starve the rest. */
export const POOL_NAMES = ["foreground", "runtime", "tools", "forge", "maintenance"] as const;
export type PoolName = (typeof POOL_NAMES)[number];

export interface PoolBudget {
	readonly max: number;
	readonly idleTimeoutMs: number;
	readonly statementTimeoutMs: number;
}

export type PoolBudgets = Readonly<Record<PoolName, PoolBudget>>;

export const DEFAULT_POOL_BUDGETS: PoolBudgets = {
	foreground: { max: 20, idleTimeoutMs: 30_000, statementTimeoutMs: 10_000 },
	runtime: { max: 20, idleTimeoutMs: 30_000, statementTimeoutMs: 30_000 },
	tools: { max: 10, idleTimeoutMs: 30_000, statementTimeoutMs: 60_000 },
	forge: { max: 10, idleTimeoutMs: 30_000, statementTimeoutMs: 30_000 },
	maintenance: { max: 4, idleTimeoutMs: 10_000, statementTimeoutMs: 600_000 },
};

/** The smallest client a transaction needs; `pg`'s `PoolClient` satisfies it. */
export interface SqlClient {
	query(text: string, values?: readonly unknown[]): Promise<{ rows: unknown[] }>;
}

export interface SqlPool {
	/** Runs `fn` on one connection inside BEGIN/COMMIT, rolling back when it throws. */
	transaction<T>(fn: (client: SqlClient) => Promise<T>): Promise<T>;
}

/**
 * Runs `fn` in a transaction whose rows are those of `ownerId`. The owner is set with `set_config(..., true)`,
 * which is `SET LOCAL`: it ends with the transaction, so a connection PgBouncer hands to another client in
 * transaction mode never carries it. `SET LOCAL` itself takes no parameters, hence `set_config`.
 */
export async function withTenantTransaction<T>(pool: SqlPool, ownerId: string, fn: (client: SqlClient) => Promise<T>): Promise<T> {
	const owner = OwnerId.parse(ownerId);
	return pool.transaction(async (client) => {
		await client.query("SELECT set_config('pim.owner_id', $1, true)", [owner]);
		return fn(client);
	});
}
