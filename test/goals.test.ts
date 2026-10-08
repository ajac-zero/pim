import { fauxAssistantMessage } from "@earendil-works/pi-ai/providers/faux";
import { describe, expect, it } from "vitest";
import type { Goal } from "../src/store";
import type { Message } from "@earendil-works/pi-ai";
import { api, post, say, systemPrompt, toolUse } from "./helpers";
import { faux } from "./worker";

describe("goals", () => {
	it("updates only the goals section when the first goal appears, keeping the prompt cache", async () => {
		const session = (await post("/sessions")).body.id;
		const prompts: Message[][] = [];
		const record = (context: { messages: Message[] }) => {
			prompts.push(context.messages);
			return fauxAssistantMessage("ok");
		};
		faux.setResponses([record]);
		await say("hi", session);
		faux.setResponses([toolUse("create_goal", { title: "Learn Portuguese", steps: ["Find a tutor"] }), record]);
		await say("I want to learn Portuguese.", session);

		const [first, second] = prompts as [Message[], Message[]];
		const systemOf = (messages: Message[]) => messages.filter((message) => message.role === "system");
		// What was sent before is sent again unchanged, a prefix the provider has cached.
		expect(second.slice(0, first.length)).toEqual(first);
		// One new system entry, patching only the goals section: no section is removed and re-sent.
		const added = systemOf(second).slice(systemOf(first).length);
		expect(added).toHaveLength(1);
		expect(Object.keys(added[0]!.role === "system" ? (added[0]!.sections ?? {}) : {})).toEqual(["active_goals"]);
	});

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
