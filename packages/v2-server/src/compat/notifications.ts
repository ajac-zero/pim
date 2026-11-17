/**
 * The bell and the devices: the notifications the web app lists and marks read, and the Web Push subscription routes it calls. What makes the notifications and
 * sends the pushes is `../notifier.ts`, run by the maintenance role.
 */
import { BadRequestError, CapabilityUnavailableError, NotFoundError } from "@pim/v2-app/errors";
import { ok, route, type Route } from "@pim/v2-app/http";
import { validSubscription, vapidFromEnv } from "../push.ts";
import { ms } from "./admin-util.ts";

const SELECT = `SELECT n.id, n.kind, n.public_chat_id, n.title, n.body, n.created_at, n.read_at, a.id AS agent_id, a.emoji, a.color, a.icon_key, a.updated_at AS agent_updated
	FROM pim_app.notifications n
	LEFT JOIN pim_app.conversations c ON c.public_chat_id = n.public_chat_id
	LEFT JOIN pim_app.agents a ON a.owner_id = c.owner_id AND a.id = c.agent_id`;

const view = (r: Record<string, any>) => ({
	id: r.id as string,
	kind: r.kind as string,
	session: (r.public_chat_id as string | null) ?? null,
	agent: r.agent_id ? { id: r.agent_id as string, icon: r.icon_key ? (ms(r.agent_updated) ?? 1) : null, symbol: (r.emoji as string | null) ?? null, color: (r.color as string | null) ?? null } : null,
	title: r.title as string,
	body: r.body as string,
	createdAt: ms(r.created_at),
	readAt: ms(r.read_at),
});

export function notificationRoutes(env: Record<string, string | undefined>): Route[] {
	const keys = vapidFromEnv(env);
	const allowHttp = env.PIM_PUSH_ALLOW_PRIVATE === "1";
	return [
		route("GET", "/api/notifications", async ({ app, principal, url }) => {
			const p = await principal();
			const unread = url.searchParams.get("unread") === "true";
			const rows = await app.db.owner(p.ownerId, async (tx) => (await tx.query(`${SELECT} ${unread ? "WHERE n.read_at IS NULL" : ""} ORDER BY n.created_at DESC LIMIT 100`)).rows);
			return ok({ notifications: rows.map(view) });
		}),
		route("POST", "/api/notifications/:id/read", async ({ app, principal, params }) => {
			const p = await principal();
			const row = await app.db.owner(p.ownerId, async (tx) => {
				await tx.query("UPDATE pim_app.notifications SET read_at = coalesce(read_at, now()) WHERE id = $1", [params[0]]);
				return (await tx.query(`${SELECT} WHERE n.id = $1`, [params[0]])).rows[0];
			});
			if (!row) throw new NotFoundError("No such notification");
			return ok(view(row));
		}),
		// Reading a chat reads what mentioned the person in it, as in v1; the chat's own read state is the application's.
		route("POST", "/api/sessions/:id/read", async ({ app, principal, params }) => {
			const p = await principal();
			await app.conversations.markRead(p, params[0]!);
			await app.db.owner(p.ownerId, (tx) => tx.query("UPDATE pim_app.notifications SET read_at = now() WHERE public_chat_id = $1 AND kind = 'mention' AND read_at IS NULL", [params[0]]));
			return ok({ ok: true });
		}),
		route("GET", "/api/push/key", async ({ principal }) => {
			await principal();
			if (!keys) throw new CapabilityUnavailableError("push", "this Pim has no push keys: set PIM_VAPID_PUBLIC_KEY and PIM_VAPID_PRIVATE_KEY");
			return ok({ publicKey: keys.publicKey });
		}),
		route("PUT", "/api/push/subscription", async ({ app, principal, json }) => {
			const p = await principal();
			if (!keys) throw new CapabilityUnavailableError("push", "this Pim has no push keys: set PIM_VAPID_PUBLIC_KEY and PIM_VAPID_PRIVATE_KEY");
			const body = await json();
			if (!validSubscription(body, allowHttp)) throw new BadRequestError("That is not a push subscription");
			await app.db.owner(p.ownerId, (tx) =>
				tx.query("INSERT INTO pim_app.push_subscriptions (owner_id, endpoint, p256dh, auth) VALUES ($1,$2,$3,$4) ON CONFLICT (owner_id, endpoint) DO UPDATE SET p256dh = $3, auth = $4", [p.ownerId, body.endpoint, body.p256dh, body.auth]),
			);
			return ok({ subscribed: true });
		}),
		route("DELETE", "/api/push/subscription", async ({ app, principal, json }) => {
			const p = await principal();
			const { endpoint } = (await json()) as { endpoint?: unknown };
			if (typeof endpoint !== "string") throw new BadRequestError("endpoint is required");
			await app.db.owner(p.ownerId, (tx) => tx.query("DELETE FROM pim_app.push_subscriptions WHERE endpoint = $1", [endpoint]));
			return ok({ subscribed: false });
		}),
	];
}
