import { binaryValue } from "../src/app-files.ts";
import { createHmac } from "node:crypto";
import type { Server } from "node:http";
import { OwnerId, type Principal } from "@pim/v2-contracts/identity";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { App } from "../src/app.ts";
import { KeyringCrypto } from "../src/crypto.ts";
import { connect } from "../src/db.ts";
import { createGate } from "../src/gate.ts";
import { MemoryObjectStore } from "../src/objects.ts";
import { asSession, bootstrap, freshDatabase, member } from "./support/fixture.ts";

let urls: Awaited<ReturnType<typeof freshDatabase>>;
let app: App;
let emptyChat = "";
let admin: Awaited<ReturnType<typeof bootstrap>>;
let server: Server;
let base: string;
const key = (n: number) => new Uint8Array(32).fill(n);
let crypto = new KeyringCrypto("k1", { k1: key(1) });

beforeAll(async () => {
	urls = await freshDatabase();
	const fetchTools = async () => [{ name: "search", description: "Search" }, { name: "delete_everything" }];
	app = new App(connect(urls.appUrl, 8), new MemoryObjectStore(), { crypto, fetchTools, transcripts: { read: async (_o, chat) => [{ role: "user", text: `hello from ${chat}` }], shared: async (_o, chat) => (chat === emptyChat ? [] : [{ role: "user", text: `hello from ${chat}`, images: 1, at: 1 }]) } });
	admin = await bootstrap(app, "boss");
	await app.identity.setRegistrationOpen(admin.principal, true);
	server = createGate(app);
	await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
	base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
});
afterAll(async () => {
	await new Promise<void>((r) => server.close(() => r()));
	await app.db.end();
});

const mk = async (name: string) => {
	const m = await member(app, admin.principal, name);
	const token = await app.identity.createSession(m.account.ownerId);
	return { ...m, token, http: (path: string, init: RequestInit = {}) => fetch(base + path, { ...init, headers: { authorization: `Bearer ${token}`, ...(init.body ? { "content-type": "application/json" } : {}), ...(init.headers as object) } }) };
};
const body = (o: unknown) => JSON.stringify(o);

describe("agents and skills", () => {
	it("keeps contacts and delegates inside the space, drops deleted agents from them, and versions skills", async () => {
		const u = await mk("agt");
		const a = await app.agents.create(u.principal, { name: "Scout", instructions: "look around", emoji: "🔭", color: "#336699" });
		const b = await app.agents.create(u.principal, { name: "Writer" });
		// What an agent is for: the role is its name until it has one, and the app's form calls the emoji its symbol.
		expect(b).toMatchObject({ role: "Writer", description: "" });
		const coach = await app.agents.create(u.principal, { name: "Ada", role: "Coach", description: "Coaches runners", symbol: "🏃" } as never);
		expect(coach).toMatchObject({ role: "Coach", description: "Coaches runners", emoji: "🏃" });
		expect(await app.agents.update(u.principal, coach.id, { description: "Coaches everyone" })).toMatchObject({ role: "Coach", description: "Coaches everyone" });
		await expect(app.agents.update(u.principal, coach.id, { role: " " })).rejects.toMatchObject({ status: 400 });
		// An agent that came from v1 keeps them under config.legacy until it has its own.
		await app.db.owner(u.account.ownerId, (tx) => tx.query("INSERT INTO pim_app.agents (id, owner_id, name, instructions, config) VALUES ('a_legacy', $1, 'Old', '', $2)", [u.account.ownerId, JSON.stringify({ legacy: { role: "Researcher", description: "Reads" } })]));
		expect(await app.agents.get(u.principal, "a_legacy")).toMatchObject({ role: "Researcher", description: "Reads" });
		await expect(app.agents.update(u.principal, a.id, { contacts: ["a_nope"] })).rejects.toMatchObject({ status: 400 });
		await expect(app.agents.update(u.principal, a.id, { delegates: [a.id] })).rejects.toMatchObject({ status: 400 });
		await expect(app.agents.update(u.principal, a.id, { color: "javascript:alert(1)" })).rejects.toMatchObject({ status: 400 });
		const updated = await app.agents.update(u.principal, a.id, { contacts: [b.id], delegates: [b.id], model: { provider: "openai", id: "gpt-6.1-sol" }, emoji: null });
		expect(updated).toMatchObject({ contacts: [b.id], delegates: [b.id], model: { provider: "openai", id: "gpt-6.1-sol" }, emoji: null, color: "#336699" });

		const skill = await app.agents.createSkill(u.principal, { name: "research", body: "# v1", files: { "notes/readme.md": "hi" } });
		expect(skill.version).toBe(1);
		await expect(app.agents.createSkill(u.principal, { name: "research" })).rejects.toMatchObject({ code: "skill_exists" });
		await expect(app.agents.createSkill(u.principal, { name: "bad", files: { "../etc/passwd": "x" } })).rejects.toMatchObject({ status: 400 });
		await app.agents.update(u.principal, a.id, { skills: ["research"] });
		await expect(app.agents.update(u.principal, a.id, { skills: ["missing"] })).rejects.toMatchObject({ status: 400 });
		await app.agents.updateSkill(u.principal, "research", { body: "# v2" });
		expect((await app.agents.skillVersion(u.principal, "research", 1)).body).toBe("# v1");
		const restored = await app.agents.restoreSkill(u.principal, "research", 1);
		expect([restored.version, restored.body, restored.files]).toEqual([3, "# v1", { "notes/readme.md": "hi" }]);

		// Over HTTP: the same, with the supporting file readable.
		const res = await u.http("/api/skills/research/versions/1/file?path=notes/readme.md");
		expect(await res.text()).toBe("hi");
		await app.agents.deleteSkill(u.principal, "research");
		expect((await app.agents.get(u.principal, a.id)).skills).toEqual([]);
		await app.agents.remove(u.principal, b.id);
		expect(await app.agents.get(u.principal, a.id)).toMatchObject({ contacts: [], delegates: [] });
		expect((await u.http(`/api/agents/${b.id}`)).status).toBe(404);
	});

	it("lets an admin make a published template the default, adopted once by each person", async () => {
		const agent = await app.agents.create(admin.principal, { name: "Majordomo", instructions: "help" });
		const { id } = await app.sharing.publishTemplate(admin.principal, agent.id);
		await app.agents.setDefaultTemplate(admin.principal, id);
		const u = await mk("adopter");
		const first = await app.agents.adoptDefault(u.principal);
		expect(first).toMatchObject({ name: "Majordomo", instructions: "help", adoptedFrom: id });
		expect((await app.agents.adoptDefault(u.principal))?.id).toBe(first!.id); // once
		await expect(app.agents.setDefaultTemplate(u.principal, id)).rejects.toMatchObject({ reason: "admin-only" });
		const copy = await app.sharing.useTemplate(u.principal, id);
		expect(copy.id).not.toBe(first!.id);
		await app.agents.setDefaultTemplate(admin.principal, null);
		expect(await app.agents.adoptDefault((await mk("late")).principal)).toBeNull();
	});
});

describe("what an adopted agent keeps", () => {
	it("copies the role, description, look, connectors and the agents that come with it, for the default agent and a used template", async () => {
		const scout = await app.agents.create(admin.principal, { name: "Scout", role: "Researcher", description: "Finds things out", instructions: "search", emoji: "🔎", color: "#336699", apps: ["gmail"] });
		const boss = await app.agents.create(admin.principal, { name: "Boss", role: "Lead", description: "Runs the team", instructions: "lead", emoji: "👑", color: "#aa3300", apps: ["calendar"], contacts: [scout.id] });
		const { id } = await app.sharing.publishTemplate(admin.principal, boss.id);
		await app.agents.setDefaultTemplate(admin.principal, id);
		const u = await mk("heir");
		const copy = await app.agents.adoptDefault(u.principal);
		expect(copy).toMatchObject({ name: "Boss", role: "Lead", description: "Runs the team", emoji: "👑", color: "#aa3300", apps: ["calendar"], adoptedFrom: id });
		const mine = await app.agents.list(u.principal);
		const helper = mine.find((a) => a.name === "Scout")!;
		expect(helper).toMatchObject({ role: "Researcher", description: "Finds things out", emoji: "🔎", apps: ["gmail"] });
		expect(copy!.contacts).toEqual([helper.id]); // its own copy of the contact, not the admin's agent
		expect(helper.id).not.toBe(scout.id);
		// Using the template brings the same.
		const other = await mk("user2x");
		const used = await app.sharing.useTemplate(other.principal, id);
		expect((await app.agents.list(other.principal)).filter((a) => a.name === "Scout")).toHaveLength(1);
		expect(used).toMatchObject({ role: "Lead", description: "Runs the team", color: "#aa3300" });
	});

	it("holds a person to 20 published agents and 20 bots", async () => {
		const u = await mk("publisher");
		const made = [];
		for (let i = 0; i < 21; i++) made.push(await app.agents.create(u.principal, { name: `Agent ${i}` }));
		for (const a of made.slice(0, 20)) await app.sharing.publishTemplate(u.principal, a.id);
		await expect(app.sharing.publishTemplate(u.principal, made[20]!.id)).rejects.toMatchObject({ status: 409, code: "limit" });
		await app.sharing.publishTemplate(u.principal, made[0]!.id); // publishing again replaces, so it is not over the limit
		for (const a of made.slice(0, 20)) await app.sharing.createBot(u.principal, a.id);
		await expect(app.sharing.createBot(u.principal, made[20]!.id)).rejects.toMatchObject({ code: "limit" });
	});
});

describe("the session list", () => {
	it("lists the most recently active first with unread, archived, continuedFrom and startedBy", async () => {
		const u = await mk("lister");
		const a = await app.conversations.create(u.principal, { title: "first" });
		const b = await app.conversations.create(u.principal, { title: "second" });
		const next = await app.conversations.handoff(u.principal, a, "summary");
		await app.conversations.markResponse(u.account.ownerId, b, new Date());
		const d = await app.conversations.admit(u.principal, { commandId: "dl", kind: "delegate", chatId: b, payload: { title: "research" } });
		let list = (await (await u.http("/api/sessions")).json()) as { sessions: any[] };
		const byId = Object.fromEntries(list.sessions.map((s) => [s.id, s]));
		expect(byId[b]).toMatchObject({ unread: true, archived: false, startedBy: null });
		expect(byId[next]).toMatchObject({ continuedFrom: a });
		expect(byId[d.chatId!]).toMatchObject({ startedBy: { session: b, task: d.result!.taskId, state: "working" } });
		expect(byId[a]).toBeUndefined(); // archived by its continuation
		await u.http(`/api/sessions/${b}/read`, { method: "POST" });
		await u.http(`/api/sessions/${b}/archive`, { method: "POST" });
		list = (await (await u.http("/api/sessions")).json()) as never;
		expect(list.sessions.find((s) => s.id === b)).toBeUndefined();
		const archived = (await (await u.http("/api/sessions?archived=true")).json()) as { sessions: any[] };
		expect(archived.sessions.map((s) => s.id)).toEqual(expect.arrayContaining([a, b]));
		expect(archived.sessions.find((s) => s.id === b)).toMatchObject({ unread: false, archived: true });
		// A message to an archived chat brings it back.
		await u.http(`/api/sessions/${b}/unarchive`, { method: "POST", body: body({ commandId: "ua1" }) });
		expect(((await (await u.http("/api/sessions")).json()) as any).sessions.map((s: any) => s.id)).toContain(b);
	});
});

describe("providers", () => {
	it("seals keys, never returns them, rotates them, and drops a removed provider from the fallbacks", async () => {
		const u = await mk("prov");
		const p = await app.providers.create(u.principal, { kind: "anthropic", name: "Work", apiKey: "sk-ant-secret-123" });
		expect(p).toMatchObject({ kind: "anthropic", name: "Work", hasKey: true });
		const stored = await app.db.owner(u.account.ownerId, async (tx) => (await tx.query("SELECT secret, config FROM pim_app.providers WHERE id = $1", [p.id])).rows[0]);
		expect(stored.secret).not.toContain("sk-ant");
		expect(JSON.stringify(stored.config)).not.toContain("sk-ant");
		expect(await app.providers.reveal(u.account.ownerId, p.id)).toBe("sk-ant-secret-123");
		const listed = await (await u.http("/api/providers")).text();
		expect(listed).not.toContain("sk-ant");
		expect(listed).not.toContain("pimenc");
		// A sealed key is bound to its owner and row: moved to another provider it does not open.
		const other = await app.providers.create(u.principal, { kind: "openai" });
		await app.db.owner(u.account.ownerId, (tx) => tx.query("UPDATE pim_app.providers SET secret = $2 WHERE id = $1", [other.id, stored.secret]));
		await expect(app.providers.reveal(u.account.ownerId, other.id)).rejects.toMatchObject({ name: "UnreadableError" });
		await app.providers.remove(u.principal, other.id);

		const rotated = new App(app.db, new MemoryObjectStore(), { crypto: new KeyringCrypto("k2", { k1: key(1), k2: key(2) }) });
		expect(await rotated.providers.rotateKeys(u.account.ownerId)).toBe(1);
		expect(await rotated.providers.reveal(u.account.ownerId, p.id)).toBe("sk-ant-secret-123");
		await expect(app.providers.reveal(u.account.ownerId, p.id)).rejects.toMatchObject({ name: "UnreadableError" }); // the old keyring no longer opens it

		await app.providers.setFallbacks(u.principal, [{ provider: p.id, id: "claude" }, { provider: "other", id: "m" }]);
		await app.providers.remove(u.principal, p.id);
		expect(await app.providers.fallbacks(u.principal)).toEqual([{ provider: "other", id: "m" }]);
		expect((await u.http("/api/model/fallbacks", { method: "PUT", body: body({ models: "nope" }) })).status).toBe(400);
	});
});

describe("usage", () => {
	it("records chat, background and coding-thread calls once and aggregates them", async () => {
		const u = await mk("usagey");
		const o = u.account.ownerId;
		const at = new Date();
		await app.usage.record(o, { id: "c1", runKind: "chat", provider: "openai", model: "gpt", inputTokens: 100, outputTokens: 50, costMicroUsd: 3000, at });
		await app.usage.record(o, { id: "c2", runKind: "background", provider: "openai", model: "mini", inputTokens: 10, outputTokens: 5, costMicroUsd: 100, at });
		await app.usage.record(o, { id: "c3", runKind: "coding_thread", provider: "anthropic", model: "claude", inputTokens: 1000, outputTokens: 500, costMicroUsd: 90_000, at });
		expect(await app.usage.record(o, { id: "c3", runKind: "coding_thread", inputTokens: 1000, outputTokens: 500, costMicroUsd: 90_000 })).toBe(false); // redelivered
		await app.usage.record(o, { id: "old", runKind: "chat", inputTokens: 1, outputTokens: 1, costMicroUsd: 7, at: new Date(Date.now() - 40 * 86_400_000) });
		await expect(app.usage.record(o, { id: "bad", runKind: "chat", inputTokens: -1, outputTokens: 0, costMicroUsd: 0 })).rejects.toMatchObject({ status: 400 });
		const r = (await (await u.http("/api/usage/costs?days=30")).json()) as any;
		expect(r.total).toEqual({ calls: 3, inputTokens: 1110, outputTokens: 555, costMicroUsd: 93_100 });
		expect(r.byRunKind.map((k: any) => [k.key, k.costMicroUsd])).toEqual([["background", 100], ["chat", 3000], ["coding_thread", 90_000]]);
		expect(r.byDay).toHaveLength(1);
		expect(((await (await u.http("/api/usage/costs?days=60")).json()) as any).total.calls).toBe(4);
		// One tenant never sees another's calls.
		expect(((await (await (await mk("usagey2")).http("/api/usage/costs")).json()) as any).total.calls).toBe(0);
	});
});

describe("connectors", () => {
	const spec = (agentId: string, connectorId: string, event: string) => ({ version: 1, owningAgentId: agentId, originChatId: "api", label: "On event", instruction: "handle it", source: { kind: "connector_event", connectorId, event, arguments: {} }, condition: null, destination: { type: "new_chat" }, delivery: {}, authorizationRef: null });

	it("keeps discovered tools off until enabled, and fires triggers from signed webhooks once per delivery", async () => {
		const u = await mk("conn");
		const o = u.account.ownerId;
		const agent = await app.agents.create(u.principal, { name: "Watcher" });
		const { connector, eventSecret } = await app.connectors.create(u.principal, { kind: "custom_mcp", name: "Linear", url: "https://mcp.example.com/mcp", credential: "tok-123" });
		expect(connector).toMatchObject({ status: "connected", hasCredential: true, discoveredTools: [], enabledTools: [] });
		const stored = await app.db.owner(o, async (tx) => (await tx.query("SELECT credential, event_secret FROM pim_app.connectors WHERE id = $1", [connector.id])).rows[0]);
		expect(stored.credential + stored.event_secret).not.toContain("tok-123");
		expect(stored.event_secret).not.toContain(eventSecret);
		expect(JSON.stringify(await app.connectors.list(u.principal))).not.toContain(eventSecret);

		// Discovery lands tools in discovered_tools only; nothing reaches an agent until it is enabled, and only a reported tool can be.
		const found = await app.connectors.discover(u.principal, connector.id);
		expect(found).toEqual({ discovered: 2, added: ["search", "delete_everything"] });
		expect((await app.connectors.get(u.principal, connector.id)).enabledTools).toEqual([]);
		await expect(app.connectors.setEnabledTools(u.principal, connector.id, ["made_up"])).rejects.toMatchObject({ status: 400 });
		expect(await app.connectors.setEnabledTools(u.principal, connector.id, ["search"])).toEqual(["search"]);
		expect(await app.connectors.recordDiscovery(o, connector.id, [{ name: "search" }, { name: "new_tool" }])).toMatchObject({ added: ["new_tool"] });
		expect((await app.connectors.get(u.principal, connector.id)).enabledTools).toEqual(["search"]); // the new tool is off

		const trigger = await app.triggers.create(u.principal, { spec: spec(agent.id, connector.id, "issue.created") });
		await app.triggers.setLifecycle(u.principal, trigger.id, "enabled");
		const payload = Buffer.from(JSON.stringify({ event: "issue.created", id: 7 }));
		const sign = (b: Buffer, s = eventSecret) => `sha256=${createHmac("sha256", s).update(b).digest("hex")}`;
		const path = connector.eventsPath;
		const send = (b: Buffer, sig: string, delivery?: string) => fetch(base + path, { method: "POST", headers: { "x-pim-signature": sig, ...(delivery ? { "x-pim-delivery": delivery } : {}) }, body: b });
		expect((await send(payload, sign(payload, "wrong"))).status).toBe(401);
		expect((await send(payload, "")).status).toBe(401);
		expect((await fetch(base + `/mcp/events/${o}/not-the-key`, { method: "POST", body: payload })).status).toBe(401);
		expect((await fetch(base + `/mcp/events/${(await mk("conn-other")).account.ownerId}/${path.split("/").pop()}`, { method: "POST", headers: { "x-pim-signature": sign(payload) }, body: payload })).status).toBe(401); // another owner's path
		const first = await send(payload, sign(payload), "d-1");
		expect([first.status, await first.json()]).toEqual([202, { accepted: true, fired: 1 }]);
		expect(await (await send(payload, sign(payload), "d-1")).json()).toEqual({ accepted: true, fired: 0 }); // the same delivery
		expect(await (await send(Buffer.from(JSON.stringify({ event: "other" })), sign(Buffer.from(JSON.stringify({ event: "other" }))), "d-2")).json()).toEqual({ accepted: true, fired: 0 }); // nothing watches it
		const runs = await app.triggers.runs(u.principal, trigger.id);
		expect(runs.map((r) => r.phase)).toEqual(["fired"]);
		const fire = await app.db.owner(o, async (tx) => (await tx.query("SELECT kind, payload FROM pim_app.accepted_commands WHERE kind = 'trigger_fire'")).rows);
		expect(fire).toHaveLength(1);
		expect(fire[0].payload).toMatchObject({ text: expect.stringContaining("[Connector event] issue.created\nhandle it"), trigger: trigger.id });

		// A watch's delivery fires only the trigger of its own subscription, and a trigger's condition decides whether an event fires it.
		const second = await app.triggers.create(u.principal, { spec: { ...spec(agent.id, connector.id, "issue.created"), label: "Other repo" } });
		await app.triggers.setLifecycle(u.principal, second.id, "enabled");
		expect(await app.triggers.fireConnectorEvent(o, connector.id, "issue.created", { id: 8 }, "w-1", trigger.id)).toBe(1);
		expect((await app.triggers.runs(u.principal, second.id)).length).toBe(0);
		const filtered = await app.triggers.create(u.principal, { spec: { ...spec(agent.id, connector.id, "issue.filtered"), condition: { when: { op: "compare", path: ["priority"], cmp: "gt", value: 2 } } } });
		await app.triggers.setLifecycle(u.principal, filtered.id, "enabled");
		expect(await app.triggers.fireConnectorEvent(o, connector.id, "issue.filtered", { priority: 1 }, "f-1")).toBe(0);
		expect(await app.triggers.fireConnectorEvent(o, connector.id, "issue.filtered", { priority: 3 }, "f-2")).toBe(1);
		expect((await app.triggers.runs(u.principal, filtered.id)).length).toBe(1);
		await app.triggers.setLifecycle(u.principal, second.id, "paused");
		await app.triggers.setLifecycle(u.principal, filtered.id, "paused");

		// A paused trigger and a suspended owner receive nothing.
		await app.triggers.setLifecycle(u.principal, trigger.id, "paused");
		expect(((await (await send(payload, sign(payload), "d-3")).json()) as { fired: number }).fired).toBe(0);
		await app.identity.setStatus(admin.principal, o, "suspended");
		expect((await send(payload, sign(payload), "d-4")).status).toBe(403);
	});

	it("refuses a custom connector over plain http, and finishes a sign-in only with its state and a configured exchange", async () => {
		const u = await mk("conn2");
		await expect(app.connectors.create(u.principal, { kind: "custom_mcp", name: "Bad", url: "http://evil.example/mcp" })).rejects.toMatchObject({ status: 400 });
		const { connector } = await app.connectors.create(u.principal, { kind: "native", name: "Gmail" });
		const { state } = await app.connectors.beginAuth(u.principal, connector.id);
		expect((await app.connectors.get(u.principal, connector.id)).status).toBe("auth_required");
		const res = await fetch(`${base}/mcp/callback/${u.account.ownerId}?state=${state}&code=abc`, { redirect: "manual" });
		expect(res.status).toBe(501); // this deployment has no MCP OAuth client
		expect((await fetch(`${base}/mcp/callback/${u.account.ownerId}?state=bogus&code=abc`, { redirect: "manual" })).status).toBe(400);
		const wired = new App(app.db, new MemoryObjectStore(), { crypto, exchange: async (_c, code) => `cred-for-${code}` });
		const again = await wired.connectors.beginAuth(u.principal, connector.id);
		await wired.connectors.finishAuth(u.account.ownerId, again.state, "abc");
		expect(await wired.connectors.get(u.principal, connector.id)).toMatchObject({ status: "connected", hasCredential: true });
		await expect(wired.connectors.finishAuth(u.account.ownerId, again.state, "abc")).rejects.toMatchObject({ status: 400 }); // the state answers once
	});
});

describe("API clients on another site", () => {
	it("answers a preflight for /api with the allowed methods and headers, and marks API answers open to any origin, but not other paths", async () => {
		const pre = await fetch(`${base}/api/triggers/x`, { method: "OPTIONS", headers: { origin: "https://client.example", "access-control-request-method": "PATCH" } });
		expect(pre.status).toBe(204);
		expect(pre.headers.get("access-control-allow-origin")).toBe("*");
		expect(pre.headers.get("access-control-allow-methods")).toContain("PATCH");
		expect(pre.headers.get("access-control-allow-headers")).toMatch(/Authorization.*If-Match/);
		const got = await fetch(`${base}/api/account`);
		expect(got.status).toBe(401);
		expect(got.headers.get("access-control-allow-origin")).toBe("*");
		expect((await fetch(`${base}/health`)).headers.get("access-control-allow-origin")).toBeNull();
	});
});

describe("triggers", () => {
	const cron = (agentId: string, expression = "0 * * * *") => ({ version: 1, owningAgentId: agentId, originChatId: "api", label: "Hourly", instruction: "check in", source: { kind: "time", schedule: "cron", expression, timeZone: "UTC" }, condition: null, destination: { type: "new_chat" }, delivery: {}, authorizationRef: null });

	it("dry-runs a trigger before it exists: what blocks it, and what its condition says of each sample", async () => {
		const u = await mk("dry");
		const agent = await app.agents.create(u.principal, { name: "Watcher" });
		const poll = { ...cron(agent.id), source: { kind: "poll", command: "price-check", intervalMs: 300_000 }, condition: { when: { op: "compare", path: ["price"], cmp: "lt", value: 500 } } };
		const run = (await app.triggers.test(u.principal, null, { spec: poll, samples: [{ value: { price: 600 } }, { value: { price: 400 } }, { value: { price: 300 } }, { value: { other: 1 } }] })) as any;
		expect(run).toMatchObject({ dryRun: true, valid: true, sourceKind: "poll", blockers: ["grant_required"], grant: { required: true, state: "missing" } });
		// It fires when the price falls below 500, not again while it stays there, and a sample without the field reads as such.
		expect(run.evaluations.map((e: any) => [e.truth, e.fires])).toEqual([["false", false], ["true", true], ["true", false], ["unknown", false]]);
		expect(run.evaluations[3].fields).toEqual([{ path: ["price"], present: false }]);
		expect(JSON.stringify(run)).not.toContain("600");
		await expect(app.triggers.test(u.principal, null, { spec: { ...poll, version: 9 } })).rejects.toMatchObject({ status: 400 });
		await expect(app.triggers.test(u.principal, null, {})).rejects.toMatchObject({ status: 400 });
		await expect(app.triggers.test(u.principal, null, { spec: cron(agent.id), samples: [{ value: 1 }] })).rejects.toMatchObject({ status: 400 });
		expect(await app.db.owner(u.account.ownerId, (tx) => tx.query("SELECT count(*)::int AS n FROM pim_app.triggers"))).toMatchObject({ rows: [{ n: 0 }] });
	});

	it("moves through its lifecycle, previews firings, and fires only the latest due occurrence after downtime", async () => {
		const u = await mk("trig");
		const o = u.account.ownerId;
		const agent = await app.agents.create(u.principal, { name: "Clock" });
		await expect(app.triggers.create(u.principal, { spec: { ...cron(agent.id), version: 9 } })).rejects.toMatchObject({ status: 400 });
		const t = await app.triggers.create(u.principal, { spec: cron(agent.id) });
		expect(t.lifecycle).toBe("draft");
		const preview = (await app.triggers.test(u.principal, t.id, { now: Date.parse("2026-11-16T00:30:00Z"), count: 3 })) as any;
		expect(preview.firings.map((f: any) => f.local.slice(11, 16))).toEqual(["01:00", "02:00", "03:00"]);
		await expect(app.triggers.setLifecycle(u.principal, t.id, "paused")).rejects.toMatchObject({ code: "bad_trigger_transition" });
		const enabledAt = new Date("2026-11-16T00:00:00Z");
		await app.triggers.setLifecycle(u.principal, t.id, "enabled", enabledAt);
		// Ten hours of downtime: only the 10:00 occurrence is selected, once, and nothing replays the nine before it.
		const back = new Date("2026-11-16T10:01:00Z");
		const results = await Promise.all([app.triggers.tickTime(o, back), app.triggers.tickTime(o, back)]);
		expect(results.reduce((n, r) => n + r.fired, 0)).toBe(1);
		const runs = await app.triggers.runs(u.principal, t.id);
		expect(runs.map((r) => r.phase)).toEqual(["fired"]);
		expect(runs[0]!.detail).toMatchObject({ scheduledFor: Date.parse("2026-11-16T10:00:00Z") });
		expect(await app.triggers.tickTime(o, new Date(back.getTime() + 1000))).toEqual({ fired: 0, missed: 0 });
		// A one-time trigger whose moment passed beyond its lateness is recorded as missed, never run, and ends.
		const once = await app.triggers.create(u.principal, { spec: { ...cron(agent.id), source: { kind: "time", schedule: "once", at: Date.parse("2026-11-16T11:00:00Z"), maxLatenessMs: 600_000 } } });
		await app.triggers.setLifecycle(u.principal, once.id, "enabled", new Date("2026-11-16T10:30:00Z"));
		expect(await app.triggers.tickTime(o, new Date("2026-11-16T12:00:00Z"))).toMatchObject({ missed: 1 });
		expect((await app.triggers.runs(u.principal, once.id)).map((r) => [r.phase, r.detail.reason])).toEqual([["skipped", "missed"]]);
		expect((await app.triggers.get(u.principal, once.id)).lifecycle).toBe("ended");
		await app.triggers.setLifecycle(u.principal, t.id, "paused");
		await app.triggers.setLifecycle(u.principal, t.id, "ended");
		await expect(app.triggers.setLifecycle(u.principal, t.id, "enabled")).rejects.toMatchObject({ code: "bad_trigger_transition" });
		await app.triggers.setLifecycle(u.principal, t.id, "deleted");
		expect((await app.triggers.list(u.principal)).find((x) => x.id === t.id)).toBeUndefined();
		await expect(app.triggers.runs(u.principal, t.id)).rejects.toMatchObject({ status: 404 });
	});

	it("runs a trigger one turn at a time, holds at most maxPendingEvents firings behind it, drops the rest, and makes a trigger once for one Idempotency key", async () => {
		const u = await mk("trigq");
		const agent = await app.agents.create(u.principal, { name: "Queue" });
		const spec = { version: 1, owningAgentId: agent.id, originChatId: "api", label: "Events", instruction: "look", source: { kind: "connector_event", connectorId: "c1", event: "ticket", arguments: {} }, condition: null, destination: { type: "new_chat" }, delivery: { maxPendingEvents: 1 }, authorizationRef: null };
		const t = await app.triggers.create(u.principal, { spec, key: "k1" });
		expect((await app.triggers.create(u.principal, { spec, key: "k1" })).id).toBe(t.id); // the same key and request: the trigger made the first time
		await expect(app.triggers.create(u.principal, { spec: { ...spec, label: "Other" }, key: "k1" })).rejects.toMatchObject({ code: "idempotency_conflict" });
		await app.triggers.setLifecycle(u.principal, t.id, "enabled");
		// A trigger runs one turn at a time: the first firing starts one, the second waits behind it (what may wait is `maxPendingEvents`), and the third finds no room and is recorded as skipped, with no chat made for it.
		const fired = [];
		for (const n of [1, 2, 3, 3]) fired.push(await app.triggers.fireOccurrence(u.account.ownerId, t.id, `e${n}`, { event: "ticket" }));
		expect(fired).toEqual(["fired", "queued", "full", "full"]);
		const runs = await app.triggers.runs(u.principal, t.id);
		expect(runs.map((r) => [r.id.split(":").at(-1), r.phase, r.detail.reason ?? null]).sort()).toEqual([["e1", "fired", null], ["e2", "pending", null]]);
		expect((await app.db.owner(u.account.ownerId, (tx) => tx.query("SELECT count(*)::int AS n FROM pim_app.conversations WHERE kind = 'trigger'"))).rows[0]!.n).toBe(1);
	});

	it("does not replay a pause when a time trigger is resumed, and says in its firing that it is a trigger, when it was due and what was missed", async () => {
		const u = await mk("trigpause");
		const o = u.account.ownerId;
		const agent = await app.agents.create(u.principal, { name: "Pauser" });
		const t = await app.triggers.create(u.principal, { spec: cron(agent.id) });
		await app.triggers.setLifecycle(u.principal, t.id, "enabled", new Date("2026-11-16T00:00:00Z"));
		await app.triggers.setLifecycle(u.principal, t.id, "paused", new Date("2026-11-16T00:30:00Z"));
		// Resumed at 10:30: the 01:00 to 10:00 firings fell during the pause and none of them runs, though 10:00 is within its catch-up.
		await app.triggers.setLifecycle(u.principal, t.id, "enabled", new Date("2026-11-16T10:30:00Z"));
		expect(await app.triggers.tickTime(o, new Date("2026-11-16T10:31:00Z"))).toEqual({ fired: 0, missed: 0 });
		expect(await app.triggers.tickTime(o, new Date("2026-11-16T11:01:00Z"))).toEqual({ fired: 1, missed: 0 });
		const fire = await app.db.owner(o, async (tx) => (await tx.query("SELECT payload FROM pim_app.accepted_commands WHERE kind = 'trigger_fire' AND payload->>'trigger' = $1", [t.id])).rows);
		expect(fire).toHaveLength(1);
		expect(fire[0].payload.text).toBe(`[Trigger "Hourly" ${t.id}] check in\n\n(Due at 2026-11-16T11:00:00.000Z (UTC).)`);
	});

	it("loses a source's place when its source is edited, and ends a process watch when it expires", async () => {
		const u = await mk("trigreset");
		const o = u.account.ownerId;
		const agent = await app.agents.create(u.principal, { name: "Resetter" });
		const poll = { ...cron(agent.id), source: { kind: "poll", command: "price-check", intervalMs: 300_000 }, condition: { when: { op: "compare", path: ["price"], cmp: "lt", value: 500 } } };
		const t = await app.triggers.create(u.principal, { spec: poll });
		const state = async () => (await app.db.owner(o, async (tx) => (await tx.query("SELECT checkpoint, last_observed_at FROM pim_app.triggers WHERE id = $1", [t.id])).rows[0])) as { checkpoint: unknown; last_observed_at: Date | null };
		const remember = () => app.db.owner(o, (tx) => tx.query("UPDATE pim_app.triggers SET checkpoint = '{\"position\":4,\"cursor\":null}', last_observed_at = now() WHERE id = $1", [t.id]));
		await remember();
		// A changed threshold keeps the source's place; a changed command loses it.
		await app.triggers.update(u.principal, t.id, { spec: { ...poll, condition: { when: { op: "compare", path: ["price"], cmp: "lt", value: 400 } } } });
		expect(await state()).toMatchObject({ checkpoint: { position: 4 } });
		await remember();
		await app.triggers.update(u.principal, t.id, { spec: { ...poll, source: { ...poll.source, command: "other-check" } } });
		expect(await state()).toEqual({ checkpoint: null, last_observed_at: null });

		const watch = { ...cron(agent.id), label: "Build", source: { kind: "process", handle: "h-4242", expiresAt: Date.now() + 3_600_000 } };
		const p = await app.triggers.create(u.principal, { spec: watch });
		await app.db.owner(o, (tx) => tx.query("UPDATE pim_app.triggers SET lifecycle = 'enabled', enabled = true WHERE id = $1", [p.id]));
		await app.triggers.tickTime(o, new Date(Date.now() + 1_000_000));
		expect((await app.triggers.get(u.principal, p.id)).lifecycle).toBe("enabled");
		await app.triggers.tickTime(o, new Date(Date.now() + 4 * 3_600_000));
		expect((await app.triggers.get(u.principal, p.id)).lifecycle).toBe("ended");
		expect((await app.triggers.runs(u.principal, p.id)).map((r) => [r.phase, r.detail.reason])).toEqual([["skipped", "expired"]]);
	});

	it("needs a computer grant for a computer trigger, and a paired computer for the grant", async () => {
		const u = await mk("trigc");
		const agent = await app.agents.create(u.principal, { name: "Watcher" });
		const file = { version: 1, owningAgentId: agent.id, originChatId: "api", label: "Watch", instruction: "look", source: { kind: "file", path: "/home/me/notes.md", events: ["modified"], recursive: false }, condition: null, destination: { type: "new_chat" }, delivery: {}, authorizationRef: null };
		// Nothing observes files yet: it is a draft until something does, however it is granted.
		await expect(app.triggers.setLifecycle(u.principal, (await app.triggers.create(u.principal, { spec: file })).id, "enabled")).rejects.toMatchObject({ code: "source_not_wired" });
		const watch = { ...file, source: { kind: "stream", command: "tail -f /home/me/notes.md" } };
		const t = await app.triggers.create(u.principal, { spec: watch });
		await expect(app.triggers.setLifecycle(u.principal, t.id, "enabled")).rejects.toMatchObject({ name: "CapabilityUnavailableError" }); // no grant
		await expect(app.triggers.grantComputer(u.principal, t.id, "pc_none")).rejects.toMatchObject({ name: "CapabilityUnavailableError" }); // nothing paired
		const pair = await app.relay.pair(u.principal, "laptop", 2);
		await app.triggers.grantComputer(u.principal, t.id, pair.computerId);
		expect((await app.triggers.setLifecycle(u.principal, t.id, "enabled")).lifecycle).toBe("enabled");
		await app.triggers.revokeComputer(u.principal, t.id); // pulling the grant pauses it
		expect((await app.triggers.get(u.principal, t.id)).lifecycle).toBe("paused");
		// A guest may not make computer triggers at all.
		await app.identity.setRole(admin.principal, u.account.ownerId, "guest");
		await expect(app.triggers.create(u.principal, { spec: file })).rejects.toMatchObject({ reason: "guest" });
	});
});

describe("apps", () => {
	const page = (t: string) => `<!doctype html><title>${t}</title><p>${t}</p>`;

	it("names the base version on every write, keeps every version, and restores by adding one", async () => {
		const u = await mk("appy");
		const ref = await app.apps.create(u.principal, { title: "Todo", kind: "html", files: { "index.html": page("one"), "app.js": "let x = 1" } });
		expect(ref).toMatchObject({ kind: "html", version: 1 });
		await expect(app.apps.create(u.principal, { title: "Bad", kind: "html", files: { "app.js": "x" } })).rejects.toMatchObject({ status: 400 });
		const v2 = await app.apps.update(u.principal, ref.id, { baseVersion: 1, edits: [{ find: "<p>one</p>", replace: "<p>two</p>" }] });
		expect([v2.version, v2.changed]).toEqual([2, true]);
		await expect(app.apps.update(u.principal, ref.id, { baseVersion: 1, files: { "index.html": page("stale") }, title: "Changed" })).rejects.toMatchObject({ code: "version_conflict" });
		expect((await app.apps.read(u.principal, ref.id)).content).toContain("two");
		await expect(app.apps.update(u.principal, ref.id, { baseVersion: 2, edits: [{ find: "<p>", replace: "x" }, { find: "nothing", replace: "y" }] })).rejects.toMatchObject({ status: 400 });
		expect(await app.apps.update(u.principal, ref.id, { baseVersion: 2, files: { "index.html": v2 && (await app.apps.read(u.principal, ref.id)).content } })).toMatchObject({ changed: false, version: 2 }); // the same files make no version
		const restored = await app.apps.restore(u.principal, ref.id, 1);
		expect([restored.version, (await app.apps.read(u.principal, ref.id)).content]).toEqual([3, page("one")]);
		expect((await app.apps.versions(u.principal, ref.id)).map((v) => v.version)).toEqual([1, 2, 3]);
		expect((await app.apps.list(u.principal, "todo"))[0]).toMatchObject({ id: ref.id, version: 3, files: 2 });
		expect((await app.apps.list(u.principal, "missing"))).toEqual([]);
		const big = await app.apps.read(u.principal, ref.id, { path: "app.js", offset: 4 });
		expect(big).toMatchObject({ content: "x = 1", files: ["app.js", "index.html"] });
	});

	it("validates a backend app's manifest, and refuses to publish it", async () => {
		const u = await mk("backy");
		const files = (m: unknown) => ({ "pim.app.json": JSON.stringify(m), "server.js": "x" });
		await expect(app.apps.create(u.principal, { title: "B", kind: "backend", files: files({ backend: { command: "node server.js" }, env: {} }) })).rejects.toMatchObject({ message: expect.stringContaining('no "env"') });
		await expect(app.apps.create(u.principal, { title: "B", kind: "backend", files: files({ backend: { command: "node server.js", port: 1 } }) })).rejects.toMatchObject({ message: expect.stringContaining('"port"') });
		await expect(app.apps.create(u.principal, { title: "B", kind: "backend", files: files({ backend: { command: "x" }, access: "everyone" }) })).rejects.toMatchObject({ status: 400 });
		const ref = await app.apps.create(u.principal, { title: "B", kind: "hosted", files: files({ backend: { command: "node server.js", install: "npm ci" }, access: "public" }) });
		expect(ref.kind).toBe("backend");
		await expect(app.apps.publish(u.principal, ref.id)).rejects.toMatchObject({ status: 400 });
	});

	it("serves a published version at /p/pa_… to anyone, without ?token=, until unpublished, and 410 once the author is deleted", async () => {
		const u = await mk("pubby");
		const ref = await app.apps.create(u.principal, { title: "Hello", kind: "html", files: { "index.html": page("hello"), "style.css": "p{color:red}" } });
		// Publishing puts it in the gallery of everyone signed in; the link for anyone is a choice of its own, and publishing again keeps the id.
		const { publicId, public: open } = await app.apps.publish(u.principal, ref.id);
		expect(publicId).toMatch(/^pa_/);
		expect(open).toBe(false);
		expect((await fetch(`${base}/p/${publicId}`)).status).toBe(404);
		expect(((await (await u.http("/api/published-artifacts")).json()) as any).published.map((p: any) => p.id)).toContain(publicId);
		expect(await app.apps.publish(u.principal, ref.id, { public: true })).toEqual({ publicId, version: 1, public: true });
		expect(await app.apps.publish(u.principal, ref.id)).toMatchObject({ publicId, public: true }); // left out: as it was
		expect(await app.apps.publish(u.principal, ref.id, { public: false })).toMatchObject({ publicId, public: false });
		expect((await fetch(`${base}/p/${publicId}`)).status).toBe(404);
		await app.apps.publish(u.principal, ref.id, { public: true });
		await app.apps.update(u.principal, ref.id, { baseVersion: 1, edits: [{ find: "hello</p>", replace: "changed</p>" }] });
		const res = await fetch(`${base}/p/${publicId}`);
		expect(res.status).toBe(200);
		expect(await res.text()).toContain("hello</p>"); // pinned to the published version, not the latest
		expect(res.headers.get("content-security-policy")).toContain("connect-src 'none'");
		expect(res.headers.get("content-security-policy")).toContain("sandbox");
		expect(await (await fetch(`${base}/p/${publicId}/style.css`)).text()).toBe("p{color:red}");
		expect((await fetch(`${base}/p/${publicId}?token=${u.token}`)).status).toBe(200); // a token in the URL is ignored, never a credential here
		expect(((await (await u.http("/api/published-artifacts")).json()) as any).published.map((p: any) => p.id)).toContain(publicId);
		await app.apps.unpublish(u.principal, ref.id);
		expect((await fetch(`${base}/p/${publicId}`)).status).toBe(404);
		const again = (await app.apps.publish(u.principal, ref.id, { public: true })).publicId;
		await app.identity.setStatus(admin.principal, u.account.ownerId, "suspended");
		expect((await fetch(`${base}/p/${again}`)).status).toBe(200); // the deliberate separation of publishing from the account
		await app.identity.setStatus(admin.principal, u.account.ownerId, "deleted");
		expect((await fetch(`${base}/p/${again}`)).status).toBe(410);
	});

	it("publishes up to 20 apps, and keeps drawings, diagrams and binary files whole", async () => {
		const u = await mk("pubcap");
		const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==", "base64");
		const html = await app.apps.create(u.principal, { title: "Pic", kind: "html", files: { "index.html": '<!doctype html><img src="dot.png">', "dot.png": binaryValue(png) } });
		expect((await app.apps.read(u.principal, html.id, { path: "dot.png" })).content).toBe(`(binary file, ${png.length} bytes, image/png)`);
		expect(html.size).toBeGreaterThan(png.length);
		await expect(app.apps.update(u.principal, html.id, { baseVersion: 1, edits: [{ path: "dot.png", find: "a", replace: "b" }] })).rejects.toMatchObject({ status: 400 });
		await expect(app.apps.create(u.principal, { title: "Big", kind: "html", files: { "index.html": "<p>x</p>", "big.bin": binaryValue(Buffer.alloc(10_000_001)) } })).rejects.toMatchObject({ status: 400 });
		const svg = await app.apps.create(u.principal, { title: "Drawing", kind: "svg", files: { "image.svg": '<svg xmlns="http://www.w3.org/2000/svg"></svg>' } });
		const diagram = await app.apps.create(u.principal, { title: "Flow", kind: "mermaid", files: { "diagram.mmd": "graph TD; A-->B" } });
		await expect(app.apps.create(u.principal, { title: "Not a drawing", kind: "svg", files: { "image.svg": "<p>no</p>" } })).rejects.toMatchObject({ status: 400 });
		expect((await app.apps.list(u.principal)).map((a) => a.kind).sort()).toEqual(["html", "mermaid", "svg"]);
		expect(svg.kind).toBe("svg");
		expect(diagram.kind).toBe("mermaid");
		const published = [];
		for (let n = 0; n < 20; n++) published.push((await app.apps.publish(u.principal, (await app.apps.create(u.principal, { title: `A${n}`, kind: "html", files: { "index.html": `<p>${n}</p>` } })).id)).publicId);
		const extra = await app.apps.create(u.principal, { title: "One more", kind: "html", files: { "index.html": "<p>x</p>" } });
		await expect(app.apps.publish(u.principal, extra.id)).rejects.toMatchObject({ status: 429, message: "You can publish up to 20 apps." });
		await app.apps.unpublish(u.principal, (await app.apps.list(u.principal)).find((a) => a.title === "A0")!.id);
		await app.apps.publish(u.principal, extra.id); // a place is free again
		expect(published).toHaveLength(20);
	});
});

describe("circles, sharing and people", () => {
	it("shares an app read-only with a circle's members, and stops at their next look when they leave", async () => {
		const owner = await mk("sharer");
		const friend = await mk("friend");
		const stranger = await mk("stranger");
		const ref = await app.apps.create(owner.principal, { title: "Shared", kind: "html", files: { "index.html": "<p>hi</p>" } });
		const circle = await app.sharing.createCircle(owner.principal, "Friends");
		await expect(app.sharing.addMember(owner.principal, circle.id, "nobody-here")).rejects.toMatchObject({ status: 404 });
		await app.sharing.addMember(owner.principal, circle.id, "friend");
		await app.apps.setAccess(owner.principal, ref.id, "circles", [circle.id]);
		const read = (p: Principal) => app.sharing.sharedApp(p, owner.account.ownerId, ref.id);
		expect(await read(friend.principal)).toMatchObject({ title: "Shared", version: 1, files: { "index.html": "<p>hi</p>" } });
		await expect(read(stranger.principal)).rejects.toMatchObject({ status: 404 });
		expect((await app.sharing.activity(friend.principal)).map((a) => a.id)).toContain(ref.id);
		expect((await app.sharing.activity(stranger.principal)).map((a) => a.id)).not.toContain(ref.id);
		// Read only: a member cannot change what is shared with them, even by id.
		await expect(app.apps.update(friend.principal, ref.id, { baseVersion: 1, files: { "index.html": "<p>x</p>" } })).rejects.toMatchObject({ status: 404 });
		expect((await app.sharing.circles(friend.principal))[0]).toMatchObject({ name: "Friends", members: undefined, mine: false }); // members hidden from members
		// A guest cannot open shared apps, and cannot be added.
		const guest = await mk("guesty");
		await app.identity.setRole(admin.principal, guest.account.ownerId, "guest");
		await expect(app.sharing.addMember(owner.principal, circle.id, "guesty")).rejects.toMatchObject({ code: "guest" });

		await app.sharing.removeMember(owner.principal, circle.id, friend.account.ownerId);
		await expect(read(friend.principal)).rejects.toMatchObject({ status: 404 });
		await app.sharing.addMember(owner.principal, circle.id, "friend");
		await app.sharing.deleteCircle(owner.principal, circle.id);
		await expect(read(friend.principal)).rejects.toMatchObject({ status: 404 });
		expect((await app.apps.list(owner.principal))[0]!.access).toBe("private");
	});

	it("shares a copy of a chat by an unguessable link that stays as it was until updated, hides it again, and 410s for a deleted author", async () => {
		const u = await mk("chatter");
		const chat = await app.conversations.create(u.principal, { title: "Plans" });
		type Link = { id: string; url: string; sharedAt: number; messages: number };
		const put = async () => ((await (await u.http(`/api/sessions/${chat}/link`, { method: "PUT" })).json()) as { link: Link }).link;
		const link = await put();
		expect(link).toMatchObject({ url: `${base}/shared/${u.account.ownerId}/${link.id}`, sharedAt: expect.any(Number), messages: 1 });
		expect(((await (await u.http(`/api/sessions/${chat}/link`)).json()) as any).link).toEqual(link);
		const read = () => fetch(`${base}/api/shared/${u.account.ownerId}/${link.id}`);
		const shown = (await (await read()).json()) as any;
		expect(shown).toEqual({ title: "Plans", agent: { name: "Pim", symbol: null, color: null }, sharedAt: link.sharedAt, messages: [{ role: "user", text: `hello from ${chat}`, images: 1, at: 1 }] });
		expect((await read()).headers.get("x-robots-tag")).toBe("noindex");
		// Updating keeps the address and makes the copy again.
		const updated = await put();
		expect(updated.id).toBe(link.id);
		expect(updated.sharedAt).toBeGreaterThanOrEqual(link.sharedAt);
		expect((await fetch(`${base}/api/shared/${u.account.ownerId}/nope`)).status).toBe(404);
		expect((await fetch(`${base}/api/shared/${(await mk("chatter2")).account.ownerId}/${link.id}`)).status).toBe(404); // another owner's path
		expect(((await (await u.http(`/api/sessions/${chat}/link`, { method: "DELETE" })).json()) as any)).toEqual({ deleted: true });
		expect((await read()).status).toBe(404);
		expect(((await (await u.http(`/api/sessions/${chat}/link`)).json()) as any).link).toBeNull();
		const again = await put();
		await app.identity.setStatus(admin.principal, u.account.ownerId, "deleted");
		expect((await fetch(`${base}/api/shared/${u.account.ownerId}/${again.id}`)).status).toBe(410);
	});

	it("refuses a public link to an empty chat, and a link made before copies were kept shows nothing", async () => {
		const u = await mk("emptier");
		emptyChat = await app.conversations.create(u.principal, { title: "Nothing yet" });
		expect((await u.http(`/api/sessions/${emptyChat}/link`, { method: "PUT" })).status).toBe(409);
		const chat = await app.conversations.create(u.principal, { title: "Old" });
		await app.db.owner(u.account.ownerId, (tx) => tx.query("INSERT INTO pim_app.shares (id, owner_id, kind, resource_id, audience, link) VALUES ('sh_old', $1, 'chat', $2, 'link', 'oldlink')", [u.account.ownerId, chat]));
		expect((await fetch(`${base}/api/shared/${u.account.ownerId}/oldlink`)).status).toBe(404);
		expect(((await (await u.http(`/api/sessions/${chat}/link`)).json()) as any).link).toBeNull();
		expect(((await (await u.http(`/api/sessions/${chat}/link`, { method: "PUT" })).json()) as any).link.id).toBe("oldlink");
	});

	it("lets an operator take a published agent down, and no one else", async () => {
		const author = await mk("takedown");
		const agent = await app.agents.create(author.principal, { name: "Spammy", instructions: "advertise" });
		const { id } = await app.sharing.publishTemplate(author.principal, agent.id, "Spammy kit");
		await expect(app.sharing.removeTemplate(author.principal, id)).rejects.toMatchObject({ reason: "admin-only" });
		expect((await app.sharing.templates(admin.principal)).some((t) => t.id === id)).toBe(true);
		await app.sharing.removeTemplate(admin.principal, id);
		expect((await app.sharing.templates(admin.principal)).some((t) => t.id === id)).toBe(false);
		await expect(app.sharing.removeTemplate(admin.principal, id)).rejects.toMatchObject({ status: 404 });
	});

	it("shows a published profile with its templates and bots, visits a bot in the host's space, and hides what is unpublished or deleted", async () => {
		const host = await mk("hosty");
		const visitor = await mk("visitory");
		expect((await fetch(`${base}/api/people/hosty`)).status).toBe(404); // unpublished
		const agent = await app.agents.create(host.principal, { name: "Concierge", instructions: "greet" });
		await app.sharing.publishTemplate(host.principal, agent.id, "Concierge kit");
		const bot = await app.sharing.createBot(host.principal, agent.id, "Front desk");
		await host.http("/api/profile", { method: "PUT", body: body({ displayName: "Hosty", bio: "hello", published: true }) });
		const person = (await (await fetch(`${base}/api/people/hosty`)).json()) as any;
		expect(person).toMatchObject({ username: "hosty", displayName: "Hosty", templates: [{ title: "Concierge kit" }], bots: [{ name: "Front desk" }] });
		expect(((await (await fetch(`${base}/api/bots/${bot.id}`)).json()) as any)).toMatchObject({ name: "Front desk", owner: "hosty" });

		const v = (await (await visitor.http("/api/visits/hosty", { method: "POST", body: body({ bot: bot.id }) })).json()) as any;
		const hostChat = await app.conversations.get(host.account.ownerId, v.chatId);
		expect(hostChat).toMatchObject({ kind: "visit" });
		expect((await app.sharing.visits(host.principal))[0]).toMatchObject({ visitor: visitor.account.ownerId, botId: bot.id });
		expect((await visitor.http("/api/visits/hosty", { method: "POST", body: body({ bot: "bot_nope" }) })).status).toBe(404);
		expect((await app.sharing.templates(visitor.principal)).map((t) => t.title)).toContain("Concierge kit");
		await app.identity.setStatus(admin.principal, host.account.ownerId, "suspended");
		expect((await visitor.http("/api/visits/hosty", { method: "POST", body: body({ bot: bot.id }) })).status).toBe(403);
		await app.identity.setStatus(admin.principal, host.account.ownerId, "deleted");
		expect((await fetch(`${base}/api/people/hosty`)).status).toBe(404);
		expect((await fetch(`${base}/api/bots/${bot.id}`)).status).toBe(404);
		expect((await app.sharing.templates(visitor.principal)).map((t) => t.title)).not.toContain("Concierge kit");
	});
});

describe("export and deletion", () => {
	it("exports a person's own data without any secret", async () => {
		const u = await mk("exporty");
		await app.providers.create(u.principal, { kind: "openai", apiKey: "sk-export-secret" });
		await app.connectors.create(u.principal, { kind: "custom_mcp", name: "C", url: "https://c.example.com/mcp", credential: "cred-secret" });
		await app.memories.remember(u.principal, "everyone", "a memory", "body");
		await app.agents.create(u.principal, { name: "Exported" });
		await app.identity.createToken(u.principal as Principal, { name: "t", scopes: ["*"] });
		const circle = await app.sharing.createCircle(admin.principal, "Export friends");
		await app.sharing.addMember(admin.principal, circle.id, "exporty");
		const res = await u.http("/api/account/export");
		const text = await res.text();
		expect(res.headers.get("content-disposition")).toContain("pim-export.json");
		const data = JSON.parse(text);
		expect(data).toMatchObject({ account: { username: "exporty" }, memories: [{ title: "a memory" }], agents: [{ name: "Exported" }], connectors: [{ name: "C" }], providers: [{ kind: "openai" }] });
		// What the account holds beyond its chats: the sign-ins by name and use (never the secrets), and the spaces shared with it.
		expect(data).toMatchObject({ notes: [], files: [], notifications: [], appData: [], guestActivity: [], passkeys: [], identities: [], tokens: [{ name: "t", scopes: ["*"] }], sharedWithMe: [{ username: "boss", circle: "Export friends" }] });
		for (const secret of ["sk-export-secret", "cred-secret", "pimenc", "token_hash", "pims_", "event_secret", u.token]) expect(text).not.toContain(secret);
		expect((await u.http("/api/export")).status).toBe(200);
		// Another person's export holds none of this.
		expect(await (await (await mk("exporty2")).http("/api/export")).text()).not.toContain("a memory");
	});

	it("deletes an account: gone at once (410), purged on request, the username never reused, and the last admin refused", async () => {
		const u = await mk("leaver");
		const o = u.account.ownerId;
		const session = await app.identity.authenticate(u.token);
		await app.agents.create(u.principal, { name: "Doomed" });
		const chat = await app.conversations.create(u.principal, {});
		await app.conversations.admit(u.principal, { commandId: "leave-1", kind: "user_message", chatId: chat, payload: { text: "bye" } });
		await app.apps.create(u.principal, { title: "A", kind: "html", files: { "index.html": "<p>a</p>" } });
		const api = await app.identity.createToken(session, { name: "api", scopes: ["*"] });
		// An API token, even an unscoped one, cannot delete the account: that is session-only.
		const viaToken = await fetch(`${base}/api/account`, { method: "DELETE", headers: { authorization: `Bearer ${api.token}` } });
		expect(viaToken.status).toBe(403);
		// It asks the person to say whose account it is, as v1 did, and ends their session with it.
		expect((await u.http("/api/account", { method: "DELETE" })).status).toBe(400);
		expect((await u.http("/api/account", { method: "DELETE", body: body({ confirm: "someone-else" }) })).status).toBe(400);
		const gone = await u.http("/api/account", { method: "DELETE", body: body({ confirm: "leaver" }) });
		expect(gone.status).toBe(200);
		expect(await gone.json()).toEqual({ deleted: true });
		expect(gone.headers.get("set-cookie")).toMatch(/pim_session=; .*Max-Age=0/);
		expect((await u.http("/api/account")).status).toBe(401); // its sessions were revoked with it
		expect((await app.identity.authz.account(o))?.status).toBe("deleting");
		await expect(app.identity.authz.enforce(asSession(o), "api:read")).rejects.toMatchObject({ status: 410 });
		await expect(app.identity.purgeOwner(admin.account.ownerId)).rejects.toMatchObject({ code: "not_deleting" });
		const purged = await app.identity.purgeOwner(o);
		expect(purged.deleted).toBeGreaterThan(3);
		expect((await app.identity.authz.account(o))?.status).toBe("deleted");
		const left = await app.db.owner(o, async (tx) => (await tx.query("SELECT (SELECT count(*)::int FROM pim_app.agents) AS agents, (SELECT count(*)::int FROM pim_app.conversations) AS chats, (SELECT count(*)::int FROM pim_app.accepted_commands) AS commands, (SELECT count(*)::int FROM pim_app.artifacts) AS apps")).rows[0]);
		expect(left).toEqual({ agents: 0, chats: 0, commands: 0, apps: 0 });
		expect((await app.identity.purgeOwner(o)).deleted).toBe(0); // repeatable
		await expect(app.identity.register({ username: "leaver" })).rejects.toMatchObject({ code: "username_taken" });
		// The only admin cannot delete their account.
		await expect(app.identity.deleteSelf(admin.principal)).rejects.toMatchObject({ code: "last_admin" });
	});
});
void OwnerId;
