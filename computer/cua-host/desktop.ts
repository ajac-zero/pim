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
 * when the endpoint starts, and no shell is involved. It gets no secret of the
 * bridge's: the bridge's token and TLS key stay in the bridge's account
 * (./bridge.ts).
 *
 * One pim-computer at a time. While the one it started hasn't exited, a new
 * connection is refused (closed unanswered), so two never share the
 * browser's profile. When its connection ends, its input is ended, and, if
 * it hasn't exited after `exitMs`, it is asked to (`SIGTERM`), then ended
 * (`SIGKILL`) after `closeMs`. A connection whose bytes can't be handed on,
 * either way, for `stallMs` (pim-computer not reading its input, or the
 * bridge not reading the socket) is ended the same way, since a paused
 * socket would not notice its peer leaving. That is all the endpoint knows of: only the
 * process it started, never its process group or anything else on the VM.
 * Its exit doesn't show that what it started, or anything else running as
 * the desktop user, has stopped.
 *
 * The socket is an operator's boundary between two accounts, not between
 * agents: anything running as the desktop user can connect to it, as it can
 * run pim-computer itself.
 *
 * An endpoint may be given `cua`: its program gives it only with `--native on`
 * and all four of the Cua computer's settings (`readEndpointArguments`), and
 * refuses to start on anything partial or malformed; without `--native`, or
 * with `--native off`, it starts pim-computer exactly as before. With `cua`,
 * it starts the Cua computer (./cua-computer.ts), pim-computer with a
 * native-app dispatcher for the VM's spacesd, in pim-computer's place, with
 * the same folder, environment, limits and one-at-a-time rule, and never
 * pim-computer: a Cua computer that fails to start is not replaced by one.
 * spacesd's token is the one secret it hands on, and only as a descriptor:
 * for each child it opens the desktop user's credential file
 * (./cua-credential.ts), checks it, hands it over as descriptor 3, and closes
 * its own, once, as soon as the spawn returns or throws, never reading it. A
 * close that fails is not taken as closed: the endpoint refuses every later
 * connection for good, and a child it started then gets its input ended and
 * is watched to its exit as any other, keeping the endpoint busy until then.
 * A descriptor keeps the token out of arguments, environments and logs; it
 * doesn't keep it from the agents, which run as the desktop user and can read
 * the file. The file is opened
 * again for each connection, so a token rotated by replacing the file is
 * used from the next connection on; a child already started keeps the token
 * it read.
 *
 *   node desktop.ts --socket /run/pim-session/session.sock --root /home/desktop/workspace \
 *     --browser /opt/google/chrome/chrome --pim-computer /opt/pim/pim-computer.ts [--headful] \
 *     [--native on --cua-computer /opt/pim/cua-host/cua-computer.ts --cua-owner <space> \
 *      --cua-origin http://127.0.0.1:7443 --cua-credential /home/desktop/.config/pim/spacesd-token]
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
import { parseArgs } from "node:util";
import type { LogEntry } from "../cua-bridge.ts";
import { NATIVE_IDENTITY } from "../native-outcome.ts";
import { type CredentialFiles, CredentialRefused, closeCredential, NODE_CREDENTIAL_FILES, openCredential } from "./cua-credential.ts";
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

/**
 * How pim-computer is started. The endpoint passes fixed values only. A
 * fourth stdio entry, the descriptor of the credential file, is there only
 * for the Cua computer (`EndpointOptions.cua`).
 */
export type SpawnOptions = {
	readonly cwd: string;
	readonly env: Record<string, string>;
	readonly stdio: ["pipe", "pipe", "ignore"] | ["pipe", "pipe", "ignore", number];
	readonly shell: false;
};
export type Spawn = (command: string, args: readonly string[], options: SpawnOptions) => Child;

export type EndpointLimits = {
	/** Sockets the endpoint keeps at once, open or being refused; past it, new ones are dropped. */
	readonly maxConnections: number;
	/** How long pim-computer has to exit after its input ends (it quits its browser first, which may take 15 s) before it is asked to. */
	readonly exitMs: number;
	/** How long it has after being asked before it is ended; and how long its output has to finish after it exits. */
	readonly closeMs: number;
	/**
	 * How long bytes may wait, either way, for the side they go to to take
	 * more (pim-computer's input, or the socket) before the connection is
	 * ended. Each time that side takes more, the wait starts again, so a slow
	 * side that keeps taking is never ended for it.
	 */
	readonly stallMs: number;
};

export const DEFAULT_ENDPOINT_LIMITS: EndpointLimits = { maxConnections: 4, exitMs: 30_000, closeMs: 5_000, stallMs: 30_000 };

/** Why the endpoint refused to start: a fixed reason, which is all its program logs of it. */
export class EndpointRefused extends Error {
	readonly reason: string;
	constructor(reason: string, message: string) {
		super(message);
		this.reason = reason;
	}
}

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
	/**
	 * Starts the Cua computer (./cua-computer.ts) in place of pim-computer,
	 * with a native-app dispatcher for this VM's spacesd. Absent, as the
	 * endpoint's program leaves it without `--native on`, the endpoint starts
	 * pim-computer exactly as before. No variable, installer step or service
	 * gives it.
	 */
	readonly cua?: CuaChild;
	/** What the credential file is opened with; Node's `fs` unless a test gives its own. */
	readonly credentialFiles?: CredentialFiles;
	/** What takes the socket's connections; `net.createServer()` unless a test gives its own, which then hands it connections without listening. */
	readonly listener?: EndpointListener;
};

/** What the endpoint takes connections from: a `net.Server`, or a test's stand-in. */
export type EndpointListener = Pick<net.Server, "on" | "once" | "off" | "listen" | "close"> & { maxConnections: number };

/**
 * The Cua computer's fixed settings. The owner and origin go in its
 * arguments; the token doesn't go anywhere but the descriptor it reads.
 */
export type CuaChild = {
	/** cua-computer.ts, which Node runs, checked as pim-computer is. */
	readonly program: string;
	/** The space whose VM this is. */
	readonly owner: string;
	/** spacesd's origin: `https://host[:port]`, or `http://` on a loopback host. */
	readonly origin: string;
	/**
	 * spacesd's token, in a file of the desktop user's, mode 0600, with one
	 * name, at a path with no links (./cua-credential.ts). It is opened for
	 * each child and handed over as descriptor 3, never read here.
	 */
	readonly credentialFile: string;
};

export type Endpoint = {
	/** Starts listening, when nothing is at the socket's path. */
	listen(): Promise<void>;
	/**
	 * Stops listening, ends the open connection, and resolves once the
	 * pim-computer it started is seen to exit. After `SIGKILL` that is up to
	 * the OS: if it never reports the exit, this never resolves, rather than
	 * take a signal for an exit.
	 */
	close(): Promise<void>;
};

/** `file`, when it is absolute and is its own real path (no `..`, no link anywhere on it). */
function canonical(file: string, what: string, reason: string): string {
	let real: string | null = null;
	try {
		real = realpathSync(file);
	} catch {
		// Refused below.
	}
	if (typeof file !== "string" || !path.isAbsolute(file) || real !== file) throw new EndpointRefused(reason, `The ${what} must be an existing absolute path with no links in it.`);
	return file;
}

/** A program the operator installed: a regular file that neither its group nor others can write. */
function program(file: string, what: string, reason: string, executable: boolean): string {
	const stat = fs.statSync(canonical(file, what, reason));
	let runnable = true;
	if (executable) {
		try {
			fs.accessSync(file, fs.constants.X_OK);
		} catch {
			runnable = false;
		}
	}
	if (!stat.isFile() || (stat.mode & 0o022) !== 0 || !runnable) throw new EndpointRefused(reason, `The ${what} must be a regular file${executable ? " the desktop user can run" : ""}, writable by neither its group nor others.`);
	return file;
}

/** Whether `origin` is exactly `https://host[:port]`, or `http://` on a loopback host: what `createNativeMcp` takes, which the Cua computer checks again. */
function exactOrigin(origin: unknown): boolean {
	if (typeof origin !== "string") return false;
	let url: URL;
	try {
		url = new URL(origin);
	} catch {
		return false;
	}
	const loopback = ["127.0.0.1", "[::1]", "localhost"].includes(url.hostname);
	return url.origin === origin && (url.protocol === "https:" || (url.protocol === "http:" && loopback));
}

/**
 * The Cua computer's settings, read once and checked: its program as
 * pim-computer's is, the owner and origin as the dispatcher takes them, and a
 * credential file that opens as `openCredential` requires, which is opened,
 * checked and closed again here, unread.
 */
function cuaChild(cua: CuaChild, uid: number, files: CredentialFiles): CuaChild {
	const { program: file, owner, origin, credentialFile } = cua;
	const checked = { program: program(file, "Cua computer program", "cua-computer", false), owner, origin, credentialFile };
	if (typeof owner !== "string" || !NATIVE_IDENTITY.test(owner)) throw new EndpointRefused("cua-owner", "The Cua computer's owner must be a space's identity.");
	if (!exactOrigin(origin)) throw new EndpointRefused("cua-origin", "spacesd's origin must be exactly https://host[:port], or http:// on a loopback host.");
	try {
		closeCredential(openCredential(credentialFile, uid, files), files);
	} catch (error) {
		// A descriptor that couldn't be closed may still be open in this process: say so, apart from a file that was refused.
		if (error instanceof CredentialRefused && error.retained) {
			throw new EndpointRefused("credential-close", "The spacesd credential couldn't be closed after it was checked, so a descriptor of it may still be open in this process.");
		}
		throw new EndpointRefused("credential", "The spacesd credential must be a regular file of the desktop user's, mode 0600, with one name, at a path with no links, and no larger than a token.");
	}
	return Object.freeze(checked);
}

export function createDesktopEndpoint(options: EndpointOptions): Endpoint {
	const uid = options.uid ?? process.geteuid?.();
	if (uid === undefined) throw new EndpointRefused("user", "The desktop endpoint runs only where users have IDs.");
	if (uid === 0) throw new EndpointRefused("root-user", "The desktop endpoint doesn't run as root: run it as the desktop user.");
	const limits: EndpointLimits = { ...DEFAULT_ENDPOINT_LIMITS, ...options.limits };
	for (const [name, value] of Object.entries(limits)) {
		if (!Number.isSafeInteger(value) || value < 1) throw new EndpointRefused("limits", `An endpoint's ${name} must be a positive whole number.`);
	}

	try {
		checkSocketPath(options.socketPath);
	} catch {
		throw new EndpointRefused("socket-path", "The session socket's path must be absolute and normalized, short enough for a Unix socket.");
	}
	const socketPath = options.socketPath;
	const directory = fs.statSync(canonical(path.dirname(socketPath), "session socket's directory", "socket-directory"));
	if (!directory.isDirectory() || directory.uid !== uid || (directory.mode & 0o027) !== 0) {
		throw new EndpointRefused("socket-directory", "The session socket's directory must be the desktop user's, writable by no one else, and reachable by no one outside its group.");
	}
	const root = canonical(options.root, "root folder", "root-folder");
	const rootStat = fs.statSync(root);
	if (!rootStat.isDirectory() || rootStat.uid !== uid) throw new EndpointRefused("root-folder", "The root folder must be a directory the desktop user owns.");
	const pimComputer = program(options.pimComputer, "pim-computer program", "pim-computer", false);
	const browser = program(options.browser, "browser", "browser", true);

	const files = options.credentialFiles ?? NODE_CREDENTIAL_FILES;
	const cua = options.cua ? cuaChild(options.cua, uid, files) : undefined;

	const environment = options.environment ?? process.env;
	const env: Record<string, string> = {};
	for (const name of KEPT_ENVIRONMENT) {
		const value = environment[name];
		if (value !== undefined) env[name] = value;
	}
	const command = process.execPath;
	const args = cua
		? [cua.program, "--root", root, "--chrome", browser, "--owner", cua.owner, "--origin", cua.origin, ...(options.headful ? ["--headful"] : [])]
		: [pimComputer, "--stdio", "--root", root, "--chrome", browser, ...(options.headful ? ["--headful"] : [])];
	const spawn: Spawn = options.spawn ?? ((file, argv, spawnOptions) => spawnProcess(file, argv, spawnOptions) as ChildProcess & Child);
	const log = options.log ?? ((entry: LogEntry) => console.error(JSON.stringify(entry)));

	const server: EndpointListener = options.listener ?? net.createServer();
	server.maxConnections = limits.maxConnections;
	let closing = false;
	/** The pim-computer this endpoint started last, until it has exited. */
	let current: { exited: Promise<void>; done: boolean; end(): void } | null = null;
	/**
	 * Set, for good, when a descriptor of the Cua computer's credential
	 * couldn't be closed: the endpoint may still hold it, so it takes no
	 * other connection and opens the file no more. A child already started
	 * is ended and watched as any other, until its exit is seen.
	 */
	let retained = false;

	function serve(socket: net.Socket): void {
		socket.on("error", () => socket.destroy());
		if (closing || retained || (current && !current.done)) {
			log({ event: "endpoint.refused", reason: closing ? "closing" : retained ? "credential-close" : "busy" });
			socket.destroy();
			return;
		}
		// The Cua computer's credential, opened afresh for each child and checked again; refused, nothing starts.
		let credential: number | undefined = undefined;
		if (cua) {
			try {
				credential = openCredential(cua.credentialFile, uid, files);
			} catch (error) {
				// Refused after opening it, and then not closed: nothing more is opened or started.
				if (error instanceof CredentialRefused && error.retained) retained = true;
				log({ event: "endpoint.refused", reason: retained ? "credential-close" : "credential" });
				socket.destroy();
				return;
			}
		}
		let spawned: Child | undefined;
		try {
			spawned = spawn(command, args, { cwd: root, env, stdio: credential === undefined ? ["pipe", "pipe", "ignore"] : ["pipe", "pipe", "ignore", credential], shell: false });
		} catch {
			// Nothing started; the descriptor is closed below.
		}
		// The child has its own copy once the spawn returns (Node starts it before returning), so the endpoint closes its own, started or not.
		// Closed once: a close that throws is never taken as closed, and the number isn't closed again.
		let unclosed = false;
		if (credential !== undefined) {
			try {
				closeCredential(credential, files);
			} catch {
				// Logged only once a child that was started is tracked, so nothing can leave it untracked.
				unclosed = true;
				retained = true;
			}
		}
		if (!spawned) {
			if (unclosed) log({ event: "endpoint.refused", reason: "credential-close" });
			log({ event: "endpoint.refused", reason: "spawn" });
			socket.destroy();
			return;
		}
		const child = spawned;
		const timers: ReturnType<typeof setTimeout>[] = [];
		let ended = false;
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

		/** A wait, per way bytes go, for the side they go to to take more; past `stallMs`, the connection ends. */
		const stalls = new Map<"input" | "output", ReturnType<typeof setTimeout>>();
		/** Hands `chunk` on to `to`; when `to` holds all it will, `from` is paused until `to` takes more. */
		const forward = (way: "input" | "output", from: Readable, to: Writable, chunk: Buffer) => {
			if (ended || to.write(chunk) || stalls.has(way)) return;
			from.pause();
			stalls.set(
				way,
				setTimeout(() => {
					log({ event: "endpoint.stalled", reason: way });
					socket.destroy();
				}, limits.stallMs),
			);
			to.once("drain", () => {
				clearTimeout(stalls.get(way));
				stalls.delete(way);
				if (!ended) from.resume();
			});
		};

		/** The connection is over: pim-computer's input ends, what it says from now goes nowhere, and it has `exitMs` to exit. */
		const transportEnded = () => {
			if (ended) return;
			ended = true;
			for (const stall of stalls.values()) clearTimeout(stall);
			stalls.clear();
			child.stdin.end();
			// Read and dropped, so a pim-computer still writing as it exits isn't held up.
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
		// Only an exit the OS reports counts: a signal sent is not an exit, and the endpoint stays busy until one comes.
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
		socket.on("data", (chunk: Buffer) => forward("input", socket, child.stdin, chunk));
		child.stdout.on("data", (chunk: Buffer) => forward("output", child.stdout, socket, chunk));
		child.stdout.on("end", () => {
			if (!ended) socket.end();
		});
		// Started, but the endpoint couldn't close its copy of the credential: the child is tracked like any
		// other, but carries nothing. Its input ends now, so it has `exitMs` to exit, then SIGTERM and SIGKILL,
		// and the endpoint stays busy until its exit is seen, then refuses every connection (`retained`).
		if (unclosed) {
			transportEnded();
			socket.destroy();
			log({ event: "endpoint.refused", reason: "credential-close" });
		}
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
			if (existing) throw new EndpointRefused("socket-exists", "Something is already at the session socket's path; it is left as it is.");
			await new Promise<void>((resolve, reject) => {
				const failed = () => reject(new EndpointRefused("listen", "The endpoint couldn't listen on the session socket."));
				server.once("error", failed);
				server.listen({ path: socketPath, exclusive: true }, () => {
					server.off("error", failed);
					resolve();
				});
			});
			fs.chmodSync(socketPath, 0o660);
			const made = fs.lstatSync(socketPath);
			if (!made.isSocket() || made.uid !== uid || made.gid !== directory.gid || (made.mode & 0o777) !== 0o660) {
				await new Promise<void>((resolve) => server.close(() => resolve()));
				throw new EndpointRefused("socket-mode", "The session socket couldn't be given its directory's group and mode 0660.");
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

const USAGE = `The desktop session endpoint of a Cua bridge: starts pim-computer --stdio for each connection on a Unix socket,
or, with --native on, the Cua computer, with a native-app dispatcher for this VM's spacesd.

  node desktop.ts --socket <path> --root <folder> --browser <path> --pim-computer <path> [--headful]
    [--native on --cua-computer <path> --cua-owner <space> --cua-origin <spacesd origin> --cua-credential <file>]

--native off, or no --native, starts pim-computer and takes no Cua setting; an ordinary setting given twice keeps its last value.
With --native on, every setting is given exactly once, and --native and the Cua settings are never given twice.
Run it as the desktop user, never as root. See docs/cua-bridge.md.`;

/** The Cua computer's settings, each given with `--native on` and only then. */
const CUA_FLAGS = ["cua-computer", "cua-owner", "cua-origin", "cua-credential"] as const;

/** What the endpoint's program was asked to start, read from its arguments. */
export type EndpointArguments = {
	readonly socketPath: string;
	readonly root: string;
	readonly browser: string;
	readonly pimComputer: string;
	readonly headful: boolean;
	/** The Cua computer's settings with `--native on`; absent otherwise, and pim-computer starts as before. */
	readonly cua?: CuaChild;
};

/**
 * Reads the endpoint program's arguments. `usage` for an unknown or missing
 * setting, `--native` or a Cua setting given twice, or any setting given
 * twice with `--native on`; without it, an ordinary setting given twice keeps
 * its last value, as the program always has. `native-settings` for a Cua
 * setting without `--native on`,
 * `--native on` without all four, an empty one, or `--native` other than `on`
 * or `off`. Nothing is checked on disk here: `createDesktopEndpoint` checks
 * the Cua computer's program, owner, origin and credential file.
 */
export function readEndpointArguments(argv: readonly string[]): EndpointArguments {
	let parsed: ReturnType<typeof parseEndpointArguments>;
	try {
		parsed = parseEndpointArguments(argv);
	} catch {
		throw new EndpointRefused("usage", USAGE);
	}
	const values = parsed.values;
	// An ordinary setting given twice keeps its last value, as the program always has, unless --native is on;
	// --native and the Cua settings are never taken twice, and with --native on no setting is.
	const counts = new Map<string, number>();
	for (const token of parsed.tokens) if (token.kind === "option") counts.set(token.name, (counts.get(token.name) ?? 0) + 1);
	const strict = new Set<string>(values.native === "on" ? counts.keys() : ["native", ...CUA_FLAGS]);
	if ([...counts].some(([name, count]) => count > 1 && strict.has(name))) throw new EndpointRefused("usage", USAGE);
	const { socket, root, browser } = values;
	const pimComputer = values["pim-computer"];
	if (!socket || !root || !browser || !pimComputer) throw new EndpointRefused("usage", USAGE);
	const base = { socketPath: socket, root, browser, pimComputer, headful: values.headful === true };
	const given = CUA_FLAGS.filter((name) => values[name] !== undefined);
	if (values.native === undefined || values.native === "off") {
		if (given.length > 0) throw new EndpointRefused("native-settings", "The Cua computer's settings are taken only with --native on.");
		return base;
	}
	if (values.native !== "on") throw new EndpointRefused("native-settings", "--native is on or off.");
	if (given.length !== CUA_FLAGS.length || CUA_FLAGS.some((name) => values[name] === "")) {
		throw new EndpointRefused("native-settings", "With --native on, --cua-computer, --cua-owner, --cua-origin and --cua-credential are each given.");
	}
	return {
		...base,
		cua: { program: values["cua-computer"]!, owner: values["cua-owner"]!, origin: values["cua-origin"]!, credentialFile: values["cua-credential"]! },
	};
}

function parseEndpointArguments(argv: readonly string[]) {
	return parseArgs({
		args: [...argv],
		strict: true,
		allowPositionals: false,
		tokens: true,
		options: {
			socket: { type: "string" },
			root: { type: "string" },
			browser: { type: "string" },
			"pim-computer": { type: "string" },
			headful: { type: "boolean" },
			native: { type: "string" },
			"cua-computer": { type: "string" },
			"cua-owner": { type: "string" },
			"cua-origin": { type: "string" },
			"cua-credential": { type: "string" },
		},
	});
}

async function main(): Promise<void> {
	let settings: EndpointArguments;
	try {
		settings = readEndpointArguments(process.argv.slice(2));
	} catch (error) {
		const reason = error instanceof EndpointRefused ? error.reason : "usage";
		if (reason === "usage") console.error(USAGE);
		else console.error(JSON.stringify({ event: "endpoint.failed", reason }));
		process.exit(2);
	}
	let endpoint: Endpoint;
	let stage = "settings";
	try {
		endpoint = createDesktopEndpoint({ ...settings });
		stage = "listen";
		await endpoint.listen();
	} catch (error) {
		// Only a fixed reason: what Node threw may name paths or anything else.
		console.error(JSON.stringify({ event: "endpoint.failed", reason: error instanceof EndpointRefused ? error.reason : stage }));
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
