import type { Message } from "@earendil-works/pi-ai";
import { type FauxResponseFactory, fauxAssistantMessage } from "@earendil-works/pi-ai/providers/faux";
import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import { exports } from "cloudflare:workers";
import { describe, expect, it, vi } from "vitest";
import type { Approval } from "../src/store";
import { api, lastUserText, messagesOf, pendingApproval, post, ROOT, say, scripts, settled, speaker, systemPrompt, TOKEN, toolUse, url } from "./helpers";
import { spans } from "./worker";

type Context = Parameters<FauxResponseFactory>[0];

type PublicTask = { id: string; parent: string | null; agent: { name: string; member: boolean }; from: { name: string }; task: string; state: string; result: string | null };

const toolResult = (messages: readonly Message[]) =>
	JSON.stringify(messages.findLast((message) => message.role === "toolResult")?.content);

const tools = (context: Context) => context.messages.flatMap((message) => (message.role === "system" ? (message.toolsAdded ?? []).map((tool) => tool.name) : []));

const tasksOf = async (session: string) => (await api<{ tasks: PublicTask[] }>(`/sessions/${session}/tasks`)).body.tasks;

/** The updates a chat was given: messages starting with "[Task update]". */
const updatesIn = async (session: string) => (await messagesOf(session, "user")).filter((text) => text.startsWith("[Task update]"));

const planner = {
	name: "Trip planner",
	instructions: "Plan trips in detail.",
	team: [
		{ name: "Researcher", instructions: "Find facts and cite where they came from." },
		{ name: "Writer", instructions: "Write plans as short lists.", tools: ["current_time"] },
	],
};

describe("an agent's team", () => {
	it("works on the tasks the agent hands out at the same time, without the agent waiting, which goes on once they all answer", async () => {
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
			seen[speaker(context)] = { prompt: systemPrompt(context.messages), tools: tools(context), task: lastUserText(context.messages) };
		};
		let handedOut = "";
		let update = "";
		// The members are held until the agent's turn is over, and both have started: the agent doesn't wait for them, and they work at the same time.
		let release = () => {};
		const released = new Promise<void>((resolve) => {
			release = resolve;
		});
		let started = 0;
		const member = (answer: string) => async (context: Context) => {
			record(context);
			started++;
			await released;
			return fauxAssistantMessage(answer);
		};
		scripts({
			lead: [
				(context) => {
					record(context);
					return toolUse("delegate", {
						tasks: [
							{ to: "researcher", task: "Find the best month to visit Lisbon." },
							{ to: "Writer", task: "Draft a three-day outline." },
						],
					});
				},
				(context) => {
					handedOut = toolResult(context.messages);
					return toolUse("send_to_user", { message: "I asked my team." });
				},
				(context) => {
					update = lastUserText(context.messages);
					return toolUse("send_to_user", { message: "Go in May." });
				},
			],
			Researcher: [member("May: mild and before the crowds.")],
			Writer: [member("Day 1: Alfama. Day 2: Belém. Day 3: Sintra.")],
		});
		expect(await say("Plan Lisbon for me.", session)).toMatchObject({ status: "done", replies: ["I asked my team."] });
		await vi.waitFor(() => expect(started).toBe(2));
		const working = await tasksOf(session);
		expect(working.map((task) => [task.agent.name, task.state, task.from.name, task.parent])).toEqual([
			["Researcher", "working", "Trip planner", null],
			["Writer", "working", "Trip planner", null],
		]);
		const [researcher, writer] = working as [PublicTask, PublicTask];
		expect(handedOut).toContain(`Task ${researcher.id}: Researcher is on it.`);
		expect(handedOut).toContain(`Task ${writer.id}: Writer is on it.`);
		release();
		await settled(session);
		expect(await messagesOf(session, "user")).toEqual(["Plan Lisbon for me.", update]);

		// The agent knows its team; each member knows who it is, who asked, its own instructions, and only its tools.
		expect(seen.lead!.prompt).toContain("- Researcher: Find facts and cite where they came from.");
		expect(seen.lead!.tools).toContain("delegate");
		expect(seen.Researcher!.prompt).toContain("working on a task Trip planner handed you");
		expect(seen.Researcher!.prompt).toContain("Find facts and cite where they came from.");
		expect(seen.Researcher!.prompt).not.toContain("Write plans as short lists.");
		expect(seen.Researcher!.prompt).not.toContain("Plan trips in detail.");
		expect(seen.Researcher!.task).toBe("Find the best month to visit Lisbon.");
		expect(seen.Researcher!.tools).toContain("current_time");
		for (const tool of ["send_to_user", "delegate", "schedule_task", "watch_app_event", "create_agent", "update_agent", "rename_agent", "manage_apps", "write_skill"]) expect(seen.Researcher!.tools).not.toContain(tool);
		expect(seen.Writer!.tools).toEqual(["current_time"]);
		// Their answers come in one update, by task.
		expect(update).toMatch(/^\[Task update\] /);
		expect(update).toContain(`Researcher finished task ${researcher.id}:\nMay: mild and before the crowds.`);
		expect(update).toContain(`Writer finished task ${writer.id}:\nDay 1: Alfama. Day 2: Belém. Day 3: Sintra.`);

		// The person sees what the team did, read-only; tasks' conversations aren't chats.
		expect((await tasksOf(session)).map((task) => [task.agent.name, task.state, task.result])).toEqual([
			["Researcher", "completed", "May: mild and before the crowds."],
			["Writer", "completed", "Day 1: Alfama. Day 2: Belém. Day 3: Sintra."],
		]);
		const transcript = (await api(`/sessions/${session}/tasks/${researcher.id}`)).body;
		expect(transcript.messages.map((message: { role: string }) => message.role)).toEqual(["user", "assistant"]);
		const listed = (await api("/sessions")).body.sessions.map((info: { id: string }) => info.id);
		expect(listed).toEqual(expect.arrayContaining([session, ROOT]));
		expect(listed).toHaveLength(2);
		expect((await api(`/sessions/${ROOT}/tasks/${researcher.id}`)).status).toBe(404);

		// An agent with no one to hand tasks to is told so, as is one that names someone it can't.
		const solo = (await post("/sessions", { agent: (await post("/agents", { name: "Solo" })).body.id })).body.id;
		const results: string[] = [];
		scripts({
			lead: [
				() => toolUse("delegate", { tasks: [{ to: "Researcher", task: "x" }] }),
				(context) => {
					results.push(toolResult(context.messages));
					return toolUse("send_to_user", { message: "Fine." });
				},
			],
		});
		await say("Ask your team.", solo);
		scripts({
			lead: [
				() => toolUse("delegate", { tasks: [{ to: "Editor", task: "x" }] }),
				(context) => {
					results.push(toolResult(context.messages));
					return toolUse("send_to_user", { message: "Fine." });
				},
			],
		});
		await say("Ask your editor.", session);
		expect(results[0]).toContain("You have no one to hand tasks to: do the work yourself.");
		expect(results[1]).toContain("No one called Editor to hand tasks to. You can hand them to: Researcher, Writer.");
	});

	it("shows a member's approval in the agent's chat, where its task waits for the person, and the agent hears its answer once it is decided", async () => {
		await api("/settings", { method: "PUT", body: JSON.stringify({ approvalPolicy: "explicit" }) });
		const realFetch = globalThis.fetch;
		vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
			const request = new Request(input, init);
			return request.url.startsWith("https://hooks.example.test/") ? new Response("booked", { status: 201 }) : realFetch(input, init);
		});
		const agent = (await post("/agents", { ...planner, name: "Booker" })).body;
		const session = (await post("/sessions", { agent: agent.id })).body.id;
		let result = "";
		let update = "";
		scripts({
			lead: [
				() => toolUse("delegate", { tasks: [{ to: "Researcher", task: "Book the hotel." }] }),
				() => toolUse("send_to_user", { message: "Researcher is booking it." }),
				(context) => {
					update = lastUserText(context.messages);
					return toolUse("send_to_user", { message: "Your hotel is booked: confirmation 77." });
				},
			],
			Researcher: [
				() => toolUse("http_request", { method: "POST", url: "https://hooks.example.test/hotel" }),
				(context) => {
					result = toolResult(context.messages);
					return fauxAssistantMessage("Booked: confirmation 77.");
				},
			],
		});
		expect(await say("Book my hotel.", session)).toMatchObject({ replies: ["Researcher is booking it."] });
		const approval = await pendingApproval();
		const [task] = await vi.waitFor(async () => {
			const tasks = await tasksOf(session);
			expect(tasks[0]?.state).toBe("auth-required");
			return tasks;
		});
		expect(approval).toMatchObject({ member: { name: "Researcher", session } });
		const notifications = (await api("/notifications")).body.notifications;
		expect(notifications).toContainEqual(expect.objectContaining({ title: "Pim needs your approval", session }));
		// A task waiting for the person alone tells the agent nothing yet.
		expect(await updatesIn(session)).toEqual([]);

		expect((await post<Approval>(`/approvals/${approval.id}/approve`)).body.status).toBe("approved");
		await settled(session);
		expect(result).toContain(`[Approval ${approval.id}] The user approved`);
		expect(update).toContain(`Researcher finished task ${task!.id}:\nBooked: confirmation 77.`);
		expect(await updatesIn(session)).toEqual([update]);
		expect((await tasksOf(session))[0]).toMatchObject({ state: "completed", result: "Booked: confirmation 77." });
		await api("/settings", { method: "PUT", body: JSON.stringify({ approvalPolicy: null }) });
	});
});

describe("the majordomo", () => {
	const majordomo = async () => ((await api("/agents")).body.agents as { id: string; name: string; majordomo: boolean }[]).find((agent) => agent.majordomo)!;

	it("hands tasks to the person's other agents, in conversations of their own that aren't chats, and only it can", async () => {
		const self = await majordomo();
		await api(`/agents/${self.id}`, { method: "PUT", body: JSON.stringify({ name: "Alfred" }) });
		const scout = (await post("/agents", { name: "Scout", instructions: "Find facts and cite where they came from." })).body;
		const chats = async () => (await api("/sessions")).body.sessions.map((info: { id: string }) => info.id).sort();
		const before = await chats();

		let lead = { prompt: "", tools: [] as string[] };
		let scoutSaw = { prompt: "", tools: [] as string[], message: "" };
		const results: string[] = [];
		scripts({
			lead: [
				(context) => {
					lead = { prompt: systemPrompt(context.messages), tools: tools(context) };
					return toolUse("delegate", { tasks: [{ to: "scout", task: "Find the best month to visit Lisbon." }] });
				},
				() => toolUse("send_to_user", { message: "I asked Scout." }),
				(context) => {
					results.push(lastUserText(context.messages));
					return toolUse("send_to_user", { message: "Scout says May." });
				},
			],
			Scout: [
				(context) => {
					scoutSaw = { prompt: systemPrompt(context.messages), tools: tools(context), message: lastUserText(context.messages) };
					return fauxAssistantMessage("May: mild and before the crowds.");
				},
			],
		});
		expect(await say("When should I go to Lisbon?")).toMatchObject({ status: "done", replies: ["I asked Scout."] });
		await settled();

		expect(lead.prompt).toContain("You are the person's majordomo, Alfred");
		expect(lead.prompt).toContain(`- Scout [id: ${scout.id}]`);
		expect(lead.tools).toContain("delegate");
		expect(lead.tools).not.toContain("send_to_agent");
		expect(lead.prompt).toContain("The person's other agents:");
		// Scout works for Alfred there, with its own instructions, and answers it, not the person.
		expect(scoutSaw.prompt).toContain("working on a task Alfred handed you");
		expect(scoutSaw.prompt).toContain("Find facts and cite where they came from.");
		expect(scoutSaw.prompt).not.toContain("majordomo, Scout");
		expect(scoutSaw.message).toBe("Find the best month to visit Lisbon.");
		expect(scoutSaw.tools).not.toContain("send_to_user");
		const [task] = await tasksOf(ROOT);
		expect(task).toMatchObject({ agent: { name: "Scout", member: false }, from: { name: "Alfred" }, state: "completed" });
		expect(results[0]).toContain(`Scout finished task ${task!.id}:\nMay: mild and before the crowds.`);
		// It is no chat, and the person's chat has only what they said and the update.
		expect(await chats()).toEqual(before);
		expect(await messagesOf(ROOT, "user")).toEqual(expect.arrayContaining(["When should I go to Lisbon?", results[0]]));

		// It follows up in the task's conversation, only on a task it handed out, and only to agents that exist.
		scripts({
			lead: [
				() => toolUse("delegate", { tasks: [{ to: "Nobody", task: "Hi." }] }),
				(context) => {
					results.push(toolResult(context.messages));
					return toolUse("delegate", { tasks: [{ to: "Scout", task: "Hi.", continues: "nope" }] });
				},
				(context) => {
					results.push(toolResult(context.messages));
					return toolUse("delegate", { tasks: [{ to: "Scout", task: "And in autumn?", continues: task!.id }] });
				},
				() => toolUse("send_to_user", { message: "Asking about autumn." }),
				(context) => {
					results.push(lastUserText(context.messages));
					return toolUse("send_to_user", { message: "October works too." });
				},
			],
			Scout: [() => fauxAssistantMessage("October.")],
		});
		await say("And autumn?");
		await settled();
		expect(results[1]).toContain("No one called Nobody to hand tasks to. You can hand them to: ");
		expect(results[1]).toContain("Scout");
		expect(results[2]).toContain("No task nope you handed Scout");
		expect(results[3]).toContain("Scout finished task");
		expect(results[3]).toContain("October.");
		const [first, second] = await tasksOf(ROOT);
		const conversation = (await api(`/sessions/${ROOT}/tasks/${second!.id}`)).body.messages.filter((message: { role: string }) => message.role === "user");
		expect(conversation.map((message: { parts: { text: string }[] }) => message.parts[0]!.text)).toEqual(["Find the best month to visit Lisbon.", "And in autumn?"]);
		expect(first!.id).toBe(task!.id);
		expect(await chats()).toEqual(before);

		// Another agent's chats don't offer it the person's other agents.
		const own = (await post("/sessions", { agent: scout.id })).body.id;
		scripts({
			Scout: [
				(context) => {
					scoutSaw = { ...scoutSaw, prompt: systemPrompt(context.messages) };
					return toolUse("send_to_user", { message: "Hi." });
				},
			],
		});
		await say("Hello", own);
		expect(scoutSaw.prompt).not.toContain("The person's other agents:");
	});

	it("hears an agent's answer to a task once, once its team has answered the agent", async () => {
		await post("/agents", { ...planner, name: "Lisbon planner" });
		let planned = "";
		let researched = "";
		// The researcher answers only once the planner's turn is over.
		let release = () => {};
		const released = new Promise<void>((resolve) => {
			release = resolve;
		});
		scripts({
			lead: [
				() => toolUse("delegate", { tasks: [{ to: "Lisbon planner", task: "Plan three days in Lisbon." }] }),
				() => toolUse("send_to_user", { message: "Lisbon planner is on it." }),
				(context) => {
					planned = lastUserText(context.messages);
					return toolUse("send_to_user", { message: "Here's your plan." });
				},
			],
			"Lisbon planner": [
				() => toolUse("delegate", { tasks: [{ to: "Researcher", task: "Find the best month." }] }),
				// Its turn ends while its team works: its task isn't done yet.
				() => fauxAssistantMessage("I asked my researcher."),
				(context) => {
					researched = lastUserText(context.messages);
					return fauxAssistantMessage("Three days in May: Alfama, Belém, Sintra.");
				},
			],
			Researcher: [
				async () => {
					await released;
					return fauxAssistantMessage("May.");
				},
			],
		});
		await say("Plan Lisbon.");
		const turnEnded = async () => {
			const plan = (await tasksOf(ROOT)).find((task) => task.agent.name === "Lisbon planner")!;
			const { messages } = (await api(`/sessions/${ROOT}/tasks/${plan.id}`)).body;
			expect(JSON.stringify(messages)).toContain("I asked my researcher.");
		};
		await vi.waitFor(turnEnded);
		await new Promise((resolve) => setTimeout(resolve, 100));
		expect((await tasksOf(ROOT)).find((task) => task.agent.name === "Lisbon planner")!.state).toBe("working");
		release();
		await settled();
		const tasks = await tasksOf(ROOT);
		const plan = tasks.find((task) => task.agent.name === "Lisbon planner")!;
		const research = tasks.find((task) => task.agent.name === "Researcher")!;
		expect(research).toMatchObject({ parent: plan.id, from: { name: "Lisbon planner" }, state: "completed", result: "May." });
		expect(plan).toMatchObject({ parent: null, state: "completed", result: "Three days in May: Alfama, Belém, Sintra." });
		expect(researched).toContain(`Researcher finished task ${research.id}:\nMay.`);
		expect(planned).toContain(`Lisbon planner finished task ${plan.id}:\nThree days in May: Alfama, Belém, Sintra.`);
		expect(planned).not.toContain("I asked my researcher.");
		expect((await updatesIn(ROOT)).filter((update) => update.includes(plan.id))).toEqual([planned]);
	});

	it("talks with MCP clients at /mcp, a new chat per call unless they continue one, waiting for the work it hands out", async () => {
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
				() => toolUse("delegate", { tasks: [{ to: "Dentist finder", task: "Find a dentist open on Tuesdays." }] }),
				() => toolUse("send_to_user", { message: "Looking for one." }),
				() => toolUse("send_to_user", { message: "Dr. Silva can see you Tuesday at 9." }),
			],
			"Dentist finder": [() => fauxAssistantMessage("Dr. Silva, Tuesday 9:00.")],
		});
		const first = await client.callTool({ name: "pim", arguments: { message: "Find me a dentist" } });
		const { conversation } = first.structuredContent as { conversation: string };
		const reply = "Looking for one.\n\nDr. Silva can see you Tuesday at 9.";
		expect(first.structuredContent).toEqual({ conversation, reply });
		expect(first.content).toEqual([{ type: "text", text: `${reply}\n\n[conversation: ${conversation}]` }]);

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
		const finderChat = (await post("/sessions", { agent: finder.id })).body.id;
		const { name } = (await api("/majordomo")).body.agent;
		for (const other of [finderChat, "nope"]) {
			const refused = await client.callTool({ name: "pim", arguments: { message: "Hi", conversation: other } });
			expect(refused).toMatchObject({ isError: true, content: [{ type: "text", text: `No conversation ${other} with ${name}: leave out conversation to start one.` }] });
		}
		await client.close();

		expect((await exports.default.fetch(url("/mcp"), { method: "POST" })).status).toBe(401);
	});

	it("hears what an agent did once an approval in its task is decided, once", async () => {
		await api("/settings", { method: "PUT", body: JSON.stringify({ approvalPolicy: "explicit" }) });
		const sent: string[] = [];
		vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
			sent.push(new Request(input).url);
			return new Response("booked", { status: 201 });
		});
		await post("/agents", { name: "Concierge", instructions: "Book what the person asks for." });
		let update = "";
		scripts({
			lead: [
				() => toolUse("delegate", { tasks: [{ to: "Concierge", task: "Book the hotel." }] }),
				() => toolUse("send_to_user", { message: "Concierge is booking it." }),
				(context) => {
					update = lastUserText(context.messages);
					return toolUse("send_to_user", { message: "Your hotel is booked." });
				},
			],
			Concierge: [() => toolUse("http_request", { method: "POST", url: "https://hooks.example.test/hotel" }), () => fauxAssistantMessage("Booked.")],
		});
		const before = (await updatesIn(ROOT)).length;
		await say("Book my hotel.");
		const approval = await pendingApproval();
		const task = (await tasksOf(ROOT)).at(-1)!;
		// It shows in the chat the work began in, from the agent that asked.
		expect(approval).toMatchObject({ member: { name: "Concierge", session: ROOT } });

		await post(`/approvals/${approval.id}/approve`);
		await settled();
		expect(sent).toEqual(["https://hooks.example.test/hotel"]);
		expect(update).toContain(`Concierge finished task ${task.id}:\nBooked.`);
		// It hears it once, in one update, and nothing else comes to its chat.
		const updates = await updatesIn(ROOT);
		expect(updates.slice(before)).toEqual([update]);
		expect((await messagesOf(ROOT, "user")).at(-2)).toBe("Book my hotel.");
		await api("/settings", { method: "PUT", body: JSON.stringify({ approvalPolicy: null }) });
	});

	it("stops a task the person cancels, or whose chat they delete, and nothing it asked for runs", async () => {
		await api("/settings", { method: "PUT", body: JSON.stringify({ approvalPolicy: "explicit" }) });
		const sent: string[] = [];
		vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
			sent.push(new Request(input).url);
			return new Response("ok", { status: 201 });
		});
		await post("/agents", { name: "Payer", instructions: "Pay what the person asks." });
		let update = "";
		scripts({
			lead: [
				() => toolUse("delegate", { tasks: [{ to: "Payer", task: "Pay the deposit." }] }),
				() => toolUse("send_to_user", { message: "Payer is on it." }),
				(context) => {
					update = lastUserText(context.messages);
					return toolUse("send_to_user", { message: "Canceled." });
				},
			],
			Payer: [() => toolUse("http_request", { method: "POST", url: "https://hooks.example.test/pay" })],
		});
		await say("Pay the deposit.");
		const approval = await pendingApproval();
		const task = await vi.waitFor(async () => {
			const last = (await tasksOf(ROOT)).at(-1)!;
			expect(last.state).toBe("auth-required");
			return last;
		});
		expect((await post(`/sessions/${ROOT}/tasks/${task.id}/cancel`)).body).toMatchObject({ state: "canceled", result: "The person canceled it." });
		await settled();
		expect((await api<{ approvals: Approval[] }>(`/approvals?status=denied`)).body.approvals.map((denied) => denied.id)).toContain(approval.id);
		expect(update).toContain(`Task ${task.id} for Payer was canceled: The person canceled it.`);
		expect(sent).toEqual([]);

		// Deleting the chat a task was handed out from cancels it too.
		const chat = (await post("/sessions", {})).body.id;
		scripts({
			lead: [() => toolUse("delegate", { tasks: [{ to: "Payer", task: "Pay the rent." }] }), () => toolUse("send_to_user", { message: "Payer is on it." })],
			Payer: [() => toolUse("http_request", { method: "POST", url: "https://hooks.example.test/rent" })],
		});
		await say("Pay the rent.", chat);
		const rent = await pendingApproval();
		const [handed] = await tasksOf(chat);
		await api(`/sessions/${chat}`, { method: "DELETE" });
		await vi.waitFor(async () => expect((await api<Approval>(`/approvals/${rent.id}`)).body.status).toBe("denied"));
		expect((await post(`/approvals/${rent.id}/approve`)).status).toBe(409);
		expect(sent).toEqual([]);
		expect(handed).toBeDefined();

		// Deleting the agent doing a task cancels it too: no other agent takes it over.
		const mover = (await post("/agents", { name: "Mover", instructions: "Move money." })).body;
		let told = "";
		scripts({
			lead: [
				() => toolUse("delegate", { tasks: [{ to: "Mover", task: "Move the savings." }] }),
				() => toolUse("send_to_user", { message: "Mover is on it." }),
				(context) => {
					told = lastUserText(context.messages);
					return toolUse("send_to_user", { message: "Mover is gone." });
				},
			],
			Mover: [() => toolUse("http_request", { method: "POST", url: "https://hooks.example.test/move" })],
		});
		await say("Move my savings.");
		const move = await pendingApproval();
		const moving = (await tasksOf(ROOT)).at(-1)!;
		expect((await api(`/agents/${mover.id}`, { method: "DELETE" })).body).toEqual({ deleted: true });
		await settled();
		expect((await api<Approval>(`/approvals/${move.id}`)).body.status).toBe("denied");
		expect((await tasksOf(ROOT)).at(-1)).toMatchObject({ id: moving.id, state: "canceled", result: "Its agent was deleted." });
		expect(told).toContain(`Task ${moving.id} for Mover was canceled: Its agent was deleted.`);
		expect(sent).toEqual([]);
		await api("/settings", { method: "PUT", body: JSON.stringify({ approvalPolicy: null }) });
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
		spans.reset();
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
				(context) => {
					outcome = toolResult(context.messages);
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
		// The call waits for the review's decision, and the turn goes on with it.
		expect(await say("Book the hotel.", chat)).toMatchObject({ status: "done", replies: ["Booked."] });
		const [approved] = (await api<{ approvals: Approval[] }>("/approvals?status=approved")).body.approvals;
		expect(approved).toMatchObject({ decidedBy: "majordomo", note: "They asked for this hotel.", result: "HTTP 201 Created\nbooked" });
		expect(sent).toEqual(["https://hooks.example.test/hotel"]);
		expect(outcome).toContain(`${name}, the user's majordomo, approved it for them: POST https://hooks.example.test/hotel`);
		expect(outcome).toContain(`${name}'s note: They asked for this hotel.`);
		expect(review.prompt).toContain(`You are \\"${name}\\", the majordomo of one person`);
		expect(review.request).toContain("Booker, in a chat the person has with it, asks for approval.");
		expect(review.tools.sort()).toEqual(["decide_approval", "recall", "zoom"]);
		// One trace, in OpenTelemetry's conventions for generative AI, holds the request and the review it led to.
		const span = (name: string) => spans.getFinishedSpans().find((candidate) => candidate.name === name)!;
		await vi.waitFor(() => expect(span(`invoke_agent ${name}`)).toBeDefined());
		const run = span("invoke_agent Booker");
		const call = span("execute_tool http_request");
		const reviewRun = span(`invoke_agent ${name}`);
		const decided = span("execute_tool decide_approval");
		const parent = (child: typeof run) => child.parentSpanContext?.spanId;
		expect(run.attributes).toMatchObject({ "gen_ai.operation.name": "invoke_agent", "gen_ai.agent.id": booker.id, "gen_ai.conversation.id": chat, "pim.input.from": "user" });
		expect(parent(call)).toBe(run.spanContext().spanId);
		expect(parent(reviewRun)).toBe(call.spanContext().spanId);
		expect(parent(decided)).toBe(reviewRun.spanContext().spanId);
		expect(new Set([run, call, reviewRun, decided].map((each) => each.spanContext().traceId)).size).toBe(1);
		expect(reviewRun.attributes).toMatchObject({ "pim.input.from": "review" });
		expect(decided.attributes).toMatchObject({ "gen_ai.tool.name": "decide_approval", "gen_ai.tool.call.result": "Approved. Result:\nHTTP 201 Created\nbooked" });
		const reviewChat = spans.getFinishedSpans().find((candidate) => parent(candidate) === reviewRun.spanContext().spanId && candidate.name.startsWith("chat"))!;
		expect(reviewChat.name).toBe("chat faux-model");
		expect(reviewChat.attributes).toMatchObject({ "gen_ai.provider.name": "faux", "gen_ai.response.finish_reasons": ["tool_call"] });
		expect(reviewChat.attributes["gen_ai.system_instructions"]).toContain("the majordomo of one person");
		expect(JSON.parse(String(reviewChat.attributes["gen_ai.output.messages"]))).toEqual([
			{ role: "assistant", parts: [expect.objectContaining({ type: "tool_call", name: "decide_approval" })], finish_reason: "tool_call" },
		]);
		// The review isn't a chat, and nobody was notified: there was nothing to ask.
		expect((await chats()).sort()).toEqual(before.sort());
		const notified = async () => (await api("/notifications")).body.notifications.filter((notification: { session: string }) => notification.session === chat);
		expect(await notified()).toEqual([]);

		// What it isn't sure about goes to the person, with what it has to say, and waits for them.
		scripts({
			lead: [
				() => toolUse("http_request", { method: "POST", url: "https://hooks.example.test/pay" }),
				() => toolUse("send_to_user", { message: "Not paid." }),
			],
			review: [
				() => toolUse("decide_approval", { decision: "escalate", note: "It's a payment: your call." }),
				() => fauxAssistantMessage("Asked them."),
			],
		});
		const paying = say("Pay the deposit.", chat);
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
		expect((await post<Approval>(`/approvals/${escalated.id}/deny`)).body).toMatchObject({ status: "denied", decidedBy: "user" });
		expect(await paying).toMatchObject({ status: "done", replies: ["Not paid."] });

		// The majordomo's own requests, in its chats with the person, go straight to them.
		scripts({
			lead: [
				() => toolUse("http_request", { method: "POST", url: "https://hooks.example.test/own" }),
				() => toolUse("send_to_user", { message: "Fine." }),
			],
		});
		const calling = say("Call the hook.");
		const own = await pendingApproval();
		expect(own).toMatchObject({ review: null, expiresAt: null });
		await post(`/approvals/${own.id}/deny`);
		expect(await calling).toMatchObject({ status: "done", replies: ["Fine."] });
	});
});
