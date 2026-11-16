import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { describe, expect, it } from "vitest";
import { parse, parseAllDocuments } from "yaml";
import { createPimMetrics } from "../src/observability/signals.ts";

const ROOT = new URL("../../../", import.meta.url).pathname;
const read = (path: string) => readFileSync(join(ROOT, path), "utf8");
const metricNames = new Set(createPimMetrics().registry.names());
// Histogram series carry these suffixes; the registry knows the base name.
const baseMetric = (name: string) => name.replace(/_(bucket|sum|count)$/, "");
const metricsIn = (expr: string) => [...expr.matchAll(/\b(pim_[a-z0-9_]+|cnpg_[a-z0-9_]+|up)\b/g)].map((m) => m[1]!);

describe("the Compose homelab profile", () => {
	const compose = parse(read("deploy/compose/compose.yaml"), { merge: true }) as any;
	const text = read("deploy/compose/compose.yaml");
	const env = read("deploy/compose/.env.example");

	it("is self-contained: no Kubernetes, no Temporal, nothing from Cloudflare, no AWS service", () => {
		// What the stack runs (not the comments that say what it avoids).
		const effective = JSON.stringify(compose);
		for (const forbidden of [/temporal/i, /kubernetes|kubectl|k3s/i, /cloudflare|wrangler|workerd|durable[_ ]?object/i, /\bamazonaws\b|amazon\/|\blambda\b|\bdynamodb\b/i]) expect(effective, String(forbidden)).not.toMatch(forbidden);
		for (const [name, service] of Object.entries<any>(compose.services)) expect(service.image ?? service.build, name).toBeDefined();
	});

	it("has the core services, and the optional ones only behind profiles, so Pim starts with computer and coding off", () => {
		const core = ["caddy", "postgres", "pgbouncer", "nats", "seaweedfs", "objects-init", "migrator", "gate", "live", "runner", "forge", "maintenance"];
		for (const name of core) expect(compose.services[name], name).toBeDefined();
		for (const name of core) expect(compose.services[name].profiles, `${name} is core`).toBeUndefined();
		const profiled: Record<string, string[]> = { canvas: ["canvas"], relay: ["computer"], coturn: ["computer"], "sandbox-manager": ["coding"], prometheus: ["observability"], grafana: ["observability"] };
		for (const [name, profiles] of Object.entries(profiled)) expect(compose.services[name].profiles, name).toEqual(profiles);
		// Nothing in the core waits for an optional service.
		for (const name of core) for (const dep of Object.keys(compose.services[name].depends_on ?? {})) expect(core, `${name} depends on ${dep}`).toContain(dep);
		expect(Object.keys(compose.services.runner.depends_on)).toEqual(expect.arrayContaining(["migrator", "pgbouncer", "nats", "objects-init"]));
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
		for (const role of ["pim_migrator", "pim_app_role", "pim_runtime_role", "pim_readonly_role"]) expect(init, role).toMatch(new RegExp(`CREATE ROLE ${role} LOGIN .*NOSUPERUSER NOBYPASSRLS`));
		expect(init).not.toMatch(/\bSUPERUSER\b(?<!NOSUPERUSER)/);
		const roles = read("packages/v2-ops/sql/0502_roles.sql");
		expect(roles).toContain("pim_readonly_role");
		expect(roles).toMatch(/REVOKE ALL ON pim\.secret_envelopes FROM pim_readonly_role/);
	});

	it("pools connections in transaction mode with bounded per-role pools; the migrator and maintenance bypass the pooler", () => {
		const ini = read("deploy/compose/pgbouncer/pgbouncer.ini");
		expect(ini).toMatch(/^pool_mode = transaction$/m);
		expect(ini).toMatch(/^max_user_connections = \d+$/m);
		expect(ini).toMatch(/^max_db_connections = \d+$/m);
		expect(ini).toMatch(/^auth_type = scram-sha-256$/m);
		expect(compose.services.gate.environment.PIM_DATABASE_URL).toContain("@pgbouncer:6432/");
		expect(compose.services.runner.environment.PIM_DATABASE_URL).toContain("pim_runtime_role");
		expect(compose.services.migrator.environment.PIM_DATABASE_URL).toMatch(/pim_migrator:.*@postgres:5432/);
		expect(compose.services.maintenance.environment.PIM_DATABASE_URL).toMatch(/@postgres:5432/);
	});

	it("scales Runners, drains them on stop, and routes the paths the audit lists to the right role", () => {
		expect(compose.services.runner.stop_grace_period).toBe("120s");
		expect(Number(compose.services.runner.environment.PIM_DRAIN_WINDOW_SECONDS)).toBeLessThan(120);
		const caddy = read("deploy/compose/caddy/Caddyfile");
		expect(caddy).toMatch(/@live path \/api\/ws[^\n]*\n\s*handle @live \{\s*reverse_proxy live:8080/);
		expect(caddy).toMatch(/\/api\/notes\/live[\s\S]*reverse_proxy canvas:8080/);
		expect(caddy).toMatch(/\/api\/computer[\s\S]*reverse_proxy relay:8080/);
		expect(caddy).toMatch(/handle \{\s*reverse_proxy gate:8080/);
		expect(caddy).toContain("header_up X-Pim-Ingress-Secret {env.PIM_INGRESS_SECRET}");
	});

	it("takes every required variable from .env.example, with no real secret committed, and hardens every Pim container", () => {
		const required = new Set([...text.matchAll(/\$\{([A-Z0-9_]+):\?/g)].map((m) => m[1]!));
		const defined = new Set([...env.matchAll(/^([A-Z0-9_]+)=/gm)].map((m) => m[1]!));
		for (const name of required) expect(defined.has(name), `${name} is in .env.example`).toBe(true);
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
				for (const e of c.env ?? []) if (/KEY|SECRET|TOKEN|PASSWORD|URL/.test(e.name) && e.value !== undefined) expect(e.name, `${d.metadata.name} ${e.name} must come from a Secret`).toMatch(/^(PIM_KEK_DIR|PIM_ROLE|PIM_HTTP_PORT|PIM_KEK_CURRENT|PIM_DRAIN_WINDOW_SECONDS)$/);
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
