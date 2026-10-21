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
 * by paths such as `references/guide.md`. They are text, and go with each
 * version.
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

/** A supporting file, by its path relative to the skill. */
export type SkillFile = { readonly path: string; readonly content: string };

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
export const MAX_SKILL_FILES = 20;
export const MAX_SKILL_FILE_CHARS = 50_000;
/** Instructions and files together. */
export const MAX_SKILL_CHARS = 200_000;

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
`;

type Row = Record<string, SqlStorageValue>;

const versionInfo = (row: Row): SkillVersionInfo => ({
	version: Number(row.version),
	author: row.author === null ? null : String(row.author),
	restoredFrom: row.restored_from === null ? null : Number(row.restored_from),
	createdAt: Number(row.created_at),
});

const versionOf = (row: Row): SkillVersion => ({
	name: String(row.name),
	description: String(row.description),
	instructions: String(row.instructions),
	files: JSON.parse(String(row.files)) as SkillFile[],
	...versionInfo(row),
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

const skillOf = (row: Row): Skill => ({
	...versionOf(row),
	createdAt: Number(row.skill_created_at),
	updatedAt: Number(row.created_at),
});

/** What a write gives: the whole skill, the version it rewrites, if it does, and who wrote it. */
export type SkillWrite = {
	readonly name: string;
	readonly description: string;
	readonly instructions: string;
	/** Every supporting file; left out, a rewrite keeps the files it had. */
	readonly files?: readonly SkillFile[];
	readonly baseVersion?: number;
	/** The agent writing it, by name; left out for a restore. */
	readonly author?: string;
	readonly restoredFrom?: number;
};

const encoder = new TextEncoder();

export class SkillStore {
	readonly #sql: SqlStorage;
	/** Bytes the space may still grow by, or null for no limit. */
	readonly #storageRoom: () => number | null;

	constructor(sql: SqlStorage, storageRoom: () => number | null) {
		this.#sql = sql;
		this.#storageRoom = storageRoom;
		this.#sql.exec(SCHEMA);
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
		return row ? skillOf(row) : undefined;
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
		return row ? versionOf(row) : undefined;
	}

	/** Checks a write against the skill as it is now, and throws what it refuses. */
	check(write: SkillWrite): SkillWrite {
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
		const existing = this.get(write.name);
		if (existing && write.baseVersion === undefined) {
			throw new HttpError(409, `A skill named ${write.name} exists already: read it, then give its version as base_version to rewrite it`);
		}
		if (!existing && write.baseVersion !== undefined) throw new HttpError(404, `No skill named ${write.name}`);
		if (existing && write.baseVersion !== existing.version) {
			throw new HttpError(409, `${write.name} is at version ${existing.version} now, not ${write.baseVersion}: read it again before rewriting it`);
		}
		if (!existing && Number(this.#sql.exec("SELECT COUNT(*) AS count FROM pim_skills").one().count) >= MAX_SKILLS) throw new HttpError(429, `The person can have up to ${MAX_SKILLS} skills.`);
		const files = write.files ?? existing?.files ?? [];
		if (files.length > MAX_SKILL_FILES) throw new HttpError(400, `A skill can have up to ${MAX_SKILL_FILES} supporting files`);
		const paths = new Set<string>();
		for (const file of files) {
			if (!FILE_PATH.test(file.path)) {
				throw new HttpError(400, `${file.path} is not a supporting file's path: give one relative to the skill, such as references/guide.md`);
			}
			if (paths.has(file.path)) throw new HttpError(400, `Two supporting files are at ${file.path}`);
			paths.add(file.path);
			if (file.content.length > MAX_SKILL_FILE_CHARS) throw new HttpError(400, `${file.path} is longer than ${MAX_SKILL_FILE_CHARS} characters`);
		}
		if (files.reduce((total, file) => total + file.content.length, instructions.length) > MAX_SKILL_CHARS) {
			throw new HttpError(400, `A skill's instructions and files together must be at most ${MAX_SKILL_CHARS} characters`);
		}
		// A version keeps all of it again, so each write needs room for the whole skill.
		const size = [description, instructions, ...files.flatMap((file) => [file.path, file.content])].reduce((total, part) => total + encoder.encode(part).byteLength, 0);
		const room = this.#storageRoom();
		if (room !== null && size > room) throw new HttpError(429, `Space storage quota exceeded: there is room for ${Math.max(0, room)} more bytes.`);
		return { ...write, description, instructions, files };
	}

	/** Makes a skill or adds a version, checked again against the skill as it is now. */
	write(given: SkillWrite): Skill {
		const write = this.check(given);
		const now = Date.now();
		const version = (write.baseVersion ?? 0) + 1;
		this.#sql.exec(
			"INSERT INTO pim_skill_versions (name, version, description, instructions, files, author, restored_from, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
			write.name,
			version,
			write.description,
			write.instructions,
			JSON.stringify(write.files),
			write.author ?? null,
			write.restoredFrom ?? null,
			now,
		);
		this.#sql.exec(
			"INSERT INTO pim_skills (name, version, created_at) VALUES (?, ?, ?) ON CONFLICT (name) DO UPDATE SET version = excluded.version",
			write.name,
			version,
			now,
		);
		this.#sql.exec("DELETE FROM pim_skill_versions WHERE name = ? AND version <= ?", write.name, version - MAX_SKILL_VERSIONS);
		return this.get(write.name)!;
	}

	/** Adds the content of an older version as the newest. */
	restore(name: string, version: number, baseVersion: number): Skill {
		const old = this.version(name, version);
		if (!old) throw new HttpError(404, `No version ${version} of the skill ${name}`);
		return this.write({ name, description: old.description, instructions: old.instructions, files: old.files, baseVersion, restoredFrom: version });
	}

	/** Deletes a skill and every version of it. */
	delete(name: string): boolean {
		this.#sql.exec("DELETE FROM pim_skill_versions WHERE name = ?", name);
		return this.#sql.exec("DELETE FROM pim_skills WHERE name = ?", name).rowsWritten > 0;
	}

	/** Every skill with every version kept, for the owner's export. */
	export() {
		return this.list().map(({ name, createdAt }) => ({
			name,
			createdAt,
			versions: this.#sql.exec("SELECT * FROM pim_skill_versions WHERE name = ? ORDER BY version", name).toArray().map(versionOf),
		}));
	}
}
