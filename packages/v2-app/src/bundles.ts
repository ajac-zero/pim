import type { Db, Tx } from "./db.ts";
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
	 * Makes the bundle's agents `ownerId`'s own: copies that remember the template they came from (the agent itself alone), their contacts pointing at the
	 * copies of the agents that came with it. Nothing is checked against what the person may do, so it works while an account is still being made; the callers
	 * are the ones that decided to give it. Icons are copied afterwards. Returns the new agent's id.
	 */
	async adopt(ownerId: string, bundle: Bundle, opts: { adoptedFrom: string; apps?: string[]; model?: { provider: string; id: string } | null }): Promise<string> {
		const agents = [bundle.agent as BundleAgent, ...(bundle.bundle ?? [])];
		const ids = agents.map(() => newId("a"));
		const byRole = new Map<string, string>();
		agents.forEach((a, i) => {
			const role = a.role ?? a.name;
			if (i > 0 && !byRole.has(role)) byRole.set(role, ids[i]!);
		});
		const icons: { id: string; key: string }[] = [];
		await this.db.owner(ownerId, async (tx) => {
			for (const [i, a] of agents.entries()) {
				const config = { apps: i === 0 && opts.apps ? opts.apps : (a.apps ?? bundle.apps ?? []), contacts: (a.contacts ?? []).flatMap((role) => byRole.get(role) ?? []), delegates: [], fallbacks: [], skills: [], memoryScopes: [], ...(i === 0 && opts.model ? { model: opts.model } : {}) };
				await tx.query(
					"INSERT INTO pim_app.agents (id, owner_id, name, instructions, config, emoji, color, role, description, adopted_from) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)",
					[ids[i], ownerId, a.name, a.instructions, JSON.stringify(config), a.emoji ?? null, a.color ?? null, (a.role ?? a.name).trim(), a.description ?? (i === 0 ? bundle.description : "") ?? "", i === 0 ? opts.adoptedFrom : null],
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
