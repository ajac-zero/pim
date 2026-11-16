// The real AmpHttpOrbClient against a local Amp API on a node http server.
import { randomBytes } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ampAttachmentFetcher, ampOrbClients, sniff } from "../src/amp-adapter";
import { ForgeVault, LocalEnvelopeCrypto } from "../src/vault";
import { ada, startReq, stack } from "./stack";
import { HTML, MP4, MockAmp, PNG } from "./amp-mock";

const KEY = "sgamp_0123456789abcdef0123456789";

describe("AmpHttpOrbClient against a local Amp", () => {
	let s: Awaited<ReturnType<typeof stack>>;
	let amp: MockAmp;
	let vault: ForgeVault;
	let n = 0;
	const worker = (extra = {}) => {
		const wiring = { db: s.db, vault, baseUrl: amp.baseUrl, now: s.clock };
		return s.worker({ orbs: ampOrbClients(wiring), attachments: ampAttachmentFetcher(wiring), ampBaseUrl: amp.baseUrl, ...extra });
	};
	const start = async () => (await s.forge.start(ada, startReq(`amp-http-${++n}`, { harness: "amp" }))).threadId;

	beforeAll(async () => {
		s = await stack();
		await s.grantAll("ada");
		amp = await new MockAmp().start();
		vault = new ForgeVault(s.db, new LocalEnvelopeCrypto({ keyId: "k", key: randomBytes(32) }));
		await vault.saveApiKey("ada", "amp", KEY);
	});
	afterAll(async () => {
		await amp.stop();
		await s.close();
	});

	it("starts once with the person's own key, and the reservation is durable in PostgreSQL", async () => {
		const id = await start();
		expect(await worker().step(id)).toBe("done");
		const t = (await s.store.get(id))!;
		expect(t.orb!.threadId).toMatch(/^T-mock/);
		expect(amp.creates).toBe(1);
		expect(amp.auth.every((a) => a === `Bearer ${KEY}`)).toBe(true);
		const kv = await s.pool.query("select key from pim_forge.forge_amp_kv where key like 'amp:start:%'");
		expect(kv.rows.map((r) => r.key)).toContain(`amp:start:forge:${id}:${t.startOperation}`);
		// A second worker (a restart) adopts it: no second create, no re-sent prompt.
		await worker().step(id);
		await worker().step(id);
		expect(amp.creates).toBe(1);
		expect(amp.threads.get(t.orb!.threadId)!.messages).toHaveLength(1);
	});

	it("a start whose answer was lost (5xx after the thread was made) is never started again: it waits for a person to check Amp", async () => {
		amp.fail.createRemoteExecutorThread = { status: 502, times: 1, afterWork: true };
		const before = amp.creates;
		const id = await start();
		const w = worker();
		expect(await w.step(id)).toBe("retry");
		expect((await s.store.get(id))!.provisioning.phase).toBe("uncertain");
		s.advance(10 * 60_000);
		expect(await w.step(id)).toBe("done");
		expect(await s.store.get(id)).toMatchObject({ state: "waiting_input", stateReason: "orb_start_uncertain", orb: null });
		s.advance(60 * 60_000);
		await w.step(id);
		expect(amp.creates - before).toBe(1);
	});

	it("reads the transcript in pages after its cursor and syncs a turn started in Amp itself", async () => {
		const id = await start();
		const w = worker();
		await w.step(id);
		const h = (await s.store.get(id))!.orb!.threadId;
		for (let i = 0; i < 5; i++) amp.say(h, "assistant", `step ${i}`);
		amp.threads.get(h)!.state = "idle";
		await w.step(id);
		expect((await s.forge.transcript(ada, id)).events.map((e) => e.data.text)).toEqual([expect.stringContaining("Fix the login bug"), "step 0", "step 1", "step 2", "step 3", "step 4"]);
		// Someone types in Amp's own UI.
		amp.say(h, "user", "from the amp website");
		amp.threads.get(h)!.state = "working";
		await w.step(id);
		await w.step(id);
		const external = (await s.pool.query("select data from pim_forge.forge_events where thread_id = $1 and kind = 'thread.turn_started' and data ->> 'external' = 'true'", [id])).rows;
		expect(external).toHaveLength(1);
		expect((await s.forge.transcript(ada, id)).events).toHaveLength(7);
		expect((await s.store.get(id))!.state).toBe("running");
	});

	it("rides out a 5xx on a read: the sync retries after the backoff and loses nothing", async () => {
		const id = await start();
		const w = worker();
		await w.step(id);
		const h = (await s.store.get(id))!.orb!.threadId;
		amp.say(h, "assistant", "while amp was down");
		amp.fail.getThreadTail = { status: 503, times: 1, afterWork: false };
		expect(await w.step(id)).toBe("retry");
		// Still backing off.
		expect(await w.step(id)).toBe("retry");
		s.advance(5 * 60_000);
		expect(await w.step(id)).toBe("done");
		expect((await s.forge.transcript(ada, id)).events.map((e) => e.data.text)).toContain("while amp was down");
	});

	it("mirrors attachments after checking their magic bytes; a lie about the type is refused, and a file that isn't there yet holds the message back", async () => {
		amp.attachments.set("shot.png", { type: "image/png", body: PNG });
		amp.attachments.set("demo.mp4", { type: "video/mp4", body: MP4 });
		amp.attachments.set("fake.png", { type: "image/png", body: HTML });
		amp.attachments.set("late.png", { type: "image/png", body: PNG, status: 503 });
		const id = await start();
		const w = worker();
		await w.step(id);
		const h = (await s.store.get(id))!.orb!.threadId;
		const at = (n: string) => `${amp.baseUrl}/user-content/attachments/${n}`;
		amp.say(h, "assistant", `![a](${at("shot.png")}) ![b](${at("demo.mp4")}) ![c](${at("fake.png")})`);
		await w.step(id);
		const mirrored = [...s.objects.map.entries()].filter(([k]) => k.startsWith(`forge/${id}/attachments/`));
		expect(mirrored.map(([, o]) => o.contentType).sort()).toEqual(["image/png", "video/mp4"]);
		const text = (await s.forge.transcript(ada, id)).events.at(-1)!.data.text as string;
		expect(text).toContain(`/api/coding/${id}/attachments/`);
		expect(text).toContain(at("fake.png"));
		// An attachment that isn't ready: the message isn't recorded half-mirrored.
		amp.say(h, "assistant", `![late](${at("late.png")})`);
		expect(await w.step(id)).toBe("retry");
		expect((await s.forge.transcript(ada, id)).events.some((e) => String(e.data.text).includes("late.png"))).toBe(false);
		amp.attachments.set("late.png", { type: "image/png", body: PNG });
		expect(await w.step(id)).toBe("done");
		expect((await s.forge.transcript(ada, id)).events.some((e) => String(e.data.text).includes("/attachments/"))).toBe(true);
		expect(sniff(PNG)).toBe("image/png");
		expect(sniff(HTML)).toBeNull();
	});

	it("a steer whose answer was lost is checked against Amp's own transcript: found means sent, not found is recorded uncertain and never resent by itself", async () => {
		const id = await start();
		const w = worker();
		await w.step(id);
		const h = (await s.store.get(id))!.orb!.threadId;
		// The agent took it, the answer was lost: found in the transcript, so sent once.
		amp.fail.sendMessageToThread = { status: 502, times: 1, afterWork: true };
		await s.forge.steer(ada, id, "use tabs", "st-a");
		await w.step(id);
		expect(amp.steers).toEqual(["use tabs"]);
		expect((await s.pool.query("select status from pim_forge.forge_inbox where thread_id = $1 and operation_id = 'st-a'", [id])).rows[0].status).toBe("done");

		// Amp queued it and the answer was lost: not in the transcript, so uncertain; nothing is resent.
		amp.deliverAtOnce = false;
		amp.fail.sendMessageToThread = { status: 502, times: 1, afterWork: true };
		s.advance(60 * 60_000);
		await s.forge.steer(ada, id, "use spaces", "st-b");
		await w.step(id);
		expect((await s.pool.query("select status from pim_forge.forge_inbox where thread_id = $1 and operation_id = 'st-b'", [id])).rows[0].status).toBe("uncertain");
		expect((await s.pool.query("select kind from pim_forge.forge_events where thread_id = $1 and kind = 'steer.uncertain'", [id])).rows).toHaveLength(1);
		s.advance(60 * 60_000);
		await w.step(id);
		await w.step(id);
		expect(amp.steers).toEqual(["use tabs", "use spaces"]);

		// Amp takes the queued message later: the next sync settles it as sent, with no resend.
		amp.deliver(h);
		await w.step(id);
		expect((await s.pool.query("select status from pim_forge.forge_inbox where thread_id = $1 and operation_id = 'st-b'", [id])).rows[0].status).toBe("done");
		expect(amp.steers).toEqual(["use tabs", "use spaces"]);
		expect((await s.pool.query("select count(*) c from pim_forge.forge_events where thread_id = $1 and data ->> 'external' = 'true'", [id])).rows[0].c).toBe("0");
	});

	it("a worker that died while sending reconciles on restart, and a person resends an uncertain steer explicitly", async () => {
		const id = await start();
		const w = worker();
		await w.step(id);
		const h = (await s.store.get(id))!.orb!.threadId;
		amp.deliverAtOnce = false;
		// Died after the row went 'sending' and before anything is known.
		await s.store.locked(id, (q) => s.store.enqueueInbox(q, id, "st-c", "steer", { prompt: "crashy", baseline: String(amp.threads.get(h)!.messages.length) }));
		await s.pool.query("update pim_forge.forge_inbox set status = 'sending' where thread_id = $1 and operation_id = 'st-c'", [id]);
		await w.step(id);
		expect((await s.pool.query("select status from pim_forge.forge_inbox where thread_id = $1 and operation_id = 'st-c'", [id])).rows[0].status).toBe("uncertain");
		expect(amp.steers).not.toContain("crashy");
		const next = await s.forge.retrySteer(ada, id, "st-c");
		expect(next).toEqual({ operationId: "retry-st-c-1" });
		await w.step(id);
		expect(amp.steers.filter((x) => x === "crashy")).toHaveLength(1);
		await expect(s.forge.retrySteer(ada, id, "st-c")).rejects.toMatchObject({ code: "conflict" });
	});
});
