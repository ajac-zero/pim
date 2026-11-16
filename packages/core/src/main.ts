import { randomUUID } from "node:crypto";
import { createServer } from "node:http";
import { createModels } from "@earendil-works/pi-ai/models";
import { openaiProvider } from "@earendil-works/pi-ai/providers/openai";
import { fauxAssistantMessage, fauxProvider } from "@earendil-works/pi-ai/providers/faux";
import { createRegistry } from "@earendil-works/pi-durable";
import { checkDurability, createPool, migrate } from "./db.ts";
import { createGate } from "./gate.ts";
import { NatsHints } from "./hints.ts";
import { IdAllocator } from "./ids.ts";
import { attachLive } from "./live-server.ts";
import { Metrics, databaseGauges, processGauges } from "./metrics.ts";
import { projectOnce, pruneStreams } from "./projector.ts";
import { Runner } from "./runner.ts";
import { approvalExpiry, runTimersOnce } from "./timers.ts";
import { noHints } from "./commands.ts";

/**
 * One small, role-selectable image: `PIM_ROLES=gate,live,runner,steward,maint` picks what a process does. Roles share
 * code, not state: they meet only in PostgreSQL. Ordinary chat needs gate, live (optional), runner and steward; the
 * personal computer, the coding pool, connectors and media are separate capability roles that may be absent.
 */
const env = process.env;
const need = (name: string): string => {
	const value = env[name];
	if (!value) throw new Error(`${name} is required`);
	return value;
};
const num = (name: string, fallback: number) => (env[name] ? Number(env[name]) : fallback);

/** Each role connects with its own scoped, non-bypass login: a Gate compromise cannot write runtime records, and Live cannot write at all. */
const url = (role: string) => env[`PIM_DB_URL_${role.toUpperCase()}`] ?? need("PIM_DB_URL");

const roles = new Set((env.PIM_ROLES ?? "gate").split(",").map((r) => r.trim()).filter(Boolean));
const metrics = new Metrics();
const stops: (() => Promise<void> | void)[] = [];
const ownerId = `${env.HOSTNAME ?? "proc"}-${randomUUID().slice(0, 8)}`;

function healthServer(port: number, ready: () => boolean | Promise<boolean>) {
	const server = createServer(async (req, res) => {
		if (req.url === "/metrics") {
			res.writeHead(200, { "content-type": "text/plain; version=0.0.4" });
			return void res.end(await metrics.render());
		}
		if (req.url === "/healthz") return void res.writeHead(200).end("ok");
		const ok = await Promise.resolve(ready()).catch(() => false);
		res.writeHead(ok ? 200 : 503).end(ok ? "ready" : "not ready");
	});
	server.listen(port);
	stops.push(() => void server.close());
	return server;
}

async function main(): Promise<void> {
	if (process.argv[2] === "migrate") {
		const pool = createPool({ connectionString: need("PIM_DB_URL_OWNER"), max: 2 });
		console.log(JSON.stringify({ applied: await migrate(pool) }));
		await pool.end();
		return;
	}
	const pools: Record<string, ReturnType<typeof createPool>> = {};
	const pool = (role: string, max: number) => (pools[role] ??= createPool({ connectionString: url(role), max, applicationName: `pim-${role}` }));
	const hints = env.PIM_NATS_URL ? new NatsHints(env.PIM_NATS_URL) : undefined;
	hints?.start();
	let draining = false;

	if (roles.has("gate")) {
		const gatePool = pool("gate", num("PIM_GATE_POOL", 10));
		const ids = new IdAllocator(gatePool);
		const server = createGate({ pool: gatePool, ids, hints: hints ?? noHints, metrics }).listen(num("PIM_GATE_PORT", 8080));
		stops.push(() => void server.close());
		if (roles.has("live") && !env.PIM_LIVE_PORT) {
			const live = attachLive(server, { pool: pool("live", num("PIM_LIVE_POOL", 5)), metrics });
			stops.push(() => live.close());
		}
	}
	if (roles.has("live") && env.PIM_LIVE_PORT) {
		const server = createServer((req, res) => void (req.url === "/healthz" ? res.writeHead(200).end("ok") : res.writeHead(404).end()));
		const live = attachLive(server, { pool: pool("live", num("PIM_LIVE_POOL", 5)), metrics });
		server.listen(num("PIM_LIVE_PORT", 8081));
		stops.push(() => (live.close(), void server.close()));
	}
	if (roles.has("runner")) {
		const runtime = pool("runtime", num("PIM_RUNNER_POOL", 20));
		const models = createModels();
		if (env.PIM_QUAL_FAKE_MODEL === "1") {
			// A controlled provider for qualification and smoke tests: no real model, no quota, realistic latency.
			const faux = fauxProvider({ provider: "faux", models: [{ id: "m", contextWindow: 100_000 }], tokensPerSecond: num("PIM_QUAL_TOKENS_PER_SECOND", 200) });
			faux.setResponses(Array.from({ length: 10_000_000 }, () => async () => (await new Promise((r) => setTimeout(r, num("PIM_QUAL_MODEL_LATENCY_MS", 300))), fauxAssistantMessage("ok " + "word ".repeat(num("PIM_QUAL_ANSWER_WORDS", 60))))));
			models.setProvider(faux.provider);
		} else models.setProvider(openaiProvider());
		const runner = new Runner({
			ownerId,
			steward: pool("steward", 4),
			maxFamilies: num("PIM_RUNNER_MAX_FAMILIES", 200),
			perTenantLimit: num("PIM_PER_TENANT_FAMILIES", 50),
			deps: {
				pool: runtime,
				ids: new IdAllocator(runtime),
				leaseTtlMs: num("PIM_LEASE_TTL_MS", 15_000),
				harnessOptions: () => ({ models, registry: createRegistry() }),
				onCommitTiming: ({ wait, total, ok }) => {
					metrics.observe("pim_commit_seconds", total, { ok: String(ok) }, "PostgreSQL commit time, including the wait for a connection");
					metrics.observe("pim_commit_pool_wait_seconds", wait, {}, "Time waiting for a pooled connection");
				},
				onReport: (error) => {
					metrics.inc("pim_runner_errors_total", { name: (error as Error).name ?? "Error" });
					console.error(JSON.stringify({ level: "warn", name: (error as Error).name }));
				},
			},
		});
		metrics.gauge("pim_runner_families", "Families this runner owns", () => runner.hosts.size);
		hints?.subscribe("pim.activate.*", () => void runner.claimOnce().catch(() => undefined));
		runner.start();
		healthServer(num("PIM_RUNNER_PORT", 8082), () => !draining);
		stops.push(async () => {
			draining = true;
			await runner.drain();
		});
		processGauges(metrics, pools);
	}
	if (roles.has("steward") || roles.has("maint")) {
		const steward = pool("steward", 4);
		const runtime = pool("runtime", 4);
		databaseGauges(metrics, steward);
		const timer = setInterval(async () => {
			try {
				await projectOnce({ steward, runtime });
				await runTimersOnce(steward, { "approval.expire": approvalExpiry(runtime) }, { ownerId });
			} catch (error) {
				metrics.inc("pim_steward_errors_total", { name: (error as Error).name });
			}
		}, num("PIM_STEWARD_INTERVAL_MS", 500));
		stops.push(() => clearInterval(timer));
		if (roles.has("maint")) {
			const maint = pool("maint", 2);
			const prune = setInterval(() => void pruneStreams(maint, num("PIM_RETENTION_MS", 24 * 3600_000)).catch(() => undefined), 60_000);
			stops.push(() => clearInterval(prune));
		}
		if (!roles.has("runner")) healthServer(num("PIM_STEWARD_PORT", 8083), async () => (await steward.query("SELECT 1")).rowCount === 1);
	}
	if (roles.has("gate") || roles.has("runner")) {
		const durability = await checkDurability(pool(roles.has("gate") ? "gate" : "runtime", 1), { synchronousCommit: (env.PIM_SYNCHRONOUS_COMMIT as "on") ?? "on" });
		if (!durability.ok) {
			const message = `PostgreSQL durability is weaker than configured: ${durability.problems.join("; ")}`;
			if (env.PIM_ALLOW_WEAK_DURABILITY === "1") console.warn(message);
			else throw new Error(message);
		}
	}
	const shutdown = async () => {
		for (const stop of stops.reverse()) await stop();
		for (const p of Object.values(pools)) await p.end();
		hints?.close();
		process.exit(0);
	};
	process.on("SIGTERM", () => void shutdown());
	process.on("SIGINT", () => void shutdown());
	console.log(JSON.stringify({ level: "info", msg: "started", roles: [...roles], ownerId }));
}

main().catch((error) => {
	console.error(JSON.stringify({ level: "fatal", message: (error as Error).message }));
	process.exit(1);
});
