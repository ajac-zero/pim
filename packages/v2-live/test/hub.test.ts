import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { PgAuthorizer } from "../src/server/authorizer.ts";
import { LiveHub } from "../src/server/hub.ts";
import { LogStore } from "../src/server/log-store.ts";
import { MemoryPulse } from "../src/server/pulse.ts";
import { Projector } from "../src/projections/projector.ts";
import { type Database, POSTGRES, seeded, startPostgres, until } from "./support/infra.ts";
import { FakeTransport, addAccount, assistant, commit, reset, user } from "./support/fixtures.ts";

const live = POSTGRES ? describe : describe.skip;
const FAST = { heartbeatMs: 40, revalidateMs: 60, pumpMs: 2 };

live("Live bridge over PostgreSQL", () => {
	let db: Database;
	let pulse: MemoryPulse;
	let hub: LiveHub;
	let projector: Projector;
	let log: LogStore;
	let seq = 0;

	beforeAll(async () => {
		db = await startPostgres();
	});
	afterAll(() => db?.stop());
	beforeEach(async () => {
		await reset(db.pool);
		seq = 0;
		pulse = new MemoryPulse({ random: seeded(7) });
		log = new LogStore(db.pool);
		projector = new Projector(db.pool, { pulse });
		hub = new LiveHub(log, pulse, new PgAuthorizer(db.pool, () => null), FAST);
		await addAccount(db.pool, "t1", "s1");
	});
	afterEach(() => hub.close());

	const identity = { tenantId: "t1", userId: "user-1", sessionId: "s1" };
	/** The runtime commits one message of a chat and the projector projects it. */
	async function say(text: string, chat = "c1", tenant = "t1", partial = false, id = ++seq) {
		await commit(db.pool, "p1", ++commitSeq, tenant, [{ kind: "chat.entry", chatId: chat, entry: assistant(id, text), partial }]);
		await projector.drain("p1");
	}
	let commitSeq = 0;
	beforeEach(() => {
		commitSeq = 0;
	});

	async function open(stream = "chat:c1", cursor: number | null = null, who = identity) {
		const transport = new FakeTransport();
		const connection = hub.connect(who, transport);
		await connection.receive(JSON.stringify({ type: "subscribe", stream, cursor }));
		return { transport, connection };
	}

	it("replays from a cursor then follows live, in order and exactly once", async () => {
		for (let i = 0; i < 5; i++) await say(`m${i}`);
		const { transport } = await open("chat:c1", 2);
		for (let i = 5; i < 8; i++) await say(`m${i}`);
		await until(() => transport.seqs("chat:c1").length === 6, "six events");
		expect(transport.seqs("chat:c1")).toEqual([3, 4, 5, 6, 7, 8]);
		expect(transport.of("subscribed")[0]).toMatchObject({ cursor: 2, head: 5 });
	});

	it("zero gaps and zero duplicates when commits race a subscribe, with lost and duplicated hints", async () => {
		pulse.dropRate = 0.3;
		pulse.duplicateRate = 0.3;
		const total = 120;
		const writer = (async () => {
			for (let i = 0; i < total; i++) await say(`m${i}`);
		})();
		const subscribers: Awaited<ReturnType<typeof open>>[] = [];
		for (let k = 0; k < 6; k++) {
			await new Promise((resolve) => setTimeout(resolve, 15 * k));
			subscribers.push(await open("chat:c1", null));
		}
		await writer;
		for (const { transport } of subscribers) {
			await until(() => transport.seqs("chat:c1").length >= total, "all events", 15_000);
			expect(transport.seqs("chat:c1")).toEqual(Array.from({ length: total }, (_, i) => i + 1));
			expect(transport.events("chat:c1").map((event) => event.payload.message.parts[0].text)).toEqual(Array.from({ length: total }, (_, i) => `m${i}`));
		}
		expect(pulse.published).toBeGreaterThan(0);
	});

	it("delivers every committed message when NATS is down altogether, within a heartbeat", async () => {
		const { transport } = await open();
		await say("before");
		await until(() => transport.seqs("chat:c1").length === 1, "first");
		pulse.down = true;
		const started = Date.now();
		for (let i = 0; i < 25; i++) await say(`during ${i}`);
		await until(() => transport.seqs("chat:c1").length === 26, "repair from PostgreSQL", 5_000);
		expect(transport.seqs("chat:c1")).toEqual(Array.from({ length: 26 }, (_, i) => i + 1));
		expect(Date.now() - started).toBeLessThan(2_000);
		pulse.down = false;
		await say("after");
		await until(() => transport.seqs("chat:c1").length === 27, "back on the bus");
		expect(transport.seqs("chat:c1").at(-1)).toBe(27);
	});

	it("repairs a gap in hints at once, without waiting for the heartbeat", async () => {
		const slow = new LiveHub(log, pulse, new PgAuthorizer(db.pool, () => null), { ...FAST, heartbeatMs: 60_000 });
		const transport = new FakeTransport();
		const connection = slow.connect(identity, transport);
		await connection.receive(JSON.stringify({ type: "subscribe", stream: "chat:c1", cursor: null }));
		await say("one");
		pulse.down = true;
		await say("two (hint lost)");
		pulse.down = false;
		await say("three");
		await until(() => transport.seqs("chat:c1").length === 3, "gap repaired");
		expect(transport.seqs("chat:c1")).toEqual([1, 2, 3]);
		await slow.close();
	});

	it("tells a client whose cursor cannot be served to take a snapshot", async () => {
		for (let i = 0; i < 6; i++) await say(`m${i}`);
		expect((await open("chat:c1", 99)).transport.of("snapshot_required")[0]).toMatchObject({ reason: "cursor_ahead", head: 6 });
		await db.pool.query("DELETE FROM pim_projection.live_event_log WHERE stream_seq <= 3");
		expect((await open("chat:c1", 1)).transport.of("snapshot_required")[0]).toMatchObject({ reason: "cursor_expired", head: 6 });
		const ok = await open("chat:c1", 3);
		expect(ok.transport.seqs("chat:c1")).toEqual([4, 5, 6]);
		const narrow = new LiveHub(log, pulse, new PgAuthorizer(db.pool, () => null), { ...FAST, maxReplay: 2 });
		const transport = new FakeTransport();
		await narrow.connect(identity, transport).receive(JSON.stringify({ type: "subscribe", stream: "chat:c1", cursor: 3 }));
		expect(transport.of("snapshot_required")[0]).toMatchObject({ reason: "replay_window" });
		expect(transport.of("event")).toHaveLength(0);
		await narrow.close();
	});

	it("coalesces replaceable partials for a slow client and still delivers the canonical message", async () => {
		const small = new LiveHub(log, pulse, new PgAuthorizer(db.pool, () => null), { ...FAST, maxQueueBytes: 20_000 });
		const transport = new FakeTransport();
		transport.buffer = 1_000_000; // the reader has stopped
		const connection = small.connect(identity, transport);
		await connection.receive(JSON.stringify({ type: "subscribe", stream: "chat:c1", cursor: null }));
		await say("question", "c1", "t1", false, 1);
		let text = "";
		for (let i = 0; i < 500; i++) {
			text += "tok ";
			await say(text, "c1", "t1", true, 2);
			expect(connection.queue.bytes).toBeLessThanOrEqual(20_000);
		}
		await say(text.trim(), "c1", "t1", false, 2);
		await until(() => connection.queue.length >= 3, "queued");
		// 500 partials of one message, held as one.
		expect(connection.queue.length).toBe(3);
		expect(connection.queue.coalesced).toBeGreaterThanOrEqual(499);
		transport.buffer = 0;
		await until(() => transport.events("chat:c1").length === 3, "drained");
		const events = transport.events("chat:c1");
		expect(events.map((event) => event.kind)).toEqual(["message", "message.partial", "message"]);
		expect(events.map((event) => event.seq)).toEqual([1, 501, 502]);
		expect(events[1]!.coalesced).toBe(true);
		expect(events[0]!.coalesced).toBeUndefined();
		expect(events[2]!.payload.message.parts[0].text).toBe(text.trim());
		expect(events[2]!.payload.partial).toBe(false);
		await small.close();
	});

	it("never drops a canonical message to make room: a flood it cannot hold becomes snapshot_required", async () => {
		const small = new LiveHub(log, pulse, new PgAuthorizer(db.pool, () => null), { ...FAST, maxQueueBytes: 6_000 });
		const transport = new FakeTransport();
		transport.buffer = 1_000_000;
		const connection = small.connect(identity, transport);
		await connection.receive(JSON.stringify({ type: "subscribe", stream: "chat:c1", cursor: null }));
		for (let i = 0; i < 60; i++) await say(`canonical ${i} ${"x".repeat(200)}`);
		await until(() => connection.streams.length === 0, "dropped");
		// The notice waits behind the jammed socket like everything else, and arrives once it moves.
		expect(transport.of("snapshot_required")).toHaveLength(0);
		transport.buffer = 0;
		await until(() => transport.of("snapshot_required").length > 0, "snapshot_required");
		expect(transport.of("snapshot_required")[0]).toMatchObject({ stream: "chat:c1", reason: "slow_client" });
		expect(connection.queue.bytes).toBe(0);
		expect(connection.streams).toEqual([]);
		// The client takes a snapshot and subscribes again from its cursor: nothing is missing.
		const again = new FakeTransport();
		await small.connect(identity, again).receive(JSON.stringify({ type: "subscribe", stream: "chat:c1", cursor: 0 }));
		await until(() => again.seqs("chat:c1").length === 60, "replay");
		await small.close();
	});

	it("closes with 4003 and leaks nothing further when the session is revoked, by check or by bus", async () => {
		await addAccount(db.pool, "t1", "s2");
		const a = await open("chat:c1", null);
		const b = await open("chat:c1", null, { ...identity, sessionId: "s2" });
		await say("visible");
		await until(() => a.transport.seqs("chat:c1").length === 1 && b.transport.seqs("chat:c1").length === 1, "both see it");
		// By the periodic check, with the bus down.
		pulse.down = true;
		await db.pool.query("UPDATE pim_identity.sessions SET revoked_at = now() WHERE session_id = 's1'");
		await until(() => a.transport.closed !== null, "closed by check");
		expect(a.transport.closed!.code).toBe(4003);
		await say("secret");
		await new Promise((resolve) => setTimeout(resolve, 150));
		expect(a.transport.seqs("chat:c1")).toEqual([1]);
		// By the bus, faster than the check: a suspension of the whole account.
		pulse.down = false;
		const slowCheck = new LiveHub(log, pulse, new PgAuthorizer(db.pool, () => null), { ...FAST, revalidateMs: 60_000 });
		const transport = new FakeTransport();
		await slowCheck.connect({ ...identity, sessionId: "s2" }, transport).receive(JSON.stringify({ type: "subscribe", stream: "chat:c1", cursor: null }));
		await pulse.publishRevocation("t1");
		await until(() => transport.closed !== null, "closed by bus", 500);
		expect(transport.closed!.code).toBe(4003);
		// Subscribing is checked too: a suspended account cannot start one.
		await db.pool.query("UPDATE pim_identity.accounts SET status = 'suspended' WHERE tenant_id = 't1'");
		const late = await open("chat:c1", null, { ...identity, sessionId: "s2" });
		expect(late.transport.closed?.code).toBe(4003);
		expect(late.transport.of("subscribed")).toHaveLength(0);
		await slowCheck.close();
	});

	it("serves a tenant only its own streams whatever the stream key says", async () => {
		await addAccount(db.pool, "t2", "other", "user-2");
		await say("t1 secret", "shared-name", "t1");
		await say("t2 text", "shared-name", "t2");
		const mine = await open("chat:shared-name", null, { tenantId: "t2", userId: "user-2", sessionId: "other" });
		expect(mine.transport.events("chat:shared-name").map((event) => event.payload.message.parts[0].text)).toEqual(["t2 text"]);
		const forged = await open("chat:only-in-t1", null, { tenantId: "t2", userId: "user-2", sessionId: "other" });
		await say("later", "only-in-t1", "t1");
		await new Promise((resolve) => setTimeout(resolve, 120));
		expect(forged.transport.events("chat:only-in-t1")).toHaveLength(0);
	});

	it("follows only a few streams per connection", async () => {
		const small = new LiveHub(log, pulse, new PgAuthorizer(db.pool, () => null), { ...FAST, maxStreams: 2 });
		const transport = new FakeTransport();
		const connection = small.connect(identity, transport);
		for (const stream of ["sidebar", "chat:a", "chat:b"]) await connection.receive(JSON.stringify({ type: "subscribe", stream, cursor: null }));
		expect(connection.streams).toEqual(["sidebar", "chat:a"]);
		expect(transport.of("error")[0].message).toMatch(/At most 2/);
		await small.close();
	});
});
