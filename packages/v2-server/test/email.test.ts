// Email to the person: the SMTP client against a stand-in server, the confirmation flow of Settings with its limits, and an agent emailing the person with `send_to_user` on
// the real stack (Gate, Runner, Live and the faux model), only at the address they confirmed.
import { randomBytes } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { fauxAssistantMessage, fauxProvider, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import { App } from "@pim/v2-app/app";
import { connect as connectApp } from "@pim/v2-app/db";
import { MemoryObjectStore } from "@pim/v2-app/objects";
import { hidePassword, mailerFrom, smtpMailer, smtpConfigFrom } from "../src/smtp.ts";
import type { Process } from "../src/main.ts";
import { waitFor } from "../../v2-runtime/test/support/rig.ts";
import { Client } from "./support/client.ts";
import { type Deployment, base, start, startS3 } from "./support/processes.ts";
import { createStack, describeWith, freePort, hasNats, startNats } from "./support/stack.ts";
import { readMessage, startSmtp } from "./support/smtp.ts";

const real = describeWith(hasNats());

describe("the SMTP client", () => {
	it("sends a UTF-8 message through a server that asks for a password, and refuses a wrong one", async () => {
		const smtp = await startSmtp({ auth: { user: "pim", pass: "s3cret:/" } });
		try {
			const config = smtpConfigFrom({ PIM_SMTP_URL: `smtp://pim:${encodeURIComponent("s3cret:/")}@127.0.0.1:${smtp.port}`, PIM_EMAIL_FROM: "pim@example.com" })!;
			expect(config).toMatchObject({ host: "127.0.0.1", port: smtp.port, secure: false, user: "pim", pass: "s3cret:/" });
			await smtpMailer(config).send({ to: "ada@example.com", subject: "Tu semana — 3 entrenamientos, vuelo reservado y una pregunta larga para ver que el asunto se parte bien", text: "Hola\n.\nUna línea con punto arriba.\n¡Hasta luego! 🏃" });
			const [sent] = smtp.received;
			expect(sent).toMatchObject({ from: "pim@example.com", to: ["ada@example.com"], user: "pim" });
			const message = readMessage(sent!.raw);
			expect(message.headers.from).toBe("Pim <pim@example.com>");
			expect(message.subject).toBe("Tu semana — 3 entrenamientos, vuelo reservado y una pregunta larga para ver que el asunto se parte bien");
			expect(message.text.trim()).toBe("Hola\n.\nUna línea con punto arriba.\n¡Hasta luego! 🏃");
			await expect(smtpMailer({ ...config, pass: "wrong" }).send({ to: "ada@example.com", subject: "x", text: "y" })).rejects.toThrow(/535/);
			expect(smtp.received).toHaveLength(1);
			// No password goes over a connection that has no TLS, unless it stays on this machine.
			await expect(smtpMailer({ ...config, host: "mail.invalid" }).send({ to: "ada@example.com", subject: "x", text: "y" })).rejects.toThrow();
		} finally {
			await smtp.close();
		}
	});

	it("is off without both PIM_SMTP_URL and PIM_EMAIL_FROM", () => {
		expect(smtpConfigFrom({ PIM_SMTP_URL: "smtp://localhost:25" })).toBeNull();
		expect(smtpConfigFrom({ PIM_EMAIL_FROM: "pim@example.com" })).toBeNull();
		expect(smtpConfigFrom({ PIM_SMTP_URL: "http://mail.example.com", PIM_EMAIL_FROM: "pim@example.com" })).toBeNull();
		expect(smtpConfigFrom({ PIM_SMTP_URL: "smtps://u:p@mail.example.com", PIM_EMAIL_FROM: "pim@example.com" })).toMatchObject({ port: 465, secure: true });
		expect(hidePassword("smtps://u:p%40ss@mail.example.com:465")).toBe("smtps://u:***@mail.example.com:465");
	});
});

real("email to the person", () => {
	let d: Deployment;
	let gate: Process;
	let runner: Process;
	let live: Process;
	let web: Client;
	let app: App;
	let ownerId: string;
	let smtp: Awaited<ReturnType<typeof startSmtp>>;
	const faux = fauxProvider({ provider: "faux", models: [{ id: "m" }] });
	const toolUse = (...calls: ReturnType<typeof fauxToolCall>[]) => fauxAssistantMessage(calls, { stopReason: "toolUse" });
	const asked: string[] = [];
	const codeOf = (index: number) => readMessage(smtp.received[index]!.raw).subject.slice(0, 6);

	beforeAll(async () => {
		smtp = await startSmtp();
		const stack = await createStack();
		d = { stack, nats: await startNats(), s3: await startS3(), gatePort: await freePort(), ingressSecret: "ingress" };
		const mail = { PIM_SMTP_URL: `smtp://127.0.0.1:${smtp.port}`, PIM_EMAIL_FROM: "pim@example.com" };
		// The admin's Deployment screen reads the process environment, which the in-process Gate shares.
		Object.assign(process.env, mail, { PIM_PUBLIC_URL: `http://127.0.0.1:${d.gatePort}` });
		app = new App(connectApp(stack.url("gate"), 4), new MemoryObjectStore(), { mailer: mailerFrom(mail)! });
		gate = await start(d, "gate", {}, mail);
		web = new Client(base(gate), d.ingressSecret);
		const claim = await app.identity.issueClaim("bootstrap", null, 3_600_000);
		const registered = await web.call("POST", "/auth/register", { username: "anibal", bootstrap: claim, session: true });
		expect(registered.status).toBe(201);
		ownerId = registered.json.account.ownerId;
		runner = await start(d, "runner", { pollMs: 40, providers: () => [faux.provider] }, { PIM_DEFAULT_MODEL: "faux/m", PIM_APP_DATABASE_URL: stack.url("gate"), ...mail });
		live = await start(d, "live", { pollMs: 40 });
	}, 180_000);
	afterAll(async () => {
		delete process.env.PIM_SMTP_URL;
		delete process.env.PIM_EMAIL_FROM;
		delete process.env.PIM_PUBLIC_URL;
		await Promise.allSettled([live?.close(), runner?.close(), gate?.close()]);
		await app?.db.end();
		await smtp?.close();
		d?.nats.stop();
		await d?.s3.stop();
		await d?.stack.drop();
	}, 60_000);

	it("confirms an address with a code, five codes a day and five tries each", async () => {
		expect((await web.call("GET", "/api/email")).json).toEqual({ available: true, address: null, pending: null });
		expect((await web.call("PUT", "/api/email", { address: "not an address" })).status).toBe(400);
		expect((await web.call("POST", "/api/email/confirm", { code: "123456" })).status).toBe(409);
		expect((await web.call("PUT", "/api/email", { address: "ada@example.com" })).json).toEqual({ available: true, address: null, pending: "ada@example.com" });
		expect(smtp.received[0]).toMatchObject({ to: ["ada@example.com"] });
		expect(readMessage(smtp.received[0]!.raw).subject).toMatch(/^\d{6} is your Pim confirmation code$/);
		// Five wrong tries lock a code, and not even the right one works then.
		const code = codeOf(0);
		const wrong = code === "000000" ? "000001" : "000000";
		for (let n = 0; n < 5; n++) expect((await web.call("POST", "/api/email/confirm", { code: wrong })).status).toBe(400);
		expect((await web.call("POST", "/api/email/confirm", { code })).status).toBe(429);
		// A new code starts again; the fifth of the day is the last.
		for (let n = 1; n < 5; n++) expect((await web.call("PUT", "/api/email", { address: "ada@example.com" })).status).toBe(200);
		const refused = await web.call("PUT", "/api/email", { address: "ada@example.com" });
		expect(refused.status).toBe(429);
		expect(refused.json.error).toBe("too_many_codes");
		expect(smtp.received).toHaveLength(5);
		expect((await web.call("POST", "/api/email/confirm", { code: codeOf(4) })).json).toEqual({ available: true, address: "ada@example.com", pending: null });
		expect((await web.call("DELETE", "/api/email")).json).toEqual({ available: true, address: null, pending: null });
		// Only a person's own codes count against their day.
		expect(await app.mail.state(ownerId)).toMatchObject({ address: null });
	});

	it("shows the deployment's sender, and the SMTP server without its password", async () => {
		const deployment = await web.call("GET", "/api/admin/deployment");
		expect(deployment.status).toBe(200);
		expect(deployment.json.settings.emailFrom).toBe("pim@example.com");
		expect(deployment.json.variables.find((v: { name: string }) => v.name === "PIM_SMTP_URL")).toMatchObject({ value: `smtp://127.0.0.1:${smtp.port}`, problem: null });
	});

	it("lets an agent email the person at the address they confirmed, and only there, 50 times a day", async () => {
		smtp.received.length = 0;
		const chat = (await web.call("POST", "/api/sessions", { title: "Week" })).json.id as string;
		const turn = async (words: string, ...script: unknown[]) => {
			faux.setResponses(script as never);
			const before = (await web.call("GET", `/api/snapshot/chat/${chat}`)).json.messages.length;
			expect((await web.call("POST", `/api/sessions/${chat}/messages`, { commandId: `m-${Math.random()}`, text: words })).status).toBe(202);
			await waitFor(`the turn "${words}" to end`, async () => {
				const page = (await web.call("GET", `/api/snapshot/chat/${chat}`)).json.messages as { role: string; stopReason?: string; partial?: boolean }[];
				const last = page.at(-1) as { role: string; parts: { content?: { text?: string }[] }[] } | undefined;
				const said = last?.role === "tool" ? last.parts.flatMap((p) => p.content?.map((c) => c.text ?? "") ?? []).join("") : "";
				return page.length > before + 1 && (said === "Sent." || said.startsWith("Emailed it")) ? page : undefined;
			}, 60_000);
			return (await web.call("GET", `/api/snapshot/chat/${chat}`)).json.messages as { role: string; parts: { type: string; content?: { text?: string }[] }[] }[];
		};
		const resultOf = (messages: Awaited<ReturnType<typeof turn>>) => messages.filter((m) => m.role === "tool").at(-1)!.parts.flatMap((p) => p.content?.map((c) => c.text ?? "") ?? []).join("");
		const email = { channel: "email", title: "Your week", message: "3 workouts, 1 flight booked." };
		// The agent is offered email as a channel, because this deployment sends it.
		// No address yet: nothing is sent, and the model is told why.
		const unsent = await turn("Email me my week.", toolUse(fauxToolCall("send_to_user", email)), (ctx: { messages: { role: string; content: unknown }[] }) => (asked.push(JSON.stringify(ctx.messages.at(-1))), toolUse(fauxToolCall("send_to_user", { message: "Add an email address first." }))));
		expect(resultOf(unsent)).toContain("Sent.");
		expect(asked.at(-1)).toContain("hasn't added an email address");
		expect(smtp.received).toEqual([]);

		await web.call("PUT", "/api/email", { address: "ada@example.com" }).catch(() => undefined);
		// The day's five codes were used above; the address is confirmed as the person would have, by the code that came.
		await app.db.owner(ownerId, (tx) => tx.query("INSERT INTO pim_app.email_addresses (owner_id, address) VALUES ($1, 'ada@example.com')", [ownerId]));
		const sent = await turn("Email me my week again.", toolUse(fauxToolCall("send_to_user", email)));
		expect(resultOf(sent)).toBe("Emailed it to ada@example.com.");
		await waitFor("the email", () => smtp.received.length === 1 || undefined);
		const [mail] = smtp.received;
		expect(mail).toMatchObject({ from: "pim@example.com", to: ["ada@example.com"] });
		const message = readMessage(mail!.raw);
		expect(message.subject).toBe("Your week");
		expect(message.text.trim()).toBe(`3 workouts, 1 flight booked.\n\n—\nFrom your Pim: http://127.0.0.1:${d.gatePort}/chat/${chat}`);

		// The same call again sends nothing twice; fifty a day, and the fifty-first says so.
		const id = "replayed-call";
		await app.mail.send(ownerId, { id, chat, subject: "a", text: "a" });
		await app.mail.send(ownerId, { id, chat, subject: "a", text: "a" });
		expect(smtp.received).toHaveLength(2);
		for (let n = 2; n < 50; n++) expect(await app.mail.send(ownerId, { id: `n${n}`, chat, subject: "n", text: "n" })).toEqual({ to: "ada@example.com" });
		expect(await app.mail.send(ownerId, { id: "one-too-many", chat, subject: "n", text: "n" })).toEqual({ error: "Pim can email the person 50 times a day, and has today." });
		expect(smtp.received).toHaveLength(50);
	}, 120_000);
});

describe("a deployment without a mail sender", () => {
	let stack: Awaited<ReturnType<typeof createStack>>;
	let app: App;
	beforeAll(async () => {
		stack = await createStack();
		app = new App(connectApp(stack.url("gate"), 2), new MemoryObjectStore());
	});
	afterAll(async () => {
		await app?.db.end();
		await stack?.drop();
	});
	it("shows email as unavailable, and sends nothing", async () => {
		const claim = await app.identity.issueClaim("bootstrap", null, 3_600_000);
		const account = await app.identity.register({ username: `ada${randomBytes(2).toString("hex")}`, bootstrap: claim });
		expect(await app.mail.state(account.ownerId)).toEqual({ available: false, address: null, pending: null });
		const principal = (await app.identity.authenticate(await app.identity.createSession(account.ownerId)))!;
		await expect(app.mail.start(principal as never, "ada@example.com")).rejects.toThrow("This Pim can't send email");
		expect(await app.mail.send(account.ownerId, { id: "x", chat: null, subject: "x", text: "x" })).toEqual({ error: "This Pim can't send email." });
	});
});
