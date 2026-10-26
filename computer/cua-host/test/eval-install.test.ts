/**
 * The Cua evaluation VM's installation (../eval-install/), without a VM:
 * the planner over synthetic VMs given as metadata, never this machine's
 * accounts; `apply`, `status` and `start` against stand-in hosts that
 * record what they are asked to do; the rendered management scripts and
 * services read as text and checked with `bash -n`; the bundle made from
 * synthetic tarballs; and the file helpers and the bash tree digest over a
 * folder made for this run. No installer, management script, account,
 * service or privileged command runs here, and nothing leaves this machine.
 *
 *   pnpm --filter pim-cua-host test
 */

import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { after, before, describe, it } from "node:test";
import * as zlib from "node:zlib";
import { KEPT_ENVIRONMENT } from "../desktop.ts";
import { type Config, parseConfig, renderTmpfiles, renderUnits } from "../eval-install/config.ts";
import { type Action, ApplyFailure, apply, checkAccounts, type Facts, type Host, inspectedPaths, type PathFact, type Probe, plan, readText, type Staged, start, status, systemHost } from "../eval-install/install.ts";
import { BUNDLE_SOURCES, bundleEntries, lockedIntegrity, renderCloudConfig, renderScripts, TREE_DIGEST_BASH, treeDigest, untarPackage, writePrivate, writeTree } from "../eval-install/operator.ts";

const REPOSITORY = path.resolve(import.meta.dirname, "../../..");
const OWNER = "o_0123456789abcdefghijklmnop";
const COMMIT = "0123456789abcdef0123456789abcdef01234567";

let root = "";
let publicKeyPem = "";
let fingerprint = "";
let tls = { cert: Buffer.alloc(0), key: Buffer.alloc(0), otherKey: Buffer.alloc(0) };

before(() => {
	root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "cua-install-")));
	const { publicKey } = crypto.generateKeyPairSync("rsa", { modulusLength: 3072, publicExponent: 0x10001 });
	publicKeyPem = publicKey.export({ type: "spki", format: "pem" }).toString();
	fingerprint = crypto.createHash("sha256").update(publicKey.export({ type: "spki", format: "der" })).digest("hex");
	const tlsDir = path.join(root, "tls");
	fs.mkdirSync(tlsDir);
	for (const name of ["", "other-"]) {
		execFileSync(
			"openssl",
			["req", "-x509", "-newkey", "ec", "-pkeyopt", "ec_paramgen_curve:prime256v1", "-nodes", "-days", "2", "-subj", "/CN=bridge.example", "-keyout", path.join(tlsDir, `${name}key.pem`), "-out", path.join(tlsDir, `${name}cert.pem`)],
			{ stdio: "ignore" },
		);
	}
	tls = { cert: fs.readFileSync(path.join(tlsDir, "cert.pem")), key: fs.readFileSync(path.join(tlsDir, "key.pem")), otherKey: fs.readFileSync(path.join(tlsDir, "other-key.pem")) };
});

after(() => {
	fs.rmSync(root, { recursive: true, force: true });
	assert.equal(fs.existsSync(root), false);
});

type Mutable<T> = { -readonly [K in keyof T]: T[K] extends object ? Mutable<T[K]> : T[K] };

function rawConfig(): Mutable<Config> {
	return {
		version: 1,
		evaluation: "cua-eval-test",
		owner: OWNER,
		commit: COMMIT,
		bundle: { dir: "/opt/pim-cua/bundle", sha256: "b".repeat(64) },
		node: { path: "/opt/pim-node/bin/node", sha256: "c".repeat(64), version: "v22.18.0" },
		browser: { path: "/opt/google/chrome/chrome", sha256: "d".repeat(64) },
		workspace: "/srv/pim-workspace",
		tls: { cert: "/var/lib/pim-cua-install/cert.pem", key: "/var/lib/pim-cua-install/key.pem" },
		evalKey: { fingerprint, publicKeyPem },
		bridge: { host: "0.0.0.0", port: 8443, path: "/pim" },
		desktop: { headful: true, display: ":0", xauthority: null },
	};
}

const config = (change: (raw: Mutable<Config>) => void = () => {}): Config => {
	const raw = rawConfig();
	change(raw);
	return parseConfig(JSON.stringify(raw));
};

function refusedWith(run: () => unknown, reason: string): void {
	assert.throws(run, (error: unknown) => {
		assert.equal((error as { reason?: string }).reason, reason);
		return true;
	});
}

// ---- Synthetic VMs ----

const DESKTOP_HOME = "/home/pim-desktop";
const PASSWD = ["root:x:0:0:root:/root:/bin/bash", "daemon:x:1:1:daemon:/usr/sbin:/usr/sbin/nologin", "pim-desktop:x:1000:1000:Pim desktop:/home/pim-desktop:/bin/bash", ""].join("\n");
const GROUP = ["root:x:0:", "adm:x:4:syslog", "sudo:x:27:", "docker:x:999:", "pim-desktop:x:1000:", ""].join("\n");

const dirFact = (uid = 0, mode = 0o755): PathFact => ({ kind: "dir", uid, gid: uid, mode });
const fileFact = (uid = 0, mode = 0o755): PathFact => ({ kind: "file", uid, gid: uid, mode });

/** A new Ubuntu 24.04 VM as the installer expects it: the base image's desktop account and programs, and nothing of the installer's. */
type VM = Omit<Mutable<Facts>, "passwd" | "group" | "sudoers" | "paths"> & { passwd: string; group: string; sudoers: (string | null)[]; paths: Record<string, PathFact> };

function vm(cfg: Config): VM {
	const paths: Record<string, PathFact> = {};
	for (const p of inspectedPaths(cfg, DESKTOP_HOME)) paths[p] = null;
	const put = (p: string, fact: PathFact) => {
		let current = "";
		paths["/"] ??= dirFact();
		for (const part of p.split("/").filter(Boolean).slice(0, -1)) {
			current += `/${part}`;
			paths[current] ??= dirFact();
		}
		paths[p] = fact;
	};
	put("/run/systemd/system", dirFact());
	// Ubuntu's own layout: /etc/os-release is a link to this file, which is the one read.
	put("/usr/lib/os-release", fileFact(0, 0o644));
	for (const tool of ["/usr/sbin/groupadd", "/usr/sbin/useradd", "/usr/sbin/runuser", "/usr/sbin/nologin", "/usr/bin/systemctl", "/usr/bin/systemd-tmpfiles", "/usr/bin/head"]) put(tool, fileFact());
	put(cfg.node.path, fileFact());
	put(cfg.browser.path, fileFact());
	for (const file of ["BUNDLE", "computer/pim-computer.ts", "computer/cua-host/bridge.ts", "computer/cua-host/desktop.ts", "computer/cua-host/eval-credentials.ts", "computer/cua-host/eval-install/install.ts", "computer/cua-host/node_modules/ws/package.json"]) {
		put(`${cfg.bundle.dir}/${file}`, fileFact(0, 0o644));
	}
	put(path.dirname(cfg.tls.cert), dirFact(0, 0o700));
	put(cfg.tls.cert, fileFact(0, 0o644));
	put(cfg.tls.key, fileFact(0, 0o600));
	put(DESKTOP_HOME, dirFact(1000, 0o750));
	for (const dir of ["/etc/systemd/system", "/etc/tmpfiles.d", "/run", path.dirname(cfg.workspace)]) put(dir, dirFact());
	return {
		euid: 0,
		execPath: cfg.node.path,
		nodeVersion: cfg.node.version,
		osRelease: 'NAME="Ubuntu"\nID=ubuntu\nVERSION_ID="24.04"\n',
		passwd: PASSWD,
		group: GROUP,
		sudoers: ["root ALL=(ALL:ALL) ALL\n%admin ALL=(ALL) ALL\n%sudo ALL=(ALL:ALL) ALL\n@includedir /etc/sudoers.d\n", "# README\n"],
		paths,
		browserSha256: cfg.browser.sha256,
		bundleMarker: `pim-cua-eval-bundle v1\ncommit ${cfg.commit}\nws 8.22.0 sha512-x\n`,
		ptraceScope: "1\n",
	};
}

/** What an action is, without its content: what the plan's tests compare. */
const summary = (action: Action) => ({
	step: action.step,
	kind: action.kind,
	...("argv" in action ? { argv: action.argv } : {}),
	...("path" in action ? { path: action.path, mode: action.mode.toString(8), owner: action.owner } : {}),
});

const DESKTOP_UNIT = `# Pim Cua evaluation (docs/cua-eval-install.md): the desktop session endpoint, as the shared desktop account.
[Unit]
Description=Pim Cua evaluation desktop session endpoint
After=systemd-tmpfiles-setup.service

[Service]
Type=simple
User=pim-desktop
Group=pim-desktop
WorkingDirectory=/srv/pim-workspace
Environment=PATH=/usr/local/bin:/usr/bin:/bin
Environment=LANG=C.UTF-8
Environment=DISPLAY=:0
Environment=XDG_RUNTIME_DIR=/run/user/1000
Environment=DBUS_SESSION_BUS_ADDRESS=unix:path=/run/user/1000/bus
ExecStart=/opt/pim-node/bin/node /opt/pim-cua/bundle/computer/cua-host/desktop.ts --socket /run/pim-session/session.sock --root /srv/pim-workspace --browser /opt/google/chrome/chrome --pim-computer /opt/pim-cua/bundle/computer/pim-computer.ts --headful
KillMode=process
SendSIGKILL=no
TimeoutStopSec=infinity
Restart=no

[Install]
WantedBy=multi-user.target
`;

const BRIDGE_UNIT = `# Pim Cua evaluation (docs/cua-eval-install.md): the bridge, as its own account; it alone reads the token and TLS key.
[Unit]
Description=Pim Cua evaluation bridge
Wants=network-online.target
After=network-online.target

[Service]
Type=simple
User=pim-bridge
Group=pim-bridge
WorkingDirectory=/
Environment=PATH=/usr/bin:/bin
Environment=PIM_BRIDGE_TOKEN_FILE=/etc/pim-bridge/token
Environment=PIM_BRIDGE_CERT_FILE=/etc/pim-bridge/cert.pem
Environment=PIM_BRIDGE_KEY_FILE=/etc/pim-bridge/key.pem
ExecStart=/opt/pim-node/bin/node /opt/pim-cua/bundle/computer/cua-host/bridge.ts --space ${OWNER} --path /pim --socket /run/pim-session/session.sock --host 0.0.0.0 --port 8443
KillMode=process
Restart=no

[Install]
WantedBy=multi-user.target
`;

describe("the configuration", () => {
	it("takes the example and refuses anything else, by field", () => {
		assert.equal(config().owner, OWNER);
		const { publicKey: small } = crypto.generateKeyPairSync("rsa", { modulusLength: 2048 });
		const smallPem = small.export({ type: "spki", format: "pem" }).toString();
		const cases: [string, (raw: Mutable<Config>) => void][] = [
			["config-object", (raw) => Object.assign(raw, { extra: 1 })],
			["config-object", (raw) => delete (raw as Partial<Mutable<Config>>).workspace],
			["config-tls", (raw) => Object.assign(raw.tls, { extra: "/x" })],
			["config-owner", (raw) => (raw.owner = "o_short")],
			["config-commit", (raw) => (raw.commit = "main")],
			["config-port", (raw) => (raw.bridge.port = 443)],
			["config-port", (raw) => (raw.bridge.port = 8443.5)],
			["config-host", (raw) => (raw.bridge.host = "localhost")],
			["config-host", (raw) => (raw.bridge.host = "fe80::1%eth0")],
			["config-path", (raw) => (raw.bridge.path = "/a/../pim")],
			["config-path", (raw) => (raw.bridge.path = "/pim?x")],
			["config-dir", (raw) => (raw.bundle.dir = "opt/pim-cua/bundle")],
			["config-dir", (raw) => (raw.bundle.dir = "/opt/pim-cua/../bundle")],
			["config-workspace", (raw) => (raw.workspace = "/srv/pim workspace")],
			["config-workspace", (raw) => (raw.workspace = "/srv/$HOME")],
			["config-workspace", (raw) => (raw.workspace = "/srv/%h")],
			["config-workspace", (raw) => (raw.workspace = "/srv/x/")],
			["config-version", (raw) => (raw.node.version = "v22.17.9")],
			["config-version", (raw) => (raw.node.version = "22.18.0")],
			["config-public-key", (raw) => (raw.evalKey = { fingerprint: crypto.createHash("sha256").update(crypto.createPublicKey(smallPem).export({ type: "spki", format: "der" })).digest("hex"), publicKeyPem: smallPem })],
			["config-fingerprint", (raw) => (raw.evalKey.fingerprint = "e".repeat(64))],
			["config-desktop", (raw) => (raw.desktop.display = null)],
			["config-desktop", (raw) => (raw.desktop = { headful: false, display: ":0", xauthority: null })],
			["config-tls", (raw) => (raw.tls.key = "/var/lib/other/key.pem")],
			["config-workspace", (raw) => (raw.workspace = "/etc/systemd/system/pim-cua-bridge.service.d")],
			["config-workspace", (raw) => (raw.workspace = "/etc/pim-bridge/workspace")],
			["config-workspace", (raw) => (raw.workspace = "/srv")],
			["config-overlap", (raw) => Object.assign(raw, { bundle: { dir: "/srv/pim-cua", sha256: "b".repeat(64) }, workspace: "/srv/pim-cua/workspace" })],
			["config-overlap", (raw) => (raw.tls = { cert: "/etc/pim-bridge/cert.pem", key: "/etc/pim-bridge/key.pem" })],
			["config-overlap", (raw) => (raw.node.path = "/opt/pim-cua/bundle/node")],
		];
		for (const [reason, change] of cases) refusedWith(() => config(change), reason);
		assert.equal(parseConfig(JSON.stringify(Object.assign(rawConfig(), { node: { path: "/opt/pim-node/bin/node", sha256: "c".repeat(64), version: "v26.12.1" } }))).node.version, "v26.12.1");
	});
});

describe("the plan", () => {
	it("makes the bridge's account and the session group, the files with their owners and modes, and the services, in order", () => {
		const cfg = config();
		const actions = plan(cfg, vm(cfg));
		assert.deepEqual(actions.map(summary), [
			{ step: "tls", kind: "read-tls" },
			{ step: "session-group", kind: "run", argv: ["/usr/sbin/groupadd", "--system", "pim-session"] },
			{
				step: "bridge-account",
				kind: "run",
				argv: ["/usr/sbin/useradd", "--system", "--user-group", "--no-create-home", "--home-dir", "/nonexistent", "--shell", "/usr/sbin/nologin", "--groups", "pim-session", "pim-bridge"],
			},
			{ step: "accounts", kind: "check-accounts" },
			{ step: "eval-dir", kind: "mkdir", path: "/etc/pim-eval", mode: "755", owner: "root" },
			{ step: "public-key", kind: "write", path: "/etc/pim-eval/eval-key.pub.pem", mode: "644", owner: "root" },
			{ step: "bridge-dir", kind: "mkdir", path: "/etc/pim-bridge", mode: "700", owner: "root" },
			{ step: "cert", kind: "write", path: "/etc/pim-bridge/cert.pem", mode: "600", owner: "pim-bridge" },
			{ step: "key", kind: "write", path: "/etc/pim-bridge/key.pem", mode: "600", owner: "pim-bridge" },
			{ step: "bridge-dir-owner", kind: "chown", path: "/etc/pim-bridge", mode: "700", owner: "pim-bridge" },
			{ step: "workspace", kind: "mkdir", path: "/srv/pim-workspace", mode: "700", owner: "pim-desktop" },
			{ step: "tmpfiles", kind: "write", path: "/etc/tmpfiles.d/pim-cua-session.conf", mode: "644", owner: "root" },
			{ step: "desktop-unit", kind: "write", path: "/etc/systemd/system/pim-cua-desktop.service", mode: "644", owner: "root" },
			{ step: "bridge-unit", kind: "write", path: "/etc/systemd/system/pim-cua-bridge.service", mode: "644", owner: "root" },
			{ step: "socket-dir", kind: "run", argv: ["/usr/bin/systemd-tmpfiles", "--create", "/etc/tmpfiles.d/pim-cua-session.conf"] },
			{ step: "daemon-reload", kind: "run", argv: ["/usr/bin/systemctl", "daemon-reload"] },
			{ step: "units", kind: "check-units" },
			{ step: "enable", kind: "run", argv: ["/usr/bin/systemctl", "enable", "pim-cua-desktop.service", "pim-cua-bridge.service"] },
			{ step: "staged-tls", kind: "remove-staged" },
		]);
		const content = (step: string) => {
			const action = actions.find((a) => a.step === step);
			return action?.kind === "write" ? action.content : undefined;
		};
		assert.deepEqual(content("public-key"), { text: publicKeyPem });
		assert.deepEqual(content("cert"), { staged: "cert" });
		assert.deepEqual(content("key"), { staged: "key" });
		assert.deepEqual(content("tmpfiles"), { text: "# Pim Cua evaluation (docs/cua-eval-install.md): the session socket's directory.\nd /run/pim-session 2750 pim-desktop pim-session -\n" });
		assert.deepEqual(content("desktop-unit"), { text: DESKTOP_UNIT });
		assert.deepEqual(content("bridge-unit"), { text: BRIDGE_UNIT });
		// Nothing starts: start.sh does, once the token is there.
		assert.equal(
			actions.some((a) => a.kind === "run" && (a.argv.includes("start") || a.argv.includes("--now"))),
			false,
		);
	});

	it("refuses an unsafe or unexpected VM before it changes anything", () => {
		const cfg = config();
		const cases: [string, (facts: ReturnType<typeof vm>) => void, Config?][] = [
			["root-required", (f) => (f.euid = 1000)],
			["os", (f) => (f.osRelease = 'ID=ubuntu\nVERSION_ID="22.04"\n')],
			["os", (f) => (f.osRelease = null)],
			["os", (f) => (f.paths["/usr/lib/os-release"] = { kind: "link", uid: 0, gid: 0, mode: 0o777 })],
			["os", (f) => (f.paths["/usr/lib/os-release"] = fileFact(0, 0o664))],
			["os", (f) => (f.paths["/usr/lib/os-release"] = fileFact(1000, 0o644))],
			["os", (f) => (f.paths["/usr/lib"] = dirFact(1000))],
			["accounts-unreadable", (f) => ((f as Mutable<Facts>).passwd = null)],
			["accounts-unreadable", (f) => ((f as Mutable<Facts>).group = null)],
			["sudoers-unreadable", (f) => ((f as Mutable<Facts>).sudoers = null)],
			["sudoers-unreadable", (f) => (f.sudoers = [])],
			["sudoers-unreadable", (f) => (f.sudoers = [...f.sudoers, null])],
			["systemd", (f) => (f.paths["/run/systemd/system"] = null)],
			["ptrace-scope", (f) => (f.ptraceScope = "0\n")],
			["ptrace-scope", (f) => (f.ptraceScope = null)],
			["tools", (f) => (f.paths["/usr/sbin/useradd"] = fileFact(0, 0o775))],
			["tools", (f) => (f.paths["/usr/bin"] = dirFact(1000))],
			["node-path", (f) => (f.execPath = "/usr/bin/node")],
			["node-path", (f) => (f.paths[cfg.node.path] = { kind: "link", uid: 0, gid: 0, mode: 0o777 })],
			["node-version", (f) => (f.nodeVersion = "v22.19.0")],
			["bundle", (f) => (f.paths[`${cfg.bundle.dir}/computer/cua-host/bridge.ts`] = fileFact(1000, 0o644))],
			["bundle", (f) => (f.paths["/opt/pim-cua"] = dirFact(0, 0o1777))],
			["bundle", (f) => (f.paths[`${cfg.bundle.dir}/computer/cua-host/node_modules/ws/package.json`] = null)],
			["bundle-commit", (f) => (f.bundleMarker = `pim-cua-eval-bundle v1\ncommit ${"f".repeat(40)}\n`)],
			["browser", (f) => (f.paths[cfg.browser.path] = { kind: "link", uid: 0, gid: 0, mode: 0o777 })],
			["browser", (f) => (f.paths[cfg.browser.path] = fileFact(0, 0o644))],
			["browser", (f) => (f.paths[cfg.browser.path] = fileFact(0, 0o750))],
			["node-path", (f) => (f.paths[cfg.node.path] = fileFact(0, 0o750))],
			["browser-digest", (f) => (f.browserSha256 = "0".repeat(64))],
			["unreachable", (f) => (f.paths["/opt/pim-cua"] = dirFact(0, 0o750))],
			["unreachable", (f) => (f.paths["/opt/pim-cua/bundle"] = dirFact(0, 0o700))],
			["unreachable", (f) => (f.paths["/opt/pim-node/bin"] = dirFact(0, 0o750))],
			["unreachable", (f) => (f.paths["/opt/google"] = dirFact(0, 0o700))],
			["unreachable", (f) => (f.paths["/srv"] = dirFact(0, 0o750))],
			["preexisting-account", (f) => (f.passwd += "pim-bridge:x:998:998::/nonexistent:/usr/sbin/nologin\n")],
			["preexisting-account", (f) => (f.group += "pim-session:x:997:\n")],
			["preexisting-account", (f) => (f.group += "pim-bridge:x:997:\n")],
			["desktop-account-missing", (f) => (f.passwd = f.passwd.replace(/^pim-desktop:.*\n/m, ""))],
			["desktop-account", (f) => (f.passwd = f.passwd.replace("pim-desktop:x:1000:", "pim-desktop:x:0:"))],
			["desktop-account", (f) => (f.passwd += "other:x:1000:1001::/home/other:/bin/bash\n")],
			["desktop-group", (f) => (f.group = f.group.replace("pim-desktop:x:1000:", "users:x:1000:"))],
			["desktop-groups", (f) => (f.group = f.group.replace("sudo:x:27:", "sudo:x:27:pim-desktop"))],
			["desktop-groups", (f) => (f.group = f.group.replace("docker:x:999:", "docker:x:999:someone,pim-desktop"))],
			["sudoers", (f) => (f.sudoers = [...f.sudoers, "pim-desktop ALL=(ALL) NOPASSWD: ALL\n"])],
			["sudoers", (f) => (f.sudoers = [...f.sudoers, "%pim-session ALL=(ALL) ALL\n"])],
			["desktop-home", (f) => (f.paths[DESKTOP_HOME] = dirFact(1000, 0o770))],
			["desktop-home", (f) => (f.paths[DESKTOP_HOME] = dirFact(0, 0o755))],
			["preexisting-path", (f) => (f.paths["/etc/pim-bridge"] = dirFact())],
			["preexisting-path", (f) => (f.paths["/etc/pim-eval"] = dirFact())],
			["preexisting-path", (f) => (f.paths["/run/pim-session"] = dirFact(1000, 0o2750))],
			["preexisting-path", (f) => (f.paths["/etc/systemd/system/pim-cua-bridge.service.d"] = dirFact())],
			["preexisting-path", (f) => (f.paths["/etc/systemd/system/pim-cua-desktop.service"] = { kind: "link", uid: 0, gid: 0, mode: 0o777 })],
			["preexisting-path", (f) => (f.paths["/srv/pim-workspace"] = dirFact(1000, 0o700))],
			["unsafe-parent", (f) => (f.paths["/srv"] = dirFact(1000))],
			["unsafe-parent", (f) => (f.paths["/etc/tmpfiles.d"] = dirFact(0, 0o777))],
			["tls-staging", (f) => (f.paths["/var/lib/pim-cua-install"] = dirFact(0, 0o755))],
			["tls-staging", (f) => (f.paths[cfg.tls.key] = fileFact(0, 0o640))],
			["tls-staging", (f) => (f.paths[cfg.tls.key] = { kind: "link", uid: 0, gid: 0, mode: 0o777 })],
			["tls-staging", (f) => (f.paths[cfg.tls.cert] = fileFact(1000, 0o644))],
			["tls-staging", (f) => (f.paths["/var/lib"] = dirFact(1000))],
		];
		for (const [reason, change] of cases) {
			const facts = vm(cfg);
			change(facts);
			refusedWith(() => plan(cfg, facts), reason);
		}
		const listed = vm(cfg);
		listed.group = listed.group.replace("pim-desktop:x:1000:", "pim-desktop:x:1000:pim-desktop");
		assert.equal(plan(cfg, listed).length, 19);
		const inHome = config((raw) => (raw.workspace = "/srv/home/pim-desktop/workspace"));
		const homeFacts = vm(inHome);
		homeFacts.passwd = homeFacts.passwd.replace(":/home/pim-desktop:", ":/srv/home/pim-desktop:");
		homeFacts.paths["/srv/home"] = dirFact();
		homeFacts.paths["/srv/home/pim-desktop"] = dirFact(1000, 0o751);
		refusedWith(() => plan(inHome, homeFacts), "config-overlap");
	});

	it("looks at every directory above what it checks", () => {
		const paths = inspectedPaths(config(), DESKTOP_HOME);
		for (const p of ["/", "/opt", "/opt/pim-cua", "/opt/pim-cua/bundle/computer/cua-host/node_modules/ws", "/var/lib/pim-cua-install", "/etc/systemd", "/home", "/srv"]) assert.ok(paths.includes(p), p);
	});
});

describe("the services", () => {
	const keys = (unit: string) => unit.split("\n").filter((line) => /^[A-Za-z]+=/.test(line)).map((line) => line.split("=")[0]);
	const env = (unit: string) => unit.split("\n").filter((line) => line.startsWith("Environment=")).map((line) => line.slice("Environment=".length).split("=")[0]);

	it("run each program as its own non-root account, with fixed arguments, only the allowed variables, and no confinement or group kill", () => {
		const units = renderUnits(config(), 1000);
		assert.equal(units.desktop, DESKTOP_UNIT);
		assert.equal(units.bridge, BRIDGE_UNIT);
		// Only these directives: no resource, confinement, sandboxing, capability, delegation or restart policy.
		const allowed = new Set(["Description", "Wants", "After", "Type", "User", "Group", "WorkingDirectory", "Environment", "ExecStart", "KillMode", "SendSIGKILL", "TimeoutStopSec", "Restart", "WantedBy"]);
		for (const unit of [units.desktop, units.bridge]) {
			for (const key of keys(unit)) assert.ok(allowed.has(key!), key);
			assert.match(unit, /^KillMode=process$/m);
			assert.match(unit, /^Restart=no$/m);
			assert.doesNotMatch(unit, /^(User|Group)=(root|0)$/m);
		}
		for (const name of env(units.desktop)) assert.ok((KEPT_ENVIRONMENT as readonly string[]).includes(name!), name);
		assert.deepEqual(env(units.bridge), ["PATH", "PIM_BRIDGE_TOKEN_FILE", "PIM_BRIDGE_CERT_FILE", "PIM_BRIDGE_KEY_FILE"]);
		// The desktop's has no SIGKILL and no stop timeout, so systemd never ends pim-computer or the browser itself.
		assert.match(units.desktop, /^SendSIGKILL=no$/m);
		assert.match(units.desktop, /^TimeoutStopSec=infinity$/m);
	});

	it("give a headless browser no display", () => {
		const desktop = renderUnits(config((raw) => (raw.desktop = { headful: false, display: null, xauthority: null })), 1000).desktop;
		assert.deepEqual(env(desktop), ["PATH", "LANG"]);
		assert.doesNotMatch(desktop, /--headful/);
		const xauth = renderUnits(config((raw) => (raw.desktop.xauthority = "/home/pim-desktop/.Xauthority")), 1001).desktop;
		assert.deepEqual(env(xauth), ["PATH", "LANG", "DISPLAY", "XAUTHORITY", "XDG_RUNTIME_DIR", "DBUS_SESSION_BUS_ADDRESS"]);
		assert.match(xauth, /^Environment=XDG_RUNTIME_DIR=\/run\/user\/1001$/m);
	});

	it("make the socket directory the desktop's, setgid to the session group", () => {
		assert.match(renderTmpfiles(), /^d \/run\/pim-session 2750 pim-desktop pim-session -$/m);
	});
});

// ---- apply, against a stand-in VM ----

type Entry = { kind: "file" | "dir"; uid: number; gid: number; mode: number; bytes?: Buffer };

/** A VM in memory: what `apply` asks of it, and what its groupadd and useradd would do. */
class StandIn implements Host {
	readonly ops: string[] = [];
	readonly entries = new Map<string, Entry>();
	passwd = PASSWD;
	group = GROUP;
	shadow = "root:*:19000:0:99999:7:::\npim-desktop:$y$hash:19000:0:99999:7:::\n";
	failOn: string | undefined;
	/** A drop-in some other package left for a unit, which systemd would merge. */
	dropIn: string | undefined;
	readonly staged: Record<string, Staged>;
	readonly removed: string[] = [];

	constructor(cfg: Config, cert: Buffer, key: Buffer) {
		this.staged = { [cfg.tls.cert]: { bytes: Buffer.from(cert), dev: 1, ino: 10 }, [cfg.tls.key]: { bytes: Buffer.from(key), dev: 1, ino: 11 } };
	}
	readText(file: string) {
		this.ops.push(`read ${file}`);
		return ({ "/etc/passwd": this.passwd, "/etc/group": this.group, "/etc/shadow": this.shadow } as Record<string, string>)[file] ?? "";
	}
	readStaged(file: string) {
		this.ops.push(`read-staged ${file}`);
		const staged = this.staged[file];
		if (!staged) throw new Error("ENOENT");
		return staged;
	}
	mkdirNew(dir: string, mode: number, uid: number, gid: number) {
		this.ops.push(`mkdir ${dir} ${mode.toString(8)} ${uid}:${gid}`);
		if (this.entries.has(dir)) throw new Error("EEXIST");
		this.entries.set(dir, { kind: "dir", uid, gid, mode });
	}
	writeNew(file: string, bytes: Buffer, mode: number, uid: number, gid: number) {
		this.ops.push(`write ${file} ${mode.toString(8)} ${uid}:${gid}`);
		if (this.failOn === file) throw new Error("EIO");
		if (this.entries.has(file)) throw new Error("EEXIST");
		this.entries.set(file, { kind: "file", uid, gid, mode, bytes: Buffer.from(bytes) });
	}
	chownDir(dir: string, mode: number, uid: number, gid: number) {
		this.ops.push(`chown ${dir} ${mode.toString(8)} ${uid}:${gid}`);
		const entry = this.entries.get(dir);
		if (entry?.kind !== "dir" || entry.uid !== 0) throw new Error("not root's");
		Object.assign(entry, { uid, gid, mode });
	}
	removeStaged(file: string, staged: Staged) {
		this.ops.push(`remove-staged ${file}`);
		assert.equal(staged, this.staged[file]);
		this.removed.push(file);
	}
	query(argv: readonly string[]) {
		this.ops.push(`query ${argv.join(" ")}`);
		const unit = argv.at(-1)!;
		const desktop = unit === "pim-cua-desktop.service";
		const fragment = `/etc/systemd/system/${unit}`;
		// As systemctl show prints them: in its own order, not the order asked for.
		const lines = [`User=${desktop ? "pim-desktop" : "pim-bridge"}`, "KillMode=process", `FragmentPath=${this.entries.has(fragment) ? fragment : ""}`, `DropInPaths=${this.dropIn === unit ? `/usr/lib/systemd/system/${unit}.d/override.conf` : ""}`];
		return { status: 0, stdout: `${lines.join("\n")}\n` };
	}
	run(argv: readonly string[]) {
		this.ops.push(`run ${argv.join(" ")}`);
		if (this.failOn === argv[0]) throw new Error("exit 1");
		if (argv[0] === "/usr/sbin/groupadd") this.group += "pim-session:x:998:\n";
		if (argv[0] === "/usr/sbin/useradd") {
			this.passwd += "pim-bridge:x:997:997::/nonexistent:/usr/sbin/nologin\n";
			this.group = this.group.replace("pim-session:x:998:", "pim-session:x:998:pim-bridge") + "pim-bridge:x:997:\n";
			this.shadow += "pim-bridge:!:19000::::::\n";
		}
	}
}

describe("apply", () => {
	it("does the plan, giving the bridge's files to the account useradd made, and keeps no key", () => {
		const cfg = config();
		const host = new StandIn(cfg, tls.cert, tls.key);
		const keyBytes = host.staged[cfg.tls.key]!.bytes;
		apply(cfg, plan(cfg, vm(cfg)), host);
		const at = (file: string) => {
			const entry = host.entries.get(file);
			return entry && { kind: entry.kind, owner: `${entry.uid}:${entry.gid}`, mode: entry.mode.toString(8) };
		};
		assert.deepEqual(
			Object.fromEntries([...host.entries.keys()].map((file) => [file, at(file)])),
			{
				"/etc/pim-eval": { kind: "dir", owner: "0:0", mode: "755" },
				"/etc/pim-eval/eval-key.pub.pem": { kind: "file", owner: "0:0", mode: "644" },
				"/etc/pim-bridge": { kind: "dir", owner: "997:997", mode: "700" },
				"/etc/pim-bridge/cert.pem": { kind: "file", owner: "997:997", mode: "600" },
				"/etc/pim-bridge/key.pem": { kind: "file", owner: "997:997", mode: "600" },
				"/srv/pim-workspace": { kind: "dir", owner: "1000:1000", mode: "700" },
				"/etc/tmpfiles.d/pim-cua-session.conf": { kind: "file", owner: "0:0", mode: "644" },
				"/etc/systemd/system/pim-cua-desktop.service": { kind: "file", owner: "0:0", mode: "644" },
				"/etc/systemd/system/pim-cua-bridge.service": { kind: "file", owner: "0:0", mode: "644" },
			},
		);
		assert.deepEqual(host.entries.get("/etc/pim-bridge/key.pem")?.bytes, tls.key);
		assert.deepEqual(host.entries.get("/etc/pim-bridge/cert.pem")?.bytes, tls.cert);
		assert.equal(host.entries.get("/etc/systemd/system/pim-cua-bridge.service")?.bytes?.toString(), BRIDGE_UNIT);
		// The bridge's directory was root's while its files were written, and given to the bridge after.
		const order = host.ops.filter((op) => op.includes("/etc/pim-bridge"));
		assert.deepEqual(order, ["mkdir /etc/pim-bridge 700 0:0", "write /etc/pim-bridge/cert.pem 600 997:997", "write /etc/pim-bridge/key.pem 600 997:997", "chown /etc/pim-bridge 700 997:997"]);
		assert.deepEqual(host.removed, [cfg.tls.key, cfg.tls.cert]);
		assert.ok(keyBytes.every((byte) => byte === 0));
		assert.deepEqual(
			host.ops.filter((op) => op.startsWith("query ") || op.includes("systemctl")),
			[
				"run /usr/bin/systemctl daemon-reload",
				"query /usr/bin/systemctl show --property=FragmentPath,DropInPaths,User,KillMode pim-cua-desktop.service",
				"query /usr/bin/systemctl show --property=FragmentPath,DropInPaths,User,KillMode pim-cua-bridge.service",
				"run /usr/bin/systemctl enable pim-cua-desktop.service pim-cua-bridge.service",
			],
		);
		// The token is never made or read here: only seal makes it, as the bridge.
		assert.equal(
			host.ops.some((op) => op.includes("/etc/pim-bridge/token")),
			false,
		);
	});

	it("stops at the first failure, says which step and whether anything changed, and undoes nothing", () => {
		const cfg = config();
		const actions = plan(cfg, vm(cfg));

		const mismatched = new StandIn(cfg, tls.cert, tls.otherKey);
		assert.throws(
			() => apply(cfg, actions, mismatched),
			(error: unknown) => error instanceof ApplyFailure && error.step === "tls" && error.reason === "tls" && !error.changed,
		);
		assert.deepEqual(mismatched.ops, [`read-staged ${cfg.tls.cert}`, `read-staged ${cfg.tls.key}`]);
		assert.ok(mismatched.staged[cfg.tls.key]!.bytes.every((byte) => byte === 0));

		const expired = new StandIn(cfg, tls.cert, tls.key);
		assert.throws(() => apply(cfg, actions, expired, Date.now() + 5 * 24 * 3600 * 1000), (error: unknown) => error instanceof ApplyFailure && error.step === "tls");

		const noUser = new StandIn(cfg, tls.cert, tls.key);
		noUser.failOn = "/usr/sbin/useradd";
		assert.throws(
			() => apply(cfg, actions, noUser),
			(error: unknown) => error instanceof ApplyFailure && error.step === "bridge-account" && error.changed,
		);
		assert.equal(noUser.entries.size, 0);
		assert.deepEqual(noUser.removed, []);

		const failedKey = new StandIn(cfg, tls.cert, tls.key);
		failedKey.failOn = "/etc/pim-bridge/key.pem";
		assert.throws(
			() => apply(cfg, actions, failedKey),
			(error: unknown) => error instanceof ApplyFailure && error.step === "key" && error.changed,
		);
		// The bridge's directory stays root's, and the staged files stay where they were.
		assert.equal(failedKey.entries.get("/etc/pim-bridge")?.uid, 0);
		assert.deepEqual(failedKey.removed, []);

		// A drop-in anywhere systemd looks stops it before either unit is enabled.
		const merged = new StandIn(cfg, tls.cert, tls.key);
		merged.dropIn = "pim-cua-bridge.service";
		assert.throws(
			() => apply(cfg, actions, merged),
			(error: unknown) => error instanceof ApplyFailure && error.step === "units" && error.reason === "unit-check",
		);
		assert.equal(
			merged.ops.some((op) => op.includes("systemctl enable")),
			false,
		);
		assert.deepEqual(merged.removed, []);

		// An account useradd left otherwise than expected stops it before any file is made.
		const strange = new StandIn(cfg, tls.cert, tls.key);
		const run = strange.run.bind(strange);
		strange.run = (argv) => {
			run(argv);
			if (argv[0] === "/usr/sbin/useradd") strange.group = strange.group.replace("docker:x:999:", "docker:x:999:pim-bridge");
		};
		assert.throws(
			() => apply(cfg, actions, strange),
			(error: unknown) => error instanceof ApplyFailure && error.step === "accounts" && error.reason === "accounts",
		);
		assert.equal(strange.entries.size, 0);
	});
});

describe("the accounts", () => {
	const passwd = `${PASSWD}pim-bridge:x:997:997::/nonexistent:/usr/sbin/nologin\n`;
	const group = `${GROUP}pim-session:x:998:pim-bridge\npim-bridge:x:997:\n`;
	const shadow = "pim-bridge:!:19000::::::\n";

	it("are the bridge in its own and the session group only, and the desktop in its own", () => {
		const accounts = checkAccounts(passwd, group, shadow);
		assert.deepEqual([accounts.bridge.uid, accounts.desktop.uid, accounts.sessionGid], [997, 1000, 998]);
		const cases: [string, string, string][] = [
			[passwd.replace("pim-bridge:x:997:997::/nonexistent:/usr/sbin/nologin", "pim-bridge:x:997:997::/nonexistent:/bin/bash"), group, shadow],
			[passwd.replace("pim-bridge:x:997:997::/nonexistent:", "pim-bridge:x:997:997::/home/pim-bridge:"), group, shadow],
			[passwd.replace("pim-bridge:x:997:", "pim-bridge:x:1001:"), group, shadow],
			[passwd.replace("pim-bridge:x:997:", "pim-bridge:x:0:"), group, shadow],
			[passwd, group.replace("docker:x:999:", "docker:x:999:pim-bridge"), shadow],
			[passwd, group.replace("pim-session:x:998:pim-bridge", "pim-session:x:998:pim-bridge,pim-desktop"), shadow],
			[passwd, group.replace("pim-session:x:998:pim-bridge", "pim-session:x:998:"), shadow],
			[passwd, group.replace("pim-desktop:x:1000:", "pim-desktop:x:1000:pim-bridge"), shadow],
			[passwd, group, "pim-bridge:$y$hash:19000::::::\n"],
			[passwd, group, ""],
		];
		for (const [p, g, s] of cases) refusedWith(() => checkAccounts(p, g, s), "accounts");
	});
});

// ---- status and start, against stand-in probes ----

function probe(entries: Record<string, PathFact>, texts: Record<string, string>, answers: (argv: readonly string[]) => { status: number | null; stdout: string }) {
	const read: string[] = [];
	const queries: string[][] = [];
	const value: Probe = {
		lstat: (file) => entries[file] ?? null,
		readText: (file) => {
			read.push(file);
			return texts[file] ?? null;
		},
		query: (argv) => {
			queries.push([...argv]);
			return answers(argv);
		},
	};
	return { value, read, queries };
}

/** How `systemctl show --property=LoadState,ActiveState,SubState,Result` answers, in systemd's own order. */
const shown = (active: string, sub: string, result: string, load = "loaded") => ({ status: 0, stdout: `LoadState=${load}\nActiveState=${active}\nSubState=${sub}\nResult=${result}\n` });
const SHOW = ["/usr/bin/systemctl", "show", "--property=LoadState,ActiveState,SubState,Result"];

describe("status", () => {
	it("says metadata only, and checks as the desktop account that each secret file is refused, reading none of them", () => {
		const cfg = config();
		const installed = {
			"/etc/pim-bridge": dirFact(997, 0o700),
			"/etc/pim-bridge/token": fileFact(997, 0o600),
			"/etc/pim-bridge/cert.pem": fileFact(997, 0o600),
			"/etc/pim-bridge/key.pem": fileFact(997, 0o600),
			"/run/pim-session": { kind: "dir", uid: 1000, gid: 998, mode: 0o2750 },
			"/run/pim-session/session.sock": { kind: "socket", uid: 1000, gid: 998, mode: 0o660 },
			"/tmp/.X11-unix/X0": { kind: "socket", uid: 1000, gid: 1000, mode: 0o777 },
			"/run/user/1000": dirFact(1000, 0o700),
			"/etc/pim-eval/eval-key.pub.pem": fileFact(0, 0o644),
		} satisfies Record<string, PathFact>;
		const texts = {
			"/etc/passwd": `${PASSWD}pim-bridge:x:997:997::/nonexistent:/usr/sbin/nologin\n`,
			"/etc/group": `${GROUP}pim-session:x:998:pim-bridge\npim-bridge:x:997:\n`,
			"/etc/shadow": "pim-bridge:!:19000::::::\n",
			"/etc/pim-bridge/cert.pem": tls.cert.toString(),
			"/proc/sys/kernel/yama/ptrace_scope": "1\n",
		};
		const readable = new Set(["/etc/pim-eval/eval-key.pub.pem", "/etc/pim-bridge/cert.pem"]);
		let bridgeShow = shown("failed", "failed", "exit-code");
		const { value, read, queries } = probe(installed, texts, (argv) => {
			if (argv[0] === "/usr/sbin/runuser") return { status: readable.has(argv.at(-1)!) ? 0 : 1, stdout: "" };
			if (argv[1] === "is-enabled") return { status: 0, stdout: "enabled\n" };
			return argv.at(-1) === "pim-cua-desktop.service" ? shown("active", "running", "success") : bridgeShow;
		});
		const report = status(cfg, value);
		assert.equal(report.accounts, "ok");
		assert.deepEqual(report.denied, { "/etc/pim-bridge/token": "denied", "/etc/pim-bridge/cert.pem": "READABLE", "/etc/pim-bridge/key.pem": "denied" });
		assert.deepEqual((report.paths as Record<string, string>)["/etc/pim-bridge/key.pem"], "file pim-bridge:pim-bridge 0600");
		assert.deepEqual((report.paths as Record<string, string>)["/run/pim-session"], "dir pim-desktop:pim-session 2750");
		assert.deepEqual((report.paths as Record<string, string>)[cfg.tls.key], "absent");
		assert.deepEqual(report.units, {
			"pim-cua-desktop.service": { enabled: "enabled", LoadState: "loaded", ActiveState: "active", SubState: "running", Result: "success" },
			"pim-cua-bridge.service": { enabled: "enabled", LoadState: "loaded", ActiveState: "failed", SubState: "failed", Result: "exit-code" },
		});
		assert.deepEqual(report.display, { socket: true, runtimeDir: true });
		assert.equal(report.ptraceScope, "1");
		const x509 = new crypto.X509Certificate(tls.cert);
		assert.equal((report.certificate as Record<string, string>).sha256, x509.fingerprint256);
		// The token and the key are never read; the certificate (public) is, to report its fingerprint and dates. Nothing under /sys is.
		assert.equal(read.includes("/etc/pim-bridge/token") || read.includes("/etc/pim-bridge/key.pem"), false);
		assert.equal(
			read.some((file) => file.startsWith("/sys/")),
			false,
		);
		const text = JSON.stringify(report);
		assert.doesNotMatch(text, /BEGIN|PRIVATE/);
		assert.ok(!text.includes(tls.cert.toString().split("\n")[1]!));
		assert.deepEqual(
			queries.filter((argv) => argv[0] === "/usr/sbin/runuser"),
			["/etc/pim-eval/eval-key.pub.pem", "/etc/pim-bridge/token", "/etc/pim-bridge/cert.pem", "/etc/pim-bridge/key.pem"].map((file) => ["/usr/sbin/runuser", "-u", "pim-desktop", "--", "/usr/bin/head", "-c", "0", "--", file]),
		);
		for (const argv of queries.filter((argv) => argv[0] === "/usr/bin/systemctl")) assert.ok(argv[1] === "is-enabled" || JSON.stringify(argv.slice(0, 3)) === JSON.stringify(SHOW), argv.join(" "));
		// When the desktop account can't open even the public key, the check failed, and says so rather than "denied".
		readable.clear();
		// And a unit state that can't be read whole is unknown, not a state.
		bridgeShow = { status: 0, stdout: "LoadState=loaded\nActiveState=failed\n" };
		const again = status(cfg, value);
		assert.deepEqual(again.denied, { "/etc/pim-bridge/token": "unknown", "/etc/pim-bridge/cert.pem": "unknown", "/etc/pim-bridge/key.pem": "unknown" });
		assert.deepEqual((again.units as Record<string, unknown>)["pim-cua-bridge.service"], { enabled: "enabled", state: "unknown" });
	});
});

describe("start", () => {
	const cfg = config();
	const texts = { "/etc/passwd": `${PASSWD}pim-bridge:x:997:997::/nonexistent:/usr/sbin/nologin\n` };
	const ready: Record<string, PathFact> = { "/etc/pim-bridge/token": fileFact(997, 0o600), "/tmp/.X11-unix/X0": { kind: "socket", uid: 1000, gid: 1000, mode: 0o777 }, "/run/user/1000": dirFact(1000, 0o700) };
	type Answer = { status: number | null; stdout: string };
	const attempt = (entries: Record<string, PathFact>, desktop: Answer, bridge: Answer = shown("inactive", "dead", "success")) => {
		const started: string[] = [];
		const { value, read, queries } = probe(entries, texts, (argv) => (argv.at(-1) === "pim-cua-desktop.service" ? desktop : bridge));
		let reason: string | undefined;
		try {
			start(cfg, value, (argv) => started.push(argv.join(" ")));
		} catch (error) {
			reason = (error as { reason?: string }).reason ?? "thrown";
		}
		for (const argv of queries) assert.deepEqual(argv.slice(0, 3), SHOW);
		assert.equal(
			read.some((file) => file.startsWith("/sys/")),
			false,
		);
		return { started, reason };
	};

	it("starts the desktop endpoint, then the bridge, when the token is the bridge's, the display is there, and the endpoint never ran, stopped cleanly or runs", () => {
		const both = ["/usr/bin/systemctl start pim-cua-desktop.service", "/usr/bin/systemctl start pim-cua-bridge.service"];
		assert.deepEqual(attempt(ready, shown("inactive", "dead", "success")), { started: both, reason: undefined });
		assert.deepEqual(attempt(ready, shown("active", "running", "success")), { started: both, reason: undefined });
		// The bridge starts nothing of its own: a bridge that failed (as it does at boot before seal) may be started again.
		assert.deepEqual(attempt(ready, shown("inactive", "dead", "success"), shown("failed", "failed", "exit-code")), { started: both, reason: undefined });
	});

	it("refuses, starting nothing, without the token or the display, or after the endpoint ended any other way or its state can't be read", () => {
		const cases: [string, Record<string, PathFact>, Answer, Answer?][] = [
			["token-missing", { ...ready, "/etc/pim-bridge/token": null }, shown("inactive", "dead", "success")],
			["token-missing", { ...ready, "/etc/pim-bridge/token": fileFact(1000, 0o600) }, shown("inactive", "dead", "success")],
			["token-missing", { ...ready, "/etc/pim-bridge/token": fileFact(997, 0o640) }, shown("inactive", "dead", "success")],
			["display-missing", { ...ready, "/tmp/.X11-unix/X0": null }, shown("inactive", "dead", "success")],
			["display-missing", { ...ready, "/run/user/1000": null }, shown("inactive", "dead", "success")],
			// Ended abnormally: not recoverable in place, whatever it left.
			["desktop-not-clean", ready, shown("failed", "failed", "exit-code")],
			["desktop-not-clean", ready, shown("failed", "failed", "signal")],
			["desktop-not-clean", ready, shown("inactive", "dead", "signal")],
			["desktop-not-clean", ready, shown("inactive", "dead", "core-dump")],
			["desktop-not-clean", ready, shown("deactivating", "stop-sigterm", "success")],
			["desktop-not-clean", ready, shown("activating", "start", "success")],
			["desktop-not-clean", ready, shown("active", "exited", "success")],
			["desktop-not-clean", ready, shown("inactive", "dead", "success", "not-found")],
			// What can't be read whole is refused, not taken as clean.
			["desktop-not-clean", ready, { status: 1, stdout: "" }],
			["desktop-not-clean", ready, { status: null, stdout: "" }],
			["desktop-not-clean", ready, { status: 0, stdout: "" }],
			["desktop-not-clean", ready, { status: 0, stdout: "LoadState=loaded\nActiveState=inactive\nSubState=dead\n" }],
			["desktop-not-clean", ready, { status: 0, stdout: "LoadState=loaded\nActiveState=failed\nActiveState=inactive\nSubState=dead\nResult=success\n" }],
			["desktop-not-clean", ready, { status: 0, stdout: "LoadState=loaded\nActiveState=inactive\nSubState=dead\nResult=success\nMainPID=0\n" }],
			["bridge-state", ready, shown("inactive", "dead", "success"), shown("deactivating", "stop-sigterm", "success")],
			["bridge-state", ready, shown("inactive", "dead", "success"), { status: 1, stdout: "" }],
			["bridge-state", ready, shown("inactive", "dead", "success"), shown("inactive", "dead", "success", "masked")],
		];
		for (const [reason, entries, desktop, bridge] of cases) assert.deepEqual(attempt(entries, desktop, bridge), { started: [], reason }, `${reason}: ${desktop.stdout}`);
	});
});

// ---- The management scripts ----

describe("the management scripts", () => {
	it("are bash, hold the configuration only as a quoted here-document, and call nothing in the cloud", () => {
		const cfg = config();
		const scripts = renderScripts(cfg);
		assert.deepEqual(Object.keys(scripts).sort(), ["install.sh", "plan.sh", "seal.sh", "start.sh", "status.sh"]);
		for (const [name, script] of Object.entries(scripts)) {
			const checked = spawnSync("bash", ["-n"], { input: script, encoding: "utf8" });
			assert.equal(checked.status, 0, `${name}: ${checked.stderr}`);
			assert.match(script, /^#!\/bin\/bash\n/);
			assert.match(script, /^set -euo pipefail$/m);
			assert.doesNotMatch(script, /set -x|xtrace|\bcurl\b|\bwget\b|\baz\b|https?:|\bcat\b|\btee\b|^\s*eval\s|PRIVATE KEY|\bkill|setcap|cgroup|systemd-run|chown -R|rm -r/m);
			// The pins are checked before anything runs from them.
			const exec = script.indexOf("\nexec ");
			for (const check of ["fail root-required", "fail node-digest", "fail bundle-ownership", "fail bundle-digest"]) assert.ok(script.indexOf(check) > 0 && script.indexOf(check) < exec, `${name}: ${check}`);
			assert.equal(script.split("\nexec ").length, 2, `${name} execs once`);
		}
		for (const command of ["plan", "install", "start", "status"]) {
			const script = scripts[`${command}.sh`]!;
			const match = /\nexec "\$NODE" "\$BUNDLE\/computer\/cua-host\/eval-install\/install\.ts" ([a-z]+) <<'PIM_CUA_EVAL_CONFIG'\n(.*)\nPIM_CUA_EVAL_CONFIG\n$/.exec(script);
			assert.ok(match, command);
			assert.equal(match[1], command);
			assert.deepEqual(parseConfig(match[2]!), cfg);
		}
	});

	it("seal once, as the bridge, with fixed arguments, and send nothing but the envelope to standard output", () => {
		const cfg = config();
		const seal = renderScripts(cfg)["seal.sh"]!;
		const tail = seal.slice(seal.indexOf("\nexec ") + 1);
		assert.equal(
			tail,
			`exec /usr/sbin/runuser -u pim-bridge -- "$NODE" "$BUNDLE/computer/cua-host/eval-credentials.ts" seal \\
	--evaluation 'cua-eval-test' --owner '${OWNER}' \\
	--public-key /etc/pim-eval/eval-key.pub.pem --fingerprint '${fingerprint}' \\
	--token-file /etc/pim-bridge/token </dev/null
`,
		);
		// Before the exec, nothing writes to standard output. Every top-level statement is one of these, whose output is captured or
		// goes to standard error through `fail`; the functions that print are `fail` (to standard error) and the digest's two, which
		// only ever run inside a command substitution; and every other command a function runs has its output captured.
		const before = seal.slice(0, seal.indexOf("\nexec "));
		const functions: Record<string, string[]> = {};
		const top: string[] = [];
		let current = "";
		for (const line of before.split("\n")) {
			if (current) {
				if (line === "}") current = "";
				else functions[current]!.push(line);
				continue;
			}
			const header = /^([a-z_]+)\(\) \{$/.exec(line);
			if (header) functions[(current = header[1]!)] = [];
			else top.push(line);
		}
		const statements = [
			/^$/,
			/^#/,
			/^#!\/bin\/bash$/,
			/^if \[ -z "\$\{BASH_VERSION:-\}" \]; then exec \/bin\/bash "\$0" "\$@"; fi$/,
			/^set -euo pipefail$/,
			/^umask 077$/,
			/^export LC_ALL=C PATH=\/usr\/sbin:\/usr\/bin$/,
			/^cd \/$/,
			/^readonly [A-Z0-9_]+='[^']*'$/,
			/^[a-z_]+="\$\(.*\)" \|\| fail [a-z-]+$/,
			/^\[\[ .* \]\] \|\| fail [a-z-]+$/,
			/^trusted_(file|dirs) \S+ \|\| fail [a-z-]+$/,
		];
		for (const line of top) assert.ok(statements.some((statement) => statement.test(line)), line);
		assert.deepEqual(Object.keys(functions).sort(), ["fail", "root_dir", "tree_digest", "tree_lines", "trusted_dirs", "trusted_file"]);
		const printing = Object.keys(functions).filter((name) => functions[name]!.some((line) => /\b(printf|echo)\b/.test(line)));
		assert.deepEqual(printing.sort(), ["fail", "tree_digest", "tree_lines"]);
		for (const line of functions.fail!.filter((l) => /\bprintf\b/.test(l))) assert.match(line, />&2$/);
		for (const name of ["tree_digest", "tree_lines"]) {
			const calls = [...top, ...Object.values(functions).flat()].filter((line) => new RegExp(`\\b${name}\\b`).test(line));
			assert.ok(calls.length > 0);
			for (const line of calls) assert.match(line, new RegExp(`\\$\\(.*\\b${name}\\b`), line);
		}
		for (const name of ["root_dir", "trusted_dirs", "trusted_file"]) {
			for (const line of functions[name]!.filter((l) => /\b(stat|sha256sum|find|dirname)\b/.test(l))) assert.match(line, /\$\(|< <\(/, line);
		}
		assert.doesNotMatch(seal, /PIM_CUA_EVAL_CONFIG/);
	});

	it("are placed on the VM by cloud-init, as root's, and none is run there", () => {
		const scripts = renderScripts(config());
		const cloud = renderCloudConfig(scripts);
		assert.ok(cloud.startsWith("#cloud-config\n"));
		const parsed = JSON.parse(cloud.slice("#cloud-config\n".length)) as Record<string, unknown>;
		assert.deepEqual(Object.keys(parsed), ["write_files"]);
		assert.deepEqual(
			parsed.write_files,
			Object.entries(scripts).map(([name, content]) => ({ path: `/usr/local/sbin/pim-cua-eval-${name.slice(0, -3)}`, owner: "root:root", permissions: "0700", content })),
		);
	});
});

// ---- The bundle ----

/** A ustar archive, written by hand so a test can make the entries a real packer wouldn't. */
function ustar(entries: { name: string; type?: string; body?: string; prefix?: string; corrupt?: boolean }[]): Buffer {
	const blocks: Buffer[] = [];
	for (const entry of entries) {
		const body = Buffer.from(entry.body ?? "");
		const header = Buffer.alloc(512);
		header.write(entry.name, 0, 100, "latin1");
		header.write("0000644\0", 100, "latin1");
		header.write("0000000\0", 108, "latin1");
		header.write("0000000\0", 116, "latin1");
		header.write(`${body.length.toString(8).padStart(11, "0")}\0`, 124, "latin1");
		header.write("00000000000\0", 136, "latin1");
		header.write(entry.type ?? "0", 156, "latin1");
		header.write("ustar\x0000", 257, "latin1");
		if (entry.prefix) header.write(entry.prefix, 345, 155, "latin1");
		header.fill(0x20, 148, 156);
		const sum = header.reduce((total, byte) => total + byte, 0) + (entry.corrupt ? 1 : 0);
		header.write(`${sum.toString(8).padStart(6, "0")}\0 `, 148, "latin1");
		blocks.push(header, body, Buffer.alloc((512 - (body.length % 512)) % 512));
	}
	blocks.push(Buffer.alloc(1024));
	return zlib.gzipSync(Buffer.concat(blocks));
}

const WS_PACKAGE = JSON.stringify({ name: "ws", version: "8.22.0", main: "index.js" });

describe("the bundle", () => {
	const sources = new Map(BUNDLE_SOURCES.map((source) => [source, Buffer.from(`// ${source}\n`)]));
	const integrity = (tarball: Buffer) => `sha512-${crypto.createHash("sha512").update(tarball).digest("base64")}`;

	it("takes ws only when its tarball is the one the lockfile pins, and only its regular files", () => {
		assert.equal(lockedIntegrity(fs.readFileSync(path.join(REPOSITORY, "pnpm-lock.yaml"), "utf8"), "8.22.0"), "sha512-Ydggc987+RO0AnWtZ/7Wq9FtNvcrL1b/RO0ud9mWjUPgDrsAAwQSF51sm2hm1XofbU/4jkpGEsLFsZZxU+1DOg==");
		const tarball = ustar([{ name: "package/", type: "5" }, { name: "package/package.json", body: WS_PACKAGE }, { name: "index.js", prefix: "package", body: "module.exports = 1;\n" }, { name: "package/lib/sender.js", body: "x" }]);
		const entries = bundleEntries({ commit: COMMIT, sources, wsVersion: "8.22.0", wsIntegrity: integrity(tarball), wsTarball: tarball });
		assert.deepEqual([...entries.keys()].sort(), [...BUNDLE_SOURCES, "BUNDLE", "computer/cua-host/node_modules/ws/index.js", "computer/cua-host/node_modules/ws/lib/sender.js", "computer/cua-host/node_modules/ws/package.json"].sort());
		assert.equal(entries.get("BUNDLE")!.toString(), `pim-cua-eval-bundle v1\ncommit ${COMMIT}\nws 8.22.0 ${integrity(tarball)}\n`);

		refusedWith(() => bundleEntries({ commit: COMMIT, sources, wsVersion: "8.22.0", wsIntegrity: integrity(Buffer.from("other")), wsTarball: tarball }), "ws-integrity");
		refusedWith(() => bundleEntries({ commit: "main", sources, wsVersion: "8.22.0", wsIntegrity: integrity(tarball), wsTarball: tarball }), "commit");
		const missing = new Map(sources);
		missing.delete("computer/cua-host/desktop.ts");
		refusedWith(() => bundleEntries({ commit: COMMIT, sources: missing, wsVersion: "8.22.0", wsIntegrity: integrity(tarball), wsTarball: tarball }), "source");
		const other = ustar([{ name: "package/package.json", body: JSON.stringify({ name: "ws", version: "8.21.0" }) }]);
		refusedWith(() => bundleEntries({ commit: COMMIT, sources, wsVersion: "8.22.0", wsIntegrity: integrity(other), wsTarball: other }), "ws-package");
	});

	it("refuses an archive with links, special entries, escaping or odd names, duplicates or a bad checksum", () => {
		const good = { name: "package/package.json", body: WS_PACKAGE };
		const cases = [
			[good, { name: "package/link.js", type: "2" }],
			[good, { name: "package/hard.js", type: "1" }],
			[good, { name: "package/dev", type: "3" }],
			[good, { name: "package/fifo", type: "6" }],
			[{ name: "PaxHeader", type: "x", body: "30 path=package/package.json\n" }, good],
			[good, { name: "package/../../etc/passwd", body: "x" }],
			[good, { name: "/package/abs.js", body: "x" }],
			[good, { name: "other/index.js", body: "x" }],
			[good, { name: "package/a b.js", body: "x" }],
			[good, good],
			[good, { name: "package/lib/", body: "x" }],
			[good, { name: "package/lib", body: "x" }, { name: "package/lib/x.js", body: "y" }],
			[{ ...good, corrupt: true }],
		];
		for (const entries of cases) refusedWith(() => untarPackage(ustar(entries)), "ws-tarball");
		refusedWith(() => untarPackage(Buffer.from("not gzip")), "ws-tarball");
		// Cut short: no end of archive.
		const whole = zlib.gunzipSync(ustar([good]));
		refusedWith(() => untarPackage(zlib.gzipSync(whole.subarray(0, 1024))), "ws-tarball");
	});

	it("reads what GNU tar writes", () => {
		const dir = path.join(root, "gnu");
		fs.mkdirSync(path.join(dir, "package/lib"), { recursive: true });
		fs.writeFileSync(path.join(dir, "package/package.json"), WS_PACKAGE);
		fs.writeFileSync(path.join(dir, "package/lib/x.js"), "x");
		const file = path.join(root, "gnu.tgz");
		execFileSync("tar", ["--format=ustar", "-czf", file, "-C", dir, "package"]);
		assert.deepEqual([...untarPackage(fs.readFileSync(file)).keys()].sort(), ["lib/x.js", "package.json"]);
		fs.symlinkSync("x.js", path.join(dir, "package/lib/y.js"));
		execFileSync("tar", ["--format=ustar", "-czf", file, "-C", dir, "package"]);
		refusedWith(() => untarPackage(fs.readFileSync(file)), "ws-tarball");
	});

	it("is written new with fixed modes, and its digest is the same in Node and in the scripts' bash", () => {
		const out = path.join(root, "bundle");
		const tarball = ustar([{ name: "package/package.json", body: WS_PACKAGE }, { name: "package/lib/sender.js", body: "y" }]);
		writeTree(out, bundleEntries({ commit: COMMIT, sources, wsVersion: "8.22.0", wsIntegrity: integrity(tarball), wsTarball: tarball }));
		refusedWith(() => writeTree(out, new Map()), "out-exists");
		const modes = new Set<string>();
		const walk = (dir: string) => {
			for (const name of fs.readdirSync(dir)) {
				const full = path.join(dir, name);
				const stat = fs.lstatSync(full);
				modes.add(`${stat.isDirectory() ? "d" : "f"}${(stat.mode & 0o7777).toString(8)}`);
				if (stat.isDirectory()) walk(full);
			}
		};
		walk(out);
		assert.deepEqual([...modes].sort(), ["d755", "f644"]);

		const bash = (dir: string) => spawnSync("bash", ["-c", `set -euo pipefail\n${TREE_DIGEST_BASH}\ntree_digest "$1"`, "digest", dir], { encoding: "utf8", env: { PATH: "/usr/bin:/bin", LC_ALL: "C" } });
		const digest = treeDigest(out);
		assert.match(digest, /^[0-9a-f]{64}$/);
		assert.equal(bash(out).stdout, `${digest}\n`);
		// The digest covers content, modes and names, independently derived here for one file's change of each.
		fs.chmodSync(path.join(out, "BUNDLE"), 0o600);
		const moded = treeDigest(out);
		assert.notEqual(moded, digest);
		assert.equal(bash(out).stdout, `${moded}\n`);
		fs.appendFileSync(path.join(out, "BUNDLE"), "x");
		assert.notEqual(treeDigest(out), moded);
		assert.equal(bash(out).stdout, `${treeDigest(out)}\n`);
		// A link anywhere is refused by both.
		fs.symlinkSync("BUNDLE", path.join(out, "computer/link"));
		refusedWith(() => treeDigest(out), "bundle-type");
		const linked = bash(out);
		assert.notEqual(linked.status, 0);
		assert.equal(linked.stdout, "");
	});
});

describe("the rendered scripts' directory", () => {
	it("is new and private (0700, files 0600), under a parent only this account can write", () => {
		const parent = path.join(root, "operator");
		fs.mkdirSync(parent, { mode: 0o700 });
		const scripts = renderScripts(config());
		const files = new Map(Object.entries({ ...scripts, "cloud-config.yaml": renderCloudConfig(scripts) }).map(([name, content]) => [name, Buffer.from(content)]));
		const out = path.join(parent, "scripts");
		writePrivate(out, files);
		assert.equal(fs.lstatSync(out).mode & 0o7777, 0o700);
		for (const name of files.keys()) {
			assert.equal(fs.lstatSync(path.join(out, name)).mode & 0o7777, 0o600, name);
			assert.deepEqual(fs.readFileSync(path.join(out, name)), files.get(name));
		}
		refusedWith(() => writePrivate(out, files), "out-exists");
		// A parent others can write, or reach through a link, is refused, and nothing is made there.
		const shared = path.join(root, "shared");
		fs.mkdirSync(shared);
		fs.chmodSync(shared, 0o777);
		refusedWith(() => writePrivate(path.join(shared, "scripts"), files), "out-parent");
		assert.equal(fs.existsSync(path.join(shared, "scripts")), false);
		fs.symlinkSync(parent, path.join(root, "operator-link"));
		refusedWith(() => writePrivate(path.join(root, "operator-link", "other"), files), "out-parent");
		assert.equal(fs.existsSync(path.join(parent, "other")), false);
		refusedWith(() => writePrivate("relative/scripts", files), "out");
		// A parent that is root's (here /usr), not the operator's own, is refused before anything is tried there.
		refusedWith(() => writePrivate("/usr/pim-cua-render-test", files), "out-parent");
		// Neither is a group-writable parent the operator owns.
		const group = path.join(root, "group-writable");
		fs.mkdirSync(group);
		fs.chmodSync(group, 0o770);
		refusedWith(() => writePrivate(path.join(group, "scripts"), files), "out-parent");
	});
});

describe("the VM's metadata reads", () => {
	it("take a regular file only, never through a link, a FIFO or a directory, so the planner reads Ubuntu's canonical os-release", () => {
		const fake = path.join(root, "fake-root");
		fs.mkdirSync(path.join(fake, "usr/lib"), { recursive: true });
		fs.mkdirSync(path.join(fake, "etc"));
		fs.writeFileSync(path.join(fake, "usr/lib/os-release"), 'NAME="Ubuntu"\nID=ubuntu\nVERSION_ID="24.04"\n');
		// Ubuntu's layout, relative link and all.
		fs.symlinkSync("../usr/lib/os-release", path.join(fake, "etc/os-release"));
		assert.equal(readText(path.join(fake, "usr/lib/os-release")), 'NAME="Ubuntu"\nID=ubuntu\nVERSION_ID="24.04"\n');
		assert.equal(readText(path.join(fake, "etc/os-release")), null);
		assert.equal(readText(path.join(fake, "usr/lib")), null);
		assert.equal(readText(path.join(fake, "missing")), null);
		execFileSync("mkfifo", [path.join(fake, "fifo")]);
		assert.equal(readText(path.join(fake, "fifo")), null);
		fs.writeFileSync(path.join(fake, "large"), Buffer.alloc(1024 * 1024 + 1, 0x61));
		assert.equal(readText(path.join(fake, "large")), null);
		if (process.geteuid?.() !== 0) {
			fs.writeFileSync(path.join(fake, "unreadable"), "x", { mode: 0o000 });
			assert.equal(readText(path.join(fake, "unreadable")), null);
		}
		// What such a read gives the planner: the file's text from the canonical path; a refusal (`os`) for anything it couldn't read.
		const cfg = config();
		const facts = vm(cfg);
		facts.osRelease = readText(path.join(fake, "usr/lib/os-release"));
		assert.equal(plan(cfg, facts).length, 19);
		facts.osRelease = readText(path.join(fake, "etc/os-release"));
		refusedWith(() => plan(cfg, facts), "os");
	});
});

// ---- The VM's own file operations, over a folder of this run's, as this user ----

describe("the file operations", () => {
	it("create only new files and directories, never through a link, and remove only the staged file they read", () => {
		const dir = path.join(root, "ops");
		fs.mkdirSync(dir);
		const uid = process.geteuid!();
		const gid = process.getegid!();
		const host = systemHost(uid);

		host.writeNew(path.join(dir, "unit"), Buffer.from("text"), 0o644, uid, gid);
		assert.equal(fs.readFileSync(path.join(dir, "unit"), "utf8"), "text");
		assert.equal(fs.lstatSync(path.join(dir, "unit")).mode & 0o7777, 0o644);
		assert.throws(() => host.writeNew(path.join(dir, "unit"), Buffer.from("other"), 0o644, uid, gid), { code: "EEXIST" });
		assert.equal(fs.readFileSync(path.join(dir, "unit"), "utf8"), "text");
		fs.symlinkSync(path.join(dir, "target"), path.join(dir, "dangling"));
		assert.throws(() => host.writeNew(path.join(dir, "dangling"), Buffer.from("secret"), 0o600, uid, gid));
		assert.equal(fs.existsSync(path.join(dir, "target")), false);

		host.mkdirNew(path.join(dir, "made"), 0o700, uid, gid);
		assert.equal(fs.lstatSync(path.join(dir, "made")).mode & 0o7777, 0o700);
		assert.throws(() => host.mkdirNew(path.join(dir, "made"), 0o700, uid, gid), { code: "EEXIST" });
		fs.symlinkSync(path.join(dir, "made"), path.join(dir, "made-link"));
		assert.throws(() => host.chownDir(path.join(dir, "made-link"), 0o700, uid, gid));

		fs.writeFileSync(path.join(dir, "key.pem"), "staged", { mode: 0o600 });
		fs.symlinkSync(path.join(dir, "key.pem"), path.join(dir, "key-link.pem"));
		assert.throws(() => host.readStaged(path.join(dir, "key-link.pem"), 1024));
		const staged = host.readStaged(path.join(dir, "key.pem"), 1024);
		refusedWith(() => host.readStaged(path.join(dir, "key.pem"), 3), "tls-staging");
		// Replaced since it was read: left as it is.
		fs.renameSync(path.join(dir, "key.pem"), path.join(dir, "old.pem"));
		fs.writeFileSync(path.join(dir, "key.pem"), "new", { mode: 0o600 });
		refusedWith(() => host.removeStaged(path.join(dir, "key.pem"), staged), "staged-changed");
		assert.equal(fs.readFileSync(path.join(dir, "key.pem"), "utf8"), "new");
		host.removeStaged(path.join(dir, "old.pem"), staged);
		assert.equal(fs.existsSync(path.join(dir, "old.pem")), false);
	});
});
