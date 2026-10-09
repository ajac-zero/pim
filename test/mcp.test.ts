import type { Message } from "@earendil-works/pi-ai";
import { fauxAssistantMessage } from "@earendil-works/pi-ai/providers/faux";
import { McpServer } from "@modelcontextprotocol/server";
import { createMcpHandler } from "agents/mcp/server";
import { createExecutionContext } from "cloudflare:test";
import { exports } from "cloudflare:workers";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import type { Approval } from "../src/store";
import { api, apiUrl, lastUserText, post, say, toolUse, url } from "./helpers";
import { faux } from "./worker";

/**
 * Real MCP servers, built with the official server SDK, answering the
 * agent's MCP client in-process: requests to their URLs are routed to them.
 * One agent for the file; the tests build on each other's connected apps.
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

beforeEach(() => {
	const realFetch = globalThis.fetch;
	vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
		const request = new Request(input, init);
		const target = `${new URL(request.url).origin}${new URL(request.url).pathname}`;
		if (target === "https://down.example.test/mcp") return new Response("unavailable", { status: 503 });
		const server = SERVERS[target];
		if (!server) return realFetch(input, init);
		return createMcpHandler(server)(request, {}, createExecutionContext());
	});
});

function toolResults(messages: readonly Message[]): string {
	return JSON.stringify(messages.filter((message) => message.role === "toolResult"));
}

describe("connected apps (MCP)", () => {
	it("connects an app and offers its tools, gating the ones that change things", async () => {
		const { status, body } = await post("/mcp", { name: "Calendar", url: "https://calendar.example.test/mcp" });
		expect(status).toBe(201);
		expect(body).toMatchObject({ id: "calendar", state: "ready" });

		const apps = (await api("/mcp")).body.servers;
		expect(apps).toEqual([
			expect.objectContaining({ id: "calendar", name: "Calendar", state: "ready", approval: "writes" }),
		]);
		expect(apps[0].tools).toEqual([
			{ name: "calendar_find_events", description: "Find events on a day.", requiresApproval: false },
			{ name: "calendar_create_event", description: "Create an event.", requiresApproval: true },
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
				return fauxAssistantMessage("You see the dentist at 9.");
			},
		]);
		await say("What's on Monday?");
		expect(results).toContain("Events on monday: dentist at 9.");
		expect(system).toContain("## Calendar\\nTimes are in Eastern time.");
	});

	it("files an approval for a tool that changes things, and calls the app once approved", async () => {
		faux.setResponses([
			toolUse("calendar_create_event", { title: "Lunch with Ana", day: "friday" }),
			fauxAssistantMessage("I've asked for your approval."),
		]);
		await say("Book lunch with Ana on Friday.");
		expect(created).toEqual([]);
		const [approval] = (await api<{ approvals: Approval[] }>("/approvals?status=pending")).body.approvals;
		expect(approval!.summary).toBe('Calendar: create_event {"title":"Lunch with Ana","day":"friday"}');

		let reported = "";
		faux.setResponses([
			(context) => {
				reported = lastUserText(context.messages);
				return fauxAssistantMessage("Booked.");
			},
		]);
		const decided = await post<Approval>(`/approvals/${approval!.id}/approve`);
		expect(decided.body).toMatchObject({ status: "approved", result: 'Created "Lunch with Ana" on friday.' });
		expect(created).toEqual([{ title: "Lunch with Ana", day: "friday" }]);
		await api(`/sessions/1/operations/approval:${approval!.id}`);
		expect(reported).toContain('Created "Lunch with Ana" on friday.');
	});

	it("follows each app's approval policy", async () => {
		expect((await api("/mcp/calendar", { method: "PUT", body: JSON.stringify({ approval: "sometimes" }) })).status).toBe(400);
		const updated = await api("/mcp/calendar", { method: "PUT", body: JSON.stringify({ approval: "none" }) });
		expect(updated.body.tools.map((tool: { requiresApproval: boolean }) => tool.requiresApproval)).toEqual([false, false]);

		faux.setResponses([toolUse("calendar_create_event", { title: "Gym", day: "saturday" }), fauxAssistantMessage("Done.")]);
		await say("Add gym on Saturday.");
		expect(created.at(-1)).toEqual({ title: "Gym", day: "saturday" });

		const strict = await api("/mcp/calendar", { method: "PUT", body: JSON.stringify({ approval: "all" }) });
		expect(strict.body.tools.map((tool: { requiresApproval: boolean }) => tool.requiresApproval)).toEqual([true, true]);
		await api("/mcp/calendar", { method: "PUT", body: JSON.stringify({ approval: "writes" }) });
	});

	it("adds a new app's tools without re-sending the prompt sent so far", async () => {
		const session = (await post("/sessions")).body.id;
		const prompts: Message[][] = [];
		const record = (context: { messages: Message[] }) => {
			prompts.push(context.messages);
			return fauxAssistantMessage("ok");
		};
		faux.setResponses([record]);
		await say("one", session);
		expect((await post("/mcp", { name: "Notes", url: "https://notes.example.test/mcp" })).status).toBe(201);
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

	it("lets the model connect an app once the user approves", async () => {
		faux.setResponses([
			toolUse("connect_app", { name: "Weather", url: "https://weather.example.test/mcp" }),
			fauxAssistantMessage("Waiting for your approval."),
		]);
		await say("Connect the weather app.");
		expect((await api("/mcp")).body.servers).toHaveLength(1);
		const [approval] = (await api<{ approvals: Approval[] }>("/approvals?status=pending")).body.approvals;
		expect(approval!.summary).toBe("Connect Weather (https://weather.example.test/mcp) and let me use its tools");

		let reported = "";
		faux.setResponses([
			(context) => {
				reported = lastUserText(context.messages);
				return fauxAssistantMessage("Connected.");
			},
		]);
		await post(`/approvals/${approval!.id}/approve`);
		await api(`/sessions/1/operations/approval:${approval!.id}`);
		expect(reported).toContain("Connected Weather. Its tools: weather_forecast.");
		expect((await api("/mcp")).body.servers.map((server: { id: string }) => server.id).sort()).toEqual(["calendar", "weather"]);
	});

	it("refuses bad or failing servers and leaves nothing behind", async () => {
		expect((await post("/mcp", { name: "X", url: "ftp://example.test" })).status).toBe(400);
		expect((await post("/mcp", { name: "X", url: "https://x.example.test/mcp", approval: "maybe" })).status).toBe(400);
		const down = await post("/mcp", { name: "Down", url: "https://down.example.test/mcp" });
		expect(down.status).toBe(502);
		expect(down.body.error).toMatch(/^Could not connect Down/);
		// The same name again: refused, and the connected app is untouched.
		const again = await post("/mcp", { name: "Calendar", url: "https://down.example.test/mcp" });
		expect(again.status).toBe(409);
		expect((await api("/mcp")).body.servers.map((server: { id: string; state: string }) => [server.id, server.state]).sort()).toEqual([
			["calendar", "ready"],
			["weather", "ready"],
		]);
	});

	it("lets the sign-in callback through without the API token, and nothing else", async () => {
		const callback = await exports.default.fetch(url("/mcp/callback?state=forged&code=x"));
		expect(callback.status).not.toBe(401);
		expect((await exports.default.fetch(url("/mcp/callback"), { method: "POST" })).status).toBe(405);
		expect((await exports.default.fetch(apiUrl("/mcp"))).status).toBe(401);
	});
});
