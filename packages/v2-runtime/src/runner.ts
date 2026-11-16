import type { Context } from "@earendil-works/chord";
import { BACKGROUND_CONTEXT, withAbortSignal } from "@earendil-works/chord/context";
import {
	type Conversation,
	type ConversationId,
	Harness,
	type HarnessOptions,
	LiveDoc,
	type SubmissionDraft,
	type TaskId,
} from "@earendil-works/pi-durable";
import pg from "pg";
import { ModelAdmission, admitModels, type AdmissionOptions } from "./admission.ts";
import { type Db } from "./db.ts";
import { type AmbiguousCommit, OwnershipLost } from "./errors.ts";
import { type Lease, Steward, type StewardOptions } from "./ownership.ts";
import { assessInspection, liveDueTimes } from "./quiescence.ts";
import { type Command, type DurableSignal, PartitionInbox } from "./signals.ts";
import { PgPiStorage, reconcileAmbiguousCommit, type AmbiguousOutcome } from "./storage.ts";

export type PartitionContext = {
	readonly tenantId: string;
	readonly partitionId: string;
	/** True only for the tenant's home partition, the one that holds conversation 1. */
	readonly home: boolean;
	readonly lease: Lease;
};

export type CommandHandler = (resident: ResidentPartition, command: Command, context: Context) => Promise<void>;

/** Observability: what the Runner did with a partition. */
export type RunnerEvent =
	| { type: "activated"; tenantId: string; partitionId: string; epoch: number }
	| { type: "released"; tenantId: string; partitionId: string; nextDueAt: number | undefined }
	| { type: "evicted"; tenantId: string; partitionId: string; reason: "idle" | "capacity" }
	| { type: "fenced"; tenantId: string; partitionId: string; epoch: number; reason: string }
	| { type: "ambiguous"; tenantId: string; partitionId: string; batchId: string }
	| { type: "reconciled"; tenantId: string; partitionId: string; batchId: string; outcome: AmbiguousOutcome }
	| { type: "signal"; tenantId: string; partitionId: string; key: string; result: "resumed" | "requested" | "terminal" | "settled" }
	| { type: "command"; tenantId: string; partitionId: string; requestId: string; kind: string }
	| { type: "drained"; tenantId: string; partitionId: string; handedOff: boolean };

export type RunnerOptions = {
	readonly db: Db;
	readonly steward?: Partial<Omit<StewardOptions, "db">> & { ownerId: string };
	/** pi-durable options for one partition. `models` is wrapped by the Runner's admission; the registry must be the same for every partition. */
	readonly harnessOptions: (partition: PartitionContext) => HarnessOptions;
	/** The agent and init for the home partition's root conversation; called only for the home partition. */
	readonly homeRoot?: (tenantId: string) => Parameters<Harness["root"]>[1];
	/** Handlers for command kinds besides the built-in `submit`. */
	readonly commands?: Readonly<Record<string, CommandHandler>>;
	readonly admission?: AdmissionOptions;
	/** The most Harnesses resident in this process; default 64. Quiet ones are evicted least-recently-used first. */
	readonly maxResident?: number;
	/** How long a partition that needs no owner stays resident before it is released; default 30 s. */
	readonly idleUnloadMs?: number;
	/** A sleep, retry or poll at least this far away does not hold a partition; default 60 s. */
	readonly longWaitMs?: number;
	/** Claim only this tenant's partitions; unset claims any (a shared Runner pool). */
	readonly tenantFilter?: string;
	/** The claim and pump interval; default 500 ms. */
	readonly pollMs?: number;
	/** Listen for wake notifications besides polling. Polling alone is always enough; default true. */
	readonly listen?: boolean;
	readonly onEvent?: (event: RunnerEvent) => void;
	readonly onReport?: (error: unknown) => void;
	readonly now?: () => number;
};

const keyOf = (tenantId: string, partitionId: string): string => `${tenantId}\u0000${partitionId}`;

/** The submit command's payload: input for one conversation of the partition. */
export type SubmitPayload = { conversationId: number; content: Extract<SubmissionDraft, { type: "input" }>["content"]; whenBusy?: "steer" | "followUp" | "reject" };

/**
 * One partition loaded in this process: its fenced storage, its Harness, and the host work around them (the durable
 * inbox, the signals, and the decision whether the partition still needs a process).
 */
export class ResidentPartition {
	readonly runner: Runner;
	readonly lease: Lease;
	readonly home: boolean;
	#harness!: Harness;
	#storage!: PgPiStorage;
	#unsubscribe: (() => void)[] = [];
	#pumping: Promise<void> | undefined;
	#dirty = true;
	#lastAssessAt = 0;
	#quietSince: number | undefined;
	#touched: number;
	#disposed = false;
	#faulted: AmbiguousCommit | undefined;
	/** A signal whose task was not yet suspended when `resumeTask` ran: settled once the task has been seen to wait and wake, or to end. */
	readonly #awaiting = new Map<number, { signal: DurableSignal; seenWaiting: boolean }>();
	#seq = 0;

	constructor(runner: Runner, lease: Lease) {
		this.runner = runner;
		this.lease = lease;
		this.home = lease.kind === "home";
		this.#touched = runner.clock();
	}

	get tenantId(): string {
		return this.lease.tenantId;
	}
	get partitionId(): string {
		return this.lease.partitionId;
	}
	/** The Harness. On a non-home partition `root()` throws: only the home partition may create conversation 1. */
	get harness(): Harness {
		return this.#harness;
	}
	get storage(): PgPiStorage {
		return this.#storage;
	}
	get disposed(): boolean {
		return this.#disposed;
	}
	get touchedAt(): number {
		return this.#touched;
	}
	get context(): Context {
		return withAbortSignal(this.lease.signal, BACKGROUND_CONTEXT);
	}

	/** Open the storage under the fence, then the Harness; the root exists only on the home partition. */
	async open(): Promise<void> {
		const { runner, lease } = this;
		const partition: PartitionContext = { tenantId: lease.tenantId, partitionId: lease.partitionId, home: this.home, lease };
		// The fence is checked in PostgreSQL before Harness.open reads live tasks, because open rewrites running tasks to pending.
		this.#storage = await PgPiStorage.openForOwner({ db: runner.db, fence: lease, onFault: (error) => this.#fault(error) });
		const options = runner.harnessOptions(partition);
		const models = runner.admission === undefined ? options.models : admitModels(options.models, { admission: runner.admission, tenantId: lease.tenantId, signal: lease.signal });
		const raw = await Harness.open(this.#storage, { ...options, models }, this.context);
		this.#harness = this.home ? raw : forbidRoot(raw, lease.partitionId);
		if (this.home) await raw.root(this.context, runner.homeRoot?.(lease.tenantId));
		this.#unsubscribe.push(
			raw.subscribeCommits((publication) => {
				this.#dirty = true;
				for (const change of publication.changes) {
					if (change.type === "task") this.#observeTask(change.value.id, change.value.state.status, change.value.state.status === "waiting" ? change.value.state.on.length : -1);
				}
			}),
			raw.subscribeClose(() => {
				this.#dirty = false;
			}),
			lease.onLost((reason) => void this.dispose(reason)),
		);
		await this.applySignals();
		this.#harness.resume();
	}

	/** Serialised: apply durable signals, deliver commands, then see whether the partition can be released. */
	pump(): Promise<void> {
		if (this.#pumping === undefined) {
			this.#pumping = this.#pump().finally(() => {
				this.#pumping = undefined;
			});
		}
		return this.#pumping;
	}

	async #pump(): Promise<void> {
		if (this.#disposed || this.#faulted !== undefined) return;
		try {
			const worked = await this.#deliver();
			if (worked || this.#disposed) return;
			await this.#considerRelease();
		} catch (error) {
			if (error instanceof OwnershipLost || this.#disposed || this.#faulted !== undefined) return;
			this.runner.report(error);
		}
	}

	/** Re-apply every unsettled decision, then run pending commands. Returns whether anything was pending. */
	async #deliver(): Promise<boolean> {
		const signals = await this.runner.inbox.pendingSignals(this.tenantId, this.partitionId);
		const commands = await this.runner.inbox.pendingCommands(this.tenantId, this.partitionId);
		if (signals.length === 0 && commands.length === 0) return false;
		this.#touched = this.runner.clock();
		this.#quietSince = undefined;
		await this.applySignals(signals);
		for (const command of commands) {
			await this.#runCommand(command);
			if (this.#disposed) break;
		}
		return true;
	}

	async #runCommand(command: Command): Promise<void> {
		const handler = command.kind === "submit" ? submitCommand : this.runner.commands[command.kind];
		try {
			if (handler === undefined) throw new CommandRejected(`No handler for command kind ${command.kind}`);
			await handler(this, command, this.context);
		} catch (error) {
			if (!(error instanceof CommandRejected)) throw error;
			this.runner.report(error);
		}
		// Done only after pi has durably admitted it; a crash before this redelivers it, and its requestId deduplicates.
		await this.runner.inbox.completeCommand(this.tenantId, this.partitionId, command.commandId);
		this.runner.emit({ type: "command", tenantId: this.tenantId, partitionId: this.partitionId, requestId: command.requestId, kind: command.kind });
	}

	/**
	 * Apply the durable signals (approval decisions, tool completions). Patched pi-durable 1.1.0 remembers a `resumeTask`
	 * for a task that has not suspended yet only in memory, so a decision lives in PostgreSQL and is applied again at
	 * every open until its task has been seen to leave the waiting state.
	 */
	async applySignals(pending?: DurableSignal[]): Promise<void> {
		const signals = pending ?? (await this.runner.inbox.pendingSignals(this.tenantId, this.partitionId));
		for (const signal of signals) {
			if (this.#awaiting.has(signal.taskId)) continue;
			const result = await this.#harness.resumeTask(signal.taskId as TaskId, this.context);
			this.runner.emit({ type: "signal", tenantId: this.tenantId, partitionId: this.partitionId, key: signal.key, result });
			if (result === "requested") {
				this.#awaiting.set(signal.taskId, { signal, seenWaiting: false });
			} else {
				await this.runner.inbox.settleSignal(this.tenantId, this.partitionId, signal.signalId);
			}
		}
	}

	#observeTask(taskId: number, status: string, waitingOn: number): void {
		const awaiting = this.#awaiting.get(taskId);
		if (awaiting === undefined) return;
		if (status === "waiting" && waitingOn === 0) awaiting.seenWaiting = true;
		const done = status === "terminal" || (awaiting.seenWaiting && status !== "waiting");
		if (!done) return;
		this.#awaiting.delete(taskId);
		void this.runner.inbox
			.settleSignal(this.tenantId, this.partitionId, awaiting.signal.signalId)
			.then(() => this.runner.emit({ type: "signal", tenantId: this.tenantId, partitionId: this.partitionId, key: awaiting.signal.key, result: "settled" }))
			.catch((error: unknown) => this.runner.report(error));
	}

	/** What pi says this partition needs, from `inspect()` and the due times `pi.live` publishes. */
	async assess(): Promise<ReturnType<typeof assessInspection>> {
		const inspection = await this.#harness.inspect(this.context);
		const liveDue: number[] = [];
		const conversations = new Set(inspection.tasks.map((t) => t.record.conversationId));
		for (const id of conversations) {
			liveDue.push(...liveDueTimes(await this.#harness.snapshot(LiveDoc, id as ConversationId, this.context)));
		}
		return assessInspection(inspection, this.runner.clock(), { longWaitMs: this.runner.longWaitMs, liveDue });
	}

	async #considerRelease(): Promise<void> {
		const now = this.runner.clock();
		if (!this.#dirty && now - this.#lastAssessAt < this.runner.assessEveryMs) return;
		this.#dirty = false;
		this.#lastAssessAt = now;
		const seen = await this.runner.inbox.activationSeq(this.tenantId, this.partitionId);
		const assessment = await this.assess();
		if (assessment.needsOwner) {
			this.#quietSince = undefined;
			return;
		}
		this.#quietSince ??= now;
		const idle = now - this.#quietSince >= this.runner.idleUnloadMs;
		const overCapacity = this.runner.overCapacity();
		if (!idle && !overCapacity && !this.runner.steward.draining) return;
		await this.release(seen, assessment.nextDueAt, overCapacity && !idle ? "capacity" : "idle");
	}

	/** Release the lease if no work arrived since `seen`; on success the Harness is closed and the partition is gone from this Runner. */
	async release(seen: number, nextDueAt: number | undefined, reason: "idle" | "capacity" = "idle"): Promise<boolean> {
		const result = await this.runner.steward.release(this.lease, { seenActivation: seen, nextDueAt: nextDueAt === undefined ? undefined : new Date(nextDueAt), reason });
		if (!result.released) {
			this.#dirty = true;
			return false;
		}
		this.runner.emit({ type: "released", tenantId: this.tenantId, partitionId: this.partitionId, nextDueAt });
		this.runner.emit({ type: "evicted", tenantId: this.tenantId, partitionId: this.partitionId, reason });
		await this.dispose("released");
		return true;
	}

	/** An ambiguous commit: close the Session, find out whether the batch landed, then reopen on the same lease before any new work runs. */
	#fault(error: OwnershipLost | AmbiguousCommit): void {
		if (error instanceof OwnershipLost) {
			this.lease.lose(error.message);
			return;
		}
		if (this.#faulted !== undefined) return;
		this.#faulted = error;
		this.runner.emit({ type: "ambiguous", tenantId: this.tenantId, partitionId: this.partitionId, batchId: error.batchId });
		void this.runner.recover(this, error).catch((cause: unknown) => this.runner.report(cause));
	}

	get faulted(): AmbiguousCommit | undefined {
		return this.#faulted;
	}

	/** Close the Harness and stop everything this resident started. Idempotent. */
	async dispose(reason: string): Promise<void> {
		if (this.#disposed) return;
		this.#disposed = true;
		for (const stop of this.#unsubscribe.splice(0)) stop();
		if (reason !== "released" && reason !== "recovered" && reason !== "stopped") {
			this.runner.emit({ type: "fenced", tenantId: this.tenantId, partitionId: this.partitionId, epoch: this.lease.epoch, reason });
		}
		this.runner.forget(this);
		try {
			// Closing signals the invocations, which cuts model streams through the lease signal and the Harness's own.
			await this.#harness?.close(BACKGROUND_CONTEXT);
		} catch (error) {
			if (this.#faulted === undefined && !(error instanceof OwnershipLost)) this.runner.report(error);
		}
	}

	nextSeq(): number {
		return ++this.#seq;
	}
}

/** A command the partition cannot ever run: it is completed, not retried. */
export class CommandRejected extends Error {
	constructor(message: string) {
		super(message);
		this.name = "CommandRejected";
	}
}

const submitCommand: CommandHandler = async (resident, command, context) => {
	const payload = command.payload as SubmitPayload;
	const conversation: Conversation | undefined = await resident.harness.conversation(payload.conversationId as ConversationId, context);
	if (conversation === undefined) throw new CommandRejected(`Conversation ${payload.conversationId} is not in partition ${resident.partitionId}`);
	await conversation.submit({ type: "input", content: payload.content, requestId: command.requestId, ...(payload.whenBusy === undefined ? {} : { whenBusy: payload.whenBusy }) }, context);
};

/** The Harness for a non-home partition, with `root()` removed: calling it would create a second conversation 1. */
function forbidRoot(harness: Harness, partitionId: string): Harness {
	return new Proxy(harness, {
		get(target, property, receiver) {
			if (property === "root") {
				return () => {
					throw new Error(`Harness.root() is never called on partition ${partitionId}: only the home partition holds conversation 1`);
				};
			}
			const value = Reflect.get(target, property, receiver) as unknown;
			return typeof value === "function" ? (value as (...args: unknown[]) => unknown).bind(target) : value;
		},
	});
}

/**
 * Hosts partitions in this process: claims the partitions that need an owner, keeps each one's Harness running under
 * a fenced lease, applies durable commands and signals, releases partitions that no longer need a process, bounds how
 * many stay resident, and drains for a rolling upgrade.
 */
export class Runner {
	readonly db: Db;
	readonly steward: Steward;
	readonly inbox: PartitionInbox;
	readonly admission: ModelAdmission | undefined;
	readonly commands: Readonly<Record<string, CommandHandler>>;
	readonly longWaitMs: number;
	readonly idleUnloadMs: number;
	readonly assessEveryMs: number;
	readonly maxResident: number;
	readonly harnessOptions: RunnerOptions["harnessOptions"];
	readonly homeRoot: RunnerOptions["homeRoot"];
	readonly #resident = new Map<string, ResidentPartition>();
	readonly #options: RunnerOptions;
	#timer: ReturnType<typeof setTimeout> | undefined;
	#listener: pg.Client | undefined;
	#running = false;
	#ticking: Promise<void> | undefined;

	constructor(options: RunnerOptions) {
		this.#options = options;
		this.db = options.db;
		this.steward = new Steward({ ownerId: options.steward?.ownerId ?? `runner-${process.pid}-${Math.random().toString(36).slice(2, 8)}`, ...options.steward, db: options.db });
		this.inbox = new PartitionInbox(options.db);
		this.admission = options.admission === undefined ? undefined : new ModelAdmission(options.admission);
		this.commands = options.commands ?? {};
		this.longWaitMs = options.longWaitMs ?? 60_000;
		this.idleUnloadMs = options.idleUnloadMs ?? 30_000;
		this.assessEveryMs = Math.max(50, Math.floor((options.pollMs ?? 500) * 2));
		this.maxResident = options.maxResident ?? 64;
		this.harnessOptions = options.harnessOptions;
		this.homeRoot = options.homeRoot;
	}

	clock(): number {
		return (this.#options.now ?? Date.now)();
	}
	emit(event: RunnerEvent): void {
		this.#options.onEvent?.(event);
	}
	report(error: unknown): void {
		(this.#options.onReport ?? (() => {}))(error);
	}

	get residents(): readonly ResidentPartition[] {
		return [...this.#resident.values()];
	}
	resident(tenantId: string, partitionId: string): ResidentPartition | undefined {
		return this.#resident.get(keyOf(tenantId, partitionId));
	}
	overCapacity(): boolean {
		return this.#resident.size > this.maxResident;
	}
	forget(resident: ResidentPartition): void {
		if (this.#resident.get(keyOf(resident.tenantId, resident.partitionId)) === resident) this.#resident.delete(keyOf(resident.tenantId, resident.partitionId));
	}

	/** Take a specific partition now (when it is free) and load it. */
	async activate(tenantId: string, partitionId: string): Promise<ResidentPartition | undefined> {
		const lease = await this.steward.acquire(tenantId, partitionId);
		return lease === undefined ? undefined : this.#load(lease);
	}

	async #load(lease: Lease): Promise<ResidentPartition> {
		const resident = new ResidentPartition(this, lease);
		this.#resident.set(keyOf(lease.tenantId, lease.partitionId), resident);
		try {
			await resident.open();
		} catch (error) {
			this.forget(resident);
			// The lease goes back with its work intact; the next claim retries.
			await this.steward.handOff(lease, "open failed").catch(() => {});
			throw error;
		}
		lease.startHeartbeat();
		this.emit({ type: "activated", tenantId: lease.tenantId, partitionId: lease.partitionId, epoch: lease.epoch });
		return resident;
	}

	/**
	 * Recover from a commit whose outcome is unknown: close the poisoned Session, ask PostgreSQL whether the batch
	 * landed (waiting out or ending the old backend), and reopen on the same lease. Nothing new runs in between.
	 */
	async recover(resident: ResidentPartition, error: AmbiguousCommit): Promise<void> {
		const { lease } = resident;
		await resident.dispose("recovered");
		let outcome: AmbiguousOutcome | undefined;
		while (outcome === undefined && lease.isLocallyValid()) {
			try {
				outcome = await reconcileAmbiguousCommit(this.db, { batchId: error.batchId, backendPid: error.backendPid, tenantId: lease.tenantId, partitionId: lease.partitionId });
			} catch (cause) {
				this.report(cause);
				await new Promise((resolve) => setTimeout(resolve, 100));
			}
		}
		if (outcome === undefined) return;
		this.emit({ type: "reconciled", tenantId: lease.tenantId, partitionId: lease.partitionId, batchId: error.batchId, outcome });
		if (lease.isLocallyValid()) await this.#load(lease);
	}

	/** Start claiming work. */
	async start(): Promise<void> {
		if (this.#running) return;
		this.#running = true;
		if (this.#options.listen !== false) await this.#listen();
		this.#schedule();
	}

	async #listen(): Promise<void> {
		const client = new pg.Client(this.db.pool.options);
		client.on("error", () => {
			this.#listener = undefined;
		});
		try {
			await client.connect();
			await client.query("LISTEN pim_runtime_wake");
			client.on("notification", () => void this.tick());
			this.#listener = client;
		} catch (error) {
			this.report(error);
			await client.end().catch(() => {});
		}
	}

	#schedule(): void {
		if (!this.#running) return;
		this.#timer = setTimeout(() => void this.tick().finally(() => this.#schedule()), this.#options.pollMs ?? 500);
	}

	/** One round: claim partitions while there is room, then pump every resident. Rounds never overlap. */
	tick(): Promise<void> {
		this.#ticking ??= this.#tick().finally(() => {
			this.#ticking = undefined;
		});
		return this.#ticking;
	}

	async #tick(): Promise<void> {
		try {
			while (this.#running && !this.steward.draining && this.#resident.size < this.maxResident) {
				const lease = await this.steward.claimNext(this.#options.tenantFilter === undefined ? {} : { tenantId: this.#options.tenantFilter });
				if (lease === undefined) break;
				try {
					await this.#load(lease);
				} catch (error) {
					this.report(error);
				}
			}
			// Over capacity, quiet residents are released least-recently-used first by their own pump.
			const residents = [...this.#resident.values()].sort((a, b) => a.touchedAt - b.touchedAt);
			await Promise.all(residents.map((resident) => resident.pump()));
		} catch (error) {
			this.report(error);
		}
	}

	/**
	 * Rolling-upgrade drain: stop claiming, let each partition finish or reach a point where it needs no process (within
	 * `deadlineMs`), then release it atomically with a check for newly arrived work. A partition still busy at the
	 * deadline is closed and handed off with its wake intent, so the next Runner takes it at once.
	 */
	async drain(deadlineMs: number): Promise<void> {
		this.steward.beginDrain();
		const deadline = this.clock() + deadlineMs;
		await Promise.all(
			[...this.#resident.values()].map(async (resident) => {
				while (!resident.disposed && this.clock() < deadline) {
					await resident.pump();
					if (!resident.disposed) await new Promise((resolve) => setTimeout(resolve, 20));
				}
				if (resident.disposed) {
					this.emit({ type: "drained", tenantId: resident.tenantId, partitionId: resident.partitionId, handedOff: false });
					return;
				}
				await resident.dispose("drain deadline");
				await this.steward.handOff(resident.lease, "drain");
				this.emit({ type: "drained", tenantId: resident.tenantId, partitionId: resident.partitionId, handedOff: true });
			}),
		);
		await this.stop();
	}

	/** Stop the loops and close every resident Harness without releasing leases (they expire, or a drain already released them). */
	async stop(): Promise<void> {
		this.#running = false;
		if (this.#timer !== undefined) clearTimeout(this.#timer);
		await this.#ticking;
		const listener = this.#listener;
		this.#listener = undefined;
		await listener?.end().catch(() => {});
		await Promise.all([...this.#resident.values()].map(async (resident) => {
			await resident.lease.stopHeartbeat();
			await resident.dispose("stopped");
		}));
	}
}
