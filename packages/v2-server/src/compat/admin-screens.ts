/**
 * The admin screens of the web app, as `/api/admin/*` answers them: accounts, invites, the default agent, how this deployment runs, sign-in
 * methods, model providers, the connector directory, built-in apps, coding pools, compute and the computer host. Everything here needs an admin
 * (`admin:*` in the Authorizer), and an account's status changes go through `Identity`, whose last-admin guard is the database's own.
 */
import type { App } from "@pim/v2-app/app";
import { BadRequestError, NotFoundError, RefusedError } from "@pim/v2-app/errors";
import { route, type Reply, type Route } from "@pim/v2-app/http";
import { deploymentLimits } from "@pim/v2-app/quota";
import { toServiceInput } from "@pim/v2-app/web-providers";
import { configuredProviders, PROVIDER_IDS, providerName, providerSecrets } from "@pim/v2-app/oauth";
import type { Principal } from "@pim/v2-contracts/identity";
import type { IncomingMessage } from "node:http";
import { randomBytes } from "node:crypto";
import { CUSTOM_APPS_KEY, type CustomApp, customApps, gatewayModels } from "./admin-gallery.ts";
import { deleted, ms, ok } from "./admin-util.ts";

type Env = Readonly<Record<string, string | undefined>>;
/** Forge's HTTP handler, which owns the coding pools: a Fetch handler that answers null for a path that is not its own. */
export type ForgeHandler = (request: Request) => Promise<Response | null>;

const admin = async (app: App, p: Principal, action: string) => app.identity.authz.enforce(p, action);
const unsupported = (what: string): Reply => ({ status: 501, body: { error: "not_supported", message: `${what} isn't available on this deployment yet.` } });

async function ownerOfUsername(app: App, username: string): Promise<string> {
	const row = await app.db.anonymous(async (tx) => (await tx.query("SELECT owner_id FROM pim_app.accounts WHERE username = $1 AND status <> 'deleted'", [username.toLowerCase()])).rows[0]);
	if (!row) throw new NotFoundError("No such account");
	return row.owner_id;
}

async function setSetting(app: App, key: string, value: unknown) {
	await app.db.anonymous((tx) => tx.query("INSERT INTO pim_app.instance_settings (key, value) VALUES ($1, $2) ON CONFLICT (key) DO UPDATE SET value = $2", [key, JSON.stringify(value)]));
}

const defaultAgentOf = async (app: App) => {
	const t = await app.db.anonymous(async (tx) => (await tx.query("SELECT t.agent_id, t.title, t.published_at, a.username FROM pim_app.templates t JOIN pim_app.accounts a ON a.owner_id = t.owner_id WHERE t.default_for_everyone LIMIT 1")).rows[0]);
	return t ? { author: t.username as string, agentId: t.agent_id as string, name: t.title as string, updatedAt: ms(t.published_at) } : null;
};

/** Variables the admin may see the value of; the rest are shown as set or not, never as what they are. */
const PLAIN_VARIABLES = ["PIM_PUBLIC_URL", "PIM_APPS_ORIGIN", "PIM_CONTENT_ORIGIN", "PIM_DEFAULT_MODEL", "PIM_AI_GATEWAY_URL", "PIM_AI_GATEWAY_MODELS"];

const slug = (text: string) => text.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 40);

export function screenRoutes(env: Env): Route[] {
	const member = (r: Record<string, unknown>) => ({ ownerId: r.owner_id, username: r.username, role: r.role, status: r.status, createdAt: ms(r.created_at as Date), activatedAt: ms(r.activated_at as Date | null), statusReason: r.status_reason ?? null });
	const status = (to: "active" | "suspended") => async ({ app, principal, params }: { app: App; principal: () => Promise<Principal>; params: string[] }) => {
		const p = await principal();
		const target = await ownerOfUsername(app, params[0]!);
		// Not yourself; when you are the only admin the database's own guard answers with the last-admin refusal.
		if (to === "suspended" && target === p.ownerId && (await app.db.anonymous(async (tx) => (await tx.query("SELECT count(*)::int AS n FROM pim_app.admin_roster WHERE owner_id <> $1", [target])).rows[0].n)) > 0) throw new RefusedError("You can't suspend your own account.", "self");
		await app.identity.setStatus(p, target, to, to === "suspended" ? "suspended by an admin" : "");
		return ok({});
	};

	return [
		// ---- accounts ----
		route("POST", "/api/admin/accounts/:username/suspend", status("suspended")),
		route("POST", "/api/admin/accounts/:username/unsuspend", status("active")),
		route("POST", "/api/admin/accounts/:username/setup-link", async ({ app, principal, params, origin }) => {
			await admin(app, await principal(), "admin:accounts");
			const { code, expiresAt } = await app.signin.issueSetupCode(await ownerOfUsername(app, params[0]!));
			return ok({ setupUrl: `${origin}/#setup=${code}`, expiresAt: expiresAt.toISOString() });
		}),
		route("DELETE", "/api/admin/accounts/:username", async ({ app, principal, params }) => {
			await app.identity.setStatus(await principal(), await ownerOfUsername(app, params[0]!), "deleting", "removed by an admin");
			return deleted();
		}),
		route("POST", "/api/admin/invites", async ({ app, principal, origin, json }) => {
			const p = await principal();
			const body = await json();
			const count = Math.min(Math.max(Number(body.count ?? 1) || 1, 1), 100);
			const links: string[] = [];
			for (let i = 0; i < count; i++) links.push(`${origin}/#invite=${await app.identity.createInvite(p, typeof body.note === "string" ? body.note.slice(0, 200) : "")}`);
			return ok({ links }, 201);
		}),

		// The operator takes a published agent down from the gallery, whoever published it.
		route("DELETE", "/api/admin/templates/:id", async ({ app, principal, params }) => (await app.sharing.removeTemplate(await principal(), params[0]!), ok({ deleted: true }))),

		// ---- the default agent: a template the admin marks for everyone who joins ----
		route("GET", "/api/admin/default-agent", async ({ app, principal }) => (await admin(app, await principal(), "admin:templates"), ok({ agent: await defaultAgentOf(app) }))),
		route("PUT", "/api/admin/default-agent", async ({ app, principal, json }) => {
			const p = await principal();
			const b = await json();
			const agentId = String(b.agent ?? b.agentId ?? "");
			if (!agentId) throw new BadRequestError("agent is required");
			await admin(app, p, "admin:templates");
			const published = await app.db.owner(p.ownerId, async (tx) => (await tx.query("SELECT id FROM pim_app.templates WHERE owner_id = $1 AND agent_id = $2", [p.ownerId, agentId])).rows[0]);
			const templateId = published?.id ?? (await app.sharing.publishTemplate(p, agentId)).id;
			await app.agents.setDefaultTemplate(p, templateId);
			return ok({ agent: await defaultAgentOf(app) });
		}),
		route("DELETE", "/api/admin/default-agent", async ({ app, principal }) => (await app.agents.setDefaultTemplate(await principal(), null), ok({ agent: null }))),

		// ---- how this deployment runs ----
		route("GET", "/api/admin/deployment", async ({ app, principal, origin, appsOrigin }) => {
			await admin(app, await principal(), "admin:settings");
			const open = (await app.db.anonymous(async (tx) => (await tx.query("SELECT value FROM pim_app.instance_settings WHERE key = 'registration_open'")).rows[0]))?.value === true;
			const limits = deploymentLimits(env);
			const settings = { registration: open ? "open" : "invite", maxAccounts: null, registrationsPerAddress: 5, approvalPolicy: env.PIM_APPROVAL_POLICY === "auto" || env.PIM_APPROVAL_POLICY === "explicit" ? env.PIM_APPROVAL_POLICY : "majordomo", timeZone: env.PIM_TIME_ZONE ?? env.TZ ?? "UTC", model: env.PIM_DEFAULT_MODEL ?? "", models: gatewayModels(env), utilityModel: null, memoryModel: null, memoryLines: 0, imageModel: null, limits, publicUrl: env.PIM_PUBLIC_URL ?? origin, contentOrigin: appsOrigin ?? env.PIM_CONTENT_ORIGIN ?? null, emailFrom: null };
			const secrets = PROVIDER_IDS.flatMap((id) => providerSecrets(id));
			const variables = [...PLAIN_VARIABLES.map((name) => ({ name, value: env[name]?.trim() || null, problem: null })), ...secrets.map((name) => ({ name, value: env[name]?.trim() ? "(set)" : null, problem: null }))];
			return ok({ settings, variables });
		}),
		route("GET", "/api/admin/sign-in", async ({ app, principal, origin }) => {
			await admin(app, await principal(), "admin:settings");
			const { providers, problems } = configuredProviders(env);
			return ok({ providers: PROVIDER_IDS.map((id) => ({ id, name: providerName(id, providers[id]), enabled: !!providers[id], problem: problems[id] ?? null, secrets: providerSecrets(id), callbackUrl: `${origin}/auth/oauth/${id}/callback` })) });
		}),

		// ---- model providers for the deployment: an admin's own provider, marked for everyone ----
		route("POST", "/api/admin/providers", async ({ app, principal, json }) => {
			const p = await principal();
			await admin(app, p, "admin:providers");
			const input = await toServiceInput(await json());
			const created = await app.providers.create(p, { kind: input.kind, ...(input.name ? { name: input.name } : {}), ...(input.apiKey ? { apiKey: input.apiKey } : {}), config: { ...input.config, shared: true } });
			return ok({ provider: saved(created) }, 201);
		}),
		route("PUT", "/api/admin/providers/:id", async ({ app, principal, params, json }) => {
			const p = await principal();
			await admin(app, p, "admin:providers");
			const existing = (await app.providers.list(p)).find((r) => r.id === params[0] && r.config.shared === true);
			if (!existing) throw new NotFoundError("No such shared provider");
			const input = await toServiceInput(await json(), existing);
			return ok({ provider: saved(await app.providers.update(p, params[0]!, input)) });
		}),
		route("DELETE", "/api/admin/providers/:id", async ({ app, principal, params }) => {
			const p = await principal();
			await admin(app, p, "admin:providers");
			if (!(await app.providers.list(p)).some((r) => r.id === params[0] && r.config.shared === true)) throw new NotFoundError("No such shared provider");
			await app.providers.remove(p, params[0]!);
			return deleted();
		}),

		// ---- the connector directory and built-in apps ----
		route("POST", "/api/admin/apps", async ({ app, principal, json }) => {
			await admin(app, await principal(), "admin:apps");
			const b = await json();
			if (typeof b.name !== "string" || !b.name.trim()) throw new BadRequestError("A connector needs a name");
			if (!/^https:\/\//.test(String(b.url ?? "")) && !/^http:\/\/(localhost|127\.0\.0\.1)/.test(String(b.url ?? "")) && !(process.env.PIM_CONNECTOR_ALLOW_PRIVATE === "1" && /^http:\/\//.test(String(b.url ?? "")))) throw new BadRequestError("A connector's url is https");
			const entry: CustomApp = { id: `${slug(b.name) || "connector"}-${randomBytes(3).toString("hex")}`, name: b.name.trim(), description: String(b.description ?? ""), url: b.url, icon: b.icon ? String(b.icon) : null, category: b.category ? String(b.category) : null };
			await setSetting(app, CUSTOM_APPS_KEY, [...(await customApps(app)), entry]);
			return ok({ app: { id: `custom/${entry.id}` } }, 201);
		}),
		route("PUT", "/api/admin/apps/:id", async ({ app, principal, params, json }) => {
			await admin(app, await principal(), "admin:apps");
			const b = await json();
			const id = params[0]!.replace(/^custom\//, "");
			const list = await customApps(app);
			if (!list.some((c) => c.id === id)) throw new NotFoundError("No such connector");
			await setSetting(app, CUSTOM_APPS_KEY, list.map((c) => (c.id === id ? { ...c, ...(typeof b.icon === "string" ? { icon: b.icon || null } : {}), ...(typeof b.name === "string" ? { name: b.name } : {}), ...(typeof b.description === "string" ? { description: b.description } : {}) } : c)));
			return ok({ app: { id: `custom/${id}` } });
		}),
		route("DELETE", "/api/admin/apps/:id", async ({ app, principal, params }) => {
			await admin(app, await principal(), "admin:apps");
			const id = params[0]!.replace(/^custom\//, "");
			const list = await customApps(app);
			if (!list.some((c) => c.id === id)) throw new NotFoundError("No such connector");
			await setSetting(app, CUSTOM_APPS_KEY, list.filter((c) => c.id !== id));
			return deleted();
		}),
		// ---- managed compute and the computer host: not part of this deployment yet ----
		route("GET", "/api/admin/compute", async ({ app, principal }) => {
			await admin(app, await principal(), "admin:compute");
			const quota = await app.db.anonymous(async (tx) => (await tx.query("SELECT max_concurrent, compute_minutes FROM pim_forge.forge_quotas WHERE subject_type = 'deployment' AND subject_id = '*'")).rows[0]);
			// Everyone's sandbox minutes are in rows each owner alone can read, so the deployment's own usage is shown as nothing here.
			return ok({ providers: [], kinds: [], quota: { maxConcurrentWorkspaces: quota?.max_concurrent === null || quota === undefined ? null : Number(quota.max_concurrent), monthlySandboxMinutes: quota?.compute_minutes === null || quota === undefined ? null : Number(quota.compute_minutes), maxSessionMinutes: null }, usage: { month: new Date().toISOString().slice(0, 7), minutes: 0, running: 0, byProvider: [], top: [] } });
		}),
		...(["POST /api/admin/compute/providers", "PUT /api/admin/compute/providers/:id", "DELETE /api/admin/compute/providers/:id", "POST /api/admin/compute/providers/:id/validate"] as const).map((spec) => {
			const [method, path] = spec.split(" ") as [string, string];
			return route(method, path, async ({ app, principal }) => (await admin(app, await principal(), "admin:compute"), unsupported("Managed compute")));
		}),
	];
}

/** A provider as adding or changing it answers (`SavedProvider`): never its key. */
function saved(p: { id: string; name: string; hasKey: boolean; config: Record<string, unknown> }) {
	const c = p.config as { url?: string; baseUrl?: string; chosen?: string[] | null; structuredOutput?: boolean; api?: string; builtin?: string; overrides?: Record<string, unknown> };
	return { id: p.id, ...(c.builtin ? { builtin: c.builtin } : {}), name: p.name, url: c.baseUrl ?? c.url ?? "", hasKey: p.hasKey, chosen: c.chosen ?? null, models: [], ...(c.structuredOutput ? { structuredOutput: true } : {}), ...(c.api ? { api: c.api } : {}), ...(c.overrides ? { overrides: c.overrides } : {}) };
}

/** The coding pools Forge keeps, in the web app's shape. They go before Forge's own `/api/admin/coding` routes, which answer in Forge's. */
export function poolRoutes(coding: ForgeHandler): Route[] {
	/** Forge's own answer to a pools request, made as the caller (it checks for an admin's browser session itself). */
	const forge = async (req: IncomingMessage, origin: string, method: string, path: string, body?: unknown): Promise<Response> => {
		const headers = new Headers();
		for (const [k, v] of Object.entries(req.headers)) if (v !== undefined && !["content-length", "content-type", "transfer-encoding"].includes(k)) headers.set(k, Array.isArray(v) ? v.join(", ") : v);
		if (body !== undefined) headers.set("content-type", "application/json");
		const response = await coding(new Request(new URL(path, origin), { method, headers, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) }));
		return response ?? new Response(JSON.stringify({ error: "not_found" }), { status: 404 });
	};
	const poolsOf = async (req: IncomingMessage, origin: string) => {
		const response = await forge(req, origin, "GET", "/api/admin/coding/pools");
		if (!response.ok) throw Object.assign(new Error("pools"), { response });
		const rows = ((await response.json()) as { pools: Record<string, any>[] }).pools;
		return rows.map((r) => ({ id: r.id, provider: r.provider, size: r.size, priority: r.priority, enabled: r.enabled, config: {}, providerAvailable: true, slots: { held: r.held, free: Math.max(r.size - r.held, 0) }, queued: r.waiting, breaker: { state: r.retryAt ? "open" : "healthy", retryAt: ms(r.retryAt) } }));
	};
	const passThrough = async (response: Response): Promise<Reply> => ({ status: response.status, body: await response.json().catch(() => ({})) });
	const upsertPool = async (req: IncomingMessage, origin: string, id: string, input: Record<string, any>): Promise<Reply> => {
		const response = await forge(req, origin, "PUT", `/api/admin/coding/pools/${encodeURIComponent(id)}`, { provider: input.provider, size: input.size, priority: input.priority, enabled: input.enabled });
		if (!response.ok) return passThrough(response);
		return ok({ pool: (await poolsOf(req, origin)).find((p) => p.id === id) });
	};
	const runPools = async (method: string, req: IncomingMessage, origin: string, p: Principal, app: App, id: string | undefined, body: Record<string, any>): Promise<Reply> => {
		await admin(app, p, "admin:pools");
		try {
			if (method === "GET") return ok({ pools: await poolsOf(req, origin) });
			if (method === "DELETE") {
				const response = await forge(req, origin, "DELETE", `/api/admin/coding/pools/${encodeURIComponent(id!)}`);
				return response.ok ? deleted() : passThrough(response);
			}
			if (method === "POST") {
				const provider = String(body.provider ?? "");
				if (!provider) throw new BadRequestError("A pool needs a provider");
				return upsertPool(req, origin, String(body.id ?? (slug(provider) || "pool")), { size: 10, ...body });
			}
			const current = (await poolsOf(req, origin)).find((x) => x.id === id);
			if (!current) throw new NotFoundError("No such pool");
			return upsertPool(req, origin, id!, { ...current, ...body });
		} catch (error) {
			const response = (error as { response?: Response }).response;
			if (response) return passThrough(response);
			throw error;
		}
	};

	return [
		// ---- coding pools: Forge's, in the web app's shape ----
		route("GET", "/api/admin/coding/pools", async ({ app, principal, req, origin }) => runPools("GET", req, origin, await principal(), app, undefined, {})),
		route("POST", "/api/admin/coding/pools", async ({ app, principal, req, origin, json }) => runPools("POST", req, origin, await principal(), app, undefined, await json())),
		route("PATCH", "/api/admin/coding/pools/:id", async ({ app, principal, req, origin, json, params }) => runPools("PATCH", req, origin, await principal(), app, params[0], await json())),
		route("DELETE", "/api/admin/coding/pools/:id", async ({ app, principal, req, origin, params }) => runPools("DELETE", req, origin, await principal(), app, params[0], {})),

	];
}
