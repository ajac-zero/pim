/**
 * The Cua evaluation VM's base (../eval-base/), without a VM: the pinned
 * manifest, the plan and the scripts rendered from it read as text and
 * checked with `bash -n`, the session's unit compared whole, the installer's
 * own planner run over a synthetic VM in the state the base leaves, and the
 * scripts' helpers run in bash over a folder made for this run, with every
 * account, package and service command replaced by a stand-in function. No
 * base script, account, package, service or privileged command runs here,
 * and nothing leaves this machine.
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
import {
	ABSENT,
	actions,
	BASE_HELPERS_BASH,
	BASE_PATHS,
	BASE_TOOLS,
	checks,
	DESKTOP,
	installerFragment,
	preflight,
	renderAll,
	renderCheck,
	renderChromeDefaults,
	renderCloudConfig,
	renderReview,
	renderSessionUnit,
	renderSetup,
	SESSION,
	SESSION_ENVIRONMENT,
	type Step,
	word,
} from "../eval-base/base.ts";
import { CHROME, CUA, IMAGE, NODE, STOCK_CHROME_PROFILE, UBUNTU_PACKAGES } from "../eval-base/manifest.ts";
import { ACCOUNTS, MIN_NODE, nodeVersionAtLeast, parseConfig, renderUnits } from "../eval-install/config.ts";
import { type Facts, inspectedPaths, type PathFact, plan } from "../eval-install/install.ts";

let root = "";

before(() => {
	root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "cua-base-")));
});

after(() => {
	fs.rmSync(root, { recursive: true, force: true });
	assert.equal(fs.existsSync(root), false);
});

function refusedWith(run: () => unknown, reason: string): void {
	assert.throws(run, (error: unknown) => {
		assert.equal((error as { reason?: string }).reason, reason);
		return true;
	});
}

const HEX64 = /^[0-9a-f]{64}$/;
const allCalls = (steps: Step[]) => steps.flatMap((step) => step.calls);

describe("the manifest", () => {
	it("pins Node's official build by archive and binary, at a version the installer takes", () => {
		assert.equal(NODE.version, "v24.22.1");
		assert.ok(nodeVersionAtLeast(NODE.version, MIN_NODE));
		assert.equal(NODE.url, `https://nodejs.org/dist/${NODE.version}/node-${NODE.version}-linux-x64.tar.xz`);
		assert.equal(NODE.member, `node-${NODE.version}-linux-x64/bin/node`);
		assert.equal(path.posix.basename(BASE_PATHS.nodeArchive), path.posix.basename(NODE.url));
		for (const digest of [NODE.archiveSha256, NODE.binarySha256]) assert.match(digest, HEX64);
		assert.ok(Number.isSafeInteger(NODE.archiveSize) && NODE.archiveSize > 0 && Number.isSafeInteger(NODE.binarySize) && NODE.binarySize > 0);
	});

	it("pins Google Chrome's own .deb by version and digest, at the path Ubuntu's stock profile names", () => {
		assert.equal(CHROME.url, `https://dl.google.com/linux/chrome/deb/pool/main/g/${CHROME.package}/${CHROME.package}_${CHROME.version}_amd64.deb`);
		assert.equal(path.posix.basename(BASE_PATHS.chromeDeb), path.posix.basename(CHROME.url));
		for (const digest of [CHROME.debSha256, CHROME.binarySha256, CHROME.sandboxSha256]) assert.match(digest, HEX64);
		assert.equal(CHROME.binary, "/opt/google/chrome/chrome");
		assert.equal(STOCK_CHROME_PROFILE.lines[0], `profile chrome ${CHROME.binary} flags=(unconfined) {`);
	});

	it("asks for each Ubuntu package at one exact version, and for no viewer, remote access, container or admin package", () => {
		const names = UBUNTU_PACKAGES.map((p) => p.name);
		assert.deepEqual(names, ["xvfb", "xinit", "xfce4-session", "xfwm4", "xfce4-panel", "xfdesktop4", "xfce4-settings", "dbus-user-session"]);
		assert.equal(new Set(names).size, names.length);
		for (const p of UBUNTU_PACKAGES) {
			assert.match(p.version, /^[0-9][A-Za-z0-9.+:~-]*$/);
			assert.ok(["noble", "noble-updates", "noble-security"].includes(p.suite));
		}
		const forbidden = /vnc|rdp|ssh|docker|lxd|podman|sudo|polkit|lightdm|gdm|sddm|pulseaudio|pipewire|spice|teamviewer|cua|spacesd/;
		assert.equal(names.filter((name) => forbidden.test(name)).length, 0);
	});

	it("leaves Cua's own programs out, since the accepted data path doesn't use them", () => {
		assert.equal(CUA, null);
		const scripts = Object.values(renderAll()).join("\n");
		assert.doesNotMatch(scripts, /spacesd|cua-driver|computer-server/i);
	});

	it("gives the installer exactly the pins and display it expects, which its own parser takes", () => {
		assert.deepEqual(installerFragment(), {
			node: { path: "/opt/pim-node/bin/node", sha256: NODE.binarySha256, version: "v24.22.1" },
			browser: { path: "/opt/google/chrome/chrome", sha256: CHROME.binarySha256 },
			desktop: { headful: true, display: ":0", xauthority: null },
		});
		const config = parseConfig(JSON.stringify(installerConfig()));
		assert.equal(config.node.path, BASE_PATHS.node);
	});
});

// ---- The installer over the state the base leaves ----

const { publicKey } = crypto.generateKeyPairSync("rsa", { modulusLength: 3072, publicExponent: 0x10001 });

function installerConfig() {
	return {
		version: 1,
		evaluation: "cua-eval-base-test",
		owner: "o_0123456789abcdefghijklmnop",
		commit: "0123456789abcdef0123456789abcdef01234567",
		bundle: { dir: "/opt/pim-cua/bundle", sha256: "b".repeat(64) },
		...installerFragment(),
		workspace: "/srv/pim-workspace",
		tls: { cert: "/var/lib/pim-cua-install/cert.pem", key: "/var/lib/pim-cua-install/key.pem" },
		evalKey: {
			fingerprint: crypto.createHash("sha256").update(publicKey.export({ type: "spki", format: "der" })).digest("hex"),
			publicKeyPem: publicKey.export({ type: "spki", format: "pem" }).toString(),
		},
		bridge: { host: "0.0.0.0", port: 8443, path: "/pim" },
	};
}

/** The /etc/passwd and /etc/group lines the base's account check requires, which is all it leaves of accounts. */
const PASSWD_LINE = `${DESKTOP.name}:x:${DESKTOP.uid}:${DESKTOP.gid}:${DESKTOP.comment}:${DESKTOP.home}:${DESKTOP.shell}`;
const GROUP_LINE = `${DESKTOP.name}:x:${DESKTOP.gid}:`;

/** A VM as the base leaves it, before the installer: what the base made, the operator's staged bundle and TLS files, and Ubuntu's own. */
function baseVm(): Facts & { paths: Record<string, PathFact> } {
	const config = parseConfig(JSON.stringify(installerConfig()));
	const dir = (uid = 0, mode = 0o755): PathFact => ({ kind: "dir", uid, gid: uid, mode });
	const file = (uid = 0, mode = 0o755): PathFact => ({ kind: "file", uid, gid: uid, mode });
	const paths: Record<string, PathFact> = {};
	for (const p of inspectedPaths(config, DESKTOP.home)) paths[p] = null;
	const put = (p: string, fact: PathFact) => {
		let current = "";
		paths["/"] ??= dir();
		for (const part of p.split("/").filter(Boolean).slice(0, -1)) {
			current += `/${part}`;
			paths[current] ??= dir();
		}
		paths[p] = fact;
	};
	put("/run/systemd/system", dir());
	put("/usr/lib/os-release", file(0, 0o644));
	for (const tool of ["/usr/sbin/groupadd", "/usr/sbin/useradd", "/usr/sbin/runuser", "/usr/sbin/nologin", "/usr/bin/systemctl", "/usr/bin/systemd-tmpfiles", "/usr/bin/head"]) put(tool, file());
	// What the base made, with the owners and modes its own checks require.
	put(BASE_PATHS.nodeDir, dir());
	put(BASE_PATHS.nodeBin, dir());
	put(BASE_PATHS.node, file(0, 0o755));
	put("/opt/google/chrome", dir());
	put(CHROME.binary, file(0, 0o755));
	put(DESKTOP.home, dir(DESKTOP.uid, DESKTOP.homeMode));
	// The installer's own inputs, staged by later stages.
	for (const name of ["BUNDLE", "computer/pim-computer.ts", "computer/cua-host/bridge.ts", "computer/cua-host/desktop.ts", "computer/cua-host/eval-credentials.ts", "computer/cua-host/eval-install/install.ts", "computer/cua-host/node_modules/ws/package.json"]) {
		put(`${config.bundle.dir}/${name}`, file(0, 0o644));
	}
	put(path.posix.dirname(config.tls.cert), dir(0, 0o700));
	put(config.tls.cert, file(0, 0o644));
	put(config.tls.key, file(0, 0o600));
	for (const d of ["/etc/systemd/system", "/etc/tmpfiles.d", "/run", "/srv"]) put(d, dir());
	return {
		euid: 0,
		execPath: BASE_PATHS.node,
		nodeVersion: NODE.version,
		osRelease: 'PRETTY_NAME="Ubuntu 24.04.3 LTS"\nNAME="Ubuntu"\nVERSION_ID="24.04"\nVERSION_CODENAME=noble\nID=ubuntu\n',
		passwd: ["root:x:0:0:root:/root:/bin/bash", "azureuser:x:1000:1000:Ubuntu:/home/azureuser:/bin/bash", PASSWD_LINE, ""].join("\n"),
		group: ["root:x:0:", "adm:x:4:syslog,azureuser", "sudo:x:27:azureuser", "azureuser:x:1000:", GROUP_LINE, ""].join("\n"),
		sudoers: ["root ALL=(ALL:ALL) ALL\n%admin ALL=(ALL) ALL\n%sudo ALL=(ALL:ALL) ALL\n@includedir /etc/sudoers.d\n", "azureuser ALL=(ALL) NOPASSWD:ALL\n"],
		paths,
		browserSha256: CHROME.binarySha256,
		bundleMarker: `pim-cua-eval-bundle v1\ncommit ${config.commit}\nws 8.22.0 sha512-x\n`,
		ptraceScope: "1\n",
	};
}

describe("the installer, on the base", () => {
	it("plans its install on a VM in the state the base leaves, with the desktop account the base made", () => {
		const config = parseConfig(JSON.stringify(installerConfig()));
		const steps = plan(config, baseVm()).map((action) => action.step);
		assert.deepEqual(steps.slice(0, 3), ["tls", "session-group", "bridge-account"]);
		assert.ok(steps.includes("enable"));
	});

	it("is refused by the installer if the desktop account had any other group, its home were writable by its group, or the browser or Node weren't root's", () => {
		const config = parseConfig(JSON.stringify(installerConfig()));
		const sudo = baseVm();
		refusedWith(() => plan(config, { ...sudo, group: sudo.group!.replace("sudo:x:27:azureuser", `sudo:x:27:azureuser,${DESKTOP.name}`) }), "desktop-groups");
		const home = baseVm();
		home.paths[DESKTOP.home] = { kind: "dir", uid: DESKTOP.uid, gid: DESKTOP.gid, mode: 0o770 };
		refusedWith(() => plan(config, home), "desktop-home");
		const browser = baseVm();
		browser.paths[CHROME.binary] = { kind: "file", uid: DESKTOP.uid, gid: DESKTOP.gid, mode: 0o755 };
		refusedWith(() => plan(config, browser), "browser");
		const node = baseVm();
		node.paths[BASE_PATHS.nodeBin] = { kind: "dir", uid: DESKTOP.uid, gid: DESKTOP.gid, mode: 0o755 };
		refusedWith(() => plan(config, node), "node-path");
	});

	it("gives the installer's desktop unit exactly the session's display, runtime directory and bus, and no XAUTHORITY", () => {
		const config = parseConfig(JSON.stringify(installerConfig()));
		const environment = renderUnits(config, DESKTOP.uid)
			.desktop.split("\n")
			.filter((line) => /^Environment=(DISPLAY|XAUTHORITY|XDG_RUNTIME_DIR|DBUS_SESSION_BUS_ADDRESS)=/.test(line));
		assert.deepEqual(environment, [
			`Environment=DISPLAY=${SESSION_ENVIRONMENT.DISPLAY}`,
			`Environment=XDG_RUNTIME_DIR=${SESSION_ENVIRONMENT.XDG_RUNTIME_DIR}`,
			`Environment=DBUS_SESSION_BUS_ADDRESS=${SESSION_ENVIRONMENT.DBUS_SESSION_BUS_ADDRESS}`,
		]);
		assert.deepEqual(SESSION_ENVIRONMENT, { DISPLAY: ":0", XDG_RUNTIME_DIR: "/run/user/2000", DBUS_SESSION_BUS_ADDRESS: "unix:path=/run/user/2000/bus" });
	});
});

// ---- The plan ----

describe("the plan", () => {
	it("checks everything first, changing nothing, then takes its steps in this order", () => {
		assert.deepEqual(
			preflight().map((step) => [step.step, step.reason]),
			[
				["root", "root-required"],
				["os", "os"],
				["arch", "arch"],
				["systemd", "systemd"],
				["tools", "tools"],
				["accounts", "preexisting-account"],
				["paths", "preexisting-path"],
				["parents", "unsafe-parent"],
				["browser-sandbox", "browser-sandbox"],
			],
		);
		assert.ok(preflight().every((step) => !step.changes));
		assert.deepEqual(
			actions().map((step) => step.step),
			[
				"staging",
				"node-archive",
				"chrome-deb",
				"node-extract",
				"node",
				"chrome-defaults",
				"apt-update",
				"packages",
				"chrome",
				"record-packages",
				"desktop-group",
				"desktop-account",
				"desktop-check",
				"desktop-dirs",
				"session-unit",
				"session-enable",
				"linger",
			],
		);
	});

	it("refuses an image that isn't Ubuntu 24.04 on x86-64 with systemd, by os-release read as data", () => {
		const os = preflight().find((step) => step.step === "os")!;
		assert.deepEqual(os.calls, [
			["trusted_file", "/usr/lib/os-release"],
			["os_release_is", "/usr/lib/os-release", "ID", "ubuntu"],
			["os_release_is", "/usr/lib/os-release", "VERSION_ID", "24.04"],
			["os_release_is", "/usr/lib/os-release", "VERSION_CODENAME", "noble"],
		]);
		assert.deepEqual(preflight().find((step) => step.step === "arch")!.calls, [["arch_is", "x86_64", "amd64"]]);
		assert.deepEqual(IMAGE, { id: "ubuntu", versionId: "24.04", codename: "noble", machine: "x86_64", dpkgArch: "amd64" });
	});

	it("refuses any account or group by the desktop's name or ID, or the installer's names, through the name service", () => {
		assert.deepEqual(preflight().find((step) => step.step === "accounts")!.calls, [
			["unknown_to", "passwd", "pim-desktop"],
			["unknown_to", "passwd", "2000"],
			["unknown_to", "passwd", "pim-bridge"],
			["unknown_to", "passwd", "pim-session"],
			["unknown_to", "group", "pim-desktop"],
			["unknown_to", "group", "2000"],
			["unknown_to", "group", "pim-bridge"],
			["unknown_to", "group", "pim-session"],
		]);
	});

	it("refuses when anything it makes is already there: every path a step writes is, or is under, a path checked absent", () => {
		const written = allCalls(actions()).flatMap((call): string[] => {
			if (call[0] === "/usr/bin/mkdir") return [call.at(-1)!];
			if (call[0] === "/usr/sbin/runuser") return [call.at(-1)!];
			if (["write_new", "record_packages", "extract_member"].includes(call[0]!)) return [call[1]!];
			if (["fetch", "install_new"].includes(call[0]!)) return [call[2]!];
			if (call[0] === "run_logged") return [call[1]!];
			return [];
		});
		const made = [...written, DESKTOP.home, SESSION.wants, SESSION.linger, CHROME.binary, BASE_PATHS.chromeDefaults];
		for (const p of made) assert.ok(ABSENT.some((absent) => p === absent || p.startsWith(`${absent}/`)), p);
		assert.deepEqual(preflight().find((step) => step.step === "paths")!.calls, ABSENT.map((p) => ["absent", p]));
	});

	it("downloads and checks both pinned artifacts before it installs anything from them", () => {
		const order = actions().map((step) => step.step);
		for (const download of ["node-archive", "chrome-deb"]) {
			for (const install of ["node-extract", "node", "apt-update", "packages"]) assert.ok(order.indexOf(download) < order.indexOf(install));
		}
		const calls = allCalls(actions());
		assert.deepEqual(
			calls.filter((call) => call[0] === "fetch"),
			[
				["fetch", NODE.url, BASE_PATHS.nodeArchive, String(NODE.archiveSize), NODE.archiveSha256],
				["fetch", CHROME.url, BASE_PATHS.chromeDeb, String(CHROME.debSize), CHROME.debSha256],
			],
		);
		assert.deepEqual(
			calls.filter((call) => call[0] === "extract_member"),
			[["extract_member", BASE_PATHS.nodeArchive, BASE_PATHS.nodeExtract, NODE.member, String(NODE.binarySize), NODE.binarySha256]],
		);
		assert.ok(calls.some((call) => call.join(" ") === `install_new ${BASE_PATHS.nodeExtract}/${NODE.member} /opt/pim-node/bin/node 0755 ${NODE.binarySize} ${NODE.binarySha256}`));
		assert.ok(calls.some((call) => call.join(" ") === `file_digest_is ${CHROME.binary} ${CHROME.binarySize} ${CHROME.binarySha256}`));
		assert.ok(calls.some((call) => call.join(" ") === `file_is ${CHROME.sandbox} file 0 0 4755`));
	});

	it("installs the pinned packages and the checked .deb in one apt transaction, then checks every pinned version", () => {
		const install = allCalls(actions()).find((call) => call.includes("install") && call.includes("/usr/bin/apt-get"))!;
		assert.deepEqual(install, [
			"run_logged",
			BASE_PATHS.log,
			"/usr/bin/env",
			"DEBIAN_FRONTEND=noninteractive",
			"/usr/bin/apt-get",
			"-o",
			"DPkg::Lock::Timeout=600",
			"-o",
			"Dpkg::Options::=--force-confold",
			"--yes",
			"--no-install-recommends",
			"install",
			"xvfb=2:21.1.12-1ubuntu1.9",
			"xinit=1.4.1-0ubuntu5",
			"xfce4-session=4.18.3-1build2",
			"xfwm4=4.18.0-1build3",
			"xfce4-panel=4.18.4-1ubuntu0.1",
			"xfdesktop4=4.18.1-1build3",
			"xfce4-settings=4.18.4-0ubuntu3",
			"dbus-user-session=1.14.10-4ubuntu4.1",
			BASE_PATHS.chromeDeb,
		]);
		assert.ok(allCalls(actions()).some((call) => call[0] === "packages_are" && call.at(-1) === "google-chrome-stable=156.0.8078.47-1"));
		// Apt's own sources and their keys are left as the image has them; only Chrome's package is kept from adding one.
		assert.doesNotMatch(renderSetup(), /trusted\.gpg|signed-by|apt-key|add-apt-repository|keyrings/i);
		assert.deepEqual(new Set(renderSetup().match(/\/etc\/apt\/[^' ]*/g)), new Set(["/etc/apt/sources.list.d", "/etc/apt/sources.list.d/google-chrome.sources", "/etc/apt/sources.list.d/google-chrome.list"]));
	});

	it("makes exactly pim-desktop: its own group by ID, a locked password, a 0750 home, no other group and no subordinate IDs", () => {
		const calls = allCalls(actions());
		assert.deepEqual(
			calls.filter((call) => call[0] === "/usr/sbin/groupadd"),
			[["/usr/sbin/groupadd", "--gid", "2000", "pim-desktop"]],
		);
		assert.deepEqual(
			calls.filter((call) => call[0] === "/usr/sbin/useradd"),
			[
				[
					"/usr/sbin/useradd",
					"--uid",
					"2000",
					"--gid",
					"2000",
					"--comment",
					"Pim desktop",
					"--home-dir",
					"/home/pim-desktop",
					"--create-home",
					"--shell",
					"/bin/bash",
					"--key",
					"HOME_MODE=0750",
					"--key",
					"SUB_UID_COUNT=0",
					"--key",
					"SUB_GID_COUNT=0",
					"pim-desktop",
				],
			],
		);
		assert.ok(calls.some((call) => call.join(" ") === "account_is pim-desktop 2000 2000 /home/pim-desktop /bin/bash Pim desktop"));
		assert.ok(calls.some((call) => call.join(" ") === "file_is /home/pim-desktop dir 2000 2000 750"));
		// The account is made once, and given nothing else: no group, password, key or login of any kind.
		const words = calls.flat();
		for (const forbidden of ["--groups", "-G", "--append", "-a", "--password", "-p", "usermod", "gpasswd", "adduser", "chpasswd", "sudo", "adm", "audio", "video", "docker", "lxd", "authorized_keys", ".ssh"]) {
			assert.ok(!words.includes(forbidden), forbidden);
		}
	});

	it("makes the desktop's profile and program directories as the account itself, private to it", () => {
		const dirs = allCalls(actions()).filter((call) => call[0] === "/usr/sbin/runuser");
		assert.deepEqual(
			dirs,
			[".pim-computer", ".local", ".local/bin"].map((dir) => ["/usr/sbin/runuser", "-u", "pim-desktop", "--", "/usr/bin/mkdir", "-m", "0700", "--", `/home/pim-desktop/${dir}`]),
		);
	});

	it("starts the session only through the account's lingering user manager, after its unit is in place and enabled", () => {
		const order = actions().map((step) => step.step);
		assert.ok(order.indexOf("desktop-check") < order.indexOf("session-unit"));
		assert.ok(order.indexOf("session-unit") < order.indexOf("session-enable"));
		assert.equal(order.at(-1), "linger");
		const calls = allCalls(actions());
		assert.ok(calls.some((call) => call.join(" ") === `run_logged ${BASE_PATHS.log} /usr/bin/systemctl --global enable pim-desktop-session.service`));
		assert.deepEqual(
			calls.filter((call) => call[0] === "/usr/bin/loginctl"),
			[["/usr/bin/loginctl", "enable-linger", "pim-desktop"]],
		);
		// Nothing is started or restarted by name, and no system unit is written.
		assert.ok(!calls.some((call) => call.includes("start") || call.includes("restart") || call.includes("daemon-reload") || call.some((w) => w.startsWith("/etc/systemd/system"))));
	});

	it("deletes, moves, recursively changes or follows nothing: only new files and directories, each by one call with fixed words", () => {
		const words = [...allCalls(actions()), ...allCalls(checks())].flat();
		for (const forbidden of ["rm", "/usr/bin/rm", "rmdir", "unlink", "mv", "chown", "/usr/bin/chown", "-R", "--recursive", "-p", "--parents", "-f", "--force", "ln", "cp"]) {
			assert.ok(!words.includes(forbidden), forbidden);
		}
		const helpers = new Set([...BASE_HELPERS_BASH.matchAll(/^([a-z_]+)\(\) \{$/gm)].map((m) => m[1]));
		for (const call of [...allCalls(preflight()), ...allCalls(actions()), ...allCalls(checks())]) {
			assert.ok(helpers.has(call[0]!) || (BASE_TOOLS as readonly string[]).includes(call[0]!), call[0]);
		}
		// Every program a step names by path is one the checks find root's first.
		const checked = new Set(allCalls(preflight()).filter((call) => call[0] === "trusted_file").map((call) => call[1]));
		for (const word of allCalls(actions()).flat().filter((w) => /^\/usr\/s?bin\//.test(w))) assert.ok(checked.has(word), word);
	});

	it("verifies, read-only, the account, files, pins, session, runtime directory, bus and display after setup", () => {
		assert.deepEqual(
			checks().map((step) => step.step),
			["account", "home", "node", "chrome", "browser-sandbox", "apt-sources", "packages", "session-unit", "user-manager", "session", "runtime-dir", "display"],
		);
		const readOnly = new Set(["account_is", "file_is", "trusted_file", "file_digest_is", "text_digest_is", "lines_in", "absent", "packages_are", "link_is", "present_file", "unit_running", "socket_of"]);
		for (const call of allCalls(checks())) assert.ok(readOnly.has(call[0]!), call[0]);
		assert.deepEqual(checks().find((step) => step.step === "runtime-dir")!.calls, [
			["file_is", "/run/user/2000", "dir", "2000", "2000", "700"],
			["socket_of", "/run/user/2000/bus", "2000"],
		]);
		assert.deepEqual(checks().find((step) => step.step === "display")!.calls, [
			["file_is", "/tmp/.X11-unix", "dir", "0", "0", "1777"],
			["socket_of", "/tmp/.X11-unix/X0", "2000"],
		]);
		assert.deepEqual(checks().find((step) => step.step === "session")!.calls, [["unit_running", "pim-desktop@.host", "pim-desktop-session.service"]]);
	});
});

// ---- The session ----

const SESSION_UNIT = `# Pim Cua evaluation base (docs/cua-eval-base.md): the desktop account's one X11 display and Xfce session.
# It runs in that account's own systemd user manager, which lingering starts at boot, and in no other account's.
[Unit]
Description=Pim Cua evaluation desktop session (Xvfb :0 and Xfce)
ConditionUser=pim-desktop
Requires=dbus.socket
After=dbus.socket

[Service]
Type=simple
Environment=DBUS_SESSION_BUS_ADDRESS=unix:path=%t/bus
Environment=XDG_SESSION_TYPE=x11
Environment=XDG_CURRENT_DESKTOP=XFCE
ExecStart=/usr/bin/xinit /usr/bin/xfce4-session -- /usr/bin/Xvfb :0 -screen 0 1280x800x24 -nolisten tcp
Restart=no

[Install]
WantedBy=default.target
`;

describe("the session", () => {
	it("is one user unit, compared whole, for the desktop account only", () => {
		assert.equal(renderSessionUnit(), SESSION_UNIT);
		assert.equal(SESSION.unitPath, "/etc/systemd/user/pim-desktop-session.service");
	});

	it("has only ordinary startup directives: no resource, confinement, sandboxing, cgroup, delegation, capability, kill or user directive", () => {
		const keys = renderSessionUnit()
			.split("\n")
			.filter((line) => /^[A-Za-z]+=/.test(line))
			.map((line) => line.slice(0, line.indexOf("=")));
		assert.deepEqual([...new Set(keys)].sort(), ["After", "ConditionUser", "Description", "Environment", "ExecStart", "Requires", "Restart", "Type", "WantedBy"]);
		assert.doesNotMatch(
			renderSessionUnit(),
			/Delegate|Slice|CPU|Memory|Tasks|\bIO[A-Z]|Device|Private|Protect|Restrict|Capabilit|NoNewPrivileges|SystemCall|Kill|SIGKILL|PAMName|TTY|ExecStop|ExecStartPre|ExecStartPost|Nice|OOM|Limit/,
		);
	});

	it("starts one X server with no TCP listener, no disabled access control and no viewer, and Xfce on it", () => {
		const exec = renderSessionUnit()
			.split("\n")
			.find((line) => line.startsWith("ExecStart="))!;
		assert.deepEqual(exec.slice("ExecStart=".length).split(" "), ["/usr/bin/xinit", "/usr/bin/xfce4-session", "--", "/usr/bin/Xvfb", ":0", "-screen", "0", "1280x800x24", "-nolisten", "tcp"]);
		assert.doesNotMatch(renderSessionUnit(), / -ac\b|-listen|vnc|rdp|xhost|-auth\b/);
	});

	it("adds no apt source of Chrome's through its own documented setting", () => {
		assert.equal(renderChromeDefaults(), `# Pim Cua evaluation base (docs/cua-eval-base.md): Google Chrome's package adds no apt source of its own.\nrepo_add_once="false"\nrepo_reenable_on_distupgrade="false"\n`);
	});
});

// ---- The rendered scripts ----

/** The statements after the helpers: what each script runs, in order. */
function mainOf(script: string): string[] {
	const start = script.indexOf(BASE_HELPERS_BASH);
	assert.ok(start > 0);
	return script.slice(start + BASE_HELPERS_BASH.length).split("\n");
}

describe("the scripts", () => {
	it("are bash that parses, with a fixed environment, refusing to run but as root before anything else", () => {
		const out = path.join(root, "syntax");
		fs.mkdirSync(out);
		for (const [name, script] of Object.entries({ setup: renderSetup(), check: renderCheck(), review: renderReview() })) {
			const file = path.join(out, `${name}.sh`);
			fs.writeFileSync(file, script);
			execFileSync("bash", ["-n", file]);
			assert.ok(script.startsWith("#!/bin/bash\n"));
			assert.match(script, /\nset -euo pipefail\numask 022\nexport LC_ALL=C PATH=\/usr\/sbin:\/usr\/bin\ncd \/\n/);
			assert.match(script, /It holds no secret, makes none, and prints none\./);
		}
		const setup = mainOf(renderSetup()).filter((line) => line && !line.startsWith("#"));
		const firstStatement = setup.findIndex((line) => line.startsWith("STEP="));
		assert.deepEqual(setup.slice(firstStatement, firstStatement + 2), ["STEP=root", "is_root || fail root-required"]);
	});

	it("runs exactly the plan in setup: each statement a rendered call that stops at its first failure, and nothing changes before every check passed", () => {
		const main = mainOf(renderSetup()).filter((line) => line !== "" && !line.startsWith("# "));
		const expected: string[] = [];
		const content = main.slice(0, main.indexOf("STEP=root"));
		for (const step of preflight()) {
			expected.push(`STEP=${step.step}`);
			for (const call of step.calls) expected.push(`${call[0]} ${call.slice(1).map(word).join(" ")}`.trimEnd() + ` || fail ${step.reason}`);
		}
		expected.push("CHANGED=true");
		for (const step of actions()) {
			expected.push(`STEP=${step.step}`);
			for (const call of step.calls) expected.push(`${call[0]} ${call.slice(1).map(word).join(" ")}`.trimEnd() + ` || fail ${step.reason}`);
		}
		expected.push(`printf '{"event":"pim-cua-base.set-up","account":"%s","display":"%s"}\\n' 'pim-desktop' ':0'`);
		assert.deepEqual(main.slice(content.length), expected);
		// Before the checks, only the two contents are read into variables.
		assert.deepEqual(
			content.filter((line) => line.startsWith("IFS=")),
			["IFS= read -r -d '' SESSION_UNIT <<'PIM_CUA_BASE_SESSION_UNIT' || true", "IFS= read -r -d '' CHROME_DEFAULTS <<'PIM_CUA_BASE_CHROME_DEFAULTS' || true"],
		);
	});

	it("reads each content from a quoted here-document back to exactly the text rendered", () => {
		const script = renderSetup();
		const definitions = script.slice(script.indexOf("IFS= read -r -d '' SESSION_UNIT"), script.indexOf("# Checks:"));
		for (const [name, text] of [
			["SESSION_UNIT", renderSessionUnit()],
			["CHROME_DEFAULTS", renderChromeDefaults()],
		] as const) {
			const printed = execFileSync("bash", ["-c", `set -euo pipefail\n${definitions}\nprintf '%s' "$${name}"`], { env: { PATH: "/usr/bin:/bin" } }).toString("utf8");
			assert.equal(printed, text);
		}
	});

	it("holds no secret, generates none, and has no tracing, evaluation, sourcing, signal, process listing, privilege, confinement or cloud command", () => {
		const scripts = [renderSetup(), renderCheck(), renderReview()].join("\n");
		assert.doesNotMatch(scripts, /BEGIN [A-Z ]*PRIVATE KEY|BEGIN CERTIFICATE|token|secret=|password=|Authorization|Bearer/i);
		assert.doesNotMatch(scripts, /\/dev\/u?random|\$RANDOM|mcookie|openssl|uuidgen|xauth|pwgen|mkpasswd|chpasswd/);
		assert.doesNotMatch(scripts, /(^|[;&|]\s*)(eval|source|\.)\s|set -x|xtrace/m);
		assert.doesNotMatch(scripts, /\bkill\b|pkill|pgrep|killall|\bps\b|\/proc\/[0-9]|setsid|nohup/);
		assert.doesNotMatch(scripts, /\bsu\b|setcap|capsh|setpriv|nsenter|unshare|chroot|apparmor_parser|aa-|sysctl|cgroup|Delegate|systemd-run/);
		// Only review names sudo, as a package and a group whose metadata it prints.
		assert.doesNotMatch([renderSetup(), renderCheck()].join("\n"), /\bsudo\b/);
		assert.doesNotMatch(scripts, /--no-sandbox|disable-setuid|userns_clone|restrict_unprivileged/);
		assert.doesNotMatch(scripts, /\baz\b|azure|169\.254|\bssh\b|scp|authorized_keys|certbot|acme|ufw|iptables|nft\b/i);
		assert.doesNotMatch(scripts, /\brm\b|rmdir|\bmv\b|chown|chgrp|-R\b|--recursive/);
		// Every word is single-quoted from a checked set, or a content variable; nothing is interpolated into code.
		for (const bad of ["it's", "$(x)", "`x`", "a;b", "a\nb", "a|b", "a&b", "a>b", "$X y"]) refusedWith(() => word(bad), "render-value");
	});

	it("only reads in check: its statements are the plan's checks, each printing a fixed result", () => {
		const main = mainOf(renderCheck()).filter(Boolean);
		const ifs = main.filter((line) => line.startsWith("if "));
		assert.deepEqual(
			ifs.map((line) => /then result ([a-z-]+) true/.exec(line)?.[1]),
			checks().map((step) => step.step),
		);
		assert.deepEqual(main.slice(0, 4), ["OK=true", "result() {", `\tprintf '{"event":"pim-cua-base.check","check":"%s","ok":%s}\\n' "$1" "$2"`, "}"]);
		assert.deepEqual(main.slice(-2), [`printf '{"event":"pim-cua-base.checked","ok":%s}\\n' "$OK"`, '[[ "$OK" == true ]]']);
		assert.doesNotMatch(main.join("\n"), /fetch|write_new|install_new|extract_member|run_logged|record_packages|mkdir|useradd|groupadd|apt-get|loginctl|enable|>>?\s*["/$]/);
	});

	it("only reads in review, printing metadata and decision-free lines, never a sudoers or polkit file's contents", () => {
		const main = mainOf(renderReview()).join("\n");
		assert.doesNotMatch(main, /fetch|write_new|install_new|run_logged|mkdir|useradd|groupadd|apt-get|loginctl|systemctl|>>?\s*(?!\/dev\/null)["/$]/);
		assert.match(main, /for file in \/etc\/sudoers \/etc\/sudoers\.d\/\* \/etc\/polkit-1\/rules\.d\/\* \/usr\/share\/polkit-1\/rules\.d\/\* \/etc\/nsswitch\.conf; do/);
		assert.match(main, /dpkg --verify sudo polkitd libc-bin/);
		// Only sha256sum reads a listed file's bytes, and only nsswitch.conf's account lines are printed.
		assert.doesNotMatch(main, /\bcat\b|\bhead\b|\btail\b|\bless\b|\bgrep\b|<"\$file"/);
	});

	it("are placed, not run, by the cloud-init data: exactly the three scripts, root's, 0700, within Azure's custom data limit", () => {
		const files = renderAll();
		assert.deepEqual(Object.keys(files), ["setup.sh", "check.sh", "review.sh", "cloud-config.yaml", "installer-fragment.json"]);
		const text = files["cloud-config.yaml"]!;
		assert.ok(text.startsWith("#cloud-config\n"));
		const data = JSON.parse(text.slice("#cloud-config\n".length)) as { write_files: { path: string; owner: string; permissions: string; content: string }[] };
		assert.deepEqual(Object.keys(data), ["write_files"]);
		assert.deepEqual(
			data.write_files.map((f) => [f.path, f.owner, f.permissions]),
			["setup", "check", "review"].map((name) => [`/usr/local/sbin/pim-cua-base-${name}`, "root:root", "0700"]),
		);
		assert.deepEqual(
			data.write_files.map((f) => f.content),
			[files["setup.sh"], files["check.sh"], files["review.sh"]],
		);
		assert.ok(Buffer.from(text).toString("base64").length < 64 * 1024);
		assert.equal(renderCloudConfig({}), '#cloud-config\n{\n  "write_files": []\n}\n');
	});
});

// ---- The helpers, in bash, with stand-ins ----

/**
 * Runs `script` after the helpers, with `standIns` defining functions in
 * place of the programs a helper would call: bash runs a function before a
 * program of the same name, so no stand-in's program runs.
 */
function helper(script: string, standIns = ""): { status: number | null; stdout: string; stderr: string } {
	const result = spawnSync("bash", ["-c", `set -euo pipefail\n${BASE_HELPERS_BASH}\n${standIns}\n${script}`], { env: { PATH: "/usr/bin:/bin", LC_ALL: "C" }, encoding: "utf8", cwd: root });
	return { status: result.status, stdout: result.stdout, stderr: result.stderr };
}
const passes = (script: string, standIns = "") => helper(script, standIns).status === 0;
const sh = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;

function dir(name: string): string {
	const made = path.join(root, name);
	fs.mkdirSync(made);
	return made;
}

describe("the helpers", () => {
	it("read os-release as data: exact values, quoted or not, once; nothing in it runs", () => {
		const at = dir("os-release");
		const file = (name: string, text: string) => {
			fs.writeFileSync(path.join(at, name), text);
			return sh(path.join(at, name));
		};
		const ubuntu = file("ubuntu", 'PRETTY_NAME="Ubuntu 24.04.3 LTS"\nID=ubuntu\nVERSION_ID="24.04"\nVERSION_CODENAME=noble\nUBUNTU_CODENAME=noble');
		assert.ok(passes(`os_release_is ${ubuntu} ID ubuntu && os_release_is ${ubuntu} VERSION_ID 24.04 && os_release_is ${ubuntu} VERSION_CODENAME noble`));
		assert.ok(!passes(`os_release_is ${ubuntu} VERSION_ID 24.04.3`));
		assert.ok(!passes(`os_release_is ${ubuntu} VERSION_ID '"24.04"'`));
		assert.ok(!passes(`os_release_is ${file("debian", "ID=debian\nID_LIKE=ubuntu\n")} ID ubuntu`));
		assert.ok(!passes(`os_release_is ${file("twice", "ID=debian\nID=ubuntu\n")} ID ubuntu`));
		assert.ok(!passes(`os_release_is ${file("missing", "NAME=Ubuntu\n")} ID ubuntu`));
		assert.ok(!passes(`os_release_is ${file("prefix", "ID_LIKE=ubuntu\n")} ID ubuntu`));
		const marker = path.join(at, "ran");
		const hostile = file("hostile", `ID="$(touch ${marker})"\nVERSION_ID=\`touch ${marker}\`\nVERSION_CODENAME=noble;touch ${marker}\n`);
		assert.ok(!passes(`os_release_is ${hostile} ID ubuntu || os_release_is ${hostile} VERSION_ID 24.04 || os_release_is ${hostile} VERSION_CODENAME noble`));
		assert.ok(passes(`os_release_is ${hostile} VERSION_CODENAME ${sh(`noble;touch ${marker}`)}`));
		assert.equal(fs.existsSync(marker), false);
		fs.symlinkSync(path.join(at, "ubuntu"), path.join(at, "link"));
		assert.ok(!passes(`os_release_is ${sh(path.join(at, "link"))} ID ubuntu`));
	});

	it("refuse anything already at a path, a dangling link included, and a file or link where a directory, socket or link is expected", () => {
		const at = dir("absent");
		fs.writeFileSync(path.join(at, "file"), "x");
		fs.symlinkSync(path.join(at, "nowhere"), path.join(at, "dangling"));
		fs.mkdirSync(path.join(at, "dir"), { mode: 0o750 });
		fs.chmodSync(path.join(at, "dir"), 0o750);
		const uid = process.getuid!();
		const gid = process.getgid!();
		assert.ok(passes(`absent ${sh(path.join(at, "nothing"))}`));
		assert.ok(!passes(`absent ${sh(path.join(at, "file"))}`));
		assert.ok(!passes(`absent ${sh(path.join(at, "dangling"))}`));
		assert.ok(passes(`file_is ${sh(path.join(at, "dir"))} dir ${uid} ${gid} 750`));
		assert.ok(!passes(`file_is ${sh(path.join(at, "dir"))} dir ${uid} ${gid} 755`));
		assert.ok(!passes(`file_is ${sh(path.join(at, "dir"))} dir 0 0 750`));
		assert.ok(!passes(`file_is ${sh(path.join(at, "file"))} dir ${uid} ${gid} 644`));
		assert.ok(!passes(`file_is ${sh(path.join(at, "dangling"))} file ${uid} ${gid} 777`));
		assert.ok(passes(`link_is ${sh(path.join(at, "dangling"))} ${sh(path.join(at, "nowhere"))}`));
		assert.ok(!passes(`link_is ${sh(path.join(at, "file"))} ${sh(path.join(at, "file"))}`));
		assert.ok(!passes(`socket_of ${sh(path.join(at, "file"))} ${uid}`));
		// This user's own files are never "root's": the trust checks refuse them, as the setup would on a VM.
		assert.ok(!passes(`trusted_file ${sh(path.join(at, "file"))}`));
		assert.ok(!passes(`trusted_dirs ${sh(path.join(at, "dir"))}`));
	});

	it("ask the name service, and pass only when it says not found", () => {
		const calls = path.join(dir("getent"), "calls");
		const getent = (status: number) => `getent() { printf '%s %s\\n' "$1" "$2" >>${sh(calls)}; return ${status}; }`;
		assert.ok(passes("unknown_to passwd pim-desktop", getent(2)));
		assert.ok(!passes("unknown_to passwd pim-desktop", getent(0)));
		assert.ok(!passes("unknown_to group 2000", getent(1)));
		assert.ok(!passes("unknown_to group 2000", getent(3)));
		assert.equal(fs.readFileSync(calls, "utf8"), "passwd pim-desktop\npasswd pim-desktop\ngroup 2000\ngroup 2000\n");
	});

	it("download over HTTPS only to a new path, and keep nothing unchecked: the size and digest must be the pin's", () => {
		const at = dir("fetch");
		const body = "pinned artifact\n";
		const digest = crypto.createHash("sha256").update(body).digest("hex");
		const curl = `curl() { printf '%s\\n' "$*" >>${sh(path.join(at, "calls"))}; local out=""; while (( $# )); do if [[ "$1" == --output ]]; then out="$2"; shift; fi; shift; done; printf '%s' "$BODY" >"$out"; }`;
		const run = (out: string, size: number, sha: string, text = body) => helper(`BODY=${sh(text)}\nfetch https://example.invalid/a.tar.xz ${sh(path.join(at, out))} ${size} ${sha}`, curl).status === 0;
		assert.ok(run("good", body.length, digest));
		assert.equal(fs.readFileSync(path.join(at, "good"), "utf8"), body);
		assert.ok(!run("digest", body.length, "0".repeat(64)));
		assert.ok(!run("size", body.length + 1, digest));
		assert.ok(!run("tampered", body.length, digest, "pinned artifacT\n"));
		const calls = fs.readFileSync(path.join(at, "calls"), "utf8").trim().split("\n");
		assert.equal(calls.length, 4);
		assert.equal(calls[0], `--proto =https --proto-redir =https --tlsv1.2 --fail --silent --show-error --location --max-redirs 3 --retry 3 --max-filesize ${body.length} --output ${path.join(at, "good")} -- https://example.invalid/a.tar.xz`);
		// Something already at the path: refused before anything is downloaded.
		assert.ok(!run("good", body.length, digest));
		assert.equal(fs.readFileSync(path.join(at, "calls"), "utf8").trim().split("\n").length, 4);
	});

	it("take only the one named member of an archive, as a regular file with the pinned digest; a link, hard link or missing member refuses", () => {
		const at = dir("archive");
		const tree = path.join(at, "tree");
		fs.mkdirSync(path.join(tree, "node-v1/bin"), { recursive: true });
		const binary = "#!/not/run\nnode binary stand-in\n";
		fs.writeFileSync(path.join(tree, "node-v1/bin/node"), binary, { mode: 0o755 });
		fs.writeFileSync(path.join(tree, "node-v1/README.md"), "readme");
		fs.symlinkSync("/etc/passwd", path.join(tree, "node-v1/bin/npm"));
		const digest = crypto.createHash("sha256").update(binary).digest("hex");
		const archive = (name: string, members: string[], extra: string[] = []) => {
			const file = path.join(at, `${name}.tar.xz`);
			execFileSync("tar", ["--create", "--xz", "--file", file, "--directory", tree, ...extra, ...members]);
			return sh(file);
		};
		const good = archive("good", ["node-v1"]);
		const out = path.join(at, "out");
		assert.ok(passes(`extract_member ${good} ${sh(out)} node-v1/bin/node ${binary.length} ${digest}`, ""));
		const listing = execFileSync("find", [out, "-mindepth", "1", "-printf", "%P %y\n"]).toString("utf8").trim().split("\n").sort();
		assert.deepEqual(listing, ["node-v1 d", "node-v1/bin d", "node-v1/bin/node f"]);
		assert.equal(fs.statSync(out).mode & 0o777, 0o700);
		// The directory must be new.
		assert.ok(!passes(`extract_member ${good} ${sh(out)} node-v1/bin/node ${binary.length} ${digest}`));
		assert.ok(!passes(`extract_member ${good} ${sh(path.join(at, "wrong"))} node-v1/bin/node ${binary.length} ${"0".repeat(64)}`));
		assert.ok(!passes(`extract_member ${good} ${sh(path.join(at, "missing"))} node-v1/bin/nodejs ${binary.length} ${digest}`));
		// A member that is a link is extracted as a link, never followed, and refused.
		assert.ok(!passes(`extract_member ${good} ${sh(path.join(at, "link"))} node-v1/bin/npm 0 ${digest}`));
		assert.equal(fs.lstatSync(path.join(at, "link/node-v1/bin/npm")).isSymbolicLink(), true);
		// A hard link to a member not taken can't be made, and refuses.
		fs.linkSync(path.join(tree, "node-v1/bin/node"), path.join(tree, "node-v1/hard"));
		const hard = archive("hard", ["node-v1/bin/node", "node-v1/hard"]);
		assert.ok(!passes(`extract_member ${hard} ${sh(path.join(at, "hard"))} node-v1/hard ${binary.length} ${digest}`));
	});

	it("install a copy only where nothing is, and check the copy's digest and mode", () => {
		const at = dir("install");
		const body = "binary\n";
		const digest = crypto.createHash("sha256").update(body).digest("hex");
		fs.writeFileSync(path.join(at, "from"), body, { mode: 0o600 });
		assert.ok(passes(`install_new ${sh(path.join(at, "from"))} ${sh(path.join(at, "to"))} 0755 ${body.length} ${digest}`));
		assert.equal(fs.statSync(path.join(at, "to")).mode & 0o7777, 0o755);
		assert.ok(!passes(`install_new ${sh(path.join(at, "from"))} ${sh(path.join(at, "to"))} 0755 ${body.length} ${digest}`));
		assert.ok(!passes(`install_new ${sh(path.join(at, "from"))} ${sh(path.join(at, "other"))} 0755 ${body.length} ${"1".repeat(64)}`));
	});

	it("write a new file with exactly its content and mode, never over or through anything", () => {
		const at = dir("write");
		const unit = renderSessionUnit();
		assert.ok(passes(`write_new ${sh(path.join(at, "unit"))} 0644 ${sh(unit)}`));
		assert.equal(fs.readFileSync(path.join(at, "unit"), "utf8"), unit);
		assert.equal(fs.statSync(path.join(at, "unit")).mode & 0o7777, 0o644);
		assert.ok(passes(`text_digest_is ${sh(path.join(at, "unit"))} ${crypto.createHash("sha256").update(unit).digest("hex")}`));
		assert.ok(!passes(`write_new ${sh(path.join(at, "unit"))} 0644 changed`));
		assert.equal(fs.readFileSync(path.join(at, "unit"), "utf8"), unit);
		fs.symlinkSync(path.join(at, "target"), path.join(at, "dangling"));
		assert.ok(!passes(`write_new ${sh(path.join(at, "dangling"))} 0644 x`));
		assert.equal(fs.existsSync(path.join(at, "target")), false);
	});

	it("record packages into a new file, and check each pinned version exactly, through stand-ins for dpkg-query", () => {
		const at = dir("packages");
		const dpkgQuery = `dpkg-query() { if [[ "$1" == --show && "$2" == --showformat=\\$'{Version}' ]]; then case "$4" in xvfb) printf '2:21.1.12-1ubuntu1.9' ;; xinit) printf '1.4.1-0ubuntu5' ;; *) return 1 ;; esac; else printf 'xvfb\\t2:21.1.12-1ubuntu1.9\\tamd64\\tii \\n'; fi; }`;
		assert.ok(passes("packages_are xvfb=2:21.1.12-1ubuntu1.9 xinit=1.4.1-0ubuntu5", dpkgQuery));
		assert.ok(!passes("packages_are xvfb=2:21.1.12-1ubuntu1.10", dpkgQuery));
		assert.ok(!passes("packages_are xvfb=2:21.1.12-1ubuntu1.9 absent=1", dpkgQuery));
		assert.ok(passes(`record_packages ${sh(path.join(at, "packages.tsv"))}`, dpkgQuery));
		assert.equal(fs.readFileSync(path.join(at, "packages.tsv"), "utf8"), "xvfb\t2:21.1.12-1ubuntu1.9\tamd64\tii \n");
		assert.equal(fs.statSync(path.join(at, "packages.tsv")).mode & 0o777, 0o600);
		assert.ok(!passes(`record_packages ${sh(path.join(at, "packages.tsv"))}`, dpkgQuery));
	});

	it("accept the desktop account only exactly as made: its own group alone, locked, with no subordinate IDs", () => {
		const at = dir("account");
		const line = "pim-desktop:x:2000:2000:Pim desktop:/home/pim-desktop:/bin/bash";
		const standIns = (over: Partial<Record<"passwd" | "group" | "groups" | "status", string>> = {}) => `
getent() {
	case "$1 $2" in
		"passwd pim-desktop"|"passwd 2000") printf '%s\\n' ${sh(over.passwd ?? line)} ;;
		"group pim-desktop"|"group 2000") printf '%s\\n' ${sh(over.group ?? "pim-desktop:x:2000:")} ;;
		*) return 2 ;;
	esac
}
id() { [[ "$1" == -G && "$2" == pim-desktop ]] && printf '%s\\n' ${sh(over.groups ?? "2000")}; }
passwd() { [[ "$1" == --status && "$2" == pim-desktop ]] && printf '%s\\n' ${sh(over.status ?? "pim-desktop L 10/26/2026 0 99999 7 -1")}; }
no_subids() { [[ "$1 $2 $3 $4" == "pim-desktop 2000 /etc/subuid /etc/subgid" ]]; }`;
		const check = "account_is pim-desktop 2000 2000 /home/pim-desktop /bin/bash 'Pim desktop'";
		assert.ok(passes(check, standIns()));
		assert.ok(!passes(check, standIns({ groups: "2000 27" })));
		assert.ok(!passes(check, standIns({ group: "pim-desktop:x:2000:someone" })));
		assert.ok(!passes(check, standIns({ status: "pim-desktop P 10/26/2026 0 99999 7 -1" })));
		assert.ok(!passes(check, standIns({ passwd: "pim-desktop:x:2000:2000:Pim desktop:/home/pim-desktop:/bin/sh" })));
		assert.ok(!passes(check, standIns({ passwd: "pim-desktop:x:2000:27:Pim desktop:/home/pim-desktop:/bin/bash" })));
		// The subordinate ID files, as data: a line for the account, by name or UID, refuses; so does a link in a file's place.
		fs.writeFileSync(path.join(at, "subuid"), "azureuser:100000:65536\n");
		fs.writeFileSync(path.join(at, "named"), "azureuser:100000:65536\npim-desktop:165536:65536\n");
		fs.writeFileSync(path.join(at, "numbered"), "2000:165536:65536");
		fs.symlinkSync(path.join(at, "subuid"), path.join(at, "link"));
		const subids = (...files: string[]) => passes(`no_subids pim-desktop 2000 ${files.map((f) => sh(path.join(at, f))).join(" ")}`);
		assert.ok(subids("subuid", "absent"));
		assert.ok(!subids("subuid", "named"));
		assert.ok(!subids("numbered"));
		assert.ok(!subids("link"));
	});

	it("take a unit as running only when systemd says exactly active and running, asking the right manager", () => {
		const systemctl = (answer: string, status = 0) => `systemctl() { printf '%s\\n' "$*" >&2; printf '%s\\n' ${sh(answer)}; return ${status}; }`;
		const running = "ActiveState=active\nSubState=running";
		const system = helper("unit_running system user@2000.service", systemctl(running));
		assert.equal(system.status, 0);
		assert.equal(system.stderr, "show --property=ActiveState,SubState -- user@2000.service\n");
		const user = helper("unit_running pim-desktop@.host pim-desktop-session.service", systemctl(running));
		assert.equal(user.status, 0);
		assert.equal(user.stderr, "--user --machine=pim-desktop@.host show --property=ActiveState,SubState -- pim-desktop-session.service\n");
		assert.ok(!passes("unit_running system x.service", systemctl("ActiveState=activating\nSubState=start")));
		assert.ok(!passes("unit_running system x.service", systemctl("ActiveState=active\nSubState=exited")));
		assert.ok(!passes("unit_running system x.service", systemctl(`${running}\nResult=success`)));
		assert.ok(!passes("unit_running system x.service", systemctl(running, 1)));
	});

	it("find the stock profile's lines whole, and the architecture from both uname and dpkg", () => {
		const at = dir("lines");
		const profile = path.join(at, "chrome");
		fs.writeFileSync(profile, `abi <abi/4.0>,\ninclude <tunables/global>\n\n${STOCK_CHROME_PROFILE.lines[0]}\n${STOCK_CHROME_PROFILE.lines[1]}\n}\n`);
		const lines = STOCK_CHROME_PROFILE.lines.map(sh).join(" ");
		assert.ok(passes(`lines_in ${sh(profile)} ${lines}`));
		fs.writeFileSync(profile, `${STOCK_CHROME_PROFILE.lines[0]}\n  # userns,\n}\n`);
		assert.ok(!passes(`lines_in ${sh(profile)} ${lines}`));
		const arch = (machine: string, dpkgArch: string) => `uname() { printf '%s\\n' ${machine}; }\ndpkg() { [[ "$1" == --print-architecture ]] && printf '%s\\n' ${dpkgArch}; }`;
		assert.ok(passes("arch_is x86_64 amd64", arch("x86_64", "amd64")));
		assert.ok(!passes("arch_is x86_64 amd64", arch("aarch64", "arm64")));
		assert.ok(!passes("arch_is x86_64 amd64", arch("x86_64", "i386")));
	});

	it("log a command's output to the log only, and pass on its status", () => {
		const at = dir("log");
		const log = sh(path.join(at, "setup.log"));
		assert.ok(passes(`run_logged ${log} printf 'apt says %s\\n' hello`));
		assert.equal(helper(`run_logged ${log} printf 'quiet\\n'`).stdout, "");
		assert.ok(!passes(`run_logged ${log} false`));
		assert.equal(fs.readFileSync(path.join(at, "setup.log"), "utf8"), "apt says hello\nquiet\n");
	});
});
