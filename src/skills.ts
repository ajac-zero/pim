import { Buffer } from "node:buffer";
import { fileType, isTextType, sha256 } from "./artifacts";
import { FileStore } from "./file-store";
import { HttpError } from "./http";

/**
 * Skills the person's agents write for work they do again and again, such as
 * "how we write the weekly report": named instructions in the Agent Skills
 * format (https://agentskills.io), kept in the owner's own Durable Object.
 * Each agent lists the skills it uses, the way it lists apps; the prompt
 * shows their names and descriptions, and the model loads one with
 * `read_skill` before the work it describes. Agents write them only with the
 * person's approval (./extensions/skills.ts), since what a skill says steers
 * every later run that loads it.
 *
 * Besides its instructions (its SKILL.md), a skill can have supporting
 * files: references, templates, or scripts to run on the person's computer,
 * by paths such as `references/guide.md`. As with artifacts' files, their
 * bytes are in R2 (the space's `BLOBS` bucket, at `<owner>/skills/<sha256>`),
 * each stored once however many versions and skills have it, and this
 * object keeps what each version lists (see ./file-store.ts). Versions from
 * before that keep their files, which are text, in their own row.
 *
 * Every write adds a version, and nothing rewrites one; the person can
 * restore an older one, which adds a new version with its content. The
 * latest `MAX_SKILL_VERSIONS` are kept. A write names the version it was
 * based on and is refused when that is no longer the latest, so two writes
 * can't overwrite each other unseen.
 */

export type SkillVersionInfo = {
	readonly version: number;
	/** The agent that wrote it, by name then; null for a version the person restored. */
	readonly author: string | null;
	/** The version a restore copied. */
	readonly restoredFrom: number | null;
	readonly createdAt: number;
};

/** A supporting file, as a version lists it: its path relative to the skill, its size in bytes, and its media type. */
export type SkillFile = { readonly path: string; readonly size: number; readonly type: string };

/** A supporting file's content, as a write gives it: text, or bytes. */
export type SkillFileContent = { readonly path: string; readonly content: string | Uint8Array };

export type SkillVersion = SkillVersionInfo & {
	readonly name: string;
	readonly description: string;
	readonly instructions: string;
	readonly files: readonly SkillFile[];
};

/** A skill as its latest version, without its instructions and files: what lists and prompts show of it. */
export type SkillSummary = SkillVersionInfo & {
	readonly name: string;
	readonly description: string;
	readonly updatedAt: number;
};

/** A skill as its latest version. */
export type Skill = SkillVersion & {
	readonly createdAt: number;
	readonly updatedAt: number;
};

export const MAX_SKILLS = 50;
export const MAX_SKILL_VERSIONS = 20;
export const MAX_SKILL_DESCRIPTION = 1024;
export const MAX_SKILL_INSTRUCTIONS = 20_000;
export const MAX_SKILL_FILES = 50;
/** The longest supporting file an agent writes out as text. */
export const MAX_SKILL_FILE_CHARS = 50_000;
/** One version's supporting files together, in bytes. */
export const MAX_SKILL_BYTES = 10_000_000;
/** All skills' supporting files together, each counted once, in bytes. */
export const MAX_SKILL_STORAGE_BYTES = 100_000_000;
/** How many bytes of files an export carries inline; the rest are listed by hash. */
const EXPORT_INLINE_BYTES = 16_000_000;

/** A supporting file's path: relative, its parts letters, digits, dots, hyphens and underscores, none starting with a dot, and not SKILL.md. */
const FILE_PATH = /^(?=.{1,200}$)(?!SKILL\.md$)[\w-][\w.-]*(\/[\w-][\w.-]*)*$/;

/** A skill's name as Agent Skills has it: lowercase letters, digits and single hyphens, at most 64 characters. */
export const SKILL_NAME = /^(?=.{1,64}$)[a-z0-9]+(-[a-z0-9]+)*$/;

const SCHEMA = `
CREATE TABLE IF NOT EXISTS pim_skills (
	name TEXT PRIMARY KEY,
	version INTEGER NOT NULL,
	created_at INTEGER NOT NULL
);
-- A version: its files are in pim_skill_files. Versions from before that keep theirs in files, as JSON; newer ones keep '[]'.
CREATE TABLE IF NOT EXISTS pim_skill_versions (
	name TEXT NOT NULL,
	version INTEGER NOT NULL,
	description TEXT NOT NULL,
	instructions TEXT NOT NULL,
	files TEXT NOT NULL DEFAULT '[]',
	author TEXT,
	restored_from INTEGER,
	created_at INTEGER NOT NULL,
	PRIMARY KEY (name, version)
);
-- The files each version has. Their bytes are in R2 at <owner>/skills/<sha256>, once each.
CREATE TABLE IF NOT EXISTS pim_skill_files (
	name TEXT NOT NULL,
	version INTEGER NOT NULL,
	path TEXT NOT NULL,
	sha256 TEXT NOT NULL,
	size INTEGER NOT NULL,
	type TEXT NOT NULL,
	PRIMARY KEY (name, version, path)
);
CREATE INDEX IF NOT EXISTS pim_skill_files_by_hash ON pim_skill_files (sha256);
`;

type Row = Record<string, SqlStorageValue>;

/** A file a version lists: stored in R2 by its hash, or, in a version from before that, its text in the version's row. */
type Listed = SkillFile & ({ readonly sha256: string } | { readonly text: string });

/** A version as it is about to be written: its files, and the bytes of those not stored yet, by hash. */
type Draft = { readonly files: (SkillFile & { readonly sha256: string })[]; readonly bytes: Map<string, Uint8Array> };

const encoder = new TextEncoder();
const utf8Bytes = (text: string) => encoder.encode(text).byteLength;

/** A file's media type: by its name, or plain text for other text, such as a Python script. */
function typeOf(path: string, bytes: Uint8Array): string {
	const type = fileType(path);
	if (type !== "application/octet-stream") return type;
	try {
		const text = new TextDecoder("utf-8", { fatal: true, ignoreBOM: false }).decode(bytes);
		return text.includes("\0") ? type : "text/plain";
	} catch {
		return type;
	}
}

const versionInfo = (row: Row): SkillVersionInfo => ({
	version: Number(row.version),
	author: row.author === null ? null : String(row.author),
	restoredFrom: row.restored_from === null ? null : Number(row.restored_from),
	createdAt: Number(row.created_at),
});

const LATEST = `SELECT v.*, s.created_at AS skill_created_at FROM pim_skills s
	JOIN pim_skill_versions v ON v.name = s.name AND v.version = s.version`;

/** The latest versions without their text, which lists and every model request read, so skills' size doesn't weigh on them. */
const SUMMARIES = `SELECT v.name, v.version, v.description, v.author, v.restored_from, v.created_at, s.created_at AS skill_created_at
	FROM pim_skills s JOIN pim_skill_versions v ON v.name = s.name AND v.version = s.version`;

const summaryOf = (row: Row): SkillSummary => ({
	name: String(row.name),
	description: String(row.description),
	...versionInfo(row),
	createdAt: Number(row.skill_created_at),
	updatedAt: Number(row.created_at),
});

/** What a write gives: the whole skill, the version it rewrites, if it does, and who wrote it. */
export type SkillWrite = {
	readonly name: string;
	readonly description: string;
	readonly instructions: string;
	/** Every supporting file; left out, a rewrite keeps the files it had. */
	readonly files?: readonly SkillFileContent[];
	readonly baseVersion?: number;
	/** The agent writing it, by name; left out for a restore. */
	readonly author?: string;
	readonly restoredFrom?: number;
};

export type SkillStoreOptions = {
	/** Bytes the space may still grow by, or null for no limit. */
	readonly storageRoom: () => number | null;
	/** Where files' bytes are kept. */
	readonly bucket: R2Bucket;
	/** The owner's id: their files' prefix in the bucket. */
	readonly owner: () => string;
};

export class SkillStore {
	readonly #sql: SqlStorage;
	readonly #options: SkillStoreOptions;
	readonly #blobs: FileStore;

	constructor(sql: SqlStorage, options: SkillStoreOptions) {
		this.#sql = sql;
		this.#options = options;
		this.#sql.exec(SCHEMA);
		this.#blobs = new FileStore(sql, {
			bucket: options.bucket,
			key: (hash) => this.#key(hash),
			pending: "pim_skill_pending",
			listed: (hash) => this.#sql.exec("SELECT 1 FROM pim_skill_files WHERE sha256 = ? LIMIT 1", hash).toArray().length > 0,
		});
	}

	#key(hash: string): string {
		return `${this.#options.owner()}/skills/${hash}`;
	}

	/** Every skill, by name, without its instructions and files. */
	list(): SkillSummary[] {
		return this.#sql.exec(`${SUMMARIES} ORDER BY s.name`).toArray().map(summaryOf);
	}

	has(name: string): boolean {
		return this.#sql.exec("SELECT 1 FROM pim_skills WHERE name = ?", name).toArray().length > 0;
	}

	get(name: string): Skill | undefined {
		const [row] = this.#sql.exec(`${LATEST} WHERE s.name = ?`, name).toArray();
		if (!row) return undefined;
		return { ...this.#versionOf(row), createdAt: Number(row.skill_created_at), updatedAt: Number(row.created_at) };
	}

	/** Every version kept, newest first, without their text. */
	history(name: string): SkillVersionInfo[] {
		return this.#sql
			.exec("SELECT version, author, restored_from, created_at FROM pim_skill_versions WHERE name = ? ORDER BY version DESC", name)
			.toArray()
			.map(versionInfo);
	}

	version(name: string, version: number): SkillVersion | undefined {
		const [row] = this.#sql.exec("SELECT * FROM pim_skill_versions WHERE name = ? AND version = ?", name, version).toArray();
		return row ? this.#versionOf(row) : undefined;
	}

	#versionOf(row: Row): SkillVersion {
		const name = String(row.name);
		return {
			name,
			description: String(row.description),
			instructions: String(row.instructions),
			files: this.#listed(name, Number(row.version), String(row.files)).map(({ path, size, type }) => ({ path, size, type })),
			...versionInfo(row),
		};
	}

	/** The files a version lists; `inline` is its row's own, for a version from before files were in R2. */
	#listed(name: string, version: number, inline?: string): Listed[] {
		const files = this.#sql
			.exec("SELECT path, sha256, size, type FROM pim_skill_files WHERE name = ? AND version = ? ORDER BY path", name, version)
			.toArray()
			.map((row) => ({ path: String(row.path), sha256: String(row.sha256), size: Number(row.size), type: String(row.type) }));
		if (files.length > 0) return files;
		const own = inline ?? String(this.#sql.exec("SELECT files FROM pim_skill_versions WHERE name = ? AND version = ?", name, version).toArray()[0]?.files ?? "[]");
		return (JSON.parse(own) as { path: string; content: string }[]).map(({ path, content }) => ({
			path,
			size: utf8Bytes(content),
			type: typeOf(path, encoder.encode(content)),
			text: content,
		}));
	}

	/** A supporting file's bytes, at a version. */
	async read(name: string, version: number, path: string): Promise<{ readonly file: SkillFile; readonly bytes: Uint8Array }> {
		const file = this.#listed(name, version).find((candidate) => candidate.path === path);
		if (!file) throw new HttpError(404, `Version ${version} of the skill ${name} has no file ${path}`);
		if ("text" in file) return { file, bytes: encoder.encode(file.text) };
		const object = await this.#options.bucket.get(this.#key(file.sha256));
		if (!object) throw new HttpError(404, `The file ${path} is no longer stored`);
		return { file, bytes: new Uint8Array(await object.arrayBuffer()) };
	}

	/** Bytes skills' files keep in R2, outside this object's database, each counted once. */
	fileBytes(): number {
		return Number(this.#sql.exec("SELECT COALESCE(SUM(size), 0) AS total FROM (SELECT sha256, MAX(size) AS size FROM pim_skill_files GROUP BY sha256)").one().total);
	}

	/** Checks what a write gives on its own, and throws what it refuses. */
	#checkInput(write: SkillWrite): SkillWrite {
		if (!SKILL_NAME.test(write.name)) {
			throw new HttpError(400, "A skill's name is lowercase letters, digits and single hyphens, at most 64 characters, such as weekly-report");
		}
		const description = write.description.trim();
		const instructions = write.instructions.trim();
		if (description === "" || description.length > MAX_SKILL_DESCRIPTION) {
			throw new HttpError(400, `A skill's description says what it is for and when to use it, in at most ${MAX_SKILL_DESCRIPTION} characters`);
		}
		if (instructions === "" || instructions.length > MAX_SKILL_INSTRUCTIONS) {
			throw new HttpError(400, `A skill's instructions must be at most ${MAX_SKILL_INSTRUCTIONS} characters, and not empty`);
		}
		if (write.files) {
			if (write.files.length > MAX_SKILL_FILES) throw new HttpError(400, `A skill can have up to ${MAX_SKILL_FILES} supporting files`);
			const paths = new Set<string>();
			for (const file of write.files) {
				if (!FILE_PATH.test(file.path)) {
					throw new HttpError(400, `${file.path} is not a supporting file's path: give one relative to the skill, such as references/guide.md`);
				}
				if (paths.has(file.path)) throw new HttpError(400, `Two supporting files are at ${file.path}`);
				paths.add(file.path);
			}
		}
		return { ...write, description, instructions };
	}

	/** The files a version will have: those given, or else those of `base`'s version, which a rewrite keeps. */
	async #draft(files: readonly SkillFileContent[] | undefined, base: { name: string; version: number } | undefined): Promise<Draft> {
		const draft: Draft = { files: [], bytes: new Map() };
		const add = async (path: string, content: string | Uint8Array) => {
			const bytes = typeof content === "string" ? encoder.encode(content) : content;
			const hash = await sha256(bytes);
			draft.files.push({ path, sha256: hash, size: bytes.byteLength, type: typeOf(path, bytes) });
			draft.bytes.set(hash, bytes);
		};
		if (files) {
			for (const file of files) await add(file.path, file.content);
		} else if (base) {
			for (const file of this.#listed(base.name, base.version)) {
				if ("text" in file) await add(file.path, file.text);
				else draft.files.push(file);
			}
		}
		draft.files.sort((a, b) => (a.path < b.path ? -1 : 1));
		return draft;
	}

	/**
	 * Checks a write against the skills as they are now, and throws what it
	 * refuses: a conflict, too many skills, a version too large, or no room
	 * for what it would add.
	 */
	#checkState(write: SkillWrite, draft: Draft): void {
		const existing = this.get(write.name);
		if (existing && write.baseVersion === undefined) {
			throw new HttpError(409, `A skill named ${write.name} exists already: read it, then give its version as base_version to rewrite it`);
		}
		if (!existing && write.baseVersion !== undefined) throw new HttpError(404, `No skill named ${write.name}`);
		if (existing && write.baseVersion !== existing.version) {
			throw new HttpError(409, `${write.name} is at version ${existing.version} now, not ${write.baseVersion}: read it again before rewriting it`);
		}
		if (!existing && Number(this.#sql.exec("SELECT COUNT(*) AS count FROM pim_skills").one().count) >= MAX_SKILLS) {
			throw new HttpError(429, `The person can have up to ${MAX_SKILLS} skills.`);
		}
		const size = draft.files.reduce((total, file) => total + file.size, 0);
		if (size > MAX_SKILL_BYTES) throw new HttpError(413, `A skill's supporting files can take up to ${MAX_SKILL_BYTES} bytes together; these take ${size}.`);
		// Files already stored for any version take no more room; the row takes its text again.
		const known = (hash: string) => this.#sql.exec("SELECT 1 FROM pim_skill_files WHERE sha256 = ? LIMIT 1", hash).toArray().length > 0;
		const added = [...new Map(draft.files.filter((file) => !known(file.sha256)).map((file) => [file.sha256, file.size])).values()].reduce(
			(total, bytes) => total + bytes,
			0,
		);
		const used = this.fileBytes();
		if (added > 0 && used + added > MAX_SKILL_STORAGE_BYTES) {
			throw new HttpError(429, `Skills' files can take up to ${MAX_SKILL_STORAGE_BYTES} bytes in all; ${used} are used. Delete a skill first.`);
		}
		const row = utf8Bytes(write.description) + utf8Bytes(write.instructions) + draft.files.reduce((total, file) => total + utf8Bytes(file.path) + file.sha256.length, 0);
		const room = this.#options.storageRoom();
		if (room !== null && row + added > room) throw new HttpError(429, `Space storage quota exceeded: there is room for ${Math.max(0, room)} more bytes.`);
	}

	/** Checks a write against the skill as it is now, and throws what it refuses, without writing anything. */
	async check(given: SkillWrite): Promise<void> {
		const write = this.#checkInput(given);
		const base = write.baseVersion === undefined ? undefined : { name: write.name, version: write.baseVersion };
		this.#checkState(write, await this.#draft(write.files, base));
	}

	/**
	 * Makes a skill or adds a version: stores its new files, then, checked
	 * again against the skill as it is then, lists them, with nothing awaited
	 * in between.
	 */
	async write(given: SkillWrite): Promise<Skill> {
		const write = this.#checkInput(given);
		const base = write.baseVersion === undefined ? undefined : { name: write.name, version: write.baseVersion };
		// The files of the version it is based on, which is still the latest when it is written.
		const draft = await this.#draft(write.files, base);
		return this.#add(write, draft);
	}

	/** Adds a version with a draft's files, checked before storing anything and again when writing. */
	async #add(write: SkillWrite, draft: Draft): Promise<Skill> {
		this.#checkState(write, draft);
		const { skill, pruned } = await this.#blobs.store(
			draft.files.map((file) => file.sha256),
			draft.bytes,
			() => {
				this.#checkState(write, draft);
				const now = Date.now();
				const version = (write.baseVersion ?? 0) + 1;
				this.#sql.exec(
					"INSERT INTO pim_skill_versions (name, version, description, instructions, files, author, restored_from, created_at) VALUES (?, ?, ?, ?, '[]', ?, ?, ?)",
					write.name,
					version,
					write.description,
					write.instructions,
					write.author ?? null,
					write.restoredFrom ?? null,
					now,
				);
				for (const file of draft.files) {
					this.#sql.exec(
						"INSERT INTO pim_skill_files (name, version, path, sha256, size, type) VALUES (?, ?, ?, ?, ?, ?)",
						write.name,
						version,
						file.path,
						file.sha256,
						file.size,
						file.type,
					);
				}
				this.#sql.exec(
					"INSERT INTO pim_skills (name, version, created_at) VALUES (?, ?, ?) ON CONFLICT (name) DO UPDATE SET version = excluded.version",
					write.name,
					version,
					now,
				);
				return { skill: this.get(write.name)!, pruned: this.#deleteVersions(write.name, version - MAX_SKILL_VERSIONS) };
			},
		);
		await this.#blobs.collect(pruned);
		return skill;
	}

	/** Deletes a skill's versions up to `upTo`, giving the hashes of the files they listed, to collect. */
	#deleteVersions(name: string, upTo: number): string[] {
		const hashes = this.#sql
			.exec("SELECT DISTINCT sha256 FROM pim_skill_files WHERE name = ? AND version <= ?", name, upTo)
			.toArray()
			.map((row) => String(row.sha256));
		this.#sql.exec("DELETE FROM pim_skill_files WHERE name = ? AND version <= ?", name, upTo);
		this.#sql.exec("DELETE FROM pim_skill_versions WHERE name = ? AND version <= ?", name, upTo);
		return hashes;
	}

	/** Adds the content of an older version as the newest, its files stored once still. */
	async restore(name: string, version: number, baseVersion: number): Promise<Skill> {
		const old = this.version(name, version);
		if (!old) throw new HttpError(404, `No version ${version} of the skill ${name}`);
		const write = { name, description: old.description, instructions: old.instructions, baseVersion, restoredFrom: version };
		return this.#add(write, await this.#draft(undefined, { name, version }));
	}

	/** Deletes a skill and every version of it, and then the files no other version has. */
	async delete(name: string): Promise<boolean> {
		if (!this.has(name)) return false;
		const hashes = this.#deleteVersions(name, Number.MAX_SAFE_INTEGER);
		this.#sql.exec("DELETE FROM pim_skills WHERE name = ?", name);
		await this.#blobs.collect(hashes);
		return true;
	}

	/**
	 * Every skill with every version kept, for the owner's export, and the
	 * files' contents, once each by hash: text as text, anything else in
	 * base64, inline up to `EXPORT_INLINE_BYTES`.
	 */
	async export() {
		const contents: { sha256: string; size: number; encoding?: "utf8" | "base64"; content?: string }[] = [];
		const seen = new Set<string>();
		let inlined = 0;
		const skills = [];
		for (const { name, createdAt } of this.list()) {
			const versions = [];
			for (const info of this.history(name).reverse()) {
				const found = this.version(name, info.version)!;
				const files = [];
				for (const file of this.#listed(name, info.version)) {
					const hash = "sha256" in file ? file.sha256 : await sha256(file.text);
					files.push({ path: file.path, size: file.size, type: file.type, sha256: hash });
					if (seen.has(hash)) continue;
					seen.add(hash);
					if (inlined + file.size > EXPORT_INLINE_BYTES) {
						contents.push({ sha256: hash, size: file.size });
						continue;
					}
					inlined += file.size;
					const bytes = "text" in file ? encoder.encode(file.text) : (await this.read(name, info.version, file.path)).bytes;
					if (isTextType(file.type)) contents.push({ sha256: hash, size: file.size, encoding: "utf8", content: new TextDecoder().decode(bytes) });
					else contents.push({ sha256: hash, size: file.size, encoding: "base64", content: Buffer.from(bytes).toString("base64") });
				}
				versions.push({ ...found, files });
			}
			skills.push({ name, createdAt, versions });
		}
		return { skills, files: contents };
	}
}
