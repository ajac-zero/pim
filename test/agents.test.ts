import type { JsonValue, Message } from "@earendil-works/pi-ai";
import * as fs from "node:fs/promises";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { env, runInDurableObject } from "cloudflare:test";
import { exports } from "cloudflare:workers";
import { AgentStore } from "../src/agents";
import { TaskStore } from "../src/tasks";
import { CREATE_AGENT, UPDATE_AGENT } from "../src/extensions/agents";
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

	it("lets agents share a name but not a role, and the name changes without the role", async () => {
		const first = (await post("/agents", { name: "Ada", role: "Researcher" })).body;
		expect(first).toMatchObject({ name: "Ada", role: "Researcher" });
		// A second Ada is fine; a second researcher is not, whatever its case.
		const second = await post("/agents", { name: "Ada", role: "Editor" });
		expect(second).toMatchObject({ status: 201, body: { name: "Ada", role: "Editor" } });
		expect((await post("/agents", { name: "Grace", role: " researcher " })).status).toBe(409);
		expect((await api(`/agents/${second.body.id}`, { method: "PUT", body: JSON.stringify({ role: "RESEARCHER" }) })).status).toBe(409);
		// Without a role, it is the name, as agents were before roles; renaming then leaves it.
		const plain = (await post("/agents", { name: "Sage" })).body;
		expect(plain.role).toBe("Sage");
		expect((await api(`/agents/${plain.id}`, { method: "PUT", body: JSON.stringify({ name: "Sagan" }) })).body).toMatchObject({ name: "Sagan", role: "Sage" });
		expect((await post("/agents", { name: "Sage" })).status).toBe(409);
		// The majordomo keeps its role whatever it is named.
		const [majordomo] = (await api("/agents")).body.agents;
		expect((await api(`/agents/${majordomo.id}`, { method: "PUT", body: JSON.stringify({ name: "Jeeves", role: "Researcher" }) })).body).toMatchObject({ name: "Jeeves", role: "Majordomo" });
		await api(`/agents/${majordomo.id}`, { method: "PUT", body: JSON.stringify({ name: "Majordomo" }) });
		for (const agent of [first, second.body, plain]) await api(`/agents/${agent.id}`, { method: "DELETE" });
	});

	it("keeps an icon for each agent, only as a picture", async () => {
		const agent = (await post("/agents", { name: "Pacer" })).body;
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
		const major = (await post("/sessions", {})).body.id;
		faux.setResponses([
			toolUse(CREATE_AGENT, { name: "Draft helper", description: "Writes drafts.", instructions: "Write clearly." }),
			toolUse("send_to_user", { message: "Created." }),
		]);
		await say("Make a writing assistant", major);
		const target = (await api("/agents")).body.agents.find((agent: { name: string }) => agent.name === "Draft helper");
		const targetSession = (await post("/sessions", { agent: target.id })).body.id;

		faux.setResponses([
			toolUse(UPDATE_AGENT, { agent: target.id, name: "  Quill  " }),
			toolUse("send_to_user", { message: "Renamed." }),
		]);
		const renaming = say("Rename the assistant you just made to Quill", major);
		const approval = await pendingApproval();
		expect(approval.summary).toBe('Majordomo renames Draft helper to "Quill"');
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
			faux.setResponses([toolUse(UPDATE_AGENT, { name: "Atlas" }), toolUse("send_to_user", { message: "Understood." })]);
			const asking = say("Call yourself Atlas", session);
			const request = await pendingApproval();
			await post(`/approvals/${request.id}/${decision}`);
			expect(await asking).toMatchObject({ status: "done", replies: ["Understood."] });
			expect((await api(`/agents/${creator.id}`)).body.name).toBe(decision === "approve" ? "Atlas" : "Organizer");
		}
		// Only the majordomo changes another agent.
		faux.setResponses([toolUse(UPDATE_AGENT, { agent: target.id, instructions: "Be rude." }), (context) => {
			expect(JSON.stringify(context.messages.findLast((m) => m.role === "toolResult")?.content)).toContain("Only the person's majordomo");
			return toolUse("send_to_user", { message: "No." });
		}]);
		await say("Make Quill rude", session);
		expect((await api(`/agents/${target.id}`)).body.instructions).toBe("Use short paragraphs.");
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

	it("lets the majordomo give another agent an image from the person's files or the web as its icon, as the person approved it", async () => {
		await api("/settings", { method: "PUT", body: JSON.stringify({ approvalPolicy: "explicit" }) });
		await pairTestComputer();
		const raw = (path: string, init: RequestInit = {}) => exports.default.fetch(new Request(apiUrl(path), { ...init, headers: { Authorization: `Bearer ${TOKEN}` } }));
		const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3]);
		await raw("/files/content?path=/workspace/images/coach.png", { method: "PUT", body: png });
		await raw("/files/content?path=/workspace/notes.txt", { method: "PUT", body: new TextEncoder().encode("not an image") });
		const majordomo = (await api("/agents")).body.agents.find((agent: { majordomo: boolean }) => agent.majordomo);
		const coach = (await post("/agents", { name: "Running coach", instructions: "Coach my runs.", symbol: "rocket", color: "gray" })).body;
		const helper = (await post("/agents", { name: "Helper", instructions: "Help." })).body;
		const results: string[] = [];
		const record = (context: { messages: Message[] }) => {
			results.push(JSON.stringify(context.messages.findLast((m) => m.role === "toolResult")?.content));
			return toolUse("send_to_user", { message: "ok" });
		};

		// Only the majordomo changes another agent, and only to an image.
		faux.setResponses([toolUse(UPDATE_AGENT, { agent: coach.id, icon: "/workspace/images/coach.png" }), record]);
		await say("Give the coach a picture", (await post("/sessions", { agent: helper.id })).body.id);
		expect(results[0]).toContain("Only the person's majordomo changes their other agents.");
		faux.setResponses([toolUse(UPDATE_AGENT, { agent: coach.id, icon: "/workspace/notes.txt" }), record]);
		await say("Use my notes as the coach's icon", ROOT);
		expect(results[1]).toContain("An icon must be a PNG, JPEG, WebP or GIF image.");

		faux.setResponses([toolUse(UPDATE_AGENT, { agent: coach.id, emoji: "🏃", color: "teal", icon: "/workspace/images/coach.png" }), record]);
		let asking = say("Give the coach the picture I made", ROOT);
		const approval = await pendingApproval();
		expect(approval.summary).toBe(
			`${majordomo.name} makes Running coach's emoji 🏃, makes Running coach's color teal, makes Running coach's icon the image at /workspace/images/coach.png`,
		);
		expect((await api(`/agents/${coach.id}`)).body).toMatchObject({ icon: null, symbol: "rocket", color: "gray" });
		// The person sees the picture they're asked about.
		const preview = await raw(`/approvals/${approval.id}/icon`);
		expect(preview.headers.get("content-type")).toBe("image/png");
		expect(new Uint8Array(await preview.arrayBuffer())).toEqual(png);
		await post(`/approvals/${approval.id}/approve`);
		await asking;
		expect((await api(`/agents/${coach.id}`)).body).toMatchObject({ icon: expect.any(Number), symbol: "🏃", color: "teal", instructions: "Coach my runs." });
		const icon = await raw(`/agents/${coach.id}/icon`);
		expect(icon.headers.get("content-type")).toBe("image/png");
		expect(new Uint8Array(await icon.arrayBuffer())).toEqual(png);

		// An image on the web is set only if it is still the one the person approved.
		const gif = new Uint8Array([0x47, 0x49, 0x46, 0x38, 0x39, 0x61, 1, 0, 1, 0]);
		let served = gif;
		const realFetch = globalThis.fetch;
		vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
			const request = new Request(input, init);
			return request.url === "https://images.example.test/shoe.gif" ? new Response(served, { headers: { "content-type": "image/gif" } }) : realFetch(input, init);
		});
		try {
			for (const swapped of [true, false]) {
				served = gif;
				faux.setResponses([toolUse(UPDATE_AGENT, { agent: coach.id, icon: "https://images.example.test/shoe.gif" }), record]);
				asking = say("Use that shoe picture for the coach", ROOT);
				const request = await pendingApproval();
				if (swapped) {
					served = new Uint8Array([...gif, 9]);
					expect((await raw(`/approvals/${request.id}/icon`)).status).toBe(409);
				}
				await post(`/approvals/${request.id}/approve`);
				await asking;
			}
		} finally {
			vi.restoreAllMocks();
		}
		expect(results[3]).toContain("isn't the image the person approved");
		expect(new Uint8Array(await (await raw(`/agents/${coach.id}/icon`)).arrayBuffer())).toEqual(gif);

		// And it removes an image, to show the emoji again.
		faux.setResponses([toolUse(UPDATE_AGENT, { agent: coach.id, icon: null }), record]);
		asking = say("Take the coach's picture off", ROOT);
		const removal = await pendingApproval();
		expect(removal.summary).toBe(`${majordomo.name} removes Running coach's icon image`);
		await post(`/approvals/${removal.id}/approve`);
		await asking;
		expect((await api(`/agents/${coach.id}`)).body).toMatchObject({ icon: null, symbol: "🏃" });
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
			by: agent.id,
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

describe("skills the majordomo writes for other agents, and each agent's switch for skills", () => {
	let told = "";
	let tools: string[] = [];
	/** The model's last step: it reads the tool's result and the tools it was offered, then answers. */
	const record = (context: { messages: Message[] }) => {
		told = JSON.stringify(context.messages.findLast((m) => m.role === "toolResult")?.content);
		tools = context.messages.flatMap((message) => (message.role === "system" ? (message.toolsAdded ?? []).map((tool) => tool.name) : []));
		for (const message of context.messages) if (message.role === "system") for (const tool of message.toolsRemoved ?? []) tools = tools.filter((name) => name !== tool.name);
		return toolUse("send_to_user", { message: "ok" });
	};
	/** Calls a tool in a chat, and gives what it returned. */
	const ask = async (args: Record<string, JsonValue>, session: string, tool = WRITE_SKILL) => {
		faux.setResponses([toolUse(tool, args), record]);
		await say("Go on", session);
		return told;
	};
	const offeredIn = async (session: string) => {
		faux.setResponses([record]);
		await say("Hi", session);
		return tools;
	};
	type Decided = { id: string; summary: string; args: Record<string, unknown>; status: string; result: string | null };
	const approval = async (id: string): Promise<Decided> => (await api("/approvals")).body.approvals.find((found: { id: string }) => found.id === id);
	/** Files a request with a tool, and once it waits, does `meanwhile` and decides it. */
	const decide = async (args: Record<string, JsonValue>, session: string, options: { meanwhile?: () => Promise<unknown>; decision?: "approve" | "deny"; tool?: string } = {}) => {
		faux.setResponses([toolUse(options.tool ?? WRITE_SKILL, args), record]);
		const asking = say("Go on", session);
		const request = await pendingApproval();
		await options.meanwhile?.();
		await post(`/approvals/${request.id}/${options.decision ?? "approve"}`);
		await asking;
		return approval(request.id);
	};
	/**
	 * Files a request with write_skill and approves it, holding the approved
	 * write with `hold` until `change` is made: between the checks it starts
	 * with and the commit, so only the checks made as it commits see it.
	 */
	const approveWhile = async (args: Record<string, JsonValue>, session: string, hold: () => Promise<Gate>, change: () => Promise<unknown>) => {
		faux.setResponses([toolUse(WRITE_SKILL, args), record]);
		const asking = say("Go on", session);
		const request = await pendingApproval();
		const gate = await hold();
		const approving = post(`/approvals/${request.id}/approve`);
		await gate.reached;
		await change();
		gate.release();
		expect((await approving).status).toBe(200);
		await asking;
		return approval(request.id);
	};
	type Gate = { reached: Promise<void>; release: () => void };
	const gate = () => {
		const opened = { reach: () => {}, release: () => {} };
		const reached = new Promise<void>((resolve) => {
			opened.reach = resolve;
		});
		const released = new Promise<void>((resolve) => {
			opened.release = resolve;
		});
		return { reached, released, ...opened };
	};
	/** Holds the next skill file stored in R2 until released. */
	const holdStorage = async (): Promise<Gate> => {
		const { reached, released, reach, release } = gate();
		await runInDurableObject(env.Pim.getByName(OWNER), (instance: Pim) => {
			const bucket = (instance as unknown as { env: { BLOBS: R2Bucket } }).env.BLOBS;
			// One hold at a time: the one before is undone, so this one stores through the bucket itself.
			if (vi.isMockFunction(bucket.put)) vi.mocked(bucket.put).mockRestore();
			const put = bucket.put.bind(bucket);
			vi.spyOn(bucket, "put").mockImplementation(async (...args: Parameters<R2Bucket["put"]>) => {
				if (args[0].includes("/skills/")) {
					reach();
					await released;
				}
				return put(...args);
			});
		});
		return { reached, release };
	};
	const switchSkills = (agent: string, permission: string | null) =>
		api("/permissions", { method: "PUT", body: JSON.stringify({ agent, app: "", tool: WRITE_SKILL, permission }) });
	const writeSkill = (permission: string | null) => api("/permissions", { method: "PUT", body: JSON.stringify({ app: null, tool: WRITE_SKILL, permission }) });
	const version = async (name: string): Promise<number | null> => {
		const found = await api(`/skills/${name}`);
		return found.status === 404 ? null : found.body.version;
	};
	const skillsOf = async (id: string): Promise<string[]> => (await api(`/agents/${id}`)).body.skills;
	const plan = { name: "weekly-plan", description: "Plan the week's runs.", instructions: "Add 10% distance." };
	const meals = { name: "meal-prep", description: "Prep meals.", instructions: "Cook on Sunday." };

	type Cast = { id: string; name: string; chat: string };
	let made: string[] = [];
	let cast = 0;
	/** The majordomo, as requests name it, and two new agents with a chat each. */
	const agents = async () => {
		cast++;
		const [majordomo] = (await api("/agents")).body.agents;
		const by = majordomo.role.toLowerCase() === majordomo.name.toLowerCase() ? majordomo.name : `${majordomo.name} (${majordomo.role})`;
		const make = async (name: string): Promise<Cast> => {
			const agent = (await post("/agents", { name: `${name} ${cast}`, instructions: "Work." })).body;
			made.push(agent.id);
			return { id: agent.id, name: agent.name, chat: (await post("/sessions", { agent: agent.id })).body.id };
		};
		return { majordomo: majordomo as { id: string; name: string }, by, coach: await make("Strider"), chef: await make("Cook") };
	};
	/** Puts a skill on an agent's list, written by the majordomo for it. */
	const given = async (agent: Cast, write: Record<string, JsonValue>) => {
		expect((await decide({ ...write, agent: agent.id }, ROOT)).result).toContain("Saved the skill");
	};

	beforeEach(async () => {
		await api("/settings", { method: "PUT", body: JSON.stringify({ approvalPolicy: "explicit" }) });
	});
	afterEach(async () => {
		for (const skill of (await api("/skills")).body.skills) await api(`/skills/${skill.name}`, { method: "DELETE" });
		for (const id of made) await api(`/agents/${id}`, { method: "DELETE" });
		made = [];
		await writeSkill(null);
		await api("/settings", { method: "PUT", body: JSON.stringify({ approvalPolicy: null }) });
	});

	it("refuses before asking: other agents' skills from any agent but the majordomo, unknown agents, mixed or missing input, sources outside GitHub or /workspace, and names it doesn't hold", async () => {
		const { coach, chef } = await agents();
		expect(await ask({ ...plan, agent: chef.id }, coach.chat)).toContain("Only the person's majordomo writes skills for their other agents");
		expect(await ask({ source: "/workspace/skills/deck", agent: chef.id }, coach.chat, INSTALL_SKILL)).toContain("Only the person's majordomo writes skills for their other agents");
		expect(await ask({ ...meals, agent: "p_nope" }, ROOT)).toContain("no agent with the id p_nope");
		expect(await ask({ from: "/workspace/skills/deck", name: "deck", instructions: "Mine." }, coach.chat)).toContain("not both: name, instructions came with from");
		expect(await ask({ description: "Half a skill." }, coach.chat)).toContain("Give name, description and instructions");
		expect(await ask({ from: "https://evil.example/skills/deck" }, coach.chat)).toContain("Give a GitHub repository's address");
		expect(await ask({ from: "/workspace/../etc/skills" }, coach.chat)).toContain("path must be an absolute path under /workspace");
		expect((await api("/approvals?status=pending")).body.approvals).toEqual([]);

		// A skill of another agent's, or of none, by its name and version: not Cook's to write.
		await given(coach, plan);
		expect(await ask({ ...plan, instructions: "Mine now.", base_version: 1 }, chef.chat)).toContain(`weekly-plan is one of ${coach.name}'s skills, not ${chef.name}'s`);
		expect(await ask(plan, chef.chat)).toContain(`weekly-plan is one of ${coach.name}'s skills, not ${chef.name}'s`);
		await api(`/agents/${coach.id}`, { method: "PUT", body: JSON.stringify({ skills: [] }) });
		expect(await ask({ ...plan, instructions: "Mine now.", base_version: 1 }, chef.chat)).toContain(`The person has a skill named weekly-plan that isn't one of ${chef.name}'s`);
		// One two agents use is neither's to change.
		await api(`/agents/${coach.id}`, { method: "PUT", body: JSON.stringify({ skills: ["weekly-plan"] }) });
		await api(`/agents/${chef.id}`, { method: "PUT", body: JSON.stringify({ skills: ["weekly-plan"] }) });
		expect(await ask({ ...plan, base_version: 1 }, coach.chat)).toContain(`weekly-plan is one of ${chef.name}'s skills too`);
		expect(await ask({ ...plan, base_version: 1, agent: coach.id }, ROOT)).toContain(`weekly-plan is one of ${chef.name}'s skills too`);
		expect(await version("weekly-plan")).toBe(1);
	});

	it("writes an agent's own skills, and the majordomo's for another agent, naming both, from the version it read", async () => {
		const { majordomo, by, coach } = await agents();
		const own = await decide(plan, coach.chat);
		expect(own).toMatchObject({ summary: `${coach.name} saves a new skill: weekly-plan`, args: { by: coach.id, agent: coach.id } });
		expect(await skillsOf(coach.id)).toEqual(["weekly-plan"]);

		const rewrite = await decide({ ...plan, instructions: "Add 5% distance.", base_version: 1, agent: coach.id }, ROOT);
		expect(rewrite).toMatchObject({ summary: `${by} rewrites ${coach.name}'s skill weekly-plan`, args: { by: majordomo.id, agent: coach.id } });
		expect((await api("/skills/weekly-plan")).body).toMatchObject({ instructions: "Add 5% distance.", history: [{ version: 2, author: majordomo.name }, { version: 1, author: coach.name }] });
		expect(await skillsOf(majordomo.id)).not.toContain("weekly-plan");
		expect(await ask({ ...plan, base_version: 1, agent: coach.id }, ROOT)).toContain("is at version 2 now, not 1");
	});

	it("follows each agent's switch for skills and write_skill's permission, which still decides whether to ask", async () => {
		const { majordomo, coach, chef } = await agents();
		expect((await switchSkills(chef.id, "ask")).status).toBe(400);
		expect((await switchSkills(chef.id, "off")).body).toMatchObject({ tool: WRITE_SKILL, permission: "off", chosen: "off", default: "on" });
		expect((await api(`/permissions?agent=${chef.id}`)).body.skills).toMatchObject({ permission: "off" });
		expect(await offeredIn(chef.chat)).toContain("current_time");
		expect(tools).not.toContain(WRITE_SKILL);
		expect(tools).not.toContain(INSTALL_SKILL);
		expect(await offeredIn(coach.chat)).toContain(WRITE_SKILL);
		expect(await ask({ ...meals, agent: chef.id }, ROOT)).toContain(`The person turned off skills for ${chef.name}`);
		await switchSkills(majordomo.id, "off");
		expect(await offeredIn(ROOT)).not.toContain(WRITE_SKILL);
		await switchSkills(majordomo.id, null);

		// write_skill on: a write the switches allow runs without asking; one they don't is still refused, and so is another's from any agent but the majordomo.
		await writeSkill("on");
		await ask({ ...meals, agent: coach.id }, ROOT);
		expect(told).toContain("Saved the skill meal-prep");
		expect((await api("/approvals?status=pending")).body.approvals).toEqual([]);
		expect(await skillsOf(coach.id)).toEqual(["meal-prep"]);
		expect(await ask({ ...plan, agent: chef.id }, ROOT)).toContain(`The person turned off skills for ${chef.name}`);
		expect(await ask({ ...plan, agent: chef.id }, coach.chat)).toContain("Only the person's majordomo writes skills");
		expect(await version("weekly-plan")).toBeNull();
		// write_skill off: no agent is offered it.
		await writeSkill("off");
		expect(await offeredIn(coach.chat)).not.toContain(WRITE_SKILL);
	});

	it("saves nothing when, before approval, a switch goes off, an agent is deleted, the skill gains another agent or a newer version, or write_skill is turned off", async () => {
		const { by, coach, chef } = await agents();
		const offFor = await decide({ ...meals, agent: chef.id }, ROOT, { meanwhile: () => switchSkills(chef.id, "off") });
		expect(offFor.summary).toBe(`${by} saves a new skill for ${chef.name}: meal-prep`);
		expect(offFor.result).toContain(`The skill was not saved: The person turned off skills for ${chef.name}`);
		await switchSkills(chef.id, null);
		// Its own chat loses the tool as the decision lands, so the call hears it was interrupted; the request's result says why.
		const selfOff = await decide({ ...meals, name: "race-day" }, coach.chat, { meanwhile: () => switchSkills(coach.id, "off") });
		expect(selfOff.result).toBe(`The skill was not saved: The person turned off skills for ${coach.name}. Only they can turn them on again, on its page in Agents.`);
		await switchSkills(coach.id, null);
		const temp = (await post("/agents", { name: `Baker ${cast}`, instructions: "Bake." })).body;
		const target = await decide({ ...meals, agent: temp.id }, ROOT, { meanwhile: () => api(`/agents/${temp.id}`, { method: "DELETE" }) });
		expect(target.result).toContain(`The skill was not saved: The person has no agent with the id ${temp.id}`);
		const asker = (await post("/agents", { name: `Baker ${cast}`, instructions: "Bake." })).body;
		const askerChat = (await post("/sessions", { agent: asker.id })).body.id;
		const asked = await decide(meals, askerChat, { meanwhile: () => api(`/agents/${asker.id}`, { method: "DELETE" }) });
		expect(asked.result).toContain("The skill was not saved: The agent that asked for this skill no longer exists");
		const off = await decide(meals, chef.chat, { meanwhile: () => writeSkill("off") });
		expect(off.result).toContain("The skill was not saved: The person turned off write_skill");
		await writeSkill(null);
		expect(await version("meal-prep")).toBeNull();
		expect(await version("race-day")).toBeNull();

		// The majordomo's rewrite for Strider, approved after the person gave the skill to Cook too, or restored a version.
		await given(coach, plan);
		const shared = await decide({ ...plan, instructions: "Mine.", base_version: 1, agent: coach.id }, ROOT, {
			meanwhile: () => api(`/agents/${chef.id}`, { method: "PUT", body: JSON.stringify({ skills: ["weekly-plan"] }) }),
		});
		expect(shared.result).toContain(`The skill was not saved: weekly-plan is one of ${chef.name}'s skills too`);
		await api(`/agents/${chef.id}`, { method: "PUT", body: JSON.stringify({ skills: [] }) });
		const stale = await decide({ ...plan, instructions: "Mine.", base_version: 1, agent: coach.id }, ROOT, {
			meanwhile: () => post("/skills/weekly-plan/restore", { version: 1, baseVersion: 1 }),
		});
		expect(stale.result).toContain("weekly-plan is at version 2 now, not 1");
		expect((await api("/skills/weekly-plan")).body).toMatchObject({ version: 2, instructions: plan.instructions });
	});

	it("checks again as it commits: what changes while an approved write stores its files or reads its copies saves nothing", async () => {
		const { majordomo, coach, chef } = await agents();
		const notes = (text: string) => [{ path: "notes.md", content: text }];
		/** A refused write added no version and put the skill on no list. */
		const unchanged = async (name: string, wanted: number | null, lists: Record<string, string[]>) => {
			expect(await version(name)).toBe(wanted);
			for (const [id, skills] of Object.entries(lists)) expect(await skillsOf(id)).toEqual(skills);
		};

		const targetOff = await approveWhile({ ...meals, files: notes("1"), agent: coach.id }, ROOT, holdStorage, () => switchSkills(coach.id, "off"));
		expect(targetOff.result).toContain(`The skill was not saved: The person turned off skills for ${coach.name}`);
		await unchanged("meal-prep", null, { [coach.id]: [] });
		await switchSkills(coach.id, null);

		const actorOff = await approveWhile({ ...meals, files: notes("2"), agent: coach.id }, ROOT, holdStorage, () => switchSkills(majordomo.id, "off"));
		expect(actorOff.result).toContain(`The skill was not saved: The person turned off skills for ${majordomo.name}`);
		await unchanged("meal-prep", null, { [coach.id]: [] });
		await switchSkills(majordomo.id, null);

		const temp = (await post("/agents", { name: `Baker ${cast}`, instructions: "Bake." })).body;
		const deleted = await approveWhile({ ...meals, files: notes("3"), agent: temp.id }, ROOT, holdStorage, () => api(`/agents/${temp.id}`, { method: "DELETE" }));
		expect(deleted.result).toContain(`The skill was not saved: The person has no agent with the id ${temp.id}`);
		await unchanged("meal-prep", null, {});

		await given(coach, plan);
		const rewrite = (text: string) => ({ ...plan, instructions: text, files: notes(text), base_version: 1, agent: coach.id });
		const attached = await approveWhile(rewrite("4"), ROOT, holdStorage, () => api(`/agents/${chef.id}`, { method: "PUT", body: JSON.stringify({ skills: ["weekly-plan"] }) }));
		expect(attached.result).toContain(`The skill was not saved: weekly-plan is one of ${chef.name}'s skills too`);
		await unchanged("weekly-plan", 1, { [coach.id]: ["weekly-plan"], [chef.id]: ["weekly-plan"] });
		await api(`/agents/${chef.id}`, { method: "PUT", body: JSON.stringify({ skills: [] }) });

		const detached = await approveWhile(rewrite("5"), ROOT, holdStorage, () => api(`/agents/${coach.id}`, { method: "PUT", body: JSON.stringify({ skills: [] }) }));
		expect(detached.result).toContain(`The skill was not saved: The person has a skill named weekly-plan that isn't one of ${coach.name}'s`);
		await unchanged("weekly-plan", 1, { [coach.id]: [] });
		// The files the refused writes stored aren't kept: weekly-plan's one version has none.
		expect((await env.BLOBS.list({ prefix: `${OWNER}/skills/` })).objects).toHaveLength(0);

		// While it reads a copy again at approval, from GitHub: held there, the target's switch goes off.
		const commit = "0123456789abcdef0123456789abcdef01234567";
		const raw = `https://raw.githubusercontent.com/acme/skills/${commit}/stretch/`;
		const held = gate();
		let reads = 0;
		const realFetch = globalThis.fetch;
		vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
			const url = new Request(input, init).url;
			if (url === "https://api.github.com/repos/acme/skills/commits/main") return new Response(commit);
			if (url === `https://api.github.com/repos/acme/skills/git/trees/${commit}?recursive=1`) {
				return Response.json({ truncated: false, tree: ["stretch/SKILL.md", "stretch/moves.md"].map((path) => ({ path, type: "blob", size: 20 })) });
			}
			if (url === `${raw}SKILL.md`) return new Response("---\nname: stretch\ndescription: Stretch after runs.\n---\nSee moves.md.\n");
			if (url === `${raw}moves.md`) {
				// The second read is the approved write's.
				if (++reads === 2) {
					held.reach();
					await held.released;
				}
				return new Response("Calves first.\n");
			}
			return realFetch(input, init);
		});
		const copying = await approveWhile({ from: "https://github.com/acme/skills/tree/main/stretch", agent: coach.id }, ROOT, async () => held, () => switchSkills(coach.id, "off"));
		expect(reads).toBe(2);
		expect(copying.result).toContain(`The skill was not saved: The person turned off skills for ${coach.name}`);
		await unchanged("stretch", null, { [coach.id]: [] });
	});

	it("installs a published skill for another agent with install_skill or from, as its source has it, and saves nothing denied or leading outside /workspace", async () => {
		const { majordomo, by, coach, chef } = await agents();
		const { root } = await pairTestComputer();
		const putFile = (path: string, body: string) =>
			exports.default.fetch(new Request(apiUrl(`/files/content?path=${path}`), { method: "PUT", body, headers: { Authorization: `Bearer ${TOKEN}` } }));
		await putFile("/workspace/skills/stretch/SKILL.md", "---\nname: stretch\ndescription: Stretch after runs.\n---\nSee reference/moves.md.\n");
		await putFile("/workspace/skills/stretch/reference/moves.md", "Calves, then hamstrings.\n");

		// Denied: nothing saved, on no list.
		const denied = await decide({ source: "/workspace/skills/stretch", agent: coach.id }, ROOT, { tool: INSTALL_SKILL, decision: "deny" });
		expect(denied.status).toBe("denied");
		expect(await version("stretch")).toBeNull();
		expect(await skillsOf(coach.id)).toEqual([]);

		const installed = await decide({ source: "/workspace/skills/stretch", agent: coach.id }, ROOT, { tool: INSTALL_SKILL });
		expect(installed).toMatchObject({
			summary: `${by} installs the skill stretch for ${coach.name} from /workspace/skills/stretch`,
			args: { by: majordomo.id, agent: coach.id, source: "/workspace/skills/stretch", files: [{ path: "reference/moves.md", from_file: "/workspace/skills/stretch/reference/moves.md", sha256: expect.stringMatching(/^[0-9a-f]{64}$/) }] },
		});
		expect((await api("/skills/stretch")).body).toMatchObject({ version: 1, author: majordomo.name, source: "/workspace/skills/stretch" });
		expect(await skillsOf(coach.id)).toEqual(["stretch"]);
		// Updated through write_skill's from, from the version it read.
		await putFile("/workspace/skills/stretch/reference/moves.md", "Hamstrings, then calves.\n");
		expect((await decide({ from: "/workspace/skills/stretch", base_version: 1, agent: coach.id }, ROOT)).summary).toBe(`${by} updates ${coach.name}'s skill stretch from /workspace/skills/stretch`);
		expect(await version("stretch")).toBe(2);
		expect(await ask({ source: "/workspace/skills/stretch", base_version: 1, agent: coach.id }, ROOT, INSTALL_SKILL)).toContain("stretch is at version 2 now, not 1");

		// A link in the skill's folder that leads outside /workspace refuses the install before anything is asked.
		await putFile("/workspace/skills/leaky/SKILL.md", "---\nname: leaky\ndescription: Leaks.\n---\nRead secret.txt.\n");
		await fs.mkdir(`${root}-outside`, { recursive: true });
		await fs.writeFile(`${root}-outside/secret.txt`, "secret");
		await fs.symlink(`${root}-outside/secret.txt`, `${root}/skills/leaky/secret.txt`);
		expect(await ask({ source: "/workspace/skills/leaky", agent: chef.id }, ROOT, INSTALL_SKILL)).toContain("outside /workspace");
		await fs.rm(`${root}/skills/leaky/secret.txt`);
		await fs.symlink(`${root}-outside`, `${root}/skills/leaky/linked`);
		expect(await ask({ source: "/workspace/skills/leaky", agent: chef.id }, ROOT, INSTALL_SKILL)).toContain("outside /workspace");
		expect((await api("/approvals?status=pending")).body.approvals).toEqual([]);
		expect(await version("leaky")).toBeNull();
	});

	it("lists the skill for its agent in the transaction that adds the version: what changes after it stands, and a failed listing adds nothing", async () => {
		const { coach, chef } = await agents();
		/** A skill with 20 versions, Strider's, whose first version alone has its file: the next write prunes it, and deletes that file from R2 after it commits. */
		const twentyVersions = async (name: string) => {
			await runInDurableObject(env.Pim.getByName(OWNER), async (instance: Pim) => {
				const base = { name, description: "Plan.", instructions: "Plan.", author: "Setup" };
				await instance.skills.write({ ...base, files: [{ path: "first.md", content: `only in ${name}'s first version` }] });
				await instance.skills.write({ ...base, files: [{ path: "later.md", content: "later" }], baseVersion: 1 });
				for (let version = 2; version < 20; version++) await instance.skills.restore(name, 2, version);
			});
			await api(`/agents/${coach.id}`, { method: "PUT", body: JSON.stringify({ skills: [name] }) });
			expect(await version(name)).toBe(20);
		};
		/** Holds the first file deleted from R2 once a write has committed, until released; `fail` makes the delete fail instead. */
		const holdCleanup = async (fail = false): Promise<Gate> => {
			const { reached, released, reach, release } = gate();
			await runInDurableObject(env.Pim.getByName(OWNER), (instance: Pim) => {
				const bucket = (instance as unknown as { env: { BLOBS: R2Bucket } }).env.BLOBS;
				if (vi.isMockFunction(bucket.delete)) vi.mocked(bucket.delete).mockRestore();
				const remove = bucket.delete.bind(bucket);
				vi.spyOn(bucket, "delete").mockImplementation(async (keys: string | string[]) => {
					reach();
					await released;
					if (fail) throw new Error("R2 is down");
					return remove(keys);
				});
			});
			return { reached, release };
		};
		const rewrite = (name: string) => ({ name, description: "Plan.", instructions: "Version 21.", files: [{ path: "new.md", content: `new in ${name}` }], base_version: 20, agent: coach.id });
		/** By the time it collects, the version is published and listed. */
		const published = async (name: string) => {
			expect(await version(name)).toBe(21);
			expect(await skillsOf(coach.id)).toContain(name);
		};

		// Taken off Strider after the commit: it stays off; nothing lists it again.
		await twentyVersions("detached");
		const detached = await approveWhile(rewrite("detached"), ROOT, holdCleanup, async () => {
			await published("detached");
			await api(`/agents/${coach.id}`, { method: "PUT", body: JSON.stringify({ skills: [] }) });
		});
		expect(detached.result).toContain(`Saved the skill detached, version 21, one of ${coach.name}'s skills`);
		expect(await skillsOf(coach.id)).toEqual([]);

		// Switched off, or given to Cook too, after the commit: the person's later changes, which stand.
		await twentyVersions("switched");
		const switched = await approveWhile(rewrite("switched"), ROOT, holdCleanup, async () => {
			await published("switched");
			await switchSkills(coach.id, "off");
			await api(`/agents/${chef.id}`, { method: "PUT", body: JSON.stringify({ skills: ["switched"] }) });
		});
		expect(switched.result).toContain(`Saved the skill switched, version 21, one of ${coach.name}'s skills`);
		expect(await skillsOf(coach.id)).toEqual(["switched"]);
		expect(await skillsOf(chef.id)).toEqual(["switched"]);
		expect((await api(`/permissions?agent=${coach.id}`)).body.skills.permission).toBe("off");
		await switchSkills(coach.id, null);
		await api(`/agents/${chef.id}`, { method: "PUT", body: JSON.stringify({ skills: [] }) });

		// Collecting files failing after the commit doesn't make it unsaved.
		await twentyVersions("collected");
		const collected = await approveWhile(rewrite("collected"), ROOT, () => holdCleanup(true), () => published("collected"));
		expect(collected.result).toContain(`Saved the skill collected, version 21, one of ${coach.name}'s skills`);
		expect(await version("collected")).toBe(21);

		// Strider deleted after the commit: the request still says whose skill it became.
		await twentyVersions("deleted");
		const deleted = await approveWhile(rewrite("deleted"), ROOT, holdCleanup, async () => {
			await published("deleted");
			await api(`/agents/${coach.id}`, { method: "DELETE" });
		});
		expect(deleted.result).toContain(`Saved the skill deleted, version 21, one of ${coach.name}'s skills`);

		// Listing it for Cook fails in the transaction: no version, no list, as if never asked.
		await runInDurableObject(env.Pim.getByName(OWNER), (instance: Pim) => {
			vi.spyOn(instance.agents, "update").mockImplementationOnce(() => {
				throw new Error("listing failed");
			});
		});
		const unlisted = await decide({ ...meals, files: [{ path: "notes.md", content: "unlisted" }], agent: chef.id }, ROOT);
		expect(unlisted.result).toBe("The action failed: listing failed");
		expect(await version("meal-prep")).toBeNull();
		expect(await skillsOf(chef.id)).toEqual([]);
	});

	it("reads published skills only from GitHub's own addresses, at a commit's hash, and follows no redirect elsewhere", async () => {
		const { majordomo, coach } = await agents();
		const commit = "0123456789abcdef0123456789abcdef01234567";
		const fetched: string[] = [];
		const responses: Record<string, () => Response> = {};
		vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
			const url = new Request(input, init).url;
			fetched.push(url);
			return responses[url]?.() ?? new Response("Not Found", { status: 404 });
		});
		const install = (from: string) => ask({ from, agent: coach.id }, ROOT);

		// Addresses that aren't a repository's folder are refused before anything is fetched.
		for (const [from, refusal] of [
			["https://github.com/../skills/tree/main/name", "Give a GitHub repository's address"],
			["https://github.com/acme/../tree/main/name", "Give a GitHub repository's address"],
			["https://github.com/acme/./tree/main/name", "Give a GitHub repository's address"],
			["https://user:secret@github.com/acme/skills", "Give a GitHub repository's address"],
			["https://github.com:8443/acme/skills", "Give a GitHub repository's address"],
			["https://github.com/acme/skills/tree/main/%2e%2e/secrets", "isn't a file or folder's name"],
			["https://github.com/acme/skills/tree/main/a%2Fb", "isn't a file or folder's name"],
			["https://github.com/acme/skills/tree/main/a\\b", "isn't a file or folder's name"],
			["https://github.com/acme/skills/tree/main/%E0%A4%A", "isn't a file or folder's name"],
		] as const) {
			expect(await install(from)).toContain(refusal);
		}
		expect(fetched).toEqual([]);

		// What GitHub names as the commit must be a full hash, or nothing else is read.
		responses["https://api.github.com/repos/acme/odd/commits/main"] = () => new Response("../../users/acme");
		expect(await install("https://github.com/acme/odd/tree/main/skill")).toContain("GitHub answered with no commit's hash");
		expect(fetched.filter((url) => url.includes("/git/trees/"))).toEqual([]);

		// A redirect away from GitHub's API, or from a raw file, is refused without following it.
		responses["https://api.github.com/repos/acme/moved/commits/main"] = () => new Response(null, { status: 301, headers: { location: "https://evil.example/commits/main" } });
		expect(await install("https://github.com/acme/moved/tree/main/skill")).toContain("GitHub sent https://api.github.com elsewhere");
		responses["https://api.github.com/repos/acme/skills/commits/main"] = () => new Response(commit);
		responses[`https://api.github.com/repos/acme/skills/git/trees/${commit}?recursive=1`] = () =>
			Response.json({ truncated: false, tree: [{ path: "skill/SKILL.md", type: "blob", size: 40 }] });
		responses[`https://raw.githubusercontent.com/acme/skills/${commit}/skill/SKILL.md`] = () =>
			new Response(null, { status: 302, headers: { location: "https://raw.githubusercontent.com.evil.example/SKILL.md" } });
		expect(await install("https://github.com/acme/skills/tree/main/skill")).toContain("GitHub sent https://raw.githubusercontent.com elsewhere");
		expect(fetched.filter((url) => !url.startsWith("https://api.github.com/") && !url.startsWith("https://raw.githubusercontent.com/"))).toEqual([]);
		expect((await api("/approvals?status=pending")).body.approvals).toEqual([]);

		// An approved request whose copy names any other address, or one a URL resolves elsewhere, copies nothing.
		fetched.length = 0;
		for (const from_url of [
			"https://evil.example/x.md",
			`https://raw.githubusercontent.com/acme/skills/${commit}/../../../x.md`,
			`https://raw.githubusercontent.com/acme/skills/${commit}/%2e%2e/x.md`,
			`https://raw.githubusercontent.com:8443/acme/skills/${commit}/x.md`,
			`https://raw.githubusercontent.com/acme/skills/main/x.md`,
		]) {
			const forged = await runInDurableObject(env.Pim.getByName(OWNER), (instance: Pim) => {
				const write = instance.actions.find((action) => action.name === WRITE_SKILL)!;
				return write.run({ by: majordomo.id, agent: coach.id, ...meals, files: [{ path: "x.md", from_url, sha256: "0".repeat(64) }] }, { session: ROOT });
			});
			expect(forged).toContain("Only files of a commit on https://raw.githubusercontent.com/ are copied from the web");
		}
		expect(fetched).toEqual([]);
		expect(await version("meal-prep")).toBeNull();
		expect(await skillsOf(coach.id)).toEqual([]);
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
			// Its name was its role; the majordomo's role is its title.
			expect(agents.list()[0]!.role).toBe("Majordomo");
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
			expect(byName["Writer (Planner)"]!.role).toBe("Writer (Planner)");
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
