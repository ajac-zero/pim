import type { Db } from "./db.ts";
import { Authorizer } from "./authz.ts";
import { BadRequestError, ConflictError, NotFoundError } from "./errors.ts";
import { newId } from "./ids.ts";
import type { Principal } from "@pim/v2-contracts/identity";

const MAX_NAMED_SCOPES = 20;

/** Memories (scopes: agent-<id>, everyone, or a custom shared scope) and skills. */
export class Memories {
	constructor(private readonly db: Db, private readonly authz = new Authorizer(db)) {}

	/** Names a new shared scope, such as Work, which agents read once it is shared with them (`Agents.update`'s `memoryScopes`). */
	async createScope(p: Principal, name: string): Promise<string> {
		await this.authz.enforce(p, "api:write");
		const key = `scope-${newId("s").slice(2)}`;
		await this.db.owner(p.ownerId, async (tx) => {
			if (((await tx.query("SELECT count(*)::int AS n FROM pim_app.memory_scopes")).rows[0].n as number) >= MAX_NAMED_SCOPES) throw new ConflictError(`You can have up to ${MAX_NAMED_SCOPES} named memory scopes.`, "too_many_scopes");
			await tx.query("INSERT INTO pim_app.memory_scopes (owner_id, key, name) VALUES ($1, $2, $3)", [p.ownerId, key, name]);
		});
		return key;
	}

	async remember(p: Principal, scope: string, title: string, body: string): Promise<string> {
		await this.authz.enforce(p, "api:write");
		const id = newId("m");
		await this.db.owner(p.ownerId, (tx) => tx.query("INSERT INTO pim_app.memories (id, owner_id, scope, title, body) VALUES ($1, $2, $3, $4, $5)", [id, p.ownerId, scope, title, body]));
		return id;
	}

	/** Regex recall over title and body inside `scopes`. The pattern is checked here and the query is time-limited, so a hostile pattern cannot hold a connection. */
	async recall(p: Principal, scopes: string[], pattern: string, limit = 20): Promise<{ id: string; scope: string; title: string }[]> {
		return (await this.search(p, scopes, pattern, limit)).matches;
	}

	/** `recall` with how many memories match in all, newest first, so an agent can tell that it saw only the newest of many. */
	async search(p: Principal, scopes: string[], pattern: string, limit = 20): Promise<{ matches: { id: string; scope: string; title: string }[]; total: number }> {
		await this.authz.enforce(p, "api:read");
		try {
			new RegExp(pattern);
		} catch (error) {
			throw new BadRequestError(`Invalid pattern: ${error instanceof Error ? error.message : String(error)}`);
		}
		return this.db.owner(p.ownerId, async (tx) => {
			await tx.query("SET LOCAL statement_timeout = '1000ms'");
			const { rows } = await tx.query("SELECT id, scope, title, count(*) OVER () AS total FROM pim_app.memories WHERE deleted_at IS NULL AND scope = ANY($1) AND (title ~* $2 OR body ~* $2) ORDER BY updated_at DESC LIMIT $3", [scopes, pattern, Math.min(limit, 100)]);
			const total = rows[0] ? Number(rows[0].total) : 0;
			return { matches: rows.map((r) => ({ id: r.id, scope: r.scope, title: r.title })), total };
		});
	}

	/** The lines of a memory from `start` for `count` (1-based): a block of a long memory without loading all of it into a prompt. */
	async zoom(p: Principal, id: string, start = 1, count = 40, within?: string[]): Promise<{ lines: string[]; total: number }> {
		await this.authz.enforce(p, "api:read");
		const body = await this.db.owner(p.ownerId, async (tx) => (await tx.query("SELECT body FROM pim_app.memories WHERE id = $1 AND deleted_at IS NULL AND ($2::text[] IS NULL OR scope = ANY($2))", [id, within ?? null])).rows[0]?.body as string | undefined);
		if (body === undefined) throw new NotFoundError("No such memory");
		const all = body.split("\n");
		return { lines: all.slice(Math.max(start, 1) - 1, Math.max(start, 1) - 1 + count), total: all.length };
	}

	/** `within` limits it to memories of those scopes: an agent forgets only what it reads. */
	async forget(p: Principal, id: string, within?: string[]): Promise<void> {
		await this.authz.enforce(p, "api:write");
		const n = await this.db.owner(p.ownerId, async (tx) => (await tx.query("UPDATE pim_app.memories SET deleted_at = now() WHERE id = $1 AND deleted_at IS NULL AND ($2::text[] IS NULL OR scope = ANY($2))", [id, within ?? null])).rowCount);
		if (!n) throw new NotFoundError("No such memory");
	}

	async move(p: Principal, id: string, scope: string, within?: string[]): Promise<void> {
		await this.authz.enforce(p, "api:write");
		const n = await this.db.owner(p.ownerId, async (tx) => (await tx.query("UPDATE pim_app.memories SET scope = $2, updated_at = now() WHERE id = $1 AND deleted_at IS NULL AND ($3::text[] IS NULL OR scope = ANY($3))", [id, scope, within ?? null])).rowCount);
		if (!n) throw new NotFoundError("No such memory");
	}

	async list(p: Principal, scopes?: string[]): Promise<{ id: string; scope: string; title: string; body: string; updatedAt: Date }[]> {
		await this.authz.enforce(p, "api:read");
		return this.db.owner(p.ownerId, async (tx) => (await tx.query("SELECT id, scope, title, body, updated_at FROM pim_app.memories WHERE deleted_at IS NULL AND ($1::text[] IS NULL OR scope = ANY($1)) ORDER BY updated_at DESC LIMIT 500", [scopes ?? null])).rows.map((r) => ({ id: r.id, scope: r.scope, title: r.title, body: r.body, updatedAt: r.updated_at })));
	}
}
