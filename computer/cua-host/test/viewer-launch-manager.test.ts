/**
 * The viewer launch manager (../viewer-launch-manager.ts), with a stand-in
 * for the viewer adapter whose launches are real `ViewerLaunch`es
 * (../viewer-lifetime.ts) on a clock and timers the test turns by hand, and
 * a journal store that is a string in memory: each write replaces it whole,
 * as an atomic rename would, and the test can make a write fail before or
 * after it lands, hold it, lose the journal, or move its revision as a
 * second writer would. No socket, server, file, process or real timer is
 * involved, and no real credential: the root token is a test string.
 *
 *   pnpm --filter pim-cua-host test
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { LaunchHandle, LaunchRequest } from "../viewer-adapter.ts";
import {
	DEFAULT_START_TIMEOUT_MS,
	type Journal,
	type JournalStore,
	type KeyRequest,
	type LaunchRequestKey,
	MAX_UNRESOLVED_LAUNCHES,
	openViewerLaunchManager,
} from "../viewer-launch-manager.ts";
import { MAX_LAUNCH_MS, startViewerLaunch, type Timers, type ViewerLaunch } from "../viewer-lifetime.ts";

const WALL = 1_800_000_000_000;
const ROOT_TOKEN = "stand-in-root-token-never-stored";
const key = (n: number) => `observation-key-${String(n).padStart(4, "0")}`;
const request = (n: number, overrides: Partial<LaunchRequestKey> = {}): LaunchRequestKey => ({ key: key(n), owner: "ada", notAfter: WALL + 60_000, ...overrides });
const fresh = (generation = "gen-a"): Journal => ({ version: 1, revision: 1, generation, initialized: "operator: a new host, nothing open", entries: [] });

/** Lets every promise continuation that is ready run. */
const flush = () => new Promise<void>((resolve) => setImmediate(resolve));

/** A monotonic clock the test sets, a wall clock apart from it, and timers that fire only when the test moves the clock. */
function fakeTime() {
	let now = 1_000;
	let wall = WALL;
	let next = 1;
	const pending = new Map<number, { readonly at: number; readonly callback: () => void }>();
	const timers: Timers = {
		set(callback, ms) {
			const id = next++;
			pending.set(id, { at: now + ms, callback });
			return id;
		},
		clear(handle) {
			pending.delete(handle as number);
		},
	};
	return {
		clock: () => now,
		wall: () => wall,
		timers,
		setWall(to: number) {
			wall = to;
		},
		advance(ms: number) {
			const until = now + ms;
			for (;;) {
				const due = [...pending].filter(([, t]) => t.at <= until).sort(([, a], [, b]) => a.at - b.at)[0];
				if (!due) break;
				pending.delete(due[0]);
				now = Math.max(now, due[1].at);
				due[1].callback();
			}
			now = until;
		},
	};
}

/** A journal kept as one string, replaced whole by each write. */
function memoryStore(initial?: Journal) {
	let stored: string | undefined = initial === undefined ? undefined : JSON.stringify(initial);
	let failNext: "before" | "after" | undefined;
	let readFails = false;
	let held: Promise<void> | undefined;
	let writes = 0;
	const store: JournalStore = {
		async read() {
			if (readFails) throw new Error("EIO");
			return stored === undefined ? undefined : JSON.parse(stored);
		},
		async write(journal, expectedRevision) {
			if (held) await held;
			const current = stored === undefined ? 0 : (JSON.parse(stored) as Journal).revision;
			if (current !== expectedRevision) throw new Error("the stored revision moved");
			const fail = failNext;
			failNext = undefined;
			if (fail === "before") throw new Error("no space left");
			stored = JSON.stringify(journal);
			writes++;
			if (fail === "after") throw new Error("the flush failed after the rename");
		},
	};
	return {
		store,
		raw: () => stored,
		journal: () => (stored === undefined ? undefined : (JSON.parse(stored) as Journal)),
		entry: (k: string) => (stored === undefined ? undefined : (JSON.parse(stored) as Journal).entries.find((e) => e.key === k)),
		writes: () => writes,
		failNext(mode: "before" | "after") {
			failNext = mode;
		},
		failReads() {
			readFails = true;
		},
		lose() {
			stored = undefined;
		},
		/** Holds every write until the returned function is called. */
		hold() {
			let release!: () => void;
			held = new Promise<void>((resolve) => {
				release = resolve;
			});
			return () => {
				held = undefined;
				release();
			};
		},
	};
}

/** A stand-in for the adapter's `startLaunch`: each call waits for the test to answer it, unless `auto`. */
function standIn(time: ReturnType<typeof fakeTime>, options: { auto?: boolean | "fail" } = {}) {
	const calls: LaunchRequest[] = [];
	const answers: Array<{ readonly resolve: () => void; readonly reject: () => void; settled: boolean }> = [];
	const launches: Array<{ readonly id: string; readonly lifetime: ViewerLaunch; unconfirmed: number; cleanup: { requested: number; answered: number; failed: number } }> = [];
	const make = (request: LaunchRequest): LaunchHandle => {
		const lifetime = startViewerLaunch({ lifetimeMs: request.lifetimeMs, clock: time.clock, timers: time.timers });
		const id = `launch${launches.length}`;
		const launch = { id, lifetime, unconfirmed: 0, cleanup: { requested: 0, answered: 0, failed: 0 } };
		launches.push(launch);
		return Object.freeze({
			id,
			viewerPath: `/${id}/viewer/#ticket=launch-credential-${id}&clipboard=0`,
			end: lifetime.end,
			status: () => ({ ...lifetime.status(), sessions: 0, unconfirmed: launch.unconfirmed, cleanup: { ...launch.cleanup } }),
		});
	};
	return {
		calls,
		launches,
		adapter: {
			startLaunch(request: LaunchRequest): Promise<LaunchHandle> {
				calls.push(request);
				if (options.auto === true) return Promise.resolve(make(request));
				if (options.auto === "fail") return Promise.reject(new Error("The desktop did not grant a view-only viewer ticket for this launch."));
				return new Promise((resolve, reject) => {
					const answer = {
						settled: false,
						resolve: () => {
							answer.settled = true;
							resolve(make(request));
						},
						reject: () => {
							answer.settled = true;
							reject(new Error("The desktop did not grant a view-only viewer ticket for this launch."));
						},
					};
					answers.push(answer);
				});
			},
		},
		answer: (n: number) => answers[n]!.resolve(),
		fail: (n: number) => answers[n]!.reject(),
		/** The process dies: every call it has not answered fails with it, so nothing the test started is left pending. */
		crash() {
			for (const answer of answers) if (!answer.settled) answer.reject();
		},
	};
}

async function setUp(options: { journal?: Journal | null; auto?: boolean | "fail"; generation?: string; rootToken?: () => string | undefined } = {}) {
	const time = fakeTime();
	const memory = memoryStore(options.journal === null ? undefined : (options.journal ?? fresh()));
	const desk = standIn(time, { auto: options.auto ?? true });
	// This process's own view of the store, which its crash severs: nothing it does after dying is stored.
	let severed = false;
	const gone = () => Promise.reject(new Error("the process is gone"));
	const store: JournalStore = {
		read: () => (severed ? gone() : memory.store.read()),
		write: (journal, expectedRevision) => (severed ? gone() : memory.store.write(journal, expectedRevision)),
	};
	const manager = await openViewerLaunchManager({
		adapter: desk.adapter,
		store,
		generation: options.generation ?? "gen-b",
		rootToken: options.rootToken ?? (() => ROOT_TOKEN),
		wallClock: time.wall,
		timers: time.timers,
	});
	/** Simulates the process dying: its store view is severed, its adapter calls fail, and what it was waiting on settles. */
	const crash = async () => {
		severed = true;
		desk.crash();
		await flush();
	};
	return { time, memory, desk, manager, crash };
}

/** The same store, opened by the next process: a new generation and a new adapter with no launches. */
async function restart(memory: ReturnType<typeof memoryStore>, time: ReturnType<typeof fakeTime>, generation: string) {
	const desk = standIn(time, { auto: true });
	const manager = await openViewerLaunchManager({ adapter: desk.adapter, store: memory.store, generation, rootToken: () => ROOT_TOKEN, wallClock: time.wall, timers: time.timers });
	return { desk, manager };
}

const ada = (n: number, generation = "gen-b") => ({ owner: "ada", key: key(n), generation });

describe("the viewer launch manager", () => {
	it("stores the intent before starting, and answers repeats with the original launch, never a second", async () => {
		const { memory, desk, manager } = await setUp({ auto: false });
		const release = memory.hold();
		const first = manager.launch(request(1));
		const second = manager.launch(request(1));
		await flush();
		assert.equal(desk.calls.length, 0, "nothing reaches the adapter before the intent is stored");
		release();
		await flush();
		assert.equal(desk.calls.length, 1);
		assert.equal(memory.entry(key(1))?.state, "intent");
		desk.answer(0);
		const [one, two] = await Promise.all([first, second]);
		assert.equal(one.outcome, "launched");
		assert.equal(two.outcome, "launched");
		if (one.outcome !== "launched" || two.outcome !== "launched") return;
		assert.equal(one.replayed, false);
		assert.equal(two.replayed, true);
		assert.deepEqual([two.launchId, two.viewerPath, two.generation, two.notAfter], [one.launchId, one.viewerPath, "gen-b", WALL + 60_000]);
		const third = await manager.launch(request(1));
		assert.equal(third.outcome === "launched" && third.launchId === one.launchId && third.replayed, true);
		assert.equal(desk.calls.length, 1, "one start for three requests");
		assert.deepEqual(memory.entry(key(1)), { key: key(1), owner: "ada", notAfter: WALL + 60_000, generation: "gen-b", launchId: one.launchId, state: "open" });
		// The root token went to the one start and nowhere else; the launch's credential isn't stored.
		assert.equal(desk.calls[0]?.rootToken, ROOT_TOKEN);
		assert.equal(desk.calls[0]?.lifetimeMs, 60_000);
		for (const text of [memory.raw()!, JSON.stringify([one, two, third])]) assert.equal(text.includes(ROOT_TOKEN), false);
		assert.equal(memory.raw()!.includes("launch-credential"), false);
	});

	it("refuses a repeat naming another owner or deadline, and hides a key from another owner", async () => {
		const { desk, manager } = await setUp();
		const first = await manager.launch(request(1));
		assert.equal(first.outcome, "launched");
		assert.deepEqual(await manager.launch(request(1, { notAfter: WALL + 120_000 })), { outcome: "refused", reason: "conflict" });
		assert.deepEqual(await manager.launch(request(1, { owner: "grace" })), { outcome: "refused", reason: "conflict" });
		assert.deepEqual(await manager.status({ owner: "grace", key: key(1), generation: "gen-b" }), { outcome: "not_found" });
		assert.deepEqual(await manager.end({ owner: "grace", key: key(1), generation: "gen-b" }), { outcome: "not_found" });
		assert.equal(desk.launches[0]?.lifetime.live(), true, "another owner ended nothing");
		assert.equal(desk.calls.length, 1);
		assert.deepEqual(await manager.launch({ ...request(2), key: "short" }), { outcome: "refused", reason: "invalid" });
	});

	it("starts nothing when the intent can't be stored, blocks until restart, and a restart finds a stored intent unconfirmed", async () => {
		const { time, memory, desk, manager } = await setUp();
		memory.failNext("after");
		assert.deepEqual(await manager.launch(request(1)), { outcome: "refused", reason: "storage" });
		assert.equal(desk.calls.length, 0);
		assert.equal(memory.entry(key(1))?.state, "intent", "the write landed though it failed");
		assert.deepEqual(await manager.launch(request(2)), { outcome: "refused", reason: "blocked" });
		assert.equal(manager.blockers().length, 1);

		const next = await restart(memory, time, "gen-c");
		assert.equal(memory.entry(key(1))?.state, "unconfirmed");
		assert.match(memory.entry(key(1))?.evidence ?? "", /gen-b/);
		assert.deepEqual(await next.manager.launch(request(1)), { outcome: "unconfirmed", key: key(1), reason: "earlier_generation" });
		assert.equal(next.desk.calls.length, 0, "the same key is never started again");

		const lost = await setUp();
		lost.memory.failNext("before");
		assert.deepEqual(await lost.manager.launch(request(1)), { outcome: "refused", reason: "storage" });
		assert.equal(lost.memory.entry(key(1)), undefined);
		assert.equal(lost.desk.calls.length, 0);
	});

	it("leaves a key unconfirmed under the next generation after a crash before its start answered or after it was acknowledged", async () => {
		const { memory, desk, manager, crash } = await setUp({ auto: false });
		const hanging = manager.launch(request(1));
		await flush();
		assert.equal(desk.calls.length, 1, "started, and never answered: the process dies here");
		const stored = memory.raw();
		await crash();
		// The dead process's own wait settles, and nothing it did after dying reached the journal.
		assert.deepEqual(await hanging, { outcome: "start_failed", key: key(1) });
		assert.equal(memory.raw(), stored);
		assert.equal(memory.entry(key(1))?.state, "intent");
		// The next process reads what the first stored. Its own launch is acknowledged, and then it dies too.
		const acked = await setUp({ journal: memory.journal()!, generation: "gen-c" });
		assert.equal((await acked.manager.launch(request(2))).outcome, "launched");

		const next = await restart(acked.memory, acked.time, "gen-d");
		for (const [n, generation] of [[1, "gen-b"], [2, "gen-c"]] as const) {
			assert.deepEqual(await next.manager.status({ owner: "ada", key: key(n), generation }), { outcome: "generation_mismatch", generation: "gen-d" });
			const status = await next.manager.status(ada(n, "gen-d"));
			assert.equal(status.outcome === "found" && status.state, "unconfirmed");
			assert.equal(status.outcome === "found" && status.launch, null, "nothing here holds it");
			assert.equal(status.outcome === "found" && status.generation, generation);
			assert.deepEqual(await next.manager.launch(request(n)), { outcome: "unconfirmed", key: key(n), reason: "earlier_generation" });
			assert.deepEqual(await next.manager.end(ada(n, "gen-d")), { outcome: "unconfirmed" });
		}
		assert.equal(next.desk.calls.length, 0);
		assert.equal(acked.desk.launches[0]?.lifetime.live(), true, "the old launch, if its process lived, isn't claimed closed");
	});

	it("blocks on a missing, unreadable, invalid or own-generation journal, and leaves it as it is", async () => {
		const missing = await setUp({ journal: null });
		assert.match(missing.manager.blockers()[0] ?? "", /no journal is stored/);
		assert.deepEqual(await missing.manager.launch(request(1)), { outcome: "refused", reason: "blocked" });
		assert.equal("initialize" in missing.manager, false, "the manager never creates a journal");
		assert.equal(missing.desk.calls.length, 0);
		assert.equal(missing.memory.raw(), undefined, "nothing was written");
		assert.equal(missing.manager.blockers().length, 1);

		const ready = await setUp();
		const launched = await ready.manager.launch(request(1));
		assert.equal(launched.outcome, "launched");
		ready.memory.lose();
		const after = await restart(ready.memory, ready.time, "gen-c");
		assert.deepEqual(await after.manager.launch(request(1)), { outcome: "refused", reason: "blocked" }, "a lost journal permits no launch of the same key");
		assert.equal(after.desk.calls.length, 0);
		assert.equal(ready.desk.launches[0]?.lifetime.live(), true);

		const unreadable = memoryStore(fresh());
		unreadable.failReads();
		const blind = await openViewerLaunchManager({ adapter: standIn(fakeTime()).adapter, store: unreadable.store, generation: "gen-b", rootToken: () => ROOT_TOKEN });
		assert.match(blind.blockers()[0] ?? "", /could not be read/);
		assert.deepEqual(await blind.launch(request(1)), { outcome: "refused", reason: "blocked" });

		const garbled = { ...fresh(), entries: [{ key: key(1), owner: "ada", notAfter: WALL, generation: "gen-a", launchId: null, state: "open" }] } as unknown as Journal;
		const bad = memoryStore(garbled);
		const before = bad.raw();
		const refused = await openViewerLaunchManager({ adapter: standIn(fakeTime()).adapter, store: bad.store, generation: "gen-b", rootToken: () => ROOT_TOKEN });
		assert.match(refused.blockers()[0] ?? "", /invalid/);
		assert.deepEqual([bad.raw(), bad.writes()], [before, 0]);

		const same = await setUp({ journal: fresh("gen-b"), generation: "gen-b" });
		assert.match(same.manager.blockers()[0] ?? "", /this host generation/);

		const none = await openViewerLaunchManager({ adapter: standIn(fakeTime()).adapter, generation: "gen-b", rootToken: () => ROOT_TOKEN });
		assert.deepEqual(await none.launch(request(1)), { outcome: "refused", reason: "blocked" });
		assert.equal(none.blockers().length, 1);
	});

	it("never starts a key again after its journal is lost, whatever recovery is tried, not even for a delayed request from before the loss", async () => {
		const { time, memory, desk, manager } = await setUp();
		const first = await manager.launch(request(1));
		assert.equal(first.outcome, "launched");
		// A repeat of key 1 sent before the loss, whose delivery is delayed until after it: still within its deadline.
		const delayed = request(1);
		memory.lose();
		for (const generation of ["gen-c", "gen-d", "gen-e"]) {
			const next = await restart(memory, time, generation);
			// Every way the runtime might be asked to start over: none exists, or none takes.
			assert.equal("initialize" in next.manager, false, "there is no runtime reinitialization");
			assert.equal((next.manager as unknown as { initialize?: unknown }).initialize, undefined);
			assert.equal(next.manager.blockers().length, 1);
			assert.equal(await next.manager.reconcile(key(1), "operator: the key is retired and nothing is open"), false, "evidence retires nothing");
			assert.deepEqual(await next.manager.status(ada(1, generation)), { outcome: "not_found" });
			assert.deepEqual(await next.manager.end(ada(1, generation)), { outcome: "not_found" });
			// The delayed request arrives, and the same key is resent as a repeat of a request whose reply was lost.
			assert.ok(delayed.notAfter > time.wall(), "the delayed request has not expired");
			assert.deepEqual(await next.manager.launch(delayed), { outcome: "refused", reason: "blocked" });
			assert.deepEqual(await next.manager.launch(request(1)), { outcome: "refused", reason: "blocked" });
			assert.deepEqual(await next.manager.launch(request(2)), { outcome: "refused", reason: "blocked" });
			assert.equal(next.desk.calls.length, 0, "the adapter is never called again");
			assert.equal(memory.raw(), undefined, "nothing recreated the journal");
		}
		assert.equal(memory.raw(), undefined, "no manager recreated the journal");
		assert.equal(desk.calls.length, 1);
	});

	it("refuses a second writer of the same journal", async () => {
		const { time, memory, desk, manager } = await setUp();
		await restart(memory, time, "gen-c");
		assert.deepEqual(await manager.launch(request(1)), { outcome: "refused", reason: "storage" });
		assert.equal(desk.calls.length, 0);
	});

	it("ends at once a launch the journal can't name, and gives out no page", async () => {
		const { memory, desk, manager } = await setUp({ auto: false });
		const answer = manager.launch(request(1));
		await flush();
		memory.failNext("before");
		desk.answer(0);
		assert.deepEqual(await answer, { outcome: "unconfirmed", key: key(1), reason: "storage" });
		assert.equal(desk.launches[0]?.lifetime.status().reason, "ended");
		assert.equal(memory.entry(key(1))?.state, "intent");
	});

	it("answers a start past its timeout unconfirmed, ends the launch when it comes, and observes its closure only when its transports report closed", async () => {
		const { time, memory, desk, manager } = await setUp({ auto: false });
		const answer = manager.launch(request(1));
		await flush();
		time.advance(DEFAULT_START_TIMEOUT_MS);
		assert.deepEqual(await answer, { outcome: "unconfirmed", key: key(1), reason: "timeout" });
		desk.answer(0);
		await flush();
		const launch = desk.launches[0]!;
		// A transport that opens now is refused, and counts until it reports closed.
		const viewer = { closed: launch.lifetime.adopt("media-viewer", { close() {} }).closed };
		assert.equal(launch.lifetime.status().reason, "ended");
		assert.deepEqual(await manager.launch(request(1)), { outcome: "unconfirmed", key: key(1), reason: "unconfirmed" }, "never reminted, never handed out");
		const closing = await manager.status(ada(1));
		assert.equal(closing.outcome === "found" && closing.state, "unconfirmed");
		assert.equal(closing.outcome === "found" && closing.launchId, launch.id);
		assert.equal(closing.outcome === "found" && closing.launch?.refused, 1, "the late transport counts until it reports closed");
		viewer.closed();
		const closed = await manager.status(ada(1));
		assert.equal(closed.outcome === "found" && closed.state, "closed_observed");
		assert.deepEqual(await manager.launch(request(1)), { outcome: "refused", reason: "closed" });

		const second = manager.launch(request(2));
		await flush();
		time.advance(DEFAULT_START_TIMEOUT_MS);
		assert.equal((await second).outcome, "unconfirmed");
		desk.fail(1);
		await flush();
		assert.equal(memory.entry(key(2))?.state, "unconfirmed", "a late failure doesn't say nothing was minted");
		assert.match(memory.entry(key(2))?.evidence ?? "", /failed later/);
		assert.equal(await manager.reconcile(key(2), ""), false);
		assert.equal(await manager.reconcile(key(2), "operator: spacesd lists no session for it"), true);
		assert.equal(memory.entry(key(2))?.state, "reconciled");
		assert.equal(desk.calls.length, 2);
	});

	it("ends a launch whose end was requested while it started, and gives out no page", async () => {
		const { memory, desk, manager } = await setUp({ auto: false });
		const answer = manager.launch(request(1));
		await flush();
		assert.deepEqual(await manager.end(ada(1)), { outcome: "requested", recorded: false });
		desk.answer(0);
		assert.deepEqual(await answer, { outcome: "unconfirmed", key: key(1), reason: "ended" });
		assert.equal(desk.launches[0]?.lifetime.status().reason, "ended");
		assert.equal(memory.entry(key(1))?.state, "ending");

		// An end that comes while the launch is being stored as open.
		const storing = manager.launch(request(2));
		await flush();
		const release = memory.hold();
		desk.answer(1);
		await flush();
		assert.deepEqual(await manager.end(ada(2)), { outcome: "requested", recorded: false });
		assert.equal(desk.launches[1]?.lifetime.status().reason, "ended", "ended at once, before the write finished");
		release();
		assert.deepEqual(await storing, { outcome: "unconfirmed", key: key(2), reason: "ended" });
		assert.equal(memory.entry(key(2))?.state, "ending");
	});

	it("cancels a start whose end is requested while its intent is being stored, before the adapter is called", async () => {
		const { memory, desk, manager } = await setUp({ auto: false });
		const release = memory.hold();
		const answer = manager.launch(request(1));
		await flush();
		assert.deepEqual(await manager.end(ada(1)), { outcome: "requested", recorded: false });
		release();
		assert.deepEqual(await answer, { outcome: "start_failed", key: key(1) });
		assert.equal(desk.calls.length, 0, "the adapter was never called, so nothing was minted");
		assert.equal(memory.entry(key(1))?.state, "start_failed");
		assert.match(memory.entry(key(1))?.evidence ?? "", /end was requested before the start/);
		assert.deepEqual(await manager.launch(request(1)), { outcome: "start_failed", key: key(1) });
		assert.equal(desk.calls.length, 0);
	});

	it("starts what its stored intent says, from a copy taken before it waits, and refuses accessors, coercion and unknown fields", async () => {
		const { memory, desk, manager } = await setUp();
		const given = { key: key(1), owner: "ada", notAfter: WALL + 60_000, displayName: "Ada" };
		const release = memory.hold();
		const answer = manager.launch(given);
		await flush();
		// The caller changes its object while the intent is being stored.
		given.key = key(9);
		given.owner = "grace";
		given.notAfter = WALL + 3_600_000;
		given.displayName = "Mallory";
		release();
		const launched = await answer;
		assert.equal(launched.outcome, "launched");
		if (launched.outcome !== "launched") return;
		assert.deepEqual([launched.key, launched.notAfter], [key(1), WALL + 60_000]);
		assert.deepEqual([desk.calls[0]?.lifetimeMs, desk.calls[0]?.displayName], [60_000, "Ada"]);
		assert.deepEqual(memory.entry(key(1)), { key: key(1), owner: "ada", notAfter: WALL + 60_000, generation: "gen-b", launchId: launched.launchId, state: "open" });
		assert.equal(memory.entry(key(9)), undefined);

		let reads = 0;
		const accessor = Object.defineProperty({ key: key(2), owner: "ada" }, "notAfter", {
			enumerable: true,
			get: () => {
				reads++;
				return WALL + 60_000;
			},
		});
		const malformed: unknown[] = [
			accessor,
			Object.assign(Object.create({ inherited: true }) as object, request(2)),
			{ ...request(2), extra: 1 },
			{ ...request(2), [Symbol("extra")]: 1 },
			{ ...request(2), notAfter: String(WALL + 60_000) },
			{ ...request(2), notAfter: new Number(WALL + 60_000) },
			{ ...request(2), displayName: 7 },
			{ key: key(2), owner: "ada" },
			null,
		];
		for (const bad of malformed) assert.deepEqual(await manager.launch(bad as LaunchRequestKey), { outcome: "refused", reason: "invalid" });
		assert.equal(reads, 0, "an accessor is never called");
		assert.equal(memory.entry(key(2)), undefined);
		assert.equal(desk.calls.length, 1);
	});

	it("answers a request whose proxy traps throw as malformed, and never rejects", async () => {
		const { memory, desk, manager } = await setUp();
		assert.equal((await manager.launch(request(1))).outcome, "launched");
		const fail = (): never => {
			throw new Error("a trap that throws");
		};
		const handlers: ProxyHandler<object>[] = [{ getPrototypeOf: fail }, { ownKeys: fail }, { getOwnPropertyDescriptor: fail }];
		const revoked = (target: object) => {
			const { proxy, revoke } = Proxy.revocable(target, {});
			revoke();
			return proxy;
		};
		const launches: unknown[] = [...handlers.map((handler) => new Proxy({ ...request(2) }, handler)), revoked({ ...request(2) })];
		for (const bad of launches) assert.deepEqual(await manager.launch(bad as LaunchRequestKey), { outcome: "refused", reason: "invalid" });
		// Key 1's launch is live: a throwing request for it ends nothing and shows nothing.
		const keys: unknown[] = [...handlers.map((handler) => new Proxy({ ...ada(1) }, handler)), revoked({ ...ada(1) })];
		for (const bad of keys) {
			assert.deepEqual(await manager.end(bad as KeyRequest), { outcome: "not_found" });
			assert.deepEqual(await manager.status(bad as KeyRequest), { outcome: "not_found" });
		}
		assert.equal(desk.launches[0]?.lifetime.live(), true);
		assert.equal(memory.entry(key(2)), undefined);
		assert.equal(desk.calls.length, 1);
	});

	it("tells a requested end from an observed closure, which neither CloseMedia answers nor an unconfirmed stream make", async () => {
		const { memory, desk, manager } = await setUp();
		const first = await manager.launch(request(1));
		assert.equal(first.outcome, "launched");
		const launch = desk.launches[0]!;
		const viewer = launch.lifetime.adopt("media-viewer", { close() {} });
		launch.cleanup = { requested: 1, answered: 1, failed: 0 };
		assert.deepEqual(await manager.end(ada(1)), { outcome: "requested", recorded: true });
		const late = launch.lifetime.adopt("media-upstream", { close() {} });
		assert.equal(late.admitted, false, "an attach after the end is refused");
		let status = await manager.status(ada(1));
		assert.equal(status.outcome === "found" && status.state, "ending");
		assert.equal(status.outcome === "found" && status.launch?.phase, "closing");
		viewer.closed();
		late.closed();
		launch.unconfirmed = 1;
		status = await manager.status(ada(1));
		assert.equal(status.outcome === "found" && status.state, "ending", "a presence stream whose cancel failed keeps it unobserved");
		launch.unconfirmed = 0;
		status = await manager.status(ada(1));
		assert.equal(status.outcome === "found" && status.state, "closed_observed");
		assert.match(memory.entry(key(1))?.evidence ?? "", /CloseMedia requested 1, answered 1/);
		assert.deepEqual(await manager.end(ada(1)), { outcome: "final", state: "closed_observed" });
		assert.deepEqual(await manager.status(ada(1, "gen-x")), { outcome: "generation_mismatch", generation: "gen-b" });
	});

	it("reads the deadline once and never moves it", async () => {
		const { time, memory, desk, manager } = await setUp();
		const first = await manager.launch(request(1));
		assert.equal(first.outcome, "launched");
		time.setWall(WALL - 3_600_000);
		time.advance(60_000);
		assert.equal(desk.launches[0]?.lifetime.status().reason, "expired", "turning the wall clock back extended nothing");
		assert.deepEqual(await manager.launch(request(1)), { outcome: "unconfirmed", key: key(1), reason: "ended" });
		const status = await manager.status(ada(1));
		assert.equal(status.outcome === "found" && status.state, "closed_observed");
		assert.equal(status.outcome === "found" && status.notAfter, WALL + 60_000);

		time.setWall(WALL);
		assert.deepEqual(await manager.launch(request(2, { notAfter: WALL })), { outcome: "refused", reason: "invalid_deadline" });
		assert.deepEqual(await manager.launch(request(2, { notAfter: WALL + MAX_LAUNCH_MS + 1 })), { outcome: "refused", reason: "invalid_deadline" });
		const release = memory.hold();
		const passing = manager.launch(request(3, { notAfter: WALL + 1_000 }));
		await flush();
		time.setWall(WALL + 1_000);
		release();
		assert.deepEqual(await passing, { outcome: "start_failed", key: key(3) });
		assert.equal(desk.calls.length, 1, "a deadline that passed while the intent was stored started nothing");
	});

	it("refuses new keys at its limits and evicts nothing", async () => {
		const { desk, manager } = await setUp({ auto: false });
		const starts = Array.from({ length: MAX_UNRESOLVED_LAUNCHES }, (_, n) => manager.launch(request(n + 1)));
		await flush();
		assert.deepEqual(await manager.launch(request(9)), { outcome: "refused", reason: "limit" }, "starts in progress count");
		for (let n = 0; n < MAX_UNRESOLVED_LAUNCHES; n++) desk.answer(n);
		for (const start of starts) assert.equal((await start).outcome, "launched");
		assert.deepEqual(await manager.launch(request(9)), { outcome: "refused", reason: "limit" });
		for (let n = 1; n <= MAX_UNRESOLVED_LAUNCHES; n++) assert.equal((await manager.launch(request(n))).outcome, "launched", "every earlier launch is still held");
		await manager.end(ada(1));
		assert.deepEqual(await manager.launch(request(9)), { outcome: "refused", reason: "limit" }, "a requested end frees nothing");
		const status = await manager.status(ada(1));
		assert.equal(status.outcome === "found" && status.state, "closed_observed");
		const next = manager.launch(request(9));
		await flush();
		desk.answer(MAX_UNRESOLVED_LAUNCHES);
		assert.equal((await next).outcome, "launched");
	});

	it("refuses before storing anything without a root token, and fails a refused start for good", async () => {
		const missing = await setUp({ rootToken: () => undefined });
		assert.deepEqual(await missing.manager.launch(request(1)), { outcome: "refused", reason: "no_credential" });
		assert.deepEqual([missing.memory.entry(key(1)), missing.desk.calls.length], [undefined, 0]);

		const refused = await setUp({ auto: "fail" });
		assert.deepEqual(await refused.manager.launch(request(1)), { outcome: "start_failed", key: key(1) });
		assert.deepEqual(await refused.manager.launch(request(1)), { outcome: "start_failed", key: key(1) });
		assert.equal(refused.desk.calls.length, 1);
		assert.match(refused.memory.entry(key(1))?.evidence ?? "", /may last until notAfter/);
	});

	it("still ends a launch it holds after a journal write failed", async () => {
		const { memory, desk, manager } = await setUp();
		assert.equal((await manager.launch(request(1))).outcome, "launched");
		memory.failNext("before");
		assert.deepEqual(await manager.launch(request(2)), { outcome: "refused", reason: "storage" });
		assert.deepEqual(await manager.end(ada(1)), { outcome: "requested", recorded: false });
		assert.equal(desk.launches[0]?.lifetime.status().phase, "closed");
		const status = await manager.status(ada(1));
		assert.equal(status.outcome === "found" && status.state, "open", "what the journal can't record isn't claimed");
	});
});
