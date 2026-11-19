/**
 * `/api/memory`, `/api/memory/log` and `/api/memory/scopes` as the memory screen reads them, over V2's memories. A memory is one line to the app;
 * V2 keeps a title and a body, so a line is read back as "title: body" and written as a title with the same line as its body.
 *
 * A scope is a key: `private` (what only the person and their majordomo read), `everyone`, `agent-<id>` (one agent's own), or one the person named
 * (`scope-…`, kept in `pim_app.memory_scopes`). An agent reads `everyone`, its own and the named scopes it was given (its `memoryScopes`).
 */
import { BadRequestError, NotFoundError } from "@pim/v2-app/errors";
import { ok, type Route, route } from "@pim/v2-app/http";
import type { App } from "@pim/v2-app/app";
import type { Principal } from "@pim/v2-contracts/identity";

const MAX_LINE = 2000;

type ScopeInfo = { key: string; kind: "private" | "everyone" | "agent" | "named" | "former"; name: string | null; agents: string[]; readers: string[]; count: number };

const lineOf = (title: string, body: string) => (body.trim() === "" || body.trim() === title.trim() ? title : `${title}: ${body}`).replace(/\s*\n\s*/g, " ");
const entryOf = (r: any) => ({ id: r.id as string, date: (r.updated_at as Date).toISOString().slice(0, 10), text: lineOf(r.title, r.body), forgotten: false, source: null, scope: r.scope as string });

async function scopes(app: App, p: Principal): Promise<ScopeInfo[]> {
	return app.db.owner(p.ownerId, async (tx) => {
		const counts = new Map((await tx.query("SELECT scope, count(*)::int AS n FROM pim_app.memories WHERE deleted_at IS NULL GROUP BY scope")).rows.map((r) => [r.scope as string, r.n as number]));
		const agents = (await tx.query("SELECT id, name, config FROM pim_app.agents WHERE deleted_at IS NULL ORDER BY created_at")).rows.map((r) => ({ id: r.id as string, name: r.name as string, own: (r.config.memoryScope ?? `agent-${r.id}`) as string, named: (r.config.memoryScopes ?? []) as string[] }));
		const named = (await tx.query("SELECT key, name FROM pim_app.memory_scopes ORDER BY created_at")).rows;
		// An agent's own scope is shared by the agents that keep it (copies of one agent do); `private` is the majordomo's.
		const owners = Map.groupBy(agents, (a) => a.own);
		const out: ScopeInfo[] = [
			{ key: "private", kind: "private", name: null, agents: (owners.get("private") ?? []).map((a) => a.id), readers: (owners.get("private") ?? []).map((a) => a.id), count: counts.get("private") ?? 0 },
			{ key: "everyone", kind: "everyone", name: null, agents: [], readers: agents.map((a) => a.id), count: counts.get("everyone") ?? 0 },
			...[...owners].filter(([key]) => key !== "private").map(([key, copies]): ScopeInfo => ({ key, kind: "agent", name: copies.map((a) => a.name).join(", "), agents: copies.map((a) => a.id), readers: copies.map((a) => a.id), count: counts.get(key) ?? 0 })),
			...named.map((r): ScopeInfo => ({ key: r.key, kind: "named", name: r.name, agents: [], readers: agents.filter((a) => a.named.includes(r.key)).map((a) => a.id), count: counts.get(r.key) ?? 0 })),
		];
		const known = new Set(out.map((s) => s.key));
		for (const [key, count] of counts) if (!known.has(key)) out.push({ key, kind: "former", name: null, agents: [], readers: [], count });
		return out;
	});
}

async function knownScope(app: App, p: Principal, key: unknown): Promise<string> {
	if (typeof key !== "string" || key === "") throw new BadRequestError("scope must be a memory scope's key");
	if (!(await scopes(app, p)).some((s) => s.key === key && s.kind !== "former")) throw new NotFoundError(`No memory scope ${key}`);
	return key;
}

const scopeName = (value: unknown): string => {
	const name = typeof value === "string" ? value.trim() : "";
	if (name === "" || name.length > 40 || /[\r\n]/.test(name)) throw new BadRequestError("A scope's name is one line of 1 to 40 characters");
	return name;
};

export function memoryRoutes(): Route[] {
	return [
		route("GET", "/api/memory", async ({ app, principal }) => {
			const p = await principal();
			const list = await scopes(app, p);
			const recent = await app.memories.list(p);
			return ok({ count: recent.length, pendingCompressions: 0, view: recent.slice(0, 100).map((m) => `[${m.scope}] ${lineOf(m.title, m.body)}`), scopes: list });
		}),
		route("GET", "/api/memory/log", async ({ app, principal, url }) => {
			const p = await principal();
			await app.identity.authz.enforce(p, "api:read");
			const limit = Math.min(Math.max(Number(url.searchParams.get("limit")) || 100, 1), 500);
			const scope = url.searchParams.get("scope");
			const pattern = url.searchParams.get("q");
			if (pattern !== null) {
				try {
					new RegExp(pattern);
				} catch {
					throw new BadRequestError("q is not a valid regular expression");
				}
			}
			const before = url.searchParams.get("before");
			const rows = await app.db.owner(p.ownerId, async (tx) => {
				await tx.query("SET LOCAL statement_timeout = '1000ms'");
				return (await tx.query(
					`SELECT id, scope, title, body, updated_at FROM pim_app.memories m
					 WHERE deleted_at IS NULL AND ($1::text IS NULL OR scope = $1) AND ($2::text IS NULL OR title ~* $2 OR body ~* $2)
					   AND ($3::text IS NULL OR (updated_at, id) < (SELECT updated_at, id FROM pim_app.memories WHERE id = $3))
					 ORDER BY updated_at DESC, id DESC LIMIT $4`,
					[scope, pattern, before, limit],
				)).rows;
			});
			return ok({ entries: rows.map(entryOf) });
		}),
		route("POST", "/api/memory/log", async ({ app, principal, json }) => {
			const p = await principal();
			const b = await json();
			const line = typeof b.text === "string" ? b.text.trim() : "";
			if (line === "" || /[\r\n]/.test(line)) throw new BadRequestError("text must be one non-empty line");
			if (line.length > MAX_LINE) throw new BadRequestError(`text is limited to ${MAX_LINE} characters`);
			const scope = b.scope === undefined ? "private" : await knownScope(app, p, b.scope);
			const id = await app.memories.remember(p, scope, line, line);
			const row = (await app.db.owner(p.ownerId, async (tx) => (await tx.query("SELECT id, scope, title, body, updated_at FROM pim_app.memories WHERE id = $1", [id])).rows[0]))!;
			return ok(entryOf(row), 201);
		}),
		route("PUT", "/api/memory/log/:id", async ({ app, principal, json, params }) => {
			const p = await principal();
			const scope = await knownScope(app, p, (await json()).scope);
			await app.memories.move(p, params[0]!, scope);
			const row = (await app.db.owner(p.ownerId, async (tx) => (await tx.query("SELECT id, scope, title, body, updated_at FROM pim_app.memories WHERE id = $1", [params[0]!])).rows[0]))!;
			return ok(entryOf(row));
		}),
		route("DELETE", "/api/memory/log/:id", async ({ app, principal, params }) => {
			await app.memories.forget(await principal(), params[0]!);
			return ok({ forgotten: params[0] });
		}),
		route("POST", "/api/memory/scopes", async ({ app, principal, json }) => {
			const p = await principal();
			await app.identity.authz.enforce(p, "api:write");
			const name = scopeName((await json()).name);
			const key = await app.memories.createScope(p, name);
			return ok((await scopes(app, p)).find((s) => s.key === key), 201);
		}),
		route("PUT", "/api/memory/scopes/:key", async ({ app, principal, json, params }) => {
			const p = await principal();
			await app.identity.authz.enforce(p, "api:write");
			const name = scopeName((await json()).name);
			const n = await app.db.owner(p.ownerId, async (tx) => (await tx.query("UPDATE pim_app.memory_scopes SET name = $2 WHERE key = $1", [params[0]!, name])).rowCount);
			if (!n) throw new BadRequestError("Only a scope you named can be renamed");
			return ok((await scopes(app, p)).find((s) => s.key === params[0]));
		}),
		route("DELETE", "/api/memory/scopes/:key", async ({ app, principal, params }) => {
			const p = await principal();
			await app.identity.authz.enforce(p, "api:write");
			// Its memories stay, and only the person reads them, until they are moved or forgotten.
			const n = await app.db.owner(p.ownerId, async (tx) => {
				const deleted = (await tx.query("DELETE FROM pim_app.memory_scopes WHERE key = $1", [params[0]!])).rowCount;
				// No agent keeps reading a scope that no longer has a name.
				if (deleted) await tx.query("UPDATE pim_app.agents SET config = jsonb_set(config, '{memoryScopes}', (SELECT coalesce(jsonb_agg(v), '[]'::jsonb) FROM jsonb_array_elements(config->'memoryScopes') v WHERE v <> to_jsonb($1::text))) WHERE config->'memoryScopes' ? $1", [params[0]!]);
				return deleted;
			});
			if (!n) throw new BadRequestError("Only a scope you named can be deleted");
			return ok({ deleted: true });
		}),
	];
}
