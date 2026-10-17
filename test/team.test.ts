import type { Message } from "@earendil-works/pi-ai";
import { type FauxResponseFactory, fauxAssistantMessage } from "@earendil-works/pi-ai/providers/faux";
import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import { exports } from "cloudflare:workers";
import { describe, expect, it, vi } from "vitest";
import type { Approval } from "../src/store";
import { api, decisionRun, lastUserText, pendingApproval, post, say, systemPrompt, TOKEN, toolUse, url } from "./helpers";
import { faux } from "./worker";

type Context = Parameters<FauxResponseFactory>[0];

const toolResult = (messages: readonly Message[]) =>
	JSON.stringify(messages.findLast((message) => message.role === "toolResult")?.content);

/** Who a request is from, by the preamble its conversation got: a member, by name; the majordomo reviewing an approval; or the agent the chat is with. */
const speaker = (context: Context) => {
	const prompt = systemPrompt(context.messages);
	if (/the majordomo of one person/.test(prompt)) return "review";
	return /You are \\"([^"\\]+)\\", a member of the team/.exec(prompt)?.[1] ?? "lead";
};

/**
 * Answers each request with the script of whoever asked, in order: members run at once, so their order isn't fixed.
 * The agent a chat is with answers with its own script, by name, if it has one, or else with `lead`'s.
 */
function scripts(byRole: Record<string, ((context: Context) => ReturnType<FauxResponseFactory>)[]>) {
	const count = Object.values(byRole).reduce((sum, list) => sum + list.length, 0);
	const route = (context: Context) => {
		const agent = /In this conversation you are \\"([^"\\]+)\\"/.exec(systemPrompt(context.messages))?.[1];
		const role = speaker(context) === "lead" && agent !== undefined && agent in byRole ? agent : speaker(context);
		const next = byRole[role]?.shift();
		if (!next) throw new Error(`No response left for ${role}`);
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
		for (const tool of ["send_to_user", "delegate", "schedule_task", "watch_app_event", "create_agent", "update_agent", "rename_agent", "manage_apps"]) expect(seen.Researcher!.tools).not.toContain(tool);
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
			return toolUse("send_to_user", { message: "Fine." });
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
				() => toolUse("send_to_user", { message: "Waiting on your approval for the hotel." }),
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

describe("the majordomo", () => {
	const majordomo = async () => ((await api("/agents")).body.agents as { id: string; name: string; majordomo: boolean }[]).find((agent) => agent.majordomo)!;

	it("sends tasks to the person's other agents in chats the person sees, as though they wrote them, and only it can", async () => {
		const self = await majordomo();
		await api(`/agents/${self.id}`, { method: "PUT", body: JSON.stringify({ name: "Alfred" }) });
		const scout = (await post("/agents", { name: "Scout", instructions: "Find facts and cite where they came from." })).body;
		const tools = (context: Context) => context.messages.flatMap((message) => (message.role === "system" ? (message.toolsAdded ?? []).map((tool) => tool.name) : []));

		let lead = { prompt: "", tools: [] as string[] };
		let scoutSaw = { prompt: "", tools: [] as string[], message: "" };
		const results: string[] = [];
		scripts({
			lead: [
				(context) => {
					lead = { prompt: systemPrompt(context.messages), tools: tools(context) };
					return toolUse("send_to_agent", { agent: "scout", message: "Find the best month to visit Lisbon." });
				},
				(context) => {
					results.push(toolResult(context.messages));
					return toolUse("send_to_user", { message: "Scout says May." });
				},
			],
			Scout: [
				(context) => {
					scoutSaw = { prompt: systemPrompt(context.messages), tools: tools(context), message: lastUserText(context.messages) };
					return toolUse("send_to_user", { message: "May: mild and before the crowds." });
				},
			],
		});
		// The main chat is the majordomo's.
		expect(await say("When should I go to Lisbon?")).toMatchObject({ status: "done", replies: ["Scout says May."] });

		expect(lead.prompt).toContain("You are the person's majordomo, Alfred");
		expect(lead.prompt).toContain(`- Scout [id: ${scout.id}]`);
		expect(lead.tools).toContain("send_to_agent");
		// Scout talks with the person as in any chat with it, and can't hand work on the same way.
		expect(scoutSaw.prompt).not.toContain("majordomo, Scout");
		expect(scoutSaw.prompt).toContain("Find facts and cite where they came from.");
		expect(scoutSaw.message).toBe("Find the best month to visit Lisbon.");
		expect(scoutSaw.tools).toContain("send_to_user");
		expect(scoutSaw.tools).not.toContain("send_to_agent");
		expect(results[0]).toContain("Scout answered:\\nMay: mild and before the crowds.");

		// It is one of the person's chats with Scout, the message theirs, and no hidden conversation of the majordomo's.
		const chat = /Chat (\S+) with Scout/.exec(results[0]!)?.[1];
		const sessions = async () => (await api("/sessions")).body.sessions as { id: string; agent: { id: string } | null }[];
		expect((await sessions()).find((info) => info.id === chat)?.agent?.id).toBe(scout.id);
		const transcript = async () => ((await api(`/sessions/${chat}/messages`)).body.messages as { role: string; parts: { type: string; text?: string }[] }[]).filter((message) => message.role === "user").map((message) => message.parts[0]?.text);
		expect(await transcript()).toEqual(["Find the best month to visit Lisbon."]);
		expect((await api("/sessions/1/team")).body.runs).toEqual([]);

		// It carries on in that chat, not in one that isn't Scout's, and only with agents that exist.
		const count = (await sessions()).length;
		scripts({
			lead: [
				() => toolUse("send_to_agent", { agent: "Nobody", message: "Hi." }),
				(context) => {
					results.push(toolResult(context.messages));
					return toolUse("send_to_agent", { agent: "Scout", message: "Hi.", chat: "1" });
				},
				(context) => {
					results.push(toolResult(context.messages));
					return toolUse("send_to_agent", { agent: scout.id, message: "And in autumn?", chat: chat! });
				},
				(context) => {
					results.push(toolResult(context.messages));
					return toolUse("send_to_user", { message: "October works too." });
				},
			],
			Scout: [() => toolUse("send_to_user", { message: "October." })],
		});
		await say("And autumn?");
		expect(results[1]).toContain("No agent called Nobody.");
		expect(results[2]).toContain("No chat 1 with Scout");
		expect(results[3]).toContain(`Chat ${chat} with Scout`);
		expect(results[3]).toContain("Scout answered:\\nOctober.");
		expect(await transcript()).toEqual(["Find the best month to visit Lisbon.", "And in autumn?"]);
		expect((await sessions()).length).toBe(count);

		// Another agent's chats don't offer it.
		const own = (await post("/sessions", { agent: scout.id })).body.id;
		scripts({
			Scout: [
				(context) => {
					scoutSaw = { ...scoutSaw, tools: tools(context) };
					return toolUse("send_to_user", { message: "Hi." });
				},
			],
		});
		await say("Hello", own);
		expect(scoutSaw.tools).not.toContain("send_to_agent");
	});

	it("talks with MCP clients at /mcp, a new chat per call unless they continue one, handing work down as in the app", async () => {
		const finder = (await post("/agents", { name: "Dentist finder", instructions: "Find dentists near the person." })).body;
		const client = new Client({ name: "test-client", version: "1.0.0" });
		await client.connect(
			new StreamableHTTPClientTransport(new URL(url("/mcp")), {
				fetch: (input, init) => exports.default.fetch(new Request(input, init)),
				requestInit: { headers: { Authorization: `Bearer ${TOKEN}` } },
			}),
		);
		expect((await client.listTools()).tools.map((tool) => tool.name)).toEqual(["pim"]);
		const lastAsked = { messages: "" };
		const answer = (message: string) => (context: { messages: unknown }) => {
			lastAsked.messages = JSON.stringify(context.messages);
			return toolUse("send_to_user", { message });
		};

		scripts({
			lead: [
				() => toolUse("send_to_agent", { agent: "Dentist finder", message: "Find a dentist open on Tuesdays." }),
				() => toolUse("send_to_user", { message: "Dr. Silva can see you Tuesday at 9." }),
			],
			"Dentist finder": [() => toolUse("send_to_user", { message: "Dr. Silva, Tuesday 9:00." })],
		});
		const first = await client.callTool({ name: "pim", arguments: { message: "Find me a dentist" } });
		const { conversation } = first.structuredContent as { conversation: string };
		expect(first.structuredContent).toEqual({ conversation, reply: "Dr. Silva can see you Tuesday at 9." });
		expect(first.content).toEqual([{ type: "text", text: `Dr. Silva can see you Tuesday at 9.\n\n[conversation: ${conversation}]` }]);

		// Naming the conversation continues it, where the earlier work is.
		scripts({ lead: [answer("Yes, Tuesday at 9 with Dr. Silva.")] });
		const second = await client.callTool({ name: "pim", arguments: { message: "Did you book it?", conversation } });
		expect(second.structuredContent).toEqual({ conversation, reply: "Yes, Tuesday at 9 with Dr. Silva." });
		expect(lastAsked.messages).toContain("Find me a dentist");
		expect(lastAsked.messages).toContain("Dr. Silva, Tuesday 9:00.");

		// Leaving it out starts afresh.
		scripts({ lead: [answer("Hello!")] });
		const third = await client.callTool({ name: "pim", arguments: { message: "Hi" } });
		expect((third.structuredContent as { conversation: string }).conversation).not.toBe(conversation);
		expect(lastAsked.messages).not.toContain("dentist");

		// Only the majordomo's chats can be continued, not the person's other chats.
		const sessions: { id: string; agent: { id: string } }[] = (await api("/sessions")).body.sessions;
		const finderChat = sessions.find((session) => session.agent.id === finder.id)!.id;
		const { name } = (await api("/majordomo")).body.agent;
		for (const other of [finderChat, "nope"]) {
			const refused = await client.callTool({ name: "pim", arguments: { message: "Hi", conversation: other } });
			expect(refused).toMatchObject({ isError: true, content: [{ type: "text", text: `No conversation ${other} with ${name}: leave out conversation to start one.` }] });
		}
		await client.close();

		expect((await exports.default.fetch(url("/mcp"), { method: "POST" })).status).toBe(401);
	});

	it("hears what an agent says in a chat it started once an approval there is decided", async () => {
		await api("/settings", { method: "PUT", body: JSON.stringify({ approvalPolicy: "explicit" }) });
		vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response("booked", { status: 201 }));
		const concierge = (await post("/agents", { name: "Concierge", instructions: "Book what the person asks for." })).body;
		scripts({
			lead: [
				() => toolUse("send_to_agent", { agent: "Concierge", message: "Book the hotel." }),
				() => toolUse("send_to_user", { message: "Concierge asked you to approve the booking." }),
			],
			Concierge: [
				() => toolUse("http_request", { method: "POST", url: "https://hooks.example.test/hotel" }),
				() => toolUse("send_to_user", { message: "Waiting for your approval." }),
			],
		});
		await say("Book my hotel.");
		const approval = await pendingApproval();
		expect((await api("/sessions")).body.sessions.find((info: { id: string }) => info.id === approval.session).agent.id).toBe(concierge.id);

		let forwarded = "";
		scripts({
			Concierge: [() => toolUse("send_to_user", { message: "Booked." })],
			lead: [
				(context) => {
					forwarded = lastUserText(context.messages);
					return fauxAssistantMessage("Noted.");
				},
			],
		});
		await post(`/approvals/${approval.id}/approve`);
		expect((await decisionRun(approval)).replies).toEqual(["Booked."]);
		await vi.waitFor(() => expect(forwarded).toBe(`[Chat with Concierge] In chat ${approval.session}, after the decision on its approval request, Concierge said:\nBooked.`));
	});

	it("decides other agents' approvals for the person, or asks them, under the majordomo policy", async () => {
		await api("/settings", { method: "PUT", body: JSON.stringify({ approvalPolicy: "majordomo" }) });
		const realFetch = globalThis.fetch;
		const sent: string[] = [];
		vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
			const request = new Request(input, init);
			if (!request.url.startsWith("https://hooks.example.test/")) return realFetch(input, init);
			sent.push(request.url);
			return new Response("booked", { status: 201 });
		});
		const { name } = await majordomo();
		const booker = (await post("/agents", { name: "Booker", instructions: "Book what the person asks for." })).body;
		const chat = (await post("/sessions", { agent: booker.id })).body.id;
		const chats = async () => (await api("/sessions")).body.sessions.map((info: { id: string }) => info.id);
		const before = await chats();

		// It approves what it is sure the person wants; the agent hears who decided, and why.
		let review = { prompt: "", tools: [] as string[], request: "" };
		let outcome = "";
		scripts({
			lead: [
				() => toolUse("http_request", { method: "POST", url: "https://hooks.example.test/hotel" }),
				() => toolUse("send_to_user", { message: "Asked." }),
				(context) => {
					outcome = lastUserText(context.messages);
					return toolUse("send_to_user", { message: "Booked." });
				},
			],
			review: [
				(context) => {
					review = {
						prompt: systemPrompt(context.messages),
						tools: context.messages.flatMap((message) => (message.role === "system" ? (message.toolsAdded ?? []).map((tool) => tool.name) : [])),
						request: lastUserText(context.messages),
					};
					return toolUse("decide_approval", { decision: "approve", note: "They asked for this hotel." });
				},
				() => fauxAssistantMessage("Approved."),
			],
		});
		await say("Book the hotel.", chat);
		const approved = await vi.waitFor(async () => {
			const [approval] = (await api<{ approvals: Approval[] }>("/approvals?status=approved")).body.approvals;
			expect(approval).toBeDefined();
			return approval!;
		});
		expect(approved).toMatchObject({ decidedBy: "majordomo", note: "They asked for this hotel.", result: "HTTP 201 Created\nbooked" });
		expect(sent).toEqual(["https://hooks.example.test/hotel"]);
		expect((await decisionRun(approved)).status).toBe("done");
		expect(outcome).toContain(`${name}, the user's majordomo, approved it for them: POST https://hooks.example.test/hotel`);
		expect(outcome).toContain(`${name}'s note: They asked for this hotel.`);
		expect(review.prompt).toContain(`You are \\"${name}\\", the majordomo of one person`);
		expect(review.request).toContain("Booker, in a chat the person has with it, asks for approval.");
		expect(review.tools.sort()).toEqual(["decide_approval", "recall", "zoom"]);
		// The review isn't a chat, and nobody was notified: there was nothing to ask.
		expect((await chats()).sort()).toEqual(before.sort());
		const notified = async () => (await api("/notifications")).body.notifications.filter((notification: { session: string }) => notification.session === chat);
		expect(await notified()).toEqual([]);

		// What it isn't sure about goes to the person, with what it has to say, and waits for them.
		scripts({
			lead: [
				() => toolUse("http_request", { method: "POST", url: "https://hooks.example.test/pay" }),
				() => toolUse("send_to_user", { message: "Asked." }),
			],
			review: [
				() => toolUse("decide_approval", { decision: "escalate", note: "It's a payment: your call." }),
				() => fauxAssistantMessage("Asked them."),
			],
		});
		await say("Pay the deposit.", chat);
		const escalated = await vi.waitFor(async () => {
			const approval = await pendingApproval();
			expect(approval.review).toEqual({ status: "escalated", note: "It's a payment: your call." });
			return approval;
		});
		expect(escalated.expiresAt).toBeNull();
		expect(await notified()).toEqual([
			expect.objectContaining({ title: `${name} needs your approval`, body: "POST https://hooks.example.test/pay\nIt's a payment: your call.", session: chat }),
		]);
		expect(sent).toEqual(["https://hooks.example.test/hotel"]);
		scripts({ lead: [() => toolUse("send_to_user", { message: "Not paid." })] });
		expect((await post<Approval>(`/approvals/${escalated.id}/deny`)).body).toMatchObject({ status: "denied", decidedBy: "user" });
		expect((await decisionRun(escalated)).status).toBe("done");

		// The majordomo's own requests, in its chats with the person, go straight to them.
		scripts({
			lead: [
				() => toolUse("http_request", { method: "POST", url: "https://hooks.example.test/own" }),
				() => toolUse("send_to_user", { message: "Asked you." }),
			],
		});
		await say("Call the hook.");
		const own = await pendingApproval();
		expect(own).toMatchObject({ review: null, expiresAt: null });
		scripts({ lead: [() => toolUse("send_to_user", { message: "Fine." })] });
		await post(`/approvals/${own.id}/deny`);
		expect((await decisionRun(own)).status).toBe("done");
	});
});
