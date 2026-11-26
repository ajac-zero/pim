// The self-hosted Langfuse recipe (deploy/langfuse), how Pim's Compose file meets it, and the smoke script that qualifies a real Langfuse, here run against a stand-in that implements only
// the calls the script makes: it proves the script and Pim's side of the protocol, not Langfuse. Langfuse itself needs a Docker host (see "Traces and Langfuse" in docs/v2-operations.md).
import { execFileSync, spawn } from "node:child_process";
import { mkdtempSync, readFileSync, statSync, cpSync, writeFileSync } from "node:fs";
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
		expect(compose.networks["pim-traces"]).toEqual({ external: true, name: "${LANGFUSE_TRACES_NETWORK:-pim-traces}" });
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

// scripts/langfuse-qualify.sh on a host that already runs Langfuse. Docker is a stand-in that keeps the host's resources in a file and records every call: the script may create and remove
// only what it names for itself, and the default project (`pim-langfuse`), its volumes and the default network (`pim-traces`) must be exactly as they were.
describe("the qualification script on a host that already runs Langfuse", () => {
	const compose = parse(read("deploy/langfuse/compose.yaml"), { merge: true }) as any;
	const images = Object.fromEntries(Object.entries<any>(compose.services).map(([name, s]) => [name, { image: s.image, healthcheck: s.healthcheck, ...(s.ports ? { ports: [{ host_ip: "127.0.0.1" }] } : {}) }]));

	function host(options: { failNetworkCreate?: boolean; smoke?: string } = {}) {
		const dir = mkdtempSync(join(tmpdir(), "pim-qualify-"));
		const bin = join(dir, "bin");
		execFileSync("mkdir", ["-p", bin]);
		const state = join(dir, "state.json");
		const log = join(dir, "log");
		const existing = { networks: ["pim-traces", "bridge"], projects: ["pim-langfuse"], volumes: ["pim-langfuse_langfuse-postgres", "pim-langfuse_langfuse-clickhouse"] };
		writeFileSync(state, JSON.stringify(existing));
		writeFileSync(join(dir, "pim.json"), JSON.stringify({ services: { runner: { environment: { OTEL_EXPORTER_OTLP_HEADERS: "Authorization=Basic YTpi==,x-langfuse-ingestion-version=4" }, networks: { internal: null, traces: null } }, gate: { networks: { internal: null } } }, networks: { traces: { name: "pim-traces" } } }));
		writeFileSync(join(dir, "lf.json"), JSON.stringify({ services: images, networks: { "pim-traces": { name: "NETWORK", external: true } } }));
		// The stand-in: records argv, and applies what it was told to the state, by the names it was given.
		writeFileSync(join(bin, "docker"), `#!/usr/bin/env node
const fs = require("fs");
const state = JSON.parse(fs.readFileSync(${JSON.stringify(state)}, "utf8"));
const argv = process.argv.slice(2);
fs.appendFileSync(${JSON.stringify(log)}, JSON.stringify({ argv, cwd: process.cwd(), network: process.env.LANGFUSE_TRACES_NETWORK, port: process.env.LANGFUSE_PORT }) + "\\n");
const save = () => fs.writeFileSync(${JSON.stringify(state)}, JSON.stringify(state));
const has = (a) => argv.includes(a);
if (argv[0] === "network") {
	if (argv[1] === "create") {
		if (${JSON.stringify(!!options.failNetworkCreate)} || state.networks.includes(argv[2])) { console.error("network exists or refused"); process.exit(1); }
		state.networks.push(argv[2]); save();
	}
	if (argv[1] === "rm") { state.networks = state.networks.filter((n) => n !== argv[2]); save(); }
	process.exit(0);
}
if (argv[0] === "compose") {
	const p = argv.includes("-p") ? argv[argv.indexOf("-p") + 1] : undefined;
	const inLangfuse = process.cwd().endsWith("langfuse");
	const verb = argv.find((a, i) => i > 0 && ["config", "pull", "up", "down", "logs"].includes(a));
	if (verb === "config") {
		if (inLangfuse && !fs.existsSync(".env")) process.exit(1);
		if (argv.includes("json")) process.stdout.write(fs.readFileSync(inLangfuse ? ${JSON.stringify(join(dir, "lf.json"))} : ${JSON.stringify(join(dir, "pim.json"))}, "utf8").replaceAll("NETWORK", process.env.LANGFUSE_TRACES_NETWORK ?? ""));
		process.exit(0);
	}
	if (verb === "up") { state.projects.push(p ?? "pim-langfuse"); save(); }
	if (verb === "down") {
		// Without -p this is the recipe's own project: the running instance.
		const name = p ?? "pim-langfuse";
		state.projects = state.projects.filter((x) => x !== name);
		if (has("-v")) state.volumes = state.volumes.filter((v) => !v.startsWith(name + "_"));
		save();
	}
	process.exit(0);
}
process.exit(0);
`, { mode: 0o755 });
		const run = () => {
			try {
				execFileSync("sh", [join(ROOT, "scripts/langfuse-qualify.sh")], { env: { ...process.env, PATH: `${bin}:${process.env.PATH}`, LANGFUSE_QUALIFY_SMOKE: options.smoke ?? "true" }, stdio: "pipe", encoding: "utf8" });
				return 0;
			} catch (error) {
				return (error as { status: number }).status;
			}
		};
		const calls = () => readFileSync(log, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l) as { argv: string[]; cwd: string; network?: string; port?: string });
		return { run, calls, state: () => JSON.parse(readFileSync(state, "utf8")), existing };
	}

	it("creates, starts and removes only a project, network and port of its own, and leaves the running instance's project, volumes and network exactly as they were", () => {
		const h = host();
		expect(h.run()).toBe(0);
		const calls = h.calls();
		const composeCalls = calls.filter((c) => c.argv[0] === "compose" && c.cwd.endsWith("langfuse"));
		const projects = new Set(composeCalls.map((c) => c.argv[c.argv.indexOf("-p") + 1]));
		// Every Compose call in the Langfuse directory names the same project, a unique one, and never the recipe's own.
		expect(composeCalls.every((c) => c.argv.includes("-p"))).toBe(true);
		expect([...projects]).toHaveLength(1);
		expect([...projects][0]).toMatch(/^pimlfq-[0-9a-f]{8}$/);
		const network = calls.find((c) => c.argv[0] === "network" && c.argv[1] === "create")!.argv[2]!;
		expect(network).toMatch(/^pim-lfq-[0-9a-f]{8}$/);
		expect(calls.filter((c) => c.argv[0] === "network").map((c) => [c.argv[1], c.argv[2]])).toEqual([["create", network], ["rm", network]]);
		expect(composeCalls.filter((c) => c.argv.includes("up")).every((c) => c.network === network && Number(c.port) > 1024 && c.port !== "3100")).toBe(true);
		expect(composeCalls.some((c) => c.argv.includes("down") && c.argv.includes("-v"))).toBe(true);
		// What was there is there, and what this run made is gone.
		expect(h.state()).toEqual(h.existing);
	});

	it("stops before starting anything, and removes nothing, when its network cannot be created", () => {
		const h = host({ failNetworkCreate: true });
		expect(h.run()).not.toBe(0);
		const calls = h.calls();
		expect(calls.filter((c) => c.argv[0] === "network").map((c) => c.argv[1])).toEqual(["create"]);
		expect(calls.some((c) => c.argv.includes("up") || c.argv.includes("down"))).toBe(false);
		expect(h.state()).toEqual(h.existing);
	});

	it("cleans up what it started when the smoke fails, and still touches nothing else", () => {
		const h = host({ smoke: "exit 1" });
		expect(h.run()).toBe(1);
		const calls = h.calls();
		expect(calls.some((c) => c.argv.includes("down") && c.argv.includes("-p"))).toBe(true);
		expect(calls.some((c) => c.argv[0] === "network" && c.argv[1] === "rm")).toBe(true);
		expect(h.state()).toEqual(h.existing);
	});
});
