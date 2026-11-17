// The web app's chat-side routes over a real PostgreSQL and the real migrations: what each answers in the shape the app reads, that a person reaches
// only their own rows, and that a change made on a stale revision or an old ui-block version is refused.
import { createServer, type Server } from "node:http";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { App } from "@pim/v2-app/app";
import { connect } from "@pim/v2-app/db";
import { createGate } from "@pim/v2-app/gate";
import { MemoryObjectStore } from "@pim/v2-app/objects";
import { chatRoutes } from "../src/compat/chat.ts";
import { modelRoutes } from "../src/compat/model.ts";
import { snapshotRoutes } from "../src/gate-extras.ts";
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

const call = async (token: string, method: string, path: string, body?: unknown, headers: Record<string, string> = {}) => {
	const response = await fetch(base + path, { method, headers: { authorization: `Bearer ${token}`, ...(typeof body === "object" ? { "content-type": "application/json" } : {}), ...headers }, ...(body === undefined ? {} : { body: typeof body === "string" ? body : JSON.stringify(body) }) });
	const text = await response.text();
	return { status: response.status, body: text.startsWith("{") ? JSON.parse(text) : text, headers: response.headers };
};

beforeAll(async () => {
	stack = await createStack();
	app = new App(connect(stack.url("gate"), 4), new MemoryObjectStore());
	// A stand-in utility model: answers each side job the way a small model would, and records what it was asked.
	utility = createServer(async (req, res) => {
		let raw = "";
		for await (const chunk of req) raw += chunk;
		const body = JSON.parse(raw);
		asked.push(body);
		const system = String(body.messages[0].content);
		const content = system.includes("name chats") ? 'Title: "Fresh Garden Plan".' : system.includes("improve messages") ? "Plan my week in detail" : system.includes("suggest") ? 'Sure! {"messages":["Plan my week","Water the garden","Plan my week"]}' : "- They planned a garden";
		res.setHeader("content-type", "application/json").end(JSON.stringify({ choices: [{ message: { content } }] }));
	});
	await new Promise<void>((resolve) => utility.listen(0, "127.0.0.1", resolve));
	const gateway = { PIM_AI_GATEWAY_URL: `http://127.0.0.1:${(utility.address() as { port: number }).port}/v1`, PIM_AI_GATEWAY_MODELS: "u1,u2" };
	server = createGate(app, { first: [...modelRoutes(gateway), ...chatRoutes, ...snapshotRoutes(app.db.pool)] });
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
		expect((await call(ada, "GET", `/api/sessions/${chat}/suggestions`)).body).toEqual({ suggestions: [] });
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
		expect((await call(ada, "GET", `/api/sessions/${chat}/suggestions?locale=en`)).body).toEqual({ suggestions: ["Plan my week", "Water the garden"] });
		expect((await call(ada, "GET", `/api/sessions/${chat}/summary`)).body).toEqual({ summary: "- They planned a garden" });
		// Asked again with nothing more said, the summary is not written again; another person's chat is not reachable.
		const before = asked.length;
		await call(ada, "GET", `/api/sessions/${chat}/summary`);
		expect(asked).toHaveLength(before);
		expect((await call(bob, "POST", `/api/sessions/${chat}/title`)).status).toBe(404);
	});
});

describe("a chat's own model", () => {
	it("is kept for the chat, shown in the sidebar and handed to the Runner as its next turn's model, until the chat follows its agent again", async () => {
		const owner = (await stack.admin.query("SELECT owner_id FROM pim_app.accounts WHERE username = 'ada'")).rows[0].owner_id as string;
		const chat = (await call(ada, "POST", "/api/sessions", { agentId: agent, title: "Pinned" })).body.id as string;
		const context = async () => (await stack.admin.query("SELECT pim_app.runner_context($1, $2) AS c", [owner, chat])).rows[0].c;
		expect((await context()).chat_model).toBeNull();
		expect((await call(ada, "PUT", `/api/sessions/${chat}/model`, { provider: "gateway", id: "nope" })).status).toBe(400);
		expect((await call(ada, "PUT", `/api/sessions/${chat}/model`, { provider: "gateway", id: "u1" })).body).toMatchObject({ model: { provider: "gateway", id: "u1" } });
		expect((await context()).chat_model).toEqual({ provider: "gateway", id: "u1" });
		const row = ((await call(ada, "GET", "/api/snapshot/sidebar")).body.sessions as { chatId: string; summary: any }[]).find((s) => s.chatId === chat);
		expect(row?.summary.model).toMatchObject({ override: true, model: { provider: "gateway", id: "u1" } });
		expect((await call(bob, "PUT", `/api/sessions/${chat}/model`, { provider: "gateway", id: "u1" })).status).toBe(404);
		await call(ada, "PUT", `/api/sessions/${chat}/model`, { provider: null, id: null });
		expect((await context()).chat_model).toBeNull();
	});
});
