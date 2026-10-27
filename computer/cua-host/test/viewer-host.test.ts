/**
 * The bridge's viewer side (../viewer-host.ts) over fakes only: files are in
 * memory (./fake-journal-files.ts), spacesd is a function that fails the test
 * if it is called or a recorder, the launch manager in the shutdown tests is a
 * stand-in, and the media socket is an in-process emitter. No socket, process,
 * timer of the real clock, or real file. The Node host's routes over loopback
 * sockets are in viewer-routes.test.ts, which is outside this boundary.
 */

import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { describe, it } from "node:test";
import { isHttpsOrigin, originAllowed, viewerHeaders } from "../host.ts";
import { viewerCsp } from "../viewer-adapter.ts";
import {
	checkedOrigin,
	createMediaOpener,
	createRootTokenReader,
	createViewerHost,
	createLaunchAdmission,
	MAX_ROOT_TOKEN_BYTES,
	parseViewerSettings,
	type UpstreamSocket,
} from "../viewer-host.ts";
import type { EndAnswer, EntryState, KeyRequest, LaunchAnswer, LaunchRequestKey, StatusAnswer } from "../viewer-launch-manager.ts";
import { FakeFiles, OWNER_UID } from "./fake-journal-files.ts";

const SPACE = "o_0123456789abcdefghijklmnop";

describe("the viewer host's root token", () => {
	const FILE = "/etc/pim-viewer/root-token";
	const token = "t".repeat(40);
	const read = (prepare: (files: FakeFiles) => void) => {
		const files = new FakeFiles();
		prepare(files);
		return createRootTokenReader(FILE, files).read();
	};

	it("is read from a checked file of this account's, with at most one newline after it", () => {
		assert.equal(read((files) => files.file(FILE, token)), token);
		assert.equal(read((files) => files.file(FILE, `${token}\n`)), token);
		assert.equal(read((files) => files.file(FILE, `${token}\n`, 0o400)), token);
		assert.equal(read((files) => files.file(FILE, "a".repeat(MAX_ROOT_TOKEN_BYTES) + "\n")), "a".repeat(MAX_ROOT_TOKEN_BYTES));
	});

	it("is none when the file is missing, another's, readable by others, linked, empty, too long or not printable", () => {
		assert.equal(read(() => undefined), undefined);
		assert.equal(read((files) => files.file(FILE, token, 0o640)), undefined);
		assert.equal(read((files) => files.file(FILE, token, 0o604)), undefined);
		assert.equal(read((files) => files.file(FILE, token, 0o600, OWNER_UID + 1)), undefined);
		assert.equal(read((files) => files.link(FILE)), undefined);
		assert.equal(read((files) => (files.file(FILE, token), (files.nodes.get(FILE)!.nlink = 2))), undefined);
		assert.equal(read((files) => files.file(FILE, "")), undefined);
		assert.equal(read((files) => files.file(FILE, "\n")), undefined);
		assert.equal(read((files) => files.file(FILE, "a".repeat(MAX_ROOT_TOKEN_BYTES + 1))), undefined);
		assert.equal(read((files) => files.file(FILE, `${token}\n\n`)), undefined);
		assert.equal(read((files) => files.file(FILE, `${token} x`)), undefined);
		assert.equal(read((files) => files.file(FILE, `${token}\r\n`)), undefined);
		const nobody = new FakeFiles();
		nobody.file(FILE, token);
		nobody.user = undefined;
		assert.equal(createRootTokenReader(FILE, nobody).read(), undefined);
	});

	it("is read afresh for each call", () => {
		const files = new FakeFiles();
		files.file(FILE, token);
		const reader = createRootTokenReader(FILE, files);
		assert.equal(reader.read(), token);
		files.nodes.get(FILE)!.data = Buffer.from("u".repeat(40));
		assert.equal(reader.read(), "u".repeat(40));
		files.nodes.delete(FILE);
		assert.equal(reader.read(), undefined);
		assert.equal(reader.latched(), false);
	});

	it("refuses the token and latches when the descriptor can't be seen to close, and never closes that number again", () => {
		const files = new FakeFiles();
		files.file(FILE, token);
		const reader = createRootTokenReader(FILE, files);
		files.failNext.add("close");
		assert.equal(reader.read(), undefined, "a valid token is not returned past a close that failed");
		assert.equal(reader.latched(), true);
		const before = files.log.length;
		assert.equal(reader.read(), undefined);
		assert.equal(files.log.length, before, "a latched reader opens and closes nothing");
		assert.equal(files.log.filter((entry) => entry.startsWith("close")).length, 1);
	});

	it("latches when the close fails after a refused file too", () => {
		const files = new FakeFiles();
		files.file(FILE, token, 0o644);
		const reader = createRootTokenReader(FILE, files);
		files.failNext.add("close");
		assert.equal(reader.read(), undefined);
		assert.equal(reader.latched(), true);
	});
});

describe("the viewer's settings", () => {
	const all = { origin: "http://127.0.0.1:3211", journalDirectory: "/var/lib/pim-viewer", publicOrigin: "https://bridge.example:8443" };
	const env = { PIM_VIEWER_ROOT_TOKEN_FILE: "/etc/pim-viewer/root-token" };

	it("are none when none is given, and checked whole when any is", () => {
		assert.equal(parseViewerSettings({}, {}), undefined);
		assert.deepEqual(parseViewerSettings(all, env), {
			origin: "http://127.0.0.1:3211",
			displayId: "primary",
			journalDirectory: "/var/lib/pim-viewer",
			rootTokenFile: "/etc/pim-viewer/root-token",
			publicOrigin: "https://bridge.example:8443",
		});
		assert.equal(parseViewerSettings({ ...all, display: "DP-1" }, env)?.displayId, "DP-1");
		assert.equal(parseViewerSettings({ ...all, embedOrigin: "https://pim.example" }, env)?.embedOrigin, "https://pim.example");
	});

	it("keep spacesd's origin apart from the browser's: both are needed, and neither stands in for the other", () => {
		assert.throws(() => parseViewerSettings({ origin: all.origin, journalDirectory: all.journalDirectory }, env), RangeError);
		assert.throws(() => parseViewerSettings({ publicOrigin: all.publicOrigin, journalDirectory: all.journalDirectory }, env), RangeError);
		assert.equal(parseViewerSettings(all, env)?.origin, "http://127.0.0.1:3211");
		assert.equal(parseViewerSettings(all, env)?.publicOrigin, "https://bridge.example:8443");
	});

	it("refuse a part given without the rest, however small the part", () => {
		assert.throws(() => parseViewerSettings({}, env), RangeError);
		assert.throws(() => parseViewerSettings({ display: "primary" }, {}), RangeError);
		assert.throws(() => parseViewerSettings({ embedOrigin: "https://pim.example" }, {}), RangeError);
		assert.throws(() => parseViewerSettings({ publicOrigin: all.publicOrigin }, {}), RangeError);
		assert.throws(() => parseViewerSettings({ origin: all.origin }, env), RangeError);
		assert.throws(() => parseViewerSettings({ journalDirectory: all.journalDirectory }, env), RangeError);
		assert.throws(() => parseViewerSettings(all, {}), RangeError);
		assert.throws(() => parseViewerSettings(all, { PIM_VIEWER_ROOT_TOKEN_FILE: "" }), RangeError);
	});

	it("refuse an invalid origin, path or display", () => {
		assert.throws(() => parseViewerSettings({ ...all, origin: "http://desktop.example" }, env), RangeError);
		assert.throws(() => parseViewerSettings({ ...all, journalDirectory: "relative" }, env), RangeError);
		assert.throws(() => parseViewerSettings({ ...all, journalDirectory: "/var/lib/../pim" }, env), RangeError);
		assert.throws(() => parseViewerSettings(all, { PIM_VIEWER_ROOT_TOKEN_FILE: "token" }), RangeError);
		assert.throws(() => parseViewerSettings({ ...all, display: "not a display" }, env), RangeError);
		assert.throws(() => parseViewerSettings({ ...all, display: "" }, env), RangeError);
		for (const bad of ["http://bridge.example", "http://127.0.0.1:8443", "https://bridge.example/", "https://bridge.example/path", "https://u:p@bridge.example", "https://bridge.example?q", "*", "", "bridge.example"]) {
			assert.throws(() => parseViewerSettings({ ...all, publicOrigin: bad }, env), RangeError, `public origin ${bad}`);
			assert.throws(() => parseViewerSettings({ ...all, embedOrigin: bad }, env), RangeError, `embedding origin ${bad}`);
		}
	});
});

describe("a browser's origin and the viewer's headers", () => {
	const PUBLIC = "https://bridge.example:8443";

	it("takes only exact https origins a browser would write", () => {
		for (const good of [PUBLIC, "https://pim.example", "https://localhost", "https://a-b.c1.example:444", "https://203.0.113.7", "https://203.0.113.7:8443", "https://[::1]", "https://[2001:db8::1]:8443", `https://${"a".repeat(63)}.example`]) {
			assert.equal(isHttpsOrigin(good), true, good);
		}
		const bad = [
			// Scheme, path, query, fragment, credentials.
			"http://pim.example", "https://pim.example/", "https://pim.example/a", "https://pim.example?q=1", "https://pim.example#f", "https://pim.example/?q", "https://u@pim.example", "https://u:p@pim.example",
			// A default port written out is not what a browser sends: it writes the origin without it.
			"https://pim.example:443", "https://pim.example:", "https://[::1]:443",
			// Wildcards, which the URL parser lets through as a host.
			"https://*.example", "https://*", "https://a*.example", "https://pim.*", "https://%2A.example", "*", "https://*.example:8443",
			// Empty or malformed hostnames.
			"https://", "https://.example", "https://example.", "https://example..com", "https://-a.example", "https://a-.example", "https://exa_mple.example", "https://exa mple.example", `https://${"a".repeat(64)}.example`, "https://[::1", "https://[zz::1]",
			// Other forms of the same origin: not what `Origin` carries.
			"https://PIM.example", "https://pim.example\\", "HTTPS://pim.example", " https://pim.example", "https://pim.example ", "null", "", "pim.example",
		];
		for (const value of bad) assert.equal(isHttpsOrigin(value), false, JSON.stringify(value));
		for (const value of [undefined, null, 1, {}, ["https://pim.example"]]) assert.equal(isHttpsOrigin(value), false, String(value));
	});

	it("names the media socket's origin in the page's policy as well as 'self', and keeps the rest", () => {
		const plain = viewerCsp();
		assert.ok(plain.includes("connect-src 'self';"));
		assert.equal(plain, "default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; worker-src 'self'; base-uri 'none'; form-action 'none'");
		assert.equal(viewerCsp(PUBLIC), plain.replace("connect-src 'self';", "connect-src 'self' wss://bridge.example:8443;"));
		assert.ok(viewerCsp("https://bridge.example").includes("connect-src 'self' wss://bridge.example;"), "a default port is not written");
		for (const bad of ["http://bridge.example", "https://bridge.example/", "https://bridge.example:443", "*"]) assert.throws(() => viewerCsp(bad), bad === "*" ? TypeError : RangeError, bad);
	});

	it("lets a media socket or call through only with exactly one Origin, the public one", () => {
		assert.equal(originAllowed([PUBLIC], PUBLIC), true);
		assert.equal(originAllowed(undefined, PUBLIC), false, "absent fails closed");
		assert.equal(originAllowed([], PUBLIC), false);
		assert.equal(originAllowed(["https://pim.example"], PUBLIC), false, "the Pim app's origin is not the viewer's");
		assert.equal(originAllowed(["https://bridge.example:8444"], PUBLIC), false);
		assert.equal(originAllowed(["http://bridge.example:8443"], PUBLIC), false);
		assert.equal(originAllowed(["null"], PUBLIC), false);
		assert.equal(originAllowed([PUBLIC, PUBLIC], PUBLIC), false, "repeated is refused");
		assert.equal(originAllowed([PUBLIC, "https://evil.example"], PUBLIC), false);
	});

	it("allows framing by one exact origin or no one, and no clipboard, microphone or capture", () => {
		assert.deepEqual(viewerHeaders(undefined)[0], ["content-security-policy", "frame-ancestors 'none'"]);
		assert.deepEqual(viewerHeaders("https://pim.example")[0], ["content-security-policy", "frame-ancestors https://pim.example"]);
		const policy = Object.fromEntries(viewerHeaders(undefined))["permissions-policy"]!;
		for (const feature of ["clipboard-read", "clipboard-write", "microphone", "camera", "display-capture"]) assert.ok(policy.includes(`${feature}=()`), feature);
		assert.equal(viewerHeaders("https://pim.example").some(([name]) => name.startsWith("access-control-")), false, "no CORS header");
	});
});

describe("the media opener", () => {
	class Fake extends EventEmitter {
		terminated = 0;
		bufferedAmount = 0;
		send() {}
		close() {}
		terminate() {
			this.terminated++;
			queueMicrotask(() => this.emit("close", 1006));
		}
	}
	const events = () => {
		const seen: { closed: (number | undefined)[]; messages: (string | Uint8Array)[] } = { closed: [], messages: [] };
		return { seen, events: { message: (data: string | Uint8Array) => seen.messages.push(data), closed: (code?: number) => seen.closed.push(code) } };
	};

	it("makes no socket for an open that was already cancelled", async () => {
		let made = 0;
		const open = createMediaOpener(() => {
			made++;
			return new Fake() as unknown as UpstreamSocket;
		});
		const controller = new AbortController();
		controller.abort();
		await assert.rejects(open({ url: "ws://127.0.0.1:1/media", protocol: "rcdp.v2", signal: controller.signal, events: events().events }));
		assert.equal(made, 0);
	});

	it("ends the socket it made when the open is cancelled later, and reports its closure", async () => {
		const fake = new Fake();
		const open = createMediaOpener(() => fake as unknown as UpstreamSocket);
		const controller = new AbortController();
		const { seen, events: sink } = events();
		const opened = open({ url: "ws://127.0.0.1:1/media", protocol: "rcdp.v2", signal: controller.signal, events: sink });
		controller.abort();
		await assert.rejects(opened);
		assert.equal(fake.terminated, 1);
		await new Promise((resolve) => setImmediate(resolve));
		assert.deepEqual(seen.closed, [undefined]);
	});

	it("resolves when open, passes messages on after that, and rejects with the upgrade's status when refused", async () => {
		const fake = new Fake();
		const { seen, events: sink } = events();
		const opened = createMediaOpener(() => fake as unknown as UpstreamSocket)({ url: "ws://127.0.0.1:1/media", protocol: "rcdp.v2", signal: new AbortController().signal, events: sink });
		fake.emit("message", Buffer.from("early"), false);
		fake.emit("open");
		const socket = await opened;
		fake.emit("message", Buffer.from("late"), false);
		assert.deepEqual(seen.messages, ["late"]);
		socket.terminate();

		const refused = new Fake();
		const rejected = createMediaOpener(() => refused as unknown as UpstreamSocket)({ url: "ws://127.0.0.1:1/media", protocol: "rcdp.v2", signal: new AbortController().signal, events: events().events });
		refused.emit("unexpected-response", {}, { statusCode: 401, resume() {} });
		await assert.rejects(rejected, (error: { status?: number }) => error.status === 401);
	});

	it("rejects when no socket can be made", async () => {
		const open = createMediaOpener(() => {
			throw new Error("no socket");
		});
		await assert.rejects(open({ url: "ws://127.0.0.1:1/media", protocol: "rcdp.v2", signal: new AbortController().signal, events: events().events }));
	});
});

/** Lets every promise that is ready run, without any timer. */
const settle = async () => {
	for (let index = 0; index < 40; index++) await Promise.resolve();
};

/** A clock that moves only when a test moves it, with timers that can be set and cleared: `active` counts those still set. */
function clock() {
	let time = 0;
	let next = 0;
	const timers = new Map<number, { at: number; wake: () => void }>();
	return {
		timers: {
			set: (wake: () => void, ms: number): unknown => {
				const handle = next++;
				timers.set(handle, { at: time + ms, wake });
				return handle;
			},
			clear: (handle: unknown) => void timers.delete(handle as number),
		},
		active: () => timers.size,
		async advance(ms: number) {
			const target = time + ms;
			for (;;) {
				const due = [...timers.entries()].filter(([, timer]) => timer.at <= target).sort((a, b) => a[1].at - b[1].at)[0];
				if (!due) break;
				timers.delete(due[0]);
				time = Math.max(time, due[1].at);
				due[1].wake();
				await settle();
			}
			time = target;
			await settle();
		},
	};
}

/** Something a test holds back; `release` settles it with a harmless answer, `settle` with a chosen one. */
function gate<T>(fallback: T) {
	let settleIt!: (value: T) => void;
	const promise = new Promise<T>((resolve) => {
		settleIt = resolve;
	});
	return { promise, settle: settleIt, release: () => settleIt(fallback) };
}

/**
 * Runs `body`, then, whatever happened, releases every gate and waits for
 * every operation the body handed it, so no continuation outlives the test.
 * A failure of the body and any failure in the cleanup are all kept, in an
 * `AggregateError` when there is more than one.
 */
async function withGates(gates: { release: () => void }[], body: (owned: Promise<unknown>[]) => Promise<void>): Promise<void> {
	const owned: Promise<unknown>[] = [];
	const errors: unknown[] = [];
	try {
		await body(owned);
	} catch (error) {
		errors.push(error);
	}
	for (const held of gates) held.release();
	await settle();
	for (const result of await Promise.allSettled(owned)) if (result.status === "rejected") errors.push(result.reason);
	if (errors.length === 1) throw errors[0];
	if (errors.length > 1) throw new AggregateError(errors, "The test failed, and so did its cleanup.");
}

/** Moves time in steps until `work` finishes, at most a bounded number of them, and checks no timer is left set. */
async function drive<T>(time: ReturnType<typeof clock>, work: Promise<T>): Promise<T> {
	let finished = false;
	work.then(
		() => (finished = true),
		() => (finished = true),
	);
	await settle();
	for (let step = 0; step < 100 && !finished; step++) await time.advance(100);
	assert.ok(finished, "the shutdown finished within the bounded steps");
	const report = await work;
	assert.equal(time.active(), 0, "every timer the shutdown set was cleared");
	return report;
}

describe("a shutdown", () => {
	const key = (name: string) => name.padEnd(16, "k");
	const launchRequest = (name: string): LaunchRequestKey => ({ key: key(name), owner: SPACE, notAfter: 1 });
	const keyRequest = (name: string): KeyRequest => ({ owner: SPACE, key: key(name), generation: "g" });
	const launched = (name: string): LaunchAnswer => ({ outcome: "launched", key: key(name), launchId: "l".repeat(22), generation: "g", notAfter: 1, viewerPath: "/x", replayed: false });
	const found = (name: string, state: EntryState): StatusAnswer => ({ outcome: "found", key: key(name), state, generation: "g", launchId: "l", notAfter: 1, evidence: null, launch: null });
	const options = (time: ReturnType<typeof clock>) => ({ graceMs: 1000, pollMs: 300, timers: time.timers });
	const journal = () => {
		const seen = { closes: 0 };
		return { seen, close: async () => void seen.closes++ };
	};
	/** A manager whose launch, end and status answer from `script`, and which records the keys it was asked about. */
	function manager(script: { launch?: (request: LaunchRequestKey) => Promise<LaunchAnswer>; end?: (request: KeyRequest) => Promise<EndAnswer>; status?: (request: KeyRequest) => Promise<StatusAnswer> } = {}) {
		const seen = { launches: [] as string[], ends: [] as string[], statuses: [] as string[] };
		return {
			seen,
			manager: {
				launch: async (request: LaunchRequestKey) => {
					seen.launches.push(request.key);
					return script.launch ? script.launch(request) : launched(request.key.replace(/k+$/, ""));
				},
				end: async (request: KeyRequest) => {
					seen.ends.push(request.key);
					return script.end ? script.end(request) : ({ outcome: "requested", recorded: true } as const);
				},
				status: async (request: KeyRequest) => {
					seen.statuses.push(request.key);
					return script.status ? script.status(request) : found(request.key.replace(/k+$/, ""), "ending");
				},
			},
		};
	}

	it("asks each launch to end, reads each until it is seen closed, and reports what it saw", async () => {
		const reads: Record<string, number> = {};
		const w = manager({
			end: async (request) => (request.key === key("c") ? { outcome: "final", state: "closed_observed" } : { outcome: "requested", recorded: true }),
			status: async (request) => {
				const name = request.key.replace(/k+$/, "");
				reads[name] = (reads[name] ?? 0) + 1;
				return found(name, name === "a" && reads[name]! > 2 ? "closed_observed" : "ending");
			},
		});
		const admission = createLaunchAdmission(w.manager);
		for (const name of ["a", "b", "c"]) await admission.manager.launch(launchRequest(name));
		const time = clock();
		const j = journal();
		const report = await drive(time, admission.shutdown(options(time), j));
		assert.deepEqual(report, { requested: 3, closed: 2, pending: 1, unconfirmed: 0, inFlight: 0, unsettled: 0, lockLeft: false, settled: false });
		assert.deepEqual(w.seen.ends, [key("a"), key("b"), key("c")]);
		assert.equal(j.seen.closes, 1, "nothing was outstanding, so the lock was released, though one launch is pending");
	});

	it("gives up when the grace has passed and calls what it didn't see closed pending, not closed", async () => {
		const w = manager();
		const admission = createLaunchAdmission(w.manager);
		await admission.manager.launch(launchRequest("a"));
		const time = clock();
		const report = await drive(time, admission.shutdown(options(time), journal()));
		assert.equal(report.closed, 0);
		assert.equal(report.pending, 1);
		assert.ok(w.seen.statuses.length >= 2 && w.seen.statuses.length <= 6, "bounded by the grace");
	});

	it("counts a launch whose last read was unconfirmed", async () => {
		const w = manager({ status: async (request) => found(request.key.replace(/k+$/, ""), "unconfirmed") });
		const admission = createLaunchAdmission(w.manager);
		await admission.manager.launch(launchRequest("a"));
		const time = clock();
		const report = await drive(time, admission.shutdown(options(time), journal()));
		assert.deepEqual([report.pending, report.unconfirmed, report.settled], [1, 1, false]);
	});

	it("leaves a launch pending when the manager throws, and has nothing to ask when it has no launch", async () => {
		const throwing = manager({ end: () => Promise.reject(new Error("x")), status: () => Promise.reject(new Error("x")) });
		const admission = createLaunchAdmission(throwing.manager);
		await admission.manager.launch(launchRequest("a"));
		const time = clock();
		const report = await drive(time, admission.shutdown(options(time), journal()));
		assert.deepEqual([report.requested, report.closed, report.pending, report.unsettled], [1, 0, 1, 0]);

		const none = createLaunchAdmission(manager().manager);
		const quiet = clock();
		assert.deepEqual(await drive(quiet, none.shutdown(options(quiet), journal())), { requested: 0, closed: 0, pending: 0, unconfirmed: 0, inFlight: 0, unsettled: 0, lockLeft: false, settled: true });
	});

	it("is not held by an end that never answers, and leaves the lock held and the call counted", async () => {
		const held = gate<EndAnswer>({ outcome: "requested", recorded: true });
		await withGates([held], async () => {
			const w = manager({ end: () => held.promise });
			const admission = createLaunchAdmission(w.manager);
			await admission.manager.launch(launchRequest("a"));
			const time = clock();
			const j = journal();
			const report = await drive(time, admission.shutdown(options(time), j));
			assert.deepEqual([report.pending, report.unsettled, report.inFlight, report.lockLeft, report.settled], [1, 1, 0, true, false]);
			assert.equal(j.seen.closes, 0, "a call that could still write holds the lock");
		});
	});

	it("is not held by a status that never answers, and reads a launch one at a time", async () => {
		const held = gate<StatusAnswer>(found("a", "ending"));
		await withGates([held], async () => {
			const w = manager({ status: () => held.promise });
			const admission = createLaunchAdmission(w.manager);
			await admission.manager.launch(launchRequest("a"));
			const time = clock();
			const j = journal();
			const report = await drive(time, admission.shutdown(options(time), j));
			assert.deepEqual([report.pending, report.unsettled, report.lockLeft, report.settled], [1, 1, true, false]);
			assert.equal(w.seen.statuses.length, 1, "a held read isn't piled on");
			assert.equal(j.seen.closes, 0);
		});
	});

	it("is held by no launch that is still starting, refuses new ones, and ends a late one when it answers", async () => {
		const start = gate<LaunchAnswer>(launched("a"));
		await withGates([start], async (owned) => {
			const w = manager({ launch: () => start.promise });
			const admission = createLaunchAdmission(w.manager);
			const starting = admission.manager.launch(launchRequest("a"));
			owned.push(starting);
			const time = clock();
			const j = journal();
			const done = admission.shutdown(options(time), j);
			await settle();
			assert.deepEqual(await admission.manager.launch(launchRequest("b")), { outcome: "refused", reason: "blocked" });
			assert.deepEqual(w.seen.launches, [key("a")], "the refused launch never reached the manager");
			const report = await drive(time, done);
			assert.deepEqual([report.inFlight, report.unsettled, report.pending, report.lockLeft, report.settled], [1, 0, 0, true, false]);
			assert.equal(j.seen.closes, 0);
			assert.deepEqual(w.seen.ends, []);
			// It answers after the deadline: nothing waits for it, and it is ended at once.
			start.settle(launched("a"));
			assert.equal((await starting).outcome, "launched");
			await settle();
			assert.deepEqual(w.seen.ends, [key("a")]);
		});
	});

	it("ends a launch that answers while it is waiting, and sees it closed", async () => {
		const start = gate<LaunchAnswer>(launched("a"));
		await withGates([start], async (owned) => {
			const w = manager({ launch: () => start.promise, end: async () => ({ outcome: "final", state: "closed_observed" }) });
			const admission = createLaunchAdmission(w.manager);
			owned.push(admission.manager.launch(launchRequest("a")));
			const time = clock();
			const j = journal();
			const done = admission.shutdown(options(time), j);
			await settle();
			start.settle(launched("a"));
			const report = await drive(time, done);
			assert.deepEqual(report, { requested: 1, closed: 1, pending: 0, unconfirmed: 0, inFlight: 0, unsettled: 0, lockLeft: false, settled: true });
			assert.equal(j.seen.closes, 1);
		});
	});

	it("leaves the lock held, and says so, when the journal's drain never finishes or fails", async () => {
		const held = gate<void>(undefined);
		await withGates([held], async () => {
			const admission = createLaunchAdmission(manager().manager);
			const time = clock();
			const report = await drive(time, admission.shutdown(options(time), { close: () => held.promise }));
			assert.deepEqual([report.lockLeft, report.settled], [true, false]);
		});
		const failing = createLaunchAdmission(manager().manager);
		const time = clock();
		const report = await drive(time, failing.shutdown(options(time), { close: () => Promise.reject(new Error("x")) }));
		assert.deepEqual([report.lockLeft, report.settled], [true, false]);
	});

	it("gives a drain one more poll interval when the deadline had already passed, and no more", async () => {
		const held = gate<void>(undefined);
		await withGates([held], async () => {
			// One launch never seen closed, so the deadline passes before the drain begins; the drain's own timer is cleared too.
			const admission = createLaunchAdmission(manager().manager);
			await admission.manager.launch(launchRequest("a"));
			const time = clock();
			const report = await drive(time, admission.shutdown(options(time), { close: () => held.promise }));
			assert.deepEqual([report.pending, report.lockLeft, report.settled], [1, true, false]);
		});
	});

	it("admits nothing through any of its three calls while the journal drain is held, and the underlying manager is not asked", async () => {
		const held = gate<void>(undefined);
		await withGates([held], async (owned) => {
			const w = manager();
			const admission = createLaunchAdmission(w.manager);
			const time = clock();
			const done = admission.shutdown(options(time), { close: () => held.promise });
			owned.push(done);
			await settle();
			assert.deepEqual(await admission.manager.launch(launchRequest("a")), { outcome: "refused", reason: "blocked" });
			assert.deepEqual(await admission.manager.end(keyRequest("a")), { outcome: "unconfirmed" });
			await assert.rejects(admission.manager.status(keyRequest("a")), /shutting down/);
			assert.deepEqual(w.seen, { launches: [], ends: [], statuses: [] });
			const report = await drive(time, done);
			assert.deepEqual([report.lockLeft, report.settled], [true, false]);
			assert.deepEqual(w.seen, { launches: [], ends: [], statuses: [] });
		});
	});

	it("gives the first call's answer to a second, and admits nothing after", async () => {
		const admission = createLaunchAdmission(manager().manager);
		const time = clock();
		const first = admission.shutdown(options(time), journal());
		assert.equal(admission.shutdown(options(time), journal()), first);
		await drive(time, first);
		assert.deepEqual(await admission.manager.launch(launchRequest("a")), { outcome: "refused", reason: "blocked" });
	});
});

describe("the viewer host", () => {
	const DIR = "/var/lib/pim-viewer";
	const ROOT = "/etc/pim-viewer/root-token";
	const noSpacesd = {
		fetch: async () => {
			throw new Error("spacesd must not be asked");
		},
		openMedia: async () => {
			throw new Error("spacesd must not be asked");
		},
	};
	const launch = { key: "k".repeat(16), owner: SPACE, notAfter: Date.now() + 3_600_000 };
	// No real timer: the shutdown's clock is a test's, and its work finishes without waiting on it.
	const make = (files: FakeFiles) => {
		const time = clock();
		return createViewerHost({ origin: "http://127.0.0.1:3211", displayId: "primary", journalDirectory: DIR, rootTokenFile: ROOT, publicOrigin: "https://bridge.example", files, upstream: noSpacesd, generation: "host-test", shutdown: { timers: time.timers } });
	};

	it("takes only an origin that is https, or http on a loopback address", () => {
		assert.equal(checkedOrigin("https://desktop.example"), true);
		assert.equal(checkedOrigin("https://desktop.example:8443"), true);
		assert.equal(checkedOrigin("http://127.0.0.1:3211"), true);
		assert.equal(checkedOrigin("http://[::1]:3211"), true);
		for (const bad of ["http://desktop.example", "http://localhost:3211", "https://u:p@desktop.example", "https://desktop.example/path", "https://desktop.example/?q", "ftp://127.0.0.1", "nonsense"]) {
			assert.equal(checkedOrigin(bad), false, bad);
		}
	});

	it("refuses every launch, and creates no journal, when the store can't be opened or there is no journal", async () => {
		// No directory at all.
		const none = new FakeFiles();
		const missing = await make(none);
		assert.ok(missing.blockers().some((reason) => reason.includes("journal store")));
		assert.deepEqual(await missing.routes.manager.launch(launch), { outcome: "refused", reason: "blocked" });
		assert.equal([...none.nodes.keys()].length, 0);

		// A directory with a lock left by a host that died: refused, the lock left alone.
		const locked = new FakeFiles();
		locked.directory(DIR);
		locked.file(`${DIR}/journal.json`, "{}");
		locked.file(`${DIR}/journal.lock`, "dead");
		const stale = await make(locked);
		assert.ok(stale.blockers().length > 0);
		assert.deepEqual(await stale.routes.manager.launch(launch), { outcome: "refused", reason: "blocked" });
		assert.equal(locked.text(`${DIR}/journal.lock`), "dead");
		assert.equal(locked.text(`${DIR}/journal.json`), "{}");

		// A directory with no journal in it: nothing is created, and the launch is blocked.
		const empty = new FakeFiles();
		empty.directory(DIR);
		empty.file(ROOT, "r".repeat(40));
		const unprovisioned = await make(empty);
		assert.ok(unprovisioned.blockers().length > 0);
		assert.deepEqual(await unprovisioned.routes.manager.launch(launch), { outcome: "refused", reason: "blocked" });
		assert.equal(empty.nodes.has(`${DIR}/journal.json`), false);
		await unprovisioned.close();
	});

	it("refuses a launch with no root token before anything is stored or spacesd is asked", async () => {
		const files = new FakeFiles();
		files.directory(DIR);
		files.file(`${DIR}/journal.json`, JSON.stringify({ version: 1, revision: 1, generation: "provisioned", initialized: "a test", entries: [] }));
		const viewer = await make(files);
		assert.deepEqual(viewer.blockers(), []);
		assert.deepEqual(await viewer.routes.manager.launch(launch), { outcome: "refused", reason: "no_credential" });
		assert.deepEqual((JSON.parse(files.text(`${DIR}/journal.json`)!) as { entries: unknown[] }).entries, []);
		assert.deepEqual(await viewer.close(), { requested: 0, closed: 0, pending: 0, unconfirmed: 0, inFlight: 0, unsettled: 0, lockLeft: false, settled: true });
		assert.equal(files.nodes.has(`${DIR}/journal.lock`), false);
	});

	it("admits no launch once its shutdown began, and says so when the journal's lock was left in place", async () => {
		const files = new FakeFiles();
		files.directory(DIR);
		files.file(`${DIR}/journal.json`, JSON.stringify({ version: 1, revision: 1, generation: "provisioned", initialized: "a test", entries: [] }));
		const viewer = await make(files);
		const closing = viewer.close();
		assert.deepEqual(await viewer.routes.manager.launch(launch), { outcome: "refused", reason: "blocked" });
		assert.equal(viewer.close(), closing, "a second call gets the first one's answer");
		assert.equal((await closing).lockLeft, false);

		// The lock descriptor can't be seen to close: the lock is left in place, and the result says so.
		const stuck = new FakeFiles();
		stuck.directory(DIR);
		stuck.file(`${DIR}/journal.json`, JSON.stringify({ version: 1, revision: 1, generation: "provisioned", initialized: "a test", entries: [] }));
		const held = await make(stuck);
		// Starting the host already wrote the journal (and so unlinked a temporary file, which is not the lock); only what the shutdown does is judged.
		const lock = `${DIR}/journal.lock`;
		const setup = stuck.log.length;
		stuck.failNext.add("close");
		assert.equal((await held.close()).lockLeft, true);
		assert.equal(stuck.nodes.has(lock), true);
		const shutdown = stuck.log.slice(setup);
		assert.deepEqual(shutdown.filter((entry) => entry.startsWith("unlink")), [], "the shutdown unlinked nothing: the lock's descriptor wasn't seen to close");
		assert.equal(shutdown.filter((entry) => entry === `close ${lock}`).length, 1, "the lock's descriptor was closed once, and never again by number");
	});

	it("reports a root token reader that latched", async () => {
		const files = new FakeFiles();
		files.directory(DIR);
		files.file(`${DIR}/journal.json`, JSON.stringify({ version: 1, revision: 1, generation: "provisioned", initialized: "a test", entries: [] }));
		files.file(ROOT, "r".repeat(40));
		const viewer = await make(files);
		files.failNext.add("close");
		assert.deepEqual(await viewer.routes.manager.launch(launch), { outcome: "refused", reason: "no_credential" });
		assert.ok(viewer.blockers().some((reason) => reason.includes("root token")));
		assert.deepEqual(await viewer.routes.manager.launch(launch), { outcome: "refused", reason: "no_credential" });
		await viewer.close();
	});
});
