/**
 * The viewer host's journal, kept in one file (./viewer-launch-manager.ts,
 * docs/cua-observation.md), for one writer for as long as the host lives.
 *
 * **The lock.** Reading the file, checking its revision and renaming over it
 * is not a compare-and-swap: two writers can both pass the check. So the
 * store excludes a second writer for good instead. `openJournalStore` makes
 * `journal.lock` in the journal's directory with `O_CREAT | O_EXCL`, which
 * the file system grants to one process, and the store holds it until
 * `close()`. A lock that is already there is **refused, and left where it
 * is**: it may be a live host's, or one that died, and nothing here can tell
 * which. No stale lock is removed, replaced or recovered by this program; an
 * operator who has stopped every host removes it by hand. A host that died
 * therefore keeps its successor from starting, and that is the intended
 * failure: it fails closed. While it lives, every write also checks that the
 * lock file is still the one it made (same device and inode, one link), so a
 * lock removed from under a live host stops its writes.
 *
 * **The write.** Under the lock the stored revision can't move except by
 * this store, so `write(journal, expected)` reads the stored journal, refuses
 * unless its revision is `expected` and `journal`'s is the next one, writes
 * the new one to `journal.json.tmp`, flushes it, renames it over
 * `journal.json`, and flushes the directory. A crash leaves the old journal
 * or the new one, whole. A leftover `journal.json.tmp` is never the journal;
 * it is replaced while the lock is held.
 *
 * **What it never does.** It never creates `journal.json`. A missing journal
 * reads as `undefined`, and a write to a missing one is refused, so the
 * manager stays blocked (docs/cua-observation.md) until an operator
 * provisions one, outside this program. It never repairs, resets or
 * reinitializes a journal that is invalid; the manager refuses it, and so
 * does this store's write.
 *
 * The directory and files must be the host account's own, and no one else's
 * to read or write: a directory with no group or other permissions, a
 * regular journal and lock file with no group or other permissions and one
 * link, none of them a symbolic link. Failures say a fixed reason, never a
 * path or what was thrown.
 *
 * Importing it does nothing.
 */

import { Buffer } from "node:buffer";
import * as fs from "node:fs";
import * as path from "node:path";
import type { Journal, JournalStore } from "./viewer-launch-manager.ts";

export const JOURNAL_FILE = "journal.json";
export const JOURNAL_TEMP_FILE = "journal.json.tmp";
export const JOURNAL_LOCK_FILE = "journal.lock";

/** The most bytes a journal may take. The manager's limit of 64 entries is far below it. */
export const MAX_JOURNAL_BYTES = 1024 * 1024;

/** What is read of a file's status; `fs.Stats` has it, and tests give stand-ins. */
export type JournalStat = {
	isFile(): boolean;
	isDirectory(): boolean;
	isSymbolicLink(): boolean;
	readonly uid: number;
	readonly mode: number;
	readonly nlink: number;
	readonly size: number;
	readonly dev: number;
	readonly ino: number;
};

/**
 * The file operations the store uses, each synchronous and each throwing an
 * error with a `code` (`ENOENT`, `EEXIST`) on failure. Node's are the real
 * ones; tests give an in-memory set.
 */
export type JournalFiles = {
	/** `open(2)`; the flags are `fs.constants`'. */
	open(file: string, flags: number, mode?: number): number;
	fstat(descriptor: number): JournalStat;
	lstat(file: string): JournalStat;
	/** Everything in the file, up to `max` bytes; one more byte than that means it was too big. */
	read(descriptor: number, max: number): Buffer;
	/** All of `data`, or throws. */
	write(descriptor: number, data: Buffer): void;
	fsync(descriptor: number): void;
	close(descriptor: number): void;
	rename(from: string, to: string): void;
	unlink(file: string): void;
	/** The effective user ID of this process, or `undefined` where there is none. */
	uid(): number | undefined;
};

export const NODE_JOURNAL_FILES: JournalFiles = {
	open: (file, flags, mode) => fs.openSync(file, flags, mode),
	fstat: (descriptor) => fs.fstatSync(descriptor),
	lstat: (file) => fs.lstatSync(file),
	read: (descriptor, max) => {
		const buffer = Buffer.alloc(max + 1);
		let length = 0;
		while (length < buffer.length) {
			const count = fs.readSync(descriptor, buffer, length, buffer.length - length, null);
			if (count === 0) break;
			length += count;
		}
		return buffer.subarray(0, length);
	},
	write: (descriptor, data) => {
		let offset = 0;
		while (offset < data.length) offset += fs.writeSync(descriptor, data, offset, data.length - offset);
	},
	fsync: (descriptor) => fs.fsyncSync(descriptor),
	close: (descriptor) => fs.closeSync(descriptor),
	rename: (from, to) => fs.renameSync(from, to),
	unlink: (file) => fs.unlinkSync(file),
	uid: () => process.geteuid?.(),
};

/** Why a journal store wasn't opened: a fixed reason, never a path or an error's text. */
export class JournalStoreRefused extends Error {
	readonly reason: string;
	constructor(reason: string) {
		super(`The viewer journal store was refused (${reason}).`);
		this.reason = reason;
	}
}

export type JournalStoreOptions = {
	/** The journal's directory: absolute, the host account's own, with no group or other permissions. */
	readonly directory: string;
	readonly files?: JournalFiles;
};

export type OpenJournalStore = {
	readonly store: JournalStore;
	/** Releases the lock, once the host has stopped writing. A lock that isn't this store's any more is left where it is. */
	readonly close: () => void;
};

const { O_RDONLY, O_WRONLY, O_CREAT, O_EXCL, O_NOFOLLOW, O_DIRECTORY } = fs.constants;
const code = (error: unknown) => (typeof error === "object" && error !== null ? (error as { code?: unknown }).code : undefined);

/** Takes the lock for good, or refuses without changing anything. */
export function openJournalStore(options: JournalStoreOptions): OpenJournalStore {
	const files = options.files ?? NODE_JOURNAL_FILES;
	const directory = options.directory;
	if (typeof directory !== "string" || !path.isAbsolute(directory) || path.resolve(directory) !== directory) throw new JournalStoreRefused("directory");
	const uid = files.uid();
	const own = (stat: JournalStat) => uid !== undefined && stat.uid === uid;
	const file = path.join(directory, JOURNAL_FILE);
	const temp = path.join(directory, JOURNAL_TEMP_FILE);
	const lockFile = path.join(directory, JOURNAL_LOCK_FILE);

	// The directory: a real one of this account's, closed to everyone else.
	try {
		const stat = files.lstat(directory);
		if (stat.isSymbolicLink() || !stat.isDirectory() || !own(stat) || (stat.mode & 0o077) !== 0) throw new JournalStoreRefused("directory");
	} catch (error) {
		throw error instanceof JournalStoreRefused ? error : new JournalStoreRefused("directory");
	}

	// The lock: made exclusively, or refused and left as it is.
	let lock: number;
	try {
		lock = files.open(lockFile, O_WRONLY | O_CREAT | O_EXCL | O_NOFOLLOW, 0o600);
	} catch (error) {
		throw new JournalStoreRefused(code(error) === "EEXIST" ? "locked" : "lock");
	}
	let held = true;
	let lockIdentity: { dev: number; ino: number };
	try {
		const stat = files.fstat(lock);
		if (!stat.isFile() || !own(stat) || (stat.mode & 0o077) !== 0 || stat.nlink !== 1) throw new Error("lock");
		lockIdentity = { dev: stat.dev, ino: stat.ino };
	} catch {
		// Made here a moment ago and not as it must be: taken back, so no lock of ours is left behind.
		try {
			files.close(lock);
		} catch {
			// Nothing more can be done with it.
		}
		try {
			files.unlink(lockFile);
		} catch {
			// A lock left behind blocks, which fails closed.
		}
		throw new JournalStoreRefused("lock");
	}

	/** Whether the lock file at its path is still the one this store made. */
	const lockIsOurs = (): boolean => {
		if (!held) return false;
		try {
			const stat = files.lstat(lockFile);
			return !stat.isSymbolicLink() && stat.isFile() && stat.dev === lockIdentity.dev && stat.ino === lockIdentity.ino && stat.nlink === 1;
		} catch {
			return false;
		}
	};

	/** The stored journal's bytes, or `undefined` when there is no file; throws when it can't be read as it must be. */
	const readStored = (): Buffer | undefined => {
		let descriptor: number;
		try {
			descriptor = files.open(file, O_RDONLY | O_NOFOLLOW);
		} catch (error) {
			if (code(error) === "ENOENT") return undefined;
			throw new Error("journal open");
		}
		try {
			const stat = files.fstat(descriptor);
			if (!stat.isFile() || !own(stat) || (stat.mode & 0o077) !== 0 || stat.nlink !== 1 || stat.size > MAX_JOURNAL_BYTES) throw new Error("journal file");
			const bytes = files.read(descriptor, MAX_JOURNAL_BYTES);
			if (bytes.length > MAX_JOURNAL_BYTES) throw new Error("journal size");
			return bytes;
		} finally {
			try {
				files.close(descriptor);
			} catch {
				// A read is done either way.
			}
		}
	};

	/** The stored journal's revision, or `undefined` if there is no journal; throws if it isn't JSON with a whole revision. */
	const storedRevision = (): number | undefined => {
		const bytes = readStored();
		if (bytes === undefined) return undefined;
		const parsed: unknown = JSON.parse(bytes.toString("utf8"));
		const revision = typeof parsed === "object" && parsed !== null ? (parsed as { revision?: unknown }).revision : undefined;
		if (typeof revision !== "number" || !Number.isSafeInteger(revision) || revision < 1) throw new Error("journal revision");
		return revision;
	};

	/** Flushes the directory, so a rename in it is durable. */
	const flushDirectory = () => {
		const descriptor = files.open(directory, O_RDONLY | O_DIRECTORY);
		try {
			files.fsync(descriptor);
		} finally {
			try {
				files.close(descriptor);
			} catch {
				// Flushed or not, nothing more can be done with it.
			}
		}
	};

	let queue: Promise<unknown> = Promise.resolve();

	const store: JournalStore = {
		async read() {
			if (!lockIsOurs()) throw new Error("lock lost");
			const bytes = readStored();
			return bytes === undefined ? undefined : JSON.parse(bytes.toString("utf8"));
		},
		write(journal: Journal, expectedRevision: number): Promise<void> {
			const run = async (): Promise<void> => {
				if (!lockIsOurs()) throw new Error("lock lost");
				if (!Number.isSafeInteger(expectedRevision) || journal.revision !== expectedRevision + 1) throw new Error("revision");
				// Under the lock nothing else writes, so this is a check and then a swap with no one between.
				const stored = storedRevision();
				if (stored === undefined) throw new Error("no journal");
				if (stored !== expectedRevision) throw new Error("revision moved");
				const data = Buffer.from(JSON.stringify(journal), "utf8");
				if (data.length > MAX_JOURNAL_BYTES) throw new Error("journal size");
				// A temporary file left by a crash is never the journal; this store holds the lock, so no one else uses it.
				try {
					files.unlink(temp);
				} catch (error) {
					if (code(error) !== "ENOENT") throw new Error("temporary file");
				}
				const descriptor = files.open(temp, O_WRONLY | O_CREAT | O_EXCL | O_NOFOLLOW, 0o600);
				try {
					files.write(descriptor, data);
					files.fsync(descriptor);
				} finally {
					try {
						files.close(descriptor);
					} catch {
						// Written and flushed, or the error above is the one that counts.
					}
				}
				if (!lockIsOurs()) throw new Error("lock lost");
				files.rename(temp, file);
				flushDirectory();
			};
			// One write at a time, whatever the caller does; `queue` never rejects, so a failed write doesn't stop the next.
			const result = queue.then(run);
			queue = result.catch(() => undefined);
			return result;
		},
	};

	return {
		store,
		close() {
			if (!held) return;
			const ours = lockIsOurs();
			held = false;
			try {
				files.close(lock);
			} catch {
				// The descriptor is of no use any more.
			}
			if (!ours) return;
			try {
				files.unlink(lockFile);
			} catch {
				// A lock left behind blocks the next host, which fails closed.
			}
		},
	};
}
