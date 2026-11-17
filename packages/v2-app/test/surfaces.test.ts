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
let admin: Awaited<ReturnType<typeof bootstrap>>;
let server: Server;
let base: string;
const key = (n: number) => new Uint8Array(32).fill(n);
let crypto = new KeyringCrypto("k1", { k1: key(1) });

beforeAll(async () => {
	urls = await freshDatabase();
	const fetchTools = async () => [{ name: "search", description: "Search" }, { name: "delete_everything" }];
	app = new App(connect(urls.appUrl, 8), new MemoryObjectStore(), { crypto, fetchTools, transcripts: { read: async (_o, chat) => [{ role: "user", text: `hello from ${chat}` }] } });
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

describe("triggers", () => {
	const cron = (agentId: string, expression = "0 * * * *") => ({ version: 1, owningAgentId: agentId, originChatId: "api", label: "Hourly", instruction: "check in", source: { kind: "time", schedule: "cron", expression, timeZone: "UTC" }, condition: null, destination: { type: "new_chat" }, delivery: {}, authorizationRef: null });

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

	it("needs a computer grant for a computer trigger, and a paired computer for the grant", async () => {
		const u = await mk("trigc");
		const agent = await app.agents.create(u.principal, { name: "Watcher" });
		const file = { version: 1, owningAgentId: agent.id, originChatId: "api", label: "Watch", instruction: "look", source: { kind: "file", path: "/home/me/notes.md", events: ["modified"], recursive: false }, condition: null, destination: { type: "new_chat" }, delivery: {}, authorizationRef: null };
		const t = await app.triggers.create(u.principal, { spec: file });
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
		const { publicId } = await app.apps.publish(u.principal, ref.id);
		expect(publicId).toMatch(/^pa_/);
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
		const again = (await app.apps.publish(u.principal, ref.id)).publicId;
		await app.identity.setStatus(admin.principal, u.account.ownerId, "suspended");
		expect((await fetch(`${base}/p/${again}`)).status).toBe(200); // the deliberate separation of publishing from the account
		await app.identity.setStatus(admin.principal, u.account.ownerId, "deleted");
		expect((await fetch(`${base}/p/${again}`)).status).toBe(410);
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

	it("shares a chat by an unguessable link, hides it again, and 410s for a deleted author", async () => {
		const u = await mk("chatter");
		const chat = await app.conversations.create(u.principal, { title: "Plans" });
		const { link } = (await (await u.http(`/api/sessions/${chat}/link`, { method: "PUT" })).json()) as { link: string };
		expect((((await (await u.http(`/api/sessions/${chat}/link`, { method: "PUT" })).json()) as any)).link).toBe(link); // stable
		const shown = (await (await fetch(`${base}/api/shared/${u.account.ownerId}/${link}`)).json()) as any;
		expect(shown).toMatchObject({ title: "Plans", author: "chatter", messages: [{ text: `hello from ${chat}` }] });
		expect((await fetch(`${base}/api/shared/${u.account.ownerId}/nope`)).status).toBe(404);
		expect((await fetch(`${base}/api/shared/${(await mk("chatter2")).account.ownerId}/${link}`)).status).toBe(404); // another owner's path
		await u.http(`/api/sessions/${chat}/link`, { method: "DELETE" });
		expect((await fetch(`${base}/api/shared/${u.account.ownerId}/${link}`)).status).toBe(404);
		const again = ((await (await u.http(`/api/sessions/${chat}/link`, { method: "PUT" })).json()) as any).link;
		await app.identity.setStatus(admin.principal, u.account.ownerId, "deleted");
		expect((await fetch(`${base}/api/shared/${u.account.ownerId}/${again}`)).status).toBe(410);
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
		const token = await app.identity.createToken(u.principal as Principal, { name: "t", scopes: ["*"] }).catch(() => null);
		void token;
		const res = await u.http("/api/account/export");
		const text = await res.text();
		expect(res.headers.get("content-disposition")).toContain("pim-export.json");
		const data = JSON.parse(text);
		expect(data).toMatchObject({ account: { username: "exporty" }, memories: [{ title: "a memory" }], agents: [{ name: "Exported" }], connectors: [{ name: "C" }], providers: [{ kind: "openai" }] });
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
		expect((await u.http("/api/account", { method: "DELETE" })).status).toBe(200);
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
