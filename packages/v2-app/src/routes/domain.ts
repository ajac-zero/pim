import { BadRequestError, NotFoundError } from "../errors.ts";
import { ok, type Reply, route, type Route } from "../http.ts";
import { isWebProviderInput, toServiceInput, toWebProvider } from "../web-providers.ts";

const int = (v: string | null, fallback: number) => (v === null ? fallback : Number.isInteger(Number(v)) ? Number(v) : fallback);
const none = (): Reply => ({ status: 200, body: { ok: true } });

/**
 * The `/api/*` surface over the domain services: agents and skills, memory, goals, schedules, triggers, providers, connectors, usage, apps,
 * circles and sharing, people, templates, and account export and deletion. Every handler is one bounded service call.
 */
export const domainRoutes: Route[] = [
	// ---- chats ----
	route("GET", "/api/sessions", async ({ app, principal, url }) => {
		const p = await principal();
		await app.identity.authz.enforce(p, "api:read");
		return ok({ sessions: await app.conversations.list(p.ownerId, { archived: url.searchParams.get("archived") === "true", limit: int(url.searchParams.get("limit"), 100) }) });
	}),
	route("POST", "/api/sessions/:id/read", async ({ app, principal, params }) => (await app.conversations.markRead(await principal(), params[0]!), none())),
	route("POST", "/api/sessions/:id/archive", async ({ app, principal, params }) => (await app.conversations.archive(await principal(), params[0]!), none())),
	// A chat's public link as the web reads it: `{ link: { id, url, sharedAt, messages } }`, and a copy of the chat made when it was made or last updated.
	route("GET", "/api/sessions/:id/link", async ({ app, principal, params, origin }) => {
		const p = await principal();
		const { link } = await app.sharing.sharedChatLink(p, params[0]!);
		return ok({ link: link && { ...link, url: `${origin}/shared/${p.ownerId}/${link.id}` } });
	}),
	route("PUT", "/api/sessions/:id/link", async ({ app, principal, params, origin }) => {
		const p = await principal();
		const link = await app.sharing.shareChat(p, params[0]!);
		return ok({ link: { ...link, url: `${origin}/shared/${p.ownerId}/${link.id}` } });
	}),
	route("DELETE", "/api/sessions/:id/link", async ({ app, principal, params }) => {
		const p = await principal();
		const had = (await app.sharing.sharedChatLink(p, params[0]!)).link !== null;
		await app.sharing.unshareChat(p, params[0]!);
		return ok({ deleted: had });
	}),
	route("GET", "/api/shared/:owner/:link", async ({ app, params }) => ({ status: 200, body: await app.sharing.readSharedChat(params[0]!, params[1]!), headers: { "cache-control": "public, max-age=60", "x-robots-tag": "noindex" } })),

	// ---- agents and skills ----
	route("GET", "/api/agents", async ({ app, principal }) => ok({ agents: await app.agents.list(await principal()) })),
	route("POST", "/api/agents", async ({ app, principal, json }) => ok(await app.agents.create(await principal(), (await json()) as never), 201)),
	route("POST", "/api/agents/adopt-default", async ({ app, principal }) => ok({ agent: await app.agents.adoptDefault(await principal()) })),
	route("GET", "/api/agents/:id", async ({ app, principal, params }) => ok(await app.agents.get(await principal(), params[0]!))),
	route("PUT", "/api/agents/:id", async ({ app, principal, params, json }) => ok(await app.agents.update(await principal(), params[0]!, (await json()) as never))),
	route("DELETE", "/api/agents/:id", async ({ app, principal, params }) => (await app.agents.remove(await principal(), params[0]!), none())),
	route("PUT", "/api/agents/:id/model", async ({ app, principal, params, json }) => {
		const b = await json();
		return ok(await app.agents.update(await principal(), params[0]!, { model: b.provider === null || b.provider === undefined ? null : { provider: b.provider, id: b.id } }));
	}),
	route("PUT", "/api/agents/:id/fallbacks", async ({ app, principal, params, json }) => ok(await app.agents.update(await principal(), params[0]!, { fallbacks: (await json()).models ?? [] }))),
	route("POST", "/api/agents/:id/publish", async ({ app, principal, params, json }) => ok(await app.sharing.publishTemplate(await principal(), params[0]!, (await json()).title), 201)),
	route("DELETE", "/api/agents/:id/publish", async ({ app, principal, params }) => (await app.sharing.unpublishTemplate(await principal(), params[0]!), none())),
	route("PUT", "/api/admin/default-agent", async ({ app, principal, json }) => (await app.agents.setDefaultTemplate(await principal(), (await json()).templateId ?? null), none())),
	route("GET", "/api/skills", async ({ app, principal }) => ok({ skills: await app.agents.listSkills(await principal()) })),
	route("POST", "/api/skills", async ({ app, principal, json }) => ok(await app.agents.createSkill(await principal(), (await json()) as never), 201)),
	route("GET", "/api/skills/:name", async ({ app, principal, params }) => ok(await app.agents.getSkill(await principal(), params[0]!))),
	route("PUT", "/api/skills/:name", async ({ app, principal, params, json }) => ok(await app.agents.updateSkill(await principal(), params[0]!, (await json()) as never))),
	route("DELETE", "/api/skills/:name", async ({ app, principal, params }) => (await app.agents.deleteSkill(await principal(), params[0]!), none())),
	route("GET", "/api/skills/:name/versions/:version", async ({ app, principal, params }) => ok(await app.agents.skillVersion(await principal(), params[0]!, int(params[1]!, 0)))),
	route("GET", "/api/skills/:name/versions/:version/file", async ({ app, principal, params, url }) => {
		const v = await app.agents.skillVersion(await principal(), params[0]!, int(params[1]!, 0));
		const path = url.searchParams.get("path") ?? "";
		const text = path === "SKILL.md" ? v.body : v.files[path];
		if (text === undefined) throw new NotFoundError("No such file");
		return { status: 200, headers: { "content-type": "text/plain; charset=utf-8" }, raw: text };
	}),
	route("POST", "/api/skills/:name/restore", async ({ app, principal, params, json }) => ok(await app.agents.restoreSkill(await principal(), params[0]!, Number((await json()).version)))),

	// ---- memory, goals, schedules ----
	route("GET", "/api/memory/log", async ({ app, principal, url }) => {
		const p = await principal();
		const scopes = url.searchParams.get("scope")?.split(",");
		const q = url.searchParams.get("q");
		return ok({ memories: q ? await app.memories.recall(p, scopes ?? ["everyone"], q) : await app.memories.list(p, scopes) });
	}),
	route("POST", "/api/memory/log", async ({ app, principal, json }) => {
		const b = await json();
		return ok({ id: await app.memories.remember(await principal(), String(b.scope ?? "everyone"), String(b.title ?? ""), String(b.body ?? "")) }, 201);
	}),
	route("PUT", "/api/memory/log/:id", async ({ app, principal, params, json }) => (await app.memories.move(await principal(), params[0]!, String((await json()).scope ?? "")), none())),
	route("DELETE", "/api/memory/log/:id", async ({ app, principal, params }) => (await app.memories.forget(await principal(), params[0]!), none())),
	route("GET", "/api/memory/tree/:scope/:block", async ({ app, principal, params, url }) => ok(await app.memories.zoom(await principal(), params[1]!, int(url.searchParams.get("start"), 1), int(url.searchParams.get("count"), 40)))),
	route("GET", "/api/goals", async ({ app, principal }) => ok({ goals: await app.memories.listGoals(await principal()) })),
	route("POST", "/api/goals", async ({ app, principal, json }) => {
		const b = await json();
		return ok({ id: await app.memories.createGoal(await principal(), String(b.title ?? ""), (b.steps ?? []).map(String)) }, 201);
	}),
	route("GET", "/api/goals/:id", async ({ app, principal, params }) => ok(await app.memories.getGoal(await principal(), params[0]!))),
	route("PUT", "/api/goals/:id", async ({ app, principal, params, json }) => ok(await app.memories.updateGoal(await principal(), params[0]!, (await json()) as never))),
	route("POST", "/api/goals/:id/steps/:position/done", async ({ app, principal, params }) => ok(await app.memories.completeStep(await principal(), params[0]!, int(params[1]!, -1)))),
	route("DELETE", "/api/goals/:id", async ({ app, principal, params }) => (await app.memories.deleteGoal(await principal(), params[0]!), none())),
	route("GET", "/api/schedules", async ({ app, principal }) => ok({ schedules: await app.schedules.list(await principal()) })),
	route("POST", "/api/schedules", async ({ app, principal, json }) => ok({ id: await app.schedules.create(await principal(), (await json()) as never) }, 201)),
	route("DELETE", "/api/schedules/:id", async ({ app, principal, params }) => (await app.schedules.remove(await principal(), params[0]!), none())),

	// ---- triggers ----
	route("GET", "/api/triggers", async ({ app, principal, url }) => ok({ triggers: await app.triggers.list(await principal(), { ...(url.searchParams.get("lifecycle") ? { lifecycle: url.searchParams.get("lifecycle")! } : {}), limit: int(url.searchParams.get("limit"), 20) }) })),
	route("POST", "/api/triggers", async ({ app, principal, json }) => ok(await app.triggers.create(await principal(), (await json()) as never), 201)),
	route("GET", "/api/triggers/:id", async ({ app, principal, params }) => ok(await app.triggers.get(await principal(), params[0]!))),
	route("POST", "/api/triggers/:id/lifecycle", async ({ app, principal, params, json }) => ok(await app.triggers.setLifecycle(await principal(), params[0]!, (await json()).lifecycle))),
	route("POST", "/api/triggers/:id/test", async ({ app, principal, params, json }) => ok(await app.triggers.test(await principal(), params[0]!, (await json()) as never))),
	route("GET", "/api/triggers/:id/runs", async ({ app, principal, params, url }) => ok({ runs: await app.triggers.runs(await principal(), params[0]!, int(url.searchParams.get("limit"), 20)) })),
	route("POST", "/api/triggers/:id/computer-grant", async ({ app, principal, params, json }) => (await app.triggers.grantComputer(await principal(), params[0]!, String((await json()).computerId ?? "")), none())),
	route("DELETE", "/api/triggers/:id/computer-grant", async ({ app, principal, params }) => (await app.triggers.revokeComputer(await principal(), params[0]!), none())),

	// ---- providers, usage ----
	route("GET", "/api/providers", async ({ app, principal }) => ok({ providers: await app.providers.list(await principal()) })),
	// The web app's own forms (`builtin`, `url`, `key`, `models`) are answered in the shape it shows; the services' own shape (`kind`, `apiKey`, `config`) still works.
	route("POST", "/api/providers", async ({ app, principal, json }) => {
		const body = await json();
		if (!isWebProviderInput(body)) return ok(await app.providers.create(await principal(), body as never), 201);
		const p = await principal();
		return ok({ provider: toWebProvider(await app.providers.create(p, (await toServiceInput(body)) as never)) }, 201);
	}),
	route("PUT", "/api/providers/:id", async ({ app, principal, params, json }) => {
		const body = await json();
		if (!isWebProviderInput(body)) return ok(await app.providers.update(await principal(), params[0]!, body as never));
		const p = await principal();
		const existing = (await app.providers.list(p)).find((x) => x.id === params[0]!);
		const input = await toServiceInput(body, existing);
		return ok({ provider: toWebProvider(await app.providers.update(p, params[0]!, { ...(input.name ? { name: input.name } : {}), config: input.config, ...(input.apiKey !== undefined ? { apiKey: input.apiKey } : {}) })) });
	}),
	route("DELETE", "/api/providers/:id", async ({ app, principal, params }) => (await app.providers.remove(await principal(), params[0]!), none())),
	route("GET", "/api/model/fallbacks", async ({ app, principal }) => ok({ models: await app.providers.fallbacks(await principal()) })),
	route("PUT", "/api/model/fallbacks", async ({ app, principal, json }) => ok({ models: await app.providers.setFallbacks(await principal(), (await json()).models) })),
	route("GET", "/api/usage/costs", async ({ app, principal, url }) => ok(await app.usage.costs(await principal(), int(url.searchParams.get("days"), 30)))),

	// ---- connectors ----
	route("GET", "/api/connectors", async ({ app, principal }) => ok({ connectors: await app.connectors.list(await principal()) })),
	route("POST", "/api/connectors", async ({ app, principal, json }) => ok(await app.connectors.create(await principal(), (await json()) as never), 201)),
	route("GET", "/api/connectors/:id", async ({ app, principal, params }) => ok(await app.connectors.get(await principal(), params[0]!))),
	route("DELETE", "/api/connectors/:id", async ({ app, principal, params }) => (await app.connectors.remove(await principal(), params[0]!), none())),
	route("POST", "/api/connectors/:id/discover", async ({ app, principal, params }) => ok(await app.connectors.discover(await principal(), params[0]!))),
	route("PUT", "/api/connectors/:id/tools", async ({ app, principal, params, json }) => ok({ enabledTools: await app.connectors.setEnabledTools(await principal(), params[0]!, (await json()).tools ?? []) })),
	route("POST", "/api/connectors/:id/authorize", async ({ app, principal, params }) => ok(await app.connectors.beginAuth(await principal(), params[0]!))),
	// The services call these at the root, without /api, and name whose connector they are for.
	route("GET", "/mcp/callback/:owner", async ({ app, params, url }) => {
		const { connectorId } = await app.connectors.finishAuth(params[0]!, url.searchParams.get("state"), url.searchParams.get("code"));
		return { status: 302, headers: { location: `/?dialog=connectors&connected=${encodeURIComponent(connectorId)}` } };
	}),
	route("POST", "/mcp/events/:owner/:key", async ({ app, params, bytes, req }) => {
		const header = (n: string) => (typeof req.headers[n] === "string" ? (req.headers[n] as string) : undefined);
		const r = await app.connectors.receiveEvent(params[0]!, params[1]!, await bytes(1_000_000), header("x-pim-signature") ?? header("x-hub-signature-256"), header("x-pim-delivery") ?? header("x-github-delivery"));
		return ok(r, 202);
	}),

	// ---- apps ----
	route("GET", "/api/apps", async ({ app, principal, url }) => ok({ apps: await app.apps.list(await principal(), url.searchParams.get("query") ?? "") })),
	route("POST", "/api/apps", async ({ app, principal, json }) => ok(await app.apps.create(await principal(), (await json()) as never), 201)),
	route("GET", "/api/apps/:id", async ({ app, principal, params, url }) => ok(await app.apps.read(await principal(), params[0]!, { ...(url.searchParams.get("version") ? { version: int(url.searchParams.get("version"), 1) } : {}), ...(url.searchParams.get("path") ? { path: url.searchParams.get("path")! } : {}), offset: int(url.searchParams.get("offset"), 0) }))),
	route("PUT", "/api/apps/:id", async ({ app, principal, params, json }) => {
		const b = await json();
		if (typeof b.baseVersion !== "number") throw new BadRequestError("baseVersion is required: say which version you changed");
		return ok(await app.apps.update(await principal(), params[0]!, b as never));
	}),
	route("DELETE", "/api/apps/:id", async ({ app, principal, params }) => (await app.apps.remove(await principal(), params[0]!), none())),
	route("GET", "/api/apps/:id/versions", async ({ app, principal, params }) => ok({ versions: await app.apps.versions(await principal(), params[0]!) })),
	route("POST", "/api/apps/:id/restore", async ({ app, principal, params, json }) => ok(await app.apps.restore(await principal(), params[0]!, Number((await json()).version)))),
	route("PUT", "/api/apps/:id/access", async ({ app, principal, params, json }) => {
		const b = await json();
		return (await app.apps.setAccess(await principal(), params[0]!, b.access, b.circles ?? []), none());
	}),
	route("POST", "/api/apps/:id/publish", async ({ app, principal, params, json }) => ok(await app.apps.publish(await principal(), params[0]!, (await json()).version), 201)),
	route("DELETE", "/api/apps/:id/publish", async ({ app, principal, params }) => (await app.apps.unpublish(await principal(), params[0]!), none())),
	route("POST", "/api/apps/:id/open", async ({ app, principal, params }) => ok(await app.apps.openHosted(await principal(), params[0]!))),
	route("GET", "/api/published-artifacts", async ({ app, principal }) => {
		await app.identity.authz.enforce(await principal(), "api:read");
		return ok({ published: await app.db.anonymous(async (tx) => (await tx.query("SELECT p.public_id, p.version, p.published_at, a.username FROM pim_app.published_artifacts p JOIN pim_app.accounts a ON a.owner_id = p.owner_id WHERE p.unpublished_at IS NULL AND a.status NOT IN ('deleting', 'deleted') ORDER BY p.published_at DESC LIMIT 100")).rows.map((r) => ({ id: r.public_id as string, version: r.version as number, author: r.username as string, publishedAt: r.published_at as Date }))) });
	}),
	// A published artifact is for anyone with its address, signed in or not, and never takes ?token=.
	route("GET", "/p/:id", async ({ app, params }) => {
		const r = await app.apps.servePublished(params[0]!);
		return { status: r.status, headers: r.headers, raw: r.body };
	}),
	route("GET", "/p/:id/*", async ({ app, params }) => {
		const r = await app.apps.servePublished(params[0]!, params[1]!);
		return { status: r.status, headers: r.headers, raw: r.body };
	}),
	// The owner's own apps framed on a page of their own.
	route("GET", "/app-pages/:id", async ({ app, principal, params }) => ok(await app.apps.read(await principal(), params[0]!))),

	// ---- circles, shared apps, people, bots, visits, templates ----
	route("GET", "/api/circles/activity", async ({ app, principal }) => ok({ activity: await app.sharing.activity(await principal()) })),
	route("GET", "/api/circles", async ({ app, principal }) => ok({ circles: await app.sharing.circles(await principal()) })),
	route("POST", "/api/circles", async ({ app, principal, json }) => ok(await app.sharing.createCircle(await principal(), String((await json()).name ?? "")), 201)),
	route("PUT", "/api/circles/:id", async ({ app, principal, params, json }) => (await app.sharing.renameCircle(await principal(), params[0]!, String((await json()).name ?? "")), none())),
	route("DELETE", "/api/circles/:id", async ({ app, principal, params }) => (await app.sharing.deleteCircle(await principal(), params[0]!), none())),
	route("POST", "/api/circles/:id/members", async ({ app, principal, params, json }) => ok(await app.sharing.addMember(await principal(), params[0]!, String((await json()).username ?? "")), 201)),
	route("DELETE", "/api/circles/:id/members/:ownerId", async ({ app, principal, params }) => (await app.sharing.removeMember(await principal(), params[0]!, params[1]!), none())),
	route("GET", "/api/shared-artifacts/:owner/:id", async ({ app, principal, params }) => ok(await app.sharing.sharedApp(await principal(), params[0]!, params[1]!))),
	route("GET", "/api/profile", async ({ app, principal }) => ok(await app.sharing.profile(await principal()))),
	route("PUT", "/api/profile", async ({ app, principal, json }) => ok(await app.sharing.setProfile(await principal(), (await json()) as never))),
	route("GET", "/api/people/:username", async ({ app, params }) => ok(await app.sharing.person(params[0]!))),
	route("GET", "/api/bots", async ({ app, principal }) => ok({ bots: await app.sharing.bots(await principal()) })),
	route("POST", "/api/bots", async ({ app, principal, json }) => {
		const b = await json();
		return ok(await app.sharing.createBot(await principal(), String(b.agentId ?? ""), b.name), 201);
	}),
	route("DELETE", "/api/bots/:id", async ({ app, principal, params }) => (await app.sharing.removeBot(await principal(), params[0]!), none())),
	route("GET", "/api/bots/:id", async ({ app, params }) => ok(await app.sharing.bot(params[0]!))),
	route("GET", "/api/visits", async ({ app, principal }) => ok({ visits: await app.sharing.visits(await principal()) })),
	route("POST", "/api/visits/:username", async ({ app, principal, params, json }) => ok(await app.sharing.visit(await principal(), params[0]!, String((await json()).bot ?? "")), 201)),
	route("GET", "/api/templates", async ({ app, principal }) => ok({ templates: await app.sharing.templates(await principal()) })),
	route("GET", "/api/templates/:id", async ({ app, principal, params }) => ok(await app.sharing.template(await principal(), params[0]!))),
	route("POST", "/api/templates/:id/use", async ({ app, principal, params }) => ok(await app.sharing.useTemplate(await principal(), params[0]!), 201)),

	// ---- the account's own data ----
	route("GET", "/api/account/export", async ({ app, principal }) => ok(await app.sharing.export(await principal()), 200, { "content-disposition": 'attachment; filename="pim-export.json"' })),
	route("GET", "/api/export", async ({ app, principal }) => ok(await app.sharing.export(await principal()), 200, { "content-disposition": 'attachment; filename="pim-export.json"' })),
	route("DELETE", "/api/account", async ({ app, principal }) => (await app.identity.deleteSelf(await principal()), none())),
];
