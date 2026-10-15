import type { Message } from "@earendil-works/pi-ai";
import { type FauxResponseFactory, fauxAssistantMessage } from "@earendil-works/pi-ai/providers/faux";
import { describe, expect, it, vi } from "vitest";
import type { Approval } from "../src/store";
import { api, lastUserText, pendingApproval, post, say, systemPrompt, toolUse } from "./helpers";
import { faux } from "./worker";

type Context = Parameters<FauxResponseFactory>[0];

const toolResult = (messages: readonly Message[]) =>
	JSON.stringify(messages.findLast((message) => message.role === "toolResult")?.content);

/** Who a request is from: the agent, or a member by name, from the preamble its conversation got. */
const speaker = (context: Context) => /You are \\"([^"\\]+)\\", a member of the team/.exec(systemPrompt(context.messages))?.[1] ?? "lead";

/** Answers each request with the script of whoever asked, in order: members run at once, so their order isn't fixed. */
function scripts(byRole: Record<string, ((context: Context) => ReturnType<FauxResponseFactory>)[]>) {
	const count = Object.values(byRole).reduce((sum, list) => sum + list.length, 0);
	const route = (context: Context) => {
		const next = byRole[speaker(context)]?.shift();
		if (!next) throw new Error(`No response left for ${speaker(context)}`);
		return next(context);
	};
	faux.setResponses(Array.from({ length: count }, () => route));
}

const planner = {
	name: "Trip planner",
	instructions: "Plan trips in detail.",
	team: [
		{ name: "Researcher", instructions: "Find facts and cite where they came from." },
		{ name: "Writer", instructions: "Write plans as short lists.", tools: ["current_time"] },
	],
};

describe("an agent's team", () => {
	it("works on the tasks the agent hands out at the same time, each member with its own instructions and tools", async () => {
		expect((await post("/agents", { ...planner, team: [planner.team[0], planner.team[0]] })).status).toBe(400);
		expect((await post("/agents", { ...planner, team: [{ name: "Researcher" }] })).status).toBe(400);
		const agent = (await post("/agents", planner)).body;
		expect(agent.team).toEqual([
			{ name: "Researcher", instructions: "Find facts and cite where they came from.", tools: null },
			{ name: "Writer", instructions: "Write plans as short lists.", tools: ["current_time"] },
		]);
		const session = (await post("/sessions", { agent: agent.id })).body.id;

		const seen: Record<string, { prompt: string; tools: string[]; task: string }> = {};
		const record = (context: Context) => {
			seen[speaker(context)] = {
				prompt: systemPrompt(context.messages),
				tools: context.messages.flatMap((message) => (message.role === "system" ? (message.toolsAdded ?? []).map((tool) => tool.name) : [])),
				task: lastUserText(context.messages),
			};
		};
		let results = "";
		// Both members are held until both have started: they run at the same time, not one after the other.
		let started = 0;
		const bothStarted = vi.waitFor(() => expect(started).toBe(2), { timeout: 5_000 });
		const member = (answer: string) => async (context: Context) => {
			record(context);
			started++;
			await bothStarted;
			return fauxAssistantMessage(answer);
		};
		scripts({
			lead: [
				(context) => {
					record(context);
					return toolUse("delegate", {
						tasks: [
							{ member: "researcher", task: "Find the best month to visit Lisbon." },
							{ member: "Writer", task: "Draft a three-day outline." },
						],
					});
				},
				(context: Context) => {
					results = toolResult(context.messages);
					return toolUse("send_to_user", { message: "Go in May." });
				},
				() => fauxAssistantMessage("Done."),
			],
			Researcher: [member("May: mild and before the crowds.")],
			Writer: [member("Day 1: Alfama. Day 2: Belém. Day 3: Sintra.")],
		});
		expect(await say("Plan Lisbon for me.", session)).toMatchObject({ status: "done", replies: ["Go in May."] });

		// The agent knows its team; each member knows who it is, its own instructions, and only its tools.
		expect(seen.lead!.prompt).toContain("- Researcher: Find facts and cite where they came from.");
		expect(seen.lead!.tools).toContain("delegate");
		expect(seen.Researcher!.prompt).toContain("Find facts and cite where they came from.");
		expect(seen.Researcher!.prompt).not.toContain("Write plans as short lists.");
		expect(seen.Researcher!.prompt).not.toContain("Plan trips in detail.");
		expect(seen.Researcher!.task).toBe("Find the best month to visit Lisbon.");
		expect(seen.Researcher!.tools).toContain("current_time");
		for (const tool of ["send_to_user", "delegate", "schedule_task", "watch_app_event", "create_agent", "update_agent", "rename_agent"]) expect(seen.Researcher!.tools).not.toContain(tool);
		expect(seen.Writer!.tools).toEqual(["current_time"]);
		// Their answers come back together, by name.
		expect(results).toContain("## Researcher\\nMay: mild and before the crowds.");
		expect(results).toContain("## Writer\\nDay 1: Alfama. Day 2: Belém. Day 3: Sintra.");

		// The person sees what the team did, read-only; members' conversations aren't chats.
		const { runs } = (await api(`/sessions/${session}/team`)).body;
		expect(runs.map((run: { member: string; status: string }) => [run.member, run.status]).sort()).toEqual([
			["Researcher", "done"],
			["Writer", "done"],
		]);
		const researcher = runs.find((run: { member: string }) => run.member === "Researcher");
		const transcript = (await api(`/sessions/${session}/team/${researcher.conversation}`)).body;
		expect(transcript.messages.map((message: { role: string }) => message.role)).toEqual(["user", "assistant"]);
		const listed = (await api("/sessions")).body.sessions.map((info: { id: string }) => info.id);
		expect(listed).toContain(session);
		expect(listed).not.toContain(researcher.conversation);
		expect((await api(`/sessions/${researcher.conversation}/messages`)).status).toBe(404);
		expect((await api(`/sessions/1/team/${researcher.conversation}`)).status).toBe(404);

		// An agent without a team is told so.
		scripts({ lead: [() => toolUse("delegate", { tasks: [{ member: "Researcher", task: "x" }] }), (context: Context) => {
			results = toolResult(context.messages);
			return fauxAssistantMessage("Fine.");
		}] });
		await say("Ask your team.", "1");
		expect(results).toContain("has no team: do the work yourself.");
	});

	it("shows a member's approval in the agent's chat, and brings the member's answer after the decision there", async () => {
		await api("/settings", { method: "PUT", body: JSON.stringify({ approvalPolicy: "explicit" }) });
		const realFetch = globalThis.fetch;
		vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
			const request = new Request(input, init);
			return request.url.startsWith("https://hooks.example.test/") ? new Response("booked", { status: 201 }) : realFetch(input, init);
		});
		const agent = (await post("/agents", { ...planner, name: "Booker" })).body;
		const session = (await post("/sessions", { agent: agent.id })).body.id;
		scripts({
			lead: [
				() => toolUse("delegate", { tasks: [{ member: "Researcher", task: "Book the hotel." }] }),
				() => fauxAssistantMessage("Waiting on your approval for the hotel."),
			],
			Researcher: [
				() => toolUse("http_request", { method: "POST", url: "https://hooks.example.test/hotel" }),
				() => fauxAssistantMessage("Waiting for approval to book the hotel."),
			],
		});
		await say("Book my hotel.", session);
		const approval = await pendingApproval();
		const run = (await api(`/sessions/${session}/team`)).body.runs[0];
		expect(approval).toMatchObject({ session: run.conversation, member: { name: "Researcher", session } });
		const notifications = (await api("/notifications")).body.notifications;
		expect(notifications).toContainEqual(expect.objectContaining({ title: "Pim needs your approval", session }));

		let decision = "";
		let report = "";
		scripts({
			Researcher: [
				(context) => {
					decision = lastUserText(context.messages);
					return fauxAssistantMessage("Booked: confirmation 77.");
				},
			],
			lead: [
				(context) => {
					report = lastUserText(context.messages);
					return fauxAssistantMessage("Told them.");
				},
			],
		});
		expect((await post<Approval>(`/approvals/${approval.id}/approve`)).body.status).toBe("approved");
		const reported = await api(`/sessions/${session}/operations/${encodeURIComponent(`team-report:${run.conversation}:approval:${approval.id}`)}`);
		expect(reported.body.status).toBe("done");
		expect(decision).toContain(`[Approval ${approval.id}] The user approved`);
		expect(report).toBe("[Team: Researcher] After the person's decision, Researcher answered:\nBooked: confirmation 77.");
		expect((await api(`/sessions/${session}/team`)).body.runs[0].status).toBe("done");
	});
});
