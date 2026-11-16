import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { WebSocket } from "ws";
import { LiveHub } from "../src/server/hub.ts";
import { LogStore } from "../src/server/log-store.ts";
import { NatsPulse } from "../src/server/pulse.ts";
import { type LiveServer, startLiveServer } from "../src/server/ws-server.ts";
import { Projector } from "../src/projections/projector.ts";
import { type Database, NATS_SERVER, type Nats, POSTGRES, startNats, startPostgres, until } from "./support/infra.ts";
import { ADA, C1, FixtureAuthorizer, FixtureIdentity, Outbox, P1, addSession, assistant, reset } from "./support/fixtures.ts";

const real = POSTGRES && NATS_SERVER ? describe : describe.skip;
const TOPIC = `chat:${C1}`;

real("Live service over real WebSockets, PostgreSQL and NATS", () => {
	let db: Database;
	let outbox: Outbox;
	let nats: Nats;
	let pulse: NatsPulse;
	let hub: LiveHub;
	let server: LiveServer;
	let projector: Projector;
	let entryId = 0;

	beforeAll(async () => {
		db = await startPostgres();
		outbox = new Outbox(db.admin);
	});
	afterAll(() => db?.stop());
	beforeEach(async () => {
		await reset(db.admin);
		outbox.reset();
		entryId = 0;
		nats = await startNats();
		pulse = await NatsPulse.connect(nats.url);
		projector = new Projector(db.pool, { pulse });
		hub = new LiveHub(new LogStore(db.pool), pulse, new FixtureIdentity(db.admin), new FixtureAuthorizer(), { heartbeatMs: 100, revalidateMs: 100, pumpMs: 2, highWaterBytes: 32_768, maxQueueBytes: 262_144 });
		server = await startLiveServer(hub, db.pool);
		await addSession(db.admin, ADA, "s1");
	});
	afterEach(async () => {
		await hub.close();
		await server.close();
		await pulse.close();
		await nats.stop();
	});

	async function say(text: string, id = ++entryId, partial = false) {
		await outbox.entry(P1, ADA, C1, assistant(id, text), partial);
		await projector.drain(ADA, P1);
	}

	async function client(session = "s1") {
		const socket = new WebSocket(`ws://127.0.0.1:${server.port}/live`, { headers: { cookie: `pim_session=${session}` } });
		const frames: any[] = [];
		const closed = new Promise<{ code: number }>((resolve) => socket.on("close", (code) => resolve({ code })));
		socket.on("message", (data) => frames.push(JSON.parse(data.toString())));
		await new Promise((resolve, reject) => (socket.on("open", resolve), socket.on("error", reject)));
		const events = () => frames.filter((frame) => frame.type === "event" || frame.type === "coalesced_progress");
		const subscribe = (topic: string, cursor?: string | null) => socket.send(JSON.stringify({ type: "subscribe", topic, ...(cursor ? { cursor } : {}) }));
		return { socket, frames, closed, events, subscribe };
	}
	const commitOf = (frame: { cursor: string }) => Number(frame.cursor.split(":")[2]);

	it("streams over NATS hints, and keeps delivering from PostgreSQL after the NATS server is killed", async () => {
		const c = await client();
		c.subscribe(TOPIC);
		for (let i = 0; i < 10; i++) await say(`a${i}`);
		await until(() => c.events().length === 10, "ten over the bus");
		nats.process.kill("SIGKILL");
		await until(() => nats.process.exitCode !== null || nats.process.signalCode !== null, "nats down");
		for (let i = 0; i < 40; i++) await say(`b${i}`);
		await until(() => c.events().length === 50, "all 50 with NATS dead", 10_000);
		expect(c.events().map(commitOf)).toEqual(Array.from({ length: 50 }, (_, i) => i + 1));
		c.socket.close();
	});

	it("takes the HTTP snapshot first and subscribes from its cursor", async () => {
		for (let i = 0; i < 4; i++) await say(`m${i}`);
		const response = await fetch(`http://127.0.0.1:${server.port}/snapshot/chat/${C1}?limit=3`, { headers: { cookie: "pim_session=s1" } });
		const page = (await response.json()) as any;
		expect(page.messages).toHaveLength(3);
		expect(page.liveCursor).toBe(`${P1}:1:4`);
		expect((await fetch(`http://127.0.0.1:${server.port}/snapshot/chat/${C1}`)).status).toBe(401);
		const c = await client();
		c.subscribe(TOPIC, page.liveCursor);
		await say("newer");
		await until(() => c.events().length === 1, "only the newer one");
		expect(commitOf(c.events()[0])).toBe(5);
		c.socket.close();
	});

	it("coalesces a 500-chunk flood for a reader that stopped, keeps the final message, within the memory cap", async () => {
		const c = await client();
		c.subscribe(TOPIC);
		await new Promise((resolve) => setTimeout(resolve, 100));
		// The reader stops reading: the kernel's socket buffers fill, then the server's own queue.
		(c.socket as unknown as { _socket: { pause(): void; resume(): void } })._socket.pause();
		await say("question", 1);
		const chunk = (i: number) => `${"tok ".repeat(4000)}#${i}`; // ~16 KB each: 8 MB in all
		let maxQueued = 0;
		for (let i = 0; i < 500; i++) {
			await say(chunk(i), 2, true);
			maxQueued = Math.max(maxQueued, hub.queuedBytes);
		}
		await say("final answer", 2, false);
		(c.socket as unknown as { _socket: { resume(): void } })._socket.resume();
		await until(() => c.events().some((frame) => frame.type === "event" && frame.kind === "message" && frame.data.message.id === "2"), "final message", 15_000);
		const events = c.events();
		const commits = events.map(commitOf);
		expect(commits).toEqual([...commits].sort((a, b) => a - b));
		expect(new Set(commits).size).toBe(commits.length);
		expect(events.length).toBeLessThan(250);
		expect(maxQueued).toBeLessThanOrEqual(262_144);
		// What was skipped is counted: every coalesced_progress says so.
		expect(events.some((frame) => frame.type === "coalesced_progress" && frame.skipped > 0)).toBe(true);
		expect(events.at(-1).data.message.parts[0].text).toBe("final answer");
		expect(c.frames.some((frame) => frame.type === "snapshot_required")).toBe(false);
		c.socket.close();
	});

	it("closes with 4003 when the session is revoked or the connection has no session", async () => {
		const anonymous = await client("nobody");
		expect((await anonymous.closed).code).toBe(4003);
		const c = await client();
		c.subscribe(TOPIC);
		await say("one");
		await until(() => c.events().length === 1, "one");
		await db.admin.query("UPDATE test_identity.sessions SET revoked_at = now() WHERE session_id = 's1'");
		await pulse.publishRevocation(ADA, "s1");
		expect((await c.closed).code).toBe(4003);
		await say("after revocation");
		expect(c.events()).toHaveLength(1);
	});
});
