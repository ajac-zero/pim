import { randomUUID } from "node:crypto";
import type pg from "pg";
import { type Q, withTenant } from "./db.ts";

export const newPartitionId = (): string => `p-${randomUUID()}`;

/** Creates a tenant with its id sequence and its home family. Admin or maintenance role; idempotent. */
export async function provisionTenant(pool: pg.Pool, tenantId: string, homePartitionId = `home-${tenantId}`.slice(0, 64)): Promise<{ homePartitionId: string }> {
	await withTenant(pool, tenantId, async (q) => {
		await q.run("INSERT INTO app.tenants (tenant_id) VALUES ($1) ON CONFLICT DO NOTHING", tenantId);
		await q.run("INSERT INTO rt.tenant_ids (tenant_id) VALUES ($1) ON CONFLICT DO NOTHING", tenantId);
		await q.run("INSERT INTO rt.partitions (partition_id, tenant_id, home) VALUES ($1, $2, true) ON CONFLICT DO NOTHING", homePartitionId, tenantId);
		await q.run("INSERT INTO app.activation (partition_id, tenant_id, state, due_at) VALUES ($1, $2, 'needs_owner', now()) ON CONFLICT DO NOTHING", homePartitionId, tenantId);
	});
	return { homePartitionId };
}

/** A new, empty family: a chat, a seat, a delegation, a trigger chat, a review, a visit or a continuation starts one. */
export async function createFamily(q: Q, tenantId: string, partitionId = newPartitionId()): Promise<string> {
	await q.run("INSERT INTO rt.partitions (partition_id, tenant_id) VALUES ($1, $2)", partitionId, tenantId);
	await q.run("INSERT INTO app.activation (partition_id, tenant_id, state, due_at) VALUES ($1, $2, 'needs_owner', now())", partitionId, tenantId);
	return partitionId;
}

export interface Lease {
	tenantId: string;
	partitionId: string;
	ownerId: string;
	epoch: number;
	home: boolean;
	/** The activation `signal_seq` read when the lease was taken; a quiescence declaration is valid only against it. */
	signalSeq: number;
}

const interval = (ms: number) => `${Math.max(1, Math.trunc(ms))} milliseconds`;

/**
 * Takes the family if no live lease holds it. The epoch always increases, so a previous owner's lease, however
 * long it believes it has left, no longer matches the row the storage fences on. Time is the database's, not the caller's.
 */
export async function acquireLease(pool: pg.Pool, tenantId: string, partitionId: string, ownerId: string, ttlMs: number): Promise<Lease | undefined> {
	return withTenant(pool, tenantId, async (q) => {
		const row = await q.get<{ epoch: number; home: boolean }>(
			`UPDATE rt.partitions p SET owner_id = $3, epoch = epoch + 1, lease_until = clock_timestamp() + $4::interval
			 FROM app.tenants t
			 WHERE p.partition_id = $1 AND p.tenant_id = $2 AND t.tenant_id = p.tenant_id AND t.status = 'active' AND p.lease_until <= clock_timestamp()
			 RETURNING p.epoch, p.home`,
			partitionId,
			tenantId,
			ownerId,
			interval(ttlMs),
		);
		if (row === undefined) return undefined;
		const activation = await q.get<{ signal_seq: number }>("SELECT signal_seq FROM app.activation WHERE partition_id = $1", partitionId);
		return { tenantId, partitionId, ownerId, epoch: row.epoch, home: row.home, signalSeq: activation?.signal_seq ?? 0 };
	});
}

/** Extends a lease that is still ours and unexpired. An expired lease is not revived: its owner must treat it as lost. */
export async function renewLease(pool: pg.Pool, lease: Lease, ttlMs: number): Promise<boolean> {
	return withTenant(pool, lease.tenantId, async (q) => {
		const n = await q.run(
			"UPDATE rt.partitions SET lease_until = clock_timestamp() + $5::interval WHERE partition_id = $1 AND tenant_id = $2 AND owner_id = $3 AND epoch = $4 AND lease_until > clock_timestamp()",
			lease.partitionId,
			lease.tenantId,
			lease.ownerId,
			lease.epoch,
			interval(ttlMs),
		);
		return n === 1;
	});
}

export async function releaseLease(pool: pg.Pool, lease: Lease): Promise<void> {
	await withTenant(pool, lease.tenantId, (q) =>
		q.run("UPDATE rt.partitions SET lease_until = '-infinity', owner_id = NULL WHERE partition_id = $1 AND tenant_id = $2 AND owner_id = $3 AND epoch = $4", lease.partitionId, lease.tenantId, lease.ownerId, lease.epoch),
	);
}

/**
 * Marks a family as needing an owner now. Runs in the writer's own transaction (command, signal, timer), so the
 * signal and the activation commit together; a hint sent afterwards only makes discovery faster.
 */
export async function markNeedsOwner(q: Q, tenantId: string, partitionId: string, dueInMs = 0): Promise<void> {
	await q.run(
		`INSERT INTO app.activation (partition_id, tenant_id, state, due_at, signal_seq) VALUES ($1, $2, 'needs_owner', clock_timestamp() + $3::interval, 1)
		 ON CONFLICT (partition_id) DO UPDATE SET state = 'needs_owner', signal_seq = app.activation.signal_seq + 1,
		 due_at = CASE WHEN app.activation.state = 'quiescent' THEN excluded.due_at ELSE LEAST(app.activation.due_at, excluded.due_at) END`,
		partitionId,
		tenantId,
		interval(dueInMs),
	);
}

/**
 * The owner declares the family quiescent only if no signal arrived since it last looked (`seenSignalSeq`) and it
 * still holds the lease, so a signal that lands between `inspect()` and this call is never missed.
 * `wakeAt` is the earliest time-based wait the owner found (a retry or a poll), or none.
 */
export async function declareQuiescent(pool: pg.Pool, lease: Lease, seenSignalSeq: number, wakeAt?: Date): Promise<boolean> {
	return withTenant(pool, lease.tenantId, async (q) => {
		const n = await q.run(
			`UPDATE app.activation a SET state = CASE WHEN $6::timestamptz IS NULL THEN 'quiescent' ELSE 'needs_owner' END,
			   due_at = COALESCE($6::timestamptz, a.due_at)
			 WHERE a.partition_id = $1 AND a.signal_seq = $2
			   AND EXISTS (SELECT 1 FROM rt.partitions p WHERE p.partition_id = a.partition_id AND p.owner_id = $3 AND p.epoch = $4 AND p.lease_until > clock_timestamp())
			   AND $5::text IS NOT NULL`,
			lease.partitionId,
			seenSignalSeq,
			lease.ownerId,
			lease.epoch,
			lease.tenantId,
			wakeAt?.toISOString() ?? null,
		);
		return n === 1;
	});
}

export async function readSignalSeq(pool: pg.Pool, tenantId: string, partitionId: string): Promise<number> {
	return withTenant(pool, tenantId, async (q) => (await q.get<{ signal_seq: number }>("SELECT signal_seq FROM app.activation WHERE partition_id = $1", partitionId))?.signal_seq ?? 0, { readOnly: true });
}

export interface ClaimOptions {
	ownerId: string;
	ttlMs: number;
	limit: number;
	/** The most families one tenant may hold leases on at once, across all runners: a fairness cap. */
	perTenantLimit?: number;
}

/**
 * Steward: claims due families across tenants. Candidates are ranked by their order within their tenant first, so
 * one busy tenant's backlog cannot starve another tenant's single waiting family; suspended tenants are skipped.
 * `stewardPool` connects as pim_steward.
 */
export async function claimDue(stewardPool: pg.Pool, options: ClaimOptions): Promise<Lease[]> {
	return withTenant(stewardPool, null, async (q) => {
		const candidates = await q.all<{ partition_id: string }>(
			`WITH live AS (
			   SELECT tenant_id, count(*) AS n FROM rt.partitions WHERE lease_until > clock_timestamp() GROUP BY tenant_id
			 ), due AS (
			   SELECT a.partition_id, a.tenant_id, a.due_at,
			     row_number() OVER (PARTITION BY a.tenant_id ORDER BY a.due_at) + COALESCE(l.n, 0) AS depth
			   FROM app.activation a
			   JOIN rt.partitions p ON p.partition_id = a.partition_id
			   JOIN app.tenants t ON t.tenant_id = a.tenant_id AND t.status = 'active'
			   LEFT JOIN live l ON l.tenant_id = a.tenant_id
			   WHERE a.state = 'needs_owner' AND a.due_at <= clock_timestamp() AND p.lease_until <= clock_timestamp()
			 )
			 SELECT partition_id FROM due WHERE depth <= $2 ORDER BY depth, due_at LIMIT $1`,
			options.limit * 2,
			options.perTenantLimit ?? 1_000_000,
		);
		if (candidates.length === 0) return [];
		const locked = await q.all<{ partition_id: string }>("SELECT partition_id FROM app.activation WHERE partition_id = ANY($1) FOR UPDATE SKIP LOCKED", candidates.map((row) => row.partition_id));
		const lockedIds = new Set(locked.map((row) => row.partition_id));
		const leases: Lease[] = [];
		for (const { partition_id } of candidates) {
			if (leases.length >= options.limit) break;
			if (!lockedIds.has(partition_id)) continue;
			const row = await q.get<{ tenant_id: string; epoch: number; home: boolean }>(
				`UPDATE rt.partitions SET owner_id = $2, epoch = epoch + 1, lease_until = clock_timestamp() + $3::interval
				 WHERE partition_id = $1 AND lease_until <= clock_timestamp() RETURNING tenant_id, epoch, home`,
				partition_id,
				options.ownerId,
				interval(options.ttlMs),
			);
			if (row === undefined) continue;
			const activation = (await q.get<{ signal_seq: number }>("SELECT signal_seq FROM app.activation WHERE partition_id = $1", partition_id))!;
			leases.push({ tenantId: row.tenant_id, partitionId: partition_id, ownerId: options.ownerId, epoch: row.epoch, home: row.home, signalSeq: activation.signal_seq });
		}
		return leases;
	});
}
