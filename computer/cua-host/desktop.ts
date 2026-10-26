/**
 * The desktop session endpoint of a Cua bridge (docs/cua-bridge.md): what
 * runs on the VM as its one shared, non-root desktop user, which every agent
 * of the space runs as. It listens on a Unix socket at a path the operator
 * sets and, for each connection, starts `pim-computer --stdio` as that same
 * user, with the root folder and browser the operator set, and carries bytes
 * between the connection and pim-computer's input and output. What
 * pim-computer writes to standard error is discarded.
 *
 * Nothing that arrives on the socket chooses what runs: the program, its
 * arguments, its working directory, its environment and its user are fixed
 * when the endpoint starts, and no shell is involved. It gets no secret: the
 * bridge's token and TLS key stay in the bridge's account (./bridge.ts).
 *
 * One pim-computer at a time. While the one it started hasn't exited, a new
 * connection is refused (closed unanswered), so two never share the
 * browser's profile. When its connection ends, its input is ended, and, if
 * it hasn't exited after `exitMs`, it is asked to (`SIGTERM`), then ended
 * (`SIGKILL`) after `closeMs`. That is all the endpoint knows of: only the
 * process it started, never its process group or anything else on the VM.
 * Its exit doesn't show that what it started, or anything else running as
 * the desktop user, has stopped.
 *
 * The socket is an operator's boundary between two accounts, not between
 * agents: anything running as the desktop user can connect to it, as it can
 * run pim-computer itself.
 *
 *   node desktop.ts --socket /run/pim-session/session.sock --root /home/desktop/workspace \
 *     --browser /opt/google/chrome/chrome --pim-computer /opt/pim/pim-computer.ts [--headful]
 *
 * Importing it does nothing; `createDesktopEndpoint(...).listen()` serves.
 */

import { type ChildProcess, spawn as spawnProcess } from "node:child_process";
import * as fs from "node:fs";
import { realpathSync } from "node:fs";
import * as net from "node:net";
import * as path from "node:path";
import type { Readable, Writable } from "node:stream";
import { pathToFileURL } from "node:url";
import type { LogEntry } from "../cua-bridge.ts";
import { checkSocketPath } from "./session.ts";

/** What the endpoint needs of a process it started; tests give stand-ins. */
export type Child = {
	readonly pid?: number | undefined;
	readonly stdin: Writable;
	readonly stdout: Readable;
	kill(signal: "SIGTERM" | "SIGKILL"): unknown;
	once(event: "exit", listener: () => void): unknown;
	once(event: "error", listener: () => void): unknown;
};

/** How pim-computer is started. The endpoint passes fixed values only. */
export type SpawnOptions = { readonly cwd: string; readonly env: Record<string, string>; readonly stdio: ["pipe", "pipe", "ignore"]; readonly shell: false };
export type Spawn = (command: string, args: readonly string[], options: SpawnOptions) => Child;

export type EndpointLimits = {
	/** Sockets the endpoint keeps at once, open or being refused; past it, new ones are dropped. */
	readonly maxConnections: number;
	/** How long pim-computer has to exit after its input ends (it quits its browser first, which may take 15 s) before it is asked to. */
	readonly exitMs: number;
	/** How long it has after being asked before it is ended; and how long its output has to finish after it exits. */
	readonly closeMs: number;
};

export const DEFAULT_ENDPOINT_LIMITS: EndpointLimits = { maxConnections: 4, exitMs: 30_000, closeMs: 5_000 };

/**
 * The variables pim-computer gets from the endpoint's own environment, and
 * no others; it adds `PIM_WORKSPACE` for commands. A desktop session's: its
 * home, user, shell, path, locale, and display for a browser with a window.
 */
export const KEPT_ENVIRONMENT = [
	"HOME",
	"USER",
	"LOGNAME",
	"SHELL",
	"PATH",
	"LANG",
	"LC_ALL",
	"TZ",
	"DISPLAY",
	"WAYLAND_DISPLAY",
	"XAUTHORITY",
	"XDG_RUNTIME_DIR",
	"DBUS_SESSION_BUS_ADDRESS",
] as const;

export type EndpointOptions = {
	/** The socket to listen on, in a directory the desktop user owns that its group can't write and others can't reach. */
	readonly socketPath: string;
	/** The folder pim-computer serves as `/workspace`: an existing directory the desktop user owns. */
	readonly root: string;
	/** The Chrome or Chromium pim-computer starts for agents. */
	readonly browser: string;
	/** pim-computer.ts, which Node runs. */
	readonly pimComputer: string;
	/** Whether the browser shows its window, as on a desktop. */
	readonly headful?: boolean;
	readonly limits?: Partial<EndpointLimits>;
	/** Where the endpoint's log entries go; by default, `console.error` as JSON. */
	readonly log?: (entry: LogEntry) => void;
	/** Starts pim-computer; `child_process.spawn` unless a test gives its own. */
	readonly spawn?: Spawn;
	/** The effective user ID the endpoint runs as; `process.geteuid()` unless a test gives its own. */
	readonly uid?: number;
	/** The environment `KEPT_ENVIRONMENT` is taken from; `process.env` unless a test gives its own. */
	readonly environment?: Readonly<Record<string, string | undefined>>;
};

export type Endpoint = {
	/** Starts listening, when nothing is at the socket's path. */
	listen(): Promise<void>;
	/** Stops listening, ends the open connection, and resolves once the pim-computer it started has exited. */
	close(): Promise<void>;
};

/** `file`, when it is absolute and is its own real path (no `..`, no link anywhere on it). */
function canonical(file: string, what: string): string {
	let real: string | null = null;
	try {
		real = realpathSync(file);
	} catch {
		// Refused below.
	}
	if (typeof file !== "string" || !path.isAbsolute(file) || real !== file) throw new Error(`The ${what} must be an existing absolute path with no links in it.`);
	return file;
}

/** A program the operator installed: a regular file that neither its group nor others can write. */
function program(file: string, what: string, executable: boolean): string {
	const stat = fs.statSync(canonical(file, what));
	let runnable = true;
	if (executable) {
		try {
			fs.accessSync(file, fs.constants.X_OK);
		} catch {
			runnable = false;
		}
	}
	if (!stat.isFile() || (stat.mode & 0o022) !== 0 || !runnable) throw new Error(`The ${what} must be a regular file${executable ? " the desktop user can run" : ""}, writable by neither its group nor others.`);
	return file;
}

export function createDesktopEndpoint(options: EndpointOptions): Endpoint {
	const uid = options.uid ?? process.geteuid?.();
	if (uid === undefined) throw new Error("The desktop endpoint runs only where users have IDs.");
	if (uid === 0) throw new Error("The desktop endpoint doesn't run as root: run it as the desktop user.");
	const limits: EndpointLimits = { ...DEFAULT_ENDPOINT_LIMITS, ...options.limits };
	for (const [name, value] of Object.entries(limits)) {
		if (!Number.isSafeInteger(value) || value < 1) throw new RangeError(`An endpoint's ${name} must be a positive whole number.`);
	}

	checkSocketPath(options.socketPath);
	const socketPath = options.socketPath;
	const directory = fs.statSync(canonical(path.dirname(socketPath), "session socket's directory"));
	if (!directory.isDirectory() || directory.uid !== uid || (directory.mode & 0o027) !== 0) {
		throw new Error("The session socket's directory must be the desktop user's, writable by no one else, and reachable by no one outside its group.");
	}
	const root = canonical(options.root, "root folder");
	const rootStat = fs.statSync(root);
	if (!rootStat.isDirectory() || rootStat.uid !== uid) throw new Error("The root folder must be a directory the desktop user owns.");
	const pimComputer = program(options.pimComputer, "pim-computer program", false);
	const browser = program(options.browser, "browser", true);

	const environment = options.environment ?? process.env;
	const env: Record<string, string> = {};
	for (const name of KEPT_ENVIRONMENT) {
		const value = environment[name];
		if (value !== undefined) env[name] = value;
	}
	const command = process.execPath;
	const args = [pimComputer, "--stdio", "--root", root, "--chrome", browser, ...(options.headful ? ["--headful"] : [])];
	const spawn: Spawn = options.spawn ?? ((file, argv, spawnOptions) => spawnProcess(file, argv, spawnOptions) as ChildProcess & Child);
	const log = options.log ?? ((entry: LogEntry) => console.error(JSON.stringify(entry)));

	const server = net.createServer();
	server.maxConnections = limits.maxConnections;
	let closing = false;
	/** The pim-computer this endpoint started last, until it has exited. */
	let current: { exited: Promise<void>; done: boolean; end(): void } | null = null;

	function serve(socket: net.Socket): void {
		socket.on("error", () => socket.destroy());
		if (closing || (current && !current.done)) {
			log({ event: "endpoint.refused", reason: closing ? "closing" : "busy" });
			socket.destroy();
			return;
		}
		let child: Child;
		try {
			child = spawn(command, args, { cwd: root, env, stdio: ["pipe", "pipe", "ignore"], shell: false });
		} catch {
			log({ event: "endpoint.refused", reason: "spawn" });
			socket.destroy();
			return;
		}
		const timers: ReturnType<typeof setTimeout>[] = [];
		let inputEnded = false;
		let markExited!: () => void;
		const run = {
			done: false,
			exited: new Promise<void>((resolve) => {
				markExited = resolve;
			}),
			end: () => socket.destroy(),
		};
		current = run;
		log({ event: "endpoint.started" });

		/** The connection is over: pim-computer's input ends, what it says from now goes nowhere, and it has `exitMs` to exit. */
		const transportEnded = () => {
			if (inputEnded) return;
			inputEnded = true;
			socket.unpipe(child.stdin);
			child.stdin.end();
			child.stdout.unpipe(socket);
			// Read and dropped, so a pim-computer still writing as it exits isn't held up.
			child.stdout.on("data", () => {});
			child.stdout.resume();
			if (run.done) return;
			log({ event: "endpoint.input-ended" });
			timers.push(
				setTimeout(() => {
					log({ event: "endpoint.stopping", reason: "SIGTERM" });
					child.kill("SIGTERM");
					timers.push(
						setTimeout(() => {
							log({ event: "endpoint.stopping", reason: "SIGKILL" });
							child.kill("SIGKILL");
						}, limits.closeMs),
					);
				}, limits.exitMs),
			);
		};
		const exited = () => {
			if (run.done) return;
			run.done = true;
			for (const timer of timers) clearTimeout(timer);
			log({ event: "endpoint.exited" });
			// Its output ends the connection when it has all been passed on; a pipe someone else still holds doesn't keep it open past `closeMs`.
			setTimeout(() => {
				socket.destroy();
				child.stdout.destroy();
			}, limits.closeMs).unref();
			markExited();
		};
		child.once("exit", exited);
		// A process that couldn't be started has no ID, and no exit comes for it; any other error (a failed kill) changes nothing.
		child.once("error", () => {
			if (child.pid === undefined) exited();
		});
		child.stdin.on("error", () => socket.destroy());
		child.stdout.on("error", () => socket.destroy());
		socket.on("end", transportEnded);
		socket.on("close", transportEnded);
		socket.pipe(child.stdin, { end: false });
		child.stdout.pipe(socket);
	}

	server.on("connection", serve);

	return {
		async listen() {
			// Whatever is at the path, even a socket an endpoint left when it didn't stop cleanly, is left as it is.
			let existing = true;
			try {
				fs.lstatSync(socketPath);
			} catch (error) {
				existing = (error as NodeJS.ErrnoException).code !== "ENOENT";
			}
			if (existing) throw new Error("Something is already at the session socket's path; it is left as it is.");
			await new Promise<void>((resolve, reject) => {
				server.once("error", reject);
				server.listen({ path: socketPath, exclusive: true }, () => {
					server.off("error", reject);
					resolve();
				});
			});
			fs.chmodSync(socketPath, 0o660);
			const made = fs.lstatSync(socketPath);
			if (!made.isSocket() || made.uid !== uid || made.gid !== directory.gid || (made.mode & 0o777) !== 0o660) {
				await new Promise<void>((resolve) => server.close(() => resolve()));
				throw new Error("The session socket couldn't be given its directory's group and mode 0660.");
			}
			log({ event: "endpoint.listening" });
		},
		async close() {
			closing = true;
			const closed = new Promise<void>((resolve) => server.close(() => resolve()));
			const run = current;
			if (run && !run.done) {
				run.end();
				await run.exited;
			}
			await closed;
		},
	};
}

const USAGE = `The desktop session endpoint of a Cua bridge: starts pim-computer --stdio for each connection on a Unix socket.

  node desktop.ts --socket <path> --root <folder> --browser <path> --pim-computer <path> [--headful]

Run it as the desktop user, never as root. See docs/cua-bridge.md.`;

async function main(): Promise<void> {
	const { parseArgs } = await import("node:util");
	let values: { socket?: string; root?: string; browser?: string; "pim-computer"?: string; headful?: boolean };
	try {
		({ values } = parseArgs({
			options: { socket: { type: "string" }, root: { type: "string" }, browser: { type: "string" }, "pim-computer": { type: "string" }, headful: { type: "boolean" } },
		}));
	} catch {
		values = {};
	}
	if (!values.socket || !values.root || !values.browser || !values["pim-computer"]) {
		console.error(USAGE);
		process.exit(2);
	}
	let endpoint: Endpoint;
	try {
		endpoint = createDesktopEndpoint({ socketPath: values.socket, root: values.root, browser: values.browser, pimComputer: values["pim-computer"], headful: values.headful === true });
		await endpoint.listen();
	} catch (error) {
		console.error(JSON.stringify({ event: "endpoint.failed", reason: error instanceof Error ? error.message : "unknown" }));
		process.exit(1);
	}
	const stop = () => {
		void endpoint.close().then(() => process.exit(0));
	};
	process.once("SIGTERM", stop);
	process.once("SIGINT", stop);
}

// Run as a program, not when tests import it.
if (process.argv[1] && import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href) void main();
