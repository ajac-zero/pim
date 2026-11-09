import { env, runInDurableObject } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { type AdmissionGate, budgetCapGate, CodingScheduler, lowDiskGate, type RequestResult } from "../src/coding/scheduler";
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

type MakeOptions = { defaultLimit?: number; crash?: boolean; gates?: readonly AdmissionGate[]; defaultDeadlineMs?: number };

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
			expect(snapshot.running).toEqual([{ threadId: "a", provider: "sandbox", acquiredAt: START, state: "admitted" }]);
			expect(snapshot.queued).toEqual([{ threadId: "b", provider: "sandbox", reason: "first", priority: 0, queuedAt: START, deadlineAt: START + 1_000 }]);
			expect(scheduler.release("a")).toEqual(["b"]);
			expect(scheduler.request("b", { provider: "sandbox" })).toEqual({ status: "admitted" });
			expect(scheduler.release("a")).toEqual([]);
			expect(scheduler.snapshot().running).toEqual([{ threadId: "b", provider: "sandbox", acquiredAt: START + 500, state: "admitted" }]);
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
					{ threadId: "b", provider: "sandbox", acquiredAt: START, state: "admitted" },
					{ threadId: "d", provider: "vm", acquiredAt: START + 10, state: "adopted" },
					{ threadId: "x", provider: null, acquiredAt: START + 10, state: "adopted" },
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
				expect(scheduler.tick()).toEqual({ expired: [], admitted: [] });
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
			expect(scheduler.tick()).toEqual({ expired: [], admitted: ["s1", "s2"] });
			expect(scheduler.request("w", { provider: "vm" })).toEqual({ status: "queued", position: 2, reason: "slots_full" });
			expect(scheduler.release("p")).toEqual(["s3"]);
			expect(scheduler.release("s1")).toEqual([]);
			expect(reasons(scheduler)).toEqual(["w:provider_down"]);
			// The gate's world changes outside the scheduler; the next tick sees it.
			vmDown = false;
			expect(scheduler.tick()).toEqual({ expired: [], admitted: ["w"] });
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
			expect(scheduler.tick(START + SIX_HOURS - 1)).toEqual({ expired: [], admitted: [] });
			clock.now = START + SIX_HOURS;
			expect(scheduler.tick()).toEqual({
				expired: [{ threadId: "a", provider: "sandbox", reason: "low_disk", detail: "5% free", priority: 0, queuedAt: START, deadlineAt: START + SIX_HOURS }],
				admitted: [],
			});
			expect(reasons(scheduler)).toEqual(["b:low_disk"]);
			// c waits for the disk behind b, then, once b takes the slot, for a slot.
			expect(scheduler.request("c", { provider: "sandbox" })).toEqual({ status: "queued", position: 2, reason: "slots_full" });
			expect(scheduler.setConditions({ lowDisk: false, budgetCapped: false })).toEqual(["b"]);
			expect(scheduler.tick(START + 2 * SIX_HOURS)).toEqual({
				expired: [{ threadId: "c", provider: "sandbox", reason: "slots_full", priority: 0, queuedAt: START + SIX_HOURS, deadlineAt: START + 2 * SIX_HOURS }],
				admitted: [],
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
				expect(again.tick()).toEqual({ expired: [], admitted: [] });
				expect(() => make({ crash: true }).setConditions({ lowDisk: false, budgetCapped: false })).toThrow("crash before commit");
				expect(make().snapshot()).toEqual(before);
				expect(make().setConditions({ lowDisk: false, budgetCapped: false })).toEqual(["a", "b"]);
				expect(running(scheduler)).toEqual(["a", "b"]);
			},
			2,
		);
	});
});
