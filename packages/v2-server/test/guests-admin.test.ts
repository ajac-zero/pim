// Guests and the admin's majordomo on the real stack, against a local fake MCP server: a guest joins through a bot's link and reaches only what the bot
// shares (a tool that asks first is the host's to approve, the day's calls are counted, the link going off stops it), a circle member's visit reaches what the host
// granted that circle, and the admin's majordomo runs the deployment through the admin API (a change that cannot be undone asks the admin each time).
import { createServer, type Server } from "node:http";
import { randomBytes } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { fauxAssistantMessage, fauxProvider, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import { App } from "@pim/v2-app/app";
import { connect as connectApp } from "@pim/v2-app/db";
import { MemoryObjectStore } from "@pim/v2-app/objects";
import type { Process } from "../src/main.ts";
import { readTranscript, waitFor } from "../../v2-runtime/test/support/rig.ts";
import { Client } from "./support/client.ts";
import { type Deployment, base, start, startS3 } from "./support/processes.ts";
import { createStack, describeWith, freePort, hasNats, startNats } from "./support/stack.ts";

const real = describeWith(hasNats());
const TOKEN = "host-mcp-token";

function fakeMcp() {
	const calls: { name: string; arguments: unknown; authorization: string | undefined }[] = [];
	const tools = [
		{ name: "search", description: "Search tickets", inputSchema: { type: "object", properties: { q: { type: "string" } } }, annotations: { readOnlyHint: true } },
		{ name: "create_ticket", description: "Open a ticket", inputSchema: { type: "object", properties: { title: { type: "string" } } } },
		{ name: "delete_all", description: "Delete every ticket", inputSchema: { type: "object", properties: {} }, annotations: { destructiveHint: true } },
		{ name: "internal", description: "Not shared with anyone", inputSchema: { type: "object", properties: {} } },
	];
	const server: Server = createServer((req, res) => {
		let raw = "";
		req.on("data", (c) => (raw += c));
		req.on("end", () => {
			if (req.method === "DELETE") return void res.writeHead(204).end();
			if (req.headers.authorization !== `Bearer ${TOKEN}`) return void res.writeHead(401).end();
			const m = JSON.parse(raw);
			if (m.id === undefined) return void res.writeHead(202).end();
			const reply = (result: unknown) => res.writeHead(200, { "content-type": "application/json", "mcp-session-id": "s1" }).end(JSON.stringify({ jsonrpc: "2.0", id: m.id, result }));
			if (m.method === "initialize") return reply({ protocolVersion: "2025-06-18", capabilities: { tools: {} }, serverInfo: { name: "fake", version: "1" } });
			if (m.method === "tools/list") return reply({ tools });
			if (m.method === "tools/call") {
				calls.push({ name: m.params.name, arguments: m.params.arguments, authorization: req.headers.authorization });
				return reply({ content: [{ type: "text", text: `${m.params.name} ok ${JSON.stringify(m.params.arguments)}` }] });
			}
			res.writeHead(404).end();
		});
	});
	return { server, calls };
}

real("guests, circles and the admin's majordomo", () => {
	let d: Deployment;
	let gate: Process;
	let runner: Process;
	let app: App;
	const mcp = fakeMcp();
	const faux = fauxProvider({ provider: "faux", models: [{ id: "m" }] });
	const toolUse = (...calls: ReturnType<typeof fauxToolCall>[]) => fauxAssistantMessage(calls, { stopReason: "toolUse" });
	let n = 0;

	type Person = { web: Client; ownerId: string; chat: string };
	const host = {} as Person;
	const guest = {} as Person;
	const bob = {} as Person;
	let connector: string;
	let botId: string;
	let circleId: string;
	let agentId: string;

	const transcript = async (who: Person) => {
		const c = (await d.stack.admin.query("SELECT partition_id, conversation_id FROM pim_runtime.conversation_partitions WHERE public_chat_id = $1", [who.chat])).rows[0];
		if (!c) return "[]";
		return JSON.stringify(await readTranscript(d.stack.runtime, who.ownerId, c.partition_id, Number(c.conversation_id)));
	};
	const results = async (who: Person, tool: string) =>
		(JSON.parse(await transcript(who)) as { model?: { role: string; toolName?: string; content: { text?: string }[] }[] }[]).flatMap((e) => (e.model ?? []).filter((m) => m.role === "toolResult" && m.toolName === tool).map((m) => m.content.map((c) => c.text ?? "").join("")));
	const finish = (who: Person) => waitFor("the turn to end", async () => ((await transcript(who)).includes(`done ${n}`) ? true : undefined), 60_000);
	const send = async (who: Person, words: string, park: boolean, ...script: unknown[]) => {
		faux.setResponses([...script, fauxAssistantMessage(`done ${++n}`)] as never);
		expect((await who.web.call("POST", `/api/sessions/${who.chat}/messages`, { commandId: `m-${n}`, text: words })).status).toBe(202);
		if (!park) await finish(who);
	};
	const waitingOnHost = () => waitFor("an approval on the host", async () => (await d.stack.admin.query("SELECT id, tool, args FROM pim_app.approvals WHERE owner_id = $1 AND state = 'waiting'", [host.ownerId])).rows[0], 60_000);
	const mcpCalls = () => mcp.calls.map((c) => c.name);

	beforeAll(async () => {
		await new Promise<void>((r) => mcp.server.listen(0, "127.0.0.1", r));
		const url = `http://127.0.0.1:${(mcp.server.address() as { port: number }).port}/mcp`;
		const stack = await createStack();
		d = { stack, nats: await startNats(), s3: await startS3(), gatePort: await freePort(), ingressSecret: "ingress" };
		const keys = { PIM_KEK_T1: randomBytes(32).toString("base64"), PIM_KEK_CURRENT: "t1", PIM_CONNECTOR_ALLOW_PRIVATE: "1" };
		app = new App(connectApp(stack.url("gate"), 4), new MemoryObjectStore());
		gate = await start(d, "gate", {}, keys);
		runner = await start(d, "runner", { pollMs: 40, providers: () => [faux.provider] }, { PIM_DEFAULT_MODEL: "faux/m", PIM_APP_DATABASE_URL: stack.url("gate"), ...keys });
		host.web = new Client(base(gate), d.ingressSecret);
		const claim = await app.identity.issueClaim("bootstrap", null, 3_600_000);
		const registered = await host.web.call("POST", "/auth/register", { username: "anibal", bootstrap: claim, session: true });
		expect(registered.status).toBe(201);
		host.ownerId = registered.json.account.ownerId;
		host.chat = (await host.web.call("POST", "/api/sessions", { title: "Home" })).json.id;
		// The host connects a server and switches three of its tools on; `internal` stays off, and is shared with no one.
		const made = await host.web.call("POST", "/api/connectors", { kind: "custom_mcp", name: "Tickets", url, credential: TOKEN });
		connector = made.json.connector.id;
		await host.web.call("POST", `/api/connectors/${connector}/discover`);
		expect((await host.web.call("PUT", `/api/connectors/${connector}/tools`, { tools: ["search", "create_ticket", "delete_all"] })).status).toBe(200);
		agentId = (await host.web.call("POST", "/api/agents", { name: "Helper", instructions: "Help with tickets." })).json.id;
	}, 180_000);
	afterAll(async () => {
		await Promise.allSettled([runner?.close(), gate?.close()]);
		await new Promise((r) => mcp.server.close(r));
		await app?.db.end();
		d?.nats.stop();
		await d?.s3.stop();
		await d?.stack.drop();
	}, 60_000);

	it("shares a bot, and a guest joins through its link under closed registration with a copy of the agent", async () => {
		// Only an admin shares a bot.
		const shared = await host.web.call("PUT", `/api/agents/${agentId}/bot`, { dailyMessages: 5, dailyToolCalls: 4, tools: ["search", "create_ticket", "delete_all"], ask: ["create_ticket"] });
		expect(shared.status).toBe(200);
		botId = shared.json.id;
		expect((await host.web.call("GET", `/api/bots/${botId}`)).json).toMatchObject({ id: botId, author: "anibal" });
		expect((await new Client(base(gate), d.ingressSecret).call("POST", "/auth/register", { username: "nobot", bot: "b_nope" })).status).toBe(404);

		guest.web = new Client(base(gate), d.ingressSecret);
		const joined = await guest.web.call("POST", "/auth/register", { username: "visitor", bot: botId, session: true });
		expect(joined.status).toBe(201);
		expect(joined.json.account).toMatchObject({ role: "guest", username: "visitor" });
		guest.ownerId = joined.json.account.ownerId;
		const mine = (await guest.web.call("GET", "/api/bot")).json;
		expect(mine.bot).toMatchObject({ id: botId, author: "anibal", dailyMessages: 5, dailyToolCalls: 4 });
		const agents = (await guest.web.call("GET", "/api/agents")).json.agents as { id: string; name: string; instructions: string }[];
		// Their own copy of the agent (the majordomo is the app's own entry), not the host's.
		expect(agents.find((a) => a.id === mine.agent)).toMatchObject({ name: "Helper", instructions: "Help with tickets." });
		expect(mine.agent).not.toBe(agentId);
		guest.chat = (await guest.web.call("POST", "/api/sessions", { title: "Hi", agentId: mine.agent })).json.id;
	});

	it("keeps a guest to its allow-list: no agents of its own, circles, connectors or tokens", async () => {
		expect((await guest.web.call("PUT", `/api/agents/${agentId}`, { name: "Mine" })).status).toBe(403);
		expect((await guest.web.call("POST", "/api/agents", { name: "Mine" })).status).toBe(403);
		expect((await guest.web.call("GET", "/api/circles")).status).toBe(403);
		expect((await guest.web.call("POST", "/api/connectors", { kind: "custom_mcp", name: "x", url: "http://127.0.0.1:1/mcp" })).status).toBe(403);
		expect((await guest.web.call("GET", "/api/admin/accounts")).status).toBe(403);
		expect((await guest.web.call("GET", "/api/agents")).status).toBe(200);
		// Only an admin shares an agent as a bot.
		const bobRegister = new Client(base(gate), d.ingressSecret);
		const invite = ((await host.web.call("POST", "/api/admin/invites", {})).json.links as string[])[0]!.split("#invite=")[1];
		const b = await bobRegister.call("POST", "/auth/register", { username: "bob", invite, session: true });
		expect(b.status).toBe(201);
		bob.web = bobRegister;
		bob.ownerId = b.json.account.ownerId;
		bob.chat = (await bob.web.call("POST", "/api/sessions", { title: "Bob" })).json.id;
		const bobAgent = (await bob.web.call("POST", "/api/agents", { name: "B" })).json.id;
		expect((await bob.web.call("PUT", `/api/agents/${bobAgent}/bot`, { tools: [] })).status).toBe(403);
	});

	it("gives a guest's agent only the host's shared tools: a read runs, a call that asks waits for the host, a tool it was not given does not exist", async () => {
		await send(guest, "what can I use?", false, toolUse(fauxToolCall("guest_tools", {})), toolUse(fauxToolCall("fetch_url", { url: "https://example.com" })), toolUse(fauxToolCall("connector_tools", {})), toolUse(fauxToolCall("guest_call", { connector, tool: "search", arguments: { q: "printer" } })), toolUse(fauxToolCall("guest_call", { connector, tool: "internal", arguments: {} })));
		const listed = (await results(guest, "guest_tools"))[0]!;
		expect(listed).toContain("create_ticket");
		expect(listed).toContain('"asksFirst": true');
		expect(listed).not.toContain("internal");
		// Nothing of the host's own tools, the web or the host's connectors outside the bot's list.
		expect((await results(guest, "fetch_url"))[0]).toMatch(/isn't available here/);
		expect((await results(guest, "connector_tools"))[0]).toMatch(/isn't available here/);
		expect((await results(guest, "guest_call"))[0]).toContain('search ok {"q":"printer"}');
		expect((await results(guest, "guest_call"))[1]).toMatch(/doesn't share a tool internal/);
		expect(mcp.calls).toEqual([{ name: "search", arguments: { q: "printer" }, authorization: `Bearer ${TOKEN}` }]);

		await send(guest, "open a ticket", true, toolUse(fauxToolCall("guest_call", { connector, tool: "create_ticket", arguments: { title: "Printer" } })));
		const approval = await waitingOnHost();
		expect(approval.id).toMatch(/^g-[0-9a-f]{32}$/);
		expect(approval.args).toMatchObject({ connector, tool: "create_ticket", requestedBy: { username: "visitor", circleName: expect.any(String), bot: botId } });
		expect(mcpCalls()).toEqual(["search"]);
		// The host sees it in the approvals the web app lists, with who asked, and decides it.
		const listedApproval = (await host.web.call("GET", "/api/approvals")).json.approvals.find((a: any) => a.id === approval.id);
		expect(listedApproval).toMatchObject({ status: "pending", requestedBy: { username: "visitor", bot: botId } });
		expect((await host.web.call("POST", `/api/approvals/${approval.id}/approve`, {})).status).toBe(200);
		await finish(guest);
		expect(mcpCalls()).toEqual(["search", "create_ticket"]);
		expect((await results(guest, "guest_call")).at(-1)).toContain("create_ticket ok");
	}, 180_000);

	it("does not make a call the host denied, and counts the guest's day", async () => {
		await send(guest, "another ticket", true, toolUse(fauxToolCall("guest_call", { connector, tool: "create_ticket", arguments: { title: "No" } })));
		const approval = await waitingOnHost();
		expect((await host.web.call("POST", `/api/approvals/${approval.id}/deny`, {})).status).toBe(200);
		await finish(guest);
		expect((await results(guest, "guest_call")).at(-1)).toMatch(/didn't approve/);
		expect(mcpCalls()).toEqual(["search", "create_ticket"]);
		// The bot allows four calls a day: a search, a ticket, the denied one, and one more search; the next is refused.
		await send(guest, "search again", false, toolUse(fauxToolCall("guest_call", { connector, tool: "search", arguments: { q: "a" } })), toolUse(fauxToolCall("guest_call", { connector, tool: "search", arguments: { q: "b" } })));
		const last = await results(guest, "guest_call");
		expect(last.at(-2)).toContain("search ok");
		expect(last.at(-1)).toMatch(/reset at midnight UTC/);
		expect(mcpCalls()).toEqual(["search", "create_ticket", "search"]);
		const log = (await host.web.call("GET", "/api/circles/activity")).json.activity as { username: string; tool: string; outcome: string }[];
		expect(log.map((a) => `${a.tool}:${a.outcome}`)).toEqual(expect.arrayContaining(["search:ran", "create_ticket:asked", "internal:refused", "search:refused"]));
		expect(log.every((a) => a.username === "visitor")).toBe(true);
	}, 180_000);

	it("stops a guest's messages at the bot's daily limit and its tools when the link is turned off", async () => {
		// Five messages a day; four were sent so far, one more is allowed and the next is not.
		await send(guest, "one more", false);
		const over = await guest.web.call("POST", `/api/sessions/${guest.chat}/messages`, { commandId: "over-2", text: "and another" });
		expect(over.status).toBe(429);
		expect((await host.web.call("DELETE", `/api/agents/${agentId}/bot`)).json).toEqual({ deleted: true });
		expect((await guest.web.call("GET", "/api/bot")).json.bot).toBeNull();
		await d.stack.admin.query("UPDATE pim_app.guest_calls SET calls = 0, messages = 0");
		// Their limits are 0 now: a message is refused, and a call, were one made, would be too.
		expect((await guest.web.call("POST", `/api/sessions/${guest.chat}/messages`, { commandId: "try-now", text: "try now" })).status).toBe(429);
		await expect(app.guests.boundary(guest.ownerId, guest.chat)).rejects.toThrow(/isn't shared any more/);
		expect((await new Client(base(gate), d.ingressSecret).call("POST", "/auth/register", { username: "late", bot: botId })).status).toBe(404);
		expect(mcpCalls()).toEqual(["search", "create_ticket", "search"]);
	}, 120_000);

	it("lets a circle member's visit reach what the host granted that circle, and nothing before", async () => {
		const circle = await host.web.call("POST", "/api/circles", { name: "Friends" });
		expect(circle.status).toBe(201);
		circleId = circle.json.id;
		expect(circle.json).toMatchObject({ enabled: true, memoryScopes: [], members: [] });
		expect((await host.web.call("POST", `/api/circles/${circleId}/members`, { username: "visitor" })).status).toBe(404);
		const added = await host.web.call("POST", `/api/circles/${circleId}/members`, { username: "bob" });
		expect(added.json.members).toMatchObject([{ ownerId: bob.ownerId, username: "bob" }]);
		expect((await bob.web.call("GET", "/api/visits")).json.visits).toMatchObject([{ username: "anibal", available: true, session: null }]);
		const visit = await bob.web.call("POST", "/api/visits/anibal");
		expect(visit.status).toBe(201);
		const session = visit.json.session;
		expect((await bob.web.call("POST", "/api/visits/anibal")).json.session).toBe(session);
		const visitor: Person = { ...bob, chat: session };

		// A new circle has every tool off.
		await send(visitor, "search", false, toolUse(fauxToolCall("guest_call", { connector, tool: "search", arguments: { q: "x" } })));
		expect((await results(visitor, "guest_call"))[0]).toMatch(/doesn't share a tool search/);
		const perms = (await host.web.call("GET", `/api/permissions?circle=${circleId}`)).json.tools as { tool: string; permission: string }[];
		expect(Object.fromEntries(perms.map((t) => [t.tool, t.permission]))).toMatchObject({ search: "off", create_ticket: "off", delete_all: "off" });
		expect((await host.web.call("PUT", "/api/permissions", { circle: circleId, app: connector, tool: "search", permission: "on" })).json).toMatchObject({ permission: "on", chosen: "on" });
		expect((await host.web.call("PUT", "/api/permissions", { circle: circleId, app: connector, tool: "delete_all", permission: "on" })).json).toMatchObject({ permission: "ask" });
		const before = mcp.calls.length;
		await send(visitor, "search now", false, toolUse(fauxToolCall("guest_call", { connector, tool: "search", arguments: { q: "x" } })), toolUse(fauxToolCall("guest_call", { connector, tool: "create_ticket", arguments: {} })));
		expect((await results(visitor, "guest_call")).slice(-2)[0]).toContain("search ok");
		expect((await results(visitor, "guest_call")).at(-1)).toMatch(/doesn't share a tool create_ticket/);
		expect(mcp.calls.length).toBe(before + 1);
		// The host's own agents never see a circle's choices.
		const own = (await host.web.call("GET", "/api/permissions")).json.tools as { tool: string; permission: string }[];
		expect(own.find((t) => t.tool === "search")!.permission).toBe("on");
		expect(own.find((t) => t.tool === "create_ticket")!.permission).toBe("ask");

		// A paused circle, and a member taken out, stop the next call; a person is in one circle at most.
		expect((await host.web.call("PUT", `/api/circles/${circleId}`, { enabled: false })).json).toMatchObject({ enabled: false });
		await send(visitor, "paused?", false, toolUse(fauxToolCall("guest_call", { connector, tool: "search", arguments: {} })));
		expect((await results(visitor, "guest_call")).at(-1)).toMatch(/paused sharing/);
		await host.web.call("PUT", `/api/circles/${circleId}`, { enabled: true });
		const second = (await host.web.call("POST", "/api/circles", { name: "Work" })).json.id;
		await host.web.call("POST", `/api/circles/${second}/members`, { username: "bob" });
		const circles = (await host.web.call("GET", "/api/circles")).json.circles as { id: string; members: unknown[] }[];
		expect(circles.map((c) => [c.id === circleId ? "Friends" : "Work", c.members.length])).toEqual([["Friends", 0], ["Work", 1]]);
		await send(visitor, "moved", false, toolUse(fauxToolCall("guest_call", { connector, tool: "search", arguments: {} })));
		expect((await results(visitor, "guest_call")).at(-1)).toMatch(/doesn't share a tool search/);
		await host.web.call("DELETE", `/api/circles/${second}/members/${bob.ownerId}`);
		await send(visitor, "gone", false, toolUse(fauxToolCall("guest_call", { connector, tool: "search", arguments: {} })));
		expect((await results(visitor, "guest_call")).at(-1)).toMatch(/doesn't share their space with you/);
		expect((await bob.web.call("POST", "/api/visits/anibal")).status).toBe(403);
	}, 240_000);

	it("gives the admin's majordomo the admin API as three tools, and no one else", async () => {
		await send(host, "how is the deployment?", false, toolUse(fauxToolCall("admin_read", { path: "/api/admin/stats" })), toolUse(fauxToolCall("admin_read", { path: "/api/admin/deployment" })), toolUse(fauxToolCall("admin_read", { path: "/api/other" })));
		const read = await results(host, "admin_read");
		expect(JSON.parse(read[0]!)).toMatchObject({ status: 200, body: { accounts: { active: 3, admins: 1, guests: 1 } } });
		expect(read[1]).toContain("PIM_PUBLIC_URL");
		expect(read[2]).toMatch(/starting \/api\/admin|A path is/);

		// A change that can be undone runs; one that cannot is not offered through that tool.
		await send(host, "turn notes off", false, toolUse(fauxToolCall("admin_write", { method: "PUT", path: "/api/admin/builtin-apps/notes", body: { enabled: false } })), toolUse(fauxToolCall("admin_write", { method: "DELETE", path: "/api/admin/apps/custom/none" })));
		const wrote = await results(host, "admin_write");
		expect(JSON.parse(wrote[0]!)).toMatchObject({ status: 200, body: { apps: [{ id: "notes", enabled: false }] } });
		expect(wrote[1]).toMatch(/use admin_write_approved/);
		expect((await host.web.call("GET", "/api/builtin-apps")).json.apps).toEqual([]);
		expect((await host.web.call("GET", "/api/notes")).status).toBe(404);
		await host.web.call("PUT", "/api/admin/builtin-apps/notes", { enabled: true });
		expect((await host.web.call("GET", "/api/builtin-apps")).json.apps).toMatchObject([{ id: "notes" }]);

		// A credential or a delete asks the admin each time, and runs only on a yes.
		const entry = (await host.web.call("POST", "/api/admin/apps", { name: "Temp", url: "https://example.com/mcp" })).json.app.id as string;
		await send(host, "remove the temp connector", true, toolUse(fauxToolCall("admin_write_approved", { method: "DELETE", path: `/api/admin/apps/${entry}` })));
		const approval = await waitFor("the admin's approval", async () => (await d.stack.admin.query("SELECT id, args FROM pim_app.approvals WHERE tool = 'admin:write' AND state = 'waiting'")).rows[0], 60_000);
		expect(approval.args).toMatchObject({ method: "DELETE", path: `/api/admin/apps/${encodeURIComponent(entry)}` });
		expect((await host.web.call("GET", "/api/admin/accounts?limit=2")).json).toMatchObject({ next: expect.any(String) });
		expect((await host.web.call("GET", "/api/app-directory")).json.apps.map((a: any) => a.ref)).toContain(entry);
		expect((await host.web.call("POST", `/api/approvals/${approval.id}/approve`, {})).status).toBe(200);
		await finish(host);
		expect(JSON.parse((await results(host, "admin_write_approved")).at(-1)!)).toMatchObject({ status: 200, body: { deleted: true } });
		expect((await host.web.call("GET", "/api/app-directory")).json.apps.map((a: any) => a.ref)).not.toContain(entry);

		await send(host, "delete another", true, toolUse(fauxToolCall("admin_write_approved", { method: "DELETE", path: "/api/admin/apps/custom/zzz" })));
		const denied = await waitFor("a second approval", async () => (await d.stack.admin.query("SELECT id FROM pim_app.approvals WHERE tool = 'admin:write' AND state = 'waiting'")).rows[0], 60_000);
		await host.web.call("POST", `/api/approvals/${denied.id}/deny`, {});
		await finish(host);
		expect((await results(host, "admin_write_approved")).at(-1)).toMatch(/did not approve/);
		expect((await d.stack.admin.query("SELECT action, decision FROM pim_app.audit_log WHERE actor = 'agent:majordomo' AND action = 'admin_write_approved' ORDER BY id")).rows.map((r) => r.decision)).toEqual(["approval_required", "allowed", "approval_required", "denied"]);

		// Neither a member's majordomo nor another agent of the admin's has them, and the last admin cannot be suspended through them.
		await send(bob, "run the pim", false, toolUse(fauxToolCall("admin_read", { path: "/api/admin/stats" })));
		expect((await results(bob, "admin_read")).at(-1)).toMatch(/Only the admin/);
		const other: Person = { ...host, chat: (await host.web.call("POST", "/api/sessions", { title: "Helper", agentId })).json.id };
		await send(other, "run the pim", false, toolUse(fauxToolCall("admin_read", { path: "/api/admin/stats" })));
		expect((await results(other, "admin_read")).at(-1)).toMatch(/Only your majordomo/);
		await send(host, "suspend me", true, toolUse(fauxToolCall("admin_write_approved", { method: "POST", path: "/api/admin/accounts/anibal/suspend" })));
		const self = await waitFor("an approval to suspend", async () => (await d.stack.admin.query("SELECT id FROM pim_app.approvals WHERE tool = 'admin:write' AND state = 'waiting'")).rows[0], 60_000);
		await host.web.call("POST", `/api/approvals/${self.id}/approve`, {});
		await finish(host);
		expect((await results(host, "admin_write_approved")).at(-1)).toMatch(/"status": 403/);
		expect((await d.stack.admin.query("SELECT status FROM pim_app.accounts WHERE username = 'anibal'")).rows[0].status).toBe("active");
	}, 300_000);
});
