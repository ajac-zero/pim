import { randomUUID } from "node:crypto";
import { type IncomingMessage, type ServerResponse, createServer } from "node:http";
import type pg from "pg";
import { type Principal, authenticate, createApiToken, revokeSession, revokeToken, tenantOfToken } from "./auth.ts";
import { enforce, Forbidden, createGrant, revokeGrant, type ExecutionKind } from "./authz.ts";
import { CommandConflict, type Hints, acceptCommand, createChat, decideApproval, noHints } from "./commands.ts";
import { withTenant } from "./db.ts";
import type { IdAllocator } from "./ids.ts";
import type { Metrics } from "./metrics.ts";
import { chatSnapshot } from "./snapshot.ts";

export interface GateDeps {
	pool: pg.Pool;
	ids: IdAllocator;
	hints?: Hints;
	metrics?: Metrics;
	/** Requests in flight beyond this are shed with 503, so a burst cannot queue unboundedly behind the database. */
	maxInflight?: number;
	maxBodyBytes?: number;
	requestTimeoutMs?: number;
}

class HttpError extends Error {
	constructor(
		readonly status: number,
		message: string,
		readonly code = "error",
	) {
		super(message);
	}
}

const json = (res: ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}) => {
	const text = JSON.stringify(body);
	res.writeHead(status, { "content-type": "application/json", "content-length": Buffer.byteLength(text), ...headers });
	res.end(text);
};

async function readBody(req: IncomingMessage, limit: number): Promise<any> {
	const chunks: Buffer[] = [];
	let size = 0;
	for await (const chunk of req) {
		size += (chunk as Buffer).length;
		if (size > limit) throw new HttpError(413, "Request body too large", "too_large");
		chunks.push(chunk as Buffer);
	}
	if (size === 0) return {};
	try {
		return JSON.parse(Buffer.concat(chunks).toString("utf8"));
	} catch {
		throw new HttpError(400, "Body is not JSON", "bad_json");
	}
}

const str = (value: unknown, name: string, max = 200): string => {
	if (typeof value !== "string" || value.length === 0 || value.length > max) throw new HttpError(400, `${name} must be a non-empty string up to ${max} characters`, "bad_request");
	return value;
};

/** The bounded HTTP surface: auth, commands, settings, snapshots. It never waits for a model, a provision or an owner. */
export function createGate(deps: GateDeps) {
	const hints = deps.hints ?? noHints;
	let inflight = 0;

	async function principalOf(req: IncomingMessage): Promise<Principal> {
		const header = req.headers.authorization;
		const secret = header?.startsWith("Bearer ") ? header.slice(7) : undefined;
		const tenantId = secret ? tenantOfToken(secret) : undefined;
		const principal = secret && tenantId ? await authenticate(deps.pool, tenantId, secret) : undefined;
		if (!principal) throw new HttpError(401, "Not signed in", "unauthorized");
		return principal;
	}

	async function route(req: IncomingMessage, res: ServerResponse, url: URL): Promise<void> {
		const { pathname } = url;
		const method = req.method ?? "GET";
		if (pathname === "/healthz") return json(res, 200, { ok: true });
		if (pathname === "/readyz") {
			await deps.pool.query("SELECT 1");
			return json(res, 200, { ok: true });
		}
		if (pathname === "/metrics" && deps.metrics) {
			res.writeHead(200, { "content-type": "text/plain; version=0.0.4" });
			return void res.end(await deps.metrics.render());
		}
		const principal = await principalOf(req);
		const actor = { principal };
		const tenantId = principal.tenantId;

		if (method === "POST" && pathname === "/v1/chats") {
			const body = await readBody(req, deps.maxBodyBytes ?? 262_144);
			await enforce(deps.pool, actor, "chat.create", { tenantId });
			const result = await createChat(deps.pool, { tenantId, commandId: str(body.commandId, "commandId", 100), actor: principal.userId, agent: body.agent, firstMessage: typeof body.firstMessage === "string" ? body.firstMessage : undefined, chatId: typeof body.chatId === "string" ? body.chatId : undefined }, hints);
			return json(res, result.duplicate ? 200 : 202, { chatId: result.chatId, duplicate: result.duplicate });
		}
		if (method === "GET" && pathname === "/v1/chats") {
			const rows = await withTenant(deps.pool, tenantId, (q) => q.all("SELECT chat_id AS \"chatId\", title, last_seq AS \"lastSeq\", updated_at AS \"updatedAt\" FROM app.chats WHERE tenant_id = $1 AND created_by = $2 ORDER BY COALESCE(updated_at, created_at) DESC LIMIT 100", tenantId, principal.userId), { readOnly: true });
			return json(res, 200, { chats: rows });
		}
		const chat = /^\/v1\/chats\/([A-Za-z0-9_-]{1,64})\/(messages|snapshot)$/.exec(pathname);
		if (chat) {
			const owner = await withTenant(deps.pool, tenantId, (q) => q.get<{ created_by: string; partition_id: string }>("SELECT created_by, partition_id FROM app.chats WHERE tenant_id = $1 AND chat_id = $2", tenantId, chat[1]), { readOnly: true });
			// Another person's chat is a 404, not a 403: its existence is not revealed.
			if (owner === undefined || (owner.created_by !== principal.userId)) throw new HttpError(404, "No such chat", "not_found");
			if (chat[2] === "messages" && method === "POST") {
				const body = await readBody(req, deps.maxBodyBytes ?? 262_144);
				await enforce(deps.pool, actor, "chat.send", { tenantId, ownerUserId: owner.created_by });
				const commandId = str(body.commandId, "commandId", 100);
				const content = str(body.content, "content", 100_000);
				const receipt = await acceptCommand(deps.pool, { tenantId, commandId, actor: principal.userId, kind: "chat.send", partitionId: owner.partition_id, payload: { chatId: chat[1], content }, signal: { kind: "input" } }, hints);
				return json(res, receipt.duplicate ? 200 : 202, { commandId, duplicate: receipt.duplicate });
			}
			if (chat[2] === "snapshot" && method === "GET") {
				await enforce(deps.pool, actor, "chat.read", { tenantId, ownerUserId: owner.created_by });
				const limit = Math.min(200, Math.max(1, Number(url.searchParams.get("limit") ?? 50) || 50));
				return json(res, 200, await chatSnapshot(deps.pool, deps.ids, tenantId, chat[1]!, limit));
			}
		}
		const approval = /^\/v1\/approvals\/([A-Za-z0-9_-]{1,80})\/decision$/.exec(pathname);
		if (approval && method === "POST") {
			const body = await readBody(req, 4096);
			await enforce(deps.pool, actor, "approval.decide", { tenantId });
			const outcome = await decideApproval(deps.pool, { tenantId, approvalId: approval[1]!, decidedBy: principal.userId, approve: body.approve === true }, hints);
			return json(res, outcome === "unknown" ? 404 : 200, { outcome });
		}
		if (method === "POST" && pathname === "/v1/tokens") {
			// Session-auth security control: a token cannot mint tokens, so a leaked token cannot widen itself.
			if (principal.via !== "session") throw new HttpError(403, "Tokens are created from a signed-in session", "forbidden");
			const body = await readBody(req, 4096);
			const scopes = Array.isArray(body.scopes) ? body.scopes.map((s: unknown) => str(s, "scope", 60)) : [];
			if (scopes.length === 0) throw new HttpError(400, "A token needs at least one scope", "bad_request");
			const created = await createApiToken(deps.pool, { tenantId, userId: principal.userId, name: str(body.name, "name", 80), scopes, ttlMs: typeof body.ttlMs === "number" ? body.ttlMs : undefined });
			return json(res, 201, created);
		}
		const tokenRoute = /^\/v1\/tokens\/([A-Za-z0-9_-]{1,40})$/.exec(pathname);
		if (tokenRoute && method === "DELETE") {
			if (principal.via !== "session") throw new HttpError(403, "Tokens are revoked from a signed-in session", "forbidden");
			return json(res, (await revokeToken(deps.pool, tenantId, tokenRoute[1]!)) ? 200 : 404, { revoked: true });
		}
		if (method === "POST" && pathname === "/v1/sessions/revoke-all") {
			if (principal.via !== "session") throw new HttpError(403, "Sessions are revoked from a signed-in session", "forbidden");
			return json(res, 200, { revoked: await revokeSession(deps.pool, tenantId, principal.userId, "all") });
		}
		if (method === "POST" && pathname === "/v1/admin/grants") {
			const body = await readBody(req, 8192);
			await createGrant(deps.pool, principal, { grantId: str(body.grantId, "grantId", 80), subjectUser: str(body.subjectUser, "subjectUser", 80), kind: str(body.kind, "kind") as ExecutionKind, pools: body.pools, repos: body.repos, standing: body.standing === true, allowDelegates: body.allowDelegates === true, quotaRuns: body.quotaRuns, spendCapCents: body.spendCapCents });
			return json(res, 201, { ok: true });
		}
		const grantRoute = /^\/v1\/admin\/grants\/([A-Za-z0-9_-]{1,80})$/.exec(pathname);
		if (grantRoute && method === "DELETE") return json(res, 200, { revoked: await revokeGrant(deps.pool, principal, grantRoute[1]!) });
		throw new HttpError(404, "Not found", "not_found");
	}

	return createServer(async (req, res) => {
		const started = performance.now();
		const url = new URL(req.url ?? "/", "http://gate");
		let status = 500;
		const limit = deps.maxInflight ?? 200;
		if (inflight >= limit && url.pathname !== "/healthz") {
			deps.metrics?.inc("pim_http_shed_total");
			return json(res, 503, { error: "busy" }, { "retry-after": "1" });
		}
		inflight++;
		const timeout = setTimeout(() => {
			if (!res.headersSent) json(res, 504, { error: "timeout" });
		}, deps.requestTimeoutMs ?? 10_000);
		try {
			await route(req, res, url);
			status = res.statusCode;
		} catch (error) {
			const requestId = randomUUID();
			if (error instanceof HttpError) {
				status = error.status;
				json(res, error.status, { error: error.code, message: error.message });
			} else if (error instanceof Forbidden) {
				status = 403;
				json(res, 403, { error: "forbidden", message: error.decision.reason });
			} else if (error instanceof CommandConflict) {
				status = 409;
				json(res, 409, { error: "conflict", message: error.message });
			} else {
				// Nothing of the failure's content goes to the client or the metrics.
				status = 500;
				json(res, 500, { error: "internal", requestId });
				console.error(JSON.stringify({ level: "error", requestId, name: (error as Error).name }));
			}
		} finally {
			clearTimeout(timeout);
			inflight--;
			const route = /^\/v1\/[a-z]+/.exec(url.pathname)?.[0] ?? url.pathname;
			deps.metrics?.observe("pim_http_request_seconds", (performance.now() - started) / 1000, { route, method: req.method ?? "GET", status: String(Math.trunc(status / 100)) });
		}
	});
}
