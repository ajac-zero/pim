/**
 * The viewer's startup artifact (docs/cua-viewer-first-startup.md) over fakes only: the configuration's
 * `viewer`, the bridge unit's flags, the planner over a synthetic VM given as metadata, `start`'s refusals
 * over a stand-in probe, the one-time journal provisioning over an in-memory file system
 * (./fake-journal-files.ts), the bundle's viewer entries over archives written by hand, and the rendered
 * scripts as text. It starts no process (not even `bash -n`), reads no account of this machine, makes no
 * socket, and touches no real file but the repository's own pinned viewer files and lockfile, read-only.
 * It has not been run.
 */

import assert from "node:assert/strict";
import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import { before, describe, it } from "node:test";
import * as zlib from "node:zlib";
import {
	BUNDLE_FILES,
	type Config,
	PATHS,
	parseConfig,
	renderCaddyfile,
	renderUnits,
	TOOLS,
	UNITS,
	VIEWER_ACCOUNTS,
	VIEWER_ASSET_NAMES,
	VIEWER_ASSET_SHA256,
	VIEWER_BUNDLE_FILES,
	VIEWER_PATHS,
	VIEWER_UNITS,
	viewerBundleFiles,
} from "../eval-install/config.ts";
import { checkAccounts, checkBackendName, checkUnits, cleanlyStopped, type Facts, inspectedPaths, type PathFact, type Probe, plan, SHOW_UNIT, start, unitState } from "../eval-install/install.ts";
import { compareBundles, RECOVER_FILE, RECOVERY_ADDED, RECOVERY_MAX_RUN_US, type RecoveryHost, type RecoveryProbe, RecoveryFailure, recoverDesktop } from "../eval-install/recover.ts";
import { initialJournalText, newRootToken, provisionJournal, provisionRootToken, ProvisionFailure, tombstoneText } from "../eval-install/journal-provision.ts";
import { BASE_DESKTOP_UID, BUNDLE_SOURCES, bundleEntries, bundleInputs, lockedPackageIntegrity, renderBaseCloudConfig, renderCloudConfig, renderRecoveryScripts, renderScripts, runtimeImports, unresolvedImports, untarPackage, VIEWER_SOURCES } from "../eval-install/operator.ts";
import { integrityHex, missingPins, PINS, type Pins } from "../eval-install/pins.ts";
import { isHttpsOrigin } from "../origin.ts";
import { openJournalStore } from "../journal-store.ts";
import { initialJournal } from "../../../preview/cua-viewer-first.ts";
import { FakeFiles } from "./fake-journal-files.ts";

const REPOSITORY = path.resolve(import.meta.dirname, "../../..");
const OWNER = "o_0123456789abcdefghijklmnop";
const COMMIT = "0123456789abcdef0123456789abcdef01234567";
const PIM = "https://pim-cua-eval.ajac-zero.com";
const VIEWER = "https://cua-eval.ajac-zero.com";
const SPACESD_SHA256 = "78622428711f3778127ad661ba2976ae27bf23ae5e05439d60d5b95511c808fd";

/** The pins with the one commit and archive digest PINS leaves empty filled in, for the commit these tests configure. */
const PINNED: Pins = { ...PINS, repository: { commit: COMMIT, sha256: "a".repeat(64), maxBytes: PINS.repository.maxBytes } };

let publicKeyPem = "";
let fingerprint = "";

before(() => {
	const { publicKey } = crypto.generateKeyPairSync("rsa", { modulusLength: 3072, publicExponent: 0x10001 });
	publicKeyPem = publicKey.export({ type: "spki", format: "pem" }).toString();
	fingerprint = crypto.createHash("sha256").update(publicKey.export({ type: "spki", format: "der" })).digest("hex");
});

type Raw = Record<string, any>;

function rawConfig(viewer: boolean): Raw {
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
		bridge: { host: viewer ? "127.0.0.1" : "0.0.0.0", port: 8443, path: "/pim" },
		desktop: { headful: true, display: ":0", xauthority: null },
		...(viewer
			? {
					viewer: {
						origin: "http://127.0.0.1:3211",
						publicOrigin: VIEWER,
						embedOrigin: PIM,
						display: "primary",
						// The pinned spacesd 0.7.0 release asset's own digest (docs/cua-viewer-first-startup.md); Caddy's binary digest is the operator's to record, so this one stands in.
						spacesd: { path: "/opt/pim-spacesd/bin/cua-spacesd", sha256: SPACESD_SHA256, version: "0.7.0" },
						caddy: { path: "/opt/pim-caddy/bin/caddy", sha256: "e".repeat(64), version: "v2.11.7" },
						backendName: "pim-cua-bridge.internal",
					},
				}
			: {}),
	};
}

const config = (viewer = true, change: (raw: Raw) => void = () => {}): Config => {
	const raw = rawConfig(viewer);
	change(raw);
	return parseConfig(JSON.stringify(raw));
};

const refusedWith = (run: () => unknown, reason: string) =>
	assert.throws(run, (error: unknown) => {
		assert.equal((error as { reason?: string }).reason, reason);
		return true;
	});

describe("the configuration's viewer", () => {
	it("is optional, and a configuration without one is exactly as before", () => {
		const plain = config(false);
		assert.equal(plain.viewer, undefined);
		const bridge = renderUnits(plain, 1000).bridge;
		assert.ok(!bridge.includes("viewer") && !bridge.includes("VIEWER"));
	});

	it("takes the exact origins, and renders the bridge's flags and environment, and nothing else changes", () => {
		const withViewer = config(true);
		const plain = config(false);
		const units = renderUnits(withViewer, 1000);
		assert.equal(units.desktop, renderUnits(plain, 1000).desktop, "the desktop's unit is untouched");
		assert.ok(units.bridge.includes(`Environment=PIM_VIEWER_ROOT_TOKEN_FILE=${VIEWER_PATHS.rootToken}\n`));
		const exec = units.bridge.split("\n").find((line) => line.startsWith("ExecStart="))!;
		assert.equal(
			exec,
			`ExecStart=/opt/pim-node/bin/node /opt/pim-cua/bundle/computer/cua-host/bridge.ts --space ${OWNER} --path /pim --socket /run/pim-session/session.sock --host 127.0.0.1 --port 8443` +
				` --viewer-origin http://127.0.0.1:3211 --viewer-public-origin ${VIEWER} --viewer-embed-origin ${PIM} --viewer-journal-dir /var/lib/pim-viewer --viewer-display primary`,
		);
		// The root token's file is named, never its contents; and the bridge's account alone reads it.
		assert.ok(VIEWER_PATHS.rootToken.startsWith(`${PATHS.bridgeDir}/`));
		// Only lines that carry the viewer differ.
		const base = renderUnits(plain, 1000).bridge.split("\n");
		const extra = units.bridge.split("\n").filter((line) => !base.includes(line));
		assert.equal(extra.length, 2);
	});

	it("refuses an origin that isn't exact, a wildcard, equal origins, a spacesd that isn't loopback HTTP, and a display that isn't one", () => {
		const bad: [string, (raw: Raw) => void][] = [
			["config-publicOrigin", (raw) => (raw.viewer.publicOrigin = "http://cua-eval.ajac-zero.com")],
			["config-publicOrigin", (raw) => (raw.viewer.publicOrigin = "https://*.ajac-zero.com")],
			["config-publicOrigin", (raw) => (raw.viewer.publicOrigin = `${VIEWER}/`)],
			["config-publicOrigin", (raw) => (raw.viewer.publicOrigin = `${VIEWER}:443`)],
			["config-embedOrigin", (raw) => (raw.viewer.embedOrigin = "https://*")],
			["config-embedOrigin", (raw) => (raw.viewer.embedOrigin = `${PIM}/path`)],
			["config-viewer", (raw) => (raw.viewer.embedOrigin = raw.viewer.publicOrigin)],
			["config-origin", (raw) => (raw.viewer.origin = "http://localhost:3211")],
			["config-origin", (raw) => (raw.viewer.origin = "https://127.0.0.1:3211")],
			["config-origin", (raw) => (raw.viewer.origin = "http://10.0.0.4:3211")],
			["config-origin", (raw) => (raw.viewer.origin = "http://127.0.0.1")],
			["config-display", (raw) => (raw.viewer.display = "not a display")],
			["config-display", (raw) => (raw.viewer.display = "")],
			["config-viewer", (raw) => (raw.viewer.extra = 1)],
			["config-viewer", (raw) => delete raw.viewer.embedOrigin],
			["config-object", (raw) => (raw.unknown = 1)],
			// The ingress is the one public listener: the bridge stays private, the public origin is port 443, the names differ, and the pinned programs are exact.
			["config-viewer", (raw) => (raw.bridge.host = "0.0.0.0")],
			["config-viewer", (raw) => (raw.viewer.publicOrigin = "https://cua-eval.ajac-zero.com:8443")],
			["config-viewer", (raw) => (raw.viewer.backendName = "cua-eval.ajac-zero.com")],
			["config-viewer", (raw) => (raw.viewer.origin = "http://127.0.0.1:8443")],
			["config-backendName", (raw) => (raw.viewer.backendName = "localhost")],
			["config-backendName", (raw) => (raw.viewer.backendName = "*.internal")],
			["config-backendName", (raw) => (raw.viewer.backendName = "10.0.0.4")],
			["config-version", (raw) => (raw.viewer.spacesd.version = "0.7")],
			["config-version", (raw) => (raw.viewer.caddy.version = "2.11.7")],
			["config-sha256", (raw) => (raw.viewer.spacesd.sha256 = "abc")],
			["config-sha256", (raw) => (raw.viewer.caddy.sha256 = "E".repeat(64))],
			["config-path", (raw) => (raw.viewer.caddy.path = "relative/caddy")],
			["config-overlap", (raw) => (raw.viewer.caddy.path = "/opt/pim-cua/bundle/caddy")],
			["config-overlap", (raw) => (raw.viewer.spacesd.path = "/etc/pim-spacesd/cua-spacesd")],
			["config-spacesd", (raw) => (raw.viewer.spacesd.extra = 1)],
			["config-spacesd", (raw) => delete raw.viewer.spacesd.sha256],
		];
		for (const [reason, change] of bad) refusedWith(() => config(true, change), reason);
	});
});

describe("the planner with a viewer, over a synthetic VM", () => {
	const DESKTOP_HOME = "/home/pim-desktop";
	const dir = (uid = 0, mode = 0o755): PathFact => ({ kind: "dir", uid, gid: uid, mode });
	const file = (uid = 0, mode = 0o755): PathFact => ({ kind: "file", uid, gid: uid, mode });

	/** A new Ubuntu 24.04 VM as the installer expects it, with the viewer's files in its bundle and nothing of the installer's. */
	type VM = Omit<{ -readonly [K in keyof Facts]: Facts[K] }, "passwd" | "group" | "sudoers" | "paths"> & { passwd: string; group: string; sudoers: (string | null)[]; paths: Record<string, PathFact> };
	function vm(cfg: Config): VM {
		const paths: Record<string, PathFact> = {};
		for (const p of inspectedPaths(cfg, DESKTOP_HOME)) paths[p] = null;
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
		put(cfg.node.path, file());
		put(cfg.browser.path, file());
		for (const f of [...Object.values(BUNDLE_FILES), ...(cfg.viewer ? viewerBundleFiles() : [])]) put(`${cfg.bundle.dir}/${f}`, file(0, 0o644));
		if (cfg.viewer) {
			put(cfg.viewer.spacesd.path, file());
			put(cfg.viewer.caddy.path, file());
		}
		put(path.dirname(cfg.tls.cert), dir(0, 0o700));
		put(cfg.tls.cert, file(0, 0o644));
		put(cfg.tls.key, file(0, 0o600));
		put(DESKTOP_HOME, dir(1000, 0o750));
		for (const d of ["/etc/systemd/system", "/etc/tmpfiles.d", "/run", "/var/lib", path.dirname(cfg.workspace)]) put(d, dir());
		return {
			euid: 0,
			execPath: cfg.node.path,
			nodeVersion: cfg.node.version,
			osRelease: 'NAME="Ubuntu"\nID=ubuntu\nVERSION_ID="24.04"\n',
			passwd: ["root:x:0:0:root:/root:/bin/bash", "pim-desktop:x:1000:1000:Pim desktop:/home/pim-desktop:/bin/bash", ""].join("\n"),
			group: ["root:x:0:", "sudo:x:27:", "pim-desktop:x:1000:", ""].join("\n"),
			sudoers: ["root ALL=(ALL:ALL) ALL\n", "# README\n"],
			paths,
			browserSha256: cfg.browser.sha256,
			...(cfg.viewer ? { spacesdSha256: cfg.viewer.spacesd.sha256, caddySha256: cfg.viewer.caddy.sha256 } : {}),
			bundleMarker: `pim-cua-eval-bundle v1\ncommit ${cfg.commit}\nws 8.22.0 sha512-x\nprotobuf 2.15.0 sha512-${"A".repeat(86)}==\n`,
			ptraceScope: "1\n",
		};
	}

	it("lists the viewer's files, the journal's paths and the tombstone among what it looks at", () => {
		const paths = inspectedPaths(config(true), null);
		for (const f of viewerBundleFiles()) assert.ok(paths.includes(`/opt/pim-cua/bundle/${f}`), f);
		for (const p of Object.values(VIEWER_PATHS)) assert.ok(paths.includes(p), p);
		assert.ok(!inspectedPaths(config(false), null).includes(VIEWER_PATHS.tombstone));
	});

	it("plans the viewer's extra steps in order, the same others, and makes neither the journal nor either root token", () => {
		const withViewer = config(true);
		const plain = config(false);
		const a = plan(withViewer, vm(withViewer));
		const b = plan(plain, vm(plain));
		const extra = ["ingress-account", "spacesd-dir", "spacesd-data", "ingress-dir", "bridge-trust", "caddyfile", "ingress-state", "spacesd-unit", "ingress-unit"];
		assert.deepEqual(a.map((x) => x.step).filter((step) => !b.some((y) => y.step === step)), extra);
		assert.deepEqual(a.map((x) => x.step).filter((step) => b.some((y) => y.step === step)), b.map((x) => x.step));
		// The account is made before the accounts are checked, and the units before they are checked and enabled.
		const order = a.map((x) => x.step);
		assert.ok(order.indexOf("ingress-account") < order.indexOf("accounts") && order.indexOf("ingress-unit") < order.indexOf("units") && order.indexOf("units") < order.indexOf("enable"));
		const byStep = (step: string) => a.find((x) => x.step === step) as Record<string, any>;
		assert.equal(byStep("caddyfile").content.text, renderCaddyfile(withViewer));
		assert.deepEqual(byStep("bridge-trust").content, { staged: "cert" });
		assert.equal(byStep("bridge-trust").path, VIEWER_PATHS.bridgeTrust);
		assert.deepEqual([byStep("ingress-state").owner, byStep("ingress-state").mode], [VIEWER_ACCOUNTS.ingress, 0o700]);
		assert.deepEqual([byStep("spacesd-data").owner, byStep("spacesd-data").mode], ["pim-desktop", 0o700]);
		assert.deepEqual(byStep("enable").argv.slice(-4), ["pim-cua-desktop.service", "pim-cua-bridge.service", VIEWER_UNITS.spacesd, VIEWER_UNITS.ingress]);
		assert.ok(byStep("bridge-unit").content.text.includes("--viewer-public-origin"));
		for (const action of a) {
			if ("path" in action) assert.ok(!action.path.startsWith(VIEWER_PATHS.journalDir) && action.path !== VIEWER_PATHS.tombstone && action.path !== VIEWER_PATHS.rootToken && action.path !== VIEWER_PATHS.spacesdToken, action.step);
		}
	});

	it("refuses an ingress or spacesd that isn't as pinned, a name already taken, and what it would make already there", () => {
		const cfg = config(true);
		for (const target of [VIEWER_PATHS.spacesdDir, VIEWER_PATHS.spacesdData, VIEWER_PATHS.ingressDir, VIEWER_PATHS.ingressState, VIEWER_PATHS.spacesdUnit, VIEWER_PATHS.ingressUnit, `${VIEWER_PATHS.ingressUnit}.d`]) {
			const facts = vm(cfg);
			facts.paths[target] = dir();
			refusedWith(() => plan(cfg, facts), "preexisting-path");
		}
		const missing = vm(cfg);
		missing.paths[cfg.viewer!.spacesd.path] = null;
		refusedWith(() => plan(cfg, missing), "spacesd");
		const digest = vm(cfg);
		digest.spacesdSha256 = "f".repeat(64);
		refusedWith(() => plan(cfg, digest), "spacesd-digest");
		const noCaddy = vm(cfg);
		noCaddy.paths[cfg.viewer!.caddy.path] = file(1000, 0o755);
		refusedWith(() => plan(cfg, noCaddy), "caddy");
		const caddyDigest = vm(cfg);
		caddyDigest.caddySha256 = null;
		refusedWith(() => plan(cfg, caddyDigest), "caddy-digest");
		const taken = vm(cfg);
		taken.passwd += "pim-ingress:x:997:997::/nonexistent:/usr/sbin/nologin\n";
		refusedWith(() => plan(cfg, taken), "preexisting-account");
		const sudoers = vm(cfg);
		sudoers.sudoers = ["pim-ingress ALL=(ALL) NOPASSWD: ALL\n"];
		refusedWith(() => plan(cfg, sudoers), "sudoers");
	});

	it("refuses a VM that has a journal, a tombstone, or a bundle without the viewer or its pinned package", () => {
		const cfg = config(true);
		for (const target of [VIEWER_PATHS.journalDir, VIEWER_PATHS.tombstone]) {
			const facts = vm(cfg);
			facts.paths[target] = target === VIEWER_PATHS.journalDir ? dir(0, 0o700) : file(0, 0o444);
			refusedWith(() => plan(cfg, facts), "preexisting-path");
		}
		for (const f of [VIEWER_BUNDLE_FILES.viewerHost, VIEWER_BUNDLE_FILES.provision, VIEWER_BUNDLE_FILES.protobuf, `computer/cua-host/cua-viewer/assets/${VIEWER_ASSET_NAMES[1]}`]) {
			const facts = vm(cfg);
			facts.paths[`${cfg.bundle.dir}/${f}`] = null;
			refusedWith(() => plan(cfg, facts), "bundle");
		}
		const noPackage = vm(cfg);
		noPackage.bundleMarker = `pim-cua-eval-bundle v1\ncommit ${COMMIT}\nws 8.22.0 sha512-x\n`;
		refusedWith(() => plan(cfg, noPackage), "bundle-commit");
	});
});

describe("start with a viewer, over a stand-in probe", () => {
	const BRIDGE_UID = 998;
	const PASSWD = ["root:x:0:0:root:/root:/bin/bash", `pim-bridge:x:${BRIDGE_UID}:${BRIDGE_UID}::/nonexistent:/usr/sbin/nologin`, "pim-desktop:x:1000:1000::/home/pim-desktop:/bin/bash", ""].join("\n");
	const fact = (kind: "file" | "dir", uid: number, mode: number): PathFact => ({ kind, uid, gid: uid, mode });

	/** A probe whose files are as a provisioned VM's, with `change` making one wrong. */
	function probe(change: (files: Record<string, PathFact>) => void = () => {}, query: Probe["query"] = () => ({ status: 1, stdout: "" })): Probe {
		const files: Record<string, PathFact> = {
			[PATHS.token]: fact("file", BRIDGE_UID, 0o600),
			[VIEWER_PATHS.rootToken]: fact("file", BRIDGE_UID, 0o600),
			[VIEWER_PATHS.journalDir]: fact("dir", BRIDGE_UID, 0o700),
			[VIEWER_PATHS.journal]: fact("file", BRIDGE_UID, 0o600),
			[VIEWER_PATHS.tombstone]: fact("file", 0, 0o444),
			[VIEWER_PATHS.spacesdToken]: fact("file", 1000, 0o600),
			[VIEWER_PATHS.bridgeTrust]: fact("file", 0, 0o644),
			[VIEWER_PATHS.caddyfile]: fact("file", 0, 0o644),
			"/tmp/.X11-unix/X0": { kind: "socket", uid: 1000, gid: 1000, mode: 0o777 },
			"/run/user/1000": fact("dir", 1000, 0o700),
		};
		change(files);
		return {
			lstat: (f) => files[f] ?? null,
			readText: (f) => (f === "/etc/passwd" ? PASSWD : null),
			// By default every check that must refuse does so before the units are asked; one that got there would fail this.
			query,
		};
	}
	const refusal = (p: Probe) => {
		const runs: string[][] = [];
		try {
			start(config(true), p, (argv) => runs.push([...argv]));
		} catch (error) {
			assert.deepEqual(runs, [], "nothing was started");
			return (error as { reason?: string }).reason;
		}
		return runs.length === 0 ? "none" : "started";
	};

	it("refuses without the root token, as the bridge's own, 0600", () => {
		assert.equal(refusal(probe((f) => delete f[VIEWER_PATHS.rootToken])), "viewer-root-token-missing");
		assert.equal(refusal(probe((f) => (f[VIEWER_PATHS.rootToken] = fact("file", BRIDGE_UID, 0o640)))), "viewer-root-token-missing");
		assert.equal(refusal(probe((f) => (f[VIEWER_PATHS.rootToken] = fact("file", 1000, 0o600)))), "viewer-root-token-missing");
		assert.equal(refusal(probe((f) => (f[VIEWER_PATHS.rootToken] = fact("dir", BRIDGE_UID, 0o700)))), "viewer-root-token-missing");
	});

	it("refuses without the journal made once, as it must be, and the tombstone", () => {
		assert.equal(refusal(probe((f) => delete f[VIEWER_PATHS.journal])), "journal-missing");
		assert.equal(refusal(probe((f) => delete f[VIEWER_PATHS.journalDir])), "journal-missing");
		assert.equal(refusal(probe((f) => (f[VIEWER_PATHS.journalDir] = fact("dir", BRIDGE_UID, 0o755)))), "journal-missing");
		assert.equal(refusal(probe((f) => (f[VIEWER_PATHS.journal] = fact("file", BRIDGE_UID, 0o644)))), "journal-missing");
		assert.equal(refusal(probe((f) => (f[VIEWER_PATHS.journal] = fact("file", 0, 0o600)))), "journal-missing");
		assert.equal(refusal(probe((f) => delete f[VIEWER_PATHS.tombstone])), "journal-missing", "a journal with no tombstone is not one this tooling made");
		assert.equal(refusal(probe((f) => (f[VIEWER_PATHS.tombstone] = fact("file", 0, 0o644)))), "journal-missing");
	});

	it("refuses without spacesd's own token as the desktop account's 0600 file, and without the ingress's files as root's", () => {
		assert.equal(refusal(probe((f) => delete f[VIEWER_PATHS.spacesdToken])), "viewer-root-token-missing");
		assert.equal(refusal(probe((f) => (f[VIEWER_PATHS.spacesdToken] = fact("file", BRIDGE_UID, 0o600)))), "viewer-root-token-missing");
		assert.equal(refusal(probe((f) => (f[VIEWER_PATHS.spacesdToken] = fact("file", 1000, 0o644)))), "viewer-root-token-missing");
		assert.equal(refusal(probe((f) => delete f[VIEWER_PATHS.bridgeTrust])), "ingress-missing");
		assert.equal(refusal(probe((f) => (f[VIEWER_PATHS.caddyfile] = fact("file", 1000, 0o644)))), "ingress-missing");
		assert.equal(refusal(probe((f) => (f[VIEWER_PATHS.caddyfile] = fact("file", 0, 0o666)))), "ingress-missing");
	});

	it("refuses with a lock left behind, and removes nothing", () => {
		assert.equal(refusal(probe((f) => (f[VIEWER_PATHS.journalLock] = fact("file", BRIDGE_UID, 0o600)))), "journal-locked");
	});

	it("gets past every viewer check when the files are as they must be, and then asks about the units", () => {
		assert.equal(refusal(probe()), "desktop-not-clean");
	});

	describe("and the units, as systemd records them", () => {
		/** What `systemctl show` prints for a unit, by default one that is loaded and has never run. */
		const show = (change: Record<string, string> = {}) => ({
			status: 0,
			stdout: `${Object.entries({ LoadState: "loaded", ActiveState: "inactive", SubState: "dead", Result: "success", ExecMainPID: "0", ExecMainCode: "0", ExecMainStatus: "0", ExecMainStartTimestampMonotonic: "0", ExecMainExitTimestampMonotonic: "0", ...change })
				.map(([name, value]) => `${name}=${value}`)
				.join("\n")}\n`,
		});
		const RUNNING = { ActiveState: "active", SubState: "running", ExecMainPID: "4100", ExecMainCode: "0", ExecMainStartTimestampMonotonic: "100" };
		const FAILED = { ActiveState: "failed", SubState: "failed", Result: "exit-code", ExecMainPID: "4200", ExecMainCode: "1", ExecMainStatus: "1", ExecMainStartTimestampMonotonic: "100", ExecMainExitTimestampMonotonic: "200" };
		/** Inactive after exiting 0: the desktop endpoint's rule accepts this, the viewer's units' does not. */
		const EXITED = { ExecMainPID: "4300", ExecMainCode: "1", ExecMainStatus: "0", ExecMainStartTimestampMonotonic: "100", ExecMainExitTimestampMonotonic: "200" };
		const probeWith = (units: Record<string, ReturnType<typeof show>>) => probe(() => {}, (argv) => units[argv[argv.length - 1]!] ?? { status: 1, stdout: "" });
		const never = { [UNITS.desktop]: show(), [UNITS.bridge]: show(), [VIEWER_UNITS.spacesd]: show(), [VIEWER_UNITS.ingress]: show() };
		const started = (p: Probe) => {
			const runs: string[] = [];
			start(config(true), p, (argv) => runs.push(argv.slice(1).join(" ")));
			return runs;
		};

		it("starts all four, inside out, when none has ever run", () => {
			assert.deepEqual(started(probeWith(never)), [`start ${UNITS.desktop}`, `start ${VIEWER_UNITS.spacesd}`, `start ${UNITS.bridge}`, `start ${VIEWER_UNITS.ingress}`]);
		});

		it("sends no start to a viewer unit that is running, and still starts the rest", () => {
			assert.deepEqual(started(probeWith({ ...never, [VIEWER_UNITS.spacesd]: show(RUNNING) })), [`start ${UNITS.desktop}`, `start ${UNITS.bridge}`, `start ${VIEWER_UNITS.ingress}`]);
			assert.deepEqual(started(probeWith({ ...never, [VIEWER_UNITS.ingress]: show(RUNNING) })), [`start ${UNITS.desktop}`, `start ${VIEWER_UNITS.spacesd}`, `start ${UNITS.bridge}`]);
		});

		it("refuses, starting nothing, a viewer unit that ran and ended, is changing or can't be read: spacesd and the ingress start once", () => {
			for (const unit of [VIEWER_UNITS.spacesd, VIEWER_UNITS.ingress]) {
				for (const [name, state] of [
					["failed", show(FAILED)],
					["inactive after exiting 0", show(EXITED)],
					["activating", show({ ActiveState: "activating", SubState: "start" })],
					["deactivating", show({ ...RUNNING, ActiveState: "deactivating", SubState: "stop-sigterm" })],
					["not loaded", show({ LoadState: "not-found" })],
					["unreadable", { status: 1, stdout: "" }],
					["inactive with a result that isn't success", show({ Result: "exit-code" })],
				] as const) assert.equal(refusal(probeWith({ ...never, [unit]: state })), "viewer-unit-state", `${unit}: ${name}`);
			}
		});

		it("asks about the desktop endpoint before the viewer's units, as before", () => {
			assert.equal(refusal(probeWith({ ...never, [UNITS.desktop]: show(FAILED), [VIEWER_UNITS.spacesd]: show(FAILED) })), "desktop-not-clean");
		});
	});

	it("still asks for the bridge's own token first", () => {
		assert.equal(refusal(probe((f) => delete f[PATHS.token])), "token-missing");
	});
});

describe("the journal, provisioned once", () => {
	const BRIDGE = { uid: 998, gid: 998 };
	const TOMBSTONE_DIR = "/etc/pim-eval";
	const PARENT = "/var/lib";

	/** A VM's directories, as root's: the installer made `/etc/pim-eval`, and `/var/lib` is Ubuntu's. */
	function machine(): FakeFiles {
		const files = new FakeFiles();
		files.user = 0;
		files.directory(TOMBSTONE_DIR, 0o755, 0);
		files.directory(PARENT, 0o755, 0);
		return files;
	}
	const cfg = config(true);
	const snapshot = (files: FakeFiles) => JSON.stringify([...files.nodes].map(([name, node]) => [name, node.kind, node.uid, node.mode, node.data.toString("utf8")]));
	const failure = (run: () => void): ProvisionFailure => {
		try {
			run();
		} catch (error) {
			assert.ok(error instanceof ProvisionFailure, String(error));
			return error;
		}
		throw new Error("provisioning didn't fail");
	};

	it("makes the tombstone first, then the directory and the journal, flushing each, and the journal is the one `initialJournal` states", () => {
		const files = machine();
		provisionJournal(cfg, BRIDGE, files);
		const creates = files.log.filter((entry) => /^(mkdir|chown|fchown|fsync|rename|unlink)/.test(entry));
		assert.deepEqual(creates, [
			`fsync ${VIEWER_PATHS.tombstone}`,
			`fsync ${TOMBSTONE_DIR}`,
			`mkdir ${VIEWER_PATHS.journalDir}`,
			`chown ${VIEWER_PATHS.journalDir}`,
			`fchown ${VIEWER_PATHS.journal}`,
			`fsync ${VIEWER_PATHS.journal}`,
			`fsync ${VIEWER_PATHS.journalDir}`,
			`fsync ${PARENT}`,
		]);
		const tombstone = files.nodes.get(VIEWER_PATHS.tombstone)!;
		assert.deepEqual([tombstone.kind, tombstone.uid, tombstone.mode], ["file", 0, 0o444]);
		assert.equal(tombstone.data.toString("utf8"), tombstoneText(cfg));
		assert.deepEqual(JSON.parse(tombstone.data.toString("utf8")), { event: "pim-cua-eval.journal-provisioned", evaluation: cfg.evaluation, owner: OWNER });
		const dir = files.nodes.get(VIEWER_PATHS.journalDir)!;
		assert.deepEqual([dir.kind, dir.uid, dir.mode], ["dir", BRIDGE.uid, 0o700]);
		const journal = files.nodes.get(VIEWER_PATHS.journal)!;
		assert.deepEqual([journal.kind, journal.uid, journal.mode], ["file", BRIDGE.uid, 0o600]);
		// The same shape as `initialJournal`, which is revision 1 and no entries.
		assert.deepEqual(JSON.parse(journal.data.toString("utf8")), initialJournal(`${cfg.evaluation} ${OWNER} journal-provision`));
		assert.equal(journal.data.toString("utf8"), initialJournalText(cfg));
		// Never the lock, never a removal.
		assert.equal(files.nodes.has(VIEWER_PATHS.journalLock), false);
		assert.equal(files.log.some((entry) => entry.startsWith("unlink") || entry.startsWith("rename")), false);
	});

	it("leaves a journal the host's own store opens as the bridge's account: revision 1, and no lock but its own", async () => {
		const files = machine();
		provisionJournal(cfg, BRIDGE, files);
		files.user = BRIDGE.uid;
		const { store, close } = openJournalStore({ directory: VIEWER_PATHS.journalDir, files });
		assert.deepEqual(await store.read(), initialJournal(`${cfg.evaluation} ${OWNER} journal-provision`));
		await close();
		assert.equal(files.nodes.has(VIEWER_PATHS.journalLock), false);
	});

	it("refuses a second time, from the tombstone alone, and changes nothing, even when the journal is gone", () => {
		const files = machine();
		provisionJournal(cfg, BRIDGE, files);
		const after = snapshot(files);
		let refused = failure(() => provisionJournal(cfg, BRIDGE, files));
		assert.deepEqual([refused.step, refused.reason, refused.changed], ["check", "already-provisioned", false]);
		assert.equal(snapshot(files), after);
		// The directory and journal lost, the tombstone kept: no journal is made again.
		files.nodes.delete(VIEWER_PATHS.journal);
		files.nodes.delete(VIEWER_PATHS.journalDir);
		refused = failure(() => provisionJournal(cfg, BRIDGE, files));
		assert.equal(refused.reason, "already-provisioned");
		assert.equal(files.nodes.has(VIEWER_PATHS.journalDir), false);
	});

	it("refuses, and makes no tombstone, when the directory is already there, a parent isn't root's, it isn't root, or there is no viewer", () => {
		const present = machine();
		present.directory(VIEWER_PATHS.journalDir, 0o700, BRIDGE.uid);
		const refused = failure(() => provisionJournal(cfg, BRIDGE, present));
		assert.deepEqual([refused.reason, refused.changed], ["journal-dir-exists", false]);
		assert.equal(present.nodes.has(VIEWER_PATHS.tombstone), false);

		const open = machine();
		open.nodes.get(PARENT)!.mode = 0o777;
		assert.equal(failure(() => provisionJournal(cfg, BRIDGE, open)).reason, "unsafe-parent");
		const another = machine();
		another.nodes.get(TOMBSTONE_DIR)!.uid = 1000;
		assert.equal(failure(() => provisionJournal(cfg, BRIDGE, another)).reason, "unsafe-parent");
		const user = machine();
		user.user = 1000;
		assert.equal(failure(() => provisionJournal(cfg, BRIDGE, user)).reason, "root-required");
		assert.equal(failure(() => provisionJournal(config(false), BRIDGE, machine())).reason, "no-viewer");
		for (const files of [open, another, user]) assert.equal(files.nodes.has(VIEWER_PATHS.tombstone), false);
	});

	it("stops at a failing step, undoes nothing, and leaves the tombstone so nothing is made again", () => {
		const cases: [string, string, string][] = [
			["fsync", "tombstone", "write"],
			["write", "tombstone", "write"],
			["close", "tombstone", "descriptor-retained"],
		];
		for (const [operation, step, reason] of cases) {
			const files = machine();
			files.failNext.add(operation);
			const refused = failure(() => provisionJournal(cfg, BRIDGE, files));
			assert.deepEqual([refused.step, refused.reason, refused.changed], [step, reason, true], operation);
			assert.equal(files.nodes.has(VIEWER_PATHS.journalDir), false, operation);
			assert.equal(files.log.some((entry) => entry.startsWith("unlink")), false, operation);
			assert.equal(failure(() => provisionJournal(cfg, BRIDGE, files)).reason, "already-provisioned", operation);
		}
		for (const operation of ["mkdir", "chown"]) {
			const files = machine();
			files.failNext.add(operation);
			const refused = failure(() => provisionJournal(cfg, BRIDGE, files));
			assert.deepEqual([refused.step, refused.changed], ["journal-dir", true], operation);
			assert.equal(files.nodes.has(VIEWER_PATHS.tombstone), true, operation);
			assert.equal(files.nodes.has(VIEWER_PATHS.journal), false, operation);
			assert.equal(failure(() => provisionJournal(cfg, BRIDGE, files)).reason, "already-provisioned", operation);
		}
		// The journal's own failures, after the tombstone and the directory are made: neither is undone.
		const owner = machine();
		owner.failNext.add("fchown");
		const refusedOwner = failure(() => provisionJournal(cfg, BRIDGE, owner));
		assert.deepEqual([refusedOwner.step, refusedOwner.reason, refusedOwner.changed], ["journal", "write", true]);
		assert.equal(owner.nodes.has(VIEWER_PATHS.tombstone), true);
		assert.equal(owner.nodes.has(VIEWER_PATHS.journalDir), true);
		assert.equal(failure(() => provisionJournal(cfg, BRIDGE, owner)).reason, "already-provisioned");

		const written = machine();
		const original = written.write.bind(written);
		let writes = 0;
		written.write = (descriptor, data) => {
			// The tombstone's write is the first; the journal's is the second.
			if (++writes === 2) throw Object.assign(new Error("EIO"), { code: "EIO" });
			original(descriptor, data);
		};
		const refusedWrite = failure(() => provisionJournal(cfg, BRIDGE, written));
		assert.deepEqual([refusedWrite.step, refusedWrite.reason, refusedWrite.changed], ["journal", "write", true]);
		assert.equal(written.nodes.has(VIEWER_PATHS.tombstone), true);
		assert.equal(written.log.some((entry) => entry.startsWith("unlink")), false);
		assert.equal(failure(() => provisionJournal(cfg, BRIDGE, written)).reason, "already-provisioned");
	});
});

describe("the viewer's bundle", () => {
	/** A ustar archive of the given files, written by hand. */
	function ustar(entries: { name: string; body: string }[], count = 0): Buffer {
		const blocks: Buffer[] = [];
		const all = [...entries, ...Array.from({ length: count }, (_, i) => ({ name: `package/filler/f${i}.js`, body: "x" }))];
		for (const entry of all) {
			const body = Buffer.from(entry.body);
			const header = Buffer.alloc(512);
			header.write(entry.name, 0, 100, "latin1");
			header.write("0000644\0", 100, "latin1");
			header.write("0000000\0", 108, "latin1");
			header.write("0000000\0", 116, "latin1");
			header.write(`${body.length.toString(8).padStart(11, "0")}\0`, 124, "latin1");
			header.write("00000000000\0", 136, "latin1");
			header.write("0", 156, "latin1");
			header.write("ustar\x0000", 257, "latin1");
			header.fill(0x20, 148, 156);
			const sum = header.reduce((total, byte) => total + byte, 0);
			header.write(`${sum.toString(8).padStart(6, "0")}\0 `, 148, "latin1");
			blocks.push(header, body, Buffer.alloc((512 - (body.length % 512)) % 512));
		}
		blocks.push(Buffer.alloc(1024));
		return zlib.gzipSync(Buffer.concat(blocks));
	}
	const integrity = (bytes: Buffer) => `sha512-${crypto.createHash("sha512").update(bytes).digest("base64")}`;
	const WS_PACKAGE = JSON.stringify({ name: "ws", version: "8.22.0" });
	const PROTOBUF_PACKAGE = JSON.stringify({ name: "@bufbuild/protobuf", version: "2.15.0" });
	const wsTarball = ustar([{ name: "package/package.json", body: WS_PACKAGE }, { name: "package/index.js", body: "module.exports = 1;\n" }]);
	const protobufTarball = ustar([{ name: "package/package.json", body: PROTOBUF_PACKAGE }, { name: "package/dist/index.js", body: "export {};\n" }]);

	/** The repository's own files for every source the bundle reads, as `git show` would give them. */
	function sources(): Map<string, Buffer> {
		const map = new Map<string, Buffer>();
		for (const source of [...BUNDLE_SOURCES, ...VIEWER_SOURCES]) map.set(source, fs.readFileSync(path.join(REPOSITORY, source)));
		return map;
	}
	const base = { commit: COMMIT, wsVersion: "8.22.0", wsIntegrity: integrity(wsTarball), wsTarball };
	const viewer = { protobufVersion: "2.15.0", protobufIntegrity: integrity(protobufTarball), protobufTarball };

	it("holds the pinned page and scripts to their SHA-256, which are the adapter's own pins", async () => {
		const { VIEWER_ASSETS } = await import("../viewer-upstream.ts");
		for (const name of VIEWER_ASSET_NAMES) assert.equal(VIEWER_ASSET_SHA256[name], VIEWER_ASSETS[name].sha256, name);
		assert.deepEqual([...VIEWER_ASSET_NAMES].sort(), Object.keys(VIEWER_ASSETS).sort());
		for (const name of VIEWER_ASSET_NAMES) {
			assert.equal(crypto.createHash("sha256").update(fs.readFileSync(path.join(REPOSITORY, "computer/cua-host/cua-viewer/assets", name))).digest("hex"), VIEWER_ASSET_SHA256[name], name);
		}
	});

	it("adds the viewer's programs, its pinned files and its one package, and names the package in the marker", () => {
		const plain = bundleEntries({ ...base, sources: sources() });
		const entries = bundleEntries({ ...base, sources: sources(), viewer });
		for (const file of viewerBundleFiles()) assert.ok(entries.has(file), file);
		assert.ok(entries.has("computer/cua-host/node_modules/@bufbuild/protobuf/dist/index.js"));
		assert.equal(entries.get(VIEWER_BUNDLE_FILES.protobuf)!.toString("utf8"), PROTOBUF_PACKAGE);
		assert.equal(entries.get("BUNDLE")!.toString("utf8"), `${plain.get("BUNDLE")!.toString("utf8")}protobuf 2.15.0 ${integrity(protobufTarball)}\n`);
		// Without a viewer the bundle is exactly what it was: none of the viewer's files, and the old marker.
		for (const file of viewerBundleFiles()) assert.equal(plain.has(file), false, file);
		assert.equal(plain.get("BUNDLE")!.toString("utf8"), `pim-cua-eval-bundle v1\ncommit ${COMMIT}\nws 8.22.0 ${integrity(wsTarball)}\n`);
		// Nothing is a link or a name a digest refuses.
		for (const file of entries.keys()) assert.match(file, /^[A-Za-z0-9._@-]+(\/[A-Za-z0-9._@-]+)*$/);
	});

	it("refuses a page or script that isn't the pinned one, a package of another integrity or name, and a missing source", () => {
		const changed = sources();
		changed.set("computer/cua-host/cua-viewer/assets/viewer.js", Buffer.from("// another viewer"));
		refusedWith(() => bundleEntries({ ...base, sources: changed, viewer }), "viewer-asset");
		refusedWith(() => bundleEntries({ ...base, sources: sources(), viewer: { ...viewer, protobufIntegrity: integrity(Buffer.from("other")) } }), "protobuf-integrity");
		const other = ustar([{ name: "package/package.json", body: JSON.stringify({ name: "@bufbuild/other", version: "2.15.0" }) }]);
		refusedWith(() => bundleEntries({ ...base, sources: sources(), viewer: { ...viewer, protobufTarball: other, protobufIntegrity: integrity(other) } }), "protobuf-package");
		const wrong = ustar([{ name: "package/package.json", body: JSON.stringify({ name: "@bufbuild/protobuf", version: "2.15.1" }) }]);
		refusedWith(() => bundleEntries({ ...base, sources: sources(), viewer: { ...viewer, protobufTarball: wrong, protobufIntegrity: integrity(wrong) } }), "protobuf-package");
		const missing = sources();
		missing.delete(VIEWER_BUNDLE_FILES.viewerHost);
		refusedWith(() => bundleEntries({ ...base, sources: missing, viewer }), "source");
		const unsafe = ustar([{ name: "package/package.json", body: PROTOBUF_PACKAGE }, { name: "package/../escape.js", body: "x" }]);
		refusedWith(() => bundleEntries({ ...base, sources: sources(), viewer: { ...viewer, protobufTarball: unsafe, protobufIntegrity: integrity(unsafe) } }), "protobuf-tarball");
	});

	it("reads a package's many files within wider bounds than `ws`'s, and refuses more than those", () => {
		const many = ustar([{ name: "package/package.json", body: PROTOBUF_PACKAGE }], 600);
		refusedWith(() => untarPackage(many), "ws-tarball");
		assert.equal(untarPackage(many, { maxEntries: 4096, reason: "protobuf-tarball" }).size, 601);
		refusedWith(() => untarPackage(ustar([{ name: "package/package.json", body: PROTOBUF_PACKAGE }], 5000), { maxEntries: 4096, reason: "protobuf-tarball" }), "protobuf-tarball");
	});

	/**
	 * Packages with the `exports` the real ones have, built from what the sources import: `ws` with its `import` condition, and every `@bufbuild/protobuf` subpath
	 * a source names. They stand in for the real tarballs, which a test must not download; the operator's own build runs the same check on the real ones.
	 */
	function packagesFor(): { ws: Buffer; protobuf: Buffer } {
		const subpaths = new Set<string>();
		for (const source of [...BUNDLE_SOURCES, ...VIEWER_SOURCES].filter((file) => file.endsWith(".ts"))) {
			for (const { specifier } of runtimeImports(fs.readFileSync(path.join(REPOSITORY, source), "utf8"))) if (specifier.startsWith("@bufbuild/protobuf/")) subpaths.add(specifier.slice("@bufbuild/protobuf".length));
		}
		const exports: Record<string, unknown> = { ".": { import: { types: "./dist/esm/index.d.ts", default: "./dist/esm/index.js" }, require: { default: "./dist/commonjs/index.js" } } };
		const files = [{ name: "package/dist/esm/index.js", body: "export {};\n" }];
		for (const sub of subpaths) {
			exports[`.${sub}`] = { import: { types: `./dist/esm${sub}/index.d.ts`, default: `./dist/esm${sub}/index.js` } };
			files.push({ name: `package/dist/esm${sub}/index.js`, body: "export {};\n" });
		}
		return {
			ws: ustar([{ name: "package/package.json", body: JSON.stringify({ name: "ws", version: "8.22.0", exports: { ".": { browser: "./browser.js", import: "./wrapper.mjs", require: "./index.js" }, "./package.json": "./package.json" } }) }, { name: "package/wrapper.mjs", body: "export {};\n" }, { name: "package/index.js", body: "module.exports = 1;\n" }]),
			protobuf: ustar([{ name: "package/package.json", body: JSON.stringify({ name: "@bufbuild/protobuf", version: "2.15.0", exports }) }, ...files]),
		};
	}
	const assembled = (withViewer: boolean) => {
		const packages = packagesFor();
		return bundleEntries({
			commit: COMMIT,
			sources: sources(),
			wsVersion: "8.22.0",
			wsIntegrity: integrity(packages.ws),
			wsTarball: packages.ws,
			...(withViewer ? { viewer: { protobufVersion: "2.15.0", protobufIntegrity: integrity(packages.protobuf), protobufTarball: packages.protobuf } } : {}),
		});
	};

	it("holds every file the desktop endpoint imports, including `native-outcome.ts` and `cua-credential.ts`, which the first bundle left out", () => {
		for (const file of ["computer/native-outcome.ts", "computer/cua-host/cua-credential.ts"]) {
			assert.ok(BUNDLE_SOURCES.includes(file as never), file);
			assert.equal(assembled(false).get(file)!.toString("utf8"), fs.readFileSync(path.join(REPOSITORY, file), "utf8"), file);
		}
		// What the real desktop.ts imports at runtime, read from the repository, and not what is type-only.
		const desktop = runtimeImports(fs.readFileSync(path.join(REPOSITORY, "computer/cua-host/desktop.ts"), "utf8")).map((i) => i.specifier);
		assert.ok(desktop.includes("../native-outcome.ts") && desktop.includes("./cua-credential.ts") && desktop.includes("./session.ts"));
		assert.equal(desktop.includes("../cua-bridge.ts"), false, "`import type` is erased");
	});

	it("resolves every runtime import of the assembled bundle, with the viewer and without, from the entries themselves", () => {
		assert.deepEqual(unresolvedImports(assembled(true), true), []);
		assert.deepEqual(unresolvedImports(assembled(false), false), [], "the viewer's file is a dynamic import the base bundle never loads");
		// The same bundle read as if it should hold the viewer is not complete: the base has none of the viewer's files.
		assert.ok(unresolvedImports(assembled(false), true).length > 0);
	});

	it("reports the live failure: a bundle without those two files cannot load `desktop.ts`", () => {
		const old = new Map(assembled(true));
		old.delete("computer/native-outcome.ts");
		assert.deepEqual(unresolvedImports(old, true), ["computer/cua-host/desktop.ts>../native-outcome.ts"]);
		old.delete("computer/cua-host/cua-credential.ts");
		assert.deepEqual(unresolvedImports(old, true), ["computer/cua-host/desktop.ts>../native-outcome.ts", "computer/cua-host/desktop.ts>./cua-credential.ts"]);
	});

	it("follows imports through the files the bundle holds, ignores type-only ones, and refuses a package without its target", () => {
		const entries = (files: Record<string, string>) => new Map(Object.entries(files).map(([name, body]) => [name, Buffer.from(body)]));
		const pkg = (exports: unknown) => JSON.stringify({ name: "p", exports });
		// A chain a -> b -> c with c missing is reported at b, the file that needs it.
		assert.deepEqual(unresolvedImports(entries({ "computer/a.ts": 'import { b } from "./b.ts";\n', "computer/b.ts": 'import * as c from "./c.ts";\nexport const b = c;\n' }), true), ["computer/b.ts>./c.ts"]);
		// Type-only, in any form Node erases, is not a runtime import; an inline `type` specifier is not erased whole and is.
		assert.deepEqual(unresolvedImports(entries({ "computer/a.ts": 'import type { X } from "./gone.ts";\nexport type { Y } from "./gone2.ts";\nimport type Z from "./gone3.ts";\n' }), true), []);
		assert.deepEqual(unresolvedImports(entries({ "computer/a.ts": 'import { type X } from "./gone.ts";\n' }), true), ["computer/a.ts>./gone.ts"]);
		// Several forms: multi-line, re-export, side effect, dynamic, and a built-in that is the runtime's.
		assert.deepEqual(unresolvedImports(entries({ "computer/a.ts": 'import {\n\tone,\n\ttwo,\n} from "./m1.ts";\nexport * from "./m2.ts";\nimport "./m3.ts";\nawait import("./m4.ts");\nimport * as fs from "node:fs";\n' }), true), ["computer/a.ts>./m1.ts", "computer/a.ts>./m2.ts", "computer/a.ts>./m3.ts", "computer/a.ts>./m4.ts"]);
		// A comment or a string that looks like an import is not one.
		assert.deepEqual(unresolvedImports(entries({ "computer/a.ts": '// import x from "./gone.ts";\n/**\n * import y from "./gone2.ts"\n */\nconst s = "import z from \'./gone3.ts\'";\n' }), true), []);
		// Packages: present with the target file; absent; subpath not exported; target file missing; a file inside `node_modules` is not scanned.
		const good = { "computer/cua-host/node_modules/p/package.json": pkg({ ".": { import: "./i.mjs" }, "./sub": { import: { default: "./s.js" } } }), "computer/cua-host/node_modules/p/i.mjs": "", "computer/cua-host/node_modules/p/s.js": "" };
		assert.deepEqual(unresolvedImports(entries({ ...good, "computer/a.ts": 'import "p";\nimport "p/sub";\n' }), true), []);
		assert.deepEqual(unresolvedImports(entries({ ...good, "computer/a.ts": 'import "q";\nimport "p/other";\n' }), true), ["computer/a.ts>q", "computer/a.ts>p/other"]);
		const { "computer/cua-host/node_modules/p/s.js": _dropped, ...noTarget } = good;
		assert.deepEqual(unresolvedImports(entries({ ...noTarget, "computer/a.ts": 'import "p/sub";\n' }), true), ["computer/a.ts>p/sub"]);
		assert.deepEqual(unresolvedImports(entries({ ...good, "computer/cua-host/node_modules/p/x.ts": 'import "./nothing.ts";\n' }), true), []);
	});

	it("makes the new bundle the old one plus the permitted files, from the assembled entries, so the recovery's comparison holds for a real bundle", () => {
		const entries = assembled(true);
		const digests = (map: Map<string, Buffer>) => Object.fromEntries([...map].map(([file, content]) => [file, crypto.createHash("sha256").update(content).digest("hex")]));
		const old = new Map(entries);
		for (const file of RECOVERY_ADDED) old.delete(file);
		old.set("BUNDLE", Buffer.from("pim-cua-eval-bundle v1\ncommit afc9371a75f1c21b3b22627222b9791ef283692d\n"));
		assert.equal(compareBundles(digests(old), digests(entries)), null);
		assert.deepEqual(RECOVERY_ADDED.filter((file) => !entries.has(file)), []);
		// An old bundle that is not a subset (a file of its own that the new one lacks) fails.
		old.set("computer/only-in-old.ts", Buffer.from("x"));
		assert.equal(compareBundles(digests(old), digests(entries)), "bundle-differs");
	});

	it("is checked by the operator's own build before a bundle is written, so a defective one can't be made", () => {
		const source = fs.readFileSync(path.join(REPOSITORY, "computer/cua-host/eval-install/operator.ts"), "utf8");
		const check = source.indexOf("unresolvedImports(entries, viewer !== undefined)");
		assert.ok(check > 0 && check < source.indexOf("writeTree(out, entries)"));
		assert.ok(source.includes("throw new Refusal(`bundle-closure:${unresolved[0]}`)"));
	});

	it("finds a scoped package's locked integrity in the repository's own lockfile, and no other version's", () => {
		const lockfile = fs.readFileSync(path.join(REPOSITORY, "pnpm-lock.yaml"), "utf8");
		assert.match(lockedPackageIntegrity(lockfile, "@bufbuild/protobuf", "2.15.0"), /^sha512-[A-Za-z0-9+/]{86}==$/);
		refusedWith(() => lockedPackageIntegrity(lockfile, "@bufbuild/protobuf", "2.15.1"), "package-lock");
		refusedWith(() => lockedPackageIntegrity(lockfile, "@bufbuild/nothing", "2.15.0"), "package-lock");
	});
});

describe("the viewer's accounts and units", () => {
	const PASSWD = [
		"root:x:0:0:root:/root:/bin/bash",
		"pim-desktop:x:1000:1000::/home/pim-desktop:/bin/bash",
		"pim-bridge:x:998:998::/nonexistent:/usr/sbin/nologin",
		"pim-ingress:x:997:997::/nonexistent:/usr/sbin/nologin",
		"",
	].join("\n");
	const GROUP = ["root:x:0:", "pim-desktop:x:1000:", "pim-bridge:x:998:", "pim-session:x:996:pim-bridge", "pim-ingress:x:997:", ""].join("\n");
	const SHADOW = ["pim-bridge:!:19000::::::", "pim-ingress:!:19000::::::", ""].join("\n");

	it("takes the ingress account as the bridge's own kind: a system account of its own, no login, no home, a locked password, no group but its own", () => {
		assert.equal(checkAccounts(PASSWD, GROUP, SHADOW, true).ingress?.name, "pim-ingress");
		assert.equal(checkAccounts(PASSWD, GROUP, SHADOW, false).ingress, undefined);
		const refused = (passwd: string, group: string, shadow: string) => refusedWith(() => checkAccounts(passwd, group, shadow, true), "accounts");
		refused(PASSWD.replace("pim-ingress:x:997:997::/nonexistent:/usr/sbin/nologin", "pim-ingress:x:997:997::/nonexistent:/bin/bash"), GROUP, SHADOW);
		refused(PASSWD.replace("pim-ingress:x:997:997::/nonexistent", "pim-ingress:x:997:997::/home/x"), GROUP, SHADOW);
		refused(PASSWD.replace("pim-ingress:x:997:997", "pim-ingress:x:1500:997"), GROUP, SHADOW);
		refused(PASSWD, GROUP.replace("pim-session:x:996:pim-bridge", "pim-session:x:996:pim-bridge,pim-ingress"), SHADOW);
		refused(PASSWD, GROUP.replace("pim-ingress:x:997:", "pim-ingress:x:997:pim-bridge"), SHADOW);
		refused(PASSWD, GROUP, SHADOW.replace("pim-ingress:!:", "pim-ingress:$6$x:"));
		refused(PASSWD, GROUP, "pim-bridge:!:19000::::::\n");
		refused(PASSWD.replace("pim-ingress:x:997:997", "pim-ingress:x:998:997"), GROUP, SHADOW);
		refused(PASSWD.replace("pim-ingress:x:997:997", "pim-ingress:x:997:998"), GROUP, SHADOW);
		refused(PASSWD.replace(/pim-ingress.*\n/, ""), GROUP, SHADOW);
		refused(PASSWD, GROUP.replace("pim-desktop:x:1000:", "pim-desktop:x:1000:\nvideo:x:44:pim-desktop"), SHADOW);
	});

	it("checks four units with the viewer, as the accounts that run them, and two without", () => {
		const show = (overrides: Record<string, string> = {}) => (unit: string) => {
			const table: Record<string, [string, string]> = {
				"pim-cua-desktop.service": [PATHS.desktopUnit, "pim-desktop"],
				"pim-cua-bridge.service": [PATHS.bridgeUnit, "pim-bridge"],
				[VIEWER_UNITS.spacesd]: [VIEWER_PATHS.spacesdUnit, "pim-desktop"],
				[VIEWER_UNITS.ingress]: [VIEWER_PATHS.ingressUnit, "pim-ingress"],
			};
			const [file, user] = table[unit]!;
			return `FragmentPath=${overrides[`${unit}:FragmentPath`] ?? file}\nDropInPaths=${overrides[`${unit}:DropInPaths`] ?? ""}\nUser=${overrides[`${unit}:User`] ?? user}\nKillMode=process\n`;
		};
		checkUnits(show(), true);
		checkUnits(show(), false);
		refusedWith(() => checkUnits(show({ [`${VIEWER_UNITS.ingress}:User`]: "pim-bridge" }), true), "unit-check");
		refusedWith(() => checkUnits(show({ [`${VIEWER_UNITS.spacesd}:User`]: "root" }), true), "unit-check");
		refusedWith(() => checkUnits(show({ [`${VIEWER_UNITS.spacesd}:DropInPaths`]: "/etc/systemd/system/x.d/override.conf" }), true), "unit-check");
		// Without a viewer the extra units aren't asked about at all.
		checkUnits((unit) => (unit.includes("spacesd") || unit.includes("ingress") ? "garbage" : show()(unit)), false);
	});

	it("refuses a staged certificate that isn't for the backend's name", () => {
		refusedWith(() => checkBackendName(Buffer.from("not a certificate"), "pim-cua-bridge.internal"), "tls-name");
	});
});

describe("the ingress, the units spacesd and Caddy run under, and the base", () => {
	const cfg = config(true);

	it("serves exactly the public host, forwards only the relay's and the adapter's paths to the one private bridge, and verifies its certificate", () => {
		const text = renderCaddyfile(cfg);
		const lines = text.split("\n");
		assert.equal(text, renderCaddyfile(cfg), "the same text each time");
		// One site, the exact host; no other address, wildcard or port.
		const sites = lines.filter((line) => /^[^\s(#{][^\s]* \{$/.test(line));
		assert.deepEqual(sites, ["cua-eval.ajac-zero.com {"]);
		assert.ok(!text.includes("*") && !text.includes(":80") && !text.includes("http://") && !/\bhttps?:\/\/(?!127\.0\.0\.1)/.test(text.replace(/#.*$/gm, "")));
		// ACME HTTP-01 only, automatic; Caddy's admin API off.
		assert.ok(text.includes("\tadmin off\n") && text.includes("disable_tlsalpn_challenge") && !text.includes("disable_http_challenge"));
		assert.ok(text.includes("http_port 80\n") && text.includes("https_port 443\n"));
		// Only these paths go to the bridge; everything else is 404.
		assert.ok(text.includes("@bridge path /pim /pim/observations/launch /pim/observations/end /pim/observations/status"));
		const viewer = lines.find((line) => line.includes("@viewer path_regexp"))!;
		assert.equal(viewer, `\t@viewer path_regexp ^/${"[A-Za-z0-9_-]".repeat(22)}/.+$`);
		assert.ok(!viewer.includes("{"), "no braces: they are placeholders in a Caddyfile");
		assert.ok(text.includes("\thandle {\n\t\trespond 404\n\t}"));
		// One upstream, private, over TLS that is verified against the bridge's own certificate and name.
		assert.equal(lines.filter((line) => line.trim().startsWith("reverse_proxy")).length, 1);
		assert.ok(text.includes("reverse_proxy https://127.0.0.1:8443 {"));
		assert.ok(text.includes("\t\t\ttls_server_name pim-cua-bridge.internal\n"));
		assert.ok(text.includes(`\t\t\ttls_trust_pool file ${VIEWER_PATHS.bridgeTrust}\n`));
		for (const forbidden of ["insecure_skip_verify", "tls_insecure", "forward_proxy", "header_up", "trusted_proxies", "handle_path", "file_server", "header Access-Control", "Access-Control"]) {
			assert.equal(text.includes(forbidden), false, forbidden);
		}
		// A request's target and headers aren't logged: the access and proxy-error entries are excluded, and only warnings go out.
		assert.ok(text.includes("level WARN") && text.includes("exclude http.handlers.reverse_proxy http.log.access http.log.error"));
	});

	it("runs spacesd as the desktop account on loopback with no QUIC, MCP, driver or pointer probe, and Caddy as its own account with one capability", () => {
		const units = renderUnits(cfg, 1000);
		const exec = (text: string) => text.split("\n").find((line) => line.startsWith("ExecStart="))!;
		assert.equal(
			exec(units.spacesd!),
			"ExecStart=/opt/pim-spacesd/bin/cua-spacesd serve --listen 127.0.0.1:3211 --quic-port 0 --no-mcp --no-driver --cursor-probe false --token-file /etc/pim-spacesd/token --data-dir /var/lib/pim-spacesd",
		);
		assert.ok(units.spacesd!.includes("User=pim-desktop\nGroup=pim-desktop\n"));
		for (const forbidden of ["0.0.0.0", "--insecure-bootstrap", "--allow-guest-power", "--await-token-file", "Delegate", "OOMScoreAdjust", "User=root", "--token ", "CUA_ENV_TOKEN"]) {
			assert.equal(units.spacesd!.includes(forbidden), false, forbidden);
		}
		assert.ok(units.spacesd!.includes("Environment=DISPLAY=:0\n") && units.spacesd!.includes("Environment=XDG_RUNTIME_DIR=/run/user/1000\n"));
		assert.equal(exec(units.ingress!), "ExecStart=/opt/pim-caddy/bin/caddy run --config /etc/pim-ingress/Caddyfile --adapter caddyfile");
		assert.ok(units.ingress!.includes("User=pim-ingress\nGroup=pim-ingress\n"));
		assert.equal((units.ingress!.match(/Capabilit/g) ?? []).length, 2);
		assert.ok(units.ingress!.includes("AmbientCapabilities=CAP_NET_BIND_SERVICE\n") && units.ingress!.includes("CapabilityBoundingSet=CAP_NET_BIND_SERVICE\n"));
		// The bridge and the desktop's units carry no capability, and the bridge is private.
		assert.equal(/Capabilit/.test(units.bridge) || /Capabilit/.test(units.desktop), false);
		assert.ok(units.bridge.includes("--host 127.0.0.1 --port 8443"));
		// No secret in any unit or in the Caddyfile: they name files only.
		for (const text of [units.spacesd!, units.ingress!, units.bridge, renderCaddyfile(cfg)]) assert.equal(/[A-Za-z0-9_-]{43}/.test(text), false);
	});

	it("makes the base: the desktop account in no group, no sudo and no password, the X11 packages, lingering, and two units run as that account", () => {
		const text = renderBaseCloudConfig(cfg);
		assert.ok(text.startsWith("#cloud-config\n"));
		const data = JSON.parse(text.slice("#cloud-config\n".length));
		assert.deepEqual(data.users[0], "default");
		assert.deepEqual(data.users[1], { name: "pim-desktop", uid: BASE_DESKTOP_UID, homedir: "/home/pim-desktop", shell: "/bin/bash", lock_passwd: true, sudo: false });
		assert.ok(!("groups" in data.users[1]));
		assert.equal(data.disable_root, true);
		assert.equal(data.ssh_pwauth, false);
		for (const pkg of ["xvfb", "openbox", "dbus-user-session", "openssl", "curl", "libx11-6", "libxtst6", "libnss3", "libgtk-3-0t64", "libvulkan1"]) assert.ok(data.packages.includes(pkg), pkg);
		assert.deepEqual(data.runcmd[0], ["loginctl", "enable-linger", "pim-desktop"]);
		const units = Object.fromEntries(data.write_files.map((f: { path: string; content: string }) => [f.path, f.content]));
		const xvfb = units["/etc/systemd/system/pim-cua-xvfb.service"];
		assert.ok(xvfb.includes("User=pim-desktop") && xvfb.includes("ExecStart=/usr/bin/Xvfb :0 -screen 0 1920x1080x24 -nolisten tcp"));
		assert.ok(units["/etc/systemd/system/pim-cua-wm.service"].includes("ExecStart=/usr/bin/openbox"));
		assert.ok(xvfb.includes(`user@${BASE_DESKTOP_UID}.service`) && xvfb.includes(`XDG_RUNTIME_DIR=/run/user/${BASE_DESKTOP_UID}`));
		// It installs none of the pinned programs and holds no secret.
		for (const word of ["node", "chrome", "caddy", "spacesd", "token", "sha256"]) assert.equal(text.toLowerCase().includes(word), false, word);
		refusedWith(() => renderBaseCloudConfig(config(false)), "config-viewer");
	});
});

describe("spacesd's root token, made once", () => {
	const BRIDGE = { uid: 998, gid: 998 };
	const DESKTOP = { uid: 1500, gid: 1500 };
	const cfg = config(true);
	const bytes = (value: number) => (count: number) => Buffer.alloc(count, value);

	/** A VM as the installer leaves it: the bridge's own directory (0700) and spacesd's (root's). */
	function machine(): FakeFiles {
		const files = new FakeFiles();
		files.user = 0;
		files.directory(PATHS.bridgeDir, 0o700, BRIDGE.uid);
		files.directory(VIEWER_PATHS.spacesdDir, 0o755, 0);
		return files;
	}
	const failure = (run: () => void): ProvisionFailure => {
		try {
			run();
		} catch (error) {
			assert.ok(error instanceof ProvisionFailure, String(error));
			return error;
		}
		throw new Error("provisioning didn't fail");
	};

	it("is 32 random bytes as 43 characters, and nothing else", () => {
		const token = newRootToken(bytes(7));
		assert.match(token, /^[A-Za-z0-9_-]{43}$/);
		assert.equal(token, Buffer.alloc(32, 7).toString("base64url"));
		assert.equal(failure(() => newRootToken((count: number) => Buffer.alloc(count - 1, 7))).reason, "random");
	});

	it("writes the same token to the bridge's file and spacesd's own, each 0600 and its account's, flushed, in that order, and prints and logs none", () => {
		const files = machine();
		provisionRootToken(cfg, { bridge: BRIDGE, desktop: DESKTOP }, files, bytes(9));
		const token = Buffer.alloc(32, 9).toString("base64url");
		const bridgeCopy = files.nodes.get(VIEWER_PATHS.rootToken)!;
		const spacesdCopy = files.nodes.get(VIEWER_PATHS.spacesdToken)!;
		assert.deepEqual([bridgeCopy.kind, bridgeCopy.uid, bridgeCopy.mode, bridgeCopy.data.toString("utf8")], ["file", BRIDGE.uid, 0o600, `${token}\n`]);
		assert.deepEqual([spacesdCopy.kind, spacesdCopy.uid, spacesdCopy.mode, spacesdCopy.data.toString("utf8")], ["file", DESKTOP.uid, 0o600, `${token}\n`]);
		const order = files.log.filter((entry) => /^(fchown|fsync)/.test(entry));
		assert.deepEqual(order, [`fchown ${VIEWER_PATHS.rootToken}`, `fsync ${VIEWER_PATHS.rootToken}`, `fsync ${PATHS.bridgeDir}`, `fchown ${VIEWER_PATHS.spacesdToken}`, `fsync ${VIEWER_PATHS.spacesdToken}`, `fsync ${VIEWER_PATHS.spacesdDir}`]);
		assert.equal(files.log.some((entry) => entry.includes(token)), false, "the token is in no operation's record");
		assert.equal(files.log.some((entry) => /^(unlink|rename|mkdir|chown )/.test(entry)), false);
	});

	it("is refused when either file exists or a directory isn't as the installer left it, and changes nothing", () => {
		const made = machine();
		provisionRootToken(cfg, { bridge: BRIDGE, desktop: DESKTOP }, made, bytes(9));
		const snapshot = JSON.stringify([...made.nodes].map(([name, node]) => [name, node.uid, node.mode, node.data.toString("utf8")]));
		assert.deepEqual([failure(() => provisionRootToken(cfg, { bridge: BRIDGE, desktop: DESKTOP }, made, bytes(1))).reason], ["exists"]);
		assert.equal(JSON.stringify([...made.nodes].map(([name, node]) => [name, node.uid, node.mode, node.data.toString("utf8")])), snapshot);
		for (const prepare of [(f: FakeFiles) => f.file(VIEWER_PATHS.spacesdToken, "x"), (f: FakeFiles) => f.file(VIEWER_PATHS.rootToken, "x")]) {
			const files = machine();
			prepare(files);
			assert.equal(failure(() => provisionRootToken(cfg, { bridge: BRIDGE, desktop: DESKTOP }, files, bytes(1))).reason, "exists");
		}
		const open = machine();
		open.nodes.get(PATHS.bridgeDir)!.mode = 0o755;
		assert.equal(failure(() => provisionRootToken(cfg, { bridge: BRIDGE, desktop: DESKTOP }, open, bytes(1))).reason, "unsafe-parent");
		const another = machine();
		another.nodes.get(VIEWER_PATHS.spacesdDir)!.mode = 0o777;
		assert.equal(failure(() => provisionRootToken(cfg, { bridge: BRIDGE, desktop: DESKTOP }, another, bytes(1))).reason, "unsafe-parent");
		const user = machine();
		user.user = 1000;
		assert.equal(failure(() => provisionRootToken(cfg, { bridge: BRIDGE, desktop: DESKTOP }, user, bytes(1))).reason, "root-required");
		assert.equal(failure(() => provisionRootToken(config(false), { bridge: BRIDGE, desktop: DESKTOP }, machine(), bytes(1))).reason, "no-viewer");
	});

	it("stops at a failing step, undoes nothing, and a second try is refused", () => {
		const second = machine();
		const original = second.open.bind(second);
		second.open = (file: string, flags: number, mode?: number) => {
			if (file === VIEWER_PATHS.spacesdToken) throw Object.assign(new Error("EACCES"), { code: "EACCES" });
			return original(file, flags, mode);
		};
		const refused = failure(() => provisionRootToken(cfg, { bridge: BRIDGE, desktop: DESKTOP }, second, bytes(3)));
		assert.deepEqual([refused.step, refused.reason, refused.changed], ["spacesd-copy", "create", true]);
		assert.equal(second.nodes.has(VIEWER_PATHS.rootToken), true, "the first copy is left");
		assert.equal(second.log.some((entry) => entry.startsWith("unlink")), false);
		assert.equal(failure(() => provisionRootToken(cfg, { bridge: BRIDGE, desktop: DESKTOP }, second, bytes(3))).reason, "exists");
		for (const operation of ["fchown", "write", "fsync", "close"]) {
			const files = machine();
			files.failNext.add(operation);
			const error = failure(() => provisionRootToken(cfg, { bridge: BRIDGE, desktop: DESKTOP }, files, bytes(3)));
			assert.equal(error.step, "bridge-copy", operation);
			assert.equal(error.reason, operation === "close" ? "descriptor-retained" : "write", operation);
			assert.equal(files.nodes.has(VIEWER_PATHS.spacesdToken), false, operation);
		}
	});
});

describe("the rendered scripts with a viewer", () => {
	it("add five scripts, `bridge-cert.sh`, `journal.sh`, `root-token.sh`, `fetch.sh` and `support.sh`, and none without a viewer", () => {
		const plain = renderScripts(config(false));
		assert.deepEqual(Object.keys(plain), ["plan.sh", "install.sh", "seal.sh", "start.sh", "status.sh"]);
		const withViewer = renderScripts(config(true), PINNED);
		assert.deepEqual(Object.keys(withViewer), ["plan.sh", "install.sh", "seal.sh", "start.sh", "status.sh", "bridge-cert.sh", "journal.sh", "root-token.sh", "fetch.sh", "support.sh"]);
		for (const name of Object.keys(plain)) assert.equal(withViewer[name]!.replace(/\{"version":1.*\}/, ""), plain[name]!.replace(/\{"version":1.*\}/, ""), `${name} is unchanged but for its configuration`);
	});

	it("run only the bundle's provisioning program, each with its one command, after the pins are checked", () => {
		const scripts = renderScripts(config(true), PINNED);
		for (const [name, command] of [["journal.sh", "journal"], ["root-token.sh", "root-token"]] as const) {
			const script = scripts[name]!;
			assert.equal(script.match(/^exec .*/gm)?.length, 1, name);
			assert.ok(script.includes(`exec "$NODE" "$BUNDLE/${VIEWER_BUNDLE_FILES.provision}" ${command} <<'`), name);
			for (const check of ["fail root-required", "fail node-digest", "fail bundle-digest"]) assert.ok(script.indexOf(check) > 0 && script.indexOf(check) < script.indexOf("\nexec "), `${name}: ${check}`);
			for (const forbidden of ["set -x", "cat ", "eval ", "kill ", "curl ", "az ", "/dev/urandom"]) assert.equal(script.includes(forbidden), false, `${name}: ${forbidden}`);
			assert.ok(!script.includes(VIEWER_PATHS.rootToken) && !script.includes(VIEWER_PATHS.spacesdToken), name);
		}
	});

	it("make the bridge's own certificate on the VM, once, into a new 0700 staging directory, for the one name Caddy checks, so its key never travels", () => {
		const script = renderScripts(config(true), PINNED)["bridge-cert.sh"]!;
		assert.equal(script.match(/^exec .*/gm)?.length, 1);
		assert.ok(script.includes("mkdir -m 0700 -- '/var/lib/pim-cua-install'"));
		assert.ok(script.includes("[[ ! -e '/var/lib/pim-cua-install' && ! -L '/var/lib/pim-cua-install' ]] || fail staging-exists"));
		assert.ok(script.includes("exec /usr/bin/openssl req -x509 -newkey ec -pkeyopt ec_paramgen_curve:prime256v1 -nodes -days 3"));
		assert.ok(script.includes("-subj '/CN=pim-cua-bridge.internal' -addext 'subjectAltName=DNS:pim-cua-bridge.internal'"));
		assert.ok(script.includes("-keyout '/var/lib/pim-cua-install/key.pem' -out '/var/lib/pim-cua-install/cert.pem'"));
		assert.ok(script.includes("trusted_file /usr/bin/openssl || fail tools"));
		assert.ok(script.indexOf("fail bundle-digest") < script.indexOf("\nexec "));
		for (const forbidden of ["set -x", "cat ", "eval ", "curl ", "az ", "-days 3650"]) assert.equal(script.includes(forbidden), false, forbidden);
	});

	/** The umask a script runs its program under: the last `umask` line before its `exec`. */
	const effectiveUmask = (script: string) => {
		const lines = script.slice(0, script.indexOf("\nexec ")).split("\n").filter((line) => /^umask [0-7]{3}$/.test(line));
		return parseInt(lines[lines.length - 1]!.slice("umask ".length), 8);
	};

	it("runs `journal` under a umask that leaves the tombstone 0444, and the other scripts at 077, with the effective modes as the program asks", () => {
		const scripts = renderScripts(config(true), PINNED);
		assert.equal(effectiveUmask(scripts["journal.sh"]!), 0o022);
		for (const name of Object.keys(scripts).filter((n) => n !== "journal.sh")) assert.equal(effectiveUmask(scripts[name]!), 0o077, `${name} stays private`);
		const cfg = config(true);
		const BRIDGE = { uid: 998, gid: 998 };
		const journalMachine = (umask: number) => {
			const files = new FakeFiles();
			files.user = 0;
			files.umask = umask;
			files.directory("/etc/pim-eval", 0o755, 0);
			files.directory("/var/lib", 0o755, 0);
			return files;
		};
		const modes = (files: FakeFiles) => [VIEWER_PATHS.tombstone, VIEWER_PATHS.journalDir, VIEWER_PATHS.journal].map((file) => files.nodes.get(file)!.mode);
		// Under the umask the script sets: 0444 for the tombstone, 0700 for the directory, 0600 for the journal.
		const made = journalMachine(effectiveUmask(scripts["journal.sh"]!));
		provisionJournal(cfg, BRIDGE, made);
		assert.deepEqual(modes(made), [0o444, 0o700, 0o600]);
		// The control: under 077, which is what the script ran under, the tombstone was 0400. The journal and its directory were already private.
		const before = journalMachine(0o077);
		provisionJournal(cfg, BRIDGE, before);
		assert.deepEqual(modes(before), [0o400, 0o700, 0o600]);
		// The root token's two files, under its script's 077, are 0600 as before.
		const tokens = new FakeFiles();
		tokens.user = 0;
		tokens.umask = effectiveUmask(scripts["root-token.sh"]!);
		tokens.directory(PATHS.bridgeDir, 0o700, BRIDGE.uid);
		tokens.directory(VIEWER_PATHS.spacesdDir, 0o755, 0);
		provisionRootToken(cfg, { bridge: BRIDGE, desktop: { uid: 1500, gid: 1500 } }, tokens, (count) => Buffer.alloc(count, 9));
		assert.deepEqual([VIEWER_PATHS.rootToken, VIEWER_PATHS.spacesdToken].map((file) => tokens.nodes.get(file)!.mode), [0o600, 0o600]);
	});

	it("travel in cloud-init data, which writes them and runs none", () => {
		const data = renderCloudConfig(renderScripts(config(true), PINNED));
		for (const name of ["bridge-cert", "journal", "root-token", "fetch", "support"]) assert.ok(data.includes(`/usr/local/sbin/pim-cua-eval-${name}`), name);
		assert.equal(data.includes("runcmd"), false);
	});
});

/** Each place a script pipes into a shell interpreter, by command word: `| sh`, `|bash -s`, but not `| sha256sum`. */
const pipesToShell = (script: string) => [...script.matchAll(/\|\s*(?:\/(?:usr\/)?bin\/)?(?:sh|bash|dash|zsh)(?=\s|$|;|&|\))/gm)].map((m) => m[0]);
/** Each place a script runs `curl` or `wget` as a command word (after a line start, space, `;`, `&`, `|`, `(` or `/`), never as part of a package name such as `libcurl4t64` or a quoted package name in a list. */
const runsCurl = (script: string) => [...script.matchAll(/(?:^|[\s;&|(/])(?:curl|wget)(?=\s|$|;|&|\))/gm)].map((m) => m[0]);

/** Each process substitution feeding a loop (`< <(...)`), whose pipeline failure the parent's `set -e` and `pipefail` never see. */
const unobservedSubstitutions = (text: string) => [...text.matchAll(/<\s*<\(/g)].map((m) => m[0]);
/** The text of a bash function `name() {` up to its closing brace at the line start. */
const bashFunction = (script: string, name: string) => {
	const start = script.indexOf(`\n${name}() {`);
	const end = script.indexOf("\n}\n", start);
	return start < 0 || end < 0 ? "" : script.slice(start, end + 3);
};

/** The lines of a script that name one of the delivered programs (`$NODE`, `$CADDY`, `$SPACESD`, `$BROWSER`) to run it other than through `step`, `capture` or `libraries`, which bound it. */
const unboundedRuns = (script: string) =>
	script.split("\n").filter((line) => /"\$(?:NODE|CADDY|SPACESD|BROWSER|program)"/.test(line) && !/^(?:readonly |trusted_file |step |capture |libraries |\tlocal |\tLD_LIBRARY_PATH= capture |\telif |\tif |\t\tif )/.test(line) && !/^\[\[/.test(line));

describe("the test's own command detectors", () => {
	it("reject truly unsafe samples and accept the legitimate ones they once confused", () => {
		for (const unsafe of ["curl -s https://x | sh", "curl https://x |sh", "wget -qO- https://x | bash -s", "echo hi | /bin/sh", "cat f | /usr/bin/bash\n", "x | dash;"]) assert.equal(pipesToShell(unsafe).length, 1, unsafe);
		for (const safe of ["find . | sort | sha256sum", "x | sha512sum | cut -d' ' -f1", "printf '%s\\n' \"$listing\" | sha256sum", "x | shuf", "a || bash_function"]) assert.deepEqual(pipesToShell(safe), [], safe);
		for (const unsafe of ["curl -s https://x", "run && curl x", "x | curl -T- u", "/usr/bin/curl https://x", "$(curl u)", "trusted_file /usr/bin/curl || fail tools", "wget"]) assert.ok(runsCurl(unsafe).length > 0, unsafe);
		// The shape the review found: a listing through a process substitution, whose failure the loop does not report.
		const old = 'publish_tree() {\n\twhile IFS= read -r -d \'\' entry; do\n\t\tmkdir x\n\tdone < <(cd -- "$1" && find . -type d -printf \'%P\\0\' | sort -z)\n}\n';
		assert.equal(unobservedSubstitutions(old).length, 1);
		assert.deepEqual(unobservedSubstitutions("x=$(a); done <\"$file\" || fail"), []);
		assert.equal(bashFunction(`\nf() {\n  a\n}\n`, "f"), "\nf() {\n  a\n}\n");
		assert.equal(unboundedRuns('"$NODE" --version').length, 1);
		assert.equal(unboundedRuns('out="$("$SPACESD" --help)"').length, 1);
		assert.equal(unboundedRuns('timeout 5 "$CADDY" version').length, 1, "a bare timeout is not the script's own bounded wrapper");
		assert.deepEqual(unboundedRuns('capture 20 "$NODE" --version\nstep x 30 env "$CADDY" validate\nlibraries "$BROWSER"'), []);
		for (const safe of ["'libcurl4t64'", "for package in 'curl' 'wget'; do", "libcurl4t64 wget-not", "echo curlish", "mycurl x"]) assert.deepEqual(runsCurl(safe), [], safe);
	});
});

describe("the pinned delivery", () => {
	const inRepository = (file: string) => fs.readFileSync(path.join(REPOSITORY, file));

	it("pins the npm packages to the lockfile's own integrity and version, derived here from the repository, not from the pins", () => {
		const inputs = bundleInputs(inRepository, true);
		assert.equal(`sha512-${PINS.ws.sha512}`, inputs.wsIntegrity);
		assert.equal(`sha512-${PINS.protobuf.sha512}`, inputs.protobuf!.integrity);
		assert.ok(PINS.ws.url.endsWith(`/ws-${inputs.wsVersion}.tgz`));
		assert.ok(PINS.protobuf.url.endsWith(`/protobuf-${inputs.protobuf!.version}.tgz`));
		// The hex `sha512sum` prints is the same 64 bytes as the base64 integrity.
		assert.equal(integrityHex(PINS.ws.sha512), Buffer.from(PINS.ws.sha512, "base64").toString("hex"));
		assert.equal(integrityHex(PINS.ws.sha512).length, 128);
		refusedWith(() => integrityHex("AAAA"), "pin-integrity");
	});

	it("reads a bundle's inputs through any reader, the viewer's only when asked, and refuses a missing file as `source`", () => {
		const base = bundleInputs(inRepository, false);
		assert.equal(base.protobuf, undefined);
		assert.deepEqual([...base.sources.keys()], [...BUNDLE_SOURCES]);
		assert.deepEqual([...bundleInputs(inRepository, true).sources.keys()], [...BUNDLE_SOURCES, ...VIEWER_SOURCES]);
		refusedWith(() => bundleInputs((file) => (file === "pnpm-lock.yaml" ? Buffer.from("") : inRepository(file)), false), "ws-lock");
		refusedWith(() => bundleInputs((file) => { if (file === BUNDLE_SOURCES[3]) throw new Error("gone"); return inRepository(file); }, false), "source");
	});

	it("pins the bundle commit B and its archive, renders only for B, and refuses any empty or mismatched pin", () => {
		const B = "afc9371a75f1c21b3b22627222b9791ef283692d";
		assert.deepEqual(PINS.repository, { commit: B, sha256: "582716ed2cac76e546980d0e856160e45e6b5f64e2dfde0aa2b2173b3236aae8", maxBytes: 64 * 1024 * 1024 });
		assert.deepEqual(missingPins(PINS), []);
		assert.deepEqual(missingPins({ ...PINS, repository: { ...PINS.repository, commit: null, sha256: null } }), ["repository-commit", "repository-sha256"]);
		const fetch = renderScripts(config(true, (raw) => { raw.commit = B; }), PINS)["fetch.sh"]!;
		assert.ok(fetch.includes(`'https://codeload.github.com/ajac-zero/pim/tar.gz/${B}' 256 '582716ed2cac76e546980d0e856160e45e6b5f64e2dfde0aa2b2173b3236aae8'`));
		// A configuration for any other commit is refused: the pin is for B alone.
		refusedWith(() => renderScripts(config(true)), "pin-commit");
		refusedWith(() => renderScripts(config(true), { ...PINNED, repository: { ...PINNED.repository, sha256: null } }), "pin-missing:repository-sha256");
		refusedWith(() => renderScripts(config(true), { ...PINNED, repository: { ...PINNED.repository, commit: null } }), "pin-missing:repository-commit");
		refusedWith(() => renderScripts(config(true), { ...PINNED, repository: { ...PINNED.repository, commit: "f".repeat(40) } }), "pin-commit");
		refusedWith(() => renderScripts(config(true), { ...PINNED, spacesd: { ...PINNED.spacesd, sha256: "0".repeat(64) } }), "pin-mismatch");
		refusedWith(() => renderScripts(config(true), { ...PINNED, node: { ...PINNED.node, version: "v22.19.0" } }), "pin-mismatch");
		refusedWith(() => renderScripts(config(true), { ...PINNED, caddy: { ...PINNED.caddy, version: "v2.11.8" } }), "pin-mismatch");
		refusedWith(() => renderScripts(config(true), { ...PINNED, chrome: { ...PINNED.chrome, url: "http://dl.google.com/chrome.deb" } }), "pin-mismatch");
		refusedWith(() => renderScripts(config(true), { ...PINNED, caddy: { ...PINNED.caddy, sha256: "XYZ" } }), "pin-mismatch");
		// Without a viewer nothing is delivered, so the pins are not consulted.
		assert.equal(Object.keys(renderScripts(config(false))).includes("fetch.sh"), false);
	});


	it("refuses a layout `fetch.sh` cannot place: Node not at bin/node, Chrome not where its package puts it, a destination inside another", () => {
		const render = (change: (raw: Raw) => void) => renderScripts(config(true, change), PINNED);
		refusedWith(() => render((raw) => { raw.node.path = "/opt/pim-node/node"; }), "pin-layout");
		refusedWith(() => render((raw) => { raw.browser.path = "/opt/chrome/chrome"; }), "pin-layout");
		refusedWith(() => render((raw) => { raw.bundle.dir = "/opt/pim-node/bundle"; }), "pin-layout");
		assert.ok(render(() => {})["fetch.sh"]);
	});

	const fetchScript = () => renderScripts(config(true), PINNED)["fetch.sh"]!;

	it("fetches each pinned artifact once over HTTPS with no credential, retry or downgrade, and checks status, size and digest before any is unpacked", () => {
		const script = fetchScript();
		for (const [name, url] of [["node", PINS.node.url], ["caddy", PINS.caddy.url], ["spacesd", PINS.spacesd.url], ["chrome", PINS.chrome.url], ["ws", PINS.ws.url], ["protobuf", PINS.protobuf.url], ["repository", `https://codeload.github.com/ajac-zero/pim/tar.gz/${COMMIT}`]]) {
			assert.equal(script.split(`'${url}'`).length - 1, 1, name);
			assert.ok(script.includes(`download '${name}' `), name);
		}
		assert.equal(script.match(/^download '/gm)?.length, 7);
		assert.ok(script.includes(`'${PINS.spacesd.sha256}' ${PINS.spacesd.bytes} ${PINS.spacesd.maxBytes}`));
		assert.ok(script.includes(`'${integrityHex(PINS.ws.sha512)}'`));
		assert.ok(script.includes("curl -q --noproxy '*' --proto '=https' --proto-redir '=https' --tlsv1.2 --max-redirs 5 --fail"));
		assert.ok(script.includes("--retry 0"));
		for (const forbidden of ["-k ", "--insecure", "--cacert", "Authorization", "--header", "-H ", "--user", "-u ", "--netrc", "http://", "--retry-", "sudo", "ssh", "az ", "set -x", "eval "]) assert.equal(script.includes(forbidden), false, forbidden);
		assert.deepEqual(pipesToShell(script), [], "no output is piped into a shell");
		assert.deepEqual(runsCurl(script).length > 0, true, "fetch.sh does run curl, exactly where it downloads");
		for (const unpack of ["tar --extract", "dpkg-deb --extract", "install -m 0755"]) assert.ok(script.indexOf(unpack) > script.lastIndexOf("\ndownload '"), unpack);
		assert.ok(script.indexOf("status-$name") < script.indexOf("digest-$name"));
		assert.ok(script.includes('[[ "$status" == 200 ]] || fail "status-$name"'));
		assert.ok(script.includes('[[ "$sum" == "$hex" ]] || fail "digest-$name"'));
	});

	it("runs as root without verifying Node or the bundle it is about to bring, in a new 0700 stage it alone removes, never replacing a destination", () => {
		const script = fetchScript();
		assert.ok(script.includes("fail root-required"));
		assert.equal(script.includes("fail node-digest"), false);
		assert.equal(script.includes("fail bundle-ownership"), false);
		assert.ok(script.includes("readonly STAGE='/var/lib/pim-cua-fetch'"));
		assert.ok(script.includes("mkdir -m 0700 -- \"$STAGE\" || fail stage-exists"));
		assert.ok(script.indexOf("CREATED=1") > script.indexOf("fail stage-exists"));
		assert.ok(script.includes("rm -rf --one-file-system -- \"$STAGE\""));
		assert.ok(script.includes("trap 'cleanup $?' EXIT"));
		assert.equal(script.match(/rm -rf/g)?.length, 1);
		for (const [variable, name] of [["NODE_ROOT", "node"], ["CADDY", "caddy"], ["SPACESD", "spacesd"], ["CHROME_DIR", "chrome"], ["BUNDLE", "bundle"]]) {
			assert.ok(script.includes(`absent "$${variable}" ${name}`), name);
			assert.ok(script.indexOf(`absent "$${variable}" ${name}`) < script.indexOf("mkdir -m 0700 --"), name);
		}
		// Publication is by exclusive creation: a hard link (refused if the destination exists) and an exclusive mkdir. `mv` is nowhere: its rename replaces a file.
		assert.deepEqual(script.match(/^publish_(?:file|tree) "\$STAGE[^\n]*/gm), [
			'publish_tree "$STAGE/node" "$NODE_ROOT" node',
			'publish_file "$STAGE/caddy/caddy" "$CADDY" caddy',
			'publish_file "$STAGE/spacesd/spacesd" "$SPACESD" spacesd',
			'publish_tree "$STAGE/chrome$CHROME_DIR" "$CHROME_DIR" chrome',
			'publish_tree "$STAGE/bundle" "$BUNDLE" bundle',
		]);
		assert.ok(script.includes('ln -P -T -- "$1" "$2" || fail "place-$3"'));
		assert.ok(script.includes('mkdir -m 0755 -- "$2" || fail "place-$3"'));
		assert.equal(/\bmv\b|\bcp\b|rsync|ln -s|ln -f|--force/.test(script), false);
		// A failed run keeps what it placed and the stage: the stage is removed only by a run that did not fail while placing.
		assert.ok(script.includes('if [[ "$PLACING" == 1 && "$status" != 0 ]]; then'));
		assert.ok(script.includes('"reason":"partial-placement-kept"'));
		assert.ok(script.indexOf("\nPLACING=1\n") > script.indexOf("ensure_parent") && script.indexOf("\nPLACING=1\n") < script.indexOf("\npublish_tree \"$STAGE/node\""));
		assert.ok(script.includes("fail placed-programs") && script.includes("fail placed-bundle"));
		assert.ok(script.includes("readonly NODE_ROOT='/opt/pim-node'"));
		assert.ok(script.includes("readonly CHROME_DIR='/opt/google/chrome'"));
	});

	it("lists every tree into a file of the stage by a pipeline whose failure is seen, before anything is placed, and compares the placed tree whole against it", () => {
		const script = fetchScript();
		for (const name of ["list_tree", "prepare_tree", "publish_tree"]) {
			const body = bashFunction(script, name);
			assert.ok(body.length > 0, name);
			assert.deepEqual(unobservedSubstitutions(body), [], `${name}: no process substitution`);
		}
		const list = bashFunction(script, "list_tree");
		// The pipeline's own status is the subshell's (pipefail is set in the prologue), and the subshell's is the function's.
		assert.ok(script.includes("set -euo pipefail"));
		// The template's escapes: the script holds the two characters backslash and 0 for find's NUL, never a NUL itself, and no printf format is broken by a real newline.
		for (const rendered of [script, renderScripts(config(true), PINNED)["support.sh"]!]) assert.equal(rendered.includes("\0"), false);
		assert.equal(list.match(/-printf '%P\\0'/g)?.length, 2);
		assert.equal(/printf '[^']*\n[^']*'/.test(script), false);
		assert.equal(list.match(/\| LC_ALL=C sort -z >"\$3" \) \|\| return 1/g)?.length, 2);
		assert.ok(list.includes("(( size <= 16777216 )) || return 1"));
		// The loops read a regular file of the stage and fail if it can't be read.
		const publish = bashFunction(script, "publish_tree");
		assert.equal(publish.match(/done <"\$STAGE\/m\/\$3\.(?:dirs|files)" \|\| fail "place-\$3"/g)?.length, 2);
		assert.ok(publish.includes('cmp -s -- "$STAGE/m/$3.dirs" "$STAGE/m/$3.placed.dirs" && cmp -s -- "$STAGE/m/$3.files" "$STAGE/m/$3.placed.files" || fail "placed-$3"'));
		// All three listings are made and checked before the first placement.
		const first = script.indexOf("\nPLACING=1\n");
		for (const tree of ['prepare_tree "$STAGE/node" node', 'prepare_tree "$STAGE/chrome$CHROME_DIR" chrome', 'prepare_tree "$STAGE/bundle" bundle']) {
			assert.ok(script.includes(tree), tree);
			assert.ok(script.indexOf(tree) < first, tree);
		}
		assert.ok(script.includes('mkdir -m 0700 -- "$STAGE/m" '));
		assert.ok(script.includes("trusted_file /usr/bin/cmp"));
	});

	// The staged tree's rule for links, as a model the script's text is then asserted to implement. The model runs no process and touches no file.
	const MODEL_ROOT = "/var/lib/pim-cua-fetch/node";
	/** The lexical half of the script's rule for a link at `link` (relative to the tree) with `target`: not empty, not absolute, and resolving to a place strictly inside the tree. */
	const linkInside = (link: string, target: string, root = MODEL_ROOT) => {
		if (target === "" || target.startsWith("/")) return false;
		return path.posix.normalize(path.posix.join(root, path.posix.dirname(link), target)).startsWith(`${root}/`);
	};
	/** Whether the script's mode test (`! -type l \( -perm /022 -o -perm /6000 \)`) would flag an entry: links are never judged by their own bits. */
	const modeFlagged = (kind: "file" | "dir" | "link", mode: number) => kind !== "link" && ((mode & 0o022) !== 0 || (mode & 0o6000) !== 0);

	it("accepts the Node archive's three links, which are 0777 and point inside the tree, and refuses a link that leaves it, is absolute, empty or dangling-by-escape", () => {
		for (const [link, target] of [["bin/npm", "../lib/node_modules/npm/bin/npm-cli.js"], ["bin/npx", "../lib/node_modules/npm/bin/npx-cli.js"], ["bin/corepack", "../lib/node_modules/corepack/dist/corepack.js"], ["lib/a/b", "../c/d"], ["bin/x", "../lib/../lib/y"]] as const) assert.equal(linkInside(link, target), true, `${link} -> ${target}`);
		for (const [link, target] of [["bin/npm", "/etc/shadow"], ["bin/npm", "../../etc/passwd"], ["bin/npm", "../../../../../etc/passwd"], ["bin/npm", ""], ["bin/npm", ".."], ["bin/npm", "../../node-evil/x"], ["lib/a/b", "../../../outside"], ["bin/npm", "../lib/../../x"], ["top", "../node2/x"]] as const) assert.equal(linkInside(link, target), false, `${link} -> ${target}`);
		// A sibling whose name starts with the root's is not inside it.
		assert.equal(linkInside("bin/npm", "../../node2/x"), false);
		// A link to a directory inside the tree is fine.
		assert.equal(linkInside("bin/npm", "."), true);
	});

	it("judges a link by its target and everything else by its mode: 0777 on a link is normal, 0666 on a file or 0775 on a directory or a setuid bit is not", () => {
		assert.equal(modeFlagged("link", 0o777), false);
		assert.equal(modeFlagged("link", 0o4777), false);
		for (const [kind, mode] of [["file", 0o666], ["file", 0o664], ["file", 0o646], ["dir", 0o775], ["dir", 0o757], ["file", 0o4755], ["file", 0o2755], ["dir", 0o2755], ["file", 0o4000]] as const) assert.equal(modeFlagged(kind, mode), true, `${kind} ${mode.toString(8)}`);
		for (const [kind, mode] of [["file", 0o755], ["file", 0o644], ["file", 0o600], ["dir", 0o755], ["dir", 0o700], ["file", 0o555]] as const) assert.equal(modeFlagged(kind, mode), false, `${kind} ${mode.toString(8)}`);
	});

	it("implements that in `staged_ok`: ownership for every entry, modes only for non-links, each link checked lexically and as resolved, every failure naming its entry", () => {
		const script = fetchScript();
		const body = bashFunction(script, "staged_ok");
		assert.ok(body.length > 0);
		// The old test, which flagged a link's 0777, is gone; the ownership test covers links too (find does not follow them).
		assert.equal(script.includes("\\( ! -uid 0 -o -perm /022"), false);
		assert.ok(body.includes('find "$root" ! -uid 0 -print -quit'));
		assert.ok(body.includes('find "$root" ! -type l \\( -perm /022 -o -perm /6000 \\) -print -quit'));
		// The links are listed into a file of the stage, so a failing find is seen, and no process substitution is used.
		assert.ok(body.includes('find "$root" -type l -print0 >"$STAGE/m/links" || fail stage-link'));
		assert.ok(body.includes('done <"$STAGE/m/links" || fail stage-link'));
		assert.deepEqual(unobservedSubstitutions(body), []);
		// Relative, non-empty, inside lexically, and inside as the filesystem resolves it (a dangling link fails).
		assert.ok(body.includes('[[ -n "$target" && "$target" != /* ]] || fail_path stage-link "$entry"'));
		assert.ok(body.includes('[[ "$(realpath -m -s -- "$(dirname -- "$entry")/$target")" == "$root"/* ]] || fail_path stage-link "$entry"'));
		assert.ok(body.includes('[[ "$(realpath -e -- "$entry")" == "$real"/* ]] || fail_path stage-link "$entry"'));
		assert.ok(bashFunction(script, "prepare_tree").includes('fail_path "manifest-$2" "$name"'), "an entry name outside the plain set is named in the failure");
		assert.ok(body.includes('fail_path stage-ownership "$entry"') && body.includes('fail_path stage-mode "$entry"'));
		// The diagnostic is the entry's name under the stage, with any odd character shown as ?, cut at 200, and nothing else.
		const named = bashFunction(script, "fail_path");
		assert.ok(named.includes(`tr -c 'A-Za-z0-9._/@+-' '?'`));
		assert.ok(named.includes('"path":"%s"') && named.includes("${shown:0:200}"));
		assert.deepEqual(unobservedSubstitutions(named), []);
		for (const tool of ["readlink", "realpath", "tr"]) assert.ok(script.includes(`trusted_file /usr/bin/${tool} || fail tools`), tool);
		// Still run on the same five staged trees, before anything is placed.
		for (const tree of ['"$STAGE/node" "$STAGE/caddy" "$STAGE/chrome$CHROME_DIR" "$STAGE/spacesd"', '"$STAGE/bundle"']) {
			assert.ok(script.includes(`\nstaged_ok ${tree}\n`), tree);
			assert.ok(script.indexOf(`\nstaged_ok ${tree}\n`) < script.indexOf("\nPLACING=1\n"), tree);
		}
	});

	it("checks each unpacked program against the configured digest, then builds the bundle with the staged Node and checks its tree digest, before any move", () => {
		const script = fetchScript();
		const moves = script.indexOf("\nPLACING=1\n");
		for (const check of ["fail digest-node-program", "fail digest-caddy-program", "fail digest-chrome-program", "fail digest-spacesd-program", "fail bundle-build", "fail bundle-digest", "staged_ok \"$STAGE/bundle\""]) {
			assert.ok(script.includes(check), check);
			assert.ok(script.indexOf(check) < moves, check);
		}
		assert.ok(script.includes("readonly CADDY_SHA256='" + "e".repeat(64) + "'"));
		assert.ok(script.includes("readonly CHROME_SHA256='" + "d".repeat(64) + "'"));
		assert.ok(script.includes(`readonly SPACESD_SHA256='${SPACESD_SHA256}'`));
		assert.ok(script.includes('"$STAGE/node/bin/node" "$STAGE/src/computer/cua-host/eval-install/operator.ts" bundle --commit "$COMMIT" --source-dir "$STAGE/src"'));
		assert.ok(script.includes("--no-same-owner"));
		assert.ok(script.includes('chmod 0755 -- "$STAGE/chrome$CHROME_DIR/chrome-sandbox"'));
	});

	it("is the program of the operator a VM can run: neither it nor the files it imports reach `ws` or the bridge", () => {
		const importsOf = (file: string) => [...fs.readFileSync(path.join(REPOSITORY, file), "utf8").matchAll(/^import .* from "([^"]+)"/gm)].map((m) => m[1]!);
		assert.deepEqual(importsOf("computer/cua-host/origin.ts"), ["node:net"]);
		for (const file of ["computer/cua-host/eval-install/config.ts", "computer/cua-host/eval-install/operator.ts", "computer/cua-host/eval-install/pins.ts", "computer/cua-host/eval-install/recover.ts", "computer/cua-host/eval-install/install.ts"]) for (const specifier of importsOf(file)) assert.ok(specifier.startsWith("node:") || /^\.\/(config|pins|recover|install)\.ts$|^\.\.\/origin\.ts$/.test(specifier), `${file}: ${specifier}`);
		assert.ok(BUNDLE_SOURCES.includes("computer/cua-host/origin.ts"));
		for (const value of ["https://*.example.com", "https://example.com:443", "https://example.com/", "https://user@example.com", "https://EXAMPLE.com", ""]) assert.equal(isHttpsOrigin(value), false, value);
		assert.equal(isHttpsOrigin("https://cua-eval.ajac-zero.com"), true);
	});

	it("checks, before `start`, the packages, libraries, versions, `caddy validate`, spacesd and a sandboxed headless Chrome, each program bounded, and ends at the first failure", () => {
		const script = renderScripts(config(true), PINNED)["support.sh"]!;
		assert.ok(script.includes("fail node-digest") && script.indexOf("fail node-digest") < script.indexOf("trap 'cleanup $?' EXIT"));
		for (const package_ of ["libnss3", "libgtk-3-0t64", "libatspi2.0-0t64", "xvfb", "xdg-utils"]) assert.ok(script.includes(`'${package_}'`), package_);
		assert.ok(script.includes("dpkg-query -W -f='${db:Status-Status}'"));
		assert.ok(script.includes('step caddy-validate 30 /usr/sbin/runuser -u pim-ingress -- env -i PATH=/usr/bin:/bin XDG_DATA_HOME=/var/lib/pim-ingress XDG_CONFIG_HOME=/var/lib/pim-ingress "$CADDY" validate --config /etc/pim-ingress/Caddyfile --adapter caddyfile'));
		assert.ok(script.includes("step spacesd-runs 20 /usr/sbin/runuser -u pim-desktop"));
		assert.ok(script.includes('"$BROWSER" --headless=new --disable-gpu --user-data-dir="$TEMP/profile" --dump-dom about:blank'));
		assert.ok(script.includes("capture 60 /usr/sbin/runuser -u pim-desktop"));
		assert.equal(script.includes("no-sandbox"), false);
		assert.equal(script.match(/rm -rf/g)?.length, 1);
		for (const forbidden of ["systemctl", "sudo", "set -x", "eval ", "--no-sandbox", "docker"]) assert.equal(script.includes(forbidden), false, forbidden);
		assert.deepEqual(runsCurl(script), [], "support.sh runs no curl; the package libcurl4t64 is a name, not a command");
		assert.deepEqual(pipesToShell(script), []);
	});

	it("runs `caddy version` and `caddy validate` in the same unprivileged environment as the ingress unit, with stderr still captured and the version exact", () => {
		const script = renderScripts(config(true), PINNED)["support.sh"]!;
		const env = "env -i PATH=/usr/bin:/bin XDG_DATA_HOME=/var/lib/pim-ingress XDG_CONFIG_HOME=/var/lib/pim-ingress";
		const version = script.split("\n").filter((l) => l.includes('"$CADDY" version'));
		const validate = script.split("\n").filter((l) => l.includes('"$CADDY" validate'));
		assert.deepEqual(version, [`capture 20 /usr/sbin/runuser -u pim-ingress -- ${env} "$CADDY" version || bad caddy-version`]);
		assert.equal(validate.length, 1);
		assert.ok(validate[0]!.includes(`-u pim-ingress -- ${env} "$CADDY" validate`));
		// The environment is the ingress unit's own: the same two variables, the same directory, and no HOME.
		const unit = renderUnits(config(true), BASE_DESKTOP_UID).ingress!;
		assert.ok(unit.includes("Environment=XDG_DATA_HOME=/var/lib/pim-ingress") && unit.includes("Environment=XDG_CONFIG_HOME=/var/lib/pim-ingress"));
		for (const line of [...version, ...validate]) assert.equal(line.replace(/XDG_(?:DATA|CONFIG)_HOME=/g, "").includes("HOME="), false, "no HOME is set for Caddy");
		// Not solved by dropping the warning or by changing who runs it or how the output is read.
		const capture = bashFunction(script, "capture");
		assert.ok(capture.includes('OUT="$(timeout --kill-after=5 "$limit" "$@" 2>&1)"'), "stderr is still captured with stdout");
		assert.ok(script.includes('[[ "$OUT" == "$CADDY_VERSION "* ]] && ok caddy-version || bad caddy-version'));
		assert.equal(/\bcaddy\b[^\n]*2>\s*\/dev\/null/.test(script) || /"\$CADDY" version[^\n]*2>/.test(script), false);
		for (const line of [...version, ...validate]) assert.ok(line.includes("-u pim-ingress --"), "unprivileged, as the ingress account");
		// Both are still bounded.
		assert.deepEqual(unboundedRuns(script), []);
	});

	it("is fail-fast: the first failed check exits, nothing aggregates, and a cleanup failure is reported beside the original status", () => {
		const script = renderScripts(config(true), PINNED)["support.sh"]!;
		assert.equal(script.includes("FAILED"), false);
		assert.ok(script.includes(`bad() { printf '{"event":"pim-cua-eval.support","check":"%s","result":"fail"}\\n' "$1" >&2; exit 1; }`));
		assert.ok(script.includes("trap 'cleanup $?' EXIT"));
		const cleanup = bashFunction(script, "cleanup");
		assert.ok(cleanup.includes('"check":"cleanup","result":"fail"}'));
		assert.ok(cleanup.includes('[[ "$status" != 0 ]] || status=1'), "a failed removal raises a zero status and never lowers the original one");
		assert.ok(cleanup.includes('exit "$status"'));
		// `bad` is never reached from a subshell, whose exit would not end the script.
		assert.equal(/\$\([^)]*\bbad\b/.test(script), false);
		assert.equal(/\|\|\s*true\b/.test(script), false, "no failure is discarded");
	});

	it("bounds every program it runs, and classifies ldd narrowly", () => {
		const script = renderScripts(config(true), PINNED)["support.sh"]!;
		assert.deepEqual(unboundedRuns(script), []);
		assert.ok(bashFunction(script, "step").includes('timeout --kill-after=5 "$limit" "$@"'));
		assert.ok(bashFunction(script, "capture").includes('timeout --kill-after=5 "$limit" "$@"'));
		for (const line of script.split("\n").filter((l) => /^(step|capture) /.test(l))) assert.match(line, /^(step \S+|capture) \d+ /, line);
		const libraries = bashFunction(script, "libraries");
		// Only a zero status with no "not found" passes; the one other thing accepted is Caddy's exact static output with status 1; anything else fails.
		assert.ok(libraries.includes('LD_LIBRARY_PATH= capture 20 ldd -- "$program" || status=$?'));
		assert.ok(libraries.includes('if grep -q \'not found\' <<<"$OUT"; then bad "$name"; fi'));
		assert.ok(libraries.includes('elif [[ "$program" == "$CADDY" && "$status" == 1 && "$OUT" =~ $static ]]; then'));
		assert.ok(libraries.includes("static='^[[:space:]]*not a dynamic executable[[:space:]]*$'"));
		assert.ok(libraries.includes("\telse\n\t\tbad \"$name\"\n\tfi"));
		for (const program of ["NODE", "CADDY", "SPACESD", "BROWSER"]) assert.ok(script.includes(`libraries "$${program}"`), program);
		assert.ok(script.includes('[[ "$OUT" == "$NODE_VERSION" ]] && ok node-version || bad node-version'));
	});
});

describe("the recovery of a retained VM whose first bundle lacked two files", () => {
	const OLD_DIR = "/opt/pim-cua/bundle";
	const NEW_DIR = "/opt/pim-cua/bundle-2";
	const NEW_SHA = "f".repeat(64);
	const DESKTOP_UID = 1000;
	const PASSWD = ["root:x:0:0:root:/root:/bin/bash", "pim-bridge:x:998:998::/nonexistent:/usr/sbin/nologin", `pim-desktop:x:${DESKTOP_UID}:${DESKTOP_UID}::/home/pim-desktop:/bin/bash`, ""].join("\n");
	const oldConfig = config(true);
	const newConfig = config(true, (raw) => {
		raw.bundle = { dir: NEW_DIR, sha256: NEW_SHA };
	});
	const installed = renderUnits(oldConfig, DESKTOP_UID).desktop;
	const next = renderUnits(newConfig, DESKTOP_UID).desktop;
	const MISSING_LOG = [`Error [ERR_MODULE_NOT_FOUND]: Cannot find module '${OLD_DIR}/computer/native-outcome.ts' imported from ${OLD_DIR}/computer/cua-host/desktop.ts`, "    at finalizeResolution (node:internal/modules/esm/resolve:275:11)", "Node.js v22.18.0", ""].join("\n");

	/** `systemctl show` for a unit: by default one that is loaded and has never run. */
	const show = (change: Record<string, string> = {}) => ({
		status: 0,
		stdout: `${Object.entries({ LoadState: "loaded", ActiveState: "inactive", SubState: "dead", Result: "success", ExecMainPID: "0", ExecMainCode: "0", ExecMainStatus: "0", ExecMainStartTimestampMonotonic: "0", ExecMainExitTimestampMonotonic: "0", ...change })
			.map(([name, value]) => `${name}=${value}`)
			.join("\n")}\n`,
	});
	const RUNNING = { ActiveState: "active", SubState: "running", ExecMainPID: "4100", ExecMainCode: "0", ExecMainStartTimestampMonotonic: "100" };
	/** What the incident left: failed, exited with status 1, 400 ms after it started. */
	const FAILED = { ActiveState: "failed", SubState: "failed", Result: "exit-code", ExecMainPID: "4200", ExecMainCode: "1", ExecMainStatus: "1", ExecMainStartTimestampMonotonic: "100000000", ExecMainExitTimestampMonotonic: "100400000" };

	const bundleFiles = (extra: Record<string, string> = {}) => ({ BUNDLE: "m", "computer/pim-computer.ts": "a".repeat(64), "computer/cua-host/desktop.ts": "b".repeat(64), ...extra });
	const ADDED = Object.fromEntries(RECOVERY_ADDED.map((file, i) => [file, String(i + 1).repeat(64)]));

	type Setup = {
		units?: Record<string, ReturnType<typeof show>>;
		files?: Record<string, ReturnType<typeof factFile>>;
		unitText?: string | null;
		cgroup?: { status: number; stdout: string };
		cgroupProcs?: string | null;
		journal?: { status: number | null; stdout: string };
		digests?: Record<string, Record<string, string> | null>;
	};
	const factFile = (kind: "file" | "dir" | "socket", uid = 0, mode = 0o644) => ({ kind, uid, gid: uid, mode }) as NonNullable<PathFact>;

	/** A VM as the incident left it, with `change` making it differ. */
	function vm(change: (setup: Required<Setup>) => void = () => {}) {
		const setup: Required<Setup> = {
			units: { [UNITS.desktop]: show(FAILED), [UNITS.bridge]: show(RUNNING), [VIEWER_UNITS.spacesd]: show(RUNNING), [VIEWER_UNITS.ingress]: show(RUNNING) },
			files: { [PATHS.desktopUnit]: factFile("file") },
			unitText: installed,
			cgroup: { status: 0, stdout: "MainPID=0\nControlGroup=/system.slice/pim-cua-desktop.service\n" },
			cgroupProcs: "",
			journal: { status: 0, stdout: MISSING_LOG },
			digests: { [OLD_DIR]: bundleFiles(), [NEW_DIR]: bundleFiles({ BUNDLE: "n", ...ADDED }) },
		};
		change(setup);
		const queries: string[][] = [];
		const probe: RecoveryProbe = {
			lstat: (file) => setup.files[file] ?? null,
			readText: (file) => (file === "/etc/passwd" ? PASSWD : file === PATHS.desktopUnit ? setup.unitText : file === "/sys/fs/cgroup/system.slice/pim-cua-desktop.service/cgroup.procs" ? setup.cgroupProcs : null),
			query: (argv) => {
				queries.push([...argv]);
				if (argv[1] === "show" && argv[2]!.startsWith("--property=MainPID")) return setup.cgroup;
				if (argv[1] === "show") return setup.units[argv[argv.length - 1]!] ?? { status: 1, stdout: "" };
				if (argv[0] === "/usr/bin/journalctl") return setup.journal;
				return { status: 1, stdout: "" };
			},
			digests: (dir) => setup.digests[dir] ?? null,
		};
		const log: string[] = [];
		const written: { file: string; text: string; mode: number; uid: number; gid: number }[] = [];
		const fail = new Set<string>();
		const host: RecoveryHost = {
			writeNew(file, bytes, mode, uid, gid) {
				log.push(`write ${file}`);
				if (fail.has("write")) throw new Error("EIO");
				written.push({ file, text: bytes.toString("utf8"), mode, uid, gid });
			},
			linkNew(existing, created) {
				log.push(`link ${existing} ${created}`);
				if (fail.has("link")) throw new Error("EEXIST");
			},
			renameOver(from, to) {
				log.push(`rename ${from} ${to}`);
				if (fail.has("rename")) throw new Error("EIO");
			},
			run(argv) {
				log.push(`run ${argv.slice(1).join(" ")}`);
				if (fail.has(argv[1]!)) throw new Error("exit 1");
			},
			query: (argv) => {
				log.push(`query ${argv.slice(1).join(" ")}`);
				const unit = argv[argv.length - 1]!;
				const file = { [UNITS.desktop]: PATHS.desktopUnit, [UNITS.bridge]: PATHS.bridgeUnit, [VIEWER_UNITS.spacesd]: VIEWER_PATHS.spacesdUnit, [VIEWER_UNITS.ingress]: VIEWER_PATHS.ingressUnit }[unit]!;
				const user = unit === VIEWER_UNITS.ingress ? "pim-ingress" : unit === UNITS.bridge ? "pim-bridge" : "pim-desktop";
				return { status: 0, stdout: `FragmentPath=${file}\nDropInPaths=\nUser=${user}\nKillMode=process\n` };
			},
		};
		return { probe, host, log, written, fail, queries };
	}
	const refusal = (change: (setup: Required<Setup>) => void) => {
		const v = vm(change);
		try {
			recoverDesktop(newConfig, v.probe, v.host);
		} catch (error) {
			assert.deepEqual(v.log, [], "nothing was changed or even asked of the host");
			return (error as { reason?: string }).reason;
		}
		return "recovered";
	};

	it("rewrites only the desktop unit, to the new bundle, keeps the old unit beside it, reloads and starts the desktop endpoint once, and touches nothing else", () => {
		assert.notEqual(installed, next);
		assert.equal(installed.split(OLD_DIR).join(NEW_DIR), next, "the two units differ in the bundle's directory and nowhere else");
		const v = vm();
		const done = recoverDesktop(newConfig, v.probe, v.host);
		const superseded = `${PATHS.desktopUnit}.superseded-${crypto.createHash("sha256").update(installed).digest("hex").slice(0, 12)}`;
		const staged = `${PATHS.desktopUnit}.next-${NEW_SHA.slice(0, 12)}`;
		assert.deepEqual(v.written, [{ file: staged, text: next, mode: 0o644, uid: 0, gid: 0 }]);
		// In this order, and only these: the new unit made exclusively, the old one kept by a new name, the new one moved over it, then systemd.
		assert.deepEqual(
			v.log.filter((entry) => !entry.startsWith("query")),
			[`write ${staged}`, `link ${PATHS.desktopUnit} ${superseded}`, `rename ${staged} ${PATHS.desktopUnit}`, "run daemon-reload", `run start ${UNITS.desktop}`],
		);
		// The bridge, spacesd and the ingress are asked nothing but their unit's facts (a `show`), never started, stopped or reloaded one by one.
		assert.equal(v.log.some((entry) => /run (start|stop|restart|reset-failed|kill)/.test(entry) && !entry.includes(UNITS.desktop)), false);
		assert.deepEqual(done, { bundle: NEW_DIR, previousBundle: OLD_DIR, supersededUnit: superseded, desktop: { active: "failed", sub: "failed" } });
	});

	it("is not the start gate: `start` still refuses what this accepts, and the state it accepts is exactly the incident's", () => {
		assert.equal(cleanlyStopped(unitState(() => show(FAILED), UNITS.desktop)), false, "install.ts's gate still refuses a desktop that exited 1, so `start.sh` can't restart it");
		// A desktop that ended cleanly (inactive, exit 0) is `start`'s business, and this path refuses it.
		const clean = { ExecMainPID: "4300", ExecMainCode: "1", ExecMainStatus: "0", ExecMainStartTimestampMonotonic: "100", ExecMainExitTimestampMonotonic: "200" };
		assert.equal(cleanlyStopped(unitState(() => show(clean), UNITS.desktop)), true);
		assert.equal(refusal((s) => (s.units[UNITS.desktop] = show(clean))), "desktop-state");
	});

	it("refuses unless the desktop endpoint failed by exiting 1, quickly, with nothing of its cgroup running and no socket", () => {
		assert.equal(refusal((s) => (s.units[UNITS.desktop] = show(RUNNING))), "desktop-state", "running is left alone");
		assert.equal(refusal((s) => (s.units[UNITS.desktop] = show())), "desktop-state", "never started");
		assert.equal(refusal((s) => (s.units[UNITS.desktop] = show({ ...FAILED, Result: "signal", ExecMainCode: "2", ExecMainStatus: "15" }))), "desktop-state", "killed by a signal");
		assert.equal(refusal((s) => (s.units[UNITS.desktop] = show({ ...FAILED, ExecMainStatus: "2" }))), "desktop-exit", "exit status 2 is not this failure");
		assert.equal(refusal((s) => (s.units[UNITS.desktop] = show({ ...FAILED, ExecMainStatus: "0" }))), "desktop-exit");
		assert.equal(refusal((s) => (s.units[UNITS.desktop] = show({ ...FAILED, ExecMainPID: "0" }))), "desktop-exit");
		assert.equal(refusal((s) => (s.units[UNITS.desktop] = show({ ...FAILED, ExecMainExitTimestampMonotonic: String(100000000n + RECOVERY_MAX_RUN_US + 1n) }))), "desktop-exit", "one microsecond past the bound");
		assert.equal(refusal((s) => (s.units[UNITS.desktop] = show({ ...FAILED, ExecMainExitTimestampMonotonic: String(100000000n + RECOVERY_MAX_RUN_US) }))), "recovered", "at the bound");
		assert.equal(refusal((s) => (s.units[UNITS.desktop] = show({ ...FAILED, ExecMainExitTimestampMonotonic: "99999999" }))), "desktop-exit", "exited before it started");
		assert.equal(refusal((s) => (s.units[UNITS.desktop] = { status: 1, stdout: "" })), "desktop-state");
		assert.equal(refusal((s) => (s.cgroupProcs = "4301\n")), "desktop-processes", "a process still in the cgroup");
		assert.equal(refusal((s) => (s.cgroup = { status: 0, stdout: "MainPID=4200\nControlGroup=/system.slice/pim-cua-desktop.service\n" })), "desktop-processes");
		assert.equal(refusal((s) => (s.cgroup = { status: 0, stdout: "MainPID=0\nControlGroup=/system.slice/../../etc\n" })), "desktop-processes");
		assert.equal(refusal((s) => (s.cgroup = { status: 1, stdout: "" })), "desktop-processes");
		assert.equal(refusal((s) => (s.cgroup = { status: 0, stdout: "MainPID=0\nControlGroup=\n" })), "recovered", "no cgroup at all is nothing running");
		assert.equal(refusal((s) => (s.cgroupProcs = null)), "recovered", "an unreadable member list is fine only when the cgroup is gone");
		assert.equal(refusal((s) => { s.cgroupProcs = null; s.files["/sys/fs/cgroup/system.slice/pim-cua-desktop.service"] = factFile("dir"); }), "desktop-processes", "a cgroup that is there but unreadable is not proof");
		assert.equal(refusal((s) => (s.files[PATHS.socket] = factFile("socket", DESKTOP_UID, 0o660))), "socket-present");
	});

	it("refuses unless its own journal says Node couldn't load one of the two files and the endpoint never spoke", () => {
		assert.equal(refusal((s) => (s.journal = { status: 0, stdout: "" })), "failure-not-recognized");
		assert.equal(refusal((s) => (s.journal = { status: 1, stdout: MISSING_LOG })), "failure-not-recognized");
		assert.equal(refusal((s) => (s.journal = { status: null, stdout: "" })), "failure-not-recognized");
		assert.equal(refusal((s) => (s.journal = { status: 0, stdout: "Error [ERR_MODULE_NOT_FOUND]: Cannot find module '/opt/other.ts'\n" })), "failure-not-recognized", "another module is another failure");
		assert.equal(refusal((s) => (s.journal = { status: 0, stdout: `${MISSING_LOG}{"event":"endpoint.failed","reason":"listen"}\n` })), "failure-not-recognized", "the endpoint ran its own code");
		assert.equal(refusal((s) => (s.journal = { status: 0, stdout: "Error [ERR_MODULE_NOT_FOUND]: Cannot find module '/opt/pim-cua/bundle/computer/cua-host/cua-credential.ts'\n" })), "recovered", "either file");
	});

	it("refuses unless the rest of the stack is running, and unless the unit is exactly the installer's for a different bundle", () => {
		for (const unit of [UNITS.bridge, VIEWER_UNITS.spacesd, VIEWER_UNITS.ingress]) {
			assert.equal(refusal((s) => (s.units[unit] = show(FAILED))), "stack-not-running", unit);
			assert.equal(refusal((s) => (s.units[unit] = show())), "stack-not-running", unit);
			assert.equal(refusal((s) => delete s.units[unit]), "stack-not-running", unit);
		}
		assert.equal(refusal((s) => (s.unitText = null)), "unit-missing");
		assert.equal(refusal((s) => (s.files[PATHS.desktopUnit] = factFile("file", 0, 0o666))), "unit-missing");
		assert.equal(refusal((s) => (s.files[PATHS.desktopUnit] = factFile("file", 1000, 0o644))), "unit-missing");
		assert.equal(refusal((s) => delete s.files[PATHS.desktopUnit]), "unit-missing");
		assert.equal(refusal((s) => (s.unitText = installed.replace("--headful", "--headful --extra"))), "unit-drift");
		assert.equal(refusal((s) => (s.unitText = installed.replace("User=pim-desktop", "User=root"))), "unit-drift");
		assert.equal(refusal((s) => (s.unitText = "[Service]\nExecStart=/bin/true\n")), "unit-drift");
		assert.equal(refusal((s) => (s.unitText = next)), "already-recovered", "a second run, for a unit that already names the new bundle");
	});

	it("refuses unless the new bundle is the old one byte for byte but its marker, plus only the permitted files", () => {
		const added = Object.fromEntries(RECOVERY_ADDED.map((file) => [file, "9".repeat(64)]));
		assert.equal(refusal((s) => (s.digests[OLD_DIR] = null)), "bundle-unreadable", "the old bundle is evidence and must still be there");
		assert.equal(refusal((s) => (s.digests[NEW_DIR] = null)), "bundle-unreadable");
		assert.equal(refusal((s) => (s.digests[NEW_DIR] = bundleFiles({ BUNDLE: "n", ...added, "computer/cua-host/desktop.ts": "0".repeat(64) }))), "bundle-differs");
		const { "computer/pim-computer.ts": _gone, ...withoutOne } = bundleFiles({ BUNDLE: "n", ...added });
		assert.equal(refusal((s) => (s.digests[NEW_DIR] = withoutOne)), "bundle-differs", "a file of the old bundle missing from the new");
		assert.equal(refusal((s) => (s.digests[NEW_DIR] = bundleFiles({ BUNDLE: "n", ...added, "computer/other.ts": "1".repeat(64) }))), "bundle-extra");
		const { [RECOVERY_ADDED[0]]: _first, ...short } = added;
		assert.equal(refusal((s) => (s.digests[NEW_DIR] = bundleFiles({ BUNDLE: "n", ...short }))), "bundle-incomplete", "the missing file isn't there");
		const { BUNDLE: _marker, ...noMarker } = bundleFiles({ ...added });
		assert.equal(refusal((s) => (s.digests[NEW_DIR] = noMarker)), "bundle-incomplete");
		assert.deepEqual(compareBundles(bundleFiles(), bundleFiles({ BUNDLE: "n", ...added })), null);
		// The old bundle's own marker is allowed to differ and nothing else is.
		assert.equal(compareBundles(bundleFiles({ BUNDLE: "old" }), bundleFiles({ BUNDLE: "new", ...added })), null);
		assert.equal(compareBundles({ ...bundleFiles(), [RECOVERY_ADDED[0]]: "5".repeat(64) }, bundleFiles({ BUNDLE: "n", ...added })), "bundle-differs", "an old copy of an added file must match too");
	});

	it("says where it stopped, whether anything had changed, and never retries or removes: a failed step is left as evidence", () => {
		const trial = (what: string) => {
			const v = vm();
			v.fail.add(what);
			try {
				recoverDesktop(newConfig, v.probe, v.host);
			} catch (error) {
				assert.ok(error instanceof RecoveryFailure);
				return { step: error.step, changed: error.changed, log: v.log.filter((e) => !e.startsWith("query")) };
			}
			throw new Error("didn't fail");
		};
		const staged = `${PATHS.desktopUnit}.next-${NEW_SHA.slice(0, 12)}`;
		assert.deepEqual(trial("write"), { step: "write", changed: false, log: [`write ${staged}`] });
		const link = trial("link");
		assert.deepEqual([link.step, link.changed, link.log.length], ["keep", true, 2], "the new unit is staged, the old one untouched");
		const rename = trial("rename");
		assert.deepEqual([rename.step, rename.changed, rename.log.length], ["replace", true, 3]);
		const reload = trial("daemon-reload");
		assert.deepEqual([reload.step, reload.changed, reload.log.at(-1)], ["reload", true, "run daemon-reload"]);
		const startFailed = trial("start");
		assert.deepEqual([startFailed.step, startFailed.changed, startFailed.log.filter((e) => e === `run start ${UNITS.desktop}`).length], ["start", true, 1], "one start, no retry");
		for (const result of [link, rename, reload, startFailed]) assert.equal(result.log.some((e) => /unlink|remove|rm /.test(e)), false);
	});

	it("is a bundle's own program, with its imports held by the bundle and nothing in it a bridge or ws import", () => {
		assert.ok(BUNDLE_SOURCES.includes(RECOVER_FILE as never));
		assert.deepEqual(RECOVERY_ADDED, ["computer/native-outcome.ts", "computer/cua-host/cua-credential.ts", RECOVER_FILE]);
		const source = fs.readFileSync(path.join(REPOSITORY, RECOVER_FILE), "utf8");
		// It reads no secret: no token, key or journal path is named in it.
		for (const word of ["rootToken", "journalLock", "journal.json", "key.pem", "PATHS.token", "spacesdToken", "evalKey"]) assert.equal(source.includes(word), false, word);
		// It changes one unit file and nothing else: the only writes are of that unit's own names.
		assert.equal((source.match(/host\.(writeNew|linkNew|renameOver|run)\(/g) ?? []).length, 5);
	});

	it("renders the two recovery scripts from the new configuration only for a viewer and complete pins, and from pins that name the new commit", () => {
		refusedWith(() => renderRecoveryScripts(config(false), PINNED), "config-viewer");
		refusedWith(() => renderRecoveryScripts(newConfig, { ...PINNED, repository: { ...PINNED.repository, commit: "f".repeat(40) } }), "pin-commit");
		refusedWith(() => renderRecoveryScripts(newConfig, { ...PINNED, repository: { ...PINNED.repository, sha256: null } }), "pin-missing:repository-sha256");
		const scripts = renderRecoveryScripts(newConfig, PINNED);
		assert.deepEqual(Object.keys(scripts), ["recover-fetch.sh", "recover-desktop.sh"]);
		const fetch = renderScripts(config(true), PINNED)["fetch.sh"]!;
		const recoverFetch = scripts["recover-fetch.sh"]!;
		// The shared machinery is the same text, so what was shown to work on the first fetch is what runs.
		for (const name of ["cleanup", "download", "publish_file", "list_tree", "prepare_tree", "publish_tree", "ensure_parent", "fail_path", "staged_ok"]) {
			assert.ok(bashFunction(fetch, name).length > 0, name);
			assert.equal(bashFunction(recoverFetch, name), bashFunction(fetch, name), name);
		}
		// It delivers a bundle and nothing else: three downloads, the VM's own Node, one tree published, nowhere else written.
		assert.equal(recoverFetch.match(/^download '/gm)?.length, 3);
		for (const name of ["repository", "ws", "protobuf"]) assert.ok(recoverFetch.includes(`download '${name}' `), name);
		for (const absent of ["node.tar.gz", "caddy", "spacesd", "chrome", "dpkg-deb", "publish_file \"$", "ensure_parent \"$NODE_ROOT\""]) assert.equal(recoverFetch.includes(absent), false, absent);
		assert.ok(recoverFetch.includes("readonly STAGE='/var/lib/pim-cua-recover-fetch'"));
		assert.ok(recoverFetch.includes('trusted_file "$NODE" || fail node-path') && recoverFetch.includes('[[ "$(sum256 "$NODE")" == "$NODE_SHA256" ]] || fail node-digest'));
		assert.ok(recoverFetch.includes('"$NODE" "$STAGE/src/computer/cua-host/eval-install/operator.ts" bundle --commit "$COMMIT" --source-dir "$STAGE/src"'));
		assert.ok(recoverFetch.includes('absent "$BUNDLE" bundle'));
		assert.deepEqual(recoverFetch.match(/^publish_(?:file|tree) "\$STAGE[^\n]*/gm), ['publish_tree "$STAGE/bundle" "$BUNDLE" bundle']);
		assert.ok(recoverFetch.indexOf("prepare_tree \"$STAGE/bundle\" bundle") < recoverFetch.indexOf("\nPLACING=1\n"));
		assert.ok(recoverFetch.includes('[[ "$(tree_digest "$BUNDLE")" == "$BUNDLE_SHA256" ]] || fail placed-bundle'));
		assert.ok(recoverFetch.includes(`readonly BUNDLE='${NEW_DIR}'`) && recoverFetch.includes(`readonly BUNDLE_SHA256='${NEW_SHA}'`));
		for (const forbidden of ["-k ", "--insecure", "--cacert", "Authorization", "--header", "--user", "--netrc", "http://", "--retry-", "sudo", "ssh", "set -x", "eval ", " mv ", "cp "]) assert.equal(recoverFetch.includes(forbidden), false, forbidden);
		assert.deepEqual(pipesToShell(recoverFetch), []);
		assert.deepEqual(unobservedSubstitutions(recoverFetch.slice(recoverFetch.indexOf("trusted_file /usr/bin/curl"))), []);
		assert.equal(/printf '[^']*\n[^']*'/.test(recoverFetch), false);
		assert.equal(recoverFetch.includes("\0"), false);
		// The script that runs the recovery verifies the NEW bundle first, as every script does, then runs the program from it, once.
		const recover = scripts["recover-desktop.sh"]!;
		assert.equal(recover.match(/^exec .*/gm)?.length, 1);
		assert.ok(recover.includes(`exec "$NODE" "$BUNDLE/${RECOVER_FILE}" <<'`));
		for (const check of ["fail root-required", "fail node-digest", "fail bundle-digest"]) assert.ok(recover.indexOf(check) > 0 && recover.indexOf(check) < recover.indexOf("\nexec "), check);
		assert.ok(recover.includes(`readonly BUNDLE='${NEW_DIR}'`) && recover.includes(`"dir":"${NEW_DIR}"`));
		assert.ok(recover.includes("\numask 077\n") && !recover.includes("umask 022"), "private, as the other scripts but `journal`");
		// The old bundle's and every secret's paths are not named in either script.
		for (const text of [recover, recoverFetch]) for (const secret of [VIEWER_PATHS.rootToken, VIEWER_PATHS.spacesdToken, PATHS.token, PATHS.key, VIEWER_PATHS.journal, VIEWER_PATHS.journalLock]) assert.equal(text.includes(secret), false, secret);
	});

});
