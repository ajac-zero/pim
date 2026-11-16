import { createHash } from "node:crypto";
import { OwnerId } from "@pim/v2-contracts/identity";

/**
 * The owner id a legacy account has in v2. v2 owner ids are `o_<chars>` (OwnerId in @pim/v2-contracts); a legacy id that already has that shape
 * is kept, any other id made of letters, digits, `_` and `-` gets the `o_` prefix. Anything else is refused rather than guessed at.
 * The mapping is recorded in pim_ops.owner_map by the import.
 */
export function ownerIdOf(legacyId: string): string {
	const candidate = /^o_[A-Za-z0-9_-]+$/.test(legacyId) ? legacyId : `o_${legacyId}`;
	return OwnerId.parse(candidate);
}

const NAMESPACE = Buffer.from("pim-v2-partition-ids-0001");

/** A stable UUID (version 5 layout) for one of an owner's partitions, so a re-import gives the same PartitionId. `label` is "home" or the family's lowest conversation id. */
export function partitionUuid(owner: string, label: string): string {
	const hash = createHash("sha1").update(NAMESPACE).update(`${owner}\u0000${label}`).digest();
	hash[6] = (hash[6]! & 0x0f) | 0x50;
	hash[8] = (hash[8]! & 0x3f) | 0x80;
	const hex = hash.subarray(0, 16).toString("hex");
	return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}
