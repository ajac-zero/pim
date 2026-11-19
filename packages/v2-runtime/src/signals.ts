import { CommandSubmission } from "@pim/v2-contracts/runtime-seam";
import type pg from "pg";
import { type Db, SCHEMA } from "./db.ts";

const S = SCHEMA;

/** A pending command as the owner reads it. `commandId` is the submitter's idempotency key; `kind` is a contract kind or `create_conversation`. */
export type Command = {
	readonly seq: number;
	readonly commandId: string;
	readonly piRequestId: string;
	readonly kind: string;
	readonly conversationId: number | undefined;
	readonly publicChatId: string | undefined;
	readonly payload: Record<string, unknown>;
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
export async function activate(client: pg.PoolClient, ownerId: string, partitionId: string, reason: string): Promise<void> {
	await client.query(
		`INSERT INTO ${S}.due_work (owner_id, partition_id, state, activation_seq, reason) VALUES ($1, $2, 'needs_owner', 1, $3)
		 ON CONFLICT (owner_id, partition_id) DO UPDATE SET state = 'needs_owner', next_due_at = NULL, activation_seq = ${S}.due_work.activation_seq + 1, reason = $3, updated_at = clock_timestamp()`,
		[ownerId, partitionId, reason],
	);
	// A hint only: the due-work row is what a Runner claims from, so a lost notification delays but never loses work.
	await client.query("SELECT pg_notify('pim_runtime_wake', $1)", [JSON.stringify({ ownerId, partitionId })]);
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

	/** Admit a command from Gate, triggers or Forge; resubmitting the same `commandId` queues nothing. */
	async enqueueCommand(submission: CommandSubmission): Promise<{ seq: number; duplicate: boolean }> {
		const c = CommandSubmission.parse(submission);
		return this.#enqueue(c.ownerId, c.partitionId, c.commandId, c.kind, c.piRequestId, c.conversationId, c.publicChatId, c.payload, c.submittedAt);
	}

	/** Ask the owner of a new family partition to create its first conversation (not a contract command: there is no conversation yet to address). */
	async enqueueCreateConversation(ownerId: string, partitionId: string, command: { commandId: string; publicChatId?: string; firstInput?: unknown }): Promise<{ seq: number; duplicate: boolean }> {
		return this.#enqueue(ownerId, partitionId, command.commandId, "create_conversation", command.commandId, undefined, command.publicChatId, { firstInput: command.firstInput ?? null }, new Date().toISOString());
	}

	async #enqueue(
		ownerId: string,
		partitionId: string,
		commandId: string,
		kind: string,
		piRequestId: string,
		conversationId: number | undefined,
		publicChatId: string | undefined,
		payload: Record<string, unknown>,
		submittedAt: string,
	): Promise<{ seq: number; duplicate: boolean }> {
		return this.#db.transaction(ownerId, async (client) => {
			const inserted = await client.query<{ seq: string }>(
				`INSERT INTO ${S}.command_inbox (owner_id, partition_id, command_id, conversation_id, public_chat_id, pi_request_id, kind, payload, submitted_at)
				 VALUES ($1, $2, $3, $4, $5, $6, $7, $8::json, $9)
				 ON CONFLICT (owner_id, partition_id, command_id) DO NOTHING RETURNING seq`,
				[ownerId, partitionId, commandId, conversationId ?? null, publicChatId ?? null, piRequestId, kind, JSON.stringify(payload), submittedAt],
			);
			const row = inserted.rows[0];
			if (row !== undefined) {
				await activate(client, ownerId, partitionId, `command:${kind}`);
				return { seq: Number(row.seq), duplicate: false };
			}
			const existing = await client.query<{ seq: string }>(`SELECT seq FROM ${S}.command_inbox WHERE owner_id = $1 AND partition_id = $2 AND command_id = $3`, [ownerId, partitionId, commandId]);
			return { seq: Number(existing.rows[0]?.seq), duplicate: true };
		});
	}

	async pendingCommands(ownerId: string, partitionId: string, limit = 100): Promise<Command[]> {
		const result = await this.#db.read<{ seq: string; command_id: string; pi_request_id: string; kind: string; conversation_id: string | null; public_chat_id: string | null; payload: Record<string, unknown> }>(
			ownerId,
			`SELECT seq, command_id, pi_request_id, kind, conversation_id, public_chat_id, payload FROM ${S}.command_inbox WHERE owner_id = $1 AND partition_id = $2 AND done_at IS NULL ORDER BY seq LIMIT $3`,
			[ownerId, partitionId, limit],
		);
		return result.rows.map((row) => ({
			seq: Number(row.seq),
			commandId: row.command_id,
			piRequestId: row.pi_request_id,
			kind: row.kind,
			conversationId: row.conversation_id === null ? undefined : Number(row.conversation_id),
			publicChatId: row.public_chat_id ?? undefined,
			payload: row.payload,
		}));
	}

	async completeCommand(ownerId: string, partitionId: string, seq: number): Promise<void> {
		await this.#db.read(ownerId, `UPDATE ${S}.command_inbox SET done_at = clock_timestamp() WHERE owner_id = $1 AND partition_id = $2 AND seq = $3 AND done_at IS NULL`, [ownerId, partitionId, seq]);
	}

	/**
	 * Record an approval decision or an external tool completion before anything acts on it. It stays pending, and is
	 * re-applied at every activation, until a Runner has seen its task leave the waiting state.
	 */
	async recordSignal(
		ownerId: string,
		partitionId: string,
		signal: { key: string; kind: DurableSignal["kind"]; taskId: number; callId?: string; payload?: unknown },
	): Promise<{ signalId: number; duplicate: boolean }> {
		return this.#db.transaction(ownerId, async (client) => {
			const inserted = await client.query<{ signal_id: string }>(
				`INSERT INTO ${S}.durable_signals (owner_id, partition_id, signal_key, kind, task_id, call_id, payload) VALUES ($1, $2, $3, $4, $5, $6, $7::json)
				 ON CONFLICT (owner_id, partition_id, signal_key) DO NOTHING RETURNING signal_id`,
				[ownerId, partitionId, signal.key, signal.kind, signal.taskId, signal.callId ?? null, JSON.stringify(signal.payload ?? null)],
			);
			if (inserted.rows[0] !== undefined) {
				await activate(client, ownerId, partitionId, `signal:${signal.kind}`);
				return { signalId: Number(inserted.rows[0].signal_id), duplicate: false };
			}
			const existing = await client.query<{ signal_id: string }>(`SELECT signal_id FROM ${S}.durable_signals WHERE owner_id = $1 AND partition_id = $2 AND signal_key = $3`, [ownerId, partitionId, signal.key]);
			return { signalId: Number(existing.rows[0]?.signal_id), duplicate: true };
		});
	}

	async pendingSignals(ownerId: string, partitionId: string): Promise<DurableSignal[]> {
		const result = await this.#db.read<{ signal_id: string; signal_key: string; kind: DurableSignal["kind"]; task_id: string; call_id: string | null; payload: unknown }>(
			ownerId,
			`SELECT signal_id, signal_key, kind, task_id, call_id, payload FROM ${S}.durable_signals WHERE owner_id = $1 AND partition_id = $2 AND settled_at IS NULL ORDER BY signal_id`,
			[ownerId, partitionId],
		);
		return result.rows.map((row) => ({ signalId: Number(row.signal_id), key: row.signal_key, kind: row.kind, taskId: Number(row.task_id), callId: row.call_id ?? undefined, payload: row.payload }));
	}

	/** The recorded signal for a key or call, settled or not: a tool's beforeTool hook reads a decision from here, so it gives the same answer after a restart. */
	async signalByKey(ownerId: string, partitionId: string, key: string): Promise<(DurableSignal & { settled: boolean }) | undefined> {
		const result = await this.#db.read<{ signal_id: string; signal_key: string; kind: DurableSignal["kind"]; task_id: string; call_id: string | null; payload: unknown; settled_at: Date | null }>(
			ownerId,
			`SELECT signal_id, signal_key, kind, task_id, call_id, payload, settled_at FROM ${S}.durable_signals WHERE owner_id = $1 AND partition_id = $2 AND signal_key = $3`,
			[ownerId, partitionId, key],
		);
		const row = result.rows[0];
		return row === undefined
			? undefined
			: { signalId: Number(row.signal_id), key: row.signal_key, kind: row.kind, taskId: Number(row.task_id), callId: row.call_id ?? undefined, payload: row.payload, settled: row.settled_at !== null };
	}

	async settleSignal(ownerId: string, partitionId: string, signalId: number): Promise<void> {
		await this.#db.read(ownerId, `UPDATE ${S}.durable_signals SET settled_at = clock_timestamp() WHERE owner_id = $1 AND partition_id = $2 AND signal_id = $3 AND settled_at IS NULL`, [ownerId, partitionId, signalId]);
	}

	/** Keeps a note for a conversation of the partition until its next owner writes it (`ResidentPartition.#writeNotes`); the same `key` again keeps nothing more. */
	async addNote(ownerId: string, partitionId: string, note: { key: string; conversationId: number; entry: unknown }): Promise<void> {
		await this.#db.read(
			ownerId,
			`INSERT INTO ${S}.pending_notes (owner_id, partition_id, note_key, conversation_id, entry) VALUES ($1, $2, $3, $4, $5::json) ON CONFLICT DO NOTHING`,
			[ownerId, partitionId, note.key, note.conversationId, JSON.stringify(note.entry)],
		);
	}

	async pendingNotes(ownerId: string, partitionId: string): Promise<{ key: string; conversationId: number; entry: unknown }[]> {
		const result = await this.#db.read<{ note_key: string; conversation_id: string; entry: unknown }>(
			ownerId,
			`SELECT note_key, conversation_id, entry FROM ${S}.pending_notes WHERE owner_id = $1 AND partition_id = $2 AND settled_at IS NULL ORDER BY created_at`,
			[ownerId, partitionId],
		);
		return result.rows.map((row) => ({ key: row.note_key, conversationId: Number(row.conversation_id), entry: row.entry }));
	}

	async settleNote(ownerId: string, partitionId: string, key: string): Promise<void> {
		await this.#db.read(ownerId, `UPDATE ${S}.pending_notes SET settled_at = clock_timestamp() WHERE owner_id = $1 AND partition_id = $2 AND note_key = $3 AND settled_at IS NULL`, [ownerId, partitionId, key]);
	}

	/** The activation sequence an owner reads before it decides whether to release. */
	async activationSeq(ownerId: string, partitionId: string): Promise<number> {
		const result = await this.#db.read<{ activation_seq: string }>(ownerId, `SELECT activation_seq FROM ${S}.due_work WHERE owner_id = $1 AND partition_id = $2`, [ownerId, partitionId]);
		return Number(result.rows[0]?.activation_seq ?? 0);
	}

	/** Ask another partition to do something, once: the outbox row and the target's command are delivered together by `deliverOutbox`. */
	async enqueueOutbox(ownerId: string, sourcePartitionId: string, item: { operationId: string; targetConversationId: number; payload: unknown }): Promise<void> {
		await this.#db.read(
			ownerId,
			`INSERT INTO ${S}.signal_outbox (owner_id, source_partition_id, operation_id, target_conversation_id, payload) VALUES ($1, $2, $3, $4, $5::json) ON CONFLICT DO NOTHING`,
			[ownerId, sourcePartitionId, item.operationId, item.targetConversationId, JSON.stringify(item.payload)],
		);
	}
}
