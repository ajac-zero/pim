import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { modelGateway, usageOf } from "../src/http/gateway";
import { ScriptedPort, startReq, ada, stack } from "./stack";
import { serve } from "./serve";

describe("model gateway", () => {
	let s: Awaited<ReturnType<typeof stack>>;
	let gw: Awaited<ReturnType<typeof serve>>;
	let upstream: Server;
	let upstreamUrl = "";
	const seen: { path: string; headers: Record<string, any>; body: string }[] = [];
	let n = 0;

	beforeAll(async () => {
		s = await stack();
		await s.grantAll("ada");
		upstream = createServer(async (req, res) => {
			let body = "";
			for await (const c of req) body += c;
			seen.push({ path: req.url!, headers: req.headers, body });
			if (req.url!.startsWith("/v1/messages/count_tokens")) return void res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ input_tokens: 10 }));
			if (JSON.parse(body).stream) {
				res.writeHead(200, { "content-type": "text/event-stream" });
				res.write(`event: message_start\ndata: ${JSON.stringify({ type: "message_start", message: { model: "claude-x", usage: { input_tokens: 1000, cache_read_input_tokens: 200, output_tokens: 1 } } })}\n\n`);
				res.write(`event: message_delta\ndata: ${JSON.stringify({ type: "message_delta", usage: { output_tokens: 500 } })}\n\n`);
				return void res.end();
			}
			res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ model: "gpt-x", usage: { prompt_tokens: 2000, completion_tokens: 100 }, choices: [] }));
		});
		await new Promise<void>((r) => upstream.listen(0, "127.0.0.1", r));
		upstreamUrl = `http://127.0.0.1:${(upstream.address() as AddressInfo).port}`;
		gw = await serve(modelGateway({ credentials: s.credentials, store: s.store, key: async (_t, family) => (family === "anthropic" ? { apiKey: "sk-ant-person", baseUrl: upstreamUrl } : { apiKey: "sk-openai-person", baseUrl: upstreamUrl }), price: (_f, _m, u) => (u.input + u.output) / 1000, limits: { concurrent: 2, requestsPerMinute: 5 } }));
	});
	afterAll(async () => {
		await gw.stop();
		upstream.closeAllConnections();
		upstream.close();
		await s.close();
	});

	const thread = async (budgetUsd?: number) => {
		const { threadId } = await s.forge.start(ada, startReq(`gw-${++n}`, { harness: "claude-code", budgetUsd }));
		await s.worker({ turns: { "claude-code": new ScriptedPort([{ outcome: "completed" }]) } }).step(threadId);
		return (await s.store.get(threadId))!;
	};
	const call = (token: string | null, path: string, body: object, headers: Record<string, string> = {}) => fetch(`${gw.url}/api/coding/gateway/${path}`, { method: "POST", headers: { "content-type": "application/json", ...(token ? { authorization: `Bearer ${token}` } : {}), ...headers }, body: JSON.stringify(body) });

	it("adds the person's key outside the sandbox, passes the answer through, and charges the usage it reports", async () => {
		const t = await thread();
		const tok = s.credentials.gatewayToken(t, { families: ["anthropic", "openai"] });
		const r = await call(tok, "openai/v1/chat/completions", { model: "gpt-x", messages: [] });
		expect(r.status).toBe(200);
		expect(((await r.json()) as any).model).toBe("gpt-x");
		const last = seen.at(-1)!;
		expect(last.headers.authorization).toBe("Bearer sk-openai-person");
		expect(JSON.stringify(last.headers)).not.toContain("pimgw_");
		const after = (await s.store.get(t.threadId))!;
		expect(after.spentUsd).toBeCloseTo(2.1);
		const ev = (await s.store.events(t.threadId, { kind: "model_call" }))[0]!;
		expect(ev.data).toMatchObject({ via: "gateway", model: "gpt-x", estimated: false });
		expect(ev.tokens_in).toBe("2000");
	});

	it("streams a server-sent answer straight through and charges its usage when it ends", async () => {
		const t = await thread();
		const tok = s.credentials.gatewayToken(t, { families: ["anthropic"] });
		const r = await call(tok, "anthropic/v1/messages", { model: "claude-x", stream: true }, { "anthropic-version": "2023-06-01" });
		const text = await r.text();
		expect(text).toContain("message_delta");
		expect(seen.at(-1)!.headers["x-api-key"]).toBe("sk-ant-person");
		const ev = (await s.store.events(t.threadId, { kind: "model_call" }))[0]!;
		expect(ev).toMatchObject({ tokens_in: "1000", tokens_out: "500" });
		expect((await s.store.get(t.threadId))!.spentUsd).toBeCloseTo(1.5);
		// Counting tokens is free.
		const count = await call(tok, "anthropic/v1/messages/count_tokens", { model: "claude-x" });
		expect(count.status).toBe(200);
		expect((await s.store.get(t.threadId))!.spentUsd).toBeCloseTo(1.5);
	});

	it("revoked, suspended, forged, wrong-family and unknown-route requests never reach the provider", async () => {
		const calls = seen.length;
		const t = await thread();
		const tok = s.credentials.gatewayToken(t, { families: ["openai"] });
		expect((await call(tok, "anthropic/v1/messages", { model: "x" })).status).toBe(403);
		expect((await call("pimgw_forged.token", "openai/v1/chat/completions", {})).status).toBe(401);
		expect((await call(null, "openai/v1/chat/completions", {})).status).toBe(401);
		expect((await call(tok, "openai/v1/models", {})).status).toBe(404);
		await s.authz.setSuspended("ada", true);
		expect((await call(tok, "openai/v1/chat/completions", {})).status).toBe(401);
		await s.authz.setSuspended("ada", false);
		await s.forge.abort(ada, t.threadId);
		expect((await call(tok, "openai/v1/chat/completions", {})).status).toBe(401);
		const u = await thread();
		await s.forge.archive(ada, u.threadId);
		expect((await call(s.credentials.gatewayToken(u, { families: ["openai"] }), "openai/v1/chat/completions", {})).status).toBe(401);
		expect(seen.length).toBe(calls);
	});

	it("caps a thread's requests per minute", async () => {
		const t = await thread();
		const tok = s.credentials.gatewayToken(t, { families: ["openai"] });
		const codes: number[] = [];
		for (let i = 0; i < 7; i++) codes.push((await call(tok, "openai/v1/chat/completions", { model: "gpt-x" })).status);
		expect(codes).toEqual([200, 200, 200, 200, 200, 429, 429]);
	});

	it("makes a streamed Chat Completions request report its usage, and leaves any other body as it was", async () => {
		const t = await thread();
		const tok = s.credentials.gatewayToken(t, { families: ["openai"] });
		await (await call(tok, "openai/v1/chat/completions", { model: "gpt-x", stream: true, stream_options: { other: 1 }, messages: [] })).text();
		expect(JSON.parse(seen.at(-1)!.body)).toEqual({ model: "gpt-x", stream: true, stream_options: { other: 1, include_usage: true }, messages: [] });
		await (await call(tok, "openai/v1/chat/completions", { model: "gpt-x", messages: [] })).text();
		expect(seen.at(-1)!.body).toBe(JSON.stringify({ model: "gpt-x", messages: [] }));
	});

	it("gives up on a provider that stops sending, ends the stream with the API's own error event, charges what it reported, and frees the request's place", async () => {
		const quiet = createServer((req, res) => {
			req.resume();
			res.writeHead(200, { "content-type": "text/event-stream" });
			res.write(`event: message_start\ndata: ${JSON.stringify({ type: "message_start", message: { model: "claude-x", usage: { input_tokens: 1200, output_tokens: 1 } } })}\n\n`);
		});
		await new Promise<void>((r) => quiet.listen(0, "127.0.0.1", r));
		const base = `http://127.0.0.1:${(quiet.address() as AddressInfo).port}`;
		const slow = await serve(modelGateway({ credentials: s.credentials, store: s.store, key: async () => ({ apiKey: "sk-ant-person", baseUrl: base }), price: (_f, _m, u) => (u.input + u.output) / 1000, limits: { idleTimeoutMs: 100, concurrent: 1 } }));
		try {
			const t = await thread();
			const tok = s.credentials.gatewayToken(t, { families: ["anthropic"] });
			const ask = () => fetch(`${slow.url}/api/coding/gateway/anthropic/v1/messages`, { method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${tok}` }, body: JSON.stringify({ model: "claude-x", stream: true }) });
			const r = await ask();
			const text = await r.text();
			expect(text).toContain("message_start");
			expect(text).toMatch(/event: error\ndata: \{"type":"error","error":\{"type":"api_error","message":"The model provider stopped sending/);
			const ev = (await s.store.events(t.threadId, { kind: "model_call" }))[0]!;
			expect(ev).toMatchObject({ tokens_in: "1200" });
			// The one place it had is free again.
			const again = await ask();
			expect(again.status).toBe(200);
			await again.text();
		} finally {
			await slow.stop();
			quiet.closeAllConnections();
			quiet.close();
		}
	});

	it("reads usage from a JSON body and from stream events, taking the largest of each counter", () => {
		expect(usageOf(JSON.stringify({ model: "m", usage: { input_tokens: 5, output_tokens: 7, input_tokens_details: { cached_tokens: 2 } } }))).toEqual({ model: "m", usage: { input: 5, output: 7, cacheRead: 2, cacheWrite: 0 } });
		expect(usageOf("data: {\"type\":\"response.completed\",\"response\":{\"model\":\"r\",\"usage\":{\"input_tokens\":9,\"output_tokens\":1}}}\n\n").usage).toMatchObject({ input: 9, output: 1 });
		expect(usageOf("nothing here").usage).toBeNull();
	});
});
