// Evidence-based stall supervision: what a thread has actually done decides whether its originating chat is woken, once per quiet spell, with one escalation.
import { type Db, type Row, tx } from "./db";
import { type ForgeStore } from "./store";
import { stallWake } from "./wakes";

export const ESCALATED_STALL_MS = 45 * 60_000;
const ESCALATION_GAP_MS = 30 * 60_000;
const QUIET_TOOL_MS = 5 * 60_000;
const QUIET_TRANSCRIPT_MS = 15 * 60_000;

type Stall = { key: string; reason: string; since: number; actionable?: false };
export type Activity = { lastActivityAt: number; stalls: Stall[] };

/** The newest sign of life a stall set carries: the last activity, or the output a stall key says it followed. */
export function progressOf(a: Activity): number {
	return Math.max(a.lastActivityAt, ...a.stalls.map((s) => Number(/^(?:tool:.+:|transcript:)(\d+)$/.exec(s.key)?.[1] ?? 0)));
}

export class Journal {
	constructor(
		private readonly db: Db,
		private readonly clock: () => number = Date.now,
	) {}
	/** `timeoutMs: null` marks a status or wait tool: it may be quiet for as long as it likes inside its own wait, and is shown, never woken for. */
	async begin(threadId: string, callId: string, tool: string, args: { timeoutMs?: number | null } & Record<string, unknown> = {}) {
		await this.db.query("insert into pim_forge.forge_tool_journal (thread_id, call_id, tool, args, at) values ($1,$2,$3,$4,$5) on conflict do nothing", [threadId, callId, tool, args, new Date(this.clock())]);
	}
	async end(threadId: string, callId: string, result: object) {
		await this.db.query("update pim_forge.forge_tool_journal set result = $3 where thread_id = $1 and call_id = $2", [threadId, callId, result]);
	}
}

export class StallSupervisor {
	constructor(
		private readonly db: Db,
		private readonly store: ForgeStore,
		private readonly clock: () => number = Date.now,
	) {}

	async activity(threadId: string): Promise<Activity | null> {
		const t = (await this.db.query<Row>("select state, created_at from pim_forge.forge_threads where thread_id = $1", [threadId])).rows[0];
		if (!t || t.state !== "running") return null;
		const now = this.clock();
		const last = (await this.db.query<Row>("select max(at) a from pim_forge.forge_events where thread_id = $1", [threadId])).rows[0]?.a;
		const lastActivityAt = Math.max(new Date(t.created_at).getTime(), last ? new Date(last).getTime() : 0);
		const stalls: Stall[] = [];
		const open = (await this.db.query<Row>("select call_id, args, at from pim_forge.forge_tool_journal where thread_id = $1 and result is null", [threadId])).rows;
		for (const call of open) {
			const startedAt = new Date(call.at).getTime();
			const timeoutMs: number | null = call.args?.timeoutMs ?? null;
			if (timeoutMs !== null && now - startedAt > timeoutMs) stalls.push({ key: `tool:${call.call_id}`, reason: "past declared timeout", since: startedAt });
			else if (now - Math.max(startedAt, lastActivityAt) > QUIET_TOOL_MS) stalls.push({ key: `tool:${call.call_id}:${Math.max(startedAt, lastActivityAt)}`, reason: "no output for five minutes", since: startedAt, ...(timeoutMs === null ? { actionable: false as const } : {}) });
		}
		if (now - lastActivityAt > QUIET_TRANSCRIPT_MS) stalls.push({ key: `transcript:${lastActivityAt}`, reason: "running with no transcript activity for fifteen minutes", since: lastActivityAt });
		return { lastActivityAt, stalls };
	}

	/** Claims and sends the wake a thread's stalls call for: 0 none, 1 first of a quiet spell, 2 its one escalation. The wake is deduplicated by `stall:<source>:<stage>:<progress>`. */
	async check(threadId: string): Promise<0 | 1 | 2> {
		const activity = await this.activity(threadId);
		if (!activity) return 0;
		const source = threadId;
		const now = this.clock();
		return tx(this.db, async (q) => {
			await q.query("select pg_advisory_xact_lock(hashtext($1))", [`stall:${source}`]);
			const actionable = activity.stalls.filter((s) => s.actionable !== false);
			if (!actionable.length) return 0;
			const prev = (await q.query<Row>("select * from pim_forge.forge_stall_episodes where source = $1", [source])).rows[0];
			const progress = progressOf(activity);
			const hard = actionable.some((s) => s.reason === "past declared timeout") ? 1 : 0;
			let stage: 0 | 1 | 2 = 0;
			if (!prev || progress > Number(prev.progress_at)) stage = 1;
			else if (prev.stage === 1 && ((hard === 1 && prev.hard === 0) || (now - progress >= ESCALATED_STALL_MS && now - Number(prev.woken_at) >= ESCALATION_GAP_MS))) stage = 2;
			if (!stage) return 0;
			await q.query(
				"insert into pim_forge.forge_stall_episodes (source, progress_at, stage, woken_at, hard) values ($1,$2,$3,$4,$5) on conflict (source) do update set progress_at = $2, stage = $3, woken_at = $4, hard = $5",
				[source, progress, stage, now, hard],
			);
			const thread = (await q.query<Row>("select chat_id from pim_forge.forge_threads where thread_id = $1", [threadId])).rows[0];
			if (thread?.chat_id) {
				const wake = stallWake(threadId, stage, progress);
				await this.store.emit(q, "wake", wake.wakeId, threadId, { chatId: thread.chat_id, kind: "stall", reasons: actionable.map((s) => s.reason), ...wake });
			}
			return stage;
		});
	}

	/** A turn ended: the next stall is a new quiet spell. */
	async clear(threadId: string) {
		await this.db.query("delete from pim_forge.forge_stall_episodes where source = $1", [threadId]);
	}
}
