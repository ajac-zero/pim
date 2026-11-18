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
import { createStack, describeWith, freePort, hasNats, startNats } from "./support/stack.ts";

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
		await waitFor(`the turn "${words.slice(0, 20)}" to end`, async () => (JSON.stringify(await transcript(chat)).includes(`ended ${id}`) ? true : undefined), 60_000);
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

	it("runs a group chat: agents in seats hear the person, answer when mentioned, and speak into the host chat", async () => {
		const coach = (await web.call("POST", "/api/agents", { name: "Coach", instructions: "You coach running." })).json;
		const host = (await web.call("POST", "/api/sessions", { title: "Planning" })).json.id;
		await say(host, "hello", reply("Hi, I'm the host."));
		expect((await web.call("POST", `/api/sessions/${host}/room/members`, { agent: coach.id })).json.room).toMatchObject({ mode: "mentions", members: [{ id: coach.id, name: "Coach", busy: false }] });
		const seat = (await d.stack.admin.query("SELECT seat_chat_id FROM pim_app.room_members WHERE public_chat_id = $1", [host])).rows[0].seat_chat_id as string;
		// The seat is a conversation of its own that no list shows.
		expect((await web.call("GET", "/api/sessions")).json.sessions.map((s: { id: string }) => s.id)).not.toContain(seat);
		await waitFor("the seat to leave the sidebar", async () => (await web.call("GET", "/api/snapshot/sidebar")).json.sessions.some((s: { chatId: string }) => s.chatId === host), 30_000);
		expect((await web.call("GET", "/api/snapshot/sidebar")).json.sessions.map((s: { chatId: string }) => s.chatId)).not.toContain(seat);
		// The host's row carries the room for the app, and the list does too.
		expect((await web.call("GET", "/api/snapshot/sidebar")).json.sessions.find((s: { chatId: string }) => s.chatId === host).summary.room).toMatchObject({ mode: "mentions", members: [{ id: coach.id, name: "Coach" }] });
		expect((await listed(host)).room).toMatchObject({ mode: "mentions", members: [{ name: "Coach" }] });

		// Said to no one in particular: the host answers, and the seat only hears it.
		await say(host, "I want to run a 10k in the spring", reply("A 10k is a fine goal."));
		await waitFor("the seat to hear it", async () => (JSON.stringify(await transcript(seat)).includes("10k in the spring") ? true : undefined), 30_000);
		expect(JSON.stringify(await transcript(seat))).not.toContain("send_to_user");
		expect((await transcript(seat)).some((e) => e.kind === "pim.room")).toBe(true);

		// Mentioned: the agent answers in its seat, and what it sends lands in the host chat as its own, without waking the host.
		const hostBefore = (await transcript(host)).length;
		faux.setResponses([reply("Start with three easy runs a week."), fauxAssistantMessage("done coach")] as never);
		await web.call("POST", `/api/sessions/${host}/messages`, { commandId: "m-mention", text: "@Coach how should I start?" });
		await waitFor("the coach to answer", async () => (JSON.stringify(await transcript(seat)).includes("done coach") ? true : undefined), 60_000);
		const hostText = JSON.stringify(await transcript(host));
		await waitFor("the post in the host chat", async () => (JSON.stringify(await transcript(host)).includes("[From Coach]") ? true : undefined), 30_000);
		expect(JSON.stringify(await transcript(host))).toContain("Start with three easy runs a week.");
		// The host did not take a turn for it: nothing the host said came after the mention, and the person has a reply to read.
		const after = (await transcript(host)).slice(hostBefore);
		expect(after.filter((e) => e.kind === "pi.assistant")).toHaveLength(0);
		expect(hostText).toContain("@Coach how should I start?");
		expect((await listed(host)).unread).toBe(true);
		// Mentioning an address is not mentioning an agent.
		await say(host, "mail me at ann@Coach.example", reply("Noted."));
		expect(JSON.stringify(await transcript(seat)).split("ann@Coach.example").length).toBeGreaterThan(1);

		// In open mode everyone wakes: both answer.
		await d.stack.admin.query("UPDATE pim_app.conversations SET room_mode = 'open' WHERE public_chat_id = $1", [host]);
		const turn = (ctx: { messages?: { role: string }[] }) => ((ctx.messages ?? []).at(-1)?.role === "toolResult" ? fauxAssistantMessage("done open") : reply("I have something to add."));
		// Each agent answers and ends its turn; the post of one into the host chat may wake the next request of the other, so there is a little slack.
		faux.setResponses([turn, turn, turn, turn, turn, turn] as never);
		await web.call("POST", `/api/sessions/${host}/messages`, { commandId: "m-open", text: "what else?" });
		await waitFor("both to answer", async () => ((await transcript(seat)).some((e) => JSON.stringify(e.model ?? "").includes("\"I have something to add.\"")) && (await transcript(host)).some((e) => e.kind === "pi.assistant" && JSON.stringify(e.model ?? "").includes("I have something to add.")) ? true : undefined), 60_000);

		// Both are still in their turns, and each one's post wakes the other: let them all end before the script is replaced, or a request still on its way is answered from the next script.
		let calls = -1;
		await waitFor("the open-mode turns to end", async () => {
			const now = faux.state.callCount;
			if (now === calls) return true;
			calls = now;
			await new Promise((resolve) => setTimeout(resolve, 1_000));
			return undefined;
		}, 60_000);
		faux.setResponses([]);

		// Taking the agent out: it hears nothing more and its seat is gone.
		expect((await web.call("DELETE", `/api/sessions/${host}/room/members/${coach.id}`)).json.room).toBeNull();
		expect((await d.stack.admin.query("SELECT deleted_at FROM pim_app.conversations WHERE public_chat_id = $1", [seat])).rows[0].deleted_at).not.toBeNull();
		await say(host, "just us now", reply("Just us."));
		expect(JSON.stringify(await transcript(seat))).not.toContain("just us now");
	}, 240_000);
});
