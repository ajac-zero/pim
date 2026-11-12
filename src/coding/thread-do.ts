import { ActivityWatch, activityOf, type Activity } from "../activity";
import { turnsOf } from "../diagnostics";
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
	cacheKeyHashes,
	NO_ENVIRONMENT,
	environmentError,
	environmentKey,
	lockfileHashes,
	repositorySetupScript,
	runSetup,
	SETUP_ENV,
	SETUP_TIMEOUT_MS,
	snapshotWorthKeeping,
} from "./environment-cache";
import { type ChosenSetup, chooseSetup, type EnvConfig, readEnvConfig } from "./env-config";
import { detectConfiguredSetup, detectRepository, environmentBrief, type ProvisionStep, pendingItems, provisionPlan, runProvisionStep, stepOf, unpinnedKeyParts, workspaceFiles } from "./repo-environment";
import { openaiProvider } from "@earendil-works/pi-ai/providers/openai";
import { CHATGPT_PROVIDER } from "../chatgpt";
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
	MODEL_GATEWAY_PATH,
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
import { DEFAULT_SPACE_CAP, type ManagerHealth } from "./provider-capacity";
import { IDLE_SLOT_GRACE_MS, PREEMPT_RESUME_PRIORITY, type QueueEntry, type QueuePlace, type Released, type SlotActivity } from "./scheduler";
import { codingScheduler, codingThreadsChanged } from "./scheduler-do";
import { BranchMovedError, checkBranch, checkBranchName, GitBrokerError, issueBrokerToken, parseRepoUrl, preparePush, type PushApprovalRequest, pushApprovalRequest, pushBranch, type PushResult, repoDefaultBranch } from "./git-broker/broker";
import { brokerPolicy, GitBrokerNotConfiguredError } from "./git-broker/config";
import { WORKSPACE_GIT_AUTH_DIR, workspaceCredentialHelper } from "./git-broker/workspace-credential";
import { GiteaNotConnectedError } from "./git-broker/gitea-connection";
import { GITHUB_INSTANCE_ID } from "./git-broker/provider";
import type { Fetch, GitHubApp } from "./git-broker/github-app";
import { brokerTokenKey, deploymentGitHubApp, deploymentProviders, GIT_BROKER_PATH } from "./git-broker/routes";
import { authEnv } from "./harness/auth";
import { type CliHarness, cliHarness } from "./harness";
import { type OrbClient, type OrbClientFactory, OrbAuthError, OrbLostError, type OrbMessage, type OrbThread, OrbUnreachableError, OrbUnsupportedError } from "./orb/types";
import { describeModelFailure, explainFailures } from "./model-error";
import { type HarnessAuth, HarnessRunner, INTERRUPT_GRACE_MS, type RunnerDeps, type RunResult, recoverRun, STALL_MS } from "./harness/runner";
import { supervisorSink } from "./supervisor";
import {
	type AgentProfile,
	type ResolvedProfile,
	type Checkpoint,
	type CodingEvent,
	type CodingHarness,
	type CodingLimits,
	type CodingSession,
	type CodingThreadRow,
	type CodingThreadState,
	CodingThreadStore,
	type PlacementReason,
	type ThreadPlacement,
	type InboxItem,
	type TestRun,
} from "./thread-store";
import { ownsLegacySnapshots, type PlacementPool, placementPools, type SandboxPool, type SkippedPool } from "./pools";
import { type CodingOutputEvent, createCodingTools, REPO_DIR, type ToolJournal } from "./tools";
import { isLoginHarness } from "./vault/harnesses";
import { HARNESS_HOME, harnessEnv, restoreHarnessCredentials, writeBackHarnessCredentials } from "./vault/inject";
import { codingVault, threadOwnership } from "./vault/vault";
import { ComposeManagerError } from "./workspace/compose";
import { COMPUTE_KINDS, type ComputeProvider, type ComputeQuota } from "../compute";
import { egressPolicy, gatewayInjection, gitBrokerInjection, placeSecret } from "./workspace/egress";
import { DEFAULT_WORKSPACE_IMAGE, NoWorkspaceBackendError, workspaceBackends, type WorkspaceProviderRegistry } from "./workspace/registry";
import {
	type EgressInjection,
	type EnvironmentOwner,
	type EnvironmentSnapshot,
	type ExecEvent,
	WORKSPACE_ROOT,
	WorkspaceCapacityError,
	WorkspaceFileError,
	WorkspaceLimitError,
	WorkspaceLostError,
	WorkspacePathError,
	WorkspaceUnsupportedError,
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
 * provider credentials enter the workspace. Compose uses a short-lived, read-only
 * broker credential file and helper for agent Git access.
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
 * snapshot of the repository where there is one, and otherwise provisions
 * the toolchains and dependencies the repository's files pin
 * (./repo-environment.ts), runs its setup script and keeps a snapshot for
 * the threads after it.
 * The environment never stops a thread: without one it goes on as before.
 *
 * A thread whose record says it is agent-hosted (`providerKind`) runs on no
 * machine of Pim's at all: its agent works in the agent's own cloud, and the
 * thread only starts, steers, reads and ends it through an orb client
 * (./orb/). Such a thread takes no slot, makes no workspace and readies no
 * environment; its first turn starts the orb and keeps it on its record at
 * once, so a restart polls it rather than starting another, and every later
 * turn is a message steered to it. What it cost, and whether its tests ran,
 * is its agent's word: the thread reports what the agent says and no more.
 *
 * A thread whose `harness` is a vendor's CLI, such as Claude Code, runs each
 * turn as one run of that CLI in the workspace instead of a pi run
 * (./harness/): what it prints goes into the same transcript, log, test runs
 * and checkpoints. A CLI run can't outlive this object: after an eviction
 * the turn ends `interrupted`, and the next turn resumes the CLI's session.
 *
 * The workspace can go down under a turn: its container, the manager or
 * the host dies. A call on it that fails as such a workspace's would makes
 * the thread check whether it still answers, for a while
 * (`workspaceLostGraceMs`), so a manager that restarts with the workspace
 * alive loses nothing. One that doesn't answer is let go, its volume kept,
 * and made again from it on its next use; every harness keeps its session
 * on that volume, under the workspace's home, or off the machine (pi's in
 * this object, Amp's on its servers). A CLI turn cut off that way ends
 * `workspace_lost` and goes on by itself in the new workspace, resuming the
 * CLI's session, a few times in a row at most; a pi turn goes on as it
 * was, its command reported lost. While a turn runs, its work is autosaved
 * every few minutes, without touching the checkout, as a commit the
 * workspace keeps and a bundle this object keeps, so a workspace whose
 * volume was lost too starts again from it.
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
	/** How many looks in a row at an agent-hosted thread said its client can't tell what it is doing; a bound on them fails the turn as unknown. */
	#orbUnknowns = 0;
	#advancing: Promise<void> | null = null;
	#advanceAgain = false;
	/** A tool asked for the workspace (`#ensureWorkspace`): the thread gets a slot and a workspace for it, with no turn, and then goes back to idle. */
	#resuming = false;
	#opening: Promise<Workspace> | null = null;
	/** The workspace opened in this isolate, by its ref's id. */
	#open: { id: string; workspace: Workspace } | null = null;
	#configured: string | null = null;
	/** The compute providers the admin set up, as last read from the Gallery, and when. */
	#compute: { providers: readonly ComputeProvider[]; at: number } = { providers: [], at: 0 };
	/** The pools the scheduler most recently reported unhealthy during placement. */
	#unhealthyPools = new Set<string>();
	/** The sandbox pools the thread may take a slot in, as last read from the Gallery, and when. */
	#pools: { pools: readonly PlacementPool[]; skipped: readonly SkippedPool[]; at: number } | null = null;
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
	/** Workspaces found to be down, so later calls on them fail at once instead of waiting for them again. */
	readonly #lost = new WeakSet<Workspace>();
	/** Checks under way of whether a workspace still answers, so calls that fail together wait for one. */
	readonly #probing = new WeakMap<Workspace, Promise<boolean>>();
	/** When the work in the workspace was last autosaved in this isolate, and the autosave under way. */
	#autosavedAt = 0;
	#autosaving: Promise<void> | null = null;
	/** A move to a new session under way (`#renewSession`): the thread takes no step meanwhile. */
	#renewing: Promise<void> | null = null;
	/** The part of it in which the workspace is being suspended and brought back: calls for the workspace wait for it. */
	#cycling: Promise<void> | null = null;
	/** When the ledger says the open stretch must end (its compute cap), in the thread's clock; null with none. Read from the ledger at boot and at each heartbeat. */
	#capAt: number | null = null;
	/** A ledger write left running (`#cycleWorkspace`): the next one waits for it. */
	#ledgerWrite: Promise<void> | null = null;
	/** The turn that is being restarted from its transcript because its session ended, so its end is auto-resumed. */
	#restarting: string | null = null;
	/** The turn the person stopped (abort, cancel, archive, an interrupting steer): a restart for a new session never resumes it. */
	#userStop: string | null = null;
	/** When the provider was last told the workspace is in use, in this isolate. */
	#keptAliveAt = 0;
	/** The credentials the workspace's egress proxy injects, by what they are for; kept in this map in memory, since each `setEgress` replaces the whole policy. The Containers provider persists its copy in the workspace DO. */
	readonly #injections = new Map<string, EgressInjection>();

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
					onActivity: (callId) => {
						this.#activityWatch.output("thread", this.now());
						this.#activityWatch.output(callId, this.now());
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
		// The admin's compute providers are read before the object answers anything, so every use of its workspace finds the backend the admin added: an RPC call such as a diff, a push, a merge or a resume, an alarm, a job — also on an instance that never ran a turn, whose `#compute` would otherwise still be empty. `#refreshCompute` keeps its throttle, and leaves what was read when the Gallery can't be reached.
		ctx.blockConcurrencyWhile(() => this.#refreshCompute());
	}

	/** How often a running turn tells a provider that needs it (`capabilities.keepAlive`) that the workspace is in use. */
	protected keepAliveMs(): number {
		return 60_000;
	}

	/** How long before a provider's session cap the thread moves to a new session: a fifth of the cap, at most two minutes. */
	protected sessionMarginMs(maxMs: number): number {
		return Math.min(120_000, Math.floor(maxMs / 5));
	}

	/** How long a turn that failed for a transient error waits before it is retried: 30 to 60 seconds. */
	protected retryDelayMs(): number {
		return RETRY_BASE_MS + Math.random() * RETRY_JITTER_MS;
	}

	/** How long a turn a rate limit stopped waits before its `attempt`th retry: longer than one blip's, and growing. */
	protected rateLimitRetryDelayMs(attempt: number, retryAfterMs: number | null): number {
		return rateLimitRetryDelayMs(attempt, retryAfterMs);
	}

	/** The clock the thread's records go by. */
	protected now(): number {
		return Date.now();
	}

	/** The workspace providers threads may use: the backends the deployment's environment sets up, and the compute providers its admin added (./compute.ts), as last read by `#refreshCompute`. */
	protected workspaceProviders(): WorkspaceProviderRegistry {
		return workspaceBackends(this.env, this.#compute.providers);
	}

	/** The compute providers with their credentials, from the Gallery. */
	protected async computeProviders(): Promise<readonly ComputeProvider[]> {
		return this.env.Gallery.getByName("gallery").computeProviders();
	}

	/**
	 * How an agent-hosted thread finds the client it runs through
	 * (./orb/types.ts): the thread asks this with its own, its space's and
	 * its provider's name. There is no factory on a deployment yet — the real
	 * client's runner is a later slice — so such a thread fails saying the
	 * agent-hosted provider isn't available, rather than crashing.
	 */
	protected orbClients(): OrbClientFactory | null {
		return null;
	}

	/** How often a turn on an agent-hosted thread is polled: what its client says it is doing. */
	protected orbPollMs(): number {
		return ORB_POLL_MS;
	}

	/** How many looks in a row may say the client can't tell what the thread is doing before the turn is failed as unknown. */
	protected orbUnknownLimit(): number {
		return ORB_UNKNOWN_LIMIT;
	}

	/** What the space may use of the deployment's compute: the admin's default, with the person's own where the admin set it. */
	protected async computeQuota(space: string): Promise<ComputeQuota> {
		return (await getAgentByName(this.env.Pim, space)).computeQuota();
	}

	/** Reads the compute providers again, at most every few seconds, so the admin's changes reach a thread's next step. A Gallery that can't be reached leaves what was read. */
	async #refreshCompute(): Promise<void> {
		if (Date.now() - this.#compute.at < COMPUTE_REFRESH_MS) return;
		try {
			this.#compute = { providers: await this.computeProviders(), at: Date.now() };
		} catch (error) {
			console.warn(JSON.stringify({ event: "pim.coding.compute_read_failed", error: String(error).slice(0, 300) }));
		}
	}

	/**
	 * Reads the sandbox pool registry again (./pools.ts), at most every few
	 * seconds, and gives it to the space's scheduler, which places by it: the
	 * enabled pools whose provider the deployment has, in their order of
	 * priority, or — when the registry has none usable — one pool per provider,
	 * exactly as placement ran before pools. A Gallery that can't be reached
	 * leaves what was read.
	 */
	async #refreshPools(space: string): Promise<void> {
		if (this.#pools && Date.now() - this.#pools.at < COMPUTE_REFRESH_MS) return;
		let read: { pools: readonly PlacementPool[]; skipped: readonly SkippedPool[] };
		try {
			const stored = await this.sandboxPools();
			this.#storedPools = stored;
			read = placementPools(stored, this.workspaceProviders().ids());
		} catch (error) {
			console.warn(JSON.stringify({ event: "pim.coding.pools_read_failed", error: String(error).slice(0, 300) }));
			read = this.#pools ?? placementPools([], this.workspaceProviders().ids());
		}
		this.#pools = { ...read, at: Date.now() };
		// The scheduler keeps the registry, so its own ticks and every other thread place by what was read.
		const registry = read.pools.filter((pool): pool is PlacementPool & { size: number } => pool.size !== null);
		await codingScheduler(this.env, space)
			.setPools(registry)
			.catch((error) => console.warn(JSON.stringify({ event: "pim.coding.pools_set_failed", thread: this.store.thread()?.threadId, error: String(error).slice(0, 300) })));
	}

	/** The registry as last read, whole: which pool keeps its provider's snapshots from before pools (`ownsLegacySnapshots`) and which providers several pools share. */
	#storedPools: readonly SandboxPool[] = [];

	/**
	 * Where the thread's environment snapshots are kept: its pool's, under the key `environmentKey` makes for it. `legacy` is true for the
	 * provider's first pool, whose snapshots are the ones made before pools; `shared` when other pools use the same provider, so the
	 * provider's snapshots aren't all this pool's to delete.
	 */
	#snapshotScope(thread: CodingThreadRow): { pool: string; legacy: boolean; shared: boolean } {
		const pool = { id: thread.poolId, provider: thread.providerId };
		const shared = this.#storedPools.some((each) => each.provider === pool.provider && each.id !== pool.id);
		return { pool: pool.id, legacy: ownsLegacySnapshots(pool, this.#storedPools), shared };
	}

	/** The sandbox pools as the Gallery keeps them, over its RPC. */
	protected async sandboxPools() {
		return this.env.Gallery.getByName("gallery").sandboxPools();
	}

	/** The pools the thread may take a slot in, and the ones it can't and why, as last read; before any read, the fallback of one pool per provider. */
	#placementPools(): { pools: readonly PlacementPool[]; skipped: readonly SkippedPool[] } {
		return this.#pools ?? placementPools([], this.workspaceProviders().ids());
	}

	/**
	 * Checks the space's compute quota and records that a workspace is about to run
	 * (./compute-ledger.ts), before the provider is asked to make or resume one.
	 * `enforce` is false for a workspace that is running already. Returns the
	 * minutes the workspace may run, or throws `ComputeQuotaError`. A limit is
	 * enforced here, not by the provider: `#enforceCompute` stops the workspace
	 * when its time is up, on the `advance` job, which `#schedule` brings
	 * forward to that time.
	 */
	async #reserveCompute(thread: CodingThreadRow, enforce: boolean, renew = false): Promise<number | null> {
		await this.#ledgerWrite;
		const quota = enforce ? await this.computeQuota(thread.space) : null;
		const gallery = this.env.Gallery.getByName("gallery");
		const entry = { userId: thread.space, threadId: thread.threadId, provider: thread.providerId, quota, now: this.now() };
		const admitted = renew ? await gallery.computeRenew(entry) : await gallery.computeBegin(entry);
		if (!admitted.ok) throw new ComputeQuotaError(admitted.message);
		this.#capAt = admitted.capAt;
		if (admitted.capAt !== null) await this.#schedule(Date.now() + HEARTBEAT_MS);
		return admitted.wallClockMin;
	}

	/**
	 * Keeps the ledger (../compute-ledger.ts) true to the thread's workspace, as the
	 * thread boots, at each heartbeat, when a turn starts and when a session
	 * limit is up (the heartbeat is brought forward to it). A workspace its provider no longer has ends as `lost`. One
	 * that ran as long as the person's session limit allows is stopped, its files
	 * kept: a turn under way is stopped first, and the thread is idle until it is
	 * continued, which asks for a workspace again and checks the quota again.
	 */
	async #enforceCompute(): Promise<void> {
		const thread = this.store.thread();
		// A workspace being made isn't in the thread's record yet.
		// Nor is one being moved to a new session: its stretch is ended and begun again by the move (`#cycleWorkspace`).
		if (!thread || this.#opening || this.#cycling || this.#renewing) return;
		try {
			const open = await this.env.Gallery.getByName("gallery").computeOpen(thread.threadId);
			this.#capAt = open?.capAt ?? null;
			if (!open) return;
			const provider = this.workspaceProviders().get(thread.providerId);
			if (!(thread.workspaceRef && (await provider.get(thread.workspaceRef)))) {
				this.#open = null;
				await this.#releaseCompute("lost");
				return;
			}
			if (open.capAt === null || this.now() < open.capAt) return;
			if (thread.currentOperation) await this.#stopTurn();
			await this.#dropWorkspace({ keepVolume: true }, "stop");
			const after = this.store.required();
			if (after.state !== "archived") {
				this.ctx.storage.transactionSync(() => {
					this.store.update({ state: "idle", stateReason: "compute_quota", stateDetail: "The workspace reached this Pim's session limit and was stopped, its files kept. Continue the thread to start a new session." });
					this.store.recordEvent("workspace.session_limit", {});
				});
				await this.#report("idle");
			}
		} catch (error) {
			// The provider can't be asked, or the Gallery can't be reached: the next look tries again.
			console.warn(JSON.stringify({ event: "pim.coding.compute_enforce_failed", thread: thread.threadId, error: errorText(error).slice(0, 300) }));
		}
	}

	/** Records that the thread's workspace stopped running. Counting never holds a thread up: a Gallery that can't be reached is logged. */
	async #releaseCompute(reason: "stop" | "suspend" | "lost" | "failed"): Promise<void> {
		await this.#ledgerWrite;
		const threadId = this.store.required().threadId;
		await this.env.Gallery.getByName("gallery")
			.computeEnd(threadId, reason, this.now())
			.catch((error) => console.warn(JSON.stringify({ event: "pim.coding.compute_end_failed", thread: threadId, error: String(error).slice(0, 300) })));
	}

	/** The machine image a workspace starts from. */
	protected workspaceImage(): string {
		return DEFAULT_WORKSPACE_IMAGE;
	}

	/** How often a thread waiting for another thread's build of its environment looks for the snapshot. */
	protected environmentPollMs(): number {
		return 5_000;
	}

	/** Hosts the workspace may reach through the egress proxy: Pim's git broker, the common package registries (Go's proxy redirects module zips to storage.googleapis.com; the CONNECT proxy filters by host only, so no path scoping), and where mise downloads toolchains (./repo-environment.ts). */
	protected egressAllow(): string[] {
		const hosts = ["registry.npmjs.org", "pypi.org", "files.pythonhosted.org", "crates.io", "static.crates.io", "index.crates.io", "proxy.golang.org", "storage.googleapis.com", ...TOOLCHAIN_HOSTS, ...JAVA_HOSTS];
		try {
			const origin = deploymentSettings(this.env).publicUrl;
			if (origin) hosts.unshift(new URL(origin).hostname);
		} catch {}
		return hosts;
	}

	/**
	 * Where the workspace clones the repository from: the git broker on this
	 * Pim (./git-broker/), with a broker token for this thread and this
	 * repository alone. Clone commands use a header, never a credential in
	 * the URL or arguments. Agent access uses injection or the global Git
	 * credential helper, and no token is recorded in thread events.
	 */
	protected async cloneSource(thread: CodingThreadRow, renewable = false): Promise<{ url: string; token: string }> {
		const provider = this.#providers().get(thread.providerInstance);
		const repo = provider.parseRepoUrl(thread.repoUrl, brokerPolicy(this.env));
		const origin = deploymentSettings(this.env).publicUrl;
		if (!origin) throw new Error("PIM_PUBLIC_URL isn't set, so the workspace can't reach Pim's git broker");
		const token = await issueBrokerToken(await brokerTokenKey(this.env), { sessionId: thread.threadId, repo, instance: provider.instance.id, ...(renewable ? { renewUntil: Date.now() + 12 * 60 * 60_000 } : {}) });
		const instance = provider.instance.id === GITHUB_INSTANCE_ID ? "" : `/${provider.instance.id}`;
		return { url: `${origin}/api${GIT_BROKER_PATH}${instance}/${repo.owner}/${repo.name}.git`, token };
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

	/** How long the workspace waits before each new try of a clone or fetch that failed for a rate limit or a brief outage; one entry per retry. */
	protected gitRetryDelaysMs(): readonly number[] {
		return GIT_RETRY_DELAYS_MS;
	}

	/** How long a CLI harness has to end its turn after SIGINT. */
	protected harnessGraceMs(): number {
		return INTERRUPT_GRACE_MS;
	}

	/** How long a CLI harness's turn may print nothing before it is stopped as stalled. */
	protected harnessStallMs(): number {
		return STALL_MS;
	}

	/** How long a workspace whose calls fail may not answer before it counts as down: a manager that restarts within it, with the workspace alive, loses nothing. */
	protected workspaceLostGraceMs(): number {
		return LOST_GRACE_MS;
	}

	/** How often the work of a running turn is autosaved. */
	protected autosaveMs(): number {
		return AUTOSAVE_MS;
	}

	/** How long a tool waits for a suspended workspace to resume. */
	protected resumeWaitMs(): number {
		return RESUME_WAIT_MS;
	}

	/** How long a thread may sit provisioning with no change before it is failed as stuck. */
	protected stuckMs(): number {
		return STUCK_MS;
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

	/** The deployment's git providers, which reach their hosts with `githubFetch`, and GitHub with `githubApp`. */
	#providers() {
		const fetch = this.githubFetch();
		return deploymentProviders(this.env, { app: this.githubApp(), ...(fetch ? { fetch } : {}) });
	}

	/**
	 * Why the thread's repository can't be pushed to, if it can't: GitHub's App isn't
	 * configured, or the Gitea account isn't connected (`conflict`, with Gitea's own message).
	 */
	async #pushBlocker(thread: CodingThreadRow): Promise<{ code: "github_app_not_configured" | "conflict"; message: string } | null> {
		const provider = this.#providers().get(thread.providerInstance);
		if (provider.instance.kind === "github") return this.githubApp() ? null : { code: "github_app_not_configured", message: GITHUB_APP_NOT_CONFIGURED };
		try {
			await provider.credential(provider.parseRepoUrl(thread.repoUrl, brokerPolicy(this.env)), "write");
			return null;
		} catch (error) {
			if (error instanceof GiteaNotConnectedError) return { code: "conflict", message: error.message };
			throw error;
		}
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
	 * tables, and never logged. The ChatGPT plan is offered too: its tokens
	 * are refreshed in the space's own credential store, so a thread asks the
	 * space's Pim for the current one on each request and never refreshes.
	 */
	protected async modelProvider(space: string, providerId: string): Promise<Provider> {
		if (providerId === CLOUDFLARE_PROVIDER_ID) {
			const binding = (this.env as { AI?: Ai }).AI;
			if (!binding) throw new Error("This Pim has no Workers AI");
			return createAI({ binding }).provider;
		}
		const pim = await getAgentByName(this.env.Pim, space);
		if (providerId === CHATGPT_PROVIDER) {
			// The plan's token is refreshed by the space's Pim, once, and asked for on each request.
			return {
				...openaiProvider(),
				auth: {
					apiKey: {
						name: "OpenAI (ChatGPT plan)",
						resolve: async () => {
							const apiKey = await (await getAgentByName(this.env.Pim, space)).codingChatgptToken();
							if (!apiKey) throw new Error("The space's ChatGPT plan isn't signed in");
							return { auth: { apiKey } };
						},
					},
				},
			};
		}
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
		await this.#enforceCompute();
		// Bounded, as a job must be: work still going after this goes on outside it.
		await this.#failIfStuck();
		await this.#keepSessionAlive();
		if (this.store.thread()?.state === "running") {
			const activity = await this.activity();
			if (activity.stalls.length) await (await getAgentByName(this.env.Pim, this.store.required().space)).codingStalled(this.store.required().threadId, activity);
		}
		await Promise.race([this.#advance(), new Promise((resolve) => setTimeout(resolve, ADVANCE_WAIT_MS))]);
		const thread = this.store.thread();
		if (thread?.currentOperation && Date.now() - this.#autosavedAt >= this.autosaveMs()) void this.#autosave();
		// A queued thread whose backend reports its health checks it again each time, so a queue held for low disk opens once there is room.
		const busy =
			thread !== null &&
			(thread.currentOperation !== null ||
				thread.state === "provisioning" ||
				(thread.slot === "held" && thread.environment.rebuildRequested) ||
				(thread.slot === "queued" && this.#healthOf(thread) !== null));
		// The heartbeat, the session's next due time and the compute cap are one timer: the earliest of them. A turn on an agent-hosted thread is polled at its own interval.
		const idleWake = thread?.idleSince !== null && thread?.idleSince !== undefined && thread.slot === "held" ? Date.now() + Math.max(0, thread.idleSince + IDLE_SLOT_GRACE_MS - this.now()) : Infinity;
		const wakes = [idleWake, busy ? Date.now() + (thread?.providerKind === "agent-hosted" ? this.orbPollMs() : HEARTBEAT_MS) : Infinity, this.#nextSessionWake(thread) ?? Infinity, this.#capWake() ?? Infinity];
		const next = Math.min(...wakes);
		return next === Infinity ? undefined : { rescheduleAt: Math.max(Date.now() + 1_000, next) };
	}

	/**
	 * What the heartbeat does for the workspace's provider while a turn runs: tells one with `capabilities.keepAlive`
	 * the workspace is in use (activity inside the sandbox doesn't count), and, when its session is about to reach
	 * `capabilities.sessionMaxMin`, starts moving the thread to a new one. The move goes on outside the job.
	 */
	async #keepSessionAlive(): Promise<void> {
		const thread = this.store.thread();
		if (!thread?.currentOperation || thread.slot !== "held" || !thread.workspaceRef || this.#renewing) return;
		const caps = this.#capabilities(thread);
		if (!caps) return;
		const now = this.now();
		if (this.#sessionDue(thread, caps)) {
			this.#renewing = this.#renewSession(thread.currentOperation)
				.catch((error) => console.warn(JSON.stringify({ event: "pim.coding.session_renew_failed", thread: thread.threadId, error: errorText(error).slice(0, 300) })))
				.finally(() => {
					this.#renewing = null;
					this.#kick();
				});
			return;
		}
		if (caps.keepAlive && now - this.#keptAliveAt >= this.keepAliveMs()) {
			this.#keptAliveAt = now;
			await this.workspaceProviders()
				.get(thread.providerId)
				.keepAlive(thread.workspaceRef)
				.catch((error) => console.warn(JSON.stringify({ event: "pim.coding.keepalive_failed", thread: thread.threadId, error: errorText(error).slice(0, 300) })));
		}
	}

	/** When the open stretch's compute cap is up, as a time of the job clock; null with none. */
	#capWake(): number | null {
		return this.#capAt === null ? null : this.#capAt - (this.now() - Date.now());
	}

	/** Whether the workspace's session is within its margin of the provider's cap. */
	#sessionDue(thread: CodingThreadRow, caps: WorkspaceProvider["capabilities"]): boolean {
		if (caps.sessionMaxMin === null || thread.session.startedAt === null) return false;
		const maxMs = caps.sessionMaxMin * 60_000;
		return this.now() >= thread.session.startedAt + maxMs - this.sessionMarginMs(maxMs);
	}

	/** When the heartbeat next has something to do for the session, so it doesn't sleep past its cap or a keepalive. Null when nothing is due. */
	#nextSessionWake(thread: CodingThreadRow | null): number | null {
		if (!thread?.currentOperation || thread.slot !== "held") return null;
		const caps = this.#capabilities(thread);
		if (!caps) return null;
		const clock = this.now() - Date.now();
		const wakes: number[] = [];
		if (caps.sessionMaxMin !== null && thread.session.startedAt !== null) {
			const maxMs = caps.sessionMaxMin * 60_000;
			wakes.push(thread.session.startedAt + maxMs - this.sessionMarginMs(maxMs) - clock);
		}
		if (caps.keepAlive) wakes.push(this.#keptAliveAt + this.keepAliveMs() - clock);
		return wakes.length ? Math.min(...wakes) : null;
	}

	/**
	 * Moves the turn under way to a new session before the provider ends this one: commits a checkpoint and
	 * autosaves, suspends the workspace (or, on a provider that can't, lets go of it keeping its files), resumes it or
	 * makes a new one, and restores the checkout. What ran in the workspace is gone, but the agent loop lives in this
	 * object, so a pi turn goes on: the commands that were running are told they were stopped, and its next call uses
	 * the new session. A CLI harness's process died with the session, so its turn is restarted from its transcript, its
	 * own session resumed, as is any turn the move can't go on with. The thread's status says which happened
	 * (`session`).
	 */
	async #renewSession(operation: string): Promise<void> {
		const thread = this.store.required();
		const provider = this.workspaceProviders().get(thread.providerId);
		const record = (patch: Partial<CodingSession>) => this.store.update({ session: { ...this.store.required().session, ...patch } });
		record({ state: "continuing" });
		this.store.recordEvent("session.continuing", { operationId: operation, startedAt: thread.session.startedAt ?? 0 });
		try {
			if (cliHarness(thread.harness)) throw new Error("The harness's process doesn't survive a new session");
			// A checkpoint that can't be made leaves the work to the autosave, whose bundle the new session restores from if its files are gone.
			await this.#checkpoint(operation).catch((error) => console.warn(JSON.stringify({ event: "pim.coding.checkpoint_failed", operation, error: String(error) })));
			await this.#autosave();
			const mode = await this.#cycleWorkspace(thread, provider);
			record({ state: "active", continuations: this.store.required().session.continuations + 1, last: { at: this.now(), mode, reason: "session_cap" } });
			this.store.recordEvent("session.continued", { operationId: operation, mode });
			void this.#write("session.continued", { mode, session: this.store.required().session.continuations });
		} catch (error) {
			if (error instanceof ComputeQuotaError) await this.#refuseRenewal(operation, error);
			else await this.#restartTurn(operation, error);
		} finally {
			this.#settleSession();
		}
	}

	/**
	 * The space's quota refused the new session: the turn ends, with the reason as the thread's, and isn't tried again.
	 * The workspace is suspended with its files kept, and its stretch ended.
	 */
	async #refuseRenewal(operation: string, error: ComputeQuotaError): Promise<void> {
		if (this.store.required().currentOperation !== operation || this.#userStop === operation) return;
		await this.#stopTurn("session");
		if (this.store.required().state !== "archived") await this.#fail(error.code, error.message, true);
	}

	/**
	 * Suspends the workspace and brings it back as a new session, with the checkout in place. Returns whether it was resumed or made again. */
	async #cycleWorkspace(thread: CodingThreadRow, provider: WorkspaceProvider): Promise<"resumed" | "created"> {
		const ref = thread.workspaceRef;
		if (!ref) throw new Error("The thread has no workspace");
		const cycle = (async () => {
			this.#open = null;
			// Calls for the workspace wait until the new session is up. The old stretch ends as the old session does, and the new one begins once the quota allows it: each exactly once. This comes before what runs in the old session is stopped, so a turn's model doesn't get ahead of the move.
			const refusal: { error?: unknown } = {};
			const wallClockMin = await this.#reserveCompute(thread, true, true).catch((error) => {
				refusal.error = error;
				return null;
			});
			this.#killCommands();
			try {
				if (provider.capabilities.suspendResume) await provider.suspend(ref);
				else await provider.destroy(ref, { keepVolume: true });
			} catch (error) {
				if (!refusal.error) this.#ledgerWrite = this.#releaseCompute("failed");
				throw error;
			}
			if (refusal.error) throw refusal.error;
			let back: Awaited<ReturnType<WorkspaceProvider["resumeOrCreate"]>>;
			try {
				back = await provider.resumeOrCreate(ref, this.#spec(thread, provider, wallClockMin));
			} catch (error) {
				// Not waited for, so the turn is told the move failed as soon as the provider says so: the next ledger call follows it.
				this.#ledgerWrite = this.#releaseCompute("failed");
				throw error;
			}
			// The thread was archived or gave its slot up meanwhile, and dropped the workspace it had: this one would be orphaned.
			const now = this.store.required();
			if (now.slot !== "held" || now.state === "archived") {
				await this.#releaseCompute("stop");
				await provider.destroy(back.ref, { keepVolume: now.state !== "archived" });
				throw new Error("The coding thread gave its workspace slot up");
			}
			this.store.update({ workspaceRef: back.ref });
			this.#injections.clear();
			this.store.update({ session: { ...this.store.required().session, startedAt: this.now() } });
			await this.#openWorkspace({});
			return back.resumed ? ("resumed" as const) : ("created" as const);
		})();
		this.#cycling = cycle.then(
			() => undefined,
			() => undefined,
		);
		try {
			return await cycle;
		} finally {
			this.#cycling = null;
		}
	}

	/** The session is no longer being moved. */
	#settleSession(): void {
		const session = this.store.required().session;
		if (session.state === "continuing") this.store.update({ session: { ...session, state: "active" } });
	}

	/**
	 * The turn couldn't go on in a new session: it is stopped, which commits a checkpoint, and started again from its
	 * transcript (`#settleTurn` queues it), in a workspace made fresh if need be.
	 */
	async #restartTurn(operation: string, cause: unknown): Promise<void> {
		const thread = this.store.required();
		// The person stopped the turn, or it ended, while the move was under way: nothing is left to restart.
		if (thread.currentOperation !== operation || this.#userStop === operation) return this.#settleSession();
		console.warn(JSON.stringify({ event: "pim.coding.session_restart", thread: thread.threadId, operation, cause: errorText(cause).slice(0, 300) }));
		this.#restarting = operation;
		try {
			await this.#stopTurn("session");
		} catch (error) {
			this.#settleSession();
			throw error;
		} finally {
			this.#restarting = null;
		}
		if (this.#userStop === operation || this.store.required().state === "failed") return this.#settleSession();
		const provider = this.workspaceProviders().get(thread.providerId);
		let mode: "resumed" | "created" | null = null;
		if (this.store.required().workspaceRef) mode = await this.#cycleWorkspace(this.store.required(), provider).catch(async (error) => {
			// The workspace can't be brought back: the next turn makes one, from its volume or the autosave.
			console.warn(JSON.stringify({ event: "pim.coding.session_cycle_failed", thread: thread.threadId, error: errorText(error).slice(0, 300) }));
			this.#open = null;
			await this.#dropWorkspace({ keepVolume: true }).catch(() => undefined);
			this.store.update({ session: { ...this.store.required().session, startedAt: null } });
			return null;
		});
		const session = this.store.required().session;
		this.store.update({ session: { ...session, state: "active", continuations: session.continuations + 1, last: { at: this.now(), mode: "turn_restarted", reason: mode ? `session_cap:${mode}` : "session_cap" } } });
		this.store.recordEvent("session.turn_restarted", { operationId: operation, cause: errorText(cause).slice(0, 300) });
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
		// Only repositories of a known git provider instance, through the git broker: no workspace ever clones from anywhere else.
		const { provider, repo } = deploymentProviders(this.env).resolveUrl(input.repo, brokerPolicy(this.env));
		const budgetUsd = input.budgetUsd ?? null;
		if (budgetUsd !== null && !(Number.isFinite(budgetUsd) && budgetUsd > 0)) throw new Error("budgetUsd must be a positive number of dollars");
		await this.#refreshCompute();
		await this.#refreshPools(input.space);
		const pools = this.#placementPools();
		const pin = this.#pin(input, pools.pools);
		const first = pin ?? pools.pools[0];
		const providerId = first ? first.provider : (this.workspaceProviders().defaultId() ?? NO_BACKEND);
		const poolId = first ? first.id : providerId;
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
				repoUrl: provider.repoUrl(repo),
				providerInstance: provider.instance.id,
				baseRef: input.ref ?? "main",
				branch: branchName(task, threadId),
				profile: { providerId: profile.providerId, model: profile.model, ...(profile.thinking ? { thinking: profile.thinking } : {}) },
				harness,
				providerId,
				poolId,
				// A thread started on a pool by name runs there; any other may overflow until it makes its workspace.
				placed: pin !== undefined,
				state: "provisioning",
				createdBy: input.createdBy,
				parentThread: input.parent ?? null,
				limits: threadLimits(repo.fullName, input.limits),
				budgetUsd,
				startOperation: input.operationId,
			});
			this.#recordResolved(profile.providerId, profile.model, cli ? input.profile?.providerId === cli.id ? "explicit" : "harness default" : input.profile ? "explicit" : "space default");
			this.store.update({
				placementReason: pin ? "pinned" : "priority",
				placement: this.#placementObject(pin ? "pinned" : "priority", poolId, [poolId], pools),
			});
			this.store.enqueue(input.operationId, task);
			if (input.rebuildEnvironment) {
				this.store.update({ environment: { ...NO_ENVIRONMENT, rebuildRequested: true } });
			}
		});
		await this.#refreshCompute();
		const backend = this.#ensureBackend();
		if (backend === true) {
			await this.#requestSlot();
			this.#kick();
		} else await backend;
		return this.status();
	}

	/**
	 * The pool a start pins the thread to, from `pool` or `provider`: a pool's
	 * id, or a provider's — its id, its kind's name or the admin's name for it,
	 * in any case — which names the first enabled pool on that provider.
	 * Undefined when the start names none. A name that is neither is refused,
	 * saying which pools the space has, so a pinned thread never waits for a
	 * place it can't have. The registry is read after `#refreshPools`, which
	 * `start` has run. `workspaceProvider`, which the API doesn't take, names
	 * a backend by its exact id and isn't checked: the thread runs there, in
	 * that provider's first pool when the registry has one.
	 */
	#pin(input: StartThread, pools: readonly PlacementPool[]): PlacementPool | undefined {
		const named = [input.pool, input.provider].filter((name): name is string => name !== undefined);
		if (named.length === 0) {
			const id = input.workspaceProvider;
			if (id === undefined) return undefined;
			return pools.find((pool) => pool.provider === id) ?? { id, provider: id, size: null, priority: 0 };
		}
		const ids = this.workspaceProviders().ids();
		const resolve = (name: string): PlacementPool | undefined => {
			const wanted = name.trim().toLowerCase();
			const pool = pools.find((candidate) => candidate.id.toLowerCase() === wanted);
			if (pool) return pool;
			const provider = ids.find((id) => {
				const configured = this.#compute.providers.find((candidate) => COMPUTE_KINDS[candidate.kind].workspace === id);
				return [id, configured?.kind, configured?.name].some((alias) => alias?.toLowerCase() === wanted);
			});
			return provider ? pools.find((candidate) => candidate.provider === provider) : undefined;
		};
		const resolved = new Set(
			named.map((name) => {
				const found = resolve(name);
				if (!found) {
					throw new Error(
						`Unknown or disabled pool "${name}": this space's coding sandbox pools are ${pools.length === 0 ? "none (no backend is set up or enabled for coding)" : pools.map((pool) => `"${pool.id}"`).join(", ")}`,
					);
				}
				return found;
			}),
		);
		if (resolved.size > 1) throw new Error(`pool and provider name different pools (${[...resolved].map((pool) => pool.id).join(", ")}): give one`);
		return [...resolved][0];
	}

	readonly #activityWatch = new ActivityWatch(this.ctx.storage.sql);

	/** Current activity from the harness transcript, including output that has not completed a tool result yet. */
	async activity(): Promise<Activity> {
		await this.lifecycle.start();
		const thread = this.store.required();
		const now = this.now();
		const turns = turnsOf((await this.harness.messages()).flatMap((entry) => entry.model ?? []), new Map(), now, thread.state === "running");
		return activityOf(turns, now, { running: thread.state === "running", startedAt: turns.at(-1)?.startedAt ?? thread.updatedAt, lastOutputAt: this.#activityWatch.lastOutput("thread"), coding: true,
			outputByCall: cliHarness(thread.harness) ? undefined : Object.fromEntries((turns.at(-1)?.steps ?? []).flatMap((step) => step.kind === "tool" ? [[step.id, this.#activityWatch.lastOutput(step.id)]] : [])), });
	}

	async status(): Promise<CodingThreadStatus> {
		await this.lifecycle.start();
		const thread = this.store.required();
		const queue = thread.slot === "queued" ? await codingScheduler(this.env, thread.space).position(thread.threadId) : null;
		return {
			threadId: thread.threadId,
			activity: await this.activity(),
			state: thread.state,
			stateReason: thread.stateReason,
			stateDetail: thread.stateDetail,
			repo: { url: thread.repoUrl, ref: thread.baseRef, branch: thread.branch, baseSha: thread.baseSha },
			profile: thread.profile,
			resolvedProfile: thread.resolvedProfile,
			harness: thread.harness,
			workspaceProvider: thread.providerId,
			provider: thread.providerId,
			pool: thread.poolId,
			placementReason: thread.placementReason,
			placement: thread.placement,
			providerKind: thread.providerKind,
			orb: thread.orb === null ? null : { url: thread.orb.url },
			cost: thread.providerKind === "agent-hosted" ? thread.orbCostUsd : thread.spentUsd,
			costNote: thread.providerKind === "agent-hosted" ? thread.orbCostNote : null,
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
			consecutiveInterrupts: thread.consecutiveInterrupts,
			session: this.#sessionView(thread),
			pullRequest: thread.pullRequest,
		};
	}

	/** The workspace's session as the status tells it: what the provider caps, and when this session ends. */
	#sessionView(thread: CodingThreadRow): CodingSessionStatus {
		const caps = this.#capabilities(thread);
		const maxMin = caps?.sessionMaxMin ?? null;
		// The session ends at the earlier of the provider's cap and the compute cap of the stretch the ledger has open.
		const ends = [maxMin !== null && thread.session.startedAt !== null ? thread.session.startedAt + maxMin * 60_000 : null, this.#capAt].filter((at) => at !== null);
		return { ...thread.session, maxMin, expiresAt: ends.length === 0 ? null : Math.min(...ends), keepAlive: caps?.keepAlive ?? false };
	}

	#capabilities(thread: CodingThreadRow): WorkspaceProvider["capabilities"] | null {
		try {
			return this.workspaceProviders().get(thread.providerId).capabilities;
		} catch {
			return null;
		}
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
		if (thread.providerKind === "agent-hosted") return this.#steerOrb(thread, text, options);
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
			// What the person says supersedes a retry waiting for its backoff.
			this.store.releaseRetries();
			this.store.enqueue(options.operationId, text);
			this.#reopen();
		});
		this.#kick();
		return this.status();
	}

	/**
	 * Tells an agent-hosted thread something. Between turns the text waits in
	 * the inbox like any input, and the turn it starts delivers it to the
	 * agent as a steered message. During a turn it is steered to the agent at
	 * once, queued there until the agent takes it on a turn boundary — there
	 * is no cutting a turn short but ending the whole thread, so `interrupt`
	 * means no more here than it does without it. A client that can't be
	 * steered says so in the log, and the text waits for the thread's next
	 * turn instead of being lost.
	 */
	async #steerOrb(thread: CodingThreadRow, text: string, options: { interrupt?: boolean; operationId: string }): Promise<CodingThreadStatus> {
		if (thread.currentOperation === null) {
			this.#assertBudget(this.store.required());
			this.ctx.storage.transactionSync(() => {
				this.store.releaseRetries();
				this.store.enqueue(options.operationId, text);
				this.#reopen();
			});
			this.#kick();
			return this.status();
		}
		const client = await this.#orbClient();
		const orb = thread.orb;
		if (client !== null && orb !== null && client.capabilities().steer) {
			await client.steer(orb.threadId, text);
			this.store.recordEvent("orb.steered", { operationId: options.operationId, provider: client.id, orb: orb.threadId });
			return this.status();
		}
		const why = client === null ? AGENT_HOSTED_UNAVAILABLE : orb === null ? "This agent-hosted thread has no orb yet" : `${client.id} takes no messages for a thread while it runs`;
		this.ctx.storage.transactionSync(() => {
			this.store.releaseRetries();
			this.store.enqueue(options.operationId, text);
			this.store.recordEvent("orb.steer_unsupported", { operationId: options.operationId, message: `${why}, so this message waits for the thread's next turn` });
		});
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
		await this.#archiveHarnessSession(thread);
		// An agent-hosted thread is archived on the agent's site too, so it leaves the person's list there.
		if (thread.providerKind === "agent-hosted") await this.#stopOrb();
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
		const ready = await this.#ensureWorkspace();
		if (!ready.ok) throw new Error(ready.message);
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
		const messages = transcriptOf(await this.harness.messages());
		for (const [index, notice] of this.store.profileNotices().entries()) {
			const { provider, model, source } = notice.profile;
			const message: TranscriptMessage = { id: `model-resolved-${notice.seq}`, role: "notice", parts: [{ type: "text", text: `Model: ${provider} · ${model} · ${source ?? "source unknown"}` }], timestamp: notice.at };
			const before = index === 0 && source !== null ? 0 : messages.findIndex((entry) => !entry.id.startsWith("model-resolved-") && entry.timestamp >= notice.at);
			messages.splice(before < 0 ? messages.length : before, 0, message);
		}
		return messages;
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
		const blocker = await this.#pushBlocker(thread);
		if (blocker) return { ok: false, ...blocker };
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
		const ready = await this.#ensureWorkspace();
		if (!ready.ok) return ready;
		try {
			const bundle = await this.#bundle(target, checkpoint.sha);
			const prepared = preparePush({ app: this.githubApp(), policy, providers: this.#providers() }, { sessionId: thread.threadId, repo: thread.repoUrl, branch: target, bundle });
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
		const blocker = await this.#pushBlocker(thread);
		if (blocker) return { ok: false, message: blocker.message };
		const ready = await this.#ensureWorkspace();
		if (!ready.ok) return { ok: false, message: ready.message };
		try {
			const policy = brokerPolicy(this.env);
			const fetch = this.githubFetch();
			const request = { sessionId: thread.threadId, repo: thread.repoUrl, branch: approved.branch, bundle: await this.#bundle(approved.branch, approved.checkpoint) };
			const deps = { app: this.githubApp(), policy, providers: this.#providers(), ...(fetch ? { fetch } : {}) };
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
		const blocker = await this.#pushBlocker(thread);
		if (blocker) return { ok: false, ...blocker };
		if (thread.state === "archived") return { ok: false, code: "archived", message: "This coding thread is archived" };
		const checkpoint = this.store.latestCheckpoint();
		if (!checkpoint) return { ok: false, code: "nothing_to_push", message: "The thread hasn't committed anything yet: each turn's changes are committed when it ends" };
		const ready = await this.#ensureWorkspace();
		if (!ready.ok) return ready;
		try {
			const defaultBranch = await this.#defaultBranch(thread);
			const provider = this.#providers().get(thread.providerInstance);
			const repo = provider.parseRepoUrl(thread.repoUrl).fullName;
			return { ok: true, request: { checkpoint: checkpoint.sha, summary: `Merge ${thread.branch} (${checkpoint.sha.slice(0, 12)}) into ${defaultBranch} of ${new URL(provider.instance.baseUrl).host}/${repo}, with no force push` } };
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
		const blocker = await this.#pushBlocker(thread);
		if (blocker) return { ok: false, message: blocker.message };
		const ready = await this.#ensureWorkspace();
		if (!ready.ok) return { ok: false, message: ready.message };
		if (this.store.latestCheckpoint()?.sha !== approved.checkpoint) return { ok: false, message: "The thread has a newer checkpoint than the one approved: ask to merge again" };
		try {
			const fetch = this.githubFetch();
			const deps = { app: this.githubApp(), policy: brokerPolicy(this.env), providers: this.#providers(), ...(fetch ? { fetch } : {}) };
			const defaultBranch = await this.#defaultBranch(thread);
			const workspace = await this.#workspace();
			const identity = ["-c", "user.name=Pim", "-c", "user.email=coding@pim.invalid"];
			if ((await git(workspace, ["rev-parse", `refs/heads/${thread.branch}`])).trim() !== approved.checkpoint) throw new Error("The thread's branch has moved past its latest checkpoint: merge once its turn ends");
			let head = approved.checkpoint;
			let rebased = false;
			for (let attempt = 0; ; attempt++) {
				// Fetching goes through Pim's git broker, so it carries a broker token as a header for this command alone, as the clone does.
				const { token, auth } = await this.#brokerAccess(thread);
				await git(workspace, ["fetch", "origin", `+refs/heads/${defaultBranch}:refs/pim/merge-base`], { timeoutMs: CLONE_TIMEOUT_MS, env: auth, secret: token });
				const base = (await git(workspace, ["rev-parse", "refs/pim/merge-base"])).trim();
				const common = (await git(workspace, ["merge-base", base, head]).catch(() => "")).trim();
				if (common === head) return { ok: true, result: { repo: this.#providers().get(thread.providerInstance).parseRepoUrl(thread.repoUrl).fullName, branch: defaultBranch, before: base, after: base, outcome: "unchanged", rebased, threadBranch: null } };
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

	/**
	 * Readies a pull request from the thread's pushed branch into its base
	 * branch (the one it started from, or the default branch when it started
	 * from a commit), for the person to approve: the provider is set up
	 * (GitHub's App, or the connected Gitea account) and Pim has pushed the
	 * branch. `title` and `body` default to the thread's task. Nothing is
	 * opened yet. Says why not, as a code, when it can't.
	 */
	async preparePullRequest(input: { title?: string; body?: string } = {}): Promise<PullRequestPreparation> {
		await this.lifecycle.start();
		const thread = this.store.required();
		const blocker = await this.#pushBlocker(thread);
		if (blocker) return { ok: false, ...blocker };
		if (thread.state === "archived") return { ok: false, code: "archived", message: "This coding thread is archived" };
		if (!this.store.hasPushed(thread.branch)) return { ok: false, code: "not_pushed", message: `${thread.branch} hasn't been pushed: push the thread's branch first, then open the pull request` };
		try {
			const provider = this.#providers().get(thread.providerInstance);
			const repo = provider.parseRepoUrl(thread.repoUrl, brokerPolicy(this.env)).fullName;
			const base = /^[0-9a-f]{40}$/i.test(thread.baseRef) || thread.baseRef === "main" ? await this.#defaultBranch(thread) : thread.baseRef;
			const task = (await codingScheduler(this.env, thread.space).thread(thread.threadId))?.task ?? thread.branch;
			const title = input.title?.trim() || (task.split("\n")[0]!.trim().slice(0, 100) || thread.branch);
			const body = input.body ?? `${task.length > 2000 ? `${task.slice(0, 2000)}…` : task}\n\n---\nOpened by Pim from a coding thread.`;
			return { ok: true, request: { title, body, base, summary: `Open a pull request from ${thread.branch} into ${base} of ${new URL(provider.instance.baseUrl).host}/${repo}: ${title}` } };
		} catch (error) {
			return { ok: false, code: "conflict", message: errorText(error) };
		}
	}

	/**
	 * Opens what the person approved (`preparePullRequest`'s request) through
	 * the thread's provider, which answers with the open pull request from the
	 * branch if there is one already. The URL and number are kept on the
	 * thread, and the log records it.
	 */
	async openPullRequest(approved: { title: string; body: string; base: string }): Promise<{ ok: true; result: { repo: string; url: string; number: number; base: string; head: string } } | { ok: false; message: string }> {
		await this.lifecycle.start();
		const thread = this.store.required();
		const blocker = await this.#pushBlocker(thread);
		if (blocker) return { ok: false, message: blocker.message };
		if (thread.state === "archived") return { ok: false, message: "This coding thread is archived" };
		if (!this.store.hasPushed(thread.branch)) return { ok: false, message: `${thread.branch} hasn't been pushed: push the thread's branch first, then open the pull request` };
		try {
			const provider = this.#providers().get(thread.providerInstance);
			const repo = provider.parseRepoUrl(thread.repoUrl, brokerPolicy(this.env));
			const { url, number } = await provider.createPullRequest({ repo, head: thread.branch, base: approved.base, title: approved.title, body: approved.body });
			this.store.update({ pullRequest: { url, number } });
			this.store.recordEvent("thread.pull_request", { repo: repo.fullName, branch: thread.branch, base: approved.base, url, number });
			return { ok: true, result: { repo: repo.fullName, url, number, base: approved.base, head: thread.branch } };
		} catch (error) {
			return { ok: false, message: error instanceof GitBrokerNotConfiguredError ? GITHUB_APP_NOT_CONFIGURED : errorText(error) };
		}
	}

	/** The name of the thread's repository's default branch, from its provider. */
	async #defaultBranch(thread: CodingThreadRow): Promise<string> {
		const provider = this.#providers().get(thread.providerInstance);
		if (provider.instance.kind !== "github") return checkBranchName(await provider.defaultBranch(provider.parseRepoUrl(thread.repoUrl, brokerPolicy(this.env))));
		const fetch = this.githubFetch();
		return repoDefaultBranch({ app: this.githubApp(), policy: brokerPolicy(this.env), ...(fetch ? { fetch } : {}) }, thread.repoUrl);
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
	 * the thread's time limit and a margin (a week, with none), and every token of the thread is
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
		const expiresAt = this.now() + (thread.limits.wallClockMin === null ? UNLIMITED_TOKEN_MS : thread.limits.wallClockMin * 60_000) + GATEWAY_TOKEN_MARGIN_MS;
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
		// A provider that injects credentials gets the token in its egress proxy, and the workspace only a placeholder to send.
		const placed = placeSecret(this.workspaceProviders().get(this.store.required().providerId), gatewayInjection(origin, `/api${MODEL_GATEWAY_PATH}`, HARNESS_FAMILY[harness], token), token);
		if (placed.rule) await this.#inject("model-gateway", placed.rule);
		return sandboxModelEnv(origin, harness, placed.env);
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
			if (current.budgetUsd !== null && current.spentUsd >= current.budgetUsd) {
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
			if (api !== "anthropic-count-tokens") this.#recordResolved(credential.providerId, read.model);
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

	/** The scheduler's notice: the queued thread holds a slot now, in `pool` when the notice says, which may be one it overflowed to. */
	async admitted(key: string, pool?: string): Promise<void> {
		await this.lifecycle.start();
		const thread = this.store.thread();
		if (!thread || !this.store.firstNotice(key) || thread.slot === "held") return;
		if (thread.slot === "none" || thread.state === "archived" || thread.state === "failed") {
			// It stopped waiting meanwhile: the slot goes to the next thread.
			await codingScheduler(this.env, thread.space).release(thread.threadId);
			return;
		}
		await this.#holdSlot(pool);
		this.#kick();
	}

	/** The scheduler's notice: the thread waited too long in the queue and left it. */
	async expired(entry: QueueEntry, key: string): Promise<void> {
		await this.lifecycle.start();
		const thread = this.store.thread();
		if (!thread || !this.store.firstNotice(key) || thread.slot !== "queued") return;
		const skipped = new Map<string, string>((entry.skipped ?? [entry.pool, ...(entry.overflow ?? [])].map((pool) => ({ pool, reason: "full" }))).map(({ pool, reason }) => [pool, reason]));
		for (const { pool, reason } of this.#placementPools().skipped) skipped.set(pool.id, reason);
		const attempt = thread.noCapacityTimeouts + 1;
		const detail = `No sandbox capacity after 30 minutes: ${[...skipped].map(([pool, reason]) => `${pool}: ${reason}`).join(", ")}. Free a slot, enable a pool, or check pool health. ${attempt === 1 ? "Retrying automatically for another 30 minutes." : "Automatic retry exhausted; continue the thread to try again."}`;
		this.ctx.storage.transactionSync(() => {
			this.store.update({ slot: "none", noCapacityTimeouts: attempt, stateReason: "no_capacity", stateDetail: detail });
			this.store.recordEvent("thread.no_capacity", { attempt, retrying: attempt === 1, pools: [...skipped].map(([pool, reason]) => `${pool}: ${reason}`).join(", "), message: detail });
		});
		if (attempt === 1) {
			await this.#requestSlot();
			this.#kick();
		} else await this.#fail("no_capacity", detail, false);
	}

	/** The scheduler's notice: it took the thread's slot back, after the thread was idle or waited for the person too long. */
	async released(released: Released, key: string): Promise<void> {
		await this.lifecycle.start();
		const thread = this.store.thread();
		if (!thread || !this.store.firstNotice(key) || thread.slot !== "held") return;
		if (thread.currentOperation || this.store.inboxSize() > 0 || thread.environment.rebuildRequested || this.#resuming) {
			// It reported itself idle or waiting just before a turn began: ask for the slot back in FIFO order.
			console.warn(JSON.stringify({ event: "pim.coding.released_running", thread: thread.threadId, why: released.why }));
			this.store.update({ slot: "none", resumePriority: true });
			await this.#requestSlot();
			this.#kick();
			return;
		}
		// Idle or preempted, the work is committed and bundled first, best effort, so it outlives the kept volume should that be reclaimed.
		await this.#checkpoint(null).catch((error) => console.warn(JSON.stringify({ event: "pim.coding.checkpoint_failed", thread: thread.threadId, error: String(error) })));
		await this.#autosave();
		const current = this.store.required();
		if (current.currentOperation || this.store.inboxSize() > 0 || current.environment.rebuildRequested || this.#resuming) {
			this.store.update({ slot: "none", resumePriority: true });
			await this.#requestSlot();
			this.#kick();
			return;
		}
		if (released.why === "idle") await this.#suspendWorkspace();
		else await this.#dropWorkspace({ keepVolume: true });
		this.store.update({ slot: "none", slotSince: null, idleSince: null, resumePriority: released.why === "preempted" });
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
						resolvedProfile: thread.resolvedProfile,
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
	 * it has some left or has none: a thread has a budget only if one was
	 * set. A CLI harness that reports no cost never spends any, so it is
	 * never stopped by one.
	 */
	#budgetSpent(thread: CodingThreadRow): string | null {
		return thread.budgetUsd !== null && thread.spentUsd >= thread.budgetUsd ? `This coding thread has spent its $${thread.budgetUsd} budget` : null;
	}

	/**
	 * Makes sure the thread has a running workspace for a tool that needs one
	 * (push, merge, a diff not kept): a thread whose slot was given back asks
	 * for a slot again and gets its workspace made, with no turn, and goes back
	 * to idle. Waits up to `waitMs`. A thread queued for a slot says so, with
	 * its place, as `workspace_queued`; the caller can try again later.
	 */
	async #ensureWorkspace({ waitMs = this.resumeWaitMs() }: { waitMs?: number } = {}): Promise<{ ok: true } | { ok: false; code: "workspace_queued" | "workspace_not_running"; message: string }> {
		const deadline = Date.now() + waitMs;
		for (;;) {
			const thread = this.store.required();
			if (thread.state === "archived" || thread.state === "failed" || thread.state === "waiting_input") {
				return { ok: false, code: "workspace_not_running", message: `The thread's workspace isn't running: the thread is ${thread.state.replace("_", " ")}, so only each checkpoint's diff from the start is kept` };
			}
			if (thread.slot === "held" && thread.state !== "provisioning") {
				try {
					await this.#workspace();
					if (this.store.required().slot === "held") return { ok: true };
				} catch (error) {
					if (this.store.required().slot === "held") return { ok: false, code: "workspace_not_running", message: `The thread's workspace isn't running and could not be opened: ${errorText(error)}` };
				}
				continue;
			}
			// Otherwise it is queued or being made; the step that makes it ends in idle.
			this.#resuming = true;
			if (thread.slot === "none") {
				this.#reopen();
				await this.#requestSlot();
			}
			this.#kick();
			const remaining = deadline - Date.now();
			if (remaining <= 0) return await this.#resumeTimedOut();
			await Promise.race([this.#advance(), new Promise((resolve) => setTimeout(resolve, Math.min(remaining, 250)))]);
		}
	}

	/** The thread's workspace isn't back after the wait: says whether it waits for a slot, and its place. */
	async #resumeTimedOut(): Promise<{ ok: false; code: "workspace_queued" | "workspace_not_running"; message: string }> {
		const thread = this.store.required();
		if (thread.slot !== "queued") return { ok: false, code: "workspace_not_running", message: "The thread's workspace is still resuming: try again in a minute" };
		const scheduler = codingScheduler(this.env, thread.space);
		const place = await scheduler.position(thread.threadId);
		const total = (await scheduler.snapshot()).queued.length;
		const eta = place ? await scheduler.etaMs(place.position) : null;
		const where = place ? ` (position ${place.position} of ${total}, ${eta === null ? "no ETA yet" : `ETA about ${Math.max(1, Math.round(eta / 60_000))} min`})` : "";
		return { ok: false, code: "workspace_queued", message: `The thread's workspace is suspended and still queued for a sandbox slot${where}: try again later` };
	}

	/** A failed or stopped thread with new input waits for a slot again. Runs in the caller's transaction. */
	#reopen(): void {
		const thread = this.store.required();
		if (thread.state === "failed" && thread.stateReason === "no_capacity") this.store.update({ noCapacityTimeouts: 0 });
		if (thread.state === "failed" || thread.state === "waiting_input" || (thread.state === "idle" && thread.slot === "none")) this.store.update({ state: thread.slot === "queued" ? "queued" : "provisioning", stateReason: null, stateDetail: null, budgetStopped: false });
	}

	/** Runs the `advance` job now, and in memory at once. */
	#kick(): void {
		void this.#schedule(Date.now()).catch((error) => console.warn(JSON.stringify({ event: "pim.coding.schedule_failed", error: String(error) })));
		void this.#advance();
	}

	#schedule(at: number): Promise<unknown> {
		// One job is the thread's only timer: it comes no later than the compute cap, if the workspace has one.
		const cap = this.#capWake();
		return this.lifecycle.jobs.push({ id: ADVANCE_JOB, fn: ADVANCE_JOB, time: cap === null ? at : Math.min(at, Math.max(cap, Date.now() + 1_000)) });
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
		// A move to a new session is under way: it kicks the thread when it is done.
		if (this.#renewing) return;
		// An agent-hosted thread runs in the agent's own cloud, not a machine Pim made: it needs no slot, no workspace and no environment, and its turns are only started and polled through the client (./orb/).
		if (thread.providerKind === "agent-hosted") return this.#stepOrb(thread);
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
		// Pending inputs, even in backoff, keep the slot busy rather than idle.
		if (this.store.inboxSize() > 0 && thread.slot === "held" && thread.idleSince !== null) await this.#report("running");
		// An input held for a retry's backoff waits for it.
		const held = this.store.nextInput();
		if (held && held.notBefore > Date.now()) {
			await this.#schedule(held.notBefore);
			return;
		}
		const work = this.store.inboxSize() > 0;
		// A rebuild of the environment needs the workspace as a turn does.
		const rebuild = thread.environment.rebuildRequested;
		// A tool waiting for the workspace needs it made too, though no turn follows, even if it stops waiting before it is made.
		if (!work && !rebuild && !this.#resuming) {
			await this.#releaseIdle();
			if (thread.state === "provisioning" && thread.slot !== "held") this.store.update({ state: "idle" });
			return;
		}
		if (thread.slot === "none") {
			await this.#refreshCompute();
			const backend = this.#ensureBackend();
			if (backend !== true) {
				await backend;
				return;
			}
			await this.#requestSlot();
		} else if (thread.slot === "queued") await this.#refreshCapacity();
		thread = this.store.required();
		if (thread.slot !== "held") return;
		// The manager refused the workspace for low disk last time: its health now says whether the space's queue may open again.
		if (thread.stateReason === "low_disk") await this.#refreshCapacity();
		this.#resuming = false;
		try {
			await this.#workspace();
			// A rebuild between turns is work the scheduler shouldn't take the slot back from.
			if (!work && rebuild) await this.#report("running");
			await this.#prepareEnvironment();
			await this.#prepareWorkspaceGit(await this.#workspace(), this.store.required());
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
			// The workspace went down as the turn was readied: it is made again, as when it is found down while being readied.
			if (error instanceof WorkspaceLostError && this.store.required().currentOperation === null) {
				await this.#provisioningFailed(error);
				return;
			}
			// Such as a model provider removed from the space since: the thread can't go on until it is continued.
			console.warn(JSON.stringify({ event: "pim.coding.turn_not_started", thread: thread.threadId, error: String(error) }));
			if (this.store.required().currentOperation !== null) return;
			await this.#fail("turn", error instanceof Error ? error.message : String(error), true);
		}
	}

	/**
	 * Whether the deployment has the thread's workspace backend. A thread
	 * started while it had none takes the default once there is one. Without
	 * one the thread fails with `no_backend` and says what to set up; it can
	 * be continued once that's done.
	 */
	#ensureBackend(): true | Promise<false> {
		const thread = this.store.required();
		const registry = this.workspaceProviders();
		let id = thread.providerId;
		const fallback = registry.defaultId();
		if (id === NO_BACKEND && fallback !== null) {
			id = fallback;
			const pools = this.#placementPools().pools;
			const pool = pools.find((candidate) => candidate.provider === id);
			this.store.update({ providerId: id, poolId: pool ? pool.id : id });
		}
		try {
			registry.get(id);
			return true;
		} catch (error) {
			if (!(error instanceof NoWorkspaceBackendError)) throw error;
			// Only a failure awaits, so a thread with its backend takes no extra turn of the event loop.
			return this.#fail(error.code, error.message, false).then(() => false as const);
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
	 * (./provider-capacity.ts): under 15% of its disk free holds the queue
	 * for the manager's provider, and its limit caps the space's slots there.
	 * Only for a backend with a manager; one that can't be reached changes
	 * nothing. Returns the health, or null without one.
	 */
	async #refreshCapacity(): Promise<ManagerHealth | null> {
		const thread = this.store.required();
		const health = this.#healthOf(thread);
		if (!health) return null;
		try {
			const { freeDiskPct, maxConcurrent, running, free } = await health();
			await codingScheduler(this.env, thread.space).refreshConditions({ freeDiskPct, maxConcurrent, running, free }, DEFAULT_SPACE_CAP, thread.poolId);
			return { freeDiskPct, maxConcurrent, running, free };
		} catch (error) {
			console.warn(JSON.stringify({ event: "pim.coding.health_failed", thread: thread.threadId, error: String(error) }));
			return null;
		}
	}

	/**
	 * Where the thread may take a slot: its own pool alone once it is placed
	 * there; otherwise its own pool first and the registry's others after it,
	 * in their order of priority, as overflow. A pool whose provider's manager
	 * says it runs as many workspaces as it may goes last, so the thread takes
	 * a slot elsewhere rather than one it can't use.
	 */
	#placement(thread: CodingThreadRow, health: ManagerHealth | null): { pool: string; overflow: string[] } {
		if (thread.placed) return { pool: thread.poolId, overflow: [] };
		const others = this.#placementPools()
			.pools.map((pool) => pool.id)
			.filter((id) => id !== thread.poolId);
		const order = health && health.free <= 0 ? [...others, thread.poolId] : [thread.poolId, ...others];
		return { pool: order[0]!, overflow: order.slice(1) };
	}

	/**
	 * Moves the slot of a thread not yet placed whose provider refused its
	 * workspace for room (a full backend, or the manager's low disk) to another
	 * pool with a slot free: true when it moved, so it makes its workspace
	 * there next.
	 */
	async #overflow(thread: CodingThreadRow): Promise<boolean> {
		if (thread.placed || thread.slot !== "held") return false;
		const { pool, overflow } = this.#placement(thread, null);
		if (overflow.length === 0) return false;
		this.#unhealthyPools = new Set(await codingScheduler(this.env, thread.space).unhealthyPools([pool, ...overflow]));
		const moved = await codingScheduler(this.env, thread.space).move(thread.threadId, overflow);
		if (moved === null) return false;
		this.ctx.storage.transactionSync(() => {
			this.store.update({
				poolId: moved,
				providerId: this.#providerOf(moved),
				stateReason: null,
				placementReason: "overflow",
				placement: this.#placementObject("overflow", moved, [pool, ...overflow], this.#placementPools()),
			});
			this.store.recordEvent("workspace.overflow", { from: thread.poolId, to: moved });
		});
		return true;
	}

	/** Asks the scheduler for a slot, unless the thread holds one or waits for one, after bringing the pool registry and the manager's health to the scheduler. */
	async #requestSlot(): Promise<void> {
		if (this.store.required().slot !== "none") return;
		const thread = this.store.required();
		await this.#refreshPools(thread.space);
		const health = await this.#refreshCapacity();
		if (thread.slot !== "none") return;
		this.store.update({ slot: "queued" });
		const { pool, overflow } = this.#placement(thread, health);
		let result: Awaited<ReturnType<ReturnType<typeof codingScheduler>["request"]>>;
		try {
			result = await codingScheduler(this.env, thread.space).request(thread.threadId, {
				pool,
				...(overflow.length > 0 ? { overflow } : {}),
				...(thread.resumePriority ? { priority: PREEMPT_RESUME_PRIORITY } : {}),
			});
		} catch (error) {
			if (this.store.required().slot === "queued") this.store.update({ slot: "none" });
			throw error;
		}
		if (result.status === "admitted") await this.#holdSlot(result.pool);
		// Admission may have been told meanwhile, by a notice that came while the request was answered.
		else if (this.store.required().slot === "queued") {
			this.ctx.storage.transactionSync(() => {
				this.store.update({ state: "queued" });
				this.store.recordEvent("thread.queued", { position: result.position, reason: result.reason });
			});
		}
	}

	/**
	 * Records that the thread holds a slot, in `pool` when it took one other
	 * than its own: it readies its workspace on that pool's provider next. A
	 * thread that took one of its overflow is placed there for good, with the
	 * pools it walked past, full, in its placement.
	 */
	async #holdSlot(pool = this.store.required().poolId): Promise<void> {
		const thread = this.store.required();
		if (thread.slot === "held") return;
		const pools = this.#placementPools();
		this.#unhealthyPools = new Set(await codingScheduler(this.env, thread.space).unhealthyPools(pools.pools.map((candidate) => candidate.id)));
		const provider = this.#providerOf(pool, pools);
		const walk = thread.placed ? undefined : this.#placement(thread, null);
		const order = walk ? [walk.pool, ...walk.overflow] : [thread.poolId];
		const kind: PlacementReason = pool === thread.poolId ? thread.placementReason : "overflow";
		this.ctx.storage.transactionSync(() => {
			this.store.update({
				slot: "held",
				slotSince: this.now(),
				resumePriority: false,
				noCapacityTimeouts: 0,
				stateReason: null,
				stateDetail: null,
				poolId: pool,
				providerId: provider,
				placementReason: kind,
				placement: this.#placementObject(kind, pool, order, pools),
				...(thread.state === "queued" ? { state: "provisioning" } : {}),
			});
			if (pool !== thread.poolId) this.store.recordEvent("workspace.overflow", { from: thread.poolId, to: pool });
		});
	}

	/** The provider behind `pool`: the registry's, and otherwise the pool's own id, as while one provider is one pool. */
	#providerOf(pool: string, pools: { pools: readonly PlacementPool[] } = this.#placementPools()): string {
		return pools.pools.find((candidate) => candidate.id === pool)?.provider ?? pool;
	}

	/**
	 * The thread's placement as its status tells it: which pool it took a
	 * slot in, the provider behind it and the pool's priority, with the pools
	 * it couldn't and why — switched off, without a provider the deployment
	 * has, or full where it walked past them to the one it took.
	 */
	#placementObject(kind: PlacementReason, poolId: string, order: readonly string[], pools: { pools: readonly PlacementPool[]; skipped: readonly SkippedPool[] }): ThreadPlacement {
		const full = order.slice(0, Math.max(0, order.indexOf(poolId)));
		return {
			kind,
			pool: poolId,
			provider: this.#providerOf(poolId, pools),
			priority: pools.pools.find((candidate) => candidate.id === poolId)?.priority ?? 0,
			skipped: [
				...pools.skipped.map(({ pool, reason }) => ({ pool: pool.id, reason })),
				...full.map((pool) => ({ pool, reason: this.#unhealthyPools.has(pool) ? "unhealthy" as const : "full" as const })),
			],
		};
	}

	async #cancelQueued(): Promise<void> {
		const thread = this.store.required();
		await codingScheduler(this.env, thread.space).cancel(thread.threadId);
		this.store.update({ slot: "none" });
	}

	/**
	 * Closes the CLI harness's session on the vendor's site (Amp's thread on ampcode.com) when the coding thread
	 * is archived or fails, so the person's list there doesn't fill with finished threads; a later turn reopens it.
	 * It needs the running workspace and the person's key, so a thread without either leaves its session be. Best-effort:
	 * a failure is logged and never fails the thread.
	 */
	async #archiveHarnessSession(thread: CodingThreadRow): Promise<void> {
		const cli = cliHarness(thread.harness);
		const session = this.store.harnessSession();
		if (!cli?.archiveCommand || !session || thread.slot !== "held" || !thread.workspaceRef) return;
		try {
			const auth = await this.harnessAuth(thread, cli);
			if (auth.mode !== "env") return;
			const workspace = await this.#workspace();
			let exit: number | null = 0;
			for await (const event of workspace.exec(cli.archiveCommand(session.sessionId), { cwd: REPO_DIR, env: { HOME: HARNESS_HOME, ...harnessEnv(cli.id), ...cli.env, ...auth.env }, timeoutMs: 20_000 })) {
				if (event.type === "exit") exit = event.timedOut ? null : event.code;
			}
			if (exit !== 0) console.warn(JSON.stringify({ event: "pim.coding.harness_archive_failed", thread: thread.threadId, harness: cli.id, exit }));
		} catch (error) {
			console.warn(JSON.stringify({ event: "pim.coding.harness_archive_failed", thread: thread.threadId, harness: cli.id, error: String(error).slice(0, 300) }));
		}
	}

	/** Gives the slot back (or leaves the queue) and deletes the workspace, as a thread does when it fails or is archived. */
	async #giveBack(options: { keepVolume: boolean }): Promise<void> {
		const thread = this.store.required();
		if (thread.slot === "queued") await this.#cancelQueued();
		await this.#dropWorkspace(options).catch((error) => console.warn(JSON.stringify({ event: "pim.coding.destroy_failed", thread: thread.threadId, error: String(error) })));
		if (thread.slot === "held") {
			await codingScheduler(this.env, thread.space).release(thread.threadId);
			this.store.update({ slot: "none", slotSince: null, idleSince: null });
			this.#recordDuration(thread);
		}
	}

	#recordDuration(thread: CodingThreadRow): void {
		if (thread.slotSince === null) return;
		void codingScheduler(this.env, thread.space)
			.recordDuration(Math.max(0, this.now() - thread.slotSince))
			.catch(() => {});
	}

	/** Suspends an unused workspace, keeping its ref or volume for the next steer. */
	async #suspendWorkspace(): Promise<void> {
		const thread = this.store.required();
		const provider = this.workspaceProviders().get(thread.providerId);
		this.#open = null;
		if (thread.workspaceRef && provider.capabilities.suspendResume) {
			await provider.suspend(thread.workspaceRef);
			await this.#releaseCompute("suspend");
		} else await this.#dropWorkspace({ keepVolume: true });
	}

	/** Gives an idle slot back after its grace, without interrupting pending work. */
	async #releaseIdle(): Promise<void> {
		const idle = () => {
			const thread = this.store.required();
			return thread.state === "idle" && thread.slot === "held" && !thread.currentOperation && this.store.inboxSize() === 0 && !thread.environment.rebuildRequested && !this.#resuming;
		};
		if (!idle()) return;
		const thread = this.store.required();
		if (thread.idleSince === null) return this.#report("idle");
		if (this.now() < thread.idleSince + IDLE_SLOT_GRACE_MS) return;
		await this.#checkpoint(null).catch(() => {});
		await this.#autosave();
		if (!idle()) return;
		await this.#suspendWorkspace();
		this.store.update({ slot: "none", slotSince: null, idleSince: null });
		await codingScheduler(this.env, thread.space).release(thread.threadId);
		this.#recordDuration(thread);
		this.store.recordEvent("workspace.suspended", { reason: "idle" });
	}

	async #report(activity: SlotActivity): Promise<void> {
		const thread = this.store.required();
		if (thread.slot !== "held") return;
		const idleSince = activity === "idle" ? thread.idleSince ?? this.now() : null;
		this.store.update({ idleSince });
		if (idleSince !== null) await this.#schedule(Date.now() + Math.max(0, idleSince + IDLE_SLOT_GRACE_MS - this.now()));
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
		this.#autosavedAt = Date.now();
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
	 * One pass for a thread that runs in the agent's own cloud (./orb/): it
	 * looks at the turn under way — mirroring what the agent said and ending
	 * the turn when its client says it is done — and otherwise starts the
	 * oldest input's turn there. Nothing here touches a workspace, a slot or
	 * an environment: the client is the whole of what the thread can do with
	 * the agent, and the work itself is on the agent's cloud.
	 */
	async #stepOrb(thread: CodingThreadRow): Promise<void> {
		for (;;) {
			if (thread.currentOperation !== null) {
				await this.#pollOrb(thread.currentOperation);
				const now = this.store.thread();
				if (!now || now.state === "failed" || now.state === "archived" || now.state === "waiting_input" || now.currentOperation !== null) return;
				thread = now;
			}
			const input = this.store.nextInput();
			if (input === null) {
				if (thread.state === "provisioning") this.store.update({ state: "idle" });
				return;
			}
			// An input held for a retry's backoff waits for it.
			if (input.notBefore > Date.now()) return void (await this.#schedule(input.notBefore));
			await this.#startOrbTurn(input);
			if (this.store.required().currentOperation === null) return;
			thread = this.store.required();
		}
	}

	/**
	 * Starts the input's turn on the agent's cloud. The thread's first turn
	 * does that with `start`, idempotent on a key of the thread and the
	 * input's operation, and the orb it answers is kept on the thread's
	 * record at once — before anything else is awaited, so a restart finds
	 * it there and never starts a second orb. Every later turn is a message
	 * steered to the same orb, which the agent takes when it is ready, on a
	 * turn boundary.
	 */
	async #startOrbTurn(input: InboxItem): Promise<void> {
		const thread = this.store.required();
		const client = await this.#orbClient();
		if (client === null) return this.#failOrb("orb_unavailable", AGENT_HOSTED_UNAVAILABLE);
		const orb = thread.orb;
		try {
			if (orb === null) {
				const started = await client.start({ project: thread.repoUrl, prompt: input.text, mode: null, title: null, idempotencyKey: `${thread.threadId}:${input.operationId}` });
				this.ctx.storage.transactionSync(() => {
					// The orb first: after this the thread never calls `start` again, whatever happens to it.
					this.store.update({ orb: started, providerId: client.id });
					this.store.dequeue(input.seq);
					this.store.update({ state: "running", stateReason: null, stateDetail: null, currentOperation: input.operationId, budgetStopped: false });
					this.store.recordEvent("thread.turn_started", { operationId: input.operationId, provider: client.id, orb: started.threadId });
				});
				return;
			}
			if (!client.capabilities().steer) {
				this.store.dequeue(input.seq);
				return this.#failOrb("orb_steer_unsupported", `${client.id} takes no messages for a thread it has started, so this thread can't be told anything more`);
			}
			await client.steer(orb.threadId, input.text);
			this.ctx.storage.transactionSync(() => {
				this.store.dequeue(input.seq);
				this.store.update({ state: "running", stateReason: null, stateDetail: null, currentOperation: input.operationId, budgetStopped: false });
				this.store.recordEvent("thread.turn_started", { operationId: input.operationId, provider: client.id, orb: orb.threadId, steered: true });
			});
		} catch (error) {
			if (error instanceof OrbLostError) return this.#failOrb("orb_lost", error.message);
			if (error instanceof OrbAuthError) return this.#failOrb("orb_auth", error.message);
			if (error instanceof OrbUnreachableError) {
				// Nothing was changed, and `start` is idempotent: the next pass starts the same turn.
				this.ctx.storage.transactionSync(() => {
					this.store.update({ stateReason: "orb_unreachable", stateDetail: "The agent's cloud can't be reached just now; the turn starts when it can be" });
					this.store.recordEvent("orb.unreachable", { operationId: input.operationId });
				});
				await this.#schedule(Date.now() + this.orbPollMs());
				return;
			}
			if (error instanceof OrbUnsupportedError) return this.#failOrb("orb_unsupported", error.message);
			return this.#failOrb("orb_error", errorText(error));
		}
	}

	/**
	 * Looks at the turn under way: mirrors what the agent said since the last
	 * look, and ends the turn when its client says it is done. "idle" ends the
	 * turn as any turn's end does; "error" fails it with what the agent last
	 * said; "unknown" — a client that can't tell, such as one that was itself
	 * restarted — ends nothing, and a bound on unknown looks in a row fails
	 * the turn as unknown rather than waiting on nothing for ever. An orb that
	 * no longer exists fails the thread, and a cloud that can't be reached
	 * just now is waited out. Nothing but the client's word may end the turn:
	 * whatever ran of it belongs to the agent's cloud.
	 */
	async #pollOrb(operation: string): Promise<void> {
		const thread = this.store.required();
		if (thread.currentOperation !== operation) return;
		const client = await this.#orbClient();
		if (client === null) return this.#failOrb("orb_unavailable", AGENT_HOSTED_UNAVAILABLE);
		const orb = thread.orb;
		if (orb === null) return this.#failOrb("orb_lost", "The agent-hosted thread has no orb to run on");
		try {
			await this.#mirrorOrb(client, orb);
			const status = await client.state(orb.threadId);
			if (status.state === "idle") {
				this.#orbUnknowns = 0;
				await this.#orbCost(client, orb);
				return await this.#endTurn(operation, { status: "done" });
			}
			if (status.state === "error") {
				this.#orbUnknowns = 0;
				const said = await this.#lastSaid().catch(() => null);
				return await this.#endTurn(operation, { status: "unanswered", reason: "orb_error", detail: `The agent's cloud reported the thread ended in an error${said ? `; it last said: ${said}` : ""}` });
			}
			if (status.state === "unknown") {
				if (++this.#orbUnknowns >= this.orbUnknownLimit()) return this.#failOrb("orb_state_unknown", `The agent's cloud couldn't say what the thread was doing for ${this.orbUnknownLimit()} looks in a row, so the turn was given up on`);
			} else this.#orbUnknowns = 0;
		} catch (error) {
			if (error instanceof OrbLostError) return this.#failOrb("orb_lost", error.message);
			if (error instanceof OrbAuthError) return this.#failOrb("orb_auth", error.message);
			if (error instanceof OrbUnreachableError) {
				// Nothing was changed: the next look tries again.
				console.warn(JSON.stringify({ event: "pim.coding.orb_unreachable", thread: thread.threadId, operation }));
			} else if (error instanceof OrbUnsupportedError) return this.#failOrb("orb_unsupported", error.message);
			else return await this.#endTurn(operation, { status: "unanswered", reason: "orb_error", detail: errorText(error) });
		}
		await this.#schedule(Date.now() + this.orbPollMs());
	}

	/**
	 * Mirrors what the agent's cloud has of the thread into the thread's own
	 * conversation, so the person reads it where they read any thread's: a
	 * page at a time, from the message after the last one mirrored — which is
	 * kept on the thread's record, so a restart repeats nothing.
	 */
	async #mirrorOrb(client: OrbClient, orb: OrbThread): Promise<void> {
		const before = this.store.required().orbLastMessage;
		let after = before;
		const read: OrbMessage[] = [];
		for (let calls = 0; calls < ORB_MESSAGE_PAGES; calls++) {
			const page = await client.messages(orb.threadId, after === null ? {} : { after });
			if (page.length === 0) break;
			const last = page[page.length - 1]!.id;
			// A client that answers the same page whatever it is asked would never end; it ends here instead.
			if (read.length > 0 && last === read[read.length - 1]!.id) break;
			read.push(...page);
			after = last;
		}
		for (const message of read) {
			// The agent's own words, as they are, without asking the thread's model anything: no provider, model or usage of Pim's is invented for them.
			const said: Message =
				message.role === "assistant"
					? {
							role: "assistant",
							content: [{ type: "text", text: message.text }],
							api: "anthropic-messages",
							provider: "orb",
							model: "orb",
							usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
							stopReason: "stop",
							timestamp: message.at,
						}
					: { role: "user", content: message.text, timestamp: message.at };
			await this.#writeMessage(said);
		}
		if (after !== before) this.store.update({ orbLastMessage: after });
	}

	/**
	 * Records what the thread's agent says it cost, as the status reports it:
	 * the agent's own word, never a number Pim invented, and never counted
	 * against the thread's budget, which Pim can't hold to the agent's word.
	 * A client that can't say — or one whose `capabilities` say it reports no
	 * usage — leaves the cost null with a note that says so.
	 */
	async #orbCost(client: OrbClient, orb: OrbThread): Promise<void> {
		if (!client.capabilities().usage) return void this.store.update({ orbCostUsd: null, orbCostNote: `${client.id} reports no usage for its threads, so what this one cost isn't known.` });
		try {
			const usage = await client.usage(orb.threadId);
			this.store.update(usage?.usd === undefined ? { orbCostUsd: null, orbCostNote: "The agent's cloud reports no cost for this thread, so what it spent isn't known." } : { orbCostUsd: usage.usd, orbCostNote: null });
		} catch (error) {
			console.warn(JSON.stringify({ event: "pim.coding.orb_usage_failed", thread: this.store.thread()?.threadId, error: errorText(error).slice(0, 300) }));
		}
	}

	/** The client an agent-hosted thread runs through, or null when this Pim has none registered for it (./orb/). */
	async #orbClient(): Promise<OrbClient | null> {
		const thread = this.store.required();
		const factory = this.orbClients();
		if (factory === null) return null;
		return await factory({ space: thread.space, threadId: thread.threadId, providerId: thread.providerId });
	}

	/** Fails an agent-hosted thread, outside a turn's end: its turn is over with what it ran on, and it holds no slot to give back. */
	async #failOrb(reason: string, detail: string | null): Promise<void> {
		this.#orbUnknowns = 0;
		this.store.update({ currentOperation: null });
		await this.#fail(reason, detail, false);
	}

	/**
	 * Ends the thread on the agent's own cloud, as aborting or archiving it
	 * asks: the run is cancelled and the thread archived there, off the
	 * person's list. Idempotent — stopping one already stopped does nothing —
	 * and best effort: a client that can't stop, or a cloud that can't be
	 * reached, is logged and the thread still ends here.
	 */
	async #stopOrb(): Promise<void> {
		const thread = this.store.required();
		const orb = thread.orb;
		if (orb === null) return;
		const client = await this.#orbClient();
		if (client === null) return;
		if (!client.capabilities().stop) {
			this.store.recordEvent("orb.stop_unsupported", { provider: client.id, message: `${client.id} can't stop its threads, so this one is left as it is on the agent's site` });
			return;
		}
		try {
			await client.stop(orb.threadId);
			this.store.recordEvent("orb.stopped", { provider: client.id, orb: orb.threadId });
		} catch (error) {
			console.warn(JSON.stringify({ event: "pim.coding.orb_stop_failed", thread: thread.threadId, error: errorText(error).slice(0, 300) }));
		}
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
			await this.#fail("budget", spent, true);
			return;
		}
		const workspace = await this.#workspace();
		const session = this.store.harnessSession();
		const sessionId = session?.sessionId ?? crypto.randomUUID();
		const timeoutMs = wallClockMs(thread);
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
		this.#autosavedAt = Date.now();
		const fresh = this.store.required();
		const turn = {
			// A thread going on by itself in a new session, its last one lost with the workspace's volume, says what it was doing.
			prompt: session === null && operation.startsWith(RESUME_PREFIX) ? await this.#lostSessionPrompt(input.text) : input.text,
			sessionId,
			resume: session !== null,
			maxBudgetUsd: fresh.budgetUsd === null ? null : fresh.budgetUsd - fresh.spentUsd,
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
			.catch((error): RunResult => ({ ...NO_RUN, reason: error instanceof WorkspaceLostError ? "workspace_lost" : "harness_error", detail: errorText(error).slice(0, 500) }))
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
	#cliDeps(thread: CodingThreadRow, cli: CliHarness, workspace: Workspace, timeoutMs: number | null, auth: HarnessAuth): RunnerDeps {
		const scheduler = codingScheduler(this.env, thread.space);
		const grace = this.harnessGraceMs();
		return {
			harness: cli,
			workspace,
			auth,
			credentials: this.harnessCredentials(thread, cli, workspace),
			// Leased for a while at a time and renewed as the run goes on, so a thread that is gone can't keep it for long, however long a run lasts.
			lock: { acquire: () => scheduler.acquireHarness(cli.id, thread.threadId, HARNESS_LOCK_LEASE_MS), release: () => scheduler.releaseHarness(cli.id, thread.threadId) },
			journal: { save: (record) => this.store.saveHarnessRun(record), clear: () => this.store.saveHarnessRun(null) },
			onEvent: (event) => this.#onCliEvent(event),
			onTestRun: (run) => this.store.addTestRun(run),
			now: () => this.now(),
			graceMs: grace,
			stallMs: this.harnessStallMs(),
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
		const result = await recoverRun(this.#cliDeps(thread, cli, workspace, wallClockMs(thread), { mode: "signed_out" }), record);
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
		await this.#endTurn(operation, result);
		if (result.status !== "done" && result.reason === "stalled") await this.#continueStalled(operation);
	}

	/**
	 * A turn that stalled goes on once by itself, resuming the CLI's session; a turn begun that way that stalls
	 * too is left failed, for the person to continue.
	 */
	async #continueStalled(operation: string): Promise<void> {
		const thread = this.store.thread();
		if (!thread || thread.state !== "failed" || thread.stateReason !== "stalled" || operation.startsWith(AUTO_CONTINUE_PREFIX) || this.store.harnessSession() === null) return;
		this.ctx.storage.transactionSync(() => {
			this.store.enqueue(`${AUTO_CONTINUE_PREFIX}${operation}`, STALLED_CONTINUE_TEXT);
			this.#reopen();
		});
		this.#kick();
	}

	/** What a CLI's output means for the thread: messages into the transcript, retries and refusals into the log, text as it is written to whoever follows live. */
	async #onCliEvent(event: CliEvent): Promise<void> {
		switch (event.type) {
			case "session": {
				if (event.model) this.#recordResolved(this.store.required().harness, event.model);
				const known = this.store.harnessSession();
				if (known?.sessionId !== event.sessionId) this.store.setHarnessSession({ sessionId: event.sessionId, costUsd: 0, usage: null });
				return;
			}
			case "delta":
				this.#tellLive({ type: "partial", kind: event.kind, text: event.text });
				return;
			case "assistant": {
				// Parsers use the harness's name until the CLI reports a model; that is not an observed model.
				const harness = this.store.required().harness;
				const model = event.message.model;
				if (model && model !== "unknown" && model !== harness && !(harness === "claude-code" && model === "claude")) this.#recordResolved(event.message.provider, model);
				await this.#writeMessage(event.message);
				return;
			}
			case "tool_result":
				await this.#writeMessage({ ...event.message, details: { ...(event.message.details as Record<string, unknown> ?? {}), ...(event.exitCode === undefined ? {} : { exitCode: event.exitCode }) } });
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
		this.#activityWatch.output("thread", this.now());
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
		// While a new session is being brought up there is no workspace to commit in; the move committed what there was before it began.
		const checkpoint = this.#cycling ? null : await this.#checkpoint(operation).catch((error) => {
			console.warn(JSON.stringify({ event: "pim.coding.checkpoint_failed", operation, error: String(error) }));
			return null;
		});
		// The bundle kept of the work, so it outlives the workspace's volume.
		if (checkpoint) await this.#autosave();
		const thread = this.store.required();
		if (thread.currentOperation !== operation) return;
		const budget = thread.budgetStopped;
		// A CLI harness whose login is missing or expired waits for the person to connect it again, and goes on when continued.
		const login = result.status !== "done" && result.reason === "login_required";
		
		// Handle auto-resume for interrupted turns (restart), and for turns whose workspace went down (made again from its volume by now)
		const lost = result.status !== "done" && result.reason === "workspace_lost";
		// A turn stopped because its session ended is started again, unless the person stopped it too. Restarts that commit nothing new count: after MAX_SESSION_RESTARTS of them in a row the thread fails rather than go round again.
		const expired = this.#restarting === operation && this.#userStop !== operation;
		let loop = false;
		if (expired) {
			const sha = this.store.latestCheckpoint()?.sha ?? null;
			const prior = thread.session;
			const unproductive = sha !== null && sha !== prior.restartCheckpoint ? 0 : prior.unproductiveRestarts + 1;
			loop = unproductive > MAX_SESSION_RESTARTS;
			this.store.update({ session: { ...prior, restartCheckpoint: sha, unproductiveRestarts: unproductive } });
		}
		if (await this.#retryTransient(operation, thread, result, { budget, login, lost, expired })) return;
		const isInterrupted = result.reason === "interrupted" || lost || expired;
		const maxInterrupts = MAX_RESUMES;
		const shouldAutoResume = isInterrupted && (expired ? !loop : thread.consecutiveInterrupts < maxInterrupts) && thread.state !== "archived";
		
		if (shouldAutoResume) {
			// Increment the counter and enqueue a continuation turn
			const attempt = expired ? thread.consecutiveInterrupts : thread.consecutiveInterrupts + 1;
			const cli = cliHarness(thread.harness);
			const why = expired ? "session_expired" : lost ? "workspace_lost" : "interrupted_by_restart";
			const resumeText = expired
				? SESSION_RESUME_TEXT
				: lost
				? LOST_RESUME_TEXT
				: cli
					? `Your previous run was interrupted by a platform restart; check git status and the repo, then continue the task where you left off.`
					: CONTINUE_TEXT;
			
			// Record the interruption in the log and transcript
			this.ctx.storage.transactionSync(() => {
				this.store.update({ consecutiveInterrupts: attempt });
				this.store.recordEvent("thread.resumed", { attempt, reason: why });
			});
			
			// Add transcript notice
			void this.#write("thread.resumed", { attempt, max: maxInterrupts, reason: why });
			
			// For CLI harnesses, enqueue the resume text for the next turn (which will resume the session)
			// For Pi harness, we enqueue CONTINUE_TEXT which tells it to continue
			const resumeOperationId = `${RESUME_PREFIX}${attempt}-${operation}`;
			this.ctx.storage.transactionSync(() => {
				this.store.enqueue(resumeOperationId, resumeText);
				this.store.update({ currentOperation: null, state: "idle", stateReason: null, stateDetail: null });
			});
			
			// Report idle since we're continuing - but do NOT emit thread.turn_ended to supervisor
			await this.#report("idle");
			
			// Kick to start the continuation turn
			this.#kick();
			return;
		}
		
		// Reset counter on normal completion
		if (result.status === "done" && !budget && !login) {
			this.ctx.storage.transactionSync(() => {
				this.store.update({ consecutiveInterrupts: 0, session: { ...this.store.required().session, unproductiveRestarts: 0 } });
			});
		}
		
		// For interrupted turns that exceed the limit, mark as failed with the interruption detail
		const outcome: TurnOutcome = budget || loop ? "error" : result.status === "done" ? "completed" : result.reason === "aborted" ? "cancelled" : login ? "needs_approval" : isInterrupted && thread.consecutiveInterrupts >= maxInterrupts ? "error" : "error";
		const exhausted = !expired && isInterrupted && thread.consecutiveInterrupts >= maxInterrupts;
		const reason = budget 
			? "budget"
			: loop
			? "session_restarts_exhausted"
			: outcome === "error" || login 
				? (exhausted && !lost
					? "interrupted_too_many_times"
					: (result.reason ?? "error"))
				: null;
		const state: CodingThreadState = outcome === "error" ? "failed" : login ? "waiting_input" : "idle";
		const said = await this.#lastSaid().catch(() => null);
		// pi's result for a model error carries no detail: the provider's words are in the failed response it recorded, or, when it said nothing, the provider and model are what is known.
		if (reason === "model_error" && !result.detail?.trim()) result = { ...result, detail: (await this.#lastModelError().catch(() => null)) ?? describeModelFailure("", `${thread.profile.providerId} ${thread.profile.model} ended the turn with an error and no message`) };
		const detail = loop ? `The sandbox's session reached its time limit ${MAX_SESSION_RESTARTS + 1} times in a row without the thread committing anything new, so it stopped; continue it, or ask for less per turn` : outcome === "completed" ? null : exhausted && lost ? lostDetail(result.detail) : (result.detail ?? thread.stateDetail)?.slice(0, DETAIL_MAX);
		const stop = budget ? { budgetUsd: thread.budgetUsd ?? 0, spentUsd: thread.spentUsd } : null;
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
			...(cliHarness(thread.harness)?.reportsCost === false ? { unmetered: true as const } : {}),
			...(said ? { said } : {}),
			...(detail ? { detail } : {}),
			at: this.now(),
		};
		this.ctx.storage.transactionSync(() => {
			this.store.update({ currentOperation: null, state, stateReason: reason, stateDetail: loop ? detail : outcome === "completed" ? null : exhausted && lost ? (detail ?? null) : (result.detail ?? null) });
			this.store.recordEvent(event.type, event);
			if (stop) this.store.recordEvent("app.budget_stop", stop);
		});
		if (stop) await this.#write("app.budget_stop", stop);
		if (state === "failed") {
			// A stalled turn that is about to be continued once by itself keeps its session open.
			if (!(reason === "stalled" && !operation.startsWith(AUTO_CONTINUE_PREFIX))) await this.#archiveHarnessSession(thread);
			await this.#giveBack({ keepVolume: true });
		} else if (state === "waiting_input") await this.#report("waiting");
		else if (this.store.inboxSize() === 0) await this.#report("idle");
		// Last, so whoever hears of the turn's end finds the slot already given back or idle.
		await this.#emit(event);
	}

	/**
	 * A turn that failed for a transient error, such as a model provider's 5xx
	 * or a dropped connection, is retried once after a backoff, in the same
	 * workspace, so its committed and uncommitted work is kept. The retry is a
	 * turn like any other, so its spend counts once, as it is made, and the
	 * budget is checked before it starts. A rate limit is shared by every
	 * thread on the account, so it outlasts one backoff: a turn it stopped is
	 * retried up to `RATE_LIMIT_RETRIES` times in a row, each after a longer
	 * wait, and never less than the `retry-after` the provider asked for; the
	 * retries are counted by the `retry-` prefixes on the operation's id, so a
	 * turn that succeeds starts the count over. A turn begun as a retry that
	 * fails too, one the person stopped, and one that failed for anything else
	 * is left as it ended. The original error is recorded as `thread.retrying`,
	 * with which retry it waits for.
	 */
	async #retryTransient(operation: string, thread: CodingThreadRow, result: TurnResult, skip: { budget: boolean; login: boolean; lost: boolean; expired: boolean }): Promise<boolean> {
		if (result.status === "done" || skip.budget || skip.login || skip.lost || skip.expired || thread.state === "archived") return false;
		if (this.#userStop === operation || this.#cycling) return false;
		const detail = result.detail ?? (result.reason === "model_error" ? this.#modelError : null) ?? undefined;
		if (!isTransient(result.reason, detail)) return false;
		if (this.#budgetSpent(thread)) return false;
		const error = (detail ?? result.reason ?? "error").slice(0, 500);
		const rateLimited = RATE_LIMIT_ERROR.test(error);
		const attempt = retryCount(operation) + 1;
		if (attempt > (rateLimited ? RATE_LIMIT_RETRIES : 1)) return false;
		const notBefore = Date.now() + (rateLimited ? this.rateLimitRetryDelayMs(attempt, retryAfterMs(error)) : this.retryDelayMs());
		this.ctx.storage.transactionSync(() => {
			this.store.enqueue(`${RETRY_PREFIX}${operation}`, CONTINUE_TEXT, { notBefore });
			this.store.update({ currentOperation: null, state: "idle", stateReason: "retrying", stateDetail: error });
			this.store.recordEvent("thread.retrying", { operationId: operation, reason: result.reason ?? "error", error, retryAt: notBefore, attempt });
		});
		console.warn(JSON.stringify({ event: "pim.coding.turn_retry", thread: thread.threadId, reason: result.reason, error: error.slice(0, 300) }));
		await this.#report("idle");
		await this.#schedule(notBefore);
		return true;
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

	/** What the last failed model response of pi's said, as `explainFailures` wrote it; null when none is recorded. */
	async #lastModelError(): Promise<string | null> {
		const entries = await this.harness.messages();
		for (let index = entries.length - 1; index >= 0; index--) {
			const message = entries[index]!.model?.[0];
			if (message?.role === "assistant" && message.stopReason === "error") return message.errorMessage?.trim() ? message.errorMessage.slice(0, DETAIL_MAX) : null;
		}
		return null;
	}

	/** Stops the turn under way: kills its commands, aborts pi's run and waits for the turn to end. */
	async #stopTurn(why: "person" | "session" = "person"): Promise<void> {
		const thread = this.store.required();
		const operation = thread.currentOperation;
		if (why === "person") this.#userStop = operation;
		// A turn on the agent's cloud ends by ending the whole thread there; nothing of it runs here to stop.
		if (thread.providerKind === "agent-hosted") {
			if (operation !== null) {
				await this.#stopOrb();
				await this.#endTurn(operation, { status: "unanswered", reason: "aborted" });
			}
			return;
		}
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

	/** An open pool is waited for, or walked past before first placement, rather than failing its thread. */
	async #waitForUnhealthyPool(thread: CodingThreadRow): Promise<boolean> {
		if (thread.state === "archived" || (await codingScheduler(this.env, thread.space).unhealthyPools([thread.poolId])).length === 0) return false;
		await codingScheduler(this.env, thread.space).release(thread.threadId);
		this.store.update({ slot: "none", slotSince: null });
		await this.#requestSlot();
		if (this.store.required().slot === "held") this.#kick();
		return true;
	}

	async #provisioningFailed(error: unknown): Promise<void> {
		const thread = this.store.required();
		const lowDisk = error instanceof ComposeManagerError && error.code === "low_disk";
		if (error instanceof WorkspaceCapacityError || lowDisk) {
			// The backend is full though the scheduler gave a slot: a thread with no workspace yet makes it on another provider with room, at once; otherwise it tries again at the next heartbeat. Low disk also holds the provider's queue until the manager's health says there is room.
			if (lowDisk) {
				await codingScheduler(this.env, thread.space)
					.onManagerError("low_disk", thread.poolId)
					.catch((failure) => console.warn(JSON.stringify({ event: "pim.coding.capacity_failed", thread: thread.threadId, error: String(failure) })));
			}
			if (await this.#overflow(thread)) {
				this.#kick();
				return;
			}
			if (await this.#waitForUnhealthyPool(thread)) return;
			// Not rewritten while it holds, so the wait counts toward the thread being stuck.
			const waiting = lowDisk ? "low_disk" : "workspace_capacity";
			if (thread.stateReason !== waiting) this.store.update({ stateReason: waiting });
			await this.#schedule(Date.now() + HEARTBEAT_MS);
			return;
		}
		if (await this.#waitForUnhealthyPool(thread)) return;
		// A workspace found down is made again from its volume; while a thread goes on after one, a backend it can't reach is waited for, longer each time. A few times in a row at most.
		const resuming = this.store.nextInput()?.operationId.startsWith(RESUME_PREFIX) === true;
		if (thread.state !== "archived" && (error instanceof WorkspaceLostError || (resuming && error instanceof ComposeManagerError && error.status >= 500))) {
			const attempt = thread.consecutiveInterrupts + 1;
			console.warn(JSON.stringify({ event: "pim.coding.workspace_retry", thread: thread.threadId, attempt, error: errorText(error).slice(0, 300) }));
			if (attempt > MAX_RESUMES) return this.#failLost(error);
			this.ctx.storage.transactionSync(() => {
				this.store.update({ consecutiveInterrupts: attempt, stateReason: "workspace_lost", stateDetail: errorText(error).slice(0, 500) });
				this.store.recordEvent("workspace.retry", { attempt, error: errorText(error).slice(0, 300) });
			});
			if (error instanceof WorkspaceLostError) this.#kick();
			else await this.#schedule(Date.now() + LOST_RETRY_MS * 2 ** (attempt - 1));
			return;
		}
		console.warn(JSON.stringify({ event: "pim.coding.provisioning_failed", thread: thread.threadId, error: String(error) }));
		if (thread.state === "archived") return;
		const aborted = error instanceof Error && / was stopped:/.test(error.message);
		// A transient failure to ready the workspace or harness, such as the manager being briefly down, is tried again once after a backoff, the input kept.
		const next = this.store.nextInput();
		if (next && !next.retried && !aborted && !(error instanceof NoWorkspaceBackendError || error instanceof ComputeQuotaError) && isTransient("workspace", errorText(error))) {
			const notBefore = Date.now() + this.retryDelayMs();
			this.ctx.storage.transactionSync(() => {
				this.store.holdForRetry(next.seq, notBefore);
				this.store.update({ stateReason: "retrying", stateDetail: errorText(error).slice(0, 500) });
				this.store.recordEvent("thread.retrying", { operationId: next.operationId, reason: "workspace", error: errorText(error).slice(0, 500), retryAt: notBefore });
			});
			await this.#schedule(notBefore);
			return;
		}
		this.ctx.storage.sql.exec("DELETE FROM coding_inbox");
		if (aborted) {
			this.store.update({ state: "idle", stateReason: "aborted" });
			return;
		}
		if (error instanceof NoWorkspaceBackendError || error instanceof ComputeQuotaError) await this.#fail(error.code, error.message, true);
		else await this.#fail("workspace", error instanceof Error ? error.message : String(error), true);
	}

	/**
	 * Fails the thread outside a turn's end, such as for a workspace that
	 * couldn't be made, and tells whoever hears of the thread as a failed turn
	 * does. The event's key is of its own, so each failure is heard of once.
	 */
	async #fail(reason: string, detail: string | null, giveBack: boolean): Promise<void> {
		const thread = this.store.required();
		const clipped = detail ? detail.slice(0, DETAIL_MAX) : null;
		const now = this.now();
		const event: TurnEndedEvent = {
			type: "thread.turn_ended",
			threadId: thread.threadId,
			space: thread.space,
			operationId: `failed-${reason}-${now}`,
			outcome: "error",
			reason,
			...(clipped ? { detail: clipped } : {}),
			state: "failed",
			spentUsd: thread.spentUsd,
			budgetUsd: thread.budgetUsd,
			at: now,
		};
		this.ctx.storage.transactionSync(() => {
			this.store.update({ state: "failed", stateReason: reason, stateDetail: clipped });
			this.store.recordEvent(event.type, event);
		});
		if (giveBack) {
			await this.#archiveHarnessSession(thread);
			await this.#giveBack({ keepVolume: true });
		}
		await this.#emit(event);
	}

	/** A thread that has sat provisioning, unchanged, for too long fails as stuck. One in a turn, waiting for the person or queued is left be: the scheduler expires a queued one itself. */
	async #failIfStuck(): Promise<void> {
		const thread = this.store.thread();
		if (!thread || thread.state !== "provisioning" || thread.currentOperation) return;
		const waited = this.now() - thread.updatedAt;
		if (waited < this.stuckMs()) return;
		await this.#fail("stuck", `The thread was provisioning for ${Math.round(waited / 60_000)} minutes without moving on`, true);
	}

	/**
	 * Gives up on a workspace that went down again each time it was made
	 * again while being readied: the input waiting for it is dropped and the
	 * thread fails as any failure outside a turn's end does, so whoever
	 * started it hears of it once, with what went wrong last.
	 */
	async #failLost(error: unknown): Promise<void> {
		this.ctx.storage.sql.exec("DELETE FROM coding_inbox");
		await this.#fail("workspace_lost", lostDetail(errorText(error)), true);
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
			if (thread && thread.budgetUsd !== null && thread.spentUsd >= thread.budgetUsd) {
				this.store.update({ budgetStopped: true });
				const message = failedResponse(model, `${BUDGET_MESSAGE}: spent $${thread.spentUsd.toFixed(4)} of $${thread.budgetUsd}`, this.now());
				const events = createAssistantMessageEventStream();
				events.push({ type: "error", reason: "error", error: message });
				events.end(message);
				return events;
			}
			this.#recordResolved(model.provider, model.id);
			// A failure says what the provider said, so the turn's detail is never empty.
			const events = explainFailures(stream(model, context, { ...(options as object), maxTokens: codingMaxTokens(model) }), model);
			events.result().then(
				(message) => this.#recordCall(model, message),
				(error) => console.warn(JSON.stringify({ event: "pim.coding.model_error", provider: model.provider, model: model.id, error: String(error).slice(0, 500) })),
			);
			return events;
		});
	}

	/** Records the identity at execution, not just the profile requested at start. */
	#recordResolved(provider: string, model: string, source?: ResolvedProfile["source"]): void {
		const previous = this.store.required().resolvedProfile;
		const resolved: ResolvedProfile = { provider, model, source: source === undefined ? previous?.source ?? null : source };
		if (previous?.provider === provider && previous.model === model && previous.source === resolved.source) return;
		this.ctx.storage.transactionSync(() => {
			this.store.update({ resolvedProfile: resolved });
			this.store.recordEvent("model.resolved", resolved);
		});
	}

	/** What the model's last failed call said, which pi's `model_error` turn end doesn't carry. */
	#modelError: string | null = null;

	#recordCall(model: Model<Api>, message: AssistantMessage): void {
		this.#modelError = message.stopReason === "error" ? (message.errorMessage ?? null) : null;
		const usage = { input: message.usage?.input ?? 0, output: message.usage?.output ?? 0, cacheRead: message.usage?.cacheRead ?? 0, cacheWrite: message.usage?.cacheWrite ?? 0 };
		this.store.recordModelCall(model.provider, model.id, usage, costOf(model, usage));
	}

	#repositorySection(): string | undefined {
		const thread = this.store.thread();
		if (!thread) return undefined;
		const brief = environmentBrief(thread.environment);
		return `The repository ${thread.repoUrl} is checked out at ${REPO_DIR}, on the branch ${thread.branch} made from ${thread.baseRef}. Work in that directory.${brief ? `\n\n${brief}` : ""}`;
	}

	/** The thread's workspace, made and cloned on first use, with its commands killed when the thread is stopped. A new one starts from `restoreFrom`, the person's environment snapshot, when given. */
	async #workspace(options: { restoreFrom?: EnvironmentSnapshot } = {}): Promise<Workspace> {
		// A new session is being brought up: the old workspace is on its way out. A stop of the thread ends the wait.
		const stopped = this.#kill.signal;
		while (this.#cycling) {
			await Promise.race([
				this.#cycling,
				new Promise<never>((_, reject) => {
					if (stopped.aborted) reject(stopped.reason);
					else stopped.addEventListener("abort", () => reject(stopped.reason), { once: true });
				}),
			]);
		}
		this.#opening ??= this.#openWorkspace(options).finally(() => {
			this.#opening = null;
		});
		return this.#opening;
	}

	/** Only provider operations can trip the pool breaker; refusals and caller errors cannot. */
	async #poolAttempt<T>(thread: CodingThreadRow, work: () => Promise<T>): Promise<T> {
		try {
			return await work();
		} catch (error) {
			const refused = error instanceof WorkspaceCapacityError || error instanceof WorkspaceLimitError || error instanceof WorkspaceUnsupportedError || error instanceof WorkspacePathError || error instanceof WorkspaceFileError ||
				(error instanceof ComposeManagerError && (error.code === "low_disk" || (error.status >= 400 && error.status < 500 && error.status !== 408)));
			await codingScheduler(this.env, thread.space).workspaceResult(thread.threadId, refused ? "ignored" : "failure");
			throw error;
		}
	}

	async #openWorkspace(options: { restoreFrom?: EnvironmentSnapshot }): Promise<Workspace> {
		const thread = this.store.required();
		if (thread.slot !== "held") throw new Error("The coding thread holds no workspace slot now");
		const provider = this.workspaceProviders().get(thread.providerId);
		if (this.#open && thread.workspaceRef?.id === this.#open.id) return this.#open.workspace;
		let workspace = thread.workspaceRef ? await this.#poolAttempt(thread, () => provider.get(thread.workspaceRef!)) : null;
		// A restart between the manager making the container and this thread saving its ref, or the manager's own restart, leaves the session running: it is taken up again, and only a session that is not there is provisioned.
		if (!workspace && !thread.workspaceRef) {
			const ref = { id: thread.threadId, providerId: thread.providerId, sessionId: thread.threadId };
			workspace = await this.#poolAttempt(thread, () => provider.get(ref));
			if (workspace) this.store.update({ workspaceRef: ref, placed: true });
		}
		const started = workspace ? null : performance.now();
		// A workspace the provider makes or resumes costs the deployment compute: the space's quota is checked before it does, and the time it runs is counted from then.
		let counted = false;
		if (!workspace) {
			const wallClockMin = await this.#reserveCompute(thread, true);
			counted = true;
			// Creating twice for one session is one workspace, so a restart mid-create makes no second one.
			let ref: WorkspaceRef;
			try {
				ref = await this.#poolAttempt(thread, () => this.#createWorkspace(provider, thread, options.restoreFrom, wallClockMin));
			} catch (error) {
				await this.#releaseCompute("failed");
				throw error;
			}
			if (this.store.required().slot !== "held") {
				// Archived or released while it was made: it goes at once.
				await provider.destroy(ref, { keepVolume: true });
				await this.#releaseCompute("suspend");
				throw new Error("The coding thread gave its workspace slot up");
			}
			// From here on the thread runs on this provider, where its files and environment are.
			this.store.update({ workspaceRef: ref, placed: true });
			workspace = await provider.get(ref);
			if (!workspace) throw new Error("The workspace provider lost the workspace it just made");
		} else if ((await this.#poolAttempt(thread, () => workspace!.status())).state === "stopped") {
			await this.#reserveCompute(thread, true);
			counted = true;
			try {
				await this.#poolAttempt(thread, () => workspace!.start());
			} catch (error) {
				await this.#releaseCompute("failed");
				throw error;
			}
		}
		await codingScheduler(this.env, thread.space).workspaceResult(thread.threadId, "success");
		// A workspace found running, such as after a restart, is counted as it is, with no check: it runs already.
		if (!counted) await this.#reserveCompute(thread, false);
		// A workspace made now starts a session; one found with none recorded (made before they were) is taken to have just begun one.
		if (started !== null || this.store.required().session.startedAt === null) this.store.update({ session: { ...this.store.required().session, startedAt: this.now() } });
		const killable = this.#killable(workspace, this.store.required().workspaceRef!);
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
	async #createWorkspace(provider: WorkspaceProvider, thread: CodingThreadRow, restoreFrom?: EnvironmentSnapshot, wallClockMin: number | null = null): Promise<WorkspaceRef> {
		const spec = this.#spec(thread, provider, wallClockMin);
		const owner = spec.environment;
		let snapshot = restoreFrom;
		// The newest snapshot of the repository is a guess only where it can be this pool's: a provider's first pool, which also holds what was made before pools.
		if (owner && !snapshot && thread.baseSha === null && thread.environment.preparedAt === null && this.#snapshotScope(thread).legacy) {
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

	#spec(thread: CodingThreadRow, provider: WorkspaceProvider, wallClockMin: number | null = null): WorkspaceSpec {
		// The quota's limit on a session's minutes caps the thread's own, which the provider enforces.
		const wallClock = [thread.limits.wallClockMin, wallClockMin].filter((minutes) => minutes !== null);
		return {
			sessionId: thread.threadId,
			image: this.workspaceImage(),
			repo: { url: thread.repoUrl, ref: thread.baseRef, branch: thread.branch },
			limits: { ...thread.limits, wallClockMin: wallClock.length === 0 ? null : Math.min(...wallClock) },
			// The allowlist as a policy: the credentials the proxy injects join it once a workspace has them (`#inject`).
			egress: egressPolicy({ allow: [...this.egressAllow(), ...(cliHarness(thread.harness)?.egress ?? [])], inject: [...this.#injections.values()] }),
			gitAuth: { mode: "none" },
			...(provider.capabilities.environmentSnapshots ? { environment: environmentOwner(thread) } : {}),
		};
	}

	/**
	 * What a git command that reaches Pim's git broker needs: the broker's URL and a token for this thread, and the
	 * environment to run with. Where the provider injects credentials, the token goes to its egress proxy and the
	 * environment is empty. Otherwise it is an HTTP header for that command alone: git keeps no copy of it in the repository.
	 */
	async #brokerAccess(thread: CodingThreadRow): Promise<{ url: string; token: string; auth: Record<string, string> }> {
		const { url, token } = await this.cloneSource(thread);
		const placed = placeSecret(this.workspaceProviders().get(thread.providerId), gitBrokerInjection(url, `/api${GIT_BROKER_PATH}`, token), token);
		if (placed.rule) await this.#inject("git", placed.rule);
		const auth: Record<string, string> = placed.rule ? {} : { GIT_CONFIG_COUNT: "1", GIT_CONFIG_KEY_0: "http.extraHeader", GIT_CONFIG_VALUE_0: `Authorization: Bearer ${token}` };
		return { url, token, auth };
	}

	/** Refreshes agent git access before a turn, after preparing the environment snapshot. */
	async #prepareWorkspaceGit(workspace: Workspace, thread: CodingThreadRow): Promise<void> {
		if (this.workspaceProviders().get(thread.providerId).capabilities.egressInjection) {
			await this.#brokerAccess(thread);
			return;
		}
		const { url, token } = await this.cloneSource(thread, true);
		const encoder = new TextEncoder();
		await workspace.writeFile(`${WORKSPACE_GIT_AUTH_DIR}/credential.json`, encoder.encode(JSON.stringify({ url, token })), 0o600);
		await workspace.writeFile(`${WORKSPACE_GIT_AUTH_DIR}/helper.mjs`, encoder.encode(workspaceCredentialHelper), 0o700);
		await git(workspace, ["config", "--global", `credential.${url}.useHttpPath`, "true"]);
		// Reset inherited helpers so none can store this token elsewhere.
		await git(workspace, ["config", "--global", "--replace-all", `credential.${url}.helper`, ""]);
		await git(workspace, ["config", "--global", "--add", `credential.${url}.helper`, `!node ${WORKSPACE_GIT_AUTH_DIR}/helper.mjs`]);
	}

	/** Gives the workspace's egress proxy a credential to add to requests, with the ones it already has. The workspace itself never holds it. */
	async #inject(purpose: string, rule: EgressInjection): Promise<void> {
		const thread = this.store.required();
		if (!thread.workspaceRef) throw new Error("The thread has no workspace");
		const provider = this.workspaceProviders().get(thread.providerId);
		this.#injections.set(purpose, rule);
		await provider.setEgress(thread.workspaceRef, this.#spec(thread, provider).egress);
	}

	/**
	 * Clones the repository and checks out the thread's branch, unless the
	 * workspace (or its kept volume) has it already. Until the thread first
	 * checked out (`baseSha` is null), a workspace with a clone, such as one
	 * restored from another thread's snapshot, fetches and checks out the
	 * thread's branch over it. A thread that had checked out before and finds
	 * no clone lost its workspace's volume: it starts again from its base and
	 * the work it last saved (`#restoreWork`).
	 */
	async #ensureRepository(workspace: Workspace, thread: CodingThreadRow): Promise<void> {
		// Only a missing file means there is no clone: a workspace that doesn't answer throws.
		const cloned = await workspace.stat(`${REPO_DIR}/.git`).then(
			() => true,
			(error) => {
				if (error instanceof WorkspaceFileError) return false;
				throw error;
			},
		);
		const base = this.store.required().baseSha;
		const { url, token, auth } = await this.#brokerAccess(thread);
		if (cloned && base !== null) return;
		const delays = this.gitRetryDelaysMs();
		if (!cloned) {
			await gitWithRetries(workspace, ["clone", "--no-checkout", url, REPO_DIR], { cwd: WORKSPACE_ROOT, timeoutMs: CLONE_TIMEOUT_MS, env: auth, secret: token }, delays, () => workspace.remove(REPO_DIR).catch(() => undefined));
		}
		// A snapshot's clone may come from this Pim at another address.
		else await git(workspace, ["remote", "set-url", "origin", url]);
		const fetchOptions = { timeoutMs: CLONE_TIMEOUT_MS, env: auth, secret: token };
		try {
			await gitWithRetries(workspace, ["fetch", "origin", thread.baseRef], fetchOptions, delays);
		} catch (error) {
			// A repository whose default branch isn't "main" (the ref nobody chose): use the remote's default branch.
			if (thread.baseRef !== "main") throw error;
			await gitWithRetries(workspace, ["fetch", "origin", "HEAD"], fetchOptions, delays);
		}
		if (!cloned && base !== null) return this.#restoreWork(workspace, thread, base);
		await git(workspace, ["checkout", "-f", "-B", thread.branch, "FETCH_HEAD"]);
		const sha = (await git(workspace, ["rev-parse", "HEAD"])).trim();
		if (this.store.required().baseSha === null) this.store.update({ baseSha: sha });
	}

	/**
	 * Puts the thread's work back in a new clone, after its workspace's volume
	 * was lost: the branch as it was when last autosaved, its checkpoints
	 * included, with the changes not committed then left uncommitted, from the
	 * bundle this object keeps (`#autosave`); without one, the thread's base.
	 * A CLI's session went with the volume, unless the CLI keeps its sessions
	 * elsewhere, so the next turn starts a new one.
	 */
	async #restoreWork(workspace: Workspace, thread: CodingThreadRow, base: string): Promise<void> {
		const saved = this.store.autosave();
		let from: "autosave" | "base" = "base";
		if (saved?.bundle) {
			const file = `${WORKSPACE_ROOT}/.pim-autosave.bundle`;
			try {
				await workspace.writeFile(file, saved.bundle);
				await git(workspace, ["fetch", file, `+${AUTOSAVE_REF}:${AUTOSAVE_REF}`]);
				await git(workspace, ["checkout", "-f", "-B", thread.branch, saved.commit]);
				await git(workspace, ["reset", "--mixed", saved.head]);
				from = "autosave";
			} catch (error) {
				if (error instanceof WorkspaceLostError) throw error;
				console.warn(JSON.stringify({ event: "pim.coding.autosave_restore_failed", thread: thread.threadId, error: errorText(error).slice(0, 300) }));
			} finally {
				await workspace.remove(file).catch(() => {});
			}
		}
		if (from === "base") await git(workspace, ["checkout", "-f", "-B", thread.branch, base]);
		const cli = cliHarness(thread.harness);
		this.ctx.storage.transactionSync(() => {
			if (cli && !cli.remoteSessions) this.store.setHarnessSession(null);
			this.store.recordEvent("workspace.restored", { from, ...(from === "autosave" && saved ? { savedAt: saved.savedAt } : {}) });
		});
		console.warn(JSON.stringify({ event: "pim.coding.workspace_restored", thread: thread.threadId, from }));
	}

	/**
	 * Readies the repository's environment in the thread's workspace, which
	 * has the repository checked out: before the thread's first turn, and
	 * again when a rebuild was asked for. That is before any secret has been
	 * in the workspace (a harness's login goes in only for a turn and comes
	 * out after it; the git broker's token and the model gateway's are only
	 * ever in a command's environment), so what is snapshotted holds none.
	 *
	 * The repository's files say what it needs (./repo-environment.ts): the
	 * toolchains and dependencies to provision, and the commands it checks
	 * itself with, which the thread keeps whatever happens next. With
	 * something to provision or a setup script (the person's setting for
	 * the repository, else its `.pim/env.json` or `.pim/setup.sh`) the environment's key is
	 * computed. A workspace
	 * restored from that key's snapshot is ready. Otherwise one of the
	 * person's snapshots with the key is restored into a new workspace, or,
	 * when there is none, the thread takes the person's lock on building it,
	 * runs the script and keeps a snapshot; while another of their threads
	 * holds the lock it waits for that one's snapshot, a bounded time.
	 * Nothing here fails the thread: a failure is recorded and the thread
	 * goes on in its workspace as it is. Only a stop is thrown. A backend
	 * that keeps no environments says so on the environment instead, and
	 * the thread works in a plain workspace.
	 */
	async #prepareEnvironment(): Promise<void> {
		const thread = this.store.required();
		const current = thread.environment;
		const provider = this.workspaceProviders().get(thread.providerId);
		if (!provider.capabilities.environmentSnapshots) {
			// Distinct from "none", which means the repository declares no setup: here the backend itself can't keep environments.
			if (current.state !== "unsupported") {
				this.#setEnvironment({ state: "unsupported", reason: `The workspace backend ${provider.id} keeps no environments`, key: null, source: null, preparedAt: this.now(), error: undefined });
			}
			return;
		}
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
		await this.#refreshPools(thread.space);
		const scope = this.#snapshotScope(thread);
		let workspace = await this.#workspace();
		// A rebuild must not snapshot the previous turn's fetch grant, on any provider.
		await workspace.remove(WORKSPACE_GIT_AUTH_DIR).catch((error: unknown) => {
			if (!(error instanceof WorkspaceFileError)) throw error;
		});
		let setup: Setup | null;
		let plan: ProvisionStep[];
		let key: string;
		try {
			const profile = await detectRepository(workspaceFiles(workspace, REPO_DIR));
			if (signal.aborted) throw new Error(ENVIRONMENT_STOPPED);
			plan = provisionPlan(profile);
			const envConfig = await readEnvConfig(workspace, REPO_DIR);
			const config = envConfig.config;
			const notes = [...profile.notes, ...envConfig.notes];
			const cacheKeys = await cacheKeyHashes(workspace, REPO_DIR, config?.cacheKeys ?? []);
			for (const pattern of cacheKeys.missing) notes.push(`.pim/env.json: the cache key ${JSON.stringify(pattern)} matches no file and is left out`);
			if (config === null && envConfig.error === undefined) {
				if (profile.toolchains.length > 0 || profile.dependencies.length > 0) {
					const toolchains = profile.toolchains.map((each) => (each.version === null ? each.tool : `${each.tool} ${each.version}`)).join(", ") || "no toolchains";
					const installs = profile.dependencies.map((each) => each.command).join(", ");
					notes.push(`detected: ${toolchains}${installs ? `, installing with ${installs}` : ""}`);
					this.store.recordEvent("environment.detected", { toolchains: profile.toolchains.map((each) => each.tool).join(","), dependencies: profile.dependencies.map((each) => each.tool).join(",") });
				}
			}
			const check = config?.check ?? [];
			this.#setEnvironment({
				...pendingItems(profile),
				testCommands: check.length > 0 ? check.map((command) => ({ command, source: "pim" as const, from: ".pim/env.json" })) : profile.testCommands,
				services: config?.services ?? [],
				cachePaths: config?.cachePaths ?? [],
				notes,
			});
			setup = await this.#setupScript(workspace, thread, owner, config);
			if (setup === null && plan.length === 0) {
				this.#setEnvironment({ state: "none", key: null, source: null, rebuildRequested: false, preparedAt: this.now(), error: undefined });
				return;
			}
			key = await environmentKey({ ...owner, provision: plan.map((step) => step.script), setupScript: setup?.content ?? null, setupSource: setup?.source ?? null, unpinned: await unpinnedKeyParts(workspace, profile.toolchains, this.now(), REPO_DIR), lockfiles: { ...(await lockfileHashes(workspace, REPO_DIR)), ...cacheKeys.hashes }, image: this.workspaceImage(), ...(scope.legacy ? {} : { pool: scope.pool }) });
		} catch (error) {
			if (signal.aborted) throw new Error(ENVIRONMENT_STOPPED);
			this.#environmentFailed(null, environmentError("The environment's setup script couldn't be read", errorText(error)));
			return;
		}
		const source = setup?.source ?? null;
		if (!rebuild && current.state === "restoring" && current.restoredFromKey === key) {
			this.#restored(key, source, scope.pool);
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
					this.#restored(key, source, scope.pool);
					return;
				}
				// The restore failed and the workspace is a plain clone: build it here instead.
				restore = false;
			}
			// An environment whose snapshot wasn't worth keeping is set up by each thread, so there is nothing to wait for.
			if (!rebuild && (await scheduler.environmentSnapshotSkipped(key))) {
				await this.#buildEnvironment(provider, workspace, owner, key, setup, plan, { snapshot: false, ...scope });
				return;
			}
			if (await scheduler.acquireEnvironmentBuild(key, thread.threadId, BUILD_LOCK_MS)) {
				try {
					await this.#buildEnvironment(provider, workspace, owner, key, setup, plan, { snapshot: true, ...scope });
				} finally {
					await scheduler.releaseEnvironmentBuild(key, thread.threadId).catch(() => {});
				}
				return;
			}
			// Another of the person's threads is building it: wait for its snapshot.
			const waiting = this.store.required().environment;
			if (waiting.state !== "building" || waiting.key !== key) this.#setEnvironment({ state: "building", pool: scope.pool, key, source, error: undefined });
			if (performance.now() > deadline) {
				this.#environmentFailed(key, "Another of your coding threads was still preparing this environment");
				return;
			}
			await sleep(this.environmentPollMs(), signal);
			if (signal.aborted) throw new Error(ENVIRONMENT_STOPPED);
			restore = !rebuild;
		}
	}

	/** A workspace restored from the snapshot with the environment's key: what the snapshot's build installed came with it. */
	#restored(key: string, source: Setup["source"] | null, pool: string): void {
		const env = this.store.required().environment;
		const cached = <T extends { status: string }>(item: T): T => (item.status === "pending" ? { ...item, status: "cached" } : item);
		this.#setEnvironment({ state: "cached", pool, key, source, readyFrom: "snapshot", preparedAt: this.now(), error: undefined, toolchains: env.toolchains.map(cached), dependencies: env.dependencies.map(cached) });
		this.store.recordEvent("environment.restored", { key });
	}

	/**
	 * Provisions the toolchains and dependencies in the workspace and runs
	 * the setup script, then, with `o.snapshot`, takes a snapshot and keeps
	 * it if it is worth keeping (`snapshotWorthKeeping`), recording the
	 * finding for the person's next threads. Its size is known only once it
	 * is taken, so one that isn't is deleted again. A provisioning step that
	 * fails is recorded and the rest go on; no snapshot is taken then, so
	 * the next thread tries again. A failure is recorded, and the thread
	 * goes on.
	 */
	async #buildEnvironment(provider: WorkspaceProvider, workspace: Workspace, owner: EnvironmentOwner, key: string, setup: Setup | null, plan: readonly ProvisionStep[], o: { snapshot: boolean; pool: string; shared: boolean }): Promise<void> {
		this.#setEnvironment({ state: "building", pool: o.pool, key, source: setup?.source ?? null, error: undefined });
		const started = performance.now();
		const provisionFailures = await this.#provision(workspace, plan);
		const result = setup ? await runSetup(workspace, setup.script, { cwd: REPO_DIR }) : ({ outcome: "ok" } as const);
		const setupMs = Math.round(performance.now() - started);
		if (result.outcome === "stopped") throw new Error(ENVIRONMENT_STOPPED);
		if (result.outcome === "failed") {
			this.#setEnvironment({ setupMs });
			this.#environmentFailed(key, result.error);
			return;
		}
		const ready = { state: "cached", pool: o.pool, key, setupMs, readyFrom: "setup", rebuildRequested: false, error: undefined } as const;
		if (!o.snapshot || provisionFailures > 0) {
			this.#setEnvironment({ ...ready, builtAt: null, snapshotMs: null, snapshotBytes: null, snapshotKept: false, preparedAt: this.now() });
			this.store.recordEvent("environment.built", { key, setupMs, snapshotKept: false, ...(provisionFailures > 0 ? { provisionFailures } : {}) });
			return;
		}
		const snapshotStarted = performance.now();
		try {
			const thread = this.store.required();
			if (!thread.workspaceRef) throw new Error("The coding thread has no workspace");
			const snapshot = await provider.snapshotEnvironment(thread.workspaceRef, { ...owner, key });
			const snapshotMs = Math.round(performance.now() - snapshotStarted);
			const snapshotBytes = snapshot.size ?? null;
			const worth = snapshotWorthKeeping(setupMs, snapshotBytes, provider.capabilities.restoreMBps);
			let kept = worth;
			if (!worth) {
				// The person's other snapshots of the repository are older environments of it, which only start new threads as a guess (`#createWorkspace`) to be set up again: they don't pay either. One that can't be deleted, such as one a restore holds at this moment, stays.
				// Pools sharing the provider share its listing, and what is theirs can't be told from what is old: only this key goes then.
				const others = o.shared ? [] : await provider.listEnvironments(owner).then(
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

	/**
	 * Runs the provisioning steps one after another, recording how each
	 * went on the items it installs. A step that fails doesn't stop the
	 * others, but the dependencies that need a toolchain it was to install
	 * are skipped. Returns how many failed or were skipped; only a stop is
	 * thrown.
	 */
	async #provision(workspace: Workspace, plan: readonly ProvisionStep[]): Promise<number> {
		let failures = 0;
		const missing = new Set<string>();
		for (const step of plan) {
			if (step.needs.some((tool) => missing.has(tool))) {
				failures++;
				this.#setItems(step.id, { status: "skipped" });
				continue;
			}
			const result = await runProvisionStep(workspace, step, { cwd: REPO_DIR, env: SETUP_ENV, signal: this.#kill.signal });
			if (result.outcome === "stopped") throw new Error(ENVIRONMENT_STOPPED);
			if (result.outcome === "ok") {
				this.#setItems(step.id, { status: "installed" });
				continue;
			}
			failures++;
			const error = environmentError(`\`${step.script}\` ${result.how}`, result.output);
			for (const each of this.store.required().environment.toolchains) if (stepOf(each) === step.id) missing.add(each.tool);
			this.#setItems(step.id, { status: "failed", error });
			this.store.recordEvent("environment.provision_failed", { step: step.id, error });
		}
		return failures;
	}

	/** Sets how the step `id` went on the toolchains and dependencies it installs. */
	#setItems(id: string, change: { status: "installed" | "failed" | "skipped"; error?: string }): void {
		const env = this.store.required().environment;
		const apply = <T extends { tool: string; status: string }>(item: T): T => (stepOf(item) === id ? { ...item, ...change } : item);
		this.#setEnvironment({ toolchains: env.toolchains.map(apply), dependencies: env.dependencies.map(apply) });
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

	/** The repository's setup, the highest of: the person's setting for it, its `.pim/env.json`, its `.pim/setup.sh`, a mise task named `setup`, a dev container's lifecycle commands; null without any. */
	async #setupScript(workspace: Workspace, thread: CodingThreadRow, owner: EnvironmentOwner, config: EnvConfig | null): Promise<Setup | null> {
		const setting = (await codingScheduler(this.env, thread.space).repoSettings(owner.repo)).setupScript;
		return chooseSetup({ setting, config, repository: () => repositorySetupScript(workspace, REPO_DIR), configured: () => detectConfiguredSetup(workspaceFiles(workspace, REPO_DIR)) });
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
	async #dropWorkspace(options: { keepVolume: boolean }, reason?: "stop"): Promise<void> {
		const thread = this.store.required();
		this.#open = null;
		if (!thread.workspaceRef) return;
		await this.workspaceProviders().get(thread.providerId).destroy(thread.workspaceRef, options);
		this.store.update({ workspaceRef: null });
		await this.#releaseCompute(reason ?? (options.keepVolume ? "suspend" : "stop"));
	}

	/**
	 * The workspace with every command also killed when the thread is
	 * stopped, and every call that fails as a workspace that went down would
	 * looked into (`#failure`): one on a workspace found down throws
	 * `WorkspaceLostError`.
	 */
	#killable(workspace: Workspace, ref: WorkspaceRef): Workspace {
		const kill = () => this.#kill.signal;
		const failure = (error: unknown) => this.#failure(workspace, ref, error);
		const lost = () => this.#lost.has(workspace);
		return new Proxy(workspace, {
			get(target, property) {
				if (property === "exec") {
					return (cmd: string[], options: Parameters<Workspace["exec"]>[1]) => {
						if (lost()) return refused();
						return watched(target.exec(cmd, { ...options, signal: options.signal ? AbortSignal.any([options.signal, kill()]) : kill() }), failure);
					};
				}
				const value = Reflect.get(target, property, target);
				if (typeof value !== "function") return value;
				return (...args: unknown[]) => {
					if (lost()) return Promise.reject(new WorkspaceLostError());
					return (value as (...args: unknown[]) => Promise<unknown>).apply(target, args).catch(async (error) => {
						throw await failure(error);
					});
				};
			},
		});
	}

	/**
	 * What a call on the workspace that threw should throw: the error itself,
	 * unless it is one a workspace that went down would throw and the
	 * workspace, the thread's current one, doesn't answer for the grace
	 * (`#probe`). Then the workspace is let go of, keeping its volume, and
	 * the call and every later one on it throw `WorkspaceLostError`.
	 */
	async #failure(workspace: Workspace, ref: WorkspaceRef, error: unknown): Promise<unknown> {
		if (this.#lost.has(workspace)) return new WorkspaceLostError();
		// A workspace the thread let go of, or replaced, isn't looked into.
		if (!mayBeLost(error) || this.store.thread()?.workspaceRef?.id !== ref.id) return error;
		let probe = this.#probing.get(workspace);
		if (!probe) {
			probe = this.#probe(ref);
			this.#probing.set(workspace, probe);
			void probe.finally(() => this.#probing.delete(workspace));
		}
		if (!(await probe)) return error;
		if (!this.#lost.has(workspace)) {
			this.#lost.add(workspace);
			await this.#loseWorkspace(ref, error);
		}
		return new WorkspaceLostError();
	}

	/**
	 * Whether the workspace went down: its backend says it has no such
	 * workspace, or neither the backend nor the workspace answers until the
	 * grace runs out. A workspace that answers, or that its backend stopped
	 * on purpose, isn't.
	 */
	async #probe(ref: WorkspaceRef): Promise<boolean> {
		const provider = this.workspaceProviders().get(ref.providerId);
		const grace = this.workspaceLostGraceMs();
		const deadline = Date.now() + grace;
		for (;;) {
			try {
				const workspace = await provider.get(ref);
				if (!workspace) return true;
				const { state } = await workspace.status();
				if (state === "gone") return true;
				if (state !== "running" || (await answers(workspace))) return false;
			} catch {
				// The backend doesn't answer: maybe it is restarting.
			}
			if (Date.now() >= deadline) return true;
			await new Promise((resolve) => setTimeout(resolve, Math.max(10, Math.min(5_000, grace / 5))));
		}
	}

	/** Lets a workspace that went down go, keeping its volume, so its next use makes it again from its files. */
	async #loseWorkspace(ref: WorkspaceRef, error: unknown): Promise<void> {
		const thread = this.store.required();
		console.warn(JSON.stringify({ event: "pim.coding.workspace_lost", thread: thread.threadId, operation: thread.currentOperation, error: errorText(error).slice(0, 300) }));
		this.store.recordEvent("workspace.lost", { operationId: thread.currentOperation ?? "", error: errorText(error).slice(0, 300) });
		if (this.#open?.id === ref.id) this.#open = null;
		try {
			await this.workspaceProviders().get(ref.providerId).destroy(ref, { keepVolume: true });
			if (this.store.required().workspaceRef?.id === ref.id) this.store.update({ workspaceRef: null });
			await this.#releaseCompute("lost");
		} catch (failure) {
			// The backend can't be reached: the next use finds the workspace down again, and lets it go then.
			console.warn(JSON.stringify({ event: "pim.coding.destroy_failed", thread: thread.threadId, error: errorText(failure).slice(0, 300) }));
		}
	}

	/**
	 * Saves the work in the open workspace, committed or not, without
	 * touching the checkout: what git would add goes into a tree through an
	 * index of its own, which a commit on top of the branch holds, kept as
	 * `refs/pim/autosave` and pushed nowhere, and a bundle of everything
	 * since the thread's base is kept in this object, so the work outlives
	 * the workspace's volume. Nothing is saved when nothing changed; a bundle
	 * too big to keep leaves the last one kept. One asked for while another
	 * runs follows it, so it sees what changed meanwhile.
	 */
	#autosave(): Promise<void> {
		if (this.#autosaving) return this.#autosaving.then(() => this.#autosave());
		this.#autosaving = this.#saveWork()
			.catch((error) => console.warn(JSON.stringify({ event: "pim.coding.autosave_failed", thread: this.store.thread()?.threadId, error: errorText(error).slice(0, 300) })))
			.finally(() => {
				this.#autosaving = null;
			});
		return this.#autosaving;
	}

	async #saveWork(): Promise<void> {
		const thread = this.store.required();
		const open = this.#open;
		if (!open || thread.slot !== "held" || thread.workspaceRef?.id !== open.id || thread.baseSha === null) return;
		this.#autosavedAt = Date.now();
		const workspace = open.workspace;
		const index = { env: { GIT_INDEX_FILE: AUTOSAVE_INDEX } };
		await git(workspace, ["add", "-A"], index);
		const tree = (await git(workspace, ["write-tree"], index)).trim();
		const head = (await git(workspace, ["rev-parse", "HEAD"])).trim();
		const last = this.store.autosave();
		if (last?.tree === tree && last.head === head) return;
		const commit = (await git(workspace, ["-c", "user.name=Pim", "-c", "user.email=coding@pim.invalid", "commit-tree", tree, "-p", head, "-m", "Autosave"])).trim();
		await git(workspace, ["update-ref", AUTOSAVE_REF, commit]);
		const file = `${WORKSPACE_ROOT}/.pim-autosave.bundle`;
		let bundle: Uint8Array;
		try {
			await git(workspace, ["bundle", "create", file, `${thread.baseSha}..${AUTOSAVE_REF}`]);
			bundle = await workspace.readFile(file);
		} finally {
			await workspace.remove(file).catch(() => {});
		}
		if (bundle.length > MAX_AUTOSAVE_BYTES) {
			console.warn(JSON.stringify({ event: "pim.coding.autosave_too_big", thread: thread.threadId, bytes: bundle.length }));
			return;
		}
		this.store.saveAutosave({ head, tree, commit, bundle, savedAt: this.now() });
	}

	/** A resume's prompt for a CLI that starts a new session, its last one lost with the workspace's volume: what it was asked first and what it last said. */
	async #lostSessionPrompt(text: string): Promise<string> {
		const messages = projectEntries(await this.harness.messages());
		const task = messages
			.find((message) => message.role === "user")
			?.parts.flatMap((part) => (part.type === "text" ? [part.text] : []))
			.join("\n")
			.trim();
		const said = await this.#lastSaid().catch(() => null);
		return [text, "Your earlier session was lost with the workspace, so this is a new one; the repository holds your work as it was last saved.", ...(task ? ["The task you were given:", task] : []), ...(said ? ["What you last said:", said] : [])].join("\n\n");
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
	readonly budgetUsd?: number | null;
	/** The thread that started this one, if any. */
	readonly parent?: string | null;
	/** Who started it: a person's or an agent's ID. */
	readonly createdBy: string;
	/** Repeating a start with the same operation changes nothing. */
	readonly operationId: string;
	/** The workspace backend's id (the deployment's default), by its exact id: the API doesn't take this, and it isn't checked. */
	readonly workspaceProvider?: string;
	/** Pins the thread to this pool, such as "compose" or "cloudflare-2": it takes a slot there only, and queues when it is full. A provider's id names its first pool. */
	readonly pool?: string;
	/** Pins the thread to this provider, such as "compose" or "cloudflare": its first pool. Naming both, they must agree. */
	readonly provider?: string;
	readonly limits?: Partial<CodingLimits>;
	/** When true, start with a freshly rebuilt environment, skipping any cached snapshot. Default false. */
	readonly rebuildEnvironment?: boolean;
};

export type CodingThreadStatus = {
	readonly activity: Activity;
	readonly threadId: string;
	readonly state: CodingThreadState;
	readonly stateReason: string | null;
	/** What to tell the person about the state, such as how to set up a workspace backend. */
	readonly stateDetail: string | null;
	readonly repo: { readonly url: string; readonly ref: string; readonly branch: string; readonly baseSha: string | null };
	readonly profile: AgentProfile;
	readonly resolvedProfile: ResolvedProfile | null;
	readonly harness: CodingHarness;
	readonly workspaceProvider: string;
	/** Where the thread runs (or would first try to): the same as `workspaceProvider`, named as the coding API's callers pin it. */
	readonly provider: string;
	/** The pool it takes slots from: a pool of the registry (./pools.ts), or its provider's id while one provider is one pool. */
	readonly pool: string;
	/** Why it is there: `pinned` (the start named it), `priority` (the first pool with room) or `overflow` (moved on from a full one). */
	readonly placementReason: PlacementReason;
	/** The same, in full: the pool and the provider behind it, the pool's priority, and the pools it couldn't and why. Null before the thread is placed. */
	readonly placement: ThreadPlacement | null;
	/** What kind of provider runs the thread: a workspace Pim made and execs into, or an agent-hosted orb in the agent's own cloud. */
	readonly providerKind: CodingThreadRow["providerKind"];
	/** The agent-hosted thread the thread runs on, where the person can watch it on the agent's own site; null for a workspace thread. */
	readonly orb: { readonly url: string } | null;
	/**
	 * What the thread has cost: what Pim measured of it in a workspace, or
	 * what its agent's cloud reported for an agent-hosted one — the agent's
	 * word, which Pim can't check. Null when the agent reports no cost, with
	 * `costNote` saying so honestly.
	 */
	readonly cost: number | null;
	/** Why `cost` is null, when it is. */
	readonly costNote: string | null;
	readonly slot: CodingThreadRow["slot"];
	/** Its place in the space's queue while it waits for a slot. */
	readonly queue: QueuePlace | null;
	readonly budgetUsd: number | null;
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
	/** How many consecutive interruptions have been auto-resumed for this thread. */
	readonly consecutiveInterrupts: number;
	/** The workspace's session: when it began, when the provider ends it, and how the thread moved on from earlier ones. */
	readonly session: CodingSessionStatus;
	/** The pull request opened from its branch; null until one is. */
	readonly pullRequest: { readonly url: string; readonly number: number } | null;
};

/** A session as the status tells it. `maxMin` and `expiresAt` are null for a provider without a cap, `keepAlive` is whether the thread pings the provider while a turn runs. */
export type CodingSessionStatus = CodingSession & { readonly maxMin: number | null; readonly expiresAt: number | null; readonly keepAlive: boolean };

export type CodingDiff = { readonly since: string | null; readonly head: string | null; readonly diff: string; readonly truncated: boolean };

/** How a turn ended, from pi or a CLI harness: answered, or why not, with what to tell the person. */
type TurnResult = { readonly status: "done" | "unanswered"; readonly reason?: string; readonly detail?: string };

/** What `events()` sends besides pi's own events: a command's output as it runs, and a CLI harness's text or thinking as it is written. */
export type CodingLiveMessage = ({ readonly type: "output" } & CodingOutputEvent) | { readonly type: "partial"; readonly kind: "text" | "thinking"; readonly text: string };

/** The kind of a CLI harness's messages in the conversation. */
const CLI_MESSAGE = "harness.message";

/** A CLI run that ended before it ran. */
const NO_RUN: RunResult = { status: "unanswered", sessionId: null, sessionCostUsd: null, usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, sessionUsage: null, model: null, lines: 0 };

/** How a turn ended. `needs_approval` is for a turn held for the person, such as for a CLI harness's login. `interrupted` is for a turn that was interrupted by a restart and auto-resumed. */
export type TurnOutcome = "completed" | "error" | "cancelled" | "needs_approval" | "interrupted";

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
	readonly budgetUsd: number | null;
	/** Set when the thread's harness reports no spend, so `spentUsd` is not a measure and the budget is not enforced. */
	readonly unmetered?: true;
	/** The end of what the coding agent last said, at most 1,000 characters. */
	readonly said?: string;
	/** What went wrong, at most 500 characters, for a turn that didn't complete. */
	readonly detail?: string;
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
- While you work, run only the tests that cover your change — one test file, or the repository's own command for a diff's tests if it has one — and never run tests in the background and poll for them with sleep.
- Before you say you are done, run the repository's type checks or linters and the tests that cover your change, and fix what fails; if you can't run something, say why. The repository's full suite runs in its CI on the pushed branch, and that is the authority for it: never run the suite locally just to check, and never sleep-poll for a result. After fixing a failing test, rerun only its file, and the files that cover a change to shared code.
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
export function cliInstructions(thread: Pick<CodingThreadRow, "repoUrl" | "branch" | "baseRef"> & { readonly environment?: CodingEnvironment }): string {
	const brief = thread.environment ? environmentBrief(thread.environment) : null;
	return `You are working for a person who will review your work as a diff. The repository ${thread.repoUrl} is checked out in the current directory, on the branch ${thread.branch} made from ${thread.baseRef}.

- Your changes are committed for you at the end of each turn: don't commit, push or rewrite history.
- While you work, run only the tests that cover your change — one test file, or the repository's own command for a diff's tests if it has one — and never run tests in the background and poll for them with sleep.
- Before you say you are done, run the repository's type checks or linters and the tests that cover your change, and fix what fails; if you can't run something, say why. The repository's full suite runs in its CI on the pushed branch, and that is the authority for it: never run the suite locally just to check, and never sleep-poll for a result. After fixing a failing test, rerun only its file, and the files that cover a change to shared code.
- When you finish, say briefly what you changed, how you checked it, and anything left undone.${brief ? `\n\n${brief}` : ""}`;
}

/** What `continue` tells the model. */
export const CONTINUE_TEXT = "Continue where you left off.";
/** What a CLI turn cut off by its workspace going down is told when it goes on in the workspace made again. */
export const SESSION_RESUME_TEXT = "The sandbox's session reached its time limit and was replaced by a new one, with your files kept but what was running in it gone; check git status and continue where you left off.";
export const LOST_RESUME_TEXT = "You were interrupted by an infrastructure restart; continue where you left off.";
const STALLED_CONTINUE_TEXT = "Your last turn was stopped because it made no progress for a long while, so a command of yours may have hung. Check where you were, and continue where you left off.";

/** A refused model call's error. "out of budget" is wording pi-ai never retries. */
export const BUDGET_MESSAGE = "Coding thread out of budget";

/** What a push needs set up, as the person reads it. */
export const GITHUB_APP_NOT_CONFIGURED = "GitHub App not configured: ask the Pim owner to set it up";

/** A push readied for the person to approve, with the checkpoint it is of; or why it can't be. */
export type PushPreparation =
	| { readonly ok: true; readonly request: PushApprovalRequest & { readonly checkpoint: string } }
	| { readonly ok: false; readonly code: "github_app_not_configured" | "push_refused" | "archived" | "nothing_to_push" | "workspace_not_running" | "workspace_queued" | "conflict"; readonly message: string };

/** A pull request readied for the person to approve; or why it can't be. */
export type PullRequestPreparation =
	| { readonly ok: true; readonly request: { readonly title: string; readonly body: string; readonly base: string; readonly summary: string } }
	| { readonly ok: false; readonly code: "github_app_not_configured" | "archived" | "not_pushed" | "conflict"; readonly message: string };

/** A merge readied for the person to approve, with the checkpoint it is of; or why it can't be. */
export type MergePreparation =
	| { readonly ok: true; readonly request: { readonly checkpoint: string; readonly summary: string } }
	| { readonly ok: false; readonly code: "github_app_not_configured" | "archived" | "nothing_to_push" | "workspace_not_running" | "workspace_queued" | "conflict"; readonly message: string };

/** What a merge did: the default branch's move, whether the thread's commits were rebased, and the thread's own branch if it was pushed too. */
export type MergeResult = PushResult & { readonly rebased: boolean; readonly threadBranch: string | null };

/** The most of the coding agent's last words a turn's end carries. */
const SAID_CHARS = 1000;

const errorText = (error: unknown) => (error instanceof Error ? error.message : String(error));

/** The workspace provider of a thread started while the deployment had none. */
const NO_BACKEND = "none";

/** How long the compute providers read from the Gallery are used before they're read again. */
const COMPUTE_REFRESH_MS = 5_000;

/** The space is over its compute quota (./compute.ts), so no workspace is made or resumed for it now. A state to show the person (`failed(compute_quota)`), not a crash. */
class ComputeQuotaError extends Error {
	override readonly name = "ComputeQuotaError";
	readonly code = "compute_quota";
}

/** A thread's own time limit for a turn, in milliseconds, or null when it has none: turns have no default limit, and are stopped only when they stall. */
const wallClockMs = (thread: CodingThreadRow): number | null => (thread.limits.wallClockMin === null ? null : thread.limits.wallClockMin * 60_000);

/** How long a harness's lock is leased before it must be renewed (`HarnessRunner` renews it as a turn goes on). */
const HARNESS_LOCK_LEASE_MS = 60 * 60_000;

/** How long a gateway token lasts for a thread with no time limit; revoking the thread's nonce ends it sooner. */
const UNLIMITED_TOKEN_MS = 7 * 24 * 60 * 60_000;

/** Marks the operation of a turn the thread began itself, after one stalled. */
const AUTO_CONTINUE_PREFIX = "auto-continue:";

/** The operations of turns retried after a transient error, and the backoff before one: 30 to 60 seconds. */
const RETRY_PREFIX = "retry-";
const RETRY_BASE_MS = 30_000;
const RETRY_JITTER_MS = 30_000;

/** What an error says when a provider's per-minute cap stopped a turn: a rate limit the whole account shares, so one thread's backoff outlasts it. */
const RATE_LIMIT_ERROR = /rate.?limit|\b429\b|too many requests|per min/i;
/** How many times in a row a turn a rate limit stopped is retried: more than a blip gets, because the cap is the account's, not this thread's. */
const RATE_LIMIT_RETRIES = 6;
/** The wait before each of those retries: 60 s, half again more each time, at most 5 minutes, and up to 10 s of jitter on top. */
const RATE_LIMIT_RETRY_BASE_MS = 60_000;
const RATE_LIMIT_RETRY_GROWTH = 1.5;
const RATE_LIMIT_RETRY_MAX_MS = 5 * 60_000;
const RATE_LIMIT_RETRY_JITTER_MS = 10_000;

/** How many retries in a row an operation already is, counted by the `retry-` prefixes piled on its id; a turn that succeeds begins with a fresh id, so the count starts over. */
function retryCount(operation: string): number {
	let count = 0;
	while (operation.startsWith(RETRY_PREFIX)) {
		count++;
		operation = operation.slice(RETRY_PREFIX.length);
	}
	return count;
}

/** A provider's `retry-after` as its error's words give it, in ms; null when it says none or no plain count of seconds. */
export function retryAfterMs(error: string): number | null {
	const seconds = /retry[ _-]?after["':= ]*["']?(\d+)/i.exec(error)?.[1];
	return seconds ? Number(seconds) * 1000 : null;
}

/** How long a turn a rate limit stopped waits before its `attempt`th retry: a backoff that grows with each retry, plus jitter, and never less than the provider's `retry-after`. */
export function rateLimitRetryDelayMs(attempt: number, retryAfterMs: number | null): number {
	const backoff = Math.min(RATE_LIMIT_RETRY_BASE_MS * RATE_LIMIT_RETRY_GROWTH ** (attempt - 1), RATE_LIMIT_RETRY_MAX_MS) + Math.random() * RATE_LIMIT_RETRY_JITTER_MS;
	return Math.max(backoff, retryAfterMs ?? 0);
}

/** Errors a retry can't help: the credentials, the request, the budget or the person. */
const PERMANENT_ERROR = /unauthori[sz]ed|forbidden|authenticat|invalid[ _-]?(api[ _-]?key|request|token|param)|api key|permission|budget|usage limit|quota|credit|billing|context (length|window)|too (long|large)|not found|\b(40[0-9]|41[0-9]|42[0-8]|4[3-9][0-9])\b/i;
/** Errors that come and go: provider trouble, rate limits and a connection that dropped. */
const TRANSIENT_ERROR = /\b(429|5\d\d)\b|rate.?limit|too many requests|overload|server error|bad gateway|unavailable|temporar|timed? ?out|timeout|network|connection|websocket|socket|ECONN\w*|ETIMEDOUT|EAI_AGAIN|fetch failed|capacity|internal error|try again|manager|workspace|container|sandbox/i;

/**
 * Whether a failed turn's error is worth a retry. A model error is, unless what it says is permanent; a
 * harness or workspace error is only when it reads as transient.
 */
export function isTransient(reason: string | undefined, detail: string | undefined): boolean {
	const text = detail ?? "";
	if (PERMANENT_ERROR.test(text) && !/\b429\b/.test(text)) return false;
	if (reason === "model_error") return true;
	if (reason !== "harness_error" && reason !== "workspace" && reason !== "error") return false;
	return TRANSIENT_ERROR.test(text);
}

/** The operations of turns a thread goes on with by itself after an interruption, and how many it goes on with in a row. */
const RESUME_PREFIX = "resume-";
const MAX_RESUMES = 3;
/** How many times in a row a turn is restarted for a session that ended, with nothing new committed between, before the thread fails. */
const MAX_SESSION_RESTARTS = 3;

/** How long a workspace that fails may not answer before it counts as down. */
const LOST_GRACE_MS = 60_000;

/** How long a thread going on after its workspace went down first waits for a backend it can't reach; doubled each time. */
const LOST_RETRY_MS = 60_000;

const lostTooOften = (times: number) => `The workspace went down ${times + 1} times in a row: its container, the workspace manager or its host died, and it was made again from its files ${times} times. Continue the thread to try again.`;

/** Why a thread failed for a workspace that kept going down, with the last error if there was one, as its state and its parents tell it. */
const lostDetail = (last?: string | null) => (last ? `${lostTooOften(MAX_RESUMES)} Last: ${last}` : lostTooOften(MAX_RESUMES)).slice(0, DETAIL_MAX);

/** How often a running turn's work is autosaved, where it is kept in the workspace, the index it is added with, and the most of it this object keeps. */
const AUTOSAVE_MS = 3 * 60_000;
const AUTOSAVE_REF = "refs/pim/autosave";
const AUTOSAVE_INDEX = ".git/pim-autosave-index";
const MAX_AUTOSAVE_BYTES = 1024 * 1024;

const DEFAULT_LIMITS: CodingLimits = { cpu: 2, memMiB: 4096, diskMiB: 5120, pids: 1024, wallClockMin: null };

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
/** How often a turn on an agent-hosted thread is looked at, and how many looks in a row may say the client can't tell what it is doing before the turn is failed as unknown. */
const ORB_POLL_MS = 30_000;
const ORB_UNKNOWN_LIMIT = 10;
/** The most calls one look at an agent-hosted thread's transcript may page through. */
const ORB_MESSAGE_PAGES = 1_000;
/** What a thread that runs in the agent's own cloud is told when this Pim has no client for it: a state to show the person, not a crash. */
const AGENT_HOSTED_UNAVAILABLE = "agent-hosted provider not available: this Pim has no orb client registered, so the thread can't run in the agent's cloud. Continue it once one is set up.";
/** How long a thread may sit queued or provisioning with no change before it is failed as stuck. */
const STUCK_MS = 20 * 60_000;
const DETAIL_MAX = 500;
const ADVANCE_WAIT_MS = 20_000;
/** How long a tool waits for a suspended workspace to resume (`#ensureWorkspace`). */
const RESUME_WAIT_MS = 120_000;
const GIT_TIMEOUT_MS = 120_000;
const CLONE_TIMEOUT_MS = 10 * 60_000;
/** The pauses before the retries of a clone or fetch the git host rate limited: 5 s, 15 s, then 45 s. */
const GIT_RETRY_DELAYS_MS: readonly number[] = [5_000, 15_000, 45_000];

/** How long a thread holds the lock on building an environment, and waits for another thread's build: the provisioning's and setup script's time, and the snapshot's. */
const BUILD_LOCK_MS = 2 * SETUP_TIMEOUT_MS + 10 * 60_000;

/** A repository's setup script and where it came from. */
type Setup = ChosenSetup;

/**
 * Where mise downloads the toolchains a repository pins: its version lists,
 * Go, Node and Rust from their projects' own sites, Go's checksum database,
 * and GitHub's releases for Python, uv, Bun and the rest.
 */
const TOOLCHAIN_HOSTS = ["mise-versions.jdx.dev", "dl.google.com", "go.dev", "sum.golang.org", "nodejs.org", "static.rust-lang.org", "github.com", "api.github.com", "objects.githubusercontent.com", "release-assets.githubusercontent.com"];
/** JDK downloads and the Gradle/Maven/Minecraft mod toolchain hosts, so Java builds (NeoForge mods) work in a workspace. */
const JAVA_HOSTS = ["mise-java.jdx.dev", "api.foojay.io", "api.adoptium.net", "repo.maven.apache.org", "repo1.maven.org", "services.gradle.org", "downloads.gradle.org", "plugins.gradle.org", "plugins-artifacts.gradle.org", "maven.neoforged.net", "maven.minecraftforge.net", "piston-meta.mojang.com", "piston-data.mojang.com", "launchermeta.mojang.com", "libraries.minecraft.net", "resources.download.minecraft.net"];

/** An abort while the environment is readied: `#provisioningFailed` takes " was stopped:" as one. */
const ENVIRONMENT_STOPPED = "Readying the environment was stopped: the thread was aborted";

/** Whose the thread's environments are: the person whose space it is, and the repository as `owner/name` in lowercase. */
function environmentOwner(thread: CodingThreadRow): EnvironmentOwner {
	// Another instance's repositories are told apart from GitHub's by the instance's id.
	if (thread.providerInstance !== GITHUB_INSTANCE_ID) return { userId: thread.space, repo: `${thread.providerInstance}/${new URL(thread.repoUrl).pathname.slice(1)}`.toLowerCase() };
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

/** pi's run policy for coding threads: a few retries for transient model errors, waiting longer between them than pi's own default, since what reaches a thread is what pi gave up on. */
const CODING_SETTINGS: HarnessSettings = {
	retry: { enabled: true, maxRetries: 4, baseDelayMs: 2000 },
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

/** What an `app.budget_stop` entry holds: tokens only in those of threads stopped at a token ceiling, which Pim no longer sets. */
type BudgetStop = { budgetUsd?: number; spentUsd?: number; tokens?: number; tokenCeiling?: number };

/** A budget stop as the transcript says it. */
function budgetStopText(stop: BudgetStop): string {
	if (stop.tokenCeiling !== undefined) return `Stopped: the thread used ${(stop.tokens ?? 0).toLocaleString("en-US")} of the ${stop.tokenCeiling.toLocaleString("en-US")} tokens its $${stop.budgetUsd ?? 0} budget allows.`;
	return `Stopped: the thread spent $${(stop.spentUsd ?? 0).toFixed(2)} of its $${stop.budgetUsd ?? 0} budget.`;
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

/** Whether a workspace call's failure may be the workspace going down, rather than about what was asked: a missing file, a path, a full disk or a full backend never is. */
function mayBeLost(error: unknown): boolean {
	if (error instanceof WorkspaceFileError || error instanceof WorkspacePathError || error instanceof WorkspaceLimitError || error instanceof WorkspaceCapacityError || error instanceof WorkspaceLostError) return false;
	if (error instanceof ComposeManagerError) return error.status >= 500;
	return !(error instanceof Error && error.name === "AbortError");
}

/** Whether a command runs in the workspace at all: any exit says so, whatever its code. */
async function answers(workspace: Workspace): Promise<boolean> {
	try {
		for await (const event of workspace.exec(["true"], { timeoutMs: 10_000 })) if (event.type === "exit") return event.timedOut !== true;
		return false;
	} catch {
		return false;
	}
}

/** A command's events, with what it throws looked into by `failure`. */
async function* watched(events: AsyncIterable<ExecEvent>, failure: (error: unknown) => Promise<unknown>): AsyncGenerator<ExecEvent> {
	try {
		yield* events;
	} catch (error) {
		throw await failure(error);
	}
}

/** A command on a workspace found down: it throws at once. */
async function* refused(): AsyncGenerator<ExecEvent> {
	throw new WorkspaceLostError();
}

/** Whether git's error says the host rate limited the request or was briefly unavailable, which is worth another try. */
function isTransientGitError(message: string): boolean {
	return /error: (429|502|503|504)\b|HTTP (429|502|503|504)\b|RPC failed|rate limit|Too Many Requests|\b(502|503|504)\b.*(Bad Gateway|Unavailable|Timeout)/i.test(message);
}

/** `git`, tried again after each of `delays` (ms) while it fails with a rate limit or a brief outage; `cleanUp` runs before each retry, to remove what a failed attempt left. Any other failure, and the last, is thrown. */
async function gitWithRetries(workspace: Workspace, args: string[], options: Parameters<typeof git>[2], delays: readonly number[], cleanUp?: () => Promise<unknown>): Promise<string> {
	for (let retry = 0; ; retry++) {
		try {
			return await git(workspace, args, options);
		} catch (error) {
			if (retry >= delays.length || !(error instanceof Error) || !isTransientGitError(error.message)) throw error;
			await cleanUp?.();
			await new Promise((resolve) => setTimeout(resolve, delays[retry]));
		}
	}
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
