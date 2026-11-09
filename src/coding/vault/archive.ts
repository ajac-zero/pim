/**
 * The archive the vault encrypts (./vault.ts): a harness's config files as
 * one buffer. It holds regular files only, by paths relative to the CLI's
 * config directory, each with its permission bits. Packing and unpacking
 * check every path the same way, so an archive can only ever name files
 * inside that directory: no absolute paths, no `..`, no symlinks or
 * directories, and, when an allowlist is given, only the files on it.
 *
 * Layout, big-endian: the magic `PCVA`, a format byte (1), a u16 count of
 * files, then for each file a u16 path length, the UTF-8 path, u16 mode,
 * u32 size and the bytes. Files are sorted by path, so the same files
 * always pack to the same bytes. Nothing may follow the last file.
 */

/** The most an archive may hold in all, header included. */
export const MAX_ARCHIVE_BYTES = 512 * 1024;
/** The most files an archive may hold. */
export const MAX_ARCHIVE_FILES = 32;
/** The longest path, in UTF-8 bytes. */
export const MAX_PATH_BYTES = 255;

const MAGIC = [0x50, 0x43, 0x56, 0x41]; // "PCVA"
const FORMAT = 1;
const HEADER_BYTES = MAGIC.length + 1 + 2;
const ENTRY_HEADER_BYTES = 2 + 2 + 4;

/** One file of an archive. `type` is what the workspace said the path is; only "file" may be packed. */
export type ArchiveFile = { readonly path: string; readonly mode: number; readonly data: Uint8Array; readonly type?: "file" | "dir" | "symlink" };

/** An archive or a file for one is not acceptable; the message says why, never what a file holds. */
export class ArchiveError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "ArchiveError";
	}
}

const encoder = new TextEncoder();
const decoder = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });

/** Checks a path as an archive may hold it: relative, plain segments, and on the allowlist when one is given. */
export function checkArchivePath(path: unknown, allowed?: readonly string[]): string {
	if (typeof path !== "string" || path === "") throw new ArchiveError("An archived path must be a non-empty string");
	if (encoder.encode(path).byteLength > MAX_PATH_BYTES) throw new ArchiveError(`An archived path is longer than ${MAX_PATH_BYTES} bytes`);
	// Control characters include NUL; a backslash would be a separator on some systems.
	if (/[\u0000-\u001f\u007f\\]/.test(path)) throw new ArchiveError("An archived path has a control character or a backslash");
	if (path.startsWith("/")) throw new ArchiveError("An archived path must be relative");
	for (const segment of path.split("/")) {
		if (segment === "" || segment === "." || segment === "..") throw new ArchiveError("An archived path must not have empty, `.` or `..` segments");
	}
	if (allowed && !allowed.includes(path)) throw new ArchiveError("An archived path is not on the harness's list of files");
	return path;
}

function checkMode(mode: unknown): number {
	if (typeof mode !== "number" || !Number.isInteger(mode) || mode < 0 || mode > 0o777) throw new ArchiveError("An archived file's mode must be permission bits, 0 to 0o777");
	return mode;
}

/** Packs regular files into one archive, refusing anything an unpack would refuse. */
export function packArchive(files: readonly ArchiveFile[], allowed?: readonly string[]): Uint8Array<ArrayBuffer> {
	if (files.length > MAX_ARCHIVE_FILES) throw new ArchiveError(`An archive holds at most ${MAX_ARCHIVE_FILES} files`);
	const seen = new Set<string>();
	const entries = files.map((file) => {
		if ((file.type ?? "file") !== "file") throw new ArchiveError("An archive holds regular files only");
		const path = checkArchivePath(file.path, allowed);
		if (seen.has(path)) throw new ArchiveError("An archive holds each path once");
		seen.add(path);
		if (!(file.data instanceof Uint8Array)) throw new ArchiveError("An archived file's data must be bytes");
		return { path: encoder.encode(path), mode: checkMode(file.mode), data: file.data, key: path };
	});
	entries.sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
	const total = entries.reduce((sum, entry) => sum + ENTRY_HEADER_BYTES + entry.path.byteLength + entry.data.byteLength, HEADER_BYTES);
	if (total > MAX_ARCHIVE_BYTES) throw new ArchiveError(`An archive holds at most ${MAX_ARCHIVE_BYTES} bytes`);
	const out = new Uint8Array(total);
	const view = new DataView(out.buffer);
	out.set(MAGIC, 0);
	view.setUint8(4, FORMAT);
	view.setUint16(5, entries.length);
	let at = HEADER_BYTES;
	for (const entry of entries) {
		view.setUint16(at, entry.path.byteLength);
		out.set(entry.path, at + 2);
		at += 2 + entry.path.byteLength;
		view.setUint16(at, entry.mode);
		view.setUint32(at + 2, entry.data.byteLength);
		out.set(entry.data, at + 6);
		at += 6 + entry.data.byteLength;
	}
	return out;
}

/** Reads an archive back, checking it as strictly as packing does, since its bytes may come from anywhere. */
export function unpackArchive(bytes: Uint8Array, allowed?: readonly string[]): ArchiveFile[] {
	if (bytes.byteLength > MAX_ARCHIVE_BYTES) throw new ArchiveError(`An archive holds at most ${MAX_ARCHIVE_BYTES} bytes`);
	if (bytes.byteLength < HEADER_BYTES || MAGIC.some((byte, i) => bytes[i] !== byte)) throw new ArchiveError("This is not a vault archive");
	const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
	if (view.getUint8(4) !== FORMAT) throw new ArchiveError("This vault archive's format is not one Pim reads");
	const count = view.getUint16(5);
	if (count > MAX_ARCHIVE_FILES) throw new ArchiveError(`An archive holds at most ${MAX_ARCHIVE_FILES} files`);
	const need = (at: number, length: number) => {
		if (at + length > bytes.byteLength) throw new ArchiveError("This vault archive is cut short");
	};
	const files: ArchiveFile[] = [];
	const seen = new Set<string>();
	let at = HEADER_BYTES;
	for (let i = 0; i < count; i++) {
		need(at, 2);
		const pathLength = view.getUint16(at);
		if (pathLength > MAX_PATH_BYTES) throw new ArchiveError(`An archived path is longer than ${MAX_PATH_BYTES} bytes`);
		need(at + 2, pathLength + 6);
		let path: string;
		try {
			path = decoder.decode(bytes.subarray(at + 2, at + 2 + pathLength));
		} catch {
			throw new ArchiveError("An archived path is not UTF-8");
		}
		checkArchivePath(path, allowed);
		if (seen.has(path)) throw new ArchiveError("An archive holds each path once");
		seen.add(path);
		at += 2 + pathLength;
		const mode = checkMode(view.getUint16(at));
		const size = view.getUint32(at + 2);
		need(at + 6, size);
		files.push({ path, mode, data: bytes.slice(at + 6, at + 6 + size), type: "file" });
		at += 6 + size;
	}
	if (at !== bytes.byteLength) throw new ArchiveError("This vault archive has bytes after its last file");
	return files;
}
