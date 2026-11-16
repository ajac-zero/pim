import { StorageRejected } from "@earendil-works/pi-durable";

/**
 * This owner no longer holds the partition: another Runner took a higher epoch, or the lease ran out. It is a
 * StorageRejected because it is thrown before the commit transaction changes anything, which is the guarantee pi
 * reads from that class.
 */
export class OwnershipLost extends StorageRejected {
	readonly partitionId: string;
	readonly epoch: number;
	constructor(partitionId: string, epoch: number, message: string, options?: { cause?: unknown }) {
		super(`Ownership of partition ${partitionId} at epoch ${epoch} was lost: ${message}`, options);
		this.name = "OwnershipLost";
		this.partitionId = partitionId;
		this.epoch = epoch;
	}
}

/**
 * COMMIT was sent and its outcome is unknown: the connection failed before the acknowledgement. This is not a
 * StorageRejected, so pi poisons the Session; `reconcileAmbiguousCommit` says afterwards whether the batch landed.
 */
export class AmbiguousCommit extends Error {
	readonly batchId: string;
	readonly backendPid: number | undefined;
	constructor(batchId: string, backendPid: number | undefined, options?: { cause?: unknown }) {
		super(`The outcome of commit batch ${batchId} is unknown: the connection failed while COMMIT was in flight`, options);
		this.name = "AmbiguousCommit";
		this.batchId = batchId;
		this.backendPid = backendPid;
	}
}
