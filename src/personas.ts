import { HttpError } from "./http";

/**
 * The owner's Pims: named agents, each with its own instructions, such as
 * "Marathon coach" or "Trip planner". Every account has a default one, its
 * Pim, which talks in every chat not started with another; a copy of the
 * Pim the admin chose for everyone, or a plain one. A chat's Pim gives it
 * its instructions on top of the agent's own habits; memory, apps and
 * approvals are shared by all of them. One can be published as a template
 * others make their own (see ./gallery.ts); a copy made from a template
 * remembers where it came from.
 *
 * A Pim can have a team: named members with instructions of their own,
 * which it hands tasks to and which work in parallel (see ./team.ts). The
 * person talks only with the Pim.
 */

/** An app a template suggests connecting: by its MCP server URL, never with credentials. */
export type SuggestedApp = { readonly name: string; readonly url: string };

/** One of a Pim's team: it does tasks the Pim hands it, and answers the Pim, never the person. */
export type TeamMember = {
	readonly name: string;
	readonly instructions: string;
	/** The tools it may use, by name; null for all the Pim's tools a member can have. */
	readonly tools: readonly string[] | null;
};

export type Persona = {
	readonly id: string;
	readonly name: string;
	readonly description: string;
	readonly instructions: string;
	readonly apps: readonly SuggestedApp[];
	readonly team: readonly TeamMember[];
	/** The template it was made from. */
	readonly source: { readonly template: string; readonly author: string } | null;
	/** Its published template, if the owner published it. */
	readonly published: string | null;
	/** When its icon was last set, to fetch it again when it changes; null without one. */
	readonly icon: number | null;
	/** The one that talks in every chat not started with another. It can't be deleted. */
	readonly default: boolean;
	readonly createdAt: number;
	readonly updatedAt: number;
};

export type PersonaInput = {
	readonly name: string;
	readonly description: string;
	readonly instructions: string;
	readonly apps: readonly SuggestedApp[];
	readonly team: readonly TeamMember[];
};

export const MAX_PERSONAS = 20;
export const MAX_ICON_BYTES = 256 * 1024;
export const ICON_TYPES = ["image/png", "image/jpeg", "image/webp", "image/gif"];
export const MAX_NAME = 60;
export const MAX_DESCRIPTION = 280;
export const MAX_INSTRUCTIONS = 8000;
export const MAX_APPS = 10;
export const MAX_TEAM = 8;
export const MAX_MEMBER_NAME = 40;
export const MAX_MEMBER_TOOLS = 50;

/** The default Pim of an account that has no other: the agent's own habits, nothing on top. */
export const PLAIN_PIM: PersonaInput = { name: "Pim", description: "", instructions: "", apps: [], team: [] };

const SCHEMA = `
CREATE TABLE IF NOT EXISTS pim_personas (
	id TEXT PRIMARY KEY,
	name TEXT NOT NULL,
	description TEXT NOT NULL,
	instructions TEXT NOT NULL,
	apps TEXT NOT NULL,
	source TEXT,
	published TEXT,
	created_at INTEGER NOT NULL,
	updated_at INTEGER NOT NULL,
	is_default INTEGER NOT NULL DEFAULT 0,
	team TEXT NOT NULL DEFAULT '[]'
);
CREATE TABLE IF NOT EXISTS pim_persona_icons (
	persona TEXT PRIMARY KEY,
	type TEXT NOT NULL,
	data BLOB NOT NULL,
	updated_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS pim_persona_sessions (
	session TEXT PRIMARY KEY,
	persona TEXT NOT NULL
);
`;

type Row = Record<string, SqlStorageValue>;

const SELECT = "SELECT p.*, (SELECT updated_at FROM pim_persona_icons WHERE persona = p.id) AS icon FROM pim_personas p";

const personaOf = (row: Row): Persona => ({
	id: String(row.id),
	name: String(row.name),
	description: String(row.description),
	instructions: String(row.instructions),
	apps: JSON.parse(String(row.apps)) as SuggestedApp[],
	team: JSON.parse(String(row.team)) as TeamMember[],
	source: row.source ? (JSON.parse(String(row.source)) as Persona["source"]) : null,
	published: row.published === null ? null : String(row.published),
	icon: row.icon === null ? null : Number(row.icon),
	default: Number(row.is_default) === 1,
	createdAt: Number(row.created_at),
	updatedAt: Number(row.updated_at),
});

function text(value: unknown, field: string, max: number, required: boolean): string {
	if (value === undefined && !required) return "";
	if (typeof value !== "string") throw new HttpError(400, `${field} must be a string`);
	const trimmed = value.trim();
	if (required && trimmed === "") throw new HttpError(400, `${field} is required`);
	if (trimmed.length > max) throw new HttpError(400, `${field} must be at most ${max} characters`);
	return trimmed;
}

/** A Pim as given through the API or a template: checked, trimmed, within limits. */
export function personaInput(body: Record<string, unknown>, partial?: Persona): PersonaInput {
	const apps = body.apps === undefined ? (partial?.apps ?? []) : body.apps;
	if (!Array.isArray(apps) || apps.length > MAX_APPS) throw new HttpError(400, `apps must be a list of up to ${MAX_APPS}`);
	return {
		name: body.name === undefined && partial ? partial.name : text(body.name, "name", MAX_NAME, true),
		description:
			body.description === undefined && partial ? partial.description : text(body.description, "description", MAX_DESCRIPTION, false),
		instructions:
			body.instructions === undefined && partial
				? partial.instructions
				: text(body.instructions, "instructions", MAX_INSTRUCTIONS, false),
		apps: apps.map((app) => {
			const { name, url } = (app ?? {}) as { name?: unknown; url?: unknown };
			if (typeof url !== "string" || !/^https:\/\/[^\s]+$/.test(url) || url.length > 500) {
				throw new HttpError(400, "Each app needs an https url");
			}
			return { name: text(name, "app name", 40, true), url };
		}),
		team: body.team === undefined ? (partial?.team ?? []) : teamInput(body.team),
	};
}

/** A team as given: up to `MAX_TEAM` members with distinct names, each with instructions. */
function teamInput(value: unknown): TeamMember[] {
	if (!Array.isArray(value) || value.length > MAX_TEAM) throw new HttpError(400, `team must be a list of up to ${MAX_TEAM} members`);
	const names = new Set<string>();
	return value.map((member) => {
		const { name: given, instructions, tools } = (member ?? {}) as { name?: unknown; instructions?: unknown; tools?: unknown };
		const name = text(given, "a team member's name", MAX_MEMBER_NAME, true);
		if (names.has(name.toLowerCase())) throw new HttpError(400, `Two team members are called ${name}`);
		names.add(name.toLowerCase());
		if (tools !== undefined && tools !== null) {
			if (!Array.isArray(tools) || tools.length > MAX_MEMBER_TOOLS || tools.some((tool) => typeof tool !== "string" || !/^[\w.-]{1,128}$/.test(tool))) {
				throw new HttpError(400, `A team member's tools must be a list of up to ${MAX_MEMBER_TOOLS} tool names`);
			}
		}
		return {
			name,
			instructions: text(instructions, `${name}'s instructions`, MAX_INSTRUCTIONS, true),
			tools: tools === undefined || tools === null ? null : [...new Set(tools as string[])],
		};
	});
}

/** What a chat's Pim adds to the agent's own habits: who it is, and its instructions. */
export function personaInstructions(persona: Persona): string {
	const identity = `In this conversation you are "${persona.name}"${persona.description ? `: ${persona.description}` : "."}`;
	if (persona.instructions === "") return identity;
	return [identity, "Your instructions, which come before your general habits wherever the two differ:", persona.instructions].join("\n");
}

export class PersonaStore {
	readonly #sql: SqlStorage;

	constructor(sql: SqlStorage) {
		this.#sql = sql;
		this.#sql.exec(SCHEMA);
		const columns = this.#sql.exec("PRAGMA table_info(pim_personas)").toArray().map((row) => String(row.name));
		if (!columns.includes("is_default")) this.#sql.exec("ALTER TABLE pim_personas ADD COLUMN is_default INTEGER NOT NULL DEFAULT 0");
		if (!columns.includes("team")) this.#sql.exec("ALTER TABLE pim_personas ADD COLUMN team TEXT NOT NULL DEFAULT '[]'");
	}

	/** The default one first, then the others as they were made. */
	list(): Persona[] {
		this.default();
		return this.#sql.exec(`${SELECT} ORDER BY p.is_default DESC, p.created_at, p.id`).toArray().map(personaOf);
	}

	/** The default Pim, made plain the first time it is asked for. */
	default(): Persona {
		const [row] = this.#sql.exec(`${SELECT} WHERE p.is_default = 1`).toArray();
		return row ? personaOf(row) : this.#insert(PLAIN_PIM, null, true);
	}

	/** Makes the default Pim a copy of `input`: at registration, the one the admin chose for everyone. */
	replaceDefault(input: PersonaInput, source: Persona["source"]): Persona {
		const current = this.default();
		this.update(current.id, input);
		this.#sql.exec("UPDATE pim_personas SET source = ? WHERE id = ?", source === null ? null : JSON.stringify(source), current.id);
		return this.get(current.id)!;
	}

	get(id: string): Persona | undefined {
		const [row] = this.#sql.exec(`${SELECT} WHERE p.id = ?`, id).toArray();
		return row ? personaOf(row) : undefined;
	}

	create(input: PersonaInput, source: Persona["source"] = null): Persona {
		if (this.list().length >= MAX_PERSONAS) throw new HttpError(429, `You can have up to ${MAX_PERSONAS} Pims.`);
		return this.#insert(input, source, false);
	}

	#insert(input: PersonaInput, source: Persona["source"], isDefault: boolean): Persona {
		const id = `p_${crypto.randomUUID().replaceAll("-", "").slice(0, 12)}`;
		const now = Date.now();
		this.#sql.exec(
			"INSERT INTO pim_personas (id, name, description, instructions, apps, team, source, published, created_at, updated_at, is_default) VALUES (?, ?, ?, ?, ?, ?, ?, NULL, ?, ?, ?)",
			id,
			input.name,
			input.description,
			input.instructions,
			JSON.stringify(input.apps),
			JSON.stringify(input.team),
			source === null ? null : JSON.stringify(source),
			now,
			now,
			isDefault ? 1 : 0,
		);
		return this.get(id)!;
	}

	update(id: string, input: PersonaInput): Persona {
		this.#sql.exec(
			"UPDATE pim_personas SET name = ?, description = ?, instructions = ?, apps = ?, team = ?, updated_at = ? WHERE id = ?",
			input.name,
			input.description,
			input.instructions,
			JSON.stringify(input.apps),
			JSON.stringify(input.team),
			Date.now(),
			id,
		);
		return this.get(id)!;
	}

	setPublished(id: string, template: string | null): void {
		this.#sql.exec("UPDATE pim_personas SET published = ? WHERE id = ?", template, id);
	}

	/** Deletes it; its chats stay, with the default Pim. */
	delete(id: string): void {
		if (this.get(id)?.default) throw new HttpError(400, "Your default Pim can't be deleted.");
		this.#sql.exec("DELETE FROM pim_persona_sessions WHERE persona = ?", id);
		this.#sql.exec("DELETE FROM pim_persona_icons WHERE persona = ?", id);
		this.#sql.exec("DELETE FROM pim_personas WHERE id = ?", id);
	}

	/** Sets its icon, an image of a type browsers show in a picture. */
	setIcon(id: string, type: string, data: ArrayBuffer): void {
		if (!ICON_TYPES.includes(type)) throw new HttpError(415, "An icon must be a PNG, JPEG, WebP or GIF image.");
		if (data.byteLength === 0) throw new HttpError(400, "The icon is empty.");
		if (data.byteLength > MAX_ICON_BYTES) throw new HttpError(413, `An icon must be at most ${MAX_ICON_BYTES / 1024} KB.`);
		this.#sql.exec(
			"INSERT INTO pim_persona_icons (persona, type, data, updated_at) VALUES (?, ?, ?, ?) ON CONFLICT (persona) DO UPDATE SET type = excluded.type, data = excluded.data, updated_at = excluded.updated_at",
			id,
			type,
			data,
			Date.now(),
		);
	}

	icon(id: string): { type: string; data: ArrayBuffer } | undefined {
		const [row] = this.#sql.exec("SELECT type, data FROM pim_persona_icons WHERE persona = ?", id).toArray();
		return row ? { type: String(row.type), data: row.data as ArrayBuffer } : undefined;
	}

	removeIcon(id: string): void {
		this.#sql.exec("DELETE FROM pim_persona_icons WHERE persona = ?", id);
	}

	setSession(session: string, persona: string): void {
		this.#sql.exec(
			"INSERT INTO pim_persona_sessions (session, persona) VALUES (?, ?) ON CONFLICT (session) DO UPDATE SET persona = excluded.persona",
			session,
			persona,
		);
	}

	/** The Pim a chat was started with, or the default one. */
	ofSession(session: string): Persona {
		const [row] = this.#sql
			.exec(`${SELECT} JOIN pim_persona_sessions s ON p.id = s.persona WHERE s.session = ?`, session)
			.toArray();
		return row ? personaOf(row) : this.default();
	}

	/** Chats started with a Pim other than the default one. */
	startedSessions(): string[] {
		return this.#sql
			.exec("SELECT session FROM pim_persona_sessions")
			.toArray()
			.map((row) => String(row.session));
	}
}
