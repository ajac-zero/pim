import type { JsonValue, Message } from "@earendil-works/pi-ai";
import { describe, expect, it } from "vitest";
import { env, runInDurableObject } from "cloudflare:test";
import { exports } from "cloudflare:workers";
import { AgentStore } from "../src/agents";
import { TeamStore } from "../src/team";
import { CREATE_AGENT, RENAME_AGENT, UPDATE_AGENT } from "../src/extensions/agents";
import { WRITE_SKILL } from "../src/extensions/skills";
import { api, apiUrl, decisionRun, lastUserText, pendingApproval, post, say, TOKEN, toolUse } from "./helpers";
import { faux } from "./worker";

/** The prompt sections sent last: pi sends the whole prompt once, then only what changed. */
const system = (messages: readonly Message[]) => JSON.stringify(messages.filter((message) => message.role === "system").at(-1));

describe("the owner's agents", () => {
	it("talks in every chat as the chat's agent, or the majordomo, as each is at each request", async () => {
		// Every account has its majordomo: plain until named, and there to stay.
		const [mine] = (await api("/agents")).body.agents;
		expect(mine).toMatchObject({ name: "Majordomo", instructions: "", majordomo: true, source: null });
		expect((await api(`/agents/${mine.id}`, { method: "DELETE" })).status).toBe(400);

		expect((await post("/agents", { name: "", instructions: "x" })).status).toBe(400);
		expect((await post("/agents", { name: "Coach", instructions: "x", apps: [{ name: "Cal", url: "https://plain.test/mcp" }] })).status).toBe(400);
		// Only apps this Pim offers.
		expect((await post("/agents", { name: "Coach", instructions: "x", apps: ["custom/nope"] })).status).toBe(400);
		const coach = (
			await post("/agents", {
				name: "Marathon coach",
				description: "Plans my training.",
				instructions: "Answer every question with a training tip.",
				apps: ["test.ledger/strava"],
			})
		).body;
		expect(coach).toMatchObject({ id: expect.stringMatching(/^p_/), source: null, published: null, majordomo: false });
		expect((await api("/agents")).body.agents.map((agent: { name: string }) => agent.name)).toEqual(["Majordomo", "Marathon coach"]);
		expect((await post("/sessions", { agent: "p_nope" })).status).toBe(404);
		const session = (await post("/sessions", { agent: coach.id })).body;
		expect(session.agent).toEqual({ id: coach.id, name: "Marathon coach" });
		expect((await post("/sessions", {})).body.agent).toEqual({ id: mine.id, name: "Majordomo" });

		const prompts: string[] = [];
		const record = (context: { messages: Message[] }) => {
			prompts.push(system(context.messages));
			return toolUse("send_to_user", { message: "ok" });
		};
		faux.setResponses([record, record]);
		await say("How far today?", session.id);
		await say("Hello", "1");
		expect(prompts[0]).toContain('In this conversation you are \\"Marathon coach\\"');
		expect(prompts[0]).toContain("Answer every question with a training tip.");
		expect(prompts[1]).toContain('In this conversation you are \\"Majordomo\\".');
		expect(prompts[1]).not.toContain("training tip");

		// Edited, an agent's chats follow from their next request: the majordomo's are every chat not started with another.
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

		// Deleted, its chats stay, with the majordomo.
		expect((await api(`/agents/${coach.id}`, { method: "DELETE" })).body).toEqual({ deleted: true });
		faux.setResponses([record]);
		await say("Still there?", session.id);
		expect(prompts[4]).toContain("Sign off with -S.");
		expect(prompts[4]).not.toContain("haiku");
		expect((await api("/agents")).body.agents).toEqual([expect.objectContaining({ id: mine.id, name: "Sam", majordomo: true })]);
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

	it("shows each agent with a chosen icon or emoji, in a chosen color", async () => {
		const runner = (await post("/agents", { name: "Runner", symbol: "🏃🏽‍♀️", color: "teal" })).body;
		expect(runner).toMatchObject({ symbol: "🏃🏽‍♀️", color: "teal" });
		expect((await post("/agents", { name: "Plain" })).body).toMatchObject({ symbol: null, color: null });
		const put = (body: Record<string, unknown>) => api(`/agents/${runner.id}`, { method: "PUT", body: JSON.stringify(body) });
		// An edit that leaves them out keeps them.
		expect((await put({ description: "Runs" })).body).toMatchObject({ symbol: "🏃🏽‍♀️", color: "teal" });
		expect((await put({ symbol: "rocket" })).body).toMatchObject({ symbol: "rocket", color: "teal" });
		for (const symbol of ["🏃🏃", "hi there", "a😀", "<svg>", "Rocket"]) expect((await put({ symbol })).status).toBe(400);
		expect((await put({ color: "#ff0000" })).status).toBe(400);
		expect((await put({ symbol: null, color: null })).body).toMatchObject({ symbol: null, color: null });
		expect((await api(`/agents/${runner.id}/dashboard`)).body.agent).toMatchObject({ symbol: null, color: null });
	});

	it("knows the person's other agents, and makes one none of them covers", async () => {
		const planner = (await post("/agents", { name: "Trip planner", description: "Plans my trips." })).body;
		const session = (await post("/sessions", { agent: planner.id })).body.id;
		const seen: { prompt: string; result: string }[] = [];
		const record = (context: { messages: Message[] }) => {
			seen.push({ prompt: system(context.messages), result: JSON.stringify(context.messages.findLast((m) => m.role === "toolResult")?.content) });
			return toolUse("send_to_user", { message: "ok" });
		};
		const reviewer = {
			name: "Code reviewer",
			description: "Reviews my pull requests.",
			instructions: "Point out bugs before style.",
			apps: ["test.ledger/github"],
			team: [{ name: "Linter", instructions: "Flag style issues.", tools: ["fetch_url"] }],
			emoji: "🧐",
			color: "indigo",
		};
		faux.setResponses([
			record,
			toolUse(CREATE_AGENT, { ...reviewer, apps: ["custom/github"] }),
			record,
			toolUse(CREATE_AGENT, { ...reviewer, emoji: "a sticker" }),
			record,
			toolUse(CREATE_AGENT, reviewer),
			record,
			toolUse(CREATE_AGENT, { ...reviewer, name: " code REVIEWER ", instructions: "Something else." }),
			record,
		]);
		await say("Hi", session);
		expect(seen[0]!.prompt).toContain("- Trip planner (you): Plans my trips.");
		expect(seen[0]!.prompt).toMatch(/- [^\\]+ \(their majordomo\) \[id/);

		// Refused as the API refuses it: nothing made.
		await say("Make me a code reviewer", session);
		expect(seen[1]!.result).toContain("This Pim offers no app custom/github");
		await say("Try again", session);
		expect(seen[2]!.result).toContain("symbol must be an icon's name");
		expect((await api("/agents")).body.agents.some((agent: { name: string }) => agent.name === "Code reviewer")).toBe(false);
		await say("Once more", session);
		expect(seen[3]!.result).toContain('\\"created\\": true');
		const made = (await api("/agents")).body.agents.find((agent: { name: string }) => agent.name === "Code reviewer");
		const { emoji, ...given } = reviewer;
		expect(made).toMatchObject({ ...given, symbol: emoji, color: "indigo", majordomo: false, source: null });
		// One the person has already isn't made again, whatever its case.
		await say("And another code reviewer", session);
		expect(seen[4]!.result).toContain('\\"exists\\": true');
		expect((await api("/agents")).body.agents.filter((agent: { name: string }) => agent.name === "Code reviewer")).toHaveLength(1);
		expect(seen[4]!.prompt).toContain("- Code reviewer: Reviews my pull requests.");
	});

	it("renames another agent or itself in chat only after approval, keeping its identity and settings", async () => {
		await api("/settings", { method: "PUT", body: JSON.stringify({ approvalPolicy: "explicit" }) });
		const creator = (await post("/agents", { name: "Organizer", instructions: "Organize my work." })).body;
		const session = (await post("/sessions", { agent: creator.id })).body.id;
		faux.setResponses([
			toolUse(CREATE_AGENT, { name: "Draft helper", description: "Writes drafts.", instructions: "Write clearly." }),
			toolUse("send_to_user", { message: "Created." }),
		]);
		await say("Make a writing assistant", session);
		const target = (await api("/agents")).body.agents.find((agent: { name: string }) => agent.name === "Draft helper");
		const targetSession = (await post("/sessions", { agent: target.id })).body.id;

		faux.setResponses([
			toolUse(RENAME_AGENT, { agent: target.id, name: "  Quill  " }),
			toolUse("send_to_user", { message: "Waiting for approval." }),
		]);
		await say("Rename the assistant you just made to Quill", session);
		const approval = await pendingApproval();
		expect(approval.summary).toBe('Rename "Draft helper" to "Quill"');
		expect((await api(`/agents/${target.id}`)).body.name).toBe("Draft helper");
		// Approval changes only the name, retaining edits made while it was waiting.
		await api(`/agents/${target.id}`, { method: "PUT", body: JSON.stringify({ instructions: "Use short paragraphs." }) });
		faux.setResponses([toolUse("send_to_user", { message: "Renamed." })]);
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
			return toolUse("send_to_user", { message: "Hello." });
		}]);
		await say("What is your name?", targetSession);
		expect(prompt).toContain('you are \\"Quill\\"');
		expect(prompt).toContain("Use short paragraphs.");

		// The same tool can rename the agent in this chat; denying it leaves the name alone.
		for (const decision of ["deny", "approve"]) {
			faux.setResponses([toolUse(RENAME_AGENT, { agent: creator.id, name: "Atlas" }), toolUse("send_to_user", { message: "Waiting." })]);
			await say("Call yourself Atlas", session);
			const request = await pendingApproval();
			faux.setResponses([toolUse("send_to_user", { message: "Understood." })]);
			await post(`/approvals/${request.id}/${decision}`);
			expect(await decisionRun(request)).toMatchObject({ status: "done" });
			expect((await api(`/agents/${creator.id}`)).body.name).toBe(decision === "approve" ? "Atlas" : "Organizer");
		}
		// Renaming has its own permission, separate from changing instructions and apps.
		await api("/permissions", { method: "PUT", body: JSON.stringify({ tool: RENAME_AGENT, permission: "on" }) });
		faux.setResponses([toolUse(RENAME_AGENT, { agent: target.id, name: "Scribe" }), toolUse("send_to_user", { message: "Renamed." })]);
		await say("Call Quill Scribe instead", session);
		expect((await api(`/agents/${target.id}`)).body.name).toBe("Scribe");
		expect((await api("/approvals?status=pending")).body.approvals).toEqual([]);
		await api("/permissions", { method: "PUT", body: JSON.stringify({ tool: RENAME_AGENT, permission: "off" }) });
		const fresh = (await post("/sessions", { agent: creator.id })).body.id;
		let tools: string[] = [];
		faux.setResponses([(context) => {
			tools = context.messages.flatMap((message) => message.role === "system" ? (message.toolsAdded ?? []).map((tool) => tool.name) : []);
			return toolUse("send_to_user", { message: "Hello." });
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
				apps: ["test.ledger/docs"],
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
			return toolUse("send_to_user", { message: "ok" });
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
				return toolUse("send_to_user", { message: "Done." });
			},
		]);
		await post(`/approvals/${approval.id}/approve`);
		expect(await decisionRun(approval)).toMatchObject({ status: "done" });
		expect((await api(`/agents/${writer.id}`)).body).toMatchObject({
			instructions: "Write long.",
			apps: ["test.ledger/docs"],
			team: [
				{ name: "Editor", instructions: "Fix grammar and tone.", tools: null },
				{ name: "Researcher", instructions: "Find sources.", tools: ["fetch_url"] },
			],
		});
		expect(prompt).toContain("Write long.");
		expect(prompt).toContain("- Researcher: Find sources.");
		await api("/settings", { method: "PUT", body: JSON.stringify({ approvalPolicy: null }) });
	});

	it("saves a skill it writes once the person approves, and loads it in its own chats", async () => {
		await api("/settings", { method: "PUT", body: JSON.stringify({ approvalPolicy: "explicit" }) });
		const coach = (await post("/agents", { name: "Coach", instructions: "Coach my running." })).body;
		const chef = (await post("/agents", { name: "Chef", instructions: "Plan meals." })).body;
		const session = (await post("/sessions", { agent: coach.id })).body.id;
		const results: string[] = [];
		const record = (context: { messages: Message[] }) => {
			results.push(JSON.stringify(context.messages.findLast((m) => m.role === "toolResult")?.content));
			return toolUse("send_to_user", { message: "ok" });
		};
		const skill = {
			name: "weekly-plan",
			description: "Plan the week's runs.",
			instructions: "1. Read last week's runs.\n2. Add 10% distance, with scripts/paces.js.",
			files: [{ path: "scripts/paces.js", content: "export const easy = (race) => race * 1.25;" }],
		};
		faux.setResponses([toolUse(WRITE_SKILL, { ...skill, name: "Weekly Plan" }), record]);
		await say("Remember how we plan my week", session);
		expect(results[0]).toContain("lowercase letters, digits and single hyphens");
		faux.setResponses([toolUse(WRITE_SKILL, { ...skill, files: [{ path: "../notes.md", content: "Mine." }] }), record]);
		await say("Keep my notes with it", session);
		expect(results[1]).toContain("../notes.md is not a supporting file's path");

		faux.setResponses([toolUse(WRITE_SKILL, skill), toolUse("send_to_user", { message: "Asked." })]);
		await say("Try again", session);
		const approval = await pendingApproval();
		expect(approval.summary).toBe("Coach saves a new skill: weekly-plan");
		// The person reads what they approve.
		expect(approval.args).toMatchObject({ instructions: skill.instructions, description: skill.description, files: skill.files });
		expect((await api("/skills")).body.skills).toEqual([]);
		faux.setResponses([toolUse("send_to_user", { message: "Saved." })]);
		await post(`/approvals/${approval.id}/approve`);
		expect(await decisionRun(approval)).toMatchObject({ status: "done" });
		expect((await api("/skills")).body.skills).toEqual([
			{ name: "weekly-plan", description: skill.description, version: 1, author: "Coach", restoredFrom: null, createdAt: expect.any(Number), updatedAt: expect.any(Number), agents: [{ id: coach.id, name: "Coach" }] },
		]);

		// The agent that wrote it lists it and loads it; another agent doesn't see it.
		let prompt = "";
		faux.setResponses([
			(context) => {
				prompt = system(context.messages);
				return toolUse("read_skill", { skill: "weekly-plan" });
			},
			(context) => {
				record(context);
				return toolUse("read_skill_file", { skill: "weekly-plan", path: "scripts/paces.js" });
			},
			record,
		]);
		await say("Plan my week", (await post("/sessions", { agent: coach.id })).body.id);
		expect(prompt).toContain("- weekly-plan: Plan the week's runs.");
		expect(results[2]).toContain("version 1");
		expect(results[2]).toContain("2. Add 10% distance");
		expect(results[2]).toContain("Supporting files (read with read_skill_file): scripts/paces.js");
		expect(results[3]).toContain("export const easy = (race) => race * 1.25;");
		faux.setResponses([
			(context) => {
				prompt = system(context.messages);
				return toolUse("send_to_user", { message: "Hello." });
			},
		]);
		await say("Hi", (await post("/sessions", { agent: chef.id })).body.id);
		expect(prompt).toContain("You have no skills yet.");
		expect(prompt).not.toContain("weekly-plan");

		// Two rewrites of the same version: the one approved second finds the skill changed and changes nothing.
		for (const [message, instructions] of [["Make it 5%", "Add 5% distance."], ["No, 20%", "Add 20% distance."]]) {
			const { files: _kept, ...rewrite } = skill;
			faux.setResponses([toolUse(WRITE_SKILL, { ...rewrite, instructions: instructions!, base_version: 1 }), toolUse("send_to_user", { message: "Asked." })]);
			await say(message!, session);
		}
		const pending = (await api("/approvals?status=pending")).body.approvals;
		const [five, twenty] = ["Add 5% distance.", "Add 20% distance."].map((wanted) => pending.find((request: { args: { instructions: string } }) => request.args.instructions === wanted));
		expect(twenty.summary).toBe("Coach rewrites the skill weekly-plan");
		let told = "";
		faux.setResponses([
			toolUse("send_to_user", { message: "Saved." }),
			(context) => {
				told = lastUserText(context.messages);
				return toolUse("send_to_user", { message: "Kept 20%." });
			},
		]);
		for (const request of [twenty, five]) {
			await post(`/approvals/${request.id}/approve`);
			expect(await decisionRun(request)).toMatchObject({ status: "done" });
		}
		expect(told).toContain("is at version 2 now, not 1");
		expect((await api("/skills/weekly-plan")).body).toMatchObject({
			instructions: "Add 20% distance.",
			version: 2,
			// A rewrite that gives no files keeps them.
			files: skill.files,
			history: [
				{ version: 2, author: "Coach", restoredFrom: null },
				{ version: 1, author: "Coach", restoredFrom: null },
			],
		});

		// The person restores an older version as a new one, from the version they saw.
		expect((await api("/skills/weekly-plan/versions/1")).body.instructions).toBe(skill.instructions);
		const restore = (baseVersion: number) => post("/skills/weekly-plan/restore", { version: 1, baseVersion });
		expect((await restore(1)).status).toBe(409);
		const restored = await restore(2);
		expect(restored.status).toBe(201);
		expect(restored.body).toMatchObject({ instructions: skill.instructions, files: skill.files, version: 3, history: [{ version: 3, author: null, restoredFrom: 1 }, { version: 2 }, { version: 1 }] });

		// The person gives skills to agents and deletes them.
		expect((await api(`/agents/${chef.id}`, { method: "PUT", body: JSON.stringify({ skills: ["meal-prep"] }) })).status).toBe(400);
		expect((await api(`/agents/${chef.id}`, { method: "PUT", body: JSON.stringify({ skills: ["weekly-plan"] }) })).body.skills).toEqual(["weekly-plan"]);
		expect((await api("/skills/weekly-plan", { method: "DELETE" })).status).toBe(200);
		expect((await api(`/agents/${coach.id}`)).body.skills).toEqual([]);
		expect((await api(`/agents/${chef.id}`)).body.skills).toEqual([]);
		expect((await api("/skills/weekly-plan")).status).toBe(404);
		await api("/settings", { method: "PUT", body: JSON.stringify({ approvalPolicy: null }) });
	});
});

describe("a database from when agents were personas", () => {
	it("is renamed in place, keeping its agents, icons, chats, team runs, and the apps it listed by URL that the directory has", async () => {
		await runInDurableObject(env.Pim.getByName("legacy"), async (_instance, state) => {
			const sql = state.storage.sql;
			for (const table of ["pim_agents", "pim_agent_icons", "pim_agent_sessions", "pim_team_runs"]) sql.exec(`DROP TABLE ${table}`);
			sql.exec(`CREATE TABLE pim_personas (id TEXT PRIMARY KEY, name TEXT NOT NULL, description TEXT NOT NULL, instructions TEXT NOT NULL, apps TEXT NOT NULL,
				source TEXT, published TEXT, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, is_default INTEGER NOT NULL DEFAULT 0, team TEXT NOT NULL DEFAULT '[]', base TEXT)`);
			sql.exec(`INSERT INTO pim_personas VALUES ('p_1', 'Coach', 'Runs', 'Be brief.', '[{"name":"Runs","url":"https://mcp.strava.example/mcp"},{"name":"Gone","url":"https://gone.example/mcp"}]', NULL, NULL, 1, 1, 1, '[]', 'test.ledger/budget')`);
			sql.exec("CREATE TABLE pim_persona_icons (persona TEXT PRIMARY KEY, type TEXT NOT NULL, data BLOB NOT NULL, updated_at INTEGER NOT NULL)");
			sql.exec("INSERT INTO pim_persona_icons VALUES ('p_1', 'image/png', x'00', 7)");
			sql.exec("CREATE TABLE pim_persona_sessions (session TEXT PRIMARY KEY, persona TEXT NOT NULL)");
			sql.exec("INSERT INTO pim_persona_sessions VALUES ('9', 'p_1')");
			sql.exec(`CREATE TABLE pim_team_runs (conversation TEXT PRIMARY KEY, call TEXT NOT NULL, position INTEGER NOT NULL, session TEXT NOT NULL, persona TEXT NOT NULL,
				member TEXT NOT NULL, task TEXT NOT NULL, status TEXT NOT NULL, report TEXT, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL)`);
			sql.exec("INSERT INTO pim_team_runs VALUES ('c1', 'k', 0, '9', 'p_1', 'Editor', 'Fix it', 'done', NULL, 1, 1)");

			const directory = () => [{ ref: "test.ledger/strava", name: "Strava", description: "", url: "https://mcp.strava.example/mcp", custom: false, icon: null, category: null }];
			const agents = new AgentStore(
				sql,
				() => {
					throw new Error("the majordomo exists, so no starter is needed");
				},
				directory,
			);
			expect(agents.list()).toMatchObject([{ id: "p_1", name: "Coach", blueprint: "test.ledger/budget", majordomo: true, icon: 7, apps: ["test.ledger/strava"] }]);
			// Its default agent is its majordomo, already named: nobody is asked to name theirs again.
			expect(agents.introduced()).toBe(true);
			expect(agents.ofSession("9").id).toBe("p_1");
			expect(new TeamStore(sql).run("c1")).toMatchObject({ kind: "member", agent: "p_1", member: "Editor" });
			// Starting again changes nothing.
			expect(new AgentStore(sql, () => { throw new Error("unused"); }, directory).list()).toHaveLength(1);
		});
	});
});
