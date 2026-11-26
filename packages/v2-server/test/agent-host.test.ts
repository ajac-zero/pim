// The default agent host on the real stack: a Runner started without any `harnessOptions` runs a real Pim agent. The only thing given to it is a model provider (pi-ai's
// faux one, as a deployment's own provider would be) and the databases the tools write through. The agent keeps notes and goals, creates a note and an app, makes an
// HTTP request that is sent at once and only once, and starts a coding thread under an admin's grant; every model call lands in the cost ledger.
import { createHash, randomBytes } from "node:crypto";
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
	const github = { sha: "a".repeat(40), files: {} as Record<string, string>, redirectTo: undefined as string | undefined };
	const serveGithub = (url: URL): Response | undefined => {
		if (url.hostname === "api.github.com") {
			if (github.redirectTo) return new Response(null, { status: 302, headers: { location: github.redirectTo } });
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
		gate = await start(d, "gate", {}, KEK);
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
					// Pages for fetch_url and http_request: a page with markup, a redirect to it, a redirect to a private address, a loop, a long text, and a long answer.
					const pages: Record<string, () => Response> = {
						"http://93.184.216.34/article": () => new Response('<html><head><title>T</title><style>.a{color:red}</style><meta property="og:image" content="/preview.png"></head><body><script>var secret = 1;</script><h1>Hello &amp; welcome</h1><p>Some <b>bold</b> text</p><img src="http://93.184.216.34/inline.png"><svg><text>drawing</text></svg></body></html>', { headers: { "content-type": "text/html" } }),
						"http://93.184.216.34/go": () => new Response(null, { status: 302, headers: { location: "/article" } }),
						"http://93.184.216.34/to-private": () => new Response(null, { status: 302, headers: { location: "http://127.0.0.1/secret" } }),
						"http://93.184.216.34/loop": () => new Response(null, { status: 302, headers: { location: "/loop" } }),
						"http://93.184.216.34/long": () => new Response("x".repeat(25_000), { headers: { "content-type": "text/plain" } }),
						"http://93.184.216.34/big": () => new Response("y".repeat(9_000), { headers: { "content-type": "text/plain" } }),
					};
					const page = pages[String(url)];
					if (page) return page();
					if (failNext) throw new Error("the connection timed out");
					sent.push({ url: String(url), method: init?.method ?? "GET", headers: (init?.headers ?? {}) as Record<string, string>, body: init?.body });
					return new Response('{"ok":true}', { status: 201, headers: { "content-type": "application/json" } });
				}) as typeof fetch,
			},
			{ PIM_DEFAULT_MODEL: "faux/m", PIM_APP_DATABASE_URL: stack.url("gate"), PIM_FORGE_DATABASE_URL: stack.url("forge"), ...KEK },
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
		const calls = await rows("SELECT provider, model, output_tokens FROM pim_app.model_calls");
		expect(calls.length).toBeGreaterThanOrEqual(5);
		expect(calls[0]).toMatchObject({ provider: "faux", model: "m" });
		// The faux model bills a first prompt as cache writes (pi 1.5), so the ledger's input column can be 0 while its output is not.
		expect(Number(calls[0].output_tokens)).toBeGreaterThan(0);
		// A chat's calls are attributed to the chat, which is what its cost and activity read.
		expect(new Set((await rows("SELECT public_chat_id, run_kind FROM pim_app.model_calls WHERE run_kind = 'chat'")).map((r) => r.public_chat_id))).toEqual(new Set([chatId]));
		const priced = (await web.call("GET", `/api/sessions/${chatId}/cost`)).json;
		expect(priced.models).toEqual([expect.objectContaining({ provider: "faux", model: "m" })]);
		// The chat's latest turn, step by step, read from its transcript: each model call with how long the ledger says it took, and each tool call with how long it ran.
		const steps = (await web.call("GET", `/api/sessions/${chatId}/activity`)).json.steps as { kind: string; ms: number | null; model?: string; name?: string }[];
		expect(steps.length).toBeGreaterThanOrEqual(4);
		expect(steps.filter((step) => step.kind === "model").every((step) => typeof step.ms === "number" && step.model === "faux/m")).toBe(true);
		expect(steps.some((step) => step.kind === "tool" && typeof step.ms === "number")).toBe(true);
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
		// A request that fails for a reason of the provider's, which neither the Runner's failover nor pi retries, ends the turn with the error and holds the run.
		faux.setResponses([fauxAssistantMessage([], { stopReason: "error", errorMessage: "the provider crashed" })] as never);
		expect((await web.call("POST", `/api/sessions/${chat}/messages`, { commandId: "retry-1", text: "what is 2+2" })).status).toBe(202);
		await waitFor("the failed request", async () => ((await said("the provider crashed")) ? true : undefined), 60_000);
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
		// A chat that has been answered is not held any more, once the Gate's view of it has the answer's send as its last message.
		await waitFor("the answer as the chat's last message", async () => ((await d.stack.admin.query("SELECT message FROM pim_projection.chat_transcript_projection WHERE chat_id = $1 AND NOT partial ORDER BY position DESC LIMIT 1", [chat])).rows[0]?.message.role === "tool" ? true : undefined), 60_000);
		expect((await web.call("POST", `/api/sessions/${chat}/retry`, {})).status).toBe(409);

		// Reset: the chat starts a new context, carrying the handoff the person gave, and keeps answering from there.
		expect((await web.call("POST", `/api/sessions/${chat}/reset`, { commandId: "reset-1", handoff: "We were doing sums; the last answer was four." })).status).toBe(202);
		await waitFor("the new context", async () => ((await entries()).some((e) => e.kind === "pi.reset") && (await said("We were doing sums")) ? true : undefined), 60_000);
		faux.setResponses([toolUse(fauxToolCall("send_to_user", { message: "Six." }))] as never);
		expect((await web.call("POST", `/api/sessions/${chat}/messages`, { commandId: "retry-2", text: "and 3+3" })).status).toBe(202);
		await waitFor("the answer in the new context", async () => ((await said("Six.")) ? true : undefined), 60_000);
	}, 180_000);

	it("ends a turn the provider refused as invalid, instead of holding it, and does not keep an answer that stopped with nothing in it", async () => {
		const chat = (await web.call("POST", "/api/sessions", { title: "Refused" })).json.id as string;
		const busy = async () => (await d.stack.admin.query("SELECT busy FROM pim_projection.sidebar_session_projection WHERE chat_id = $1", [chat])).rows[0]?.busy as boolean | undefined;
		const lastShown = async () => (await d.stack.admin.query("SELECT message FROM pim_projection.chat_transcript_projection WHERE chat_id = $1 AND NOT partial ORDER BY position DESC LIMIT 1", [chat])).rows[0]?.message;
		const entries = async () => {
			const c = (await d.stack.admin.query("SELECT partition_id, conversation_id FROM pim_runtime.conversation_partitions WHERE public_chat_id = $1", [chat])).rows[0];
			return readTranscript(d.stack.runtime, ownerId, c.partition_id, Number(c.conversation_id));
		};
		// Vertex's refusal of a message without parts: asking again fails the same way, so the chat is not left at work, and the error is the last thing in it.
		faux.setResponses([fauxAssistantMessage([], { stopReason: "error", errorMessage: "400 INVALID_ARGUMENT: Unable to submit request because it must include at least one parts field" })] as never);
		expect((await web.call("POST", `/api/sessions/${chat}/messages`, { commandId: "refused-1", text: "hello" })).status).toBe(202);
		await waitFor("the refused turn to end", async () => ((await lastShown())?.stopReason === "error" && (await busy()) === false ? true : undefined), 60_000);
		// A later message is a new turn: the model answers with send_to_user, then stops with a lone newline and an empty thought, as in the incident (a send finishes the turn only when no other call is made in its round).
		faux.setResponses([toolUse(fauxToolCall("send_to_user", { message: "Hello!" }), fauxToolCall("trigger", { action: "list" })), fauxAssistantMessage([{ type: "text", text: "\n" }, { type: "thinking", thinking: "" }] as never)] as never);
		expect((await web.call("POST", `/api/sessions/${chat}/messages`, { commandId: "refused-2", text: "hello again" })).status).toBe(202);
		await waitFor("the turn after the refusal", async () => ((await entries()).some((e) => JSON.stringify(e).includes("Hello!")) && (await busy()) === false ? true : undefined), 60_000);
		// The blank stop is stored with no content, and the chat shows nothing for it.
		const answers = (await entries()).flatMap((e) => ((e as { model?: { role: string; stopReason?: string; content: unknown[] }[] }).model ?? []).filter((m) => m.role === "assistant" && m.stopReason === "stop"));
		expect(answers).toEqual([expect.objectContaining({ content: [] })]);
		const shown = (await d.stack.admin.query("SELECT message FROM pim_projection.chat_transcript_projection WHERE chat_id = $1 AND NOT partial ORDER BY position", [chat])).rows.map((r) => r.message as { role: string; stopReason?: string });
		expect(shown.filter((m) => m.role === "assistant" && m.stopReason === "stop")).toEqual([]);
	}, 180_000);

	it("ends the turn when the agent keeps stopping without delivering, and the empty answers do not poison the next request", async () => {
		const chat = (await web.call("POST", "/api/sessions", { title: "Silent" })).json.id as string;
		const busy = async () => (await d.stack.admin.query("SELECT busy FROM pim_projection.sidebar_session_projection WHERE chat_id = $1", [chat])).rows[0]?.busy as boolean | undefined;
		const lastShown = async () => (await d.stack.admin.query("SELECT message FROM pim_projection.chat_transcript_projection WHERE chat_id = $1 AND NOT partial ORDER BY position DESC LIMIT 1", [chat])).rows[0]?.message;
		const blank = () => fauxAssistantMessage([{ type: "text", text: "\n" }, { type: "thinking", thinking: "" }] as never);
		// The answer, and the two reminders that follow it, are empty: the third stop fails the run.
		faux.setResponses([blank(), blank(), blank()] as never);
		expect((await web.call("POST", `/api/sessions/${chat}/messages`, { commandId: "silent-1", text: "hello" })).status).toBe(202);
		await waitFor("the failed turn to end", async () => ((await lastShown())?.error?.includes("did not deliver") && (await busy()) === false ? true : undefined), 60_000);
		const stored = (await d.stack.admin.query("SELECT message FROM pim_projection.chat_transcript_projection WHERE chat_id = $1 AND NOT partial", [chat])).rows.map((r) => r.message as { role: string; parts: unknown[] });
		// Nothing the model said is shown but the error, which has no parts.
		expect(stored.filter((m) => m.role === "assistant")).toEqual([expect.objectContaining({ stopReason: "error", parts: [] })]);
		const asked: string[] = [];
		faux.setResponses([(ctx: { messages: unknown[] }) => (asked.push(JSON.stringify(ctx.messages)), toolUse(fauxToolCall("send_to_user", { message: "Hi!" })))] as never);
		expect((await web.call("POST", `/api/sessions/${chat}/messages`, { commandId: "silent-2", text: "anyone there?" })).status).toBe(202);
		await waitFor("the next turn", async () => ((await lastShown())?.role === "tool" && (await busy()) === false ? true : undefined), 60_000);
		// The request had no assistant message with nothing in it, and the person's messages and the reminders were sent together.
		const sent = JSON.parse(asked[0]!) as { role: string; content: unknown }[];
		expect(sent.filter((m) => m.role === "assistant")).toEqual([]);
		expect(JSON.stringify(sent)).toContain("anyone there?");
	}, 180_000);

	it("retries from a message in place: later messages leave the chat and the model's context, and the message is answered again", async () => {
		const chat = (await web.call("POST", "/api/sessions", { title: "Retry here" })).json.id as string;
		const shown = async () => (await d.stack.admin.query("SELECT entry_id, message FROM pim_projection.chat_transcript_projection WHERE chat_id = $1 AND NOT partial ORDER BY position", [chat])).rows as { entry_id: string; message: { role: string; parts: { text?: string; arguments?: { message?: string } }[] } }[];
		const words = async () => JSON.stringify((await shown()).map((r) => r.message));
		const turn = async (text: string, answer: string) => {
			faux.setResponses([toolUse(fauxToolCall("send_to_user", { message: answer }))] as never);
			expect((await web.call("POST", `/api/sessions/${chat}/messages`, { commandId: `retry-turn-${answer}`, text })).status).toBe(202);
			await waitFor(`the answer ${answer}`, async () => {
				const rows = await shown();
				return (await words()).includes(answer) && rows.at(-1)?.message.role === "tool" ? true : undefined;
			}, 60_000);
		};
		await turn("one", "A1");
		await turn("two", "A2");
		await turn("three", "A3");
		const user = async (text: string) => (await shown()).find((r) => r.message.role === "user" && r.message.parts[0]?.text === text)!.entry_id;
		const two = await user("two");
		// Not a message to retry from: an answer, a message that is not there, a chat that is not the person's, and a caller that has not signed in.
		const answerId = (await shown()).find((r) => r.message.role === "assistant")!.entry_id;
		expect((await web.call("POST", `/api/sessions/${chat}/messages/${answerId}/retry`, {})).status).toBe(400);
		expect((await web.call("POST", `/api/sessions/${chat}/messages/999999/retry`, {})).status).toBe(400);
		expect((await web.call("POST", `/api/sessions/00000000-0000-4000-8000-000000000000/messages/${two}/retry`, {})).status).toBe(404);
		expect((await new Client(web.base, d.ingressSecret).call("POST", `/api/sessions/${chat}/messages/${two}/retry`, {})).status).toBe(401);
		expect(await words()).toContain("A3");
		// The model is asked again with what it had been given up to the message: not its own first answer to it, and nothing the person said after.
		const asked: string[] = [];
		faux.setResponses([(ctx: { messages: unknown[] }) => (asked.push(JSON.stringify(ctx.messages)), toolUse(fauxToolCall("send_to_user", { message: "A2 again" })))] as never);
		expect((await web.call("POST", `/api/sessions/${chat}/messages/${two}/retry`, {})).status).toBe(202);
		await waitFor("the answer again", async () => ((await words()).includes("A2 again") && (await shown()).at(-1)?.message.role === "tool" ? true : undefined), 60_000);
		expect(asked).toHaveLength(1);
		expect(asked[0]).toContain("A1");
		expect(asked[0]).toContain('"two"');
		for (const gone of ["A2\"", "three", "A3"]) expect(asked[0]).not.toContain(gone);
		// The chat shows the message once, with the answer again after it, and the chat's own record of the messages says the same.
		const after = (await shown()).filter((r) => r.message.role === "user").map((r) => r.message.parts[0]?.text);
		expect(after).toEqual(["one", "two"]);
		expect((await shown()).find((r) => r.message.role === "user" && r.message.parts[0]?.text === "two")?.entry_id).toBe(two);
		const listed = await web.call("GET", `/api/sessions/${chat}/messages`);
		expect(JSON.stringify(listed.json.messages)).not.toContain("A3");
		// Open apps are told which messages went, and the chat goes on from there.
		expect((await d.stack.admin.query("SELECT 1 FROM pim_projection.live_event_log WHERE topic = $1 AND event_kind = 'message.removed'", [`chat:${chat}`])).rowCount).toBeGreaterThan(0);
		await turn("four", "A4");
		// A chat at work is refused, and nothing leaves it: the person stops it first.
		let release!: () => void;
		const held = new Promise<void>((resolve) => (release = resolve));
		faux.setResponses([(async () => (await held, toolUse(fauxToolCall("send_to_user", { message: "A5" }))))] as never);
		expect((await web.call("POST", `/api/sessions/${chat}/messages`, { commandId: "retry-turn-five", text: "five" })).status).toBe(202);
		const refused = await web.call("POST", `/api/sessions/${chat}/messages/${two}/retry`, {});
		expect(refused).toMatchObject({ status: 409, json: { error: "busy" } });
		release();
		await waitFor("the answer A5", async () => ((await words()).includes("A5") && (await shown()).at(-1)?.message.role === "tool" ? true : undefined), 60_000);
		expect(await words()).toContain("A4");
	}, 180_000);

	it("retries from a message in a chat whose request failed and is held, which ends the held run", async () => {
		const chat = (await web.call("POST", "/api/sessions", { title: "Held" })).json.id as string;
		const shown = async () => (await d.stack.admin.query("SELECT entry_id, message FROM pim_projection.chat_transcript_projection WHERE chat_id = $1 AND NOT partial ORDER BY position", [chat])).rows as { entry_id: string; message: { role: string; stopReason?: string; parts: { text?: string }[] } }[];
		faux.setResponses([fauxAssistantMessage([], { stopReason: "error", errorMessage: "the provider crashed" })] as never);
		expect((await web.call("POST", `/api/sessions/${chat}/messages`, { commandId: "held-1", text: "what is 2+2" })).status).toBe(202);
		await waitFor("the error as the chat's last message", async () => ((await shown()).at(-1)?.message.stopReason === "error" ? true : undefined), 60_000);
		const asked = (await shown()).find((r) => r.message.role === "user")!.entry_id;
		faux.setResponses([toolUse(fauxToolCall("send_to_user", { message: "Four." }))] as never);
		expect((await web.call("POST", `/api/sessions/${chat}/messages/${asked}/retry`, {})).status).toBe(202);
		await waitFor("the answer", async () => ((await shown()).at(-1)?.message.role === "tool" ? true : undefined), 60_000);
		// The error is gone with the rest that came after the message, and the chat is not at work.
		expect((await shown()).map((r) => r.message.role)).toEqual(["user", "assistant", "tool"]);
		await waitFor("the chat to be idle", async () => ((await d.stack.admin.query("SELECT busy FROM pim_projection.sidebar_session_projection WHERE chat_id = $1", [chat])).rows[0]?.busy === false ? true : undefined), 60_000);
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
		// With no sandbox pool to run a thread in, and no Amp to run one in an orb, the prompt says coding is unavailable; the pool made below takes the line away.
		expect(await transcript()).toContain("Coding threads are unavailable");
		expect((await d.stack.admin.query("SELECT 1 FROM pim_forge.forge_threads WHERE owner_id = $1", [ownerId])).rowCount).toBe(0);

		expect((await web.call("POST", "/api/admin/coding-grants", { ownerId, permissions: ["coding:start", "coding:steer"], repositories: ["github.com/acme/*"], pools: ["default"] })).status).toBe(201);
		const forgeDb = d.stack.admin as unknown as ForgeDb;
		await new ForgeScheduler(forgeDb, new (await import("@pim/v2-forge/store")).ForgeStore(forgeDb), Date.now).upsertPool({ poolId: "default", provider: "local", size: 10 });
		await say("try again", toolUse(fauxToolCall("coding_start", { task: "Fix the flaky test", repo: REPO })));
		const threads = (await d.stack.admin.query("SELECT thread_id, repo, task FROM pim_forge.forge_threads WHERE owner_id = $1", [ownerId])).rows;
		expect(threads).toHaveLength(1);
		expect(threads[0]).toMatchObject({ task: "Fix the flaky test" });
		expect((await results("coding_start")).at(-1)).toContain(threads[0].thread_id);
		// A pi thread asked to run on a model the person doesn't have is refused where it starts, with nothing recorded.
		const threadsNow = (await d.stack.admin.query("SELECT 1 FROM pim_forge.forge_threads WHERE owner_id = $1", [ownerId])).rowCount;
		await say("a model I don't have", toolUse(fauxToolCall("coding_start", { task: "Nope", repo: REPO, harness: "pi", profile: { provider: "own:nope", model: "x" } })));
		expect((await results("coding_start")).at(-1)).toMatch(/no model provider own:nope/);
		expect((await d.stack.admin.query("SELECT 1 FROM pim_forge.forge_threads WHERE owner_id = $1", [ownerId])).rowCount).toBe(threadsNow);
		// Its state reads back through the tool, as the owner's.
		await say("how is it going?", toolUse(fauxToolCall("coding_inspect", { thread: threads[0].thread_id })));
		expect((await results("coding_inspect")).at(-1)).toContain(threads[0].thread_id);
		// v1's spelling and shapes still work: `thread_id`, a brief that never carries what signs the thread's grants, a list when no thread is named, and each view: a diff that says nothing is committed yet, the transcript, a message whole, and the test runs.
		const inspect = async (args: Record<string, any>) => {
			await say("inspect", toolUse(fauxToolCall("coding_inspect", args)));
			return (await results("coding_inspect")).at(-1)!;
		};
		const one = await inspect({ thread_id: threads[0].thread_id, view: "status" });
		const list = await inspect({});
		const diff = await inspect({ thread_id: threads[0].thread_id, view: "diff" });
		const page = await inspect({ thread: threads[0].thread_id, view: "transcript", tail: true, limit: 5 });
		const output = await inspect({ thread: threads[0].thread_id, view: "transcript_output" });
		const tests = await inspect({ thread: threads[0].thread_id, view: "tests" });
		const nameless = await inspect({ view: "diff" });
		expect(JSON.parse(one)).toMatchObject({ thread_id: threads[0].thread_id, repo: REPO, harness: "pi", task: "Fix the flaky test", turn_under_way: false });
		expect(one).not.toMatch(/gatewayNonce|gateway_nonce|leaseHolder/);
		expect(JSON.parse(list)).toEqual({ threads: [expect.objectContaining({ thread_id: threads[0].thread_id, task: "Fix the flaky test", status: expect.any(String) })] });
		expect(diff).toMatch(/Nothing committed yet/);
		expect(JSON.parse(page)).toHaveProperty("messages");
		expect(output).toBeDefined();
		expect(tests).toBe("It hasn't run any tests.");
		expect(nameless).toMatch(/Say which coding thread/);
		// Stopping keeps the thread and its work; archiving ends it for good. Both need the right to steer, which this grant holds.
		const id = threads[0].thread_id;
		await say("stop it", toolUse(fauxToolCall("coding_stop", { thread: id })));
		expect(JSON.parse((await results("coding_stop")).at(-1)!)).toMatchObject({ thread_id: id });
		await say("start another", toolUse(fauxToolCall("coding_start", { task: "A second one", repo: REPO })));
		const second = (await d.stack.admin.query("SELECT thread_id FROM pim_forge.forge_threads WHERE owner_id = $1 AND task = 'A second one'", [ownerId])).rows[0].thread_id as string;
		await say("end it", toolUse(fauxToolCall("coding_stop", { thread: second, archive: true })));
		expect(JSON.parse((await results("coding_stop")).at(-1)!)).toEqual({ thread_id: second, status: "archived" });
		// A person's push, pull request and merge are their own act (the app's routes, gated by their own permissions): an agent has no tool for any of them.
		const registered = ((await import("../src/agent-tools.ts")).pimExtension({ ownerId: "o_".padEnd(28, "0"), partitionId: "", runtime: {} } as never, []).tools as unknown as { name: string }[]).map((t) => t.name);
		expect(registered.filter((n) => /^coding_/.test(n)).sort()).toEqual(["coding_inspect", "coding_start", "coding_steer", "coding_stop"]);
	}, 120_000);
	it("shows a person the push, pull request or merge Forge needs them to approve when they ask for it in the app, and carries their answer back to it", async () => {
		const id = (await d.stack.admin.query("SELECT thread_id FROM pim_forge.forge_threads WHERE owner_id = $1", [ownerId])).rows[0].thread_id as string;
		const granted = await web.call("POST", "/api/admin/coding-grants", { ownerId, permissions: ["coding:pr"], repositories: ["github.com/acme/*"], pools: ["default"] });
		expect(granted.status).toBe(201);
		const waiting = async () => (await d.stack.admin.query("SELECT id, tool, public_chat_id, args FROM pim_app.approvals WHERE state = 'waiting' AND args ? 'forgeApproval'")).rows;
		const forgeState = async () => (await d.stack.admin.query("SELECT status FROM pim_forge.forge_approvals WHERE thread_id = $1 AND action = 'pr'", [id])).rows.map((r) => r.status);
		const ask = () => web.call("POST", `/api/coding/threads/${id}/pull-request`, {});
		// Asking twice files one approval, in the person's list.
		expect((await ask()).json).toMatchObject({ status: "approval_required" });
		expect((await ask()).json).toMatchObject({ status: "approval_required" });
		const [filed, ...others] = await waiting();
		expect(others).toEqual([]);
		expect(filed).toMatchObject({ tool: "coding:pr", args: { explicit: true } });
		expect((await web.call("GET", "/api/approvals?status=pending")).json.approvals.map((a: { id: string }) => a.id)).toContain(filed.id);
		expect(await forgeState()).toEqual(["pending"]);
		// Their yes is Forge's, so the next try goes past the approval; a no is Forge's too.
		expect((await web.call("POST", `/api/approvals/${filed.id}/approve`, {})).status).toBe(200);
		expect(await forgeState()).toEqual(["approved"]);
		expect(JSON.stringify((await ask()).json)).not.toMatch(/approval_required/);
		await d.stack.admin.query("DELETE FROM pim_forge.forge_approvals WHERE thread_id = $1", [id]);
		expect((await ask()).json).toMatchObject({ status: "approval_required" });
		const [second] = await waiting();
		expect(second.id).not.toBe(filed.id);
		expect((await web.call("POST", `/api/approvals/${second.id}/deny`, {})).status).toBe(200);
		expect(await forgeState()).toEqual(["denied"]);
		await web.call("DELETE", `/api/admin/coding-grants/${ownerId}/${granted.json.grantId}`);
	}, 120_000);
	it("lets an admin list, give and revoke coding access, and an amp thread needs no pool", async () => {
		const forgeDb = d.stack.admin as unknown as ForgeDb;
		const access = (await web.call("GET", "/api/admin/coding-access")).json;
		expect(access.harnesses.find((h: { id: string }) => h.id === "amp")).toMatchObject({ available: true, runsIn: "orb" });
		expect(access.harnesses.find((h: { id: string }) => h.id === "pi")).toMatchObject({ available: true, runsIn: "sandbox" });
		// The grant the earlier test made by hand is listed, with its holder.
		const listed = (await web.call("GET", "/api/admin/coding-grants")).json.grants;
		expect(listed).toEqual([expect.objectContaining({ ownerId, username: "anibal", permissions: ["coding:start", "coding:steer"], repositories: ["github.com/acme/*"] })]);
		const forgeRows = async () => (await d.stack.admin.query("SELECT permission, source_grant_id FROM pim_forge.forge_grants WHERE subject_id = $1 AND revoked_at IS NULL ORDER BY permission", [ownerId])).rows;
		expect((await forgeRows()).map((r) => r.permission)).toEqual(["coding:abort", "coding:start", "coding:steer"]);

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
		await say("set things up", toolUse(fauxToolCall("create_agent", { name: "Poet", description: "Writes verse", instructions: "Answer in verse." })));
		// (Saving a skill is a person's to approve; the next test does that. This one reads one back.)
		await app.agents.createSkill({ kind: "agent", ownerId: ownerId as never, agentId: "pim" }, { name: "haiku", description: "Write haiku", body: "Five, seven, five.", files: { "ref.md": "# ref" } });
const agentId = (await d.stack.admin.query("SELECT id FROM pim_app.agents WHERE name = 'Poet'")).rows[0].id as string;
		const trigger = { action: "create", label: "Hourly", instruction: "check in", source: { kind: "time", schedule: "cron", expression: "0 * * * *", timeZone: "UTC" }, agentId, newChat: true };
		await say(
			"more",
			toolUse(fauxToolCall("read_skill", { name: "haiku" }), fauxToolCall("read_skill_file", { name: "haiku", path: "ref.md" }), fauxToolCall("trigger", { action: "create", instruction: "Stretch", label: "Stretching", source: { kind: "time", delay_seconds: 3600 } }), fauxToolCall("trigger", trigger)),
			toolUse(fauxToolCall("trigger", { action: "list" }), fauxToolCall("update_agent", { id: agentId, name: "Bard" })),
		);
		expect((await results("read_skill")).at(-1)).toContain("Five, seven, five.");
		expect((await results("read_skill_file")).at(-1)).toBe("# ref");
		expect((await d.stack.admin.query("SELECT name FROM pim_app.agents WHERE id = $1", [agentId])).rows[0].name).toBe("Bard");
		expect((await d.stack.admin.query("SELECT lifecycle FROM pim_app.triggers")).rows).toEqual([{ lifecycle: "draft" }]);
		expect((await d.stack.admin.query("SELECT kind, prompt, label, target FROM pim_app.schedules")).rows).toEqual([{ kind: "delay", prompt: "Stretch", label: "Stretching", target: "same_chat" }]);
		const results2 = (await results("trigger")).map((r) => JSON.parse(r));
		expect(results2.find((r) => r.type === "delayed")).toMatchObject({ type: "delayed", label: "Stretching", instruction: "Stretch", newChat: false });
		// A listing holds the triggers, and beside them what was scheduled with delay_seconds, at or cron.
		expect(results2.find((r) => r.triggers)).toMatchObject({ triggers: [{ label: "Hourly", lifecycle: "draft" }], scheduled: [{ type: "delayed", label: "Stretching", instruction: "Stretch" }], nextCursor: null });
		// A time trigger that is on is listed with its next firing, and deleted by its id like a scheduled task is by its own.
		await say("a daily one", toolUse(fauxToolCall("trigger", { ...trigger, label: "Daily", source: { kind: "time", schedule: "cron", expression: "30 7 * * *", timeZone: "Europe/Lisbon" }, enabled: true })));
		const daily = (await d.stack.admin.query("SELECT id FROM pim_app.triggers WHERE title = 'Daily' AND lifecycle = 'enabled'")).rows[0].id as string;
		await say("what is scheduled", toolUse(fauxToolCall("trigger", { action: "list", sourceKind: "time", lifecycle: "enabled" })));
		expect(JSON.parse((await results("trigger")).at(-1)!)).toMatchObject({ triggers: [{ id: daily, label: "Daily", instruction: "check in", agentId, schedule: { nextFiringAt: expect.any(Number) } }], scheduled: [{ label: "Stretching" }] });
		const task = (await d.stack.admin.query("SELECT id FROM pim_app.schedules")).rows[0].id as string;
		await say("look at it", toolUse(fauxToolCall("trigger", { action: "get", id: task })));
		await say("pause it", toolUse(fauxToolCall("trigger", { action: "pause", id: task })));
		const [got, paused] = (await results("trigger")).slice(-2).map((r) => JSON.parse(r));
		expect(got).toMatchObject({ scheduled: { id: task, type: "delayed" } });
		expect(paused).toMatchObject({ error: { code: "not_a_trigger" } });
		for (const id of [daily, task, task]) await say("drop it", toolUse(fauxToolCall("trigger", { action: "delete", id })));
		const [gone, goneTask, again] = (await results("trigger")).slice(-3).map((r) => JSON.parse(r));
		expect([gone, goneTask]).toEqual([{ deleted: true, id: daily }, { deleted: true, id: task }]);
		expect(again).toMatchObject({ error: { code: "not_found" } });
		expect((await d.stack.admin.query("SELECT lifecycle FROM pim_app.triggers WHERE id = $1", [daily])).rows).toEqual([{ lifecycle: "deleted" }]);
		expect((await d.stack.admin.query("SELECT 1 FROM pim_app.schedules")).rowCount).toBe(0);
	}, 120_000);

	/** A turn in a chat of its own that ends with a plain send. */
	const say2 = async (chat: string, words: string) => {
		faux.setResponses([toolUse(fauxToolCall("send_to_user", { message: `reply to ${words}` }))] as never);
		expect((await message(chat, words)).status).toBe(202);
		await waitFor(`the reply to ${words}`, async () => ((await resultsIn(chat, "send_to_user")).length > 0 ? true : undefined), 90_000);
	};
	/** A chat's transcript as the model read it, and what its tools answered. */
	const transcriptOf = async (chat: string) => {
		// A chat made after the cutover has its real conversation id in the runtime's directory; the application's is provisional.
		const c = (await d.stack.admin.query("SELECT partition_id, conversation_id FROM pim_runtime.conversation_partitions WHERE public_chat_id = $1", [chat])).rows[0];
		return c ? JSON.stringify(await readTranscript(d.stack.runtime, ownerId, c.partition_id, Number(c.conversation_id))) : "[]";
	};
	/** Waits until a chat has answered `count` sends, so that what it was scripted is all used before the next test scripts the model again. */
	const sentIn = (chat: string, count: number) => waitFor(`${count} sends in the chat`, async () => ((await resultsIn(chat, "send_to_user")).length >= count ? true : undefined), 90_000);
	const resultsIn = async (chat: string, tool: string) =>
		(JSON.parse(await transcriptOf(chat)) as { model?: { role: string; toolName?: string; content: { text?: string }[] }[] }[]).flatMap((e) => (e.model ?? []).filter((m) => m.role === "toolResult" && m.toolName === tool).map((m) => m.content.map((c) => c.text ?? "").join("")));
	const said = async (id: string) => JSON.stringify((await d.stack.admin.query("SELECT message FROM pim_projection.chat_transcript_projection WHERE chat_id = $1 AND NOT partial ORDER BY position", [id])).rows);
	const newAgent = async (name: string, description: string, extra: Record<string, unknown> = {}) => (await web.call("POST", "/api/agents", { name, description, instructions: `You are ${name}.`, apps: [], contacts: [], ...extra })).json.id as string;
	const message = (chat: string, text: string) => web.call("POST", `/api/sessions/${chat}/messages`, { commandId: `m-${chat}-${++n}`, text });
	const updatesIn = async (chat: string) => (await d.stack.admin.query("SELECT payload->>'text' AS text FROM pim_app.accepted_commands WHERE public_chat_id = $1 AND payload->>'text' LIKE '[Task update]%' ORDER BY accepted_at", [chat])).rows.map((r) => r.text as string);
	/** What each agent does, told by who it is and what it was just given: the requester hands tasks out, a task agent answers, and the requester relays what comes back. */
	const offered: { worker?: string[]; requester?: string[] } = {};
	const team = (calls: ReturnType<typeof fauxToolCall>[], options: { wait?: boolean } = {}) => (ctx: { messages: { role: string; toolName?: string; toolsAdded?: { name: string }[]; toolsRemoved?: { name: string }[] }[] }) => {
		const asked = JSON.stringify(ctx.messages);
		const last = ctx.messages.at(-1);
		const given = /\[From Pim\]\\n(Find A|Write B|Find C)/.exec(asked)?.[1];
		// The tools a request offers are what its system messages add and remove, in order.
		const tools = new Set<string>();
		for (const m of ctx.messages) if (m.role === "system") for (const t of m.toolsAdded ?? []) tools.add(t.name);
		for (const m of ctx.messages) if (m.role === "system") for (const t of m.toolsRemoved ?? []) tools.delete(t.name);
		if (given) offered.worker = [...tools];
		else offered.requester ??= [...tools];
		if (given) return toolUse(fauxToolCall("send_to_user", { message: { "Find A": "A found", "Write B": "B written", "Find C": "C found" }[given]! }));
		if (last?.toolName === "delegate") return toolUse(fauxToolCall("send_to_user", { message: options.wait ? "Waited" : "On it" }));
		if (JSON.stringify(last).includes("[Task update]")) return toolUse(fauxToolCall("send_to_user", { message: "Relayed both" }));
		return toolUse(...calls);
	};

	it("hands several tasks out at once, tells the requester their answers in one update, and tells the majordomo who its agents are", async () => {
		await web.call("GET", "/api/agents");
		const researcher = await newAgent("Researcher", "Finds things out", { role: "Researcher" });
		await newAgent("Writer", "Writes text");
		faux.setResponses(Array(12).fill(team([fauxToolCall("delegate", { tasks: [{ to: "Researcher", task: "Find A" }, { to: "Writer", task: "Write B" }] })])) as never);
		const chat = (await web.call("POST", "/api/sessions", { title: "Asker" })).json.id as string;
		expect((await message(chat, "please hand it off")).status).toBe(202);
		await waitFor("the requester to hear back", async () => ((await said(chat)).includes("Relayed both") ? true : undefined), 90_000);
		// The majordomo is told who its agents are and what each is for, though it has no contacts configured, and that it hands work out rather than doing it.
		const prompt = await transcriptOf(chat);
		expect(prompt).toContain(`- Researcher: Finds things out [id: ${researcher}]`);
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
		// The agent that hands work out is offered the tools to; the agent handed a task is not offered triggers, delegation or agent management, but keeps the rest.
		expect(offered.requester).toEqual(expect.arrayContaining(["trigger", "delegate", "create_agent", "update_agent", "send_to_user", "read_chat"]));
		expect(offered.worker).toEqual(expect.arrayContaining(["send_to_user", "read_chat", "note", "fetch_url"]));
		for (const hidden of ["trigger", "trigger_computer_grant", "delegate", "archive_task_chats", "create_agent", "update_agent"]) expect(offered.worker).not.toContain(hidden);
	}, 180_000);

	it("waits for the answers of the tasks it hands out when asked to, and gets them as the call's result instead of an update", async () => {
		// A call id as long as OpenAI's (`call_…|fc_…`) must not make the batch's command id too long to accept.
		const answer = team([fauxToolCall("delegate", { tasks: [{ to: "Researcher", task: "Find C" }], wait: true }, { id: `call_${"a".repeat(60)}|fc_${"b".repeat(400)}` })], { wait: true });
		faux.setResponses(Array(8).fill(answer) as never);
		const chat = (await web.call("POST", "/api/sessions", { title: "Waiter" })).json.id as string;
		expect((await message(chat, "please hand it off")).status).toBe(202);
		await waitFor("the requester to finish waiting", async () => ((await said(chat)).includes("Waited") ? true : undefined), 90_000);
		expect((await resultsIn(chat, "delegate"))[0]).toMatch(/^Task task_\w+: Researcher answered:\nC found$/);
		expect(await updatesIn(chat)).toEqual([]);
	}, 180_000);

	it("fails a task whose agent's run ends without an answer, and tells the agent that asked, instead of holding the run for a person", async () => {
		const answer = (ctx: { messages: { role: string; toolName?: string }[] }) => {
			const asked = JSON.stringify(ctx.messages);
			const last = ctx.messages.at(-1);
			if (asked.includes("[From Pim]")) return fauxAssistantMessage([], { stopReason: "error", errorMessage: "400 invalid request body" });
			if (last?.toolName === "delegate") return toolUse(fauxToolCall("send_to_user", { message: "On it" }));
			if (JSON.stringify(last).includes("[Task update]")) return toolUse(fauxToolCall("send_to_user", { message: "It failed" }));
			return toolUse(fauxToolCall("delegate", { tasks: [{ to: "Researcher", task: "Find D" }] }));
		};
		faux.setResponses(Array(8).fill(answer) as never);
		const chat = (await web.call("POST", "/api/sessions", { title: "Failing" })).json.id as string;
		expect((await message(chat, "please hand it off")).status).toBe(202);
		await waitFor("the requester to hear of the failure", async () => ((await said(chat)).includes("It failed") ? true : undefined), 90_000);
		expect((await d.stack.admin.query("SELECT status, result FROM pim_app.tasks WHERE started_by = $1", [chat])).rows).toEqual([{ status: "failed", result: expect.stringMatching(/^It didn't finish: /) }]);
		expect(await updatesIn(chat)).toEqual([expect.stringContaining("didn't finish task")]);
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
		await sentIn(workerChat, 1);
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
		expect((await resultsIn(adaChat, "update_agent")).sort()).toEqual(["Ada is updated. The change applies from its next step.", "Only the person's majordomo changes their other agents."].sort());
		await sentIn(adaChat, 1);
		expect((await d.stack.admin.query("SELECT instructions FROM pim_app.agents WHERE id = $1", [worker])).rows[0].instructions).toBe("You are Writer.");
		await say("rename the writer", toolUse(fauxToolCall("update_agent", { id: worker, role: "Author", description: "Writes long text" })));
		expect((await results("update_agent")).at(-1)).toBe("Writer is updated. The change applies from its next step.");
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
		const form = '```ui\n<slider name="a" min={0} max={10}/>\n```';
		const readId = (ctx: { messages: { role: string; toolName?: string; content?: { text?: string }[] }[] }) => JSON.parse(ctx.messages.findLast((m) => m.toolName === "send_to_user")!.content![0]!.text!) as { message: string; uiBlocks: { id: string }[] };
		faux.setResponses([toolUse(fauxToolCall("send_to_user", { message: form, complete: false })), (ctx: never) => toolUse(fauxToolCall("send_to_user", { message: `message ${readId(ctx).message}` }))] as never);
		expect((await message(chat, "a form")).status).toBe(202);
		await waitFor("the form", async () => ((await resultsIn(chat, "send_to_user")).length === 2 ? true : undefined), 90_000);
		const sent = JSON.parse((await resultsIn(chat, "send_to_user"))[0]!) as { message: string; uiBlocks: { id: string }[] };
		const block = sent.uiBlocks[0]!.id;
		await waitFor("the message to be projected", async () => ((await d.stack.admin.query("SELECT 1 FROM pim_projection.chat_transcript_projection WHERE chat_id = $1 AND entry_id = $2", [chat, sent.message])).rowCount ? true : undefined), 60_000);
		// A block the message does not hold has no state; one it does keeps what its program lets it, not more.
		expect((await web.call("PUT", `/api/messages/${sent.message}/ui-state/nope`, { version: 0, state: { values: { a: 1 } } })).status).toBe(404);
		expect((await web.call("PUT", `/api/messages/${sent.message}/ui-state/${block}`, { version: 0, state: { values: { a: "x".repeat(40_000) } } })).status).toBe(400);
		expect((await web.call("PUT", `/api/messages/${sent.message}/ui-state/${block}`, { version: 0, state: { values: { a: 7 } } })).json).toMatchObject({ version: 1, state: { values: { a: 7 } } });
		// The agent reads it back without waiting for a submit.
		faux.setResponses([toolUse(fauxToolCall("ui_state", { message: sent.message })), toolUse(fauxToolCall("send_to_user", { message: "thanks" }))] as never);
		expect((await message(chat, "I set it")).status).toBe(202);
		await waitFor("ui_state", async () => ((await resultsIn(chat, "ui_state")).length === 1 ? true : undefined), 90_000);
		expect(JSON.parse((await resultsIn(chat, "ui_state"))[0]!).blocks).toMatchObject([{ block, values: { a: 7 }, submitted: false }]);
		await sentIn(chat, 3);
	}, 180_000);

	it("schedules work as v1 did: a label, a delay in seconds, never a time in the past, another agent only for the majordomo", async () => {
		const writer = (await d.stack.admin.query("SELECT id FROM pim_app.agents WHERE name = 'Writer'")).rows[0].id as string;
		await say(
			"schedule things",
			toolUse(
				fauxToolCall("trigger", { action: "create", instruction: "Too early", source: { kind: "time", at: "2020-01-01T00:00:00Z" } }),
				fauxToolCall("trigger", { action: "create", instruction: "Both", source: { kind: "time", delay_seconds: 5, cron: "0 * * * *" } }),
				fauxToolCall("trigger", { action: "create", instruction: "Weekly report", label: "Report", source: { kind: "time", cron: "0 9 * * 1" }, agentId: writer }),
				fauxToolCall("trigger", { action: "create", instruction: "Nope", source: { kind: "time", cron: "0 9 * * 1" }, agentId: "a_missing" }),
			),
		);
		const made = (await results("trigger")).slice(-4);
		const [past, both, report, missing] = ["is in the past", "Give exactly one", '"label": "Report"', "No agent has the id"].map((needle) => made.find((r) => r.includes(needle)));
		expect(past).toBe("2020-01-01T00:00:00Z is in the past.");
		expect(both).toBe("Give exactly one of delay_seconds, at, or cron.");
		expect(JSON.parse(report!)).toMatchObject({ type: "cron", cron: "0 9 * * 1", label: "Report", newChat: true, agent: writer });
		expect(missing).toContain("No agent has the id a_missing");
		const row = (await d.stack.admin.query("SELECT label, target, agent_id FROM pim_app.schedules WHERE prompt = 'Weekly report'")).rows[0];
		expect(row).toEqual({ label: "Report", target: "new_chat", agent_id: writer });
		// What fires reads as a scheduled task, by its label and id.
		const id = JSON.parse(report!).id as string;
		const due = new Date(Date.parse(JSON.parse(report!).next) + 60_000);
		faux.setResponses([toolUse(fauxToolCall("send_to_user", { message: "On it" }))] as never);
		await app.schedules.tick(ownerId, due);
		const fired = (await d.stack.admin.query("SELECT payload->>'text' AS text, public_chat_id FROM pim_app.accepted_commands WHERE command_id LIKE $1", [`sched:${id}:%`])).rows[0];
		// Its run is the agent's own, in a chat of its own; let it end before the next test scripts the model.
		await sentIn(fired.public_chat_id, 1);
		expect(fired.text).toBe(`[Scheduled task "Report" ${id}] Weekly report`);
	}, 180_000);

	it("lets the host take agents out of a group chat, lets a late agent read what came before it, and any agent read another chat", async () => {
		const ada = (await d.stack.admin.query("SELECT id FROM pim_app.agents WHERE name = 'Ada'")).rows[0].id as string;
		const room = (await web.call("POST", "/api/sessions", { title: "Room" })).json.id as string;
		const chat0 = (await web.call("POST", "/api/sessions", { title: "Alone" })).json.id as string;
		await say2(room, "first words");
		expect((await web.call("POST", `/api/sessions/${room}/room/members`, { agent: ada })).status).toBe(201);
		const seat = (await d.stack.admin.query("SELECT seat_chat_id FROM pim_app.room_members WHERE public_chat_id = $1", [room])).rows[0].seat_chat_id as string;
		// The room's mode is the person's to set.
		expect((await web.call("PUT", `/api/sessions/${room}/room`, { mode: "bad" })).status).toBe(400);
		expect((await web.call("PUT", `/api/sessions/${room}/room`, { mode: "mentions" })).json.room).toMatchObject({ mode: "mentions" });
		// Ada is mentioned, wakes in her seat, reads what was said before she joined, and answers by mentioning the host, which wakes in its turn.
		faux.setResponses([toolUse(fauxToolCall("read_chat", {})), toolUse(fauxToolCall("read_chat", { id: room })), toolUse(fauxToolCall("send_to_user", { message: "@Pim over to you" })), toolUse(fauxToolCall("send_to_user", { message: "thanks Ada" }))] as never);
		expect((await message(room, "@Ada what came before?")).status).toBe(202);
		await waitFor("Ada's reading", async () => ((await resultsIn(seat, "read_chat")).length === 2 ? true : undefined), 90_000);
		expect((await resultsIn(seat, "read_chat"))[0]).toContain("The person: first words");
		expect((await resultsIn(seat, "read_chat"))[1]).toMatch(/^Chat "Room":\n\n/);
		await waitFor("the host to answer Ada", async () => ((await resultsIn(room, "send_to_user")).length === 2 ? true : undefined), 90_000);
		await waitFor("Ada's post in the room", async () => ((await said(room)).includes("[From Ada]\\n@Pim over to you") ? true : undefined), 30_000);
		// The models behind Ada's post come with it from her seat's chat as data beside the message, never in what it says or what the other agents read; the host's own send keeps its own.
		const projected = (await d.stack.admin.query("SELECT message FROM pim_projection.chat_transcript_projection WHERE chat_id = $1 AND NOT partial ORDER BY position", [room])).rows.map((r) => r.message as { role: string; parts: { text?: string; name?: string; provenance?: { emitter: { provider: string }; contributors: unknown[]; complete: boolean } }[]; provenance?: { emitter: { provider: string }; contributors: unknown[]; complete: boolean } });
		const post = projected.find((m) => m.role === "user" && m.parts[0]?.text === "[From Ada]\n@Pim over to you");
		expect(post?.provenance).toMatchObject({ emitter: { provider: "faux" }, complete: true });
		expect(post?.provenance?.contributors.length).toBeGreaterThan(0);
		expect(JSON.stringify(post?.parts)).not.toContain("provenance");
		expect(projected.flatMap((m) => m.parts.filter((p) => p.name === "send_to_user").map((p) => p.provenance?.emitter.provider))).toContain("faux");
		expect((await web.call("PUT", `/api/sessions/${chat0}/room`, { mode: "open" })).status).toBe(404);
		// Only the host takes agents out; an agent that is not there is said not to be.
		faux.setResponses([toolUse(fauxToolCall("remove_from_chat", { agents: ["@Ada", "Nobody"] })), toolUse(fauxToolCall("send_to_user", { message: "removed" }))] as never);
		expect((await message(room, "thanks, you can go")).status).toBe(202);
		await waitFor("the removal", async () => ((await resultsIn(room, "remove_from_chat")).length === 1 ? true : undefined), 90_000);
		expect((await resultsIn(room, "remove_from_chat"))[0]).toBe("Ada left the chat.\nNobody isn't in this chat.");
		await sentIn(room, 3);
		expect((await d.stack.admin.query("SELECT count(*)::int AS n FROM pim_app.room_members WHERE public_chat_id = $1", [room])).rows[0].n).toBe(0);
	}, 180_000);
	/** A turn in `chat` for the calls given; the first call that asks a person first is answered as `approve` says, after `during` has seen what was filed. */
	const turnWith = async (chat: string, calls: ReturnType<typeof fauxToolCall>[], ask?: { action: string; approve: boolean; during?: (filed: { id: string; args: Record<string, any> }) => Promise<void> }) => {
		const before = (await resultsIn(chat, "send_to_user")).length;
		faux.setResponses([toolUse(...calls), toolUse(fauxToolCall("send_to_user", { message: `settled ${++n}` }))] as never);
		expect((await message(chat, `go ${n}`)).status).toBe(202);
		if (ask) {
			const filed = await waitFor(`the ${ask.action} approval`, async () => (await d.stack.admin.query("SELECT id, args FROM pim_app.approvals WHERE tool = $1 AND state = 'waiting' AND public_chat_id = $2", [ask.action, chat])).rows[0], 60_000);
			await ask.during?.(filed);
			expect((await web.call("POST", `/api/approvals/${filed.id}/decision`, { approve: ask.approve })).status).toBe(200);
		}
		await waitFor("the turn to end", async () => ((await resultsIn(chat, "send_to_user")).length > before ? true : undefined), 90_000);
	};

	it("saves skills as v1 did: a person approves each one, a rewrite names the version it read, and the agent is told of the skill it saved", async () => {
		expect((await web.call("PUT", "/api/settings", { approvalPolicy: "explicit" })).status).toBe(200);
		const scribe = await newAgent("Scribe", "Writes things down");
		const chat = (await web.call("POST", "/api/sessions", { title: "Scribe", agentId: scribe })).json.id as string;
		const skill = async () => (await d.stack.admin.query("SELECT version, body FROM pim_app.skills WHERE name = 'sonnet'")).rows[0] as { version: number; body: string } | undefined;
		const listed = async () => (await d.stack.admin.query("SELECT config->'skills' AS skills FROM pim_app.agents WHERE id = $1", [scribe])).rows[0].skills as string[] | null;

		// Nothing is saved until the person says yes, and what they are asked names the agent and the skill.
		await turnWith(chat, [fauxToolCall("write_skill", { name: "sonnet", description: "Write sonnets", body: "Five, seven, five.", files: { "ref.md": "# ref" } })], {
			action: "skill:write", approve: true,
			during: async (filed) => {
				expect(filed.args).toMatchObject({ name: "sonnet", agent: scribe, summary: "Scribe saves a new skill: sonnet" });
				expect(await skill()).toBeUndefined();
			},
		});
		expect(await skill()).toMatchObject({ version: 1, body: "Five, seven, five." });
		// The skill is on the agent's own list, which is what its prompt shows it.
		expect(await listed()).toEqual(["sonnet"]);
		await turnWith(chat, [fauxToolCall("current_time", {})]);
		expect(await transcriptOf(chat)).toMatch(/<your_skills>[\s\S]*sonnet: Write sonnets/);

		// A rewrite names the version it read; one that does not, or read an old one, is refused before anyone is asked.
		await turnWith(chat, [fauxToolCall("write_skill", { name: "sonnet", body: "No version." }), fauxToolCall("write_skill", { name: "sonnet", body: "Old.", base_version: 9 }), fauxToolCall("write_skill", { name: "limerick", body: "x", base_version: 1 }), fauxToolCall("read_skill", { name: "sonnet" })]);
		const answers = await resultsIn(chat, "write_skill");
		expect(answers.slice(-3).sort()).toEqual((["A skill named sonnet exists already: read it, then give its version as base_version to rewrite it", "sonnet is at version 1 now, not 9: read it again before rewriting it", "No skill named limerick"]).sort());
		expect((await resultsIn(chat, "read_skill")).at(-1)).toMatch(/^Skill sonnet, version 1:\nFive, seven, five\./);
		expect(await skill()).toMatchObject({ version: 1 });
		// A refusal leaves the skill as it was; a yes makes the next version.
		await turnWith(chat, [fauxToolCall("write_skill", { name: "sonnet", body: "Refused.", base_version: 1 })], { action: "skill:write", approve: false });
		expect((await resultsIn(chat, "write_skill")).at(-1)).toMatch(/did not approve/);
		expect(await skill()).toMatchObject({ version: 1, body: "Five, seven, five." });
		await turnWith(chat, [fauxToolCall("write_skill", { name: "sonnet", body: "Approved.", base_version: 1 })], { action: "skill:write", approve: true });
		expect((await resultsIn(chat, "write_skill")).at(-1)).toMatch(/^Saved the skill sonnet, version 2, one of Scribe's skills/);
		expect(await skill()).toMatchObject({ version: 2, body: "Approved." });
	}, 240_000);

	it("copies the person's own files into a skill, shown with their hashes and saved only as shown, copies them back out, and installs from their files for another agent", async () => {
		expect((await web.call("PUT", "/api/settings", { approvalPolicy: "explicit" })).status).toBe(200);
		// The person's files, through the Files screen's own routes.
		const file = (method: string, path: string, body?: Uint8Array) => fetch(`${web.base}/api/files/content?path=${path}`, { method, headers: { "x-pim-ingress-secret": web.ingress, cookie: web.cookie, ...(body ? { "content-type": "application/octet-stream" } : {}) }, ...(body ? { body } : {}) });
		const put = async (path: string, bytes: Uint8Array) => expect((await file("PUT", path, bytes)).status).toBe(200);
		const template = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0xff, 0xfe, 0x00, 0x01]);
		await put("/workspace/templates/report.bin", template);
		await put("/workspace/templates/notes.txt", Buffer.from("plain notes"));
		const binder = await newAgent("Binder", "Binds reports");
		const chat = (await web.call("POST", "/api/sessions", { title: "Binder", agentId: binder })).json.id as string;
		const skill = async (name: string) => (await d.stack.admin.query("SELECT version, body, files FROM pim_app.skills WHERE name = $1", [name])).rows[0] as { version: number; body: string; files: Record<string, string> } | undefined;
		const hash = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");

		// What the person is shown names each copy with the hash of what it holds; text is kept as text and anything else as bytes.
		await turnWith(chat, [fauxToolCall("write_skill", { name: "report-kit", description: "Make the report", body: "Fill the template.", copy_files: [{ path: "tpl/report.bin", from_file: "/workspace/templates/report.bin" }, { path: "tpl/notes.txt", from_file: "/workspace/templates/notes.txt" }] })], {
			action: "skill:write", approve: true,
			during: async (filed) => {
				expect(filed.args.copies).toEqual([{ path: "tpl/report.bin", from_file: "/workspace/templates/report.bin", sha256: hash(template), size: 8 }, { path: "tpl/notes.txt", from_file: "/workspace/templates/notes.txt", sha256: hash(Buffer.from("plain notes")), size: 11 }]);
				expect(filed.args.summary).toContain("2 files copied from the person's own");
			},
		});
		const kit = (await skill("report-kit"))!;
		expect(kit.version).toBe(1);
		expect(kit.files["tpl/notes.txt"]).toBe("plain notes");
		expect(kit.files["tpl/report.bin"]).toBe(`pim-binary:${template.toString("base64")}`);

		// A file that changed after the person was shown it is not copied.
		await turnWith(chat, [fauxToolCall("write_skill", { name: "report-kit", body: "Changed.", base_version: 1, copy_files: [{ path: "tpl/report.bin", from_file: "/workspace/templates/report.bin" }] })], {
			action: "skill:write", approve: true,
			during: async () => void (await put("/workspace/templates/report.bin", Buffer.from([1, 2, 3]))),
		});
		expect((await resultsIn(chat, "write_skill")).at(-1)).toMatch(/\/workspace\/templates\/report\.bin changed after the person approved copying it/);
		expect((await skill("report-kit"))!.version).toBe(1);

		// A file that is not text is not read out, and is copied to the person's files instead.
		await turnWith(chat, [fauxToolCall("read_skill_file", { name: "report-kit", path: "tpl/report.bin" }), fauxToolCall("read_skill_file", { name: "report-kit", path: "tpl/report.bin", save_to: "/workspace/out/report.bin" }), fauxToolCall("read_skill_file", { name: "report-kit", path: "tpl/nothing.md" })]);
		const read = await resultsIn(chat, "read_skill_file");
		expect(read.find((r) => r.startsWith("(binary file"))).toBe("(binary file, 8 bytes, application/octet-stream): copy it to the person's files with save_to to use it.");
		expect(read.find((r) => r.startsWith("Copied"))).toBe("Copied tpl/report.bin from the report-kit skill, version 1, to /workspace/out/report.bin (8 bytes).");
		expect(read.find((r) => r.includes("nothing.md"))).toContain("Its files: tpl/notes.txt, tpl/report.bin.");
		expect(Buffer.from(await (await file("GET", "/workspace/out/report.bin")).arrayBuffer())).toEqual(template);

		// A skill in the person's files is installed as it is there; the majordomo may install it for another agent, and another agent may not.
		await put("/workspace/skills/greeter/SKILL.md", Buffer.from("---\nname: greeter\ndescription: Say hello\n---\nSay hello warmly.\n"));
		await put("/workspace/skills/greeter/phrases.txt", Buffer.from("hello"));
		await put("/workspace/skills/greeter/.hidden", Buffer.from("never"));
		await turnWith(chat, [fauxToolCall("install_skill", { source: "/workspace/skills/greeter", agent: "a_someone_else" })]);
		expect((await resultsIn(chat, "install_skill")).at(-1)).toMatch(/no agent with the id a_someone_else/);
		const other = await newAgent("Other", "Someone else");
		await turnWith(chat, [fauxToolCall("install_skill", { source: "/workspace/skills/greeter", agent: other })]);
		expect((await resultsIn(chat, "install_skill")).at(-1)).toBe("Only the person's majordomo writes skills for their other agents.");
		await turnWith(chatId, [fauxToolCall("install_skill", { source: "/workspace/skills/greeter", agent: binder })], { action: "skill:install", approve: true, during: async (filed) => void expect(Object.keys(filed.args.hashes).sort()).toEqual(["SKILL.md", "phrases.txt"]) });
		const greeter = (await skill("greeter"))!;
		expect(greeter).toMatchObject({ body: "Say hello warmly.\n" });
		expect(Object.keys(greeter.files).sort()).toEqual([".source", "phrases.txt"]);
		expect((await d.stack.admin.query("SELECT config->'skills' AS skills FROM pim_app.agents WHERE id = $1", [binder])).rows[0].skills).toEqual(["report-kit", "greeter"]);

		// GitHub sending a request elsewhere is refused.
		github.redirectTo = "https://evil.example/steal";
		try {
			await say("install from github", toolUse(fauxToolCall("install_skill", { source: "https://github.com/acme/skills/tree/main/skills/tea" })));
			expect((await results("install_skill")).at(-1)).toMatch(/GitHub sent https:\/\/api\.github\.com elsewhere, so nothing was read from it/);
		} finally {
			github.redirectTo = undefined;
		}
	}, 240_000);

	it("keeps an agent to the memory scopes it reads, one line of at most 280 bytes to a memory title, and says when recall shows only the newest", async () => {
		const other = await newAgent("Keeper", "Keeps secrets");
		const mine = await newAgent("Rememberer", "Remembers");
		const chat = (await web.call("POST", "/api/sessions", { title: "Memory", agentId: mine })).json.id as string;
		const secret = await app.memories.remember({ kind: "agent", ownerId: ownerId as never, agentId: "pim" }, `agent-${other}`, "Keeper's secret", "hidden");
		// The calls of one turn run side by side, so each answer is found by what it says, and what depends on another call waits for the next turn.
		await turnWith(chat, [
			fauxToolCall("note", { title: "x".repeat(281), body: "too long a title" }),
			fauxToolCall("note", { title: "two\nlines", body: "b" }),
			fauxToolCall("note", { title: "Fine", body: "b", scope: `agent-${other}` }),
			fauxToolCall("note", { title: "Oolong one", body: "t" }),
			fauxToolCall("note", { title: "Oolong two", body: "t" }),
			fauxToolCall("note", { title: "Oolong three", body: "t" }),
		]);
		const noted = await resultsIn(chat, "note");
		expect(noted).toContain("Too long: the title is 281 bytes, the limit is 280. Compress it, and put the rest in the text.");
		expect(noted).toContain("A memory's title is one line: merge it, or note each part separately.");
		expect(noted.filter((r) => r.startsWith("You can't keep memories in agent-"))).toHaveLength(1);
		expect(noted.filter((r) => /^Saved as m_\w+ in agent-/.test(r))).toHaveLength(3);
		await turnWith(chat, [
			fauxToolCall("recall", { pattern: "Oolong", limit: 2 }),
			fauxToolCall("recall", { pattern: "(" }),
			fauxToolCall("recall", { pattern: ".", scope: `agent-${other}` }),
			fauxToolCall("recall", { pattern: "Oolong" }),
			fauxToolCall("forget", { id: secret }),
			fauxToolCall("zoom", { id: secret }),
			fauxToolCall("move_memory", { id: secret, scope: "everyone" }),
		]);
		const recalls = await resultsIn(chat, "recall");
		expect(recalls.find((r) => r.includes("Newest 2 of 3"))).toMatch(/^(\[m_\w+\] \(agent-\w+\) Oolong \w+\n){2}Newest 2 of 3 matches\. Narrow the pattern\.$/);
		expect(recalls.find((r) => r.startsWith("Invalid pattern: "))).toBeDefined();
		expect(recalls).toContain(`You don't read the scope agent-${other}.`);
		expect(recalls.find((r) => r.endsWith("\n3 matches."))).toMatch(/Oolong one[\s\S]*Oolong two|Oolong two[\s\S]*Oolong one/);
		// Another agent's private memory is neither read, forgotten nor moved.
		for (const tool of ["forget", "zoom", "move_memory"]) expect((await resultsIn(chat, tool))[0]).toBe(`There is no memory ${secret}.`);
		expect((await d.stack.admin.query("SELECT scope, deleted_at FROM pim_app.memories WHERE id = $1", [secret])).rows[0]).toEqual({ scope: `agent-${other}`, deleted_at: null });

		// The majordomo names a scope once, and shares it with an agent only once the person approves; any other agent has neither tool.
		await turnWith(chat, [fauxToolCall("create_memory_scope", { name: "Health" })]);
		expect((await resultsIn(chat, "create_memory_scope"))[0]).toBe("Only the person's majordomo does that.");
		await turnWith(chatId, [fauxToolCall("create_memory_scope", { name: "Health" })]);
		await turnWith(chatId, [fauxToolCall("create_memory_scope", { name: "health" })]);
		const [made, again] = (await resultsIn(chatId, "create_memory_scope")).slice(-2);
		const key = /as (scope-\w+)\./.exec(made!)![1]!;
		expect(again).toBe(`The scope "Health" is there already, as ${key}.`);
		await turnWith(chatId, [fauxToolCall("share_memory_scope", { scope: key, agent: mine })], { action: "memory:share", approve: false, during: async (filed) => expect(filed.args.summary).toBe('Let "Rememberer" read the memory scope "Health"') });
		expect((await app.agents.get({ kind: "agent", ownerId: ownerId as never, agentId: "pim" }, mine)).memoryScopes).toEqual([]);
		await turnWith(chatId, [fauxToolCall("share_memory_scope", { scope: key, agent: mine })], { action: "memory:share", approve: true });
		expect((await app.agents.get({ kind: "agent", ownerId: ownerId as never, agentId: "pim" }, mine)).memoryScopes).toEqual([key]);
		expect((await resultsIn(chatId, "share_memory_scope")).at(-1)).toBe('Rememberer reads "Health" from its next step.');
	}, 300_000);

	it("reads, edits and lists notes as v1 did: versions and offsets, all-or-nothing edits, append, rename, and a whole rewrite only from the latest version", async () => {
		const chat = (await web.call("POST", "/api/sessions", { title: "Notes" })).json.id as string;
		await turnWith(chat, [fauxToolCall("note_create", { title: "Reading plan", text: "alpha beta gamma" })]);
		const id = (await d.stack.admin.query("SELECT note_id FROM pim_app.notes WHERE title = 'Reading plan'")).rows[0].note_id as string;
		await turnWith(chat, [fauxToolCall("note_read", { id })]);
		// The calls that change the note run one turn at a time: the note has one writer at once.
		await turnWith(chat, [fauxToolCall("note_edit", { id, edits: [{ find: "alpha", replace: "ALPHA" }, { find: "gamma", replace: "GAMMA" }], title: "Renamed plan" })]);
		await turnWith(chat, [fauxToolCall("note_edit", { id, edits: [{ find: "ALPHA", replace: "x" }, { find: "missing", replace: "y" }] })]);
		await turnWith(chat, [fauxToolCall("note_edit", { id, append: "- delta" })]);
		await turnWith(chat, [fauxToolCall("note_edit", { id, content: "stale rewrite", base_version: 1 })]);
		await turnWith(chat, [fauxToolCall("note_read", { id, version: 1 }), fauxToolCall("note_read", { id, offset: 6 }), fauxToolCall("note_read", { id, version: 99 }), fauxToolCall("note_list", { query: "renamed" }), fauxToolCall("note_list", { query: "nothing like it" })]);
		const edits = await resultsIn(chat, "note_edit");
		expect(JSON.parse(edits[0]!)).toMatchObject({ artifact: { id, title: "Renamed plan", kind: "markdown" }, note: expect.stringMatching(/^Made version 2;/) });
		// One edit that does not match changes nothing at all.
		expect(edits[1]).toMatch(/^Edit 2: its find text is not in the note/);
		expect(JSON.parse(edits[2]!).note).toMatch(/^Made version 3;/);
		expect(edits[3]).toMatch(/^Version 1 is not the latest: version 3 is\./);
		expect((await app.canvas.read(ownerId, id)).text).toBe("ALPHA beta GAMMA\n- delta");
		const reads = await resultsIn(chat, "note_read");
		const read = (re: RegExp) => reads.find((r) => re.test(r));
		expect(reads[0]).toBe(`Note ${id} "Reading plan", version 1 of 1, 16 characters:\nalpha beta gamma`);
		expect(read(/version 1 of 3/)).toBe(`Note ${id} "Renamed plan", version 1 of 3, 16 characters:\nalpha beta gamma`);
		expect(read(/from 6/)).toBe(`Note ${id} "Renamed plan", version 3 of 3, 24 characters, from 6:\nbeta GAMMA\n- delta`);
		expect(read(/^No version 99/)).toBe(`No version 99 of note ${id}.`);
		expect(await resultsIn(chat, "note_list")).toEqual(expect.arrayContaining([`- Renamed plan (id ${id}, version 3, 24 bytes)`, "No note's title has nothing and like and it."]));
	}, 240_000);

	it("tracks goals as v1 did: a plan of at least one step, several steps done at once by number, steps added, a progress note, and a list by status", async () => {
		const chat = (await web.call("POST", "/api/sessions", { title: "Goals" })).json.id as string;
		await turnWith(chat, [fauxToolCall("create_goal", { title: "Read a book", steps: [] }), fauxToolCall("create_goal", { title: "Read a book", steps: ["Pick it", "Read half", "Finish it"] })]);
		const created = await resultsIn(chat, "create_goal");
		expect(created.find((r) => r.includes("Validation failed"))).toContain("steps");
		expect(created.find((r) => r.startsWith("Goal created."))).toMatch(/^Goal created\.\n- Read a book \(id g_\w+, 0\/3 steps done\)\n  1\. \[ \] Pick it\n  2\. \[ \] Read half\n  3\. \[ \] Finish it$/);
		const goal = (await d.stack.admin.query("SELECT id FROM pim_app.goals WHERE title = 'Read a book'")).rows[0].id as string;
		await turnWith(chat, [fauxToolCall("update_goal", { id: goal, complete_steps: [1, 3], add_steps: ["Review it"], note: "Halfway there" })]);
		await turnWith(chat, [fauxToolCall("update_goal", { id: goal, complete_steps: [9] })]);
		await turnWith(chat, [fauxToolCall("update_goal", { id: goal, status: "paused" })]);
		await turnWith(chat, [fauxToolCall("list_goals", { status: "paused" }), fauxToolCall("list_goals", { status: "active" })]);
		const updates = await resultsIn(chat, "update_goal");
		expect(updates[0]).toBe(`Goal updated.\n- Read a book (id ${goal}, 2/4 steps done)\n  1. [x] Pick it\n  2. [ ] Read half\n  3. [x] Finish it\n  4. [ ] Review it\n  Latest note: Halfway there`);
		expect(updates[1]).toBe(`Goal ${goal} has 4 steps; there is no step 9.`);
		const lists = await resultsIn(chat, "list_goals");
		const paused = JSON.parse(lists.find((r) => r.includes(goal))!);
		expect(paused).toMatchObject([{ id: goal, status: "paused", notes: [{ text: "Halfway there" }], steps: [{ number: 1, done: true }, { number: 2, done: false }, { number: 3, done: true }, { number: 4, done: false }] }]);
		expect(lists.filter((r) => r.includes(goal))).toHaveLength(1);
		// An active goal's prompt section numbers its steps, which is what complete_steps takes, and shows its latest note.
		await turnWith(chat, [fauxToolCall("update_goal", { id: goal, status: "active" })]);
		await turnWith(chat, [fauxToolCall("current_time", {})]);
		expect(await transcriptOf(chat)).toContain(`- Read a book (id ${goal}, 2/4 steps done)\\n  1. [x] Pick it\\n  2. [ ] Read half`);
		expect(await transcriptOf(chat)).toContain("Latest note: Halfway there");
	}, 240_000);

	it("reads a web page as text with its images, follows redirects only to public addresses, clips long pages, and clips an HTTP answer", async () => {
		const chat = (await web.call("POST", "/api/sessions", { title: "Web" })).json.id as string;
		await turnWith(chat, [
			fauxToolCall("fetch_url", { url: "http://93.184.216.34/go" }),
			fauxToolCall("fetch_url", { url: "http://93.184.216.34/to-private" }),
			fauxToolCall("fetch_url", { url: "http://93.184.216.34/loop" }),
			fauxToolCall("fetch_url", { url: "http://93.184.216.34/long" }),
			fauxToolCall("fetch_url", { url: "http://93.184.216.34/cat.png" }),
			fauxToolCall("http_request", { method: "GET", url: "http://93.184.216.34/big" }),
		]);
		// The calls of a turn run side by side, so each answer is found by what it says.
		const pages = await resultsIn(chat, "fetch_url");
		const page = (re: RegExp) => pages.find((r) => re.test(r));
		// The redirect is followed to the page, whose markup, script, style and drawing are gone; its preview image comes first, then the others.
		expect(page(/article/)).toBe("HTTP 200 http://93.184.216.34/article\n\nHello & welcome\nSome bold text\n\nImages:\n- http://93.184.216.34/preview.png\n- http://93.184.216.34/inline.png");
		expect(page(/public internet/)).toBe("That address is not on the public internet");
		expect(page(/^Too many redirects/)).toBeDefined();
		expect(page(/long/)).toBe(`HTTP 200 http://93.184.216.34/long\n\n${"x".repeat(20_000)}\n[... 5000 more characters]`);
		expect(page(/not readable as text/)).toBe("HTTP 200: image/png content is not readable as text.");
		expect((await resultsIn(chat, "http_request"))[0]).toBe(`200 text/plain\n${"y".repeat(8_000)}\n[... 1000 more characters]`);
	}, 180_000);
	it("makes triggers from a typed draft, keeps an agent to its own, refuses a stale edit, and asks the person before a computer source runs", async () => {
		const [ann, bob] = [await newAgent("Anya", "Works"), await newAgent("Bobby", "Also works")];
		const [annChat, bobChat] = [(await web.call("POST", "/api/sessions", { title: "Ann", agentId: ann })).json.id as string, (await web.call("POST", "/api/sessions", { title: "Bob", agentId: bob })).json.id as string];
		let turns = 0;
		/** Starts a turn that calls `calls` and then answers; what it returns waits for the answer, which a tool that waits for the person delays. */
		const begin = async (chat: string, ...calls: ReturnType<typeof fauxToolCall>[]) => {
			const mine = ++turns;
			faux.setResponses([toolUse(...calls), toolUse(fauxToolCall("send_to_user", { message: `reply ${mine}` }))] as never);
			expect((await message(chat, `turn ${mine}`)).status).toBe(202);
			return () => waitFor(`turn ${mine}`, async () => (sentAndAnswered(await transcriptOf(chat), `reply ${mine}`) ? true : undefined), 90_000);
		};
		const turn = async (chat: string, ...calls: ReturnType<typeof fauxToolCall>[]) => (await begin(chat, ...calls))();
		const last = async (chat: string, tool: string) => (await resultsIn(chat, tool)).at(-1)!;
		const cron = { kind: "time", schedule: "cron", expression: "0 9 * * *", timeZone: "UTC" };
		/** One turn of `trigger` calls, and what each answered. */
		const triggers = async (chat: string, ...calls: Record<string, any>[]) => {
			for (const c of calls) await turn(chat, fauxToolCall("trigger", c));
			return (await resultsIn(chat, "trigger")).slice(-calls.length);
		};

		// What the model gives is a label, an instruction and a source; Pim fills in the rest: the owner, the chat it belongs to, where its work goes.
		const [madeText] = await triggers(annChat, { action: "create", label: "Morning", instruction: "Say good morning", source: cron });
		const made = JSON.parse(madeText!);
		expect(made.trigger).toMatchObject({ lifecycle: "draft", label: "Morning", agentId: ann, origin: { type: "chat", chatId: annChat }, destination: { type: "existing_chat", chatId: annChat }, capability: { status: "available" } });
		const id = made.trigger.id as string;
		// Another agent's triggers are not its to see or change, and an agent cannot make one for another.
		const [seen, paused, deleted, listed, notMine] = await triggers(bobChat, { action: "get", id }, { action: "pause", id }, { action: "delete", id }, { action: "list" }, { action: "create", label: "Not mine", instruction: "x", source: cron, agentId: ann });
		for (const refused of [seen, paused, deleted]) expect(refused).toContain('"code":"not_found"');
		expect(JSON.parse(listed!)).toEqual({ triggers: [], nextCursor: null });
		expect(notMine).toContain("Only the majordomo makes triggers for other agents");
		expect((await d.stack.admin.query("SELECT count(*)::int AS n FROM pim_app.triggers WHERE id = $1 AND lifecycle = 'draft'", [id])).rows[0].n).toBe(1);

		// A change needs the revision it is for: a stale or missing one is refused with the current one, and the right one is applied.
		const [stale, missing, updated] = await triggers(annChat, { action: "update", id, expectedRevision: made.trigger.revision - 1, label: "Stale" }, { action: "update", id, label: "No revision" }, { action: "update", id, expectedRevision: made.trigger.revision, label: "Morning!", newChat: true });
		expect(JSON.parse(stale!).error).toMatchObject({ status: 409, code: "revision_conflict" });
		expect(JSON.parse(missing!).error).toMatchObject({ code: "revision_required" });
		expect(JSON.parse(updated!).trigger).toMatchObject({ label: "Morning!", destination: { type: "new_chat" } });
		const [resumed, runs, got] = await triggers(annChat, { action: "resume", id, expectedRevision: JSON.parse(updated!).trigger.revision }, { action: "runs", id }, { action: "get", id });
		expect(JSON.parse(resumed!).trigger.lifecycle).toBe("enabled");
		expect(JSON.parse(runs!)).toEqual({ runs: [], nextCursor: null });
		expect(JSON.parse(got!)).toMatchObject({ trigger: { id, lifecycle: "enabled" }, runs: [] });
		// A dry run changes nothing: it says when a trigger would fire.
		const [dry] = await triggers(annChat, { action: "test", trigger: { label: "Dry", instruction: "x", source: cron }, count: 2 });
		expect(JSON.parse(dry!)).toMatchObject({ dryRun: true, valid: true, sourceKind: "time" });
		expect((await d.stack.admin.query("SELECT count(*)::int AS n FROM pim_app.triggers WHERE title = 'Dry'")).rows[0].n).toBe(0);

		// A source on the computer runs only as the person's own user: with no computer paired it is a draft that cannot start, and once one is, only their approval grants it.
		const stream = { kind: "stream", command: "tail -f /var/log/syslog" };
		const [sources, streamed] = await triggers(annChat, { action: "sources" }, { action: "create", label: "Log", instruction: "Read the line", source: stream, newChat: true, enabled: true });
		expect(JSON.parse(sources!).sources.find((x: { kind: string }) => x.kind === "stream")).toMatchObject({ status: "draft_only", delivers: false, reason: "computer_not_paired" });
		expect(streamed).toContain("source_not_wired");
		const logId = (await d.stack.admin.query("SELECT id FROM pim_app.triggers WHERE title = 'Log'")).rows[0].id as string;
		expect((await web.call("POST", "/api/computer", {})).status).toBe(201);
		const granted = await begin(annChat, fauxToolCall("trigger", { action: "sources" }), fauxToolCall("trigger_computer_grant", { triggerId: logId }));
		const approval = await waitFor("the grant to wait for the person", async () => (await d.stack.admin.query("SELECT id, args FROM pim_app.approvals WHERE tool = 'trigger:computer_grant' AND state = 'waiting'")).rows[0], 60_000);
		expect(approval.args.summary).toContain("tail -f /var/log/syslog");
		expect(approval.args.explicit).toBe(true);
		expect((await d.stack.admin.query("SELECT count(*)::int AS n FROM pim_app.trigger_computer_grants WHERE trigger_id = $1", [logId])).rows[0].n).toBe(0);
		expect((await web.call("POST", `/api/approvals/${approval.id}/decision`, { approve: true })).status).toBe(200);
		await granted();
		expect(JSON.parse((await resultsIn(annChat, "trigger")).at(-1)!).sources.find((x: { kind: string }) => x.kind === "stream")).toMatchObject({ status: "available", delivers: true });
		expect(await last(annChat, "trigger_computer_grant")).toContain("Granted");
		const view = (await web.call("GET", `/api/triggers/${logId}`)).json;
		expect(view.grant.state).toBe("current");
		const [grantResumed] = await triggers(annChat, { action: "resume", id: logId, expectedRevision: view.revision });
		expect(JSON.parse(grantResumed!).trigger).toMatchObject({ lifecycle: "enabled", grant: { state: "current" } });

		// A retried create with the same Idempotency-Key gives the trigger the first one made; the same key for another request is refused.
		const body = { agentId: ann, label: "Once", instruction: "x", destination: { type: "new_chat" }, source: cron };
		const first = await web.call("POST", "/api/triggers", body, { "idempotency-key": "k-1" });
		const again = await web.call("POST", "/api/triggers", body, { "idempotency-key": "k-1" });
		expect([first.status, again.status, again.json.id === first.json.id]).toEqual([201, 200, true]);
		expect((await web.call("POST", "/api/triggers", { ...body, label: "Other" }, { "idempotency-key": "k-1" })).status).toBe(409);
		expect((await d.stack.admin.query("SELECT count(*)::int AS n FROM pim_app.triggers WHERE title = 'Once'")).rows[0].n).toBe(1);
	}, 240_000);
});
