import { DurableObject } from "cloudflare:workers";
import pimConfig from "../pim.config";
import { isBuiltinApp } from "./builtin-apps";
import { HttpError } from "./http";
import { type Admission, ComputeLedger, type ComputeDeploymentUsage, type ComputeUsage, type EndReason } from "./compute-ledger";
import {
	type ComputeProvider,
	type ComputeProviderInput,
	type ComputeQuota,
	type ComputeSummary,
	computeSummary,
	DEFAULT_COMPUTE_QUOTA,
	parseComputeQuota,
	prepareComputeProvider,
	resolveQuota,
} from "./compute";
import { auditPoolWrite, comparePools, type SandboxPool, type SandboxPoolInput, prepareSandboxPool } from "./coding/pools";
import { DEFAULT_POOLS } from "./coding/pools-default";
import { type CustomProvider, MAX_PROVIDERS, type ProviderInput, prepareProvider } from "./providers";
import { appDirectory, type CustomApp, type DirectoryApp, findSiteIcon, storedApps } from "./extensions/app-directory";
import { APP_CATEGORIES, type AppCategory } from "./extensions/define";
import type { BotTool } from "./extensions/bot-tools";
import type { ArtifactFile, ArtifactKind } from "./artifacts";

/**
 * What the people on a Pim show each other: profiles, and the agents they
 * publish as templates for anyone to make their own. One Durable Object for
 * the instance, apart from the Directory, so browsing never touches accounts.
 *
 * A template is a copy of one of its author's agents when they published it:
 * its name, description, instructions, suggested connectors and look (its
 * symbol, color and uploaded icon), never their memory, conversations or
 * credentials. Its contacts come with it, and theirs: copies of the other
 * agents it hands tasks to, with their looks and uploaded icons, which
 * whoever makes it their own gets too.
 * Publishing again replaces it.
 *
 * People publish apps here too, the same way: a copy of one version,
 * which anyone can open and use, with their own storage, model and tools,
 * or make their own. Publishing again replaces it with the latest version.
 *
 * The admin also chooses an agent everyone starts with: a copy of one of
 * theirs, which each new account gets besides its majordomo; and adds connectors
 * anyone can connect besides the extensions' (`custom/<connector>`).
 *
 * And the admin shares bots: copies of their agents, kept like templates,
 * whose public link lets anyone join as a guest who chats with that bot
 * alone (./accounts.ts). Sharing again replaces the copy, which guests'
 * copies follow.
 */

export type Profile = {
	readonly username: string;
	readonly displayName: string | null;
	readonly bio: string | null;
};

/** Another of the author's agents that comes with one they publish: one of its contacts, or of theirs. */
export type BundledAgent = {
	readonly name: string;
	/** What it is for: how contacts name it among the agents that come with it. */
	readonly role: string;
	readonly description: string;
	readonly instructions: string;
	readonly apps: readonly string[];
	readonly symbol: string | null;
	readonly color: string | null;
	/** Its contacts, by role, among the agents that come with it. */
	readonly contacts: readonly string[];
	/** When its uploaded icon was published, to fetch it again when it changes; null without one. */
	readonly icon: number | null;
};

/** An agent's contacts as the gallery keeps them: their roles, and every agent that comes with it. */
export type Contacts = {
	/** Its own contacts, by role, among `bundle`. */
	readonly contacts: readonly string[];
	readonly bundle: readonly BundledAgent[];
};

export type Template = Contacts & {
	readonly id: string;
	/** The author's username. */
	readonly author: string;
	readonly authorName: string | null;
	/** The name the agent comes with, which its copies keep until their owners change it. */
	readonly name: string;
	readonly role: string;
	readonly description: string;
	readonly instructions: string;
	readonly apps: readonly string[];
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
export type DefaultAgent = Contacts & {
	/** The admin's username. */
	readonly author: string;
	/** Which of the admin's agents it is a copy of. */
	readonly agentId: string;
	readonly name: string;
	readonly role: string;
	readonly description: string;
	readonly instructions: string;
	readonly apps: readonly string[];
	readonly symbol: string | null;
	readonly color: string | null;
	/** Whether it has an uploaded icon, which each copy gets. */
	readonly icon: boolean;
	readonly updatedAt: number;
};

/** An uploaded icon, as an agent has one. */
export type AgentIcon = { readonly type: string; readonly data: ArrayBuffer };

/** One of an author's agents as the gallery copies it. */
export type PublishedAgent = Omit<Contacts, "bundle"> & {
	/** The agents that come with it, each with its uploaded icon. */
	readonly bundle: readonly (Omit<BundledAgent, "icon"> & { readonly image: AgentIcon | null })[];
	readonly id: string;
	readonly name: string;
	readonly role: string;
	readonly description: string;
	readonly instructions: string;
	readonly apps: readonly string[];
	readonly symbol: string | null;
	readonly color: string | null;
	readonly image: AgentIcon | null;
};

/** An app someone published: a copy of one of its versions. */
export type PublishedArtifact = {
	readonly id: string;
	/** The author's username. */
	readonly author: string;
	readonly authorName: string | null;
	/** Which of the author's apps it is a copy of, and which version. */
	readonly artifactId: string;
	readonly version: number;
	readonly title: string;
	readonly kind: ArtifactKind;
	readonly sha256: string;
	readonly size: number;
	readonly publishedAt: number;
	/** How many people made it their own. */
	readonly uses: number;
	/** Whether anyone with its link may see it, without an account, on the content origin. */
	readonly public: boolean;
};

/** An app as its author publishes it. */
export type ArtifactToPublish = {
	readonly id: string;
	readonly version: number;
	readonly title: string;
	readonly kind: ArtifactKind;
	/** Its files, whose bytes stay in R2 under the author's prefix. */
	readonly files: readonly ArtifactFile[];
	readonly sha256: string;
	readonly size: number;
};

/** One of the admin's agents, shared through a public link: anyone who opens it can join as a guest and chat with a copy. */
export type Bot = Contacts & {
	readonly id: string;
	/** The author's owner ID, which only the Worker reads. */
	readonly ownerId: string;
	/** The author's username. */
	readonly author: string;
	readonly authorName: string | null;
	/** Which of the author's agents it is a copy of. */
	readonly agentId: string;
	readonly name: string;
	readonly role: string;
	readonly description: string;
	readonly instructions: string;
	readonly apps: readonly string[];
	readonly symbol: string | null;
	readonly color: string | null;
	/** When its uploaded icon was shared, to fetch it again when it changes; null without one. */
	readonly icon: number | null;
	/** When it was last shared: guests' copies follow it when this changes. */
	readonly sharedAt: number;
	/** Messages each guest may send it in a UTC day; null for the deployment's own limit. */
	readonly dailyMessages: number | null;
	/** Tool calls each guest's copy may make in a UTC day, to its connectors and to the tools shared with it; null for the deployment's own limit. */
	readonly dailyToolCalls: number | null;
	/** The model guests' copies run on, one this Pim offers everyone; null for the deployment's default. */
	readonly model: BotModel | null;
	/** The tools it shares, which run in the author's space, as the author (./extensions/bot-tools.ts). */
	readonly tools: readonly BotTool[];
};

/** What the author chooses for a bot's guests when they share it. */
export type BotSettings = Pick<Bot, "dailyMessages" | "dailyToolCalls" | "model" | "tools">;

/** A model by provider and id, as an agent keeps it. */
export type BotModel = { readonly provider: string; readonly id: string };

/** What the public link shows of a bot: never its instructions. */
export type BotCard = Pick<Bot, "id" | "author" | "authorName" | "name" | "description" | "symbol" | "color" | "icon">;

/** A template in a list: everything but its instructions. */
export type TemplateSummary = Omit<Template, "instructions">;

export const MAX_DISPLAY_NAME = 50;
export const MAX_BIO = 280;
export const MAX_TEMPLATES = 20;
export const MAX_PUBLISHED_ARTIFACTS = 20;
export const MAX_APP_NAME = 40;
export const MAX_BOTS = 20;
/** The most messages a day a bot may let each guest send, and the most tool calls. */
export const MAX_DAILY_MESSAGES = 10_000;

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
CREATE TABLE IF NOT EXISTS bundle_icons (
	holder TEXT NOT NULL,
	position INTEGER NOT NULL,
	type TEXT NOT NULL,
	data BLOB NOT NULL,
	PRIMARY KEY (holder, position)
);
CREATE TABLE IF NOT EXISTS published_artifacts (
	id TEXT PRIMARY KEY,
	owner_id TEXT NOT NULL,
	username TEXT NOT NULL,
	artifact_id TEXT NOT NULL,
	version INTEGER NOT NULL,
	title TEXT NOT NULL,
	kind TEXT NOT NULL,
	files TEXT NOT NULL,
	sha256 TEXT NOT NULL,
	size INTEGER NOT NULL,
	published_at INTEGER NOT NULL,
	uses INTEGER NOT NULL DEFAULT 0,
	public INTEGER NOT NULL DEFAULT 0,
	UNIQUE (owner_id, artifact_id)
);
CREATE INDEX IF NOT EXISTS published_artifacts_by_author ON published_artifacts (username, published_at);
CREATE TABLE IF NOT EXISTS apps (
	id TEXT PRIMARY KEY,
	name TEXT NOT NULL,
	description TEXT NOT NULL,
	url TEXT NOT NULL UNIQUE,
	icon TEXT,
	category TEXT,
	created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS bots (
	id TEXT PRIMARY KEY,
	owner_id TEXT NOT NULL,
	username TEXT NOT NULL,
	agent_id TEXT NOT NULL,
	name TEXT NOT NULL,
	role TEXT NOT NULL,
	description TEXT NOT NULL,
	instructions TEXT NOT NULL,
	apps TEXT NOT NULL,
	contacts TEXT NOT NULL,
	bundle TEXT NOT NULL,
	symbol TEXT,
	color TEXT,
	icon_type TEXT,
	icon_data BLOB,
	shared_at INTEGER NOT NULL,
	daily_messages INTEGER,
	daily_tool_calls INTEGER,
	model TEXT,
	tools TEXT NOT NULL DEFAULT '[]',
	UNIQUE (owner_id, agent_id)
);
CREATE TABLE IF NOT EXISTS providers (
	id TEXT PRIMARY KEY,
	provider TEXT NOT NULL,
	created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS disabled_builtin_apps (
	id TEXT PRIMARY KEY
);
CREATE TABLE IF NOT EXISTS compute_providers (
	id TEXT PRIMARY KEY,
	provider TEXT NOT NULL,
	created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS compute_settings (
	key TEXT PRIMARY KEY,
	value TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS sandbox_pools (
	id TEXT PRIMARY KEY,
	pool TEXT NOT NULL,
	created_at INTEGER NOT NULL
);
`;

type Row = Record<string, SqlStorageValue>;

const optional = (value: SqlStorageValue | undefined) => (value === null || value === undefined ? null : String(value));

/**
 * The contacts kept with a template or the agent everyone starts with.
 * Published when agents had teams, its members come with it as agents of
 * their own, with its connectors.
 */
function contactsOf(row: Row, apps: readonly string[]): Contacts {
	const team = JSON.parse(String(row.team ?? "[]")) as { name: string; instructions: string }[];
	// Published before roles, an agent's name was its role.
	if (team.length === 0) {
		const bundle = JSON.parse(String(row.bundle ?? "[]")) as (Omit<BundledAgent, "role"> & { role?: string })[];
		return { contacts: JSON.parse(String(row.contacts ?? "[]")) as string[], bundle: bundle.map((agent) => ({ ...agent, role: agent.role ?? agent.name })) };
	}
	return {
		contacts: team.map((member) => member.name),
		bundle: team.map((member) => ({
			name: member.name,
			role: member.name,
			description: (member.instructions.trim().split(/\r?\n/)[0] ?? "").slice(0, MAX_BIO),
			instructions: member.instructions,
			apps,
			symbol: null,
			color: optional(row.color),
			contacts: [],
			icon: null,
		})),
	};
}

function templateOf(row: Row, directory: () => readonly DirectoryApp[]): Template {
	const apps = storedApps(JSON.parse(String(row.apps)) as unknown[], directory);
	return {
		id: String(row.id),
		author: String(row.username),
		authorName: optional(row.display_name),
		name: String(row.name),
		role: optional(row.role) ?? String(row.name),
		description: String(row.description),
		instructions: String(row.instructions),
		apps,
		...contactsOf(row, apps),
		symbol: optional(row.symbol),
		color: optional(row.color),
		icon: Number(row.has_icon) === 1 ? Number(row.published_at) : null,
		publishedAt: Number(row.published_at),
		uses: Number(row.uses),
	};
}

const summaryOf = (row: Row, directory: () => readonly DirectoryApp[]): TemplateSummary => {
	const { instructions: _instructions, ...summary } = templateOf(row, directory);
	return summary;
};

// Every column but the icon's bytes, which only its own route reads.
const WITH_AUTHOR =
	"SELECT t.id, t.owner_id, t.username, t.agent_id, t.name, t.role, t.description, t.instructions, t.apps, t.team, t.contacts, t.bundle, t.symbol, t.color, t.icon_data IS NOT NULL AS has_icon, t.published_at, t.uses, p.display_name FROM templates t LEFT JOIN profiles p ON p.owner_id = t.owner_id";

// Every column of a bot but its icon's bytes.
const BOT =
	"SELECT b.id, b.owner_id, b.username, b.agent_id, b.name, b.role, b.description, b.instructions, b.apps, b.contacts, b.bundle, b.symbol, b.color, b.icon_data IS NOT NULL AS has_icon, b.shared_at, b.daily_messages, b.daily_tool_calls, b.model, b.tools, p.display_name FROM bots b LEFT JOIN profiles p ON p.owner_id = b.owner_id";

function botOf(row: Row, directory: () => readonly DirectoryApp[]): Bot {
	const apps = storedApps(JSON.parse(String(row.apps)) as unknown[], directory);
	return {
		id: String(row.id),
		ownerId: String(row.owner_id),
		author: String(row.username),
		authorName: optional(row.display_name),
		agentId: String(row.agent_id),
		name: String(row.name),
		role: String(row.role),
		description: String(row.description),
		instructions: String(row.instructions),
		apps,
		...contactsOf(row, apps),
		symbol: optional(row.symbol),
		color: optional(row.color),
		icon: Number(row.has_icon) === 1 ? Number(row.shared_at) : null,
		sharedAt: Number(row.shared_at),
		dailyMessages: row.daily_messages === null ? null : Number(row.daily_messages),
		dailyToolCalls: row.daily_tool_calls === null ? null : Number(row.daily_tool_calls),
		model: row.model ? (JSON.parse(String(row.model)) as BotModel) : null,
		tools: JSON.parse(String(row.tools)) as BotTool[],
	};
}

// Every column but the files, which only opening one reads.
const PUBLISHED_ARTIFACT =
	"SELECT a.id, a.username, a.artifact_id, a.version, a.title, a.kind, a.sha256, a.size, a.published_at, a.uses, a.public, p.display_name FROM published_artifacts a LEFT JOIN profiles p ON p.owner_id = a.owner_id";

const publishedArtifactOf = (row: Row): PublishedArtifact => ({
	id: String(row.id),
	author: String(row.username),
	authorName: optional(row.display_name),
	artifactId: String(row.artifact_id),
	version: Number(row.version),
	title: String(row.title),
	kind: String(row.kind) as ArtifactKind,
	sha256: String(row.sha256),
	size: Number(row.size),
	publishedAt: Number(row.published_at),
	uses: Number(row.uses),
	public: Number(row.public) === 1,
});

/** The category the admin filed a connector under, or null for Other. */
function appCategory(value: unknown): AppCategory | null {
	if (value === undefined || value === null || value === "") return null;
	if (!APP_CATEGORIES.includes(value as AppCategory)) throw new HttpError(400, `category must be one of ${APP_CATEGORIES.join(", ")}`);
	return value as AppCategory;
}

/** An icon the admin gave: an https image URL, or null for none. */
function iconUrl(value: unknown): string | null {
	if (value === undefined || value === null || (typeof value === "string" && value.trim() === "")) return null;
	const url = typeof value === "string" ? value.trim() : "";
	if (!/^https:\/\/\S+$/.test(url) || url.length > 1000) throw new HttpError(400, "icon must be an https URL");
	return url;
}

function optionalText(value: unknown, field: string, max: number): string | null {
	if (value === null || value === undefined) return null;
	if (typeof value !== "string") throw new HttpError(400, `${field} must be a string`);
	const trimmed = value.trim();
	if (trimmed.length > max) throw new HttpError(400, `${field} must be at most ${max} characters`);
	return trimmed === "" ? null : trimmed;
}

/**
 * What the gallery keeps of an agent, in its columns' order from `name` to
 * `icon_data`; the uploaded icons of the agents that come with it are kept
 * apart (`#keepIcons`), and `published` is when, for the version of each.
 */
const copyOf = (agent: PublishedAgent, published: number) => [
	agent.name,
	agent.role,
	agent.description,
	agent.instructions,
	JSON.stringify(agent.apps),
	JSON.stringify(agent.contacts),
	JSON.stringify(agent.bundle.map(({ image, ...bundled }): BundledAgent => ({ ...bundled, icon: image ? published : null }))),
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
		// Agents were once personas: renamed in place, keeping the rows.
		const names = (query: string) => new Set(ctx.storage.sql.exec(query).toArray().map((row) => String(row.name)));
		const tables = names("SELECT name FROM sqlite_master WHERE type = 'table'");
		if (tables.has("default_pim") && !tables.has("default_agent")) ctx.storage.sql.exec("ALTER TABLE default_pim RENAME TO default_agent");
		for (const table of ["templates", "default_agent"]) {
			const columns = names(`PRAGMA table_info(${table})`);
			if (columns.has("persona_id")) ctx.storage.sql.exec(`ALTER TABLE ${table} RENAME COLUMN persona_id TO agent_id`);
		}
		ctx.storage.sql.exec(SCHEMA);
		const bots = names("PRAGMA table_info(bots)");
		if (!bots.has("model")) ctx.storage.sql.exec("ALTER TABLE bots ADD COLUMN model TEXT");
		if (!bots.has("daily_tool_calls")) ctx.storage.sql.exec("ALTER TABLE bots ADD COLUMN daily_tool_calls INTEGER");
		if (!bots.has("tools")) ctx.storage.sql.exec("ALTER TABLE bots ADD COLUMN tools TEXT NOT NULL DEFAULT '[]'");
		for (const table of ["templates", "default_agent"]) {
			const columns = ctx.storage.sql.exec(`PRAGMA table_info(${table})`).toArray().map((row) => String(row.name));
			if (!columns.includes("team")) ctx.storage.sql.exec(`ALTER TABLE ${table} ADD COLUMN team TEXT NOT NULL DEFAULT '[]'`);
			if (!columns.includes("role")) ctx.storage.sql.exec(`ALTER TABLE ${table} ADD COLUMN role TEXT`);
			for (const column of ["contacts", "bundle"]) {
				if (!columns.includes(column)) ctx.storage.sql.exec(`ALTER TABLE ${table} ADD COLUMN ${column} TEXT NOT NULL DEFAULT '[]'`);
			}
			for (const column of ["symbol", "color", "icon_type", "icon_data"]) {
				if (!columns.includes(column)) ctx.storage.sql.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${column === "icon_data" ? "BLOB" : "TEXT"}`);
			}
		}
	}

	#sql(query: string, ...bindings: unknown[]) {
		return this.ctx.storage.sql.exec(query, ...bindings);
	}

	/** The deployment's connectors, for templates that listed them by URL before the directory. */
	readonly #directory = () => appDirectory(pimConfig.extensions, this.customApps());

	/** The connectors the admin added, as they added them. */
	customApps(): CustomApp[] {
		return this.#sql("SELECT id, name, description, url, icon, category FROM apps ORDER BY created_at, id")
			.toArray()
			.map((row) => ({
				id: String(row.id),
				name: String(row.name),
				description: String(row.description),
				url: String(row.url),
				icon: optional(row.icon),
				category: optional(row.category) as AppCategory | null,
			}));
	}

	/** The admin adds a connector anyone on this Pim can connect: a remote MCP server, named `custom/<id>` after its name, with the icon they give or else its site's. */
	async addCustomApp(input: { name?: unknown; description?: unknown; url?: unknown; icon?: unknown; category?: unknown }): Promise<CustomApp> {
		const name = optionalText(input.name, "name", MAX_APP_NAME);
		if (name === null) throw new HttpError(400, "name is required");
		const description = optionalText(input.description, "description", MAX_BIO) ?? "";
		const url = typeof input.url === "string" ? input.url.trim() : "";
		if (!/^https:\/\/\S+$/.test(url) || url.length > 500) throw new HttpError(400, "url must be an https URL");
		const given = iconUrl(input.icon);
		const category = appCategory(input.category);
		const added = () => this.customApps().some((app) => app.url === url);
		if (added()) throw new HttpError(409, "A connector with that URL is already here");
		const icon = given ?? (await findSiteIcon(url));
		// Looking took a while: the same app may have been added since.
		if (added()) throw new HttpError(409, "A connector with that URL is already here");
		const base = name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 40) || "app";
		const taken = new Set(this.customApps().map((app) => app.id));
		let id = base;
		for (let n = 2; taken.has(id); n++) id = `${base}-${n}`;
		this.#sql(
			"INSERT INTO apps (id, name, description, url, icon, category, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
			id,
			name,
			description,
			url,
			icon,
			category,
			Date.now(),
		);
		return { id, name, description, url, icon, category };
	}

	/** The admin changes a connector's icon; with none given, its site's is looked up again. Null when there's no such connector. */
	async setCustomAppIcon(id: string, input: { icon?: unknown }): Promise<CustomApp | null> {
		const given = iconUrl(input.icon);
		const app = this.customApps().find((candidate) => candidate.id === id);
		if (!app) return null;
		const icon = given ?? (await findSiteIcon(app.url));
		if (this.#sql("UPDATE apps SET icon = ? WHERE id = ?", icon, id).rowsWritten === 0) return null;
		return { ...app, icon };
	}

	/** Takes a connector the admin added out of the directory. People's connections to it stay until they remove them. */
	removeCustomApp(id: string): boolean {
		return this.#sql("DELETE FROM apps WHERE id = ?", id).rowsWritten > 0;
	}

	/** The model providers the admin added for everyone, with their keys, for people's spaces to call (./providers.ts). */
	sharedProviders(): CustomProvider[] {
		return this.#sql("SELECT provider FROM providers ORDER BY created_at, id")
			.toArray()
			.map((row) => JSON.parse(String(row.provider)) as CustomProvider);
	}

	/** The admin adds a model provider everyone on this Pim can use, or changes one; it reads the provider's models again. Null when there's no such provider. */
	async putSharedProvider(id: string | null, input: ProviderInput): Promise<CustomProvider | null> {
		const providers = this.sharedProviders();
		const existing = id === null ? null : (providers.find((provider) => provider.id === id) ?? null);
		if (id !== null && !existing) return null;
		if (!existing && providers.length >= MAX_PROVIDERS) throw new HttpError(400, `This Pim can share up to ${MAX_PROVIDERS} providers.`);
		const provider = await prepareProvider(input, existing, new Set(providers.map((candidate) => candidate.id)));
		// Reading the models took a while: another may have been added, or this one removed, since.
		const now = this.sharedProviders().some((candidate) => candidate.id === provider.id);
		if (now !== (existing !== null)) throw new HttpError(409, existing ? "That provider was just removed." : "Another provider was just added: try again.");
		this.#sql(
			"INSERT INTO providers (id, provider, created_at) VALUES (?, ?, ?) ON CONFLICT (id) DO UPDATE SET provider = excluded.provider",
			provider.id,
			JSON.stringify(provider),
			Date.now(),
		);
		return provider;
	}

	/** Takes a provider away from everyone; their chats on its models go back to the default model. */
	removeSharedProvider(id: string): boolean {
		return this.#sql("DELETE FROM providers WHERE id = ?", id).rowsWritten > 0;
	}

	// Compute (./compute.ts): the providers the admin set up for everyone's coding sandboxes, the quotas on them, and what people have used.

	/** The compute providers, with their credentials, for the Durable Objects that make workspaces. No route shows these. */
	computeProviders(): ComputeProvider[] {
		return this.#sql("SELECT provider FROM compute_providers ORDER BY created_at, id")
			.toArray()
			.map((row) => JSON.parse(String(row.provider)) as ComputeProvider);
	}

	/** The compute providers without their credentials: what a space needs to know to say whether coding is on. */
	computeSummaries(): ComputeSummary[] {
		return this.computeProviders().map((provider) => computeSummary(provider, this.env));
	}

	/** The admin adds a compute provider, or changes the one of that kind: `id` is null to add. Null when there's no provider `id`. */
	putComputeProvider(id: string | null, input: ComputeProviderInput): ComputeProvider | null {
		const existing = id === null ? null : (this.computeProviders().find((provider) => provider.id === id) ?? null);
		if (id !== null && !existing) return null;
		const provider = prepareComputeProvider(input, existing);
		if (!existing && this.computeProviders().some((candidate) => candidate.id === provider.id)) {
			throw new HttpError(409, `${provider.name} is already set up: change it instead.`);
		}
		this.#sql(
			"INSERT INTO compute_providers (id, provider, created_at) VALUES (?, ?, ?) ON CONFLICT (id) DO UPDATE SET provider = excluded.provider",
			provider.id,
			JSON.stringify(provider),
			Date.now(),
		);
		return provider;
	}

	/** Takes a compute provider away. Workspaces already made on it go on until their threads stop them. */
	removeComputeProvider(id: string): boolean {
		return this.#sql("DELETE FROM compute_providers WHERE id = ?", id).rowsWritten > 0;
	}

	/** What each person may use of the compute unless the admin gave them their own. */
	computeQuota(): ComputeQuota {
		const [row] = this.#sql("SELECT value FROM compute_settings WHERE key = 'quota'").toArray();
		return resolveQuota(DEFAULT_COMPUTE_QUOTA, row ? (JSON.parse(String(row.value)) as Partial<ComputeQuota>) : null);
	}

	/** The admin changes the quota for everyone: the names given change, the rest stay. */
	setComputeQuota(change: unknown): ComputeQuota {
		const quota = resolveQuota(this.computeQuota(), parseComputeQuota(change));
		this.#sql("INSERT INTO compute_settings (key, value) VALUES ('quota', ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value", JSON.stringify(quota));
		return quota;
	}

	// Sandbox pools (./coding/pools.ts): the groups of coding sandboxes the admin keeps over the deployment's workspace providers, several pools to a provider. Kept here for placement to read: threads take slots by the registry, each pool's size its limit.

	#poolsSeeded = false;

	/**
	 * Puts the default pools in (./coding/pools-default.ts) the first time the
	 * registry is used, and never again: only while the table is empty, so the
	 * admin's changes stay theirs, even emptying the registry.
	 */
	#seedSandboxPools(): void {
		if (this.#poolsSeeded) return;
		this.#poolsSeeded = true;
		if (this.#sql("SELECT 1 FROM compute_settings WHERE key = 'sandbox_pools_seeded'").toArray().length) return;
		if (!this.#sql("SELECT 1 FROM sandbox_pools").toArray().length) {
			const now = Date.now();
			for (const pool of DEFAULT_POOLS) this.#sql("INSERT INTO sandbox_pools (id, pool, created_at) VALUES (?, ?, ?)", pool.id, JSON.stringify(pool), now);
		}
		this.#sql("INSERT INTO compute_settings (key, value) VALUES ('sandbox_pools_seeded', '1')");
	}

	/** The sandbox pools in the order they stand: the lowest priority first, ties by id. */
	sandboxPools(): SandboxPool[] {
		this.#seedSandboxPools();
		return this.#sql("SELECT pool FROM sandbox_pools")
			.toArray()
			.map((row) => JSON.parse(String(row.pool)) as SandboxPool)
			.sort(comparePools);
	}

	/** One sandbox pool, or null when there is none with that id. */
	sandboxPool(id: string): SandboxPool | null {
		this.#seedSandboxPools();
		const [row] = this.#sql("SELECT pool FROM sandbox_pools WHERE id = ?", id).toArray();
		return row ? (JSON.parse(String(row.pool)) as SandboxPool) : null;
	}

	/**
	 * The admin adds a sandbox pool, or changes the one with that id: `id` is
	 * null to add. Null when there is no pool `id`. Every write is kept in the
	 * admin's audit trail, by `by` (the admin's owner id).
	 */
	upsertSandboxPool(id: string | null, input: SandboxPoolInput, by: string): SandboxPool | null {
		this.#seedSandboxPools();
		const existing = id === null ? null : this.sandboxPool(id);
		if (id !== null && !existing) return null;
		const pool = prepareSandboxPool(input, existing);
		if (!existing && this.sandboxPool(pool.id)) throw new HttpError(409, `The pool ${pool.id} is already here: change it instead.`);
		this.#sql(
			"INSERT INTO sandbox_pools (id, pool, created_at) VALUES (?, ?, ?) ON CONFLICT (id) DO UPDATE SET pool = excluded.pool",
			pool.id,
			JSON.stringify(pool),
			Date.now(),
		);
		auditPoolWrite(existing ? "changed" : "added", pool.id, by);
		return pool;
	}

	/** Takes a sandbox pool away. Threads already running in it go on until they stop. Every write is kept in the admin's audit trail, by `by`. */
	removeSandboxPool(id: string, by: string): boolean {
		this.#seedSandboxPools();
		const removed = this.#sql("DELETE FROM sandbox_pools WHERE id = ?", id).rowsWritten > 0;
		if (removed) auditPoolWrite("removed", id, by);
		return removed;
	}

	/** A workspace is about to run: checks the person's quota and records the start, together (./compute-ledger.ts). A null quota records without checking. */
	computeBegin(o: { userId: string; threadId: string; provider: string; quota: ComputeQuota | null; now?: number }): Admission {
		return this.#ledger().begin({ ...o, now: o.now ?? Date.now() });
	}

	/** A workspace moves to a new session: ends its stretch and begins the next, checking the quota, in one step (`ComputeLedger.renew`). */
	computeRenew(o: { userId: string; threadId: string; provider: string; quota: ComputeQuota | null; now?: number }): Admission {
		return this.#ledger().renew({ ...o, now: o.now ?? Date.now() });
	}

	/** Forgets what a person's sandboxes ran, for an erased account. */
	computeForget(userId: string): void {
		this.#ledger().forget(userId);
	}

	/** The thread's workspace as the ledger has it running (its stop time, if it has a limit), or null. */
	computeOpen(threadId: string): { capAt: number | null } | null {
		return this.#ledger().open(threadId);
	}

	/** Ends the running stretches of threads named `prefix…` that aren't in `keep`: for a space to clear what its crash left. */
	computeEndExcept(prefix: string, keep: string[], reason: EndReason, now = Date.now()): number {
		return this.#ledger().endExcept(prefix, keep, reason, now);
	}

	/** A thread's workspace stopped running. */
	computeEnd(threadId: string, reason: EndReason, now = Date.now()): boolean {
		return this.#ledger().end(threadId, reason, now);
	}

	/** One person's sandbox minutes this month, by provider, and the months before. */
	computeUsageOf(userId: string, now = Date.now()): ComputeUsage {
		return this.#ledger().usage(userId, now);
	}

	/** Everyone's sandbox minutes this month, for the admin. */
	computeUsage(now = Date.now()): ComputeDeploymentUsage {
		return this.#ledger().deployment(now);
	}

	#ledgerOf: ComputeLedger | undefined;
	#ledger(): ComputeLedger {
		return (this.#ledgerOf ??= new ComputeLedger(this.ctx.storage.sql));
	}

	/** The built-in apps (../builtin-apps.ts) the admin turned off for everyone. */
	disabledBuiltinApps(): string[] {
		return this.#sql("SELECT id FROM disabled_builtin_apps ORDER BY id")
			.toArray()
			.map((row) => String(row.id))
			.filter(isBuiltinApp);
	}

	/** The admin turns a built-in app on or off for everyone. False when Pim has no such app. */
	setBuiltinApp(id: string, enabled: boolean): boolean {
		if (!isBuiltinApp(id)) return false;
		if (enabled) this.#sql("DELETE FROM disabled_builtin_apps WHERE id = ?", id);
		else this.#sql("INSERT OR IGNORE INTO disabled_builtin_apps (id) VALUES (?)", id);
		return true;
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
		const now = Date.now();
		this.#sql(
			`INSERT INTO templates (id, owner_id, username, agent_id, name, role, description, instructions, apps, contacts, bundle, symbol, color, icon_type, icon_data, published_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
			ON CONFLICT (id) DO UPDATE SET name = excluded.name, role = excluded.role, description = excluded.description, instructions = excluded.instructions, apps = excluded.apps, team = '[]', contacts = excluded.contacts, bundle = excluded.bundle,
			symbol = excluded.symbol, color = excluded.color, icon_type = excluded.icon_type, icon_data = excluded.icon_data, published_at = excluded.published_at`,
			id,
			ownerId,
			username,
			agent.id,
			...copyOf(agent, now),
			now,
		);
		this.#keepIcons(id, agent);
		return this.template(id)!;
	}

	/** A template's uploaded icon, if it was published with one. */
	templateIcon(id: string): AgentIcon | null {
		return iconOf(this.#sql("SELECT icon_type, icon_data FROM templates WHERE id = ?", id).toArray()[0]);
	}

	/**
	 * The uploaded icons of the agents that come with a template, or with the
	 * agent everyone starts with (`default`), by their place in its bundle.
	 */
	bundleIcons(holder: string): (AgentIcon | null)[] {
		const icons: (AgentIcon | null)[] = [];
		for (const row of this.#sql("SELECT position, type, data FROM bundle_icons WHERE holder = ?", holder).toArray()) {
			icons[Number(row.position)] = { type: String(row.type), data: row.data as ArrayBuffer };
		}
		return Array.from(icons, (icon) => icon ?? null);
	}

	/** The uploaded icon of one of the agents that come with a template, if it has one. */
	bundleIcon(holder: string, position: number): AgentIcon | null {
		const [row] = this.#sql("SELECT type, data FROM bundle_icons WHERE holder = ? AND position = ?", holder, position).toArray();
		return row ? { type: String(row.type), data: row.data as ArrayBuffer } : null;
	}

	/** Keeps the uploaded icons of the agents that come with what `holder` published, in place of those it had. */
	#keepIcons(holder: string, agent: PublishedAgent): void {
		this.#sql("DELETE FROM bundle_icons WHERE holder = ?", holder);
		for (const [position, { image }] of agent.bundle.entries()) {
			if (image) this.#sql("INSERT INTO bundle_icons (holder, position, type, data) VALUES (?, ?, ?, ?)", holder, position, image.type, image.data);
		}
	}

	/** Forgets the icons of templates and bots no longer shared, and of an agent everyone starts with no longer chosen. */
	#pruneIcons(): void {
		this.#sql(
			"DELETE FROM bundle_icons WHERE (holder = 'default' AND NOT EXISTS (SELECT 1 FROM default_agent)) OR (holder != 'default' AND holder NOT IN (SELECT id FROM templates) AND holder NOT IN (SELECT id FROM bots))",
		);
	}

	/** Takes one of the author's agents out of the gallery. False when it wasn't published. */
	unpublish(ownerId: string, agentId: string): boolean {
		const removed = this.#sql("DELETE FROM templates WHERE owner_id = ? AND agent_id = ?", ownerId, agentId).rowsWritten > 0;
		this.#pruneIcons();
		return removed;
	}

	template(id: string): Template | null {
		const [row] = this.#sql(`${WITH_AUTHOR} WHERE t.id = ?`, id).toArray();
		return row ? templateOf(row, this.#directory) : null;
	}

	/** Templates, most used first; matching `query` in their name, description or author, or by one author. */
	templates(options: { query?: string; author?: string; limit?: number } = {}): TemplateSummary[] {
		const limit = Math.min(Math.max(options.limit ?? 50, 1), 100);
		if (options.author) {
			return this.#sql(`${WITH_AUTHOR} WHERE t.username = ? ORDER BY t.published_at DESC LIMIT ?`, options.author, limit)
				.toArray()
				.map((row) => summaryOf(row, this.#directory));
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
				.map((row) => summaryOf(row, this.#directory));
		}
		return this.#sql(`${WITH_AUTHOR} ORDER BY t.uses DESC, t.published_at DESC LIMIT ?`, limit).toArray().map((row) => summaryOf(row, this.#directory));
	}

	/** Someone made a template their own. */
	used(id: string): void {
		this.#sql("UPDATE templates SET uses = uses + 1 WHERE id = ?", id);
	}

	/** The operator takes a template down. */
	remove(id: string): boolean {
		const removed = this.#sql("DELETE FROM templates WHERE id = ?", id).rowsWritten > 0;
		this.#pruneIcons();
		return removed;
	}

	/**
	 * Publishes the latest version of one of the author's apps, or
	 * replaces what was published of it. `open` says whether anyone with its
	 * link may see it too; left out, that stays as it was (no, at first).
	 */
	publishArtifact(ownerId: string, username: string, artifact: ArtifactToPublish, open?: boolean): PublishedArtifact {
		const [known] = this.#sql("SELECT id, public FROM published_artifacts WHERE owner_id = ? AND artifact_id = ?", ownerId, artifact.id).toArray();
		if (!known) {
			const count = Number(this.#sql("SELECT COUNT(*) AS n FROM published_artifacts WHERE owner_id = ?", ownerId).one().n);
			if (count >= MAX_PUBLISHED_ARTIFACTS) throw new HttpError(429, `You can publish up to ${MAX_PUBLISHED_ARTIFACTS} apps.`);
		}
		const id = known ? String(known.id) : `pa_${crypto.randomUUID().replaceAll("-", "").slice(0, 16)}`;
		this.#sql(
			`INSERT INTO published_artifacts (id, owner_id, username, artifact_id, version, title, kind, files, sha256, size, published_at, public) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
			ON CONFLICT (id) DO UPDATE SET version = excluded.version, title = excluded.title, kind = excluded.kind, files = excluded.files, sha256 = excluded.sha256,
			size = excluded.size, published_at = excluded.published_at, public = ?`,
			id,
			ownerId,
			username,
			artifact.id,
			artifact.version,
			artifact.title,
			artifact.kind,
			JSON.stringify(artifact.files),
			artifact.sha256,
			artifact.size,
			Date.now(),
			open ? 1 : 0,
			open === undefined ? (known ? Number(known.public) : 0) : open ? 1 : 0,
		);
		return this.publishedArtifact(id)!;
	}

	/** Takes one of the author's apps out of the gallery. False when it wasn't published. */
	unpublishArtifact(ownerId: string, artifactId: string): boolean {
		return this.#sql("DELETE FROM published_artifacts WHERE owner_id = ? AND artifact_id = ?", ownerId, artifactId).rowsWritten > 0;
	}

	/** What the author published of one of their apps, if they did. */
	publishedArtifactOf(ownerId: string, artifactId: string): PublishedArtifact | null {
		const [row] = this.#sql(`${PUBLISHED_ARTIFACT} WHERE a.owner_id = ? AND a.artifact_id = ?`, ownerId, artifactId).toArray();
		return row ? publishedArtifactOf(row) : null;
	}

	publishedArtifact(id: string): PublishedArtifact | null {
		const [row] = this.#sql(`${PUBLISHED_ARTIFACT} WHERE a.id = ?`, id).toArray();
		return row ? publishedArtifactOf(row) : null;
	}

	/** A published app's files, and whose prefix in R2 they're under. */
	publishedFiles(id: string): { owner: string; files: ArtifactFile[] } | null {
		const [row] = this.#sql("SELECT owner_id, files FROM published_artifacts WHERE id = ?", id).toArray();
		return row ? { owner: String(row.owner_id), files: JSON.parse(String(row.files)) as ArtifactFile[] } : null;
	}

	/** A published app anyone with its link may see, with its files; null for any other id. */
	publicArtifact(id: string): { kind: ArtifactKind; title: string; owner: string; files: ArtifactFile[] } | null {
		const [row] = this.#sql("SELECT kind, title, owner_id, files FROM published_artifacts WHERE id = ? AND public = 1", id).toArray();
		return row
			? { kind: String(row.kind) as ArtifactKind, title: String(row.title), owner: String(row.owner_id), files: JSON.parse(String(row.files)) as ArtifactFile[] }
			: null;
	}

	/** Published apps, most used first; matching `query` in their title or author, or by one author. */
	publishedArtifacts(options: { query?: string; author?: string; limit?: number } = {}): PublishedArtifact[] {
		const limit = Math.min(Math.max(options.limit ?? 50, 1), 100);
		if (options.author) {
			return this.#sql(`${PUBLISHED_ARTIFACT} WHERE a.username = ? ORDER BY a.published_at DESC LIMIT ?`, options.author, limit)
				.toArray()
				.map(publishedArtifactOf);
		}
		const query = options.query?.trim().toLowerCase();
		if (query) {
			const like = `%${query.replace(/[\\%_]/g, (character) => `\\${character}`)}%`;
			return this.#sql(
				`${PUBLISHED_ARTIFACT} WHERE lower(a.title) LIKE ? ESCAPE '\\' OR a.username LIKE ? ESCAPE '\\' OR lower(coalesce(p.display_name, '')) LIKE ? ESCAPE '\\' ORDER BY a.uses DESC, a.published_at DESC LIMIT ?`,
				like,
				like,
				like,
				limit,
			)
				.toArray()
				.map(publishedArtifactOf);
		}
		return this.#sql(`${PUBLISHED_ARTIFACT} ORDER BY a.uses DESC, a.published_at DESC LIMIT ?`, limit).toArray().map(publishedArtifactOf);
	}

	/** Someone made a published app their own. */
	artifactUsed(id: string): void {
		this.#sql("UPDATE published_artifacts SET uses = uses + 1 WHERE id = ?", id);
	}

	/** The operator takes a published app down. */
	removeArtifact(id: string): boolean {
		return this.#sql("DELETE FROM published_artifacts WHERE id = ?", id).rowsWritten > 0;
	}

	/**
	 * Shares one of the author's agents as a bot, or replaces what was shared
	 * of it, with how many messages a day each guest may send it, how many
	 * tool calls it may make for each, the model guests use and the tools it
	 * shares, which the author's space checked.
	 */
	shareBot(ownerId: string, username: string, agent: PublishedAgent, { dailyMessages, dailyToolCalls, model, tools }: BotSettings): Bot {
		if (dailyMessages !== null && !(Number.isSafeInteger(dailyMessages) && dailyMessages >= 1 && dailyMessages <= MAX_DAILY_MESSAGES)) {
			throw new HttpError(400, `dailyMessages must be a whole number from 1 to ${MAX_DAILY_MESSAGES}, or null for this Pim's own limit`);
		}
		if (dailyToolCalls !== null && !(Number.isSafeInteger(dailyToolCalls) && dailyToolCalls >= 0 && dailyToolCalls <= MAX_DAILY_MESSAGES)) {
			throw new HttpError(400, `dailyToolCalls must be a whole number from 0 to ${MAX_DAILY_MESSAGES}, or null for this Pim's own limit`);
		}
		const [known] = this.#sql("SELECT id FROM bots WHERE owner_id = ? AND agent_id = ?", ownerId, agent.id).toArray();
		if (!known && Number(this.#sql("SELECT COUNT(*) AS n FROM bots WHERE owner_id = ?", ownerId).one().n) >= MAX_BOTS) {
			throw new HttpError(429, `You can share up to ${MAX_BOTS} bots.`);
		}
		const id = known ? String(known.id) : `b_${crypto.randomUUID().replaceAll("-", "").slice(0, 16)}`;
		const now = Date.now();
		this.#sql(
			`INSERT INTO bots (id, owner_id, username, agent_id, name, role, description, instructions, apps, contacts, bundle, symbol, color, icon_type, icon_data, shared_at, daily_messages, daily_tool_calls, model, tools) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
			ON CONFLICT (id) DO UPDATE SET name = excluded.name, role = excluded.role, description = excluded.description, instructions = excluded.instructions, apps = excluded.apps, contacts = excluded.contacts, bundle = excluded.bundle,
			symbol = excluded.symbol, color = excluded.color, icon_type = excluded.icon_type, icon_data = excluded.icon_data, shared_at = excluded.shared_at, daily_messages = excluded.daily_messages, daily_tool_calls = excluded.daily_tool_calls, model = excluded.model, tools = excluded.tools`,
			id,
			ownerId,
			username,
			agent.id,
			...copyOf(agent, now),
			now,
			dailyMessages,
			dailyToolCalls,
			model && JSON.stringify({ provider: model.provider, id: model.id }),
			JSON.stringify(tools),
		);
		this.#keepIcons(id, agent);
		return this.bot(id)!;
	}

	bot(id: string): Bot | null {
		const [row] = this.#sql(`${BOT} WHERE b.id = ?`, id).toArray();
		return row ? botOf(row, this.#directory) : null;
	}

	/** What the author shared of one of their agents, if they did. */
	botOf(ownerId: string, agentId: string): Bot | null {
		const [row] = this.#sql(`${BOT} WHERE b.owner_id = ? AND b.agent_id = ?`, ownerId, agentId).toArray();
		return row ? botOf(row, this.#directory) : null;
	}

	/** A bot's uploaded icon, if it was shared with one. */
	botIcon(id: string): AgentIcon | null {
		return iconOf(this.#sql("SELECT icon_type, icon_data FROM bots WHERE id = ?", id).toArray()[0]);
	}

	/** Turns a bot's link off. Its guests keep their accounts and chats, and can't send it anything more. */
	unshareBot(ownerId: string, agentId: string): boolean {
		const removed = this.#sql("DELETE FROM bots WHERE owner_id = ? AND agent_id = ?", ownerId, agentId).rowsWritten > 0;
		this.#pruneIcons();
		return removed;
	}

	/** The agent everyone starts with besides their majordomo; null when the admin chose none. */
	defaultAgent(): DefaultAgent | null {
		const [row] = this.#sql("SELECT * FROM default_agent WHERE id = 1").toArray();
		if (!row) return null;
		const apps = storedApps(JSON.parse(String(row.apps)) as unknown[], this.#directory);
		return {
			author: String(row.username),
			agentId: String(row.agent_id),
			name: String(row.name),
			role: optional(row.role) ?? String(row.name),
			description: String(row.description),
			instructions: String(row.instructions),
			apps,
			...contactsOf(row, apps),
			symbol: optional(row.symbol),
			color: optional(row.color),
			icon: row.icon_data !== null,
			updatedAt: Number(row.updated_at),
		};
	}

	/** The admin makes a copy of one of their agents the one everyone starts with. Choosing again replaces it. */
	setDefaultAgent(ownerId: string, username: string, agent: PublishedAgent): DefaultAgent {
		const now = Date.now();
		this.#sql(
			`INSERT INTO default_agent (id, owner_id, username, agent_id, name, role, description, instructions, apps, contacts, bundle, symbol, color, icon_type, icon_data, updated_at) VALUES (1, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
			ON CONFLICT (id) DO UPDATE SET owner_id = excluded.owner_id, username = excluded.username, agent_id = excluded.agent_id, name = excluded.name, role = excluded.role,
			description = excluded.description, instructions = excluded.instructions, apps = excluded.apps, team = '[]', contacts = excluded.contacts, bundle = excluded.bundle,
			symbol = excluded.symbol, color = excluded.color, icon_type = excluded.icon_type, icon_data = excluded.icon_data, updated_at = excluded.updated_at`,
			ownerId,
			username,
			agent.id,
			...copyOf(agent, now),
			now,
		);
		this.#keepIcons("default", agent);
		return this.defaultAgent()!;
	}

	/** The uploaded icon of the agent everyone starts with, if it has one. */
	defaultAgentIcon(): AgentIcon | null {
		return iconOf(this.#sql("SELECT icon_type, icon_data FROM default_agent WHERE id = 1").toArray()[0]);
	}

	/** Back to a plain agent for everyone who joins. False when none was chosen. */
	clearDefaultAgent(): boolean {
		const cleared = this.#sql("DELETE FROM default_agent").rowsWritten > 0;
		this.#pruneIcons();
		return cleared;
	}

	/** Forgets a person: their profile, everything they published (agents and apps) or shared (bots), and the agent everyone starts with if it was theirs. Run when their account is deleted. */
	forgetOwner(ownerId: string): void {
		this.#sql("DELETE FROM templates WHERE owner_id = ?", ownerId);
		this.#sql("DELETE FROM published_artifacts WHERE owner_id = ?", ownerId);
		this.#sql("DELETE FROM profiles WHERE owner_id = ?", ownerId);
		this.#sql("DELETE FROM default_agent WHERE owner_id = ?", ownerId);
		this.#sql("DELETE FROM bots WHERE owner_id = ?", ownerId);
		this.#pruneIcons();
	}

	/** Whether anything of the owner is left: a deletion is done only once nothing is. */
	holds(ownerId: string): boolean {
		return (
			this.#sql(
				"SELECT 1 FROM profiles WHERE owner_id = ? UNION SELECT 1 FROM templates WHERE owner_id = ? UNION SELECT 1 FROM published_artifacts WHERE owner_id = ? UNION SELECT 1 FROM default_agent WHERE owner_id = ? UNION SELECT 1 FROM bots WHERE owner_id = ? LIMIT 1",
				ownerId,
				ownerId,
				ownerId,
				ownerId,
				ownerId,
			).toArray().length > 0
		);
	}
}
