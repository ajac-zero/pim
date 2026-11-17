/**
 * What clients of the HTTP API that are not the web app call, in the shapes v1's reference documents (`docs/reference.md`): the space's root
 * and health, sending a message as `{ content, operationId }` and asking how it went, and reading a chat's messages. The web app's own
 * shapes (`{ commandId, text }`, the snapshots) still answer on the same paths; these accept both.
 */
import { randomUUID } from "node:crypto";
import { BadRequestError } from "@pim/v2-app/errors";
import { ok, type Reply, type Route, route } from "@pim/v2-app/http";
import { transcriptPage } from "@pim/v2-live/projections/snapshots";

/** Message text from what a client sends: a string, or content blocks of which the text ones are joined. */
function textOf(body: Record<string, unknown>): string {
	const content = body.content ?? body.text;
	if (typeof content === "string") return content;
	if (Array.isArray(content)) return content.map((block) => (block && typeof block === "object" && (block as { type?: unknown }).type === "text" ? String((block as { text?: unknown }).text ?? "") : "")).filter(Boolean).join("\n");
	return "";
}

export function apiClientRoutes(): Route[] {
	return [
		route("GET", "/api/health", async () => ok({ name: "pim", ok: true })),
		// The root: what a client learns first. `tools` is empty: the Runner builds each chat's tool list itself, per agent.
		route("GET", "/api", async ({ app, principal }) => {
			const p = await principal();
			await app.identity.authz.enforce(p, "api:read");
			const settings = await app.db.owner(p.ownerId, async (tx) => Object.fromEntries((await tx.query("SELECT key, value FROM pim_app.owner_settings WHERE key IN ('settings.timeZone', 'majordomo_chat')")).rows.map((r) => [r.key, r.value])));
			return ok({ model: null, timeZone: settings["settings.timeZone"] ?? process.env.PIM_TIME_ZONE ?? "UTC", rootSession: settings.majordomo_chat ?? null, tools: [] });
		}),
		route("POST", "/api/sessions/:id/messages", async ({ app, principal, json, params }): Promise<Reply> => {
			const b = await json();
			const text = textOf(b);
			if (!text.trim() && b.payload === undefined) throw new BadRequestError("A message needs content");
			const commandId = String(b.commandId ?? b.operationId ?? `cmd_${randomUUID()}`);
			const admission = await app.conversations.admit(await principal(), { commandId, kind: "user_message", chatId: params[0]!, payload: b.payload ?? { text } });
			return ok({ ...admission, operationId: commandId, session: params[0] }, admission.duplicate ? 200 : 202);
		}),
		// How a sent message went: `pending` until the runtime has taken it, then `committed`. The reply is read from the chat's messages.
		route("GET", "/api/sessions/:id/operations/:op", async ({ app, principal, params }) => {
			const p = await principal();
			await app.identity.authz.enforce(p, "api:read");
			const found = (await app.conversations.pending(p.ownerId, params[0]!, 200)).find((c) => c.commandId === params[1]);
			return ok({ operationId: params[1], session: params[0], status: found ? (found.runtimeCommitted ? "committed" : "pending") : "unknown", ...(found ? { state: found.state } : {}) }, found ? 200 : 404);
		}),
		route("GET", "/api/sessions/:id/messages", async ({ app, principal, params, url }) => {
			const p = await principal();
			await app.identity.authz.enforce(p, "api:read");
			await app.conversations.get(p.ownerId, params[0]!);
			const limit = url.searchParams.has("limit") ? Number(url.searchParams.get("limit")) : undefined;
			const page = await transcriptPage(app.db.pool, p.ownerId, params[0]!, { before: url.searchParams.get("before"), ...(limit === undefined ? {} : { limit }) });
			const pending = (await app.conversations.pending(p.ownerId, params[0]!, 200)).filter((c) => !c.runtimeCommitted);
			return ok({ session: params[0], busy: pending.length > 0 || page.messages.some((m) => m.partial), pending: pending.map((c) => c.commandId), messages: page.messages, nextBefore: page.nextBefore });
		}),
	];
}
