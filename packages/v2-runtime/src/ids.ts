import type { Id } from "@earendil-works/pi-durable";
import { type Db, SCHEMA } from "./db.ts";

const S = SCHEMA;
export const MAX_SAFE_ID = Number.MAX_SAFE_INTEGER;
export const DEFAULT_BLOCK_SIZE = 256;

/** The block of ids a partition's owner holds, [next, last]. */
export type IdBlock = { first: number; last: number };

/** Lease `size` ids from the tenant's sequence. Ids a holder does not use are gaps; they are never reissued. */
export async function leaseIdBlock(db: Db, tenantId: string, size: number, holder?: { partitionId: string; epoch: number }): Promise<IdBlock> {
	if (!Number.isSafeInteger(size) || size < 1) throw new RangeError("An id block needs a positive size");
	return db.transaction(tenantId, async (client) => {
		await client.query(`INSERT INTO ${S}.tenant_id_allocators (tenant_id) VALUES ($1) ON CONFLICT DO NOTHING`, [tenantId]);
		const row = (
			await client.query<{ first: string; last: string }>(
				`WITH old AS (SELECT high_water FROM ${S}.tenant_id_allocators WHERE tenant_id = $1 FOR UPDATE)
				 UPDATE ${S}.tenant_id_allocators a SET high_water = a.high_water + least($2::bigint, ${MAX_SAFE_ID} - a.high_water)
				 FROM old WHERE a.tenant_id = $1 RETURNING old.high_water + 1 AS first, a.high_water AS last`,
				[tenantId, size],
			)
		).rows[0];
		const block = { first: Number(row?.first), last: Number(row?.last) };
		if (!Number.isSafeInteger(block.first) || !Number.isSafeInteger(block.last) || block.first > block.last) throw new Error("ID space is exhausted");
		await client.query(`INSERT INTO ${S}.id_blocks (tenant_id, first_id, last_id, partition_id, owner_epoch) VALUES ($1, $2, $3, $4, $5)`, [
			tenantId,
			block.first,
			block.last,
			holder?.partitionId ?? null,
			holder?.epoch ?? null,
		]);
		return block;
	});
}

/** Raise the tenant's high-water mark to at least `max`, as an import does so later ids never collide with imported ones. */
export async function seedIdHighWater(db: Db, tenantId: string, max: number): Promise<void> {
	if (!Number.isSafeInteger(max) || max < 1) throw new RangeError("The high-water mark must be a safe positive integer");
	await db.transaction(tenantId, async (client) => {
		await client.query(
			`INSERT INTO ${SCHEMA}.tenant_id_allocators AS a (tenant_id, high_water) VALUES ($1, $2)
			 ON CONFLICT (tenant_id) DO UPDATE SET high_water = greatest(a.high_water, $2)`,
			[tenantId, max],
		);
	});
}

/**
 * Mints ids from a block, leasing a new one when it runs out. Active token streams in different partitions draw from
 * their own blocks, so minting touches the shared allocator row once per `size` ids, not once per id. An allocator is
 * dropped when its storage closes: the next owner leases a fresh, higher block, which keeps ids increasing per partition.
 */
export class IdAllocator {
	readonly #db: Db;
	readonly #tenantId: string;
	readonly #size: number;
	readonly #holder: () => { partitionId: string; epoch: number } | undefined;
	#block: IdBlock | undefined;
	#next = 0;
	#leasing: Promise<void> | undefined;
	#ceiling = 0;

	constructor(db: Db, tenantId: string, holder: () => { partitionId: string; epoch: number } | undefined, size = DEFAULT_BLOCK_SIZE) {
		this.#db = db;
		this.#tenantId = tenantId;
		this.#holder = holder;
		this.#size = size;
	}

	/** Start from the tenant's current high-water mark: every id already committed is at or below it. */
	startAt(highWater: number): void {
		this.#ceiling = Math.max(this.#ceiling, highWater);
	}

	/** The largest id this allocator knows the tenant sequence has already passed. */
	get ceiling(): number {
		return this.#ceiling;
	}

	/**
	 * Ids at or above the tenant's high-water mark were committed from outside this allocator's blocks (an import, or a
	 * caller's explicit id). Raise the mark past them, and drop the local block so the next id is minted above them.
	 */
	async observe(max: number): Promise<void> {
		if (max <= this.#ceiling) return;
		await seedIdHighWater(this.#db, this.#tenantId, max);
		this.#ceiling = max;
		this.#block = undefined;
	}

	async mint<I extends Id<string>>(): Promise<I> {
		for (;;) {
			const block = this.#block;
			if (block !== undefined && this.#next <= block.last) return this.#next++ as I;
			this.#leasing ??= leaseIdBlock(this.#db, this.#tenantId, this.#size, this.#holder())
				.then((leased) => {
					this.#block = leased;
					this.#next = leased.first;
					this.#ceiling = Math.max(this.#ceiling, leased.last);
				})
				.finally(() => {
					this.#leasing = undefined;
				});
			await this.#leasing;
		}
	}
}
