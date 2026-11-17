// ForgeScheduler: the pool and slot scheduler CodingSchedulerDO ran as one DO per space, as transaction- and advisory-locked PostgreSQL scheduling, deployment-wide.
import { POOL_COOLDOWN_MS, type PoolBreaker, closedPool, poolAvailable, poolResult, reservePool } from "@pim/coding/pool-breaker";
import { type Db, type Queryable, type Row, tx } from "./db";
import { ForgeError } from "./errors";
import { type ForgeStore } from "./store";

/** A queued thread waits this long for a slot, is requeued once, and then fails. */
export const QUEUE_DEADLINE_MS = 30 * 60_000;
/** A held workspace with nothing to do keeps its slot this long. */
export const IDLE_SLOT_GRACE_MS = 2 * 60_000;
export { POOL_COOLDOWN_MS };

export type Admission = { kind: "slot"; poolId: string; probe: boolean } | { kind: "queued"; poolId: string; position: number } | { kind: "unhealthy"; poolId: string };

const lockPool = (q: Queryable, poolId: string) => q.query("select pg_advisory_xact_lock(hashtext($1))", [`forge_pool:${poolId}`]);

export class ForgeScheduler {
	constructor(
		private readonly db: Db,
		private readonly store: ForgeStore,
		readonly clock: () => number = Date.now,
	) {}

	private at = (ms: number) => new Date(ms);

	async upsertPool(p: { poolId: string; provider: string; size: number; priority?: number; enabled?: boolean }): Promise<void> {
		await this.db.query(
			`insert into pim_forge.forge_pools (pool_id, provider, size, priority, enabled) values ($1,$2,$3,$4,$5)
			 on conflict (pool_id) do update set provider = $2, size = $3, priority = $4, enabled = $5`,
			[p.poolId, p.provider, p.size, p.priority ?? 0, p.enabled ?? true],
		);
		await this.db.query("insert into pim_forge.forge_pool_breakers (pool_id) values ($1) on conflict do nothing", [p.poolId]);
	}

	private async breaker(q: Queryable, poolId: string): Promise<PoolBreaker> {
		const r = (await q.query<Row>("select * from pim_forge.forge_pool_breakers where pool_id = $1 for update", [poolId])).rows[0];
		return r ? { failures: r.failures, retryAt: r.retry_at ? new Date(r.retry_at).getTime() : null, probe: r.probe } : closedPool();
	}

	private async saveBreaker(q: Queryable, poolId: string, b: PoolBreaker): Promise<void> {
		await q.query("update pim_forge.forge_pool_breakers set failures = $2, retry_at = $3, probe = $4 where pool_id = $1", [poolId, b.failures, b.retryAt === null ? null : this.at(b.retryAt), b.probe]);
	}

	/** Quotas: the most specific of user, tenant, deployment that sets a number applies to that number. Thrown as `quota` so a second thread fails with compute_quota. */
	async checkQuota(q: Queryable, ownerId: string, tenantId: string | null, opts: { startingWorkspaceThread: boolean }): Promise<void> {
		const rows = (
			await q.query<Row>("select * from pim_forge.forge_quotas where (subject_type, subject_id) in (('user', $1), ('tenant', $2), ('deployment', '*'))", [ownerId, tenantId ?? ""])
		).rows;
		const pick = (col: string): number | null => {
			for (const type of ["user", "tenant", "deployment"]) {
				const v = rows.find((r) => r.subject_type === type)?.[col];
				if (v !== null && v !== undefined) return Number(v);
			}
			return null;
		};
		const maxConcurrent = pick("max_concurrent");
		if (opts.startingWorkspaceThread && maxConcurrent !== null) {
			const held = Number((await q.query<Row>("select count(*) c from pim_forge.forge_slots where owner_id = $1", [ownerId])).rows[0]!.c);
			if (held >= maxConcurrent) throw new ForgeError("quota", `compute_quota: ${maxConcurrent} concurrent coding workspaces are allowed`);
		}
		const minutes = pick("compute_minutes");
		if (minutes !== null) {
			const used = Number((await q.query<Row>(`select coalesce(sum(extract(epoch from (coalesce(ended_at, $2) - began_at))) / 60, 0) m from pim_forge.forge_compute_usage where owner_id = $1 and began_at >= date_trunc('month', $2::timestamptz)`, [ownerId, this.at(this.clock())])).rows[0]!.m);
			if (used >= minutes) throw new ForgeError("quota", `compute_quota: ${minutes} compute minutes this month are spent`);
		}
		const usd = pick("usd");
		if (usd !== null) {
			const spent = Number((await q.query<Row>(`select coalesce(sum(spent_usd), 0) s from pim_forge.forge_threads where owner_id = $1 and created_at >= date_trunc('month', $2::timestamptz)`, [ownerId, this.at(this.clock())])).rows[0]!.s);
			if (spent >= usd) throw new ForgeError("quota", `usd_quota: $${usd} of coding spend this month is used`);
		}
	}

	/** Gives the thread a slot in the pool, or queues it behind those already waiting (FIFO). Amp threads never come here. */
	async admit(threadId: string, poolId: string, ownerId: string, tenantId: string | null = null): Promise<Admission> {
		return tx(this.db, async (q) => {
			await lockPool(q, poolId);
			const pool = (await q.query<Row>("select * from pim_forge.forge_pools where pool_id = $1", [poolId])).rows[0];
			if (!pool || !pool.enabled) return { kind: "unhealthy", poolId } as Admission;
			const existing = (await q.query("select 1 from pim_forge.forge_slots where thread_id = $1", [threadId])).rows.length;
			if (existing) return { kind: "slot", poolId, probe: false } as Admission;
			await this.checkQuota(q, ownerId, tenantId, { startingWorkspaceThread: true });
			const now = this.clock();
			const b = await this.breaker(q, poolId);
			if (!poolAvailable(b, now)) return { kind: "unhealthy", poolId } as Admission;
			const held = Number((await q.query<Row>("select count(*) c from pim_forge.forge_slots where pool_id = $1", [poolId])).rows[0]!.c);
			const waiting = Number((await q.query<Row>("select count(*) c from pim_forge.forge_queue where pool_id = $1 and thread_id <> $2", [poolId, threadId])).rows[0]!.c);
			if (held < pool.size && waiting === 0) {
				await this.takeSlot(q, threadId, poolId, ownerId);
				const reserved = reservePool(b, threadId);
				await this.saveBreaker(q, poolId, reserved);
				return { kind: "slot", poolId, probe: b.retryAt !== null } as Admission;
			}
			await q.query(
				"insert into pim_forge.forge_queue (thread_id, pool_id, owner_id, deadline_at) values ($1,$2,$3,$4) on conflict (thread_id) do nothing",
				[threadId, poolId, ownerId, this.at(now + QUEUE_DEADLINE_MS)],
			);
			const position = Number((await q.query<Row>("select count(*) c from pim_forge.forge_queue where pool_id = $1 and seq <= (select seq from pim_forge.forge_queue where thread_id = $2)", [poolId, threadId])).rows[0]!.c);
			await this.store.setState(q, threadId, "queued", "pool_full", null);
			return { kind: "queued", poolId, position } as Admission;
		});
	}

	private async takeSlot(q: Queryable, threadId: string, poolId: string, ownerId: string) {
		const at = this.at(this.clock());
		await q.query("delete from pim_forge.forge_queue where thread_id = $1", [threadId]);
		await q.query("insert into pim_forge.forge_slots (thread_id, pool_id, owner_id, acquired_at) values ($1,$2,$3,$4)", [threadId, poolId, ownerId, at]);
		const provider = (await q.query<Row>("select provider from pim_forge.forge_pools where pool_id = $1", [poolId])).rows[0]!.provider;
		await q.query("insert into pim_forge.forge_compute_usage (owner_id, thread_id, provider, began_at, reason) values ($1,$2,$3,$4,'slot')", [ownerId, threadId, provider, at]);
	}

	/** Promotes in every pool: fills slots freed by a caller that couldn't, and expires overdue waiters (the 30-minute deadline). */
	async sweep(): Promise<string[]> {
		const pools = (await this.db.query<Row>("select pool_id from pim_forge.forge_pools")).rows.map((r) => r.pool_id as string);
		const out: string[] = [];
		for (const p of pools) out.push(...(await this.promote(p)));
		return out;
	}

	/** Frees the thread's slot, ends its compute stretch and admits the next waiting threads. */
	async release(threadId: string, reason = "released", o: { promote?: boolean } = {}): Promise<string[]> {
		const poolId = await tx(this.db, async (q) => {
			const slot = (await q.query<Row>("delete from pim_forge.forge_slots where thread_id = $1 returning pool_id", [threadId])).rows[0];
			await q.query("delete from pim_forge.forge_queue where thread_id = $1", [threadId]);
			await q.query("update pim_forge.forge_compute_usage set ended_at = $2, reason = $3 where thread_id = $1 and ended_at is null", [threadId, this.at(this.clock()), reason]);
			return slot?.pool_id as string | undefined;
		});
		// A caller that sees only one owner's rows (the Gate) leaves promotion to the worker's sweep, which sees them all.
		return poolId && o.promote !== false ? this.promote(poolId) : [];
	}

	/** Expires overdue queue entries (requeue once, then fail), then fills free slots in FIFO order. Returns the threads that got a slot. */
	async promote(poolId: string): Promise<string[]> {
		return tx(this.db, async (q) => {
			await lockPool(q, poolId);
			const now = this.clock();
			const overdue = (await q.query<Row>("select * from pim_forge.forge_queue where pool_id = $1 and deadline_at <= $2 order by seq for update", [poolId, this.at(now)])).rows;
			for (const e of overdue) {
				if (!e.requeued) {
					await q.query("delete from pim_forge.forge_queue where thread_id = $1", [e.thread_id]);
					await q.query("insert into pim_forge.forge_queue (thread_id, pool_id, owner_id, deadline_at, requeued) values ($1,$2,$3,$4,true)", [e.thread_id, poolId, e.owner_id, this.at(now + QUEUE_DEADLINE_MS)]);
				} else {
					await q.query("delete from pim_forge.forge_queue where thread_id = $1", [e.thread_id]);
					await this.store.setState(q, e.thread_id, "failed", "queue_timeout", "No workspace slot became free in time, even after one requeue");
				}
			}
			const pool = (await q.query<Row>("select * from pim_forge.forge_pools where pool_id = $1", [poolId])).rows[0];
			if (!pool?.enabled) return [];
			const promoted: string[] = [];
			let b = await this.breaker(q, poolId);
			for (;;) {
				const held = Number((await q.query<Row>("select count(*) c from pim_forge.forge_slots where pool_id = $1", [poolId])).rows[0]!.c);
				if (held >= pool.size || !poolAvailable(b, now)) break;
				const next = (await q.query<Row>("select * from pim_forge.forge_queue where pool_id = $1 order by seq limit 1 for update", [poolId])).rows[0];
				if (!next) break;
				try {
					await this.checkQuota(q, next.owner_id, null, { startingWorkspaceThread: true });
				} catch (error) {
					// Over quota now: the thread fails the way a direct admission would, and the ones behind it go on.
					await q.query("delete from pim_forge.forge_queue where thread_id = $1", [next.thread_id]);
					await this.store.setState(q, next.thread_id, "failed", "compute_quota", error instanceof Error ? error.message : null);
					continue;
				}
				await this.takeSlot(q, next.thread_id, poolId, next.owner_id);
				b = reservePool(b, next.thread_id);
				await this.store.setState(q, next.thread_id, "provisioning", null, null);
				promoted.push(next.thread_id);
			}
			await this.saveBreaker(q, poolId, b);
			return promoted;
		});
	}

	/** The held workspace has nothing to do: its slot is released after the idle grace unless work arrives. */
	async markIdle(threadId: string): Promise<void> {
		await this.db.query("update pim_forge.forge_slots set idle_since = coalesce(idle_since, $2) where thread_id = $1", [threadId, this.at(this.clock())]);
	}

	async markBusy(threadId: string): Promise<void> {
		await this.db.query("update pim_forge.forge_slots set idle_since = null where thread_id = $1", [threadId]);
	}

	/** Threads whose slot has been idle for the grace period, oldest first; the worker gives their sandboxes back (`ForgeWorker.reap`), which frees the slots. */
	async idleCandidates(): Promise<string[]> {
		return (await this.db.query<Row>("select thread_id from pim_forge.forge_slots where idle_since is not null and idle_since <= $1 order by idle_since", [this.at(this.clock() - IDLE_SLOT_GRACE_MS)])).rows.map((r) => r.thread_id as string);
	}

	/** Releases every slot idle for the grace period; the caller also tears down those workspaces. */
	async releaseIdle(): Promise<string[]> {
		const due = (await this.db.query<Row>("select thread_id from pim_forge.forge_slots where idle_since is not null and idle_since <= $1", [this.at(this.clock() - IDLE_SLOT_GRACE_MS)])).rows.map((r) => r.thread_id as string);
		for (const id of due) await this.release(id, "idle");
		return due;
	}

	/** A provision's result for the pool: three failures in a row open it for five minutes, then one probe is let through. Capacity, cancellation and quota are `ignored`. */
	async report(poolId: string, threadId: string, result: "success" | "failure" | "ignored"): Promise<PoolBreaker> {
		return tx(this.db, async (q) => {
			await lockPool(q, poolId);
			const next = poolResult(await this.breaker(q, poolId), threadId, result, this.clock());
			await this.saveBreaker(q, poolId, next);
			return next;
		}).then(async (b) => {
			if (b.retryAt === null) await this.promote(poolId);
			return b;
		});
	}

	async slots(poolId: string): Promise<string[]> {
		return (await this.db.query<Row>("select thread_id from pim_forge.forge_slots where pool_id = $1 order by acquired_at", [poolId])).rows.map((r) => r.thread_id);
	}

	async queue(poolId: string): Promise<string[]> {
		return (await this.db.query<Row>("select thread_id from pim_forge.forge_queue where pool_id = $1 order by seq", [poolId])).rows.map((r) => r.thread_id);
	}

	/** A person's login for a harness is refreshed by one holder at a time, so a rotating token (Codex) is never clobbered by a concurrent refresh. */
	async acquireLogin(ownerId: string, harness: string, holder: string, ttlMs = 60_000): Promise<boolean> {
		const r = await this.db.query(
			`insert into pim_forge.forge_login_locks (owner_id, harness, holder, expires_at) values ($1,$2,$3,$4)
			 on conflict (owner_id, harness) do update set holder = $3, expires_at = $4
			 where pim_forge.forge_login_locks.expires_at <= $5 or pim_forge.forge_login_locks.holder = $3`,
			[ownerId, harness, holder, this.at(this.clock() + ttlMs), this.at(this.clock())],
		);
		return (r.rowCount ?? 0) > 0;
	}

	async releaseLogin(ownerId: string, harness: string, holder: string): Promise<void> {
		await this.db.query("delete from pim_forge.forge_login_locks where owner_id = $1 and harness = $2 and holder = $3", [ownerId, harness, holder]);
	}

	/** Environment builds are deduplicated by key: one thread builds, the rest wait for its snapshot. */
	async acquireEnvBuild(envKey: string, holder: string, ttlMs = 15 * 60_000): Promise<"build" | "wait"> {
		const r = await this.db.query(
			`insert into pim_forge.forge_env_builds (env_key, holder, expires_at) values ($1,$2,$3)
			 on conflict (env_key) do update set holder = $2, expires_at = $3
			 where pim_forge.forge_env_builds.expires_at <= $4 or pim_forge.forge_env_builds.holder = $2`,
			[envKey, holder, this.at(this.clock() + ttlMs), this.at(this.clock())],
		);
		return (r.rowCount ?? 0) > 0 ? "build" : "wait";
	}

	async finishEnvBuild(envKey: string, holder: string): Promise<void> {
		await this.db.query("delete from pim_forge.forge_env_builds where env_key = $1 and holder = $2", [envKey, holder]);
	}
}
