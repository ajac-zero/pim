import type { JsonValue, Message } from "@earendil-works/pi-ai";
import { fauxAssistantMessage } from "@earendil-works/pi-ai/providers/faux";
import { describe, expect, it } from "vitest";
import { exports } from "cloudflare:workers";
import { CREATE_PIM, UPDATE_PIM } from "../src/extensions/persona";
import { api, apiUrl, decisionRun, pendingApproval, post, say, TOKEN, toolUse } from "./helpers";
import { faux } from "./worker";

/** The prompt sections sent last: pi sends the whole prompt once, then only what changed. */
const system = (messages: readonly Message[]) => JSON.stringify(messages.filter((message) => message.role === "system").at(-1));

describe("the owner's Pims", () => {
	it("talks in every chat as the chat's Pim, or the default one, as each is at each request", async () => {
		// Every account has its Pim: plain until changed, and there to stay.
		const [mine] = (await api("/personas")).body.personas;
		expect(mine).toMatchObject({ name: "Pim", instructions: "", default: true, source: null });
		expect((await api(`/personas/${mine.id}`, { method: "DELETE" })).status).toBe(400);

		expect((await post("/personas", { name: "", instructions: "x" })).status).toBe(400);
		expect((await post("/personas", { name: "Coach", instructions: "x", apps: [{ name: "Cal", url: "http://plain.test" }] })).status).toBe(400);
		const coach = (
			await post("/personas", {
				name: "Marathon coach",
				description: "Plans my training.",
				instructions: "Answer every question with a training tip.",
				apps: [{ name: "Strava", url: "https://mcp.strava.example/mcp" }],
			})
		).body;
		expect(coach).toMatchObject({ id: expect.stringMatching(/^p_/), source: null, published: null, default: false });
		expect((await api("/personas")).body.personas.map((pim: { name: string }) => pim.name)).toEqual(["Pim", "Marathon coach"]);
		expect((await post("/sessions", { persona: "p_nope" })).status).toBe(404);
		const session = (await post("/sessions", { persona: coach.id })).body;
		expect(session.persona).toEqual({ id: coach.id, name: "Marathon coach" });
		expect((await post("/sessions", {})).body.persona).toEqual({ id: mine.id, name: "Pim" });

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

		// Edited, a Pim's chats follow from their next request: the default one's are every chat not started with another.
		await api(`/personas/${coach.id}`, { method: "PUT", body: JSON.stringify({ instructions: "Speak only in haiku." }) });
		await api(`/personas/${mine.id}`, { method: "PUT", body: JSON.stringify({ name: "Sam", instructions: "Sign off with -S." }) });
		faux.setResponses([record, record]);
		await say("And tomorrow?", session.id);
		await say("Hi again", "1");
		expect(prompts[2]).toContain("Speak only in haiku.");
		expect(prompts[3]).toContain('you are \\"Sam\\"');
		expect(prompts[3]).toContain("Sign off with -S.");
		expect((await api("/sessions")).body.sessions.find((info: { id: string }) => info.id === session.id).persona).toEqual({
			id: coach.id,
			name: "Marathon coach",
		});

		// Deleted, its chats stay, with the default Pim.
		expect((await api(`/personas/${coach.id}`, { method: "DELETE" })).body).toEqual({ deleted: true });
		faux.setResponses([record]);
		await say("Still there?", session.id);
		expect(prompts[4]).toContain("Sign off with -S.");
		expect(prompts[4]).not.toContain("haiku");
		expect((await api("/personas")).body.personas).toEqual([expect.objectContaining({ id: mine.id, name: "Sam", default: true })]);
	});

	it("keeps an icon for each Pim, only as a picture", async () => {
		const pim = (await post("/personas", { name: "Coach" })).body;
		expect(pim.icon).toBeNull();
		expect((await api(`/personas/${pim.id}/icon`)).status).toBe(404);
		const png = new Uint8Array([137, 80, 78, 71, 1, 2, 3]);
		const upload = (type: string, body: BodyInit) => api(`/personas/${pim.id}/icon`, { method: "PUT", headers: { "content-type": type }, body });
		expect((await upload("image/svg+xml", "<svg/>")).status).toBe(415);
		expect((await upload("image/png", new Uint8Array(256 * 1024 + 1))).status).toBe(413);
		expect((await upload("image/png", png)).body.icon).toEqual(expect.any(Number));
		const [, listed] = (await api("/personas")).body.personas;
		expect(listed.icon).toEqual(expect.any(Number));
		const served = await exports.default.fetch(apiUrl(`/personas/${pim.id}/icon`), { headers: { authorization: `Bearer ${TOKEN}` } });
		expect(served.headers.get("content-type")).toBe("image/png");
		expect(new Uint8Array(await served.arrayBuffer())).toEqual(png);
		expect((await api(`/personas/${pim.id}/icon`, { method: "DELETE" })).body.icon).toBeNull();
		expect((await api(`/personas/${pim.id}/icon`)).status).toBe(404);
	});

	it("knows the person's other Pims, and makes one none of them covers", async () => {
		const planner = (await post("/personas", { name: "Trip planner", description: "Plans my trips." })).body;
		const session = (await post("/sessions", { persona: planner.id })).body.id;
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
			toolUse(CREATE_PIM, { ...reviewer, apps: [{ name: "GitHub", url: "http://plain.test" }] }),
			record,
			toolUse(CREATE_PIM, reviewer),
			record,
			toolUse(CREATE_PIM, { ...reviewer, name: " code REVIEWER ", instructions: "Something else." }),
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
		const made = (await api("/personas")).body.personas.find((pim: { name: string }) => pim.name === "Code reviewer");
		expect(made).toMatchObject({ ...reviewer, default: false, source: null });
		// One the person has already isn't made again, whatever its case.
		await say("And another code reviewer", session);
		expect(seen[3]!.result).toContain('\\"exists\\": true');
		expect((await api("/personas")).body.personas.filter((pim: { name: string }) => pim.name === "Code reviewer")).toHaveLength(1);
		expect(seen[3]!.prompt).toContain("- Code reviewer: Reviews my pull requests.");
	});

	it("changes itself, its team included, once the person approves", async () => {
		await api("/settings", { method: "PUT", body: JSON.stringify({ approvalPolicy: "explicit" }) });
		const writer = (
			await post("/personas", {
				name: "Ghostwriter",
				instructions: "Write short.",
				apps: [{ name: "Docs", url: "https://mcp.docs.example/mcp" }],
				team: [
					{ name: "Editor", instructions: "Fix grammar." },
					{ name: "Fact checker", instructions: "Check every claim." },
				],
			})
		).body;
		const session = (await post("/sessions", { persona: writer.id })).body.id;
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
			toolUse(UPDATE_PIM, { set_members: [{ name: "Editor", instructions: "" }] }),
			record,
			toolUse(UPDATE_PIM, { instructions: "Write short." }),
			record,
			toolUse(UPDATE_PIM, edit),
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
		expect((await api(`/personas/${writer.id}`)).body.instructions).toBe("Write short.");

		let prompt = "";
		faux.setResponses([
			(context) => {
				prompt = system(context.messages);
				return fauxAssistantMessage("Done.");
			},
		]);
		await post(`/approvals/${approval.id}/approve`);
		expect(await decisionRun(approval)).toMatchObject({ status: "done" });
		expect((await api(`/personas/${writer.id}`)).body).toMatchObject({
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
