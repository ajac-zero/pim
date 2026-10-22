import { type DirectoryApp, storedApps } from "./extensions/app-directory";
import { ASSISTANT_BLUEPRINT } from "./extensions/assistant";
import type { WidgetSize } from "./extensions/dashboard";
import type { BlueprintDefinition } from "./extensions/define";
import { PRIVATE_SCOPE } from "./extensions/optmem/store";
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
 * its look when they first sign in. Approvals and connected apps
 * are shared by all of them: an agent lists the apps it works with by name, from the
 * deployment's directory (./extensions/app-directory.ts), and the person
 * connects each app once. Memory is kept in scopes: each agent has its own,
 * which copies of one template share, and reads the scope every agent reads
 * and the person's named scopes they chose for it; the majordomo's own is
 * the private scope, and it reads them all.
 * One can be published as a template others make their own (see
 * ./gallery.ts); a copy made from a template remembers where it came from.
 *
 * An agent lists its contacts, as it lists its apps: others of the person's
 * agents it hands tasks to (see ./tasks.ts). Every agent that works is one
 * of the person's own, in the sidebar with its own page; the majordomo
 * hands tasks to all of them without a list.
 */

export type Agent = {
	readonly id: string;
	/** What people call it, such as "Ada". Agents may share a name. */
	readonly name: string;
	/** What it is for, such as "Researcher", which is how agents and templates refer to it. Each of the person's agents has its own. */
	readonly role: string;
	readonly description: string;
	readonly instructions: string;
	/** The apps it works with, by name in the directory: `<extension>/<app>`. */
	readonly apps: readonly string[];
	/** The person's skills it uses, by name (see ./skills.ts). */
	readonly skills: readonly string[];
	/** The person's other agents it hands tasks to, by id; the majordomo's is empty, as it hands tasks to all of them. */
	readonly contacts: readonly string[];
	/** The memory scope its notes go to: the majordomo's is the private scope, and copies of one template share one. */
	readonly memoryScope: string;
	/** The person's named memory scopes it reads besides its own and everyone's, by key. */
	readonly memoryScopes: readonly string[];
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
	/**
	 * What its dashboard shows, in order: widgets as `<extension>/<widget>` and
	 * the person's artifacts as `artifact:<id>`. Null until it's changed: the
	 * blueprint's dashboard.
	 */
	readonly dashboard: readonly string[] | null;
	/** The size of each artifact's widget on its dashboard, by item, where it isn't the default. */
	readonly dashboardSizes: Readonly<Record<string, WidgetSize>>;
	readonly createdAt: number;
	readonly updatedAt: number;
};

export type AgentInput = {
	readonly name: string;
	/** Left out, a new agent's role is its name and an edited one keeps its own. */
	readonly role?: string;
	readonly description: string;
	readonly instructions: string;
	readonly apps: readonly string[];
	readonly skills: readonly string[];
	readonly contacts: readonly string[];
	/** Left out, a new agent reads none of the named memory scopes and an edited one keeps those it reads. */
	readonly memoryScopes?: readonly string[];
	/** Left out, a new agent builds on the deployment's default blueprint and an edited one keeps its own. */
	readonly blueprint?: string | null;
	/** Left out, a new agent has the default look and an edited one keeps its own. */
	readonly symbol?: string | null;
	readonly color?: string | null;
};

export const MAX_AGENTS = 50;
export const MAX_ICON_BYTES = 256 * 1024;
export const ICON_TYPES = ["image/png", "image/jpeg", "image/webp", "image/gif"];

/** Refuses what can't be an agent's icon: an image of a type browsers show in a picture, of at most `MAX_ICON_BYTES`. */
export function checkIcon(type: string, bytes: number): void {
	if (!ICON_TYPES.includes(type)) throw new HttpError(415, "An icon must be a PNG, JPEG, WebP or GIF image.");
	if (bytes === 0) throw new HttpError(400, "The icon is empty.");
	if (bytes > MAX_ICON_BYTES) throw new HttpError(413, `An icon must be at most ${MAX_ICON_BYTES / 1024} KB.`);
}

export const AGENT_COLORS = ["gray", "red", "orange", "amber", "green", "teal", "blue", "indigo", "violet", "pink"];
export const MAX_NAME = 60;
export const MAJORDOMO_ROLE = "Majordomo";
export const MAX_DESCRIPTION = 280;
export const MAX_INSTRUCTIONS = 8000;
export const MAX_APPS = 10;
export const MAX_AGENT_SKILLS = 20;
export const MAX_MEMORY_SCOPES = 20;

const SCHEMA = `
CREATE TABLE IF NOT EXISTS pim_agents (
	id TEXT PRIMARY KEY,
	name TEXT NOT NULL,
	role TEXT,
	description TEXT NOT NULL,
	instructions TEXT NOT NULL,
	apps TEXT NOT NULL,
	source TEXT,
	published TEXT,
	created_at INTEGER NOT NULL,
	updated_at INTEGER NOT NULL,
	is_default INTEGER NOT NULL DEFAULT 0,
	blueprint TEXT,
	symbol TEXT,
	color TEXT,
	introduced INTEGER NOT NULL DEFAULT 0,
	skills TEXT NOT NULL DEFAULT '[]',
	dashboard TEXT,
	dashboard_sizes TEXT,
	contacts TEXT NOT NULL DEFAULT '[]',
	memory_scope TEXT,
	memory_scopes TEXT NOT NULL DEFAULT '[]',
	copy_of TEXT
);
CREATE TABLE IF NOT EXISTS pim_agent_icons (
	agent TEXT PRIMARY KEY,
	type TEXT NOT NULL,
	data BLOB NOT NULL,
	updated_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS pim_agent_sessions (
	session TEXT PRIMARY KEY,
	agent TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS pim_session_abilities (
	session TEXT PRIMARY KEY,
	abilities TEXT NOT NULL
);
`;

type Row = Record<string, SqlStorageValue>;

const newAgentId = () => `p_${crypto.randomUUID().replaceAll("-", "").slice(0, 12)}`;

/** An agent as a prompt lists it: its name, and its role when that is not the same. */
export const agentLabel = (agent: Agent) => (agent.role.toLowerCase() === agent.name.toLowerCase() ? agent.name : `${agent.name} (${agent.role})`);

/** The agent someone means by `wanted`: the one with that role, or else the only one with that name. */
export function agentCalled(wanted: string, agents: readonly Agent[]): Agent | undefined {
	const key = wanted.trim().toLowerCase();
	const named = agents.filter((agent) => agent.name.toLowerCase() === key);
	return agents.find((agent) => agent.role.toLowerCase() === key) ?? (named.length === 1 ? named[0] : undefined);
}

/** `name`, or, when one of the person's agents has it as its role, the name with its former agent's after it, or a number. */
export function freeName(name: string, of: string, taken: ReadonlySet<string>): string {
	const candidates = [name, `${name} (${of})`.slice(0, MAX_NAME), ...Array.from({ length: MAX_AGENTS * 2 }, (_, n) => `${name.slice(0, MAX_NAME - 4)} ${n + 2}`)];
	return candidates.find((candidate) => !taken.has(candidate.toLowerCase())) ?? name;
}

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
	role: String(row.role),
	description: String(row.description),
	instructions: String(row.instructions),
	apps: storedApps(JSON.parse(String(row.apps)) as unknown[], directory),
	skills: JSON.parse(String(row.skills)) as string[],
	contacts: JSON.parse(String(row.contacts)) as string[],
	memoryScope: String(row.memory_scope),
	memoryScopes: JSON.parse(String(row.memory_scopes)) as string[],
	blueprint: row.blueprint === null ? null : String(row.blueprint),
	source: row.source ? (JSON.parse(String(row.source)) as Agent["source"]) : null,
	published: row.published === null ? null : String(row.published),
	icon: row.icon === null ? null : Number(row.icon),
	symbol: row.symbol === null ? null : String(row.symbol),
	color: row.color === null ? null : String(row.color),
	majordomo: Number(row.is_default) === 1,
	dashboard: row.dashboard === null ? null : (JSON.parse(String(row.dashboard)) as string[]),
	dashboardSizes: row.dashboard_sizes ? (JSON.parse(String(row.dashboard_sizes)) as Record<string, WidgetSize>) : {},
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
	const name = body.name === undefined && partial ? partial.name : text(body.name, "name", MAX_NAME, true);
	return {
		name,
		role: body.role === undefined ? (partial?.role ?? name) : text(body.role, "role", MAX_NAME, true),
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
		contacts: body.contacts === undefined ? (partial?.contacts ?? []) : contactsInput(body.contacts),
		...(body.memoryScopes === undefined ? {} : { memoryScopes: memoryScopesInput(body.memoryScopes) }),
		...(body.symbol === undefined ? {} : { symbol: symbolInput(body.symbol) }),
		...(body.color === undefined ? {} : { color: colorInput(body.color) }),
		...(body.blueprint === undefined ? {} : { blueprint: blueprintInput(body.blueprint) }),
	};
}

/** What an extension brings, by name: `<extension>/<name>`. */
const REF = /^[a-z0-9][a-z0-9.-]*\/[a-z0-9][a-z0-9.-]*$/;

/** A blueprint as given: `<extension>/<blueprint>`, or null. Whether it is installed is the space's to check. */
function blueprintInput(value: unknown): string | null {
	if (value === null) return null;
	if (typeof value !== "string" || !REF.test(value)) {
		throw new HttpError(400, "blueprint must be an extension's blueprint, such as pim.assistant/pim, or null");
	}
	return value;
}

/** Skills as given: names of the person's skills. Whether each exists is the space's to check. */
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

/** Contacts as given: ids of the person's agents. Whether each is one, and not the agent itself, is the space's to check. */
function contactsInput(value: unknown): string[] {
	if (!Array.isArray(value) || value.length > MAX_AGENTS || value.some((id) => typeof id !== "string" || !/^p_\w{1,32}$/.test(id))) {
		throw new HttpError(400, `contacts must be a list of up to ${MAX_AGENTS} of your agents' ids`);
	}
	return [...new Set(value as string[])];
}

/** Named memory scopes as given, by key. Whether each is one of the person's is the space's to check. */
function memoryScopesInput(value: unknown): string[] {
	if (!Array.isArray(value) || value.length > MAX_MEMORY_SCOPES || value.some((key) => typeof key !== "string" || !/^s_\w{1,32}$/.test(key))) {
		throw new HttpError(400, `memoryScopes must be a list of up to ${MAX_MEMORY_SCOPES} of your named memory scopes' keys`);
	}
	return [...new Set(value as string[])];
}

/**
 * Checks an agent's contacts: others of the person's agents, never the
 * majordomo, which has none, as it hands tasks to all of them. `self` is the
 * agent edited, or null for a new one.
 */
export function checkContacts(self: Agent | null, input: AgentInput, agents: readonly Agent[]): AgentInput {
	if (input.contacts.length === 0) return input;
	if (self?.majordomo) throw new HttpError(400, "Your majordomo hands tasks to all of your agents, so it has no contacts.");
	for (const id of input.contacts) {
		const contact = agents.find((agent) => agent.id === id);
		if (!contact || contact.majordomo || contact.id === self?.id) throw new HttpError(400, `${id} isn't another of your agents: contacts can't include the agent itself or your majordomo`);
	}
	return input;
}

/**
 * Who a chat's agent is and how it works: its name and `role`, such as the
 * majordomo's, then the instructions of the blueprint it builds on, then the
 * person's own, which win.
 */
export function agentInstructions(agent: Agent, blueprint: BlueprintDefinition | undefined, role?: string): string {
	const as = agent.role.toLowerCase() === agent.name.toLowerCase() ? "" : `, the person's ${agent.role}`;
	const identity = `In this conversation you are "${agent.name}"${as}${agent.description ? `: ${agent.description}` : "."}`;
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
		// Agents made before extensions all had the assistant's habits.
		if (!columns.includes("blueprint")) this.#sql.exec(`ALTER TABLE pim_agents ADD COLUMN blueprint TEXT DEFAULT '${ASSISTANT_BLUEPRINT}'`);
		if (!columns.includes("symbol")) this.#sql.exec("ALTER TABLE pim_agents ADD COLUMN symbol TEXT");
		if (!columns.includes("color")) this.#sql.exec("ALTER TABLE pim_agents ADD COLUMN color TEXT");
		// Accounts from before majordomos already have the agent they talk with: it becomes theirs as it is.
		if (!columns.includes("introduced")) this.#sql.exec("ALTER TABLE pim_agents ADD COLUMN introduced INTEGER NOT NULL DEFAULT 1");
		if (!columns.includes("skills")) this.#sql.exec("ALTER TABLE pim_agents ADD COLUMN skills TEXT NOT NULL DEFAULT '[]'");
		if (!columns.includes("dashboard")) this.#sql.exec("ALTER TABLE pim_agents ADD COLUMN dashboard TEXT");
		if (!columns.includes("dashboard_sizes")) this.#sql.exec("ALTER TABLE pim_agents ADD COLUMN dashboard_sizes TEXT");
		if (!columns.includes("contacts")) this.#sql.exec("ALTER TABLE pim_agents ADD COLUMN contacts TEXT NOT NULL DEFAULT '[]'");
		if (!columns.includes("memory_scope")) this.#sql.exec("ALTER TABLE pim_agents ADD COLUMN memory_scope TEXT");
		if (!columns.includes("memory_scopes")) this.#sql.exec("ALTER TABLE pim_agents ADD COLUMN memory_scopes TEXT NOT NULL DEFAULT '[]'");
		if (!columns.includes("copy_of")) this.#sql.exec("ALTER TABLE pim_agents ADD COLUMN copy_of TEXT");
		// Agents were called by their role: it is their name, until the person gives them another.
		if (!columns.includes("role")) this.#sql.exec("ALTER TABLE pim_agents ADD COLUMN role TEXT");
		this.#sql.exec(`UPDATE pim_agents SET role = CASE WHEN is_default = 1 THEN '${MAJORDOMO_ROLE}' ELSE name END WHERE role IS NULL`);
		if (columns.includes("team")) this.#moveTeams();
		// Agents from before memory scopes, and those made from teams, each get a scope of their own.
		this.#sql.exec(`UPDATE pim_agents SET memory_scope = CASE WHEN is_default = 1 THEN '${PRIVATE_SCOPE}' ELSE 'agent-' || id END WHERE memory_scope IS NULL`);
	}

	/**
	 * The memory scope a new agent keeps its notes in: the private scope for
	 * the majordomo; for a copy, the scope of an earlier copy of the same
	 * agent, or of the person's own agent it was published from, so copies of
	 * one agent share what they remember; else a scope of its own.
	 */
	#memoryScope(id: string, copyOf: string | null, majordomo: boolean): string {
		if (majordomo) return PRIVATE_SCOPE;
		if (copyOf !== null) {
			const [sibling] = this.#sql
				.exec("SELECT memory_scope FROM pim_agents WHERE is_default = 0 AND (copy_of = ? OR published = ?) ORDER BY created_at, rowid LIMIT 1", copyOf, copyOf)
				.toArray();
			if (sibling) return String(sibling.memory_scope);
		}
		return `agent-${id}`;
	}

	/**
	 * Agents once had teams: members with a name and instructions, which
	 * worked with their agent's apps and answered only it. Each member becomes
	 * an agent of its own, with its instructions and its agent's blueprint,
	 * apps, skills and app tool permissions, and one of its agent's contacts;
	 * its tasks, done and not, become the new agent's. A member's list of
	 * tools has no counterpart and is left behind.
	 */
	#moveTeams(): void {
		const tables = new Set(this.#sql.exec("SELECT name FROM sqlite_master WHERE type = 'table'").toArray().map((row) => String(row.name)));
		const taken = new Set(this.#sql.exec("SELECT role FROM pim_agents").toArray().map((row) => String(row.role).toLowerCase()));
		for (const row of this.#sql.exec("SELECT * FROM pim_agents WHERE team != '[]'").toArray()) {
			const team = JSON.parse(String(row.team)) as { name: string; instructions: string }[];
			const contacts = JSON.parse(String(row.contacts)) as string[];
			for (const member of team) {
				const name = freeName(member.name, String(row.name), taken);
				taken.add(name.toLowerCase());
				const id = newAgentId();
				const line = member.instructions.trim().split(/\r?\n/)[0] ?? "";
				this.#sql.exec(
					"INSERT INTO pim_agents (id, name, role, description, instructions, apps, skills, blueprint, color, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
					id,
					name,
					name,
					line.length > MAX_DESCRIPTION ? `${line.slice(0, MAX_DESCRIPTION - 1)}…` : line,
					member.instructions,
					row.apps,
					row.skills,
					row.blueprint,
					row.color,
					Date.now(),
					Date.now(),
				);
				contacts.push(id);
				if (tables.has("pim_tool_permissions")) {
					this.#sql.exec(
						"INSERT OR IGNORE INTO pim_tool_permissions (audience, app, tool, permission, definition, updated_at) SELECT ?, app, tool, permission, definition, updated_at FROM pim_tool_permissions WHERE audience = ?",
						`agent:${id}`,
						`agent:${row.id}`,
					);
				}
				if (tables.has("pim_tasks")) {
					this.#sql.exec("UPDATE pim_tasks SET kind = 'agent', agent = ?, member = NULL WHERE agent = ? AND member = ?", id, row.id, member.name);
					this.#sql.exec("INSERT OR REPLACE INTO pim_agent_sessions (session, agent) SELECT DISTINCT conversation, agent FROM pim_tasks WHERE agent = ?", id);
				}
			}
			this.#sql.exec("UPDATE pim_agents SET contacts = ?, team = '[]' WHERE id = ?", JSON.stringify(contacts), row.id);
		}
		// Tasks of members taken off their teams before, which no member is left to become, are their agent's.
		if (tables.has("pim_tasks")) this.#sql.exec("UPDATE pim_tasks SET kind = 'agent' WHERE kind = 'member'");
	}

	/** The majordomo first, then the others in the order they were made. */
	list(): Agent[] {
		this.majordomo();
		return this.#sql.exec(`${SELECT} ORDER BY p.is_default DESC, p.created_at, p.rowid`).toArray().map((row) => agentOf(row, this.#directory));
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

	/**
	 * Makes an agent. `copyOf` names the agent it copies, when it is a copy:
	 * a template's id, or `<template id>/<name>` for an agent that comes with
	 * a template; copies of one agent share a memory scope.
	 */
	create(input: AgentInput, source: Agent["source"] = null, copyOf: string | null = null): Agent {
		if (this.list().length >= MAX_AGENTS) throw new HttpError(429, `You can have up to ${MAX_AGENTS} agents.`);
		return this.#insert(input, source, false, copyOf);
	}

	/** Each of the person's agents has a role of its own, which is how others refer to it. */
	#checkRole(role: string, self: string | null): void {
		const [taken] = this.#sql.exec("SELECT name FROM pim_agents WHERE lower(role) = ? AND id IS NOT ?", role.toLowerCase(), self).toArray();
		if (taken) throw new HttpError(409, `You already have an agent for the role ${role}: ${String(taken.name)}. Each agent has a role of its own.`);
	}

	#insert(input: AgentInput, source: Agent["source"], isDefault: boolean, copyOf: string | null = null): Agent {
		if (!isDefault) this.#checkRole(input.role ?? input.name, null);
		const id = newAgentId();
		const now = Date.now();
		this.#sql.exec(
			"INSERT INTO pim_agents (id, name, role, description, instructions, apps, skills, contacts, memory_scope, memory_scopes, copy_of, blueprint, symbol, color, source, published, created_at, updated_at, is_default) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?, ?, ?)",
			id,
			input.name,
			isDefault ? MAJORDOMO_ROLE : (input.role ?? input.name),
			input.description,
			input.instructions,
			JSON.stringify(input.apps),
			JSON.stringify(input.skills),
			JSON.stringify(input.contacts),
			this.#memoryScope(id, copyOf, isDefault),
			JSON.stringify(input.memoryScopes ?? []),
			copyOf,
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
		const before = this.get(id);
		if (input.role !== undefined && !before?.majordomo && input.role.toLowerCase() !== before?.role.toLowerCase()) this.#checkRole(input.role, id);
		this.#sql.exec(
			"UPDATE pim_agents SET name = ?, role = COALESCE(?, role), description = ?, instructions = ?, apps = ?, skills = ?, contacts = ?, updated_at = ? WHERE id = ?",
			input.name,
			before?.majordomo ? null : (input.role ?? null),
			input.description,
			input.instructions,
			JSON.stringify(input.apps),
			JSON.stringify(input.skills),
			JSON.stringify(input.contacts),
			Date.now(),
			id,
		);
		if (input.blueprint !== undefined) this.#sql.exec("UPDATE pim_agents SET blueprint = ? WHERE id = ?", input.blueprint, id);
		if (input.symbol !== undefined) this.#sql.exec("UPDATE pim_agents SET symbol = ? WHERE id = ?", input.symbol, id);
		if (input.color !== undefined) this.#sql.exec("UPDATE pim_agents SET color = ? WHERE id = ?", input.color, id);
		if (input.memoryScopes !== undefined) this.#sql.exec("UPDATE pim_agents SET memory_scopes = ? WHERE id = ?", JSON.stringify(input.memoryScopes), id);
		return this.get(id)!;
	}

	/** Sets what its dashboard shows, checked by the space. */
	setDashboard(id: string, items: readonly string[], sizes: Readonly<Record<string, WidgetSize>>): Agent {
		this.#sql.exec("UPDATE pim_agents SET dashboard = ?, dashboard_sizes = ? WHERE id = ?", JSON.stringify(items), JSON.stringify(sizes), id);
		return this.get(id)!;
	}

	setPublished(id: string, template: string | null): void {
		this.#sql.exec("UPDATE pim_agents SET published = ? WHERE id = ?", template, id);
	}

	/** No agent reads a named memory scope any more, as when it is deleted. */
	dropMemoryScope(key: string): void {
		for (const agent of this.list()) {
			if (agent.memoryScopes.includes(key)) this.#sql.exec("UPDATE pim_agents SET memory_scopes = ? WHERE id = ?", JSON.stringify(agent.memoryScopes.filter((other) => other !== key)), agent.id);
		}
	}

	/** Deletes it; its chats stay, with the majordomo, and it leaves the contacts of the agents that had it. */
	delete(id: string): void {
		if (this.get(id)?.majordomo) throw new HttpError(400, "Your majordomo can't be deleted.");
		for (const agent of this.list()) {
			if (agent.contacts.includes(id)) this.#sql.exec("UPDATE pim_agents SET contacts = ? WHERE id = ?", JSON.stringify(agent.contacts.filter((other) => other !== id)), agent.id);
		}
		this.#sql.exec("DELETE FROM pim_agent_sessions WHERE agent = ?", id);
		this.#sql.exec("DELETE FROM pim_agent_icons WHERE agent = ?", id);
		this.#sql.exec("DELETE FROM pim_agents WHERE id = ?", id);
	}

	/** Sets its icon, an image of a type browsers show in a picture. */
	setIcon(id: string, type: string, data: ArrayBuffer): void {
		checkIcon(type, data.byteLength);
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

	/** Ties a chat, or a task's conversation, to the agent it is with. */
	setSession(session: string, agent: string): void {
		this.#sql.exec("INSERT INTO pim_agent_sessions (session, agent) VALUES (?, ?) ON CONFLICT (session) DO UPDATE SET agent = excluded.agent", session, agent);
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
