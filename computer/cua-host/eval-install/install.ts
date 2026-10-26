/**
 * Installs a Cua evaluation's bridge and desktop endpoint on a new,
 * disposable Ubuntu 24.04 VM (docs/cua-eval-install.md). It runs as root,
 * from the bundle the management script has already verified against the
 * operator's pinned digest, with the configuration (./config.ts) on its
 * standard input:
 *
 *   node install.ts plan|install|start|status < config.json
 *
 * - `plan` reads the VM and prints what `install` would do, or why it
 *   refuses; it changes nothing.
 * - `install` checks every prerequisite first, refuses any account, group or
 *   path of its own that is already there, then makes the bridge's account
 *   and the session group, the bridge's private directory with its TLS
 *   certificate and key, the evaluation's public key, the workspace, the
 *   socket directory's tmpfiles.d entry, and the two services, checked to
 *   have no drop-in and enabled but not started. It never reuses, deletes or recursively changes anything it
 *   didn't make, and it doesn't undo a step that failed: the VM is then
 *   discarded.
 * - `start` starts the two services once the bridge's token is there, and
 *   only while systemd says the desktop endpoint runs, never ran, or last
 *   stopped with its result `success`; any other end means a reboot or a
 *   new VM.
 * - `status` prints metadata only: accounts, owners and modes, the
 *   certificate's fingerprint and dates, whether the desktop account is
 *   refused each secret file, and the services' states as systemd says them.
 *
 * It reads no token and prints no file's contents. What it prints is fixed
 * JSON; a failure says only a fixed reason and the step. The planner is
 * pure (`plan` over `Facts`), so tests give it synthetic VMs; what it does
 * goes through `Host`, so tests give it stand-ins.
 */

import { execFileSync, spawnSync } from "node:child_process";
import * as crypto from "node:crypto";
import * as fs from "node:fs";
import { realpathSync } from "node:fs";
import * as path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { ACCOUNTS, BUNDLE_FILES, BUNDLE_FORMAT, type Config, MIN_NODE, nodeVersionAtLeast, PATHS, parseConfig, Refusal, renderTmpfiles, renderUnits, TOOLS, UNITS, within } from "./config.ts";

export type PathFact = { readonly kind: "file" | "dir" | "link" | "socket" | "other"; readonly uid: number; readonly gid: number; readonly mode: number } | null;

/** What the planner knows of the VM: read once, before anything changes. */
export type Facts = {
	readonly euid: number;
	readonly execPath: string;
	readonly nodeVersion: string;
	/** /usr/lib/os-release, the canonical file /etc/os-release links to on Ubuntu; `null` when it can't be read as a regular file. */
	readonly osRelease: string | null;
	/** /etc/passwd and /etc/group; `null` when unreadable. */
	readonly passwd: string | null;
	readonly group: string | null;
	/**
	 * /etc/sudoers and every entry of /etc/sudoers.d, each `null` when it
	 * can't be read as a regular file; the whole `null` when the directory
	 * can't be listed. Only searched for the installation's account names.
	 */
	readonly sudoers: readonly (string | null)[] | null;
	/** `lstat` of every path in `inspectedPaths`, and of each directory above it; `null` when nothing is there. */
	readonly paths: Readonly<Record<string, PathFact>>;
	readonly browserSha256: string | null;
	readonly bundleMarker: string | null;
	/** /proc/sys/kernel/yama/ptrace_scope, at 1 or more, as docs/cua-bridge.md assumes of the OS. */
	readonly ptraceScope: string | null;
};

export type User = { readonly name: string; readonly uid: number; readonly gid: number; readonly home: string; readonly shell: string };
export type Group = { readonly name: string; readonly gid: number; readonly members: readonly string[] };

export function parsePasswd(text: string): User[] {
	return text
		.split("\n")
		.filter((line) => line && !line.startsWith("#"))
		.map((line) => {
			const [name = "", , uid = "", gid = "", , home = "", shell = ""] = line.split(":");
			return { name, uid: Number(uid), gid: Number(gid), home, shell };
		});
}

export function parseGroup(text: string): Group[] {
	return text
		.split("\n")
		.filter((line) => line && !line.startsWith("#"))
		.map((line) => {
			const [name = "", , gid = "", members = ""] = line.split(":");
			return { name, gid: Number(gid), members: members ? members.split(",") : [] };
		});
}

/** `file` and every directory above it, from `/` down. */
function chain(file: string): string[] {
	const out = ["/"];
	let current = "";
	for (const part of file.split("/").filter(Boolean)) {
		current += `/${part}`;
		out.push(current);
	}
	return out;
}

function unitDropins(): string[] {
	return [`${PATHS.desktopUnit}.d`, `${PATHS.bridgeUnit}.d`];
}

/** The paths the planner looks at, each with every directory above it. */
export function inspectedPaths(config: Config, desktopHome: string | null): string[] {
	const paths = [
		OS_RELEASE,
		"/run/systemd/system",
		...Object.values(TOOLS),
		config.node.path,
		config.browser.path,
		...Object.values(BUNDLE_FILES).map((file) => `${config.bundle.dir}/${file}`),
		config.tls.cert,
		config.tls.key,
		...Object.values(PATHS),
		...unitDropins(),
		config.workspace,
		...(desktopHome ? [desktopHome] : []),
	];
	return [...new Set(paths.flatMap(chain))].sort();
}

/** Whether every directory from `/` to `dir` is root's, not a link, and writable by no one else. */
function trustedChain(facts: Facts, dir: string): boolean {
	return chain(dir).every((p) => {
		const fact = facts.paths[p];
		return fact?.kind === "dir" && fact.uid === 0 && (fact.mode & 0o022) === 0;
	});
}

/** Whether every account can pass through every directory from `/` to `dir`, as the two services' accounts must. */
function reachableChain(facts: Facts, dir: string): boolean {
	return chain(dir).every((p) => ((facts.paths[p]?.mode ?? 0) & 0o001) !== 0);
}

/** Whether `file` is a regular file of root's, writable by no one else, in a trusted directory; and one every account can run, when asked. */
function trustedFile(facts: Facts, file: string, executable: boolean): boolean {
	const fact = facts.paths[file];
	return trustedChain(facts, path.posix.dirname(file)) && fact?.kind === "file" && fact.uid === 0 && (fact.mode & 0o022) === 0 && (!executable || (fact.mode & 0o001) !== 0);
}

/** Who owns what the installer makes: root, or an account's own user and primary group. */
export type Owner = "root" | typeof ACCOUNTS.bridge | typeof ACCOUNTS.desktop;

export type Action =
	| { readonly step: string; readonly kind: "read-tls" }
	| { readonly step: string; readonly kind: "run"; readonly argv: readonly string[] }
	| { readonly step: string; readonly kind: "check-accounts" }
	| { readonly step: string; readonly kind: "check-units" }
	| { readonly step: string; readonly kind: "mkdir"; readonly path: string; readonly mode: number; readonly owner: Owner }
	| { readonly step: string; readonly kind: "write"; readonly path: string; readonly mode: number; readonly owner: Owner; readonly content: { readonly text: string } | { readonly staged: "cert" | "key" } }
	| { readonly step: string; readonly kind: "chown"; readonly path: string; readonly mode: number; readonly owner: Owner }
	| { readonly step: string; readonly kind: "remove-staged" };

const NAMES = Object.values(ACCOUNTS);

/** Read here rather than /etc/os-release, which on Ubuntu is a link to it; no link is followed. */
export const OS_RELEASE = "/usr/lib/os-release";

/** The account names as words in a sudoers file: a user, `%group`, or in a list. */
function mentions(text: string, name: string): boolean {
	return new RegExp(`(^|[^A-Za-z0-9_.-])${name.replace(/[-.]/g, "\\$&")}($|[^A-Za-z0-9_.-])`, "m").test(text);
}

/**
 * What `install` would do on a VM with these facts, in order; or a
 * refusal with a fixed reason. Everything is checked here, before anything
 * is changed. Pure: it reads only its arguments.
 */
export function plan(config: Config, facts: Facts): Action[] {
	if (facts.euid !== 0) throw new Refusal("root-required");
	if (facts.osRelease === null || !trustedFile(facts, OS_RELEASE, false)) throw new Refusal("os");
	const os = Object.fromEntries(
		facts.osRelease
			.split("\n")
			.map((line) => /^([A-Z_]+)=(.*)$/.exec(line))
			.filter((match) => match !== null)
			.map((match) => [match[1], match[2]!.replace(/^"(.*)"$/, "$1")]),
	);
	if (os.ID !== "ubuntu" || os.VERSION_ID !== "24.04") throw new Refusal("os");
	if (facts.paths["/run/systemd/system"]?.kind !== "dir") throw new Refusal("systemd");
	if (!/^[123]\n?$/.test(facts.ptraceScope ?? "")) throw new Refusal("ptrace-scope");
	if (!Object.values(TOOLS).every((tool) => trustedFile(facts, tool, true))) throw new Refusal("tools");

	if (facts.execPath !== config.node.path || !trustedFile(facts, config.node.path, true)) throw new Refusal("node-path");
	if (facts.nodeVersion !== config.node.version || !nodeVersionAtLeast(facts.nodeVersion, MIN_NODE)) throw new Refusal("node-version");
	if (!Object.values(BUNDLE_FILES).every((file) => trustedFile(facts, `${config.bundle.dir}/${file}`, false))) throw new Refusal("bundle");
	if (facts.bundleMarker === null || !facts.bundleMarker.startsWith(`${BUNDLE_FORMAT}\ncommit ${config.commit}\n`)) throw new Refusal("bundle-commit");
	if (!trustedFile(facts, config.browser.path, true)) throw new Refusal("browser");
	if (facts.browserSha256 !== config.browser.sha256) throw new Refusal("browser-digest");
	// pim-bridge and pim-desktop run Node, read the bundle and start the browser, and the desktop reaches its workspace.
	if (![path.posix.dirname(config.node.path), config.bundle.dir, path.posix.dirname(config.browser.path), path.posix.dirname(config.workspace)].every((dir) => reachableChain(facts, dir))) {
		throw new Refusal("unreachable");
	}

	if (facts.passwd === null || facts.group === null) throw new Refusal("accounts-unreadable");
	const users = parsePasswd(facts.passwd);
	const groups = parseGroup(facts.group);
	if (users.some((user) => user.name === ACCOUNTS.bridge || user.name === ACCOUNTS.session) || groups.some((group) => group.name === ACCOUNTS.bridge || group.name === ACCOUNTS.session)) {
		throw new Refusal("preexisting-account");
	}
	const desktop = users.find((user) => user.name === ACCOUNTS.desktop);
	if (!desktop) throw new Refusal("desktop-account-missing");
	if (!Number.isSafeInteger(desktop.uid) || desktop.uid < 1000 || desktop.uid >= 60000 || users.filter((user) => user.uid === desktop.uid).length !== 1) throw new Refusal("desktop-account");
	const primary = groups.filter((group) => group.gid === desktop.gid);
	if (primary.length !== 1 || primary[0]!.name !== ACCOUNTS.desktop || users.some((user) => user !== desktop && user.gid === desktop.gid)) throw new Refusal("desktop-group");
	// The desktop account is in no group but its own: not sudo, adm, docker, lxd or any other, and so never the bridge's.
	if (groups.some((group) => group.gid !== desktop.gid && group.members.includes(ACCOUNTS.desktop))) throw new Refusal("desktop-groups");
	// A tripwire, not an interpretation of sudo's policy: any file that can't be read refuses, and any mention of the accounts does.
	if (facts.sudoers === null || facts.sudoers.length === 0 || facts.sudoers.some((text) => text === null)) throw new Refusal("sudoers-unreadable");
	if (facts.sudoers.some((text) => NAMES.some((name) => mentions(text!, name)))) throw new Refusal("sudoers");
	const home = facts.paths[desktop.home];
	if (!path.posix.isAbsolute(desktop.home) || !trustedChain(facts, path.posix.dirname(desktop.home)) || home?.kind !== "dir" || home.uid !== desktop.uid || (home.mode & 0o022) !== 0) {
		throw new Refusal("desktop-home");
	}
	if (within(config.workspace, desktop.home)) throw new Refusal("config-overlap");

	const targets = [PATHS.bridgeDir, PATHS.evalDir, PATHS.socketDir, PATHS.tmpfiles, PATHS.desktopUnit, PATHS.bridgeUnit, ...unitDropins(), config.workspace];
	if (targets.some((target) => facts.paths[target] !== null)) throw new Refusal("preexisting-path");
	if (!targets.every((target) => trustedChain(facts, path.posix.dirname(target)))) throw new Refusal("unsafe-parent");

	const staging = path.posix.dirname(config.tls.cert);
	const stagingDir = facts.paths[staging];
	const cert = facts.paths[config.tls.cert];
	const key = facts.paths[config.tls.key];
	if (
		!trustedChain(facts, path.posix.dirname(staging)) ||
		stagingDir?.kind !== "dir" ||
		stagingDir.uid !== 0 ||
		(stagingDir.mode & 0o077) !== 0 ||
		cert?.kind !== "file" ||
		cert.uid !== 0 ||
		(cert.mode & 0o022) !== 0 ||
		key?.kind !== "file" ||
		key.uid !== 0 ||
		(key.mode & 0o077) !== 0
	) {
		throw new Refusal("tls-staging");
	}

	const units = renderUnits(config, desktop.uid);
	return [
		{ step: "tls", kind: "read-tls" },
		{ step: "session-group", kind: "run", argv: [TOOLS.groupadd, "--system", ACCOUNTS.session] },
		{
			step: "bridge-account",
			kind: "run",
			argv: [TOOLS.useradd, "--system", "--user-group", "--no-create-home", "--home-dir", "/nonexistent", "--shell", TOOLS.nologin, "--groups", ACCOUNTS.session, ACCOUNTS.bridge],
		},
		{ step: "accounts", kind: "check-accounts" },
		{ step: "eval-dir", kind: "mkdir", path: PATHS.evalDir, mode: 0o755, owner: "root" },
		{ step: "public-key", kind: "write", path: PATHS.publicKey, mode: 0o644, owner: "root", content: { text: config.evalKey.publicKeyPem } },
		// Made root's and 0700, filled, and only then given to the bridge, so nothing of the bridge's acts in it while root writes.
		{ step: "bridge-dir", kind: "mkdir", path: PATHS.bridgeDir, mode: 0o700, owner: "root" },
		{ step: "cert", kind: "write", path: PATHS.cert, mode: 0o600, owner: ACCOUNTS.bridge, content: { staged: "cert" } },
		{ step: "key", kind: "write", path: PATHS.key, mode: 0o600, owner: ACCOUNTS.bridge, content: { staged: "key" } },
		{ step: "bridge-dir-owner", kind: "chown", path: PATHS.bridgeDir, mode: 0o700, owner: ACCOUNTS.bridge },
		{ step: "workspace", kind: "mkdir", path: config.workspace, mode: 0o700, owner: ACCOUNTS.desktop },
		{ step: "tmpfiles", kind: "write", path: PATHS.tmpfiles, mode: 0o644, owner: "root", content: { text: renderTmpfiles() } },
		{ step: "desktop-unit", kind: "write", path: PATHS.desktopUnit, mode: 0o644, owner: "root", content: { text: units.desktop } },
		{ step: "bridge-unit", kind: "write", path: PATHS.bridgeUnit, mode: 0o644, owner: "root", content: { text: units.bridge } },
		{ step: "socket-dir", kind: "run", argv: [TOOLS.tmpfiles, "--create", PATHS.tmpfiles] },
		{ step: "daemon-reload", kind: "run", argv: [TOOLS.systemctl, "daemon-reload"] },
		// What systemd will run is these files alone: no drop-in from anywhere changes them.
		{ step: "units", kind: "check-units" },
		{ step: "enable", kind: "run", argv: [TOOLS.systemctl, "enable", UNITS.desktop, UNITS.bridge] },
		{ step: "staged-tls", kind: "remove-staged" },
	];
}

/**
 * The accounts as the installation leaves them, or the fixed reason they
 * aren't: the bridge a system account with no login, no home and a locked
 * password, in its own group and the session group only; the session group
 * holding the bridge alone; the desktop account in no group but its own.
 */
export function checkAccounts(passwd: string, group: string, shadow: string): { desktop: User; bridge: User; sessionGid: number } {
	const users = parsePasswd(passwd);
	const groups = parseGroup(group);
	const one = <T extends { name: string }>(list: T[], name: string): T => {
		const found = list.filter((entry) => entry.name === name);
		if (found.length !== 1) throw new Refusal("accounts");
		return found[0]!;
	};
	const desktop = one(users, ACCOUNTS.desktop);
	const bridge = one(users, ACCOUNTS.bridge);
	const bridgeGroup = one(groups, ACCOUNTS.bridge);
	const session = one(groups, ACCOUNTS.session);
	const locked = shadow
		.split("\n")
		.filter((line) => line.split(":")[0] === ACCOUNTS.bridge)
		.map((line) => line.split(":")[1] ?? "");
	const ok =
		bridge.uid > 0 &&
		bridge.uid < 1000 &&
		users.filter((user) => user.uid === bridge.uid).length === 1 &&
		bridge.gid === bridgeGroup.gid &&
		groups.filter((g) => g.gid === bridgeGroup.gid).length === 1 &&
		bridge.home === "/nonexistent" &&
		bridge.shell === TOOLS.nologin &&
		locked.length === 1 &&
		/^[!*]/.test(locked[0]!) &&
		JSON.stringify(groups.filter((g) => g.members.includes(ACCOUNTS.bridge)).map((g) => g.name)) === JSON.stringify([ACCOUNTS.session]) &&
		JSON.stringify(session.members) === JSON.stringify([ACCOUNTS.bridge]) &&
		groups.filter((g) => g.gid === session.gid).length === 1 &&
		!groups.some((g) => g.gid !== desktop.gid && g.members.includes(ACCOUNTS.desktop)) &&
		desktop.gid !== bridgeGroup.gid &&
		desktop.gid !== session.gid;
	if (!ok) throw new Refusal("accounts");
	return { desktop, bridge, sessionGid: session.gid };
}

export type Staged = { readonly bytes: Buffer; readonly dev: number; readonly ino: number };

/** What `apply` does to the VM; `systemHost()` does it, tests give stand-ins. */
export type Host = {
	readText(file: string): string;
	/** A regular file of root's, read without following a link. */
	readStaged(file: string, maxBytes: number): Staged;
	/** Makes `dir` new (never over anything), root's, then gives it `uid`, `gid` and `mode` through a descriptor. */
	mkdirNew(dir: string, mode: number, uid: number, gid: number): void;
	/** Creates `file` new (`O_EXCL`, never through a link) with `bytes`, then gives it `uid`, `gid` and `mode` through its descriptor. */
	writeNew(file: string, bytes: Buffer, mode: number, uid: number, gid: number): void;
	/** Gives a directory still root's `uid`, `gid` and `mode`, through a descriptor. */
	chownDir(dir: string, mode: number, uid: number, gid: number): void;
	/** Removes `file` only if it is still the one read (`dev`, `ino`). */
	removeStaged(file: string, staged: Staged): void;
	/** Runs a fixed program with fixed arguments, no shell; throws unless it exits 0. */
	run(argv: readonly string[]): void;
	/** Runs a fixed read-only program; answers its exit status and at most 4 KiB of its output. */
	query(argv: readonly string[]): { status: number | null; stdout: string };
};

/** What `systemctl show` says of each unit, which must be what the installer wrote, as the account it names, with nothing merged in. */
export function checkUnits(show: (unit: string) => string): void {
	for (const [unit, file, user] of [
		[UNITS.desktop, PATHS.desktopUnit, ACCOUNTS.desktop],
		[UNITS.bridge, PATHS.bridgeUnit, ACCOUNTS.bridge],
	] as const) {
		const properties = new Map(
			show(unit)
				.split("\n")
				.filter(Boolean)
				.map((line) => [line.slice(0, line.indexOf("=")), line.slice(line.indexOf("=") + 1)]),
		);
		if (properties.size !== 4 || properties.get("FragmentPath") !== file || properties.get("DropInPaths") !== "" || properties.get("User") !== user || properties.get("KillMode") !== "process") {
			throw new Refusal("unit-check");
		}
	}
}

/** The `systemctl show` arguments `checkUnits` reads. */
export const SHOW_UNIT = (unit: string) => [TOOLS.systemctl, "show", "--property=FragmentPath,DropInPaths,User,KillMode", unit];

/** Where `apply` stopped: the step, and whether anything had changed on the VM by then. */
export class ApplyFailure extends Error {
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

/** Checks the staged certificate and key: PEM, the key the certificate's, and the certificate not expired. */
export function checkTls(cert: Buffer, key: Buffer, now = Date.now()): void {
	let ok = false;
	try {
		const x509 = new crypto.X509Certificate(cert);
		const privateKey = crypto.createPrivateKey({ key, format: "pem" });
		ok = cert.subarray(0, 27).toString("latin1") === "-----BEGIN CERTIFICATE-----" && x509.checkPrivateKey(privateKey) && Date.parse(x509.validTo) > now && Date.parse(x509.validFrom) <= now;
	} catch {
		ok = false;
	}
	if (!ok) throw new Refusal("tls");
}

const MAX_TLS_BYTES = 64 * 1024;

/** Does the planned actions in order, and stops at the first that fails, undoing nothing. */
export function apply(config: Config, actions: readonly Action[], host: Host, now = Date.now()): void {
	let staged: { cert: Staged; key: Staged } | undefined;
	let ids: Record<Owner, { uid: number; gid: number }> | undefined;
	let changed = false;
	try {
		for (const action of actions) {
			try {
				const owner = (name: Owner) => {
					if (name === "root") return { uid: 0, gid: 0 };
					if (!ids) throw new Refusal("accounts");
					return ids[name];
				};
				switch (action.kind) {
					case "read-tls": {
						staged = { cert: host.readStaged(config.tls.cert, MAX_TLS_BYTES), key: host.readStaged(config.tls.key, MAX_TLS_BYTES) };
						checkTls(staged.cert.bytes, staged.key.bytes, now);
						break;
					}
					case "run":
						changed = true;
						host.run(action.argv);
						break;
					case "check-units":
					checkUnits((unit) => {
						const answer = host.query(SHOW_UNIT(unit));
						if (answer.status !== 0) throw new Refusal("unit-check");
						return answer.stdout;
					});
					break;
				case "check-accounts": {
						const accounts = checkAccounts(host.readText("/etc/passwd"), host.readText("/etc/group"), host.readText("/etc/shadow"));
						ids = { root: { uid: 0, gid: 0 }, [ACCOUNTS.bridge]: { uid: accounts.bridge.uid, gid: accounts.bridge.gid }, [ACCOUNTS.desktop]: { uid: accounts.desktop.uid, gid: accounts.desktop.gid } };
						break;
					}
					case "mkdir": {
						const { uid, gid } = owner(action.owner);
						changed = true;
						host.mkdirNew(action.path, action.mode, uid, gid);
						break;
					}
					case "write": {
						const { uid, gid } = owner(action.owner);
						let bytes: Buffer;
						if ("text" in action.content) bytes = Buffer.from(action.content.text, "utf8");
						else {
							if (!staged) throw new Refusal("tls");
							bytes = staged[action.content.staged].bytes;
						}
						changed = true;
						host.writeNew(action.path, bytes, action.mode, uid, gid);
						break;
					}
					case "chown": {
						const { uid, gid } = owner(action.owner);
						changed = true;
						host.chownDir(action.path, action.mode, uid, gid);
						break;
					}
					case "remove-staged":
						if (!staged) throw new Refusal("tls");
						host.removeStaged(config.tls.key, staged.key);
						host.removeStaged(config.tls.cert, staged.cert);
						break;
				}
			} catch (error) {
				throw new ApplyFailure(action.step, error instanceof Refusal ? error.reason : "failed", changed);
			}
		}
	} finally {
		// Best effort: the key's bytes aren't kept past the install, whether it finished or not.
		staged?.key.bytes.fill(0);
	}
}

/** The status of the installation: metadata only, from reads and from read-only queries. */
export type Probe = {
	lstat(file: string): PathFact;
	readText(file: string): string | null;
	/** Runs a fixed read-only program; answers its exit status and at most 4 KiB of its output. */
	query(argv: readonly string[]): { status: number | null; stdout: string };
};

function describePath(fact: PathFact, names: Map<number, string>, groupNames: Map<number, string>): string {
	if (!fact) return "absent";
	return `${fact.kind} ${names.get(fact.uid) ?? fact.uid}:${groupNames.get(fact.gid) ?? fact.gid} ${(fact.mode & 0o7777).toString(8).padStart(4, "0")}`;
}

/** What `status` prints. Nothing in it is read from a secret file. */
export function status(config: Config, probe: Probe): Record<string, unknown> {
	const passwd = probe.readText("/etc/passwd") ?? "";
	const group = probe.readText("/etc/group") ?? "";
	const users = parsePasswd(passwd);
	const groups = parseGroup(group);
	const names = new Map(users.map((user) => [user.uid, user.name]));
	const groupNames = new Map(groups.map((g) => [g.gid, g.name]));
	let accounts: string;
	try {
		checkAccounts(passwd, group, probe.readText("/etc/shadow") ?? "");
		accounts = "ok";
	} catch {
		accounts = "unexpected";
	}
	const watched = [PATHS.bridgeDir, PATHS.token, PATHS.cert, PATHS.key, PATHS.evalDir, PATHS.publicKey, PATHS.socketDir, PATHS.socket, config.workspace, config.tls.cert, config.tls.key];
	const facts = Object.fromEntries(watched.map((file) => [file, probe.lstat(file)]));
	const paths = Object.fromEntries(watched.map((file) => [file, describePath(facts[file]!, names, groupNames)]));

	let certificate: Record<string, string> | null = null;
	const pem = facts[PATHS.cert]?.kind === "file" ? probe.readText(PATHS.cert) : null;
	if (pem) {
		try {
			const x509 = new crypto.X509Certificate(pem);
			certificate = { sha256: x509.fingerprint256, notBefore: x509.validFrom, notAfter: x509.validTo, subjectAltName: x509.subjectAltName ?? "" };
		} catch {
			certificate = { error: "unreadable" };
		}
	}

	// As the desktop account, with the groups it logs in with: opening each secret file must fail. Nothing is read or printed.
	// The public key, which it may read, is the control: if opening that fails too, the check itself failed and says nothing.
	const opens = (file: string) => probe.query([TOOLS.runuser, "-u", ACCOUNTS.desktop, "--", TOOLS.head, "-c", "0", "--", file]).status === 0;
	const control = facts[PATHS.publicKey]?.kind === "file" && opens(PATHS.publicKey);
	const denied: Record<string, string> = {};
	for (const file of [PATHS.token, PATHS.cert, PATHS.key]) {
		if (facts[file]?.kind !== "file") denied[file] = "absent";
		else if (!control) denied[file] = "unknown";
		else denied[file] = opens(file) ? "READABLE" : "denied";
	}

	// What systemd says of each unit, nothing more: it says nothing of what the unit's programs started.
	const units: Record<string, Record<string, string>> = {};
	for (const unit of [UNITS.desktop, UNITS.bridge]) {
		const enabled = probe.query([TOOLS.systemctl, "is-enabled", unit]).stdout.trim();
		const state = unitState(probe.query, unit);
		units[unit] = { enabled: /^[a-z-]+$/.test(enabled) ? enabled : "unknown", ...(state ?? { state: "unknown" }) };
	}

	const desktop = users.find((user) => user.name === ACCOUNTS.desktop);
	const display =
		config.desktop.headful && config.desktop.display && desktop
			? {
					socket: probe.lstat(`/tmp/.X11-unix/X${config.desktop.display.slice(1)}`)?.kind === "socket",
					runtimeDir: probe.lstat(`/run/user/${desktop.uid}`)?.kind === "dir",
				}
			: null;

	const ptraceScope = (probe.readText("/proc/sys/kernel/yama/ptrace_scope") ?? "absent").trim();
	return { event: "pim-cua-eval.status", evaluation: config.evaluation, commit: config.commit, accounts, paths, certificate, denied, units, display, ptraceScope };
}

/** The `systemctl show` arguments `unitState` reads: ordinary unit metadata only. */
export const UNIT_STATE = (unit: string) => [TOOLS.systemctl, "show", "--property=LoadState,ActiveState,SubState,Result", unit];

type UnitState = { LoadState: string; ActiveState: string; SubState: string; Result: string };

/** A unit's load, active and sub-state and its last result, as systemd says them; `null` when they can't be read whole. */
export function unitState(query: Probe["query"], unit: string): UnitState | null {
	const answer = query(UNIT_STATE(unit));
	if (answer.status !== 0) return null;
	const lines = answer.stdout.split("\n").filter(Boolean);
	const state: Record<string, string> = {};
	for (const line of lines) {
		const match = /^(LoadState|ActiveState|SubState|Result)=([a-z-]+)$/.exec(line);
		if (!match || Object.hasOwn(state, match[1]!)) return null;
		state[match[1]!] = match[2]!;
	}
	return Object.keys(state).length === 4 ? (state as UnitState) : null;
}

/**
 * Starts the desktop endpoint, then the bridge, once the token is the
 * bridge's and, for a headful browser, the session's display is there.
 *
 * Only an endpoint that systemd says is running, or never ran or stopped
 * with its result `success` (it exited 0, which it does only after the
 * pim-computer it started was seen to exit), is started (or left running).
 * After any other end (failed, killed, a refused start, a stop still under
 * way, or state that can't be read), it isn't recoverable in place: the VM
 * is rebooted or discarded. That is a policy about what systemd recorded,
 * not a check that nothing the endpoint started still runs.
 */
export function start(config: Config, probe: Probe, run: (argv: readonly string[]) => void): void {
	const users = parsePasswd(probe.readText("/etc/passwd") ?? "");
	const bridge = users.find((user) => user.name === ACCOUNTS.bridge);
	const desktop = users.find((user) => user.name === ACCOUNTS.desktop);
	const token = probe.lstat(PATHS.token);
	if (!bridge || token?.kind !== "file" || token.uid !== bridge.uid || (token.mode & 0o7777) !== 0o600) throw new Refusal("token-missing");
	if (config.desktop.headful && config.desktop.display) {
		const socket = probe.lstat(`/tmp/.X11-unix/X${config.desktop.display.slice(1)}`);
		const runtime = desktop ? probe.lstat(`/run/user/${desktop.uid}`) : null;
		if (socket?.kind !== "socket" || runtime?.kind !== "dir" || runtime.uid !== desktop?.uid) throw new Refusal("display-missing");
	}
	const desktopState = unitState(probe.query, UNITS.desktop);
	const running = desktopState?.ActiveState === "active" && desktopState.SubState === "running";
	const clean = desktopState?.ActiveState === "inactive" && desktopState.SubState === "dead" && desktopState.Result === "success";
	if (desktopState?.LoadState !== "loaded" || !(running || clean)) throw new Refusal("desktop-not-clean");
	// The bridge starts nothing of its own, so a failed one may be started again; a state that can't be read, or a change under way, may not.
	const bridgeState = unitState(probe.query, UNITS.bridge);
	if (bridgeState?.LoadState !== "loaded" || !["active", "inactive", "failed"].includes(bridgeState.ActiveState)) throw new Refusal("bridge-state");
	run([TOOLS.systemctl, "start", UNITS.desktop]);
	run([TOOLS.systemctl, "start", UNITS.bridge]);
}

// ---- The real VM ----

function kindOf(stat: fs.Stats): NonNullable<PathFact>["kind"] {
	if (stat.isSymbolicLink()) return "link";
	if (stat.isFile()) return "file";
	if (stat.isDirectory()) return "dir";
	if (stat.isSocket()) return "socket";
	return "other";
}

function lstat(file: string): PathFact {
	try {
		const stat = fs.lstatSync(file);
		return { kind: kindOf(stat), uid: stat.uid, gid: stat.gid, mode: stat.mode & 0o7777 };
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT" || (error as NodeJS.ErrnoException).code === "ENOTDIR") return null;
		throw new Refusal("inspect");
	}
}

/** A regular file's text, at most 1 MiB, read without following a link or waiting on a FIFO; `null` when it can't be. */
export function readText(file: string): string | null {
	let descriptor: number;
	try {
		descriptor = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK);
	} catch {
		return null;
	}
	try {
		if (!fs.fstatSync(descriptor).isFile()) return null;
		const buffer = Buffer.alloc(1024 * 1024 + 1);
		let length = 0;
		for (;;) {
			const read = fs.readSync(descriptor, buffer, length, buffer.length - length, null);
			if (read === 0) break;
			length += read;
			if (length > 1024 * 1024) return null;
		}
		return buffer.subarray(0, length).toString("utf8");
	} catch {
		return null;
	} finally {
		fs.closeSync(descriptor);
	}
}

/** Runs a fixed read-only program, no shell, with a fixed environment; its standard error is dropped. */
function query(argv: readonly string[]): { status: number | null; stdout: string } {
	const [command, ...args] = argv;
	const result = spawnSync(command!, args, { stdio: ["ignore", "pipe", "ignore"], env: { PATH: "/usr/sbin:/usr/bin", LC_ALL: "C" }, shell: false, maxBuffer: 4096, encoding: "utf8" });
	return { status: result.status, stdout: result.stdout ?? "" };
}

/** The SHA-256 of a regular file, read without following a link. */
function sha256File(file: string): string | null {
	let descriptor: number;
	try {
		descriptor = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
	} catch {
		return null;
	}
	try {
		if (!fs.fstatSync(descriptor).isFile()) return null;
		const hash = crypto.createHash("sha256");
		const buffer = Buffer.alloc(1024 * 1024);
		for (;;) {
			const read = fs.readSync(descriptor, buffer, 0, buffer.length, null);
			if (read === 0) break;
			hash.update(buffer.subarray(0, read));
		}
		return hash.digest("hex");
	} finally {
		fs.closeSync(descriptor);
	}
}

export function gatherFacts(config: Config): Facts {
	const passwd = readText("/etc/passwd");
	const desktop = parsePasswd(passwd ?? "").find((user) => user.name === ACCOUNTS.desktop);
	const paths: Record<string, PathFact> = {};
	for (const file of inspectedPaths(config, desktop && path.posix.isAbsolute(desktop.home) ? path.posix.normalize(desktop.home) : null)) paths[file] = lstat(file);
	let sudoers: (string | null)[] | null;
	try {
		sudoers = [readText("/etc/sudoers"), ...fs.readdirSync("/etc/sudoers.d").map((entry) => readText(path.join("/etc/sudoers.d", entry)))];
	} catch {
		sudoers = null;
	}
	return {
		euid: process.geteuid?.() ?? -1,
		execPath: process.execPath,
		nodeVersion: process.version,
		osRelease: readText(OS_RELEASE),
		passwd,
		group: readText("/etc/group"),
		sudoers,
		paths,
		browserSha256: sha256File(config.browser.path),
		bundleMarker: readText(`${config.bundle.dir}/${BUNDLE_FILES.marker}`),
		ptraceScope: readText("/proc/sys/kernel/yama/ptrace_scope"),
	};
}

const { O_RDONLY, O_WRONLY, O_CREAT, O_EXCL, O_NOFOLLOW, O_DIRECTORY, O_NONBLOCK } = fs.constants;

function syncDirectory(dir: string): void {
	try {
		const descriptor = fs.openSync(dir, O_RDONLY | O_DIRECTORY);
		try {
			fs.fsyncSync(descriptor);
		} finally {
			fs.closeSync(descriptor);
		}
	} catch {
		// Durability only.
	}
}

/** The VM's own `Host`. Every change goes through a descriptor opened without following links; `euid` is root's when run for real. */
export function systemHost(euid = process.geteuid?.() ?? -1): Host {
	return {
		readText(file) {
			const text = readText(file);
			if (text === null) throw new Refusal("read");
			return text;
		},
		readStaged(file, maxBytes) {
			const descriptor = fs.openSync(file, O_RDONLY | O_NOFOLLOW | O_NONBLOCK);
			try {
				const stat = fs.fstatSync(descriptor);
				if (!stat.isFile() || stat.uid !== euid || stat.size > maxBytes) throw new Refusal("tls-staging");
				const bytes = fs.readFileSync(descriptor);
				if (bytes.length > maxBytes) throw new Refusal("tls-staging");
				return { bytes, dev: stat.dev, ino: stat.ino };
			} finally {
				fs.closeSync(descriptor);
			}
		},
		mkdirNew(dir, mode, uid, gid) {
			fs.mkdirSync(dir, { mode: 0o700 });
			const descriptor = fs.openSync(dir, O_RDONLY | O_DIRECTORY | O_NOFOLLOW);
			try {
				const stat = fs.fstatSync(descriptor);
				if (!stat.isDirectory() || stat.uid !== euid) throw new Refusal("mkdir");
				fs.fchownSync(descriptor, uid, gid);
				fs.fchmodSync(descriptor, mode);
			} finally {
				fs.closeSync(descriptor);
			}
			syncDirectory(path.dirname(dir));
		},
		writeNew(file, bytes, mode, uid, gid) {
			const descriptor = fs.openSync(file, O_WRONLY | O_CREAT | O_EXCL | O_NOFOLLOW, 0o600);
			try {
				fs.fchmodSync(descriptor, 0o600);
				const stat = fs.fstatSync(descriptor);
				if (!stat.isFile() || stat.uid !== euid) throw new Refusal("write");
				let written = 0;
				while (written < bytes.length) written += fs.writeSync(descriptor, bytes, written, bytes.length - written);
				fs.fsyncSync(descriptor);
				fs.fchownSync(descriptor, uid, gid);
				fs.fchmodSync(descriptor, mode);
			} catch (error) {
				// Only this call's own file is removed, and only while the path is still it.
				try {
					const made = fs.fstatSync(descriptor);
					const there = fs.lstatSync(file);
					if (made.dev === there.dev && made.ino === there.ino) {
						fs.ftruncateSync(descriptor, 0);
						fs.unlinkSync(file);
					}
				} catch {
					// Left for the operator; the VM is discarded after a failed install.
				}
				throw error;
			} finally {
				fs.closeSync(descriptor);
			}
			syncDirectory(path.dirname(file));
		},
		chownDir(dir, mode, uid, gid) {
			const descriptor = fs.openSync(dir, O_RDONLY | O_DIRECTORY | O_NOFOLLOW);
			try {
				const stat = fs.fstatSync(descriptor);
				if (!stat.isDirectory() || stat.uid !== euid) throw new Refusal("chown");
				fs.fchownSync(descriptor, uid, gid);
				fs.fchmodSync(descriptor, mode);
			} finally {
				fs.closeSync(descriptor);
			}
		},
		removeStaged(file, staged) {
			const there = fs.lstatSync(file);
			if (!there.isFile() || there.dev !== staged.dev || there.ino !== staged.ino || there.uid !== euid) throw new Refusal("staged-changed");
			fs.unlinkSync(file);
			syncDirectory(path.dirname(file));
		},
		run(argv) {
			const [command, ...args] = argv;
			execFileSync(command!, args, { stdio: ["ignore", "ignore", "inherit"], env: { PATH: "/usr/sbin:/usr/bin", LC_ALL: "C" }, shell: false });
		},
		query,
	};
}

function systemProbe(): Probe {
	return { lstat, readText, query };
}

const COMMANDS = ["plan", "install", "start", "status"] as const;
const USAGE = `Installs a Cua evaluation's bridge and desktop endpoint on a new VM, as root, with the configuration on standard input.

  node install.ts plan|install|start|status < config.json

See docs/cua-eval-install.md.`;

function say(entry: Record<string, unknown>, stream: "stdout" | "stderr" = "stdout"): void {
	process[stream].write(`${JSON.stringify(entry)}\n`);
}

async function main(argv: string[]): Promise<void> {
	const command = argv[0] as (typeof COMMANDS)[number];
	if (argv.length !== 1 || !COMMANDS.includes(command)) {
		process.stderr.write(`${USAGE}\n`);
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
		// This program must be the verified bundle's own copy, run by the pinned Node.
		if (fileURLToPath(import.meta.url) !== `${config.bundle.dir}/${BUNDLE_FILES.installer}`) throw new Refusal("installer-path");
		if (process.execPath !== config.node.path) throw new Refusal("node-path");
		if (command === "plan" || command === "install") {
			step = "plan";
			const actions = plan(config, gatherFacts(config));
			if (command === "plan") {
				say({ event: "pim-cua-eval.planned", actions: actions.map((a) => ({ step: a.step, kind: a.kind, ...("path" in a ? { path: a.path, mode: a.mode.toString(8), owner: a.owner } : {}), ...("argv" in a ? { argv: a.argv } : {}) })) });
				return;
			}
			try {
				apply(config, actions, systemHost());
			} catch (error) {
				if (!(error instanceof ApplyFailure)) throw error;
				say({ event: "pim-cua-eval.failed", command, step: error.step, reason: error.reason, changed: error.changed }, "stderr");
				process.exit(1);
			}
			say({ event: "pim-cua-eval.installed", evaluation: config.evaluation, commit: config.commit, units: [UNITS.desktop, UNITS.bridge] });
		} else if (command === "start") {
			step = "start";
			start(config, systemProbe(), systemHost().run);
			say({ event: "pim-cua-eval.started", units: [UNITS.desktop, UNITS.bridge] });
		} else {
			step = "status";
			say(status(config, systemProbe()));
		}
	} catch (error) {
		// What was thrown may name a path; only a fixed reason is said.
		say({ event: "pim-cua-eval.failed", command, step, reason: error instanceof Refusal ? error.reason : "internal" }, "stderr");
		process.exit(1);
	}
}

// Run as a program, never when imported.
if (process.argv[1] && import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href) void main(process.argv.slice(2));
