/**
 * Artifacts: documents and small interactive pages the agent makes for its
 * owner, kept in the owner's own Durable Object with every version.
 *
 * - Versions are append-only. Editing, or restoring an older version, adds
 *   a new one; nothing rewrites a version, so a version number and its
 *   `sha256` always name the same bytes.
 * - Every write names the version it was based on, and is refused (409)
 *   when that is no longer the latest: the agent and the person can't
 *   overwrite each other's change unseen.
 * - Sizes are bounded per version, per artifact (versions) and in total,
 *   counted from the stored versions themselves, before anything is written.
 * - A version is a set of files. Their bytes are in the artifacts' R2
 *   bucket, under the owner's name and their SHA-256, each stored once however many
 *   versions and artifacts have it; this object keeps what each version
 *   lists. Versions from before files were in R2 keep their one file here,
 *   until someone else needs it (see `stored`).
 *
 * An HTML artifact runs, in the browser, only in a sandbox with an opaque
 * origin (see `artifactHtmlHeaders`); this module only stores it.
 */

import { Buffer } from "node:buffer";
import { compileJsxApp, dataUrl, inlineCssUrls, inlineScript, resolvePath } from "./artifact-jsx";
import { HttpError } from "./http";

export const ARTIFACT_KINDS = ["html", "markdown", "svg", "mermaid", "jsx"] as const;
export type ArtifactKind = (typeof ARTIFACT_KINDS)[number];

/** The kinds the app shows in a sandboxed frame; Markdown it renders itself. */
export const FRAMED_KINDS: readonly ArtifactKind[] = ["html", "svg", "mermaid", "jsx"];

/** Each kind's file extension, for downloads. */
const EXTENSIONS: Record<ArtifactKind, string> = { html: "html", markdown: "md", svg: "svg", mermaid: "mmd", jsx: "jsx" };

/** Who made a version: the agent, the person editing it, or the person restoring an older one. */
export type ArtifactSource = "agent" | "person" | "restore";

/** Each kind's main file, which every version has: the page, the document, the drawing, the diagram or the component. */
export const ENTRY_FILES: Record<ArtifactKind, string> = { html: "index.html", markdown: "README.md", svg: "image.svg", mermaid: "diagram.mmd", jsx: "App.jsx" };

/**
 * The file a page or an app may have beside its main one for its widget: a
 * small view of it, which a dashboard shows as a tile, as a phone's home
 * screen shows an app's widget. It shares the artifact's other files, data
 * and permissions.
 */
export const WIDGET_FILES: Partial<Record<ArtifactKind, string>> = { html: "widget.html", jsx: "Widget.jsx" };

/** Whether a version has a widget. */
export const hasWidget = (kind: ArtifactKind, files: readonly { path: string }[]) => files.some((file) => file.path === WIDGET_FILES[kind]);

/** One file of a version, as the version lists it. */
export type ArtifactFile = {
	readonly path: string;
	readonly sha256: string;
	readonly size: number;
	/** Its media type, from its name. */
	readonly type: string;
};

/** A version's files with their bytes, by path. */
export type LoadedFiles = ReadonlyMap<string, { readonly type: string; readonly bytes: Uint8Array }>;

/** New content for files, by path: text, or bytes. */
export type FileContents = Readonly<Record<string, string | Uint8Array>>;

export type ArtifactSummary = {
	readonly id: string;
	readonly title: string;
	readonly kind: ArtifactKind;
	/** The session it was made in. */
	readonly session: string | null;
	/** The latest version's number. */
	readonly version: number;
	readonly versions: number;
	/** The latest version's size: all its files, in bytes. */
	readonly size: number;
	/** How many files the latest version has. */
	readonly files: number;
	readonly sha256: string;
	readonly createdAt: number;
	readonly updatedAt: number;
};

export type ArtifactVersionInfo = {
	readonly version: number;
	readonly sha256: string;
	readonly size: number;
	readonly source: ArtifactSource;
	/** The version a restore copied. */
	readonly restoredFrom: number | null;
	readonly createdAt: number;
};

export type ArtifactVersion = ArtifactVersionInfo & { readonly artifact: string; readonly files: readonly ArtifactFile[] };

/** Whose data an artifact keeps: the person using it (`own`), or everyone using it (`shared`). */
export type DataScope = "own" | "shared";

/** The limits artifacts count against; null is none (the hard caps still apply). */
export type ArtifactLimits = {
	readonly artifacts: number | null;
	readonly artifactVersions: number | null;
	readonly artifactBytes: number | null;
	readonly artifactStorageBytes: number | null;
};

/**
 * Caps that hold whatever the limits say. A framed version is served as one
 * page with all its files, so a version stays well within a Worker's
 * memory; all of them together are counted once per distinct file, and an
 * export carries up to `EXPORT_INLINE_BYTES` of them.
 */
export const MAX_ARTIFACT_BYTES = 10_000_000;
export const MAX_ARTIFACT_STORAGE_BYTES = 100_000_000;
export const MAX_ARTIFACT_FILES = 100;
export const MAX_TITLE_LENGTH = 200;
const MAX_PATH_LENGTH = 200;
/** How many bytes of files an export carries inline; the rest are listed by hash. */
const EXPORT_INLINE_BYTES = 32_000_000;
/** How long a write's claim on a file it is storing keeps it from being collected, should the write never finish. */
const PENDING_MS = 60 * 60 * 1000;
/**
 * What one artifact, and all of them, may keep through the bridge, keys and
 * values together, in UTF-8 bytes: an export holds it all in memory too.
 */
export const MAX_ARTIFACT_DATA_BYTES = 1_000_000;
export const MAX_ARTIFACT_DATA_TOTAL_BYTES = 10_000_000;
const MAX_DATA_KEY_LENGTH = 200;

const SCHEMA = `
CREATE TABLE IF NOT EXISTS pim_artifacts (
	id TEXT PRIMARY KEY,
	title TEXT NOT NULL,
	kind TEXT NOT NULL,
	session TEXT,
	head INTEGER NOT NULL,
	created_at INTEGER NOT NULL,
	updated_at INTEGER NOT NULL
);
-- A version: its files are in pim_artifact_files. Versions from before that keep their one file in content, and
-- have no rows there; newer ones keep content empty.
CREATE TABLE IF NOT EXISTS pim_artifact_versions (
	artifact TEXT NOT NULL,
	version INTEGER NOT NULL,
	content TEXT NOT NULL,
	sha256 TEXT NOT NULL,
	size INTEGER NOT NULL,
	source TEXT NOT NULL,
	restored_from INTEGER,
	call_id TEXT,
	created_at INTEGER NOT NULL,
	PRIMARY KEY (artifact, version)
);
-- Ids of deleted artifacts, and when: no title, content or hash. A replayed create of one must not bring it back.
-- Never pruned, since any id may still be replayed. One row (about 100 bytes) exists per artifact that was made and
-- then deleted, and each is made by a model request: the daily request limit caps the rate, and the rows count
-- in the database size the storage quota refuses new artifacts against. (A deletion needs no room.)
-- What an artifact keeps through the bridge: text under keys, kept across its versions and deleted with it. Scope
-- \`own\` is what it keeps for the person using it (window.pim.storage); \`shared\`, what everyone using it sees.
CREATE TABLE IF NOT EXISTS pim_artifact_data (
	artifact TEXT NOT NULL,
	scope TEXT NOT NULL,
	key TEXT NOT NULL,
	value TEXT NOT NULL,
	size INTEGER NOT NULL,
	updated_at INTEGER NOT NULL,
	PRIMARY KEY (artifact, scope, key)
);
-- What the person let one version of an artifact use through the bridge: the model, or an app's tool. A new
-- version, which is new code, asks again.
CREATE TABLE IF NOT EXISTS pim_artifact_grants (
	artifact TEXT NOT NULL,
	sha256 TEXT NOT NULL,
	capability TEXT NOT NULL,
	granted_at INTEGER NOT NULL,
	PRIMARY KEY (artifact, sha256, capability)
);
-- The circles an artifact is shared with: their people see its latest version from their own space.
CREATE TABLE IF NOT EXISTS pim_artifact_circles (
	artifact TEXT NOT NULL,
	circle TEXT NOT NULL,
	PRIMARY KEY (artifact, circle)
);
CREATE TABLE IF NOT EXISTS pim_artifact_deleted (
	id TEXT PRIMARY KEY,
	deleted_at INTEGER NOT NULL
);
-- The files each version has. Their bytes are in R2 at artifacts/<owner>/<sha256>, once each.
CREATE TABLE IF NOT EXISTS pim_artifact_files (
	artifact TEXT NOT NULL,
	version INTEGER NOT NULL,
	path TEXT NOT NULL,
	sha256 TEXT NOT NULL,
	size INTEGER NOT NULL,
	type TEXT NOT NULL,
	PRIMARY KEY (artifact, version, path)
);
CREATE INDEX IF NOT EXISTS pim_artifact_files_by_hash ON pim_artifact_files (sha256);
-- Files a write is storing in R2 before it lists them: they aren't collected meanwhile.
CREATE TABLE IF NOT EXISTS pim_artifact_pending (
	sha256 TEXT NOT NULL,
	write TEXT NOT NULL,
	at INTEGER NOT NULL,
	PRIMARY KEY (sha256, write)
);
`;

type Row = Record<string, SqlStorageValue>;

const encoder = new TextEncoder();
export const utf8Bytes = (text: string) => encoder.encode(text).byteLength;

export async function sha256(content: string | Uint8Array): Promise<string> {
	const digest = await crypto.subtle.digest("SHA-256", typeof content === "string" ? encoder.encode(content) : content);
	return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

const decoder = new TextDecoder();
/** A file's bytes as text. */
export const textOf = (bytes: Uint8Array) => decoder.decode(bytes);

/** Media types by file extension; anything else is `application/octet-stream`. */
const TYPES: Record<string, string> = {
	html: "text/html",
	htm: "text/html",
	css: "text/css",
	js: "text/javascript",
	mjs: "text/javascript",
	jsx: "text/jsx",
	ts: "text/typescript",
	tsx: "text/tsx",
	json: "application/json",
	md: "text/markdown",
	txt: "text/plain",
	csv: "text/csv",
	mmd: "text/plain",
	svg: "image/svg+xml",
	png: "image/png",
	jpg: "image/jpeg",
	jpeg: "image/jpeg",
	gif: "image/gif",
	webp: "image/webp",
	avif: "image/avif",
	ico: "image/x-icon",
	woff: "font/woff",
	woff2: "font/woff2",
	ttf: "font/ttf",
	otf: "font/otf",
	mp3: "audio/mpeg",
	wav: "audio/wav",
	ogg: "audio/ogg",
	mp4: "video/mp4",
	webm: "video/webm",
};

export const fileType = (path: string) => TYPES[path.slice(path.lastIndexOf(".") + 1).toLowerCase()] ?? "application/octet-stream";

/** Whether a file of this type is text, which tools and the editor show as such. */
export const isTextType = (type: string) => type.startsWith("text/") || type === "application/json" || type === "image/svg+xml";

/** Refuses a file path that isn't plain: relative, with segments of letters, digits, dots, dashes and underscores, not starting with a dot. */
export function checkPath(path: unknown): string {
	if (typeof path !== "string" || path.length === 0 || path.length > MAX_PATH_LENGTH || !path.split("/").every((part) => /^[A-Za-z0-9_-][A-Za-z0-9._-]*$/.test(part))) {
		throw new HttpError(400, `A file path is relative, like "app.js" or "assets/logo.png": letters, digits, dots, dashes and underscores, at most ${MAX_PATH_LENGTH} characters.`);
	}
	return path;
}

/**
 * A version's hash: its one file's, when it has only its main file, so a
 * version keeps the hash it had before versions had files; otherwise the
 * hash of its list of paths and file hashes.
 */
async function versionHash(kind: ArtifactKind, files: readonly ArtifactFile[]): Promise<string> {
	if (files.length === 1 && files[0]!.path === ENTRY_FILES[kind]) return files[0]!.sha256;
	return sha256(JSON.stringify([...files].sort((a, b) => (a.path < b.path ? -1 : 1)).map((file) => [file.path, file.sha256])));
}

/** Where a file's bytes are in R2. */
export const blobKey = (owner: string, hash: string) => `${owner}/${hash}`;

/** Reads a version's files from R2, from the prefix of the owner who stored them. */
export async function readFiles(bucket: R2Bucket, owner: string, files: readonly ArtifactFile[]): Promise<Map<string, { type: string; bytes: Uint8Array }>> {
	const loaded = await Promise.all(
		files.map(async (file) => {
			const object = await bucket.get(blobKey(owner, file.sha256));
			if (!object) throw new HttpError(404, `The file ${file.path} is no longer stored`);
			return [file.path, { type: file.type, bytes: new Uint8Array(await object.arrayBuffer()) }] as const;
		}),
	);
	return new Map(loaded);
}

function versionInfo(row: Row): ArtifactVersionInfo {
	return {
		version: Number(row.version),
		sha256: String(row.sha256),
		size: Number(row.size),
		source: String(row.source) as ArtifactSource,
		restoredFrom: row.restored_from === null ? null : Number(row.restored_from),
		createdAt: Number(row.created_at),
	};
}

/** Versions from before files, which keep their one file in `content`. */
const INLINE = "NOT EXISTS (SELECT 1 FROM pim_artifact_files f WHERE f.artifact = v.artifact AND f.version = v.version)";

const SUMMARY = `SELECT a.*, v.size, v.sha256, (SELECT COUNT(*) FROM pim_artifact_versions c WHERE c.artifact = a.id) AS versions,
	(SELECT COUNT(*) FROM pim_artifact_files f WHERE f.artifact = a.id AND f.version = a.head) AS files
	FROM pim_artifacts a JOIN pim_artifact_versions v ON v.artifact = a.id AND v.version = a.head`;

export function checkTitle(title: unknown): string {
	if (typeof title !== "string" || title.trim() === "") throw new HttpError(400, "title must be a non-empty string");
	const trimmed = title.trim().replace(/\s+/g, " ");
	if (trimmed.length > MAX_TITLE_LENGTH) throw new HttpError(400, `title must be at most ${MAX_TITLE_LENGTH} characters`);
	return trimmed;
}

export function checkKind(kind: unknown): ArtifactKind {
	if (!ARTIFACT_KINDS.includes(kind as ArtifactKind)) throw new HttpError(400, `kind must be one of ${ARTIFACT_KINDS.join(", ")}`);
	return kind as ArtifactKind;
}

/** An SVG artifact's markup: an `<svg>` element, after at most an XML declaration and comments. */
const SVG_START = /^\s*(<\?xml[^>]*\?>\s*)?(<!--[\s\S]*?-->\s*)*<svg[\s>]/i;

/** The kinds whose main file can use files of their own: a page's scripts, styles and images, an app's modules. */
export const MULTI_FILE_KINDS: readonly ArtifactKind[] = ["html", "jsx"];

/** Refuses a main file its kind can't show, with what to fix, so a mistake reaches the one who made it. */
export function checkContent(kind: ArtifactKind, content: string): void {
	checkFiles(kind, new Map([[ENTRY_FILES[kind], { type: fileType(ENTRY_FILES[kind]), bytes: encoder.encode(content) }]]));
}

/** Refuses a version's files its kind can't show: the main file, any other files for a kind without them, a JSX app that won't compile. */
export function checkFiles(kind: ArtifactKind, files: LoadedFiles): void {
	const entry = ENTRY_FILES[kind];
	const main = files.get(entry);
	if (!main) throw new HttpError(400, `A ${kind} artifact needs its main file, ${entry}.`);
	if (files.size > 1 && !MULTI_FILE_KINDS.includes(kind)) {
		throw new HttpError(400, `Only HTML and JSX artifacts can have files besides their main one; a ${kind} artifact is ${entry} alone.`);
	}
	const content = textOf(main.bytes);
	if (kind === "svg" && !SVG_START.test(content)) throw new HttpError(400, "An SVG artifact must be one <svg> element, starting with <svg.");
	if (kind === "mermaid" && content.trim() === "") throw new HttpError(400, "A Mermaid artifact needs a diagram.");
	if (kind === "jsx") {
		compileJsxApp(files, entry);
		if (files.has(WIDGET_FILES.jsx!)) compileJsxApp(files, WIDGET_FILES.jsx!);
	}
}

function checkKey(key: unknown): string {
	if (typeof key !== "string" || key === "" || key.length > MAX_DATA_KEY_LENGTH) {
		throw new HttpError(400, `A key must be text of 1 to ${MAX_DATA_KEY_LENGTH} characters.`);
	}
	return key;
}

/** Search-and-replace edits, each matching exactly once, applied in order. */
export function applyEdits(content: string, edits: readonly { find: string; replace: string }[]): string {
	let result = content;
	edits.forEach(({ find, replace }, index) => {
		if (find === "") throw new HttpError(400, `Edit ${index + 1}: find must not be empty`);
		const first = result.indexOf(find);
		if (first === -1) throw new HttpError(400, `Edit ${index + 1}: its find text is not in the artifact. Read it again and copy the text exactly.`);
		if (result.indexOf(find, first + 1) !== -1) {
			throw new HttpError(400, `Edit ${index + 1}: its find text appears more than once. Include more of the surrounding text so it matches once.`);
		}
		result = result.slice(0, first) + replace + result.slice(first + find.length);
	});
	return result;
}

export type ArtifactWriteOptions = {
	/** Bytes the space may still grow by, or null for no limit. */
	readonly storageRoom: () => number | null;
	/** Where files' bytes are kept. */
	readonly bucket: R2Bucket;
	/** The owner's id: their files' prefix in the bucket. */
	readonly owner: () => string;
};

/** A version as it is about to be written: its files, and their bytes where they aren't stored yet. */
type Draft = { readonly files: ArtifactFile[]; readonly bytes: Map<string, Uint8Array> };

export class ArtifactStore {
	readonly #sql: SqlStorage;
	readonly #limits: () => ArtifactLimits;
	readonly #storageRoom: () => number | null;
	readonly #bucket: R2Bucket;
	readonly #owner: () => string;
	/** One chain of R2 work per file hash, so a file isn't collected while a write stores it again. */
	readonly #locks = new Map<string, Promise<void>>();

	constructor(sql: SqlStorage, limits: () => ArtifactLimits, options: ArtifactWriteOptions) {
		this.#sql = sql;
		this.#limits = limits;
		this.#storageRoom = options.storageRoom;
		this.#bucket = options.bucket;
		this.#owner = options.owner;
		this.#sql.exec(SCHEMA);
	}

	/** Every artifact, most recently changed first. */
	list(): ArtifactSummary[] {
		return this.#sql
			.exec(`${SUMMARY} ORDER BY a.updated_at DESC, a.rowid DESC`)
			.toArray()
			.map((row) => this.#summary(row));
	}

	get(id: string): ArtifactSummary | undefined {
		const [row] = this.#sql.exec(`${SUMMARY} WHERE a.id = ?`, id).toArray();
		return row ? this.#summary(row) : undefined;
	}

	#summary(row: Row): ArtifactSummary {
		return {
			id: String(row.id),
			title: String(row.title),
			kind: String(row.kind) as ArtifactKind,
			session: row.session === null ? null : String(row.session),
			version: Number(row.head),
			versions: Number(row.versions),
			size: Number(row.size),
			files: Math.max(1, Number(row.files)),
			sha256: String(row.sha256),
			createdAt: Number(row.created_at),
			updatedAt: Number(row.updated_at),
		};
	}

	/** Every version's details, newest first, without content. */
	versions(id: string): ArtifactVersionInfo[] {
		return this.#sql
			.exec("SELECT version, sha256, size, source, restored_from, created_at FROM pim_artifact_versions WHERE artifact = ? ORDER BY version DESC", id)
			.toArray()
			.map(versionInfo);
	}

	/** A version with the files it has; the latest when `version` is omitted. */
	version(id: string, version?: number): ArtifactVersion | undefined {
		const summary = this.get(id);
		if (!summary) return undefined;
		const [row] = this.#sql
			.exec("SELECT version, sha256, size, source, restored_from, created_at FROM pim_artifact_versions WHERE artifact = ? AND version = ?", id, version ?? summary.version)
			.toArray();
		if (!row) return undefined;
		const info = versionInfo(row);
		return { ...info, artifact: id, files: this.#files(id, summary.kind, info) };
	}

	/** A version's files: as listed, or, for a version from before files, its one main file. */
	#files(id: string, kind: ArtifactKind, info: ArtifactVersionInfo): ArtifactFile[] {
		const files = this.#sql
			.exec("SELECT path, sha256, size, type FROM pim_artifact_files WHERE artifact = ? AND version = ? ORDER BY path", id, info.version)
			.toArray()
			.map((row) => ({ path: String(row.path), sha256: String(row.sha256), size: Number(row.size), type: String(row.type) }));
		if (files.length > 0) return files;
		const path = ENTRY_FILES[kind];
		return [{ path, sha256: info.sha256, size: info.size, type: fileType(path) }];
	}

	/** Whether a version is from before files, with its one file in this object. */
	#inline(id: string, version: number): boolean {
		return this.#sql.exec("SELECT 1 FROM pim_artifact_files WHERE artifact = ? AND version = ? LIMIT 1", id, version).toArray().length === 0;
	}

	/** A version's files with their bytes; only those at `paths`, if given. */
	async read(id: string, version: number, paths?: readonly string[]): Promise<Map<string, { type: string; bytes: Uint8Array }>> {
		const found = this.version(id, version);
		if (!found) throw new HttpError(404, `No version ${version} of artifact ${id}`);
		const wanted = paths ? found.files.filter((file) => paths.includes(file.path)) : found.files;
		if (this.#inline(id, version)) {
			const [row] = this.#sql.exec("SELECT content FROM pim_artifact_versions WHERE artifact = ? AND version = ?", id, version).toArray();
			return new Map(wanted.map((file) => [file.path, { type: file.type, bytes: encoder.encode(String(row?.content ?? "")) }]));
		}
		return readFiles(this.#bucket, this.#owner(), wanted);
	}

	/** One file of a version as text: its main file, unless `path` names another. */
	async text(id: string, version: number, path?: string): Promise<string> {
		const found = this.version(id, version);
		if (!found) throw new HttpError(404, `No version ${version} of artifact ${id}`);
		const wanted = path ?? ENTRY_FILES[this.get(id)!.kind];
		if (!found.files.some((file) => file.path === wanted)) throw new HttpError(404, `Version ${version} has no file ${wanted}`);
		return textOf((await this.read(id, version, [wanted])).get(wanted)!.bytes);
	}

	/**
	 * Makes sure a version's files are in R2, where others' spaces read them:
	 * a version from before files is moved there, keeping its hash.
	 */
	async stored(id: string, version: number): Promise<ArtifactVersion> {
		const found = this.version(id, version);
		if (!found) throw new HttpError(404, `No version ${version} of artifact ${id}`);
		if (!this.#inline(id, version)) return found;
		const [row] = this.#sql.exec("SELECT content FROM pim_artifact_versions WHERE artifact = ? AND version = ?", id, version).toArray();
		const file = found.files[0]!;
		await this.#store([{ ...file }], new Map([[file.sha256, encoder.encode(String(row!.content))]]), () => {
			if (!this.#inline(id, version)) return;
			this.#sql.exec("INSERT INTO pim_artifact_files (artifact, version, path, sha256, size, type) VALUES (?, ?, ?, ?, ?, ?)", id, version, file.path, file.sha256, file.size, file.type);
			this.#sql.exec("UPDATE pim_artifact_versions SET content = '' WHERE artifact = ? AND version = ?", id, version);
		});
		return this.version(id, version)!;
	}

	/** Bytes all artifacts take: each distinct file once, and versions from before files as they are. */
	totalBytes(): number {
		return this.fileBytes() + Number(this.#sql.exec(`SELECT COALESCE(SUM(size), 0) AS total FROM pim_artifact_versions v WHERE ${INLINE}`).one().total);
	}

	/** Bytes artifacts keep in R2, outside this object's database. */
	fileBytes(): number {
		return Number(this.#sql.exec("SELECT COALESCE(SUM(size), 0) AS total FROM (SELECT sha256, MAX(size) AS size FROM pim_artifact_files GROUP BY sha256)").one().total);
	}

	/** Whether this file's bytes are already stored, for some version. */
	#known(hash: string): boolean {
		return this.#sql.exec("SELECT 1 FROM pim_artifact_files WHERE sha256 = ? LIMIT 1", hash).toArray().length > 0;
	}

	/**
	 * Refuses a version that would break a limit: its files' size, the
	 * versions one artifact keeps, how many artifacts there are, and the
	 * bytes its new files would add. `artifact` is null for a new one.
	 */
	#checkRoom(draft: Draft, artifact: string | null): void {
		const limits = this.#limits();
		const size = draft.files.reduce((total, file) => total + file.size, 0);
		const perVersion = Math.min(MAX_ARTIFACT_BYTES, limits.artifactBytes ?? MAX_ARTIFACT_BYTES);
		if (size > perVersion) throw new HttpError(413, `An artifact can be at most ${perVersion} bytes; this one is ${size}. Make it smaller.`);
		if (draft.files.length > MAX_ARTIFACT_FILES) throw new HttpError(413, `An artifact can have at most ${MAX_ARTIFACT_FILES} files; this one has ${draft.files.length}.`);
		if (artifact === null) {
			const count = Number(this.#sql.exec("SELECT COUNT(*) AS count FROM pim_artifacts").one().count);
			if (limits.artifacts !== null && count >= limits.artifacts) {
				throw new HttpError(429, `You can keep up to ${limits.artifacts} artifacts. Delete one first.`);
			}
		} else if (limits.artifactVersions !== null) {
			const count = Number(this.#sql.exec("SELECT COUNT(*) AS count FROM pim_artifact_versions WHERE artifact = ?", artifact).one().count);
			if (count >= limits.artifactVersions) {
				throw new HttpError(
					429,
					`This artifact has ${count} versions, the most one can keep. Delete it, or make a new artifact from its latest version.`,
				);
			}
		}
		const added = [...new Map(draft.files.filter((file) => !this.#known(file.sha256)).map((file) => [file.sha256, file.size])).values()].reduce(
			(total, bytes) => total + bytes,
			0,
		);
		const total = Math.min(MAX_ARTIFACT_STORAGE_BYTES, limits.artifactStorageBytes ?? MAX_ARTIFACT_STORAGE_BYTES);
		const used = this.totalBytes();
		if (added > 0 && used + added > total) {
			throw new HttpError(429, `Artifacts can take up to ${total} bytes in all; ${used} are used. Delete some first.`);
		}
		const room = this.#storageRoom();
		if (room !== null && added > room) throw new HttpError(429, `Space storage quota exceeded: there is room for ${Math.max(0, room)} more bytes.`);
	}

	/** A version's files from new contents, over `base`'s files when given (whose other files it keeps), without `remove`. */
	async #draft(kind: ArtifactKind, put: FileContents, base: readonly ArtifactFile[] = [], remove: readonly string[] = []): Promise<Draft> {
		const files = new Map(base.map((file) => [file.path, file]));
		for (const path of remove) {
			if (path === ENTRY_FILES[kind]) throw new HttpError(400, `${path} is the artifact's main file, which it can't do without.`);
			if (!files.delete(checkPath(path))) throw new HttpError(400, `There is no file ${path} to delete.`);
		}
		const bytes = new Map<string, Uint8Array>();
		for (const [path, content] of Object.entries(put)) {
			const data = typeof content === "string" ? encoder.encode(content) : content;
			const hash = await sha256(data);
			files.set(checkPath(path), { path, sha256: hash, size: data.byteLength, type: fileType(path) });
			bytes.set(hash, data);
		}
		if (!files.has(ENTRY_FILES[kind])) throw new HttpError(400, `A ${kind} artifact needs its main file, ${ENTRY_FILES[kind]}.`);
		return { files: [...files.values()].sort((a, b) => (a.path < b.path ? -1 : 1)), bytes };
	}

	/**
	 * Stores a draft's new files in R2, then runs `commit`, with nothing
	 * awaited between its checks and its writes. While a file is being
	 * stored, it's claimed, so a deletion doesn't collect it; one a refused
	 * write stored and no version lists is collected after.
	 */
	async #store<T>(files: readonly ArtifactFile[], bytes: ReadonlyMap<string, Uint8Array>, commit: () => T): Promise<T> {
		const write = crypto.randomUUID();
		const hashes = [...new Set(files.map((file) => file.sha256))].filter((hash) => bytes.has(hash));
		const now = Date.now();
		for (const hash of hashes) this.#sql.exec("INSERT INTO pim_artifact_pending (sha256, write, at) VALUES (?, ?, ?)", hash, write, now);
		try {
			await Promise.all(
				hashes.map((hash) =>
					this.#locked(hash, async () => {
						await this.#bucket.put(blobKey(this.#owner(), hash), bytes.get(hash)!);
					}),
				),
			);
			return commit();
		} finally {
			this.#sql.exec("DELETE FROM pim_artifact_pending WHERE write = ?", write);
			await this.#collect(hashes);
		}
	}

	/** Runs R2 work on one file hash after the work on it before. */
	#locked(hash: string, work: () => Promise<void>): Promise<void> {
		const before = this.#locks.get(hash) ?? Promise.resolve();
		const done = before.then(work, work);
		const settled = done.catch(() => undefined);
		this.#locks.set(hash, settled);
		void settled.then(() => {
			if (this.#locks.get(hash) === settled) this.#locks.delete(hash);
		});
		return done;
	}

	/** Deletes from R2 the files no version lists and no write is storing. */
	async #collect(hashes: readonly string[]): Promise<void> {
		this.#sql.exec("DELETE FROM pim_artifact_pending WHERE at < ?", Date.now() - PENDING_MS);
		await Promise.all(
			hashes.map((hash) =>
				this.#locked(hash, async () => {
					// Checked here, just before deleting: a write that claims it later stores it again after.
					if (this.#known(hash) || this.#sql.exec("SELECT 1 FROM pim_artifact_pending WHERE sha256 = ? LIMIT 1", hash).toArray().length > 0) return;
					await this.#bucket.delete(blobKey(this.#owner(), hash));
				}),
			),
		);
	}

	/** Writes a version's row and its files' rows. */
	#insertVersion(id: string, version: number, draft: Draft, hash: string, input: { source: ArtifactSource; restoredFrom?: number; callId?: string }, now: number) {
		const size = draft.files.reduce((total, file) => total + file.size, 0);
		this.#sql.exec(
			"INSERT INTO pim_artifact_versions (artifact, version, content, sha256, size, source, restored_from, call_id, created_at) VALUES (?, ?, '', ?, ?, ?, ?, ?, ?)",
			id,
			version,
			hash,
			size,
			input.source,
			input.restoredFrom ?? null,
			input.callId ?? null,
			now,
		);
		for (const file of draft.files) {
			this.#sql.exec("INSERT INTO pim_artifact_files (artifact, version, path, sha256, size, type) VALUES (?, ?, ?, ?, ?, ?)", id, version, file.path, file.sha256, file.size, file.type);
		}
	}

	/**
	 * Makes an artifact with its first version: its main file's `content`,
	 * and any other `files`. Run again with the same id, it returns what the
	 * first run made, or is refused (410) if that was deleted since.
	 */
	async create(input: { id: string; title: string; kind: ArtifactKind; content: string | Uint8Array; files?: FileContents; session: string | null }): Promise<ArtifactVersion> {
		const draft = await this.#draft(input.kind, { ...input.files, [ENTRY_FILES[input.kind]]: input.content });
		const hash = await versionHash(input.kind, draft.files);
		const check = () => {
			const existing = this.version(input.id, 1);
			if (existing) return existing;
			if (this.#sql.exec("SELECT 1 FROM pim_artifact_deleted WHERE id = ?", input.id).toArray().length > 0) {
				throw new HttpError(410, "This artifact was deleted, so this create, run again, made nothing. Make a new artifact if the user still wants it.");
			}
			this.#checkRoom(draft, null);
			return undefined;
		};
		// Checked before storing anything, and again when writing, after storing took a while.
		const before = check();
		if (before) return before;
		return this.#store(draft.files, draft.bytes, () => {
			const existing = check();
			if (existing) return existing;
			const now = Date.now();
			this.#sql.exec(
				"INSERT INTO pim_artifacts (id, title, kind, session, head, created_at, updated_at) VALUES (?, ?, ?, ?, 1, ?, ?)",
				input.id,
				input.title,
				input.kind,
				input.session,
				now,
				now,
			);
			this.#insertVersion(input.id, 1, draft, hash, { source: "agent" }, now);
			return this.version(input.id, 1)!;
		});
	}

	/**
	 * Adds a version to `id`, based on `baseVersion`, which must still be the
	 * latest: the latest's files, with `files` put over them (new or
	 * changed) and `remove` taken away. `callId` makes a replayed tool call
	 * return the version it made instead of adding another. A version with
	 * the same files as the latest adds nothing.
	 */
	async append(
		id: string,
		input: {
			baseVersion: number;
			/** The main file's new content: the same as giving it in `files`. */
			content?: string | Uint8Array;
			files?: FileContents;
			remove?: readonly string[];
			source: ArtifactSource;
			restoredFrom?: number;
			callId?: string;
			title?: string;
			/** The files to have, as another version listed them, for a restore. */
			copy?: readonly ArtifactFile[];
		},
	): Promise<{ version: ArtifactVersion; changed: boolean }> {
		const summary = this.get(id);
		if (!summary) throw new HttpError(404, `No artifact ${id}`);
		const replayed = () => {
			if (input.callId === undefined) return undefined;
			const [made] = this.#sql.exec("SELECT version FROM pim_artifact_versions WHERE artifact = ? AND call_id = ?", id, input.callId).toArray();
			return made ? { version: this.version(id, Number(made.version))!, changed: true } : undefined;
		};
		const early = replayed();
		if (early) return early;
		const latest = this.version(id)!;
		const put = input.content === undefined ? (input.files ?? {}) : { ...input.files, [ENTRY_FILES[summary.kind]]: input.content };
		const draft = input.copy ? { files: [...input.copy], bytes: new Map<string, Uint8Array>() } : await this.#draft(summary.kind, put, latest.files, input.remove);
		const hash = await versionHash(summary.kind, draft.files);
		// Checked before storing anything, and again when writing, with nothing awaited between the checks and the write.
		const check = () => {
			const again = replayed();
			if (again) return again;
			const current = this.get(id);
			if (!current) throw new HttpError(404, `No artifact ${id}`);
			if (input.baseVersion !== current.version) {
				throw new HttpError(409, `Version ${input.baseVersion} is not the latest: version ${current.version} is. Read it, then edit that.`);
			}
			const title = input.title ?? current.title;
			if (hash === current.sha256 && input.source !== "restore") {
				if (title !== current.title) this.#sql.exec("UPDATE pim_artifacts SET title = ?, updated_at = ? WHERE id = ?", title, Date.now(), id);
				return { version: this.version(id)!, changed: false };
			}
			// A version that is refused renames nothing.
			this.#checkRoom(draft, id);
			return undefined;
		};
		const before = check();
		if (before) return before;
		return this.#store(draft.files, draft.bytes, () => {
			const decided = check();
			if (decided) return decided;
			const current = this.get(id)!;
			const now = Date.now();
			const next = current.version + 1;
			this.#insertVersion(id, next, draft, hash, input, now);
			this.#sql.exec("UPDATE pim_artifacts SET head = ?, title = ?, updated_at = ? WHERE id = ?", next, input.title ?? current.title, now, id);
			return { version: this.version(id, next)!, changed: true };
		});
	}

	/** Restores `version` as a new latest version, if `baseVersion` is still the latest. */
	async restore(id: string, version: number, baseVersion: number): Promise<ArtifactVersion> {
		if (!this.version(id, version)) throw new HttpError(404, `No version ${version} of artifact ${id}`);
		const old = await this.stored(id, version);
		return (await this.append(id, { baseVersion, copy: old.files, source: "restore", restoredFrom: version })).version;
	}

	/** Deletes an artifact and every version of it, and then the files no other version has. */
	async delete(id: string): Promise<boolean> {
		if (!this.get(id)) return false;
		const hashes = this.#sql
			.exec("SELECT DISTINCT sha256 FROM pim_artifact_files WHERE artifact = ?", id)
			.toArray()
			.map((row) => String(row.sha256));
		// The fence first, then the deletion, with nothing awaited between: if the fence can't be written, nothing is deleted.
		this.#sql.exec("INSERT OR IGNORE INTO pim_artifact_deleted (id, deleted_at) VALUES (?, ?)", id, Date.now());
		this.#sql.exec("DELETE FROM pim_artifact_versions WHERE artifact = ?", id);
		this.#sql.exec("DELETE FROM pim_artifact_files WHERE artifact = ?", id);
		this.#sql.exec("DELETE FROM pim_artifact_data WHERE artifact = ?", id);
		this.#sql.exec("DELETE FROM pim_artifact_grants WHERE artifact = ?", id);
		this.#sql.exec("DELETE FROM pim_artifact_circles WHERE artifact = ?", id);
		this.#sql.exec("DELETE FROM pim_artifacts WHERE id = ?", id);
		await this.#collect(hashes);
		return true;
	}

	/** Deletes every file artifacts keep in R2, including any a lost write left unlisted. Run when the space is erased. */
	async deleteAllFiles(): Promise<void> {
		let cursor: string | undefined;
		do {
			const listed = await this.#bucket.list({ prefix: `${this.#owner()}/`, ...(cursor ? { cursor } : {}) });
			if (listed.objects.length > 0) await this.#bucket.delete(listed.objects.map((object) => object.key));
			cursor = listed.truncated ? listed.cursor : undefined;
		} while (cursor);
	}

	/** Whether any file is left in R2 under the owner's prefix. */
	async anyFiles(): Promise<boolean> {
		return (await this.#bucket.list({ prefix: `${this.#owner()}/`, limit: 1 })).objects.length > 0;
	}

	/** A value the artifact kept, or null. */
	dataGet(id: string, scope: DataScope, key: string): string | null {
		const [row] = this.#sql
			.exec("SELECT value FROM pim_artifact_data WHERE artifact = ? AND scope = ? AND key = ?", id, scope, checkKey(key))
			.toArray();
		return row ? String(row.value) : null;
	}

	/** The keys the artifact kept, those starting with `prefix` if given, in order. */
	dataKeys(id: string, scope: DataScope, prefix = ""): string[] {
		return this.#sql
			.exec(
				"SELECT key FROM pim_artifact_data WHERE artifact = ? AND scope = ? AND substr(key, 1, ?) = ? ORDER BY key",
				id,
				scope,
				prefix.length,
				prefix,
			)
			.toArray()
			.map((row) => String(row.key));
	}

	/** Keeps a value under a key for the artifact, within its room and the space's. */
	dataSet(id: string, scope: DataScope, key: string, value: string): void {
		checkKey(key);
		if (typeof value !== "string") throw new HttpError(400, "An artifact can keep only text: use JSON.stringify for anything else.");
		const size = utf8Bytes(key) + utf8Bytes(value);
		const [old] = this.#sql.exec("SELECT size FROM pim_artifact_data WHERE artifact = ? AND scope = ? AND key = ?", id, scope, key).toArray();
		const replaced = old ? Number(old.size) : 0;
		const used = this.dataBytes(id, scope) - replaced;
		if (used + size > MAX_ARTIFACT_DATA_BYTES) {
			throw new HttpError(413, `An artifact can keep up to ${MAX_ARTIFACT_DATA_BYTES} bytes; this would make ${used + size}.`);
		}
		const all = Number(this.#sql.exec("SELECT COALESCE(SUM(size), 0) AS total FROM pim_artifact_data").one().total) - replaced;
		if (all + size > MAX_ARTIFACT_DATA_TOTAL_BYTES) {
			throw new HttpError(429, `Artifacts can keep up to ${MAX_ARTIFACT_DATA_TOTAL_BYTES} bytes in all; ${all} are used. Delete an artifact first.`);
		}
		const room = this.#storageRoom();
		if (room !== null && size > room) throw new HttpError(429, `Space storage quota exceeded: there is room for ${Math.max(0, room)} more bytes.`);
		this.#sql.exec(
			"INSERT INTO pim_artifact_data (artifact, scope, key, value, size, updated_at) VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT (artifact, scope, key) DO UPDATE SET value = excluded.value, size = excluded.size, updated_at = excluded.updated_at",
			id,
			scope,
			key,
			value,
			size,
			Date.now(),
		);
	}

	dataDelete(id: string, scope: DataScope, key: string): void {
		this.#sql.exec("DELETE FROM pim_artifact_data WHERE artifact = ? AND scope = ? AND key = ?", id, scope, checkKey(key));
	}

	/** Bytes the artifact keeps through the bridge, in one scope. */
	dataBytes(id: string, scope: DataScope): number {
		return Number(
			this.#sql.exec("SELECT COALESCE(SUM(size), 0) AS total FROM pim_artifact_data WHERE artifact = ? AND scope = ?", id, scope).one().total,
		);
	}

	/** Everything the artifact keeps in a scope, by key. */
	data(id: string, scope: DataScope): Record<string, string> {
		return Object.fromEntries(
			this.#sql
				.exec("SELECT key, value FROM pim_artifact_data WHERE artifact = ? AND scope = ? ORDER BY key", id, scope)
				.toArray()
				.map((row) => [String(row.key), String(row.value)]),
		);
	}

	/** The circles the artifact is shared with. */
	circlesOf(id: string): string[] {
		return this.#sql
			.exec("SELECT circle FROM pim_artifact_circles WHERE artifact = ? ORDER BY circle", id)
			.toArray()
			.map((row) => String(row.circle));
	}

	/** Shares the artifact with exactly these circles. */
	setCircles(id: string, circles: readonly string[]): void {
		this.#sql.exec("DELETE FROM pim_artifact_circles WHERE artifact = ?", id);
		for (const circle of new Set(circles)) this.#sql.exec("INSERT INTO pim_artifact_circles (artifact, circle) VALUES (?, ?)", id, circle);
	}

	/** The artifacts shared with a circle, most recently changed first. */
	sharedWith(circle: string): ArtifactSummary[] {
		const ids = new Set(
			this.#sql
				.exec("SELECT artifact FROM pim_artifact_circles WHERE circle = ?", circle)
				.toArray()
				.map((row) => String(row.artifact)),
		);
		return this.list().filter((artifact) => ids.has(artifact.id));
	}

	/** Forgets a deleted circle's shares. */
	forgetCircle(circle: string): void {
		this.#sql.exec("DELETE FROM pim_artifact_circles WHERE circle = ?", circle);
	}

	/**
	 * What this person keeps for artifacts that aren't theirs: others' they
	 * use, shared or published, by the key the bridge kept it under.
	 */
	othersData(): { artifact: string; data: Record<string, string> }[] {
		return this.#sql
			.exec("SELECT DISTINCT artifact FROM pim_artifact_data WHERE artifact NOT IN (SELECT id FROM pim_artifacts) ORDER BY artifact")
			.toArray()
			.map((row) => ({ artifact: String(row.artifact), data: this.data(String(row.artifact), "own") }));
	}

	/** Whether the person let this version (by its hash) use `capability`. */
	granted(id: string, sha: string, capability: string): boolean {
		return this.#sql.exec("SELECT 1 FROM pim_artifact_grants WHERE artifact = ? AND sha256 = ? AND capability = ?", id, sha, capability).toArray().length > 0;
	}

	grant(id: string, sha: string, capability: string): void {
		this.#sql.exec("INSERT OR IGNORE INTO pim_artifact_grants (artifact, sha256, capability, granted_at) VALUES (?, ?, ?, ?)", id, sha, capability, Date.now());
	}

	/**
	 * Every artifact with every version and the files each has, for the
	 * owner's export, and the files' contents by hash, once each: text as
	 * text, anything else as base64. Past `EXPORT_INLINE_BYTES`, files are
	 * listed without their contents, which the app still downloads.
	 */
	async export() {
		const artifacts = this.list().map((artifact) => ({
			...artifact,
			versions: this.versions(artifact.id)
				.reverse()
				.map((info) => ({ ...info, files: this.version(artifact.id, info.version)!.files })),
			data: this.data(artifact.id, "own"),
			sharedData: this.data(artifact.id, "shared"),
			circles: this.circlesOf(artifact.id),
		}));
		const contents: { sha256: string; size: number; encoding?: "utf8" | "base64"; content?: string }[] = [];
		const seen = new Set<string>();
		let inlined = 0;
		for (const artifact of artifacts) {
			for (const version of artifact.versions) {
				for (const file of version.files) {
					if (seen.has(file.sha256)) continue;
					seen.add(file.sha256);
					if (inlined + file.size > EXPORT_INLINE_BYTES) {
						contents.push({ sha256: file.sha256, size: file.size });
						continue;
					}
					inlined += file.size;
					const { bytes } = (await this.read(artifact.id, version.version, [file.path])).get(file.path)!;
					if (isTextType(file.type)) contents.push({ sha256: file.sha256, size: file.size, encoding: "utf8", content: textOf(bytes) });
					else contents.push({ sha256: file.sha256, size: file.size, encoding: "base64", content: Buffer.from(bytes).toString("base64") });
				}
			}
		}
		return { artifacts, files: contents };
	}
}

/**
 * Headers for any response that carries an artifact's bytes. HTML in it can
 * only ever run sandboxed, in an opaque origin: even opened directly in a tab,
 * it can't read this origin's cookies or storage, or call its API. The CSP
 * also keeps it from loading anything or connecting anywhere, except, with
 * `runtime`, Pim's own scripts under `RUNTIME_PATH`. That is not a
 * promise it can't send data out: it can still navigate itself away, with
 * what it shows or what someone typed in the address.
 */
export function artifactHeaders(origin: string, contentType: string, options: { runtime?: boolean } = {}): Headers {
	return new Headers({
		"content-type": contentType,
		"content-security-policy": [
			"sandbox allow-scripts",
			"default-src 'none'",
			// A diagram or a JSX artifact also loads the scripts it runs on, Pim's own (see `RUNTIME_PATH`).
			options.runtime ? `script-src 'unsafe-inline' ${origin}${RUNTIME_PATH}` : "script-src 'unsafe-inline'",
			"style-src 'unsafe-inline'",
			"img-src data: blob:",
			"font-src data:",
			"media-src data: blob:",
			"connect-src 'none'",
			"form-action 'none'",
			"base-uri 'none'",
			`frame-ancestors ${origin}`,
		].join("; "),
		"cache-control": "no-store, private",
		"x-content-type-options": "nosniff",
		"referrer-policy": "no-referrer",
		"cross-origin-resource-policy": "same-origin",
		"permissions-policy": "camera=(), microphone=(), geolocation=(), usb=(), serial=(), bluetooth=(), payment=(), publickey-credentials-get=(), publickey-credentials-create=()",
	});
}

/**
 * Reports the page's height to the app that shows it, the one message an
 * artifact sends. Added after the artifact's own markup, so it can't change
 * how the document is parsed.
 */
export const RESIZE_SCRIPT = `<script>(()=>{let last=-1;const post=()=>{const h=Math.ceil(document.documentElement.scrollHeight);if(h!==last){last=h;parent.postMessage({type:"pim:artifact-height",height:h},"*")}};addEventListener("load",post);new ResizeObserver(post).observe(document.documentElement);post()})()</script>`;

/**
 * Where the scripts that diagrams and JSX artifacts run on are served from:
 * static files the web app's build makes (`web/scripts/build-artifact-runtimes.mjs`),
 * the same for everyone, which load nothing else.
 */
export const RUNTIME_PATH = "/artifact-runtime/";

const escapeHtml = (text: string) => text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

/**
 * The bridge an artifact reaches Pim through: `window.pim`, whose calls are
 * messages to the app that shows it, which asks Pim and the person (see
 * `ArtifactFrame` in the web app). It answers only messages from that app,
 * the frame's parent. Added before the artifact's own scripts, so they find it.
 * A page open on its own, with no app around it, gets failed calls.
 *
 * In a dashboard's widget, `pim.size` is the size it's shown at, which the
 * app puts in the frame's address; elsewhere it's null.
 *
 * In the app, it also keeps the page's moves within itself (a link to a
 * `#section`, `history.pushState`) out of the browser's history, which the
 * frame shares with the app: otherwise Back would undo them one by one
 * instead of leaving the artifact. A link the page handles itself is left alone.
 */
export const BRIDGE_SCRIPT = `<script>(()=>{let next=0;const waiting=new Map();const alone=parent===window;if(!alone){const replace=history.replaceState.bind(history);history.pushState=(state,title,url)=>replace(state,title,url);addEventListener("click",(event)=>{const link=event.target instanceof Element?event.target.closest("a[href]"):null;if(event.defaultPrevented||!link||typeof link.href!=="string"||(link.target&&link.target!=="_self"))return;const [page,hash]=link.href.split("#");if(hash===undefined||page!==location.href.split("#")[0])return;event.preventDefault();location.replace(link.href)})}addEventListener("message",(event)=>{if(event.source!==parent)return;const data=event.data;if(!data||data.type!=="pim:reply"||!waiting.has(data.id))return;const [resolve,reject]=waiting.get(data.id);waiting.delete(data.id);if(data.error!==undefined)reject(new Error(String(data.error)));else resolve(data.value)});const call=(op,args)=>alone?Promise.reject(new Error("Pim isn't here: this page is open on its own.")):new Promise((resolve,reject)=>{const id=++next;waiting.set(id,[resolve,reject]);parent.postMessage({type:"pim:call",id,op,args},"*")});const store=(scope)=>Object.freeze({get:(key)=>call(scope+".get",{key}),set:(key,value)=>call(scope+".set",{key,value}),delete:(key)=>call(scope+".delete",{key}),list:(prefix)=>call(scope+".list",{prefix})});window.pim=Object.freeze({storage:store("storage"),shared:store("shared"),ask:(prompt)=>call("model.ask",{prompt}),tools:Object.freeze({call:(name,input)=>call("tools.call",{name,input})}),chat:(text)=>call("chat.draft",{text}),open:()=>call("app.open",{}),size:["small","medium","large"].find((size)=>size===new URLSearchParams(location.search).get("size"))??null})})()</script>`;

/**
 * An HTML artifact with the bridge added first: after its doctype, so the
 * page keeps standards mode, and before everything else of its own.
 */
function withBridge(content: string): string {
	const doctype = /^\s*<!doctype[^>]*>/i.exec(content);
	return doctype ? doctype[0] + BRIDGE_SCRIPT + content.slice(doctype[0].length) : BRIDGE_SCRIPT + content;
}

const PAGE_HEAD =
	'<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">' +
	"<style>html,body{margin:0;background:#fff}body{font:14px/1.5 system-ui,sans-serif}</style>" +
	BRIDGE_SCRIPT;

/**
 * The page a framed version is shown as: an HTML artifact as it is; an SVG
 * one in a page that fits it to the frame; a Mermaid one as its source, in
 * text, which the Mermaid runtime draws; a JSX one compiled, after the React
 * runtime and the modules it imports. Each ends with the height script.
 * With `widget`, the page is its widget file instead of its main one.
 */
export function framePage(kind: ArtifactKind, files: LoadedFiles, origin: string, options: { widget?: boolean } = {}): Response {
	const entry = options.widget ? WIDGET_FILES[kind] : ENTRY_FILES[kind];
	const main = entry === undefined ? undefined : files.get(entry);
	if (!main) throw new HttpError(404, options.widget ? "The artifact has no widget" : `The artifact has no ${entry}`);
	const content = textOf(main.bytes);
	const html = (body: string, runtime = false) =>
		new Response(body + RESIZE_SCRIPT, { headers: artifactHeaders(origin, "text/html; charset=utf-8", { runtime }) });
	switch (kind) {
		case "html":
			return inlineOwnFiles(html(withBridge(content)), files);
		case "svg":
			return html(`${PAGE_HEAD}<style>svg{display:block;max-width:100%;height:auto;margin:0 auto}</style></head><body>${content}</body></html>`);
		case "mermaid":
			return html(
				`${PAGE_HEAD}<style>body{padding:16px}pre.mermaid{margin:0;display:flex;justify-content:center}pre.error{white-space:pre-wrap;color:#991b1b}</style></head>` +
					`<body><pre class="mermaid">${escapeHtml(content)}</pre><script src="${origin}${RUNTIME_PATH}mermaid.js"></script></body></html>`,
				true,
			);
		case "jsx": {
			const { code, runtimes } = compileJsxApp(files, entry!);
			const scripts = [...runtimes, "tailwind"].map((name) => `<script src="${origin}${RUNTIME_PATH}${name}.js"></script>`).join("");
			return html(
				`${PAGE_HEAD}</head><body><div id="root"></div>${scripts}<script>__pimMount(function (require, module, exports) {\n${inlineScript(code)}\n})</script></body></html>`,
				true,
			);
		}
		default:
			throw new HttpError(404, "This kind of artifact isn't shown in a frame");
	}
}

/** What an attribute names, as one of the artifact's files, if it is one: relative to the main file, without a query or fragment. */
function ownFile(files: LoadedFiles, reference: string | null) {
	if (!reference || /^[a-z][a-z0-9+.-]*:|^\/\/|^#/i.test(reference.trim())) return undefined;
	const path = resolvePath(ENTRY_FILES.html, reference.trim().split(/[?#]/)[0]!);
	return path === null ? undefined : files.get(path);
}

/**
 * A page with what it loads of its own files put inline, since a sandboxed
 * page can load nothing: scripts become inline scripts, stylesheets
 * `<style>` (their `url()`s `data:` URLs), and images, media and icons
 * `data:` URLs. What names no file of its own is left alone, and blocked.
 */
function inlineOwnFiles(page: Response, files: LoadedFiles): Response {
	if (files.size < 2) return page;
	const media = (attribute: string) => ({
		element(element: Element) {
			const file = ownFile(files, element.getAttribute(attribute));
			if (file) element.setAttribute(attribute, dataUrl(file));
		},
	});
	return new HTMLRewriter()
		.on("script[src]", {
			element(element) {
				const file = ownFile(files, element.getAttribute("src"));
				if (!file) return;
				element.removeAttribute("src");
				element.setInnerContent(inlineScript(textOf(file.bytes)), { html: true });
			},
		})
		.on("link[href]", {
			element(element) {
				const rel = (element.getAttribute("rel") ?? "").toLowerCase().split(/\s+/);
				const href = element.getAttribute("href");
				const file = ownFile(files, href);
				if (!file) return;
				if (rel.includes("stylesheet")) {
					const path = resolvePath(ENTRY_FILES.html, href!.trim().split(/[?#]/)[0]!)!;
					const css = inlineCssUrls(textOf(file.bytes), path, files).replace(/<\/(style)/gi, "<\\/$1");
					element.replace(`<style>${css}</style>`, { html: true });
				} else if (rel.includes("icon")) element.setAttribute("href", dataUrl(file));
			},
		})
		.on("img[src]", media("src"))
		.on("source[src]", media("src"))
		.on("audio[src]", media("src"))
		.on("video[src]", media("src"))
		.on("video[poster]", media("poster"))
		.transform(page);
}

/**
 * A download's name: the title, made safe for a header and a file system,
 * and the version; for a file besides the main one, its name after them.
 */
export function downloadName(title: string, version: number, kind: ArtifactKind, path?: string): { ascii: string; utf8: string } {
	const extension = path === undefined ? EXTENSIONS[kind] : path.slice(path.lastIndexOf("/") + 1);
	const separator = path === undefined ? "." : "-";
	const cleaned = title
		.normalize("NFC")
		.replace(/[\u0000-\u001f\u007f"\\/:*?<>|]+/g, " ")
		.replace(/\s+/g, " ")
		.trim()
		.slice(0, 80) || "artifact";
	const utf8 = `${cleaned}-v${version}${separator}${extension}`;
	const ascii = `${cleaned.replace(/[^\x20-\x7e]+/g, "_").replace(/[;%]+/g, "_") || "artifact"}-v${version}${separator}${extension}`;
	return { ascii, utf8 };
}
