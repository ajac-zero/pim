import { DurableObject } from "cloudflare:workers";
import { HttpError } from "./http";
import type { SuggestedApp, TeamMember } from "./personas";

/**
 * What the people on a Pim show each other: profiles, and the Pims they
 * publish as templates for anyone to make their own. One Durable Object for
 * the instance, apart from the Directory, so browsing never touches accounts.
 *
 * A template is a copy of one of its author's Pims when they published it:
 * its name, description, instructions, suggested apps and team, never their
 * memory, conversations or credentials. Publishing again replaces it.
 *
 * The admin also chooses the Pim everyone starts with: a copy of one of
 * theirs, which becomes each new account's default Pim.
 */

export type Profile = {
	readonly username: string;
	readonly displayName: string | null;
	readonly bio: string | null;
};

export type Template = {
	readonly id: string;
	/** The author's username. */
	readonly author: string;
	readonly authorName: string | null;
	readonly name: string;
	readonly description: string;
	readonly instructions: string;
	readonly apps: readonly SuggestedApp[];
	readonly team: readonly TeamMember[];
	readonly publishedAt: number;
	/** How many people made it their own. */
	readonly uses: number;
};

/** The Pim everyone starts with, as the admin chose it. */
export type DefaultPim = {
	/** The admin's username. */
	readonly author: string;
	/** Which of the admin's Pims it is a copy of. */
	readonly personaId: string;
	readonly name: string;
	readonly description: string;
	readonly instructions: string;
	readonly apps: readonly SuggestedApp[];
	readonly team: readonly TeamMember[];
	readonly updatedAt: number;
};

/** A template in a list: everything but its instructions. */
export type TemplateSummary = Omit<Template, "instructions">;

export const MAX_DISPLAY_NAME = 50;
export const MAX_BIO = 280;
export const MAX_TEMPLATES = 20;

const SCHEMA = `
CREATE TABLE IF NOT EXISTS profiles (
	owner_id TEXT PRIMARY KEY,
	username TEXT NOT NULL UNIQUE,
	display_name TEXT,
	bio TEXT,
	updated_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS templates (
	id TEXT PRIMARY KEY,
	owner_id TEXT NOT NULL,
	username TEXT NOT NULL,
	persona_id TEXT NOT NULL,
	name TEXT NOT NULL,
	description TEXT NOT NULL,
	instructions TEXT NOT NULL,
	apps TEXT NOT NULL,
	published_at INTEGER NOT NULL,
	uses INTEGER NOT NULL DEFAULT 0,
	UNIQUE (owner_id, persona_id)
);
CREATE INDEX IF NOT EXISTS templates_by_author ON templates (username, published_at);
CREATE TABLE IF NOT EXISTS default_pim (
	id INTEGER PRIMARY KEY CHECK (id = 1),
	owner_id TEXT NOT NULL,
	username TEXT NOT NULL,
	persona_id TEXT NOT NULL,
	name TEXT NOT NULL,
	description TEXT NOT NULL,
	instructions TEXT NOT NULL,
	apps TEXT NOT NULL,
	updated_at INTEGER NOT NULL
);
`;

type Row = Record<string, SqlStorageValue>;

const optional = (value: SqlStorageValue | undefined) => (value === null || value === undefined ? null : String(value));

function templateOf(row: Row): Template {
	return {
		id: String(row.id),
		author: String(row.username),
		authorName: optional(row.display_name),
		name: String(row.name),
		description: String(row.description),
		instructions: String(row.instructions),
		apps: JSON.parse(String(row.apps)) as SuggestedApp[],
		team: JSON.parse(String(row.team ?? "[]")) as TeamMember[],
		publishedAt: Number(row.published_at),
		uses: Number(row.uses),
	};
}

const summaryOf = (row: Row): TemplateSummary => {
	const { instructions: _instructions, ...summary } = templateOf(row);
	return summary;
};

const WITH_AUTHOR = "SELECT t.*, p.display_name FROM templates t LEFT JOIN profiles p ON p.owner_id = t.owner_id";

function optionalText(value: unknown, field: string, max: number): string | null {
	if (value === null || value === undefined) return null;
	if (typeof value !== "string") throw new HttpError(400, `${field} must be a string`);
	const trimmed = value.trim();
	if (trimmed.length > max) throw new HttpError(400, `${field} must be at most ${max} characters`);
	return trimmed === "" ? null : trimmed;
}

export class Gallery extends DurableObject<Env> {
	constructor(ctx: DurableObjectState, env: Env) {
		super(ctx, env);
		ctx.storage.sql.exec(SCHEMA);
		for (const table of ["templates", "default_pim"]) {
			const columns = ctx.storage.sql.exec(`PRAGMA table_info(${table})`).toArray().map((row) => String(row.name));
			if (!columns.includes("team")) ctx.storage.sql.exec(`ALTER TABLE ${table} ADD COLUMN team TEXT NOT NULL DEFAULT '[]'`);
		}
	}

	#sql(query: string, ...bindings: unknown[]) {
		return this.ctx.storage.sql.exec(query, ...bindings);
	}

	profile(username: string): Profile {
		const [row] = this.#sql("SELECT * FROM profiles WHERE username = ?", username).toArray();
		return { username, displayName: optional(row?.display_name), bio: optional(row?.bio) };
	}

	setProfile(ownerId: string, username: string, change: { displayName?: unknown; bio?: unknown }): Profile {
		const current = this.profile(username);
		const displayName = change.displayName === undefined ? current.displayName : optionalText(change.displayName, "displayName", MAX_DISPLAY_NAME);
		const bio = change.bio === undefined ? current.bio : optionalText(change.bio, "bio", MAX_BIO);
		this.#sql(
			"INSERT INTO profiles (owner_id, username, display_name, bio, updated_at) VALUES (?, ?, ?, ?, ?) ON CONFLICT (owner_id) DO UPDATE SET display_name = excluded.display_name, bio = excluded.bio, updated_at = excluded.updated_at",
			ownerId,
			username,
			displayName,
			bio,
			Date.now(),
		);
		return this.profile(username);
	}

	/** Display names for usernames, for lists of people. */
	names(usernames: readonly string[]): Record<string, string | null> {
		const names: Record<string, string | null> = {};
		for (const username of usernames) names[username] = this.profile(username).displayName;
		return names;
	}

	/** Publishes one of the author's Pims, or replaces what was published of it. */
	publish(
		ownerId: string,
		username: string,
		persona: {
			id: string;
			name: string;
			description: string;
			instructions: string;
			apps: readonly SuggestedApp[];
			team: readonly TeamMember[];
		},
	): Template {
		const [known] = this.#sql("SELECT id FROM templates WHERE owner_id = ? AND persona_id = ?", ownerId, persona.id).toArray();
		if (!known) {
			const count = Number(this.#sql("SELECT COUNT(*) AS n FROM templates WHERE owner_id = ?", ownerId).toArray()[0]?.n ?? 0);
			if (count >= MAX_TEMPLATES) throw new HttpError(429, `You can publish up to ${MAX_TEMPLATES} Pims.`);
		}
		const id = known ? String(known.id) : `t_${crypto.randomUUID().replaceAll("-", "").slice(0, 16)}`;
		this.#sql(
			`INSERT INTO templates (id, owner_id, username, persona_id, name, description, instructions, apps, team, published_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
			ON CONFLICT (id) DO UPDATE SET name = excluded.name, description = excluded.description, instructions = excluded.instructions, apps = excluded.apps, team = excluded.team, published_at = excluded.published_at`,
			id,
			ownerId,
			username,
			persona.id,
			persona.name,
			persona.description,
			persona.instructions,
			JSON.stringify(persona.apps),
			JSON.stringify(persona.team),
			Date.now(),
		);
		return this.template(id)!;
	}

	/** Takes one of the author's Pims out of the gallery. False when it wasn't published. */
	unpublish(ownerId: string, personaId: string): boolean {
		return this.#sql("DELETE FROM templates WHERE owner_id = ? AND persona_id = ?", ownerId, personaId).rowsWritten > 0;
	}

	template(id: string): Template | null {
		const [row] = this.#sql(`${WITH_AUTHOR} WHERE t.id = ?`, id).toArray();
		return row ? templateOf(row) : null;
	}

	/** Templates, most used first; matching `query` in their name, description or author, or by one author. */
	templates(options: { query?: string; author?: string; limit?: number } = {}): TemplateSummary[] {
		const limit = Math.min(Math.max(options.limit ?? 50, 1), 100);
		if (options.author) {
			return this.#sql(`${WITH_AUTHOR} WHERE t.username = ? ORDER BY t.published_at DESC LIMIT ?`, options.author, limit)
				.toArray()
				.map(summaryOf);
		}
		const query = options.query?.trim().toLowerCase();
		if (query) {
			const like = `%${query.replace(/[\\%_]/g, (character) => `\\${character}`)}%`;
			return this.#sql(
				`${WITH_AUTHOR} WHERE lower(t.name) LIKE ? ESCAPE '\\' OR lower(t.description) LIKE ? ESCAPE '\\' OR t.username LIKE ? ESCAPE '\\' OR lower(coalesce(p.display_name, '')) LIKE ? ESCAPE '\\' ORDER BY t.uses DESC, t.published_at DESC LIMIT ?`,
				like,
				like,
				like,
				like,
				limit,
			)
				.toArray()
				.map(summaryOf);
		}
		return this.#sql(`${WITH_AUTHOR} ORDER BY t.uses DESC, t.published_at DESC LIMIT ?`, limit).toArray().map(summaryOf);
	}

	/** Someone made a template their own. */
	used(id: string): void {
		this.#sql("UPDATE templates SET uses = uses + 1 WHERE id = ?", id);
	}

	/** The operator takes a template down. */
	remove(id: string): boolean {
		return this.#sql("DELETE FROM templates WHERE id = ?", id).rowsWritten > 0;
	}

	/** The Pim everyone starts with; null when the admin chose none, and people start with a plain one. */
	defaultPim(): DefaultPim | null {
		const [row] = this.#sql("SELECT * FROM default_pim WHERE id = 1").toArray();
		if (!row) return null;
		return {
			author: String(row.username),
			personaId: String(row.persona_id),
			name: String(row.name),
			description: String(row.description),
			instructions: String(row.instructions),
			apps: JSON.parse(String(row.apps)) as SuggestedApp[],
			team: JSON.parse(String(row.team ?? "[]")) as TeamMember[],
			updatedAt: Number(row.updated_at),
		};
	}

	/** The admin makes a copy of one of their Pims the one everyone starts with. Choosing again replaces it. */
	setDefaultPim(
		ownerId: string,
		username: string,
		persona: {
			id: string;
			name: string;
			description: string;
			instructions: string;
			apps: readonly SuggestedApp[];
			team: readonly TeamMember[];
		},
	): DefaultPim {
		this.#sql(
			`INSERT INTO default_pim (id, owner_id, username, persona_id, name, description, instructions, apps, team, updated_at) VALUES (1, ?, ?, ?, ?, ?, ?, ?, ?, ?)
			ON CONFLICT (id) DO UPDATE SET owner_id = excluded.owner_id, username = excluded.username, persona_id = excluded.persona_id, name = excluded.name,
			description = excluded.description, instructions = excluded.instructions, apps = excluded.apps, team = excluded.team, updated_at = excluded.updated_at`,
			ownerId,
			username,
			persona.id,
			persona.name,
			persona.description,
			persona.instructions,
			JSON.stringify(persona.apps),
			JSON.stringify(persona.team),
			Date.now(),
		);
		return this.defaultPim()!;
	}

	/** Back to a plain Pim for everyone who joins. False when none was chosen. */
	clearDefaultPim(): boolean {
		return this.#sql("DELETE FROM default_pim").rowsWritten > 0;
	}

	/** Forgets a person: their profile, everything they published, and the Pim everyone starts with if it was theirs. Run when their account is deleted. */
	forgetOwner(ownerId: string): void {
		this.#sql("DELETE FROM templates WHERE owner_id = ?", ownerId);
		this.#sql("DELETE FROM profiles WHERE owner_id = ?", ownerId);
		this.#sql("DELETE FROM default_pim WHERE owner_id = ?", ownerId);
	}

	/** Whether anything of the owner is left: a deletion is done only once nothing is. */
	holds(ownerId: string): boolean {
		return (
			this.#sql(
				"SELECT 1 FROM profiles WHERE owner_id = ? UNION SELECT 1 FROM templates WHERE owner_id = ? UNION SELECT 1 FROM default_pim WHERE owner_id = ? LIMIT 1",
				ownerId,
				ownerId,
				ownerId,
			).toArray().length > 0
		);
	}
}
