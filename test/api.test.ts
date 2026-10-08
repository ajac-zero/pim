import { fauxAssistantMessage } from "@earendil-works/pi-ai/providers/faux";
import { env, runInDurableObject } from "cloudflare:test";
import { exports } from "cloudflare:workers";
import { describe, expect, it, vi } from "vitest";
import type { TranscriptMessage } from "../src/transcript";
import { api, connect, post, say, TOKEN, textOf, url } from "./helpers";
import { AGENT_NAME } from "../src/agent";
import { faux, type Pim } from "./worker";

describe("auth", () => {
	it("rejects requests without the API token", async () => {
		expect((await exports.default.fetch(url("/"))).status).toBe(401);
		const wrong = await exports.default.fetch(url("/"), { headers: { Authorization: "Bearer nope" } });
		expect(wrong.status).toBe(401);
		// A token that only shares a prefix with the real one is still wrong.
		const prefix = await exports.default.fetch(url("/"), { headers: { Authorization: "Bearer test" } });
		expect(prefix.status).toBe(401);
		const socket = await exports.default.fetch(url("/ws"), { headers: { Upgrade: "websocket" } });
		expect(socket.status).toBe(401);
	});

	it("accepts the token as a bearer header or a query parameter", async () => {
		expect((await api("/")).status).toBe(200);
		expect((await exports.default.fetch(url(`/?token=${TOKEN}`))).status).toBe(200);
	});

	it("serves health without a token", async () => {
		const response = await exports.default.fetch(url("/health"));
		expect(await response.json()).toEqual({ name: "pim", ok: true });
	});

	it("answers CORS preflights without a token, allowing every method the API uses", async () => {
		const response = await exports.default.fetch(url("/memory/log/1"), {
			method: "OPTIONS",
			headers: { Origin: "https://ui.example", "Access-Control-Request-Method": "DELETE" },
		});
		expect(response.status).toBeLessThan(300);
		expect(response.headers.get("Access-Control-Allow-Methods")).toContain("DELETE");
		expect(response.headers.get("Access-Control-Allow-Headers")).toContain("Authorization");
		// Actual responses carry CORS headers too, including errors.
		const denied = await exports.default.fetch(url("/"));
		expect(denied.headers.get("Access-Control-Allow-Origin")).toBe("*");
	});

	it("takes WebSockets only at /ws", async () => {
		const elsewhere = await exports.default.fetch(url(`/sessions?token=${TOKEN}`), { headers: { Upgrade: "websocket" } });
		expect(elsewhere.status).toBe(404);
		expect((await api("/ws")).status).toBe(426);
	});
});

describe("agent", () => {
	it("describes itself and marks the tools that need approval", async () => {
		const { body } = await api("/");
		expect(body).toMatchObject({ model: "faux-model", timeZone: "America/New_York", rootSession: "1" });
		const tools = new Map((body.tools as { name: string; requiresApproval: boolean }[]).map((tool) => [tool.name, tool]));
		expect(tools.get("http_request")?.requiresApproval).toBe(true);
		expect(tools.get("note")?.requiresApproval).toBe(false);
		// web_search costs money and is off unless configured.
		expect(tools.has("web_search")).toBe(false);
		expect(tools.has("fetch_url")).toBe(true);
	});

	it("accepts POSTs without a body where every field is optional, and rejects bodies that are not objects", async () => {
		const { id } = (await post("/sessions")).body;
		// What `curl -X POST` sends: an empty body, not a missing one.
		const empty = await exports.default.fetch(url(`/sessions/${id}/reset`), {
			method: "POST",
			headers: { Authorization: `Bearer ${TOKEN}` },
			body: "",
		});
		expect(empty.status).toBe(200);
		expect(await empty.json()).toEqual({ reset: true });
		const array = await api(`/sessions/${id}/reset`, { method: "POST", body: "[1]" });
		expect(array.status).toBe(400);
	});

	it("answers 404 for unknown paths and 405 for wrong methods", async () => {
		expect((await api("/nope")).status).toBe(404);
		expect((await api("/memory/log", { method: "PUT" })).status).toBe(405);
	});
});

describe("conversation", () => {
	it("answers a message and keeps the transcript", async () => {
		faux.setResponses([fauxAssistantMessage("Paris.")]);
		const answer = await say("What is the capital of France?");
		expect(answer).toMatchObject({ status: "done", text: "Paris." });

		const { body } = await api("/sessions/1/messages");
		const messages = body.messages as TranscriptMessage[];
		expect(messages.map((message) => [message.role, textOf(message)])).toEqual([
			["user", "What is the capital of France?"],
			["assistant", "Paris."],
		]);
		expect(body.busy).toBe(false);
	});

	it("keeps sessions separate", async () => {
		const { body: created } = await post("/sessions");
		faux.setResponses([fauxAssistantMessage("In the new session.")]);
		expect((await say("hi", created.id)).text).toBe("In the new session.");
		const { body } = await api(`/sessions/${created.id}/messages`);
		expect(body.messages.map(textOf)).toEqual(["hi", "In the new session."]);
		expect((await api("/sessions/999/messages")).status).toBe(404);
	});

	it("names sessions by the user's first message and lists the most recently active first", async () => {
		const first = (await post("/sessions")).body.id;
		const second = (await post("/sessions", { title: "  Groceries  " })).body.id;
		const third = (await post("/sessions")).body.id;
		const titles = async () =>
			Object.fromEntries(
				((await api("/sessions")).body.sessions as { id: string; title: string | null }[]).map((s) => [s.id, s.title]),
			);
		const order = async () => ((await api("/sessions")).body.sessions as { id: string }[]).map((s) => s.id);

		faux.setResponses([fauxAssistantMessage("Sure.")]);
		await say("Plan my trip to Lisbon\nwith lots of detail", first);
		faux.setResponses([fauxAssistantMessage("Ok.")]);
		await say("Milk and eggs", second);
		// A message Pim sends itself (a scheduled task, an event) does not name a session.
		await runInDurableObject(env.Pim.getByName(AGENT_NAME), async (instance: Pim) => {
			faux.setResponses([fauxAssistantMessage("Reminder sent.")]);
			const receipt = await instance.submitTo(third, "[Scheduled task] remind", {}, "pim");
			await instance.harness.wait(receipt.operationId, { session: third });
		});
		expect(await titles()).toMatchObject({ [first]: "Plan my trip to Lisbon", [second]: "Groceries", [third]: null });
		expect((await order()).slice(0, 3)).toEqual([third, second, first]);

		// Activity moves a session up; later messages do not rename it.
		faux.setResponses([fauxAssistantMessage("Booked.")]);
		await say("Book the flights", first);
		expect((await order())[0]).toBe(first);
		expect((await titles())[first]).toBe("Plan my trip to Lisbon");

		const renamed = await api(`/sessions/${first}`, { method: "PUT", body: JSON.stringify({ title: "Lisbon" }) });
		expect(renamed.body).toMatchObject({ id: first, title: "Lisbon", createdAt: expect.any(Number), updatedAt: expect.any(Number) });
		expect((await api(`/sessions/${first}`, { method: "PUT", body: JSON.stringify({ title: " " }) })).status).toBe(400);
		expect((await api("/sessions/999", { method: "PUT", body: JSON.stringify({ title: "x" }) })).status).toBe(404);
	});

	it("returns a receipt without waiting, and the operation settles later", async () => {
		const { body: created } = await post("/sessions");
		faux.setResponses([fauxAssistantMessage("Later.")]);
		const path = `/sessions/${created.id}/messages`;
		const { status, body: receipt } = await post(path, { content: "hi", operationId: "op-1" });
		expect(status).toBe(202);
		expect(receipt).toMatchObject({ operationId: "op-1", accepted: true });
		// The same operation id again is the same submission, not a second run.
		expect((await post(path, { content: "hi", operationId: "op-1" })).body.accepted).toBe(false);
		const { body } = await api(`/sessions/${created.id}/operations/op-1`);
		expect(body).toMatchObject({ status: "done", text: "Later." });
	});

	it("runs a turn submitted over the socket and streams its events", async () => {
		const { body: created } = await post("/sessions");
		const { socket, received } = await connect(created.id);
		await vi.waitFor(() => expect(received.some((message) => message.type === "events")).toBe(true));
		expect(received[0]).toMatchObject({ type: "hello", session: created.id });
		expect(received[1].events[0].type).toBe("snapshot");

		faux.setResponses([fauxAssistantMessage("Hello over the socket.")]);
		socket.send(JSON.stringify({ type: "submit", id: "c1", content: "hi" }));

		const events = () => received.filter((message) => message.type === "events").flatMap((message) => message.events);
		await vi.waitFor(() => expect(events().some((event) => event.type === "run_end")).toBe(true));
		expect(received.find((message) => message.type === "result")).toMatchObject({ id: "c1", result: { accepted: true } });
		const roles = events()
			.filter((event) => event.type === "message_end")
			.map((event) => event.entry.model[0].role)
			.filter((role) => role !== "system");
		expect(roles).toEqual(["user", "assistant"]);
		socket.close();
	});

	it("refuses a socket for a session that does not exist", async () => {
		const { received } = await connect("999");
		await vi.waitFor(() => expect(received).toEqual([{ type: "error", message: "No session 999" }]));
	});
});

