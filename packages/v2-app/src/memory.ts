import type { Db } from "./db.ts";
import { Authorizer } from "./authz.ts";
import { BadRequestError, ConflictError, NotFoundError } from "./errors.ts";
import { newId } from "./ids.ts";
import type { Principal } from "@pim/v2-contracts/identity";

const MAX_NAMED_SCOPES = 20;

/** Memories (scopes: agent-<id>, everyone, or a custom shared scope), skills and goals. */
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

	async createGoal(p: Principal, title: string, steps: string[]): Promise<string> {
		await this.authz.enforce(p, "api:write");
		const id = newId("g");
		await this.db.owner(p.ownerId, async (tx) => {
			await tx.query("INSERT INTO pim_app.goals (id, owner_id, title) VALUES ($1, $2, $3)", [id, p.ownerId, title]);
			for (const [i, step] of steps.entries()) await tx.query("INSERT INTO pim_app.goal_steps (goal_id, owner_id, position, title) VALUES ($1, $2, $3, $4)", [id, p.ownerId, i, step]);
		});
		return id;
	}

	async listGoals(p: Principal) {
		await this.authz.enforce(p, "api:read");
		return this.db.owner(p.ownerId, async (tx) => (await tx.query("SELECT g.id, g.title, g.status, g.notes, (SELECT coalesce(jsonb_agg(jsonb_build_object('position', s.position, 'title', s.title, 'done', s.done) ORDER BY s.position), '[]') FROM pim_app.goal_steps s WHERE s.goal_id = g.id) AS steps FROM pim_app.goals g ORDER BY g.created_at DESC")).rows.map((r) => ({ id: r.id as string, title: r.title as string, status: r.status as string, notes: r.notes as { at: number; text: string }[], steps: r.steps as { position: number; title: string; done: boolean }[] })));
	}

	async getGoal(p: Principal, id: string) {
		const goal = (await this.listGoals(p)).find((g) => g.id === id);
		if (!goal) throw new NotFoundError("No such goal");
		return goal;
	}

	/**
	 * `update_goal`: the title, the status (active, paused, done or dropped, which v1 called abandoned), the steps (replaced as a list; a step that keeps its title keeps its done mark),
	 * steps added to the end, and a progress note, which is kept with when it was written.
	 */
	async updateGoal(p: Principal, id: string, input: { title?: string; status?: string; steps?: string[]; addSteps?: string[]; note?: string }) {
		await this.authz.enforce(p, "api:write");
		const status = input.status === "abandoned" ? "dropped" : input.status;
		if (status !== undefined && !["active", "paused", "done", "dropped"].includes(status)) throw new BadRequestError("status is active, paused, done or dropped");
		await this.db.owner(p.ownerId, async (tx) => {
			const note = input.note?.trim() ? JSON.stringify([{ at: Date.now(), text: input.note.trim().slice(0, 2000) }]) : "[]";
			if (!(await tx.query("UPDATE pim_app.goals SET title = coalesce($2, title), status = coalesce($3, status), notes = notes || $4::jsonb WHERE id = $1", [id, input.title ?? null, status ?? null, note])).rowCount) throw new NotFoundError("No such goal");
			if (input.addSteps?.length) {
				const next = (await tx.query("SELECT coalesce(max(position) + 1, 0)::int AS n FROM pim_app.goal_steps WHERE goal_id = $1", [id])).rows[0].n as number;
				for (const [i, title] of input.addSteps.entries()) await tx.query("INSERT INTO pim_app.goal_steps (goal_id, owner_id, position, title) VALUES ($1,$2,$3,$4)", [id, p.ownerId, next + i, title]);
			}
			if (input.steps) {
				const old = new Map((await tx.query("SELECT title, done FROM pim_app.goal_steps WHERE goal_id = $1", [id])).rows.map((r) => [r.title as string, r.done as boolean]));
				await tx.query("DELETE FROM pim_app.goal_steps WHERE goal_id = $1", [id]);
				for (const [i, title] of input.steps.entries()) await tx.query("INSERT INTO pim_app.goal_steps (goal_id, owner_id, position, title, done) VALUES ($1,$2,$3,$4,$5)", [id, p.ownerId, i, title, old.get(title) ?? false]);
			}
		});
		return this.getGoal(p, id);
	}

	async deleteGoal(p: Principal, id: string): Promise<void> {
		await this.authz.enforce(p, "api:write");
		if (!(await this.db.owner(p.ownerId, async (tx) => (await tx.query("DELETE FROM pim_app.goals WHERE id = $1", [id])).rowCount))) throw new NotFoundError("No such goal");
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
