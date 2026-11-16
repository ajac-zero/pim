import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { LiveHub } from "../src/server/hub.ts";
import { LogStore } from "../src/server/log-store.ts";
import { MemoryPulse } from "../src/server/pulse.ts";
import { Projector } from "../src/projections/projector.ts";
import { type Database, POSTGRES, seeded, startPostgres, until, describeWith } from "./support/infra.ts";
import { ADA, C1, FakeTransport, FixtureAuthorizer, FixtureIdentity, GRACE, Outbox, P1, addSession, assistant, principal, reset } from "./support/fixtures.ts";

const live = describeWith(!!POSTGRES);
const FAST = { heartbeatMs: 40, revalidateMs: 60, pumpMs: 2 };
const TOPIC = `chat:${C1}`;

live("Live bridge over PostgreSQL", () => {
	let db: Database;
	let outbox: Outbox;
	let pulse: MemoryPulse;
	let hub: LiveHub;
	let projector: Projector;
	let log: LogStore;
	let identity: FixtureIdentity;
	let authorizer: FixtureAuthorizer;
	let entryId = 0;

	beforeAll(async () => {
		db = await startPostgres();
		outbox = new Outbox(db.admin);
	});
	afterAll(() => db?.stop());
	const hubWith = (options = {}) => new LiveHub(log, pulse, identity, authorizer, { ...FAST, ...options });
	beforeEach(async () => {
		await reset(db.admin);
		outbox.reset();
		entryId = 0;
		pulse = new MemoryPulse({ random: seeded(7) });
		log = new LogStore(db.pool);
		projector = new Projector(db.pool, { pulse });
		identity = new FixtureIdentity(db.admin);
		authorizer = new FixtureAuthorizer();
		hub = hubWith();
		await addSession(db.admin, ADA, "s1");
	});
	afterEach(() => hub.close());

	/** The runtime commits one message of a chat and the projector projects it. */
	async function say(text: string, options: { owner?: typeof ADA; chat?: string; partial?: boolean; id?: number } = {}) {
		const owner = options.owner ?? ADA;
		await outbox.entry(P1, owner, options.chat ?? C1, assistant(options.id ?? ++entryId, text), options.partial ?? false);
		await projector.drain(owner, P1);
	}

	async function open(topic = TOPIC, cursor?: string, who = principal(ADA, "s1"), h = hub) {
		const transport = new FakeTransport();
		const connection = h.connect(who, transport);
		await connection.receive(JSON.stringify({ type: "subscribe", topic, ...(cursor === undefined ? {} : { cursor }) }));
		return { transport, connection };
	}
	const texts = (transport: FakeTransport, topic = TOPIC) => transport.events(topic).map((frame) => frame.data.message.parts[0].text);

	it("replays after a cursor, in the canonical frames, then follows live, in order and exactly once", async () => {
		for (let i = 0; i < 5; i++) await say(`m${i}`);
		const { transport } = await open(TOPIC, `${P1}:1:2`);
		for (let i = 5; i < 8; i++) await say(`m${i}`);
		await until(() => transport.events(TOPIC).length === 6, "six events");
		expect(transport.commits(TOPIC)).toEqual([3, 4, 5, 6, 7, 8]);
		expect(transport.frames.map((frame) => frame.type).slice(0, 3)).toEqual(["ack", "cursor_replay", "event"]);
		expect(transport.of("ack")[0]).toEqual({ type: "ack", cursor: `${P1}:1:2` });
		expect(transport.of("cursor_replay")[0]).toEqual({ type: "cursor_replay", topic: TOPIC, from: `${P1}:1:2`, to: `${P1}:1:5` });
		expect(transport.events(TOPIC)[0]).toMatchObject({ type: "event", kind: "message", cursor: `${P1}:1:3` });
	});

	it("stops delivering a topic after unsubscribe, keeps the others on the same connection, and ignores a topic it never followed", async () => {
		const { transport, connection } = await open(TOPIC);
		await connection.receive(JSON.stringify({ type: "subscribe", topic: "sidebar" }));
		await say("one");
		await until(() => transport.events(TOPIC).length === 1, "first message");
		await connection.receive(JSON.stringify({ type: "unsubscribe", topic: TOPIC }));
		await connection.receive(JSON.stringify({ type: "unsubscribe", topic: `chat:${"c".repeat(8)}` }));
		expect(connection.topics).toEqual(["sidebar"]);
		await outbox.commit(P1, ADA, C1, "chat.meta", { title: "t", updatedAt: 1 });
		await say("two");
		await until(() => transport.events("sidebar").length === 1, "sidebar still delivers");
		await new Promise((resolve) => setTimeout(resolve, 100));
		expect(transport.events(TOPIC)).toHaveLength(1);
		expect(transport.closed).toBeNull();
		expect(transport.of("error")).toEqual([]);
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
			subscribers.push(await open(TOPIC));
		}
		await writer;
		for (const { transport } of subscribers) {
			await until(() => transport.events(TOPIC).length >= total, "all events", 15_000);
			expect(transport.commits(TOPIC)).toEqual(Array.from({ length: total }, (_, i) => i + 1));
			expect(texts(transport)).toEqual(Array.from({ length: total }, (_, i) => `m${i}`));
		}
		expect(pulse.published).toBeGreaterThan(0);
	});

	it("delivers every committed message when NATS is down altogether, within a heartbeat", async () => {
		const { transport } = await open();
		await say("before");
		await until(() => transport.events(TOPIC).length === 1, "first");
		pulse.down = true;
		const started = Date.now();
		for (let i = 0; i < 25; i++) await say(`during ${i}`);
		await until(() => transport.events(TOPIC).length === 26, "repair from PostgreSQL", 5_000);
		expect(transport.commits(TOPIC)).toEqual(Array.from({ length: 26 }, (_, i) => i + 1));
		expect(Date.now() - started).toBeLessThan(2_000);
		pulse.down = false;
		await say("after");
		await until(() => transport.events(TOPIC).length === 27, "back on the bus");
	});

	it("repairs after a lost hint at the next hint, without waiting for the heartbeat", async () => {
		const slow = hubWith({ heartbeatMs: 60_000 });
		const { transport } = await open(TOPIC, undefined, principal(ADA, "s1"), slow);
		await say("one");
		pulse.down = true;
		await say("two (hint lost)");
		pulse.down = false;
		await say("three");
		await until(() => transport.events(TOPIC).length === 3, "gap repaired");
		expect(transport.commits(TOPIC)).toEqual([1, 2, 3]);
		await slow.close();
	});

	it("tells a client whose cursor cannot be served to take a snapshot, with the canonical reason", async () => {
		for (let i = 0; i < 6; i++) await say(`m${i}`);
		expect((await open(TOPIC, `${P1}:1:99`)).transport.of("snapshot_required")[0]).toEqual({ type: "snapshot_required", topic: TOPIC, reason: "expired" });
		expect((await open(TOPIC, `${P1}:2:3`)).transport.of("snapshot_required")[0]).toEqual({ type: "snapshot_required", topic: TOPIC, reason: "projection_version" });
		// Retention removed what the client had.
		await db.admin.query("DELETE FROM pim_projection.live_event_log WHERE stream_seq <= 3");
		expect((await open(TOPIC, `${P1}:1:1`)).transport.of("snapshot_required")[0]).toMatchObject({ reason: "expired" });
		expect((await open(TOPIC, `${P1}:1:4`)).transport.commits(TOPIC)).toEqual([5, 6]);
		// A hole in the middle of what would be replayed.
		await db.admin.query("DELETE FROM pim_projection.live_event_log WHERE stream_seq = 5");
		const holed = await open(TOPIC, `${P1}:1:4`);
		expect(holed.transport.of("snapshot_required")[0]).toMatchObject({ reason: "gap" });
		const narrow = hubWith({ maxReplay: 1 });
		expect((await open(TOPIC, `${P1}:1:4`, principal(ADA, "s1"), narrow)).transport.of("snapshot_required")[0]).toMatchObject({ reason: "expired" });
		await narrow.close();
	});

	it("coalesces replaceable partials for a slow client into one coalesced_progress and still delivers the canonical message", async () => {
		const small = hubWith({ maxQueueBytes: 20_000 });
		const transport = new FakeTransport();
		transport.buffer = 1_000_000; // the reader has stopped
		const connection = small.connect(principal(ADA, "s1"), transport);
		await connection.receive(JSON.stringify({ type: "subscribe", topic: TOPIC }));
		await say("question", { id: 1 });
		let text = "";
		for (let i = 0; i < 500; i++) {
			text += "tok ";
			await say(text, { id: 2, partial: true });
			expect(connection.queue.bytes).toBeLessThanOrEqual(20_000);
		}
		await say(text.trim(), { id: 2 });
		await until(() => connection.queue.length >= 3, "queued");
		expect(connection.queue.length).toBe(3);
		expect(connection.queue.coalesced).toBe(499);
		transport.buffer = 0;
		await until(() => transport.events(TOPIC).length === 3, "drained");
		const events = transport.events(TOPIC);
		expect(events.map((event) => event.type)).toEqual(["event", "coalesced_progress", "event"]);
		expect(events.map((event) => event.cursor)).toEqual([`${P1}:1:1`, `${P1}:1:501`, `${P1}:1:502`]);
		expect(events[1]).toMatchObject({ skipped: 499, data: { partial: true } });
		expect(events[2]).toMatchObject({ kind: "message", data: { partial: false } });
		expect(events[2]!.data.message.parts[0].text).toBe(text.trim());
		await small.close();
	});

	it("never drops a canonical message to make room: a flood it cannot hold becomes snapshot_required", async () => {
		const small = hubWith({ maxQueueBytes: 6_000 });
		const transport = new FakeTransport();
		transport.buffer = 1_000_000;
		const connection = small.connect(principal(ADA, "s1"), transport);
		await connection.receive(JSON.stringify({ type: "subscribe", topic: TOPIC }));
		for (let i = 0; i < 60; i++) await say(`canonical ${i} ${"x".repeat(200)}`);
		await until(() => connection.topics.length === 0, "dropped");
		expect(transport.of("snapshot_required")).toHaveLength(0);
		transport.buffer = 0;
		await until(() => transport.of("snapshot_required").length > 0, "snapshot_required");
		expect(transport.of("snapshot_required")[0]).toEqual({ type: "snapshot_required", topic: TOPIC, reason: "expired" });
		expect(connection.queue.bytes).toBe(0);
		// The client takes a snapshot and subscribes again: nothing is missing.
		const again = await open(TOPIC);
		await until(() => again.transport.events(TOPIC).length === 60, "replay");
		await small.close();
	});

	it("closes with 4003 and leaks nothing further when the session is revoked, by check or by bus, or the Authorizer forbids", async () => {
		await addSession(db.admin, ADA, "s2");
		const a = await open(TOPIC, undefined, principal(ADA, "s1"));
		await say("visible");
		await until(() => a.transport.events(TOPIC).length === 1, "seen");
		// By the periodic check, with the bus down.
		pulse.down = true;
		await db.admin.query("UPDATE test_identity.sessions SET revoked_at = now() WHERE session_id = 's1'");
		await until(() => a.transport.closed !== null, "closed by check");
		expect(a.transport.closed!.code).toBe(4003);
		await say("secret");
		await new Promise((resolve) => setTimeout(resolve, 150));
		expect(a.transport.commits(TOPIC)).toEqual([1]);
		// By the bus, faster than the check.
		pulse.down = false;
		const slowCheck = hubWith({ revalidateMs: 60_000 });
		const b = await open(TOPIC, undefined, principal(ADA, "s2"), slowCheck);
		await pulse.publishRevocation(ADA, "s2");
		await until(() => b.transport.closed !== null, "closed by bus", 500);
		expect(b.transport.closed!.code).toBe(4003);
		// A suspended account cannot start a subscription.
		await db.admin.query("UPDATE test_identity.accounts SET status = 'suspended' WHERE owner_id = $1", [ADA]);
		const late = await open(TOPIC, undefined, principal(ADA, "s2"));
		expect(late.transport.closed?.code).toBe(4003);
		expect(late.transport.of("ack")).toHaveLength(0);
		// And a topic the canonical Authorizer forbids closes the connection.
		await db.admin.query("UPDATE test_identity.accounts SET status = 'active' WHERE owner_id = $1", [ADA]);
		authorizer.denied.add(`chat:${C1}`);
		await db.admin.query("INSERT INTO test_identity.sessions (session_id, owner_id) VALUES ('s3', $1)", [ADA]);
		const denied = await open(TOPIC, undefined, principal(ADA, "s3"));
		expect(denied.transport.closed?.code).toBe(4003);
		await slowCheck.close();
	});

	it("serves an owner only their own rows whatever the topic says", async () => {
		await addSession(db.admin, GRACE, "other");
		await say("ada's secret", { owner: ADA });
		await say("grace's own", { owner: GRACE, chat: C1 });
		const mine = await open(TOPIC, undefined, principal(GRACE, "other"));
		expect(texts(mine.transport)).toEqual(["grace's own"]);
		const grace = await open("sidebar", undefined, principal(GRACE, "other"));
		await outbox.commit(P1, ADA, C1, "chat.meta", { title: "ada only" });
		await projector.drain(ADA, P1);
		await new Promise((resolve) => setTimeout(resolve, 150));
		expect(grace.transport.events("sidebar")).toHaveLength(0);
	});

	it("follows only a few topics per connection, and answers bad frames with canonical error frames", async () => {
		const small = hubWith({ maxTopics: 2 });
		const transport = new FakeTransport();
		const connection = small.connect(principal(ADA, "s1"), transport);
		for (const topic of ["sidebar", TOPIC, `chat:${"b".repeat(8)}`]) await connection.receive(JSON.stringify({ type: "subscribe", topic }));
		expect(connection.topics).toEqual(["sidebar", TOPIC]);
		expect(transport.of("error")[0]).toMatchObject({ code: "too_many_topics" });
		for (const raw of ["not json", JSON.stringify({ type: "teleport", topic: "sidebar" }), JSON.stringify({ type: "subscribe", topic: "chat:>" }), JSON.stringify({ type: "subscribe", topic: "chat:*" }), JSON.stringify({ type: "subscribe", topic: "sidebar", cursor: "nope" })]) await connection.receive(raw);
		expect(transport.of("error").map((frame) => frame.code)).toEqual(["too_many_topics", "bad_frame", "bad_frame", "bad_topic", "bad_topic", "bad_cursor"]);
		await say("one");
		await until(() => transport.events(TOPIC).length === 1, "delivered");
		await connection.receive(JSON.stringify({ type: "ack", cursor: `${P1}:1:1` }));
		await until(() => connection.acked.get(TOPIC) !== undefined, "ack", 2_000);
		expect(connection.acked.get(TOPIC)).toBe(`${P1}:1:1`);
		await small.close();
	});
});
