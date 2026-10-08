import { fauxAssistantMessage } from "@earendil-works/pi-ai/providers/faux";
import { describe, expect, it } from "vitest";
import type { Goal, Memory } from "../src/store";
import { api, post, say, systemPrompt, toolUse } from "./helpers";
import { faux } from "./worker";

describe("memory", () => {
	it("remembers a fact, carries it in the system prompt, and forgets it", async () => {
		let promptAfter = "";
		faux.setResponses([
			toolUse("remember", { content: "The user is allergic to peanuts." }),
			fauxAssistantMessage("Noted."),
			(context) => {
				promptAfter = systemPrompt(context.messages);
				return fauxAssistantMessage("No peanuts for you.");
			},
		]);
		await say("I'm allergic to peanuts.");
		const { body } = await api<{ memories: Memory[] }>("/memories");
		expect(body.memories.map((memory) => memory.content)).toEqual(["The user is allergic to peanuts."]);
		const [memory] = body.memories;

		await say("Suggest a snack.");
		expect(promptAfter).toContain(`${memory!.id}: The user is allergic to peanuts.`);

		expect((await api(`/memories/${memory!.id}`, { method: "DELETE" })).status).toBe(200);
		expect((await api("/memories")).body.memories).toEqual([]);
		expect((await api(`/memories/${memory!.id}`, { method: "DELETE" })).status).toBe(404);
	});

	it("searches memories by keyword, best match first", async () => {
		await post("/memories", { content: "Sister Ana lives in Lisbon." });
		await post("/memories", { content: "Prefers aisle seats on flights." });
		await post("/memories", { content: "Ana's birthday is May 3; she likes flights of wine." });
		const { body } = await api<{ memories: Memory[] }>("/memories?q=ana%20flights");
		expect(body.memories.map((memory) => memory.content)).toEqual([
			"Ana's birthday is May 3; she likes flights of wine.",
			// One-word matches follow; between them, the newest first.
			"Prefers aisle seats on flights.",
			"Sister Ana lives in Lisbon.",
		]);
	});
});

describe("goals", () => {
	it("creates a goal with a plan and records progress", async () => {
		faux.setResponses([
			toolUse("create_goal", { title: "Run a 10k", steps: ["Buy shoes", "Run 3x a week", "Sign up for a race"] }),
			fauxAssistantMessage("Plan made."),
		]);
		await say("I want to run a 10k.");
		const [goal] = (await api<{ goals: Goal[] }>("/goals")).body.goals;
		expect(goal).toMatchObject({ title: "Run a 10k", status: "active", session: "1" });

		let prompt = "";
		faux.setResponses([
			toolUse("update_goal", { id: goal!.id, complete_steps: [1], note: "Bought trail shoes" }),
			(context) => {
				prompt = systemPrompt(context.messages);
				return fauxAssistantMessage("Nice.");
			},
		]);
		await say("I bought shoes!");
		const updated = (await api<Goal>(`/goals/${goal!.id}`)).body;
		expect(updated.steps.map((step) => step.done)).toEqual([true, false, false]);
		expect(updated.notes.map((note) => note.text)).toEqual(["Bought trail shoes"]);
		// The active goal, with its progress, is in front of the model.
		expect(prompt).toContain("Run a 10k");
		expect(prompt).toContain("1/3 steps done");
	});
});
