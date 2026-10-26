/**
 * A viewer launch's absolute lifetime (../viewer-lifetime.ts), with a clock
 * and timers the test turns by hand and transports that are records in
 * memory. What stands in for Cua's upstream ticket is a deadline the test
 * keeps beside the launch, which the launch never sees. No socket, server,
 * process or real timer is involved.
 *
 *   pnpm --filter pim-cua-host test
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
	type Attachment,
	type LaunchStatus,
	lifetimeUntil,
	MAX_LAUNCH_MS,
	MAX_LAUNCH_TRANSPORTS,
	type OwnedTransport,
	startViewerLaunch,
	type Timers,
	type TransportKind,
	type ViewerLaunch,
} from "../viewer-lifetime.ts";

/** A clock the test sets, and timers that fire only when the test runs them. */
function fakeTime(start = 1_000) {
	let now = start;
	let next = 1;
	const pending = new Map<number, { readonly at: number; readonly callback: () => void }>();
	let set = 0;
	let cleared = 0;
	const timers: Timers = {
		set(callback, ms) {
			assert.ok(Number.isSafeInteger(ms) && ms >= 1, `a timer for ${ms} ms`);
			const id = next++;
			pending.set(id, { at: now + ms, callback });
			set++;
			return id;
		},
		clear(handle) {
			if (pending.delete(handle as number)) cleared++;
		},
	};
	return {
		clock: () => now,
		timers,
		/** Moves the clock without running any timer, as a stalled event loop would. */
		setNow(to: number) {
			now = to;
		},
		/** Moves the clock and runs the timers that are due, in order. */
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
		/** Runs every pending timer now, whatever the clock says: one that fires early or late. */
		fireAll() {
			for (const [id, t] of [...pending]) {
				pending.delete(id);
				t.callback();
			}
		},
		pending: () => pending.size,
		counts: () => ({ set, cleared }),
	};
}

/** A transport that records its `close` calls and reports itself closed when the test says. */
function transport(launch: ViewerLaunch, kind: TransportKind, options: { throws?: boolean; closesAtOnce?: boolean } = {}) {
	const record = { closes: 0, attachment: undefined as Attachment | undefined };
	const owned: OwnedTransport = {
		close() {
			record.closes++;
			if (options.closesAtOnce) record.attachment?.closed();
			if (options.throws) throw new Error("close failed");
		},
	};
	record.attachment = launch.adopt(kind, owned);
	return record;
}

const counts = (status: LaunchStatus) => Object.values(status.transports).reduce((a, b) => a + b, 0);

describe("a viewer launch's lifetime", () => {
	it("ends at its deadline though the upstream ticket is still valid", () => {
		const time = fakeTime();
		const ticketNotAfter = time.clock() + 60_000;
		const launch = startViewerLaunch({ lifetimeMs: 1_000, clock: time.clock, timers: time.timers });
		const viewer = transport(launch, "media-viewer");
		const upstream = transport(launch, "media-upstream");

		time.advance(999);
		assert.equal(launch.live(), true);
		assert.equal(launch.status().remainingMs, 1);
		time.advance(1);
		assert.ok(time.clock() < ticketNotAfter, "the ticket has not expired");
		assert.equal(launch.signal.aborted, true);
		assert.deepEqual([viewer.closes, upstream.closes], [1, 1]);
		assert.equal(launch.live(), false);
		assert.equal(launch.status().reason, "expired");
		assert.equal(launch.adopt("media-viewer", { close() {} }), undefined, "a valid ticket admits nothing more");
	});

	it("stays live, holding its transports, after the upstream ticket expires", () => {
		const time = fakeTime();
		const ticketNotAfter = time.clock() + 100;
		const launch = startViewerLaunch({ lifetimeMs: 1_000, clock: time.clock, timers: time.timers });
		const viewer = transport(launch, "media-viewer");

		time.advance(500);
		assert.ok(time.clock() > ticketNotAfter, "the ticket has expired");
		assert.equal(launch.live(), true);
		assert.equal(viewer.closes, 0);
		assert.equal(launch.status().transports["media-viewer"], 1);
		// Refusing a new upgrade on an expired ticket is upstream's concern; the launch neither ends nor lengthens for it.
		assert.equal(launch.status().remainingMs, 500);
	});

	it("refuses a late attach when its timer has not yet fired, and the late timer does nothing more", () => {
		const time = fakeTime();
		const launch = startViewerLaunch({ lifetimeMs: 1_000, clock: time.clock, timers: time.timers });
		const viewer = transport(launch, "media-viewer");

		time.setNow(time.clock() + 5_000);
		assert.equal(time.pending(), 1, "the timer is still waiting");
		const late = transport(launch, "media-viewer");
		assert.equal(late.attachment, undefined);
		assert.equal(late.closes, 1, "the late transport is closed at once");
		assert.equal(viewer.closes, 1, "the check that refused it ended the launch");
		assert.equal(launch.status().reason, "expired");
		assert.equal(time.pending(), 0, "and cleared its timer");

		time.fireAll();
		assert.equal(viewer.closes, 1);
	});

	it("checks the clock when a timer fires early, and sets another for what is left", () => {
		const time = fakeTime();
		const launch = startViewerLaunch({ lifetimeMs: 1_000, clock: time.clock, timers: time.timers });
		time.setNow(time.clock() + 400);
		time.fireAll();
		assert.equal(launch.live(), true);
		assert.equal(time.pending(), 1);
		time.advance(599);
		assert.equal(launch.live(), true);
		time.advance(1);
		assert.equal(launch.status().reason, "expired");
	});

	it("closes at once a transport whose asynchronous open finishes after the deadline", async () => {
		const time = fakeTime();
		const launch = startViewerLaunch({ lifetimeMs: 1_000, clock: time.clock, timers: time.timers });
		assert.equal(launch.live(), true, "the open starts while the launch is live");
		let finish!: () => void;
		const opening = new Promise<void>((resolve) => {
			finish = resolve;
		});
		const opened = opening.then(() => transport(launch, "media-upstream"));

		time.advance(1_000);
		assert.equal(launch.signal.aborted, true, "an open under way can be given up");
		finish();
		const upstream = await opened;
		assert.equal(upstream.attachment, undefined);
		assert.equal(upstream.closes, 1);
		assert.equal(counts(launch.status()), 0);
	});

	it("takes reconnects into the same launch, which none of them lengthens", () => {
		const time = fakeTime();
		const launch = startViewerLaunch({ lifetimeMs: 1_000, clock: time.clock, timers: time.timers });
		assert.deepEqual(Object.keys(launch).sort(), ["adopt", "end", "live", "signal", "status"]);
		assert.ok(Object.isFrozen(launch));

		for (let round = 0; round < 50; round++) {
			const viewer = transport(launch, "media-viewer");
			const rpc = transport(launch, "presence-rpc");
			viewer.attachment?.closed();
			rpc.attachment?.closed();
			rpc.attachment?.closed();
			time.advance(10);
		}
		assert.equal(launch.status().remainingMs, 500);
		assert.equal(counts(launch.status()), 0, "closed transports leave no registration");
		assert.equal(time.pending(), 1, "and one timer at a time");

		time.advance(499);
		const reconnected = transport(launch, "media-viewer");
		assert.ok(reconnected.attachment);
		time.advance(1);
		assert.equal(reconnected.closes, 1);
		assert.equal(launch.status().reason, "expired");
	});

	it("counts only monotonic time, so a clock that goes back gives none back", () => {
		const time = fakeTime(50_000);
		const launch = startViewerLaunch({ lifetimeMs: 1_000, clock: time.clock, timers: time.timers });
		time.setNow(50_900);
		assert.equal(launch.status().remainingMs, 100);
		time.setNow(10_000);
		assert.equal(launch.status().remainingMs, 100);
		time.setNow(50_950);
		assert.equal(launch.status().remainingMs, 50);
		time.setNow(51_000);
		assert.equal(launch.live(), false);
	});

	it("converts Pim's own wall-clock notAfter once, and a wall clock turned back later extends nothing", () => {
		let wall = Date.UTC(2026, 9, 26, 12);
		const time = fakeTime();
		const lifetimeMs = lifetimeUntil(wall + 1_000, wall);
		assert.equal(lifetimeMs, 1_000);
		const launch = startViewerLaunch({ lifetimeMs, clock: time.clock, timers: time.timers });
		wall -= 60 * 60 * 1000;
		time.advance(999);
		assert.equal(launch.live(), true);
		time.advance(1);
		assert.equal(launch.live(), false);
	});

	it("refuses lifetimes, times and clocks out of bounds", () => {
		for (const lifetimeMs of [0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY, MAX_LAUNCH_MS + 1, Number.MAX_SAFE_INTEGER]) {
			assert.throws(() => startViewerLaunch({ lifetimeMs, clock: () => 0 }), RangeError, String(lifetimeMs));
		}
		for (const start of [Number.NaN, Number.POSITIVE_INFINITY, Number.MAX_VALUE, 2 ** 60]) {
			const time = fakeTime(start);
			assert.throws(() => startViewerLaunch({ lifetimeMs: 1_000, clock: time.clock, timers: time.timers }), RangeError, String(start));
			assert.equal(time.pending(), 0);
		}
		const now = Date.UTC(2026, 9, 26);
		for (const [notAfter, at] of [
			[now, now],
			[now - 1, now],
			[now + MAX_LAUNCH_MS + 1, now],
			[now + 1.5, now],
			[Number.NaN, now],
			[now + 1_000, Number.POSITIVE_INFINITY],
		] as const) {
			assert.throws(() => lifetimeUntil(notAfter, at), RangeError, `${notAfter} at ${at}`);
		}
		assert.equal(lifetimeUntil(now + MAX_LAUNCH_MS, now), MAX_LAUNCH_MS);
	});

	it("ends a launch whose clock fails", () => {
		const time = fakeTime();
		let broken = false;
		const launch = startViewerLaunch({
			lifetimeMs: 1_000,
			clock: () => {
				if (broken) throw new Error("no clock");
				return time.clock();
			},
			timers: time.timers,
		});
		const viewer = transport(launch, "media-viewer");
		broken = true;
		assert.equal(launch.live(), false);
		assert.equal(viewer.closes, 1);
		assert.equal(launch.status().reason, "clock");
		assert.equal(time.pending(), 0);
	});

	it("closes every transport once when one cleanup throws, and stays closing until each reports closed", () => {
		const time = fakeTime();
		const launch = startViewerLaunch({ lifetimeMs: 1_000, clock: time.clock, timers: time.timers });
		const viewer = transport(launch, "media-viewer", { closesAtOnce: true });
		const broken = transport(launch, "media-upstream", { throws: true });
		const rpc = transport(launch, "presence-rpc");
		const brokenAtOnce = transport(launch, "presence-rpc", { throws: true, closesAtOnce: true });

		time.advance(1_000);
		assert.deepEqual(
			[viewer, broken, rpc, brokenAtOnce].map((t) => t.closes),
			[1, 1, 1, 1],
		);
		const status = launch.status();
		assert.equal(status.phase, "closing");
		assert.equal(status.closeFailures, 2);
		assert.deepEqual(status.transports, { "media-viewer": 0, "media-upstream": 1, "presence-rpc": 1 });

		rpc.attachment?.closed();
		assert.equal(launch.status().phase, "closing");
		broken.attachment?.closed();
		assert.equal(launch.status().phase, "closed");
	});

	it("keeps a requested shutdown apart from transports observed closed, and ends once", () => {
		const time = fakeTime();
		const launch = startViewerLaunch({ lifetimeMs: 1_000, clock: time.clock, timers: time.timers });
		const gone = transport(launch, "media-viewer");
		gone.attachment?.closed();
		assert.equal(gone.closes, 0, "a transport that closed by itself is not closed again");
		assert.equal(launch.status().phase, "live", "nor does it end the launch");

		const viewer = transport(launch, "media-viewer");
		const upstream = transport(launch, "media-upstream");
		launch.end();
		assert.equal(launch.status().phase, "closing", "close was requested, but nothing has reported closed");
		assert.equal(launch.status().reason, "ended");
		assert.equal(launch.status().remainingMs, 0);
		launch.end();
		time.advance(5_000);
		assert.deepEqual([viewer.closes, upstream.closes], [1, 1]);
		assert.equal(launch.status().reason, "ended", "the first reason stays");

		viewer.attachment?.closed();
		viewer.attachment?.closed();
		assert.equal(launch.status().phase, "closing");
		upstream.attachment?.closed();
		assert.equal(launch.status().phase, "closed");
	});

	it("refuses a transport adopted from inside a cleanup", () => {
		const time = fakeTime();
		const launch = startViewerLaunch({ lifetimeMs: 1_000, clock: time.clock, timers: time.timers });
		let reentered: Attachment | undefined | null = null;
		let refusedCloses = 0;
		launch.adopt("media-viewer", {
			close() {
				reentered = launch.adopt("media-viewer", {
					close() {
						refusedCloses++;
					},
				});
			},
		});
		launch.end();
		assert.equal(reentered, undefined);
		assert.equal(refusedCloses, 1);
		assert.equal(launch.status().transports["media-viewer"], 1);
	});

	it("holds at most its bound of transports at once", () => {
		const time = fakeTime();
		const launch = startViewerLaunch({ lifetimeMs: 1_000, clock: time.clock, timers: time.timers });
		const held = Array.from({ length: MAX_LAUNCH_TRANSPORTS }, () => transport(launch, "presence-rpc"));
		assert.ok(held.every((t) => t.attachment));
		const extra = transport(launch, "presence-rpc");
		assert.equal(extra.attachment, undefined);
		assert.equal(extra.closes, 1);
		assert.equal(launch.live(), true, "refusing one ends nothing");
		held[0]?.attachment?.closed();
		assert.ok(transport(launch, "presence-rpc").attachment);
	});

	it("sets one timer at a time and clears it when the launch ends", () => {
		const time = fakeTime();
		const ended = startViewerLaunch({ lifetimeMs: 1_000, clock: time.clock, timers: time.timers });
		assert.equal(time.pending(), 1);
		ended.end();
		assert.equal(time.pending(), 0);
		assert.deepEqual(time.counts(), { set: 1, cleared: 1 });

		const expired = startViewerLaunch({ lifetimeMs: 1_000, clock: time.clock, timers: time.timers });
		time.advance(1_000);
		assert.equal(expired.status().phase, "closed");
		assert.equal(time.pending(), 0);
		expired.end();
		assert.deepEqual(time.counts(), { set: 2, cleared: 1 }, "an expired timer has nothing left to clear");
	});

	it("uses Node's own clock and timers when given none", async () => {
		const launch = startViewerLaunch({ lifetimeMs: 20 });
		let closes = 0;
		launch.adopt("media-viewer", {
			close() {
				closes++;
			},
		});
		assert.equal(launch.live(), true);
		await new Promise((resolve) => setTimeout(resolve, 60));
		assert.equal(closes, 1);
		assert.equal(launch.status().reason, "expired");
	});
});
