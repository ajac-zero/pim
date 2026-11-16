import { type Db, SCHEMA } from "./db.ts";
import type { OwnerFence } from "./storage.ts";

const S = SCHEMA;

export type StewardOptions = {
	readonly db: Db;
	/** Names this Runner process; two Runners must not share one. */
	readonly ownerId: string;
	/** How long a lease lasts without renewal; default 15 s. */
	readonly leaseTtlMs?: number;
	/** How often a held lease is renewed; default a third of the TTL. */
	readonly renewEveryMs?: number;
	/** A lease is treated as lost this long before its database expiry, so work stops before another owner can start. Default a fifth of the TTL. */
	readonly safetyMarginMs?: number;
};

/**
 * A held lease on one partition. The database row is the authority: `epoch` is the fence token every commit carries.
 * Locally the lease keeps a deadline measured on this process's monotonic clock from the database's own remaining time,
 * so clock skew between hosts never extends it. When renewal fails or the deadline passes, `signal` aborts and the
 * `onLost` listeners run once: the Runner closes the Harness and aborts model and tool dispatch.
 */
export class Lease implements OwnerFence {
	readonly tenantId: string;
	readonly partitionId: string;
	readonly ownerId: string;
	readonly epoch: number;
	readonly kind: "home" | "family";
	readonly #abort = new AbortController();
	readonly #listeners = new Set<(reason: string) => void>();
	readonly #steward: Steward;
	#deadline: number;
	#timer: ReturnType<typeof setTimeout> | undefined;
	#deadlineTimer: ReturnType<typeof setTimeout> | undefined;
	#lostReason: string | undefined;
	#renewing: Promise<void> | undefined;

	constructor(steward: Steward, row: { tenantId: string; partitionId: string; epoch: number; kind: "home" | "family"; remainingMs: number; sentAt: number }) {
		this.#steward = steward;
		this.tenantId = row.tenantId;
		this.partitionId = row.partitionId;
		this.ownerId = steward.ownerId;
		this.epoch = row.epoch;
		this.kind = row.kind;
		this.#deadline = row.sentAt + row.remainingMs - steward.safetyMarginMs;
		this.#armDeadline();
	}

	/** A lease nobody renews is lost at its local deadline even when no heartbeat tick runs (a stalled event loop or database). */
	#armDeadline(): void {
		if (this.#deadlineTimer !== undefined) clearTimeout(this.#deadlineTimer);
		this.#deadlineTimer = setTimeout(() => this.lose("the lease ran past its local deadline"), Math.max(0, this.#deadline - performance.now()));
		this.#deadlineTimer.unref?.();
	}

	get signal(): AbortSignal {
		return this.#abort.signal;
	}
	get lostReason(): string | undefined {
		return this.#lostReason;
	}
	isLocallyValid(): boolean {
		return this.#lostReason === undefined && performance.now() < this.#deadline;
	}

	/** Run `listener` once when the lease is lost (immediately when it already is). */
	onLost(listener: (reason: string) => void): () => void {
		if (this.#lostReason !== undefined) {
			listener(this.#lostReason);
			return () => {};
		}
		this.#listeners.add(listener);
		return () => this.#listeners.delete(listener);
	}

	/** Start the renewal heartbeat. */
	startHeartbeat(): void {
		if (this.#timer !== undefined || this.#lostReason !== undefined) return;
		const tick = (): void => {
			this.#timer = undefined;
			if (this.#lostReason !== undefined) return;
			if (performance.now() >= this.#deadline) {
				this.lose("the lease ran past its local deadline");
				return;
			}
			this.#renewing = this.#steward
				.renew(this)
				.catch((error: unknown) => {
					// A transient database error is retried until the local deadline; a rejection is final.
					if (error instanceof LeaseRejected) this.lose(error.message);
				})
				.finally(() => {
					this.#renewing = undefined;
					if (this.#lostReason === undefined) this.#timer = setTimeout(tick, this.#steward.renewEveryMs);
				});
		};
		this.#timer = setTimeout(tick, this.#steward.renewEveryMs);
	}

	/** @internal */
	extend(remainingMs: number, sentAt: number): void {
		if (this.#lostReason !== undefined) return;
		this.#deadline = Math.max(this.#deadline, sentAt + remainingMs - this.#steward.safetyMarginMs);
		this.#armDeadline();
	}

	/** Give the lease up locally: stop renewing, abort the signal, notify listeners. Does not touch the database. */
	lose(reason: string): void {
		if (this.#lostReason !== undefined) return;
		this.#lostReason = reason;
		if (this.#timer !== undefined) clearTimeout(this.#timer);
		this.#timer = undefined;
		if (this.#deadlineTimer !== undefined) clearTimeout(this.#deadlineTimer);
		this.#deadlineTimer = undefined;
		this.#abort.abort(new Error(`Lost partition ${this.partitionId} at epoch ${this.epoch}: ${reason}`));
		for (const listener of [...this.#listeners]) {
			try {
				listener(reason);
			} catch {}
		}
		this.#listeners.clear();
	}

	async stopHeartbeat(): Promise<void> {
		if (this.#timer !== undefined) clearTimeout(this.#timer);
		this.#timer = undefined;
		await this.#renewing;
	}
}

/** A renewal the database refused: another owner holds a higher epoch, or the row is gone. */
export class LeaseRejected extends Error {
	constructor(message: string) {
		super(message);
		this.name = "LeaseRejected";
	}
}

export type ReleaseResult = { released: true } | { released: false; reason: "new_work" | "lost" };

/** Takes, renews and releases partition leases for one Runner. */
export class Steward {
	readonly db: Db;
	readonly ownerId: string;
	readonly leaseTtlMs: number;
	readonly renewEveryMs: number;
	readonly safetyMarginMs: number;
	readonly #held = new Set<Lease>();
	#draining = false;

	constructor(options: StewardOptions) {
		this.db = options.db;
		this.ownerId = options.ownerId;
		this.leaseTtlMs = options.leaseTtlMs ?? 15_000;
		this.renewEveryMs = options.renewEveryMs ?? Math.floor(this.leaseTtlMs / 3);
		this.safetyMarginMs = options.safetyMarginMs ?? Math.floor(this.leaseTtlMs / 5);
	}

	get draining(): boolean {
		return this.#draining;
	}
	get held(): readonly Lease[] {
		return [...this.#held];
	}

	/**
	 * Take the lease on one partition when it is free or expired, with the next epoch. The epoch only ever grows, so a
	 * previous owner that is still running is fenced the moment this statement commits.
	 */
	async acquire(tenantId: string, partitionId: string): Promise<Lease | undefined> {
		if (this.#draining) return undefined;
		const sentAt = performance.now();
		const result = await this.db.read<{ epoch: string; kind: "home" | "family"; remaining_ms: number }>(
			tenantId,
			`UPDATE ${S}.partitions SET owner_id = $3, owner_epoch = owner_epoch + 1, lease_expires_at = clock_timestamp() + ($4::int * interval '1 millisecond')
			 WHERE tenant_id = $1 AND partition_id = $2 AND (owner_id IS NULL OR lease_expires_at IS NULL OR lease_expires_at <= clock_timestamp())
			 RETURNING owner_epoch AS epoch, kind, ($4::int)::float8 AS remaining_ms`,
			[tenantId, partitionId, this.ownerId, this.leaseTtlMs],
		);
		const row = result.rows[0];
		if (row === undefined) return undefined;
		const lease = new Lease(this, { tenantId, partitionId, epoch: Number(row.epoch), kind: row.kind, remainingMs: row.remaining_ms, sentAt });
		this.#held.add(lease);
		lease.onLost(() => this.#held.delete(lease));
		return lease;
	}

	/**
	 * Claim the next partition that needs an owner: one whose due-work row says so (or whose due time has come) and whose
	 * lease is free or expired. Candidates are locked with SKIP LOCKED so Runners claiming together take different ones.
	 */
	async claimNext(options: { tenantId?: string } = {}): Promise<Lease | undefined> {
		if (this.#draining) return undefined;
		const sentAt = performance.now();
		const result = await this.db.transaction(
			options.tenantId ?? "",
			async (client) => {
				const picked = await client.query<{ tenant_id: string; partition_id: string }>(
					`SELECT d.tenant_id, d.partition_id FROM ${S}.due_work d JOIN ${S}.partitions p USING (tenant_id, partition_id)
					 WHERE (d.state = 'needs_owner' OR d.next_due_at <= clock_timestamp())
					   AND (p.owner_id IS NULL OR p.lease_expires_at <= clock_timestamp())
					   AND ($1::text IS NULL OR d.tenant_id = $1)
					 ORDER BY coalesce(d.next_due_at, d.updated_at) LIMIT 1 FOR UPDATE OF p SKIP LOCKED`,
					[options.tenantId ?? null],
				);
				const row = picked.rows[0];
				if (row === undefined) return undefined;
				const taken = await client.query<{ epoch: string; kind: "home" | "family" }>(
					`UPDATE ${S}.partitions SET owner_id = $3, owner_epoch = owner_epoch + 1, lease_expires_at = clock_timestamp() + ($4::int * interval '1 millisecond')
					 WHERE tenant_id = $1 AND partition_id = $2 RETURNING owner_epoch AS epoch, kind`,
					[row.tenant_id, row.partition_id, this.ownerId, this.leaseTtlMs],
				);
				const t = taken.rows[0];
				if (t === undefined) return undefined;
				return { tenantId: row.tenant_id, partitionId: row.partition_id, epoch: Number(t.epoch), kind: t.kind };
			},
			{ scope: "all" },
		);
		if (result === undefined) return undefined;
		const lease = new Lease(this, { ...result, remainingMs: this.leaseTtlMs, sentAt });
		this.#held.add(lease);
		lease.onLost(() => this.#held.delete(lease));
		return lease;
	}

	/** Extend a lease. Throws `LeaseRejected` when the row now belongs to another epoch. */
	async renew(lease: Lease): Promise<void> {
		const sentAt = performance.now();
		const result = await this.db.read<{ remaining_ms: number }>(
			lease.tenantId,
			`UPDATE ${S}.partitions SET lease_expires_at = clock_timestamp() + ($5::int * interval '1 millisecond')
			 WHERE tenant_id = $1 AND partition_id = $2 AND owner_id = $3 AND owner_epoch = $4
			 RETURNING ($5::int)::float8 AS remaining_ms`,
			[lease.tenantId, lease.partitionId, lease.ownerId, lease.epoch, this.leaseTtlMs],
		);
		if (result.rows[0] === undefined) throw new LeaseRejected(`partition ${lease.partitionId} is owned by a higher epoch`);
		lease.extend(this.leaseTtlMs, sentAt);
	}

	/**
	 * Release a lease only if nothing arrived for the partition since the owner last looked. `seenActivation` is the
	 * due-work activation_seq the owner read before its final inspection. One statement checks that value, the command
	 * inbox, the durable signals and the outbox, records the next due time, and clears the owner; any new work makes it
	 * release nothing, and the owner carries on.
	 */
	async release(lease: Lease, options: { seenActivation: number; nextDueAt?: Date | undefined; reason?: string }): Promise<ReleaseResult> {
		await lease.stopHeartbeat();
		const result = await this.db.read<{ released: boolean }>(
			lease.tenantId,
			`WITH quiet AS (
				UPDATE ${S}.due_work SET state = 'quiescent', next_due_at = $5, reason = $6, updated_at = clock_timestamp()
				WHERE tenant_id = $1 AND partition_id = $2 AND activation_seq = $7
				  AND NOT EXISTS (SELECT 1 FROM ${S}.command_inbox c WHERE c.tenant_id = $1 AND c.partition_id = $2 AND c.done_at IS NULL)
				  AND NOT EXISTS (SELECT 1 FROM ${S}.durable_signals s WHERE s.tenant_id = $1 AND s.partition_id = $2 AND s.settled_at IS NULL)
				  AND NOT EXISTS (SELECT 1 FROM ${S}.signal_outbox o WHERE o.tenant_id = $1 AND o.source_partition_id = $2 AND o.delivered_at IS NULL)
				RETURNING 1
			), freed AS (
				UPDATE ${S}.partitions SET owner_id = NULL, lease_expires_at = NULL
				WHERE tenant_id = $1 AND partition_id = $2 AND owner_id = $3 AND owner_epoch = $4 AND EXISTS (SELECT 1 FROM quiet)
				RETURNING 1
			)
			SELECT EXISTS (SELECT 1 FROM freed) AS released`,
			[lease.tenantId, lease.partitionId, lease.ownerId, lease.epoch, options.nextDueAt ?? null, options.reason ?? null, options.seenActivation],
		);
		if (result.rows[0]?.released === true) {
			lease.lose("released");
			return { released: true };
		}
		const holder = await this.db.read<{ owner_epoch: string; owner_id: string | null }>(lease.tenantId, `SELECT owner_epoch, owner_id FROM ${S}.partitions WHERE tenant_id = $1 AND partition_id = $2`, [
			lease.tenantId,
			lease.partitionId,
		]);
		const stillMine = holder.rows[0]?.owner_id === lease.ownerId && Number(holder.rows[0]?.owner_epoch) === lease.epoch;
		if (stillMine) lease.startHeartbeat();
		return { released: false, reason: stillMine ? "new_work" : "lost" };
	}

	/**
	 * Give a partition up while it still has work: the next Runner claims it at once. Used when this Runner drains or
	 * cannot keep running a partition it holds (the wake intent is persisted before the lease is cleared).
	 */
	async handOff(lease: Lease, reason: string): Promise<void> {
		await lease.stopHeartbeat();
		await this.db.transaction(lease.tenantId, async (client) => {
			const held = await client.query(
				`UPDATE ${S}.partitions SET owner_id = NULL, lease_expires_at = NULL WHERE tenant_id = $1 AND partition_id = $2 AND owner_id = $3 AND owner_epoch = $4 RETURNING 1`,
				[lease.tenantId, lease.partitionId, lease.ownerId, lease.epoch],
			);
			if (held.rowCount === 0) return;
			await client.query(
				`INSERT INTO ${S}.due_work (tenant_id, partition_id, state, activation_seq, reason) VALUES ($1, $2, 'needs_owner', 1, $3)
				 ON CONFLICT (tenant_id, partition_id) DO UPDATE SET state = 'needs_owner', next_due_at = NULL, activation_seq = ${S}.due_work.activation_seq + 1, reason = $3, updated_at = clock_timestamp()`,
				[lease.tenantId, lease.partitionId, reason],
			);
		});
		lease.lose("handed off");
	}

	/** Stop claiming partitions; the Runner finishes or checkpoints its active turns, then releases what it holds. */
	beginDrain(): void {
		this.#draining = true;
	}
}
