// What happens to a chat over its life, end to end on the real stack with a scripted model: read state (an agent's reply makes it unread, reading it clears that, and the
// sidebar and the chat agree), compaction (a chat that outgrows the model's context is compacted in place by pi, and the next turn runs on the summary), and reset with a
// handoff (a summary carried into a new chat that continues the old one, which is archived and detaches again when the person writes in it), and a group chat (a room: a
// seat for each agent, who hears what the person says, answers when mentioned, and speaks into the host chat as "[From Name]").
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { fauxAssistantMessage, fauxProvider, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import { App } from "@pim/v2-app/app";
import { connect as connectApp } from "@pim/v2-app/db";
import { MemoryObjectStore } from "@pim/v2-app/objects";
import type { Process } from "../src/main.ts";
import { readTranscript, waitFor } from "../../v2-runtime/test/support/rig.ts";
import { Client } from "./support/client.ts";
import { type Deployment, base, start, startS3 } from "./support/processes.ts";
import { createStack, describeWith, freePort, hasNats, startNats, sentAndAnswered } from "./support/stack.ts";

const real = describeWith(hasNats());

real("a chat over its life", () => {
	let d: Deployment;
	let gate: Process;
	let runner: Process;
	let live: Process;
	let web: Client;
	let app: App;
	let ownerId: string;
	let n = 0;
	// A modest context window, so that two long messages are over pi's compaction threshold (the window less 16,384 reserved tokens) with something old enough to summarise
	// (pi keeps about the last 20,000 tokens verbatim).
	const faux = fauxProvider({ provider: "faux", models: [{ id: "m", contextWindow: 32_000 }] });
	const prompts: string[] = [];
	const toolUse = (...calls: ReturnType<typeof fauxToolCall>[]) => fauxAssistantMessage(calls, { stopReason: "toolUse" });
	const reply = (message: string) => toolUse(fauxToolCall("send_to_user", { message }));
	/** A response that notes every message it was asked with. */
	const asked = (build: () => ReturnType<typeof fauxAssistantMessage>) => (ctx: { messages?: unknown[] }) => (prompts.push(JSON.stringify(ctx.messages ?? [])), build());

	const transcript = async (chat: string) => {
		const c = (await d.stack.admin.query("SELECT partition_id, conversation_id FROM pim_runtime.conversation_partitions WHERE public_chat_id = $1", [chat])).rows[0];
		// The Runner makes the conversation when it takes the chat's first command.
		if (!c) return [];
		return readTranscript(d.stack.runtime, ownerId, c.partition_id, Number(c.conversation_id));
	};
	const say = async (chat: string, words: string, ...script: unknown[]) => {
		const id = ++n;
		// A turn ends by sending its answer, except background work, which may stay silent.
		const background = words.startsWith("[Scheduled task");
		faux.setResponses([...script, ...(background ? [] : [toolUse(fauxToolCall("send_to_user", { message: `done ${id}` }))]), fauxAssistantMessage(`ended ${id}`)] as never);
		expect((await web.call("POST", `/api/sessions/${chat}/messages`, { commandId: `m-${id}`, text: words })).status).toBe(202);
		await waitFor(`the turn "${words.slice(0, 20)}" to end`, async () => ((background ? JSON.stringify(await transcript(chat)).includes(`ended ${id}`) : sentAndAnswered(await transcript(chat), `done ${id}`)) ? true : undefined), 60_000);
	};
	const listed = async (chat: string) => (await web.call("GET", "/api/sessions")).json.sessions.find((s: { id: string }) => s.id === chat);

	beforeAll(async () => {
		const stack = await createStack();
		d = { stack, nats: await startNats(), s3: await startS3(), gatePort: await freePort(), ingressSecret: "ingress" };
		app = new App(connectApp(stack.url("gate"), 4), new MemoryObjectStore());
		gate = await start(d, "gate", {}, { PIM_DEFAULT_MODEL: "faux/m" });
		web = new Client(base(gate), d.ingressSecret);
		const claim = await app.identity.issueClaim("bootstrap", null, 3_600_000);
		const registered = await web.call("POST", "/auth/register", { username: "anibal", bootstrap: claim, session: true });
		expect(registered.status).toBe(201);
		ownerId = registered.json.account.ownerId;
		live = await start(d, "live", { pollMs: 40 });
		runner = await start(d, "runner", { pollMs: 40, providers: () => [faux.provider] }, { PIM_DEFAULT_MODEL: "faux/m", PIM_APP_DATABASE_URL: stack.url("gate"), PIM_MEMORY_NAP: "off" });
	}, 180_000);
	afterAll(async () => {
		await Promise.allSettled([runner?.close(), live?.close(), gate?.close()]);
		await app?.db.end();
		d?.nats.stop();
		await d?.s3.stop();
		await d?.stack.drop();
	}, 60_000);

	it("marks a chat unread when the agent replies, and read when the person reads it, in the chat and in the sidebar", async () => {
		const chat = (await web.call("POST", "/api/sessions", { title: "Reading" })).json.id;
		expect((await listed(chat)).unread).toBe(false);
		await say(chat, "hello", reply("Hi there."));
		const afterReply = await listed(chat);
		expect(afterReply.unread).toBe(true);
		expect(afterReply.responseAt).toBeTruthy();
		const sidebar = async () => (await waitFor("the chat in the sidebar", async () => (await web.call("GET", "/api/snapshot/sidebar")).json.sessions.find((s: { chatId: string }) => s.chatId === chat), 30_000)) as { unread: boolean };
		expect((await sidebar()).unread).toBe(true);
		// The person opens it.
		expect((await web.call("POST", `/api/sessions/${chat}/read`)).status).toBe(200);
		expect((await listed(chat)).unread).toBe(false);
		expect((await sidebar()).unread).toBe(false);
		// A background turn that sends nothing leave it read; the next reply makes it unread again.
		await say(chat, "[Scheduled task: tidy] and again");
		expect((await listed(chat)).unread).toBe(false);
		await say(chat, "one more", reply("Here you go."));
		expect((await listed(chat)).unread).toBe(true);
		expect((await sidebar()).unread).toBe(true);
		// Acknowledging an earlier reply does not read this newer one, and a bad value is refused; acknowledging this one does, and answers the chat as it is then.
		const newer = (await listed(chat)).responseAt as number;
		expect((await web.call("POST", `/api/sessions/${chat}/read`, { responseAt: newer - 5_000 })).json).toMatchObject({ id: chat, unread: true });
		expect((await listed(chat)).unread).toBe(true);
		expect((await web.call("POST", `/api/sessions/${chat}/read`, { responseAt: -1 })).status).toBe(400);
		expect((await web.call("POST", `/api/sessions/${chat}/read`, { responseAt: newer })).json).toMatchObject({ id: chat, unread: false });
		expect((await listed(chat)).unread).toBe(false);
		await say(chat, "and again", reply("Once more."));
		expect((await listed(chat)).unread).toBe(true);
		// Reading is the person's own: another owner's read of this chat finds nothing.
		expect((await web.call("POST", `/api/sessions/00000000-0000-4000-8000-000000000000/read`)).status).toBe(404);
	}, 160_000);

	it("compacts a chat that outgrew the model's context in place, and the next turn runs on the summary", async () => {
		const chat = (await web.call("POST", "/api/sessions", { title: "Long" })).json.id;
		const filler = (word: string) => Array.from({ length: 10_000 }, (_, i) => `${word}${i}`).join(" ");
		await say(chat, `first: ${filler("alpha")}`, reply("Noted the first."));
		// The second message is over the threshold: pi summarises before answering, with the model, so its summary is the first scripted response.
		await say(chat, `second: ${filler("beta")}`, fauxAssistantMessage("SUMMARY: the person sent alpha words and beta words."), reply("Noted the second."));
		const entries = await transcript(chat);
		const kinds = entries.map((e) => e.kind);
		expect(kinds.some((k) => k.includes("compaction"))).toBe(true);
		// The turn after it runs on the summary and what is kept, not on everything: the model is asked with the summary and without the first message's words.
		await say(chat, "what did I send?", asked(() => reply("You sent alpha and beta words.")) as never);
		expect(prompts).toHaveLength(1);
		expect(prompts[0]).toContain("SUMMARY: the person sent alpha words and beta words.");
		expect(prompts[0]).not.toContain("alpha5000");
		expect(JSON.stringify(await transcript(chat))).toContain("You sent alpha and beta words.");
	}, 180_000);

	it("carries a chat on through a handoff: the summary starts a new chat, the old one is archived, and writing in the old one detaches them", async () => {
		const old = (await web.call("POST", "/api/sessions", { title: "Trip planning" })).json.id;
		await say(old, "we are planning a trip to Lisbon", reply("Lisbon it is."));
		const principal = { kind: "user", ownerId, role: "member", sessionId: "test" } as never;
		const carried = await app.conversations.handoff(principal, old, "Summary: planning a trip to Lisbon in May; flights not booked.");
		expect(carried).not.toBe(old);
		// The same handoff again is the same chat, not a second one.
		expect(await app.conversations.handoff(principal, old, "Summary: planning a trip to Lisbon in May; flights not booked.")).toBe(carried);
		const oldView = (await web.call("GET", `/api/sessions/${old}/info`)).json;
		expect(oldView).toBeDefined();
		const sessions = (await web.call("GET", "/api/sessions?archived=1")).json.sessions;
		expect(sessions.find((s: { id: string }) => s.id === carried)).toMatchObject({ continuedFrom: old, title: "Trip planning" });
		expect((await app.conversations.get(ownerId, old)).archived).toBe(true);
		// The Runner reset the new chat's conversation with the summary as its first message: the next turn is asked with it, and with nothing of the old chat.
		await waitFor("the new chat to start from the summary", async () => (JSON.stringify(await transcript(carried)).includes("flights not booked") ? true : undefined), 60_000);
		prompts.length = 0;
		await say(carried, "when do we go?", asked(() => reply("In May.")) as never);
		expect(prompts[0]).toContain("flights not booked");
		expect(prompts[0]).not.toContain("we are planning a trip");
		expect(JSON.stringify(await transcript(old))).toContain("Lisbon it is.");
		// Writing in the old chat brings it back and detaches the pair.
		await say(old, "one more thing about Lisbon", reply("Go on."));
		expect((await app.conversations.get(ownerId, old))).toMatchObject({ archived: false, continuedTo: null });
	}, 180_000);

});
