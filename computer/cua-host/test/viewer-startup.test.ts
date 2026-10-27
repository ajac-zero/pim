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
	VIEWER_ACCOUNTS,
	VIEWER_ASSET_NAMES,
	VIEWER_ASSET_SHA256,
	VIEWER_BUNDLE_FILES,
	VIEWER_PATHS,
	VIEWER_UNITS,
	viewerBundleFiles,
} from "../eval-install/config.ts";
import { checkAccounts, checkBackendName, checkUnits, type Facts, inspectedPaths, type PathFact, type Probe, plan, start } from "../eval-install/install.ts";
import { initialJournalText, newRootToken, provisionJournal, provisionRootToken, ProvisionFailure, tombstoneText } from "../eval-install/journal-provision.ts";
import { BASE_DESKTOP_UID, BUNDLE_SOURCES, bundleEntries, bundleInputs, lockedPackageIntegrity, renderBaseCloudConfig, renderCloudConfig, renderScripts, untarPackage, VIEWER_SOURCES } from "../eval-install/operator.ts";
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
	function probe(change: (files: Record<string, PathFact>) => void = () => {}): Probe {
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
			// Every check that must refuse does so before the units are asked; one that got there would fail this.
			query: () => ({ status: 1, stdout: "" }),
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

	it("travel in cloud-init data, which writes them and runs none", () => {
		const data = renderCloudConfig(renderScripts(config(true), PINNED));
		for (const name of ["bridge-cert", "journal", "root-token", "fetch", "support"]) assert.ok(data.includes(`/usr/local/sbin/pim-cua-eval-${name}`), name);
		assert.equal(data.includes("runcmd"), false);
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

	it("still lacks exactly two pins, the commit and its archive's SHA-256, and renders nothing until they are filled in, for the same commit", () => {
		assert.deepEqual(missingPins(PINS), ["repository-commit", "repository-sha256"]);
		assert.deepEqual(missingPins(PINNED), []);
		refusedWith(() => renderScripts(config(true)), "pin-missing:repository-commit,repository-sha256");
		refusedWith(() => renderScripts(config(true), { ...PINNED, repository: { ...PINNED.repository, sha256: null } }), "pin-missing:repository-sha256");
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
		for (const forbidden of ["-k ", "--insecure", "--cacert", "Authorization", "--header", "-H ", "--user", "-u ", "--netrc", "| sh", "| bash", "http://", "--retry-", "sudo", "ssh", "az ", "set -x", "eval "]) assert.equal(script.includes(forbidden), false, forbidden);
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
		for (const file of ["computer/cua-host/eval-install/config.ts", "computer/cua-host/eval-install/operator.ts", "computer/cua-host/eval-install/pins.ts"]) for (const specifier of importsOf(file)) assert.ok(specifier.startsWith("node:") || /^\.\/(config|pins)\.ts$|^\.\.\/origin\.ts$/.test(specifier), `${file}: ${specifier}`);
		assert.ok(BUNDLE_SOURCES.includes("computer/cua-host/origin.ts"));
		for (const value of ["https://*.example.com", "https://example.com:443", "https://example.com/", "https://user@example.com", "https://EXAMPLE.com", ""]) assert.equal(isHttpsOrigin(value), false, value);
		assert.equal(isHttpsOrigin("https://cua-eval.ajac-zero.com"), true);
	});

	it("checks, read-only and before `start`, the packages, libraries, versions, `caddy validate`, spacesd and a sandboxed headless Chrome, failing if any does", () => {
		const script = renderScripts(config(true), PINNED)["support.sh"]!;
		assert.ok(script.includes("fail node-digest") && script.indexOf("fail node-digest") < script.indexOf("FAILED=0"));
		for (const package_ of ["libnss3", "libgtk-3-0t64", "libatspi2.0-0t64", "xvfb", "xdg-utils"]) assert.ok(script.includes(`'${package_}'`), package_);
		assert.ok(script.includes("dpkg-query -W -f='${db:Status-Status}'"));
		assert.ok(script.includes("check caddy-validate /usr/sbin/runuser -u pim-ingress -- env -i PATH=/usr/bin:/bin XDG_DATA_HOME=/var/lib/pim-ingress XDG_CONFIG_HOME=/var/lib/pim-ingress \"$CADDY\" validate --config /etc/pim-ingress/Caddyfile --adapter caddyfile"));
		assert.ok(script.includes("check spacesd-runs /usr/sbin/runuser -u pim-desktop"));
		assert.ok(script.includes('"$BROWSER" --headless=new --disable-gpu --user-data-dir="$TEMP/profile" --dump-dom about:blank'));
		assert.equal(script.includes("no-sandbox"), false);
		assert.ok(script.includes('exit "$FAILED"'));
		assert.equal(script.match(/rm -rf/g)?.length, 1);
		for (const forbidden of ["systemctl", "curl", "sudo", "set -x", "eval ", "--no-sandbox", "docker"]) assert.equal(script.includes(forbidden), false, forbidden);
	});
});
