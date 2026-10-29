/**
 * The descriptor-inheritance qualification (docs/cua-native-host-plan.md,
 * "Qualifying descriptor 3"): whether a real child the desktop endpoint
 * starts inherits the credential as descriptor 3, reads it, and closes it
 * before it serves or starts anything, and whether the endpoint closes its
 * own copy. Nothing else in this repository starts a real child with a
 * credential descriptor.
 *
 * **It starts real processes, so it runs only when separately authorized,**
 * and only with `--authorized-descriptor-qualification`; it is in no suite,
 * the bundle doesn't hold it, and no test imports it. It refuses to run as
 * root or anywhere without `/proc/self/fd`.
 *
 * What it composes: `readEndpointArguments` and `createDesktopEndpoint`
 * (../desktop.ts) with their real `spawn` and the real credential checks, on
 * a file of synthetic, non-secret bytes it writes into a new private
 * temporary folder; `--cua-computer` names ./fd3-child.ts, which runs the
 * real `startCuaComputer` and reads the real inherited descriptor. The
 * connection is in memory, handed to the endpoint through its `listener`
 * seam, so nothing listens on a socket. Nothing reaches a network, browser,
 * driver or MCP server: the child's spacesd is a stand-in that answers 503.
 *
 * Steps, each bounded, stopping at the first failure with no retry:
 *
 * 1. `good`: the child reports descriptor 3 inherited, closed before serving,
 *    absent from a grandchild, and the bearer its dispatcher sent equal to
 *    the synthetic token (compared by SHA-256, never printed); the endpoint
 *    holds no descriptor of the file once the spawn returned; ending the
 *    connection ends the child with status 0.
 * 2. `refused`: a file the endpoint takes but the child refuses (a token
 *    with a space) gives `credential-format`, the child holding no
 *    descriptor of it as it exits 1, and no other child started.
 *
 * It prints one JSON line per step and one at the end: step names, booleans
 * and fixed reasons, never a path or a byte of the file. Cleanup always
 * runs: the connection is ended, the endpoint closed (bounded), every child
 * it saw started is checked to have exited and is sent SIGKILL if not, and
 * the temporary folder, which it made, is removed. A cleanup that fails is
 * reported beside the result, never in place of it.
 */

import { type ChildProcess, spawn as spawnProcess } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { EventEmitter } from "node:events";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { Duplex } from "node:stream";
import { fileURLToPath, pathToFileURL } from "node:url";
import { type Child, createDesktopEndpoint, type EndpointListener, readEndpointArguments, type Spawn } from "../desktop.ts";

const FLAG = "--authorized-descriptor-qualification";
const STEP_MS = 15_000;
const CLOSE_MS = 10_000;
const OWNER = "o_fd3-qualification";
/** Never contacted: the child's spacesd is a stand-in. Loopback, so the endpoint's origin check passes as it would for spacesd. */
const ORIGIN = "http://127.0.0.1:9";
const CHILD = fileURLToPath(new URL("./fd3-child.ts", import.meta.url));

const print = (line: Record<string, unknown>) => process.stdout.write(`${JSON.stringify({ event: "fd3-qualification", ...line })}\n`);

class Connection extends Duplex {
	received = "";
	override _read() {}
	override _write(chunk: Buffer, _encoding: BufferEncoding, done: () => void) {
		this.received += chunk.toString("utf8");
		done();
	}
}

/** A stand-in listener: the endpoint takes connections from it and never listens. */
function inMemoryListener() {
	const listener = Object.assign(new EventEmitter(), {
		maxConnections: 0,
		listen() {
			throw new Error("This qualification doesn't listen.");
		},
		close(done?: () => void) {
			done?.();
			return listener;
		},
	});
	return {
		listener: listener as unknown as EndpointListener,
		connect() {
			const connection = new Connection();
			listener.emit("connection", connection);
			return connection;
		},
	};
}

/** Whether any descriptor of this process is the file with `dev` and `ino`. */
function holds(dev: bigint, ino: bigint): boolean {
	for (const name of fs.readdirSync("/proc/self/fd")) {
		try {
			const stat = fs.statSync(`/proc/self/fd/${name}`, { bigint: true });
			if (stat.dev === dev && stat.ino === ino) return true;
		} catch {
			// Not a file, or closed as it was read.
		}
	}
	return false;
}

async function within<T>(ms: number, what: string, wait: () => Promise<T>): Promise<T> {
	let timer: ReturnType<typeof setTimeout> | undefined;
	try {
		return await Promise.race([wait(), new Promise<never>((_, reject) => (timer = setTimeout(() => reject(new Error(`timeout:${what}`)), ms)))]);
	} finally {
		clearTimeout(timer);
	}
}

async function until(condition: () => boolean, what: string, ms = STEP_MS): Promise<void> {
	await within(ms, what, async () => {
		while (!condition()) await new Promise((resolve) => setTimeout(resolve, 20));
	});
}

const exited = (pid: number) => {
	try {
		process.kill(pid, 0);
		return false;
	} catch (error) {
		return (error as NodeJS.ErrnoException).code === "ESRCH";
	}
};

async function main(): Promise<number> {
	if (!process.argv.includes(FLAG)) {
		print({ result: "refused", reason: "not-authorized" });
		return 2;
	}
	const uid = process.geteuid?.();
	if (uid === undefined || uid === 0 || !fs.existsSync("/proc/self/fd")) {
		print({ result: "refused", reason: "environment" });
		return 2;
	}

	const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "pim-fd3-qualification-")));
	const children: ChildProcess[] = [];
	const failures: string[] = [];
	let endpoint: ReturnType<typeof createDesktopEndpoint> | undefined;
	const connections: Connection[] = [];
	let result = "failed";
	try {
		fs.chmodSync(dir, 0o700);
		const root = path.join(dir, "root");
		fs.mkdirSync(root, { mode: 0o700 });
		// A browser the endpoint checks and the child never runs.
		const browser = path.join(dir, "browser");
		fs.writeFileSync(browser, "#!/bin/sh\nexit 1\n", { mode: 0o700 });
		const credential = path.join(dir, "credential");
		const token = `pim-fd3-qualification-${randomBytes(16).toString("hex")}`;
		const write = (bytes: string) => {
			fs.rmSync(credential, { force: true });
			fs.writeFileSync(credential, bytes, { mode: 0o600, flag: "wx" });
			fs.chmodSync(credential, 0o600);
			const stat = fs.statSync(credential, { bigint: true });
			return { dev: stat.dev, ino: stat.ino };
		};
		let file = write(`${token}\n`);

		const started: string[] = [];
		const spawn: Spawn = (command, args, options) => {
			started.push(args[0] ?? "");
			const child = spawnProcess(command, args, options);
			children.push(child);
			return child as ChildProcess & Child;
		};
		const { listener, connect } = inMemoryListener();
		const log: string[] = [];
		const settings = readEndpointArguments([
			"--socket", path.join(dir, "never.sock"), "--root", root, "--browser", browser, "--pim-computer", CHILD,
			"--native", "on", "--cua-computer", CHILD, "--cua-owner", OWNER, "--cua-origin", ORIGIN, "--cua-credential", credential,
		]);
		endpoint = createDesktopEndpoint({
			...settings,
			spawn,
			listener,
			environment: { PATH: process.env.PATH ?? "/usr/bin:/bin", HOME: dir },
			log: (entry) => log.push(`${entry.event}:${entry.reason ?? ""}`),
			limits: { exitMs: 2_000, closeMs: 2_000 },
		});
		print({ step: "endpoint", checkedAtStart: !holds(file.dev, file.ino) });

		// 1. good
		const good = connect();
		connections.push(good);
		await until(() => good.received.includes("\n"), "good-line");
		const goodLine = JSON.parse(good.received.slice(0, good.received.indexOf("\n"))) as Record<string, unknown>;
		const expected = createHash("sha256").update(token, "utf8").digest("hex");
		const goodChecks = {
			oneChild: started.length === 1 && started[0] === CHILD,
			endpointHoldsNone: !holds(file.dev, file.ino),
			inherited: goodLine.inherited === true,
			closedBeforeServe: goodLine.closedBeforeServe === true,
			grandchildClean: goodLine.grandchildClean === true,
			bearerMatches: goodLine.bearer === expected,
		};
		good.push(null);
		await until(() => log.includes("endpoint.exited:"), "good-exit");
		const goodExit = children[0]?.exitCode;
		print({ step: "good", ...goodChecks, exitCode: goodExit ?? null });
		if (!Object.values(goodChecks).every(Boolean) || goodExit !== 0) throw new Error("step:good");

		// 2. refused: bytes the endpoint takes (a regular 0600 file of this user's) and the child doesn't.
		file = write("not a token\n");
		const refused = connect();
		connections.push(refused);
		await until(() => refused.received.includes("\n"), "refused-line");
		const refusedLine = JSON.parse(refused.received.slice(0, refused.received.indexOf("\n"))) as Record<string, unknown>;
		await until(() => log.filter((entry) => entry === "endpoint.exited:").length === 2, "refused-exit");
		const refusedChecks = {
			twoChildren: started.length === 2 && started.every((program) => program === CHILD),
			reason: refusedLine.refused === "credential-format",
			childHeldNone: refusedLine.heldAfter === false,
			endpointHoldsNone: !holds(file.dev, file.ino),
			exitCode: children[1]?.exitCode === 1,
		};
		print({ step: "refused", ...refusedChecks });
		if (!Object.values(refusedChecks).every(Boolean)) throw new Error("step:refused");
		result = "passed";
	} catch (error) {
		const message = error instanceof Error ? error.message : "";
		print({ step: "stopped", reason: /^(step|timeout):[a-z-]+$/.test(message) ? message : "error" });
	} finally {
		for (const connection of connections) connection.destroy();
		if (endpoint) {
			try {
				await within(CLOSE_MS, "endpoint-close", () => endpoint!.close());
			} catch {
				failures.push("endpoint-close");
			}
		}
		for (const child of children) {
			if (child.pid !== undefined && !exited(child.pid)) {
				failures.push("child-running");
				child.kill("SIGKILL");
			}
		}
		try {
			fs.rmSync(dir, { recursive: true, force: true });
		} catch {
			failures.push("remove-folder");
		}
	}
	print({ result, cleanupFailures: failures });
	return result === "passed" && failures.length === 0 ? 0 : 1;
}

// Run as a program, not when imported.
if (process.argv[1] && import.meta.url === pathToFileURL(fs.realpathSync(process.argv[1])).href) {
	void main().then((code) => process.exit(code));
}
