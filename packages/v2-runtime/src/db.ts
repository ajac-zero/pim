import pg from "pg";

/** The Postgres schema every runtime table lives in. */
export const SCHEMA = "pim_runtime";

export type Rows<R> = { rows: R[]; rowCount: number | null };

const tenantOf = new WeakMap<pg.PoolClient, string>();

/**
 * A pool plus the tenant a connection is working for. Row-level security reads `pim.tenant_id`, so each connection is
 * told its tenant before it runs a statement for it: for the whole session on a read, and for one transaction on a
 * commit. A connection remembers which tenant it was last told, so reads in a row for one tenant cost no extra round
 * trip. Session-level settings need session pooling (or direct connections), not a transaction-pooling proxy.
 */
export class Db {
	readonly pool: pg.Pool;
	constructor(pool: pg.Pool) {
		this.pool = pool;
	}

	static connect(options: pg.PoolConfig): Db {
		return new Db(new pg.Pool(options));
	}

	/** One read-only statement for a tenant. */
	async read<R extends pg.QueryResultRow = pg.QueryResultRow>(tenantId: string, text: string, values: unknown[] = []): Promise<Rows<R>> {
		const client = await this.pool.connect();
		let destroy: Error | undefined;
		try {
			if (tenantOf.get(client) !== tenantId) {
				try {
					await client.query("SELECT set_config('pim.tenant_id', $1, false), set_config('pim.scope', '', false)", [tenantId]);
				} catch (error) {
					destroy = error instanceof Error ? error : new Error(String(error));
					throw error;
				}
				tenantOf.set(client, tenantId);
			}
			const result = await client.query<R>(text, values);
			return { rows: result.rows, rowCount: result.rowCount };
		} finally {
			client.release(destroy);
		}
	}

	/** Run `body` in one transaction with `pim.tenant_id` set locally; commits when it returns, rolls back when it throws. */
	async transaction<T>(tenantId: string, body: (client: pg.PoolClient) => Promise<T>, options: { scope?: "all" } = {}): Promise<T> {
		const client = await this.pool.connect();
		let destroy: Error | undefined;
		try {
			await client.query(`BEGIN; ${setLocalSql(client, tenantId, options.scope)}`);
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

/** The statement that scopes one transaction to a tenant (and optionally to every tenant), as literal SQL. */
export function setLocalSql(client: Pick<pg.PoolClient, "escapeLiteral">, tenantId: string, scope?: "all"): string {
	return `SELECT set_config('pim.tenant_id', ${client.escapeLiteral(tenantId)}, true), set_config('pim.scope', ${client.escapeLiteral(scope ?? "")}, true)`;
}
