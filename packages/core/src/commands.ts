import { createHash, randomUUID } from "node:crypto";
import type pg from "pg";
import { type Q, withTenant } from "./db.ts";
import { createFamily, markNeedsOwner } from "./partitions.ts";

/** Best-effort fanout that makes discovery faster. Never the only way work is found: the activation row is. */
export interface Hints {
	publish(subject: string, payload: Record<string, unknown>): void;
}
export const noHints: Hints = { publish() {} };

export interface CommandInput {
	tenantId: string;
	/** Stable, client-chosen. The same id with the same body is the same command. */
	commandId: string;
	actor: string;
	kind: string;
	/** The family the command is for. Chat creation allocates its own. */
	partitionId: string;
	payload: Record<string, unknown>;
	/** What the owner of the family does with it. */
	signal: { kind: string; payload?: Record<string, unknown> };
}

export interface CommandReceipt {
	commandId: string;
	duplicate: boolean;
}

const digest = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");

export class CommandConflict extends Error {}

/**
 * Gate: accepts a command in one transaction (the inbox row, the durable signal and the activation row) and
 * returns. Nothing here waits for a model, a provision or an owner. A repeated id returns the first acceptance.
 */
export async function acceptCommand(pool: pg.Pool, input: CommandInput, hints: Hints = noHints): Promise<CommandReceipt> {
	const receipt = await withTenant(pool, input.tenantId, (q) => acceptCommandIn(q, input));
	if (!receipt.duplicate) hints.publish(`pim.activate.${input.tenantId}`, { partitionId: input.partitionId });
	return receipt;
}

export async function acceptCommandIn(q: Q, input: CommandInput): Promise<CommandReceipt> {
	const body = { kind: input.kind, partitionId: input.partitionId, payload: input.payload, signal: input.signal };
	const inserted = await q.get("INSERT INTO app.commands (tenant_id, command_id, actor, kind, partition_id, payload) VALUES ($1, $2, $3, $4, $5, $6) ON CONFLICT DO NOTHING RETURNING command_id", input.tenantId, input.commandId, input.actor, input.kind, input.partitionId, JSON.stringify({ ...body, digest: digest(body) }));
	if (inserted === undefined) {
		const prior = await q.get<{ payload: { digest?: string } }>("SELECT payload FROM app.commands WHERE tenant_id = $1 AND command_id = $2", input.tenantId, input.commandId);
		if (prior?.payload.digest !== digest(body)) throw new CommandConflict(`Command ${input.commandId} was already accepted with a different body`);
		return { commandId: input.commandId, duplicate: true };
	}
	await insertSignal(q, input.tenantId, input.partitionId, input.signal.kind, input.commandId, input.signal.payload ?? input.payload);
	return { commandId: input.commandId, duplicate: false };
}

/** Writes a durable signal and marks the family as needing an owner, in the caller's transaction. Idempotent on `operationId`. */
export async function insertSignal(q: Q, tenantId: string, partitionId: string, kind: string, operationId: string, payload: Record<string, unknown>): Promise<boolean> {
	const inserted = await q.get("INSERT INTO app.signals (tenant_id, partition_id, kind, operation_id, payload) VALUES ($1, $2, $3, $4, $5) ON CONFLICT DO NOTHING RETURNING signal_id", tenantId, partitionId, kind, operationId, JSON.stringify(payload));
	if (inserted === undefined) return false;
	await markNeedsOwner(q, tenantId, partitionId);
	return true;
}

/**
 * A new chat is a new family. The row maps the public chat id to the family; the owner creates the conversation
 * when it first activates the family, so no model or compute is involved in accepting it.
 */
export async function createChat(pool: pg.Pool, input: { tenantId: string; commandId: string; actor: string; chatId?: string; agent?: Record<string, unknown>; firstMessage?: string }, hints: Hints = noHints): Promise<{ chatId: string; partitionId: string; duplicate: boolean }> {
	const chatId = input.chatId ?? randomUUID();
	const result = await withTenant(pool, input.tenantId, async (q) => {
		const prior = await q.get<{ partition_id: string }>("SELECT partition_id FROM app.chats WHERE tenant_id = $1 AND chat_id = $2", input.tenantId, chatId);
		if (prior !== undefined) return { partitionId: prior.partition_id, duplicate: true };
		const partitionId = await createFamily(q, input.tenantId);
		await q.run("INSERT INTO app.chats (tenant_id, chat_id, partition_id, created_by) VALUES ($1, $2, $3, $4)", input.tenantId, chatId, partitionId, input.actor);
		const payload = { chatId, agent: input.agent ?? {}, firstMessage: input.firstMessage ?? null };
		await acceptCommandIn(q, { tenantId: input.tenantId, commandId: input.commandId, actor: input.actor, kind: "chat.create", partitionId, payload, signal: { kind: "create_chat", payload } });
		return { partitionId, duplicate: false };
	});
	if (!result.duplicate) hints.publish(`pim.activate.${input.tenantId}`, { partitionId: result.partitionId });
	return { chatId, ...result };
}

/**
 * Records a person's decision on a pending approval and signals the family. Only a pending approval can be decided, once.
 * The owner re-applies the decision to the suspended tool task after every activation until it is acknowledged.
 */
export async function decideApproval(pool: pg.Pool, input: { tenantId: string; approvalId: string; decidedBy: string; approve: boolean }, hints: Hints = noHints): Promise<"decided" | "already_decided" | "unknown"> {
	const outcome = await withTenant(pool, input.tenantId, async (q) => {
		const row = await q.get<{ partition_id: string }>(
			"UPDATE app.approvals SET status = $3, decided_by = $4, decided_at = now() WHERE tenant_id = $1 AND approval_id = $2 AND status = 'pending' RETURNING partition_id",
			input.tenantId,
			input.approvalId,
			input.approve ? "approved" : "denied",
			input.decidedBy,
		);
		if (row === undefined) {
			const existing = await q.get("SELECT 1 FROM app.approvals WHERE tenant_id = $1 AND approval_id = $2", input.tenantId, input.approvalId);
			return { result: existing === undefined ? ("unknown" as const) : ("already_decided" as const), partitionId: undefined };
		}
		await insertSignal(q, input.tenantId, row.partition_id, "approval", `approval:${input.approvalId}`, { approvalId: input.approvalId });
		return { result: "decided" as const, partitionId: row.partition_id };
	});
	if (outcome.partitionId) hints.publish(`pim.activate.${input.tenantId}`, { partitionId: outcome.partitionId });
	return outcome.result;
}

/** Files a pending approval for a suspended tool call. Idempotent per (family, call): a rerun of the tool finds the same approval. */
export async function fileApproval(pool: pg.Pool, input: { tenantId: string; partitionId: string; conversationId: number; taskId: number; callId: string }): Promise<{ approvalId: string; status: "pending" | "approved" | "denied" | "expired" }> {
	return withTenant(pool, input.tenantId, async (q) => {
		await q.run(
			"INSERT INTO app.approvals (tenant_id, approval_id, partition_id, conversation_id, task_id, call_id) VALUES ($1, $2, $3, $4, $5, $6) ON CONFLICT (tenant_id, partition_id, call_id) DO NOTHING",
			input.tenantId,
			`apr-${randomUUID()}`,
			input.partitionId,
			input.conversationId,
			input.taskId,
			input.callId,
		);
		const row = (await q.get<{ approval_id: string; status: "pending" | "approved" | "denied" | "expired" }>("SELECT approval_id, status FROM app.approvals WHERE tenant_id = $1 AND partition_id = $2 AND call_id = $3", input.tenantId, input.partitionId, input.callId))!;
		return { approvalId: row.approval_id, status: row.status };
	});
}
