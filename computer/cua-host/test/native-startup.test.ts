/**
 * The native-capable host start, composed in this process: the desktop
 * endpoint's program arguments (`readEndpointArguments` in ../desktop.ts), the
 * endpoint with them (`createDesktopEndpoint`), the credential it opens for
 * each child (../cua-credential.ts), and the Cua computer each child would
 * start (`startCuaComputer` in ../cua-computer.ts), with the descriptor the
 * endpoint hands over.
 *
 * Everything outside this process is a stand-in, and nothing starts, listens
 * or connects:
 *
 * - The endpoint is given a stand-in listener, which it never listens on;
 *   each connection is an in-memory duplex the test hands it.
 * - Every child is an in-memory `StandInChild` from the endpoint's `spawn`.
 *   No `child_process` function is called: every endpoint here is given a
 *   `spawn`. A child that "starts the Cua computer" runs `startCuaComputer`
 *   in this process, with descriptor 3 as a stand-in reader over the bytes
 *   the stand-in file system holds for the descriptor the endpoint passed in
 *   its `stdio`, as a child's own copy of it.
 * - The credential file is a stand-in file system (`CredentialFiles`) that
 *   holds files by path, records every open and close, and can't read: the
 *   endpoint never could.
 * - spacesd is a `fetch` that records what it was sent and answers 503;
 *   serving is a function that writes a hello on the child's output, or
 *   throws, and records what it was given.
 *
 * What it does touch: a temporary folder per test under `os.tmpdir()`
 * (`cua-native-*`), holding the root folder and stand-in program and browser
 * files the endpoint checks on disk and never runs, and the socket's
 * directory, where no socket is made; all removed after each test. And
 * Node's timers, for waits of at most a few seconds.
 *
 * What it doesn't show: what a real kernel does with an inherited descriptor,
 * what a real spacesd, driver, desktop or VM does, or that any credential
 * exists or works. Run it directly, so its tests run in this process:
 *
 *   node test/native-startup.test.ts
 */

import assert from "node:assert/strict";
import { Buffer } from "node:buffer";
import { EventEmitter } from "node:events";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { Duplex, PassThrough } from "node:stream";
import { afterEach, describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import type { NativeCall, ServeSettings } from "../../pim-computer.ts";
import { CuaComputerRefused, startCuaComputer } from "../cua-computer.ts";
import { type CredentialFiles, type CredentialReader, type CredentialStat, MAX_CREDENTIAL_BYTES } from "../cua-credential.ts";
import { type Child, createDesktopEndpoint, type EndpointArguments, type EndpointListener, EndpointRefused, readEndpointArguments, type Spawn, type SpawnOptions } from "../desktop.ts";
import type { LogEntry } from "../../cua-bridge.ts";
import type { Fetch, NativeOutcome } from "../native-mcp.ts";

/** The endpoint checks the real temporary folders as the desktop user's, so the stand-in credential is this user's too. */
const UID = process.geteuid!();
/** Another user, whatever user runs the tests: the endpoint refuses to run as root, so `UID` is at least 1 and this is never it. */
const FOREIGN_UID = UID + 1;
assert.notEqual(FOREIGN_UID, UID);
const OWNER = "o_cua-native-space";
const ORIGIN = "http://127.0.0.1:7443";
const TOKEN_A = "spacesd-stand-in-token-A-0123456789abcdef";
const TOKEN_B = "spacesd-stand-in-token-B-fedcba9876543210";
const HELLO = JSON.stringify({ type: "hello", version: 1, agent: "pim-computer/stand-in" });
const HOST_DIR = fileURLToPath(new URL("..", import.meta.url));
const CUA_COMPUTER = path.join(HOST_DIR, "cua-computer.ts");
const PIM_COMPUTER = path.resolve(HOST_DIR, "..", "pim-computer.ts");

const tick = (ms = 5) => new Promise((resolve) => setTimeout(resolve, ms));
async function until(condition: () => boolean, what: string, ms = 3_000) {
	const deadline = Date.now() + ms;
	while (!condition()) {
		if (Date.now() > deadline) throw new Error(`Timed out waiting for ${what}.`);
		await tick();
	}
}

const cleanups: (() => void)[] = [];
afterEach(() => {
	for (const cleanup of cleanups.splice(0).reverse()) cleanup();
});

/** The folders and files the endpoint checks on disk: none is run, and no socket is made. */
function place() {
	const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "cua-native-")));
	cleanups.push(() => fs.rmSync(dir, { recursive: true, force: true }));
	fs.chmodSync(dir, 0o700);
	const root = path.join(dir, "root");
	fs.mkdirSync(root);
	const browser = path.join(dir, "browser");
	fs.writeFileSync(browser, "#!/bin/sh\nexit 1\n", { mode: 0o700 });
	return { dir, root, browser, socketPath: path.join(dir, "session.sock") };
}

type StandInFile = { bytes: string; stat?: { isFile?: boolean; uid?: number; mode?: number; nlink?: number; size?: number }; missing?: boolean; linkedTo?: string };

/**
 * The credential file as a stand-in file system: files by path, which a test
 * replaces to rotate or break one. Each open gets a new descriptor number
 * whose bytes and status are those of the file as it was opened, as a
 * kernel's open file is; a child's copy of a descriptor (`copyFor`) keeps
 * them after the endpoint closes its own. It records every open, close tried
 * and close that returned, and can't read.
 */
function standInFiles(initial: Record<string, StandInFile>) {
	const files = new Map(Object.entries(initial));
	const open = new Map<number, { bytes: Buffer; stat: CredentialStat }>();
	const state = { opened: [] as string[], tried: [] as number[], closed: [] as number[], failClose: false, next: 40 };
	const statOf = (file: StandInFile): CredentialStat => {
		const stat = { isFile: true, uid: UID, mode: 0o100600, nlink: 1, size: Buffer.byteLength(file.bytes, "latin1"), ...file.stat };
		return { isFile: () => stat.isFile, uid: stat.uid, mode: stat.mode, nlink: stat.nlink, size: stat.size };
	};
	const fsStandIn: CredentialFiles = {
		realpath(file) {
			const found = files.get(file);
			if (!found || found.missing) throw Object.assign(new Error("ENOENT"), { code: "ENOENT" });
			return found.linkedTo ?? file;
		},
		open(file) {
			const found = files.get(file);
			if (!found || found.missing) throw Object.assign(new Error("ENOENT"), { code: "ENOENT" });
			const fd = state.next++;
			open.set(fd, { bytes: Buffer.from(found.bytes, "latin1"), stat: statOf(found) });
			state.opened.push(file);
			return fd;
		},
		fstat(fd) {
			const found = open.get(fd);
			if (!found) throw new Error("EBADF");
			return found.stat;
		},
		close(fd) {
			state.tried.push(fd);
			if (state.failClose) throw new Error("EIO");
			if (!open.delete(fd)) throw new Error("EBADF");
			state.closed.push(fd);
		},
	};
	/** A child's own copy of descriptor `fd`, as its process would inherit it: a reader over the bytes it was opened with. */
	const copyFor = (fd: number) => {
		const found = open.get(fd);
		if (!found) return null;
		const copy = { closed: false };
		const reader: CredentialReader = {
			fstat: () => found.stat,
			read(_fd, buffer, offset, length, position) {
				if (copy.closed) throw new Error("EBADF");
				return found.bytes.copy(buffer, offset, position, Math.min(found.bytes.length, position + length));
			},
			close() {
				if (copy.closed) throw new Error("EBADF");
				copy.closed = true;
			},
		};
		return { reader, copy };
	};
	return { files, fs: fsStandIn, state, copyFor, isOpen: (fd: number) => open.has(fd) };
}

/** A child the endpoint started: what it was given on its input, and how it was ended. */
class StandInChild extends EventEmitter implements Child {
	readonly pid = 4242;
	readonly stdin = new PassThrough();
	readonly stdout = new PassThrough();
	readonly signals: string[] = [];
	input = "";
	inputEnded = false;
	exited = false;
	constructor() {
		super();
		this.stdin.on("data", (chunk: Buffer) => {
			this.input += chunk.toString("utf8");
		});
		this.stdin.on("finish", () => {
			this.inputEnded = true;
		});
	}
	kill(signal: "SIGTERM" | "SIGKILL") {
		this.signals.push(signal);
		return true;
	}
	exit(code = 0) {
		if (this.exited) return;
		this.exited = true;
		this.stdout.end();
		this.emit("exit", code, null);
	}
}

/** A connection, in memory: what the bridge would send and what it got back. */
class StandInSocket extends Duplex {
	received = "";
	override _read() {}
	override _write(chunk: Buffer, _encoding: BufferEncoding, done: () => void) {
		this.received += chunk.toString("utf8");
		done();
	}
	send(text: string) {
		this.push(text);
	}
	hangUp() {
		this.push(null);
	}
}

/** The endpoint's listener, which it never listens on; `connect` hands it a connection. */
function standInListener() {
	const listener = Object.assign(new EventEmitter(), {
		maxConnections: 0,
		listen() {
			throw new Error("This test's endpoint doesn't listen.");
		},
		close(done?: () => void) {
			done?.();
			return listener;
		},
	});
	const connect = () => {
		const socket = new StandInSocket();
		listener.emit("connection", socket);
		return socket;
	};
	return { listener: listener as unknown as EndpointListener, connect };
}

/** spacesd as a `fetch` that records each request and answers 503. */
function standInSpacesd() {
	const requests: { url: string; authorization: string | null }[] = [];
	const fetch: Fetch = async (url, init) => {
		requests.push({ url: String(url), authorization: new Headers(init?.headers).get("authorization") });
		return new Response("unavailable", { status: 503 });
	};
	return { fetch, requests };
}

type Started = { child: StandInChild; args: readonly string[]; options: SpawnOptions; fd?: number; copy?: { closed: boolean }; start?: Promise<void>; serving?: ServeSettings; failure?: unknown };

/** The descriptor handed over as the child's fourth stdio entry, if any. */
const handedOver = (options: SpawnOptions) => (options.stdio as readonly unknown[])[3] as number | undefined;

/**
 * An endpoint made from `argv` as its program reads them, with stand-ins for
 * everything it starts and opens. A child started with descriptor 3 runs
 * `startCuaComputer` with its own copy of that descriptor; `serve` writes the
 * hello, or does what the test says.
 */
function hostFrom(argv: readonly string[], credentials: ReturnType<typeof standInFiles>, options: { serve?: (child: StandInChild, settings: ServeSettings) => Promise<void>; spawnFails?: () => boolean } = {}) {
	const settings: EndpointArguments = readEndpointArguments(argv);
	const started: Started[] = [];
	const log: LogEntry[] = [];
	const spacesd = standInSpacesd();
	const { listener, connect } = standInListener();
	const attempts: (readonly string[])[] = [];
	const spawn: Spawn = (command, args, spawnOptions) => {
		assert.equal(command, process.execPath);
		attempts.push(args);
		if (options.spawnFails?.()) throw new Error("spawn EAGAIN");
		const child = new StandInChild();
		const run: Started = { child, args, options: spawnOptions };
		started.push(run);
		const fd = handedOver(spawnOptions);
		if (fd !== undefined) {
			run.fd = fd;
			// The child's own descriptor 3, copied before the endpoint closes its own, as a spawned process's would be.
			const copy = credentials.copyFor(fd);
			assert.ok(copy, "the descriptor handed over was open when the spawn ran");
			run.copy = copy.copy;
			run.start = startCuaComputer({
				root: args[args.indexOf("--root") + 1]!,
				chrome: args[args.indexOf("--chrome") + 1]!,
				headful: args.includes("--headful"),
				owner: args[args.indexOf("--owner") + 1]!,
				origin: args[args.indexOf("--origin") + 1]!,
				reader: copy.reader,
				uid: UID,
				fetch: spacesd.fetch,
				serve: async (serving) => {
					run.serving = serving;
					if (options.serve) return options.serve(child, serving);
					child.stdout.write(`${HELLO}\n`);
				},
			}).catch((error: unknown) => {
				// What its program does on a refusal: exit 1, which the endpoint sees as the child's exit.
				run.failure = error;
				child.exit(1);
			});
		}
		return child;
	};
	const endpoint = createDesktopEndpoint({ ...settings, uid: UID, environment: { HOME: "/home/desktop", PATH: "/usr/bin" }, spawn, credentialFiles: credentials.fs, listener, log: (entry) => log.push(entry), limits: { exitMs: 20, closeMs: 20, stallMs: 1_000 } });
	cleanups.push(() => {
		for (const run of started) run.child.exit();
	});
	return { endpoint, settings, started, attempts, log, spacesd, connect };
}

function placeWithCua() {
	const where = place();
	const credential = path.join(where.dir, "spacesd-token");
	const cuaComputer = path.join(where.dir, "cua-computer.ts");
	fs.writeFileSync(cuaComputer, "// never run\n", { mode: 0o644 });
	const pimComputer = path.join(where.dir, "pim-computer.ts");
	fs.writeFileSync(pimComputer, "// never run\n", { mode: 0o644 });
	const ordinary = ["--socket", where.socketPath, "--root", where.root, "--browser", where.browser, "--pim-computer", pimComputer];
	const native = [...ordinary, "--native", "on", "--cua-computer", cuaComputer, "--cua-owner", OWNER, "--cua-origin", ORIGIN, "--cua-credential", credential];
	return { ...where, credential, cuaComputer, pimComputer, ordinary, native };
}

const reasonsOf = (log: LogEntry[]) => log.filter((entry) => entry.event === "endpoint.refused").map((entry) => entry.reason);

describe("the endpoint program's native settings", () => {
	const base = ["--socket", "/run/pim/session.sock", "--root", "/home/desktop/workspace", "--browser", "/opt/chrome", "--pim-computer", "/opt/pim/pim-computer.ts"];
	const cua = ["--cua-computer", "/opt/pim/cua-computer.ts", "--cua-owner", OWNER, "--cua-origin", ORIGIN, "--cua-credential", "/home/desktop/.config/pim/token"];
	const refused = (argv: string[]) => {
		try {
			readEndpointArguments(argv);
		} catch (error) {
			assert.ok(error instanceof EndpointRefused);
			return error.reason;
		}
		return "accepted";
	};

	it("starts pim-computer, with no Cua settings, when --native is absent or off", () => {
		for (const argv of [base, [...base, "--native", "off"], [...base, "--headful"]]) {
			const settings = readEndpointArguments(argv);
			assert.equal(settings.cua, undefined, argv.join(" "));
			assert.equal(settings.pimComputer, "/opt/pim/pim-computer.ts");
		}
	});

	it("keeps an ordinary setting's last value when it is given twice without --native on, as the program always has", () => {
		// What the program read before --native existed: Node's parseArgs with its five settings, the last value of each kept.
		const before = (argv: string[]) => {
			const { values } = parseArgs({
				args: argv,
				options: { socket: { type: "string" }, root: { type: "string" }, browser: { type: "string" }, "pim-computer": { type: "string" }, headful: { type: "boolean" } },
			});
			return { socketPath: values.socket, root: values.root, browser: values.browser, pimComputer: values["pim-computer"], headful: values.headful === true };
		};
		const repeated = [
			"--socket", "/run/first/session.sock", "--root", "/home/desktop/first", "--browser", "/opt/first-chrome", "--pim-computer", "/opt/first/pim-computer.ts", "--headful",
			...base, "--headful", "--root", "/home/desktop/last",
		];
		for (const argv of [repeated, [...repeated, "--native", "off"], ["--native", "off", ...repeated]]) {
			const settings = readEndpointArguments(argv);
			assert.deepEqual(settings, before(argv.filter((_, index) => argv[index] !== "--native" && argv[index - 1] !== "--native")), argv.join(" "));
			assert.deepEqual(settings, { socketPath: "/run/pim/session.sock", root: "/home/desktop/last", browser: "/opt/chrome", pimComputer: "/opt/pim/pim-computer.ts", headful: true });
		}
	});

	it("takes the Cua computer's four settings with --native on, and only all of them", () => {
		assert.deepEqual(readEndpointArguments([...base, "--native", "on", ...cua]).cua, {
			program: "/opt/pim/cua-computer.ts",
			owner: OWNER,
			origin: ORIGIN,
			credentialFile: "/home/desktop/.config/pim/token",
		});
	});

	it("refuses anything partial, contradictory, repeated or malformed, before anything is checked or started", () => {
		const cases: [string, string[], string][] = [
			["Cua settings without --native", [...base, ...cua], "native-settings"],
			["Cua settings with --native off", [...base, "--native", "off", ...cua], "native-settings"],
			["one Cua setting with --native off", [...base, "--native", "off", "--cua-owner", OWNER], "native-settings"],
			["--native on alone", [...base, "--native", "on"], "native-settings"],
			["--native of another value", [...base, "--native", "yes", ...cua], "native-settings"],
			["--native empty", [...base, "--native", "", ...cua], "native-settings"],
			["a Cua setting empty", [...base, "--native", "on", ...cua.slice(0, 3), "", ...cua.slice(4)], "native-settings"],
			["--native repeated", [...base, "--native", "on", "--native", "on", ...cua], "usage"],
			["--native off, then on", [...base, "--native", "off", "--native", "on", ...cua], "usage"],
			["--native on, then off", [...base, "--native", "on", "--native", "off", ...cua], "usage"],
			["--native off repeated", [...base, "--native", "off", "--native", "off"], "usage"],
			["--native on, then inline", [...base, "--native", "on", "--native=on", ...cua], "usage"],
			["a Cua setting repeated with --native off", [...base, "--native", "off", "--cua-owner", OWNER, "--cua-owner", OWNER], "usage"],
			["a Cua setting repeated without --native", [...base, "--cua-credential", "/a", "--cua-credential", "/b"], "usage"],
			["an ordinary setting repeated with --native on", [...base, "--native", "on", ...cua, "--root", "/home/desktop/other"], "usage"],
			["--headful repeated with --native on", [...base, "--headful", "--native", "on", ...cua, "--headful"], "usage"],
			["a Cua setting with no value", [...base, "--native", "on", ...cua.slice(0, 6), "--cua-credential"], "usage"],
			["a Cua setting repeated", [...base, "--native", "on", ...cua, "--cua-origin", "https://elsewhere.test"], "usage"],
			["--native as a flag", [...base, "--native", ...cua], "usage"],
			["an unknown setting", [...base, "--native", "on", ...cua, "--cua-token", TOKEN_A], "usage"],
			["a positional argument", [...base, TOKEN_A], "usage"],
		];
		for (const name of ["--cua-computer", "--cua-owner", "--cua-origin", "--cua-credential"]) {
			const index = cua.indexOf(name);
			cases.push([`--native on without ${name}`, [...base, "--native", "on", ...cua.slice(0, index), ...cua.slice(index + 2)], "native-settings"]);
		}
		for (const [what, argv, reason] of cases) assert.equal(refused(argv), reason, what);
	});
});

describe("the native-capable host start, composed", () => {
	it("starts pim-computer exactly as before without --native, and never opens the credential", async () => {
		const where = placeWithCua();
		const credentials = standInFiles({ [where.credential]: { bytes: TOKEN_A } });
		// Given twice, the first values pointing at nothing: the last are the ones checked and started, as before.
		const twice = ["--root", "/nowhere/root", "--browser", "/nowhere/browser", "--pim-computer", "/nowhere/pim-computer.ts", ...where.ordinary];
		for (const argv of [where.ordinary, [...where.ordinary, "--native", "off"], twice, ["--native", "off", ...twice]]) {
			const host = hostFrom(argv, credentials);
			const socket = host.connect();
			await until(() => host.started.length === 1, "the child");
			const [run] = host.started;
			assert.deepEqual(run!.args, [where.pimComputer, "--stdio", "--root", where.root, "--chrome", where.browser]);
			assert.deepEqual(run!.options.stdio, ["pipe", "pipe", "ignore"]);
			assert.equal(run!.start, undefined);
			socket.hangUp();
			run!.child.exit();
			await host.endpoint.close();
		}
		assert.deepEqual(credentials.state.opened, []);
	});

	it("hands the Cua computer its credential as descriptor 3 only, which it reads and closes before it serves, and never puts the token in its arguments, environment or logs", async () => {
		const where = placeWithCua();
		const credentials = standInFiles({ [where.credential]: { bytes: `${TOKEN_A}\n` } });
		const host = hostFrom(where.native, credentials);
		// Checked once at the start: opened and closed, unread.
		assert.deepEqual(credentials.state.opened, [where.credential]);
		assert.equal(credentials.state.closed.length, 1);

		const socket = host.connect();
		await until(() => host.started.length === 1 && host.started[0]!.serving !== undefined, "the Cua computer serving");
		const run = host.started[0]!;
		const fd = run.fd!;
		assert.deepEqual(run.args, [where.cuaComputer, "--root", where.root, "--chrome", where.browser, "--owner", OWNER, "--origin", ORIGIN]);
		assert.deepEqual(run.options.stdio, ["pipe", "pipe", "ignore", fd]);
		// The endpoint closed its own copy as the spawn returned; the child's copy was read and closed before serving.
		assert.equal(credentials.isOpen(fd), false);
		assert.deepEqual(credentials.state.closed, [credentials.state.closed[0], fd]);
		assert.equal(run.copy?.closed, true);
		await until(() => socket.received.includes(HELLO), "the hello on the connection");
		const exposed = JSON.stringify({ args: run.args, env: run.options.env, log: host.log, received: socket.received, serving: { ...run.serving, native: undefined } });
		for (const secret of [TOKEN_A, where.credential]) assert.ok(!exposed.includes(secret), "no token or credential path outside descriptor 3");
		assert.deepEqual(Object.keys(run.options.env).sort(), ["HOME", "PATH"]);

		// Its native calls go to this space's spacesd only, with the token only as the bearer; another space's go nowhere.
		const native = run.serving!.native!;
		const call: NativeCall = { owner: OWNER, agentId: "agent-1", runId: "7", callId: "approval:1", tool: "list_apps", arguments: {} };
		await native(call);
		assert.ok(host.spacesd.requests.length > 0);
		for (const request of host.spacesd.requests) {
			assert.ok(request.url.startsWith(`${ORIGIN}/`), request.url);
			assert.equal(request.authorization, `Bearer ${TOKEN_A}`);
		}
		const sent = host.spacesd.requests.length;
		const other = (await native({ ...call, owner: "o_another-space" })) as NativeOutcome;
		assert.equal(other.status, "rejected");
		assert.equal(host.spacesd.requests.length, sent);

		socket.hangUp();
		run.child.exit();
		await host.endpoint.close();
	});

	it("refuses to start on a wrong owner or origin, or a credential that is missing, a link, not private, not the user's, linked twice, empty or too large, and starts nothing", () => {
		const where = placeWithCua();
		const bad: [string, string[], StandInFile | null, string][] = [
			["an owner that isn't a space's identity", where.native.map((value) => (value === OWNER ? "not a space" : value)), { bytes: TOKEN_A }, "cua-owner"],
			["an origin with a path", where.native.map((value) => (value === ORIGIN ? `${ORIGIN}/mcp` : value)), { bytes: TOKEN_A }, "cua-origin"],
			["plain HTTP off loopback", where.native.map((value) => (value === ORIGIN ? "http://spacesd.test:7443" : value)), { bytes: TOKEN_A }, "cua-origin"],
			["a missing credential", where.native, { bytes: TOKEN_A, missing: true }, "credential"],
			["a credential that is a link", where.native, { bytes: TOKEN_A, linkedTo: "/elsewhere/token" }, "credential"],
			["a credential others can read", where.native, { bytes: TOKEN_A, stat: { mode: 0o100644 } }, "credential"],
			["a credential of another user", where.native, { bytes: TOKEN_A, stat: { uid: FOREIGN_UID } }, "credential"],
			["a credential of root's", where.native, { bytes: TOKEN_A, stat: { uid: 0 } }, "credential"],
			["a credential with two names", where.native, { bytes: TOKEN_A, stat: { nlink: 2 } }, "credential"],
			["a credential that isn't a file", where.native, { bytes: TOKEN_A, stat: { isFile: false } }, "credential"],
			["an empty credential", where.native, { bytes: "" }, "credential"],
			["a credential too large", where.native, { bytes: "x".repeat(MAX_CREDENTIAL_BYTES + 1) }, "credential"],
		];
		for (const [what, argv, file, reason] of bad) {
			const credentials = standInFiles(file ? { [where.credential]: file } : {});
			assert.throws(
				() => hostFrom(argv, credentials),
				(error: unknown) => error instanceof EndpointRefused && error.reason === reason && !error.message.includes(where.credential),
				what,
			);
			// Whatever was opened to check was closed again.
			assert.equal(credentials.state.closed.length, credentials.state.opened.length, what);
		}
	});

	it("starts no pim-computer in the Cua computer's place when it fails to start, its credential is refused at a connection, or its hello never comes", async () => {
		const where = placeWithCua();
		const credentials = standInFiles({ [where.credential]: { bytes: TOKEN_A } });
		let fail = true;
		let spawnFails = true;
		const host = hostFrom(where.native, credentials, {
			serve: async (child) => {
				if (fail) throw new Error("couldn't write the hello");
				child.stdout.write(`${HELLO}\n`);
			},
			spawnFails: () => spawnFails,
		});

		// Its process can't be started: the descriptor opened for it is closed all the same, and nothing else is tried.
		const unstarted = host.connect();
		await until(() => unstarted.destroyed, "the connection with no child");
		assert.equal(host.attempts.length, 1);
		assert.equal(host.started.length, 0);
		assert.equal(credentials.state.closed.length, credentials.state.opened.length);
		assert.deepEqual(reasonsOf(host.log), ["spawn"]);
		spawnFails = false;

		// Its start fails at the handshake: the child exits 1, the connection ends with nothing on it.
		const first = host.connect();
		await until(() => host.started[0]?.failure !== undefined, "the failed start");
		await until(() => first.destroyed, "the first connection to end");
		assert.equal(first.received, "");

		// A credential made unreadable by others' standards between connections: refused, nothing started, no fallback.
		credentials.files.set(where.credential, { bytes: TOKEN_A, stat: { mode: 0o100640 } });
		const second = host.connect();
		await until(() => second.destroyed, "the refused connection");
		assert.equal(host.started.length, 1);
		assert.deepEqual(reasonsOf(host.log), ["spawn", "credential"]);

		// A file the endpoint takes but the child doesn't (a token with a space in it): the child refuses before serving, and exits.
		credentials.files.set(where.credential, { bytes: "not a token" });
		const refusedByChild = host.connect();
		await until(() => host.started[1]?.failure !== undefined, "the child's refusal");
		await until(() => refusedByChild.destroyed, "that connection to end");
		assert.equal((host.started[1]!.failure as CuaComputerRefused).reason, "credential-format");
		assert.equal(host.started[1]!.serving, undefined);
		assert.equal(host.started[1]!.copy?.closed, true);
		assert.equal(refusedByChild.received, "");

		// Put right, the next connection starts the Cua computer again, and only it.
		credentials.files.set(where.credential, { bytes: TOKEN_A });
		fail = false;
		const third = host.connect();
		await until(() => third.received.includes(HELLO), "the hello");
		assert.equal(host.started.length, 3);
		assert.equal(host.attempts.length, 4);
		for (const args of host.attempts) assert.equal(args[0], where.cuaComputer);
		assert.ok(host.attempts.every((args) => !args.includes("--stdio") && !args.includes(where.pimComputer)));
		third.hangUp();
		host.started[2]!.child.exit();
		await host.endpoint.close();
	});

	it("uses a rotated credential from the next connection on, and leaves the running child with the one it read", async () => {
		const where = placeWithCua();
		const credentials = standInFiles({ [where.credential]: { bytes: TOKEN_A } });
		const host = hostFrom(where.native, credentials);
		const call: NativeCall = { owner: OWNER, agentId: "agent-1", runId: "7", callId: "approval:1", tool: "list_apps", arguments: {} };

		const first = host.connect();
		await until(() => host.started[0]?.serving !== undefined, "the first child serving");
		// Rotated while the first child runs: replaced by a new file, as an operator would rename one into place.
		credentials.files.set(where.credential, { bytes: `${TOKEN_B}\n` });
		await host.started[0]!.serving!.native!(call);
		assert.ok(host.spacesd.requests.length > 0);
		assert.ok(host.spacesd.requests.every((request) => request.authorization === `Bearer ${TOKEN_A}`));

		// A second connection waits for the first child's exit; the next child reads the new token.
		const early = host.connect();
		await until(() => early.destroyed, "the busy refusal");
		assert.deepEqual(reasonsOf(host.log), ["busy"]);
		first.hangUp();
		host.started[0]!.child.exit();
		await until(() => host.log.some((entry) => entry.event === "endpoint.exited"), "the first child's exit");
		const before = host.spacesd.requests.length;
		host.connect();
		await until(() => host.started[1]?.serving !== undefined, "the second child serving");
		await host.started[1]!.serving!.native!({ ...call, callId: "approval:2" });
		assert.ok(host.spacesd.requests.length > before);
		assert.ok(host.spacesd.requests.slice(before).every((request) => request.authorization === `Bearer ${TOKEN_B}`));
		host.started[1]!.child.exit();
		await host.endpoint.close();
	});

	it("takes nothing more once it can't close the descriptor it handed a child, ends and watches that child to its exit, and opens the file no more", async () => {
		const where = placeWithCua();
		const credentials = standInFiles({ [where.credential]: { bytes: TOKEN_A } });
		const host = hostFrom(where.native, credentials);
		const opened = credentials.state.opened.length;
		credentials.state.failClose = true;
		const socket = host.connect();
		await until(() => host.started.length === 1, "the child");
		const run = host.started[0]!;
		// Started, but carrying nothing: its input ended, the connection closed, then SIGTERM and SIGKILL after the limits.
		await until(() => run.child.inputEnded && socket.destroyed, "the child's input to end");
		await until(() => run.child.signals.join() === "SIGTERM,SIGKILL", "SIGTERM, then SIGKILL");
		assert.deepEqual(reasonsOf(host.log), ["credential-close"]);
		// Still busy until its exit is seen; then refused for good, with nothing opened again.
		const meanwhile = host.connect();
		await until(() => meanwhile.destroyed, "the refusal while busy");
		credentials.state.failClose = false;
		run.child.exit();
		await until(() => host.log.some((entry) => entry.event === "endpoint.exited"), "its exit");
		const later = host.connect();
		await until(() => later.destroyed, "the refusal after");
		assert.equal(host.started.length, 1);
		assert.equal(credentials.state.opened.length, opened + 1);
		assert.deepEqual(reasonsOf(host.log), ["credential-close", "credential-close", "credential-close"]);
		await host.endpoint.close();
	});
});
