import { ASSISTANT_BLUEPRINT } from "./extensions/assistant";
import { DurableObject } from "cloudflare:workers";
import { HttpError } from "./http";
import type { SuggestedApp, TeamMember } from "./agents";

/**
 * What the people on a Pim show each other: profiles, and the agents they
 * publish as templates for anyone to make their own. One Durable Object for
 * the instance, apart from the Directory, so browsing never touches accounts.
 *
 * A template is a copy of one of its author's agents when they published it:
 * its name, description, instructions, suggested apps, team and look (its
 * symbol, color and uploaded icon), never their memory, conversations or
 * credentials. Publishing again replaces it.
 *
 * The admin also chooses the agent everyone starts with: a copy of one of
 * theirs, which becomes each new account's default agent.
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
	/** The blueprint it builds on, or null for none. */
	readonly blueprint: string | null;
	/** An icon's name or an emoji, as an agent's; null for the default. */
	readonly symbol: string | null;
	readonly color: string | null;
	/** When its uploaded icon was published, to fetch it again when it changes; null without one. */
	readonly icon: number | null;
	readonly publishedAt: number;
	/** How many people made it their own. */
	readonly uses: number;
};

/** The agent everyone starts with, as the admin chose it. */
export type DefaultAgent = {
	/** The admin's username. */
	readonly author: string;
	/** Which of the admin's agents it is a copy of. */
	readonly agentId: string;
	readonly name: string;
	readonly description: string;
	readonly instructions: string;
	readonly apps: readonly SuggestedApp[];
	readonly team: readonly TeamMember[];
	readonly blueprint: string | null;
	readonly symbol: string | null;
	readonly color: string | null;
	/** Whether it has an uploaded icon, which each copy gets. */
	readonly icon: boolean;
	readonly updatedAt: number;
};

/** An uploaded icon, as an agent has one. */
export type AgentIcon = { readonly type: string; readonly data: ArrayBuffer };

/** One of an author's agents as the gallery copies it. */
export type PublishedAgent = {
	readonly id: string;
	readonly name: string;
	readonly description: string;
	readonly instructions: string;
	readonly apps: readonly SuggestedApp[];
	readonly team: readonly TeamMember[];
	readonly blueprint: string | null;
	readonly symbol: string | null;
	readonly color: string | null;
	readonly image: AgentIcon | null;
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
	agent_id TEXT NOT NULL,
	name TEXT NOT NULL,
	description TEXT NOT NULL,
	instructions TEXT NOT NULL,
	apps TEXT NOT NULL,
	published_at INTEGER NOT NULL,
	uses INTEGER NOT NULL DEFAULT 0,
	UNIQUE (owner_id, agent_id)
);
CREATE INDEX IF NOT EXISTS templates_by_author ON templates (username, published_at);
CREATE TABLE IF NOT EXISTS default_agent (
	id INTEGER PRIMARY KEY CHECK (id = 1),
	owner_id TEXT NOT NULL,
	username TEXT NOT NULL,
	agent_id TEXT NOT NULL,
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
		blueprint: optional(row.blueprint),
		symbol: optional(row.symbol),
		color: optional(row.color),
		icon: Number(row.has_icon) === 1 ? Number(row.published_at) : null,
		publishedAt: Number(row.published_at),
		uses: Number(row.uses),
	};
}

const summaryOf = (row: Row): TemplateSummary => {
	const { instructions: _instructions, ...summary } = templateOf(row);
	return summary;
};

// Every column but the icon's bytes, which only its own route reads.
const WITH_AUTHOR =
	"SELECT t.id, t.owner_id, t.username, t.agent_id, t.name, t.description, t.instructions, t.apps, t.team, t.blueprint, t.symbol, t.color, t.icon_data IS NOT NULL AS has_icon, t.published_at, t.uses, p.display_name FROM templates t LEFT JOIN profiles p ON p.owner_id = t.owner_id";

function optionalText(value: unknown, field: string, max: number): string | null {
	if (value === null || value === undefined) return null;
	if (typeof value !== "string") throw new HttpError(400, `${field} must be a string`);
	const trimmed = value.trim();
	if (trimmed.length > max) throw new HttpError(400, `${field} must be at most ${max} characters`);
	return trimmed === "" ? null : trimmed;
}

/** What the gallery keeps of an agent, in its columns' order from `name` to `icon_data`. */
const copyOf = (agent: PublishedAgent) => [
	agent.name,
	agent.description,
	agent.instructions,
	JSON.stringify(agent.apps),
	JSON.stringify(agent.team),
	agent.blueprint,
	agent.symbol,
	agent.color,
	agent.image?.type ?? null,
	agent.image?.data ?? null,
];

const iconOf = (row: Row | undefined): AgentIcon | null =>
	row && row.icon_data !== null ? { type: String(row.icon_type), data: row.icon_data as ArrayBuffer } : null;

export class Gallery extends DurableObject<Env> {
	constructor(ctx: DurableObjectState, env: Env) {
		super(ctx, env);
		// Agents were once personas, and blueprints bases: renamed in place, keeping the rows.
		const names = (query: string) => new Set(ctx.storage.sql.exec(query).toArray().map((row) => String(row.name)));
		const tables = names("SELECT name FROM sqlite_master WHERE type = 'table'");
		if (tables.has("default_pim") && !tables.has("default_agent")) ctx.storage.sql.exec("ALTER TABLE default_pim RENAME TO default_agent");
		for (const table of ["templates", "default_agent"]) {
			const columns = names(`PRAGMA table_info(${table})`);
			if (columns.has("persona_id")) ctx.storage.sql.exec(`ALTER TABLE ${table} RENAME COLUMN persona_id TO agent_id`);
			if (columns.has("base") && !columns.has("blueprint")) ctx.storage.sql.exec(`ALTER TABLE ${table} RENAME COLUMN base TO blueprint`);
		}
		ctx.storage.sql.exec(SCHEMA);
		for (const table of ["templates", "default_agent"]) {
			const columns = ctx.storage.sql.exec(`PRAGMA table_info(${table})`).toArray().map((row) => String(row.name));
			if (!columns.includes("team")) ctx.storage.sql.exec(`ALTER TABLE ${table} ADD COLUMN team TEXT NOT NULL DEFAULT '[]'`);
			// Published before extensions, they all built on Pim's own assistant.
			if (!columns.includes("blueprint")) ctx.storage.sql.exec(`ALTER TABLE ${table} ADD COLUMN blueprint TEXT DEFAULT '${ASSISTANT_BLUEPRINT}'`);
			for (const column of ["symbol", "color", "icon_type", "icon_data"]) {
				if (!columns.includes(column)) ctx.storage.sql.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${column === "icon_data" ? "BLOB" : "TEXT"}`);
			}
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

	/** Publishes one of the author's agents, or replaces what was published of it. */
	publish(ownerId: string, username: string, agent: PublishedAgent): Template {
		const [known] = this.#sql("SELECT id FROM templates WHERE owner_id = ? AND agent_id = ?", ownerId, agent.id).toArray();
		if (!known) {
			const count = Number(this.#sql("SELECT COUNT(*) AS n FROM templates WHERE owner_id = ?", ownerId).toArray()[0]?.n ?? 0);
			if (count >= MAX_TEMPLATES) throw new HttpError(429, `You can publish up to ${MAX_TEMPLATES} agents.`);
		}
		const id = known ? String(known.id) : `t_${crypto.randomUUID().replaceAll("-", "").slice(0, 16)}`;
		this.#sql(
			`INSERT INTO templates (id, owner_id, username, agent_id, name, description, instructions, apps, team, blueprint, symbol, color, icon_type, icon_data, published_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
			ON CONFLICT (id) DO UPDATE SET name = excluded.name, description = excluded.description, instructions = excluded.instructions, apps = excluded.apps, team = excluded.team, blueprint = excluded.blueprint,
			symbol = excluded.symbol, color = excluded.color, icon_type = excluded.icon_type, icon_data = excluded.icon_data, published_at = excluded.published_at`,
			id,
			ownerId,
			username,
			agent.id,
			...copyOf(agent),
			Date.now(),
		);
		return this.template(id)!;
	}

	/** A template's uploaded icon, if it was published with one. */
	templateIcon(id: string): AgentIcon | null {
		return iconOf(this.#sql("SELECT icon_type, icon_data FROM templates WHERE id = ?", id).toArray()[0]);
	}

	/** Takes one of the author's agents out of the gallery. False when it wasn't published. */
	unpublish(ownerId: string, agentId: string): boolean {
		return this.#sql("DELETE FROM templates WHERE owner_id = ? AND agent_id = ?", ownerId, agentId).rowsWritten > 0;
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

	/** The agent everyone starts with; null when the admin chose none, and people start with a plain one. */
	defaultAgent(): DefaultAgent | null {
		const [row] = this.#sql("SELECT * FROM default_agent WHERE id = 1").toArray();
		if (!row) return null;
		return {
			author: String(row.username),
			agentId: String(row.agent_id),
			name: String(row.name),
			description: String(row.description),
			instructions: String(row.instructions),
			apps: JSON.parse(String(row.apps)) as SuggestedApp[],
			team: JSON.parse(String(row.team ?? "[]")) as TeamMember[],
			blueprint: optional(row.blueprint),
			symbol: optional(row.symbol),
			color: optional(row.color),
			icon: row.icon_data !== null,
			updatedAt: Number(row.updated_at),
		};
	}

	/** The admin makes a copy of one of their agents the one everyone starts with. Choosing again replaces it. */
	setDefaultAgent(ownerId: string, username: string, agent: PublishedAgent): DefaultAgent {
		this.#sql(
			`INSERT INTO default_agent (id, owner_id, username, agent_id, name, description, instructions, apps, team, blueprint, symbol, color, icon_type, icon_data, updated_at) VALUES (1, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
			ON CONFLICT (id) DO UPDATE SET owner_id = excluded.owner_id, username = excluded.username, agent_id = excluded.agent_id, name = excluded.name,
			description = excluded.description, instructions = excluded.instructions, apps = excluded.apps, team = excluded.team, blueprint = excluded.blueprint,
			symbol = excluded.symbol, color = excluded.color, icon_type = excluded.icon_type, icon_data = excluded.icon_data, updated_at = excluded.updated_at`,
			ownerId,
			username,
			agent.id,
			...copyOf(agent),
			Date.now(),
		);
		return this.defaultAgent()!;
	}

	/** The uploaded icon of the agent everyone starts with, if it has one. */
	defaultAgentIcon(): AgentIcon | null {
		return iconOf(this.#sql("SELECT icon_type, icon_data FROM default_agent WHERE id = 1").toArray()[0]);
	}

	/** Back to a plain agent for everyone who joins. False when none was chosen. */
	clearDefaultAgent(): boolean {
		return this.#sql("DELETE FROM default_agent").rowsWritten > 0;
	}

	/** Forgets a person: their profile, everything they published, and the agent everyone starts with if it was theirs. Run when their account is deleted. */
	forgetOwner(ownerId: string): void {
		this.#sql("DELETE FROM templates WHERE owner_id = ?", ownerId);
		this.#sql("DELETE FROM profiles WHERE owner_id = ?", ownerId);
		this.#sql("DELETE FROM default_agent WHERE owner_id = ?", ownerId);
	}

	/** Whether anything of the owner is left: a deletion is done only once nothing is. */
	holds(ownerId: string): boolean {
		return (
			this.#sql(
				"SELECT 1 FROM profiles WHERE owner_id = ? UNION SELECT 1 FROM templates WHERE owner_id = ? UNION SELECT 1 FROM default_agent WHERE owner_id = ? LIMIT 1",
				ownerId,
				ownerId,
				ownerId,
			).toArray().length > 0
		);
	}
}
