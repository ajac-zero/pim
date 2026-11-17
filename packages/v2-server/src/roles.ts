/** What each process role runs. One process may run several (`all-in-one` runs every one): each role adds its handlers and checks to the shared host. */
import { readdirSync, readFileSync } from "node:fs";
import { hostname } from "node:os";
import { join } from "node:path";
import { createModels } from "@earendil-works/pi-ai";
import { createRegistry, type HarnessOptions } from "@earendil-works/pi-durable";
import type { ProcessConfig } from "@pim/v2-contracts/platform";
import { App } from "@pim/v2-app/app";
import { KeyringCrypto } from "@pim/v2-app/crypto";
import { connect as connectApp } from "@pim/v2-app/db";
import { createGate } from "@pim/v2-app/gate";
import { S3ObjectStore } from "@pim/v2-app/objects";
import { attachSockets } from "@pim/v2-app/sockets";
import { runnerMayStart } from "@pim/v2-ops/backup/reconcile";
import { createPimMetrics, instrumentPool, monitorEventLoop } from "@pim/v2-ops/observability/signals";
import { codingRest } from "@pim/v2-forge/http/rest";
import { compose } from "@pim/v2-forge/http/index";
import { codingVault } from "@pim/v2-forge/http/vault";
import { modelGateway } from "@pim/v2-forge/http/gateway";
import { ForgeVault } from "@pim/v2-forge/vault";
import { Projector } from "@pim/v2-live/projections/projector";
import { LiveHub } from "@pim/v2-live/server/hub";
import { LogStore } from "@pim/v2-live/server/log-store";
import { NatsPulse } from "@pim/v2-live/server/pulse";
import { liveEndpoint } from "@pim/v2-live/server/ws-server";
import { runtimePoolConfig, Db as RuntimeDb } from "@pim/v2-runtime/db";
import { Runner, type RunnerOptions } from "@pim/v2-runtime/runner";
import pg from "pg";
import { createAgentHost, type AgentHostOptions } from "./agent-host.ts";
import { CommandRelay } from "./command-relay.ts";
import { deliverCosts } from "./deliveries.ts";
import { assembleForge } from "./forge-assembly.ts";
import { combineSources, forgeOutboxSource } from "./forge-source.ts";
import { deliverForgeWakes } from "./forge-wakes.ts";
import { codingAdminRoutes, forgeAuthenticator, forgeRoutes, projectedTranscripts, snapshotRoutes } from "./gate-extras.ts";
import type { Host } from "./host.ts";
import { AppLiveIdentity, deliverApprovalDecisions, LiveAuthorizer, mirrorCodingGrants, publishRevocations } from "./identity.ts";
import { runtimeOutboxSource } from "./runtime-source.ts";
import { sweepApprovals, trimForgeOutbox } from "./sweeps.ts";

export type Env = Record<string, string | undefined>;
export type Hooks = {
	/** What a Runner's agents run with: the model providers and the tool registry. The deployment supplies them; none are configured by default. */
	harnessOptions?: RunnerOptions["harnessOptions"];
	homeRoot?: RunnerOptions["homeRoot"];
	chatAgent?: RunnerOptions["chatAgent"];
	/** Model providers added to every owner's catalog by the default agent host, which runs the agents when `harnessOptions` is not given. */
	providers?: AgentHostOptions["providers"];
	fetch?: AgentHostOptions["fetch"];
	/** How often the loops that move work between processes look for it, in ms. */
	pollMs?: number;
};
export type Role = { name: string; close(): Promise<void> };

/** The envelope-encryption keys: `PIM_KEK_<id>` variables and files named `<id>` in `PIM_KEK_DIR`, each a base64 32-byte key; `PIM_KEK_CURRENT` names the one that wraps new keys. */
export function keyringFromProcessEnv(env: Env): KeyringCrypto | undefined {
	const keys: Record<string, Uint8Array> = {};
	for (const [name, value] of Object.entries(env)) {
		const id = /^PIM_KEK_(?!CURRENT$|DIR$)(.+)$/.exec(name)?.[1];
		if (id && value) keys[id.toLowerCase()] = new Uint8Array(Buffer.from(value, "base64"));
	}
	if (env.PIM_KEK_DIR) for (const file of readdirSync(env.PIM_KEK_DIR)) if (!file.startsWith(".")) keys[file.toLowerCase()] = new Uint8Array(Buffer.from(readFileSync(join(env.PIM_KEK_DIR, file), "utf8").trim(), "base64"));
	if (Object.keys(keys).length === 0) return undefined;
	return new KeyringCrypto((env.PIM_KEK_CURRENT ?? Object.keys(keys).at(-1)!).toLowerCase(), keys);
}

/** One set of metrics per process, whatever roles it runs: the registry refuses a name twice. */
const metricsByHost = new WeakMap<Host, ReturnType<typeof createPimMetrics>>();
const metricsOf = (host: Host) => {
	let m = metricsByHost.get(host);
	if (!m) metricsByHost.set(host, (m = createPimMetrics(host.registry)));
	return m;
};

const s3Of = (config: ProcessConfig, env: Env) =>
	new S3ObjectStore(config.s3.bucket, { endpoint: config.s3.endpoint, region: config.s3.region, ...(env.PIM_S3_ACCESS_KEY && env.PIM_S3_SECRET_KEY ? { credentials: { accessKeyId: env.PIM_S3_ACCESS_KEY, secretAccessKey: env.PIM_S3_SECRET_KEY } } : {}) });

const pool = (config: ProcessConfig, name: keyof ProcessConfig["pools"]) => {
	const b = config.pools[name];
	return new pg.Pool({ connectionString: config.databaseUrl, max: b.max, idleTimeoutMillis: b.idleTimeoutMs, statement_timeout: b.statementTimeoutMs }).on("error", () => {});
};

/** The Gate: the application's HTTP API and sockets, the projections' snapshots, Forge's coding API. It also runs the Canvas and Relay sockets, which `canvas` and `relay` containers serve with the same code. */
export async function startGate(config: ProcessConfig, env: Env, host: Host, nats?: NatsPulse): Promise<Role> {
	const metrics = metricsOf(host);
	const db = connectApp(config.databaseUrl, config.pools.foreground.max, config.pools.foreground.statementTimeoutMs);
	db.pool.on("error", () => {});
	instrumentPool(db.pool, metrics, "gate");
	const objects = s3Of(config, env);
	const crypto = keyringFromProcessEnv(env);
	const app = new App(db, objects, { ...(crypto ? { crypto } : {}), ...(env.PIM_APP_SECRET_KEY ? { appKey: env.PIM_APP_SECRET_KEY } : {}), transcripts: projectedTranscripts(db.pool) });
	if (nats) publishRevocations(app, nats);
	deliverApprovalDecisions(app);
	const secure = config.publicUrl.startsWith("https:");
	const forge = assembleForge(db.pool as never, objects, env);
	mirrorCodingGrants(app, forge.authz as never);
	const authenticate = forgeAuthenticator(app, secure);
	// The rest of Forge's HTTP surface: a person's harness logins, sealed under the deployment's keys; and the model gateway, only where the deployment holds a provider key.
	// The git broker and the Gitea connection need a git host and a Gitea configuration this process does not build: they are not mounted.
	const gatewayKeys: Record<string, string | undefined> = { anthropic: env.PIM_CODING_ANTHROPIC_API_KEY, openai: env.PIM_CODING_OPENAI_API_KEY };
	const coding = compose(
		codingRest({ forge: forge.forge, scheduler: forge.scheduler, store: forge.store, db: forge.db, authenticate }),
		codingVault({ vault: new ForgeVault(forge.db, app.crypto as never), authenticate }),
		gatewayKeys.anthropic || gatewayKeys.openai ? modelGateway({ credentials: forge.credentials, store: forge.store, key: async (_thread, family) => (gatewayKeys[family] ? { apiKey: gatewayKeys[family]! } : null) }) : null,
	);
	const options = { publicUrl: config.publicUrl, ...(env.PIM_APPS_ORIGIN ? { appsOrigin: env.PIM_APPS_ORIGIN } : {}), routes: [...snapshotRoutes(db.pool), ...codingAdminRoutes(), ...forgeRoutes(coding)] };
	const gate = createGate(app, options);
	const listener = gate.listeners("request")[0] as (req: never, res: never) => void;
	host.handle((req, res) => (listener(req as never, res as never), true));
	const sockets = attachSockets(host.server, app, options);
	host.readiness(async () => (await db.anonymous((tx) => tx.query("SELECT 1")), true));
	const stopLoop = monitorEventLoop(metrics, "gate");
	return {
		name: "gate",
		async close() {
			stopLoop();
			sockets.close();
			await db.end();
		},
	};
}

/** The loop that keeps projections current: a wake when the runtime commits (`pg_notify`), and a poll that also catches Forge's feed and anything a lost wake missed. */
function projectorLoop(projector: Projector, listenerUrl: string, pollMs: number): () => Promise<void> {
	let running = true;
	let pending = false;
	let active: Promise<void> | undefined;
	const run = () => {
		if (active) return void (pending = true);
		active = projector
			.drainAll()
			.catch((error) => console.error("projector", error))
			.finally(() => {
				active = undefined;
				if (pending && running) {
					pending = false;
					run();
				}
			}) as Promise<void>;
	};
	const timer = setInterval(run, pollMs);
	const listener = new pg.Client({ connectionString: listenerUrl });
	listener.on("error", () => {});
	void listener.connect().then(() => listener.query("LISTEN pim_runtime_outbox")).catch(() => undefined);
	listener.on("notification", run);
	return async () => {
		running = false;
		clearInterval(timer);
		await listener.end().catch(() => undefined);
		await active;
	};
}

/** Live: the WebSocket at `/api/ws`, the snapshots, and the projector. Stateless: any replica serves any reconnect from a cursor. */
export async function startLive(config: ProcessConfig, env: Env, host: Host, hooks: Hooks, pulse: NatsPulse): Promise<Role> {
	const metrics = metricsOf(host);
	const live = instrumentPool(pool(config, "foreground"), metrics, "live");
	const secure = config.publicUrl.startsWith("https:");
	const hub = new LiveHub(new LogStore(live), pulse, new AppLiveIdentity(live, secure), new LiveAuthorizer());
	const endpoint = liveEndpoint(hub, live, { paths: ["/api/ws", "/live"] });
	host.handle((req, res) => {
		if (!(req.url ?? "").startsWith("/snapshot/")) return false;
		void endpoint.snapshot(req, res);
		return true;
	});
	host.upgrade((req, socket, head) => endpoint.upgrade(req, socket, head));
	const projector = new Projector(live, { pulse, source: combineSources(runtimeOutboxSource(live), forgeOutboxSource(live)) });
	const stopLoop = projectorLoop(projector, config.databaseUrl, hooks.pollMs ?? 500);
	metrics.websockets.collect(() => metrics.websockets.set(hub.connections, { service: "live" }));
	metrics.projectionLag.collect(async () => {
		const lags = await projector.lag().catch(() => []);
		metrics.projectionLag.set(Math.max(0, ...lags.map((l) => l.oldestUnprojectedAgeMs / 1000)), { service: "live", projection: "all" });
	});
	host.readiness(async () => (await live.query("SELECT 1"), true));
	return {
		name: "live",
		async close() {
			endpoint.close();
			await hub.close();
			await stopLoop();
			await live.end();
		},
	};
}

/** A Runner may claim work only once any restore has had its safety pass: until then it is alive but not ready. */
export async function startRunner(config: ProcessConfig, env: Env, host: Host, hooks: Hooks): Promise<Role> {
	const metrics = metricsOf(host);
	const runtimePool = pool(config, "runtime");
	const db = new RuntimeDb(runtimePool);
	instrumentPool(runtimePool, metrics, "runner", "runtime");
	const holderId = config.runnerHolderId ?? `${hostname()}-${process.pid}`;
	// What runs the agents: the injected options when a test or a deployment supplies them, else the portable agent host with the application's and Forge's services when this
	// Runner was given their databases (`PIM_APP_DATABASE_URL`, `PIM_FORGE_DATABASE_URL`).
	const crypto = keyringFromProcessEnv(env);
	const appDb = !hooks.harnessOptions && env.PIM_APP_DATABASE_URL ? connectApp(env.PIM_APP_DATABASE_URL, 4, config.pools.foreground.statementTimeoutMs) : undefined;
	appDb?.pool.on("error", () => {});
	const forgePool = !hooks.harnessOptions && env.PIM_FORGE_DATABASE_URL ? new pg.Pool({ connectionString: env.PIM_FORGE_DATABASE_URL, max: 4 }).on("error", () => {}) : undefined;
	const objects = appDb || forgePool ? s3Of(config, env) : undefined;
	const app = appDb && objects ? new App(appDb, objects, { ...(crypto ? { crypto } : {}), ...(env.PIM_APP_SECRET_KEY ? { appKey: env.PIM_APP_SECRET_KEY } : {}) }) : undefined;
	const forge = forgePool && objects ? assembleForge(forgePool as never, objects, env) : undefined;
	const host_ = hooks.harnessOptions ? undefined : createAgentHost({ db, env, crypto, app, forge, providers: hooks.providers, fetch: hooks.fetch });
	const runner = new Runner({
		db,
		harnessOptions: hooks.harnessOptions ?? host_!.harnessOptions,
		...(hooks.homeRoot ?? host_?.homeRoot ? { homeRoot: (hooks.homeRoot ?? host_!.homeRoot)! } : {}),
		...(hooks.chatAgent ?? host_?.chatAgent ? { chatAgent: (hooks.chatAgent ?? host_!.chatAgent)! } : {}),
		steward: { holderId },
		...(hooks.pollMs ? { pollMs: hooks.pollMs } : {}),
		onEvent: (e) => {
			if (e.type === "fenced") metrics.fencingRejects.inc({ service: "runner", kind: "lease" });
			if (e.type === "released" || e.type === "drained") metrics.ownershipTransfers.inc({ service: "runner", reason: e.type === "drained" ? "drained" : "released" });
		},
		onReport: (error) => console.error("runner", error),
	});
	const relay = new CommandRelay({ pool: runtimePool, db, inbox: runner.inbox, directory: runner.directory, holder: holderId, onError: (e) => console.error("relay", e) });
	metrics.leasesHeld.collect(() => metrics.leasesHeld.set(runner.residents.length, { service: "runner" }));
	let started = false;
	let stopped = false;
	const tryStart = async () => {
		if (started || stopped) return;
		if (!(await runnerMayStart(runtimePool))) return;
		started = true;
		await runner.start();
		relay.start(hooks.pollMs ?? 100);
	};
	await tryStart().catch((error) => console.error("runner start", error));
	const retry = setInterval(() => void tryStart().catch((error) => console.error("runner start", error)), 2_000);
	host.readiness(() => started && !stopped);
	const drain = async () => {
		stopped = true;
		relay.stop();
		if (started) await runner.drain(Number(env.PIM_DRAIN_WINDOW_SECONDS ?? 90) * 1000);
	};
	host.onDrain(drain);
	return {
		name: "runner",
		async close() {
			stopped = true;
			clearInterval(retry);
			relay.stop();
			await runner.stop();
			await runtimePool.end();
			await appDb?.end();
			await forgePool?.end();
		},
	};
}

/** Forge: the coding control plane's worker. It steps threads when a compute provider is configured; without one a coding thread cannot start, and the Gate says so. */
export async function startForge(config: ProcessConfig, env: Env, host: Host, hooks: Hooks): Promise<Role> {
	const forgePool = instrumentPool(pool(config, "forge"), metricsOf(host), "forge", "forge");
	monitorEventLoop(metricsOf(host), "forge");
	const parts = assembleForge(forgePool as never, s3Of(config, env), env);
	host.readiness(async () => (await forgePool.query("SELECT 1"), true));
	void hooks;
	return { name: "forge", close: () => forgePool.end() };
}

/** Maintenance: what moves work between schemas that no single service may touch, with the grants only this role holds: Forge's wakes into the chats that started threads, and Forge's costs into the ledger. */
export async function startMaintenance(config: ProcessConfig, env: Env, host: Host, hooks: Hooks): Promise<Role> {
	const maint = instrumentPool(pool(config, "maintenance"), metricsOf(host), "maintenance", "maintenance");
	monitorEventLoop(metricsOf(host), "maintenance");
	const objects = s3Of(config, env);
	const parts = assembleForge(maint as never, objects, env);
	const runtime = new RuntimeDb(maint);
	const { PartitionInbox } = await import("@pim/v2-runtime/signals");
	const inbox = new PartitionInbox(runtime);
	const app = connectApp(config.databaseUrl, config.pools.maintenance.max, config.pools.maintenance.statementTimeoutMs);
	app.pool.on("error", () => {});
	const { Usage } = await import("@pim/v2-app/usage");
	const usage = new Usage(app);
	let lastTrim = 0;
	const { App } = await import("@pim/v2-app/app");
	const sweeper = new App(app, objects);
	const pass = async () => {
		await sweepApprovals(sweeper, maint).catch((e) => console.error("approval sweep", e));
		if (Date.now() - lastTrim > 60_000) {
			lastTrim = Date.now();
			await trimForgeOutbox(maint).catch((e) => console.error("outbox trim", e));
		}
		await deliverForgeWakes({ forge: parts.forge, forgeDb: maint as never, runtime, inbox, onUnroutable: (id, why) => console.warn("wake dropped", id, why) });
		await deliverCosts({ forge: parts.forge, forgeDb: maint as never, usage, onUnroutable: (id, why) => console.warn("cost dropped", id, why) });
	};
	let running = true;
	let active: Promise<void> | undefined;
	const timer = setInterval(() => {
		if (!active) active = pass().catch((e) => console.error("maintenance", e)).finally(() => (active = undefined)) as Promise<void>;
	}, hooks.pollMs ?? 500);
	host.readiness(async () => (await maint.query("SELECT 1"), running));
	return {
		name: "maintenance",
		async close() {
			running = false;
			clearInterval(timer);
			await active;
			await app.end();
			await maint.end();
		},
	};
}

export { NatsPulse };
