import type pg from "pg";
import { type Db, SCHEMA } from "./db.ts";

const S = SCHEMA;

export type Command = {
	readonly commandId: number;
	readonly requestId: string;
	readonly kind: string;
	readonly conversationId: number | undefined;
	readonly payload: unknown;
};

export type DurableSignal = {
	readonly signalId: number;
	readonly key: string;
	readonly kind: "approval" | "tool_result" | "resume";
	readonly taskId: number;
	readonly callId: string | undefined;
	readonly payload: unknown;
};

/** Makes a partition claimable again and tells any listening Runner; always runs in the transaction that wrote the work. */
async function activate(client: pg.PoolClient, tenantId: string, partitionId: string, reason: string): Promise<void> {
	await client.query(
		`INSERT INTO ${S}.due_work (tenant_id, partition_id, state, activation_seq, reason) VALUES ($1, $2, 'needs_owner', 1, $3)
		 ON CONFLICT (tenant_id, partition_id) DO UPDATE SET state = 'needs_owner', next_due_at = NULL, activation_seq = ${S}.due_work.activation_seq + 1, reason = $3, updated_at = clock_timestamp()`,
		[tenantId, partitionId, reason],
	);
	// A hint only: the due-work row is what a Runner claims from, so a lost notification delays but never loses work.
	await client.query("SELECT pg_notify('pim_runtime_wake', $1)", [JSON.stringify({ tenantId, partitionId })]);
}

/**
 * The durable inbox and signal tables of a partition. Writing work here is one transaction that also bumps the
 * partition's activation_seq, which is what makes a concurrent release of the partition fail safe: the owner cannot
 * declare itself quiescent after seeing an activation_seq older than the one this commit wrote.
 */
export class PartitionInbox {
	readonly #db: Db;
	constructor(db: Db) {
		this.#db = db;
	}

	/** Admit a command; a repeated request id is not queued twice. */
	async enqueueCommand(tenantId: string, partitionId: string, command: { requestId: string; kind: string; conversationId?: number; payload: unknown }): Promise<{ commandId: number; duplicate: boolean }> {
		return this.#db.transaction(tenantId, async (client) => {
			const inserted = await client.query<{ command_id: string }>(
				`INSERT INTO ${S}.command_inbox (tenant_id, partition_id, request_id, kind, conversation_id, payload) VALUES ($1, $2, $3, $4, $5, $6::json)
				 ON CONFLICT (tenant_id, partition_id, request_id) DO NOTHING RETURNING command_id`,
				[tenantId, partitionId, command.requestId, command.kind, command.conversationId ?? null, JSON.stringify(command.payload)],
			);
			const row = inserted.rows[0];
			if (row !== undefined) {
				await activate(client, tenantId, partitionId, `command:${command.kind}`);
				return { commandId: Number(row.command_id), duplicate: false };
			}
			const existing = await client.query<{ command_id: string }>(`SELECT command_id FROM ${S}.command_inbox WHERE tenant_id = $1 AND partition_id = $2 AND request_id = $3`, [tenantId, partitionId, command.requestId]);
			return { commandId: Number(existing.rows[0]?.command_id), duplicate: true };
		});
	}

	async pendingCommands(tenantId: string, partitionId: string, limit = 100): Promise<Command[]> {
		const result = await this.#db.read<{ command_id: string; request_id: string; kind: string; conversation_id: string | null; payload: unknown }>(
			tenantId,
			`SELECT command_id, request_id, kind, conversation_id, payload FROM ${S}.command_inbox WHERE tenant_id = $1 AND partition_id = $2 AND done_at IS NULL ORDER BY command_id LIMIT $3`,
			[tenantId, partitionId, limit],
		);
		return result.rows.map((row) => ({
			commandId: Number(row.command_id),
			requestId: row.request_id,
			kind: row.kind,
			conversationId: row.conversation_id === null ? undefined : Number(row.conversation_id),
			payload: row.payload,
		}));
	}

	async completeCommand(tenantId: string, partitionId: string, commandId: number): Promise<void> {
		await this.#db.read(tenantId, `UPDATE ${S}.command_inbox SET done_at = clock_timestamp() WHERE tenant_id = $1 AND partition_id = $2 AND command_id = $3 AND done_at IS NULL`, [tenantId, partitionId, commandId]);
	}

	/**
	 * Record an approval decision or an external tool completion before anything acts on it. It stays pending, and is
	 * re-applied at every activation, until a Runner has seen its task leave the waiting state.
	 */
	async recordSignal(
		tenantId: string,
		partitionId: string,
		signal: { key: string; kind: DurableSignal["kind"]; taskId: number; callId?: string; payload?: unknown },
	): Promise<{ signalId: number; duplicate: boolean }> {
		return this.#db.transaction(tenantId, async (client) => {
			const inserted = await client.query<{ signal_id: string }>(
				`INSERT INTO ${S}.durable_signals (tenant_id, partition_id, signal_key, kind, task_id, call_id, payload) VALUES ($1, $2, $3, $4, $5, $6, $7::json)
				 ON CONFLICT (tenant_id, partition_id, signal_key) DO NOTHING RETURNING signal_id`,
				[tenantId, partitionId, signal.key, signal.kind, signal.taskId, signal.callId ?? null, JSON.stringify(signal.payload ?? null)],
			);
			if (inserted.rows[0] !== undefined) {
				await activate(client, tenantId, partitionId, `signal:${signal.kind}`);
				return { signalId: Number(inserted.rows[0].signal_id), duplicate: false };
			}
			const existing = await client.query<{ signal_id: string }>(`SELECT signal_id FROM ${S}.durable_signals WHERE tenant_id = $1 AND partition_id = $2 AND signal_key = $3`, [tenantId, partitionId, signal.key]);
			return { signalId: Number(existing.rows[0]?.signal_id), duplicate: true };
		});
	}

	async pendingSignals(tenantId: string, partitionId: string): Promise<DurableSignal[]> {
		const result = await this.#db.read<{ signal_id: string; signal_key: string; kind: DurableSignal["kind"]; task_id: string; call_id: string | null; payload: unknown }>(
			tenantId,
			`SELECT signal_id, signal_key, kind, task_id, call_id, payload FROM ${S}.durable_signals WHERE tenant_id = $1 AND partition_id = $2 AND settled_at IS NULL ORDER BY signal_id`,
			[tenantId, partitionId],
		);
		return result.rows.map((row) => ({ signalId: Number(row.signal_id), key: row.signal_key, kind: row.kind, taskId: Number(row.task_id), callId: row.call_id ?? undefined, payload: row.payload }));
	}

	/** The recorded signal for a key or call, settled or not: a tool's beforeTool hook reads a decision from here, so it gives the same answer after a restart. */
	async signalByKey(tenantId: string, partitionId: string, key: string): Promise<(DurableSignal & { settled: boolean }) | undefined> {
		const result = await this.#db.read<{ signal_id: string; signal_key: string; kind: DurableSignal["kind"]; task_id: string; call_id: string | null; payload: unknown; settled_at: Date | null }>(
			tenantId,
			`SELECT signal_id, signal_key, kind, task_id, call_id, payload, settled_at FROM ${S}.durable_signals WHERE tenant_id = $1 AND partition_id = $2 AND signal_key = $3`,
			[tenantId, partitionId, key],
		);
		const row = result.rows[0];
		return row === undefined
			? undefined
			: { signalId: Number(row.signal_id), key: row.signal_key, kind: row.kind, taskId: Number(row.task_id), callId: row.call_id ?? undefined, payload: row.payload, settled: row.settled_at !== null };
	}

	async settleSignal(tenantId: string, partitionId: string, signalId: number): Promise<void> {
		await this.#db.read(tenantId, `UPDATE ${S}.durable_signals SET settled_at = clock_timestamp() WHERE tenant_id = $1 AND partition_id = $2 AND signal_id = $3 AND settled_at IS NULL`, [tenantId, partitionId, signalId]);
	}

	/** The activation sequence an owner reads before it decides whether to release. */
	async activationSeq(tenantId: string, partitionId: string): Promise<number> {
		const result = await this.#db.read<{ activation_seq: string }>(tenantId, `SELECT activation_seq FROM ${S}.due_work WHERE tenant_id = $1 AND partition_id = $2`, [tenantId, partitionId]);
		return Number(result.rows[0]?.activation_seq ?? 0);
	}

	/** Ask another partition to do something, once: the outbox row and the target's command are delivered together by `deliverOutbox`. */
	async enqueueOutbox(tenantId: string, sourcePartitionId: string, item: { operationId: string; targetConversationId: number; payload: unknown }): Promise<void> {
		await this.#db.read(
			tenantId,
			`INSERT INTO ${S}.signal_outbox (tenant_id, source_partition_id, operation_id, target_conversation_id, payload) VALUES ($1, $2, $3, $4, $5::json) ON CONFLICT DO NOTHING`,
			[tenantId, sourcePartitionId, item.operationId, item.targetConversationId, JSON.stringify(item.payload)],
		);
	}
}
