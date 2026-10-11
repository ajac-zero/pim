import type { Message } from "@earendil-works/pi-ai";
import { fauxAssistantMessage } from "@earendil-works/pi-ai/providers/faux";
import { describe, expect, it } from "vitest";
import { api, post, say } from "./helpers";
import { faux } from "./worker";

/** The prompt sections sent last: pi sends the whole prompt once, then only what changed. */
const system = (messages: readonly Message[]) => JSON.stringify(messages.filter((message) => message.role === "system").at(-1));

describe("the owner's Pims", () => {
	it("gives a chat started with one its instructions, as they are at each request, and nothing to other chats", async () => {
		expect((await post("/personas", { name: "", instructions: "x" })).status).toBe(400);
		expect((await post("/personas", { name: "Coach", instructions: "x", apps: [{ name: "Cal", url: "http://plain.test" }] })).status).toBe(400);
		const coach = (
			await post("/personas", {
				name: "Marathon coach",
				description: "Plans my training.",
				instructions: "Answer every question with a training tip.",
				apps: [{ name: "Strava", url: "https://mcp.strava.example/mcp" }],
			})
		).body;
		expect(coach).toMatchObject({ id: expect.stringMatching(/^p_/), source: null, published: null });
		expect((await post("/sessions", { persona: "p_nope" })).status).toBe(404);
		const session = (await post("/sessions", { persona: coach.id })).body;
		expect(session.persona).toEqual({ id: coach.id, name: "Marathon coach" });

		const prompts: string[] = [];
		const record = (context: { messages: Message[] }) => {
			prompts.push(system(context.messages));
			return fauxAssistantMessage("ok");
		};
		faux.setResponses([record, record]);
		await say("How far today?", session.id);
		await say("Hello", "1");
		expect(prompts[0]).toContain('In this conversation you are \\"Marathon coach\\"');
		expect(prompts[0]).toContain("Answer every question with a training tip.");
		expect(prompts[1]).not.toContain("Marathon coach");

		// Edited, its chats follow from their next request.
		await api(`/personas/${coach.id}`, { method: "PUT", body: JSON.stringify({ instructions: "Speak only in haiku." }) });
		faux.setResponses([record]);
		await say("And tomorrow?", session.id);
		expect(prompts[2]).toContain("Speak only in haiku.");
		expect((await api("/sessions")).body.sessions.find((info: { id: string }) => info.id === session.id).persona).toEqual({
			id: coach.id,
			name: "Marathon coach",
		});

		// Deleted, its chats stay, as plain chats.
		expect((await api(`/personas/${coach.id}`, { method: "DELETE" })).body).toEqual({ deleted: true });
		faux.setResponses([record]);
		await say("Still there?", session.id);
		expect(JSON.parse(prompts[3]!).sections).toEqual({ instructions: null });
		expect((await api("/personas")).body.personas).toEqual([]);
	});
});
