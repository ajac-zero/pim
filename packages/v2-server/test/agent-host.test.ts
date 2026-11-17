// The default agent host on the real stack: a Runner started without any `harnessOptions` runs a real Pim agent. The only thing given to it is a model provider (pi-ai's
// faux one, as a deployment's own provider would be) and the databases the tools write through. The agent keeps notes and goals, creates a note and an app, makes an
// HTTP request that waits for a person's approval and is sent once, and starts a coding thread under an admin's grant; every model call lands in the cost ledger.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { fauxAssistantMessage, fauxProvider, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import { App } from "@pim/v2-app/app";
import { connect as connectApp } from "@pim/v2-app/db";
import { MemoryObjectStore } from "@pim/v2-app/objects";
import type { Db as ForgeDb } from "@pim/v2-forge/db";
import { ForgeScheduler } from "@pim/v2-forge/scheduler";
import type { Process } from "../src/main.ts";
import { readTranscript, waitFor } from "../../v2-runtime/test/support/rig.ts";
import { Client } from "./support/client.ts";
import { type Deployment, base, start, startS3 } from "./support/processes.ts";
import { createStack, describeWith, freePort, hasNats, startNats } from "./support/stack.ts";

const real = describeWith(hasNats());
const REPO = "https://github.com/acme/app";
const API = "http://93.184.216.34/orders";

real("the default agent host", () => {
	let d: Deployment;
	let gate: Process;
	let runner: Process;
	let web: Client;
	let app: App;
	let ownerId: string;
	let chatId: string;
	let n = 0;
	const faux = fauxProvider({ provider: "faux", models: [{ id: "m" }] });
	const prompts: string[] = [];
	const sent: { url: string; method: string; headers: Record<string, string>; body: unknown }[] = [];
	let failNext = false;
	const toolUse = (...calls: ReturnType<typeof fauxToolCall>[]) => fauxAssistantMessage(calls, { stopReason: "toolUse" });
	/** A response that notes the prompt it was asked with. */
	const seen = (message: ReturnType<typeof fauxAssistantMessage>) => (ctx: { systemPrompt?: string }) => (prompts.push(ctx.systemPrompt ?? ""), message);

	const say = async (words: string, ...script: unknown[]) => {
		faux.setResponses([...script, fauxAssistantMessage(`done ${++n}`)] as never);
		expect((await web.call("POST", `/api/sessions/${chatId}/messages`, { commandId: `m-${n}`, text: words })).status).toBe(202);
		await waitFor(`the turn "${words}" to end`, async () => ((await transcript()).includes(`done ${n}`) ? true : undefined), 60_000);
	};
	/** What a tool answered, as the model read it. */
	const results = async (tool: string) =>
		(JSON.parse(await transcript()) as { model?: { role: string; toolName?: string; content: { text?: string }[] }[] }[]).flatMap((e) => (e.model ?? []).filter((m) => m.role === "toolResult" && m.toolName === tool).map((m) => m.content.map((c) => c.text ?? "").join("")));
	const transcript = async () => {
		const c = (await d.stack.admin.query("SELECT partition_id, conversation_id FROM pim_app.conversations WHERE public_chat_id = $1", [chatId])).rows[0];
		return JSON.stringify(await readTranscript(d.stack.runtime, ownerId, c.partition_id, Number(c.conversation_id)));
	};

	beforeAll(async () => {
		const stack = await createStack();
		d = { stack, nats: await startNats(), s3: await startS3(), gatePort: await freePort(), ingressSecret: "ingress" };
		app = new App(connectApp(stack.url("gate"), 4), new MemoryObjectStore());
		gate = await start(d, "gate", {}, { PIM_CODING_ALLOWED_REPOS: "acme/*" });
		web = new Client(base(gate), d.ingressSecret);
		const claim = await app.identity.issueClaim("bootstrap", null, 3_600_000);
		const registered = await web.call("POST", "/auth/register", { username: "anibal", bootstrap: claim, session: true });
		expect(registered.status).toBe(201);
		ownerId = registered.json.account.ownerId;
		chatId = (await web.call("POST", "/api/sessions", { title: "Work" })).json.id;
		// No harness options, no tool registry: the host builds them. Only a provider and what the tools reach are given.
		runner = await start(
			d,
			"runner",
			{
				pollMs: 40,
				providers: () => [faux.provider],
				fetch: (async (url: string | URL, init?: RequestInit) => {
					if (failNext) throw new Error("the connection timed out");
					sent.push({ url: String(url), method: init?.method ?? "GET", headers: (init?.headers ?? {}) as Record<string, string>, body: init?.body });
					return new Response('{"ok":true}', { status: 201, headers: { "content-type": "application/json" } });
				}) as typeof fetch,
			},
			{ PIM_DEFAULT_MODEL: "faux/m", PIM_APP_DATABASE_URL: stack.url("gate"), PIM_FORGE_DATABASE_URL: stack.url("forge"), PIM_CODING_ALLOWED_REPOS: "acme/*" },
		);
	}, 180_000);
	afterAll(async () => {
		await Promise.allSettled([runner?.close(), gate?.close()]);
		await app?.db.end();
		d?.nats.stop();
		await d?.s3.stop();
		await d?.stack.drop();
	}, 60_000);

	it("keeps memories, goals, notes and apps with the application's services, and puts them in the next prompt", async () => {
		await say(
			"remember my tea, plan a 5k, and write it down",
			toolUse(
				fauxToolCall("note", { title: "Tea", body: "Anibal drinks black tea" }),
				fauxToolCall("create_goal", { title: "Run a 5k", steps: ["Run 2k", "Run 4k"] }),
				fauxToolCall("note_create", { title: "Plan", text: "Week one: run 2k" }),
				fauxToolCall("app_create", { title: "Tracker", kind: "html", files: { "index.html": "<h1>5k</h1>" } }),
			),
			toolUse(fauxToolCall("recall", { pattern: "black" })),
			toolUse(fauxToolCall("send_to_user", { message: "Saved it all." })),
		);
		const rows = async (sql: string) => (await d.stack.admin.query(sql)).rows;
		expect((await rows("SELECT scope, title FROM pim_app.memories")).map((r) => [r.scope, r.title])).toEqual([["everyone", "Tea"]]);
		expect((await rows("SELECT g.title, count(s.*)::int AS steps FROM pim_app.goals g JOIN pim_app.goal_steps s ON s.goal_id = g.id GROUP BY g.title"))[0]).toMatchObject({ title: "Run a 5k", steps: 2 });
		expect((await rows("SELECT title, version FROM pim_app.notes"))[0]).toMatchObject({ title: "Plan" });
		expect((await rows("SELECT title, kind FROM pim_app.artifacts"))[0]).toMatchObject({ title: "Tracker", kind: "html" });
		expect((await results("recall"))[0]).toContain("Tea");
		// The app comes back as the reference the web app shows as a card and opens in the canvas.
		expect(JSON.parse((await results("app_create"))[0]!).artifact).toMatchObject({ title: "Tracker", kind: "html", version: 1 });
		// The next turn's prompt carries what the agent knows: who it is, its goals, its memory.
		await say("what do you know?", seen(toolUse(fauxToolCall("send_to_user", { message: "I know." }))) as never);
		expect(prompts).toHaveLength(1);
		const shown = await transcript();
		expect(shown).toContain("<agent>");
		expect(shown).toContain("anibal");
		expect(shown).toMatch(/<active_goals>[\s\S]*Run a 5k[\s\S]*Run 2k/);
		expect(shown).toMatch(/<memory>[\s\S]*Tea/);
		// Every model call is a row in the ledger, with its tokens.
		const calls = await rows("SELECT provider, model, input_tokens FROM pim_app.model_calls");
		expect(calls.length).toBeGreaterThanOrEqual(5);
		expect(calls[0]).toMatchObject({ provider: "faux", model: "m" });
		expect(Number(calls[0].input_tokens)).toBeGreaterThan(0);
	}, 120_000);

	it("refuses a message whose ui block cannot be drawn or that names a widget it cannot show, and loads the widgets it can", async () => {
		const before = (await results("send_to_user")).length;
		await say(
			"show me",
			toolUse(fauxToolCall("send_to_user", { message: "Try:\n```ui\n<box><gauge/></box>\n```" })),
			toolUse(fauxToolCall("send_to_user", { message: "Here.", widgets: ["pim.nothing/here"] })),
			toolUse(fauxToolCall("send_to_user", { message: "Here are your goals.", widgets: ["pim.goals/active"] })),
		);
		const answered = (await results("send_to_user")).slice(before);
		expect(answered[0]).toMatch(/^Not sent: a ```ui block .*gauge/);
		expect(answered[1]).toContain("pim.nothing/here isn't a widget you can show");
		expect(answered[1]).toContain("pim.goals/active");
		// What the person was shown goes back to the model as the web app reads it: loaded once, as sent.
		expect(JSON.parse(answered[2]!).widgets).toMatchObject([{ id: "pim.goals/active", kind: "progress", items: [{ title: "Run a 5k", value: 0, max: 2, detail: "Run 2k" }] }]);
	}, 120_000);

	it("sends an approved HTTP request once, and a request whose outcome is unknown is never sent again", async () => {
		const request = { method: "POST", url: API, headers: { authorization: "Bearer secret-token" }, body: '{"sku":1}' };
		faux.setResponses([toolUse(fauxToolCall("http_request", request)), toolUse(fauxToolCall("send_to_user", { message: "Ordered." })), fauxAssistantMessage(`done ${++n}`)] as never);
		expect((await web.call("POST", `/api/sessions/${chatId}/messages`, { commandId: `m-${n}`, text: "place the order" })).status).toBe(202);
		const approval = await waitFor("the approval to be filed", async () => (await d.stack.admin.query("SELECT id, args FROM pim_app.approvals WHERE state = 'waiting'")).rows[0], 60_000);
		// What the person is shown is what will be sent, with the secret left out.
		expect(approval.args).toMatchObject({ method: "POST", url: API, headers: { authorization: "[redacted]" } });
		expect(sent).toHaveLength(0);
		expect((await web.call("POST", `/api/approvals/${approval.id}/decision`, { approve: true })).status).toBe(200);
		await waitFor("the turn to end", async () => ((await transcript()).includes(`done ${n}`) ? true : undefined), 60_000);
		expect(sent).toHaveLength(1);
		expect(sent[0]).toMatchObject({ method: "POST", url: API, body: '{"sku":1}' });
		expect(sent[0]!.headers["idempotency-key"]).toMatch(/^pim-/);
		expect((await d.stack.admin.query("SELECT state, tool_name FROM pim_runtime.external_operations WHERE owner_id = $1", [ownerId])).rows).toEqual([{ state: "completed", tool_name: "http_request" }]);

		// A standing approval stands in for the person; the connection then fails after the request may have gone out: it is not sent again and waits for reconciliation.
		const standing = await web.call("POST", "/api/admin/standing-approvals", { ownerId, action: "http:request", scope: { host: "93.184.216.34" } });
		expect(standing.status).toBe(201);
		failNext = true;
		await say("place it again", toolUse(fauxToolCall("http_request", { ...request, body: '{"sku":2}' })));
		failNext = false;
		expect((await results("http_request")).at(-1)).toMatch(/may or may not have reached/);
		expect(sent).toHaveLength(1);
		expect((await d.stack.admin.query("SELECT state FROM pim_runtime.external_operations WHERE owner_id = $1 ORDER BY created_at", [ownerId])).rows.map((r) => r.state)).toEqual(["completed", "needs_reconciliation"]);
	}, 120_000);

	it("starts a coding thread only under an admin's grant, through Forge", async () => {
		await say("start a coding thread", toolUse(fauxToolCall("coding_start", { task: "Fix the flaky test", repo: REPO })));
		expect((await results("coding_start"))[0]).toMatch(/no-coding-grant/);
		expect((await d.stack.admin.query("SELECT 1 FROM pim_forge.forge_threads WHERE owner_id = $1", [ownerId])).rowCount).toBe(0);

		expect((await web.call("POST", "/api/admin/coding-grants", { ownerId, permissions: ["coding:start", "coding:merge"], repositories: ["github.com/acme/*"], pools: ["default"] })).status).toBe(201);
		const forgeDb = d.stack.admin as unknown as ForgeDb;
		await new ForgeScheduler(forgeDb, new (await import("@pim/v2-forge/store")).ForgeStore(forgeDb), Date.now).upsertPool({ poolId: "default", provider: "local", size: 10 });
		await say("try again", toolUse(fauxToolCall("coding_start", { task: "Fix the flaky test", repo: REPO })), toolUse(fauxToolCall("send_to_user", { message: "Started." })));
		const threads = (await d.stack.admin.query("SELECT thread_id, repo, task FROM pim_forge.forge_threads WHERE owner_id = $1", [ownerId])).rows;
		expect(threads).toHaveLength(1);
		expect(threads[0]).toMatchObject({ task: "Fix the flaky test" });
		expect((await results("coding_start")).at(-1)).toContain(threads[0].thread_id);
		// Its state reads back through the tool, as the owner's.
		await say("how is it going?", toolUse(fauxToolCall("coding_status", { thread: threads[0].thread_id })));
		expect((await results("coding_status")).at(-1)).toContain(threads[0].thread_id);
	}, 120_000);
	it("manages agents, skills, schedules and triggers, and hands a task to another agent", async () => {
		await say("set things up", toolUse(fauxToolCall("create_agent", { name: "Poet", instructions: "Answer in verse." }), fauxToolCall("write_skill", { name: "haiku", description: "Write haiku", body: "Five, seven, five.", files: { "ref.md": "# ref" } })));
const agentId = (await d.stack.admin.query("SELECT id FROM pim_app.agents WHERE name = 'Poet'")).rows[0].id as string;
		const trigger = { version: 1, owningAgentId: agentId, originChatId: "api", label: "Hourly", instruction: "check in", source: { kind: "time", schedule: "cron", expression: "0 * * * *", timeZone: "UTC" }, condition: null, destination: { type: "new_chat" }, delivery: {}, authorizationRef: null };
		await say(
			"more",
			toolUse(fauxToolCall("read_skill", { name: "haiku" }), fauxToolCall("read_skill_file", { name: "haiku", path: "ref.md" }), fauxToolCall("schedule_task", { kind: "delay", spec: "3600000", prompt: "Stretch", target: "same_chat" }), fauxToolCall("create_trigger", { spec: trigger })),
			toolUse(fauxToolCall("list_scheduled_tasks", {}), fauxToolCall("list_triggers", {}), fauxToolCall("update_agent", { id: agentId, name: "Bard" }), fauxToolCall("delegate", { title: "Write a haiku", text: "About tea", agent_id: agentId })),
		);
		expect((await results("read_skill")).at(-1)).toContain("Five, seven, five.");
		expect((await results("read_skill_file")).at(-1)).toBe("# ref");
		expect((await d.stack.admin.query("SELECT name FROM pim_app.agents WHERE id = $1", [agentId])).rows[0].name).toBe("Bard");
		expect((await d.stack.admin.query("SELECT lifecycle FROM pim_app.triggers")).rows).toEqual([{ lifecycle: "draft" }]);
		expect((await d.stack.admin.query("SELECT kind, prompt FROM pim_app.schedules")).rows).toEqual([{ kind: "delay", prompt: "Stretch" }]);
		// The task has a chat of its own, started by this one, and a task row whose origin is the agent that asked.
		const task = (await d.stack.admin.query("SELECT t.task_id, t.status, t.origin_principal, c.agent_id, c.kind FROM pim_app.tasks t JOIN pim_app.conversations c ON c.public_chat_id = t.task_chat")).rows[0];
		expect(task).toMatchObject({ status: "working", agent_id: agentId, kind: "task", origin_principal: { kind: "agent", ownerId } });
	}, 120_000);
});
