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
import { createStack, describeWith, freePort, hasNats, startNats, sentAndAnswered } from "./support/stack.ts";

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
	// The host's image model: an OpenAI-compatible endpoint that answers every request with one tiny picture.
	const PNG = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGP4z8DwHwAFAAH/q842iQAAAABJRU5ErkJggg==";
	const drawn: unknown[] = [];
	const images: Server = createServer((req, res) => {
		let raw = "";
		req.on("data", (c) => (raw += c));
		req.on("end", () => {
			drawn.push(JSON.parse(raw));
			res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ data: [{ b64_json: PNG }] }));
		});
	});
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
	let guestAgent: string;

	const transcript = async (who: Person) => {
		const c = (await d.stack.admin.query("SELECT partition_id, conversation_id FROM pim_runtime.conversation_partitions WHERE public_chat_id = $1", [who.chat])).rows[0];
		if (!c) return "[]";
		return JSON.stringify(await readTranscript(d.stack.runtime, who.ownerId, c.partition_id, Number(c.conversation_id)));
	};
	const results = async (who: Person, tool: string) =>
		(JSON.parse(await transcript(who)) as { model?: { role: string; toolName?: string; content: { text?: string }[] }[] }[]).flatMap((e) => (e.model ?? []).filter((m) => m.role === "toolResult" && m.toolName === tool).map((m) => m.content.map((c) => c.text ?? "").join("")));
	const finish = (who: Person) => waitFor("the turn to end", async () => (sentAndAnswered(await transcript(who), `done ${n}`) ? true : undefined), 60_000);
	const send = async (who: Person, words: string, park: boolean, ...script: unknown[]) => {
		faux.setResponses([...script, toolUse(fauxToolCall("send_to_user", { message: `done ${++n}` })), fauxAssistantMessage(`ended ${n}`)] as never);
		expect((await who.web.call("POST", `/api/sessions/${who.chat}/messages`, { commandId: `m-${n}`, text: words })).status).toBe(202);
		if (!park) await finish(who);
	};
	const waitingOnHost = () => waitFor("an approval on the host", async () => (await d.stack.admin.query("SELECT id, tool, args FROM pim_app.approvals WHERE owner_id = $1 AND state = 'waiting'", [host.ownerId])).rows[0], 60_000);
	const mcpCalls = () => mcp.calls.map((c) => c.name);

	beforeAll(async () => {
		await new Promise<void>((r) => mcp.server.listen(0, "127.0.0.1", r));
		await new Promise<void>((r) => images.listen(0, "127.0.0.1", r));
		const url = `http://127.0.0.1:${(mcp.server.address() as { port: number }).port}/mcp`;
		const stack = await createStack();
		d = { stack, nats: await startNats(), s3: await startS3(), gatePort: await freePort(), ingressSecret: "ingress" };
		const keys = { PIM_KEK_T1: randomBytes(32).toString("base64"), PIM_KEK_CURRENT: "t1", PIM_CONNECTOR_ALLOW_PRIVATE: "1" };
		app = new App(connectApp(stack.url("gate"), 4), new MemoryObjectStore());
		// The compat routes read the process environment: the deployment's default model is one it offers everyone.
		process.env.PIM_DEFAULT_MODEL = "faux/m";
		gate = await start(d, "gate", {}, { ...keys, PIM_REGISTRATIONS_PER_ADDRESS: "1000" });
		runner = await start(d, "runner", { pollMs: 40, providers: () => [faux.provider] }, { PIM_DEFAULT_MODEL: "faux/m", PIM_APP_DATABASE_URL: stack.url("gate"), PIM_AI_GATEWAY_URL: `http://127.0.0.1:${(images.address() as { port: number }).port}`, PIM_IMAGE_MODEL: "gateway/draw-1", ...keys });
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
		agentId = (await host.web.call("POST", "/api/agents", { name: "Helper", description: "Helps with tickets.", instructions: "Help with tickets.", apps: [connector] })).json.id;
	}, 180_000);
	afterAll(async () => {
		await Promise.allSettled([runner?.close(), gate?.close()]);
		await new Promise((r) => mcp.server.close(r));
		await new Promise((r) => images.close(r));
		delete process.env.PIM_DEFAULT_MODEL;
		await app?.db.end();
		d?.nats.stop();
		await d?.s3.stop();
		await d?.stack.drop();
	}, 60_000);

	it("shares a bot, and a guest joins through its link under closed registration with a copy of the agent", async () => {
		// Only an admin shares a bot.
		// Guests can't use the host's own plan or providers, but a model the deployment offers everyone.
		expect((await host.web.call("PUT", `/api/agents/${agentId}/bot`, { model: { provider: "chatgpt", id: "gpt-5" }, tools: [] })).status).toBe(400);
		const shared = await host.web.call("PUT", `/api/agents/${agentId}/bot`, { model: { provider: "faux", id: "m" }, dailyMessages: 5, dailyToolCalls: 4, tools: ["search", "create_ticket", "delete_all"], ask: ["create_ticket"] });
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
		// On the model the bot was given.
		expect(agents.find((a) => a.id === mine.agent)).toMatchObject({ model: { provider: "faux", id: "m" } });
		guest.chat = (await guest.web.call("POST", "/api/sessions", { title: "Hi", agentId: mine.agent })).json.id;
		guestAgent = mine.agent;
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

	it("checks what a bot shares, keeps what a later sharing leaves out, and has a guest's copy follow the bot on their next request", async () => {
		const bad = (body: unknown) => host.web.call("PUT", `/api/agents/${agentId}/bot`, body);
		expect((await bad({ dailyMessages: 0 })).status).toBe(400);
		expect((await bad({ model: { provider: "faux", id: "not-offered" } })).status).toBe(400);
		const unknown = await bad({ tools: ["search", "format_disk"] });
		expect(unknown.status).toBe(400);
		expect(unknown.json.message).toContain("can't share format_disk");
		expect((await bad({ tools: ["search"], ask: ["create_ticket"] })).status).toBe(400);
		expect((await host.web.call("GET", `/api/agents/${agentId}/bot`)).json).toMatchObject({ dailyMessages: 5, dailyToolCalls: 4, tools: ["search", "create_ticket", "delete_all"], ask: ["create_ticket"], model: { provider: "faux", id: "m" } });
		// The card carries the agent's description.
		expect((await new Client(base(gate), d.ingressSecret).call("GET", `/api/bots/${botId}`)).json).toMatchObject({ name: "Helper", description: "Helps with tickets." });
		expect((await guest.web.call("GET", "/api/bot")).json.bot).toMatchObject({ description: "Helps with tickets." });

		// Shared again after the agent changed, with settings left out: the tools, the ask list, the limits and the model stay, and the guest's copy follows at its next request. generate_image is shareable too.
		await host.web.call("PUT", `/api/agents/${agentId}`, { instructions: "Help with tickets, politely.", description: "Helps politely." });
		const before = (await guest.web.call("GET", "/api/agents")).json.agents.find((a: any) => a.id === guestAgent);
		expect(before.instructions).toBe("Help with tickets."); // the bot is what was last shared, not the agent as it is now
		const again = await host.web.call("PUT", `/api/agents/${agentId}/bot`, { tools: ["search", "create_ticket", "delete_all", "generate_image"] });
		expect(again.json).toMatchObject({ id: botId, dailyMessages: 5, dailyToolCalls: 4, tools: ["search", "create_ticket", "delete_all", "generate_image"], ask: ["create_ticket"], model: { provider: "faux", id: "m" } });
		const after = (await guest.web.call("GET", "/api/agents")).json.agents.find((a: any) => a.id === guestAgent);
		expect(after).toMatchObject({ instructions: "Help with tickets, politely.", description: "Helps politely.", model: { provider: "faux", id: "m" } });
		expect((await guest.web.call("GET", "/api/bot")).json.bot).toMatchObject({ description: "Helps politely." });
		expect((await host.web.call("PUT", `/api/agents/${agentId}/bot`, {})).json).toMatchObject({ tools: ["search", "create_ticket", "delete_all", "generate_image"], ask: ["create_ticket"] });
	});

	it("lets a bot share generate_image: the host's image model draws it, the host keeps it under bots/, and the guest's chat has its own copy", async () => {
		const painter = {} as Person;
		painter.web = new Client(base(gate), d.ingressSecret);
		const joined = await painter.web.call("POST", "/auth/register", { username: "painter", bot: botId, session: true });
		expect(joined.status).toBe(201);
		painter.ownerId = joined.json.account.ownerId;
		const mine = (await painter.web.call("GET", "/api/bot")).json.agent as string;
		painter.chat = (await painter.web.call("POST", "/api/sessions", { title: "Art", agentId: mine })).json.id;
		await send(painter, "what can I use?", false, toolUse(fauxToolCall("guest_tools", {})), toolUse(fauxToolCall("guest_call", { connector: "pim", tool: "generate_image", arguments: { prompt: "a cat in a hat", shape: "landscape" } })));
		expect((await results(painter, "guest_tools"))[0]).toContain('"tool": "generate_image"');
		const made = JSON.parse((await results(painter, "guest_call"))[0]!);
		expect(made.image).toMatchObject({ type: "image/png", path: expect.stringMatching(/^\/workspace\/images\/.+\.png$/) });
		expect(drawn).toEqual([expect.objectContaining({ prompt: "a cat in a hat", size: "1536x1024" })]);
		const keys = (await d.stack.admin.query("SELECT key FROM pim_app.objects WHERE key LIKE $1 OR key LIKE $2 ORDER BY key", [`${host.ownerId}/files/workspace/bots/${botId}/${painter.ownerId}/%`, `${painter.ownerId}/files/workspace/images/%`])).rows.map((r) => r.key as string);
		expect(keys).toHaveLength(2);
		expect(keys.some((k) => k.startsWith(`${host.ownerId}/files/workspace/bots/${botId}/${painter.ownerId}/`))).toBe(true);
		expect(keys.some((k) => k === `${painter.ownerId}${made.image.path.replace(/^/, "/files")}`)).toBe(true);
	}, 180_000);

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
		expect(log.filter((a) => a.username !== "painter").every((a) => a.username === "visitor")).toBe(true);
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

		// The host's time zone and the memory its circle may read are the visit's, and no other: the circle reads nothing until it is given a scope.
		const hostP = { kind: "user", ownerId: host.ownerId, role: "admin", sessionId: "s" } as never;
		await app.memories.remember(hostP, "everyone", "Anibal's locker code", "The locker code is 4512");
		await app.memories.remember(hostP, "diary", "Anibal's secret", "Never share this diary entry");
		await app.memories.remember({ ...(hostP as object), ownerId: bob.ownerId, role: "member" } as never, "everyone", "Bob's own note", "Bob keeps bees");
		await host.web.call("PUT", "/api/settings", { timeZone: "Pacific/Auckland" });
		const brief = async () => (await d.stack.admin.query("SELECT pim_app.runner_visit_brief($1, $2, 96) AS b", [bob.ownerId, visitor.chat])).rows[0].b;
		expect(await brief()).toMatchObject({ host: "anibal", circle: "Friends", available: true, timeZone: "Pacific/Auckland", memory: null });
		await send(visitor, "what do you know of him?", false, toolUse(fauxToolCall("recall", { pattern: "locker" })));
		expect((await results(visitor, "recall")).at(-1)).toBe("No match.");
		await host.web.call("PUT", `/api/circles/${circleId}`, { memoryScopes: ["everyone"] });
		expect((await brief()).memory).toEqual([expect.objectContaining({ title: "Anibal's locker code", scope: "everyone" })]);
		await send(visitor, "his locker?", false, toolUse(fauxToolCall("recall", { pattern: "locker" })), toolUse(fauxToolCall("recall", { pattern: "diary|bees" })));
		const recalled = await results(visitor, "recall");
		expect(recalled.at(-2)).toContain("Anibal's locker code");
		expect(recalled.at(-1)).toBe("No match."); // neither the host's diary scope nor the visitor's own memory
		await host.web.call("PUT", `/api/circles/${circleId}`, { memoryScopes: [] });

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
		expect(JSON.parse(read[0]!)).toMatchObject({ status: 200, body: { accounts: { active: 4, admins: 1, guests: 2 }, registrationsLastDay: expect.any(Number), invitesUnused: 0, cleanups: { queued: 0, failing: 0 } } });
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

	it("lets the admin's majordomo read its own audit, diagnostics and health, and do in the app what the person does, with deletes asking first", async () => {
		await send(host, "audit what you did", false, toolUse(fauxToolCall("admin_audit", { limit: 3 })), toolUse(fauxToolCall("pim_health", {})), toolUse(fauxToolCall("pim_diagnostics", { kind: "approvals" })));
		const audit = JSON.parse((await results(host, "admin_audit")).at(-1)!);
		expect(audit.writes.length).toBe(3);
		expect(audit.writes[0]).toMatchObject({ tool: expect.stringMatching(/^admin_/), method: expect.any(String), path: expect.stringMatching(/^\/api\/admin\//), decision: expect.any(String) });
		expect(JSON.parse((await results(host, "pim_health")).at(-1)!)).toMatchObject({ status: 200, body: { counts: { active_accounts: expect.any(Number) } } });
		expect(JSON.parse((await results(host, "pim_diagnostics")).at(-1)!).status).toBe(200);

		const goal = (await host.web.call("POST", "/api/goals", { title: "Sail", steps: ["Buy a boat"] })).json;
		await send(host, "look at the app", false,
			toolUse(fauxToolCall("ui_routes", {})), toolUse(fauxToolCall("ui_read", { path: "/api/goals" })), toolUse(fauxToolCall("ui_read", { path: "/api/account/export" })), toolUse(fauxToolCall("ui_read", { path: "/api/admin/stats" })),
			toolUse(fauxToolCall("ui_write", { method: "DELETE", path: `/api/goals/${goal.id}` })));
		expect((await results(host, "ui_routes")).at(-1)).toContain('"class":"blocked"');
		expect((await results(host, "ui_read"))[0]).toContain("Sail");
		expect((await results(host, "ui_read"))[1]).toMatch(/not open to you/);
		expect((await results(host, "ui_read"))[2]).toMatch(/not open to you/); // the admin API has its own tools
		expect((await results(host, "ui_write")).at(-1)).toMatch(/use ui_write_destructive/);

		await send(host, "rename the goal", false, toolUse(fauxToolCall("ui_write", { method: "PUT", path: `/api/goals/${goal.id}`, body: { title: "Sail far" } })));
		expect((await host.web.call("GET", `/api/goals/${goal.id}`)).json).toMatchObject({ title: "Sail far" });
		// A delete asks the admin, with the exact request, and runs only on a yes.
		await send(host, "drop the goal", true, toolUse(fauxToolCall("ui_write_destructive", { method: "DELETE", path: `/api/goals/${goal.id}` })));
		const asked = await waitFor("the delete's approval", async () => (await d.stack.admin.query("SELECT id, args FROM pim_app.approvals WHERE tool = 'admin:write' AND state = 'waiting'")).rows[0], 60_000);
		expect(asked.args).toMatchObject({ method: "DELETE", path: `/api/goals/${goal.id}` });
		expect((await host.web.call("GET", `/api/goals/${goal.id}`)).status).toBe(200);
		await host.web.call("POST", `/api/approvals/${asked.id}/approve`, {});
		await finish(host);
		expect((await host.web.call("GET", `/api/goals/${goal.id}`)).status).toBe(404);
		await send(host, "what did you change?", false, toolUse(fauxToolCall("ui_audit", {})));
		const kept = JSON.parse((await results(host, "ui_audit")).at(-1)!).writes as { tool: string; decision: string; keys: string[]; status: number }[];
		expect(kept.map((w) => [w.tool, w.decision])).toEqual([["ui_write_destructive", "allowed"], ["ui_write_destructive", "approval_required"], ["ui_write", "allowed"]]);
		expect(kept[2]).toMatchObject({ keys: ["title"], status: 200 });
		// A member's majordomo has none of them.
		await send(bob, "use the app routes", false, toolUse(fauxToolCall("ui_read", { path: "/api/goals" })));
		expect((await results(bob, "ui_read")).at(-1)).toMatch(/Only the admin/);
	}, 240_000);

	it("has a development sign-in only where PIM_DEV_SIGN_IN is on, which makes the account, gives it the default agent and joins a bot's guests", async () => {
		const open = (path: string) => fetch(`${base(gate)}${path}`, { redirect: "manual", headers: { "x-pim-ingress-secret": d.ingressSecret } });
		expect((await open("/__dev/sign-in/devvy")).status).toBe(404);
		process.env.PIM_DEV_SIGN_IN = "1";
		try {
			const made = await open("/__dev/sign-in/devvy?returnTo=/settings");
			expect(made.status).toBe(302);
			expect(made.headers.get("location")).toBe("/settings");
			const cookie = made.headers.get("set-cookie")!.split(";")[0]!;
			const me = await fetch(`${base(gate)}/api/account`, { headers: { cookie, "x-pim-ingress-secret": d.ingressSecret } });
			expect(await me.json()).toMatchObject({ username: "devvy", role: "member", status: "active" });
			// Signing in again is the same account; a returnTo that leaves the site is not followed.
			expect((await open("/__dev/sign-in/devvy?returnTo=//evil.example")).headers.get("location")).toBe("/");
			expect((await d.stack.admin.query("SELECT count(*)::int AS n FROM pim_app.accounts WHERE username = 'devvy'")).rows[0].n).toBe(1);
			// With a bot, a new account is its guest.
			const shared = (await host.web.call("PUT", `/api/agents/${agentId}/bot`, { tools: [] })).json.id as string;
			const guestCookie = (await open(`/__dev/sign-in/devguest?bot=${shared}`)).headers.get("set-cookie")!.split(";")[0]!;
			expect(await (await fetch(`${base(gate)}/api/account`, { headers: { cookie: guestCookie, "x-pim-ingress-secret": d.ingressSecret } })).json()).toMatchObject({ role: "guest" });
			await host.web.call("DELETE", `/api/agents/${agentId}/bot`);
		} finally {
			delete process.env.PIM_DEV_SIGN_IN;
		}
	}, 60_000);
	it("stops a suspended person's agent at its next model request, so a turn under way does not go on", async () => {
		faux.setResponses([
			async () => {
				await d.stack.admin.query("UPDATE pim_app.accounts SET status = 'suspended' WHERE owner_id = $1", [bob.ownerId]);
				return toolUse(fauxToolCall("current_time", {}));
			},
			toolUse(fauxToolCall("send_to_user", { message: "never sent" })),
		] as never);
		expect((await bob.web.call("POST", `/api/sessions/${bob.chat}/messages`, { commandId: "suspend-1", text: "think for a while" })).status).toBe(202);
		await waitFor("the refusal", async () => ((await transcript(bob)).includes("This account is suspended") ? true : undefined), 60_000);
		expect(await transcript(bob)).not.toContain("never sent");
		await d.stack.admin.query("UPDATE pim_app.accounts SET status = 'active' WHERE owner_id = $1", [bob.ownerId]);
	}, 90_000);
});
