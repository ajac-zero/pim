import { DurableObject } from "cloudflare:workers";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { type Api, type AssistantMessage, createAssistantMessageEventStream, type Message, type Model, type Provider } from "@earendil-works/pi-ai";
import { createModels, type Models, type MutableModels } from "@earendil-works/pi-ai/models";
import { createRegistry, type EntryRecord, Harness, type HarnessSettings, section } from "@earendil-works/pi-durable";
import { getAgentByName } from "agents";
import { PiHarness } from "agents/harness/pi";
import { Lifecycle, type LifecycleJobContext, type LifecycleJobOutcome } from "agents/lifecycle";
import { CLOUDFLARE_PROVIDER_ID, createAI } from "agents/models/pi-ai";
import { deploymentSettings } from "../deployment";
import {
	type CodingEnvironment,
	environmentError,
	environmentKey,
	lockfileHashes,
	repositorySetupScript,
	runSetup,
	SETUP_TIMEOUT_MS,
	snapshotWorthKeeping,
} from "./environment-cache";
import { piProvider } from "../providers";
import { projectEntries, type TranscriptMessage } from "../transcript";
import { failedResponse, wrapStreams } from "../usage";
import {
	DEFAULT_GATEWAY_LIMITS,
	forwardToProvider,
	GATEWAY_FAMILIES,
	GATEWAY_TOKEN_MARGIN_MS,
	type GatewayCredential,
	type GatewayFamily,
	gatewayCost,
	gatewayError,
	GatewayGate,
	type GatewayHarness,
	type GatewayLimits,
	gatewayPrice,
	gatewayRoute,
	gatewayTokenKey,
	HARNESS_FAMILY,
	estimatedUsage,
	issueGatewayToken,
	type MeteredAnswer,
	newGatewayNonce,
	readCapped,
	readGatewayBody,
	sameNonce,
	sandboxModelEnv,
	type SandboxModelEnv,
	verifyGatewayToken,
} from "./model-gateway";
import type { ManagerHealth } from "./provider-capacity";
import { PREEMPT_RESUME_PRIORITY, type QueueEntry, type QueuePlace, type Released, type SlotActivity } from "./scheduler";
import { codingScheduler, codingThreadsChanged } from "./scheduler-do";
import { BranchMovedError, checkBranch, GitBrokerError, issueBrokerToken, parseRepoUrl, preparePush, type PushApprovalRequest, pushApprovalRequest, pushBranch, type PushResult, repoDefaultBranch } from "./git-broker/broker";
import { brokerPolicy, GitBrokerNotConfiguredError } from "./git-broker/config";
import type { Fetch, GitHubApp } from "./git-broker/github-app";
import { brokerTokenKey, deploymentGitHubApp, GIT_BROKER_PATH } from "./git-broker/routes";
import { authEnv } from "./harness/auth";
import { type CliHarness, cliHarness } from "./harness";
import { type HarnessAuth, HarnessRunner, INTERRUPT_GRACE_MS, type RunnerDeps, type RunResult, recoverRun } from "./harness/runner";
import { supervisorSink } from "./supervisor";
import {
	type AgentProfile,
	type Checkpoint,
	type CodingEvent,
	type CodingHarness,
	type CodingLimits,
	type CodingThreadRow,
	type CodingThreadState,
	CodingThreadStore,
	type TestRun,
} from "./thread-store";
import { type CodingOutputEvent, createCodingTools, REPO_DIR, type ToolJournal } from "./tools";
import { isLoginHarness } from "./vault/harnesses";
import { restoreHarnessCredentials, writeBackHarnessCredentials } from "./vault/inject";
import { codingVault, threadOwnership } from "./vault/vault";
import { ComposeManagerError } from "./workspace/compose";
import { DEFAULT_WORKSPACE_IMAGE, NoWorkspaceBackendError, workspaceBackends, type WorkspaceProviderRegistry } from "./workspace/registry";
import {
	type EnvironmentOwner,
	type EnvironmentSnapshot,
	WORKSPACE_ROOT,
	WorkspaceCapacityError,
	type Workspace,
	type WorkspaceProvider,
	type WorkspaceRef,
	type WorkspaceSpec,
} from "./workspace/types";
import type { HarnessEvent as CliEvent, HarnessUsage } from "./harness/types";

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
 *
 * Before its first turn a thread readies the repository's environment
 * (./environment-cache.ts): it starts its workspace from the person's
 * snapshot of the repository where there is one, and otherwise runs the
 * repository's setup script and keeps a snapshot for the threads after it.
 * The environment never stops a thread: without one it goes on as before.
 *
 * A thread whose `harness` is a vendor's CLI, such as Claude Code, runs each
 * turn as one run of that CLI in the workspace instead of a pi run
 * (./harness/): what it prints goes into the same transcript, log, test runs
 * and checkpoints. A CLI run can't outlive this object: after an eviction
 * the turn ends `interrupted`, and the next turn resumes the CLI's session.
 */
export class CodingThreadDO extends DurableObject<Env> {
	readonly store = new CodingThreadStore(
		this.ctx.storage.sql,
		() => this.now(),
		() => this.#indexChanged(),
	);
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
	/** Who follows the thread live besides pi's events (`events()`): commands' output as they run, and a CLI harness's text as it is written. */
	readonly #liveListeners = new Set<(message: CodingLiveMessage) => void>();
	/** The CLI harness's turn under way in this isolate, and its end. */
	#cli: { operation: string; runner: HarnessRunner; done: Promise<void> } | null = null;
	/** Turns being ended, by operation, so two who notice one end it once. */
	readonly #endings = new Map<string, Promise<void>>();
	/** The space's list being told of the thread's row, and whether it changed again meanwhile. */
	#indexing: Promise<void> | null = null;
	#indexAgain = false;
	/** The model gateway's caps on this thread's requests. */
	readonly #gate = new GatewayGate();

	readonly harness = new PiHarness({
		harness: async ({ storage, context }) => {
			const thread = this.store.thread();
			// A run resumed after a restart needs its model; one whose provider is gone fails its turn instead of the object's startup.
			if (thread && !cliHarness(thread.harness)) await this.#loadModel(thread.space, thread.profile).catch((error) => console.warn(JSON.stringify({ event: "pim.coding.model_unavailable", thread: thread.threadId, error: String(error) })));
			this.registry.install({
				name: "coding",
				sections: [section("coding_agent", () => CODING_PROMPT, { tag: false }), section("repository", () => this.#repositorySection())],
				tools: createCodingTools({
					workspace: () => this.#workspace(),
					journal: this.#journal,
					onTestRun: (run) => this.store.addTestRun(run),
					sink: (event) => this.#tellLive({ type: "output", ...event }),
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
		return DEFAULT_WORKSPACE_IMAGE;
	}

	/** How often a thread waiting for another thread's build of its environment looks for the snapshot. */
	protected environmentPollMs(): number {
		return 5_000;
	}

	/** Hosts the workspace may reach through the egress proxy: Pim's git broker and the common package registries. */
	protected egressAllow(): string[] {
		const hosts = ["registry.npmjs.org", "pypi.org", "files.pythonhosted.org", "crates.io", "static.crates.io", "index.crates.io", "proxy.golang.org"];
		try {
			const origin = deploymentSettings(this.env).publicUrl;
			if (origin) hosts.unshift(new URL(origin).hostname);
		} catch {}
		return hosts;
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

	/** How a CLI harness signs in for the thread, as `authEnv` says (./harness/auth.ts): the person's subscription, or their API key from the coding vault. */
	protected harnessAuth(thread: CodingThreadRow, harness: CliHarness): Promise<HarnessAuth> {
		const vault = codingVault(this.env);
		return authEnv(thread, harness, (id) => vault.loadApiKey(thread.space, id));
	}

	/** The person's login for the harness, put into the thread's workspace and written back from it, through the coding vault. */
	protected harnessCredentials(thread: CodingThreadRow, harness: CliHarness, workspace: Workspace): RunnerDeps["credentials"] {
		const vault = codingVault(this.env);
		const owns = threadOwnership(this.env);
		const target = () => {
			const ref = this.store.required().workspaceRef;
			if (!ref) throw new Error("The coding thread has no workspace");
			return { userId: thread.space, ref, workspace };
		};
		const id = harness.id;
		return {
			restore: () => {
				// Only a harness whose login the vault keeps as files has one to put in.
				if (!isLoginHarness(id)) throw new Error(`${harness.name} keeps no login files`);
				return restoreHarnessCredentials(vault, owns, target(), id);
			},
			writeBack: (restored) => writeBackHarnessCredentials(vault, owns, restored, target()),
		};
	}

	/** How long a CLI harness has to end its turn after SIGINT. */
	protected harnessGraceMs(): number {
		return INTERRUPT_GRACE_MS;
	}

	/** Who hears of what the thread does: the chat of the agent that started it, if one did (./supervisor.ts). */
	protected eventSink(): CodingEventSink {
		return supervisorSink(this.env);
	}

	/** The model a thread started without a profile runs on: its space's default (`Pim.codingDefaultProfile`). */
	protected async defaultProfile(space: string): Promise<AgentProfile> {
		return (await getAgentByName(this.env.Pim, space)).codingDefaultProfile();
	}

	/** The deployment's GitHub App, which pushes; null when it isn't configured. */
	protected githubApp(): GitHubApp | null {
		return deploymentGitHubApp(this.env);
	}

	/** How Pim reaches GitHub to push: the Worker's `fetch`, unless given. */
	protected githubFetch(): Fetch | undefined {
		return undefined;
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

	/** How the model gateway reaches model providers: the Worker's `fetch`, unless given. */
	protected gatewayFetch(): typeof fetch {
		return (input, init) => fetch(input, init);
	}

	/** The model gateway's caps on this thread's requests. */
	protected gatewayLimits(): GatewayLimits {
		return DEFAULT_GATEWAY_LIMITS;
	}

	/** The space's key for `family`, read from the space's Pim for one request, preferring the provider the thread runs on. */
	protected async gatewayCredential(space: string, family: GatewayFamily, preferred: string): Promise<GatewayCredential | null> {
		return (await getAgentByName(this.env.Pim, space)).codingGatewayCredential(family, preferred);
	}

	/** Startup: work left mid-way by an eviction goes on. */
	async onStart(): Promise<void> {
		const thread = this.store.thread();
		if (thread) this.#indexChanged();
		if (thread && thread.state !== "archived") await this.#schedule(Date.now());
	}

	/** The `advance` job: moves the thread on, and comes back while a turn or a workspace is under way. */
	async onJob({ job }: LifecycleJobContext): Promise<LifecycleJobOutcome | void> {
		if (job.fn !== ADVANCE_JOB) return;
		// Bounded, as a job must be: work still going after this goes on outside it.
		await Promise.race([this.#advance(), new Promise((resolve) => setTimeout(resolve, ADVANCE_WAIT_MS))]);
		const thread = this.store.thread();
		// A queued thread whose backend reports its health checks it again each time, so a queue held for low disk opens once there is room.
		const busy =
			thread !== null &&
			(thread.currentOperation !== null ||
				(thread.slot === "held" && (thread.state === "provisioning" || thread.environment.rebuildRequested)) ||
				(thread.slot === "queued" && this.#healthOf(thread) !== null));
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
		const harness = input.harness ?? "pi";
		const cli = cliHarness(harness);
		if (harness !== "pi" && !cli) throw new Error("harness not yet available");
		// A CLI harness picks its own model: a profile of its own names one, any other means its default.
		const profile = cli
			? { providerId: cli.id, model: input.profile?.providerId === cli.id ? input.profile.model : "default" }
			: (input.profile ?? (await this.defaultProfile(input.space)));
		// The model is checked before anything is recorded, so a thread never starts on a model it can't call.
		if (!cli) await this.#loadModel(input.space, profile);
		const threadId = this.#threadId();
		this.ctx.storage.transactionSync(() => {
			this.store.create({
				threadId,
				space: input.space,
				repoUrl: `https://github.com/${repo.fullName}`,
				baseRef: input.ref ?? "main",
				branch: branchName(task, threadId),
				profile: { providerId: profile.providerId, model: profile.model, ...(profile.thinking ? { thinking: profile.thinking } : {}) },
				harness,
				providerId,
				state: "provisioning",
				createdBy: input.createdBy,
				parentThread: input.parent ?? null,
				limits: threadLimits(repo.fullName, input.limits),
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
			harness: thread.harness,
			workspaceProvider: thread.providerId,
			slot: thread.slot,
			queue,
			budgetUsd: thread.budgetUsd,
			spentUsd: thread.spentUsd,
			currentOperation: thread.currentOperation,
			inbox: this.store.inboxSize(),
			checkpoint: this.store.latestCheckpoint(),
			environment: thread.environment,
			createdBy: thread.createdBy,
			parentThread: thread.parentThread,
			createdAt: thread.createdAt,
			updatedAt: thread.updatedAt,
		};
	}

	/** The repository's prepared environment in the thread's workspace (./environment-cache.ts). */
	async environment(): Promise<CodingEnvironment> {
		await this.lifecycle.start();
		return this.store.required().environment;
	}

	/**
	 * Builds the thread's environment again: deletes the person's snapshot of
	 * its current key now, then, once the thread holds its workspace and
	 * between turns, runs the setup script there again and keeps a new
	 * snapshot (`#prepareEnvironment`). A thread without a slot asks for one;
	 * a failed thread rebuilds once it is continued.
	 */
	async rebuildEnvironment(): Promise<CodingEnvironment> {
		await this.lifecycle.start();
		const thread = this.#live();
		if (thread.currentOperation) throw new Error("This coding thread's turn is under way: rebuild its environment between turns");
		const provider = this.workspaceProviders().get(thread.providerId);
		if (!provider.capabilities.environmentSnapshots) throw new Error("This coding thread's workspace backend keeps no environments");
		if (thread.environment.key) await provider.deleteEnvironment(thread.space, thread.environment.key);
		this.#setEnvironment({ state: "building", rebuildRequested: true, error: undefined });
		this.#kick();
		return this.store.required().environment;
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
			if (cliHarness(thread.harness)) {
				// A CLI takes no input mid-turn: the text is the next turn, which resumes the CLI's session.
				this.store.enqueue(options.operationId, text);
				return this.status();
			}
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
		// Whatever runs in the workspace loses its model at once.
		this.store.setGatewayNonce(null);
		if (thread.currentOperation) await this.#stopTurn();
		else {
			this.#killCommands();
			if (thread.slot === "queued") await this.#cancelQueued();
			const now = this.store.required();
			if (now.state === "provisioning" || now.state === "queued") this.store.update({ state: "idle", stateReason: "aborted" });
		}
		return this.status();
	}

	/**
	 * Calls off a thread whose next input hasn't started its turn: it leaves
	 * the queue or gives its slot back, its inputs are withdrawn, and the
	 * input's turn ends `cancelled`, recorded and emitted as any turn's end.
	 * The thread is then idle (`cancelled`), and can be steered or continued.
	 * A thread with nothing waiting changes nothing; one in a turn refuses.
	 */
	async cancel(): Promise<CodingThreadStatus> {
		await this.lifecycle.start();
		const thread = this.#live();
		if (thread.currentOperation) throw new Error("This coding thread's turn has started: abort it instead");
		const input = this.store.nextInput();
		if (!input) return this.status();
		this.#killCommands();
		const event: TurnEndedEvent = {
			type: "thread.turn_ended",
			threadId: thread.threadId,
			space: thread.space,
			operationId: input.operationId,
			outcome: "cancelled",
			reason: "cancelled",
			state: "idle",
			spentUsd: thread.spentUsd,
			budgetUsd: thread.budgetUsd,
			at: this.now(),
		};
		// The slot is let go of here, so an admission that arrives meanwhile finds the thread wanting none and gives it back.
		this.ctx.storage.transactionSync(() => {
			this.ctx.storage.sql.exec("DELETE FROM coding_inbox");
			this.store.update({ state: "idle", stateReason: "cancelled", stateDetail: null, slot: "none", slotSince: null });
			this.store.recordEvent(event.type, event);
		});
		const scheduler = codingScheduler(this.env, thread.space);
		if (thread.slot === "queued") await scheduler.cancel(thread.threadId);
		else if (thread.slot === "held") {
			await this.#dropWorkspace({ keepVolume: true }).catch((error) => console.warn(JSON.stringify({ event: "pim.coding.destroy_failed", thread: thread.threadId, error: String(error) })));
			await scheduler.release(thread.threadId);
			this.#recordDuration(thread);
		}
		await this.#emit(event);
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
			// A thread waiting for the person's login still has the input it waited with: that goes on, with nothing added.
			if (!(thread.state === "waiting_input" && this.store.inboxSize() > 0)) this.store.enqueue(options.operationId, CONTINUE_TEXT);
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
		this.store.setGatewayNonce(null);
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
		const listeners = this.#liveListeners;
		let listener: ((message: CodingLiveMessage) => void) | null = null;
		return new ReadableStream<Uint8Array>({
			start(controller) {
				controller.enqueue(line(stream.snapshot));
				listener = (message) => {
					try {
						controller.enqueue(line(message));
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

	/**
	 * Readies a push of the thread's latest checkpoint to `branch` (its own,
	 * unless given), for the person to approve: the GitHub App is set up, the
	 * branch is one Pim pushes to, and the workspace makes a git bundle of the
	 * branch, which Pim checks (`preparePush`). Says why not, as a code, when
	 * it can't: before anything is asked.
	 */
	async preparePush(branch?: string): Promise<PushPreparation> {
		await this.lifecycle.start();
		const thread = this.store.required();
		const app = this.githubApp();
		if (!app) return { ok: false, code: "github_app_not_configured", message: GITHUB_APP_NOT_CONFIGURED };
		const target = branch ?? thread.branch;
		const policy = brokerPolicy(this.env);
		try {
			checkBranch(target, policy);
		} catch (error) {
			return { ok: false, code: "push_refused", message: errorText(error) };
		}
		if (thread.state === "archived") return { ok: false, code: "archived", message: "This coding thread is archived" };
		const checkpoint = this.store.latestCheckpoint();
		if (!checkpoint) return { ok: false, code: "nothing_to_push", message: "The thread hasn't committed anything yet: each turn's changes are committed when it ends" };
		if (thread.slot !== "held" || !thread.workspaceRef) {
			return { ok: false, code: "workspace_not_running", message: "The thread's workspace isn't running: continue or steer the thread, then push once its turn ends" };
		}
		try {
			const bundle = await this.#bundle(target, checkpoint.sha);
			const prepared = preparePush({ app, policy }, { sessionId: thread.threadId, repo: thread.repoUrl, branch: target, bundle });
			return { ok: true, request: { ...pushApprovalRequest(prepared), checkpoint: checkpoint.sha } };
		} catch (error) {
			if (error instanceof GitBrokerError && error.status === 403) return { ok: false, code: "push_refused", message: error.message };
			return { ok: false, code: "conflict", message: errorText(error) };
		}
	}

	/**
	 * Pushes what the person approved (`preparePush`'s request): a bundle of
	 * the same checkpoint, made again, which must name the same commit; Pim
	 * sends it to GitHub (`pushBranch`), and the log records the push.
	 */
	async push(approved: { branch: string; checkpoint: string; head: string }): Promise<{ ok: true; result: PushResult } | { ok: false; message: string }> {
		await this.lifecycle.start();
		const thread = this.store.required();
		const app = this.githubApp();
		if (!app) return { ok: false, message: GITHUB_APP_NOT_CONFIGURED };
		if (thread.slot !== "held" || !thread.workspaceRef) return { ok: false, message: "The thread's workspace isn't running now: continue the thread, then ask to push again" };
		try {
			const policy = brokerPolicy(this.env);
			const fetch = this.githubFetch();
			const request = { sessionId: thread.threadId, repo: thread.repoUrl, branch: approved.branch, bundle: await this.#bundle(approved.branch, approved.checkpoint) };
			const deps = { app, policy, ...(fetch ? { fetch } : {}) };
			if (preparePush(deps, request).head !== approved.head) return { ok: false, message: "The branch isn't what was approved any more: ask to push again" };
			const result = await pushBranch(deps, request);
			this.store.recordEvent("thread.pushed", { repo: result.repo, branch: result.branch, before: result.before, after: result.after, outcome: result.outcome });
			return { ok: true, result };
		} catch (error) {
			return { ok: false, message: error instanceof GitBrokerNotConfiguredError ? GITHUB_APP_NOT_CONFIGURED : errorText(error) };
		}
	}

	/**
	 * Readies a merge of the thread's latest checkpoint into the repository's
	 * default branch, for the person to approve: the GitHub App is set up, the
	 * workspace runs, and there is a checkpoint. Nothing is fetched or changed
	 * yet. Says why not, as a code, when it can't.
	 */
	async prepareMerge(): Promise<MergePreparation> {
		await this.lifecycle.start();
		const thread = this.store.required();
		const app = this.githubApp();
		if (!app) return { ok: false, code: "github_app_not_configured", message: GITHUB_APP_NOT_CONFIGURED };
		if (thread.state === "archived") return { ok: false, code: "archived", message: "This coding thread is archived" };
		const checkpoint = this.store.latestCheckpoint();
		if (!checkpoint) return { ok: false, code: "nothing_to_push", message: "The thread hasn't committed anything yet: each turn's changes are committed when it ends" };
		if (thread.slot !== "held" || !thread.workspaceRef) {
			return { ok: false, code: "workspace_not_running", message: "The thread's workspace isn't running: continue or steer the thread, then merge once its turn ends" };
		}
		try {
			const fetch = this.githubFetch();
			const defaultBranch = await repoDefaultBranch({ app, policy: brokerPolicy(this.env), ...(fetch ? { fetch } : {}) }, thread.repoUrl);
			const repo = parseRepoUrl(thread.repoUrl).fullName;
			return { ok: true, request: { checkpoint: checkpoint.sha, summary: `Merge ${thread.branch} (${checkpoint.sha.slice(0, 12)}) into ${defaultBranch} of github.com/${repo}, with no force push` } };
		} catch (error) {
			return { ok: false, code: "conflict", message: errorText(error) };
		}
	}

	/**
	 * Merges what the person approved (`prepareMerge`'s checkpoint) into the
	 * repository's default branch: fetches it into the workspace; if the
	 * checkpoint already descends from it, that is the new head, and if not,
	 * the checkpoint is rebased onto it, and a rebase that conflicts is
	 * aborted and reported, the thread's branch as it was. Pim then moves the
	 * default branch forward to the head (never a force push); if it moved
	 * meanwhile, the rebase is made once more. The thread's own branch is
	 * pushed to the same head as well, when GitHub lets it.
	 */
	async merge(approved: { checkpoint: string }): Promise<{ ok: true; result: MergeResult } | { ok: false; message: string }> {
		await this.lifecycle.start();
		const thread = this.store.required();
		const app = this.githubApp();
		if (!app) return { ok: false, message: GITHUB_APP_NOT_CONFIGURED };
		if (thread.slot !== "held" || !thread.workspaceRef) return { ok: false, message: "The thread's workspace isn't running now: continue the thread, then ask to merge again" };
		if (this.store.latestCheckpoint()?.sha !== approved.checkpoint) return { ok: false, message: "The thread has a newer checkpoint than the one approved: ask to merge again" };
		try {
			const fetch = this.githubFetch();
			const deps = { app, policy: brokerPolicy(this.env), ...(fetch ? { fetch } : {}) };
			const defaultBranch = await repoDefaultBranch(deps, thread.repoUrl);
			const workspace = await this.#workspace();
			const identity = ["-c", "user.name=Pim", "-c", "user.email=coding@pim.invalid"];
			if ((await git(workspace, ["rev-parse", `refs/heads/${thread.branch}`])).trim() !== approved.checkpoint) throw new Error("The thread's branch has moved past its latest checkpoint: merge once its turn ends");
			let head = approved.checkpoint;
			let rebased = false;
			for (let attempt = 0; ; attempt++) {
				await git(workspace, ["fetch", "origin", `+refs/heads/${defaultBranch}:refs/pim/merge-base`]);
				const base = (await git(workspace, ["rev-parse", "refs/pim/merge-base"])).trim();
				const common = (await git(workspace, ["merge-base", base, head]).catch(() => "")).trim();
				if (common === head) return { ok: true, result: { repo: parseRepoUrl(thread.repoUrl).fullName, branch: defaultBranch, before: base, after: base, outcome: "unchanged", rebased, threadBranch: null } };
				if (common !== base) {
					// The default branch has commits the thread doesn't: put the thread's commits on top of them, aside from the thread's branch.
					try {
						await git(workspace, ["checkout", "-f", "--detach", head]);
						await git(workspace, [...identity, "rebase", base]);
					} catch (error) {
						await git(workspace, ["rebase", "--abort"]).catch(() => {});
						await git(workspace, ["checkout", "-f", "-B", thread.branch, head]).catch(() => {});
						return { ok: false, message: `The thread's changes conflict with ${defaultBranch} (${base.slice(0, 12)}); nothing was pushed and the thread's branch is as it was. Steer the thread to rebase onto origin/${defaultBranch} and resolve the conflicts, then merge again. ${errorText(error)}` };
					}
					head = (await git(workspace, ["rev-parse", "HEAD"])).trim();
					rebased = true;
					await git(workspace, ["checkout", "-f", "-B", thread.branch, head]);
					const checkpoint = this.store.addCheckpoint(head, `Rebased onto ${defaultBranch}`, null);
					const since = this.store.required().baseSha;
					if (since) await this.#makeDiff(since, checkpoint.sha);
				}
				try {
					const request = { sessionId: thread.threadId, repo: thread.repoUrl, branch: defaultBranch, toDefault: true, bundle: await this.#bundle(defaultBranch, head, base) };
					const result = await pushBranch(deps, request);
					this.store.recordEvent("thread.merged", { repo: result.repo, branch: result.branch, before: result.before, after: result.after, outcome: result.outcome, rebased });
					return { ok: true, result: { ...result, rebased, threadBranch: await this.#pushOwnBranch(deps, head) } };
				} catch (error) {
					if (!(error instanceof BranchMovedError)) throw error;
					if (attempt > 0) return { ok: false, message: `${defaultBranch} moved again while merging; nothing was pushed to it. Ask to merge again.` };
				}
			}
		} catch (error) {
			return { ok: false, message: error instanceof GitBrokerNotConfiguredError ? GITHUB_APP_NOT_CONFIGURED : errorText(error) };
		}
	}

	/** Pushes the thread's own branch at `head` after a merge, so it matches what was merged; null when GitHub wouldn't move it (its branch has other commits). */
	async #pushOwnBranch(deps: Parameters<typeof pushBranch>[0], head: string): Promise<string | null> {
		const thread = this.store.required();
		try {
			const result = await pushBranch(deps, { sessionId: thread.threadId, repo: thread.repoUrl, branch: thread.branch, bundle: await this.#bundle(thread.branch, head) });
			this.store.recordEvent("thread.pushed", { repo: result.repo, branch: result.branch, before: result.before, after: result.after, outcome: result.outcome });
			return thread.branch;
		} catch {
			return null;
		}
	}

	/**
	 * A git bundle of `branch` at the checkpoint `sha`, from the commit the
	 * thread started from (or `since`), which GitHub has. The thread's own
	 * branch is bundled as it is, and must still be at the checkpoint; another
	 * branch is set to it first.
	 */
	async #bundle(branch: string, sha: string, since = this.store.required().baseSha): Promise<Uint8Array> {
		const thread = this.store.required();
		const workspace = await this.#workspace();
		const ref = `refs/heads/${branch}`;
		if (branch === thread.branch) {
			if ((await git(workspace, ["rev-parse", ref])).trim() !== sha) throw new Error("The thread's branch has moved past its latest checkpoint: push once its turn ends");
		} else await git(workspace, ["update-ref", ref, sha]);
		const file = `${WORKSPACE_ROOT}/.pim-push.bundle`;
		await git(workspace, ["bundle", "create", file, since ? `${since}..${ref}` : ref]);
		try {
			return await workspace.readFile(file);
		} finally {
			await workspace.remove(file).catch(() => {});
		}
	}

	/**
	 * A token for the model gateway (./model-gateway.ts) for this thread and
	 * `families`, to give a CLI in its workspace instead of a key. It lasts
	 * the thread's wall clock and a margin, and every token of the thread is
	 * revoked when it is aborted or archived (`revokeGatewayTokens`); one
	 * minted after that carries a new nonce.
	 */
	async gatewayToken(families: readonly GatewayFamily[]): Promise<{ token: string; expiresAt: number }> {
		await this.lifecycle.start();
		const thread = this.#live();
		if (families.length === 0 || !families.every((family) => GATEWAY_FAMILIES.includes(family))) throw new Error(`families must be some of ${GATEWAY_FAMILIES.join(", ")}`);
		let nonce = this.store.gatewayNonce();
		if (nonce === null) {
			nonce = newGatewayNonce();
			this.store.setGatewayNonce(nonce);
		}
		const expiresAt = this.now() + thread.limits.wallClockMin * 60_000 + GATEWAY_TOKEN_MARGIN_MS;
		const token = await issueGatewayToken(await gatewayTokenKey(this.env), { threadId: thread.threadId, space: thread.space, families: [...new Set(families)], nonce, expiresAt });
		return { token, expiresAt };
	}

	/** Revokes every gateway token of the thread: a CLI still holding one is refused from its next request. */
	async revokeGatewayTokens(): Promise<void> {
		await this.lifecycle.start();
		this.store.setGatewayNonce(null);
	}

	/**
	 * What to put in the workspace for `harness` to call its model through the
	 * gateway: its environment, with a fresh token as its key, and the one host
	 * its egress must allow, this Pim's.
	 */
	async modelGatewayEnv(harness: GatewayHarness): Promise<SandboxModelEnv> {
		const origin = deploymentSettings(this.env).publicUrl;
		if (!origin) throw new Error("PIM_PUBLIC_URL isn't set, so the workspace can't reach Pim's model gateway");
		const { token } = await this.gatewayToken([HARNESS_FAMILY[harness]]);
		return sandboxModelEnv(origin, harness, token);
	}

	/**
	 * A CLI's request to the model gateway, `path` being under the family's
	 * route, as the Worker hands it on (`serveModelGateway`). It is refused
	 * unless the token is this thread's current one and lets `family`, the
	 * route is one the gateway forwards, the thread is under its request caps
	 * and its budget, and its space has a key for the family. Then the space's
	 * key goes with it to the provider, and once the answer ends its usage is
	 * charged to the thread, in the log and its spend in one transaction.
	 * Requests already under way may together spend past the budget; the
	 * next one is refused.
	 */
	async gatewayRequest(token: string, family: GatewayFamily, path: string, request: Request): Promise<Response> {
		await this.lifecycle.start();
		const claims = await verifyGatewayToken(await gatewayTokenKey(this.env), token, this.now());
		const thread = this.store.thread();
		const nonce = this.store.gatewayNonce();
		if (!claims || !thread || claims.threadId !== thread.threadId || claims.space !== thread.space || nonce === null || !sameNonce(claims.nonce, nonce) || thread.state === "archived") {
			await request.body?.cancel().catch(() => {});
			return gatewayError(family, 401, "invalid_token", "This model gateway token isn't valid for this coding thread any more");
		}
		if (!claims.families.includes(family)) return gatewayError(family, 403, "family_not_allowed", `This token doesn't let the thread call ${family}`);
		const url = new URL(request.url);
		const api = gatewayRoute(family, request.method, path, url.search);
		if (api instanceof Response) return api;
		const limits = this.gatewayLimits();
		const refused = this.#gate.admit(this.now(), limits);
		if (refused) {
			const message = refused.refused === "rate_limited" ? `This coding thread made ${limits.requestsPerMinute} model requests in the last minute: wait a little` : `This coding thread has ${limits.concurrent} model requests under way: wait for one to finish`;
			return gatewayError(family, 429, refused.refused, message, { "retry-after": String(refused.retryAfter) });
		}
		let released = false;
		const release = () => {
			if (!released) this.#gate.release();
			released = true;
		};
		try {
			const current = this.store.required();
			if (current.spentUsd >= current.budgetUsd) {
				release();
				return gatewayError(family, 402, "budget_exhausted", `${BUDGET_MESSAGE}: spent $${current.spentUsd.toFixed(4)} of $${current.budgetUsd}`);
			}
			const raw = await readCapped(request, limits.maxRequestBytes);
			if (raw === null) {
				release();
				return gatewayError(family, 413, "too_large", `The request is larger than the ${limits.maxRequestBytes} bytes the model gateway takes`);
			}
			const read = readGatewayBody(api, raw);
			if (typeof read === "string") {
				release();
				return gatewayError(family, 400, "invalid_request", read);
			}
			const credential = await this.gatewayCredential(thread.space, family, thread.profile.providerId);
			if (!credential) {
				release();
				return gatewayError(family, 403, "no_credential", `The space has no ${family === "anthropic" ? "Anthropic" : "OpenAI API"} key: add one in Pim's Settings → Model`);
			}
			const started = this.now();
			return await forwardToProvider({
				family,
				api,
				path,
				search: url.search,
				request,
				body: read.body,
				credential,
				fetch: this.gatewayFetch(),
				limits,
				settle: (answer) => {
					release();
					this.#settleGateway({ family, api, providerId: credential.providerId, model: read.model, requestBytes: read.body.byteLength, started }, answer);
				},
			});
		} catch (error) {
			release();
			console.warn(JSON.stringify({ event: "pim.coding.gateway_failed", thread: thread.threadId, family, error: String(error).slice(0, 300) }));
			return gatewayError(family, 502, "upstream_unreachable", "The model gateway couldn't forward the request");
		}
	}

	/** Charges an answer the gateway passed on to the thread, and logs the request, never its key or content. */
	#settleGateway(call: { family: GatewayFamily; api: string; providerId: string; model: string; requestBytes: number; started: number }, answer: MeteredAnswer | null): void {
		const log = { event: "pim.coding.gateway", thread: this.store.thread()?.threadId ?? null, family: call.family, api: call.api, model: call.model, ms: this.now() - call.started };
		// Refused or failed answers, and counting tokens, cost nothing.
		if (answer === null || call.api === "anthropic-count-tokens") {
			console.log(JSON.stringify({ ...log, charged: false }));
			return;
		}
		void (async () => {
			const usage = answer.usage ?? estimatedUsage(call.requestBytes, answer.bytes);
			const { model, pricing } = await gatewayPrice(call.family, call.model);
			const costUsd = gatewayCost(model, usage);
			this.ctx.storage.transactionSync(() =>
				this.store.recordModelCall(call.providerId, call.model, usage, costUsd, {
					via: "gateway",
					api: call.api,
					pricing,
					...(pricing === "fallback" ? { pricedAs: model.id ?? null } : {}),
					...(answer.usage === null ? { estimated: true } : {}),
				}),
			);
			console.log(JSON.stringify({ ...log, charged: true, costUsd, estimated: answer.usage === null, pricing }));
		})().catch((error) => console.warn(JSON.stringify({ event: "pim.coding.gateway_charge_failed", error: String(error).slice(0, 300) })));
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

	/**
	 * Tells the space's list of threads the thread's row as it is now, after
	 * each change: one telling at a time, and once more if it changed
	 * meanwhile. Each telling is the whole row, so a repeat changes nothing.
	 */
	#indexChanged(): void {
		if (this.#indexing) {
			this.#indexAgain = true;
			return;
		}
		this.#indexing = (async () => {
			try {
				do {
					// After the change's transaction, which may still be under way.
					await Promise.resolve();
					this.#indexAgain = false;
					const thread = this.store.thread();
					if (!thread) return;
					await codingScheduler(this.env, thread.space).recordThread({
						threadId: thread.threadId,
						repo: thread.repoUrl,
						ref: thread.baseRef,
						branch: thread.branch,
						state: thread.state,
						stateReason: thread.stateReason,
						spentUsd: thread.spentUsd,
						budgetUsd: thread.budgetUsd,
						createdAt: thread.createdAt,
						updatedAt: thread.updatedAt,
						lastTurnEndedAt: this.store.lastTurnEndedAt(),
					});
					await codingThreadsChanged(this.env, thread.space);
				} while (this.#indexAgain);
			} catch (error) {
				console.warn(JSON.stringify({ event: "pim.coding.index_failed", error: String(error) }));
			} finally {
				this.#indexing = null;
			}
		})();
	}

	/** Hands an event, recorded already, to the sink; best-effort. */
	async #emit(event: CodingThreadEvent): Promise<void> {
		try {
			await this.eventSink().emit(event);
		} catch (error) {
			console.warn(JSON.stringify({ event: "pim.coding.sink_failed", operation: event.operationId, error: String(error) }));
		}
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
		const spent = this.#budgetSpent(thread);
		if (spent) throw new Error(`${spent}: continue it with a bigger one`);
	}

	/**
	 * Why the thread can't go on until given a bigger budget, or null while
	 * it has some left: it spent its budget, or, on a CLI harness that
	 * estimates no cost, used the tokens its budget allows.
	 */
	#budgetSpent(thread: CodingThreadRow): string | null {
		if (thread.spentUsd >= thread.budgetUsd) return `This coding thread has spent its $${thread.budgetUsd} budget`;
		const ceiling = tokenCeiling(thread);
		if (ceiling === null) return null;
		const used = this.store.tokensUsed();
		return used >= ceiling ? `This coding thread has used ${used.toLocaleString("en-US")} of the ${ceiling.toLocaleString("en-US")} tokens its $${thread.budgetUsd} budget allows, as ${cliHarness(thread.harness)!.name} reports no cost` : null;
	}

	/** A failed or stopped thread with new input waits for a slot again. Runs in the caller's transaction. */
	#reopen(): void {
		const thread = this.store.required();
		if (thread.state === "failed" || thread.state === "waiting_input" || (thread.state === "idle" && thread.slot === "none")) this.store.update({ state: thread.slot === "queued" ? "queued" : "provisioning", stateReason: null, stateDetail: null, budgetStopped: false });
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
		if (!thread || thread.state === "archived" || thread.state === "failed" || thread.state === "waiting_input") return;
		if (thread.currentOperation) {
			const operation = thread.currentOperation;
			if (cliHarness(thread.harness)) {
				if (this.#cli?.operation === operation) return;
				// The run that was this turn's is gone with the isolate that ran it.
				await this.#endCliTurn(operation, await this.#recoverCliRun(thread));
			} else {
				const pending = await this.harness.pending();
				if (pending.some((item) => item.operationId === operation)) {
					this.#watch(operation);
					return;
				}
				await this.#endTurn(operation, await this.harness.wait(operation));
			}
			thread = this.store.thread();
			if (!thread || thread.state === "failed" || thread.state === "archived" || thread.state === "waiting_input") return;
		}
		const work = this.store.inboxSize() > 0;
		// A rebuild of the environment needs the workspace as a turn does.
		const rebuild = thread.environment.rebuildRequested;
		if (!work && !rebuild) {
			if (thread.state === "provisioning" && thread.slot !== "held") this.store.update({ state: "idle" });
			return;
		}
		if (thread.slot === "none") {
			if (!this.#ensureBackend()) return;
			await this.#requestSlot();
		} else if (thread.slot === "queued") await this.#refreshCapacity();
		thread = this.store.required();
		if (thread.slot !== "held") return;
		// The manager refused the workspace for low disk last time: its health now says whether the space's queue may open again.
		if (thread.stateReason === "low_disk") await this.#refreshCapacity();
		try {
			await this.#workspace();
			// A rebuild between turns is work the scheduler shouldn't take the slot back from.
			if (!work && rebuild) await this.#report("running");
			await this.#prepareEnvironment();
		} catch (error) {
			await this.#provisioningFailed(error);
			return;
		}
		if (!work) {
			if (this.store.required().state === "provisioning") this.store.update({ state: "idle" });
			await this.#report("idle");
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

	/** The backend's health check, for a backend with a manager that reports one (Compose); null for one without, or none. */
	#healthOf(thread: CodingThreadRow): (() => Promise<ManagerHealth>) | null {
		let provider: WorkspaceProvider & { managerHealth?: () => Promise<ManagerHealth> };
		try {
			provider = this.workspaceProviders().get(thread.providerId);
		} catch {
			return null;
		}
		return typeof provider.managerHealth === "function" ? provider.managerHealth.bind(provider) : null;
	}

	/**
	 * Tells the space's scheduler what the workspace manager's health says
	 * (./provider-capacity.ts): under 15% of its disk free holds the queue,
	 * and its limit caps the space's slots. Only for a backend with a
	 * manager; one that can't be reached changes nothing.
	 */
	async #refreshCapacity(): Promise<void> {
		const thread = this.store.required();
		const health = this.#healthOf(thread);
		if (!health) return;
		try {
			const { freeDiskPct, maxConcurrent, running, free } = await health();
			await codingScheduler(this.env, thread.space).refreshConditions({ freeDiskPct, maxConcurrent, running, free });
		} catch (error) {
			console.warn(JSON.stringify({ event: "pim.coding.health_failed", thread: thread.threadId, error: String(error) }));
		}
	}

	/** Asks the scheduler for a slot, unless the thread holds one or waits for one, after telling it the manager's health. */
	async #requestSlot(): Promise<void> {
		if (this.store.required().slot !== "none") return;
		await this.#refreshCapacity();
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
		else if (this.store.required().slot === "queued") {
			this.ctx.storage.transactionSync(() => {
				this.store.update({ state: "queued" });
				this.store.recordEvent("thread.queued", { position: result.position, reason: result.reason });
			});
		}
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
		const cli = cliHarness(thread.harness);
		if (cli) return this.#startCliTurn(thread, cli, input);
		await this.#loadModel(thread.space, thread.profile);
		await this.#configure(thread.profile);
		// The same operation twice is one submission, so a restart between here and the record below repeats nothing.
		const receipt = await this.harness.submit(input.text, { operationId: input.operationId });
		this.ctx.storage.transactionSync(() => {
			this.store.dequeue(input.seq);
			this.store.update({ state: "running", stateReason: null, currentOperation: receipt.operationId, budgetStopped: false });
			this.store.recordEvent("thread.turn_started", { operationId: receipt.operationId });
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
	 * Starts the inbox's oldest input as a turn of the thread's CLI harness:
	 * readies the run first (the person's lock on their login, and the login
	 * put into the workspace), then records the turn and runs the CLI in the
	 * background, resuming its session after the first turn. Without a login
	 * the thread waits for the person (`login_required`), the input kept;
	 * while another of the person's threads runs the harness, it tries again
	 * at the next heartbeat.
	 */
	async #startCliTurn(thread: CodingThreadRow, cli: CliHarness, input: { seq: number; operationId: string; text: string }): Promise<void> {
		// A run readied before a restart, whose turn never started, is finished off first.
		if (this.store.harnessRun()) await this.#recoverCliRun(thread);
		const spent = this.#budgetSpent(thread);
		if (spent) {
			this.store.update({ state: "failed", stateReason: "budget", stateDetail: spent });
			await this.#giveBack({ keepVolume: true });
			return;
		}
		const workspace = await this.#workspace();
		const session = this.store.harnessSession();
		const sessionId = session?.sessionId ?? crypto.randomUUID();
		const timeoutMs = thread.limits.wallClockMin * 60_000;
		const runner = new HarnessRunner(this.#cliDeps(thread, cli, workspace, timeoutMs, await this.harnessAuth(thread, cli)));
		const prepared = await runner.prepare(input.operationId, { sessionId, resume: session !== null });
		if (prepared.status === "busy") {
			this.store.update({ stateReason: "harness_busy", stateDetail: `Another of your coding threads is running ${cli.name}; this one starts when it ends` });
			await this.#schedule(Date.now() + HEARTBEAT_MS);
			return;
		}
		if (prepared.status === "login_required") {
			this.ctx.storage.transactionSync(() => {
				const how = cli.apiKeyEnv ? "your API key" : "your subscription";
				this.store.update({ state: "waiting_input", stateReason: "login_required", stateDetail: `Connect ${cli.name} with ${how}, then continue the thread` });
				this.store.recordEvent("thread.waiting_input", { reason: "login_required", harness: cli.id, operationId: input.operationId });
			});
			await this.#report("waiting");
			return;
		}
		const operation = input.operationId;
		this.ctx.storage.transactionSync(() => {
			this.store.dequeue(input.seq);
			this.store.update({ state: "running", stateReason: null, stateDetail: null, currentOperation: operation, budgetStopped: false });
			this.store.recordEvent("thread.turn_started", { operationId: operation });
		});
		const fresh = this.store.required();
		const turn = {
			prompt: input.text,
			sessionId,
			resume: session !== null,
			maxBudgetUsd: fresh.budgetUsd - fresh.spentUsd,
			maxTokens: cli.reportsCost || cli.unmetered ? null : Math.max(0, tokenCeiling(fresh)! - this.store.tokensUsed()),
			model: fresh.profile.providerId === cli.id && fresh.profile.model !== "default" ? fresh.profile.model : null,
			instructions: cliInstructions(fresh),
			sessionBefore: { costUsd: session?.costUsd ?? 0, usage: session?.usage ?? null },
		};
		// Known at once, before anything is awaited, so a stop that comes meanwhile finds the run to stop.
		let go = () => {};
		const started = new Promise<void>((resolve) => {
			go = resolve;
		});
		const done = started
			.then(() => runner.run(turn, timeoutMs))
			.catch((error): RunResult => ({ ...NO_RUN, reason: "harness_error", detail: errorText(error).slice(0, 500) }))
			.then((result) => this.#endCliTurn(operation, result))
			.catch((error) => console.warn(JSON.stringify({ event: "pim.coding.harness_turn_failed", operation, error: String(error) })))
			.finally(() => {
				if (this.#cli?.operation === operation) this.#cli = null;
				void this.#advance();
			});
		this.#cli = { operation, runner, done };
		try {
			await this.#writeMessage({ role: "user", content: input.text, timestamp: this.now() });
			await this.#report("running");
		} finally {
			go();
		}
	}

	/** What a CLI run needs from the thread: its workspace, how it signs in, the person's login and lock, and where its record and events go. */
	#cliDeps(thread: CodingThreadRow, cli: CliHarness, workspace: Workspace, timeoutMs: number, auth: HarnessAuth): RunnerDeps {
		const scheduler = codingScheduler(this.env, thread.space);
		const grace = this.harnessGraceMs();
		return {
			harness: cli,
			workspace,
			auth,
			credentials: this.harnessCredentials(thread, cli, workspace),
			// Held at most as long as a run can last, so a thread that is gone can't keep it.
			lock: { acquire: () => scheduler.acquireHarness(cli.id, thread.threadId, timeoutMs + 4 * grace + 60_000), release: () => scheduler.releaseHarness(cli.id, thread.threadId) },
			journal: { save: (record) => this.store.saveHarnessRun(record), clear: () => this.store.saveHarnessRun(null) },
			onEvent: (event) => this.#onCliEvent(event),
			onTestRun: (run) => this.store.addTestRun(run),
			now: () => this.now(),
			graceMs: grace,
		};
	}

	/** Finishes off a CLI run this isolate didn't start: the CLI killed, the login written back, the lock let go. The turn was `interrupted`. */
	async #recoverCliRun(thread: CodingThreadRow): Promise<RunResult> {
		const cli = cliHarness(thread.harness)!;
		const record = this.store.harnessRun();
		const interrupted: RunResult = { ...NO_RUN, reason: "interrupted", detail: `The thread restarted while ${cli.name} ran; its turn was stopped` };
		if (!record) return interrupted;
		let workspace: Workspace | null = null;
		try {
			if (thread.slot === "held") workspace = await this.#workspace();
		} catch (error) {
			console.warn(JSON.stringify({ event: "pim.coding.harness_recover_workspace", thread: thread.threadId, error: String(error) }));
		}
		if (!workspace) {
			// Without the workspace there is no CLI to stop and no login to keep: only the lock is let go.
			if (record.locked) await codingScheduler(this.env, thread.space).releaseHarness(cli.id, thread.threadId);
			this.store.saveHarnessRun(null);
			return interrupted;
		}
		// Finishing a run off signs nothing in: only its record says what to undo.
		const result = await recoverRun(this.#cliDeps(thread, cli, workspace, thread.limits.wallClockMin * 60_000, { mode: "signed_out" }), record);
		console.warn(JSON.stringify({ event: "pim.coding.harness_interrupted", thread: thread.threadId, operation: record.operationId, lines: record.lines }));
		return result;
	}

	/**
	 * A CLI turn ended: what it cost is recorded, as the change in the
	 * session's whole cost the CLI reported, and the session kept for the next
	 * turn; then the turn ends as any does. A CLI that reports only the
	 * session's tokens (Codex) has its turn's tokens counted the same way, and
	 * no cost. A resumed session that the CLI no longer has is let go, so the
	 * next turn starts a new one.
	 */
	async #endCliTurn(operation: string, result: RunResult): Promise<void> {
		const thread = this.store.thread();
		if (!thread || thread.currentOperation !== operation) return;
		const before = this.store.harnessSession();
		this.ctx.storage.transactionSync(() => {
			const same = before !== null && before.sessionId === result.sessionId;
			const cost = result.sessionCostUsd === null ? 0 : Math.max(0, result.sessionCostUsd - (same ? before.costUsd : 0));
			const usage = result.sessionUsage ? grown(result.sessionUsage, same ? before.usage : null) : result.usage;
			if (cost > 0 || usage.input + usage.output + usage.cacheRead + usage.cacheWrite > 0) this.store.recordModelCall(thread.harness, result.model ?? "unknown", usage, cost);
			if (result.sessionId && (result.sessionCostUsd !== null || result.sessionUsage)) {
				this.store.setHarnessSession({ sessionId: result.sessionId, costUsd: result.sessionCostUsd ?? (same ? before.costUsd : 0), usage: result.sessionUsage ?? (same ? before.usage : null) });
			}
			else if (result.status !== "done" && result.sessionId === null && result.reason === "harness_error" && before) this.store.setHarnessSession(null);
			if (result.reason === "budget") this.store.update({ budgetStopped: true });
		});
		// A turn stopped at the token ceiling says by how much, in place of the dollars it can't name.
		const spent = result.reason === "budget" && tokenCeiling(thread) !== null ? this.#budgetSpent(this.store.required()) : null;
		await this.#endTurn(operation, spent ? { ...result, detail: spent } : result);
	}

	/** What a CLI's output means for the thread: messages into the transcript, retries and refusals into the log, text as it is written to whoever follows live. */
	async #onCliEvent(event: CliEvent): Promise<void> {
		switch (event.type) {
			case "session": {
				const known = this.store.harnessSession();
				if (known?.sessionId !== event.sessionId) this.store.setHarnessSession({ sessionId: event.sessionId, costUsd: 0, usage: null });
				return;
			}
			case "delta":
				this.#tellLive({ type: "partial", kind: event.kind, text: event.text });
				return;
			case "assistant":
			case "tool_result":
				await this.#writeMessage(event.message);
				return;
			case "retry":
				this.store.recordEvent("harness.api_retry", { attempt: event.attempt, maxRetries: event.maxRetries, delayMs: event.delayMs, error: event.error, status: event.status });
				return;
			case "permission_denied":
				this.store.recordEvent("harness.permission_denied", { tool: event.tool, message: event.message.slice(0, 500) });
				return;
			case "notice":
				this.store.recordEvent("harness.notice", { message: event.message.slice(0, 500) });
				return;
			case "unparsed":
				// Its length only: what the CLI printed may hold anything.
				console.warn(JSON.stringify({ event: "pim.coding.harness_unparsed", length: event.line.length }));
				return;
		}
	}

	/** Appends a message to the conversation as it is, without asking pi's model anything: a CLI harness's own. */
	async #writeMessage(message: Message): Promise<void> {
		const root = await (await this.harness.pi()).root(BACKGROUND_CONTEXT);
		await root.submit({ type: "write", entry: { kind: CLI_MESSAGE, model: [message] } }, BACKGROUND_CONTEXT);
	}

	/** Tells whoever follows the thread live. */
	#tellLive(message: CodingLiveMessage): void {
		for (const listener of this.#liveListeners) listener(message);
	}

	/**
	 * A turn ended: commits a checkpoint, settles the thread's state, records
	 * and emits `thread.turn_ended`, and gives the slot back when the thread
	 * failed. Ending a turn already ended does nothing.
	 */
	#endTurn(operation: string, result: TurnResult): Promise<void> {
		let ending = this.#endings.get(operation);
		if (!ending) {
			ending = this.#settleTurn(operation, result).finally(() => this.#endings.delete(operation));
			this.#endings.set(operation, ending);
		}
		return ending;
	}

	async #settleTurn(operation: string, result: TurnResult): Promise<void> {
		if (this.store.thread()?.currentOperation !== operation) return;
		const checkpoint = await this.#checkpoint(operation).catch((error) => {
			console.warn(JSON.stringify({ event: "pim.coding.checkpoint_failed", operation, error: String(error) }));
			return null;
		});
		const thread = this.store.required();
		if (thread.currentOperation !== operation) return;
		const budget = thread.budgetStopped;
		// A CLI harness whose login is missing or expired waits for the person to connect it again, and goes on when continued.
		const login = result.status !== "done" && result.reason === "login_required";
		const outcome: TurnOutcome = budget ? "error" : result.status === "done" ? "completed" : result.reason === "aborted" ? "cancelled" : login ? "needs_approval" : "error";
		const reason = budget ? "budget" : outcome === "error" || login ? (result.reason ?? "error") : null;
		const state: CodingThreadState = outcome === "error" ? "failed" : login ? "waiting_input" : "idle";
		const said = await this.#lastSaid().catch(() => null);
		// A budget stop says what was spent, and on a CLI harness that estimates no cost, the tokens used of its ceiling.
		const ceiling = tokenCeiling(thread);
		const stop = budget ? { budgetUsd: thread.budgetUsd, spentUsd: thread.spentUsd, ...(ceiling === null ? {} : { tokens: this.store.tokensUsed(), tokenCeiling: ceiling }) } : null;
		const event: TurnEndedEvent = {
			type: "thread.turn_ended",
			threadId: thread.threadId,
			space: thread.space,
			operationId: operation,
			outcome,
			...(reason ? { reason } : {}),
			...(checkpoint ? { checkpoint: checkpoint.sha } : {}),
			state,
			spentUsd: thread.spentUsd,
			budgetUsd: thread.budgetUsd,
			...(cliHarness(thread.harness)?.unmetered ? { unmetered: true as const } : {}),
			...(said ? { said } : {}),
			at: this.now(),
		};
		this.ctx.storage.transactionSync(() => {
			this.store.update({ currentOperation: null, state, stateReason: reason, stateDetail: outcome === "completed" ? null : (result.detail ?? null) });
			this.store.recordEvent(event.type, event);
			if (stop) this.store.recordEvent("app.budget_stop", stop);
		});
		if (stop) await this.#write("app.budget_stop", stop);
		if (state === "failed") await this.#giveBack({ keepVolume: true });
		else if (state === "waiting_input") await this.#report("waiting");
		else if (this.store.inboxSize() === 0) await this.#report("idle");
		// Last, so whoever hears of the turn's end finds the slot already given back or idle.
		await this.#emit(event);
	}

	/** The end of what the coding agent last said, for whoever hears of its turn's end. */
	async #lastSaid(): Promise<string | null> {
		const messages = projectEntries(await this.harness.messages());
		for (let index = messages.length - 1; index >= 0; index--) {
			const message = messages[index]!;
			if (message.role !== "assistant") continue;
			const text = message.parts
				.flatMap((part) => (part.type === "text" ? [part.text] : []))
				.join("\n")
				.trim();
			if (text) return text.length > SAID_CHARS ? `…${text.slice(-SAID_CHARS)}` : text;
		}
		return null;
	}

	/** Stops the turn under way: kills its commands, aborts pi's run and waits for the turn to end. */
	async #stopTurn(): Promise<void> {
		const thread = this.store.required();
		const operation = thread.currentOperation;
		if (cliHarness(thread.harness)) {
			const run = this.#cli;
			if (run && run.operation === operation) {
				await run.runner.abort();
				await run.done;
			} else if (operation) await this.#endCliTurn(operation, await this.#recoverCliRun(thread));
			this.#killCommands();
			return;
		}
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
		const lowDisk = error instanceof ComposeManagerError && error.code === "low_disk";
		if (error instanceof WorkspaceCapacityError || lowDisk) {
			// The backend is full though the scheduler gave a slot: try again at the next heartbeat. Low disk also holds the space's queue until the manager's health says there is room.
			if (lowDisk) {
				await codingScheduler(this.env, thread.space)
					.onManagerError("low_disk")
					.catch((failure) => console.warn(JSON.stringify({ event: "pim.coding.capacity_failed", thread: thread.threadId, error: String(failure) })));
			}
			this.store.update({ stateReason: lowDisk ? "low_disk" : "workspace_capacity" });
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

	/** The thread's workspace, made and cloned on first use, with its commands killed when the thread is stopped. A new one starts from `restoreFrom`, the person's environment snapshot, when given. */
	#workspace(options: { restoreFrom?: EnvironmentSnapshot } = {}): Promise<Workspace> {
		this.#opening ??= this.#openWorkspace(options).finally(() => {
			this.#opening = null;
		});
		return this.#opening;
	}

	async #openWorkspace(options: { restoreFrom?: EnvironmentSnapshot }): Promise<Workspace> {
		const thread = this.store.required();
		if (thread.slot !== "held") throw new Error("The coding thread holds no workspace slot now");
		const provider = this.workspaceProviders().get(thread.providerId);
		if (this.#open && thread.workspaceRef?.id === this.#open.id) return this.#open.workspace;
		let workspace = thread.workspaceRef ? await provider.get(thread.workspaceRef) : null;
		const started = workspace ? null : performance.now();
		if (!workspace) {
			// Creating twice for one session is one workspace, so a restart mid-create makes no second one.
			const ref = await this.#createWorkspace(provider, thread, options.restoreFrom);
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
		if (started !== null) this.#setEnvironment({ provisionMs: Math.round(performance.now() - started) });
		this.#open = { id: this.store.required().workspaceRef!.id, workspace: killable };
		return killable;
	}

	/**
	 * Makes the thread's workspace. Its first one, on a backend that keeps
	 * environments, starts from the person's newest snapshot of the
	 * repository, the best guess before the repository is checked out
	 * (`#prepareEnvironment` checks it then), or from `restoreFrom`. A
	 * restore that fails for any reason but a full backend is logged and
	 * the workspace is made empty, to be cloned as usual.
	 */
	async #createWorkspace(provider: WorkspaceProvider, thread: CodingThreadRow, restoreFrom?: EnvironmentSnapshot): Promise<WorkspaceRef> {
		const spec = this.#spec(thread, provider);
		const owner = spec.environment;
		let snapshot = restoreFrom;
		if (owner && !snapshot && thread.baseSha === null && thread.environment.preparedAt === null) {
			snapshot = await provider.listEnvironments(owner).then(
				(snapshots) => snapshots[0],
				(error) => void console.warn(JSON.stringify({ event: "pim.coding.environment_list_failed", thread: thread.threadId, error: String(error).slice(0, 300) })),
			);
		}
		if (owner && snapshot) {
			const started = performance.now();
			try {
				const ref = await provider.create({ ...spec, environment: { ...owner, restoreFrom: snapshot.key } });
				this.#setEnvironment({ state: "restoring", restoredFromKey: snapshot.key, builtAt: snapshot.createdAt, restoreMs: Math.round(performance.now() - started), snapshotBytes: snapshot.size ?? null, error: undefined });
				return ref;
			} catch (error) {
				if (error instanceof WorkspaceCapacityError || (error instanceof ComposeManagerError && error.code === "low_disk")) throw error;
				console.warn(JSON.stringify({ event: "pim.coding.environment_restore_failed", thread: thread.threadId, key: snapshot.key, error: String(error).slice(0, 300) }));
				this.store.recordEvent("environment.restore_failed", { key: snapshot.key, error: environmentError("The snapshot couldn't be restored", errorText(error)) });
			}
		}
		return provider.create(spec);
	}

	#spec(thread: CodingThreadRow, provider: WorkspaceProvider): WorkspaceSpec {
		return {
			sessionId: thread.threadId,
			image: this.workspaceImage(),
			repo: { url: thread.repoUrl, ref: thread.baseRef, branch: thread.branch },
			limits: thread.limits,
			egress: { allow: [...this.egressAllow(), ...(cliHarness(thread.harness)?.egress ?? [])] },
			gitAuth: { mode: "none" },
			...(provider.capabilities.environmentSnapshots ? { environment: environmentOwner(thread) } : {}),
		};
	}

	/**
	 * Clones the repository and checks out the thread's branch, unless the
	 * workspace (or its kept volume) has it already. Until the thread first
	 * checked out (`baseSha` is null), a workspace with a clone, such as one
	 * restored from another thread's snapshot, fetches and checks out the
	 * thread's branch over it.
	 */
	async #ensureRepository(workspace: Workspace, thread: CodingThreadRow): Promise<void> {
		const cloned = await workspace.stat(`${REPO_DIR}/.git`).then(
			() => true,
			() => false,
		);
		if (cloned && this.store.required().baseSha !== null) return;
		const { url, token } = await this.cloneSource(thread);
		// The broker token as an HTTP header for these commands alone: git keeps no copy of it in the repository.
		const auth = { GIT_CONFIG_COUNT: "1", GIT_CONFIG_KEY_0: "http.extraHeader", GIT_CONFIG_VALUE_0: `Authorization: Bearer ${token}` };
		if (!cloned) await git(workspace, ["clone", "--no-checkout", url, REPO_DIR], { cwd: WORKSPACE_ROOT, timeoutMs: CLONE_TIMEOUT_MS, env: auth, secret: token });
		// A snapshot's clone may come from this Pim at another address.
		else await git(workspace, ["remote", "set-url", "origin", url]);
		const fetchOptions = { timeoutMs: CLONE_TIMEOUT_MS, env: auth, secret: token };
		try {
			await git(workspace, ["fetch", "origin", thread.baseRef], fetchOptions);
		} catch (error) {
			// A repository whose default branch isn't "main" (the ref nobody chose): use the remote's default branch.
			if (thread.baseRef !== "main") throw error;
			await git(workspace, ["fetch", "origin", "HEAD"], fetchOptions);
		}
		await git(workspace, ["checkout", "-f", "-B", thread.branch, "FETCH_HEAD"]);
		const sha = (await git(workspace, ["rev-parse", "HEAD"])).trim();
		if (this.store.required().baseSha === null) this.store.update({ baseSha: sha });
	}

	/**
	 * Readies the repository's environment in the thread's workspace, which
	 * has the repository checked out: before the thread's first turn, and
	 * again when a rebuild was asked for. That is before any secret has been
	 * in the workspace (a harness's login goes in only for a turn and comes
	 * out after it; the git broker's token and the model gateway's are only
	 * ever in a command's environment), so what is snapshotted holds none.
	 *
	 * With a setup script (the person's setting for the repository, else
	 * its `.pim/setup.sh`) the environment's key is computed. A workspace
	 * restored from that key's snapshot is ready. Otherwise one of the
	 * person's snapshots with the key is restored into a new workspace, or,
	 * when there is none, the thread takes the person's lock on building it,
	 * runs the script and keeps a snapshot; while another of their threads
	 * holds the lock it waits for that one's snapshot, a bounded time.
	 * Nothing here fails the thread: a failure is recorded and the thread
	 * goes on in its workspace as it is. Only a stop is thrown.
	 */
	async #prepareEnvironment(): Promise<void> {
		const thread = this.store.required();
		const current = thread.environment;
		const provider = this.workspaceProviders().get(thread.providerId);
		if (!provider.capabilities.environmentSnapshots) return;
		const rebuild = current.rebuildRequested;
		if (!rebuild && current.preparedAt !== null) return;
		// A thread that already worked without one (it began before environments, or was called off while one was readied) gets none unless asked.
		if (!rebuild && this.store.nextInput()?.operationId !== thread.startOperation) {
			const unfinished = current.state !== "none";
			this.#setEnvironment(unfinished ? { state: "failed", error: "The thread went on before its environment was ready", preparedAt: this.now() } : { preparedAt: this.now() });
			return;
		}
		const signal = this.#kill.signal;
		const owner = environmentOwner(thread);
		let workspace = await this.#workspace();
		let setup: { script: string; source: "settings" | "repository" } | null;
		let key: string;
		try {
			setup = await this.#setupScript(workspace, thread, owner);
			if (setup === null) {
				this.#setEnvironment({ state: "none", key: null, source: null, rebuildRequested: false, preparedAt: this.now(), error: undefined });
				return;
			}
			key = await environmentKey({ ...owner, setupScript: setup.script, lockfiles: await lockfileHashes(workspace, REPO_DIR), image: this.workspaceImage() });
		} catch (error) {
			if (signal.aborted) throw new Error(ENVIRONMENT_STOPPED);
			this.#environmentFailed(null, environmentError("The environment's setup script couldn't be read", errorText(error)));
			return;
		}
		const { source } = setup;
		if (!rebuild && current.state === "restoring" && current.restoredFromKey === key) {
			this.#setEnvironment({ state: "cached", key, source, readyFrom: "snapshot", preparedAt: this.now(), error: undefined });
			this.store.recordEvent("environment.restored", { key });
			return;
		}
		// A rebuild runs the script in the thread's own workspace; a new thread may start over from someone's snapshot.
		let restore = !rebuild;
		const scheduler = codingScheduler(this.env, thread.space);
		const deadline = performance.now() + BUILD_LOCK_MS;
		for (;;) {
			const snapshot = restore ? await this.#findSnapshot(provider, owner, key) : undefined;
			if (snapshot) {
				// Nothing has worked in the workspace yet: it is replaced, and the new one checks the repository out again.
				this.store.update({ baseSha: null });
				await this.#dropWorkspace({ keepVolume: false });
				workspace = await this.#workspace({ restoreFrom: snapshot });
				const now = this.store.required().environment;
				if (now.state === "restoring" && now.restoredFromKey === key) {
					this.#setEnvironment({ state: "cached", key, source, readyFrom: "snapshot", preparedAt: this.now(), error: undefined });
					this.store.recordEvent("environment.restored", { key });
					return;
				}
				// The restore failed and the workspace is a plain clone: build it here instead.
				restore = false;
			}
			// An environment whose snapshot wasn't worth keeping is set up by each thread, so there is nothing to wait for.
			if (!rebuild && (await scheduler.environmentSnapshotSkipped(key))) {
				await this.#buildEnvironment(provider, workspace, owner, key, setup, { snapshot: false });
				return;
			}
			if (await scheduler.acquireEnvironmentBuild(key, thread.threadId, BUILD_LOCK_MS)) {
				try {
					await this.#buildEnvironment(provider, workspace, owner, key, setup, { snapshot: true });
				} finally {
					await scheduler.releaseEnvironmentBuild(key, thread.threadId).catch(() => {});
				}
				return;
			}
			// Another of the person's threads is building it: wait for its snapshot.
			const waiting = this.store.required().environment;
			if (waiting.state !== "building" || waiting.key !== key) this.#setEnvironment({ state: "building", key, source, error: undefined });
			if (performance.now() > deadline) {
				this.#environmentFailed(key, "Another of your coding threads was still preparing this environment");
				return;
			}
			await sleep(this.environmentPollMs(), signal);
			if (signal.aborted) throw new Error(ENVIRONMENT_STOPPED);
			restore = !rebuild;
		}
	}

	/**
	 * Runs the setup script in the workspace, then, with `o.snapshot`, takes
	 * a snapshot and keeps it if it is worth keeping (`snapshotWorthKeeping`),
	 * recording the finding for the person's next threads. Its size is known
	 * only once it is taken, so one that isn't is deleted again. A failure is
	 * recorded, and the thread goes on.
	 */
	async #buildEnvironment(provider: WorkspaceProvider, workspace: Workspace, owner: EnvironmentOwner, key: string, setup: { script: string; source: "settings" | "repository" }, o: { snapshot: boolean }): Promise<void> {
		this.#setEnvironment({ state: "building", key, source: setup.source, error: undefined });
		const started = performance.now();
		const result = await runSetup(workspace, setup.script, { cwd: REPO_DIR });
		const setupMs = Math.round(performance.now() - started);
		if (result.outcome === "stopped") throw new Error(ENVIRONMENT_STOPPED);
		if (result.outcome === "failed") {
			this.#setEnvironment({ setupMs });
			this.#environmentFailed(key, result.error);
			return;
		}
		const ready = { state: "cached", key, setupMs, readyFrom: "setup", rebuildRequested: false, error: undefined } as const;
		if (!o.snapshot) {
			this.#setEnvironment({ ...ready, builtAt: null, snapshotMs: null, snapshotBytes: null, snapshotKept: false, preparedAt: this.now() });
			this.store.recordEvent("environment.built", { key, setupMs, snapshotKept: false });
			return;
		}
		const snapshotStarted = performance.now();
		try {
			const thread = this.store.required();
			if (!thread.workspaceRef) throw new Error("The coding thread has no workspace");
			const snapshot = await provider.snapshotEnvironment(thread.workspaceRef, { ...owner, key });
			const snapshotMs = Math.round(performance.now() - snapshotStarted);
			const snapshotBytes = snapshot.size ?? null;
			const worth = snapshotWorthKeeping(setupMs, snapshotBytes);
			let kept = worth;
			if (!worth) {
				// The person's other snapshots of the repository are older environments of it, which only start new threads as a guess (`#createWorkspace`) to be set up again: they don't pay either. One that can't be deleted, such as one a restore holds at this moment, stays.
				const others = await provider.listEnvironments(owner).then(
					(snapshots) => snapshots.map((each) => each.key).filter((each) => each !== key),
					() => [],
				);
				for (const each of [key, ...others]) {
					const deleted = await provider.deleteEnvironment(owner.userId, each).then(
						() => true,
						(error) => void console.warn(JSON.stringify({ event: "pim.coding.environment_delete_failed", thread: thread.threadId, key: each, error: String(error).slice(0, 300) })),
					);
					if (each === key) kept = !deleted;
				}
			}
			await codingScheduler(this.env, thread.space).setEnvironmentSnapshotSkipped(key, !worth);
			this.#setEnvironment({ ...ready, builtAt: kept ? snapshot.createdAt : null, snapshotMs, snapshotBytes, snapshotKept: kept, preparedAt: this.now() });
			this.store.recordEvent("environment.built", { key, setupMs, snapshotKept: kept });
		} catch (error) {
			console.warn(JSON.stringify({ event: "pim.coding.environment_snapshot_failed", thread: this.store.required().threadId, key, error: String(error).slice(0, 300) }));
			this.#setEnvironment({ setupMs });
			this.#environmentFailed(key, environmentError("The environment was set up but couldn't be kept", errorText(error)));
		}
	}

	#environmentFailed(key: string | null, error: string): void {
		this.#setEnvironment({ state: "failed", key, error, rebuildRequested: false, preparedAt: this.now() });
		this.store.recordEvent("environment.failed", { key, error });
	}

	#setEnvironment(change: Partial<CodingEnvironment>): void {
		this.store.update({ environment: { ...this.store.required().environment, ...change } });
	}

	/** The person's snapshot of the repository with `key`; none when they have none, or the backend can't say. */
	async #findSnapshot(provider: WorkspaceProvider, owner: EnvironmentOwner, key: string): Promise<EnvironmentSnapshot | undefined> {
		try {
			return (await provider.listEnvironments(owner)).find((snapshot) => snapshot.key === key);
		} catch (error) {
			console.warn(JSON.stringify({ event: "pim.coding.environment_list_failed", thread: this.store.required().threadId, error: String(error).slice(0, 300) }));
			return undefined;
		}
	}

	/** The repository's setup script: the person's setting for it, else its own `.pim/setup.sh`; null without either. */
	async #setupScript(workspace: Workspace, thread: CodingThreadRow, owner: EnvironmentOwner): Promise<{ script: string; source: "settings" | "repository" } | null> {
		const setting = (await codingScheduler(this.env, thread.space).repoSettings(owner.repo)).setupScript;
		if (setting !== null) return { script: setting, source: "settings" };
		const own = await repositorySetupScript(workspace, REPO_DIR);
		return own === null ? null : { script: own, source: "repository" };
	}

	/** Commits whatever changed in the workspace as a checkpoint, and keeps its diff from the start. Null when nothing changed (no edits and no new commits) or there is no workspace. */
	async #checkpoint(operation: string | null): Promise<Checkpoint | null> {
		const thread = this.store.required();
		if (thread.slot !== "held" || !thread.workspaceRef) return null;
		const workspace = await this.#workspace();
		const dirty = (await git(workspace, ["status", "--porcelain"])).trim() !== "";
		// The coding agent may have committed its work itself, leaving the tree clean: that is a change too, whenever HEAD is past the last checkpoint (or the base).
		const head = (await git(workspace, ["rev-parse", "HEAD"])).trim();
		const last = this.store.latestCheckpoint()?.sha ?? this.store.required().baseSha;
		if (!dirty && (head === last || last === null)) return null;
		const message = `Checkpoint ${this.store.checkpoints().length + 1}${operation ? ` (${operation})` : ""}`;
		if (dirty) {
			await git(workspace, ["add", "-A"]);
			await git(workspace, ["-c", "user.name=Pim", "-c", "user.email=coding@pim.invalid", "commit", "--no-verify", "-m", message]);
		}
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
	/** The model it runs on: the space's default unless given (`defaultProfile`). */
	readonly profile?: AgentProfile;
	/** The coding agent that runs it (pi). */
	readonly harness?: CodingHarness;
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
	readonly harness: CodingHarness;
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
	/** The repository's prepared environment in the thread's workspace. */
	readonly environment: CodingEnvironment;
	readonly createdBy: string;
	readonly parentThread: string | null;
	readonly createdAt: number;
	readonly updatedAt: number;
};

export type CodingDiff = { readonly since: string | null; readonly head: string | null; readonly diff: string; readonly truncated: boolean };

/** How a turn ended, from pi or a CLI harness: answered, or why not, with what to tell the person. */
type TurnResult = { readonly status: "done" | "unanswered"; readonly reason?: string; readonly detail?: string };

/** What `events()` sends besides pi's own events: a command's output as it runs, and a CLI harness's text or thinking as it is written. */
export type CodingLiveMessage = ({ readonly type: "output" } & CodingOutputEvent) | { readonly type: "partial"; readonly kind: "text" | "thinking"; readonly text: string };

/** The kind of a CLI harness's messages in the conversation. */
const CLI_MESSAGE = "harness.message";

/** A CLI run that ended before it ran. */
const NO_RUN: RunResult = { status: "unanswered", sessionId: null, sessionCostUsd: null, usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, sessionUsage: null, model: null, lines: 0 };

/** How a turn ended. `needs_approval` is for a turn held for the person, such as for a CLI harness's login. */
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
	/** The thread's state after the turn, and its spend and budget then. */
	readonly state: CodingThreadState;
	readonly spentUsd: number;
	readonly budgetUsd: number;
	/** Set when the thread's harness reports no spend, so `spentUsd` is not a measure and the budget is not enforced. */
	readonly unmetered?: true;
	/** The end of what the coding agent last said, at most 1,000 characters. */
	readonly said?: string;
	readonly at: number;
};

export type CodingThreadEvent = TurnEndedEvent;

/**
 * Who hears of what coding threads do, such as the space's Pim to wake the
 * agent that started a thread, or the web app. Pim's own event machinery,
 * connector events and triggers (./extensions/app-events.ts,
 * ../triggers/), takes signed deliveries from outside services into a
 * space and has no way in for a space's own objects, so a thread hands its
 * events to this narrow sink instead: by default the one that wakes the
 * chat of the agent that started the thread (./supervisor.ts).
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

/**
 * How many tokens a session used since `before`, its usage when the turn
 * started. A count that went down, as after the CLI compacted its context,
 * can't be told apart, so the session's count is taken as it is.
 */
function grown(after: HarnessUsage, before: HarnessUsage | null): HarnessUsage {
	if (!before || (Object.keys(after) as (keyof HarnessUsage)[]).some((key) => after[key] < before[key])) return after;
	return { input: after.input - before.input, output: after.output - before.output, cacheRead: after.cacheRead - before.cacheRead, cacheWrite: after.cacheWrite - before.cacheWrite };
}

/** What every CLI harness is told besides its own instructions: the repository, and what Pim does for it. */
export function cliInstructions(thread: Pick<CodingThreadRow, "repoUrl" | "branch" | "baseRef">): string {
	return `You are working for a person who will review your work as a diff. The repository ${thread.repoUrl} is checked out in the current directory, on the branch ${thread.branch} made from ${thread.baseRef}.

- Your changes are committed for you at the end of each turn: don't commit, push or rewrite history.
- Before you say you are done, run the repository's tests (or the ones that cover your change) and its type checks or linters if it has them, and fix what fails. If you can't run them, say why.
- When you finish, say briefly what you changed, how you checked it, and anything left undone.`;
}

/** What `continue` tells the model. */
export const CONTINUE_TEXT = "Continue where you left off.";

/** A refused model call's error. "out of budget" is wording pi-ai never retries. */
export const BUDGET_MESSAGE = "Coding thread out of budget";

export const DEFAULT_BUDGET_USD = 3;

/**
 * How many tokens each dollar of a thread's budget allows a CLI harness
 * that estimates no cost (Codex, Amp), all kinds counted alike. It is a
 * ceiling that stops a runaway thread, not a price: Pim doesn't know what
 * the CLI's tokens cost, and doesn't claim to.
 */
export const UNPRICED_TOKENS_PER_USD = 1_000_000;

/** What a push needs set up, as the person reads it. */
export const GITHUB_APP_NOT_CONFIGURED = "GitHub App not configured: ask the Pim owner to set it up";

/** A push readied for the person to approve, with the checkpoint it is of; or why it can't be. */
export type PushPreparation =
	| { readonly ok: true; readonly request: PushApprovalRequest & { readonly checkpoint: string } }
	| { readonly ok: false; readonly code: "github_app_not_configured" | "push_refused" | "archived" | "nothing_to_push" | "workspace_not_running" | "conflict"; readonly message: string };

/** A merge readied for the person to approve, with the checkpoint it is of; or why it can't be. */
export type MergePreparation =
	| { readonly ok: true; readonly request: { readonly checkpoint: string; readonly summary: string } }
	| { readonly ok: false; readonly code: "github_app_not_configured" | "archived" | "nothing_to_push" | "workspace_not_running" | "conflict"; readonly message: string };

/** What a merge did: the default branch's move, whether the thread's commits were rebased, and the thread's own branch if it was pushed too. */
export type MergeResult = PushResult & { readonly rebased: boolean; readonly threadBranch: string | null };

/** The most of the coding agent's last words a turn's end carries. */
const SAID_CHARS = 1000;

const errorText = (error: unknown) => (error instanceof Error ? error.message : String(error));

/** The workspace provider of a thread started while the deployment had none. */
const NO_BACKEND = "none";

const DEFAULT_LIMITS: CodingLimits = { cpu: 2, memMiB: 4096, diskMiB: 5120, pids: 1024, wallClockMin: 240 };

/** Limits for repositories that need more than the defaults, keyed by lowercase `owner/name`. */
const REPO_LIMIT_OVERRIDES: Record<string, Partial<CodingLimits>> = {
	"ajac-zero/pim": { memMiB: 6144 },
};

/** A thread's limits: the defaults, then its repository's overrides, then what the caller asked for. */
export const threadLimits = (repoFullName: string, requested?: Partial<CodingLimits>): CodingLimits => ({
	...DEFAULT_LIMITS,
	...REPO_LIMIT_OVERRIDES[repoFullName.toLowerCase()],
	...requested,
});

/** The most tokens one model answer may have: the model's own limit, up to this. */
const MAX_OUTPUT_TOKENS = 32_000;

/** The most of a diff kept and returned, in characters (256 KiB of ASCII). */
const MAX_DIFF_CHARS = 256 * 1024;

const ADVANCE_JOB = "advance";
const HEARTBEAT_MS = 30_000;
const ADVANCE_WAIT_MS = 20_000;
const GIT_TIMEOUT_MS = 120_000;
const CLONE_TIMEOUT_MS = 10 * 60_000;

/** How long a thread holds the lock on building an environment, and waits for another thread's build: the setup script's time, and the snapshot's. */
const BUILD_LOCK_MS = SETUP_TIMEOUT_MS + 10 * 60_000;

/** An abort while the environment is readied: `#provisioningFailed` takes " was stopped:" as one. */
const ENVIRONMENT_STOPPED = "Readying the environment was stopped: the thread was aborted";

/** Whose the thread's environments are: the person whose space it is, and the repository as `owner/name` in lowercase. */
function environmentOwner(thread: CodingThreadRow): EnvironmentOwner {
	return { userId: thread.space, repo: parseRepoUrl(thread.repoUrl).fullName.toLowerCase() };
}

/** Waits `ms`, or less if `signal` aborts. */
function sleep(ms: number, signal: AbortSignal): Promise<void> {
	return new Promise((resolve) => {
		const done = () => {
			clearTimeout(timer);
			signal.removeEventListener("abort", done);
			resolve();
		};
		const timer = setTimeout(done, ms);
		signal.addEventListener("abort", done);
	});
}

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

/** What an `app.budget_stop` entry holds: tokens only for a CLI harness that estimates no cost. */
type BudgetStop = { budgetUsd?: number; spentUsd?: number; tokens?: number; tokenCeiling?: number };

/** A budget stop as the transcript says it. */
function budgetStopText(stop: BudgetStop): string {
	if (stop.tokenCeiling !== undefined) return `Stopped: the thread used ${(stop.tokens ?? 0).toLocaleString("en-US")} of the ${stop.tokenCeiling.toLocaleString("en-US")} tokens its $${stop.budgetUsd ?? 0} budget allows.`;
	return `Stopped: the thread spent $${(stop.spentUsd ?? 0).toFixed(2)} of its $${stop.budgetUsd ?? 0} budget.`;
}

/** The tokens a thread's budget allows, for a CLI harness that estimates no cost; null for one that does, and for Pi. */
function tokenCeiling(thread: CodingThreadRow): number | null {
	const cli = cliHarness(thread.harness);
	return cli?.reportsCost === false && !cli.unmetered ? Math.floor(thread.budgetUsd * UNPRICED_TOKENS_PER_USD) : null;
}

/** The transcript for the UI: pi's messages, with the thread's own entries as notices. */
function transcriptOf(entries: readonly EntryRecord[]): TranscriptMessage[] {
	return entries.flatMap((entry): TranscriptMessage[] => {
		if (entry.kind === "app.budget_stop") {
			return [{ id: String(entry.id), role: "notice", parts: [{ type: "text", text: budgetStopText((entry.data ?? {}) as BudgetStop) }], timestamp: 0 }];
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
