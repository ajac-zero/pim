/**
 * Recovers the desktop endpoint of a retained Cua evaluation VM whose first bundle was missing two files its
 * program imports (docs/cua-viewer-first-startup.md, "A live failure in the first bundle, and its recovery").
 * It runs as root, from the NEW bundle (a new, versioned directory the recovery fetch made and verified), with
 * the NEW configuration on standard input:
 *
 *   node recover.ts < config.json
 *
 * This is not a general restart. `start` (./install.ts) refuses a desktop endpoint that ended any way but cleanly,
 * and refuses once the bridge has made its journal lock; both stay as they are. This is the one separate, narrow
 * path, and it refuses unless every one of these holds, each read and none assumed:
 *
 * - the endpoint's unit is exactly what the installer wrote for the bundle it names, and that bundle is not the new one;
 * - systemd says its one main process exited with status 1, within seconds of starting, and nothing of its cgroup runs;
 * - the endpoint's own journal names `ERR_MODULE_NOT_FOUND` for one of the two missing files and no line of the endpoint
 *   itself, so it ended while Node was loading its modules, before any of its code ran: it made no socket, opened no
 *   credential and started no pim-computer, which is why it left nothing behind and why it may start again;
 * - the session socket is absent;
 * - the bridge, spacesd and the ingress are running, so only the desktop is wrong;
 * - the new bundle holds every file of the old one but its marker, byte for byte, and adds only the files named below.
 *
 * What it changes is one file: the desktop unit, now naming the new bundle. The old unit is kept beside it by a hard
 * link, never replaced; the old bundle, the bridge's unit, the journal and its lock, every token and key, and the owner's
 * state are not read, written or removed. The bridge, spacesd and the ingress are not touched or restarted. Then
 * `daemon-reload` and one `start` of the desktop endpoint, no retry. A second run for the same bundle refuses, because the
 * unit then already names it.
 *
 * It prints metadata only, as fixed JSON; a failure says only a fixed reason and the step. The checks are pure over a
 * `RecoveryProbe` and the changes go through a `RecoveryHost`, so tests give them stand-ins.
 */

import * as crypto from "node:crypto";
import * as fs from "node:fs";
import { realpathSync } from "node:fs";
import * as path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { BUNDLE_FILES, type Config, parseConfig, PATHS, Refusal, renderUnits, TOOLS, UNITS, VIEWER_UNITS } from "./config.ts";
import { checkUnits, type Host, parsePasswd, type Probe, readText, SHOW_UNIT, systemHost, unitState } from "./install.ts";

const JOURNALCTL = "/usr/bin/journalctl";

/** This program, in the bundle. */
export const RECOVER_FILE = "computer/cua-host/eval-install/recover.ts";

/** The only files the new bundle may hold that the old one did not: what the first bundle left out, and this program. */
export const RECOVERY_ADDED = ["computer/native-outcome.ts", "computer/cua-host/cua-credential.ts", RECOVER_FILE] as const;

/** The longest the failed main process may have run: a module that couldn't be linked ends in well under a second. */
export const RECOVERY_MAX_RUN_US = 30_000_000n;

/** At most this many entries are read from either bundle, each at most `MAX_FILE_BYTES`. */
const MAX_ENTRIES = 4096;
const MAX_FILE_BYTES = 16 * 1024 * 1024;

export type RecoveryProbe = Probe & {
	/** Every regular file under `dir`, relative path to SHA-256; `null` if `dir` isn't a directory, holds anything but directories and regular files, or is too big. */
	digests(dir: string): Record<string, string> | null;
};

export type RecoveryHost = Pick<Host, "writeNew" | "run" | "query"> & {
	/** Makes `created` another name for `existing`, never over anything, and flushes the directory. */
	linkNew(existing: string, created: string): void;
	/** Renames `from` over `to`, in one directory, and flushes the directory. */
	renameOver(from: string, to: string): void;
};

/** Where a change stopped: the step, a fixed reason, and whether anything on the VM had changed by then. */
export class RecoveryFailure extends Error {
	readonly step: string;
	readonly reason: string;
	readonly changed: boolean;
	constructor(step: string, reason: string, changed: boolean) {
		super(reason);
		this.step = step;
		this.reason = reason;
		this.changed = changed;
	}
}

type State = NonNullable<ReturnType<typeof unitState>>;

const running = (state: State | null) => state?.LoadState === "loaded" && state.ActiveState === "active" && state.SubState === "running";

/** Whether the old bundle's digests and the new one's are those of a bundle and the same bundle with only the permitted files added. */
export function compareBundles(oldBundle: Record<string, string>, newBundle: Record<string, string>): "bundle-differs" | "bundle-extra" | "bundle-incomplete" | null {
	for (const [file, digest] of Object.entries(oldBundle)) if (file !== BUNDLE_FILES.marker && newBundle[file] !== digest) return "bundle-differs";
	for (const file of Object.keys(newBundle)) if (!Object.hasOwn(oldBundle, file) && !(RECOVERY_ADDED as readonly string[]).includes(file)) return "bundle-extra";
	if (!Object.hasOwn(newBundle, BUNDLE_FILES.marker) || !RECOVERY_ADDED.every((file) => Object.hasOwn(newBundle, file))) return "bundle-incomplete";
	return null;
}

/**
 * Everything that must hold, read before anything changes. Answers what the change needs: the old bundle's directory, the unit the installer wrote for it,
 * and the unit to write. Throws a `Refusal` with a fixed reason at the first thing that doesn't hold.
 */
export function checkRecoverable(config: Config, probe: RecoveryProbe): { oldDir: string; installed: string; next: string } {
	const desktop = parsePasswd(probe.readText("/etc/passwd") ?? "").find((user) => user.name === "pim-desktop");
	if (!desktop) throw new Refusal("accounts");
	// The unit: a regular file of root's, 0644, exactly what the installer renders for the bundle it names.
	const file = probe.lstat(PATHS.desktopUnit);
	const installed = probe.readText(PATHS.desktopUnit);
	if (file?.kind !== "file" || file.uid !== 0 || (file.mode & 0o7777) !== 0o644 || installed === null) throw new Refusal("unit-missing");
	const named = /^ExecStart=\S+ (\/\S+)\/computer\/cua-host\/desktop\.ts /m.exec(installed);
	const oldDir = named?.[1];
	if (!oldDir) throw new Refusal("unit-drift");
	if (oldDir === config.bundle.dir) throw new Refusal("already-recovered");
	if (renderUnits({ ...config, bundle: { ...config.bundle, dir: oldDir } }, desktop.uid).desktop !== installed) throw new Refusal("unit-drift");
	const next = renderUnits(config, desktop.uid).desktop;

	// The endpoint's end: its one main process exited with status 1, soon after it started.
	const state = unitState(probe.query, UNITS.desktop);
	if (!state || state.LoadState !== "loaded" || state.ActiveState !== "failed" || state.SubState !== "failed" || state.Result !== "exit-code") throw new Refusal("desktop-state");
	const started = BigInt(state.ExecMainStartTimestampMonotonic);
	const exited = BigInt(state.ExecMainExitTimestampMonotonic);
	if (state.ExecMainCode !== "1" || state.ExecMainStatus !== "1" || BigInt(state.ExecMainPID) === 0n || started === 0n || exited < started || exited - started > RECOVERY_MAX_RUN_US) throw new Refusal("desktop-exit");
	// Nothing of its cgroup runs (KillMode=process leaves a child there), and no process is its main one.
	const group = probe.query([TOOLS.systemctl, "show", "--property=MainPID,ControlGroup", UNITS.desktop]);
	const lines = group.stdout.split("\n").filter(Boolean);
	const mainPid = lines.find((line) => line.startsWith("MainPID="));
	const cgroup = lines.find((line) => line.startsWith("ControlGroup="));
	if (group.status !== 0 || lines.length !== 2 || mainPid !== "MainPID=0" || cgroup === undefined) throw new Refusal("desktop-processes");
	const where = cgroup.slice("ControlGroup=".length);
	if (where !== "") {
		if (!/^\/[A-Za-z0-9._@/-]*$/.test(where) || where.split("/").includes("..")) throw new Refusal("desktop-processes");
		const members = probe.readText(`/sys/fs/cgroup${where}/cgroup.procs`);
		if (members === null ? probe.lstat(`/sys/fs/cgroup${where}`) !== null : members !== "") throw new Refusal("desktop-processes");
	}
	if (probe.lstat(PATHS.socket) !== null) throw new Refusal("socket-present");

	// Why it ended: Node couldn't load one of the two files, and the endpoint never spoke.
	const journal = probe.query([JOURNALCTL, "-u", UNITS.desktop, "-n", "12", "--no-pager", "-o", "cat"]);
	if (journal.status !== 0 || !journal.stdout.includes("ERR_MODULE_NOT_FOUND") || !/native-outcome\.ts|cua-credential\.ts/.test(journal.stdout) || /"event":\s*"endpoint\./.test(journal.stdout)) throw new Refusal("failure-not-recognized");

	// Only the desktop is wrong: the rest of the stack is up, and stays untouched.
	const others = config.viewer ? [UNITS.bridge, VIEWER_UNITS.spacesd, VIEWER_UNITS.ingress] : [UNITS.bridge];
	for (const unit of others) if (!running(unitState(probe.query, unit))) throw new Refusal("stack-not-running");

	// The old bundle is still there and the new one is the old one and nothing but the permitted files.
	const oldBundle = probe.digests(oldDir);
	const newBundle = probe.digests(config.bundle.dir);
	if (!oldBundle || !newBundle) throw new Refusal("bundle-unreadable");
	const difference = compareBundles(oldBundle, newBundle);
	if (difference) throw new Refusal(difference);
	return { oldDir, installed, next };
}

/** What it did, as fixed metadata: nothing here is read from a secret file. */
export type Recovered = { readonly bundle: string; readonly previousBundle: string; readonly supersededUnit: string; readonly desktop: { readonly active: string; readonly sub: string } | null };

/** The checks, then the one change: the unit, `daemon-reload`, one `start`. */
export function recoverDesktop(config: Config, probe: RecoveryProbe, host: RecoveryHost): Recovered {
	const { oldDir, installed, next } = checkRecoverable(config, probe);
	const staged = `${PATHS.desktopUnit}.next-${config.bundle.sha256.slice(0, 12)}`;
	const superseded = `${PATHS.desktopUnit}.superseded-${crypto.createHash("sha256").update(installed).digest("hex").slice(0, 12)}`;
	let changed = false;
	const step = <T>(name: string, run: () => T): T => {
		try {
			return run();
		} catch (error) {
			throw new RecoveryFailure(name, error instanceof Refusal ? error.reason : "failed", changed);
		}
	};
	step("write", () => host.writeNew(staged, Buffer.from(next), 0o644, 0, 0));
	changed = true;
	step("keep", () => host.linkNew(PATHS.desktopUnit, superseded));
	step("replace", () => host.renameOver(staged, PATHS.desktopUnit));
	step("reload", () => host.run([TOOLS.systemctl, "daemon-reload"]));
	step("check", () => checkUnits((unit) => host.query(SHOW_UNIT(unit)).stdout, Boolean(config.viewer)));
	step("start", () => host.run([TOOLS.systemctl, "start", UNITS.desktop]));
	const after = unitState(probe.query, UNITS.desktop);
	return { bundle: config.bundle.dir, previousBundle: oldDir, supersededUnit: superseded, desktop: after ? { active: after.ActiveState, sub: after.SubState } : null };
}

// ---- The real VM ----

function syncDirectory(dir: string): void {
	const descriptor = fs.openSync(dir, fs.constants.O_RDONLY | fs.constants.O_DIRECTORY | fs.constants.O_NOFOLLOW);
	try {
		fs.fsyncSync(descriptor);
	} finally {
		fs.closeSync(descriptor);
	}
}

/** Regular files and directories only, never a link, at most `MAX_ENTRIES`, each file at most `MAX_FILE_BYTES`. */
function digestsOf(dir: string): Record<string, string> | null {
	const out: Record<string, string> = {};
	let entries = 0;
	const walk = (relative: string): boolean => {
		for (const name of fs.readdirSync(path.join(dir, relative)).sort()) {
			const child = relative ? `${relative}/${name}` : name;
			const stat = fs.lstatSync(path.join(dir, child));
			if (++entries > MAX_ENTRIES) return false;
			if (stat.isDirectory()) {
				if (!walk(child)) return false;
			} else if (stat.isFile() && stat.size <= MAX_FILE_BYTES) {
				out[child] = crypto.createHash("sha256").update(fs.readFileSync(path.join(dir, child))).digest("hex");
			} else {
				return false;
			}
		}
		return true;
	};
	try {
		return fs.lstatSync(dir).isDirectory() && walk("") ? out : null;
	} catch {
		return null;
	}
}

function lstatFact(file: string): ReturnType<Probe["lstat"]> {
	try {
		const stat = fs.lstatSync(file);
		const kind = stat.isSymbolicLink() ? "link" : stat.isFile() ? "file" : stat.isDirectory() ? "dir" : stat.isSocket() ? "socket" : "other";
		return { kind, uid: stat.uid, gid: stat.gid, mode: stat.mode & 0o7777 };
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT" || (error as NodeJS.ErrnoException).code === "ENOTDIR") return null;
		throw new Refusal("inspect");
	}
}

function realHost(): RecoveryHost {
	const system = systemHost();
	return {
		writeNew: system.writeNew,
		run: system.run,
		query: system.query,
		linkNew(existing, created) {
			fs.linkSync(existing, created);
			syncDirectory(path.dirname(created));
		},
		renameOver(from, to) {
			fs.renameSync(from, to);
			syncDirectory(path.dirname(to));
		},
	};
}

function say(entry: Record<string, unknown>, stream: "stdout" | "stderr" = "stdout"): void {
	process[stream].write(`${JSON.stringify(entry)}\n`);
}

async function main(argv: string[]): Promise<void> {
	if (argv.length !== 0) {
		process.stderr.write("Recovers the desktop endpoint of a retained Cua evaluation VM, as root, with the new configuration on standard input. See docs/cua-viewer-first-startup.md.\n");
		process.exit(2);
	}
	let step = "config";
	try {
		if (process.geteuid?.() !== 0) throw new Refusal("root-required");
		const chunks: Buffer[] = [];
		let length = 0;
		for await (const chunk of process.stdin) {
			length += (chunk as Buffer).length;
			if (length > 64 * 1024) throw new Refusal("config-size");
			chunks.push(chunk as Buffer);
		}
		const config = parseConfig(Buffer.concat(chunks).toString("utf8"));
		// This program must be the verified new bundle's own copy, run by the pinned Node.
		if (fileURLToPath(import.meta.url) !== `${config.bundle.dir}/${RECOVER_FILE}`) throw new Refusal("recover-path");
		if (process.execPath !== config.node.path) throw new Refusal("node-path");
		step = "recover";
		const host = realHost();
		const probe: RecoveryProbe = { lstat: lstatFact, readText: (file) => readText(file), query: host.query, digests: digestsOf };
		say({ event: "pim-cua-eval.desktop-recovered", ...recoverDesktop(config, probe, host) });
	} catch (error) {
		if (error instanceof RecoveryFailure) say({ event: "pim-cua-eval.failed", command: "recover-desktop", step: error.step, reason: error.reason, changed: error.changed }, "stderr");
		else say({ event: "pim-cua-eval.failed", command: "recover-desktop", step, reason: error instanceof Refusal ? error.reason : "internal" }, "stderr");
		process.exit(1);
	}
}

// Run as a program, never when imported.
if (process.argv[1] && import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href) void main(process.argv.slice(2));
