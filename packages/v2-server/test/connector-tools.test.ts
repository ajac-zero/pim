// An owner's MCP connector on the real stack, against a local fake streamable-HTTP MCP server: its tools are discovered and enabled, the agent is offered the ones that are not
// off, a read-only tool runs, a tool that asks first parks for approval and is called once after a person says yes, an off tool is neither offered nor callable, the
// approval policies (auto, majordomo, explicit) decide what asks, the permissions screen's API sets Off / Ask / On, and "always approve" turns Ask into On.
import { createServer, type Server } from "node:http";
import { randomBytes } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { fauxAssistantMessage, fauxProvider, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import { App } from "@pim/v2-app/app";
import { connect as connectApp } from "@pim/v2-app/db";
import { MemoryObjectStore } from "@pim/v2-app/objects";
import { discoverTokenEndpoint, type Transport } from "../src/connector-tools.ts";
import type { Process } from "../src/main.ts";
import { readTranscript, waitFor } from "../../v2-runtime/test/support/rig.ts";
import { Client } from "./support/client.ts";
import { type Deployment, base, start, startS3 } from "./support/processes.ts";
import { createStack, describeWith, freePort, hasNats, startNats, sentAndAnswered } from "./support/stack.ts";

const real = describeWith(hasNats());
const TOKEN = "mcp-secret-token";
/** A real 1x1 PNG, which a connector's screenshot tool returns. */
const PNG = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==";

/** A minimal MCP server: initialize with a session, tools/list, tools/call (one answered as an event stream). It records every tools/call. */
function fakeMcp() {
	const calls: { name: string; arguments: unknown; authorization: string | undefined }[] = [];
	const tools: { name: string; description: string; inputSchema: Record<string, unknown>; annotations?: Record<string, unknown> }[] = [
		{ name: "search", description: "Search tickets", inputSchema: { type: "object", properties: { q: { type: "string" } } }, annotations: { readOnlyHint: true } },
		{ name: "create_ticket", description: "Open a ticket", inputSchema: { type: "object", properties: { title: { type: "string" } }, required: ["title"] } },
		{ name: "delete_all", description: "Delete every ticket", inputSchema: { type: "object", properties: {} }, annotations: { destructiveHint: true } },
	];
	const server: Server = createServer((req, res) => {
		let raw = "";
		req.on("data", (c) => (raw += c));
		req.on("end", () => {
			if (req.method === "DELETE") return void res.writeHead(204).end();
			if (req.headers.authorization !== `Bearer ${TOKEN}`) return void res.writeHead(401).end();
			const m = JSON.parse(raw);
			if (m.id === undefined) return void res.writeHead(202).end();
			const reply = (result: unknown, sse = false) => {
				const body = JSON.stringify({ jsonrpc: "2.0", id: m.id, result });
				if (sse) res.writeHead(200, { "content-type": "text/event-stream" }).end(`event: message\ndata: ${body}\n\n`);
				else res.writeHead(200, { "content-type": "application/json", "mcp-session-id": "s1" }).end(body);
			};
			if (m.method === "initialize") return reply({ protocolVersion: "2025-06-18", capabilities: { tools: {} }, serverInfo: { name: "fake", version: "1" } });
			if (m.method === "tools/list") return reply({ tools });
			if (m.method === "tools/call") {
				calls.push({ name: m.params.name, arguments: m.params.arguments, authorization: req.headers.authorization });
				if (m.params.name === "shot") return reply({ content: [{ type: "text", text: "here it is" }, { type: "image", data: PNG, mimeType: "image/png" }] });
				return reply({ content: [{ type: "text", text: `${m.params.name} ok ${JSON.stringify(m.params.arguments)}` }] }, m.params.name === "create_ticket");
			}
			res.writeHead(404).end();
		});
	});
	return { server, calls, tools };
}

real("connector tools", () => {
	let d: Deployment;
	let gate: Process;
	let runner: Process;
	let maintenance: Process;
	let web: Client;
	let app: App;
	let ownerId: string;
	let chatId: string;
	let connector: string;
	let n = 0;
	const mcp = fakeMcp();
	const faux = fauxProvider({ provider: "faux", models: [{ id: "m" }] });
	const toolUse = (...calls: ReturnType<typeof fauxToolCall>[]) => fauxAssistantMessage(calls, { stopReason: "toolUse" });
	const transcript = async () => {
		const c = (await d.stack.admin.query("SELECT partition_id, conversation_id FROM pim_app.conversations WHERE public_chat_id = $1", [chatId])).rows[0];
		return JSON.stringify(await readTranscript(d.stack.runtime, ownerId, c.partition_id, Number(c.conversation_id)));
	};
	const results = async (tool: string) =>
		(JSON.parse(await transcript()) as { model?: { role: string; toolName?: string; content: { text?: string }[] }[] }[]).flatMap((e) => (e.model ?? []).filter((m) => m.role === "toolResult" && m.toolName === tool).map((m) => m.content.map((c) => c.text ?? "").join("")));
	/** Sends a message, scripting the model; resolves once the turn ended unless it parks. */
	const send = async (words: string, park: boolean, ...script: unknown[]) => {
		faux.setResponses([...script, toolUse(fauxToolCall("send_to_user", { message: `done ${++n}` })), fauxAssistantMessage(`ended ${n}`)] as never);
		expect((await web.call("POST", `/api/sessions/${chatId}/messages`, { commandId: `m-${n}`, text: words })).status).toBe(202);
		if (!park) await waitFor(`the turn "${words}" to end`, async () => (sentAndAnswered(await transcript(), `done ${n}`) ? true : undefined), 60_000);
	};
	const waiting = () => waitFor("an approval to be filed", async () => (await d.stack.admin.query("SELECT id, tool, args FROM pim_app.approvals WHERE state = 'waiting'")).rows[0], 60_000);
	const finish = () => waitFor("the turn to end", async () => (sentAndAnswered(await transcript(), `done ${n}`) ? true : undefined), 60_000);
	const callNames = () => mcp.calls.map((c) => c.name);

	beforeAll(async () => {
		await new Promise<void>((r) => mcp.server.listen(0, "127.0.0.1", r));
		const url = `http://127.0.0.1:${(mcp.server.address() as { port: number }).port}/mcp`;
		const stack = await createStack();
		d = { stack, nats: await startNats(), s3: await startS3(), gatePort: await freePort(), ingressSecret: "ingress" };
		const keys = { PIM_KEK_T1: randomBytes(32).toString("base64"), PIM_KEK_CURRENT: "t1", PIM_CONNECTOR_ALLOW_PRIVATE: "1" };
		app = new App(connectApp(stack.url("gate"), 4), new MemoryObjectStore());
		gate = await start(d, "gate", {}, keys);
		web = new Client(base(gate), d.ingressSecret);
		const claim = await app.identity.issueClaim("bootstrap", null, 3_600_000);
		const registered = await web.call("POST", "/auth/register", { username: "anibal", bootstrap: claim, session: true });
		expect(registered.status).toBe(201);
		ownerId = registered.json.account.ownerId;
		chatId = (await web.call("POST", "/api/sessions", { title: "Work" })).json.id;
		runner = await start(d, "runner", { pollMs: 40, providers: () => [faux.provider] }, { PIM_DEFAULT_MODEL: "faux/m", PIM_APP_DATABASE_URL: stack.url("gate"), ...keys });
		// Maintenance applies approval timeouts, as the auto policy needs.
		maintenance = await start(d, "maintenance", { pollMs: 100 });
		// The person connects the server, finds its tools, and switches two on; the destructive one is left off.
		const made = await web.call("POST", "/api/connectors", { kind: "custom_mcp", name: "Tickets", url, credential: TOKEN });
		expect(made.status).toBe(201);
		connector = made.json.connector.id;
		expect((await web.call("POST", `/api/connectors/${connector}/discover`)).json.discovered).toBe(3);
		expect((await web.call("PUT", `/api/connectors/${connector}/tools`, { tools: ["search", "create_ticket"] })).status).toBe(200);
	}, 180_000);
	afterAll(async () => {
		await Promise.allSettled([maintenance?.close(), runner?.close(), gate?.close()]);
		await new Promise((r) => mcp.server.close(r));
		await app?.db.end();
		d?.nats.stop();
		await d?.s3.stop();
		await d?.stack.drop();
	}, 60_000);

	it("keeps the credential sealed and shows each tool's default permission", async () => {
		expect((await d.stack.admin.query("SELECT credential FROM pim_app.connectors")).rows[0].credential).not.toContain(TOKEN);
		const tools = ((await web.call("GET", "/api/permissions")).json.tools as { app: string | null; tool: string; permission: string; default: string; readOnly: boolean; destructive: boolean }[]).filter((t) => t.app !== null);
		expect(Object.fromEntries(tools.map((t) => [t.tool, t.permission]))).toEqual({ search: "on", create_ticket: "ask", delete_all: "off" });
		expect(tools.find((t) => t.tool === "search")).toMatchObject({ readOnly: true });
		expect(tools.find((t) => t.tool === "delete_all")).toMatchObject({ destructive: true });
	});

	it("offers the tools that are not off and runs a read-only one", async () => {
		await send("what can you reach?", false, toolUse(fauxToolCall("connector_tools", {})), toolUse(fauxToolCall("connector_call", { connector, tool: "search", arguments: { q: "printer" } })), toolUse(fauxToolCall("connector_call", { connector, tool: "delete_all" })));
		const listed = (await results("connector_tools"))[0]!;
		expect(listed).toContain("create_ticket");
		expect(listed).toContain('"asksFirst": true');
		expect(listed).not.toContain("delete_all");
		expect((await results("connector_call"))[0]).toContain('search ok {"q":"printer"}');
		expect(mcp.calls).toEqual([{ name: "search", arguments: { q: "printer" }, authorization: `Bearer ${TOKEN}` }]);
		// An off tool is not callable even when asked for by name.
		expect((await results("connector_call"))[1]).toMatch(/no tool delete_all|switched off/);
		expect(callNames()).toEqual(["search"]);
	}, 120_000);

	it("parks an ask-first tool for approval and calls it once after a person approves", async () => {
		await send("open a ticket", true, toolUse(fauxToolCall("connector_call", { connector, tool: "create_ticket", arguments: { title: "Printer", api_token: "hunter2" } })));
		const approval = await waiting();
		expect(approval).toMatchObject({ tool: "connector:call", args: { connector, tool: "create_ticket", arguments: { title: "Printer", api_token: "[redacted]" } } });
		expect(callNames()).toEqual(["search"]);
		expect((await web.call("POST", `/api/approvals/${approval.id}/approve`, {})).status).toBe(200);
		await finish();
		expect(callNames()).toEqual(["search", "create_ticket"]);
		expect((await results("connector_call")).at(-1)).toContain("create_ticket ok");
		expect((await d.stack.admin.query("SELECT state, tool_name FROM pim_runtime.external_operations WHERE tool_name = 'connector_call'")).rows).toEqual([{ state: "completed", tool_name: "connector_call" }]);
	}, 120_000);

	it("does not call a tool whose approval was denied", async () => {
		await send("open another", true, toolUse(fauxToolCall("connector_call", { connector, tool: "create_ticket", arguments: { title: "Nope" } })));
		const approval = await waiting();
		expect((await web.call("POST", `/api/approvals/${approval.id}/deny`, {})).status).toBe(200);
		await finish();
		expect(callNames()).toEqual(["search", "create_ticket"]);
		expect((await results("connector_call")).at(-1)).toContain("did not approve");
	}, 120_000);

	it("answers the approval policies: auto approves what is not answered, the majordomo decides or hands back, explicit waits for the person", async () => {
		const ticket = (title: string) => toolUse(fauxToolCall("connector_call", { connector, tool: "create_ticket", arguments: { title } }));
		const created = () => mcp.calls.filter((c) => c.name === "create_ticket").length;
		const before = created();
		const approvalOf = async (title: string) => waitFor(`the approval of ${title}`, async () => (await d.stack.admin.query("SELECT id, state, decided_by, args FROM pim_app.approvals WHERE args->'arguments'->>'title' = $1", [title])).rows[0], 60_000);

		// auto: nobody answers; the call goes ahead when the timeout passes, and the approval says the timeout decided.
		expect((await web.call("PUT", "/api/settings", { approvalPolicy: "auto", approvalTimeoutSeconds: 1 })).status).toBe(200);
		await send("ticket 10", true, ticket("t10"));
		await finish();
		expect((await approvalOf("t10")).state).toBe("timed_out_approved");
		expect(created()).toBe(before + 1);

		// majordomo: the review is one model call; approve goes ahead as the majordomo's own decision.
		expect((await web.call("PUT", "/api/settings", { approvalPolicy: "majordomo" })).status).toBe(200);
		await send("ticket 11", true, ticket("t11"), fauxAssistantMessage('{"decision":"approve","note":"A routine ticket."}'));
		await finish();
		expect(await approvalOf("t11")).toMatchObject({ state: "approved", decided_by: "majordomo", args: { review: { status: "decided", note: "A routine ticket." } } });
		expect(created()).toBe(before + 2);

		// majordomo deny: the call does not go ahead.
		await send("ticket 12", true, ticket("t12"), fauxAssistantMessage('{"decision":"deny","note":"Not something they asked for."}'));
		await finish();
		expect(await approvalOf("t12")).toMatchObject({ state: "denied", decided_by: "majordomo" });
		expect(created()).toBe(before + 2);

		// majordomo unsure, or an answer that is not a decision: handed back, and the person answers as usual.
		await send("ticket 13", true, ticket("t13"), fauxAssistantMessage("I think so?"));
		const handed = await waitFor("the review to hand it back", async () => ((await approvalOf("t13")).args.review?.status === "escalated" ? await approvalOf("t13") : undefined), 60_000);
		expect(handed.state).toBe("waiting");
		const listed = (await web.call("GET", "/api/approvals?status=pending")).json.approvals as { id: string; review: { status: string } | null }[];
		expect(listed.find((a) => a.id === handed.id)?.review?.status).toBe("escalated");
		expect((await web.call("POST", `/api/approvals/${handed.id}/decision`, { approve: true })).status).toBe(200);
		await finish();
		expect(created()).toBe(before + 3);
		expect((await approvalOf("t13")).decided_by).not.toBe("majordomo");
		expect((await web.call("PUT", "/api/settings", { approvalPolicy: "explicit" })).status).toBe(200);
	}, 360_000);

	it("follows the person's Off / Ask / On, and always approve turns Ask into On", async () => {
		const put = (tool: string, permission: string | null, extra: object = {}) => web.call("PUT", "/api/permissions", { app: connector, tool, permission, ...extra });
		const approvals = async () => (await d.stack.admin.query("SELECT count(*)::int AS n FROM pim_app.approvals")).rows[0].n as number;
		const filed = await approvals();
		expect((await put("create_ticket", "on")).json).toMatchObject({ permission: "on", chosen: "on" });
		await send("again", false, toolUse(fauxToolCall("connector_call", { connector, tool: "create_ticket", arguments: { title: "Direct" } })));
		expect(callNames().at(-1)).toBe("create_ticket");
		expect(await approvals()).toBe(filed);

		expect((await put("create_ticket", "off")).json).toMatchObject({ permission: "off" });
		const before = mcp.calls.length;
		await send("and again", false, toolUse(fauxToolCall("connector_call", { connector, tool: "create_ticket", arguments: { title: "Off" } })));
		expect(mcp.calls.length).toBe(before);
		expect((await results("connector_call")).at(-1)).toMatch(/switched off|no tool/);

		// One agent's switch can only turn a tool off; a bad choice is refused.
		expect((await put("search", "ask", { agent: "someone" })).status).toBe(400);
		expect((await put("nothing", "on")).status).toBe(404);

		expect((await put("create_ticket", null)).json).toMatchObject({ permission: "ask", chosen: null });
		await send("ask again", true, toolUse(fauxToolCall("connector_call", { connector, tool: "create_ticket", arguments: { title: "Always" } })));
		const approval = await waiting();
		expect((await web.call("POST", `/api/approvals/${approval.id}/approve`, { always: true })).status).toBe(200);
		await finish();
		expect(callNames().at(-1)).toBe("create_ticket");
		expect((await d.stack.admin.query("SELECT permission FROM pim_app.tool_permissions WHERE tool = 'create_ticket'")).rows).toEqual([{ permission: "on" }]);
		const count = mcp.calls.length;
		await send("no asking now", false, toolUse(fauxToolCall("connector_call", { connector, tool: "create_ticket", arguments: { title: "Quiet" } })));
		expect(mcp.calls.length).toBe(count + 1);
		expect(await approvals()).toBe(filed + 1);
	}, 240_000);

	it("holds Pim's own tools to Off / Ask / On, lists them as v1 did, and lets Always approve set one On with what it did on the card", async () => {
		const own = async () => ((await web.call("GET", "/api/permissions")).json.tools as { app: string | null; tool: string; permission: string; default: string; chosen: string | null; choices: string[] }[]).filter((t) => t.app === null);
		const put = (tool: string, permission: string | null) => web.call("PUT", "/api/permissions", { app: null, tool, permission });
		const approvals = async () => (await d.stack.admin.query("SELECT count(*)::int AS n FROM pim_app.approvals WHERE tool = 'skill:write'")).rows[0].n as number;
		// What an agent does on the computer and its HTTP requests run without asking, everything else asks first; a tool that always needs a person's own decision is only Off or Ask.
		const listed = await own();
		expect(Object.fromEntries(listed.map((t) => [t.tool, t.permission]))).toMatchObject({ shell: "on", file_delete: "on", desktop_act: "on", browser_click: "on", browser_type: "on", browser_upload: "on", http_request: "on", write_skill: "ask", install_skill: "ask", app_deploy: "ask", share_memory_scope: "ask", manage_connectors: "ask" });
		expect(listed.find((t) => t.tool === "install_skill")!.choices).toEqual(["off", "ask"]);
		expect(listed.find((t) => t.tool === "shell")!.choices).toEqual(["off", "ask", "on"]);
		expect((await put("install_skill", "on")).status).toBe(400);
		expect((await put("no_such_tool", "on")).status).toBe(404);
		expect((await web.call("PUT", "/api/permissions", { circle: "none", app: null, tool: "shell", permission: "on" })).status).toBe(404);

		// Ask: the write waits for a person; Always approve on its card sets the tool On, and the card says what came of it.
		const written = await approvals();
		await send("write a skill", true, toolUse(fauxToolCall("write_skill", { name: "brief-notes", description: "How to write brief notes", body: "Keep them short." })));
		const first = await waiting();
		expect(first.tool).toBe("skill:write");
		expect((await web.call("POST", `/api/approvals/${first.id}/approve`, { always: true })).status).toBe(200);
		await finish();
		expect((await results("write_skill")).at(-1)).toContain("Saved the skill brief-notes");
		expect((await web.call("GET", `/api/approvals/${first.id}`)).json).toMatchObject({ status: "approved", result: expect.stringContaining("Saved the skill brief-notes") });
		expect(await approvals()).toBe(written + 1);
		expect((await own()).find((t) => t.tool === "write_skill")).toMatchObject({ permission: "on", chosen: "on", default: "ask" });

		// On: the next write runs at once, rechecked on every call.
		await send("write another", false, toolUse(fauxToolCall("write_skill", { name: "brief-notes-two", description: "More brief notes", body: "Keep them shorter." })));
		expect((await results("write_skill")).at(-1)).toContain("Saved the skill brief-notes-two");
		expect(await approvals()).toBe(written + 1);

		// Off: it is refused before anyone is asked. Taken back to its default, it asks again.
		expect((await put("write_skill", "off")).json).toMatchObject({ permission: "off", chosen: "off" });
		await send("write a third", false, toolUse(fauxToolCall("write_skill", { name: "brief-notes-three", description: "Even more", body: "Shortest." })));
		expect((await results("write_skill")).at(-1)).toMatch(/switched off|turned skills off/);
		expect((await put("write_skill", null)).json).toMatchObject({ permission: "ask", chosen: null });
		// An agent's own switch for skills turns them off for that agent only; the listing gives it as `skills`.
		const made = await web.call("POST", "/api/agents", { name: "Scribe" });
		expect(made.status).toBe(201);
		const agentId = made.json.id as string;
		await d.stack.admin.query("UPDATE pim_app.conversations SET agent_id = $1 WHERE public_chat_id = $2", [agentId, chatId]);
		expect((await web.call("GET", `/api/permissions?agent=${agentId}`)).json.skills).toMatchObject({ tool: "write_skill", permission: "on", choices: ["off", "on"] });
		expect((await web.call("PUT", "/api/permissions", { agent: agentId, app: "", tool: "write_skill", permission: "off" })).json).toMatchObject({ permission: "off" });
		await send("write a fourth", false, toolUse(fauxToolCall("write_skill", { name: "brief-notes-four", description: "Again", body: "Shortest." })));
		expect((await results("write_skill")).at(-1)).toContain("turned skills off for this agent");
		await web.call("PUT", "/api/permissions", { agent: agentId, app: "", tool: "write_skill", permission: null });
	}, 240_000);

	it("reads a tool's permission again at every gated call: on runs, ask files an approval, off refuses, and a tool that always needs a person ignores on", async () => {
		const agent = { kind: "agent", ownerId, agentId: "dev" } as never;
		const admin = { kind: "user", ownerId, role: "admin", sessionId: "s1" } as never;
		const set = (tool: string, permission: string | null) => web.call("PUT", "/api/permissions", { app: null, tool, permission });
		const shell = () => app.approvals.gate(agent, { action: "computer:shell", tool: "shell", args: { summary: "ls" } });
		expect(await shell()).toEqual({ outcome: "allowed" });
		expect((await set("shell", "ask")).status).toBe(200);
		expect((await shell()).outcome).toBe("waiting");
		// A standing approval an admin recorded still stands in for a person where the tool asks.
		const standing = await app.identity.authz.grantStanding(admin, { ownerId, action: "computer:shell", scope: {} });
		expect(await shell()).toEqual({ outcome: "allowed", viaStandingApproval: standing });
		await app.identity.authz.revokeStanding(admin, ownerId, standing);
		expect((await set("shell", "off")).status).toBe(200);
		await expect(shell()).rejects.toMatchObject({ code: "tool_off" });
		expect((await set("shell", null)).status).toBe(200);
		expect(await shell()).toEqual({ outcome: "allowed" });
		// The browser's three tools are three permissions of one action.
		const browse = (tool: string) => app.approvals.gate(agent, { action: "computer:browser_submit", tool, resource: { tool } });
		await set("browser_click", "ask");
		expect([(await browse("browser_click")).outcome, (await browse("browser_type")).outcome]).toEqual(["waiting", "allowed"]);
		await set("browser_click", null);
		// An action a person must always answer for asks whatever the permission says (the row is forced past the screen, which refuses On), and still stops when off.
		const install = () => app.approvals.gate(agent, { action: "skill:install", tool: "install_skill", explicit: true });
		await d.stack.admin.query("INSERT INTO pim_app.tool_permissions (owner_id, audience, app, tool, permission) VALUES ($1,'owner','','install_skill','on')", [ownerId]);
		expect((await install()).outcome).toBe("waiting");
		await set("install_skill", "off");
		await expect(install()).rejects.toMatchObject({ code: "tool_off" });
		await set("install_skill", null);
		await d.stack.admin.query("UPDATE pim_app.approvals SET state = 'denied' WHERE state = 'waiting'");
	}, 60_000);

	it("asks again about a tool its connector changed since the person let it run, and says so", async () => {
		const put = (tool: string, permission: string | null) => web.call("PUT", "/api/permissions", { app: connector, tool, permission });
		const info = async () => ((await web.call("GET", "/api/permissions")).json.tools as { app: string | null; tool: string; permission: string; changed: boolean }[]).find((t) => t.app === connector && t.tool === "create_ticket")!;
		expect((await put("create_ticket", "on")).json).toMatchObject({ permission: "on", changed: false });
		const tool = mcp.tools.find((t) => t.name === "create_ticket")!;
		const was = tool.description;
		try {
			tool.description = "Open a ticket, and email everyone";
			expect((await web.call("POST", `/api/connectors/${connector}/discover`)).status).toBe(200);
			expect(await info()).toMatchObject({ permission: "ask", changed: true });
			// Choosing again trusts the new version.
			expect((await put("create_ticket", "on")).json).toMatchObject({ permission: "on", changed: false });
		} finally {
			tool.description = was;
			await web.call("POST", `/api/connectors/${connector}/discover`);
			await put("create_ticket", null);
		}
	}, 60_000);

	it("serves the web app's connected-servers and connections lists, connects a server by its address and removes it", async () => {
		const listed = (await web.call("GET", "/api/mcp")).json.servers as { id: string; state: string; tools: { name: string }[] }[];
		expect(listed.find((s) => s.id === connector)).toMatchObject({ state: "ready", tools: [{ name: "search" }, { name: "create_ticket" }, { name: "delete_all" }] });
		expect((await web.call("POST", "/api/mcp", {})).status).toBe(400);
		const url = (await d.stack.admin.query("SELECT url FROM pim_app.connectors WHERE id = $1", [connector])).rows[0].url;
		// Without the server's credential it cannot list tools, and says so instead of pretending.
		const bare = (await web.call("POST", "/api/mcp", { url })).json;
		expect(bare).toMatchObject({ state: "failed" });
		expect((await web.call("DELETE", `/api/mcp/${bare.id}`)).json).toEqual({ deleted: true });
		expect((await web.call("GET", "/api/connections")).json).toEqual({ connections: [] });
	});

	it("checks a call's arguments before anyone is asked, finds tools past the first page, and shows a tool's picture to the model", async () => {
		// The server grows: a tool that answers with a picture, and seventy more.
		const bulk = Array.from({ length: 70 }, (_, i) => `bulk_${String(i).padStart(2, "0")}`);
		mcp.tools.push({ name: "shot", description: "Take a screenshot", inputSchema: { type: "object", properties: {} }, annotations: { readOnlyHint: true } }, ...bulk.map((name) => ({ name, description: "Bulk tool", inputSchema: { type: "object", properties: {} }, annotations: { readOnlyHint: true } })));
		// A second connection to it (the Runner keeps each connection's tool list for half a minute), with all of them switched on.
		const url = (await d.stack.admin.query("SELECT url FROM pim_app.connectors WHERE id = $1", [connector])).rows[0].url;
		const gallery = (await web.call("POST", "/api/connectors", { kind: "custom_mcp", name: "Gallery", url, credential: TOKEN })).json.connector.id as string;
		expect((await web.call("POST", `/api/connectors/${gallery}/discover`)).json.discovered).toBe(74);
		expect((await web.call("PUT", `/api/connectors/${gallery}/tools`, { tools: ["shot", ...bulk] })).status).toBe(200);
		const filed = (await d.stack.admin.query("SELECT count(*)::int AS n FROM pim_app.approvals")).rows[0].n as number;
		const before = mcp.calls.length;
		await send("try these", false,
			toolUse(fauxToolCall("connector_call", { connector, tool: "create_ticket", arguments: {} })),
			toolUse(fauxToolCall("connector_call", { connector: gallery, tool: "shot" })),
			toolUse(fauxToolCall("connector_tools", { query: "bulk", offset: 10, limit: 5 })),
			toolUse(fauxToolCall("connector_tools", { connector: gallery, query: "printer" })),
		);
		// A call the tool would refuse is refused here, with what the tool takes, and nothing is called or asked.
		const answers = await results("connector_call");
		expect(answers.slice(-2).find((r) => r.includes("Validation failed"))).toMatch(/Validation failed[\s\S]*title[\s\S]*The tool takes: \{.*"required":\["title"\]/);
		expect(mcp.calls.slice(before).map((c) => c.name)).toEqual(["shot"]);
		expect((await d.stack.admin.query("SELECT count(*)::int AS n FROM pim_app.approvals")).rows[0].n).toBe(filed);
		// A tool's picture reaches the model as an image, not as "[image image/png]".
		const model = (JSON.parse(await transcript()) as { model?: { role: string; toolName?: string; content: { type: string; data?: string; text?: string }[] }[] }[]).flatMap((e) => e.model ?? []);
		const shot = model.filter((m) => m.role === "toolResult" && m.toolName === "connector_call" && m.content.some((part) => part.type === "image")).at(-1)!;
		expect(shot.content).toEqual([{ type: "text", text: "here it is" }, { type: "image", data: PNG, mimeType: "image/png" }]);
		// The tools past the first page are listed on request, and a search that finds nothing says how many there are.
		const pages = (await results("connector_tools")).slice(-2);
		const page = JSON.parse(pages.find((r) => r.startsWith("{"))!);
		expect(page).toMatchObject({ total: 70, from: 10, next: "offset 15 of 70" });
		expect(page.tools.map((t: { tool: string }) => t.tool)).toEqual(bulk.slice(10, 15));
		expect(pages.find((r) => r.startsWith("None of"))).toMatch(/^None of the 73 tools matches/);
		// The prompt lists the first sixty and says how many more there are.
		await send("and now?", false);
		expect(await transcript()).toMatch(/and 13 more tools: find them with connector_tools/);
	}, 120_000);
});

describe("finding a server's token endpoint", () => {
	/** A transport that answers from a table of documents, refusing private addresses as the deployment's does. */
	const transportOf = (documents: Record<string, unknown>, asked: string[] = []): Transport => ({
		allowPrivate: false,
		check: async (url) => {
			if (new URL(url).hostname === "10.0.0.5") throw new Error("private");
			return new URL(url);
		},
		fetch: (async (url: URL | string) => {
			asked.push(String(url));
			const found = documents[String(url)];
			return found === undefined ? new Response("", { status: 404 }) : Response.json(found);
		}) as typeof fetch,
	});

	it("follows the protected resource to its authorization server, as the MCP specification says", async () => {
		const transport = transportOf({
			"https://mcp.example.test/.well-known/oauth-protected-resource/v1/mcp": { authorization_servers: ["https://auth.example.test/tenant"] },
			"https://auth.example.test/.well-known/oauth-authorization-server/tenant": { token_endpoint: "https://auth.example.test/tenant/token" },
		});
		expect(await discoverTokenEndpoint("https://mcp.example.test/v1/mcp", transport)).toBe("https://auth.example.test/tenant/token");
	});

	it("falls back to the server's own origin, and refuses an authorization server on a private address", async () => {
		expect(await discoverTokenEndpoint("https://mcp.example.test/mcp", transportOf({ "https://mcp.example.test/.well-known/oauth-authorization-server": { token_endpoint: "https://mcp.example.test/token" } }))).toBe("https://mcp.example.test/token");
		const asked: string[] = [];
		const hostile = transportOf({ "https://mcp.example.test/.well-known/oauth-protected-resource": { authorization_servers: ["http://10.0.0.5/"] } }, asked);
		expect(await discoverTokenEndpoint("https://mcp.example.test/mcp", hostile)).toBeNull();
		expect(asked.some((u) => u.includes("10.0.0.5"))).toBe(false);
	});
});
