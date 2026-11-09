import { DurableObject } from "cloudflare:workers";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { type Api, type AssistantMessage, createAssistantMessageEventStream, type Model, type Provider } from "@earendil-works/pi-ai";
import { createModels, type Models, type MutableModels } from "@earendil-works/pi-ai/models";
import { createRegistry, type EntryRecord, Harness, type HarnessSettings, section } from "@earendil-works/pi-durable";
import { getAgentByName } from "agents";
import { type PiOperationResult, PiHarness } from "agents/harness/pi";
import { Lifecycle, type LifecycleJobContext, type LifecycleJobOutcome } from "agents/lifecycle";
import { CLOUDFLARE_PROVIDER_ID, createAI } from "agents/models/pi-ai";
import { deploymentSettings } from "../deployment";
import { piProvider } from "../providers";
import { projectEntries, type TranscriptMessage } from "../transcript";
import { failedResponse, wrapStreams } from "../usage";
import { PREEMPT_RESUME_PRIORITY, type QueueEntry, type QueuePlace, type Released, type SlotActivity } from "./scheduler";
import { codingScheduler } from "./scheduler-do";
import { issueBrokerToken, parseRepoUrl } from "./git-broker/broker";
import { brokerPolicy } from "./git-broker/config";
import { brokerTokenKey, GIT_BROKER_PATH } from "./git-broker/routes";
import {
	type AgentProfile,
	type Checkpoint,
	type CodingEvent,
	type CodingLimits,
	type CodingThreadRow,
	type CodingThreadState,
	CodingThreadStore,
	type TestRun,
} from "./thread-store";
import { type CodingOutputEvent, createCodingTools, REPO_DIR, type ToolJournal } from "./tools";
import { NoWorkspaceBackendError, workspaceBackends, type WorkspaceProviderRegistry } from "./workspace/registry";
import { WORKSPACE_ROOT, WorkspaceCapacityError, type Workspace, type WorkspaceSpec } from "./workspace/types";

/**
 * One coding thread, in a Durable Object of its own named by the thread's
 * ID (`codingThread`). It is the thread's control plane: it runs the agent
 * loop with pi (`PiHarness`, its transcript in this object's SQLite), calls
 * the model with the space's own model providers, keeps the thread's
 * checkpoints, test runs, spend and tool journal (./thread-store.ts), holds a
 * slot of its space's scheduler (./scheduler-do.ts) while it has a
 * workspace, and drives the workspace, a remote machine reached through
 * `Workspace` (./workspace/types.ts). Neither the model's credentials nor git
 * credentials ever enter the workspace.
 *
 * A thread works through its inputs one turn at a time: the task `start`
 * gives it, then whatever the person sends between turns (`steer`) or asks
 * it to go on with (`continue`). Each waits in the thread's inbox until the
 * thread holds a slot and a workspace with the repository cloned, and then
 * becomes one pi run: a turn. At each turn's end the thread commits what
 * changed as a checkpoint, reports itself idle to the scheduler, and emits
 * `thread.turn_ended` (`CodingEventSink`).
 *
 * Every step is driven from durable state by one job (`advance`), so an
 * eviction loses nothing: on restart pi resumes its run, and the job picks
 * up provisioning, the next input, or the end of the turn where they were.
 */
export class CodingThreadDO extends DurableObject<Env> {
	readonly store = new CodingThreadStore(this.ctx.storage.sql, () => this.now());
	readonly registry = createRegistry();
	/** The catalog the thread's model is resolved against; its provider is added once the thread's profile is known. */
	readonly #models: MutableModels = createModels();
	/** The provider id already in `#models`. */
	#loadedProvider: string | null = null;
	/** Aborted to kill every command running in the workspace; replaced after each abort. */
	#kill = new AbortController();
	/** The pi operation whose end is being waited for in memory. */
	#watching: string | null = null;
	#advancing: Promise<void> | null = null;
	#advanceAgain = false;
	#opening: Promise<Workspace> | null = null;
	/** The workspace opened in this isolate, by its ref's id. */
	#open: { id: string; workspace: Workspace } | null = null;
	#configured: string | null = null;
	/**
	 * The tools' journal, in `coding_tool_journal`. A call's record is on
	 * disk before `put` returns, since the command it records starts right
	 * after and a rerun after an eviction must find it.
	 */
	readonly #journal: ToolJournal = {
		get: (key) => this.store.journalEntry(key),
		put: async (key, entry) => {
			this.store.recordJournal(key, entry);
			await this.ctx.storage.sync();
		},
	};
	/** Who follows the output of commands as they run (`events()`). */
	readonly #outputListeners = new Set<(event: CodingOutputEvent) => void>();
	/** Turns being ended, by operation, so two who notice one end it once. */
	readonly #endings = new Map<string, Promise<void>>();

	readonly harness = new PiHarness({
		harness: async ({ storage, context }) => {
			const thread = this.store.thread();
			// A run resumed after a restart needs its model; one whose provider is gone fails its turn instead of the object's startup.
			if (thread) await this.#loadModel(thread.space, thread.profile).catch((error) => console.warn(JSON.stringify({ event: "pim.coding.model_unavailable", thread: thread.threadId, error: String(error) })));
			this.registry.install({
				name: "coding",
				sections: [section("coding_agent", () => CODING_PROMPT, { tag: false }), section("repository", () => this.#repositorySection())],
				tools: createCodingTools({
					workspace: () => this.#workspace(),
					journal: this.#journal,
					onTestRun: (run) => this.store.addTestRun(run),
					sink: (event) => {
						for (const listener of this.#outputListeners) listener(event);
					},
				}),
			});
			return Harness.open(storage, { models: this.#meter(this.#models), registry: this.registry, settings: CODING_SETTINGS }, context);
		},
	});

	readonly lifecycle = Lifecycle.install(this);

	constructor(ctx: DurableObjectState, env: Env) {
		super(ctx, env);
		this.lifecycle.use(this.harness);
	}

	/** The clock the thread's records go by. */
	protected now(): number {
		return Date.now();
	}

	/** The workspace providers threads may use: the backends the deployment's environment sets up. */
	protected workspaceProviders(): WorkspaceProviderRegistry {
		return workspaceBackends(this.env);
	}

	/** The machine image a workspace starts from. */
	protected workspaceImage(): string {
		return "pim-coding";
	}

	/**
	 * Where the workspace clones the repository from: the git broker on this
	 * Pim (./git-broker/), with a broker token for this thread and this
	 * repository alone. The token goes to git in the clone's environment
	 * only, never in a URL, argument or file, and the thread never writes it
	 * down or logs it.
	 */
	protected async cloneSource(thread: CodingThreadRow): Promise<{ url: string; token: string }> {
		const repo = parseRepoUrl(thread.repoUrl, brokerPolicy(this.env));
		const origin = deploymentSettings(this.env).publicUrl;
		if (!origin) throw new Error("PIM_PUBLIC_URL isn't set, so the workspace can't reach Pim's git broker");
		const token = await issueBrokerToken(await brokerTokenKey(this.env), { sessionId: thread.threadId, repo });
		return { url: `${origin}/api${GIT_BROKER_PATH}/${repo.owner}/${repo.name}.git`, token };
	}

	/** Who hears of what the thread does: nobody yet (see `CodingEventSink`). */
	protected eventSink(): CodingEventSink {
		return noCodingEvents;
	}

	/**
	 * The space's model provider by its id, as pi-ai calls it. Workers AI is
	 * the deployment's own binding; a provider the person or the admin added
	 * (`own:` or `shared:`) is read from the space's Pim over RPC, key and
	 * all, and kept only in this isolate's memory: never in this object's
	 * tables, and never logged. The ChatGPT plan isn't offered: its tokens
	 * are refreshed in the space's own credential store, and a second
	 * refresher would race it.
	 */
	protected async modelProvider(space: string, providerId: string): Promise<Provider> {
		if (providerId === CLOUDFLARE_PROVIDER_ID) {
			const binding = (this.env as { AI?: Ai }).AI;
			if (!binding) throw new Error("This Pim has no Workers AI");
			return createAI({ binding }).provider;
		}
		const pim = await getAgentByName(this.env.Pim, space);
		const provider = await pim.codingModelProvider(providerId);
		if (!provider) throw new Error(`The space has no model provider ${providerId}`);
		return piProvider(providerId, provider);
	}

	/** Startup: work left mid-way by an eviction goes on. */
	async onStart(): Promise<void> {
		const thread = this.store.thread();
		if (thread && thread.state !== "archived") await this.#schedule(Date.now());
	}

	/** The `advance` job: moves the thread on, and comes back while a turn or a workspace is under way. */
	async onJob({ job }: LifecycleJobContext): Promise<LifecycleJobOutcome | void> {
		if (job.fn !== ADVANCE_JOB) return;
		// Bounded, as a job must be: work still going after this goes on outside it.
		await Promise.race([this.#advance(), new Promise((resolve) => setTimeout(resolve, ADVANCE_WAIT_MS))]);
		const thread = this.store.thread();
		const busy = thread !== null && (thread.currentOperation !== null || (thread.slot === "held" && thread.state === "provisioning"));
		return busy ? { rescheduleAt: Date.now() + HEARTBEAT_MS } : undefined;
	}

	/**
	 * Starts the thread on a task: records it, asks the space's scheduler for
	 * a slot, and once it has one makes the workspace, clones the repository
	 * onto a branch of its own and runs the task. Returns while that goes on:
	 * the state is `queued` when the space's slots are all taken. Starting
	 * again with the same operation changes nothing.
	 */
	async start(input: StartThread): Promise<CodingThreadStatus> {
		await this.lifecycle.start();
		const existing = this.store.thread();
		if (existing) {
			if (existing.startOperation !== input.operationId) throw new Error("This coding thread was already started");
			this.#kick();
			return this.status();
		}
		const task = input.task?.trim();
		if (!task) throw new Error("A coding thread needs a task");
		if (!input.space || !input.createdBy || !input.operationId) throw new Error("space, createdBy and operationId are required");
		// Only GitHub repositories, through the git broker: no workspace ever clones from anywhere else.
		const repo = parseRepoUrl(input.repo, brokerPolicy(this.env));
		const budgetUsd = input.budgetUsd ?? DEFAULT_BUDGET_USD;
		if (!(Number.isFinite(budgetUsd) && budgetUsd > 0)) throw new Error("budgetUsd must be a positive number of dollars");
		const providerId = input.workspaceProvider ?? this.workspaceProviders().defaultId() ?? NO_BACKEND;
		// The model is checked before anything is recorded, so a thread never starts on a model it can't call.
		await this.#loadModel(input.space, input.profile);
		const threadId = this.#threadId();
		this.ctx.storage.transactionSync(() => {
			this.store.create({
				threadId,
				space: input.space,
				repoUrl: `https://github.com/${repo.fullName}`,
				baseRef: input.ref ?? "main",
				branch: branchName(task, threadId),
				profile: { providerId: input.profile.providerId, model: input.profile.model, ...(input.profile.thinking ? { thinking: input.profile.thinking } : {}) },
				providerId,
				state: "provisioning",
				createdBy: input.createdBy,
				parentThread: input.parent ?? null,
				limits: { ...DEFAULT_LIMITS, ...input.limits },
				budgetUsd,
				startOperation: input.operationId,
			});
			this.store.enqueue(input.operationId, task);
		});
		if (this.#ensureBackend()) {
			await this.#requestSlot();
			this.#kick();
		}
		return this.status();
	}

	async status(): Promise<CodingThreadStatus> {
		await this.lifecycle.start();
		const thread = this.store.required();
		const queue = thread.slot === "queued" ? await codingScheduler(this.env, thread.space).position(thread.threadId) : null;
		return {
			threadId: thread.threadId,
			state: thread.state,
			stateReason: thread.stateReason,
			stateDetail: thread.stateDetail,
			repo: { url: thread.repoUrl, ref: thread.baseRef, branch: thread.branch, baseSha: thread.baseSha },
			profile: thread.profile,
			workspaceProvider: thread.providerId,
			slot: thread.slot,
			queue,
			budgetUsd: thread.budgetUsd,
			spentUsd: thread.spentUsd,
			currentOperation: thread.currentOperation,
			inbox: this.store.inboxSize(),
			checkpoint: this.store.latestCheckpoint(),
			createdBy: thread.createdBy,
			parentThread: thread.parentThread,
			createdAt: thread.createdAt,
			updatedAt: thread.updatedAt,
		};
	}

	/**
	 * Tells the thread something. During a turn it joins the turn after its
	 * current tool round, or with `interrupt` stops the turn and starts a new
	 * one with it; between turns it starts the next one.
	 */
	async steer(text: string, options: { interrupt?: boolean; operationId: string }): Promise<CodingThreadStatus> {
		await this.lifecycle.start();
		const thread = this.#live();
		if (!text.trim()) throw new Error("Say something");
		if (thread.currentOperation && !options.interrupt) {
			await this.harness.submit(text, { operationId: options.operationId, whenBusy: "steer" });
			return this.status();
		}
		if (thread.currentOperation) await this.#stopTurn();
		this.#assertBudget(this.store.required());
		this.ctx.storage.transactionSync(() => {
			this.store.enqueue(options.operationId, text);
			this.#reopen();
		});
		this.#kick();
		return this.status();
	}

	/** Stops the turn under way and every command it runs, and withdraws inputs waiting for a turn. */
	async abort(): Promise<CodingThreadStatus> {
		await this.lifecycle.start();
		const thread = this.#live();
		this.ctx.storage.sql.exec("DELETE FROM coding_inbox");
		if (thread.currentOperation) await this.#stopTurn();
		else {
			this.#killCommands();
			if (thread.slot === "queued") await this.#cancelQueued();
			const now = this.store.required();
			if (now.state === "provisioning" || now.state === "queued") this.store.update({ state: "idle", stateReason: "aborted" });
		}
		return this.status();
	}

	/** Goes on after a failure or a stop, optionally with a bigger budget. */
	async continue(options: { operationId: string; budgetUsd?: number }): Promise<CodingThreadStatus> {
		await this.lifecycle.start();
		const thread = this.#live();
		if (thread.currentOperation) return this.status();
		if (options.budgetUsd !== undefined) {
			if (!(Number.isFinite(options.budgetUsd) && options.budgetUsd > 0)) throw new Error("budgetUsd must be a positive number of dollars");
			this.store.update({ budgetUsd: options.budgetUsd, budgetStopped: false });
		}
		this.#assertBudget(this.store.required());
		this.ctx.storage.transactionSync(() => {
			this.store.enqueue(options.operationId, CONTINUE_TEXT);
			this.#reopen();
		});
		this.#kick();
		return this.status();
	}

	/** Ends the thread: stops its turn, gives back its slot and deletes its workspace. */
	async archive(): Promise<CodingThreadStatus> {
		await this.lifecycle.start();
		const thread = this.store.required();
		if (thread.state === "archived") return this.status();
		if (thread.currentOperation) await this.#stopTurn();
		this.#killCommands();
		this.ctx.storage.sql.exec("DELETE FROM coding_inbox");
		this.store.update({ state: "archived", stateReason: null });
		await this.#giveBack({ keepVolume: false });
		await this.lifecycle.jobs.cancel(ADVANCE_JOB);
		return this.status();
	}

	/**
	 * What changed since `since` (the commit the thread started from, unless
	 * given) up to the latest checkpoint, as `git diff`, at most 256 KiB.
	 * Each is kept once made, so the diff of a checkpoint is there after its
	 * workspace is gone; another needs the workspace.
	 */
	async diff(since?: string): Promise<CodingDiff> {
		await this.lifecycle.start();
		const thread = this.store.required();
		const head = this.store.latestCheckpoint()?.sha ?? thread.baseSha;
		const from = since ?? thread.baseSha;
		if (!head || !from) return { since: from, head, diff: "", truncated: false };
		if (from === head) return { since: from, head, diff: "", truncated: false };
		const cached = this.store.cachedDiff(from, head);
		if (cached) return { since: from, head, ...cached };
		if (thread.slot !== "held") throw new Error("The thread's workspace isn't running: only each checkpoint's diff from the start is kept");
		return { since: from, head, ...(await this.#makeDiff(from, head)) };
	}

	async tests(): Promise<TestRun[]> {
		await this.lifecycle.start();
		return this.store.testRuns();
	}

	async checkpoints(): Promise<Checkpoint[]> {
		await this.lifecycle.start();
		return this.store.checkpoints();
	}

	/** The thread's log after `since`: model calls with their cost, turns' ends and stops. */
	async log(since = 0): Promise<CodingEvent[]> {
		await this.lifecycle.start();
		return this.store.events(since);
	}

	/** The conversation as the web app shows chats, with the thread's own notices, such as a budget stop. */
	async transcript(): Promise<TranscriptMessage[]> {
		await this.lifecycle.start();
		return transcriptOf(await this.harness.messages());
	}

	/**
	 * pi's agent events for the conversation, as newline-delimited JSON: a
	 * `snapshot` first, then one line per commit, until the reader cancels,
	 * with the output of `bash` and `test` as it is printed (`output`) in
	 * between. For the web app to follow a thread live.
	 */
	async events(): Promise<ReadableStream<Uint8Array>> {
		await this.lifecycle.start();
		const stream = await this.harness.session().events();
		const encoder = new TextEncoder();
		const line = (value: unknown) => encoder.encode(`${JSON.stringify(value)}\n`);
		const listeners = this.#outputListeners;
		let listener: ((event: CodingOutputEvent) => void) | null = null;
		return new ReadableStream<Uint8Array>({
			start(controller) {
				controller.enqueue(line(stream.snapshot));
				listener = (event) => {
					try {
						controller.enqueue(line({ type: "output", ...event }));
					} catch {
						if (listener) listeners.delete(listener);
					}
				};
				listeners.add(listener);
				stream.start(async (events) => {
					try {
						controller.enqueue(line({ type: "events", events }));
					} catch {
						await stream.stop();
					}
				});
				void stream.closed.then(() => {
					try {
						controller.close();
					} catch {}
				});
			},
			cancel() {
				if (listener) listeners.delete(listener);
				void stream.stop();
			},
		});
	}

	/** The scheduler's notice: the queued thread holds a slot now. */
	async admitted(key: string): Promise<void> {
		await this.lifecycle.start();
		const thread = this.store.thread();
		if (!thread || !this.store.firstNotice(key) || thread.slot === "held") return;
		if (thread.slot === "none" || thread.state === "archived" || thread.state === "failed") {
			// It stopped waiting meanwhile: the slot goes to the next thread.
			await codingScheduler(this.env, thread.space).release(thread.threadId);
			return;
		}
		this.#holdSlot();
		this.#kick();
	}

	/** The scheduler's notice: the thread waited too long in the queue and left it. */
	async expired(entry: QueueEntry, key: string): Promise<void> {
		await this.lifecycle.start();
		const thread = this.store.thread();
		if (!thread || !this.store.firstNotice(key) || thread.slot !== "queued") return;
		this.store.update({ slot: "none", state: "failed", stateReason: `queue_expired:${entry.reason}` });
	}

	/** The scheduler's notice: it took the thread's slot back, after the thread was idle or waited for the person too long. */
	async released(released: Released, key: string): Promise<void> {
		await this.lifecycle.start();
		const thread = this.store.thread();
		if (!thread || !this.store.firstNotice(key) || thread.slot !== "held") return;
		if (thread.currentOperation) {
			// It reported itself idle or waiting just before a turn began: ask for the slot back, at the head of the queue.
			console.warn(JSON.stringify({ event: "pim.coding.released_running", thread: thread.threadId, why: released.why }));
			this.store.update({ slot: "none", resumePriority: true });
			await this.#requestSlot();
			return;
		}
		if (released.why === "preempted") await this.#checkpoint(null).catch((error) => console.warn(JSON.stringify({ event: "pim.coding.checkpoint_failed", thread: thread.threadId, error: String(error) })));
		await this.#dropWorkspace({ keepVolume: true });
		this.store.update({ slot: "none", slotSince: null, resumePriority: released.why === "preempted" });
		this.#recordDuration(thread);
	}

	/** The thread's ID: this object's name. */
	#threadId(): string {
		const name = this.ctx.id.name;
		if (!name) throw new Error("A coding thread's Durable Object must be addressed by name");
		return name;
	}

	/** The thread, unless it is archived. */
	#live(): CodingThreadRow {
		const thread = this.store.required();
		if (thread.state === "archived") throw new Error("This coding thread is archived");
		return thread;
	}

	#assertBudget(thread: CodingThreadRow): void {
		if (thread.spentUsd >= thread.budgetUsd) throw new Error(`This coding thread has spent its $${thread.budgetUsd} budget: continue it with a bigger one`);
	}

	/** A failed or stopped thread with new input waits for a slot again. Runs in the caller's transaction. */
	#reopen(): void {
		const thread = this.store.required();
		if (thread.state === "failed" || (thread.state === "idle" && thread.slot === "none")) this.store.update({ state: thread.slot === "queued" ? "queued" : "provisioning", stateReason: null, stateDetail: null, budgetStopped: false });
	}

	/** Runs the `advance` job now, and in memory at once. */
	#kick(): void {
		void this.#schedule(Date.now()).catch((error) => console.warn(JSON.stringify({ event: "pim.coding.schedule_failed", error: String(error) })));
		void this.#advance();
	}

	#schedule(at: number): Promise<unknown> {
		return this.lifecycle.jobs.push({ id: ADVANCE_JOB, fn: ADVANCE_JOB, time: at });
	}

	/** Moves the thread on until there is nothing to do but wait; one at a time, and once more if asked again meanwhile. */
	#advance(): Promise<void> {
		if (this.#advancing) {
			this.#advanceAgain = true;
			return this.#advancing;
		}
		this.#advancing = (async () => {
			try {
				do {
					this.#advanceAgain = false;
					await this.#step().catch((error) => console.warn(JSON.stringify({ event: "pim.coding.advance_failed", error: String(error) })));
				} while (this.#advanceAgain);
			} finally {
				this.#advancing = null;
			}
		})();
		return this.#advancing;
	}

	/** One pass: notices a turn's end, asks for a slot, readies the workspace, and starts the next input's turn. */
	async #step(): Promise<void> {
		let thread = this.store.thread();
		if (!thread || thread.state === "archived" || thread.state === "failed") return;
		if (thread.currentOperation) {
			const operation = thread.currentOperation;
			const pending = await this.harness.pending();
			if (pending.some((item) => item.operationId === operation)) {
				this.#watch(operation);
				return;
			}
			await this.#endTurn(operation, await this.harness.wait(operation));
			thread = this.store.thread();
			if (!thread || thread.state === "failed" || thread.state === "archived") return;
		}
		const work = this.store.inboxSize() > 0;
		if (!work) {
			if (thread.state === "provisioning" && thread.slot !== "held") this.store.update({ state: "idle" });
			return;
		}
		if (thread.slot === "none") {
			if (!this.#ensureBackend()) return;
			await this.#requestSlot();
		}
		thread = this.store.required();
		if (thread.slot !== "held") return;
		try {
			await this.#workspace();
		} catch (error) {
			await this.#provisioningFailed(error);
			return;
		}
		try {
			await this.#startTurn();
		} catch (error) {
			// Such as a model provider removed from the space since: the thread can't go on until it is continued.
			console.warn(JSON.stringify({ event: "pim.coding.turn_not_started", thread: thread.threadId, error: String(error) }));
			if (this.store.required().currentOperation !== null) return;
			this.store.update({ state: "failed", stateReason: "turn", stateDetail: (error instanceof Error ? error.message : String(error)).slice(0, 500) });
			await this.#giveBack({ keepVolume: true });
		}
	}

	/**
	 * Whether the deployment has the thread's workspace backend. A thread
	 * started while it had none takes the default once there is one. Without
	 * one the thread fails with `no_backend` and says what to set up; it can
	 * be continued once that's done.
	 */
	#ensureBackend(): boolean {
		const thread = this.store.required();
		const registry = this.workspaceProviders();
		let id = thread.providerId;
		const fallback = registry.defaultId();
		if (id === NO_BACKEND && fallback !== null) {
			id = fallback;
			this.store.update({ providerId: id });
		}
		try {
			registry.get(id);
			return true;
		} catch (error) {
			if (!(error instanceof NoWorkspaceBackendError)) throw error;
			this.store.update({ state: "failed", stateReason: error.code, stateDetail: error.message });
			return false;
		}
	}

	/** Asks the scheduler for a slot, unless the thread holds one or waits for one. */
	async #requestSlot(): Promise<void> {
		const thread = this.store.required();
		if (thread.slot !== "none") return;
		this.store.update({ slot: "queued" });
		let result: Awaited<ReturnType<ReturnType<typeof codingScheduler>["request"]>>;
		try {
			result = await codingScheduler(this.env, thread.space).request(thread.threadId, {
				provider: thread.providerId,
				...(thread.resumePriority ? { priority: PREEMPT_RESUME_PRIORITY } : {}),
			});
		} catch (error) {
			if (this.store.required().slot === "queued") this.store.update({ slot: "none" });
			throw error;
		}
		if (result.status === "admitted") this.#holdSlot();
		// Admission may have been told meanwhile, by a notice that came while the request was answered.
		else if (this.store.required().slot === "queued") this.store.update({ state: "queued" });
	}

	/** Records that the thread holds a slot: it readies its workspace next. */
	#holdSlot(): void {
		const thread = this.store.required();
		if (thread.slot === "held") return;
		this.store.update({ slot: "held", slotSince: this.now(), resumePriority: false, ...(thread.state === "queued" ? { state: "provisioning" } : {}) });
	}

	async #cancelQueued(): Promise<void> {
		const thread = this.store.required();
		await codingScheduler(this.env, thread.space).cancel(thread.threadId);
		this.store.update({ slot: "none" });
	}

	/** Gives the slot back (or leaves the queue) and deletes the workspace, as a thread does when it fails or is archived. */
	async #giveBack(options: { keepVolume: boolean }): Promise<void> {
		const thread = this.store.required();
		if (thread.slot === "queued") await this.#cancelQueued();
		await this.#dropWorkspace(options).catch((error) => console.warn(JSON.stringify({ event: "pim.coding.destroy_failed", thread: thread.threadId, error: String(error) })));
		if (thread.slot === "held") {
			await codingScheduler(this.env, thread.space).release(thread.threadId);
			this.store.update({ slot: "none", slotSince: null });
			this.#recordDuration(thread);
		}
	}

	#recordDuration(thread: CodingThreadRow): void {
		if (thread.slotSince === null) return;
		void codingScheduler(this.env, thread.space)
			.recordDuration(Math.max(0, this.now() - thread.slotSince))
			.catch(() => {});
	}

	async #report(activity: SlotActivity): Promise<void> {
		const thread = this.store.required();
		if (thread.slot !== "held") return;
		await codingScheduler(this.env, thread.space)
			.setActivity(thread.threadId, activity)
			.catch((error) => console.warn(JSON.stringify({ event: "pim.coding.activity_failed", thread: thread.threadId, error: String(error) })));
	}

	/** Submits the inbox's oldest input to pi as the next turn. */
	async #startTurn(): Promise<void> {
		const thread = this.store.required();
		const input = this.store.nextInput();
		if (!input || thread.currentOperation) return;
		await this.#loadModel(thread.space, thread.profile);
		await this.#configure(thread.profile);
		// The same operation twice is one submission, so a restart between here and the record below repeats nothing.
		const receipt = await this.harness.submit(input.text, { operationId: input.operationId });
		this.ctx.storage.transactionSync(() => {
			this.store.dequeue(input.seq);
			this.store.update({ state: "running", stateReason: null, currentOperation: receipt.operationId, budgetStopped: false });
		});
		await this.#report("running");
		this.#watch(receipt.operationId);
	}

	/** Waits in memory for the turn to end. The `advance` job waits again after a restart. */
	#watch(operation: string): void {
		if (this.#watching === operation) return;
		this.#watching = operation;
		this.harness
			.wait(operation)
			.then((result) => this.#endTurn(operation, result))
			.catch((error) => console.warn(JSON.stringify({ event: "pim.coding.wait_failed", operation, error: String(error) })))
			.finally(() => {
				if (this.#watching === operation) this.#watching = null;
				void this.#advance();
			});
	}

	/**
	 * A turn ended: commits a checkpoint, settles the thread's state, records
	 * and emits `thread.turn_ended`, and gives the slot back when the thread
	 * failed. Ending a turn already ended does nothing.
	 */
	#endTurn(operation: string, result: PiOperationResult): Promise<void> {
		let ending = this.#endings.get(operation);
		if (!ending) {
			ending = this.#settleTurn(operation, result).finally(() => this.#endings.delete(operation));
			this.#endings.set(operation, ending);
		}
		return ending;
	}

	async #settleTurn(operation: string, result: PiOperationResult): Promise<void> {
		if (this.store.thread()?.currentOperation !== operation) return;
		const checkpoint = await this.#checkpoint(operation).catch((error) => {
			console.warn(JSON.stringify({ event: "pim.coding.checkpoint_failed", operation, error: String(error) }));
			return null;
		});
		const thread = this.store.required();
		if (thread.currentOperation !== operation) return;
		const budget = thread.budgetStopped;
		const outcome: TurnOutcome = budget ? "error" : result.status === "done" ? "completed" : result.reason === "aborted" ? "cancelled" : "error";
		const reason = budget ? "budget" : outcome === "error" ? (result.reason ?? "error") : null;
		const state: CodingThreadState = outcome === "error" ? "failed" : "idle";
		const event: TurnEndedEvent = {
			type: "thread.turn_ended",
			threadId: thread.threadId,
			space: thread.space,
			operationId: operation,
			outcome,
			...(reason ? { reason } : {}),
			...(checkpoint ? { checkpoint: checkpoint.sha } : {}),
			at: this.now(),
		};
		this.ctx.storage.transactionSync(() => {
			this.store.update({ currentOperation: null, state, stateReason: reason, stateDetail: null });
			this.store.recordEvent(event.type, event);
			if (budget) this.store.recordEvent("app.budget_stop", { budgetUsd: thread.budgetUsd, spentUsd: thread.spentUsd });
		});
		if (budget) await this.#write("app.budget_stop", { budgetUsd: thread.budgetUsd, spentUsd: thread.spentUsd });
		if (state === "failed") await this.#giveBack({ keepVolume: true });
		else if (this.store.inboxSize() === 0) await this.#report("idle");
		// Last, so whoever hears of the turn's end finds the slot already given back or idle.
		try {
			await this.eventSink().emit(event);
		} catch (error) {
			console.warn(JSON.stringify({ event: "pim.coding.sink_failed", operation, error: String(error) }));
		}
	}

	/** Stops the turn under way: kills its commands, aborts pi's run and waits for the turn to end. */
	async #stopTurn(): Promise<void> {
		const operation = this.store.required().currentOperation;
		this.#killCommands();
		await this.harness.abort();
		if (operation) await this.#endTurn(operation, await this.harness.wait(operation));
	}

	#killCommands(): void {
		this.#kill.abort(new Error("The coding thread was stopped"));
		this.#kill = new AbortController();
	}

	/** Appends an entry of the thread's own to the conversation, such as a budget stop, without asking the model anything. */
	async #write(kind: string, data: Record<string, number | string>): Promise<void> {
		const root = await (await this.harness.pi()).root(BACKGROUND_CONTEXT);
		await root.submit({ type: "write", entry: { kind, data } }, BACKGROUND_CONTEXT);
	}

	async #provisioningFailed(error: unknown): Promise<void> {
		const thread = this.store.required();
		if (error instanceof WorkspaceCapacityError) {
			// The backend is full though the scheduler gave a slot: try again at the next heartbeat.
			this.store.update({ stateReason: "workspace_capacity" });
			await this.#schedule(Date.now() + HEARTBEAT_MS);
			return;
		}
		console.warn(JSON.stringify({ event: "pim.coding.provisioning_failed", thread: thread.threadId, error: String(error) }));
		if (thread.state === "archived") return;
		const aborted = error instanceof Error && / was stopped:/.test(error.message);
		this.ctx.storage.sql.exec("DELETE FROM coding_inbox");
		this.store.update(
			aborted
				? { state: "idle", stateReason: "aborted" }
				: error instanceof NoWorkspaceBackendError
					? { state: "failed", stateReason: error.code, stateDetail: error.message }
					: { state: "failed", stateReason: "workspace", stateDetail: (error instanceof Error ? error.message : String(error)).slice(0, 500) },
		);
		if (!aborted) await this.#giveBack({ keepVolume: true });
	}

	/** Makes the thread's model resolvable: its provider in the catalog pi resolves models against. */
	async #loadModel(space: string, profile: AgentProfile): Promise<void> {
		if (this.#loadedProvider !== profile.providerId) {
			this.#models.setProvider(await this.modelProvider(space, profile.providerId));
			this.#loadedProvider = profile.providerId;
		}
		if (profile.providerId !== CLOUDFLARE_PROVIDER_ID && !this.#models.getModel(profile.providerId, profile.model)) {
			throw new Error(`The provider ${profile.providerId} has no model ${profile.model}`);
		}
	}

	/** Sets the conversation's model and thinking level from the profile. */
	async #configure(profile: AgentProfile): Promise<void> {
		const key = `${profile.providerId}/${profile.model}/${profile.thinking ?? ""}`;
		if (this.#configured === key) return;
		const root = await (await this.harness.pi()).root(BACKGROUND_CONTEXT);
		await root.configure({ model: { provider: profile.providerId, modelId: profile.model }, thinkingLevel: profile.thinking ?? "medium" }, BACKGROUND_CONTEXT);
		this.#configured = key;
	}

	/**
	 * The catalog with every model call metered against the thread's budget:
	 * before each call, the spend so far (each finished call's usage times
	 * the model's price in the catalog) is checked, and a call at or over the
	 * budget is refused with an error no retry cures, which ends the turn and
	 * stops the thread (`#endTurn`). Each call also gets the thread's own
	 * output limit for its model.
	 */
	#meter(models: Models): Models {
		return wrapStreams(models, (stream) => (model, context, options) => {
			const thread = this.store.thread();
			if (thread && thread.spentUsd >= thread.budgetUsd) {
				this.store.update({ budgetStopped: true });
				const message = failedResponse(model, `${BUDGET_MESSAGE}: spent $${thread.spentUsd.toFixed(4)} of $${thread.budgetUsd}`, this.now());
				const events = createAssistantMessageEventStream();
				events.push({ type: "error", reason: "error", error: message });
				events.end(message);
				return events;
			}
			const events = stream(model, context, { ...(options as object), maxTokens: codingMaxTokens(model) });
			events.result().then(
				(message) => this.#recordCall(model, message),
				(error) => console.warn(JSON.stringify({ event: "pim.coding.model_error", provider: model.provider, model: model.id, error: String(error).slice(0, 500) })),
			);
			return events;
		});
	}

	#recordCall(model: Model<Api>, message: AssistantMessage): void {
		const usage = { input: message.usage?.input ?? 0, output: message.usage?.output ?? 0, cacheRead: message.usage?.cacheRead ?? 0, cacheWrite: message.usage?.cacheWrite ?? 0 };
		this.store.recordModelCall(model.provider, model.id, usage, costOf(model, usage));
	}

	#repositorySection(): string | undefined {
		const thread = this.store.thread();
		if (!thread) return undefined;
		return `The repository ${thread.repoUrl} is checked out at ${REPO_DIR}, on the branch ${thread.branch} made from ${thread.baseRef}. Work in that directory.`;
	}

	/** The thread's workspace, made and cloned on first use, with its commands killed when the thread is stopped. */
	#workspace(): Promise<Workspace> {
		this.#opening ??= this.#openWorkspace().finally(() => {
			this.#opening = null;
		});
		return this.#opening;
	}

	async #openWorkspace(): Promise<Workspace> {
		const thread = this.store.required();
		if (thread.slot !== "held") throw new Error("The coding thread holds no workspace slot now");
		const provider = this.workspaceProviders().get(thread.providerId);
		if (this.#open && thread.workspaceRef?.id === this.#open.id) return this.#open.workspace;
		let workspace = thread.workspaceRef ? await provider.get(thread.workspaceRef) : null;
		if (!workspace) {
			// Creating twice for one session is one workspace, so a restart mid-create makes no second one.
			const ref = await provider.create(this.#spec(thread));
			if (this.store.required().slot !== "held") {
				// Archived or released while it was made: it goes at once.
				await provider.destroy(ref, { keepVolume: true });
				throw new Error("The coding thread gave its workspace slot up");
			}
			this.store.update({ workspaceRef: ref });
			workspace = await provider.get(ref);
			if (!workspace) throw new Error("The workspace provider lost the workspace it just made");
		}
		if ((await workspace.status()).state === "stopped") await workspace.start();
		const killable = this.#killable(workspace);
		await this.#ensureRepository(killable, thread);
		this.#open = { id: this.store.required().workspaceRef!.id, workspace: killable };
		return killable;
	}

	#spec(thread: CodingThreadRow): WorkspaceSpec {
		return {
			sessionId: thread.threadId,
			image: this.workspaceImage(),
			repo: { url: thread.repoUrl, ref: thread.baseRef, branch: thread.branch },
			limits: thread.limits,
			egress: { allow: [] },
			gitAuth: { mode: "none" },
		};
	}

	/** Clones the repository and checks out the thread's branch, unless the workspace (or its kept volume) has it. */
	async #ensureRepository(workspace: Workspace, thread: CodingThreadRow): Promise<void> {
		const cloned = await workspace.stat(`${REPO_DIR}/.git`).then(
			() => true,
			() => false,
		);
		if (cloned) return;
		const { url, token } = await this.cloneSource(thread);
		// The broker token as an HTTP header for these two commands alone: git keeps no copy of it in the repository.
		const auth = { GIT_CONFIG_COUNT: "1", GIT_CONFIG_KEY_0: "http.extraHeader", GIT_CONFIG_VALUE_0: `Authorization: Bearer ${token}` };
		await git(workspace, ["clone", "--no-checkout", url, REPO_DIR], { cwd: WORKSPACE_ROOT, timeoutMs: CLONE_TIMEOUT_MS, env: auth, secret: token });
		await git(workspace, ["fetch", "origin", thread.baseRef], { timeoutMs: CLONE_TIMEOUT_MS, env: auth, secret: token });
		await git(workspace, ["checkout", "-B", thread.branch, "FETCH_HEAD"]);
		const sha = (await git(workspace, ["rev-parse", "HEAD"])).trim();
		if (this.store.required().baseSha === null) this.store.update({ baseSha: sha });
	}

	/** Commits whatever changed in the workspace as a checkpoint, and keeps its diff from the start. Null when nothing changed or there is no workspace. */
	async #checkpoint(operation: string | null): Promise<Checkpoint | null> {
		const thread = this.store.required();
		if (thread.slot !== "held" || !thread.workspaceRef) return null;
		const workspace = await this.#workspace();
		if (!(await git(workspace, ["status", "--porcelain"])).trim()) return null;
		const message = `Checkpoint ${this.store.checkpoints().length + 1}${operation ? ` (${operation})` : ""}`;
		await git(workspace, ["add", "-A"]);
		await git(workspace, ["-c", "user.name=Pim", "-c", "user.email=coding@pim.invalid", "commit", "--no-verify", "-m", message]);
		const sha = (await git(workspace, ["rev-parse", "HEAD"])).trim();
		const checkpoint = this.store.addCheckpoint(sha, message, operation);
		const base = this.store.required().baseSha;
		if (base) await this.#makeDiff(base, sha);
		return checkpoint;
	}

	async #makeDiff(since: string, head: string): Promise<{ diff: string; truncated: boolean }> {
		const output = await git(await this.#workspace(), ["diff", since, head]);
		const truncated = output.length > MAX_DIFF_CHARS;
		const diff = truncated ? output.slice(0, MAX_DIFF_CHARS) : output;
		this.store.cacheDiff(since, head, diff, truncated);
		return { diff, truncated };
	}

	/** Deletes the workspace, keeping its files for the next one with `keepVolume`. */
	async #dropWorkspace(options: { keepVolume: boolean }): Promise<void> {
		const thread = this.store.required();
		this.#open = null;
		if (!thread.workspaceRef) return;
		await this.workspaceProviders().get(thread.providerId).destroy(thread.workspaceRef, options);
		this.store.update({ workspaceRef: null });
	}

	/** The workspace with every command also killed when the thread is stopped. */
	#killable(workspace: Workspace): Workspace {
		const kill = () => this.#kill.signal;
		return new Proxy(workspace, {
			get(target, property) {
				if (property === "exec") {
					return (cmd: string[], options: Parameters<Workspace["exec"]>[1]) =>
						target.exec(cmd, { ...options, signal: options.signal ? AbortSignal.any([options.signal, kill()]) : kill() });
				}
				const value = Reflect.get(target, property, target);
				return typeof value === "function" ? value.bind(target) : value;
			},
		});
	}
}

/** The thread's Durable Object. */
export function codingThread(env: Env, threadId: string): DurableObjectStub<CodingThreadDO> {
	return env.CodingThread.getByName(threadId);
}

export type StartThread = {
	/** The space the thread belongs to: its owner's ID, which names its Pim and its scheduler. */
	readonly space: string;
	/** A GitHub repository, https://github.com/<owner>/<name>: workspaces clone it through Pim's git broker. */
	readonly repo: string;
	/** The branch, tag or commit to start from ("main"). */
	readonly ref?: string;
	readonly task: string;
	readonly profile: AgentProfile;
	/** The most the thread may spend on its model, in dollars ($3). */
	readonly budgetUsd?: number;
	/** The thread that started this one, if any. */
	readonly parent?: string | null;
	/** Who started it: a person's or an agent's ID. */
	readonly createdBy: string;
	/** Repeating a start with the same operation changes nothing. */
	readonly operationId: string;
	/** The workspace backend's id (the deployment's default). */
	readonly workspaceProvider?: string;
	readonly limits?: Partial<CodingLimits>;
};

export type CodingThreadStatus = {
	readonly threadId: string;
	readonly state: CodingThreadState;
	readonly stateReason: string | null;
	/** What to tell the person about the state, such as how to set up a workspace backend. */
	readonly stateDetail: string | null;
	readonly repo: { readonly url: string; readonly ref: string; readonly branch: string; readonly baseSha: string | null };
	readonly profile: AgentProfile;
	readonly workspaceProvider: string;
	readonly slot: CodingThreadRow["slot"];
	/** Its place in the space's queue while it waits for a slot. */
	readonly queue: QueuePlace | null;
	readonly budgetUsd: number;
	readonly spentUsd: number;
	readonly currentOperation: string | null;
	/** Inputs waiting for a turn. */
	readonly inbox: number;
	readonly checkpoint: Checkpoint | null;
	readonly createdBy: string;
	readonly parentThread: string | null;
	readonly createdAt: number;
	readonly updatedAt: number;
};

export type CodingDiff = { readonly since: string | null; readonly head: string | null; readonly diff: string; readonly truncated: boolean };

/** How a turn ended. `needs_approval` is for a turn held for the person's approval, which no coding tool asks for yet. */
export type TurnOutcome = "completed" | "error" | "cancelled" | "needs_approval";

export type TurnEndedEvent = {
	readonly type: "thread.turn_ended";
	readonly threadId: string;
	readonly space: string;
	/** The input whose turn it was. */
	readonly operationId: string;
	readonly outcome: TurnOutcome;
	/** Why a turn ended in error, such as `budget` or `model_error`. */
	readonly reason?: string;
	/** The checkpoint the turn's changes were committed as, if anything changed. */
	readonly checkpoint?: string;
	readonly at: number;
};

export type CodingThreadEvent = TurnEndedEvent;

/**
 * Who hears of what coding threads do, such as the space's Pim to wake the
 * agent that started a thread, or the web app. Pim's own event machinery,
 * connector events and triggers (./extensions/app-events.ts,
 * ../triggers/), takes signed deliveries from outside services into a
 * space and has no way in for a space's own objects, so a thread hands its
 * events to this narrow sink instead; until something listens, nobody does.
 *
 * Every event is recorded in the thread's log (`log()`) before it is
 * emitted, and emitting is best-effort: a sink that throws is logged and the
 * event isn't emitted again. A sink that must not miss one reads the log.
 */
export interface CodingEventSink {
	emit(event: CodingThreadEvent): void | Promise<void>;
}

/** Tells nobody. */
export const noCodingEvents: CodingEventSink = { emit() {} };

/** The coding agent's instructions, before the repository's section. */
export const CODING_PROMPT = `You are a coding agent working in a git repository on a remote machine, for a person who will review your work.

- Read the code before you change it, and follow the repository's own conventions: its layout, style, naming, frameworks and tests. Look for an AGENTS.md, CONTRIBUTING or README for guidance.
- Make the smallest change that does what was asked. Don't reformat or refactor code you weren't asked to touch.
- Before you say you are done, run the repository's tests (or the ones that cover your change) and its type checks or linters if it has them, and fix what fails. If you can't run them, say why.
- Your changes are committed for you at the end of each turn; don't push or rewrite history.
- When you finish, say briefly what you changed, how you checked it, and anything left undone.`;

/** What `continue` tells the model. */
export const CONTINUE_TEXT = "Continue where you left off.";

/** A refused model call's error. "out of budget" is wording pi-ai never retries. */
export const BUDGET_MESSAGE = "Coding thread out of budget";

export const DEFAULT_BUDGET_USD = 3;

/** The workspace provider of a thread started while the deployment had none. */
const NO_BACKEND = "none";

const DEFAULT_LIMITS: CodingLimits = { cpu: 2, memMiB: 4096, diskMiB: 10_240, pids: 1024, wallClockMin: 240 };

/** The most tokens one model answer may have: the model's own limit, up to this. */
const MAX_OUTPUT_TOKENS = 32_000;

/** The most of a diff kept and returned, in characters (256 KiB of ASCII). */
const MAX_DIFF_CHARS = 256 * 1024;

const ADVANCE_JOB = "advance";
const HEARTBEAT_MS = 30_000;
const ADVANCE_WAIT_MS = 20_000;
const GIT_TIMEOUT_MS = 120_000;
const CLONE_TIMEOUT_MS = 10 * 60_000;

/** pi's run policy for coding threads: a few retries for transient model errors. */
const CODING_SETTINGS: HarnessSettings = {
	retry: { enabled: true, maxRetries: 3, baseDelayMs: 1000 },
	progress: { partialIntervalMs: 250, outputIntervalMs: 250 },
};

/** A model's answer limit for coding: its own, at most `MAX_OUTPUT_TOKENS`. */
export function codingMaxTokens(model: Pick<Model<Api>, "maxTokens">): number {
	return Math.min(model.maxTokens > 0 ? model.maxTokens : 8192, MAX_OUTPUT_TOKENS);
}

/** What a call cost, in dollars: its tokens times the model's price per million. */
export function costOf(model: Pick<Model<Api>, "cost">, usage: { input: number; output: number; cacheRead: number; cacheWrite: number }): number {
	const price = model.cost ?? { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
	return (usage.input * price.input + usage.output * price.output + usage.cacheRead * price.cacheRead + usage.cacheWrite * price.cacheWrite) / 1_000_000;
}

/** The thread's branch: `pim/` and a slug of the task, then the thread's ID's first characters. */
export function branchName(task: string, threadId: string): string {
	const slug =
		task
			.toLowerCase()
			.replace(/[^a-z0-9]+/g, "-")
			.replace(/^-+|-+$/g, "")
			.slice(0, 40)
			.replace(/-+$/, "") || "task";
	const id = threadId.toLowerCase().replace(/[^a-z0-9]/g, "").slice(0, 8) || "thread";
	return `pim/${slug}-${id}`;
}

/** The transcript for the UI: pi's messages, with the thread's own entries as notices. */
function transcriptOf(entries: readonly EntryRecord[]): TranscriptMessage[] {
	return entries.flatMap((entry): TranscriptMessage[] => {
		if (entry.kind === "app.budget_stop") {
			const data = (entry.data ?? {}) as { budgetUsd?: number; spentUsd?: number };
			return [{ id: String(entry.id), role: "notice", parts: [{ type: "text", text: `Stopped: the thread spent $${(data.spentUsd ?? 0).toFixed(2)} of its $${data.budgetUsd ?? 0} budget.` }], timestamp: 0 }];
		}
		return projectEntries([entry]);
	});
}

/** Runs git in the repository (or `cwd`) and returns its output; throws with its error output when it fails. */
async function git(workspace: Workspace, args: string[], options: { cwd?: string; timeoutMs?: number; env?: Record<string, string>; secret?: string } = {}): Promise<string> {
	let stdout = "";
	let stderr = "";
	let exit: { code: number | null; signal?: string; timedOut?: boolean } | null = null;
	for await (const event of workspace.exec(["git", ...args], { cwd: options.cwd ?? REPO_DIR, timeoutMs: options.timeoutMs ?? GIT_TIMEOUT_MS, env: { GIT_TERMINAL_PROMPT: "0", ...options.env } })) {
		if (event.type === "stdout") stdout += event.data;
		else if (event.type === "stderr") stderr += event.data;
		else if (event.type === "exit") exit = event;
	}
	if (exit?.code === 0) return stdout;
	const how = exit === null ? "ended without an exit" : exit.code === null ? (exit.timedOut ? "timed out" : "was stopped") : `exited ${exit.code}`;
	const said = options.secret ? stderr.replaceAll(options.secret, "[redacted]") : stderr;
	throw new Error(`git ${args[0] === "-c" ? "commit" : args[0]} ${how}: ${said.trim().slice(-500)}`);
}
