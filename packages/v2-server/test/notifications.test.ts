// Notifications and Web Push over a real PostgreSQL and the real migrations, as the maintenance role runs them: what is announced from committed rows (an approval
// waiting, a reply the runtime committed, a mention), what the bell and the subscription routes answer, and what is sent to a stand-in push service, signed with
// the deployment's VAPID key. Nothing here reaches a real push service.
import { createServer, type Server } from "node:http";
import { webcrypto } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import pg from "pg";
import { App } from "@pim/v2-app/app";
import { connect } from "@pim/v2-app/db";
import { createGate } from "@pim/v2-app/gate";
import { MemoryObjectStore } from "@pim/v2-app/objects";
import { notificationRoutes } from "../src/compat/notifications.ts";
import { lastSaid, mentionsPerson, notifyPass, REPLY_DELAY_MS, type NotifierOptions } from "../src/notifier.ts";
import { fromBase64Url, toBase64Url, vapidFromEnv } from "../src/push.ts";
import { createStack, type Stack } from "./support/stack.ts";

const subtle = webcrypto.subtle;

/** A browser's push subscription: a real P-256 key and auth secret, so the message can be encrypted to it. */
async function browser(endpoint: string) {
	const pair = (await subtle.generateKey({ name: "ECDH", namedCurve: "P-256" }, true, ["deriveBits"])) as webcrypto.CryptoKeyPair;
	return { endpoint, p256dh: toBase64Url(await subtle.exportKey("raw", pair.publicKey)), auth: toBase64Url(webcrypto.getRandomValues(new Uint8Array(16))) };
}

let stack: Stack;
let gate: App;
let maint: App;
let maintPool: pg.Pool;
let server: Server;
let base: string;
let env: Record<string, string>;
let options: NotifierOptions;
const people: Record<string, { ownerId: string; token: string; chat: string }> = {};
/** What the stand-in push service received, and what it answers next. */
const pushed: { url: string; authorization: string }[] = [];
let answer = 201;

const call = async (token: string, method: string, path: string, body?: unknown) => {
	const response = await fetch(base + path, { method, headers: { authorization: `Bearer ${token}`, ...(body === undefined ? {} : { "content-type": "application/json" }) }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
	const text = await response.text();
	return { status: response.status, body: text.startsWith("{") ? JSON.parse(text) : text };
};
const standIn: typeof fetch = async (url, init) => {
	pushed.push({ url: String(url), authorization: String((init?.headers as Record<string, string>).Authorization) });
	if (answer === 0) throw new Error("connection refused");
	return new Response(null, { status: answer });
};

/** What the runtime commits for a chat: the person's message and the agent's `send_to_user` call. Only then does the Runner report the reply. */
async function agentSays(who: string, message: string, options: { personAsked?: boolean; commit?: boolean } = {}) {
	const { ownerId, chat } = people[who]!;
	const row = (await stack.admin.query("SELECT partition_id, conversation_id FROM pim_app.conversations WHERE public_chat_id = $1", [chat])).rows[0];
	await stack.admin.query("INSERT INTO pim_runtime.partitions (owner_id, partition_id) VALUES ($1,$2) ON CONFLICT DO NOTHING", [ownerId, row.partition_id]);
	// The runtime keeps its own map from a chat to its conversation, which is not the application's number once the runtime has moved it.
	await stack.admin.query("INSERT INTO pim_runtime.conversation_partitions (owner_id, conversation_id, partition_id, public_chat_id) VALUES ($1,$2,$3,$4) ON CONFLICT DO NOTHING", [ownerId, Number(row.conversation_id) + 100, row.partition_id, chat]);
	const next = Number((await stack.admin.query("SELECT coalesce(max(id), 0) + 1 AS n FROM pim_runtime.entries WHERE owner_id = $1", [ownerId])).rows[0].n);
	const records = [
		...(options.personAsked === false ? [] : [{ role: "user", content: "hello" }]),
		...(options.commit === false ? [] : [{ role: "assistant", content: [{ type: "toolCall", id: `c${next}`, name: "send_to_user", arguments: { message } }] }]),
	];
	for (const [i, model] of records.entries()) {
		await stack.admin.query("INSERT INTO pim_runtime.entries (owner_id, partition_id, id, conversation_id, commit_seq, record) VALUES ($1,$2,$3,$4,$3,$5)", [ownerId, row.partition_id, next + i, Number(row.conversation_id) + 100, JSON.stringify({ id: next + i, kind: "pi.message", model: [model] })]);
	}
	const at = new Date();
	await gate.conversations.markResponse(ownerId, chat, at);
	return at;
}
/** What a gated tool call leaves: an approval row waiting for the person. */
let approvals = 0;
const fileApproval = (who: string, summary: string) =>
	gate.db.owner(people[who]!.ownerId, (tx) => tx.query("INSERT INTO pim_app.approvals (id, owner_id, public_chat_id, tool, args) VALUES ($1,$2,$3,'http_request',$4)", [`ap_${++approvals}`, people[who]!.ownerId, people[who]!.chat, JSON.stringify({ summary })]));
const queue = async () => (await stack.admin.query("SELECT id, kind, state, asked FROM pim_app.push_queue ORDER BY created_at, id")).rows;

beforeAll(async () => {
	stack = await createStack();
	gate = new App(connect(stack.url("gate"), 4), new MemoryObjectStore());
	maint = new App(connect(stack.url("maintenance"), 4), new MemoryObjectStore());
	maintPool = new pg.Pool({ connectionString: stack.url("maintenance"), max: 4 }).on("error", () => {});
	const pair = (await subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, ["sign", "verify"])) as webcrypto.CryptoKeyPair;
	env = { PIM_VAPID_PUBLIC_KEY: toBase64Url(await subtle.exportKey("raw", pair.publicKey)), PIM_VAPID_PRIVATE_KEY: ((await subtle.exportKey("jwk", pair.privateKey)) as { d: string }).d, PIM_PUSH_ALLOW_PRIVATE: "1" };
	options = { vapid: vapidFromEnv(env), subject: "https://pim.test", allowPrivate: true, fetch: standIn };
	server = createGate(gate, { first: notificationRoutes(env) });
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
	base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
	const claim = await gate.identity.issueClaim("bootstrap", null, 3_600_000);
	const ada = await gate.identity.register({ username: "ada", bootstrap: claim });
	await gate.identity.setRegistrationOpen((await gate.identity.authenticate(await gate.identity.createSession(ada.ownerId))) as never, true);
	const bob = await gate.identity.register({ username: "bob" });
	for (const [name, a] of [["ada", ada], ["bob", bob]] as const) {
		const token = await gate.identity.createSession(a.ownerId);
		const principal = (await gate.identity.authenticate(token))!;
		people[name] = { ownerId: a.ownerId, token, chat: await gate.conversations.create(principal as never, { title: `${name}'s chat` }) };
	}
}, 120_000);
afterAll(async () => {
	server?.close();
	await maintPool?.end();
	await gate?.db.end();
	await maint?.db.end();
	await stack?.drop();
});

describe("what is read from committed entries", () => {
	it("finds the agent's last message, whether the person spoke since the one before it, and whether @name names the person", () => {
		const user = { model: [{ role: "user", content: "hi" }] };
		const say = (message: string) => ({ model: [{ role: "assistant", content: [{ type: "text", text: "thinking" }, { type: "toolCall", id: "x", name: "send_to_user", arguments: { message } }] }] });
		expect(lastSaid([say("two"), user, say("one")])).toEqual({ message: "two", asked: true });
		expect(lastSaid([say("two"), say("one"), user])).toEqual({ message: "two", asked: false });
		expect(lastSaid([{ model: [{ role: "assistant", content: [{ type: "toolCall", id: "y", name: "other", arguments: {} }] }] }])).toBeUndefined();
		expect(mentionsPerson("@Ada, a word", ["ada"])).toBe(true);
		expect(mentionsPerson("mail ada@example.com or @adam", ["ada"])).toBe(false);
	});
});

describe("push subscriptions", () => {
	it("hands out the deployment's public key, keeps a person's subscription, refuses a malformed one, and forgets it on request", async () => {
		const ada = people.ada!;
		expect((await call(ada.token, "GET", "/api/push/key")).body).toEqual({ publicKey: env.PIM_VAPID_PUBLIC_KEY });
		expect((await call(ada.token, "PUT", "/api/push/subscription", { endpoint: "http://x.test/p", p256dh: "a", auth: "b" })).status).toBe(400);
		const sub = await browser("http://127.0.0.1:9/push/ada");
		expect((await call(ada.token, "PUT", "/api/push/subscription", sub)).body).toEqual({ subscribed: true });
		expect((await call(ada.token, "PUT", "/api/push/subscription", sub)).status).toBe(200);
		expect((await stack.admin.query("SELECT owner_id FROM pim_app.push_subscriptions")).rows).toEqual([{ owner_id: ada.ownerId }]);
		const other = await browser("http://127.0.0.1:9/push/bob");
		await call(people.bob!.token, "PUT", "/api/push/subscription", other);
		await call(people.bob!.token, "DELETE", "/api/push/subscription", { endpoint: sub.endpoint });
		expect(Number((await stack.admin.query("SELECT count(*) n FROM pim_app.push_subscriptions")).rows[0].n)).toBe(2);
		await call(people.bob!.token, "DELETE", "/api/push/subscription", { endpoint: other.endpoint });
		expect(Number((await stack.admin.query("SELECT count(*) n FROM pim_app.push_subscriptions")).rows[0].n)).toBe(1);
	});

	it("answers as unavailable when the deployment has no keys", async () => {
		const bare = createGate(gate, { first: notificationRoutes({}) });
		await new Promise<void>((resolve) => bare.listen(0, "127.0.0.1", resolve));
		const response = await fetch(`http://127.0.0.1:${(bare.address() as { port: number }).port}/api/push/key`, { headers: { authorization: `Bearer ${people.ada!.token}` } });
		bare.close();
		expect(response.status).toBeGreaterThanOrEqual(400);
		expect(vapidFromEnv({ PIM_VAPID_PUBLIC_KEY: "x", PIM_VAPID_PRIVATE_KEY: "y" })).toBeUndefined();
	});
});

describe("an approval waiting", () => {
	it("is announced once, to its owner alone, in the bell and to the devices with a message signed by the deployment's key", async () => {
		const ada = people.ada!;
		await fileApproval("ada", "GET https://example.com");
		pushed.length = 0;
		expect(await notifyPass(maint, maintPool, options)).toBe(2);
		expect(await notifyPass(maint, maintPool, options)).toBe(0);
		const [note] = (await call(ada.token, "GET", "/api/notifications")).body.notifications;
		expect(note).toMatchObject({ kind: "general", session: ada.chat, title: "Pim needs your approval", readAt: null });
		expect(note.body).toContain("GET https://example.com");
		expect((await call(people.bob!.token, "GET", "/api/notifications")).body.notifications).toEqual([]);
		expect(pushed).toHaveLength(1);
		expect(pushed[0]!.url).toBe("http://127.0.0.1:9/push/ada");
		// The VAPID JWT verifies against the public key the browser subscribed with.
		const [, token, key] = /^vapid t=([^,]+), k=(.+)$/.exec(pushed[0]!.authorization)!.slice(0, 3) as [string, string, string];
		expect(key).toBe(env.PIM_VAPID_PUBLIC_KEY);
		const [h, c, s] = token.split(".") as [string, string, string];
		const publicKey = await subtle.importKey("raw", fromBase64Url(key), { name: "ECDSA", namedCurve: "P-256" }, false, ["verify"]);
		expect(await subtle.verify({ name: "ECDSA", hash: "SHA-256" }, publicKey, fromBase64Url(s), new TextEncoder().encode(`${h}.${c}`))).toBe(true);
		expect(JSON.parse(Buffer.from(fromBase64Url(c)).toString())).toMatchObject({ aud: "http://127.0.0.1:9", sub: "https://pim.test" });
		// Read state.
		expect((await call(ada.token, "POST", `/api/notifications/${note.id}/read`)).body.readAt).toBeGreaterThan(0);
		expect((await call(ada.token, "GET", "/api/notifications?unread=true")).body.notifications).toEqual([]);
		expect((await call(people.bob!.token, "POST", `/api/notifications/${note.id}/read`)).status).toBe(404);
	});
});

describe("replies and mentions", () => {
	it("announces nothing for a reply whose text is not committed, and sends an answer to something asked only while the chat is unread", async () => {
		const ada = people.ada!;
		const before = (await queue()).length;
		await agentSays("ada", "ghost", { commit: false });
		expect(await notifyPass(maint, maintPool, options)).toBe(0);
		expect((await queue()).length).toBe(before);

		await agentSays("ada", "Here is the answer you asked for.");
		pushed.length = 0;
		const now = new Date(Date.now() + 1000);
		expect(await notifyPass(maint, maintPool, { ...options, now: () => now })).toBe(1);
		expect(pushed).toHaveLength(0);
		const later = new Date(now.getTime() + REPLY_DELAY_MS + 1000);
		expect(await notifyPass(maint, maintPool, { ...options, now: () => later })).toBe(1);
		expect(pushed).toHaveLength(1);
		expect((await queue()).at(-1)).toMatchObject({ kind: "reply", state: "sent", asked: true });
		// An answer is no bell entry.
		expect((await call(ada.token, "GET", "/api/notifications")).body.notifications).toHaveLength(1);

		// Read before the alert is due: dropped.
		await agentSays("ada", "Another answer.");
		await notifyPass(maint, maintPool, { ...options, now: () => later });
		await gate.db.owner(ada.ownerId, (tx) => tx.query("UPDATE pim_app.conversations SET read_at = now() + interval '1 minute' WHERE public_chat_id = $1", [ada.chat]));
		pushed.length = 0;
		const muchLater = new Date(later.getTime() + 60_000);
		await notifyPass(maint, maintPool, { ...options, now: () => muchLater });
		expect(pushed).toHaveLength(0);
		expect((await queue()).at(-1)).toMatchObject({ state: "dropped" });
	});

	it("keeps an unasked message quiet unless the person wants every message", async () => {
		const ada = people.ada!;
		await gate.db.owner(ada.ownerId, (tx) => tx.query("UPDATE pim_app.conversations SET read_at = NULL WHERE public_chat_id = $1", [ada.chat]));
		await agentSays("ada", "Unprompted news.", { personAsked: false });
		const at = new Date(Date.now() + REPLY_DELAY_MS + 5000);
		pushed.length = 0;
		await notifyPass(maint, maintPool, { ...options, now: () => at });
		await notifyPass(maint, maintPool, { ...options, now: () => new Date(at.getTime() + REPLY_DELAY_MS + 1000) });
		expect(pushed).toHaveLength(0);
		expect((await queue()).at(-1)).toMatchObject({ asked: false, state: "dropped" });

		// Settings → General → "Every message", as the settings route stores it.
		await gate.db.owner(ada.ownerId, (tx) => tx.query("INSERT INTO pim_app.owner_settings (owner_id, key, value) VALUES ($1, 'settings.deviceAlerts', '\"all\"')", [ada.ownerId]));
		await agentSays("ada", "More unprompted news.", { personAsked: false });
		await notifyPass(maint, maintPool, { ...options, now: () => at });
		pushed.length = 0;
		await notifyPass(maint, maintPool, { ...options, now: () => new Date(at.getTime() + REPLY_DELAY_MS + 1000) });
		expect(pushed).toHaveLength(1);
	});

	it("makes a mention a notification of its own kind, and reading the chat reads it", async () => {
		const ada = people.ada!;
		await agentSays("ada", "@ada I need a decision from you.");
		pushed.length = 0;
		await notifyPass(maint, maintPool, options);
		const mention = (await call(ada.token, "GET", "/api/notifications")).body.notifications.find((n: { kind: string }) => n.kind === "mention");
		expect(mention).toMatchObject({ title: "Pim mentioned you", session: ada.chat, readAt: null });
		expect(pushed).toHaveLength(1);
		await call(ada.token, "POST", `/api/sessions/${ada.chat}/read`);
		expect((await call(ada.token, "GET", "/api/notifications?unread=true")).body.notifications.find((n: { kind: string }) => n.kind === "mention")).toBeUndefined();
	});
});

describe("a push that cannot be sent now", () => {
	it("stays queued across passes (and so a restart) until it is sent, and a subscription the service says is gone is forgotten", async () => {
		const ada = people.ada!;
		await gate.db.owner(ada.ownerId, (tx) => tx.query("DELETE FROM pim_app.push_queue"));
		await fileApproval("ada", "Send a note");
		answer = 0;
		pushed.length = 0;
		await notifyPass(maint, maintPool, options);
		expect(pushed).toHaveLength(1);
		expect((await queue()).at(-1)).toMatchObject({ state: "pending" });
		// Not before its retry time; then, from a fresh pass (as after a restart), delivered.
		await notifyPass(maint, maintPool, options);
		expect(pushed).toHaveLength(1);
		answer = 201;
		await notifyPass(maint, maintPool, { ...options, now: () => new Date(Date.now() + 90_000) });
		expect(pushed).toHaveLength(2);
		expect((await queue()).at(-1)).toMatchObject({ state: "sent" });

		answer = 410;
		await fileApproval("ada", "Send another");
		await notifyPass(maint, maintPool, options);
		answer = 201;
		expect(Number((await stack.admin.query("SELECT count(*) n FROM pim_app.push_subscriptions WHERE owner_id = $1", [ada.ownerId])).rows[0].n)).toBe(0);
	});
});
