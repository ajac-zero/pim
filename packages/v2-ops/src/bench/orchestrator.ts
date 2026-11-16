import { type ChildProcess, fork, spawn } from "node:child_process";
import { closeSync, existsSync, fsyncSync, openSync, readFileSync, readdirSync, writeSync } from "node:fs";
import { cpus, totalmem, tmpdir } from "node:os";
import { join } from "node:path";
import pg from "pg";
import { loadMigrations, migrate } from "../pg/migrate.ts";
import { startEmbeddedPostgres } from "../pg/embedded.ts";
import { DEFAULT_PHASES, DEFAULT_WORKLOAD, type PhaseTimes, type Profile, type Workload } from "./profiles.ts";
import { seed } from "./schema.ts";

const PROC = new URL("./proc.ts", import.meta.url).pathname;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export type BenchResult = ReturnType<typeof summarize>;

/** Finds the NATS server binary: PIM_NATS_BIN, or the one scripts/v2-bench/install-nats.sh downloads. */
export function natsBinary(): string {
	if (process.env.PIM_NATS_BIN) return process.env.PIM_NATS_BIN;
	const cache = join(process.env.HOME ?? "", ".cache", "pim-bench");
	const dir = existsSync(cache) ? readdirSync(cache).find((d) => d.startsWith("nats-server-v")) : undefined;
	if (!dir) throw new Error("No NATS server found: run scripts/v2-bench/install-nats.sh or set PIM_NATS_BIN");
	return join(cache, dir, "nats-server");
}

type Msg = { ready?: boolean; done?: boolean; stats?: any };
const child = (role: string, config: unknown) => fork(PROC, [role, JSON.stringify(config)], { stdio: ["ignore", "inherit", "inherit", "ipc"] });
const once = (c: ChildProcess, pick: (m: Msg) => boolean) => new Promise<Msg>((resolve, reject) => {
	const onMessage = (m: Msg) => {
		if (pick(m)) {
			c.off("message", onMessage);
			resolve(m);
		}
	};
	c.on("message", onMessage);
	c.once("exit", (code) => reject(new Error(`child exited (${code}) before answering`)));
});
const ask = async (c: ChildProcess) => {
	c.send({ type: "stats" });
	return (await once(c, (m) => m.stats !== undefined)).stats;
};

/** Machine-wide CPU busy fraction between two samples of /proc/stat, and the resident memory of a set of processes. */
function cpuTimes() {
	const [, ...f] = readFileSync("/proc/stat", "utf8").split("\n")[0]!.split(/\s+/).map(Number);
	const idle = (f[3] ?? 0) + (f[4] ?? 0);
	return { idle, total: f.reduce((a, b) => a + b, 0) };
}
function rssKb(pids: number[]): number {
	let sum = 0;
	for (const pid of pids) {
		try {
			sum += Number(/VmRSS:\s+(\d+)/.exec(readFileSync(`/proc/${pid}/status`, "utf8"))?.[1] ?? 0);
		} catch {}
	}
	return sum;
}
function pidsNamed(prefix: string): number[] {
	return readdirSync("/proc").filter((d) => /^\d+$/.test(d)).filter((d) => {
		try {
			return readFileSync(`/proc/${d}/comm`, "utf8").trim().startsWith(prefix);
		} catch {
			return false;
		}
	}).map(Number);
}

/** Median time of an 8 KB write + fsync on the temp directory's filesystem: the floor under any synchronous commit here. */
function fsyncMedianMs(dir: string): number {
	const path = join(dir, "fsync-probe");
	const fd = openSync(path, "w");
	const buf = Buffer.alloc(8192, 1);
	const times: number[] = [];
	for (let i = 0; i < 200; i++) {
		const t = performance.now();
		writeSync(fd, buf);
		fsyncSync(fd);
		times.push(performance.now() - t);
	}
	closeSync(fd);
	return times.sort((a, b) => a - b)[100]!;
}

export type RunOptions = { profile: Profile; workload?: Partial<Workload>; phases?: Partial<PhaseTimes>; entriesPerIdleChat?: number; log?: (line: string) => void };

export async function runBenchmark(options: RunOptions) {
	const { profile } = options;
	const workload: Workload = { ...DEFAULT_WORKLOAD, ...options.workload };
	const phases: PhaseTimes = { ...DEFAULT_PHASES, ...options.phases };
	const log = options.log ?? (() => undefined);
	const procs: ChildProcess[] = [];
	let nats: ChildProcess | undefined;
	const server = await startEmbeddedPostgres({ settings: { max_connections: "600", shared_buffers: "256MB", track_io_timing: "on", track_wal_io_timing: "on", wal_buffers: "16MB", max_wal_size: "2GB", checkpoint_timeout: "15min" } });
	try {
		await server.createDatabase("bench");
		const dbUrl = server.url("bench");
		const admin = new pg.Pool({ connectionString: dbUrl, max: 4 });
		await migrate(admin, await loadMigrations());
		const t0 = performance.now();
		const seeded = await seed(admin, { tenants: profile.tenants, activeRuns: profile.activeRuns, idleChatsPerTenant: profile.idleChatsPerTenant, entriesPerIdleChat: options.entriesPerIdleChat ?? 20 });
		log(`seeded ${seeded.tenants.length} tenants, ${seeded.idleChats} idle chats, ${seeded.idleEntries} idle entries, ${seeded.runs.length} active runs in ${((performance.now() - t0) / 1000).toFixed(1)} s`);

		const natsPort = 30000 + Math.floor(Math.random() * 10000);
		nats = spawn(natsBinary(), ["-a", "127.0.0.1", "-p", String(natsPort)], { stdio: "ignore" });
		await sleep(500);
		const natsUrl = `127.0.0.1:${natsPort}`;
		const base = 41000 + Math.floor(Math.random() * 10000);
		const ports = { provider: base, gate: base + 1, live: base + 2 };
		const spawnReady = async (role: string, config: unknown) => {
			const c = child(role, config);
			procs.push(c);
			await once(c, (m) => m.ready === true);
			log(`${role} ready`);
			return c;
		};
		await spawnReady("provider", { port: ports.provider, workload });
		const gate = await spawnReady("gate", { port: ports.gate, dbUrl, pool: 10 });
		const live = await spawnReady("live", { port: ports.live, natsUrl });
		const sample = seeded.runs.slice(0, Math.min(seeded.runs.length, 200));
		const browsers = await spawnReady("browsers", { count: profile.browsers, slow: profile.slowBrowsers, tenants: seeded.tenants, livePort: ports.live, gatePort: ports.gate, sample, probers: 4, thinkMs: 10 });
		const runners: ChildProcess[] = [];
		const totalMs = (phases.rampSeconds + phases.loadedSeconds + 4) * 1000;
		for (let i = 0; i < profile.runnerProcesses; i++) {
			const assigned = seeded.runs.filter((_, k) => k % profile.runnerProcesses === i);
			runners.push(await spawnReady("runner", { index: i, runs: assigned, dbUrl, natsUrl, providerPort: ports.provider, workload, durationMs: totalMs, floods: Math.ceil(profile.codingFloods / profile.runnerProcesses) }));
		}
		browsers.send({ type: "phase", phase: "idle" });

		// Baseline: foreground reads with nothing running.
		await sleep(1000);
		browsers.send({ type: "phase", phase: "warm" });
		await sleep(2000);
		browsers.send({ type: "phase", phase: "baseline" });
		await sleep(phases.baselineSeconds * 1000);
		browsers.send({ type: "phase", phase: "idle" });

		// Load.
		const pgBefore = await pgCounters(admin);
		runners.forEach((r) => r.send({ type: "go" }));
		await sleep(phases.rampSeconds * 1000);
		browsers.send({ type: "phase", phase: "warm2" });
		await sleep(1500);
		browsers.send({ type: "phase", phase: "loaded" });
		const cpu0 = cpuTimes();
		const mem: { pg: number; node: number }[] = [];
		const pgBefore2 = await pgCounters(admin);
		const runnersAtStart = await Promise.all(runners.map(ask));
		const loadedStart = performance.now();
		const memTimer = setInterval(() => mem.push({ pg: rssKb(pidsNamed("postgres")), node: rssKb(procs.map((p) => p.pid!).concat(process.pid)) }), 1000);
		await sleep(phases.loadedSeconds * 1000);
		clearInterval(memTimer);
		const loadedSeconds = (performance.now() - loadedStart) / 1000;
		const cpu1 = cpuTimes();
		const pgAfter = await pgCounters(admin);
		browsers.send({ type: "phase", phase: "idle" });
		const runnerStats = await Promise.all(runners.map(ask));
		const commitsInWindow = runnerStats.reduce((n, s) => n + s.commits, 0) - runnersAtStart.reduce((n, s) => n + s.commits, 0);
		const partialsInWindow = runnerStats.reduce((n, s) => n + s.partials, 0) - runnersAtStart.reduce((n, s) => n + s.partials, 0);
		const gateStats = await ask(gate);
		const liveStats = await ask(live);
		const browserStats = await ask(browsers);
		const settings = Object.fromEntries((await admin.query("SELECT name, setting FROM pg_settings WHERE name IN ('fsync','synchronous_commit','full_page_writes','shared_buffers','max_connections','wal_level')")).rows.map((r) => [r.name, r.setting]));
		const version = (await admin.query("SHOW server_version")).rows[0].server_version;
		const rows = (await admin.query("SELECT (SELECT count(*) FROM pim.pi_entries) AS entries, (SELECT count(*) FROM pim.bench_coding_events) AS flood")).rows[0];
		browsers.send({ type: "phase", phase: "stop" });
		runners.forEach((r) => r.send({ type: "stop" }));
		await admin.end();
		void pgBefore;
		return summarize({ commitsInWindow, partialsInWindow, profile, workload, phases, seeded, runnerStats, gateStats, liveStats, browserStats, pgBefore: pgBefore2, pgAfter, loadedSeconds, cpu: { busy: 1 - (cpu1.idle - cpu0.idle) / (cpu1.total - cpu0.total) }, mem, env: { cpus: cpus().length, cpuModel: cpus()[0]?.model, memGb: +(totalmem() / 2 ** 30).toFixed(1), node: process.version, postgres: version, settings, fsyncMedianMs: +fsyncMedianMs(tmpdir()).toFixed(3) }, rows });
	} finally {
		for (const p of procs) p.kill("SIGKILL");
		nats?.kill("SIGKILL");
		await server.stop();
	}
}

async function pgCounters(pool: pg.Pool) {
	const db = (await pool.query("SELECT xact_commit, xact_rollback, blks_read, blks_hit, tup_inserted, tup_updated FROM pg_stat_database WHERE datname = 'bench'")).rows[0];
	let walSync: { fsyncs: number; fsyncMs: number } | null = null;
	try {
		// PostgreSQL 17: pg_stat_wal counts WAL flushes (wal_sync) and, with track_wal_io_timing on, their time in ms.
		const w = (await pool.query("SELECT wal_sync, wal_sync_time FROM pg_stat_wal")).rows[0];
		walSync = { fsyncs: Number(w.wal_sync), fsyncMs: Number(w.wal_sync_time) };
	} catch {}
	return { xact: Number(db.xact_commit), rollback: Number(db.xact_rollback), inserted: Number(db.tup_inserted), updated: Number(db.tup_updated), walSync };
}

const round = (v: number | null, d = 2) => (v === null ? null : +v.toFixed(d));
const r2 = (s: any) => (s ? { n: s.n, p50: round(s.p50), p95: round(s.p95), p99: round(s.p99), max: round(s.max), mean: round(s.mean) } : null);

function summarize(i: any) {
	const seconds = i.loadedSeconds as number;
	const rs = i.runnerStats as any[];
	const commits = rs.reduce((n, s) => n + s.commits, 0);
	const base = i.browserStats.probes.baseline;
	const loaded = i.browserStats.probes.loaded;
	const regress = (a: number | null, b: number | null) => (a && b ? round(((b - a) / a) * 100, 1) : null);
	const both = (b: any, f: string) => b?.[f]?.p95 ?? null;
	const slo = {
		sidebarP95Ms: round(both(loaded, "sidebar")),
		sessionP95Ms: round(both(loaded, "session")),
		absoluteUnder250ms: (both(loaded, "sidebar") ?? 1e9) < 250 && (both(loaded, "session") ?? 1e9) < 250,
		sidebarRegressionPct: regress(both(base, "sidebar"), both(loaded, "sidebar")),
		sessionRegressionPct: regress(both(base, "session"), both(loaded, "session")),
	};
	const relOk = (slo.sidebarRegressionPct ?? 1e9) <= 20 && (slo.sessionRegressionPct ?? 1e9) <= 20;
	const loopMax = Math.max(...rs.map((s) => s.loop.maxMs), i.gateStats.loop.maxMs, i.liveStats.loop.maxMs);
	const expectedTurnMs = i.workload.ttftMs + i.workload.tokensPerTurn * i.workload.tokenIntervalMs + i.workload.toolLatencyMs + i.workload.turnPauseMs;
	const turns = rs.reduce((n, s) => n + s.turns, 0);
	const late = rs.reduce((n, s) => n + s.lateTurns, 0);
	return {
		profile: i.profile.name,
		activeStreamingRuns: i.profile.activeRuns,
		tenants: i.profile.tenants,
		idleStoredChats: i.seeded.idleChats,
		idleStoredEntries: i.seeded.idleEntries,
		workload: i.workload,
		phases: i.phases,
		environment: i.env,
		measuredSeconds: round(seconds, 1),
		foreground: {
			baseline: { sidebar: r2(base?.sidebar), session: r2(base?.session), errors: base?.errors },
			underLoad: { sidebar: r2(loaded?.sidebar), session: r2(loaded?.session), errors: loaded?.errors },
			slo: { ...slo, relativeWithin20pct: relOk, passesBoth: slo.absoluteUnder250ms && relOk, note: "The relative test compares warm p95 under load with warm p95 at baseline, measured in the same run." },
		},
		write: {
			commits,
			commitsPerSecondInWindow: round(i.commitsInWindow / seconds, 1),
			commitsPerSecondPerActiveRun: round(i.commitsInWindow / seconds / i.profile.activeRuns, 2),
			commitLatencyMsByRunner: rs.map((s) => r2(s.commit)),
			partialsPerSecondPerRun: round(i.partialsInWindow / seconds / i.profile.activeRuns, 2),
			fencingRejects: rs.reduce((n, s) => n + s.fencingRejects, 0),
			providerErrors: rs.reduce((n, s) => n + s.providerErrors, 0),
			turnsCompleted: turns,
			turnsMuchLaterThanTwiceExpected: late,
			expectedTurnMs,
			codingFloodRows: rs.reduce((n, s) => n + s.floodEvents, 0),
		},
		postgres: {
			transactionsPerSecondIncludingReads: round((i.pgAfter.xact - i.pgBefore.xact) / seconds, 1),
			rowsInsertedPerSecond: round((i.pgAfter.inserted - i.pgBefore.inserted) / seconds, 1),
			rowsUpdatedPerSecond: round((i.pgAfter.updated - i.pgBefore.updated) / seconds, 1),
			walFsyncsPerSecond: i.pgAfter.walSync && i.pgBefore.walSync ? round((i.pgAfter.walSync.fsyncs - i.pgBefore.walSync.fsyncs) / seconds, 1) : null,
			walFsyncMeanMs: i.pgAfter.walSync && i.pgBefore.walSync && i.pgAfter.walSync.fsyncs > i.pgBefore.walSync.fsyncs ? round((i.pgAfter.walSync.fsyncMs - i.pgBefore.walSync.fsyncMs) / (i.pgAfter.walSync.fsyncs - i.pgBefore.walSync.fsyncs), 3) : null,
			rollbacks: i.pgAfter.rollback - i.pgBefore.rollback,
		},
		resources: {
			machineCpuBusyPct: round(i.cpu.busy * 100, 1),
			postgresRssMbMax: round(Math.max(...i.mem.map((m: any) => m.pg)) / 1024, 0),
			nodeProcessesRssMbMax: round(Math.max(...i.mem.map((m: any) => m.node)) / 1024, 0),
			maxEventLoopDelayMs: round(loopMax, 1),
			gatePool: i.gateStats.pool,
		},
		live: { websocketsOpen: i.browserStats.ws.open, websocketsRequested: i.browserStats.ws.clients, eventsReceived: i.browserStats.ws.events, deliveryLagMs: r2(i.browserStats.ws.lagMs), coalesced: i.liveStats.coalesced, overflowDisconnects: i.liveStats.overflowed, liveEventLoopMaxMs: round(i.liveStats.loop.maxMs, 1) },
		saturation: {
			// A run is "behind" when its turn took more than twice the time the simulated model and tool needed.
			fractionOfTurnsMuchLate: turns ? round(late / turns, 3) : null,
			commitP99Ms: round(Math.max(...rs.map((s) => s.commit.p99 ?? 0))),
			verdict: late / Math.max(turns, 1) > 0.1 || loopMax > 500 ? "saturated: runs fall behind or the event loop stalls" : "keeping up",
		},
		dataRows: i.rows,
	};
}
