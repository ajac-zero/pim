// The web app's apps, gallery and admin routes over a real PostgreSQL with every migration applied: shapes the web app reads, who may see what
// (a circle's members, the admin), and that the last admin cannot be suspended through the admin screens.
import type { Server } from "node:http";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { App } from "@pim/v2-app/app";
import { connect as connectApp } from "@pim/v2-app/db";
import { createGate } from "@pim/v2-app/gate";
import { MemoryObjectStore } from "@pim/v2-app/objects";
import { adminCompatRoutes } from "../src/compat/admin.ts";
import { hostRoutes } from "../src/hostops/routes.ts";
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
		server = createGate(app, { first: [...hostRoutes(), ...adminCompatRoutes] });
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

		const published = (await call("ada", "POST", `/api/artifacts/${id}/publish`, { public: true })).json;
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

	it("opens a note as the markdown app the web app's card names, and renames it", async () => {
		const ownerId = people.ada!.ownerId as never;
		const principal = { kind: "user", ownerId, role: "admin", sessionId: "s" } as never;
		const id = await app.canvas.create(principal, "Plan", "Week one");
		expect((await call("ada", "GET", `/api/artifacts/${id}`)).json).toMatchObject({ id, title: "Plan", kind: "markdown", version: 1, history: [{ version: 1 }] });
		expect((await call("ada", "GET", `/api/artifacts/${id}/versions/1`)).json).toMatchObject({ kind: "markdown", content: "Week one", version: 1, latest: 1 });
		expect((await call("ada", "GET", `/api/artifacts/${id}/versions/2`)).status).toBe(404);
		// An agent's edit keeps versions, so an older one still reads back its text, is listed in the history, and can be restored.
		await app.canvas.edit(principal, id, "one", "two");
		expect((await call("ada", "GET", `/api/artifacts/${id}`)).json).toMatchObject({ version: 2, versions: 2, history: [{ version: 2, source: "agent" }, { version: 1, source: "person" }] });
		expect((await call("ada", "GET", `/api/artifacts/${id}/versions/1`)).json).toMatchObject({ content: "Week one", version: 1, latest: 2 });
		expect((await call("ada", "POST", `/api/artifacts/${id}/restore`, { version: 1, baseVersion: 2 })).json).toMatchObject({ version: 3, restored: 1 });
		expect((await call("ada", "GET", `/api/artifacts/${id}/versions/3`)).json).toMatchObject({ content: "Week one", source: "restore", restoredFrom: 1 });
		expect((await call("ada", "PUT", `/api/artifacts/${id}`, { title: "Plan B" })).json).toMatchObject({ title: "Plan B", kind: "markdown" });
		expect((await call("bob", "GET", `/api/artifacts/${id}`)).status).toBe(404);
		// The list the Notes section reads holds it, and a note started from "New note" is one with a version to open.
		expect((await call("ada", "GET", "/api/artifacts")).json.artifacts.filter((a: { kind: string }) => a.kind === "markdown")).toMatchObject([{ id, title: "Plan B", version: 3, size: 8 }]);
		expect((await call("bob", "GET", "/api/artifacts")).json.artifacts.filter((a: { kind: string }) => a.kind === "markdown")).toEqual([]);
		const started = (await call("ada", "POST", "/api/notes", { title: "Untitled" })).json;
		expect(started).toMatchObject({ title: "Untitled", kind: "markdown", version: 1 });
		expect((await call("ada", "GET", `/api/artifacts/${started.id}`)).json).toMatchObject({ id: started.id, kind: "markdown" });
		expect((await call("ada", "DELETE", `/api/artifacts/${started.id}`)).json).toEqual({ deleted: true });
		expect((await call("ada", "GET", `/api/artifacts/${started.id}`)).status).toBe(404);
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
		// The administration is for the admin signed in to the app: not an API token, whatever it may otherwise do.
		const session = (await app.identity.authenticate(people.ada!.token))!;
		const apiToken = (await app.identity.createToken(session, { name: "ci", scopes: ["*"] })).token;
		const viaToken = await fetch(`${base}/api/admin/accounts`, { headers: { authorization: `Bearer ${apiToken}` } });
		expect(viaToken.status).toBe(403);
		expect(await viaToken.json()).toMatchObject({ error: "session-only" });
		expect((await fetch(`${base}/api/account`, { headers: { authorization: `Bearer ${apiToken}` } })).status).toBe(200);
	});

	it("lets the admin take a published agent down, for everyone", async () => {
		const agent = (await call("bob", "POST", "/api/agents", { name: "Pitch", instructions: "sell" })).json;
		const published = (await call("bob", "POST", `/api/agents/${agent.id}/publish`, {})).json;
		expect((await call("bob", "DELETE", `/api/admin/templates/${published.id}`)).status).toBe(403);
		expect((await call("ada", "DELETE", `/api/admin/templates/${published.id}`)).json).toEqual({ deleted: true });
		expect((await call("ada", "GET", "/api/templates")).json.templates.some((t: { id: string }) => t.id === published.id)).toBe(false);
		expect((await call("ada", "DELETE", `/api/admin/templates/${published.id}`)).status).toBe(404);
	});

	it("adds a custom connector with its site's icon, a known category and a name and address of its own, and takes only an https icon", async () => {
		const real = globalThis.fetch;
		const sites: Record<string, () => Response> = {
			"https://crm.example.test/": () => Object.defineProperty(new Response(`<head><link rel="icon" href="/favicon.png" sizes="32x32"><link href="static/logo.svg?v=2&amp;x=1" rel="icon" type="image/svg+xml"></head>`, { headers: { "content-type": "text/html; charset=utf-8" } }), "url", { value: "https://www.acme.example.test/crm/" }),
			"https://www.acme.example.test/crm/static/logo.svg?v=2&x=1": () => new Response("<svg/>", { headers: { "content-type": "image/svg+xml" } }),
		};
		const spy = vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
			const url = new Request(input, init).url;
			if (url.startsWith(base)) return real(input, init);
			return sites[url]?.() ?? new Response("Not found", { status: 404 });
		});
		try {
			const crm = { name: "Acme CRM", description: "Customers and deals.", url: "https://crm.example.test/mcp" };
			expect((await call("bob", "POST", "/api/admin/apps", crm)).status).toBe(403);
			expect((await call("ada", "POST", "/api/admin/apps", { ...crm, category: "crm" })).status).toBe(400);
			const made = await call("ada", "POST", "/api/admin/apps", { ...crm, category: "customers" });
			expect(made).toMatchObject({ status: 201, json: { app: { id: "custom/acme-crm", icon: "https://www.acme.example.test/crm/static/logo.svg?v=2&x=1", category: "customers" } } });
			// The same address or the same name is refused, not added twice.
			expect((await call("ada", "POST", "/api/admin/apps", { ...crm, name: "Other" })).status).toBe(400);
			expect((await call("ada", "POST", "/api/admin/apps", { ...crm, url: "https://other.example.test/mcp", name: "acme crm" })).status).toBe(400);
			// An icon is an https address.
			const logo = "https://cdn.acme.example.test/logo.png";
			expect((await call("ada", "PUT", "/api/admin/apps/acme-crm", { icon: "javascript:alert(1)" })).status).toBe(400);
			expect((await call("ada", "PUT", "/api/admin/apps/acme-crm", { icon: "data:image/svg+xml,<svg/>" })).status).toBe(400);
			expect((await call("ada", "PUT", "/api/admin/apps/acme-crm", { icon: logo })).json).toMatchObject({ app: { icon: logo } });
			expect((await call("ada", "PUT", "/api/admin/apps/nope", { icon: logo })).status).toBe(404);
			expect((await call("bob", "GET", "/api/app-directory")).json.apps).toContainEqual(expect.objectContaining({ ref: "custom/acme-crm", icon: logo, category: "customers" }));
			expect((await call("ada", "DELETE", "/api/admin/apps/acme-crm")).json).toEqual({ deleted: true });
		} finally {
			spy.mockRestore();
		}
	});

	it("keeps a published agent's template, id and uses, when it is published again", async () => {
		const agent = (await call("bob", "POST", "/api/agents", { name: "Cook", instructions: "v1" })).json;
		const first = (await call("bob", "POST", `/api/agents/${agent.id}/publish`, {})).json;
		await call("ada", "POST", `/api/templates/${first.id}/use`);
		await call("bob", "PUT", `/api/agents/${agent.id}`, { instructions: "v2" });
		const again = (await call("bob", "POST", `/api/agents/${agent.id}/publish`, {})).json;
		expect(again).toMatchObject({ id: first.id, uses: 1, instructions: "v2" });
		// Deleting the agent takes its template down.
		expect((await call("bob", "DELETE", `/api/agents/${agent.id}`)).status).toBeLessThan(300);
		expect((await call("ada", "GET", `/api/templates/${first.id}`)).status).toBe(404);
	});

	it("keeps the connector directory in the instance's settings, and answers compute and the computer host as not set up", async () => {
		const added = (await call("ada", "POST", "/api/admin/apps", { name: "Docs", description: "d", url: "https://example.com/mcp", icon: "", category: "productivity" })).json.app.id;
		expect((await call("bob", "GET", "/api/app-directory")).json.apps).toMatchObject([{ ref: added, name: "Docs", custom: true, category: "productivity" }]);
		expect((await call("bob", "POST", "/api/admin/apps", { name: "x", url: "https://x.example" })).status).toBe(403);
		expect((await call("ada", "DELETE", `/api/admin/apps/${encodeURIComponent(added)}`, {})).json).toEqual({ deleted: true });
		expect((await call("bob", "GET", "/api/app-directory")).json.apps).toEqual([]);
		expect((await call("ada", "GET", "/api/admin/compute")).json).toMatchObject({ providers: [], quota: { maxConcurrentWorkspaces: null } });
		// The providers the sandbox pools run on are what the Compute screen lists; changing one is the deployment's environment's, and a member sees nothing of it.
		await stack.admin.query("INSERT INTO pim_forge.forge_pools (pool_id, provider, size) VALUES ('default', 'sandbox-manager', 4), ('spare', 'sandbox-manager', 2)");
		expect((await call("ada", "GET", "/api/admin/compute")).json).toMatchObject({ providers: [{ id: "sandbox-manager", kind: "sandbox-manager", name: "sandbox-manager", codingSandbox: true, agentComputer: false, credentialsSet: {} }], kinds: [{ kind: "sandbox-manager", fields: [] }] });
		expect((await call("bob", "GET", "/api/admin/compute")).status).toBe(403);
		expect((await call("ada", "POST", "/api/admin/compute/providers", { kind: "e2b" })).json).toMatchObject({ error: "not_supported", message: expect.stringContaining("environment") });
		// Everyone's sandbox minutes this month, by provider and by person, though each person's ledger is theirs alone: Ada ran a workspace for 30 minutes, Bob one still running, last month's is not counted.
		const adaId = (await stack.admin.query("SELECT owner_id FROM pim_app.accounts WHERE username = 'ada'")).rows[0].owner_id;
		const bobId = (await stack.admin.query("SELECT owner_id FROM pim_app.accounts WHERE username = 'bob'")).rows[0].owner_id;
		const thisMonth = new Date().toISOString().slice(0, 7);
		const at = (minutesAgo: number) => new Date(Math.max(Date.parse(`${thisMonth}-01T00:00:00Z`) + 1_000, Date.now() - minutesAgo * 60_000));
		await stack.admin.query("INSERT INTO pim_forge.forge_compute_usage (owner_id, thread_id, provider, began_at, ended_at) VALUES ($1,'t1','sandbox-manager',$2,$3), ($4,'t2','sandbox-manager',$5,NULL), ($1,'t3','sandbox-manager','2020-01-05','2020-01-06'), ($1,'t4','sandbox-manager',$6,$7)", [adaId, new Date(`${thisMonth}-01T10:00:00Z`), new Date(`${thisMonth}-01T10:30:00Z`), bobId, at(0), new Date(Date.parse(`${thisMonth}-01T00:00:00Z`) - 40 * 60_000), new Date(Date.parse(`${thisMonth}-01T00:00:00Z`) + 20 * 60_000)]);
		const usage = (await call("ada", "GET", "/api/admin/compute")).json.usage;
		expect(usage).toMatchObject({ month: thisMonth, running: 1, byProvider: [{ provider: "sandbox-manager", running: 1 }] });
		// A stretch that crossed midnight on the 1st counts toward this month only for the 20 minutes that ran in it.
		expect(usage.minutes).toBeGreaterThanOrEqual(50);
		expect(usage.top[0]).toEqual({ username: "ada", minutes: 50, running: 0 });
		expect(usage.top.map((t: { username: string }) => t.username)).toContain("bob");
		// Checking a provider: one that the sandbox pools name but the environment gives no address for says so; an unknown one is not found.
		expect((await call("ada", "POST", "/api/admin/compute/providers/sandbox-manager/validate", {})).json).toMatchObject({ ok: false, message: expect.stringContaining("environment") });
		expect((await call("ada", "POST", "/api/admin/compute/providers/nope/validate", {})).status).toBe(404);
		await stack.admin.query("DELETE FROM pim_forge.forge_compute_usage");
		await stack.admin.query("DELETE FROM pim_forge.forge_pools");
		expect((await call("ada", "GET", "/api/admin/computer-host")).json).toMatchObject({ paired: false, connected: false });
		// Pairing it is the computer host's own tests (computer-host.test.ts): a member cannot.
		expect((await call("bob", "POST", "/api/admin/computer-host")).status).toBe(403);
		const sign = (await call("ada", "GET", "/api/admin/sign-in")).json.providers;
		expect(sign.map((p: any) => p.id)).toEqual(["google", "github", "oidc"]);
		// A provider is checked before it is kept: a server that cannot be read says so unless its models are named, and a built-in service needs its key.
		expect(await call("ada", "POST", "/api/admin/providers", { name: "Local", url: "http://127.0.0.1:1/v1", key: "sk-secret" })).toMatchObject({ status: 400, json: { message: expect.stringContaining("couldn't read the models") } });
		expect(await call("ada", "POST", "/api/admin/providers", { builtin: "openai", models: ["gpt-4.1"] })).toMatchObject({ status: 400, json: { message: "An API key is required" } });
		const provider = (await call("ada", "POST", "/api/admin/providers", { name: "Local", url: "http://127.0.0.1:1/v1", key: "sk-secret", models: ["local"] })).json.provider;
		expect(JSON.stringify(provider)).not.toContain("sk-secret");
		expect(provider.hasKey).toBe(true);
		// Refreshing reads the endpoint again, at the gateway's root when its own path has no list: the chosen model keeps its price, the other listed ones are offered, none is added.
		const { createServer } = await import("node:http");
		const gateway = createServer((req, res) => {
			res.statusCode = req.url === "/v1/models" ? 200 : 400;
			res.end(JSON.stringify(req.url === "/v1/models" ? { object: "list", data: [{ id: "local", context_length: 9_000 }, { id: "newer" }] } : {}));
		});
		await new Promise<void>((resolve) => gateway.listen(0, "127.0.0.1", resolve));
		const root = `http://127.0.0.1:${(gateway.address() as { port: number }).port}`;
		try {
			const own = (await call("ada", "POST", "/api/admin/providers", { name: "Gateway", url: `${root}/anthropic`, api: "anthropic-messages", key: "sk-secret", models: ["local"], overrides: { local: { cost: { input: 3 } } } })).json.provider;
			const refreshed = await call("ada", "POST", `/api/admin/providers/${own.id}/refresh-models`, {});
			expect(refreshed).toMatchObject({ status: 200, json: { available: ["newer"], url: `${root}/v1/models`, provider: { chosen: ["local"] } } });
			const shown = (await call("ada", "GET", "/api/providers")).json.providers.find((p: any) => p.id === own.id);
			expect(shown.config.models).toEqual([{ id: "local", contextWindow: 9_000, cost: { input: 3, output: 0, cacheRead: 0, cacheWrite: 0 } }]);
			// A member's own provider is refreshed by its owner alone.
			const mine = (await call("bob", "POST", "/api/providers", { name: "Mine", url: `${root}/anthropic`, api: "anthropic-messages", key: "k", models: ["local"] })).json.provider;
			expect(await call("bob", "POST", `/api/providers/${mine.id}/refresh-models`, {})).toMatchObject({ status: 200, json: { available: ["newer"], url: `${root}/v1/models` } });
			expect((await call("ada", "POST", `/api/providers/${mine.id}/refresh-models`, {})).status).toBe(404);
			expect((await call("bob", "POST", `/api/admin/providers/${own.id}/refresh-models`, {})).status).toBe(403);
			expect((await call("ada", "POST", "/api/admin/providers/nope/refresh-models", {})).status).toBe(404);
		} finally {
			gateway.close();
		}
	});
});
