// The memory nap on the real stack: a chat nobody is in is read by a Runner and kept as one memory on the memory model (here pi-ai's faux provider, as a deployment's own
// provider would be), rewritten when the chat moves on, forgotten when nothing in it is worth keeping, and never written twice. A chat too short to say anything is only marked.
// The same loop summarizes a scope's memories into its tree, which the prompt shows older memories by, and builds again what a forgotten memory was in.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { fauxAssistantMessage, fauxProvider, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import { App } from "@pim/v2-app/app";
import { connect as connectApp } from "@pim/v2-app/db";
import { MemoryObjectStore } from "@pim/v2-app/objects";
import type { Process } from "../src/main.ts";
import { napMemoryId } from "../src/memory-nap.ts";
import { readTranscript, waitFor } from "../../v2-runtime/test/support/rig.ts";
import { Client } from "./support/client.ts";
import { type Deployment, base, start, startS3 } from "./support/processes.ts";
import { createStack, describeWith, freePort, hasNats, startNats, sentAndAnswered } from "./support/stack.ts";

const real = describeWith(hasNats());

real("the memory nap", () => {
	let d: Deployment;
	let gate: Process;
	let runner: Process;
	let web: Client;
	let app: App;
	let ownerId: string;
	let n = 0;
	const faux = fauxProvider({ provider: "faux", models: [{ id: "m" }] });
	// A reply in a script does not end the turn; the send `say` adds does.
	const reply = (message: string, ends = false) => fauxAssistantMessage([fauxToolCall("send_to_user", { message, ...(ends ? {} : { complete: false }) })], { stopReason: "toolUse" });

	const transcript = async (chat: string) => {
		const c = (await d.stack.admin.query("SELECT partition_id, conversation_id FROM pim_runtime.conversation_partitions WHERE public_chat_id = $1", [chat])).rows[0];
		return c ? JSON.stringify(await readTranscript(d.stack.runtime, ownerId, c.partition_id, Number(c.conversation_id))) : "";
	};
	const say = async (chat: string, words: string, ...script: unknown[]) => {
		const id = ++n;
		faux.setResponses([...script, reply(`done ${id}`, true), fauxAssistantMessage(`ended ${id}`)] as never);
		expect((await web.call("POST", `/api/sessions/${chat}/messages`, { commandId: `m-${id}`, text: words })).status).toBe(202);
		await waitFor(`the turn to end`, async () => (sentAndAnswered(await transcript(chat), `done ${id}`) ? true : undefined), 60_000);
	};
	const memory = async (chat: string) => (await d.stack.admin.query("SELECT scope, title, body, deleted_at FROM pim_app.memories WHERE id = $1", [napMemoryId(chat)])).rows[0];
	const napped = async (chat: string) => (await d.stack.admin.query("SELECT napped_at, memory_id FROM pim_app.chat_naps WHERE public_chat_id = $1", [chat])).rows[0];
	const background = async () => Number((await d.stack.admin.query("SELECT count(*) FROM pim_app.model_calls WHERE run_kind = 'background'")).rows[0].count);

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
		runner = await start(d, "runner", { pollMs: 40, providers: () => [faux.provider] }, { PIM_DEFAULT_MODEL: "faux/m", PIM_APP_DATABASE_URL: stack.url("gate"), PIM_MEMORY_NAP: "on", PIM_MEMORY_NAP_IDLE_SECONDS: "1", PIM_MEMORY_NAP_POLL_MS: "200", PIM_MEMORY_LINES: "8" });
	}, 180_000);
	afterAll(async () => {
		await Promise.allSettled([runner?.close(), gate?.close()]);
		await app?.db.end();
		d?.nats.stop();
		await d?.s3.stop();
		await d?.stack.drop();
	}, 60_000);

	it("keeps a quiet chat as one memory, rewrites it when the chat moves on, and never writes it twice", async () => {
		const chat = (await web.call("POST", "/api/sessions", { title: "Breakfast and running" })).json.id;
		await say(chat, "I prefer oat milk in my coffee, I'm training for a 10k in May, and please remember that I'm allergic to peanuts.", reply("Noted all of that."));
		faux.setResponses([fauxAssistantMessage("Preferences and health\nPrefers oat milk. Training for a 10k in May. Allergic to peanuts.")] as never);
		const first = await waitFor("the nap to write a memory", async () => (await memory(chat)) ?? undefined, 30_000);
		expect(first).toMatchObject({ scope: "everyone", title: "Preferences and health", body: "Prefers oat milk. Training for a 10k in May. Allergic to peanuts.", deleted_at: null });
		expect((await napped(chat)).memory_id).toBe(napMemoryId(chat));
		// The memory is the person's own: the memory screen lists it, and the agent's next prompt carries its title.
		expect(JSON.stringify((await web.call("GET", "/api/memory/log")).json)).toContain("Preferences and health");
		// Nothing moved, so nothing more is napped: the chat is not read again however long it is left.
		const calls = await background();
		await new Promise((resolve) => setTimeout(resolve, 2500));
		expect(await background()).toBe(calls);
		expect((await d.stack.admin.query("SELECT count(*)::int AS n FROM pim_app.memories WHERE id LIKE 'm_nap_%'")).rows[0].n).toBe(1);

		// The chat moves on: the same memory is rewritten.
		await say(chat, "Update: the 10k moved to June, and I switched to almond milk.", reply("Updated."));
		faux.setResponses([fauxAssistantMessage("Preferences, health and running\nPrefers almond milk. The 10k is in June. Allergic to peanuts.")] as never);
		await waitFor("the memory to be rewritten", async () => ((await memory(chat))?.title === "Preferences, health and running" ? true : undefined), 30_000);
		expect((await memory(chat)).body).toContain("almond milk");
		expect((await d.stack.admin.query("SELECT count(*)::int AS n FROM pim_app.memories WHERE id LIKE 'm_nap_%'")).rows[0].n).toBe(1);
		// Each nap is a model call in the ledger, as background work.
		expect(await background()).toBe(calls + 1);
	}, 180_000);

	it("marks a chat with nothing to say without asking a model, and forgets a memory the chat no longer deserves", async () => {
		const short = (await web.call("POST", "/api/sessions", { title: "Hi" })).json.id;
		const before = await background();
		await say(short, "hi", reply("Hello."));
		await waitFor("the short chat to be marked", async () => (await napped(short)) ?? undefined, 30_000);
		expect((await napped(short)).memory_id).toBeNull();
		expect(await memory(short)).toBeUndefined();
		expect(await background()).toBe(before);

		// A chat whose memory was written and then found worth nothing: the model says so, and the memory is forgotten.
		const chat = (await d.stack.admin.query("SELECT public_chat_id FROM pim_app.chat_naps WHERE memory_id IS NOT NULL")).rows[0].public_chat_id as string;
		await say(chat, "Never mind all of that, ignore everything I said about food and running, it was a joke test.", reply("Alright."));
		faux.setResponses([fauxAssistantMessage("NOTHING")] as never);
		await waitFor("the memory to be forgotten", async () => ((await memory(chat))?.deleted_at ? true : undefined), 30_000);
		expect((await napped(chat)).memory_id).toBeNull();
	}, 120_000);

	it("summarizes a scope into its tree, shows older memories by their summaries, opens one with zoom, and rebuilds what a forgotten memory was in", async () => {
		// The chat memory the tests above kept and forgot holds place 0 of everyone; 39 more memories take places 1 to 39.
		expect((await d.stack.admin.query("SELECT pos, deleted_at IS NOT NULL AS forgotten FROM pim_app.memories WHERE owner_id = $1 AND scope = 'everyone'", [ownerId])).rows).toEqual([{ pos: 0, forgotten: true }]);
		await d.stack.admin.query("INSERT INTO pim_app.memories (id, owner_id, scope, title, body) SELECT 'm_tree_' || lpad(i::text, 2, '0'), $1, 'everyone', 'fact ' || lpad(i::text, 2, '0'), 'b' FROM generate_series(1, 39) i", [ownerId]);
		expect((await d.stack.admin.query("SELECT array_agg(pos ORDER BY id) AS p FROM pim_app.memories WHERE id LIKE 'm_tree_%'")).rows[0].p).toEqual([...Array(40).keys()].slice(1));
		// The model is asked for each block that can be built, smallest first: 20 + 10 + 5 + 2 + 1, the last from its halves' summaries. An empty place is left out.
		const asked: string[] = [];
		const summarize = (context: any) => {
			const prompt = String(context.messages.at(-1).content);
			asked.push(prompt);
			return fauxAssistantMessage(`Sum ${/#(\d+-\d+) of the scope/.exec(prompt)![1]}`);
		};
		const summaries = async () => (await d.stack.admin.query("SELECT size, lo, text FROM pim_app.memory_summaries WHERE owner_id = $1 AND scope = 'everyone' ORDER BY size, lo", [ownerId])).rows;
		faux.setResponses(Array.from({ length: 38 }, () => summarize) as never);
		await waitFor("the tree to be built", async () => ((await summaries()).length === 38 ? true : undefined), 60_000);
		expect(faux.getPendingResponseCount()).toBe(0);
		expect(asked[0]).toMatch(/#0-1 of the scope everyone into one line\. Here are its memories, each with the day it was kept:\n\d{4}-\d\d-\d\d fact 01$/);
		expect(asked.at(-1)).toMatch(/#0-31 of the scope everyone into one line\. Here are the summaries of its two halves:\nSum 0-15\nSum 16-31$/);

		// The prompt shows the oldest memories by summaries and the newest as they are, and zoom opens a summary into its halves.
		const chat = (await web.call("POST", "/api/sessions", { title: "Tree" })).json.id;
		let zoomed = "";
		await say(chat, "What do you know?", fauxAssistantMessage([fauxToolCall("zoom", { id: "everyone/0-31" })], { stopReason: "toolUse" }), (context: any) => {
			zoomed = JSON.stringify(context.messages.at(-1).content);
			return reply("Here is what I know.");
		});
		// The memory section is in the transcript, where pi keeps the prompt's sections.
		const shown = await transcript(chat);
		const view = ["Scope everyone (your own):", "#everyone/0-15 Sum 0-15", "#everyone/16-23 Sum 16-23", "#everyone/24-31 Sum 24-31", "#everyone/32-35 Sum 32-35", "[m_tree_36] fact 36", "[m_tree_37] fact 37", "[m_tree_38] fact 38", "[m_tree_39] fact 39"].join("\n");
		expect(shown).toContain(JSON.stringify(view).slice(1, -1));
		expect(zoomed).toContain(JSON.stringify("#everyone/0-15 Sum 0-15\n#everyone/16-31 Sum 16-31").slice(1, -1));

		// Forgetting a memory drops every summary built over its place, and the pass builds them again without it.
		const before = asked.length;
		faux.setResponses(Array.from({ length: 5 }, () => summarize) as never);
		expect((await web.call("DELETE", "/api/memory/log/m_tree_05")).status).toBeLessThan(300);
		await waitFor("the tree to be built again", async () => ((await summaries()).length === 38 && faux.getPendingResponseCount() === 0 ? true : undefined), 60_000);
		const again = asked.slice(before);
		expect(again.map((p) => /#(\d+-\d+) of the scope/.exec(p)![1])).toEqual(["4-5", "4-7", "0-7", "0-15", "0-31"]);
		expect(again[0]).toContain("fact 04");
		expect(again[0]).not.toContain("fact 05");
	}, 180_000);
});
