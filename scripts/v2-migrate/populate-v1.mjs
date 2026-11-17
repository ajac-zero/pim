#!/usr/bin/env node
// Fills a running v1 preview (`amp orb services ensure`, http://localhost:8787) with a realistic space through the real API paths, so the cutover can be rehearsed on data
// a real Worker wrote instead of a synthetic fixture. Two accounts (ada the admin, bob), chats with a fork and a chat cut off mid-tool, agents, skills with files and
// versions, memories, goals, scheduled tasks, notes, apps with versions, an uploaded image, a custom model provider with an API key, settings and a profile.
// Also what the admin shares and what credentials a space holds: a template, a bot, the agent everyone starts with, a provider shared with everyone, and (through the preview's
// `/__dev/seed-connections`, since a local Worker can reach neither OpenAI nor an https MCP server) a ChatGPT sign-in and a connected MCP server with its OAuth tokens.
// Writes the expectations (what v2 must show afterwards) to --expect.
// Usage: node scripts/v2-migrate/populate-v1.mjs [--base URL] [--expect FILE] [--provider-host HOST]
//   --provider-host  the host the stand-in providers are addressed by (default 127.0.0.1). Use the Docker gateway (172.18.0.1) when the destination's Runner is a container, so the
//                    imported providers and the MCP server are reachable from it without anyone editing a row.
import { createHash } from "node:crypto";
import { createServer } from "node:http";
import { writeFileSync } from "node:fs";
import { parseArgs } from "node:util";
import { Passkey } from "./passkey.mjs";

const { values } = parseArgs({ options: { base: { type: "string", default: "http://localhost:8787" }, expect: { type: "string", default: "v1-expectations.json" }, "probe-seconds": { type: "string", default: "0" }, "provider-host": { type: "string", default: "127.0.0.1" } } });
const BASE = values.base;
const log = (...a) => console.log("[populate]", ...a);

class Client {
	constructor(name) {
		this.name = name;
		this.cookie = "";
	}
	async signIn() {
		const r = await fetch(`${BASE}/__dev/sign-in/${this.name}?returnTo=/`, { redirect: "manual" });
		this.cookie = r.headers.getSetCookie().map((c) => c.split(";")[0]).filter((c) => !c.endsWith("=")).join("; ");
		if (!this.cookie) throw new Error(`sign-in of ${this.name} gave no cookie (${r.status})`);
		return this;
	}
	async call(method, path, body) {
		const r = await fetch(`${BASE}/api${path}`, { method, headers: { cookie: this.cookie, origin: BASE, "content-type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) });
		const text = await r.text();
		let json;
		try {
			json = JSON.parse(text);
		} catch {
			json = text;
		}
		if (!r.ok) throw new Error(`${method} ${path} -> ${r.status} ${text.slice(0, 300)}`);
		return json;
	}
	/** A call to the sign-in Worker's own routes (`/auth/...`), which are not under /api; returns the response and keeps its cookies. */
	async auth(path, body) {
		const r = await fetch(`${BASE}/auth${path}`, { method: "POST", headers: { cookie: this.cookie, origin: BASE, "content-type": "application/json" }, body: JSON.stringify(body ?? {}) });
		const text = await r.text();
		if (!r.ok) throw new Error(`POST /auth${path} -> ${r.status} ${text.slice(0, 200)}`);
		return { json: text ? JSON.parse(text) : {}, setCookie: r.headers.getSetCookie().map((c) => c.split(";")[0]).join("; ") };
	}
	get = (p) => this.call("GET", p);
	post = (p, b = {}) => this.call("POST", p, b);
	put = (p, b = {}) => this.call("PUT", p, b);
	/** Sends a message and waits for the agent to settle. */
	say(session, content, extra = {}) {
		log("say", session.slice(0, 8), JSON.stringify(content).slice(0, 70));
		return this.post(`/sessions/${session}/messages`, { content, wait: true, ...extra });
	}
	/** Runs one tool through the preview's stand-in model. */
	tool(session, name, args) {
		return this.say(session, `/tool ${name} ${JSON.stringify(args)}`);
	}
	/** Runs a tool that is a gated action: the run waits for the person, so send without waiting, approve, then wait for the chat to settle. */
	async gated(session, name, args) {
		await this.post(`/sessions/${session}/messages`, { content: `/tool ${name} ${JSON.stringify(args)}`, wait: false });
		for (let i = 0; i < 50; i++) {
			if ((await this.approveAll()) > 0) break;
			await new Promise((r) => setTimeout(r, 200));
		}
		for (let i = 0; i < 100 && (await this.get(`/sessions/${session}/messages`)).busy; i++) await new Promise((r) => setTimeout(r, 200));
	}
	async approveAll() {
		const { approvals } = await this.get("/approvals?status=pending");
		for (const a of approvals) await this.post(`/approvals/${a.id}/approve`, {});
		return approvals.length;
	}
	async messages(session) {
		return (await this.get(`/sessions/${session}/messages`)).messages;
	}
}

// A model provider that answers /models, so a custom provider can be added with a key.
const provider = createServer((_req, res) => {
	res.setHeader("content-type", "application/json");
	res.end(JSON.stringify({ data: [{ id: "rehearsal-model" }] }));
});
const HOST = values["provider-host"];
await new Promise((r) => provider.listen(0, HOST === "127.0.0.1" ? "127.0.0.1" : "0.0.0.0", r));
const providerUrl = `http://${HOST}:${provider.address().port}/v1`;
// A port for the MCP server the space is connected to: the server itself is only a stand-in the verification starts, so the port is held just long enough to be named.
const mcpPort = await new Promise((resolve) => {
	const probe = createServer();
	probe.listen(0, "127.0.0.1", () => {
		const { port } = probe.address();
		probe.close(() => resolve(port));
	});
});

const ada = await new Client("ada").signIn();
const bob = await new Client("bob").signIn();
const expect = { base: BASE, accounts: {}, chats: [], agents: [], skills: [], memories: [], goals: [], triggers: [], notes: [], apps: [], providers: [], sharedProviders: [], templates: [], bots: [], settings: {}, files: [] };

const adaAccount = await ada.get("/account");
const bobAccount = await bob.get("/account");
expect.accounts = { ada: { ownerId: adaAccount.ownerId, role: adaAccount.role }, bob: { ownerId: bobAccount.ownerId, role: bobAccount.role } };

await ada.put("/settings", { timeZone: "Europe/Madrid", colorMode: "dark", locale: "es" });
expect.settings = { timeZone: "Europe/Madrid", colorMode: "dark", locale: "es" };
await bob.put("/settings", { timeZone: "America/Chicago" });

const sessionsOf = async (c) => (await c.get("/sessions")).sessions;
const root = (await ada.get("/")).session ?? (await sessionsOf(ada))[0].id;
await ada.say(root, "Hello from the first chat");
await ada.say(root, "Plan my week, then check the weather");
expect.chats.push({ owner: "ada", id: root, role: "root", userTexts: ["Hello from the first chat", "Plan my week, then check the weather"] });

const researcher = await ada.post("/agents", { name: "Researcher", role: "Research", description: "Finds things out", instructions: "You research carefully. Cite sources.", symbol: "🔎", color: "blue" });
const agentId = (researcher.agent ?? researcher).id;
expect.agents.push({ owner: "ada", id: agentId, name: "Researcher", instructions: "You research carefully. Cite sources." });
const chef = await bob.post("/agents", { name: "Chef", instructions: "You suggest dinner.", symbol: "🍳", color: "amber" });
expect.agents.push({ owner: "bob", id: (chef.agent ?? chef).id, name: "Chef", instructions: "You suggest dinner." });

const made = await ada.post("/sessions", { title: "Trip research", agent: agentId });
const researchId = (made.session ?? made).id;
await ada.say(researchId, "Find good train routes to Lisbon");
expect.chats.push({ owner: "ada", id: researchId, role: "agent", agent: agentId, userTexts: ["Find good train routes to Lisbon"] });

const agentMessage = (await ada.messages(root)).find((m) => m.role === "agent" || m.role === "assistant");
const fork = await ada.post(`/sessions/${root}/fork`, { at: agentMessage.id });
const forkId = (fork.session ?? fork).id;
await ada.say(forkId, "In this fork, plan the weekend instead");
expect.chats.push({ owner: "ada", id: forkId, role: "fork", forkOf: root, userTexts: ["Hello from the first chat", "In this fork, plan the weekend instead"] });

const bobRoot = (await bob.get("/")).session ?? (await sessionsOf(bob))[0].id;
await bob.say(bobRoot, "What is for dinner?");
expect.chats.push({ owner: "bob", id: bobRoot, role: "root", userTexts: ["What is for dinner?"] });

// Skills with a file and two versions: written through a gated action the person approves.
const SKILL_FILES = [{ path: "notes/checklist.md", content: "# Checklist\n- bytes must survive\n" }];
const majordomo = (await ada.get("/agents")).agents.find((a) => a.majordomo).id;
await ada.gated(root, "write_skill", { agent: majordomo, name: "weekly-report", description: "Writes the weekly report", instructions: "Summarize the week in five bullets.", files: SKILL_FILES });
await ada.gated(root, "write_skill", { agent: majordomo, name: "weekly-report", description: "Writes the weekly report", instructions: "Summarize the week in five bullets, then list risks.", files: SKILL_FILES, base_version: 1 });
expect.skills.push({ owner: "ada", name: "weekly-report", version: 2, instructions: "Summarize the week in five bullets, then list risks.", files: { "notes/checklist.md": SKILL_FILES[0].content } });

for (const text of ["Ada prefers trains over planes", "Ada's sister lives in Porto"]) {
	await ada.post("/memory/log", { text });
	expect.memories.push({ owner: "ada", text });
}
await bob.post("/memory/log", { text: "Bob is allergic to peanuts" });
expect.memories.push({ owner: "bob", text: "Bob is allergic to peanuts" });

await ada.tool(root, "create_goal", { title: "Run a 5k", steps: ["Run 2k", "Run 4k", "Run 5k"] });
expect.goals.push({ owner: "ada", title: "Run a 5k", steps: ["Run 2k", "Run 4k", "Run 5k"] });

await ada.tool(root, "schedule_task", { instruction: "Send the weekly summary", label: "Weekly summary", cron: "0 9 * * 1" });
await ada.tool(root, "schedule_task", { instruction: "Water the plants", label: "Plants", at: new Date(Date.now() + 7 * 86400_000).toISOString() });
expect.triggers.push({ owner: "ada", label: "Weekly summary", kind: "time" }, { owner: "ada", label: "Plants", kind: "time" });

await ada.tool(root, "note_create", { title: "Packing list", content: "# Packing\n\n- passport\n- charger\n" });
expect.notes.push({ owner: "ada", id: (await ada.get("/artifacts")).artifacts.find((a) => a.title === "Packing list").id, title: "Packing list", text: "passport" });
await ada.tool(root, "app_create", { title: "Tip calculator", kind: "html", content: "<!doctype html><title>tips</title><h1>Tip calculator v1</h1>" });
const app = (await ada.get("/artifacts")).artifacts.find((a) => a.title === "Tip calculator");
await ada.tool(root, "app_update", { id: app.id, base_version: 1, content: "<!doctype html><title>tips</title><h1>Tip calculator v2</h1>" });
expect.apps.push({ owner: "ada", id: app.id, title: "Tip calculator", versions: 2, latest: "Tip calculator v2" });

// An uploaded file: an image sent in a chat is kept in the BLOBS bucket.
const PNG = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";
await ada.say(root, [{ type: "text", text: "Here is a picture" }, { type: "image", data: PNG, mimeType: "image/png" }]);
expect.files.push({ owner: "ada", kind: "chat-image", sha256: createHash("sha256").update(Buffer.from(PNG, "base64")).digest("hex") });

const added = await ada.post("/providers", { name: "Rehearsal provider", url: providerUrl, key: "rehearsal-provider-key-0001", models: ["rehearsal-model"] });
expect.providers.push({ owner: "ada", name: "Rehearsal provider", key: "rehearsal-provider-key-0001", id: (added.provider ?? added).id, url: providerUrl });

// What the admin shares: a provider for everyone, a template and a bot made of an agent, and the agent everyone starts with.
const shared = await ada.call("POST", "/admin/providers", { name: "Shared rehearsal models", url: providerUrl, key: "rehearsal-shared-key-0002", models: ["rehearsal-model"] });
expect.sharedProviders.push({ id: (shared.provider ?? shared).id, name: "Shared rehearsal models", key: "rehearsal-shared-key-0002", url: providerUrl });
for (const [who, c, agent, name, instructions] of [["ada", ada, agentId, "Researcher", "You research carefully. Cite sources."], ["bob", bob, (chef.agent ?? chef).id, "Chef", "You suggest dinner."]]) {
	const published = await c.call("POST", `/agents/${agent}/publish`, {});
	expect.templates.push({ owner: who, id: published.id, agent, name, instructions });
}
await ada.call("PUT", `/agents/${agentId}/bot`, { dailyMessages: 12, dailyToolCalls: 3 });
const botShared = await ada.call("GET", `/agents/${agentId}/bot`);
expect.bots.push({ owner: "ada", id: botShared.id, agent: agentId, dailyMessages: 12, dailyToolCalls: 3 });
await ada.call("PUT", "/admin/default-agent", { agent: agentId });
expect.defaultAgent = { owner: "ada", agent: agentId };

// What credentials a space holds besides model keys: the ChatGPT sign-in and a connected MCP server with its OAuth tokens (seeded: the preview cannot make either itself).
const mcpUrl = `http://${HOST}:${mcpPort}/mcp`;
const seeded = await (await fetch(`${BASE}/__dev/seed-connections/ada?mcp=${encodeURIComponent(mcpUrl)}`)).json();
expect.chatgpt = { owner: "ada", email: seeded.chatgptEmail, access: "rehearsal-chatgpt-access-0001", refresh: "rehearsal-chatgpt-refresh-0001" };
expect.mcp = { owner: "ada", id: seeded.mcpServer, url: mcpUrl, port: mcpPort, accessToken: seeded.accessToken, refreshToken: seeded.refreshToken };

await ada.put("/profile", { displayName: "Ada L.", bio: "Rehearsal admin" });
const circle = await ada.post("/circles", { name: "Family" });
await ada.post(`/circles/${(circle.circle ?? circle).id}/members`, { username: "bob" });

// A chat cut off mid-tool, made last because approvals are approved in bulk above: a gated action waits for an approval nobody gives.
const mid = await ada.post("/sessions", { title: "Mid tool chat" });
const midId = (mid.session ?? mid).id;
await ada.post(`/sessions/${midId}/messages`, { content: `/tool http_request ${JSON.stringify({ method: "GET", url: "https://example.com" })}`, wait: false });
await new Promise((r) => setTimeout(r, 1500));
expect.chats.push({ owner: "ada", id: midId, role: "mid-tool", pendingApproval: true });

// A schedule that falls due while the fence is up: whether the old Worker fires it after an unfence is what the rollback rehearsal observes.
if (Number(values["probe-seconds"]) > 0) {
	await ada.tool(root, "schedule_task", { instruction: "Fence probe", label: "Fence probe", delay_seconds: Number(values["probe-seconds"]), new_chat: true });
	expect.probe = { owner: "ada", label: "Fence probe", dueAt: Date.now() + Number(values["probe-seconds"]) * 1000 };
}

// A passkey whose private key the rehearsal keeps, and an API token whose secret it keeps: the new stack must accept both. (A preview sign-in's own key is gone with the Worker.)
const options = await ada.auth("/passkeys/options", {});
const challengeCookie = options.setCookie;
const key = Passkey.make();
const registered = await fetch(`${BASE}/auth/passkeys`, { method: "POST", headers: { cookie: `${ada.cookie}; ${challengeCookie}`, origin: BASE, "content-type": "application/json" }, body: JSON.stringify(key.create(options.json, BASE)) });
if (!registered.ok) throw new Error(`registering the rehearsal passkey: ${registered.status} ${await registered.text()}`);
expect.passkey = { owner: "ada", ...key.save(), rpId: new URL(BASE).hostname };
// Recovery codes: the way back in when the passkey's host changes.
expect.recoveryCodes = { owner: "ada", username: "ada", codes: (await ada.auth("/recovery-codes")).json.codes };
const token = (await ada.auth("/tokens", { name: "rehearsal" })).json;
expect.token = { owner: "ada", name: "rehearsal", token: token.token ?? token.secret };
const bobToken = (await bob.auth("/tokens", { name: "rehearsal" })).json;
expect.tokens = { ada: expect.token.token, bob: bobToken.token ?? bobToken.secret };

writeFileSync(values.expect, JSON.stringify(expect, null, 2));
log(`wrote ${values.expect}`);
provider.close();
