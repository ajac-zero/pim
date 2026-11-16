import type { Id } from "@earendil-works/pi-durable";
import { type Db, SCHEMA } from "./db.ts";

const S = SCHEMA;
export const MAX_SAFE_ID = Number.MAX_SAFE_INTEGER;
export const DEFAULT_BLOCK_SIZE = 256;

/** The block of ids a partition's owner holds, [next, last]. */
export type IdBlock = { first: number; last: number };

/** Lease `size` ids from the owner's sequence. Ids a holder does not use are gaps; they are never reissued. */
export async function leaseIdBlock(db: Db, ownerId: string, size: number, holder?: { partitionId: string; epoch: bigint }): Promise<IdBlock> {
	if (!Number.isSafeInteger(size) || size < 1) throw new RangeError("An id block needs a positive size");
	return db.transaction(ownerId, async (client) => {
		await client.query(`INSERT INTO ${S}.owner_id_allocators (owner_id) VALUES ($1) ON CONFLICT DO NOTHING`, [ownerId]);
		const row = (
			await client.query<{ first: string; last: string }>(
				`WITH old AS (SELECT high_water FROM ${S}.owner_id_allocators WHERE owner_id = $1 FOR UPDATE)
				 UPDATE ${S}.owner_id_allocators a SET high_water = a.high_water + least($2::bigint, ${MAX_SAFE_ID} - a.high_water)
				 FROM old WHERE a.owner_id = $1 RETURNING old.high_water + 1 AS first, a.high_water AS last`,
				[ownerId, size],
			)
		).rows[0];
		const block = { first: Number(row?.first), last: Number(row?.last) };
		if (!Number.isSafeInteger(block.first) || !Number.isSafeInteger(block.last) || block.first > block.last) throw new Error("ID space is exhausted");
		await client.query(`INSERT INTO ${S}.id_blocks (owner_id, first_id, last_id, partition_id, epoch) VALUES ($1, $2, $3, $4, $5)`, [
			ownerId,
			block.first,
			block.last,
			holder?.partitionId ?? null,
			holder?.epoch ?? null,
		]);
		return block;
	});
}

/** Raise the owner's high-water mark to at least `max`, as an import does so later ids never collide with imported ones. */
export async function seedIdHighWater(db: Db, ownerId: string, max: number): Promise<void> {
	if (!Number.isSafeInteger(max) || max < 1) throw new RangeError("The high-water mark must be a safe positive integer");
	await db.transaction(ownerId, async (client) => {
		await client.query(
			`INSERT INTO ${SCHEMA}.owner_id_allocators AS a (owner_id, high_water) VALUES ($1, $2)
			 ON CONFLICT (owner_id) DO UPDATE SET high_water = greatest(a.high_water, $2)`,
			[ownerId, max],
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
	readonly #ownerId: string;
	readonly #size: number;
	readonly #holder: () => { partitionId: string; epoch: bigint } | undefined;
	#block: IdBlock | undefined;
	#next = 0;
	#leasing: Promise<void> | undefined;
	#ceiling = 0;

	constructor(db: Db, ownerId: string, holder: () => { partitionId: string; epoch: bigint } | undefined, size = DEFAULT_BLOCK_SIZE) {
		this.#db = db;
		this.#ownerId = ownerId;
		this.#holder = holder;
		this.#size = size;
	}

	/** Start from the owner's current high-water mark: every id already committed is at or below it. */
	startAt(highWater: number): void {
		this.#ceiling = Math.max(this.#ceiling, highWater);
	}

	/** The largest id this allocator knows the owner sequence has already passed. */
	get ceiling(): number {
		return this.#ceiling;
	}

	/**
	 * Ids at or above the owner's high-water mark were committed from outside this allocator's blocks (an import, or a
	 * caller's explicit id). Raise the mark past them, and drop the local block so the next id is minted above them.
	 */
	async observe(max: number): Promise<void> {
		if (max <= this.#ceiling) return;
		await seedIdHighWater(this.#db, this.#ownerId, max);
		this.#ceiling = max;
		this.#block = undefined;
	}

	async mint<I extends Id<string>>(): Promise<I> {
		for (;;) {
			const block = this.#block;
			if (block !== undefined && this.#next <= block.last) return this.#next++ as I;
			this.#leasing ??= leaseIdBlock(this.#db, this.#ownerId, this.#size, this.#holder())
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
