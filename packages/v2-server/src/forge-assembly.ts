/**
 * Forge assembled from the process configuration, as far as the deployment configures it:
 *
 * - a sandbox manager (`PIM_CODING_MANAGER_URL` and `PIM_CODING_MANAGER_TOKEN`) gives it a `ComputeProvider`, which runs the `pi` and vendor-CLI turns; without one a sandbox harness answers 503 and `amp` orbs still run;
 * - the person's harness logins and Amp key live in the vault, sealed under the deployment's keys (`PIM_KEK_*`), so Amp and the vendor CLIs need them;
 * - a git host: the GitHub App (`PIM_GITHUB_APP_ID`, `PIM_GITHUB_APP_PRIVATE_KEY` or `PIM_GITHUB_PRIVATE_KEY`) and/or Gitea (`PIM_GITEA_BASE_URL`, `PIM_GITEA_CLIENT_ID`, `PIM_GITEA_CLIENT_SECRET`), reached through `ProviderGitHost`; without one a thread can't be pushed or merged;
 * - Amp's origin is `PIM_AMP_BASE_URL` (https://ampcode.com).
 *
 * `startForgeLoops` runs what keeps threads moving. `forgeHttp` is Forge's HTTP surface for the Gate.
 */
import { compatibleProvider } from "./agent-host.ts";
import { type PageApproval, webCodingShapes } from "./compat/coding.ts";
import { createModels } from "@earendil-works/pi-ai";
import { anthropicProvider } from "@earendil-works/pi-ai/providers/anthropic";
import { openaiProvider } from "@earendil-works/pi-ai/providers/openai";
import { randomBytes } from "node:crypto";
import { GiteaNotConnectedError } from "@pim/coding/git-broker/gitea-connection";
import { githubAppConfig, githubAppStatus, giteaConfig, brokerPolicy, GITEA_INSTANCE_ID } from "@pim/coding/git-broker/config";
import { GitHubApp } from "@pim/coding/git-broker/github-app";
import { GitHubProvider } from "@pim/coding/git-broker/github-provider";
import { GiteaProvider } from "@pim/coding/git-broker/gitea-provider";
import { ProviderRegistry, type GitProvider } from "@pim/coding/git-broker/provider";
import { claudeCode } from "@pim/coding/harness/claude-code";
import { codex } from "@pim/coding/harness/codex";
import { mistralVibe } from "@pim/coding/harness/vibe";
import { ComposeWorkspaceProvider } from "@pim/coding/workspace/compose";
import type { WorkspaceProvider } from "@pim/coding/workspace/types";
import type { EnvelopeCrypto, ObjectStore } from "@pim/v2-contracts/platform";
import { type ApprovalFiled, Authz } from "@pim/v2-forge/authz";
import { ampAttachmentFetcher, ampOrbClients } from "@pim/v2-forge/amp-adapter";
import { CliTurnPort } from "@pim/v2-forge/cli-port";
import type { ComputeProvider } from "@pim/v2-forge/compute";
import { type Db as ForgeDb, scopedDb } from "@pim/v2-forge/db";
import { CapabilityUnavailableError } from "@pim/v2-forge/errors";
import { Forge } from "@pim/v2-forge/forge";
import { GiteaConnection } from "@pim/v2-forge/gitea";
import { prepareCheckout } from "@pim/v2-forge/git-checkout";
import type { Authenticate, Handler } from "@pim/v2-forge/http/common";
import { gitBroker, type GitUpstream } from "@pim/v2-forge/http/git-broker";
import { modelGateway } from "@pim/v2-forge/http/gateway";
import { compose } from "@pim/v2-forge/http/index";
import { codingRest } from "@pim/v2-forge/http/rest";
import { codingGitea, codingVault } from "@pim/v2-forge/http/vault";
import { HarnessLogins } from "@pim/v2-forge/login-flows";
import { PiTurnPort, type PiPortDeps } from "@pim/v2-forge/pi-port";
import type { GitHost, TurnPort } from "@pim/v2-forge/ports";
import { ProviderGitHost, providerUpstream } from "@pim/v2-forge/provider-git";
import { ForgeScheduler } from "@pim/v2-forge/scheduler";
import { StallSupervisor } from "@pim/v2-forge/stall";
import { ForgeStore } from "@pim/v2-forge/store";
import { Credentials } from "@pim/v2-forge/tokens";
import { ForgeVault } from "@pim/v2-forge/vault";
import { WorkspaceAgentComputeProvider } from "@pim/v2-forge/workspace-agent";
import { ForgeWorker } from "@pim/v2-forge/worker";
import type { Harness } from "@pim/v2-forge/harnesses";
import pg from "pg";

type Env = Record<string, string | undefined>;

const unavailable = (what: string) => new Proxy({}, { get: (_t, name) => () => Promise.reject(new CapabilityUnavailableError("git host", `no git host is configured (${what}: ${String(name)})`)) }) as never;

/** What a test replaces: the parts that reach outside Pim and have no local stand-in over the network. Set before the roles start. */
export type ForgeOverrides = Partial<{
	compute: ComputeProvider | null;
	/** The sandbox manager's workspaces, where a harness sign-in runs; null without a manager. */
	workspaces: WorkspaceProvider | null;
	git: GitHost;
	gitUpstream: GitUpstream;
	models: PiPortDeps["models"];
	fetch: typeof fetch;
	clock: () => number;
}>;
let overrides: ForgeOverrides = {};
/** Installs overrides for the roles started after this call; returns the function that removes them. */
export function useForgeOverrides(o: ForgeOverrides): () => void {
	overrides = o;
	return () => void (overrides = {});
}

export type ForgeParts = {
	forge: Forge;
	store: ForgeStore;
	authz: Authz;
	scheduler: ForgeScheduler;
	credentials: Credentials;
	db: ForgeDb;
	worker: ForgeWorker;
	stalls: StallSupervisor;
	compute: ComputeProvider | null;
	/** The sandbox manager's workspaces, where a harness sign-in runs; null without a manager. */
	workspaces: WorkspaceProvider | null;
	git: GitHost;
	gitUpstream: GitUpstream;
	gitea: GiteaConnection | null;
	vault: ForgeVault | null;
	/** Whether people can run Amp threads here: the deployment holds the keys that seal a person's Amp key. */
	ampConfigured: boolean;
	env: Env;
};

/** The pi models a coding thread may use: the deployment's providers, and `PIM_CODING_DEFAULT_MODEL` (`provider/model`) for a thread that names none. */
function defaultModels(env: Env): PiPortDeps["models"] {
	const models = createModels();
	models.setProvider(anthropicProvider());
	models.setProvider(openaiProvider());
	// The deployment's OpenAI-compatible gateway (a stand-in model in a trial), as `gateway/<model>`.
	const listed = (env.PIM_AI_GATEWAY_MODELS ?? "").split(",").map((m) => m.trim()).filter(Boolean);
	if (env.PIM_AI_GATEWAY_URL && listed.length > 0) models.setProvider(compatibleProvider("gateway", "AI gateway", env.PIM_AI_GATEWAY_URL, listed.map((id) => ({ id })), () => env.PIM_AI_GATEWAY_KEY) as never);
	return async () => models;
}

export function assembleForge(db: ForgeDb, objects: ObjectStore, env: Env, crypto?: EnvelopeCrypto, opts: { scoped?: boolean; /** Whether this deployment can run Amp, for a process that holds no vault of its own (the Runner, which only starts threads). Default: this process has a vault. */ ampConfigured?: boolean; /** Where a person answers what Forge asks them to approve. */ onApprovalFiled?: (filed: ApprovalFiled) => Promise<void> } = {}): ForgeParts {
	const store = new ForgeStore(db);
	const authz = new Authz(db, { allowedRepos: (env.PIM_CODING_ALLOWED_REPOS ?? "").split(",").map((r) => r.trim()).filter(Boolean), branchPrefix: env.PIM_CODING_BRANCH_PREFIX ?? "pim/" }, opts.onApprovalFiled);
	const clock = overrides.clock ?? Date.now;
	const scheduler = new ForgeScheduler(db, store, clock);
	// Without a configured signing key a process signs with its own, so the broker tokens it issues die with it: fine for a trial, set one in a deployment.
	const credentials = new Credentials(db, env.PIM_CODING_SIGNING_KEY ?? randomBytes(32).toString("base64url"), authz.policy, clock, opts.scoped ?? false);
	const publicUrl = env.PIM_PUBLIC_URL ?? "";
	// Where a workspace reaches the git broker: Pim's public address, or `PIM_CODING_BROKER_URL` where that isn't reachable from a workspace (a Compose stack with no public HTTPS address: the egress proxy's `EGRESS_INTERNAL_HOSTS` then lists it).
	const brokerUrl = env.PIM_CODING_BROKER_URL || publicUrl;

	const workspaces: WorkspaceProvider | null = env.PIM_CODING_MANAGER_URL && env.PIM_CODING_MANAGER_TOKEN ? new ComposeWorkspaceProvider({ managerUrl: env.PIM_CODING_MANAGER_URL, token: env.PIM_CODING_MANAGER_TOKEN, ...(overrides.fetch ? { fetch: overrides.fetch } : {}) }) : null;
	const compute: ComputeProvider | null =
		overrides.compute !== undefined
			? overrides.compute
			: workspaces
				? new WorkspaceAgentComputeProvider(workspaces, { ...(env.PIM_CODING_IMAGE ? { image: env.PIM_CODING_IMAGE } : {}), egressAllow: [...(brokerUrl ? [new URL(brokerUrl).hostname] : []), ...(env.PIM_CODING_EGRESS ?? "").split(",").map((h) => h.trim()).filter(Boolean)] })
				: null;

	const vault = crypto ? new ForgeVault(db, crypto) : null;

	// The git host: the GitHub App (public repositories are read without it) and Gitea once its OAuth application is set up.
	const aliased = { ...env, PIM_GITHUB_APP_PRIVATE_KEY: env.PIM_GITHUB_APP_PRIVATE_KEY ?? env.PIM_GITHUB_PRIVATE_KEY };
	const policy = brokerPolicy(env);
	const providers: GitProvider[] = [new GitHubProvider(githubAppStatus(aliased).configured ? new GitHubApp(githubAppConfig(aliased)) : null, { policy })];
	const giteaOauth = giteaConfig(env);
	const gitea = crypto && giteaOauth && publicUrl ? new GiteaConnection(db, crypto, { ...giteaOauth, redirectUri: `${publicUrl.replace(/\/$/, "")}/api/coding/gitea/callback` }) : null;
	if (gitea && giteaOauth) {
		const viaForge = { accessToken: async () => (await gitea.accessToken()) ?? Promise.reject(new GiteaNotConnectedError("not_connected")) };
		providers.push(new GiteaProvider({ id: GITEA_INSTANCE_ID, kind: "gitea", baseUrl: giteaOauth.baseUrl, label: "Gitea" }, viaForge as never));
	}
	const registry = new ProviderRegistry(providers);
	const hostConfigured = githubAppStatus(aliased).configured || gitea !== null;
	const providerDeps = { registry, policy, ...(compute ? { compute } : {}) };
	const git: GitHost = overrides.git ?? (hostConfigured ? new ProviderGitHost(providerDeps) : unavailable("configure the GitHub App or Gitea"));
	const gitUpstream: GitUpstream = overrides.gitUpstream ?? providerUpstream(providerDeps);

	// Turns: pi on pi-durable and PostgreSQL, and the three vendor CLIs, in the sandbox the manager makes. Amp needs no sandbox, only the person's key.
	const turns: Partial<Record<Harness, TurnPort>> = {};
	if (compute) {
		const [provider, ...rest] = (env.PIM_CODING_DEFAULT_MODEL ?? "anthropic/claude-sonnet-5").split("/");
		turns.pi = new PiTurnPort({ store, compute, models: overrides.models ?? defaultModels(env), defaultModel: { provider: provider!, modelId: rest.join("/") } });
		if (vault) for (const cli of [claudeCode, codex, mistralVibe]) turns[cli.id as Harness] = new CliTurnPort({ cli, compute, store, scheduler, vault });
	}
	const wiring = vault ? { db, vault, baseUrl: env.PIM_AMP_BASE_URL ?? "https://ampcode.com", ...(overrides.fetch ? { fetch: overrides.fetch } : {}) } : null;
	const worker = new ForgeWorker({
		store,
		scheduler,
		turns,
		compute,
		orbs: wiring ? ampOrbClients(wiring) : () => null,
		objects: objects as never,
		...(wiring ? { attachments: ampAttachmentFetcher(wiring), ampBaseUrl: wiring.baseUrl } : {}),
		defaultPool: env.PIM_CODING_DEFAULT_POOL ?? "default",
		clock,
		...(env.PIM_FORGE_ORB_POLL_MS ? { orbPollMs: Number(env.PIM_FORGE_ORB_POLL_MS) } : {}),
		...(env.PIM_FORGE_LEASE_MS ? { leaseMs: Number(env.PIM_FORGE_LEASE_MS) } : {}),
		computeSpec: (t) => ({ repo: { url: `${brokerUrl.replace(/\/$/, "")}/api/coding/git/${t.repo}.git`, ref: t.ref ?? "HEAD", branch: t.branch ?? "" } }),
		prepareWorkspace: compute
			? async (thread, handle) => {
					const save = (await db.query("select head_sha, object_key from pim_forge.forge_autosaves where thread_id = $1", [thread.threadId])).rows[0];
					const got = save ? await objects.get(save.object_key as string) : null;
					await prepareCheckout({ compute, credentials, publicUrl: brokerUrl }, thread, handle, got && save ? { bundle: got.body, head: save.head_sha as string } : null);
				}
			: undefined,
	});
	const ampConfigured = opts.ampConfigured ?? vault !== null;
	const forge = new Forge({ db, store, authz, scheduler, credentials, git, objects: objects as never, orbs: wiring ? ampOrbClients(wiring) : () => null, compute, ampConfigured, promoteOnRelease: !opts.scoped });
	return { forge, store, authz, scheduler, credentials, db, worker, stalls: new StallSupervisor(db, store, clock), compute, workspaces, git, gitUpstream, gitea, vault, ampConfigured, env };
}

/** Forge's HTTP surface for the Gate, whose database role is subject to row-level security: each request runs under its owner's scope. The git broker and the Gitea connection are mounted when there is a git host for them. */
export function forgeHttp(parts: ForgeParts, o: { authenticate: Authenticate; crypto: EnvelopeCrypto; pageApproval: PageApproval }): Handler {
	const { db } = parts;
	const scope = (owner: string) => new ForgeStore(scopedDb(db, owner));
	const gatewayKeys: Record<string, string | undefined> = { anthropic: parts.env.PIM_CODING_ANTHROPIC_API_KEY, openai: parts.env.PIM_CODING_OPENAI_API_KEY };
	const vault = (owner: string) => new ForgeVault(scopedDb(db, owner), o.crypto);
	// A sign-in or a key makes the person's threads that waited for it go on, under their own scope.
	const resume = async (owner: string, harness: string) => void (await parts.forge.scopedTo(owner).resumeAfterLogin(owner, harness));
	// Harness sign-ins run in a short-lived sandbox of the manager, so they are offered where there is one.
	const login = new HarnessLogins({ provider: parts.workspaces, image: parts.env.PIM_CODING_IMAGE ?? "pim-workspace:local", vault, onConnected: resume });
	const inner = compose(
		codingRest({ forge: parts.forge, scheduler: parts.scheduler, store: parts.store, db, authenticate: o.authenticate, scoped: true }),
		codingVault({ vault, authenticate: o.authenticate, login, connected: resume }),
		gitBroker({ credentials: parts.credentials, store: parts.store, scope, git: parts.git, upstream: parts.gitUpstream }),
		codingGitea({ gitea: parts.gitea, authenticate: o.authenticate }),
		gatewayKeys.anthropic || gatewayKeys.openai ? modelGateway({ credentials: parts.credentials, store: parts.store, scope, key: async (_thread, family) => (gatewayKeys[family] ? { apiKey: gatewayKeys[family]! } : null) }) : null,
	);
	// The web app reads threads in v1's shapes.
	return webCodingShapes({ forge: parts.forge, authenticate: o.authenticate, inner, pageApproval: o.pageApproval });
}

export type ForgeLoopOptions = { databaseUrl: string; pollMs?: number; stallMs?: number; onError?: (what: string, error: unknown) => void };

/**
 * What keeps coding threads moving: the worker's sweep (a poll, and a wake the moment `pg_notify('pim_forge_work')` says there is input), the scheduler's queue deadlines and promotions,
 * the idle-slot release (a sandbox idle for two minutes is bundled, deleted and its slot freed) and the two-stage stall supervision. Returns the function that stops them.
 */
export async function startForgeLoops(parts: ForgeParts, o: ForgeLoopOptions): Promise<() => Promise<void>> {
	const fail = o.onError ?? ((what, error) => console.error(JSON.stringify({ event: "pim.forge.loop_failed", what, error: String((error as Error)?.message ?? error).slice(0, 300) })));
	// A deployment with a sandbox manager and no pool yet gets one, so a first thread can start.
	if (parts.compute && !(await parts.db.query("select 1 from pim_forge.forge_pools limit 1")).rows.length) await parts.scheduler.upsertPool({ poolId: parts.env.PIM_CODING_DEFAULT_POOL ?? "default", provider: parts.compute.id, size: Number(parts.env.PIM_CODING_POOL_SIZE ?? 10) });
	let stopped = false;
	let pending = false;
	let active: Promise<void> | undefined;
	const tick = () => {
		if (stopped) return;
		if (active) return void (pending = true);
		active = (async () => {
			do {
				pending = false;
				await parts.scheduler.sweep().catch((e) => fail("scheduler", e));
				await parts.worker.reap((id) => parts.forge.autosave(id)).catch((e) => fail("reap", e));
				await parts.worker.dispatch().catch((e) => fail("worker", e));
			} while (pending && !stopped);
		})().finally(() => (active = undefined));
	};
	const listener = new pg.Client({ connectionString: o.databaseUrl });
	listener.on("error", (e) => fail("listen", e));
	listener.on("notification", tick);
	await listener.connect();
	await listener.query("LISTEN pim_forge_work");
	const poll = setInterval(tick, o.pollMs ?? 1000);
	const stalls = setInterval(async () => {
		const ids = (await parts.db.query<{ thread_id: string }>("select thread_id from pim_forge.forge_threads where state = 'running'").catch(() => ({ rows: [] }))).rows;
		for (const { thread_id } of ids) await parts.stalls.check(thread_id).catch((e) => fail("stall", e));
	}, o.stallMs ?? 15_000);
	tick();
	return async () => {
		stopped = true;
		clearInterval(poll);
		clearInterval(stalls);
		await listener.end().catch(() => {});
		await active;
		await parts.worker.drain();
	};
}
