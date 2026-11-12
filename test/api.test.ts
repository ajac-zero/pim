import { createAssistantMessageEventStream } from "@earendil-works/pi-ai";
import { fauxAssistantMessage, type FauxResponseFactory, fauxText, fauxThinking, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { getAgentByName } from "agents";
import { CompactionTask } from "@earendil-works/pi-durable";
import { env, runInDurableObject } from "cloudflare:test";
import { exports } from "cloudflare:workers";
import { describe, expect, it, vi } from "vitest";
import type { StoredImage } from "../src/images";
import type { TranscriptMessage } from "../src/transcript";
import { uiBlockId, uiBlockIds } from "../src/ui-lang";
import { api, apiUrl, connect, lastUserText, messagesOf, OWNER, post, ROOT, say, settled, textOf, TOKEN, toolUse, triggersOn, url } from "./helpers";
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

	it("archives a chat by hand until it is active again", async () => {
		const id = (await post("/sessions", { title: "Manual" })).body.id;
		const archived = async () => (await api("/sessions")).body.sessions.find((s: { id: string }) => s.id === id).archived;
		expect(await archived()).toBe(false);
		expect((await post(`/sessions/${id}/archive`, {})).status).toBe(200);
		expect(await archived()).toBe(true);
		faux.setResponses([toolUse("send_to_user", { message: "Back." })]);
		await say("I'm back", id);
		expect(await archived()).toBe(false);
		expect((await post("/sessions/missing/archive", {})).status).toBe(404);
		await post(`/sessions/${id}/archive`, {});
		expect(await archived()).toBe(true);
		expect((await post(`/sessions/${id}/unarchive`, {})).status).toBe(200);
		expect(await archived()).toBe(false);
		expect((await post("/sessions/missing/unarchive", {})).status).toBe(404);
		await api(`/sessions/${id}`, { method: "DELETE" });
	});

	it("archives chats after two weeks without activity, except those with unread replies, until they are active again", async () => {
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
			vi.setSystemTime(Date.now() + (14 * 24 - 1) * 60 * 60 * 1000);
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

	it("counts what a chat has cost across new contexts", async () => {
		const { body: created } = await post("/sessions");
		const output = async () => (await api<{ models: { output: number }[] }>(`/sessions/${created.id}/cost`)).body.models.reduce((sum, row) => sum + row.output, 0);
		faux.setResponses([toolUse("send_to_user", { message: "x".repeat(400) })]);
		await say("hi", created.id);
		const first = await output();
		expect(first).toBeGreaterThan(100);
		// A new context leaves what the requests before it cost on the chat's bill.
		expect((await post(`/sessions/${created.id}/reset`)).status).toBe(200);
		expect(await output()).toBe(first);
		faux.setResponses([toolUse("send_to_user", { message: "y".repeat(400) })]);
		await say("again", created.id);
		expect(await output()).toBeGreaterThan(first + 100);
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
		await triggersOn();
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

	it("shows the messages queued behind the work, and steers, edits or cancels one before the agent reads it", async () => {
		const { body: created } = await post("/sessions");
		const { socket, received } = await connect(created.id);
		await vi.waitFor(() => expect(received.some((message) => message.type === "events")).toBe(true));
		let release!: () => void;
		const held = new Promise<void>((resolve) => (release = resolve));
		const read: string[][] = [];
		const reads = (context: Parameters<FauxResponseFactory>[0]) =>
			read.push(context.messages.filter((message) => message.role === "user").map((message) => lastUserText([message])));
		faux.setResponses([
			async (context) => {
				reads(context);
				await held;
				return toolUse("current_time", {});
			},
			(context) => {
				reads(context);
				return toolUse("send_to_user", { message: "Steered." });
			},
			(context) => {
				reads(context);
				return toolUse("send_to_user", { message: "Edited." });
			},
		]);
		const path = `/sessions/${created.id}/messages`;
		await post(path, { content: "Start" });
		await vi.waitFor(() => expect(read).toHaveLength(1));
		for (const content of ["Never mind", "Steer this", "Edit this"]) await post(path, { content });

		// Each queued message comes with what it says.
		const inbox = () => received.flatMap((message) => (message.type === "events" ? message.events : [])).findLast((event) => event.type === "inbox_update")?.items ?? [];
		await vi.waitFor(() => expect(inbox()).toHaveLength(3));
		const [never, steer, edit] = inbox();
		expect([never, steer, edit]).toMatchObject([
			{ mode: "followUp", content: "Never mind" },
			{ mode: "followUp", content: "Steer this" },
			{ mode: "followUp", content: "Edit this" },
		]);
		const queue = `/sessions/${created.id}/queue`;
		expect((await api(`${queue}/${never.id}`, { method: "DELETE" })).status).toBe(200);
		expect((await post(`${queue}/${steer.id}/steer`)).status).toBe(200);
		expect((await api(`${queue}/${edit.id}`, { method: "PUT", body: JSON.stringify({ text: "Edited it" }) })).status).toBe(200);
		expect((await api(`${queue}/${edit.id}`, { method: "PUT", body: JSON.stringify({ text: " " }) })).status).toBe(400);
		await vi.waitFor(() => expect(inbox()).toEqual([{ ...steer, mode: "steer" }, { ...edit, content: "Edited it" }]));

		release();
		await settled(created.id);
		// The steered message joined the run after its tool call; the edited one waited for the run to end; the canceled one never came.
		expect(read).toEqual([["Start"], ["Start", "Steer this"], ["Start", "Steer this", "Edited it"]]);
		// A message the agent has already can't change.
		expect((await post(`${queue}/${edit.id}/steer`)).status).toBe(409);
		socket.close();
	});

	it("forks a chat through an agent's message, or up to one of the person's to send it changed, keeping its images while a fork shows them", async () => {
		const { body: chat } = await post("/sessions", { title: "Trip" });
		faux.setResponses([toolUse("send_to_user", { message: "Where to?" }), toolUse("send_to_user", { message: "Lisbon it is." })]);
		const plan = [
			{ type: "text", text: "Plan a trip" },
			{ type: "image", data: "iVBORw0KGgo=", mimeType: "image/png" },
		];
		expect((await post(`/sessions/${chat.id}/messages`, { content: plan, wait: true })).status).toBe(200);
		await say("Lisbon", chat.id);
		const messages = (await api(`/sessions/${chat.id}/messages`)).body.messages as TranscriptMessage[];
		expect(messages.map((message) => message.role)).toEqual(["user", "assistant", "tool", "user", "assistant", "tool"]);
		const image = (messages[0]!.parts.find((part) => part.type === "image") as StoredImage).url;

		// Through the agent's first message: what it sent, with its tool's result, and nothing after.
		const { body: fork } = await post(`/sessions/${chat.id}/fork`, { at: messages[1]!.id });
		expect(fork).toMatchObject({ title: "Trip (fork #1)", agent: chat.agent });
		expect(fork.id).not.toBe(chat.id);
		const forked = (await api(`/sessions/${fork.id}/messages`)).body.messages as TranscriptMessage[];
		expect(forked.map((message) => message.id)).toEqual(messages.slice(0, 3).map((message) => message.id));
		const heard: string[][] = [];
		faux.setResponses([
			(context) => {
				heard.push(context.messages.filter((message) => message.role === "user").map((message) => lastUserText([message])));
				return toolUse("send_to_user", { message: "Porto, then." });
			},
		]);
		// Its first message names it anew, from what was said before and that.
		const named: string[] = [];
		utility.setResponses([
			({ messages }) => {
				named.push(JSON.stringify(messages.at(-1)?.content));
				return fauxAssistantMessage("Porto Trip");
			},
		]);
		await say("Porto", fork.id);
		expect(heard).toEqual([["Plan a trip", "Porto"]]);
		await vi.waitFor(async () => expect((await api("/sessions")).body.sessions.find((s: { id: string }) => s.id === fork.id).title).toBe("Porto Trip"));
		expect(named[0]).toContain("Assistant: Where to?");
		expect(named[0]).toMatch(/Where to\?.*Person: Porto/);
		expect(named[0]).not.toContain("Lisbon");
		expect(await messagesOf(chat.id, "user")).toEqual(["Plan a trip", "Lisbon"]);

		// Before the person's first message, to send it again changed: nothing of the chat is left.
		const { body: edited } = await post(`/sessions/${chat.id}/fork`, { before: messages[0]!.id });
		expect((await api(`/sessions/${edited.id}/messages`)).body.messages).toEqual([]);
		// Before their second: the first exchange.
		const { body: second } = await post(`/sessions/${chat.id}/fork`, { before: messages[3]!.id });
		expect(await messagesOf(second.id, "user")).toEqual(["Plan a trip"]);
		// Numbered after the forks still titled so: the first, renamed since, no longer counts.
		expect([edited.title, second.title]).toEqual(["Trip (fork #1)", "Trip (fork #2)"]);
		// A fork of a fork counts with its chat's forks.
		const { body: again } = await post(`/sessions/${second.id}/fork`, { at: messages[1]!.id });
		expect(again.title).toBe("Trip (fork #3)");


		for (const body of [{ at: messages[0]!.id }, { before: messages[1]!.id }, { at: "999999" }, {}, { at: messages[1]!.id, before: messages[0]!.id }]) {
			expect((await post(`/sessions/${chat.id}/fork`, body)).status).toBe(400);
		}

		// The image stays while a fork shows it, and goes with the last of them.
		const served = async () => (await exports.default.fetch(url(image), { headers: { Authorization: `Bearer ${TOKEN}` } })).status;
		await api(`/sessions/${chat.id}`, { method: "DELETE" });
		expect(await served()).toBe(200);
		for (const id of [fork.id, edited.id, second.id, again.id]) await api(`/sessions/${id}`, { method: "DELETE" });
		expect(await served()).toBe(404);
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

	it("keeps an animated GIF's bytes as they are, and stops reading an image once it passes the limit", async () => {
		// Two frames with a loop extension, not a still: kept byte for byte.
		const gif = Buffer.from("R0lGODlhAQABAPAAAAAAAP///yH/C05FVFNDQVBFMi4wAwEAAAAh+QQACgAAACwAAAAAAQABAAACAkQBACH5BAAKAAAALAAAAAABAAEAAAICRAEAOw==", "base64");
		const CHUNK = 100_000;
		// A body made on demand, as a network gives one: nothing is read ahead but what is asked for.
		const stats: Record<string, { pulls: number; cancelled: boolean }> = {};
		const streamed = (name: string, total: number, headers: Record<string, string>) => {
			const seen = { pulls: 0, cancelled: false };
			stats[name] = seen;
			let sent = 0;
			const body = new ReadableStream<Uint8Array>(
				{
					pull(controller) {
						seen.pulls++;
						const chunk = new Uint8Array(Math.min(CHUNK, total - sent));
						if (sent === 0) chunk.set(gif);
						sent += chunk.length;
						controller.enqueue(chunk);
						if (sent === total) controller.close();
					},
					cancel() {
						seen.cancelled = true;
					},
				},
				{ highWaterMark: 0 },
			);
			return new Response(body, { headers: { "content-type": "image/gif", ...headers } });
		};
		const realFetch = globalThis.fetch;
		vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
			const request = new Request(input, init);
			switch (request.url) {
				case "https://cdn.example.test/anim.gif":
					return new Response(gif, { headers: { "content-type": "image/gif" } });
				// Exactly the limit, with no length declared.
				case "https://cdn.example.test/exact.gif":
					return streamed("exact", 5_000_000, {});
				// Over it by a long way, with no length declared.
				case "https://cdn.example.test/endless.gif":
					return streamed("endless", 50_000_000, {});
				// Over it, declaring a length that is far too small.
				case "https://cdn.example.test/liar.gif":
					return streamed("liar", 50_000_000, { "content-length": "10" });
				case "https://cdn.example.test/page":
					return new Response(addresses.map((address) => `<img src="${address}">`).join(""), { headers: { "content-type": "text/html" } });
				default:
					return realFetch(input, init);
			}
		});
		const names = ["anim", "exact", "endless", "liar"];
		const addresses = names.map((name) => `https://cdn.example.test/${name}.gif`);
		const gallery = `\`\`\`gallery\n${JSON.stringify(addresses.map((image) => ({ image, caption: "Row", url: "https://cdn.example.test/page" })))}\n\`\`\``;
		faux.setResponses([
			// The page's tool result has to give the images before a reply may show them.
			toolUse("fetch_url", { url: "https://cdn.example.test/page" }),
			toolUse("send_to_user", { message: gallery }),
		]);
		const { id } = (await post("/sessions")).body;
		await say("Show me a row", id);
		const results = ((await api(`/sessions/${id}/messages`)).body.messages as TranscriptMessage[]).flatMap((message) =>
			message.parts.flatMap((part) => (part.type === "tool-result" && part.name === "send_to_user" ? [part.content.map((content) => (content.type === "text" ? content.text : "")).join("")] : [])),
		);
		const sent = JSON.parse(results.at(-1)!) as { images: Record<string, string>; notShown: string };
		// Only the GIF and the one of exactly the limit are kept, and the first is served as it came.
		expect(Object.keys(sent.images)).toEqual([addresses[0], addresses[1]]);
		const served = async (address: string) => exports.default.fetch(url(sent.images[address]!), { headers: { Authorization: `Bearer ${TOKEN}` } });
		const animated = await served(addresses[0]!);
		expect(animated.headers.get("content-type")).toBe("image/gif");
		expect(Buffer.from(await animated.arrayBuffer())).toEqual(gif);
		expect((await (await served(addresses[1]!)).arrayBuffer()).byteLength).toBe(5_000_000);
		expect(stats.exact).toEqual({ pulls: 50, cancelled: false });
		// The others are refused, and reading stops soon after the limit: the 45 MB left unread is never pulled.
		expect(sent.notShown).toContain("endless.gif");
		expect(sent.notShown).toContain("liar.gif");
		for (const name of ["endless", "liar"]) {
			expect(stats[name]!.cancelled).toBe(true);
			expect(stats[name]!.pulls).toBeLessThanOrEqual(52);
		}
	});

	it("shows cards and galleries with copies of the images a tool's result gave, and refuses images the model made up", async () => {
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
		const gallery = (image: string) => `\`\`\`gallery\n${JSON.stringify([{ image, caption: "The vest", url: "https://shop.example.test/vest" }])}\n\`\`\``;
		const madeUp = "https://evil.example.test/pixel.png?d=secret";
		faux.setResponses([
			toolUse("fetch_url", { url: "https://shop.example.test/vest" }),
			toolUse("send_to_user", { message: `Found one:\n\n${card(madeUp)}` }),
			// The refusal names the image, which doesn't make it one a tool gave.
			toolUse("send_to_user", { message: `Found one:\n\n${gallery(madeUp)}` }),
			toolUse("send_to_user", {
				message: `Found one:\n\n${card("https://shop.example.test/img/vest.png?w=400&h=400")}\n\n${card("https://cdn.example.test/broken.png")}\n\n${gallery("https://shop.example.test/img/vest.png?w=400&h=400")}`,
			}),
		]);
		const { id } = (await post("/sessions")).body;
		const answer = await say("Find me a dog vest", id);

		// Clients that can't draw them get them as links.
		expect(answer.text).toBe(
			"Found one:\n\n- **[Dog vest](https://shop.example.test/vest)** · Shop · $20\n\n- **[Dog vest](https://shop.example.test/vest)** · Shop · $20\n\n- [The vest](https://shop.example.test/vest)",
		);
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

	it("shows YouTube videos as links elsewhere, and refuses other addresses and malformed ids", async () => {
		const videos = (items: unknown[]) => `Try:\n\n\`\`\`videos\n${JSON.stringify(items)}\n\`\`\``;
		const id = "dQw4w9WgXcQ";
		faux.setResponses([
			toolUse("send_to_user", { message: videos([{ url: `https://evil.example.test/watch?v=${id}` }]) }),
			toolUse("send_to_user", { message: videos([{ url: `https://www.youtube.com/watch?v=${id}x` }]) }),
			toolUse("send_to_user", { message: videos([{ url: `https://youtu.be/${id}`, embed: "https://evil.example.test" }]) }),
			toolUse("send_to_user", { message: videos([{ url: `https://youtube.com.evil.example.test/shorts/${id}` }]) }),
			toolUse("send_to_user", { message: videos([{ url: `https://www.youtube.com/watch?v=${id}`, title: "Squat form" }, { url: `https://youtube.com/shorts/${id}` }]) }),
		]);
		const { id: session } = (await post("/sessions")).body;
		const answer = await say("Show me a squat", session);
		expect(answer.text).toBe(`Try:\n\n- [Squat form](https://www.youtube.com/watch?v=${id})\n- [Video](https://youtube.com/shorts/${id})`);
		const results = ((await api(`/sessions/${session}/messages`)).body.messages as TranscriptMessage[]).flatMap((message) =>
			message.parts.flatMap((part) => (part.type === "tool-result" && part.name === "send_to_user" ? [part.content.map((content) => (content.type === "text" ? content.text : "")).join("")] : [])),
		);
		expect(results.slice(0, 4).map((result) => result.slice(0, 60))).toEqual([
			"Not sent: in a ```videos block, an item's url must be a YouT",
			"Not sent: in a ```videos block, an item's url must be a YouT",
			"Not sent: in a ```videos block, an item has no embed.",
			"Not sent: in a ```videos block, an item's url must be a YouT",
		]);
	});

	it("checks a ```ui block when it is sent, refusing what can't be drawn and noting what still can", async () => {
		const bad = "Here you go:\n\n```ui\n<form id=\"quiz\"><gauge/></form>\n```";
		const good = ["Try it:", "", "```ui", '<form id="quiz" title="Capitals" submitLabel="Check">', '  <input name="city" label="Capital of Portugal" answer="Lisbon" hint="h"/>', "</form>", "```"].join("\n");
		faux.setResponses([
			toolUse("send_to_user", { message: bad }),
			toolUse("send_to_user", { message: good }),
		]);
		const { id: session } = (await post("/sessions")).body;
		const answer = await say("Quiz me", session);
		const results = ((await api(`/sessions/${session}/messages`)).body.messages as TranscriptMessage[]).flatMap((message) =>
			message.parts.flatMap((part) => (part.type === "tool-result" && part.name === "send_to_user" ? [part.content.map((content) => (content.type === "text" ? content.text : "")).join("")] : [])),
		);
		// The refused one says what Pim's compiler found, without the compiled block.
		expect(results[0]).toContain("Not sent: a ```ui block");
		expect(results[0]).toContain("<gauge> is not one of the components a ui block may draw.");
		expect(results[0]).not.toContain("forms");
		// The good one sends, with only its diagnostics going back to the model.
		const sent = JSON.parse(results[1]!) as { sent: string; uiNotes: string[] };
		expect(sent.sent).toBe("Sent.");
		expect(sent.uiNotes).toEqual(["a ```ui block <input> has no hint."]);
		// What a client that can't draw it gets: the block as readable Markdown, its answers as blanks.
		expect(answer.text).toBe(["Try it:", "", "Capitals (form quiz)", "", "- Capital of Portugal: ___"].join("\n"));
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

	it("carries a chat on in a new one when it needs compacting, and leaves the chat whole", async () => {
		const { id } = (await post("/sessions", { title: "Long chat" })).body;
		faux.setResponses([toolUse("send_to_user", { message: "One." })]);
		await say("first question", id);
		faux.setResponses([toolUse("send_to_user", { message: "Two." })]);
		await say("second question", id);
		const before = (await api(`/sessions/${id}/messages`)).body.messages.length;

		faux.setResponses([fauxAssistantMessage("The user asked two questions.")]);
		await runInDurableObject(env.Pim.getByName(OWNER), async (instance: Pim) => {
			const pi = await instance.harness.pi();
			const session = Number(instance.store.sessionOf(id));
			const conversation = (await pi.conversation(session as never, BACKGROUND_CONTEXT))!;
			// A threshold compaction, which a chat nearing its model's limit starts.
			const task = await conversation.commit(
				(tx) => tx.createTask(CompactionTask, { reason: "threshold" }, { ownership: { kind: "conversation" }, conversationId: session as never, background: true }),
				BACKGROUND_CONTEXT,
			);
			await pi.waitForTask(task, BACKGROUND_CONTEXT);
		});

		const continued = async () => (await api("/sessions")).body.sessions.find((session: { continuedFrom: string | null }) => session.continuedFrom === id);
		await vi.waitFor(async () => expect(await continued()).toMatchObject({ title: "Long chat", agent: { name: expect.any(String) } }));
		// The chat keeps all it said; the new one opens with the summary.
		expect((await api(`/sessions/${id}/messages`)).body.messages).toHaveLength(before);
		const next = (await continued()).id;
		// The chat that carries it on has taken its place in the list.
		const listed = (await api("/sessions")).body.sessions;
		expect(listed.find((session: { id: string }) => session.id === id).archived).toBe(true);
		expect(listed.find((session: { id: string }) => session.id === next).archived).toBe(false);
		await vi.waitFor(async () => {
			const { messages } = (await api(`/sessions/${next}/messages`)).body;
			expect(textOf(messages[0])).toContain("The user asked two questions.");
		});
	});

});

describe("appearance settings", () => {
	const put = (body: Record<string, unknown>) => api("/settings", { method: "PUT", body: JSON.stringify(body) });

	it("keeps the look of the app only when it is valid, tells open clients, and goes back to unset on null", async () => {
		expect((await api("/settings")).body).not.toHaveProperty("colorMode");
		const { socket, received } = await connect();
		try {
			const saved = await put({ colorMode: "dark", colorTheme: "dracula", locale: "es" });
			expect(saved.body).toMatchObject({ colorMode: "dark", colorTheme: "dracula", locale: "es" });
			await vi.waitFor(() => expect(received.some((message) => message.type === "settings")).toBe(true));
			expect((await api("/settings")).body).toMatchObject({ colorMode: "dark", colorTheme: "dracula", locale: "es" });

			for (const bad of [{ colorMode: "blue" }, { colorTheme: "no-such-theme" }, { colorTheme: 3 }, { locale: "xx" }, { locale: "es-ES" }]) {
				expect((await put(bad)).status).toBe(400);
			}
			// A refused update changes nothing, even beside a valid field.
			expect((await put({ colorMode: "light", locale: "xx" })).status).toBe(400);
			expect((await api("/settings")).body).toMatchObject({ colorMode: "dark", locale: "es" });

			const cleared = await put({ colorMode: null, colorTheme: null, locale: null });
			expect(cleared.body).not.toHaveProperty("colorMode");
			expect(cleared.body).not.toHaveProperty("colorTheme");
			expect(cleared.body).not.toHaveProperty("locale");
		} finally {
			socket.close();
		}
	});
});

describe("a slow or restarted space", () => {
	/** The structured lines the space logged with `method`, of one event. */
	const logged = (spy: { mock: { calls: unknown[][] } }, event: string) =>
		spy.mock.calls.flatMap(([line]) => (typeof line === "string" && line.startsWith("{") ? [JSON.parse(line)] : [])).filter((line) => line.event === event);

	it("answers while the gallery is stuck, with what it read before, reading it once", async () => {
		const before = (await api("/builtin-apps")).body;
		const warn = vi.spyOn(console, "warn");
		try {
			// The gallery answers nothing for 6 s, as a busy or stuck Durable Object would.
			let stuck = false;
			const unstuck = runInDurableObject(env.Gallery.getByName("gallery"), (_gallery, state) => {
				stuck = true;
				return state.blockConcurrencyWhile(() => new Promise((resolve) => setTimeout(resolve, 6_000)));
			});
			await vi.waitFor(() => expect(stuck).toBe(true));
			// Each request reads it again; none waits more than the 2 s bound, and after the first, none waits at all.
			const waited: number[] = [];
			for (let request = 0; request < 3; request++) {
				const started = Date.now();
				const { status, body } = await api("/builtin-apps");
				waited.push(Date.now() - started);
				expect(status).toBe(200);
				expect(body).toEqual(before);
			}
			expect(waited[0]).toBeGreaterThanOrEqual(1_900);
			expect(Math.max(...waited)).toBeLessThan(3_000);
			expect(waited[1]! + waited[2]!).toBeLessThan(1_000);
			expect(logged(warn, "pim.slow_refresh")).toEqual([{ event: "pim.slow_refresh", owner: OWNER, ms: 2_000, done: false }]);
			// The one read in flight ends once the gallery answers; the requests made no others meanwhile.
			await unstuck;
			await vi.waitFor(() => expect(logged(warn, "pim.slow_refresh").filter((line) => line.done)).toHaveLength(1), { timeout: 8_000 });
			expect(logged(warn, "pim.slow_refresh").find((line) => line.done).ms).toBeGreaterThan(2_000);
			expect((await api("/builtin-apps")).body).toEqual(before);
		} finally {
			warn.mockRestore();
		}
	});

	it("logs a request that takes more than 5 s, by its route, as it passes 5 s and as it ends", async () => {
		const { body: created } = await post("/sessions");
		const warn = vi.spyOn(console, "warn");
		try {
			faux.setResponses([
				async () => {
					await new Promise((resolve) => setTimeout(resolve, 5_500));
					return toolUse("send_to_user", { message: "Slowly." });
				},
			]);
			await say("Take your time.", created.id);
			const slow = logged(warn, "pim.slow_request");
			expect(slow).toEqual([
				{ event: "pim.slow_request", owner: OWNER, method: "POST", path: "/sessions/:session/messages", ms: expect.any(Number), status: null },
				{ event: "pim.slow_request", owner: OWNER, method: "POST", path: "/sessions/:session/messages", ms: expect.any(Number), status: 200 },
			]);
			expect(slow[1].ms).toBeGreaterThan(5_000);
			// Quick requests aren't logged.
			await api("/sessions");
			expect(logged(warn, "pim.slow_request")).toHaveLength(2);
		} finally {
			warn.mockRestore();
		}
	});

	it("closes a socket whose watch can't be restored as the space starts, so the app connects again", async () => {
		const { body: created } = await post("/sessions");
		const { socket, received } = await connect(created.id);
		await vi.waitFor(() => expect(received.some((message) => message.type === "events")).toBe(true));
		const closed = new Promise<CloseEvent>((resolve) => socket.addEventListener("close", resolve));
		const log = vi.spyOn(console, "log");
		try {
			await runInDurableObject(env.Pim.getByName(OWNER), async (instance: Pim) => {
				const session = instance.store.sessionOf(created.id);
				// The socket follows a chat whose events can't be read: its watch fails as the space starts again.
				for (const connection of instance.getConnections<{ session: string }>()) {
					if (connection.state?.session === session) connection.setState({ session: "999999" });
				}
				await instance.onStart();
			});
			expect(await closed).toMatchObject({ code: 4010, reason: "watch restore failed" });
			expect(logged(log, "pim.do_start")).toEqual([{ event: "pim.do_start", owner: OWNER, ms: expect.any(Number), watches: expect.any(Number) }]);
			expect(logged(log, "pim.do_start")[0].watches).toBeGreaterThanOrEqual(1);
		} finally {
			log.mockRestore();
		}
	});
});

describe("what a ui block holds", () => {
	const source = ["{@state volume = 3}", '<form id="quiz" submitLabel="Check">', '  <input name="city" label="Capital" answer="Lisbon" hint="h"/>', "</form>"].join("\n");
	const block = uiBlockId(source);
	const draft = { values: { volume: 7, "quiz.city": "Lis" }, revealed: {}, submitted: {} };
	const answered = {
		values: { volume: 7, "quiz.city": "Lisbon" },
		revealed: { quiz: true },
		submitted: { quiz: { values: { "quiz.city": "Lisbon" }, graded: { "quiz.city": true } } },
	};

	/** A chat whose agent sent the block, and the id of the message that did. */
	async function sent(message = `Try it:\n\n\`\`\`ui\n${source}\n\`\`\``) {
		faux.setResponses([toolUse("send_to_user", { message })]);
		const { id: session } = (await post("/sessions")).body;
		await say("Quiz me", session);
		const messages = (await api(`/sessions/${session}/messages`)).body.messages as TranscriptMessage[];
		const reply = messages.find((candidate) => candidate.parts.some((part) => part.type === "tool-call" && part.name === "send_to_user"))!;
		return { session, message: reply.id };
	}
	const put = (message: string, id: string, body: unknown) => api(`/messages/${message}/ui-state/${id}`, { method: "PUT", body: JSON.stringify(body) });

	it("keeps a block's state under its version, and reads it back with the message's other blocks", async () => {
		const { message } = await sent();
		expect((await api(`/messages/${message}/ui-state`)).body).toEqual({ blocks: {} });
		const first = await put(message, block, { version: 0, state: draft });
		expect(first).toMatchObject({ status: 200, body: { version: 1, submitted: false, state: draft } });
		const second = await put(message, block, { version: 1, state: { ...draft, values: { ...draft.values, "quiz.city": "Lisb" } } });
		expect(second.body.version).toBe(2);
		const { blocks } = (await api(`/messages/${message}/ui-state`)).body;
		expect(Object.keys(blocks)).toEqual([block]);
		expect(blocks[block]).toMatchObject({ version: 2, submitted: false, state: { values: { volume: 7, "quiz.city": "Lisb" } } });
	});

	it("answers a stale version with 409 and what is kept, and keeps it", async () => {
		const { message } = await sent();
		await put(message, block, { version: 0, state: draft });
		const stale = await put(message, block, { version: 0, state: answered });
		expect(stale.status).toBe(409);
		expect(stale.body.current).toMatchObject({ version: 1, submitted: false, state: draft });
		// A version from the future is as stale as one from the past.
		expect((await put(message, block, { version: 5, state: draft })).status).toBe(409);
		expect((await api(`/messages/${message}/ui-state`)).body.blocks[block].state).toEqual(draft);
	});

	it("refuses every write to a block once it is submitted", async () => {
		const { message } = await sent();
		const done = await put(message, block, { version: 0, state: answered, submitted: true });
		expect(done.body).toMatchObject({ version: 1, submitted: true });
		const after = await put(message, block, { version: 1, state: draft });
		expect(after.status).toBe(409);
		expect(after.body.current).toMatchObject({ version: 1, submitted: true, state: answered });
		expect((await put(message, block, { version: 1, state: answered, submitted: true })).status).toBe(409);
		// It can't be marked submitted with no form answered.
		const other = await sent();
		expect((await put(other.message, block, { version: 0, state: draft, submitted: true })).status).toBe(400);
	});

	it("takes only blocks the message has, and only the keys of the block", async () => {
		const { message } = await sent();
		expect((await put(message, "0000000000000a", { version: 0, state: draft })).status).toBe(404);
		for (const state of [
			{ values: { stranger: "x" } },
			{ values: { "quiz.nope": "x" } },
			{ revealed: { other: true } },
			{ revealed: { quiz: false } },
			{ submitted: { other: { values: {}, graded: {} } } },
			{ submitted: { quiz: { values: { "quiz.nope": "x" }, graded: {} } } },
			{ submitted: { quiz: { values: {}, graded: { "quiz.city": "yes" } } } },
			{ values: { volume: { nested: 1 } } },
			{ values: { volume: [[1]] } },
			{ values: { volume: Array.from({ length: 65 }, () => 1) } },
			{ values: { volume: "x".repeat(2001) } },
			{ extra: {} },
			[],
			"text",
		]) {
			expect((await put(message, block, { version: 0, state })).status, JSON.stringify(state).slice(0, 60)).toBe(400);
		}
		// A number can't be infinite: JSON has no such number, so it arrives as null at most.
		expect((await api(`/messages/${message}/ui-state/${block}`, { method: "PUT", body: '{"version":0,"state":{"values":{"volume":1e999}}}' })).status).toBe(400);
		expect((await put(message, block, { version: "0", state: draft })).status).toBe(400);
		expect((await api(`/messages/${message}/ui-state`)).body).toEqual({ blocks: {} });
		// Scalars and short lists are kept as they were.
		const kept = { values: { volume: [1, "two", null, true] }, revealed: {}, submitted: {} };
		expect((await put(message, block, { version: 0, state: kept })).body.state).toEqual(kept);
	});

	it("keeps a slider's and a checkbox's value outside a form, and refuses one they can't hold", async () => {
		const calculator = ["{@state seats = 8}", '<slider name="seats" min={1} max={50}/>', '<checkbox name="annual"/>', "{@let price = seats * 29}", "{price}"].join("\n");
		const { message } = await sent(`Try it:\n\n\`\`\`ui\n${calculator}\n\`\`\``);
		const id = uiBlockId(calculator);
		const state = (values: Record<string, unknown>) => ({ values, revealed: {}, submitted: {} });
		expect((await put(message, id, { version: 0, state: state({ seats: 12, annual: true }) })).body).toMatchObject({ version: 1, state: state({ seats: 12, annual: true }) });
		for (const values of [{ seats: "12" }, { seats: 51 }, { seats: 0.5 }, { annual: "true" }, { annual: 1 }]) {
			expect((await put(message, id, { version: 1, state: state(values) })).status, JSON.stringify(values)).toBe(400);
		}
	});

	it("keeps a block's state to 32 KB", async () => {
		const many = (long: number) => ({ values: { volume: "x".repeat(long), "quiz.city": "y".repeat(long) }, revealed: {}, submitted: {} });
		const { message } = await sent();
		// 2 x 2000 characters is well within; what pushes past 32 KB is the many answers a form keeps.
		const lists = (items: number) => ({
			values: Object.fromEntries([["volume", Array.from({ length: 64 }, () => "z".repeat(2000))]]),
			revealed: {},
			submitted: { quiz: { values: { "quiz.city": Array.from({ length: items }, () => "z".repeat(2000)) }, graded: {} } },
		});
		expect((await put(message, block, { version: 0, state: many(2000) })).status).toBe(200);
		const tooBig = await put(message, block, { version: 1, state: lists(64) });
		expect(tooBig.status).toBe(400);
		expect(tooBig.body.error).toContain("32768 bytes");
		expect((await api(`/messages/${message}/ui-state`)).body.blocks[block].version).toBe(1);
	});

	it("tells its blocks apart by their source, in a message that has several", async () => {
		const other = '<form id="two"><input name="a" label="A" answer="1" hint="h"/></form>';
		const { message } = await sent(`\`\`\`ui\n${source}\n\`\`\`\n\nAnd:\n\n\`\`\`ui\n${other}\n\`\`\``);
		const second = uiBlockId(other);
		expect((await put(message, second, { version: 0, state: { values: { "two.a": "1" } } })).status).toBe(200);
		expect((await put(message, second, { version: 0, state: { values: { "two.a": "2" } } })).status).toBe(409);
		expect((await put(message, block, { version: 0, state: { values: { "two.a": "1" } } })).status).toBe(400);
		expect((await put(message, block, { version: 0, state: draft })).status).toBe(200);
	});

	it("tells two blocks of one source apart: the first keeps the id it always had, the next ones take a number", async () => {
		const { message, session } = await sent(`\`\`\`ui\n${source}\n\`\`\`\n\nAgain:\n\n\`\`\`ui\n${source}\n\`\`\`\n\nAnd once more, with other spacing:\n\n\`\`\`ui\n\n${source}\n\n\`\`\``);
		const ids = [block, `${block}-1`, `${block}-2`];
		expect(uiBlockIds([source, source, ` ${source} `])).toEqual(ids);
		// What the agent was told when it sent them.
		const result = JSON.parse(
			((await api(`/sessions/${session}/messages`)).body.messages as TranscriptMessage[])
				.flatMap((candidate) => candidate.parts.flatMap((part) => (part.type === "tool-result" && part.name === "send_to_user" ? [part.content.map((content) => (content.type === "text" ? content.text : "")).join("")] : [])))
				.at(-1)!,
		) as { uiBlocks: { id: string }[] };
		expect(result.uiBlocks.map((entry) => entry.id)).toEqual(ids);
		// Each is kept apart.
		expect((await put(message, ids[0]!, { version: 0, state: draft })).status).toBe(200);
		expect((await put(message, ids[1]!, { version: 0, state: answered, submitted: true })).status).toBe(200);
		// A second write to the first finds only its own version; the second's submission locks only the second.
		expect((await put(message, ids[0]!, { version: 1, state: { ...draft, values: { ...draft.values, "quiz.city": "Li" } } })).status).toBe(200);
		expect((await put(message, ids[1]!, { version: 1, state: draft })).status).toBe(409);
		expect((await put(message, ids[2]!, { version: 0, state: draft })).status).toBe(200);
		const { blocks } = (await api(`/messages/${message}/ui-state`)).body;
		expect(Object.keys(blocks).sort()).toEqual([...ids].sort());
		expect(blocks[ids[0]!]).toMatchObject({ version: 2, submitted: false });
		expect(blocks[ids[1]!]).toMatchObject({ version: 1, submitted: true });
		// There is no fourth.
		expect((await put(message, `${block}-3`, { version: 0, state: draft })).status).toBe(404);
		expect((await put(message, `${block}-0`, { version: 0, state: draft })).status).toBe(404);
	});

	it("doesn't count a fence that only shows one, or one of another language, as a block", async () => {
		const { message } = await sent(`\`\`\`\`md\n\`\`\`ui\n${source}\n\`\`\`\n\`\`\`\`\n\n\`\`\`ui-response\n{"block":"x","values":{},"graded":{}}\n\`\`\`\n\n\`\`\`ui\n${source}\n\`\`\``);
		expect((await put(message, block, { version: 0, state: draft })).status).toBe(200);
		expect((await put(message, `${block}-1`, { version: 0, state: draft })).status).toBe(404);
	});

	describe("read back by the agent with ui_state", () => {
		const calculator = ["{@state seats = 8}", '<slider name="seats" min={1} max={50}/>', '<checkbox name="annual"/>', "{seats}"].join("\n");
		const fenced = (body: string) => `Try it:\n\n\`\`\`ui\n${body}\n\`\`\``;
		const resultsOf = async (session: string, tool: string) =>
			((await api(`/sessions/${session}/messages`)).body.messages as TranscriptMessage[]).flatMap((message) =>
				message.parts.flatMap((part) => (part.type === "tool-result" && part.name === tool ? [part.content.map((content) => (content.type === "text" ? content.text : "")).join("")] : [])),
			);
		/** The agent of `session` calls ui_state with these arguments; what it was told comes back. */
		async function asks(session: string, args: Record<string, string>) {
			faux.setResponses([toolUse("ui_state", args), toolUse("send_to_user", { message: "Looked." })]);
			await say("What did I change?", session);
			return (await resultsOf(session, "ui_state")).at(-1)!;
		}

		it("tells the agent the message and block ids when it sends a block, and returns what the person set", async () => {
			const { session, message } = await sent(fenced(calculator));
			const id = uiBlockId(calculator);
			const told = JSON.parse((await resultsOf(session, "send_to_user"))[0]!) as { message: string; uiBlocks: { id: string; label: string }[] };
			expect(told).toMatchObject({ sent: "Sent.", message, uiBlocks: [{ id, label: "seats: 8" }] });
			// Nothing changed yet.
			expect(JSON.parse(await asks(session, { message }))).toMatchObject({ blocks: [{ block: id, values: {}, submitted: false, updatedAt: null }] });
			const state = { values: { seats: 12, annual: true }, revealed: {}, submitted: {} };
			await put(message, id, { version: 0, state });
			const read = JSON.parse(await asks(session, { message, block: id }));
			expect(read.blocks).toEqual([{ block: id, label: "seats: 8", values: { seats: 12, annual: true }, submitted: false, submittedForms: [], updatedAt: expect.stringMatching(/^20\d\d-/) }]);
			expect(read.summary).toContain("seats = 12, annual = true");
		});

		it("reports a submitted form's id and a title", async () => {
			const { session, message } = await sent();
			await put(message, block, { version: 0, state: answered, submitted: true });
			const read = JSON.parse(await asks(session, { message }));
			expect(read.blocks[0]).toMatchObject({ block, label: "form quiz", submitted: true, submittedForms: ["quiz"], values: { volume: 7, "quiz.city": "Lisbon" } });
		});

		it("denies a message of another chat or space, or none, and finds no blocks in the person's own words", async () => {
			const first = await sent();
			const other = await sent();
			expect(await asks(first.session, { message: other.message })).toBe(`No message ${other.message} in this chat.`);
			const person = ((await api(`/sessions/${first.session}/messages`)).body.messages as TranscriptMessage[]).find((candidate) => candidate.role === "user")!;
			// The person's own words draw no blocks, so there is nothing to read.
			expect(await asks(first.session, { message: person.id })).toBe("That message has no ui blocks.");
			for (const message of ["999999999", "nope", "0"]) expect(await asks(first.session, { message })).toBe(`No message ${message} in this chat.`);
			expect(await asks(first.session, { message: first.message, block: "0000000000000a" })).toContain("has no ui block 0000000000000a");
			// A chat in someone else's space: its message id means nothing here, and a stranger's state isn't read.
			const directory = env.Directory.getByName("directory");
			const registered = await directory.register({ username: "stranger", ip: "192.0.2.7", policy: { mode: "open", maxAccounts: null, perAddressPerDay: 100 } });
			if (!registered.ok) throw new Error(registered.error);
			const stranger = registered.account.ownerId;
			await directory.activate(stranger);
			await (await getAgentByName(env.Pim, stranger)).provision({ ownerId: stranger, username: "stranger" });
			const theirToken = (await env.Auth.getByName(stranger).createToken(stranger, "tests", Date.now())).token;
			const theirs = async (path: string, init: RequestInit = {}) =>
				(await exports.default.fetch(new Request(apiUrl(path), { ...init, headers: { Authorization: `Bearer ${theirToken}`, "content-type": "application/json" } }))).json() as Promise<any>;
			faux.setResponses([toolUse("send_to_user", { message: fenced(calculator) })]);
			const chat = (await theirs("/sessions", { method: "POST", body: "{}" })).id;
			await theirs(`/sessions/${chat}/messages`, { method: "POST", body: JSON.stringify({ content: "Hi", wait: true }) });
			const theirMessage = ((await theirs(`/sessions/${chat}/messages`)).messages as TranscriptMessage[]).find((candidate) => candidate.parts.some((part) => part.type === "tool-call" && part.name === "send_to_user"))!;
			expect(await asks(first.session, { message: theirMessage.id })).toBe(`No message ${theirMessage.id} in this chat.`);
		});

		it("cuts a large result to fit, and offers a block by its id", async () => {
			const long = Array.from({ length: 6 }, (_, index) => `{@state note${index} = ""}`).join("\n") + "\n{note0}";
			const { session, message } = await sent(fenced(long));
			const id = uiBlockId(long);
			const values = Object.fromEntries(Array.from({ length: 6 }, (_, index) => [`note${index}`, "n".repeat(1900)]));
			expect((await put(message, id, { version: 0, state: { values, revealed: {}, submitted: {} } })).status).toBe(200);
			const read = await asks(session, { message });
			expect(read.length).toBeLessThanOrEqual(8000);
			const parsed = JSON.parse(read);
			expect(parsed.note).toContain("Cut to fit");
			expect(Object.keys(parsed.blocks[0].values).length).toBeLessThan(6);
		});

		it("has no way to write: the tool takes no state, and the person's block is the same after", async () => {
			const { session, message } = await sent(fenced(calculator));
			const id = uiBlockId(calculator);
			const state = { values: { seats: 3 }, revealed: {}, submitted: {} };
			await put(message, id, { version: 0, state });
			await asks(session, { message, block: id, values: JSON.stringify({ seats: 40 }) } as Record<string, string>);
			expect((await api(`/messages/${message}/ui-state`)).body.blocks[id]).toMatchObject({ version: 1, state });
			const tools = (await import("../src/extensions/messaging")).messagingExtension({} as never).tools!.find((tool) => tool.name === "ui_state")!;
			expect(Object.keys((tools.parameters as { properties: object }).properties)).toEqual(["message", "block"]);
		});
	});

	it("knows no message that isn't an agent's with a block in a chat of the person's", async () => {
		const { session, message } = await sent();
		const person = (await api(`/sessions/${session}/messages`)).body.messages.find((candidate: TranscriptMessage) => candidate.role === "user");
		expect((await put(person.id, block, { version: 0, state: draft })).status).toBe(404);
		for (const id of ["nope", "0", "999999999", "1.5"]) expect((await api(`/messages/${id}/ui-state`)).status).toBe(404);
		expect((await api(`/messages/${message}/ui-state/${block}`)).status).toBe(405);
		// Without the token nothing is read or written.
		const bare = await exports.default.fetch(apiUrl(`/messages/${message}/ui-state/${block}`), { method: "PUT", body: JSON.stringify({ version: 0, state: draft }) });
		expect(bare.status).toBe(401);
		expect((await exports.default.fetch(apiUrl(`/messages/${message}/ui-state`))).status).toBe(401);
		// A deleted chat's messages are gone.
		await put(message, block, { version: 0, state: draft });
		expect((await api(`/sessions/${session}`, { method: "DELETE" })).status).toBe(200);
		expect((await api(`/messages/${message}/ui-state`)).status).toBe(404);
		expect((await put(message, block, { version: 1, state: draft })).status).toBe(404);
	});
});
