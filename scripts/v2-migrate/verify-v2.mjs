#!/usr/bin/env node
// Checks a promoted v2 stack against what a populated v1 space held (the expectations file `populate-v1.mjs` wrote), through the stack's public API and the same sign-in
// a person uses. Run against the local rehearsal's stack or the Docker Compose stack:
//   node scripts/v2-migrate/verify-v2.mjs --public-url https://pim.example.test --expect v1-expectations.json [--database-url postgres://...] [--ingress-secret S] [--no-run] [--provider-host 0.0.0.0]
// Exit status 0 only when every check passed. `--no-run` skips the checks that need a Runner and a model (a new message in an imported chat).
// `--provider-host` is where the stand-in for the imported provider listens: 0.0.0.0 when the Runners run in containers and reach it through the Docker gateway.
import { createHash, randomUUID } from "node:crypto";
import { createServer } from "node:http";
import { readFileSync } from "node:fs";
import { parseArgs } from "node:util";
import { Passkey } from "./passkey.mjs";

const { values } = parseArgs({
	options: { "public-url": { type: "string" }, expect: { type: "string" }, "database-url": { type: "string" }, "ingress-secret": { type: "string", default: "" }, "no-run": { type: "boolean", default: false }, "run-timeout": { type: "string", default: "60" }, "provider-host": { type: "string", default: "127.0.0.1" } },
});
const BASE = values["public-url"]?.replace(/\/$/, "");
if (!BASE || !values.expect) throw new Error("--public-url and --expect are required");
const expect = JSON.parse(readFileSync(values.expect, "utf8"));
const checks = [];
const check = (name, ok, detail = "") => {
	checks.push({ name, ok: Boolean(ok), detail: ok ? "" : String(detail) });
	console.log(`${ok ? "ok  " : "FAIL"} ${name}${ok || !detail ? "" : `: ${String(detail).slice(0, 300)}`}`);
};

class Session {
	constructor(token) {
		this.token = token;
		this.cookie = "";
	}
	async call(method, path, body) {
		const headers = { ...(values["ingress-secret"] ? { "x-pim-ingress-secret": values["ingress-secret"] } : {}), ...(this.token ? { authorization: `Bearer ${this.token}` } : {}), ...(this.cookie ? { cookie: this.cookie } : {}), ...(body === undefined ? {} : { "content-type": "application/json" }), origin: BASE };
		const res = await fetch(BASE + path, { method, headers, body: body === undefined ? undefined : JSON.stringify(body), redirect: "manual" });
		const jar = res.headers.getSetCookie().map((c) => c.split(";")[0]).filter((c) => !c.endsWith("="));
		if (jar.length) this.cookie = [...new Set([...this.cookie.split("; ").filter(Boolean), ...jar])].join("; ");
		const raw = Buffer.from(await res.arrayBuffer());
		let json = null;
		if ((res.headers.get("content-type") ?? "").includes("json")) json = JSON.parse(raw.toString("utf8"));
		return { status: res.status, json, raw };
	}
	get = (p) => this.call("GET", p);
	post = (p, b = {}) => this.call("POST", p, b);
	/** The whole transcript, oldest first: the snapshot is a bounded page, so earlier pages are read until there are none. */
	async transcript(chat) {
		let all = null;
		for (let before = ""; ; ) {
			const r = await this.get(`/api/snapshot/chat/${chat}${before}`);
			if (r.status !== 200) return all;
			all = [...r.json.messages, ...(all ?? [])];
			if (!r.json.nextBefore) return all;
			before = `?before=${encodeURIComponent(r.json.nextBefore)}`;
		}
	}
}
// The account answers in the old app's flat shape on newer builds and wrapped on older ones; the memory list as `entries` (text) or `memories` (body).
const accountOf = (response) => response.json?.account ?? response.json;
const memoriesOf = (response) => (response.json?.entries ?? response.json?.memories ?? []).map((m) => m.text ?? m.body);
const text = (message) => (message.parts ?? []).filter((p) => p.type === "text").map((p) => p.text).join("");
const sha = (bytes) => createHash("sha256").update(bytes).digest("hex");

const ada = new Session(expect.tokens.ada);
const bob = new Session(expect.tokens.bob);

// ---- sign-in ----
{
	const anon = new Session(null);
	const key = Passkey.from(expect.passkey);
	const options = await anon.post("/auth/sign-in/options");
	const signed = options.status === 200 ? await anon.post("/auth/sign-in", key.get(options.json, BASE, Buffer.from(expect.accounts.ada.ownerId).toString("base64url"))) : options;
	check("the passkey made on the old Pim signs in on the new one", signed.status === 200, `${signed.status} ${signed.raw.toString().slice(0, 200)}`);
	const me = accountOf(await anon.get("/api/account"));
	check("that session is Ada, the admin, with her old owner id", me?.ownerId === expect.accounts.ada.ownerId && me.role === "admin" && me.username === "ada", JSON.stringify(me)?.slice(0, 200));
}
for (const [name, session] of [["ada", ada], ["bob", bob]]) {
	const me = accountOf(await session.get("/api/account"));
	check(`the old API token of ${name} still works and names ${name}`, me?.username === name && me.ownerId === expect.accounts[name].ownerId, JSON.stringify(me));
}
check("bob is a member, not an admin", accountOf(await bob.get("/api/account"))?.role === expect.accounts.bob.role);

// ---- chats, history and forks ----
const adaChats = new Map(((await ada.get("/api/sessions")).json?.sessions ?? []).map((c) => [c.id, c]));
const bobChats = new Map(((await bob.get("/api/sessions")).json?.sessions ?? []).map((c) => [c.id, c]));
for (const chat of expect.chats) {
	const mine = chat.owner === "ada" ? ada : bob;
	const listed = (chat.owner === "ada" ? adaChats : bobChats).has(chat.id);
	check(`${chat.owner}'s ${chat.role} chat is listed under ${chat.owner}`, listed);
	const messages = await mine.transcript(chat.id);
	check(`${chat.owner}'s ${chat.role} chat has a transcript`, messages?.length > 0, `got ${messages?.length}`);
	if (chat.userTexts) {
		const said = (messages ?? []).filter((m) => m.role === "user").map(text);
		check(`${chat.owner}'s ${chat.role} chat keeps what was said, in order`, chat.userTexts.every((t, i) => said[i] === t || (chat.role === "root" && said.includes(t))), JSON.stringify(said.slice(0, 4)));
	}
	if (chat.forkOf) {
		const meta = (await mine.get(`/api/sessions/${chat.id}`)).json;
		check("the fork names its parent chat", meta?.forkedFrom === chat.forkOf, JSON.stringify(meta));
		const parent = await mine.transcript(chat.forkOf);
		const own = (messages ?? []).filter((m) => m.role === "user").map(text);
		check("the fork's history runs through its parent up to the fork point, then its own words", own[0] === chat.userTexts[0] && own.at(-1) === chat.userTexts.at(-1) && (parent ?? []).filter((m) => m.role === "user").length > own.length - 1);
	}
}
{
	const a = await ada.get(`/api/snapshot/chat/${expect.chats.find((c) => c.owner === "bob").id}`);
	const b = await bob.get(`/api/snapshot/chat/${expect.chats.find((c) => c.owner === "ada").id}`);
	check("ada cannot read bob's chat, and bob cannot read ada's", a.status !== 200 || a.json.messages.length === 0, `${a.status} ${JSON.stringify(a.json).slice(0, 100)}`);
	check("bob cannot read ada's chat", b.status !== 200 || b.json.messages.length === 0, `${b.status} ${JSON.stringify(b.json).slice(0, 100)}`);
}
check("each person lists only their own chats", !expect.chats.some((c) => (c.owner === "ada" ? bobChats : adaChats).has(c.id)));

// ---- agents, skills, memories, goals ----
const agentsOf = async (s) => (await s.get("/api/agents")).json?.agents ?? [];
for (const a of expect.agents) {
	const found = (await agentsOf(a.owner === "ada" ? ada : bob)).find((x) => x.id === a.id);
	check(`${a.owner}'s agent ${a.name} has its instructions`, found?.name === a.name && found.instructions === a.instructions, JSON.stringify(found));
	check(`${a.name} is not visible to the other person`, !(await agentsOf(a.owner === "ada" ? bob : ada)).some((x) => x.id === a.id));
}
for (const k of expect.skills) {
	const skill = (await ada.get(`/api/skills/${k.name}`)).json;
	check(`skill ${k.name} is at version ${k.version} with its instructions and file`, skill?.version === k.version && skill.body === k.instructions && JSON.stringify(skill.files) === JSON.stringify(k.files), JSON.stringify(skill));
	const v1 = await ada.get(`/api/skills/${k.name}/versions/1`);
	check(`skill ${k.name} keeps its first version`, v1.status === 200, v1.status);
}
{
	const memories = new Set(memoriesOf(await ada.get("/api/memory/log")));
	for (const m of expect.memories.filter((x) => x.owner === "ada")) check(`memory "${m.text}" is ada's`, memories.has(m.text));
	const bobs = new Set(memoriesOf(await bob.get("/api/memory/log")));
	check("bob has his memory and none of ada's", expect.memories.filter((x) => x.owner === "bob").every((m) => bobs.has(m.text)) && !expect.memories.filter((x) => x.owner === "ada").some((m) => bobs.has(m.text)));
}
for (const g of expect.goals) {
	const goal = ((await ada.get("/api/goals")).json?.goals ?? []).find((x) => x.title === g.title);
	check(`goal "${g.title}" keeps its steps in order`, JSON.stringify(goal?.steps?.map((s) => s.title)) === JSON.stringify(g.steps), JSON.stringify(goal));
}

// ---- triggers: present, aimed at the right chat, and none fired ----
{
	const triggers = (await ada.get("/api/triggers")).json?.triggers ?? [];
	const rootChat = expect.chats.find((c) => c.owner === "ada" && c.role === "root").id;
	for (const t of expect.triggers) {
		const found = triggers.find((x) => x.label === t.label);
		check(`trigger "${t.label}" is promoted and enabled`, found && found.lifecycle === "enabled", JSON.stringify(found));
		check(`trigger "${t.label}" is addressed to the chat's new id, not the old numeric one`, !found?.spec?.destination?.chatId || found.spec.destination.chatId === rootChat, found?.spec?.destination?.chatId);
		const runs = found ? ((await ada.get(`/api/triggers/${found.id}/runs`)).json?.runs ?? []) : null;
		check(`trigger "${t.label}" has not fired by itself: nothing caught up`, Array.isArray(runs) && runs.length === 0, JSON.stringify(runs));
	}
}

// ---- notes, apps, files ----
for (const n of expect.notes) {
	const id = n.id;
	const note = id ? (await ada.get(`/api/notes/${id}`)).json : null;
	check(`note "${n.title}" reads with its words`, String(note?.text ?? "").includes(n.text), JSON.stringify(note)?.slice(0, 200));
}
for (const a of expect.apps) {
	const app = (await ada.get(`/api/apps/${a.id}`)).json;
	const versions = (await ada.get(`/api/apps/${a.id}/versions`)).json?.versions ?? [];
	check(`app "${a.title}" shows its latest version`, app?.title === a.title && String(app.content).includes(a.latest), JSON.stringify(app)?.slice(0, 200));
	check(`app "${a.title}" keeps all ${a.versions} versions`, versions.length === a.versions, JSON.stringify(versions));
}
for (const f of expect.files) {
	const root = await ada.transcript(expect.chats.find((c) => c.owner === "ada" && c.role === "root").id);
	const part = (root ?? []).flatMap((m) => m.parts ?? []).find((p) => p.type === "image");
	const url = part?.url ?? part?.image?.url;
	const bytes = url ? await ada.get(url.startsWith("/") ? url : new URL(url).pathname) : null;
	check("the uploaded image opens from the chat with the same bytes", bytes?.status === 200 && sha(bytes.raw) === f.sha256, `${url} ${bytes?.status} ${bytes && sha(bytes.raw)}`);
}

// ---- provider and settings ----
const providers = (await ada.get("/api/providers")).json?.providers ?? [];
for (const p of expect.providers) {
	const found = providers.find((x) => x.id === p.id);
	check(`provider ${p.name} is ada's, with a key set and never returned`, found?.hasKey === true && !JSON.stringify(providers).includes(p.key), JSON.stringify(found));
	check(`provider ${p.name} is not bob's`, !((await bob.get("/api/providers")).json?.providers ?? []).some((x) => x.id === p.id));
}
// ---- what the admin shared, and the credentials a space held ----
{
	const listed = (await bob.get("/api/templates")).json?.templates ?? [];
	for (const t of expect.templates ?? []) {
		const full = (await (t.owner === "ada" ? ada : bob).get(`/api/templates/${t.id}`)).json;
		check(`${t.owner}'s template ${t.name} is in the gallery, with its instructions, and anyone signed in lists it`, listed.some((x) => x.id === t.id && x.name === t.name) && (full?.instructions ?? full?.template?.instructions) === t.instructions, JSON.stringify(full)?.slice(0, 200));
	}
	if (expect.defaultAgent) {
		const chosen = (await ada.get("/api/admin/default-agent")).json?.agent;
		check("the agent everyone starts with is the one the admin chose", JSON.stringify(chosen ?? null).includes(expect.templates.find((t) => t.agent === expect.defaultAgent.agent)?.name ?? "\0"), JSON.stringify(chosen));
	}
	for (const b of expect.bots ?? []) {
		const bot = (await ada.get(`/api/agents/${b.agent}/bot`)).json;
		check("the bot the admin shared keeps its link and limits", bot?.id === b.id && bot.dailyMessages === b.dailyMessages && bot.dailyToolCalls === b.dailyToolCalls, JSON.stringify(bot));
	}
	const model = (await ada.get("/api/model")).json;
	if (expect.chatgpt) check("the ChatGPT sign-in came across: connected as the same account, with nobody signing in again", model?.chatgpt?.connected === true && model.chatgpt.email === expect.chatgpt.email && !JSON.stringify(model).includes(expect.chatgpt.access), JSON.stringify(model?.chatgpt));
	for (const p of expect.sharedProviders ?? []) {
		const bobModel = (await bob.get("/api/model")).json;
		const offered = (m) => (m?.choices ?? []).some((c) => c.provider === `shared:${p.id}`);
		check("the provider shared with everyone offers its models to ada and to bob, as the old Pim named it, and no response shows its key", offered(model) && offered(bobModel) && !JSON.stringify([model, bobModel]).includes(p.key), JSON.stringify(model?.choices)?.slice(0, 300));
		const theirs = [...providers, ...((await bob.get("/api/providers")).json?.providers ?? [])];
		check("a provider shared with everyone is the deployment's, not a copy in anyone's space", !theirs.some((x) => x.id === p.id || x.id === `shared:${p.id}`), JSON.stringify(theirs.map((x) => x.id)));
	}
	if (expect.mcp) {
		const mine = ((await ada.get("/api/connectors")).json?.connectors ?? []).find((c) => c.id === expect.mcp.id);
		check("the MCP server ada had connected is hers, connected, at its address, without its tokens ever shown", mine?.kind === "custom_mcp" && mine.url === expect.mcp.url && mine.status === "connected" && !JSON.stringify(mine).includes(expect.mcp.accessToken), JSON.stringify(mine));
		check("the MCP server is not bob's", !((await bob.get("/api/connectors")).json?.connectors ?? []).some((c) => c.id === expect.mcp.id));
	}
}
check("the circle Family has bob in it", ((await ada.get("/api/circles")).json?.circles ?? []).some((c) => c.name === "Family" && c.members.includes(expect.accounts.bob.ownerId)));
check("the profile is kept", (await ada.get("/api/profile")).json?.displayName === "Ada L.");

// ---- a new message in an imported chat, answered by the imported provider with its imported key ----
const seen = [];
if (!values["no-run"]) {
	const provider = expect.providers[0];
	const port = Number(new URL(provider.url).port);
	const fake = createServer((req, res) => {
		let body = "";
		req.on("data", (d) => (body += d));
		req.on("end", () => {
			seen.push({ path: req.url, authorization: req.headers.authorization });
			if (!req.url?.includes("chat/completions")) {
				res.setHeader("content-type", "application/json");
				return res.end(JSON.stringify({ data: [{ id: "rehearsal-model" }] }));
			}
			const request = JSON.parse(body || "{}");
			const afterTool = request.messages?.at(-1)?.role === "tool";
			const lastUser = JSON.stringify([...(request.messages ?? [])].reverse().find((m) => m.role === "user")?.content ?? "");
			res.writeHead(200, { "content-type": "text/event-stream" });
			const chunk = (delta, finish = null, usage) => res.write(`data: ${JSON.stringify({ id: "c1", object: "chat.completion.chunk", created: 1, model: "rehearsal-model", choices: [{ index: 0, delta, finish_reason: finish }], ...(usage ? { usage } : {}) })}\n\n`);
			if (afterTool) chunk({ role: "assistant", content: "Done." }, "stop", { prompt_tokens: 5, completion_tokens: 2, total_tokens: 7 });
			else if (lastUser.includes("MCPCHECK")) {
				chunk({ role: "assistant", tool_calls: [{ index: 0, id: "call_mcp", type: "function", function: { name: "connector_call", arguments: JSON.stringify({ connector: expect.mcp.id, tool: "echo", arguments: { text: "hello from the rehearsal" } }) } }] });
				chunk({}, "tool_calls", { prompt_tokens: 5, completion_tokens: 2, total_tokens: 7 });
			} else {
				chunk({ role: "assistant", tool_calls: [{ index: 0, id: "call_rehearsal", type: "function", function: { name: "send_to_user", arguments: JSON.stringify({ message: "pong from the imported provider" }) } }] });
				chunk({}, "tool_calls", { prompt_tokens: 5, completion_tokens: 2, total_tokens: 7 });
			}
			res.end("data: [DONE]\n\n");
		});
	});
	await new Promise((resolve, reject) => fake.once("error", reject).listen(port, values["provider-host"], resolve));
	// The MCP server ada had connected: a stand-in that accepts only the access token that was imported.
	const mcpSeen = [];
	const mcp = expect.mcp
		? createServer((req, res) => {
				let body = "";
				req.on("data", (d) => (body += d));
				req.on("end", () => {
					const message = body ? JSON.parse(body) : {};
					if (req.headers.authorization !== `Bearer ${expect.mcp.accessToken}`) {
						res.writeHead(401);
						return res.end();
					}
					if (message.method === "tools/call") mcpSeen.push({ tool: message.params.name, arguments: message.params.arguments });
					if (message.id === undefined) {
						res.writeHead(req.method === "DELETE" ? 200 : 202);
						return res.end();
					}
					const results = {
						initialize: { protocolVersion: "2025-06-18", capabilities: { tools: {} }, serverInfo: { name: "rehearsal-notes", version: "1" } },
						"tools/list": { tools: [{ name: "echo", description: "Echoes its text", inputSchema: { type: "object", properties: { text: { type: "string" } } }, annotations: { readOnlyHint: true } }] },
						"tools/call": { content: [{ type: "text", text: `MCPECHO ${message.params?.arguments?.text}` }] },
					};
					res.writeHead(200, { "content-type": "application/json", "mcp-session-id": "rehearsal" });
					res.end(JSON.stringify({ jsonrpc: "2.0", id: message.id, result: results[message.method] ?? {} }));
				});
			})
		: null;
	if (mcp) await new Promise((resolve, reject) => mcp.once("error", reject).listen(expect.mcp.port, values["provider-host"], resolve));
	try {
		for (const role of ["root", "mid-tool"]) {
			const chat = expect.chats.find((c) => c.owner === "ada" && c.role === role).id;
			const before = (await ada.transcript(chat)).length;
			const sent = await ada.post(`/api/sessions/${chat}/messages`, { commandId: randomUUID(), text: `ping after the move (${role})` });
			let answered = false;
			for (let i = 0; i < Number(values["run-timeout"]) * 2 && !answered; i++) {
				await new Promise((r) => setTimeout(r, 500));
				answered = ((await ada.transcript(chat)) ?? []).slice(before).some((m) => JSON.stringify(m).includes("pong from the imported provider"));
			}
			check(`a new message in the imported ${role} chat is answered${role === "mid-tool" ? ", though its tool call was cut off and is never replayed" : ""}`, sent.status < 300 && answered, `${sent.status}; calls ${JSON.stringify(seen.slice(-2))}`);
		}
		if (expect.mcp) {
			const id = expect.mcp.id;
			const discovered = await ada.post(`/api/connectors/${id}/discover`);
			check("the imported MCP credential lists the server's tools (the server accepted the imported access token)", discovered.status === 200 && discovered.json?.discovered === 1, `${discovered.status} ${discovered.raw.toString().slice(0, 200)}`);
			await ada.call("PUT", `/api/connectors/${id}/tools`, { tools: ["echo"] });
			const chat = expect.chats.find((c) => c.owner === "ada" && c.role === "root").id;
			const before = (await ada.transcript(chat)).length;
			await ada.post(`/api/sessions/${chat}/messages`, { commandId: randomUUID(), text: "MCPCHECK call the notes server" });
			let called = false;
			for (let i = 0; i < Number(values["run-timeout"]) * 2 && !called; i++) {
				await new Promise((r) => setTimeout(r, 500));
				called = ((await ada.transcript(chat)) ?? []).slice(before).some((m) => JSON.stringify(m).includes("MCPECHO hello from the rehearsal"));
			}
			check("an agent calls the imported MCP server's tool with the imported token, and reads its answer", called && mcpSeen.some((c) => c.tool === "echo" && c.arguments?.text === "hello from the rehearsal"), JSON.stringify(mcpSeen));
		}
		for (const p of expect.sharedProviders ?? []) {
			const made = await ada.post("/api/agents", { name: "Shared check", instructions: "Answer.", model: { provider: `shared:${p.id}`, id: "rehearsal-model" } });
			const agent = made.json?.agent?.id ?? made.json?.id;
			const chat = (await ada.post("/api/sessions", { title: "Shared provider check", agentId: agent })).json?.id;
			const mark = seen.length;
			await ada.post(`/api/sessions/${chat}/messages`, { commandId: randomUUID(), text: "ping the shared provider" });
			let answered = false;
			for (let i = 0; i < Number(values["run-timeout"]) * 2 && !answered; i++) {
				await new Promise((r) => setTimeout(r, 500));
				answered = ((await ada.transcript(chat)) ?? []).some((m) => JSON.stringify(m).includes("pong from the imported provider"));
			}
			check("a chat on a model of the provider shared with everyone is answered with the deployment's key for it", answered && seen.slice(mark).some((c) => c.authorization === `Bearer ${p.key}`), `${made.status} ${JSON.stringify(seen.slice(mark))}`);
		}
		check("the model call used the imported API key", seen.some((s) => s.authorization === `Bearer ${expect.providers[0].key}`), JSON.stringify(seen));
		const replayed = ((await ada.transcript(expect.chats.find((c) => c.role === "mid-tool").id)) ?? []).filter((m) => JSON.stringify(m).includes("example.com") && m.role === "tool");
		check("the cut-off http_request did not run again", replayed.every((m) => !JSON.stringify(m).includes("Example Domain")), JSON.stringify(replayed).slice(0, 200));
	} finally {
		if (mcp) await new Promise((r) => mcp.close(r));
		await new Promise((r) => fake.close(r));
	}
}

// ---- the database's own view, when we may look ----
if (values["database-url"]) {
	const { createRequire } = await import("node:module");
	const pg = createRequire(import.meta.url)("../../packages/v2-server/node_modules/pg");
	const pool = new pg.Pool({ connectionString: values["database-url"], max: 2 });
	try {
		const q = async (sql, args = []) => (await pool.query(sql, args)).rows;
		const settings = Object.fromEntries((await q("SELECT key, value FROM pim_app.owner_settings WHERE owner_id = $1", [expect.accounts.ada.ownerId])).map((r) => [r.key, r.value]));
		for (const [k, v] of Object.entries(expect.settings)) check(`setting ${k} is ada's explicit choice`, settings[`settings.${k}`] === v, JSON.stringify(settings));
		const bobSettings = (await q("SELECT key FROM pim_app.owner_settings WHERE owner_id = $1 AND key LIKE 'settings.%'", [expect.accounts.bob.ownerId])).map((r) => r.key);
		check("bob's settings are bob's own, and nothing he never set is an override", bobSettings.length === 1 && bobSettings[0] === "settings.timeZone", JSON.stringify(bobSettings));
		const clear = (await q("SELECT count(*)::int n FROM pim_ops.legacy_rows WHERE row::text LIKE $1", [`%${expect.providers[0].key}%`]))[0].n + (await q("SELECT count(*)::int n FROM pim_app.providers WHERE secret LIKE $1 OR config::text LIKE $1", [`%${expect.providers[0].key}%`]))[0].n;
		check("the provider key is in no table in clear", clear === 0, clear);
		// Every credential this rehearsal planted, in no table in clear, and sealed where the new stack can use it.
		const planted = [expect.chatgpt?.access, expect.chatgpt?.refresh, expect.mcp?.accessToken, expect.mcp?.refreshToken, ...(expect.sharedProviders ?? []).map((p) => p.key)].filter(Boolean);
		for (const needle of planted) {
			const where = (await q("SELECT 'legacy_rows' t FROM pim_ops.legacy_rows WHERE row::text LIKE $1 UNION ALL SELECT 'secrets' FROM pim_ops.secret_envelopes WHERE envelope::text LIKE $1 UNION ALL SELECT 'app' FROM (SELECT secret t FROM pim_app.providers UNION ALL SELECT config::text FROM pim_app.providers UNION ALL SELECT credential FROM pim_app.connectors UNION ALL SELECT secret FROM pim_app.instance_providers UNION ALL SELECT config::text FROM pim_app.instance_providers UNION ALL SELECT secret FROM pim_app.chatgpt_credentials) x WHERE t LIKE $1", [`%${needle}%`])).map((r) => r.t);
			check(`${needle.slice(0, 18)}… is in no table in clear`, where.length === 0, where.join(","));
		}
		if (expect.chatgpt) check("the ChatGPT credential is sealed in the application's own table", (await q("SELECT count(*)::int n FROM pim_app.chatgpt_credentials WHERE owner_id = $1 AND secret IS NOT NULL", [expect.accounts.ada.ownerId]))[0].n === 1);
		if (expect.mcp) check("the MCP tokens are sealed on the connector", (await q("SELECT count(*)::int n FROM pim_app.connectors WHERE owner_id = $1 AND id = $2 AND credential IS NOT NULL", [expect.accounts.ada.ownerId, expect.mcp.id]))[0].n === 1);
		for (const p of expect.sharedProviders ?? []) check("the shared provider is one deployment-level row with its key sealed", (await q("SELECT count(*)::int n FROM pim_app.instance_providers WHERE id = $1 AND secret IS NOT NULL", [p.id]))[0].n === 1);
		const held = (await q("SELECT count(*)::int n FROM pim_ops.external_operations WHERE status = 'needs_reconciliation' AND kind IN ('approval') AND owner_id = $1", [expect.accounts.ada.ownerId]))[0].n;
		check("the approval that was pending at the fence is kept as an operation to reconcile, not run", held >= 1, held);
	} finally {
		await pool.end();
	}
}

const failed = checks.filter((c) => !c.ok);
console.log(`\n${failed.length === 0 ? "PASS" : "FAIL"}: ${checks.length - failed.length}/${checks.length} checks`);
process.exit(failed.length === 0 ? 0 : 1);
