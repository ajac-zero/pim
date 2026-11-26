import { trace } from "@opentelemetry/api";
import { ExportResultCode } from "@opentelemetry/core";
import type { ReadableSpan, SpanExporter } from "@opentelemetry/sdk-trace";
import pg from "pg";
import { describe, expect, it } from "vitest";
import { Registry } from "../src/observability/metrics.ts";
import { REDACTED, redactText, redactValue, redactedLogLine } from "../src/observability/redact.ts";
import { loadProcessConfig } from "@pim/v2-contracts/platform";
import { createPimMetrics, instrumentPool, monitorEventLoop, openPools } from "../src/observability/signals.ts";
import { createTracerProvider } from "../src/observability/tracing.ts";
import { usePostgres } from "./support/pg.ts";

const SECRETS = [
	"pim_own_ada_Zk3j9Qm2Lp0xVb7nTrYw4sHd",
	"pimgit_9f8e7d6c5b4a39281706f5e4d3c2b1a0",
	"pimgw_AAAAbbbbCCCCddddEEEEffff1234",
	"sgamp_0123456789abcdefghijklmn",
	"pimhostops_secretsecretsecret",
	"Bearer abcdefghijklmnopqrstuvwxyz0123456789",
	"sk-ant-api03-abcdefghijklmnop",
	"ya29.a0AfH6SMBexamplexample",
	"eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dBjftJeZ4CVPmB92K27uhbUJU1p1r_wW1gFWFOEjXk",
	"APP_CREDENTIALS_KEY=AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8=",
	"cookie_key: Zm9vYmFyZm9vYmFyZm9vYmFyZm9vYmFyZm9vYmFyZm8",
	"Cookie: session=abc123def456ghi789; theme=dark",
	"-----BEGIN PRIVATE KEY-----\nMIIEvQIBADANBgkqhkiG9w0BAQEFAASC\n-----END PRIVATE KEY-----",
];

describe("redaction", () => {
	it("removes every credential shape from free text and leaves ordinary text alone", () => {
		for (const secret of SECRETS) {
			const out = redactText(`before ${secret} after`);
			expect(out, secret).toContain(REDACTED);
			expect(out, secret).not.toMatch(/Zk3j9Qm2|9f8e7d6c|AAAAbbbb|0123456789abcdefghijklmn|secretsecret|abcdefghijklmnopqrstuvwxyz0123456789|abcdefghijklmnop\b|a0AfH6SMB|dBjftJeZ|AAECAwQF|Zm9vYmFy|abc123def456|MIIEvQ/);
		}
		expect(redactText("The session ran for 12 s and used model glm-5.3.")).toBe("The session ran for 12 s and used model glm-5.3.");
	});

	it("drops prompts, tool bodies and credential fields by name unless content capture is on, and never drops the credentials", () => {
		const attrs = { "gen_ai.prompt": "tell me a secret", "gen_ai.completion": "ok", "tool.arguments": { to: "x@y.test" }, "http.request.header.authorization": "Bearer x", "http.request.header.cookie": "a=b", "db.statement.kind": "select", "pim.token": "t", "gen_ai.usage.input_tokens": 12, "pim.api_key": "k", "http.route": "/api/chats/:id" };
		expect(redactValue(attrs)).toEqual({ "gen_ai.prompt": REDACTED, "gen_ai.completion": REDACTED, "tool.arguments": REDACTED, "http.request.header.authorization": REDACTED, "http.request.header.cookie": REDACTED, "db.statement.kind": "select", "pim.token": REDACTED, "gen_ai.usage.input_tokens": 12, "pim.api_key": REDACTED, "http.route": "/api/chats/:id" });
		const captured = redactValue({ "gen_ai.prompt": `use ${SECRETS[0]} to log in`, "pim.token": "t" }, { captureContent: true }) as Record<string, string>;
		expect(captured["gen_ai.prompt"]).toBe(`use ${REDACTED} to log in`);
		expect(captured["pim.token"]).toBe(REDACTED);
		expect(redactedLogLine({ event: "x", authorization: "Bearer abcdefghijklmnop", note: `with ${SECRETS[1]}` })).not.toMatch(/abcdefghijklmnop|9f8e7d6c/);
	});

	it("keeps secrets out of exported spans: attributes, events, status messages and names", async () => {
		const exported: ReadableSpan[] = [];
		const inner: SpanExporter = { export: (spans, done) => (exported.push(...spans), done({ code: ExportResultCode.SUCCESS })), shutdown: async () => undefined };
		const made = createTracerProvider({ serviceName: "test", exporter: inner, scheduledDelayMs: 1 });
		const tracer = made.provider.getTracer("t");
		const span = tracer.startSpan(`GET /hosted/own_ada/app/${SECRETS[1]}/x`);
		span.setAttribute("gen_ai.prompt", "my private question");
		span.setAttribute("http.url", `https://pim.example.test/cb?token=${SECRETS[2]}`);
		span.setAttribute("pim.cookie", "session=abc123def456ghi789");
		span.addEvent("tool.result", { "tool.result": "bank balance 12,345", detail: `key ${SECRETS[9]}` });
		span.setStatus({ code: 2, message: `failed with ${SECRETS[5]}` });
		span.end();
		await made.provider.forceFlush();
		await made.shutdown();
		const text = JSON.stringify(exported.map((s) => ({ name: s.name, attributes: s.attributes, events: s.events, status: s.status })));
		expect(exported).toHaveLength(1);
		for (const leak of ["private question", "AAAAbbbb", "9f8e7d6c", "abc123def456", "12,345", "AAECAwQF", "abcdefghijklmnopqrstuvwxyz0123456789"]) expect(text, leak).not.toContain(leak);
		expect(text).toContain(REDACTED);
		void trace;
	});
});

describe("metrics", () => {
	it("renders Prometheus text for every required signal and refuses labels that identify people or content", () => {
		const m = createPimMetrics();
		m.httpDuration.observe(0.12, { service: "gate", route: "/api/chats", method: "GET", status_class: "2xx" });
		m.httpDuration.observe(0.4, { service: "gate", route: "/api/chats", method: "GET", status_class: "2xx" });
		m.modelErrors.inc({ provider: "example", class: "timeout_524" });
		m.websockets.set(7, { service: "live" });
		const text = m.registry.render();
		for (const name of ["pim_http_request_duration_seconds", "pim_nodejs_event_loop_delay_seconds", "pim_pg_pool_wait_seconds", "pim_pg_query_duration_seconds", "pim_pg_commit_batch_duration_seconds", "pim_inbox_oldest_age_seconds", "pim_due_work_oldest_age_seconds", "pim_partition_ownership_transfers_total", "pim_fencing_rejects_total", "pim_projection_lag_seconds", "pim_live_cursor_replay_lag_seconds", "pim_live_websockets_active", "pim_live_slow_client_coalesced_total", "pim_live_slow_client_overflow_total", "pim_model_request_duration_seconds", "pim_model_errors_total", "pim_model_tokens_total", "pim_spend_usd_total"]) expect(text, name).toContain(`# TYPE ${name} `);
		expect(text).toContain('pim_http_request_duration_seconds_bucket{service="gate",route="/api/chats",method="GET",status_class="2xx",le="0.25"} 1');
		expect(text).toContain('pim_http_request_duration_seconds_count{service="gate",route="/api/chats",method="GET",status_class="2xx"} 2');
		expect(text).toContain('pim_model_errors_total{provider="example",class="timeout_524"} 1');
		const r = new Registry();
		for (const label of ["owner_id", "user", "prompt", "token", "conversation_id", "email"]) expect(() => r.counter(`c_${label}`, "x", [label]), label).toThrow(/may not have/);
	});

	it("scrubs credential-looking label values and bounds the number of series", () => {
		const r = new Registry();
		const c = r.counter("c_total", "x", ["route"]);
		c.inc({ route: `/hosted/${SECRETS[1]}` });
		expect(r.render()).not.toContain("9f8e7d6c");
		for (let i = 0; i < 3000; i++) c.inc({ route: `/r${i}` });
		expect(r.render().split("\n").filter((l) => l.startsWith("c_total{")).length).toBeLessThanOrEqual(2000);
	});

	it("reports event-loop delay from monitorEventLoopDelay: a blocked loop shows up in the p99 and max", async () => {
		const m = createPimMetrics();
		const stop = monitorEventLoop(m, "gate", 10);
		await new Promise((r) => setTimeout(r, 50));
		const end = Date.now() + 120;
		while (Date.now() < end); // block the loop for about 120 ms
		await new Promise((r) => setTimeout(r, 30));
		m.registry.render();
		expect(m.eventLoopDelay.get({ service: "gate", quantile: "max" })!).toBeGreaterThan(0.08);
		stop();
	});
});

describe("PostgreSQL pool instrumentation", () => {
	const db = usePostgres();
	it("measures connection wait and query time by statement kind without recording SQL text", async () => {
		const m = createPimMetrics();
		const pool = new pg.Pool({ connectionString: db.server.url(), max: 1 }).on("error", () => undefined);
		instrumentPool(pool, m, "runner");
		const slow = pool.query("SELECT pg_sleep(0.15), 'secret-looking-literal-sk-live-abcdefghijkl'");
		const waiting = pool.query("SELECT 1");
		await Promise.all([slow, waiting]);
		const text = m.registry.render();
		expect(m.pgQuery.count({ service: "runner", op: "select" })).toBe(2);
		expect(text).toMatch(/pim_pg_pool_connections\{service="runner",pool="foreground",state="total"\} \d/);
		expect(text).not.toContain("secret-looking-literal");
		await pool.end();
	});

	it("opens one bounded, instrumented pool per contracts pool name, with the statement timeout of its budget", async () => {
		const m = createPimMetrics();
		const config = loadProcessConfig({ PIM_ROLE: "runner", PIM_PUBLIC_URL: "https://pim.example.test", PIM_DATABASE_URL: db.server.url(), PIM_NATS_URL: "nats://x:4222", PIM_S3_ENDPOINT: "http://s3.example.test", PIM_S3_BUCKET: "b", PIM_POOL_RUNTIME_MAX: "3" });
		const pools = openPools(config, m, "runner");
		expect(Object.keys(pools).sort()).toEqual(["foreground", "forge", "maintenance", "runtime", "tools"]);
		expect((pools.runtime as unknown as { options: { max: number } }).options.max).toBe(3);
		expect((await pools.foreground.query("SHOW statement_timeout")).rows[0].statement_timeout).toBe("10s");
		expect((await pools.maintenance.query("SHOW statement_timeout")).rows[0].statement_timeout).toBe("10min");
		await pools.runtime.query("SELECT 1");
		expect(m.pgQuery.count({ service: "runner", op: "show" })).toBe(2);
		expect(m.registry.render()).toContain('pool="runtime"');
		await Promise.all(Object.values(pools).map((p) => p.end()));
	});
});
