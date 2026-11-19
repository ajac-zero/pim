import { createHash, randomUUID } from "node:crypto";
import { Authorizer } from "./authz.ts";
import type { Db, Tx } from "./db.ts";
import { BadRequestError, ConflictError, NotFoundError } from "./errors.ts";
import { CommandSubmission, type CommandKind } from "@pim/v2-contracts/runtime-seam";
import type { Quota } from "./quota.ts";
import { effectivePrincipal, OwnerId, type Principal } from "@pim/v2-contracts/identity";

/** What a client can submit: the runtime's commands, and two application operations that only change metadata here (unarchive, delegate). */
export type AdmitKind = CommandKind | "unarchive" | "delegate";
const RUNTIME_KINDS = new Set<string>(["user_message", "approval_decision", "task_wake", "trigger_fire", "coding_wake", "compaction_handoff", "abort", "fork"]);
export type Admission = { commandId: string; piRequestId: string; duplicate: boolean; state: "inbox_accepted" | "runtime_committed" | "rejected"; chatId: string | null; result?: Record<string, unknown> };

const uuidFrom = (seed: string): string => {
	const h = createHash("sha256").update(seed).digest("hex");
	return `${h.slice(0, 8)}-${h.slice(8, 12)}-5${h.slice(13, 16)}-a${h.slice(17, 20)}-${h.slice(20, 32)}`;
};
export const requestId = (ownerId: string, commandId: string) => `pimreq_${createHash("sha256").update(`${ownerId}\n${commandId}`).digest("hex").slice(0, 32)}`;

/** How long a chat can be idle before it is archived by age. */
const ARCHIVE_AFTER_MS = 14 * 86_400_000;

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
	/** Per-space limits, when the deployment's application has them: a refused chat or run is not made. */
	quota: Quota | undefined;
	/**
	 * Runs inside the transaction that accepts a person's message, for a deployment that gives a chat more than one reader (a group chat's seats, `v2-server/src/rooms.ts`).
	 * It answers whether the chat's own agent is woken by the message; when not, the message is only written into its conversation.
	 */
	onUserMessage: ((tx: Tx, ownerId: string, chatId: string, commandId: string, payload: Record<string, unknown>) => Promise<{ host: boolean }>) | undefined;
	/** The other chats that work with a chat and stop with it: the seats of a group chat's other agents. Installed by a deployment that has rooms. */
	seatsOf: ((tx: Tx, chatId: string) => Promise<string[]>) | undefined;
	constructor(private readonly db: Db) {
		this.authz = new Authorizer(db);
	}

	/** A new chat starts a new family (partition) with the next id of the tenant-wide sequence. */
	async create(p: Principal, input: { agentId?: string; title?: string; kind?: "normal" | "group" | "task" | "trigger" | "review" | "visit"; roomMode?: string; id?: string }): Promise<string> {
		await this.authz.enforce(p, "api:write");
		return this.db.owner(p.ownerId, async (tx) => {
			if (!input.kind || input.kind === "normal" || input.kind === "group") await this.quota?.admitNew(tx, p.ownerId, "sessions");
			return createChat(tx, p.ownerId, input);
		});
	}

	/**
	 * Accepts a command. A duplicate commandId commits once and answers with the first acceptance (a changed payload under the same id is a conflict).
	 * Cheap metadata the command implies (fork, unarchive, resuming an archived chat, delegation) is applied in the same transaction.
	 */
	async admit(p: Principal, input: { commandId: string; kind: AdmitKind; chatId?: string; payload?: Record<string, unknown> }): Promise<Admission> {
		await this.authz.enforce(p, input.kind === "approval_decision" ? "approval:decide" : "api:write");
		if (!input.commandId || input.commandId.length > 128) throw new BadRequestError("commandId is required");
		// A fork is made by the runtime, from the entry `at` of the chat it leaves, so the relay needs to know which chat that is.
		if (input.kind === "fork" && !/^\d+$/.test(String(input.payload?.at))) throw new BadRequestError("A fork names the entry of the chat it leaves at");
		const payload = input.kind === "fork" ? { ...input.payload, parent: input.chatId } : (input.payload ?? {});
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
			// A message or a firing trigger starts a run: it counts against the day, and a space that has used its day's allowance is refused.
			if (input.kind === "user_message" || input.kind === "trigger_fire") await this.quota?.admitRun(tx, p.ownerId);
			let chatId = input.chatId ?? null;
			let result: Record<string, unknown> | undefined;
			if (chatId) await requireChat(tx, chatId);
			if (input.kind === "fork") {
				chatId = await fork(tx, p.ownerId, chatId!, uuidFrom(`${p.ownerId}\nfork\n${input.commandId}`), payload.title as string | undefined);
				result = { forkedChatId: chatId };
			} else if (input.kind === "abort") {
				// Stopping a chat stops every agent at work in it, and what they waited on from the person is withdrawn with them: no request is left that nothing can wake.
				for (const seat of (await this.seatsOf?.(tx, chatId!)) ?? []) await stopChat(tx, p.ownerId, seat, `abort:${input.commandId}:${seat}`.slice(0, 128), "Its chat was stopped.");
				await denyWaiting(tx, p.ownerId, chatId!, "Its chat was stopped.");
			} else if (input.kind === "unarchive") {
				await resume(tx, chatId!);
				// Listed again by hand: it is not archived again by age for two weeks.
				await tx.query("UPDATE pim_app.conversations SET updated_at = now() WHERE public_chat_id = $1", [chatId]);
			} else if (input.kind === "user_message" && chatId) {
				await resume(tx, chatId);
				await tx.query("UPDATE pim_app.conversations SET updated_at = now() WHERE public_chat_id = $1", [chatId]);
			} else if (input.kind === "delegate") {
				result = await delegateTasks(tx, p, chatId!, input.commandId, payload);
				chatId = result.taskChatId as string;
			}
			await tx.query("UPDATE pim_app.accepted_commands SET public_chat_id = $2, payload = payload || $3::jsonb WHERE command_id = $1", [input.commandId, chatId, JSON.stringify(result ? { _result: result } : {})]);
			if (RUNTIME_KINDS.has(input.kind)) {
				if (!chatId) throw new BadRequestError(`A ${input.kind} command needs a chat`);
				const heard = input.kind === "user_message" && payload.write !== true && this.onUserMessage ? await this.onUserMessage(tx, p.ownerId, chatId, input.commandId, payload) : { host: true };
				if (!heard.host) await tx.query("UPDATE pim_app.accepted_commands SET payload = payload || '{\"write\": true}'::jsonb WHERE command_id = $1", [input.commandId]);
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
			// A chat that has been idle for two weeks is archived by age, as in v1, unless it is at work or has a reply not yet read; its next activity lists it again.
			const { rows } = await tx.query(
				`SELECT * FROM (
				   SELECT c.public_chat_id, c.title, c.kind, c.created_at, c.updated_at, c.response_at, c.read_at, c.archived_at, c.continued_from, c.agent_id, c.room_mode,
				          t.task_id, t.status AS task_status, t.started_by,
				          (SELECT coalesce(jsonb_agg(m.member), '[]') FROM pim_app.room_members m WHERE m.public_chat_id = c.public_chat_id) AS members,
				          (SELECT count(*)::int FROM pim_app.command_inbox i JOIN pim_app.accepted_commands a ON a.command_id = i.command_id AND a.owner_id = i.owner_id WHERE a.public_chat_id = c.public_chat_id) AS queued
				   FROM pim_app.conversations c LEFT JOIN pim_app.tasks t ON t.task_chat = c.public_chat_id
				   WHERE c.deleted_at IS NULL) l
				 WHERE (l.archived_at IS NOT NULL OR (l.queued = 0 AND l.updated_at < now() - interval '14 days' AND NOT (l.response_at IS NOT NULL AND (l.read_at IS NULL OR l.read_at < l.response_at)))) = $1
				 ORDER BY l.updated_at DESC LIMIT $2`,
				[opts.archived ?? false, Math.min(opts.limit ?? 100, 200)],
			);
			return rows.map((r) => ({
				id: r.public_chat_id as string, title: r.title as string | null, kind: r.kind as string, createdAt: r.created_at as Date, updatedAt: r.updated_at as Date, responseAt: r.response_at as Date | null,
				unread: r.response_at !== null && (r.read_at === null || r.read_at < r.response_at), archived: r.archived_at !== null || (r.queued === 0 && r.updated_at < new Date(Date.now() - ARCHIVE_AFTER_MS) && !(r.response_at !== null && (r.read_at === null || r.read_at < r.response_at))), busy: r.queued > 0,
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

	/**
	 * The person has read the chat. With `through`, the reply (its `responseAt`, in ms) they read, only that far is read, so a slow acknowledgement of an earlier reply never hides a newer one
	 * that came meanwhile (v1's `readSession`); without it, everything is.
	 */
	async markRead(p: Principal, chatId: string, at = new Date(), through?: number): Promise<void> {
		await this.authz.enforce(p, "api:write");
		await this.db.owner(p.ownerId, async (tx) => {
			await requireChat(tx, chatId);
			if (through === undefined) await tx.query("UPDATE pim_app.conversations SET read_at = $2 WHERE public_chat_id = $1", [chatId, at]);
			else await tx.query("UPDATE pim_app.conversations SET read_at = greatest(coalesce(read_at, 'epoch'), least(coalesce(response_at, 'epoch'), to_timestamp($2::double precision / 1000))) WHERE public_chat_id = $1", [chatId, through]);
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

	/**
	 * Moves a task along working | auth-required | completed | failed | canceled and delivers one "[Task update]" per state to the starting chat, however often it is called.
	 * Canceling a task also stops its chat: the turn it is running is aborted and what it waits on from the person is denied.
	 */
	async updateTask(p: Principal, taskId: string, status: string, result?: string): Promise<{ delivered: boolean }> {
		await this.authz.enforce(p, "api:write");
		return this.db.owner(p.ownerId, (tx) => moveTask(tx, p.ownerId, taskId, status, result));
	}

	/**
	 * Deletes a chat and withdraws what hangs on it, so nothing keeps working in a chat the person can no longer see: its turn is aborted and what it waits on from the person is
	 * denied, in every seat of its room too; the tasks it handed out, and the tasks those handed out, are canceled and their chats stopped; if it is a task's chat, that task is canceled
	 * and its requester hears so; messages not yet read are dropped; and the scheduled tasks, triggers and watches that deliver to it end with it, while those that start new chats go on.
	 */
	async remove(p: Principal, chatId: string): Promise<void> {
		await this.authz.enforce(p, "api:write");
		await this.db.owner(p.ownerId, async (tx) => {
			await requireChat(tx, chatId);
			const chats = [chatId, ...((await this.seatsOf?.(tx, chatId)) ?? [])];
			await tx.query("DELETE FROM pim_app.command_inbox i USING pim_app.accepted_commands c WHERE c.owner_id = i.owner_id AND c.command_id = i.command_id AND c.public_chat_id = ANY($1::uuid[]) AND c.state = 'inbox_accepted' AND c.kind <> 'abort'", [chats]);
			await tx.query("UPDATE pim_app.accepted_commands SET state = 'rejected' WHERE public_chat_id = ANY($1::uuid[]) AND state = 'inbox_accepted' AND kind <> 'abort' AND command_id NOT IN (SELECT command_id FROM pim_app.command_inbox)", [chats]);
			// A task's chat is canceled before its run is stopped, so that the run ending does not fail the task first: its requester hears it was canceled.
			const own = (await tx.query("SELECT task_id FROM pim_app.tasks WHERE task_chat = $1 AND status IN ('working', 'auth-required')", [chatId])).rows[0];
			if (own) await moveTask(tx, p.ownerId, own.task_id, "canceled", "The person deleted its chat.");
			const handed = await tx.query(
				`WITH RECURSIVE handed(task_id, task_chat, status) AS (
				   SELECT task_id, task_chat, status FROM pim_app.tasks WHERE started_by = ANY($1::uuid[])
				   UNION SELECT t.task_id, t.task_chat, t.status FROM pim_app.tasks t JOIN handed h ON t.started_by = h.task_chat)
				 SELECT task_id, task_chat, status FROM handed`,
				[chats],
			);
			for (const t of handed.rows) {
				if (t.status === "working" || t.status === "auth-required") await tx.query("UPDATE pim_app.tasks SET status = 'canceled', result = 'Its chat was deleted.', updated_at = now() WHERE task_id = $1", [t.task_id]);
				if (t.task_chat && (t.status === "working" || t.status === "auth-required")) await stopChat(tx, p.ownerId, t.task_chat, `abort:task:${t.task_id}`, "Its chat was deleted.");
			}
			await denyWaiting(tx, p.ownerId, chatId, "Its chat was deleted.");
			await enqueue(tx, p.ownerId, `abort:delete:${chatId}`, "abort", chatId, {});
			for (const seat of chats.slice(1)) await stopChat(tx, p.ownerId, seat, `abort:delete:${seat}`, "Its chat was deleted.");
			await tx.query("DELETE FROM pim_app.schedules WHERE chat_id = ANY($1::uuid[])", [chats]);
			const gone = (await tx.query("SELECT id FROM pim_app.triggers WHERE lifecycle <> 'deleted' AND spec->'destination'->>'type' = 'existing_chat' AND spec->'destination'->>'chatId' = ANY($1::text[])", [chats])).rows.map((r) => r.id as string);
			if (gone.length) {
				await tx.query("DELETE FROM pim_app.trigger_runs WHERE trigger_id = ANY($1::text[])", [gone]);
				await tx.query("DELETE FROM pim_app.trigger_computer_grants WHERE trigger_id = ANY($1::text[])", [gone]);
				await tx.query("UPDATE pim_app.triggers SET lifecycle = 'deleted', enabled = false, updated_at = now() WHERE id = ANY($1::text[])", [gone]);
			}
			await tx.query("DELETE FROM pim_app.room_members WHERE public_chat_id = ANY($1::uuid[])", [chats]);
			await tx.query("UPDATE pim_app.conversations SET deleted_at = now() WHERE public_chat_id = ANY($1::uuid[]) AND deleted_at IS NULL", [chats]);
		});
	}

	/**
	 * What an agent sends in a chat a task started is part of its answer to the agent that asked. Kept under `key` (the call's), so a replayed send is kept once; false when the chat is
	 * not the chat of a task that is working.
	 */
	async taskSaid(ownerId: string, chatId: string, key: string, text: string): Promise<boolean> {
		return this.db.owner(ownerId, async (tx) => {
			const task = (await tx.query("SELECT task_id, said FROM pim_app.tasks WHERE task_chat = $1 AND status IN ('working', 'auth-required') ORDER BY created_at DESC LIMIT 1 FOR UPDATE", [chatId])).rows[0];
			if (!task) return false;
			if (!(task.said as { key: string }[]).some((s) => s.key === key)) await tx.query("UPDATE pim_app.tasks SET said = said || $2::jsonb WHERE task_id = $1", [task.task_id, JSON.stringify([{ key, text }])]);
			return true;
		});
	}

	/**
	 * Ends a task whose agent's run has settled, and tells whoever asked: with what the agent sent while working on it as its answer, or, given a `failure`, why it did not finish.
	 * Nothing if it was ended already (canceled, say).
	 */
	async settleTask(ownerId: string, taskId: string, failure?: string): Promise<void> {
		await this.db.owner(ownerId, async (tx) => {
			const task = (await tx.query("SELECT status, said FROM pim_app.tasks WHERE task_id = $1 FOR UPDATE", [taskId])).rows[0];
			if (!task || (task.status !== "working" && task.status !== "auth-required")) return;
			const said = (task.said as { text: string }[]).map((s) => s.text.trim()).filter(Boolean).join("\n\n");
			if (failure !== undefined) await moveTask(tx, ownerId, taskId, "failed", `It didn't finish: ${failure}.`.slice(0, 2000));
			else await moveTask(tx, ownerId, taskId, "completed", (said || "(It gave no answer.)").slice(0, 20_000));
		});
	}

	/** The tasks one `delegate` call handed out, with who did each: what a call that waits returns once they are all done. */
	async batch(ownerId: string, batch: string): Promise<{ id: string; status: string; result: string | null; by: string }[]> {
		return this.db.owner(ownerId, async (tx) => (await tx.query(
			"SELECT t.task_id, t.status, t.result, coalesce(a.name, 'An agent') AS by FROM pim_app.tasks t LEFT JOIN pim_app.agents a ON a.owner_id = t.owner_id AND a.id = t.agent_id WHERE t.batch = $1 ORDER BY t.position",
			[batch],
		)).rows.map((r) => ({ id: r.task_id as string, status: r.status as string, result: r.result as string | null, by: r.by as string })));
	}

	/** A call that waited has returned the answers of its tasks: they are told, and it no longer waits. */
	async answered(ownerId: string, batch: string): Promise<void> {
		await this.db.owner(ownerId, (tx) => tx.query("UPDATE pim_app.tasks SET delivered = 1, waits = false WHERE batch = $1 AND status IN ('completed', 'failed', 'canceled')", [batch]));
	}

	/** The call that waited for a batch cannot be woken, as when its chat was stopped: its answers go to its chat as an update instead. */
	async stopWaiting(ownerId: string, batch: string): Promise<void> {
		await this.db.owner(ownerId, async (tx) => {
			await tx.query("UPDATE pim_app.tasks SET waits = false WHERE batch = $1", [batch]);
			await deliverBatch(tx, ownerId, batch);
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

export async function requireChat(tx: Tx, chatId: string) {
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

export async function createChat(tx: Tx, ownerId: string, input: NewChat, partitionId?: string): Promise<string> {
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
async function fork(tx: Tx, ownerId: string, parentId: string, id: string, title?: string): Promise<string> {
	const parent = await requireChat(tx, parentId);
	const chat = await createChat(tx, ownerId, { id, agentId: parent.agent_id, title: title ?? parent.title, kind: parent.kind === "group" ? "group" : "normal" }, parent.partition_id);
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

/** The most tasks one `delegate` call hands out, and how deep a chain of tasks goes (v1's limits). */
export const MAX_TASKS = 8;
export const MAX_TASK_DEPTH = 3;

const clipTitle = (text: string) => (text.replace(/\s+/g, " ").trim().slice(0, 60) || "Task");

/**
 * Hands out the tasks of one `delegate` call, each in a chat of its own (or that of the earlier task it `continues`) with the agent doing it, started by a first message from the agent
 * that asked. A task is one `{ agentId, text }`, or the payload is one itself (`title`, `text`, `agentId`). A replay of the call is a replay of the command, which gives none twice.
 */
async function delegateTasks(tx: Tx, p: Principal, fromChat: string, commandId: string, payload: Record<string, unknown>): Promise<Record<string, unknown>> {
	type Handed = { agentId?: string; text?: string; title?: string; continues?: string };
	const handed: Handed[] = Array.isArray(payload.tasks) ? (payload.tasks as Handed[]) : [{ agentId: payload.agentId as string | undefined, text: String(payload.text ?? payload.prompt ?? payload.title ?? ""), title: payload.title as string | undefined }];
	if (handed.length === 0 || handed.length > MAX_TASKS) throw new BadRequestError(`A call hands out 1 to ${MAX_TASKS} tasks`);
	const from = typeof payload.fromName === "string" && payload.fromName ? payload.fromName : null;
	const seed = (i: number) => (i === 0 ? commandId : `${commandId}\n${i}`);
	const parent = (await tx.query("SELECT task_id FROM pim_app.tasks WHERE task_chat = $1 AND status IN ('working', 'auth-required') ORDER BY created_at DESC LIMIT 1", [fromChat])).rows[0]?.task_id ?? null;
	const tasks: { taskId: string; chatId: string; agentId: string | null }[] = [];
	for (const [i, one] of handed.entries()) {
		const text = String(one.text ?? one.title ?? "");
		const taskId = `task_${createHash("sha256").update(`${p.ownerId}\n${seed(i)}`).digest("hex").slice(0, 16)}`;
		let chat: string;
		let agentId = one.agentId ?? null;
		if (one.continues) {
			// A follow-up goes on in the chat where the earlier task worked, which is brought back if it was archived.
			const earlier = (await tx.query("SELECT task_chat, agent_id FROM pim_app.tasks WHERE task_id = $1 AND started_by = $2 AND task_chat IS NOT NULL", [one.continues, fromChat])).rows[0];
			if (!earlier) throw new NotFoundError(`No task ${one.continues} you handed out`);
			chat = earlier.task_chat as string;
			agentId = agentId ?? earlier.agent_id;
			await resume(tx, chat);
		} else {
			chat = await createChat(tx, p.ownerId, { id: uuidFrom(`${p.ownerId}\ntask\n${seed(i)}`), agentId: agentId ?? undefined, title: one.title ?? clipTitle(text), kind: "task" });
		}
		const wakeId = i === 0 ? `${commandId}:wake` : `${commandId}:wake:${i}`;
		// The effective principal that asked is recorded: what runs the task is bounded by it, however many agents delegate onward.
		await tx.query(
			"INSERT INTO pim_app.tasks (task_id, owner_id, started_by, task_chat, origin_principal, title, agent_id, batch, position, waits, waiter_task, parent_task, body, wake_request) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)",
			[taskId, p.ownerId, fromChat, chat, JSON.stringify(effectivePrincipal(p)), one.title ?? clipTitle(text), agentId, commandId, i, payload.waits === true, payload.waits === true && payload.waiterTask !== undefined ? Number(payload.waiterTask) : null, parent, text, requestId(p.ownerId, wakeId)],
		);
		// The task chat starts working: its first message, from the agent that handed it out.
		await enqueue(tx, p.ownerId, wakeId, "user_message", chat, { text: from ? `[From ${from}]\n${text}` : text, taskId, whenBusy: "followUp" });
		tasks.push({ taskId, chatId: chat, agentId });
	}
	return { taskId: tasks[0]!.taskId, taskChatId: tasks[0]!.chatId, batch: commandId, tasks };
}

/** Accepts a command for a chat into the same transaction, for the Runner to work in its turn. A command id that was accepted already is not accepted again. */
async function enqueue(tx: Tx, ownerId: string, commandId: string, kind: CommandKind, chatId: string, payload: Record<string, unknown>): Promise<void> {
	const first = await tx.query("INSERT INTO pim_app.accepted_commands (owner_id, command_id, kind, public_chat_id, pi_request_id, payload) VALUES ($1,$2,$3,$4,$5,$6) ON CONFLICT (owner_id, command_id) DO NOTHING RETURNING command_id", [ownerId, commandId, kind, chatId, requestId(ownerId, commandId), JSON.stringify(payload)]);
	if (first.rowCount) await tx.query("INSERT INTO pim_app.command_inbox (owner_id, command_id, partition_id) VALUES ($1, $2, (SELECT partition_id FROM pim_app.conversations WHERE public_chat_id = $3))", [ownerId, commandId, chatId]);
}

/**
 * Denies what a chat's agent waits on from the person, with the reason as the person's note, and lets each parked call know, so the call ends and nothing is left that no one can answer.
 * What Forge keeps for a coding thread, and a guest's call that asked the host, are not the chat's to withdraw.
 */
async function denyWaiting(tx: Tx, ownerId: string, chatId: string, why: string): Promise<void> {
	const denied = await tx.query(
		`UPDATE pim_app.approvals SET state = 'denied', decided_by = 'chat', decided_at = now(), args = args || $2::jsonb
		 WHERE public_chat_id = $1 AND state = 'waiting' AND NOT (args ? 'forgeApproval') AND NOT (args ? 'guestOwner') RETURNING id, args`,
		[chatId, JSON.stringify({ note: why })],
	);
	for (const a of denied.rows) if (a.args.taskId !== undefined) await enqueue(tx, ownerId, `approval:${a.id}`, "approval_decision", chatId, { taskId: a.args.taskId, approved: false, approvalId: a.id });
}

/** Stops a chat other than the one a command is for: what it waited on is denied, and its running turn is aborted. */
async function stopChat(tx: Tx, ownerId: string, chatId: string, commandId: string, why: string): Promise<void> {
	await denyWaiting(tx, ownerId, chatId, why);
	await enqueue(tx, ownerId, commandId, "abort", chatId, {});
}

/** The body of `updateTask`, in the caller's transaction. */
async function moveTask(tx: Tx, ownerId: string, taskId: string, status: string, result?: string): Promise<{ delivered: boolean }> {
	const { rows } = await tx.query("SELECT status, started_by, task_chat, batch FROM pim_app.tasks WHERE task_id = $1 FOR UPDATE", [taskId]);
	const task = rows[0];
	if (!task) throw new NotFoundError("No such task");
	if (task.status !== status && !TASK_NEXT[task.status]?.includes(status)) throw new ConflictError(`A ${task.status} task cannot become ${status}`, "bad_task_transition");
	await tx.query("UPDATE pim_app.tasks SET status = $2, result = coalesce($3, result), updated_at = now() WHERE task_id = $1", [taskId, status, result ?? null]);
	if (status === "canceled" && task.status !== "canceled" && task.task_chat) await stopChat(tx, ownerId, task.task_chat, `abort:task:${taskId}`, "Its task was canceled.");
	if (task.status === status) return { delivered: false };
	return deliverBatch(tx, ownerId, task.batch ?? taskId);
}

type TaskRow = { task_id: string; status: string; result: string | null; started_by: string; delivered: number; waits: boolean; waiter_task: string | null; position: number; updated_at: Date; by: string | null };
const TERMINAL = new Set(["completed", "failed", "canceled"]);

/** The message that gives a requester the answers of tasks it handed out together, and says which of them still wait for the person. */
export function taskUpdateText(done: readonly { id: string; status: string; result: string | null; by: string }[], waiting: readonly { id: string; by: string }[]): string {
	const outcome = (t: { id: string; status: string; result: string | null; by: string }) =>
		t.status === "completed" ? `${t.by} finished task ${t.id}:\n${t.result}` : t.status === "canceled" ? `Task ${t.id} for ${t.by} was canceled: ${t.result}` : `${t.by} didn't finish task ${t.id}: ${t.result}`;
	const headline = (t: { status: string; by: string }) => `${t.by} ${t.status === "completed" ? "answered" : t.status === "canceled" ? "was canceled" : "didn't finish"}`;
	return [`[Task update] ${done.map(headline).join("; ")}`, ...done.map(outcome), ...waiting.map((t) => `${t.by} is waiting for the person's approval on task ${t.id}; its answer will come in a later update.`)].join("\n\n");
}

/**
 * Tells a requester what came of the tasks it handed out together, once none of them is working: in one message, which wakes it. Those waiting for the person are named, and
 * answered in a later update of their own. A `delegate` call that waits gets nothing until every one of them is done, those waiting for the person too; then it is woken to return
 * the answers itself (`task_wake`). A chat that was deleted hears of nothing, and is not woken to.
 */
async function deliverBatch(tx: Tx, ownerId: string, batch: string): Promise<{ delivered: boolean }> {
	const tasks = (await tx.query(
		`SELECT t.task_id, t.status, t.result, t.started_by, t.delivered, t.waits, t.waiter_task, t.position, t.updated_at, a.name AS by
		 FROM pim_app.tasks t LEFT JOIN pim_app.agents a ON a.owner_id = t.owner_id AND a.id = t.agent_id WHERE t.batch = $1 ORDER BY t.position FOR UPDATE OF t`,
		[batch],
	)).rows as TaskRow[];
	if (tasks.length === 0 || tasks.some((t) => t.status === "working")) return { delivered: false };
	const requester = tasks[0]!.started_by;
	const done = tasks.filter((t) => TERMINAL.has(t.status) && t.delivered === 0);
	if (done.length === 0) return { delivered: false };
	if (!(await tx.query("SELECT 1 FROM pim_app.conversations WHERE public_chat_id = $1 AND deleted_at IS NULL", [requester])).rowCount) {
		await tx.query("UPDATE pim_app.tasks SET delivered = 1 WHERE batch = $1 AND status IN ('completed', 'failed', 'canceled')", [batch]);
		return { delivered: false };
	}
	if (tasks[0]!.waits) {
		if (tasks.some((t) => !TERMINAL.has(t.status)) || tasks[0]!.waiter_task === null) return { delivered: false };
		await enqueue(tx, ownerId, `task-wake:${createHash("sha256").update(batch).digest("hex").slice(0, 40)}`, "task_wake", requester, { taskId: Number(tasks[0]!.waiter_task) });
		return { delivered: true };
	}
	const text = taskUpdateText(
		done.map((t) => ({ id: t.task_id, status: t.status, result: t.result, by: t.by ?? "An agent" })),
		tasks.filter((t) => t.status === "auth-required").map((t) => ({ id: t.task_id, by: t.by ?? "An agent" })),
	);
	const commandId = `task-update:${createHash("sha256").update(done.map((t) => `${t.task_id}@${t.updated_at.toISOString()}`).join(",")).digest("hex").slice(0, 40)}`;
	await tx.query("UPDATE pim_app.tasks SET delivered = 1 WHERE task_id = ANY($1::text[])", [done.map((t) => t.task_id)]);
	await enqueue(tx, ownerId, commandId, "user_message", requester, { text, whenBusy: "followUp", tasks: done.map((t) => t.task_id) });
	// An agent at work on a task of its own goes on with the answers, and finishes its task once it has them all: its task now waits on that turn, which starts over what it has sent.
	await tx.query("UPDATE pim_app.tasks SET wake_request = $2, said = '[]' WHERE task_chat = $1 AND status IN ('working', 'auth-required')", [requester, requestId(ownerId, commandId)]);
	return { delivered: true };
}
