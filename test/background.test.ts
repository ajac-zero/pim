import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import { env, runInDurableObject } from "cloudflare:test";
import { describe, expect, it, vi } from "vitest";
import { AGENT_NAME } from "../src/agent";
import { api, connect, lastUserText, post, say, toolUse } from "./helpers";
import { faux, type Pim } from "./worker";

describe("scheduled tasks", () => {
	it("schedules work for later and hands it back to the same session when it fires", async () => {
		faux.setResponses([
			toolUse("schedule_task", {
				instruction: "Check whether the flight price dropped.",
				label: "Flight check",
				delay_seconds: 3600,
			}),
			fauxAssistantMessage("I'll check in an hour."),
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
		const operation = await runInDurableObject(env.Pim.getByName(AGENT_NAME), async (instance: Pim) => {
			const [due] = await instance.listSchedules();
			await instance.runScheduledTask(due!.payload as never, due as never);
			return `schedule:${due!.id}:${due!.time}`;
		});
		const settled = await api(`/sessions/1/operations/${encodeURIComponent(operation)}`);
		expect(settled.body).toMatchObject({ status: "done", text: "Same price." });
		expect(woken).toBe(`[Scheduled task "Flight check" ${schedule.id}] Check whether the flight price dropped.`);

		expect((await api(`/schedules/${schedule.id}`, { method: "DELETE" })).status).toBe(200);
		expect((await api("/schedules")).body.schedules).toEqual([]);
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
				return fauxAssistantMessage("Oops.");
			},
		]);
		await say("Remind me.");
		expect(results).toContain("exactly one of delay_seconds, at, or cron");
		expect(results).toContain("is in the past");
		expect((await api("/schedules")).body.schedules).toEqual([]);
	});
});

describe("notifications", () => {
	it("stores notifications and pushes them to every connected socket", async () => {
		const { body: other } = await post("/sessions");
		// Sockets on different sessions both receive it.
		const root = await connect();
		const elsewhere = await connect(other.id);

		faux.setResponses([
			toolUse("notify_user", { title: "Price drop", body: "Your flight is $80 cheaper." }),
			fauxAssistantMessage("Told you."),
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
		expect((await api("/notifications")).body.notifications).toHaveLength(1);
		root.socket.close();
		elsewhere.socket.close();
	});
});

describe("web push", () => {
	const decoder = new TextDecoder();
	const bytes = (text: string) => new TextEncoder().encode(text);

	/** A browser's side of a push subscription, which can read what the agent sends it. */
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
		runInDurableObject(env.Pim.get(env.Pim.idFromName(AGENT_NAME)) as unknown as DurableObjectStub<Pim>, (agent) =>
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
