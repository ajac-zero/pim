import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { IDLE_SLOT_GRACE_MS, loginKey, POOL_COOLDOWN_MS, QUEUE_DEADLINE_MS, SESSION_CAP_GRACE_MS } from "../src/scheduler";
import { stack } from "./stack";

describe("ForgeScheduler on PostgreSQL", () => {
	let s: Awaited<ReturnType<typeof stack>>;
	let n = 0;
	/** A thread row to schedule, made the way a start makes it. */
	const thread = async (owner = "ada") => (await s.store.start({ ownerId: owner, operationId: `op-${++n}`, harness: "claude-code", task: "t", repo: "acme/app", createdBy: owner })).thread.threadId;
	beforeAll(async () => (s = await stack()));
	afterAll(async () => s.close());

	it("caps a pool at its size and queues the rest FIFO; a release promotes the head", async () => {
		await s.scheduler.upsertPool({ poolId: "p1", provider: "local", size: 2 });
		const [a, b, c, d] = [await thread(), await thread(), await thread(), await thread()];
		expect((await s.scheduler.admit(a, "p1", "ada")).kind).toBe("slot");
		expect((await s.scheduler.admit(b, "p1", "ada")).kind).toBe("slot");
		expect(await s.scheduler.admit(c, "p1", "ada")).toMatchObject({ kind: "queued", position: 1 });
		expect(await s.scheduler.admit(d, "p1", "ada")).toMatchObject({ kind: "queued", position: 2 });
		// The page reads the same place from the thread, and nothing for one that isn't waiting.
		const ada = { ownerId: "ada", role: "member" as const };
		expect((await s.forge.progress(ada, c)).queuePosition).toBe(1);
		expect((await s.forge.progress(ada, d)).queuePosition).toBe(2);
		expect((await s.forge.progress(ada, a)).queuePosition).toBeNull();
		expect(await s.scheduler.release(a)).toEqual([c]);
		expect(await s.scheduler.slots("p1")).toEqual([b, c]);
		expect((await s.forge.progress(ada, d)).queuePosition).toBe(1);
		expect(await s.scheduler.queue("p1")).toEqual([d]);
		expect((await s.store.get(c))!.state).toBe("provisioning");
		// A newcomer cannot jump the queue even though... the pool is full, and FIFO also holds when a slot frees and a waiter exists.
		await s.scheduler.release(b);
		expect(await s.scheduler.queue("p1")).toEqual([]);
	});

	it("never overfills a pool under concurrent admissions", async () => {
		await s.scheduler.upsertPool({ poolId: "p2", provider: "local", size: 3 });
		const ids = await Promise.all(Array.from({ length: 12 }, () => thread("bo")));
		const results = await Promise.all(ids.map((id) => s.scheduler.admit(id, "p2", "bo")));
		expect(results.filter((r) => r.kind === "slot")).toHaveLength(3);
		expect(await s.scheduler.slots("p2")).toHaveLength(3);
		expect(await s.scheduler.queue("p2")).toHaveLength(9);
	});

	it("requeues an overdue waiter once, then fails it", async () => {
		await s.scheduler.upsertPool({ poolId: "p3", provider: "local", size: 1 });
		const [a, b] = [await thread(), await thread()];
		await s.scheduler.admit(a, "p3", "ada");
		await s.scheduler.admit(b, "p3", "ada");
		s.advance(QUEUE_DEADLINE_MS + 1);
		await s.scheduler.promote("p3");
		expect(await s.scheduler.queue("p3")).toEqual([b]);
		expect((await s.store.get(b))!.state).toBe("queued");
		s.advance(QUEUE_DEADLINE_MS + 1);
		await s.scheduler.promote("p3");
		expect(await s.scheduler.queue("p3")).toEqual([]);
		expect(await s.store.get(b)).toMatchObject({ state: "failed", stateReason: "queue_timeout" });
	});

	it("releases an idle workspace's slot after two minutes, not before", async () => {
		await s.scheduler.upsertPool({ poolId: "p4", provider: "local", size: 1 });
		const [a, b] = [await thread(), await thread()];
		await s.scheduler.admit(a, "p4", "ada");
		await s.scheduler.admit(b, "p4", "ada");
		await s.scheduler.markIdle(a);
		s.advance(IDLE_SLOT_GRACE_MS - 1);
		expect(await s.scheduler.releaseIdle()).toEqual([]);
		await s.scheduler.markBusy(a);
		await s.scheduler.markIdle(a);
		s.advance(IDLE_SLOT_GRACE_MS);
		expect(await s.scheduler.releaseIdle()).toEqual([a]);
		expect(await s.scheduler.slots("p4")).toEqual([b]);
	});

	it("opens after three failures for five minutes, then lets exactly one probe through", async () => {
		await s.scheduler.upsertPool({ poolId: "p5", provider: "local", size: 5 });
		const ids = await Promise.all([1, 2, 3, 4, 5].map(() => thread()));
		for (const id of ids.slice(0, 3)) {
			expect((await s.scheduler.admit(id, "p5", "ada")).kind).toBe("slot");
			await s.scheduler.report("p5", id, "failure");
			await s.scheduler.release(id, "provision_failed");
		}
		expect((await s.scheduler.admit(ids[3]!, "p5", "ada")).kind).toBe("unhealthy");
		s.advance(POOL_COOLDOWN_MS);
		expect(await s.scheduler.admit(ids[3]!, "p5", "ada")).toMatchObject({ kind: "slot", probe: true });
		// The half-open pool admits no second attempt until the probe reports.
		expect((await s.scheduler.admit(ids[4]!, "p5", "ada")).kind).toBe("unhealthy");
		await s.scheduler.report("p5", ids[3]!, "success");
		expect((await s.scheduler.admit(ids[4]!, "p5", "ada")).kind).toBe("slot");
	});

	it("an ignored result (capacity, quota) never counts as a failure", async () => {
		await s.scheduler.upsertPool({ poolId: "p6", provider: "local", size: 5 });
		const id = await thread();
		for (let i = 0; i < 5; i++) await s.scheduler.report("p6", id, "ignored");
		expect((await s.scheduler.admit(id, "p6", "ada")).kind).toBe("slot");
	});

	it("serializes a person's login refresh: of many concurrent holders exactly one wins, and the lock expires", async () => {
		const wins = await Promise.all(Array.from({ length: 10 }, (_, i) => s.scheduler.acquireLogin("ada", "codex", `h${i}`, 60_000)));
		expect(wins.filter(Boolean)).toHaveLength(1);
		const other = await s.scheduler.acquireLogin("ada", "claude-code", "x");
		expect(other).toBe(true);
		const holder = `h${wins.indexOf(true)}`;
		expect(await s.scheduler.acquireLogin("ada", "codex", holder)).toBe(true);
		s.advance(61_000);
		expect(await s.scheduler.acquireLogin("ada", "codex", "late")).toBe(true);
		await s.scheduler.releaseLogin("ada", "codex", "late");
		expect(await s.scheduler.acquireLogin("ada", "codex", "next")).toBe(true);
	});

	it("builds an environment once; the others wait", async () => {
		const r = await Promise.all(["a", "b", "c"].map((h) => s.scheduler.acquireEnvBuild("env-key", h)));
		expect(r.filter((x) => x === "build")).toHaveLength(1);
		const builder = ["a", "b", "c"][r.indexOf("build")]!;
		await s.scheduler.finishEnvBuild("env-key", builder);
		expect(await s.scheduler.acquireEnvBuild("env-key", "d")).toBe("build");
	});

	it("enforces concurrency, compute-minute and USD quotas apart, most specific first", async () => {
		await s.scheduler.upsertPool({ poolId: "q", provider: "local", size: 10 });
		await s.pool.query("insert into pim_forge.forge_quotas values ('deployment', '*', 5, null, null), ('user', 'quinn', 1, 1, 0.5)");
		const [a, b] = [await thread("quinn"), await thread("quinn")];
		expect((await s.scheduler.admit(a, "q", "quinn")).kind).toBe("slot");
		// The second thread fails with compute_quota: the user's 1 beats the deployment's 5.
		await expect(s.scheduler.admit(b, "q", "quinn")).rejects.toMatchObject({ code: "quota", message: expect.stringContaining("compute_quota") });
		// Another person gets the deployment default of 5.
		for (let i = 0; i < 5; i++) expect((await s.scheduler.admit(await thread("rae"), "q", "rae")).kind).toBe("slot");
		await expect(s.scheduler.admit(await thread("rae"), "q", "rae")).rejects.toMatchObject({ code: "quota" });
		// Compute minutes: a stretch of 2 minutes against a 1-minute cap.
		await s.scheduler.release(a);
		await s.pool.query("insert into pim_forge.forge_compute_usage (owner_id, thread_id, provider, began_at, ended_at) values ('quinn', 'x', 'local', $1, $2)", [new Date(s.clock() - 120_000), new Date(s.clock())]);
		await expect(s.scheduler.admit(b, "q", "quinn")).rejects.toMatchObject({ message: expect.stringContaining("compute minutes") });
		// USD is its own limit, apart from normal agents' spend.
		await s.pool.query("update pim_forge.forge_quotas set compute_minutes = null where subject_id = 'quinn'");
		await s.pool.query("update pim_forge.forge_threads set spent_usd = 0.75 where thread_id = $1", [a]);
		await expect(s.scheduler.admit(b, "q", "quinn")).rejects.toMatchObject({ message: expect.stringContaining("usd_quota") });
	});

	it("holds a workspace to the session limit or the month's minutes left, whichever is less, and refuses once they are spent", async () => {
		await s.scheduler.upsertPool({ poolId: "mins", provider: "local", size: 10 });
		await s.pool.query("insert into pim_forge.forge_quotas (subject_type, subject_id, compute_minutes, max_session_minutes) values ('user', 'sam', 60, 45), ('user', 'zed', null, 0)");
		const [a, b, c] = [await thread("sam"), await thread("sam"), await thread("sam")];
		// The first session is held to 45 minutes; it runs 40.
		const first = await s.scheduler.admit(a, "mins", "sam");
		expect(first).toMatchObject({ kind: "slot", wallClockMin: 45 });
		// A thread that holds its slot already keeps the end it was given, counted from when it began.
		s.advance(10 * 60_000);
		expect(await s.scheduler.admit(a, "mins", "sam")).toMatchObject({ kind: "slot", wallClockMin: 35 });
		s.advance(30 * 60_000);
		await s.scheduler.release(a);
		// 20 minutes are left, which is less than a session.
		expect(await s.scheduler.admit(b, "mins", "sam")).toMatchObject({ kind: "slot", wallClockMin: 20 });
		s.advance(20 * 60_000);
		await s.scheduler.release(b);
		await expect(s.scheduler.admit(c, "mins", "sam")).rejects.toMatchObject({ code: "quota", message: expect.stringContaining("60 compute minutes") });
		// A session limit of 0 means no workspace at all.
		await expect(s.scheduler.admit(await thread("zed"), "mins", "zed")).rejects.toMatchObject({ code: "quota", message: expect.stringContaining("session length limit is 0") });
	});

	it("counts a stretch toward each month it ran in, by when it ran", async () => {
		const day = new Date(s.clock());
		const first = Date.UTC(day.getUTCFullYear(), day.getUTCMonth(), 1);
		await s.pool.query("insert into pim_forge.forge_quotas (subject_type, subject_id, compute_minutes) values ('user', 'mia', 25)");
		// 30 minutes of October and 20 of November: only the 20 count against November's 25.
		await s.pool.query("insert into pim_forge.forge_compute_usage (owner_id, thread_id, provider, began_at, ended_at) values ('mia', 'x', 'local', $1, $2)", [new Date(first - 30 * 60_000), new Date(first + 20 * 60_000)]);
		s.advance(Math.max(0, first + 21 * 60_000 - s.clock()));
		expect(await s.scheduler.admit(await thread("mia"), "mins", "mia")).toMatchObject({ kind: "slot", wallClockMin: 5 });
	});

	it("counts a harness sign-in's sandbox against the quota, and ends it at its limit", async () => {
		await s.pool.query("insert into pim_forge.forge_quotas (subject_type, subject_id, max_concurrent) values ('user', 'ned', 1)");
		expect(await s.scheduler.beginSandbox("ned", loginKey("ned", "codex"), "local", { maxMinutes: 20 })).toEqual({ wallClockMin: 20 });
		// It holds the person's one workspace, so a thread is refused until it ends.
		const t = await thread("ned");
		await expect(s.scheduler.admit(t, "mins", "ned")).rejects.toMatchObject({ code: "quota", message: expect.stringContaining("concurrent") });
		await s.scheduler.endSandbox(loginKey("ned", "codex"));
		expect((await s.scheduler.admit(t, "mins", "ned")).kind).toBe("slot");
		await s.scheduler.release(t);
		// One nobody ended stops counting at the end it was given, so a restart doesn't leave it running.
		await s.scheduler.beginSandbox("ned", loginKey("ned", "claude-code"), "local", { maxMinutes: 20 });
		s.advance(21 * 60_000);
		await s.scheduler.overCap();
		expect((await s.pool.query("select ended_at is not null as ended, reason from pim_forge.forge_compute_usage where thread_id = $1", [loginKey("ned", "claude-code")])).rows[0]).toEqual({ ended: true, reason: "session_limit" });
		expect(SESSION_CAP_GRACE_MS).toBeGreaterThan(0);
	});
});
