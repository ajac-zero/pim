// A load pass over the integrated product, not a synthetic writer: real Gate, Live (with the Projector) and Runner processes, each a Node process of its own, against real PostgreSQL
// (non-superuser, NOBYPASSRLS logins) and a NATS server, with one controlled streaming model (pi-ai's faux provider: a reply of fixed length written at 25 tokens per second).
//
// A profile is N ACTIVE RUNS: N chats, each with a person's turn streaming at every moment of the measured window (a closed loop: the next message goes in 200 ms after the answer is
// readable, so each chat's history grows through the run). Stored idle chats (created, never run in the window; two per active run) are counted separately, and so are the tenants
// (people), the Runners and their `maxResident`. Beside the runs, the profile holds WebSocket followers (some that read slowly, some that are cut and reconnect) and a flood of
// coding-thread transcript events. The foreground is one person's `/api/sessions` and `/api/snapshot/sidebar` read by closed-loop probes in a process of their own: first with no run
// active (the warm baseline), then through the load. Both budgets are evaluated on the result: warm p95 under 250 ms, and p95 at most 20% above the baseline's.
//
// Default `vitest` runs 5 and 50 with short windows (a few minutes). `node scripts/v2-bench/integrated.mjs` runs 5, 50, 500 and 1,000 with long windows, on a PostgreSQL with durability on, and
// writes `bench-results/`. PIM_BENCH_PROFILES, PIM_BENCH_WINDOW_S and PIM_BENCH_OUT override them. The test fails only on a collapse (and, at 50 runs or fewer, on a missed absolute budget);
// the budgets met or missed at the larger profiles are results, not failures. Everything runs on one machine, the load generator included: the numbers say so.
import { fork, spawnSync, type ChildProcess } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { cpus, loadavg, totalmem } from "node:os";
import { fileURLToPath } from "node:url";
import { afterAll, describe, expect, it } from "vitest";
import { WebSocket } from "ws";
import { FakeOrbClient } from "@pim/coding/orb/fake";
import { LiveClient, type LiveSocket, SnapshotRefused } from "@pim/shared/live-client";
import { App } from "@pim/v2-app/app";
import { connect as connectApp } from "@pim/v2-app/db";
import { MemoryObjectStore } from "@pim/v2-app/objects";
import { Authz } from "@pim/v2-forge/authz";
import type { Db as ForgeDb } from "@pim/v2-forge/db";
import { Forge } from "@pim/v2-forge/forge";
import { MemoryObjects } from "@pim/v2-forge/ports";
import { ForgeScheduler } from "@pim/v2-forge/scheduler";
import { ForgeStore } from "@pim/v2-forge/store";
import { Credentials } from "@pim/v2-forge/tokens";
import { forgePartitionId } from "../src/forge-source.ts";
import { type Deployment, envFor, startS3 } from "./support/processes.ts";
import { createStack, describeWith, freePort, hasNats, startNats } from "./support/stack.ts";

const real = describeWith(hasNats());
const FULL = Boolean(process.env.PIM_BENCH_FULL);
const PROFILES = (process.env.PIM_BENCH_PROFILES ?? "5,50").split(",").map(Number);
const WINDOW_S = Number(process.env.PIM_BENCH_WINDOW_S ?? 10);
const RAMP_S = FULL ? 15 : 5;
const BASELINE_S = FULL ? 20 : 8;
const IDLE_PER_ACTIVE = 2;
const MAX_RESIDENT = 64; // The Runner's default: `startRunner` does not expose it, so capacity is set by the number of Runners.
const POLL_MS = process.env.PIM_BENCH_POLL_MS ?? ""; // unset: the processes' own defaults (a Runner claims and pumps every 500 ms, Live projects every 500 ms and on a wake)
const REPLY_CHARS = 240;
const TOKENS_PER_SECOND = 25;
const REPO = "https://github.com/acme/app";
const SCRIPT = fileURLToPath(new URL("../../../scripts/v2-bench/integrated-process.ts", import.meta.url));
const PKG = fileURLToPath(new URL("..", import.meta.url));

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const pct = (xs: number[], p: number) => (xs.length ? [...xs].sort((a, b) => a - b)[Math.min(xs.length - 1, Math.floor((p / 100) * xs.length))]! : 0);
const r1 = (n: number) => Math.round(n * 10) / 10;
const dist = (xs: number[]) => ({ n: xs.length, p50: r1(pct(xs, 50)), p95: r1(pct(xs, 95)), p99: r1(pct(xs, 99)), max: r1(Math.max(0, ...xs)) });
async function limited<T>(items: T[], k: number, fn: (item: T, i: number) => Promise<void>) {
	let next = 0;
	await Promise.all(Array.from({ length: Math.min(k, items.length) }, async () => void (await (async () => { while (next < items.length) { const i = next++; await fn(items[i]!, i); } })())));
}

type Child = { name: string; proc: ChildProcess; port: number; metricsPort: number; messages: ((m: any) => void)[] };
function spawnChild(name: string, role: string, env: Record<string, string>): Promise<Child> {
	const proc = fork(SCRIPT, [role], { cwd: PKG, execArgv: ["--import", "tsx"], env: { ...process.env, ...env } as never, stdio: ["ignore", "ignore", "inherit", "ipc"] });
	const child: Child = { name, proc, port: 0, metricsPort: 0, messages: [] };
	return new Promise((resolve, reject) => {
		proc.on("message", (m: any) => {
			if (m.ready && !child.port) (Object.assign(child, { port: m.port ?? 0, metricsPort: m.metricsPort ?? 0 }), resolve(child));
			for (const f of child.messages.splice(0)) f(m);
		});
		proc.on("exit", (c) => reject(new Error(`${name} exited with ${c}`)));
	});
}
const reply = (child: Child, message: unknown) => new Promise<any>((resolve) => (child.messages.push(resolve), child.proc.send(message as never)));

const readStatus = (pid: number, key: string) => Number(new RegExp(`^${key}:\\s+(\\d+)`, "m").exec(readFileSync(`/proc/${pid}/status`, "utf8"))?.[1] ?? 0);
const pidsUnder = (pid: number): number[] => spawnSync("pgrep", ["-P", String(pid)], { encoding: "utf8" }).stdout.split("\n").filter(Boolean).map(Number);
const cpuTicks = (pid: number) => {
	const f = readFileSync(`/proc/${pid}/stat`, "utf8").split(") ")[1]!.split(" ");
	return Number(f[11]) + Number(f[12]);
};
const machineTicks = () => {
	const f = readFileSync("/proc/stat", "utf8").split("\n")[0]!.split(/\s+/).slice(1).map(Number);
	return { total: f.reduce((a, b) => a + b, 0), idle: f[3]! + (f[4] ?? 0) };
};
const TICKS_PER_S = 100;

type Person = { token: string; ownerId: string };

async function runProfile(n: number) {
	const tenants = n <= 5 ? 3 : n <= 50 ? 10 : n <= 500 ? 50 : 100;
	const idleChats = IDLE_PER_ACTIVE * n;
	const runners = Math.max(2, Math.ceil(n / MAX_RESIDENT) + 1);
	const stack = await createStack();
	const nats = await startNats();
	const s3 = await startS3();
	const d: Deployment = { stack, nats, s3, gatePort: await freePort(), ingressSecret: "ingress" };
	const app = new App(connectApp(stack.url("gate"), 8), new MemoryObjectStore());
	const children: Child[] = [];
	const sockets: { close(): void }[] = [];
	let pgPid = 0;
	try {
		const pgSettings = Object.fromEntries((await stack.admin.query("SELECT name, setting FROM pg_settings WHERE name IN ('fsync','synchronous_commit','full_page_writes','shared_buffers','max_connections','wal_level')")).rows.map((r) => [r.name, r.setting]));
		const pgVersion = (await stack.admin.query("SHOW server_version")).rows[0].server_version as string;
		try {
			pgPid = Number(readFileSync(`${(await stack.admin.query("SHOW data_directory")).rows[0].data_directory}/postmaster.pid`, "utf8").split("\n")[0]);
		} catch {}
		const gate = await spawnChild("gate", "gate", { ...envFor(d, "gate"), PIM_POOL_FOREGROUND_MAX: "30", PIM_RATE_API: "1000000" });
		const live = await spawnChild("live", "live", { ...envFor(d, "live"), PIM_POOL_FOREGROUND_MAX: "30", BENCH_POLL_MS: POLL_MS });
		for (let i = 0; i < runners; i++) children.push(await spawnChild(`runner-${i + 1}`, "runner", { ...envFor(d, "runner", { PIM_RUNNER_HOLDER_ID: `bench-${i + 1}`, PIM_POOL_RUNTIME_MAX: "10" }), BENCH_POLL_MS: POLL_MS, BENCH_REPLY_CHARS: String(REPLY_CHARS), BENCH_TOKENS_PER_SECOND: String(TOKENS_PER_SECOND) }));
		children.unshift(gate, live);
		const gateUrl = `http://127.0.0.1:${gate.port}`;
		const liveUrl = `http://127.0.0.1:${live.port}`;

		// Tenants: real accounts, each with a session.
		const root = await app.identity.register({ username: "root", bootstrap: await app.identity.issueClaim("bootstrap", null, 3_600_000) });
		const rootSession = await app.identity.createSession(root.ownerId);
		await app.identity.setRegistrationOpen({ kind: "user", ownerId: root.ownerId, role: "admin", sessionId: rootSession } as never, true);
		const people: Person[] = [];
		await limited(Array.from({ length: tenants }), 8, async (_, i) => {
			const account = await app.identity.register({ username: `bench${i}` });
			people[i] = { token: await app.identity.createSession(account.ownerId), ownerId: account.ownerId };
		});
		const call = async (p: Person, method: string, path: string, body?: unknown) => {
			const res = await fetch(gateUrl + path, { method, headers: { authorization: `Bearer ${p.token}`, "x-pim-ingress-secret": d.ingressSecret, ...(body ? { "content-type": "application/json" } : {}) }, ...(body ? { body: JSON.stringify(body) } : {}) });
			return { status: res.status, json: (await res.json()) as any };
		};

		// Chats: the active ones, a spare for the solo turn, and the stored idle ones.
		const chatOf: { person: Person; id: string }[] = [];
		await limited(Array.from({ length: n + 1 + idleChats }), 24, async (_, i) => {
			const person = people[i % tenants]!;
			const r = await call(person, "POST", "/api/sessions", { title: "bench" });
			expect(r.status).toBeLessThan(300);
			chatOf[i] = { person, id: r.json.id };
		});
		const active = chatOf.slice(0, n);
		const spare = chatOf[n]!;
		const idleIds = chatOf.slice(n + 1).map((c) => c.id);
		const submit = async (c: { person: Person; id: string }, key: string) => {
			const t = performance.now();
			const r = await call(c.person, "POST", `/api/sessions/${c.id}/messages`, { commandId: key, text: `message ${key}` });
			return { status: r.status, ms: performance.now() - t };
		};
		const assistantCounts = async (ids: string[]) => new Map<string, number>((await stack.admin.query("SELECT chat_id, count(*)::int AS n FROM pim_projection.chat_transcript_projection WHERE message->>'role' = 'assistant' AND NOT partial AND chat_id = ANY($1) GROUP BY chat_id", [ids])).rows.map((r) => [r.chat_id, r.n]));
		const waitFor = async <T>(what: string, fn: () => Promise<T | undefined>, ms = 240_000) => {
			for (const end = Date.now() + ms; Date.now() < end; await sleep(250)) {
				const v = await fn();
				if (v !== undefined) return v;
			}
			throw new Error(`timed out waiting for ${what}`);
		};
		const lagSql = "SELECT coalesce(sum(p.next_seq - 1 - w.projected_seq), 0)::int AS lag FROM pim_runtime.partitions p JOIN pim_projection.projection_watermarks w ON w.partition_id = p.partition_id";

		// The solo turn: one chat on an otherwise idle deployment, so that a late turn means late against this.
		const t0 = performance.now();
		await submit(spare, "solo");
		await waitFor("the solo turn", async () => ((await assistantCounts([spare.id])).get(spare.id) ? true : undefined), 60_000);
		const soloMs = performance.now() - t0;

		// The foreground probes, a process of their own, reading the first tenant's pages.
		const probe = await spawnChild("probe", "probe", { BENCH_PROBE: JSON.stringify({ token: people[0]!.token, gate: gateUrl, ingress: d.ingressSecret }) });
		children.push(probe);
		const measure = async (seconds: number) => (probe.proc.send({ type: "start" }), await sleep(seconds * 1000), (await reply(probe, { type: "stop" })).samples as { path: string; ms: number; status: number }[]);
		const summarize = (samples: { path: string; ms: number; status: number }[]) => ({
			all: dist(samples.map((s) => s.ms)),
			sessions: dist(samples.filter((s) => s.path === "/api/sessions").map((s) => s.ms)),
			sidebar: dist(samples.filter((s) => s.path !== "/api/sessions").map((s) => s.ms)),
			non_200: samples.filter((s) => s.status !== 200).length,
		});
		await measure(3); // warm: connections open, plans cached
		const baseline = summarize(await measure(BASELINE_S));

		// Followers: normal ones, slow ones that read in bursts, and the churn that cuts a socket and lets it reconnect.
		const stats = { updates: 0, opens: 0, reconnects: 0, slowFrames: 0, slowSkipped: 0, slowCoalescedFrames: 0, slowClosed: 0, churned: 0, refused: [] as string[] };
		const followers = Math.min(n, 100 + tenants);
		const slowCount = Math.max(2, Math.floor(followers / 10));
		const clients: { client: LiveClient; ws: () => WebSocket | undefined; slow: boolean }[] = [];
		const follow = (person: Person, topics: string[], slow: boolean) => {
			let current: WebSocket | undefined;
			let opened = false;
			const client = new LiveClient({
				openSocket: () => {
					const ws = new WebSocket(`ws://127.0.0.1:${live.port}/api/ws`, { headers: { authorization: `Bearer ${person.token}`, "x-pim-ingress-secret": d.ingressSecret } });
					current = ws;
					stats.opens++;
					if (opened) stats.reconnects++;
					opened = true;
					ws.on("error", () => {});
					ws.on("close", (code) => void (slow && code === 4009 && stats.slowClosed++));
					if (slow) {
						ws.on("open", () => (ws as any)._socket.pause());
						ws.on("message", (raw) => {
							const text = String(raw);
							stats.slowFrames++;
							if (text.includes('"coalesced_progress"')) (stats.slowCoalescedFrames++, (stats.slowSkipped += Number(/"skipped":(\d+)/.exec(text)?.[1] ?? 0)));
						});
					}
					return ws as unknown as LiveSocket;
				},
				loadSnapshot: async (topic) => {
					const [kind, id] = topic.split(":");
					const res = await fetch(`${liveUrl}/snapshot/${kind}${id ? `/${id}` : ""}`, { headers: { authorization: `Bearer ${person.token}`, "x-pim-ingress-secret": d.ingressSecret } });
					if (!res.ok) {
						stats.refused.push(`${topic}:${res.status}`);
						throw new SnapshotRefused(res.status);
					}
					return { liveCursor: ((await res.json()) as { liveCursor: string | null }).liveCursor };
				},
				onUpdate: () => void stats.updates++,
				onUnauthorized: () => {},
			});
			client.follow(topics);
			clients.push({ client, ws: () => current, slow });
			sockets.push({ close: () => client.stop() });
		};

		// A coding-thread transcript flood: Forge's outbox written fast on a few threads, projected by Live, followed by sockets.
		const forgeDb = stack.admin as unknown as ForgeDb;
		const store = new ForgeStore(forgeDb);
		const authz = new Authz(forgeDb, { allowedRepos: ["acme/*"], branchPrefix: "pim/" });
		const scheduler = new ForgeScheduler(forgeDb, store, Date.now);
		await scheduler.upsertPool({ poolId: "default", provider: "local", size: 50 });
		const forge = new Forge({ db: forgeDb, store, authz, scheduler, credentials: new Credentials(forgeDb, "bench-signing-key", authz.policy, Date.now), git: {} as never, objects: new MemoryObjects(), orbs: () => new FakeOrbClient(), compute: {} as never, ampConfigured: false });
		const threads: { threadId: string; ownerId: string }[] = [];
		for (const person of people.slice(0, Math.min(3, tenants))) {
			await authz.grant({ subjectType: "user", subjectId: person.ownerId, permission: "coding:start", grantedBy: "admin" });
			const { threadId } = await forge.start({ ownerId: person.ownerId as never, role: "member" }, { operationId: `flood-${person.ownerId}`, task: "Flood the transcript", repo: REPO });
			await store.locked(threadId, (q) => store.setState(q, threadId, "running"));
			threads.push({ threadId, ownerId: person.ownerId });
			follow(person, ["sidebar", `coding:${threadId}`], false);
		}
		// Followers of the chats; the slow readers also follow the first flooded coding thread, whose big events fill their queue past Live's high-water mark.
		for (let i = 0; i < followers; i++) {
			const slowOnCoding = i < slowCount && threads[0];
			const person = slowOnCoding ? people.find((p) => p.ownerId === threads[0]!.ownerId)! : active[i]!.person;
			const chat = slowOnCoding ? active.find((c) => c.person === person)! : active[i]!;
			follow(person, ["sidebar", `chat:${chat.id}`, ...(slowOnCoding ? [`coding:${threads[0]!.threadId}`] : [])], i < slowCount);
		}
		let flooding = true;
		let flooded = 0;
		const flood = Promise.all(
			threads.map(async ({ threadId }) => {
				while (flooding) {
					await store.locked(threadId, async (q) => {
						await store.appendEvent(q, threadId, { kind: "message", role: "assistant", data: { text: "Reading the file and thinking about the change. ".repeat(4), toolCalls: [{ id: `t${flooded}`, name: "read", arguments: { path: "src/a.ts" } }] } });
						await store.appendEvent(q, threadId, { kind: "message", role: "tool", data: { toolCallId: `t${flooded}`, name: "read", text: "x".repeat(8_000) } });
					});
					flooded += 2;
					await sleep(60);
				}
			}),
		);
		const churn = setInterval(() => {
			for (const c of clients.filter((c) => !c.slow).sort(() => Math.random() - 0.5).slice(0, Math.max(1, Math.floor(followers / 20)))) (c.ws()?.terminate(), stats.churned++);
		}, 3_000);
		const slowCycle = setInterval(() => {
			for (const c of clients.filter((c) => c.slow)) {
				const sock = (c.ws() as any)?._socket;
				if (!sock) continue;
				sock.resume();
				setTimeout(() => sock.pause(), 3_000);
			}
		}, 40_000);

		// The runs: every active chat streams a turn at once, then another 200 ms after each answer is readable.
		const submitted = new Map<string, { turns: number; sentAt: number }>();
		const turnMs: number[] = [];
		const admissionMs: number[] = [];
		let completedInWindow = 0;
		let windowOpen = false;
		let running = true;
		const inFlightSamples: number[] = [];
		let landedKnown = 0;
		const lagSamples: number[] = [];
		const forgeLagSamples: number[] = [];
		const send = async (c: (typeof active)[number]) => {
			const state = submitted.get(c.id) ?? { turns: 0, sentAt: 0 };
			state.turns++;
			state.sentAt = performance.now();
			submitted.set(c.id, state);
			const r = await submit(c, `run-${c.id}-${state.turns}`);
			admissionMs.push(r.ms);
			if (r.status !== 202) throw new Error(`admission refused: ${r.status}`);
		};
		let loopError: unknown;
		const driver = (async () => {
			try {
				// The runs start spread over a few seconds, as people do, not as one wave that stays in step.
				await limited(active, 32, async (c, i) => (await sleep((i / n) * Math.min(4_000, RAMP_S * 600)), send(c)));
				while (running) {
					const counts = await assistantCounts(active.map((c) => c.id));
					const now = performance.now();
					const due = active.filter((c) => (counts.get(c.id) ?? 0) >= submitted.get(c.id)!.turns);
					for (const c of due) {
						const s = submitted.get(c.id)!;
						if (windowOpen) (turnMs.push(now - s.sentAt), completedInWindow++);
					}
					landedKnown = due.length;
					await sleep(200);
					if (running) await limited(due, 32, (c) => send(c));
				}
			} catch (error) {
				loopError = error;
			}
		})();

		await sleep(RAMP_S * 1000);
		const pgPids = () => (pgPid ? [pgPid, ...pidsUnder(pgPid)] : []);
		const pgTicks = () => pgPids().reduce((a, pid) => { try { return a + cpuTicks(pid); } catch { return a; } }, 0);
		const pgTicksBefore = pgTicks();
		const generatorBefore = process.cpuUsage();
		const ticksBefore = new Map(children.map((c) => [c.name, cpuTicks(c.proc.pid!)]));
		/** WAL flush counts: pg_stat_wal has them through PostgreSQL 17 and not after, so a newer server reports none. */
		const walStats = async (): Promise<{ sync: number; time: number } | null> => {
			try {
				const r = (await stack.admin.query("SELECT wal_sync, wal_sync_time FROM pg_stat_wal")).rows[0];
				return { sync: Number(r.wal_sync), time: Number(r.wal_sync_time) };
			} catch {
				return null;
			}
		};
		const machineBefore = machineTicks();
		const commitsBefore = Number((await stack.admin.query("SELECT count(*) n FROM pim_runtime.commit_receipts")).rows[0].n);
		const walBefore = await walStats();
		const xactBefore = Number((await stack.admin.query("SELECT xact_commit FROM pg_stat_database WHERE datname = current_database()")).rows[0].xact_commit);
		const updatesBefore = stats.updates;
		const floodedBefore = flooded;
		const admittedAtStart = submitted.size;
		windowOpen = true;
		const win0 = performance.now();
		let sampling = true;
		const rss = { node: 0, nodeByRole: {} as Record<string, number>, postgresPss: 0, bench: 0 };
		const sampler = (async () => {
			while (sampling) {
				inFlightSamples.push(submitted.size - landedKnown);
				lagSamples.push((await stack.admin.query(lagSql)).rows[0].lag);
				const forgeLag = await (async () => {
					let lag = 0;
					for (const t of threads) {
						const head = (await stack.admin.query("SELECT last_seq FROM pim_forge.forge_outbox_counters WHERE owner_id = $1", [t.ownerId])).rows[0]?.last_seq;
						const mark = (await stack.admin.query("SELECT projected_seq FROM pim_projection.projection_watermarks WHERE partition_id = $1", [forgePartitionId(t.ownerId)])).rows[0]?.projected_seq;
						lag += Number(head ?? 0) - Number(mark ?? 0);
					}
					return threads.length ? lag : undefined;
				})();
				if (forgeLag !== undefined) forgeLagSamples.push(forgeLag);
				let total = 0;
				const byRole: Record<string, number> = {};
				for (const c of children) {
					const kb = readStatus(c.proc.pid!, "VmRSS");
					const role = c.name.replace(/-\d+$/, "");
					byRole[role] = (byRole[role] ?? 0) + kb;
					total += kb;
				}
				if (total > rss.node) (rss.node = total, (rss.nodeByRole = byRole));
				if (pgPid) {
					let pss = 0;
					for (const pid of [pgPid, ...pidsUnder(pgPid)]) {
						try {
							pss += Number(/Pss:\s+(\d+)/.exec(readFileSync(`/proc/${pid}/smaps_rollup`, "utf8"))?.[1] ?? 0);
						} catch {}
					}
					rss.postgresPss = Math.max(rss.postgresPss, pss);
				}
				rss.bench = Math.max(rss.bench, readStatus(process.pid, "VmRSS"));
				await sleep(1_000);
			}
		})();
		const loaded = summarize(await measure(WINDOW_S));
		const seconds = (performance.now() - win0) / 1000;
		windowOpen = false;
		const machineAfter = machineTicks();
		const commitsAfter = Number((await stack.admin.query("SELECT count(*) n FROM pim_runtime.commit_receipts")).rows[0].n);
		const walAfter = await walStats();
		const xactAfter = Number((await stack.admin.query("SELECT xact_commit FROM pg_stat_database WHERE datname = current_database()")).rows[0].xact_commit);
		const cpuSeconds: Record<string, number> = {};
		for (const c of children) {
			const role = c.name.replace(/-\d+$/, "");
			cpuSeconds[role] = r1((cpuSeconds[role] ?? 0) + (cpuTicks(c.proc.pid!) - ticksBefore.get(c.name)!) / TICKS_PER_S);
		}
		if (pgPid) cpuSeconds.postgres = r1((pgTicks() - pgTicksBefore) / TICKS_PER_S);
		const g = process.cpuUsage(generatorBefore);
		cpuSeconds.load_generator = r1((g.user + g.system) / 1e6);
		const updatesInWindow = stats.updates - updatesBefore;
		const floodedInWindow = flooded - floodedBefore;
		sampling = false;
		await sampler;

		// Stop the load; every run's last turn lands, the projection catches up, and the idle chats were never touched.
		running = false;
		flooding = false;
		clearInterval(churn);
		clearInterval(slowCycle);
		await driver;
		await flood;
		const drainStart = performance.now();
		const settled = await waitFor("the last turns to land", async () => {
			const counts = await assistantCounts(active.map((c) => c.id));
			return active.every((c) => (counts.get(c.id) ?? 0) >= submitted.get(c.id)!.turns) ? true : undefined;
		}, 120_000).catch(() => false);
		const turnsLanded = settled === true;
		const caught = await waitFor("the projection to catch up", async () => ((await stack.admin.query(lagSql)).rows[0].lag === 0 ? true : undefined), 120_000).then(() => true, () => false);
		const catchUpMs = performance.now() - drainStart;
		const idleTouched = (await assistantCounts(idleIds)).size;
		const turnsSubmitted = [...submitted.values()].reduce((a, s) => a + s.turns, 0);
		const lateOver2xSolo = turnMs.filter((t) => t > 2 * soloMs).length;

		const regression = (a: number, b: number) => (a > 0 ? r1(((b - a) / a) * 100) : null);
		const budget = (name: "sessions" | "sidebar" | "all") => ({
			baseline_p95_ms: baseline[name].p95,
			loaded_p95_ms: loaded[name].p95,
			regression_pct: regression(baseline[name].p95, loaded[name].p95),
			regression_ms: r1(loaded[name].p95 - baseline[name].p95),
			absolute_p95_under_250ms: loaded[name].p95 < 250,
			relative_regression_within_20pct: loaded[name].p95 <= baseline[name].p95 * 1.2,
		});
		const row = {
			active_runs: n,
			stored_idle_chats: idleChats,
			tenants,
			runners,
			runner_max_resident: MAX_RESIDENT,
			runner_resident_capacity: runners * MAX_RESIDENT,
			websocket_followers: { normal: followers - slowCount + threads.length, slow_reader: slowCount, churn_cuts: stats.churned, reconnects: stats.reconnects, socket_opens: stats.opens },
			window_s: r1(seconds),
			ramp_s: RAMP_S,
			baseline_s: BASELINE_S,
			foreground: { baseline_0_active_runs: baseline, under_load: loaded, slo: { sessions: budget("sessions"), sidebar: budget("sidebar"), all: budget("all") } },
			turns: {
				model: { tokens_per_second: TOKENS_PER_SECOND, reply_chars: REPLY_CHARS, process_poll_ms: POLL_MS || "product defaults" },
				solo_turn_ms: Math.round(soloMs),
				runs_first_turn_admitted: { at_window_start: admittedAtStart, at_window_end: submitted.size },
				mean_in_flight_runs: r1(inFlightSamples.reduce((a, b) => a + b, 0) / Math.max(1, inFlightSamples.length)),
				p05_in_flight_runs: pct(inFlightSamples, 5),
				completed_in_window: completedInWindow,
				completion_rate_per_s: r1(completedInWindow / seconds),
				latency_ms: dist(turnMs),
				late_over_2x_solo: lateOver2xSolo,
				late_over_2x_solo_pct: r1((lateOver2xSolo / Math.max(1, turnMs.length)) * 100),
				submitted_total: turnsSubmitted,
				all_last_turns_landed: turnsLanded,
				admission_ms: dist(admissionMs),
				in_flight_note: "in flight = chats with a turn sent whose answer the 200 ms poll of the projection has not yet seen, sampled once a second",
				note: "turn latency is the time from the Gate accepting the send to a 200 ms poll of the projection seeing the answer, so it includes up to 200 ms of polling",
			},
			runtime: { commits_in_window: commitsAfter - commitsBefore, commits_per_s: r1((commitsAfter - commitsBefore) / seconds), pg_transactions_per_s: r1((xactAfter - xactBefore) / seconds), wal_flushes_per_s: walBefore && walAfter ? r1((walAfter.sync - walBefore.sync) / seconds) : null, wal_flush_mean_ms: walBefore && walAfter && walAfter.sync > walBefore.sync ? r1((walAfter.time - walBefore.time) / (walAfter.sync - walBefore.sync)) : null },
			projection: { max_lag_commits: Math.max(0, ...lagSamples), p95_lag_commits: pct(lagSamples, 95), mean_lag_commits: r1(lagSamples.reduce((a, b) => a + b, 0) / Math.max(1, lagSamples.length)), caught_up_after_load: caught, catch_up_ms: Math.round(catchUpMs), forge_max_lag_events: Math.max(0, ...forgeLagSamples) },
			live: { updates_delivered_per_s: r1(updatesInWindow / seconds), slow_client: { frames_read: stats.slowFrames, coalesced_progress_frames: stats.slowCoalescedFrames, progress_updates_folded: stats.slowSkipped, closed_as_slow: stats.slowClosed } },
			coding_flood: { threads: threads.length, events_appended_in_window: floodedInWindow, events_per_s: r1(floodedInWindow / seconds) },
			refused_snapshots: stats.refused.slice(0, 5),
			idle_chats_run_in_window: idleTouched,
			machine: { cpu_busy_pct: r1((1 - (machineAfter.idle - machineBefore.idle) / (machineAfter.total - machineBefore.total)) * 100), process_cpu_seconds_in_window: cpuSeconds, load_average_1m_after: r1(loadavg()[0]!) },
			memory_mb: { node_processes_peak_rss_total: Math.round(rss.node / 1024), node_by_role_at_peak: Object.fromEntries(Object.entries(rss.nodeByRole).map(([k, v]) => [k, Math.round(v / 1024)])), postgres_peak_pss: pgPid ? Math.round(rss.postgresPss / 1024) : null, load_generator_peak_rss: Math.round(rss.bench / 1024) },
			postgres: { version: pgVersion, ...pgSettings },
		};
		if (loopError) throw loopError;
		return { row, turnsLanded, caught };
	} finally {
		for (const s of sockets) s.close();
		for (const c of children) c.proc.removeAllListeners("exit"), c.proc.kill("SIGKILL");
		await app.db.end().catch(() => {});
		nats.stop();
		await s3.stop();
		await stack.drop();
	}
}

real("the integrated Gate, Live, Projector and Runners under concurrent streaming runs", () => {
	const results: Record<string, unknown>[] = [];
	const environment = { cpus: cpus().length, cpu_model: cpus()[0]?.model, memory_gb: r1(totalmem() / 1024 ** 3), node: process.version, platform: process.platform, nats: spawnSync("nats-server", ["--version"], { encoding: "utf8" }).stdout.trim(), durable_postgres: FULL, load_generator: "same machine" };
	afterAll(() => {
		if (process.env.PIM_BENCH_OUT) writeFileSync(process.env.PIM_BENCH_OUT, `${JSON.stringify({ environment, profiles: results }, null, 2)}\n`);
	});

	for (const n of PROFILES) {
		it(`${n} active runs, ${IDLE_PER_ACTIVE * n} stored idle chats`, async () => {
			const { row, turnsLanded, caught } = await runProfile(n);
			results.push(row);
			console.log("BENCH", JSON.stringify(row));
			// A collapse, not a target: at 50 runs or fewer turns completed in the window; at any size the last turns landed, the projection caught up, and a foreground read never stalled.
			if (n <= 50) expect(row.turns.completed_in_window).toBeGreaterThan(0);
			expect(turnsLanded).toBe(true);
			expect(caught).toBe(true);
			expect(row.foreground.under_load.all.max).toBeLessThan(10_000);
			expect(row.foreground.under_load.non_200).toBe(0);
			expect(row.idle_chats_run_in_window).toBe(0);
			if (n <= 50) expect(row.foreground.slo.all.absolute_p95_under_250ms).toBe(true);
		}, 1_800_000);
	}
});
