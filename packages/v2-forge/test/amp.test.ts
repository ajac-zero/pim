import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { FakeOrbClient } from "@pim/coding/orb/fake";
import { OrbUnreachableError, type OrbClient, type OrbStart } from "@pim/coding/orb/types";
import { LEGACY_AMP_WORKSPACE_MESSAGE } from "../src/harnesses";
import { ada, startReq, stack } from "./stack";

const wakes = async (s: Awaited<ReturnType<typeof stack>>, id: string) => (await s.pool.query("select dedupe_key from pim_forge.forge_outbox where topic = 'wake' and thread_id = $1 order by id", [id])).rows.map((r) => r.dedupe_key);
const messages = async (s: Awaited<ReturnType<typeof stack>>, id: string) => (await s.forge.transcript(ada, id)).events;

describe("Amp: a remote orb Forge adopts and never restarts", () => {
	let s: Awaited<ReturnType<typeof stack>>;
	let n = 0;
	const amp = async (over = {}) => (await s.forge.start(ada, startReq(`amp-${++n}`, { harness: "amp", ...over }))).threadId;
	beforeAll(async () => {
		s = await stack();
		await s.grantAll("ada");
	});
	afterAll(async () => s.close());

	it("records the intent, starts through the idempotency key and persists the handle before anything else", async () => {
		const id = await amp();
		expect(await s.worker().step(id)).toBe("done");
		const t = (await s.store.get(id))!;
		expect(t.orb).toMatchObject({ threadId: s.orb.started.at(-1)!.threadId, url: expect.stringContaining("T-") });
		expect(t).toMatchObject({ state: "running", workspaceRef: null });
		expect(t.provisioning).toMatchObject({ kind: "orb", phase: "ready", key: `forge:${id}:${t.startOperation}` });
		// Never in the workspace queue or a slot.
		expect(await s.scheduler.slots("default")).not.toContain(id);
		// Found by the Amp id and by its page URL.
		expect((await s.forge.status(ada, t.orb!.threadId)).threadId).toBe(id);
		expect((await s.forge.status(ada, `https://ampcode.com/threads/${t.orb!.threadId}`)).threadId).toBe(id);
	});

	it("an ambiguous start (the orb exists, the answer was lost) reconnects to the same orb instead of starting a second", async () => {
		const real = new FakeOrbClient({ id: "amp-http" });
		let dropAnswer = true;
		const lossy: OrbClient = new Proxy(real, {
			get(target, prop, recv) {
				if (prop === "start")
					return async (st: OrbStart) => {
						const out = await target.start(st);
						if (dropAnswer) {
							dropAnswer = false;
							throw new OrbUnreachableError();
						}
						return out;
					};
				const v = Reflect.get(target, prop, recv);
				return typeof v === "function" ? v.bind(target) : v;
			},
		});
		const id = await amp();
		const w = s.worker({ orbs: () => lossy });
		expect(await w.step(id)).toBe("retry");
		expect((await s.store.get(id))!).toMatchObject({ orb: null, state: "provisioning" });
		expect((await s.store.get(id))!.provisioning.phase).toBe("uncertain");
		expect(await w.step(id)).toBe("done");
		expect(real.started).toHaveLength(1);
		expect((await s.store.get(id))!.orb!.threadId).toBe(real.started[0]!.threadId);
	});

	it("an unreachable cloud leaves the thread provisioning with nothing created", async () => {
		const down = new FakeOrbClient();
		down.unreachable("start");
		const id = await amp();
		expect(await s.worker({ orbs: () => down }).step(id)).toBe("retry");
		expect(down.started).toHaveLength(0);
		down.unreachable("start", false);
		expect(await s.worker({ orbs: () => down }).step(id)).toBe("done");
		expect(down.started).toHaveLength(1);
	});

	it("a restarted Forge adopts the live session: no second start, no prompt re-sent, no duplicate messages or wakes", async () => {
		const orb = new FakeOrbClient();
		const id = await amp();
		const w1 = s.worker({ orbs: () => orb });
		await w1.step(id);
		const handle = orb.started[0]!.threadId;
		orb.say(handle, "assistant", "Working on it.\n<suggested-replies>\n- Looks good\n- Run the tests\n</suggested-replies>");
		await w1.step(id);
		// Forge restarts: a new worker with no memory of the first, and the remote keeps running meanwhile.
		orb.say(handle, "assistant", "Done, branch pushed.");
		orb.setState(handle, "idle");
		const w2 = s.worker({ orbs: () => orb });
		for (let i = 0; i < 3; i++) await w2.step(id);
		expect(orb.started).toHaveLength(1);
		const texts = (await messages(s, id)).map((e) => [e.role, e.data.text]);
		expect(texts).toEqual([
			["user", expect.stringContaining("Fix the login bug")],
			["assistant", "Working on it."],
			["assistant", "Done, branch pushed."],
		]);
		expect((await messages(s, id))[1]!.data.suggestedReplies).toEqual(["Looks good", "Run the tests"]);
		const t = (await s.store.get(id))!;
		expect(t.state).toBe("idle");
		expect(await wakes(s, id)).toEqual([`coding:${id}:${t.startOperation}`]);
		const ends = await s.pool.query("select count(*) c from pim_forge.forge_events where thread_id = $1 and kind = 'thread.turn_ended'", [id]);
		expect(Number(ends.rows[0].c)).toBe(1);
	});

	it("syncs a turn someone started in Amp's own UI, and wakes once when it ends", async () => {
		const orb = new FakeOrbClient();
		const id = await amp();
		const w = s.worker({ orbs: () => orb });
		await w.step(id);
		const h = orb.started[0]!.threadId;
		orb.setState(h, "idle");
		await w.step(id);
		orb.say(h, "user", "Hey, also update the docs");
		orb.setState(h, "working");
		await w.step(id);
		const started = await s.pool.query("select data from pim_forge.forge_events where thread_id = $1 and kind = 'thread.turn_started' order by seq", [id]);
		expect(started.rows.map((r) => r.data.external ?? false)).toEqual([false, true]);
		expect((await s.store.get(id))!.state).toBe("running");
		orb.say(h, "assistant", "Docs updated");
		orb.setState(h, "idle");
		await w.step(id);
		await w.step(id);
		const keys = await wakes(s, id);
		expect(keys).toHaveLength(2);
		expect(keys[1]).toMatch(new RegExp(`^coding:${id}:external:m-`));
	});

	it("steers at most once per operation id", async () => {
		const orb = new FakeOrbClient();
		const id = await amp();
		const w = s.worker({ orbs: () => orb });
		await w.step(id);
		const h = orb.started[0]!.threadId;
		await s.forge.steer(ada, id, "use tabs", "st-1");
		await s.forge.steer(ada, id, "use tabs", "st-1");
		await w.step(id);
		await w.step(id);
		expect(orb.queued(h)).toEqual(["use tabs"]);
		// Delivered by the agent: it shows up as the user's message and is not mistaken for an external turn.
		orb.deliver(h);
		await w.step(id);
		const external = await s.pool.query("select count(*) c from pim_forge.forge_events where thread_id = $1 and data ->> 'external' = 'true'", [id]);
		expect(Number(external.rows[0].c)).toBe(0);
	});

	it("mirrors image and video attachments into Objects once", async () => {
		const orb = new FakeOrbClient();
		const fetched: string[] = [];
		const id = await amp();
		const w = s.worker({ orbs: () => orb, attachments: async (url) => (fetched.push(url), { bytes: new Uint8Array([1, 2, 3]), type: url.endsWith(".mp4") ? "video/mp4" : "image/png" }) });
		await w.step(id);
		const h = orb.started[0]!.threadId;
		orb.say(h, "assistant", "Screens: ![shot](https://ampcode.com/user-content/attachments/shot.png) and ![demo](https://ampcode.com/user-content/attachments/demo.mp4)");
		orb.say(h, "assistant", "Again: ![shot](https://ampcode.com/user-content/attachments/shot.png)");
		await w.step(id);
		await w.step(id);
		expect(fetched.sort()).toEqual(["https://ampcode.com/user-content/attachments/demo.mp4", "https://ampcode.com/user-content/attachments/shot.png"]);
		expect([...s.objects.map.values()].map((o) => o.contentType).sort()).toContain("video/mp4");
		const text = (await messages(s, id)).find((e) => e.data.text?.startsWith("Screens"))!.data.text as string;
		expect(text).not.toContain("ampcode.com");
		expect(text).toContain(`/api/coding/${id}/attachments/`);
	});

	it("an orb deleted on Amp's side fails the thread once, with a wake", async () => {
		const orb = new FakeOrbClient();
		const id = await amp();
		const w = s.worker({ orbs: () => orb });
		await w.step(id);
		orb.lose(orb.started[0]!.threadId);
		await w.step(id);
		expect(await s.store.get(id)).toMatchObject({ state: "failed", stateReason: "orb_lost" });
		expect(await wakes(s, id)).toHaveLength(1);
	});

	it("tracks cancellation as requested, cancelled or uncertain, and revokes credentials at once", async () => {
		const orb = new FakeOrbClient();
		const id = await amp();
		const f = s.worker({ orbs: () => orb });
		await f.step(id);
		const before = (await s.store.get(id))!.gatewayNonce;
		// Forge's facade resolves clients through the stack's single orb; point it at this one.
		(s.forge as any).c.orbs = () => orb;
		expect(await s.forge.abort(ada, id)).toEqual({ cancelState: "cancelled" });
		expect(orb.cancelCount(orb.started[0]!.threadId)).toBe(1);
		expect((await s.store.get(id))!.gatewayNonce).not.toBe(before);

		const id2 = await amp();
		await f.step(id2);
		orb.unreachable("cancel");
		expect(await s.forge.abort(ada, id2)).toEqual({ cancelState: "uncertain" });
		expect((await s.store.get(id2))!.cancelState).toBe("uncertain");
	});

	it("keeps a retired workspace-Amp row readable and never steps it", async () => {
		const id = await amp();
		await s.pool.query("update pim_forge.forge_threads set workspace_ref = '{\"id\":\"old\"}' where thread_id = $1", [id]);
		await s.worker().step(id);
		expect(await s.store.get(id)).toMatchObject({ state: "failed", stateDetail: LEGACY_AMP_WORKSPACE_MESSAGE });
		expect((await s.forge.status(ada, id)).stateDetail).toBe(LEGACY_AMP_WORKSPACE_MESSAGE);
	});

	it("can't be pushed or merged by Forge, and its diff says honestly when the work isn't on the git host", async () => {
		const id = await amp();
		await s.worker().step(id);
		await expect(s.forge.push(ada, id)).rejects.toMatchObject({ code: "unsupported" });
		await expect(s.forge.merge(ada, id)).rejects.toMatchObject({ code: "unsupported" });
		expect(await s.forge.diff(ada, id)).toEqual({ source: "orb", diff: "", unpushedOrb: true });
		await s.forge.recordOrbBranch(id, "amp/feature");
		expect(await s.forge.diff(ada, id)).toMatchObject({ unpushedOrb: true });
		// Once the orb has pushed to the host, the diff is the host's.
		const clone = (await s.sandboxes.create("amp-pusher"));
		await s.sandboxes.exec(clone, ["git", "clone", s.bare, "."]);
		await s.sandboxes.exec(clone, ["sh", "-c", "echo amp > amp.txt"]);
		await s.sh(clone, "checkout", "-b", "amp/feature");
		await s.sh(clone, "add", ".");
		await s.sh(clone, "commit", "-m", "amp work");
		await s.sh(clone, "push", s.bare, "amp/feature");
		const d = await s.forge.diff(ada, id);
		expect(d.unpushedOrb).toBe(false);
		expect(d.diff).toContain("+amp");
		// A PR can be opened for the pushed orb branch.
		expect(await s.forge.openPullRequest(ada, id)).toMatchObject({ status: "done", number: 1 });
	});

	it("takes no slot and consumes no sandbox quota, even at a concurrency quota of zero", async () => {
		await s.pool.query("insert into pim_forge.forge_quotas values ('user', 'ada', 0, null, null) on conflict do nothing");
		const id = await amp();
		expect(await s.worker().step(id)).toBe("done");
		expect((await s.store.get(id))!.state).toBe("running");
		await s.pool.query("delete from pim_forge.forge_quotas where subject_id = 'ada'");
	});
});
