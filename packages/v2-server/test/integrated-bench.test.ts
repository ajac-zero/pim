// A load pass over the integrated product, not a synthetic writer: real Gate, Live and Runner processes, real PostgreSQL (non-superuser roles), NATS, and a streaming scripted model.
// N people each start one streaming turn at once; the test measures what a person feels (the Gate answering 202, the time until the answer is projected and readable) and what a
// person feels meanwhile (the sidebar snapshot of someone else's chat list), and fails only on a collapse (a turn that never lands, or a foreground read that stalls).
// Numbers vary with the machine; the run prints them, and PIM_BENCH_OUT names a file to write them to. PIM_BENCH_PROFILES lists the sizes (default 5,50; the 500 and 1,000 qualification
// runs use scripts/v2-bench/integrated.mjs, which also starts a durable PostgreSQL 17 and nats-server).
//
// Each profile measures the same foreground reads (the sidebar snapshot and the session list of one person, four closed-loop clients) twice: warm and idle (the baseline), then through the load,
// so the two budgets (warm p95 under 250 ms, and at most 20% worse than the baseline) are read off one run. Through the load it also runs a slow Live client that never reads, a Live client whose
// socket is cut mid-load and reconnects, and a flood of coding-thread projection writes. Gate, Live, both Runners and the Projector run in this one Node process (the model is scripted in-process),
// so the whole stack shares one event loop: that is a limit of the harness, and the results say so.
import { readFileSync, writeFileSync } from "node:fs";
import { cpus, totalmem } from "node:os";
import { monitorEventLoopDelay } from "node:perf_hooks";
import { execFileSync } from "node:child_process";
import { WebSocket } from "ws";
import { LiveClient, type LiveSocket, type LiveStatus, type LiveUpdate } from "@pim/shared/live-client";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createModels } from "@earendil-works/pi-ai";
import { fauxAssistantMessage, fauxProvider } from "@earendil-works/pi-ai/providers/faux";
import { createRegistry, type HarnessOptions } from "@earendil-works/pi-durable";
import { App } from "@pim/v2-app/app";
import { connect as connectApp } from "@pim/v2-app/db";
import { MemoryObjectStore } from "@pim/v2-app/objects";
import type { Process } from "../src/main.ts";
import { waitFor } from "../../v2-runtime/test/support/rig.ts";
import { type Deployment, base, start, startS3 } from "./support/processes.ts";
import { createStack, describeWith, freePort, hasNats, startNats } from "./support/stack.ts";

const real = describeWith(hasNats());
const PROFILES = (process.env.PIM_BENCH_PROFILES ?? "5,50").split(",").map(Number);
const pct = (xs: number[], p: number) => [...xs].sort((a, b) => a - b)[Math.min(xs.length - 1, Math.floor((p / 100) * xs.length))] ?? 0;
const ms = (n: number) => Math.round(n);

real("the integrated Gate, Runner, Projector and Live under concurrent streaming turns", () => {
	let d: Deployment;
	let gate: Process;
	const procs: Process[] = [];
	let app: App;
	const faux = fauxProvider({ provider: "faux", models: [{ id: "m" }], tokensPerSecond: 25, tokenSize: { min: 2, max: 3 } });
	const results: Record<string, unknown>[] = [];
	const ANSWER = "This is a streamed answer of a fair length, so that it commits several partial messages as it is written.";

	beforeAll(async () => {
		const stack = await createStack();
		d = { stack, nats: await startNats(), s3: await startS3(), gatePort: await freePort(), ingressSecret: "ingress" };
		app = new App(connectApp(stack.url("gate"), 8), new MemoryObjectStore());
		const models = createModels();
		models.setProvider(faux.provider);
		const agent = { model: { provider: "faux", modelId: "m" } };
		const hooks = { harnessOptions: (): HarnessOptions => ({ models, registry: createRegistry(), settings: { retry: { enabled: false, maxRetries: 0, baseDelayMs: 1_000 } } as never }), homeRoot: () => ({ agent }), chatAgent: () => agent, pollMs: 40 };
		// Tuning knobs for the qualification runs: pool sizes per process and how many Runners share the work (all in this process, so they add no CPU, only concurrency).
		const runtimePool = process.env.PIM_BENCH_RUNTIME_POOL ?? "20";
		const runners = Number(process.env.PIM_BENCH_RUNNERS ?? 2);
		gate = await start(d, "gate", {}, { PIM_POOL_FOREGROUND_MAX: process.env.PIM_BENCH_GATE_POOL ?? "20" });
		procs.push(gate, await start(d, "live", { pollMs: 40 }));
		for (let i = 1; i <= runners; i++) procs.push(await start(d, "runner", hooks, { PIM_RUNNER_HOLDER_ID: `bench-${i}`, PIM_POOL_RUNTIME_MAX: runtimePool }));
	}, 180_000);
	afterAll(async () => {
		if (process.env.PIM_BENCH_OUT) writeFileSync(process.env.PIM_BENCH_OUT, `${JSON.stringify(results, null, 2)}\n`);
		await Promise.allSettled(procs.map((p) => p.close()));
		await app?.db.end();
		d?.nats.stop();
		await d?.s3.stop();
		await d?.stack.drop();
	}, 60_000);

	const sessions: { token: string; ownerId: string }[] = [];
	async function person(i: number) {
		const existing = sessions[i];
		if (existing) return existing;
		await openRegistration();
		const account = await app.identity.register({ username: `bench${i}` });
		const token = await app.identity.createSession(account.ownerId);
		return (sessions[i] = { token, ownerId: account.ownerId });
	}
	let opened: Promise<void> | undefined;
	const openRegistration = () => (opened ??= bootstrapAdmin().then((a) => app.identity.setRegistrationOpen(a.principal, true)));
	let admin: { principal: never } | undefined;
	async function bootstrapAdmin() {
		if (admin) return admin;
		const account = await app.identity.register({ username: "root", bootstrap: await app.identity.issueClaim("bootstrap", null, 3_600_000) });
		const token = await app.identity.createSession(account.ownerId);
		return (admin = { principal: { kind: "user", ownerId: account.ownerId, role: "admin", sessionId: token } as never });
	}
	const call = async (token: string, method: string, path: string, body?: unknown) => {
		const t0 = performance.now();
		const res = await fetch(base(gate) + path, { method, headers: { authorization: `Bearer ${token}`, "x-pim-ingress-secret": d.ingressSecret, ...(body ? { "content-type": "application/json" } : {}) }, ...(body ? { body: JSON.stringify(body) } : {}) });
		const json = (await res.json()) as any;
		return { status: res.status, json, ms: performance.now() - t0 };
	};

	const pcts = (xs: number[]) => ({ n: xs.length, p50: ms(pct(xs, 50)), p95: ms(pct(xs, 95)), p99: ms(pct(xs, 99)), max: ms(xs.length ? Math.max(...xs) : 0) });
	/** Four closed-loop clients reading the person's sidebar snapshot and session list, until `stop()`; samples by endpoint. */
	function probe(token: string) {
		const samples: Record<"sessions" | "sidebar", number[]> = { sessions: [], sidebar: [] };
		let running = true;
		const loops = Array.from({ length: 4 }, (_, k) =>
			(async () => {
				while (running) {
					const kind = k % 2 ? "sessions" : "sidebar";
					samples[kind].push((await call(token, "GET", kind === "sessions" ? "/api/sessions" : "/api/snapshot/sidebar")).ms);
					await new Promise((r) => setTimeout(r, 40));
				}
			})(),
		);
		return { samples, async stop() { running = false; await Promise.all(loops); return samples; } };
	}
	/** WAL flush counts: pg_stat_wal has them through PostgreSQL 17 and not after, so a newer server reports none. */
	const walStats = async (): Promise<{ sync: number; time: number } | null> => {
		try {
			const r = (await d.stack.admin.query("SELECT wal_sync, wal_sync_time FROM pg_stat_wal")).rows[0];
			return { sync: Number(r.wal_sync), time: Number(r.wal_sync_time) };
		} catch {
			return null;
		}
	};
	const cpuTimes = () => {
		const f = readFileSync("/proc/stat", "utf8").split("\n")[0]!.split(/\s+/).slice(1).map(Number);
		return { idle: (f[3] ?? 0) + (f[4] ?? 0), total: f.reduce((a, b) => a + b, 0) };
	};
	const rssMb = (name: string) => {
		try {
			return execFileSync("ps", ["-C", name, "-o", "rss="], { encoding: "utf8" }).split("\n").reduce((n, l) => n + (Number(l.trim()) || 0), 0) / 1024;
		} catch {
			return 0;
		}
	};
	const livePort = () => (procs[1] as unknown as { host: { port: number } }).host.port;
	/** A Live client over a real WebSocket to the Live process, with the person's session as its bearer. `slow` pauses the socket after it opens, so it never reads. */
	function liveClient(token: string, slow = false) {
		const log = { updates: 0, progress: 0, skipped: 0, statuses: [] as { status: LiveStatus; at: number }[] };
		let socket: WebSocket | undefined;
		const client = new LiveClient({
			openSocket: () => {
				socket = new WebSocket(`ws://127.0.0.1:${livePort()}/live`, { headers: { authorization: `Bearer ${token}`, "x-pim-ingress-secret": d.ingressSecret } });
				if (slow) socket.on("open", () => (socket as unknown as { _socket: { pause(): void } })._socket.pause());
				socket.on("error", () => undefined);
				return socket as unknown as LiveSocket;
			},
			loadSnapshot: async (topic) => {
				const [kind, id] = topic.split(":");
				const r = await fetch(`http://127.0.0.1:${livePort()}/snapshot/${kind}${id ? `/${id}` : ""}`, { headers: { authorization: `Bearer ${token}`, "x-pim-ingress-secret": d.ingressSecret } });
				return { liveCursor: r.ok ? ((await r.json()) as { liveCursor: string | null }).liveCursor : null };
			},
			onUpdate: (u: LiveUpdate) => {
				log.updates++;
				if (u.kind === "progress") (log.progress++, (log.skipped += u.skipped ?? 0));
			},
			onStatus: (status) => log.statuses.push({ status, at: performance.now() }),
			onUnauthorized: () => undefined,
		});
		client.follow(["sidebar"]);
		return { client, log, cut: () => socket?.terminate(), stop: () => client.stop() };
	}

	for (const n of PROFILES) {
		it(`${n} people each stream one turn at once`, async () => {
			const rounds = Number(process.env.PIM_BENCH_ROUNDS ?? (n <= 50 ? 2 : 1));
			faux.setResponses(Array.from({ length: n * rounds + 5 }, () => fauxAssistantMessage(ANSWER)));
			const people: { token: string; ownerId: string }[] = [];
			for (let i = 0; i < n; i += 50) people.push(...(await Promise.all(Array.from({ length: Math.min(50, n - i) }, (_, k) => person(i + k + 1)))));
			const chats: string[] = [];
			for (let i = 0; i < n; i += 100) chats.push(...(await Promise.all(people.slice(i, i + 100).map(async (p) => (await call(p.token, "POST", "/api/sessions", { title: "bench" })).json.id as string))));
			// Idle stored chats: they exist and are listed, and nothing runs in them. They are not active runs.
			const idlePerPerson = Number(process.env.PIM_BENCH_IDLE_CHATS ?? 3);
			for (let i = 0; i < n; i += 100) await Promise.all(people.slice(i, i + 100).map(async (p) => { for (let k = 0; k < idlePerPerson; k++) await call(p.token, "POST", "/api/sessions", { title: `idle ${k}` }); }));
			const watcher = people[0]!;

			// Baseline: the same reads, warm, with nothing running.
			const warm = probe(watcher.token);
			await new Promise((r) => setTimeout(r, 2_000));
			await warm.stop();
			const idle = probe(watcher.token);
			await new Promise((r) => setTimeout(r, 6_000));
			const baseline = await idle.stop();

			// The load: a slow client, a client to be cut, a flood, and the foreground reads, around n turns started at once.
			const slow = liveClient(watcher.token, true);
			const flaky = liveClient(watcher.token);
			const floodOwner = watcher.ownerId;
			let flooding = true;
			const flood = (async () => {
				let seq = 0;
				const thread = `flood-${n}`;
				while (flooding) {
					const rows = Array.from({ length: 40 }, () => ({ id: `${thread}-${seq % 400}`, n: ++seq }));
					await d.stack.admin.query(
						"INSERT INTO pim_projection.coding_thread_projection (owner_id, thread_id, title, harness, state, running, updated_at, summary, partition_id, commit_seq, projection_version) SELECT $1, t, 'flood', 'pi', 'running', true, $4, jsonb_build_object('line', 'build output '), gen_random_uuid(), s, 1 FROM unnest($2::text[], $3::bigint[]) x(t, s) ON CONFLICT (owner_id, thread_id) DO UPDATE SET updated_at = EXCLUDED.updated_at, commit_seq = EXCLUDED.commit_seq, summary = EXCLUDED.summary",
						[floodOwner, rows.map((r) => r.id), rows.map((r) => r.n), Date.now()],
					);
					await new Promise((r) => setTimeout(r, 100));
				}
				return seq;
			})();
			const lp = new (monitorEventLoopDelay as unknown as new (o: object) => ReturnType<typeof monitorEventLoopDelay>)({ resolution: 10 });
			lp.enable();
			const rss: { node: number; pg: number; nats: number }[] = [];
			const memTimer = setInterval(() => rss.push({ node: process.memoryUsage().rss / 1048576, pg: rssMb("postgres"), nats: rssMb("nats-server") }), 1_000);
			const db0 = (await d.stack.admin.query("SELECT xact_commit AS x FROM pg_stat_database WHERE datname = current_database()")).rows[0].x as string;
			const wal0 = await walStats();
			const receipts0 = Number((await d.stack.admin.query("SELECT count(*) n FROM pim_runtime.commit_receipts")).rows[0].n);
			const cpu0 = cpuTimes();
			const proc0 = process.cpuUsage();
			const wall0 = performance.now();
			const loadedProbe = probe(watcher.token);
			const t0 = performance.now();
			let cutAt = 0;
			let reconnectedMs: number | null = null;
			setTimeout(() => {
				cutAt = performance.now();
				flaky.cut();
				void (async () => {
					while (reconnectedMs === null && performance.now() - cutAt < 60_000) {
						await new Promise((r) => setTimeout(r, 25));
						const last = flaky.log.statuses.at(-1);
						if (last && last.at > cutAt && last.status === "live") reconnectedMs = ms(last.at - cutAt);
					}
				})();
			}, 4_000);
			const admissions: number[] = [];
			const e2e: number[] = [];
			let maxLag = 0;
			let admittedAt = 0;
			for (let round = 1; round <= rounds; round++) {
				const sent = new Map<string, number>();
				for (let i = 0; i < n; i += 250)
					admissions.push(
						...(await Promise.all(
							people.slice(i, i + 250).map(async (p, k) => {
								sent.set(chats[i + k]!, performance.now());
								const r = await call(p.token, "POST", `/api/sessions/${chats[i + k]}/messages`, { commandId: `bench-${n}-${round}-${i + k}`, text: `hello ${i + k}` });
								expect(r.status).toBe(202);
								return r.ms;
							}),
						)),
					);
				if (round === 1) admittedAt = performance.now() - t0;
				// When each answer is readable: sampled from the projection every 50 ms; and how far the Projector is behind.
				const landed = new Map<string, number>();
				await waitFor(`${n} answers of round ${round} to be projected`, async () => {
					const rows = (await d.stack.admin.query("SELECT chat_id FROM pim_projection.chat_transcript_projection WHERE message->>'role' = 'assistant' AND NOT partial AND chat_id = ANY($1) GROUP BY chat_id HAVING count(*) >= $2", [chats, round])).rows;
					const at = performance.now();
					for (const r of rows) if (!landed.has(r.chat_id)) landed.set(r.chat_id, at);
					const lag = (await d.stack.admin.query("SELECT coalesce(sum(p.next_seq - 1 - w.projected_seq), 0)::int AS lag FROM pim_runtime.partitions p JOIN pim_projection.projection_watermarks w ON w.partition_id = p.partition_id")).rows[0].lag;
					maxLag = Math.max(maxLag, lag);
					return landed.size === n ? true : undefined;
				}, 1_500_000);
				for (const c of chats) e2e.push(landed.get(c)! - sent.get(c)!);
			}
			const total = performance.now() - t0;
			const cpu1 = cpuTimes();
			const procCpu = process.cpuUsage(proc0);
			const wallMs = performance.now() - wall0;
			clearInterval(memTimer);
			lp.disable();
			flooding = false;
			const floodRows = await flood;
			const loaded = await loadedProbe.stop();
			const db1 = (await d.stack.admin.query("SELECT xact_commit AS x FROM pg_stat_database WHERE datname = current_database()")).rows[0].x as string;
			const wal1 = await walStats();
			const receipts1 = Number((await d.stack.admin.query("SELECT count(*) n FROM pim_runtime.commit_receipts")).rows[0].n);
			const settings = Object.fromEntries((await d.stack.admin.query("SELECT name, setting FROM pg_settings WHERE name IN ('fsync','synchronous_commit','full_page_writes','shared_buffers','max_connections')")).rows.map((r) => [r.name, r.setting]));
			const version = (await d.stack.admin.query("SHOW server_version")).rows[0].server_version as string;
			const liveStatus = { slow: slow.client.status, flaky: flaky.client.status };
			slow.stop();
			flaky.stop();
			const all = (x: Record<"sessions" | "sidebar", number[]>) => [...x.sessions, ...x.sidebar];
			const regress = (a: number, b: number) => (a > 0 ? Math.round(((b - a) / a) * 1000) / 10 : null);
			const base = { sessions: pcts(baseline.sessions), sidebar: pcts(baseline.sidebar) };
			const load = { sessions: pcts(loaded.sessions), sidebar: pcts(loaded.sidebar) };
			const seconds = total / 1000;
			const row = {
				people: n,
				rounds,
				active_streaming_runs: n,
				idle_stored_chats: n * idlePerPerson,
				tenants: n,
				admission_ms: { p50: ms(pct(admissions, 50)), p95: ms(pct(admissions, 95)), max: ms(Math.max(...admissions)) },
				all_admitted_after_ms: ms(admittedAt),
				answer_readable_ms: { p50: ms(pct(e2e, 50)), p95: ms(pct(e2e, 95)), p99: ms(pct(e2e, 99)), max: ms(Math.max(...e2e)) },
				// The two budgets, read off one run: warm p95 under 250 ms, and at most 20% worse than the same read with nothing running.
				foreground: {
					baseline: base,
					under_load: load,
					budget_absolute_p95_under_250ms: Math.max(load.sessions.p95, load.sidebar.p95) < 250,
					p95_regression_pct: { sessions: regress(base.sessions.p95, load.sessions.p95), sidebar: regress(base.sidebar.p95, load.sidebar.p95) },
					p50_regression_pct: { sessions: regress(base.sessions.p50, load.sessions.p50), sidebar: regress(base.sidebar.p50, load.sidebar.p50) },
					budget_relative_within_20pct: (regress(base.sessions.p95, load.sessions.p95) ?? 999) <= 20 && (regress(base.sidebar.p95, load.sidebar.p95) ?? 999) <= 20,
				},
				foreground_read_ms: { reads: all(loaded).length, p50: ms(pct(all(loaded), 50)), p95: ms(pct(all(loaded), 95)), max: ms(Math.max(...all(loaded))) },
				max_projection_lag_commits: maxLag,
				total_s: Math.round(total / 100) / 10,
				runtime_commits_total: receipts1,
				runtime_commits_per_second: Math.round(((receipts1 - receipts0) / seconds) * 10) / 10,
				pg_transactions_per_second: Math.round((Number(db1) - Number(db0)) / seconds),
				pg_wal_flushes_per_second: wal0 && wal1 ? Math.round((wal1.sync - wal0.sync) / seconds) : null,
				pg_wal_flush_mean_ms: wal0 && wal1 && wal1.sync > wal0.sync ? Math.round(((wal1.time - wal0.time) / (wal1.sync - wal0.sync)) * 1000) / 1000 : null,
				machine_cpu_busy_pct: Math.round((1 - (cpu1.idle - cpu0.idle) / (cpu1.total - cpu0.total)) * 1000) / 10,
				// The stack's Node process: CPU seconds used per wall second, as a percent of ONE core (100 means its one event loop is saturated).
				stack_node_process_cpu_pct_of_one_core: Math.round(((procCpu.user + procCpu.system) / 1000 / wallMs) * 1000) / 10,
				rss_mb_max: { stack_node_process: ms(Math.max(...rss.map((r) => r.node))), postgres_sum_of_backends: ms(Math.max(...rss.map((r) => r.pg))), nats: ms(Math.max(...rss.map((r) => r.nats))) },
				event_loop_delay_ms: { p50: Math.round(lp.percentile(50) / 1e4) / 100, p99: Math.round(lp.percentile(99) / 1e4) / 100, max: Math.round(lp.max / 1e4) / 100 },
				live: { slow_client_status: liveStatus.slow, slow_client_updates_received: slow.log.updates, reconnect_cut_to_live_ms: reconnectedMs, reconnecting_client_updates: flaky.log.updates, reconnecting_client_final_status: liveStatus.flaky, coalesced_progress_updates: flaky.log.progress, coalesced_updates_skipped: flaky.log.skipped },
				coding_projection_flood_rows: floodRows,
				environment: { cpus: cpus().length, cpu_model: cpus()[0]?.model, mem_gb: Math.round((totalmem() / 2 ** 30) * 10) / 10, node: process.version, postgres: version, postgres_settings: settings, knobs: { runtime_pool: process.env.PIM_BENCH_RUNTIME_POOL ?? "20", gate_pool: process.env.PIM_BENCH_GATE_POOL ?? "20", runners: Number(process.env.PIM_BENCH_RUNNERS ?? 2) }, shape: "Gate, Live, the Runners and the Projector in one Node process; PostgreSQL and nats-server separate; scripted model at 25 tokens/s" },
				cpus: cpus().length,
			};
			results.push(row);
			console.log("BENCH", JSON.stringify(row));
			// A collapse, not a target: every turn landed, the Gate kept admitting, and a foreground read never stalled.
			expect(admissions.every((a) => a < 60_000)).toBe(true);
			expect(Math.max(...all(loaded))).toBeLessThan(30_000);
		}, 1_800_000);
	}
});
