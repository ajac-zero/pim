import type { JsonValue, Message } from "@earendil-works/pi-ai";
import { fauxAssistantMessage } from "@earendil-works/pi-ai/providers/faux";
import { describe, expect, it } from "vitest";
import { env, runInDurableObject } from "cloudflare:test";
import { exports } from "cloudflare:workers";
import { AgentStore } from "../src/agents";
import { TeamStore } from "../src/team";
import { CREATE_AGENT, RENAME_AGENT, UPDATE_AGENT } from "../src/extensions/agents";
import { api, apiUrl, decisionRun, pendingApproval, post, say, TOKEN, toolUse } from "./helpers";
import { faux } from "./worker";

/** The prompt sections sent last: pi sends the whole prompt once, then only what changed. */
const system = (messages: readonly Message[]) => JSON.stringify(messages.filter((message) => message.role === "system").at(-1));

describe("the owner's agents", () => {
	it("talks in every chat as the chat's agent, or the default one, as each is at each request", async () => {
		// Every account has its agent: plain until changed, and there to stay.
		const [mine] = (await api("/agents")).body.agents;
		expect(mine).toMatchObject({ name: "Pim", instructions: "", default: true, source: null });
		expect((await api(`/agents/${mine.id}`, { method: "DELETE" })).status).toBe(400);

		expect((await post("/agents", { name: "", instructions: "x" })).status).toBe(400);
		expect((await post("/agents", { name: "Coach", instructions: "x", apps: [{ name: "Cal", url: "http://plain.test" }] })).status).toBe(400);
		const coach = (
			await post("/agents", {
				name: "Marathon coach",
				description: "Plans my training.",
				instructions: "Answer every question with a training tip.",
				apps: [{ name: "Strava", url: "https://mcp.strava.example/mcp" }],
			})
		).body;
		expect(coach).toMatchObject({ id: expect.stringMatching(/^p_/), source: null, published: null, default: false });
		expect((await api("/agents")).body.agents.map((agent: { name: string }) => agent.name)).toEqual(["Pim", "Marathon coach"]);
		expect((await post("/sessions", { agent: "p_nope" })).status).toBe(404);
		const session = (await post("/sessions", { agent: coach.id })).body;
		expect(session.agent).toEqual({ id: coach.id, name: "Marathon coach" });
		expect((await post("/sessions", {})).body.agent).toEqual({ id: mine.id, name: "Pim" });

		const prompts: string[] = [];
		const record = (context: { messages: Message[] }) => {
			prompts.push(system(context.messages));
			return fauxAssistantMessage("ok");
		};
		faux.setResponses([record, record]);
		await say("How far today?", session.id);
		await say("Hello", "1");
		expect(prompts[0]).toContain('In this conversation you are \\"Marathon coach\\"');
		expect(prompts[0]).toContain("Answer every question with a training tip.");
		expect(prompts[1]).toContain('In this conversation you are \\"Pim\\".');
		expect(prompts[1]).not.toContain("training tip");

		// Edited, an agent's chats follow from their next request: the default one's are every chat not started with another.
		await api(`/agents/${coach.id}`, { method: "PUT", body: JSON.stringify({ instructions: "Speak only in haiku." }) });
		await api(`/agents/${mine.id}`, { method: "PUT", body: JSON.stringify({ name: "Sam", instructions: "Sign off with -S." }) });
		faux.setResponses([record, record]);
		await say("And tomorrow?", session.id);
		await say("Hi again", "1");
		expect(prompts[2]).toContain("Speak only in haiku.");
		expect(prompts[3]).toContain('you are \\"Sam\\"');
		expect(prompts[3]).toContain("Sign off with -S.");
		expect((await api("/sessions")).body.sessions.find((info: { id: string }) => info.id === session.id).agent).toEqual({
			id: coach.id,
			name: "Marathon coach",
		});

		// Deleted, its chats stay, with the default agent.
		expect((await api(`/agents/${coach.id}`, { method: "DELETE" })).body).toEqual({ deleted: true });
		faux.setResponses([record]);
		await say("Still there?", session.id);
		expect(prompts[4]).toContain("Sign off with -S.");
		expect(prompts[4]).not.toContain("haiku");
		expect((await api("/agents")).body.agents).toEqual([expect.objectContaining({ id: mine.id, name: "Sam", default: true })]);
	});

	it("keeps an icon for each agent, only as a picture", async () => {
		const agent = (await post("/agents", { name: "Coach" })).body;
		expect(agent.icon).toBeNull();
		expect((await api(`/agents/${agent.id}/icon`)).status).toBe(404);
		const png = new Uint8Array([137, 80, 78, 71, 1, 2, 3]);
		const upload = (type: string, body: BodyInit) => api(`/agents/${agent.id}/icon`, { method: "PUT", headers: { "content-type": type }, body });
		expect((await upload("image/svg+xml", "<svg/>")).status).toBe(415);
		expect((await upload("image/png", new Uint8Array(256 * 1024 + 1))).status).toBe(413);
		expect((await upload("image/png", png)).body.icon).toEqual(expect.any(Number));
		const [, listed] = (await api("/agents")).body.agents;
		expect(listed.icon).toEqual(expect.any(Number));
		const served = await exports.default.fetch(apiUrl(`/agents/${agent.id}/icon`), { headers: { authorization: `Bearer ${TOKEN}` } });
		expect(served.headers.get("content-type")).toBe("image/png");
		expect(new Uint8Array(await served.arrayBuffer())).toEqual(png);
		expect((await api(`/agents/${agent.id}/icon`, { method: "DELETE" })).body.icon).toBeNull();
		expect((await api(`/agents/${agent.id}/icon`)).status).toBe(404);
	});

	it("knows the person's other agents, and makes one none of them covers", async () => {
		const planner = (await post("/agents", { name: "Trip planner", description: "Plans my trips." })).body;
		const session = (await post("/sessions", { agent: planner.id })).body.id;
		const seen: { prompt: string; result: string }[] = [];
		const record = (context: { messages: Message[] }) => {
			seen.push({ prompt: system(context.messages), result: JSON.stringify(context.messages.findLast((m) => m.role === "toolResult")?.content) });
			return fauxAssistantMessage("ok");
		};
		const reviewer = {
			name: "Code reviewer",
			description: "Reviews my pull requests.",
			instructions: "Point out bugs before style.",
			apps: [{ name: "GitHub", url: "https://mcp.github.example/mcp" }],
			team: [{ name: "Linter", instructions: "Flag style issues.", tools: ["fetch_url"] }],
		};
		faux.setResponses([
			record,
			toolUse(CREATE_AGENT, { ...reviewer, apps: [{ name: "GitHub", url: "http://plain.test" }] }),
			record,
			toolUse(CREATE_AGENT, reviewer),
			record,
			toolUse(CREATE_AGENT, { ...reviewer, name: " code REVIEWER ", instructions: "Something else." }),
			record,
		]);
		await say("Hi", session);
		expect(seen[0]!.prompt).toContain("- Trip planner (you): Plans my trips.");
		expect(seen[0]!.prompt).toMatch(/- [^\\]+ \(default\)/);

		// Refused as the API refuses it: nothing made.
		await say("Make me a code reviewer", session);
		expect(seen[1]!.result).toContain("Each app needs an https url");
		await say("Try again", session);
		expect(seen[2]!.result).toContain('\\"created\\": true');
		const made = (await api("/agents")).body.agents.find((agent: { name: string }) => agent.name === "Code reviewer");
		expect(made).toMatchObject({ ...reviewer, default: false, source: null });
		// One the person has already isn't made again, whatever its case.
		await say("And another code reviewer", session);
		expect(seen[3]!.result).toContain('\\"exists\\": true');
		expect((await api("/agents")).body.agents.filter((agent: { name: string }) => agent.name === "Code reviewer")).toHaveLength(1);
		expect(seen[3]!.prompt).toContain("- Code reviewer: Reviews my pull requests.");
	});

	it("renames another agent or itself in chat only after approval, keeping its identity and settings", async () => {
		await api("/settings", { method: "PUT", body: JSON.stringify({ approvalPolicy: "explicit" }) });
		const creator = (await post("/agents", { name: "Organizer", instructions: "Organize my work." })).body;
		const session = (await post("/sessions", { agent: creator.id })).body.id;
		faux.setResponses([
			toolUse(CREATE_AGENT, { name: "Draft helper", description: "Writes drafts.", instructions: "Write clearly." }),
			fauxAssistantMessage("Created."),
		]);
		await say("Make a writing assistant", session);
		const target = (await api("/agents")).body.agents.find((agent: { name: string }) => agent.name === "Draft helper");
		const targetSession = (await post("/sessions", { agent: target.id })).body.id;

		faux.setResponses([
			toolUse(RENAME_AGENT, { agent: target.id, name: "  Quill  " }),
			fauxAssistantMessage("Waiting for approval."),
		]);
		await say("Rename the assistant you just made to Quill", session);
		const approval = await pendingApproval();
		expect(approval.summary).toBe('Rename "Draft helper" to "Quill"');
		expect((await api(`/agents/${target.id}`)).body.name).toBe("Draft helper");
		// Approval changes only the name, retaining edits made while it was waiting.
		await api(`/agents/${target.id}`, { method: "PUT", body: JSON.stringify({ instructions: "Use short paragraphs." }) });
		faux.setResponses([fauxAssistantMessage("Renamed.")]);
		await post(`/approvals/${approval.id}/approve`);
		expect(await decisionRun(approval)).toMatchObject({ status: "done" });
		expect((await api(`/agents/${target.id}`)).body).toEqual({
			...target, name: "Quill", instructions: "Use short paragraphs.", updatedAt: expect.any(Number),
		});
		expect((await api(`/agents/${creator.id}`)).body.name).toBe("Organizer");
		expect((await api("/sessions")).body.sessions.find((info: { id: string }) => info.id === targetSession).agent).toEqual({ id: target.id, name: "Quill" });
		let prompt = "";
		faux.setResponses([(context) => {
			prompt = system(context.messages);
			return fauxAssistantMessage("Hello.");
		}]);
		await say("What is your name?", targetSession);
		expect(prompt).toContain('you are \\"Quill\\"');
		expect(prompt).toContain("Use short paragraphs.");

		// The same tool can rename the agent in this chat; denying it leaves the name alone.
		for (const decision of ["deny", "approve"]) {
			faux.setResponses([toolUse(RENAME_AGENT, { agent: creator.id, name: "Atlas" }), fauxAssistantMessage("Waiting.")]);
			await say("Call yourself Atlas", session);
			const request = await pendingApproval();
			faux.setResponses([fauxAssistantMessage("Understood.")]);
			await post(`/approvals/${request.id}/${decision}`);
			expect(await decisionRun(request)).toMatchObject({ status: "done" });
			expect((await api(`/agents/${creator.id}`)).body.name).toBe(decision === "approve" ? "Atlas" : "Organizer");
		}
		// Renaming has its own permission, separate from changing instructions and apps.
		await api("/permissions", { method: "PUT", body: JSON.stringify({ tool: RENAME_AGENT, permission: "on" }) });
		faux.setResponses([toolUse(RENAME_AGENT, { agent: target.id, name: "Scribe" }), fauxAssistantMessage("Renamed.")]);
		await say("Call Quill Scribe instead", session);
		expect((await api(`/agents/${target.id}`)).body.name).toBe("Scribe");
		expect((await api("/approvals?status=pending")).body.approvals).toEqual([]);
		await api("/permissions", { method: "PUT", body: JSON.stringify({ tool: RENAME_AGENT, permission: "off" }) });
		const fresh = (await post("/sessions", { agent: creator.id })).body.id;
		let tools: string[] = [];
		faux.setResponses([(context) => {
			tools = context.messages.flatMap((message) => message.role === "system" ? (message.toolsAdded ?? []).map((tool) => tool.name) : []);
			return fauxAssistantMessage("Hello.");
		}]);
		await say("Hi", fresh);
		expect(tools).not.toContain(RENAME_AGENT);
		expect(tools).toContain(UPDATE_AGENT);
		await api("/permissions", { method: "PUT", body: JSON.stringify({ tool: RENAME_AGENT, permission: null }) });
		await api("/settings", { method: "PUT", body: JSON.stringify({ approvalPolicy: null }) });
	});

	it("changes itself, its team included, once the person approves", async () => {
		await api("/settings", { method: "PUT", body: JSON.stringify({ approvalPolicy: "explicit" }) });
		const writer = (
			await post("/agents", {
				name: "Ghostwriter",
				instructions: "Write short.",
				apps: [{ name: "Docs", url: "https://mcp.docs.example/mcp" }],
				team: [
					{ name: "Editor", instructions: "Fix grammar." },
					{ name: "Fact checker", instructions: "Check every claim." },
				],
			})
		).body;
		const session = (await post("/sessions", { agent: writer.id })).body.id;
		const results: string[] = [];
		const record = (context: { messages: Message[] }) => {
			results.push(JSON.stringify(context.messages.findLast((m) => m.role === "toolResult")?.content));
			return fauxAssistantMessage("ok");
		};
		const edit: Record<string, JsonValue> = {
			instructions: "Write long.",
			set_members: [
				{ name: "editor", instructions: "Fix grammar and tone." },
				{ name: "Researcher", instructions: "Find sources.", tools: ["fetch_url"] },
			],
			remove_members: ["Fact checker"],
		};
		faux.setResponses([
			toolUse(UPDATE_AGENT, { set_members: [{ name: "Editor", instructions: "" }] }),
			record,
			toolUse(UPDATE_AGENT, { instructions: "Write short." }),
			record,
			toolUse(UPDATE_AGENT, edit),
			record,
		]);
		await say("Bring on a researcher", session);
		expect(results[0]).toContain("Editor's instructions is required");
		await say("Again?", session);
		expect(results[1]).toContain("That changes nothing.");
		await say("Please", session);
		const approval = await pendingApproval();
		expect(approval.summary).toBe(
			"Ghostwriter changes its instructions, adds Researcher to its team, changes Editor on its team, removes Fact checker from its team",
		);
		// Nothing changes until the person says yes.
		expect((await api(`/agents/${writer.id}`)).body.instructions).toBe("Write short.");

		let prompt = "";
		faux.setResponses([
			(context) => {
				prompt = system(context.messages);
				return fauxAssistantMessage("Done.");
			},
		]);
		await post(`/approvals/${approval.id}/approve`);
		expect(await decisionRun(approval)).toMatchObject({ status: "done" });
		expect((await api(`/agents/${writer.id}`)).body).toMatchObject({
			instructions: "Write long.",
			apps: [{ name: "Docs", url: "https://mcp.docs.example/mcp" }],
			team: [
				{ name: "Editor", instructions: "Fix grammar and tone.", tools: null },
				{ name: "Researcher", instructions: "Find sources.", tools: ["fetch_url"] },
			],
		});
		expect(prompt).toContain("Write long.");
		expect(prompt).toContain("- Researcher: Find sources.");
		await api("/settings", { method: "PUT", body: JSON.stringify({ approvalPolicy: null }) });
	});
});

describe("a database from when agents were personas", () => {
	it("is renamed in place, keeping its agents, icons, chats and team runs", async () => {
		await runInDurableObject(env.Pim.getByName("legacy"), async (_instance, state) => {
			const sql = state.storage.sql;
			for (const table of ["pim_agents", "pim_agent_icons", "pim_agent_sessions", "pim_team_runs"]) sql.exec(`DROP TABLE ${table}`);
			sql.exec(`CREATE TABLE pim_personas (id TEXT PRIMARY KEY, name TEXT NOT NULL, description TEXT NOT NULL, instructions TEXT NOT NULL, apps TEXT NOT NULL,
				source TEXT, published TEXT, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, is_default INTEGER NOT NULL DEFAULT 0, team TEXT NOT NULL DEFAULT '[]', base TEXT)`);
			sql.exec(`INSERT INTO pim_personas VALUES ('p_1', 'Coach', 'Runs', 'Be brief.', '[]', NULL, NULL, 1, 1, 1, '[]', 'test.ledger/budget')`);
			sql.exec("CREATE TABLE pim_persona_icons (persona TEXT PRIMARY KEY, type TEXT NOT NULL, data BLOB NOT NULL, updated_at INTEGER NOT NULL)");
			sql.exec("INSERT INTO pim_persona_icons VALUES ('p_1', 'image/png', x'00', 7)");
			sql.exec("CREATE TABLE pim_persona_sessions (session TEXT PRIMARY KEY, persona TEXT NOT NULL)");
			sql.exec("INSERT INTO pim_persona_sessions VALUES ('9', 'p_1')");
			sql.exec(`CREATE TABLE pim_team_runs (conversation TEXT PRIMARY KEY, call TEXT NOT NULL, position INTEGER NOT NULL, session TEXT NOT NULL, persona TEXT NOT NULL,
				member TEXT NOT NULL, task TEXT NOT NULL, status TEXT NOT NULL, report TEXT, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL)`);
			sql.exec("INSERT INTO pim_team_runs VALUES ('c1', 'k', 0, '9', 'p_1', 'Editor', 'Fix it', 'done', NULL, 1, 1)");

			const agents = new AgentStore(sql, () => {
				throw new Error("the default exists, so no starter is needed");
			});
			expect(agents.list()).toMatchObject([{ id: "p_1", name: "Coach", blueprint: "test.ledger/budget", default: true, icon: 7 }]);
			expect(agents.ofSession("9").id).toBe("p_1");
			expect(new TeamStore(sql).run("c1")).toMatchObject({ agent: "p_1", member: "Editor" });
			// Starting again changes nothing.
			expect(new AgentStore(sql, () => { throw new Error("unused"); }).list()).toHaveLength(1);
		});
	});
});
