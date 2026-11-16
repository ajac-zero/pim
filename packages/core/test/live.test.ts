import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { acceptCommand, createChat } from "../src/commands.ts";
import { withTenant } from "../src/db.ts";
import { IdAllocator } from "../src/ids.ts";
import { LiveHub, LiveSession, ownerMayRead, StreamSource, type ServerMessage } from "../src/live.ts";
import { projectOnce, pruneStreams } from "../src/projector.ts";
import { provisionTenant } from "../src/partitions.ts";
import { Runner } from "../src/runner.ts";
import { chatSnapshot } from "../src/snapshot.ts";
import { createTestDb, type TestDb } from "./support/db.ts";
import { scriptedModel, until } from "./support/harness.ts";
import { tenantWithPeople } from "./support/people.ts";
import { fauxAssistantMessage } from "@earendil-works/pi-ai/providers/faux";

let db: TestDb;
beforeAll(async () => {
	db = await createTestDb(20);
});
afterAll(async () => db.close());

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** A tenant with a person and one answered chat, run by a real Runner. Returns what a test needs to drive more turns. */
async function chatWithHistory(turns = 3) {
	const t = await tenantWithPeople(db);
	const m = scriptedModel();
	m.faux.setResponses(Array.from({ length: 200 }, (_, i) => fauxAssistantMessage(`a${i}`)));
	const ids = new IdAllocator(db.runtime, 100);
	const runner = new Runner({ ownerId: "live-r", steward: db.steward, deps: { pool: db.runtime, ids, leaseTtlMs: 3000, pollMs: 20, harnessOptions: () => m.options() } });
	const chat = await createChat(db.gate, { tenantId: t.tenantId, commandId: `c-${t.tenantId}`, actor: "ada", agent: m.agent, firstMessage: "t0" });
	const answers = async () => (await db.admin.query("SELECT count(*)::int AS n FROM rt.entries WHERE partition_id = $1 AND record LIKE '%pi.assistant%'", [chat.partitionId])).rows[0].n as number;
	await runner.claimOnce();
	await until(async () => (await answers()) === 1, "first answer");
	// The owner unloads once the family is quiescent; a command sent before then is delivered by the owner itself, one sent after needs a claim.
	const unloaded = () => until(() => runner.hosts.size === 0, "the owner to unload");
	await unloaded();
	const conv = (await db.admin.query("SELECT conversation_id FROM app.chats WHERE chat_id = $1", [chat.chatId])).rows[0].conversation_id as number;
	const send = async (n: number) => {
		await acceptCommand(db.gate, { tenantId: t.tenantId, commandId: `m${n}-${chat.chatId}`, actor: "ada", kind: "chat.send", partitionId: chat.partitionId, payload: { conversationId: conv, content: `t${n}` }, signal: { kind: "input" } });
		await runner.claimOnce();
		await until(async () => (await answers()) === n + 1, `answer ${n}`);
		await unloaded();
	};
	for (let n = 1; n < turns; n++) await send(n);
	return { t, chat, conv, runner, send, answers, ids };
}

const collect = () => {
	const messages: ServerMessage[] = [];
	return { messages, send: (m: ServerMessage) => void messages.push(m), events: () => messages.flatMap((m) => (m.type === "events" ? m.events : [])) };
};

describe("snapshot, high-water and replay bridge", () => {
	it("starts from an HTTP snapshot and a cursor, and delivers every later commit once, in order, with no gap", async () => {
		const h = await chatWithHistory(2);
		const ada = await h.t.login("ada");
		const source = new StreamSource(db.live);
		const out = collect();
		const session = new LiveSession(source, ada, out.send, { mayRead: ownerMayRead });
		const stream = `chat:${h.chat.chatId}`;
		await session.subscribe(stream);
		const need = out.messages.find((m) => m.type === "snapshot_required");
		expect(need).toMatchObject({ reason: "no_cursor" });
		// The snapshot works with no Live and no owner: Gate-side, straight from PostgreSQL.
		const snap = (await chatSnapshot(db.gate, h.ids, h.t.tenantId, h.chat.chatId))!;
		expect(snap.entries.length).toBeGreaterThanOrEqual(4);
		expect(snap.highWater).toBeGreaterThanOrEqual((need as { highWater: number }).highWater);
		await session.subscribe(stream, snap.highWater);
		await h.send(2);
		await h.send(3);
		await session.pump(stream);
		const cursors = out.events().map((e) => e.cursor);
		expect(cursors.length).toBeGreaterThan(0);
		expect(cursors[0]).toBeGreaterThan(snap.highWater);
		for (let i = 1; i < cursors.length; i++) expect(cursors[i]).toBeGreaterThan(cursors[i - 1]!);
		// Every commit after the snapshot is accounted for.
		const all = (await db.admin.query("SELECT seq FROM rt.commits WHERE partition_id = $1 AND seq > $2 ORDER BY seq", [h.chat.partitionId, snap.highWater])).rows.map((r) => r.seq);
		expect(cursors).toEqual(all);
		expect(new Set(out.events().map((e) => e.eventId)).size).toBe(cursors.length);
		await h.runner.drain();
	});

	it("repairs a gap from the durable cursor after Live restarts, and the hub delivers without hints by polling", async () => {
		const h = await chatWithHistory(2);
		const ada = await h.t.login("ada");
		const stream = `chat:${h.chat.chatId}`;
		const before = (await chatSnapshot(db.gate, h.ids, h.t.tenantId, h.chat.chatId))!.highWater;
		// "Live" is down while two more turns commit; a new Live process starts with the client's old cursor.
		await h.send(2);
		await h.send(3);
		const source = new StreamSource(db.live);
		const hub = new LiveHub(source, 30);
		const out = collect();
		const session = new LiveSession(source, ada, out.send, { mayRead: ownerMayRead });
		hub.sessions.add(session);
		hub.start();
		await session.subscribe(stream, before);
		const expected = (await db.admin.query("SELECT count(*)::int AS n FROM rt.commits WHERE partition_id = $1 AND seq > $2", [h.chat.partitionId, before])).rows[0].n;
		expect(out.events().length).toBe(expected);
		// A turn that happens while subscribed arrives through the hub's poll alone.
		const n = out.events().length;
		await h.send(4);
		await until(() => out.events().length > n, "poll delivery");
		hub.stop();
		await h.runner.drain();
	});
});

describe("isolation, limits and overflow", () => {
	it("does not reveal another account's chat, and lets a member read only their own", async () => {
		const a = await chatWithHistory(1);
		const other = await tenantWithPeople(db);
		const source = new StreamSource(db.live);
		const stream = `chat:${a.chat.chatId}`;
		const intruder = collect();
		await new LiveSession(source, await other.login("ada"), intruder.send, { mayRead: ownerMayRead }).subscribe(stream, 0);
		expect(intruder.messages).toEqual([{ type: "error", stream, code: "not_found", message: "No such stream" }]);
		// Same tenant, different person: the chat is ada's.
		await withTenant(db.gate, a.t.tenantId, (q) => q.run("INSERT INTO app.users (tenant_id, user_id, username, role) VALUES ($1, 'bob', 'bob', 'member')", a.t.tenantId));
		const peer = collect();
		const bob = (await import("../src/auth.ts")).authenticate(db.gate, a.t.tenantId, await (await import("../src/auth.ts")).createSession(db.gate, a.t.tenantId, "bob"));
		await new LiveSession(source, (await bob)!, peer.send, { mayRead: ownerMayRead }).subscribe(stream, 0);
		expect(peer.messages[0]).toMatchObject({ type: "error", code: "not_found" });
		await a.runner.drain();
	});

	it("limits how many streams one connection follows", async () => {
		const a = await chatWithHistory(1);
		const out = collect();
		const session = new LiveSession(new StreamSource(db.live), await a.t.login("ada"), out.send, { mayRead: ownerMayRead, maxStreams: 1 });
		await session.subscribe("list", 0);
		await session.subscribe(`chat:${a.chat.chatId}`, 0);
		expect(out.messages.at(-1)).toMatchObject({ type: "error", code: "too_many_streams" });
		await a.runner.drain();
	});

	it("holds nothing for a slow client: no events while backpressured, then one coalesced catch-up that names every changed record", async () => {
		const a = await chatWithHistory(1);
		const stream = `chat:${a.chat.chatId}`;
		const start = (await chatSnapshot(db.gate, a.ids, a.t.tenantId, a.chat.chatId))!.highWater;
		let slow = true;
		const out = collect();
		const session = new LiveSession(new StreamSource(db.live), await a.t.login("ada"), out.send, { mayRead: ownerMayRead, backpressured: () => slow, batch: 3 });
		await session.subscribe(stream, start);
		await a.send(1);
		await a.send(2);
		await session.pump(stream);
		expect(out.events().length).toBe(0);
		expect(session.subs.get(stream)!.cursor).toBe(start);
		slow = false;
		await session.pump(stream);
		const merged = out.messages.filter((m) => m.type === "events" && m.coalesced);
		expect(merged.length).toBeGreaterThan(0);
		const changed = new Set(merged.flatMap((m) => (m as { events: { payload: { changes: { t: string; id: number }[] } }[] }).events.flatMap((e) => e.payload.changes.map((c) => `${c.t}:${c.id}`))));
		const entries = (await db.admin.query("SELECT id FROM rt.entries WHERE partition_id = $1 AND commit_seq > $2", [a.chat.partitionId, start])).rows;
		const delivered = out.events().flatMap((e) => (e.kind === "commit.coalesced" ? (e.payload as { changes: { t: string; id: number }[] }).changes : (e.payload as { t: string; id: number }[]))).map((c) => `${c.t}:${c.id}`);
		for (const e of entries) expect(new Set([...changed, ...delivered]).has(`entry:${e.id}`)).toBe(true);
		expect(session.subs.get(stream)!.cursor).toBe((await db.admin.query("SELECT max(seq) AS n FROM rt.commits WHERE partition_id = $1", [a.chat.partitionId])).rows[0].n);
		await a.runner.drain();
	});

	it("tells a client whose cursor was pruned to take a new snapshot, and rejects a cursor from the future", async () => {
		const a = await chatWithHistory(3);
		const stream = `chat:${a.chat.chatId}`;
		await projectOnce({ steward: db.steward, runtime: db.runtime });
		await sleep(20);
		const pruned = await pruneStreams(db.maint, 1);
		expect(pruned.commits).toBeGreaterThan(0);
		const out = collect();
		const session = new LiveSession(new StreamSource(db.live), await a.t.login("ada"), out.send, { mayRead: ownerMayRead });
		await session.subscribe(stream, 1);
		expect(out.messages.at(-1)).toMatchObject({ type: "snapshot_required", reason: "retention" });
		const future = collect();
		await new LiveSession(new StreamSource(db.live), await a.t.login("ada"), future.send, { mayRead: ownerMayRead }).subscribe(stream, 10_000_000);
		expect(future.messages.at(-1)).toMatchObject({ type: "snapshot_required", reason: "ahead" });
		await a.runner.drain();
	});
});

describe("projection", () => {
	it("projects commits into stable, idempotent list events with a monotonic cursor, and updates the chat row", async () => {
		const a = await chatWithHistory(2);
		const first = await projectOnce({ steward: db.steward, runtime: db.runtime });
		expect(first).toBeGreaterThan(0);
		expect(await projectOnce({ steward: db.steward, runtime: db.runtime })).toBe(0);
		await a.send(2);
		expect(await projectOnce({ steward: db.steward, runtime: db.runtime })).toBeGreaterThan(0);
		const rows = (await db.admin.query("SELECT cursor, event_id FROM app.view_events WHERE tenant_id = $1 AND stream = 'list' ORDER BY cursor", [a.t.tenantId])).rows;
		expect(rows.map((r) => r.cursor)).toEqual(rows.map((_, i) => i + 1));
		expect(new Set(rows.map((r) => r.event_id)).size).toBe(rows.length);
		const chat = (await db.admin.query("SELECT last_seq FROM app.chats WHERE chat_id = $1", [a.chat.chatId])).rows[0];
		expect(chat.last_seq).toBe((await db.admin.query("SELECT max(seq) AS n FROM rt.commits WHERE partition_id = $1", [a.chat.partitionId])).rows[0].n);
		// The list stream replays through Live the same way.
		const out = collect();
		await new LiveSession(new StreamSource(db.live), await a.t.login("ada"), out.send, { mayRead: ownerMayRead }).subscribe("list", 0);
		expect(out.events().map((e) => e.cursor)).toEqual(rows.map((r) => r.cursor));
		await a.runner.drain();
		void provisionTenant;
	});
});
