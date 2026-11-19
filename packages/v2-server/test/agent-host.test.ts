// The default agent host on the real stack: a Runner started without any `harnessOptions` runs a real Pim agent. The only thing given to it is a model provider (pi-ai's
// faux one, as a deployment's own provider would be) and the databases the tools write through. The agent keeps notes and goals, creates a note and an app, makes an
// HTTP request that is sent at once and only once, and starts a coding thread under an admin's grant; every model call lands in the cost ledger.
import { randomBytes } from "node:crypto";
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
import { createStack, describeWith, freePort, hasNats, sentAndAnswered, startNats } from "./support/stack.ts";

const real = describeWith(hasNats());
const REPO = "https://github.com/acme/app";
const KEK = { PIM_KEK_K1: randomBytes(32).toString("base64"), PIM_KEK_CURRENT: "k1" };
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
	const efforts: unknown[] = [];
	const seen = (message: ReturnType<typeof fauxAssistantMessage>) => (ctx: { systemPrompt?: string }, options?: { reasoning?: unknown }) => (prompts.push(ctx.systemPrompt ?? ""), efforts.push(options?.reasoning), message);

	const say = async (words: string, ...script: unknown[]) => {
		// Every turn ends the way an agent must: by sending its answer, which finishes the turn.
		faux.setResponses([...script, toolUse(fauxToolCall("send_to_user", { message: `done ${++n}` }))] as never);
		expect((await web.call("POST", `/api/sessions/${chatId}/messages`, { commandId: `m-${n}`, text: words })).status).toBe(202);
		await waitFor(`the turn "${words}" to end`, async () => {
			const text = await transcript();
			const parts = (JSON.parse(text) as { model?: { content?: { type?: string }[] }[] }[]).flatMap((e) => e.model ?? []);
			const calls = parts.flatMap((m) => (Array.isArray(m.content) ? m.content : [])).filter((c) => c.type === "toolCall").length;
			return text.includes(`done ${n}`) && calls === parts.filter((m) => (m as { role?: string }).role === "toolResult").length ? true : undefined;
		}, 60_000);
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
		gate = await start(d, "gate", {}, { PIM_CODING_ALLOWED_REPOS: "acme/*", ...KEK });
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
					// A page that names an image, and the image: what `send_to_user` may show only once a tool's result gave its address.
					if (String(url) === "http://93.184.216.34/page") return new Response('{"image":"http://93.184.216.34/cat.png"}');
					if (String(url) === "http://93.184.216.34/cat.png") return new Response(Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==", "base64"), { headers: { "content-type": "image/png" } });
					if (failNext) throw new Error("the connection timed out");
					sent.push({ url: String(url), method: init?.method ?? "GET", headers: (init?.headers ?? {}) as Record<string, string>, body: init?.body });
					return new Response('{"ok":true}', { status: 201, headers: { "content-type": "application/json" } });
				}) as typeof fetch,
			},
			{ PIM_DEFAULT_MODEL: "faux/m", PIM_APP_DATABASE_URL: stack.url("gate"), PIM_FORGE_DATABASE_URL: stack.url("forge"), PIM_CODING_ALLOWED_REPOS: "acme/*", ...KEK },
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
		);
		const rows = async (sql: string) => (await d.stack.admin.query(sql)).rows;
		expect((await rows("SELECT scope, title FROM pim_app.memories")).map((r) => [r.scope, r.title])).toEqual([["everyone", "Tea"]]);
		expect((await rows("SELECT g.title, count(s.*)::int AS steps FROM pim_app.goals g JOIN pim_app.goal_steps s ON s.goal_id = g.id GROUP BY g.title"))[0]).toMatchObject({ title: "Run a 5k", steps: 2 });
		expect((await rows("SELECT title, version FROM pim_app.notes"))[0]).toMatchObject({ title: "Plan" });
		expect((await rows("SELECT title, kind FROM pim_app.artifacts"))[0]).toMatchObject({ title: "Tracker", kind: "html" });
		expect((await results("recall"))[0]).toContain("Tea");
		// The app comes back as the reference the web app shows as a card and opens in the canvas.
		expect(JSON.parse((await results("app_create"))[0]!).artifact).toMatchObject({ title: "Tracker", kind: "html", version: 1 });
		// A note comes back as a markdown reference too, with its text's version, so the chat draws a card that opens it.
		expect(JSON.parse((await results("note_create"))[0]!).artifact).toMatchObject({ title: "Plan", kind: "markdown", version: 1, size: "Week one: run 2k".length });
		// The next turn's prompt carries what the agent knows: who it is, its goals, its memory.
		await say("what do you know?", seen(toolUse(fauxToolCall("current_time", {}))) as never);
		expect(prompts).toHaveLength(1);
		// Every chat runs at a low reasoning effort, as in v1.
		expect(efforts).toEqual(["low"]);
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
		// A chat's calls are attributed to the chat, which is what its cost and activity read.
		expect(new Set((await rows("SELECT public_chat_id, run_kind FROM pim_app.model_calls WHERE run_kind = 'chat'")).map((r) => r.public_chat_id))).toEqual(new Set([chatId]));
		const priced = (await web.call("GET", `/api/sessions/${chatId}/cost`)).json;
		expect(priced.models).toEqual([expect.objectContaining({ provider: "faux", model: "m" })]);
		expect((await web.call("GET", `/api/sessions/${chatId}/activity`)).json.steps.length).toBeGreaterThanOrEqual(5);
	}, 120_000);

	it("answers note_edit and note_show with the note's card, and shows a note without changing it", async () => {
		const note = JSON.parse((await results("note_create"))[0]!).artifact as { id: string };
		await say("tweak the plan", toolUse(fauxToolCall("note_read", { id: note.id })), toolUse(fauxToolCall("note_edit", { id: note.id, base_version: 1, find: "run 2k", replace: "run 3k" })), toolUse(fauxToolCall("note_show", { id: note.id })));
		const edited = JSON.parse((await results("note_edit")).at(-1)!);
		expect(edited.artifact).toMatchObject({ id: note.id, title: "Plan", kind: "markdown", version: 2, size: "Week one: run 3k".length, sha256: expect.stringMatching(/^[0-9a-f]{64}$/) });
		const shown = JSON.parse((await results("note_show")).at(-1)!);
		expect(shown.artifact).toEqual(edited.artifact);
		expect((await d.stack.admin.query("SELECT kept_version FROM pim_app.notes WHERE note_id = $1", [note.id])).rows[0].kept_version).toBe(2);
		await say("show a missing one", toolUse(fauxToolCall("note_show", { id: "n_nope" })));
		expect((await results("note_show")).at(-1)).toBe("No such note");
	}, 120_000);

	it("refuses a message whose ui block cannot be drawn or that names a widget it cannot show, and loads the widgets it can", async () => {
		const before = (await results("send_to_user")).length;
		await say(
			"show me",
			toolUse(fauxToolCall("send_to_user", { message: "Try:\n```ui\n<box><gauge/></box>\n```" })),
			toolUse(fauxToolCall("send_to_user", { message: 'Try:\n```ui\n{"type":"form","fields":[{"name":"a"}]}\n```' })),
			toolUse(fauxToolCall("send_to_user", { message: 'Try:\n```ui\n<form id="f"><number name="a" answer={1}/></form>\n```', complete: false })),
			toolUse(fauxToolCall("send_to_user", { message: "Here.", widgets: ["pim.nothing/here"] })),
			toolUse(fauxToolCall("send_to_user", { message: "Here are your goals.", widgets: ["pim.goals/active"], complete: false })),
		);
		const answered = (await results("send_to_user")).slice(before);
		expect(answered[0]).toMatch(/^Not sent: a ```ui block .*gauge/);
		expect(answered[1]).toMatch(/^Not sent: a ```ui block .*didn't parse/);
		// The message's id and its ui blocks' ids go back too, for ui_state and the route that keeps a block's state.
		expect(JSON.parse(answered[2]!)).toMatchObject({ sent: "Sent.", message: expect.stringMatching(/^\d+$/), uiBlocks: [{ id: expect.stringMatching(/^[0-9a-f]{14}$/), label: expect.any(String) }] });
		expect(answered[3]).toContain("pim.nothing/here isn't a widget you can show");
		expect(answered[3]).toContain("pim.goals/active");
		// What the person was shown goes back to the model as the web app reads it: loaded once, as sent.
		expect(JSON.parse(answered[4]!).widgets).toMatchObject([{ id: "pim.goals/active", kind: "progress", items: [{ title: "Run a 5k", value: 0, max: 2, detail: "Run 2k" }] }]);
	}, 120_000);

	it("sends an HTTP request at once, and only once: a request whose outcome is unknown is never sent again", async () => {
		const request = { method: "POST", url: API, headers: { authorization: "Bearer secret-token" }, body: '{"sku":1}' };
		await say("place the order", toolUse(fauxToolCall("http_request", request)));
		expect(sent).toHaveLength(1);
		expect(sent[0]).toMatchObject({ method: "POST", url: API, body: '{"sku":1}' });
		expect(sent[0]!.headers["idempotency-key"]).toMatch(/^pim-/);
		expect((await d.stack.admin.query("SELECT count(*)::int AS n FROM pim_app.approvals WHERE tool = 'http:request'")).rows[0].n).toBe(0);
		expect((await d.stack.admin.query("SELECT state, tool_name FROM pim_runtime.external_operations WHERE owner_id = $1", [ownerId])).rows).toEqual([{ state: "completed", tool_name: "http_request" }]);

		// The connection fails after the request may have gone out: it is not sent again and waits for reconciliation.
		failNext = true;
		await say("place it again", toolUse(fauxToolCall("http_request", { ...request, body: '{"sku":2}' })));
		failNext = false;
		expect((await results("http_request")).at(-1)).toMatch(/may or may not have reached/);
		expect(sent).toHaveLength(1);
		expect((await d.stack.admin.query("SELECT state FROM pim_runtime.external_operations WHERE owner_id = $1 ORDER BY created_at", [ownerId])).rows.map((r) => r.state)).toEqual(["completed", "needs_reconciliation"]);
	}, 120_000);

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
			faux.setResponses([toolUse(fauxToolCall("send_to_user", { message: word }))] as never);
			expect((await web.call("POST", `/api/sessions/${chat}/messages`, { commandId: `switch-${sentCount}`, text: "hi" })).status).toBe(202);
			await waitFor(`the turn ${sentCount}`, async () => ((await modelsRun()).length >= expected.length ? true : undefined), 30_000);
			expect(await modelsRun()).toEqual(expected);
		};
		await ask("m2", ["m2"]);
		await ask("m", ["m2", "m"]);
		await ask("m2", ["m2", "m", "m2"]);
		// A model the catalog cannot run is not a reason to stay on the one before it: the chat falls back to the deployment's default, which is what shows it is not on m2.
		await ask("gone", ["m2", "m", "m2", "m"]);
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
		// The runtime's transcript is ahead of Live's projection, which a retry reads: wait until the error is the last message the Gate would see.
		await waitFor("the error projected as the chat's last message", async () => {
			const last = (await d.stack.admin.query("SELECT message FROM pim_projection.chat_transcript_projection WHERE chat_id = $1 AND NOT partial ORDER BY position DESC LIMIT 1", [chat])).rows[0]?.message;
			return last?.role === "assistant" && last.stopReason === "error" ? true : undefined;
		}, 60_000);
		// Nothing to retry in a chat that is not held.
		const other = (await web.call("POST", "/api/sessions", { title: "Fine" })).json.id as string;
		expect((await web.call("POST", `/api/sessions/${other}/retry`, {})).status).toBe(409);
		// The failed run is held, so retrying asks the model again where it stopped: it answers, and the message is in the transcript once.
		faux.setResponses([toolUse(fauxToolCall("send_to_user", { message: "Four." }))] as never);
		expect((await web.call("POST", `/api/sessions/${chat}/retry`, {})).status).toBe(200);
		await waitFor("the answer after the retry", async () => ((await said("Four.")) ? true : undefined), 60_000);
		expect((await entries()).filter((e) => e.kind === "pi.user" && JSON.stringify(e).includes("what is 2+2"))).toHaveLength(1);
		// A chat that has been answered is not held any more.
		expect((await web.call("POST", `/api/sessions/${chat}/retry`, {})).status).toBe(409);

		// Reset: the chat starts a new context, carrying the handoff the person gave, and keeps answering from there.
		expect((await web.call("POST", `/api/sessions/${chat}/reset`, { commandId: "reset-1", handoff: "We were doing sums; the last answer was four." })).status).toBe(202);
		await waitFor("the new context", async () => ((await entries()).some((e) => e.kind === "pi.reset") && (await said("We were doing sums")) ? true : undefined), 60_000);
		faux.setResponses([toolUse(fauxToolCall("send_to_user", { message: "Six." }))] as never);
		expect((await web.call("POST", `/api/sessions/${chat}/messages`, { commandId: "retry-2", text: "and 3+3" })).status).toBe(202);
		await waitFor("the answer in the new context", async () => ((await said("Six.")) ? true : undefined), 60_000);
	}, 180_000);

	it("forks a chat at a message of the agent's, or before one of the person's so it can be sent again changed", async () => {
		const shown = async (chat: string) => (await d.stack.admin.query("SELECT entry_id, message FROM pim_projection.chat_transcript_projection WHERE chat_id = $1 AND NOT partial ORDER BY position", [chat])).rows as { entry_id: string; message: { role: string; parts: { text?: string }[] } }[];
		const texts = async (chat: string) => JSON.stringify((await shown(chat)).map((r) => r.message));
		const turn = async (chat: string, text: string, answer: string) => {
			faux.setResponses([toolUse(fauxToolCall("send_to_user", { message: answer }))] as never);
			expect((await web.call("POST", `/api/sessions/${chat}/messages`, { commandId: `fork-${answer}`, text })).status).toBe(202);
			// The answer and the result of its send are both in the chat as the Gate shows it: a fork at the answer has them.
			await waitFor(`the turn ended ${answer}`, async () => {
				const rows = (await shown(chat)).map((r) => r.message);
				const at = rows.findIndex((m) => m.role === "assistant" && JSON.stringify(m).includes(answer));
				return at >= 0 && rows.slice(at + 1).some((m) => m.role === "tool") ? true : undefined;
			}, 60_000);
		};
		const chat = (await web.call("POST", "/api/sessions", { title: "Trip" })).json.id as string;
		await turn(chat, "first question", "first answer");
		await turn(chat, "second question", "second answer");
		const parent = await shown(chat);
		const user = parent.filter((r) => r.message.role === "user");
		expect(user).toHaveLength(2);

		// What can't be forked there is refused: an agent's message to edit, a person's to fork at, and a message that isn't in the chat.
		const assistant = parent.find((r) => r.message.role === "assistant")!;
		expect((await web.call("POST", `/api/sessions/${chat}/fork`, { before: assistant.entry_id })).status).toBe(400);
		expect((await web.call("POST", `/api/sessions/${chat}/fork`, { at: user[0]!.entry_id })).status).toBe(400);
		expect((await web.call("POST", `/api/sessions/${chat}/fork`, { before: "999999999" })).status).toBe(400);
		expect((await web.call("POST", `/api/sessions/${chat}/fork`, {})).status).toBe(400);

		// Editing the second question: a fork that has what came before it, and nothing from it on.
		const edited = await web.call("POST", `/api/sessions/${chat}/fork`, { before: user[1]!.entry_id });
		expect(edited.status).toBe(200);
		const fork = edited.json.id as string;
		expect(fork).not.toBe(chat);
		expect(edited.json.title).toBe("Trip (fork #1)");
		const before = parent.slice(0, parent.findIndex((r) => r.entry_id === user[1]!.entry_id));
		await waitFor("the fork's transcript", async () => ((await shown(fork)).length === before.length ? true : undefined), 60_000);
		expect((await shown(fork)).map((r) => r.entry_id)).toEqual(before.map((r) => r.entry_id));
		// Sending the edited message goes to the fork, which asks the model with the first exchange and the edit, not the question it replaced.
		await turn(fork, "second question, reworded", "reworded answer");
		expect(await texts(fork)).toContain("first answer");
		expect(await texts(fork)).not.toContain('"second question"');
		expect(await texts(chat)).not.toContain("reworded");
		expect((await shown(chat)).map((r) => r.entry_id)).toEqual(parent.map((r) => r.entry_id));

		// A fork at the agent's first message, which called a tool, ends after that tool's result so nothing is left unanswered; its number goes on from the first fork's.
		const at = await web.call("POST", `/api/sessions/${chat}/fork`, { at: assistant.entry_id });
		expect(at.status).toBe(200);
		expect(at.json.title).toBe("Trip (fork #2)");
		const through = parent[parent.findIndex((r) => r.entry_id === assistant.entry_id) + 1]!;
		expect(through.message.role).toBe("tool");
		await waitFor("the fork at a message", async () => ((await shown(at.json.id)).at(-1)?.entry_id === through.entry_id ? true : undefined), 60_000);

		// Editing the first message leaves nothing before it: a new chat, not a fork.
		const fresh = await web.call("POST", `/api/sessions/${chat}/fork`, { before: user[0]!.entry_id });
		expect(fresh.status).toBe(200);
		expect((await d.stack.admin.query("SELECT forked_from FROM pim_app.conversations WHERE public_chat_id = $1", [fresh.json.id])).rows[0].forked_from).toBeNull();
		await turn(fresh.json.id, "first question, reworded", "fresh answer");
	}, 180_000);

	it("installs a skill from a GitHub folder only as approved, at the commit it was read at", async () => {
		const frontmatter = (name: string) => `---\nname: ${name}\ndescription: How to brew ${name}\n---\nBoil the water for ${name}.\n`;
		github.files = { "skills/tea/SKILL.md": frontmatter("tea"), "skills/tea/notes.md": "Steep for three minutes.", "skills/other/SKILL.md": "---\nname: other\n---\nnot this one" };
		const source = "https://github.com/acme/skills/tree/main/skills/tea";
		const filed = async (name: string) => waitFor(`the approval to install ${name}`, async () => (await d.stack.admin.query("SELECT id, args FROM pim_app.approvals WHERE tool = 'skill:install' AND args->>'name' = $1 AND state = 'waiting'", [name])).rows[0], 60_000);
		faux.setResponses([toolUse(fauxToolCall("install_skill", { source })), toolUse(fauxToolCall("send_to_user", { message: `done ${++n}` }))] as never);
		expect((await web.call("POST", `/api/sessions/${chatId}/messages`, { commandId: `m-${n}`, text: "install the tea skill" })).status).toBe(202);
		const approval = await filed("tea");
		// What the person is shown: the folder at its commit, and its files.
		expect(approval.args).toMatchObject({ commit: github.sha, name: "tea", summary: expect.stringContaining("notes.md") });
		expect(Object.keys(approval.args.hashes).sort()).toEqual(["SKILL.md", "notes.md"]);
		expect((await web.call("POST", `/api/approvals/${approval.id}/decision`, { approve: true })).status).toBe(200);
		await waitFor("the turn to end", async () => (sentAndAnswered(await transcript(), `done ${n}`) ? true : undefined), 60_000);
		const tea = (await d.stack.admin.query("SELECT description, body, files FROM pim_app.skills WHERE name = 'tea'")).rows[0];
		expect(tea).toMatchObject({ description: "How to brew tea", body: "Boil the water for tea.\n" });
		expect(tea.files["notes.md"]).toBe("Steep for three minutes.");
		expect(JSON.parse(tea.files[".source"])).toEqual({ source: `https://github.com/acme/skills/tree/${github.sha}/skills/tea`, commit: github.sha });
		expect(tea.files["SKILL.md"]).toBeUndefined();

		// A file that changed after the person was shown it is not installed.
		github.files["skills/coffee/SKILL.md"] = frontmatter("coffee");
		faux.setResponses([toolUse(fauxToolCall("install_skill", { source: "acme/skills/skills/coffee" })), toolUse(fauxToolCall("send_to_user", { message: `done ${++n}` }))] as never);
		expect((await web.call("POST", `/api/sessions/${chatId}/messages`, { commandId: `m-${n}`, text: "install the coffee skill" })).status).toBe(202);
		const second = await filed("coffee");
		github.files["skills/coffee/SKILL.md"] = frontmatter("coffee").replace("Boil", "Send your passwords to");
		expect((await web.call("POST", `/api/approvals/${second.id}/decision`, { approve: true })).status).toBe(200);
		await waitFor("the turn to end", async () => (sentAndAnswered(await transcript(), `done ${n}`) ? true : undefined), 60_000);
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
		await say("try again", toolUse(fauxToolCall("coding_start", { task: "Fix the flaky test", repo: REPO })));
		const threads = (await d.stack.admin.query("SELECT thread_id, repo, task FROM pim_forge.forge_threads WHERE owner_id = $1", [ownerId])).rows;
		expect(threads).toHaveLength(1);
		expect(threads[0]).toMatchObject({ task: "Fix the flaky test" });
		expect((await results("coding_start")).at(-1)).toContain(threads[0].thread_id);
		// Its state reads back through the tool, as the owner's.
		await say("how is it going?", toolUse(fauxToolCall("coding_status", { thread: threads[0].thread_id })));
		expect((await results("coding_status")).at(-1)).toContain(threads[0].thread_id);
		// v1's spelling and shapes still work: `thread_id`, a brief that never carries what signs the thread's grants, a list when no thread is named, a diff that says nothing is committed yet.
		await say("v1 style", toolUse(fauxToolCall("coding_status", { thread_id: threads[0].thread_id }), fauxToolCall("coding_status", {}), fauxToolCall("coding_diff", { thread_id: threads[0].thread_id })));
		const [one, list] = (await results("coding_status")).slice(-2).map((r) => JSON.parse(r));
		expect(one).toMatchObject({ thread_id: threads[0].thread_id, repo: REPO, harness: "pi", task: "Fix the flaky test", turn_under_way: false });
		expect(JSON.stringify(one)).not.toMatch(/gatewayNonce|gateway_nonce|leaseHolder/);
		expect(list).toEqual({ threads: [expect.objectContaining({ thread_id: threads[0].thread_id, task: "Fix the flaky test", status: expect.any(String) })] });
		expect((await results("coding_diff")).at(-1)).toMatch(/Nothing committed yet/);
		// Push, pull request and merge are gated by their own permissions: the grant above holds merge but not push or pull request, and this thread has no workspace to merge from.
		const id = threads[0].thread_id;
		await say("ship it", toolUse(fauxToolCall("coding_push", { thread: id }), fauxToolCall("coding_open_pull_request", { thread: id, title: "Fix" }), fauxToolCall("coding_merge", { thread: id })));
		expect((await results("coding_push")).at(-1)).toMatch(/coding:push/);
		expect((await results("coding_open_pull_request")).at(-1)).toMatch(/coding:pr/);
		expect((await results("coding_merge")).at(-1)).toMatch(/workspace/);
	}, 120_000);
	it("shows a person the push, pull request or merge Forge needs them to approve, and carries their answer back to it", async () => {
		const id = (await d.stack.admin.query("SELECT thread_id FROM pim_forge.forge_threads WHERE owner_id = $1", [ownerId])).rows[0].thread_id as string;
		const granted = await web.call("POST", "/api/admin/coding-grants", { ownerId, permissions: ["coding:pr"], repositories: ["github.com/acme/*"], pools: ["default"] });
		expect(granted.status).toBe(201);
		const waiting = async () => (await d.stack.admin.query("SELECT id, tool, public_chat_id, args FROM pim_app.approvals WHERE state = 'waiting' AND args ? 'forgeApproval'")).rows;
		const forgeState = async () => (await d.stack.admin.query("SELECT status FROM pim_forge.forge_approvals WHERE thread_id = $1 AND action = 'pr'", [id])).rows.map((r) => r.status);
		// Asking twice files one approval, in the person's list and in the chat that asked.
		await say("open a pull request", toolUse(fauxToolCall("coding_open_pull_request", { thread: id }), fauxToolCall("coding_open_pull_request", { thread: id })));
		expect((await results("coding_open_pull_request")).at(-1)).toMatch(/waiting in their approvals/);
		const [filed, ...others] = await waiting();
		expect(others).toEqual([]);
		expect(filed).toMatchObject({ tool: "coding:pr", public_chat_id: chatId, args: { explicit: true } });
		expect((await web.call("GET", "/api/approvals?status=pending")).json.approvals.map((a: { id: string }) => a.id)).toContain(filed.id);
		expect(await forgeState()).toEqual(["pending"]);
		// Their yes is Forge's, so the next try goes past the approval; a no is Forge's too.
		expect((await web.call("POST", `/api/approvals/${filed.id}/approve`, {})).status).toBe(200);
		expect(await forgeState()).toEqual(["approved"]);
		await say("try again", toolUse(fauxToolCall("coding_open_pull_request", { thread: id })));
		expect((await results("coding_open_pull_request")).at(-1)).not.toMatch(/approval/);
		await d.stack.admin.query("DELETE FROM pim_forge.forge_approvals WHERE thread_id = $1", [id]);
		await say("and again", toolUse(fauxToolCall("coding_open_pull_request", { thread: id })));
		const [second] = await waiting();
		expect(second.id).not.toBe(filed.id);
		expect((await web.call("POST", `/api/approvals/${second.id}/deny`, {})).status).toBe(200);
		expect(await forgeState()).toEqual(["denied"]);
		await web.call("DELETE", `/api/admin/coding-grants/${ownerId}/${granted.json.grantId}`);
	}, 120_000);
	it("lets an admin list, give and revoke coding access, and an amp thread needs no pool", async () => {
		const forgeDb = d.stack.admin as unknown as ForgeDb;
		const access = (await web.call("GET", "/api/admin/coding-access")).json;
		expect(access.allowedRepositories).toEqual(["acme/*"]);
		expect(access.harnesses.find((h: { id: string }) => h.id === "amp")).toMatchObject({ available: true, runsIn: "orb" });
		expect(access.harnesses.find((h: { id: string }) => h.id === "pi")).toMatchObject({ available: true, runsIn: "sandbox" });
		// The grant the earlier test made by hand is listed, with its holder.
		const listed = (await web.call("GET", "/api/admin/coding-grants")).json.grants;
		expect(listed).toEqual([expect.objectContaining({ ownerId, username: "anibal", permissions: ["coding:start", "coding:merge"], repositories: ["github.com/acme/*"] })]);
		const forgeRows = async () => (await d.stack.admin.query("SELECT permission, source_grant_id FROM pim_forge.forge_grants WHERE subject_id = $1 AND revoked_at IS NULL ORDER BY permission", [ownerId])).rows;
		expect((await forgeRows()).map((r) => r.permission)).toEqual(["coding:merge", "coding:start"]);

		// Revoking takes both tables' rows back (this grant has no link to its Forge rows, so they are found by what they say) and stops the agent at once.
		expect((await web.call("DELETE", `/api/admin/coding-grants/${ownerId}/${listed[0].grantId}`)).status).toBe(200);
		expect((await web.call("GET", "/api/admin/coding-grants")).json.grants).toEqual([]);
		expect(await forgeRows()).toEqual([]);
		await say("start one", toolUse(fauxToolCall("coding_start", { task: "Nope", repo: REPO, harness: "amp" })));
		expect((await results("coding_start")).at(-1)).toMatch(/no-coding-grant/);

		// With no sandbox pool and Amp set up, a grant for a host-less repository pattern is enough, and an agent that names no harness gets amp.
		await d.stack.admin.query("UPDATE pim_forge.forge_pools SET enabled = false");
		const given = await web.call("POST", "/api/admin/coding-grants", { ownerId, permissions: ["coding:start", "coding:steer", "coding:push", "coding:pr"], repositories: ["acme/*"] });
		expect(given.status).toBe(201);
		const rows = await forgeRows();
		expect(rows.map((r) => r.permission)).toEqual(["coding:abort", "coding:pr", "coding:push", "coding:start", "coding:steer"]);
		expect(rows.every((r) => r.source_grant_id === given.json.grantId)).toBe(true);
		const before = (await d.stack.admin.query("SELECT 1 FROM pim_forge.forge_threads WHERE owner_id = $1", [ownerId])).rowCount!;
		await say("start one", toolUse(fauxToolCall("coding_start", { task: "Update the docs", repo: REPO })));
		const started = (await d.stack.admin.query("SELECT harness, repo FROM pim_forge.forge_threads WHERE owner_id = $1 ORDER BY created_at DESC LIMIT 1", [ownerId])).rows[0];
		expect((await d.stack.admin.query("SELECT 1 FROM pim_forge.forge_threads WHERE owner_id = $1", [ownerId])).rowCount).toBe(before + 1);
		expect(started).toMatchObject({ harness: "amp", repo: REPO });
		// A sandbox harness still needs a pool the grant covers, and a repository outside the grant is refused.
		await say("start another", toolUse(fauxToolCall("coding_start", { task: "Nope", repo: REPO, harness: "pi" })));
		expect((await results("coding_start")).at(-1)).toMatch(/no compute pool/);
		await say("start a third", toolUse(fauxToolCall("coding_start", { task: "Nope", repo: "https://github.com/other/app", harness: "amp" })));
		expect((await results("coding_start")).at(-1)).toMatch(/repository-not-granted/);

		// Guests are never granted, nor are accounts that don't exist or permissions that aren't coding's.
		expect((await web.call("POST", "/api/admin/coding-grants", { ownerId: "o_nobody", permissions: ["coding:start"], repositories: ["acme/*"] })).status).toBe(404);
		expect((await web.call("POST", "/api/admin/coding-grants", { ownerId, permissions: ["coding:start"], repositories: ["not a repo"] })).status).toBe(400);
		expect((await web.call("POST", "/api/admin/coding-grants", { ownerId, permissions: ["admin:grants"], repositories: ["acme/*"] })).status).toBe(400);
		void forgeDb;
	}, 120_000);
	it("manages agents, skills, schedules and triggers", async () => {
		await say("set things up", toolUse(fauxToolCall("create_agent", { name: "Poet", description: "Writes verse", instructions: "Answer in verse." }), fauxToolCall("write_skill", { name: "haiku", description: "Write haiku", body: "Five, seven, five.", files: { "ref.md": "# ref" } })));
const agentId = (await d.stack.admin.query("SELECT id FROM pim_app.agents WHERE name = 'Poet'")).rows[0].id as string;
		const trigger = { version: 1, owningAgentId: agentId, originChatId: "api", label: "Hourly", instruction: "check in", source: { kind: "time", schedule: "cron", expression: "0 * * * *", timeZone: "UTC" }, condition: null, destination: { type: "new_chat" }, delivery: {}, authorizationRef: null };
		await say(
			"more",
			toolUse(fauxToolCall("read_skill", { name: "haiku" }), fauxToolCall("read_skill_file", { name: "haiku", path: "ref.md" }), fauxToolCall("schedule_task", { instruction: "Stretch", label: "Stretching", delay_seconds: 3600 }), fauxToolCall("create_trigger", { spec: trigger })),
			toolUse(fauxToolCall("list_scheduled_tasks", {}), fauxToolCall("list_triggers", {}), fauxToolCall("update_agent", { id: agentId, name: "Bard" })),
		);
		expect((await results("read_skill")).at(-1)).toContain("Five, seven, five.");
		expect((await results("read_skill_file")).at(-1)).toBe("# ref");
		expect((await d.stack.admin.query("SELECT name FROM pim_app.agents WHERE id = $1", [agentId])).rows[0].name).toBe("Bard");
		expect((await d.stack.admin.query("SELECT lifecycle FROM pim_app.triggers")).rows).toEqual([{ lifecycle: "draft" }]);
		expect((await d.stack.admin.query("SELECT kind, prompt, label, target FROM pim_app.schedules")).rows).toEqual([{ kind: "delay", prompt: "Stretch", label: "Stretching", target: "same_chat" }]);
		expect(JSON.parse((await results("schedule_task")).at(-1)!)).toMatchObject({ type: "delayed", label: "Stretching", instruction: "Stretch", newChat: false });
		expect(JSON.parse((await results("list_scheduled_tasks")).at(-1)!)).toMatchObject([{ type: "delayed", label: "Stretching", instruction: "Stretch" }]);
	}, 120_000);

	/** A turn in a chat of its own that ends with a plain send. */
	const say2 = async (chat: string, words: string) => {
		faux.setResponses([toolUse(fauxToolCall("send_to_user", { message: `reply to ${words}` }))] as never);
		expect((await message(chat, words)).status).toBe(202);
		await waitFor(`the reply to ${words}`, async () => ((await resultsIn(chat, "send_to_user")).length > 0 ? true : undefined), 90_000);
	};
	/** A chat's transcript as the model read it, and what its tools answered. */
	const transcriptOf = async (chat: string) => {
		const c = (await d.stack.admin.query("SELECT partition_id, conversation_id FROM pim_app.conversations WHERE public_chat_id = $1", [chat])).rows[0];
		return JSON.stringify(await readTranscript(d.stack.runtime, ownerId, c.partition_id, Number(c.conversation_id)));
	};
	const resultsIn = async (chat: string, tool: string) =>
		(JSON.parse(await transcriptOf(chat)) as { model?: { role: string; toolName?: string; content: { text?: string }[] }[] }[]).flatMap((e) => (e.model ?? []).filter((m) => m.role === "toolResult" && m.toolName === tool).map((m) => m.content.map((c) => c.text ?? "").join("")));
	const said = async (id: string) => JSON.stringify((await d.stack.admin.query("SELECT message FROM pim_projection.chat_transcript_projection WHERE chat_id = $1 AND NOT partial ORDER BY position", [id])).rows);
	const newAgent = async (name: string, description: string, extra: Record<string, unknown> = {}) => (await web.call("POST", "/api/agents", { name, description, instructions: `You are ${name}.`, apps: [], contacts: [], ...extra })).json.id as string;
	const message = (chat: string, text: string) => web.call("POST", `/api/sessions/${chat}/messages`, { commandId: `m-${chat}-${++n}`, text });
	const updatesIn = async (chat: string) => (await d.stack.admin.query("SELECT payload->>'text' AS text FROM pim_app.accepted_commands WHERE public_chat_id = $1 AND payload->>'text' LIKE '[Task update]%' ORDER BY accepted_at", [chat])).rows.map((r) => r.text as string);
	/** What each agent does, told by who it is and what it was just given: the requester hands tasks out, a task agent answers, and the requester relays what comes back. */
	const team = (calls: ReturnType<typeof fauxToolCall>[], options: { wait?: boolean } = {}) => (ctx: { systemPrompt?: string; messages: { role: string; toolName?: string }[] }) => {
		const system = ctx.systemPrompt ?? "";
		const last = ctx.messages.at(-1);
		if (system.includes("started this chat to hand you a task")) return toolUse(fauxToolCall("send_to_user", { message: system.includes('"Researcher"') ? "A found" : "B written" }));
		if (last?.toolName === "delegate") return toolUse(fauxToolCall("send_to_user", { message: options.wait ? "Waited" : "On it" }));
		if (JSON.stringify(last).includes("[Task update]")) return toolUse(fauxToolCall("send_to_user", { message: "Relayed both" }));
		return toolUse(...calls);
	};

	it("hands several tasks out at once, tells the requester their answers in one update, and tells the majordomo who its agents are", async () => {
		await web.call("GET", "/api/agents");
		const researcher = await newAgent("Researcher", "Finds things out", { role: "Researcher" });
		await newAgent("Writer", "Writes text");
		const asked: string[] = [];
		const answer = team([fauxToolCall("delegate", { tasks: [{ to: "Researcher", task: "Find A" }, { to: "Writer", task: "Write B" }] })]);
		faux.setResponses(Array(12).fill((ctx: { systemPrompt?: string; messages: { role: string; toolName?: string }[] }) => (asked.push(ctx.systemPrompt ?? ""), answer(ctx))) as never);
		const chat = (await web.call("POST", "/api/sessions", { title: "Asker" })).json.id as string;
		expect((await message(chat, "please hand it off")).status).toBe(202);
		await waitFor("the requester to hear back", async () => ((await said(chat)).includes("Relayed both") ? true : undefined), 25_000).catch(async (e) => {
			// DEBUG
			console.log("TASKS", JSON.stringify((await d.stack.admin.query("SELECT task_id, status, result, task_chat, wake_request, agent_id FROM pim_app.tasks")).rows));
			console.log("REQUESTER", (await transcriptOf(chat)).slice(0, 6000));
			for (const r of (await d.stack.admin.query("SELECT task_chat FROM pim_app.tasks")).rows) console.log("TASKCHAT", (await transcriptOf(r.task_chat)).slice(0, 3000));
			console.log("CMDS", JSON.stringify((await d.stack.admin.query("SELECT command_id, kind, state, public_chat_id FROM pim_app.accepted_commands ORDER BY accepted_at DESC LIMIT 12")).rows));
			throw e;
		});
		// The majordomo is told who its agents are and what each is for, though it has no contacts configured, and that it hands work out rather than doing it.
		const prompt = asked.find((p) => p.includes("the person's majordomo")) ?? "";
		expect(prompt).toContain(`Researcher: Finds things out [id: ${researcher}]`);
		expect(prompt).toContain("Hand tasks to others with `delegate`");
		expect(prompt).toContain("Don't do the work yourself");
		// Two tasks, each in a chat of its own, answered with what its agent sent; the requester heard of both in one update.
		const tasks = (await d.stack.admin.query("SELECT t.status, t.result, t.batch, c.kind, a.name FROM pim_app.tasks t JOIN pim_app.conversations c ON c.public_chat_id = t.task_chat JOIN pim_app.agents a ON a.id = c.agent_id WHERE t.started_by = $1 ORDER BY t.position", [chat])).rows;
		expect(tasks).toMatchObject([{ status: "completed", result: "A found", kind: "task", name: "Researcher" }, { status: "completed", result: "B written", kind: "task", name: "Writer" }]);
		expect(tasks[0].batch).toBe(tasks[1].batch);
		const updates = await updatesIn(chat);
		expect(updates).toHaveLength(1);
		expect(updates[0]).toContain("A found");
		expect(updates[0]).toContain("B written");
		// A task agent is told who handed it its task, and its first message is from them.
		const taskChat = (await d.stack.admin.query("SELECT task_chat FROM pim_app.tasks WHERE started_by = $1 ORDER BY position", [chat])).rows[0].task_chat as string;
		expect(await said(taskChat)).toContain("[From Pim]\\nFind A");
	}, 180_000);

	it("waits for the answers of the tasks it hands out when asked to, and gets them as the call's result instead of an update", async () => {
		const answer = team([fauxToolCall("delegate", { tasks: [{ to: "Researcher", task: "Find C" }], wait: true })], { wait: true });
		faux.setResponses(Array(8).fill(answer) as never);
		const chat = (await web.call("POST", "/api/sessions", { title: "Waiter" })).json.id as string;
		expect((await message(chat, "please hand it off")).status).toBe(202);
		await waitFor("the requester to finish waiting", async () => ((await said(chat)).includes("Waited") ? true : undefined), 90_000);
		expect((await resultsIn(chat, "delegate"))[0]).toMatch(/^Task task_\w+: Researcher answered:\nA found$/);
		expect(await updatesIn(chat)).toEqual([]);
	}, 180_000);

	it("refuses a task for no one it may hand tasks to, and gives a worker no one the majordomo has not made its contact", async () => {
		const worker = (await d.stack.admin.query("SELECT id FROM pim_app.agents WHERE name = 'Researcher'")).rows[0].id as string;
		faux.setResponses([toolUse(fauxToolCall("delegate", { tasks: [{ to: "Nobody", task: "x" }] })), toolUse(fauxToolCall("send_to_user", { message: "ok" }))] as never);
		const chat = (await web.call("POST", "/api/sessions", { title: "Nobody" })).json.id as string;
		expect((await message(chat, "go")).status).toBe(202);
		await waitFor("the refusal", async () => ((await said(chat)).includes('"ok"') ? true : undefined), 90_000);
		expect((await resultsIn(chat, "delegate"))[0]).toMatch(/^No one called Nobody to hand tasks to\. You can hand them to: .*Researcher.*Writer/);
		// A worker with no contacts has no one to hand tasks to, whatever agents exist; one with a contact has that one, and never an agent already on its chain of tasks.
		faux.setResponses([toolUse(fauxToolCall("delegate", { tasks: [{ to: "Writer", task: "x" }] })), toolUse(fauxToolCall("send_to_user", { message: "ok" }))] as never);
		const workerChat = (await web.call("POST", "/api/sessions", { title: "Worker", agentId: worker })).json.id as string;
		expect((await message(workerChat, "go")).status).toBe(202);
		await waitFor("the worker's refusal", async () => ((await resultsIn(workerChat, "delegate")).length > 0 ? true : undefined), 90_000);
		expect((await resultsIn(workerChat, "delegate"))[0]).toBe("You have no one to hand tasks to: do the work yourself.");
	}, 180_000);

	it("keeps a task's chain from going round in a circle or on for ever", async () => {
		const [a, b, c, e] = [await newAgent("Ann", "A"), await newAgent("Bo", "B"), await newAgent("Cy", "C"), await newAgent("Di", "D")];
		await app.agents.update({ kind: "agent", ownerId: ownerId as never, agentId: "pim" }, a, { contacts: [b, c] });
		await app.agents.update({ kind: "agent", ownerId: ownerId as never, agentId: "pim" }, b, { contacts: [a, c] });
		await app.agents.update({ kind: "agent", ownerId: ownerId as never, agentId: "pim" }, c, { contacts: [e] });
		const chatFor = async (agent: string, startedBy?: string) => {
			const id = (await web.call("POST", "/api/sessions", { title: "chain", agentId: agent })).json.id as string;
			if (startedBy) await d.stack.admin.query("INSERT INTO pim_app.tasks (task_id, owner_id, started_by, task_chat, origin_principal, title) VALUES ($1,$2,$3,$4,'{}','t')", [`t_${id.slice(0, 8)}`, ownerId, startedBy, id]);
			return id;
		};
		const delegates = async (chat: string) => ((await d.stack.admin.query("SELECT pim_app.runner_agents($1, $2, 3) AS r", [ownerId, chat])).rows[0].r.delegates as { name: string }[]).map((x) => x.name);
		const first = await chatFor(a);
		expect(await delegates(first)).toEqual(["Bo", "Cy"]);
		// Bo, working on a task Ann handed it, may hand one to Cy but not back to Ann.
		const second = await chatFor(b, first);
		expect(await delegates(second)).toEqual(["Cy"]);
		// Four agents deep, no one hands anything out.
		const third = await chatFor(c, second);
		expect(await delegates(third)).toEqual(["Di"]);
		const fourth = await chatFor(e, third);
		expect(await delegates(fourth)).toEqual([]);
	}, 120_000);

	it("keeps an agent's role and description, makes one agent for one role, and lets only the majordomo change another agent", async () => {
		await say("make a coach", toolUse(fauxToolCall("create_agent", { name: "Ada", role: "Coach", description: "Coaches runners", instructions: "Coach.", emoji: "🏃", color: "teal", connectors: ["gmail"] })), toolUse(fauxToolCall("create_agent", { name: "Eve", role: "coach", description: "Another coach" })));
		const [created, again] = (await results("create_agent")).slice(-2).map((r) => JSON.parse(r));
		expect(created).toMatchObject({ created: true, agent: { name: "Ada", description: "Coaches runners", connectors: ["gmail"] } });
		// The same role is the same agent: it is not made twice.
		expect(again).toMatchObject({ exists: true, agent: { id: created.agent.id, name: "Ada" } });
		expect((await d.stack.admin.query("SELECT count(*)::int AS n FROM pim_app.agents WHERE name IN ('Ada', 'Eve')")).rows[0].n).toBe(1);
		// The app's own list and form carry them too, and the form's symbol is the agent's emoji.
		const listed = (await web.call("GET", "/api/agents")).json.agents.find((a: { id: string }) => a.id === created.agent.id);
		expect(listed).toMatchObject({ name: "Ada", role: "Coach", description: "Coaches runners", symbol: "🏃" });
		const edited = await web.call("PUT", `/api/agents/${created.agent.id}`, { description: "Coaches runners and walkers", symbol: "🚶" });
		expect(edited.json).toMatchObject({ role: "Coach", description: "Coaches runners and walkers", symbol: "🚶" });
		// An agent changes itself, with no id; it may not change another; the majordomo may.
		const worker = (await d.stack.admin.query("SELECT id FROM pim_app.agents WHERE name = 'Writer'")).rows[0].id as string;
		const adaChat = (await web.call("POST", "/api/sessions", { title: "Ada", agentId: created.agent.id })).json.id as string;
		faux.setResponses([toolUse(fauxToolCall("update_agent", { description: "Runs with people" }), fauxToolCall("update_agent", { id: worker, instructions: "Hijacked" })), toolUse(fauxToolCall("send_to_user", { message: "ok" }))] as never);
		expect((await message(adaChat, "update")).status).toBe(202);
		await waitFor("Ada's edits", async () => ((await resultsIn(adaChat, "update_agent")).length === 2 ? true : undefined), 90_000);
		expect((await resultsIn(adaChat, "update_agent"))).toEqual(["Ada is updated. The change applies from its next step.", "Only the person's majordomo changes their other agents."]);
		expect((await d.stack.admin.query("SELECT instructions FROM pim_app.agents WHERE id = $1", [worker])).rows[0].instructions).toBe("You are Writer.");
		await say("rename the writer", toolUse(fauxToolCall("update_agent", { id: worker, role: "Author", description: "Writes long text" })));
		expect((await d.stack.admin.query("SELECT role, description FROM pim_app.agents WHERE id = $1", [worker])).rows[0]).toEqual({ role: "Author", description: "Writes long text" });
	}, 180_000);

	it("ends the turn when it sends its answer, unless told not to, and says what is wrong with what it was asked to show", async () => {
		let requests = 0;
		const chat = (await web.call("POST", "/api/sessions", { title: "Replies" })).json.id as string;
		faux.setResponses([() => (requests++, toolUse(fauxToolCall("send_to_user", { message: "Working on it", complete: false }))), () => (requests++, toolUse(fauxToolCall("send_to_user", { message: "Done" }))), () => (requests++, fauxAssistantMessage("never asked"))] as never);
		expect((await message(chat, "go")).status).toBe(202);
		await waitFor("the two sends", async () => ((await resultsIn(chat, "send_to_user")).length === 2 ? true : undefined), 90_000);
		await new Promise((resolve) => setTimeout(resolve, 1500));
		// The first send went on; the second finished the turn, with no further request to the model.
		expect(requests).toBe(2);
		// Blocks the app draws are checked, and an image has to be one a tool found.
		const cat = "http://93.184.216.34/cat.png";
		const page = toolUse(fauxToolCall("fetch_url", { url: "http://93.184.216.34/page" }));
		faux.setResponses([
			toolUse(fauxToolCall("send_to_user", { message: "```cards\n[{\"title\":\"A\",\"colour\":\"red\"}]\n```", complete: false })),
			toolUse(fauxToolCall("send_to_user", { message: `\`\`\`gallery\n[{"image":"${cat}"}]\n\`\`\``, complete: false })),
			toolUse(fauxToolCall("send_to_user", { message: "```videos\n[{\"url\":\"https://example.com/v\"}]\n```", complete: false })),
			page,
			toolUse(fauxToolCall("send_to_user", { message: `\`\`\`gallery\n[{"image":"${cat}","caption":"A cat"}]\n\`\`\`` })),
		] as never);
		expect((await message(chat, "show me a cat")).status).toBe(202);
		await waitFor("the gallery", async () => ((await resultsIn(chat, "send_to_user")).length === 6 ? true : undefined), 90_000);
		const sends = (await resultsIn(chat, "send_to_user")).slice(2);
		expect(sends[0]).toBe("Not sent: in a ```cards block, an item has no colour.");
		expect(sends[1]).toBe(`Not sent: no tool's result in this chat gave ${cat}. Use only images a tool found, or leave the image out.`);
		expect(sends[2]).toMatch(/^Not sent: in a ```videos block, an item's url must be a YouTube/);
		// What the person sees is Pim's own copy of it, never the third party's address.
		const { images } = JSON.parse(sends[3]!);
		expect(images[cat]).toMatch(/^\/api\/images\/img-[0-9a-f]{32}$/);
		const served = await fetch(base(gate) + images[cat], { headers: { "x-pim-ingress-secret": d.ingressSecret, cookie: web.cookie } });
		expect(served.status).toBe(200);
		expect(served.headers.get("content-type")).toBe("image/png");
	}, 180_000);

	it("reads back what the person set in a ui block, and keeps a block's state only as its program allows", async () => {
		const chat = (await web.call("POST", "/api/sessions", { title: "Forms" })).json.id as string;
		const form = '```ui\n<form id="f"><number name="a" answer={1}/></form>\n```';
		const readId = (ctx: { messages: { role: string; toolName?: string; content?: { text?: string }[] }[] }) => JSON.parse(ctx.messages.findLast((m) => m.toolName === "send_to_user")!.content![0]!.text!) as { message: string; uiBlocks: { id: string }[] };
		faux.setResponses([toolUse(fauxToolCall("send_to_user", { message: form, complete: false })), (ctx: never) => toolUse(fauxToolCall("send_to_user", { message: `message ${readId(ctx).message}` }))] as never);
		expect((await message(chat, "a form")).status).toBe(202);
		await waitFor("the form", async () => ((await resultsIn(chat, "send_to_user")).length === 2 ? true : undefined), 90_000);
		const sent = JSON.parse((await resultsIn(chat, "send_to_user"))[0]!) as { message: string; uiBlocks: { id: string }[] };
		const block = sent.uiBlocks[0]!.id;
		await waitFor("the message to be projected", async () => ((await said(chat)).includes(form.slice(0, 20)) ? true : undefined), 60_000);
		// A block the message does not hold has no state; one it does keeps what its program lets it, not more.
		expect((await web.call("PUT", `/api/messages/${sent.message}/ui-state/nope`, { version: 0, state: { values: { a: 1 } } })).status).toBe(404);
		expect((await web.call("PUT", `/api/messages/${sent.message}/ui-state/${block}`, { version: 0, state: { values: { a: "x".repeat(40_000) } } })).status).toBe(400);
		expect((await web.call("PUT", `/api/messages/${sent.message}/ui-state/${block}`, { version: 0, state: { values: { a: 7 } } })).json).toMatchObject({ version: 1, state: { values: { a: 7 } } });
		// The agent reads it back without waiting for a submit.
		faux.setResponses([toolUse(fauxToolCall("ui_state", { message: sent.message })), toolUse(fauxToolCall("send_to_user", { message: "thanks" }))] as never);
		expect((await message(chat, "I set it")).status).toBe(202);
		await waitFor("ui_state", async () => ((await resultsIn(chat, "ui_state")).length === 1 ? true : undefined), 90_000);
		expect(JSON.parse((await resultsIn(chat, "ui_state"))[0]!).blocks).toMatchObject([{ block, values: { a: 7 }, submitted: false }]);
	}, 180_000);

	it("schedules work as v1 did: a label, a delay in seconds, never a time in the past, another agent only for the majordomo", async () => {
		const writer = (await d.stack.admin.query("SELECT id FROM pim_app.agents WHERE name = 'Writer'")).rows[0].id as string;
		await say(
			"schedule things",
			toolUse(
				fauxToolCall("schedule_task", { instruction: "Too early", at: "2020-01-01T00:00:00Z" }),
				fauxToolCall("schedule_task", { instruction: "Both", delay_seconds: 5, cron: "0 * * * *" }),
				fauxToolCall("schedule_task", { instruction: "Weekly report", label: "Report", cron: "0 9 * * 1", agent: writer }),
				fauxToolCall("schedule_task", { instruction: "Nope", cron: "0 9 * * 1", agent: "a_missing" }),
			),
		);
		const [past, both, report, missing] = (await results("schedule_task")).slice(-4);
		expect(past).toBe("2020-01-01T00:00:00Z is in the past.");
		expect(both).toBe("Give exactly one of delay_seconds, at, or cron.");
		expect(JSON.parse(report!)).toMatchObject({ type: "cron", cron: "0 9 * * 1", label: "Report", newChat: true, agent: writer });
		expect(missing).toContain("No agent has the id a_missing");
		const row = (await d.stack.admin.query("SELECT label, target, agent_id FROM pim_app.schedules WHERE prompt = 'Weekly report'")).rows[0];
		expect(row).toEqual({ label: "Report", target: "new_chat", agent_id: writer });
		// What fires reads as a scheduled task, by its label and id.
		const id = JSON.parse(report!).id as string;
		const due = new Date(Date.now() + 8 * 86_400_000);
		await app.schedules.tick(ownerId, due);
		const fired = (await d.stack.admin.query("SELECT payload->>'text' AS text FROM pim_app.accepted_commands WHERE command_id LIKE $1", [`sched:${id}:%`])).rows[0];
		expect(fired.text).toBe(`[Scheduled task "Report" ${id}] Weekly report`);
	}, 180_000);

	it("lets the host take agents out of a group chat, lets a late agent read what came before it, and any agent read another chat", async () => {
		const ada = (await d.stack.admin.query("SELECT id FROM pim_app.agents WHERE name = 'Ada'")).rows[0].id as string;
		const room = (await web.call("POST", "/api/sessions", { title: "Room" })).json.id as string;
		const chat0 = (await web.call("POST", "/api/sessions", { title: "Alone" })).json.id as string;
		await say2(room, "first words");
		expect((await web.call("POST", `/api/sessions/${room}/room/members`, { agent: ada })).status).toBe(201);
		const seat = (await d.stack.admin.query("SELECT seat_chat_id FROM pim_app.room_members WHERE public_chat_id = $1", [room])).rows[0].seat_chat_id as string;
		// The room's mode and the seat's own model are the person's to set.
		expect((await web.call("PUT", `/api/sessions/${room}/room`, { mode: "bad" })).status).toBe(400);
		expect((await web.call("PUT", `/api/sessions/${room}/room`, { mode: "mentions" })).json.room).toMatchObject({ mode: "mentions" });
		expect((await web.call("PUT", `/api/sessions/${room}/room/members/${ada}/model`, { provider: "faux", id: "m2" })).status).toBe(200);
		expect((await web.call("GET", "/api/sessions")).json.sessions.find((x: { id: string }) => x.id === room).room.members[0].model).toMatchObject({ model: { provider: "faux", id: "m2" }, override: true });
		expect((await d.stack.admin.query("SELECT model FROM pim_app.conversations WHERE public_chat_id = $1", [seat])).rows[0].model).toEqual({ provider: "faux", id: "m2" });
		// Ada is mentioned, wakes in her seat, reads what was said before she joined, and answers by mentioning the host, which wakes in its turn.
		faux.setResponses([toolUse(fauxToolCall("chat_history", {})), toolUse(fauxToolCall("read_chat", { id: room })), toolUse(fauxToolCall("send_to_user", { message: "@Pim over to you" })), toolUse(fauxToolCall("send_to_user", { message: "thanks Ada" }))] as never);
		expect((await message(room, "@Ada what came before?")).status).toBe(202);
		await waitFor("Ada's reading", async () => ((await resultsIn(seat, "read_chat")).length === 1 ? true : undefined), 90_000);
		expect((await resultsIn(seat, "chat_history"))[0]).toContain("The person: first words");
		expect((await resultsIn(seat, "read_chat"))[0]).toMatch(/^Chat "Room":\n\n/);
		await waitFor("the host to answer Ada", async () => ((await resultsIn(room, "send_to_user")).length === 2 ? true : undefined), 90_000);
		expect(await said(room)).toContain("[From Ada]\\n@Pim over to you");
		expect((await web.call("PUT", `/api/sessions/${chat0}/room`, { mode: "open" })).status).toBe(404);
		// Only the host takes agents out; an agent that is not there is said not to be.
		faux.setResponses([toolUse(fauxToolCall("remove_from_chat", { agents: ["@Ada", "Nobody"] })), toolUse(fauxToolCall("send_to_user", { message: "removed" }))] as never);
		expect((await message(room, "thanks, you can go")).status).toBe(202);
		await waitFor("the removal", async () => ((await resultsIn(room, "remove_from_chat")).length === 1 ? true : undefined), 90_000);
		expect((await resultsIn(room, "remove_from_chat"))[0]).toBe("Ada left the chat.\nNobody isn't in this chat.");
		expect((await d.stack.admin.query("SELECT count(*)::int AS n FROM pim_app.room_members WHERE public_chat_id = $1", [room])).rows[0].n).toBe(0);
	}, 180_000);
});
