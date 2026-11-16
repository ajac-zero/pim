import { OwnerId, type Principal } from "@pim/v2-contracts/identity";
import { Authorizer } from "./authz.ts";
import type { Db } from "./db.ts";
import { BadRequestError, GoneError, NotFoundError, RefusedError } from "./errors.ts";
import { newId, secret } from "./ids.ts";
import type { Agents } from "./agents.ts";
import type { Conversations } from "./conversations.ts";

/** Where a chat's messages are read from: the runtime's projection. Absent, a shared chat shows its metadata alone. */
export interface TranscriptSource {
	read(ownerId: string, chatId: string, limit: number): Promise<unknown[]>;
}

/**
 * Circles, shared chats, people and profiles, visits, bots, templates and the account export: how a person's space meets other people's.
 * What is shared is shared on purpose and read-only: row-level security lets a circle's members read the circle and what is shared with it,
 * never write it, and never see anything else of the owner's.
 */
export class Sharing {
	constructor(
		private readonly db: Db,
		private readonly conversations: Conversations,
		private readonly agents: Agents,
		private readonly transcripts?: TranscriptSource,
		private readonly authz = new Authorizer(db),
	) {}

	// ---- circles ----

	async createCircle(p: Principal, name: string) {
		await this.authz.enforce(p, "api:write");
		if (!name?.trim() || name.length > 60) throw new BadRequestError("A circle needs a name of up to 60 characters");
		const id = newId("ci");
		await this.db.owner(p.ownerId, (tx) => tx.query("INSERT INTO pim_app.circles (id, owner_id, name) VALUES ($1,$2,$3)", [id, p.ownerId, name.trim()]));
		return { id, name: name.trim(), members: [] as string[] };
	}

	async circles(p: Principal) {
		await this.authz.enforce(p, "api:read");
		return this.db.owner(p.ownerId, async (tx) => (await tx.query("SELECT id, name, members, owner_id = $1 AS mine FROM pim_app.circles ORDER BY name", [p.ownerId])).rows.map((r) => ({ id: r.id as string, name: r.name as string, members: r.mine ? (r.members as string[]) : undefined, mine: r.mine as boolean })));
	}

	async renameCircle(p: Principal, id: string, name: string) {
		await this.authz.enforce(p, "api:write");
		if (!(await this.db.owner(p.ownerId, async (tx) => (await tx.query("UPDATE pim_app.circles SET name = $2 WHERE id = $1 AND owner_id = $3", [id, name.trim(), p.ownerId])).rowCount))) throw new NotFoundError("No such circle");
	}

	/** Deleting a circle stops everything shared with it, at the next look of anyone in it. */
	async deleteCircle(p: Principal, id: string) {
		await this.authz.enforce(p, "api:write");
		await this.db.owner(p.ownerId, async (tx) => {
			if (!(await tx.query("DELETE FROM pim_app.circles WHERE id = $1 AND owner_id = $2", [id, p.ownerId])).rowCount) throw new NotFoundError("No such circle");
			await tx.query("DELETE FROM pim_app.shares WHERE audience = $1", [`circle:${id}`]);
			await tx.query("UPDATE pim_app.artifacts SET circles = array_remove(circles, $1), access = CASE WHEN cardinality(array_remove(circles, $1)) = 0 AND access = 'shared' THEN 'private' ELSE access END WHERE $1 = ANY(circles)", [id]);
		});
	}

	/** Adds a person by username. Guests, the suspended and the deleted cannot be added. */
	async addMember(p: Principal, circleId: string, username: string) {
		await this.authz.enforce(p, "api:write");
		const target = await this.db.anonymous(async (tx) => (await tx.query("SELECT owner_id, role, status FROM pim_app.accounts WHERE username = $1", [username.trim().toLowerCase().replace(/^@/, "")])).rows[0]);
		if (!target || target.status !== "active") throw new NotFoundError("No one by that name");
		if (target.role === "guest") throw new RefusedError("Guests cannot be in circles.", "guest");
		if (target.owner_id === p.ownerId) throw new BadRequestError("You are in your own circles already");
		await this.db.owner(p.ownerId, async (tx) => {
			if (!(await tx.query("UPDATE pim_app.circles SET members = CASE WHEN $2 = ANY(members) THEN members ELSE members || $2 END WHERE id = $1 AND owner_id = $3", [circleId, target.owner_id, p.ownerId])).rowCount) throw new NotFoundError("No such circle");
		});
		return { ownerId: target.owner_id as string };
	}

	async removeMember(p: Principal, circleId: string, memberOwnerId: string) {
		await this.authz.enforce(p, "api:write");
		if (!(await this.db.owner(p.ownerId, async (tx) => (await tx.query("UPDATE pim_app.circles SET members = array_remove(members, $2) WHERE id = $1 AND owner_id = $3", [circleId, memberOwnerId, p.ownerId])).rowCount))) throw new NotFoundError("No such circle");
	}

	/** What the circles you are in have shared with you: other people's apps and shared chats, newest first. */
	async activity(p: Principal) {
		await this.authz.enforce(p, "api:read");
		return this.db.owner(p.ownerId, async (tx) => {
			const apps = (await tx.query("SELECT a.owner_id, a.id, a.title, a.kind, a.latest_version, a.updated_at, ac.username FROM pim_app.artifacts a JOIN pim_app.accounts ac ON ac.owner_id = a.owner_id WHERE a.owner_id <> $1 ORDER BY a.updated_at DESC LIMIT 50", [p.ownerId])).rows;
			return apps.map((r) => ({ kind: "app" as const, ownerId: r.owner_id as string, from: r.username as string, id: r.id as string, title: r.title as string, appKind: r.kind as string, version: r.latest_version as number, at: r.updated_at as Date }));
		});
	}

	/** One shared app, as its latest version, read only. The viewer must be in a circle it is shared with (row-level security decides). */
	async sharedApp(p: Principal, ownerId: string, id: string) {
		const role = (await this.authz.account(p.ownerId))?.role;
		if (role === "guest") throw new RefusedError("Guests cannot open shared apps.", "guest");
		await this.authz.requireLive(ownerId, "shared:read").catch((e) => { if (e instanceof GoneError) throw new NotFoundError(); throw new NotFoundError(); });
		const row = await this.db.owner(p.ownerId, async (tx) => (await tx.query("SELECT a.title, a.kind, a.latest_version, v.files FROM pim_app.artifacts a JOIN pim_app.artifact_versions v ON v.artifact_id = a.id AND v.owner_id = a.owner_id AND v.version = a.latest_version WHERE a.owner_id = $1 AND a.id = $2", [ownerId, id])).rows[0]);
		if (!row) throw new NotFoundError();
		return { id, ownerId, title: row.title as string, kind: row.kind as string, version: row.latest_version as number, files: row.files as Record<string, string> };
	}

	// ---- shared chats ----

	/** Makes (or returns) a chat's public link. Anyone with it can read the chat, nothing more. */
	async shareChat(p: Principal, chatId: string): Promise<{ link: string }> {
		await this.authz.enforce(p, "api:write");
		await this.conversations.get(p.ownerId, chatId);
		return this.db.owner(p.ownerId, async (tx) => {
			const cur = (await tx.query("SELECT link FROM pim_app.shares WHERE kind = 'chat' AND resource_id = $1", [chatId])).rows[0];
			if (cur) return { link: cur.link as string };
			const link = secret(12);
			await tx.query("INSERT INTO pim_app.shares (id, owner_id, kind, resource_id, audience, link) VALUES ($1,$2,'chat',$3,'link',$4)", [newId("sh"), p.ownerId, chatId, link]);
			return { link };
		});
	}

	async unshareChat(p: Principal, chatId: string): Promise<void> {
		await this.authz.enforce(p, "api:write");
		await this.db.owner(p.ownerId, (tx) => tx.query("DELETE FROM pim_app.shares WHERE kind = 'chat' AND resource_id = $1", [chatId]));
	}

	async sharedChatLink(p: Principal, chatId: string): Promise<{ link: string | null }> {
		await this.authz.enforce(p, "api:read");
		return this.db.owner(p.ownerId, async (tx) => ({ link: (await tx.query("SELECT link FROM pim_app.shares WHERE kind = 'chat' AND resource_id = $1", [chatId])).rows[0]?.link ?? null }));
	}

	/** `/api/shared/:owner/:link`: public. A deleted author's chat is gone (410); a suspended author's stays up. */
	async readSharedChat(ownerId: string, link: string, limit = 200) {
		const share = await this.db.lookup(link, async (tx) => (await tx.query("SELECT resource_id FROM pim_app.shares WHERE link = $1 AND owner_id = $2", [link, ownerId])).rows[0]);
		if (!share) throw new NotFoundError();
		const author = await this.authz.account(ownerId);
		if (!author || author.status === "deleting" || author.status === "deleted") throw new GoneError("The author has deleted their account");
		const chat = await this.conversations.get(ownerId, share.resource_id);
		return { title: await this.db.owner(ownerId, async (tx) => (await tx.query("SELECT title FROM pim_app.conversations WHERE public_chat_id = $1", [chat.id])).rows[0]?.title ?? null), author: author.username, messages: this.transcripts ? await this.transcripts.read(ownerId, chat.id, Math.min(limit, 500)) : [] };
	}

	// ---- profiles and people ----

	async profile(p: Principal) {
		await this.authz.enforce(p, "api:read");
		return this.db.owner(p.ownerId, async (tx) => {
			const r = (await tx.query("SELECT display_name, bio, published FROM pim_app.profiles WHERE owner_id = $1", [p.ownerId])).rows[0];
			return { displayName: (r?.display_name ?? "") as string, bio: (r?.bio ?? "") as string, published: (r?.published ?? false) as boolean };
		});
	}

	async setProfile(p: Principal, input: { displayName?: string; bio?: string; published?: boolean }) {
		await this.authz.enforce(p, "api:write");
		if ((input.displayName?.length ?? 0) > 80 || (input.bio?.length ?? 0) > 1000) throw new BadRequestError("A display name is up to 80 characters and a bio up to 1000");
		await this.db.owner(p.ownerId, (tx) => tx.query("INSERT INTO pim_app.profiles (owner_id, display_name, bio, published) VALUES ($1, coalesce($2, ''), coalesce($3, ''), coalesce($4, false)) ON CONFLICT (owner_id) DO UPDATE SET display_name = coalesce($2, profiles.display_name), bio = coalesce($3, profiles.bio), published = coalesce($4, profiles.published), updated_at = now()", [p.ownerId, input.displayName ?? null, input.bio ?? null, input.published ?? null]));
		return this.profile(p);
	}

	/** `/api/people/:username`: a published profile with the person's published templates and bots. Unpublished, deleted and unknown are all 404. */
	async person(username: string) {
		const acct = await this.db.anonymous(async (tx) => (await tx.query("SELECT a.owner_id, a.username, a.status, p.display_name, p.bio FROM pim_app.accounts a JOIN pim_app.profiles p ON p.owner_id = a.owner_id WHERE a.username = $1 AND p.published", [username.toLowerCase()])).rows[0]);
		if (!acct || acct.status === "deleted" || acct.status === "deleting") throw new NotFoundError();
		return this.db.anonymous(async (tx) => ({
			username: acct.username as string, displayName: acct.display_name as string, bio: acct.bio as string,
			templates: (await tx.query("SELECT id, title FROM pim_app.templates WHERE owner_id = $1 ORDER BY published_at DESC", [acct.owner_id])).rows.map((r) => ({ id: r.id as string, title: r.title as string })),
			bots: (await tx.query("SELECT id, name FROM pim_app.bots WHERE owner_id = $1 ORDER BY created_at", [acct.owner_id])).rows.map((r) => ({ id: r.id as string, name: r.name as string })),
		}));
	}

	// ---- bots, visits ----

	/** Shares one of your agents as a bot anyone signed in may visit. */
	async createBot(p: Principal, agentId: string, name?: string) {
		await this.authz.enforce(p, "api:write");
		const agent = await this.agents.get(p, agentId);
		const id = `bot_${secret(9)}`;
		await this.db.owner(p.ownerId, (tx) => tx.query("INSERT INTO pim_app.bots (id, owner_id, name, agent_id) VALUES ($1,$2,$3,$4)", [id, p.ownerId, name?.trim() || agent.name, agentId]));
		return { id };
	}

	async bots(p: Principal) {
		await this.authz.enforce(p, "api:read");
		return this.db.owner(p.ownerId, async (tx) => (await tx.query("SELECT id, name, agent_id FROM pim_app.bots WHERE owner_id = $1 ORDER BY created_at", [p.ownerId])).rows.map((r) => ({ id: r.id as string, name: r.name as string, agentId: r.agent_id as string })));
	}

	async removeBot(p: Principal, id: string) {
		await this.authz.enforce(p, "api:write");
		if (!(await this.db.owner(p.ownerId, async (tx) => (await tx.query("DELETE FROM pim_app.bots WHERE id = $1 AND owner_id = $2", [id, p.ownerId])).rowCount))) throw new NotFoundError("No such bot");
	}

	async bot(id: string) {
		const r = await this.db.anonymous(async (tx) => (await tx.query("SELECT b.id, b.name, a.username, a.status FROM pim_app.bots b JOIN pim_app.accounts a ON a.owner_id = b.owner_id WHERE b.id = $1", [id])).rows[0]);
		if (!r || r.status === "deleted" || r.status === "deleting") throw new NotFoundError();
		return { id: r.id as string, name: r.name as string, owner: r.username as string };
	}

	/**
	 * Visits someone's bot: a chat in the host's space with the visitor as its guest. Both must be live; a guest account may visit (that is what guests
	 * are for), but only the host's bot, and the host's other agents are not reachable. The visit is recorded in the host's space.
	 */
	async visit(p: Principal, username: string, botId: string) {
		await this.authz.enforce(p, "api:write");
		const host = await this.db.anonymous(async (tx) => (await tx.query("SELECT owner_id FROM pim_app.accounts WHERE username = $1", [username.toLowerCase()])).rows[0]);
		if (!host) throw new NotFoundError("No one by that name");
		await this.authz.requireLive(host.owner_id, "visit");
		const bot = await this.db.owner(host.owner_id, async (tx) => (await tx.query("SELECT agent_id FROM pim_app.bots WHERE id = $1 AND owner_id = $2", [botId, host.owner_id])).rows[0]);
		if (!bot) throw new NotFoundError("That bot isn't offered");
		const hostPrincipal: Principal = { kind: "agent", ownerId: OwnerId.parse(host.owner_id), agentId: `visit:${p.ownerId}` };
		const chatId = await this.conversations.create(hostPrincipal, { agentId: bot.agent_id, kind: "visit", title: "Visit" });
		const visitId = newId("vi");
		await this.db.owner(host.owner_id, (tx) => tx.query("INSERT INTO pim_app.visits (id, owner_id, visitor, bot_id, public_chat_id) VALUES ($1,$2,$3,$4,$5)", [visitId, host.owner_id, p.ownerId, botId, chatId]));
		return { visitId, chatId, host: host.owner_id as string };
	}

	async visits(p: Principal) {
		await this.authz.enforce(p, "api:read");
		return this.db.owner(p.ownerId, async (tx) => (await tx.query("SELECT id, visitor, bot_id, public_chat_id, created_at FROM pim_app.visits ORDER BY created_at DESC LIMIT 100")).rows.map((r) => ({ id: r.id as string, visitor: r.visitor as string, botId: r.bot_id as string, chatId: r.public_chat_id as string, at: r.created_at as Date })));
	}

	// ---- templates and the gallery ----

	/** Publishes an agent as a template: its name, instructions and look, nothing of its memory or connectors. */
	async publishTemplate(p: Principal, agentId: string, title?: string) {
		await this.authz.enforce(p, "api:write");
		const agent = await this.agents.get(p, agentId);
		const id = `tpl_${secret(9)}`;
		const bundle = { agent: { name: agent.name, instructions: agent.instructions, emoji: agent.emoji, color: agent.color } };
		await this.db.owner(p.ownerId, async (tx) => {
			await tx.query("DELETE FROM pim_app.templates WHERE owner_id = $1 AND agent_id = $2", [p.ownerId, agentId]);
			await tx.query("INSERT INTO pim_app.templates (id, owner_id, agent_id, title, bundle) VALUES ($1,$2,$3,$4,$5)", [id, p.ownerId, agentId, title?.trim() || agent.name, JSON.stringify(bundle)]);
		});
		return { id };
	}

	async unpublishTemplate(p: Principal, agentId: string) {
		await this.authz.enforce(p, "api:write");
		await this.db.owner(p.ownerId, (tx) => tx.query("DELETE FROM pim_app.templates WHERE owner_id = $1 AND agent_id = $2", [p.ownerId, agentId]));
	}

	/** The gallery: every published template, except those whose author was deleted. */
	async templates(p: Principal) {
		await this.authz.enforce(p, "api:read");
		return this.db.owner(p.ownerId, async (tx) => (await tx.query("SELECT t.id, t.title, a.username, t.published_at FROM pim_app.templates t JOIN pim_app.accounts a ON a.owner_id = t.owner_id WHERE a.status NOT IN ('deleting', 'deleted') ORDER BY t.published_at DESC LIMIT 100")).rows.map((r) => ({ id: r.id as string, title: r.title as string, author: r.username as string, publishedAt: r.published_at as Date })));
	}

	async template(p: Principal, id: string) {
		await this.authz.enforce(p, "api:read");
		const r = await this.db.owner(p.ownerId, async (tx) => (await tx.query("SELECT t.id, t.title, t.bundle, a.username FROM pim_app.templates t JOIN pim_app.accounts a ON a.owner_id = t.owner_id WHERE t.id = $1 AND a.status NOT IN ('deleting', 'deleted')", [id])).rows[0]);
		if (!r) throw new NotFoundError("No such template");
		return { id: r.id as string, title: r.title as string, author: r.username as string, bundle: r.bundle as { agent: { name: string; instructions: string } } };
	}

	/** Uses a template: a copy of the agent in your space, remembering where it came from. */
	async useTemplate(p: Principal, id: string) {
		const t = await this.template(p, id);
		const agent = await this.agents.create(p, { name: t.bundle.agent.name, instructions: t.bundle.agent.instructions });
		await this.db.owner(p.ownerId, (tx) => tx.query("UPDATE pim_app.agents SET adopted_from = $2 WHERE id = $1", [agent.id, id]));
		return agent;
	}

	// ---- export ----

	/** Everything of the account that is the person's own, as JSON. Secrets (credentials, sessions, tokens, keys, sealed values) are never in it. */
	async export(p: Principal): Promise<Record<string, unknown>> {
		await this.authz.enforce(p, "api:read");
		const take = async (sql: string, params: unknown[] = []) => this.db.owner(p.ownerId, async (tx) => (await tx.query(sql, params)).rows);
		const account = await this.authz.account(p.ownerId);
		return {
			exportedAt: new Date().toISOString(),
			account: { username: account!.username, role: account!.role },
			profile: await this.profile(p),
			agents: await take("SELECT id, name, instructions, emoji, color, config, created_at FROM pim_app.agents WHERE deleted_at IS NULL"),
			skills: await take("SELECT name, description, body, files, version FROM pim_app.skills"),
			memories: await take("SELECT id, scope, title, body, created_at FROM pim_app.memories WHERE deleted_at IS NULL"),
			goals: await take("SELECT g.id, g.title, g.status, (SELECT coalesce(jsonb_agg(jsonb_build_object('title', s.title, 'done', s.done) ORDER BY s.position), '[]') FROM pim_app.goal_steps s WHERE s.goal_id = g.id) AS steps FROM pim_app.goals g"),
			schedules: await take("SELECT id, kind, spec, target, prompt, enabled FROM pim_app.schedules"),
			triggers: await take("SELECT id, lifecycle, spec FROM pim_app.triggers WHERE lifecycle <> 'deleted'"),
			chats: await take("SELECT public_chat_id AS id, title, kind, created_at, archived_at FROM pim_app.conversations WHERE deleted_at IS NULL"),
			apps: await take("SELECT a.id, a.title, a.kind, a.latest_version, (SELECT jsonb_agg(jsonb_build_object('version', v.version, 'files', v.files) ORDER BY v.version) FROM pim_app.artifact_versions v WHERE v.artifact_id = a.id) AS versions FROM pim_app.artifacts a WHERE a.owner_id = $1", [p.ownerId]),
			circles: await take("SELECT id, name, members FROM pim_app.circles WHERE owner_id = $1", [p.ownerId]),
			connectors: await take("SELECT id, kind, name, url, enabled_tools FROM pim_app.connectors"),
			providers: await take("SELECT id, kind, config FROM pim_app.providers"),
		};
	}
}
