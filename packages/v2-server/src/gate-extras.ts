/**
 * What the Gate serves beyond the application's own routes: the projections' HTTP snapshots (the page loads from them before, and without,
 * a WebSocket), Forge's coding API, and the transcript source shared chats read.
 */
import type { IncomingMessage, ServerResponse } from "node:http";
import { Readable } from "node:stream";
import type { App } from "@pim/v2-app/app";
import { bearerOf, ok, type Reply, type Route } from "@pim/v2-app/http";
import { principalId } from "@pim/v2-app/authz";
import type { TranscriptSource } from "@pim/v2-app/sharing";
import { chatSummary } from "./chat-summary.ts";
import { roomViews } from "./rooms.ts";
import { MAX_PAGE, sidebarPage, transcriptPage } from "@pim/v2-live/projections/snapshots";
import { sharedMessages } from "./shared-chat.ts";
import type { TranscriptMessage } from "@pim/shared/transcript";
import { nameOneUntitled } from "./compat/utility.ts";
import { HARNESSES } from "@pim/v2-forge/harnesses";
import type { ForgeParts } from "./forge-assembly.ts";
import type { Authenticate, Caller, Handler } from "@pim/v2-forge/http/common";
import type { Pool } from "pg";

/** Shared chats and exports read the projected transcript a person sees, as that chat's owner; a public link shows `shared`, the part of it the person read. */
export function projectedTranscripts(pool: Pool): TranscriptSource {
	const source: TranscriptSource = {
		read: async (ownerId, chatId, limit) => (await transcriptPage(pool, ownerId, chatId, { limit })).messages,
		// Page by page back to the first message, so an export is whole however long the chat is.
		readAll: async (ownerId, chatId) => {
			const all: unknown[] = [];
			for (let before: string | null = null; ; ) {
				const page: Awaited<ReturnType<typeof transcriptPage>> = await transcriptPage(pool, ownerId, chatId, { before, limit: MAX_PAGE });
				all.unshift(...page.messages);
				if (!page.nextBefore) return all;
				before = page.nextBefore;
			}
		},
	};
	return { ...source, shared: async (ownerId, chatId) => sharedMessages((await source.readAll!(ownerId, chatId)) as TranscriptMessage[]) };
}

/** `GET /api/snapshot/sidebar`, `/api/snapshot/chat/:id` and `/api/snapshot/coding/:id`: bounded, paginated, read as the caller. */
export function snapshotRoutes(pool: Pool): Route[] {
	const limit = (url: URL) => (url.searchParams.has("limit") ? Number(url.searchParams.get("limit")) : undefined);
	return [
		{
			method: "GET",
			pattern: /^\/api\/snapshot\/sidebar$/,
			run: async ({ app, principal, url }): Promise<Reply> => {
				const p = await principal();
				await app.identity.authz.enforce(p, "api:read");
				const page = await sidebarPage(pool, p.ownerId, { after: url.searchParams.get("after"), ...(limit(url) === undefined ? {} : { limit: limit(url)! }) });
				// What the person renamed, deleted or has read is kept on the chat itself; the projection learns of it only from the runtime. The chat's agent (its
				// majordomo when it has none of its own), its own model and when it began are in the application's table too, and ride in the row's summary,
				// where the app reads them from.
				const chats = (where: string, params: unknown[]) =>
					app.db.owner(p.ownerId, async (tx) => (await tx.query(
						`SELECT c.public_chat_id::text AS id, c.title, c.deleted_at, c.room_of IS NOT NULL AS seat, (c.response_at IS NOT NULL AND (c.read_at IS NULL OR c.read_at < c.response_at)) AS unread, c.model, c.archived_at IS NOT NULL AS archived, c.created_at, c.updated_at, c.response_at, a.id AS agent_id, a.name AS agent_name
						 FROM pim_app.conversations c LEFT JOIN pim_app.agents a ON a.id = coalesce(c.agent_id, (SELECT value #>> '{}' FROM pim_app.owner_settings WHERE key = 'majordomo')) AND a.deleted_at IS NULL
						 WHERE ${where}`, params)).rows);
				const summaryOf = (r: any, own: unknown) => ({ ...(own as Record<string, unknown> | null), ...chatSummary(r) });
				const kept = new Map((await chats("c.public_chat_id::text = ANY($1)", [page.sessions.map((s) => s.chatId)])).map((r) => [r.id as string, r]));
				// A room member's seat is not a chat the person opens; a room's members ride in the host chat's summary.
				const rooms = await roomViews(app, p.ownerId, page.sessions.map((s) => s.chatId));
				const sessions = page.sessions.filter((s) => !kept.get(s.chatId)?.deleted_at && !kept.get(s.chatId)?.seat).map((s) => {
					const row = kept.get(s.chatId);
					const summary = row ? summaryOf(row, s.summary) : s.summary;
					return { ...s, title: row?.title ?? s.title, unread: row?.unread ?? s.unread, ...(row || rooms.has(s.chatId) ? { summary: { ...((summary as object | null) ?? {}), ...(rooms.has(s.chatId) ? { room: rooms.get(s.chatId) } : {}) } } : {}) };
				});
				// The projection learns of a chat only when the Runner first commits to it, a moment after the chat is made. Until then a new chat
				// (the majordomo's welcome chat, right after the first passkey) is listed from the application's own table, so the page opening it finds it.
				if (!url.searchParams.has("after")) {
					const known = new Set(sessions.map((s) => s.chatId));
					const fresh = await chats("c.deleted_at IS NULL AND c.archived_at IS NULL AND c.room_of IS NULL AND c.kind IN ('normal','group') AND c.created_at > now() - interval '10 minutes' ORDER BY c.updated_at DESC LIMIT 20", []);
					for (const r of fresh) if (!known.has(r.id) && !kept.has(r.id)) sessions.unshift({ chatId: r.id, title: r.title, busy: true, unread: false, stalled: false, updatedAt: new Date(r.updated_at).getTime(), summary: summaryOf(r, null) } as (typeof sessions)[number]);
				}
				// A chat with no title is named by the utility model once it is idle and has something said in it (nothing happens with no utility model).
				const named = await nameOneUntitled(app, process.env, p, page.sessions.filter((s) => !s.busy && kept.get(s.chatId) && !kept.get(s.chatId)!.deleted_at).map((s) => ({ id: s.chatId, title: kept.get(s.chatId)!.title })));
				if (named) for (const s of sessions) if (s.chatId === named.id) s.title = named.title;
				return ok({ ...page, sessions });
			},
		},
		{
			method: "GET",
			pattern: /^\/api\/snapshot\/(chat|coding)\/([^/]+)$/,
			run: async ({ app, principal, url, params }): Promise<Reply> => {
				const p = await principal();
				await app.identity.authz.enforce(p, "api:read");
				return ok(await transcriptPage(pool, p.ownerId, params[1]!, { kind: params[0] as "chat" | "coding", before: url.searchParams.get("before"), ...(limit(url) === undefined ? {} : { limit: limit(url)! }) }));
			},
		},
	];
}

/** Forge's handlers speak Fetch `Request` and `Response`; the Gate speaks Node's. */
export function toRequest(req: IncomingMessage, origin: string): Request {
	const headers = new Headers();
	for (const [k, v] of Object.entries(req.headers)) if (v !== undefined) headers.set(k, Array.isArray(v) ? v.join(", ") : v);
	const hasBody = req.method !== "GET" && req.method !== "HEAD";
	return new Request(new URL(req.url ?? "/", origin), { method: req.method ?? "GET", headers, ...(hasBody ? { body: Readable.toWeb(req) as ReadableStream, duplex: "half" } : {}) } as RequestInit);
}

export async function sendResponse(res: ServerResponse, response: Response): Promise<Reply> {
	const headers: Record<string, string> = {};
	response.headers.forEach((v, k) => (headers[k] = v));
	// A live stream (the coding page's) is sent as it is written, not once it ends, which it never does.
	if (response.body && /^application\/x-ndjson\b/.test(headers["content-type"] ?? "")) return { status: response.status, headers, stream: response.body };
	return { status: response.status, headers, raw: new Uint8Array(await response.arrayBuffer()) };
}

/** Who is calling Forge, from the Gate's own credentials; Forge never reads a session itself. */
export function forgeAuthenticator(app: App, secure: boolean): Authenticate {
	return async (request): Promise<Caller | null> => {
		const fake = { headers: Object.fromEntries(request.headers.entries()) } as unknown as IncomingMessage;
		const { bearer, viaCookie } = bearerOf(fake, new URL(request.url), secure);
		if (!bearer) return null;
		const p = await app.identity.authenticate(bearer);
		void principalId;
		return { actor: { ownerId: p.ownerId, role: p.kind === "user" || p.kind === "token" ? p.role : "member", ...(p.kind === "agent" ? { agent: p.agentId } : {}) }, via: viaCookie || p.kind === "user" ? "session" : "token" };
	};
}

/** `/api/coding/**` and the admin pool routes, on whatever Forge handler the host composed. */
export function forgeRoutes(handler: Handler): Route[] {
	const run = async ({ req, origin }: { req: IncomingMessage; origin: string }): Promise<Reply> => {
		const response = await handler(toRequest(req, origin));
		return response ? sendResponse(null as never, response) : { status: 404, body: { error: "not_found" } };
	};
	return ["GET", "POST", "PUT", "PATCH", "DELETE"].flatMap((method) => [
		{ method, pattern: /^\/api\/coding(\/.*)?$/, run },
		{ method, pattern: /^\/api\/admin\/coding(\/.*)?$/, run },
	]);
}

/** What coding can run on here, for the admin's Settings: each harness with whether this deployment can run it and why not, and the pools. */
async function codingAccess(forge: ForgeParts) {
	const pools = (await forge.db.query("select pool_id, enabled from pim_forge.forge_pools order by priority desc, pool_id")).rows.map((r) => ({ id: r.pool_id as string, enabled: r.enabled as boolean }));
	const sandbox = pools.some((p) => p.enabled) ? null : "No sandbox pool is enabled. Pools exist once a sandbox manager is configured (PIM_CODING_MANAGER_URL and PIM_CODING_MANAGER_TOKEN).";
	const amp = !forge.ampConfigured ? "This deployment has no encryption keys (PIM_KEK_*), so people can't save an Amp key." : null;
	return {
		harnesses: HARNESSES.map((id) => {
			const reason = id === "amp" ? amp : sandbox;
			return { id, runsIn: id === "amp" ? "orb" : "sandbox", available: reason === null, reason };
		}),
		pools,
	};
}

/**
 * The admin's door to coding authority, through the application's Authorizer (which Forge's tables follow, see `mirrorCodingGrants`): what coding can run on here,
 * and the grants to list, give and take back.
 */
export function codingAdminRoutes(forge: ForgeParts): Route[] {
	return [
		{
			method: "GET",
			pattern: /^\/api\/admin\/coding-access$/,
			run: async ({ app, principal }): Promise<Reply> => {
				await app.identity.authz.enforce(await principal(), "admin:grants");
				return ok(await codingAccess(forge));
			},
		},
		{
			method: "GET",
			pattern: /^\/api\/admin\/coding-grants$/,
			run: async ({ app, principal }): Promise<Reply> => ok({ grants: await app.identity.authz.listCodingGrants(await principal()) }),
		},
		{
			method: "POST",
			pattern: /^\/api\/admin\/coding-grants$/,
			run: async ({ app, principal, json }): Promise<Reply> => {
				const b = await json();
				const p = await principal();
				await app.identity.authz.enforce(p, "admin:grants");
				// Without pools named, the grant covers the pools there are now, so a sandbox thread can start under it; an Amp thread needs none.
				const pools = b.pools ?? (await codingAccess(forge)).pools.filter((x) => x.enabled).map((x) => x.id);
				return ok({ grantId: await app.identity.authz.grantCoding(p, { ownerId: String(b.ownerId), permissions: b.permissions ?? [], ...(pools.length ? { pools } : {}), ...(b.repositories ? { repositories: b.repositories } : {}), ...(b.quota ? { quota: b.quota } : {}) }) }, 201);
			},
		},
		{
			method: "DELETE",
			pattern: /^\/api\/admin\/coding-grants\/([^/]+)\/([^/]+)$/,
			run: async ({ app, principal, params }): Promise<Reply> => {
				await app.identity.authz.revokeCoding(await principal(), params[0]!, params[1]!);
				return ok({ ok: true });
			},
		},
		{
			method: "POST",
			pattern: /^\/api\/admin\/standing-approvals$/,
			run: async ({ app, principal, json }): Promise<Reply> => {
				const b = await json();
				return ok({ approvalId: await app.identity.authz.grantStanding(await principal(), { ownerId: String(b.ownerId), action: String(b.action), scope: b.scope ?? {}, ...(b.expiresAt ? { expiresAt: new Date(b.expiresAt) } : {}) }) }, 201);
			},
		},
		{
			method: "DELETE",
			pattern: /^\/api\/admin\/standing-approvals\/([^/]+)\/([^/]+)$/,
			run: async ({ app, principal, params }): Promise<Reply> => {
				await app.identity.authz.revokeStanding(await principal(), params[0]!, params[1]!);
				return ok({ ok: true });
			},
		},
	];
}
