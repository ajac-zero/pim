import type { Workspace } from "@cloudflare/computer";
import { HttpError } from "./http";

/**
 * The person's files: a folder in their Pim that they and their agents
 * share. It is a `@cloudflare/computer` Workspace kept in the Pim's own
 * SQLite, so files count toward the Pim's storage and go with it when the
 * account is deleted. Everything here, and every file tool, stays under
 * `FILES_ROOT`; the Workspace's other paths are its own.
 */
export const FILES_ROOT = "/workspace";

/** The largest file the app can upload. */
export const MAX_UPLOAD_BYTES = 25_000_000;

/** How many bytes of files an export carries inline; the rest are listed by path. */
const EXPORT_INLINE_BYTES = 32_000_000;

export type FileEntry = {
	readonly name: string;
	/** Absolute, under `FILES_ROOT`. */
	readonly path: string;
	readonly type: "file" | "directory";
	readonly size: number;
	readonly updatedAt: string;
};

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

function isMissing(error: unknown): boolean {
	return (error as { code?: string } | null)?.code === "ENOENT";
}

export class Files {
	readonly #workspace: () => Workspace;

	constructor(workspace: () => Workspace) {
		this.#workspace = workspace;
	}

	get #fs() {
		return this.#workspace().fs;
	}

	async #stat(path: string) {
		try {
			return await this.#fs.stat(path);
		} catch (error) {
			if (isMissing(error)) return null;
			throw error;
		}
	}

	/** A folder's entries, folders first, then by name. The root exists even before the first file. */
	async list(path: unknown): Promise<{ path: string; entries: FileEntry[] }> {
		const folder = checkedPath(path);
		if (folder === FILES_ROOT) await this.#fs.mkdir(FILES_ROOT, { recursive: true });
		const stat = await this.#stat(folder);
		if (!stat) throw new HttpError(404, `No folder ${folder}`);
		if (!stat.isDirectory) throw new HttpError(400, `${folder} is a file, not a folder`);
		const entries = (await this.#fs.readdir(folder))
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
		const stat = await this.#stat(file);
		if (!stat?.isFile) throw new HttpError(404, `No file ${file}`);
		const name = file.slice(file.lastIndexOf("/") + 1);
		return { path: file, name, size: stat.size, type: fileType(name), body: await this.#fs.readFile(file) };
	}

	/** Saves `body` at `path`, making its folders, and replacing a file already there. */
	async write(path: unknown, body: Uint8Array): Promise<FileEntry> {
		const file = checkedPath(path);
		if (file === FILES_ROOT) throw new HttpError(400, "path must name a file");
		const existing = await this.#stat(file);
		if (existing?.isDirectory) throw new HttpError(409, `${file} is a folder`);
		await this.#fs.mkdir(file.slice(0, file.lastIndexOf("/")), { recursive: true });
		await this.#fs.writeFile(file, body);
		const stat = await this.#fs.stat(file);
		return { name: stat.name, path: file, type: "file", size: stat.size, updatedAt: new Date(stat.mtime).toISOString() };
	}

	/** Deletes a file, or a folder with everything in it. */
	async remove(path: unknown): Promise<void> {
		const target = checkedPath(path);
		if (target === FILES_ROOT) throw new HttpError(400, "The files folder itself can't be deleted");
		try {
			await this.#fs.rm(target, { recursive: true });
		} catch (error) {
			if (isMissing(error)) throw new HttpError(404, `No file or folder ${target}`);
			throw error;
		}
	}

	/**
	 * Every file, for the account export: text as text, anything else as
	 * base64. Past `EXPORT_INLINE_BYTES` files are listed without their
	 * content, which the Files view still downloads.
	 */
	async export(): Promise<{ path: string; size: number; updatedAt: string; encoding?: "utf8" | "base64"; content?: string }[]> {
		const files = [];
		let inlined = 0;
		const pending = [FILES_ROOT];
		while (pending.length > 0) {
			const folder = pending.pop()!;
			let entries;
			try {
				entries = await this.#fs.readdir(folder);
			} catch (error) {
				if (isMissing(error)) continue;
				throw error;
			}
			for (const entry of entries) {
				const path = `${folder}/${entry.name}`;
				if (entry.isDirectory) pending.push(path);
				if (!entry.isFile) continue;
				const described = { path, size: entry.size, updatedAt: new Date(entry.mtime).toISOString() };
				if (inlined + entry.size > EXPORT_INLINE_BYTES) {
					files.push(described);
					continue;
				}
				inlined += entry.size;
				const bytes = new Uint8Array(await new Response(await this.#fs.readFile(path)).arrayBuffer());
				try {
					files.push({ ...described, encoding: "utf8" as const, content: new TextDecoder("utf-8", { fatal: true, ignoreBOM: false }).decode(bytes) });
				} catch {
					let binary = "";
					for (const byte of bytes) binary += String.fromCharCode(byte);
					files.push({ ...described, encoding: "base64" as const, content: btoa(binary) });
				}
			}
		}
		return files.sort((a, b) => a.path.localeCompare(b.path));
	}
}
