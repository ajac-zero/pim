// Forge's thread store: fenced PostgreSQL rows in place of CodingThreadDO's SQLite.
// Every write that steps a thread goes through `fenced`, which names the lease epoch it was granted, so two workers never step one thread.
import { randomUUID } from "node:crypto";
import { type Db, type Queryable, type Row, tx } from "./db";
import { ForgeError, LeaseLostError } from "./errors";
import { codingThreadId, threadRef } from "./identity";
import { type Harness } from "./harnesses";
import { completionWake } from "./wakes";

export type ThreadState = "provisioning" | "queued" | "idle" | "running" | "waiting_input" | "failed" | "archived";

export type StartInput = {
	ownerId: string;
	operationId: string;
	harness: Harness;
	task: string;
	repo: string;
	ref?: string | null;
	chatId?: string | null;
	createdBy: string;
	budgetUsd?: number | null;
	limits?: object | null;
	profile?: object | null;
};

export type ThreadRow = {
	threadId: string;
	ownerId: string;
	startOperation: string;
	harness: Harness;
	state: ThreadState;
	stateReason: string | null;
	stateDetail: string | null;
	task: string;
	repo: string;
	ref: string | null;
	branch: string | null;
	baseSha: string | null;
	lastPushedSha: string | null;
	pullRequest: { url: string; number: number } | null;
	chatId: string | null;
	createdBy: string;
	workspaceRef: any;
	placement: any;
	orb: { threadId: string; url: string; client?: string; /** The operation whose turn is running on the remote thread. */ turn?: string; /** The total dollars the orb has reported so far, so each sync records only the difference. */ reportedUsd?: number; /** The branch Amp pushed its work to, once known. */ branch?: string } | null;
	provisioning: any;
	budgetUsd: number | null;
	spentUsd: number;
	consecutiveInterrupts: number;
	gatewayNonce: string;
	leaseHolder: string | null;
	leaseEpoch: number;
	cancelState: "none" | "requested" | "cancelled" | "uncertain";
	archivedAt: Date | null;
	computeTornDownAt: Date | null;
};

export const toThread = (r: Row): ThreadRow => ({
	threadId: r.thread_id,
	ownerId: r.owner_id,
	startOperation: r.start_operation,
	harness: r.harness,
	state: r.state,
	stateReason: r.state_reason,
	stateDetail: r.state_detail,
	task: r.task,
	repo: r.repo,
	ref: r.ref,
	branch: r.branch,
	baseSha: r.base_sha,
	lastPushedSha: r.last_pushed_sha,
	pullRequest: r.pull_request,
	chatId: r.chat_id,
	createdBy: r.created_by,
	workspaceRef: r.workspace_ref,
	placement: r.placement,
	orb: r.orb,
	provisioning: r.provisioning,
	budgetUsd: r.budget_usd === null ? null : Number(r.budget_usd),
	spentUsd: Number(r.spent_usd),
	consecutiveInterrupts: r.consecutive_interrupts,
	gatewayNonce: r.gateway_nonce,
	leaseHolder: r.lease_holder,
	leaseEpoch: Number(r.lease_epoch),
	cancelState: r.cancel_state,
	archivedAt: r.archived_at,
	computeTornDownAt: r.compute_torn_down_at,
});

export type EventInput = { kind: string; role?: string | null; data?: object; costUsd?: number; tokensIn?: number; tokensOut?: number; sourceCursor?: string | null };

export type OutboxTopic = "projection" | "wake" | "cost_ledger";

/** A thread slug for the pim/<slug>-<id> branch name. */
export function branchFor(task: string, threadId: string, prefix = "pim/"): string {
	const slug = task.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 32).replace(/-+$/, "") || "task";
	return `${prefix}${slug}-${threadId.slice(0, 8)}`;
}

export class ForgeStore {
	constructor(
		readonly db: Db,
		readonly now: () => Date = () => new Date(),
	) {}

	/** Starts a thread, or finds the one this (owner, operation) already made: the same start is always the same thread. */
	async start(input: StartInput, branchPrefix = "pim/"): Promise<{ thread: ThreadRow; created: boolean }> {
		const threadId = codingThreadId(input.ownerId, input.operationId);
		const r = await this.db.query<Row>(
			`insert into pim_forge.forge_threads (thread_id, owner_id, start_operation, harness, state, task, repo, ref, branch, chat_id, created_by, budget_usd, limits, profile, gateway_nonce)
			 values ($1,$2,$3,$4,'provisioning',$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)
			 on conflict (owner_id, start_operation) do nothing returning *`,
			[threadId, input.ownerId, input.operationId, input.harness, input.task, input.repo, input.ref ?? null, input.harness === "amp" ? null : branchFor(input.task, threadId, branchPrefix), input.chatId ?? null, input.createdBy, input.budgetUsd ?? null, input.limits ?? null, input.profile ?? null, randomUUID()],
		);
		if (r.rows[0]) return { thread: toThread(r.rows[0]), created: true };
		return { thread: (await this.get(threadId))!, created: false };
	}

	async get(threadId: string, q: Queryable = this.db): Promise<ThreadRow | null> {
		const r = await q.query<Row>("select * from pim_forge.forge_threads where thread_id = $1", [threadId]);
		return r.rows[0] ? toThread(r.rows[0]) : null;
	}

	/** A thread of this owner by id, page URL, Amp `T-…` id or Amp page URL; not_found for one that is not theirs. */
	async find(ownerId: string, given: string): Promise<ThreadRow> {
		const ref = threadRef(given);
		const r =
			ref.kind === "amp"
				? await this.db.query<Row>("select * from pim_forge.forge_threads where owner_id = $1 and (orb ->> 'threadId' = $2 or orb ->> 'url' like '%/' || $2)", [ownerId, ref.id])
				: ref.id.length <= 128
					? await this.db.query<Row>("select * from pim_forge.forge_threads where owner_id = $1 and thread_id = $2", [ownerId, ref.id])
					: { rows: [] };
		if (!r.rows[0]) throw new ForgeError("not_found", `No coding thread ${given}`);
		return toThread(r.rows[0]);
	}

	/** Takes the thread's lease for `holder`, or null while another holds it unexpired. A takeover bumps the epoch, which fences the old holder out. */
	async acquireLease(threadId: string, holder: string, ttlMs: number): Promise<number | null> {
		const r = await this.db.query<Row>(
			`update pim_forge.forge_threads set
			   lease_epoch = case when lease_holder = $2 then lease_epoch else lease_epoch + 1 end,
			   lease_holder = $2, lease_expires_at = now() + ($3 || ' milliseconds')::interval
			 where thread_id = $1 and (lease_holder is null or lease_holder = $2 or lease_expires_at < now())
			 returning lease_epoch`,
			[threadId, holder, String(ttlMs)],
		);
		return r.rows[0] ? Number(r.rows[0].lease_epoch) : null;
	}

	async releaseLease(threadId: string, holder: string, epoch: number): Promise<void> {
		await this.db.query("update pim_forge.forge_threads set lease_holder = null, lease_expires_at = null where thread_id = $1 and lease_holder = $2 and lease_epoch = $3", [threadId, holder, epoch]);
	}

	/** Runs `fn` in a transaction holding the thread's row, after checking the epoch is still this worker's. */
	async fenced<T>(threadId: string, epoch: number, fn: (q: Queryable, thread: ThreadRow) => Promise<T>): Promise<T> {
		return tx(this.db, async (q) => {
			const row = (await q.query<Row>("select * from pim_forge.forge_threads where thread_id = $1 for update", [threadId])).rows[0];
			if (!row || Number(row.lease_epoch) !== epoch) throw new LeaseLostError(threadId);
			return fn(q, toThread(row));
		});
	}

	/** Runs `fn` with the thread's row locked and no lease check, for API calls (steer, abort, archive) that are not a worker's step. */
	async locked<T>(threadId: string, fn: (q: Queryable, thread: ThreadRow) => Promise<T>): Promise<T> {
		return tx(this.db, async (q) => {
			const row = (await q.query<Row>("select * from pim_forge.forge_threads where thread_id = $1 for update", [threadId])).rows[0];
			if (!row) throw new ForgeError("not_found", `No coding thread ${threadId}`);
			return fn(q, toThread(row));
		});
	}

	async setState(q: Queryable, threadId: string, state: ThreadState, reason: string | null = null, detail: string | null = null): Promise<void> {
		await q.query("update pim_forge.forge_threads set state = $2, state_reason = $3, state_detail = $4, updated_at = now() where thread_id = $1", [threadId, state, reason, detail]);
		await this.emit(q, "projection", `state:${threadId}:${state}:${reason ?? ""}:${Date.now()}:${randomUUID()}`, threadId, { type: "coding.state", threadId, state, reason });
	}

	async patch(q: Queryable, threadId: string, fields: Record<string, unknown>): Promise<void> {
		const keys = Object.keys(fields);
		if (!keys.length) return;
		const cols = new Set(["workspace_ref", "placement", "orb", "provisioning", "branch", "base_sha", "last_pushed_sha", "pull_request", "consecutive_interrupts", "last_seen_at", "resolved_profile", "cancel_state", "compute_torn_down_at", "gateway_nonce"]);
		for (const k of keys) if (!cols.has(k)) throw new Error(`patch: unsupported column ${k}`);
		await q.query(`update pim_forge.forge_threads set ${keys.map((k, i) => `${k} = $${i + 2}`).join(", ")}, updated_at = now() where thread_id = $1`, [threadId, ...keys.map((k) => (fields[k] !== null && typeof fields[k] === "object" ? JSON.stringify(fields[k]) : fields[k]))]);
	}

	/** Appends an event; a replayed source cursor is dropped and returns null. Cost lands on the thread's spend and the cost ledger once. */
	async appendEvent(q: Queryable, threadId: string, e: EventInput): Promise<number | null> {
		const seq = Number((await q.query<Row>("select coalesce(max(seq), 0) + 1 as n from pim_forge.forge_events where thread_id = $1", [threadId])).rows[0]!.n);
		const r = await q.query(
			`insert into pim_forge.forge_events (thread_id, seq, kind, role, data, cost_usd, tokens_in, tokens_out, source_cursor) values ($1,$2,$3,$4,$5,$6,$7,$8,$9) on conflict do nothing`,
			[threadId, seq, e.kind, e.role ?? null, e.data ?? {}, e.costUsd ?? 0, e.tokensIn ?? 0, e.tokensOut ?? 0, e.sourceCursor ?? null],
		);
		if (!r.rowCount) return null;
		if (e.costUsd) {
			await q.query("update pim_forge.forge_threads set spent_usd = spent_usd + $2 where thread_id = $1", [threadId, e.costUsd]);
			await this.emit(q, "cost_ledger", `cost:${threadId}:${seq}`, threadId, { run_kind: "coding_thread", threadId, costUsd: e.costUsd, tokensIn: e.tokensIn ?? 0, tokensOut: e.tokensOut ?? 0 });
		}
		return seq;
	}

	/** Wakes the chat that started the thread, once per (thread, operation). Returns false when it was already sent or the thread has no chat. */
	async emitCompletionWake(q: Queryable, t: Pick<ThreadRow, "threadId" | "chatId">, operationId: string, outcome: "completed" | "failed" | "cancelled", summary?: string | null): Promise<boolean> {
		if (!t.chatId) return false;
		const wake = completionWake(t.threadId, operationId, outcome, summary);
		return this.emit(q, "wake", wake.wakeId, t.threadId, { chatId: t.chatId, ...wake });
	}

	async emit(q: Queryable, topic: OutboxTopic, dedupeKey: string, threadId: string | null, payload: object): Promise<boolean> {
		const r = await q.query("insert into pim_forge.forge_outbox (topic, dedupe_key, thread_id, payload) values ($1,$2,$3,$4) on conflict (dedupe_key) do nothing", [topic, dedupeKey, threadId, payload]);
		return (r.rowCount ?? 0) > 0;
	}

	/** Queues an input for the thread; the same operation id again is the same input. */
	async enqueueInbox(q: Queryable, threadId: string, operationId: string, kind: string, payload: object = {}): Promise<boolean> {
		const r = await q.query("insert into pim_forge.forge_inbox (thread_id, operation_id, kind, payload) values ($1,$2,$3,$4) on conflict (thread_id, operation_id) do nothing", [threadId, operationId, kind, payload]);
		return (r.rowCount ?? 0) > 0;
	}

	async takeInbox(q: Queryable, threadId: string): Promise<{ seq: number; operationId: string; kind: string; payload: any }[]> {
		const r = await q.query<Row>("update pim_forge.forge_inbox set status = 'taken' where thread_id = $1 and status = 'pending' returning seq, operation_id, kind, payload", [threadId]);
		return r.rows.map((x) => ({ seq: Number(x.seq), operationId: x.operation_id, kind: x.kind, payload: x.payload })).sort((a, b) => a.seq - b.seq);
	}

	async events(threadId: string, o: { role?: string; kind?: string; tail?: number } = {}): Promise<Row[]> {
		const rows = (await this.db.query<Row>("select * from pim_forge.forge_events where thread_id = $1 and ($2::text is null or role = $2) and ($3::text is null or kind = $3) order by seq", [threadId, o.role ?? null, o.kind ?? null])).rows;
		return o.tail ? rows.slice(-o.tail) : rows;
	}

	/** Rotates the nonce, which invalidates every pimgit_ and pimgw_ token issued for the thread at once. */
	async revokeCredentials(q: Queryable, threadId: string): Promise<void> {
		await q.query("update pim_forge.forge_threads set gateway_nonce = $2 where thread_id = $1", [threadId, randomUUID()]);
	}
}
