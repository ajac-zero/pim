import { fauxAssistantMessage } from "@earendil-works/pi-ai/providers/faux";
import { McpServer } from "@modelcontextprotocol/server";
import { createMcpHandler } from "agents/mcp/server";
import { createExecutionContext, env, runDurableObjectAlarm, runInDurableObject } from "cloudflare:test";
import { exports } from "cloudflare:workers";
import { describe, expect, it, vi } from "vitest";
import type { Directory, RegistrationPolicy } from "../src/directory";
import { toAgent } from "../src/gateway";
import { z } from "zod";
import { completionStream, faux, Pim } from "./worker";
import { ORIGIN, Browser, register, person, rootOf, directory, freshDirectory, operator, admin, holdings, withAgentMethod, toolUse, makeArtifact } from "./people-support";

/** Several people on one Pim: the admin, erasure, and what people share with each other. The first half is in people.test.ts. */

describe("the admin", () => {
	it("is the one who claimed the Pim, signed in with a passkey", async () => {
		const ron = await person("ron");
		expect((await new Browser().json("/api/admin/stats")).status).toBe(401);
		expect((await ron.browser.json("/api/admin/stats")).status).toBe(403);
		expect((await ron.browser.json("/api/admin/accounts/ron/suspend", { method: "POST", json: {} })).status).toBe(403);
		const token = (await operator.browser.json("/auth/tokens", { method: "POST", json: { name: "CLI" } })).body.token as string;
		expect((await new Browser().json("/api/admin/stats", { headers: { Authorization: `Bearer ${token}` } })).status).toBe(403);
		const stats = await admin("/api/admin/stats");
		expect(stats.status).toBe(200);
		expect(stats.body.accounts.active).toBeGreaterThan(1);
		const listed = (await admin("/api/admin/accounts?limit=500")).body.accounts as { username: string; role: string }[];
		expect(listed).toEqual(expect.arrayContaining([expect.objectContaining({ username: "boss", role: "admin" }), expect.objectContaining({ username: "ron", role: "member" })]));
		// The admin can't suspend or delete themself from here.
		expect((await admin("/api/admin/accounts/boss/suspend", { method: "POST", json: {} })).status).toBe(409);
		expect((await admin("/api/admin/accounts/boss", { method: "DELETE" })).status).toBe(409);
	});

	it("suspends an account at once, and restores it", async () => {
		const pat = await person("pat");
		expect((await admin("/api/admin/accounts/pat/suspend", { method: "POST", json: { reason: "spam" } })).body.account).toMatchObject({
			status: "suspended",
			statusReason: "spam",
		});
		expect((await pat.browser.json("/api/sessions")).status).toBe(403);
		// The space refuses too, whatever a Worker has cached.
		const agent = await runInDurableObject(env.Pim.getByName(pat.ownerId), (instance: Pim) => instance.status());
		expect(agent).toBe("suspended");
		await admin("/api/admin/accounts/pat/unsuspend", { method: "POST" });
		expect((await pat.browser.json("/api/sessions")).status).toBe(200);
	});

	it("sets one person's limits over everyone's", async () => {
		const quinn = await person("quinn");
		expect((await quinn.browser.json("/api/usage")).body.limits).toMatchObject({ dailyRuns: null, sessions: null });
		await admin("/api/admin/accounts/quinn/limits", { method: "PUT", json: { limits: { dailyRuns: 0 } } });
		expect((await quinn.browser.json("/api/usage")).body.limits).toMatchObject({ dailyRuns: 0, sessions: null });
		const refused = await quinn.browser.json(`/api/sessions/${await rootOf(quinn.browser)}/messages`, { method: "POST", json: { content: "Hello" } });
		expect(refused.status).toBe(429);
		expect((await admin("/api/admin/accounts/quinn/limits", { method: "PUT", json: { limits: { dailyRuns: "lots" } } })).status).toBe(400);
		await admin("/api/admin/accounts/quinn/limits", { method: "PUT", json: { limits: null } });
		expect((await quinn.browser.json("/api/usage")).body.limits).toMatchObject({ dailyRuns: null });
	});

	it("adds model providers everyone can use, without showing anyone their keys", async () => {
		const ann = await person("provider-ann");
		const gpu = { name: "Team GPU", url: "https://gpu.example.test/v1", key: "team-key" };
		const realFetch = globalThis.fetch;
		const chats: { authorization: string | null; model: string }[] = [];
		const server = vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
			const request = new Request(input, init);
			if (!request.url.startsWith(gpu.url)) return realFetch(input, init);
			if (request.headers.get("authorization") !== `Bearer ${gpu.key}`) return Response.json({ error: "unauthorized" }, { status: 401 });
			if (request.url.endsWith("/models")) return Response.json({ data: [{ id: "team-model" }] });
			const { model } = await request.json<{ model: string }>();
			chats.push({ authorization: request.headers.get("authorization"), model });
			return completionStream(model, "Hello from the team GPU");
		});
		try {
			expect((await ann.browser.json("/api/admin/providers", { method: "POST", json: gpu })).status).toBe(403);
			const added = await admin("/api/admin/providers", { method: "POST", json: gpu });
			expect(added).toMatchObject({ status: 201, body: { provider: { id: "team-gpu", hasKey: true, models: [{ id: "team-model" }] } } });

			// Ann didn't add it, and can use it.
			const model = (await ann.browser.json("/api/model")).body;
			expect(model.providers).toEqual([expect.objectContaining({ id: "team-gpu", provider: "shared:team-gpu", shared: true, hasKey: true })]);
			expect(model.choices).toContainEqual({ provider: "shared:team-gpu", id: "team-model", name: "team-model", images: false });
			expect((await ann.browser.json("/api/model", { method: "PUT", json: { provider: "shared:team-gpu", id: "team-model" } })).status).toBe(200);
			const answer = await ann.browser.json(`/api/sessions/${await rootOf(ann.browser)}/messages`, { method: "POST", json: { content: "Hello?", wait: true } });
			expect(answer.body.text).toBe("Hello from the team GPU");
			expect(chats).toEqual([{ authorization: "Bearer team-key", model: "team-model" }]);
			for (const shown of [added.body, model]) expect(JSON.stringify(shown)).not.toContain(gpu.key);
			// Only the admin changes it; Ann's own changes are to her own providers.
			expect((await ann.browser.json("/api/admin/providers/team-gpu", { method: "PUT", json: { name: "Mine" } })).status).toBe(403);
			expect((await ann.browser.json("/api/providers/team-gpu", { method: "PUT", json: { name: "Mine" } })).status).toBe(404);
			expect((await admin("/api/admin/providers/team-gpu", { method: "PUT", json: { name: "Shared GPU" } })).body.provider).toMatchObject({ name: "Shared GPU", hasKey: true });
		} finally {
			server.mockRestore();
		}

		// Taken away, Ann's chats go back to the default model.
		expect((await admin("/api/admin/providers/team-gpu", { method: "DELETE" })).body).toEqual({ deleted: true });
		const after = (await ann.browser.json("/api/model")).body;
		expect(after.providers).toEqual([]);
		expect(after.model.id).toBe("faux-model");
		expect((await admin("/api/admin/providers/team-gpu", { method: "DELETE" })).status).toBe(404);
	});

	it("sets up compute providers for everyone's coding sandboxes without ever showing a credential, and limits what each person may use", async () => {
		const ann = await person("compute-ann");
		const secret = "mgr-secret-token-91";
		const manager = "https://manager.example.test";
		const input = { kind: "compose", settings: { managerUrl: manager }, credentials: { token: secret } };
		expect((await ann.browser.json("/api/admin/compute/providers", { method: "POST", json: input })).status).toBe(403);
		expect((await ann.browser.json("/api/admin/compute")).status).toBe(403);
		expect((await admin("/api/admin/compute/providers", { method: "POST", json: { ...input, credentials: {} } })).status).toBe(400);
		expect((await admin("/api/admin/compute/providers", { method: "POST", json: { ...input, settings: { managerUrl: `https://admin:${secret}@manager.example.test` } } })).status).toBe(400);
		try {
			const added = await admin("/api/admin/compute/providers", { method: "POST", json: input });
			expect(added).toMatchObject({ status: 201, body: { provider: { id: "compose", kind: "compose", codingSandbox: true, agentComputer: false, settings: { managerUrl: manager }, credentialsSet: { token: true } } } });
			expect((await admin("/api/admin/compute/providers", { method: "POST", json: input })).status).toBe(409);

			// A change that leaves the credential out keeps it; one that gives it replaces it.
			const renamed = await admin("/api/admin/compute/providers/compose", { method: "PUT", json: { name: "Team sandboxes", agentComputer: true } });
			expect(renamed.body.provider).toMatchObject({ name: "Team sandboxes", agentComputer: true, credentialsSet: { token: true } });
			expect((await admin("/api/admin/compute/providers/compose", { method: "PUT", json: { credentials: { token: "rotated-secret-77" } } })).body.provider.credentialsSet).toEqual({ token: true });
			expect((await admin("/api/admin/compute/providers/nope", { method: "PUT", json: { name: "x" } })).status).toBe(404);

			// The health check reads from the manager with the credential the admin gave, and answers without it.
			const realFetch = globalThis.fetch;
			const asked: { path: string; authorization: string | null }[] = [];
			const server = vi.spyOn(globalThis, "fetch").mockImplementation(async (request, init) => {
				const call = new Request(request, init);
				if (!call.url.startsWith(manager)) return realFetch(request, init);
				asked.push({ path: new URL(call.url).pathname, authorization: call.headers.get("authorization") });
				return call.url.endsWith("/health") ? Response.json({ maxConcurrent: 5, running: 2, free: 3, freeDiskPct: 50 }) : Response.json([]);
			});
			let validated: { status: number; body: { health: { ok: boolean; message: string } } };
			try {
				validated = await admin("/api/admin/compute/providers/compose/validate", { method: "POST" });
			} finally {
				server.mockRestore();
			}
			expect(validated).toMatchObject({ status: 200, body: { health: { ok: true, message: "Reachable: 2 of 5 workspaces running." } } });
			expect(asked[0]).toEqual({ path: "/sessions", authorization: "Bearer rotated-secret-77" });
			expect((await admin("/api/admin/compute/providers/nope/validate", { method: "POST" })).status).toBe(404);

			// Nothing the admin or a member can read has either credential.
			const overview = await admin("/api/admin/compute");
			expect(overview.body.providers).toHaveLength(1);
			expect(overview.body.kinds.map((kind: { kind: string }) => kind.kind)).toEqual(["cloudflare-sandbox", "compose"]);
			for (const shown of [added.body, renamed.body, validated.body, overview.body, (await admin("/api/admin/stats")).body, (await ann.browser.json("/api/account")).body, (await ann.browser.json("/api/usage")).body]) {
				for (const hidden of [secret, "rotated-secret-77"]) expect(JSON.stringify(shown)).not.toContain(hidden);
			}
		} finally {
			await admin("/api/admin/compute/providers/compose", { method: "DELETE" });
		}
		expect((await admin("/api/admin/compute/providers/compose", { method: "DELETE" })).status).toBe(404);
		expect((await admin("/api/admin/compute")).body.providers).toEqual([]);

		// Everyone starts with the deployment's quota, which the admin changes; each person's own is kept over it.
		const quotaOf = async () => (await ann.browser.json("/api/usage")).body.compute;
		// A deployment starts with no limits: the admin sets them.
		expect(await quotaOf()).toMatchObject({ quota: { maxConcurrentWorkspaces: null, monthlySandboxMinutes: null, maxSessionMinutes: null }, own: null, usage: { running: 0, minutes: 0, byProvider: [] } });
		expect((await ann.browser.json("/api/admin/compute/quota", { method: "PUT", json: { quota: { maxSessionMinutes: 5 } } })).status).toBe(403);
		expect((await admin("/api/admin/compute/quota", { method: "PUT", json: { quota: { maxSessionMinutes: -1 } } })).status).toBe(400);
		expect((await admin("/api/admin/compute/quota", { method: "PUT", json: { quota: { hours: 1 } } })).status).toBe(400);
		try {
			expect((await admin("/api/admin/compute/quota", { method: "PUT", json: { quota: { monthlySandboxMinutes: null, maxSessionMinutes: 30 } } })).body.quota).toEqual({ maxConcurrentWorkspaces: null, monthlySandboxMinutes: null, maxSessionMinutes: 30 });
			expect((await quotaOf()).quota).toEqual({ maxConcurrentWorkspaces: null, monthlySandboxMinutes: null, maxSessionMinutes: 30 });
			const own = (quota: unknown) => admin("/api/admin/accounts/compute-ann/compute-quota", { method: "PUT", json: { quota } });
			expect((await own({ maxConcurrentWorkspaces: 1, maxSessionMinutes: "long" })).status).toBe(400);
			expect((await own({ maxConcurrentWorkspaces: 1 })).body.quota).toEqual({ maxConcurrentWorkspaces: 1, monthlySandboxMinutes: null, maxSessionMinutes: 30 });
			expect(await quotaOf()).toMatchObject({ quota: { maxConcurrentWorkspaces: 1 }, own: { maxConcurrentWorkspaces: 1 } });
			expect((await admin("/api/admin/accounts/compute-ann")).body.compute).toMatchObject({ own: { maxConcurrentWorkspaces: 1 } });
			expect((await own(null)).body.quota.maxConcurrentWorkspaces).toBeNull();
			expect((await quotaOf()).own).toBeNull();
		} finally {
			await admin("/api/admin/compute/quota", { method: "PUT", json: { quota: { monthlySandboxMinutes: null, maxSessionMinutes: null } } });
		}
		expect((await admin("/api/admin/stats")).body.compute).toMatchObject({ month: expect.stringMatching(/^\d{4}-\d{2}$/), minutes: expect.any(Number), byProvider: expect.any(Array), top: expect.any(Array) });
	});

	it("turns Pim's built-in apps on and off for everyone, leaving people's notes theirs", async () => {
		const nell = await person("notes-nell");
		const { body: kept } = await nell.browser.json("/api/notes", { method: "POST", json: { title: "Kept" } });
		// What Nell's agent is given in a chat, and what loading Notes' skill gets it.
		const chat = async () => {
			const seen = { prompt: "", tools: [] as string[], skill: { text: "", isError: false } };
			faux.setResponses([
				(context) => {
					seen.prompt = JSON.stringify(context.messages.filter((message) => message.role === "system"));
					// The tools offered: every tool the system messages added, less those they removed.
					const tools = new Set<string>();
					for (const message of context.messages) {
						if (message.role !== "system") continue;
						for (const tool of message.toolsAdded ?? []) tools.add(tool.name);
						for (const tool of message.toolsRemoved ?? []) tools.delete(tool.name);
					}
					seen.tools = [...tools];
					return toolUse("read_skill", { app: "notes", skill: "notes" });
				},
				(context) => {
					const result = context.messages.findLast((message) => message.role === "toolResult");
					seen.skill = { text: JSON.stringify(result?.content), isError: result?.isError ?? false };
					return toolUse("send_to_user", { message: "Done." });
				},
			]);
			await nell.browser.json(`/api/sessions/${await rootOf(nell.browser)}/messages`, { method: "POST", json: { content: "Write it down", wait: true } });
			return seen;
		};

		expect((await nell.browser.json("/api/admin/builtin-apps/notes", { method: "PUT", json: { enabled: false } })).status).toBe(403);
		expect((await admin("/api/admin/builtin-apps")).body.apps).toEqual([expect.objectContaining({ id: "notes", name: "Notes", enabled: true })]);
		expect((await admin("/api/admin/builtin-apps/nope", { method: "PUT", json: { enabled: false } })).status).toBe(404);
		expect((await admin("/api/admin/builtin-apps/notes", { method: "PUT", json: { enabled: "no" } })).status).toBe(400);

		const off = await admin("/api/admin/builtin-apps/notes", { method: "PUT", json: { enabled: false } });
		expect(off.body.apps).toEqual([expect.objectContaining({ id: "notes", enabled: false })]);
		expect((await nell.browser.json("/api/builtin-apps")).body.apps).toEqual([]);
		const without = await chat();
		expect(without.tools).not.toContain("note_create");
		expect(without.tools).toContain("app_create");
		expect(without.prompt).not.toContain("Notes is one of Pim's built-in apps");
		expect(without.skill.isError).toBe(true);
		expect((await nell.browser.json("/api/notes", { method: "POST", json: { title: "New" } })).status).toBe(403);
		// The notes Nell has stay hers to read and change.
		expect((await nell.browser.json(`/api/artifacts/${kept.id}`)).status).toBe(200);
		const saved = await nell.browser.json(`/api/artifacts/${kept.id}/versions`, { method: "POST", json: { baseVersion: 1, content: "Still mine" } });
		expect(saved.status).toBe(201);

		await admin("/api/admin/builtin-apps/notes", { method: "PUT", json: { enabled: true } });
		expect((await nell.browser.json("/api/builtin-apps")).body.apps).toEqual([expect.objectContaining({ id: "notes" })]);
		const back = await chat();
		expect(back.tools).toContain("note_create");
		expect(back.prompt).toContain("Notes is one of Pim's built-in apps");
		expect(back.skill).toMatchObject({ isError: false, text: expect.stringContaining("note_edit") });
		expect((await nell.browser.json("/api/notes", { method: "POST", json: { title: "New" } })).status).toBe(201);
	});

	it("shares a built-in service with members without sharing its key or their own connections", async () => {
		const member = await person("builtin-member");
		const model = "llama-3.3-70b-versatile";
		const input = { builtin: "groq", key: "shared-groq-key", models: [model] };
		expect((await member.browser.json("/api/admin/providers", { method: "POST", json: input })).status).toBe(403);
		const added = await admin("/api/admin/providers", { method: "POST", json: input });
		expect(added).toMatchObject({ status: 201, body: { provider: { id: "groq", builtin: "groq", hasKey: true } } });
		const settings = (await member.browser.json("/api/model")).body;
		expect(settings.choices).toContainEqual(expect.objectContaining({ provider: "shared:groq", id: model }));
		expect(JSON.stringify([added.body, settings])).not.toContain(input.key);
		expect((await member.browser.json("/api/providers", { method: "POST", json: { ...input, key: "own-groq-key" } })).status).toBe(200);
		expect((await admin("/api/model")).body.providers.some((provider: { provider: string }) => provider.provider === "own:groq")).toBe(false);
		const realFetch = globalThis.fetch;
		const keys: (string | null)[] = [];
		const server = vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
			const request = new Request(input, init);
			if (request.url !== "https://api.groq.com/openai/v1/chat/completions") return realFetch(input, init);
			keys.push(request.headers.get("authorization"));
			return completionStream(model, "Hello from Groq");
		});
		try {
			for (const provider of ["shared:groq", "own:groq"]) {
				expect((await member.browser.json("/api/model", { method: "PUT", json: { provider, id: model } })).status).toBe(200);
				const answer = await member.browser.json(`/api/sessions/${await rootOf(member.browser)}/messages`, { method: "POST", json: { content: "Hello?", wait: true } });
				expect(answer.body.text).toBe("Hello from Groq");
			}
			expect(keys).toEqual(["Bearer shared-groq-key", "Bearer own-groq-key"]);
		} finally {
			server.mockRestore();
			await admin("/api/admin/providers/groq", { method: "DELETE" });
			await member.browser.json("/api/providers/groq", { method: "DELETE" });
		}
	});

	it("adds apps everyone can connect, which each person signs in to once for all their agents", async () => {
		const uma = await person("app-uma");
		const crm = { name: "Acme CRM", description: "Customers and deals.", url: "https://crm.example.test/mcp" };
		expect((await uma.browser.json("/api/admin/apps", { method: "POST", json: crm })).status).toBe(403);
		expect((await admin("/api/admin/apps", { method: "POST", json: { ...crm, url: "http://crm.example.test/mcp" } })).status).toBe(400);
		// Its icon is its site's: the page its home redirects to links a PNG and an SVG, relative to itself, and the SVG is kept.
		const realSiteFetch = globalThis.fetch;
		const site = vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
			const url = new Request(input, init).url;
			if (url === "https://crm.example.test/") {
				const page = new Response(
					`<head><link rel="icon" href="/favicon.png" sizes="32x32"><link href="static/logo.svg?v=2&amp;x=1" rel="icon" type="image/svg+xml"></head>`,
					{ headers: { "content-type": "text/html; charset=utf-8" } },
				);
				// Followed a redirect to here.
				Object.defineProperty(page, "url", { value: "https://www.acme.example.test/crm/" });
				return page;
			}
			if (url === "https://www.acme.example.test/crm/static/logo.svg?v=2&x=1") return new Response("<svg/>", { headers: { "content-type": "image/svg+xml" } });
			if (url === "https://www.acme.example.test/favicon.png") return new Response("png", { headers: { "content-type": "image/png" } });
			if (url.includes("example.test")) return new Response("Not found", { status: 404 });
			return realSiteFetch(input, init);
		});
		try {
			expect((await admin("/api/admin/apps", { method: "POST", json: { ...crm, category: "crm" } })).status).toBe(400);
			expect(await admin("/api/admin/apps", { method: "POST", json: { ...crm, category: "customers" } })).toMatchObject({ status: 201, body: { app: { id: "acme-crm" } } });
		} finally {
			site.mockRestore();
		}
		expect((await admin("/api/admin/apps", { method: "POST", json: { ...crm, name: "Other" } })).status).toBe(400);
		expect((await uma.browser.json("/api/app-directory")).body.apps).toContainEqual({
			ref: "custom/acme-crm",
			...crm,
			custom: true,
			icon: "https://www.acme.example.test/crm/static/logo.svg?v=2&x=1",
			category: "customers",
		});
		// The admin can give it another; only an https one.
		const logo = "https://cdn.acme.example.test/logo.png";
		expect((await uma.browser.json("/api/admin/apps/acme-crm", { method: "PUT", json: { icon: logo } })).status).toBe(403);
		expect((await admin("/api/admin/apps/acme-crm", { method: "PUT", json: { icon: "javascript:alert(1)" } })).status).toBe(400);
		expect((await admin("/api/admin/apps/acme-crm", { method: "PUT", json: { icon: logo } })).body).toMatchObject({ app: { icon: logo } });
		expect((await admin("/api/admin/apps/nope", { method: "PUT", json: { icon: logo } })).status).toBe(404);
		expect((await uma.browser.json("/api/app-directory")).body.apps).toContainEqual(expect.objectContaining({ ref: "custom/acme-crm", icon: logo }));

		// Two of Uma's agents list it; connecting it once serves both.
		const sales = (await uma.browser.json("/api/agents", { method: "POST", json: { name: "Sales", apps: ["custom/acme-crm"] } })).body;
		await uma.browser.json("/api/agents", { method: "POST", json: { name: "Support", apps: ["custom/acme-crm"] } });
		const realFetch = globalThis.fetch;
		const spy = vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
			const request = new Request(input, init);
			if (!request.url.startsWith(crm.url)) return realFetch(input, init);
			const server = () => {
				const mcp = new McpServer({ name: "crm", version: "1.0.0" });
				mcp.registerTool("deals", { description: "Open deals.", annotations: { readOnlyHint: true } }, async () => ({ content: [{ type: "text", text: "None." }] }));
				return mcp;
			};
			return createMcpHandler(server)(request, {}, createExecutionContext());
		});
		try {
			expect((await uma.browser.json("/api/mcp", { method: "POST", json: { app: "custom/acme-crm" } })).body).toMatchObject({ state: "ready" });
		} finally {
			spy.mockRestore();
		}
		expect((await uma.browser.json("/api/mcp")).body.servers).toEqual([expect.objectContaining({ url: crm.url, agents: ["Sales", "Support"] })]);
		// Nothing but the directory's apps connects.
		expect((await uma.browser.json("/api/mcp", { method: "POST", json: { name: "Evil", url: "https://evil.example.test/mcp" } })).status).toBe(400);

		// Taken out, nobody can add it again; Uma's connection stays until she removes it.
		expect((await admin("/api/admin/apps/acme-crm", { method: "DELETE" })).body).toEqual({ deleted: true });
		expect((await uma.browser.json("/api/app-directory")).body.apps.some((app: { ref: string }) => app.ref === "custom/acme-crm")).toBe(false);
		expect((await uma.browser.json(`/api/agents/${sales.id}`, { method: "PUT", json: { apps: ["custom/acme-crm"] } })).status).toBe(400);
		expect((await uma.browser.json("/api/mcp")).body.servers).toHaveLength(1);
	});

	it("lets the admin's majordomo add an app for everyone, once the admin approves it in the app", async () => {
		const vera = await person("app-vera");
		const tools = async (browser: Browser) => ((await browser.json("/api/permissions")).body.tools as { tool: string }[]).map((info) => info.tool);
		expect(await tools(vera.browser)).not.toContain("add_custom_connector");
		expect(await tools(operator.browser)).toContain("add_custom_connector");

		const wiki = { name: "Acme Wiki", url: "https://wiki.example.test/mcp", description: "The team's pages." };
		let result = "";
		faux.setResponses([
			toolUse("add_custom_connector", wiki),
			(context) => {
				result = JSON.stringify(context.messages.filter((message) => message.role === "toolResult"));
				return toolUse("send_to_user", { message: "Added." });
			},
		]);
		const realFetch = globalThis.fetch;
		const spy = vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
			const request = new Request(input, init);
			if (request.url.startsWith(wiki.url)) {
				const server = () => {
					const mcp = new McpServer({ name: "wiki", version: "1.0.0" });
					mcp.registerTool("pages", { description: "Find pages.", annotations: { readOnlyHint: true } }, async () => ({ content: [{ type: "text", text: "None." }] }));
					return mcp;
				};
				return createMcpHandler(server)(request, {}, createExecutionContext());
			}
			if (request.url.includes("wiki.example.test")) return new Response("Not found", { status: 404 });
			return realFetch(input, init);
		});
		const made = await operator.browser.json("/auth/tokens", { method: "POST", json: { name: "Bridge" } });
		try {
			const turn = admin(`/api/sessions/${await rootOf(operator.browser)}/messages`, { method: "POST", json: { content: "Add our wiki", wait: true } });
			const approval = await vi.waitFor(async () => {
				const [asked] = (await admin("/api/approvals?status=pending")).body.approvals;
				expect(asked).toBeDefined();
				return asked;
			});
			expect(approval).toMatchObject({ action: "add_custom_connector", summary: "Add Acme Wiki (https://wiki.example.test/mcp) to this Pim's connectors for everyone, and connect it" });
			// Not with an API token, even the admin's, nor by claiming to be signed in.
			const byToken = await new Browser().json(`/api/approvals/${approval.id}/approve`, {
				method: "POST",
				json: {},
				headers: { Authorization: `Bearer ${made.body.token}`, "x-pim-signed-in": "1" },
			});
			expect(byToken.status).toBe(403);
			expect((await admin(`/api/approvals/${approval.id}/approve`, { method: "POST", json: {} })).status).toBe(200);
			expect((await turn).body).toMatchObject({ status: "done" });
		} finally {
			spy.mockRestore();
		}
		expect(result).toContain("Connected Acme Wiki.");
		// Everyone can connect it now, and the admin's majordomo works with it.
		expect((await vera.browser.json("/api/app-directory")).body.apps).toContainEqual(expect.objectContaining({ ref: "custom/acme-wiki", ...wiki, custom: true }));
		expect((await admin("/api/majordomo")).body.agent.apps).toContain("custom/acme-wiki");
		expect((await admin("/api/mcp")).body.servers).toContainEqual(expect.objectContaining({ url: wiki.url, state: "ready" }));
		await admin("/api/admin/apps/acme-wiki", { method: "DELETE" });
		await operator.browser.json(`/auth/tokens/${made.body.id}`, { method: "DELETE" });
	});
});

/**
 * What erasing a space must stop, case by case: everything that could
 * still write to it, or act for its owner, once the Directory says it's gone.
 */
describe("erasure boundaries", () => {
	/**
	 * A gate a test holds work on inside a space, and a flag that the work
	 * reached it. Only plain flags cross between the test and the space, each
	 * polled with its own timers: a promise made in the test and awaited in an
	 * agent that then ends would hang the test runner itself.
	 */
	function gate() {
		const state = { reached: false, open: false };
		return {
			/** Called by the held work, in the space. */
			hold: async () => {
				state.reached = true;
				while (!state.open) await new Promise((resolve) => setTimeout(resolve, 10));
			},
			/** Awaited by the test. */
			reached: () => vi.waitFor(() => expect(state.reached).toBe(true), { timeout: 5_000 }),
			release: () => {
				state.open = true;
			},
		};
	}

	async function expectErased(ownerId: string) {
		expect(await holdings(ownerId)).toEqual({ remaining: [], memories: 0, credentials: [], passkeys: 0, tokens: 0 });
		expect(await runInDurableObject(env.Pim.getByName(ownerId), (instance: Pim) => instance.erasure())).toEqual({ sealed: true, remaining: [] });
		expect((await directory().account(ownerId))?.status).toBe("deleted");
	}

	/** Deletes the account from `browser`, which keeps its session cookie, as another of the person's devices would. */
	const deleteAccount = async (browser: Browser, username: string) => {
		const before = new Map(browser.cookies);
		const { body } = await browser.json("/api/account", { method: "DELETE", json: { confirm: username } });
		browser.cookies = before;
		return body;
	};

	it("forgets the sandbox minutes of an erased account, those still running included", async () => {
		const ana = await person("eb-compute");
		const gallery = env.Gallery.getByName("gallery");
		await gallery.computeBegin({ userId: ana.ownerId, threadId: "eb-compute-1", provider: "compose", quota: null });
		await gallery.computeBegin({ userId: ana.ownerId, threadId: "eb-compute-2", provider: "compose", quota: null });
		await gallery.computeEnd("eb-compute-2", "stop");
		expect(await gallery.computeUsageOf(ana.ownerId)).toMatchObject({ running: 1 });
		expect(await deleteAccount(ana.browser, "eb-compute")).toEqual({ deleted: true });
		expect(await gallery.computeUsageOf(ana.ownerId)).toMatchObject({ minutes: 0, running: 0, byProvider: [] });
		expect(await gallery.computeOpen("eb-compute-1")).toBeNull();
	});

	it("closes a socket that was open across the deletion, and takes nothing from it", async () => {
		const ana = await person("eb-socket");
		const upgrade = await ana.browser.fetch("/api/ws", { headers: { Upgrade: "websocket", origin: ORIGIN } });
		expect(upgrade.status).toBe(101);
		const socket = upgrade.webSocket!;
		const closed = new Promise<number>((resolve) => socket.addEventListener("close", (event) => resolve(event.code)));
		const hello = new Promise<void>((resolve) => socket.addEventListener("message", () => resolve(), { once: true }));
		socket.accept();
		await hello;
		expect(await deleteAccount(ana.browser, "eb-socket")).toEqual({ deleted: true });
		expect(await closed).toBe(4010);
		// A submit sent on it afterwards goes nowhere.
		try {
			socket.send(JSON.stringify({ type: "submit", id: "late", content: "Sent on an old socket" }));
		} catch {
			// Closed: the send itself fails.
		}
		await new Promise((resolve) => setTimeout(resolve, 200));
		await expectErased(ana.ownerId);
	});

	it("refuses the write of a request that was already inside the space when the deletion began", async () => {
		const ben = await person("eb-inflight");
		const root = await rootOf(ben.browser);
		const held = gate();
		const prototype = Pim.prototype as Pim;
		const original = prototype.submitTo;
		prototype.submitTo = async function (this: Pim, ...args: Parameters<Pim["submitTo"]>) {
			await held.hold();
			return original.apply(this, args);
		};
		try {
			// Past the Worker and the space's own check, waiting just before it writes.
			const late = ben.browser.json(`/api/sessions/${root}/messages`, { method: "POST", json: { content: "Written after deletion" } });
			await held.reached();
			expect(await deleteAccount(ben.browser, "eb-inflight")).toEqual({ deleted: true });
			held.release();
			// The instance it was in ended: it gets "try again", and trying again gets "gone".
			expect(await late).toMatchObject({ status: 503 });
			const retry = await ben.browser.json(`/api/sessions/${root}/messages`, { method: "POST", json: { content: "Written after deletion" } });
			expect(retry.status).toBe(410);
		} finally {
			prototype.submitTo = original;
		}
		await expectErased(ben.ownerId);
	});

	/**
	 * Holds the first `POST /memory/log` inside the space's request handler,
	 * past the Worker and the space's `fetch`, and records how it ended. The
	 * SDK binds `onRequest` when a space is made, so this goes in before the
	 * person registers. `duringErasure` lets the request go on from inside
	 * the erasure itself, between its start and the wipe.
	 */
	function holdMemoryWrite(held: ReturnType<typeof gate>, options: { duringErasure: boolean; path?: RegExp }) {
		const prototype = Pim.prototype as Pim;
		const original = prototype.onRequest;
		const seen = { outcome: "never resumed" };
		let taken = false;
		const path = options.path ?? /^\/memory\/log$/;
		prototype.onRequest = async function (this: Pim, request: Request) {
			if (taken || request.method !== "POST" || !path.test(new URL(request.url).pathname)) return original.call(this, request);
			taken = true;
			if (options.duringErasure) {
				const storage = this.ctx.storage as { deleteAll: DurableObjectStorage["deleteAll"] };
				const wipe = storage.deleteAll.bind(this.ctx.storage);
				storage.deleteAll = async (...args) => {
					held.release();
					// Long enough for the held request to go on before the wipe.
					await new Promise((resolve) => setTimeout(resolve, 100));
					return wipe(...args);
				};
			}
			await held.hold();
			try {
				const response = await original.call(this, request);
				seen.outcome = `answered ${response.status}`;
				return response;
			} catch (error) {
				seen.outcome = `threw ${error instanceof Error ? error.message : String(error)}`;
				throw error;
			}
		};
		return { seen, restore: () => (prototype.onRequest = original) };
	}

	it("refuses a write in the space's handler that goes on while the erasure runs", async () => {
		const held = gate();
		const hook = holdMemoryWrite(held, { duringErasure: true });
		try {
			const gil = await person("eb-handler-during");
			const late = gil.browser.json("/api/memory/log", { method: "POST", json: { text: "Written during erasure" } });
			await held.reached();
			expect(await deleteAccount(gil.browser, "eb-handler-during")).toEqual({ deleted: true });
			// It went on before the wipe, and the space, already erasing, refused it.
			expect(hook.seen.outcome).toBe("answered 410");
			expect((await late).status).toBe(410);
			await expectErased(gil.ownerId);
		} finally {
			hook.restore();
		}
	});

	it("refuses an artifact restore in the space's handler that goes on while the erasure runs", async () => {
		const held = gate();
		const hook = holdMemoryWrite(held, { duringErasure: true, path: /^\/artifacts\/[^/]+\/restore$/ });
		try {
			const jo = await person("eb-artifact-handler");
			const id = await makeArtifact(jo.browser, "<p>Jo's page</p>");
			const late = jo.browser.json(`/api/artifacts/${id}/restore`, { method: "POST", json: { version: 1, baseVersion: 1 } });
			await held.reached();
			expect(await deleteAccount(jo.browser, "eb-artifact-handler")).toEqual({ deleted: true });
			expect(hook.seen.outcome).toBe("answered 410");
			expect((await late).status).toBe(410);
			await expectErased(jo.ownerId);
		} finally {
			hook.restore();
		}
	});

	it("drops a write held in the space's handler until the instance has ended", async () => {
		const held = gate();
		const hook = holdMemoryWrite(held, { duringErasure: false });
		try {
			const hal = await person("eb-handler-after");
			const late = hal.browser.json("/api/memory/log", { method: "POST", json: { text: "Written after deletion" } });
			await held.reached();
			expect(await deleteAccount(hal.browser, "eb-handler-after")).toEqual({ deleted: true });
			held.release();
			// The instance it was in ended with the erasure: the request gets "try again", and its handler never goes on.
			expect((await late).status).toBe(503);
			await new Promise((resolve) => setTimeout(resolve, 200));
			expect(hook.seen.outcome).toBe("never resumed");
			await expectErased(hal.ownerId);
		} finally {
			hook.restore();
		}
	});

	it("keeps a model request under way from writing its answer", async () => {
		const cy = await person("eb-model");
		const held = gate();
		faux.setResponses([
			async () => {
				await held.hold();
				return fauxAssistantMessage("Written after deletion");
			},
		]);
		expect((await cy.browser.json(`/api/sessions/${await rootOf(cy.browser)}/messages`, { method: "POST", json: { content: "Think slowly" } })).status).toBe(202);
		await held.reached();
		expect(await deleteAccount(cy.browser, "eb-model")).toEqual({ deleted: true });
		held.release();
		await new Promise((resolve) => setTimeout(resolve, 300));
		await expectErased(cy.ownerId);
	});

	it("keeps an artifact the model asks for during the erasure from being written", async () => {
		const di = await person("eb-artifact");
		const held = gate();
		faux.setResponses([
			async () => {
				await held.hold();
				return toolUse("app_create", { title: "Late", kind: "html", content: "<p>Made during erasure</p>" });
			},
		]);
		await withAgentMethod(
			"deleteEverything",
			(original) =>
				async function (this: Pim) {
					const storage = this.ctx.storage as { deleteAll: DurableObjectStorage["deleteAll"] };
					const wipe = storage.deleteAll.bind(this.ctx.storage);
					storage.deleteAll = async (...args) => {
						// The model asks for the artifact once the erasure has begun, before the wipe.
						held.release();
						await new Promise((resolve) => setTimeout(resolve, 100));
						return wipe(...args);
					};
					return original.call(this);
				},
			async () => {
				expect((await di.browser.json(`/api/sessions/${await rootOf(di.browser)}/messages`, { method: "POST", json: { content: "Make a page" } })).status).toBe(202);
				await held.reached();
				expect(await deleteAccount(di.browser, "eb-artifact")).toEqual({ deleted: true });
			},
		);
		await new Promise((resolve) => setTimeout(resolve, 300));
		await expectErased(di.ownerId);
		const rows = await runInDurableObject(env.Pim.getByName(di.ownerId), (_instance: Pim, state) =>
			state.storage.sql.exec("SELECT COUNT(*) AS count FROM sqlite_master WHERE name = 'pim_artifact_versions'").one().count === 0
				? 0
				: state.storage.sql.exec("SELECT COUNT(*) AS count FROM pim_artifact_versions").one().count,
		);
		expect(rows).toBe(0);
	});

	it("keeps a model answer that arrives during the erasure from being written", async () => {
		const ivy = await person("eb-model-during");
		const held = gate();
		const answered = { during: false };
		faux.setResponses([
			async () => {
				await held.hold();
				answered.during = true;
				return fauxAssistantMessage("Written during erasure");
			},
		]);
		// Let the answer arrive from inside the erasure: after it has begun, before the wipe.
		await withAgentMethod(
			"deleteEverything",
			(original) =>
				async function (this: Pim) {
					const storage = this.ctx.storage as { deleteAll: DurableObjectStorage["deleteAll"] };
					const wipe = storage.deleteAll.bind(this.ctx.storage);
					storage.deleteAll = async (...args) => {
						held.release();
						await new Promise((resolve) => setTimeout(resolve, 100));
						return wipe(...args);
					};
					return original.call(this);
				},
			async () => {
				expect((await ivy.browser.json(`/api/sessions/${await rootOf(ivy.browser)}/messages`, { method: "POST", json: { content: "Think slowly" } })).status).toBe(202);
				await held.reached();
				const started = Date.now();
				expect(await deleteAccount(ivy.browser, "eb-model-during")).toEqual({ deleted: true });
				// A run that ignores its abort can't hold the deletion past the courtesy wait.
				expect(Date.now() - started).toBeLessThan(10_000);
				// The model did answer, mid-erasure; the answer was not kept.
				expect(answered.during).toBe(true);
			},
		);
		await expectErased(ivy.ownerId);
	});

	it("never runs an action whose approval timer outlives the space", async () => {
		const dot = await person("eb-approval");
		// Auto-approve after the timeout: the dangerous case.
		expect((await dot.browser.json("/api/settings", { method: "PUT", json: { approvalPolicy: "auto" } })).body).toMatchObject({ approvalPolicy: "auto" });
		const realFetch = globalThis.fetch;
		const hook = vi.fn();
		const spy = vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
			const request = new Request(input, init);
			if (!request.url.startsWith("https://hooks.example.test/")) return realFetch(input, init);
			hook(request.url);
			return new Response("sent", { status: 201 });
		});
		try {
			faux.setResponses([toolUse("http_request", { method: "POST", url: "https://hooks.example.test/after-deletion" })]);
			await dot.browser.json(`/api/sessions/${await rootOf(dot.browser)}/messages`, { method: "POST", json: { content: "Send it" } });
			await vi.waitFor(async () => {
				const pending = await runInDurableObject(env.Pim.getByName(dot.ownerId), (instance: Pim) => instance.store.approvals("pending"));
				expect(pending).toHaveLength(1);
			});
			expect(await deleteAccount(dot.browser, "eb-approval")).toEqual({ deleted: true });
			// Past the test agent's 1.5-second timeout, which would have approved and sent it.
			await new Promise((resolve) => setTimeout(resolve, 2_500));
			expect(hook).not.toHaveBeenCalled();
		} finally {
			spy.mockRestore();
		}
		await expectErased(dot.ownerId);
	});

	it("runs no scheduled work that comes due after the deletion", async () => {
		const eve = await person("eb-schedule");
		const due = { label: "Write", instruction: "Write something", source: { kind: "time", schedule: "once", at: Date.now() + 1_000 }, enabled: true };
		expect((await eve.browser.json("/api/triggers", { method: "POST", json: due })).status).toBe(201);
		expect(await deleteAccount(eve.browser, "eb-schedule")).toEqual({ deleted: true });
		await new Promise((resolve) => setTimeout(resolve, 2_100));
		// Wiping cleared the alarm; firing one anyway does nothing.
		await runDurableObjectAlarm(env.Pim.getByName(eve.ownerId));
		await expectErased(eve.ownerId);
	});

	it("refuses a Worker that still has the account cached, and the hosting service's own writes", async () => {
		const fay = await person("eb-stale");
		expect(await deleteAccount(fay.browser, "eb-stale")).toEqual({ deleted: true });
		// Another Worker that still has the account cached as active, with requests it already authorized.
		const stale = fay.ownerId;
		const write = new Request(`${ORIGIN}/api/memory/log`, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ text: "Written by a stale gateway" }),
		});
		expect((await toAgent(write, env, stale, "/memory/log")).status).toBe(410);
		const socket = new Request(`${ORIGIN}/api/ws`, { headers: { Upgrade: "websocket" } });
		expect((await toAgent(socket, env, stale, "/ws")).status).toBe(410);
		const callback = new Request(`${ORIGIN}/mcp/events/watch-1`, { method: "POST", body: "{}" });
		expect((await toAgent(callback, env, stale, "/mcp/events/watch-1")).status).toBe(410);
		const writes: ((instance: Pim) => Promise<unknown>)[] = [
			(instance) => instance.provision({ ownerId: fay.ownerId, username: "eb-stale" }),
			(instance) => instance.applySettings({ timeZone: "Asia/Tokyo" }),
			(instance) => instance.setLimits({ dailyRuns: 1 }),
			(instance) => instance.submitTo("1", "Hello", {}, "pim"),
		];
		for (const write of writes) {
			await expect(runInDurableObject(env.Pim.getByName(fay.ownerId), write)).rejects.toThrow(/erased/);
		}
		await expectErased(fay.ownerId);
	});
});

describe("circles and visits", () => {
	const created: { title: string; day: string }[] = [];
	const calendar = () => {
		const server = new McpServer({ name: "calendar", version: "1.0.0" });
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
	};
	const withCalendar = () => {
		const realFetch = globalThis.fetch;
		return vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
			const request = new Request(input, init);
			if (!request.url.startsWith("https://calendar.example.test/mcp")) return realFetch(input, init);
			return createMcpHandler(calendar)(request, {}, createExecutionContext());
		});
	};
	const say = async (browser: Browser, session: string, content: string) =>
		browser.json(`/api/sessions/${session}/messages`, { method: "POST", json: { content, wait: true } });
	const transcript = async (browser: Browser, session: string) =>
		JSON.stringify((await browser.json(`/api/sessions/${session}/messages`)).body.messages);
	const setPermission = (browser: Browser, circle: string, app: string | null, tool: string, permission: string | null) =>
		browser.json("/api/permissions", { method: "PUT", json: { circle, app, tool, permission } });

	it("lets someone in a circle message the owner's space from their own, with only what the circle was given", async () => {
		const spy = withCalendar();
		try {
			const ana = await person("ana");
			const ben = await person("ben");
			const cyd = await person("cyd");
			expect((await ana.browser.json("/api/mcp", { method: "POST", json: { app: "test.ledger/calendar" } })).status).toBe(201);
			await ana.browser.json("/api/memory/log", { method: "POST", json: { text: "Ana's favourite restaurant is Tasca do Chico.", scope: "everyone" } });
			await ana.browser.json("/api/memory/log", { method: "POST", json: { text: "Ana's door code is 0420." } });

			// Ana puts Ben in a circle; Ben's space hears of it.
			const family = (await ana.browser.json("/api/circles", { method: "POST", json: { name: "Family" } })).body;
			expect((await ana.browser.json(`/api/circles/${family.id}/members`, { method: "POST", json: { username: "nobody-here" } })).status).toBe(404);
			expect((await ana.browser.json(`/api/circles/${family.id}/members`, { method: "POST", json: { username: "ana" } })).status).toBe(400);
			expect((await ana.browser.json(`/api/circles/${family.id}/members`, { method: "POST", json: { username: "@Ben" } })).status).toBe(201);
			expect((await ben.browser.json("/api/visits")).body.visits).toEqual([
				{ ownerId: ana.ownerId, username: "ana", sharedAt: expect.any(Number), available: true, session: null },
			]);
			expect((await ben.browser.json("/api/notifications")).body.notifications[0]).toMatchObject({ title: "ana shared their space with you" });

			// A circle starts with nothing: every tool off, no memory scope.
			const circleTools = (await ana.browser.json(`/api/permissions?circle=${family.id}`)).body.tools;
			expect(circleTools.map((info: { name: string; permission: string }) => [info.name, info.permission])).toEqual([
				["calendar_find_events", "off"],
				["calendar_create_event", "off"],
			]);
			expect(family.memoryScopes).toEqual([]);
			// It reads everyone's scope and those Ana named, never her majordomo's own.
			expect((await ana.browser.json(`/api/circles/${family.id}`, { method: "PUT", json: { memoryScopes: ["private"] } })).status).toBe(400);
			expect((await ana.browser.json(`/api/circles/${family.id}`, { method: "PUT", json: { memoryScopes: ["everyone"] } })).body.memoryScopes).toEqual(["everyone"]);
			await setPermission(ana.browser, family.id, "calendar", "find_events", "on");
			await setPermission(ana.browser, family.id, "calendar", "create_event", "ask");

			// Ben's visit runs in Ben's space, on Ben's usage, with Ana's tools and memory and nothing of Ben's own.
			const session = (await ben.browser.json("/api/visits/ana", { method: "POST" })).body.session as string;
			let system = "";
			let offered: string[] = [];
			faux.setResponses([
				(context) => {
					system = JSON.stringify(context.messages.filter((message) => message.role === "system"));
					offered = context.messages.flatMap((message) =>
						message.role === "system" ? (message.toolsAdded ?? []).map((tool) => tool.name) : [],
					);
					return toolUse("calendar_find_events", { day: "monday" });
				},
				toolUse("send_to_user", { message: "Ana sees the dentist at 9 on Monday." }),
			]);
			expect((await say(ben.browser, session, "Is Ana free Monday morning?")).body).toMatchObject({ status: "done" });
			expect(system).toContain("You are ana's personal AI agent");
			expect(system).toContain("Tasca do Chico");
			expect(system).not.toContain("0420");
			// The circle's tools, and the visitor's own way to be answered.
			expect(offered.sort()).toEqual(["calendar_create_event", "calendar_find_events", "current_time", "recall", "send_to_user"]);
			expect(await transcript(ben.browser, session)).toContain("Events on monday: dentist at 9.");
			const usage = async (browser: Browser) => (await browser.json("/api/usage")).body.today;
			expect(await usage(ben.browser)).toMatchObject({ runs: 1, modelRequests: 2 });
			expect(await usage(ana.browser)).toMatchObject({ runs: 0, modelRequests: 0 });
			// Ben's own chats don't get Ana's tools, or her instructions.
			expect(((await ben.browser.json("/api/")).body.tools as { name: string }[]).map((tool) => tool.name)).not.toContain("calendar_find_events");
			let own = "";
			let ownTools: string[] = [];
			faux.setResponses([
				(context) => {
					own = JSON.stringify(context.messages.filter((message) => message.role === "system"));
					ownTools = context.messages.flatMap((message) =>
						message.role === "system" ? (message.toolsAdded ?? []).map((tool) => tool.name) : [],
					);
					return toolUse("send_to_user", { message: "Hi Ben." });
				},
			]);
			await say(ben.browser, await rootOf(ben.browser), "Hi");
			expect(ownTools).toContain("note");
			expect(ownTools).not.toContain("calendar_find_events");
			expect(own).not.toContain("ana's space");
			expect((await ben.browser.json("/api/sessions")).body.sessions.find((info: { id: string }) => info.id === session)).toMatchObject({
				visit: { username: "ana", available: true },
			});

			// A tool that asks: Ana gets the request, with who asked; her answer continues Ben's visit.
			faux.setResponses([toolUse("calendar_create_event", { title: "Lunch with Ben", day: "friday" }), toolUse("send_to_user", { message: "I've asked Ana." })]);
			expect((await say(ben.browser, session, "Put lunch with me on Ana's calendar Friday.")).body).toMatchObject({ status: "done" });
			expect(created).toEqual([]);
			const [asked] = (await ana.browser.json("/api/approvals?status=pending")).body.approvals;
			expect(asked).toMatchObject({
				summary: 'Calendar: create_event {"title":"Lunch with Ben","day":"friday"}',
				requestedBy: { ownerId: ben.ownerId, username: "ben", circle: family.id, circleName: "Family" },
				onTimeout: "deny",
			});
			expect((await ana.browser.json("/api/notifications")).body.notifications[0]).toMatchObject({ title: "ben asked your agent" });
			faux.setResponses([toolUse("send_to_user", { message: "Ana said yes: lunch is on her calendar." })]);
			expect((await ana.browser.json(`/api/approvals/${asked.id}/approve`, { method: "POST", json: {} })).body).toMatchObject({ status: "approved" });
			expect(created).toEqual([{ title: "Lunch with Ben", day: "friday" }]);
			await vi.waitFor(async () => expect(await transcript(ben.browser, session)).toContain("Ana said yes: lunch is on her calendar."));
			expect(await transcript(ben.browser, session)).toContain("[ana's answer to approval");
			expect(await usage(ana.browser)).toMatchObject({ runs: 0, modelRequests: 0 });
			expect((await ana.browser.json("/api/circles/activity")).body.activity.map((entry: { tool: string; outcome: string }) => [entry.tool, entry.outcome])).toEqual([
				["calendar_create_event", "asked"],
				["calendar_find_events", "ran"],
			]);

			// The boundary is in Ana's space, at each call: a tool turned off is refused even to a space that was told of it, and nobody outside the circle gets anything.
			await setPermission(ana.browser, family.id, "calendar", "find_events", "off");
			const call = (guest: { ownerId: string; username: string }) =>
				runInDurableObject(env.Pim.getByName(ana.ownerId), (instance: Pim) =>
					instance.guestCall(guest, { tool: "calendar_find_events", args: { day: "tuesday" }, session, callId: "c1" }),
				);
			expect(await call({ ownerId: ben.ownerId, username: "ben" })).toEqual({ text: "ana doesn't let you use calendar_find_events.", isError: true });
			expect(await call({ ownerId: cyd.ownerId, username: "cyd" })).toEqual({ text: "ana doesn't share their space with you.", isError: true });
			await ana.browser.json(`/api/circles/${family.id}`, { method: "PUT", json: { enabled: false } });
			expect((await say(ben.browser, session, "Still there?")).status).toBe(403);

			// Taken out of the circle, Ben's space knows, and the visit can't go on.
			await ana.browser.json(`/api/circles/${family.id}`, { method: "PUT", json: { enabled: true } });
			expect((await ana.browser.json(`/api/circles/${family.id}/members/${ben.ownerId}`, { method: "DELETE" })).status).toBe(200);
			expect((await ben.browser.json("/api/visits")).body.visits[0]).toMatchObject({ available: false, session });
			expect((await say(ben.browser, session, "Hello?")).status).toBe(403);
		} finally {
			spy.mockRestore();
		}
	});
});

describe("profiles and published agents", () => {
	it("lets people publish an agent, others find it and make it their own, and takes it all down with the account", async () => {
		const dee = await person("dee");
		const eli = await person("eli");

		expect((await dee.browser.json("/api/profile", { method: "PUT", json: { displayName: "x".repeat(51) } })).status).toBe(400);
		expect((await dee.browser.json("/api/profile", { method: "PUT", json: { displayName: "Dee Rivers", bio: "Runs, cooks." } })).body).toEqual({
			username: "dee",
			displayName: "Dee Rivers",
			bio: "Runs, cooks.",
		});

		const make = async (json: Record<string, unknown>) => (await dee.browser.json("/api/agents", { method: "POST", json })).body;
		// The coach hands tasks to a physio, and the physio to a dietitian: both come with it.
		const dietitian = await make({ name: "Dietitian", instructions: "Plan meals around training." });
		const physio = await make({ name: "Physio", description: "Checks injury risk.", instructions: "Check every plan for injury risk.", symbol: "🩺", contacts: [dietitian.id] });
		const coach = await make({
			name: "Marathon coach",
			description: "Plans training weeks.",
			instructions: "Plan one week at a time.",
			apps: ["test.ledger/strava"],
			contacts: [physio.id],
			symbol: "🏃",
			color: "teal",
		});
		const png = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10, 7]);
		const physioPng = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10, 8]);
		await dee.browser.fetch(`/api/agents/${coach.id}/icon`, { method: "PUT", headers: { "content-type": "image/png" }, body: png });
		await dee.browser.fetch(`/api/agents/${physio.id}/icon`, { method: "PUT", headers: { "content-type": "image/png" }, body: physioPng });
		const published = await dee.browser.json(`/api/agents/${coach.id}/publish`, { method: "POST" });
		expect(published).toMatchObject({
			status: 201,
			body: { author: "dee", authorName: "Dee Rivers", name: "Marathon coach", symbol: "🏃", color: "teal", icon: expect.any(Number), uses: 0 },
		});
		const templateId = published.body.id as string;
		expect((await dee.browser.json(`/api/agents/${coach.id}`)).body.published).toBe(templateId);
		// Publishing again replaces it, under the same id.
		await dee.browser.json(`/api/agents/${coach.id}`, { method: "PUT", json: { instructions: "Plan two weeks at a time." } });
		expect((await dee.browser.json(`/api/agents/${coach.id}/publish`, { method: "POST" })).body).toMatchObject({ id: templateId });

		// Eli finds it, by search or on Dee's page, and reads it in full: a copy of the agent, never Dee's data.
		const found = (await eli.browser.json("/api/templates?q=marathon")).body.templates;
		expect(found).toEqual([expect.objectContaining({ id: templateId, author: "dee", name: "Marathon coach" })]);
		expect(found[0]).not.toHaveProperty("instructions");
		expect(found[0]).toMatchObject({ symbol: "🏃", color: "teal", icon: expect.any(Number) });
		const shown = await eli.browser.fetch(`/api/templates/${templateId}/icon`);
		expect(shown.headers.get("content-type")).toBe("image/png");
		expect(new Uint8Array(await shown.arrayBuffer())).toEqual(png);
		expect((await eli.browser.json("/api/templates?q=nothing-like-it")).body.templates).toEqual([]);
		expect((await eli.browser.json("/api/people/dee")).body).toMatchObject({
			username: "dee",
			displayName: "Dee Rivers",
			bio: "Runs, cooks.",
			templates: [expect.objectContaining({ id: templateId })],
		});
		expect((await eli.browser.json(`/api/templates/${templateId}`)).body).toMatchObject({
			instructions: "Plan two weeks at a time.",
			contacts: ["Physio"],
			bundle: [
				{ name: "Physio", description: "Checks injury risk.", instructions: "Check every plan for injury risk.", symbol: "🩺", contacts: ["Dietitian"], icon: expect.any(Number) },
				{ name: "Dietitian", instructions: "Plan meals around training.", contacts: [], icon: null },
			],
		});
		// Each agent that comes with it shows its own uploaded icon, by its place.
		expect(new Uint8Array(await (await eli.browser.fetch(`/api/templates/${templateId}/agents/0/icon`)).arrayBuffer())).toEqual(physioPng);
		expect((await eli.browser.fetch(`/api/templates/${templateId}/agents/1/icon`)).status).toBe(404);

		// Made his own: a copy in Eli's agents, his to change, with copies of the agents that come with it; Dee's is untouched, and counts the use.
		await eli.browser.json("/api/agents", { method: "POST", json: { name: "Physio", instructions: "Fix my knee." } });
		const mine = await eli.browser.json(`/api/templates/${templateId}/use`, { method: "POST" });
		expect(mine).toMatchObject({
			status: 201,
			body: {
				name: "Marathon coach",
				instructions: "Plan two weeks at a time.",
				apps: ["test.ledger/strava"],
				symbol: "🏃",
				color: "teal",
				icon: expect.any(Number),
				source: { template: templateId, author: "dee" },
				published: null,
			},
		});
		// The physio's copy takes a role of its own beside Eli's own physio, and a name of its own too, and each copy hands tasks to the copies of its contacts.
		const eliAgents = (await eli.browser.json("/api/agents")).body.agents as { id: string; name: string; role: string; contacts: string[]; source: unknown }[];
		const named = (role: string) => eliAgents.find((agent) => agent.role === role)!;
		expect(eliAgents.map((agent) => agent.role)).toEqual(["Majordomo", "Physio", "Marathon coach", "Physio (Marathon coach)", "Dietitian"]);
		expect(eliAgents.map((agent) => agent.name)).toEqual(["Majordomo", "Physio", "Marathon coach", "Physio (Marathon coach)", "Dietitian"]);
		expect(mine.body.contacts).toEqual([named("Physio (Marathon coach)").id]);
		expect(named("Physio (Marathon coach)")).toMatchObject({ contacts: [named("Dietitian").id], source: { template: templateId, author: "dee" } });
		expect(named("Physio").contacts).toEqual([]);
		// Their copies have their icons too.
		expect(new Uint8Array(await (await eli.browser.fetch(`/api/agents/${named("Physio (Marathon coach)").id}/icon`)).arrayBuffer())).toEqual(physioPng);
		expect((await eli.browser.fetch(`/api/agents/${named("Dietitian").id}/icon`)).status).toBe(404);
		// The copy has its own icon: the picture, kept when the template's changes.
		const copied = await eli.browser.fetch(`/api/agents/${mine.body.id}/icon`);
		expect(new Uint8Array(await copied.arrayBuffer())).toEqual(png);
		await eli.browser.json(`/api/agents/${mine.body.id}`, { method: "PUT", json: { instructions: "Plan my week around work." } });
		expect((await dee.browser.json(`/api/agents/${coach.id}`)).body.instructions).toBe("Plan two weeks at a time.");
		expect((await eli.browser.json(`/api/templates/${templateId}`)).body.uses).toBe(1);
		// Copies of one agent share a memory scope: made his own again, each new copy keeps its notes with the earlier copy of the same agent.
		type Scoped = { id: string; contacts: string[]; memoryScope: string };
		const second = (await eli.browser.json(`/api/templates/${templateId}/use`, { method: "POST" })).body as Scoped;
		const eliAgent = async (id: string) => (await eli.browser.json(`/api/agents/${id}`)).body as Scoped;
		const physioAgain = await eliAgent(second.contacts[0]!);
		const dietitianAgain = await eliAgent(physioAgain.contacts[0]!);
		expect([second.memoryScope, physioAgain.memoryScope, dietitianAgain.memoryScope]).toEqual(
			[mine.body.id, named("Physio (Marathon coach)").id, named("Dietitian").id].map((id) => `agent-${id}`),
		);
		const firstScopes = (await eli.browser.json("/api/agents")).body.agents.map((agent: Scoped) => agent.memoryScope);
		expect(new Set(firstScopes).size).toBe(5);
		expect(firstScopes[0]).toBe("private");
		for (const copy of [second, physioAgain, dietitianAgain]) await eli.browser.fetch(`/api/agents/${copy.id}`, { method: "DELETE" });
		// Published again without its picture, the template has none; Eli's copy keeps it.
		await dee.browser.fetch(`/api/agents/${coach.id}/icon`, { method: "DELETE" });
		await dee.browser.json(`/api/agents/${coach.id}`, { method: "PUT", json: { symbol: "rocket", color: null } });
		expect((await dee.browser.json(`/api/agents/${coach.id}/publish`, { method: "POST" })).body).toMatchObject({ symbol: "rocket", color: null, icon: null });
		expect((await eli.browser.fetch(`/api/templates/${templateId}/icon`)).status).toBe(404);
		expect((await eli.browser.fetch(`/api/agents/${mine.body.id}/icon`)).status).toBe(200);

		// Unpublished, it's gone from the gallery; Eli keeps his copy.
		expect((await dee.browser.json(`/api/agents/${coach.id}/publish`, { method: "DELETE" })).status).toBe(200);
		expect((await eli.browser.json(`/api/templates/${templateId}`)).status).toBe(404);
		expect((await eli.browser.json("/api/agents")).body.agents.map((agent: { role: string }) => agent.role)).toEqual(["Majordomo", "Physio", "Marathon coach", "Physio (Marathon coach)", "Dietitian"]);

		// Deleting a published agent unpublishes it; deleting the account takes the profile and everything published.
		const again = (await dee.browser.json(`/api/agents/${coach.id}/publish`, { method: "POST" })).body.id;
		await dee.browser.json(`/api/agents/${coach.id}`, { method: "DELETE" });
		expect((await eli.browser.json(`/api/templates/${again}`)).status).toBe(404);
		const other = (await dee.browser.json("/api/agents", { method: "POST", json: { name: "Cook", instructions: "Suggest dinners." } })).body;
		await dee.browser.json(`/api/agents/${other.id}/publish`, { method: "POST" });
		expect((await eli.browser.json("/api/templates?q=cook")).body.templates).toHaveLength(1);
		expect((await dee.browser.json("/api/account", { method: "DELETE", json: { confirm: "dee" } })).status).toBe(200);
		expect((await eli.browser.json("/api/templates?q=cook")).body.templates).toEqual([]);
		expect(await env.Gallery!.getByName("gallery").holds(dee.ownerId)).toBe(false);
		expect((await eli.browser.json("/api/people/dee")).status).toBe(404);
	});

	it("gives everyone who joins a copy of the agent the admin chose, theirs to change", async () => {
		const before = await person("nell");
		const shopper = (await admin("/api/agents", { method: "POST", json: { name: "Shopper", instructions: "Keep the shopping list." } })).body;
		const helper = (
			await admin("/api/agents", {
				method: "POST",
				json: {
					name: "Household helper",
					description: "Keeps the house running.",
					instructions: "Check the family calendar first.",
					contacts: [shopper.id],
					symbol: "house",
					color: "amber",
				},
			})
		).body;
		const png = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10, 9]);
		const cart = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10, 10]);
		await operator.browser.fetch(`/api/agents/${helper.id}/icon`, { method: "PUT", headers: { "content-type": "image/png" }, body: png });
		await operator.browser.fetch(`/api/agents/${shopper.id}/icon`, { method: "PUT", headers: { "content-type": "image/png" }, body: cart });
		expect((await before.browser.json("/api/admin/default-agent", { method: "PUT", json: { agent: helper.id } })).status).toBe(403);
		expect((await admin("/api/admin/default-agent", { method: "PUT", json: { agent: "p_nope" } })).status).toBe(404);
		expect((await admin("/api/admin/default-agent", { method: "PUT", json: { agent: helper.id } })).body.agent).toMatchObject({
			author: "boss",
			agentId: helper.id,
			name: "Household helper",
			symbol: "house",
			color: "amber",
			icon: true,
		});

		// A newcomer gets a copy besides their majordomo; whoever joined before doesn't. The name they gave when they joined is the one it greets them by.
		expect((await register("otto", { name: "Otto\nLilienthal" })).status).toBe(400);
		const otto = await person("otto", { name: " Otto Lilienthal " });
		expect((await otto.browser.json("/api/majordomo")).body).toMatchObject({ agent: { name: "Majordomo", majordomo: true }, introduced: false, yourName: "Otto Lilienthal" });
		const [, copy, shopperCopy] = (await otto.browser.json("/api/agents")).body.agents;
		expect(shopperCopy).toMatchObject({ name: "Shopper", instructions: "Keep the shopping list.", source: { template: "default", author: "boss" } });
		expect(copy).toMatchObject({
			contacts: [shopperCopy.id],
			name: "Household helper",
			description: "Keeps the house running.",
			instructions: "Check the family calendar first.",
			symbol: "house",
			color: "amber",
			icon: expect.any(Number),
			majordomo: false,
			source: { template: "default", author: "boss" },
		});
		expect(new Uint8Array(await (await otto.browser.fetch(`/api/agents/${copy.id}/icon`)).arrayBuffer())).toEqual(png);
		expect(new Uint8Array(await (await otto.browser.fetch(`/api/agents/${shopperCopy.id}/icon`)).arrayBuffer())).toEqual(cart);
		expect((await before.browser.json("/api/agents")).body.agents).toEqual([expect.objectContaining({ name: "Majordomo", majordomo: true })]);

		// The copy is Otto's: the admin's later edits don't reach it, and his don't reach theirs.
		await admin(`/api/agents/${helper.id}`, { method: "PUT", json: { instructions: "Ask before buying anything." } });
		await otto.browser.json(`/api/agents/${copy.id}`, { method: "PUT", json: { name: "Otto's helper" } });
		expect((await otto.browser.json("/api/agents")).body.agents[1]).toMatchObject({
			name: "Otto's helper",
			instructions: "Check the family calendar first.",
		});
		expect((await admin(`/api/agents/${helper.id}`)).body.name).toBe("Household helper");

		// Taken back, people join with only their majordomo again.
		expect((await admin("/api/admin/default-agent", { method: "DELETE" })).body).toEqual({ agent: null });
		expect((await (await person("pia")).browser.json("/api/agents")).body.agents).toEqual([
			expect.objectContaining({ name: "Majordomo", instructions: "", symbol: null, color: null, icon: null, majordomo: true }),
		]);
	});

	it("lets the operator take a template down", async () => {
		const fin = await person("fin");
		const agent = (await fin.browser.json("/api/agents", { method: "POST", json: { name: "Spam", instructions: "Buy now." } })).body;
		const template = (await fin.browser.json(`/api/agents/${agent.id}/publish`, { method: "POST" })).body.id;
		expect((await admin(`/api/admin/templates/${template}`, { method: "DELETE" })).status).toBe(200);
		expect((await fin.browser.json(`/api/templates/${template}`)).status).toBe(404);
	});
});

describe("bots", () => {
	const say = async (browser: Browser, session: string, content: string) =>
		browser.json(`/api/sessions/${session}/messages`, { method: "POST", json: { content, wait: true } });
	/** The system prompt of the next model request, which answers with `reply`. */
	const nextPrompt = (reply: string) => {
		const seen = { system: "" };
		faux.setResponses([
			(context) => {
				seen.system = JSON.stringify(context.messages.filter((message) => message.role === "system"));
				return toolUse("send_to_user", { message: reply });
			},
		]);
		return seen;
	};

	it("lets the admin share an agent through a public link that anyone joins as a guest who only chats with it", async () => {
		const tutor = (
			await admin("/api/agents", {
				method: "POST",
				json: { name: "Spanish tutor", description: "Practise Spanish with me.", instructions: "Answer only in Spanish.", symbol: "🇪🇸", color: "amber" },
			})
		).body;
		const png = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10, 11]);
		await operator.browser.fetch(`/api/agents/${tutor.id}/icon`, { method: "PUT", headers: { "content-type": "image/png" }, body: png });

		// Only the admin shares bots: the deployment pays for their guests.
		const member = await person("bot-member");
		const own = (await member.browser.json("/api/agents", { method: "POST", json: { name: "Mine", instructions: "Hi." } })).body;
		expect((await member.browser.json(`/api/agents/${own.id}/bot`, { method: "PUT" })).status).toBe(403);
		expect((await admin(`/api/agents/${tutor.id}/bot`)).status).toBe(404);
		expect((await admin(`/api/agents/${tutor.id}/bot`, { method: "PUT", json: { dailyMessages: 0 } })).status).toBe(400);
		const shared = await admin(`/api/agents/${tutor.id}/bot`, { method: "PUT", json: { dailyMessages: 2 } });
		expect(shared).toMatchObject({ status: 201, body: { dailyMessages: 2, guests: 0, url: expect.stringMatching(/^https:\/\/pim\.test\/b\/b_[0-9a-f]{16}$/) } });
		const botId = shared.body.id as string;

		// Anyone with the link sees what it is, never its instructions.
		const stranger = new Browser();
		const card = await stranger.json(`/api/bots/${botId}`);
		expect(card).toMatchObject({ status: 200, body: { id: botId, author: "boss", name: "Spanish tutor", description: "Practise Spanish with me.", symbol: "🇪🇸", icon: expect.any(Number) } });
		expect(JSON.stringify(card.body)).not.toContain("Answer only in Spanish");
		expect(new Uint8Array(await (await stranger.fetch(`/api/bots/${botId}/icon`)).arrayBuffer())).toEqual(png);
		expect((await stranger.json("/api/bots/b_0000000000000000")).status).toBe(404);

		// Joining through it makes a guest with a copy of the bot, and nothing the admin gives members.
		expect((await register("bot-nobody", { bot: "b_0000000000000000" })).status).toBe(404);
		const guest = await person("bot-guest", { bot: botId });
		expect(guest.registered.role).toBe("guest");
		// A guest's space never has triggers.
		expect(await runInDurableObject(env.Pim.getByName(guest.ownerId), (pim: Pim) => pim.triggerEngine())).toBeNull();
		const bot = (await guest.browser.json("/api/bot")).body;
		expect(bot).toMatchObject({ bot: { id: botId, name: "Spanish tutor", dailyMessages: 2 }, agent: expect.any(String) });
		expect(JSON.stringify(bot)).not.toContain("Answer only in Spanish");
		const agents = (await guest.browser.json("/api/agents")).body.agents;
		expect(agents.map((agent: { name: string }) => agent.name)).toEqual(["Majordomo", "Spanish tutor"]);
		expect(agents[1]).toMatchObject({ id: bot.agent, instructions: "Answer only in Spanish.", source: { template: botId, author: "boss" } });
		expect((await guest.browser.json("/api/usage")).body.limits).toMatchObject({ dailyRuns: 2 });
		expect((await admin(`/api/agents/${tutor.id}/bot`)).body.guests).toBe(1);

		// Every chat a guest starts is with their bot.
		const chat = (await guest.browser.json("/api/sessions", { method: "POST", json: {} })).body;
		expect(chat.agent).toMatchObject({ id: bot.agent });
		let seen = nextPrompt("¡Hola!");
		expect((await say(guest.browser, chat.id, "Hello")).body).toMatchObject({ status: "done" });
		expect(seen.system).toContain("Answer only in Spanish.");

		// A guest reaches only what chatting needs: not agents, models, sharing, publishing, memory, a computer or MCP.
		for (const [method, path] of [
			["POST", "/api/agents"],
			["PUT", `/api/agents/${bot.agent}`],
			["DELETE", `/api/agents/${bot.agent}`],
			["POST", `/api/agents/${bot.agent}/publish`],
			["PUT", "/api/model"],
			["GET", "/api/circles"],
			["GET", "/api/memory"],
			["GET", "/api/computer"],
			["GET", "/api/templates"],
			["GET", `/api/sessions/${chat.id}/link`],
			["POST", "/api/admin/invites"],
		] as const) {
			expect([method, path, (await guest.browser.fetch(path, { method })).status]).toEqual([method, path, 403]);
		}
		const token = (await guest.browser.json("/auth/tokens", { method: "POST", json: { name: "cli" } })).body.token as string;
		expect(token).toEqual(expect.any(String));
		const viaMcp = await exports.default.fetch(
			new Request(`${ORIGIN}/mcp`, { method: "POST", headers: { authorization: `Bearer ${token}`, "content-type": "application/json" }, body: "{}" }),
		);
		expect(viaMcp.status).toBe(401);
		// Nobody finds a guest to share with.
		expect((await member.browser.json("/api/people/bot-guest")).status).toBe(404);
		const circle = (await member.browser.json("/api/circles", { method: "POST", json: { name: "Friends" } })).body;
		expect((await member.browser.json(`/api/circles/${circle.id}/members`, { method: "POST", json: { username: "bot-guest" } })).status).toBe(404);

		// Shared again, the guest's copy follows on their next request, with the new daily messages.
		await admin(`/api/agents/${tutor.id}`, { method: "PUT", json: { instructions: "Answer only in Spanish, slowly." } });
		await operator.browser.fetch(`/api/agents/${tutor.id}/icon`, { method: "DELETE" });
		expect((await admin(`/api/agents/${tutor.id}/bot`, { method: "PUT", json: { dailyMessages: 3 } })).status).toBe(200);
		expect((await guest.browser.json("/api/bot")).body.bot).toMatchObject({ dailyMessages: 3, icon: null });
		expect((await guest.browser.json(`/api/agents/${bot.agent}`)).body).toMatchObject({ instructions: "Answer only in Spanish, slowly.", icon: null });
		expect((await guest.browser.json("/api/usage")).body.limits).toMatchObject({ dailyRuns: 3 });
		seen = nextPrompt("Muy bien.");
		expect((await say(guest.browser, chat.id, "Again")).body).toMatchObject({ status: "done" });
		expect(seen.system).toContain("Answer only in Spanish, slowly.");
		// Past its daily messages, the bot answers nothing more today.
		faux.setResponses([toolUse("send_to_user", { message: "Tres." })]);
		await say(guest.browser, chat.id, "Three");
		expect((await say(guest.browser, chat.id, "Four")).status).toBe(429);

		// Turned off, the link shows nothing and lets nobody in; the guest keeps their chats to read, and can't send more.
		const fresh = await person("bot-guest-two", { bot: botId });
		expect((await admin(`/api/agents/${tutor.id}/bot`, { method: "DELETE" })).body).toEqual({ deleted: true });
		expect((await stranger.json(`/api/bots/${botId}`)).status).toBe(404);
		expect((await register("bot-late", { bot: botId })).status).toBe(404);
		expect((await fresh.browser.json("/api/bot")).body.bot).toBeNull();
		expect((await fresh.browser.json("/api/sessions")).status).toBe(200);
		const theirs = (await fresh.browser.json("/api/sessions", { method: "POST", json: {} })).body;
		expect((await say(fresh.browser, theirs.id, "Hello?")).status).toBe(429);
	});

	it("gives guests only the tools the admin shares, run with the admin's connection, up to the bot's tool calls a day", async () => {
		const search = { name: "Web search", description: "Searches the web.", url: "https://search.example.test/mcp", icon: "https://search.example.test/icon.png" };
		let found = 0;
		const realFetch = globalThis.fetch;
		const server = vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
			const request = new Request(input, init);
			if (!request.url.startsWith(search.url)) return realFetch(input, init);
			const mcp = () => {
				const app = new McpServer({ name: "search", version: "1.0.0" });
				app.registerTool("find", { description: "Search the web.", annotations: { readOnlyHint: true } }, async () => {
					found += 1;
					return { content: [{ type: "text", text: "Found it." }] };
				});
				app.registerTool("forget", { description: "Delete the search history.", annotations: { destructiveHint: true } }, async () => ({ content: [{ type: "text", text: "Gone." }] }));
				return app;
			};
			return createMcpHandler(mcp)(request, {}, createExecutionContext());
		});
		try {
			expect((await admin("/api/admin/apps", { method: "POST", json: search })).status).toBe(201);
			// The admin connects it once, in their own space.
			expect((await admin("/api/mcp", { method: "POST", json: { app: "custom/web-search" } })).body).toMatchObject({ state: "ready" });
			const agent = (await admin("/api/agents", { method: "POST", json: { name: "Researcher", instructions: "Look things up.", apps: ["custom/web-search"] } })).body;
			expect((await admin(`/api/agents/${agent.id}/bot-tools`)).body.tools).toEqual([
				expect.objectContaining({ name: "web_search_find", appName: "Web search", destructive: false }),
				expect.objectContaining({ name: "web_search_forget", appName: "Web search", destructive: true }),
			]);
			const share = (json: unknown) => admin(`/api/agents/${agent.id}/bot`, { method: "PUT", json });
			expect((await share({ tools: ["shell"] })).status).toBe(400);
			const shared = await share({ tools: ["web_search_find"], dailyToolCalls: 1 });
			expect(shared.body).toMatchObject({ tools: ["web_search_find"], dailyToolCalls: 1 });

			// The guest's copy works with no connectors of its own: it has the one tool shared, and connects nothing.
			const guest = await person("search-guest", { bot: shared.body.id });
			const { agent: copy } = (await guest.browser.json("/api/bot")).body;
			expect((await guest.browser.json(`/api/agents/${copy}`)).body.apps).toEqual([]);
			const results: string[] = [];
			const seen = { tools: [] as string[] };
			faux.setResponses([
				(context) => {
					// Every tool the system messages added, less those they removed.
					const tools = new Set<string>();
					for (const message of context.messages) {
						if (message.role !== "system") continue;
						for (const tool of message.toolsAdded ?? []) tools.add(tool.name);
						for (const tool of message.toolsRemoved ?? []) tools.delete(tool.name);
					}
					seen.tools = [...tools];
					return toolUse("web_search_find", { query: "pim" });
				},
				toolUse("web_search_find", { query: "pim again" }),
				(context) => {
					for (const message of context.messages) if (message.role === "toolResult") results.push(JSON.stringify(message.content));
					return toolUse("send_to_user", { message: "Done." });
				},
			]);
			const chat = (await guest.browser.json("/api/sessions", { method: "POST", json: {} })).body;
			expect((await say(guest.browser, chat.id, "Look it up twice")).body).toMatchObject({ status: "done" });
			expect(seen.tools).toContain("web_search_find");
			expect(seen.tools).not.toContain("web_search_forget");
			expect(results[0]).toContain("Found it.");
			// One call a day: the second never leaves the guest's space.
			expect(results[1]).toContain("today's 1 tool calls are used up");
			expect(found).toBe(1);
			expect((await guest.browser.json("/api/usage")).body.today).toMatchObject({ toolCalls: 1 });
			expect((await guest.browser.json("/api/mcp")).body.servers).toEqual([]);

			// Shared again without it, the admin's space refuses it, whatever the guest's space asks.
			expect((await share({ tools: [], dailyToolCalls: 5 })).body.tools).toEqual([]);
			const refused = await runInDurableObject(env.Pim.getByName(operator.ownerId), (instance: Pim) =>
				instance.runBotTool(shared.body.id, guest.ownerId, "web_search_find", { query: "pim" }),
			);
			expect(refused).toMatchObject({ isError: true, content: [{ text: "Researcher doesn't share web_search_find." }] });
			expect(found).toBe(1);

			// Shared to ask first: each call waits for the admin, who approves one and denies the next.
			expect((await share({ tools: ["web_search_find"], ask: ["shell"] })).status).toBe(400);
			expect((await share({ tools: ["web_search_find"], ask: ["web_search_find"], dailyToolCalls: 5 })).body).toMatchObject({ ask: ["web_search_find"] });
			const asked: string[] = [];
			faux.setResponses([
				toolUse("web_search_find", { query: "asked" }),
				toolUse("web_search_find", { query: "asked again" }),
				(context) => {
					for (const message of context.messages) if (message.role === "toolResult") asked.push(JSON.stringify(message.content));
					return toolUse("send_to_user", { message: "Done." });
				},
			]);
			const later = (await guest.browser.json("/api/sessions", { method: "POST", json: {} })).body;
			expect((await guest.browser.json(`/api/sessions/${later.id}/messages`, { method: "POST", json: { content: "Ask first" } })).status).toBe(202);
			const request = () =>
				vi.waitFor(async () => {
					const [pending] = (await admin("/api/approvals?status=pending")).body.approvals;
					expect(pending).toMatchObject({ requestedBy: { username: "search-guest", bot: shared.body.id } });
					return pending;
				});
			const first = await request();
			expect(first.summary).toContain("web_search_find");
			// Nothing runs until the admin answers, and only they can: never "always".
			expect(found).toBe(1);
			expect((await admin(`/api/approvals/${first.id}/approve`, { method: "POST", json: { always: true } })).status).toBe(400);
			expect((await admin(`/api/approvals/${first.id}/approve`, { method: "POST", json: {} })).body).toMatchObject({ status: "approved" });
			const second = await vi.waitFor(async () => {
				const next = await request();
				expect(next.id).not.toBe(first.id);
				return next;
			});
			expect((await admin(`/api/approvals/${second.id}/deny`, { method: "POST", json: { note: "Once is enough." } })).body).toMatchObject({ status: "denied" });
			await vi.waitFor(() => expect(asked).toHaveLength(2), { timeout: 10_000 });
			expect(asked[0]).toContain("Found it.");
			expect(asked[1]).toContain("said no, so web_search_find didn't run. boss's note: Once is enough.");
			expect(found).toBe(2);
			// Each call counts once, though it ran again when the admin's answer woke it.
			expect((await guest.browser.json("/api/usage")).body.today).toMatchObject({ toolCalls: 3 });
		} finally {
			// The admin's connection goes before the server it talks to does.
			await admin("/api/mcp/web_search", { method: "DELETE" });
			server.mockRestore();
			await admin("/api/admin/apps/web-search", { method: "DELETE" });
		}
	});

	it("runs guests on the model the admin chose for the bot, one this Pim offers everyone", async () => {
		const gpu = { name: "Bot GPU", url: "https://bot-gpu.example.test/v1", key: "bot-key" };
		const realFetch = globalThis.fetch;
		const asked: string[] = [];
		const server = vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
			const request = new Request(input, init);
			if (!request.url.startsWith(gpu.url)) return realFetch(input, init);
			if (request.url.endsWith("/models")) return Response.json({ data: [{ id: "bot-model" }] });
			const { model } = await request.json<{ model: string }>();
			asked.push(model);
			return completionStream(model, "Hello from the bot GPU");
		});
		try {
			expect((await admin("/api/admin/providers", { method: "POST", json: gpu })).status).toBe(201);
			const agent = (await admin("/api/agents", { method: "POST", json: { name: "Model bot", instructions: "Be brief." } })).body;
			const share = (json: unknown) => admin(`/api/agents/${agent.id}/bot`, { method: "PUT", json });
			// Never the admin's own ChatGPT plan, nor a model this Pim doesn't offer.
			expect((await share({ model: { provider: "openai", id: "gpt-5" } })).status).toBe(400);
			expect((await share({ model: { provider: "shared:bot-gpu", id: "no-such-model" } })).status).toBe(400);
			expect((await share({ model: "bot-model" })).status).toBe(400);
			const shared = await share({ model: { provider: "shared:bot-gpu", id: "bot-model" } });
			expect(shared).toMatchObject({ status: 201, body: { model: { provider: "shared:bot-gpu", id: "bot-model" } } });

			const guest = await person("model-guest", { bot: shared.body.id });
			const { agent: copy } = (await guest.browser.json("/api/bot")).body;
			expect((await guest.browser.json(`/api/agents/${copy}`)).body.model).toEqual({ provider: "shared:bot-gpu", id: "bot-model" });
			const chat = (await guest.browser.json("/api/sessions", { method: "POST", json: {} })).body;
			const answer = await guest.browser.json(`/api/sessions/${chat.id}/messages`, { method: "POST", json: { content: "Hi", wait: true } });
			expect(answer.body.text).toBe("Hello from the bot GPU");
			expect(asked).toEqual(["bot-model"]);

			// Shared again without saying, it keeps its model; back to the default, guests follow.
			expect((await share({ dailyMessages: 5 })).body.model).toEqual({ provider: "shared:bot-gpu", id: "bot-model" });
			expect((await share({ model: null })).body.model).toBeNull();
			expect((await guest.browser.json(`/api/agents/${copy}`)).body.model).toBeNull();
		} finally {
			server.mockRestore();
			await admin("/api/admin/providers/bot-gpu", { method: "DELETE" });
		}
	});

	it("lets guests join whatever the registration mode, without counting as someone to share with", async () => {
		const stub = await freshDirectory();
		const keeper = (await stub.resolve("keeper"))!;
		const closed: RegistrationPolicy = { mode: "closed", maxAccounts: 3, perAddressPerDay: 100 };
		expect(await stub.register({ username: "walk-in", ip: "1", policy: closed })).toMatchObject({ ok: false, status: 403 });
		const joined = await stub.register({ username: "visitor", ip: "1", policy: closed, bot: "b_0123456789abcdef" });
		expect(joined).toMatchObject({ ok: true, account: { role: "guest", bot: "b_0123456789abcdef" } });
		if (!joined.ok) return;
		await stub.activate(joined.account.ownerId);
		expect(await stub.hasOthers(keeper.ownerId)).toBe(false);
		expect(await stub.botGuests("b_0123456789abcdef")).toBe(1);
		// The cap on accounts holds for guests too.
		await stub.register({ username: "visitor-two", ip: "2", policy: closed, bot: "b_0123456789abcdef" });
		expect(await stub.register({ username: "visitor-three", ip: "3", policy: closed, bot: "b_0123456789abcdef" })).toMatchObject({ ok: false, status: 503 });
	});
});

