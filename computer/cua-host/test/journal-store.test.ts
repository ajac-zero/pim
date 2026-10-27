/**
 * The viewer journal's file store (../journal-store.ts) over an in-memory
 * file system (./fake-journal-files.ts): no real file, process or socket.
 * It shows the lock's exclusion, that no stale lock is removed, that a
 * journal is never created, and what a write does and in which order.
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { JOURNAL_FILE, JOURNAL_LOCK_FILE, JOURNAL_TEMP_FILE, JournalStoreRefused, openJournalStore, writeFully } from "../journal-store.ts";
import type { Journal } from "../viewer-launch-manager.ts";
import { FakeFiles, OWNER_UID } from "./fake-journal-files.ts";

const DIR = "/var/lib/pim-viewer";
const FILE = `${DIR}/${JOURNAL_FILE}`;
const TEMP = `${DIR}/${JOURNAL_TEMP_FILE}`;
const LOCK = `${DIR}/${JOURNAL_LOCK_FILE}`;

const journal = (revision: number, generation = "g1"): Journal => ({ version: 1, revision, generation, initialized: "a test", entries: [] });

/** A directory with a provisioned journal at revision 1, as an operator would leave it. */
function provisioned(): FakeFiles {
	const files = new FakeFiles();
	files.directory(DIR);
	files.file(FILE, JSON.stringify(journal(1, "provisioned")));
	return files;
}

const refusal = (open: () => unknown): string | undefined => {
	try {
		open();
	} catch (error) {
		return error instanceof JournalStoreRefused ? error.reason : "other";
	}
	return undefined;
};

describe("the journal store's lock", () => {
	it("is taken once, and a second store is refused while it is held", async () => {
		const files = provisioned();
		const first = openJournalStore({ directory: DIR, files });
		assert.equal(refusal(() => openJournalStore({ directory: DIR, files })), "locked");
		assert.ok(files.nodes.has(LOCK));
		await first.close();
		assert.equal(files.nodes.has(LOCK), false);
		await openJournalStore({ directory: DIR, files }).close();
	});

	it("refuses a lock left behind and leaves it where it is", () => {
		const files = provisioned();
		files.file(LOCK, "a host that died");
		assert.equal(refusal(() => openJournalStore({ directory: DIR, files })), "locked");
		assert.equal(files.text(LOCK), "a host that died");
		assert.equal(files.log.some((entry) => entry.startsWith("unlink")), false);
	});

	it("refuses a directory that is another account's, open to others, a link or missing", () => {
		const open = (prepare: (files: FakeFiles) => void) => {
			const files = new FakeFiles();
			prepare(files);
			return refusal(() => openJournalStore({ directory: DIR, files }));
		};
		assert.equal(open((files) => files.directory(DIR, 0o700, OWNER_UID + 1)), "directory");
		assert.equal(open((files) => files.directory(DIR, 0o750)), "directory");
		assert.equal(open((files) => files.directory(DIR, 0o707)), "directory");
		assert.equal(open((files) => files.link(DIR)), "directory");
		assert.equal(open(() => undefined), "directory");
		assert.equal(refusal(() => openJournalStore({ directory: "relative", files: provisioned() })), "directory");
		const files = provisioned();
		files.user = undefined;
		assert.equal(refusal(() => openJournalStore({ directory: DIR, files })), "directory");
	});

	it("stops writing when the lock file is removed or replaced while the host lives", async () => {
		const files = provisioned();
		const { store, close } = openJournalStore({ directory: DIR, files });
		files.nodes.delete(LOCK);
		await assert.rejects(store.write(journal(2), 1));
		await assert.rejects(store.read());
		assert.equal(files.text(FILE), JSON.stringify(journal(1, "provisioned")));
		// Another process's lock at the same path is not this store's, and `close` leaves it.
		files.file(LOCK, "someone else's");
		await assert.rejects(store.write(journal(2), 1));
		await assert.rejects(close());
		assert.equal(files.text(LOCK), "someone else's");
	});
});

describe("the journal store's reads and writes", () => {
	it("reads a missing journal as none, and never creates one, not even by a write", async () => {
		const files = new FakeFiles();
		files.directory(DIR);
		const { store } = openJournalStore({ directory: DIR, files });
		assert.equal(await store.read(), undefined);
		await assert.rejects(store.write(journal(2), 1));
		await assert.rejects(store.write(journal(1), 0));
		assert.equal(files.nodes.has(FILE), false);
		assert.equal(files.nodes.has(TEMP), false);
	});

	it("replaces the journal at the revision it expects: temporary file flushed, renamed over it, directory flushed", async () => {
		const files = provisioned();
		const { store } = openJournalStore({ directory: DIR, files });
		files.log.length = 0;
		await store.write(journal(2, "g2"), 1);
		assert.deepEqual(await store.read(), journal(2, "g2"));
		assert.equal(files.nodes.has(TEMP), false);
		const order = files.log.filter((entry) => /^(fsync|rename)/.test(entry));
		assert.deepEqual(order, [`fsync ${TEMP}`, `rename ${TEMP} ${FILE}`, `fsync ${DIR}`]);
	});

	it("refuses a stale or skipped revision and changes nothing", async () => {
		const files = provisioned();
		const { store } = openJournalStore({ directory: DIR, files });
		await store.write(journal(2), 1);
		const stored = files.text(FILE);
		await assert.rejects(store.write(journal(2), 1), "stale: the stored revision is 2");
		await assert.rejects(store.write(journal(4), 3), "expected revision 3 isn't stored");
		await assert.rejects(store.write(journal(5), 2), "not the next revision");
		await assert.rejects(store.write(journal(2), 2), "not the next revision");
		assert.equal(files.text(FILE), stored);
	});

	it("runs writes one at a time, so two with the same expectation can't both land", async () => {
		const files = provisioned();
		const { store } = openJournalStore({ directory: DIR, files });
		const results = await Promise.allSettled([store.write(journal(2, "first"), 1), store.write(journal(2, "second"), 1)]);
		assert.deepEqual(results.map((result) => result.status), ["fulfilled", "rejected"]);
		assert.equal((JSON.parse(files.text(FILE)!) as Journal).generation, "first");
	});

	it("leaves the old journal whole when the flush, the write or the rename fails, and recovers the temporary file next time", async () => {
		for (const operation of ["write", "fsync", "rename"]) {
			const files = provisioned();
			const { store } = openJournalStore({ directory: DIR, files });
			const before = files.text(FILE);
			files.failNext.add(operation);
			await assert.rejects(store.write(journal(2), 1), operation);
			assert.equal(files.text(FILE), before, operation);
			// The temporary file may be left behind; it is never the journal, and the next write replaces it.
			await store.write(journal(2, "later"), 1);
			assert.equal((JSON.parse(files.text(FILE)!) as Journal).generation, "later", operation);
			assert.equal(files.nodes.has(TEMP), false, operation);
		}
	});

	it("reads what is stored and leaves judging it to the manager, but never writes over an invalid or open one", async () => {
		const files = provisioned();
		files.nodes.get(FILE)!.data = Buffer.from('{"version":1,"revision":"x"}');
		const { store } = openJournalStore({ directory: DIR, files });
		assert.deepEqual(await store.read(), { version: 1, revision: "x" });
		await assert.rejects(store.write(journal(2), 1));
		files.nodes.get(FILE)!.data = Buffer.from("not json");
		await assert.rejects(store.read());
		await assert.rejects(store.write(journal(2), 1));
		files.nodes.get(FILE)!.mode = 0o644;
		await assert.rejects(store.read());
		files.nodes.get(FILE)!.mode = 0o600;
		files.nodes.get(FILE)!.uid = OWNER_UID + 1;
		await assert.rejects(store.read());
		files.nodes.get(FILE)!.uid = OWNER_UID;
		files.nodes.get(FILE)!.nlink = 2;
		await assert.rejects(store.read());
		files.nodes.get(FILE)!.nlink = 1;
		files.nodes.get(FILE)!.data = Buffer.alloc(1024 * 1024 + 1, "a");
		await assert.rejects(store.read());
	});
});

describe("the journal store's descriptors", () => {
	it("refuses everything after a descriptor couldn't be seen to close, and keeps both errors when the work failed too", async () => {
		const files = provisioned();
		const { store } = openJournalStore({ directory: DIR, files });
		files.failNext.add("close");
		await assert.rejects(store.read(), /couldn't be closed/);
		const closes = files.log.filter((entry) => entry.startsWith("close")).length;
		await assert.rejects(store.read());
		await assert.rejects(store.write(journal(2), 1));
		assert.equal(files.log.filter((entry) => entry.startsWith("close")).length, closes, "a number whose close failed is not closed again");
		assert.equal(files.text(FILE), JSON.stringify(journal(1, "provisioned")));

		const both = provisioned();
		const second = openJournalStore({ directory: DIR, files: both });
		both.failNext.add("read");
		both.failNext.add("close");
		await assert.rejects(second.store.read(), (error: unknown) => error instanceof AggregateError && error.errors.length === 2);
	});

	it("leaves the lock where it is, and says so, when the lock's own descriptor can't be seen to close", async () => {
		const files = provisioned();
		const { close } = openJournalStore({ directory: DIR, files });
		files.failNext.add("close");
		await assert.rejects(close(), (error: unknown) => error instanceof JournalStoreRefused && error.reason === "close");
		assert.equal(files.nodes.has(LOCK), true);
		assert.equal(files.log.some((entry) => entry.startsWith("unlink")), false);
		await assert.rejects(close(), JournalStoreRefused, "a second close gets the first one's answer");
	});

	it("leaves the lock in place after a data descriptor failed to close, even though the lock's own closes", async () => {
		const files = provisioned();
		const { store, close } = openJournalStore({ directory: DIR, files });
		files.failNext.add("close");
		await assert.rejects(store.read());
		await assert.rejects(close());
		assert.equal(files.nodes.has(LOCK), true);
	});

	it("doesn't unlink a lock it made but couldn't close, when the lock isn't as it must be", () => {
		// A directory that is right but whose lock comes out another account's: the made lock is checked, refused, closed and removed.
		const refusedFiles = new FakeFiles();
		refusedFiles.directory(DIR);
		const open = refusedFiles.open.bind(refusedFiles);
		refusedFiles.open = (path: string, flags: number, mode?: number) => {
			const descriptor = open(path, flags, mode);
			if (path === LOCK) refusedFiles.nodes.get(LOCK)!.uid = OWNER_UID + 1;
			return descriptor;
		};
		refusedFiles.failNext.add("close");
		assert.equal(refusal(() => openJournalStore({ directory: DIR, files: refusedFiles })), "lock");
		assert.equal(refusedFiles.nodes.has(LOCK), true, "its descriptor may still be open, so the lock stays");
		assert.equal(refusedFiles.log.some((entry) => entry.startsWith("unlink")), false);
	});

	it("waits for the writes already queued before it releases the lock, and takes no later one", async () => {
		const files = provisioned();
		const { store, close } = openJournalStore({ directory: DIR, files });
		const written = store.write(journal(2, "queued"), 1);
		const closed = close();
		await written;
		await closed;
		assert.equal((JSON.parse(files.text(FILE)!) as Journal).generation, "queued");
		assert.equal(files.nodes.has(LOCK), false);
		await assert.rejects(store.write(journal(3), 2));
	});
});

describe("the native write loop", () => {
	const data = Buffer.from("0123456789");
	it("writes everything through partial writes", () => {
		const seen: number[] = [];
		writeFully(3, data, (_fd, _buffer, offset, length) => {
			seen.push(offset);
			return Math.min(4, length);
		});
		assert.deepEqual(seen, [0, 4, 8]);
	});

	it("rejects a write that takes nothing, or claims more than was left, instead of looping", () => {
		let calls = 0;
		assert.throws(() => writeFully(3, data, () => (calls++, 0)), /no progress/);
		assert.equal(calls, 1);
		assert.throws(() => writeFully(3, data, () => data.length + 1), /no progress/);
		assert.throws(() => writeFully(3, data, () => -1), /no progress/);
		assert.throws(() => writeFully(3, data, () => Number.NaN), /no progress/);
	});
});
