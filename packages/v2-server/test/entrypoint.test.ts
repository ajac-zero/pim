import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { migrateCommand, startProcess, type Process } from "../src/main.ts";
import { waitFor } from "../../v2-runtime/test/support/rig.ts";
import { type Deployment, base, envFor, start, startS3 } from "./support/processes.ts";
import { createStack, describeWith, freePort, hasNats, startNats } from "./support/stack.ts";

const real = describeWith(hasNats());

real("the role entrypoint", () => {
	let d: Deployment;
	const running: Process[] = [];
	beforeAll(async () => {
		const stack = await createStack();
		d = { stack, nats: await startNats(), s3: await startS3(), gatePort: await freePort(), ingressSecret: "ingress-secret" };
	}, 120_000);
	afterAll(async () => {
		await Promise.allSettled(running.map((p) => p.close()));
		d?.nats.stop();
		await d?.s3.stop();
		await d?.stack.drop();
	});
	const go = async (...args: Parameters<typeof start>) => {
		const p = await start(...args);
		running.push(p);
		return p;
	};

	it("migrates every band into one ledger, and again with nothing to do", async () => {
		const bands = (await d.stack.admin.query("SELECT (number / 100) AS band FROM public.pim_schema_migrations GROUP BY 1 ORDER BY 1")).rows.map((r) => Number(r.band));
		expect(bands).toEqual([0, 1, 2, 3, 4, 5, 6]);
		expect(await migrateCommand({ PIM_DATABASE_URL: d.stack.url("super") })).toEqual([]);
	});

	it("runs every login as a role that is neither superuser nor BYPASSRLS, and keeps each out of the schemas that are not its own", async () => {
		const { Pool } = (await import("pg")).default;
		const as = async (role: Parameters<Deployment["stack"]["url"]>[0], sql: string) => {
			const pool = new Pool({ connectionString: d.stack.url(role), max: 1 }).on("error", () => {});
			try {
				return (await pool.query(sql)).rows;
			} finally {
				await pool.end();
			}
		};
		for (const role of ["gate", "runtime", "live", "forge", "maintenance"] as const) {
			expect(await as(role, "SELECT rolsuper, rolbypassrls FROM pg_roles WHERE rolname = current_user")).toEqual([{ rolsuper: false, rolbypassrls: false }]);
		}
		const denied = async (role: Parameters<Deployment["stack"]["url"]>[0], sql: string) => expect(as(role, sql)).rejects.toThrow(/permission denied/);
		await denied("gate", "SELECT 1 FROM pim_runtime.entries LIMIT 1");
		await denied("runtime", "SELECT 1 FROM pim_app.accounts LIMIT 1");
		await denied("live", "SELECT 1 FROM pim_app.accounts LIMIT 1");
		await denied("live", "SELECT 1 FROM pim_forge.forge_threads LIMIT 1");
		await denied("forge", "SELECT 1 FROM pim_runtime.entries LIMIT 1");
		await denied("forge", "SELECT 1 FROM pim_app.accounts LIMIT 1");
		await denied("runtime", "SELECT 1 FROM pim_forge.forge_threads LIMIT 1");
		// Tenant tables answer nothing without an owner, even where the role may read the table.
		expect(await as("gate", "SELECT count(*)::int AS n FROM pim_app.accounts")).toEqual([{ n: 0 }]);
	});

	it("serves /healthz, /readyz and metrics for each role, and answers the ingress secret and nothing else for the rest", async () => {
		const gate = await go(d, "gate");
		const live = await go(d, "live");
		const runner = await go(d, "runner");
		const maintenance = await go(d, "maintenance");
		for (const p of [gate, live, runner, maintenance]) {
			expect((await fetch(`${base(p)}/healthz`)).status).toBe(200);
			await waitFor("ready", async () => ((await fetch(`${base(p)}/readyz`)).status === 200 ? true : undefined));
			const metrics = await fetch(`http://127.0.0.1:${p.host.metricsPort}/metrics`);
			expect(metrics.status).toBe(200);
			const body = await metrics.text(); if (!body.includes("pim_")) console.log("EMPTY METRICS", p.roles.map((r) => r.name), body.length);
			expect(body).toContain("pim_");
		}
		expect((await fetch(`${base(gate)}/auth/session`)).status).toBe(403);
		const signedOut = await fetch(`${base(gate)}/auth/session`, { headers: { "x-pim-ingress-secret": d.ingressSecret } });
		expect(signedOut.status).toBe(200);
		expect(((await signedOut.json()) as { signedIn: boolean }).signedIn).toBe(false);
	}, 60_000);

	it("drains a Runner on POST /drain: it stops being ready, and the process still closes cleanly", async () => {
		const runner = await go(d, "runner");
		await waitFor("ready", async () => ((await fetch(`${base(runner)}/readyz`)).status === 200 ? true : undefined));
		expect((await fetch(`${base(runner)}/drain`, { method: "POST" })).status).toBe(202);
		expect((await fetch(`${base(runner)}/readyz`)).status).toBe(503);
	}, 60_000);

	it("keeps a Runner from claiming work after a restore until its safety pass has reconciled", async () => {
		await d.stack.admin.query("INSERT INTO pim_ops.ops_restore (restore_id, state) VALUES ('r-1', 'restored')");
		const runner = await go(d, "runner");
		await new Promise((resolve) => setTimeout(resolve, 600));
		expect((await fetch(`${base(runner)}/healthz`)).status).toBe(200);
		expect((await fetch(`${base(runner)}/readyz`)).status).toBe(503);
		await d.stack.admin.query("UPDATE pim_ops.ops_restore SET state = 'reconciled' WHERE restore_id = 'r-1'");
		await waitFor("the Runner to start once reconciled", async () => ((await fetch(`${base(runner)}/readyz`)).status === 200 ? true : undefined), 15_000);
	}, 60_000);

	it("runs as a real OS process: `migrate` into an empty database, then a Runner that drains and exits 0 on SIGTERM", async () => {
		const root = new pg.Client({ connectionString: process.env.PIM_V2_PG_URL });
		await root.connect();
		const name = `cli_${randomUUID().replaceAll("-", "").slice(0, 12)}`;
		await root.query(`CREATE DATABASE ${name}`);
		await root.end();
		const url = new URL(process.env.PIM_V2_PG_URL!);
		url.pathname = `/${name}`;
		const cwd = fileURLToPath(new URL("..", import.meta.url));
		const run = (role: string, env: Record<string, string>) => spawn(process.execPath, ["--import", "tsx", "src/main.ts", role], { cwd, env: { PATH: process.env.PATH!, ...env }, stdio: ["ignore", "pipe", "pipe"] });
		const out = (child: ReturnType<typeof run>) => {
			let text = "";
			child.stdout!.on("data", (c) => (text += c));
			child.stderr!.on("data", (c) => (text += c));
			return () => text;
		};
		const migrator = run("migrate", { PIM_DATABASE_URL: url.toString() });
		const migrated = out(migrator);
		const exit = await new Promise((resolve) => migrator.on("exit", (code, signal) => resolve(code ?? signal)));
		if (exit !== 0) console.log("MIGRATE", exit, migrated());
		expect(exit).toBe(0);
		expect(migrated()).toContain('"event":"pim.migrate"');
		const check = new pg.Client({ connectionString: url.toString() });
		await check.connect();
		expect((await check.query("SELECT count(DISTINCT number / 100)::int AS bands FROM public.pim_schema_migrations")).rows[0].bands).toBe(7);
		// The roles a deployment's logins belong to exist now; a Runner connects as one of them.
		await check.query("CREATE ROLE cli_runtime LOGIN NOSUPERUSER NOBYPASSRLS; GRANT pim_runtime TO cli_runtime");
		await check.end();
		const runnerUrl = new URL(url);
		runnerUrl.username = "cli_runtime";
		const env: Record<string, string> = { ...envFor(d, "runner", { PIM_HTTP_PORT: String(await freePort()), PIM_METRICS_PORT: String(await freePort()) }), PIM_DATABASE_URL: runnerUrl.toString() };
		const child = run("runner", env);
		const log = out(child);
		await waitFor("the process to answer /readyz", async () => ((await fetch(`http://127.0.0.1:${env.PIM_HTTP_PORT}/readyz`).catch(() => null))?.status === 200 ? true : undefined), 30_000);
		child.kill("SIGTERM");
		expect(await new Promise((resolve) => child.on("exit", resolve))).toBe(0);
		expect(log()).toContain('"event":"pim.stopping"');
		// A role it cannot start exits non-zero with a reason, so an orchestrator restarts it.
		const bad = run("gate", { ...env, PIM_DATABASE_URL: "" });
		const badLog = out(bad);
		expect(await new Promise((resolve) => bad.on("exit", resolve))).toBe(1);
		expect(badLog()).toContain("pim.failed");
		const drop = new pg.Client({ connectionString: process.env.PIM_V2_PG_URL });
		await drop.connect();
		await drop.query(`DROP DATABASE ${name} WITH (FORCE)`);
		await drop.end();
	}, 120_000);

	it("refuses a role it does not know", async () => {
		await expect(startProcess("teapot", {})).rejects.toThrow(/Unknown role/);
	});
});
