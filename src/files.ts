import { Buffer } from "node:buffer";
import type { Workspace } from "@cloudflare/computer";
import { WorkerJavaScriptBackend } from "@cloudflare/computer/backends/worker-javascript";
import { HttpError } from "./http";

/**
 * The person's files: a folder in their space that they and their agents
 * share. Text is a `@cloudflare/computer` Workspace kept in the space's own
 * SQLite; other files are kept in R2 (see `Files`). Both count toward the
 * space's storage and go with it when the account is deleted. Everything
 * here, and every file tool, stays under `FILES_ROOT`; the Workspace's other
 * paths are its own.
 */
export const FILES_ROOT = "/workspace";

/** The Workspace backend that runs agents' JavaScript (`run_javascript`). */
export const CODE_BACKEND = "javascript";

/**
 * The Worker Loader that runs agents' code, when the deployment has one: a
 * `worker_loaders` binding named `LOADER`, which needs the Workers Paid plan.
 */
export function codeLoader(env: object): WorkerLoader | null {
	return (env as { LOADER?: WorkerLoader }).LOADER ?? null;
}

/**
 * The Workspace's backends: JavaScript in a fresh Dynamic Worker for each
 * run, which reads and writes the files under `FILES_ROOT` and nothing
 * else. It has no network, so nothing leaves the space except through
 * Pim's own tools and their approvals.
 */
export function codeBackends(env: object): WorkerJavaScriptBackend[] {
	const loader = codeLoader(env);
	if (!loader) return [];
	return [
		new WorkerJavaScriptBackend({
			id: CODE_BACKEND,
			loader,
			root: FILES_ROOT,
			egress: { mode: "none" },
			defaultTimeoutMs: 60_000,
			maxTimeoutMs: 60_000,
		}),
	];
}

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

/** How much of a file decides whether it is text. */
const SNIFF_BYTES = 8192;

/**
 * Whether bytes are text, judged by their start: UTF-8 with no NUL bytes.
 * Text stays in the Workspace, where agents search, edit and run code on
 * it; anything else is a stored file (see `Files`).
 */
export function isText(bytes: Uint8Array): boolean {
	const head = bytes.subarray(0, SNIFF_BYTES);
	if (head.includes(0)) return false;
	try {
		// `stream` lets a character cut off at the end of the sample through.
		new TextDecoder("utf-8", { fatal: true, ignoreBOM: false }).decode(head, { stream: true });
		return true;
	} catch {
		return false;
	}
}

/** An image's type, from its first bytes, for the types models take; else null. */
function imageType(bytes: Uint8Array): string | null {
	const starts = (...values: number[]) => values.every((value, index) => bytes[index] === value);
	const ascii = (from: number, to: number) => String.fromCharCode(...bytes.subarray(from, to));
	if (starts(0x89, 0x50, 0x4e, 0x47)) return "image/png";
	if (starts(0xff, 0xd8, 0xff)) return "image/jpeg";
	if (ascii(0, 4) === "GIF8") return "image/gif";
	if (ascii(0, 4) === "RIFF" && ascii(8, 12) === "WEBP") return "image/webp";
	return null;
}

/**
 * Where agents' copies of stored files go (see `Files.load`), for their
 * code to open. The person doesn't see it in Files or the export.
 */
export const LOADED_ROOT = `${FILES_ROOT}/.loaded`;
/** How many bytes of loaded copies are kept; loading past it drops the oldest. */
const LOADED_BYTES = 50_000_000;

/** One of the files kept in R2 instead of the Workspace. */
export type StoredFile = {
	readonly path: string;
	readonly id: string;
	/** An image's type when it is one models take, else what its name says. */
	readonly type: string;
	readonly bytes: number;
	readonly updatedAt: number;
};

const SCHEMA = `
CREATE TABLE IF NOT EXISTS pim_stored_files (
	path TEXT PRIMARY KEY,
	id TEXT NOT NULL,
	type TEXT NOT NULL,
	bytes INTEGER NOT NULL,
	updated_at INTEGER NOT NULL
);
`;

type FilesOptions = {
	readonly workspace: () => Workspace;
	readonly sql: SqlStorage;
	/** The bucket that also keeps sent images; stored files are under `<owner>/files/`. */
	readonly bucket: R2Bucket;
	readonly owner: () => string;
};

/**
 * The person's files. Text is kept in the Workspace, where agents read,
 * search and edit it and their code works on it. Anything else (PDFs,
 * images, audio, video) is a stored file: its bytes are an R2 object and a
 * row here keeps its path, so it costs the space's SQLite nothing and
 * shows in the same folders. Folders are the Workspace's: storing a file
 * makes its folder there. A path is one or the other; saving at a path
 * replaces whatever was there.
 *
 * Agents' code sees only the Workspace. `load` copies a stored file into
 * `LOADED_ROOT` for it, and `afterCode` stores what code wrote that isn't text.
 */
export class Files {
	readonly #workspace: () => Workspace;
	readonly #sql: SqlStorage;
	readonly #bucket: R2Bucket;
	readonly #owner: () => string;

	constructor(options: FilesOptions) {
		this.#workspace = options.workspace;
		this.#sql = options.sql;
		this.#bucket = options.bucket;
		this.#owner = options.owner;
		options.sql.exec(SCHEMA);
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

	#key(id: string): string {
		return `${this.#owner()}/files/${id}`;
	}

	/** The stored file at `path`, or null. */
	stored(path: string): StoredFile | null {
		const row = this.#sql
			.exec<{ path: string; id: string; type: string; bytes: number; updated_at: number }>("SELECT * FROM pim_stored_files WHERE path = ?", path)
			.toArray()[0];
		return row ? { path: row.path, id: row.id, type: row.type, bytes: row.bytes, updatedAt: row.updated_at } : null;
	}

	/** The stored files at `path` or anywhere under it. */
	storedUnder(path: string): StoredFile[] {
		const prefix = `${path}/`;
		return this.#sql
			.exec<{ path: string; id: string; type: string; bytes: number; updated_at: number }>(
				"SELECT * FROM pim_stored_files WHERE path = ? OR substr(path, 1, ?) = ? ORDER BY path",
				path,
				prefix.length,
				prefix,
			)
			.toArray()
			.map((row) => ({ path: row.path, id: row.id, type: row.type, bytes: row.bytes, updatedAt: row.updated_at }));
	}

	/** The stored files directly in `folder`. */
	storedIn(folder: string): StoredFile[] {
		return this.storedUnder(folder).filter((file) => file.path.lastIndexOf("/") === folder.length);
	}

	/** What the stored files take, in bytes: they count against the storage quota. */
	storedBytes(): number {
		return Number(this.#sql.exec("SELECT COALESCE(SUM(bytes), 0) AS bytes FROM pim_stored_files").one().bytes);
	}

	/** A stored file's bytes, or null when it's gone. */
	async storedBody(file: StoredFile): Promise<R2ObjectBody | null> {
		return this.#bucket.get(this.#key(file.id));
	}

	/**
	 * Keeps `bytes` in R2 as the file at `path`, replacing a stored file or a
	 * Workspace file there. The object is written before the row, so a lost
	 * write leaves an object no row names, which erasing the space removes.
	 */
	async #store(path: string, bytes: Uint8Array): Promise<void> {
		const id = crypto.randomUUID();
		const name = path.slice(path.lastIndexOf("/") + 1);
		const type = imageType(bytes) ?? fileType(name).split(";")[0]!;
		await this.#bucket.put(this.#key(id), bytes, { httpMetadata: { contentType: type } });
		const replaced = this.stored(path);
		this.#sql.exec(
			"INSERT OR REPLACE INTO pim_stored_files (path, id, type, bytes, updated_at) VALUES (?, ?, ?, ?, ?)",
			path,
			id,
			type,
			bytes.byteLength,
			Date.now(),
		);
		if (replaced) await this.#bucket.delete(this.#key(replaced.id));
		await this.#fs.mkdir(path.slice(0, path.lastIndexOf("/")), { recursive: true });
		if ((await this.#stat(path))?.isFile) await this.#fs.rm(path);
	}

	/** Deletes the stored files at `path` or under it, rows first. */
	async removeStored(path: string): Promise<void> {
		const files = this.storedUnder(path);
		for (const file of files) this.#sql.exec("DELETE FROM pim_stored_files WHERE path = ?", file.path);
		// R2 deletes at most 1000 keys at once.
		for (let start = 0; start < files.length; start += 1000) {
			await this.#bucket.delete(files.slice(start, start + 1000).map((file) => this.#key(file.id)));
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
			.filter((entry) => (entry.isFile || entry.isDirectory) && `${folder}/${entry.name}` !== LOADED_ROOT)
			.map(
				(entry): FileEntry => ({
					name: entry.name,
					path: `${folder}/${entry.name}`,
					type: entry.isDirectory ? "directory" : "file",
					size: entry.isDirectory ? 0 : entry.size,
					updatedAt: new Date(entry.mtime).toISOString(),
				}),
			)
			.concat(
				this.storedIn(folder).map((file) => ({
					name: file.path.slice(folder.length + 1),
					path: file.path,
					type: "file",
					size: file.bytes,
					updatedAt: new Date(file.updatedAt).toISOString(),
				})),
			)
			.sort((a, b) => (a.type === b.type ? a.name.localeCompare(b.name) : a.type === "directory" ? -1 : 1));
		return { path: folder, entries };
	}

	/** A file's bytes and what to serve them as. */
	async read(path: unknown): Promise<{ path: string; name: string; size: number; type: string; body: ReadableStream<Uint8Array> }> {
		const file = checkedPath(path);
		const name = file.slice(file.lastIndexOf("/") + 1);
		const stored = this.stored(file);
		if (stored) {
			const object = await this.storedBody(stored);
			if (!object) throw new HttpError(404, `No file ${file}`);
			return { path: file, name, size: stored.bytes, type: fileType(name), body: object.body };
		}
		const stat = await this.#stat(file);
		if (!stat?.isFile) throw new HttpError(404, `No file ${file}`);
		return { path: file, name, size: stat.size, type: fileType(name), body: await this.#fs.readFile(file) };
	}

	/** Saves `body` at `path`, making its folders, and replacing a file already there: text in the Workspace, anything else in R2. */
	async write(path: unknown, body: Uint8Array): Promise<FileEntry> {
		const file = checkedPath(path);
		if (file === FILES_ROOT) throw new HttpError(400, "path must name a file");
		if (file === LOADED_ROOT || file.startsWith(`${LOADED_ROOT}/`)) throw new HttpError(400, `${LOADED_ROOT} is for agents' copies of files`);
		const existing = await this.#stat(file);
		if (existing?.isDirectory) throw new HttpError(409, `${file} is a folder`);
		const name = file.slice(file.lastIndexOf("/") + 1);
		if (!isText(body)) {
			await this.#store(file, body);
			return { name, path: file, type: "file", size: body.byteLength, updatedAt: new Date(this.stored(file)!.updatedAt).toISOString() };
		}
		await this.#fs.mkdir(file.slice(0, file.lastIndexOf("/")), { recursive: true });
		await this.#fs.writeFile(file, body);
		await this.removeStored(file);
		const stat = await this.#fs.stat(file);
		return { name, path: file, type: "file", size: stat.size, updatedAt: new Date(stat.mtime).toISOString() };
	}

	/** Deletes a file, or a folder with everything in it. */
	async remove(path: unknown): Promise<void> {
		const target = checkedPath(path);
		if (target === FILES_ROOT) throw new HttpError(400, "The files folder itself can't be deleted");
		const stored = this.storedUnder(target).length > 0;
		await this.removeStored(target);
		try {
			await this.#fs.rm(target, { recursive: true });
		} catch (error) {
			if (isMissing(error) && !stored) throw new HttpError(404, `No file or folder ${target}`);
			if (!isMissing(error)) throw error;
		}
	}

	/**
	 * Copies a stored file into `LOADED_ROOT`, at the same path below it, for
	 * agents' code to open, and gives back the copy's path. Copies past
	 * `LOADED_BYTES` are dropped, oldest first, to make room.
	 */
	async load(path: string): Promise<string> {
		const file = this.stored(path);
		if (!file) throw new Error(`${path} is not a stored file. Files that are text are already in ${FILES_ROOT}, where code can open them.`);
		const object = await this.storedBody(file);
		if (!object) throw new Error(`${path} is gone.`);
		const target = `${LOADED_ROOT}${path.slice(FILES_ROOT.length)}`;
		const copies = [];
		for await (const copy of this.#walk(LOADED_ROOT)) if (copy.path !== target) copies.push(copy);
		copies.sort((a, b) => a.mtime - b.mtime);
		let kept = copies.reduce((total, copy) => total + copy.size, 0);
		for (const copy of copies) {
			if (kept + file.bytes <= LOADED_BYTES) break;
			await this.#fs.rm(copy.path);
			kept -= copy.size;
		}
		await this.#fs.mkdir(target.slice(0, target.lastIndexOf("/")), { recursive: true });
		await this.#fs.writeFile(target, object.body);
		return target;
	}

	/**
	 * Settles the files after agents' code ran (it started at `since`): what
	 * it wrote that isn't text is stored, what it made at a stored file's
	 * path replaces that file, and folders it removed that held stored files
	 * come back, since code never saw those files.
	 */
	async afterCode(since: number): Promise<void> {
		for await (const file of this.#walk(FILES_ROOT)) {
			if (file.mtime < since) continue;
			const head = new Uint8Array(await new Response(await this.#fs.readFile(file.path, { byteLength: SNIFF_BYTES })).arrayBuffer());
			if (isText(head)) continue;
			await this.#store(file.path, new Uint8Array(await new Response(await this.#fs.readFile(file.path)).arrayBuffer()));
		}
		for (const file of this.storedUnder(FILES_ROOT)) {
			if (await this.#stat(file.path)) await this.removeStored(file.path);
			else await this.#fs.mkdir(file.path.slice(0, file.path.lastIndexOf("/")), { recursive: true });
		}
	}

	/** Every Workspace file under `folder`, except agents' loaded copies when `folder` is above them. */
	async *#walk(folder: string): AsyncGenerator<{ path: string; size: number; mtime: number }> {
		const pending = [folder];
		while (pending.length > 0) {
			const current = pending.pop()!;
			let entries;
			try {
				entries = await this.#fs.readdir(current);
			} catch (error) {
				if (isMissing(error)) continue;
				throw error;
			}
			for (const entry of entries) {
				const path = `${current}/${entry.name}`;
				if (path === LOADED_ROOT && folder !== LOADED_ROOT) continue;
				if (entry.isDirectory) pending.push(path);
				else if (entry.isFile) yield { path, size: entry.size, mtime: entry.mtime };
			}
		}
	}

	/**
	 * Every file, for the account export: what the Workspace holds inline,
	 * text as text and anything else (kept there before files were stored)
	 * as base64. Stored files, and Workspace files past `EXPORT_INLINE_BYTES`,
	 * are listed without their content, which the Files view still downloads.
	 */
	async export(): Promise<{ path: string; size: number; updatedAt: string; encoding?: "utf8" | "base64"; content?: string }[]> {
		const files: { path: string; size: number; updatedAt: string; encoding?: "utf8" | "base64"; content?: string }[] = [];
		let inlined = 0;
		for await (const file of this.#walk(FILES_ROOT)) {
			const described = { path: file.path, size: file.size, updatedAt: new Date(file.mtime).toISOString() };
			if (inlined + file.size > EXPORT_INLINE_BYTES) {
				files.push(described);
				continue;
			}
			inlined += file.size;
			const bytes = new Uint8Array(await new Response(await this.#fs.readFile(file.path)).arrayBuffer());
			try {
				files.push({ ...described, encoding: "utf8", content: new TextDecoder("utf-8", { fatal: true, ignoreBOM: false }).decode(bytes) });
			} catch {
				files.push({ ...described, encoding: "base64", content: Buffer.from(bytes).toString("base64") });
			}
		}
		for (const file of this.storedUnder(FILES_ROOT)) {
			files.push({ path: file.path, size: file.bytes, updatedAt: new Date(file.updatedAt).toISOString() });
		}
		return files.sort((a, b) => a.path.localeCompare(b.path));
	}
}
