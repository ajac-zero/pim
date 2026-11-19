import type { Principal } from "@pim/v2-contracts/identity";
import { Authorizer } from "./authz.ts";
import type { Db, Tx } from "./db.ts";
import { BadRequestError, ConflictError, NotFoundError } from "./errors.ts";
import { newId } from "./ids.ts";

export type Agent = {
	id: string;
	name: string;
	instructions: string;
	emoji: string | null;
	color: string | null;
	icon: string | null;
	model: { provider: string; id: string } | null;
	fallbacks: { provider: string; id: string }[];
	skills: string[];
	apps: string[];
	/** Other agents it may mention and hand work to. */
	contacts: string[];
	delegates: string[];
	/** The scope it writes its memories to and reads: `agent-<id>` unless its config names another (the majordomo of a migrated space writes to `private`). */
	memoryScope: string;
	/** The named scopes (`pim_app.memory_scopes`) it also reads. */
	memoryScopes: string[];
	adoptedFrom: string | null;
	createdAt: Date;
};

export type AgentInput = Partial<Pick<Agent, "name" | "instructions" | "emoji" | "color" | "icon" | "model" | "fallbacks" | "skills" | "apps" | "contacts" | "delegates" | "memoryScopes">>;

/** Every scope an agent reads: its own, the named ones it was given, and everyone's. */
export const readScopes = (a: Pick<Agent, "memoryScope" | "memoryScopes">): string[] => [...new Set([a.memoryScope, ...a.memoryScopes, "everyone"])];

const COLOR = /^#[0-9a-fA-F]{6}$|^[a-z]{3,20}$/;
const strings = (v: unknown, what: string): string[] => {
	if (v === undefined) return [];
	if (!Array.isArray(v) || v.some((x) => typeof x !== "string")) throw new BadRequestError(`${what} must be a list of names`);
	return [...new Set(v as string[])];
};
const modelRef = (v: unknown, what: string) => {
	if (v === null || v === undefined) return null;
	const m = v as { provider?: unknown; id?: unknown };
	if (typeof m.provider !== "string" || typeof m.id !== "string") throw new BadRequestError(`${what} is { provider, id }`);
	return { provider: m.provider, id: m.id };
};

const rowToAgent = (r: any): Agent => ({
	id: r.id, name: r.name, instructions: r.instructions, emoji: r.emoji, color: r.color, icon: r.icon_key,
	model: r.config.model ?? null, fallbacks: r.config.fallbacks ?? [], skills: r.config.skills ?? [], apps: r.config.apps ?? [],
	contacts: r.config.contacts ?? [], delegates: r.config.delegates ?? [],
	memoryScope: r.config.memoryScope ?? `agent-${r.id}`, memoryScopes: r.config.memoryScopes ?? [], adoptedFrom: r.adopted_from, createdAt: r.created_at,
});

/**
 * Agents and the skills they use. An agent's model, fallbacks, skills, connectors, contacts and delegates live in its config; what people see
 * (name, emoji, color, icon) are columns. Contacts and delegates must be agents of the same owner, so an agent cannot reach outside its space.
 */
export class Agents {
	constructor(private readonly db: Db, private readonly authz = new Authorizer(db)) {}

	async #config(tx: Tx, ownerId: string, input: AgentInput, base: Record<string, unknown> = {}): Promise<Record<string, unknown>> {
		const config = { ...base };
		if (input.model !== undefined) config.model = modelRef(input.model, "model");
		if (input.fallbacks !== undefined) config.fallbacks = (input.fallbacks as unknown[]).map((m) => modelRef(m, "fallbacks")!);
		if (input.apps !== undefined) config.apps = strings(input.apps, "apps");
		if (input.skills !== undefined) {
			const names = strings(input.skills, "skills");
			const have = new Set((await tx.query("SELECT name FROM pim_app.skills WHERE name = ANY($1)", [names])).rows.map((r) => r.name));
			const missing = names.filter((n) => !have.has(n));
			if (missing.length) throw new BadRequestError(`No such skill: ${missing.join(", ")}`);
			config.skills = names;
		}
		if (input.memoryScopes !== undefined) {
			const keys = strings(input.memoryScopes, "memoryScopes");
			const have = new Set((await tx.query("SELECT key FROM pim_app.memory_scopes WHERE key = ANY($1)", [keys])).rows.map((r) => r.key));
			const missing = keys.filter((k) => !have.has(k));
			if (missing.length) throw new BadRequestError(`No such memory scope: ${missing.join(", ")}`);
			config.memoryScopes = keys;
		}
		for (const key of ["contacts", "delegates"] as const) {
			if (input[key] === undefined) continue;
			const ids = strings(input[key], key);
			const have = new Set((await tx.query("SELECT id FROM pim_app.agents WHERE id = ANY($1) AND deleted_at IS NULL", [ids])).rows.map((r) => r.id));
			const missing = ids.filter((i) => !have.has(i));
			if (missing.length) throw new BadRequestError(`${key} must be your own agents: ${missing.join(", ")}`);
			config[key] = ids;
		}
		return config;
	}

	#check(input: AgentInput) {
		if (input.name !== undefined && (typeof input.name !== "string" || !input.name.trim() || input.name.length > 60)) throw new BadRequestError("An agent needs a name of up to 60 characters");
		if (input.instructions !== undefined && (typeof input.instructions !== "string" || input.instructions.length > 20_000)) throw new BadRequestError("Instructions are up to 20,000 characters");
		if (input.color != null && !COLOR.test(input.color)) throw new BadRequestError("color is a #rrggbb value or a color name");
		if (input.emoji != null && [...String(input.emoji)].length > 4) throw new BadRequestError("emoji is one emoji");
	}

	async create(p: Principal, input: AgentInput & { name: string }): Promise<Agent> {
		await this.authz.enforce(p, "api:write");
		this.#check(input);
		const id = newId("a");
		return this.db.owner(p.ownerId, async (tx) => {
			const config = await this.#config(tx, p.ownerId, input);
			await tx.query("INSERT INTO pim_app.agents (id, owner_id, name, instructions, config, emoji, color, icon_key) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)", [id, p.ownerId, input.name.trim(), input.instructions ?? "", JSON.stringify(config), input.emoji ?? null, input.color ?? null, input.icon ?? null]);
			return rowToAgent((await tx.query("SELECT * FROM pim_app.agents WHERE id = $1", [id])).rows[0]);
		});
	}

	async list(p: Principal): Promise<Agent[]> {
		await this.authz.enforce(p, "api:read");
		return this.db.owner(p.ownerId, async (tx) => (await tx.query("SELECT * FROM pim_app.agents WHERE deleted_at IS NULL ORDER BY created_at")).rows.map(rowToAgent));
	}

	/**
	 * Where an agent writes its memories and what it reads. A chat with no agent is answered by the person's majordomo (`pim_app.majordomo_id()`); with none, only
	 * `everyone` is shared. The majordomo reads every scope there is, as in v1, and still writes to its own.
	 */
	async memoryOf(p: Principal, agentId: string | null): Promise<{ own: string; reads: string[] }> {
		await this.authz.enforce(p, "api:read");
		return this.db.owner(p.ownerId, async (tx) => {
			const row = (await tx.query("SELECT *, id = pim_app.majordomo_id() AS majordomo FROM pim_app.agents WHERE deleted_at IS NULL AND id = coalesce($1, pim_app.majordomo_id())", [agentId])).rows[0];
			if (!row) return { own: "everyone", reads: ["everyone"] };
			const agent = rowToAgent(row);
			if (!row.majordomo) return { own: agent.memoryScope, reads: readScopes(agent) };
			const every = (await tx.query("SELECT config->>'memoryScope' AS own, a.id FROM pim_app.agents a WHERE deleted_at IS NULL")).rows.map((r) => (r.own ?? `agent-${r.id}`) as string);
			const named = (await tx.query("SELECT key FROM pim_app.memory_scopes")).rows.map((r) => r.key as string);
			const kept = (await tx.query("SELECT DISTINCT scope FROM pim_app.memories WHERE deleted_at IS NULL")).rows.map((r) => r.scope as string);
			return { own: agent.memoryScope, reads: [...new Set([...readScopes(agent), ...every, ...named, ...kept])] };
		});
	}

	async get(p: Principal, id: string): Promise<Agent> {
		await this.authz.enforce(p, "api:read");
		return this.db.owner(p.ownerId, async (tx) => {
			const r = (await tx.query("SELECT * FROM pim_app.agents WHERE id = $1 AND deleted_at IS NULL", [id])).rows[0];
			if (!r) throw new NotFoundError("No such agent");
			return rowToAgent(r);
		});
	}

	async update(p: Principal, id: string, input: AgentInput): Promise<Agent> {
		await this.authz.enforce(p, "api:write");
		this.#check(input);
		return this.db.owner(p.ownerId, async (tx) => {
			const cur = (await tx.query("SELECT config FROM pim_app.agents WHERE id = $1 AND deleted_at IS NULL FOR UPDATE", [id])).rows[0];
			if (!cur) throw new NotFoundError("No such agent");
			if (input.contacts?.includes(id) || input.delegates?.includes(id)) throw new BadRequestError("An agent cannot be its own contact or delegate");
			const config = await this.#config(tx, p.ownerId, input, cur.config);
			await tx.query(
				"UPDATE pim_app.agents SET name = coalesce($2, name), instructions = coalesce($3, instructions), config = $4, emoji = CASE WHEN $5 THEN $6 ELSE emoji END, color = CASE WHEN $7 THEN $8 ELSE color END, icon_key = CASE WHEN $9 THEN $10 ELSE icon_key END, updated_at = now() WHERE id = $1",
				[id, input.name?.trim() ?? null, input.instructions ?? null, JSON.stringify(config), "emoji" in input, input.emoji ?? null, "color" in input, input.color ?? null, "icon" in input, input.icon ?? null],
			);
			return rowToAgent((await tx.query("SELECT * FROM pim_app.agents WHERE id = $1", [id])).rows[0]);
		});
	}

	/** Deleting an agent drops it from every other agent's contacts and delegates, so nothing points at it. */
	async remove(p: Principal, id: string): Promise<void> {
		await this.authz.enforce(p, "api:write");
		await this.db.owner(p.ownerId, async (tx) => {
			if (!(await tx.query("UPDATE pim_app.agents SET deleted_at = now() WHERE id = $1 AND deleted_at IS NULL", [id])).rowCount) throw new NotFoundError("No such agent");
			for (const key of ["contacts", "delegates"]) {
				await tx.query(`UPDATE pim_app.agents SET config = jsonb_set(config, '{${key}}', coalesce((SELECT jsonb_agg(v) FROM jsonb_array_elements(config->'${key}') v WHERE v <> to_jsonb($1::text)), '[]'::jsonb)) WHERE config ? '${key}'`, [id]);
			}
		});
	}

	/** An admin marks a published template as the one everyone may adopt. */
	async setDefaultTemplate(admin: Principal, templateId: string | null): Promise<void> {
		await this.authz.enforce(admin, "admin:templates");
		await this.db.owner(admin.ownerId, async (tx) => {
			await tx.query("UPDATE pim_app.templates SET default_for_everyone = false WHERE default_for_everyone");
			if (templateId && !(await tx.query("UPDATE pim_app.templates SET default_for_everyone = true WHERE id = $1 AND owner_id = $2", [templateId, admin.ownerId])).rowCount) throw new NotFoundError("Publish the template first; only your own can be the default");
		});
	}

	/** The default-for-everyone agent, adopted into the person's space once: a copy that remembers where it came from. */
	async adoptDefault(p: Principal): Promise<Agent | null> {
		await this.authz.enforce(p, "api:write");
		const template = await this.db.anonymous(async (tx) => (await tx.query("SELECT id, title, bundle FROM pim_app.templates WHERE default_for_everyone LIMIT 1")).rows[0]);
		if (!template) return null;
		const existing = await this.db.owner(p.ownerId, async (tx) => (await tx.query("SELECT * FROM pim_app.agents WHERE adopted_from = $1 AND deleted_at IS NULL", [template.id])).rows[0]);
		if (existing) return rowToAgent(existing);
		const b = template.bundle as { agent?: { name?: string; instructions?: string; emoji?: string; color?: string } };
		const agent = await this.create(p, { name: b.agent?.name ?? template.title, instructions: b.agent?.instructions ?? "", ...(b.agent?.emoji ? { emoji: b.agent.emoji } : {}), ...(b.agent?.color ? { color: b.agent.color } : {}) });
		await this.db.owner(p.ownerId, (tx) => tx.query("UPDATE pim_app.agents SET adopted_from = $2 WHERE id = $1", [agent.id, template.id]));
		return { ...agent, adoptedFrom: template.id };
	}

	// ---- skills ----

	async createSkill(p: Principal, input: { name: string; description?: string; body?: string; files?: Record<string, string> }) {
		await this.authz.enforce(p, "api:write");
		if (!/^[a-z0-9][a-z0-9-]{0,62}$/.test(input.name)) throw new BadRequestError("A skill's name is lowercase letters, digits and dashes");
		const files = checkFiles(input.files ?? {});
		return this.db.owner(p.ownerId, async (tx) => {
			if ((await tx.query("SELECT 1 FROM pim_app.skills WHERE name = $1", [input.name])).rowCount) throw new ConflictError("You already have a skill with that name", "skill_exists");
			const id = newId("sk");
			await tx.query("INSERT INTO pim_app.skills (id, owner_id, name, description, body, files) VALUES ($1,$2,$3,$4,$5,$6)", [id, p.ownerId, input.name, input.description ?? "", input.body ?? "", JSON.stringify(files)]);
			await tx.query("INSERT INTO pim_app.skill_versions (owner_id, skill_id, version, body, files) VALUES ($1,$2,1,$3,$4)", [p.ownerId, id, input.body ?? "", JSON.stringify(files)]);
			return this.#skill(tx, input.name);
		});
	}

	async #skill(tx: Tx, name: string) {
		const r = (await tx.query("SELECT * FROM pim_app.skills WHERE name = $1", [name])).rows[0];
		if (!r) throw new NotFoundError("No such skill");
		return { id: r.id as string, name: r.name as string, description: r.description as string, body: r.body as string, files: r.files as Record<string, string>, version: r.version as number, updatedAt: r.updated_at as Date };
	}

	async listSkills(p: Principal) {
		await this.authz.enforce(p, "api:read");
		return this.db.owner(p.ownerId, async (tx) => (await tx.query("SELECT name, description, version, updated_at FROM pim_app.skills ORDER BY name")).rows.map((r) => ({ name: r.name as string, description: r.description as string, version: r.version as number, updatedAt: r.updated_at as Date })));
	}

	async getSkill(p: Principal, name: string) {
		await this.authz.enforce(p, "api:read");
		return this.db.owner(p.ownerId, (tx) => this.#skill(tx, name));
	}

	/** A new version of a skill: its body and supporting files, with every earlier version kept. */
	async updateSkill(p: Principal, name: string, input: { description?: string; body?: string; files?: Record<string, string> }) {
		await this.authz.enforce(p, "api:write");
		const files = input.files === undefined ? undefined : checkFiles(input.files);
		return this.db.owner(p.ownerId, async (tx) => {
			const cur = await this.#skill(tx, name);
			const next = cur.version + 1;
			const body = input.body ?? cur.body;
			const f = files ?? cur.files;
			await tx.query("UPDATE pim_app.skills SET description = $2, body = $3, files = $4, version = $5, updated_at = now() WHERE id = $1", [cur.id, input.description ?? cur.description, body, JSON.stringify(f), next]);
			await tx.query("INSERT INTO pim_app.skill_versions (owner_id, skill_id, version, body, files) VALUES ($1,$2,$3,$4,$5)", [p.ownerId, cur.id, next, body, JSON.stringify(f)]);
			return this.#skill(tx, name);
		});
	}

	async skillVersion(p: Principal, name: string, version: number) {
		await this.authz.enforce(p, "api:read");
		return this.db.owner(p.ownerId, async (tx) => {
			const cur = await this.#skill(tx, name);
			const r = (await tx.query("SELECT body, files FROM pim_app.skill_versions WHERE skill_id = $1 AND version = $2", [cur.id, version])).rows[0];
			if (!r) throw new NotFoundError("No such version");
			return { version, body: r.body as string, files: r.files as Record<string, string> };
		});
	}

	/** Restoring writes an older version again as a new one, so history only grows. */
	async restoreSkill(p: Principal, name: string, version: number) {
		const v = await this.skillVersion(p, name, version);
		return this.updateSkill(p, name, { body: v.body, files: v.files });
	}

	/** Deleting a skill takes it off every agent that listed it. */
	async deleteSkill(p: Principal, name: string): Promise<void> {
		await this.authz.enforce(p, "api:write");
		await this.db.owner(p.ownerId, async (tx) => {
			if (!(await tx.query("DELETE FROM pim_app.skills WHERE name = $1", [name])).rowCount) throw new NotFoundError("No such skill");
			await tx.query("UPDATE pim_app.agents SET config = jsonb_set(config, '{skills}', coalesce((SELECT jsonb_agg(v) FROM jsonb_array_elements(config->'skills') v WHERE v <> to_jsonb($1::text)), '[]'::jsonb)) WHERE config ? 'skills'", [name]);
		});
	}
}

/** Supporting files: relative paths with no `..`, text only, bounded. */
function checkFiles(files: Record<string, string>): Record<string, string> {
	let total = 0;
	for (const [path, content] of Object.entries(files)) {
		if (!/^[\w.-]+(\/[\w.-]+)*$/.test(path) || path.split("/").includes("..")) throw new BadRequestError(`"${path}" is not a plain relative path`);
		if (typeof content !== "string") throw new BadRequestError(`${path} must be text`);
		total += content.length;
	}
	if (Object.keys(files).length > 50 || total > 1_000_000) throw new BadRequestError("A skill has up to 50 files and 1 MB");
	return files;
}
