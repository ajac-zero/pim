// The web app's apps, gallery and admin routes over a real PostgreSQL with every migration applied: shapes the web app reads, who may see what
// (a circle's members, the admin), and that the last admin cannot be suspended through the admin screens.
import type { Server } from "node:http";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { App } from "@pim/v2-app/app";
import { connect as connectApp } from "@pim/v2-app/db";
import { createGate } from "@pim/v2-app/gate";
import { MemoryObjectStore } from "@pim/v2-app/objects";
import { adminCompatRoutes } from "../src/compat/admin.ts";
import { createStack, type Stack } from "./support/stack.ts";

describe("the web app's apps, gallery and admin routes", () => {
	let stack: Stack;
	let app: App;
	let server: Server;
	let base: string;
	const people: Record<string, { token: string; ownerId: string }> = {};
	const call = async (who: string, method: string, path: string, body?: unknown) => {
		const res = await fetch(base + path, { method, headers: { authorization: `Bearer ${people[who]!.token}`, ...(body === undefined ? {} : { "content-type": "application/json" }) }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
		const text = await res.text();
		return { status: res.status, json: res.headers.get("content-type")?.includes("json") ? JSON.parse(text) : text };
	};

	beforeAll(async () => {
		stack = await createStack();
		app = new App(connectApp(stack.url("gate"), 6), new MemoryObjectStore());
		const ada = await app.identity.register({ username: "ada", bootstrap: await app.identity.issueClaim("bootstrap", null, 3_600_000) });
		await app.identity.setRegistrationOpen({ kind: "user", ownerId: ada.ownerId, role: "admin", sessionId: "s" }, true);
		const bob = await app.identity.register({ username: "bob" });
		for (const [name, a] of [["ada", ada], ["bob", bob]] as const) people[name] = { ownerId: a.ownerId, token: await app.identity.createSession(a.ownerId) };
		server = createGate(app, { first: adminCompatRoutes });
		await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
		base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
	}, 120_000);
	afterAll(async () => {
		await new Promise<void>((r) => server?.close(() => r()));
		await app?.db.end();
		await stack?.drop();
	});

	it("keeps an app's versions, restores one, shares the latest with a circle's members only, and publishes a copy others can make their own", async () => {
		const made = await call("ada", "POST", "/api/apps", { title: "Tips", kind: "html", files: { "index.html": "<!doctype html><p>hi</p><script src=a.js></script>", "a.js": "1" } });
		const id = made.json.id;
		expect((await call("ada", "POST", `/api/artifacts/${id}/versions`, { baseVersion: 1, content: "2", path: "a.js" })).json).toMatchObject({ version: 2, saved: 2, changed: true });
		// A stale base is refused, not merged.
		expect((await call("ada", "POST", `/api/artifacts/${id}/versions`, { baseVersion: 1, content: "3", path: "a.js" })).status).toBe(409);
		expect((await call("ada", "POST", `/api/artifacts/${id}/restore`, { version: 1, baseVersion: 2 })).json).toMatchObject({ version: 3, restored: 1 });
		const detail = (await call("ada", "GET", `/api/artifacts/${id}`)).json;
		expect(detail.history.map((h: any) => [h.version, h.source, h.restoredFrom])).toEqual([[3, "restore", 1], [2, "person", null], [1, "agent", null]]);
		expect((await call("ada", "GET", `/api/artifacts/${id}/versions/2?path=a.js`)).json).toMatchObject({ content: "2", latest: 3, kind: "html" });
		const frame = await fetch(`${base}/api/artifacts/${id}/versions/1/frame`, { headers: { authorization: `Bearer ${people.ada!.token}` } });
		expect(await frame.text()).toContain("<script >1</script>");
		expect(frame.headers.get("content-security-policy")).toContain("sandbox allow-scripts");

		expect((await call("bob", "GET", `/api/artifacts/${id}`)).status).toBe(404);
		expect((await call("bob", "GET", "/api/shared-artifacts")).json.artifacts).toEqual([]);
		const circle = (await call("ada", "POST", "/api/circles", { name: "Friends" })).json;
		await call("ada", "POST", `/api/circles/${circle.id}/members`, { username: "bob" });
		await call("ada", "PUT", `/api/artifacts/${id}/circles`, { circles: [circle.id] });
		const shared = (await call("bob", "GET", "/api/shared-artifacts")).json.artifacts;
		expect(shared).toMatchObject([{ id, host: "ada", title: "Tips", version: 3 }]);
		expect((await call("bob", "GET", `/api/shared-artifacts/ada/${id}/versions/3`)).json.content).toContain("<p>hi</p>");
		expect((await call("bob", "PUT", `/api/artifacts/${id}`, { title: "mine" })).status).toBe(404);

		const published = (await call("ada", "POST", `/api/artifacts/${id}/publish`, {})).json;
		expect(published).toMatchObject({ author: "ada", version: 3, public: true, linkable: true });
		expect((await call("bob", "GET", "/api/published-artifacts?q=tips")).json.artifacts).toMatchObject([{ id: published.id, uses: 0 }]);
		const copy = (await call("bob", "POST", `/api/published-artifacts/${published.id}/use`)).json;
		expect(copy).toMatchObject({ title: "Tips", version: 1 });
		expect((await call("bob", "GET", `/api/published-artifacts/${published.id}`)).json.uses).toBe(1);
		// Only an admin takes a published app down.
		expect((await call("bob", "DELETE", `/api/admin/published-artifacts/${published.id}`)).status).toBe(403);
		expect((await call("ada", "DELETE", `/api/admin/published-artifacts/${published.id}`)).json).toEqual({ deleted: true });
		expect((await call("bob", "GET", "/api/published-artifacts")).json.artifacts).toEqual([]);
	});

	it("publishes an agent as a template with its uploaded icon, counts who made it their own, and shares it as a bot with limits", async () => {
		const agent = await app.agents.create({ kind: "user", ownerId: people.ada!.ownerId as never, role: "admin", sessionId: "s" }, { name: "Scout", instructions: "look", emoji: "🔭" });
		const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGP4z8DwHwAFAAH/q842iQAAAABJRU5ErkJggg==", "base64");
		const put = await fetch(`${base}/api/agents/${agent.id}/icon`, { method: "PUT", headers: { authorization: `Bearer ${people.ada!.token}`, "content-type": "image/png" }, body: png });
		expect(put.status).toBe(200);
		const template = (await call("ada", "POST", `/api/agents/${agent.id}/publish`, {})).json;
		expect(template).toMatchObject({ name: "Scout", author: "ada", symbol: "🔭", uses: 0 });
		expect(template.icon).toEqual(expect.any(Number));
		const icon = await fetch(`${base}/api/templates/${template.id}/icon`, { headers: { authorization: `Bearer ${people.bob!.token}` } });
		expect(icon.headers.get("content-type")).toBe("image/png");
		expect(Buffer.from(await icon.arrayBuffer()).equals(png)).toBe(true);
		expect((await call("bob", "GET", "/api/templates?q=scout")).json.templates).toMatchObject([{ id: template.id }]);
		expect((await call("bob", "GET", "/api/templates?q=nothing")).json.templates).toEqual([]);
		await call("bob", "POST", `/api/templates/${template.id}/use`);
		expect((await call("bob", "GET", `/api/templates/${template.id}`)).json).toMatchObject({ uses: 1, instructions: "look" });

		expect((await call("ada", "GET", `/api/agents/${agent.id}/bot`)).status).toBe(404);
		const bot = (await call("ada", "PUT", `/api/agents/${agent.id}/bot`, { dailyMessages: 20, dailyToolCalls: null, model: null, tools: [], ask: [] })).json;
		expect(bot).toMatchObject({ dailyMessages: 20, guests: 0, url: expect.stringContaining("/b/") });
		expect((await call("ada", "PUT", `/api/agents/${agent.id}/bot`, { dailyMessages: -1 })).status).toBe(400);
		const card = await fetch(`${base}/api/bots/${bot.id}`);
		expect(await card.json()).toMatchObject({ author: "ada", name: "Scout", symbol: "🔭", icon: expect.any(Number) });
		expect((await call("ada", "DELETE", `/api/agents/${agent.id}/bot`)).json).toEqual({ deleted: true });
	});

	it("lists, suspends and links accounts for an admin alone, and never the last admin", async () => {
		expect((await call("bob", "GET", "/api/admin/accounts")).status).toBe(403);
		expect((await call("bob", "GET", "/api/admin/deployment")).status).toBe(403);
		expect((await call("ada", "GET", "/api/admin/accounts?limit=500")).json.accounts.map((a: any) => [a.username, a.role, a.status])).toEqual([["ada", "admin", "active"], ["bob", "member", "active"]]);
		await call("ada", "POST", "/api/admin/accounts/bob/suspend", {});
		expect((await call("ada", "GET", "/api/admin/accounts")).json.accounts[1].status).toBe("suspended");
		await call("ada", "POST", "/api/admin/accounts/bob/unsuspend", {});
		expect((await call("ada", "POST", "/api/admin/accounts/bob/setup-link", {})).json.setupUrl).toMatch(/#setup=/);
		expect((await call("ada", "POST", "/api/admin/accounts/ada/suspend", {})).json).toMatchObject({ error: "last_admin" });
		const invite = (await call("ada", "POST", "/api/admin/invites", { count: 2 })).json;
		expect(invite.links).toHaveLength(2);
	});

	it("keeps the connector directory in the instance's settings, and answers compute and the computer host as not set up", async () => {
		const added = (await call("ada", "POST", "/api/admin/apps", { name: "Docs", description: "d", url: "https://example.com/mcp", icon: "", category: "productivity" })).json.app.id;
		expect((await call("bob", "GET", "/api/app-directory")).json.apps).toMatchObject([{ ref: added, name: "Docs", custom: true, category: "productivity" }]);
		expect((await call("bob", "POST", "/api/admin/apps", { name: "x", url: "https://x.example" })).status).toBe(403);
		expect((await call("ada", "DELETE", `/api/admin/apps/${encodeURIComponent(added)}`, {})).json).toEqual({ deleted: true });
		expect((await call("bob", "GET", "/api/app-directory")).json.apps).toEqual([]);
		expect((await call("ada", "GET", "/api/admin/compute")).json).toMatchObject({ providers: [], quota: { maxConcurrentWorkspaces: null } });
		expect((await call("ada", "GET", "/api/admin/computer-host")).json).toMatchObject({ paired: false, connected: false });
		expect((await call("ada", "POST", "/api/admin/computer-host")).status).toBe(501);
		const sign = (await call("ada", "GET", "/api/admin/sign-in")).json.providers;
		expect(sign.map((p: any) => p.id)).toEqual(["google", "github", "oidc"]);
		const provider = (await call("ada", "POST", "/api/admin/providers", { name: "Local", url: "http://x/v1", key: "sk-secret" })).json.provider;
		expect(JSON.stringify(provider)).not.toContain("sk-secret");
		expect(provider.hasKey).toBe(true);
	});
});
