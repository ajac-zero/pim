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
import {
	checkedOrigin,
	createMediaOpener,
	createRootTokenReader,
	createViewerHost,
	endOwnedLaunches,
	MAX_ROOT_TOKEN_BYTES,
	parseViewerSettings,
	type UpstreamSocket,
} from "../viewer-host.ts";
import type { EndAnswer, KeyRequest, StatusAnswer } from "../viewer-launch-manager.ts";
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
	const all = { origin: "http://127.0.0.1:3211", journalDirectory: "/var/lib/pim-viewer" };
	const env = { PIM_VIEWER_ROOT_TOKEN_FILE: "/etc/pim-viewer/root-token" };

	it("are none when none is given, and checked whole when any is", () => {
		assert.equal(parseViewerSettings({}, {}), undefined);
		assert.deepEqual(parseViewerSettings(all, env), { origin: "http://127.0.0.1:3211", displayId: "primary", journalDirectory: "/var/lib/pim-viewer", rootTokenFile: "/etc/pim-viewer/root-token" });
		assert.equal(parseViewerSettings({ ...all, display: "DP-1" }, env)?.displayId, "DP-1");
	});

	it("refuse a part given without the rest, however small the part", () => {
		assert.throws(() => parseViewerSettings({}, env), RangeError);
		assert.throws(() => parseViewerSettings({ display: "primary" }, {}), RangeError);
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

describe("a shutdown's launches", () => {
	const key = (name: string): KeyRequest => ({ owner: SPACE, key: name.padEnd(16, "k"), generation: "g" });
	/** A manager whose launches close after `after[key]` status reads (never when absent), on a clock the sleeps advance. */
	function world(after: Record<string, number>, finalOnEnd: string[] = []) {
		let time = 0;
		const reads: Record<string, number> = {};
		const ends: string[] = [];
		return {
			ends,
			options: { graceMs: 1000, pollMs: 300, now: () => time, sleep: async (ms: number) => void (time += ms) },
			manager: {
				end: async (request: KeyRequest): Promise<EndAnswer> => {
					ends.push(request.key);
					return finalOnEnd.includes(request.key) ? { outcome: "final", state: "closed_observed" } : { outcome: "requested", recorded: true };
				},
				status: async (request: KeyRequest): Promise<StatusAnswer> => {
					reads[request.key] = (reads[request.key] ?? 0) + 1;
					const done = request.key in after && reads[request.key]! > after[request.key]!;
					return { outcome: "found", key: request.key, state: done ? "closed_observed" : "ending", generation: "g", launchId: "l", notAfter: 1, evidence: null, launch: null };
				},
			},
		};
	}

	it("asks each to end, reads each until it is seen closed, and reports what it saw", async () => {
		const a = key("a");
		const b = key("b");
		const c = key("c");
		const w = world({ [a.key]: 2 }, [c.key]);
		assert.deepEqual(await endOwnedLaunches(w.manager, [a, b, c], w.options), { requested: 3, closed: 2, pending: 1 });
		assert.deepEqual(w.ends, [a.key, b.key, c.key]);
	});

	it("gives up when the grace has passed and calls what it didn't see closed pending, not closed", async () => {
		const a = key("a");
		const w = world({});
		let reads = 0;
		const manager = { ...w.manager, status: async (request: KeyRequest) => (reads++, w.manager.status(request)) };
		assert.deepEqual(await endOwnedLaunches(manager, [a], w.options), { requested: 1, closed: 0, pending: 1 });
		assert.ok(reads >= 2 && reads <= 6, "bounded by the grace");
	});

	it("leaves a launch pending when the manager throws, and asks about none when there are none", async () => {
		const a = key("a");
		const throwing = { end: async () => Promise.reject(new Error("x")), status: async () => Promise.reject(new Error("x")) };
		assert.deepEqual(await endOwnedLaunches(throwing, [a], world({}).options), { requested: 1, closed: 0, pending: 1 });
		assert.deepEqual(await endOwnedLaunches(throwing, [], world({}).options), { requested: 0, closed: 0, pending: 0 });
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
	const make = (files: FakeFiles) => createViewerHost({ origin: "http://127.0.0.1:3211", displayId: "primary", journalDirectory: DIR, rootTokenFile: ROOT, files, upstream: noSpacesd, generation: "host-test" });

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
		assert.deepEqual(await viewer.close(), { requested: 0, closed: 0, pending: 0, lockLeft: false });
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
		stuck.failNext.add("close");
		assert.equal((await held.close()).lockLeft, true);
		assert.equal(stuck.nodes.has(`${DIR}/journal.lock`), true);
		assert.equal(stuck.log.some((entry) => entry.startsWith("unlink")), false);
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
