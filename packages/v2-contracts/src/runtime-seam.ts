import { z } from "zod";
import { OwnerId, PartitionId, PublicChatId } from "./identity.ts";

export const COMMAND_KINDS = ["user_message", "approval_decision", "task_wake", "trigger_fire", "coding_wake", "compaction_handoff", "abort", "fork", "queue_change", "retry_from"] as const;
export const CommandKind = z.enum(COMMAND_KINDS);
export type CommandKind = z.infer<typeof CommandKind>;

/** What Gate, triggers and Forge put in a partition's command inbox. `commandId` makes a resubmission a no-op. */
export const CommandSubmission = z.object({
	commandId: z.string().min(1),
	ownerId: OwnerId,
	partitionId: PartitionId,
	/** pi-durable's numeric conversation id. */
	conversationId: z.number().int().positive(),
	publicChatId: PublicChatId,
	piRequestId: z.string().min(1),
	kind: CommandKind,
	payload: z.record(z.string(), z.unknown()),
	submittedAt: z.iso.datetime(),
});
export type CommandSubmission = z.infer<typeof CommandSubmission>;

/** A Runner's hold on a partition. A write under an older `epoch` than the stored one must fail, so a stale Runner is fenced. */
export interface PartitionLease {
	readonly partitionId: PartitionId;
	readonly ownerId: OwnerId;
	readonly isHome: boolean;
	/** Increases on every acquisition; PostgreSQL bigint, so a string here. */
	readonly epoch: bigint;
	readonly holderId: string;
	readonly leaseExpiresAt: string;
	readonly activationSeq: bigint;
	/** When the partition next needs a Runner, if anything is scheduled. */
	readonly dueAt: string | null;
}

/** True when a lease is held and unexpired at `now`. */
export function leaseLive(lease: PartitionLease, now: Date): boolean {
	return Date.parse(lease.leaseExpiresAt) > now.getTime();
}

/** True when a writer holding `writerEpoch` may still commit against the stored lease. */
export function epochCurrent(stored: bigint, writerEpoch: bigint): boolean {
	return writerEpoch === stored;
}

/** Written in the same PostgreSQL transaction as `PgPiStorage.commit()`, so what Live shows never runs ahead of what is durable. */
export interface RuntimeOutboxEvent {
	readonly partitionId: PartitionId;
	/** Gapless per partition. */
	readonly commitSeq: bigint;
	readonly projectionVersion: number;
	readonly ownerId: OwnerId;
	readonly publicChatId: PublicChatId;
	readonly conversationId: number;
	readonly eventKind: string;
	readonly payload: Readonly<Record<string, unknown>>;
	readonly committedAt: string;
}

export const EXTERNAL_OPERATION_STATES = ["pending", "running", "completed", "failed", "cancel_requested", "cancelled", "cancel_uncertain", "needs_reconciliation"] as const;
export type ExternalOperationState = (typeof EXTERNAL_OPERATION_STATES)[number];

const TERMINAL: ReadonlySet<ExternalOperationState> = new Set(["completed", "failed", "cancelled"]);

/** Whether an operation has nothing further to do; `cancel_uncertain` and `needs_reconciliation` still need a decision. */
export function operationSettled(state: ExternalOperationState): boolean {
	return TERMINAL.has(state);
}

/** A tool call with effects outside the database, kept so a crash can be reconciled instead of repeated. */
export interface ExternalOperationRecord {
	readonly operationId: string;
	readonly ownerId: OwnerId;
	readonly partitionId: PartitionId;
	readonly taskId: string;
	readonly toolName: string;
	readonly capability: string;
	/** Sent to the external system so a repeat of the call is recognised there. */
	readonly idempotencyKey: string;
	readonly state: ExternalOperationState;
	readonly receipt: Readonly<Record<string, unknown>> | null;
	/** A decision or result that arrived before pi-durable 1.1.0 parked the task; delivered when it parks. */
	readonly earlySignal: Readonly<Record<string, unknown>> | null;
}
