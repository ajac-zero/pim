import type { Message } from "@earendil-works/pi-ai";
import { McpServer } from "@modelcontextprotocol/server";
import { createMcpHandler } from "agents/mcp/server";
import { createExecutionContext, env, runInDurableObject } from "cloudflare:test";
import { exports } from "cloudflare:workers";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import type { Approval } from "../src/store";
import { MANAGE_APPS, UPDATE_AGENT } from "../src/extensions/agents";
import { api, apiUrl, decisionRun, lastUserText, OWNER, pendingApproval, post, say, systemPrompt, toolUse, url } from "./helpers";
import { faux, type Pim } from "./worker";

/**
 * Real MCP servers, built with the official server SDK, answering the
 * Pim's MCP client in-process: requests to their URLs are routed to them.
 * One Pim for the file; the tests build on each other's connected apps.
 */

const created: { title: string; day: string }[] = [];

function calendar() {
	const server = new McpServer(
		{ name: "calendar", version: "1.0.0" },
		{ instructions: "Times are in Eastern time." },
	);
	server.registerTool(
		"find_events",
		{ description: "Find events on a day.", inputSchema: { day: z.string() }, annotations: { readOnlyHint: true } },
		async ({ day }) => ({ content: [{ type: "text", text: `Events on ${day}: dentist at 9.` }] }),
	);
	server.registerTool(
		"create_event",
		{ description: "Create an event.", inputSchema: { title: z.string(), day: z.string() } },
		async ({ title, day }) => {
			created.push({ title, day });
			return { content: [{ type: "text", text: `Created "${title}" on ${day}.` }] };
		},
	);
	return server;
}

function notes() {
	const server = new McpServer({ name: "notes", version: "1.0.0" });
	server.registerTool(
		"search",
		{ description: "Search notes.", inputSchema: { query: z.string() }, annotations: { readOnlyHint: true } },
		async ({ query }) => ({ content: [{ type: "text", text: `No notes match ${query}.` }] }),
	);
	return server;
}

const SERVERS: Record<string, () => McpServer> = {
	"https://calendar.example.test/mcp": calendar,
	"https://notes.example.test/mcp": notes,
	"https://firecrawl.example.test/mcp": notes,
	"https://weather.example.test/mcp": () => {
		const server = new McpServer({ name: "weather", version: "1.0.0" });
		server.registerTool(
			"forecast",
			{ description: "Tomorrow's forecast.", annotations: { readOnlyHint: true } },
			async () => ({ content: [{ type: "text" as const, text: "Sunny." }] }),
		);
		return server;
	},
};

/**
 * Forge: an MCP server behind an OAuth server that, like GitHub's, has no
 * client registration, so only the client the deployment registered signs
 * in. It records the token requests it gets, and any registration attempt.
 */
const forgeGrants: Record<string, string>[] = [];
let forgeRegistrations = 0;

async function forge(request: Request): Promise<Response> {
	const { pathname } = new URL(request.url);
	if (pathname === "/mcp") {
		if (request.headers.get("authorization") !== "Bearer forge-token") {
			return new Response("Unauthorized", {
				status: 401,
				headers: { "www-authenticate": 'Bearer resource_metadata="https://forge.example.test/.well-known/oauth-protected-resource/mcp"' },
			});
		}
		return createMcpHandler(notes)(request, {}, createExecutionContext());
	}
	if (pathname === "/.well-known/oauth-protected-resource/mcp") {
		return Response.json({ resource: "https://forge.example.test/mcp", authorization_servers: ["https://forge.example.test/login"] });
	}
	if (pathname.startsWith("/.well-known/oauth-authorization-server")) {
		return Response.json({
			issuer: "https://forge.example.test/login",
			authorization_endpoint: "https://forge.example.test/login/authorize",
			token_endpoint: "https://forge.example.test/login/token",
			response_types_supported: ["code"],
			code_challenge_methods_supported: ["S256"],
		});
	}
	if (pathname === "/login/token") {
		const form = Object.fromEntries(new URLSearchParams(await request.text()));
		forgeGrants.push(form);
		if (form.client_id !== "forge-client" || form.client_secret !== "forge-secret") return Response.json({ error: "invalid_client" }, { status: 401 });
		if (form.code !== "good") return Response.json({ error: "invalid_grant" }, { status: 400 });
		return Response.json({ access_token: "forge-token", token_type: "bearer" });
	}
	if (pathname === "/register") forgeRegistrations++;
	return new Response("not found", { status: 404 });
}

beforeEach(() => {
	const realFetch = globalThis.fetch;
	vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
		const request = new Request(input, init);
		const target = `${new URL(request.url).origin}${new URL(request.url).pathname}`;
		if (new URL(request.url).origin === "https://forge.example.test") return forge(request);
		if (target === "https://down.example.test/mcp") return new Response("unavailable", { status: 503 });
		const server = SERVERS[target];
		if (!server) return realFetch(input, init);
		return createMcpHandler(server)(request, {}, createExecutionContext());
	});
});

function toolResults(messages: readonly Message[]): string {
	return JSON.stringify(messages.filter((message) => message.role === "toolResult"));
}

/** The tools a request offered the model: every tool its system messages added, less those they removed. */
function offered(messages: readonly Message[]): string[] {
	const tools = new Set<string>();
	for (const message of messages) {
		if (message.role !== "system") continue;
		for (const tool of message.toolsAdded ?? []) tools.add(tool.name);
		for (const tool of message.toolsRemoved ?? []) tools.delete(tool.name);
	}
	return [...tools];
}

/** Sets the apps the person's default agent works with. */
async function defaultAgentApps(apps: string[]) {
	const [agent] = (await api("/agents")).body.agents;
	expect((await api(`/agents/${agent.id}`, { method: "PUT", body: JSON.stringify({ apps }) })).status).toBe(200);
}

describe("connected apps (MCP)", () => {
	it("connects an app and offers its tools, gating the ones that change things", async () => {
		const { status, body } = await post("/mcp", { app: "test.ledger/calendar" });
		expect(status).toBe(201);
		expect(body).toMatchObject({ id: "calendar", state: "ready" });

		// Connected, but no Pim works with it yet.
		expect((await api("/mcp")).body.servers).toEqual([expect.objectContaining({ id: "calendar", agents: [] })]);
		await defaultAgentApps(["test.ledger/calendar"]);
		const apps = (await api("/mcp")).body.servers;
		expect(apps).toEqual([
			expect.objectContaining({ id: "calendar", name: "Calendar", state: "ready", approval: "writes", agents: ["Pim"] }),
		]);
		expect(apps[0].tools).toEqual([
			{ name: "calendar_find_events", description: "Find events on a day.", permission: "on", requiresApproval: false },
			{ name: "calendar_create_event", description: "Create an event.", permission: "ask", requiresApproval: true },
		]);
		const tools = new Map((await api("/")).body.tools.map((tool: { name: string }) => [tool.name, tool]));
		expect(tools.get("calendar_create_event")).toMatchObject({ requiresApproval: true });
		expect(tools.get("calendar_find_events")).toMatchObject({ requiresApproval: false });
	});

	it("calls a read-only tool directly, with the app's instructions in the prompt", async () => {
		let results = "";
		let system = "";
		faux.setResponses([
			(context) => {
				system = JSON.stringify(context.messages.filter((message) => message.role === "system"));
				return toolUse("calendar_find_events", { day: "monday" });
			},
			(context) => {
				results = toolResults(context.messages);
				return toolUse("send_to_user", { message: "You see the dentist at 9." });
			},
		]);
		await say("What's on Monday?");
		expect(results).toContain("Events on monday: dentist at 9.");
		expect(system).toContain("## Calendar [id: test.ledger/calendar]\\nTimes are in Eastern time.");
	});

	it("runs a tool that changes things once the user approves, and tells the conversation", async () => {
		let reported = "";
		faux.setResponses([toolUse("calendar_create_event", { title: "Lunch with Ana", day: "friday" }), toolUse("send_to_user", { message: "Asked." })]);
		await say("Book lunch with Ana on Friday.");
		const approval = await pendingApproval();
		expect(created).toEqual([]);
		expect(approval.summary).toBe('Calendar: create_event {"title":"Lunch with Ana","day":"friday"}');

		faux.setResponses([
			(context) => {
				reported = lastUserText(context.messages);
				return toolUse("send_to_user", { message: "Booked." });
			},
		]);
		const decided = await post<Approval>(`/approvals/${approval.id}/approve`);
		expect(decided.body).toMatchObject({ status: "approved", result: 'Created "Lunch with Ana" on friday.' });
		expect(created).toEqual([{ title: "Lunch with Ana", day: "friday" }]);
		expect(await decisionRun(approval)).toMatchObject({ status: "done", text: "Booked." });
		expect(reported).toContain('Created "Lunch with Ana" on friday.');
	});

	it("follows each app's approval policy", async () => {
		expect((await api("/mcp/calendar", { method: "PUT", body: JSON.stringify({ approval: "sometimes" }) })).status).toBe(400);
		const updated = await api("/mcp/calendar", { method: "PUT", body: JSON.stringify({ approval: "none" }) });
		expect(updated.body.tools.map((tool: { requiresApproval: boolean }) => tool.requiresApproval)).toEqual([false, false]);

		faux.setResponses([toolUse("calendar_create_event", { title: "Gym", day: "saturday" }), toolUse("send_to_user", { message: "Done." })]);
		await say("Add gym on Saturday.");
		expect(created.at(-1)).toEqual({ title: "Gym", day: "saturday" });

		const strict = await api("/mcp/calendar", { method: "PUT", body: JSON.stringify({ approval: "all" }) });
		expect(strict.body.tools.map((tool: { requiresApproval: boolean }) => tool.requiresApproval)).toEqual([true, true]);
		await api("/mcp/calendar", { method: "PUT", body: JSON.stringify({ approval: "writes" }) });
	});

	it("lets the user turn each tool off, on, or back to asking", async () => {
		const setPermission = (tool: string, permission: string | null) =>
			api("/permissions", { method: "PUT", body: JSON.stringify({ app: "calendar", tool, permission }) });
		const offered = async () => (await api("/")).body.tools.map((tool: { name: string }) => tool.name);
		expect((await setPermission("create_event", "sometimes")).status).toBe(400);
		expect((await setPermission("delete_event", "on")).status).toBe(404);

		// Off: the model is no longer offered the tool.
		expect((await setPermission("find_events", "off")).body).toMatchObject({ permission: "off", chosen: "off", default: "on" });
		expect(await offered()).not.toContain("calendar_find_events");

		// On: a tool that changes things runs without an approval.
		expect((await setPermission("create_event", "on")).body).toMatchObject({ permission: "on", changed: false });
		faux.setResponses([toolUse("calendar_create_event", { title: "Swim", day: "sunday" }), toolUse("send_to_user", { message: "Done." })]);
		const approvals = (await api("/approvals")).body.approvals.length;
		await say("Add swimming on Sunday.");
		expect(created.at(-1)).toEqual({ title: "Swim", day: "sunday" });
		expect((await api("/approvals")).body.approvals).toHaveLength(approvals);

		// The app changes the tool after the user let it run: Pim asks again, even with the tools already built.
		await runInDurableObject(env.Pim.getByName(OWNER), (instance: Pim) =>
			instance.store.setToolPermission("", "calendar", "create_event", "on", '{"description":"Create a draft."}'),
		);
		const permissions = (await api("/permissions")).body.tools;
		expect(permissions.find((info: { name: string }) => info.name === "calendar_create_event")).toMatchObject({
			permission: "ask",
			chosen: "on",
			changed: true,
		});
		faux.setResponses([toolUse("calendar_create_event", { title: "Run", day: "monday" }), toolUse("send_to_user", { message: "Asked." })]);
		const turn = say("Add a run on Monday.");
		const approval = await pendingApproval();
		expect(approval.summary).toBe('Calendar: create_event {"title":"Run","day":"monday"}');
		await post(`/approvals/${approval.id}/deny`);
		await turn;
		expect(created.at(-1)).toEqual({ title: "Swim", day: "sunday" });

		// Back to the defaults.
		expect((await setPermission("find_events", null)).body).toMatchObject({ permission: "on", chosen: null });
		expect((await setPermission("create_event", null)).body).toMatchObject({ permission: "ask", chosen: null, changed: false });
		expect(await offered()).toContain("calendar_find_events");
	});

	it("keeps an app tool the user always approved before tool permissions", async () => {
		await runInDurableObject(env.Pim.getByName(OWNER), (_instance: Pim, state) => {
			state.storage.sql.exec("INSERT INTO pim_always_approved (tool, created_at) VALUES ('calendar_create_event', 1)");
		});
		// Rebuilding the apps' tools moves it over.
		await api("/mcp/calendar", { method: "PUT", body: JSON.stringify({ approval: "writes" }) });
		const permissions = (await api("/permissions")).body.tools;
		expect(permissions.find((info: { name: string }) => info.name === "calendar_create_event")).toMatchObject({
			permission: "on",
			chosen: "on",
			changed: false,
		});
		await api("/permissions", { method: "PUT", body: JSON.stringify({ app: "calendar", tool: "create_event", permission: null }) });
	});

	it("adds a new app's tools without re-sending the prompt sent so far", async () => {
		await defaultAgentApps(["test.ledger/calendar", "test.ledger/notes"]);
		const session = (await post("/sessions")).body.id;
		const prompts: Message[][] = [];
		const record = (context: { messages: Message[] }) => {
			prompts.push(context.messages);
			return toolUse("send_to_user", { message: "ok" });
		};
		faux.setResponses([record]);
		await say("one", session);
		expect((await post("/mcp", { app: "test.ledger/notes" })).status).toBe(201);
		faux.setResponses([record]);
		await say("two", session);

		const [first, second] = prompts as [Message[], Message[]];
		expect(second.slice(0, first.length)).toEqual(first);
		const added = second.slice(first.length).filter((message) => message.role === "system");
		expect(added).toHaveLength(1);
		const entry = added[0]! as Extract<Message, { role: "system" }>;
		expect(Object.keys(entry.sections ?? {})).toEqual(["connected_apps"]);
		expect(entry.toolsAdded?.map((tool) => tool.name)).toEqual(["notes_search"]);
	});

	it("removes an app and its tools", async () => {
		expect((await api("/mcp/notes", { method: "DELETE" })).status).toBe(200);
		expect((await api("/mcp")).body.servers.map((server: { id: string }) => server.id)).toEqual(["calendar"]);
		const tools = (await api("/")).body.tools.map((tool: { name: string }) => tool.name);
		expect(tools).not.toContain("notes_search");
		expect((await api("/mcp/notes", { method: "DELETE" })).status).toBe(404);
	});

	it("gives a chat only the apps its Pim lists, and lets the model connect only those", async () => {
		const weather = "https://weather.example.test/mcp";
		const books = (await post("/agents", { name: "Books", blueprint: "test.ledger/budget" })).body;
		const budget = (await post("/sessions", { agent: books.id })).body.id;

		// The default Pim doesn't list Weather: the model can't connect it from there.
		let refused = "";
		faux.setResponses([
			toolUse("connect_app", { app: "Weather" }),
			(context) => {
				refused = toolResults(context.messages);
				return toolUse("send_to_user", { message: "I can't." });
			},
		]);
		await say("Connect the weather app.");
		expect(refused).toContain("This agent doesn't work with Weather; its apps are Calendar, Notes.");
		expect((await api("/mcp")).body.servers.map((server: { id: string }) => server.id)).toEqual(["calendar"]);

		// The Budget Pim's definition lists it: connecting it needs no approval, as its Pim already chose it.
		let connected = "";
		let system = "";
		faux.setResponses([
			(context) => {
				system = systemPrompt(context.messages);
				return toolUse("connect_app", { app: "weather" });
			},
			(context) => {
				connected = toolResults(context.messages);
				return toolUse("send_to_user", { message: "Connected." });
			},
		]);
		await say("Connect the weather app.", budget);
		expect(system).toContain("## Weather [id: test.ledger/weather]\\n(not connected: connect_app connects it)");
		expect(connected).toContain("Connected Weather. Its tools: weather_forecast.");
		const servers = (await api("/mcp")).body.servers;
		expect(servers.find((server: { id: string }) => server.id === "weather")).toMatchObject({ url: weather, agents: ["Books"] });

		// Its tools reach the Budget chat, and no other.
		const tools: Record<string, string[]> = {};
		const record = (key: string) => (context: { messages: Message[] }) => {
			tools[key] = offered(context.messages);
			return toolUse("send_to_user", { message: "ok" });
		};
		faux.setResponses([record("budget"), record("default")]);
		await say("Forecast?", budget);
		await say("Forecast?");
		expect(tools.budget).toContain("weather_forecast");
		expect(tools.budget).not.toContain("calendar_find_events");
		expect(tools.default).toContain("calendar_find_events");
		expect(tools.default).not.toContain("weather_forecast");
	});

	it("connects only the directory's apps, refuses failing servers and leaves nothing behind", async () => {
		expect((await post("/mcp", { name: "X", url: "https://x.example.test/mcp" })).status).toBe(400);
		expect((await post("/mcp", { app: "test.ledger/nope" })).status).toBe(400);
		expect((await post("/mcp", { app: "test.ledger/notes", approval: "maybe" })).status).toBe(400);
		const down = await post("/mcp", { app: "test.ledger/down" });
		expect(down.status).toBe(502);
		expect(down.body.error).toMatch(/^Could not connect Down/);
		// Connected already: refused, and the connected app is untouched.
		const again = await post("/mcp", { app: "test.ledger/calendar" });
		expect(again.status).toBe(409);
		expect((await api("/mcp")).body.servers.map((server: { id: string; state: string }) => [server.id, server.state]).sort()).toEqual([
			["calendar", "ready"],
			["weather", "ready"],
		]);
	});

	it("gives apps a sign-in callback that names this Pim's owner, so it comes back to this Pim", async () => {
		const callbacks = await runInDurableObject(env.Pim.getByName(OWNER), (_instance: Pim, state) =>
			state.storage.sql.exec("SELECT callback_url FROM cf_agents_mcp_servers").toArray().map((row) => row.callback_url),
		);
		expect(callbacks.length).toBeGreaterThan(0);
		for (const callback of callbacks) expect(callback).toBe(`https://pim.test/mcp/callback/${OWNER}`);
	});

	it("lets the sign-in callback through without the API token, and nothing else", async () => {
		const callback = await exports.default.fetch(url(`/mcp/callback/${OWNER}?state=forged&code=x`));
		expect(callback.status).not.toBe(401);
		expect((await exports.default.fetch(url(`/mcp/callback/${OWNER}`), { method: "POST" })).status).toBe(405);
		// Nobody's callback: there's no agent to hand it to.
		expect((await exports.default.fetch(url("/mcp/callback/o_nobody?state=forged&code=x"))).status).toBe(404);
		expect((await exports.default.fetch(apiUrl("/mcp"))).status).toBe(401);
	});

	it("signs in to a server that can't register clients with the client the deployment registered, and offers none it didn't", async () => {
		const directory = (await api("/app-directory")).body.apps as { ref: string }[];
		expect(directory.some((app) => app.ref === "test.ledger/forge")).toBe(true);
		// Hub's client isn't set: nobody is offered it, or can connect it.
		expect(directory.some((app) => app.ref === "test.ledger/hub")).toBe(false);
		expect((await post("/mcp", { app: "test.ledger/hub" })).status).toBe(400);

		const started = await post("/mcp", { app: "test.ledger/forge" });
		expect(started).toMatchObject({ status: 201, body: { id: "forge", state: "authenticating" } });
		const authUrl = new URL(started.body.authUrl);
		expect(`${authUrl.origin}${authUrl.pathname}`).toBe("https://forge.example.test/login/authorize");
		expect(Object.fromEntries(authUrl.searchParams)).toMatchObject({ client_id: "forge-client", redirect_uri: `https://pim.test/mcp/callback/${OWNER}` });

		await exports.default.fetch(url(`/mcp/callback/${OWNER}?state=${authUrl.searchParams.get("state")}&code=good`));
		expect(forgeGrants.at(-1)).toMatchObject({ grant_type: "authorization_code", code: "good", client_id: "forge-client", client_secret: "forge-secret" });
		expect(forgeRegistrations).toBe(0);
		const server = (await api("/mcp")).body.servers.find((candidate: { id: string }) => candidate.id === "forge");
		expect(server).toMatchObject({ state: "ready" });
		expect(server.tools.map((tool: { name: string }) => tool.name)).toEqual(["forge_search"]);
		expect((await api("/mcp/forge", { method: "DELETE" })).status).toBe(200);
	});

	it("finds an app, adds and connects it after explicit chat approval, then continues the original task", async () => {
		await api("/settings", { method: "PUT", body: JSON.stringify({ approvalPolicy: "auto" }) });
		const app = "test.ledger/firecrawl";
		const agent = (await post("/agents", { name: "Researcher", instructions: "Research carefully." })).body;
		const session = (await post("/sessions", { agent: agent.id })).body.id;
		let found = "";
		faux.setResponses([
			toolUse("find_app", { app: "firecrawl" }),
			(context) => {
				found = toolResults(context.messages);
				return toolUse(MANAGE_APPS, { add: ["test.ledger/nope"] });
			},
			(context) => {
				found += toolResults(context.messages);
				return toolUse(MANAGE_APPS, { add: [app] });
			},
			toolUse("send_to_user", { message: "Please approve the connection." }),
		]);
		await say("Connect Firecrawl and search for turbines", session);
		// The directory's apps only: one this Pim doesn't offer is refused before anyone is asked.
		expect(found).toContain("- Firecrawl [id: test.ledger/firecrawl]: Crawls web pages.");
		expect(found).toContain("This Pim offers no app test.ledger/nope");
		const approval = await pendingApproval();
		expect(approval).toMatchObject({ action: MANAGE_APPS, tool: null, expiresAt: null, onTimeout: "deny", summary: "Researcher: add and connect Firecrawl" });
		await new Promise((resolve) => setTimeout(resolve, 1_600));
		expect((await api(`/approvals/${approval.id}`)).body.status).toBe("pending");
		expect((await api(`/agents/${agent.id}`)).body.apps).toEqual([]);
		expect((await api("/mcp")).body.servers.some((server: { id: string }) => server.id === "firecrawl")).toBe(false);
		// Neither "always approve" nor a tool permission can bypass per-change consent.
		expect((await post(`/approvals/${approval.id}/approve`, { always: true })).status).toBe(400);
		expect((await api("/permissions", { method: "PUT", body: JSON.stringify({ tool: MANAGE_APPS, permission: "on" }) })).status).toBe(400);
		const permission = (await api("/permissions")).body.tools.find((info: { tool: string }) => info.tool === MANAGE_APPS);
		expect(permission).toMatchObject({ permission: "ask", choices: ["off", "ask"] });
		// A pending edit applies only its app delta, not a stale snapshot of the agent.
		await api(`/agents/${agent.id}`, { method: "PUT", body: JSON.stringify({ instructions: "Cite sources." }) });
		let tools: string[] = [];
		let outcome = "";
		let result = "";
		faux.setResponses([
			(context) => {
				tools = offered(context.messages);
				outcome = lastUserText(context.messages);
				return toolUse("firecrawl_search", { query: "turbines" });
			},
			(context) => { result = toolResults(context.messages); return toolUse("send_to_user", { message: "Searched." }); },
		]);
		expect((await post(`/approvals/${approval.id}/approve`)).body.result).toContain("Connected Firecrawl.");
		expect(await decisionRun(approval)).toMatchObject({ status: "done" });
		expect(tools).toContain("firecrawl_search");
		expect(outcome).toContain("Connected Firecrawl.");
		expect(result).toContain("No notes match turbines.");
		expect((await api(`/agents/${agent.id}`)).body).toMatchObject({ apps: [app], instructions: "Cite sources." });

		// Another agent that lists it works with the same connection: no second sign-in.
		const other = (await post("/agents", { name: "Other researcher", apps: [app] })).body;
		const servers = (await api("/mcp")).body.servers.filter((server: { url: string }) => server.url === "https://firecrawl.example.test/mcp");
		expect(servers).toEqual([expect.objectContaining({ id: "firecrawl", state: "ready", agents: ["Researcher", "Other researcher"] })]);

		// Removing it from this agent does not disconnect it or remove it from another agent.
		faux.setResponses([toolUse(MANAGE_APPS, { remove: [app] }), toolUse("send_to_user", { message: "Waiting." })]);
		await say("Stop working with Firecrawl", session);
		const removal = await pendingApproval();
		expect(removal.summary).toBe("Researcher: remove Firecrawl");
		faux.setResponses([toolUse("send_to_user", { message: "Removed." })]);
		await post(`/approvals/${removal.id}/approve`);
		expect(await decisionRun(removal)).toMatchObject({ status: "done" });
		expect((await api(`/agents/${agent.id}`)).body.apps).toEqual([]);
		expect((await api(`/agents/${other.id}`)).body.apps).toEqual([app]);
		expect((await api("/mcp")).body.servers.find((server: { id: string }) => server.id === "firecrawl")).toMatchObject({ state: "ready", approval: "writes" });
		const after: Record<string, string[]> = {};
		const record = (key: string) => (context: { messages: Message[] }) => { after[key] = offered(context.messages); return toolUse("send_to_user", { message: "ok" }); };
		faux.setResponses([record("removed"), record("other")]);
		await say("Which tools now?", session);
		const otherSession = (await post("/sessions", { agent: other.id })).body.id;
		await say("Which tools now?", otherSession);
		expect(after.removed).not.toContain("firecrawl_search");
		expect(after.other).toContain("firecrawl_search");
		await api("/settings", { method: "PUT", body: JSON.stringify({ approvalPolicy: null }) });
	});

	it("can disable app management without disabling self-edits, and reports connection failures honestly", async () => {
		const app = "test.ledger/down";
		const agent = (await post("/agents", { name: "App manager" })).body;
		const session = (await post("/sessions", { agent: agent.id })).body.id;
		faux.setResponses([toolUse(MANAGE_APPS, { add: [app] }), toolUse("send_to_user", { message: "Waiting." })]);
		await say("Add this server", session);
		const approval = await pendingApproval();
		await api("/permissions", { method: "PUT", body: JSON.stringify({ tool: MANAGE_APPS, permission: "off" }) });
		expect((await post(`/approvals/${approval.id}/approve`)).status).toBe(403);
		faux.setResponses([toolUse("send_to_user", { message: "Understood." })]);
		await post(`/approvals/${approval.id}/deny`);
		expect(await decisionRun(approval)).toMatchObject({ status: "done" });
		expect((await api(`/agents/${agent.id}`)).body.apps).toEqual([]);
		let tools: string[] = [];
		let result = "";
		faux.setResponses([
			(context) => {
				tools = offered(context.messages);
				return toolUse(UPDATE_AGENT, { add_apps: [app], instructions: "Keep it short." });
			},
			toolUse("send_to_user", { message: "Waiting." }),
		]);
		await say("Try the old edit tool", session);
		expect(tools).not.toContain(MANAGE_APPS);
		expect(tools).toContain(UPDATE_AGENT);
		const edit = await pendingApproval();
		faux.setResponses([toolUse("send_to_user", { message: "Edited." })]);
		await post(`/approvals/${edit.id}/approve`);
		expect(await decisionRun(edit)).toMatchObject({ status: "done" });
		expect((await api(`/agents/${agent.id}`)).body).toMatchObject({ apps: [], instructions: "Keep it short." });
		await api("/permissions", { method: "PUT", body: JSON.stringify({ tool: MANAGE_APPS, permission: null }) });
		faux.setResponses([toolUse(MANAGE_APPS, { add: [app] }), toolUse("send_to_user", { message: "Waiting." })]);
		await say("Try the unavailable server again", session);
		const retry = await pendingApproval();
		faux.setResponses([(context) => { result = lastUserText(context.messages); return toolUse("send_to_user", { message: "Connection failed." }); }]);
		await post(`/approvals/${retry.id}/approve`);
		expect(await decisionRun(retry)).toMatchObject({ status: "done" });
		expect(result).toContain("was added, but connecting failed");
		expect(result).toContain("Use connect_app to retry");
		expect((await api(`/agents/${agent.id}`)).body.apps).toEqual([app]);
		expect((await api("/mcp")).body.servers.some((server: { url: string }) => server.url === "https://down.example.test/mcp")).toBe(false);
	});
});
