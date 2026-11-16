import { createHash, randomUUID } from "node:crypto";
import { Authorizer } from "./authz.ts";
import type { Db, Tx } from "./db.ts";
import { BadRequestError, ConflictError, NotFoundError } from "./errors.ts";
import { CommandSubmission, type CommandKind } from "@pim/v2-contracts/runtime-seam";
import { effectivePrincipal, OwnerId, type Principal } from "@pim/v2-contracts/identity";

/** What a client can submit: the runtime's commands, and three application operations that only change metadata here (fork, unarchive, delegate). */
export type AdmitKind = CommandKind | "fork" | "unarchive" | "delegate";
const RUNTIME_KINDS = new Set<string>(["user_message", "approval_decision", "task_wake", "trigger_fire", "coding_wake", "compaction_handoff", "abort"]);
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
		await this.authz.enforce(p, "api:write");
		return this.db.owner(p.ownerId, (tx) => createChat(tx, p.ownerId, input));
	}

	/**
	 * Accepts a command. A duplicate commandId commits once and answers with the first acceptance (a changed payload under the same id is a conflict).
	 * Cheap metadata the command implies (fork, unarchive, resuming an archived chat, delegation) is applied in the same transaction.
	 */
	async admit(p: Principal, input: { commandId: string; kind: AdmitKind; chatId?: string; payload?: Record<string, unknown> }): Promise<Admission> {
		await this.authz.enforce(p, input.kind === "approval_decision" ? "approval:decide" : "api:write");
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
			} else if (input.kind === "user_message" && chatId) {
				await resume(tx, chatId);
				await tx.query("UPDATE pim_app.conversations SET updated_at = now() WHERE public_chat_id = $1", [chatId]);
			} else if (input.kind === "delegate") {
				result = await delegateTask(tx, p, chatId!, input.commandId, payload);
				chatId = result.taskChatId as string;
				// The task chat starts working: a wake in the task's own chat, stable under a retry of this command.
				const wakeId = `${input.commandId}:wake`;
				await tx.query("INSERT INTO pim_app.accepted_commands (owner_id, command_id, kind, public_chat_id, pi_request_id, payload) VALUES ($1,$2,'task_wake',$3,$4,$5)", [p.ownerId, wakeId, chatId, requestId(p.ownerId, wakeId), JSON.stringify({ text: String(payload.prompt ?? payload.title ?? "") , taskId: result.taskId })]);
				await tx.query("INSERT INTO pim_app.command_inbox (owner_id, command_id, partition_id) VALUES ($1,$2,(SELECT partition_id FROM pim_app.conversations WHERE public_chat_id = $3))", [p.ownerId, wakeId, chatId]);
			}
			await tx.query("UPDATE pim_app.accepted_commands SET public_chat_id = $2, payload = payload || $3::jsonb WHERE command_id = $1", [input.commandId, chatId, JSON.stringify(result ? { _result: result } : {})]);
			if (RUNTIME_KINDS.has(input.kind)) {
				if (!chatId) throw new BadRequestError(`A ${input.kind} command needs a chat`);
				await tx.query("INSERT INTO pim_app.command_inbox (owner_id, command_id, partition_id) VALUES ($1, $2, (SELECT partition_id FROM pim_app.conversations WHERE public_chat_id = $3))", [p.ownerId, input.commandId, chatId]);
			}
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

	/**
	 * The Runner claims due inbox rows without blocking other claimers; a claim that is not committed returns after `leaseMs`.
	 * Each is the runtime's `CommandSubmission`, with the stable `piRequestId`.
	 */
	async claim(ownerId: string, runner: string, limit = 10, leaseMs = 30_000): Promise<CommandSubmission[]> {
		return this.db.owner(ownerId, async (tx) => {
			const { rows } = await tx.query(
				`WITH picked AS (
				   UPDATE pim_app.command_inbox SET claimed_by = $1, claimed_until = now() + ($3 || ' milliseconds')::interval
				   WHERE seq IN (SELECT seq FROM pim_app.command_inbox WHERE available_at <= now() AND (claimed_until IS NULL OR claimed_until < now()) ORDER BY seq LIMIT $2 FOR UPDATE SKIP LOCKED)
				   RETURNING seq, command_id)
				 SELECT c.command_id, c.kind, c.pi_request_id, c.payload, c.accepted_at, v.partition_id, v.conversation_id, v.public_chat_id, p.seq
				 FROM picked p JOIN pim_app.accepted_commands c ON c.command_id = p.command_id
				 JOIN pim_app.conversations v ON v.public_chat_id = c.public_chat_id ORDER BY p.seq`,
				[runner, limit, String(leaseMs)],
			);
			return rows.map((r) => {
				const { _fingerprint, _result, ...payload } = r.payload;
				return CommandSubmission.parse({
					commandId: r.command_id, ownerId, partitionId: r.partition_id, conversationId: Number(r.conversation_id), publicChatId: r.public_chat_id,
					piRequestId: r.pi_request_id, kind: r.kind, payload, submittedAt: r.accepted_at.toISOString(),
				});
			});
		});
	}

	async markCommitted(ownerId: string, commandId: string): Promise<void> {
		await this.db.owner(ownerId, async (tx) => {
			await tx.query("UPDATE pim_app.accepted_commands SET state = 'runtime_committed', committed_at = now() WHERE command_id = $1 AND state = 'inbox_accepted'", [commandId]);
			await tx.query("DELETE FROM pim_app.command_inbox WHERE command_id = $1", [commandId]);
		});
	}

	/** `GET /api/sessions`: most recently active first, with what the sidebar shows. `startedBy` names the chat and task that started a chat made for a task. */
	async list(ownerId: string, opts: { archived?: boolean; limit?: number } = {}) {
		return this.db.owner(ownerId, async (tx) => {
			const { rows } = await tx.query(
				`SELECT c.public_chat_id, c.title, c.kind, c.created_at, c.updated_at, c.response_at, c.read_at, c.archived_at, c.continued_from, c.agent_id, c.room_mode,
				        t.task_id, t.status AS task_status, t.started_by,
				        (SELECT coalesce(jsonb_agg(m.member), '[]') FROM pim_app.room_members m WHERE m.public_chat_id = c.public_chat_id) AS members,
				        (SELECT count(*)::int FROM pim_app.command_inbox i JOIN pim_app.accepted_commands a ON a.command_id = i.command_id AND a.owner_id = i.owner_id WHERE a.public_chat_id = c.public_chat_id) AS queued
				 FROM pim_app.conversations c LEFT JOIN pim_app.tasks t ON t.task_chat = c.public_chat_id
				 WHERE c.deleted_at IS NULL AND (c.archived_at IS NOT NULL) = $1 ORDER BY c.updated_at DESC LIMIT $2`,
				[opts.archived ?? false, Math.min(opts.limit ?? 100, 200)],
			);
			return rows.map((r) => ({
				id: r.public_chat_id as string, title: r.title as string | null, kind: r.kind as string, createdAt: r.created_at as Date, updatedAt: r.updated_at as Date, responseAt: r.response_at as Date | null,
				unread: r.response_at !== null && (r.read_at === null || r.read_at < r.response_at), archived: r.archived_at !== null, busy: r.queued > 0,
				agent: r.agent_id as string | null, continuedFrom: r.continued_from as string | null,
				startedBy: r.task_id ? { session: r.started_by as string, task: r.task_id as string, state: r.task_status as string } : null,
				room: r.room_mode || r.kind === "group" ? { mode: (r.room_mode as string | null) ?? "host", members: r.members as string[] } : null,
			}));
		});
	}

	/** The latest delivered reply of a chat, which the Runner reports; it is what "unread" is measured against. */
	async markResponse(ownerId: string, chatId: string, at = new Date()): Promise<void> {
		await this.db.owner(ownerId, (tx) => tx.query("UPDATE pim_app.conversations SET response_at = $2, updated_at = greatest(updated_at, $2) WHERE public_chat_id = $1", [chatId, at]));
	}

	async markRead(p: Principal, chatId: string, at = new Date()): Promise<void> {
		await this.authz.enforce(p, "api:write");
		await this.db.owner(p.ownerId, async (tx) => {
			await requireChat(tx, chatId);
			await tx.query("UPDATE pim_app.conversations SET read_at = $2 WHERE public_chat_id = $1", [chatId, at]);
		});
	}

	/** Archives a chat by hand until its next activity. */
	async archive(p: Principal, chatId: string): Promise<void> {
		await this.authz.enforce(p, "api:write");
		await this.db.owner(p.ownerId, async (tx) => {
			await requireChat(tx, chatId);
			await tx.query("UPDATE pim_app.conversations SET archived_at = coalesce(archived_at, now()) WHERE public_chat_id = $1", [chatId]);
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
		await this.authz.enforce(p, "api:write");
		return this.db.owner(p.ownerId, async (tx) => {
			const from = await requireChat(tx, chatId);
			if (from.continued_to) return from.continued_to as string;
			const id = await createChat(tx, p.ownerId, { agentId: from.agent_id, title: from.title, summary, summaryOf: chatId, continuedFrom: chatId });
			await tx.query("UPDATE pim_app.conversations SET continued_to = $2, archived_at = coalesce(archived_at, now()) WHERE public_chat_id = $1", [chatId, id]);
			// The Runner carries the summary into the new chat's first turn.
			const commandId = `handoff:${chatId}`;
			await tx.query("INSERT INTO pim_app.accepted_commands (owner_id, command_id, kind, public_chat_id, pi_request_id, payload) VALUES ($1,$2,'compaction_handoff',$3,$4,$5) ON CONFLICT DO NOTHING", [p.ownerId, commandId, id, requestId(p.ownerId, commandId), JSON.stringify({ summary, continuedFrom: chatId })]);
			await tx.query("INSERT INTO pim_app.command_inbox (owner_id, command_id, partition_id) VALUES ($1,$2,(SELECT partition_id FROM pim_app.conversations WHERE public_chat_id = $3)) ON CONFLICT DO NOTHING", [p.ownerId, commandId, id]);
			return id;
		});
	}

	// ---- delegation tasks ----

	/** Moves a task along working | auth-required | completed | failed | canceled and delivers one "[Task update]" per state to the starting chat, however often it is called. */
	async updateTask(p: Principal, taskId: string, status: string, result?: string): Promise<{ delivered: boolean }> {
		await this.authz.enforce(p, "api:write");
		return this.db.owner(p.ownerId, async (tx) => {
			const { rows } = await tx.query("SELECT status, started_by, task_chat FROM pim_app.tasks WHERE task_id = $1 FOR UPDATE", [taskId]);
			const task = rows[0];
			if (!task) throw new NotFoundError("No such task");
			if (task.status !== status && !TASK_NEXT[task.status]?.includes(status)) throw new ConflictError(`A ${task.status} task cannot become ${status}`, "bad_task_transition");
			await tx.query("UPDATE pim_app.tasks SET status = $2, result = coalesce($3, result), updated_at = now() WHERE task_id = $1", [taskId, status, result ?? null]);
			const commandId = `task:${taskId}:${status}`;
			const first = await tx.query("INSERT INTO pim_app.task_update_deliveries (task_id, owner_id, status, command_id) VALUES ($1, $2, $3, $4) ON CONFLICT DO NOTHING", [taskId, p.ownerId, status, commandId]);
			if (!first.rowCount) return { delivered: false };
			await tx.query("INSERT INTO pim_app.accepted_commands (owner_id, command_id, kind, public_chat_id, pi_request_id, payload) VALUES ($1, $2, 'task_wake', $3, $4, $5)", [
				p.ownerId, commandId, task.started_by, requestId(p.ownerId, commandId), JSON.stringify({ text: `[Task update] ${taskId} is ${status}${result ? `: ${result}` : ""}`, taskId, status }),
			]);
			await tx.query("INSERT INTO pim_app.command_inbox (owner_id, command_id) VALUES ($1, $2)", [p.ownerId, commandId]);
			return { delivered: true };
		});
	}

	/** archive_task_chats: archives the chats of finished tasks so they leave the list; returns how many. */
	async archiveTaskChats(p: Principal): Promise<number> {
		await this.authz.enforce(p, "api:write");
		return this.db.owner(p.ownerId, async (tx) => (await tx.query(
			`UPDATE pim_app.conversations c SET archived_at = now() FROM pim_app.tasks t
			 WHERE t.task_chat = c.public_chat_id AND t.status IN ('completed', 'failed', 'canceled') AND c.archived_at IS NULL`,
		)).rowCount ?? 0);
	}

	/** The principal a delegated task runs as. The Authorizer decides on its origin, the principal that asked, so delegation never adds privilege. */
	async taskPrincipal(ownerId: string, taskId: string): Promise<Principal> {
		const { origin } = await this.task(ownerId, taskId);
		return { kind: "delegated", ownerId: OwnerId.parse(ownerId), delegateId: taskId, originPrincipal: origin };
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
		partition = randomUUID();
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
	// The effective principal that asked is recorded: what runs the task is bounded by it, however many agents delegate onward.
	await tx.query("INSERT INTO pim_app.tasks (task_id, owner_id, started_by, task_chat, origin_principal, title) VALUES ($1, $2, $3, $4, $5, $6)", [taskId, p.ownerId, fromChat, taskChat, JSON.stringify(effectivePrincipal(p)), title]);
	return { taskId, taskChatId: taskChat };
}
