// The web app's chat-side routes over a real PostgreSQL and the real migrations: what each answers in the shape the app reads, that a person reaches
// only their own rows, and that a change made on a stale revision or an old ui-block version is refused.
import { randomBytes } from "node:crypto";
import { createServer, type Server } from "node:http";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { App } from "@pim/v2-app/app";
import { chatgptContext } from "@pim/v2-app/chatgpt";
import { KeyringCrypto, sealString } from "@pim/v2-app/crypto";
import { connect } from "@pim/v2-app/db";
import { createGate } from "@pim/v2-app/gate";
import { MemoryObjectStore } from "@pim/v2-app/objects";
import { planAnswer, NAME_CHAT, nameChatsFromFirstMessage } from "../src/compat/utility.ts";
import { webApproval } from "../src/compat/boot.ts";
import { chatRoutes } from "../src/compat/chat.ts";
import { apiClientRoutes, outcomeOf } from "../src/compat/api-clients.ts";
import { accountRoutes } from "../src/compat/chat-account.ts";
import { bootRoutes } from "../src/compat/boot.ts";
import { screenRoutes } from "../src/compat/admin-screens.ts";
import { diagnosticsRoutes } from "../src/compat/diagnostics.ts";
import { callsOf } from "../src/compat/activity.ts";
import { usageRoutes } from "../src/compat/usage.ts";
import { modelRoutes } from "../src/compat/model.ts";
import { snapshotRoutes } from "../src/gate-extras.ts";
import { uiBlockIds } from "@pim/ui-lang";
import { compareTraces, createFingerprinter } from "../src/request-fingerprint.ts";
import { createStack, type Stack } from "./support/stack.ts";

let stack: Stack;
let app: App;
let server: Server;
let base: string;
let ada: string;
let bob: string;
let agent: string;
let utility: Server;
const asked: any[] = [];
const auths: string[] = [];
const crypto = new KeyringCrypto("k1", { k1: new Uint8Array(randomBytes(32)) });

const call = async (token: string, method: string, path: string, body?: unknown, headers: Record<string, string> = {}) => {
	const response = await fetch(base + path, { method, headers: { authorization: `Bearer ${token}`, ...(typeof body === "object" ? { "content-type": "application/json" } : {}), ...headers }, ...(body === undefined ? {} : { body: typeof body === "string" ? body : JSON.stringify(body) }) });
	const text = await response.text();
	return { status: response.status, body: text.startsWith("{") ? JSON.parse(text) : text, headers: response.headers };
};

beforeAll(async () => {
	stack = await createStack();
	// A stand-in utility model: answers each side job the way a small model would, and records what it was asked.
	utility = createServer(async (req, res) => {
		let raw = "";
		for await (const chunk of req) raw += chunk;
		const body = JSON.parse(raw);
		asked.push(body);
		auths.push(String(req.headers.authorization));
		const responses = req.url?.endsWith("/responses");
		const system = String(responses ? (body.instructions ?? body.input?.[0]?.content) : body.messages[0].content);
		const content = system.includes("name chats") ? 'Title: "Fresh Garden Plan".' : system.includes("improve messages") ? "Plan my week in detail" : system.includes("suggest") ? 'Sure! {"messages":["Plan my week","Water the garden","Plan my week"]}' : "- They planned a garden";
		if (responses) {
			// The plan's Responses API, streamed as the plan requires.
			const sse = (event: string, data: unknown) => `event: ${event}\ndata: ${JSON.stringify({ type: event, ...(data as object) })}\n\n`;
			const msg = { id: "msg_1", type: "message", status: "completed", role: "assistant", content: [{ type: "output_text", text: content, annotations: [] }] };
			const response = { id: "resp_1", object: "response", status: "completed", model: body.model, output: [msg], usage: { input_tokens: 5, output_tokens: 3, total_tokens: 8, input_tokens_details: { cached_tokens: 0 }, output_tokens_details: { reasoning_tokens: 0 } } };
			res.writeHead(200, { "content-type": "text/event-stream" });
			res.end(
				sse("response.created", { response: { ...response, status: "in_progress", output: [] } }) +
					sse("response.output_item.added", { output_index: 0, item: { ...msg, status: "in_progress", content: [] } }) +
					sse("response.content_part.added", { item_id: "msg_1", output_index: 0, content_index: 0, part: { type: "output_text", text: "", annotations: [] } }) +
					sse("response.output_text.delta", { item_id: "msg_1", output_index: 0, content_index: 0, delta: content }) +
					sse("response.output_text.done", { item_id: "msg_1", output_index: 0, content_index: 0, text: content }) +
					sse("response.content_part.done", { item_id: "msg_1", output_index: 0, content_index: 0, part: msg.content[0] }) +
					sse("response.output_item.done", { output_index: 0, item: msg }) +
					sse("response.completed", { response }),
			);
			return;
		}
		res.setHeader("content-type", "application/json").end(JSON.stringify({ choices: [{ message: { content } }] }));
	});
	await new Promise<void>((resolve) => utility.listen(0, "127.0.0.1", resolve));
	const refresh = (async () => new Response(JSON.stringify({ access_token: "plan-access", refresh_token: "plan-refresh-2", expires_in: 3600 }), { headers: { "content-type": "application/json" } })) as typeof fetch;
	const gateway = { PIM_AI_GATEWAY_URL: `http://127.0.0.1:${(utility.address() as { port: number }).port}/v1`, PIM_AI_GATEWAY_MODELS: "u1,u2" };
	app = new App(connect(stack.url("gate"), 4), new MemoryObjectStore(), { crypto, chatgpt: { fetch: refresh, endpoints: { issuer: "http://issuer.test", modelsUrl: "", resource: gateway.PIM_AI_GATEWAY_URL } } }).limitSpaces();
	server = createGate(app, { first: [...modelRoutes(gateway), ...chatRoutes, ...snapshotRoutes(app.db.pool), ...usageRoutes(), ...apiClientRoutes(), ...diagnosticsRoutes({ PIM_PUBLIC_URL: "https://pim.example.test" })] });
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
	base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
	const claim = await app.identity.issueClaim("bootstrap", null, 3600_000);
	const a = await app.identity.register({ username: "ada", bootstrap: claim });
	ada = await app.identity.createSession(a.ownerId);
	await app.identity.setRegistrationOpen((await app.identity.authenticate(ada)) as never, true);
	const b = await app.identity.register({ username: "bob" });
	bob = await app.identity.createSession(b.ownerId);
	agent = (await call(ada, "POST", "/api/agents", { name: "Pim" })).body.id;
	process.env.PIM_AI_GATEWAY_URL = gateway.PIM_AI_GATEWAY_URL;
});
afterAll(async () => {
	server?.close();
	utility?.close();
	await app?.db.end();
	await stack?.drop();
});

describe("memory", () => {
	it("keeps lines in scopes, pages by cursor, and shows a person only their own", async () => {
		const scope = (await call(ada, "POST", "/api/memory/scopes", { name: "Work" })).body;
		expect(scope).toMatchObject({ kind: "named", name: "Work", count: 0 });
		for (const text of ["one", "two", "three"]) expect((await call(ada, "POST", "/api/memory/log", { text, scope: scope.key })).status).toBe(201);
		const first = (await call(ada, "GET", `/api/memory/log?limit=2&scope=${scope.key}`)).body.entries;
		expect(first.map((e: { text: string }) => e.text)).toEqual(["three", "two"]);
		const next = (await call(ada, "GET", `/api/memory/log?limit=2&scope=${scope.key}&before=${first[1].id}`)).body.entries;
		expect(next.map((e: { text: string }) => e.text)).toEqual(["one"]);
		expect((await call(ada, "POST", "/api/memory/log", { text: "x", scope: "nope" })).status).toBe(404);
		expect((await call(bob, "GET", "/api/memory/log")).body.entries).toEqual([]);
		expect((await call(bob, "PUT", `/api/memory/log/${first[0].id}`, { scope: "private" })).status).toBe(404);
		expect((await call(ada, "GET", "/api/memory")).body.scopes.find((s: { key: string }) => s.key === scope.key).count).toBe(3);
	});
});

describe("memory scopes of agents", () => {
	it("lets an agent read its own scope, the named scopes it was given and everyone, and no others", async () => {
		const owner = await ownerOf(ada);
		const as = (agentId: string) => ({ kind: "agent", ownerId: owner, agentId }) as never;
		const career = (await call(ada, "POST", "/api/memory/scopes", { name: "Career" })).body.key as string;
		const [reader, plain, majordomo] = (await Promise.all(["Reader", "Plain", "Groves"].map(async (name) => (await call(ada, "POST", "/api/agents", { name })).body.id as string))) as [string, string, string];
		expect((await call(ada, "PUT", `/api/agents/${reader}`, { memoryScopes: ["scope-missing"] })).status).toBe(400);
		expect((await call(ada, "PUT", `/api/agents/${reader}`, { memoryScopes: [career] })).body).toMatchObject({ memoryScope: `agent-${reader}`, memoryScopes: [career] });
		// A migrated majordomo keeps its own scope under another name, as v1's was `private`.
		await stack.admin.query("UPDATE pim_app.agents SET config = config || '{\"memoryScope\": \"private\"}' WHERE id = $1", [majordomo]);
		for (const [scope, title] of [[career, "Resume"], ["private", "Diary"], ["everyone", "Name"], [`agent-${plain}`, "Plain's"], [`agent-${reader}`, "Reader's"]]) await app.memories.remember(as(reader), scope!, title!, title!);
		const titles = new Set(["Resume", "Diary", "Name", "Plain's", "Reader's"]);
		const recalled = async (id: string) => (await app.memories.recall(as(id), (await app.agents.memoryOf(as(id), id)).reads, ".", 100)).map((m) => m.title).filter((t) => titles.has(t)).sort();
		expect(await recalled(reader)).toEqual(["Name", "Reader's", "Resume"]);
		expect(await recalled(plain)).toEqual(["Name", "Plain's"]);
		// The majordomo is the agent the person named, or else the one v1 marked as the default; it reads every scope and writes to its own.
		await stack.admin.query("UPDATE pim_app.agents SET config = config || '{\"legacy\": {\"isDefault\": true}}' WHERE id = $1", [majordomo]);
		expect(await recalled(majordomo)).toEqual(["Diary", "Name", "Plain's", "Reader's", "Resume"]);
		expect((await app.agents.memoryOf(as(majordomo), majordomo)).own).toBe("private");
		// A chat with no agent is answered by the majordomo, so it reads and writes as the majordomo does.
		expect((await app.agents.memoryOf(as("pim"), null)).own).toBe("private");
		// What the Runner shows an agent in its prompt follows the same scopes.
		const context = async (id: string | null) => {
			const chat = id ? (await call(ada, "POST", "/api/sessions", { agentId: id, title: "Scopes" })).body.id : null;
			const c = (await stack.admin.query("SELECT pim_app.runner_context($1, $2) AS c", [owner, chat])).rows[0].c;
			return { majordomo: c.agent.majordomo as boolean, titles: (c.memories as { title: string }[]).map((m) => m.title).filter((t) => titles.has(t)).sort() };
		};
		expect(await context(reader)).toEqual({ majordomo: false, titles: ["Name", "Reader's", "Resume"] });
		expect(await context(majordomo)).toEqual({ majordomo: true, titles: ["Diary", "Name", "Plain's", "Reader's", "Resume"] });
		expect(await context(null)).toMatchObject({ majordomo: true });
		// The memory screen lists who reads each scope, and deleting a named scope stops every agent reading it.
		const list = (await call(ada, "GET", "/api/memory")).body.scopes as { key: string; readers: string[] }[];
		expect(list.find((s) => s.key === career)!.readers.sort()).toEqual([majordomo, reader].sort());
		expect(list.find((s) => s.key === "private")!.readers).toEqual([majordomo]);
		expect(list.find((s) => s.key === `agent-${plain}`)!.readers.sort()).toEqual([majordomo, plain].sort());
		expect((await call(ada, "DELETE", `/api/memory/scopes/${career}`)).status).toBe(200);
		expect((await call(ada, "GET", `/api/agents/${reader}`)).body.memoryScopes).toEqual([]);
	});
});

describe("files", () => {
	it("lists folders from paths, honors conditional writes, and keeps to /workspace", async () => {
		expect((await call(ada, "PUT", "/api/files/content?path=/workspace/a/b.txt", "hello", { "content-type": "application/octet-stream" })).status).toBe(200);
		expect((await call(ada, "PUT", "/api/files/content?path=/workspace/a/b.txt", "again", { "if-none-match": "*" })).status).toBe(412);
		expect((await call(ada, "GET", "/api/files?path=/workspace")).body.entries).toMatchObject([{ name: "a", type: "directory" }]);
		expect((await call(ada, "GET", "/api/files/content?path=/workspace/a/b.txt")).body).toBe("hello");
		expect((await call(ada, "GET", "/api/files/content?path=/workspace/../etc/passwd")).status).toBe(400);
		expect((await call(bob, "GET", "/api/files/content?path=/workspace/a/b.txt")).status).toBe(404);
		expect((await call(ada, "DELETE", "/api/files?path=/workspace/a")).status).toBe(200);
		expect((await call(ada, "GET", "/api/files?path=/workspace")).body.entries).toEqual([]);
	});
});

describe("triggers", () => {
	it("changes only at the revision the person saw", async () => {
		const made = await call(ada, "POST", "/api/triggers", { label: "Daily", instruction: "Say hi", agentId: agent, source: { kind: "time", schedule: "cron", expression: "0 8 * * *", timeZone: "UTC" }, destination: { type: "new_chat" } });
		expect(made.status).toBe(201);
		const t = made.body;
		expect(t).toMatchObject({ lifecycle: "draft", agentId: agent, capability: { status: "available" }, grant: { required: false } });
		expect((await call(ada, "POST", `/api/triggers/${t.id}/resume`, {}, {})).status).toBe(428);
		expect((await call(ada, "PATCH", `/api/triggers/${t.id}`, { label: "x" }, { "if-match": '"1"' })).body).toMatchObject({ code: "revision_conflict", currentRevision: t.revision });
		const on = (await call(ada, "POST", `/api/triggers/${t.id}/resume`, {}, { "if-match": `"${t.revision}"` })).body;
		expect(on.lifecycle).toBe("enabled");
		// The stale revision no longer works, the new one does.
		expect((await call(ada, "POST", `/api/triggers/${t.id}/pause`, {}, { "if-match": `"${t.revision}"` })).status).toBe(409);
		expect((await call(ada, "PATCH", `/api/triggers/${t.id}`, { label: "Evening" }, { "if-match": `"${on.revision}"` })).body.label).toBe("Evening");
		expect((await call(bob, "GET", `/api/triggers/${t.id}`)).status).toBe(404);
		expect((await call(ada, "GET", "/api/triggers?lifecycle=enabled")).body.triggers).toHaveLength(1);
	});
});

describe("ui-block state", () => {
	it("is saved over the version last read and only as its block allows, and a submitted block stays as submitted", async () => {
		const { rows } = await stack.admin.query("SELECT owner_id FROM pim_app.accounts WHERE username = 'ada'");
		// The message holds one block, a slider; a block's state is kept only as its program allows.
		const source = '<slider name="v" min={0} max={9}/>\n<form id="f"><checkbox name="c"/></form>';
		const message = { id: "m1", role: "assistant", timestamp: 1, parts: [{ type: "tool-call", id: "c1", name: "send_to_user", arguments: { message: `Try:\n\`\`\`ui\n${source}\n\`\`\`` } }] };
		await stack.admin.query("INSERT INTO pim_projection.chat_transcript_projection (owner_id, stream_kind, chat_id, entry_id, position, message, partition_id, commit_seq, projection_version) VALUES ($1,'chat','c','m1',1,$2,'00000000-0000-0000-0000-000000000001',1,1)", [rows[0].owner_id, JSON.stringify(message)]);
		const block = uiBlockIds([source])[0]!;
		const put = (token: string, version: number, submitted = false, values: Record<string, number> = { v: version }) => call(token, "PUT", `/api/messages/m1/ui-state/${block}`, { version, state: { values }, submitted });
		// A block the message does not hold, a value its slider cannot take and a state over 32 KB are refused; a block with no form submitted is not submitted.
		expect((await call(ada, "PUT", "/api/messages/m1/ui-state/nope", { version: 0, state: { values: { v: 1 } } })).status).toBe(404);
		expect((await put(ada, 0, false, { v: 99 })).status).toBe(400);
		expect((await call(ada, "PUT", `/api/messages/m1/ui-state/${block}`, { version: 0, state: { values: { v: 1 }, junk: "x".repeat(40_000) } })).status).toBe(400);
		expect((await put(ada, 0, true)).status).toBe(400);
		expect((await put(ada, 0)).body).toMatchObject({ version: 1, submitted: false });
		expect((await put(ada, 0)).status).toBe(409);
		expect((await put(ada, 1)).body).toMatchObject({ version: 2, submitted: false });
		expect((await put(ada, 1)).status).toBe(409);
		expect((await call(ada, "GET", "/api/messages/m1/ui-state")).body.blocks[block]).toMatchObject({ version: 2, submitted: false, state: { values: { v: 1 } } });
		// A submitted form is kept as it was submitted, and the block can't be changed after it.
		const sent = { values: { v: 1 }, submitted: { f: { values: { "f.c": true }, graded: {} } } };
		expect((await call(ada, "PUT", `/api/messages/m1/ui-state/${block}`, { version: 2, state: sent, submitted: true })).body).toMatchObject({ version: 3, submitted: true });
		expect((await put(ada, 3)).status).toBe(409);
		expect((await put(bob, 0)).status).toBe(404);
	});
});

describe("chats and the account", () => {
	it("renames and deletes a chat, answers cost and tasks, and lists tokens without secrets", async () => {
		const chat = (await call(ada, "POST", "/api/sessions", { agentId: agent, title: "First" })).body.id as string;
		expect((await call(ada, "PUT", `/api/sessions/${chat}`, { title: "Second" })).body).toMatchObject({ id: chat, title: "Second" });
		expect((await call(ada, "GET", `/api/sessions/${chat}/cost`)).body).toEqual({ total: 0, cacheHitRatio: null, models: [], coding: [] });
		expect((await call(ada, "GET", `/api/sessions/${chat}/tasks`)).body).toEqual({ tasks: [] });
		expect((await call(bob, "GET", `/api/sessions/${chat}/cost`)).status).toBe(404);
		expect((await call(ada, "POST", "/api/prompts/improve", { text: "x" })).status).toBe(501);
		// What a chat's model calls cost is read from the ledger by the chat they were for, with the cache tiers and the calls of its tasks.
		const owner = await ownerOf(ada);
		await app.usage.record(owner, { id: "cc1", runKind: "chat", chatId: chat, provider: "gateway", model: "m", inputTokens: 1000, outputTokens: 200, cacheReadTokens: 800, cacheWriteTokens: 50, costMicroUsd: 12_000 });
		await app.usage.record(owner, { id: "cc2", runKind: "chat", chatId: chat, provider: "gateway", model: "m", inputTokens: 10, outputTokens: 20, costMicroUsd: 3_000 });
		const costed = (await call(ada, "GET", `/api/sessions/${chat}/cost`)).body;
		expect(costed).toEqual({ total: 0.015, cacheHitRatio: expect.closeTo(800 / 1860, 6), models: [{ provider: "gateway", model: "m", input: 1010, output: 220, cacheRead: 800, cacheWrite: 50, cost: 0.015 }], coding: [] });
		// The coding threads the chat started are a line of their own, by harness and model, and count toward the total. Recording a call again counts nothing more. A harness that reports no cache tiers
		// adds its spend but not its tokens to the hit rate, which would otherwise read them as a full miss.
		const amp = { runKind: "coding_thread" as const, chatId: chat, provider: "amp", model: "claude-opus-4-5", threadId: "T-1" };
		expect(await app.usage.record(owner, { ...amp, id: "cc3", inputTokens: 100, outputTokens: 10, cacheReadTokens: 900, costMicroUsd: 20_000 })).toBe(true);
		expect(await app.usage.record(owner, { ...amp, id: "cc3", inputTokens: 100, outputTokens: 10, cacheReadTokens: 900, costMicroUsd: 20_000 })).toBe(false);
		await app.usage.record(owner, { ...amp, id: "cc4", provider: "claude-code", model: "", threadId: "T-2", inputTokens: 5000, outputTokens: 50, costMicroUsd: 5_000 });
		await app.usage.record(owner, { ...amp, id: "cc5", model: "", threadId: "T-3", inputTokens: 0, outputTokens: 0, costMicroUsd: 1_000 });
		const withCoding = (await call(ada, "GET", `/api/sessions/${chat}/cost`)).body;
		expect(withCoding.total).toBeCloseTo(0.041, 9);
		expect(withCoding.cacheHitRatio).toBeCloseTo(1700 / (1110 + 1700 + 50), 6);
		expect(withCoding.models).toHaveLength(1);
		expect(withCoding.coding).toEqual([
			{ provider: "amp", harness: "amp", model: "claude-opus-4-5", threads: 1, input: 100, output: 10, cacheRead: 900, cacheWrite: 0, cost: 0.02 },
			{ provider: "claude-code", harness: "claude-code", model: "", threads: 1, input: 5000, output: 50, cacheRead: 0, cacheWrite: 0, cost: 0.005 },
			{ provider: "amp", harness: "amp", model: "", threads: 1, input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0.001 },
		]);
		// The history lists each call newest first, with the cache tiers and a hit rate that is null where the provider reported no cache; another person's chat is not reachable.
		await stack.admin.query("UPDATE pim_app.model_calls SET at = now() - interval '1 minute' WHERE id = 'cc1'");
		const history = (await call(ada, "GET", `/api/sessions/${chat}/turns`)).body.turns;
		expect(history.map((t: { id: string }) => t.id)).toEqual(["cc4", "cc3", "cc2", "cc1"]);
		expect(history[2]).toMatchObject({ input: 10, output: 20, cacheRead: 0, cacheWrite: 0, hitRatio: null, cost: 0.003 });
		expect(history[3]).toMatchObject({ input: 1000, cacheRead: 800, cacheWrite: 50, hitRatio: expect.closeTo(800 / 1850, 6) });
		expect((await call(bob, "GET", `/api/sessions/${chat}/turns`)).status).toBe(404);
		// A chat's activity is its latest turn, read from its transcript: calls the ledger has and the transcript has not are no steps of it.
		expect((await call(ada, "GET", `/api/sessions/${chat}/activity`)).body).toMatchObject({ running: false, steps: [], current: [], stalls: [] });
		await stack.admin.query("DELETE FROM pim_app.model_calls WHERE id IN ('cc1', 'cc2', 'cc3', 'cc4', 'cc5')");
		expect((await call(ada, "DELETE", `/api/sessions/${chat}`)).body).toEqual({ deleted: true });
		expect((await call(ada, "GET", `/api/sessions/${chat}/summary`)).status).toBe(404);
		const token = (await call(ada, "POST", "/auth/tokens", { name: "cli" })).body;
		const listed = (await call(ada, "GET", "/auth/tokens")).body.tokens;
		expect(listed).toMatchObject([{ id: token.id, name: "cli" }]);
		expect(JSON.stringify(listed)).not.toContain(token.token);
		expect((await call(ada, "GET", "/api/email")).body).toEqual({ available: false, address: null, pending: null });
	});
});

describe("usage and per-space limits", () => {
	it("meters runs, refuses past the admin's limit for one person, and shows the day in the shape the usage screens read", async () => {
		const set = (limits: unknown) => call(ada, "PUT", "/api/admin/accounts/bob/limits", { limits });
		expect((await set({ dailyRuns: 1, sessions: 2 })).body.limits).toMatchObject({ dailyRuns: 1, sessions: 2, schedules: null });
		expect((await set({ dailyRuns: -1 })).status).toBe(400);
		expect((await call(bob, "PUT", "/api/admin/accounts/bob/limits", { limits: null })).status).toBe(403);
		const chat = (await call(bob, "POST", "/api/sessions", { title: "one" })).body.id as string;
		const send = (commandId: string) => call(bob, "POST", `/api/sessions/${chat}/messages`, { commandId, text: "hi" });
		expect((await send("u1")).status).toBe(202);
		expect((await send("u1")).status).toBe(200); // a retry of an accepted command is not a second run
		const refused = await send("u2");
		expect(refused).toMatchObject({ status: 429, body: { error: "quota_exceeded" } });
		expect(refused.body.message).toMatch(/^Space usage quota exceeded:/);
		expect((await call(bob, "POST", "/api/sessions", {})).status).toBe(201);
		expect((await call(bob, "POST", "/api/sessions", {})).status).toBe(429);
		const usage = (await call(bob, "GET", "/api/usage")).body;
		expect(usage.limits.dailyRuns).toBe(1);
		expect(usage.today).toMatchObject({ runs: 1, toolCalls: 0, tokens: 0 });
		// Back to the deployment's: nothing set means no limit here, and the admin never had one.
		expect((await set(null)).body.limits.dailyRuns).toBeNull();
		expect((await call(ada, "GET", "/api/usage")).body.limits.dailyRuns).toBeNull();
	});

	it("sets the deployment's and one person's compute quota over Forge's, and shows the person the one that applies and what they used", async () => {
		expect((await call(ada, "PUT", "/api/admin/compute/quota", { quota: { maxConcurrentWorkspaces: 3, monthlySandboxMinutes: 600 } })).body.quota).toEqual({ maxConcurrentWorkspaces: 3, monthlySandboxMinutes: 600, maxSessionMinutes: null });
		expect((await call(ada, "PUT", "/api/admin/accounts/bob/compute-quota", { quota: { monthlySandboxMinutes: 30 } })).body.quota).toMatchObject({ monthlySandboxMinutes: 30 });
		// The longest session is kept and shown too; it is the number of minutes a workspace may run from its start.
		expect((await call(ada, "PUT", "/api/admin/compute/quota", { quota: { maxConcurrentWorkspaces: 3, monthlySandboxMinutes: 600, maxSessionMinutes: 10 } })).body.quota).toEqual({ maxConcurrentWorkspaces: 3, monthlySandboxMinutes: 600, maxSessionMinutes: 10 });
		expect((await call(ada, "PUT", "/api/admin/compute/quota", { quota: { maxSessionMinutes: -1 } })).status).toBe(400);
		expect((await call(bob, "PUT", "/api/admin/compute/quota", { quota: null })).status).toBe(403);
		const owner = await ownerOf(bob);
		await app.db.owner(owner, (tx) => tx.query("INSERT INTO pim_forge.forge_compute_usage (owner_id, thread_id, provider, began_at, ended_at) VALUES ($1, 't', 'e2b', now() - interval '90 minutes', now() - interval '30 minutes')", [owner]));
		const compute = (await call(bob, "GET", "/api/usage")).body.compute;
		// Bob's own number wins for minutes; the deployment's holds for what he has none of.
		expect(compute).toMatchObject({ quota: { maxConcurrentWorkspaces: 3, monthlySandboxMinutes: 30, maxSessionMinutes: 10 }, own: { monthlySandboxMinutes: 30 }, usage: { minutes: 60, running: 0, byProvider: [{ provider: "e2b", minutes: 60 }] } });
		expect((await call(ada, "PUT", "/api/admin/accounts/bob/compute-quota", { quota: null })).body.quota).toEqual({ maxConcurrentWorkspaces: null, monthlySandboxMinutes: null, maxSessionMinutes: null });
		// A stretch that crosses midnight on the 1st counts toward each month by when it ran, in the person's report.
		const midnight = new Date(Date.UTC(new Date().getUTCFullYear(), new Date().getUTCMonth(), 1));
		await app.db.owner(owner, (tx) => tx.query("DELETE FROM pim_forge.forge_compute_usage WHERE owner_id = $1", [owner]));
		await app.db.owner(owner, (tx) => tx.query("INSERT INTO pim_forge.forge_compute_usage (owner_id, thread_id, provider, began_at, ended_at) VALUES ($1, 'm', 'e2b', $2, $3)", [owner, new Date(midnight.getTime() - 40 * 60_000), new Date(midnight.getTime() + 20 * 60_000)]));
		const split = (await call(bob, "GET", "/api/usage")).body.compute.usage;
		const last = new Date(midnight.getTime() - 1).toISOString().slice(0, 7);
		expect(split).toMatchObject({ minutes: 20, history: expect.arrayContaining([{ month: last, minutes: 40 }, { month: midnight.toISOString().slice(0, 7), minutes: 20 }]) });
	});

	it("reports what calls cost in the cost report's shape, with the ledger's cost in dollars", async () => {
		await app.usage.record(await ownerOf(ada), { id: "mc1", runKind: "chat", provider: "gateway", model: "m", inputTokens: 1000, outputTokens: 2000, costMicroUsd: 30_000 });
		await app.usage.record(await ownerOf(ada), { id: "mc2", runKind: "background", provider: "gateway", model: "free", inputTokens: 10, outputTokens: 20, costMicroUsd: 0 });
		const report = (await call(ada, "GET", "/api/usage/costs?days=7")).body;
		expect(report).toMatchObject({ days: 7, totalCostUsd: 0.03, calls: 2, unpricedCalls: 1, errors: 0, costPer1kOutputTokens: expect.closeTo(0.0149, 3) });
		expect(report.byDay).toHaveLength(1);
		expect(report.byDay[0].byRunKind).toEqual([{ key: "chat", costUsd: 0.03 }, { key: "background", costUsd: 0 }]);
		expect(report.byDay[0].byModel.map((m: { key: string }) => m.key)).toEqual(["gateway/m", "gateway/free"]);
		expect((await call(bob, "GET", "/api/usage/costs")).body.calls).toBe(0);

		// What the ledger keeps of how calls went: the cache's share of what was read, calls that failed, how deep a chat's turns went and how large its requests were, a coding thread's own calls, and what a call was for.
		const owner = await ownerOf(ada);
		const chat = (await call(ada, "POST", "/api/sessions", { agentId: agent, title: "Costly" })).body.id as string;
		await app.usage.record(owner, { id: "mc3", runKind: "scheduled", chatId: chat, provider: "gateway", model: "m", inputTokens: 1000, outputTokens: 100, cacheReadTokens: 1000, costMicroUsd: 10_000 });
		await app.usage.record(owner, { id: "mc4", runKind: "scheduled", chatId: chat, provider: "gateway", model: "m", inputTokens: 0, outputTokens: 0, costMicroUsd: 0 });
		await app.usage.record(owner, { id: "mc5", runKind: "coding_thread", threadId: "th1", inputTokens: 500, outputTokens: 50, costMicroUsd: 20_000 });
		await stack.admin.query("UPDATE pim_app.model_calls SET stop_reason = 'stop', turn_index = 5, prompt_bytes = 300 WHERE id = 'mc3'");
		await stack.admin.query("UPDATE pim_app.model_calls SET stop_reason = 'error', turn_index = 2 WHERE id = 'mc4'");
		const more = (await call(ada, "GET", "/api/usage/costs?days=7")).body;
		expect(more).toMatchObject({ calls: 5, errors: 1, totalCostUsd: expect.closeTo(0.06, 6) });
		expect(more.cacheHitRatio).toBeCloseTo(1000 / (1000 + 10 + 1000 + 500 + 1000), 6);
		expect(more.byDay[0].cacheHitRatio).toBeCloseTo(more.cacheHitRatio, 6);
		expect(more.byDay[0].byRunKind.map((k: { key: string }) => k.key).sort()).toEqual(["background", "chat", "coding_thread", "scheduled"]);
		expect(more.topChats).toEqual([expect.objectContaining({ id: chat, calls: 2, turns: 5, avgPromptBytes: 300 })]);
		expect(more.topCodingThreads).toEqual([{ id: "th1", costUsd: 0.02, calls: 1, turns: 0, avgPromptBytes: 0 }]);
	});
});

const ownerOf = async (token: string) => (await app.identity.authenticate(token))!.ownerId;

describe("the API's clients", () => {
	it("takes a message as { content, operationId } once, tells how it went, and keeps to the owner", async () => {
		const chat = (await call(ada, "POST", "/api/sessions", { title: "api" })).body.id as string;
		const first = await call(ada, "POST", `/api/sessions/${chat}/messages`, { content: [{ type: "text", text: "from a client" }], operationId: "op-1" });
		expect(first).toMatchObject({ status: 202, body: { operationId: "op-1", session: chat, state: "inbox_accepted", duplicate: false } });
		expect((await call(ada, "POST", `/api/sessions/${chat}/messages`, { content: "something else", operationId: "op-1" })).status).toBe(409); // another message under the same id
		expect((await call(ada, "POST", `/api/sessions/${chat}/messages`, { content: [{ type: "text", text: "from a client" }], operationId: "op-1" })).status).toBe(200);
		expect((await call(ada, "POST", `/api/sessions/${chat}/messages`, { content: "  " })).status).toBe(400);
		expect((await call(ada, "GET", `/api/sessions/${chat}/operations/op-1?timeout=100`)).body).toMatchObject({ status: "pending", session: chat });
		expect((await call(ada, "GET", `/api/sessions/${chat}/operations/nope`)).status).toBe(404);
		expect((await call(ada, "GET", `/api/sessions/${chat}/messages`)).body).toMatchObject({ session: chat, busy: true, pending: ["op-1"], messages: [] });
		expect((await call(bob, "GET", `/api/sessions/${chat}/messages`)).status).toBe(404);
		const root = (await call(ada, "GET", "/api")).body;
		expect(root).toMatchObject({ timeZone: expect.any(String) });
		const tools = new Map((root.tools as { name: string; requiresApproval: boolean }[]).map((t) => [t.name, t.requiresApproval]));
		expect([tools.get("connector_call"), tools.get("note"), tools.has("fetch_url")]).toEqual([true, false, true]);
		expect((await call(ada, "GET", "/api/health")).body).toEqual({ name: "pim", ok: true });
		// The export carries each chat with its messages, the settings, approvals and the days of usage, and only the person's own.
		const exported = (await call(ada, "GET", "/api/export")).body;
		expect(exported.chats.find((c: { id: string }) => c.id === chat)).toMatchObject({ title: "api", messages: [] });
		expect(Object.keys(exported)).toEqual(expect.arrayContaining(["settings", "approvals", "permissions", "usage"]));
		expect((await call(bob, "GET", "/api/export")).body.chats.some((c: { id: string }) => c.id === chat)).toBe(false);
	});

	it("holds a message sent with wait until its turn ends and answers what the agent sent, and long-polls an operation the same way", async () => {
		const chat = (await call(ada, "POST", "/api/sessions", { title: "waiting" })).body.id as string;
		const owner = await ownerOf(ada);
		const partition = (await stack.admin.query("SELECT partition_id FROM pim_app.conversations WHERE public_chat_id = $1", [chat])).rows[0].partition_id;
		let position = 0;
		const project = async (message: object, partial = false) => {
			position++;
			await stack.admin.query("INSERT INTO pim_projection.chat_transcript_projection (owner_id, stream_kind, chat_id, entry_id, position, partial, message, partition_id, commit_seq, projection_version) VALUES ($1,'chat',$2,$3,$4,$5,$6,$7,$4,1)", [owner, chat, `e${position}`, position, partial, JSON.stringify({ id: `e${position}`, ...message }), partition]);
		};
		const at = Date.now() + 60_000;
		const send = (id: string, message: string, extra = {}) => ({ role: "assistant", timestamp: at, stopReason: "toolUse", parts: [{ type: "thinking", text: "secret thoughts" }, { type: "tool-call", id, name: "send_to_user", arguments: { message, ...extra } }] });
		const answered = (id: string, text = "Sent.") => ({ role: "tool", timestamp: at, parts: [{ type: "tool-result", id, name: "send_to_user", content: [{ type: "text", text }], error: false }] });
		await project({ role: "user", timestamp: at, parts: [{ type: "text", text: "hi" }] });
		// The turn is still going: the answer is pending.
		await project(send("c0", "Not yet."), true);
		process.env.PIM_API_WAIT_MS = "300";
		const held = await call(ada, "POST", `/api/sessions/${chat}/messages`, { content: "hi", operationId: "w-0", wait: true });
		expect(held.status).toBe(200);
		expect(held.body).toMatchObject({ operationId: "w-0", status: "pending", replies: [] });
		// It ends with a send the person read, one that went to their inbox, and a refused one; only the first is a reply.
		await stack.admin.query("DELETE FROM pim_projection.chat_transcript_projection WHERE chat_id = $1 AND partial", [chat]);
		await project(send("c1", "Lisbon it is."));
		await project(answered("c1"));
		await project(send("c2", "An email.", { channel: "email" }));
		await project(answered("c2"));
		await project({ role: "assistant", timestamp: at, stopReason: "stop", parts: [{ type: "text", text: "Done." }] });
		const done = await call(ada, "POST", `/api/sessions/${chat}/messages`, { content: "again", operationId: "w-1", wait: true });
		expect(done.body).toEqual({ operationId: "w-1", session: chat, status: "done", replies: ["Lisbon it is."], text: "Lisbon it is." });
		expect(JSON.stringify(done.body)).not.toContain("secret thoughts");
		expect((await call(ada, "GET", `/api/sessions/${chat}/operations/w-1?timeout=100`)).body).toMatchObject({ status: "done", replies: ["Lisbon it is."] });
		// Stopping by the operation's id answers as the app's Stop does.
		expect((await call(ada, "POST", `/api/sessions/${chat}/abort`, { operationId: "w-1" })).body).toMatchObject({ aborted: true });
	});

	it("counts a turn as ended when its reply closed it, though no answer from the model follows", () => {
		// A reply ends the turn (the agent asks the model nothing more), so the newest message is the send's own result; `complete: false` keeps the turn going.
		const turn = (complete?: boolean) => [
			{ role: "user", timestamp: 1, parts: [{ type: "text", text: "hi" }] },
			{ role: "assistant", timestamp: 2, stopReason: "toolUse", parts: [{ type: "tool-call", id: "c1", name: "send_to_user", arguments: { message: "Hello.", ...(complete === undefined ? {} : { complete }) } }] },
			{ role: "tool", timestamp: 3, parts: [{ type: "tool-result", id: "c1", name: "send_to_user", content: [{ type: "text", text: "Sent." }], error: false }] },
		] as never;
		expect(outcomeOf(turn(), 0)).toEqual({ status: "done", replies: ["Hello."], text: "Hello." });
		expect(outcomeOf(turn(false), 0)).toBeNull();
		// What the chat told of a model asked again, which a request that answered with nothing leaves as its newest message, does not make the turn look unfinished.
		const told = { role: "notice", timestamp: 4, parts: [], notices: [{ kind: "retry", model: "a" }] };
		expect(outcomeOf([...turn(), told] as never, 0)).toEqual({ status: "done", replies: ["Hello."], text: "Hello." });
	});

	it("shows one trigger run by its id, and no other person's", async () => {
		const made = (await call(ada, "POST", "/api/triggers", { label: "Runs", instruction: "go", agentId: agent, source: { kind: "time", schedule: "cron", expression: "0 8 * * *", timeZone: "UTC" }, destination: { type: "new_chat" } })).body;
		const owner = await ownerOf(ada);
		await app.db.owner(owner, (tx) => tx.query("INSERT INTO pim_app.trigger_runs (id, owner_id, trigger_id, phase, detail) VALUES ('tr1', $1, $2, 'fired', '{\"scheduledFor\": 1000}')", [owner, made.id]));
		expect((await call(ada, "GET", "/api/trigger-runs/tr1")).body).toMatchObject({ id: "tr1", triggerId: made.id, phase: "fired", dueAt: 1000, evidence: { reason: "time", scheduledFor: 1000 } });
		expect((await call(bob, "GET", "/api/trigger-runs/tr1")).status).toBe(404);
	});

	it("shows a delivered run's chat and how it ended, a waiting one as pending, and the trigger's health", async () => {
		const made = (await call(ada, "POST", "/api/triggers", { label: "Stream", instruction: "go", agentId: agent, source: { kind: "stream", command: "tail -f x" }, condition: { when: { op: "exists", path: ["n"] } }, destination: { type: "new_chat" } })).body;
		const owner = await ownerOf(ada);
		await app.db.owner(owner, (tx) => tx.query("UPDATE pim_app.triggers SET lifecycle = 'enabled', health = 'gap', health_detail = 'lost_lines', last_observed_at = now(), failures = 2 WHERE id = $1", [made.id]));
		const first = await app.triggers.fireOccurrence(owner, made.id, "computer:a", { source: "stream" });
		const second = await app.triggers.fireOccurrence(owner, made.id, "computer:b", { source: "stream" });
		expect([first, second]).toEqual(["fired", "queued"]);
		const runs = async () => (await call(ada, "GET", `/api/triggers/${made.id}/runs`)).body.runs as { id: string; state: string; outcomeKnown: boolean; chatId: string | null; occurrenceStatus: string }[];
		const byEvent = (all: Awaited<ReturnType<typeof runs>>, event: string) => all.find((r) => r.id.endsWith(`:${event}`))!;
		// Handed to a chat it is queued, linked to that chat; the one behind it waits, with no chat yet.
		expect(byEvent(await runs(), "computer:a")).toMatchObject({ state: "queued", outcomeKnown: false, chatId: expect.any(String) });
		expect(byEvent(await runs(), "computer:b")).toMatchObject({ state: "pending", occurrenceStatus: "pending", chatId: null });
		// Once its command is taken and its chat is idle the run is completed, and says it is over.
		await app.db.owner(owner, (tx) => tx.query("UPDATE pim_app.accepted_commands SET state = 'runtime_committed', committed_at = now() - interval '1 minute' WHERE command_id LIKE $1", [`trigger:${made.id}:computer:a`]));
		const done = byEvent(await runs(), "computer:a");
		expect(done).toMatchObject({ state: "completed", outcomeKnown: true, chatId: expect.any(String), occurrenceStatus: "delivered" });
		expect((await call(ada, "GET", `/api/trigger-runs/${done.id}`)).body).toMatchObject({ state: "completed", chatId: done.chatId });
		// What the source did lately is on the trigger, as health, for the screen and the agent; with no computer paired it is waiting for one.
		expect((await call(ada, "GET", `/api/triggers/${made.id}`)).body).toMatchObject({ health: "waiting_computer", observation: { failures: 2, lastObservedAt: expect.any(Number) } });
		await app.db.owner(owner, (tx) => tx.query("INSERT INTO pim_app.computers (id, owner_id, name, protocol) VALUES ('pc1', $1, 'Laptop', 2)", [owner]));
		expect((await call(ada, "GET", `/api/triggers/${made.id}`)).body).toMatchObject({ health: "gap", healthDetail: "lost_lines" });
		await app.db.owner(owner, (tx) => tx.query("DELETE FROM pim_app.computers WHERE id = 'pc1'"));
	});
});

describe("diagnostics", () => {
	it("gives an admin bounded, scrubbed reads of their own space by kind, and refuses a member", async () => {
		const owner = await ownerOf(ada);
		const made = (await call(ada, "POST", "/api/triggers", { label: "Broken", instruction: "go", agentId: agent, source: { kind: "time", schedule: "cron", expression: "0 8 * * *", timeZone: "UTC" }, destination: { type: "new_chat" } })).body;
		await app.db.owner(owner, (tx) => tx.query("INSERT INTO pim_app.trigger_runs (id, owner_id, trigger_id, phase, detail) VALUES ('trd', $1, $2, 'failed', $3)", [owner, made.id, JSON.stringify({ message: "POST https://hooks.example.test/x?key=1 failed for ada@example.test with Bearer abcdefghijklmnop", apiKey: "hunter2" })]));
		const triggers = (await call(ada, "GET", "/api/admin/diagnostics?kind=triggers")).body;
		expect(triggers.failures).toHaveLength(1);
		const text = JSON.stringify(triggers);
		expect(text).toContain("[address]/x");
		expect(text).toContain("[email]");
		expect(text).not.toMatch(/hooks\.example|ada@example|abcdefghijklmnop|hunter2/);
		expect(triggers.failures[0].detail.apiKey).toBe("[redacted]");
		expect((await call(ada, "GET", "/api/admin/diagnostics")).body.counts).toMatchObject({ chats: expect.any(Number), waiting_approvals: 0 });
		expect((await call(ada, "GET", "/api/admin/diagnostics?kind=provider_cooldowns")).body).toMatchObject({ count: 0, items: [] });
		expect((await call(ada, "GET", "/api/admin/diagnostics?kind=nope")).status).toBe(400);
		expect((await call(ada, "GET", "/api/admin/diagnostics?since=soon")).status).toBe(400);
		expect((await call(bob, "GET", "/api/admin/diagnostics")).status).toBe(403);
		expect((await call(ada, "GET", "/api/admin/health")).body.deployment).toMatchObject({ publicUrlSet: true, approvalPolicy: "majordomo" });
	});

	it("keeps the cache trace of every call, and compares a chat's consecutive calls from them without saying what was asked", async () => {
		const owner = await ownerOf(ada);
		const chat = (await call(ada, "POST", "/api/sessions", { agentId: agent, title: "Cache" })).body.id as string;
		const fingerprint = createFingerprinter({ PIM_INGRESS_SECRET: "s" }, owner);
		const history = [{ role: "user", content: "a private question" }, { role: "assistant", content: [{ type: "text", text: "a private answer" }] }];
		const body = (messages: unknown[], marked: number) => ({ model: "m", system: [{ type: "text", text: "You are Pim.", cache_control: { type: "ephemeral" } }], messages: messages.map((m: any, i) => (i === marked ? { ...m, content: [{ type: "text", text: typeof m.content === "string" ? m.content : "x", cache_control: { type: "ephemeral" } }] } : m)) });
		// The second call adds a tool round before the context update that ended the first.
		const update = { role: "user", content: "[Context update] changed" };
		const one = fingerprint(body([...history, update], 2))!;
		const two = fingerprint(body([...history, { role: "assistant", content: "more" }, { role: "user", content: "result" }, update], 4))!;
		const record = (id: string, trace: unknown, tokens: [number, number], at: number) =>
			stack.admin.query("SELECT pim_app.record_model_call($1, $2, 'chat', $3, 'anthropic', 'm', $4, 5, 0, $5, $6, NULL, $7::jsonb)", [owner, id, chat, 4, tokens[0], tokens[1], JSON.stringify({ stopReason: "stop", latencyMs: 20, cacheTrace: trace })]).then(() => stack.admin.query("UPDATE pim_app.model_calls SET at = to_timestamp($2) WHERE id = $1", [id, at]));
		await record("mc_cache_1", one, [60_000, 400_000], 1_900_000_000);
		await record("mc_cache_2", two, [60_000, 401_500], 1_900_000_010);
		// A call with no trace (a background one) is a row all the same, and a failed attempt's trace is kept under its own row.
		await record("mc_cache_2_f0", one, [0, 0], 1_900_000_005);
		await stack.admin.query("SELECT pim_app.record_model_call($1, 'mc_cache_none', 'chat', $2, 'anthropic', 'm', 1, 1, 0)", [owner, chat]);
		expect((await stack.admin.query("SELECT id, cache_trace IS NOT NULL AS traced FROM pim_app.model_calls WHERE public_chat_id = $1 ORDER BY id", [chat])).rows).toEqual([
			{ id: "mc_cache_1", traced: true },
			{ id: "mc_cache_2", traced: true },
			{ id: "mc_cache_2_f0", traced: true },
			{ id: "mc_cache_none", traced: false },
		]);
		// Another person's ledger holds none of it.
		expect((await app.db.owner(await ownerOf(bob), (tx) => tx.query("SELECT count(*)::int AS n FROM pim_app.model_calls WHERE cache_trace IS NOT NULL"))).rows[0].n).toBe(0);

		const report = (await call(ada, "GET", `/api/admin/diagnostics?kind=prompt_cache&chat=${chat}&since=${new Date(1_800_000_000_000).toISOString()}`)).body;
		expect(report.items).toHaveLength(2);
		expect(report.items[0]).toMatchObject({ cache_read_tokens: 60_000, cache_write_tokens: 400_000, trace: { counts: { messages: 3 } } });
		expect(report.items[0]).not.toHaveProperty("since_previous");
		expect(report.items[1]).toMatchObject({ cache_write_tokens: 401_500, since_previous: compareTraces(one, two), previous_model_differs: false });
		// The comparison says what happened: the history is shared up to the update, and the breakpoint on the update is not in the later call.
		expect(report.items[1].since_previous).toMatchObject({ firstChange: "messages", sharedMessages: 2, breakpoints: [{ in: "system", stillThere: true }, { in: "messages", index: 2, stillThere: false }] });
		const text = JSON.stringify(report);
		expect(text).not.toMatch(/private|Pim\b|Context update/);
		expect(text).toContain(one.messages);
		expect((await call(ada, "GET", "/api/admin/diagnostics?kind=prompt_cache")).status).toBe(400);
		expect((await call(bob, "GET", `/api/admin/diagnostics?kind=prompt_cache&chat=${chat}`)).status).toBe(403);
	});
});

describe("a chat's activity and the diagnostics of how its turns went", () => {
	it("shows the latest turn step by step with durations, what is running now and what has gone quiet, and reads the ledger's failures, the event log and the cooldowns", async () => {
		const owner = await ownerOf(ada);
		const chat = (await call(ada, "POST", "/api/sessions", { agentId: agent, title: "Slow" })).body.id as string;
		const at = Date.now();
		const seed = (n: number, message: unknown) => stack.admin.query("INSERT INTO pim_projection.chat_transcript_projection (owner_id, stream_kind, chat_id, entry_id, position, message, partition_id, commit_seq, projection_version) VALUES ($1,'chat',$2,$3,$4,$5,'00000000-0000-0000-0000-000000000001',$4,1)", [owner, chat, `e${n}`, n, JSON.stringify({ id: `e${n}`, ...(message as object) })]);
		// A turn that began 20 minutes ago: the model answered in 3 s with two tool calls; one ran for 4 s and ended, the other has been running since and waits for nothing.
		const started = at - 20 * 60_000;
		await seed(1, { role: "user", timestamp: started, parts: [{ type: "text", text: "Run the long job" }] });
		await seed(2, { role: "assistant", timestamp: started + 1_000, stopReason: "toolUse", parts: [{ type: "tool-call", id: "call-a", name: "http_request", arguments: { url: "https://example.test/a?token=abc", timeout: 30 } }, { type: "tool-call", id: "call-b", name: "shell", arguments: { command: "make all", timeout: 3600 } }] });
		await seed(3, { role: "tool", timestamp: started + 8_000, parts: [{ type: "tool-result", id: "call-a", name: "http_request", content: [{ type: "text", text: "ok" }], error: false }] });
		await stack.admin.query("INSERT INTO pim_projection.sidebar_session_projection (owner_id, chat_id, title, busy, unread, stalled, updated_at, partition_id, commit_seq, projection_version) VALUES ($1,$2,'Slow',true,false,false,$3,'00000000-0000-0000-0000-000000000001',1,1)", [owner, chat, at]);
		// What the ledger knows of the model call (its id ends with the answer's time), a call that failed over to it, and a failed one with the provider's words.
		const call1 = (id: string, extra: Record<string, unknown>) => stack.admin.query("SELECT pim_app.record_model_call($1, $2, 'chat', $3, 'gw', 'm1', 10, 5, 0, 0, 0, NULL, $4::jsonb)", [owner, id, chat, JSON.stringify(extra)]);
		await call1(`mc_c1_t1_${started + 1_000}`, { stopReason: "toolUse", latencyMs: 3_000, turnIndex: 1, toolCount: 4, promptBytes: 2_000, runKind: "chat" });
		// Its attempt ran in the second before the answered request began, as the turn shows it.
		await call1(`mc_c1_t1_${started + 1_000}_f0`, { stopReason: "error", latencyMs: 900, error: "529 overloaded at https://gw.example.test/v1/messages for ada@example.test with max_tokens", request: { phases: { headersMs: 900, httpAttempts: 1 } }, runKind: "chat" });
		// They happened when the turn did.
		await stack.admin.query("UPDATE pim_app.model_calls SET at = to_timestamp(($2::bigint + latency_ms) / 1000.0) WHERE owner_id = $1 AND public_chat_id = $3", [owner, started + 1_000, chat]);
		await app.db.owner(owner, (tx) => tx.query("SELECT pim_app.record_diagnostic_event($1, 'model_call_failed', $2)", [owner, JSON.stringify({ provider: "gw", model: "m1", error: "529 overloaded" })]));
		await stack.admin.query("INSERT INTO pim_runtime.provider_cooldowns (owner_id, ref, until, reason) VALUES ($1, 'gw/m1', now() + interval '1 minute', 'overloaded')", [owner]);

		const activity = (await call(ada, "GET", `/api/sessions/${chat}/activity`)).body;
		expect(activity).toMatchObject({ running: true });
		const tools = activity.steps.filter((step: any) => step.kind === "tool");
		// The call that ended took what the result's time says after the answer (3 s of it the model's); the one that did not is running now, with its declared timeout in ms.
		expect(tools[0]).toMatchObject({ id: "call-a", name: "http_request", ms: 4_000, timeoutMs: 30_000, error: false });
		expect(tools[0].summary).not.toContain("abc");
		expect(tools[1]).toMatchObject({ id: "call-b", ms: null, timeoutMs: 3_600_000, summary: expect.stringContaining("make all") });
		expect(activity.steps.find((step: any) => step.kind === "model" && step.error === null)).toMatchObject({ ms: 3_000, model: "gw/m1", stop: "toolUse" });
		expect(activity.steps.find((step: any) => step.kind === "model" && step.error)).toMatchObject({ ms: 900, stop: "error" });
		expect(activity.current).toMatchObject([{ id: "call-b", name: "shell", timeoutMs: 3_600_000 }]);
		// Quiet inside its own declared timeout, so shown but never woken for.
		expect(activity.stalls).toMatchObject([{ reason: "no output for five minutes", actionable: false }]);

		// A person's approval the call waits on is not a command that has gone quiet.
		await stack.admin.query("INSERT INTO pim_app.approvals (id, owner_id, public_chat_id, tool, args, state) VALUES ('ap1', $1, $2, 'shell', $3, 'waiting')", [owner, chat, JSON.stringify({ callId: "call-b" })]);
		expect((await call(ada, "GET", `/api/sessions/${chat}/activity`)).body).toMatchObject({ current: [], stalls: [] });
		await stack.admin.query("DELETE FROM pim_app.approvals WHERE id = 'ap1'");

		const turns = (await call(ada, "GET", `/api/admin/diagnostics?kind=turns&chat=${chat}`)).body;
		expect(turns.items[0]).toMatchObject({ in_progress: true, model_calls: 2, tool_calls: 2, model_ms: 3_900 });
		expect(turns.items[0].steps.map((step: any) => step.step)).toEqual(["model", "model", "tool", "tool"]);
		const working = (await call(ada, "GET", "/api/admin/diagnostics?kind=runs")).body.chats.find((c: any) => c.chat === chat);
		expect(working).toMatchObject({ waiting_on: expect.stringContaining("shell"), working_minutes: 20, stalls: [{ reason: "no output for five minutes" }] });
		expect((await call(ada, "GET", "/api/admin/diagnostics?kind=turns")).body.items).toMatchObject([{ chat, in_progress: true }]);

		const calls = (await call(ada, "GET", "/api/admin/diagnostics?kind=model_calls")).body;
		expect(calls.totals.errors).toBeGreaterThanOrEqual(1);
		expect(calls.totals.calls).toBeGreaterThanOrEqual(2);
		const failure = calls.failures.find((f: any) => f.stop_reason === "error" && f.latency_ms === 900);
		expect(failure).toMatchObject({ why: "stopped with error", provider: "gw", model: "m1", latency_ms: 900, request: { phases: { headersMs: 900 } } });
		// The provider's words keep their ids and their words, but not an address or an email.
		expect(failure.error).toBe("529 overloaded at [address]/v1/messages for [email] with max_tokens");
		expect((await call(ada, "GET", "/api/admin/diagnostics?kind=events")).body.items).toMatchObject([{ kind: "model_call_failed", detail: { provider: "gw" }, error: "529 overloaded" }]);
		expect((await call(ada, "GET", "/api/admin/diagnostics?kind=provider_cooldowns")).body.items).toMatchObject([{ model: "gw/m1", active: true, reason: "overloaded" }]);
		await stack.admin.query("DELETE FROM pim_runtime.provider_cooldowns WHERE owner_id = $1", [owner]);
	});
});

describe("a new chat", () => {
	it("is listed in the sidebar before the projection has heard of it", async () => {
		const chat = (await call(ada, "POST", "/api/sessions", { agentId: agent, title: "Welcome" })).body.id as string;
		const listed = (await call(ada, "GET", "/api/snapshot/sidebar")).body.sessions as { chatId: string; title: string }[];
		expect(listed.find((s) => s.chatId === chat)).toMatchObject({ title: "Welcome" });
		// Another person does not see it, and a deleted chat is gone.
		expect(((await call(bob, "GET", "/api/snapshot/sidebar")).body.sessions as { chatId: string }[]).some((s) => s.chatId === chat)).toBe(false);
		await call(ada, "DELETE", `/api/sessions/${chat}`);
		expect(((await call(ada, "GET", "/api/snapshot/sidebar")).body.sessions as { chatId: string }[]).some((s) => s.chatId === chat)).toBe(false);
	});
});

describe("the utility model", () => {
	const say = (ownerId: string, chat: string, n: number, role: "user" | "assistant", text: string) =>
		stack.admin.query("INSERT INTO pim_projection.chat_transcript_projection (owner_id, stream_kind, chat_id, entry_id, position, message, partition_id, commit_seq, projection_version) VALUES ($1,'chat',$2,$3,$4,$5,'00000000-0000-0000-0000-000000000001',$4,1)", [
			ownerId, chat, `m${n}-${chat}`, n, JSON.stringify({ id: `m${n}-${chat}`, role, timestamp: n, parts: role === "user" ? [{ type: "text", text }] : [{ type: "tool-call", id: "c", name: "send_to_user", arguments: { message: text } }] }),
		]);

	it("is off until one is chosen: no suggestions, no title, no improved prompt", async () => {
		const chat = (await call(ada, "POST", "/api/sessions", { agentId: agent })).body.id as string;
		// An empty chat offers Pim's own starters, with no model, in the person's language.
		expect((await call(ada, "GET", `/api/sessions/${chat}/suggestions`)).body).toEqual({ suggestions: ["What can you do?", "Plan my week"] });
		expect((await call(ada, "GET", `/api/sessions/${chat}/suggestions?locale=es`)).body).toEqual({ suggestions: ["¿Qué puedes hacer?", "Planea mi semana"] });
		expect((await call(ada, "POST", `/api/sessions/${chat}/title`)).status).toBe(501);
		expect((await call(ada, "POST", "/api/prompts/improve", { text: "plan" })).status).toBe(501);
		expect((await call(ada, "GET", `/api/sessions/${chat}/summary`)).body).toEqual({ summary: null });
		expect(asked).toHaveLength(0);
	});

	it("names, summarizes, improves and suggests through the model chosen in Settings", async () => {
		const owner = (await stack.admin.query("SELECT owner_id FROM pim_app.accounts WHERE username = 'ada'")).rows[0].owner_id as string;
		expect((await call(ada, "PUT", "/api/model/utility", { provider: "gateway", id: "u2" })).status).toBe(200);
		const chat = (await call(ada, "POST", "/api/sessions", { agentId: agent })).body.id as string;
		// Nothing has been answered yet, so there is nothing to name.
		expect((await call(ada, "POST", `/api/sessions/${chat}/title`)).status).toBe(501);
		await say(owner, chat, 1, "user", "Help me plan my garden");
		await say(owner, chat, 2, "assistant", "Start with the beds by the fence.");
		expect((await call(ada, "POST", `/api/sessions/${chat}/title`)).body).toMatchObject({ id: chat, title: "Fresh Garden Plan" });
		expect(asked.at(-1)).toMatchObject({ model: "u2", stream: false });
		expect(JSON.stringify(asked.at(-1).messages[1].content)).toBe('"Person: Help me plan my garden\\n\\nAssistant: Start with the beds by the fence."');
		expect((await call(ada, "POST", "/api/prompts/improve", { text: "plan" })).body).toEqual({ text: "Plan my week in detail" });
		const suggestions = () => call(ada, "GET", `/api/sessions/${chat}/suggestions?locale=en`);
		const asks = asked.length;
		expect((await suggestions()).body).toEqual({ suggestions: ["Plan my week", "Water the garden"] });
		// The model read the agent, what it remembers and this chat; asked again with nothing changed, it is not asked again.
		const read = JSON.stringify(asked.at(-1).messages[1].content);
		expect(asked).toHaveLength(asks + 1);
		expect(read).toContain("Assistant: ");
		expect(read).toContain("The chat:");
		expect((await suggestions()).body).toEqual({ suggestions: ["Plan my week", "Water the garden"] });
		expect(asked).toHaveLength(asks + 1);
		expect((await call(ada, "GET", `/api/sessions/${chat}/summary`)).body).toEqual({ summary: "- They planned a garden" });
		// Asked again with nothing more said, the summary is not written again; another person's chat is not reachable.
		const before = asked.length;
		await call(ada, "GET", `/api/sessions/${chat}/summary`);
		expect(asked).toHaveLength(before);
		expect((await call(bob, "POST", `/api/sessions/${chat}/title`)).status).toBe(404);
	});
});

describe("an approval's card", () => {
	it("carries the note the person left with their decision, the majordomo's own note, and what the action returned", () => {
		const row = (more: object) => ({ id: "ap_1", tool: "http:request", public_chat_id: null, created_at: new Date(), expires_at: null, timeout_policy: "deny", decided_at: new Date(), via_standing_grant: null, ...more });
		expect(webApproval(row({ state: "denied", decided_by: "user:s1", args: { summary: "GET x", note: "Not this week." } }))).toMatchObject({ status: "denied", note: "Not this week.", result: null, args: { summary: "GET x" } });
		expect(webApproval(row({ state: "approved", decided_by: "user:s1", args: { result: "200 ok" } }))).toMatchObject({ status: "approved", note: null, result: "200 ok" });
		expect(webApproval(row({ state: "approved", decided_by: "majordomo", args: { review: { status: "decided", note: "Routine." } } }))).toMatchObject({ decidedBy: "majordomo", note: "Routine." });
		// An approval every call of which needs a person's own decision names no tool, so its card offers no "always approve".
		expect(webApproval(row({ state: "waiting", args: { explicit: true, summary: "Install a skill" } })).tool).toBeNull();
		expect(webApproval(row({ state: "waiting", args: { summary: "Run ls" } })).tool).toBe("http:request");
	});
});

describe("naming a chat from its first message", () => {
	it("titles it from what was said at once, names it with the utility model, and keeps a rename and what a fork is called until its first message", async () => {
		const person = (await app.identity.authenticate(ada)) as never;
		const send = (chat: string, text: string) => app.conversations.admit(person, { commandId: `first-${chat}-${text.length}`, kind: "user_message", chatId: chat, payload: { text } });
		const titleOf = async (chat: string) => (await stack.admin.query("SELECT title FROM pim_app.conversations WHERE public_chat_id = $1", [chat])).rows[0].title as string | null;
		const named = async (chat: string, title: string) => { for (let i = 0; i < 100 && (await titleOf(chat)) !== title; i++) await new Promise((r) => setTimeout(r, 50)); return titleOf(chat); };
		const original = app.conversations.admit;
		nameChatsFromFirstMessage(app, process.env);
		try {
			// With no utility model the first words are the title: the first line, at most 80 characters.
			await stack.admin.query("DELETE FROM pim_app.owner_settings WHERE key = 'model_utility' AND owner_id = $1", [await ownerOf(ada)]);
			const plain = (await call(ada, "POST", "/api/sessions", { agentId: agent })).body.id as string;
			await send(plain, `${"Plan the garden beds ".repeat(6)}\nand then the fence`);
			expect(await titleOf(plain)).toBe(`${"Plan the garden beds ".repeat(6)}`.slice(0, 79).trimEnd() + "…");
			// A second message changes nothing, and nor does a retry.
			await send(plain, "something else");
			expect((await titleOf(plain))!.startsWith("Plan the garden")).toBe(true);

			// With one chosen the chat is named from the first message in the background.
			expect((await call(ada, "PUT", "/api/model/utility", { provider: "gateway", id: "u2" })).status).toBe(200);
			const asking = asked.length;
			const chat = (await call(ada, "POST", "/api/sessions", { agentId: agent })).body.id as string;
			await send(chat, "Help me plan my garden");
			expect(await named(chat, "Fresh Garden Plan")).toBe("Fresh Garden Plan");
			expect(JSON.stringify(asked.at(asking)?.messages[1].content)).toBe('"Person: Help me plan my garden"');

			// A rename before the answer stays.
			const renamed = (await call(ada, "POST", "/api/sessions", { agentId: agent })).body.id as string;
			const slow = send(renamed, "Water the beds");
			await call(ada, "PUT", `/api/sessions/${renamed}`, { title: "Mine" });
			await slow;
			await new Promise((r) => setTimeout(r, 400));
			expect(await titleOf(renamed)).toBe("Mine");

			// A fork keeps its numbered title until its first message, which names it anew.
			const fork = (await call(ada, "POST", "/api/sessions", { agentId: agent, title: "Garden (fork #2)" })).body.id as string;
			expect(await titleOf(fork)).toBe("Garden (fork #2)");
			await send(fork, "And the roses?");
			expect(await named(fork, "Fresh Garden Plan")).toBe("Fresh Garden Plan");
		} finally {
			app.conversations.admit = original;
		}
	});
});

describe("the utility model on a ChatGPT plan", () => {
	it("names an untitled chat with the plan's token on the Responses API, from the chat list, the sidebar and the title route", async () => {
		const carol = await app.identity.register({ username: "carol" });
		const token = await app.identity.createSession(carol.ownerId);
		// What a ChatGPT-plan owner has: an expired sealed credential, model_utility `openai`, and no OpenAI API key.
		const credential = { type: "oauth", access: "old", refresh: "plan-refresh-1", expires: 0, clientId: "c", scopes: [], idToken: "", subject: "s", email: null };
		await stack.admin.query("INSERT INTO pim_app.chatgpt_credentials (owner_id, host_id, secret) VALUES ($1, 'h', $2)", [carol.ownerId, await sealString(crypto, JSON.stringify(credential), chatgptContext(carol.ownerId))]);
		expect((await call(token, "PUT", "/api/model/utility", { provider: "openai", id: "gpt-6-luna" })).status).toBe(200);
		const agentId = (await call(token, "POST", "/api/agents", { name: "Pim" })).body.id;
		const say = (chat: string, n: number, message: unknown) => stack.admin.query("INSERT INTO pim_projection.chat_transcript_projection (owner_id, stream_kind, chat_id, entry_id, position, message, partition_id, commit_seq, projection_version) VALUES ($1,'chat',$2,$3,$4,$5,'00000000-0000-0000-0000-000000000001',$4,1)", [carol.ownerId, chat, `m${n}-${chat}`, n, JSON.stringify(message)]);
		const chatWith = async (answer: unknown) => {
			const chat = (await call(token, "POST", "/api/sessions", { agentId })).body.id as string;
			await say(chat, 1, { id: "u", role: "user", timestamp: 1, parts: [{ type: "text", text: "Help me plan my garden" }] });
			if (answer) await say(chat, 2, answer);
			await stack.admin.query("INSERT INTO pim_projection.sidebar_session_projection (owner_id, chat_id, title, busy, unread, stalled, updated_at, partition_id, commit_seq, projection_version) VALUES ($1,$2,NULL,false,false,false,1,'00000000-0000-0000-0000-000000000001',1,1)", [carol.ownerId, chat]);
			return chat;
		};
		const dbTitle = async (chat: string) => (await stack.admin.query("SELECT title FROM pim_app.conversations WHERE public_chat_id = $1", [chat])).rows[0].title;
		const before = asked.length;

		// The chat list names a chat whose answer is the plain text a plan model writes between tool calls, so only the person's message is there to go on.
		const plain = await chatWith({ id: "a", role: "assistant", timestamp: 2, parts: [{ type: "text", text: "Thinking about beds" }] });
		const listed = (await call(token, "GET", "/api/sessions")).body.sessions as { id: string; title: string | null }[];
		expect(listed.find((s) => s.id === plain)?.title).toBe("Fresh Garden Plan");
		expect(await dbTitle(plain)).toBe("Fresh Garden Plan");
		expect(auths.at(-1)).toBe("Bearer plan-access");
		expect(asked.length).toBe(before + 1);
		// The request is what the Runner sends the plan: pi-ai's streamed Responses call, with the fields the plan accepts and none it rejects.
		expect(asked.at(-1)).toMatchObject({ model: "gpt-6-luna", stream: true, store: false });

		// The sidebar names one that has been answered through send_to_user.
		const sent = await chatWith({ id: "a", role: "assistant", timestamp: 2, parts: [{ type: "tool-call", id: "c", name: "send_to_user", arguments: { message: "Start with the beds." } }] });
		const rows = (await call(token, "GET", "/api/snapshot/sidebar")).body.sessions as { chatId: string; title: string | null }[];
		expect(rows.find((s) => s.chatId === sent)?.title).toBe("Fresh Garden Plan");

		// And the title route.
		const asked3 = await chatWith(null);
		expect((await call(token, "POST", `/api/sessions/${asked3}/title`)).body).toMatchObject({ id: asked3, title: "Fresh Garden Plan" });
	});
});

describe("a plan call to OpenAI's own API", () => {
	it("is the request the Runner sends the plan: streamed Responses on /v1/responses, store false, and none of the fields the plan rejects", async () => {
		const sent: { url: string; headers: Headers; body: any }[] = [];
		const capture = (async (input: Request | string | URL, init?: RequestInit) => {
			const request = new Request(input as never, init);
			sent.push({ url: request.url, headers: request.headers, body: JSON.parse(await request.text()) });
			return new Response("event: response.completed\ndata: " + JSON.stringify({ type: "response.completed", response: { id: "r", object: "response", status: "failed", output: [], error: { code: "x", message: "stop here" } } }) + "\n\n", { headers: { "content-type": "text/event-stream" } });
		}) as typeof fetch;
		await planAnswer({ resource: "https://api.openai.com/v1", token: "plan-token", model: "gpt-6-luna" }, NAME_CHAT, "Person: hi", capture).catch(() => {});
		expect(sent).toHaveLength(1);
		expect(sent[0]!.url).toBe("https://api.openai.com/v1/responses");
		expect(sent[0]!.headers.get("authorization")).toBe("Bearer plan-token");
		expect(sent[0]!.body).toMatchObject({ model: "gpt-6-luna", stream: true, store: false });
		for (const rejected of ["max_output_tokens", "temperature", "prompt_cache_retention", "prompt_cache_options"]) expect(sent[0]!.body).not.toHaveProperty(rejected);
		expect(JSON.stringify(sent[0]!.body.input)).toContain("Person: hi");
	});
});

describe("a chat's own model", () => {
	it("is kept for the chat, shown in the sidebar and handed to the Runner as its next turn's model, until the chat follows its agent again", async () => {
		const owner = (await stack.admin.query("SELECT owner_id FROM pim_app.accounts WHERE username = 'ada'")).rows[0].owner_id as string;
		const chat = (await call(ada, "POST", "/api/sessions", { agentId: agent, title: "Pinned" })).body.id as string;
		const context = async () => (await stack.admin.query("SELECT pim_app.runner_context($1, $2) AS c", [owner, chat])).rows[0].c;
		expect((await context()).chat_model).toBeNull();
		expect((await call(ada, "PUT", `/api/sessions/${chat}/model`, { provider: "gateway", id: "nope" })).status).toBe(400);
		// v1's other shapes: {model: "<provider>/<id>"} and a bare id, and what to send when it is none of them.
		expect((await call(ada, "PUT", `/api/sessions/${chat}/model`, { model: "gateway/u2" })).body).toMatchObject({ model: { provider: "gateway", id: "u2" }, override: { provider: "gateway", id: "u2" } });
		expect((await call(ada, "PUT", `/api/sessions/${chat}/model`, { model: "u1" })).body).toMatchObject({ model: { provider: "gateway", id: "u1" } });
		const bad = await call(ada, "PUT", `/api/sessions/${chat}/model`, { model: "gateway/nope" });
		expect(bad.status).toBe(400);
		expect(bad.body.message).toContain('or {model:"<provider>/<id>"}.');
		expect((await call(ada, "PUT", `/api/sessions/${chat}/model`, { provider: "gateway", id: "u1" })).body).toMatchObject({ model: { provider: "gateway", id: "u1" } });
		expect((await context()).chat_model).toEqual({ provider: "gateway", id: "u1" });
		const row = ((await call(ada, "GET", "/api/snapshot/sidebar")).body.sessions as { chatId: string; summary: any }[]).find((s) => s.chatId === chat);
		expect(row?.summary.model).toMatchObject({ override: true, model: { provider: "gateway", id: "u1" } });
		expect((await call(bob, "PUT", `/api/sessions/${chat}/model`, { provider: "gateway", id: "u1" })).status).toBe(404);
		await call(ada, "PUT", `/api/sessions/${chat}/model`, { provider: null, id: null });
		expect((await context()).chat_model).toBeNull();
	});
});

describe("a chat an agent started for a task", () => {
	it("says in the sidebar who started it, so the app lists it under that chat, and is announced again when its task ends", async () => {
		const owner = (await stack.admin.query("SELECT owner_id FROM pim_app.accounts WHERE username = 'ada'")).rows[0].owner_id as string;
		const worker = (await call(ada, "POST", "/api/agents", { name: "Worker", role: "Worker", description: "Works" })).body;
		const from = (await call(ada, "POST", "/api/sessions", { agentId: agent, title: "Starter" })).body.id as string;
		const chat = (await call(ada, "POST", "/api/sessions", { agentId: worker.id, title: "Task chat" })).body.id as string;
		const row = async (id: string) => ((await call(ada, "GET", "/api/snapshot/sidebar")).body.sessions as { chatId: string; summary: any }[]).find((s) => s.chatId === id);
		expect((await row(chat))?.summary.startedBy).toBeNull();
		const before = Number((await stack.admin.query("SELECT last_seq FROM pim_app.chat_feed_counters WHERE owner_id = $1", [owner])).rows[0].last_seq);
		await stack.admin.query("INSERT INTO pim_app.tasks (task_id, owner_id, started_by, task_chat, origin_principal, title) VALUES ('t_started', $1, $2, $3, '{}', 'do it')", [owner, from, chat]);
		expect((await row(chat))?.summary.startedBy).toEqual({ session: from, agent: { id: agent, name: expect.any(String) }, task: "t_started", state: "working" });
		expect((await row(from))?.summary.startedBy).toBeNull();
		// The chat is announced when its task is made and when the task ends, and each time the row Live builds says who started it.
		await stack.admin.query("UPDATE pim_app.tasks SET status = 'completed' WHERE task_id = 't_started'");
		const feed = (await stack.admin.query("SELECT chat_id, started_by FROM pim_app.live_chat_feed($1, $2, 10)", [owner, before])).rows;
		expect(feed.map((r) => r.chat_id)).toEqual([chat, chat]);
		expect(feed[1].started_by).toMatchObject({ session: from, task: "t_started", state: "completed" });
	});
});

describe("a group chat's room", () => {
	it("takes its mode from the person, and runs each agent besides the host on a model chosen for its seat alone", async () => {
		const owner = (await stack.admin.query("SELECT owner_id FROM pim_app.accounts WHERE username = 'ada'")).rows[0].owner_id as string;
		const guest = (await call(ada, "POST", "/api/agents", { name: "Coach", role: "Coach", description: "Coaches" })).body;
		expect(guest).toMatchObject({ role: "Coach", description: "Coaches" });
		const chat = (await call(ada, "POST", "/api/sessions", { agentId: agent, title: "Room" })).body.id as string;
		// A chat with one agent is no room: it has no mode, and its agents have no seats.
		expect((await call(ada, "PUT", `/api/sessions/${chat}/room`, { mode: "open" })).status).toBe(404);
		expect((await call(ada, "PUT", `/api/sessions/${chat}/room/members/${guest.id}/model`, { provider: "gateway", id: "u1" })).status).toBe(404);
		expect((await call(ada, "POST", `/api/sessions/${chat}/room/members`, { agent: guest.id })).status).toBe(201);
		expect((await call(ada, "PUT", `/api/sessions/${chat}/room`, { mode: "sideways" })).status).toBe(400);
		expect((await call(ada, "PUT", `/api/sessions/${chat}/room`, { mode: "open" })).body.room).toMatchObject({ mode: "open" });
		expect((await call(bob, "PUT", `/api/sessions/${chat}/room`, { mode: "mentions" })).status).toBe(404);
		const member = async () => (await call(ada, "GET", "/api/sessions")).body.sessions.find((s: { id: string }) => s.id === chat).room.members[0];
		expect(await member()).toMatchObject({ id: guest.id, model: { override: false } });
		expect((await call(ada, "PUT", `/api/sessions/${chat}/room/members/${guest.id}/model`, { provider: "gateway", id: "nope" })).status).toBe(400);
		expect((await call(ada, "PUT", `/api/sessions/${chat}/room/members/${guest.id}/model`, { provider: "gateway", id: "u1" })).body).toMatchObject({ model: { provider: "gateway", id: "u1" } });
		// The seat is a chat of its own, so its model is the one the Runner reads for it; the host's is untouched.
		const seat = (await stack.admin.query("SELECT seat_chat_id FROM pim_app.room_members WHERE public_chat_id = $1", [chat])).rows[0].seat_chat_id as string;
		expect((await stack.admin.query("SELECT pim_app.runner_context($1, $2) AS c", [owner, seat])).rows[0].c.chat_model).toEqual({ provider: "gateway", id: "u1" });
		expect((await stack.admin.query("SELECT pim_app.runner_context($1, $2) AS c", [owner, chat])).rows[0].c.chat_model).toBeNull();
		expect(await member()).toMatchObject({ model: { model: { provider: "gateway", id: "u1" }, override: true } });
		expect((await call(ada, "PUT", `/api/sessions/${chat}/room/members/${guest.id}/model`, { provider: null, id: null })).status).toBe(200);
		expect(await member()).toMatchObject({ model: { override: false } });
	});
});

describe("joining, API tokens and the deployment screen", () => {
	let people: Server;
	let origin: string;
	const env = { PIM_REGISTRATIONS_PER_ADDRESS: "7", PIM_MAX_ACCOUNTS: "lots", PIM_MODELS: "u1", PIM_MEMORY_LINES: "4", PIM_IMAGE_MODEL: "off", PIM_APPROVAL_POLICY: "sometimes" };
	const ask = async (token: string | null, method: string, path: string, body?: unknown) => {
		const res = await fetch(origin + path, { method, headers: { ...(token ? { authorization: `Bearer ${token}` } : {}), ...(body === undefined ? {} : { "content-type": "application/json" }) }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
		const text = await res.text();
		return { status: res.status, body: text.startsWith("{") ? JSON.parse(text) : text };
	};
	beforeAll(async () => {
		people = createGate(app, { first: [...bootRoutes, ...accountRoutes(), ...screenRoutes(env)] });
		await new Promise<void>((resolve) => people.listen(0, "127.0.0.1", resolve));
		origin = `http://127.0.0.1:${(people.address() as { port: number }).port}`;
	});
	afterAll(() => void people?.close());

	it("makes a registration pending until its first passkey, with the default agent already its own, and refuses names that look official", async () => {
		const agentId = (await call(ada, "POST", "/api/agents", { name: "Buddy", instructions: "Be kind", role: "Friend", description: "Says hello", emoji: "🙂" })).body.id;
		expect((await ask(ada, "PUT", "/api/admin/default-agent", { agent: agentId })).status).toBe(200);
		const invite = await app.identity.createInvite((await app.identity.authenticate(ada)) as never);
		expect((await ask(null, "POST", "/auth/register", { username: "support", invite })).status).toBe(400);
		const joined = await ask(null, "POST", "/auth/register", { username: "newcomer", invite });
		expect(joined.status).toBe(201);
		expect(joined.body).toMatchObject({ account: { status: "pending" }, role: "member", setup: expect.any(String), recoveryCodes: expect.any(Array) });
		const owner = joined.body.account.ownerId as string;
		// Not yet theirs to act in, but their space already holds a copy of the agent the admin chose.
		const copies = await app.db.owner(owner, async (tx) => (await tx.query("SELECT name, role, description, emoji FROM pim_app.agents WHERE adopted_from IS NOT NULL AND deleted_at IS NULL")).rows);
		expect(copies).toEqual([{ name: "Buddy", role: "Friend", description: "Says hello", emoji: "🙂" }]);
		// A client without a browser asks for the session and starts active.
		const scripted = await ask(null, "POST", "/auth/register", { username: "scripty", invite: await app.identity.createInvite((await app.identity.authenticate(ada)) as never), session: true });
		expect(scripted.body.account.status).toBe("active");
		await ask(ada, "DELETE", "/api/admin/default-agent");
	});

	it("lists API tokens imported from v1, requires a name, and revokes any of them", async () => {
		const me = (await app.identity.authenticate(bob)) as { ownerId: string };
		await app.identity.importLegacyToken(me.ownerId, "old phone", "legacy-hash-1");
		expect((await ask(bob, "POST", "/auth/tokens", {})).status).toBe(400);
		expect((await ask(bob, "POST", "/auth/tokens", { name: "  " })).status).toBe(400);
		const made = (await ask(bob, "POST", "/auth/tokens", { name: "laptop" })).body;
		const listed = (await ask(bob, "GET", "/auth/tokens")).body.tokens as { id: string; name: string }[];
		expect(listed.map((t) => t.name).sort()).toEqual(["laptop", "old phone"]);
		const legacy = listed.find((t) => t.name === "old phone")!;
		expect((await ask(bob, "DELETE", `/auth/tokens/${legacy.id}`)).status).toBe(200);
		expect(((await ask(bob, "GET", "/auth/tokens")).body.tokens as { id: string }[]).map((t) => t.id)).toEqual([made.id]);
	});

	it("shows what the deployment's variables say, and what could not be read, never a made-up value", async () => {
		const shown = (await ask(ada, "GET", "/api/admin/deployment")).body;
		expect(shown.settings).toMatchObject({ registration: "open", registrationsPerAddress: 7, maxAccounts: 0, models: ["u1"], memoryLines: 96, imageModel: null, utilityModel: null, approvalPolicy: "majordomo" });
		const problems = Object.fromEntries((shown.variables as { name: string; problem: string | null }[]).filter((v) => v.problem).map((v) => [v.name, v.problem]));
		expect(Object.keys(problems).sort()).toEqual(["PIM_APPROVAL_POLICY", "PIM_MAX_ACCOUNTS", "PIM_MEMORY_LINES"]);
		expect((shown.variables as { name: string; value: string | null }[]).find((v) => v.name === "PIM_IMAGE_MODEL")?.value).toBe("off");
	});
});

describe("the agents' rules and the majordomo", () => {
	let rules: Server;
	let origin = "";
	const call = async (token: string, method: string, path: string, body?: unknown) => {
		const res = await fetch(origin + path, { method, headers: { authorization: `Bearer ${token}`, ...(body === undefined ? {} : { "content-type": "application/json" }) }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
		const text = await res.text();
		return { status: res.status, body: text.startsWith("{") ? JSON.parse(text) : text };
	};
	beforeAll(async () => {
		process.env.PIM_AI_GATEWAY_MODELS = "u1,u2";
		rules = createGate(app, { first: [...bootRoutes, ...modelRoutes(process.env)] });
		await new Promise<void>((resolve) => rules.listen(0, "127.0.0.1", resolve));
		origin = `http://127.0.0.1:${(rules.address() as { port: number }).port}`;
	});
	afterAll(() => {
		rules?.close();
		delete process.env.PIM_AI_GATEWAY_MODELS;
	});

	it("keeps the majordomo's role and refuses to delete it, and gives each agent a name and a role of its own", async () => {
		const [major] = (await call(bob, "GET", "/api/agents")).body.agents as { id: string; role: string; majordomo: boolean }[];
		expect(major).toMatchObject({ majordomo: true, role: "Majordomo" });
		expect((await call(bob, "DELETE", `/api/agents/${major!.id}`)).status).toBe(400);
		expect((await call(bob, "PUT", `/api/agents/${major!.id}`, { name: "Jeeves", role: "Researcher" })).body).toMatchObject({ name: "Jeeves", role: "Majordomo" });
		const first = await call(bob, "POST", "/api/agents", { name: "Dora", role: "Researcher" });
		expect(first).toMatchObject({ status: 201, body: { name: "Dora", role: "Researcher" } });
		expect((await call(bob, "POST", "/api/agents", { name: "dora", role: "Editor" })).status).toBe(409);
		expect((await call(bob, "POST", "/api/agents", { name: "Grace", role: " researcher " })).status).toBe(409);
		expect((await call(bob, "POST", "/api/agents", { name: "Rocket", symbol: "rocket", color: "indigo" })).body).toMatchObject({ symbol: "rocket", color: "indigo" });
		expect((await call(bob, "POST", "/api/agents", { name: "Runner", symbol: "🏃🏃" })).status).toBe(400);
		expect((await call(bob, "DELETE", `/api/agents/${first.body.id}`)).status).toBeLessThan(300);
	});

	it("takes only connectors this Pim offers and fallback models that are choices", async () => {
		expect((await call(bob, "POST", "/api/agents", { name: "Cal", apps: ["custom/nope"] })).status).toBe(400);
		expect((await call(bob, "POST", "/api/agents", { name: "Cal", apps: [{ name: "Cal", url: "https://plain.test/mcp" }] })).status).toBe(400);
		expect((await call(bob, "POST", "/api/agents", { name: "Cal", fallbacks: [{ provider: "nowhere", id: "nope" }] })).status).toBe(400);
		const made = await call(bob, "POST", "/api/agents", { name: "Cal", fallbacks: [{ provider: "gateway", id: "u2" }] });
		expect(made).toMatchObject({ status: 201, body: { fallbacks: [{ provider: "gateway", id: "u2" }] } });
		expect((await call(bob, "PUT", `/api/agents/${made.body.id}/fallbacks`, { models: [{ provider: "nowhere", id: "nope" }] })).status).toBe(400);
		expect((await call(bob, "PUT", `/api/agents/${made.body.id}/fallbacks`, { models: [{ provider: "gateway", id: "u1" }] })).body).toMatchObject({ fallbacks: [{ provider: "gateway", id: "u1" }] });
		expect((await call(bob, "PUT", "/api/model/fallbacks", { models: [{ provider: "nowhere", id: "nope" }] })).status).toBe(400);
		expect((await call(bob, "PUT", "/api/model/fallbacks", { models: [{ provider: "gateway", id: "u2" }] })).body).toMatchObject({ models: [{ provider: "gateway", id: "u2" }] });
		expect((await call(bob, "PUT", "/api/model/fallbacks", { models: [] })).body).toEqual({ models: [] });
	});

	it("starts the majordomo's first chat only for a name, a title and a language it accepts, and greets in that language", async () => {
		const owner = (await stack.admin.query("SELECT owner_id FROM pim_app.accounts WHERE username = 'bob'")).rows[0]?.owner_id as string | undefined;
		for (const bad of [{ yourName: "Ana\nSouza" }, { yourName: "x".repeat(81) }, { locale: "Spanish!" }, { title: "x".repeat(101) }]) expect((await call(bob, "POST", "/api/majordomo", bad)).status).toBe(400);
		expect((await call(bob, "GET", "/api/majordomo")).body).toMatchObject({ introduced: false });
		const started = (await call(bob, "POST", "/api/majordomo", { yourName: "Anita", locale: "es", title: "Te damos la bienvenida, Anita" })).body;
		expect(started).toMatchObject({ introduced: true, session: expect.any(String) });
		const sent = (await stack.admin.query("SELECT payload->>'text' AS text FROM pim_app.accepted_commands WHERE public_chat_id = $1 AND kind = 'user_message'", [started.session])).rows[0]?.text as string;
		expect(sent).toContain('Their name is Anita.');
		expect(sent).toContain('"es"');
		expect(owner).toBeTruthy();
	});
});

describe("where the turns put a request that failed over", () => {
	it("is where it ran, ending when the next attempt began, not when the request that followed it ended", () => {
		// Neon began at 0, went silent for 120 s, and Sol began then and answered in 5 s. The ledger writes both rows when Sol ended.
		const row = (id: string, model: string, latency: number, error: string | null) => ({ id, provider: "gw", model, latency_ms: latency, error, at: 125_000 });
		const { calls, failed } = callsOf([row("mc_c1_t1_120000", "sol", 5_000, null), row("mc_c1_t1_120000_f0", "neon", 120_000, "timed out")]);
		expect(calls.get(120_000)).toEqual({ model: "gw/sol", ms: 5_000 });
		expect(failed).toEqual([{ at: 0, ms: 120_000, model: "gw/neon", error: "timed out" }]);
		// Two attempts that failed in a row ran one after the other, the last ending where the answered request began.
		const twice = callsOf([row("mc_c1_t1_100000_f0", "a", 40_000, "x"), row("mc_c1_t1_100000_f1", "b", 60_000, "y")]);
		expect(twice.failed.map((f) => [f.model, f.at])).toEqual([["gw/b", 40_000], ["gw/a", 0]]);
		// Three in a row, two of them after the first: each ends where the next began, however long the answered request took.
		const rows = [row("mc_c1_t1_300000", "sol", 90_000, null), row("mc_c1_t1_300000_f0", "a", 100_000, "x"), row("mc_c1_t1_300000_f1", "b", 70_000, "y"), row("mc_c1_t1_300000_f2", "c", 30_000, "z")];
		expect(callsOf(rows).failed.map((f) => [f.model, f.at, f.ms])).toEqual([["gw/c", 270_000, 30_000], ["gw/b", 200_000, 70_000], ["gw/a", 100_000, 100_000]]);
	});
});
