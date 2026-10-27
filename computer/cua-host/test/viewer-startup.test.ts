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
	renderUnits,
	VIEWER_ASSET_NAMES,
	VIEWER_ASSET_SHA256,
	VIEWER_BUNDLE_FILES,
	VIEWER_PATHS,
	viewerBundleFiles,
} from "../eval-install/config.ts";
import { type Facts, inspectedPaths, type PathFact, type Probe, plan, start } from "../eval-install/install.ts";
import { initialJournalText, provisionJournal, ProvisionFailure, tombstoneText } from "../eval-install/journal-provision.ts";
import { BUNDLE_SOURCES, bundleEntries, lockedPackageIntegrity, renderCloudConfig, renderScripts, untarPackage, VIEWER_SOURCES } from "../eval-install/operator.ts";
import { openJournalStore } from "../journal-store.ts";
import { initialJournal } from "../../../preview/cua-viewer-first.ts";
import { FakeFiles } from "./fake-journal-files.ts";

const REPOSITORY = path.resolve(import.meta.dirname, "../../..");
const OWNER = "o_0123456789abcdefghijklmnop";
const COMMIT = "0123456789abcdef0123456789abcdef01234567";
const PIM = "https://pim-cua-eval.ajac-zero.com";
const VIEWER = "https://cua-eval.ajac-zero.com";

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
		bridge: { host: "0.0.0.0", port: 8443, path: "/pim" },
		desktop: { headful: true, display: ":0", xauthority: null },
		...(viewer ? { viewer: { origin: "http://127.0.0.1:3211", publicOrigin: VIEWER, embedOrigin: PIM, display: "primary" } } : {}),
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
			`ExecStart=/opt/pim-node/bin/node /opt/pim-cua/bundle/computer/cua-host/bridge.ts --space ${OWNER} --path /pim --socket /run/pim-session/session.sock --host 0.0.0.0 --port 8443` +
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

	it("plans the same actions as without a viewer, but the bridge's unit, and makes neither the journal nor the root token", () => {
		const withViewer = config(true);
		const plain = config(false);
		const a = plan(withViewer, vm(withViewer));
		const b = plan(plain, vm(plain));
		assert.deepEqual(a.map((x) => x.step), b.map((x) => x.step));
		const unitA = a.find((x) => x.step === "bridge-unit") as { content: { text: string } };
		assert.ok(unitA.content.text.includes("--viewer-public-origin"));
		for (const action of a) {
			if ("path" in action) assert.ok(!action.path.startsWith(VIEWER_PATHS.journalDir) && action.path !== VIEWER_PATHS.tombstone && action.path !== VIEWER_PATHS.rootToken, action.step);
		}
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

describe("the rendered scripts with a viewer", () => {
	it("add one script, `journal.sh`, that runs only the bundle's own provisioning program with the configuration, and none without a viewer", () => {
		const plain = renderScripts(config(false));
		assert.deepEqual(Object.keys(plain), ["plan.sh", "install.sh", "seal.sh", "start.sh", "status.sh"]);
		const withViewer = renderScripts(config(true));
		assert.deepEqual(Object.keys(withViewer), ["plan.sh", "install.sh", "seal.sh", "start.sh", "status.sh", "journal.sh"]);
		for (const name of Object.keys(plain)) assert.equal(withViewer[name]!.replace(/\{"version":1.*\}/, ""), plain[name]!.replace(/\{"version":1.*\}/, ""), `${name} is unchanged but for its configuration`);
		const script = withViewer["journal.sh"]!;
		assert.equal(script.match(/^exec .*/gm)?.length, 1);
		assert.ok(script.includes(`exec "$NODE" "$BUNDLE/${VIEWER_BUNDLE_FILES.provision}" <<'`));
		// It checks the pinned Node and the bundle's digest before that, and takes nothing from outside, reads no secret and prints none.
		for (const check of ["fail root-required", "fail node-digest", "fail bundle-digest"]) assert.ok(script.indexOf(check) > 0 && script.indexOf(check) < script.indexOf("\nexec "), check);
		for (const forbidden of ["set -x", "cat ", "eval ", "kill ", "curl ", "az "]) assert.equal(script.includes(forbidden), false, forbidden);
		assert.ok(!script.includes(VIEWER_PATHS.rootToken));
	});

	it("travel in cloud-init data, which writes them and runs none", () => {
		const data = renderCloudConfig(renderScripts(config(true)));
		assert.ok(data.includes("/usr/local/sbin/pim-cua-eval-journal"));
		assert.equal(data.includes("runcmd"), false);
	});
});
