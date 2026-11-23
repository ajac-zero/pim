import { createHash } from "node:crypto";
import type { Principal } from "@pim/v2-contracts/identity";
import { OwnerId } from "@pim/v2-contracts/identity";
import type { Agents } from "./agents.ts";
import type { Bundle, Bundles } from "./bundles.ts";
import type { Db } from "./db.ts";
import { NotFoundError, RefusedError } from "./errors.ts";
import { choiceChanged } from "./tool-permissions.ts";

/** What a guest of a bot may do in a day when the bot says nothing (v1's defaults), and what a circle's member may. */
export const BOT_DAILY_MESSAGES = 50;
export const BOT_DAILY_TOOL_CALLS = 20;
export const CIRCLE_DAILY_CALLS = 200;
/** A guest's approval waits a day for the host and is then denied; it is never approved by timing out. */
export const GUEST_APPROVAL_MS = 24 * 3600_000;
const ACTIVITY_KEPT = 500;

const modelOf = (s: BotSettings) => (s.model && typeof s.model.provider === "string" && typeof s.model.id === "string" ? { provider: s.model.provider, id: s.model.id } : null);

export type BotSettings = { dailyMessages?: number | null; dailyToolCalls?: number | null; model?: { provider: string; id: string } | null; tools?: string[]; ask?: string[] };

/**
 * Where a guest's calls to someone else's space are bounded. A guest is a person who joined through a bot's link (their account has role `guest`) or a member
 * of a host's circle on a visit; either way what they can reach of the host's space is what the host granted that audience (`bot:<id>` or `circle:<id>`) and nothing
 * else: connector tools the host switched on for it, never a computer, files, coding or the host's other agents. Every call re-reads the boundary, so a bot turned
 * off, a circle paused or a member removed stops the next call.
 */
export type Boundary = {
	kind: "bot" | "circle";
	guest: string;
	guestName: string;
	host: string;
	hostName: string;
	/** The audience the host's permissions are kept under. */
	audience: string;
	/** The bot's or the circle's name, for the host's approval card. */
	label: string;
	botId?: string;
	circleId?: string;
	/** For a bot, the tool names it shares and which of them ask first. */
	tools: string[];
	ask: string[];
	dailyCalls: number;
	memoryScopes: string[];
};

export type GuestConnector = { id: string; kind: string; name: string; url: string; status: string; credential: string | null; enabledTools: string[] };
export type GuestPermission = { app: string; tool: string; permission: "off" | "ask" | "on"; definition?: string | null };

export class Guests {
	constructor(private readonly db: Db, private readonly agents: Agents, private readonly now: () => Date = () => new Date()) {}

	/** Copies the bot's agents into a guest's space: set by the application. */
	bundles?: Bundles;

	// ---- bots: joining ----

	/** A bot whose link is live: its author is an active admin and the bot is still shared. Anything else is a 404, as v1's was. */
	async liveBot(botId: string) {
		const row = await this.db.lookup(botId, async (tx) => (await tx.query("SELECT b.id, b.owner_id, b.name, b.agent_id, b.settings, b.shared_at, b.snapshot, a.username, a.role, a.status FROM pim_app.bots b JOIN pim_app.accounts a ON a.owner_id = b.owner_id WHERE b.id = $1", [botId])).rows[0]);
		if (!row || row.status !== "active" || row.role !== "admin") throw new NotFoundError("That bot isn't shared");
		return { id: row.id as string, host: row.owner_id as string, hostName: row.username as string, name: row.name as string, agentId: row.agent_id as string | null, settings: (row.settings ?? {}) as BotSettings, sharedAt: row.shared_at as Date, snapshot: (row.snapshot ?? null) as Bundle | null };
	}

	/** After a guest's account is made: their copy of the bot's agent, which is what they chat with. */
	async enroll(guest: string, botId: string): Promise<void> {
		const bot = await this.liveBot(botId);
		// Their copy of the bot's agent and the agents that come with it, as they were when the bot was last shared, on the model the bot was given; it connects none of the host's connectors (the bot's tools are the host's to share).
		const bundle = await this.shared(bot);
		const model = modelOf(bot.settings);
		const copy = { id: await this.bundles!.adopt(guest, bundle ?? { agent: { name: bot.name, instructions: "" } }, { adoptedFrom: bot.id, apps: [], model }) };
		await this.db.owner(guest, (tx) => tx.query("INSERT INTO pim_app.guest_bots (owner_id, bot_id, host_owner, agent_id, shared_at) VALUES ($1,$2,$3,$4,$5) ON CONFLICT (owner_id) DO NOTHING", [guest, bot.id, bot.host, copy.id, bot.sharedAt]));
	}

	/** What the bot shared of its agent: the snapshot made when it was shared, else (a bot shared before snapshots) the agent as it is now. */
	private async shared(bot: { host: string; agentId: string | null; snapshot: Bundle | null }): Promise<Bundle | null> {
		if (bot.snapshot) return bot.snapshot;
		return bot.agentId ? this.db.owner(bot.host, (tx) => this.bundles!.of(tx, bot.host, bot.agentId!)) : null;
	}

	/**
	 * Brings a guest's copy of the bot up to what its author shared last: its name, description, instructions, look and model. The agents that came with it stay as
	 * they came. The bot's daily limits are read live, so they need no copying. Does nothing for a guest whose bot is turned off (their chats stay to read) or whose
	 * copy already follows the latest sharing.
	 */
	async syncBot(guest: string): Promise<void> {
		const joined = await this.db.owner(guest, async (tx) => (await tx.query("SELECT bot_id, host_owner, agent_id, shared_at FROM pim_app.guest_bots WHERE owner_id = $1", [guest])).rows[0]);
		if (!joined) return;
		const bot = await this.liveBot(joined.bot_id).catch(() => null);
		if (!bot || bot.host !== joined.host_owner || bot.sharedAt.getTime() === (joined.shared_at as Date).getTime()) return;
		const bundle = await this.shared(bot);
		await this.bundles!.follow(guest, joined.agent_id, bundle ?? { agent: { name: bot.name, instructions: "" } }, modelOf(bot.settings));
		await this.db.owner(guest, (tx) => tx.query("UPDATE pim_app.guest_bots SET shared_at = $2 WHERE owner_id = $1", [guest, bot.sharedAt]));
	}

	/** `GET /api/bot` for a guest: the bot they joined through, with what it allows a day (null once its link is off), and their copy of the agent. */
	async guestBot(guest: string) {
		const joined = await this.db.owner(guest, async (tx) => (await tx.query("SELECT bot_id, agent_id FROM pim_app.guest_bots WHERE owner_id = $1", [guest])).rows[0]);
		if (!joined) return { bot: null, agent: null, joined: null };
		const live = await this.liveBot(joined.bot_id).catch(() => null);
		return { bot: live, agent: joined.agent_id as string | null, joined: joined.bot_id as string };
	}

	// ---- the boundary ----

	/**
	 * What this guest may reach, or a refusal in words the agent can pass on. `chat` is the guest's chat: a circle member's visit names its host by it, a bot guest has
	 * one boundary for every chat.
	 */
	async boundary(guest: string, chat: string | null): Promise<Boundary> {
		const account = await this.db.owner(guest, async (tx) => (await tx.query("SELECT username, role, status FROM pim_app.accounts WHERE owner_id = $1", [guest])).rows[0]);
		if (!account || account.status !== "active") throw new RefusedError("Your account can't use this right now.", "guest_inactive");
		const joined = await this.db.owner(guest, async (tx) => (await tx.query("SELECT bot_id, host_owner FROM pim_app.guest_bots WHERE owner_id = $1", [guest])).rows[0]);
		if (account.role === "guest") {
			if (!joined) throw new RefusedError("This guest isn't a guest of any bot.", "no_bot");
			const bot = await this.liveBot(joined.bot_id).catch(() => null);
			if (!bot || bot.host !== joined.host_owner) throw new RefusedError("This bot isn't shared any more, so its tools are off.", "bot_off");
			return { kind: "bot", guest, guestName: account.username, host: bot.host, hostName: bot.hostName, audience: `bot:${bot.id}`, label: bot.name, botId: bot.id, tools: bot.settings.tools ?? [], ask: bot.settings.ask ?? [], dailyCalls: bot.settings.dailyToolCalls ?? BOT_DAILY_TOOL_CALLS, memoryScopes: [] };
		}
		const link = chat ? await this.db.owner(guest, async (tx) => (await tx.query("SELECT host_owner FROM pim_app.visit_links WHERE owner_id = $1 AND chat = $2", [guest, chat])).rows[0]) : null;
		if (!link) throw new RefusedError("This chat isn't a visit to someone's space.", "no_visit");
		const host = await this.db.owner(link.host_owner, async (tx) => ({
			account: (await tx.query("SELECT username, role, status FROM pim_app.accounts WHERE owner_id = $1", [link.host_owner])).rows[0],
			circle: (await tx.query("SELECT id, name, enabled, memory_scopes FROM pim_app.circles WHERE owner_id = $1 AND $2 = ANY (members)", [link.host_owner, guest])).rows[0],
		}));
		if (!host.account || host.account.status !== "active" || host.account.role === "guest") throw new RefusedError("That space isn't available any more.", "host_gone");
		if (!host.circle) throw new RefusedError(`${host.account.username} doesn't share their space with you.`, "not_a_member");
		if (!host.circle.enabled) throw new RefusedError(`${host.account.username} has paused sharing.`, "paused");
		return { kind: "circle", guest, guestName: account.username, host: link.host_owner, hostName: host.account.username, audience: `circle:${host.circle.id}`, label: host.circle.name, circleId: host.circle.id, tools: [], ask: [], dailyCalls: CIRCLE_DAILY_CALLS, memoryScopes: host.circle.memory_scopes };
	}

	/** The host's connectors (their credentials still sealed) and what the host decided for this audience: the rows a guest's tool call is judged against. */
	async hostConnectors(b: Boundary): Promise<{ connectors: GuestConnector[]; permissions: GuestPermission[] }> {
		return this.db.owner(b.host, async (tx) => ({
			connectors: (await tx.query("SELECT id, kind, name, url, status, credential, enabled_tools FROM pim_app.connectors WHERE url IS NOT NULL ORDER BY created_at")).rows
				.filter((r) => r.status === "connected" || r.credential === null)
				.map((r): GuestConnector => ({ id: r.id, kind: r.kind, name: r.name, url: r.url, status: r.status, credential: r.credential, enabledTools: r.enabled_tools })),
			permissions: (await tx.query("SELECT app, tool, permission, definition FROM pim_app.tool_permissions WHERE audience = $1", [b.audience])).rows as GuestPermission[],
		}));
	}

	/**
	 * Whether the guest may call a tool: off (not offered), ask (the host decides each call), or on. A bot shares the tool names it lists, the ones in `ask` asking first;
	 * a circle's tools are the host's choices for that circle, off until set. A tool the connector marks destructive never runs without asking, a tool it changed since the host chose is off until they choose again, and a host's choice never
	 * reaches beyond the connector's own enabled tools for a bot.
	 */
	permissionOf(b: Boundary, c: GuestConnector, tool: { name: string; destructive?: boolean; definition?: string }, permissions: readonly GuestPermission[]): "off" | "ask" | "on" {
		let permission: "off" | "ask" | "on";
		if (b.kind === "bot") permission = !b.tools.includes(tool.name) || !c.enabledTools.includes(tool.name) ? "off" : b.ask.includes(tool.name) ? "ask" : "on";
		else {
			const row = permissions.find((p) => p.app === c.id && p.tool === tool.name);
			// A tool the connector changed since the host chose it is the host's to choose again.
			permission = row && !(tool.definition !== undefined && choiceChanged(row, tool.definition, false)) ? row.permission : "off";
		}
		return tool.destructive === true && permission === "on" ? "ask" : permission;
	}

	// ---- limits and the log ----

	/** Counts one call against the guest's day. False when the day's calls are used up. */
	async countCall(b: Boundary): Promise<boolean> {
		const day = this.now().toISOString().slice(0, 10);
		return this.db.owner(b.host, async (tx) => {
			const r = await tx.query("INSERT INTO pim_app.guest_calls (owner_id, guest, day, calls) VALUES ($1,$2,$3,1) ON CONFLICT (owner_id, guest, day) DO UPDATE SET calls = guest_calls.calls + 1 WHERE guest_calls.calls < $4 RETURNING calls", [b.host, b.guest, day, b.dailyCalls]);
			return (r.rowCount ?? 0) > 0;
		});
	}

	/** Counts one message of a bot's guest; false once their day's messages are used up. A circle's visits are the member's own messages and have no limit here. */
	async countMessage(guest: string): Promise<boolean> {
		const joined = await this.db.owner(guest, async (tx) => (await tx.query("SELECT host_owner, bot_id FROM pim_app.guest_bots WHERE owner_id = $1", [guest])).rows[0]);
		if (!joined) return true;
		const bot = await this.liveBot(joined.bot_id).catch(() => null);
		if (!bot) return false;
		const limit = bot.settings.dailyMessages === undefined ? BOT_DAILY_MESSAGES : bot.settings.dailyMessages;
		if (limit === null) return true;
		const day = this.now().toISOString().slice(0, 10);
		return this.db.owner(joined.host_owner, async (tx) => {
			const r = await tx.query("INSERT INTO pim_app.guest_calls (owner_id, guest, day, messages) VALUES ($1,$2,$3,1) ON CONFLICT (owner_id, guest, day) DO UPDATE SET messages = guest_calls.messages + 1 WHERE guest_calls.messages < $4 RETURNING messages", [joined.host_owner, guest, day, limit]);
			return (r.rowCount ?? 0) > 0;
		});
	}

	async log(b: Boundary, tool: string, outcome: "ran" | "asked" | "refused", summary: string): Promise<void> {
		await this.db.owner(b.host, async (tx) => {
			await tx.query("INSERT INTO pim_app.guest_activity (owner_id, guest, username, audience, tool, outcome, summary) VALUES ($1,$2,$3,$4,$5,$6,$7)", [b.host, b.guest, b.guestName, b.audience, tool, outcome, summary.slice(0, 300)]);
			await tx.query("DELETE FROM pim_app.guest_activity WHERE owner_id = $1 AND id <= (SELECT max(id) FROM pim_app.guest_activity WHERE owner_id = $1) - $2", [b.host, ACTIVITY_KEPT]);
		});
	}

	/** What the host's guests did, newest first, in the web app's shape. */
	async activity(host: string) {
		return this.db.owner(host, async (tx) => (await tx.query("SELECT id, at, username, audience, tool, outcome, summary FROM pim_app.guest_activity ORDER BY id DESC LIMIT 100")).rows.map((r) => ({ id: Number(r.id), at: (r.at as Date).getTime(), username: r.username as string, circle: (r.audience as string).replace(/^(bot|circle):/, ""), tool: r.tool as string, outcome: r.outcome as "ran" | "asked" | "refused", summary: r.summary as string })));
	}

	// ---- approvals ----

	/**
	 * A guest's call that asks first, filed on the host. Its id is a digest of who, where and which call, so a replayed call finds the same approval and never files
	 * a second. It expires in a day and is denied then. The arguments name the guest's task and chat, so the host's decision is carried to them.
	 */
	async file(b: Boundary, input: { chat: string; taskId: string; callId: string; connector: string; service: string; tool: string; arguments: unknown; resource: Record<string, string> }): Promise<{ id: string; state: string }> {
		const id = `g-${createHash("sha256").update(`${b.guest}\n${input.chat}\n${input.callId}`).digest("hex").slice(0, 32)}`;
		const args = { taskId: input.taskId, callId: input.callId, guestOwner: b.guest, guestChat: input.chat, connector: input.connector, service: input.service, tool: input.tool, arguments: input.arguments, summary: `${b.guestName} asks to use ${input.tool} of ${input.service}`, requestedBy: { ownerId: b.guest, username: b.guestName, circle: b.circleId ?? b.botId ?? "", circleName: b.label, ...(b.kind === "bot" ? { bot: b.botId } : {}) }, resource: input.resource };
		return this.db.owner(b.host, async (tx) => {
			await tx.query("INSERT INTO pim_app.approvals (id, owner_id, public_chat_id, tool, args, timeout_policy, expires_at) VALUES ($1,$2,NULL,'connector:call',$3,'deny',$4) ON CONFLICT DO NOTHING", [id, b.host, JSON.stringify(args), new Date(this.now().getTime() + GUEST_APPROVAL_MS)]);
			return { id, state: (await tx.query("SELECT state FROM pim_app.approvals WHERE id = $1", [id])).rows[0].state as string };
		});
	}

	/**
	 * Setting "always approve" on a guest's approval makes the tool On for that bot's or circle's audience, and settles the audience's other waiting calls of it. Never for a
	 * tool that is destructive: that one asks every time.
	 */
	async alwaysFor(host: string, approvalId: string): Promise<{ settled: string[] }> {
		return this.db.owner(host, async (tx) => {
			const a = (await tx.query("SELECT args FROM pim_app.approvals WHERE id = $1 AND tool = 'connector:call'", [approvalId])).rows[0];
			const r = a?.args?.requestedBy;
			const connector = a?.args?.resource?.connector;
			const tool = a?.args?.resource?.tool;
			if (!r || typeof connector !== "string" || typeof tool !== "string") return { settled: [] };
			const discovered = ((await tx.query("SELECT discovered_tools FROM pim_app.connectors WHERE id = $1", [connector])).rows[0]?.discovered_tools ?? []) as { name: string; definition?: string; annotations?: { destructiveHint?: boolean } }[];
			const found = discovered.find((t) => t.name === tool);
			if (found?.annotations?.destructiveHint === true) return { settled: [] };
			const audience = r.bot ? `bot:${r.bot}` : `circle:${r.circle}`;
			if (audience.startsWith("circle:")) {
				await tx.query("INSERT INTO pim_app.tool_permissions (owner_id, audience, app, tool, permission, definition) VALUES ($1,$2,$3,$4,'on',$5) ON CONFLICT (owner_id, audience, app, tool) DO UPDATE SET permission = 'on', definition = excluded.definition, updated_at = now()", [host, audience, connector, tool, found?.definition ?? null]);
			} else {
				const b = (await tx.query("SELECT settings FROM pim_app.bots WHERE id = $1 AND owner_id = $2", [r.bot, host])).rows[0];
				if (b) await tx.query("UPDATE pim_app.bots SET settings = $3 WHERE id = $1 AND owner_id = $2", [r.bot, host, JSON.stringify({ ...b.settings, ask: ((b.settings.ask ?? []) as string[]).filter((t) => t !== tool) })]);
			}
			const same = (await tx.query("SELECT id FROM pim_app.approvals WHERE state = 'waiting' AND id <> $1 AND tool = 'connector:call' AND args->'resource'->>'connector' = $2 AND args->'resource'->>'tool' = $3 AND coalesce(args->'requestedBy'->>'bot', args->'requestedBy'->>'circle') = $4", [approvalId, connector, tool, r.bot ?? r.circle])).rows.map((x) => x.id as string);
			return { settled: same };
		});
	}
}
