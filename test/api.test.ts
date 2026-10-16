import { createAssistantMessageEventStream } from "@earendil-works/pi-ai";
import { fauxAssistantMessage, type FauxResponseFactory, fauxText, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import { env, runInDurableObject } from "cloudflare:test";
import { exports } from "cloudflare:workers";
import { describe, expect, it, vi } from "vitest";
import type { StoredImage } from "../src/images";
import type { TranscriptMessage } from "../src/transcript";
import { api, apiUrl, connect, OWNER, post, say, textOf, TOKEN, toolUse, url } from "./helpers";
import { faux, type Pim, utility } from "./worker";

describe("auth", () => {
	it("rejects requests without the API token", async () => {
		expect((await exports.default.fetch(apiUrl("/"))).status).toBe(401);
		const wrong = await exports.default.fetch(apiUrl("/"), { headers: { Authorization: "Bearer nope" } });
		expect(wrong.status).toBe(401);
		// A token that only shares a prefix with the real one is still wrong.
		const prefix = await exports.default.fetch(apiUrl("/"), { headers: { Authorization: "Bearer test" } });
		expect(prefix.status).toBe(401);
		const socket = await exports.default.fetch(apiUrl("/ws"), { headers: { Upgrade: "websocket" } });
		expect(socket.status).toBe(401);
	});

	it("accepts the token as a bearer header or a query parameter", async () => {
		expect((await api("/")).status).toBe(200);
		expect((await exports.default.fetch(apiUrl(`/?token=${TOKEN}`))).status).toBe(200);
	});

	it("serves health without a token", async () => {
		const response = await exports.default.fetch(url("/health"));
		expect(await response.json()).toEqual({ name: "pim", ok: true });
	});

	it("answers CORS preflights without a token, allowing every method the API uses", async () => {
		const response = await exports.default.fetch(apiUrl("/memory/log/1"), {
			method: "OPTIONS",
			headers: { Origin: "https://ui.example", "Access-Control-Request-Method": "DELETE" },
		});
		expect(response.status).toBeLessThan(300);
		expect(response.headers.get("Access-Control-Allow-Methods")).toContain("DELETE");
		expect(response.headers.get("Access-Control-Allow-Headers")).toContain("Authorization");
		// Actual responses carry CORS headers too, including errors.
		const denied = await exports.default.fetch(apiUrl("/"));
		expect(denied.headers.get("Access-Control-Allow-Origin")).toBe("*");
	});

	it("takes WebSockets only at /ws", async () => {
		const elsewhere = await exports.default.fetch(apiUrl(`/sessions?token=${TOKEN}`), { headers: { Upgrade: "websocket" } });
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
		const empty = await exports.default.fetch(apiUrl(`/sessions/${id}/reset`), {
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
		faux.setResponses([toolUse("send_to_user", { message: "Paris." })]);
		const answer = await say("What is the capital of France?");
		expect(answer).toMatchObject({ status: "done", text: "Paris." });

		const { body } = await api("/sessions/1/messages");
		const messages = body.messages as TranscriptMessage[];
		expect(messages.map((message) => [message.role, textOf(message)])).toEqual([
			["user", "What is the capital of France?"],
			["assistant", ""],
			["tool", ""],
		]);
		expect(messages[1]!.parts).toMatchObject([{ type: "tool-call", name: "send_to_user", arguments: { message: "Paris." } }]);
		expect(body.busy).toBe(false);
	});

	it("keeps sessions separate", async () => {
		const { body: created } = await post("/sessions");
		faux.setResponses([toolUse("send_to_user", { message: "In the new session." })]);
		expect((await say("hi", created.id)).text).toBe("In the new session.");
		const { body } = await api(`/sessions/${created.id}/messages`);
		expect(body.messages.map(textOf)).toEqual(["hi", "", ""]);
		expect(body.messages[1].parts[0].arguments.message).toBe("In the new session.");
		expect((await api("/sessions/999/messages")).status).toBe(404);
	});

	it("names sessions from the user's first message with the utility model and lists the most recently active first", async () => {
		const first = (await post("/sessions")).body.id;
		const second = (await post("/sessions", { title: "  Groceries  " })).body.id;
		const third = (await post("/sessions")).body.id;
		const titles = async () =>
			Object.fromEntries(
				((await api("/sessions")).body.sessions as { id: string; title: string | null }[]).map((s) => [s.id, s.title]),
			);
		const order = async () => ((await api("/sessions")).body.sessions as { id: string }[]).map((s) => s.id);

		// The utility model's quotes and full stop are dropped.
		utility.setResponses([fauxAssistantMessage('"Lisbon Trip Planning."')]);
		faux.setResponses([toolUse("send_to_user", { message: "Sure." })]);
		await say("Can you help me plan my trip to Lisbon in May?\nWe want lots of detail", first);
		await vi.waitFor(async () => expect((await titles())[first]).toBe("Lisbon Trip Planning"));
		// A session with a title is not named again.
		faux.setResponses([toolUse("send_to_user", { message: "Ok." })]);
		await say("Milk and eggs", second);
		// A message Pim sends itself (a scheduled task, an event) does not name a session.
		await runInDurableObject(env.Pim.getByName(OWNER), async (instance: Pim) => {
			faux.setResponses([fauxAssistantMessage("Reminder sent.")]);
			const receipt = await instance.submitTo(third, "[Scheduled task] remind", {}, "pim");
			await instance.harness.wait(receipt.operationId, { session: third });
		});
		expect(await titles()).toMatchObject({ [first]: "Lisbon Trip Planning", [second]: "Groceries", [third]: null });
		expect((await order()).slice(0, 3)).toEqual([third, second, first]);
		expect(utility.getPendingResponseCount()).toBe(0);

		// Activity moves a session up; later messages do not rename it.
		faux.setResponses([toolUse("send_to_user", { message: "Booked." })]);
		await say("Book the flights", first);
		expect((await order())[0]).toBe(first);
		expect((await titles())[first]).toBe("Lisbon Trip Planning");

		// When the utility model fails, the session keeps the first line of its first message.
		const fourth = (await post("/sessions")).body.id;
		faux.setResponses([toolUse("send_to_user", { message: "Will do." })]);
		await say("Call mom on Sunday\nabout the party", fourth);
		expect((await titles())[fourth]).toBe("Call mom on Sunday");

		const renamed = await api(`/sessions/${first}`, { method: "PUT", body: JSON.stringify({ title: "Lisbon" }) });
		expect(renamed.body).toMatchObject({ id: first, title: "Lisbon", createdAt: expect.any(Number), updatedAt: expect.any(Number) });
		expect((await api(`/sessions/${first}`, { method: "PUT", body: JSON.stringify({ title: " " }) })).status).toBe(400);
		expect((await api("/sessions/999", { method: "PUT", body: JSON.stringify({ title: "x" }) })).status).toBe(404);
	});

	it("regenerates a title, summarizes a chat and improves a prompt with the utility model", async () => {
		const session = (await post("/sessions", { title: "Untitled" })).body.id;
		expect((await api(`/sessions/${session}/summary`)).body).toEqual({ summary: null });
		faux.setResponses([
			fauxAssistantMessage([fauxText("Private note: check flight prices first."), fauxToolCall("send_to_user", { message: "Lisbon in May is lovely." })], {
				stopReason: "toolUse",
			}),
		]);
		await say("Plan my trip to Lisbon", session);
		faux.setResponses([toolUse("send_to_user", { message: "Booked the 9:40 flight." })]);
		await say("Book the morning flight", session);

		// Each job reads the conversation: what each side said, without the agent's private notes.
		const inputs: { job: string; input: string }[] = [];
		const answer =
			(text: string): FauxResponseFactory =>
			({ messages }) => {
				const [job, input] = [messages.find((message) => message.role === "system"), messages.at(-1)];
				inputs.push({ job: JSON.stringify(job?.content), input: JSON.stringify(input?.content) });
				return fauxAssistantMessage(text);
			};
		utility.setResponses([answer("Title: Lisbon Flights."), answer("- Flight booked\n\n## Next steps\n- Find a hotel")]);
		const retitled = await post(`/sessions/${session}/title`);
		expect(retitled.body).toMatchObject({ id: session, title: "Lisbon Flights" });
		const summary = await api(`/sessions/${session}/summary`);
		expect(summary.body).toEqual({ summary: "- Flight booked\n\n## Next steps\n- Find a hotel" });
		expect(inputs[0]!.job).toContain("You name chats");
		expect(inputs[1]!.job).toContain("You summarize");
		for (const { input } of inputs) {
			expect(input).toContain("Person: Plan my trip to Lisbon");
			expect(input).toContain("Assistant: Lisbon in May is lovely.");
			expect(input).toContain("Assistant: Booked the 9:40 flight.");
			expect(input).not.toContain("Private note");
		}

		utility.setResponses([fauxAssistantMessage("  Plan a 3-day Lisbon trip in May for two, under €1,500.  ")]);
		expect((await post("/prompts/improve", { text: "lisbon trip" })).body).toEqual({ text: "Plan a 3-day Lisbon trip in May for two, under €1,500." });
		expect((await post("/prompts/improve", { text: " " })).status).toBe(400);
		// A failed job says so and changes nothing.
		const failed = await post(`/sessions/${session}/title`);
		expect(failed.status).toBe(502);
		const { sessions } = (await api("/sessions")).body as { sessions: { id: string; title: string }[] };
		expect(sessions.find((listed) => listed.id === session)?.title).toBe("Lisbon Flights");

		// The summary is kept until something more is said: asking again doesn't ask the model.
		expect((await api(`/sessions/${session}/summary`)).body).toEqual(summary.body);
		faux.setResponses([toolUse("send_to_user", { message: "Found a hotel in Alfama." })]);
		await say("Now a hotel", session);
		utility.setResponses([answer("- Flight and hotel booked\n\n## Next steps\nNone.")]);
		expect((await api(`/sessions/${session}/summary`)).body).toEqual({ summary: "- Flight and hotel booked\n\n## Next steps\nNone." });
		expect(inputs.at(-1)!.input).toContain("Assistant: Found a hotel in Alfama.");
		expect(utility.getPendingResponseCount()).toBe(0);
	});

	it("deletes a chat: it leaves the list and the API, and its scheduled tasks stop", async () => {
		const kept = (await post("/sessions")).body.id;
		const doomed = (await post("/sessions")).body.id;
		for (const [session, instruction] of [
			[doomed, "Remind me about the doomed chat."],
			[kept, "Remind me about the kept chat."],
		]) {
			faux.setResponses([toolUse("schedule_task", { instruction, delay_seconds: 3600 }), toolUse("send_to_user", { message: "Will do." })]);
			await say(instruction!, session);
		}
		const listed = async () => ((await api("/sessions")).body.sessions as { id: string }[]).map((s) => s.id);
		const scheduledFor = async () => ((await api("/schedules")).body.schedules as { session: string }[]).map((s) => s.session);
		expect(await scheduledFor()).toEqual(expect.arrayContaining([doomed, kept]));

		expect(await api(`/sessions/${doomed}`, { method: "DELETE" })).toEqual({ status: 200, body: { deleted: true } });
		expect(await listed()).not.toContain(doomed);
		expect(await listed()).toContain(kept);
		expect((await api(`/sessions/${doomed}/messages`)).status).toBe(404);
		expect((await post(`/sessions/${doomed}/messages`, { content: "still there?" })).status).toBe(404);
		expect((await api(`/sessions/${doomed}`, { method: "DELETE" })).status).toBe(404);
		expect(await scheduledFor()).not.toContain(doomed);
		expect(await scheduledFor()).toContain(kept);

		// The root is where API clients talk by default: deleting hides it until it gets a message.
		faux.setResponses([toolUse("send_to_user", { message: "Hi." })]);
		await say("hello root");
		expect((await api("/sessions/1", { method: "DELETE" })).status).toBe(200);
		expect(await listed()).not.toContain("1");
		faux.setResponses([toolUse("send_to_user", { message: "Back." })]);
		expect((await say("hello again")).text).toBe("Back.");
		expect(await listed()).toContain("1");
	});

	it("returns a receipt without waiting, and the operation settles later", async () => {
		const { body: created } = await post("/sessions");
		faux.setResponses([toolUse("send_to_user", { message: "Later." })]);
		const path = `/sessions/${created.id}/messages`;
		const { status, body: receipt } = await post(path, { content: "hi", operationId: "op-1" });
		expect(status).toBe(202);
		expect(receipt).toMatchObject({ operationId: "op-1", accepted: true });
		// The same operation id again is the same submission, not a second run.
		expect((await post(path, { content: "hi", operationId: "op-1" })).body.accepted).toBe(false);
		const { body } = await api(`/sessions/${created.id}/operations/op-1`);
		expect(body).toMatchObject({ status: "done", text: "Later." });
	});

	it("keeps a message's images in R2 by URL, and gives the model their bytes on every turn", async () => {
		const { body: created } = await post("/sessions");
		const path = `/sessions/${created.id}/messages`;
		const png = "iVBORw0KGgo=";
		const jpeg = "/9j/4AAQ";
		const seen: unknown[] = [];
		faux.setResponses([
			(context) => {
				seen.push(context.messages.find((message) => message.role === "user"));
				return toolUse("send_to_user", { message: "A cat and a dog." });
			},
			(context) => {
				seen.push(context.messages.find((message) => message.role === "user"));
				return toolUse("send_to_user", { message: "Yes, the cat." });
			},
		]);
		const content = [
			{ type: "text", text: "What are these?" },
			{ type: "image", data: png, mimeType: "image/png" },
			{ type: "image", data: jpeg, mimeType: "image/jpeg" },
		];
		expect((await post(path, { content, wait: true })).status).toBe(200);
		expect((await post(path, { content: "The first one?", wait: true })).status).toBe(200);
		// Both turns' requests carry the first message's images inline.
		expect(seen).toEqual([{ role: "user", content, timestamp: expect.any(Number) }, { role: "user", content, timestamp: expect.any(Number) }]);

		// The transcript holds their URLs, not their bytes, and the URLs serve them.
		const [user] = (await api(`/sessions/${created.id}/messages`)).body.messages as TranscriptMessage[];
		const images = user!.parts.filter((part) => part.type === "image") as StoredImage[];
		expect(images.map(({ data, mimeType }) => ({ data, mimeType }))).toEqual([
			{ data: "", mimeType: "image/png" },
			{ data: "", mimeType: "image/jpeg" },
		]);
		const served = await exports.default.fetch(url(images[0]!.url), { headers: { Authorization: `Bearer ${TOKEN}` } });
		expect(served.headers.get("content-type")).toBe("image/png");
		expect(Buffer.from(await served.arrayBuffer()).toString("base64")).toBe(png);

		// Deleting the chat deletes its images.
		await api(`/sessions/${created.id}`, { method: "DELETE" });
		const gone = await exports.default.fetch(url(images[0]!.url), { headers: { Authorization: `Bearer ${TOKEN}` } });
		expect(gone.status).toBe(404);

		const refused = async (parts: unknown) => (await post("/sessions/1/messages", { content: parts })).status;
		expect(await refused([{ type: "image", data: "A".repeat(6_666_668), mimeType: "image/png" }])).toBe(413);
		expect(await refused(Array.from({ length: 5 }, () => ({ type: "image", data: "AAAA", mimeType: "image/png" })))).toBe(400);
		expect(await refused([{ type: "image", data: "AAAA", mimeType: "image/svg+xml" }])).toBe(415);
		expect(await refused([{ type: "image", data: "not base64!", mimeType: "image/png" }])).toBe(400);
		expect(await refused([{ type: "image", url: "https://example.com/cat.png" }])).toBe(400);
		expect(await refused([{ type: "text", text: "  " }])).toBe(400);
		expect(await refused("")).toBe(400);
	});

	it("gives a model whose API fetches images a signed URL instead, which serves the image without the token", async () => {
		const png = "iVBORw0KGgo=";
		const { body: created } = await post("/sessions");
		faux.setResponses([toolUse("send_to_user", { message: "Seen." })]);
		await post(`/sessions/${created.id}/messages`, { content: [{ type: "image", data: png, mimeType: "image/png" }], wait: true });
		const [user] = (await api(`/sessions/${created.id}/messages`)).body.messages as TranscriptMessage[];
		// What Anthropic's API, through pi-ai, would be given for the chat.
		const sent = await runInDurableObject(env.Pim.getByName(OWNER), async (instance: Pim) => {
			let context: { messages: { content: unknown }[] } | undefined;
			const models = instance.images.resolving({
				stream: (_model: unknown, given: typeof context) => {
					context = given;
					const events = createAssistantMessageEventStream();
					events.end(fauxAssistantMessage("Seen."));
					return events;
				},
			} as never);
			const model = { api: "anthropic-messages", provider: "test", id: "claude", input: ["text", "image"] };
			await models.stream(model as never, { messages: [{ role: "user", content: user!.parts, timestamp: 0 }] } as never).result();
			return context!.messages[0]!.content as { type: string; data: string; url: string }[];
		});
		expect(sent).toEqual([{ type: "image", data: "", mimeType: "image/png", url: expect.stringMatching(/^https:\/\/pim\.test\/images\//) }]);

		// Anyone holding the URL, a provider, gets the image; a changed signature gets nothing.
		const fetched = await exports.default.fetch(sent[0]!.url);
		expect(fetched.status).toBe(200);
		expect(Buffer.from(await fetched.arrayBuffer()).toString("base64")).toBe(png);
		const forged = await exports.default.fetch(sent[0]!.url.replace(/signature=[0-9a-f]/, (match) => `${match.slice(0, -1)}${match.endsWith("0") ? "1" : "0"}`));
		expect(forged.status).toBe(404);
	});

	it("runs a turn submitted over the socket and streams its events", async () => {
		const { body: created } = await post("/sessions");
		const { socket, received } = await connect(created.id);
		await vi.waitFor(() => expect(received.some((message) => message.type === "events")).toBe(true));
		expect(received[0]).toMatchObject({ type: "hello", session: created.id });
		expect(received[1].events[0].type).toBe("snapshot");

		faux.setResponses([toolUse("send_to_user", { message: "Hello over the socket." })]);
		socket.send(JSON.stringify({ type: "submit", id: "c1", content: "hi" }));

		const events = () => received.filter((message) => message.type === "events").flatMap((message) => message.events);
		await vi.waitFor(() => expect(events().some((event) => event.type === "run_end")).toBe(true));
		expect(received.find((message) => message.type === "result")).toMatchObject({ id: "c1", result: { accepted: true } });
		const roles = events()
			.filter((event) => event.type === "message_end")
			.map((event) => event.entry.model[0].role)
			.filter((role) => role !== "system");
		expect(roles).toEqual(["user", "assistant", "toolResult"]);
		socket.close();
	});

	it("refuses a socket for a session that does not exist", async () => {
		const { received } = await connect("999");
		await vi.waitFor(() => expect(received).toEqual([{ type: "error", message: "No session 999" }]));
	});
});
