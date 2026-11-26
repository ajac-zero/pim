// The adapter that records pi's spans on OpenTelemetry, the export pipeline around it, and what a collector (Langfuse in particular) receives: checked with pi's own
// adapter conformance suite, and with spans shaped as pi-durable and pi-ai make them.
import { type Span, trace } from "@opentelemetry/api";
import { InMemorySpanExporter, type ReadableSpan, SimpleSpanProcessor, type SpanExporter, TracerProvider } from "@opentelemetry/sdk-trace";
import { ExportResultCode } from "@opentelemetry/core";
import type { RecordedTelemetrySpan, TelemetryCarrier } from "@earendil-works/pi-telemetry";
import { createTelemetryAdapterConformance, type TelemetryAdapterFixture } from "@earendil-works/pi-telemetry/testing";
import { createServer } from "node:http";
import { describe, expect, it } from "vitest";
import { PiTelemetry } from "../src/observability/pi-telemetry.ts";
import { REDACTED } from "../src/observability/redact.ts";
import { createTracerProvider, otlpHttpExporter, parseOtlpHeaders, telemetryConfigFromEnv } from "../src/observability/tracing.ts";

// pi's conformance suite, with the adapter on a plain in-memory exporter: what the suite sees is what the adapter recorded.
function fixture(): TelemetryAdapterFixture {
	const memory = new InMemorySpanExporter();
	const provider = new TracerProvider({ spanProcessors: [new SimpleSpanProcessor({ exporter: memory })] });
	const real = provider.getTracer("test");
	const started: Span[] = [];
	const tracer = new Proxy(real, { get: (target, property) => (property === "startSpan" ? (...args: Parameters<typeof real.startSpan>) => (started.push(real.startSpan(...args)), started.at(-1)!) : Reflect.get(target, property)) });
	const adapter = new PiTelemetry({ tracer });
	const carrierOf = (span: Pick<ReadableSpan, "spanContext" | "attributes">): TelemetryCarrier => {
		const { traceId, spanId, traceFlags } = span.spanContext();
		const conversation = span.attributes["pim.conversation"];
		return { traceparent: `00-${traceId}-${spanId}-0${traceFlags}`, ...(conversation === undefined ? {} : { "pim.conversation": String(conversation) }) };
	};
	return {
		context: adapter.context,
		propagation: adapter,
		async getSpans() {
			const finished = memory.getFinishedSpans();
			const idOf = (spanId: string) => started.findIndex((s) => s.spanContext().spanId === spanId) + 1;
			const carriers = new Map(finished.map((s) => [s.spanContext().spanId, carrierOf(s)]));
			return started.map((live, index): RecordedTelemetrySpan => {
				const span = finished.find((s) => s.spanContext().spanId === live.spanContext().spanId);
				const parent = span?.parentSpanContext;
				const local = parent && idOf(parent.spanId) > 0 ? idOf(parent.spanId) : null;
				const attributes = Object.fromEntries(Object.entries(span?.attributes ?? {}).filter(([key]) => key !== "pim.conversation")) as never;
				return {
					id: index + 1,
					parentId: local,
					context: carriers.get(live.spanContext().spanId) ?? { traceparent: `00-${live.spanContext().traceId}-${live.spanContext().spanId}-01` },
					parentContext: parent === undefined ? null : (carriers.get(parent.spanId) ?? { traceparent: `00-${parent.traceId}-${parent.spanId}-01` }),
					links: (span?.links ?? []).map((l) => ({ context: { traceparent: `00-${l.context.traceId}-${l.context.spanId}-01` }, attributes: { ...(l.attributes ?? {}) } })) as never,
					name: span?.name ?? "",
					attributes,
					events: (span?.events ?? []).map((e) => ({ name: e.name, attributes: { ...(e.attributes ?? {}) } })) as never,
					status: span?.status.code === 2 ? { status: "error", ...(span.status.message ? { error: { name: span.status.message.split(": ")[0]!, message: span.status.message.split(": ").slice(1).join(": ") } } : {}) } : { status: "ok" },
					settled: span !== undefined,
					...(span ? { endSequence: finished.indexOf(span) + 1 } : {}),
				};
			});
		},
		async [Symbol.asyncDispose]() {
			await provider.forceFlush();
		},
	};
}

describe("the pi telemetry adapter", () => {
	const cases = createTelemetryAdapterConformance(async () => fixture());
	for (const group of new Set(cases.map((c) => c.group))) {
		describe(group, () => {
			for (const testCase of cases.filter((c) => c.group === group)) it(testCase.name, () => testCase.run());
		});
	}

	it("leaves the global tracer provider alone", async () => {
		const before = trace.getTracerProvider();
		const handle = createTracerProvider({ serviceName: "test", exporter: new InMemorySpanExporter() });
		await new PiTelemetry({ tracer: handle.provider.getTracer("t") }).context.startSpan({ name: "x" }, () => undefined);
		expect(trace.getTracerProvider()).toBe(before);
		expect(trace.getTracer("other").startSpan("y").isRecording()).toBe(false);
		await handle.shutdown();
	});
});

/** What a collector got: every span of every batch, as the exporter sent it. */
function sink() {
	const spans: ReadableSpan[] = [];
	const exporter: SpanExporter = { export: (batch, done) => (spans.push(...batch), done({ code: ExportResultCode.SUCCESS })), shutdown: async () => undefined };
	return { spans, exporter };
}
const adapterOn = (handle: ReturnType<typeof createTracerProvider>, attributes = {}) => new PiTelemetry({ tracer: handle.provider.getTracer("pim"), attributes });

describe("what Langfuse receives", () => {
	const generation = async (attributes: Record<string, string | number>, status?: { status: "error"; error: { name: string; message: string } }) => {
		const { spans, exporter } = sink();
		const handle = createTracerProvider({ serviceName: "pim", exporter, langfuse: { release: "9.9" }, scheduledDelayMs: 1 });
		await adapterOn(handle, { "pim.owner.ref": "o_abc", "pim.chat": "chat-1" }).context.startSpan({ name: "pi.ai.request", attributes: { provider: "anthropic", api: "anthropic-messages", model: "claude-x", reasoning: "low" } }, (span) => {
			span.setAttributes(attributes);
			if (status) span.setStatus(status);
		});
		await handle.shutdown();
		return spans[0]!.attributes;
	};

	it("shows a request as a generation with the model, usage in tiers and the supplied cost, once", async () => {
		const attributes = await generation({ stop: "stop", "usage.input": 100, "usage.output": 20, "usage.cache_read": 5000, "usage.cache_write": 300, "cost.total": 0.0123 });
		expect(attributes).toMatchObject({ "langfuse.observation.type": "generation", "langfuse.observation.model.name": "claude-x", "langfuse.observation.metadata.provider": "anthropic", "langfuse.session.id": "chat-1", "langfuse.user.id": "o_abc", "langfuse.release": "9.9" });
		expect(JSON.parse(String(attributes["langfuse.observation.usage_details"]))).toEqual({ input: 100, output: 20, cache_read_input_tokens: 5000, cache_creation_input_tokens: 300 });
		expect(JSON.parse(String(attributes["langfuse.observation.cost_details"]))).toEqual({ total: 0.0123 });
		// Not also sent the other ways Langfuse reads usage and cost.
		for (const key of Object.keys(attributes)) expect(key, key).not.toMatch(/^(gen_ai\.usage|llm\.token_count|usage\.|cost\.)/);
	});

	it("does not send a price that is not known as a measured zero, or usage a failed request never had", async () => {
		const unpriced = await generation({ stop: "stop", "usage.input": 10, "usage.output": 2, "usage.cache_read": 0, "usage.cache_write": 0, "cost.total": 0 });
		expect(unpriced["langfuse.observation.cost_details"]).toBeUndefined();
		expect(JSON.parse(String(unpriced["langfuse.observation.usage_details"]))).toEqual({ input: 10, output: 2 });
		const failed = await generation({ stop: "error", "usage.input": 0, "usage.output": 0, "usage.cache_read": 0, "usage.cache_write": 0, "cost.total": 0 }, { status: "error", error: { name: "provider_error", message: "503 service unavailable, repeat: my private question" } });
		expect(failed["langfuse.observation.usage_details"]).toBeUndefined();
		expect(failed["langfuse.observation.model.name"]).toBe("claude-x");
	});

	it("never exports an error's message unless content capture is on, and never a credential either way", async () => {
		for (const captureContent of [false, true]) {
			const { spans, exporter } = sink();
			const handle = createTracerProvider({ serviceName: "pim", exporter, scheduledDelayMs: 1, captureContent });
			await adapterOn(handle).context.startSpan({ name: "pi.ai.request" }, (span) => span.setStatus({ status: "error", error: { name: "provider_error", message: "bad request: my private question, key sk-ant-api03-abcdefghijklmnop" } }));
			await handle.shutdown();
			const status = spans[0]!.status;
			expect(status.message, String(captureContent)).toMatch(captureContent ? /^provider_error: bad request: my private question, key \[redacted\]$/ : /^provider_error$/);
		}
	});

	it("shows a tool's phase as a tool named for it, and keeps pi's own submission result word", async () => {
		const { spans, exporter } = sink();
		const handle = createTracerProvider({ serviceName: "pim", exporter, langfuse: {}, scheduledDelayMs: 1 });
		const pi = adapterOn(handle).context;
		await pi.startSpan({ name: "pi.durable.phase", attributes: { "task.id": 1 } }, (span) => span.setAttributes({ "tool.name": "http_request", outcome: "done" }));
		await pi.startSpan({ name: "pi.durable.submit", attributes: { "conversation.id": 3 } }, (span) => span.setAttributes({ result: "queued" }));
		await handle.shutdown();
		expect(spans.map((s) => [s.name, s.attributes["langfuse.observation.type"] ?? null])).toEqual([["http_request", "tool"], ["pi.durable.submit", null]]);
		expect(spans[1]!.attributes.result).toBe("queued");
	});

	it("cleans every field of a span before it leaves, with content capture on or off: attributes, nested values, events, links, name, resource and the extra attributes", async () => {
		const secrets = ["pim_own_ada_Zk3j9Qm2Lp0xVb7nTrYw4sHd", "sk-ant-api03-abcdefghijklmnop", "Bearer abcdefghijklmnopqrstuvwxyz0123456789", "Basic dXNlcjpwYXNzd29yZDEyMw==", "pimgit_9f8e7d6c5b4a39281706f5e4d3c2b1a0"];
		for (const captureContent of [false, true]) {
			const { spans, exporter } = sink();
			const handle = createTracerProvider({
				serviceName: `svc ${secrets[0]}`,
				resource: { "deployment.note": `key ${secrets[1]}` },
				exporter,
				captureContent,
				langfuse: {},
				scheduledDelayMs: 1,
				enrich: async (batch) => new Map(batch.map((s) => [s, { "pim.chat": `chat ${secrets[2]}`, "pim.agent": "agent-1" }])),
			});
			const pi = adapterOn(handle, { "pim.owner.ref": "o_x" }).context;
			const link = await pi.startSpan({ name: "linked" }, (span) => span);
			await pi.startSpan({ name: `pi.ai.request ${secrets[4]}`, links: [{ context: link, attributes: { note: secrets[0], authorization: secrets[3] } }] }, (span) => {
				span.setAttributes({ "x.list": [secrets[1]!, "fine"], "http.cookie": "a=b", "gen_ai.prompt": "my private question", note: `see ${secrets[3]}` });
				span.addEvent(`tool ${secrets[1]}`, { token: "t", detail: `with ${secrets[0]}` });
			});
			await handle.shutdown();
			const text = JSON.stringify(spans.map((s) => ({ name: s.name, attributes: s.attributes, events: s.events, links: s.links, status: s.status, resource: s.resource.attributes, scope: s.instrumentationScope })));
			for (const leak of ["Zk3j9Qm2", "abcdefghijklmnop", "abcdefghijklmnopqrstuvwxyz0123456789", "dXNlcjpwYXNzd29yZDEyMw", "9f8e7d6c"]) expect(text, `${leak} (content capture ${captureContent})`).not.toContain(leak);
			expect(text).toContain(REDACTED);
			expect(text.includes("my private question")).toBe(captureContent);
		}
	});
});

describe("what is left of an error and of a scope", () => {
	it("keeps only pi's own error classes, never free text however short, and cleans every field of the scope", async () => {
		const { spans, exporter } = sink();
		const handle = createTracerProvider({ serviceName: "pim", exporter, scheduledDelayMs: 1 });
		const pi = adapterOn(handle).context;
		const fail = (name: string, message: string) => pi.startSpan({ name: `s-${name}` }, (span) => span.setStatus({ status: "error", error: { name, message } }));
		await fail("provider_error", "503 my private question");
		await fail("task_faulted", "boom");
		await fail("hunter2", "x");
		await fail("Secret", "y");
		await pi.startSpan({ name: "thrown" }, () => Promise.reject(Object.assign(new Error("one"), { name: "PrivateWord" }))).catch(() => undefined);
		await handle.shutdown();
		expect(spans.map((s) => [s.name, s.status.code, s.status.message ?? null])).toEqual([["s-provider_error", 2, "provider_error"], ["s-task_faulted", 2, "task_faulted"], ["s-hunter2", 2, null], ["s-Secret", 2, null], ["thrown", 2, null]]);

		const secret = "sk-ant-api03-abcdefghijklmnop";
		const scoped = sink();
		const other = createTracerProvider({ serviceName: "pim", exporter: scoped.exporter, scheduledDelayMs: 1 });
		other.provider.getTracer(`lib ${secret}`, `1.0 ${secret}`, { schemaUrl: `https://schemas.example/${secret}` }).startSpan("x").end();
		await other.shutdown();
		expect(JSON.stringify(scoped.spans[0]!.instrumentationScope)).not.toContain("abcdefghijklmnop");
		expect(scoped.spans[0]!.instrumentationScope).toMatchObject({ name: `lib ${REDACTED}`, version: `1.0 ${REDACTED}`, schemaUrl: `https://schemas.example/${REDACTED}` });
	});

	it("sends a batch without its enrichment when the lookup runs past the deadline, and nothing after shutdown", async () => {
		const { spans, exporter } = sink();
		let release!: (m: Map<ReadableSpan, Record<string, string>>) => void;
		const handle = createTracerProvider({ serviceName: "pim", exporter, scheduledDelayMs: 1, enrichTimeoutMs: 50, enrich: () => new Promise((resolve) => (release = resolve as never)) });
		await adapterOn(handle).context.startSpan({ name: "one" }, () => undefined);
		await new Promise((r) => setTimeout(r, 300));
		expect(spans.map((s) => [s.name, s.attributes["pim.chat"] ?? null])).toEqual([["one", null]]);
		// A second batch waits for its own deadline, then the hung lookup is released after shutdown: it sends nothing.
		await adapterOn(handle).context.startSpan({ name: "two" }, () => undefined);
		await handle.shutdown(2000);
		release(new Map(spans.map((s) => [s, { "pim.chat": "late" }])));
		await new Promise((r) => setTimeout(r, 100));
		expect(spans.map((s) => s.name)).toEqual(["one", "two"]);
	});
});

describe("the exporter and its guard", () => {
	it("reads headers at the first '=' only, so a Basic credential keeps its padding", () => {
		expect(parseOtlpHeaders("Authorization=Basic cHVibGljOnNlY3JldA==, X-Langfuse-Ingestion-Version=4,x-pct=a%20b%3D==")).toEqual({ authorization: "Basic cHVibGljOnNlY3JldA==", "x-langfuse-ingestion-version": "4", "x-pct": "a b===" });
		expect(parseOtlpHeaders("=novalue,noequals,bad name=1,ok=line\nbreak,  ,good=1,pct=100%")).toEqual({ good: "1", pct: "100%" });
		expect(parseOtlpHeaders(undefined)).toEqual({});
	});

	it("is off, with no exporter and no request, unless an http(s) endpoint it can use is set, and says why without echoing the endpoint", () => {
		for (const env of [{}, { OTEL_EXPORTER_OTLP_ENDPOINT: "" }, { OTEL_EXPORTER_OTLP_ENDPOINT: "  " }]) expect(telemetryConfigFromEnv(env, "pim")).toEqual({ enabled: false, warnings: [] });
		for (const [env, why] of [
			[{ OTEL_EXPORTER_OTLP_ENDPOINT: "not a url" }, /not a URL/],
			[{ OTEL_EXPORTER_OTLP_ENDPOINT: "ftp://collector.example/x" }, /http or https/],
			[{ OTEL_EXPORTER_OTLP_ENDPOINT: "https://user:pass-word@collector.example" }, /without a username/],
			[{ OTEL_EXPORTER_OTLP_ENDPOINT: "https://collector.example", OTEL_EXPORTER_OTLP_PROTOCOL: "grpc" }, /gRPC/],
		] as const) {
			const config = telemetryConfigFromEnv(env, "pim");
			expect(config.enabled).toBe(false);
			expect(config.warnings.join(" ")).toMatch(why);
			expect(config.warnings.join(" ")).not.toMatch(/pass-word|collector\.example/);
		}
	});

	it("resolves the traces endpoint and headers, and sets up Langfuse's real-time ingestion for a Langfuse endpoint", () => {
		expect(telemetryConfigFromEnv({ OTEL_EXPORTER_OTLP_ENDPOINT: "https://collector.example:4318/" }, "pim")).toMatchObject({ enabled: true, url: "https://collector.example:4318/v1/traces", profile: "generic", serviceName: "pim", headers: {} });
		expect(telemetryConfigFromEnv({ OTEL_EXPORTER_OTLP_ENDPOINT: "https://a.example", OTEL_EXPORTER_OTLP_TRACES_ENDPOINT: "https://b.example/custom", OTEL_SERVICE_NAME: "mine" }, "pim")).toMatchObject({ url: "https://b.example/custom", serviceName: "mine" });
		const langfuse = telemetryConfigFromEnv({ OTEL_EXPORTER_OTLP_ENDPOINT: "http://langfuse-web:3000/api/public/otel", OTEL_EXPORTER_OTLP_HEADERS: "Authorization=Basic YTpi==", OTEL_EXPORTER_OTLP_TRACES_HEADERS: "Authorization=Basic Yzpk==" }, "pim");
		expect(langfuse).toMatchObject({ enabled: true, url: "http://langfuse-web:3000/api/public/otel/v1/traces", profile: "langfuse", headers: { authorization: "Basic Yzpk==", "x-langfuse-ingestion-version": "4" } });
		expect(telemetryConfigFromEnv({ OTEL_EXPORTER_OTLP_TRACES_ENDPOINT: "http://x/api/public/otel/v1/traces", OTEL_EXPORTER_OTLP_HEADERS: "x-langfuse-ingestion-version=3" }, "pim")).toMatchObject({ headers: { "x-langfuse-ingestion-version": "3" } });
		expect(telemetryConfigFromEnv({ OTEL_EXPORTER_OTLP_TRACES_ENDPOINT: "http://x/api/public/otel/v1/traces", PIM_TRACES_PROFILE: "generic" }, "pim")).toMatchObject({ profile: "generic", headers: {} });
	});

	const burst = async (handle: ReturnType<typeof createTracerProvider>, n: number) => {
		const pi = adapterOn(handle).context;
		const started = performance.now();
		for (let i = 0; i < n; i++) void pi.startSpan({ name: "pi.durable.phase", attributes: { "task.id": i } }, () => undefined);
		return performance.now() - started;
	};

	it("holds a bounded queue while the collector hangs, and shuts down within its bound with the request cut off", async () => {
		let opened = 0;
		let closedByUs = 0;
		const server = createServer((req) => {
			opened++;
			req.on("close", () => closedByUs++);
			// never answers
		});
		await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
		const { port } = server.address() as { port: number };
		const errors: string[] = [];
		const handle = createTracerProvider({ serviceName: "pim", exporter: otlpHttpExporter(`http://127.0.0.1:${port}/v1/traces`, {}, { timeoutMs: 60_000, onError: (reason) => errors.push(reason) }), maxQueueSize: 50, maxExportBatchSize: 10, scheduledDelayMs: 5 });
		// Thousands of spans, one request open and none answered: the hot path is not held, and the queue never grows past its bound.
		const took = await burst(handle, 5000);
		expect(took).toBeLessThan(2000);
		await new Promise((r) => setTimeout(r, 100));
		expect(opened).toBe(1);
		const started = Date.now();
		await handle.shutdown(300);
		expect(Date.now() - started).toBeLessThan(2500);
		await new Promise((r) => setTimeout(r, 100));
		expect(closedByUs).toBeGreaterThanOrEqual(1);
		server.close();
		server.closeAllConnections();
	});

	it("gives a failing or unreachable collector no way into the work: errors are reported without the endpoint, and nothing throws", async () => {
		const errors: string[] = [];
		const server = createServer((_req, res) => res.writeHead(503).end("secret-body"));
		await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
		const { port } = server.address() as { port: number };
		for (const url of [`http://127.0.0.1:${port}/api/public/otel/v1/traces`, "http://127.0.0.1:1/api/public/otel/v1/traces"]) {
			const handle = createTracerProvider({ serviceName: "pim", exporter: otlpHttpExporter(url, { authorization: "Basic c2VjcmV0" }, { onError: (reason) => errors.push(reason) }), scheduledDelayMs: 1 });
			await burst(handle, 3);
			await handle.forceFlush();
			await handle.shutdown();
		}
		expect(errors).toContain("HTTP 503");
		expect(errors).toContain("request failed");
		expect(errors.join(" ")).not.toMatch(/127\.0\.0\.1|secret/);
		server.close();
	});
});
