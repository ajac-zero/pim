/**
 * The bridge's Unix-socket sessions (../session.ts) and the desktop session
 * endpoint (../desktop.ts), over real Unix sockets in a folder made for each
 * test. What stands in: pim-computer, which is a test's in-memory child or a
 * small Node script that speaks lines on its input and output, except in the
 * last test, where the bridge and endpoint programs run as processes and the
 * endpoint starts the real pim-computer.ts for one `stat`. No shell or
 * browser command runs, and nothing leaves this machine. Where the endpoint
 * starts the Cua computer, its credential file is a stand-in for `fs` that
 * records what was opened and closed; no credential file exists, and no Cua
 * computer process runs.
 *
 *   pnpm --filter pim-cua-host test
 */

import assert from "node:assert/strict";
import { type ChildProcess, execFileSync, spawn as spawnProcess } from "node:child_process";
import { EventEmitter } from "node:events";
import * as fs from "node:fs";
import * as net from "node:net";
import * as os from "node:os";
import * as path from "node:path";
import { PassThrough } from "node:stream";
import { afterEach, describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { WebSocket } from "ws";
import { MAX_MESSAGE_CHARS, type SessionEvents, SPACE_HEADER } from "../../cua-bridge.ts";
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

const cleanups: (() => unknown)[] = [];
afterEach(async () => {
	for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
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

describe("the desktop endpoint's settings", () => {
	it("refuses to run as root", () => {
		const where = place();
		assert.throws(() => createDesktopEndpoint({ ...where, pimComputer: PIM_COMPUTER, uid: 0 }), /root/);
		assert.equal(fs.existsSync(where.socketPath), false);
	});

	it("refuses unsafe socket paths, directories, roots and programs, and creates nothing", () => {
		const where = place();
		const base = { socketPath: where.socketPath, root: where.root, browser: where.browser, pimComputer: PIM_COMPUTER };
		const open = path.join(where.dir, "open");
		fs.mkdirSync(open, { mode: 0o755 });
		fs.chmodSync(open, 0o755);
		const groupWritable = path.join(where.dir, "group");
		fs.mkdirSync(groupWritable);
		fs.chmodSync(groupWritable, 0o770);
		const linked = path.join(where.dir, "linked");
		fs.symlinkSync(where.dir, linked);
		const linkedRoot = path.join(where.dir, "root-link");
		fs.symlinkSync(where.root, linkedRoot);
		const file = path.join(where.dir, "file");
		fs.writeFileSync(file, "");
		const writableProgram = path.join(where.dir, "writable.ts");
		fs.writeFileSync(writableProgram, "");
		fs.chmodSync(writableProgram, 0o666);
		const notRunnable = path.join(where.dir, "not-runnable");
		fs.writeFileSync(notRunnable, "", { mode: 0o600 });
		const browserLink = path.join(where.dir, "browser-link");
		fs.symlinkSync(where.browser, browserLink);
		const cases: [string, Partial<typeof base>][] = [
			["a relative socket path", { socketPath: "session.sock" }],
			["a socket path that isn't normalized", { socketPath: `${where.dir}/x/../session.sock` }],
			["a socket path too long for a Unix socket", { socketPath: `${where.dir}/${"s".repeat(120)}.sock` }],
			["an abstract socket", { socketPath: "\0pim-session" }],
			["a socket directory others can reach", { socketPath: path.join(open, "session.sock") }],
			["a socket directory its group can write", { socketPath: path.join(groupWritable, "session.sock") }],
			["a socket directory reached through a link", { socketPath: path.join(linked, "session.sock") }],
			["a socket directory that isn't there", { socketPath: path.join(where.dir, "missing", "session.sock") }],
			["a root that isn't there", { root: path.join(where.dir, "missing") }],
			["a root reached through a link", { root: linkedRoot }],
			["a root that is a file", { root: file }],
			["a relative root", { root: "root" }],
			["a pim-computer others can write", { pimComputer: writableProgram }],
			["a pim-computer that isn't there", { pimComputer: path.join(where.dir, "missing.ts") }],
			["a browser that can't be run", { browser: notRunnable }],
			["a browser reached through a link", { browser: browserLink }],
		];
		for (const [name, change] of cases) {
			assert.throws(() => createDesktopEndpoint({ ...base, ...change, spawn: () => assert.fail("nothing starts") }), Error, name);
		}
		assert.deepEqual(fs.readdirSync(open), []);
		assert.equal(fs.existsSync(where.socketPath), false);
	});

	it("listens on a socket of mode 0660 in its directory's group, and removes it when it stops", async () => {
		const served = await endpoint();
		const stat = fs.lstatSync(served.socketPath);
		assert.ok(stat.isSocket());
		assert.equal(stat.mode & 0o777, 0o660);
		assert.equal(stat.uid, process.geteuid!());
		assert.equal(stat.gid, fs.statSync(served.dir).gid);
		await served.endpoint.close();
		assert.equal(fs.existsSync(served.socketPath), false);
	});

	it("leaves a file, a link, a socket left behind, or a listening socket at its path as it is, and refuses to start", async () => {
		const where = place();
		const base = { socketPath: where.socketPath, root: where.root, browser: where.browser, pimComputer: PIM_COMPUTER, log: () => {}, spawn: () => assert.fail("nothing starts") };
		fs.writeFileSync(where.socketPath, "keep me");
		await assert.rejects(createDesktopEndpoint(base).listen(), /left as it is/);
		assert.equal(fs.readFileSync(where.socketPath, "utf8"), "keep me");
		fs.rmSync(where.socketPath);
		const target = path.join(where.dir, "target");
		fs.writeFileSync(target, "target");
		fs.symlinkSync(target, where.socketPath);
		await assert.rejects(createDesktopEndpoint(base).listen(), /left as it is/);
		assert.equal(fs.readlinkSync(where.socketPath), target);
		fs.rmSync(where.socketPath);
		// A listener that is killed, so its socket stays behind with nothing listening.
		const holder = spawnProcess(process.execPath, ["-e", "require('net').createServer().listen(process.argv[1], () => process.stdout.write('up'))", where.socketPath], { stdio: ["ignore", "pipe", "ignore"] });
		await new Promise((resolve) => holder.stdout!.once("data", resolve));
		holder.kill("SIGKILL");
		await new Promise((resolve) => holder.once("exit", resolve));
		const left = fs.lstatSync(where.socketPath);
		await assert.rejects(createDesktopEndpoint(base).listen(), /left as it is/);
		assert.equal(fs.lstatSync(where.socketPath).ino, left.ino);

		const first = await endpoint();
		await assert.rejects(createDesktopEndpoint({ ...base, socketPath: first.socketPath, root: first.root, browser: first.browser }).listen(), /left as it is/);
		assert.equal(first.calls.length, 0, "refusing connected to nothing");
		const { seen, given } = events();
		const session = await unixSession({ socketPath: first.socketPath })(given, new AbortController().signal);
		assert.deepEqual(seen.messages, [HELLO], "the first endpoint still serves");
		session.close();
	});
});

describe("starting pim-computer", () => {
	it("starts the operator's pim-computer with fixed arguments, folder and environment, no shell, and its standard error discarded", async () => {
		const served = await endpoint({ environment: { HOME: "/home/desktop", PATH: "/usr/bin", PIM_BRIDGE_TOKEN_FILE: "/etc/pim-bridge/token", PIM_COMPUTER_TOKEN: "pimc_x", NODE_OPTIONS: "--require /tmp/x.js", DISPLAY: ":0" } });
		const { seen, given } = events();
		const session = await unixSession({ socketPath: served.socketPath })(given, new AbortController().signal);
		// What arrives on the socket is input, and changes nothing about what was started.
		session.send('{"type":"call","id":"1","op":"exec","args":{"command":"x"}} --root /etc');
		await until(() => served.children[0]!.input.length > 0, "the input");
		assert.deepEqual(served.calls, [
			{
				command: process.execPath,
				args: [PIM_COMPUTER, "--stdio", "--root", served.root, "--chrome", served.browser],
				options: { cwd: served.root, env: { HOME: "/home/desktop", PATH: "/usr/bin", DISPLAY: ":0" }, stdio: ["pipe", "pipe", "ignore"], shell: false },
			},
		]);
		assert.equal(served.children[0]!.input, '{"type":"call","id":"1","op":"exec","args":{"command":"x"}} --root /etc\n');
		assert.deepEqual(seen.messages, [HELLO]);
		session.close();
	});

	it("passes on only what a real child writes to its output, never its standard error", async () => {
		// A small Node script in place of pim-computer, started with the options the endpoint chose.
		const fixture = [
			"process.stderr.write('stderr-private ' + 'x'.repeat(100) + '\\n');",
			`process.stdout.write(${JSON.stringify(`${HELLO}\n`)});`,
			"require('readline').createInterface({ input: process.stdin }).on('line', (line) => {",
			"  process.stderr.write('stderr-private ' + line + '\\n');",
			"  process.stdout.write(JSON.stringify({ type: 'reply', id: JSON.parse(line).id, result: line.length }) + '\\n');",
			"}).on('close', () => process.exit(0));",
		].join("\n");
		const started: ChildProcess[] = [];
		const served = await endpoint({
			spawn: (_command, _args, options) => {
				const child = spawnProcess(process.execPath, ["-e", fixture], options);
				started.push(child);
				return child as ChildProcess & Child;
			},
		});
		const { seen, given } = events();
		const session = await unixSession({ socketPath: served.socketPath })(given, new AbortController().signal);
		const call = JSON.stringify({ type: "call", id: "a" });
		session.send(call);
		await until(() => seen.messages.length === 2, "the reply");
		assert.deepEqual(seen.messages, [HELLO, JSON.stringify({ type: "reply", id: "a", result: call.length })]);
		assert.equal(started[0]!.stderr, null, "its standard error goes nowhere");
		session.close();
		await until(() => served.log.some((entry) => entry.event === "endpoint.exited"), "the child to exit");
		assert.equal(started[0]!.exitCode, 0);
		assert.ok(!JSON.stringify(served.log).includes("stderr-private"));
		assert.equal(seen.closed, 0, "closing tells the relay nothing");
	});
});

describe("starting the Cua computer", () => {
	const OWNER = "o_cua-space";
	const ORIGIN = "https://spacesd.test:7443";
	const CREDENTIAL = "/etc/pim-cua/spacesd.token";
	const UID = process.geteuid!();
	const cua: CuaChild = { program: CUA_COMPUTER, owner: OWNER, origin: ORIGIN, credentialFile: CREDENTIAL };

	/**
	 * A stand-in for the credential file at `CREDENTIAL`, and nowhere else:
	 * each descriptor opened, which are open now, and each closed. It has no
	 * way to be read, as the endpoint has none.
	 */
	function credentials() {
		const state = {
			stat: { isFile: () => true, uid: UID, mode: 0o100600, nlink: 1, size: 65 } as CredentialStat,
			real: (file: string): string => {
				if (file !== CREDENTIAL) throw Object.assign(new Error("ENOENT"), { code: "ENOENT" });
				return file;
			},
			openFails: false,
			opened: [] as { file: string; flags: number; fd: number }[],
			open: new Set<number>(),
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
});

describe("a session over the endpoint's socket", () => {
	it("opens on pim-computer's hello, carries a call and its reply once each, and ends its input when closed", async () => {
		const served = await endpoint({
			make: () => {
				const child = new FakeChild();
				child.say(HELLO);
				child.stdin.on("data", (chunk: Buffer) => {
					for (const line of chunk.toString("utf8").split("\n").filter(Boolean)) child.say(JSON.stringify({ type: "reply", id: JSON.parse(line).id, result: "ok" }));
				});
				return child;
			},
		});
		const { seen, given } = events();
		const session = await unixSession({ socketPath: served.socketPath })(given, new AbortController().signal);
		assert.deepEqual(seen.messages, [HELLO]);
		const call = JSON.stringify({ type: "call", id: "7", op: "stat", args: { path: "/workspace" } });
		session.send(call);
		await until(() => seen.messages.length === 2, "the reply");
		assert.deepEqual(JSON.parse(seen.messages[1]!), { type: "reply", id: "7", result: "ok" });
		assert.equal(served.children[0]!.input, `${call}\n`);
		session.close();
		session.close();
		await until(() => served.children[0]!.inputEnded, "pim-computer's input to end");
		served.children[0]!.say(JSON.stringify({ type: "reply", id: "late" }));
		await tick(50);
		assert.equal(seen.messages.length, 2, "nothing reaches the relay after it closed the session");
		assert.equal(seen.closed, 0);
		assert.throws(() => session.send(call), /ended/);
		assert.equal(served.children[0]!.input, `${call}\n`, "nothing is sent again");
	});

	it("connects to nothing when given up before it is asked for", async () => {
		const served = await endpoint();
		const stop = new AbortController();
		stop.abort();
		const { seen, given } = events();
		assert.equal((await settle(unixSession({ socketPath: served.socketPath })(given, stop.signal))).ok, false);
		await tick(50);
		assert.equal(served.calls.length, 0);
		assert.deepEqual(seen, { messages: [], closed: 0 });
	});

	it("fails, and ends pim-computer's input, when given up while connecting or before pim-computer speaks; what it says late goes nowhere", async () => {
		const served = await endpoint({ make: () => new FakeChild() });
		// Given up in the same turn as it connects.
		const early = new AbortController();
		const first = events();
		const connecting = unixSession({ socketPath: served.socketPath })(first.given, early.signal);
		early.abort();
		assert.equal((await settle(connecting)).ok, false);

		// The endpoint may or may not have taken that connection; if it did, its pim-computer's input ends, and it is made to exit.
		await tick(100);
		await until(() => served.children.every((child) => child.inputEnded), "any child's input to end");
		for (const child of served.children) child.exit();
		await until(() => served.log.filter((entry) => entry.event === "endpoint.exited").length === served.children.length, "any child to exit");

		// Given up while pim-computer hasn't said its hello.
		const later = new AbortController();
		const second = events();
		const waiting = unixSession({ socketPath: served.socketPath })(second.given, later.signal);
		await until(() => served.children.some((child) => !child.inputEnded), "pim-computer to start");
		const child = served.children.at(-1)!;
		later.abort();
		assert.equal((await settle(waiting)).ok, false);
		await until(() => child.inputEnded, "its input to end");
		child.say(HELLO);
		await tick(50);
		assert.deepEqual(first.seen, { messages: [], closed: 0 });
		assert.deepEqual(second.seen, { messages: [], closed: 0 });
	});

	it("fails when no endpoint listens, when the path isn't a socket, or when pim-computer can't be started", async () => {
		const where = place();
		const { given } = events();
		const signal = new AbortController().signal;
		assert.equal((await settle(unixSession({ socketPath: where.socketPath })(given, signal))).ok, false);
		fs.writeFileSync(where.socketPath, "");
		assert.equal((await settle(unixSession({ socketPath: where.socketPath })(given, signal))).ok, false);
		assert.throws(() => unixSession({ socketPath: "relative.sock" }), /absolute/);

		const served = await endpoint({ spawn: () => assert.fail("can't start") });
		const failed = await settle(unixSession({ socketPath: served.socketPath })(given, signal));
		assert.equal(failed.ok, false);
		assert.ok(served.log.some((entry) => entry.reason === "spawn"));
	});

	it("tells the relay once that it closed when pim-computer exits, and takes nothing after", async () => {
		const served = await endpoint();
		const { seen, given } = events();
		const session = await unixSession({ socketPath: served.socketPath })(given, new AbortController().signal);
		served.children[0]!.exit();
		await until(() => seen.closed === 1, "the session to end");
		assert.throws(() => session.send("{}"), /ended/);
		session.close();
		await tick(50);
		assert.equal(seen.closed, 1);
	});

	it("refuses a new session until the pim-computer before has exited, and replays nothing to the next", async () => {
		const served = await endpoint();
		const first = events();
		const one = await unixSession({ socketPath: served.socketPath })(first.given, new AbortController().signal);
		one.send('{"type":"call","id":"1"}');
		await until(() => served.children[0]!.input !== "", "the first call");
		one.close();
		await until(() => served.children[0]!.inputEnded, "its input to end");

		const second = events();
		const refused = await settle(unixSession({ socketPath: served.socketPath })(second.given, new AbortController().signal));
		assert.equal(refused.ok, false);
		assert.equal(served.calls.length, 1, "nothing more was started");
		assert.ok(served.log.some((entry) => entry.event === "endpoint.refused" && entry.reason === "busy"));

		served.children[0]!.exit();
		await until(() => served.log.some((entry) => entry.event === "endpoint.exited"), "the first to exit");
		const third = events();
		const three = await unixSession({ socketPath: served.socketPath })(third.given, new AbortController().signal);
		assert.equal(served.calls.length, 2);
		await tick(50);
		assert.equal(served.children[1]!.input, "", "nothing of the first session reaches the next");
		assert.deepEqual(third.seen.messages, [HELLO]);
		three.close();
	});

	it("asks a pim-computer that doesn't exit after its input ended to, then ends it, and only then takes another session", async () => {
		const served = await endpoint({ limits: { exitMs: 100, closeMs: 100 } });
		const { given } = events();
		const session = await unixSession({ socketPath: served.socketPath })(given, new AbortController().signal);
		session.close();
		const child = served.children[0]!;
		await until(() => child.signals.length === 2, "SIGTERM and SIGKILL");
		assert.deepEqual(child.signals, ["SIGTERM", "SIGKILL"]);
		assert.equal((await settle(unixSession({ socketPath: served.socketPath })(events().given, new AbortController().signal))).ok, false);
		child.exit();
		const next = await unixSession({ socketPath: served.socketPath })(events().given, new AbortController().signal);
		assert.equal(served.calls.length, 2);
		next.close();
	});

	it("throws rather than hold more than its limit for an endpoint that doesn't read, empty messages too, and keeps taking them from one that does", async () => {
		for (const [message, count] of [["x".repeat(64 * 1024), 64], ["", 5_000]] as const) {
			for (const reads of [false, true]) {
				const served = await endpoint({
					limits: { closeMs: 100 },
					make: () => {
						const child = new FakeChild({ reads });
						child.say(HELLO);
						return child;
					},
				});
				const { seen, given } = events();
				const session = await unixSession({ socketPath: served.socketPath, maxQueuedBytes: 256 * 1024, closeMs: 100 })(given, new AbortController().signal);
				// One message a turn, so what the socket hands on is counted out as it goes.
				let taken = 0;
				for (; taken < (reads ? count : 1_000_000); taken++) {
					try {
						session.send(message);
					} catch {
						break;
					}
					await new Promise((resolve) => setImmediate(resolve));
				}
				if (reads) {
					assert.equal(taken, count, `all ${count} messages of ${message.length} characters are taken by an endpoint that reads`);
					await until(() => served.children[0]!.input.length === count * (message.length + 1), "every message to arrive");
				} else {
					assert.ok(taken < 1_000_000, `messages of ${message.length} characters stop being taken`);
				}
				session.close();
				assert.equal(seen.closed, 0);
			}
		}
	});

	it("ends a connection whose pim-computer stops reading, though the bridge has gone unnoticed, and stays busy until that pim-computer is seen to exit", async () => {
		const served = await endpoint({
			limits: { stallMs: 150, exitMs: 100, closeMs: 100 },
			make: () => {
				const child = new FakeChild({ reads: false });
				child.say(HELLO);
				return child;
			},
		});
		const { seen, given } = events();
		const session = await unixSession({ socketPath: served.socketPath, closeMs: 50 })(given, new AbortController().signal);
		const child = served.children[0]!;
		// More than pim-computer's input holds, so the endpoint stops reading the socket, and can't see the bridge leave.
		session.send("x".repeat(64 * 1024));
		await until(() => child.stdin.writableNeedDrain, "the endpoint to stop reading");
		session.close();
		await until(() => child.signals.length === 2, "SIGTERM and SIGKILL");
		assert.deepEqual(child.signals, ["SIGTERM", "SIGKILL"]);
		const said = served.log.map((entry) => (entry.reason ? `${entry.event} ${entry.reason}` : entry.event));
		assert.deepEqual(said, ["endpoint.listening", "endpoint.started", "endpoint.stalled input", "endpoint.input-ended", "endpoint.stopping SIGTERM", "endpoint.stopping SIGKILL"]);
		assert.equal(child.inputEnded || child.stdin.writableEnded, true, "its input was ended");

		// A signal is not an exit: the next session is refused until the exit is seen.
		assert.equal((await settle(unixSession({ socketPath: served.socketPath })(events().given, new AbortController().signal))).ok, false);
		await tick(300);
		assert.equal(served.calls.length, 1);
		assert.deepEqual(child.signals, ["SIGTERM", "SIGKILL"], "nothing more is signalled");
		assert.ok(!served.log.some((entry) => entry.event === "endpoint.exited"));
		child.exit();
		const next = await unixSession({ socketPath: served.socketPath })(events().given, new AbortController().signal);
		assert.equal(served.calls.length, 2);
		assert.equal(seen.closed, 0);
		next.close();
	});

	it("ends a connection whose peer stops reading what pim-computer says", async () => {
		const served = await endpoint({ limits: { stallMs: 150, exitMs: 100, closeMs: 100 } });
		const peer = net.connect({ path: served.socketPath });
		peer.pause();
		cleanups.push(() => peer.destroy());
		await until(() => served.children.length === 1, "pim-computer to start");
		const child = served.children[0]!;
		const part = Buffer.alloc(64 * 1024, 0x61);
		for (let index = 0; index < 32; index++) child.stdout.write(part);
		await until(() => child.signals.length === 2, "SIGTERM and SIGKILL");
		assert.ok(served.log.some((entry) => entry.event === "endpoint.stalled" && entry.reason === "output"));
		assert.equal(child.inputEnded, true);
	});

	it("keeps a connection whose pim-computer and peer are slow but keep taking more", async () => {
		const served = await endpoint({
			limits: { stallMs: 150, exitMs: 100, closeMs: 100 },
			make: () => {
				const child = new FakeChild({ reads: false });
				child.say(HELLO);
				return child;
			},
		});
		const { seen, given } = events();
		const session = await unixSession({ socketPath: served.socketPath })(given, new AbortController().signal);
		const child = served.children[0]!;
		const started = Date.now();
		// pim-computer takes what its input holds every 30 ms, much less than stallMs, while 1 MiB comes.
		const slowly = setInterval(() => {
			for (let chunk = child.stdin.read(); chunk !== null; chunk = child.stdin.read()) child.input += chunk.toString("utf8");
		}, 30);
		cleanups.push(() => clearInterval(slowly));
		for (let index = 0; index < 16; index++) session.send("i".repeat(64 * 1024));
		await until(() => child.input.length === 16 * (64 * 1024 + 1), "every message", 20_000);
		assert.ok(Date.now() - started > 300, `it took ${Date.now() - started} ms, longer than stallMs twice`);

		// A peer reading what it holds every 30 ms, while pim-computer says 1 MiB.
		const peerServed = await endpoint({ limits: { stallMs: 150, exitMs: 100, closeMs: 100 } });
		const peer = net.connect({ path: peerServed.socketPath });
		peer.pause();
		cleanups.push(() => peer.destroy());
		let received = 0;
		const reading = setInterval(() => {
			for (let chunk = peer.read(); chunk !== null; chunk = peer.read()) received += chunk.length;
		}, 30);
		cleanups.push(() => clearInterval(reading));
		await until(() => peerServed.children.length === 1, "the second pim-computer to start");
		const part = Buffer.alloc(64 * 1024, 0x61);
		const speaking = Date.now();
		for (let index = 0; index < 16; index++) peerServed.children[0]!.stdout.write(part);
		await until(() => received === HELLO.length + 1 + 16 * part.length, "every byte", 20_000);
		assert.ok(Date.now() - speaking > 300, `it took ${Date.now() - speaking} ms, longer than stallMs twice`);

		for (const log of [served.log, peerServed.log]) assert.ok(!log.some((entry) => entry.event === "endpoint.stalled" || entry.event === "endpoint.input-ended"));
		assert.deepEqual(child.signals, []);
		assert.deepEqual(peerServed.children[0]!.signals, []);
		assert.equal(seen.closed, 0);
		session.close();
	});

	it("splits a large write into bounded parts, passes many empty messages on in order, and ends on a line longer than a message may be", async () => {
		const served = await endpoint();
		const { seen, given } = events();
		const session = await unixSession({ socketPath: served.socketPath })(given, new AbortController().signal);
		const child = served.children[0]!;
		const big = JSON.stringify({ type: "cdp", data: "y".repeat(300 * 1024) });
		child.stdout.write(`${big}\n${"\n".repeat(70_000)}{"type":"after"}\n`);
		await until(() => seen.messages.length === 70_003, "every message", 10_000);
		assert.equal(seen.messages[1], big);
		assert.ok(seen.messages.slice(2, 70_002).every((message) => message === ""));
		assert.equal(seen.messages[70_002], '{"type":"after"}');

		child.stdout.write("z".repeat(MAX_MESSAGE_CHARS + 1));
		await until(() => seen.closed === 1, "the session to end", 20_000);
		await until(() => child.inputEnded, "pim-computer's input to end");
		assert.throws(() => session.send("{}"), /ended/);
		assert.equal(seen.messages.length, 70_003);
	});
});

describe("the bridge and the endpoint as programs", () => {
	it("carries Pim's call over HTTPS to the real pim-computer, started by the endpoint, and its reply back", { timeout: 60_000 }, async () => {
		const where = place();
		const home = path.join(where.dir, "home");
		fs.mkdirSync(home);
		const secrets = path.join(where.dir, "secrets");
		fs.mkdirSync(secrets, { mode: 0o700 });
		execFileSync("openssl", [
			"req", "-x509", "-newkey", "ec", "-pkeyopt", "ec_paramgen_curve:prime256v1", "-nodes", "-days", "1",
			"-subj", "/CN=127.0.0.1", "-addext", "subjectAltName=IP:127.0.0.1",
			"-keyout", path.join(secrets, "key.pem"), "-out", path.join(secrets, "cert.pem"),
		], { stdio: "ignore" });
		const token = "cua-session-test-token-0123456789abcdef";
		fs.writeFileSync(path.join(secrets, "token"), `${token}\n`, { mode: 0o600 });
		for (const file of ["key.pem", "cert.pem"]) fs.chmodSync(path.join(secrets, file), 0o600);
		const cert = fs.readFileSync(path.join(secrets, "cert.pem"), "utf8");
		const space = "o_0123456789abcdefghijklmnop";

		/** A program, its standard error collected, ended when the test is. */
		const run = (file: string, args: string[], env: Record<string, string>) => {
			const child = spawnProcess(process.execPath, [path.join(HOST_DIR, file), ...args], { env, stdio: ["ignore", "ignore", "pipe"] });
			const output = { text: "" };
			child.stderr!.on("data", (chunk: Buffer) => {
				output.text += chunk.toString("utf8");
			});
			const exited = new Promise<number | null>((resolve) => child.once("exit", (code) => resolve(code)));
			cleanups.push(async () => {
				if (child.exitCode === null && child.signalCode === null) {
					child.kill("SIGTERM");
					await exited;
				}
			});
			return { child, output, exited };
		};

		const desktop = run("desktop.ts", ["--socket", where.socketPath, "--root", where.root, "--browser", where.browser, "--pim-computer", PIM_COMPUTER], { HOME: home, PATH: process.env.PATH ?? "/usr/bin" });
		await until(() => desktop.output.text.includes('"endpoint.listening"'), "the endpoint to listen", 10_000);

		const port = await new Promise<number>((resolve) => {
			const probe = net.createServer().listen(0, "127.0.0.1", () => {
				const { port: free } = probe.address() as net.AddressInfo;
				probe.close(() => resolve(free));
			});
		});
		const bridge = run("bridge.ts", ["--space", space, "--path", "/pim", "--socket", where.socketPath, "--host", "127.0.0.1", "--port", String(port)], {
			PATH: process.env.PATH ?? "/usr/bin",
			PIM_BRIDGE_TOKEN_FILE: path.join(secrets, "token"),
			PIM_BRIDGE_CERT_FILE: path.join(secrets, "cert.pem"),
			PIM_BRIDGE_KEY_FILE: path.join(secrets, "key.pem"),
		});
		await until(() => bridge.output.text.includes('"host.listening"'), "the bridge to listen", 10_000);

		const pim = new WebSocket(`wss://127.0.0.1:${port}/pim`, { headers: { authorization: `Bearer ${token}`, [SPACE_HEADER]: space }, ca: cert, perMessageDeflate: false });
		const messages: string[] = [];
		let named: string | string[] | undefined;
		pim.on("upgrade", (response) => {
			named = response.headers[SPACE_HEADER];
		});
		pim.on("message", (data) => messages.push(data.toString()));
		await new Promise((resolve, reject) => {
			pim.once("open", resolve);
			pim.once("error", reject);
		});
		assert.equal(named, space);
		await until(() => messages.length === 1, "pim-computer's hello", 10_000);
		const hello = JSON.parse(messages[0]!);
		assert.equal(hello.type, "hello");
		assert.match(hello.agent, /^pim-computer\//);
		assert.equal(hello.root, where.root);
		assert.equal(hello.browser, where.browser);

		pim.send(JSON.stringify({ type: "call", id: "s1", op: "stat", args: { path: "/workspace" } }));
		await until(() => messages.length === 2, "the reply", 10_000);
		const reply = JSON.parse(messages[1]!);
		assert.equal(reply.id, "s1");
		assert.equal(reply.result.isDirectory, true);

		pim.close(1000);
		await until(() => desktop.output.text.includes('"endpoint.exited"'), "pim-computer to exit after its input ended", 20_000);
		assert.ok(!desktop.output.text.includes("SIGTERM"), "it exited by itself");
		assert.ok(!bridge.output.text.includes(token) && !desktop.output.text.includes(token), "the token is in no log");

		desktop.child.kill("SIGTERM");
		assert.equal(await desktop.exited, 0);
		assert.equal(fs.existsSync(where.socketPath), false);
		bridge.child.kill("SIGTERM");
		assert.equal(await bridge.exited, 0);
	});

	/** Runs one of the programs to its exit: its exit code, and what it wrote to standard error. */
	const runToExit = (file: string, args: string[], env: Record<string, string>) =>
		new Promise<{ code: number | null; stderr: string }>((resolve) => {
			const child = spawnProcess(process.execPath, [path.join(HOST_DIR, file), ...args], { env: { PATH: process.env.PATH ?? "/usr/bin", ...env }, stdio: ["ignore", "ignore", "pipe"] });
			let stderr = "";
			child.stderr!.on("data", (chunk: Buffer) => {
				stderr += chunk.toString("utf8");
			});
			child.once("exit", (code) => resolve({ code, stderr }));
		});

	it("refuses to start the bridge with a token file others can read, saying only where it failed", async () => {
		const where = place();
		const file = path.join(where.dir, "token");
		fs.writeFileSync(file, "cua-session-test-token-0123456789abcdef", { mode: 0o644 });
		fs.chmodSync(file, 0o644);
		const result = await runToExit("bridge.ts", ["--space", "o_0123456789abcdefghijklmnop", "--path", "/pim", "--socket", where.socketPath, "--host", "127.0.0.1", "--port", "0"], { PIM_BRIDGE_TOKEN_FILE: file });
		assert.equal(result.code, 1);
		assert.equal(result.stderr.trim(), JSON.stringify({ event: "bridge.failed", reason: "token" }));
	});

	it("says only a fixed reason when the endpoint can't start, never a path or what was thrown", async () => {
		const sentinel = "SENTINEL-7f3a9c";
		const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), `cua-${sentinel}-`)));
		cleanups.push(() => fs.rmSync(dir, { recursive: true, force: true }));
		const root = path.join(dir, `root-${sentinel}`);
		fs.mkdirSync(root);
		const browser = path.join(dir, `browser-${sentinel}`);
		fs.writeFileSync(browser, "#!/bin/sh\nexit 1\n", { mode: 0o700 });
		const occupied = path.join(dir, `taken-${sentinel}.sock`);
		fs.writeFileSync(occupied, sentinel);
		const open = path.join(dir, `open-${sentinel}`);
		fs.mkdirSync(open);
		fs.chmodSync(open, 0o755);
		const settings = (change: Record<string, string>) => {
			const values: Record<string, string> = { socket: path.join(dir, `s-${sentinel}.sock`), root, browser, "pim-computer": PIM_COMPUTER, ...change };
			return Object.entries(values).flatMap(([name, value]) => [`--${name}`, value]);
		};
		const cases: [string, Record<string, string>][] = [
			["root-folder", { root: path.join(dir, `missing-${sentinel}`) }],
			["socket-exists", { socket: occupied }],
			["socket-directory", { socket: path.join(open, `s-${sentinel}.sock`) }],
			["browser", { browser: path.join(dir, `no-browser-${sentinel}`) }],
		];
		for (const [reason, change] of cases) {
			const result = await runToExit("desktop.ts", settings(change), { HOME: dir });
			assert.equal(result.code, 1, reason);
			assert.equal(result.stderr.trim(), JSON.stringify({ event: "endpoint.failed", reason }));
			assert.ok(!result.stderr.includes(sentinel), `${reason}: nothing of the settings is in what it said`);
		}
		assert.equal(fs.readFileSync(occupied, "utf8"), sentinel, "what was at the socket's path is left as it is");
	});
});
