import { OwnerId } from "@pim/v2-contracts/identity";
import type { Pool, PoolClient } from "pg";

/**
 * Runs `fn` in a transaction whose rows are those of `ownerId`: the owner is set with `set_config(..., true)`
 * (`SET LOCAL`), exactly as `withTenantTransaction` in @pim/v2-contracts does, so the row-level security
 * policies on `pim_projection` match this owner's rows and no one else's. `snapshot` makes it a read-only,
 * repeatable-read transaction, so several reads see one moment; that has to be chosen before the first statement,
 * which is why this isn't `withTenantTransaction`.
 */
export async function withOwner<T>(pool: Pool, ownerId: string, fn: (client: PoolClient) => Promise<T>, options: { snapshot?: boolean } = {}): Promise<T> {
	const owner = OwnerId.parse(ownerId);
	const client = await pool.connect();
	try {
		await client.query(options.snapshot ? "BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY" : "BEGIN");
		await client.query("SELECT set_config('pim.owner_id', $1, true)", [owner]);
		const result = await fn(client);
		await client.query("COMMIT");
		return result;
	} catch (error) {
		await client.query("ROLLBACK").catch(() => {});
		throw error;
	} finally {
		client.release();
	}
}
