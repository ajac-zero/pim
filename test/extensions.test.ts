import type { Message } from "@earendil-works/pi-ai";
import { fauxAssistantMessage } from "@earendil-works/pi-ai/providers/faux";
import { describe, expect, it, vi } from "vitest";
import { exports } from "cloudflare:workers";
import { checkToolNames, PimExtensions } from "../src/extensions/define";
import { themes as ownThemes } from "../src/extensions/themes";
import { nord } from "../src/extensions/themes/nord";
import { PimThemes, type Theme, type ThemeList } from "../src/themes";
import { api, apiUrl, lastUserText, pendingApproval, post, ROOT, say, scripts, settled, systemPrompt, toolUse } from "./helpers";
import { faux, ledger, outbox } from "./worker";

type Agent = { id: string; name: string; blueprint: string | null; majordomo: boolean };

/** A message's result as API clients get it: what Pim sent, in order. */
const ask = async (content: string, session: string) => (await say(content, session)) as unknown as { replies: string[] };

const dashboard = async (agent: Agent, locale = "en") => (await api(`/agents/${agent.id}/dashboard?locale=${locale}`)).body;
const widget = (board: { widgets: { id: string }[] }, id: string) => board.widgets.find((candidate) => candidate.id === id) as any;
type Request = { messages: Message[] };

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
		expect(() => new PimExtensions([ledger, ledger], null)).toThrow("Two extensions are called test.ledger");
		// A dashboard naming a widget nobody brings would draw nothing: refused.
		const typo = { ...ledger, blueprints: [{ ...ledger.blueprints![0]!, dashboard: ["test.ledger/bils"] }] };
		expect(() => new PimExtensions([typo], null)).toThrow("test.ledger/budget's dashboard shows test.ledger/bils");
		expect(() => new PimExtensions([{ ...ledger, blueprints: [] }], "test.ledger/budget")).toThrow("The default blueprint test.ledger/budget");
		const borrows = { ...ledger, id: "test.other", blueprints: [{ ...ledger.blueprints![0]!, dashboard: [], abilities: ["test.nothing"] }] };
		expect(() => new PimExtensions([borrows], null)).toThrow("test.other/budget uses the ability of test.nothing");
		const missing = { ...ledger, blueprints: [{ ...ledger.blueprints![0]!, dashboard: [], apps: ["test.ledger/nope"] }] };
		expect(() => new PimExtensions([missing], null)).toThrow("test.ledger/budget works with the app test.ledger/nope, which no installed extension brings");
		const insecure = { ...ledger, apps: [{ id: "notes", name: "Notes", description: "", url: "http://notes.example.test/mcp" }] };
		expect(() => new PimExtensions([insecure], null)).toThrow("test.ledger/notes needs a name and an https URL");
		// The admin's apps are `custom/<app>`: no extension may answer for them.
		expect(() => new PimExtensions([{ ...ledger, id: "custom", blueprints: [] }], null)).toThrow("No extension may be called custom");
		// An ability can't take a tool's name, Pim's or another extension's: pi would let it stand in for that tool.
		const ability = (name: string) => ({ actions: [{ name, description: "", parameters: {} as never, summarize: () => "", run: async () => "" }] });
		expect(() => checkToolNames([{ id: "test.evil", ability: ability("send_to_user") }], ["send_to_user"])).toThrow(
			"test.evil brings a tool named send_to_user, which Pim already has",
		);
		expect(() => checkToolNames([{ id: "a", ability: ability("pay") }, { id: "b", ability: ability("pay") }], [])).toThrow("b brings a tool named pay, which a already has");
	});

	it("builds each agent on an extension's blueprint: its instructions first, then the person's own", async () => {
		const [mine] = (await api("/agents")).body.agents as Agent[];
		expect(mine).toMatchObject({ name: "Majordomo", blueprint: "pim.assistant/pim", majordomo: true });
		const { extensions } = (await api("/extensions")).body;
		expect(extensions.flatMap((extension: { blueprints: { ref: string }[] }) => extension.blueprints.map((blueprint) => blueprint.ref))).toEqual([
			"pim.assistant/pim",
			"test.ledger/budget",
		]);

		expect((await post("/agents", { name: "X", blueprint: "Budget" })).status).toBe(400);
		expect((await post("/agents", { name: "X", blueprint: "test.ledger/nope" })).status).toBe(400);
		const budget = (await post("/agents", { name: "Books", blueprint: "test.ledger/budget", instructions: "Use euros." })).body as Agent;
		const bare = (await post("/agents", { name: "Bare", blueprint: null })).body as Agent;
		// Left out, a new agent builds on the deployment's default blueprint.
		expect((await post("/agents", { name: "Coach" })).body.blueprint).toBe("pim.assistant/pim");

		const prompts: string[] = [];
		const record = (context: { messages: Message[] }) => {
			prompts.push(systemPrompt(context.messages));
			return toolUse("send_to_user", { message: "ok" });
		};
		faux.setResponses([record, record, record]);
		await say("Hi", ROOT);
		await say("Spent?", (await post("/sessions", { agent: budget.id })).body.id);
		await say("Hello", (await post("/sessions", { agent: bare.id })).body.id);
		const [assistant, books, plain] = prompts as [string, string, string];

		// Every agent works the same way: the core preamble.
		for (const prompt of prompts) expect(prompt).toContain("They see only what you send with `send_to_user`");
		// Pim's own blueprint brings the assistant's habits; the others don't.
		expect(assistant).toContain("Turn ambitions into plans.");
		expect(books).not.toContain("Turn ambitions into plans.");
		expect(plain).not.toContain("Turn ambitions into plans.");
		// An agent built on another blueprint: its name, then the extension's instructions, then the person's, which win.
		expect(books).toContain('In this conversation you are \\"Books\\".');
		expect(books.indexOf("Answer every money question with a number first.")).toBeGreaterThan(books.indexOf('you are \\"Books\\"'));
		expect(books.indexOf("Use euros.")).toBeGreaterThan(books.indexOf("Answer every money question"));
		expect(plain).not.toContain("Answer every money question");
	});

	it("shows each agent's dashboard, with what belongs to its chats", async () => {
		const mine = ((await api("/agents")).body.agents as Agent[]).find((agent) => agent.majordomo)!;
		const coach = (await post("/agents", { name: "Run coach", team: [{ name: "Tracker", instructions: "Track goals." }] })).body as Agent;
		const chat = (await post("/sessions", { agent: coach.id })).body.id;

		faux.setResponses([
			toolUse("schedule_task", { instruction: "Ask how the long run went.", label: "Long run check-in", delay_seconds: 3600 }),
			toolUse("artifact_create", { title: "Training plan", kind: "markdown", content: "# Week 1" }),
			toolUse("send_to_user", { message: "Set." }),
		]);
		await say("Plan my training and check in later.", chat);
		// The goal comes from a team member's conversation: it belongs to the chat the member works for.
		scripts({
			lead: [
				() => toolUse("delegate", { tasks: [{ to: "Tracker", task: "Track a 10k goal." }] }),
				() => toolUse("send_to_user", { message: "Asked Tracker." }),
				() => toolUse("send_to_user", { message: "Tracking it." }),
			],
			Tracker: [() => toolUse("create_goal", { title: "Run a 10k", steps: ["Buy shoes", "Run 3x a week"] }), () => fauxAssistantMessage("Tracking it.")],
		});
		await say("Track my 10k.", chat);
		await settled(chat);
		faux.setResponses([toolUse("create_goal", { title: "Learn Portuguese", steps: ["Find a tutor"] }), toolUse("send_to_user", { message: "ok" })]);
		await say("I want to learn Portuguese.", ROOT);
		await post("/memory/log", { text: "Prefers morning runs" });
		const forgotten = (await post("/memory/log", { text: "Lives in Lisbon" })).body;
		await api(`/memory/log/${forgotten.id}`, { method: "DELETE" });

		const board = await dashboard(coach);
		expect(board.agent).toMatchObject({ id: coach.id, name: "Run coach", majordomo: false });
		expect(board.starters).toEqual(["What can you do for me?", "Help me plan my week", "Start tracking a goal with me"]);
		expect(board.widgets.map((shown: { id: string }) => shown.id)).toEqual([
			"pim.schedule/upcoming",
			"pim.goals/active",
			"pim.memory/recent",
			"pim.artifacts/recent",
		]);
		const [scheduled] = widget(board, "pim.schedule/upcoming").items;
		expect(scheduled).toMatchObject({ title: "Long run check-in", link: { chat } });
		const inAnHour = Date.parse(scheduled.time) - Date.now();
		expect(inAnHour).toBeGreaterThan(55 * 60_000);
		expect(inAnHour).toBeLessThan(61 * 60_000);
		expect(widget(board, "pim.goals/active")).toMatchObject({
			title: "Goals",
			kind: "progress",
			items: [{ title: "Run a 10k", value: 0, max: 2, detail: "Buy shoes", link: { chat } }],
		});
		// Memory is shared by every agent; a forgotten memory is gone from it.
		expect(widget(board, "pim.memory/recent").items.map((item: { title: string }) => item.title)).toEqual(["Prefers morning runs"]);
		const artifact = widget(board, "pim.artifacts/recent").items;
		expect(artifact).toMatchObject([{ title: "Training plan", link: { artifact: expect.any(String) } }]);

		// The default agent's dashboard shows its own chats' things, not the coach's.
		const home = await dashboard(mine);
		expect(widget(home, "pim.goals/active").items.map((item: { title: string }) => item.title)).toEqual(["Learn Portuguese"]);
		expect(widget(home, "pim.schedule/upcoming").items).toEqual([]);
		expect(widget(home, "pim.artifacts/recent")).toMatchObject({ items: [], empty: expect.stringContaining("Nothing made yet") });
		expect(widget(home, "pim.memory/recent").items.map((item: { title: string }) => item.title)).toEqual(["Prefers morning runs"]);

		// In the person's language, where the extension translated it.
		const spanish = await dashboard(mine, "es");
		expect(widget(spanish, "pim.goals/active").title).toBe("Metas");
		expect(spanish.starters[0]).toBe("¿Qué puedes hacer por mí?");
	});

	it("draws a deployment extension's dashboard, and one widget failing leaves the rest", async () => {
		const books = (await post("/agents", { name: "Household", blueprint: "test.ledger/budget" })).body as Agent;
		const board = await dashboard(books, "es");
		expect(board.starters).toEqual(["¿Cuánto gasté?"]);
		expect(board.widgets).toEqual([
			{ id: "test.ledger/bills", title: "Próximas facturas", empty: "No bills.", kind: "list", items: [] },
			{ id: "test.ledger/broken", title: "Bank balance", empty: "", failed: true },
			{ id: "pim.goals/active", title: "Metas", empty: expect.any(String), kind: "progress", items: [] },
		]);
		const bare = (await post("/agents", { name: "Blank", blueprint: null })).body as Agent;
		expect(await dashboard(bare)).toMatchObject({ starters: [], widgets: [] });

		// Published and made someone's own, an agent keeps what it builds on; so does an agent from nothing.
		for (const [agent, blueprint] of [
			[books, "test.ledger/budget"],
			[bare, null],
		] as const) {
			const template = (await post(`/agents/${agent.id}/publish`)).body;
			expect(template.blueprint).toBe(blueprint);
			expect((await post(`/templates/${template.id}/use`)).body.blueprint).toBe(blueprint);
		}
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

	it("gives an agent's chats, and its team, the abilities of the blueprint it builds on, and only those", async () => {
		await api("/settings", { method: "PUT", body: JSON.stringify({ approvalPolicy: "explicit" }) });
		const books = (await post("/agents", { name: "Books", blueprint: "test.ledger/budget", team: [{ name: "Clerk", instructions: "File bills." }] })).body as Agent;
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
		expect(offered(seen)).toEqual(expect.arrayContaining(["ledger_add_bill", "ledger_pay_bill", "create_goal", "send_to_user"]));
		// Its section is in the prompt, with the extension's data as the tool left it.
		expect(systemPrompt(seen.messages)).toContain("Rent: 1850");
		expect(widget(await dashboard(books), "test.ledger/bills").items).toEqual([{ title: "Rent: 1850", time: "2026-11-01T09:00:00.000Z" }]);

		// The default agent builds on Pim's own blueprint: no ledger in its chats.
		let home: Request = { messages: [] };
		faux.setResponses([
			(context) => {
				home = context;
				return toolUse("send_to_user", { message: "Hi." });
			},
		]);
		await say("Hello", (await post("/sessions", {})).body.id);
		expect(offered(home)).toContain("create_goal");
		expect(offered(home)).not.toContain("ledger_add_bill");
		expect(offered(home)).not.toContain("ledger_pay_bill");
		expect(systemPrompt(home.messages)).not.toContain("ledger_bills");

		// A team member works with its agent's abilities.
		scripts({
			lead: [
				() => toolUse("delegate", { tasks: [{ to: "Clerk", task: "File the rent." }] }),
				() => toolUse("send_to_user", { message: "Asked Clerk." }),
				() => toolUse("send_to_user", { message: "Filed." }),
			],
			Clerk: [
				(context) => {
					member = context;
					return fauxAssistantMessage("Filed.");
				},
			],
		});
		await say("File it.", chat);
		await settled(chat);
		expect(offered(member)).toContain("ledger_add_bill");
		expect(offered(member)).not.toContain("send_to_user");

		// An action asks first; approved, it runs with the extension's data.
		faux.setResponses([toolUse("ledger_pay_bill", { name: "Rent" }), toolUse("send_to_user", { message: "Paid." })]);
		const paying = say("Pay the rent.", chat);
		const approval = await pendingApproval();
		expect(approval).toMatchObject({ action: "ledger_pay_bill", summary: "Pay Rent", session: chat });
		expect((await post(`/approvals/${approval.id}/approve`)).body).toMatchObject({ status: "approved", result: "Paid Rent." });
		expect(await paying).toMatchObject({ status: "done", replies: ["Paid."] });
		expect(widget(await dashboard(books), "test.ledger/bills").items).toEqual([]);
		// It is one of the tools Settings sets the permission of.
		const permissions = (await api("/permissions")).body.tools.map((tool: { tool: string }) => tool.tool);
		expect(permissions).toContain("ledger_pay_bill");
		await api("/settings", { method: "PUT", body: JSON.stringify({ approvalPolicy: null }) });
	});

	it("gives a chat its agent's new abilities from its next message when the agent changes what it builds on", async () => {
		const agent = (await post("/agents", { name: "Switcher" })).body as Agent;
		const chat = (await post("/sessions", { agent: agent.id })).body.id;
		const requests: Request[] = [];
		const record = (context: Request) => {
			requests.push(context);
			return toolUse("send_to_user", { message: "ok" });
		};
		faux.setResponses([record, record, record]);
		await say("One", chat);
		await api(`/agents/${agent.id}`, { method: "PUT", body: JSON.stringify({ blueprint: "test.ledger/budget" }) });
		await say("Two", chat);
		await api(`/agents/${agent.id}`, { method: "PUT", body: JSON.stringify({ blueprint: null }) });
		await say("Three", chat);
		expect(requests.map((request) => offered(request).includes("ledger_add_bill"))).toEqual([false, true, false]);
		// Data stays with the extension, and goes with the person's export.
		expect((await api("/export")).body.extensions["test.ledger"]).toMatchObject({
			"bill:Rent": { name: "Rent", paid: true },
		});
	});

	it("shows widgets with a message, as they are when sent, and says so to the model and to clients that can't draw them", async () => {
		const books = (await post("/agents", { name: "Home books", blueprint: "test.ledger/budget" })).body as Agent;
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

		// The model is offered the widgets that describe themselves, from Pim's own and its agent's blueprint.
		expect(prompt).toContain("- test.ledger/bills: Bills not paid yet, with when each is due.");
		expect(prompt).toContain("- pim.goals/active:");
		expect(prompt).not.toContain("test.ledger/broken");
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

		// A chat whose agent doesn't use the ledger can't show its widget: nothing is sent, and the model is told what it can show.
		const plain = (await post("/sessions", {})).body.id;
		let refused = "";
		let offered = "";
		faux.setResponses([
			(context) => {
				offered = systemPrompt(context.messages);
				return toolUse("send_to_user", { message: "Bills:", widgets: ["test.ledger/bills"] });
			},
			(context) => {
				refused = JSON.stringify(context.messages.findLast((message) => message.role === "toolResult"));
				return toolUse("send_to_user", { message: "No ledger here.", widgets: ["pim.schedule/upcoming"] });
			},
		]);
		const retried = await ask("Show my bills.", plain);
		expect(offered).not.toContain("test.ledger/bills");
		expect(refused).toContain("Not sent: test.ledger/bills isn't a widget you can show. The widgets you can show here: pim.goals/active");
		expect(refused).toContain('"isError":true');
		expect(retried.replies).toHaveLength(1);
		expect(retried.replies[0]).toMatch(/^No ledger here\.\n\n\*\*Coming up\*\*/);
	});

	it("emails widgets as text", async () => {
		await api("/email", { method: "PUT", body: JSON.stringify({ address: "ada@example.com" }) });
		const code = outbox.splice(0)[0]!.subject.slice(0, 6);
		await post("/email/confirm", { code });
		faux.setResponses([
			toolUse("create_goal", { title: "Save for a bike", steps: ["Open an account", "Save monthly"] }),
			toolUse("send_to_user", { message: "Your goals, for your records.", channel: "email", widgets: ["pim.goals/active"] }),
		]);
		await say("Email me my goals.", (await post("/sessions", {})).body.id);
		const [mail] = outbox.splice(0);
		expect(mail!.text).toContain("Your goals, for your records.\n\n**Goals**\n- Save for a bike (0/2) · Open an account");
	});

	it("serves the deployment's color themes before anyone signs in", async () => {
		const list = await exports.default.fetch(apiUrl("/themes"));
		expect(list.status).toBe(200);
		const { default: fallback, themes } = (await list.json()) as ThemeList;
		expect(fallback).toBe("tokyo-night");
		expect(themes.map((theme) => theme.id)).toEqual(ownThemes.themes!.map((theme) => theme.id));
		expect(themes.every((theme) => theme.extension === "pim.themes")).toBe(true);
		expect(themes.find((theme) => theme.id === "pixel")).toMatchObject({ fonts: { ui: "pixel", code: "pixel" }, icons: "pixel" });

		const sheet = await exports.default.fetch(apiUrl("/themes.css"));
		expect(sheet.headers.get("Content-Type")).toContain("text/css");
		const css = await sheet.text();
		// The default comes first, on the page itself, so later themes win over it.
		expect(css.startsWith(':root,\n[data-theme="tokyo-night"] {\n  --background: #e6e7ed;')).toBe(true);
		expect(css).toContain('.dark,\n[data-theme="tokyo-night"].dark {\n  --background: #1a1b26;');
		expect(css).toContain('[data-theme="nord"].dark {\n  --background: #2e3440;');
		expect(css).toContain('[data-theme="nord"].dark .shiki-token {\n  color: var(--shiki-nord-dark);');
	});

	it("lets themes select bundled fonts and icons independently, with system defaults for older themes", () => {
		const pixel: Theme = { ...nord, id: "test-pixel", fonts: { ui: "pixel" }, icons: "pixel" };
		const codeOnly: Theme = { ...nord, id: "test-code", fonts: { code: "pixel" } };
		const themes = new PimThemes([{ id: "test.styles", themes: [pixel, nord, codeOnly] }], pixel.id);
		const css = themes.stylesheet();
		const style = (id: string) => [...css.matchAll(new RegExp(`\\[data-theme="${id}"\\] \\{([^}]+)\\}`, "g"))].map((match) => match[1]).join("");
		expect(style(pixel.id)).toContain('--theme-font-ui: "Pixeloid Sans"');
		expect(style(pixel.id)).toContain("--theme-font-code: ui-monospace");
		expect(style(pixel.id)).toContain("--theme-icon-lucide: none;");
		expect(style(pixel.id)).toContain("--theme-icon-pixel: inline;");
		// Every theme declares its defaults, so a nested preview cannot inherit the pixel look.
		expect(style(nord.id)).toContain("--theme-font-ui: ui-sans-serif");
		expect(style(nord.id)).toContain("--theme-font-code: ui-monospace");
		expect(style(nord.id)).toContain("--theme-icon-lucide: inline;");
		expect(style(nord.id)).toContain("--theme-icon-pixel: none;");
		expect(style(codeOnly.id)).toContain('--theme-font-code: "Pixeloid Mono"');
		expect(style(codeOnly.id)).toContain("--theme-font-ui: ui-sans-serif");
		for (const invalid of [{ fonts: { ui: "remote" } }, { fonts: { code: "remote" } }, { icons: "remote" }]) {
			expect(() => new PimThemes([{ id: "test.styles", themes: [{ ...nord, ...invalid } as Theme] }], nord.id)).toThrow("isn't bundled");
		}
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
