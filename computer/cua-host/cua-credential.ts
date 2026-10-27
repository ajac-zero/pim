/**
 * The spacesd credential a Cua computer (./cua-computer.ts) gets from the
 * desktop endpoint (./desktop.ts): a file the operator would put on the VM,
 * which the endpoint opens and hands its child as one read-only descriptor,
 * `CREDENTIAL_FD` (3), and which the child reads, bounded, and closes before
 * it takes any call. The bytes are never in an argument, a variable, standard
 * input or output, a log, an error or a result; the endpoint never reads them
 * at all.
 *
 * Every close is tried once and reported: one that throws, for whatever
 * reason, is refused `close` with `retained` set, never taken as done, and the
 * number is never closed again, since it may by then name another file. The
 * endpoint then takes no more connections; the child doesn't start serving.
 *
 * What it guards against is accidents: the token turning up in a process
 * listing, an environment a command inherits, a log line, or a descriptor a
 * shell or browser the child starts would keep. It is not a boundary between
 * agents. The file is the desktop user's, mode 0600, and every agent of the
 * space runs as that user, so any command an agent runs can read it, as it can
 * do anything else the desktop user can: they share the credential and the
 * OS's authority. Nor does it assume spacesd can give a token narrower than its
 * own. How such a file is made, rotated and put on a VM, and what else a guest
 * must be, are not decided here.
 *
 * Importing it does nothing.
 */

import { Buffer } from "node:buffer";
import * as fs from "node:fs";
import * as path from "node:path";

/** The descriptor the child reads its credential from. */
export const CREDENTIAL_FD = 3;

/** The longest token spacesd's client takes (`createNativeMcp`), in printable ASCII. */
export const MAX_TOKEN_BYTES = 4096;

/** The largest credential file: the token, and one newline after it. */
export const MAX_CREDENTIAL_BYTES = MAX_TOKEN_BYTES + 1;

/** Why a credential was refused: a fixed reason, never the file's path or bytes. */
export class CredentialRefused extends Error {
	readonly reason: string;
	/**
	 * Whether a descriptor of the credential may still be open: only when
	 * closing it failed (`close`). Its number is never closed again, since by
	 * then it may name another file; whoever holds it must stop taking work.
	 */
	readonly retained: boolean;
	constructor(reason: string, retained = false) {
		super(`The Cua spacesd credential was refused (${reason}).`);
		this.reason = reason;
		this.retained = retained;
	}
}

/** What is read of a file's status; Node's `fs.Stats` has it, and tests give stand-ins. */
export type CredentialStat = {
	isFile(): boolean;
	readonly uid: number;
	readonly mode: number;
	readonly nlink: number;
	readonly size: number;
};

/** What the endpoint opens the file with: Node's `fs` unless a test gives its own. It never reads. */
export type CredentialFiles = {
	realpath(file: string): string;
	open(file: string, flags: number): number;
	fstat(fd: number): CredentialStat;
	close(fd: number): void;
};

/** What the child reads its descriptor with: Node's `fs` unless a test gives its own. */
export type CredentialReader = {
	fstat(fd: number): CredentialStat;
	/** Reads into `buffer` at `offset`, at most `length` bytes, from `position` in the file; 0 at its end. */
	read(fd: number, buffer: Buffer, offset: number, length: number, position: number): number;
	close(fd: number): void;
};

export const NODE_CREDENTIAL_FILES: CredentialFiles = {
	realpath: (file) => fs.realpathSync(file),
	open: (file, flags) => fs.openSync(file, flags),
	fstat: (fd) => fs.fstatSync(fd),
	close: (fd) => fs.closeSync(fd),
};

export const NODE_CREDENTIAL_READER: CredentialReader = {
	fstat: (fd) => fs.fstatSync(fd),
	read: (fd, buffer, offset, length, position) => fs.readSync(fd, buffer, offset, length, position),
	close: (fd) => fs.closeSync(fd),
};

/**
 * Read-only, without following a link at the last step, without waiting on a
 * FIFO, and never as a controlling terminal. Node opens every file
 * close-on-exec, so only a child that is handed it explicitly gets it.
 */
const OPEN_FLAGS = fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK | fs.constants.O_NOCTTY;

function user(uid: number | undefined): number {
	if (uid === undefined || !Number.isSafeInteger(uid) || uid < 0) throw new CredentialRefused("user");
	if (uid === 0) throw new CredentialRefused("root-user");
	return uid;
}

/** A regular file of `uid`'s, mode exactly 0600, with one name, of 1 to `MAX_CREDENTIAL_BYTES` bytes. */
function checkStat(stat: CredentialStat, uid: number): void {
	if (!stat.isFile()) throw new CredentialRefused("not-file");
	if (stat.uid !== uid || (stat.mode & 0o7777) !== 0o600) throw new CredentialRefused("mode");
	if (stat.nlink !== 1) throw new CredentialRefused("links");
	if (!Number.isSafeInteger(stat.size) || stat.size < 1 || stat.size > MAX_CREDENTIAL_BYTES) throw new CredentialRefused("size");
}

/**
 * Closes `fd`, once. A close that throws is not taken as closed, whatever the
 * error: it throws `CredentialRefused("close")` with `retained` set, and the
 * caller must neither close that number again (it may since name another
 * file) nor go on as if the descriptor were gone.
 */
function closeOnce(close: (fd: number) => void, fd: number): void {
	try {
		close(fd);
	} catch {
		throw new CredentialRefused("close", true);
	}
}

/** Closes a descriptor `openCredential` returned, once; throws `CredentialRefused("close")`, `retained`, when that fails. */
export function closeCredential(fd: number, files: CredentialFiles = NODE_CREDENTIAL_FILES): void {
	closeOnce((open) => files.close(open), fd);
}

/**
 * Opens the credential file for one child and checks what was opened: the
 * endpoint's side. `file` must be absolute and its own real path (no `..`,
 * no link anywhere on it). Returns the descriptor, which the caller hands to
 * the child as `CREDENTIAL_FD` and closes with `closeCredential` as soon as
 * the spawn returns or throws. The bytes are not read. A refusal before a
 * descriptor was returned (`user`, `root-user`, `path`, `open`) holds none to
 * close; one after (the file's status) closes it once, and if that close
 * throws, the refusal is `close`, `retained`, instead.
 */
export function openCredential(file: string, uid: number | undefined, files: CredentialFiles = NODE_CREDENTIAL_FILES): number {
	const owner = user(uid);
	let real: string | null = null;
	try {
		real = typeof file === "string" && path.isAbsolute(file) ? files.realpath(file) : null;
	} catch {
		// Refused below.
	}
	if (real === null || real !== file) throw new CredentialRefused("path");
	let fd: number;
	try {
		fd = files.open(file, OPEN_FLAGS);
	} catch {
		throw new CredentialRefused("open");
	}
	try {
		checkStat(files.fstat(fd), owner);
	} catch (error) {
		const refusal = error instanceof CredentialRefused ? error : new CredentialRefused("stat");
		closeCredential(fd, files);
		throw refusal;
	}
	return fd;
}

/**
 * Reads the token from `fd` and then closes it, once, whatever the read did:
 * the child's side, before it takes any call. The descriptor must be a
 * regular file as `openCredential` checks; it is read from its start, by
 * position, to its end or one byte past `MAX_CREDENTIAL_BYTES`, whichever
 * comes first. The token is its bytes, less one newline at the end: 1 to
 * `MAX_TOKEN_BYTES` printable ASCII characters, no spaces. The buffer it was
 * read into is zeroed; the string returned can't be, and stays in the
 * process's memory.
 *
 * The token is returned only when the close returned. A close that throws,
 * after a good read or a refused one, is refused `close`, `retained`, and the
 * token read is dropped: the caller must not go on to take work. The
 * descriptor is closed even when its status can't be read, since it may still
 * be open; if it wasn't (no descriptor 3), that close fails too, and the start
 * is refused all the same.
 */
export function readCredential(fd: number, uid: number | undefined, reader: CredentialReader = NODE_CREDENTIAL_READER): string {
	const buffer = Buffer.alloc(MAX_CREDENTIAL_BYTES + 1);
	let token: string | undefined;
	let refusal: CredentialRefused | undefined;
	try {
		token = readOpen(fd, uid, reader, buffer);
	} catch (error) {
		refusal = error instanceof CredentialRefused ? error : new CredentialRefused("read");
	} finally {
		buffer.fill(0);
	}
	closeOnce((open) => reader.close(open), fd);
	if (refusal || token === undefined) throw refusal ?? new CredentialRefused("read");
	return token;
}

/** The token in `fd`, read into `buffer`, which the caller zeroes; `fd` is left open. */
function readOpen(fd: number, uid: number | undefined, reader: CredentialReader, buffer: Buffer): string {
	const owner = user(uid);
	let stat: CredentialStat;
	try {
		stat = reader.fstat(fd);
	} catch {
		throw new CredentialRefused("descriptor");
	}
	checkStat(stat, owner);
	let length = 0;
	while (length < buffer.length) {
		let read: number;
		try {
			read = reader.read(fd, buffer, length, buffer.length - length, length);
		} catch {
			throw new CredentialRefused("read");
		}
		if (!Number.isSafeInteger(read) || read < 0 || read > buffer.length - length) throw new CredentialRefused("read");
		if (read === 0) break;
		length += read;
	}
	if (length > MAX_CREDENTIAL_BYTES) throw new CredentialRefused("size");
	const end = length > 0 && buffer[length - 1] === 0x0a ? length - 1 : length;
	if (end < 1 || end > MAX_TOKEN_BYTES) throw new CredentialRefused("format");
	for (let index = 0; index < end; index++) {
		const byte = buffer[index]!;
		if (byte < 0x21 || byte > 0x7e) throw new CredentialRefused("format");
	}
	return buffer.toString("latin1", 0, end);
}
