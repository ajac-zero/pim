import { env, runDurableObjectAlarm, runInDurableObject } from "cloudflare:test";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { conditionsFromHealth, type ManagerHealth } from "../src/coding/provider-capacity";
import type { AdmissionConditions } from "../src/coding/scheduler";
import { codingScheduler, MAX_NOTICE_ATTEMPTS, type SchedulerNotifier, TICK_MS } from "../src/coding/scheduler-do";
import { CodingSchedulerDO, codingSchedulers } from "./worker";

// Every space's scheduler here goes by a fake clock years ahead, so its alarms never go off on their own: tests run them.

const START = 2_000_000_000_000;
const MINUTE = 60 * 1000;

const space = () => codingScheduler(env, `space-${crypto.randomUUID()}`);
const alarmOf = (stub: DurableObjectStub<CodingSchedulerDO>) => runInDurableObject(stub, (_instance: CodingSchedulerDO, state) => state.storage.getAlarm());
const outbox = (stub: DurableObjectStub<CodingSchedulerDO>) =>
	runInDurableObject(stub, (_instance: CodingSchedulerDO, state) =>
		state.storage.sql
			.exec("SELECT kind, thread_id, attempts, dead FROM pim_coding_outbox ORDER BY seq")
			.toArray()
			.map((row) => `${row.kind}:${row.thread_id}:${row.attempts}${row.dead ? " dead" : ""}`),
	);

/** What the notifier heard, as `kind:thread`, and each notice's key in the same order. */
let heard: string[];
let keys: string[];
const recorder: SchedulerNotifier = {
	admitted: (threadId, key) => void (heard.push(`admitted:${threadId}`), keys.push(key)),
	expired: (entry, key) => void (heard.push(`expired:${entry.threadId}:${entry.reason}`), keys.push(key)),
	released: ({ threadId, why }, key) => void (heard.push(`released:${threadId}:${why}`), keys.push(key)),
};

beforeEach(() => {
	heard = [];
	keys = [];
	codingSchedulers.now = START;
	codingSchedulers.notifier = recorder;
});

afterEach(() => {
	codingSchedulers.now = null;
	codingSchedulers.notifier = null;
});

describe("a space's coding scheduler", () => {
	it("answers every method over RPC, with a limit of 2 until it is set", async () => {
		const stub = space();
		expect(await stub.request("a", { provider: "sandbox" })).toEqual({ status: "admitted" });
		expect(await stub.request("b", { provider: "sandbox" })).toEqual({ status: "admitted" });
		expect(await stub.request("c", { provider: "sandbox", reason: "resume" })).toEqual({ status: "queued", position: 1, reason: "resume" });
		expect(await stub.request("d", { provider: "sandbox" })).toEqual({ status: "queued", position: 2, reason: "slots_full" });
		expect(await stub.position("d")).toEqual({ position: 2, reason: "slots_full" });
		expect(await stub.cancel("d")).toBe(true);
		expect(await stub.position("d")).toBeNull();
		expect(await stub.setActivity("a", "waiting")).toBe(true);
		expect(await stub.setActivity("c", "idle")).toBe(false);
		const snapshot = await stub.snapshot();
		expect(snapshot.limit).toBe(2);
		expect(snapshot.running.map((slot) => `${slot.threadId}:${slot.activity}`)).toEqual(["a:waiting", "b:running"]);
		expect(snapshot.queued).toEqual([{ threadId: "c", provider: "sandbox", reason: "resume", priority: 0, queuedAt: START, deadlineAt: START + 6 * 60 * MINUTE }]);
		for (const ms of [10, 20, 30, 40, 50]) await stub.recordDuration(ms);
		expect(await stub.etaMs(1)).toBe(15);
		expect(await stub.setConditions({ lowDisk: true, budgetCapped: false, detail: "3% free" })).toEqual([]);
		expect(await stub.setLimit(3)).toEqual([]);
		expect(await stub.position("c")).toEqual({ position: 1, reason: "low_disk", detail: "3% free" });
		expect(await stub.setConditions({ lowDisk: false, budgetCapped: false })).toEqual(["c"]);
		codingSchedulers.now = START + 5 * MINUTE;
		expect(await stub.request("e", { provider: "sandbox" })).toEqual({ status: "queued", position: 1, reason: "slots_full" });
		expect(await stub.sweep()).toEqual({ released: [{ threadId: "a", why: "preempted" }], admitted: ["e"] });
		expect(await stub.reconcile(["b", "e", "x"])).toEqual({ released: ["c"], adopted: ["x"], admitted: [] });
		expect(await stub.release("x")).toEqual([]);
		expect((await stub.snapshot()).running.map((slot) => slot.threadId)).toEqual(["b", "e"]);
	});

	it("sets its alarm 30 seconds on while a thread is queued or a slot's thread is idle or waiting, and none with nothing to do", async () => {
		const stub = space();
		await stub.request("a", { provider: "sandbox" });
		await stub.request("b", { provider: "sandbox" });
		// Two threads running: nothing for a tick to do.
		expect(await alarmOf(stub)).toBeNull();
		await stub.request("c", { provider: "sandbox" });
		expect(await alarmOf(stub)).toBe(START + TICK_MS);
		// Asking again later doesn't put off a tick already set.
		codingSchedulers.now = START + 10_000;
		await stub.request("d", { provider: "sandbox" });
		expect(await alarmOf(stub)).toBe(START + TICK_MS);
		expect(await stub.cancel("d")).toBe(true);
		expect(await stub.cancel("c")).toBe(true);
		expect(await alarmOf(stub)).toBeNull();
		await stub.setActivity("a", "idle");
		expect(await alarmOf(stub)).toBe(START + 10_000 + TICK_MS);
		await stub.setActivity("a", "running");
		expect(await alarmOf(stub)).toBeNull();
		await stub.setActivity("b", "waiting");
		codingSchedulers.now = START + 10_000 + TICK_MS;
		expect(await runDurableObjectAlarm(stub)).toBe(true);
		// b still waits for the person, so the alarm goes on ticking.
		expect(await alarmOf(stub)).toBe(START + 10_000 + 2 * TICK_MS);
		await stub.setActivity("b", "running");
		expect(await alarmOf(stub)).toBeNull();
	});

	it("expires and admits on its alarm by the clock, and tells each thread", async () => {
		const stub = space();
		await stub.setLimit(1);
		await stub.request("a", { provider: "sandbox" });
		await stub.request("b", { provider: "sandbox", deadlineMs: MINUTE });
		await stub.request("c", { provider: "sandbox" });
		await stub.setActivity("a", "idle");
		codingSchedulers.now = START + MINUTE - 1;
		await runDurableObjectAlarm(stub);
		expect(heard).toEqual([]);
		codingSchedulers.now = START + MINUTE;
		await runDurableObjectAlarm(stub);
		expect(heard).toEqual(["expired:b:slots_full"]);
		expect((await stub.snapshot()).queued.map((entry) => entry.threadId)).toEqual(["c"]);
		expect(await alarmOf(stub)).toBe(START + MINUTE + TICK_MS);
		codingSchedulers.now = START + 30 * MINUTE;
		await runDurableObjectAlarm(stub);
		expect(heard).toEqual(["expired:b:slots_full", "released:a:idle", "admitted:c"]);
		expect(new Set(keys).size).toBe(3);
		const { running, queued } = await stub.snapshot();
		expect(running.map((slot) => `${slot.threadId}:${slot.activity}:${slot.acquiredAt}`)).toEqual([`c:running:${START + 30 * MINUTE}`]);
		expect(queued).toEqual([]);
		expect(await outbox(stub)).toEqual([]);
		expect(await alarmOf(stub)).toBeNull();
	});

	it("tells a thread admitted by another's release on the next alarm, which it sets at once", async () => {
		const stub = space();
		await stub.setLimit(1);
		await stub.request("a", { provider: "sandbox" });
		await stub.request("b", { provider: "sandbox" });
		codingSchedulers.now = START + 5_000;
		expect(await stub.release("a")).toEqual(["b"]);
		expect(await outbox(stub)).toEqual(["admitted:b:0"]);
		expect(await alarmOf(stub)).toBe(START + 5_000);
		expect(heard).toEqual([]);
		await runDurableObjectAlarm(stub);
		expect(heard).toEqual(["admitted:b"]);
		expect(await alarmOf(stub)).toBeNull();
	});

	it("delivers every notice at least once through failures and restarts, with the same key each time, and each thread's in order", async () => {
		const stub = space();
		await stub.setLimit(1);
		await stub.request("a", { provider: "sandbox" });
		await stub.request("b", { provider: "sandbox" });
		await stub.setActivity("a", "waiting");
		// a is preempted for b, and asks again; then b ends, and a is admitted.
		codingSchedulers.now = START + 5 * MINUTE;
		expect(await stub.sweep()).toEqual({ released: [{ threadId: "a", why: "preempted" }], admitted: ["b"] });
		await stub.request("a", { provider: "sandbox", priority: 1000 });
		await stub.request("c", { provider: "sandbox" });
		expect(await stub.release("b")).toEqual(["a"]);
		expect(await outbox(stub)).toEqual(["released:a:0", "admitted:b:0", "admitted:a:0"]);

		// a's coding thread is down: b hears, and a's two notices wait, in order.
		const down = new Set(["a"]);
		codingSchedulers.notifier = {
			admitted: (threadId, key) => (down.has(threadId) ? Promise.reject(new Error("down")) : recorder.admitted(threadId, key)),
			expired: recorder.expired,
			released: (released, key) => (down.has(released.threadId) ? Promise.reject(new Error("down")) : recorder.released(released, key)),
		};
		codingSchedulers.now = START + 6 * MINUTE;
		await runDurableObjectAlarm(stub);
		expect(heard).toEqual(["admitted:b"]);
		// Only the first of a's was tried; the second waited behind it.
		expect(await outbox(stub)).toEqual(["released:a:1", "admitted:a:0"]);
		expect(await alarmOf(stub)).toBe(START + 6 * MINUTE + TICK_MS);

		await runInDurableObject(stub, async (_instance: CodingSchedulerDO, state) => {
			// A new instance on the same storage, as after a restart. a takes each notice but its answer is lost, so each stays to be delivered again.
			down.clear();
			const taken: string[] = [];
			codingSchedulers.notifier = {
				admitted: (threadId, key) => {
					taken.push(key);
					recorder.admitted(threadId, key);
					throw new Error("answer lost");
				},
				expired: recorder.expired,
				released: (released, key) => {
					taken.push(key);
					recorder.released(released, key);
					throw new Error("answer lost");
				},
			};
			await new CodingSchedulerDO(state, env).alarm();
			expect(taken).toHaveLength(1);
			// Then a's thread works again, after another restart: it hears both, in order, the first a second time with the key it had.
			codingSchedulers.notifier = recorder;
			await new CodingSchedulerDO(state, env).alarm();
			expect(state.storage.sql.exec("SELECT COUNT(*) AS n FROM pim_coding_outbox").one().n).toBe(0);
			// c is still queued, so the alarm goes on ticking.
			expect(await state.storage.getAlarm()).toBe(START + 6 * MINUTE + TICK_MS);
			expect(keys[2]).toBe(taken[0]);
		});
		expect(heard).toEqual(["admitted:b", "released:a:preempted", "released:a:preempted", "admitted:a"]);
		// A receiver that keeps the keys it has seen takes each notice once.
		expect([...new Set(keys)]).toHaveLength(3);
	});
});

describe("a notice that keeps failing", () => {
	afterEach(() => vi.restoreAllMocks());

	it("is tried 20 times, then kept dead: never tried again, logged once, holding up neither the thread's later notices nor the alarm", async () => {
		const stub = space();
		await stub.setLimit(1);
		await stub.request("a", { provider: "sandbox" });
		await stub.request("b", { provider: "sandbox" });
		await stub.setActivity("a", "waiting");
		// a is preempted for b and asks again; b ends, and a is admitted: a's release then its admission.
		codingSchedulers.now = START + 5 * MINUTE;
		await stub.sweep();
		await stub.request("a", { provider: "sandbox", priority: 1000 });
		expect(await stub.release("b")).toEqual(["a"]);
		// a's thread never takes the news of its release, but takes everything else.
		let tries = 0;
		codingSchedulers.notifier = {
			...recorder,
			released: () => {
				tries++;
				throw new Error("refused");
			},
		};
		const errors = vi.spyOn(console, "error").mockImplementation(() => {});
		vi.spyOn(console, "warn").mockImplementation(() => {});
		for (let attempt = 1; attempt < MAX_NOTICE_ATTEMPTS; attempt++) {
			codingSchedulers.now += TICK_MS;
			expect(await runDurableObjectAlarm(stub)).toBe(true);
		}
		// 19 failures: a's admission still waits behind its release, and the alarm is still set to try again.
		expect(heard).toEqual(["admitted:b"]);
		expect(await outbox(stub)).toEqual([`released:a:${MAX_NOTICE_ATTEMPTS - 1}`, "admitted:a:0"]);
		expect(await alarmOf(stub)).toBe(codingSchedulers.now + TICK_MS);
		codingSchedulers.now += TICK_MS;
		await runDurableObjectAlarm(stub);
		// The 20th failure kills it, and a's admission goes in the same alarm.
		expect(tries).toBe(MAX_NOTICE_ATTEMPTS);
		expect(heard).toEqual(["admitted:b", "admitted:a"]);
		expect(await outbox(stub)).toEqual([`released:a:${MAX_NOTICE_ATTEMPTS} dead`]);
		const dead = errors.mock.calls.map(([line]) => JSON.parse(String(line)));
		expect(dead).toEqual([{ event: "pim.coding.notice_dead", key: expect.stringMatching(/^coding:released:a:\d+$/), attempts: MAX_NOTICE_ATTEMPTS, error: "Error: refused" }]);
		// With only the dead notice left and a running, nothing keeps the alarm set, and running it anyway tries nothing.
		expect(await alarmOf(stub)).toBeNull();
		await runInDurableObject(stub, (instance: CodingSchedulerDO) => instance.alarm());
		expect(tries).toBe(MAX_NOTICE_ATTEMPTS);
		expect(errors).toHaveBeenCalledTimes(1);
		expect(await alarmOf(stub)).toBeNull();
		// a's later notices still go.
		await stub.setActivity("a", "idle");
		codingSchedulers.now += 30 * MINUTE;
		codingSchedulers.notifier = recorder;
		await runDurableObjectAlarm(stub);
		expect(heard).toEqual(["admitted:b", "admitted:a", "released:a:idle"]);
		expect(await outbox(stub)).toEqual([`released:a:${MAX_NOTICE_ATTEMPTS} dead`]);
		expect(await alarmOf(stub)).toBeNull();
	});
});

describe("the workspace manager's capacity", () => {
	const health = (freeDiskPct: number, maxConcurrent = 4): ManagerHealth => ({ freeDiskPct, maxConcurrent, running: 0, free: maxConcurrent });
	const clear: AdmissionConditions = { lowDisk: false, budgetCapped: false };

	it("maps the manager's free disk to the conditions, keeping the budget cap", () => {
		const table: [number, AdmissionConditions, AdmissionConditions][] = [
			[50, clear, clear],
			[15, clear, clear],
			[14.9, clear, { lowDisk: true, budgetCapped: false, detail: "14.9% of the disk free" }],
			[0, clear, { lowDisk: true, budgetCapped: false, detail: "0% of the disk free" }],
			[Number.NaN, clear, { lowDisk: true, budgetCapped: false, detail: "the disk's free space is unknown" }],
			// The budget cap and its detail stay while the disk has room.
			[50, { lowDisk: false, budgetCapped: true, detail: "$20 of $20" }, { lowDisk: false, budgetCapped: true, detail: "$20 of $20" }],
			// The disk's detail goes once the disk has room; the budget cap stays.
			[50, { lowDisk: true, budgetCapped: true, detail: "9% of the disk free" }, { lowDisk: false, budgetCapped: true }],
			[5, { lowDisk: false, budgetCapped: true, detail: "$20 of $20" }, { lowDisk: true, budgetCapped: true, detail: "5% of the disk free" }],
		];
		for (const [free, current, expected] of table) expect(conditionsFromHealth(health(free), current), `${free}% from ${JSON.stringify(current)}`).toEqual(expected);
	});

	it("sets the limit to the space's cap or the manager's, whichever is lower", async () => {
		const stub = space();
		for (const [spaceCap, maxConcurrent, limit] of [
			[2, 4, 2],
			[2, 1, 1],
			[5, 3, 3],
			[2, 0, 0],
		] as const) {
			await stub.refreshConditions(health(80, maxConcurrent), spaceCap);
			expect((await stub.snapshot()).limit, `cap ${spaceCap}, manager ${maxConcurrent}`).toBe(limit);
		}
		await stub.refreshConditions(health(80, 4));
		expect((await stub.snapshot()).limit).toBe(2);
	});

	it("admits no one the new limit and the new conditions together wouldn't, whichever way they change", async () => {
		// The limit falls as the disk clears: only one is admitted, not three.
		const falling = space();
		await falling.setLimit(3);
		await falling.setConditions({ lowDisk: true, budgetCapped: false });
		for (const id of ["a", "b", "c"]) await falling.request(id, { provider: "sandbox" });
		expect(await falling.refreshConditions(health(50, 1), 2)).toEqual(["a"]);
		// The limit rises as the disk runs low: no one is admitted.
		const rising = space();
		await rising.setLimit(1);
		for (const id of ["a", "b", "c"]) await rising.request(id, { provider: "sandbox" });
		expect(await rising.refreshConditions(health(5, 4), 4)).toEqual([]);
		expect(await rising.position("b")).toEqual({ position: 1, reason: "low_disk", detail: "5% of the disk free" });
		expect(await rising.refreshConditions(health(40, 4), 4)).toEqual(["b", "c"]);
	});

	it("holds the queue on the manager's low_disk refusal until its health says the disk has room, and ignores capacity", async () => {
		const stub = space();
		await stub.setConditions({ lowDisk: false, budgetCapped: false, detail: "kept" });
		for (const id of ["a", "b", "c"]) await stub.request(id, { provider: "sandbox" });
		expect(await stub.onManagerError("capacity")).toEqual([]);
		expect(await stub.onManagerError("something_else")).toEqual([]);
		expect(await stub.release("a")).toEqual(["c"]);
		await stub.request("d", { provider: "sandbox" });
		expect(await stub.onManagerError("low_disk")).toEqual([]);
		expect(await stub.release("b")).toEqual([]);
		expect(await stub.position("d")).toEqual({ position: 1, reason: "low_disk" });
		expect(await stub.refreshConditions(health(30, 4))).toEqual(["d"]);
	});
});
