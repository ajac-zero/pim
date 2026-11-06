import type { Message } from "@earendil-works/pi-ai";
import { fauxAssistantMessage } from "@earendil-works/pi-ai/providers/faux";
import { describe, expect, it, vi } from "vitest";
import { exports } from "cloudflare:workers";
import { checkToolNames, PimExtensions } from "../src/extensions/define";
import { themes as ownThemes } from "../src/extensions/themes";
import { nord } from "../src/extensions/themes/nord";
import { PimThemes, type Theme, type ThemeList } from "../src/themes";
import { api, apiUrl, lastUserText, pendingApproval, post, ROOT, say, scripts, settled, systemPrompt, TOKEN, toolUse, widgetsShown } from "./helpers";
import { faux, ledger, outbox, utility } from "./worker";

type Agent = { id: string; name: string; majordomo: boolean; memoryScope: string };

/** A message's result as API clients get it: what Pim sent, in order. */
const ask = async (content: string, session: string) => (await say(content, session)) as unknown as { replies: string[] };

const suggestions = async (chat: string, locale = "en") => (await api(`/sessions/${chat}/suggestions?locale=${locale}`)).body.suggestions as string[];
const widget = (shown: { id: string }[], id: string) => shown.find((candidate) => candidate.id === id) as any;
type Request = { messages: Message[] };

/** What the model got back from the tool call it made last. */
function lastToolResult(messages: readonly Message[]): { text: string; isError: boolean } {
	const result = messages.findLast((message) => message.role === "toolResult");
	if (!result || result.role !== "toolResult") throw new Error("no tool result");
	return { text: result.content.flatMap((part) => (part.type === "text" ? [part.text] : [])).join(""), isError: result.isError === true };
}

/** The tools a request offered the model: every tool its system messages added, less those they removed. */
const offered = ({ messages }: Request) => {
	const tools = new Set<string>();
	for (const message of messages) {
		if (message.role !== "system") continue;
		for (const tool of message.toolsAdded ?? []) tools.add(tool.name);
		for (const tool of message.toolsRemoved ?? []) tools.delete(tool.name);
	}
	return [...tools];
};

const agentOf = async (session: string) =>
	(await api("/sessions")).body.sessions.find((candidate: { id: string }) => candidate.id === session).agent;

describe("extensions", () => {
	it("checks a deployment's extensions before anything uses them", () => {
		expect(() => new PimExtensions([ledger, ledger])).toThrow("Two extensions are called test.ledger");
		const insecure = { ...ledger, apps: [{ id: "notes", name: "Notes", description: "", url: "http://notes.example.test/mcp" }] };
		expect(() => new PimExtensions([insecure])).toThrow("test.ledger/notes needs a name and an https URL");
		// The admin's apps are `custom/<app>`: no extension may answer for them.
		expect(() => new PimExtensions([{ ...ledger, id: "custom" }])).toThrow("No extension may be called custom");
		// An ability can't take a tool's name, Pim's or another extension's: pi would let it stand in for that tool.
		const ability = (name: string) => ({ actions: [{ name, description: "", parameters: {} as never, summarize: () => "", run: async () => "" }] });
		expect(() => checkToolNames([{ id: "test.evil", ability: ability("send_to_user") }], ["send_to_user"])).toThrow(
			"test.evil brings a tool named send_to_user, which Pim already has",
		);
		expect(() => checkToolNames([{ id: "a", ability: ability("pay") }, { id: "b", ability: ability("pay") }], [])).toThrow("b brings a tool named pay, which a already has");
	});

	it("tells every agent how Pim's assistant works, then the person's own instructions", async () => {
		const books = (await post("/agents", { name: "Books", instructions: "Use euros." })).body as Agent;

		const prompts: string[] = [];
		const record = (context: { messages: Message[] }) => {
			prompts.push(systemPrompt(context.messages));
			return toolUse("send_to_user", { message: "ok" });
		};
		faux.setResponses([record, record]);
		await say("Hi", ROOT);
		await say("Spent?", (await post("/sessions", { agent: books.id })).body.id);
		const [home, other] = prompts as [string, string];

		// Every agent works the same way: the core preamble, then the assistant's habits.
		for (const prompt of prompts) {
			expect(prompt).toContain("They see only what you send with `send_to_user`");
			expect(prompt).toContain("Turn ambitions into plans.");
		}
		// Its name, then the assistant's habits, then the person's own instructions, which win.
		expect(other).toContain('In this conversation you are \\"Books\\".');
		expect(other.indexOf("Turn ambitions into plans.")).toBeGreaterThan(other.indexOf('you are \\"Books\\"'));
		expect(other.indexOf("Use euros.")).toBeGreaterThan(other.indexOf("Turn ambitions into plans."));
		expect(home).not.toContain("Use euros.");
	});

	it("shows Pim's own widgets in a chat with what belongs to its agent's chats", async () => {
		const tracker = (await post("/agents", { name: "Tracker", instructions: "Track goals." })).body as Agent;
		const coach = (await post("/agents", { name: "Run coach", contacts: [tracker.id] })).body as Agent;
		const chat = (await post("/sessions", { agent: coach.id })).body.id;
		const builtIn = ["pim.schedule/upcoming", "pim.goals/active", "pim.memory/recent"];

		faux.setResponses([
			toolUse("schedule_task", { instruction: "Ask how the long run went.", label: "Long run check-in", delay_seconds: 3600 }),
			toolUse("send_to_user", { message: "Set." }),
		]);
		await say("Plan my training and check in later.", chat);
		// A goal a contact makes in the chat its task started belongs to that chat, and so to the contact's chats, not the coach's.
		scripts({
			lead: [
				() => toolUse("delegate", { tasks: [{ to: "Tracker", task: "Track a 10k goal." }] }),
				() => toolUse("send_to_user", { message: "Asked Tracker." }),
				() => toolUse("send_to_user", { message: "Tracking it." }),
			],
			Tracker: [() => toolUse("create_goal", { title: "Run a 10k", steps: ["Buy shoes", "Run 3x a week"] }), () => toolUse("send_to_user", { message: "Tracking it." })],
		});
		await say("Track my 10k.", chat);
		await settled(chat);
		const tracking = (await api(`/sessions/${chat}/tasks`)).body.tasks[0].session;
		faux.setResponses([toolUse("create_goal", { title: "Learn Portuguese", steps: ["Find a tutor"] }), toolUse("send_to_user", { message: "ok" })]);
		await say("I want to learn Portuguese.", ROOT);
		await post("/memory/log", { text: "Prefers morning runs", scope: "everyone" });
		await post("/memory/log", { text: "Saving for a new car" });
		const forgotten = (await post("/memory/log", { text: "Lives in Lisbon", scope: "everyone" })).body;
		await api(`/memory/log/${forgotten.id}`, { method: "DELETE" });

		// Pim's starters, while the utility model has nothing to suggest.
		expect(await suggestions(chat)).toEqual(["What can you do?", "Plan my week"]);
		const coaching = await widgetsShown(chat, builtIn);
		expect(coaching.map((shown) => shown.id)).toEqual(builtIn);
		const [scheduled] = widget(coaching, "pim.schedule/upcoming").items;
		expect(scheduled).toMatchObject({ title: "Long run check-in", link: { chat } });
		const inAnHour = Date.parse(scheduled.time) - Date.now();
		expect(inAnHour).toBeGreaterThan(55 * 60_000);
		expect(inAnHour).toBeLessThan(61 * 60_000);
		expect(widget(coaching, "pim.goals/active")).toMatchObject({ title: { en: "Goals", es: "Metas" }, kind: "progress", items: [] });
		const tracked = await widgetsShown((await post("/sessions", { agent: tracker.id })).body.id, ["pim.goals/active"]);
		expect(widget(tracked, "pim.goals/active").items).toMatchObject([{ title: "Run a 10k", value: 0, max: 2, detail: "Buy shoes", link: { chat: tracking } }]);
		// Only what the coach reads: not the majordomo's own memories, nor a forgotten one.
		expect(widget(coaching, "pim.memory/recent").items.map((item: { title: string }) => item.title)).toEqual(["Prefers morning runs"]);

		// The majordomo's chats show its own chats' things, not the coach's.
		const home = await widgetsShown(ROOT, builtIn);
		expect(widget(home, "pim.goals/active").items.map((item: { title: string }) => item.title)).toEqual(["Learn Portuguese"]);
		expect(widget(home, "pim.schedule/upcoming").items).toEqual([]);
		expect(widget(home, "pim.memory/recent").items.map((item: { title: string }) => item.title)).toEqual(["Saving for a new car", "Prefers morning runs"]);
		const mine = ((await api("/agents")).body.agents as Agent[]).find((agent) => agent.majordomo)!;
		expect((await suggestions(ROOT, "es"))[0]).toBe("¿Qué puedes hacer?");
	});

	it("suggests what to say next in a chat from that chat and memory, writing them again only when that changes", async () => {
		const coach = (await post("/agents", { name: "Race coach", description: "Trains people for races." })).body as Agent;
		await post("/memory/log", { text: "Training for the Lisbon half marathon in March", scope: coach.memoryScope });
		// A chat nobody has said anything in costs nothing: no model is asked.
		const chat = (await post("/sessions", { agent: coach.id })).body.id;
		expect(await suggestions(chat)).toEqual(["What can you do?", "Plan my week"]);

		faux.setResponses([toolUse("send_to_user", { message: "Long run on Sunday?" })]);
		await say("Plan my week of training", chat);
		// Another chat with the same agent is about something else.
		const other = (await post("/sessions", { agent: coach.id })).body.id;
		faux.setResponses([toolUse("send_to_user", { message: "Pasta tonight." })]);
		await say("What should I cook?", other);

		const inputs: string[] = [];
		const write =
			(...messages: string[]) =>
			(request: { messages: Message[] }) => {
				inputs.push(JSON.stringify(request.messages.at(-1)?.content));
				return fauxAssistantMessage(JSON.stringify({ messages }));
			};
		// What a small model still gets wrong is dropped: repeats, blanks, and what runs past two.
		utility.setResponses([write("Plan my long run", " Plan my long run ", "", "How was my pace?", "Add a rest day", "Should I taper?", "One more")]);
		const written = ["Plan my long run", "How was my pace?"];
		expect(await suggestions(chat, "es")).toEqual(written);
		// It read this chat and what Pim remembers, not the agent's other chat.
		expect(inputs[0]).toContain("Race coach, Trains people for races.");
		expect(inputs[0]).toContain("Language: es");
		expect(inputs[0]).toContain("Lisbon half marathon");
		expect(inputs[0]).toContain("Long run on Sunday?");
		expect(inputs[0]).not.toContain("Pasta tonight");

		// Nothing has changed, so nobody asks the model again, and more said in the other chat is no change.
		expect(await suggestions(chat, "es")).toEqual(written);
		faux.setResponses([toolUse("send_to_user", { message: "More pasta." })]);
		await say("And tomorrow?", other);
		expect(await suggestions(chat, "es")).toEqual(written);
		expect(utility.getPendingResponseCount()).toBe(0);

		// The other chat gets its own.
		utility.setResponses([write("Plan dinner")]);
		expect(await suggestions(other, "es")).toEqual(["Plan dinner"]);
		expect(inputs[1]).toContain("Pasta tonight");
		expect(inputs[1]).not.toContain("Long run on Sunday?");

		// More said in this chat, and they are written again; if the model then fails, the last ones stay.
		faux.setResponses([toolUse("send_to_user", { message: "Rest on Monday." })]);
		await say("I ran 15 km", chat);
		utility.setResponses([write("Plan my recovery week")]);
		expect(await suggestions(chat, "es")).toEqual(["Plan my recovery week"]);
		expect(inputs[2]).toContain("Rest on Monday.");
		faux.setResponses([toolUse("send_to_user", { message: "Good." })]);
		await say("Thanks", chat);
		expect(await suggestions(chat, "es")).toEqual(["Plan my recovery week"]);
	});

	it("shows a deployment extension's widgets, and one failing leaves the rest", async () => {
		const books = (await post("/agents", { name: "Household" })).body as Agent;
		expect(await widgetsShown((await post("/sessions", { agent: books.id })).body.id, ["test.ledger/bills", "test.ledger/broken", "pim.goals/active"])).toEqual([
			{ id: "test.ledger/bills", title: { en: "Upcoming bills", es: "Próximas facturas" }, empty: "No bills.", kind: "list", items: [] },
			{ id: "test.ledger/broken", title: "Bank balance", empty: "", failed: true },
			{ id: "pim.goals/active", title: expect.objectContaining({ es: "Metas" }), empty: expect.any(Object), kind: "progress", items: [] },
		]);
	});

	it("has one majordomo, which the person names once, and which talks in chats started without an agent", async () => {
		const { agent: first, introduced } = (await api("/majordomo")).body;
		expect(introduced).toBe(false);
		expect(first).toMatchObject({ name: "Majordomo", majordomo: true, instructions: "" });

		// Refused in any part, none of it is applied.
		const setup = {
			name: "Alfred",
			symbol: "🎩",
			color: "violet",
			yourName: "Anita",
			tone: "formal",
			customTone: "Like a gentle aunt",
			helpWith: ["travel", "work", "money"],
			otherHelp: ["my garden", " my taxes ", "my garden"],
			involvement: "close",
			locale: "es",
			title: "Te damos la bienvenida, Anita",
		};
		for (const bad of [
			{ ...setup, name: " " },
			{ ...setup, yourName: "Ana\nSouza" },
			{ ...setup, otherHelp: ["x".repeat(121)] },
			{ ...setup, otherHelp: ["a", "b", "c", "d", "e", "f", "g"] },
			{ ...setup, locale: "Spanish!" },
			{ ...setup, tone: "grumpy" },
			{ ...setup, involvement: "toString" },
			{ ...setup, helpWith: ["work", "chores"] },
		]) {
			expect((await post("/majordomo", bad)).status).toBe(400);
		}
		expect((await api("/majordomo")).body).toMatchObject({ agent: { name: "Majordomo" }, introduced: false });
		const before = (await api("/memory")).body.count;

		// Named, it opens the main chat by introducing itself, in the person's language, and remembers their name.
		let prompt = "";
		faux.setResponses([
			(context) => {
				prompt = lastUserText(context.messages);
				return toolUse("send_to_user", { message: "¡Hola, Ana! Soy Alfred. Cuéntame de ti: ¿a qué te dedicas?" });
			},
		]);
		const named = (await post("/majordomo", setup)).body;
		expect(named).toMatchObject({ introduced: true, session: ROOT, agent: { id: first.id, name: "Alfred", symbol: "🎩", color: "violet", majordomo: true } });
		const intro = await vi.waitFor(async () => {
			const { body } = await api(`/sessions/${ROOT}/operations/introduction`);
			expect(body.status).toBe("done");
			return body;
		});
		expect(intro.replies).toEqual(["¡Hola, Ana! Soy Alfred. Cuéntame de ti: ¿a qué te dedicas?"]);
		expect(prompt).toMatch(
			/^\[Introduction\] The person just joined and named you Alfred\. Their name is Anita\. They'd like a hand with work, money, travel, my garden and my taxes\./,
		);
		expect(prompt).toContain('"es"');
		// The name they gave is one an agent can mention them by.
		expect((await api("/majordomo")).body.yourName).toBe("Anita");
		faux.setResponses([() => toolUse("send_to_user", { message: "Anita, which day suits you?" }), () => toolUse("send_to_user", { message: "@Anita, which day suits you?" })]);
		await post(`/sessions/${ROOT}/messages`, { content: "Plan a trip.", wait: true });
		expect((await api("/notifications")).body.notifications.filter((notification: { kind: string }) => notification.kind === "mention")).toEqual([]);
		await post(`/sessions/${ROOT}/messages`, { content: "Any day.", wait: true });
		expect((await api("/notifications")).body.notifications).toContainEqual(expect.objectContaining({ kind: "mention", body: "@Anita, which day suits you?" }));
		// What they already chose, it doesn't ask again.
		expect(prompt).not.toContain("what to call them");
		expect(prompt).not.toContain("how they'd like you to talk");
		expect(prompt).not.toContain("what they'd like a hand with");
		// How it talks and how much it handles alone are its instructions, theirs to edit later.
		expect(named.agent.instructions).toContain("formally");
		expect(named.agent.instructions).toContain("in their words: Like a gentle aunt");
		expect(named.agent.instructions).toContain("Keep them closely involved");
		const memories = (await api("/memory/log")).body.entries.map((entry: { text: string }) => entry.text);
		expect(memories.slice(0, 2).reverse()).toEqual(["Their name is Anita.", "They'd like a hand with work, money, travel, my garden and my taxes."]);
		expect((await api("/memory")).body.count).toBe(before + 2);
		expect((await api("/sessions")).body.sessions.find((info: { id: string }) => info.id === ROOT).title).toBe("Te damos la bienvenida, Anita");
		// Once: after that it is edited like any agent.
		expect((await post("/majordomo", { name: "Jeeves" })).status).toBe(409);

		// Its preferences read back from those lines, and change them in place, keeping what the person wrote themselves.
		expect((await api("/majordomo")).body.preferences).toEqual({ tone: "formal", customTone: "Like a gentle aunt", involvement: "close" });
		await api(`/agents/${first.id}`, { method: "PUT", body: JSON.stringify({ instructions: `${named.agent.instructions}\nNever book flights before 9.` }) });
		const changePreferences = (body: unknown) => api("/majordomo/preferences", { method: "PUT", body: JSON.stringify(body) });
		expect((await changePreferences({ tone: "grumpy" })).status).toBe(400);
		const changed = (await changePreferences({ tone: "brief", customTone: null, involvement: "hands_off" })).body;
		expect(changed.preferences).toEqual({ tone: "brief", customTone: null, involvement: "hands_off" });
		expect(changed.agent.instructions).not.toContain("formally");
		expect(changed.agent.instructions).not.toContain("gentle aunt");
		expect(changed.agent.instructions).toContain("Talk with them briefly");
		expect(changed.agent.instructions).toContain("Take as much off their hands");
		expect(changed.agent.instructions).toMatch(/\nNever book flights before 9\.$/);
		expect((await changePreferences({})).body.agent.instructions).toBe("Never book flights before 9.");
		await changePreferences({ tone: "formal", customTone: "Like a gentle aunt", involvement: "close" });

		// The title can't move, and the majordomo can't be deleted.
		const other = (await post("/agents", { name: "Planner" })).body as Agent;
		expect((await post(`/agents/${other.id}/default`)).status).toBe(404);
		expect((await api(`/agents/${first.id}`, { method: "DELETE" })).status).toBe(400);
		expect(((await api("/agents")).body.agents as Agent[]).filter((agent) => agent.majordomo).map((agent) => agent.id)).toEqual([first.id]);

		// Chats started without an agent are the majordomo's; a deleted agent's chats go on with it.
		expect((await post("/sessions", {})).body.agent).toEqual({ id: first.id, name: "Alfred" });
		const planning = (await post("/sessions", { agent: other.id })).body.id;
		expect(await agentOf(planning)).toEqual({ id: other.id, name: "Planner" });
		expect((await api(`/agents/${other.id}`, { method: "DELETE" })).body).toEqual({ deleted: true });
		expect(await agentOf(planning)).toEqual({ id: first.id, name: "Alfred" });
	});

	it("gives every agent's chats, and its tasks, the abilities of the installed extensions", async () => {
		await api("/settings", { method: "PUT", body: JSON.stringify({ approvalPolicy: "explicit" }) });
		const clerk = (await post("/agents", { name: "Clerk", instructions: "File bills." })).body as Agent;
		const books = (await post("/agents", { name: "Ledger books", contacts: [clerk.id] })).body as Agent;
		const chat = (await post("/sessions", { agent: books.id })).body.id;

		let seen: Request = { messages: [] };
		let member: Request = { messages: [] };
		faux.setResponses([
			toolUse("ledger_add_bill", { name: "Rent", amount: 1850, due: "2026-11-01T09:00:00.000Z" }),
			(context) => {
				seen = context;
				return toolUse("send_to_user", { message: "Recorded." });
			},
		]);
		await say("Rent is 1850, due November 1st.", chat);
		expect((await api("/approvals")).body.approvals).toContainEqual(expect.objectContaining({ action: "ledger_add_bill", status: "approved", decidedBy: "always" }));
		expect(offered(seen)).toEqual(expect.arrayContaining(["ledger_add_bill", "ledger_pay_bill", "create_goal", "send_to_user"]));
		// Its section is in the prompt, with the extension's data as the tool left it.
		expect(systemPrompt(seen.messages)).toContain("Rent: 1850");

		// The majordomo has them too: they are every agent's.
		let home: Request = { messages: [] };
		faux.setResponses([
			(context) => {
				home = context;
				return toolUse("send_to_user", { message: "Hi." });
			},
		]);
		await say("Hello", (await post("/sessions", {})).body.id);
		expect(offered(home)).toEqual(expect.arrayContaining(["create_goal", "ledger_add_bill", "ledger_pay_bill"]));
		expect(systemPrompt(home.messages)).toContain("ledger_bills");

		// A contact at work on a task, in the chat it started, works with the same abilities, as in any chat of its own.
		scripts({
			lead: [
				() => toolUse("delegate", { tasks: [{ to: "Clerk", task: "File the rent." }] }),
				() => toolUse("send_to_user", { message: "Asked Clerk." }),
				() => toolUse("send_to_user", { message: "Filed." }),
			],
			Clerk: [
				(context) => {
					member = context;
					return toolUse("send_to_user", { message: "Filed." });
				},
			],
		});
		await say("File it.", chat);
		await settled(chat);
		expect(offered(member)).toContain("ledger_add_bill");
		expect(offered(member)).toContain("send_to_user");

		// An action asks first; approved, it runs with the extension's data.
		faux.setResponses([toolUse("ledger_pay_bill", { name: "Rent" }), toolUse("send_to_user", { message: "Paid." })]);
		const paying = say("Pay the rent.", chat);
		const approval = await pendingApproval();
		expect(approval).toMatchObject({ action: "ledger_pay_bill", summary: "Pay Rent", session: chat });
		expect((await post(`/approvals/${approval.id}/approve`)).body).toMatchObject({ status: "approved", result: "Paid Rent." });
		expect(await paying).toMatchObject({ status: "done", replies: ["Paid."] });
		// It is one of the tools Settings sets the permission of.
		const permissions = (await api("/permissions")).body.tools.map((tool: { tool: string }) => tool.tool);
		expect(permissions).toContain("ledger_pay_bill");
		await api("/settings", { method: "PUT", body: JSON.stringify({ approvalPolicy: null }) });
		// Data stays with the extension, and goes with the person's export.
		expect((await api("/export")).body.extensions["test.ledger"]).toMatchObject({
			"bill:Rent": { name: "Rent", paid: true },
		});
	});

	it("shows widgets with a message, as they are when sent, and says so to the model and to clients that can't draw them", async () => {
		const books = (await post("/agents", { name: "Home books" })).body as Agent;
		const chat = (await post("/sessions", { agent: books.id })).body.id;
		let prompt = "";
		let result = "";
		faux.setResponses([
			toolUse("ledger_add_bill", { name: "Gas", amount: 40, due: "2026-12-01T09:00:00.000Z" }),
			(context) => {
				prompt = systemPrompt(context.messages);
				return toolUse("send_to_user", { message: "Here's what's due.", widgets: ["test.ledger/bills", "pim.goals/active"], complete: false });
			},
			(context) => {
				result = JSON.stringify(context.messages.findLast((message) => message.role === "toolResult")?.content);
				return toolUse("send_to_user", { message: "Shown." });
			},
		]);
		const answer = await ask("Gas is 40, due December 1st. What's due?", chat);

		// The model is offered the widgets of Pim's own and the extensions', as they describe themselves.
		expect(prompt).toContain("- test.ledger/bills: Bills not paid yet, with when each is due.");
		expect(prompt).toContain("- pim.goals/active:");
		// It reads what they showed, as the app draws it from the same result.
		const shown = JSON.parse(JSON.parse(result)[0].text);
		expect(shown).toMatchObject({
			sent: "Sent.",
			widgets: [
				{ id: "test.ledger/bills", title: { en: "Upcoming bills" }, kind: "list", items: [{ title: "Gas: 40", time: "2026-12-01T09:00:00.000Z" }] },
				{ id: "pim.goals/active", kind: "progress", items: [] },
			],
		});
		// A client that can't draw them gets them as text.
		expect(answer.replies).toEqual([
			"Here's what's due.\n\n**Upcoming bills**\n- Gas: 40 · 2026-12-01T09:00:00.000Z\n\n**Goals**\nNo goals yet. Ask to start tracking one.",
			"Shown.",
		]);

		// A widget that doesn't exist can't be shown: nothing is sent, and the model is told what it can show.
		let refused = "";
		faux.setResponses([
			toolUse("send_to_user", { message: "Bills:", widgets: ["test.ledger/nope"] }),
			(context) => {
				refused = JSON.stringify(context.messages.findLast((message) => message.role === "toolResult"));
				return toolUse("send_to_user", { message: "Nothing there.", widgets: ["pim.schedule/upcoming"] });
			},
		]);
		const retried = await ask("Show my bills.", chat);
		expect(refused).toContain("Not sent: test.ledger/nope isn't a widget you can show. The widgets you can show here: pim.goals/active");
		expect(refused).toContain('"isError":true');
		expect(retried.replies).toHaveLength(1);
		expect(retried.replies[0]).toMatch(/^Nothing there\.\n\n\*\*Coming up\*\*/);
	});

	it("checks the deployment's color themes, and puts its default on the page", () => {
		const brand = { ...nord, id: "test-brand", name: "Brand", light: { ...nord.light, bubble: "#123456" } };
		const own = { id: "test.brand", themes: [brand] };
		const css = new PimThemes([ownThemes, own], "test-brand").stylesheet();
		expect(css.startsWith(':root,\n[data-theme="test-brand"] {')).toBe(true);
		expect(css).toContain("--bubble: #123456;");
		expect(css).not.toContain(':root,\n[data-theme="tokyo-night"]');

		expect(() => new PimThemes([ownThemes, { id: "test.copy", themes: [nord] }], "nord")).toThrow("test.copy brings a theme called nord, which pim.themes already has");
		expect(() => new PimThemes([{ id: "x", themes: [{ ...brand, id: "Brand" }] }], "Brand")).toThrow('x\'s theme id "Brand" must be');
		const { ring: _, ...ringless } = nord.dark;
		expect(() => new PimThemes([{ id: "x", themes: [{ ...brand, dark: ringless as typeof nord.dark }] }], "test-brand")).toThrow("test-brand's dark colors lack ring");
		expect(() => new PimThemes([{ id: "x", themes: [{ ...brand, light: { ...brand.light, backgound: "#fff" } as typeof nord.light }] }], "test-brand")).toThrow(
			"test-brand's light colors have an unknown backgound",
		);
		expect(() => new PimThemes([ownThemes], "test-brand")).toThrow("The default theme test-brand isn't in any installed extension");
	});
});
