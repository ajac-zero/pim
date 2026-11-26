// The self-hosted Langfuse recipe (deploy/langfuse), how Pim's Compose file meets it, and the smoke script that qualifies a real Langfuse, here run against a stand-in that implements only
// the calls the script makes: it proves the script and Pim's side of the protocol, not Langfuse. Langfuse itself needs a Docker host (see "Traces and Langfuse" in docs/v2-operations.md).
import { execFileSync, spawn } from "node:child_process";
import { mkdtempSync, readFileSync, statSync, cpSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";
import { parseOtlpHeaders } from "../src/observability/tracing.ts";

const ROOT = new URL("../../../", import.meta.url).pathname;
const read = (path: string) => readFileSync(join(ROOT, path), "utf8");

describe("the Langfuse stack", () => {
	const text = read("deploy/langfuse/compose.yaml");
	const compose = parse(text, { merge: true }) as any;
	const services = compose.services as Record<string, any>;

	it("is a project of its own with the services Langfuse needs, each healthchecked, with its own storage and pinned images", () => {
		expect(compose.name).toBe("pim-langfuse");
		expect(Object.keys(services).sort()).toEqual(["clickhouse", "langfuse-web", "langfuse-worker", "minio", "postgres", "redis"]);
		for (const [name, service] of Object.entries(services)) {
			expect(service.healthcheck, `${name} has a healthcheck`).toBeDefined();
			expect(service.image, name).toMatch(/@sha256:[0-9a-f]{64}$/);
		}
		const tag = (name: string) => services[name].image.match(/:(\d[^@]*)@/)![1];
		expect(tag("langfuse-web")).toBe(tag("langfuse-worker"));
		// Langfuse 4 needs ClickHouse 25.12 or later.
		const [major, minor] = tag("clickhouse").split(".").map(Number);
		expect(major! > 25 || (major === 25 && minor! >= 12)).toBe(true);
		// Persistent volumes for every store, and no volume or network shared with Pim's stack other than the one that carries traces.
		for (const [name, path] of [["postgres", "/var/lib/postgresql/data"], ["clickhouse", "/var/lib/clickhouse"], ["redis", "/data"], ["minio", "/data"]] as const) {
			expect(services[name].volumes.some((v: string) => v.endsWith(`:${path}`) && Object.keys(compose.volumes).includes(v.split(":")[0]!)), `${name} keeps its data in a named volume`).toBe(true);
		}
		expect(services.postgres.environment).toMatchObject({ POSTGRES_USER: "langfuse", POSTGRES_DB: "langfuse" });
		expect(JSON.stringify(compose)).not.toMatch(/pim_gate|pim_runtime|seaweed|pgbouncer|nats/i);
		expect(services.redis.command).toContain("noeviction");
	});

	it("publishes only the web UI, on the loopback address unless told otherwise, and joins Pim's trace network with that service alone", () => {
		for (const [name, service] of Object.entries(services)) if (name !== "langfuse-web") expect(service.ports, `${name} publishes nothing`).toBeUndefined();
		expect(services["langfuse-web"].ports).toEqual(["${LANGFUSE_BIND:-127.0.0.1}:${LANGFUSE_PORT:-3100}:3000"]);
		expect(Object.keys(services["langfuse-web"].networks)).toEqual(["default", "pim-traces"]);
		expect(services["langfuse-web"].networks["pim-traces"].aliases).toEqual(["langfuse-web"]);
		for (const name of ["langfuse-worker", "postgres", "clickhouse", "redis", "minio"]) expect(services[name].networks).toEqual(["default"]);
		expect(compose.networks["pim-traces"]).toEqual({ external: true, name: "pim-traces" });
		const pim = parse(read("deploy/compose/compose.yaml"), { merge: true }) as any;
		expect(pim.networks.traces).toEqual({ name: "pim-traces" });
		expect(pim.services.runner.networks).toEqual(["internal", "traces"]);
		for (const [name, service] of Object.entries<any>(pim.services)) if (name !== "runner") expect(JSON.stringify(service.networks ?? []), name).not.toContain("traces");
	});

	it("has no default for any secret, so it does not start with a guessed one, and signs no one up", () => {
		// Every credential is `${NAME:?…}`: required, never `${NAME:-default}`.
		expect(text).not.toMatch(/\$\{LANGFUSE_[A-Z_]*(PASSWORD|SECRET|SALT|KEY)[A-Z_]*:-/);
		for (const name of ["LANGFUSE_NEXTAUTH_SECRET", "LANGFUSE_SALT", "LANGFUSE_ENCRYPTION_KEY", "LANGFUSE_POSTGRES_PASSWORD", "LANGFUSE_CLICKHOUSE_PASSWORD", "LANGFUSE_REDIS_PASSWORD", "LANGFUSE_MINIO_PASSWORD", "LANGFUSE_ADMIN_PASSWORD", "LANGFUSE_PUBLIC_KEY", "LANGFUSE_SECRET_KEY"]) expect(text, name).toContain(`\${${name}:?`);
		expect(services["langfuse-web"].environment).toMatchObject({ AUTH_DISABLE_SIGNUP: "true", TELEMETRY_ENABLED: "false" });
		expect(services["langfuse-worker"].environment.TELEMETRY_ENABLED).toBe("false");
	});

	it("is not known to Pim's Compose file, which starts and runs the same without it", () => {
		const pim = read("deploy/compose/compose.yaml");
		expect(pim.replace(/^\s*#.*$/gm, "")).not.toMatch(/langfuse/i);
		const parsed = parse(pim, { merge: true }) as any;
		// The trace variables pass through to the roles, endpoint and headers alike, empty by default.
		for (const name of ["OTEL_EXPORTER_OTLP_ENDPOINT", "OTEL_EXPORTER_OTLP_TRACES_ENDPOINT", "OTEL_EXPORTER_OTLP_HEADERS", "OTEL_EXPORTER_OTLP_TRACES_HEADERS", "OTEL_EXPORTER_OTLP_PROTOCOL", "OTEL_SERVICE_NAME", "PIM_TRACES_PROFILE"]) expect(parsed.services.runner.environment[name], name).toBe(`\${${name}:-}`);
		// Nothing starts after, or waits for, a trace backend.
		for (const service of Object.values<any>(parsed.services)) expect(JSON.stringify(service.depends_on ?? {})).not.toMatch(/langfuse|trace/);
		expect(read("deploy/compose/env.example")).not.toMatch(/CAPTURE_MESSAGE_CONTENT/);
		expect(read("deploy/k8s/base/config.yaml")).not.toMatch(/CAPTURE_MESSAGE_CONTENT/);
	});
});

describe("init-env.sh", () => {
	it("writes every value the stack requires, random and private, once, with the header lines Pim needs", () => {
		const dir = mkdtempSync(join(tmpdir(), "pim-langfuse-"));
		cpSync(join(ROOT, "deploy/langfuse/init-env.sh"), join(dir, "init-env.sh"));
		const printed = execFileSync("sh", [join(dir, "init-env.sh"), "ops@example.test"], { cwd: dir, encoding: "utf8" });
		const env = Object.fromEntries(readFileSync(join(dir, ".env"), "utf8").split("\n").filter((l) => /^[A-Z_]+=/.test(l)).map((l) => [l.slice(0, l.indexOf("=")), l.slice(l.indexOf("=") + 1)]));
		expect(statSync(join(dir, ".env")).mode & 0o777).toBe(0o600);
		const required = [...read("deploy/langfuse/compose.yaml").matchAll(/\$\{(LANGFUSE_[A-Z_]+):\?/g)].map((m) => m[1]!);
		expect(new Set(required).size).toBeGreaterThan(8);
		for (const name of required) expect(env[name], `${name} is written`).toBeTruthy();
		const secrets = ["NEXTAUTH_SECRET", "SALT", "ENCRYPTION_KEY", "POSTGRES_PASSWORD", "CLICKHOUSE_PASSWORD", "REDIS_PASSWORD", "MINIO_PASSWORD", "ADMIN_PASSWORD"].map((n) => env[`LANGFUSE_${n}`]!);
		expect(new Set(secrets).size).toBe(secrets.length);
		for (const s of secrets) expect(s).toMatch(/^[0-9a-f]{24,}$/);
		expect(env.LANGFUSE_ENCRYPTION_KEY).toMatch(/^[0-9a-f]{64}$/);
		expect(env.LANGFUSE_ADMIN_EMAIL).toBe("ops@example.test");
		// What it prints for Pim's .env is the header its own parser reads back as the project's Basic credential, padding and all.
		const line = printed.split("\n").find((l) => l.startsWith("OTEL_EXPORTER_OTLP_HEADERS="))!;
		const headers = parseOtlpHeaders(line.slice("OTEL_EXPORTER_OTLP_HEADERS=".length).replace(/^"|"$/g, ""));
		expect(Buffer.from(headers.authorization!.replace("Basic ", ""), "base64").toString()).toBe(`${env.LANGFUSE_PUBLIC_KEY}:${env.LANGFUSE_SECRET_KEY}`);
		expect(headers["x-langfuse-ingestion-version"]).toBe("4");
		expect(printed).toContain("OTEL_EXPORTER_OTLP_ENDPOINT=http://langfuse-web:3000/api/public/otel");
		// A second run would orphan the data's secrets: it refuses.
		expect(() => execFileSync("sh", [join(dir, "init-env.sh")], { cwd: dir, stdio: "pipe" })).toThrow();
	});
});

/** A stand-in for the few calls the smoke script makes of Langfuse, with the project's own key check and the mapping Langfuse documents for the attributes Pim sends. */
function standIn(keys: { pk: string; sk: string }, options: { ingest: boolean }) {
	const spans: any[] = [];
	const seen: { path: string; auth: string | undefined; version: string | undefined }[] = [];
	const server = createServer((req, res) => {
		const chunks: Buffer[] = [];
		req.on("data", (c) => chunks.push(c));
		req.on("end", () => {
			const url = new URL(req.url ?? "/", "http://x");
			const authorized = req.headers.authorization === `Basic ${Buffer.from(`${keys.pk}:${keys.sk}`).toString("base64")}`;
			seen.push({ path: url.pathname, auth: req.headers.authorization, version: req.headers["x-langfuse-ingestion-version"] as string | undefined });
			const json = (status: number, body: unknown) => res.writeHead(status, { "content-type": "application/json" }).end(JSON.stringify(body));
			if (url.pathname === "/api/public/health") return json(200, { status: "OK", version: "stand-in" });
			if (!authorized) return json(401, { message: "Invalid credentials" });
			if (url.pathname === "/api/public/otel/v1/traces" && req.method === "POST") {
				if (options.ingest) for (const rs of JSON.parse(Buffer.concat(chunks).toString()).resourceSpans) for (const ss of rs.scopeSpans) spans.push(...ss.spans);
				return json(200, {});
			}
			if (url.pathname === "/api/public/v2/observations") {
				const attr = (s: any, key: string) => s.attributes.find((a: any) => a.key === key)?.value?.stringValue;
				return json(200, { data: spans.filter((s) => s.traceId === url.searchParams.get("traceId")).map((s) => ({ id: s.spanId, traceId: s.traceId, parentObservationId: s.parentSpanId ?? null, name: s.name, type: (attr(s, "langfuse.observation.type") ?? "span").toUpperCase(), model: attr(s, "langfuse.observation.model.name"), sessionId: attr(s, "langfuse.session.id"), userId: attr(s, "langfuse.user.id"), usageDetails: attr(s, "langfuse.observation.usage_details") && JSON.parse(attr(s, "langfuse.observation.usage_details")), totalCost: attr(s, "langfuse.observation.cost_details") && JSON.parse(attr(s, "langfuse.observation.cost_details")).total })), meta: {} });
			}
			return json(404, {});
		});
	});
	return { server, seen, listen: () => new Promise<string>((resolve) => server.listen(0, "127.0.0.1", () => resolve(`http://127.0.0.1:${(server.address() as { port: number }).port}`))) };
}

const smoke = (env: Record<string, string>) =>
	new Promise<{ code: number | null; out: string }>((resolve) => {
		const child = spawn(process.execPath, [join(ROOT, "scripts/langfuse-smoke.mjs")], { env: { ...process.env, ...env }, cwd: ROOT });
		let out = "";
		child.stdout.on("data", (c) => (out += c));
		child.stderr.on("data", (c) => (out += c));
		child.on("close", (code) => resolve({ code, out }));
	});

describe("the Langfuse smoke script", () => {
	const keys = { pk: "pk-lf-stand-in", sk: "sk-lf-stand-in-secret" };
	it("passes against a Langfuse that ingests what Pim sends the way Langfuse documents, and never prints a key", async () => {
		const langfuse = standIn(keys, { ingest: true });
		const url = await langfuse.listen();
		const result = await smoke({ LANGFUSE_URL: url, LANGFUSE_PUBLIC_KEY: keys.pk, LANGFUSE_SECRET_KEY: keys.sk, LANGFUSE_SMOKE_WAIT_SECONDS: "20" });
		langfuse.server.close();
		expect(result.out).toContain("Langfuse ingested Pim's spans as designed.");
		expect(result.code).toBe(0);
		expect(result.out).not.toMatch(/stand-in-secret|Basic /);
		const ingest = langfuse.seen.find((s) => s.path === "/api/public/otel/v1/traces")!;
		expect(ingest.version).toBe("4");
		expect(ingest.auth).toBe(`Basic ${Buffer.from(`${keys.pk}:${keys.sk}`).toString("base64")}`);
	}, 60_000);

	it("fails, saying what is missing, when Langfuse does not show the trace or refuses the keys", async () => {
		const silent = standIn(keys, { ingest: false });
		const failed = await smoke({ LANGFUSE_URL: await silent.listen(), LANGFUSE_PUBLIC_KEY: keys.pk, LANGFUSE_SECRET_KEY: keys.sk, LANGFUSE_SMOKE_WAIT_SECONDS: "3" });
		silent.server.close();
		expect(failed.code).toBe(1);
		expect(failed.out).toMatch(/FAIL\s+Langfuse shows the trace's 4 observations \(saw 0\)/);
		const wrong = standIn(keys, { ingest: true });
		const refused = await smoke({ LANGFUSE_URL: await wrong.listen(), LANGFUSE_PUBLIC_KEY: "pk-lf-other", LANGFUSE_SECRET_KEY: "sk-lf-other", LANGFUSE_SMOKE_WAIT_SECONDS: "2" });
		wrong.server.close();
		expect(refused.code).toBe(1);
		expect(refused.out).toMatch(/FAIL\s+Langfuse accepted the batch \(HTTP 401\)/);
	}, 60_000);
});
