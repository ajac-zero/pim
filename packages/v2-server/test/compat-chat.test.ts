// The web app's chat-side routes over a real PostgreSQL and the real migrations: what each answers in the shape the app reads, that a person reaches
// only their own rows, and that a change made on a stale revision or an old ui-block version is refused.
import { createServer, type Server } from "node:http";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { App } from "@pim/v2-app/app";
import { connect } from "@pim/v2-app/db";
import { createGate } from "@pim/v2-app/gate";
import { MemoryObjectStore } from "@pim/v2-app/objects";
import { chatRoutes } from "../src/compat/chat.ts";
import { apiClientRoutes } from "../src/compat/api-clients.ts";
import { diagnosticsRoutes } from "../src/compat/diagnostics.ts";
import { usageRoutes } from "../src/compat/usage.ts";
import { createStack, type Stack } from "./support/stack.ts";

let stack: Stack;
let app: App;
let server: Server;
let base: string;
let ada: string;
let bob: string;
let agent: string;

const call = async (token: string, method: string, path: string, body?: unknown, headers: Record<string, string> = {}) => {
	const response = await fetch(base + path, { method, headers: { authorization: `Bearer ${token}`, ...(typeof body === "object" ? { "content-type": "application/json" } : {}), ...headers }, ...(body === undefined ? {} : { body: typeof body === "string" ? body : JSON.stringify(body) }) });
	const text = await response.text();
	return { status: response.status, body: text.startsWith("{") ? JSON.parse(text) : text, headers: response.headers };
};

beforeAll(async () => {
	stack = await createStack();
	app = new App(connect(stack.url("gate"), 4), new MemoryObjectStore()).limitSpaces();
	server = createGate(app, { first: [...chatRoutes, ...usageRoutes(), ...apiClientRoutes(), ...diagnosticsRoutes({ PIM_PUBLIC_URL: "https://pim.example.test" })] });
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
	base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
	const claim = await app.identity.issueClaim("bootstrap", null, 3600_000);
	const a = await app.identity.register({ username: "ada", bootstrap: claim });
	ada = await app.identity.createSession(a.ownerId);
	await app.identity.setRegistrationOpen((await app.identity.authenticate(ada)) as never, true);
	const b = await app.identity.register({ username: "bob" });
	bob = await app.identity.createSession(b.ownerId);
	agent = (await call(ada, "POST", "/api/agents", { name: "Pim" })).body.id;
});
afterAll(async () => {
	server?.close();
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
	it("is saved over the version last read, and a submitted block stays as submitted", async () => {
		const { rows } = await stack.admin.query("SELECT owner_id FROM pim_app.accounts WHERE username = 'ada'");
		await stack.admin.query("INSERT INTO pim_projection.chat_transcript_projection (owner_id, stream_kind, chat_id, entry_id, position, message, partition_id, commit_seq, projection_version) VALUES ($1,'chat','c','m1',1,'{}','00000000-0000-0000-0000-000000000001',1,1)", [rows[0].owner_id]);
		const put = (token: string, version: number, submitted = false) => call(token, "PUT", "/api/messages/m1/ui-state/b", { version, state: { v: version }, submitted });
		expect((await put(ada, 0)).body).toMatchObject({ version: 1, submitted: false });
		expect((await put(ada, 0)).status).toBe(409);
		expect((await put(ada, 1, true)).body).toMatchObject({ version: 2, submitted: true });
		expect((await put(ada, 2)).status).toBe(409);
		expect((await call(ada, "GET", "/api/messages/m1/ui-state")).body.blocks.b).toMatchObject({ version: 2, submitted: true });
		expect((await put(bob, 0)).status).toBe(404);
	});
});

describe("chats and the account", () => {
	it("renames and deletes a chat, answers cost and tasks, and lists tokens without secrets", async () => {
		const chat = (await call(ada, "POST", "/api/sessions", { agentId: agent, title: "First" })).body.id as string;
		expect((await call(ada, "PUT", `/api/sessions/${chat}`, { title: "Second" })).body).toMatchObject({ id: chat, title: "Second" });
		expect((await call(ada, "GET", `/api/sessions/${chat}/cost`)).body).toEqual({ total: 0, models: [] });
		expect((await call(ada, "GET", `/api/sessions/${chat}/tasks`)).body).toEqual({ tasks: [] });
		expect((await call(bob, "GET", `/api/sessions/${chat}/cost`)).status).toBe(404);
		expect((await call(ada, "POST", "/api/prompts/improve", { text: "x" })).status).toBe(501);
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
		expect((await call(ada, "PUT", "/api/admin/compute/quota", { quota: { maxSessionMinutes: 10 } })).status).toBe(400);
		expect((await call(bob, "PUT", "/api/admin/compute/quota", { quota: null })).status).toBe(403);
		const owner = await ownerOf(bob);
		await app.db.owner(owner, (tx) => tx.query("INSERT INTO pim_forge.forge_compute_usage (owner_id, thread_id, provider, began_at, ended_at) VALUES ($1, 't', 'e2b', now() - interval '90 minutes', now() - interval '30 minutes')", [owner]));
		const compute = (await call(bob, "GET", "/api/usage")).body.compute;
		// Bob's own number wins for minutes; the deployment's holds for what he has none of.
		expect(compute).toMatchObject({ quota: { maxConcurrentWorkspaces: 3, monthlySandboxMinutes: 30 }, own: { monthlySandboxMinutes: 30 }, usage: { minutes: 60, running: 0, byProvider: [{ provider: "e2b", minutes: 60 }] } });
		expect((await call(ada, "PUT", "/api/admin/accounts/bob/compute-quota", { quota: null })).body.quota).toEqual({ maxConcurrentWorkspaces: null, monthlySandboxMinutes: null, maxSessionMinutes: null });
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
		expect((await call(ada, "GET", `/api/sessions/${chat}/operations/op-1`)).body).toMatchObject({ status: "pending", session: chat });
		expect((await call(ada, "GET", `/api/sessions/${chat}/operations/nope`)).status).toBe(404);
		expect((await call(ada, "GET", `/api/sessions/${chat}/messages`)).body).toMatchObject({ session: chat, busy: true, pending: ["op-1"], messages: [] });
		expect((await call(bob, "GET", `/api/sessions/${chat}/messages`)).status).toBe(404);
		expect((await call(ada, "GET", "/api")).body).toMatchObject({ timeZone: expect.any(String), tools: [] });
		expect((await call(ada, "GET", "/api/health")).body).toEqual({ name: "pim", ok: true });
		// The export carries each chat with its messages, the settings, approvals and the days of usage, and only the person's own.
		const exported = (await call(ada, "GET", "/api/export")).body;
		expect(exported.chats.find((c: { id: string }) => c.id === chat)).toMatchObject({ title: "api", messages: [] });
		expect(Object.keys(exported)).toEqual(expect.arrayContaining(["settings", "approvals", "permissions", "usage"]));
		expect((await call(bob, "GET", "/api/export")).body.chats.some((c: { id: string }) => c.id === chat)).toBe(false);
	});

	it("shows one trigger run by its id, and no other person's", async () => {
		const made = (await call(ada, "POST", "/api/triggers", { label: "Runs", instruction: "go", agentId: agent, source: { kind: "time", schedule: "cron", expression: "0 8 * * *", timeZone: "UTC" }, destination: { type: "new_chat" } })).body;
		const owner = await ownerOf(ada);
		await app.db.owner(owner, (tx) => tx.query("INSERT INTO pim_app.trigger_runs (id, owner_id, trigger_id, phase, detail) VALUES ('tr1', $1, $2, 'fired', '{\"scheduledFor\": 1000}')", [owner, made.id]));
		expect((await call(ada, "GET", "/api/trigger-runs/tr1")).body).toMatchObject({ id: "tr1", triggerId: made.id, phase: "fired", dueAt: 1000, evidence: { reason: "time", scheduledFor: 1000 } });
		expect((await call(bob, "GET", "/api/trigger-runs/tr1")).status).toBe(404);
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
		expect((await call(ada, "GET", "/api/admin/diagnostics?kind=provider_cooldowns")).body).toMatchObject({ available: false });
		expect((await call(ada, "GET", "/api/admin/diagnostics?kind=nope")).status).toBe(400);
		expect((await call(ada, "GET", "/api/admin/diagnostics?since=soon")).status).toBe(400);
		expect((await call(bob, "GET", "/api/admin/diagnostics")).status).toBe(403);
		expect((await call(ada, "GET", "/api/admin/health")).body.deployment).toMatchObject({ publicUrlSet: true, approvalPolicy: "explicit" });
	});
});
