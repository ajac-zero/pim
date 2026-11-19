import type { Db, Tx } from "./db.ts";
import { PimError } from "./errors.ts";
import { newId } from "./ids.ts";
import type { Objects } from "./objects.ts";

/** One of an author's agents as the gallery copies it: what it is for and how it looks, its connectors, and its contacts by role among the agents that come with it. */
export type BundleAgent = {
	name: string;
	role: string;
	description: string;
	instructions: string;
	apps: string[];
	emoji: string | null;
	color: string | null;
	/** Its contacts, by role, among the agents that come with it. */
	contacts: string[];
	/** The uploaded icon's object key under the author, when it has one. */
	icon: string | null;
};

/**
 * What a template, a bot and the agent everyone starts with carry (`pim_app.templates.bundle`): the agent itself, and the agents that come with it,
 * its contacts and theirs. `description`, `apps` and `icon` repeat the agent's own for the gallery's cards.
 */
export type Bundle = { agent: Partial<BundleAgent> & Pick<BundleAgent, "name" | "instructions">; description?: string; apps?: string[]; icon?: string; bundle?: BundleAgent[] };

/** At most this many agents in one space, as in v1; the agents that come with a template count against it. */
export const MAX_AGENTS = 50;
const MAX_NAME = 60;

/** `name`, or, when one of the person's agents has it already, the name with the copied agent's after it, or a number. */
export function freeName(name: string, of: string, taken: ReadonlySet<string>): string {
	const candidates = [name, `${name} (${of})`.slice(0, MAX_NAME), ...Array.from({ length: MAX_AGENTS * 2 }, (_, n) => `${name.slice(0, MAX_NAME - 4)} ${n + 2}`)];
	return candidates.find((candidate) => !taken.has(candidate.toLowerCase())) ?? name;
}

const roleOf = (r: any) => (r.role ?? r.config?.legacy?.role ?? r.name) as string;

/** Agents and the contacts that come with them: copying one's own agents to another space, as v1's gallery did, without any of what the owner's agents remember. */
export class Bundles {
	constructor(private readonly db: Db, private readonly objects?: Objects) {}

	/** The agent with every agent it can reach through contacts, as `tx`'s owner has them. */
	async of(tx: Tx, ownerId: string, agentId: string): Promise<Bundle | null> {
		const rows = (await tx.query("SELECT * FROM pim_app.agents WHERE deleted_at IS NULL")).rows;
		const byId = new Map<string, any>(rows.map((r) => [r.id as string, r]));
		const main = byId.get(agentId);
		if (!main) return null;
		const roles = (contacts: string[]) => contacts.flatMap((c) => (byId.get(c) ? [roleOf(byId.get(c))] : []));
		const view = (r: any): BundleAgent => ({
			name: r.name, role: roleOf(r), description: (r.description || r.config?.legacy?.description || "") as string, instructions: r.instructions, apps: r.config?.apps ?? [],
			emoji: r.emoji, color: r.color, contacts: roles(r.config?.contacts ?? []), icon: typeof r.icon_key === "string" && r.icon_key.startsWith(`${ownerId}/`) ? r.icon_key : null,
		});
		const others: BundleAgent[] = [];
		const seen = new Set([agentId]);
		for (const queue = [...(main.config?.contacts ?? [])] as string[]; queue.length > 0; ) {
			const next = byId.get(queue.shift()!);
			if (!next || seen.has(next.id)) continue;
			seen.add(next.id);
			others.push(view(next));
			queue.push(...(next.config?.contacts ?? []));
		}
		const agent = view(main);
		return { agent, description: agent.description, apps: agent.apps, ...(agent.icon ? { icon: agent.icon } : {}), bundle: others };
	}

	/**
	 * Brings a copy of the bundle's agent up to date: its name, description, instructions, look and model, and its icon (copied again, or none). Its role, contacts,
	 * connectors and memory stay as they are, and so do the agents that came with it.
	 */
	async follow(ownerId: string, agentId: string, bundle: Bundle, model: { provider: string; id: string } | null): Promise<void> {
		const a = bundle.agent as BundleAgent;
		const icon = a.icon ?? bundle.icon;
		const copy = icon ? ((await this.objects?.copyPublic(ownerId, icon).catch(() => null)) ?? null) : null;
		await this.db.owner(ownerId, (tx) => tx.query(
			"UPDATE pim_app.agents SET name = $2, instructions = $3, description = $4, emoji = $5, color = $6, icon_key = $7, config = CASE WHEN $8::jsonb IS NULL THEN config - 'model' ELSE jsonb_set(config, '{model}', $8::jsonb) END, updated_at = now() WHERE id = $1 AND deleted_at IS NULL",
			[agentId, a.name, a.instructions, a.description ?? bundle.description ?? "", a.emoji ?? null, a.color ?? null, copy, model && JSON.stringify(model)],
		));
	}

	/**
	 * Makes the bundle's agents `ownerId`'s own: copies that remember the template they came from (the agent itself alone), their contacts pointing at the
	 * copies of the agents that came with it. Nothing is checked against what the person may do, so it works while an account is still being made; the callers
	 * are the ones that decided to give it. A copy whose role or name one of the person's agents already has gets another (`Physio (Marathon coach)`), so that
	 * agents hand it work by its role without doubt; copies of one agent share a memory scope, the first copy's; and the agents that come with the template
	 * count against the cap on agents. Icons are copied afterwards. Returns the new agent's id.
	 */
	async adopt(ownerId: string, bundle: Bundle, opts: { adoptedFrom: string; apps?: string[]; model?: { provider: string; id: string } | null }): Promise<string> {
		const agents = [bundle.agent as BundleAgent, ...(bundle.bundle ?? [])];
		const ids = agents.map(() => newId("a"));
		const originalRole = (a: BundleAgent) => (a.role ?? a.name).trim();
		const byRole = new Map<string, string>();
		agents.forEach((a, i) => {
			const role = originalRole(a).toLowerCase();
			if (!byRole.has(role)) byRole.set(role, ids[i]!);
		});
		const copyOf = (a: BundleAgent, i: number) => (i === 0 ? opts.adoptedFrom : `${opts.adoptedFrom}/${originalRole(a).toLowerCase()}`);
		const icons: { id: string; key: string }[] = [];
		await this.db.owner(ownerId, async (tx) => {
			const have = (await tx.query("SELECT id, name, role, config FROM pim_app.agents WHERE deleted_at IS NULL")).rows;
			if (have.length + agents.length > MAX_AGENTS) throw new PimError(429, "limit", agents.length > 1 ? `You can have up to ${MAX_AGENTS} agents, and ${bundle.agent.name} comes with ${agents.length - 1} more.` : `You can have up to ${MAX_AGENTS} agents.`);
			const roles = new Set<string>(have.map((r) => roleOf(r).toLowerCase()));
			const names = new Set<string>(have.map((r) => (r.name as string).toLowerCase()));
			for (const [i, a] of agents.entries()) {
				const role = freeName(originalRole(a), bundle.agent.name, roles);
				roles.add(role.toLowerCase());
				const name = freeName(a.name.trim(), i === 0 ? role : bundle.agent.name, names);
				names.add(name.toLowerCase());
				// Copies of one agent keep their notes together: with an earlier copy of it, or with the agent of the person's own it was published from.
				const key = copyOf(a, i);
				const sibling = (await tx.query("SELECT id, config FROM pim_app.agents WHERE deleted_at IS NULL AND config->>'copyOf' = $1 ORDER BY created_at, id LIMIT 1", [key])).rows[0]
					?? (i === 0 ? (await tx.query("SELECT a.id, a.config FROM pim_app.templates t JOIN pim_app.agents a ON a.id = t.agent_id AND a.deleted_at IS NULL WHERE t.id = $1 AND t.owner_id = $2", [key, ownerId])).rows[0] : undefined);
				const memoryScope = sibling ? ((sibling.config?.memoryScope ?? `agent-${sibling.id}`) as string) : undefined;
				const config = {
					apps: i === 0 && opts.apps ? opts.apps : (a.apps ?? bundle.apps ?? []),
					contacts: (a.contacts ?? []).flatMap((c) => byRole.get(c.trim().toLowerCase()) ?? []).filter((id) => id !== ids[i]), delegates: [], fallbacks: [], skills: [], memoryScopes: [], copyOf: key,
					...(memoryScope ? { memoryScope } : {}), ...(i === 0 && opts.model ? { model: opts.model } : {}),
				};
				await tx.query(
					"INSERT INTO pim_app.agents (id, owner_id, name, instructions, config, emoji, color, role, description, adopted_from) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)",
					[ids[i], ownerId, name, a.instructions, JSON.stringify(config), a.emoji ?? null, a.color ?? null, role, a.description ?? (i === 0 ? bundle.description : "") ?? "", i === 0 ? opts.adoptedFrom : null],
				);
				const icon = a.icon ?? (i === 0 ? bundle.icon : null);
				if (icon) icons.push({ id: ids[i]!, key: icon });
			}
		});
		for (const { id, key } of icons) {
			const copy = await this.objects?.copyPublic(ownerId, key).catch(() => null);
			if (copy) await this.db.owner(ownerId, (tx) => tx.query("UPDATE pim_app.agents SET icon_key = $2 WHERE id = $1", [id, copy]));
		}
		return ids[0]!;
	}
}
