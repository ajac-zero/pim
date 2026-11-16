// `/api/coding/threads*`, `/api/coding/repos/:owner/:name/settings` and `/api/admin/coding/pools`, as a portable Fetch handler over the Forge facade.
import { randomUUID } from "node:crypto";
import { ForbiddenError, ForgeError } from "../errors";
import { type Forge } from "../forge";
import { type ForgeScheduler } from "../scheduler";
import { type Db, type Row } from "../db";
import { type ForgeStore } from "../store";
import { type Authenticate, type Handler, guarded, json, match, notGuest, readJson } from "./common";

export type RestDeps = { forge: Forge; scheduler: ForgeScheduler; store: ForgeStore; db: Db; authenticate: Authenticate };

const num = (v: string | null) => (v === null || v === "" ? undefined : Number(v));
const str = (v: unknown, what: string) => {
	if (typeof v !== "string" || v === "") throw new ForgeError("invalid", `${what} is required`);
	return v;
};

export function codingRest(d: RestDeps): Handler {
	const { forge } = d;
	return async (req) => {
		const url = new URL(req.url);
		const path = url.pathname;
		if (!path.startsWith("/api/coding/threads") && !path.startsWith("/api/coding/repos/") && !path.startsWith("/api/admin/coding/pools")) return null;
		return guarded(async () => {
			const caller = await d.authenticate(req);
			// Admin pools: a browser session of an admin only; an API token is refused.
			let m = match("/api/admin/coding/pools", path) ?? match("/api/admin/coding/pools/:id", path);
			if (m) {
				if (!caller || caller.actor.role !== "admin" || caller.via !== "session") throw new ForbiddenError("admin", "pools are managed by an admin's browser session");
				return pools(d, req, m.id, caller.actor.ownerId);
			}
			const { actor } = notGuest(caller);
			const get = req.method === "GET";
			const post = req.method === "POST";
			if ((m = match("/api/coding/threads", path))) {
				if (get) return json(200, { threads: await forge.list(actor, { archived: url.searchParams.get("archived") === "1" }) });
				if (post) {
					const b = await readJson(req);
					const r = await forge.start(actor, { operationId: typeof b.operationId === "string" ? b.operationId : randomUUID(), task: str(b.task, "task"), repo: str(b.repo, "repo"), ref: b.ref, harness: b.harness, chatId: b.chat, budgetUsd: b.budgetUsd ?? null, pool: b.pool ?? b.provider, profile: b.profile });
					return json(r.created ? 201 : 200, r);
				}
			}
			if ((m = match("/api/coding/repos/:owner/:name/settings", path))) {
				const repo = `${m.owner}/${m.name}`;
				if (get) return json(200, await forge.repoSettings(actor, repo));
				if (req.method === "PUT") return json(200, await forge.repoSettings(actor, repo, { setupScript: (await readJson(req, 80_000)).setupScript }));
			}
			if ((m = match("/api/coding/threads/:id", path)) && get) return json(200, await forge.status(actor, m.id));
			if ((m = match("/api/coding/threads/:id/:op", path))) {
				const id = m.id;
				switch (`${req.method} ${m.op}`) {
					case "GET transcript": {
						const q = url.searchParams;
						return json(200, await forge.transcriptPage(actor, id, { offset: num(q.get("offset")), limit: num(q.get("limit")), role: (q.get("role") as never) ?? undefined, summary: q.get("summary") === "1", tail: q.get("tail") === "1" }));
					}
					case "GET output": {
						const q = url.searchParams;
						return json(200, await forge.transcriptOutput(actor, id, { id: q.get("id") ?? undefined, offset: num(q.get("offset")), limit: num(q.get("limit")) }));
					}
					case "GET diff":
						return json(200, await forge.diff(actor, id));
					case "GET tests":
						return json(200, { runs: await forge.tests(actor, id) });
					case "GET log":
					case "GET events":
						return json(200, { events: await forge.eventsAfter(actor, id, num(url.searchParams.get("after")) ?? 0) });
					case "GET environment": {
						const t = await forge.status(actor, id);
						return json(200, { placement: t.placement, provisioning: t.provisioning });
					}
					case "POST seen":
						await forge.markSeen(actor, id);
						return json(200, { ok: true });
					case "POST steer": {
						const b = await readJson(req);
						return json(202, await forge.steer(actor, id, str(b.text, "text"), typeof b.operationId === "string" ? b.operationId : randomUUID()));
					}
					case "POST continue": {
						const b = await readJson(req);
						return json(202, await forge.continueThread(actor, id, typeof b.operationId === "string" ? b.operationId : randomUUID(), b.budgetUsd));
					}
					case "POST abort":
						return json(200, await forge.abort(actor, id));
					case "POST cancel":
						await forge.cancelQueued(actor, id);
						return json(200, { ok: true });
					case "POST archive":
						await forge.archive(actor, id);
						return json(200, { ok: true });
					case "POST push": {
						const r = await forge.push(actor, id);
						return json(r.status === "approval_required" ? 202 : 200, r);
					}
					case "POST pull-request": {
						const r = await forge.openPullRequest(actor, id, (await readJson(req)).title);
						return json(r.status === "approval_required" ? 202 : 200, r);
					}
				}
			}
			throw new ForgeError("not_found", "No such coding route");
		});
	};
}

async function pools(d: RestDeps, req: Request, id: string | undefined, admin: string): Promise<Response> {
	const audit = (type: string, poolId: string) => d.store.emit(d.db as never, "projection", `audit:${type}:${poolId}:${randomUUID()}`, null, { type, poolId, by: admin });
	if (req.method === "GET" && !id) {
		const rows = (await d.db.query<Row>("select p.*, b.failures, b.retry_at, (select count(*) from pim_forge.forge_slots s where s.pool_id = p.pool_id) held, (select count(*) from pim_forge.forge_queue q where q.pool_id = p.pool_id) waiting from pim_forge.forge_pools p left join pim_forge.forge_pool_breakers b using (pool_id) order by priority desc, pool_id")).rows;
		return json(200, { pools: rows.map((r) => ({ id: r.pool_id, provider: r.provider, size: r.size, priority: r.priority, enabled: r.enabled, held: Number(r.held), waiting: Number(r.waiting), failures: r.failures ?? 0, retryAt: r.retry_at })) });
	}
	if (req.method === "PUT" && id) {
		const b = await readJson(req);
		if (!/^[a-z0-9][a-z0-9-]{0,62}$/.test(id)) throw new ForgeError("invalid", "A pool id is a lowercase slug");
		if (!Number.isInteger(b.size) || b.size < 1 || b.size > 1000) throw new ForgeError("invalid", "A pool's size is 1 to 1000");
		const existed = (await d.db.query("select 1 from pim_forge.forge_pools where pool_id = $1", [id])).rows.length > 0;
		await d.scheduler.upsertPool({ poolId: id, provider: str(b.provider, "provider"), size: b.size, priority: Number.isInteger(b.priority) ? b.priority : 0, enabled: b.enabled !== false });
		await audit(existed ? "pim.sandbox_pool_changed" : "pim.sandbox_pool_added", id);
		await d.scheduler.promote(id);
		return json(200, { id });
	}
	if (req.method === "DELETE" && id) {
		const busy = Number((await d.db.query<Row>("select (select count(*) from pim_forge.forge_slots where pool_id = $1) + (select count(*) from pim_forge.forge_queue where pool_id = $1) n", [id])).rows[0]!.n);
		if (busy) throw new ForgeError("conflict", "The pool has threads in it; disable it instead");
		await d.db.query("delete from pim_forge.forge_pool_breakers where pool_id = $1", [id]);
		const r = await d.db.query("delete from pim_forge.forge_pools where pool_id = $1", [id]);
		if (!r.rowCount) throw new ForgeError("not_found", `No pool ${id}`);
		await audit("pim.sandbox_pool_removed", id);
		return json(200, { ok: true });
	}
	throw new ForgeError("not_found", "No such pool route");
}
