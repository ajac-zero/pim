import { env, runInDurableObject } from "cloudflare:test";
import { beforeAll, describe, expect, it } from "vitest";
import { classOf, routeFor } from "../src/extensions/meta-ui";
import type { Pim } from "../src/pim";
import { api, OWNER, pendingApproval, post, ROOT, say, toolUse } from "./helpers";
import { faux } from "./worker";

type Result = { content: { text: string }[]; isError?: boolean };

let helperChat = "";

/** Runs one of the extension's tools in the admin's space, as the conversation `chat` (the majordomo's root unless given). */
async function run(tool: string, args: Record<string, unknown>, chat = ROOT) {
	return runInDurableObject(env.Pim.getByName(OWNER), async (pim: Pim) => {
		const session = pim.store.sessionOf(chat)!;
		const tools = pim.abilities.get("meta-ui")!.tools!;
		const result = (await tools.find((candidate) => candidate.name === tool)!.execute(args as never, { conversationId: session } as never, {} as never)) as Result;
		return { error: result.isError === true, body: JSON.parse(result.content[0]!.text) as any };
	});
}

/** The ids of the chats the app lists. */
async function chats() {
	return ((await api("/sessions")).body.sessions as { id: string }[]).map((chat) => chat.id);
}

beforeAll(async () => {
	helperChat = (await post("/sessions", { agent: (await post("/agents", { name: "UI helper", instructions: "Helps." })).body.id })).body.id;
});

describe("the app's routes for the majordomo", () => {
	it("classes every route, with the dispatcher's own matching", async () => {
		const { routes } = (await run("ui_routes", {})).body as { routes: { method: string; path: string; class: string }[] };
		const of = (method: string, path: string) => routes.find((route) => route.method === method && route.path === path)?.class;
		expect(of("GET", "/sessions")).toBe("read");
		expect(of("POST", "/agents")).toBe("write");
		expect(of("DELETE", "/sessions/:session")).toBe("destructive");
		expect(of("POST", "/sessions/:session/reset")).toBe("destructive");
		for (const [method, path] of [
			["POST", "/approvals/:id/approve"],
			["POST", "/approvals/:id/deny"],
			["GET", "/files/content"],
			["PUT", "/files/content"],
			["GET", "/export"],
			["GET", "/browser/screenshot"],
			["POST", "/mcp-server"],
			["GET", "/artifacts/:id/versions/:version/download"],
			["POST", "/chatgpt/callback"],
			["POST", "/mcp/events/:key"],
		]) {
			expect(of(method!, path!), `${method} ${path}`).toBe("blocked");
		}
		expect(routes.some((route) => route.path.endsWith("/bridge") && route.class !== "blocked")).toBe(false);
		expect(routes.some((route) => route.path.endsWith("/grants") && route.class !== "blocked")).toBe(false);
		// A concrete path is classed by the route the dispatcher would run, with extra slashes and encoded segments too.
		expect(classOf("GET", "/mcp/:id/events")).toBe("read");
		expect(classOf("POST", "/approvals/:id/approve")).toBe("blocked");
		expect(routeFor([["GET", "/sessions/:session", () => 1]], "GET", "//sessions/a%20b/")?.[1]).toBe("/sessions/:session");
	});

	it("refuses other agents of the admin, and every agent of someone who isn't the admin", async () => {
		for (const [tool, args] of [["ui_routes", {}], ["ui_read", { path: "/agents" }], ["ui_write", { method: "POST", path: "/agents", body: { name: "x" } }], ["ui_audit", {}]] as const) {
			expect(await run(tool, args, helperChat), tool).toMatchObject({ error: true, body: { status: 403 } });
		}
		const abilities = await runInDurableObject(env.Pim.getByName(OWNER), async (pim: Pim) => pim.abilities.get("meta-ui")!.offeredTo!({ id: "x", majordomo: false }));
		expect(abilities).toBe(false);
		// A member's space: not the admin's, so even its majordomo is refused.
		const { getAgentByName } = await import("agents");
		const directory = env.Directory.getByName("directory");
		const registered = await directory.register({ username: "plain", ip: "192.0.2.9", policy: { mode: "open", maxAccounts: null, perAddressPerDay: 100 } });
		if (!registered.ok) throw new Error(registered.error);
		await directory.activate(registered.account.ownerId);
		const plain = registered.account.ownerId;
		await (await getAgentByName(env.Pim, plain)).provision({ ownerId: plain, username: "plain" });
		const refused = await runInDurableObject(env.Pim.getByName(plain), async (pim: Pim) => {
			const root = pim.store.sessionOf(pim.store.publicId("root"))!;
			const tools = pim.abilities.get("meta-ui")!.tools!;
			const result = (await tools.find((tool) => tool.name === "ui_read")!.execute({ path: "/agents" } as never, { conversationId: root } as never, {} as never)) as Result;
			return { error: result.isError === true, offered: pim.abilities.get("meta-ui")!.offeredTo!({ id: "x", majordomo: true }), body: JSON.parse(result.content[0]!.text) };
		});
		expect(refused).toMatchObject({ error: true, offered: false, body: { status: 403 } });
	});

	it("reads what the route itself answers, and only describes what isn't JSON", async () => {
		const read = await run("ui_read", { path: "/agents" });
		expect(read.error).toBe(false);
		expect(read.body).toEqual({ status: 200, body: (await api("/agents")).body });
		expect((await run("ui_read", { path: "/sessions", query: { limit: "1" } })).error).toBe(false);
		expect((await run("ui_read", { path: "/files/content", query: { path: "x" } })).body.status).toBe(403);
		expect((await run("ui_read", { path: "/agents?x=1" })).body.status).toBe(400);
		expect((await run("ui_read", { path: "agents" })).body.status).toBe(400);
		expect((await run("ui_read", { path: "/sessions/../agents" })).body.status).toBe(400);
		expect((await run("ui_read", { path: "/nope" })).body.status).toBe(404);
		const sent = await run("ui_read", { path: "/export" });
		expect(sent).toMatchObject({ error: true, body: { status: 403 } });
	});

	it("writes at once, keeps only the keys of the body, and refuses blocked and destructive routes", async () => {
		const made = await run("ui_write", { method: "POST", path: "/agents", body: { name: "Made by majordomo", instructions: "secret instructions" } });
		expect(made.error).toBe(false);
		expect(made.body.status).toBeLessThan(300);
		const row = (await run("ui_audit", {})).body.writes[0];
		expect(row).toMatchObject({ method: "POST", path: "/agents", status: made.body.status });
		expect(row.keys).toEqual(expect.arrayContaining(["name", "instructions"]));
		expect(row.keys).toHaveLength(2);
		expect(JSON.stringify(row)).not.toContain("secret instructions");
		expect(typeof row.agent).toBe("string");

		for (const [method, path] of [["POST", "/approvals/x/approve"], ["POST", "/approvals/x/deny"], ["POST", "/mcp-server"], ["PUT", "/files/content"]]) {
			expect(await run("ui_write", { method, path, body: {} }), `${method} ${path}`).toMatchObject({ error: true, body: { status: 403 } });
		}
		for (const [method, path] of [["DELETE", `/sessions/${helperChat}`], ["POST", `/sessions/${helperChat}/reset`]]) {
			expect(await run("ui_write", { method, path }), `${method} ${path}`).toMatchObject({ error: true, body: { status: 403 } });
		}
		expect(await chats()).toContain(helperChat);
		expect((await run("ui_audit", {})).body.writes[0]).toEqual(row);
	});

	it("deletes only after the person approves, with the exact request", async () => {
		const target = (await post("/sessions", { agent: (await post("/agents", { name: "To delete", instructions: "x" })).body.id })).body.id as string;
		let told = "";
		const note = (context: { messages: { role: string }[] }) => {
			const result = context.messages.findLast((message) => message.role === "toolResult") as { content: { text: string }[] } | undefined;
			told = result?.content[0]?.text ?? "";
			return toolUse("send_to_user", { message: "ok" });
		};
		faux.setResponses([toolUse("ui_write_destructive", { method: "DELETE", path: `/sessions/${target}` }), note as never]);
		const turn = say("Delete that chat", ROOT);
		const approval = await pendingApproval();
		expect(approval).toMatchObject({ action: "ui_write_destructive", summary: `DELETE /sessions/${target}`, onTimeout: "deny" });
		expect(await chats()).toContain(target);
		expect((await post(`/approvals/${approval.id}/approve`)).status).toBe(200);
		await turn;
		expect(JSON.parse(told.slice(told.indexOf("Result:\n") + 8)).status).toBeLessThan(300);
		expect(await chats()).not.toContain(target);
		expect((await run("ui_audit", {})).body.writes[0]).toMatchObject({ method: "DELETE", path: `/sessions/${target}` });

		// Routes that need no approval or are blocked are refused before anything is asked.
		for (const args of [{ method: "POST", path: "/agents", body: {} }, { method: "POST", path: "/approvals/x/approve", body: {} }]) {
			faux.setResponses([toolUse("ui_write_destructive", args), note as never]);
			await say("Do it", ROOT);
			expect(JSON.parse(told), JSON.stringify(args)).toMatchObject({ status: expect.any(Number) });
		}
	});
});
