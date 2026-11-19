/**
 * What the web app shows of sharing a space with other people: circles (who is in them, whether they are paused, what memory they may read), the visits a circle's
 * members make to a host's space, what a host's guests did, and a guest's own bot. The tools a circle or a bot grants are the Guests service's (`@pim/v2-app/guests`);
 * these routes are the host's and the member's screens over the same tables.
 */
import type { App } from "@pim/v2-app/app";
import { BadRequestError, NotFoundError, PimError, RefusedError } from "@pim/v2-app/errors";
import { type Route, route } from "@pim/v2-app/http";
import type { Principal } from "@pim/v2-contracts/identity";
import { newId } from "@pim/v2-app/ids";
import { deleted, ms, ok } from "./admin-util.ts";

/** v1's limits: circles a person may have, people across them, and a circle's name. */
export const MAX_CIRCLES = 20;
export const MAX_MEMBERS = 200;
export const MAX_NAME = 40;
const SCOPE = /^[a-z0-9][a-z0-9-]{0,39}$/;

const norm = (username: string) => username.trim().toLowerCase().replace(/^@/, "");

export function guestRoutes(): Route[] {
	const mine = async (app: App, p: Principal, write = false) => {
		await app.identity.authz.enforce(p, write ? "api:write" : "api:read");
		if ((await app.identity.authz.account(p.ownerId))?.role === "guest") throw new RefusedError("A guest's account only chats with the bot it joined through.", "guest");
	};

	const circlesOf = async (app: App, ownerId: string, where = "", params: unknown[] = []) =>
		app.db.owner(ownerId, async (tx) => {
			const rows = (await tx.query(`SELECT id, name, members, enabled, memory_scopes, members_at, created_at FROM pim_app.circles WHERE owner_id = $1 ${where} ORDER BY created_at, id`, [ownerId, ...params])).rows;
			const ids = [...new Set(rows.flatMap((r) => r.members as string[]))];
			const names = new Map<string, string>((ids.length ? (await tx.query("SELECT owner_id, username FROM pim_app.accounts WHERE owner_id = ANY($1)", [ids])).rows : []).map((a) => [a.owner_id as string, a.username as string]));
			return rows.map((r) => ({
				id: r.id as string, name: r.name as string, enabled: r.enabled as boolean, memoryScopes: r.memory_scopes as string[], createdAt: ms(r.created_at as Date),
				members: (r.members as string[]).map((m) => ({ ownerId: m, username: names.get(m) ?? m, addedAt: Number((r.members_at as Record<string, number>)[m] ?? ms(r.created_at as Date)) })),
			}));
		});
	const one = async (app: App, ownerId: string, id: string) => {
		const found = (await circlesOf(app, ownerId, "AND id = $2", [id]))[0];
		if (!found) throw new NotFoundError("No such circle");
		return found;
	};
	const named = (v: unknown) => {
		if (typeof v !== "string" || !v.trim() || v.trim().length > MAX_NAME) throw new BadRequestError(`A circle needs a name of up to ${MAX_NAME} characters`);
		return v.trim();
	};

	return [
		// ---- circles (host side) ----
		route("GET", "/api/circles/activity", async ({ app, principal }) => {
			const p = await principal();
			await mine(app, p);
			return ok({ activity: await app.guests.activity(p.ownerId) });
		}),
		route("GET", "/api/circles", async ({ app, principal }) => {
			const p = await principal();
			await mine(app, p);
			return ok({ circles: await circlesOf(app, p.ownerId) });
		}),
		route("POST", "/api/circles", async ({ app, principal, json }) => {
			const p = await principal();
			await mine(app, p, true);
			const name = named((await json()).name);
			const id = newId("ci");
			await app.db.owner(p.ownerId, async (tx) => {
				if ((await tx.query("SELECT count(*)::int AS n FROM pim_app.circles WHERE owner_id = $1", [p.ownerId])).rows[0].n >= MAX_CIRCLES) throw new PimError(429, "too_many_circles", `You can have up to ${MAX_CIRCLES} circles.`);
				await tx.query("INSERT INTO pim_app.circles (id, owner_id, name) VALUES ($1,$2,$3)", [id, p.ownerId, name]);
			});
			return ok(await one(app, p.ownerId, id), 201);
		}),
		route("PUT", "/api/circles/:id", async ({ app, principal, params, json }) => {
			const p = await principal();
			await mine(app, p, true);
			const b = await json();
			if (b.memoryScopes !== undefined && !(Array.isArray(b.memoryScopes) && b.memoryScopes.length <= 20 && b.memoryScopes.every((s: unknown) => typeof s === "string" && (SCOPE.test(s) || s === "everyone")))) throw new BadRequestError("memoryScopes is a list of scope names, such as everyone");
			if (b.enabled !== undefined && typeof b.enabled !== "boolean") throw new BadRequestError("enabled is true or false");
			const name = b.name === undefined ? null : named(b.name);
			const scopes = b.memoryScopes === undefined ? null : [...new Set<string>(b.memoryScopes)];
			const changed = await app.db.owner(p.ownerId, async (tx) => (await tx.query("UPDATE pim_app.circles SET name = coalesce($3, name), enabled = coalesce($4, enabled), memory_scopes = coalesce($5, memory_scopes) WHERE id = $1 AND owner_id = $2", [params[0], p.ownerId, name, b.enabled ?? null, scopes])).rowCount);
			if (!changed) throw new NotFoundError("No such circle");
			return ok(await one(app, p.ownerId, params[0]!));
		}),
		route("DELETE", "/api/circles/:id", async ({ app, principal, params }) => {
			const p = await principal();
			await mine(app, p, true);
			await app.sharing.deleteCircle(p, params[0]!);
			// What the circle was allowed to use goes with it.
			await app.db.owner(p.ownerId, (tx) => tx.query("DELETE FROM pim_app.tool_permissions WHERE audience = $1", [`circle:${params[0]}`]));
			return deleted();
		}),
		route("POST", "/api/circles/:id/members", async ({ app, principal, params, json }) => {
			const p = await principal();
			await mine(app, p, true);
			const username = norm(String((await json()).username ?? ""));
			const target = await app.db.anonymous(async (tx) => (await tx.query("SELECT owner_id, role, status FROM pim_app.accounts WHERE username = $1", [username])).rows[0]);
			// Someone who is active and not a guest; anything else is "no one by that name", so the answer does not say who exists.
			if (!target || target.status !== "active" || target.role === "guest") throw new NotFoundError("No one by that name");
			if (target.owner_id === p.ownerId) throw new BadRequestError("You are in your own circles already");
			await app.db.owner(p.ownerId, async (tx) => {
				const circle = (await tx.query("SELECT id FROM pim_app.circles WHERE id = $1 AND owner_id = $2", [params[0], p.ownerId])).rows[0];
				if (!circle) throw new NotFoundError("No such circle");
				const total = (await tx.query("SELECT coalesce(sum(cardinality(members)), 0)::int AS n, bool_or($2 = ANY (members)) AS present FROM pim_app.circles WHERE owner_id = $1", [p.ownerId, target.owner_id])).rows[0];
				if (!total.present && total.n >= MAX_MEMBERS) throw new PimError(429, "too_many_members", `Your circles can hold up to ${MAX_MEMBERS} people.`);
				// A person is in one circle at most: adding them here moves them.
				await tx.query("UPDATE pim_app.circles SET members = array_remove(members, $2), members_at = members_at - $2 WHERE owner_id = $1 AND id <> $3", [p.ownerId, target.owner_id, params[0]]);
				await tx.query("UPDATE pim_app.circles SET members = CASE WHEN $2 = ANY (members) THEN members ELSE members || $2 END, members_at = CASE WHEN members_at ? $2 THEN members_at ELSE members_at || jsonb_build_object($2::text, $4::bigint) END WHERE owner_id = $1 AND id = $3", [p.ownerId, target.owner_id, params[0], Date.now()]);
			});
			return ok(await one(app, p.ownerId, params[0]!), 201);
		}),
		route("DELETE", "/api/circles/:id/members/:member", async ({ app, principal, params }) => {
			const p = await principal();
			await mine(app, p, true);
			const n = await app.db.owner(p.ownerId, async (tx) => (await tx.query("UPDATE pim_app.circles SET members = array_remove(members, $3), members_at = members_at - $3 WHERE id = $1 AND owner_id = $2", [params[0], p.ownerId, params[1]])).rowCount);
			if (!n) throw new NotFoundError("No such circle");
			return deleted();
		}),

		// ---- visits (member side): a chat in the member's own space whose tools reach the host's through the circle ----
		route("GET", "/api/visits", async ({ app, principal }) => {
			const p = await principal();
			await mine(app, p);
			const rows = await app.db.owner(p.ownerId, async (tx) => ({
				circles: (await tx.query("SELECT c.owner_id, c.enabled, c.members_at, c.created_at, a.username, a.status, a.role FROM pim_app.circles c JOIN pim_app.accounts a ON a.owner_id = c.owner_id WHERE $1 = ANY (c.members) AND c.owner_id <> $1 ORDER BY c.created_at", [p.ownerId])).rows,
				links: (await tx.query("SELECT host_owner, chat FROM pim_app.visit_links WHERE owner_id = $1", [p.ownerId])).rows,
			}));
			return ok({ visits: rows.circles.filter((c) => c.status === "active" && c.role !== "guest").map((c) => ({ ownerId: c.owner_id, username: c.username, sharedAt: Number((c.members_at as Record<string, number>)[p.ownerId] ?? ms(c.created_at)), available: c.enabled === true, session: rows.links.find((l) => l.host_owner === c.owner_id)?.chat ?? null })) });
		}),
		route("POST", "/api/visits/:username", async ({ app, principal, params }) => {
			const p = await principal();
			await mine(app, p, true);
			const host = await app.db.anonymous(async (tx) => (await tx.query("SELECT owner_id, username, role, status FROM pim_app.accounts WHERE username = $1", [norm(params[0]!)])).rows[0]);
			if (!host || host.status !== "active" || host.role === "guest" || host.owner_id === p.ownerId) throw new NotFoundError("No one by that name");
			const circle = await app.db.owner(host.owner_id, async (tx) => (await tx.query("SELECT enabled FROM pim_app.circles WHERE owner_id = $1 AND $2 = ANY (members)", [host.owner_id, p.ownerId])).rows[0]);
			if (!circle) throw new RefusedError(`${host.username} doesn't share their space with you.`, "not_a_member");
			if (!circle.enabled) throw new RefusedError(`${host.username} has paused sharing.`, "paused");
			const existing = await app.db.owner(p.ownerId, async (tx) => (await tx.query("SELECT chat FROM pim_app.visit_links WHERE owner_id = $1 AND host_owner = $2", [p.ownerId, host.owner_id])).rows[0]);
			if (existing) return ok({ session: existing.chat as string });
			const chat = await app.conversations.create(p, { title: `${host.username}'s space` });
			await app.db.owner(p.ownerId, (tx) => tx.query("INSERT INTO pim_app.visit_links (owner_id, host_owner, chat) VALUES ($1,$2,$3) ON CONFLICT DO NOTHING", [p.ownerId, host.owner_id, chat]));
			return ok({ session: (await app.db.owner(p.ownerId, async (tx) => (await tx.query("SELECT chat FROM pim_app.visit_links WHERE owner_id = $1 AND host_owner = $2", [p.ownerId, host.owner_id])).rows[0])).chat as string }, 201);
		}),

		// ---- a guest's own bot ----
		route("GET", "/api/bot", async ({ app, principal }) => {
			const p = await principal();
			await app.identity.authz.enforce(p, "api:read");
			const g = await app.guests.guestBot(p.ownerId);
			if (!g.joined) return ok({ bot: null, agent: null });
			const card = g.bot && { id: g.bot.id, author: g.bot.hostName, authorName: null, name: g.bot.name, description: g.bot.snapshot?.description ?? g.bot.snapshot?.agent?.description ?? "", symbol: g.bot.snapshot?.agent?.emoji ?? null, color: g.bot.snapshot?.agent?.color ?? null, icon: g.bot.snapshot?.agent?.icon || g.bot.snapshot?.icon ? g.bot.sharedAt.getTime() : null, dailyMessages: g.bot.settings.dailyMessages === undefined ? 50 : g.bot.settings.dailyMessages, dailyToolCalls: g.bot.settings.dailyToolCalls === undefined ? 20 : g.bot.settings.dailyToolCalls };
			return ok({ bot: card, agent: g.agent });
		}),
	];
}
