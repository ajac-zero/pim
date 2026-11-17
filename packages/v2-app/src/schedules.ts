import { QuotaError, type Quota } from "./quota.ts";
import { createHash } from "node:crypto";
import { Authorizer } from "./authz.ts";
import type { Db, Tx } from "./db.ts";
import { Conversations } from "./conversations.ts";
import { BadRequestError, NotFoundError } from "./errors.ts";
import { newId } from "./ids.ts";
import { OwnerId, type Principal } from "@pim/v2-contracts/identity";

/** The next time a 5-field cron expression (minute hour day month weekday; lists, ranges, steps and *) fires strictly after `after`, in UTC. */
export function nextCron(spec: string, after: Date): Date | null {
	const f = spec.trim().split(/\s+/);
	if (f.length !== 5) throw new BadRequestError("A cron schedule has five fields");
	const ranges: [number, number][] = [[0, 59], [0, 23], [1, 31], [1, 12], [0, 6]];
	const sets = f.map((field, i) => {
		const [lo, hi] = ranges[i]!;
		const out = new Set<number>();
		for (const part of field.split(",")) {
			const [range = "", stepText] = part.split("/");
			const step = stepText ? Number(stepText) : 1;
			const [a, b] = range === "*" ? [lo, hi] : range.includes("-") ? range.split("-").map(Number) as [number, number] : [Number(range), stepText ? hi : Number(range)];
			if (![a, b, step].every(Number.isInteger) || a! < lo || b! > hi || step < 1) throw new BadRequestError(`Bad cron field "${field}"`);
			for (let v = a!; v <= b!; v += step) out.add(v);
		}
		return out;
	}) as [Set<number>, Set<number>, Set<number>, Set<number>, Set<number>];
	const t = new Date(Math.floor(after.getTime() / 60_000) * 60_000 + 60_000);
	for (let i = 0; i < 4 * 366 * 24 * 60; i++, t.setTime(t.getTime() + 60_000)) {
		if (sets[0].has(t.getUTCMinutes()) && sets[1].has(t.getUTCHours()) && sets[3].has(t.getUTCMonth() + 1) && sets[2].has(t.getUTCDate()) && sets[4].has(t.getUTCDay())) return new Date(t);
	}
	return null;
}

export type ScheduleInput = { kind: "cron" | "at" | "delay"; spec: string; prompt: string; target?: "new_chat" | "same_chat"; chatId?: string; agentId?: string; now?: Date };

/** How late an occurrence may fire. Anything older was missed while nothing was running: it is recorded, never replayed. */
export const FIRE_GRACE_MS = 5 * 60_000;

export class Schedules {
	/** Per-space limits, when the deployment's application has them. */
	quota: Quota | undefined;
	constructor(private readonly db: Db, private readonly conversations = new Conversations(db), private readonly authz = new Authorizer(db)) {}

	async create(p: Principal, input: ScheduleInput): Promise<string> {
		await this.authz.enforce(p, "api:write");
		const now = input.now ?? new Date();
		const next = input.kind === "cron" ? nextCron(input.spec, now) : input.kind === "at" ? new Date(input.spec) : new Date(now.getTime() + Number(input.spec));
		if (!next || Number.isNaN(next.getTime())) throw new BadRequestError("That schedule never fires");
		const id = newId("sc");
		await this.db.owner(p.ownerId, async (tx) => {
			await this.quota?.admitNew(tx, p.ownerId, "schedules");
			await tx.query("INSERT INTO pim_app.schedules (id, owner_id, agent_id, kind, spec, target, chat_id, prompt, next_run_at) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)", [id, p.ownerId, input.agentId ?? null, input.kind, input.spec, input.target ?? "new_chat", input.chatId ?? null, input.prompt, next]);
			await wake(tx, p.ownerId);
		});
		return id;
	}

	/** Owners with something due: what a scheduler loop asks before it ticks each owner. */
	async dueOwners(now: Date): Promise<string[]> {
		return this.db.anonymous(async (tx) => (await tx.query("SELECT owner_id FROM pim_app.schedule_wakeups WHERE next_at <= $1 ORDER BY next_at LIMIT 100", [now])).rows.map((r) => r.owner_id));
	}

	/**
	 * Fires what is due for one owner. Of the occurrences since a schedule last ran, only the latest one within FIRE_GRACE_MS fires (once);
	 * every earlier one is recorded as `missed`, so a restart or cutover never produces a storm. The command id carries the occurrence, so
	 * two ticks racing fire it once. An owner who is suspended or deleted fires nothing.
	 */
	async tick(ownerId: string, now: Date): Promise<{ fired: number; missed: number }> {
		const account = await this.authz.account(ownerId);
		if (!account || account.status !== "active") return { fired: 0, missed: 0 };
		const principal: Principal = { kind: "agent", ownerId: OwnerId.parse(ownerId), agentId: "scheduler" };
		const due = await this.db.owner(ownerId, async (tx) => (await tx.query("SELECT * FROM pim_app.schedules WHERE enabled AND next_run_at <= $1 ORDER BY next_run_at", [now])).rows);
		let fired = 0;
		let missed = 0;
		for (const s of due) {
			const occurrences: Date[] = [];
			let at: Date | null = s.next_run_at;
			while (at && at <= now && occurrences.length < 1000) {
				occurrences.push(at);
				at = s.kind === "cron" ? nextCron(s.spec, at) : null;
			}
			const latest = occurrences.at(-1)!;
			let fire = now.getTime() - latest.getTime() <= FIRE_GRACE_MS;
			// The command is admitted before the schedule moves on. Its id and its new chat's id come from the occurrence, so a second tick, or one
			// repeating after a crash between the two steps, admits nothing new.
			if (fire) {
				const commandId = `sched:${s.id}:${latest.toISOString()}`;
				let chatId: string | undefined = s.chat_id ?? undefined;
				if (s.target === "new_chat") {
					chatId = createHash("sha256").update(commandId).digest("hex").replace(/^(.{8})(.{4}).(.{3}).(.{3})(.{12}).*$/, "$1-$2-5$3-a$4-$5");
					await this.conversations.create(principal, { id: chatId, agentId: s.agent_id ?? undefined, title: s.prompt.slice(0, 60), kind: "trigger" }).catch((error) => {
						if ((error as { code?: string }).code !== "23505") throw error;
					});
				}
				// A space that has used its day's allowance does not run: the occurrence is recorded as missed, and the schedule moves on.
				const admission = await this.conversations.admit(principal, { commandId, kind: "trigger_fire", chatId, payload: { text: s.prompt, schedule: s.id } }).catch((error) => {
					if (error instanceof QuotaError) return null;
					throw error;
				});
				if (!admission) fire = false;
				else if (!admission.duplicate) fired++;
			}
			const won = await this.db.owner(ownerId, async (tx) => {
				const locked = await tx.query("SELECT 1 FROM pim_app.schedules WHERE id = $1 AND next_run_at = $2 FOR UPDATE SKIP LOCKED", [s.id, s.next_run_at]);
				if (!locked.rowCount) return false; // another tick took it
				for (const occ of occurrences) {
					const isFire = fire && occ === latest;
					await tx.query("INSERT INTO pim_app.schedule_runs (owner_id, schedule_id, occurrence, outcome, command_id) VALUES ($1,$2,$3,$4,$5) ON CONFLICT DO NOTHING", [ownerId, s.id, occ, isFire ? "fired" : "missed", isFire ? `sched:${s.id}:${occ.toISOString()}` : null]);
				}
				await tx.query("UPDATE pim_app.schedules SET next_run_at = $2, enabled = $3 WHERE id = $1", [s.id, at, at !== null]);
				await wake(tx, ownerId);
				return true;
			});
			if (won) missed += occurrences.length - (fire ? 1 : 0);
		}
		return { fired, missed };
	}

	async list(p: Principal) {
		await this.authz.enforce(p, "api:read");
		return this.db.owner(p.ownerId, async (tx) => (await tx.query("SELECT id, kind, spec, target, prompt, next_run_at, enabled FROM pim_app.schedules ORDER BY created_at")).rows.map((r) => ({ id: r.id as string, kind: r.kind as string, spec: r.spec as string, target: r.target as string, prompt: r.prompt as string, nextRunAt: r.next_run_at as Date | null, enabled: r.enabled as boolean })));
	}

	async remove(p: Principal, id: string): Promise<void> {
		await this.authz.enforce(p, "api:write");
		await this.db.owner(p.ownerId, async (tx) => {
			if (!(await tx.query("DELETE FROM pim_app.schedules WHERE id = $1", [id])).rowCount) throw new NotFoundError("No such schedule");
			await wake(tx, p.ownerId);
		});
	}

	async runs(ownerId: string, scheduleId: string): Promise<{ occurrence: Date; outcome: string }[]> {
		return this.db.owner(ownerId, async (tx) => {
			const { rows } = await tx.query("SELECT occurrence, outcome FROM pim_app.schedule_runs WHERE schedule_id = $1 ORDER BY occurrence", [scheduleId]);
			if (!rows.length && !(await tx.query("SELECT 1 FROM pim_app.schedules WHERE id = $1", [scheduleId])).rowCount) throw new NotFoundError("No such schedule");
			return rows.map((r) => ({ occurrence: r.occurrence, outcome: r.outcome }));
		});
	}
}

async function wake(tx: Tx, ownerId: string): Promise<void> {
	const next = (await tx.query("SELECT min(next_run_at) AS next FROM pim_app.schedules WHERE enabled AND next_run_at IS NOT NULL")).rows[0].next as Date | null;
	if (next) await tx.query("INSERT INTO pim_app.schedule_wakeups (owner_id, next_at) VALUES ($1, $2) ON CONFLICT (owner_id) DO UPDATE SET next_at = excluded.next_at", [ownerId, next]);
	else await tx.query("DELETE FROM pim_app.schedule_wakeups WHERE owner_id = $1", [ownerId]);
}
