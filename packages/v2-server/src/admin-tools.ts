/**
 * The admin's majordomo runs this deployment through the same admin API the Admin screens use, as three tools: `admin_read` (any GET), `admin_write` (a change that
 * can be undone, such as switching a built-in app or setting the default agent) and `admin_write_approved` (a change that cannot, or that handles a credential: every
 * DELETE, providers and their keys, compute, sign-in and setup links, suspending an account, invites). The last asks the admin each time (an approval, decided in the
 * admin's chat) and never runs on a standing approval. Only the majordomo of an active admin has them: another agent of the admin, a delegate, or anyone else is refused,
 * and each call goes through the very route a person's screen does, under the Authorizer's `admin:*` actions, so the last-admin guard and every other rule stand.
 * What the tools answer has secrets stripped, and each call is recorded in the audit log.
 */
import { Type } from "@earendil-works/pi-ai";
import { defineTool, type ToolRegistration } from "@earendil-works/pi-durable";
import type { App } from "@pim/v2-app/app";
import { httpStatus } from "@pim/v2-app/errors";
import type { Ctx, Route } from "@pim/v2-app/http";
import type { Principal } from "@pim/v2-contracts/identity";
import { OwnerId } from "@pim/v2-contracts/identity";
import { adminCompatRoutes } from "./compat/admin.ts";

type Result = { content: { type: "text"; text: string }[]; isError?: boolean };
const text = (s: string, isError = false): Result => ({ content: [{ type: "text", text: s }], ...(isError ? { isError } : {}) });

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

/** Runs one admin route in-process as the admin. */
async function dispatch(app: App, admin: Principal, env: Record<string, string | undefined>, method: string, url: URL, body: Record<string, unknown>): Promise<{ status: number; body: unknown }> {
	for (const r of ROUTES) {
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
	return { status: 404, body: { error: "not_found", message: "This deployment has no such admin route." } };
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

export function adminTools(deps: AdminToolsDeps): ToolRegistration[] {
	const { ownerId } = deps;
	const admin: Principal = { kind: "user", ownerId: OwnerId.parse(ownerId), role: "admin", sessionId: "majordomo" };

	/** The majordomo of an active admin: the home chat's agent (not another agent, not a delegate), on an account that is an admin and active. */
	const allowed = async (app: App, chat: string | null): Promise<string | null> => {
		const p = await deps.principalOf(app, chat);
		if (p.kind !== "agent" || p.agentId !== "pim") return "Only your majordomo runs the deployment: another agent, or a delegate, may not.";
		const account = await app.identity.authz.account(ownerId);
		if (!account || account.status !== "active" || account.role !== "admin") return "Only the admin of this Pim runs it.";
		return null;
	};
	const audit = (app: App, tool: string, method: string, path: string, decision: string) =>
		app.db.owner(ownerId, (tx) => tx.query("INSERT INTO pim_app.audit_log (owner_id, actor, action, resource, decision) VALUES ($1,'agent:majordomo',$2,$3,$4)", [ownerId, tool, JSON.stringify({ method, path }), decision])).catch(() => undefined);

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

	const write = (name: string, approved: boolean) => defineTool({
		name,
		description: approved
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
				const url = normalise(args.path);
				const gated = needsApproval(args.method, url.pathname);
				if (gated && !approved) return text(`${args.method} ${url.pathname} can't be undone or handles a credential, so it needs the admin's approval: use admin_write_approved.`, true);
				if (!gated && approved) return text(`${args.method} ${url.pathname} doesn't need approval: use admin_write.`, true);
				if (approved) {
					const taskId = String(api.taskId);
					const signal = (await deps.runtime.read<{ payload: { approved?: boolean } }>(ownerId, "SELECT payload FROM pim_runtime.durable_signals WHERE owner_id = $1 AND task_id = $2 AND kind = 'approval' ORDER BY signal_id DESC LIMIT 1", [ownerId, taskId])).rows[0];
					if (signal && signal.payload.approved !== true) {
						await audit(app, name, args.method, url.pathname, "denied");
						return text("The admin did not approve this change, so it was not made.", true);
					}
					if (!signal) {
						const waiting = { content: [{ type: "text", text: "Waiting for the admin's approval." }], control: { suspend: true } } as never;
						const filed = await app.db.owner(ownerId, async (tx) => (await tx.query("SELECT id FROM pim_app.approvals WHERE tool = 'admin:write' AND args->>'taskId' = $1 LIMIT 1", [taskId])).rows[0]?.id as string | undefined);
						if (filed) return waiting;
						// Every time, by the admin: a standing approval does not stand in for it, so the approval is filed directly and not through the gate.
						await app.db.owner(ownerId, (tx) => tx.query("INSERT INTO pim_app.approvals (id, owner_id, public_chat_id, tool, args, timeout_policy, expires_at) VALUES ($1,$2,$3,'admin:write',$4,'deny',$5)", [`ap_${taskId}_${api.callId}`.slice(0, 64), ownerId, chat, JSON.stringify({ taskId, callId: String(api.callId), method: args.method, path: url.pathname, summary: `${args.method} ${url.pathname}`, body: stripSecrets(args.body ?? {}), resource: {} }), new Date(Date.now() + 24 * 3600_000)]));
						await audit(app, name, args.method, url.pathname, "approval_required");
						return waiting;
					}
				}
				const r = await dispatch(app, admin, deps.env, args.method, url, args.body ?? {});
				await audit(app, name, args.method, url.pathname, r.status < 400 ? "allowed" : "denied");
				return answer(r);
			} catch (error) {
				return text(error instanceof Error ? error.message : String(error), true);
			}
		},
	} as never) as unknown as ToolRegistration;

	return [read, write("admin_write", false), write("admin_write_approved", true)];
}
