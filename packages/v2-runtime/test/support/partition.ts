import { randomUUID } from "node:crypto";
import type { Db } from "../../src/db.ts";
import { PartitionDirectory } from "../../src/directory.ts";
import { type Lease, Steward, type StewardOptions } from "../../src/ownership.ts";
import { PgPiStorage, type PgPiStorageOptions } from "../../src/storage.ts";

export const uniqueTenant = (): string => `t_${randomUUID().replaceAll("-", "").slice(0, 12)}`;

export type TestPartition = { tenantId: string; partitionId: string; steward: Steward; lease: Lease; storage: PgPiStorage };

/** A tenant with one partition, leased by a fresh steward, and a storage open for that owner. */
export async function openTestPartition(
	db: Db,
	options: { tenantId?: string; kind?: "home" | "family"; steward?: Partial<StewardOptions>; storage?: Partial<PgPiStorageOptions>; partitionId?: string } = {},
): Promise<TestPartition> {
	const tenantId = options.tenantId ?? uniqueTenant();
	const directory = new PartitionDirectory(db);
	const partitionId = await directory.createPartition(tenantId, { kind: options.kind ?? "home", ...(options.partitionId === undefined ? {} : { partitionId: options.partitionId }) });
	const steward = new Steward({ db, ownerId: `owner-${randomUUID().slice(0, 8)}`, leaseTtlMs: 30_000, ...options.steward });
	const lease = await steward.acquire(tenantId, partitionId);
	if (lease === undefined) throw new Error("could not lease the test partition");
	const storage = await PgPiStorage.openForOwner({ db, fence: lease, ...options.storage });
	return { tenantId, partitionId, steward, lease, storage };
}
