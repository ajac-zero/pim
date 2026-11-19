import { OwnerId } from "@pim/v2-contracts/identity";
import { type SqlClient, type SqlPool, withTenantTransaction } from "@pim/v2-contracts/db";
import pg from "pg";

/**
 * The only way application code reaches PostgreSQL. Every call is one transaction that sets the tenant with `set_config(..., true)`
 * (the contracts' `withTenantTransaction`), so the setting dies with the transaction and a pooled connection, including one behind
 * PgBouncer's transaction pooling, never carries one tenant's identity into the next request.
 */
export type Tx = pg.PoolClient;

export class Db {
	constructor(readonly pool: pg.Pool) {
		// An idle connection that drops is replaced by the pool; without a listener its error would end the process.
		pool.on("error", () => {});
	}

	#transaction: SqlPool["transaction"] = async (fn) => {
		const client = await this.pool.connect();
		try {
			await client.query("BEGIN");
			const result = await fn(client as unknown as SqlClient);
			await client.query("COMMIT");
			return result;
		} catch (error) {
			await client.query("ROLLBACK").catch(() => undefined);
			throw error;
		} finally {
			client.release();
		}
	};

	/** Runs `fn` as `ownerId`: row-level security shows it that owner's rows alone. `lookup` also names one secret key, for a row another owner holds that this call must reach (an invite being spent). */
	owner<T>(ownerId: string, fn: (tx: Tx) => Promise<T>, lookup = ""): Promise<T> {
		return withTenantTransaction({ transaction: this.#transaction }, OwnerId.parse(ownerId), async (client) => {
			await client.query("SELECT set_config('pim.lookup', $1, true)", [lookup]);
			return fn(client as unknown as Tx);
		});
	}

	/** Runs `fn` with no owner but one secret lookup key (a token hash, a credential id): it can see the single row that key names. */
	lookup<T>(key: string, fn: (tx: Tx) => Promise<T>): Promise<T> {
		if (!key) throw new Error("A lookup key is required");
		return this.#run(key, fn);
	}

	/** Runs `fn` with no tenant at all: only instance-level tables and public rows answer. */
	anonymous<T>(fn: (tx: Tx) => Promise<T>): Promise<T> {
		return this.#run("", fn);
	}

	#run<T>(lookup: string, fn: (tx: Tx) => Promise<T>): Promise<T> {
		return this.#transaction(async (client) => {
			await client.query("SELECT set_config('pim.owner_id', '', true), set_config('pim.lookup', $1, true)", [lookup]);
			return fn(client as unknown as Tx);
		});
	}

	end(): Promise<void> {
		return this.pool.end();
	}
}

/** A pool for the `pim_gate` login. It must not be a superuser or have BYPASSRLS, which would turn row security off. */
export function connect(connectionString: string, max = 10, statementTimeoutMs = 10_000): Db {
	return new Db(new pg.Pool({ connectionString, max, statement_timeout: statementTimeoutMs }));
}
