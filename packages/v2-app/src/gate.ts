import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { App } from "./app.ts";
import { principalId } from "./authz.ts";
import { BadRequestError, CapabilityUnavailableError, ForbiddenError, httpStatus, NotFoundError } from "./errors.ts";
import type { Principal } from "@pim/v2-contracts/identity";

type Ctx = { app: App; req: IncomingMessage; url: URL; params: string[]; principal: () => Promise<Principal>; json: () => Promise<Record<string, any>>; bytes: () => Promise<Uint8Array> };
type Reply = { status: number; body?: unknown; headers?: Record<string, string>; raw?: Uint8Array };
type Route = { method: string; pattern: RegExp; run: (ctx: Ctx) => Promise<Reply> };

const COOKIE = "pim_session";
const ok = (body: unknown, status = 200): Reply => ({ status, body });
const route = (method: string, path: string, run: Route["run"]): Route => ({ method, pattern: new RegExp(`^${path.replace(/:[a-z]+/g, "([^/]+)").replace(/\*/g, "(.+)")}$`), run });

/**
 * The stateless HTTP service. Every handler is a bounded PostgreSQL transaction: nothing here waits on a model, a Harness, a computer or
 * NATS. Chat commands are admitted into the inbox and answered at once. Errors are the typed ones from errors.ts; anything else is a 500
 * with no detail.
 */
const routes: Route[] = [
	route("GET", "/health", async () => ok({ ok: true })),
	route("GET", "/health/ready", async ({ app }) => {
		await app.db.anonymous((tx) => tx.query("SELECT 1"));
		return ok({ ok: true });
	}),
	route("POST", "/auth/register", async ({ app, json, req }) => {
		const b = await json();
		const account = await app.identity.register({ username: String(b.username ?? ""), invite: b.invite, bootstrap: b.bootstrap, address: req.socket.remoteAddress });
		const session = await app.identity.createSession(account.ownerId, { userAgent: req.headers["user-agent"] });
		return { status: 201, body: { account }, headers: { "set-cookie": `${COOKIE}=${session}; HttpOnly; SameSite=Lax; Path=/; Max-Age=2592000` } };
	}),
	route("POST", "/auth/recover", async ({ app, json }) => {
		const { session, account } = await app.identity.recoverAdmin(String((await json()).claim ?? ""));
		return { status: 200, body: { account }, headers: { "set-cookie": `${COOKIE}=${session}; HttpOnly; SameSite=Lax; Path=/; Max-Age=2592000` } };
	}),
	// Sign-out is server-side: the session row is revoked, so a copied cookie stops working too.
	route("POST", "/auth/sign-out", async ({ app, principal }) => {
		const p = await principal();
		if (p.kind === "user") await app.identity.revokeSession(p.ownerId, principalId(p));
		return { status: 200, body: { ok: true }, headers: { "set-cookie": `${COOKIE}=; HttpOnly; Path=/; Max-Age=0` } };
	}),
	route("GET", "/auth/sessions", async ({ app, principal }) => ok({ sessions: await app.identity.listSessions((await principal()).ownerId) })),
	route("DELETE", "/auth/sessions/:id", async ({ app, principal, params }) => {
		const p = await principal();
		await app.identity.authz.enforce(p, "session:revoke");
		await app.identity.revokeSession(p.ownerId, params[0]!);
		return ok({ ok: true });
	}),
	route("GET", "/api/account", async ({ app, principal }) => {
		const p = await principal();
		await app.identity.authz.enforce(p, "api:read");
		return ok({ account: await app.identity.authz.account(p.ownerId), principal: { kind: p.kind, scopes: p.kind === "token" ? p.scopes : ["*"] } });
	}),
	route("POST", "/api/tokens", async ({ app, principal, json }) => {
		const b = await json();
		return ok(await app.identity.createToken(await principal(), { name: String(b.name ?? "token"), scopes: Array.isArray(b.scopes) ? b.scopes.map(String) : ["api:read"] }), 201);
	}),
	route("DELETE", "/api/tokens/:id", async ({ app, principal, params }) => {
		await app.identity.revokeToken(await principal(), params[0]!);
		return ok({ ok: true });
	}),
	route("POST", "/api/admin/invites", async ({ app, principal, json }) => ok({ invite: await app.identity.createInvite(await principal(), String((await json()).note ?? "")) }, 201)),
	route("POST", "/api/admin/accounts/:owner/status", async ({ app, principal, json, params }) => {
		const b = await json();
		await app.identity.setStatus(await principal(), params[0]!, b.status, String(b.reason ?? ""));
		return ok({ ok: true });
	}),
	route("POST", "/api/admin/registration", async ({ app, principal, json }) => {
		await app.identity.setRegistrationOpen(await principal(), (await json()).open === true);
		return ok({ ok: true });
	}),
	// ---- chats ("sessions" in the API) ----
	route("POST", "/api/sessions", async ({ app, principal, json }) => {
		const b = await json();
		return ok({ id: await app.conversations.create(await principal(), { agentId: b.agentId, title: b.title }) }, 201);
	}),
	route("GET", "/api/sessions/:id", async ({ app, principal, params }) => ok(await app.conversations.get((await principal()).ownerId, params[0]!))),
	route("GET", "/api/sessions/:id/pending", async ({ app, principal, params }) => ok({ commands: await app.conversations.pending((await principal()).ownerId, params[0]!) })),
	route("POST", "/api/sessions/:id/:command", async ({ app, principal, json, params }) => {
		const kinds = { messages: "user_message", abort: "abort", fork: "fork", unarchive: "unarchive", delegate: "delegate" } as const;
		const kind = (kinds as Record<string, (typeof kinds)[keyof typeof kinds]>)[params[1]!];
		if (!kind) throw new NotFoundError();
		const b = await json();
		const admission = await app.conversations.admit(await principal(), { commandId: String(b.commandId ?? ""), kind, chatId: params[0]!, payload: b.payload ?? { text: b.text } });
		return ok(admission, admission.duplicate ? 200 : 202);
	}),
	route("POST", "/api/approvals/:id/decision", async ({ app, principal, json, params }) => {
		await app.approvals.decide(await principal(), params[0]!, (await json()).approve === true);
		return ok({ ok: true });
	}),
	// ---- memories, goals, schedules, notes ----
	route("GET", "/api/memories", async ({ app, principal, url }) => ok({ memories: await app.memories.recall(await principal(), (url.searchParams.get("scope") ?? "everyone").split(","), url.searchParams.get("q") ?? ".") })),
	route("POST", "/api/memories", async ({ app, principal, json }) => {
		const b = await json();
		return ok({ id: await app.memories.remember(await principal(), String(b.scope ?? "everyone"), String(b.title ?? ""), String(b.body ?? "")) }, 201);
	}),
	route("DELETE", "/api/memories/:id", async ({ app, principal, params }) => {
		await app.memories.forget(await principal(), params[0]!);
		return ok({ ok: true });
	}),
	route("POST", "/api/goals", async ({ app, principal, json }) => {
		const b = await json();
		return ok({ id: await app.memories.createGoal(await principal(), String(b.title ?? ""), (b.steps ?? []).map(String)) }, 201);
	}),
	route("POST", "/api/schedules", async ({ app, principal, json }) => ok({ id: await app.schedules.create(await principal(), (await json()) as never) }, 201)),
	route("POST", "/api/notes", async ({ app, principal, json }) => {
		const b = await json();
		return ok({ id: await app.canvas.create(await principal(), String(b.title ?? ""), b.text) }, 201);
	}),
	route("GET", "/api/notes/:id", async ({ app, principal, params }) => {
		const p = await principal();
		await app.identity.authz.enforce(p, "api:read");
		return ok(await app.canvas.read(p.ownerId, params[0]!));
	}),
	route("POST", "/api/notes/:id/edit", async ({ app, principal, json, params }) => {
		const b = await json();
		return ok(await app.canvas.edit(await principal(), params[0]!, Number(b.baseVersion), String(b.find ?? ""), String(b.replace ?? "")));
	}),
	// ---- objects ----
	route("POST", "/api/images", async ({ app, principal, bytes, req }) => ok(await app.objects.put(await principal(), { bytes: await bytes(), contentType: String(req.headers["content-type"] ?? ""), purpose: "image" }), 201)),
	route("GET", "/api/images/*", async ({ app, req, params }) => {
		const p = await app.identity.authenticate(bearerOf(req)).catch(() => null);
		const served = await app.objects.serve(p, params[0]!, req.headers.range);
		return { status: served.status, headers: served.headers, raw: served.body };
	}),
	// ---- hosted apps: public execution still asks the author's account, and needs a backend capability this deployment may lack ----
	route("GET", "/hosted/:username/*", async ({ app, params }) => {
		const owner = await app.db.anonymous(async (tx) => (await tx.query("SELECT owner_id FROM pim_app.accounts WHERE username = $1", [params[0]])).rows[0]?.owner_id as string | undefined);
		if (!owner) throw new NotFoundError();
		await app.identity.authz.requireLive(owner, "hosted:run");
		throw new CapabilityUnavailableError("hosted app backend", "this deployment runs no app backends");
	}),
];

function bearerOf(req: IncomingMessage): string | undefined {
	const auth = req.headers.authorization;
	if (auth?.startsWith("Bearer ")) return auth.slice(7);
	const cookie = /(?:^|;\s*)pim_session=([^;]+)/.exec(req.headers.cookie ?? "");
	return cookie?.[1];
}

async function readBody(req: IncomingMessage, limit: number): Promise<Uint8Array> {
	const chunks: Buffer[] = [];
	let size = 0;
	for await (const chunk of req) {
		size += chunk.length;
		if (size > limit) throw new BadRequestError("Request body too large");
		chunks.push(chunk);
	}
	return Buffer.concat(chunks);
}

export function createGate(app: App): Server {
	return createServer(async (req, res) => {
		try {
			await handle(app, req, res);
		} catch (error) {
			const known = httpStatus(error);
			if (!known) console.error("gate error", error);
			send(res, { status: known?.status ?? 500, body: { error: known?.code ?? "internal", message: known ? (error as Error).message : "Something went wrong" } });
		}
	});
}

async function handle(app: App, req: IncomingMessage, res: ServerResponse): Promise<void> {
	const url = new URL(req.url ?? "/", "http://gate");
	const method = req.method ?? "GET";
	for (const r of routes) {
		if (r.method !== method) continue;
		const m = r.pattern.exec(url.pathname);
		if (!m) continue;
		let principal: Promise<Principal> | undefined;
		const ctx: Ctx = {
			app, req, url, params: m.slice(1).map(decodeURIComponent),
			principal: () => {
				principal ??= (async () => {
					const bearer = bearerOf(req);
					// A cookie is ambient, so an unsafe request carrying one must come from this site; a bearer header is deliberate.
					if (!req.headers.authorization && method !== "GET" && req.headers.origin && new URL(req.headers.origin).host !== req.headers.host) throw new ForbiddenError("Cross-site request refused", "csrf");
					return app.identity.authenticate(bearer);
				})();
				return principal;
			},
			json: async () => {
				const body = await readBody(req, 1_000_000);
				try {
					return body.length ? JSON.parse(Buffer.from(body).toString("utf8")) : {};
				} catch {
					throw new BadRequestError("The body is not valid JSON");
				}
			},
			bytes: () => readBody(req, 25_000_000),
		};
		return send(res, await r.run(ctx));
	}
	throw new NotFoundError();
}

function send(res: ServerResponse, reply: Reply): void {
	const raw = reply.raw ?? Buffer.from(JSON.stringify(reply.body ?? {}));
	res.writeHead(reply.status, { ...(reply.raw ? {} : { "content-type": "application/json" }), "cache-control": "no-store", ...reply.headers, "content-length": String(raw.length) });
	res.end(raw);
}
