import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import type { Message } from "@earendil-works/pi-ai";
import { type FauxResponseFactory, fauxAssistantMessage } from "@earendil-works/pi-ai/providers/faux";
import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import { env, runInDurableObject } from "cloudflare:test";
import { exports } from "cloudflare:workers";
import { describe, expect, it, vi } from "vitest";
import type { Approval } from "../src/store";
import { api, lastUserText, messagesOf, OWNER, pendingApproval, post, ROOT, say, scripts, settled, speaker, systemPrompt, TOKEN, toolUse, url } from "./helpers";
import { type Pim, spans } from "./worker";

type Context = Parameters<FauxResponseFactory>[0];

type PublicTask = { id: string; parent: string | null; call: string | null; agent: { name: string }; from: { name: string }; task: string; state: string; result: string | null };
type Agent = { id: string; name: string; contacts: string[]; majordomo: boolean };

const toolResult = (messages: readonly Message[]) =>
	JSON.stringify(messages.findLast((message) => message.role === "toolResult")?.content);

const tools = (context: Context) => context.messages.flatMap((message) => (message.role === "system" ? (message.toolsAdded ?? []).map((tool) => tool.name) : []));

const tasksOf = async (session: string) => (await api<{ tasks: PublicTask[] }>(`/sessions/${session}/tasks`)).body.tasks;

/** The updates a chat was given: messages starting with "[Task update]". */
const updatesIn = async (session: string) => (await messagesOf(session, "user")).filter((text) => text.startsWith("[Task update]"));

const agents = async () => (await api<{ agents: Agent[] }>("/agents")).body.agents;

/** One of the person's agents, made the first time it is asked for. */
async function agent(body: { name: string; description?: string; instructions?: string; contacts?: string[] }): Promise<Agent> {
	return (await agents()).find((other) => other.name === body.name) ?? (await post<Agent>("/agents", body)).body;
}

/** A trip planner, with a researcher and a writer for its contacts. */
async function planner(name = "Trip planner"): Promise<Agent> {
	const researcher = await agent({ name: "Researcher", description: "Finds facts", instructions: "Find facts and cite where they came from." });
	const writer = await agent({ name: "Writer", description: "Writes plans", instructions: "Write plans as short lists." });
	return agent({ name, instructions: "Plan trips in detail.", contacts: [researcher.id, writer.id] });
}

describe("an agent's contacts", () => {
	it("work on the tasks the agent hands out at the same time, without the agent waiting, which goes on once they all answer", async () => {
		const majordomo = (await agents()).find((other) => other.majordomo)!;
		// Contacts are others of the person's agents, never the majordomo, which hands tasks to all of them and lists none.
		expect((await post("/agents", { name: "Lost", contacts: ["p_nobody"] })).status).toBe(400);
		expect((await post("/agents", { name: "Lost", contacts: [majordomo.id] })).status).toBe(400);
		const agent = await planner();
		expect((await api(`/agents/${agent.id}`, { method: "PUT", body: JSON.stringify({ contacts: [agent.id] }) })).status).toBe(400);
		expect((await api(`/agents/${majordomo.id}`, { method: "PUT", body: JSON.stringify({ contacts: [agent.id] }) })).status).toBe(400);
		const [researcherId, writerId] = agent.contacts as [string, string];
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

		// The agent knows its contacts; each knows who it is, who asked, and its own instructions, and has none of what only a chat with the person gets.
		expect(seen.lead!.prompt).toContain("Your contacts, the person's agents you hand tasks to:");
		expect(seen.lead!.prompt).toContain("- Researcher: Finds facts");
		expect(seen.lead!.prompt).toContain("- Writer: Writes plans");
		expect(seen.lead!.tools).toContain("delegate");
		expect(seen.Researcher!.prompt).toContain("working on a task Trip planner handed you");
		expect(seen.Researcher!.prompt).toContain("Find facts and cite where they came from.");
		expect(seen.Researcher!.prompt).not.toContain("Write plans as short lists.");
		expect(seen.Researcher!.prompt).not.toContain("Plan trips in detail.");
		expect(seen.Researcher!.task).toBe("Find the best month to visit Lisbon.");
		expect(seen.Researcher!.tools).toContain("current_time");
		for (const tool of ["send_to_user", "schedule_task", "watch_app_event", "create_agent", "update_agent", "manage_apps", "write_skill", "install_skill"]) expect(seen.Researcher!.tools).not.toContain(tool);
		// Nor does a request to write a skill filed from a task's conversation save anything when approved.
		const forged = await runInDurableObject(env.Pim.getByName(OWNER), async (instance: Pim, state) => {
			const conversation = String(state.storage.sql.exec("SELECT conversation FROM pim_tasks WHERE id = ?", researcher.id).one().conversation);
			const write = instance.actions.find((action) => action.name === "write_skill")!;
			return write.run({ by: researcherId, agent: researcherId, name: "lisbon", description: "Plan Lisbon.", instructions: "Go in May." }, { session: conversation });
		});
		expect(forged).toContain("An agent at work on a task writes no skills");
		// Their answers come in one update, by task.
		expect(update).toMatch(/^\[Task update\] /);
		expect(update).toContain(`Researcher finished task ${researcher.id}:\nMay: mild and before the crowds.`);
		expect(update).toContain(`Writer finished task ${writer.id}:\nDay 1: Alfama. Day 2: Belém. Day 3: Sintra.`);

		// The person sees what its contacts did, read-only; tasks' conversations aren't chats.
		expect((await tasksOf(session)).map((task) => [task.agent.name, task.state, task.result])).toEqual([
			["Researcher", "completed", "May: mild and before the crowds."],
			["Writer", "completed", "Day 1: Alfama. Day 2: Belém. Day 3: Sintra."],
		]);
		const transcript = (await api(`/sessions/${session}/tasks/${researcher.id}`)).body;
		expect(transcript.messages.map((message: { role: string }) => message.role)).toEqual(["user", "assistant"]);
		const listed = (await api("/sessions")).body.sessions.map((info: { id: string }) => info.id);
		expect(listed).toEqual(expect.arrayContaining([session, ROOT]));
		expect(listed).toHaveLength(2);
		// A deleted agent leaves the contacts of those that had it.
		expect((await api(`/agents/${writerId}`, { method: "DELETE" })).status).toBe(200);
		expect((await api<Agent>(`/agents/${agent.id}`)).body.contacts).toEqual([researcherId]);
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
		await say("Ask your contacts.", solo);
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
		expect(results[1]).toContain("No one called Editor to hand tasks to. You can hand them to: Researcher.");
	});

	it("shows a contact's approval in the agent's chat, where its task waits for the person, and the agent hears its answer once it is decided", async () => {
		await api("/settings", { method: "PUT", body: JSON.stringify({ approvalPolicy: "explicit" }) });
		const realFetch = globalThis.fetch;
		vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
			const request = new Request(input, init);
			return request.url.startsWith("https://hooks.example.test/") ? new Response("booked", { status: 201 }) : realFetch(input, init);
		});
		const agent = await planner("Booker");
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

	it("waits for the answers when it needs them to reply, suspended meanwhile, and they come as the call's result", async () => {
		const agent = await planner("Concierge");
		const session = (await post("/sessions", { agent: agent.id })).body.id;
		let release = () => {};
		const released = new Promise<void>((resolve) => {
			release = resolve;
		});
		let started = 0;
		const member = (answer: string) => async () => {
			started++;
			await released;
			return fauxAssistantMessage(answer);
		};
		let result = "";
		scripts({
			lead: [
				() =>
					toolUse("delegate", {
						wait: true,
						tasks: [
							{ to: "Researcher", task: "Find the best month to visit Lisbon." },
							{ to: "Writer", task: "Draft a three-day outline." },
						],
					}),
				(context) => {
					result = JSON.parse(toolResult(context.messages))[0].text;
					return toolUse("send_to_user", { message: "Go in May; here is your outline." });
				},
			],
			Researcher: [member("May: mild and before the crowds.")],
			Writer: [member("Day 1: Alfama. Day 2: Belém. Day 3: Sintra.")],
		});
		const said = say("When should I go to Lisbon, and what should I see?", session);
		await vi.waitFor(() => expect(started).toBe(2));
		// The call is suspended while they work: nothing of it runs or waits in memory.
		const calls = await runInDurableObject(env.Pim.getByName(OWNER), async (pim: Pim) =>
			(await (await pim.harness.pi()).inspect(BACKGROUND_CONTEXT)).tasks.flatMap(({ record, state }) => (record.kind === "pi.tool" ? [state.kind] : [])),
		);
		expect(calls).toEqual(["suspended"]);
		// The chat shows the tasks at the call that handed them out, which has no result yet.
		const [researcher, writer] = (await tasksOf(session)) as [PublicTask, PublicTask];
		const { messages } = (await api<{ messages: { parts: { type: string; id?: string; name?: string }[] }[] }>(`/sessions/${session}/messages`)).body;
		const call = messages.flatMap((message) => message.parts).find((part) => part.type === "tool-call" && part.name === "delegate");
		expect([researcher.call, writer.call]).toEqual([call!.id, call!.id]);

		release();
		expect(await said).toMatchObject({ status: "done", replies: ["Go in May; here is your outline."] });
		expect(result).toContain(`Task ${researcher.id}: Researcher answered:\nMay: mild and before the crowds.`);
		expect(result).toContain(`Task ${writer.id}: Writer answered:\nDay 1: Alfama. Day 2: Belém. Day 3: Sintra.`);
		await settled(session);
		// Answers come once: the call returned them, so no update follows.
		expect(await updatesIn(session)).toEqual([]);
		expect((await tasksOf(session)).map((task) => task.state)).toEqual(["completed", "completed"]);
	});

	it("waits through a task's approval for as long as the person takes, and hears the answers in an update when its chat is stopped", async () => {
		await api("/settings", { method: "PUT", body: JSON.stringify({ approvalPolicy: "explicit" }) });
		const realFetch = globalThis.fetch;
		vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
			const request = new Request(input, init);
			return request.url.startsWith("https://hooks.example.test/") ? new Response("booked", { status: 201 }) : realFetch(input, init);
		});
		const agent = await planner("Waiting booker");
		const session = (await post("/sessions", { agent: agent.id })).body.id;
		let result = "";
		scripts({
			lead: [
				() => toolUse("delegate", { wait: true, tasks: [{ to: "Researcher", task: "Book the hotel." }] }),
				(context) => {
					result = JSON.parse(toolResult(context.messages))[0].text;
					return toolUse("send_to_user", { message: "Booked: confirmation 77." });
				},
			],
			Researcher: [
				() => toolUse("http_request", { method: "POST", url: "https://hooks.example.test/hotel" }),
				() => fauxAssistantMessage("Booked: confirmation 77."),
			],
		});
		const booked = say("Book my hotel and tell me the confirmation.", session);
		const approval = await pendingApproval();
		await vi.waitFor(async () => expect((await tasksOf(session))[0]?.state).toBe("auth-required"));
		// Both calls are suspended: the agent's, waiting for the task, and its contact's, waiting for the person.
		const calls = await runInDurableObject(env.Pim.getByName(OWNER), async (pim: Pim) =>
			(await (await pim.harness.pi()).inspect(BACKGROUND_CONTEXT)).tasks.flatMap(({ record, state }) => (record.kind === "pi.tool" ? [state.kind] : [])),
		);
		expect(calls).toEqual(["suspended", "suspended"]);
		expect(result).toBe("");
		await post(`/approvals/${approval.id}/approve`);
		expect(await booked).toMatchObject({ status: "done", replies: ["Booked: confirmation 77."] });
		const [task] = await tasksOf(session);
		expect(result).toBe(`Task ${task!.id}: Researcher answered:\nBooked: confirmation 77.`);
		await settled(session);
		expect(await updatesIn(session)).toEqual([]);
		await api("/settings", { method: "PUT", body: JSON.stringify({ approvalPolicy: null }) });

		let update = "";
		// A chat stopped while it waits hears the answers in an update instead.
		let release = () => {};
		const released = new Promise<void>((resolve) => {
			release = resolve;
		});
		let working = false;
		scripts({
			lead: [
				() => toolUse("delegate", { wait: true, tasks: [{ to: "Writer", task: "Draft a three-day outline." }] }),
				(context) => {
					update = lastUserText(context.messages);
					return toolUse("send_to_user", { message: "Here is the outline." });
				},
			],
			Writer: [
				async () => {
					working = true;
					await released;
					return fauxAssistantMessage("Day 1: Alfama.");
				},
			],
		});
		const said = say("Outline it for me.", session);
		await vi.waitFor(() => expect(working).toBe(true));
		expect((await post(`/sessions/${session}/abort`)).status).toBe(200);
		expect((await said).status).toBe("unanswered");
		release();
		await settled(session);
		expect(update).toMatch(/^\[Task update\] Writer answered/);
		expect(update).toContain("Day 1: Alfama.");
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
					return toolUse("artifact_create", { title: "Lisbon by month", kind: "markdown", content: "# May" });
				},
				() => fauxAssistantMessage("May: mild and before the crowds."),
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
		expect(task).toMatchObject({ agent: { name: "Scout" }, from: { name: "Alfred" }, state: "completed" });
		expect(results[0]).toContain(`Scout finished task ${task!.id}:\nMay: mild and before the crowds.`);
		// It is no chat, and the person's chat has only what they said and the update.
		expect(await chats()).toEqual(before);
		expect(await messagesOf(ROOT, "user")).toEqual(expect.arrayContaining(["When should I go to Lisbon?", results[0]]));
		// What Scout made belongs to the chat its task began in, so it opens beside that chat.
		const made = (await api<{ artifacts: { title: string; session: string | null }[] }>("/artifacts")).body.artifacts;
		expect(made.find((artifact) => artifact.title === "Lisbon by month")?.session).toBe(ROOT);

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

	it("hears an agent's answer to a task once, once its contacts have answered the agent, and work never goes back up the chain", async () => {
		const lisbon = await planner("Lisbon planner");
		const researcher = (await agents()).find((other) => other.name === "Researcher")!;
		// The researcher may hand the planner tasks, but not while it works on one the planner handed it.
		await api(`/agents/${researcher.id}`, { method: "PUT", body: JSON.stringify({ contacts: [lisbon.id] }) });
		let refused = "";
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
				// Its turn ends while its contacts work: its task isn't done yet.
				() => fauxAssistantMessage("I asked my researcher."),
				(context) => {
					researched = lastUserText(context.messages);
					return fauxAssistantMessage("Three days in May: Alfama, Belém, Sintra.");
				},
			],
			Researcher: [
				async () => {
					await released;
					return toolUse("delegate", { tasks: [{ to: "Lisbon planner", task: "Check my work." }] });
				},
				(context) => {
					refused = toolResult(context.messages);
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
		expect(refused).toContain("You have no one to hand tasks to: do the work yourself.");
		await api(`/agents/${researcher.id}`, { method: "PUT", body: JSON.stringify({ contacts: [] }) });
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
		const booker = (await post("/agents", { name: "Reservations", instructions: "Book what the person asks for." })).body;
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
		expect(review.request).toContain("Reservations, in a chat the person has with it, asks for approval.");
		expect(review.tools.sort()).toEqual(["decide_approval", "recall", "zoom"]);
		// One trace, in OpenTelemetry's conventions for generative AI, holds the request and the review it led to.
		const span = (name: string) => spans.getFinishedSpans().find((candidate) => candidate.name === name)!;
		await vi.waitFor(() => expect(span(`invoke_agent ${name}`)).toBeDefined());
		const run = span("invoke_agent Reservations");
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

describe("a group chat", () => {
	type Member = { id: string; name: string; busy: boolean };
	const roomOf = async (session: string) =>
		(await api("/sessions")).body.sessions.find((info: { id: string }) => info.id === session)?.room as { mode: string; members: Member[] } | null;
	/** Waits until every scripted response is used and no agent in the chat is at work. */
	const quiet = async (session: string) => {
		await settled(session);
		await vi.waitFor(async () => expect((await roomOf(session))?.members.filter((member) => member.busy) ?? []).toEqual([]));
	};
	const userTexts = (context: Context) =>
		context.messages.flatMap((message) =>
			message.role === "user" ? [typeof message.content === "string" ? message.content : message.content.flatMap((part) => (part.type === "text" ? [part.text] : [])).join("")] : [],
		);

	it("brings in the agents the person and the host mention: each answers what is for it, in the chat, and hears the rest", async () => {
		const host = (await agents()).find((other) => other.majordomo)!;
		const coach = await agent({ name: "Coach", description: "Plans runs", instructions: "Plan runs in kilometres." });
		await agent({ name: "Physio", description: "Treats injuries", instructions: "Look after the person's knees." });
		const session = (await post("/sessions", {})).body.id;
		const chats = async () => (await api("/sessions")).body.sessions.length;
		const seen: Record<string, Context[]> = { lead: [], Coach: [], Physio: [] };
		const as = (role: string, message: string) => (context: Context) => {
			seen[role]!.push(context);
			return toolUse("send_to_user", { message });
		};
		scripts({ lead: [as("lead", "Happy to help you train.")] });
		await say("I want to run a marathon.", session);
		await quiet(session);
		expect(await roomOf(session)).toBeNull();
		const before = await chats();

		// Mentioned, Coach joins knowing nothing of what was said before, reads it back, and answers in the chat; the host isn't woken.
		let readBack = "";
		scripts({
			Coach: [
				(context) => {
					seen.Coach!.push(context);
					return toolUse("chat_history", {});
				},
				(context) => {
					readBack = toolResult(context.messages);
					return toolUse("send_to_user", { message: "Start with 5 km on Monday." });
				},
			],
		});
		expect(await say("@coach plan my first week", session)).toMatchObject({ status: "done" });
		await quiet(session);
		const [joining] = seen.Coach as [Context];
		expect(systemPrompt(joining.messages)).toContain("Plan runs in kilometres.");
		expect(systemPrompt(joining.messages)).toContain("This chat is a group chat");
		expect(userTexts(joining)).toEqual([`[Room] You joined this chat, with the person and ${host.name}.`, "@coach plan my first week"]);
		expect(readBack).toContain(`The person: I want to run a marathon.\\n\\n${host.name}: Happy to help you train.`);
		expect(readBack).not.toContain("plan my first week");
		expect(await messagesOf(session, "user")).toEqual([
			"I want to run a marathon.",
			"[Room] Coach joined the chat.",
			"@coach plan my first week",
			"[From Coach]\nStart with 5 km on Monday.",
		]);
		expect(await roomOf(session)).toEqual({ mode: "mentions", members: [{ id: coach.id, name: "Coach", busy: false }] });
		// Coach's own conversation isn't one of the person's chats.
		expect(await chats()).toBe(before);

		// Said to no one in particular, it is the host's to answer, having heard Coach. It brings in Physio by
		// mentioning it, which hears that message as what brought it in, and nothing before it.
		scripts({ lead: [as("lead", "Good plan. @Physio, check the knees.")], Physio: [as("Physio", "Knees look fine.")] });
		await say("Sounds good?", session);
		await quiet(session);
		expect(userTexts(seen.lead!.at(-1)!).slice(-3)).toEqual(["@coach plan my first week", "[From Coach]\nStart with 5 km on Monday.", "Sounds good?"]);
		expect(userTexts(seen.Physio![0]!)).toEqual([`[Room] You joined this chat, with the person and ${host.name}, Coach.`, `[From ${host.name}]\nGood plan. @Physio, check the knees.`]);

		// Coach heard all of it without being woken, and has it when mentioned again.
		scripts({ Coach: [as("Coach", "Tuesday is rest.")] });
		await say("@Coach what about Tuesday?", session);
		await quiet(session);
		expect(userTexts(seen.Coach!.at(-1)!).slice(-5)).toEqual([
			"Sounds good?",
			"[Room] Physio joined the chat.",
			`[From ${host.name}]\nGood plan. @Physio, check the knees.`,
			"[From Physio]\nKnees look fine.",
			"@Coach what about Tuesday?",
		]);
		expect((await roomOf(session))?.members.map((member) => member.name)).toEqual(["Coach", "Physio"]);

		// The host takes Physio out once it is done: it hears nothing more, and everyone left hears it left.
		let removed = "";
		scripts({
			lead: [
				() => toolUse("remove_from_chat", { agents: ["@Physio", "Nobody"] }),
				(context) => {
					removed = toolResult(context.messages);
					return toolUse("send_to_user", { message: "Physio is done." });
				},
			],
		});
		await say("Thanks, Physio is no longer needed.", session);
		await quiet(session);
		expect(removed).toContain("Physio left the chat.\\nNobody isn't in this chat.");
		expect((await roomOf(session))?.members.map((member) => member.name)).toEqual(["Coach"]);
		expect((await messagesOf(session, "user")).slice(-2)).toEqual(["Thanks, Physio is no longer needed.", "[Room] Physio left the chat."]);
		const physioHeard = seen.Physio!.length;
		scripts({ Coach: [as("Coach", "Rest on Wednesday.")] });
		await say("@Coach and Wednesday?", session);
		await quiet(session);
		expect(userTexts(seen.Coach!.at(-1)!).slice(-4)).toEqual([
			"Thanks, Physio is no longer needed.",
			"[Room] Physio left the chat.",
			`[From ${host.name}]\nPhysio is done.`,
			"@Coach and Wednesday?",
		]);
		expect(seen.Physio).toHaveLength(physioHeard);

		// Only the host takes agents out; the person does through the API, and can bring one back, afresh.
		const coachTried: string[] = [];
		scripts({
			Coach: [
				() => toolUse("remove_from_chat", { agents: [host.name] }),
				(context) => {
					coachTried.push(toolResult(context.messages));
					return fauxAssistantMessage("I can't.");
				},
				as("Coach", "Fine."),
			],
		});
		await say("@Coach remove the host", session);
		await quiet(session);
		expect(coachTried[0]).toContain("Only the chat's host takes agents out of it.");
		const removing = await api(`/sessions/${session}/room/members/${coach.id}`, { method: "DELETE" });
		expect(removing.body).toEqual({ room: { mode: "mentions", members: [] } });
		expect((await api(`/sessions/${session}/room/members/${coach.id}`, { method: "DELETE" })).status).toBe(404);
		expect((await api(`/sessions/${session}/room/members/${host.id}`, { method: "DELETE" })).status).toBe(404);
		expect(await chats()).toBe(before);
		scripts({ Coach: [as("Coach", "Back again.")] });
		await say("@Coach come back", session);
		await quiet(session);
		expect(userTexts(seen.Coach!.at(-1)!)).toEqual([`[Room] You joined this chat, with the person and ${host.name}.`, "@Coach come back"]);
		expect((await roomOf(session))?.members.map((member) => member.name)).toEqual(["Coach"]);
	});

	it("in an open room wakes every agent for everything said, each choosing whether to answer, unless it is asked", async () => {
		const host = (await agents()).find((other) => other.majordomo)!;
		await agent({ name: "Coach", description: "Plans runs", instructions: "Plan runs in kilometres." });
		const session = (await post("/sessions", {})).body.id;
		expect((await api(`/sessions/${session}/room`, { method: "PUT", body: JSON.stringify({ mode: "loud" }) })).status).toBe(400);
		expect((await api(`/sessions/${session}/room`, { method: "PUT", body: JSON.stringify({ mode: "open" }) })).body).toEqual({ room: { mode: "open", members: [] } });
		/** What each agent let pass, by what it was last told: a reminder to answer would show here. */
		const passed: string[] = [];
		const silent = (role: string) => (context: Context) => {
			passed.push(`${role}: ${lastUserText(context.messages)}`);
			return fauxAssistantMessage("Nothing to add.");
		};

		// The host hears the person speak to Coach, and then Coach, and lets both pass.
		scripts({ lead: [silent("host"), silent("host")], Coach: [() => toolUse("send_to_user", { message: "Hi, I'm Coach." })] });
		expect(await say("@Coach hello", session)).toMatchObject({ status: "done" });
		await quiet(session);
		expect(passed.sort()).toEqual(["host: @Coach hello", "host: [From Coach]\nHi, I'm Coach."]);

		// What the person says to no one in particular, the host answers; Coach hears it, and the host's answer, and lets both pass.
		passed.length = 0;
		scripts({ lead: [() => toolUse("send_to_user", { message: "Start easy." })], Coach: [silent("Coach"), silent("Coach")] });
		expect(await say("Where do we begin?", session)).toMatchObject({ status: "done", replies: ["Start easy."] });
		await quiet(session);
		expect(passed).toEqual(["Coach: Where do we begin?", `Coach: [From ${host.name}]\nStart easy.`]);

		// Coach, mentioned, has to answer: when it doesn't send, it's reminded to.
		passed.length = 0;
		let reminded = "";
		scripts({
			lead: [silent("host"), silent("host")],
			Coach: [
				() => fauxAssistantMessage("5 km, I think."),
				(context) => {
					reminded = lastUserText(context.messages);
					return toolUse("send_to_user", { message: "Run 5 km." });
				},
			],
		});
		expect(await say("@Coach how far?", session)).toMatchObject({ status: "done" });
		await quiet(session);
		expect(reminded).toMatch(/^\[Delivery required\]/);
		expect(passed.sort()).toEqual(["host: @Coach how far?", "host: [From Coach]\nRun 5 km."]);
		expect((await messagesOf(session, "user")).filter((text) => text.startsWith("[From Coach]"))).toEqual(["[From Coach]\nHi, I'm Coach.", "[From Coach]\nRun 5 km."]);
	});
});
