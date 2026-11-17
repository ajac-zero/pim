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
import { MAX_PAGE, sidebarPage, transcriptPage } from "@pim/v2-live/projections/snapshots";
import type { Authenticate, Caller, Handler } from "@pim/v2-forge/http/common";
import type { Pool } from "pg";

/** Shared chats read the same projected transcript a person sees, as that chat's owner. */
export function projectedTranscripts(pool: Pool): TranscriptSource {
	return {
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
				// What the person renamed or deleted is kept on the chat itself; the projection learns of it only from the runtime.
				const kept = new Map((await app.db.owner(p.ownerId, async (tx) => (await tx.query("SELECT public_chat_id::text AS id, title, deleted_at FROM pim_app.conversations WHERE public_chat_id::text = ANY($1)", [page.sessions.map((s) => s.chatId)])).rows)).map((r) => [r.id as string, r]));
				return ok({ ...page, sessions: page.sessions.filter((s) => !kept.get(s.chatId)?.deleted_at).map((s) => ({ ...s, title: kept.get(s.chatId)?.title ?? s.title })) });
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

/** The admin's door to coding authority, through the application's Authorizer (which Forge's tables follow, see `mirrorCodingGrants`). */
export function codingAdminRoutes(): Route[] {
	return [
		{
			method: "POST",
			pattern: /^\/api\/admin\/coding-grants$/,
			run: async ({ app, principal, json }): Promise<Reply> => {
				const b = await json();
				return ok({ grantId: await app.identity.authz.grantCoding(await principal(), { ownerId: String(b.ownerId), permissions: b.permissions ?? [], ...(b.pools ? { pools: b.pools } : {}), ...(b.repositories ? { repositories: b.repositories } : {}), ...(b.quota ? { quota: b.quota } : {}) }) }, 201);
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
