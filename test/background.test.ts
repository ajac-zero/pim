import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import { env, runInDurableObject } from "cloudflare:test";
import { describe, expect, it, vi } from "vitest";
import { DELIVERY_REMINDER } from "../src/transcript";
import { api, connect, lastUserText, OWNER, post, say, toolUse } from "./helpers";
import { faux, outbox, type Pim } from "./worker";

describe("scheduled tasks", () => {
	it("schedules work for later and hands it back to the same session when it fires", async () => {
		faux.setResponses([
			toolUse("schedule_task", {
				instruction: "Check whether the flight price dropped.",
				label: "Flight check",
				delay_seconds: 3600,
			}),
			toolUse("send_to_user", { message: "I'll check in an hour." }),
		]);
		const before = Date.now();
		await say("Watch the flight price.");
		const { body } = await api("/schedules");
		expect(body.schedules).toHaveLength(1);
		const [schedule] = body.schedules;
		expect(schedule).toMatchObject({ type: "delayed", session: "1", label: "Flight check" });
		const next = Date.parse(schedule.next);
		expect(next).toBeGreaterThanOrEqual(before + 3_599_000);
		expect(next).toBeLessThanOrEqual(Date.now() + 3_601_000);

		// Fire it now instead of waiting an hour.
		let woken = "";
		faux.setResponses([
			(context) => {
				woken = lastUserText(context.messages);
				return fauxAssistantMessage("Same price.");
			},
		]);
		const operation = await runInDurableObject(env.Pim.getByName(OWNER), async (instance: Pim) => {
			const [due] = await instance.listSchedules();
			await instance.runScheduledTask(due!.payload as never, due as never);
			// The same firing retried tells the person once.
			await instance.runScheduledTask(due!.payload as never, due as never);
			return `schedule:${due!.id}:${due!.time}`;
		});
		// The person sees that it ran, with a link to the chat it ran in.
		expect((await api("/notifications")).body.notifications).toEqual([
			expect.objectContaining({
				session: "1",
				title: "Scheduled task ran: Flight check",
				body: "Check whether the flight price dropped.",
				readAt: null,
			}),
		]);
		const [ran] = (await api("/notifications")).body.notifications;
		await post(`/notifications/${ran.id}/read`);
		const settled = await api(`/sessions/1/operations/${encodeURIComponent(operation)}`);
		// Work Pim gave itself may stay silent: its final text is notes, not a reply.
		expect(settled.body).toMatchObject({ status: "done", replies: [] });
		expect(settled.body).not.toHaveProperty("text");
		expect(woken).toBe(`[Scheduled task "Flight check" ${schedule.id}] Check whether the flight price dropped.`);

		expect((await api(`/schedules/${schedule.id}`, { method: "DELETE" })).status).toBe(200);
		expect((await api("/schedules")).body.schedules).toEqual([]);
	});

	it("starts a new chat with the same agent each time a new-chat task fires", async () => {
		const coach = (await post("/agents", { name: "Coach", instructions: "Coach me." })).body;
		const origin = (await post("/sessions", { agent: coach.id, title: "Training" })).body.id;
		faux.setResponses([
			toolUse("schedule_task", { instruction: "Write today's training plan.", label: "Daily plan", cron: "0 9 * * *", new_chat: true }),
			toolUse("send_to_user", { message: "Every morning." }),
		]);
		await say("Plan my training every morning.", origin);
		const [schedule] = (await api("/schedules")).body.schedules;
		expect(schedule).toMatchObject({ type: "cron", session: origin, newChat: true });
		const originLength = (await api(`/sessions/${origin}/messages`)).body.messages.length;

		// Two days' firings, the first retried: one chat per day, none for the retry.
		faux.setResponses([fauxAssistantMessage("Day one."), fauxAssistantMessage("Day two.")]);
		const fire = (days: number, times: number) =>
			runInDurableObject(env.Pim.getByName(OWNER), async (instance: Pim) => {
				const [due] = await instance.listSchedules();
				const firing = { ...due!, time: due!.time + days * 86_400 };
				for (let i = 0; i < times; i++) await instance.runScheduledTask(firing.payload as never, firing as never);
				return `schedule:${firing.id}:${firing.time}`;
			});
		const operations = [await fire(0, 2)];
		expect((await api(`/sessions/${origin}/messages`)).body.messages).toHaveLength(originLength);

		// Deleting the chat that scheduled it leaves it running, still on the agent's dashboard.
		expect((await api(`/sessions/${origin}`, { method: "DELETE" })).status).toBe(200);
		expect((await api("/schedules")).body.schedules).toMatchObject([{ id: schedule.id }]);
		const board = (await api(`/agents/${coach.id}/dashboard`)).body;
		const upcoming = board.widgets.find((shown: { id: string }) => shown.id === "pim.schedule/upcoming").items;
		expect(upcoming).toEqual([{ title: "Daily plan", time: expect.any(String) }]);
		operations.push(await fire(1, 1));

		const chats = (await api("/sessions")).body.sessions.filter((session: { title: string }) => session.title === "Daily plan");
		expect(chats).toHaveLength(2);
		chats.sort((a: { id: string }, b: { id: string }) => Number(a.id) - Number(b.id));
		// Each run's notification links to the chat it started.
		const ran = (await api("/notifications")).body.notifications.filter((notification: { title: string }) => notification.title === "Scheduled task ran: Daily plan");
		expect(ran.map((notification: { session: string }) => notification.session).sort()).toEqual(chats.map((chat: { id: string }) => chat.id).sort());
		for (const notification of ran) await post(`/notifications/${notification.id}/read`);
		for (const [index, chat] of chats.entries()) {
			expect(chat.agent).toMatchObject({ id: coach.id });
			expect((await api(`/sessions/${chat.id}/operations/${encodeURIComponent(operations[index]!)}`)).body).toMatchObject({ status: "done" });
			const { messages } = (await api(`/sessions/${chat.id}/messages`)).body;
			const fired = JSON.stringify(messages).split(`[Scheduled task \\"Daily plan\\" ${schedule.id}] Write today's training plan.`);
			expect(fired).toHaveLength(2);
		}
		expect((await api(`/schedules/${schedule.id}`, { method: "DELETE" })).status).toBe(200);
	});

	it("rejects ambiguous or past times without scheduling anything", async () => {
		let results = "";
		faux.setResponses([
			fauxAssistantMessage(
				[
					fauxToolCall("schedule_task", { instruction: "x", delay_seconds: 60, cron: "0 9 * * *" }),
					fauxToolCall("schedule_task", { instruction: "x", at: "2001-01-01T00:00:00Z" }),
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
		expect(results).toContain("is in the past");
		expect((await api("/schedules")).body.schedules).toEqual([]);
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
		const { body } = await post("/sessions/1/messages", { content: "How's the flight price?", wait: true });
		expect(body).toMatchObject({ status: "done", text: "On it.\n\nYour flight is **$80** cheaper.", replies: ["On it.", "Your flight is **$80** cheaper."] });
		// Without notify, nothing else hears of it.
		expect((await api("/notifications?unread=true")).body.notifications).toEqual([]);

		// Private final text prompts an explicit send; it is never passed off as the answer.
		faux.setResponses([
			fauxAssistantMessage("Private draft: same as before."),
			(context) => {
				expect(lastUserText(context.messages)).toBe(DELIVERY_REMINDER);
				return toolUse("send_to_user", { message: "Same as before." });
			},
		]);
		const forgot = await post("/sessions/1/messages", { content: "And now?", wait: true });
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
			const answer = await post("/sessions/1/messages", { content: "Check for me.", wait: true });
			expect(answer.body).toMatchObject({ status: "done", replies: ["I'll check.", "Here's the answer."] });
		}
	});

	it("bounds delivery corrections and never exposes private text as a fallback", async () => {
		faux.setResponses([
			fauxAssistantMessage("Private first answer."),
			fauxAssistantMessage("Still private."),
			fauxAssistantMessage("Private third answer."),
		]);
		const failed = await post("/sessions/1/messages", { content: "Answer me.", wait: true });
		expect(failed.body).toMatchObject({ status: "unanswered", replies: [] });
		expect(failed.body).not.toHaveProperty("text");
		// A new user turn gets a fresh correction budget, not the previous turn's reminders.
		faux.setResponses([
			fauxAssistantMessage("Another private draft."),
			toolUse("send_to_user", { message: "A delivered answer." }),
		]);
		expect((await post("/sessions/1/messages", { content: "Try again.", wait: true })).body).toMatchObject({ status: "done", replies: ["A delivered answer."] });
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
		const unsent = await post("/sessions/1/messages", { content: "Email me my week.", wait: true });
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
		const sent = await post("/sessions/1/messages", { content: "Email me my week.", wait: true });
		expect(JSON.stringify((await api("/sessions/1/messages")).body.messages)).toContain("Emailed it to ada@example.com.");
		expect(outbox).toEqual([
			{ to: "ada@example.com", subject: "Your week", text: "3 workouts, 1 flight booked.\n\n—\nFrom your Pim: https://pim.test/chat/1" },
		]);
		// The chat shows it was emailed; it is not a reply in the conversation.
		expect(sent.body).toMatchObject({ status: "done", replies: [] });
		outbox.splice(0);

		expect((await api("/email", { method: "DELETE" })).body).toEqual({ available: true, address: null, pending: null });
	});

	it("alerts the person's devices with notify, on every connected socket", async () => {
		const { body: other } = await post("/sessions");
		// Sockets on different sessions both receive it.
		const root = await connect();
		const elsewhere = await connect(other.id);

		faux.setResponses([
			toolUse("send_to_user", { message: "Your flight is $80 cheaper.", notify: true, title: "Price drop" }),
		]);
		await say("Tell me if anything changes.");

		for (const { received } of [root, elsewhere]) {
			await vi.waitFor(() => expect(received.some((message) => message.type === "notification")).toBe(true));
		}
		const pushed = root.received.find((message) => message.type === "notification");
		expect(pushed.notification).toMatchObject({ title: "Price drop", body: "Your flight is $80 cheaper.", session: "1" });

		expect((await api("/notifications?unread=true")).body.notifications).toHaveLength(1);
		await post(`/notifications/${pushed.notification.id}/read`);
		expect((await api("/notifications?unread=true")).body.notifications).toEqual([]);
		expect((await api("/notifications")).body.notifications).toContainEqual(
			expect.objectContaining({ id: pushed.notification.id, readAt: expect.any(Number) }),
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
			await deliver("Price drop", "Your flight is $80 cheaper.");
			const [[endpoint, init]] = fetched.mock.calls as [[string, RequestInit]];
			expect(endpoint).toBe("https://push.example/phone");
			expect(await phone.decrypt(new Uint8Array(init.body as ArrayBuffer))).toMatchObject({ title: "Price drop", body: "Your flight is $80 cheaper.", session: "1" });

			// The VAPID token is signed by the key /push/key advertises, for the push service's origin.
			const header = (init.headers as Record<string, string>).Authorization!;
			expect(header).toContain(`k=${publicKey}`);
			const [, signing, signature] = header.match(/t=([\w-]+\.[\w-]+)\.([\w-]+)/)!;
			const raw = (value: string) => Uint8Array.from(atob(value.replace(/-/g, "+").replace(/_/g, "/").padEnd(Math.ceil(value.length / 4) * 4, "=")), (c) => c.charCodeAt(0));
			const verifier = await crypto.subtle.importKey("raw", raw(publicKey), { name: "ECDSA", namedCurve: "P-256" }, false, ["verify"]);
			expect(await crypto.subtle.verify({ name: "ECDSA", hash: "SHA-256" }, verifier, raw(signature!), bytes(signing!))).toBe(true);
			expect(JSON.parse(decoder.decode(raw(signing!.split(".")[1]!))).aud).toBe("https://push.example");

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

	it("rejects subscriptions that are not https push subscriptions", async () => {
		const phone = await browser("http://push.example/phone");
		expect((await api("/push/subscription", { method: "PUT", body: JSON.stringify(phone.subscription) })).status).toBe(400);
		expect((await api("/push/subscription", { method: "PUT", body: JSON.stringify({ endpoint: "https://x.example/" }) })).status).toBe(400);
	});
});
