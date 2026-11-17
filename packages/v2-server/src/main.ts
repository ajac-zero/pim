/**
 * The process entrypoint, matching `deploy/compose/compose.yaml` and `deploy/k8s/`: `node main.ts <role>` where the role is `migrate` (the
 * one-shot SQL runner) or one of `gate | live | runner | forge | canvas | relay | maintenance | all-in-one` (`PIM_ROLE` of the contracts). It reads
 * `loadProcessConfig(process.env)`, serves `/healthz`, `/readyz` and `POST /drain` on `PIM_HTTP_PORT` (8080) and Prometheus metrics on
 * `PIM_METRICS_PORT` (9464), and drains on SIGTERM.
 */
import { loadProcessConfig, PROCESS_ROLES, rolesOf, type PimProcessRole } from "@pim/v2-contracts/platform";
import { realpathSync } from "node:fs";
import { pathToFileURL } from "node:url";
import pg from "pg";
import { createHost, type Host } from "./host.ts";
import { migrateAll } from "./migrate.ts";
import { promoteToLive } from "./migration-bridge.ts";
import { type Env, type Hooks, NatsPulse, type Role, startForge, startGate, startLive, startMaintenance, startRunner } from "./roles.ts";

export type Process = { host: Host; roles: Role[]; close(): Promise<void>; drain(): Promise<void> };

export async function migrateCommand(env: Env): Promise<number[]> {
	if (!env.PIM_DATABASE_URL) throw new Error("PIM_DATABASE_URL is required to migrate");
	const pool = new pg.Pool({ connectionString: env.PIM_DATABASE_URL, max: 2 });
	try {
		return await migrateAll(pool);
	} finally {
		await pool.end();
	}
}

/**
 * `promote`: after `@pim/v2-ops` has imported and audited a legacy snapshot into the landing schema, writes it into the live schemas (see `migration-bridge.ts`).
 * Reads `PIM_DATABASE_URL` (the schema owner), `PIM_RP_ID` (the new deployment's hostname), `PIM_CUTOVER_AT` (epoch ms) and optionally `PIM_DEFAULT_MODEL` (`provider/model`).
 */
export async function promoteCommand(env: Env) {
	for (const name of ["PIM_DATABASE_URL", "PIM_RP_ID", "PIM_CUTOVER_AT"]) if (!env[name]) throw new Error(`${name} is required to promote`);
	const [provider, ...model] = (env.PIM_DEFAULT_MODEL ?? "").split("/");
	const pool = new pg.Pool({ connectionString: env.PIM_DATABASE_URL, max: 4 });
	try {
		return await promoteToLive(pool, { rpId: env.PIM_RP_ID!, cutoverAt: Number(env.PIM_CUTOVER_AT), ...(provider && model.length ? { defaultAgent: { provider, modelId: model.join("/") } } : {}) });
	} finally {
		await pool.end();
	}
}

/** Starts the roles `command` names in this process. */
export async function startProcess(command: string, env: Env, hooks: Hooks = {}): Promise<Process> {
	if (!(PROCESS_ROLES as readonly string[]).includes(command)) throw new Error(`Unknown role ${command}; one of migrate, ${PROCESS_ROLES.join(", ")}`);
	const config = loadProcessConfig({ ...env, PIM_ROLE: command });
	const roles = rolesOf(config.role as PimProcessRole);
	const host = await createHost({ port: Number(env.PIM_HTTP_PORT ?? 8080), metricsPort: Number(env.PIM_METRICS_PORT ?? 9464), ingressSecret: env.PIM_INGRESS_SECRET });
	const started: Role[] = [];
	// Gate, Live and the Forge-facing loops publish and hear on Pulse, and the Gate's relay and canvas containers reach each other's computers on it; a deployment without NATS reaches Live by polling alone.
	const pulse = roles.includes("gate") || roles.includes("live") || roles.includes("relay") || roles.includes("canvas") ? await NatsPulse.connect(config.natsUrl) : undefined;
	try {
		for (const role of roles) {
			if (role === "gate" || role === "canvas" || role === "relay") {
				// The canvas and relay containers run the Gate's sockets; one Gate in a process serves all three.
				if (started.some((s) => s.name === "gate")) continue;
				started.push(await startGate(config, env, host, pulse));
			} else if (role === "live") started.push(await startLive(config, env, host, hooks, pulse!));
			else if (role === "runner") started.push(await startRunner(config, env, host, hooks));
			else if (role === "forge") started.push(await startForge(config, env, host, hooks));
			else if (role === "maintenance") started.push(await startMaintenance(config, env, host, hooks));
		}
	} catch (error) {
		await Promise.allSettled(started.map((r) => r.close()));
		await pulse?.close();
		await host.close();
		throw error;
	}
	host.started();
	const proc: Process = {
		host,
		roles: started,
		async drain() {
			await fetch(`http://127.0.0.1:${host.port}/drain`, { method: "POST" });
		},
		async close() {
			await Promise.allSettled(started.map((r) => r.close()));
			await pulse?.close();
			await host.close();
		},
	};
	return proc;
}

/** The command line: `migrate`, or a role; exits non-zero when it cannot start. */
export async function main(argv = process.argv.slice(2), env: Env = process.env): Promise<void> {
	const command = argv[0] ?? env.PIM_ROLE;
	if (!command) throw new Error("Name a role: migrate, " + PROCESS_ROLES.join(", "));
	if (command === "promote") {
		console.log(JSON.stringify({ event: "pim.promote", ...(await promoteCommand(env)) }));
		return;
	}
	if (command === "migrate") {
		const applied = await migrateCommand(env);
		console.log(JSON.stringify({ event: "pim.migrate", applied }));
		return;
	}
	// Signals are handled from the first moment, so one that arrives while the roles are still starting stops them cleanly too.
	let proc: Process | undefined;
	let stopping = false;
	let early = false;
	const stop = async (signal: string) => {
		if (stopping) return;
		stopping = true;
		console.log(JSON.stringify({ event: "pim.stopping", signal }));
		if (!proc) {
			early = true;
			return;
		}
		await proc.drain().catch(() => undefined);
		await proc.close();
		process.exit(0);
	};
	process.on("SIGTERM", () => void stop("SIGTERM"));
	process.on("SIGINT", () => void stop("SIGINT"));
	proc = await startProcess(command, env);
	console.log(JSON.stringify({ event: "pim.started", role: command, port: proc.host.port, metricsPort: proc.host.metricsPort }));
	if (early) {
		await proc.close();
		process.exit(0);
	}
}

if (process.argv[1] && pathToFileURL(realpathSync(process.argv[1])).href === import.meta.url) {
	main().catch((error) => {
		console.error(JSON.stringify({ event: "pim.failed", error: String(error?.message ?? error) }));
		process.exit(1);
	});
}
