import type { Computer } from "./computer";
import { HttpError } from "./http";

/**
 * The person's files: a folder on their computer (./computer.ts) that they
 * and their agents share, which agents and the app name `FILES_ROOT`. The
 * app shows it as Files, while a computer is connected; agents work with it
 * through the file tools and `shell`. The files are the computer's: the space
 * keeps no copy, and they stay there when the computer is removed.
 */
export const FILES_ROOT = "/workspace";

/** The largest file the app can upload. */
export const MAX_UPLOAD_BYTES = 25_000_000;

export type FileEntry = {
	readonly name: string;
	/** Absolute, under `FILES_ROOT`. */
	readonly path: string;
	readonly type: "file" | "directory";
	readonly size: number;
	readonly updatedAt: string;
};

/** The most entries a folder lists in the app. */
const MAX_LISTED = 1000;

/**
 * `path` resolved (`.`, `..`, repeated and trailing slashes), or null when
 * it isn't absolute or leaves `FILES_ROOT`.
 */
export function filesPath(path: unknown): string | null {
	if (typeof path !== "string" || !path.startsWith("/") || path.includes("\0")) return null;
	const parts: string[] = [];
	for (const part of path.split("/")) {
		if (part === "" || part === ".") continue;
		if (part === "..") {
			if (parts.length === 0) return null;
			parts.pop();
		} else parts.push(part);
	}
	const resolved = `/${parts.join("/")}`;
	return resolved === FILES_ROOT || resolved.startsWith(`${FILES_ROOT}/`) ? resolved : null;
}

function checkedPath(path: unknown): string {
	const resolved = filesPath(path);
	if (resolved === null) throw new HttpError(400, `path must be an absolute path under ${FILES_ROOT}`);
	return resolved;
}

const TYPES: Record<string, string> = {
	txt: "text/plain",
	md: "text/markdown",
	csv: "text/csv",
	tsv: "text/tab-separated-values",
	json: "application/json",
	png: "image/png",
	jpg: "image/jpeg",
	jpeg: "image/jpeg",
	gif: "image/gif",
	webp: "image/webp",
	avif: "image/avif",
	pdf: "application/pdf",
	mp3: "audio/mpeg",
	wav: "audio/wav",
	mp4: "video/mp4",
	webm: "video/webm",
};

/**
 * The type a file is served as, from its name. Anything a browser would run
 * as a document of this origin (HTML, SVG, XML) is served as plain text.
 */
export function fileType(name: string): string {
	const extension = name.includes(".") ? name.slice(name.lastIndexOf(".") + 1).toLowerCase() : "";
	const type = TYPES[extension];
	if (type?.startsWith("text/") || type === "application/json") return `${type}; charset=utf-8`;
	return type ?? "text/plain; charset=utf-8";
}

/**
 * Headers for a file's bytes. However a browser opens them, they are inert:
 * never run as a page of this origin, and never sniffed into another type.
 */
export function fileHeaders(file: { name: string; size: number; type: string }, download: boolean): Headers {
	const headers = new Headers({
		"content-type": file.type,
		"content-length": String(file.size),
		"content-security-policy": "default-src 'none'; sandbox",
		"x-content-type-options": "nosniff",
		"cache-control": "no-store, private",
		"cross-origin-resource-policy": "same-origin",
		"referrer-policy": "no-referrer",
	});
	if (download) {
		const utf8 = file.name.normalize("NFC").replace(/[\u0000-\u001f\u007f"\\]+/g, "_");
		const ascii = utf8.replace(/[^\x20-\x7e]+/g, "_").replace(/[;%]+/g, "_");
		headers.set("content-disposition", `attachment; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(utf8)}`);
	}
	return headers;
}

/** An image's type, from its first bytes, for the types models take; else null. */
export function imageType(bytes: Uint8Array): string | null {
	const starts = (...values: number[]) => values.every((value, index) => bytes[index] === value);
	const ascii = (from: number, to: number) => String.fromCharCode(...bytes.subarray(from, to));
	if (starts(0x89, 0x50, 0x4e, 0x47)) return "image/png";
	if (starts(0xff, 0xd8, 0xff)) return "image/jpeg";
	if (ascii(0, 4) === "GIF8") return "image/gif";
	if (ascii(0, 4) === "RIFF" && ascii(8, 12) === "WEBP") return "image/webp";
	return null;
}

function isMissing(error: unknown): boolean {
	return (error as { code?: string } | null)?.code === "ENOENT";
}

/** What the computer refused, as the API answers it: what's missing is 404, what's outside the files 403. */
function answer(error: unknown, missing: string): unknown {
	const code = (error as { code?: string } | null)?.code;
	if (code === "ENOENT") return new HttpError(404, missing);
	if (code === "EACCES") return new HttpError(403, (error as Error).message);
	if (code === "ENOTDIR" || code === "EISDIR") return new HttpError(400, (error as Error).message);
	return error;
}

/** The person's files, as the app and Pim's own tools use them: on the computer, under `FILES_ROOT`. */
export class Files {
	readonly #computer: Computer;

	constructor(computer: Computer) {
		this.#computer = computer;
	}

	get #fs() {
		return this.#computer.fs;
	}

	/** A folder's entries, folders first, then by name. */
	async list(path: unknown): Promise<{ path: string; entries: FileEntry[] }> {
		const folder = checkedPath(path);
		let listed;
		try {
			listed = await this.#fs.readdir(folder, { limit: MAX_LISTED });
		} catch (error) {
			throw answer(error, `No folder ${folder}`);
		}
		const entries = listed
			.filter((entry) => entry.isFile || entry.isDirectory)
			.map(
				(entry): FileEntry => ({
					name: entry.name,
					path: `${folder}/${entry.name}`,
					type: entry.isDirectory ? "directory" : "file",
					size: entry.isDirectory ? 0 : entry.size,
					updatedAt: new Date(entry.mtime).toISOString(),
				}),
			)
			.sort((a, b) => (a.type === b.type ? a.name.localeCompare(b.name) : a.type === "directory" ? -1 : 1));
		return { path: folder, entries };
	}

	/** A file's bytes and what to serve them as. */
	async read(path: unknown): Promise<{ path: string; name: string; size: number; type: string; body: ReadableStream<Uint8Array> }> {
		const file = checkedPath(path);
		const name = file.slice(file.lastIndexOf("/") + 1);
		try {
			const stat = await this.#fs.stat(file);
			if (!stat.isFile) throw new HttpError(404, `No file ${file}`);
			return { path: file, name, size: stat.size, type: fileType(name), body: await this.#fs.readFile(file) };
		} catch (error) {
			throw answer(error, `No file ${file}`);
		}
	}

	/** A file's bytes, whole. */
	async bytes(path: unknown): Promise<Uint8Array> {
		return new Uint8Array(await new Response((await this.read(path)).body).arrayBuffer());
	}

	/** Saves `body` at `path`, making its folders, and replacing a file already there. */
	async write(path: unknown, body: Uint8Array): Promise<FileEntry> {
		const file = checkedPath(path);
		if (file === FILES_ROOT) throw new HttpError(400, "path must name a file");
		const existing = await this.#fs.stat(file).catch((error) => {
			if (isMissing(error)) return null;
			throw answer(error, `No file ${file}`);
		});
		if (existing?.isDirectory) throw new HttpError(409, `${file} is a folder`);
		let stat;
		try {
			await this.#fs.mkdir(file.slice(0, file.lastIndexOf("/")), { recursive: true });
			await this.#fs.writeFile(file, body);
			stat = await this.#fs.stat(file);
		} catch (error) {
			throw answer(error, `No folder for ${file}`);
		}
		return { name: file.slice(file.lastIndexOf("/") + 1), path: file, type: "file", size: stat.size, updatedAt: new Date(stat.mtime).toISOString() };
	}

	/** Whether there is a file or folder at `path`. */
	async exists(path: string): Promise<boolean> {
		try {
			await this.#fs.stat(path);
			return true;
		} catch (error) {
			if (isMissing(error)) return false;
			throw error;
		}
	}

	/** Deletes a file, or a folder with everything in it. */
	async remove(path: unknown): Promise<void> {
		const target = checkedPath(path);
		if (target === FILES_ROOT) throw new HttpError(400, "The files folder itself can't be deleted");
		try {
			await this.#fs.rm(target, { recursive: true });
		} catch (error) {
			throw answer(error, `No file or folder ${target}`);
		}
	}
}
