import { randomUUID } from "node:crypto";
import { IdAllocator } from "../../src/ids.ts";
import { acquireLease, createFamily, provisionTenant } from "../../src/partitions.ts";
import { PgStorage, type PgStorageOptions } from "../../src/storage.ts";
import { withTenant } from "../../src/db.ts";
import type { TestDb } from "./db.ts";

export const newTenant = () => `t${randomUUID().replaceAll("-", "").slice(0, 20)}`;

/** A tenant with a leased family and a storage over it. `home` is the tenant's home family; otherwise a new family. */
export async function openStorage(db: TestDb, options: { tenantId?: string; home?: boolean; ids?: IdAllocator; ownerId?: string; ttlMs?: number; faults?: PgStorageOptions["faults"]; onCommitted?: PgStorageOptions["onCommitted"] } = {}) {
	const tenantId = options.tenantId ?? newTenant();
	const { homePartitionId } = await provisionTenant(db.maint, tenantId);
	const home = options.home ?? true;
	const partitionId = home ? homePartitionId : await withTenant(db.gate, tenantId, (q) => createFamily(q, tenantId));
	const ownerId = options.ownerId ?? `owner-${randomUUID()}`;
	const lease = (await acquireLease(db.runtime, tenantId, partitionId, ownerId, options.ttlMs ?? 60_000))!;
	const ids = options.ids ?? new IdAllocator(db.runtime, 50);
	const storage = new PgStorage({ pool: db.runtime, tenantId, partitionId, ownerId, epoch: lease.epoch, home: lease.home, ids, faults: options.faults, onCommitted: options.onCommitted });
	return { storage, lease, tenantId, partitionId, ids };
}
