// An owner's MCP connector on the real stack, against a local fake streamable-HTTP MCP server: its tools are discovered and enabled, the agent is offered the ones that are not
// off, a read-only tool runs, a tool that asks first parks for approval and is called once after a person says yes, an off tool is neither offered nor callable, the
// permissions screen's API sets Off / Ask / On, and "always approve" turns Ask into On.
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
import { createStack, describeWith, freePort, hasNats, startNats } from "./support/stack.ts";

const real = describeWith(hasNats());
const TOKEN = "mcp-secret-token";

/** A minimal MCP server: initialize with a session, tools/list, tools/call (one answered as an event stream). It records every tools/call. */
function fakeMcp() {
	const calls: { name: string; arguments: unknown; authorization: string | undefined }[] = [];
	const tools = [
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
				return reply({ content: [{ type: "text", text: `${m.params.name} ok ${JSON.stringify(m.params.arguments)}` }] }, m.params.name === "create_ticket");
			}
			res.writeHead(404).end();
		});
	});
	return { server, calls };
}

real("connector tools", () => {
	let d: Deployment;
	let gate: Process;
	let runner: Process;
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
		faux.setResponses([...script, fauxAssistantMessage(`done ${++n}`)] as never);
		expect((await web.call("POST", `/api/sessions/${chatId}/messages`, { commandId: `m-${n}`, text: words })).status).toBe(202);
		if (!park) await waitFor(`the turn "${words}" to end`, async () => ((await transcript()).includes(`done ${n}`) ? true : undefined), 60_000);
	};
	const waiting = () => waitFor("an approval to be filed", async () => (await d.stack.admin.query("SELECT id, tool, args FROM pim_app.approvals WHERE state = 'waiting'")).rows[0], 60_000);
	const finish = () => waitFor("the turn to end", async () => ((await transcript()).includes(`done ${n}`) ? true : undefined), 60_000);
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
		// The person connects the server, finds its tools, and switches two on; the destructive one is left off.
		const made = await web.call("POST", "/api/connectors", { kind: "custom_mcp", name: "Tickets", url, credential: TOKEN });
		expect(made.status).toBe(201);
		connector = made.json.connector.id;
		expect((await web.call("POST", `/api/connectors/${connector}/discover`)).json.discovered).toBe(3);
		expect((await web.call("PUT", `/api/connectors/${connector}/tools`, { tools: ["search", "create_ticket"] })).status).toBe(200);
	}, 180_000);
	afterAll(async () => {
		await Promise.allSettled([runner?.close(), gate?.close()]);
		await new Promise((r) => mcp.server.close(r));
		await app?.db.end();
		d?.nats.stop();
		await d?.s3.stop();
		await d?.stack.drop();
	}, 60_000);

	it("keeps the credential sealed and shows each tool's default permission", async () => {
		expect((await d.stack.admin.query("SELECT credential FROM pim_app.connectors")).rows[0].credential).not.toContain(TOKEN);
		const tools = (await web.call("GET", "/api/permissions")).json.tools as { tool: string; permission: string; default: string; readOnly: boolean; destructive: boolean }[];
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
		await send("open another", true, toolUse(fauxToolCall("connector_call", { connector, tool: "create_ticket", arguments: { title: "Nope" } })), toolUse(fauxToolCall("send_to_user", { message: "ok" })));
		const approval = await waiting();
		expect((await web.call("POST", `/api/approvals/${approval.id}/deny`, {})).status).toBe(200);
		await finish();
		expect(callNames()).toEqual(["search", "create_ticket"]);
		expect((await results("connector_call")).at(-1)).toContain("did not approve");
	}, 120_000);

	it("follows the person's Off / Ask / On, and always approve turns Ask into On", async () => {
		const put = (tool: string, permission: string | null, extra: object = {}) => web.call("PUT", "/api/permissions", { app: connector, tool, permission, ...extra });
		expect((await put("create_ticket", "on")).json).toMatchObject({ permission: "on", chosen: "on" });
		await send("again", false, toolUse(fauxToolCall("connector_call", { connector, tool: "create_ticket", arguments: { title: "Direct" } })));
		expect(callNames().at(-1)).toBe("create_ticket");
		expect((await d.stack.admin.query("SELECT count(*)::int AS n FROM pim_app.approvals")).rows[0].n).toBe(2);

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
		expect((await d.stack.admin.query("SELECT count(*)::int AS n FROM pim_app.approvals")).rows[0].n).toBe(3);
	}, 240_000);

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
