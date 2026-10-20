import { createAssistantMessageEventStream } from "@earendil-works/pi-ai";
import { fauxAssistantMessage, type FauxResponseFactory, fauxText, fauxThinking, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import { env, runInDurableObject } from "cloudflare:test";
import { exports } from "cloudflare:workers";
import { describe, expect, it, vi } from "vitest";
import type { StoredImage } from "../src/images";
import type { TranscriptMessage } from "../src/transcript";
import { api, apiUrl, connect, lastUserText, OWNER, post, ROOT, say, textOf, TOKEN, toolUse, url } from "./helpers";
import { faux, type Pim, utility } from "./worker";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

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
		expect(body).toMatchObject({ model: "faux-model", timeZone: "America/New_York", rootSession: expect.stringMatching(UUID) });
		const tools = new Map((body.tools as { name: string; requiresApproval: boolean }[]).map((tool) => [tool.name, tool]));
		expect(tools.get("http_request")?.requiresApproval).toBe(true);
		expect(tools.get("note")?.requiresApproval).toBe(false);
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
	it("tracks unread replies without notifications and acknowledges only replies the client saw", async () => {
		const { id } = (await post("/sessions", { title: "Unread replies" })).body;
		const listed = async () => (await api("/sessions")).body.sessions.find((session: { id: string }) => session.id === id);
		expect(await listed()).toMatchObject({ unread: false, responseAt: null });
		const { socket, received } = await connect();
		try {
			faux.setResponses([toolUse("send_to_user", { message: "First reply." })]);
			await say("First", id);
			const first = await listed();
			expect(first).toMatchObject({ unread: true, responseAt: expect.any(Number) });
			await vi.waitFor(() => expect(received.some((message) => message.type === "sessions")).toBe(true));
			expect((await post(`/sessions/${id}/read`, { responseAt: first.responseAt })).body.unread).toBe(false);
			faux.setResponses([toolUse("send_to_user", { message: "Second reply." })]);
			await say("Second", id);
			const second = await listed();
			expect(second.responseAt).toBeGreaterThan(first.responseAt);
			// A slow acknowledgement from another device cannot swallow the newer reply.
			expect((await post(`/sessions/${id}/read`, { responseAt: first.responseAt })).body.unread).toBe(true);
			expect((await post(`/sessions/${id}/read`, { responseAt: second.responseAt })).body.unread).toBe(false);
			expect((await post(`/sessions/${id}/read`, { responseAt: first.responseAt })).body.unread).toBe(false);
			for (const responseAt of [-1, 1.5, "now", null]) {
				expect((await post(`/sessions/${id}/read`, { responseAt })).status).toBe(400);
			}
			expect((await post("/sessions/missing/read", { responseAt: 0 })).status).toBe(404);
		} finally {
			socket.close();
		}
	});

	it("archives chats after two days without activity, except those with unread replies, until they are active again", async () => {
		const quiet = (await post("/sessions", { title: "Quiet" })).body.id;
		const unread = (await post("/sessions", { title: "Unread" })).body.id;
		const archived = async () =>
			Object.fromEntries(((await api("/sessions")).body.sessions as { id: string; archived: boolean }[]).map((s) => [s.id, s.archived]));
		faux.setResponses([toolUse("send_to_user", { message: "Hi." })]);
		await say("Hello", quiet);
		const { responseAt } = (await api("/sessions")).body.sessions.find((s: { id: string }) => s.id === quiet);
		await post(`/sessions/${quiet}/read`, { responseAt });
		faux.setResponses([toolUse("send_to_user", { message: "Done." })]);
		await say("Remind me", unread);
		vi.useFakeTimers({ toFake: ["Date"] });
		try {
			vi.setSystemTime(Date.now() + 47 * 60 * 60 * 1000);
			expect(await archived()).toMatchObject({ [quiet]: false, [unread]: false });
			vi.setSystemTime(Date.now() + 2 * 60 * 60 * 1000);
			expect(await archived()).toMatchObject({ [quiet]: true, [unread]: false });
			faux.setResponses([toolUse("send_to_user", { message: "Back." })]);
			await say("I'm back", quiet);
			expect((await archived())[quiet]).toBe(false);
		} finally {
			vi.useRealTimers();
			// Their activity is now in the future, which would put them first in later tests' lists.
			for (const id of [quiet, unread]) await api(`/sessions/${id}`, { method: "DELETE" });
		}
	});

	it("answers a message and keeps the transcript", async () => {
		faux.setResponses([toolUse("send_to_user", { message: "Paris." })]);
		const answer = await say("What is the capital of France?");
		expect(answer).toMatchObject({ status: "done", text: "Paris." });

		const { body } = await api(`/sessions/${ROOT}/messages`);
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
		// A session goes by a random id; pi's number for its conversation is no address.
		expect(created.id).toMatch(UUID);
		const number = await runInDurableObject(env.Pim.getByName(OWNER), (instance: Pim) => instance.store.sessionOf(created.id));
		expect(number).toMatch(/^[0-9]+$/);
		expect((await api(`/sessions/${number}/messages`)).status).toBe(404);
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
			const session = instance.store.sessionOf(third)!;
			const receipt = await instance.submitTo(session, "[Scheduled task] remind", {}, "pim");
			await instance.harness.wait(receipt.operationId, { session });
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
		expect((await api(`/sessions/${ROOT}`, { method: "DELETE" })).status).toBe(200);
		expect(await listed()).not.toContain(ROOT);
		faux.setResponses([toolUse("send_to_user", { message: "Back." })]);
		expect((await say("hello again")).text).toBe("Back.");
		expect(await listed()).toContain(ROOT);
	});

	it("makes a public link to a chat: a copy of what the person read, as it was, for anyone with the link until it's turned off", async () => {
		const chat = (await post("/sessions")).body.id;
		expect((await api(`/sessions/${chat}/link`, { method: "PUT" })).status).toBe(409);
		faux.setResponses([
			fauxAssistantMessage([fauxThinking("They want Lisbon."), fauxText("Private working note."), fauxToolCall("create_goal", { title: "Visit Lisbon", steps: ["Book a flight"] })], {
				stopReason: "toolUse",
			}),
			// Refused: nothing reached the person.
			toolUse("send_to_user", { message: "Never sent.", widgets: ["test.nothing/here"] }),
			toolUse("send_to_user", { message: "Lisbon it is.", widgets: ["pim.goals/active"] }),
		]);
		const content = [
			{ type: "text", text: "Plan a trip to Lisbon" },
			{ type: "image", data: "iVBORw0KGgo=", mimeType: "image/png" },
		];
		expect((await post(`/sessions/${chat}/messages`, { content, wait: true })).status).toBe(200);

		const { status, body: made } = await api(`/sessions/${chat}/link`, { method: "PUT" });
		expect(status).toBe(200);
		const { link } = made as { link: { id: string; url: string; sharedAt: number; messages: number } };
		expect(link).toEqual({ id: expect.stringMatching(/^[0-9a-z]{22}$/), url: `https://pim.test/shared/${OWNER}/${link.id}`, sharedAt: expect.any(Number), messages: 2 });
		expect((await api(`/sessions/${chat}/link`)).body).toEqual({ link });

		// Anyone can read it: no token, no cookie.
		const read = () => exports.default.fetch(url(`/api/shared/${OWNER}/${link.id}`));
		const response = await read();
		expect(response.status).toBe(200);
		expect(response.headers.get("x-robots-tag")).toBe("noindex");
		const shared = (await response.json()) as any;
		const agent = ((await api("/sessions")).body.sessions as { id: string; agent: { name: string } }[]).find((session) => session.id === chat)!.agent;
		expect(shared).toEqual({
			title: "Plan a trip to Lisbon",
			agent: { name: agent.name, symbol: null, color: null },
			sharedAt: link.sharedAt,
			messages: [
				{ role: "user", text: "Plan a trip to Lisbon", images: 1, at: expect.any(Number) },
				{ role: "agent", text: "Lisbon it is.", widgets: [expect.objectContaining({ id: "pim.goals/active", kind: "progress" })], at: expect.any(Number) },
			],
		});
		const goal = shared.messages[1].widgets[0].items.find((item: { title: string }) => item.title === "Visit Lisbon");
		// The widget is as it was sent, without links into the owner's chats.
		expect(goal).toEqual({ title: "Visit Lisbon", value: 0, max: 1, detail: "Book a flight" });
		// Nothing private, and no image, is in it.
		const raw = JSON.stringify(shared);
		for (const hidden of ["They want Lisbon", "Private working note", "create_goal", "Never sent", "iVBORw0KGgo", "/images/", chat]) expect(raw).not.toContain(hidden);

		// It stays as it was when made, until its owner updates it, which keeps its address.
		faux.setResponses([toolUse("send_to_user", { message: "Book early." })]);
		await say("Any tips?", chat);
		expect(((await (await read()).json()) as any).messages).toHaveLength(2);
		const updated = (await api(`/sessions/${chat}/link`, { method: "PUT" })).body.link;
		expect(updated).toMatchObject({ id: link.id, messages: 4 });
		expect(((await (await read()).json()) as any).messages.slice(2).map((message: { text: string }) => message.text)).toEqual(["Any tips?", "Book early."]);

		// Every other address is the same 404: another owner, another id, or a path that isn't a link.
		const other = (await exports.default.fetch(url(`/api/shared/o_${"a".repeat(26)}/${link.id}`))).status;
		const wrong = (await exports.default.fetch(url(`/api/shared/${OWNER}/${"a".repeat(22)}`))).status;
		const partial = (await exports.default.fetch(url(`/api/shared/${link.id}`), { headers: { Authorization: `Bearer ${TOKEN}` } })).status;
		expect([other, wrong, partial]).toEqual([404, 404, 404]);

		// Turning it off, or deleting the chat, ends it.
		expect((await api(`/sessions/${chat}/link`, { method: "DELETE" })).body).toEqual({ deleted: true });
		expect((await read()).status).toBe(404);
		expect((await api(`/sessions/${chat}/link`)).body).toEqual({ link: null });
		const again = (await api(`/sessions/${chat}/link`, { method: "PUT" })).body.link;
		expect(again.id).not.toBe(link.id);
		await api(`/sessions/${chat}`, { method: "DELETE" });
		expect((await exports.default.fetch(url(`/api/shared/${OWNER}/${again.id}`))).status).toBe(404);
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

		const refused = async (parts: unknown) => (await post(`/sessions/${ROOT}/messages`, { content: parts })).status;
		expect(await refused([{ type: "image", data: "A".repeat(6_666_668), mimeType: "image/png" }])).toBe(413);
		expect(await refused(Array.from({ length: 5 }, () => ({ type: "image", data: "AAAA", mimeType: "image/png" })))).toBe(400);
		expect(await refused([{ type: "image", data: "AAAA", mimeType: "image/svg+xml" }])).toBe(415);
		expect(await refused([{ type: "image", data: "not base64!", mimeType: "image/png" }])).toBe(400);
		expect(await refused([{ type: "image", url: "https://example.com/cat.png" }])).toBe(400);
		expect(await refused([{ type: "text", text: "  " }])).toBe(400);
		expect(await refused("")).toBe(400);
	});

	it("shows cards with copies of the images a tool's result gave, and refuses images the model made up", async () => {
		const png = Buffer.from("iVBORw0KGgo=", "base64");
		const fetched: string[] = [];
		const realFetch = globalThis.fetch;
		vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
			const request = new Request(input, init);
			if (!request.url.includes(".example.test")) return realFetch(input, init);
			fetched.push(request.url);
			if (request.url === "https://shop.example.test/vest") {
				const page = `<html><head><meta property="og:image" content="/img/vest.png?w=400&amp;h=400"></head><body><h1>Dog vest</h1><img src="https://cdn.example.test/broken.png"></body></html>`;
				return new Response(page, { headers: { "content-type": "text/html; charset=utf-8" } });
			}
			if (request.url === "https://shop.example.test/img/vest.png?w=400&h=400") return new Response(png, { headers: { "content-type": "image/png" } });
			return new Response("<html>not an image</html>", { headers: { "content-type": "text/html" } });
		});
		const card = (image: string) => `\`\`\`cards\n${JSON.stringify([{ title: "Dog vest", url: "https://shop.example.test/vest", image, meta: "Shop · $20" }])}\n\`\`\``;
		const madeUp = "https://evil.example.test/pixel.png?d=secret";
		faux.setResponses([
			toolUse("fetch_url", { url: "https://shop.example.test/vest" }),
			toolUse("send_to_user", { message: `Found one:\n\n${card(madeUp)}` }),
			// The refusal names the image, which doesn't make it one a tool gave.
			toolUse("send_to_user", { message: `Found one:\n\n${card(madeUp)}` }),
			toolUse("send_to_user", {
				message: `Found one:\n\n${card("https://shop.example.test/img/vest.png?w=400&h=400")}\n\n${card("https://cdn.example.test/broken.png")}`,
			}),
		]);
		const { id } = (await post("/sessions")).body;
		const answer = await say("Find me a dog vest", id);

		// Clients that can't draw cards get them as links.
		expect(answer.text).toBe("Found one:\n\n- **[Dog vest](https://shop.example.test/vest)** · Shop · $20\n\n- **[Dog vest](https://shop.example.test/vest)** · Shop · $20");
		expect(fetched).not.toContain(madeUp);
		const results = ((await api(`/sessions/${id}/messages`)).body.messages as TranscriptMessage[]).flatMap((message) =>
			message.parts.flatMap((part) => (part.type === "tool-result" && part.name === "send_to_user" ? [part.content.map((content) => (content.type === "text" ? content.text : "")).join("")] : [])),
		);
		expect(results.filter((result) => result.startsWith("Not sent: no tool's result in this chat gave https://evil.example.test/"))).toHaveLength(2);
		const sent = JSON.parse(results.at(-1)!) as { images: Record<string, string>; notShown: string };
		expect(Object.keys(sent.images)).toEqual(["https://shop.example.test/img/vest.png?w=400&h=400"]);
		expect(sent.notShown).toContain("https://cdn.example.test/broken.png");

		// The copy is Pim's, served from here.
		const copy = sent.images["https://shop.example.test/img/vest.png?w=400&h=400"]!;
		expect(copy).toMatch(/^\/api\/images\/[0-9a-f-]{36}$/);
		const served = await exports.default.fetch(url(copy), { headers: { Authorization: `Bearer ${TOKEN}` } });
		expect(served.headers.get("content-type")).toBe("image/png");
		expect(Buffer.from(await served.arrayBuffer())).toEqual(png);
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

	it("tells whoever has a chat open what its agent is doing, in the utility model's words, unless the model's own headings say it", async () => {
		// Named already, so the utility model only describes the work.
		const { body: created } = await post("/sessions", { title: "Lisbon time" });
		const { socket, received } = await connect(created.id);
		await vi.waitFor(() => expect(received.some((message) => message.type === "events")).toBe(true));
		const inputs: string[] = [];
		utility.setResponses([
			(context) => {
				inputs.push(lastUserText(context.messages));
				return fauxAssistantMessage('"Checking the time in Lisbon."');
			},
		]);
		faux.setResponses([
			// A summarized reasoning's heading describes this step: the app shows it, and no line is written.
			fauxAssistantMessage([fauxThinking("**Finding the time zone**\n\nLisbon is on WET."), fauxToolCall("current_time", {})], { stopReason: "toolUse" }),
			fauxAssistantMessage([fauxThinking("Now the local time, for the person."), fauxToolCall("current_time", { zone: "Europe/Lisbon" })], {
				stopReason: "toolUse",
			}),
			toolUse("send_to_user", { message: "It's noon in Lisbon." }),
		]);
		await say("What time is it in Lisbon?", created.id);
		// The line is for the step's own tool call, so the app shows it in that call's place.
		const { messages } = (await api<{ messages: TranscriptMessage[] }>(`/sessions/${created.id}/messages`)).body;
		const [, second] = messages.flatMap((message) => message.parts.flatMap((part) => (part.type === "tool-call" && part.name === "current_time" ? [part.id] : [])));
		await vi.waitFor(() =>
			expect(received.filter((message) => message.type === "progress")).toEqual([
				{ type: "progress", session: created.id, text: "Checking the time in Lisbon", calls: [second] },
			]),
		);
		// The request, what the agent found, its notes and its call: the step after the headed one.
		expect(inputs).toHaveLength(1);
		expect(inputs[0]).toContain("Their request: What time is it in Lisbon?");
		expect(inputs[0]).toMatch(/Found so far:\n- current_time: \S/);
		expect(inputs[0]).toContain("Its notes: Now the local time, for the person.");
		expect(inputs[0]).toContain('- current_time {"zone":"Europe/Lisbon"}');
		expect(inputs[0]).not.toContain("Finding the time zone");
		socket.close();
	});

	it("moves a socket to another session with follow, and reads another's snapshot without following it", async () => {
		const { body: first } = await post("/sessions");
		const { body: second } = await post("/sessions");
		const { socket, received } = await connect(first.id);
		await vi.waitFor(() => expect(received.some((message) => message.type === "events")).toBe(true));

		socket.send(JSON.stringify({ type: "follow", id: "f1", session: "999" }));
		await vi.waitFor(() => expect(received.at(-1)).toEqual({ type: "error", id: "f1", message: "No session 999" }));
		// Flipping through chats: the last one asked for is followed.
		socket.send(JSON.stringify({ type: "follow", id: "f2", session: first.id }));
		socket.send(JSON.stringify({ type: "follow", id: "f3", session: second.id }));
		await vi.waitFor(() => expect(received.filter((message) => message.type === "result").map((message) => message.id).sort()).toEqual(["f2", "f3"]));
		const snapshots = received.filter((message) => message.type === "events" && message.events[0].type === "snapshot");
		expect(snapshots.at(-1).session).toBe(second.id);

		received.length = 0;
		faux.setResponses([toolUse("send_to_user", { message: "In the first." }), toolUse("send_to_user", { message: "In the second." })]);
		await say("one", first.id);
		await say("two", second.id);
		const followed = received.filter((message) => message.type === "events");
		expect(followed.flatMap((message) => message.events).some((event) => event.type === "run_end")).toBe(true);
		expect(new Set(followed.map((message) => message.session))).toEqual(new Set([second.id]));

		// Another session's snapshot comes back as the result, and the socket keeps following the second.
		received.length = 0;
		socket.send(JSON.stringify({ type: "snapshot", id: "s1", session: first.id }));
		await vi.waitFor(() => expect(received).toHaveLength(1));
		const { result } = received[0];
		expect(received[0]).toMatchObject({ type: "result", id: "s1", result: { type: "snapshot" } });
		expect(JSON.stringify(result.entries)).toContain("In the first.");
		expect(JSON.stringify(result.entries)).not.toContain("In the second.");
		faux.setResponses([toolUse("send_to_user", { message: "Still the second." })]);
		await say("three", second.id);
		expect(new Set(received.filter((message) => message.type === "events").map((message) => message.session))).toEqual(new Set([second.id]));
		socket.close();
	});

	it("refuses a socket for a session that does not exist", async () => {
		const { received } = await connect("999");
		await vi.waitFor(() => expect(received).toEqual([{ type: "error", message: "No session 999" }]));
	});
});
