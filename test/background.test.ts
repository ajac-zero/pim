import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { CompactionTask } from "@earendil-works/pi-durable";
import { env, runInDurableObject } from "cloudflare:test";
import type { JsonValue } from "@earendil-works/pi-ai";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { DELIVERY_REMINDER } from "../src/transcript";
import { api, connect, lastUserText, messagesOf, OWNER, post, ROOT, say, settled, toolUse, triggersOn, widgetsShown } from "./helpers";
import { faux, outbox, type Pim, triggerClock } from "./worker";

const SECOND = 1_000;
const MINUTE = 60 * SECOND;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

const inSpace = <T>(work: (pim: Pim) => T | Promise<T>) => runInDurableObject(env.Pim.getByName(OWNER), work);

/** Runs the triggers' engine as the space's wake would at `at`, on the triggers' clock. */
async function tickAt(at: number) {
	triggerClock.offset = at - Date.now();
	await inSpace((pim) => pim.runTriggerTick());
}

/** A scheduled task's runs, newest first, as the triggers' API shows them. */
const runsOf = async (id: string) => (await api(`/triggers/${encodeURIComponent(id)}/runs`)).body.runs as { state: string; chatId: string | null; dueAt: number }[];

/** Ticks on, from `at`, until each of a task's runs is known to have ended, as the wake would. */
async function finish(id: string, at: number) {
	await tickAt(at);
	await vi.waitFor(
		async () => {
			await tickAt(Date.now() + triggerClock.offset + 2 * MINUTE);
			expect((await runsOf(id)).filter((run) => !["completed", "failed", "cancelled"].includes(run.state))).toEqual([]);
		},
		{ timeout: 10_000, interval: 200 },
	);
}

/** Has the agent of `chat` call one tool, and gives back what it answered. */
async function toolResult(name: string, args: Record<string, JsonValue>, chat = ROOT): Promise<{ text: string; isError: boolean }> {
	let result = { text: "", isError: false };
	faux.setResponses([
		toolUse(name, args),
		(context) => {
			const answer = context.messages.findLast((message) => message.role === "toolResult");
			if (answer?.role === "toolResult") result = { text: answer.content.flatMap((part) => (part.type === "text" ? [part.text] : [])).join(""), isError: answer.isError === true };
			return toolUse("send_to_user", { message: "Done." });
		},
	]);
	await say(`Please use ${name}.`, chat);
	return result;
}

describe("scheduled tasks", () => {
	beforeAll(() => triggersOn());
	afterEach(() => {
		triggerClock.offset = 0;
	});

	it("schedules work for later as a trigger, which fires it into the same chat with its notification", async () => {
		const before = Date.now();
		const made = await toolResult("schedule_task", { instruction: "Check whether the flight price dropped.", label: "Flight check", delay_seconds: 3600 });
		expect(made.isError).toBe(false);
		const task = JSON.parse(made.text);
		expect(task).toEqual({ id: expect.any(String), type: "scheduled", next: expect.any(String), session: ROOT, label: "Flight check", instruction: "Check whether the flight price dropped.", newChat: false });
		const next = Date.parse(task.next);
		expect(next).toBeGreaterThanOrEqual(before + 3_599_000);
		expect(next).toBeLessThanOrEqual(Date.now() + 3_601_000);
		expect((await api("/schedules")).body.schedules).toEqual([task]);
		// It is a time trigger of the chat's agent, enabled, which the person sees among their triggers.
		const majordomo = ((await api("/agents")).body.agents as { id: string; majordomo: boolean }[]).find((agent) => agent.majordomo)!.id;
		expect((await api(`/triggers/${task.id}`)).body).toMatchObject({
			lifecycle: "enabled",
			agentId: majordomo,
			label: "Flight check",
			source: { kind: "time", schedule: "once", at: next },
			destination: { type: "existing_chat", chatId: ROOT },
		});

		// Not before its time.
		await tickAt(next - MINUTE);
		expect(await runsOf(task.id)).toEqual([]);
		// At its time the engine hands it to the chat, which reads it as a scheduled task: work Pim gave itself may stay silent, so no reminder to reply.
		let woken = "";
		faux.setResponses([
			(context) => {
				woken = lastUserText(context.messages);
				return fauxAssistantMessage("Same price.");
			},
		]);
		await tickAt(next + SECOND);
		await settled(ROOT);
		expect(woken).toBe(`[Scheduled task "Flight check" ${task.id}] Check whether the flight price dropped.`);
		expect(await runsOf(task.id)).toEqual([expect.objectContaining({ chatId: ROOT, dueAt: next })]);
		// The person sees that it ran, once, with a link to the chat it ran in.
		await finish(task.id, next + MINUTE);
		const ran = (await api("/notifications")).body.notifications.filter((notification: { kind: string }) => notification.kind === "scheduled");
		expect(ran).toEqual([expect.objectContaining({ session: ROOT, kind: "scheduled", title: "Flight check", body: "", readAt: null })]);
		await post(`/notifications/${ran[0].id}/read`);
		// Fired once, it is done.
		expect((await api(`/triggers/${task.id}`)).body.lifecycle).toBe("ended");
		expect((await api("/schedules")).body.schedules).toEqual([]);
	});

	it("starts a new chat with the same agent each time a new-chat cron task fires, in UTC", async () => {
		const coach = (await post("/agents", { name: "Coach", instructions: "Coach me." })).body;
		const origin = (await post("/sessions", { agent: coach.id, title: "Training" })).body.id;
		const made = await toolResult("schedule_task", { instruction: "Write today's training plan.", label: "Daily plan", cron: "0 9 * * *", new_chat: true }, origin);
		const task = JSON.parse(made.text);
		expect(task).toMatchObject({ type: "cron", cron: "0 9 * * *", session: origin, newChat: true, label: "Daily plan" });
		expect(task).not.toHaveProperty("agent");
		const next = Date.parse(task.next);
		expect(new Date(next).getUTCHours()).toBe(9);
		expect(next - Date.now()).toBeLessThanOrEqual(DAY);
		expect((await api(`/triggers/${task.id}`)).body).toMatchObject({ agentId: coach.id, source: { schedule: "cron", expression: "0 9 * * *", timeZone: "UTC" }, destination: { type: "new_chat" } });
		const originLength = (await api(`/sessions/${origin}/messages`)).body.messages.length;

		faux.setResponses([fauxAssistantMessage("Day one.")]);
		await tickAt(next + SECOND);
		const [first] = await runsOf(task.id);
		await settled(first!.chatId!);
		await finish(task.id, next + MINUTE);
		expect((await api(`/sessions/${origin}/messages`)).body.messages).toHaveLength(originLength);

		// Deleting the chat that scheduled it leaves it running.
		expect((await api(`/sessions/${origin}`, { method: "DELETE" })).status).toBe(200);
		expect((await api("/schedules")).body.schedules).toMatchObject([{ id: task.id }]);
		faux.setResponses([fauxAssistantMessage("Day two.")]);
		await tickAt(next + DAY + SECOND);
		const [second] = await runsOf(task.id);
		expect(second!.dueAt).toBe(next + DAY);
		await settled(second!.chatId!);
		await finish(task.id, next + DAY + MINUTE);
		// The agent's chats still show it coming up, without a link to the deleted chat.
		const [upcoming] = await widgetsShown((await post("/sessions", { agent: coach.id })).body.id, ["pim.schedule/upcoming"]);
		expect(upcoming.items).toEqual([{ title: "Daily plan", time: expect.any(String) }]);

		const chats = (await api("/sessions")).body.sessions.filter((session: { title: string }) => session.title === "Daily plan");
		expect(chats.map((chat: { id: string }) => chat.id).sort()).toEqual([first!.chatId, second!.chatId].sort());
		// Each run's notification links to the chat it started.
		const ran = (await api("/notifications")).body.notifications.filter((notification: { title: string }) => notification.title === "Daily plan");
		expect(ran.map((notification: { session: string }) => notification.session).sort()).toEqual(chats.map((chat: { id: string }) => chat.id).sort());
		for (const notification of ran) await post(`/notifications/${notification.id}/read`);
		for (const chat of chats) {
			expect(chat.agent).toMatchObject({ id: coach.id });
			expect(await messagesOf(chat.id, "user")).toEqual([`[Scheduled task "Daily plan" ${task.id}] Write today's training plan.`]);
		}
		expect((await api(`/schedules/${task.id}`, { method: "DELETE" })).status).toBe(200);
		expect((await api(`/triggers/${task.id}`)).body.lifecycle).toBe("deleted");
	});

	it("lets only the majordomo schedule new chats with another agent", async () => {
		const scout = (await post("/agents", { name: "Scout", instructions: "Find things to do in NYC." })).body;
		const coach = (await post("/agents", { name: "Fitness coach", instructions: "Coach me." })).body;
		const training = (await post("/sessions", { agent: coach.id, title: "Training" })).body.id;
		const refused = await toolResult("schedule_task", { instruction: "Find this weekend's events.", cron: "0 9 * * 5", agent: scout.id }, training);
		expect(refused).toEqual({ isError: true, text: expect.stringContaining("Only the majordomo schedules work for other agents") });
		expect((await toolResult("schedule_task", { instruction: "Find events.", cron: "0 9 * * 5", agent: "no-such-agent" })).text).toContain("No agent has the id no-such-agent");
		expect((await api("/schedules")).body.schedules).toEqual([]);

		const made = await toolResult("schedule_task", { instruction: "Find this weekend's events.", label: "Weekend events", cron: "0 9 * * 5", agent: scout.id });
		const task = JSON.parse(made.text);
		expect(task).toMatchObject({ session: ROOT, newChat: true, agent: scout.id });
		expect((await api(`/triggers/${task.id}`)).body).toMatchObject({ agentId: scout.id, destination: { type: "new_chat" } });
		// Scout's chats show it coming up, since Scout does the work, and Coach's don't.
		for (const [agent, shown] of [
			[scout.id, 1],
			[coach.id, 0],
		] as const) {
			const [upcoming] = await widgetsShown((await post("/sessions", { agent })).body.id, ["pim.schedule/upcoming"]);
			expect(upcoming.items).toHaveLength(shown);
		}

		faux.setResponses([fauxAssistantMessage("Found three.")]);
		await tickAt(Date.parse(task.next) + SECOND);
		const [run] = await runsOf(task.id);
		await settled(run!.chatId!);
		await finish(task.id, Date.parse(task.next) + MINUTE);
		const [chat] = (await api("/sessions")).body.sessions.filter((session: { title: string }) => session.title === "Weekend events");
		expect(chat).toMatchObject({ id: run!.chatId, agent: { id: scout.id } });
		expect(await messagesOf(chat.id, "user")).toEqual([`[Scheduled task "Weekend events" ${task.id}] Find this weekend's events.`]);
		for (const notification of (await api("/notifications")).body.notifications.filter((notification: { session: string }) => notification.session === chat.id)) await post(`/notifications/${notification.id}/read`);
		expect((await api(`/schedules/${task.id}`, { method: "DELETE" })).status).toBe(200);
	});

	it("rejects ambiguous or past times without scheduling anything", async () => {
		let results = "";
		faux.setResponses([
			fauxAssistantMessage(
				[
					fauxToolCall("schedule_task", { instruction: "x", delay_seconds: 60, cron: "0 9 * * *" }),
					fauxToolCall("schedule_task", { instruction: "x", at: "2001-01-01T00:00:00Z" }),
					fauxToolCall("schedule_task", { instruction: "x", at: new Date(Date.now() - MINUTE).toISOString() }),
					fauxToolCall("schedule_task", { instruction: "x", at: "next tuesday" }),
				],
				{ stopReason: "toolUse" },
			),
			(context) => {
				results = JSON.stringify(context.messages.filter((message) => message.role === "toolResult"));
				return toolUse("send_to_user", { message: "Those times aren't valid." });
			},
		]);
		await say("Remind me.");
		expect(results).toContain("exactly one of delay_seconds, at, or cron");
		expect(results.split("is in the past")).toHaveLength(3);
		expect(results).toContain('Cannot read \\"next tuesday\\" as a date');
		expect((await api("/schedules")).body.schedules).toEqual([]);
		expect((await api("/triggers?sourceKind=time&lifecycle=enabled")).body.triggers).toEqual([]);
	});

	it("lists and cancels only the caller's own scheduled tasks, by id, and the majordomo's every one", async () => {
		const helper = (await post("/agents", { name: "Helper", instructions: "Help." })).body;
		const chat = (await post("/sessions", { agent: helper.id })).body.id;
		const at = new Date(Date.now() + 2 * HOUR).toISOString();
		const helpers = JSON.parse((await toolResult("schedule_task", { instruction: "Water the plants.", at }, chat)).text);
		expect(helpers).toMatchObject({ type: "scheduled", next: at, label: null, session: chat });
		const mine = JSON.parse((await toolResult("schedule_task", { instruction: "Pay rent.", label: "Rent", cron: "0 8 1 * *" })).text);
		// Another kind of trigger is no scheduled task.
		const draft = (await post("/triggers", { label: "Fares", instruction: "Check fares.", source: { kind: "time", schedule: "cron", expression: "0 7 * * *", timeZone: "Europe/Lisbon" } })).body;

		expect(JSON.parse((await toolResult("list_scheduled_tasks", {}, chat)).text)).toEqual([helpers]);
		expect(JSON.parse((await toolResult("list_scheduled_tasks", {})).text)).toEqual([helpers, mine]);
		// Helper can't see, or cancel, the majordomo's, nor a trigger that isn't enabled and on time.
		expect(await toolResult("cancel_scheduled_task", { id: mine.id }, chat)).toEqual({ isError: true, text: `No scheduled task with id ${mine.id}.` });
		expect(await toolResult("cancel_scheduled_task", { id: "nope" }, chat)).toEqual({ isError: true, text: "No scheduled task with id nope." });
		expect(await toolResult("cancel_scheduled_task", { id: helpers.id }, chat)).toEqual({ isError: false, text: "Cancelled." });
		expect((await api(`/triggers/${helpers.id}`)).body.lifecycle).toBe("deleted");
		expect(await toolResult("cancel_scheduled_task", { id: helpers.id }, chat)).toEqual({ isError: true, text: `No scheduled task with id ${helpers.id}.` });
		expect(JSON.parse((await toolResult("list_scheduled_tasks", {}, chat)).text)).toEqual([]);
		expect(await toolResult("cancel_scheduled_task", { id: mine.id })).toEqual({ isError: false, text: "Cancelled." });
		expect(JSON.parse((await toolResult("list_scheduled_tasks", {})).text)).toEqual([]);
		expect((await api(`/triggers/${draft.id}`)).body.lifecycle).toBe("draft");
		await api(`/triggers/${draft.id}`, { method: "DELETE" });
	});

	it("makes one task of a call replayed after an eviction, for the time its first run worked out", async () => {
		const made = await inSpace(async (pim) => {
			const tool = pim.registry.snapshot().extension("pim.schedule")!.tools!.find((candidate) => candidate.name === "schedule_task")!;
			const memos = new Map<string, unknown>();
			// The same durable call twice, with its memos kept between, as pi replays a tool call.
			const call = {
				conversationId: Number(pim.store.sessionOf(ROOT)),
				taskId: "task-replayed",
				callId: "call-1",
				memo: async (name: string, ...rest: unknown[]) => {
					if (rest.length === 2 && !memos.has(name)) memos.set(name, rest[0]);
					return memos.get(name);
				},
			} as never;
			const args = { instruction: "Stretch.", label: "Stretch", delay_seconds: 600 } as never;
			const read = (result: { content?: readonly { type: string; text?: string }[] }) => JSON.parse(result.content![0]!.text!);
			const first = read(await tool.execute(args, call, undefined as never));
			// Replayed five minutes on: the same task, at the same time, not five minutes later.
			triggerClock.offset = 5 * MINUTE;
			const again = read(await tool.execute(args, call, undefined as never));
			const other = read(await tool.execute(args, { ...(call as object), taskId: "task-other", memo: async (_name: string, ...rest: unknown[]) => rest[0] } as never, undefined as never));
			return { first, again, other };
		});
		expect(made.again).toEqual(made.first);
		expect(made.other.id).not.toBe(made.first.id);
		expect(Date.parse(made.other.next) - Date.parse(made.first.next)).toBeGreaterThanOrEqual(5 * MINUTE - SECOND);
		expect(((await api("/schedules")).body.schedules as { id: string }[]).map((task) => task.id).sort()).toEqual([made.first.id, made.other.id].sort());
		for (const id of [made.first.id, made.other.id]) expect((await api(`/schedules/${id}`, { method: "DELETE" })).status).toBe(200);
	});

	it("hands work to the chat that carries on the chat that scheduled it, once that chat grew too long", async () => {
		const { id } = (await post("/sessions", {})).body;
		faux.setResponses([toolUse("schedule_task", { instruction: "Check in.", delay_seconds: 3600 }), toolUse("send_to_user", { message: "Will do." })]);
		await say("Remind me.", id);
		faux.setResponses([fauxAssistantMessage("The person asked for a reminder.")]);
		await inSpace(async (instance) => {
			const pi = await instance.harness.pi();
			const conversation = Number(instance.store.sessionOf(id));
			const compaction = await (await pi.conversation(conversation as never, BACKGROUND_CONTEXT))!.commit(
				(tx) => tx.createTask(CompactionTask, { reason: "threshold" }, { ownership: { kind: "conversation" }, conversationId: conversation as never, background: true }),
				BACKGROUND_CONTEXT,
			);
			await pi.waitForTask(compaction, BACKGROUND_CONTEXT);
		});
		const carried = async () => (await api("/sessions")).body.sessions.find((chat: { continuedFrom: string | null }) => chat.continuedFrom === id)?.id;
		await vi.waitFor(async () => expect(await carried()).toBeDefined());
		const next = await carried();

		const [task] = (await api("/schedules")).body.schedules.filter((scheduled: { session: string }) => scheduled.session === id);
		faux.setResponses([fauxAssistantMessage("Hello again.")]);
		await tickAt(Date.parse(task.next) + SECOND);
		await vi.waitFor(async () => expect((await messagesOf(next, "user")).some((text) => text.includes("Check in."))).toBe(true));
		expect((await messagesOf(id, "user")).some((text) => text.includes("Check in."))).toBe(false);
		await settled(next);
		await finish(task.id, Date.parse(task.next) + MINUTE);
		const note = (await api("/notifications")).body.notifications.find((note: { session: string }) => note.session === next);
		expect(note).toMatchObject({ kind: "scheduled", title: "Check in." });
		await post(`/notifications/${note.id}/read`);
	});
});

describe("sending to the person", () => {
	it("replies with what Pim sent, not with its notes", async () => {
		faux.setResponses([
			fauxAssistantMessage(
				[
					{ type: "text", text: "Private working notes." },
					fauxToolCall("send_to_user", { message: "On it." }),
					fauxToolCall("send_to_user", { message: "Your flight is **$80** cheaper." }),
				],
				{ stopReason: "toolUse" },
			),
		]);
		const { body } = await post(`/sessions/${ROOT}/messages`, { content: "How's the flight price?", wait: true });
		expect(body).toMatchObject({ status: "done", text: "On it.\n\nYour flight is **$80** cheaper.", replies: ["On it.", "Your flight is **$80** cheaper."] });
		// A reply is not a notification.
		expect((await api("/notifications?unread=true")).body.notifications).toEqual([]);

		// Private final text prompts an explicit send; it is never passed off as the answer.
		faux.setResponses([
			fauxAssistantMessage("Private draft: same as before."),
			(context) => {
				expect(lastUserText(context.messages)).toBe(DELIVERY_REMINDER);
				return toolUse("send_to_user", { message: "Same as before." });
			},
		]);
		const forgot = await post(`/sessions/${ROOT}/messages`, { content: "And now?", wait: true });
		expect(forgot.body).toMatchObject({ status: "done", replies: ["Same as before."] });
	});

	it("requires a completing send after a progress update, with or without further tools", async () => {
		for (const work of [[], [toolUse("current_time", {})]]) {
			faux.setResponses([
				toolUse("send_to_user", { message: "I'll check.", complete: false }),
				...work,
				fauxAssistantMessage("Private draft answer."),
				toolUse("send_to_user", { message: "Here's the answer." }),
			]);
			const answer = await post(`/sessions/${ROOT}/messages`, { content: "Check for me.", wait: true });
			expect(answer.body).toMatchObject({ status: "done", replies: ["I'll check.", "Here's the answer."] });
		}
	});

	it("bounds delivery corrections and never exposes private text as a fallback", async () => {
		faux.setResponses([
			fauxAssistantMessage("Private first answer."),
			fauxAssistantMessage("Still private."),
			fauxAssistantMessage("Private third answer."),
		]);
		const failed = await post(`/sessions/${ROOT}/messages`, { content: "Answer me.", wait: true });
		expect(failed.body).toMatchObject({ status: "unanswered", replies: [] });
		expect(failed.body).not.toHaveProperty("text");
		// A new user turn gets a fresh correction budget, not the previous turn's reminders.
		faux.setResponses([
			fauxAssistantMessage("Another private draft."),
			toolUse("send_to_user", { message: "A delivered answer." }),
		]);
		expect((await post(`/sessions/${ROOT}/messages`, { content: "Try again.", wait: true })).body).toMatchObject({ status: "done", replies: ["A delivered answer."] });
	});

	it("emails the person at the address they confirmed, and only there", async () => {
		const sendEmail = () =>
			faux.setResponses([
				toolUse("send_to_user", { channel: "email", title: "Your week", message: "3 workouts, 1 flight booked." }),
			]);
		let emailed = "";

		// No address yet: nothing is sent, and the model is told why.
		sendEmail();
		faux.appendResponses([
			(context) => {
				emailed = JSON.stringify(context.messages.at(-1));
				return toolUse("send_to_user", { message: "Add an email address first." });
			},
		]);
		const unsent = await post(`/sessions/${ROOT}/messages`, { content: "Email me my week.", wait: true });
		expect(emailed).toContain("hasn't added an email address");
		expect(outbox).toEqual([]);
		// A failed email cannot finish the turn: an explicit chat message explains why.
		expect(unsent.body).toMatchObject({ status: "done", replies: ["Add an email address first."] });

		// Confirming an address takes the code Pim emails there.
		expect((await api("/email")).body).toEqual({ available: true, address: null, pending: null });
		expect((await api("/email", { method: "PUT", body: JSON.stringify({ address: "not an address" }) })).status).toBe(400);
		const started = await api("/email", { method: "PUT", body: JSON.stringify({ address: "ada@example.com" }) });
		expect(started.body).toEqual({ available: true, address: null, pending: "ada@example.com" });
		const [codeMail] = outbox.splice(0);
		expect(codeMail).toMatchObject({ to: "ada@example.com" });
		const code = codeMail!.subject.slice(0, 6);
		const wrong = code === "000000" ? "000001" : "000000";
		expect((await post("/email/confirm", { code: wrong })).status).toBe(400);
		expect((await post("/email/confirm", { code })).body).toEqual({ available: true, address: "ada@example.com", pending: null });

		sendEmail();
		const sent = await post(`/sessions/${ROOT}/messages`, { content: "Email me my week.", wait: true });
		expect(JSON.stringify((await api(`/sessions/${ROOT}/messages`)).body.messages)).toContain("Emailed it to ada@example.com.");
		expect(outbox).toEqual([
			{ to: "ada@example.com", subject: "Your week", text: `3 workouts, 1 flight booked.\n\n—\nFrom your Pim: https://pim.test/chat/${ROOT}` },
		]);
		// The chat shows it was emailed; it is not a reply in the conversation.
		expect(sent.body).toMatchObject({ status: "done", replies: [] });
		outbox.splice(0);

		expect((await api("/email", { method: "DELETE" })).body).toEqual({ available: true, address: null, pending: null });
	});

	it("tells every connected socket about a notification", async () => {
		const { body: agent } = await post("/agents", { name: "Travel", instructions: "Plan trips.", symbol: "plane", color: "teal" });
		const { body: other } = await post("/sessions", { agent: agent.id });
		// Sockets on different sessions both receive it.
		const root = await connect();
		const elsewhere = await connect(other.id);

		await runInDurableObject(env.Pim.getByName(OWNER), (instance: Pim) =>
			instance.deliverNotification(instance.store.addNotification({ id: crypto.randomUUID(), session: instance.store.sessionOf(other.id)!, title: "Price drop", body: "Your flight is $80 cheaper." })),
		);

		for (const { received } of [root, elsewhere]) {
			await vi.waitFor(() => expect(received.some((message) => message.type === "notification")).toBe(true));
		}
		const pushed = root.received.find((message) => message.type === "notification");
		const look = { id: agent.id, icon: null, symbol: "plane", color: "teal" };
		expect(pushed.notification).toMatchObject({ title: "Price drop", body: "Your flight is $80 cheaper.", session: other.id, agent: look });

		expect((await api("/notifications?unread=true")).body.notifications).toHaveLength(1);
		expect((await post(`/notifications/${pushed.notification.id}/read`)).body.agent).toEqual(look);
		expect((await api("/notifications?unread=true")).body.notifications).toEqual([]);
		expect((await api("/notifications")).body.notifications).toContainEqual(
			expect.objectContaining({ id: pushed.notification.id, readAt: expect.any(Number), agent: look }),
		);
		root.socket.close();
		elsewhere.socket.close();
	});
});

describe("web push", () => {
	const decoder = new TextDecoder();
	const bytes = (text: string) => new TextEncoder().encode(text);

	/** A browser's side of a push subscription, which can read what the Pim sends it. */
	async function browser(endpoint: string) {
		const pair = (await crypto.subtle.generateKey({ name: "ECDH", namedCurve: "P-256" }, true, ["deriveBits"])) as CryptoKeyPair;
		const p256dh = new Uint8Array((await crypto.subtle.exportKey("raw", pair.publicKey)) as ArrayBuffer);
		const auth = crypto.getRandomValues(new Uint8Array(16));
		const b64 = (data: Uint8Array) => btoa(String.fromCharCode(...data)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
		const derive = async (salt: Uint8Array, secret: Uint8Array, info: Uint8Array, length: number) =>
			new Uint8Array(
				await crypto.subtle.deriveBits(
					{ name: "HKDF", hash: "SHA-256", salt, info },
					await crypto.subtle.importKey("raw", secret, "HKDF", false, ["deriveBits"]),
					length * 8,
				),
			);
		return {
			subscription: { endpoint, p256dh: b64(p256dh), auth: b64(auth) },
			/** RFC 8291 section 3.4, from the receiver's side. */
			async decrypt(body: Uint8Array) {
				const salt = body.slice(0, 16);
				const keyLength = body[20]!;
				const theirs = body.slice(21, 21 + keyLength);
				const record = body.slice(21 + keyLength);
				const shared = new Uint8Array(
					await crypto.subtle.deriveBits(
						{ name: "ECDH", public: await crypto.subtle.importKey("raw", theirs, { name: "ECDH", namedCurve: "P-256" }, false, []) } as any,
						pair.privateKey,
						256,
					),
				);
				const secret = await derive(auth, shared, new Uint8Array([...bytes("WebPush: info\0"), ...p256dh, ...theirs]), 32);
				const key = await crypto.subtle.importKey("raw", await derive(salt, secret, bytes("Content-Encoding: aes128gcm\0"), 16), "AES-GCM", false, ["decrypt"]);
				const nonce = await derive(salt, secret, bytes("Content-Encoding: nonce\0"), 12);
				const plain = new Uint8Array(await crypto.subtle.decrypt({ name: "AES-GCM", iv: nonce }, key, record));
				// The record ends with its 0x02 delimiter.
				expect(plain.at(-1)).toBe(2);
				return JSON.parse(decoder.decode(plain.slice(0, -1)));
			},
		};
	}

	const deliver = (title: string, body: string) =>
		runInDurableObject(env.Pim.get(env.Pim.idFromName(OWNER)) as unknown as DurableObjectStub<Pim>, (agent) =>
			agent.deliverNotification(agent.store.addNotification({ id: crypto.randomUUID(), session: "1", title, body })),
		);

	it("sends a notification to a subscribed browser, readable only by it and signed with the deployment's key", async () => {
		const phone = await browser("https://push.example/phone");
		expect((await api("/push/subscription", { method: "PUT", body: JSON.stringify(phone.subscription) })).status).toBe(200);
		const { publicKey } = (await api("/push/key")).body;

		const fetched = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(null, { status: 201 }));
		try {
			await deliver("Price drop", "Your flight is $80.50 cheaper.\nBook by **Friday** to keep it.");
			const [[endpoint, init]] = fetched.mock.calls as [[string, RequestInit]];
			expect(endpoint).toBe("https://push.example/phone");
			// The alert shows the opening sentences, without markdown.
			expect(await phone.decrypt(new Uint8Array(init.body as ArrayBuffer))).toMatchObject({ title: "Price drop", body: "Your flight is $80.50 cheaper. Book by Friday to keep it.", session: ROOT });

			// The VAPID token is signed by the key /push/key advertises, for the push service's origin.
			const header = (init.headers as Record<string, string>).Authorization!;
			expect(header).toContain(`k=${publicKey}`);
			const [, signing, signature] = header.match(/t=([\w-]+\.[\w-]+)\.([\w-]+)/)!;
			const raw = (value: string) => Uint8Array.from(atob(value.replace(/-/g, "+").replace(/_/g, "/").padEnd(Math.ceil(value.length / 4) * 4, "=")), (c) => c.charCodeAt(0));
			const verifier = await crypto.subtle.importKey("raw", raw(publicKey), { name: "ECDSA", namedCurve: "P-256" }, false, ["verify"]);
			expect(await crypto.subtle.verify({ name: "ECDSA", hash: "SHA-256" }, verifier, raw(signature!), bytes(signing!))).toBe(true);
			expect(JSON.parse(decoder.decode(raw(signing!.split(".")[1]!))).aud).toBe("https://push.example");
			// A sleeping Android phone gets only high-urgency pushes right away.
			expect((init.headers as Record<string, string>).Urgency).toBe("high");

			// A browser the push service has dropped is forgotten.
			fetched.mockResolvedValue(new Response(null, { status: 410 }));
			await deliver("Again", "Anyone there?");
			fetched.mockClear();
			await deliver("Once more", "Nobody should get this.");
			expect(fetched).not.toHaveBeenCalled();
		} finally {
			fetched.mockRestore();
		}
	});

	it("pushes a reply nobody has read, and not one that was read", async () => {
		const phone = await browser("https://push.example/phone");
		expect((await api("/push/subscription", { method: "PUT", body: JSON.stringify(phone.subscription) })).status).toBe(200);
		const { body: agent } = await post("/agents", { name: "Planner", instructions: "Plan trips.", symbol: "🚂", color: "orange" });
		const { body: chat } = await post("/sessions", { title: "Lisbon trip", agent: agent.id });
		const stub = env.Pim.getByName(OWNER);
		/** Runs the reply checks still due, as their alarm would, and returns what reached the phone. */
		const runChecks = async () => {
			const fetched = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(null, { status: 201 }));
			try {
				await runInDurableObject(stub, async (instance: Pim) => {
					for (const schedule of await instance.listSchedules()) {
						if (schedule.callback !== "pushReply") continue;
						await instance.pushReply(schedule.payload as never);
						await instance.cancelSchedule(schedule.id);
					}
				});
				return Promise.all((fetched.mock.calls as [[string, RequestInit]]).map(([, init]) => phone.decrypt(new Uint8Array(init.body as ArrayBuffer))));
			} finally {
				fetched.mockRestore();
			}
		};

		faux.setResponses([toolUse("send_to_user", { message: "Booked the 9:40 to Lisbon. It leaves from Santa Apolónia." })]);
		await say("Book the train.", chat.id);
		expect(await runChecks()).toEqual([{ id: expect.any(String), session: chat.id, title: "Lisbon trip", body: "Booked the 9:40 to Lisbon. It leaves from Santa Apolónia.", reply: true, kind: "reply", agent: { id: agent.id, icon: null, symbol: "🚂", color: "orange" } }]);

		// Read on another device before the check: nothing to push.
		faux.setResponses([toolUse("send_to_user", { message: "Seat 42A." })]);
		await say("Which seat?", chat.id);
		const { responseAt } = (await api("/sessions")).body.sessions.find((session: { id: string }) => session.id === chat.id);
		await post(`/sessions/${chat.id}/read`, { responseAt });
		expect(await runChecks()).toEqual([]);
	});

	it("pushes an agent working on its own only when every reply is asked for", async () => {
		const phone = await browser("https://push.example/phone");
		expect((await api("/push/subscription", { method: "PUT", body: JSON.stringify(phone.subscription) })).status).toBe(200);
		const { body: chat } = await post("/sessions", { title: "Flight watch" });
		const stub = env.Pim.getByName(OWNER);
		/** A scheduled task's reply, which nobody asked for in the chat, and the pushes that reach the phone once the checks run. */
		const unprompted = async () => {
			const fetched = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(null, { status: 201 }));
			try {
				faux.setResponses([toolUse("send_to_user", { message: "Prices moved." })]);
				await runInDurableObject(stub, async (instance: Pim) => {
					const session = instance.store.sessionOf(chat.id)!;
					const receipt = await instance.submitTo(session, "[Scheduled task] check", {}, "pim");
					await instance.harness.wait(receipt.operationId, { session });
					for (const schedule of await instance.listSchedules()) {
						if (schedule.callback !== "pushReply") continue;
						await instance.pushReply(schedule.payload as never);
						await instance.cancelSchedule(schedule.id);
					}
				});
				return Promise.all((fetched.mock.calls as [[string, RequestInit]]).map(([, init]) => phone.decrypt(new Uint8Array(init.body as ArrayBuffer))));
			} finally {
				fetched.mockRestore();
			}
		};
		expect(await unprompted()).toEqual([]);
		expect((await api("/settings", { method: "PUT", body: JSON.stringify({ deviceAlerts: "all" }) })).body.deviceAlerts).toBe("all");
		expect(await unprompted()).toEqual([expect.objectContaining({ title: "Flight watch", body: "Prices moved.", kind: "reply" })]);
		expect((await api("/settings", { method: "PUT", body: JSON.stringify({ deviceAlerts: "never" }) })).status).toBe(400);
		await api("/settings", { method: "PUT", body: JSON.stringify({ deviceAlerts: null }) });
	});

	it("rejects subscriptions that are not https push subscriptions", async () => {
		const phone = await browser("http://push.example/phone");
		expect((await api("/push/subscription", { method: "PUT", body: JSON.stringify(phone.subscription) })).status).toBe(400);
		expect((await api("/push/subscription", { method: "PUT", body: JSON.stringify({ endpoint: "https://x.example/" }) })).status).toBe(400);
	});
});
