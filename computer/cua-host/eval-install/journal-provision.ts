/**
 * Makes the viewer's journal, once, on a new VM (docs/cua-viewer-first-startup.md). The viewer host
 * (../viewer-host.ts) never makes its journal: a missing journal can't be told from a lost one, and a
 * lost one took with it the keys that must never start again. So this program, run as root by a
 * rendered script, is the one place a first journal is made, under these rules:
 *
 * - **A tombstone first.** `/etc/pim-eval/journal-provisioned` (root's, `0444`) is made with
 *   `O_CREAT | O_EXCL` before anything else, written and flushed. It is never removed, replaced or
 *   rewritten by this tooling. If it exists, nothing is made: the VM had a journal, or began to have
 *   one, and no other is made for it, whatever became of the first.
 * - **Nothing already there.** The journal's directory must not exist. It is made with a plain
 *   `mkdir` (never recursive), given to the bridge's account with mode `0700`, and the journal is
 *   created in it exclusively (`0600`, the bridge's), written, flushed, its directory and parent
 *   flushed.
 * - **Never the lock, never a reset.** It doesn't make `journal.lock`, doesn't open an existing
 *   journal, removes nothing and replaces nothing. A step that fails stops it, and undoes nothing:
 *   a tombstone with no journal is a blocked viewer for good, which is the intended failure. A
 *   failed provisioning means a new VM, never a second try, a reset or a new identity.
 *
 * The journal it writes has the shape of `initialJournal` (../../../preview/cua-viewer-first.ts), which a
 * test holds equal to it. Importing this file does nothing.
 */

import * as fs from "node:fs";
import { realpathSync } from "node:fs";
import * as path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { type JournalFiles, JournalStoreRefused, NODE_JOURNAL_FILES, withDescriptor } from "../journal-store.ts";
import { type Config, parseConfig, Refusal, VIEWER_BUNDLE_FILES, VIEWER_PATHS } from "./config.ts";
import { checkAccounts } from "./install.ts";

/** What provisioning needs beyond reading and writing a file: a directory, and a new owner. */
export type ProvisionFiles = JournalFiles & {
	/** `mkdir(2)`, not recursive: throws `EEXIST` if anything is there. */
	mkdir(directory: string, mode: number): void;
	chown(file: string, uid: number, gid: number): void;
	fchown(descriptor: number, uid: number, gid: number): void;
};

export const NODE_PROVISION_FILES: ProvisionFiles = {
	...NODE_JOURNAL_FILES,
	mkdir: (directory, mode) => fs.mkdirSync(directory, { mode }),
	chown: (file, uid, gid) => fs.chownSync(file, uid, gid),
	fchown: (descriptor, uid, gid) => fs.fchownSync(descriptor, uid, gid),
};

const { O_RDONLY, O_WRONLY, O_CREAT, O_EXCL, O_NOFOLLOW, O_DIRECTORY } = fs.constants;

/** The first journal's text, with the `initialJournal` shape: version 1, revision 1 (the manager needs at least 1), a generation the host's first start replaces, no entries. */
export function initialJournalText(config: Config): string {
	return JSON.stringify({ version: 1, revision: 1, generation: "provisioned", initialized: `${config.evaluation} ${config.owner} journal-provision`, entries: [] });
}

/** The tombstone's text: which evaluation and owner a journal was provisioned for, and nothing secret. */
export function tombstoneText(config: Config): string {
	return `${JSON.stringify({ event: "pim-cua-eval.journal-provisioned", evaluation: config.evaluation, owner: config.owner })}\n`;
}

/** Why provisioning stopped, a fixed word, and whether it had changed anything by then. */
export class ProvisionFailure extends Error {
	readonly step: string;
	readonly reason: string;
	readonly changed: boolean;
	constructor(step: string, reason: string, changed: boolean) {
		super(`${step}: ${reason}`);
		this.step = step;
		this.reason = reason;
		this.changed = changed;
	}
}

const code = (error: unknown) => (typeof error === "object" && error !== null ? (error as { code?: unknown }).code : undefined);

/**
 * Makes the tombstone, then the journal's directory and the journal, as the module's header says.
 * `bridge` is the bridge account's UID and GID, as the installer's account check found them.
 */
export function provisionJournal(config: Config, bridge: { uid: number; gid: number }, files: ProvisionFiles = NODE_PROVISION_FILES): void {
	if (!config.viewer) throw new ProvisionFailure("config", "no-viewer", false);
	if (files.uid() !== 0) throw new ProvisionFailure("root", "root-required", false);
	let changed = false;
	const fail = (step: string, reason: string): never => {
		throw new ProvisionFailure(step, reason, changed);
	};
	const absent = (file: string): boolean => {
		try {
			files.lstat(file);
			return false;
		} catch (error) {
			if (code(error) === "ENOENT") return true;
			return fail("check", "unreadable");
		}
	};
	const trustedDirectory = (directory: string): boolean => {
		try {
			const stat = files.lstat(directory);
			return stat.isDirectory() && !stat.isSymbolicLink() && stat.uid === 0 && (stat.mode & 0o022) === 0;
		} catch {
			return false;
		}
	};

	// Before anything is made: nothing of a journal, a tombstone or a lock is there, and the parents are root's.
	if (!absent(VIEWER_PATHS.tombstone)) fail("check", "already-provisioned");
	if (!absent(VIEWER_PATHS.journalDir)) fail("check", "journal-dir-exists");
	if (!trustedDirectory(path.posix.dirname(VIEWER_PATHS.tombstone)) || !trustedDirectory(path.posix.dirname(VIEWER_PATHS.journalDir))) fail("check", "unsafe-parent");

	const flush = (directory: string, step: string) => {
		const descriptor = files.open(directory, O_RDONLY | O_DIRECTORY);
		let retained = false;
		try {
			withDescriptor(files, descriptor, () => (retained = true), () => files.fsync(descriptor));
		} catch {
			fail(step, retained ? "descriptor-retained" : "flush");
		}
	};
	/** Creates `file` exclusively with `mode`, gives it to `owner` if one is named, writes `text`, flushes it. */
	const create = (file: string, mode: number, owner: { uid: number; gid: number } | null, text: string, step: string) => {
		let descriptor: number;
		try {
			descriptor = files.open(file, O_WRONLY | O_CREAT | O_EXCL | O_NOFOLLOW, mode);
		} catch (error) {
			return fail(step, code(error) === "EEXIST" ? "exists" : "create");
		}
		changed = true;
		let retained = false;
		try {
			withDescriptor(files, descriptor, () => (retained = true), () => {
				if (owner) files.fchown(descriptor, owner.uid, owner.gid);
				files.write(descriptor, Buffer.from(text, "utf8"));
				files.fsync(descriptor);
			});
		} catch {
			fail(step, retained ? "descriptor-retained" : "write");
		}
	};

	// The tombstone first, so that whatever happens next, no second journal is ever made for this VM.
	create(VIEWER_PATHS.tombstone, 0o444, null, tombstoneText(config), "tombstone");
	flush(path.posix.dirname(VIEWER_PATHS.tombstone), "tombstone");

	try {
		files.mkdir(VIEWER_PATHS.journalDir, 0o700);
		files.chown(VIEWER_PATHS.journalDir, bridge.uid, bridge.gid);
	} catch {
		fail("journal-dir", "mkdir");
	}
	create(VIEWER_PATHS.journal, 0o600, bridge, initialJournalText(config), "journal");
	flush(VIEWER_PATHS.journalDir, "journal");
	flush(path.posix.dirname(VIEWER_PATHS.journalDir), "journal");
}

// ---- The program ----

async function main(): Promise<void> {
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
		if (fileURLToPath(import.meta.url) !== `${config.bundle.dir}/${VIEWER_BUNDLE_FILES.provision}`) throw new Refusal("provision-path");
		if (process.execPath !== config.node.path) throw new Refusal("node-path");
		step = "accounts";
		const read = (file: string) => fs.readFileSync(file, "utf8");
		const accounts = checkAccounts(read("/etc/passwd"), read("/etc/group"), read("/etc/shadow"));
		step = "provision";
		provisionJournal(config, { uid: accounts.bridge.uid, gid: accounts.bridge.gid });
		process.stdout.write(`${JSON.stringify({ event: "pim-cua-eval.journal-provisioned", evaluation: config.evaluation })}\n`);
	} catch (error) {
		// What was thrown may name a path; only fixed words are said.
		const entry =
			error instanceof ProvisionFailure
				? { event: "pim-cua-eval.failed", command: "journal", step: error.step, reason: error.reason, changed: error.changed }
				: { event: "pim-cua-eval.failed", command: "journal", step, reason: error instanceof Refusal ? error.reason : error instanceof JournalStoreRefused ? error.reason : "internal", changed: false };
		process.stderr.write(`${JSON.stringify(entry)}\n`);
		process.exit(1);
	}
}

// Run as a program, never when imported.
if (process.argv[1] && import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href) void main();
