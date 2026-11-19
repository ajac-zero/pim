// ForgeScheduler: the pool and slot scheduler CodingSchedulerDO ran as one DO per space, as transaction- and advisory-locked PostgreSQL scheduling, deployment-wide.
import { POOL_COOLDOWN_MS, type PoolBreaker, closedPool, poolAvailable, poolResult, reservePool } from "@pim/coding/pool-breaker";
import { type Db, type Queryable, type Row, tx } from "./db";
import { ForgeError } from "./errors";
import { type ForgeStore } from "./store";

/** A queued thread waits this long for a slot, is requeued once, and then fails. */
export const QUEUE_DEADLINE_MS = 30 * 60_000;
/** A held workspace with nothing to do keeps its slot this long. */
export const IDLE_SLOT_GRACE_MS = 2 * 60_000;
/** A thread waiting for the person (a login) keeps its slot this long, as v1 held it. */
export const WAITING_SLOT_GRACE_MS = 5 * 60_000;
export { POOL_COOLDOWN_MS };

/** How long past its limit a workspace may run before Forge itself stops it, which leaves the sandbox host's own wall clock the first chance. */
export const SESSION_CAP_GRACE_MS = 60_000;
const MINUTE_MS = 60_000;

/** Where a sandbox that belongs to no thread (a harness sign-in's) is counted: a name no thread has. */
export const loginKey = (ownerId: string, harness: string) => `login:${ownerId}:${harness}`;

export type Admission = { kind: "slot"; poolId: string; probe: boolean; /** The longest this workspace may run from its start, in minutes; null for no limit. */ wallClockMin: number | null } | { kind: "queued"; poolId: string; position: number } | { kind: "unhealthy"; poolId: string };

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

	/** The minutes of a person's stretches that fall inside [from, until): each is clipped to the window and, while it runs, to now, so one that crosses midnight on the 1st counts toward each month by when it ran. */
	private async minutesIn(q: Queryable, ownerId: string, from: Date, until: Date): Promise<number> {
		const row = (await q.query<Row>(`select coalesce(sum(greatest(0, extract(epoch from (least(coalesce(ended_at, $4), $3) - greatest(began_at, $2))))), 0) / 60 as m from pim_forge.forge_compute_usage where owner_id = $1 and began_at < $3 and coalesce(ended_at, $4) > $2`, [ownerId, from, until, this.at(this.clock())])).rows[0]!;
		return Number(row.m);
	}

	/**
	 * Quotas: the most specific of user, tenant, deployment that sets a number applies to that number. Thrown as `quota` so a second thread fails with compute_quota.
	 * Answers how long the workspace may then run (v1's `capAt`): the session limit, or the month's minutes that are left, whichever is less, and null for no limit.
	 */
	async checkQuota(q: Queryable, ownerId: string, tenantId: string | null, opts: { startingWorkspaceThread: boolean }): Promise<{ wallClockMin: number | null }> {
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
			// What counts is the stretches running, which a sign-in's workspace has as a thread's slot does.
			const held = Number((await q.query<Row>("select count(*) c from pim_forge.forge_compute_usage where owner_id = $1 and ended_at is null", [ownerId])).rows[0]!.c);
			if (held >= maxConcurrent) throw new ForgeError("quota", `compute_quota: ${maxConcurrent} concurrent coding workspaces are allowed`);
		}
		const session = pick("max_session_minutes");
		if (session !== null && session <= 0) throw new ForgeError("quota", "compute_quota: your session length limit is 0 minutes, so no sandbox workspaces run");
		let remaining: number | null = null;
		const minutes = pick("compute_minutes");
		if (minutes !== null) {
			const now = new Date(this.clock());
			const used = await this.minutesIn(q, ownerId, new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1)), new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1)));
			if (used >= minutes) throw new ForgeError("quota", `compute_quota: ${minutes} compute minutes this month are spent`);
			remaining = Math.max(1, Math.ceil(minutes - used));
		}
		const usd = pick("usd");
		if (usd !== null) {
			const spent = Number((await q.query<Row>(`select coalesce(sum(spent_usd), 0) s from pim_forge.forge_threads where owner_id = $1 and created_at >= date_trunc('month', $2::timestamptz)`, [ownerId, this.at(this.clock())])).rows[0]!.s);
			if (spent >= usd) throw new ForgeError("quota", `usd_quota: $${usd} of coding spend this month is used`);
		}
		return { wallClockMin: session === null ? remaining : remaining === null ? session : Math.min(session, remaining) };
	}

	/**
	 * The pool a thread that names none is placed on: the first by priority that is enabled, healthy and has room, else the first healthy one (where it waits its turn). Null when no pool is usable, and the caller names its default.
	 * With `provider`, only that provider's pools count.
	 */
	async choosePool(o: { provider?: string } = {}): Promise<string | null> {
		const pools = (await this.db.query<Row>("select p.pool_id, p.size, (select count(*) from pim_forge.forge_slots s where s.pool_id = p.pool_id) as held, (select count(*) from pim_forge.forge_queue w where w.pool_id = p.pool_id) as waiting from pim_forge.forge_pools p where p.enabled and ($1::text is null or p.provider = $1) order by p.priority desc, p.pool_id", [o.provider ?? null])).rows;
		const now = this.clock();
		const healthy: Row[] = [];
		for (const p of pools) if (poolAvailable(await this.breaker(this.db, p.pool_id), now)) healthy.push(p);
		return (healthy.find((p) => Number(p.held) < Number(p.size) && Number(p.waiting) === 0) ?? healthy[0])?.pool_id ?? null;
	}

	/** Gives the thread a slot in the pool, or queues it behind those already waiting (FIFO). Amp threads never come here. */
	async admit(threadId: string, poolId: string, ownerId: string, tenantId: string | null = null): Promise<Admission> {
		return tx(this.db, async (q) => {
			await lockPool(q, poolId);
			const pool = (await q.query<Row>("select * from pim_forge.forge_pools where pool_id = $1", [poolId])).rows[0];
			if (!pool || !pool.enabled) return { kind: "unhealthy", poolId } as Admission;
			const existing = (await q.query("select 1 from pim_forge.forge_slots where thread_id = $1", [threadId])).rows.length;
			if (existing) {
				// A slot already held keeps the end its stretch was given.
				const cap = (await q.query<Row>("select cap_at from pim_forge.forge_compute_usage where thread_id = $1 and ended_at is null order by id desc limit 1", [threadId])).rows[0]?.cap_at;
				return { kind: "slot", poolId, probe: false, wallClockMin: cap ? Math.max(1, Math.ceil((new Date(cap).getTime() - this.clock()) / MINUTE_MS)) : null } as Admission;
			}
			const { wallClockMin } = await this.checkQuota(q, ownerId, tenantId, { startingWorkspaceThread: true });
			const now = this.clock();
			const b = await this.breaker(q, poolId);
			if (!poolAvailable(b, now)) return { kind: "unhealthy", poolId } as Admission;
			const held = Number((await q.query<Row>("select count(*) c from pim_forge.forge_slots where pool_id = $1", [poolId])).rows[0]!.c);
			const waiting = Number((await q.query<Row>("select count(*) c from pim_forge.forge_queue where pool_id = $1 and thread_id <> $2", [poolId, threadId])).rows[0]!.c);
			if (held < pool.size && waiting === 0) {
				await this.takeSlot(q, threadId, poolId, ownerId, wallClockMin);
				const reserved = reservePool(b, threadId);
				await this.saveBreaker(q, poolId, reserved);
				return { kind: "slot", poolId, probe: b.retryAt !== null, wallClockMin } as Admission;
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

	private async takeSlot(q: Queryable, threadId: string, poolId: string, ownerId: string, wallClockMin: number | null) {
		const at = this.at(this.clock());
		await q.query("delete from pim_forge.forge_queue where thread_id = $1", [threadId]);
		await q.query("insert into pim_forge.forge_slots (thread_id, pool_id, owner_id, acquired_at) values ($1,$2,$3,$4)", [threadId, poolId, ownerId, at]);
		const provider = (await q.query<Row>("select provider from pim_forge.forge_pools where pool_id = $1", [poolId])).rows[0]!.provider;
		await q.query("insert into pim_forge.forge_compute_usage (owner_id, thread_id, provider, began_at, reason, cap_at) values ($1,$2,$3,$4,'slot',$5)", [ownerId, threadId, provider, at, wallClockMin === null ? null : this.at(at.getTime() + wallClockMin * MINUTE_MS)]);
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
					await this.store.failEarly(q, e.thread_id, "queue_timeout", "No workspace slot became free in time, even after one requeue");
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
				let wallClockMin: number | null;
				try {
					({ wallClockMin } = await this.checkQuota(q, next.owner_id, null, { startingWorkspaceThread: true }));
				} catch (error) {
					// Over quota now: the thread fails the way a direct admission would, and the ones behind it go on.
					await q.query("delete from pim_forge.forge_queue where thread_id = $1", [next.thread_id]);
					await this.store.failEarly(q, next.thread_id, "compute_quota", error instanceof Error ? error.message : null);
					continue;
				}
				await this.takeSlot(q, next.thread_id, poolId, next.owner_id, wallClockMin);
				b = reservePool(b, next.thread_id);
				await this.store.setState(q, next.thread_id, "provisioning", null, null);
				promoted.push(next.thread_id);
			}
			await this.saveBreaker(q, poolId, b);
			return promoted;
		});
	}

	/**
	 * A sandbox that is no thread's, such as a harness sign-in's, is about to run: checks the person's quota as a thread's is, and counts its minutes from now under `key` until `endSandbox`.
	 * A stretch begun again under the same key ends the one before. Throws as `quota` when the person may not; answers how long it may run, in minutes, or null for no limit.
	 */
	async beginSandbox(ownerId: string, key: string, provider: string, o: { maxMinutes?: number } = {}): Promise<{ wallClockMin: number | null }> {
		return tx(this.db, async (q) => {
			await q.query("select pg_advisory_xact_lock(hashtext($1))", [`forge_owner:${ownerId}`]);
			await this.endStretch(q, key, "restart");
			const { wallClockMin } = await this.checkQuota(q, ownerId, null, { startingWorkspaceThread: true });
			const limit = wallClockMin === null ? (o.maxMinutes ?? null) : Math.min(wallClockMin, o.maxMinutes ?? wallClockMin);
			const at = this.at(this.clock());
			await q.query("insert into pim_forge.forge_compute_usage (owner_id, thread_id, provider, began_at, reason, cap_at) values ($1,$2,$3,$4,'sandbox',$5)", [ownerId, key, provider, at, limit === null ? null : this.at(at.getTime() + limit * MINUTE_MS)]);
			return { wallClockMin: limit };
		});
	}

	/** The sandbox counted under `key` stopped running. */
	async endSandbox(key: string, reason = "stop"): Promise<void> {
		await tx(this.db, (q) => this.endStretch(q, key, reason));
	}

	private async endStretch(q: Queryable, key: string, reason: string): Promise<void> {
		await q.query("update pim_forge.forge_compute_usage set ended_at = $2, reason = $3 where thread_id = $1 and ended_at is null", [key, this.at(this.clock()), reason]);
	}

	/**
	 * The threads whose workspace has run past the end its quota gave it (the session limit, or the minutes the month had left), beyond a grace in which the sandbox host's own wall clock stops it first;
	 * the worker gives their sandboxes back. A sign-in's sandbox is deleted by the host at its limit, so its stretch is ended here at the end it was given.
	 */
	async overCap(): Promise<string[]> {
		const now = this.clock();
		await this.db.query("update pim_forge.forge_compute_usage set ended_at = cap_at, reason = 'session_limit' where ended_at is null and cap_at is not null and cap_at <= $1 and thread_id like 'login:%'", [this.at(now)]);
		return (await this.db.query<Row>("select u.thread_id from pim_forge.forge_compute_usage u join pim_forge.forge_slots s on s.thread_id = u.thread_id where u.ended_at is null and u.cap_at is not null and u.cap_at <= $1 order by u.cap_at", [this.at(now - SESSION_CAP_GRACE_MS)])).rows.map((r) => r.thread_id as string);
	}

	/** The held workspace has nothing to do: its slot is released after the idle grace (`graceMs`, longer for a thread that waits for the person) unless work arrives. */
	async markIdle(threadId: string, graceMs = IDLE_SLOT_GRACE_MS): Promise<void> {
		await this.db.query("update pim_forge.forge_slots set idle_since = coalesce(idle_since, $2) where thread_id = $1", [threadId, this.at(this.clock() + graceMs - IDLE_SLOT_GRACE_MS)]);
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
