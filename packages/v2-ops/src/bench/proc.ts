// The processes a benchmark runs: a simulated model provider, a Gate (foreground HTTP reads), a Live (NATS to WebSocket fanout with slow-client handling),
// Runners (the write path), and a browser load generator (WebSocket clients and foreground probes). Each is a separate Node process, started by orchestrator.ts
// with its configuration in argv[3] as JSON. They report to the orchestrator over the IPC channel.
//
// HONEST SCOPE: the Runner here is a reference write path, not the Pim Runner. It reproduces the storage pattern the architecture audit describes for a
// streaming conversation (partial-message commits every 250 ms, tool intent and result commits, one fenced transaction per commit, a commit event published
// after commit) against the real PostgreSQL schema of this package. It measures what PostgreSQL, Node and NATS do under that pattern. It does not run models, pi-durable
// or the product's code, and a result from it is an upper bound on what the real Runner could achieve only if the real Runner's writes follow the same pattern.
import { createServer } from "node:http";
import { monitorEventLoopDelay } from "node:perf_hooks";
import { connect as natsConnect, StringCodec } from "nats";
import pg from "pg";
import { WebSocket, WebSocketServer } from "ws";
import type { Workload } from "./profiles.ts";

const role = process.argv[2]!;
const config = JSON.parse(process.argv[3] ?? "{}");
const send = (message: unknown) => process.send?.(message);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const sc = StringCodec();

/** A histogram of milliseconds that keeps every sample (bounded), for exact percentiles. */
class Samples {
	readonly values: number[] = [];
	add(v: number) {
		if (this.values.length < 2_000_000) this.values.push(v);
	}
	summary() {
		const a = [...this.values].sort((x, y) => x - y);
		const q = (p: number) => (a.length ? a[Math.min(a.length - 1, Math.floor((p / 100) * a.length))]! : null);
		return { n: a.length, p50: q(50), p95: q(95), p99: q(99), max: a.at(-1) ?? null, mean: a.length ? a.reduce((s, v) => s + v, 0) / a.length : null };
	}
}

const loop = monitorEventLoopDelay({ resolution: 10 });
loop.enable();
const loopSummary = () => ({ p50Ms: loop.percentile(50) / 1e6, p99Ms: loop.percentile(99) / 1e6, maxMs: loop.max / 1e6 });

/** ---------------------------------------------------------------- provider */
async function provider() {
	const w: Workload = config.workload;
	let requests = 0;
	let errors = 0;
	const server = createServer(async (req, res) => {
		requests++;
		const url = new URL(req.url ?? "/", "http://x");
		if (url.pathname === "/stats") return void res.end(JSON.stringify({ requests, errors }));
		if (Math.random() < w.errorRate) {
			errors++;
			res.writeHead(Math.random() < 0.5 ? 524 : 429).end("simulated provider error");
			return;
		}
		res.writeHead(200, { "content-type": "text/event-stream" });
		await sleep(w.ttftMs);
		for (let i = 0; i < w.tokensPerTurn && !res.destroyed; i++) {
			res.write(`data: {"t":${i}}\n\n`);
			await sleep(w.tokenIntervalMs);
		}
		res.end("data: [DONE]\n\n");
	});
	server.keepAliveTimeout = 60_000;
	await new Promise<void>((r) => server.listen(config.port, "127.0.0.1", r));
	send({ ready: true });
}

/** ---------------------------------------------------------------- gate */
async function gate() {
	const pool = new pg.Pool({ connectionString: config.dbUrl, max: config.pool ?? 10 });
	const server = createServer(async (req, res) => {
		const url = new URL(req.url ?? "/", "http://x");
		const tenant = url.searchParams.get("tenant") ?? "";
		try {
			if (url.pathname === "/api/sidebar") {
				const { rows } = await pool.query("SELECT public_id, title, updated_at_ms FROM pim.chats WHERE tenant_id = $1 AND deleted_at_ms IS NULL ORDER BY updated_at_ms DESC LIMIT 50", [tenant]);
				res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify(rows));
			} else if (url.pathname === "/api/session") {
				const { rows } = await pool.query("SELECT e.record FROM pim.chats c JOIN pim.pi_entries e ON e.tenant_id = c.tenant_id AND e.conversation_id = c.conversation_id WHERE c.tenant_id = $1 AND c.public_id = $2 ORDER BY e.id DESC LIMIT 50", [tenant, url.searchParams.get("chat")]);
				res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify(rows));
			} else if (url.pathname === "/stats") res.end(JSON.stringify({ loop: loopSummary(), pool: { total: pool.totalCount, idle: pool.idleCount, waiting: pool.waitingCount } }));
			else res.writeHead(404).end();
		} catch (error) {
			res.writeHead(500).end(String(error));
		}
	});
	server.keepAliveTimeout = 60_000;
	await new Promise<void>((r) => server.listen(config.port, "127.0.0.1", r));
	process.on("message", (m: { type?: string }) => {
		if (m.type === "stats") send({ stats: { loop: loopSummary(), pool: { total: pool.totalCount, idle: pool.idleCount, waiting: pool.waitingCount } } });
	});
	send({ ready: true });
}

/** ---------------------------------------------------------------- live */
async function live() {
	const nc = await natsConnect({ servers: config.natsUrl });
	const wss = new WebSocketServer({ port: config.port, host: "127.0.0.1" });
	type Client = { ws: WebSocket; tenant: string; pending: Map<string, string> };
	const byTenant = new Map<string, Set<Client>>();
	let active = 0;
	let delivered = 0;
	let coalesced = 0;
	let overflowed = 0;
	const SLOW = 256 * 1024; // above this much unsent data, merge updates per partition
	const MAX = 4 * 1024 * 1024; // above this, disconnect
	wss.on("connection", (ws, req) => {
		const tenant = new URL(req.url ?? "/", "http://x").searchParams.get("tenant") ?? "";
		const client: Client = { ws, tenant, pending: new Map() };
		(byTenant.get(tenant) ?? byTenant.set(tenant, new Set()).get(tenant)!).add(client);
		active++;
		ws.on("close", () => {
			byTenant.get(tenant)?.delete(client);
			active--;
		});
		ws.on("error", () => undefined);
	});
	const flush = (c: Client) => {
		if (c.ws.readyState !== WebSocket.OPEN || c.pending.size === 0) return;
		for (const [key, text] of c.pending) {
			c.pending.delete(key);
			c.ws.send(text);
			delivered++;
		}
	};
	const sub = nc.subscribe("pim.commits.>");
	void (async () => {
		for await (const msg of sub) {
			const text = sc.decode(msg.data);
			const [, , tenant, partition] = msg.subject.split(".");
			for (const c of byTenant.get(tenant!) ?? []) {
				if (c.ws.bufferedAmount > MAX) {
					overflowed++;
					c.ws.terminate();
				} else if (c.ws.bufferedAmount > SLOW) {
					// A slow client gets only the latest update per partition, sent when its buffer drains.
					coalesced++;
					c.pending.set(partition!, text);
				} else {
					if (c.pending.size) flush(c);
					c.ws.send(text);
					delivered++;
				}
			}
		}
	})();
	setInterval(() => {
		for (const set of byTenant.values()) for (const c of set) if (c.ws.bufferedAmount < SLOW) flush(c);
	}, 50);
	process.on("message", (m: { type?: string }) => {
		if (m.type === "stats") send({ stats: { active, delivered, coalesced, overflowed, loop: loopSummary() } });
	});
	send({ ready: true });
}

/** ---------------------------------------------------------------- runner */
type Run = { tenant: string; conversation: number; partition: string; chat: string };

async function runner() {
	const w: Workload = config.workload;
	const runs: Run[] = config.runs;
	const owner = `runner-${config.index}`;
	const pool = new pg.Pool({ connectionString: config.dbUrl, max: w.poolSizePerRunner });
	const nc = await natsConnect({ servers: config.natsUrl });
	const commitLatency = new Samples();
	const stats = { commits: 0, partials: 0, turns: 0, providerErrors: 0, fencingRejects: 0, lateTurns: 0, floodEvents: 0 };
	const epoch = 1;
	await pool.query("INSERT INTO pim.bench_leases (partition_id, owner, epoch) SELECT p, $1, $2 FROM unnest($3::text[]) p ON CONFLICT (partition_id) DO UPDATE SET owner = EXCLUDED.owner, epoch = pim.bench_leases.epoch + 1", [owner, epoch, runs.map((r) => r.partition)]);

	// One commit: a single statement, so a single implicit transaction and a single WAL flush. It checks the lease epoch (fencing), takes the next commit
	// sequence of the partition, writes the entry, and updates the chat's last activity when asked.
	const COMMIT = `WITH fence AS (SELECT 1 FROM pim.bench_leases WHERE partition_id = $1 AND owner = $2 AND epoch >= $3 FOR SHARE),
		seq AS (UPDATE pim.partitions SET next_commit_seq = next_commit_seq + 1 WHERE tenant_id = $4 AND partition_id = $1 AND EXISTS (SELECT 1 FROM fence) RETURNING next_commit_seq - 1 AS s),
		ins AS (INSERT INTO pim.pi_entries (tenant_id, id, partition_id, conversation_id, commit_seq, record) SELECT $4, $5, $1, $6, s, $7::jsonb FROM seq
			ON CONFLICT (tenant_id, id) DO UPDATE SET record = EXCLUDED.record, commit_seq = EXCLUDED.commit_seq RETURNING 1),
		chat AS (UPDATE pim.chats SET updated_at_ms = $8 WHERE $9::boolean AND tenant_id = $4 AND public_id = $10 RETURNING 1)
		SELECT (SELECT s FROM seq) AS s`;
	const params = (r: Run, id: number, record: unknown, touch: boolean) => [r.partition, owner, epoch, r.tenant, id, r.conversation, JSON.stringify(record), Date.now(), touch, r.chat];

	type Pending = { run: Run; id: number; record: unknown; touch: boolean; at: number; done: (seq: number | null) => void };
	let queue: Pending[] = [];
	let flushing = false;
	const finishCommit = (p: Pending, seq: number | null) => {
		commitLatency.add(performance.now() - p.at);
		stats.commits++;
		if (seq === null) stats.fencingRejects++;
		else nc.publish(`pim.commits.${p.run.tenant}.${p.run.partition}`, sc.encode(JSON.stringify({ p: p.run.partition, s: seq, ts: Date.now() })));
		p.done(seq);
	};
	async function flushBatch() {
		if (flushing || queue.length === 0) return;
		flushing = true;
		const batch = queue;
		queue = [];
		const client = await pool.connect();
		try {
			await client.query("BEGIN");
			const results = await Promise.all(batch.map((p) => client.query(COMMIT, params(p.run, p.id, p.record, p.touch))).concat([client.query("COMMIT") as never]));
			batch.forEach((p, i) => finishCommit(p, (results[i] as pg.QueryResult).rows[0]?.s === null ? null : Number((results[i] as pg.QueryResult).rows[0]!.s)));
		} catch (error) {
			await client.query("ROLLBACK").catch(() => undefined);
			batch.forEach((p) => p.done(null));
			console.error("batch failed", String(error));
		} finally {
			client.release();
			flushing = false;
			if (queue.length) void flushBatch();
		}
	}
	const commit = (run: Run, id: number, record: unknown, touch = false): Promise<number | null> => {
		const at = performance.now();
		if (w.commitMode === "single") {
			return pool.query(COMMIT, params(run, id, record, touch)).then(
				(r) => {
					const seq = r.rows[0]?.s === null ? null : Number(r.rows[0]!.s);
					finishCommit({ run, id, record, touch, at, done: () => undefined }, seq);
					return seq;
				},
				(error) => {
					console.error("commit failed", String(error));
					return null;
				},
			);
		}
		return new Promise((resolve) => {
			queue.push({ run, id, record, touch, at, done: resolve });
			setTimeout(() => void flushBatch(), w.batchWindowMs);
		});
	};

	// Ids per run: a private block, as the tenant-wide leased-block sequence gives, so minting needs no round trip.
	let nextBlock = 2_000_000 + config.index * 10_000_000;
	let deadline = Number.POSITIVE_INFINITY;
	const stop = () => Date.now() >= deadline;
	let stopping = false;
	process.on("message", (m: { type?: string }) => {
		if (m.type === "stop") stopping = true;
		if (m.type === "stats") send({ stats: { ...stats, commit: commitLatency.summary(), loop: loopSummary() } });
	});

	async function oneRun(run: Run, stagger: number) {
		let nextId = (nextBlock += 100_000);
		await sleep(stagger);
		while (!stopping && !stop()) {
			const turnStart = performance.now();
			// Growing history: read the latest 40 entries as context before each model request, like building a prompt.
			await pool.query("SELECT record FROM pim.pi_entries WHERE tenant_id = $1 AND conversation_id = $2 ORDER BY id DESC LIMIT 40", [run.tenant, run.conversation]);
			await commit(run, nextId++, { id: nextId, kind: "message", model: [{ role: "user", content: [{ type: "text", text: "next question" }] }] });
			const partialId = nextId++;
			let produced = 0;
			let ok = true;
			try {
				const response = await fetch(`http://127.0.0.1:${config.providerPort}/v1/stream`, { signal: AbortSignal.timeout(60_000) });
				if (!response.ok) {
					stats.providerErrors++;
					ok = false;
				} else {
					let lastPartial = 0;
					const reader = response.body!.getReader();
					for (;;) {
						const { value, done } = await reader.read();
						if (done) break;
						produced += value.length;
						if (performance.now() - lastPartial >= w.partialIntervalMs && !stopping) {
							lastPartial = performance.now();
							stats.partials++;
							void commit(run, partialId, { id: partialId, kind: "message", partial: true, model: [{ role: "assistant", content: [{ type: "text", text: "x".repeat(Math.min(produced, 4000)) }] }] });
						}
					}
				}
			} catch {
				stats.providerErrors++;
				ok = false;
			}
			if (ok) {
				const toolId = nextId++;
				await commit(run, toolId, { id: toolId, kind: "tool", status: "running" });
				await sleep(w.toolLatencyMs);
				await commit(run, toolId, { id: toolId, kind: "tool", status: "done", result: "ok" });
				await commit(run, partialId, { id: partialId, kind: "message", model: [{ role: "assistant", content: [{ type: "text", text: "x".repeat(Math.min(produced, 4000)) }] }] }, true);
			}
			stats.turns++;
			const expected = w.ttftMs + w.tokensPerTurn * w.tokenIntervalMs + w.toolLatencyMs;
			if (performance.now() - turnStart > expected * 2) stats.lateTurns++;
			if (w.turnPauseMs) await sleep(w.turnPauseMs);
		}
	}
	// Coding transcript floods: bursts of small rows from simulated coding threads, in batches.
	async function flood(i: number) {
		let seq = 0;
		while (!stopping && !stop()) {
			const rows = Array.from({ length: 40 }, () => ({ s: ++seq, k: "output", b: JSON.stringify({ line: "build output ".repeat(8) }) }));
			await pool.query("INSERT INTO pim.bench_coding_events (thread_id, seq, kind, body) SELECT $1, s, k, b::jsonb FROM unnest($2::bigint[], $3::text[], $4::text[]) x(s, k, b) ON CONFLICT DO NOTHING", [`flood-${config.index}-${i}`, rows.map((r) => r.s), rows.map((r) => r.k), rows.map((r) => r.b)]);
			stats.floodEvents += rows.length;
			await sleep(100);
		}
	}
	send({ ready: true });
	// Wait for the orchestrator's go, so every Runner starts its load at the same moment.
	await new Promise<void>((resolve) => process.on("message", (m: { type?: string }) => m.type === "go" && resolve()));
	deadline = Date.now() + config.durationMs;
	await Promise.all([...runs.map((r, i) => oneRun(r, (i * 3000) / Math.max(runs.length, 1))), ...Array.from({ length: config.floods ?? 0 }, (_, i) => flood(i))]);
	send({ done: true, stats: { ...stats, commit: commitLatency.summary(), loop: loopSummary() } });
	await pool.end();
	await nc.drain();
}

/** ---------------------------------------------------------------- browsers */
async function browsers() {
	const lag = new Samples();
	let events = 0;
	const clients: WebSocket[] = [];
	for (let i = 0; i < config.count; i++) {
		const tenant = config.tenants[i % config.tenants.length];
		const ws = new WebSocket(`ws://127.0.0.1:${config.livePort}/?tenant=${tenant}`);
		ws.on("message", (data) => {
			events++;
			const ts = JSON.parse(data.toString()).ts as number;
			lag.add(Date.now() - ts);
		});
		ws.on("error", () => undefined);
		clients.push(ws);
	}
	// Slow browsers: connected, subscribed, and not reading.
	for (let i = 0; i < config.slow; i++) {
		const ws = new WebSocket(`ws://127.0.0.1:${config.livePort}/?tenant=${config.tenants[i % config.tenants.length]}`);
		ws.on("open", () => (ws as unknown as { _socket: { pause(): void } })._socket.pause());
		ws.on("error", () => undefined);
		clients.push(ws);
	}
	await sleep(500);
	// Foreground probes: a few closed-loop clients with keep-alive, issuing the two reads a person's browser makes.
	const phases: Record<string, { sidebar: Samples; session: Samples; errors: number }> = {};
	let phase = "idle";
	const probers = config.probers ?? 4;
	const runs: Run[] = config.sample;
	void (async () => {
		await Promise.all(
			Array.from({ length: probers }, async (_, p) => {
				let i = p;
				for (;;) {
					if (phase === "stop") return;
					if (phase === "idle") {
						await sleep(20);
						continue;
					}
					const bucket = (phases[phase] ??= { sidebar: new Samples(), session: new Samples(), errors: 0 });
					const run = runs[i++ % runs.length]!;
					const kind = i % 2 === 0 ? "sidebar" : "session";
					const url = kind === "sidebar" ? `/api/sidebar?tenant=${run.tenant}` : `/api/session?tenant=${run.tenant}&chat=${encodeURIComponent(run.chat)}`;
					const start = performance.now();
					try {
						const r = await fetch(`http://127.0.0.1:${config.gatePort}${url}`);
						await r.arrayBuffer();
						if (!r.ok) bucket.errors++;
						bucket[kind].add(performance.now() - start);
					} catch {
						bucket.errors++;
					}
					await sleep(config.thinkMs ?? 10);
				}
			}),
		);
	})();
	process.on("message", (m: { type?: string; phase?: string }) => {
		if (m.type === "phase") {
			// Samples recorded before the warm-up ends are discarded by starting a fresh bucket.
			phase = m.phase!;
			if (phase !== "idle" && phase !== "stop") phases[phase] = { sidebar: new Samples(), session: new Samples(), errors: 0 };
		}
		if (m.type === "stats") {
			const out: Record<string, unknown> = {};
			for (const [name, b] of Object.entries(phases)) out[name] = { sidebar: b.sidebar.summary(), session: b.session.summary(), errors: b.errors };
			send({ stats: { probes: out, ws: { clients: clients.length, open: clients.filter((c) => c.readyState === WebSocket.OPEN).length, events, lagMs: lag.summary() }, loop: loopSummary() } });
		}
	});
	send({ ready: true });
}

const roles: Record<string, () => Promise<void>> = { provider, gate, live, runner, browsers };
await roles[role]!();
