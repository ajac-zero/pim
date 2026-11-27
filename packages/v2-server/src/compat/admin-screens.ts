/**
 * The admin screens of the web app, as `/api/admin/*` answers them: accounts, invites, the default agent, how this deployment runs, sign-in
 * methods, model providers, the connector directory, built-in apps, coding pools, compute and the computer host. Everything here needs an admin
 * (`admin:*` in the Authorizer), and an account's status changes go through `Identity`, whose last-admin guard is the database's own.
 */
import type { App } from "@pim/v2-app/app";
import { BadRequestError, NotFoundError, RefusedError } from "@pim/v2-app/errors";
import { route, type Reply, type Route } from "@pim/v2-app/http";
import type { Bundle } from "@pim/v2-app/bundles";
import { refreshModels, toServiceInput } from "@pim/v2-app/web-providers";
import { configuredProviders, PROVIDER_IDS, providerName, providerSecrets } from "@pim/v2-app/oauth";
import type { Principal } from "@pim/v2-contracts/identity";
import type { IncomingMessage } from "node:http";
import { CUSTOM_APPS_KEY, type CustomApp, customApps } from "./admin-gallery.ts";
import { ComposeWorkspaceProvider } from "@pim/coding/workspace/compose";
import { readDeployment } from "../deployment.ts";
import { deleted, ms, ok } from "./admin-util.ts";
import { findSiteIcon } from "./site-icon.ts";

/** Where the Connectors page files a connector; the web app names each. */
const APP_CATEGORIES = ["productivity", "meetings", "development", "data", "finance", "customers", "websites", "automation", "research", "media"];
const MAX_APP_NAME = 40;
/** An icon the admin gave: an https image address, or null for none (a `javascript:` or `data:` address is refused, since it is shown as an image address). */
const iconGiven = (value: unknown): string | null => {
	if (value === undefined || value === null || (typeof value === "string" && value.trim() === "")) return null;
	const url = typeof value === "string" ? value.trim() : "";
	if (!/^https:\/\/\S+$/.test(url) || url.length > 1000) throw new BadRequestError("icon must be an https URL");
	return url;
};

type Env = Readonly<Record<string, string | undefined>>;
/** Forge's HTTP handler, which owns the coding pools: a Fetch handler that answers null for a path that is not its own. */
export type ForgeHandler = (request: Request) => Promise<Response | null>;

const admin = async (app: App, p: Principal, action: string) => app.identity.authz.enforce(p, action);
const unsupported = (what: string): Reply => ({ status: 501, body: { error: "not_supported", message: `${what} isn't available on this deployment: set its providers in the deployment's environment and its sandbox pools in Coding.` } });

async function ownerOfUsername(app: App, username: string): Promise<string> {
	const row = await app.db.anonymous(async (tx) => (await tx.query("SELECT owner_id FROM pim_app.accounts WHERE username = $1 AND status <> 'deleted'", [username.toLowerCase()])).rows[0]);
	if (!row) throw new NotFoundError("No such account");
	return row.owner_id;
}

async function setSetting(app: App, key: string, value: unknown) {
	await app.db.anonymous((tx) => tx.query("INSERT INTO pim_app.instance_settings (key, value) VALUES ($1, $2) ON CONFLICT (key) DO UPDATE SET value = $2", [key, JSON.stringify(value)]));
}

const defaultAgentOf = async (app: App) => {
	const t = await app.db.anonymous(async (tx) => (await tx.query("SELECT t.agent_id, t.title, t.bundle, t.published_at, a.username FROM pim_app.templates t JOIN pim_app.accounts a ON a.owner_id = t.owner_id WHERE t.default_for_everyone LIMIT 1")).rows[0]);
	if (!t) return null;
	const b = t.bundle as Bundle;
	return {
		author: t.username as string, agentId: t.agent_id as string, name: t.title as string, role: b.agent?.role ?? (t.title as string), description: b.description ?? "", instructions: b.agent?.instructions ?? "", apps: b.apps ?? [],
		symbol: b.agent?.emoji ?? null, color: b.agent?.color ?? null, icon: !!b.icon, updatedAt: ms(t.published_at), contacts: b.agent?.contacts ?? [],
		bundle: (b.bundle ?? []).map((a) => ({ name: a.name, role: a.role, description: a.description, instructions: a.instructions, apps: a.apps, symbol: a.emoji, color: a.color, contacts: a.contacts, icon: a.icon ? ms(t.published_at) : null })),
	};
};

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
			const adminOpen = (await app.db.anonymous(async (tx) => (await tx.query("SELECT value FROM pim_app.instance_settings WHERE key = 'registration_open'")).rows[0]))?.value === true;
			const { settings, variables } = readDeployment(env, origin, appsOrigin, adminOpen);
			const secrets = PROVIDER_IDS.flatMap((id) => providerSecrets(id));
			return ok({ settings, variables: [...variables, ...secrets.map((name) => ({ name, value: env[name]?.trim() ? "(set)" : null, problem: null }))] });
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
			const input = await toServiceInput(await json(), existing, { existingKey: existing.hasKey ? await app.providers.reveal(p.ownerId, existing.id).catch(() => null) : null });
			return ok({ provider: saved(await app.providers.update(p, params[0]!, input)) });
		}),
		route("POST", "/api/admin/providers/:id/refresh-models", async ({ app, principal, params }) => {
			const p = await principal();
			await admin(app, p, "admin:providers");
			const existing = (await app.providers.list(p)).find((r) => r.id === params[0] && r.config.shared === true);
			if (!existing) throw new NotFoundError("No such shared provider");
			const { config, available, url } = await refreshModels(existing, existing.hasKey ? await app.providers.reveal(p.ownerId, existing.id).catch(() => null) : null);
			return ok({ provider: saved(await app.providers.update(p, existing.id, { config })), available, url });
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
			const name = typeof b.name === "string" ? b.name.trim() : "";
			if (!name) throw new BadRequestError("A connector needs a name");
			if (name.length > MAX_APP_NAME) throw new BadRequestError(`name must be at most ${MAX_APP_NAME} characters`);
			if (b.description !== undefined && b.description !== null && (typeof b.description !== "string" || b.description.length > 1000)) throw new BadRequestError("description must be a string of at most 1000 characters");
			if (!/^https:\/\//.test(String(b.url ?? "")) && !/^http:\/\/(localhost|127\.0\.0\.1)/.test(String(b.url ?? "")) && !(process.env.PIM_CONNECTOR_ALLOW_PRIVATE === "1" && /^http:\/\//.test(String(b.url ?? "")))) throw new BadRequestError("A connector's url is https");
			const url = String(b.url).trim();
			if (b.category !== undefined && b.category !== null && b.category !== "" && !APP_CATEGORIES.includes(b.category)) throw new BadRequestError(`category must be one of ${APP_CATEGORIES.join(", ")}`);
			const given = iconGiven(b.icon);
			const same = (list: CustomApp[]) => list.some((c) => c.url === url || c.name.toLowerCase() === name.toLowerCase());
			if (same(await customApps(app))) throw new BadRequestError("A connector with that name or URL is already here");
			// Its icon is its site's unless one was given; looking takes a while, so it is checked again after.
			const icon = given ?? (url.startsWith("https://") ? await findSiteIcon(url) : null);
			const list = await customApps(app);
			if (same(list)) throw new BadRequestError("A connector with that name or URL is already here");
			const base = slug(name) || "app";
			const taken = new Set(list.map((c) => c.id));
			let id = base;
			for (let n = 2; taken.has(id); n++) id = `${base}-${n}`;
			const entry: CustomApp = { id, name, description: typeof b.description === "string" ? b.description.trim() : "", url, icon, category: b.category ? String(b.category) : null };
			await setSetting(app, CUSTOM_APPS_KEY, [...list, entry]);
			return ok({ app: { ...entry, id: `custom/${entry.id}` } }, 201);
		}),
		route("PUT", "/api/admin/apps/:id", async ({ app, principal, params, json }) => {
			await admin(app, await principal(), "admin:apps");
			const b = await json();
			const id = params[0]!.replace(/^custom\//, "");
			const found = (await customApps(app)).find((c) => c.id === id);
			if (!found) throw new NotFoundError("No such connector");
			// An icon is an https address; with none given, the site's is looked up again.
			const icon = "icon" in b || !("name" in b || "description" in b) ? (iconGiven(b.icon) ?? (found.url.startsWith("https://") ? await findSiteIcon(found.url) : null)) : undefined;
			let changed: CustomApp | undefined;
			await setSetting(app, CUSTOM_APPS_KEY, (await customApps(app)).map((c) => (c.id === id ? (changed = { ...c, ...(icon !== undefined ? { icon } : {}), ...(typeof b.name === "string" ? { name: b.name } : {}), ...(typeof b.description === "string" ? { description: b.description } : {}) }) : c)));
			if (!changed) throw new NotFoundError("No such connector");
			return ok({ app: { ...changed, id: `custom/${id}` } });
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
			const quota = await app.db.anonymous(async (tx) => (await tx.query("SELECT max_concurrent, compute_minutes, max_session_minutes FROM pim_forge.forge_quotas WHERE subject_type = 'deployment' AND subject_id = '*'")).rows[0]);
			// The providers coding sandboxes run on are the ones its pools name (the pools themselves are below, from Forge); a provider is set up in the deployment's environment, not here.
			const names = (await app.db.anonymous(async (tx) => (await tx.query("SELECT DISTINCT provider FROM pim_forge.forge_pools ORDER BY provider")).rows)).map((r) => String(r.provider));
			// Everyone's sandbox minutes are in rows each owner alone can read: the totals come through a definer function that returns sums only (migration 0703).
			const month = new Date().toISOString().slice(0, 7);
			const overview = (await app.db.anonymous(async (tx) => (await tx.query("SELECT pim_forge.compute_usage_overview($1) AS o", [new Date(`${month}-01T00:00:00Z`)])).rows[0]?.o)) as { byProvider: { provider: string; minutes: number; running: number }[]; top: { ownerId: string; minutes: number; running: number }[] } | undefined;
			const byProvider = (overview?.byProvider ?? []).map((r) => ({ provider: r.provider, minutes: Math.round(Number(r.minutes)), running: r.running }));
			const accounts = new Map((await app.db.anonymous(async (tx) => (await tx.query("SELECT owner_id, username FROM pim_app.accounts WHERE owner_id = ANY($1)", [(overview?.top ?? []).map((r) => r.ownerId)])).rows)).map((r) => [r.owner_id as string, r.username as string]));
			const usage = { month, minutes: byProvider.reduce((n, r) => n + r.minutes, 0), running: byProvider.reduce((n, r) => n + r.running, 0), byProvider, top: (overview?.top ?? []).map((r) => ({ username: accounts.get(r.ownerId) ?? null, minutes: Math.round(Number(r.minutes)), running: r.running })) };
			return ok({ providers: names.map((id) => ({ id, kind: id, name: id, settings: {}, credentialsSet: {}, codingSandbox: true, agentComputer: false })), kinds: names.map((id) => ({ kind: id, name: id, fields: [] })), quota: { maxConcurrentWorkspaces: quota?.max_concurrent === null || quota === undefined ? null : Number(quota.max_concurrent), monthlySandboxMinutes: quota?.compute_minutes === null || quota === undefined ? null : Number(quota.compute_minutes), maxSessionMinutes: quota?.max_session_minutes === null || quota === undefined ? null : Number(quota.max_session_minutes) }, usage });
		}),
		// One cheap read against the sandbox manager the deployment's environment names, as v1's Check did: whether it answers, and how many of its workspaces are running.
		route("POST", "/api/admin/compute/providers/:id/validate", async ({ app, principal, params }) => {
			await admin(app, await principal(), "admin:compute");
			const manager = env.PIM_CODING_MANAGER_URL && env.PIM_CODING_MANAGER_TOKEN ? new ComposeWorkspaceProvider({ managerUrl: env.PIM_CODING_MANAGER_URL, token: env.PIM_CODING_MANAGER_TOKEN }) : null;
			const named = (await app.db.anonymous(async (tx) => (await tx.query("SELECT 1 FROM pim_forge.forge_pools WHERE provider = $1 LIMIT 1", [params[0]!])).rows)).length > 0;
			if (!named && params[0] !== manager?.id) throw new NotFoundError("No such compute provider");
			if (!manager || params[0] !== manager.id) return ok({ ok: false, message: "This provider is set in the deployment's environment; Pim has no address to check it at.", ms: 0 });
			const started = Date.now();
			try {
				const health = await manager.managerHealth();
				return ok({ ok: true, message: `Reachable: ${health.running} of ${health.maxConcurrent} workspaces running.`, ms: Date.now() - started });
			} catch (error) {
				return ok({ ok: false, message: String(error instanceof Error ? error.message : error).slice(0, 300), ms: Date.now() - started });
			}
		}),
		...(["POST /api/admin/compute/providers", "PUT /api/admin/compute/providers/:id", "DELETE /api/admin/compute/providers/:id"] as const).map((spec) => {
			const [method, path] = spec.split(" ") as [string, string];
			return route(method, path, async ({ app, principal }) => (await admin(app, await principal(), "admin:compute"), unsupported("Adding, changing or removing a compute provider here")));
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
