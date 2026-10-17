import { type DirectoryApp, storedApps } from "./extensions/app-directory";
import { ASSISTANT_BLUEPRINT } from "./extensions/assistant";
import type { BlueprintDefinition } from "./extensions/define";
import { HttpError } from "./http";
import { SKILL_NAME } from "./skills";

/**
 * The owner's agents: each with its own instructions, such as "Marathon
 * coach" or "Trip planner". Each builds on a blueprint an extension brings
 * (its `blueprint`, see ./extensions/define.ts), usually Pim's own
 * assistant, and adds the person's name and instructions on top. One of
 * them is the majordomo: the agent the person comes to first, which knows
 * them best, hands work down to the others, and stands in for the person on
 * their approvals (see ./majordomo.ts). It talks in chats started without
 * choosing an agent, and it is always the same one: the title can't move to
 * another agent, and it can't be deleted. The person names it and chooses
 * its look when they first sign in. Memory, approvals and connected apps
 * are shared by all of them: an agent lists the apps it works with by name, from the
 * deployment's directory (./extensions/app-directory.ts), and the person
 * connects each app once.
 * One can be published as a template others make their own (see
 * ./gallery.ts); a copy made from a template remembers where it came from.
 *
 * An agent can have a team: named members with instructions of their own,
 * which it hands tasks to and which work in parallel (see ./team.ts). The
 * person talks only with the agent.
 */

/** One of an agent's team: it does tasks the agent hands it, and answers the agent, never the person. */
export type TeamMember = {
	readonly name: string;
	readonly instructions: string;
	/** The tools it may use, by name; null for all the agent's tools a member can have. */
	readonly tools: readonly string[] | null;
};

export type Agent = {
	readonly id: string;
	readonly name: string;
	readonly description: string;
	readonly instructions: string;
	/** The apps it works with, by name in the directory: `<extension>/<app>`. */
	readonly apps: readonly string[];
	/** The person's skills it uses, by name (see ./skills.ts). */
	readonly skills: readonly string[];
	readonly team: readonly TeamMember[];
	/** The blueprint it builds on, as `<extension>/<blueprint>`; null for none. */
	readonly blueprint: string | null;
	/** The template it was made from. */
	readonly source: { readonly template: string; readonly author: string } | null;
	/** Its published template, if the owner published it. */
	readonly published: string | null;
	/** When its icon was last set, to fetch it again when it changes; null without one. */
	readonly icon: number | null;
	/** What shows for it without an uploaded icon: a named icon, such as `rocket`, or one emoji; null for the default. */
	readonly symbol: string | null;
	/** One of `AGENT_COLORS`, for its symbol; null for the default. */
	readonly color: string | null;
	/** The person's majordomo: the one that talks in chats started without choosing an agent. There is one, always the same, and it can't be deleted. */
	readonly majordomo: boolean;
	readonly createdAt: number;
	readonly updatedAt: number;
};

export type AgentInput = {
	readonly name: string;
	readonly description: string;
	readonly instructions: string;
	readonly apps: readonly string[];
	readonly skills: readonly string[];
	readonly team: readonly TeamMember[];
	/** Left out, a new agent builds on the deployment's default blueprint and an edited one keeps its own. */
	readonly blueprint?: string | null;
	/** Left out, a new agent has the default look and an edited one keeps its own. */
	readonly symbol?: string | null;
	readonly color?: string | null;
};

export const MAX_AGENTS = 20;
export const MAX_ICON_BYTES = 256 * 1024;
export const ICON_TYPES = ["image/png", "image/jpeg", "image/webp", "image/gif"];
export const AGENT_COLORS = ["gray", "red", "orange", "amber", "green", "teal", "blue", "indigo", "violet", "pink"];
export const MAX_NAME = 60;
export const MAX_DESCRIPTION = 280;
export const MAX_INSTRUCTIONS = 8000;
export const MAX_APPS = 10;
export const MAX_AGENT_SKILLS = 20;
export const MAX_TEAM = 8;
export const MAX_MEMBER_NAME = 40;
export const MAX_MEMBER_TOOLS = 50;


const SCHEMA = `
CREATE TABLE IF NOT EXISTS pim_agents (
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
	team TEXT NOT NULL DEFAULT '[]',
	blueprint TEXT,
	symbol TEXT,
	color TEXT,
	introduced INTEGER NOT NULL DEFAULT 0,
	skills TEXT NOT NULL DEFAULT '[]'
);
CREATE TABLE IF NOT EXISTS pim_agent_icons (
	agent TEXT PRIMARY KEY,
	type TEXT NOT NULL,
	data BLOB NOT NULL,
	updated_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS pim_agent_sessions (
	session TEXT PRIMARY KEY,
	agent TEXT NOT NULL,
	handed_by TEXT,
	handoff TEXT
);
CREATE TABLE IF NOT EXISTS pim_session_abilities (
	session TEXT PRIMARY KEY,
	abilities TEXT NOT NULL
);
`;

type Row = Record<string, SqlStorageValue>;

/**
 * Agents were once called personas: their tables, and a column, are renamed
 * in place the first time an old database starts, keeping its rows.
 */
function renameStorage(sql: SqlStorage): void {
	const names = (query: string) => new Set(sql.exec(query).toArray().map((row) => String(row.name)));
	const tables = names("SELECT name FROM sqlite_master WHERE type = 'table'");
	for (const [from, to] of [["pim_personas", "pim_agents"], ["pim_persona_icons", "pim_agent_icons"], ["pim_persona_sessions", "pim_agent_sessions"]] as const) {
		if (tables.has(from) && !tables.has(to)) sql.exec(`ALTER TABLE ${from} RENAME TO ${to}`);
	}
	for (const table of ["pim_agent_icons", "pim_agent_sessions"]) {
		if (names(`PRAGMA table_info(${table})`).has("persona")) sql.exec(`ALTER TABLE ${table} RENAME COLUMN persona TO agent`);
	}
	// Blueprints were called bases.
	const agents = names("PRAGMA table_info(pim_agents)");
	if (agents.has("base") && !agents.has("blueprint")) sql.exec("ALTER TABLE pim_agents RENAME COLUMN base TO blueprint");
}

const SELECT = "SELECT p.*, (SELECT updated_at FROM pim_agent_icons WHERE agent = p.id) AS icon FROM pim_agents p";

const agentOf = (row: Row, directory: () => readonly DirectoryApp[]): Agent => ({
	id: String(row.id),
	name: String(row.name),
	description: String(row.description),
	instructions: String(row.instructions),
	apps: storedApps(JSON.parse(String(row.apps)) as unknown[], directory),
	skills: JSON.parse(String(row.skills)) as string[],
	team: JSON.parse(String(row.team)) as TeamMember[],
	blueprint: row.blueprint === null ? null : String(row.blueprint),
	source: row.source ? (JSON.parse(String(row.source)) as Agent["source"]) : null,
	published: row.published === null ? null : String(row.published),
	icon: row.icon === null ? null : Number(row.icon),
	symbol: row.symbol === null ? null : String(row.symbol),
	color: row.color === null ? null : String(row.color),
	majordomo: Number(row.is_default) === 1,
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

/** An agent as given through the API or a template: checked, trimmed, within limits. */
export function agentInput(body: Record<string, unknown>, partial?: Agent): AgentInput {
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
		apps: [
			...new Set(
				apps.map((app) => {
					if (typeof app !== "string" || !REF.test(app)) throw new HttpError(400, "Each app must be an app's id, such as custom/notes");
					return app;
				}),
			),
		],
		skills: body.skills === undefined ? (partial?.skills ?? []) : skillsInput(body.skills),
		team: body.team === undefined ? (partial?.team ?? []) : teamInput(body.team),
		...(body.symbol === undefined ? {} : { symbol: symbolInput(body.symbol) }),
		...(body.color === undefined ? {} : { color: colorInput(body.color) }),
		...(body.blueprint === undefined ? {} : { blueprint: blueprintInput(body.blueprint) }),
	};
}

/** What an extension brings, by name: `<extension>/<name>`. */
const REF = /^[a-z0-9][a-z0-9.-]*\/[a-z0-9][a-z0-9.-]*$/;

/** A blueprint as given: `<extension>/<blueprint>`, or null. Whether it is installed is the Pim's to check. */
function blueprintInput(value: unknown): string | null {
	if (value === null) return null;
	if (typeof value !== "string" || !REF.test(value)) {
		throw new HttpError(400, "blueprint must be an extension's blueprint, such as pim.assistant/pim, or null");
	}
	return value;
}

/** Skills as given: names of the person's skills. Whether each exists is the Pim's to check. */
function skillsInput(value: unknown): string[] {
	if (!Array.isArray(value) || value.length > MAX_AGENT_SKILLS || value.some((name) => typeof name !== "string" || !SKILL_NAME.test(name))) {
		throw new HttpError(400, `skills must be a list of up to ${MAX_AGENT_SKILLS} skill names, such as weekly-report`);
	}
	return [...new Set(value as string[])];
}

/** A symbol as given: a named icon, which the app draws, or a single emoji; or null. */
function symbolInput(value: unknown): string | null {
	if (value === null) return null;
	if (typeof value !== "string" || !(/^[a-z][a-z0-9-]{0,39}$/.test(value) || /^\p{RGI_Emoji}$/v.test(value))) {
		throw new HttpError(400, "symbol must be an icon's name, such as rocket, or one emoji, or null");
	}
	return value;
}

function colorInput(value: unknown): string | null {
	if (value === null) return null;
	if (typeof value !== "string" || !AGENT_COLORS.includes(value)) throw new HttpError(400, `color must be one of ${AGENT_COLORS.join(", ")}, or null`);
	return value;
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

/**
 * Who a chat's agent is and how it works: its name and `role`, such as the
 * majordomo's, then the instructions of the blueprint it builds on, then the
 * person's own, which win.
 */
export function agentInstructions(agent: Agent, blueprint: BlueprintDefinition | undefined, role?: string): string {
	const identity = `In this conversation you are "${agent.name}"${agent.description ? `: ${agent.description}` : "."}`;
	const own =
		agent.instructions === ""
			? []
			: [`Your instructions, which come before your general habits wherever the two differ:\n${agent.instructions}`];
	return [identity, ...(role ? [role] : []), ...(blueprint ? [blueprint.instructions] : []), ...own].join("\n\n");
}

export class AgentStore {
	readonly #sql: SqlStorage;
	readonly #starter: () => AgentInput;
	readonly #directory: () => readonly DirectoryApp[];

	/**
	 * `starter` is the majordomo as it is made, the first time any agent is
	 * asked for, until the person names it. `directory` finds the apps agents
	 * listed by URL before it.
	 */
	constructor(sql: SqlStorage, starter: () => AgentInput, directory: () => readonly DirectoryApp[]) {
		this.#sql = sql;
		this.#starter = starter;
		this.#directory = directory;
		renameStorage(this.#sql);
		this.#sql.exec(SCHEMA);
		const columns = this.#sql.exec("PRAGMA table_info(pim_agents)").toArray().map((row) => String(row.name));
		if (!columns.includes("is_default")) this.#sql.exec("ALTER TABLE pim_agents ADD COLUMN is_default INTEGER NOT NULL DEFAULT 0");
		if (!columns.includes("team")) this.#sql.exec("ALTER TABLE pim_agents ADD COLUMN team TEXT NOT NULL DEFAULT '[]'");
		// Agents made before extensions all had the assistant's habits.
		if (!columns.includes("blueprint")) this.#sql.exec(`ALTER TABLE pim_agents ADD COLUMN blueprint TEXT DEFAULT '${ASSISTANT_BLUEPRINT}'`);
		if (!columns.includes("symbol")) this.#sql.exec("ALTER TABLE pim_agents ADD COLUMN symbol TEXT");
		if (!columns.includes("color")) this.#sql.exec("ALTER TABLE pim_agents ADD COLUMN color TEXT");
		// Accounts from before majordomos already have the agent they talk with: it becomes theirs as it is.
		if (!columns.includes("introduced")) this.#sql.exec("ALTER TABLE pim_agents ADD COLUMN introduced INTEGER NOT NULL DEFAULT 1");
		if (!columns.includes("skills")) this.#sql.exec("ALTER TABLE pim_agents ADD COLUMN skills TEXT NOT NULL DEFAULT '[]'");
		const sessionColumns = this.#sql.exec("PRAGMA table_info(pim_agent_sessions)").toArray().map((row) => String(row.name));
		if (!sessionColumns.includes("handed_by")) this.#sql.exec("ALTER TABLE pim_agent_sessions ADD COLUMN handed_by TEXT");
		if (!sessionColumns.includes("handoff")) this.#sql.exec("ALTER TABLE pim_agent_sessions ADD COLUMN handoff TEXT");
	}

	/** The majordomo first, then the others as they were made. */
	list(): Agent[] {
		this.majordomo();
		return this.#sql.exec(`${SELECT} ORDER BY p.is_default DESC, p.created_at, p.id`).toArray().map((row) => agentOf(row, this.#directory));
	}

	/** The majordomo, made from the starter the first time it is asked for. */
	majordomo(): Agent {
		const [row] = this.#sql.exec(`${SELECT} WHERE p.is_default = 1`).toArray();
		return row ? agentOf(row, this.#directory) : this.#insert(this.#starter(), null, true);
	}

	/** Whether the person has named their majordomo yet, which they do when they first sign in. */
	introduced(): boolean {
		const [row] = this.#sql.exec("SELECT introduced FROM pim_agents WHERE id = ?", this.majordomo().id).toArray();
		return Number(row?.introduced) === 1;
	}

	/** The person named their majordomo. */
	introduce(): void {
		this.#sql.exec("UPDATE pim_agents SET introduced = 1 WHERE is_default = 1");
	}

	get(id: string): Agent | undefined {
		const [row] = this.#sql.exec(`${SELECT} WHERE p.id = ?`, id).toArray();
		return row ? agentOf(row, this.#directory) : undefined;
	}

	create(input: AgentInput, source: Agent["source"] = null): Agent {
		if (this.list().length >= MAX_AGENTS) throw new HttpError(429, `You can have up to ${MAX_AGENTS} agents.`);
		return this.#insert(input, source, false);
	}

	#insert(input: AgentInput, source: Agent["source"], isDefault: boolean): Agent {
		const id = `p_${crypto.randomUUID().replaceAll("-", "").slice(0, 12)}`;
		const now = Date.now();
		this.#sql.exec(
			"INSERT INTO pim_agents (id, name, description, instructions, apps, skills, team, blueprint, symbol, color, source, published, created_at, updated_at, is_default) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?, ?, ?)",
			id,
			input.name,
			input.description,
			input.instructions,
			JSON.stringify(input.apps),
			JSON.stringify(input.skills),
			JSON.stringify(input.team),
			input.blueprint === undefined ? (this.#starter().blueprint ?? null) : input.blueprint,
			input.symbol ?? null,
			input.color ?? null,
			source === null ? null : JSON.stringify(source),
			now,
			now,
			isDefault ? 1 : 0,
		);
		return this.get(id)!;
	}

	update(id: string, input: AgentInput): Agent {
		this.#sql.exec(
			"UPDATE pim_agents SET name = ?, description = ?, instructions = ?, apps = ?, skills = ?, team = ?, updated_at = ? WHERE id = ?",
			input.name,
			input.description,
			input.instructions,
			JSON.stringify(input.apps),
			JSON.stringify(input.skills),
			JSON.stringify(input.team),
			Date.now(),
			id,
		);
		if (input.blueprint !== undefined) this.#sql.exec("UPDATE pim_agents SET blueprint = ? WHERE id = ?", input.blueprint, id);
		if (input.symbol !== undefined) this.#sql.exec("UPDATE pim_agents SET symbol = ? WHERE id = ?", input.symbol, id);
		if (input.color !== undefined) this.#sql.exec("UPDATE pim_agents SET color = ? WHERE id = ?", input.color, id);
		return this.get(id)!;
	}

	setPublished(id: string, template: string | null): void {
		this.#sql.exec("UPDATE pim_agents SET published = ? WHERE id = ?", template, id);
	}

	/** Deletes it; its chats stay, with the majordomo. */
	delete(id: string): void {
		if (this.get(id)?.majordomo) throw new HttpError(400, "Your majordomo can't be deleted.");
		this.#sql.exec("DELETE FROM pim_agent_sessions WHERE agent = ?", id);
		this.#sql.exec("DELETE FROM pim_agent_icons WHERE agent = ?", id);
		this.#sql.exec("DELETE FROM pim_agents WHERE id = ?", id);
	}

	/** Sets its icon, an image of a type browsers show in a picture. */
	setIcon(id: string, type: string, data: ArrayBuffer): void {
		if (!ICON_TYPES.includes(type)) throw new HttpError(415, "An icon must be a PNG, JPEG, WebP or GIF image.");
		if (data.byteLength === 0) throw new HttpError(400, "The icon is empty.");
		if (data.byteLength > MAX_ICON_BYTES) throw new HttpError(413, `An icon must be at most ${MAX_ICON_BYTES / 1024} KB.`);
		this.#sql.exec(
			"INSERT INTO pim_agent_icons (agent, type, data, updated_at) VALUES (?, ?, ?, ?) ON CONFLICT (agent) DO UPDATE SET type = excluded.type, data = excluded.data, updated_at = excluded.updated_at",
			id,
			type,
			data,
			Date.now(),
		);
	}

	icon(id: string): { type: string; data: ArrayBuffer } | undefined {
		const [row] = this.#sql.exec("SELECT type, data FROM pim_agent_icons WHERE agent = ?", id).toArray();
		return row ? { type: String(row.type), data: row.data as ArrayBuffer } : undefined;
	}

	removeIcon(id: string): void {
		this.#sql.exec("DELETE FROM pim_agent_icons WHERE agent = ?", id);
	}

	/**
	 * Ties a chat to an agent. A chat the majordomo started for the person
	 * also records the majordomo's chat it came from and the handoff's key,
	 * so a retried handoff finds the same chat.
	 */
	setSession(session: string, agent: string, handoff?: { from: string; key: string }): void {
		this.#sql.exec(
			"INSERT INTO pim_agent_sessions (session, agent, handed_by, handoff) VALUES (?, ?, ?, ?) ON CONFLICT (session) DO UPDATE SET agent = excluded.agent",
			session,
			agent,
			handoff?.from ?? null,
			handoff?.key ?? null,
		);
	}

	/** The majordomo's chat a chat was started from, if the majordomo started it. */
	handedBy(session: string): string | undefined {
		const [row] = this.#sql.exec("SELECT handed_by FROM pim_agent_sessions WHERE session = ?", session).toArray();
		return row?.handed_by == null ? undefined : String(row.handed_by);
	}

	/** The chat a handoff started, if it has. */
	byHandoff(key: string): string | undefined {
		const [row] = this.#sql.exec("SELECT session FROM pim_agent_sessions WHERE handoff = ?", key).toArray();
		return row ? String(row.session) : undefined;
	}

	/** The agent a chat was started with, or the majordomo for a chat tied to none. */
	ofSession(session: string): Agent {
		const [row] = this.#sql
			.exec(`${SELECT} JOIN pim_agent_sessions s ON p.id = s.agent WHERE s.session = ?`, session)
			.toArray();
		return row ? agentOf(row, this.#directory) : this.majordomo();
	}

	/** The abilities a chat was last given, as space-separated extension ids; null if never. */
	abilities(session: string): string | null {
		const [row] = this.#sql.exec("SELECT abilities FROM pim_session_abilities WHERE session = ?", session).toArray();
		return row ? String(row.abilities) : null;
	}

	setAbilities(session: string, abilities: string): void {
		this.#sql.exec(
			"INSERT INTO pim_session_abilities (session, abilities) VALUES (?, ?) ON CONFLICT (session) DO UPDATE SET abilities = excluded.abilities",
			session,
			abilities,
		);
	}

	/** Chats tied to an agent. */
	startedSessions(): string[] {
		return this.#sql
			.exec("SELECT session FROM pim_agent_sessions")
			.toArray()
			.map((row) => String(row.session));
	}
}
