import { principalId } from "../authz.ts";
import { CapabilityUnavailableError, NotFoundError } from "../errors.ts";
import { ok, type Route, route } from "../http.ts";

/** Health, account, tokens, admin, chats, approvals, memories, goals, schedules, notes and images. */
export const coreRoutes: Route[] = [
	route("GET", "/health", async () => ok({ ok: true })),
	route("GET", "/health/ready", async ({ app }) => {
		await app.db.anonymous((tx) => tx.query("SELECT 1"));
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
	route("GET", "/api/images/*", async ({ app, req, params, maybePrincipal }) => {
		const p = await maybePrincipal();
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

