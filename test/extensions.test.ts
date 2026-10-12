import type { Message } from "@earendil-works/pi-ai";
import { fauxAssistantMessage } from "@earendil-works/pi-ai/providers/faux";
import { describe, expect, it } from "vitest";
import { PimExtensions } from "../src/extensions/define";
import { api, post, say, systemPrompt, toolUse } from "./helpers";
import { faux, ledger } from "./worker";

type Persona = { id: string; name: string; base: string | null; default: boolean };

const dashboard = async (pim: Persona, locale = "en") => (await api(`/personas/${pim.id}/dashboard?locale=${locale}`)).body;
const widget = (board: { widgets: { id: string }[] }, id: string) => board.widgets.find((candidate) => candidate.id === id) as any;
const personaOf = async (session: string) =>
	(await api("/sessions")).body.sessions.find((candidate: { id: string }) => candidate.id === session).persona;

describe("extensions", () => {
	it("checks a deployment's extensions before anything uses them", () => {
		expect(() => new PimExtensions([ledger, ledger], null)).toThrow("Two extensions are called test.ledger");
		// A dashboard naming a widget nobody brings would draw nothing: refused.
		const typo = { ...ledger, pims: [{ ...ledger.pims![0]!, dashboard: ["test.ledger/bils"] }] };
		expect(() => new PimExtensions([typo], null)).toThrow("test.ledger/budget's dashboard shows test.ledger/bils");
		expect(() => new PimExtensions([{ ...ledger, pims: [] }], "test.ledger/budget")).toThrow("The default Pim test.ledger/budget");
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
			{
				id: "test.ledger/bills",
				title: "Próximas facturas",
				empty: "No bills.",
				kind: "list",
				items: [{ title: "Rent for Household", time: "2026-11-01T09:00:00.000Z" }],
			},
			{ id: "test.ledger/broken", title: "Bank balance", empty: "", failed: true },
			{ id: "pim.goals/active", title: "Metas", empty: expect.any(String), kind: "progress", items: [] },
		]);
		const bare = (await post("/personas", { name: "Blank", base: null })).body as Persona;
		expect(await dashboard(bare)).toMatchObject({ starters: [], widgets: [] });
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
});
