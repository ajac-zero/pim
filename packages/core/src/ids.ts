import type pg from "pg";
import { withTenant } from "./db.ts";

/**
 * Hands out pi ids from one tenant-wide sequence in leased blocks, so no lock is held per minted id and
 * ids stay unique across a tenant's families. A crash loses the rest of a block: gaps are allowed by pi's contract.
 */
export class IdAllocator {
	readonly #blocks = new Map<string, { next: number; end: number }>();
	readonly #pending = new Map<string, Promise<void>>();

	constructor(
		private readonly pool: pg.Pool,
		private readonly blockSize = 1000,
	) {}

	async next(tenantId: string): Promise<number> {
		for (;;) {
			const block = this.#blocks.get(tenantId);
			if (block !== undefined && block.next < block.end) return block.next++;
			// One lease at a time per tenant; concurrent callers wait for it and then draw from the new block.
			let pending = this.#pending.get(tenantId);
			if (pending === undefined) {
				pending = this.#lease(tenantId).finally(() => this.#pending.delete(tenantId));
				this.#pending.set(tenantId, pending);
			}
			await pending;
		}
	}

	/** A commit wrote ids up to `maxId`: a cached block that reaches them is dropped, so the next id comes from after them. */
	observe(tenantId: string, maxId: number): void {
		const block = this.#blocks.get(tenantId);
		if (block !== undefined && maxId >= block.next) this.#blocks.delete(tenantId);
	}

	async #lease(tenantId: string): Promise<void> {
		const block = await withTenant(this.pool, tenantId, async (q) => {
			const row = await q.get<{ next_id: number; exhausted: boolean }>("SELECT LEAST(next_id, 9007199254740991) AS next_id, next_id > 9007199254740991 AS exhausted FROM rt.tenant_ids WHERE tenant_id = $1 FOR UPDATE", tenantId);
			if (row === undefined) throw new Error(`Tenant ${tenantId} has no id sequence`);
			if (row.exhausted) throw new Error("ID space is exhausted");
			// next_id may reach 2^53, one past the last safe integer, and no further.
			const end = Math.min(row.next_id + this.blockSize, Number.MAX_SAFE_INTEGER + 1);
			await q.run("UPDATE rt.tenant_ids SET next_id = $2 WHERE tenant_id = $1", tenantId, end);
			return { next: row.next_id, end };
		});
		this.#blocks.set(tenantId, block);
	}
}
