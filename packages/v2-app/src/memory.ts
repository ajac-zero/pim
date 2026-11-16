import type { Db } from "./db.ts";
import { Authorizer } from "./authz.ts";
import { BadRequestError, NotFoundError } from "./errors.ts";
import { newId } from "./ids.ts";
import type { Principal } from "@pim/v2-contracts/identity";

/** Memories (scopes: agent-<id>, everyone, or a custom shared scope), skills and goals. */
export class Memories {
	constructor(private readonly db: Db, private readonly authz = new Authorizer(db)) {}

	async remember(p: Principal, scope: string, title: string, body: string): Promise<string> {
		await this.authz.enforce(p, "api:write");
		const id = newId("m");
		await this.db.owner(p.ownerId, (tx) => tx.query("INSERT INTO pim_app.memories (id, owner_id, scope, title, body) VALUES ($1, $2, $3, $4, $5)", [id, p.ownerId, scope, title, body]));
		return id;
	}

	/** Regex recall over title and body inside `scopes`. The pattern is checked here and the query is time-limited, so a hostile pattern cannot hold a connection. */
	async recall(p: Principal, scopes: string[], pattern: string, limit = 20): Promise<{ id: string; scope: string; title: string }[]> {
		await this.authz.enforce(p, "api:read");
		try {
			new RegExp(pattern);
		} catch {
			throw new BadRequestError("That pattern is not a valid regular expression");
		}
		return this.db.owner(p.ownerId, async (tx) => {
			await tx.query("SET LOCAL statement_timeout = '1000ms'");
			const { rows } = await tx.query("SELECT id, scope, title FROM pim_app.memories WHERE deleted_at IS NULL AND scope = ANY($1) AND (title ~* $2 OR body ~* $2) ORDER BY updated_at DESC LIMIT $3", [scopes, pattern, Math.min(limit, 100)]);
			return rows.map((r) => ({ id: r.id, scope: r.scope, title: r.title }));
		});
	}

	/** The lines of a memory from `start` for `count` (1-based): a block of a long memory without loading all of it into a prompt. */
	async zoom(p: Principal, id: string, start = 1, count = 40): Promise<{ lines: string[]; total: number }> {
		await this.authz.enforce(p, "api:read");
		const body = await this.db.owner(p.ownerId, async (tx) => (await tx.query("SELECT body FROM pim_app.memories WHERE id = $1 AND deleted_at IS NULL", [id])).rows[0]?.body as string | undefined);
		if (body === undefined) throw new NotFoundError("No such memory");
		const all = body.split("\n");
		return { lines: all.slice(Math.max(start, 1) - 1, Math.max(start, 1) - 1 + count), total: all.length };
	}

	async forget(p: Principal, id: string): Promise<void> {
		await this.authz.enforce(p, "api:write");
		const n = await this.db.owner(p.ownerId, async (tx) => (await tx.query("UPDATE pim_app.memories SET deleted_at = now() WHERE id = $1 AND deleted_at IS NULL", [id])).rowCount);
		if (!n) throw new NotFoundError("No such memory");
	}

	async move(p: Principal, id: string, scope: string): Promise<void> {
		await this.authz.enforce(p, "api:write");
		const n = await this.db.owner(p.ownerId, async (tx) => (await tx.query("UPDATE pim_app.memories SET scope = $2, updated_at = now() WHERE id = $1 AND deleted_at IS NULL", [id, scope])).rowCount);
		if (!n) throw new NotFoundError("No such memory");
	}

	async createSkill(p: Principal, input: { name: string; description?: string; body?: string; files?: Record<string, string> }): Promise<string> {
		await this.authz.enforce(p, "api:write");
		const id = newId("sk");
		await this.db.owner(p.ownerId, (tx) => tx.query("INSERT INTO pim_app.skills (id, owner_id, name, description, body, files) VALUES ($1,$2,$3,$4,$5,$6)", [id, p.ownerId, input.name, input.description ?? "", input.body ?? "", JSON.stringify(input.files ?? {})]));
		return id;
	}

	async createGoal(p: Principal, title: string, steps: string[]): Promise<string> {
		await this.authz.enforce(p, "api:write");
		const id = newId("g");
		await this.db.owner(p.ownerId, async (tx) => {
			await tx.query("INSERT INTO pim_app.goals (id, owner_id, title) VALUES ($1, $2, $3)", [id, p.ownerId, title]);
			for (const [i, step] of steps.entries()) await tx.query("INSERT INTO pim_app.goal_steps (goal_id, owner_id, position, title) VALUES ($1, $2, $3, $4)", [id, p.ownerId, i, step]);
		});
		return id;
	}

	/** Marks a step done; the goal is done when its last step is. */
	async completeStep(p: Principal, goalId: string, position: number): Promise<{ goalDone: boolean }> {
		await this.authz.enforce(p, "api:write");
		return this.db.owner(p.ownerId, async (tx) => {
			const n = (await tx.query("UPDATE pim_app.goal_steps SET done = true WHERE goal_id = $1 AND position = $2", [goalId, position])).rowCount;
			if (!n) throw new NotFoundError("No such step");
			const left = (await tx.query("SELECT count(*)::int AS n FROM pim_app.goal_steps WHERE goal_id = $1 AND NOT done", [goalId])).rows[0].n;
			if (left === 0) await tx.query("UPDATE pim_app.goals SET status = 'done' WHERE id = $1", [goalId]);
			return { goalDone: left === 0 };
		});
	}
}
