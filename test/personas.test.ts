import type { Message } from "@earendil-works/pi-ai";
import { fauxAssistantMessage } from "@earendil-works/pi-ai/providers/faux";
import { describe, expect, it } from "vitest";
import { exports } from "cloudflare:workers";
import { api, apiUrl, post, say, TOKEN } from "./helpers";
import { faux } from "./worker";

/** The prompt sections sent last: pi sends the whole prompt once, then only what changed. */
const system = (messages: readonly Message[]) => JSON.stringify(messages.filter((message) => message.role === "system").at(-1));

describe("the owner's Pims", () => {
	it("talks in every chat as the chat's Pim, or the default one, as each is at each request", async () => {
		// Every account has its Pim: plain until changed, and there to stay.
		const [mine] = (await api("/personas")).body.personas;
		expect(mine).toMatchObject({ name: "Pim", instructions: "", default: true, source: null });
		expect((await api(`/personas/${mine.id}`, { method: "DELETE" })).status).toBe(400);

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
		expect(coach).toMatchObject({ id: expect.stringMatching(/^p_/), source: null, published: null, default: false });
		expect((await api("/personas")).body.personas.map((pim: { name: string }) => pim.name)).toEqual(["Pim", "Marathon coach"]);
		expect((await post("/sessions", { persona: "p_nope" })).status).toBe(404);
		const session = (await post("/sessions", { persona: coach.id })).body;
		expect(session.persona).toEqual({ id: coach.id, name: "Marathon coach" });
		expect((await post("/sessions", {})).body.persona).toEqual({ id: mine.id, name: "Pim" });

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
		expect(prompts[1]).toContain('In this conversation you are \\"Pim\\".');
		expect(prompts[1]).not.toContain("Marathon coach");

		// Edited, a Pim's chats follow from their next request: the default one's are every chat not started with another.
		await api(`/personas/${coach.id}`, { method: "PUT", body: JSON.stringify({ instructions: "Speak only in haiku." }) });
		await api(`/personas/${mine.id}`, { method: "PUT", body: JSON.stringify({ name: "Sam", instructions: "Sign off with -S." }) });
		faux.setResponses([record, record]);
		await say("And tomorrow?", session.id);
		await say("Hi again", "1");
		expect(prompts[2]).toContain("Speak only in haiku.");
		expect(prompts[3]).toContain('you are \\"Sam\\"');
		expect(prompts[3]).toContain("Sign off with -S.");
		expect((await api("/sessions")).body.sessions.find((info: { id: string }) => info.id === session.id).persona).toEqual({
			id: coach.id,
			name: "Marathon coach",
		});

		// Deleted, its chats stay, with the default Pim.
		expect((await api(`/personas/${coach.id}`, { method: "DELETE" })).body).toEqual({ deleted: true });
		faux.setResponses([record]);
		await say("Still there?", session.id);
		expect(prompts[4]).toContain("Sign off with -S.");
		expect(prompts[4]).not.toContain("haiku");
		expect((await api("/personas")).body.personas).toEqual([expect.objectContaining({ id: mine.id, name: "Sam", default: true })]);
	});

	it("keeps an icon for each Pim, only as a picture", async () => {
		const pim = (await post("/personas", { name: "Coach" })).body;
		expect(pim.icon).toBeNull();
		expect((await api(`/personas/${pim.id}/icon`)).status).toBe(404);
		const png = new Uint8Array([137, 80, 78, 71, 1, 2, 3]);
		const upload = (type: string, body: BodyInit) => api(`/personas/${pim.id}/icon`, { method: "PUT", headers: { "content-type": type }, body });
		expect((await upload("image/svg+xml", "<svg/>")).status).toBe(415);
		expect((await upload("image/png", new Uint8Array(256 * 1024 + 1))).status).toBe(413);
		expect((await upload("image/png", png)).body.icon).toEqual(expect.any(Number));
		const [, listed] = (await api("/personas")).body.personas;
		expect(listed.icon).toEqual(expect.any(Number));
		const served = await exports.default.fetch(apiUrl(`/personas/${pim.id}/icon`), { headers: { authorization: `Bearer ${TOKEN}` } });
		expect(served.headers.get("content-type")).toBe("image/png");
		expect(new Uint8Array(await served.arrayBuffer())).toEqual(png);
		expect((await api(`/personas/${pim.id}/icon`, { method: "DELETE" })).body.icon).toBeNull();
		expect((await api(`/personas/${pim.id}/icon`)).status).toBe(404);
	});
});
