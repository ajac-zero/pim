import pg from "pg";

/**
 * The only way application code reaches PostgreSQL. Every call is one transaction that sets the tenant with `set_config(..., true)`
 * (transaction-local), so the setting dies with the transaction and a pooled connection, including one behind PgBouncer's
 * transaction pooling, never carries one tenant's identity into the next request.
 */
export type Tx = pg.PoolClient;

export class Db {
	constructor(readonly pool: pg.Pool) {}

	/** Runs `fn` as `ownerId`: row-level security shows it that owner's rows alone. */
	owner<T>(ownerId: string, fn: (tx: Tx) => Promise<T>, lookup = ""): Promise<T> {
		if (!ownerId) throw new Error("An owner id is required");
		return this.#run(ownerId, lookup, fn);
	}

	/** Runs `fn` with no owner but one secret lookup key (a token hash, a credential id): it can see the single row that key names. */
	lookup<T>(key: string, fn: (tx: Tx) => Promise<T>): Promise<T> {
		if (!key) throw new Error("A lookup key is required");
		return this.#run("", key, fn);
	}

	/** Runs `fn` with no tenant at all: only instance-level tables and public rows answer. */
	anonymous<T>(fn: (tx: Tx) => Promise<T>): Promise<T> {
		return this.#run("", "", fn);
	}

	async #run<T>(owner: string, lookup: string, fn: (tx: Tx) => Promise<T>): Promise<T> {
		const client = await this.pool.connect();
		try {
			await client.query("BEGIN");
			await client.query("SELECT set_config('pim.owner_id', $1, true), set_config('pim.lookup', $2, true)", [owner, lookup]);
			const result = await fn(client);
			await client.query("COMMIT");
			return result;
		} catch (error) {
			await client.query("ROLLBACK").catch(() => undefined);
			throw error;
		} finally {
			client.release();
		}
	}

	end(): Promise<void> {
		return this.pool.end();
	}
}

/** A pool for the application role. It must not be a superuser or have BYPASSRLS, which would turn row security off. */
export function connect(connectionString: string, max = 10): Db {
	return new Db(new pg.Pool({ connectionString, max }));
}
