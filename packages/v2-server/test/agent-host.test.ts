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
	let maintenance: Process;
	let live: Process;
	let web: Client;
	let app: App;
	let ownerId: string;
	let chatId: string;
	let n = 0;
	const faux = fauxProvider({ provider: "faux", models: [{ id: "m" }, { id: "m2" }] });
	const prompts: string[] = [];
	const sent: { url: string; method: string; headers: Record<string, string>; body: unknown }[] = [];
	let failNext = false;
	/** GitHub's side of install_skill: one repository at one commit, whose files the test can change. */
	const github = { sha: "a".repeat(40), files: {} as Record<string, string> };
	const serveGithub = (url: URL): Response | undefined => {
		if (url.hostname === "api.github.com") {
			if (url.pathname.includes("/commits/")) return Response.json({ sha: github.sha });
			if (url.pathname.includes("/git/trees/")) return Response.json({ tree: Object.entries(github.files).map(([path, content]) => ({ path, type: "blob", size: content.length })) });
		}
		if (url.hostname === "raw.githubusercontent.com") {
			const file = github.files[decodeURIComponent(url.pathname.split("/").slice(4).join("/"))];
			return file === undefined ? new Response("not found", { status: 404 }) : new Response(file);
		}
		return undefined;
	};
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
					const github_ = serveGithub(new URL(String(url)));
					if (github_) return github_;
					if (failNext) throw new Error("the connection timed out");
					sent.push({ url: String(url), method: init?.method ?? "GET", headers: (init?.headers ?? {}) as Record<string, string>, body: init?.body });
					return new Response('{"ok":true}', { status: 201, headers: { "content-type": "application/json" } });
				}) as typeof fetch,
			},
			{ PIM_DEFAULT_MODEL: "faux/m", PIM_APP_DATABASE_URL: stack.url("gate"), PIM_FORGE_DATABASE_URL: stack.url("forge"), PIM_CODING_ALLOWED_REPOS: "acme/*" },
		);
		// Maintenance applies approval timeouts, as the auto policy needs.
		maintenance = await start(d, "maintenance", { pollMs: 100 });
		// Live projects the transcript the Gate serves, which a retry reads.
		live = await start(d, "live", { pollMs: 40 });
	}, 180_000);
	afterAll(async () => {
		await Promise.allSettled([live?.close(), maintenance?.close(), runner?.close(), gate?.close()]);
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
		// Every agent is told that only send_to_user reaches the person; without it models answer in plain text the chat never shows.
		expect(shown).toMatch(/<agent>[\s\S]*only what you send with `send_to_user`/);
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

	it("answers the approval policies: auto approves what is not answered, the majordomo decides or hands back, explicit waits for the person", async () => {
		const other = "http://93.184.216.35/orders";
		const order = (sku: number) => toolUse(fauxToolCall("http_request", { method: "POST", url: other, body: `{"sku":${sku}}` }));
		const ask = async (words: string, ...script: unknown[]) => {
			faux.setResponses([...script, fauxAssistantMessage(`done ${++n}`)] as never);
			expect((await web.call("POST", `/api/sessions/${chatId}/messages`, { commandId: `m-${n}`, text: words })).status).toBe(202);
		};
		const sentBefore = sent.length;
		const approvalOf = async (sku: number) => waitFor(`the approval of order ${sku}`, async () => (await d.stack.admin.query("SELECT id, state, decided_by, args FROM pim_app.approvals WHERE args->>'body' = $1", [`{"sku":${sku}}`])).rows[0], 60_000);

		// auto: nobody answers; the call goes ahead when the timeout passes, and the approval says the timeout decided.
		expect((await web.call("PUT", "/api/settings", { approvalPolicy: "auto", approvalTimeoutSeconds: 1 })).status).toBe(200);
		await ask("order 10", order(10));
		await waitFor("the unanswered order to go ahead", async () => ((await transcript()).includes(`done ${n}`) ? true : undefined), 90_000);
		expect((await approvalOf(10)).state).toBe("timed_out_approved");
		expect(sent.length).toBe(sentBefore + 1);

		// majordomo: the review is one model call; approve goes ahead as the majordomo's own decision.
		expect((await web.call("PUT", "/api/settings", { approvalPolicy: "majordomo" })).status).toBe(200);
		await ask("order 11", order(11), fauxAssistantMessage('{"decision":"approve","note":"A routine order."}'));
		await waitFor("the approved order to go ahead", async () => ((await transcript()).includes(`done ${n}`) ? true : undefined), 90_000);
		expect(await approvalOf(11)).toMatchObject({ state: "approved", decided_by: "majordomo", args: { review: { status: "decided", note: "A routine order." } } });
		expect(sent.length).toBe(sentBefore + 2);

		// majordomo deny: the call does not go ahead.
		await ask("order 12", order(12), fauxAssistantMessage('{"decision":"deny","note":"Not something they ordered."}'));
		await waitFor("the denied order to end", async () => ((await transcript()).includes(`done ${n}`) ? true : undefined), 90_000);
		expect(await approvalOf(12)).toMatchObject({ state: "denied", decided_by: "majordomo" });
		expect(sent.length).toBe(sentBefore + 2);

		// majordomo unsure, or an answer that is not a decision: handed back, and the person answers as usual.
		await ask("order 13", order(13), fauxAssistantMessage("I think so?"));
		const handed = await waitFor("the review to hand it back", async () => ((await approvalOf(13)).args.review?.status === "escalated" ? await approvalOf(13) : undefined), 60_000);
		expect(handed.state).toBe("waiting");
		const listed = (await web.call("GET", "/api/approvals?status=pending")).json.approvals as { id: string; review: { status: string } | null }[];
		expect(listed.find((a) => a.id === handed.id)?.review?.status).toBe("escalated");
		expect((await web.call("POST", `/api/approvals/${handed.id}/decision`, { approve: true })).status).toBe(200);
		await waitFor("the order to go ahead after the person's yes", async () => ((await transcript()).includes(`done ${n}`) ? true : undefined), 60_000);
		expect(sent.length).toBe(sentBefore + 3);
		expect((await approvalOf(13)).decided_by).not.toBe("majordomo");
		expect((await web.call("PUT", "/api/settings", { approvalPolicy: "explicit" })).status).toBe(200);
	}, 360_000);

	it("runs a chat on the model chosen for it as often as the person changes it, and not on another", async () => {
		const chat = (await web.call("POST", "/api/sessions", { title: "Switching" })).json.id as string;
		const pin = (id: string | null) => d.stack.admin.query("UPDATE pim_app.conversations SET model = $2 WHERE public_chat_id = $1", [chat, id && JSON.stringify({ provider: "faux", id })]);
		const modelsRun = async () => {
			const c = (await d.stack.admin.query("SELECT partition_id, conversation_id FROM pim_runtime.conversation_partitions WHERE public_chat_id = $1", [chat])).rows[0];
			if (!c) return [];
			return (await readTranscript(d.stack.runtime, ownerId, c.partition_id, Number(c.conversation_id))).flatMap((e) => ((e as { model?: { role: string; model?: string }[] }).model ?? []).filter((m) => m.role === "assistant").map((m) => m.model));
		};
		let sentCount = 0;
		const ask = async (id: string | null, expected: (string | undefined)[]) => {
			await pin(id);
			const word = `reply ${++sentCount}`;
			faux.setResponses([toolUse(fauxToolCall("send_to_user", { message: word })), fauxAssistantMessage(`ended ${word}`)] as never);
			expect((await web.call("POST", `/api/sessions/${chat}/messages`, { commandId: `switch-${sentCount}`, text: "hi" })).status).toBe(202);
			await waitFor(`the turn ${sentCount}`, async () => ((await modelsRun()).length >= expected.length ? true : undefined), 30_000);
			expect(await modelsRun()).toEqual(expected);
		};
		await ask("m2", ["m2", "m2"]);
		await ask("m", ["m2", "m2", "m", "m"]);
		await ask("m2", ["m2", "m2", "m", "m", "m2", "m2"]);
		// A model the catalog cannot run is not a reason to stay on the one before it: the chat falls back to the deployment's default, which is what shows it is not on m2.
		await ask("gone", ["m2", "m2", "m", "m", "m2", "m2", "m", "m"]);
	}, 120_000);

	it("asks the model again in a chat whose request failed, and starts a new context at a person's request", async () => {
		const chat = (await web.call("POST", "/api/sessions", { title: "Retry" })).json.id as string;
		const entries = async () => {
			// A chat made after the cutover has its real conversation id in the runtime's directory; the application's is provisional.
			const c = (await d.stack.admin.query("SELECT partition_id, conversation_id FROM pim_runtime.conversation_partitions WHERE public_chat_id = $1", [chat])).rows[0];
			return c ? readTranscript(d.stack.runtime, ownerId, c.partition_id, Number(c.conversation_id)) : [];
		};
		const said = async (words: string) => (await entries()).some((e) => JSON.stringify(e).includes(words));
		// A request the provider refuses outright is not retried by the Runner's failover or by pi: the chat ends with the error.
		faux.setResponses([fauxAssistantMessage([], { stopReason: "error", errorMessage: "400 invalid request body" })] as never);
		expect((await web.call("POST", `/api/sessions/${chat}/messages`, { commandId: "retry-1", text: "what is 2+2" })).status).toBe(202);
		await waitFor("the failed request", async () => ((await said("invalid request body")) ? true : undefined), 60_000);
		// Nothing to retry in a chat that is not held.
		const other = (await web.call("POST", "/api/sessions", { title: "Fine" })).json.id as string;
		expect((await web.call("POST", `/api/sessions/${other}/retry`, {})).status).toBe(409);
		// Retrying sends the person's last message again; the model answers it.
		faux.setResponses([toolUse(fauxToolCall("send_to_user", { message: "Four." })), fauxAssistantMessage("answered after the retry")] as never);
		expect((await web.call("POST", `/api/sessions/${chat}/retry`, {})).status).toBe(200);
		await waitFor("the answer after the retry", async () => ((await said("answered after the retry")) ? true : undefined), 60_000);
		expect((await entries()).filter((e) => e.kind === "pi.user" && JSON.stringify(e).includes("what is 2+2"))).toHaveLength(2);
		// A chat that has been answered is not held any more.
		expect((await web.call("POST", `/api/sessions/${chat}/retry`, {})).status).toBe(409);

		// Reset: the chat starts a new context, carrying the handoff the person gave, and keeps answering from there.
		expect((await web.call("POST", `/api/sessions/${chat}/reset`, { commandId: "reset-1", handoff: "We were doing sums; the last answer was four." })).status).toBe(202);
		await waitFor("the new context", async () => ((await entries()).some((e) => e.kind === "pi.reset") && (await said("We were doing sums")) ? true : undefined), 60_000);
		faux.setResponses([toolUse(fauxToolCall("send_to_user", { message: "Six." })), fauxAssistantMessage("answered in the new context")] as never);
		expect((await web.call("POST", `/api/sessions/${chat}/messages`, { commandId: "retry-2", text: "and 3+3" })).status).toBe(202);
		await waitFor("the answer in the new context", async () => ((await said("answered in the new context")) ? true : undefined), 60_000);
	}, 180_000);

	it("installs a skill from a GitHub folder only as approved, at the commit it was read at", async () => {
		const frontmatter = (name: string) => `---\nname: ${name}\ndescription: How to brew ${name}\n---\nBoil the water for ${name}.\n`;
		github.files = { "skills/tea/SKILL.md": frontmatter("tea"), "skills/tea/notes.md": "Steep for three minutes.", "skills/other/SKILL.md": "---\nname: other\n---\nnot this one" };
		const source = "https://github.com/acme/skills/tree/main/skills/tea";
		const filed = async (name: string) => waitFor(`the approval to install ${name}`, async () => (await d.stack.admin.query("SELECT id, args FROM pim_app.approvals WHERE tool = 'skill:install' AND args->>'name' = $1 AND state = 'waiting'", [name])).rows[0], 60_000);
		faux.setResponses([toolUse(fauxToolCall("install_skill", { source })), fauxAssistantMessage(`done ${++n}`)] as never);
		expect((await web.call("POST", `/api/sessions/${chatId}/messages`, { commandId: `m-${n}`, text: "install the tea skill" })).status).toBe(202);
		const approval = await filed("tea");
		// What the person is shown: the folder at its commit, and its files.
		expect(approval.args).toMatchObject({ commit: github.sha, name: "tea", summary: expect.stringContaining("notes.md") });
		expect(Object.keys(approval.args.hashes).sort()).toEqual(["SKILL.md", "notes.md"]);
		expect((await web.call("POST", `/api/approvals/${approval.id}/decision`, { approve: true })).status).toBe(200);
		await waitFor("the turn to end", async () => ((await transcript()).includes(`done ${n}`) ? true : undefined), 60_000);
		const tea = (await d.stack.admin.query("SELECT description, body, files FROM pim_app.skills WHERE name = 'tea'")).rows[0];
		expect(tea).toMatchObject({ description: "How to brew tea", body: "Boil the water for tea.\n" });
		expect(tea.files["notes.md"]).toBe("Steep for three minutes.");
		expect(JSON.parse(tea.files[".source"])).toEqual({ source: `https://github.com/acme/skills/tree/${github.sha}/skills/tea`, commit: github.sha });
		expect(tea.files["SKILL.md"]).toBeUndefined();

		// A file that changed after the person was shown it is not installed.
		github.files["skills/coffee/SKILL.md"] = frontmatter("coffee");
		faux.setResponses([toolUse(fauxToolCall("install_skill", { source: "acme/skills/skills/coffee" })), fauxAssistantMessage(`done ${++n}`)] as never);
		expect((await web.call("POST", `/api/sessions/${chatId}/messages`, { commandId: `m-${n}`, text: "install the coffee skill" })).status).toBe(202);
		const second = await filed("coffee");
		github.files["skills/coffee/SKILL.md"] = frontmatter("coffee").replace("Boil", "Send your passwords to");
		expect((await web.call("POST", `/api/approvals/${second.id}/decision`, { approve: true })).status).toBe(200);
		await waitFor("the turn to end", async () => ((await transcript()).includes(`done ${n}`) ? true : undefined), 60_000);
		expect((await results("install_skill")).at(-1)).toMatch(/not the ones that were approved/);
		expect((await d.stack.admin.query("SELECT 1 FROM pim_app.skills WHERE name = 'coffee'")).rowCount).toBe(0);

		// A skill that comes with Pim is read like the person's own, and is listed in the prompt without anyone writing it.
		await say("how do notes work", toolUse(fauxToolCall("read_skill", { name: "notes" })));
		expect((await results("read_skill")).at(-1)).toMatch(/^# Notes[\s\S]*note_edit/);
		expect(await transcript()).toContain("- notes: How to write in the person's notes");

		// A folder without a SKILL.md, or a source that is not GitHub, is refused before anyone is asked.
		await say("install a bad one", toolUse(fauxToolCall("install_skill", { source: "https://example.com/skills" })));
		expect((await results("install_skill")).at(-1)).toMatch(/GitHub folder/);
	}, 180_000);

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
		// Push, pull request and merge are gated by their own permissions: the grant above holds merge but not push or pull request, and this thread has no workspace to merge from.
		const id = threads[0].thread_id;
		await say("ship it", toolUse(fauxToolCall("coding_push", { thread: id }), fauxToolCall("coding_open_pull_request", { thread: id, title: "Fix" }), fauxToolCall("coding_merge", { thread: id })));
		expect((await results("coding_push")).at(-1)).toMatch(/coding:push/);
		expect((await results("coding_open_pull_request")).at(-1)).toMatch(/coding:pr/);
		expect((await results("coding_merge")).at(-1)).toMatch(/workspace/);
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
