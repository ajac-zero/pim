import { EXTERNAL_OPERATION_STATES, type ExternalOperationRecord, type ExternalOperationState, operationSettled } from "@pim/v2-contracts/runtime-seam";
import { OwnerId, PartitionId } from "@pim/v2-contracts/identity";
import { type Db, SCHEMA } from "./db.ts";
import { activate } from "./signals.ts";

const S = SCHEMA;

/** The states an operation may move to from each state. A settled operation moves nowhere. */
const NEXT: Readonly<Record<ExternalOperationState, readonly ExternalOperationState[]>> = {
	pending: ["running", "failed", "cancel_requested", "cancelled", "needs_reconciliation"],
	running: ["completed", "failed", "cancel_requested", "needs_reconciliation"],
	cancel_requested: ["cancelled", "cancel_uncertain", "completed", "failed"],
	cancel_uncertain: ["needs_reconciliation", "cancelled", "completed", "failed"],
	needs_reconciliation: ["running", "completed", "failed", "cancelled"],
	completed: [],
	failed: [],
	cancelled: [],
};

type Row = {
	operation_id: string;
	owner_id: string;
	partition_id: string;
	task_id: string;
	tool_name: string;
	capability: string;
	idempotency_key: string;
	state: ExternalOperationState;
	receipt: Record<string, unknown> | null;
	early_signal: Record<string, unknown> | null;
};

const toRecord = (row: Row): ExternalOperationRecord => ({
	operationId: row.operation_id,
	ownerId: OwnerId.parse(row.owner_id),
	partitionId: PartitionId.parse(row.partition_id),
	taskId: row.task_id,
	toolName: row.tool_name,
	capability: row.capability,
	idempotencyKey: row.idempotency_key,
	state: row.state,
	receipt: row.receipt,
	earlySignal: row.early_signal,
});

export class InvalidTransition extends Error {
	constructor(operationId: string, from: ExternalOperationState, to: ExternalOperationState) {
		super(`External operation ${operationId} cannot go from ${from} to ${to}`);
		this.name = "InvalidTransition";
	}
}

/**
 * Durable records of tool calls with effects outside the database. The call is recorded as `pending` before the effect
 * is attempted and moves to a settled state after; a crash in between leaves `running`, which the next owner turns into
 * `needs_reconciliation` instead of repeating the call. `idempotencyKey` is what the external system is sent.
 */
export class ExternalOperations {
	readonly #db: Db;
	constructor(db: Db) {
		this.#db = db;
	}

	/** Record an operation. A repeated `operationId` returns the stored record; so does a repeated idempotency key. */
	async begin(operation: Pick<ExternalOperationRecord, "operationId" | "ownerId" | "partitionId" | "taskId" | "toolName" | "capability" | "idempotencyKey">): Promise<ExternalOperationRecord> {
		const o = OwnerId.parse(operation.ownerId);
		return this.#db.transaction(o, async (client) => {
			await client.query(
				`INSERT INTO ${S}.external_operations (owner_id, operation_id, partition_id, task_id, tool_name, capability, idempotency_key) VALUES ($1, $2, $3, $4, $5, $6, $7) ON CONFLICT DO NOTHING`,
				[o, operation.operationId, operation.partitionId, operation.taskId, operation.toolName, operation.capability, operation.idempotencyKey],
			);
			const row = (await client.query<Row>(`SELECT * FROM ${S}.external_operations WHERE owner_id = $1 AND (operation_id = $2 OR idempotency_key = $3) ORDER BY (operation_id = $2) DESC LIMIT 1`, [o, operation.operationId, operation.idempotencyKey])).rows[0];
			return toRecord(row as Row);
		});
	}

	async get(ownerId: string, operationId: string): Promise<ExternalOperationRecord | undefined> {
		const result = await this.#db.read<Row>(ownerId, `SELECT * FROM ${S}.external_operations WHERE owner_id = $1 AND operation_id = $2`, [ownerId, operationId]);
		return result.rows[0] === undefined ? undefined : toRecord(result.rows[0]);
	}

	/** Move an operation along the state machine, recording the external system's receipt when there is one. A repeat of the state it is in is a no-op. */
	async transition(ownerId: string, operationId: string, to: ExternalOperationState, receipt?: Record<string, unknown>): Promise<ExternalOperationRecord> {
		if (!EXTERNAL_OPERATION_STATES.includes(to)) throw new TypeError(`Unknown operation state ${String(to)}`);
		return this.#db.transaction(ownerId, async (client) => {
			const row = (await client.query<Row>(`SELECT * FROM ${S}.external_operations WHERE owner_id = $1 AND operation_id = $2 FOR UPDATE`, [ownerId, operationId])).rows[0];
			if (row === undefined) throw new Error(`Unknown external operation ${operationId}`);
			if (row.state === to) return toRecord(row);
			if (!NEXT[row.state].includes(to)) throw new InvalidTransition(operationId, row.state, to);
			const updated = await client.query<Row>(
				`UPDATE ${S}.external_operations SET state = $3, receipt = coalesce($4::json, receipt), updated_at = clock_timestamp() WHERE owner_id = $1 AND operation_id = $2 RETURNING *`,
				[ownerId, operationId, to, receipt === undefined ? null : JSON.stringify(receipt)],
			);
			return toRecord(updated.rows[0] as Row);
		});
	}

	/**
	 * A decision or result that arrived before patched pi-durable 1.1.0 parked the task. It is kept on the record and also
	 * written as a durable signal in the same transaction, which wakes the partition and is re-applied by its owner at
	 * every activation until the task has left the waiting state. The first signal wins.
	 */
	async recordEarlySignal(ownerId: string, operationId: string, signal: Record<string, unknown>): Promise<ExternalOperationRecord> {
		return this.#db.transaction(ownerId, async (client) => {
			const row = (await client.query<Row>(`SELECT * FROM ${S}.external_operations WHERE owner_id = $1 AND operation_id = $2 FOR UPDATE`, [ownerId, operationId])).rows[0];
			if (row === undefined) throw new Error(`Unknown external operation ${operationId}`);
			if (row.early_signal !== null) return toRecord(row);
			const taskId = Number(row.task_id);
			if (!Number.isSafeInteger(taskId)) throw new Error(`External operation ${operationId} names task ${row.task_id}, which is not a pi task id`);
			await client.query(`UPDATE ${S}.external_operations SET early_signal = $3::json, updated_at = clock_timestamp() WHERE owner_id = $1 AND operation_id = $2`, [ownerId, operationId, JSON.stringify(signal)]);
			await client.query(
				`INSERT INTO ${S}.durable_signals (owner_id, partition_id, signal_key, kind, task_id, call_id, payload) VALUES ($1, $2, $3, 'tool_result', $4, NULL, $5::json) ON CONFLICT DO NOTHING`,
				[ownerId, row.partition_id, `op:${operationId}`, taskId, JSON.stringify(signal)],
			);
			await activate(client, ownerId, row.partition_id, "signal:tool_result");
			return toRecord({ ...row, early_signal: signal });
		});
	}

	/** Operations of a partition that are not settled: what a new owner must reconcile or finish. */
	async unsettled(ownerId: string, partitionId: string): Promise<ExternalOperationRecord[]> {
		const result = await this.#db.read<Row>(ownerId, `SELECT * FROM ${S}.external_operations WHERE owner_id = $1 AND partition_id = $2 ORDER BY created_at`, [ownerId, partitionId]);
		return result.rows.map(toRecord).filter((r) => !operationSettled(r.state));
	}

	/**
	 * A new owner took the partition: whatever the previous one left `running`, or with a cancel in flight, may or may not
	 * have had its effect. Those are marked for reconciliation rather than repeated. Returns the operations changed.
	 */
	async markInterrupted(ownerId: string, partitionId: string): Promise<ExternalOperationRecord[]> {
		const result = await this.#db.read<Row>(
			ownerId,
			`UPDATE ${S}.external_operations SET state = CASE state WHEN 'cancel_requested' THEN 'cancel_uncertain' ELSE 'needs_reconciliation' END, updated_at = clock_timestamp()
			 WHERE owner_id = $1 AND partition_id = $2 AND state IN ('running', 'cancel_requested') RETURNING *`,
			[ownerId, partitionId],
		);
		return result.rows.map(toRecord);
	}
}
