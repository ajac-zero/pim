/**
 * The deployment's directory of accounts and of what Pim brings, as the admin screens and the admin's majordomo read it: the accounts (paged, by status, one by name),
 * the deployment's numbers, and the built-in apps with the admin's switch for each. Built-in apps are the ones Pim brings itself (Notes); every one is on until the admin
 * turns it off for everyone, and an app that is off is not offered to anyone's agents or shown in anyone's sidebar. The connectors the admin added to the directory are in
 * `admin-screens.ts` and `admin-gallery.ts` (the instance settings' `custom_apps`).
 */
import type { App } from "@pim/v2-app/app";
import { BadRequestError, NotFoundError } from "@pim/v2-app/errors";
import { route, type Route } from "@pim/v2-app/http";
import type { Principal } from "@pim/v2-contracts/identity";
import { ms, ok } from "./admin-util.ts";
import { computeReport, usageReport } from "./usage.ts";

export const BUILTIN_APPS = [{ id: "notes", name: "Notes", description: "Documents people write with their agents, live, with diagrams and drawings in them." }] as const;
export const DISABLED_BUILTIN_KEY = "disabled_builtin_apps";

const STATUSES = ["pending", "active", "suspended", "deleting", "deleted"];
const admin = (app: App, p: Principal, action: string) => app.identity.authz.enforce(p, action);

/** The built-in apps the admin turned off. */
export const disabledBuiltins = async (app: App): Promise<string[]> => {
	const v = (await app.db.anonymous(async (tx) => (await tx.query("SELECT value FROM pim_app.instance_settings WHERE key = $1", [DISABLED_BUILTIN_KEY])).rows[0]))?.value;
	return Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : [];
};

const member = (r: Record<string, any>) => ({ ownerId: r.owner_id, username: r.username, role: r.role, status: r.status, createdAt: ms(r.created_at), activatedAt: ms(r.activated_at), statusReason: r.status_reason ?? null });
const COLUMNS = "owner_id, username, role, status, created_at, activated_at, status_reason, bot";

export function adminDirectoryRoutes(): Route[] {
	const apps = async (app: App) => {
		const off = await disabledBuiltins(app);
		return BUILTIN_APPS.map((b) => ({ ...b, enabled: !off.includes(b.id) }));
	};
	return [
		// ---- the account directory ----
		route("GET", "/api/admin/accounts", async ({ app, principal, url }) => {
			await admin(app, await principal(), "admin:accounts");
			const limit = Math.min(Math.max(Number(url.searchParams.get("limit") ?? 100) || 100, 1), 500);
			const status = url.searchParams.get("status");
			if (status && !STATUSES.includes(status)) throw new BadRequestError(`status is one of ${STATUSES.join(", ")}`);
			const after = url.searchParams.get("after");
			const rows = await app.db.anonymous(async (tx) => (await tx.query(
				`SELECT ${COLUMNS} FROM pim_app.accounts WHERE ($1::text IS NULL AND status <> 'deleted' OR status = $1)
				 AND ($2::text IS NULL OR (created_at, username) > (SELECT created_at, username FROM pim_app.accounts WHERE username = $2))
				 ORDER BY created_at, username LIMIT $3`, [status, after, limit + 1])).rows);
			return ok({ accounts: rows.slice(0, limit).map(member), next: rows.length > limit ? rows[limit - 1]!.username : null });
		}),
		// One account with what it used and what is left to erase when it is going: as v1's `{ account, usage, compute, cleanup }`, with the account's own fields flat as before.
		route("GET", "/api/admin/accounts/:username", async ({ app, principal, params }) => {
			await admin(app, await principal(), "admin:accounts");
			const r = await app.db.anonymous(async (tx) => (await tx.query(`SELECT ${COLUMNS} FROM pim_app.accounts WHERE username = $1`, [params[0]!.toLowerCase()])).rows[0]);
			if (!r) throw new NotFoundError("No such account");
			const live = r.status === "active" || r.status === "suspended";
			return ok({
				...member(r), guest: r.bot === true,
				usage: live ? await usageReport(app, r.owner_id) : null,
				compute: live ? await computeReport(app, r.owner_id).catch(() => null) : null,
				cleanup: r.status === "deleting" ? { kind: "delete", requestedAt: ms(r.status_changed_at), attempts: 0 } : null,
			});
		}),
		// The accounts by status as before, with what an operator watches: registrations in the last day, invites still unused (this admin's), and accounts still being erased
		// (`failing` are the ones that have been for more than a day).
		route("GET", "/api/admin/stats", async ({ app, principal }) => {
			const p = await principal();
			await admin(app, p, "admin:accounts");
			const n = await app.db.anonymous(async (tx) => (await tx.query("SELECT count(*) FILTER (WHERE status = 'active')::int AS active, count(*) FILTER (WHERE status = 'suspended')::int AS suspended, count(*) FILTER (WHERE status = 'pending')::int AS pending, count(*) FILTER (WHERE status = 'active' AND role = 'admin')::int AS admins, count(*) FILTER (WHERE status = 'active' AND role = 'guest')::int AS guests, count(*) FILTER (WHERE status IN ('deleting', 'deleted'))::int AS removed, count(*) FILTER (WHERE status = 'deleting')::int AS deleting, count(*) FILTER (WHERE status = 'deleting' AND status_changed_at < now() - interval '1 day')::int AS stuck, count(*) FILTER (WHERE created_at >= now() - interval '1 day')::int AS recent FROM pim_app.accounts")).rows[0]);
			const unused = await app.db.owner(p.ownerId, async (tx) => (await tx.query("SELECT count(*)::int AS n FROM pim_app.invites WHERE used_at IS NULL OR NOT EXISTS (SELECT 1 FROM pim_app.accounts WHERE owner_id = invites.used_by)")).rows[0].n as number);
			const { recent, deleting, stuck, ...accounts } = n;
			return ok({ accounts, registrationsLastDay: recent, invitesUnused: unused, cleanups: { queued: deleting, failing: stuck } });
		}),

		// ---- what Pim brings ----
		route("GET", "/api/builtin-apps", async ({ app, principal }) => {
			await app.identity.authz.enforce(await principal(), "api:read");
			return ok({ apps: (await apps(app)).filter((a) => a.enabled).map(({ enabled: _e, ...rest }) => rest) });
		}),
		route("GET", "/api/admin/builtin-apps", async ({ app, principal }) => {
			await admin(app, await principal(), "admin:apps");
			return ok({ apps: await apps(app) });
		}),
		route("PUT", "/api/admin/builtin-apps/:id", async ({ app, principal, params, json }) => {
			await admin(app, await principal(), "admin:apps");
			if (!BUILTIN_APPS.some((b) => b.id === params[0])) throw new NotFoundError("No such built-in app");
			const { enabled } = await json();
			if (typeof enabled !== "boolean") throw new BadRequestError("enabled is true or false");
			const off = new Set(await disabledBuiltins(app));
			if (enabled) off.delete(params[0]!);
			else off.add(params[0]!);
			await app.db.anonymous((tx) => tx.query("INSERT INTO pim_app.instance_settings (key, value) VALUES ($1, $2) ON CONFLICT (key) DO UPDATE SET value = $2", [DISABLED_BUILTIN_KEY, JSON.stringify([...off])]));
			return ok({ apps: await apps(app) });
		}),
	];
}
