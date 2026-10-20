import { Buffer } from "node:buffer";
import type { Workspace } from "@cloudflare/computer";
import { FILES_ROOT, type Files } from "./files";

/**
 * The files people kept in their space before files moved to their computer
 * (./files.ts): text in a `@cloudflare/computer` Workspace in the space's own
 * SQLite, other files in R2 with a row in `pim_stored_files`. They are kept
 * only until the person connects a computer, which they move to (`moveTo`);
 * until then they count toward the space's storage and are in its export.
 */

/** How many bytes of files an export carries inline; the rest are listed by path. */
const EXPORT_INLINE_BYTES = 32_000_000;

/** Where `run_javascript` used to copy stored files for code; copies, not the person's files. */
const LOADED_ROOT = `${FILES_ROOT}/.loaded`;

type StoredFile = { readonly path: string; readonly id: string; readonly bytes: number; readonly updatedAt: number };

const SCHEMA = `
CREATE TABLE IF NOT EXISTS pim_stored_files (
	path TEXT PRIMARY KEY,
	id TEXT NOT NULL,
	type TEXT NOT NULL,
	bytes INTEGER NOT NULL,
	updated_at INTEGER NOT NULL
);
`;

type LegacyFilesOptions = {
	readonly workspace: () => Workspace;
	readonly sql: SqlStorage;
	/** The bucket that also keeps sent images; stored files are under `<owner>/files/`. */
	readonly bucket: R2Bucket;
	readonly owner: () => string;
};

function isMissing(error: unknown): boolean {
	return (error as { code?: string } | null)?.code === "ENOENT";
}

/** A name beside `path` for a file that would replace one already there: `notes (from Pim).md`. */
function besides(path: string): string {
	const slash = path.lastIndexOf("/");
	const dot = path.lastIndexOf(".");
	return dot > slash + 1 ? `${path.slice(0, dot)} (from Pim)${path.slice(dot)}` : `${path} (from Pim)`;
}

export class LegacyFiles {
	readonly #workspace: () => Workspace;
	readonly #sql: SqlStorage;
	readonly #bucket: R2Bucket;
	readonly #owner: () => string;

	constructor(options: LegacyFilesOptions) {
		this.#workspace = options.workspace;
		this.#sql = options.sql;
		this.#bucket = options.bucket;
		this.#owner = options.owner;
		options.sql.exec(SCHEMA);
	}

	get #fs() {
		return this.#workspace().fs;
	}

	#key(id: string): string {
		return `${this.#owner()}/files/${id}`;
	}

	#stored(): StoredFile[] {
		return this.#sql
			.exec<{ path: string; id: string; bytes: number; updated_at: number }>("SELECT path, id, bytes, updated_at FROM pim_stored_files ORDER BY path")
			.toArray()
			.map((row) => ({ path: row.path, id: row.id, bytes: row.bytes, updatedAt: row.updated_at }));
	}

	/** What the stored files take, in bytes: they count against the storage quota. */
	storedBytes(): number {
		return Number(this.#sql.exec("SELECT COALESCE(SUM(bytes), 0) AS bytes FROM pim_stored_files").one().bytes);
	}

	/** Every Workspace file under `FILES_ROOT`, with agents' loaded copies when `copies` is set. */
	async *#walk(copies = false): AsyncGenerator<{ path: string; size: number; mtime: number }> {
		const pending = [FILES_ROOT];
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
				if (path === LOADED_ROOT && !copies) continue;
				if (entry.isDirectory) pending.push(path);
				else if (entry.isFile) yield { path, size: entry.size, mtime: entry.mtime };
			}
		}
	}

	/** Whether any files are left here. */
	async any(): Promise<boolean> {
		if (this.#stored().length > 0) return true;
		for await (const _ of this.#walk()) return true;
		return false;
	}

	/**
	 * Moves every file to the person's computer, each to the same path there,
	 * or beside a file already at it; each is deleted here once it's there, so
	 * a move cut short goes on from where it stopped. Returns how many moved.
	 */
	async moveTo(files: Files): Promise<number> {
		let moved = 0;
		const place = async (path: string, bytes: Uint8Array) => {
			let target = path;
			while (await files.exists(target)) target = besides(target);
			await files.write(target, bytes);
			moved++;
		};
		for await (const file of this.#walk()) {
			await place(file.path, new Uint8Array(await new Response(await this.#fs.readFile(file.path)).arrayBuffer()));
			await this.#fs.rm(file.path);
		}
		for (const file of this.#stored()) {
			const object = await this.#bucket.get(this.#key(file.id));
			if (object) await place(file.path, new Uint8Array(await object.arrayBuffer()));
			this.#sql.exec("DELETE FROM pim_stored_files WHERE path = ?", file.path);
			await this.#bucket.delete(this.#key(file.id));
		}
		await this.#fs.rm(FILES_ROOT, { recursive: true, force: true });
		return moved;
	}

	/**
	 * Every file, for the account export: what the Workspace holds inline,
	 * text as text and anything else as base64. Stored files, and Workspace
	 * files past `EXPORT_INLINE_BYTES`, are listed without their content.
	 */
	async export(): Promise<{ path: string; size: number; updatedAt: string; encoding?: "utf8" | "base64"; content?: string }[]> {
		const files: { path: string; size: number; updatedAt: string; encoding?: "utf8" | "base64"; content?: string }[] = [];
		let inlined = 0;
		for await (const file of this.#walk()) {
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
		for (const file of this.#stored()) files.push({ path: file.path, size: file.bytes, updatedAt: new Date(file.updatedAt).toISOString() });
		return files.sort((a, b) => a.path.localeCompare(b.path));
	}
}
