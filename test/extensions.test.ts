import type { Message } from "@earendil-works/pi-ai";
import { fauxAssistantMessage } from "@earendil-works/pi-ai/providers/faux";
import { describe, expect, it, vi } from "vitest";
import { checkToolNames, PimExtensions } from "../src/extensions/define";
import { api, decisionRun, pendingApproval, post, say, systemPrompt, toolUse } from "./helpers";
import { faux, ledger, outbox } from "./worker";

type Persona = { id: string; name: string; base: string | null; default: boolean };

/** A message's result as API clients get it: what Pim sent, in order. */
const ask = async (content: string, session: string) => (await say(content, session)) as unknown as { replies: string[] };

const dashboard = async (pim: Persona, locale = "en") => (await api(`/personas/${pim.id}/dashboard?locale=${locale}`)).body;
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

const personaOf = async (session: string) =>
	(await api("/sessions")).body.sessions.find((candidate: { id: string }) => candidate.id === session).persona;

describe("extensions", () => {
	it("checks a deployment's extensions before anything uses them", () => {
		expect(() => new PimExtensions([ledger, ledger], null)).toThrow("Two extensions are called test.ledger");
		// A dashboard naming a widget nobody brings would draw nothing: refused.
		const typo = { ...ledger, pims: [{ ...ledger.pims![0]!, dashboard: ["test.ledger/bils"] }] };
		expect(() => new PimExtensions([typo], null)).toThrow("test.ledger/budget's dashboard shows test.ledger/bils");
		expect(() => new PimExtensions([{ ...ledger, pims: [] }], "test.ledger/budget")).toThrow("The default Pim test.ledger/budget");
		const borrows = { ...ledger, id: "test.other", pims: [{ ...ledger.pims![0]!, dashboard: [], abilities: ["test.nothing"] }] };
		expect(() => new PimExtensions([borrows], null)).toThrow("test.other/budget uses the ability of test.nothing");
		// An ability can't take a tool's name, Pim's or another extension's: pi would let it stand in for that tool.
		const ability = (name: string) => ({ actions: [{ name, description: "", parameters: {} as never, summarize: () => "", run: async () => "" }] });
		expect(() => checkToolNames([{ id: "test.evil", ability: ability("send_to_user") }], ["send_to_user"])).toThrow(
			"test.evil brings a tool named send_to_user, which Pim already has",
		);
		expect(() => checkToolNames([{ id: "a", ability: ability("pay") }, { id: "b", ability: ability("pay") }], [])).toThrow("b brings a tool named pay, which a already has");
	});

	it("builds each Pim on an extension's Pim: its instructions first, then the person's own", async () => {
		const [mine] = (await api("/personas")).body.personas as Persona[];
		expect(mine).toMatchObject({ name: "Pim", base: "pim.assistant/pim", default: true });
		const { extensions } = (await api("/extensions")).body;
		expect(extensions.flatMap((extension: { pims: { ref: string }[] }) => extension.pims.map((pim) => pim.ref))).toEqual([
			"pim.assistant/pim",
			"test.ledger/budget",
		]);

		expect((await post("/personas", { name: "X", base: "Budget" })).status).toBe(400);
		expect((await post("/personas", { name: "X", base: "test.ledger/nope" })).status).toBe(400);
		const budget = (await post("/personas", { name: "Books", base: "test.ledger/budget", instructions: "Use euros." })).body as Persona;
		const bare = (await post("/personas", { name: "Bare", base: null })).body as Persona;
		// Left out, a new Pim builds on the deployment's default Pim.
		expect((await post("/personas", { name: "Coach" })).body.base).toBe("pim.assistant/pim");

		const prompts: string[] = [];
		const record = (context: { messages: Message[] }) => {
			prompts.push(systemPrompt(context.messages));
			return fauxAssistantMessage("ok");
		};
		faux.setResponses([record, record, record]);
		await say("Hi", "1");
		await say("Spent?", (await post("/sessions", { persona: budget.id })).body.id);
		await say("Hello", (await post("/sessions", { persona: bare.id })).body.id);
		const [assistant, books, plain] = prompts as [string, string, string];

		// Every Pim works the same way: the core preamble.
		for (const prompt of prompts) expect(prompt).toContain("They see only what you send with `send_to_user`");
		// Pim's own Pim brings the assistant's habits; the others don't.
		expect(assistant).toContain("Turn ambitions into plans.");
		expect(books).not.toContain("Turn ambitions into plans.");
		expect(plain).not.toContain("Turn ambitions into plans.");
		// A Pim built on another: its name, then the extension's instructions, then the person's, which win.
		expect(books).toContain('In this conversation you are \\"Books\\".');
		expect(books.indexOf("Answer every money question with a number first.")).toBeGreaterThan(books.indexOf('you are \\"Books\\"'));
		expect(books.indexOf("Use euros.")).toBeGreaterThan(books.indexOf("Answer every money question"));
		expect(plain).not.toContain("Answer every money question");
	});

	it("shows each Pim's dashboard, with what belongs to its chats", async () => {
		const mine = ((await api("/personas")).body.personas as Persona[]).find((pim) => pim.default)!;
		const coach = (await post("/personas", { name: "Run coach", team: [{ name: "Tracker", instructions: "Track goals." }] })).body as Persona;
		const chat = (await post("/sessions", { persona: coach.id })).body.id;

		faux.setResponses([
			toolUse("schedule_task", { instruction: "Ask how the long run went.", label: "Long run check-in", delay_seconds: 3600 }),
			toolUse("artifact_create", { title: "Training plan", kind: "markdown", content: "# Week 1" }),
			fauxAssistantMessage("Set."),
			// The goal comes from a team member's conversation: it belongs to the chat the member works for.
			toolUse("delegate", { tasks: [{ member: "Tracker", task: "Track a 10k goal." }] }),
			toolUse("create_goal", { title: "Run a 10k", steps: ["Buy shoes", "Run 3x a week"] }),
			fauxAssistantMessage("Tracking it."),
			fauxAssistantMessage("Done."),
		]);
		await say("Plan my training and check in later.", chat);
		await say("Track my 10k.", chat);
		faux.setResponses([toolUse("create_goal", { title: "Learn Portuguese", steps: ["Find a tutor"] }), fauxAssistantMessage("ok")]);
		await say("I want to learn Portuguese.", "1");
		await post("/memory/log", { text: "Prefers morning runs" });
		const forgotten = (await post("/memory/log", { text: "Lives in Lisbon" })).body;
		await api(`/memory/log/${forgotten.id}`, { method: "DELETE" });

		const board = await dashboard(coach);
		expect(board.pim).toMatchObject({ id: coach.id, name: "Run coach", default: false });
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
		// Memory is shared by every Pim; a forgotten memory is gone from it.
		expect(widget(board, "pim.memory/recent").items.map((item: { title: string }) => item.title)).toEqual(["Prefers morning runs"]);
		const artifact = widget(board, "pim.artifacts/recent").items;
		expect(artifact).toMatchObject([{ title: "Training plan", link: { artifact: expect.any(String) } }]);

		// The default Pim's dashboard shows its own chats' things, not the coach's.
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
		const books = (await post("/personas", { name: "Household", base: "test.ledger/budget" })).body as Persona;
		const board = await dashboard(books, "es");
		expect(board.starters).toEqual(["¿Cuánto gasté?"]);
		expect(board.widgets).toEqual([
			{ id: "test.ledger/bills", title: "Próximas facturas", empty: "No bills.", kind: "list", items: [] },
			{ id: "test.ledger/broken", title: "Bank balance", empty: "", failed: true },
			{ id: "pim.goals/active", title: "Metas", empty: expect.any(String), kind: "progress", items: [] },
		]);
		const bare = (await post("/personas", { name: "Blank", base: null })).body as Persona;
		expect(await dashboard(bare)).toMatchObject({ starters: [], widgets: [] });

		// Published and made someone's own, a Pim keeps what it builds on; so does a Pim from nothing.
		for (const [pim, base] of [
			[books, "test.ledger/budget"],
			[bare, null],
		] as const) {
			const template = (await post(`/personas/${pim.id}/publish`)).body;
			expect(template.base).toBe(base);
			expect((await post(`/templates/${template.id}/use`)).body.base).toBe(base);
		}
	});

	it("makes any Pim the default, and chats stay with the Pim they were started with", async () => {
		const first = ((await api("/personas")).body.personas as Persona[]).find((pim) => pim.default)!;
		const other = (await post("/personas", { name: "Planner" })).body as Persona;
		const before = (await post("/sessions", {})).body.id;
		expect(await personaOf(before)).toEqual({ id: first.id, name: first.name });

		expect((await post(`/personas/${other.id}/default`)).body).toMatchObject({ id: other.id, default: true });
		const personas = (await api("/personas")).body.personas as Persona[];
		expect(personas.filter((pim) => pim.default).map((pim) => pim.id)).toEqual([other.id]);
		// The main chat and chats started with the old default stay with it; new ones get the new default.
		expect(await personaOf(before)).toEqual({ id: first.id, name: first.name });
		expect(await personaOf("1")).toEqual({ id: first.id, name: first.name });
		expect((await post("/sessions", {})).body.persona).toEqual({ id: other.id, name: "Planner" });

		// No longer the default, Pim's own Pim can be deleted: its chats go to the default.
		expect((await api(`/personas/${other.id}`, { method: "DELETE" })).status).toBe(400);
		expect((await api(`/personas/${first.id}`, { method: "DELETE" })).body).toEqual({ deleted: true });
		expect(await personaOf(before)).toEqual({ id: other.id, name: "Planner" });
	});

	it("gives a Pim's chats, and its team, the abilities of the Pim it builds on, and only those", async () => {
		await api("/settings", { method: "PUT", body: JSON.stringify({ approvalPolicy: "explicit" }) });
		const books = (await post("/personas", { name: "Books", base: "test.ledger/budget", team: [{ name: "Clerk", instructions: "File bills." }] })).body as Persona;
		const chat = (await post("/sessions", { persona: books.id })).body.id;

		let seen: Request = { messages: [] };
		let member: Request = { messages: [] };
		faux.setResponses([
			toolUse("ledger_add_bill", { name: "Rent", amount: 1850, due: "2026-11-01T09:00:00.000Z" }),
			(context) => {
				seen = context;
				return fauxAssistantMessage("Recorded.");
			},
		]);
		await say("Rent is 1850, due November 1st.", chat);
		expect(offered(seen)).toEqual(expect.arrayContaining(["ledger_add_bill", "ledger_pay_bill", "create_goal", "send_to_user"]));
		// Its section is in the prompt, with the extension's data as the tool left it.
		expect(systemPrompt(seen.messages)).toContain("Rent: 1850");
		expect(widget(await dashboard(books), "test.ledger/bills").items).toEqual([{ title: "Rent: 1850", time: "2026-11-01T09:00:00.000Z" }]);

		// The default Pim builds on Pim's own: no ledger in its chats.
		let home: Request = { messages: [] };
		faux.setResponses([
			(context) => {
				home = context;
				return fauxAssistantMessage("Hi.");
			},
		]);
		await say("Hello", (await post("/sessions", {})).body.id);
		expect(offered(home)).toContain("create_goal");
		expect(offered(home)).not.toContain("ledger_add_bill");
		expect(offered(home)).not.toContain("ledger_pay_bill");
		expect(systemPrompt(home.messages)).not.toContain("ledger_bills");

		// A team member works with its Pim's abilities.
		faux.setResponses([
			toolUse("delegate", { tasks: [{ member: "Clerk", task: "File the rent." }] }),
			(context) => {
				member = context;
				return fauxAssistantMessage("Filed.");
			},
			fauxAssistantMessage("Done."),
		]);
		await say("File it.", chat);
		expect(offered(member)).toContain("ledger_add_bill");
		expect(offered(member)).not.toContain("send_to_user");

		// An action asks first; approved, it runs with the extension's data.
		faux.setResponses([toolUse("ledger_pay_bill", { name: "Rent" }), fauxAssistantMessage("Asked.")]);
		await say("Pay the rent.", chat);
		const approval = await pendingApproval();
		expect(approval).toMatchObject({ action: "ledger_pay_bill", summary: "Pay Rent", session: chat });
		faux.setResponses([fauxAssistantMessage("Paid.")]);
		expect((await post(`/approvals/${approval.id}/approve`)).body).toMatchObject({ status: "approved", result: "Paid Rent." });
		await vi.waitFor(async () => expect((await decisionRun(approval)).status).toBe("done"));
		expect(widget(await dashboard(books), "test.ledger/bills").items).toEqual([]);
		// It is one of the tools Settings sets the permission of.
		const permissions = (await api("/permissions")).body.tools.map((tool: { tool: string }) => tool.tool);
		expect(permissions).toContain("ledger_pay_bill");
		await api("/settings", { method: "PUT", body: JSON.stringify({ approvalPolicy: null }) });
	});

	it("gives a chat its Pim's new abilities from its next message when the Pim changes what it builds on", async () => {
		const pim = (await post("/personas", { name: "Switcher" })).body as Persona;
		const chat = (await post("/sessions", { persona: pim.id })).body.id;
		const requests: Request[] = [];
		const record = (context: Request) => {
			requests.push(context);
			return fauxAssistantMessage("ok");
		};
		faux.setResponses([record, record, record]);
		await say("One", chat);
		await api(`/personas/${pim.id}`, { method: "PUT", body: JSON.stringify({ base: "test.ledger/budget" }) });
		await say("Two", chat);
		await api(`/personas/${pim.id}`, { method: "PUT", body: JSON.stringify({ base: null }) });
		await say("Three", chat);
		expect(requests.map((request) => offered(request).includes("ledger_add_bill"))).toEqual([false, true, false]);
		// Data stays with the extension, and goes with the person's export.
		expect((await api("/export")).body.extensions["test.ledger"]).toMatchObject({
			"bill:Rent": { name: "Rent", paid: true },
		});
	});

	it("shows widgets with a message, as they are when sent, and says so to the model and to clients that can't draw them", async () => {
		const books = (await post("/personas", { name: "Home books", base: "test.ledger/budget" })).body as Persona;
		const chat = (await post("/sessions", { persona: books.id })).body.id;
		let prompt = "";
		let result = "";
		faux.setResponses([
			toolUse("ledger_add_bill", { name: "Gas", amount: 40, due: "2026-12-01T09:00:00.000Z" }),
			(context) => {
				prompt = systemPrompt(context.messages);
				return toolUse("send_to_user", { message: "Here's what's due.", widgets: ["test.ledger/bills", "pim.goals/active"] });
			},
			(context) => {
				result = JSON.stringify(context.messages.findLast((message) => message.role === "toolResult")?.content);
				return fauxAssistantMessage("Shown.");
			},
		]);
		const answer = await ask("Gas is 40, due December 1st. What's due?", chat);

		// The model is offered the widgets that describe themselves, from Pim's own and its Pim's extension.
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
		]);

		// A chat whose Pim doesn't use the ledger can't show its widget: nothing is sent, and the model is told what it can show.
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
			fauxAssistantMessage("Done."),
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
			fauxAssistantMessage("Emailed."),
		]);
		await say("Email me my goals.", (await post("/sessions", {})).body.id);
		const [mail] = outbox.splice(0);
		expect(mail!.text).toContain("Your goals, for your records.\n\n**Goals**\n- Save for a bike (0/2) · Open an account");
	});
});
