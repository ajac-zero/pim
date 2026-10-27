/**
 * The desktop endpoint starting the Cua computer (../desktop.ts, with
 * ../cua-credential.ts), moved unchanged from session.test.ts (at
 * 9b6a05b97adf45415c94891c53558207de998bf6) so that this file can be run
 * whole, with nothing in it that starts a process. What stands in: the Cua
 * computer and pim-computer are in-memory `FakeChild`ren, made by each
 * endpoint's `spawn` or refused by one that throws; the credential file is a
 * stand-in for `fs` that records what was opened and closed, so no
 * credential file exists or is read. No `child_process` function is
 * imported, and every `createDesktopEndpoint` here is given a `spawn`.
 *
 * What it does touch: a temporary folder per test under `os.tmpdir()`
 * (`cua-desk-*`), holding a stand-in browser script that is never run and a
 * Unix socket the endpoint listens on and the test connects to, all removed
 * after each test; and Node's own timers, for waits of at most 5 s each.
 * Nothing leaves this machine.
 *
 *   node test/cua-endpoint.test.ts
 */

import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { PassThrough } from "node:stream";
import { after, afterEach, describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import type { SessionEvents } from "../../cua-bridge.ts";
import { type CredentialFiles, type CredentialStat, MAX_CREDENTIAL_BYTES } from "../cua-credential.ts";
import { type Child, type CuaChild, createDesktopEndpoint, EndpointRefused, type EndpointLimits, type Spawn, type SpawnOptions } from "../desktop.ts";
import { unixSession } from "../session.ts";

const HELLO = JSON.stringify({ type: "hello", version: 1, agent: "pim-computer/test" });
const HOST_DIR = fileURLToPath(new URL("..", import.meta.url));
const PIM_COMPUTER = path.resolve(HOST_DIR, "..", "pim-computer.ts");
const CUA_COMPUTER = path.join(HOST_DIR, "cua-computer.ts");

const tick = (ms = 20) => new Promise((resolve) => setTimeout(resolve, ms));

async function until(condition: () => boolean, what: string, ms = 5_000) {
	const deadline = Date.now() + ms;
	while (!condition()) {
		if (Date.now() > deadline) throw new Error(`Timed out waiting for ${what}.`);
		await tick(5);
	}
}

/** How long each cleanup may take before it is reported as not seen to finish. */
const CLEANUP_MS = 5_000;

const cleanups: (() => unknown)[] = [];
/** Cleanups in this file that threw or weren't seen to finish. */
let cleanupFailures = 0;
const messageOf = (error: unknown) => (error instanceof Error ? error.message : String(error));

/**
 * Every cleanup is tried, last registered first, even when an earlier one
 * throws or doesn't finish. Each failure is written as a diagnostic of the
 * test, then the hook fails with all of them. A test that already failed
 * keeps its own error: node:test may report only a test's first error, so
 * the diagnostics are what show its cleanup failures beside it, and the
 * file's `after` fails the run once more, counting them.
 */
afterEach(async (t) => {
	const failures: unknown[] = [];
	for (const cleanup of cleanups.splice(0).reverse()) {
		let timer: ReturnType<typeof setTimeout> | undefined;
		const bound = new Promise<never>((_, reject) => {
			timer = setTimeout(() => reject(new Error(`A cleanup wasn't seen to finish within ${CLEANUP_MS} ms; it may still be running.`)), CLEANUP_MS);
		});
		try {
			await Promise.race([Promise.resolve().then(cleanup), bound]);
		} catch (error) {
			failures.push(error);
		} finally {
			clearTimeout(timer);
		}
	}
	if (failures.length === 0) return;
	cleanupFailures += failures.length;
	for (const failure of failures) if ("diagnostic" in t) t.diagnostic(`cleanup failed or wasn't seen to finish: ${messageOf(failure)}`);
	throw new AggregateError(failures, `${failures.length} cleanup(s) failed or weren't seen to finish: ${failures.map(messageOf).join("; ")}`);
});
after(() => {
	if (cleanupFailures > 0) throw new Error(`${cleanupFailures} cleanup(s) in this file failed or weren't seen to finish; each test's diagnostics name them.`);
});

/** A folder for one test: the socket's directory (0700), a root, and a browser that is never run. */
function place() {
	const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "cua-desk-")));
	cleanups.push(() => fs.rmSync(dir, { recursive: true, force: true }));
	const root = path.join(dir, "root");
	fs.mkdirSync(root);
	const browser = path.join(dir, "browser");
	fs.writeFileSync(browser, "#!/bin/sh\nexit 1\n", { mode: 0o700 });
	return { dir, root, browser, socketPath: path.join(dir, "session.sock") };
}

/** A stand-in for pim-computer: what it was given on its input, and how the endpoint ended it. */
class FakeChild extends EventEmitter implements Child {
	readonly pid = 4242;
	readonly stdin = new PassThrough();
	readonly stdout = new PassThrough();
	readonly signals: string[] = [];
	input = "";
	inputEnded = false;

	constructor(options: { reads?: boolean } = {}) {
		super();
		if (options.reads !== false) {
			this.stdin.on("data", (chunk: Buffer) => {
				this.input += chunk.toString("utf8");
			});
		}
		this.stdin.on("end", () => {
			this.inputEnded = true;
		});
		this.stdin.on("finish", () => {
			this.inputEnded = true;
		});
	}

	say(line: string) {
		this.stdout.write(`${line}\n`);
	}

	kill(signal: "SIGTERM" | "SIGKILL") {
		this.signals.push(signal);
		return true;
	}

	exit() {
		this.stdout.end();
		this.emit("exit", 0, null);
	}
}

/** An endpoint whose children are made by `make` (a `FakeChild` that says hello at once, unless given). */
async function endpoint(
	options: { make?: () => FakeChild; limits?: Partial<EndpointLimits>; spawn?: Spawn; environment?: Record<string, string>; cua?: CuaChild; credentialFiles?: CredentialFiles } = {},
) {
	const where = place();
	const children: FakeChild[] = [];
	const calls: { command: string; args: readonly string[]; options: SpawnOptions }[] = [];
	const log: { event: string; reason?: string }[] = [];
	const spawn: Spawn =
		options.spawn ??
		((command, args, spawnOptions) => {
			calls.push({ command, args, options: spawnOptions });
			const child =
				options.make?.() ??
				(() => {
					const made = new FakeChild();
					made.say(HELLO);
					return made;
				})();
			children.push(child);
			return child;
		});
	const made = createDesktopEndpoint({
		socketPath: where.socketPath,
		root: where.root,
		browser: where.browser,
		pimComputer: PIM_COMPUTER,
		spawn,
		log: (entry) => log.push(entry),
		...(options.limits ? { limits: options.limits } : {}),
		...(options.environment ? { environment: options.environment } : {}),
		...(options.cua ? { cua: options.cua } : {}),
		...(options.credentialFiles ? { credentialFiles: options.credentialFiles } : {}),
	});
	await made.listen();
	cleanups.push(async () => {
		for (const child of children) child.exit();
		await made.close();
	});
	return { ...where, endpoint: made, children, calls, log };
}

/** A session's events as the relay would see them. */
function events() {
	const seen = { messages: [] as string[], closed: 0 };
	const given: SessionEvents = { message: (message) => seen.messages.push(message), closed: () => seen.closed++ };
	return { seen, given };
}

async function settle<T>(promise: Promise<T>): Promise<{ ok: true; value: T } | { ok: false; error: Error }> {
	try {
		return { ok: true, value: await promise };
	} catch (error) {
		return { ok: false, error: error as Error };
	}
}

describe("starting the Cua computer", () => {
	const OWNER = "o_cua-space";
	const ORIGIN = "https://spacesd.test:7443";
	const CREDENTIAL = "/etc/pim-cua/spacesd.token";
	const UID = process.geteuid!();
	const cua: CuaChild = { program: CUA_COMPUTER, owner: OWNER, origin: ORIGIN, credentialFile: CREDENTIAL };

	/**
	 * A stand-in for the credential file at `CREDENTIAL`, and nowhere else:
	 * each descriptor opened, which are open now, each close tried, and each
	 * closed. With `closeFails`, a close throws before it records or releases
	 * anything, so the descriptor stays open. It has no way to be read, as the
	 * endpoint has none.
	 */
	function credentials() {
		const state = {
			stat: { isFile: () => true, uid: UID, mode: 0o100600, nlink: 1, size: 65 } as CredentialStat,
			real: (file: string): string => {
				if (file !== CREDENTIAL) throw Object.assign(new Error("ENOENT"), { code: "ENOENT" });
				return file;
			},
			openFails: false,
			closeFails: false,
			opened: [] as { file: string; flags: number; fd: number }[],
			open: new Set<number>(),
			tried: [] as number[],
			closed: [] as number[],
		};
		let next = 40;
		const files: CredentialFiles = {
			realpath: (file) => state.real(file),
			open: (file, flags) => {
				if (state.openFails) throw Object.assign(new Error("ELOOP"), { code: "ELOOP" });
				const fd = next++;
				state.opened.push({ file, flags, fd });
				state.open.add(fd);
				return fd;
			},
			fstat: (fd) => {
				if (!state.open.has(fd)) throw Object.assign(new Error("EBADF"), { code: "EBADF" });
				return state.stat;
			},
			close: (fd) => {
				state.tried.push(fd);
				if (state.closeFails) throw Object.assign(new Error("EIO"), { code: "EIO" });
				if (!state.open.delete(fd)) throw Object.assign(new Error("EBADF"), { code: "EBADF" });
				state.closed.push(fd);
			},
		};
		return { state, files };
	}
	type State = ReturnType<typeof credentials>["state"];

	it("starts pim-computer as before, and opens no credential, when it isn't given", async () => {
		const unused: CredentialFiles = {
			realpath: () => assert.fail("nothing is looked up"),
			open: () => assert.fail("nothing is opened"),
			fstat: () => assert.fail("nothing is checked"),
			close: () => assert.fail("nothing is closed"),
		};
		const served = await endpoint({ credentialFiles: unused, environment: { HOME: "/home/desktop", PATH: "/usr/bin" } });
		const session = await unixSession({ socketPath: served.socketPath })(events().given, new AbortController().signal);
		assert.deepEqual(served.calls, [
			{
				command: process.execPath,
				args: [PIM_COMPUTER, "--stdio", "--root", served.root, "--chrome", served.browser],
				options: { cwd: served.root, env: { HOME: "/home/desktop", PATH: "/usr/bin" }, stdio: ["pipe", "pipe", "ignore"], shell: false },
			},
		]);
		session.close();
	});

	it("starts it in pim-computer's place with fixed arguments and the credential as descriptor 3 only, which the endpoint never reads and closes once the spawn returns", async () => {
		const { state, files } = credentials();
		const openAtSpawn: number[][] = [];
		const served = await endpoint({
			cua,
			credentialFiles: files,
			environment: { HOME: "/home/desktop", PATH: "/usr/bin", DISPLAY: ":0", SPACESD_TOKEN: "spacesd-env-secret", PIM_COMPUTER_TOKEN: "pimc_x" },
			make: () => {
				openAtSpawn.push([...state.open]);
				const child = new FakeChild();
				child.say(HELLO);
				return child;
			},
		});
		// Checked once as the endpoint is made, and closed.
		assert.equal(state.opened.length, 1);
		assert.deepEqual(state.closed, [state.opened[0]!.fd]);

		const { seen, given } = events();
		const session = await unixSession({ socketPath: served.socketPath })(given, new AbortController().signal);
		assert.deepEqual(seen.messages, [HELLO]);
		assert.equal(state.opened.length, 2, "opened again for the child");
		const fd = state.opened[1]!.fd;
		assert.deepEqual(served.calls, [
			{
				command: process.execPath,
				args: [CUA_COMPUTER, "--root", served.root, "--chrome", served.browser, "--owner", OWNER, "--origin", ORIGIN],
				options: { cwd: served.root, env: { HOME: "/home/desktop", PATH: "/usr/bin", DISPLAY: ":0" }, stdio: ["pipe", "pipe", "ignore", fd], shell: false },
			},
		]);
		assert.deepEqual(openAtSpawn, [[fd]], "the child is handed an open descriptor");
		assert.deepEqual(state.closed, [state.opened[0]!.fd, fd], "and the endpoint keeps none");
		assert.equal(state.open.size, 0);
		for (const { file, flags } of state.opened) {
			assert.equal(file, CREDENTIAL);
			assert.equal(flags & (fs.constants.O_WRONLY | fs.constants.O_RDWR), 0, "read-only");
			assert.notEqual(flags & fs.constants.O_NOFOLLOW, 0, "no link at the last step");
		}
		assert.ok(!JSON.stringify(served.log).includes(CREDENTIAL), "the log doesn't name the credential");
		session.close();
	});

	it("refuses to start with an unsafe Cua program, owner, origin or credential file, and leaves nothing open", () => {
		const where = place();
		const writable = path.join(where.dir, "writable.ts");
		fs.writeFileSync(writable, "");
		fs.chmodSync(writable, 0o666);
		const stat = (change: Partial<CredentialStat>) => (state: State) => {
			state.stat = { ...state.stat, ...change };
		};
		const cases: { name: string; change?: Partial<CuaChild>; files?: (state: State) => void; reason: string }[] = [
			{ name: "a Cua program others can write", change: { program: writable }, reason: "cua-computer" },
			{ name: "a Cua program that isn't there", change: { program: path.join(where.dir, "missing.ts") }, reason: "cua-computer" },
			{ name: "an empty owner", change: { owner: "" }, reason: "cua-owner" },
			{ name: "an owner with a space", change: { owner: "o_cua space" }, reason: "cua-owner" },
			{ name: "an owner with a newline", change: { owner: "o_cua\n" }, reason: "cua-owner" },
			{ name: "an owner too long", change: { owner: "o".repeat(257) }, reason: "cua-owner" },
			{ name: "an origin with a slash after it", change: { origin: `${ORIGIN}/` }, reason: "cua-origin" },
			{ name: "an origin with a path", change: { origin: `${ORIGIN}/mcp` }, reason: "cua-origin" },
			{ name: "an origin with credentials", change: { origin: "https://ada:pw@spacesd.test:7443" }, reason: "cua-origin" },
			{ name: "plain HTTP off loopback", change: { origin: "http://spacesd.test:7443" }, reason: "cua-origin" },
			{ name: "no scheme", change: { origin: "spacesd.test:7443" }, reason: "cua-origin" },
			{ name: "a file URL", change: { origin: "file:///etc/pim-cua" }, reason: "cua-origin" },
			{ name: "a relative credential path", change: { credentialFile: "spacesd.token" }, reason: "credential" },
			{ name: "a credential path that isn't normalized", change: { credentialFile: "/etc/pim-cua/../pim-cua/spacesd.token" }, reason: "credential" },
			{ name: "a credential path with a link on it", files: (state) => (state.real = () => "/home/desktop/elsewhere"), reason: "credential" },
			{ name: "a credential that isn't there", files: (state) => (state.real = () => assert.fail("ENOENT")), reason: "credential" },
			{ name: "a credential that won't open (a link at the last step)", files: (state) => (state.openFails = true), reason: "credential" },
			{ name: "a credential that isn't a file", files: stat({ isFile: () => false }), reason: "credential" },
			{ name: "a credential its group can read", files: stat({ mode: 0o100640 }), reason: "credential" },
			{ name: "a credential others can read", files: stat({ mode: 0o100644 }), reason: "credential" },
			{ name: "a read-only credential, 0400", files: stat({ mode: 0o100400 }), reason: "credential" },
			{ name: "a set-user-ID credential", files: stat({ mode: 0o104600 }), reason: "credential" },
			{ name: "another user's credential", files: stat({ uid: UID + 1 }), reason: "credential" },
			{ name: "a credential with two names", files: stat({ nlink: 2 }), reason: "credential" },
			{ name: "an empty credential", files: stat({ size: 0 }), reason: "credential" },
			{ name: "a credential larger than a token", files: stat({ size: MAX_CREDENTIAL_BYTES + 1 }), reason: "credential" },
		];
		for (const { name, change, files: alter, reason } of cases) {
			const { state, files } = credentials();
			alter?.(state);
			assert.throws(
				() =>
					createDesktopEndpoint({
						socketPath: where.socketPath,
						root: where.root,
						browser: where.browser,
						pimComputer: PIM_COMPUTER,
						cua: { ...cua, ...change },
						credentialFiles: files,
						spawn: () => assert.fail("nothing starts"),
					}),
				(error: unknown) => error instanceof EndpointRefused && error.reason === reason,
				name,
			);
			assert.equal(state.open.size, 0, `${name}: nothing is left open`);
			assert.equal(state.closed.length, state.opened.length, name);
		}
		assert.equal(fs.existsSync(where.socketPath), false);
	});

	it("refuses a connection, starting nothing, when the credential no longer passes as its child would start, and closes it when the spawn throws", async () => {
		const first = credentials();
		const served = await endpoint({ cua, credentialFiles: first.files });
		first.state.stat = { ...first.state.stat, mode: 0o100644 };
		assert.equal((await settle(unixSession({ socketPath: served.socketPath })(events().given, new AbortController().signal))).ok, false);
		assert.equal(served.calls.length, 0);
		assert.ok(served.log.some((entry) => entry.event === "endpoint.refused" && entry.reason === "credential"));
		assert.equal(first.state.opened.length, 2);
		assert.equal(first.state.open.size, 0);
		// Once it passes again, the next connection starts it.
		first.state.stat = { ...first.state.stat, mode: 0o100600 };
		const session = await unixSession({ socketPath: served.socketPath })(events().given, new AbortController().signal);
		assert.equal(served.calls.length, 1);
		assert.equal(first.state.open.size, 0);
		session.close();

		const second = credentials();
		const handed: SpawnOptions["stdio"][] = [];
		const openAtSpawn: number[] = [];
		const failing = await endpoint({
			cua,
			credentialFiles: second.files,
			spawn: (_command, _args, options) => {
				handed.push(options.stdio);
				openAtSpawn.push(second.state.open.size);
				throw new Error("EAGAIN");
			},
		});
		assert.equal((await settle(unixSession({ socketPath: failing.socketPath })(events().given, new AbortController().signal))).ok, false);
		assert.deepEqual(handed, [["pipe", "pipe", "ignore", second.state.opened[1]!.fd]]);
		assert.deepEqual(openAtSpawn, [1]);
		assert.equal(second.state.open.size, 0, "closed though nothing started");
		assert.ok(failing.log.some((entry) => entry.event === "endpoint.refused" && entry.reason === "spawn"));
	});

	it("starts no other Cua computer, and opens no credential, until the one before is seen to exit, after a failed start or SIGTERM and SIGKILL", async () => {
		const { state, files } = credentials();
		let speaks = false;
		const served = await endpoint({
			cua,
			credentialFiles: files,
			limits: { exitMs: 50, closeMs: 50 },
			make: () => {
				const child = new FakeChild();
				if (speaks) child.say(HELLO);
				return child;
			},
		});
		// A Cua computer that refuses to start (its credential, say) says nothing and exits 1.
		const refusing = unixSession({ socketPath: served.socketPath })(events().given, new AbortController().signal);
		await until(() => served.children.length === 1, "the first to start");
		const failed = served.children[0]!;
		failed.stdout.end();
		failed.emit("exit", 1, null);
		assert.equal((await settle(refusing)).ok, false);
		await until(() => served.log.some((entry) => entry.event === "endpoint.exited"), "its exit to be seen");

		speaks = true;
		const session = await unixSession({ socketPath: served.socketPath })(events().given, new AbortController().signal);
		assert.equal(served.calls.length, 2);
		assert.equal(state.opened.length, 3, "once as the endpoint was made, once for each child");
		session.close();
		const child = served.children[1]!;
		await until(() => child.signals.length === 2, "SIGTERM and SIGKILL");
		assert.deepEqual(child.signals, ["SIGTERM", "SIGKILL"]);

		// A signal is not an exit: refused, with no credential opened and nothing started.
		assert.equal((await settle(unixSession({ socketPath: served.socketPath })(events().given, new AbortController().signal))).ok, false);
		assert.ok(served.log.some((entry) => entry.event === "endpoint.refused" && entry.reason === "busy"));
		await tick(150);
		assert.equal(served.calls.length, 2);
		assert.equal(state.opened.length, 3);
		assert.deepEqual(child.signals, ["SIGTERM", "SIGKILL"], "nothing more is signalled");

		child.exit();
		const next = await unixSession({ socketPath: served.socketPath })(events().given, new AbortController().signal);
		assert.equal(served.calls.length, 3);
		assert.equal(state.opened.length, 4);
		assert.equal(state.open.size, 0);
		next.close();
	});

	it("refuses to start, apart from a refused file, when the credential it checked can't be closed, and doesn't close it again", () => {
		const where = place();
		const make = (files: CredentialFiles) => () =>
			createDesktopEndpoint({
				socketPath: where.socketPath,
				root: where.root,
				browser: where.browser,
				pimComputer: PIM_COMPUTER,
				cua,
				credentialFiles: files,
				spawn: () => assert.fail("nothing starts"),
			});
		const reason = (expected: string) => (error: unknown) => error instanceof EndpointRefused && error.reason === expected;

		// A good file whose close throws.
		const good = credentials();
		good.state.closeFails = true;
		assert.throws(make(good.files), reason("credential-close"));
		assert.deepEqual(good.state.tried, [good.state.opened[0]!.fd], "tried once");
		assert.deepEqual([...good.state.open], [good.state.opened[0]!.fd], "and, as far as anyone knows, still open");

		// A refused file whose close throws is that, not merely refused.
		const refused = credentials();
		refused.state.stat = { ...refused.state.stat, mode: 0o100644 };
		refused.state.closeFails = true;
		assert.throws(make(refused.files), reason("credential-close"));
		assert.equal(refused.state.tried.length, 1);

		// A refused file closed as it should be, and a file never opened, are only refused.
		const closed = credentials();
		closed.state.stat = { ...closed.state.stat, mode: 0o100644 };
		assert.throws(make(closed.files), reason("credential"));
		assert.equal(closed.state.open.size, 0);
		const unopened = credentials();
		unopened.state.openFails = true;
		unopened.state.closeFails = true;
		assert.throws(make(unopened.files), reason("credential"));
		assert.deepEqual(unopened.state.tried, [], "nothing to close");
		assert.equal(fs.existsSync(where.socketPath), false);
	});

	it("takes nothing more once it can't close the credential it handed a child, and ends and watches that child to its exit", async () => {
		const { state, files } = credentials();
		const served = await endpoint({ cua, credentialFiles: files, limits: { exitMs: 50, closeMs: 50 } });
		state.closeFails = true;
		// The child is started, then the endpoint's copy can't be closed: the session never opens.
		assert.equal((await settle(unixSession({ socketPath: served.socketPath })(events().given, new AbortController().signal))).ok, false);
		assert.equal(served.calls.length, 1);
		const fd = state.opened[1]!.fd;
		assert.deepEqual(served.calls[0]!.options.stdio, ["pipe", "pipe", "ignore", fd]);
		assert.deepEqual(state.tried, [state.opened[0]!.fd, fd], "its close was tried once");
		assert.ok(state.open.has(fd), "and it may still be open");
		assert.ok(served.log.some((entry) => entry.event === "endpoint.refused" && entry.reason === "credential-close"));

		// The child is tracked as any other: its input ends, then SIGTERM, then SIGKILL; its input got nothing.
		const child = served.children[0]!;
		await until(() => child.inputEnded, "its input to end");
		await until(() => child.signals.length === 2, "SIGTERM and SIGKILL");
		assert.deepEqual(child.signals, ["SIGTERM", "SIGKILL"]);
		assert.equal(child.input, "");

		// Refused, opening and starting nothing, both before its exit is seen and after.
		const opened = state.opened.length;
		assert.equal((await settle(unixSession({ socketPath: served.socketPath })(events().given, new AbortController().signal))).ok, false);
		let stopped = false;
		const stopping = served.endpoint.close().then(() => {
			stopped = true;
		});
		await tick(150);
		assert.equal(stopped, false, "closing the endpoint waits for the child's exit");
		assert.ok(!served.log.some((entry) => entry.event === "endpoint.exited"));
		child.exit();
		await stopping;
		assert.ok(served.log.some((entry) => entry.event === "endpoint.exited"));
		assert.equal(served.calls.length, 1);
		assert.equal(state.opened.length, opened);
		assert.deepEqual(state.tried, [state.opened[0]!.fd, fd], "never closed again");
		assert.equal(served.log.filter((entry) => entry.event === "endpoint.refused" && entry.reason === "busy").length, 0, "refused for the credential, not as busy");
	});

	it("takes nothing more once a file refused as its child would start can't be closed, or once the spawn throws and it can't be closed", async () => {
		const first = credentials();
		const served = await endpoint({ cua, credentialFiles: first.files });
		first.state.stat = { ...first.state.stat, mode: 0o100644 };
		first.state.closeFails = true;
		assert.equal((await settle(unixSession({ socketPath: served.socketPath })(events().given, new AbortController().signal))).ok, false);
		assert.equal(served.calls.length, 0);
		// It passes again, and closes again, but the descriptor that wasn't closed is still held: refused, nothing opened.
		first.state.stat = { ...first.state.stat, mode: 0o100600 };
		first.state.closeFails = false;
		const opened = first.state.opened.length;
		assert.equal((await settle(unixSession({ socketPath: served.socketPath })(events().given, new AbortController().signal))).ok, false);
		assert.equal(served.calls.length, 0);
		assert.equal(first.state.opened.length, opened);
		assert.deepEqual(
			served.log.filter((entry) => entry.event === "endpoint.refused").map((entry) => entry.reason),
			["credential-close", "credential-close"],
		);

		const second = credentials();
		const failing = await endpoint({ cua, credentialFiles: second.files, spawn: () => assert.fail("EAGAIN") });
		second.state.closeFails = true;
		assert.equal((await settle(unixSession({ socketPath: failing.socketPath })(events().given, new AbortController().signal))).ok, false);
		const reasons = () => failing.log.filter((entry) => entry.event === "endpoint.refused").map((entry) => entry.reason);
		assert.deepEqual(reasons(), ["credential-close", "spawn"]);
		second.state.closeFails = false;
		const before = second.state.opened.length;
		assert.equal((await settle(unixSession({ socketPath: failing.socketPath })(events().given, new AbortController().signal))).ok, false);
		assert.deepEqual(reasons(), ["credential-close", "spawn", "credential-close"]);
		assert.equal(second.state.opened.length, before);
		assert.equal(second.state.tried.length, 2, "once at the start, once after the spawn: never again");
	});
});
