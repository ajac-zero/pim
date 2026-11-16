import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { Harness } from "@earendil-works/pi-durable";
import type { HarnessInspection, HarnessOptions } from "@earendil-works/pi-durable";
import type pg from "pg";
import { withTenant } from "./db.ts";
import type { IdAllocator } from "./ids.ts";
import { type Lease, claimDue, declareQuiescent, readSignalSeq, releaseLease, renewLease } from "./partitions.ts";
import { OwnershipLost, PgStorage, type CommitFaults } from "./storage.ts";

const ctx = BACKGROUND_CONTEXT;

export interface SignalRow {
	signal_id: number;
	kind: string;
	operation_id: string;
	payload: Record<string, any>;
}

export interface HandlerApi {
	harness: Harness;
	storage: PgStorage;
	lease: Lease;
	pool: pg.Pool;
}

/** Delivers one signal. Must be idempotent on `signal.operation_id`: it may run again after a crash or a lost acknowledgement. */
export type SignalHandler = (signal: SignalRow, api: HandlerApi) => Promise<void>;

export interface HostDeps {
	/** The pool for pim_runtime. */
	pool: pg.Pool;
	ids: IdAllocator;
	harnessOptions(lease: Lease): HarnessOptions;
	handlers?: Record<string, SignalHandler>;
	/** The earliest time-based wait a quiescent family has (a provider retry, a poll). Without one, only a signal wakes it. */
	dueAt?(inspection: HarnessInspection, lease: Lease): Date | undefined;
	/** For the home family only: creates conversation 1 once. A non-home family never calls Harness.root(). */
	homeRoot?: (harness: Harness) => Promise<void>;
	leaseTtlMs?: number;
	pollMs?: number;
	faults?: CommitFaults;
	onReport?(error: unknown): void;
	onLost?(lease: Lease): void;
	onReleased?(lease: Lease): void;
}

/** What keeps an owner: anything pi must still run, a queued or placed input, or work the host has yet to deliver. */
export function needsOwner(inspection: HarnessInspection): boolean {
	if (inspection.submissions.length > 0) return true;
	return inspection.tasks.some((task) => task.state.kind !== "suspended" && task.state.kind !== "blocked");
}

/**
 * One owned family: its fenced storage, its Harness, its lease heartbeat and its delivery loop. Created only from
 * a lease. Losing the lease (heartbeat refused, or a commit fenced) closes the Harness and stops everything: a
 * stale owner schedules nothing and writes nothing.
 */
export class PartitionHost {
	readonly storage: PgStorage;
	harness!: Harness;
	readonly #deps: HostDeps;
	#stopped = false;
	#lost = false;
	#timer: ReturnType<typeof setInterval> | undefined;
	#nudge: (() => void) | undefined;
	#loop: Promise<void> | undefined;
	#effectDispatch = 0;

	constructor(
		readonly lease: Lease,
		deps: HostDeps,
	) {
		this.#deps = deps;
		this.storage = new PgStorage({
			pool: deps.pool,
			tenantId: lease.tenantId,
			partitionId: lease.partitionId,
			ownerId: lease.ownerId,
			epoch: lease.epoch,
			home: lease.home,
			ids: deps.ids,
			faults: deps.faults,
			onCommitted: () => this.nudge(),
			onOwnershipLost: () => void this.#lose(),
		});
	}

	get lost(): boolean {
		return this.#lost;
	}

	/** Opens the Harness under the lease (the open itself writes, and is fenced like any commit), and starts scheduling and delivery. */
	async start(): Promise<void> {
		const ttl = this.#deps.leaseTtlMs ?? 15_000;
		this.#timer = setInterval(() => {
			void renewLease(this.#deps.pool, this.lease, ttl).then(async (ok) => { if (!ok) await this.#lose(); }, () => undefined);
		}, Math.max(50, ttl / 3));
		try {
			this.harness = await Harness.open(this.storage, { onReport: (e) => this.#deps.onReport?.(e), ...this.#deps.harnessOptions(this.lease) }, ctx);
			if (this.lease.home) await this.#deps.homeRoot?.(this.harness);
			this.harness.resume();
		} catch (error) {
			await this.#lose();
			throw error;
		}
		this.#loop = this.#run();
	}

	/** Makes the delivery loop look again now. */
	nudge(): void {
		this.#nudge?.();
	}

	/**
	 * Whether an external effect may be dispatched now: the lease is live in the database with a safety margin. Checked
	 * immediately before dispatch; fencing stops a stale owner's commits, so its network calls must stop here.
	 */
	async mayDispatch(marginMs = 1000): Promise<boolean> {
		if (this.#lost || this.#stopped) return false;
		const ok = await withTenant(
			this.#deps.pool,
			this.lease.tenantId,
			async (q) =>
				(await q.get("SELECT 1 FROM rt.partitions WHERE partition_id = $1 AND owner_id = $2 AND epoch = $3 AND lease_until > clock_timestamp() + $4::interval", this.lease.partitionId, this.lease.ownerId, this.lease.epoch, `${marginMs} milliseconds`)) !== undefined,
			{ readOnly: true },
		);
		if (ok) this.#effectDispatch++;
		return ok;
	}

	async #lose(): Promise<void> {
		if (this.#lost) return;
		this.#lost = true;
		await this.#stop();
		this.#deps.onLost?.(this.lease);
	}

	async #stop(): Promise<void> {
		this.#stopped = true;
		if (this.#timer) clearInterval(this.#timer);
		this.#nudge?.();
		try {
			await this.harness?.close(ctx);
		} catch {
			// A Harness poisoned by a lost commit may refuse to close cleanly; the storage is closed regardless.
		}
		await this.storage.close(ctx);
	}

	/** Simulates process death: everything stops and the lease is left to expire. */
	async kill(): Promise<void> {
		await this.#stop();
		await this.#loop?.catch(() => undefined);
	}

	/** Cooperative shutdown (drain): stop scheduling, close, and hand the family to whoever claims it next. */
	async release(options: { keepActivation?: boolean } = {}): Promise<void> {
		if (this.#lost) return;
		await this.#stop();
		await this.#loop?.catch(() => undefined);
		await releaseLease(this.#deps.pool, this.lease).catch(() => undefined);
		if (!options.keepActivation) this.#deps.onReleased?.(this.lease);
	}

	async #run(): Promise<void> {
		const poll = this.#deps.pollMs ?? 250;
		while (!this.#stopped) {
			try {
				if ((await this.#step()) === "released") return;
			} catch (error) {
				if (error instanceof OwnershipLost || this.#lost) return;
				this.#deps.onReport?.(error);
			}
			await new Promise<void>((resolve) => {
				const timer = setTimeout(resolve, poll);
				this.#nudge = () => {
					clearTimeout(timer);
					resolve();
				};
			});
		}
	}

	async #step(): Promise<"busy" | "released"> {
		const { pool, lease } = { pool: this.#deps.pool, lease: this.lease };
		const seen = await readSignalSeq(pool, lease.tenantId, lease.partitionId);
		const pendingSignals = await this.#deliverSignals();
		const unapplied = await this.#applyApprovals();
		const inspection = await this.harness.inspect(ctx);
		if (this.#stopped) return "busy";
		if (pendingSignals > 0 || unapplied > 0 || needsOwner(inspection)) return "busy";
		const wake = this.#deps.dueAt?.(inspection, lease);
		// The declaration holds only if no signal arrived since `seen`: a signal landing after inspect() keeps the owner.
		if (!(await declareQuiescent(pool, lease, seen, wake))) return "busy";
		await this.#stop();
		await releaseLease(pool, lease);
		this.#deps.onReleased?.(lease);
		return "released";
	}

	/** Delivers every pending signal in order and returns how many remain undelivered. */
	async #deliverSignals(): Promise<number> {
		const { pool, lease } = { pool: this.#deps.pool, lease: this.lease };
		const rows = await withTenant(pool, lease.tenantId, (q) => q.all<SignalRow>("SELECT signal_id, kind, operation_id, payload FROM app.signals WHERE partition_id = $1 AND delivered_at IS NULL ORDER BY signal_id LIMIT 100", lease.partitionId), { readOnly: true });
		let remaining = 0;
		for (const signal of rows) {
			if (this.#stopped) return rows.length;
			const handler = this.#deps.handlers?.[signal.kind] ?? BUILT_IN[signal.kind];
			if (handler === undefined) {
				this.#deps.onReport?.(new Error(`No handler for signal kind ${signal.kind}`));
				remaining++;
				continue;
			}
			await handler(signal, { harness: this.harness, storage: this.storage, lease, pool });
			// Acknowledged by pi (the handler returned): only now is the signal marked delivered.
			await withTenant(pool, lease.tenantId, (q) => q.run("UPDATE app.signals SET delivered_at = now() WHERE signal_id = $1", signal.signal_id));
		}
		return remaining;
	}

	/**
	 * Re-applies every decided approval whose suspended tool task has not been woken, after each activation. `requested`
	 * (the task has not parked yet) is held only in memory by pi, so the approval stays unapplied until it resolves.
	 */
	async #applyApprovals(): Promise<number> {
		const { pool, lease } = { pool: this.#deps.pool, lease: this.lease };
		const rows = await withTenant(pool, lease.tenantId, (q) => q.all<{ approval_id: string; task_id: number | null }>("SELECT approval_id, task_id FROM app.approvals WHERE partition_id = $1 AND status <> 'pending' AND applied_at IS NULL", lease.partitionId), { readOnly: true });
		let open = 0;
		for (const row of rows) {
			if (row.task_id === null) continue;
			const outcome = await this.harness.resumeTask(row.task_id as never, ctx);
			if (outcome === "requested") {
				open++;
				continue;
			}
			await withTenant(pool, lease.tenantId, (q) => q.run("UPDATE app.approvals SET applied_at = now() WHERE approval_id = $1 AND applied_at IS NULL", row.approval_id));
		}
		return open;
	}
}

const BUILT_IN: Record<string, SignalHandler> = {
	async input(signal, { harness, lease, pool }) {
		const { conversationId, content, whenBusy } = signal.payload as { conversationId: number; content: any; whenBusy?: "steer" | "followUp" | "reject" };
		const conversation = await harness.conversation(conversationId as never, ctx);
		if (conversation === undefined) throw new Error(`Conversation ${conversationId} is not in partition ${lease.partitionId}`);
		await conversation.submit({ type: "input", content, requestId: signal.operation_id, ...(whenBusy ? { whenBusy } : {}) }, ctx);
		void pool;
	},
	async create_chat(signal, { harness, storage, lease, pool }) {
		const { chatId, agent, firstMessage } = signal.payload as { chatId: string; agent?: Record<string, unknown>; firstMessage?: string | null };
		// A chat's family holds exactly one root conversation, so a retry after a crash finds it instead of creating a second.
		const existing = (await storage.scanConversations({}, 1)).items[0] as { id: number } | undefined;
		const conversation = existing === undefined ? await harness.createConversation({ ownership: { kind: "ownerless" }, agent: agent as never }, ctx) : (await harness.conversation(existing.id as never, ctx))!;
		await withTenant(pool, lease.tenantId, (q) => q.run("UPDATE app.chats SET conversation_id = $3 WHERE tenant_id = $1 AND chat_id = $2 AND conversation_id IS NULL", lease.tenantId, chatId, conversation.id));
		if (firstMessage) await conversation.submit({ type: "input", content: firstMessage, requestId: `${signal.operation_id}:first` }, ctx);
	},
	// Approval decisions are applied by the host loop (#applyApprovals); the signal only wakes the owner.
	async approval() {},
};

/** Claims due families and runs a PartitionHost for each, up to a bound. Several Runners share the load; leases keep each family to one. */
export class Runner {
	readonly hosts = new Map<string, PartitionHost>();
	#timer: ReturnType<typeof setTimeout> | undefined;
	#draining = false;
	#running = false;

	constructor(
		readonly options: {
			ownerId: string;
			steward: pg.Pool;
			deps: Omit<HostDeps, "onLost" | "onReleased">;
			maxFamilies?: number;
			perTenantLimit?: number;
			claimEveryMs?: number;
		},
	) {}

	start(): void {
		this.#running = true;
		const tick = async () => {
			if (!this.#running) return;
			try {
				await this.claimOnce();
			} catch (error) {
				this.options.deps.onReport?.(error);
			}
			if (this.#running) this.#timer = setTimeout(tick, this.options.claimEveryMs ?? 250);
		};
		void tick();
	}

	async claimOnce(): Promise<number> {
		if (this.#draining) return 0;
		const room = (this.options.maxFamilies ?? 100) - this.hosts.size;
		if (room <= 0) return 0;
		const leases = await claimDue(this.options.steward, { ownerId: this.options.ownerId, ttlMs: this.options.deps.leaseTtlMs ?? 15_000, limit: room, perTenantLimit: this.options.perTenantLimit });
		await Promise.all(
			leases.map(async (lease) => {
				const host = new PartitionHost(lease, {
					...this.options.deps,
					onLost: (l) => {
						this.hosts.delete(l.partitionId);
						this.options.deps.onReport?.(new OwnershipLost(l.partitionId, l.epoch));
					},
					onReleased: (l) => this.hosts.delete(l.partitionId),
				});
				this.hosts.set(lease.partitionId, host);
				try {
					await host.start();
				} catch (error) {
					this.hosts.delete(lease.partitionId);
					this.options.deps.onReport?.(error);
				}
			}),
		);
		return leases.length;
	}

	/** Rolling drain: stop claiming, then close each family and release its lease so another Runner takes it over; the activation row stays `needs_owner`. */
	async drain(): Promise<void> {
		this.#draining = true;
		this.#running = false;
		if (this.#timer) clearTimeout(this.#timer);
		await Promise.all([...this.hosts.values()].map((host) => host.release({ keepActivation: true })));
		this.hosts.clear();
	}

	/** Crash simulation for qualification: stops everything without releasing leases. */
	async crash(): Promise<void> {
		this.#running = false;
		this.#draining = true;
		if (this.#timer) clearTimeout(this.#timer);
		// No release: leases are left to expire, as after a killed process.
		await Promise.all([...this.hosts.values()].map((host) => host.kill()));
		this.hosts.clear();
	}
}
