import { env, runInDurableObject } from "cloudflare:test";
import { exports } from "cloudflare:workers";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import {
	gatewayPrice,
	gatewayTokenKey,
	issueGatewayToken,
	UsageMeter,
	verifyGatewayToken,
} from "../src/coding/model-gateway";
import { codingThread } from "../src/coding/thread-do";
import type { CodingThreadRow } from "../src/coding/thread-store";
import { getBuiltinModels } from "../src/provider-catalog";
import { OWNER, post } from "./helpers";
import { type CodingThreadDO, codingGateway } from "./worker";

// Each thread here is a row made in its object, in the tests' space (OWNER), which has the built-in Anthropic and
// OpenAI providers with the keys below. The model gateway is reached through the real Worker at https://pim.test, and
// the providers are `codingGateway.fetch`: nothing leaves the test.

const ANTHROPIC_KEY = "sk-ant-api03-REAL-ANTHROPIC-KEY-never-leaves-pim";
const OPENAI_KEY = "sk-proj-REAL-OPENAI-KEY-never-leaves-pim";
const KEYS = [ANTHROPIC_KEY, OPENAI_KEY];

type Stub = DurableObjectStub<CodingThreadDO>;
type Sent = { url: string; method: string; headers: Record<string, string>; body: string };

let sent: Sent[];
let answer: (request: Request) => Response | Promise<Response>;
let logged: string[];

beforeAll(async () => {
	expect((await post("/providers", { builtin: "anthropic", key: ANTHROPIC_KEY, models: ["claude-sonnet-4-5"] })).status).toBe(200);
	expect((await post("/providers", { builtin: "openai", key: OPENAI_KEY, models: ["gpt-5"] })).status).toBe(200);
});

beforeEach(() => {
	sent = [];
	answer = () => new Response("no answer scripted", { status: 500 });
	codingGateway.limits = {};
	codingGateway.fetch = async (input, init) => {
		const request = new Request(input, init);
		sent.push({ url: request.url, method: request.method, headers: Object.fromEntries(request.headers), body: await request.clone().text() });
		return answer(request);
	};
	logged = [];
	for (const method of ["log", "info", "warn", "error", "debug"] as const) {
		const original = console[method].bind(console);
		vi.spyOn(console, method).mockImplementation((...args: unknown[]) => {
			logged.push(args.map((arg) => (typeof arg === "string" ? arg : arg instanceof Error ? `${arg.message} ${arg.stack}` : JSON.stringify(arg))).join(" "));
			original(...args);
		});
	}
});

afterEach(() => {
	vi.restoreAllMocks();
	codingGateway.fetch = null;
	// Nothing the Worker or the thread logged, in any test, holds a provider key.
	for (const line of logged) for (const key of KEYS) expect(line).not.toContain(key);
});

/** A thread in the tests' space, made as `start` records one, idle, with no workspace. */
async function makeThread(overrides: Partial<CodingThreadRow> = {}): Promise<{ id: string; stub: Stub }> {
	const id = crypto.randomUUID();
	const stub = codingThread(env, id) as Stub;
	await runInDurableObject(stub, (thread: CodingThreadDO) =>
		thread.store.create({
			threadId: id,
			space: OWNER,
			repoUrl: "https://github.com/acme/demo",
			baseRef: "main",
			branch: "pim/gateway",
			harness: "pi",
			profile: { providerId: "own:anthropic", model: "claude-sonnet-4-5" },
			providerId: "fake",
			state: "idle",
			createdBy: "tester",
			parentThread: null,
			limits: { cpu: 2, memMiB: 4096, diskMiB: 10_240, pids: 1024, wallClockMin: 240 },
			budgetUsd: 3,
			startOperation: `start-${id}`,
			...overrides,
		}),
	);
	return { id, stub };
}

/** A request to the gateway as a CLI sends it: through the Worker, with the token as Anthropic's or OpenAI's clients send keys. */
function gateway(path: string, token: string, init: { method?: string; body?: unknown; headers?: Record<string, string> } = {}): Promise<Response> {
	const auth: Record<string, string> = path.startsWith("/anthropic") ? { "x-api-key": token } : { authorization: `Bearer ${token}` };
	return exports.default.fetch(
		new Request(`https://pim.test/api/coding/gateway${path}`, {
			method: init.method ?? "POST",
			headers: { "content-type": "application/json", ...auth, ...init.headers },
			...(init.method === "GET" ? {} : { body: typeof init.body === "string" ? init.body : JSON.stringify(init.body ?? {}) }),
		}),
	);
}

/** `bytes` as a provider streams them: in chunks of `size`, which split lines, events and multi-byte characters. */
function chunked(bytes: Uint8Array, size: number): ReadableStream<Uint8Array> {
	return new ReadableStream({
		start(controller) {
			for (let at = 0; at < bytes.length; at += size) controller.enqueue(bytes.slice(at, at + size));
			controller.close();
		},
	});
}

const sse = (events: Array<[string, unknown]>) => events.map(([name, data]) => `event: ${name}\ndata: ${typeof data === "string" ? data : JSON.stringify(data)}\n\n`).join("");

/** A Messages API stream: 1,200 input, 300 cache-write, 5,000 cache-read and 420 output tokens, with text that mentions "usage". */
const ANTHROPIC_STREAM = sse([
	[
		"message_start",
		{ type: "message_start", message: { id: "msg_1", type: "message", role: "assistant", model: "claude-sonnet-4-5-20250929", content: [], stop_reason: null, usage: { input_tokens: 1200, cache_creation_input_tokens: 300, cache_read_input_tokens: 5000, output_tokens: 1 } } },
	],
	["ping", '{"type": "ping"}'],
	["content_block_start", { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } }],
	["content_block_delta", { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: 'Héllo — the "usage" field ✓ 🚀' } }],
	["content_block_stop", { type: "content_block_stop", index: 0 }],
	["message_delta", { type: "message_delta", delta: { stop_reason: "end_turn", stop_sequence: null }, usage: { output_tokens: 420 } }],
	["message_stop", { type: "message_stop" }],
]);
/** Claude Sonnet 4.5 at $3, $15, $0.30 and $3.75 per million input, output, cache-read and cache-write tokens. */
const ANTHROPIC_COST = (1200 * 3 + 420 * 15 + 5000 * 0.3 + 300 * 3.75) / 1_000_000;

/** A Responses API stream: 2,000 input tokens of which 1,500 cached, and 300 output; `usage` is null until the end. */
const RESPONSES_STREAM = sse([
	["response.created", { type: "response.created", sequence_number: 0, response: { id: "resp_1", object: "response", status: "in_progress", model: "gpt-5-2025-08-07", usage: null } }],
	["response.output_text.delta", { type: "response.output_text.delta", sequence_number: 1, item_id: "msg_1", output_index: 0, content_index: 0, delta: "Done ✓" }],
	[
		"response.completed",
		{
			type: "response.completed",
			sequence_number: 2,
			response: { id: "resp_1", object: "response", status: "completed", model: "gpt-5-2025-08-07", usage: { input_tokens: 2000, input_tokens_details: { cached_tokens: 1500 }, output_tokens: 300, output_tokens_details: { reasoning_tokens: 100 }, total_tokens: 2300 } },
		},
	],
]);
/** GPT-5 at $1.25, $10 and $0.125 per million input, output and cached tokens. */
const RESPONSES_COST = (500 * 1.25 + 300 * 10 + 1500 * 0.125) / 1_000_000;

const encode = (text: string) => new TextEncoder().encode(text);
const streamed = (text: string, size = 7, headers: Record<string, string> = {}) =>
	new Response(chunked(encode(text), size), { headers: { "content-type": "text/event-stream; charset=utf-8", ...headers } });

const modelCalls = (stub: Stub) => stub.log().then((events) => events.filter((event) => event.kind === "model_call"));

/** The thread's model calls, once it has `count`. */
const charged = (stub: Stub, count: number) =>
	vi.waitFor(
		async () => {
			const calls = await modelCalls(stub);
			expect(calls).toHaveLength(count);
			return calls;
		},
		{ timeout: 5_000, interval: 20 },
	);

/** Every row of every table the thread's object keeps, as one text. */
const everything = (stub: Stub) =>
	runInDurableObject(stub, (_instance: CodingThreadDO, state) => {
		const tables = state.storage.sql.exec("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE '\\_cf\\_%' ESCAPE '\\'").toArray();
		return JSON.stringify(tables.map(({ name }) => state.storage.sql.exec(`SELECT * FROM "${String(name)}"`).toArray()));
	});

const nonceOf = (stub: Stub) => runInDurableObject(stub, (thread: CodingThreadDO) => thread.store.gatewayNonce());

describe("the model gateway's tokens", () => {
	it("are minted for one thread, its space and families, until the thread's wall clock and a margin", async () => {
		const { id, stub } = await makeThread();
		const before = Date.now();
		const { token, expiresAt } = await stub.gatewayToken(["anthropic", "anthropic"]);
		expect(token).toMatch(/^pimgw_[\w-]+\.[\w-]+$/);
		const claims = await verifyGatewayToken(await gatewayTokenKey(env), token);
		expect(claims).toEqual({ threadId: id, space: OWNER, families: ["anthropic"], nonce: await nonceOf(stub), expiresAt });
		// 240 minutes of wall clock and 15 of margin.
		expect(expiresAt).toBeGreaterThanOrEqual(before + 255 * 60_000);
		expect(expiresAt).toBeLessThanOrEqual(Date.now() + 255 * 60_000);
		// A second token carries the same nonce, so the first still works.
		const second = await stub.gatewayToken(["openai"]);
		expect((await verifyGatewayToken(await gatewayTokenKey(env), second.token))?.nonce).toBe(claims!.nonce);
		expect(await verifyGatewayToken(await gatewayTokenKey(env), token, expiresAt)).toBeNull();
		await expect(runInDurableObject(stub, (thread: CodingThreadDO) => thread.gatewayToken([]))).rejects.toThrow(/families/);
		await expect(runInDurableObject(stub, (thread: CodingThreadDO) => thread.gatewayToken(["google" as "openai"]))).rejects.toThrow(/families/);
	});

	it("are refused when expired, tampered with, for another thread, another family, or revoked", async () => {
		const a = await makeThread();
		const b = await makeThread();
		const key = await gatewayTokenKey(env);
		answer = () => streamed(ANTHROPIC_STREAM);
		const body = { model: "claude-sonnet-4-5", max_tokens: 10, messages: [] };
		const { token } = await a.stub.gatewayToken(["anthropic"]);
		const claims = (await verifyGatewayToken(key, token))!;
		const refused = async (response: Response, status = 401) => {
			expect(response.status).toBe(status);
			const error = (await response.json()) as { type: string; error: { type: string; message: string } };
			expect(error.type).toBe("error");
			return error.error;
		};

		expect((await gateway("/anthropic/v1/messages", token, { body })).status).toBe(200);
		await refused(await gateway("/anthropic/v1/messages", "", { body }));
		await refused(await gateway("/anthropic/v1/messages", "sk-ant-not-a-gateway-token", { body }));
		// Expired.
		const expired = await issueGatewayToken(key, { ...claims, expiresAt: Date.now() - 1 });
		expect((await refused(await gateway("/anthropic/v1/messages", expired, { body }))).type).toBe("authentication_error");
		// Its claims changed, or its signature.
		const [payload, mac] = token.slice("pimgw_".length).split(".");
		const otherClaims = btoa(JSON.stringify({ v: 1, tid: a.id, sub: OWNER, fam: ["anthropic", "openai"], n: claims.nonce, exp: claims.expiresAt })).replace(/=+$/, "").replace(/\+/g, "-").replace(/\//g, "_");
		await refused(await gateway("/anthropic/v1/messages", `pimgw_${otherClaims}.${mac}`, { body }));
		await refused(await gateway("/anthropic/v1/messages", `pimgw_${payload}.${mac![0] === "A" ? "B" : "A"}${mac!.slice(1)}`, { body }));
		// Signed for thread B but with A's nonce, or for A in another space.
		await refused(await gateway("/anthropic/v1/messages", await issueGatewayToken(key, { ...claims, threadId: b.id }), { body }));
		await refused(await gateway("/anthropic/v1/messages", await issueGatewayToken(key, { ...claims, space: "o_someoneelse" }), { body }));
		// A's token handed to B's object directly.
		const direct = await b.stub.gatewayRequest(token, "anthropic", "/v1/messages", new Request("https://pim.test/api/coding/gateway/anthropic/v1/messages", { method: "POST", body: JSON.stringify(body) }));
		await refused(direct);
		// A family the token doesn't name.
		const openai = await gateway("/openai/v1/responses", token, { body: { model: "gpt-5", input: "hi" } });
		expect(openai.status).toBe(403);
		expect(await openai.json()).toMatchObject({ error: { code: "family_not_allowed" } });
		expect(sent).toHaveLength(1);

		// Aborting revokes every token; a new one has a new nonce and works.
		await a.stub.abort();
		expect(await nonceOf(a.stub)).toBeNull();
		await refused(await gateway("/anthropic/v1/messages", token, { body }));
		const fresh = await a.stub.gatewayToken(["anthropic"]);
		expect((await verifyGatewayToken(key, fresh.token))!.nonce).not.toBe(claims.nonce);
		await refused(await gateway("/anthropic/v1/messages", token, { body }));
		expect((await gateway("/anthropic/v1/messages", fresh.token, { body })).status).toBe(200);
		// Archiving revokes too, and mints no more.
		await a.stub.archive();
		await refused(await gateway("/anthropic/v1/messages", fresh.token, { body }));
		await expect(runInDurableObject(a.stub, (thread: CodingThreadDO) => thread.gatewayToken(["anthropic"]))).rejects.toThrow(/archived/);
		expect(sent).toHaveLength(2);
	});
});

describe("the model gateway", () => {
	it("forwards only the APIs' own paths and methods", async () => {
		const { stub } = await makeThread();
		const { token } = await stub.gatewayToken(["anthropic", "openai"]);
		const tries: Array<[string, { method?: string; body?: unknown }, number]> = [
			["/anthropic/v1/messages", { method: "GET" }, 405],
			["/anthropic/v1/models", { method: "GET" }, 404],
			["/anthropic/v1/complete", {}, 404],
			["/anthropic/v1/messages/batches", {}, 404],
			["/anthropic/v1/messages?beta=true&x=1", {}, 400],
			["/anthropic/v1/files", {}, 404],
			["/openai/v1/embeddings", {}, 404],
			["/openai/v1/responses?stream=true", {}, 400],
			["/openai/v1/chat/completions", { method: "PUT" }, 405],
			["/openai/v1/responses/resp_1/cancel", {}, 404],
			["/google/v1beta/models", {}, 404],
		];
		for (const [path, init, status] of tries) expect([path, (await gateway(path, token, init)).status]).toEqual([path, status]);
		// Bodies the gateway can't read.
		expect((await gateway("/anthropic/v1/messages", token, { body: "not json" })).status).toBe(400);
		expect((await gateway("/anthropic/v1/messages", token, { body: [] })).status).toBe(400);
		expect((await gateway("/openai/v1/responses", token, { body: { input: "no model" } })).status).toBe(400);
		codingGateway.limits = { maxRequestBytes: 1024 };
		const large = await gateway("/anthropic/v1/messages", token, { body: { model: "claude-sonnet-4-5", messages: [{ role: "user", content: "x".repeat(2000) }] } });
		expect(large.status).toBe(413);
		expect(await large.json()).toMatchObject({ type: "error", error: { type: "request_too_large" } });
		expect(sent).toHaveLength(0);
		expect(await modelCalls(stub)).toHaveLength(0);
	});

	it("streams a Messages answer back byte for byte with the space's key, and charges its usage", async () => {
		const { stub } = await makeThread();
		const { env: sandbox, egressHost } = await stub.modelGatewayEnv("claude-code");
		expect(egressHost).toBe("pim.test");
		expect(Object.keys(sandbox).sort()).toEqual(["ANTHROPIC_API_KEY", "ANTHROPIC_BASE_URL"]);
		expect(sandbox.ANTHROPIC_BASE_URL).toBe("https://pim.test/api/coding/gateway/anthropic");
		const token = sandbox.ANTHROPIC_API_KEY!;
		answer = () =>
			streamed(ANTHROPIC_STREAM, 7, {
				"request-id": "req_1",
				"anthropic-ratelimit-requests-remaining": "99",
				"set-cookie": "upstream=1",
				"cf-ray": "abc",
				connection: "keep-alive",
				"anthropic-organization-id": "org-private",
			});
		const body = { model: "claude-sonnet-4-5", max_tokens: 1024, stream: true, messages: [{ role: "user", content: "Hi" }] };
		const response = await exports.default.fetch(
			new Request(`${sandbox.ANTHROPIC_BASE_URL}/v1/messages?beta=true`, {
				method: "POST",
				headers: { "x-api-key": token, "content-type": "application/json", "anthropic-version": "2023-06-01", "anthropic-beta": "interleaved-thinking-2025-05-14", cookie: "pim_session=x", "x-forwarded-for": "10.0.0.1", "openai-organization": "org-x" },
				body: JSON.stringify(body),
			}),
		);
		expect(response.status).toBe(200);
		expect(new Uint8Array(await response.arrayBuffer())).toEqual(encode(ANTHROPIC_STREAM));
		expect(response.headers.get("content-type")).toBe("text/event-stream; charset=utf-8");
		expect(response.headers.get("request-id")).toBe("req_1");
		expect(response.headers.get("anthropic-ratelimit-requests-remaining")).toBe("99");
		for (const name of ["set-cookie", "cf-ray", "anthropic-organization-id"]) expect(response.headers.has(name)).toBe(false);

		expect(sent).toHaveLength(1);
		expect(sent[0]!.url).toBe("https://api.anthropic.com/v1/messages");
		expect(sent[0]!.body).toBe(JSON.stringify(body));
		expect(sent[0]!.headers).toEqual({
			"x-api-key": ANTHROPIC_KEY,
			"content-type": "application/json",
			"anthropic-version": "2023-06-01",
			"anthropic-beta": "interleaved-thinking-2025-05-14",
		});

		const [call] = await charged(stub, 1);
		expect(call).toMatchObject({ provider: "own:anthropic", model: "claude-sonnet-4-5", input: 1200, output: 420, cacheRead: 5000, cacheWrite: 300, data: { via: "gateway", api: "anthropic-messages", pricing: "catalog" } });
		expect(call!.costUsd).toBeCloseTo(ANTHROPIC_COST, 12);
		expect((await stub.status()).spentUsd).toBeCloseTo(ANTHROPIC_COST, 12);
		for (const key of KEYS) expect(await everything(stub)).not.toContain(key);
	});

	it("streams a Responses answer back byte for byte and charges cached input as cached", async () => {
		const { stub } = await makeThread({ profile: { providerId: "own:openai", model: "gpt-5" } });
		const { env: sandbox } = await stub.modelGatewayEnv("codex");
		expect(sandbox).toEqual({ OPENAI_BASE_URL: "https://pim.test/api/coding/gateway/openai/v1", OPENAI_API_KEY: sandbox.OPENAI_API_KEY, CODEX_API_KEY: sandbox.OPENAI_API_KEY });
		answer = () => streamed(RESPONSES_STREAM, 5, { "x-request-id": "req_2", "openai-organization": "org-private" });
		const response = await exports.default.fetch(
			new Request(`${sandbox.OPENAI_BASE_URL}/responses`, {
				method: "POST",
				headers: { authorization: `Bearer ${sandbox.OPENAI_API_KEY}`, "content-type": "application/json" },
				body: JSON.stringify({ model: "gpt-5", input: "Hi", stream: true }),
			}),
		);
		expect(response.status).toBe(200);
		expect(new Uint8Array(await response.arrayBuffer())).toEqual(encode(RESPONSES_STREAM));
		expect(response.headers.get("x-request-id")).toBe("req_2");
		expect(response.headers.has("openai-organization")).toBe(false);
		expect(sent[0]).toMatchObject({ url: "https://api.openai.com/v1/responses", headers: { authorization: `Bearer ${OPENAI_KEY}` } });
		const [call] = await charged(stub, 1);
		expect(call).toMatchObject({ provider: "own:openai", model: "gpt-5", input: 500, cacheRead: 1500, output: 300, cacheWrite: 0, data: { api: "openai-responses" } });
		expect(call!.costUsd).toBeCloseTo(RESPONSES_COST, 12);
	});

	it("makes a streamed Chat Completions request report its usage, and charges it", async () => {
		const { stub } = await makeThread();
		const { token } = await stub.gatewayToken(["openai"]);
		const chunk = (extra: Record<string, unknown>) => `data: ${JSON.stringify({ id: "c1", object: "chat.completion.chunk", model: "gpt-4.1", ...extra })}\n\n`;
		const stream = `${chunk({ choices: [{ index: 0, delta: { content: "Hi" } }] })}${chunk({ choices: [], usage: { prompt_tokens: 100, completion_tokens: 20, prompt_tokens_details: { cached_tokens: 40 } } })}data: [DONE]\n\n`;
		answer = () => streamed(stream, 3);
		const response = await gateway("/openai/v1/chat/completions", token, { body: { model: "gpt-4.1", stream: true, stream_options: { other: 1 }, messages: [] } });
		expect(await response.text()).toBe(stream);
		expect(JSON.parse(sent[0]!.body)).toEqual({ model: "gpt-4.1", stream: true, stream_options: { other: 1, include_usage: true }, messages: [] });
		const [call] = await charged(stub, 1);
		expect(call).toMatchObject({ provider: "own:openai", input: 60, cacheRead: 40, output: 20 });
		// GPT-4.1 at $2, $8 and $0.50 per million.
		expect(call!.costUsd).toBeCloseTo((60 * 2 + 20 * 8 + 40 * 0.5) / 1_000_000, 12);
	});

	it("charges a JSON answer's usage, nothing for counting tokens, and a model the catalog doesn't know at the family's dearest price", async () => {
		const { stub } = await makeThread();
		const { token } = await stub.gatewayToken(["anthropic"]);
		const message = { id: "msg_2", type: "message", role: "assistant", model: "claude-mystery-9", content: [{ type: "text", text: "Hi" }], usage: { input_tokens: 1000, output_tokens: 1000 } };
		answer = (request) => (new URL(request.url).pathname.endsWith("/count_tokens") ? Response.json({ input_tokens: 77 }) : new Response(JSON.stringify(message), { headers: { "content-type": "application/json" } }));
		expect(await (await gateway("/anthropic/v1/messages/count_tokens", token, { body: { model: "claude-sonnet-4-5", messages: [] } })).json()).toEqual({ input_tokens: 77 });
		expect(await (await gateway("/anthropic/v1/messages", token, { body: { model: "claude-mystery-9", max_tokens: 10, messages: [] } })).json()).toEqual(message);
		const [call] = await charged(stub, 1);
		const dearest = Math.max(...getBuiltinModels("anthropic").map((model) => model.cost.output));
		expect(call).toMatchObject({ model: "claude-mystery-9", input: 1000, output: 1000, data: { pricing: "fallback" } });
		expect(call!.costUsd).toBeGreaterThanOrEqual((1000 * dearest) / 1_000_000);
		// A dated snapshot is priced as its model.
		expect((await gatewayPrice("openai", "gpt-5-2025-08-07")).model.id).toBe("gpt-5");
	});

	it("refuses a thread whose budget is spent, in each API's error shape", async () => {
		const { stub } = await makeThread({ budgetUsd: 0.01 });
		const { token } = await stub.gatewayToken(["anthropic", "openai"]);
		answer = () => streamed(ANTHROPIC_STREAM);
		const body = { model: "claude-sonnet-4-5", max_tokens: 10, stream: true, messages: [] };
		// Under budget when it starts, so it runs, and spends past it.
		expect((await (await gateway("/anthropic/v1/messages", token, { body })).text()).length).toBeGreaterThan(0);
		await charged(stub, 1);
		const anthropic = await gateway("/anthropic/v1/messages", token, { body });
		expect(anthropic.status).toBe(402);
		expect(await anthropic.json()).toEqual({ type: "error", error: { type: "billing_error", message: expect.stringMatching(/out of budget: spent \$0\.0125 of \$0\.01/) } });
		const openai = await gateway("/openai/v1/responses", token, { body: { model: "gpt-5", input: "Hi" } });
		expect(openai.status).toBe(402);
		expect(await openai.json()).toEqual({ error: { message: expect.stringMatching(/out of budget/), type: "insufficient_quota", param: null, code: "budget_exhausted" } });
		expect(sent).toHaveLength(1);
		// A bigger budget lets it go on.
		await runInDurableObject(stub, (thread: CodingThreadDO) => thread.store.update({ budgetUsd: 1 }));
		expect((await gateway("/anthropic/v1/messages", token, { body })).status).toBe(200);
	});

	it("caps a thread's concurrent requests and charges each of them once", async () => {
		const { stub } = await makeThread();
		const { token } = await stub.gatewayToken(["anthropic"]);
		codingGateway.limits = { concurrent: 3 };
		let finish!: () => void;
		const held = new Promise<void>((resolve) => {
			finish = resolve;
		});
		const bytes = encode(ANTHROPIC_STREAM);
		const cut = encode(ANTHROPIC_STREAM.slice(0, ANTHROPIC_STREAM.indexOf("event: message_delta"))).length;
		answer = () =>
			new Response(
				new ReadableStream({
					async start(controller) {
						controller.enqueue(bytes.slice(0, cut));
						await held;
						controller.enqueue(bytes.slice(cut));
						controller.close();
					},
				}),
				{ headers: { "content-type": "text/event-stream" } },
			);
		const body = { model: "claude-sonnet-4-5", max_tokens: 10, stream: true, messages: [] };
		const running = await Promise.all([1, 2, 3].map(() => gateway("/anthropic/v1/messages", token, { body })));
		expect(running.map((response) => response.status)).toEqual([200, 200, 200]);
		const fourth = await gateway("/anthropic/v1/messages", token, { body });
		expect(fourth.status).toBe(429);
		expect(fourth.headers.get("retry-after")).toBe("1");
		expect(await fourth.json()).toMatchObject({ error: { type: "rate_limit_error", message: expect.stringMatching(/3 model requests under way/) } });
		finish();
		const texts = await Promise.all(running.map((response) => response.text()));
		expect(texts).toEqual([ANTHROPIC_STREAM, ANTHROPIC_STREAM, ANTHROPIC_STREAM]);
		const calls = await charged(stub, 3);
		for (const call of calls) expect(call.costUsd).toBeCloseTo(ANTHROPIC_COST, 12);
		expect((await stub.status()).spentUsd).toBeCloseTo(3 * ANTHROPIC_COST, 12);
		// With them done, the next one runs.
		expect((await gateway("/anthropic/v1/messages", token, { body })).status).toBe(200);
	});

	it("caps a thread's requests per minute", async () => {
		const { stub } = await makeThread();
		const { token } = await stub.gatewayToken(["anthropic"]);
		codingGateway.limits = { requestsPerMinute: 2 };
		answer = () => Response.json({ input_tokens: 1 });
		const body = { model: "claude-sonnet-4-5", messages: [] };
		expect((await gateway("/anthropic/v1/messages/count_tokens", token, { body })).status).toBe(200);
		expect((await gateway("/anthropic/v1/messages/count_tokens", token, { body })).status).toBe(200);
		const third = await gateway("/anthropic/v1/messages/count_tokens", token, { body });
		expect(third.status).toBe(429);
		expect(Number(third.headers.get("retry-after"))).toBeGreaterThan(50);
		expect(await third.json()).toMatchObject({ error: { type: "rate_limit_error", message: expect.stringMatching(/2 model requests in the last minute/) } });
		expect(sent).toHaveLength(2);
	});

	it("never passes on the space's key, whatever the provider answers", async () => {
		const { stub } = await makeThread();
		const { token } = await stub.gatewayToken(["anthropic", "openai"]);
		const body = { model: "claude-sonnet-4-5", max_tokens: 10, messages: [] };
		const answers: Array<() => Response | Promise<Response>> = [
			// The provider refuses the key and repeats it.
			() => Response.json({ type: "error", error: { type: "authentication_error", message: `invalid x-api-key ${ANTHROPIC_KEY}` } }, { status: 401 }),
			() => Response.json({ error: { message: `Incorrect API key provided: ${OPENAI_KEY}` } }, { status: 403 }),
			// Another error that repeats it.
			() => Response.json({ type: "error", error: { type: "invalid_request_error", message: `bad request for ${ANTHROPIC_KEY}` } }, { status: 400, headers: { "set-cookie": `k=${ANTHROPIC_KEY}` } }),
			// A redirect, which isn't followed with the key.
			() => new Response(null, { status: 307, headers: { location: `https://evil.example/?key=${ANTHROPIC_KEY}` } }),
			// A failure whose error names it.
			() => Promise.reject(new Error(`connect failed with ${ANTHROPIC_KEY}`)),
			// A success whose headers name it.
			() => new Response(JSON.stringify({ usage: { input_tokens: 1, output_tokens: 1 } }), { headers: { "content-type": "application/json", "x-echo-key": ANTHROPIC_KEY } }),
		];
		const statuses: number[] = [];
		for (const next of answers) {
			answer = next;
			const response = await gateway("/anthropic/v1/messages", token, { body });
			statuses.push(response.status);
			const seen = `${JSON.stringify([...response.headers])}${await response.text()}`;
			for (const key of KEYS) expect(seen).not.toContain(key);
		}
		expect(statuses).toEqual([502, 502, 400, 502, 502, 200]);
		answer = answers[1]!;
		const openai = await gateway("/openai/v1/responses", token, { body: { model: "gpt-5", input: "Hi" } });
		expect(await openai.json()).toMatchObject({ error: { code: "upstream_refused_key", message: expect.stringMatching(/refused the space's openai key/) } });
		await charged(stub, 1);
		for (const key of KEYS) expect(await everything(stub)).not.toContain(key);
		// The provider had the key, and never the token.
		expect(sent.every((request) => !JSON.stringify(request).includes(token))).toBe(true);
	});

	it("refuses a thread whose space has no key for the family", async () => {
		const { stub } = await makeThread({ space: "o_nobody00000000000000000000" });
		const { token } = await stub.gatewayToken(["anthropic"]);
		const response = await gateway("/anthropic/v1/messages", token, { body: { model: "claude-sonnet-4-5", messages: [] } });
		expect(response.status).toBe(403);
		expect(await response.json()).toMatchObject({ type: "error", error: { type: "permission_error", message: expect.stringMatching(/no Anthropic key/) } });
		expect(sent).toHaveLength(0);
	});

	it("charges an answer the CLI cut short, estimating what it didn't report", async () => {
		const { stub } = await makeThread();
		const { token } = await stub.gatewayToken(["openai"]);
		const bytes = encode(RESPONSES_STREAM);
		let cancelled = false;
		// The provider goes on sending until it is told to stop.
		answer = () =>
			new Response(
				new ReadableStream({
					start(controller) {
						controller.enqueue(bytes.slice(0, 100));
					},
					async pull(controller) {
						await new Promise((resolve) => setTimeout(resolve, 10));
						controller.enqueue(encode(": keep-alive\n\n"));
					},
					cancel() {
						cancelled = true;
					},
				}),
				{ headers: { "content-type": "text/event-stream" } },
			);
		const response = await gateway("/openai/v1/responses", token, { body: { model: "gpt-5", input: "Hi", stream: true } });
		const reader = response.body!.getReader();
		expect((await reader.read()).value).toEqual(bytes.slice(0, 100));
		await reader.cancel();
		const [call] = await charged(stub, 1);
		expect(call).toMatchObject({ model: "gpt-5", data: { estimated: true } });
		expect(call!.output).toBeGreaterThanOrEqual(25);
		expect(call!.input).toBeGreaterThan(0);
		expect(call!.costUsd).toBeGreaterThan(0);
		await vi.waitFor(() => expect(cancelled).toBe(true));
	});

	it("gives up on a provider that stops sending, and frees the request's place", async () => {
		const { stub } = await makeThread();
		const { token } = await stub.gatewayToken(["anthropic"]);
		codingGateway.limits = { idleTimeoutMs: 100, concurrent: 1 };
		const bytes = encode(ANTHROPIC_STREAM);
		answer = () => new Response(new ReadableStream({ start: (controller) => controller.enqueue(bytes.slice(0, 400)) }), { headers: { "content-type": "text/event-stream" } });
		const response = await gateway("/anthropic/v1/messages", token, { body: { model: "claude-sonnet-4-5", stream: true, messages: [] } });
		// What the provider sent, then the Messages API's own error event.
		const text = await response.text();
		expect(text.startsWith(new TextDecoder().decode(bytes.slice(0, 400)))).toBe(true);
		expect(text.slice(400)).toMatch(/^event: error\ndata: \{"type":"error","error":\{"type":"api_error","message":"The model provider stopped sending/);
		// The input it reported is charged.
		const [call] = await charged(stub, 1);
		expect(call).toMatchObject({ input: 1200, cacheRead: 5000, cacheWrite: 300 });
		answer = () => streamed(ANTHROPIC_STREAM);
		expect((await gateway("/anthropic/v1/messages", token, { body: { model: "claude-sonnet-4-5", stream: true, messages: [] } })).status).toBe(200);
	});
});

describe("the usage meter", () => {
	const usageOf = (api: "anthropic-messages" | "openai-responses", text: string, cuts: number[]) => {
		const meter = new UsageMeter(api, true);
		const bytes = encode(text);
		let at = 0;
		for (const cut of [...cuts, bytes.length]) {
			meter.push(bytes.slice(at, cut));
			at = cut;
		}
		return meter.finish();
	};

	it("reads the same usage wherever the stream is split, with LF or CRLF line ends", () => {
		const cases = [
			["anthropic-messages", ANTHROPIC_STREAM, { input: 1200, output: 420, cacheRead: 5000, cacheWrite: 300 }, "claude-sonnet-4-5-20250929"],
			["openai-responses", RESPONSES_STREAM, { input: 500, output: 300, cacheRead: 1500, cacheWrite: 0 }, "gpt-5-2025-08-07"],
		] as const;
		for (const [api, text, usage, model] of cases) {
			for (const variant of [text, text.replaceAll("\n", "\r\n")]) {
				const length = encode(variant).length;
				for (let cut = 0; cut <= length; cut++) expect(usageOf(api, variant, [cut])).toEqual({ usage, model, bytes: length });
				expect(usageOf(api, variant, Array.from({ length: length - 1 }, (_, index) => index + 1))).toEqual({ usage, model, bytes: length });
			}
		}
	});

	it("reports no usage for a stream cut before it", () => {
		expect(usageOf("openai-responses", RESPONSES_STREAM.slice(0, RESPONSES_STREAM.indexOf("event: response.completed")), []).usage).toBeNull();
	});
});
