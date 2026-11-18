/** What each process role runs. One process may run several (`all-in-one` runs every one): each role adds its handlers and checks to the shared host. */
import { readdirSync, readFileSync } from "node:fs";
import { hostname } from "node:os";
import { join } from "node:path";
import { createModels } from "@earendil-works/pi-ai";
import { createRegistry, type HarnessOptions } from "@earendil-works/pi-durable";
import type { ProcessConfig } from "@pim/v2-contracts/platform";
import { App } from "@pim/v2-app/app";
import { startMemoryNap } from "./memory-nap.ts";
import { installRooms } from "./rooms.ts";
import { OPENAI_ENDPOINTS } from "@pim/v2-app/chatgpt";
import { KeyringCrypto } from "@pim/v2-app/crypto";
import { connect as connectApp } from "@pim/v2-app/db";
import { createGate } from "@pim/v2-app/gate";
import { S3ObjectStore } from "@pim/v2-app/objects";
import { ComputerTriggers } from "./computer-triggers.ts";
import { attachSockets, BROWSER_LIVE, COMPUTER_CONNECT, COMPUTER_SCREEN, NOTES_LIVE } from "@pim/v2-app/sockets";
import { runnerMayStart } from "@pim/v2-ops/backup/reconcile";
import { createPimMetrics, instrumentPool, monitorEventLoop } from "@pim/v2-ops/observability/signals";
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
import { assembleForge, forgeHttp, startForgeLoops } from "./forge-assembly.ts";
import { combineSources, forgeOutboxSource } from "./forge-source.ts";
import { deliverForgeWakes } from "./forge-wakes.ts";
import { codingAdminRoutes, forgeAuthenticator, forgeRoutes, projectedTranscripts, snapshotRoutes } from "./gate-extras.ts";
import { mcpFetchTools } from "./connector-tools.ts";
import { publicUrl } from "./agent-tools.ts";
import { renewDue } from "./watches.ts";
import type { Host } from "./host.ts";
import { AppLiveIdentity, deliverApprovalDecisions, LiveAuthorizer, mirrorCodingGrants, publishRevocations } from "./identity.ts";
import { runtimeOutboxSource } from "./runtime-source.ts";
import { natsRelayBus } from "./relay-bus.ts";
import { notifyPass } from "./notifier.ts";
import { vapidFromEnv } from "./push.ts";
import { startApprovalReviews } from "./approval-review.ts";
import { sweepApprovals, sweepErasures, tickSchedules, tickTriggers, trimForgeOutbox } from "./sweeps.ts";
import { webAssets } from "./web-assets.ts";
import { poolRoutes } from "./compat/admin.ts";
import { webCompatRoutes } from "./compat/index.ts";
import { gateBefore, limitGuestMessages } from "./limits.ts";
import { checkForUpdate } from "./update-check.ts";

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

/** Where Sign in with ChatGPT goes when not to OpenAI's own servers (`PIM_CHATGPT_ISSUER`: a proxy or a test double); unset, OpenAI's. */
const chatgptFromEnv = (env: Env) => (env.PIM_CHATGPT_ISSUER ? { endpoints: { ...OPENAI_ENDPOINTS, issuer: env.PIM_CHATGPT_ISSUER.replace(/\/+$/, "") } } : undefined);

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
	const app = new App(db, objects, { fetchTools: mcpFetchTools({ fetch, allowPrivate: env.PIM_CONNECTOR_ALLOW_PRIVATE === "1", check: publicUrl }), ...(crypto ? { crypto } : {}), ...(env.PIM_APP_SECRET_KEY ? { appKey: env.PIM_APP_SECRET_KEY } : {}), transcripts: projectedTranscripts(db.pool), ...(chatgptFromEnv(env) ? { chatgpt: chatgptFromEnv(env)! } : {}), allowHttpConnectors: env.PIM_CONNECTOR_ALLOW_PRIVATE === "1", env }).limitSpaces();
	installRooms(app);
	if (nats) publishRevocations(app, nats);
	// A computer paired to another process (the `relay` container, another Gate) is reached over NATS.
	if (nats) app.relay.useBus(natsRelayBus(nats));
	deliverApprovalDecisions(app);
	limitGuestMessages(app);
	// What the triggers runtime on a person's computer says over its connection is answered here, in the process that holds the socket.
	app.relay.computerTriggers = new ComputerTriggers(app);
	const secure = config.publicUrl.startsWith("https:");
	const forge = assembleForge(db.pool as never, objects, env, crypto, { scoped: true });
	mirrorCodingGrants(app, forge.authz as never);
	const authenticate = forgeAuthenticator(app, secure);
	// Forge's whole HTTP surface (the coding API, harness logins, the git broker, Gitea, the model gateway), each request under its owner's row-level security scope.
	const coding = forgeHttp(forge, { authenticate, crypto: app.crypto });
	const options = { publicUrl: config.publicUrl, ...(env.PIM_APPS_ORIGIN ? { appsOrigin: env.PIM_APPS_ORIGIN } : {}), routes: [...snapshotRoutes(db.pool), ...codingAdminRoutes(), ...poolRoutes(coding), ...forgeRoutes(coding)],
		// The web app's v1 API over v2's services (packages/v2-server/src/compat/), tried before the built-in routes so its shapes win.
		first: [...webCompatRoutes], before: gateBefore(app, env) };
	const gate = createGate(app, options);
	const listener = gate.listeners("request")[0] as (req: never, res: never) => void;
	const web = webAssets(env.PIM_WEB_DIR);
	if (web) host.handle(web);
	host.handle((req, res) => (listener(req as never, res as never), true));
	// The host owns the server's `upgrade` event and destroys a socket none of its handlers claims, so the Gate's sockets (a computer connecting, the desktop,
	// the browser, notes, a hosted app's own) are claimed by path here rather than listened for on the server.
	const appsHost = env.PIM_APPS_ORIGIN ? new URL(env.PIM_APPS_ORIGIN).hostname : null;
	const gatePath = (req: { url?: string; headers: { host?: string } }) => {
		const path = (req.url ?? "/").split("?")[0] ?? "/";
		return [COMPUTER_CONNECT, COMPUTER_SCREEN, BROWSER_LIVE, NOTES_LIVE].includes(path) || path.startsWith("/hosted/") || (appsHost !== null && (req.headers.host ?? "").split(":")[0]!.endsWith(`.${appsHost}`));
	};
	const gateServer = { on: (_event: "upgrade", listener: (...args: never[]) => void) => host.upgrade((req, socket, head) => (gatePath(req) ? (listener(req as never, socket as never, head as never), true) : false)) };
	const sockets = attachSockets(gateServer as never, app, options);
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
	// With the deployment's keys, so the coding tools see the vault: Amp threads start only when Forge can open the person's Amp key.
	const forge = forgePool && objects ? assembleForge(forgePool as never, objects, env, crypto) : undefined;
	// The computer's tools reach a paired computer over the Relay's bus (NATS). The connection is made when an agent first uses one, so a Runner that never does needs no NATS.
	let relayPulse: Promise<NatsPulse> | undefined;
	const relayBus = async () => natsRelayBus(await (relayPulse ??= NatsPulse.connect(config.natsUrl)));
	const host_ = hooks.harnessOptions ? undefined : createAgentHost({ db, env, crypto, app, forge, relay: relayBus, providers: hooks.providers, fetch: hooks.fetch, ...(chatgptFromEnv(env) ? { chatgpt: { ...chatgptFromEnv(env), ...(env.PIM_CHATGPT_BASE_URL ? { baseUrl: env.PIM_CHATGPT_BASE_URL } : {}) } } : {}), ...(env.PIM_PROVIDER_COOLDOWN_MS ? { cooldowns: { transientMs: Number(env.PIM_PROVIDER_COOLDOWN_MS) } } : {}), stallMs: { ...(env.PIM_MODEL_STALL_MS ? { stream: Number(env.PIM_MODEL_STALL_MS) } : {}), ...(env.PIM_TOOL_TIMEOUT_MS ? { tool: Number(env.PIM_TOOL_TIMEOUT_MS) } : {}) } });
	// While nobody is in a chat, what was said in it is kept as a memory (`./memory-nap.ts`); it needs the host's model catalog and the application's services.
	const stopNap = host_ && app ? startMemoryNap({ pool: runtimePool, db, app, complete: host_.complete, env, onError: (error) => console.error("memory nap", error) }) : undefined;
	const runner = new Runner({
		db,
		harnessOptions: hooks.harnessOptions ?? host_!.harnessOptions,
		...(hooks.homeRoot ?? host_?.homeRoot ? { homeRoot: (hooks.homeRoot ?? host_!.homeRoot)! } : {}),
		...(hooks.chatAgent ?? host_?.chatAgent ? { chatAgent: (hooks.chatAgent ?? host_!.chatAgent)! } : {}),
		steward: { holderId },
		// The run watchdog and how long a stop waits before recycling the partition (`PIM_RUN_STALL_MS`, 0 turns the watchdog off; `PIM_STOP_GRACE_MS`).
		...(env.PIM_RUN_STALL_MS ? { stallMs: Number(env.PIM_RUN_STALL_MS) } : {}),
		...(env.PIM_STOP_GRACE_MS ? { abortGraceMs: Number(env.PIM_STOP_GRACE_MS) } : {}),
		...(hooks.pollMs ? { pollMs: hooks.pollMs } : {}),
		onEvent: (e) => {
			if (e.type === "stalled") console.error("runner", `stopped a stalled run in chat ${e.conversationId} of ${e.ownerId}${e.recycled ? " and recycled its partition" : ""}`);
			if (e.type === "fenced") metrics.fencingRejects.inc({ service: "runner", kind: "lease" });
			if (e.type === "released" || e.type === "drained") metrics.ownershipTransfers.inc({ service: "runner", reason: e.type === "drained" ? "drained" : "released" });
		},
		onReport: (error) => console.error("runner", error),
	});
	const relay = new CommandRelay({ pool: runtimePool, db, inbox: runner.inbox, directory: runner.directory, holder: holderId, onError: (e) => console.error("relay", e) });
	metrics.leasesHeld.collect(() => metrics.leasesHeld.set(runner.residents.length, { service: "runner" }));
	// The majordomo reviews approvals for people whose policy says so; it needs the application's services and the person's models.
	const reviews = host_ && app ? startApprovalReviews({ pool: runtimePool, app, host: host_, defaultPolicy: env.PIM_APPROVAL_POLICY ?? "explicit", onError: (e) => console.error("approval review", e) }) : undefined;
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
			await reviews?.stop();
			await stopNap?.();
			await runner.stop();
			await runtimePool.end();
			await appDb?.end();
			await forgePool?.end();
			await (await relayPulse?.catch(() => undefined))?.close();
		},
	};
}

/** Forge: the coding control plane's worker. It steps threads when a compute provider is configured; without one a coding thread cannot start, and the Gate says so. */
export async function startForge(config: ProcessConfig, env: Env, host: Host, hooks: Hooks): Promise<Role> {
	const forgePool = instrumentPool(pool(config, "forge"), metricsOf(host), "forge", "forge");
	monitorEventLoop(metricsOf(host), "forge");
	const parts = assembleForge(forgePool as never, s3Of(config, env), env, keyringFromProcessEnv(env));
	host.readiness(async () => (await forgePool.query("SELECT 1"), true));
	const stop = await startForgeLoops(parts, { databaseUrl: config.databaseUrl, pollMs: hooks.pollMs });
	return {
		name: "forge",
		async close() {
			await stop();
			await forgePool.end();
		},
	};
}

/** Maintenance: what moves work between schemas that no single service may touch, with the grants only this role holds: Forge's wakes into the chats that started threads, and Forge's costs into the ledger. */
export async function startMaintenance(config: ProcessConfig, env: Env, host: Host, hooks: Hooks): Promise<Role> {
	const maint = instrumentPool(pool(config, "maintenance"), metricsOf(host), "maintenance", "maintenance");
	monitorEventLoop(metricsOf(host), "maintenance");
	const objects = s3Of(config, env);
	const parts = assembleForge(maint as never, objects, env, keyringFromProcessEnv(env));
	const runtime = new RuntimeDb(maint);
	const { PartitionInbox } = await import("@pim/v2-runtime/signals");
	const inbox = new PartitionInbox(runtime);
	const app = connectApp(config.databaseUrl, config.pools.maintenance.max, config.pools.maintenance.statementTimeoutMs);
	app.pool.on("error", () => {});
	const { Usage } = await import("@pim/v2-app/usage");
	const usage = new Usage(app);
	let lastTrim = 0;
	let lastTriggers = 0;
	const { App } = await import("@pim/v2-app/app");
	const sweeper = new App(app, objects, { env }).limitSpaces();
	const notifier = { vapid: vapidFromEnv(env), subject: env.PIM_VAPID_SUBJECT || config.publicUrl, allowPrivate: env.PIM_PUSH_ALLOW_PRIVATE === "1" };
	const keys = keyringFromProcessEnv(env);
	let lastRenewal = 0;
	let lastUpdateCheck = 0;
	const pass = async () => {
		// Whether a newer image is published on this instance's channel: a look at the registry is due a few times a day (`update-check.ts`), and this asks whether one is due every ten minutes.
		if (Date.now() - lastUpdateCheck > 600_000) {
			lastUpdateCheck = Date.now();
			await checkForUpdate(app, env).catch((e) => console.error("update check", e));
		}
		// Watches' grants that are running out are asked for again (`watches.ts`), once a minute.
		if (keys && Date.now() - lastRenewal > 60_000) {
			lastRenewal = Date.now();
			await renewDue({ app: new App(app, objects, { crypto: keys }), crypto: keys, transport: { fetch, allowPrivate: env.PIM_CONNECTOR_ALLOW_PRIVATE === "1", check: publicUrl }, publicUrl: env.PIM_PUBLIC_URL, now: Date.now }, maint).catch((e) => console.error("watch renewal", e));
		}
		await sweepApprovals(sweeper, maint).catch((e) => console.error("approval sweep", e));
		// Schedules and time triggers fire from here: a schedule's due time is looked up every pass, the triggers' every few seconds.
		await tickSchedules(sweeper).catch((e) => console.error("schedule sweep", e));
		if (Date.now() - lastTriggers > 5_000) {
			lastTriggers = Date.now();
			await tickTriggers(sweeper, maint).catch((e) => console.error("trigger sweep", e));
		}
		if (Date.now() - lastTrim > 60_000) {
			lastTrim = Date.now();
			await sweepErasures(sweeper, maint, objects).catch((e) => console.error("erasure sweep", e));
			await trimForgeOutbox(maint).catch((e) => console.error("outbox trim", e));
		}
		await deliverForgeWakes({ forge: parts.forge, forgeDb: maint as never, runtime, inbox, onUnroutable: (id, why) => console.warn("wake dropped", id, why) });
		await deliverCosts({ forge: parts.forge, forgeDb: maint as never, usage, onUnroutable: (id, why) => console.warn("cost dropped", id, why) });
		await notifyPass(sweeper, maint, notifier).catch((e) => console.error("notifications", e));
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
