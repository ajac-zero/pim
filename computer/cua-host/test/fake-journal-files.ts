/**
 * An in-memory file system for the journal store's and the viewer host's
 * tests (../journal-store.ts `JournalFiles`): a directory, regular files
 * and symbolic links with owners, modes, link counts and inodes, `O_EXCL`
 * and rename that replaces, and a hook that makes any named operation fail.
 * It touches no real file, and runs nothing. It is a helper, not a test:
 * `node --test test/*.test.ts` does not match its name.
 */

import { Buffer } from "node:buffer";
import * as fs from "node:fs";
import type { JournalFiles, JournalStat } from "../journal-store.ts";

type Node = { kind: "file" | "dir" | "link"; ino: number; uid: number; mode: number; nlink: number; data: Buffer };

export const OWNER_UID = 1001;

const error = (code: string) => Object.assign(new Error(code), { code });

export class FakeFiles implements JournalFiles {
	readonly nodes = new Map<string, Node>();
	/** Every operation, in order, as `name path-or-descriptor`. */
	readonly log: string[] = [];
	/** Makes the next operation with this name (`fsync`, `rename`, `write`, `unlink`) throw once. */
	readonly failNext = new Set<string>();
	#descriptors = new Map<number, { node: Node; path: string }>();
	#next = 10;
	#ino = 1;
	/** The effective user of the process under test. */
	user: number | undefined = OWNER_UID;

	/** Makes a directory of this account's, closed to others unless `mode` says otherwise. */
	directory(path: string, mode = 0o700, uid = OWNER_UID): void {
		this.nodes.set(path, { kind: "dir", ino: this.#ino++, uid, mode, nlink: 2, data: Buffer.alloc(0) });
	}

	/** Makes a regular file with `data`, of this account's with mode 0600 unless said otherwise. */
	file(path: string, data: string | Buffer, mode = 0o600, uid = OWNER_UID): void {
		this.nodes.set(path, { kind: "file", ino: this.#ino++, uid, mode, nlink: 1, data: Buffer.from(data) });
	}

	link(path: string): void {
		this.nodes.set(path, { kind: "link", ino: this.#ino++, uid: OWNER_UID, mode: 0o777, nlink: 1, data: Buffer.alloc(0) });
	}

	text(path: string): string | undefined {
		return this.nodes.get(path)?.data.toString("utf8");
	}

	#stat(node: Node): JournalStat {
		return {
			isFile: () => node.kind === "file",
			isDirectory: () => node.kind === "dir",
			isSymbolicLink: () => node.kind === "link",
			uid: node.uid,
			mode: node.mode,
			nlink: node.nlink,
			size: node.data.length,
			dev: 1,
			ino: node.ino,
		};
	}

	#step(operation: string, subject: string | number): void {
		this.log.push(`${operation} ${subject}`);
		if (this.failNext.delete(operation)) throw error("EIO");
	}

	open(path: string, flags: number, mode = 0o666): number {
		this.#step("open", path);
		let node = this.nodes.get(path);
		if (node?.kind === "link" && flags & fs.constants.O_NOFOLLOW) throw error("ELOOP");
		if (node && flags & fs.constants.O_CREAT && flags & fs.constants.O_EXCL) throw error("EEXIST");
		if (!node) {
			if (!(flags & fs.constants.O_CREAT)) throw error("ENOENT");
			node = { kind: "file", ino: this.#ino++, uid: this.user ?? 0, mode, nlink: 1, data: Buffer.alloc(0) };
			this.nodes.set(path, node);
		}
		const descriptor = this.#next++;
		this.#descriptors.set(descriptor, { node, path });
		return descriptor;
	}

	#held(descriptor: number) {
		const held = this.#descriptors.get(descriptor);
		if (!held) throw error("EBADF");
		return held;
	}

	fstat(descriptor: number): JournalStat {
		return this.#stat(this.#held(descriptor).node);
	}

	lstat(path: string): JournalStat {
		const node = this.nodes.get(path);
		if (!node) throw error("ENOENT");
		return this.#stat(node);
	}

	read(descriptor: number, max: number): Buffer {
		this.#step("read", descriptor);
		return Buffer.from(this.#held(descriptor).node.data.subarray(0, max + 1));
	}

	write(descriptor: number, data: Buffer): void {
		this.#step("write", descriptor);
		const { node } = this.#held(descriptor);
		node.data = Buffer.concat([node.data, data]);
	}

	fsync(descriptor: number): void {
		this.#step("fsync", this.#held(descriptor).path);
	}

	close(descriptor: number): void {
		this.#step("close", this.#held(descriptor).path);
		this.#descriptors.delete(descriptor);
	}

	rename(from: string, to: string): void {
		this.#step("rename", `${from} ${to}`);
		const node = this.nodes.get(from);
		if (!node) throw error("ENOENT");
		this.nodes.delete(from);
		this.nodes.set(to, node);
	}

	unlink(path: string): void {
		this.#step("unlink", path);
		if (!this.nodes.delete(path)) throw error("ENOENT");
	}

	uid(): number | undefined {
		return this.user;
	}

	/** `mkdir(2)` without `-p`: a directory of the effective user's, `EEXIST` if anything is there. */
	mkdir(path: string, mode: number): void {
		this.#step("mkdir", path);
		if (this.nodes.has(path)) throw error("EEXIST");
		this.nodes.set(path, { kind: "dir", ino: this.#ino++, uid: this.user ?? 0, mode, nlink: 2, data: Buffer.alloc(0) });
	}

	chown(path: string, uid: number, _gid: number): void {
		this.#step("chown", path);
		const node = this.nodes.get(path);
		if (!node) throw error("ENOENT");
		node.uid = uid;
	}

	fchown(descriptor: number, uid: number, _gid: number): void {
		this.#step("fchown", this.#held(descriptor).path);
		this.#held(descriptor).node.uid = uid;
	}
}
