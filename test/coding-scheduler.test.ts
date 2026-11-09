import { env, runInDurableObject } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { type AdmissionGate, budgetCapGate, CodingScheduler, lowDiskGate, PREEMPT_RESUME_PRIORITY, type RequestResult, type Slot } from "../src/coding/scheduler";
import type { Pim } from "../src/pim";

// These tests build the scheduler on a Durable Object's database of its own, with a fake clock; nothing of Pim's own is touched.

const START = 1_800_000_000_000;

type Context = {
	scheduler: CodingScheduler;
	clock: { now: number };
	sql: SqlStorage;
	/** A new scheduler on the same database, as after the Durable Object restarts; `crash` aborts every transaction before it commits. */
	make: (options?: MakeOptions) => CodingScheduler;
};

type MakeOptions = { defaultLimit?: number; crash?: boolean; gates?: readonly AdmissionGate[]; defaultDeadlineMs?: number; idleMs?: number; waitingGraceMs?: number };

async function withScheduler(work: (context: Context) => void, defaultLimit = 1): Promise<void> {
	await runInDurableObject(env.Pim.getByName(`coding-${crypto.randomUUID()}`), (_pim: Pim, state) => {
		const clock = { now: START };
		const make = (options: MakeOptions = {}) =>
			new CodingScheduler(state.storage.sql, {
				transaction: (run) =>
					state.storage.transactionSync(() => {
						const result = run();
						if (options.crash) throw new Error("crash before commit");
						return result;
					}),
				now: () => clock.now,
				defaultLimit: options.defaultLimit ?? defaultLimit,
				...(options.gates ? { gates: options.gates } : {}),
				...(options.defaultDeadlineMs === undefined ? {} : { defaultDeadlineMs: options.defaultDeadlineMs }),
				...(options.idleMs === undefined ? {} : { idleMs: options.idleMs }),
				...(options.waitingGraceMs === undefined ? {} : { waitingGraceMs: options.waitingGraceMs }),
			});
		work({ scheduler: make(), clock, sql: state.storage.sql, make });
	});
}

const running = (scheduler: CodingScheduler) => scheduler.snapshot().running.map((slot) => slot.threadId);
const queued = (scheduler: CodingScheduler) => scheduler.snapshot().queued.map((entry) => entry.threadId);
const ask = (scheduler: CodingScheduler, ...threadIds: string[]) => threadIds.map((id) => scheduler.request(id, { provider: "sandbox" }));
const place = (scheduler: CodingScheduler, id: string) => scheduler.position(id)?.position ?? null;
const reasons = (scheduler: CodingScheduler) => scheduler.snapshot().queued.map((entry) => `${entry.threadId}:${entry.reason}`);
const SIX_HOURS = 6 * 60 * 60 * 1000;
const MINUTE = 60 * 1000;
const activities = (scheduler: CodingScheduler) => scheduler.snapshot().running.map((slot) => `${slot.threadId}:${slot.activity}`);

/** A small seeded generator, so a failing interleaving can be run again. */
function random(seed: number): () => number {
	let state = seed >>> 0;
	return () => {
		state = (state + 0x6d2b79f5) >>> 0;
		let t = state;
		t = Math.imul(t ^ (t >>> 15), t | 1);
		t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
		return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
	};
}

/**
 * The scheduler's contract with every priority 0, as plainly as it can be
 * written: a set of running threads, a first come, first served list, and,
 * while the disk is low or the budget capped, no one admitted at all.
 */
class Model {
	running = new Set<string>();
	queue: string[] = [];
	blockedBy: string | null = null;
	constructor(readonly limit: number) {}
	request(id: string): RequestResult {
		if (!this.running.has(id) && !this.queue.includes(id)) this.queue.push(id);
		this.#admit();
		return this.running.has(id) ? { status: "admitted" } : { status: "queued", position: this.queue.indexOf(id) + 1, reason: this.reason(id) };
	}
	/** A thread waits for the gate only when a slot is free for it. */
	reason(id: string): string {
		return this.blockedBy && this.queue.indexOf(id) < this.limit - this.running.size ? this.blockedBy : "slots_full";
	}
	setConditions(lowDisk: boolean, budgetCapped: boolean): string[] {
		this.blockedBy = lowDisk ? "low_disk" : budgetCapped ? "budget_cap" : null;
		return this.#admit();
	}
	release(id: string): string[] {
		this.running.delete(id);
		return this.#admit();
	}
	cancel(id: string): boolean {
		const index = this.queue.indexOf(id);
		if (index >= 0) this.queue.splice(index, 1);
		return index >= 0;
	}
	#admit(): string[] {
		const admitted: string[] = [];
		while (!this.blockedBy && this.running.size < this.limit && this.queue.length > 0) {
			const id = this.queue.shift()!;
			this.running.add(id);
			admitted.push(id);
		}
		return admitted;
	}
}

describe("the coding scheduler", () => {
	it("never takes more slots than the limit, and admits first come, first served, under random requests, releases, cancels, low disk, budget caps and restarts", async () => {
		for (const seed of [1, 2, 3, 4, 5]) {
			await withScheduler(({ make, clock }) => {
				const next = random(seed);
				const limit = 1 + Math.floor(next() * 4);
				const ids = Array.from({ length: 30 }, (_, i) => `t${(i * 7) % 30}`);
				const pick = () => ids[Math.floor(next() * ids.length)]!;
				const model = new Model(limit);
				let scheduler = make({ defaultLimit: limit });
				let admittedEver = 0;
				let blockedSteps = 0;
				for (let step = 0; step < 600; step++) {
					// Often no time passes between steps, so the queue's order rests on more than the clock.
					clock.now += next() < 0.5 ? 0 : 1;
					const roll = next();
					const id = pick();
					const where = `seed ${seed}, step ${step}`;
					if (roll < 0.05) {
						scheduler = make({ defaultLimit: limit });
					} else if (roll < 0.55) {
						expect(scheduler.request(id, { provider: "sandbox" }), where).toEqual(model.request(id));
					} else if (roll < 0.62) {
						// The disk and the budget come and go, each low about a fifth of the time.
						const lowDisk = next() < 0.2;
						const budgetCapped = next() < 0.2;
						const admitted = scheduler.setConditions({ lowDisk, budgetCapped });
						expect(admitted, where).toEqual(model.setConditions(lowDisk, budgetCapped));
						admittedEver += admitted.length;
					} else if (roll < 0.88) {
						// Mostly a thread that holds a slot, now and then one that doesn't.
						const holders = [...model.running];
						const released = holders.length > 0 && next() < 0.8 ? holders[Math.floor(next() * holders.length)]! : id;
						const admitted = scheduler.release(released);
						expect(admitted, where).toEqual(model.release(released));
						admittedEver += admitted.length;
					} else {
						expect(scheduler.cancel(id), where).toBe(model.cancel(id));
					}
					const snapshot = scheduler.snapshot();
					expect(snapshot.running.length, where).toBeLessThanOrEqual(limit);
					expect(new Set(snapshot.running.map((slot) => slot.threadId)), where).toEqual(model.running);
					expect(snapshot.queued.map((entry) => entry.threadId), where).toEqual(model.queue);
					expect(snapshot.queued.map((entry) => entry.reason), where).toEqual(model.queue.map((id) => model.reason(id)));
					if (model.blockedBy && model.queue.length > 0 && model.running.size < limit) blockedSteps++;
				}
				// The run did fill the slots and admit from the queue, and a gate did hold up a head with a slot free for it, rather than pass by never being busy or never blocked.
				expect(admittedEver).toBeGreaterThan(60);
				expect(blockedSteps).toBeGreaterThan(60);
			});
		}
	});

	it("admits strictly in the order threads asked, not by their ids", async () => {
		await withScheduler(({ scheduler, clock }) => {
			expect(scheduler.request("r", { provider: "sandbox" })).toEqual({ status: "admitted" });
			// z and a ask in the same millisecond; m later.
			expect(ask(scheduler, "z", "a")).toEqual([
				{ status: "queued", position: 1, reason: "slots_full" },
				{ status: "queued", position: 2, reason: "slots_full" },
			]);
			clock.now += 1;
			expect(scheduler.request("m", { provider: "sandbox", reason: "resume" })).toEqual({ status: "queued", position: 3, reason: "resume" });
			expect(queued(scheduler)).toEqual(["z", "a", "m"]);
			expect(scheduler.release("r")).toEqual(["z"]);
			expect(scheduler.release("z")).toEqual(["a"]);
			expect(scheduler.release("a")).toEqual(["m"]);
			expect(scheduler.release("m")).toEqual([]);
			expect(scheduler.snapshot()).toEqual({ limit: 1, running: [], queued: [] });
		});
	});

	it("takes a thread out of the queue from its head or its middle, and leaves a running one alone", async () => {
		await withScheduler(({ scheduler }) => {
			ask(scheduler, "r", "a", "b", "c", "d");
			expect(scheduler.cancel("b")).toBe(true);
			expect(["a", "c", "d"].map((id) => place(scheduler, id))).toEqual([1, 2, 3]);
			expect(scheduler.position("b")).toBeNull();
			expect(scheduler.cancel("a")).toBe(true);
			expect(["c", "d"].map((id) => place(scheduler, id))).toEqual([1, 2]);
			expect(scheduler.cancel("a")).toBe(false);
			expect(scheduler.cancel("nobody")).toBe(false);
			// A running thread isn't queued; cancelling it doesn't free its slot.
			expect(scheduler.cancel("r")).toBe(false);
			expect(running(scheduler)).toEqual(["r"]);
			expect(scheduler.release("r")).toEqual(["c"]);
			expect(queued(scheduler)).toEqual(["d"]);
		});
	});

	it("answers a request asked again the same way, without queueing or admitting twice", async () => {
		await withScheduler(({ scheduler, clock }) => {
			expect(scheduler.request("a", { provider: "sandbox" })).toEqual({ status: "admitted" });
			expect(scheduler.request("a", { provider: "other" })).toEqual({ status: "admitted" });
			expect(scheduler.request("b", { provider: "sandbox", reason: "first", deadlineMs: 1_000 })).toEqual({ status: "queued", position: 1, reason: "first" });
			clock.now += 500;
			expect(scheduler.request("b", { provider: "other", reason: "second", deadlineMs: 60_000 })).toEqual({ status: "queued", position: 1, reason: "first" });
			const snapshot = scheduler.snapshot();
			expect(snapshot.running).toEqual([{ threadId: "a", provider: "sandbox", acquiredAt: START, state: "admitted", activity: "running", activitySince: START }]);
			expect(snapshot.queued).toEqual([{ threadId: "b", provider: "sandbox", reason: "first", priority: 0, queuedAt: START, deadlineAt: START + 1_000 }]);
			expect(scheduler.release("a")).toEqual(["b"]);
			expect(scheduler.request("b", { provider: "sandbox" })).toEqual({ status: "admitted" });
			expect(scheduler.release("a")).toEqual([]);
			expect(scheduler.snapshot().running).toEqual([{ threadId: "b", provider: "sandbox", acquiredAt: START + 500, state: "admitted", activity: "running", activitySince: START + 500 }]);
			expect(queued(scheduler)).toEqual([]);
		});
	});

	it("keeps every slot and place in the queue through a restart, and loses nothing to a crashed transaction", async () => {
		await withScheduler(
			({ scheduler, make }) => {
				ask(scheduler, "a", "b", "c", "d", "e");
				const before = scheduler.snapshot();
				const again = make();
				expect(again.snapshot()).toEqual(before);
				expect(again.request("a", { provider: "sandbox" })).toEqual({ status: "admitted" });
				expect(again.request("c", { provider: "sandbox" })).toEqual({ status: "queued", position: 1, reason: "slots_full" });
				expect(() => make({ crash: true }).release("a")).toThrow("crash before commit");
				expect(() => make({ crash: true }).request("f", { provider: "sandbox" })).toThrow("crash before commit");
				expect(make().snapshot()).toEqual(before);
			},
			2,
		);
	});

	it("reconciles with the workspaces running after a restart: releases orphans, adopts the live past the limit, and admits into what's free", async () => {
		await withScheduler(
			({ scheduler, make, clock }) => {
				ask(scheduler, "a", "b", "c");
				scheduler.request("d", { provider: "vm" });
				clock.now += 10;
				const restarted = make();
				// a's workspace is gone; b's runs; d was queued but its workspace runs; x runs with no record at all.
				expect(restarted.reconcile(["b", "d", "x"])).toEqual({ released: ["a"], adopted: ["d", "x"], admitted: [] });
				const snapshot = restarted.snapshot();
				expect(snapshot.running).toEqual([
					{ threadId: "b", provider: "sandbox", acquiredAt: START, state: "admitted", activity: "running", activitySince: START },
					{ threadId: "d", provider: "vm", acquiredAt: START + 10, state: "adopted", activity: "running", activitySince: START + 10 },
					{ threadId: "x", provider: null, acquiredAt: START + 10, state: "adopted", activity: "running", activitySince: START + 10 },
				]);
				expect(snapshot.queued.map((entry) => entry.threadId)).toEqual(["c"]);
				// Three running against a limit of two: nothing is admitted until two of them end.
				expect(restarted.release("b")).toEqual([]);
				expect(restarted.request("c", { provider: "sandbox" })).toEqual({ status: "queued", position: 1, reason: "slots_full" });
				expect(restarted.release("x")).toEqual(["c"]);
				// Run again with the same answer, it changes nothing.
				expect(restarted.reconcile(["c", "d"])).toEqual({ released: [], adopted: [], admitted: [] });
				// An orphan's slot goes to the queue's head in the same step.
				ask(restarted, "e");
				expect(restarted.reconcile(["d"])).toEqual({ released: ["c"], adopted: [], admitted: ["e"] });
				expect(running(restarted).sort()).toEqual(["d", "e"]);
			},
			2,
		);
	});

	it("takes threads out of the queue once their deadline comes, in queue order", async () => {
		await withScheduler(({ scheduler, clock }) => {
			ask(scheduler, "r");
			scheduler.request("a", { provider: "sandbox", deadlineMs: 1_000 });
			scheduler.request("b", { provider: "sandbox" });
			clock.now += 100;
			scheduler.request("c", { provider: "sandbox", reason: "resume", deadlineMs: 400 });
			expect(scheduler.expire(START + 499)).toEqual([]);
			expect(scheduler.expire(START + 500)).toEqual([{ threadId: "c", provider: "sandbox", reason: "resume", priority: 0, queuedAt: START + 100, deadlineAt: START + 500 }]);
			expect(queued(scheduler)).toEqual(["a", "b"]);
			clock.now = START + 5_000;
			expect(scheduler.expire().map((entry) => entry.threadId)).toEqual(["a"]);
			expect(scheduler.position("b")).toEqual({ position: 1, reason: "slots_full" });
			expect(scheduler.expire(START + 1_000_000)).toEqual([]);
			expect(running(scheduler)).toEqual(["r"]);
		});
	});

	it("admits more when the limit is raised, stops no one when it is lowered, and keeps it through a restart", async () => {
		await withScheduler(({ scheduler, make }) => {
			ask(scheduler, "a", "b", "c", "d");
			expect(scheduler.setLimit(3)).toEqual(["b", "c"]);
			expect(scheduler.snapshot().limit).toBe(3);
			expect(scheduler.setLimit(1)).toEqual([]);
			expect(running(scheduler)).toEqual(["a", "b", "c"]);
			expect(scheduler.release("b")).toEqual([]);
			expect(scheduler.release("c")).toEqual([]);
			expect(scheduler.release("a")).toEqual(["d"]);
			expect(make({ defaultLimit: 5 }).snapshot().limit).toBe(1);
			expect(() => scheduler.setLimit(1.5)).toThrow(RangeError);
			expect(() => scheduler.setLimit(-1)).toThrow(RangeError);
		});
	});

	it("puts higher priority first, and first come, first served within a priority", async () => {
		await withScheduler(({ scheduler, clock }) => {
			ask(scheduler, "r");
			scheduler.request("a", { provider: "sandbox" });
			scheduler.request("b", { provider: "sandbox", priority: -1 });
			clock.now += 1;
			scheduler.request("c", { provider: "sandbox", priority: 5 });
			scheduler.request("d", { provider: "sandbox" });
			expect(scheduler.request("e", { provider: "sandbox", priority: 5 })).toEqual({ status: "queued", position: 2, reason: "slots_full" });
			expect(queued(scheduler)).toEqual(["c", "e", "a", "d", "b"]);
			expect(["c", "e", "a", "d", "b"].map((id) => place(scheduler, id))).toEqual([1, 2, 3, 4, 5]);
			expect(scheduler.release("r")).toEqual(["c"]);
			expect(scheduler.setLimit(4)).toEqual(["e", "a", "d"]);
		});
	});

	it("estimates the wait from the median of the latest 20 sessions, and not from fewer than 5", async () => {
		await withScheduler(({ scheduler, make }) => {
			for (const ms of [10, 50, 20, 40]) scheduler.recordDuration(ms);
			expect(scheduler.etaMs(1)).toBeNull();
			scheduler.recordDuration(30);
			// The median of 10, 20, 30, 40 and 50 is 30, for each of 2 slots.
			scheduler.setLimit(2);
			expect(scheduler.etaMs(1)).toBe(15);
			expect(scheduler.etaMs(4)).toBe(60);
			// With an even count, it's halfway between the middle two: 30 and 40.
			scheduler.recordDuration(1_000);
			expect(scheduler.etaMs(2)).toBe(35);
			// 15 slow sessions then 10 quick ones: the latest 20 are 10 of each.
			for (let i = 0; i < 15; i++) scheduler.recordDuration(1_000);
			for (let i = 0; i < 10; i++) scheduler.recordDuration(100);
			expect(make().etaMs(1)).toBe(275);
			scheduler.setLimit(0);
			expect(scheduler.etaMs(1)).toBeNull();
			expect(() => scheduler.etaMs(0)).toThrow(RangeError);
		});
	});

	for (const [reason, conditions] of [
		["low_disk", { lowDisk: true, budgetCapped: false }],
		["budget_cap", { lowDisk: false, budgetCapped: true }],
	] as const) {
		it(`keeps the queue waiting while ${reason} holds, says so to the threads a free slot waits for, and drains first come, first served once it clears`, async () => {
			await withScheduler(({ scheduler }) => {
				expect(scheduler.setConditions({ ...conditions, detail: "the detail" })).toEqual([]);
				expect(ask(scheduler, "a", "b", "c")).toEqual([
					{ status: "queued", position: 1, reason, detail: "the detail" },
					{ status: "queued", position: 2, reason, detail: "the detail" },
					// Two slots are free, so the third would wait for one whatever the gates say.
					{ status: "queued", position: 3, reason: "slots_full" },
				]);
				expect(scheduler.position("b")).toEqual({ position: 2, reason, detail: "the detail" });
				expect(scheduler.snapshot().queued[0]).toEqual({ threadId: "a", provider: "sandbox", reason, detail: "the detail", priority: 0, queuedAt: START, deadlineAt: START + SIX_HOURS });
				// Nothing else that admits lets anyone past it.
				expect(scheduler.release("nobody")).toEqual([]);
				expect(scheduler.setLimit(2)).toEqual([]);
				expect(scheduler.tick()).toEqual({ expired: [], admitted: [], released: [] });
				expect(scheduler.reconcile([])).toEqual({ released: [], adopted: [], admitted: [] });
				expect(running(scheduler)).toEqual([]);
				expect(scheduler.setConditions({ ...conditions, detail: "newer detail" })).toEqual([]);
				expect(scheduler.position("a")).toEqual({ position: 1, reason, detail: "newer detail" });
				expect(scheduler.setConditions({ lowDisk: false, budgetCapped: false })).toEqual(["a", "b"]);
				expect(scheduler.position("c")).toEqual({ position: 1, reason: "slots_full" });
				expect(scheduler.release("a")).toEqual(["c"]);
				expect(running(scheduler)).toEqual(["b", "c"]);
			}, 2);
		});
	}

	it("shows a gate's reason only while a slot is free, and the first gate in order that refuses", async () => {
		await withScheduler(({ scheduler, make }) => {
			ask(scheduler, "r", "a");
			expect(scheduler.setConditions({ lowDisk: true, budgetCapped: true })).toEqual([]);
			// r holds the only slot: a waits for it, not for the disk.
			expect(scheduler.position("a")).toEqual({ position: 1, reason: "slots_full" });
			expect(scheduler.release("r")).toEqual([]);
			expect(scheduler.position("a")).toEqual({ position: 1, reason: "low_disk" });
			expect(make({ gates: [budgetCapGate, lowDiskGate] }).position("a")).toEqual({ position: 1, reason: "budget_cap" });
			expect(scheduler.setConditions({ lowDisk: false, budgetCapped: true })).toEqual([]);
			expect(scheduler.position("a")).toEqual({ position: 1, reason: "budget_cap" });
			expect(scheduler.setLimit(0)).toEqual([]);
			expect(reasons(scheduler)).toEqual(["a:slots_full"]);
			expect(scheduler.setLimit(1)).toEqual([]);
			expect(reasons(scheduler)).toEqual(["a:budget_cap"]);
			// With no gates, the conditions mean nothing.
			expect(make({ gates: [] }).release("nobody")).toEqual(["a"]);
		});
	});

	it("holds the whole queue behind a head a gate refuses, even threads the gate would let through", async () => {
		await withScheduler(({ make }) => {
			let vmDown = true;
			const vmGate: AdmissionGate = { check: (entry) => (entry.provider === "vm" && vmDown ? { ok: false, reason: "provider_down", detail: "vm is down" } : { ok: true }) };
			const scheduler = make({ defaultLimit: 3, gates: [vmGate] });
			expect(scheduler.request("v", { provider: "vm" })).toEqual({ status: "queued", position: 1, reason: "provider_down", detail: "vm is down" });
			expect(ask(scheduler, "s1", "s2", "s3").map((result) => (result.status === "queued" ? result.reason : result.status))).toEqual(["provider_down", "provider_down", "slots_full"]);
			expect(running(scheduler)).toEqual([]);
			// A higher priority goes in front of v, and nothing refuses it.
			expect(scheduler.request("p", { provider: "sandbox", priority: 1 })).toEqual({ status: "admitted" });
			expect(reasons(scheduler)).toEqual(["v:provider_down", "s1:provider_down", "s2:slots_full", "s3:slots_full"]);
			// Once v leaves, the next tick admits the threads behind it.
			expect(scheduler.cancel("v")).toBe(true);
			expect(scheduler.tick()).toEqual({ expired: [], admitted: ["s1", "s2"], released: [] });
			expect(scheduler.request("w", { provider: "vm" })).toEqual({ status: "queued", position: 2, reason: "slots_full" });
			expect(scheduler.release("p")).toEqual(["s3"]);
			expect(scheduler.release("s1")).toEqual([]);
			expect(reasons(scheduler)).toEqual(["w:provider_down"]);
			// The gate's world changes outside the scheduler; the next tick sees it.
			vmDown = false;
			expect(scheduler.tick()).toEqual({ expired: [], admitted: ["w"], released: [] });
			expect(running(scheduler).sort()).toEqual(["s2", "s3", "w"]);
		});
	});

	it("gives every thread 6 hours in the queue by default, and an expired one the reason it was last waiting for", async () => {
		await withScheduler(({ scheduler, clock, make }) => {
			ask(scheduler, "r", "a");
			clock.now = START + 60 * 60 * 1000;
			scheduler.request("b", { provider: "sandbox", deadlineMs: 8 * 60 * 60 * 1000 });
			scheduler.setConditions({ lowDisk: true, budgetCapped: false, detail: "5% free" });
			// a waited for a slot first, then for the disk once r ended.
			expect(scheduler.release("r")).toEqual([]);
			expect(reasons(scheduler)).toEqual(["a:low_disk", "b:slots_full"]);
			expect(scheduler.tick(START + SIX_HOURS - 1)).toEqual({ expired: [], admitted: [], released: [] });
			clock.now = START + SIX_HOURS;
			expect(scheduler.tick()).toEqual({
				expired: [{ threadId: "a", provider: "sandbox", reason: "low_disk", detail: "5% free", priority: 0, queuedAt: START, deadlineAt: START + SIX_HOURS }],
				admitted: [],
				released: [],
			});
			expect(reasons(scheduler)).toEqual(["b:low_disk"]);
			// c waits for the disk behind b, then, once b takes the slot, for a slot.
			expect(scheduler.request("c", { provider: "sandbox" })).toEqual({ status: "queued", position: 2, reason: "slots_full" });
			expect(scheduler.setConditions({ lowDisk: false, budgetCapped: false })).toEqual(["b"]);
			expect(scheduler.tick(START + 2 * SIX_HOURS)).toEqual({
				expired: [{ threadId: "c", provider: "sandbox", reason: "slots_full", priority: 0, queuedAt: START + SIX_HOURS, deadlineAt: START + 2 * SIX_HOURS }],
				admitted: [],
				released: [],
			});
			const quick = make({ defaultDeadlineMs: 60_000 });
			quick.request("d", { provider: "sandbox" });
			expect(quick.snapshot().queued[0]?.deadlineAt).toBe(clock.now + 60_000);
			expect(() => make({ defaultDeadlineMs: -1 })).toThrow(RangeError);
		});
	});

	it("keeps a head held up by low disk through a restart, and loses no condition to a crashed transaction", async () => {
		await withScheduler(
			({ scheduler, make }) => {
				scheduler.setConditions({ lowDisk: true, budgetCapped: false, detail: "9% free" });
				ask(scheduler, "a", "b", "c");
				const before = scheduler.snapshot();
				expect(before.queued.map((entry) => entry.reason)).toEqual(["low_disk", "low_disk", "slots_full"]);
				const again = make();
				expect(again.snapshot()).toEqual(before);
				expect(again.request("a", { provider: "sandbox" })).toEqual({ status: "queued", position: 1, reason: "low_disk", detail: "9% free" });
				expect(again.reconcile([])).toEqual({ released: [], adopted: [], admitted: [] });
				expect(again.tick()).toEqual({ expired: [], admitted: [], released: [] });
				expect(() => make({ crash: true }).setConditions({ lowDisk: false, budgetCapped: false })).toThrow("crash before commit");
				expect(make().snapshot()).toEqual(before);
				expect(make().setConditions({ lowDisk: false, budgetCapped: false })).toEqual(["a", "b"]);
				expect(running(scheduler)).toEqual(["a", "b"]);
			},
			2,
		);
	});
	it("never sweeps a running thread nor takes more slots than the limit, and sweeps exactly the idle and waiting slots the rules say, under random activity, requests, releases, conditions and restarts", async () => {
		for (const seed of [1, 2, 3, 4, 5]) {
			await withScheduler(({ make, clock }) => {
				const next = random(seed);
				const limit = 1 + Math.floor(next() * 4);
				const idleMs = 25;
				const graceMs = 10;
				const options = { defaultLimit: limit, idleMs, waitingGraceMs: graceMs };
				let scheduler = make(options);
				const ids = Array.from({ length: 12 }, (_, i) => `t${i}`);
				const pick = () => ids[Math.floor(next() * ids.length)]!;
				const any = (slots: Slot[]) => slots[Math.floor(next() * slots.length)]!.threadId;
				let blocked = false;
				// What this test has said each slot's thread is doing, and since when.
				const said = new Map<string, { activity: Slot["activity"]; since: number }>();
				const seen = { idle: 0, preempted: 0, heldBack: 0 };
				for (let step = 0; step < 1000; step++) {
					clock.now += Math.floor(next() * 6);
					const now = clock.now;
					const where = `seed ${seed}, step ${step}`;
					const before = scheduler.snapshot();
					const roll = next();
					if (roll < 0.04) {
						scheduler = make(options);
					} else if (roll < 0.3) {
						scheduler.request(pick(), { provider: "sandbox" });
					} else if (roll < 0.36) {
						const lowDisk = next() < 0.3;
						const budgetCapped = next() < 0.15;
						blocked = lowDisk || budgetCapped;
						scheduler.setConditions({ lowDisk, budgetCapped });
					} else if (roll < 0.46) {
						scheduler.release(before.running.length > 0 ? any(before.running) : pick());
					} else if (roll < 0.75) {
						const id = before.running.length > 0 && next() < 0.9 ? any(before.running) : pick();
						const activity = (["running", "idle", "waiting"] as const)[Math.floor(next() * 3)]!;
						expect(scheduler.setActivity(id, activity), where).toBe(said.has(id));
						// Saying again what a thread is already doing keeps the time it began.
						if (said.has(id) && said.get(id)!.activity !== activity) said.set(id, { activity, since: now });
					} else {
						const { released, admitted } = next() < 0.5 ? scheduler.sweep() : scheduler.tick();
						const after = scheduler.snapshot();
						const was = new Map(before.running.map((slot) => [slot.threadId, slot]));
						for (const { threadId, why } of released) {
							const slot = was.get(threadId);
							expect(slot?.activity, where).toBe(why === "idle" ? "idle" : "waiting");
							expect(slot!.activitySince, where).toBeLessThanOrEqual(now - (why === "idle" ? idleMs : graceMs));
						}
						for (const slot of before.running.filter((slot) => slot.activity === "running")) expect(running(scheduler), where).toContain(slot.threadId);
						// Every idle slot past its time goes, whether or not anyone is queued.
						expect(after.running.filter((slot) => slot.activity === "idle" && slot.activitySince <= now - idleMs), where).toEqual([]);
						// Each preempted slot goes to a queued thread, and a waiting thread past its grace stays only when no queued thread could take its slot.
						const preempted = released.filter((entry) => entry.why === "preempted").map((entry) => was.get(entry.threadId)!.activitySince);
						expect(preempted.length, where).toBeLessThanOrEqual(admitted.length);
						const stale = after.running.filter((slot) => slot.activity === "waiting" && slot.activitySince <= now - graceMs);
						if (stale.length > 0) expect(after.queued.length === 0 || blocked, where).toBe(true);
						// The longest waiting go first.
						for (const slot of stale) for (const since of preempted) expect(since, where).toBeLessThanOrEqual(slot.activitySince);
						seen.idle += released.length - preempted.length;
						seen.preempted += preempted.length;
						if (stale.length > 0 && after.queued.length > 0) seen.heldBack++;
					}
					const after = scheduler.snapshot();
					expect(after.running.length, where).toBeLessThanOrEqual(limit);
					// A thread new to a slot is running since it took it; the rest are as last said, through restarts.
					const holders = new Set(after.running.map((slot) => slot.threadId));
					for (const id of said.keys()) if (!holders.has(id)) said.delete(id);
					for (const slot of after.running) if (!said.has(slot.threadId)) said.set(slot.threadId, { activity: "running", since: now });
					expect(
						after.running.map((slot) => [slot.threadId, slot.activity, slot.activitySince]),
						where,
					).toEqual(after.running.map((slot) => [slot.threadId, said.get(slot.threadId)!.activity, said.get(slot.threadId)!.since]));
				}
				// The run did release idle slots, preempt waiting ones, and hold a waiting one back for a blocked queue.
				expect(seen.idle).toBeGreaterThan(5);
				expect(seen.preempted).toBeGreaterThan(10);
				expect(seen.heldBack).toBeGreaterThan(2);
			});
		}
	});

	it("gives an idle thread's slot back after 30 minutes idle and not a moment before, and starts the 30 minutes over when it works again", async () => {
		await withScheduler(({ scheduler, clock, make }) => {
			ask(scheduler, "a");
			// A running thread keeps its slot however long its turn takes.
			clock.now = START + SIX_HOURS;
			expect(scheduler.tick()).toEqual({ expired: [], admitted: [], released: [] });
			ask(scheduler, "q");
			expect(scheduler.setActivity("a", "idle")).toBe(true);
			const idle = clock.now;
			expect(scheduler.snapshot().running).toEqual([{ threadId: "a", provider: "sandbox", acquiredAt: START, state: "admitted", activity: "idle", activitySince: idle }]);
			expect(scheduler.sweep(idle + 30 * MINUTE - 1)).toEqual({ released: [], admitted: [] });
			// A turn a minute before the 30 are up, then idle again: they start over.
			clock.now = idle + 29 * MINUTE;
			scheduler.setActivity("a", "running");
			clock.now += MINUTE;
			scheduler.setActivity("a", "idle");
			expect(scheduler.sweep(idle + 30 * MINUTE)).toEqual({ released: [], admitted: [] });
			expect(scheduler.sweep(clock.now + 30 * MINUTE - 1)).toEqual({ released: [], admitted: [] });
			clock.now += 30 * MINUTE;
			expect(scheduler.tick()).toEqual({ expired: [], admitted: ["q"], released: [{ threadId: "a", why: "idle" }] });
			expect(scheduler.snapshot().running).toEqual([{ threadId: "q", provider: "sandbox", acquiredAt: clock.now, state: "admitted", activity: "running", activitySince: clock.now }]);
			// With no one queued, an idle slot is given back all the same, any time after its 30 minutes.
			scheduler.setActivity("q", "idle");
			expect(scheduler.sweep(clock.now + 2 * SIX_HOURS)).toEqual({ released: [{ threadId: "q", why: "idle" }], admitted: [] });
			expect(running(scheduler)).toEqual([]);
			// Only a thread holding a slot has an activity.
			expect(scheduler.setActivity("q", "running")).toBe(false);
			ask(scheduler, "r", "s");
			expect(scheduler.setActivity("s", "idle")).toBe(false);
			expect(scheduler.setActivity("nobody", "idle")).toBe(false);
			expect(() => scheduler.setActivity("r", "asleep" as Slot["activity"])).toThrow(RangeError);
			expect(activities(scheduler)).toEqual(["r:running"]);
			expect(() => make({ idleMs: -1 })).toThrow(RangeError);
			expect(() => make({ waitingGraceMs: Number.NaN })).toThrow(RangeError);
		});
	});

	it("lets a thread waiting for the person keep its slot for 5 minutes, then preempts it only for a queued thread, which asks again ahead of the queue", async () => {
		await withScheduler(({ scheduler, clock }) => {
			ask(scheduler, "a");
			scheduler.setActivity("a", "waiting");
			// With no one queued, it keeps its slot however long it waits.
			expect(scheduler.tick(START + SIX_HOURS)).toEqual({ expired: [], admitted: [], released: [] });
			clock.now = START + SIX_HOURS;
			ask(scheduler, "b", "c");
			expect(scheduler.tick()).toEqual({ expired: [], admitted: ["b"], released: [{ threadId: "a", why: "preempted" }] });
			// The caller checkpoints a's workspace, and a asks again ahead of c.
			expect(scheduler.request("a", { provider: "sandbox", priority: PREEMPT_RESUME_PRIORITY, reason: "resume" })).toEqual({ status: "queued", position: 1, reason: "resume" });
			expect(queued(scheduler)).toEqual(["a", "c"]);
			scheduler.setActivity("b", "waiting");
			const waiting = clock.now;
			expect(scheduler.sweep(waiting + 5 * MINUTE - 1)).toEqual({ released: [], admitted: [] });
			// The person answers a minute before the 5 are up, and b soon waits again: they start over.
			clock.now = waiting + 4 * MINUTE;
			scheduler.setActivity("b", "running");
			clock.now += MINUTE;
			scheduler.setActivity("b", "waiting");
			expect(scheduler.sweep(waiting + 5 * MINUTE)).toEqual({ released: [], admitted: [] });
			expect(scheduler.sweep(clock.now + 5 * MINUTE)).toEqual({ released: [{ threadId: "b", why: "preempted" }], admitted: ["a"] });
			expect(activities(scheduler)).toEqual(["a:running"]);
		});
	});

	it("keeps when a thread went idle or began waiting through repeated reports of the same, and starts over only on a real change", async () => {
		await withScheduler(
			({ scheduler, clock }) => {
				ask(scheduler, "a", "b", "q");
				scheduler.setActivity("a", "idle");
				scheduler.setActivity("b", "waiting");
				// Both are reported again every minute; neither report moves the time they began.
				for (let minute = 1; minute <= 5; minute++) {
					clock.now = START + minute * MINUTE;
					expect(scheduler.setActivity("a", "idle")).toBe(true);
					expect(scheduler.setActivity("b", "waiting")).toBe(true);
				}
				expect(scheduler.snapshot().running.map((slot) => [slot.threadId, slot.activity, slot.activitySince])).toEqual([
					["a", "idle", START],
					["b", "waiting", START],
				]);
				// b's 5 minutes of grace are up, however often it said it was waiting.
				expect(scheduler.sweep()).toEqual({ released: [{ threadId: "b", why: "preempted" }], admitted: ["q"] });
				for (let minute = 6; minute <= 30; minute++) {
					clock.now = START + minute * MINUTE;
					scheduler.setActivity("a", "idle");
				}
				expect(scheduler.sweep()).toEqual({ released: [{ threadId: "a", why: "idle" }], admitted: [] });
				// A real change still starts the time over: q goes idle, waits for the person, then is idle again.
				scheduler.setActivity("q", "idle");
				clock.now += 10 * MINUTE;
				scheduler.setActivity("q", "waiting");
				clock.now += MINUTE;
				scheduler.setActivity("q", "idle");
				const idle = clock.now;
				expect(scheduler.sweep(idle + 30 * MINUTE - 1)).toEqual({ released: [], admitted: [] });
				expect(scheduler.sweep(idle + 30 * MINUTE)).toEqual({ released: [{ threadId: "q", why: "idle" }], admitted: [] });
				expect(scheduler.setActivity("q", "idle")).toBe(false);
			},
			2,
		);
	});

	it("puts a preempted thread that asks again at the head of the queue, behind threads preempted before it", async () => {
		await withScheduler(({ scheduler, clock }) => {
			ask(scheduler, "r", "a");
			clock.now += 1;
			const resume = { provider: "sandbox", priority: PREEMPT_RESUME_PRIORITY, reason: "resume" };
			expect(scheduler.request("p1", resume)).toEqual({ status: "queued", position: 1, reason: "resume" });
			clock.now += 1;
			ask(scheduler, "b");
			// p3 asks in the same millisecond as p2.
			expect(scheduler.request("p2", resume)).toEqual({ status: "queued", position: 2, reason: "resume" });
			expect(scheduler.request("p3", resume)).toEqual({ status: "queued", position: 3, reason: "resume" });
			expect(scheduler.request("c", { provider: "sandbox", priority: 5 })).toEqual({ status: "queued", position: 4, reason: "slots_full" });
			expect(queued(scheduler)).toEqual(["p1", "p2", "p3", "c", "a", "b"]);
			expect(["r", "p1", "p2", "p3", "c", "a"].map((id) => scheduler.release(id))).toEqual([["p1"], ["p2"], ["p3"], ["c"], ["a"], ["b"]]);
		});
	});

	it("preempts no one for a queue a gate holds up, nor for slots still over the limit after a restart", async () => {
		await withScheduler(({ scheduler, clock, make }) => {
			ask(scheduler, "a", "b");
			scheduler.setActivity("a", "waiting");
			scheduler.setConditions({ lowDisk: true, budgetCapped: false });
			clock.now += 5 * MINUTE;
			expect(scheduler.tick()).toEqual({ expired: [], admitted: [], released: [] });
			expect(activities(scheduler)).toEqual(["a:waiting"]);
			expect(reasons(scheduler)).toEqual(["b:slots_full"]);
			scheduler.setConditions({ lowDisk: false, budgetCapped: true });
			expect(scheduler.sweep()).toEqual({ released: [], admitted: [] });
			expect(scheduler.setConditions({ lowDisk: false, budgetCapped: false })).toEqual([]);
			expect(scheduler.sweep()).toEqual({ released: [{ threadId: "a", why: "preempted" }], admitted: ["b"] });
			// After a restart, b and x run past the limit of 1: preempting one would still leave no slot for c.
			const restarted = make();
			ask(restarted, "c");
			expect(restarted.reconcile(["b", "x"])).toEqual({ released: [], adopted: ["x"], admitted: [] });
			restarted.setActivity("b", "waiting");
			restarted.setActivity("x", "waiting");
			clock.now += 5 * MINUTE;
			expect(restarted.sweep()).toEqual({ released: [], admitted: [] });
			// Once x ends, b is preempted for c.
			expect(restarted.release("x")).toEqual([]);
			expect(restarted.sweep()).toEqual({ released: [{ threadId: "b", why: "preempted" }], admitted: ["c"] });
		});
	});

	it("preempts as many waiting threads as queued threads can start, the longest waiting first", async () => {
		await withScheduler(({ make, clock }) => {
			let vmDown = true;
			const vmGate: AdmissionGate = { check: (entry) => (entry.provider === "vm" && vmDown ? { ok: false, reason: "provider_down" } : { ok: true }) };
			const scheduler = make({ defaultLimit: 5, gates: [vmGate] });
			ask(scheduler, "a", "b", "c", "d", "e");
			// b has waited longest, then c, then a; d runs; e is idle, though not for 30 minutes.
			for (const [id, activity] of [["b", "waiting"], ["c", "waiting"], ["a", "waiting"], ["e", "idle"]] as const) {
				clock.now += 1;
				scheduler.setActivity(id, activity);
			}
			ask(scheduler, "x", "y");
			scheduler.request("v", { provider: "vm" });
			ask(scheduler, "w");
			clock.now += 5 * MINUTE;
			// x and y can start; v can't, and holds up w behind it.
			expect(scheduler.sweep()).toEqual({
				released: [
					{ threadId: "b", why: "preempted" },
					{ threadId: "c", why: "preempted" },
				],
				admitted: ["x", "y"],
			});
			expect(activities(scheduler)).toEqual(["a:waiting", "d:running", "e:idle", "x:running", "y:running"]);
			expect(queued(scheduler)).toEqual(["v", "w"]);
			vmDown = false;
			expect(scheduler.sweep()).toEqual({ released: [{ threadId: "a", why: "preempted" }], admitted: ["v"] });
			expect(scheduler.sweep()).toEqual({ released: [], admitted: [] });
			expect(queued(scheduler)).toEqual(["w"]);
		});
	});

	it("keeps each slot's activity through a restart and a crashed transaction, and adopts live workspaces as running", async () => {
		await withScheduler(
			({ scheduler, clock, make }) => {
				ask(scheduler, "a", "b", "q");
				clock.now += 1_000;
				scheduler.setActivity("a", "idle");
				clock.now += 1_000;
				scheduler.setActivity("b", "waiting");
				const before = scheduler.snapshot();
				expect(before.running).toEqual([
					{ threadId: "a", provider: "sandbox", acquiredAt: START, state: "admitted", activity: "idle", activitySince: START + 1_000 },
					{ threadId: "b", provider: "sandbox", acquiredAt: START, state: "admitted", activity: "waiting", activitySince: START + 2_000 },
				]);
				expect(() => make({ crash: true }).setActivity("a", "running")).toThrow("crash before commit");
				expect(() => make({ crash: true }).sweep(START + SIX_HOURS)).toThrow("crash before commit");
				const restarted = make();
				expect(restarted.snapshot()).toEqual(before);
				// The 30 minutes count from when a went idle, before the restart.
				clock.now = START + 1_000 + 30 * MINUTE;
				expect(restarted.sweep()).toEqual({ released: [{ threadId: "a", why: "idle" }], admitted: ["q"] });
				expect(restarted.reconcile(["b", "q", "x"])).toEqual({ released: [], adopted: ["x"], admitted: [] });
				expect(restarted.snapshot().running.map(({ threadId, state, activity, activitySince }) => ({ threadId, state, activity, activitySince }))).toEqual([
					{ threadId: "b", state: "admitted", activity: "waiting", activitySince: START + 2_000 },
					{ threadId: "q", state: "admitted", activity: "running", activitySince: clock.now },
					{ threadId: "x", state: "adopted", activity: "running", activitySince: clock.now },
				]);
			},
			2,
		);
	});
});
