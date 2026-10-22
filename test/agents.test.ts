import type { JsonValue, Message } from "@earendil-works/pi-ai";
import { describe, expect, it, vi } from "vitest";
import { env, runInDurableObject } from "cloudflare:test";
import { exports } from "cloudflare:workers";
import { AgentStore } from "../src/agents";
import { TaskStore } from "../src/tasks";
import { CREATE_AGENT, RENAME_AGENT, UPDATE_AGENT } from "../src/extensions/agents";
import { INSTALL_SKILL, WRITE_SKILL } from "../src/extensions/skills";
import { api, apiUrl, OWNER, pairTestComputer, pendingApproval, post, ROOT, say, TOKEN, toolUse } from "./helpers";
import { faux, type Pim } from "./worker";

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
		await say("Hello", ROOT);
		expect(prompts[0]).toContain('In this conversation you are \\"Marathon coach\\"');
		expect(prompts[0]).toContain("Answer every question with a training tip.");
		expect(prompts[1]).toContain('In this conversation you are \\"Majordomo\\".');
		expect(prompts[1]).not.toContain("training tip");

		// Edited, an agent's chats follow from their next request: the majordomo's are every chat not started with another.
		await api(`/agents/${coach.id}`, { method: "PUT", body: JSON.stringify({ instructions: "Speak only in haiku." }) });
		await api(`/agents/${mine.id}`, { method: "PUT", body: JSON.stringify({ name: "Sam", instructions: "Sign off with -S." }) });
		faux.setResponses([record, record]);
		await say("And tomorrow?", session.id);
		await say("Hi again", ROOT);
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
			contacts: ["trip PLANNER"],
			emoji: "🧐",
			color: "indigo",
		};
		faux.setResponses([
			record,
			toolUse(CREATE_AGENT, { ...reviewer, apps: ["custom/github"] }),
			record,
			toolUse(CREATE_AGENT, { ...reviewer, contacts: ["Linter"] }),
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
		await say("Hand linting to someone", session);
		expect(seen[2]!.result).toContain("The person has no agent called Linter.");
		await say("Try again", session);
		expect(seen[3]!.result).toContain("symbol must be an icon's name");
		expect((await api("/agents")).body.agents.some((agent: { name: string }) => agent.name === "Code reviewer")).toBe(false);
		await say("Once more", session);
		expect(seen[4]!.result).toContain('\\"created\\": true');
		expect(seen[4]!.result).toContain("Trip planner");
		const made = (await api("/agents")).body.agents.find((agent: { name: string }) => agent.name === "Code reviewer");
		const { emoji, contacts: _contacts, ...given } = reviewer;
		expect(made).toMatchObject({ ...given, contacts: [planner.id], symbol: emoji, color: "indigo", majordomo: false, source: null });
		// One the person has already isn't made again, whatever its case.
		await say("And another code reviewer", session);
		expect(seen[5]!.result).toContain('\\"exists\\": true');
		expect((await api("/agents")).body.agents.filter((agent: { name: string }) => agent.name === "Code reviewer")).toHaveLength(1);
		expect(seen[5]!.prompt).toContain("- Code reviewer: Reviews my pull requests.");
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
			toolUse("send_to_user", { message: "Renamed." }),
		]);
		const renaming = say("Rename the assistant you just made to Quill", session);
		const approval = await pendingApproval();
		expect(approval.summary).toBe('Rename "Draft helper" to "Quill"');
		expect((await api(`/agents/${target.id}`)).body.name).toBe("Draft helper");
		// Approval changes only the name, retaining edits made while it was waiting.
		await api(`/agents/${target.id}`, { method: "PUT", body: JSON.stringify({ instructions: "Use short paragraphs." }) });
		await post(`/approvals/${approval.id}/approve`);
		expect(await renaming).toMatchObject({ status: "done", replies: ["Renamed."] });
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
			faux.setResponses([toolUse(RENAME_AGENT, { agent: creator.id, name: "Atlas" }), toolUse("send_to_user", { message: "Understood." })]);
			const asking = say("Call yourself Atlas", session);
			const request = await pendingApproval();
			await post(`/approvals/${request.id}/${decision}`);
			expect(await asking).toMatchObject({ status: "done", replies: ["Understood."] });
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

	it("changes itself, its contacts included, once the person approves", async () => {
		await api("/settings", { method: "PUT", body: JSON.stringify({ approvalPolicy: "explicit" }) });
		const editor = (await post("/agents", { name: "Editor", instructions: "Fix grammar." })).body;
		const checker = (await post("/agents", { name: "Fact checker", instructions: "Check every claim." })).body;
		const finder = (await post("/agents", { name: "Source finder", description: "Finds sources.", instructions: "Find sources." })).body;
		const writer = (
			await post("/agents", { name: "Ghostwriter", instructions: "Write short.", apps: ["test.ledger/docs"], contacts: [editor.id, checker.id] })
		).body;
		const session = (await post("/sessions", { agent: writer.id })).body.id;
		const results: string[] = [];
		const record = (context: { messages: Message[] }) => {
			results.push(JSON.stringify(context.messages.findLast((m) => m.role === "toolResult")?.content));
			return toolUse("send_to_user", { message: "ok" });
		};
		const edit: Record<string, JsonValue> = { instructions: "Write long.", add_contacts: ["source FINDER", "editor"], remove_contacts: ["Fact checker"] };
		let prompt = "";
		faux.setResponses([
			toolUse(UPDATE_AGENT, { add_contacts: ["Researcher"] }),
			record,
			toolUse(UPDATE_AGENT, { add_contacts: ["Ghostwriter"] }),
			record,
			toolUse(UPDATE_AGENT, { instructions: "Write short.", add_contacts: ["Editor"] }),
			record,
			toolUse(UPDATE_AGENT, edit),
			// The turn goes on as the agent is now.
			(context) => {
				prompt = system(context.messages);
				return toolUse("send_to_user", { message: "Done." });
			},
		]);
		await say("Bring on a researcher", session);
		expect(results[0]).toContain("The person has no agent called Researcher.");
		await say("Hand tasks to yourself", session);
		expect(results[1]).toContain("contacts can't include the agent itself");
		await say("Again?", session);
		expect(results[2]).toContain("That changes nothing.");
		const asking = say("Please", session);
		const approval = await pendingApproval();
		expect(approval.summary).toBe("Ghostwriter changes its instructions, adds Source finder to its contacts, to hand tasks to, removes Fact checker from its contacts");
		// Nothing changes until the person says yes.
		expect((await api(`/agents/${writer.id}`)).body.instructions).toBe("Write short.");

		await post(`/approvals/${approval.id}/approve`);
		expect(await asking).toMatchObject({ status: "done", replies: ["Done."] });
		expect((await api(`/agents/${writer.id}`)).body).toMatchObject({
			instructions: "Write long.",
			apps: ["test.ledger/docs"],
			contacts: [editor.id, finder.id],
		});
		expect(prompt).toContain("Write long.");
		expect(prompt).toContain("- Source finder: Finds sources.");
		expect(prompt).not.toContain("- Fact checker");
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

		faux.setResponses([toolUse(WRITE_SKILL, skill), toolUse("send_to_user", { message: "Saved." })]);
		const saving = say("Try again", session);
		const approval = await pendingApproval();
		expect(approval.summary).toBe("Coach saves a new skill: weekly-plan");
		// The person reads what they approve.
		expect(approval.args).toMatchObject({ instructions: skill.instructions, description: skill.description, files: skill.files });
		expect((await api("/skills")).body.skills).toEqual([]);
		await post(`/approvals/${approval.id}/approve`);
		expect(await saving).toMatchObject({ status: "done", replies: ["Saved."] });
		expect((await api("/skills")).body.skills).toEqual([
			{ name: "weekly-plan", description: skill.description, version: 1, author: "Coach", restoredFrom: null, source: null, createdAt: expect.any(Number), updatedAt: expect.any(Number), agents: [{ id: coach.id, name: "Coach" }] },
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

		// Two rewrites of the same version, in two chats: the one approved second finds the skill changed and changes nothing.
		let told = "";
		const { files: _kept, ...rewrite } = skill;
		const rewriting: Record<string, Promise<unknown>> = {};
		for (const [message, instructions] of [["Make it 5%", "Add 5% distance."], ["No, 20%", "Add 20% distance."]]) {
			faux.setResponses([toolUse(WRITE_SKILL, { ...rewrite, instructions: instructions!, base_version: 1 })]);
			rewriting[instructions!] = say(message!, (await post("/sessions", { agent: coach.id })).body.id);
			await vi.waitFor(async () => expect((await api("/approvals?status=pending")).body.approvals).toHaveLength(Object.keys(rewriting).length));
		}
		const pending = (await api("/approvals?status=pending")).body.approvals;
		const [five, twenty] = ["Add 5% distance.", "Add 20% distance."].map((wanted) => pending.find((request: { args: { instructions: string } }) => request.args.instructions === wanted));
		expect(twenty.summary).toBe("Coach rewrites the skill weekly-plan");
		faux.setResponses([toolUse("send_to_user", { message: "Saved." })]);
		await post(`/approvals/${twenty.id}/approve`);
		expect(await rewriting["Add 20% distance."]).toMatchObject({ status: "done", replies: ["Saved."] });
		faux.setResponses([
			(context) => {
				told = JSON.stringify(context.messages.findLast((m) => m.role === "toolResult")?.content);
				return toolUse("send_to_user", { message: "Kept 20%." });
			},
		]);
		await post(`/approvals/${five.id}/approve`);
		expect(await rewriting["Add 5% distance."]).toMatchObject({ status: "done", replies: ["Kept 20%."] });
		expect(told).toContain("is at version 2 now, not 1");
		const listed = [{ path: "scripts/paces.js", size: skill.files[0]!.content.length, type: "text/javascript" }];
		expect((await api("/skills/weekly-plan")).body).toMatchObject({
			instructions: "Add 20% distance.",
			version: 2,
			// A rewrite that gives no files keeps them, stored once for both versions.
			files: listed,
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
		expect(restored.body).toMatchObject({ instructions: skill.instructions, files: listed, version: 3, history: [{ version: 3, author: null, restoredFrom: 1 }, { version: 2 }, { version: 1 }] });
		const file = await exports.default.fetch(new Request(apiUrl("/skills/weekly-plan/versions/3/file?path=scripts/paces.js"), { headers: { Authorization: `Bearer ${TOKEN}` } }));
		expect(file.headers.get("content-type")).toBe("text/javascript; charset=utf-8");
		expect(await file.text()).toBe(skill.files[0]!.content);
		const stored = async () => (await env.BLOBS.list({ prefix: `${OWNER}/skills/` })).objects.map((object) => object.key);
		expect(await stored()).toHaveLength(1);
		// Each version keeps the whole skill, so one the space has no room for is refused before it is written.
		const setLimits = (room: number | null) =>
			runInDurableObject(env.Pim.getByName(OWNER), (instance: Pim) => instance.setLimits(room === null ? null : { storageBytes: instance.storedBytes() + room }));
		await setLimits(50);
		const refused = await restore(3);
		expect(refused).toMatchObject({ status: 429, body: { error: expect.stringContaining("storage quota") } });
		await setLimits(null);
		expect((await api("/skills/weekly-plan")).body.version).toBe(3);

		// The person gives skills to agents and deletes them.
		expect((await api(`/agents/${chef.id}`, { method: "PUT", body: JSON.stringify({ skills: ["meal-prep"] }) })).status).toBe(400);
		expect((await api(`/agents/${chef.id}`, { method: "PUT", body: JSON.stringify({ skills: ["weekly-plan"] }) })).body.skills).toEqual(["weekly-plan"]);
		expect((await api("/skills/weekly-plan", { method: "DELETE" })).status).toBe(200);
		expect(await stored()).toEqual([]);
		expect((await api(`/agents/${coach.id}`)).body.skills).toEqual([]);
		expect((await api(`/agents/${chef.id}`)).body.skills).toEqual([]);
		expect((await api("/skills/weekly-plan")).status).toBe(404);
		await api("/settings", { method: "PUT", body: JSON.stringify({ approvalPolicy: null }) });
	});

	it("copies the person's files into a skill as they approved them, and back out to their computer", async () => {
		await api("/settings", { method: "PUT", body: JSON.stringify({ approvalPolicy: "explicit" }) });
		await pairTestComputer();
		const raw = (path: string, init: RequestInit = {}) => exports.default.fetch(new Request(apiUrl(path), { ...init, headers: { Authorization: `Bearer ${TOKEN}` } }));
		const putFile = (path: string, bytes: Uint8Array) => raw(`/files/content?path=${path}`, { method: "PUT", body: bytes });
		const template = new Uint8Array([0x50, 0x4b, 3, 4, 0, 0xff, 0xfe, 7]);
		await putFile("/workspace/plan.docx", template);
		const coach = (await post("/agents", { name: "Planner", instructions: "Plan." })).body;
		const session = (await post("/sessions", { agent: coach.id })).body.id;
		let told = "";
		const record = (context: { messages: Message[] }) => {
			told = JSON.stringify(context.messages.findLast((m) => m.role === "toolResult")?.content);
			return toolUse("send_to_user", { message: "ok" });
		};
		const write = { name: "race-plan", description: "Plan a race.", instructions: "Fill in templates/plan.docx.", files: [{ path: "templates/plan.docx", from_file: "/workspace/plan.docx" }] };

		// The request names the copy's hash; a file changed before approval is not copied.
		faux.setResponses([toolUse(WRITE_SKILL, write), record]);
		let saving = say("Remember this plan", session);
		const first = await pendingApproval();
		expect(first.args).toMatchObject({ files: [{ path: "templates/plan.docx", from_file: "/workspace/plan.docx", sha256: expect.stringMatching(/^[0-9a-f]{64}$/), size: 8 }] });
		await putFile("/workspace/plan.docx", new Uint8Array([1, 2, 3]));
		await post(`/approvals/${first.id}/approve`);
		await saving;
		expect(told).toContain("changed after the person approved copying it");
		expect((await api("/skills/race-plan")).status).toBe(404);

		await putFile("/workspace/plan.docx", template);
		faux.setResponses([toolUse(WRITE_SKILL, write), record]);
		saving = say("Try again", session);
		await post(`/approvals/${(await pendingApproval()).id}/approve`);
		await saving;
		expect((await api("/skills/race-plan")).body.files).toEqual([{ path: "templates/plan.docx", size: 8, type: "application/octet-stream" }]);

		// An agent reads that it isn't text, and copies it to the person's files as it is.
		const results: string[] = [];
		faux.setResponses([
			toolUse("read_skill_file", { skill: "race-plan", path: "templates/plan.docx" }),
			(context) => {
				results.push(JSON.stringify(context.messages.findLast((m) => m.role === "toolResult")?.content));
				return toolUse("read_skill_file", { skill: "race-plan", path: "templates/plan.docx", save_to: "/workspace/out/plan.docx" });
			},
			(context) => {
				results.push(JSON.stringify(context.messages.findLast((m) => m.role === "toolResult")?.content));
				return toolUse("send_to_user", { message: "Copied." });
			},
		]);
		await say("Use the plan", session);
		expect(results[0]).toContain("binary file, 8 bytes");
		expect(results[1]).toContain("to /workspace/out/plan.docx (8 bytes)");
		expect(new Uint8Array(await (await raw("/files/content?path=/workspace/out/plan.docx")).arrayBuffer())).toEqual(template);
		await api("/skills/race-plan", { method: "DELETE" });
		await api("/settings", { method: "PUT", body: JSON.stringify({ approvalPolicy: null }) });
	});

	it("installs a skill someone published, from GitHub or the person's files, as its source has it", async () => {
		await api("/settings", { method: "PUT", body: JSON.stringify({ approvalPolicy: "explicit" }) });
		const commit = "0123456789abcdef0123456789abcdef01234567";
		const skillMd = `---
name: frontend-design
description: >
  Build distinctive interfaces,
  not generic ones.
license: Apache-2.0
---

# Frontend design

Read reference/fonts.md first.
`;
		const fonts = "Pair a display face with a plain one.\n";
		const raw = `https://raw.githubusercontent.com/acme/skills/${commit}/skills/frontend-design/`;
		const realFetch = globalThis.fetch;
		vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
			const url = new Request(input, init).url;
			if (url === "https://api.github.com/repos/acme/skills/commits/main") return new Response(commit);
			if (url === `https://api.github.com/repos/acme/skills/git/trees/${commit}?recursive=1`) {
				const tree = ["README.md", "skills/frontend-design/SKILL.md", "skills/frontend-design/reference/fonts.md", "skills/frontend-design/.DS_Store", "skills/other/SKILL.md"];
				return Response.json({ truncated: false, tree: tree.map((path) => ({ path, type: "blob", size: 40 })) });
			}
			if (url === `${raw}SKILL.md`) return new Response(skillMd);
			if (url === `${raw}reference/fonts.md`) return new Response(fonts);
			if (url.startsWith("https://api.github.com/") || url.startsWith("https://raw.githubusercontent.com/")) return new Response("Not Found", { status: 404 });
			return realFetch(input, init);
		});
		const agent = (await post("/agents", { name: "Designer", instructions: "Design." })).body;
		const session = (await post("/sessions", { agent: agent.id })).body.id;
		const results: string[] = [];
		const record = (context: { messages: Message[] }) => {
			results.push(JSON.stringify(context.messages.findLast((m) => m.role === "toolResult")?.content));
			return toolUse("send_to_user", { message: "ok" });
		};

		// From GitHub: the folder at the commit its branch is at now, its hidden files left out, with one request for all of it.
		faux.setResponses([toolUse(INSTALL_SKILL, { source: "https://github.com/acme/skills/tree/main/skills/frontend-design" }), record]);
		let installing = say("Use the frontend design skill from acme/skills", session);
		let approval = await pendingApproval();
		const source = `https://github.com/acme/skills/tree/${commit}/skills/frontend-design`;
		expect(approval.summary).toBe(`Designer installs the skill frontend-design from ${source}`);
		expect(approval.args).toEqual({
			agent: agent.id,
			name: "frontend-design",
			description: "Build distinctive interfaces, not generic ones.",
			instructions: "# Frontend design\n\nRead reference/fonts.md first.",
			files: [{ path: "reference/fonts.md", from_url: `${raw}reference/fonts.md`, sha256: expect.stringMatching(/^[0-9a-f]{64}$/), size: fonts.length }],
			source,
		});
		await post(`/approvals/${approval.id}/approve`);
		await installing;
		expect((await api("/skills/frontend-design")).body).toMatchObject({ version: 1, author: "Designer", source, files: [{ path: "reference/fonts.md", size: fonts.length }] });
		faux.setResponses([toolUse("read_skill", { skill: "frontend-design" }), record]);
		await say("Design my page", session);
		expect(results.at(-1)).toContain(`installed with their approval from ${source}`);

		// From the person's files: a folder on their computer, its frontmatter's quoted name read as YAML.
		await pairTestComputer();
		const putFile = (path: string, body: string | Uint8Array) =>
			exports.default.fetch(new Request(apiUrl(`/files/content?path=${path}`), { method: "PUT", body, headers: { Authorization: `Bearer ${TOKEN}` } }));
		const logo = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0, 1]);
		await putFile("/workspace/skills/deck/SKILL.md", '---\nname: "deck-style"\ndescription: \'Our slides\'\'s look.\'\n---\nUse assets/logo.png.\n');
		await putFile("/workspace/skills/deck/assets/logo.png", logo);
		await putFile("/workspace/skills/deck/.git/HEAD", "ref: main");
		faux.setResponses([toolUse(INSTALL_SKILL, { source: "/workspace/skills/deck" }), record]);
		installing = say("Install my deck skill", session);
		approval = await pendingApproval();
		expect(approval.args).toMatchObject({ name: "deck-style", description: "Our slides's look.", files: [{ path: "assets/logo.png", from_file: "/workspace/skills/deck/assets/logo.png", size: 6 }], source: "/workspace/skills/deck" });
		await post(`/approvals/${approval.id}/approve`);
		await installing;
		expect((await api("/skills/deck-style")).body.files).toEqual([{ path: "assets/logo.png", size: 6, type: "image/png" }]);

		// A folder without a SKILL.md is refused before anything is asked.
		faux.setResponses([toolUse(INSTALL_SKILL, { source: "/workspace/skills/deck/assets" }), record]);
		await say("Install the assets", session);
		expect(results.at(-1)).toContain("has no SKILL.md");
		for (const name of ["frontend-design", "deck-style"]) await api(`/skills/${name}`, { method: "DELETE" });
		vi.restoreAllMocks();
		await api("/settings", { method: "PUT", body: JSON.stringify({ approvalPolicy: null }) });
	});

	it("reads a skill saved before its files were in R2, and moves them there with its next version", async () => {
		const script = "print('5k in 25:00')\n";
		await runInDurableObject(env.Pim.getByName(OWNER), (_instance, state) => {
			const files = JSON.stringify([{ path: "scripts/pace.py", content: script }]);
			state.storage.sql.exec("INSERT INTO pim_skill_versions (name, version, description, instructions, files, author, restored_from, created_at) VALUES ('race-pace', 1, 'Race paces.', 'Run scripts/pace.py.', ?, 'Coach', NULL, 1)", files);
			state.storage.sql.exec("INSERT INTO pim_skills (name, version, created_at) VALUES ('race-pace', 1, 1)");
		});
		// A file of a type it has no name for is text when it reads as text.
		expect((await api("/skills/race-pace")).body.files).toEqual([{ path: "scripts/pace.py", size: script.length, type: "text/plain" }]);
		const read = (version: number) =>
			exports.default.fetch(new Request(apiUrl(`/skills/race-pace/versions/${version}/file?path=scripts/pace.py`), { headers: { Authorization: `Bearer ${TOKEN}` } })).then((response) => response.text());
		expect(await read(1)).toBe(script);
		expect((await post("/skills/race-pace/restore", { version: 1, baseVersion: 1 })).status).toBe(201);
		expect(await read(2)).toBe(script);
		expect((await env.BLOBS.list({ prefix: `${OWNER}/skills/` })).objects).toHaveLength(1);
		expect((await api("/skills/race-pace", { method: "DELETE" })).status).toBe(200);
		expect((await env.BLOBS.list({ prefix: `${OWNER}/skills/` })).objects).toEqual([]);
	});
});

describe("a database from when agents were personas", () => {
	it("is renamed in place, keeping its agents, icons, chats, team runs, and the apps it listed by URL that the directory has", async () => {
		await runInDurableObject(env.Pim.getByName("legacy"), async (_instance, state) => {
			const sql = state.storage.sql;
			for (const table of ["pim_agents", "pim_agent_icons", "pim_agent_sessions", "pim_tasks"]) sql.exec(`DROP TABLE IF EXISTS ${table}`);
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
			expect(new TaskStore(sql).of("c1")).toMatchObject({ kind: "agent", agent: "p_1", requester: "9", root: "9", state: "completed" });
			// Starting again changes nothing.
			expect(new AgentStore(sql, () => { throw new Error("unused"); }, directory).list()).toHaveLength(1);
		});
	});
});

describe("a database from when agents had teams", () => {
	it("makes each member an agent of its own, a contact of its agent, with its tasks and its agent's apps and permissions", async () => {
		await runInDurableObject(env.Pim.getByName("teams"), async (_instance, state) => {
			const sql = state.storage.sql;
			for (const table of ["pim_agents", "pim_agent_sessions", "pim_tasks", "pim_tool_permissions"]) sql.exec(`DELETE FROM ${table}`);
			sql.exec("ALTER TABLE pim_agents ADD COLUMN team TEXT NOT NULL DEFAULT '[]'");
			const insert = "INSERT INTO pim_agents (id, name, description, instructions, apps, skills, team, blueprint, color, created_at, updated_at, is_default) VALUES (?, ?, '', ?, ?, ?, ?, ?, ?, 1, 1, ?)";
			sql.exec(insert, "p_major", "Alfred", "", "[]", "[]", "[]", null, null, 1);
			sql.exec(insert, "p_writer", "Writer", "Write.", "[]", "[]", "[]", null, null, 0);
			const team = [
				{ name: "Researcher", instructions: "Find facts.\nCite them.", tools: ["fetch_url"] },
				{ name: "Writer", instructions: "Write it up.", tools: null },
			];
			sql.exec(insert, "p_plan", "Planner", "Plan.", '["test.ledger/github"]', '["weekly-plan"]', JSON.stringify(team), "test.ledger/budget", "teal", 0);
			sql.exec("INSERT INTO pim_tool_permissions (audience, app, tool, permission, updated_at) VALUES ('agent:p_plan', 'github', 'github_merge', 'off', 1)");
			const tasks = new TaskStore(sql);
			tasks.start({ kind: "agent", conversation: "c1", requester: "chat", parent: null, root: "chat", batch: "b", position: 0, agent: "p_plan", task: "Look it up." });
			sql.exec("UPDATE pim_tasks SET kind = 'member', member = 'Researcher' WHERE conversation = 'c1'");

			const agents = new AgentStore(sql, () => { throw new Error("unused"); }, () => []);
			const byName = Object.fromEntries(agents.list().map((agent) => [agent.name, agent]));
			// A member called as another agent is gets its agent's name after its own.
			expect(Object.keys(byName).sort()).toEqual(["Alfred", "Planner", "Researcher", "Writer", "Writer (Planner)"]);
			const researcher = byName.Researcher!;
			expect(researcher).toMatchObject({ description: "Find facts.", instructions: "Find facts.\nCite them.", skills: ["weekly-plan"], blueprint: "test.ledger/budget", color: "teal", contacts: [] });
			expect(byName.Planner!.contacts).toEqual([researcher.id, byName["Writer (Planner)"]!.id]);
			// What it did as a member is its own now.
			expect(tasks.of("c1")).toMatchObject({ kind: "agent", agent: researcher.id });
			expect(agents.ofSession("c1").id).toBe(researcher.id);
			const permissions = sql.exec("SELECT audience FROM pim_tool_permissions WHERE tool = 'github_merge' ORDER BY audience").toArray().map((row) => row.audience);
			expect(permissions).toEqual(expect.arrayContaining([`agent:${researcher.id}`, `agent:${byName["Writer (Planner)"]!.id}`, "agent:p_plan"]));
			// Starting again changes nothing.
			expect(new AgentStore(sql, () => { throw new Error("unused"); }, () => []).list()).toHaveLength(5);
		});
	});
});
