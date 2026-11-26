#!/usr/bin/env node
// Qualifies a real Langfuse against Pim's own exporter: sends spans shaped like the ones pi-durable and pi-ai make for a turn (a submission, a generation phase with a model
// request, a tool phase) through the same adapter, redaction and Langfuse mapping Pim runs, then reads them back from Langfuse's real-time observations API and checks what Langfuse
// shows: the session (the chat), the user (an opaque reference), the model, usage in its cache tiers, the cost that was supplied, and a tool observation.
//
//   LANGFUSE_URL=http://127.0.0.1:3100 LANGFUSE_PUBLIC_KEY=pk-lf-... LANGFUSE_SECRET_KEY=sk-lf-... node scripts/langfuse-smoke.mjs
//
// For the stack in deploy/langfuse, `deploy/langfuse/init-env.sh` makes the project and its keys, and `docker compose up -d --wait` there starts it. Nothing here touches Pim. Exits 0 when
// Langfuse showed everything, 1 otherwise, saying which part was missing. It sends one trace, and the keys are never printed. LANGFUSE_SMOKE_WAIT_SECONDS (default 90) is how long it waits for the trace to appear.
import { randomUUID } from "node:crypto";
import { PiTelemetry } from "../packages/v2-ops/src/observability/pi-telemetry.ts";
import { createTracerProvider, otlpHttpExporter, telemetryConfigFromEnv } from "../packages/v2-ops/src/observability/tracing.ts";

const base = (process.env.LANGFUSE_URL ?? "").replace(/\/+$/, "");
const publicKey = process.env.LANGFUSE_PUBLIC_KEY;
const secretKey = process.env.LANGFUSE_SECRET_KEY;
if (!base || !publicKey || !secretKey) {
	console.error("Set LANGFUSE_URL, LANGFUSE_PUBLIC_KEY and LANGFUSE_SECRET_KEY.");
	process.exit(1);
}
const auth = `Basic ${Buffer.from(`${publicKey}:${secretKey}`).toString("base64")}`;
const failures = [];
const check = (ok, what) => (ok ? console.log(`ok    ${what}`) : (failures.push(what), console.log(`FAIL  ${what}`)));

const health = await fetch(`${base}/api/public/health`).then((r) => r.json(), () => undefined);
check(health?.status === "OK", `Langfuse answers /api/public/health${health?.version ? ` (version ${health.version})` : ""}`);

const config = telemetryConfigFromEnv({ OTEL_EXPORTER_OTLP_ENDPOINT: `${base}/api/public/otel`, OTEL_EXPORTER_OTLP_HEADERS: `Authorization=${auth}` }, "pim-smoke");
check(config.enabled && config.profile === "langfuse" && config.headers["x-langfuse-ingestion-version"] === "4", "Pim's configuration for the endpoint is the Langfuse one, with real-time ingestion");
if (!config.enabled) process.exit(1);

const chat = `smoke-chat-${randomUUID()}`;
const exportErrors = [];
const handle = createTracerProvider({
	serviceName: "pim-smoke",
	serviceVersion: "smoke",
	exporter: otlpHttpExporter(config.url, config.headers, { onError: (reason) => exportErrors.push(reason) }),
	langfuse: { release: "smoke", environment: "smoke" },
	scheduledDelayMs: 100,
});
const pi = new PiTelemetry({ tracer: handle.provider.getTracer("pim"), attributes: { "pim.owner.ref": "o_smoke", "pim.role": "runner", "pim.chat": chat, "pim.agent": "agent-smoke" } }).context;
let traceId;
await pi.startSpan({ name: "pi.durable.submit", attributes: { "submission.type": "input", "conversation.id": 1 } }, async (submit) => {
	traceId = pi.propagation.inject(submit).traceparent.split("-")[1];
	await submit.startSpan({ name: "pi.durable.phase", attributes: { "task.id": 2, "task.name": "pi.generation", phase: "request", kind: "run", resumed: false } }, async (phase) => {
		await phase.startSpan({ name: "pi.ai.request", attributes: { provider: "smoke", api: "openai-completions", model: "smoke-model", reasoning: "low" } }, (request) => {
			request.addEvent("pi.ai.first_chunk");
			request.setAttributes({ stop: "toolUse", "usage.input": 400, "usage.output": 20, "usage.cache_read": 600, "usage.cache_write": 0, "cost.total": 0.00112 });
		});
		await phase.startSpan({ name: "pi.durable.phase", attributes: { "task.id": 3, "task.name": "pi.tool", phase: "execute", kind: "run", resumed: false } }, (tool) => tool.setAttributes({ "tool.name": "smoke_tool", outcome: "done" }));
	});
});
await handle.forceFlush(15_000);
await handle.shutdown(5_000);
check(exportErrors.length === 0, `Langfuse accepted the batch${exportErrors.length ? ` (${exportErrors.join(", ")})` : ""}`);

const query = new URLSearchParams({ traceId, fields: "core,basic,model,usage,trace_context", fromStartTime: new Date(Date.now() - 3_600_000).toISOString(), limit: "50" });
let observations = [];
for (const deadline = Date.now() + Number(process.env.LANGFUSE_SMOKE_WAIT_SECONDS ?? 90) * 1000; Date.now() < deadline && observations.length < 4; await new Promise((r) => setTimeout(r, 2_000))) {
	const response = await fetch(`${base}/api/public/v2/observations?${query}`, { headers: { authorization: auth } });
	if (response.ok) observations = (await response.json()).data ?? [];
}
check(observations.length === 4, `Langfuse shows the trace's 4 observations (saw ${observations.length})`);
const generation = observations.find((o) => o.type === "GENERATION");
const tool = observations.find((o) => o.type === "TOOL");
check(generation?.model === "smoke-model", "the model request is a generation with its model");
check(generation?.sessionId === chat && generation?.userId === "o_smoke", "its session is the chat and its user the opaque owner reference");
const usage = generation?.usageDetails ?? {};
check(usage.input === 400 && usage.output === 20 && usage.cache_read_input_tokens === 600, `its usage is as sent, with the cache tier (${JSON.stringify(usage)})`);
check(Math.abs(Number(generation?.totalCost ?? 0) - 0.00112) < 1e-9, `its cost is the one Pim supplied (${generation?.totalCost})`);
check(tool?.name === "smoke_tool", "the tool phase is a tool observation named for the tool");
check(observations.every((o) => o.traceId === traceId) && observations.filter((o) => o.parentObservationId == null).length === 1, "one trace with one root: pi's nesting survived");
console.log(failures.length === 0 ? "\nLangfuse ingested Pim's spans as designed." : `\n${failures.length} check(s) failed.`);
process.exit(failures.length === 0 ? 0 : 1);
