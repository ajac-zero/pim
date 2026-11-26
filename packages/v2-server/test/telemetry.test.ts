// Pi's own telemetry, through Pim's adapter and exporter, on a real Runner and Harness with a scripted model: what a collector receives over OTLP/HTTP, as Langfuse would.
import { createServer, type IncomingMessage, type Server } from "node:http";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createModels } from "@earendil-works/pi-ai";
import { PartitionDirectory } from "@pim/v2-runtime/directory";
import { command } from "../../v2-runtime/test/support/commands.ts";
import { createRig, fauxAssistantMessage, fauxToolCall, readTranscript, waitFor } from "../../v2-runtime/test/support/rig.ts";
import { uniqueOwner } from "../../v2-runtime/test/support/partition.ts";
import { createFailover } from "../src/provider-failover.ts";
import { compatibleProvider } from "../src/agent-host.ts";
import { createHmac } from "node:crypto";
import { createTelemetry, ownerRef } from "../src/telemetry.ts";
import { createStack, type Stack } from "./support/stack.ts";

type Span = { name: string; traceId: string; spanId: string; parentSpanId?: string; start: number; end: number; attrs: Record<string, unknown>; status?: { code?: number; message?: string }; links: { traceId: string; spanId: string }[]; events: { name: string; attrs: Record<string, unknown> }[] };
type Request = { path: string; headers: IncomingMessage["headers"]; body: string };

const value = (v: any): unknown => (v.stringValue ?? v.intValue !== undefined ? (v.intValue !== undefined ? Number(v.intValue) : v.stringValue) : (v.doubleValue ?? v.boolValue ?? v.arrayValue?.values?.map(value)));
const attrsOf = (list: { key: string; value: unknown }[] = []) => Object.fromEntries(list.map((a) => [a.key, value(a.value)]));

/** A collector: records each request as received and answers the way a healthy one does, or as the test makes it fail. */
function collector() {
	const requests: Request[] = [];
	const behavior = { mode: "ok" as "ok" | "fail" | "hang" };
	const server: Server = createServer((req, res) => {
		const chunks: Buffer[] = [];
		req.on("data", (c) => chunks.push(c));
		req.on("end", () => {
			requests.push({ path: req.url ?? "", headers: req.headers, body: Buffer.concat(chunks).toString() });
			if (behavior.mode === "hang") return;
			res.writeHead(behavior.mode === "fail" ? 503 : 200, { "content-type": "application/json" }).end("{}");
		});
	});
	const spans = (): Span[] =>
		requests
			.filter((r) => r.body.startsWith("{"))
			.flatMap((r) => (JSON.parse(r.body).resourceSpans ?? []).flatMap((rs: any) => rs.scopeSpans.flatMap((ss: any) => ss.spans.map((s: any) => ({ name: s.name, traceId: s.traceId, spanId: s.spanId, parentSpanId: s.parentSpanId || undefined, start: Number(BigInt(s.startTimeUnixNano) / 1_000_000n), end: Number(BigInt(s.endTimeUnixNano) / 1_000_000n), attrs: attrsOf(s.attributes), status: s.status, links: s.links ?? [], events: (s.events ?? []).map((e: any) => ({ name: e.name, attrs: attrsOf(e.attributes) })) })))));
	return {
		requests,
		behavior,
		spans,
		listen: () => new Promise<number>((resolve) => server.listen(0, "127.0.0.1", () => resolve((server.address() as { port: number }).port))),
		close: () => server.close(),
	};
}

let stack: Stack;
const receiver = collector();
let port: number;
beforeAll(async () => {
	stack = await createStack();
	port = await receiver.listen();
}, 120_000);
afterAll(async () => {
	receiver.close();
	await stack?.drop();
});

const BASIC = "Basic cHVibGljOnNlY3JldA==";
const env = () => ({ OTEL_EXPORTER_OTLP_ENDPOINT: `http://127.0.0.1:${port}/api/public/otel`, OTEL_EXPORTER_OTLP_HEADERS: `Authorization=${BASIC},x-extra=1`, PIM_INGRESS_SECRET: "ingress", PIM_VERSION: "1.2.3" });
/** The chat and agent a conversation of an owner is: ids that say nothing of the owner, as Pim's public ids do. */
const labels = new Map<string, number>();
const label = (ownerId: string) => labels.get(ownerId) ?? (labels.set(ownerId, labels.size + 1), labels.size);
const chats = (ownerId: string) => async () => ({ chat: `chat-${label(ownerId)}`, agent: `agent-${label(ownerId)}` });
const doneText = (ownerId: string, partitionId: string, text: string) => async () => (await readTranscript(stack.runtime, ownerId, partitionId, 1)).some((e) => JSON.stringify(e.model ?? "").includes(text));
const toolTask = async (ownerId: string) => Number((await stack.runtime.read<{ id: string }>(ownerId, "SELECT id FROM pim_runtime.tasks WHERE owner_id = $1 AND kind = 'w:pi.tool' ORDER BY id DESC LIMIT 1", [ownerId])).rows[0]!.id);
const approve = (runner: { inbox: { recordSignal: (...a: any[]) => Promise<unknown> } }, ownerId: string, partitionId: string, taskId: number) => runner.inbox.recordSignal(ownerId, partitionId, { key: `approval:${taskId}`, kind: "approval", taskId, payload: { decision: "approve" } });
const owned = (ownerId: string) => receiver.spans().filter((s) => s.attrs["pim.owner.ref"] === ownerRef(env(), ownerId));
const pause = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** A home partition with a real Runner whose Harness reports to Pim's telemetry. */
async function open(ownerId: string, options: { failover?: ReturnType<typeof createFailover>; tel?: ReturnType<typeof createTelemetry> } = {}) {
	const rig = createRig(stack.runtime, ownerId);
	const tel = options.tel ?? createTelemetry(env(), { role: "runner", immediate: true, conversation: chats(ownerId) })!;
	const partitionId = await new PartitionDirectory(stack.runtime).createPartition(ownerId, { kind: "home" });
	const runner = (steward?: { holderId: string; leaseTtlMs: number }) => rig.runner({ ...(steward ? { steward } : {}), harnessOptions: (p) => ({ ...rig.harnessOptions(), ...(options.failover ? { models: options.failover.wrap(rig.models, ownerId) } : {}), telemetry: tel.partition(ownerId, p.partitionId) }) });
	return { rig, tel, partitionId, runner };
}
const flushed = async (tel: { flush(): Promise<void> }) => (await tel.flush(), await pause(200));

describe("pi's spans, through Pim's adapter and exporter, on a real Runner", () => {
	it("sends a turn parked for an approval as the spans pi made, joined by the trace and never spanning the wait", async () => {
		receiver.requests.length = 0;
		const ownerId = uniqueOwner();
		const { rig, tel, partitionId, runner: make } = await open(ownerId);
		rig.faux.setResponses([fauxAssistantMessage(fauxToolCall("gate", { secret: "the-prompt-secret" }), { stopReason: "toolUse" }), fauxAssistantMessage("all done")]);
		const runner = make();
		await runner.start();
		await command(runner.inbox, ownerId, partitionId, "r1", 1, { content: "hello private words" });
		await waitFor("the call to park", () => rig.state.gateRuns[0]);
		await pause(1200);
		await approve(runner, ownerId, partitionId, await toolTask(ownerId));
		await waitFor("the turn to finish", doneText(ownerId, partitionId, "all done"));
		await runner.stop();
		await flushed(tel);

		// Where a Langfuse collector would have received it: its path, its Basic credential with the padding it was configured with, and real-time ingestion.
		expect(receiver.requests[0]!.path).toBe("/api/public/otel/v1/traces");
		expect(receiver.requests[0]!.headers).toMatchObject({ authorization: BASIC, "x-extra": "1", "x-langfuse-ingestion-version": "4", "content-type": "application/json" });

		const spans = owned(ownerId);
		const byId = new Map(spans.map((s) => [s.spanId, s]));
		expect(new Set(spans.map((s) => s.name))).toEqual(new Set(["pi.durable.submit", "pi.durable.phase", "pi.ai.request", "gate"]));
		// One run, one trace: every span but the submission's is a child of a span that was exported, and nothing here was made by Pim.
		expect(new Set(spans.map((s) => s.traceId)).size).toBe(1);
		const roots = spans.filter((s) => s.parentSpanId === undefined);
		expect(roots.map((s) => s.name)).toEqual(["pi.durable.submit"]);
		for (const s of spans) if (s.parentSpanId) expect(byId.get(s.parentSpanId), `${s.name}'s parent`).toBeDefined();
		const requests = spans.filter((s) => s.name === "pi.ai.request");
		expect(requests).toHaveLength(2);
		for (const r of requests) expect(byId.get(r.parentSpanId!)!.attrs).toMatchObject({ "task.name": "pi.generation", phase: "request" });

		// The approval: the tool's phases are the call that parked and the one that ran after the decision, both under the generation's request phase. Pi's phase excludes the wait,
		// so no span is as long as it, and the parent ended before its child resumed: nothing pretends to have run uninterrupted across it.
		const tools = spans.filter((s) => s.name === "gate").sort((a, b) => a.start - b.start);
		expect(tools.map((t) => [t.attrs.phase, t.attrs.outcome, t.attrs.resumed, t.attrs["langfuse.observation.type"]])).toEqual([["call", "waiting", false, "tool"], ["execute", "done", true, "tool"]]);
		expect(tools[0]!.parentSpanId).toBe(tools[1]!.parentSpanId);
		const parent = byId.get(tools[0]!.parentSpanId!)!;
		expect(tools[1]!.start - tools[0]!.end).toBeGreaterThanOrEqual(1000);
		expect(parent.end).toBeLessThan(tools[1]!.start);
		expect(Math.max(...spans.map((s) => s.end - s.start))).toBeLessThan(1000);

		// What Langfuse reads: the chat as the session, an opaque user, the release; generations with their model and usage.
		for (const s of spans) expect(s.attrs).toMatchObject({ "langfuse.session.id": `chat-${label(ownerId)}`, "langfuse.user.id": ownerRef(env(), ownerId), "langfuse.release": "1.2.3", "pim.partition.id": partitionId });
		expect(requests.map((r) => r.attrs["langfuse.observation.type"])).toEqual(["generation", "generation"]);
		expect(requests.map((r) => r.attrs["langfuse.observation.model.name"])).toEqual(["m", "m"]);
		// Usage as the transcript recorded it, once: the ledger is written from the same messages. The scripted model has no price, so no cost is sent, and the first chunk is not claimed as the start of the answer.
		const stored = (await readTranscript(stack.runtime, ownerId, partitionId, 1)).flatMap((e) => (e.model ?? []) as any[]).filter((m) => m.role === "assistant");
		const used = requests.map((r) => JSON.parse(String(r.attrs["langfuse.observation.usage_details"])) as Record<string, number>);
		expect(used.reduce((n, u) => n + u.output!, 0)).toBe(stored.reduce((n, m) => n + m.usage.output, 0));
		expect(used.reduce((n, u) => n + (u.input ?? 0), 0)).toBe(stored.reduce((n, m) => n + m.usage.input, 0));
		for (const r of requests) {
			expect(r.attrs["langfuse.observation.cost_details"]).toBeUndefined();
			expect(r.attrs["langfuse.observation.completion_start_time"]).toBeUndefined();
			expect(r.attrs["usage.output"]).toBeUndefined();
			expect(r.events.map((e) => e.name)).toContain("pi.ai.first_chunk");
		}
		// Content-free: no word of the person's, no tool argument, no owner id.
		const wire = receiver.requests.map((r) => r.body).join("\n");
		for (const leak of ["hello private words", "the-prompt-secret", ownerId, "all done"]) expect(wire, leak).not.toContain(leak);
		await tel.shutdown();
	}, 60_000);

	it("carries a run across a restart: the new process resumes the same trace", async () => {
		receiver.requests.length = 0;
		const ownerId = uniqueOwner();
		const { rig, tel, partitionId, runner: make } = await open(ownerId);
		rig.faux.setResponses([fauxAssistantMessage(fauxToolCall("gate", {}), { stopReason: "toolUse" }), fauxAssistantMessage("after restart")]);
		const a = make({ holderId: "runner-a", leaseTtlMs: 1_500 });
		await a.start();
		await command(a.inbox, ownerId, partitionId, "r1", 1, { content: "hi" });
		await waitFor("the call to park", () => rig.state.gateRuns[0]);
		await a.stop();
		await flushed(tel);
		const before = owned(ownerId);
		const trace = before.find((s) => s.name === "pi.durable.submit")!.traceId;
		const b = make({ holderId: "runner-b", leaseTtlMs: 10_000 });
		await b.start();
		await approve(b, ownerId, partitionId, await toolTask(ownerId));
		await waitFor("runner B to take the partition", () => b.resident(ownerId, partitionId), 15_000);
		await waitFor("the turn to finish", doneText(ownerId, partitionId, "after restart"));
		await b.stop();
		await flushed(tel);
		const after = owned(ownerId).filter((s) => !before.some((o) => o.spanId === s.spanId));
		// What the second process did is the same trace, as work resumed in this process: native `resumed`, and the conversation's chat from the carrier.
		expect(after.length).toBeGreaterThan(0);
		expect(new Set(after.map((s) => s.traceId))).toEqual(new Set([trace]));
		expect(after.some((s) => s.attrs.resumed === true)).toBe(true);
		for (const s of after) expect(s.attrs["langfuse.session.id"]).toBe(`chat-${label(ownerId)}`);
		await tel.shutdown();
	}, 60_000);

	it("shows a stopped run's abort in the run's own trace", async () => {
		receiver.requests.length = 0;
		const ownerId = uniqueOwner();
		const { rig, tel, partitionId, runner: make } = await open(ownerId);
		rig.faux.setResponses([fauxAssistantMessage(fauxToolCall("gate", {}), { stopReason: "toolUse" })]);
		const runner = make();
		await runner.start();
		await command(runner.inbox, ownerId, partitionId, "r1", 1, { content: "hi" });
		await waitFor("the call to park", () => rig.state.gateRuns[0]);
		await command(runner.inbox, ownerId, partitionId, "stop", 1, {}, "abort");
		await waitFor("the abort", async () => (await flushed(tel), owned(ownerId).find((s) => s.attrs.kind === "abort")));
		await runner.stop();
		await flushed(tel);
		const spans = owned(ownerId);
		expect(new Set(spans.map((s) => s.traceId)).size).toBe(1);
		expect(spans.filter((s) => s.attrs.kind === "abort").length).toBeGreaterThan(0);
		await tel.shutdown();
	}, 60_000);

	it("shows every provider attempt of a request that was retried and failed over, each with the model it asked", async () => {
		receiver.requests.length = 0;
		const ownerId = uniqueOwner();
		const failover = createFailover({ stallMs: 150, stallRetryMs: 10 });
		failover.setChain(ownerId, { provider: "faux", id: "m" }, [{ provider: "faux", id: "m" }, { provider: "faux", id: "m2" }]);
		const { rig, tel, partitionId, runner: make } = await open(ownerId, { failover });
		// A stalled stream is cut off by the failover's abort, as a provider's request is.
		const stalled = (_context: unknown, options?: { signal?: AbortSignal }) => new Promise<never>((_resolve, reject) => options?.signal?.addEventListener("abort", () => reject(new Error("cut off")), { once: true }));
		// m stalls twice (asked again once), then m2 answers: three attempts of one request.
		rig.faux.setResponses([stalled, stalled, fauxAssistantMessage("from m2")] as never);
		const runner = make();
		await runner.start();
		await command(runner.inbox, ownerId, partitionId, "r1", 1, { content: "hi" });
		await waitFor("the answer", doneText(ownerId, partitionId, "from m2"));
		await runner.stop();
		await flushed(tel);
		const attempts = owned(ownerId).filter((s) => s.name === "pi.ai.request").sort((a, b) => a.start - b.start);
		expect(attempts.map((a) => [a.attrs["langfuse.observation.model.name"], a.status?.code])).toEqual([["m", 2], ["m", 2], ["m2", 1]]);
		// All under the one request phase, and the error's text is not exported.
		expect(new Set(attempts.map((a) => a.parentSpanId)).size).toBe(1);
		expect(attempts[0]!.status?.message).toBe("provider_error");
		expect(attempts[0]!.attrs["langfuse.observation.usage_details"]).toBeUndefined();
		expect(attempts[2]!.attrs["langfuse.observation.usage_details"]).toBeDefined();
		await tel.shutdown();
	}, 60_000);

	it("shows a provider that failed with an error and the fallback that answered in its place", async () => {
		receiver.requests.length = 0;
		const ownerId = uniqueOwner();
		const failover = createFailover({});
		failover.setChain(ownerId, { provider: "faux", id: "m" }, [{ provider: "faux", id: "m" }, { provider: "faux", id: "m2" }]);
		const { rig, tel, partitionId, runner: make } = await open(ownerId, { failover });
		rig.faux.setResponses([fauxAssistantMessage([], { stopReason: "error", errorMessage: "503 service unavailable: please repeat my words hello private words" }), fauxAssistantMessage("from m2")]);
		const runner = make();
		await runner.start();
		await command(runner.inbox, ownerId, partitionId, "r1", 1, { content: "hi" });
		await waitFor("the answer", doneText(ownerId, partitionId, "from m2"));
		await runner.stop();
		await flushed(tel);
		const attempts = owned(ownerId).filter((s) => s.name === "pi.ai.request").sort((a, b) => a.start - b.start);
		// The model each attempt asked, not the one the request began with: the fallback's generation is m2's.
		expect(attempts.map((a) => [a.attrs["langfuse.observation.model.name"], a.status?.code])).toEqual([["m", 2], ["m2", 1]]);
		expect(receiver.requests.map((r) => r.body).join("")).not.toContain("hello private words");
		await tel.shutdown();
	}, 60_000);

	it("keeps owners and chats apart when their turns run at once", async () => {
		receiver.requests.length = 0;
		const owners = [uniqueOwner(), uniqueOwner(), uniqueOwner()];
		const tel = createTelemetry(env(), { role: "runner", immediate: true, conversation: async (ownerId) => ({ chat: `chat-${label(ownerId)}`, agent: `agent-${label(ownerId)}` }) })!;
		const opened = await Promise.all(owners.map((o) => open(o, { tel })));
		const runners = opened.map((o) => o.runner());
		for (const [i, o] of opened.entries()) {
			o.rig.faux.setResponses([fauxAssistantMessage(`answer ${i}`)]);
			await runners[i]!.start();
			await command(runners[i]!.inbox, owners[i]!, o.partitionId, "r1", 1, { content: "hi" });
		}
		await Promise.all(opened.map((o, i) => waitFor(`answer ${i}`, doneText(owners[i]!, o.partitionId, `answer ${i}`))));
		await Promise.all(runners.map((r) => r.stop()));
		await flushed(tel);
		for (const [i, ownerId] of owners.entries()) {
			const mine = owned(ownerId);
			expect(mine.length).toBeGreaterThan(0);
			for (const s of mine) expect(s.attrs).toMatchObject({ "pim.chat": `chat-${label(ownerId)}`, "pim.agent": `agent-${label(ownerId)}`, "pim.partition.id": opened[i]!.partitionId });
			// A trace belongs to one owner.
			const traces = new Set(mine.map((s) => s.traceId));
			for (const other of owners.filter((o) => o !== ownerId)) for (const s of owned(other)) expect(traces.has(s.traceId)).toBe(false);
		}
		await tel.shutdown();
	}, 60_000);

	it("tells Langfuse which chat started a delegated chat's runs, by the ids Pim already keeps", async () => {
		receiver.requests.length = 0;
		const ownerId = uniqueOwner();
		const tel = createTelemetry(env(), { role: "runner", immediate: true, conversation: async () => ({ chat: "task-chat", agent: "delegate", startedByChat: "parent-chat", startedByTask: "task-7" }) })!;
		const { rig, partitionId, runner: make } = await open(ownerId, { tel });
		rig.faux.setResponses([fauxAssistantMessage("done")]);
		const runner = make();
		await runner.start();
		await command(runner.inbox, ownerId, partitionId, "r1", 1, { content: "do the task" });
		await waitFor("the answer", doneText(ownerId, partitionId, "done"));
		await runner.stop();
		await flushed(tel);
		for (const s of owned(ownerId)) expect(s.attrs).toMatchObject({ "langfuse.session.id": "task-chat", "langfuse.trace.metadata.started_by_chat": "parent-chat", "langfuse.trace.metadata.started_by_task": "task-7", "langfuse.trace.metadata.agent": "delegate" });
		// A delegated chat's run is its own trace: pi starts a run's trace at its submission, and the command that started it carries no span of the delegating call.
		expect(owned(ownerId).filter((s) => s.parentSpanId === undefined)).toHaveLength(1);
		await tel.shutdown();
	}, 60_000);

	it("never changes what an agent does when the collector fails, and never waits for one that hangs", async () => {
		for (const mode of ["fail", "hang"] as const) {
			receiver.requests.length = 0;
			receiver.behavior.mode = mode;
			const ownerId = uniqueOwner();
			const { rig, tel, partitionId, runner: make } = await open(ownerId);
			rig.faux.setResponses([fauxAssistantMessage(fauxToolCall("gate", {}), { stopReason: "toolUse" }), fauxAssistantMessage(`finished ${mode}`)]);
			const runner = make();
			await runner.start();
			await command(runner.inbox, ownerId, partitionId, "r1", 1, { content: "hi" });
			await waitFor("the call to park", () => rig.state.gateRuns[0]);
			await approve(runner, ownerId, partitionId, await toolTask(ownerId));
			await waitFor("the turn to finish", doneText(ownerId, partitionId, `finished ${mode}`), 20_000);
			await runner.stop();
			// The collector was asked, and the turn was never held for it; shutdown returns within its bound even with a request still open.
			expect(receiver.requests.length).toBeGreaterThan(0);
			const started = Date.now();
			await tel.shutdown();
			expect(Date.now() - started).toBeLessThan(8_000);
		}
		receiver.behavior.mode = "ok";
	}, 60_000);
});

describe("a model call that no chat asked for, to a real provider endpoint", () => {
	it("shows usage in its cache tiers and the price the catalog supplied, under a span that says what it was for, and sends the provider nothing of Pim's", async () => {
		receiver.requests.length = 0;
		const seen: { headers: IncomingMessage["headers"]; url: string; body: string }[] = [];
		const provider = createServer((req, res) => {
			const chunks: Buffer[] = [];
			req.on("data", (c) => chunks.push(c));
			req.on("end", () => {
				seen.push({ headers: req.headers, url: req.url ?? "", body: Buffer.concat(chunks).toString() });
				res.writeHead(200, { "content-type": "text/event-stream" });
				res.write(`data: ${JSON.stringify({ id: "1", model: "gpt-x", choices: [{ index: 0, delta: { role: "assistant", content: "the answer" } }] })}\n\n`);
				res.write(`data: ${JSON.stringify({ id: "1", model: "gpt-x", choices: [{ index: 0, delta: {}, finish_reason: "stop" }], usage: { prompt_tokens: 1000, completion_tokens: 20, prompt_tokens_details: { cached_tokens: 600 } } })}\n\n`);
				res.end("data: [DONE]\n\n");
			});
		});
		await new Promise<void>((resolve) => provider.listen(0, "127.0.0.1", resolve));
		const models = createModels();
		models.setProvider(compatibleProvider("gw", "Gateway", `http://127.0.0.1:${(provider.address() as { port: number }).port}/v1`, [{ id: "gpt-x", cost: { input: 2, output: 10, cacheRead: 0.2, cacheWrite: 2.5 } }], () => "provider-key") as never);
		const ownerId = uniqueOwner();
		const tel = createTelemetry(env(), { role: "runner", immediate: true })!;
		const answer: any = await tel.background(ownerId, "memory_nap", (span) => models.completeSimple(models.getModel("gw", "gpt-x")!, { systemPrompt: "s", messages: [{ role: "user", content: "a private question", timestamp: Date.now() }] } as never, { telemetry: span } as never));
		expect(answer.content[0].text).toBe("the answer");
		await flushed(tel);
		const spans = owned(ownerId);
		const background = spans.find((s) => s.name === "pim.background")!;
		const request = spans.find((s) => s.name === "pi.ai.request")!;
		expect(background.attrs["pim.call"]).toBe("memory_nap");
		expect(request.parentSpanId).toBe(background.spanId);
		expect(request.attrs["langfuse.observation.model.name"]).toBe("gpt-x");
		expect(JSON.parse(String(request.attrs["langfuse.observation.usage_details"]))).toEqual({ input: 400, output: 20, cache_read_input_tokens: 600 });
		// The price is the catalog's: (400 × 2 + 20 × 10 + 600 × 0.2) per million tokens, which is also what the cost ledger writes from the same message.
		expect(JSON.parse(String(request.attrs["langfuse.observation.cost_details"])).total).toBeCloseTo(0.00112, 9);
		expect(answer.usage.cost.total).toBeCloseTo(0.00112, 9);
		// What the provider received is the request and the key, and no trace context, baggage or reference to the owner.
		expect(seen).toHaveLength(1);
		expect(Object.keys(seen[0]!.headers).filter((h) => /traceparent|tracestate|baggage|pim|owner|langfuse/i.test(h))).toEqual([]);
		expect(JSON.stringify(seen[0])).not.toContain(ownerRef(env(), ownerId));
		expect(JSON.stringify(seen[0])).not.toContain(ownerId);
		await tel.shutdown();
		provider.close();
		provider.closeAllConnections();
	}, 30_000);
});

describe("tracing that is not asked for", () => {
	it("makes no exporter and sends nothing without an endpoint, or with one it cannot use", async () => {
		const before = receiver.requests.length;
		let fetched = 0;
		const real = globalThis.fetch;
		globalThis.fetch = ((...args: Parameters<typeof fetch>) => (fetched++, real(...args))) as typeof fetch;
		try {
			for (const e of [{}, { OTEL_EXPORTER_OTLP_ENDPOINT: "" }, { OTEL_EXPORTER_OTLP_ENDPOINT: "not a url" }, { OTEL_EXPORTER_OTLP_ENDPOINT: `http://127.0.0.1:${port}`, OTEL_EXPORTER_OTLP_PROTOCOL: "grpc" }]) {
				const tel = createTelemetry({ ...e, OTEL_INSTRUMENTATION_GENAI_CAPTURE_MESSAGE_CONTENT: "true" }, { role: "runner" });
				expect(tel).toBeUndefined();
			}
			await pause(100);
			expect(fetched).toBe(0);
			expect(receiver.requests.length).toBe(before);
		} finally {
			globalThis.fetch = real;
		}
	});
});

describe("the owner reference", () => {
	const derived = (key: string, ownerId: string) => `o_${createHmac("sha256", key).update(`pim.telemetry.owner:${ownerId}`).digest("hex").slice(0, 16)}`;
	it("is keyed by the deployment's secret, and with none by a key made for the process, never by anything public", () => {
		expect(ownerRef({ PIM_INGRESS_SECRET: "s3cret" }, "o_ada")).toBe(derived("s3cret", "o_ada"));
		expect(ownerRef({ PIM_INGRESS_SECRET: "other" }, "o_ada")).not.toBe(ownerRef({ PIM_INGRESS_SECRET: "s3cret" }, "o_ada"));
		for (const missing of [{}, { PIM_INGRESS_SECRET: "" }, { PIM_INGRESS_SECRET: "  " }]) {
			const ref = ownerRef(missing, "o_ada");
			// Not what anyone can compute from the code or a guessed owner id: not the old constant, not an empty key, not the id's plain hash.
			for (const guess of ["pim", "", "  ", "ingress", "o_ada"]) expect(ref, JSON.stringify(guess)).not.toBe(derived(guess, "o_ada"));
			expect(ownerRef(missing, "o_ada")).toBe(ref);
			expect(ownerRef(missing, "o_bob")).not.toBe(ref);
		}
		expect(ownerRef({}, "o_ada")).toBe(ownerRef({ PIM_INGRESS_SECRET: " " }, "o_ada"));
	});
});

describe("the lookup of chat and agent ids", () => {
	/** Spans of one partition, each in a conversation of its own, exported to a list. */
	function traced(resolve: (conversation: number) => Promise<{ chat: string } | undefined>, limits: Record<string, number>) {
		const batches: { name: string; chat: unknown; session: unknown }[][] = [];
		let late = 0;
		const calls: number[] = [];
		const tel = createTelemetry({ PIM_INGRESS_SECRET: "k" }, { role: "runner", immediate: true, limits, exporter: { export: (spans, done) => (batches.push(spans.map((s) => ({ name: s.name, chat: s.attributes["pim.chat"], session: s.attributes["pim.conversation"] }))), done({ code: 0 })), shutdown: async () => void (late = 0) }, conversation: async (_owner, conversation) => (calls.push(conversation), resolve(conversation)) })!;
		const emit = (...conversations: number[]) => Promise.all(conversations.map((c) => tel.partition("o_x", "p1").startSpan({ name: `c${c}`, attributes: { "conversation.id": c } }, () => undefined)));
		return { tel, emit, calls, batches, spans: () => batches.flat(), late: () => late };
	}

	it("never holds a batch past its deadline or keeps more lookups outstanding than its bound, however long the database hangs, over many batches and expired answers", async () => {
		const { tel, emit, calls, spans } = traced(() => new Promise(() => {}), { deadlineMs: 40, inflight: 3, perBatch: 2, ttlMs: 10 });
		let sent = 0;
		for (let wave = 0; wave < 6; wave++) {
			await emit(1 + wave * 5, 2 + wave * 5, 3 + wave * 5, 4 + wave * 5, 5 + wave * 5);
			const before = Date.now();
			// Every wave's spans are exported, without ids, within the deadline's order of time.
			while (spans().length < sent + 5 && Date.now() - before < 3000) await pause(10);
			expect(spans().length, `wave ${wave}`).toBe(sent + 5);
			expect(Date.now() - before).toBeLessThan(1500);
			sent += 5;
		}
		expect(spans().every((s) => s.chat === undefined)).toBe(true);
		// 30 conversations asked about, none answered: no more than three lookups were ever started, and none was repeated.
		expect(calls.length).toBeLessThanOrEqual(3);
		expect(new Set(calls).size).toBe(calls.length);
		const started = Date.now();
		await tel.shutdown();
		expect(Date.now() - started).toBeLessThan(3000);
	}, 30_000);

	it("counts every lookup against a batch's share, an expired answer's too", async () => {
		const { tel, emit, calls } = traced(async (c) => ({ chat: `chat-${c}` }), { perBatch: 2, ttlMs: 30 });
		await emit(1, 2, 3, 4, 5, 6);
		await pause(300);
		expect(calls.length).toBeLessThanOrEqual(2);
		const first = calls.length;
		// Past their time, the answers are asked for again, and again no more than a batch's share.
		await pause(60);
		await emit(1, 2, 3, 4, 5, 6);
		await pause(300);
		expect(calls.length - first).toBeLessThanOrEqual(2);
		await tel.shutdown();
	});

	it("sends nothing after shutdown when a lookup that hung answers late", async () => {
		let answer!: (v: { chat: string }) => void;
		const { tel, emit, spans, batches } = traced(() => new Promise((resolve) => (answer = resolve)), { deadlineMs: 5_000 });
		void emit(1);
		await pause(150);
		expect(spans()).toHaveLength(0); // still waiting for the lookup, inside its deadline
		await tel.shutdown();
		answer({ chat: "late" });
		await pause(200);
		expect(batches).toEqual([]);
	});
});
