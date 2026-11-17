import { createHash } from "node:crypto";
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
import { PartitionDirectory } from "./directory.ts";
import { ExternalOperations } from "./external.ts";
import { assertDurability, type DurabilityProfile } from "./durability.ts";
import { type AmbiguousCommit, OwnershipLost } from "./errors.ts";
import { type Lease, Steward, type StewardOptions } from "./ownership.ts";
import { assessInspection, liveDueTimes, sleepUntil } from "./quiescence.ts";
import { type Command, type DurableSignal, PartitionInbox } from "./signals.ts";
import { PgPiStorage, reconcileAmbiguousCommit, type AmbiguousOutcome } from "./storage.ts";

export type PartitionContext = {
	readonly ownerId: string;
	readonly partitionId: string;
	/** True only for the owner's home partition, the one that holds conversation 1. */
	readonly home: boolean;
	readonly lease: Lease;
};

export type CommandHandler = (resident: ResidentPartition, command: Command, context: Context) => Promise<void>;

/** Observability: what the Runner did with a partition. */
export type RunnerEvent =
	| { type: "activated"; ownerId: string; partitionId: string; epoch: bigint }
	| { type: "released"; ownerId: string; partitionId: string; nextDueAt: number | undefined }
	| { type: "evicted"; ownerId: string; partitionId: string; reason: "idle" | "capacity" }
	| { type: "fenced"; ownerId: string; partitionId: string; epoch: bigint; reason: string }
	| { type: "ambiguous"; ownerId: string; partitionId: string; batchId: string }
	| { type: "reconciled"; ownerId: string; partitionId: string; batchId: string; outcome: AmbiguousOutcome }
	| { type: "signal"; ownerId: string; partitionId: string; key: string; result: "resumed" | "requested" | "terminal" | "settled" }
	| { type: "operation"; ownerId: string; partitionId: string; operationId: string; state: string }
	| { type: "command"; ownerId: string; partitionId: string; commandId: string; kind: string }
	| { type: "drained"; ownerId: string; partitionId: string; handedOff: boolean }
	/** The run watchdog stopped a chat whose run made no progress, or a stop that did not end the run recycled the partition (`recycled`). */
	| { type: "stalled"; ownerId: string; partitionId: string; conversationId: number; recycled: boolean };

export type RunnerOptions = {
	readonly db: Db;
	readonly steward?: Partial<Omit<StewardOptions, "db">> & { holderId: string };
	/** pi-durable options for one partition. `models` is wrapped by the Runner's admission; the registry must be the same for every partition. */
	readonly harnessOptions: (partition: PartitionContext) => HarnessOptions | Promise<HarnessOptions>;
	/** The agent and init for the home partition's root conversation; called only for the home partition. */
	readonly homeRoot?: (ownerId: string) => Parameters<Harness["root"]>[1] | Promise<Parameters<Harness["root"]>[1]>;
	/** The agent a conversation made by the built-in `create_conversation` command starts with; `publicChatId` names the chat when the command carries one. */
	readonly chatAgent?: (ownerId: string, publicChatId?: string) => NonNullable<Parameters<Harness["createConversation"]>[0]["agent"]> | Promise<NonNullable<Parameters<Harness["createConversation"]>[0]["agent"]>>;
	/** Handlers that replace or add to the built-in ones for the contract's command kinds. */
	readonly commands?: Readonly<Record<string, CommandHandler>>;
	readonly admission?: AdmissionOptions;
	/** The most Harnesses resident in this process; default 64. Quiet ones are evicted least-recently-used first. */
	readonly maxResident?: number;
	/** How long a partition that needs no owner stays resident before it is released; default 30 s. */
	readonly idleUnloadMs?: number;
	/** A sleep, retry or poll at least this far away does not hold a partition; default 60 s. */
	readonly longWaitMs?: number;
	/**
	 * How long a run may go without any visible progress (no task changing state, no live-document change) before the run watchdog stops it; 0 turns the watchdog off.
	 * A run parked for an approval, a retry or a sleep is not stalled. Default 10 minutes.
	 */
	readonly stallMs?: number;
	/** How long a stop (the person's, or the watchdog's) waits for the run to end before the partition is recycled: closed and handed to the next claim, whose recovery finishes the abort. Default 10 s. */
	readonly abortGraceMs?: number;
	/** The commit durability the deployment promises; checked against the server when the Runner starts. Default `strict`. */
	readonly durability?: DurabilityProfile;
	/** Claim only this owner's partitions; unset claims any (a shared Runner pool). */
	readonly ownerFilter?: string;
	/** The claim and pump interval; default 500 ms. */
	readonly pollMs?: number;
	/** Listen for wake notifications besides polling. Polling alone is always enough; default true. */
	readonly listen?: boolean;
	readonly onEvent?: (event: RunnerEvent) => void;
	readonly onReport?: (error: unknown) => void;
	readonly now?: () => number;
};

const keyOf = (ownerId: string, partitionId: string): string => `${ownerId}\u0000${partitionId}`;

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
	#ready = false;
	#faulted: AmbiguousCommit | undefined;
	/** A signal whose task was not yet suspended when `resumeTask` ran: settled once the task has been seen to wait and wake, or to end. */
	readonly #awaiting = new Map<number, { signal: DurableSignal; seenWaiting: boolean }>();
	#seq = 0;
	#watch: { fingerprint: string; since: number } | undefined;
	#watchedAt = 0;

	constructor(runner: Runner, lease: Lease) {
		this.runner = runner;
		this.lease = lease;
		this.home = lease.kind === "home";
		this.#touched = runner.clock();
	}

	get ownerId(): string {
		return this.lease.ownerId;
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
	/** True once the Harness is open and its durable work has been applied. */
	get ready(): boolean {
		return this.#ready && !this.#disposed;
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
		const partition: PartitionContext = { ownerId: lease.ownerId, partitionId: lease.partitionId, home: this.home, lease };
		// The fence is checked in PostgreSQL before Harness.open reads live tasks, because open rewrites running tasks to pending.
		this.#storage = await PgPiStorage.openForOwner({ db: runner.db, fence: lease, onFault: (error) => this.#fault(error) });
		const options = await runner.harnessOptions(partition);
		const models = runner.admission === undefined ? options.models : admitModels(options.models, { admission: runner.admission, ownerId: lease.ownerId, signal: lease.signal });
		const raw = await Harness.open(this.#storage, { ...options, models }, this.context);
		this.#harness = this.home ? raw : forbidRoot(raw, lease.partitionId);
		if (this.home) await raw.root(this.context, await runner.homeRoot?.(lease.ownerId));
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
		// Whatever the previous owner left in flight outside the database is reconciled, never repeated.
		for (const operation of await runner.operations.markInterrupted(lease.ownerId, lease.partitionId)) runner.emit({ type: "operation", ownerId: lease.ownerId, partitionId: lease.partitionId, operationId: operation.operationId, state: operation.state });
		await this.applySignals();
		this.#harness.resume();
		this.#ready = true;
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
			if (!this.#disposed) await this.#guard();
			if (worked || this.#disposed) return;
			await this.#considerRelease();
		} catch (error) {
			if (error instanceof OwnershipLost || this.#disposed || this.#faulted !== undefined) return;
			this.runner.report(error);
		}
	}

	/**
	 * Abort a conversation's run and wait for it to end, but not forever: a run that ignores its abort signal (a tool that never returns, a stream that stalled) would hold
	 * the partition's commands behind it. The abort mark is durable, so when the run has not ended within the grace the partition is recycled: its Harness is closed, the lease
	 * handed off, and the next claim's recovery runs the abort handlers of what was marked.
	 */
	async stopRun(conversation: Conversation, context: Context): Promise<void> {
		const aborted = conversation.abort(context).then(() => true);
		aborted.catch(() => {});
		const grace = this.runner.abortGraceMs;
		let timer: ReturnType<typeof setTimeout> | undefined;
		const ended = await Promise.race([aborted, new Promise<false>((resolve) => (timer = setTimeout(() => resolve(false), grace)))]);
		clearTimeout(timer);
		if (!ended) await this.recycle(Number(conversation.id));
	}

	/** Give the partition up while a run is stuck in it: nothing waits for the stuck work, and its writes are fenced once the next owner takes the partition. */
	async recycle(conversationId: number): Promise<void> {
		if (this.#disposed) return;
		this.runner.emit({ type: "stalled", ownerId: this.ownerId, partitionId: this.partitionId, conversationId, recycled: true });
		void this.dispose("recycled").catch(() => {});
		await this.runner.steward.handOff(this.lease, "a stopped run did not end");
	}

	/** The run watchdog: a run whose tasks and live document have not changed for `stallMs` is stopped. */
	async #guard(): Promise<void> {
		const stallMs = this.runner.stallMs;
		const now = this.runner.clock();
		if (stallMs <= 0 || now - this.#watchedAt < Math.min(stallMs / 4, 5_000)) return;
		this.#watchedAt = now;
		const inspection = await this.#harness.inspect(this.context);
		const running = inspection.tasks.filter((t) => ["running", "ready", "completing"].includes(t.state.kind) && !((sleepUntil(t.record.state.checkpoint) ?? 0) > now));
		if (running.length === 0) {
			this.#watch = undefined;
			return;
		}
		const conversations = [...new Set(running.map((t) => t.record.conversationId as number))].sort((a, b) => a - b);
		const parts: unknown[] = running.map((t) => [t.record.id, t.state.kind]);
		for (const id of conversations) parts.push(await this.#harness.snapshot(LiveDoc, id as ConversationId, this.context));
		const fingerprint = createHash("sha256").update(JSON.stringify(parts)).digest("hex");
		if (this.#watch?.fingerprint !== fingerprint) {
			this.#watch = { fingerprint, since: now };
			return;
		}
		if (now - this.#watch.since < stallMs) return;
		this.#watch = undefined;
		for (const id of conversations) {
			if (this.#disposed) return;
			this.runner.emit({ type: "stalled", ownerId: this.ownerId, partitionId: this.partitionId, conversationId: id, recycled: false });
			const conversation = await this.#harness.conversation(id as ConversationId, this.context);
			if (conversation) await this.stopRun(conversation, this.context);
		}
	}

	/** Re-apply every unsettled decision, then run pending commands. Returns whether anything was pending. */
	async #deliver(): Promise<boolean> {
		const signals = await this.runner.inbox.pendingSignals(this.ownerId, this.partitionId);
		const commands = await this.runner.inbox.pendingCommands(this.ownerId, this.partitionId);
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
		const handler = command.kind === "create_conversation" ? createConversationCommand : (this.runner.commands[command.kind] ?? BUILTIN_COMMANDS[command.kind]);
		try {
			if (handler === undefined) throw new CommandRejected(`No handler for command kind ${command.kind}`);
			await handler(this, command, this.context);
		} catch (error) {
			if (!(error instanceof CommandRejected)) throw error;
			this.runner.report(error);
		}
		// Done only after pi has durably admitted it; a crash before this redelivers it, and its requestId deduplicates.
		await this.runner.inbox.completeCommand(this.ownerId, this.partitionId, command.seq);
		this.runner.emit({ type: "command", ownerId: this.ownerId, partitionId: this.partitionId, commandId: command.commandId, kind: command.kind });
	}

	/**
	 * Apply the durable signals (approval decisions, tool completions). Patched pi-durable 1.1.0 remembers a `resumeTask`
	 * for a task that has not suspended yet only in memory, so a decision lives in PostgreSQL and is applied again at
	 * every open until its task has been seen to leave the waiting state.
	 */
	async applySignals(pending?: DurableSignal[]): Promise<void> {
		const signals = pending ?? (await this.runner.inbox.pendingSignals(this.ownerId, this.partitionId));
		for (const signal of signals) {
			if (this.#awaiting.has(signal.taskId)) continue;
			const result = await this.#harness.resumeTask(signal.taskId as TaskId, this.context);
			this.runner.emit({ type: "signal", ownerId: this.ownerId, partitionId: this.partitionId, key: signal.key, result });
			if (result === "requested") {
				this.#awaiting.set(signal.taskId, { signal, seenWaiting: false });
			} else {
				await this.runner.inbox.settleSignal(this.ownerId, this.partitionId, signal.signalId);
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
			.settleSignal(this.ownerId, this.partitionId, awaiting.signal.signalId)
			.then(() => this.runner.emit({ type: "signal", ownerId: this.ownerId, partitionId: this.partitionId, key: awaiting.signal.key, result: "settled" }))
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
		const seen = await this.runner.inbox.activationSeq(this.ownerId, this.partitionId);
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
		this.runner.emit({ type: "released", ownerId: this.ownerId, partitionId: this.partitionId, nextDueAt });
		this.runner.emit({ type: "evicted", ownerId: this.ownerId, partitionId: this.partitionId, reason });
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
		this.runner.emit({ type: "ambiguous", ownerId: this.ownerId, partitionId: this.partitionId, batchId: error.batchId });
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
		if (reason !== "released" && reason !== "recovered" && reason !== "stopped" && reason !== "drain deadline") {
			this.runner.emit({ type: "fenced", ownerId: this.ownerId, partitionId: this.partitionId, epoch: this.lease.epoch, reason });
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

type Input = Extract<SubmissionDraft, { type: "input" }>["content"];

const conversationOf = async (resident: ResidentPartition, command: Command, context: Context): Promise<Conversation> => {
	if (command.conversationId === undefined) throw new CommandRejected(`Command ${command.commandId} names no conversation`);
	const conversation = await resident.harness.conversation(command.conversationId as ConversationId, context);
	if (conversation === undefined) throw new CommandRejected(`Conversation ${command.conversationId} is not in partition ${resident.partitionId}`);
	return conversation;
};

/** user_message, trigger_fire and coding_wake each put input in front of a conversation; the contract's `piRequestId` deduplicates a redelivery. */
const inputCommand: CommandHandler = async (resident, command, context) => {
	const conversation = await conversationOf(resident, command, context);
	const content = (command.payload.content ?? command.payload.text) as Input | undefined;
	if (content === undefined) throw new CommandRejected(`Command ${command.commandId} has no content`);
	const whenBusy = command.payload.whenBusy as "steer" | "followUp" | "reject" | undefined;
	await conversation.submit({ type: "input", content, requestId: command.piRequestId, ...(whenBusy === undefined ? {} : { whenBusy }) }, context);
};

/** approval_decision and task_wake become durable signals: the decision is in PostgreSQL before anything acts on it, and is applied now and at every later activation. */
const signalCommand: CommandHandler = async (resident, command, context) => {
	const taskId = Number(command.payload.taskId);
	if (!Number.isSafeInteger(taskId)) throw new CommandRejected(`Command ${command.commandId} names no task`);
	await resident.runner.inbox.recordSignal(resident.ownerId, resident.partitionId, {
		key: `${command.kind}:${command.commandId}`,
		kind: command.kind === "approval_decision" ? "approval" : "resume",
		taskId,
		...(typeof command.payload.callId === "string" ? { callId: command.payload.callId } : {}),
		payload: command.payload,
	});
	await resident.applySignals();
	void context;
};

const abortCommand: CommandHandler = async (resident, command, context) => {
	await resident.stopRun(await conversationOf(resident, command, context), context);
};

const handoffCommand: CommandHandler = async (resident, command, context) => {
	const handoff = command.payload.handoff;
	await (await conversationOf(resident, command, context)).reset(typeof handoff === "string" ? handoff : undefined, context);
};

/** What each contract command kind does in the owning partition. */
const BUILTIN_COMMANDS: Readonly<Record<string, CommandHandler>> = {
	user_message: inputCommand,
	trigger_fire: inputCommand,
	coding_wake: inputCommand,
	approval_decision: signalCommand,
	task_wake: signalCommand,
	abort: abortCommand,
	compaction_handoff: handoffCommand,
};

/**
 * Creates the first conversation of a new family partition. The commit that creates it also writes its directory row, so
 * routing and the conversation appear together; a redelivered command finds the conversation already there.
 */
const createConversationCommand: CommandHandler = async (resident, command, context) => {
	if (command.publicChatId !== undefined) resident.storage.reservePublicChatId(command.publicChatId);
	const existing = await resident.storage.scanConversations({}, 1, undefined, context);
	const conversation =
		existing.items[0] !== undefined
			? await resident.harness.conversation(existing.items[0].id, context)
			: await resident.harness.createConversation({ ownership: { kind: "ownerless" }, ...(resident.runner.chatAgent === undefined ? {} : { agent: await resident.runner.chatAgent(resident.ownerId, command.publicChatId) }) }, context);
	if (conversation === undefined) throw new CommandRejected("The new conversation cannot be found");
	const first = command.payload.firstInput as Input | null | undefined;
	if (first !== undefined && first !== null) await conversation.submit({ type: "input", content: first, requestId: `${command.commandId}:first` }, context);
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
	readonly directory: PartitionDirectory;
	readonly operations: ExternalOperations;
	readonly admission: ModelAdmission | undefined;
	readonly commands: Readonly<Record<string, CommandHandler>>;
	readonly longWaitMs: number;
	readonly stallMs: number;
	readonly abortGraceMs: number;
	readonly idleUnloadMs: number;
	readonly assessEveryMs: number;
	readonly maxResident: number;
	readonly harnessOptions: RunnerOptions["harnessOptions"];
	readonly homeRoot: RunnerOptions["homeRoot"];
	readonly chatAgent: RunnerOptions["chatAgent"];
	readonly #resident = new Map<string, ResidentPartition>();
	readonly #options: RunnerOptions;
	#timer: ReturnType<typeof setTimeout> | undefined;
	#listener: pg.Client | undefined;
	#running = false;
	#ticking: Promise<void> | undefined;

	constructor(options: RunnerOptions) {
		this.#options = options;
		this.db = options.db;
		this.steward = new Steward({ holderId: options.steward?.holderId ?? `runner-${process.pid}-${Math.random().toString(36).slice(2, 8)}`, ...options.steward, db: options.db });
		this.inbox = new PartitionInbox(options.db);
		this.directory = new PartitionDirectory(options.db);
		this.operations = new ExternalOperations(options.db);
		this.chatAgent = options.chatAgent;
		this.admission = options.admission === undefined ? undefined : new ModelAdmission(options.admission);
		this.commands = options.commands ?? {};
		this.longWaitMs = options.longWaitMs ?? 60_000;
		this.stallMs = options.stallMs ?? 600_000;
		this.abortGraceMs = options.abortGraceMs ?? 10_000;
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
	/** The loaded partition, once it is open; one still opening is not returned. */
	resident(ownerId: string, partitionId: string): ResidentPartition | undefined {
		const resident = this.#resident.get(keyOf(ownerId, partitionId));
		return resident?.ready === true ? resident : undefined;
	}
	/** At the bound, a resident that needs no owner is released at once instead of waiting out `idleUnloadMs`, so waiting partitions get its place. */
	overCapacity(): boolean {
		return this.#resident.size >= this.maxResident;
	}
	forget(resident: ResidentPartition): void {
		if (this.#resident.get(keyOf(resident.ownerId, resident.partitionId)) === resident) this.#resident.delete(keyOf(resident.ownerId, resident.partitionId));
	}

	/** Take a specific partition now (when it is free) and load it. */
	async activate(ownerId: string, partitionId: string): Promise<ResidentPartition | undefined> {
		const lease = await this.steward.acquire(ownerId, partitionId);
		return lease === undefined ? undefined : this.#load(lease);
	}

	async #load(lease: Lease): Promise<ResidentPartition> {
		const resident = new ResidentPartition(this, lease);
		this.#resident.set(keyOf(lease.ownerId, lease.partitionId), resident);
		try {
			await resident.open();
		} catch (error) {
			this.forget(resident);
			// The lease goes back with its work intact; the next claim retries.
			await this.steward.handOff(lease, "open failed").catch(() => {});
			throw error;
		}
		lease.startHeartbeat();
		this.emit({ type: "activated", ownerId: lease.ownerId, partitionId: lease.partitionId, epoch: lease.epoch });
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
				outcome = await reconcileAmbiguousCommit(this.db, { batchId: error.batchId, backendPid: error.backendPid, ownerId: lease.ownerId, partitionId: lease.partitionId });
			} catch (cause) {
				this.report(cause);
				await new Promise((resolve) => setTimeout(resolve, 100));
			}
		}
		if (outcome === undefined) return;
		this.emit({ type: "reconciled", ownerId: lease.ownerId, partitionId: lease.partitionId, batchId: error.batchId, outcome });
		if (lease.isLocallyValid()) await this.#load(lease);
	}

	/** Start claiming work. */
	async start(): Promise<void> {
		if (this.#running) return;
		await assertDurability(this.db, this.#options.durability ?? "strict");
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
				const lease = await this.steward.claimNext(this.#options.ownerFilter === undefined ? {} : { ownerId: this.#options.ownerFilter });
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
					this.emit({ type: "drained", ownerId: resident.ownerId, partitionId: resident.partitionId, handedOff: false });
					return;
				}
				await resident.dispose("drain deadline");
				await this.steward.handOff(resident.lease, "drain");
				this.emit({ type: "drained", ownerId: resident.ownerId, partitionId: resident.partitionId, handedOff: true });
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
