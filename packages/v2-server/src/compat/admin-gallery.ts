/**
 * The web app's gallery and sharing surface: templates, the icons of agents, templates and bots, an agent's public bot, the connector
 * directory and the model catalog. Templates, bots and published agents are the application's (`pim_app.templates`, `bots`); an uploaded
 * icon is an object under its owner whose key the agent's `icon_key` holds, served by the application's own `Objects`.
 */
import type { App } from "@pim/v2-app/app";
import { BadRequestError, NotFoundError } from "@pim/v2-app/errors";
import { route, type Route } from "@pim/v2-app/http";
import type { Principal } from "@pim/v2-contracts/identity";
import { bytesReply, deleted, isUploadedIcon, ms, ok } from "./admin-util.ts";

type Env = Readonly<Record<string, string | undefined>>;

/** What the instance's admin added to the connector directory, kept in the instance settings. */
export type CustomApp = { id: string; name: string; description: string; url: string; icon: string | null; category: string | null };
export const CUSTOM_APPS_KEY = "custom_apps";
export const customApps = async (app: App): Promise<CustomApp[]> => ((await app.db.anonymous(async (tx) => (await tx.query("SELECT value FROM pim_app.instance_settings WHERE key = $1", [CUSTOM_APPS_KEY])).rows[0]))?.value ?? []) as CustomApp[];

/** The models the deployment's AI gateway offers, as the environment names them. */
export const gatewayModels = (env: Env) => (env.PIM_AI_GATEWAY_MODELS ?? "").split(",").map((m) => m.trim()).filter(Boolean);

type TemplateRow = { id: string; owner_id: string; agent_id: string; title: string; bundle: { agent?: { name?: string; instructions?: string; emoji?: string; color?: string }; description?: string; apps?: string[]; icon?: string }; published_at: Date; uses: number; username: string; display_name: string | null };

const TEMPLATE_SQL = "SELECT t.id, t.owner_id, t.agent_id, t.title, t.bundle, t.published_at, t.uses, a.username, pr.display_name FROM pim_app.templates t JOIN pim_app.accounts a ON a.owner_id = t.owner_id LEFT JOIN pim_app.profiles pr ON pr.owner_id = t.owner_id AND pr.published WHERE a.status NOT IN ('deleting', 'deleted')";

const templateOf = (r: TemplateRow) => ({
	id: r.id, author: r.username, authorName: r.display_name, name: r.title, description: r.bundle.description ?? "", instructions: r.bundle.agent?.instructions ?? "",
	apps: r.bundle.apps ?? [], contacts: [] as string[], bundle: [] as unknown[], symbol: r.bundle.agent?.emoji ?? null, color: r.bundle.agent?.color ?? null,
	icon: r.bundle.icon ? ms(r.published_at) : null, publishedAt: ms(r.published_at), uses: r.uses,
});

async function templates(app: App, p: Principal, where = "", params: unknown[] = []) {
	await app.identity.authz.enforce(p, "api:read");
	return (await app.db.owner(p.ownerId, async (tx) => (await tx.query(`${TEMPLATE_SQL}${where} ORDER BY t.published_at DESC LIMIT 100`, params)).rows)) as TemplateRow[];
}

const readIcon = async (p: Principal, bytes: (limit?: number) => Promise<Uint8Array>, type: string | undefined, app: App) => {
	const body = await bytes(5_000_000);
	if (!body.length) throw new BadRequestError("Send the image as the request body");
	return app.objects.put(p, { bytes: body, contentType: type ?? "", purpose: "image", acl: "public" });
};

export function galleryRoutes(env: Env): Route[] {
	/** The agent an uploaded icon belongs to, as its owner sees it. */
	const agentIcon = async (app: App, ownerId: string, agentId: string) => {
		const row = await app.db.owner(ownerId, async (tx) => (await tx.query("SELECT icon_key FROM pim_app.agents WHERE id = $1 AND deleted_at IS NULL", [agentId])).rows[0]);
		if (!row) throw new NotFoundError("No such agent");
		return isUploadedIcon(ownerId, row.icon_key) ? (row.icon_key as string) : null;
	};
	const serveKey = async (app: App, key: string | null) => {
		if (!key) throw new NotFoundError("No icon");
		return bytesReply(await app.objects.serve(null, key));
	};
	const botOf = async (app: App, id: string) => {
		const r = await app.db.anonymous(async (tx) => (await tx.query("SELECT b.id, b.owner_id, b.name, b.agent_id, b.settings, b.created_at, a.username, a.status, pr.display_name FROM pim_app.bots b JOIN pim_app.accounts a ON a.owner_id = b.owner_id LEFT JOIN pim_app.profiles pr ON pr.owner_id = b.owner_id AND pr.published WHERE b.id = $1", [id])).rows[0]);
		if (!r || r.status === "deleted" || r.status === "deleting") throw new NotFoundError();
		return r;
	};
	const sharingOf = async (app: App, p: Principal, origin: string, agentId: string) => {
		const r = await app.db.owner(p.ownerId, async (tx) => {
			const bot = (await tx.query("SELECT id, settings, created_at FROM pim_app.bots WHERE owner_id = $1 AND agent_id = $2", [p.ownerId, agentId])).rows[0];
			if (!bot) return null;
			const guests = (await tx.query("SELECT count(DISTINCT visitor)::int AS n FROM pim_app.visits WHERE bot_id = $1", [bot.id])).rows[0].n as number;
			return { bot, guests };
		});
		if (!r) return null;
		const s = r.bot.settings as { dailyMessages?: number | null; dailyToolCalls?: number | null; model?: { provider: string; id: string } | null; tools?: string[]; ask?: string[] };
		return { id: r.bot.id as string, url: `${origin}/b/${r.bot.id}`, dailyMessages: s.dailyMessages ?? null, dailyToolCalls: s.dailyToolCalls ?? null, model: s.model ?? null, tools: s.tools ?? [], ask: s.ask ?? [], sharedAt: ms(r.bot.created_at), guests: r.guests };
	};

	return [
		// ---- templates ----
		route("GET", "/api/templates", async ({ app, principal, url }) => {
			const q = (url.searchParams.get("q") ?? url.searchParams.get("query") ?? "").toLowerCase().split(/\s+/).filter(Boolean);
			const rows = await templates(app, await principal());
			const found = rows.map(templateOf).filter((t) => q.every((w) => `${t.name} ${t.description} ${t.author}`.toLowerCase().includes(w)));
			return ok({ templates: found.map(({ instructions: _i, ...summary }) => summary) });
		}),
		route("GET", "/api/templates/:id", async ({ app, principal, params }) => {
			const r = (await templates(app, await principal(), " AND t.id = $1", [params[0]!]))[0];
			if (!r) throw new NotFoundError("No such template");
			return ok(templateOf(r));
		}),
		route("GET", "/api/templates/:id/icon", async ({ app, principal, params }) => {
			const r = (await templates(app, await principal(), " AND t.id = $1", [params[0]!]))[0];
			return serveKey(app, r?.bundle.icon ?? null);
		}),
		// A template brings no other agents with it yet, so no bundled agent has an icon.
		route("GET", "/api/templates/:id/agents/:position/icon", async ({ app, principal }) => (await app.identity.authz.enforce(await principal(), "api:read"), serveKey(app, null))),
		// Making a template your own, counted for its author.
		route("POST", "/api/templates/:id/use", async ({ app, principal, params }) => {
			const agent = await app.sharing.useTemplate(await principal(), params[0]!);
			await app.db.lookup(params[0]!, (tx) => tx.query("UPDATE pim_app.templates SET uses = uses + 1 WHERE id = $1", [params[0]!]));
			return ok(agent, 201);
		}),
		// Publishing answers with the template the gallery now shows, and carries the agent's uploaded icon and connectors with it.
		route("POST", "/api/agents/:id/publish", async ({ app, principal, params, json }) => {
			const p = await principal();
			const body = await json();
			const agent = await app.agents.get(p, params[0]!);
			const { id } = await app.sharing.publishTemplate(p, params[0]!, typeof body.title === "string" ? body.title : undefined);
			const icon = await agentIcon(app, p.ownerId, params[0]!);
			await app.db.owner(p.ownerId, (tx) => tx.query("UPDATE pim_app.templates SET bundle = bundle || $2::jsonb WHERE id = $1 AND owner_id = $3", [id, JSON.stringify({ apps: agent.apps, ...(icon ? { icon } : {}) }), p.ownerId]));
			return ok(templateOf((await templates(app, p, " AND t.id = $1", [id]))[0]!), 201);
		}),
		route("DELETE", "/api/agents/:id/publish", async ({ app, principal, params }) => (await app.sharing.unpublishTemplate(await principal(), params[0]!), deleted())),

		// ---- icons ----
		route("GET", "/api/agents/:id/icon", async ({ app, principal, params }) => {
			const p = await principal();
			await app.identity.authz.enforce(p, "api:read");
			return serveKey(app, await agentIcon(app, p.ownerId, params[0]!));
		}),
		route("PUT", "/api/agents/:id/icon", async ({ app, principal, params, bytes, req }) => {
			const p = await principal();
			const before = await agentIcon(app, p.ownerId, params[0]!);
			const { key } = await readIcon(p, bytes, req.headers["content-type"], app);
			const agent = await app.agents.update(p, params[0]!, { icon: key });
			if (before) await app.objects.delete(p, before).catch(() => undefined);
			return ok(agent);
		}),
		route("DELETE", "/api/agents/:id/icon", async ({ app, principal, params }) => {
			const p = await principal();
			const before = await agentIcon(app, p.ownerId, params[0]!);
			const agent = await app.agents.update(p, params[0]!, { icon: null });
			if (before) await app.objects.delete(p, before).catch(() => undefined);
			return ok(agent);
		}),
		route("GET", "/api/bots/:id/icon", async ({ app, params }) => {
			const bot = await botOf(app, params[0]!);
			return serveKey(app, bot.agent_id ? await agentIcon(app, bot.owner_id, bot.agent_id).catch(() => null) : null);
		}),
		// The icon of the agent that asked, shown on its approval.
		route("GET", "/api/approvals/:id/icon", async ({ app, principal, params }) => {
			const p = await principal();
			await app.identity.authz.enforce(p, "api:read");
			const row = await app.db.owner(p.ownerId, async (tx) => (await tx.query("SELECT c.agent_id FROM pim_app.approvals a JOIN pim_app.conversations c ON c.public_chat_id = a.public_chat_id WHERE a.id = $1", [params[0]!])).rows[0]);
			return serveKey(app, row?.agent_id ? await agentIcon(app, p.ownerId, row.agent_id).catch(() => null) : null);
		}),

		// ---- bots ----
		// What a bot's public link shows, to anyone.
		route("GET", "/api/bots/:id", async ({ app, params }) => {
			const bot = await botOf(app, params[0]!);
			const agent = bot.agent_id ? await app.db.owner(bot.owner_id, async (tx) => (await tx.query("SELECT instructions, emoji, color, icon_key FROM pim_app.agents WHERE id = $1 AND deleted_at IS NULL", [bot.agent_id])).rows[0]) : null;
			return ok({ id: bot.id, author: bot.username, authorName: bot.display_name, name: bot.name, description: "", symbol: agent?.emoji ?? null, color: agent?.color ?? null, icon: isUploadedIcon(bot.owner_id, agent?.icon_key) ? ms(bot.created_at) : null });
		}),
		route("GET", "/api/agents/:id/bot", async ({ app, principal, params, origin }) => {
			const p = await principal();
			await app.identity.authz.enforce(p, "api:read");
			const found = await sharingOf(app, p, origin, params[0]!);
			if (!found) throw new NotFoundError("This agent isn't shared as a bot");
			return ok(found);
		}),
		route("PUT", "/api/agents/:id/bot", async ({ app, principal, params, json, origin }) => {
			const p = await principal();
			// Only the admin shares an agent as a bot: anyone may join through its link, and what it shares is the deployment's to give.
			await app.identity.authz.enforce(p, "admin:bots");
			const b = await json();
			const limit = (v: unknown) => (v === null || v === undefined ? null : Number.isInteger(v) && (v as number) >= 0 ? (v as number) : Number.NaN);
			const settings = { dailyMessages: limit(b.dailyMessages), dailyToolCalls: limit(b.dailyToolCalls), model: b.model ?? null, tools: Array.isArray(b.tools) ? b.tools.map(String) : [], ask: Array.isArray(b.ask) ? b.ask.map(String) : [] };
			if (Number.isNaN(settings.dailyMessages) || Number.isNaN(settings.dailyToolCalls)) throw new BadRequestError("Limits are whole numbers or null");
			if (settings.model && (typeof settings.model.provider !== "string" || typeof settings.model.id !== "string")) throw new BadRequestError("model is { provider, id } or null");
			await app.agents.get(p, params[0]!);
			if (!(await sharingOf(app, p, origin, params[0]!))) await app.sharing.createBot(p, params[0]!);
			await app.db.owner(p.ownerId, (tx) => tx.query("UPDATE pim_app.bots SET settings = $3 WHERE owner_id = $1 AND agent_id = $2", [p.ownerId, params[0]!, JSON.stringify(settings)]));
			return ok(await sharingOf(app, p, origin, params[0]!));
		}),
		route("DELETE", "/api/agents/:id/bot", async ({ app, principal, params }) => {
			const p = await principal();
			await app.identity.authz.enforce(p, "admin:bots");
			const n = await app.db.owner(p.ownerId, async (tx) => (await tx.query("DELETE FROM pim_app.bots WHERE owner_id = $1 AND agent_id = $2", [p.ownerId, params[0]!])).rowCount);
			return ok({ deleted: !!n });
		}),
		// What of an agent's a bot can share: the tools of the connectors it uses that their owner has switched on.
		route("GET", "/api/agents/:id/bot-tools", async ({ app, principal, params }) => {
			const p = await principal();
			const agent = await app.agents.get(p, params[0]!);
			const connectors = await app.connectors.list(p);
			const used = connectors.filter((c) => agent.apps.includes(c.id) || agent.apps.includes(c.name));
			return ok({ tools: used.flatMap((c) => c.enabledTools.map((name) => ({ name, appName: c.name, description: c.discoveredTools.find((t) => t.name === name)?.description ?? "", destructive: false }))) });
		}),

		// ---- the connector directory and the model catalog ----
		route("GET", "/api/app-directory", async ({ app, principal }) => {
			await app.identity.authz.enforce(await principal(), "api:read");
			return ok({ apps: (await customApps(app)).map((c) => ({ ref: `custom/${c.id}`, name: c.name, description: c.description, url: c.url, custom: true, icon: c.icon, category: c.category })) });
		}),
		route("GET", "/api/providers/built-in", async ({ app, principal }) => {
			await app.identity.authz.enforce(await principal(), "api:read");
			const models = gatewayModels(env);
			const info = (id: string) => ({ id, name: id, contextWindow: 128_000, maxTokens: 16_000, images: false, reasoning: false });
			return ok({ providers: models.length ? [{ id: "gateway", name: "AI gateway", models: models.map(info) }] : [] });
		}),
	];
}
