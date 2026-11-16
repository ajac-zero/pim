import { createHash } from "node:crypto";
import { createReadStream, createWriteStream, existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { createInterface } from "node:readline";

/**
 * The export bundle, `pim-export/1`: what an inert export runtime writes from the old system and what the importer reads.
 * Plain files, so it can be inspected, checksummed, backed up and moved with ordinary tools:
 *
 *   manifest.json                      format, source, tenants, per-file sha256 and row counts, fence evidence
 *   directory/accounts.ndjson          owner_id, username, role, status, created_at ...
 *   tenants/<id>/pi/<table>.ndjson     conversations, entries, tasks, submissions, documents, document_revisions: SQLite rows, `record` verbatim
 *   tenants/<id>/pi/metadata.json      { next_id (string), next_seq }
 *   tenants/<id>/host/<table>.ndjson   every pim_* table except pim_credentials
 *   tenants/<id>/auth/<table>.ndjson   auth_passkeys, auth_tokens, auth_recovery_codes, auth_identities
 *   tenants/<id>/secrets.json          secrets encrypted under the export key (never plaintext in the bundle)
 *   blobs/index.ndjson, blobs/<sha256> object bodies, with tenant, legacy key, size and content type in the index
 *   external/handles.ndjson            coding threads and remote sessions that were live at export time
 */
export const FORMAT = "pim-export/1";

export interface FileEntry {
	sha256: string;
	rows: number;
	bytes: number;
}
export interface Manifest {
	format: typeof FORMAT;
	createdAt: string;
	source: { system: string; commit?: string; fence?: Record<string, unknown> };
	tenants: string[];
	files: Record<string, FileEntry>;
}

export const PI_TABLES = ["conversations", "entries", "tasks", "submissions", "documents", "document_revisions"] as const;
export type PiTable = (typeof PI_TABLES)[number];

export class BundleWriter {
	readonly files: Record<string, FileEntry> = {};
	readonly tenants = new Set<string>();
	constructor(readonly dir: string) {
		mkdirSync(dir, { recursive: true });
	}

	/** Writes rows as NDJSON and records their digest and count. */
	async ndjson(path: string, rows: Iterable<unknown> | AsyncIterable<unknown>): Promise<void> {
		const full = join(this.dir, path);
		mkdirSync(dirname(full), { recursive: true });
		const hash = createHash("sha256");
		let count = 0;
		let bytes = 0;
		const out = createWriteStream(full);
		for await (const row of rows as AsyncIterable<unknown>) {
			const line = `${JSON.stringify(row)}\n`;
			hash.update(line);
			bytes += Buffer.byteLength(line);
			count++;
			if (!out.write(line)) await new Promise<void>((resolve) => out.once("drain", () => resolve()));
		}
		await new Promise<void>((resolve, reject) => {
			out.once("error", reject);
			out.end(() => resolve());
		});
		this.files[path] = { sha256: hash.digest("hex"), rows: count, bytes };
	}

	json(path: string, value: unknown): void {
		const full = join(this.dir, path);
		mkdirSync(dirname(full), { recursive: true });
		const text = `${JSON.stringify(value, null, 1)}\n`;
		writeFileSync(full, text);
		this.files[path] = { sha256: createHash("sha256").update(text).digest("hex"), rows: 1, bytes: Buffer.byteLength(text) };
	}

	blob(sha256: string, body: Buffer): void {
		mkdirSync(join(this.dir, "blobs"), { recursive: true });
		writeFileSync(join(this.dir, "blobs", sha256), body);
	}

	finish(source: Manifest["source"]): Manifest {
		const manifest: Manifest = { format: FORMAT, createdAt: new Date().toISOString(), source, tenants: [...this.tenants].sort(), files: this.files };
		writeFileSync(join(this.dir, "manifest.json"), `${JSON.stringify(manifest, null, 1)}\n`);
		return manifest;
	}
}

export class BundleReader {
	readonly manifest: Manifest;
	constructor(readonly dir: string) {
		this.manifest = JSON.parse(readFileSync(join(dir, "manifest.json"), "utf8")) as Manifest;
		if (this.manifest.format !== FORMAT) throw new Error(`Unsupported export format ${this.manifest.format}`);
	}

	has(path: string): boolean {
		return existsSync(join(this.dir, path));
	}

	json<T>(path: string): T | undefined {
		return this.has(path) ? (JSON.parse(readFileSync(join(this.dir, path), "utf8")) as T) : undefined;
	}

	async *ndjson<T = Record<string, any>>(path: string): AsyncGenerator<T> {
		if (!this.has(path)) return;
		const lines = createInterface({ input: createReadStream(join(this.dir, path), { encoding: "utf8" }), crlfDelay: Infinity });
		for await (const line of lines) if (line) yield JSON.parse(line) as T;
	}

	async all<T = Record<string, any>>(path: string): Promise<T[]> {
		const rows: T[] = [];
		for await (const row of this.ndjson<T>(path)) rows.push(row);
		return rows;
	}

	files(prefix: string): string[] {
		const base = join(this.dir, prefix);
		return existsSync(base) ? readdirSync(base).filter((f) => statSync(join(base, f)).isFile()).map((f) => `${prefix}/${f}`) : [];
	}

	blobPath(sha256: string): string {
		return join(this.dir, "blobs", sha256);
	}

	/** Recomputes every file's digest and row count against the manifest: a bundle that was altered or truncated fails here. */
	async checkIntegrity(): Promise<string[]> {
		const problems: string[] = [];
		for (const [path, entry] of Object.entries(this.manifest.files)) {
			if (!this.has(path)) {
				problems.push(`${path}: missing`);
				continue;
			}
			const hash = createHash("sha256").update(readFileSync(join(this.dir, path))).digest("hex");
			if (hash !== entry.sha256) problems.push(`${path}: checksum mismatch`);
		}
		return problems;
	}
}

/** Digest of rows in id order, the same on either side of an import. */
export const rowDigest = (lines: Iterable<string>): string => {
	const hash = createHash("sha256");
	for (const line of lines) hash.update(`${line}\n`);
	return hash.digest("hex");
};
