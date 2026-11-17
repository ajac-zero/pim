/**
 * What the web app asks of one chat beyond its transcript: its activity, cost, summary, the tasks it handed out, its group-chat room, what a
 * ```ui block of one of its messages holds, and renaming or deleting it. Everything is read and written as the signed-in owner, through the
 * application's tables, so row-level security decides what a person can reach.
 *
 * Not here, because they need something this Pim does not run yet: the utility-model side jobs (suggestions, a regenerated title, an improved
 * prompt) and changing the queue behind a running turn, which lives in the runtime's inbox, not in the application's tables.
 */
import type { App } from "@pim/v2-app/app";
import { addRoomMember, removeRoomMember, roomViews } from "../rooms.ts";
import { BadRequestError, CapabilityUnavailableError, ConflictError, NotFoundError } from "@pim/v2-app/errors";
import { ok, type Route, route } from "@pim/v2-app/http";
import type { Principal } from "@pim/v2-contracts/identity";
import { transcriptPage } from "@pim/v2-live/projections/snapshots";

const ms = (value: Date | string | null | undefined): number | null => (value ? new Date(value).getTime() : null);
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const chatId = (id: string) => {
	if (!UUID.test(id)) throw new NotFoundError("No such chat");
	return id;
};

/** The chat as the app's `Session`. */
async function sessionView(app: App, p: Principal, id: string) {
	return app.db.owner(p.ownerId, async (tx) => {
		const r = (await tx.query(
			`SELECT c.public_chat_id, c.title, c.created_at, c.updated_at, c.response_at, c.read_at, c.archived_at, c.agent_id, a.name AS agent_name,
			        coalesce((SELECT s.busy FROM pim_projection.sidebar_session_projection s WHERE s.chat_id = c.public_chat_id::text), false) AS busy
			 FROM pim_app.conversations c LEFT JOIN pim_app.agents a ON a.id = c.agent_id WHERE c.public_chat_id = $1 AND c.deleted_at IS NULL`,
			[id],
		)).rows[0];
		if (!r) throw new NotFoundError("No such chat");
		return {
			id: r.public_chat_id as string, title: r.title as string | null, busy: r.busy as boolean, createdAt: ms(r.created_at), updatedAt: ms(r.updated_at), responseAt: ms(r.response_at),
			unread: r.response_at !== null && (r.read_at === null || r.read_at < r.response_at), archived: r.archived_at !== null,
			agent: r.agent_id ? { id: r.agent_id as string, name: (r.agent_name as string | null) ?? r.agent_id } : null,
		};
	});
}

/** The group chat's room: how its agents take turns and who besides its host is in it; null for a chat with one agent. */
async function roomView(app: App, p: Principal, id: string) {
	return (await roomViews(app, p.ownerId, [id])).get(id) ?? null;
}

/** A task as the app's `AgentTask`: who handed it out, who has it, and how it stands. */
const TASKS = `SELECT t.task_id, t.title, t.status, t.result, t.created_at, t.updated_at, t.task_chat, t.started_by,
	tc.agent_id AS to_agent, ta.name AS to_name, sc.agent_id AS from_agent, sa.name AS from_name
	FROM pim_app.tasks t
	LEFT JOIN pim_app.conversations tc ON tc.public_chat_id = t.task_chat LEFT JOIN pim_app.agents ta ON ta.id = tc.agent_id
	LEFT JOIN pim_app.conversations sc ON sc.public_chat_id = t.started_by LEFT JOIN pim_app.agents sa ON sa.id = sc.agent_id`;
const taskView = (r: any) => ({
	id: r.task_id as string, parent: null, call: null, session: r.task_chat as string | null,
	agent: { id: (r.to_agent as string | null) ?? "", name: (r.to_name as string | null) ?? r.to_agent ?? "" },
	from: { id: (r.from_agent as string | null) ?? "", name: (r.from_name as string | null) ?? r.from_agent ?? "" },
	task: r.title as string, state: r.status as string, result: r.result as string | null, createdAt: ms(r.created_at), updatedAt: ms(r.updated_at),
});

/** The chat and every chat of a task it, or those it handed out in turn, started. */
const FAMILY = `WITH RECURSIVE family(chat) AS (
	SELECT $1::uuid UNION SELECT t.task_chat FROM pim_app.tasks t JOIN family f ON t.started_by = f.chat WHERE t.task_chat IS NOT NULL)`;

export function sessionRoutes(): Route[] {
	const gone = () => {
		throw new ConflictError("That message is no longer in the queue", "not_queued");
	};
	const needsModel = (what: string): never => {
		throw new CapabilityUnavailableError(what, "no utility model is configured on this Pim");
	};
	return [
		route("PUT", "/api/sessions/:id", async ({ app, principal, params, json }) => {
			const p = await principal();
			await app.identity.authz.enforce(p, "api:write");
			const id = chatId(params[0]!);
			const title = String((await json()).title ?? "").trim();
			if (title === "" || title.length > 200) throw new BadRequestError("A chat's title is 1 to 200 characters");
			const n = await app.db.owner(p.ownerId, async (tx) => (await tx.query("UPDATE pim_app.conversations SET title = $2 WHERE public_chat_id = $1 AND deleted_at IS NULL", [id, title])).rowCount);
			if (!n) throw new NotFoundError("No such chat");
			return ok(await sessionView(app, p, id));
		}),
		route("DELETE", "/api/sessions/:id", async ({ app, principal, params }) => {
			const p = await principal();
			await app.identity.authz.enforce(p, "api:write");
			const id = chatId(params[0]!);
			const n = await app.db.owner(p.ownerId, async (tx) => (await tx.query("UPDATE pim_app.conversations SET deleted_at = now() WHERE public_chat_id = $1 AND deleted_at IS NULL", [id])).rowCount);
			if (!n) throw new NotFoundError("No such chat");
			return ok({ deleted: true });
		}),

		route("GET", "/api/sessions/:id/activity", async ({ app, principal, params }) => {
			const p = await principal();
			await app.identity.authz.enforce(p, "api:read");
			const id = chatId(params[0]!);
			const chat = await sessionView(app, p, id);
			const calls = await app.db.owner(p.ownerId, async (tx) => (await tx.query("SELECT provider, model, at FROM pim_app.model_calls WHERE public_chat_id = $1 ORDER BY at DESC LIMIT 50", [id])).rows);
			return ok({
				running: chat.busy, lastActivityAt: chat.updatedAt ?? 0, current: [],
				steps: calls.reverse().map((c) => ({ kind: "model", at: ms(c.at), ms: null, model: [c.provider, c.model].filter(Boolean).join("/"), stop: "stop", error: null })),
				stalls: [],
			});
		}),
		route("GET", "/api/sessions/:id/cost", async ({ app, principal, params }) => {
			const p = await principal();
			await app.identity.authz.enforce(p, "api:read");
			const id = chatId(params[0]!);
			await sessionView(app, p, id);
			const rows = await app.db.owner(p.ownerId, async (tx) => (await tx.query(
				`${FAMILY} SELECT coalesce(provider, '') AS provider, coalesce(model, '') AS model, sum(input_tokens)::bigint AS input, sum(output_tokens)::bigint AS output, sum(cost_microusd)::bigint AS cost
				 FROM pim_app.model_calls WHERE public_chat_id IN (SELECT chat FROM family) GROUP BY 1, 2 ORDER BY 5 DESC`,
				[id],
			)).rows);
			const models = rows.map((r) => ({ provider: r.provider as string, model: r.model as string, input: Number(r.input), output: Number(r.output), cacheRead: 0, cacheWrite: 0, cost: Number(r.cost) / 1e6 }));
			return ok({ total: models.reduce((sum, m) => sum + m.cost, 0), models });
		}),
		route("GET", "/api/sessions/:id/summary", async ({ app, principal, params }) => {
			const p = await principal();
			await app.identity.authz.enforce(p, "api:read");
			const id = chatId(params[0]!);
			const row = await app.db.owner(p.ownerId, async (tx) => (await tx.query("SELECT summary FROM pim_app.conversations WHERE public_chat_id = $1 AND deleted_at IS NULL", [id])).rows[0]);
			if (!row) throw new NotFoundError("No such chat");
			return ok({ summary: (row.summary as string | null) ?? null });
		}),
		// The utility model's side jobs: none is configured, so there are no suggestions, and a title or an improved prompt cannot be made.
		route("GET", "/api/sessions/:id/suggestions", async ({ app, principal, params }) => {
			const p = await principal();
			await sessionView(app, p, chatId(params[0]!));
			return ok({ suggestions: [] });
		}),
		route("POST", "/api/sessions/:id/title", async ({ principal }) => (await principal(), needsModel("title"))),
		route("POST", "/api/prompts/improve", async ({ principal }) => (await principal(), needsModel("prompt improvement"))),

		// ---- tasks ----
		route("GET", "/api/sessions/:id/tasks", async ({ app, principal, params }) => {
			const p = await principal();
			await app.identity.authz.enforce(p, "api:read");
			const id = chatId(params[0]!);
			await sessionView(app, p, id);
			return ok({ tasks: (await app.db.owner(p.ownerId, async (tx) => (await tx.query(`${TASKS} WHERE t.started_by = $1 ORDER BY t.created_at`, [id])).rows)).map(taskView) });
		}),
		route("GET", "/api/sessions/:id/tasks/:task", async ({ app, principal, params }) => {
			const p = await principal();
			await app.identity.authz.enforce(p, "api:read");
			const row = (await app.db.owner(p.ownerId, async (tx) => (await tx.query(`${TASKS} WHERE t.task_id = $1 AND t.started_by = $2`, [params[1]!, chatId(params[0]!)])).rows))[0];
			if (!row) throw new NotFoundError("No such task");
			const messages = row.task_chat ? (await transcriptPage(app.db.pool, p.ownerId, row.task_chat as string)).messages : [];
			return ok({ ...taskView(row), messages });
		}),
		route("POST", "/api/sessions/:id/tasks/:task/cancel", async ({ app, principal, params }) => {
			const p = await principal();
			const find = () => app.db.owner(p.ownerId, async (tx) => (await tx.query(`${TASKS} WHERE t.task_id = $1 AND t.started_by = $2`, [params[1]!, chatId(params[0]!)])).rows[0]);
			if (!(await find())) throw new NotFoundError("No such task");
			await app.conversations.updateTask(p, params[1]!, "canceled");
			return ok(taskView(await find()));
		}),

		// ---- the queue behind a running turn: the runtime's inbox owns it ----
		route("POST", "/api/sessions/:id/queue/:item/steer", async ({ principal }) => (await principal(), gone())),
		route("PUT", "/api/sessions/:id/queue/:item", async ({ principal }) => (await principal(), gone())),
		route("DELETE", "/api/sessions/:id/queue/:item", async ({ principal }) => (await principal(), gone())),

		// ---- the chat list, without the seats of group chats ----
		route("GET", "/api/sessions", async ({ app, principal, url }) => {
			const p = await principal();
			await app.identity.authz.enforce(p, "api:read");
			const limit = Number(url.searchParams.get("limit"));
			const sessions = await app.conversations.list(p.ownerId, { archived: url.searchParams.get("archived") === "true", limit: Number.isInteger(limit) && limit > 0 ? limit : 100 });
			const seats = new Set((await app.db.owner(p.ownerId, async (tx) => (await tx.query("SELECT public_chat_id FROM pim_app.conversations WHERE room_of IS NOT NULL AND public_chat_id = ANY($1::uuid[])", [sessions.map((s) => s.id)])).rows)).map((r) => r.public_chat_id as string));
			const shown = sessions.filter((s) => !seats.has(s.id));
			const rooms = await roomViews(app, p.ownerId, shown.map((s) => s.id));
			return ok({ sessions: shown.map((s) => ({ ...s, room: rooms.get(s.id) ?? null })) });
		}),

		// ---- a group chat's room ----
		route("POST", "/api/sessions/:id/room/members", async ({ app, principal, params, json }) => {
			const p = await principal();
			const id = chatId(params[0]!);
			await addRoomMember(app, p, id, String((await json()).agent ?? ""));
			return ok({ room: await roomView(app, p, id) }, 201);
		}),
		route("DELETE", "/api/sessions/:id/room/members/:agent", async ({ app, principal, params }) => {
			const p = await principal();
			const id = chatId(params[0]!);
			await removeRoomMember(app, p, id, params[1]!);
			return ok({ room: await roomView(app, p, id) });
		}),
		// A held run is the runtime's to try again; the room is answered as it stands.
		route("POST", "/api/sessions/:id/room/members/:agent/retry", async ({ app, principal, params }) => {
			const p = await principal();
			return ok({ room: await roomView(app, p, chatId(params[0]!)) });
		}),

		// ---- what a ```ui block of a message holds ----
		route("GET", "/api/messages/:id/ui-state", async ({ app, principal, params }) => {
			const p = await principal();
			await app.identity.authz.enforce(p, "api:read");
			const rows = await app.db.owner(p.ownerId, async (tx) => (await tx.query("SELECT block, version, state, submitted, updated_at FROM pim_app.ui_states WHERE message_id = $1", [params[0]!])).rows);
			return ok({ blocks: Object.fromEntries(rows.map((r) => [r.block as string, { version: r.version as number, state: r.state, submitted: r.submitted as boolean, updatedAt: ms(r.updated_at) }])) });
		}),
		route("PUT", "/api/messages/:id/ui-state/:block", async ({ app, principal, params, json }) => {
			const p = await principal();
			await app.identity.authz.enforce(p, "api:write");
			const b = await json();
			if (!Number.isInteger(b.version) || b.version < 0) throw new BadRequestError("version must be the version you last read, 0 for none");
			if (b.submitted !== undefined && typeof b.submitted !== "boolean") throw new BadRequestError("submitted must be true or false");
			if (typeof b.state !== "object" || b.state === null || Array.isArray(b.state) || JSON.stringify(b.state).length > 65_536) throw new BadRequestError("state must be an object of at most 64 KB");
			const [message, block] = [params[0]!, params[1]!];
			return app.db.owner(p.ownerId, async (tx) => {
				if (!(await tx.query("SELECT 1 FROM pim_projection.chat_transcript_projection WHERE owner_id = $1 AND entry_id = $2 LIMIT 1", [p.ownerId, message])).rowCount) throw new NotFoundError(`No such message ${message}`);
				const current = (await tx.query("SELECT version, state, submitted, updated_at FROM pim_app.ui_states WHERE message_id = $1 AND block = $2 FOR UPDATE", [message, block])).rows[0];
				// A block that was submitted stays as it was submitted; one written since the version the caller read isn't overwritten unseen.
				if (current && (current.submitted || current.version !== b.version)) {
					const kept = { version: current.version, state: current.state, submitted: current.submitted, updatedAt: ms(current.updated_at) };
					return { status: 409, body: { error: current.submitted ? "This block was submitted and can't be changed" : "This block was saved since the version you sent", current: kept } };
				}
				if (!current && b.version !== 0) return { status: 409, body: { error: "This block was saved since the version you sent", current: null } };
				const row = (await tx.query(
					`INSERT INTO pim_app.ui_states (owner_id, message_id, block, version, state, submitted) VALUES ($1, $2, $3, 1, $4, $5)
					 ON CONFLICT (owner_id, message_id, block) DO UPDATE SET version = pim_app.ui_states.version + 1, state = $4, submitted = $5, updated_at = now() RETURNING version, state, submitted, updated_at`,
					[p.ownerId, message, block, JSON.stringify(b.state), b.submitted === true],
				)).rows[0];
				return ok({ version: row.version, state: row.state, submitted: row.submitted, updatedAt: ms(row.updated_at) });
			});
		}),
	];
}
