import { HttpError } from "./http";

/**
 * The owner's Pims: named agents inside their one Pim, each with its own
 * instructions, such as "Marathon coach" or "Trip planner". A chat started
 * with one gets its instructions on top of Pim's own; memory, apps and
 * approvals are the same Pim's. One can be published as a template others
 * make their own (on Pimling, see ./hosted/gallery.ts); a copy made from a
 * template remembers where it came from.
 */

/** An app a template suggests connecting: by its MCP server URL, never with credentials. */
export type SuggestedApp = { readonly name: string; readonly url: string };

export type Persona = {
	readonly id: string;
	readonly name: string;
	readonly description: string;
	readonly instructions: string;
	readonly apps: readonly SuggestedApp[];
	/** The template it was made from. */
	readonly source: { readonly template: string; readonly author: string } | null;
	/** Its published template, if the owner published it. */
	readonly published: string | null;
	readonly createdAt: number;
	readonly updatedAt: number;
};

export type PersonaInput = {
	readonly name: string;
	readonly description: string;
	readonly instructions: string;
	readonly apps: readonly SuggestedApp[];
};

export const MAX_PERSONAS = 20;
export const MAX_NAME = 60;
export const MAX_DESCRIPTION = 280;
export const MAX_INSTRUCTIONS = 8000;
export const MAX_APPS = 10;

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
	updated_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS pim_persona_sessions (
	session TEXT PRIMARY KEY,
	persona TEXT NOT NULL
);
`;

type Row = Record<string, SqlStorageValue>;

const personaOf = (row: Row): Persona => ({
	id: String(row.id),
	name: String(row.name),
	description: String(row.description),
	instructions: String(row.instructions),
	apps: JSON.parse(String(row.apps)) as SuggestedApp[],
	source: row.source ? (JSON.parse(String(row.source)) as Persona["source"]) : null,
	published: row.published === null ? null : String(row.published),
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
				: text(body.instructions, "instructions", MAX_INSTRUCTIONS, true),
		apps: apps.map((app) => {
			const { name, url } = (app ?? {}) as { name?: unknown; url?: unknown };
			if (typeof url !== "string" || !/^https:\/\/[^\s]+$/.test(url) || url.length > 500) {
				throw new HttpError(400, "Each app needs an https url");
			}
			return { name: text(name, "app name", 40, true), url };
		}),
	};
}

/** What a chat with a Pim gets on top of Pim's own instructions. */
export function personaInstructions(persona: Persona): string {
	return [
		`In this conversation you are "${persona.name}", one of the Pims your person made${persona.description ? `: ${persona.description}` : "."}`,
		"Their instructions for it, which come before your general habits wherever the two differ:",
		persona.instructions,
	].join("\n");
}

export class PersonaStore {
	readonly #sql: SqlStorage;

	constructor(sql: SqlStorage) {
		this.#sql = sql;
		this.#sql.exec(SCHEMA);
	}

	list(): Persona[] {
		return this.#sql.exec("SELECT * FROM pim_personas ORDER BY created_at, id").toArray().map(personaOf);
	}

	get(id: string): Persona | undefined {
		const [row] = this.#sql.exec("SELECT * FROM pim_personas WHERE id = ?", id).toArray();
		return row ? personaOf(row) : undefined;
	}

	create(input: PersonaInput, source: Persona["source"] = null): Persona {
		if (this.list().length >= MAX_PERSONAS) throw new HttpError(429, `You can have up to ${MAX_PERSONAS} Pims.`);
		const id = `p_${crypto.randomUUID().replaceAll("-", "").slice(0, 12)}`;
		const now = Date.now();
		this.#sql.exec(
			"INSERT INTO pim_personas (id, name, description, instructions, apps, source, published, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, NULL, ?, ?)",
			id,
			input.name,
			input.description,
			input.instructions,
			JSON.stringify(input.apps),
			source === null ? null : JSON.stringify(source),
			now,
			now,
		);
		return this.get(id)!;
	}

	update(id: string, input: PersonaInput): Persona {
		this.#sql.exec(
			"UPDATE pim_personas SET name = ?, description = ?, instructions = ?, apps = ?, updated_at = ? WHERE id = ?",
			input.name,
			input.description,
			input.instructions,
			JSON.stringify(input.apps),
			Date.now(),
			id,
		);
		return this.get(id)!;
	}

	setPublished(id: string, template: string | null): void {
		this.#sql.exec("UPDATE pim_personas SET published = ? WHERE id = ?", template, id);
	}

	/** Deletes it; its chats stay, as plain chats. Returns them. */
	delete(id: string): string[] {
		const sessions = this.sessions(id);
		this.#sql.exec("DELETE FROM pim_persona_sessions WHERE persona = ?", id);
		this.#sql.exec("DELETE FROM pim_personas WHERE id = ?", id);
		return sessions;
	}

	setSession(session: string, persona: string): void {
		this.#sql.exec(
			"INSERT INTO pim_persona_sessions (session, persona) VALUES (?, ?) ON CONFLICT (session) DO UPDATE SET persona = excluded.persona",
			session,
			persona,
		);
	}

	ofSession(session: string): Persona | undefined {
		const [row] = this.#sql
			.exec("SELECT p.* FROM pim_persona_sessions s JOIN pim_personas p ON p.id = s.persona WHERE s.session = ?", session)
			.toArray();
		return row ? personaOf(row) : undefined;
	}

	sessions(persona: string): string[] {
		return this.#sql
			.exec("SELECT session FROM pim_persona_sessions WHERE persona = ?", persona)
			.toArray()
			.map((row) => String(row.session));
	}
}
