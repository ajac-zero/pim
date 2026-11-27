/**
 * The admin's majordomo runs this deployment through the same admin API the Admin screens use, as three tools: `admin_read` (any GET), `admin_write` (a change that
 * can be undone, such as switching a built-in app or setting the default agent) and `admin_write_approved` (a change that cannot, or that handles a credential: every
 * DELETE, providers and their keys, compute, sign-in and setup links, suspending an account, invites). The last asks the admin each time (an approval, decided in the
 * admin's chat) and never runs on a standing approval. Only the majordomo or Pimbot of an active admin has them: another agent of the admin, a delegate, or anyone else is refused,
 * and each call goes through the very route a person's screen does, under the Authorizer's `admin:*` actions, so the last-admin guard and every other rule stand.
 * What the tools answer has secrets stripped, and each call is recorded in the audit log.
 */
import { Type } from "typebox";
import { defineTool, type ToolRegistration } from "@earendil-works/pi-durable";
import type { App } from "@pim/v2-app/app";
import { httpStatus } from "@pim/v2-app/errors";
import type { Ctx, Route } from "@pim/v2-app/http";
import type { Principal } from "@pim/v2-contracts/identity";
import { OwnerId } from "@pim/v2-contracts/identity";
import { adminCompatRoutes } from "./compat/admin.ts";
import { diagnosticsRoutes } from "./compat/diagnostics.ts";

type Result = { output: { type: "text"; text: string }[]; isError?: boolean };
const text = (s: string, isError = false): Result => ({ output: [{ type: "text", text: s }], ...(isError ? { isError } : {}) });

const SECRET_KEY = /^(key|apikey|api_key|secret|token|credential|password|setupurl|links|code|authorization)$/i;
const SECRET_VALUE = /#(setup|invite|claim)=/;
/** What an answer may show: no key, token, setup or invite link, however deep. */
export function stripSecrets(value: unknown): unknown {
	if (Array.isArray(value)) return value.map(stripSecrets);
	if (typeof value === "string") return SECRET_VALUE.test(value) ? "[redacted]" : value;
	if (value && typeof value === "object") return Object.fromEntries(Object.entries(value as Record<string, unknown>).map(([k, v]) => [k, SECRET_KEY.test(k) ? "[redacted]" : stripSecrets(v)]));
	return value;
}

/** A change that cannot be undone, or that handles a credential: it needs the admin's yes each time. */
export const needsApproval = (method: string, path: string) =>
	method === "DELETE" || /^\/api\/admin\/(providers|compute|computer-host|sign-in|invites|coding\/pools)(\/|$)/.test(path) || /^\/api\/admin\/accounts\/[^/]+\/(setup-link|suspend|limits)$/.test(path);

const ROUTES: Route[] = adminCompatRoutes;

function normalise(raw: string): URL {
	// A connector of the directory is `custom/<id>`; its slash is part of the id, as the web app sends it.
	const url = new URL(raw.replace(/^\/api\/admin\/apps\/custom\//, "/api/admin/apps/custom%2F"), "http://admin.invalid");
	if (url.origin !== "http://admin.invalid" || !url.pathname.startsWith("/api/admin/") || url.pathname.includes("..") || url.pathname.includes("//")) throw new Error("A path is /api/admin/… of this Pim.");
	return url;
}

/** What the app's routes never open to the majordomo through `ui_*`: credentials and files handed out, the person's own decisions, the account itself, and the admin API, which has its own tools. */
const BLOCKED_UI: readonly RegExp[] = [
	/^\/api\/admin(\/|$)/, /^\/api\/approvals\/[^/]+\/(approve|deny)$/, /\/ui-state(\/|$)/, /\/download$/, /^\/api\/export$/, /^\/api\/account(\/|$)/, /^\/api\/tokens(\/|$)/, /\/callback/, /\/grants$/, /\/bridge$/,
	/^\/api\/browser\/screenshot$/, /^\/api\/files\/content$/,
];
export type UiClass = "read" | "write" | "destructive" | "blocked";
/** The class of a request to the app's routes: reads and writes run at once, a delete (or resetting a chat) asks the admin, and some are never open. */
export const classOf = (method: string, path: string): UiClass => (BLOCKED_UI.some((b) => b.test(path)) ? "blocked" : method === "DELETE" || (method === "POST" && /^\/api\/sessions\/[^/]+\/reset$/.test(path)) ? "destructive" : method === "GET" ? "read" : "write");

function normaliseUi(raw: string): URL {
	const url = new URL(raw, "http://ui.invalid");
	if (url.origin !== "http://ui.invalid" || !url.pathname.startsWith("/api/") || url.pathname.includes("..") || url.pathname.includes("//")) throw new Error("A path is /api/… of this Pim's app: see ui_routes.");
	return url;
}

/** The routes of the web app, as `ui_*` reaches them: Pim's own and the compatibility routes the web app reads. */
async function appRoutes(): Promise<Route[]> {
	const [{ webCompatRoutes }, { builtInRoutes }] = await Promise.all([import("./compat/index.ts"), import("@pim/v2-app/gate")]);
	return [...webCompatRoutes, ...builtInRoutes];
}
const readable = (r: Route) => r.pattern.source.replace(/^\^|\$$/g, "").replace(/\(\[\^\/\]\+\)/g, ":id").replace(/\(\.\+\)/g, "*").replace(/\\\//g, "/").replace(/\\\./g, ".");

/** Runs one admin route in-process as the admin. */
async function dispatch(app: App, admin: Principal, env: Record<string, string | undefined>, method: string, url: URL, body: Record<string, unknown>, routes: readonly Route[] = ROUTES): Promise<{ status: number; body: unknown }> {
	for (const r of routes) {
		if (r.method !== method) continue;
		const m = r.pattern.exec(url.pathname);
		if (!m) continue;
		const ctx = {
			app, req: { headers: {}, socket: {} }, url, params: m.slice(1).map(decodeURIComponent), origin: (env.PIM_PUBLIC_URL ?? "http://localhost").replace(/\/$/, ""), appsOrigin: env.PIM_APPS_ORIGIN, secure: false,
			principal: async () => admin, maybePrincipal: async () => admin, json: async () => body, form: async () => new URLSearchParams(), bytes: async () => new Uint8Array(), cookie: () => undefined,
		} as unknown as Ctx;
		try {
			const reply = await r.run(ctx);
			return { status: reply.status, body: reply.body };
		} catch (error) {
			const known = httpStatus(error);
			if (!known) throw error;
			return { status: known.status, body: { error: known.code, message: (error as Error).message } };
		}
	}
	return { status: 404, body: { error: "not_found", message: "This deployment has no such route." } };
}

export type AdminToolsDeps = {
	ownerId: string;
	app: App | undefined;
	env: Record<string, string | undefined>;
	/** The principal of the chat a call runs in. */
	principalOf(app: App, chat: string | null): Promise<Principal>;
	chatOf(conversationId: number | string): Promise<string | null>;
	runtime: { read<R = unknown>(ownerId: string, text: string, values?: unknown[]): Promise<{ rows: R[] }> };
};

/** The majordomo or Pimbot of an active admin: the agent a chat answers as when none is chosen, or the one the person's settings name as their majordomo (or v1 marked as the default), or the admin's Pimbot (not another agent, not a delegate), on an account that is an admin and active. */
export async function operatorRefusal(app: App, ownerId: string, p: Principal): Promise<string | null> {
	const operators = p.kind === "agent" && p.agentId !== "pim"
		? await app.db.owner(ownerId, async (tx) => (await tx.query("SELECT pim_app.majordomo_id() AS majordomo, (SELECT value #>> '{}' FROM pim_app.owner_settings WHERE key = 'pimbot') AS pimbot")).rows[0] as { majordomo: string | null; pimbot: string | null })
		: undefined;
	if (p.kind !== "agent" || (p.agentId !== "pim" && p.agentId !== operators?.majordomo && p.agentId !== operators?.pimbot)) return "Only your majordomo or Pimbot run the deployment: another agent, or a delegate, may not.";
	const account = await app.identity.authz.account(ownerId);
	if (!account || account.status !== "active" || account.role !== "admin") return "Only the admin of this Pim runs it.";
	return null;
}

/** The tools that only the admin's majordomo or Pimbot are offered: the admin API, the app's own routes, and what looks into how the deployment runs. */
export const ADMIN_TOOL_NAMES = ["admin_read", "admin_write", "admin_write_approved", "admin_audit", "pim_diagnostics", "pim_health", "ui_routes", "ui_read", "ui_write", "ui_write_destructive", "ui_audit"] as const;

export function adminTools(deps: AdminToolsDeps): ToolRegistration[] {
	const { ownerId } = deps;
	const admin: Principal = { kind: "user", ownerId: OwnerId.parse(ownerId), role: "admin", sessionId: "majordomo" };

	const allowed = async (app: App, chat: string | null): Promise<string | null> => operatorRefusal(app, ownerId, await deps.principalOf(app, chat));
	const audit = (app: App, tool: string, method: string, path: string, decision: string, keys: string[] = [], status?: number) =>
		app.db.owner(ownerId, (tx) => tx.query("INSERT INTO pim_app.audit_log (owner_id, actor, action, resource, decision, detail) VALUES ($1,'agent:majordomo',$2,$3,$4,$5)", [ownerId, tool, JSON.stringify({ method, path }), decision, JSON.stringify({ keys, ...(status !== undefined ? { status } : {}) })])).catch(() => undefined);

	const answer = (r: { status: number; body: unknown }): Result => text(JSON.stringify({ status: r.status, body: stripSecrets(r.body) }, null, 1), r.status >= 400);

	const read = defineTool({
		name: "admin_read",
		description: "Read something of how this Pim is run, through the admin API: for example /api/admin/stats, /api/admin/accounts, /api/admin/deployment, /api/admin/default-agent, /api/admin/builtin-apps, /api/admin/coding/pools. Keys, tokens and setup links are never in the answer.",
		parameters: Type.Object({ path: Type.String({ description: "A path of this Pim's admin API, starting /api/admin/, with any query." }) }),
		replay: "safe",
		async execute(args: { path: string }, api: any) {
			const app = deps.app;
			if (!app) return text("This Runner has no application database (PIM_APP_DATABASE_URL), so it cannot reach the admin API.", true);
			try {
				const refusal = await allowed(app, await deps.chatOf(api.conversationId));
				if (refusal) return text(refusal, true);
				const url = normalise(args.path);
				const r = await dispatch(app, admin, deps.env, "GET", url, {});
				await audit(app, "admin_read", "GET", url.pathname, r.status < 400 ? "allowed" : "denied");
				return answer(r);
			} catch (error) {
				return text(error instanceof Error ? error.message : String(error), true);
			}
		},
	} as never) as unknown as ToolRegistration;

	const write = (name: string, approved: boolean, ui = false) => defineTool({
		name,
		description: ui
			? (approved ? "Do something in the app that cannot be taken back, through its own routes: any DELETE, and POST /api/sessions/<id>/reset. The admin is asked to approve each one first, reading the exact request." : "Do what the person does in the app, through its own routes: POST, PUT and PATCH at once. A DELETE is refused here: use ui_write_destructive. See ui_routes for what exists; some routes are never open to you.")
			: approved
			? "Make a change to how this Pim is run that cannot be undone or that handles a credential: any delete, providers and their keys, compute, sign-in, an account's suspension, invites. The admin is asked to approve each one first. method is POST, PUT, PATCH or DELETE."
			: "Make a change to how this Pim is run that can be undone, through the admin API: set the default agent, switch a built-in app, add or edit a connector in the directory, unsuspend an account. Anything that cannot be undone or that handles a credential is refused here: use admin_write_approved for it.",
		parameters: Type.Object({ method: Type.Union([Type.Literal("POST"), Type.Literal("PUT"), Type.Literal("PATCH"), Type.Literal("DELETE")]), path: Type.String({ description: "A path of this Pim's admin API, starting /api/admin/." }), body: Type.Optional(Type.Record(Type.String(), Type.Any())) }),
		// A parked call finds its approval again, and a change is made once by the route's own idempotence plus the decision's single delivery.
		replay: "safe",
		async execute(args: { method: string; path: string; body?: Record<string, unknown> }, api: any) {
			const app = deps.app;
			if (!app) return text("This Runner has no application database (PIM_APP_DATABASE_URL), so it cannot reach the admin API.", true);
			try {
				const chat = await deps.chatOf(api.conversationId);
				const refusal = await allowed(app, chat);
				if (refusal) return text(refusal, true);
				const url = ui ? normaliseUi(args.path) : normalise(args.path);
				if (ui && classOf(args.method, url.pathname) === "blocked") return text(`${args.method} ${url.pathname} is not open to you.`, true);
				const gated = ui ? classOf(args.method, url.pathname) === "destructive" : needsApproval(args.method, url.pathname);
				if (gated && !approved) return text(ui ? `${args.method} ${url.pathname} can't be taken back, so it needs the admin's approval: use ui_write_destructive.` : `${args.method} ${url.pathname} can't be undone or handles a credential, so it needs the admin's approval: use admin_write_approved.`, true);
				if (!gated && approved) return text(`${args.method} ${url.pathname} doesn't need approval: use ${ui ? "ui_write" : "admin_write"}.`, true);
				if (approved) {
					const taskId = String(api.taskId);
					const signal = (await deps.runtime.read<{ payload: { approved?: boolean } }>(ownerId, "SELECT payload FROM pim_runtime.durable_signals WHERE owner_id = $1 AND task_id = $2 AND kind = 'approval' ORDER BY signal_id DESC LIMIT 1", [ownerId, taskId])).rows[0];
					if (signal && signal.payload.approved !== true) {
						await audit(app, name, args.method, url.pathname, "denied");
						return text("The admin did not approve this change, so it was not made.", true);
					}
					if (!signal) {
						const waiting = { output: [{ type: "text", text: "Waiting for the admin's approval." }], control: { suspend: true } } as never;
						const filed = await app.db.owner(ownerId, async (tx) => (await tx.query("SELECT id FROM pim_app.approvals WHERE tool = 'admin:write' AND args->>'taskId' = $1 LIMIT 1", [taskId])).rows[0]?.id as string | undefined);
						if (filed) return waiting;
						// Every time, by the admin: a standing approval does not stand in for it, so the approval is filed directly and not through the gate.
						await app.db.owner(ownerId, (tx) => tx.query("INSERT INTO pim_app.approvals (id, owner_id, public_chat_id, tool, args, timeout_policy, expires_at) VALUES ($1,$2,$3,'admin:write',$4,'deny',$5)", [`ap_${taskId}_${api.callId}`.slice(0, 64), ownerId, chat, JSON.stringify({ taskId, callId: String(api.callId), method: args.method, path: url.pathname, summary: `${args.method} ${url.pathname}`, body: stripSecrets(args.body ?? {}), resource: {} }), new Date(Date.now() + 24 * 3600_000)]));
						await audit(app, name, args.method, url.pathname, "approval_required");
						return waiting;
					}
				}
				const r = await dispatch(app, admin, deps.env, args.method, url, args.body ?? {}, ui ? await appRoutes() : ROUTES);
				await audit(app, name, args.method, url.pathname, r.status < 400 ? "allowed" : "denied", Object.keys(args.body ?? {}), r.status);
				return answer(r);
			} catch (error) {
				return text(error instanceof Error ? error.message : String(error), true);
			}
		},
	} as never) as unknown as ToolRegistration;

	/** Runs a read-only tool for the admin's majordomo: the same checks as every admin tool, then `work`. */
	const guarded = (name: string, description: string, parameters: unknown, work: (app: App, args: any) => Promise<Result>) => defineTool({
		name, description, parameters, replay: "safe",
		async execute(args: any, api: any) {
			const app = deps.app;
			if (!app) return text("This Runner has no application database (PIM_APP_DATABASE_URL), so it cannot reach this Pim.", true);
			try {
				const refusal = await allowed(app, await deps.chatOf(api.conversationId));
				if (refusal) return text(refusal, true);
				return await work(app, args ?? {});
			} catch (error) {
				return text(error instanceof Error ? error.message : String(error), true);
			}
		},
	} as never) as unknown as ToolRegistration;

	const auditOf = (tools: string[]) => async (app: App, a: { limit?: number }): Promise<Result> => {
		const rows = (await app.db.owner(ownerId, async (tx) => (await tx.query("SELECT at, action, resource, decision, detail FROM pim_app.audit_log WHERE actor = 'agent:majordomo' AND action = ANY($1) ORDER BY id DESC LIMIT $2", [tools, Math.min(Math.max(a.limit ?? 50, 1), 500)])).rows));
		return text(JSON.stringify({ writes: rows.map((r) => ({ at: r.at, tool: r.action, ...(JSON.parse(r.resource ?? "{}") as object), decision: r.decision, status: r.detail?.status ?? null, keys: r.detail?.keys ?? [] })) }, null, 1));
	};
	const limitOnly = Type.Object({ limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 500, description: "How many, 50 unless given." })) });
	const through = (method: string, path: (a: any) => URL, routes?: () => Promise<Route[]>) => async (app: App, a: any): Promise<Result> => answer(await dispatch(app, admin, deps.env, method, path(a), {}, routes ? await routes() : ROUTES));
	
	return [
		read, write("admin_write", false), write("admin_write_approved", true),
		guarded("admin_audit", "The writes made to the admin area through admin_write and admin_write_approved, newest first: method, path, the admin's decision, status and the keys of the body.", limitOnly, auditOf(["admin_write", "admin_write_approved"])),
		guarded("pim_diagnostics", "What went wrong in this Pim lately, read only: chats at work now and what each waits on, how long turns took and where the time went (turns), failed runs and tasks, triggers' health, model call errors, prompt cache (give chat: how each model call's request compares with the one before it, as hashes, to see why a cache was not reused), provider cooldowns, connectors that aren't ready, approvals waiting, an event log, and whether the services it needs (PostgreSQL, NATS, the object store, the sandbox manager) answer (services). Give kind to read one kind, since (an ISO time, or 90m, 6h, 2d) and limit; give chat (a chat's id) with kind turns to read that chat's turns step by step.", Type.Object({ since: Type.Optional(Type.String()), kind: Type.Optional(Type.String()), chat: Type.Optional(Type.String()), limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 200 })) }), through("GET", (a) => { const u = new URL("/api/admin/diagnostics", "http://admin.invalid"); for (const k of ["since", "kind", "chat", "limit"]) if (a[k] !== undefined) u.searchParams.set(k, String(a[k])); return u; }, async () => diagnosticsRoutes(deps.env))),
		guarded("pim_health", "How this Pim is doing, read only: how many accounts are active, being erased, how many approvals wait, and how the deployment is set (without addresses or keys).", Type.Object({}), through("GET", () => new URL("/api/admin/health", "http://admin.invalid"), async () => diagnosticsRoutes(deps.env))),
		guarded("ui_routes", "Every route of the app you can use through ui_read and ui_write, with its class: read, write, destructive (ui_write_destructive, which asks the admin) or blocked (never open to you).", Type.Object({}), async () => text(JSON.stringify({ routes: (await appRoutes()).map((r) => ({ method: r.method, path: readable(r) })).filter((r) => r.path.startsWith("/api/")).map((r) => ({ ...r, class: classOf(r.method, r.path.replace(/:id/g, "x").replace(/\*/g, "x")) })) }))),
		guarded("ui_read", "Read anything the app reads, through its own route (a GET), such as /api/sessions. Answers JSON as it is, cut at 100,000 characters; give a query to ask for less.", Type.Object({ path: Type.String({ description: "A route of the app, starting /api/, with any query." }) }), async (app, a: { path: string }) => {
			const url = normaliseUi(a.path);
			if (classOf("GET", url.pathname) === "blocked") return text(`GET ${url.pathname} is not open to you.`, true);
			const reply = await dispatch(app, admin, deps.env, "GET", url, {}, await appRoutes());
			await audit(app, "ui_read", "GET", url.pathname, reply.status < 400 ? "allowed" : "denied", [], reply.status);
			const out = JSON.stringify({ status: reply.status, body: stripSecrets(reply.body) });
			return text(out.length > 100_000 ? `${out.slice(0, 100_000)} … [cut: ask for less with a query]` : out, reply.status >= 400);
		}),
		write("ui_write", false, true), write("ui_write_destructive", true, true),
		guarded("ui_audit", "The writes made through ui_write and ui_write_destructive, newest first: method, path, the decision, status and the keys of the body.", limitOnly, auditOf(["ui_write", "ui_write_destructive"])),
	];
}
