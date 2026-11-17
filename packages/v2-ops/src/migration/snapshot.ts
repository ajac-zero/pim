import { createHash } from "node:crypto";
import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

/** One value of a dumped row: JSON, with SQLite blobs wrapped as `{ "$b64": "..." }`. */
export type Cell = string | number | boolean | null | { readonly $b64: string };
export type Row = Record<string, Cell>;
export type TableDump = { readonly columns: readonly string[]; readonly rows: readonly Row[] };

/** Everything one legacy Durable Object held: its SQLite tables, its key-value entries and its pending alarm. */
export type DoDump = {
	readonly class: string;
	readonly name: string;
	readonly tables: Readonly<Record<string, TableDump>>;
	readonly kv: readonly { readonly key: string; readonly value: unknown }[];
	readonly alarm: number | null;
};

export type ObjectEntry = { readonly bucket: string; readonly key: string; readonly size: number; readonly sha256: string; readonly contentType: string | null };

export type SnapshotManifest = {
	readonly format: 1;
	/** The instant the fence was verified: no legacy write happened after it, and no schedule occurrence before it may fire. */
	readonly cutoverAt: number;
	readonly exportedAt: number;
	readonly source: string;
	/** SHA-256 of every file in the snapshot, by relative path. */
	readonly files: Readonly<Record<string, string>>;
	/** Which key material the source deployment uses, by name and public fingerprint only. */
	readonly keyMaterial: readonly { readonly name: string; readonly fingerprint: string }[];
};

export const sha256 = (data: string | Uint8Array) => createHash("sha256").update(data).digest("hex");
export const b64 = (bytes: Uint8Array): Cell => ({ $b64: Buffer.from(bytes).toString("base64") });
export const isBlob = (cell: unknown): cell is { $b64: string } => typeof cell === "object" && cell !== null && "$b64" in cell;
export const blobBytes = (cell: { $b64: string }) => Buffer.from(cell.$b64, "base64");

const safe = (name: string) => encodeURIComponent(name).replace(/%/g, "_");
const dumpPath = (cls: string, name: string) => `dos/${cls}/${safe(name)}.json`;
const chunkPath = (cls: string, name: string, table: string, i: number) => `dos-rows/${cls}/${safe(name)}/${safe(table)}.${i}.jsonl`;
const objectPath = (bucket: string, key: string) => `objects/data/${bucket}/${sha256(key)}`;
/** A table whose rows come to more than this many characters of JSON is written in chunk files of about this size, one row per line: one JSON string of a large space's whole history is more than a JavaScript string can hold. */
const CHUNK_CHARS = 64 * 1024 * 1024;

/** Writes a snapshot directory: DO dumps, the object index with object bytes, OAuth KV entries, and a manifest of checksums. */
export class SnapshotWriter {
	readonly #files: Record<string, string> = {};
	readonly #objects: ObjectEntry[] = [];
	readonly dir: string;
	constructor(dir: string) {
		this.dir = dir;
	}

	async #write(path: string, data: string | Uint8Array) {
		const full = join(this.dir, path);
		await mkdir(dirname(full), { recursive: true });
		await writeFile(full, data);
		this.#files[path] = sha256(data);
	}

	async dump(dump: DoDump) {
		const tables: Record<string, TableDump & { chunks?: number }> = {};
		for (const [table, { columns, rows }] of Object.entries(dump.tables)) {
			const lines = rows.map((row) => JSON.stringify(row));
			if (lines.reduce((n, line) => n + line.length + 1, 0) <= CHUNK_CHARS) {
				tables[table] = { columns, rows };
				continue;
			}
			let chunks = 0;
			for (let start = 0; start < lines.length; ) {
				let end = start;
				for (let size = 0; end < lines.length && (end === start || size + lines[end]!.length < CHUNK_CHARS); end++) size += lines[end]!.length + 1;
				await this.#write(chunkPath(dump.class, dump.name, table, chunks++), lines.slice(start, end).join("\n"));
				start = end;
			}
			tables[table] = { columns, rows: [], chunks };
		}
		return this.#write(dumpPath(dump.class, dump.name), JSON.stringify({ ...dump, tables }));
	}

	async object(bucket: string, key: string, bytes: Uint8Array, contentType: string | null) {
		await this.#write(objectPath(bucket, key), bytes);
		this.#objects.push({ bucket, key, size: bytes.byteLength, sha256: sha256(bytes), contentType });
	}

	oauthKv(entries: readonly { key: string; value: unknown }[]) {
		return this.#write("oauth_kv.json", JSON.stringify(entries));
	}

	async finish(manifest: Omit<SnapshotManifest, "files" | "format">): Promise<SnapshotManifest> {
		await this.#write("objects/index.json", JSON.stringify(this.#objects));
		const full: SnapshotManifest = { format: 1, ...manifest, files: { ...this.#files } };
		await writeFile(join(this.dir, "manifest.json"), JSON.stringify(full, null, 2));
		return full;
	}
}

export class SnapshotReader {
	readonly dir: string;
	constructor(dir: string) {
		this.dir = dir;
	}

	async manifest(): Promise<SnapshotManifest> {
		return JSON.parse(await readFile(join(this.dir, "manifest.json"), "utf8")) as SnapshotManifest;
	}

	/** The names of the dumped Durable Objects of one class. */
	async names(cls: string): Promise<string[]> {
		try {
			const dumps = await Promise.all((await readdir(join(this.dir, "dos", cls))).map((file) => readFile(join(this.dir, "dos", cls, file), "utf8")));
			return dumps.map((text) => (JSON.parse(text) as DoDump).name).sort();
		} catch {
			return [];
		}
	}

	async dump(cls: string, name: string): Promise<DoDump> {
		const dump = JSON.parse(await readFile(join(this.dir, dumpPath(cls, name)), "utf8")) as DoDump & { tables: Record<string, TableDump & { rows: Row[]; chunks?: number }> };
		for (const [table, value] of Object.entries(dump.tables)) {
			if (!value.chunks) continue;
			for (let i = 0; i < value.chunks; i++) for (const line of (await readFile(join(this.dir, chunkPath(cls, name, table, i)), "utf8")).split("\n")) value.rows.push(JSON.parse(line) as Row);
			delete value.chunks;
		}
		return dump;
	}

	async objects(): Promise<ObjectEntry[]> {
		return JSON.parse(await readFile(join(this.dir, "objects/index.json"), "utf8")) as ObjectEntry[];
	}

	object(bucket: string, key: string): Promise<Buffer> {
		return readFile(join(this.dir, objectPath(bucket, key)));
	}

	async oauthKv(): Promise<{ key: string; value: unknown }[]> {
		try {
			return JSON.parse(await readFile(join(this.dir, "oauth_kv.json"), "utf8")) as { key: string; value: unknown }[];
		} catch {
			return [];
		}
	}

	/** Re-reads every file and compares its SHA-256 with the manifest: what a transfer of the snapshot must survive. */
	async verifyFiles(): Promise<string[]> {
		const manifest = await this.manifest();
		const problems: string[] = [];
		for (const [path, expected] of Object.entries(manifest.files)) {
			try {
				if (sha256(await readFile(join(this.dir, path))) !== expected) problems.push(`${path}: checksum differs`);
			} catch {
				problems.push(`${path}: missing`);
			}
		}
		return problems;
	}

	/** Hash of the manifest itself, which names every file's hash: the identity of this snapshot. */
	async identity(): Promise<string> {
		return sha256(await readFile(join(this.dir, "manifest.json")));
	}
}

/** The table's rows, or none when the Durable Object never created it. */
export const rowsOf = (dump: DoDump | undefined, table: string): readonly Row[] => dump?.tables[table]?.rows ?? [];
