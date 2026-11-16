import { createHash, randomUUID } from "node:crypto";
import { Authorizer } from "./authz.ts";
import type { Db, Tx } from "./db.ts";
import { BadRequestError, ConflictError, NotFoundError } from "./errors.ts";
import { newId } from "./ids.ts";
import { type Principal, principalKey } from "./principal.ts";

export type CommandKind = "message" | "approval" | "abort" | "fork" | "unarchive" | "delegate" | "task_update";
export type Admission = { commandId: string; piRequestId: string; duplicate: boolean; state: "inbox_accepted" | "runtime_committed" | "rejected"; chatId: string | null; result?: Record<string, unknown> };

const uuidFrom = (seed: string): string => {
	const h = createHash("sha256").update(seed).digest("hex");
	return `${h.slice(0, 8)}-${h.slice(8, 12)}-5${h.slice(13, 16)}-a${h.slice(17, 20)}-${h.slice(20, 32)}`;
};
const requestId = (ownerId: string, commandId: string) => `pimreq_${createHash("sha256").update(`${ownerId}\n${commandId}`).digest("hex").slice(0, 32)}`;

const TASK_NEXT: Record<string, string[]> = {
	working: ["auth-required", "completed", "failed", "canceled"],
	"auth-required": ["working", "completed", "failed", "canceled"],
	completed: [],
	failed: [],
	canceled: [],
};

/**
 * Conversations and the command ledger. Everything here is a short PostgreSQL transaction: accepting a command never waits on the Runner,
 * a model, a harness, a computer or NATS. The Runner works the inbox later and calls `markCommitted`.
 */
export class Conversations {
	readonly authz: Authorizer;
	constructor(private readonly db: Db) {
		this.authz = new Authorizer(db);
	}

	/** A new chat starts a new family (partition) with the next id of the tenant-wide sequence. */
	async create(p: Principal, input: { agentId?: string; title?: string; kind?: "normal" | "group" | "task" | "trigger" | "review" | "visit"; roomMode?: string; id?: string }): Promise<string> {
		await this.authz.authorize(p, "api:write");
		return this.db.owner(p.ownerId, (tx) => createChat(tx, p.ownerId, input));
	}

	/**
	 * Accepts a command. A duplicate commandId commits once and answers with the first acceptance (a changed payload under the same id is a conflict).
	 * Cheap metadata the command implies (fork, unarchive, resuming an archived chat, delegation) is applied in the same transaction.
	 */
	async admit(p: Principal, input: { commandId: string; kind: CommandKind; chatId?: string; payload?: Record<string, unknown> }): Promise<Admission> {
		await this.authz.authorize(p, input.kind === "approval" ? "api:approve" : "api:write");
		if (!input.commandId || input.commandId.length > 128) throw new BadRequestError("commandId is required");
		const payload = input.payload ?? {};
		return this.db.owner(p.ownerId, async (tx) => {
			const piRequestId = requestId(p.ownerId, input.commandId);
			const fingerprint = createHash("sha256").update(JSON.stringify([input.kind, input.chatId ?? null, payload])).digest("hex");
			const inserted = await tx.query(
				`INSERT INTO pim_app.accepted_commands (owner_id, command_id, kind, public_chat_id, pi_request_id, payload)
				 VALUES ($1, $2, $3, $4, $5, $6) ON CONFLICT (owner_id, command_id) DO NOTHING RETURNING command_id`,
				[p.ownerId, input.commandId, input.kind, null, piRequestId, JSON.stringify({ ...payload, _fingerprint: fingerprint })],
			);
			if (!inserted.rowCount) {
				const { rows } = await tx.query("SELECT state, public_chat_id, payload FROM pim_app.accepted_commands WHERE command_id = $1", [input.commandId]);
				if (rows[0].payload._fingerprint !== fingerprint) throw new ConflictError("That commandId was already used for a different command", "command_id_reused");
				return { commandId: input.commandId, piRequestId, duplicate: true, state: rows[0].state, chatId: rows[0].public_chat_id, result: rows[0].payload._result };
			}
			let chatId = input.chatId ?? null;
			let result: Record<string, unknown> | undefined;
			if (chatId) await requireChat(tx, chatId);
			if (input.kind === "fork") {
				chatId = await fork(tx, p.ownerId, chatId!, uuidFrom(`${p.ownerId}\nfork\n${input.commandId}`));
				result = { forkedChatId: chatId };
			} else if (input.kind === "unarchive") {
				await resume(tx, chatId!);
			} else if (input.kind === "message" && chatId) {
				await resume(tx, chatId);
				await tx.query("UPDATE pim_app.conversations SET updated_at = now() WHERE public_chat_id = $1", [chatId]);
			} else if (input.kind === "delegate") {
				result = await delegateTask(tx, p, chatId!, input.commandId, payload);
				chatId = result.taskChatId as string;
			}
			await tx.query("UPDATE pim_app.accepted_commands SET public_chat_id = $2, payload = payload || $3::jsonb WHERE command_id = $1", [input.commandId, chatId, JSON.stringify(result ? { _result: result } : {})]);
			await tx.query("INSERT INTO pim_app.command_inbox (owner_id, command_id, partition_id) VALUES ($1, $2, $3)", [
				p.ownerId,
				input.commandId,
				chatId ? (await tx.query("SELECT partition_id FROM pim_app.conversations WHERE public_chat_id = $1", [chatId])).rows[0]?.partition_id : null,
			]);
			return { commandId: input.commandId, piRequestId, duplicate: false, state: "inbox_accepted", chatId, result };
		});
	}

	/** Commands for a chat, newest last, with what the runtime has committed told apart from what is only accepted into the inbox. Bounded. */
	async pending(ownerId: string, chatId: string, limit = 50): Promise<{ commandId: string; kind: string; state: string; inboxAccepted: boolean; runtimeCommitted: boolean; piRequestId: string }[]> {
		return this.db.owner(ownerId, async (tx) => {
			const { rows } = await tx.query("SELECT command_id, kind, state, pi_request_id FROM pim_app.accepted_commands WHERE public_chat_id = $1 ORDER BY accepted_at DESC, command_id LIMIT $2", [chatId, Math.min(limit, 200)]);
			return rows.reverse().map((r) => ({ commandId: r.command_id, kind: r.kind, state: r.state, piRequestId: r.pi_request_id, inboxAccepted: r.state === "inbox_accepted", runtimeCommitted: r.state === "runtime_committed" }));
		});
	}

	/** The Runner claims due inbox rows without blocking other claimers; a claim that is not committed returns after `leaseMs`. */
	async claim(ownerId: string, runner: string, limit = 10, leaseMs = 30_000): Promise<{ seq: string; commandId: string }[]> {
		return this.db.owner(ownerId, async (tx) => {
			const { rows } = await tx.query(
				`UPDATE pim_app.command_inbox SET claimed_by = $1, claimed_until = now() + ($3 || ' milliseconds')::interval
				 WHERE seq IN (SELECT seq FROM pim_app.command_inbox WHERE available_at <= now() AND (claimed_until IS NULL OR claimed_until < now()) ORDER BY seq LIMIT $2 FOR UPDATE SKIP LOCKED)
				 RETURNING seq, command_id`,
				[runner, limit, String(leaseMs)],
			);
			return rows.map((r) => ({ seq: r.seq, commandId: r.command_id }));
		});
	}

	async markCommitted(ownerId: string, commandId: string): Promise<void> {
		await this.db.owner(ownerId, async (tx) => {
			await tx.query("UPDATE pim_app.accepted_commands SET state = 'runtime_committed', committed_at = now() WHERE command_id = $1 AND state = 'inbox_accepted'", [commandId]);
			await tx.query("DELETE FROM pim_app.command_inbox WHERE command_id = $1", [commandId]);
		});
	}

	async get(ownerId: string, chatId: string) {
		return this.db.owner(ownerId, async (tx) => {
			const { rows } = await tx.query("SELECT * FROM pim_app.conversations WHERE public_chat_id = $1 AND deleted_at IS NULL", [chatId]);
			if (!rows[0]) throw new NotFoundError("No such chat");
			const r = rows[0];
			return { id: r.public_chat_id as string, partitionId: r.partition_id as string, conversationId: Number(r.conversation_id), kind: r.kind as string, forkedFrom: r.forked_from as string | null, continuedFrom: r.continued_from as string | null, continuedTo: r.continued_to as string | null, archived: r.archived_at !== null };
		});
	}

	/**
	 * Post-idle compaction handoff: the summary becomes a new chat in a new family that continues `chatId`, and the old chat is archived.
	 * Resuming the old chat (a message or unarchive) detaches the pair, see `resume`.
	 */
	async handoff(p: Principal, chatId: string, summary: string): Promise<string> {
		await this.authz.authorize(p, "api:write");
		return this.db.owner(p.ownerId, async (tx) => {
			const from = await requireChat(tx, chatId);
			if (from.continued_to) return from.continued_to as string;
			const id = await createChat(tx, p.ownerId, { agentId: from.agent_id, title: from.title, summary, summaryOf: chatId, continuedFrom: chatId });
			await tx.query("UPDATE pim_app.conversations SET continued_to = $2, archived_at = coalesce(archived_at, now()) WHERE public_chat_id = $1", [chatId, id]);
			return id;
		});
	}

	// ---- delegation tasks ----

	/** Moves a task along working | auth-required | completed | failed | canceled and delivers one "[Task update]" per state to the starting chat, however often it is called. */
	async updateTask(p: Principal, taskId: string, status: string, result?: string): Promise<{ delivered: boolean }> {
		await this.authz.authorize(p, "api:write");
		return this.db.owner(p.ownerId, async (tx) => {
			const { rows } = await tx.query("SELECT status, started_by, task_chat FROM pim_app.tasks WHERE task_id = $1 FOR UPDATE", [taskId]);
			const task = rows[0];
			if (!task) throw new NotFoundError("No such task");
			if (task.status !== status && !TASK_NEXT[task.status]?.includes(status)) throw new ConflictError(`A ${task.status} task cannot become ${status}`, "bad_task_transition");
			await tx.query("UPDATE pim_app.tasks SET status = $2, result = coalesce($3, result), updated_at = now() WHERE task_id = $1", [taskId, status, result ?? null]);
			const commandId = `task:${taskId}:${status}`;
			const first = await tx.query("INSERT INTO pim_app.task_update_deliveries (task_id, owner_id, status, command_id) VALUES ($1, $2, $3, $4) ON CONFLICT DO NOTHING", [taskId, p.ownerId, status, commandId]);
			if (!first.rowCount) return { delivered: false };
			await tx.query("INSERT INTO pim_app.accepted_commands (owner_id, command_id, kind, public_chat_id, pi_request_id, payload) VALUES ($1, $2, 'task_update', $3, $4, $5)", [
				p.ownerId, commandId, task.started_by, requestId(p.ownerId, commandId), JSON.stringify({ text: `[Task update] ${taskId} is ${status}${result ? `: ${result}` : ""}`, taskId, status }),
			]);
			await tx.query("INSERT INTO pim_app.command_inbox (owner_id, command_id) VALUES ($1, $2)", [p.ownerId, commandId]);
			return { delivered: true };
		});
	}

	/** archive_task_chats: archives the chats of finished tasks so they leave the list; returns how many. */
	async archiveTaskChats(p: Principal): Promise<number> {
		await this.authz.authorize(p, "api:write");
		return this.db.owner(p.ownerId, async (tx) => (await tx.query(
			`UPDATE pim_app.conversations c SET archived_at = now() FROM pim_app.tasks t
			 WHERE t.task_chat = c.public_chat_id AND t.status IN ('completed', 'failed', 'canceled') AND c.archived_at IS NULL`,
		)).rowCount ?? 0);
	}

	/** The principal a delegated task runs as: its own scopes, bounded by the chain of whoever asked, so delegation never adds privilege. */
	async taskPrincipal(ownerId: string, taskId: string, own: { kind?: "agent"; subject: string; scopes: readonly string[] }): Promise<Principal> {
		const { origin } = await this.task(ownerId, taskId);
		return { kind: own.kind ?? "agent", ownerId, scopes: own.scopes, subject: own.subject, origin };
	}

	async task(ownerId: string, taskId: string) {
		return this.db.owner(ownerId, async (tx) => {
			const { rows } = await tx.query("SELECT * FROM pim_app.tasks WHERE task_id = $1", [taskId]);
			if (!rows[0]) throw new NotFoundError("No such task");
			return { taskId: rows[0].task_id as string, status: rows[0].status as string, startedBy: rows[0].started_by as string, taskChat: rows[0].task_chat as string, origin: rows[0].origin_principal as Principal };
		});
	}
}

async function requireChat(tx: Tx, chatId: string) {
	const { rows } = await tx.query("SELECT * FROM pim_app.conversations WHERE public_chat_id = $1 AND deleted_at IS NULL", [chatId]);
	if (!rows[0]) throw new NotFoundError("No such chat");
	return rows[0];
}

type NewChat = { agentId?: string | null; title?: string | null; kind?: string; roomMode?: string; summary?: string; summaryOf?: string; continuedFrom?: string; id?: string };

/** The next id of the tenant's sequence, which lives on its home partition so ids never collide across the families they are split into. */
async function nextConversationId(tx: Tx, ownerId: string): Promise<number> {
	const { rows } = await tx.query("UPDATE pim_app.partitions SET next_conversation_id = next_conversation_id + 1 WHERE owner_id = $1 AND home RETURNING next_conversation_id - 1 AS id", [ownerId]);
	if (!rows[0]) throw new NotFoundError("This owner has no home partition");
	return Number(rows[0].id);
}

async function createChat(tx: Tx, ownerId: string, input: NewChat, partitionId?: string): Promise<string> {
	const id = input.id ?? randomUUID();
	let partition = partitionId;
	if (!partition) {
		partition = newId("p");
		await tx.query("INSERT INTO pim_app.partitions (partition_id, owner_id) VALUES ($1, $2)", [partition, ownerId]);
	}
	await tx.query(
		`INSERT INTO pim_app.conversations (public_chat_id, owner_id, partition_id, conversation_id, agent_id, title, kind, room_mode, summary, summary_of, continued_from)
		 VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)`,
		[id, ownerId, partition, await nextConversationId(tx, ownerId), input.agentId ?? null, input.title ?? null, input.kind ?? "normal", input.roomMode ?? null, input.summary ?? null, input.summaryOf ?? null, input.continuedFrom ?? null],
	);
	return id;
}

/** A fork stays in its parent's family: pi's fork needs the parent's entries in the same storage. */
async function fork(tx: Tx, ownerId: string, parentId: string, id: string): Promise<string> {
	const parent = await requireChat(tx, parentId);
	const chat = await createChat(tx, ownerId, { id, agentId: parent.agent_id, title: parent.title, kind: parent.kind === "group" ? "group" : "normal" }, parent.partition_id);
	await tx.query("UPDATE pim_app.conversations SET forked_from = $2 WHERE public_chat_id = $1", [chat, parentId]);
	return chat;
}

/**
 * Resuming an archived chat that was continued (post-idle handoff) detaches it from its continuation: the old chat is the live one again,
 * its `continuedTo` is cleared and the continuation no longer points back, so the two are independent chats.
 */
async function resume(tx: Tx, chatId: string): Promise<void> {
	await tx.query("UPDATE pim_app.conversations SET continued_from = NULL WHERE continued_from = $1", [chatId]);
	await tx.query("UPDATE pim_app.conversations SET continued_to = NULL, archived_at = NULL WHERE public_chat_id = $1", [chatId]);
}

async function delegateTask(tx: Tx, p: Principal, fromChat: string, commandId: string, payload: Record<string, unknown>): Promise<Record<string, unknown>> {
	const title = String(payload.title ?? "Task");
	const taskId = `task_${createHash("sha256").update(`${p.ownerId}\n${commandId}`).digest("hex").slice(0, 16)}`;
	const taskChat = await createChat(tx, p.ownerId, { id: uuidFrom(`${p.ownerId}\ntask\n${commandId}`), agentId: payload.agentId as string | undefined, title, kind: "task" });
	// The chain is recorded so what runs the task is bounded by who asked for it (see Authorizer: every principal in the chain must pass).
	const origin = { kind: p.kind, ownerId: p.ownerId, scopes: p.scopes, subject: p.subject, origin: p.origin ?? null, key: principalKey(p) };
	await tx.query("INSERT INTO pim_app.tasks (task_id, owner_id, started_by, task_chat, origin_principal, title) VALUES ($1, $2, $3, $4, $5, $6)", [taskId, p.ownerId, fromChat, taskChat, JSON.stringify(origin), title]);
	return { taskId, taskChatId: taskChat };
}
