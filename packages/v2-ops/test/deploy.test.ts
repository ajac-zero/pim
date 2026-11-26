import { execFileSync } from "node:child_process";
import { chmodSync, cpSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { describe, expect, it } from "vitest";
import { parse, parseAllDocuments } from "yaml";
import { DEFAULT_POOL_BUDGETS } from "@pim/v2-contracts/db";
import { loadProcessConfig } from "@pim/v2-contracts/platform";
import { createPimMetrics } from "../src/observability/signals.ts";
import { BACKEND_PATHS } from "../../../web-host/src/routes.js";

const ROOT = new URL("../../../", import.meta.url).pathname;
const read = (path: string) => readFileSync(join(ROOT, path), "utf8");
const metricNames = new Set(createPimMetrics().registry.names());
// Histogram series carry these suffixes; the registry knows the base name.
const baseMetric = (name: string) => name.replace(/_(bucket|sum|count)$/, "");
const metricsIn = (expr: string) => [...expr.matchAll(/\b(pim_[a-z0-9_]+|cnpg_[a-z0-9_]+|up)\b/g)].map((m) => m[1]!);

describe("the workflows", () => {
	const workflow = (name: string) => parse(read(`.github/workflows/${name}.yml`)) as any;
	const ci = workflow("ci");
	const publish = workflow("publish");
	const compose = workflow("compose");

	it("starts CI for every pull request, however little changed, so a required check is never left pending", () => {
		for (const w of [ci, compose, publish]) for (const trigger of Object.values<any>(w.on ?? {})) expect(trigger?.paths, "no path filter on a trigger").toBeUndefined();
		expect(Object.keys(ci.on)).toEqual(expect.arrayContaining(["pull_request", "push", "workflow_dispatch"]));
		// One run per change: a branch with a pull request is not also run for its push.
		expect(ci.on.push.branches).toEqual(["main"]);
	});

	it("selects each job from the one table, and reports one check that always runs and fails unless every selected job passed", () => {
		const jobs = ci.jobs as Record<string, any>;
		for (const [name, job] of Object.entries(jobs)) {
			if (name === "changes" || name === "ci") continue;
			expect(job.needs, name).toBe("changes");
			expect(job.if, name).toMatch(/^fromJSON\(needs\.changes\.outputs\.scope\)\.jobs\./);
		}
		expect(jobs.ci.name).toBe("CI result");
		expect(jobs.ci.if).toBe("always()");
		expect(jobs.ci.needs).toEqual(["changes", ...Object.keys(jobs).filter((n) => n !== "changes" && n !== "ci")]);
		expect(jobs.changes.steps[0].with["fetch-depth"]).toBe(0);
	});

	it("cancels what a newer push to a pull request replaces, and never a run on main", () => {
		expect(ci.concurrency["cancel-in-progress"]).toMatch(/github\.event_name == 'pull_request'/);
		expect(compose.concurrency["cancel-in-progress"]).toMatch(/github\.ref != 'refs\/heads\/main'/);
		// Publishing is production: nothing in it is ever cancelled, not a build, not a retag, not the wait for CI.
		expect(publish.concurrency["cancel-in-progress"]).toBe(false);
		for (const job of ["edge", "bootstrap-edge", "release", "rollback-stable"]) expect(publish.jobs[job].concurrency["cancel-in-progress"], job).toBe(false);
		expect(JSON.stringify(publish)).not.toMatch(/"cancel-in-progress":(true|"\$\{\{)/);
	});

	it("builds an image only when its identity is new, and tags a reused one without claiming a build", () => {
		expect(publish.jobs.image.if).toMatch(/needs\.plan\.outputs\.build != '\[\]'/);
		expect(publish.jobs.image.strategy.matrix.include).toMatch(/fromJSON\(needs\.plan\.outputs\.build\)/);
		const build = publish.jobs.image.steps.find((s: any) => s.uses?.startsWith("docker/build-push-action"));
		expect(build.with.tags).toBe("${{ steps.tags.outputs.tags }}");
		expect(build.with.labels).toMatch(/dev\.pim\.image-identity=\$\{\{ matrix\.identity \}\}/);
		const tag = publish.jobs.image.steps.find((s: any) => s.name === "Tags");
		expect(tag.run).toContain("input-$IDENTITY");
		// The reused image is given tags with `imagetools create` from its identity tag (same manifest, same labels), never with a build.
		const reuse = publish.jobs.reuse.steps.find((s: any) => s.name === "Tag the reused images");
		expect(reuse.run).toContain('docker buildx imagetools create $tags "$repository:input-$identity"');
		expect(reuse.run).toContain("reused (built at");
		// Edge follows all three images, and a run where nothing was built still reaches it.
		expect(publish.jobs.edge.if).toMatch(/!cancelled\(\)/);
		expect(publish.jobs.edge.steps.find((s: any) => s.name === "Move edge").run).toContain("edge-promote.mjs promote");
		// Every writer of the edge record shares one group, and every writer of stable and X.Y another, so each record is read, judged and written by one run at a time.
		expect([publish.jobs.edge, publish.jobs["bootstrap-edge"]].map((j: any) => j.concurrency.group)).toEqual(["publish-edge", "publish-edge"]);
		expect([publish.jobs.release, publish.jobs["rollback-stable"]].map((j: any) => j.concurrency.group)).toEqual(["publish-stable", "publish-stable"]);
		// The image job writes the immutable version only; stable and X.Y are the release job's, decided by version precedence.
		expect(publish.jobs.plan.steps.find((s: any) => s.id === "meta").run).not.toMatch(/stable|\$\{version%\.\*\}/);
		expect(publish.jobs.release.steps.at(-1).run).toContain("release-promote.mjs reconcile");
		expect(publish.jobs.plan.if).toMatch(/inputs\.bootstrap_edge_commit == ''/);
		// Every image the plan names is one that Compose and Kubernetes use.
		expect(compose.jobs.smoke.if).toMatch(/\.smoke/);
	});

	it("shares one setup, caches the package store by the lockfile, and installs only the web app's closure for its jobs", () => {
		const setup = parse(read(".github/actions/setup/action.yml")) as any;
		expect(setup.runs.steps.find((s: any) => s.uses?.startsWith("actions/setup-node")).with.cache).toBe("pnpm");
		for (const name of ["web", "web-build"]) expect(ci.jobs[name].steps.find((s: any) => s.uses === "./.github/actions/setup").with.filter).toBe("pim-web...");
		const text = read(".github/workflows/ci.yml");
		expect(text).not.toMatch(/uses: pnpm\/action-setup/);
	});
});

describe("the Compose homelab profile", () => {
	const compose = parse(read("deploy/compose/compose.yaml"), { merge: true }) as any;
	const text = read("deploy/compose/compose.yaml");
	const env = read("deploy/compose/env.example");

	it("is self-contained: no Kubernetes, no Temporal, nothing from Cloudflare, no AWS service", () => {
		// What the stack runs (not the comments that say what it avoids).
		const effective = JSON.stringify(compose);
		for (const forbidden of [/temporal/i, /kubernetes|kubectl|k3s/i, /cloudflare|wrangler|workerd|durable[_ ]?object/i, /\bamazonaws\b|amazon\/|\blambda\b|\bdynamodb\b/i]) expect(effective, String(forbidden)).not.toMatch(forbidden);
		for (const [name, service] of Object.entries<any>(compose.services)) expect(service.image ?? service.build, name).toBeDefined();
	});

	it("has the core services, and the optional ones only behind profiles, so Pim starts with computer and coding off", () => {
		const core = ["caddy", "postgres", "pgbouncer", "nats", "seaweedfs", "objects-init", "migrator", "gate", "live", "runner", "forge", "maintenance", "web"];
		for (const name of core) expect(compose.services[name], name).toBeDefined();
		for (const name of core) expect(compose.services[name].profiles, `${name} is core`).toBeUndefined();
		const profiled: Record<string, string[]> = { canvas: ["canvas"], relay: ["computer"], coturn: ["computer"], "sandbox-manager": ["coding"], prometheus: ["observability"], grafana: ["observability"] };
		for (const [name, profiles] of Object.entries(profiled)) expect(compose.services[name].profiles, name).toEqual(profiles);
		// Nothing in the core waits for an optional service.
		for (const name of core) for (const dep of Object.keys(compose.services[name].depends_on ?? {})) expect(core, `${name} depends on ${dep}`).toContain(dep);
		expect(Object.keys(compose.services.runner.depends_on)).toEqual(expect.arrayContaining(["migrator", "pgbouncer", "nats", "objects-init"]));
	});

	it("makes the web app its own component: its own image, container and volume, no dependency on the backend, and nothing of it in the backend's image or services", () => {
		const web = compose.services.web;
		expect(web.image).toMatch(/PIM_WEB_IMAGE/);
		expect(web.image).not.toMatch(/\$\{PIM_IMAGE/);
		expect(web.volumes).toEqual(["pim-web:/web-releases"]);
		expect(compose.volumes).toHaveProperty("pim-web");
		// It has no secret, no database and no service to wait for, so it starts and is replaced alone.
		expect(web.env_file).toBeUndefined();
		expect(web.depends_on).toBeUndefined();
		expect(JSON.stringify(web.environment)).not.toMatch(/PASSWORD|SECRET|KEK|DATABASE|NATS|S3/);
		expect(web.read_only).toBe(true);
		expect(web.cap_drop).toEqual(["ALL"]);
		// Nothing else mounts the volume or is told where a build is.
		for (const [name, service] of Object.entries<any>(compose.services)) {
			if (name !== "web") expect(JSON.stringify([service.volumes ?? [], service.environment ?? {}]), name).not.toMatch(/pim-web|PIM_WEB_/);
		}
		expect(compose.services.caddy.depends_on.web.condition).toBe("service_healthy");
		expect(compose.services["web-release"]).toBeUndefined();
		// The backend image has no web stage, no web build and no variable that points at one.
		const backend = read("deploy/Dockerfile.v2");
		expect(backend).not.toMatch(/AS web\b|web\/dist|PIM_WEB_DIR|PIM_WEB_RELEASES|\/web-releases/);
		const frontend = read("deploy/Dockerfile.web");
		expect(frontend).toMatch(/COPY --from=web \/app\/web\/dist \/app\/dist/);
		expect(frontend).toMatch(/ENTRYPOINT \["node", "src\/main\.js"\]/);
		expect(frontend).not.toMatch(/packages\/v2-server\/src|COPY computer|COPY displayd/);
		expect(env).toMatch(/^PIM_WEB_IMAGE=ghcr\.io\/ajac-zero\/pim-web:stable$/m);
	});

	it("sends the backend's paths to the Gate and every other path to the web app, from one list that Caddy, Kubernetes and the preview share", () => {
		const caddy = read("deploy/compose/caddy/Caddyfile");
		const matcher = /@backend path ([^\n]+)/.exec(caddy)![1]!.split(" ");
		expect(matcher).toEqual(BACKEND_PATHS.flatMap((p) => [p, `${p}/*`]));
		// The content origin answers only published pages and the scripts their frames run.
		expect(caddy).toMatch(/@published path \/p \/p\/\*\n\s*handle @published \{\s*reverse_proxy gate:8080/);
		expect(caddy).toMatch(/handle \/artifact-runtime\/\* \{\s*reverse_proxy web:8080/);
		expect(caddy).toMatch(/handle \{\s*respond 404/);
		const preview = read("scripts/v2-dev/preview.mjs");
		expect(preview).toContain('import { isBackendPath } from "../../web-host/src/routes.js"');
	});

	it("releases the web app by its own tag: a pim.sh command that replaces only the web container, and rolls its image back on failure", () => {
		const directory = mkdtempSync(join(tmpdir(), "pim-sh-"));
		const compose_ = join(directory, "deploy", "compose");
		execFileSync("mkdir", ["-p", compose_, join(directory, "bin")]);
		cpSync(join(ROOT, "deploy/compose/pim.sh"), join(compose_, "pim.sh"));
		writeFileSync(join(compose_, "compose.yaml"), "services: {}\n");
		writeFileSync(join(compose_, ".env"), "PIM_IMAGE=ghcr.io/ajac-zero/pim:stable@sha256:backend\nPIM_WEB_IMAGE=ghcr.io/ajac-zero/pim-web:stable@sha256:old\nPIM_PUBLIC_URL=https://pim.example.test\n");
		// A docker that records what it is asked, knows the registry's digest for the web image, and fails `up` while FAIL_UP is set.
		const docker = join(directory, "bin", "docker");
		writeFileSync(docker, `#!/bin/sh\necho "$@" >> "$DOCKER_LOG"\ncase "$1" in\n  pull) exit 0 ;;\n  image) echo "ghcr.io/ajac-zero/pim-web@sha256:new" ;;\n  compose) case "$*" in *" up "*) [ -z "\${FAIL_UP:-}" ] ;; esac ;;\nesac\n`);
		chmodSync(docker, 0o755);
		const run = (extra: Record<string, string>) => {
			try {
				return { out: execFileSync("sh", [join(compose_, "pim.sh"), "update-web"], { cwd: compose_, env: { PATH: `${join(directory, "bin")}:${process.env.PATH}`, DOCKER_LOG: join(directory, "log"), ...extra }, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }), code: 0 };
			} catch (error: any) {
				return { out: String(error.stdout ?? ""), code: error.status as number };
			}
		};
		const envFile = () => readFileSync(join(compose_, ".env"), "utf8");
		// Succeeds: only the web image is moved, and only the `web` container is replaced, without its dependencies.
		const updated = run({});
		expect(updated.code).toBe(0);
		expect(JSON.parse(updated.out.trim().split("\n").at(-1)!)).toMatchObject({ event: "pim.update.web", result: "updated", to: "ghcr.io/ajac-zero/pim-web:stable@sha256:new" });
		expect(envFile()).toContain("PIM_WEB_IMAGE=ghcr.io/ajac-zero/pim-web:stable@sha256:new");
		expect(envFile()).toContain("PIM_WEB_IMAGE_PREVIOUS=ghcr.io/ajac-zero/pim-web:stable@sha256:old");
		expect(envFile()).toContain("PIM_IMAGE=ghcr.io/ajac-zero/pim:stable@sha256:backend");
		const log = readFileSync(join(directory, "log"), "utf8");
		expect(log).toContain("compose -f compose.yaml up -d --no-deps --wait web");
		expect(log).not.toMatch(/backup|pim:stable|up -d --wait\n/);
		// Fails: the previous image is put back.
		writeFileSync(join(compose_, ".env"), "PIM_IMAGE=ghcr.io/ajac-zero/pim:stable@sha256:backend\nPIM_WEB_IMAGE=ghcr.io/ajac-zero/pim-web:stable@sha256:old\nPIM_PUBLIC_URL=https://pim.example.test\n");
		const failed = run({ FAIL_UP: "1" });
		expect(failed.code).toBe(1);
		expect(JSON.parse(failed.out.trim().split("\n").at(-1)!)).toMatchObject({ result: "rolled_back" });
		expect(envFile()).toContain("PIM_WEB_IMAGE=ghcr.io/ajac-zero/pim-web:stable@sha256:old");
		rmSync(directory, { recursive: true, force: true });
	});

	it("updates the backend and the web app together, and a web image that cannot be pulled, or a stack that does not come up, leaves or puts back both pins", () => {
		const directory = mkdtempSync(join(tmpdir(), "pim-sh-update-"));
		try {
			const compose_ = join(directory, "deploy", "compose");
			execFileSync("mkdir", ["-p", compose_, join(directory, "bin"), join(directory, "scripts", "v2-backup")]);
			cpSync(join(ROOT, "deploy/compose/pim.sh"), join(compose_, "pim.sh"));
			writeFileSync(join(compose_, "compose.yaml"), "services: {}\n");
			writeFileSync(join(directory, "scripts", "v2-backup", "compose-backup.sh"), "#!/bin/sh\nmkdir -p \"$1\"\necho backup >> \"$DOCKER_LOG\"\n");
			chmodSync(join(directory, "scripts", "v2-backup", "compose-backup.sh"), 0o755);
			const docker = join(directory, "bin", "docker");
			writeFileSync(docker, `#!/bin/sh\necho "$@" >> "$DOCKER_LOG"\ncase "$1" in\n  pull) case "$*" in *pim-web*) [ -z "\${PULL_FAIL_WEB:-}" ] ;; esac ;;\n  image) echo "ghcr.io/ajac-zero/pim@sha256:newbackend"; echo "ghcr.io/ajac-zero/pim-web@sha256:newweb" ;;\n  compose) case "$*" in *" up "*) [ -z "\${FAIL_UP:-}" ] ;; esac ;;\nesac\n`);
			chmodSync(docker, 0o755);
			const before = "PIM_IMAGE=ghcr.io/ajac-zero/pim:stable@sha256:oldbackend\nPIM_WEB_IMAGE=ghcr.io/ajac-zero/pim-web:stable@sha256:oldweb\nPIM_PUBLIC_URL=https://pim.example.test\n";
			const envFile = () => readFileSync(join(compose_, ".env"), "utf8");
			const run = (extra: Record<string, string>) => {
				writeFileSync(join(compose_, ".env"), before);
				writeFileSync(join(directory, "log"), "");
				try {
					return { out: execFileSync("sh", [join(compose_, "pim.sh"), "update"], { cwd: compose_, env: { PATH: `${join(directory, "bin")}:${process.env.PATH}`, DOCKER_LOG: join(directory, "log"), ...extra }, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }), code: 0 };
				} catch (error: any) {
					return { out: String(error.stdout ?? ""), code: error.status as number };
				}
			};
			const last = (out: string) => JSON.parse(out.trim().split("\n").at(-1)!);
			const log = () => readFileSync(join(directory, "log"), "utf8");
			// Both images are pulled, backed up first, and both pins move in the one `up` that recreates the stack.
			const updated = run({});
			expect(updated.code).toBe(0);
			expect(last(updated.out)).toMatchObject({ result: "updated" });
			expect(envFile()).toContain("PIM_IMAGE=ghcr.io/ajac-zero/pim:stable@sha256:newbackend");
			expect(envFile()).toContain("PIM_WEB_IMAGE=ghcr.io/ajac-zero/pim-web:stable@sha256:newweb");
			expect(envFile()).toContain("PIM_WEB_IMAGE_PREVIOUS=ghcr.io/ajac-zero/pim-web:stable@sha256:oldweb");
			expect(log().split("\n").filter((l) => /^pull|backup|compose .* up/.test(l))).toEqual(["pull -q ghcr.io/ajac-zero/pim:stable", "pull -q ghcr.io/ajac-zero/pim-web:stable", "backup", "compose -f compose.yaml up -d --wait"]);
			// A web image that cannot be pulled (not published yet) stops the update before anything is backed up, pinned or recreated: the running stack is as it was.
			const unpublished = run({ PULL_FAIL_WEB: "1" });
			expect(unpublished.code).toBe(1);
			expect(last(unpublished.out)).toMatchObject({ result: "failed" });
			expect(envFile()).toBe(before);
			expect(log()).not.toMatch(/backup|compose/);
			// A stack that does not come up with the new pair goes back to the old backend and the old web app together.
			const broken = run({ FAIL_UP: "1" });
			expect(broken.code).toBe(1);
			expect(last(broken.out)).toMatchObject({ result: "rolled_back" });
			expect(envFile()).toContain("PIM_IMAGE=ghcr.io/ajac-zero/pim:stable@sha256:oldbackend");
			expect(envFile()).toContain("PIM_WEB_IMAGE=ghcr.io/ajac-zero/pim-web:stable@sha256:oldweb");
		} finally {
			rmSync(directory, { recursive: true, force: true });
		}
	});

	it("orders startup by health: postgres, then pooler and migrator, then roles; roles wait for the migrator to finish", () => {
		expect(compose.services.pgbouncer.depends_on.postgres.condition).toBe("service_healthy");
		expect(compose.services.migrator.depends_on.postgres.condition).toBe("service_healthy");
		for (const role of ["gate", "live", "runner", "forge", "maintenance"]) {
			const deps = compose.services[role].depends_on;
			expect(deps.migrator.condition, role).toBe("service_completed_successfully");
			expect(compose.services[role].healthcheck, role).toBeDefined();
		}
		expect(compose.services.caddy.depends_on.gate.condition).toBe("service_healthy");
		// No dependency cycle among services.
		const visiting = new Set<string>();
		const done = new Set<string>();
		const visit = (name: string) => {
			expect(visiting.has(name), `cycle through ${name}`).toBe(false);
			if (done.has(name)) return;
			visiting.add(name);
			for (const dep of Object.keys(compose.services[name].depends_on ?? {})) visit(dep);
			visiting.delete(name);
			done.add(name);
		};
		for (const name of Object.keys(compose.services)) visit(name);
	});

	it("runs PostgreSQL 17 with no unsafe durability flag anywhere, and scoped non-superuser roles", () => {
		expect(compose.services.postgres.image).toMatch(/^postgres:17\./);
		const conf = read("deploy/compose/postgres/postgresql.conf");
		expect(conf).toMatch(/^fsync = on$/m);
		expect(conf).toMatch(/^full_page_writes = on$/m);
		expect(conf).toMatch(/^synchronous_commit = on$/m);
		for (const file of ["deploy/compose/compose.yaml", "deploy/compose/postgres/postgresql.conf", "deploy/k8s/base/postgres.yaml"]) expect(read(file), file).not.toMatch(/fsync\s*=\s*off|full_page_writes\s*=\s*off|synchronous_commit\s*=\s*(off|local)|synchronous_commit:\s*"?(off|local)|unlogged/i);
		const init = read("deploy/compose/postgres/init/00-roles.sh");
		// The roles are the ones @pim/v2-contracts' 0001_foundation.sql defines, and every login is a member of exactly its own.
		const foundation = read("packages/v2-contracts/migrations/0001_foundation.sql");
		for (const role of ["pim_gate", "pim_runtime", "pim_live", "pim_forge", "pim_maintenance"]) {
			expect(foundation, role).toContain(`'${role}'`);
			expect(init, role).toMatch(new RegExp(`CREATE ROLE ${role} NOLOGIN`));
			expect(init, role).toMatch(new RegExp(`CREATE ROLE ${role}_login LOGIN .*IN ROLE ${role} NOSUPERUSER NOBYPASSRLS`));
		}
		expect(init).toMatch(/CREATE ROLE pim_migrator LOGIN .*NOSUPERUSER NOBYPASSRLS/);
		expect(init).not.toMatch(/\bSUPERUSER\b(?<!NOSUPERUSER)/);
		expect(init).not.toMatch(/pim_app_role|pim_runtime_role|pim_readonly_role/);
		// Statement timeouts equal the contracts' pool budgets.
		for (const [role, pool] of [["gate", "foreground"], ["live", "foreground"], ["runtime", "runtime"], ["forge", "forge"], ["maintenance", "maintenance"]] as const) expect(init, role).toContain(`ALTER ROLE pim_${role}_login SET statement_timeout = '${DEFAULT_POOL_BUDGETS[pool].statementTimeoutMs / 1000}s'`);
		const grants = read("packages/v2-ops/sql/0502_grants.sql").replace(/^--.*$/gm, "");
		expect(grants).not.toMatch(/TO PUBLIC/);
		expect(grants).toMatch(/GRANT SELECT[^;]*secret_envelopes TO pim_gate/);
		expect(grants).not.toMatch(/secret_envelopes[^;]*TO[^;]*pim_live/);
	});

	it("gives every role an environment that @pim/v2-contracts' loadProcessConfig accepts, and a role it names", () => {
		const filled = (value: unknown) => String(value).replace(/\$\{([A-Z0-9_]+)(?::[-?][^}]*)?\}/g, (_m, name: string) => (name === "PIM_PUBLIC_URL" ? "https://pim.example.test" : `value-of-${name}`));
		for (const [service, role] of [["gate", "gate"], ["live", "live"], ["runner", "runner"], ["forge", "forge"], ["maintenance", "maintenance"], ["canvas", "canvas"], ["relay", "relay"]] as const) {
			const env = Object.fromEntries(Object.entries<unknown>(compose.services[service].environment).map(([k, v]) => [k, filled(v)]));
			const config = loadProcessConfig(env);
			expect(config.role, service).toBe(role);
			expect(config.natsUrl).toBe("nats://nats:4222");
		}
		// The migrator is the SQL runner, not a process role.
		expect(compose.services.migrator.environment.PIM_ROLE).toBeUndefined();
	});

	it("pools connections in transaction mode with bounded per-role pools; the migrator and maintenance bypass the pooler", () => {
		const ini = read("deploy/compose/pgbouncer/pgbouncer.ini");
		expect(ini).toMatch(/^pool_mode = transaction$/m);
		expect(ini).toMatch(/^max_user_connections = \d+$/m);
		expect(ini).toMatch(/^max_db_connections = \d+$/m);
		expect(ini).toMatch(/^auth_type = scram-sha-256$/m);
		expect(compose.services.gate.environment.PIM_DATABASE_URL).toMatch(/pim_gate_login:.*@pgbouncer:6432\//);
		expect(compose.services.runner.environment.PIM_DATABASE_URL).toContain("pim_runtime_login");
		expect(compose.services.live.environment.PIM_DATABASE_URL).toContain("pim_live_login");
		expect(compose.services.forge.environment.PIM_DATABASE_URL).toContain("pim_forge_login");
		expect(compose.services.migrator.environment.PIM_DATABASE_URL).toMatch(/pim_migrator:.*@postgres:5432/);
		expect(compose.services.maintenance.environment.PIM_DATABASE_URL).toMatch(/pim_maintenance_login:.*@postgres:5432/);
	});

	it("scales Runners, drains them on stop, and routes the paths the audit lists to the right role", () => {
		expect(compose.services.runner.stop_grace_period).toBe("120s");
		expect(Number(compose.services.runner.environment.PIM_DRAIN_WINDOW_SECONDS)).toBeLessThan(120);
		const caddy = read("deploy/compose/caddy/Caddyfile");
		expect(caddy).toMatch(/@live path \/api\/ws[^\n]*\n\s*handle @live \{\s*reverse_proxy live:8080/);
		expect(caddy).toMatch(/\/api\/notes\/live[\s\S]*reverse_proxy canvas:8080/);
		expect(caddy).toMatch(/\/api\/computer[\s\S]*reverse_proxy relay:8080/);
		expect(caddy).toMatch(/handle @backend \{\s*reverse_proxy gate:8080/);
		expect(caddy).toMatch(/handle \{\s*reverse_proxy web:8080/);
		expect(caddy).toContain("header_up X-Pim-Ingress-Secret {env.PIM_INGRESS_SECRET}");
	});

	it("takes every required variable from env.example, with no real secret committed, and hardens every Pim container", () => {
		const required = new Set([...text.matchAll(/\$\{([A-Z0-9_]+):\?/g)].map((m) => m[1]!));
		const defined = new Set([...env.matchAll(/^([A-Z0-9_]+)=/gm)].map((m) => m[1]!));
		for (const name of required) expect(defined.has(name), `${name} is in env.example`).toBe(true);
		for (const line of env.split("\n").filter((l) => /(PASSWORD|SECRET|KEY|TOKEN)[A-Z_0-9]*=/.test(l))) expect(line, line).toMatch(/=(CHANGE_ME|)$|=k1$|=pim-objects$/);
		for (const role of ["gate", "live", "runner", "forge", "maintenance", "migrator"]) {
			const s = compose.services[role];
			expect(s.read_only, role).toBe(true);
			expect(s.cap_drop, role).toEqual(["ALL"]);
			expect(s.security_opt, role).toContain("no-new-privileges:true");
		}
		for (const [name, service] of Object.entries<any>(compose.services)) if (service.image) expect(service.image, name).not.toMatch(/:latest$|^[^:]+$/);
		expect(compose.services.postgres.ports).toBeUndefined();
		expect(compose.services.caddy.ports).toBeDefined();
	});
});

const bin = (name: string) => [join(homedir(), ".cache", "pim-bench", name), `/usr/local/bin/${name}`].find((p) => existsSync(p));

describe("the Kubernetes manifests (Kustomize)", () => {
	const docs = (dir: string) => readdirSync(join(ROOT, dir)).filter((f) => f.endsWith(".yaml") && f !== "kustomization.yaml" && f !== "secrets.example.yaml").flatMap((f) => parseAllDocuments(read(`${dir}/${f}`)).map((d) => d.toJS() as any));
	const base = docs("deploy/k8s/base");
	const kind = (k: string) => base.filter((d) => d?.kind === k);

	it("builds with kustomize and validates against the Kubernetes and operator schemas (kubeconform)", () => {
		const kustomize = bin("kustomize");
		const kubeconform = bin("kubeconform");
		if (!kustomize || !kubeconform) {
			console.warn("kustomize/kubeconform not installed: schema validation skipped (see docs/v2-operations.md)");
			return;
		}
		for (const target of ["deploy/k8s", "deploy/k8s/overlays/production", "deploy/k8s/overlays/monitoring"]) {
			const built = execFileSync(kustomize, ["build", join(ROOT, target), "--load-restrictor", "LoadRestrictionsNone"], { encoding: "utf8" });
			expect(built.length).toBeGreaterThan(1000);
			try {
				execFileSync(kubeconform, ["-strict", "-summary", "-kubernetes-version", "1.30.0", "-schema-location", "default", "-schema-location", "https://raw.githubusercontent.com/datreeio/CRDs-catalog/main/{{.Group}}/{{.ResourceKind}}_{{.ResourceAPIVersion}}.json"], { input: built, encoding: "utf8" });
			} catch (error) {
				throw new Error(`${target} failed schema validation:\n${(error as { stdout?: string }).stdout ?? error}`);
			}
		}
	}, 120_000);

	it("gives each role its own Deployment, a disruption budget, and (where it scales) an HPA that targets it", () => {
		const roles = ["gate", "live", "runner", "forge", "canvas", "relay", "maintenance"];
		const deployments = new Map(kind("Deployment").map((d) => [d.metadata.name, d]));
		for (const role of roles) expect(deployments.get(`pim-${role}`), role).toBeDefined();
		const pdbs = new Set(kind("PodDisruptionBudget").map((p) => p.metadata.name));
		for (const role of roles.filter((r) => r !== "maintenance")) expect(pdbs.has(`pim-${role}`), `${role} PDB`).toBe(true);
		for (const hpa of kind("HorizontalPodAutoscaler")) expect(deployments.has(hpa.spec.scaleTargetRef.name), hpa.metadata.name).toBe(true);
		expect(new Set(kind("HorizontalPodAutoscaler").map((h) => h.metadata.name))).toEqual(new Set(["gate", "live", "runner", "forge", "canvas", "relay"].map((r) => `pim-${r}`)));
		for (const p of kind("PodDisruptionBudget")) expect(p.spec.minAvailable !== undefined || p.spec.maxUnavailable !== undefined).toBe(true);
	});

	it("gives every role an environment that loadProcessConfig accepts, from the ConfigMap, literals and Secret references", () => {
		const cm = kind("ConfigMap").find((c) => c.metadata.name === "pim-config").data as Record<string, string>;
		for (const role of ["gate", "live", "runner", "forge", "canvas", "relay", "maintenance"]) {
			const deployment = kind("Deployment").find((d) => d.metadata.name === `pim-${role}`);
			const container = deployment.spec.template.spec.containers[0];
			const env: Record<string, string> = { ...cm };
			for (const e of container.env) env[e.name] = e.value ?? (e.valueFrom.secretKeyRef ? (/endpoint$/.test(e.valueFrom.secretKeyRef.key) ? "https://s3.example.test" : `secret:${e.valueFrom.secretKeyRef.name}/${e.valueFrom.secretKeyRef.key}`) : `pod-name-of-${role}`);
			const config = loadProcessConfig(env);
			expect(config.role).toBe(role);
			expect(config.natsUrl).toBe("nats://pim-nats:4222");
			if (role === "runner") expect(config.runnerHolderId).toMatch(/^pod-name/);
			// The login's secret key names its role: a Runner gets the runtime login, never the migrator's.
			expect(env.PIM_DATABASE_URL).not.toContain("migrator");
		}
		const keys = Object.fromEntries(kind("Deployment").filter((d) => d.metadata.name !== "pim-web").map((d) => [d.metadata.name, d.spec.template.spec.containers[0].env.find((e: any) => e.name === "PIM_DATABASE_URL").valueFrom.secretKeyRef.key]));
		expect(keys).toMatchObject({ "pim-gate": "gate-url", "pim-live": "live-url", "pim-runner": "runtime-url", "pim-forge": "forge-url", "pim-maintenance": "maintenance-url" });
		const cluster = kind("Cluster")[0];
		const roles = new Map<string, any>(cluster.spec.managed.roles.map((r: any) => [r.name, r]));
		for (const r of ["gate", "runtime", "live", "forge", "maintenance"]) {
			expect(roles.get(`pim_${r}`).login).toBe(false);
			expect(roles.get(`pim_${r}_login`)).toMatchObject({ login: true, inRoles: [`pim_${r}`], superuser: false, bypassrls: false });
		}
		for (const r of roles.values()) expect(r.superuser).toBe(false);
	});

	it("serves the web app from its own Deployment and image, and routes to it every path the backend does not own", () => {
		const web = kind("Deployment").find((d) => d.metadata.name === "pim-web");
		const spec = web.spec.template.spec;
		const container = spec.containers[0];
		expect(container.image).toMatch(/\/pim-web:/);
		expect(container.envFrom).toBeUndefined();
		expect(JSON.stringify(container.env)).not.toMatch(/secretKeyRef|configMapRef/);
		expect(spec.serviceAccountName).toBeUndefined();
		expect(spec.automountServiceAccountToken).toBe(false);
		expect(container.securityContext.readOnlyRootFilesystem).toBe(true);
		expect(kind("PersistentVolumeClaim").find((c) => c.metadata.name === "pim-web-releases").spec.accessModes).toEqual(["ReadWriteMany"]);
		// Only the web app's image is the web app's: no backend Deployment mounts its volume, and the backend images carry no web variable.
		for (const d of kind("Deployment").filter((d) => d.metadata.name !== "pim-web")) expect(JSON.stringify(d.spec.template.spec), d.metadata.name).not.toMatch(/pim-web-releases|PIM_WEB_/);
		const ingress = kind("Ingress")[0];
		const rules = new Map<string, any[]>(ingress.spec.rules.map((r: any) => [r.host, r.http.paths]));
		const to = (paths: any[], path: string) => paths.find((p) => p.path === path)?.backend.service.name;
		const main = rules.get("pim.example.test")!;
		for (const path of BACKEND_PATHS) expect(to(main, path), path).toBe("pim-gate");
		expect(to(main, "/")).toBe("pim-web");
		expect(to(main, "/api/ws")).toBe("pim-live");
		const content = rules.get("content.pim.example.test")!;
		expect(content.map((p) => [p.path, p.backend.service.name])).toEqual([["/p", "pim-gate"], ["/artifact-runtime", "pim-web"]]);
		expect(JSON.stringify(kind("NetworkPolicy"))).toMatch(/"values":\["gate","live","canvas","relay","web"\]/);
		const images = (parse(read("deploy/k8s/base/kustomization.yaml")) as any).images;
		expect(images.map((i: any) => i.name)).toEqual(expect.arrayContaining(["registry.example.test/pim", "registry.example.test/pim-web"]));
	});

	it("drains a Runner: SIGTERM and a preStop hook leave time to hand leases back, bounded below the grace period", () => {
		const runner = kind("Deployment").find((d) => d.metadata.name === "pim-runner");
		const spec = runner.spec.template.spec;
		const container = spec.containers[0];
		expect(container.lifecycle.preStop.exec.command.join(" ")).toContain("/drain");
		const drain = Number(container.env.find((e: any) => e.name === "PIM_DRAIN_WINDOW_SECONDS").value);
		expect(spec.terminationGracePeriodSeconds).toBeGreaterThan(drain + 5);
		const hpa = kind("HorizontalPodAutoscaler").find((h) => h.metadata.name === "pim-runner");
		expect(hpa.spec.behavior.scaleDown.stabilizationWindowSeconds).toBeGreaterThanOrEqual(300);
		expect(kind("Deployment").find((d) => d.metadata.name === "pim-maintenance").spec.replicas).toBe(1);
	});

	it("hardens every pod: non-root, read-only filesystem, no capabilities, no service-account token, pinned images, probes, no inline secret", () => {
		for (const d of [...kind("Deployment"), ...kind("StatefulSet"), ...kind("Job")]) {
			const pod = d.spec.template.spec;
			expect(pod.automountServiceAccountToken, d.metadata.name).toBe(false);
			expect(pod.securityContext.runAsNonRoot, d.metadata.name).toBe(true);
			for (const c of pod.containers) {
				expect(c.securityContext.readOnlyRootFilesystem, `${d.metadata.name}/${c.name}`).toBe(true);
				expect(c.securityContext.allowPrivilegeEscalation, `${d.metadata.name}/${c.name}`).toBe(false);
				expect(c.securityContext.capabilities.drop, `${d.metadata.name}/${c.name}`).toEqual(["ALL"]);
				expect(c.image, c.name).not.toMatch(/:latest$|^[^:]+$/);
				expect(c.resources.limits.memory, c.name).toBeDefined();
				for (const e of c.env ?? []) if (/KEY|SECRET|TOKEN|PASSWORD|URL/.test(e.name) && e.value !== undefined) expect(e.name, `${d.metadata.name} ${e.name} must come from a Secret`).toMatch(/^(PIM_KEK_DIR|PIM_ROLE|PIM_HTTP_PORT|PIM_KEK_CURRENT|PIM_DRAIN_WINDOW_SECONDS|PIM_S3_REGION)$/);
			}
			if (d.kind === "Deployment" && d.metadata.name !== "pim-migrate") for (const c of pod.containers) expect(c.readinessProbe && c.livenessProbe && c.startupProbe, c.name).toBeTruthy();
		}
		const cm = kind("ConfigMap").find((c) => c.metadata.name === "pim-config");
		for (const key of Object.keys(cm.data)) expect(key, "ConfigMap holds no secrets").not.toMatch(/KEY(?!_CURRENT)|SECRET|TOKEN|PASSWORD/);
	});

	it("sets the PostgreSQL cluster up with PITR and a stated durability choice, and never claims zero-loss on async replication", () => {
		const text = read("deploy/k8s/base/postgres.yaml");
		const cluster = kind("Cluster")[0];
		expect(cluster.spec.instances).toBeGreaterThanOrEqual(3);
		expect(cluster.spec.postgresql.synchronous).toMatchObject({ method: "any", number: 1, dataDurability: "required" });
		expect(cluster.spec.postgresql.parameters.synchronous_commit).toBe("on");
		expect(cluster.spec.backup.barmanObjectStore.wal).toBeDefined();
		expect(cluster.spec.backup.retentionPolicy).toBeDefined();
		expect(kind("ScheduledBackup")).toHaveLength(1);
		const pooler = kind("Pooler")[0];
		expect(pooler.spec.pgbouncer.poolMode).toBe("transaction");
		expect(pooler.spec.type).toBe("rw");
		expect(cluster.spec.affinity.podAntiAffinityType).toBe("required");
		// The tradeoff is written down, with both sides.
		expect(text).toMatch(/DURABILITY AND AVAILABILITY/);
		expect(text).toMatch(/dataDurability: preferred/);
		expect(text).toMatch(/asynchronous, and a primary failure can lose/);
		expect(text).not.toMatch(/zero[- ]?(data[- ])?loss failover|no data loss on failover/i);
	});

	it("isolates untrusted sandbox compute from PostgreSQL, NATS and the control plane, at both ends", () => {
		const sandbox = parseAllDocuments(read("deploy/k8s/sandboxes/sandboxes.yaml")).map((d) => d.toJS() as any);
		const runtime = sandbox.find((d) => d.kind === "RuntimeClass");
		expect(runtime.handler).toBe("runsc");
		expect(runtime.scheduling.tolerations[0].key).toBe("pim.dev/untrusted");
		const template = sandbox.find((d) => d.kind === "Deployment");
		expect(template.spec.template.spec.runtimeClassName).toBe("gvisor");
		expect(template.spec.template.spec.automountServiceAccountToken).toBe(false);
		// Egress: default deny, then DNS, the Gate and the public internet minus private ranges.
		const denyAll = sandbox.find((d) => d.kind === "NetworkPolicy" && d.metadata.name === "default-deny-all");
		expect(denyAll.spec.policyTypes).toEqual(["Ingress", "Egress"]);
		const egress = sandbox.find((d) => d.metadata.name === "sandbox-egress").spec.egress;
		const targets = JSON.stringify(egress);
		expect(targets).toContain('"app.kubernetes.io/component":"gate"');
		expect(targets).not.toMatch(/postgres|nats|cnpg|runner|pgbouncer/i);
		const ipBlock = egress.flatMap((e: any) => e.to).find((t: any) => t.ipBlock).ipBlock;
		for (const range of ["10.0.0.0/8", "172.16.0.0/12", "192.168.0.0/16", "169.254.0.0/16"]) expect(ipBlock.except).toContain(range);
		// Ingress to the control plane: default deny; PostgreSQL and NATS accept only control-tier pods.
		const policies = kind("NetworkPolicy");
		expect(policies.find((p) => p.metadata.name === "default-deny-ingress").spec.podSelector).toEqual({});
		for (const name of ["allow-control-to-postgres", "allow-control-to-nats", "allow-control-to-pooler"]) {
			const from = policies.find((p) => p.metadata.name === name).spec.ingress.flatMap((i: any) => i.from);
			for (const peer of from) expect(JSON.stringify(peer), name).toMatch(/pim\.dev\/tier":"control|cnpg\.io\/poolerName":"pim-pg-pooler-rw/);
			expect(JSON.stringify(from), name).not.toContain("sandbox");
		}
		const gateFrom = JSON.stringify(policies.find((p) => p.metadata.name === "allow-sandboxes-to-gate").spec);
		expect(gateFrom).toContain("pim-sandboxes");
		expect(gateFrom).toContain('"app.kubernetes.io/component":"gate"');
		expect(sandbox.filter((d) => d.kind === "Pod" || d.kind === "Deployment").every((d) => d.metadata.namespace === "pim-sandboxes")).toBe(true);
	});

	it("takes secrets from OpenBao through External Secrets, one per Secret the workloads read, and commits none", () => {
		const external = parseAllDocuments(read("deploy/k8s/overlays/openbao/external-secrets.yaml")).map((d) => d.toJS() as any);
		expect(external.find((d) => d.kind === "SecretStore").spec.provider.vault.auth.kubernetes.role).toBe("pim");
		const wanted = new Set(kind("Deployment").flatMap((d) => d.spec.template.spec.containers.flatMap((c: any) => (c.env ?? []).map((e: any) => e.valueFrom?.secretKeyRef?.name).filter(Boolean))).concat(["pim-kek"]));
		for (const name of wanted) expect(external.some((d) => d.kind === "ExternalSecret" && d.spec.target.name === name), `ExternalSecret for ${name}`).toBe(true);
		for (const doc of base) expect(doc?.kind, "no Secret in the base").not.toBe("Secret");
	});
});

describe("alert rules, the dashboard and the runbooks", () => {
	const rules = parse(read("deploy/observability/prometheus/pim-alerts.rules.yml")) as { groups: { rules: any[] }[] };
	const alerts = rules.groups.flatMap((g) => g.rules);
	const dashboard = JSON.parse(read("deploy/observability/grafana/dashboards/pim-operations.json"));
	const runbook = read("deploy/observability/runbooks/README.md");
	const known = (name: string) => metricNames.has(baseMetric(name)) || /^cnpg_/.test(name) || name === "up";

	it("every alert and dashboard query uses a metric the services really export", () => {
		for (const alert of alerts) for (const metric of metricsIn(alert.expr)) expect(known(metric), `${alert.alert}: ${metric}`).toBe(true);
		for (const panel of dashboard.panels) for (const target of panel.targets) for (const metric of metricsIn(target.expr)) expect(known(metric), `${panel.title}: ${metric}`).toBe(true);
	});

	it("covers every required signal with a panel, and every alert has a runbook section", () => {
		const exprs = dashboard.panels.flatMap((p: any) => p.targets.map((t: any) => t.expr)).join("\n");
		for (const metric of ["pim_http_request_duration_seconds", "pim_nodejs_event_loop_delay_seconds", "pim_pg_pool_wait_seconds", "pim_pg_query_duration_seconds", "pim_pg_commit_batch_duration_seconds", "pim_inbox_oldest_age_seconds", "pim_due_work_oldest_age_seconds", "pim_partition_ownership_transfers_total", "pim_fencing_rejects_total", "pim_projection_lag_seconds", "pim_live_cursor_replay_lag_seconds", "pim_live_websockets_active", "pim_live_slow_client_coalesced_total", "pim_live_slow_client_overflow_total", "pim_model_request_duration_seconds", "pim_model_errors_total", "pim_model_tokens_total", "pim_spend_usd_total"]) expect(exprs, metric).toContain(metric);
		for (const alert of alerts) {
			expect(runbook, alert.alert).toMatch(new RegExp(`^## ${alert.alert}$`, "m"));
			expect(alert.annotations.runbook).toContain(`#${alert.alert.toLowerCase()}`);
			expect(["warning", "critical"]).toContain(alert.labels.severity);
		}
	});

	it("the Kubernetes PrometheusRule carries exactly the same rules as the plain file", () => {
		const pr = parse(read("deploy/k8s/overlays/monitoring/prometheus-rule.yaml")) as any;
		expect(pr.spec).toEqual(rules);
	});
});
