// A message sent while the agent is at work in a chat waits behind the run, joins it after its current step, or is refused, as the person's `whenBusy` says; the chat
// shows what is queued, the sessions' summary counts it, and the person can edit, cancel or steer a queued message until the agent has read it. A long tool call (a fetch
// the test holds) keeps the agent busy on the real stack: Gate, Runner, Live and the faux model.
import { afterAll, beforeAll, expect, it } from "vitest";
import { fauxAssistantMessage, fauxProvider, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import { App } from "@pim/v2-app/app";
import { connect as connectApp } from "@pim/v2-app/db";
import { MemoryObjectStore } from "@pim/v2-app/objects";
import type { Process } from "../src/main.ts";
import { waitFor } from "../../v2-runtime/test/support/rig.ts";
import { Client } from "./support/client.ts";
import { type Deployment, base, start, startS3 } from "./support/processes.ts";
import { createStack, describeWith, freePort, hasNats, startNats } from "./support/stack.ts";

const real = describeWith(hasNats());
const SLOW = "http://93.184.216.34/slow";

real("the queue behind a running turn", () => {
	let d: Deployment;
	let gate: Process;
	let runner: Process;
	let live: Process;
	let web: Client;
	let app: App;
	let release!: () => void;
	let held = false;
	const holding = new Promise<void>((resolve) => (release = resolve));
	const faux = fauxProvider({ provider: "faux", models: [{ id: "m" }] });
	const toolUse = (...calls: ReturnType<typeof fauxToolCall>[]) => fauxAssistantMessage(calls, { stopReason: "toolUse" });
	/** What each model request was asked: the person's words it could read. */
	const asked: string[][] = [];
	const readable = (ctx: { messages: { role: string; content: unknown }[] }) => ctx.messages.filter((m) => m.role === "user").map((m) => (typeof m.content === "string" ? m.content : (m.content as { text?: string }[]).map((c) => c.text ?? "").join("")));
	const send = (chat: string, text: string, extra: Record<string, unknown> = {}) => web.call("POST", `/api/sessions/${chat}/messages`, { commandId: `m-${Math.random()}`, text, ...extra });
	const queue = async (chat: string) => (await web.call("GET", `/api/snapshot/chat/${chat}`)).json.queue as { id: number; mode: string; content: unknown }[];
	const textOf = (content: unknown) => (typeof content === "string" ? content : (content as { text?: string }[]).map((c) => c.text ?? "").join(""));
	const queuedTexts = async (chat: string) => (await queue(chat)).map((q) => textOf(q.content));
	const queuedCount = async (chat: string) => (await web.call("GET", "/api/snapshot/sidebar")).json.sessions.find((s: { chatId: string }) => s.chatId === chat)?.summary?.queued;

	beforeAll(async () => {
		const stack = await createStack();
		d = { stack, nats: await startNats(), s3: await startS3(), gatePort: await freePort(), ingressSecret: "ingress" };
		app = new App(connectApp(stack.url("gate"), 4), new MemoryObjectStore());
		gate = await start(d, "gate");
		web = new Client(base(gate), d.ingressSecret);
		const claim = await app.identity.issueClaim("bootstrap", null, 3_600_000);
		expect((await web.call("POST", "/auth/register", { username: "anibal", bootstrap: claim, session: true })).status).toBe(201);
		runner = await start(
			d,
			"runner",
			{
				pollMs: 40,
				providers: () => [faux.provider],
				fetch: (async (url: string | URL) => {
					if (String(url) === SLOW) {
						held = true;
						await holding;
					}
					return new Response("a slow page", { headers: { "content-type": "text/plain" } });
				}) as typeof fetch,
			},
			{ PIM_DEFAULT_MODEL: "faux/m", PIM_APP_DATABASE_URL: stack.url("gate") },
		);
		live = await start(d, "live", { pollMs: 40 });
	}, 180_000);
	afterAll(async () => {
		release();
		await Promise.allSettled([live?.close(), runner?.close(), gate?.close()]);
		await app?.db.end();
		d?.nats.stop();
		await d?.s3.stop();
		await d?.stack.drop();
	}, 60_000);

	it("queues what is sent while the agent works, lets the person edit, steer and cancel it, and runs what is left", async () => {
		const chat = (await web.call("POST", "/api/sessions", { title: "Queue" })).json.id as string;
		const answer = (text: string) => toolUse(fauxToolCall("send_to_user", { message: text }));
		// The turn: fetch a page that is held; then answer with the steered messages the agent takes one at a time after each step.
		faux.setResponses([
			toolUse(fauxToolCall("fetch_url", { url: SLOW })),
			(ctx: never) => (asked.push(readable(ctx)), answer("answered the first and the reworded one")),
			(ctx: never) => (asked.push(readable(ctx)), answer("answered the third")),
		] as never);
		expect((await send(chat, "first")).status).toBe(202);
		await waitFor("the fetch to be held", () => held || undefined);

		// An agent at work refuses a message that asks to be refused, and takes the rest.
		const refused = await send(chat, "refuse me", { whenBusy: "reject" });
		expect(refused.status).toBe(409);
		expect(refused.json.error).toBe("busy");
		expect((await send(chat, "nope", { whenBusy: "sometime" })).status).toBe(400);
		for (const text of ["second", "third", "fourth"]) expect((await send(chat, text)).status).toBe(202);
		const first = await waitFor("three messages queued", async () => ((await queuedTexts(chat)).length === 3 ? await queue(chat) : undefined));
		expect(first.map((q) => [textOf(q.content), q.mode])).toEqual([["second", "followUp"], ["third", "followUp"], ["fourth", "followUp"]]);
		expect(await queuedCount(chat)).toBe(3);
		const [second, third, fourth] = first.map((q) => q.id) as [number, number, number];

		// Edited, steered and cancelled messages are the ones the agent sees.
		expect((await web.call("PUT", `/api/sessions/${chat}/queue/${second}`, { text: "second, reworded" })).status).toBe(200);
		expect((await web.call("POST", `/api/sessions/${chat}/queue/${third}/steer`)).status).toBe(200);
		expect((await web.call("DELETE", `/api/sessions/${chat}/queue/${fourth}`)).status).toBe(200);
		const changed = await waitFor("the queue to show the changes", async () => {
			const now = await queue(chat);
			return now.length === 2 && now.some((q) => q.mode === "steer") && now.some((q) => textOf(q.content) === "second, reworded") ? now : undefined;
		});
		expect(changed.map((q) => [textOf(q.content), q.mode])).toEqual([["second, reworded", "followUp"], ["third", "steer"]]);
		expect(await queuedCount(chat)).toBe(2);
		// A message that is not in the queue (any more) is said so, and an edit to nothing is refused.
		const gone = await web.call("DELETE", `/api/sessions/${chat}/queue/${fourth}`);
		expect(gone.status).toBe(409);
		expect(gone.json.error).toBe("not_queued");
		expect((await web.call("PUT", `/api/sessions/${chat}/queue/${second}`, { text: "   " })).status).toBe(400);
		expect((await web.call("POST", `/api/sessions/${chat}/queue/${second}/steer`)).status).toBe(200);
		await waitFor("both steered", async () => ((await queue(chat)).every((q) => q.mode === "steer") ? true : undefined));

		// The run goes on: the steered messages join it, in the order they were sent, and the cancelled one never reaches the agent.
		release();
		await waitFor("the agent to read them", async () => (asked.length >= 2 ? true : undefined), 60_000);
		await waitFor("the queue to empty", async () => ((await queue(chat)).length === 0 ? true : undefined), 60_000);
		const everything = asked.flat();
		expect(everything).toContain("third");
		expect(everything).toContain("second, reworded");
		expect(asked[0]).toContain("second, reworded");
		expect(asked[1]).toContain("third");
		expect(everything).not.toContain("fourth");
		expect(everything).not.toContain("second");
		expect(asked[0]).not.toContain("third");
		await waitFor("the count to clear", async () => ((await queuedCount(chat)) === 0 ? true : undefined));
	}, 120_000);
});
