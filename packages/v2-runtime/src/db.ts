import { DEFAULT_POOL_BUDGETS, SCHEMAS, type SqlPool, withTenantTransaction } from "@pim/v2-contracts/db";
import { OwnerId } from "@pim/v2-contracts/identity";
import pg from "pg";

/** The Postgres schema every runtime table lives in. */
export const SCHEMA = SCHEMAS.runtime;

export type Rows<R> = { rows: R[]; rowCount: number | null };

const guarded = new WeakSet<pg.PoolClient>();

/** Pool settings from the runtime budget in `@pim/v2-contracts`: its size, idle timeout and statement timeout. */
export function runtimePoolConfig(connectionString: string): pg.PoolConfig {
	const budget = DEFAULT_POOL_BUDGETS.runtime;
	return { connectionString, max: budget.max, idleTimeoutMillis: budget.idleTimeoutMs, statement_timeout: budget.statementTimeoutMs };
}

/**
 * A pool plus the owner a transaction works for. Row-level security reads `pim.owner_id` (`pim_current_owner_id()`),
 * which is set with SET LOCAL semantics inside each transaction, so nothing is left on a connection a transaction-pooling
 * proxy hands to another client. A read is a one-statement transaction.
 */
export class Db {
	readonly pool: pg.Pool;
	constructor(pool: pg.Pool) {
		this.pool = pool;
		// An idle connection that drops is replaced by the pool; without a listener its error would end the process.
		pool.on("error", () => {});
	}

	static connect(options: pg.PoolConfig): Db {
		return new Db(new pg.Pool(options));
	}

	/**
	 * A connection from the pool. A connection that fails while a query is in flight reports the failure to that query;
	 * the extra error event it also emits is absorbed here, so it cannot become an uncaught exception.
	 */
	async checkout(): Promise<pg.PoolClient> {
		const client = await this.pool.connect();
		if (!guarded.has(client)) {
			guarded.add(client);
			client.on("error", () => {});
		}
		return client;
	}

	/** One statement for an owner, in its own transaction. */
	async read<R extends pg.QueryResultRow = pg.QueryResultRow>(ownerId: string, text: string, values: unknown[] = []): Promise<Rows<R>> {
		return this.transaction(ownerId, async (client) => {
			const result = await client.query<R>(text, values);
			return { rows: result.rows, rowCount: result.rowCount };
		});
	}

	/** The pool as the contracts' `SqlPool`, for code that takes that interface. */
	get sqlPool(): SqlPool {
		return { transaction: (fn) => this.#transaction((client) => fn(client)) };
	}

	/** Run `body` in one transaction scoped to `ownerId`; commits when it returns, rolls back when it throws. */
	async transaction<T>(ownerId: string, body: (client: pg.PoolClient) => Promise<T>, options: { scope?: "all" } = {}): Promise<T> {
		if (options.scope === "all") {
			return this.#transaction(async (client) => {
				await client.query("SELECT set_config('pim.scope', 'all', true)");
				return body(client);
			});
		}
		return withTenantTransaction(this.sqlPool, OwnerId.parse(ownerId), (client) => body(client as pg.PoolClient));
	}

	async #transaction<T>(body: (client: pg.PoolClient) => Promise<T>): Promise<T> {
		const client = await this.checkout();
		let destroy: Error | undefined;
		try {
			await client.query("BEGIN");
			const result = await body(client);
			await client.query("COMMIT");
			return result;
		} catch (error) {
			try {
				await client.query("ROLLBACK");
			} catch (rollback) {
				destroy = rollback instanceof Error ? rollback : new Error(String(rollback));
			}
			throw error;
		} finally {
			client.release(destroy);
		}
	}

	async close(): Promise<void> {
		await this.pool.end();
	}
}

/** The statement that scopes one transaction to a owner (and optionally to every owner), as literal SQL. */
export function setLocalSql(client: Pick<pg.PoolClient, "escapeLiteral">, ownerId: string, scope?: "all"): string {
	return `SELECT set_config('pim.owner_id', ${client.escapeLiteral(ownerId)}, true), set_config('pim.scope', ${client.escapeLiteral(scope ?? "")}, true)`;
}
