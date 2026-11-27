/**
 * What the web app asks of one chat beyond its transcript: its activity, cost, summary, the tasks it handed out, its group-chat room, what a
 * ```ui block of one of its messages holds, and renaming or deleting it. Everything is read and written as the signed-in owner, through the
 * application's tables, so row-level security decides what a person can reach.
 *
 * The utility model's side jobs (a title, a summary, an improved prompt, suggestions) are in ./utility.ts and are off until one is chosen. The queue behind
 * a running turn lives in the runtime's inbox; the chat's projection shows it, and a change to a queued message goes to the runtime as a command.
 */
import { DEFAULT_COMPACTION_POLICY } from "@earendil-works/pi-durable";
import { fromPerson, isDeliveryReminder, withoutFileChanges } from "@pim/shared/transcript";
import { checkUiState } from "@pim/ui-lang";
import { uiProgramsOf } from "../reply-blocks.ts";
import { createHash, randomUUID } from "node:crypto";
import type { App } from "@pim/v2-app/app";
import { addRoomMember, removeRoomMember, roomViews } from "../rooms.ts";
import { BadRequestError, CapabilityUnavailableError, ConflictError, NotFoundError } from "@pim/v2-app/errors";
import { ok, type Route, route } from "@pim/v2-app/http";
import type { Principal } from "@pim/v2-contracts/identity";
import { transcriptPage } from "@pim/v2-live/projections/snapshots";
import { chatActivity } from "./activity.ts";
import { cacheHitRatio, MAX_TURN_HISTORY, turnHistory } from "./cache-usage.ts";
import { contextWindowOf } from "./model.ts";
import { chatConversation, IMPROVE_PROMPT, runUtility, SUGGEST_PROMPTS, suggestionsIn, nameOneUntitled, SUMMARIZE_CHAT, titleChat } from "./utility.ts";

const ms = (value: Date | string | null | undefined): number | null => (value ? new Date(value).getTime() : null);
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const chatId = (id: string) => {
	if (!UUID.test(id)) throw new NotFoundError("No such chat");
	return id;
};

/** The chat as the app's `Session`. */
export async function sessionView(app: App, p: Principal, id: string) {
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

/**
 * The entry a fork of a chat ends at, by one of its messages, as the projected transcript has them: an agent's message with the results of the tools
 * it called, so the fork leaves nothing unanswered, or, `before` a person's message, the message just before it, so it can be sent again changed.
 * Null when nothing comes before that message, and undefined when `message` is no such message of the chat.
 */
async function forkPoint(app: App, p: Principal, chat: string, message: string, before: boolean): Promise<string | null | undefined> {
	return app.db.owner(p.ownerId, async (tx) => {
		const rows = (sql: string, ...values: unknown[]) => tx.query(`SELECT entry_id, message FROM pim_projection.chat_transcript_projection WHERE stream_kind = 'chat' AND chat_id = $1 AND NOT partial AND ${sql}`, [chat, ...values]).then((r) => r.rows);
		const found = (await rows("entry_id = $2", message))[0];
		if (!found || found.message.role !== (before ? "user" : "assistant")) return undefined;
		const after = `position ${before ? "<" : ">"} (SELECT position FROM pim_projection.chat_transcript_projection WHERE stream_kind = 'chat' AND chat_id = $1 AND entry_id = $2)`;
		if (before) return (await rows(`${after} ORDER BY position DESC LIMIT 1`, message))[0]?.entry_id ?? null;
		const calls = new Set<string>((found.message.parts as { type: string; id?: string }[]).flatMap((part) => (part.type === "tool-call" ? [part.id!] : [])));
		let end = message;
		for (const next of calls.size === 0 ? [] : await rows(`${after} ORDER BY position LIMIT ${calls.size}`, message)) {
			const result = next.message.parts[0];
			if (next.message.role !== "tool" || !calls.delete(result?.id)) break;
			end = next.entry_id;
		}
		return end;
	});
}

/** A fork's title: its chat's, numbered after the forks with that title the person still has, as "Trip (fork #2)"; none for a chat without one. */
async function forkTitle(app: App, p: Principal, title: string | null): Promise<string | undefined> {
	if (!title) return undefined;
	const base = title.replace(/ \(fork #\d+\)$/, "");
	const taken = await app.db.owner(p.ownerId, async (tx) => (await tx.query("SELECT title FROM pim_app.conversations WHERE deleted_at IS NULL AND starts_with(title, $1)", [`${base} (fork #`])).rows);
	const numbers = taken.map((r) => Number(/^ \(fork #(\d+)\)$/.exec((r.title as string).slice(base.length))?.[1] ?? 0));
	return `${base} (fork #${Math.max(0, ...numbers) + 1})`;
}

/** The group chat's room: how its agents take turns and who besides its host is in it; null for a chat with one agent. */
async function roomView(app: App, p: Principal, id: string) {
	return (await roomViews(app, p.ownerId, [id])).get(id) ?? null;
}

type QueuedInput = { id: number; mode: "steer" | "followUp"; content: string | ({ type: string; text?: string })[] };

const queuedText = (content: QueuedInput["content"]) => (typeof content === "string" ? content : content.flatMap((part) => (part.type === "text" ? [part.text ?? ""] : [])).join("\n"));

/**
 * Changes one of the person's messages queued behind the work in a chat, before the agent reads it: `steer` has it join the running work after the agent's
 * current step rather than wait for the run to end; `text` rewrites it, keeping its images; `cancel` takes it back. Judged against the queue as the chat shows it;
 * the runtime applies the change in the chat's partition, and nothing happens when the agent has read the message by then.
 */
async function changeQueued(app: App, p: Principal, chat: string, id: number, change: "steer" | "cancel" | { text: string }): Promise<void> {
	await app.identity.authz.enforce(p, "api:write");
	await sessionView(app, p, chat);
	const queue = await app.db.owner(p.ownerId, async (tx) => ((await tx.query("SELECT queue FROM pim_projection.sidebar_session_projection WHERE chat_id = $1", [chat])).rows[0]?.queue ?? []) as QueuedInput[]);
	const item = queue.find((queued) => queued.id === id);
	if (!item) throw new ConflictError("The agent has this message already", "not_queued");
	if (!fromPerson(queuedText(withoutFileChanges(item.content as never) as QueuedInput["content"]))) throw new NotFoundError("No such message of yours is queued");
	let payload: Record<string, unknown> = { id, change: change === "steer" || change === "cancel" ? change : "edit" };
	if (typeof change === "object") {
		const images = typeof item.content === "string" ? [] : item.content.filter((part) => part.type !== "text");
		if (change.text.trim() === "" && images.length === 0) throw new BadRequestError("A message needs text or an image");
		payload = { ...payload, content: images.length === 0 ? change.text : [...(change.text.trim() === "" ? [] : [{ type: "text", text: change.text }]), ...images] };
	}
	await app.conversations.admit(p, { commandId: `queue-${randomUUID()}`, kind: "queue_change", chatId: chat, payload });
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

/** The chat, the seats of its room, and every chat of a task they, or those they handed out in turn, started. */
const FAMILY = `WITH RECURSIVE family(chat) AS (
	SELECT $1::uuid UNION
	SELECT next.chat FROM family f CROSS JOIN LATERAL (
		SELECT c.public_chat_id AS chat FROM pim_app.conversations c WHERE c.room_of = f.chat
		UNION ALL SELECT t.task_chat FROM pim_app.tasks t WHERE t.started_by = f.chat AND t.task_chat IS NOT NULL) next)`;

/** What a chat with nothing said in it offers to start with, before any model has read anything: Pim's own, in the person's language (English when it has no others), as in v1. */
const STARTERS: Record<string, string[]> = { en: ["What can you do?", "Plan my week"], es: ["¿Qué puedes hacer?", "Planea mi semana"] };
const SUGGESTION_CHAT_CHARS = 2_000;
const SUGGESTION_MEMORY_CHARS = 3_000;
/** The suggestions last written for each chat and what they were written from, so a chat nobody continues costs no model call; and the ones being written now, which a second ask shares. */
const suggested = new Map<string, { of: string; items: string[] }>();
const suggesting = new Map<string, { of: string; promise: Promise<string[]> }>();

/** How long each chat's conversation was when its summary was last written, so a summary is written again only when more has been said. */
const summarized = new Map<string, number>();

export function sessionRoutes(env: Record<string, string | undefined> = process.env): Route[] {
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
			await sessionView(app, p, id);
			// A watch of the chat is forgotten here too, so it is not renewed; its connector stops sending when the grant runs out, and what it sends meanwhile is refused.
			await app.db.owner(p.ownerId, (tx) => tx.query("DELETE FROM pim_app.watch_subscriptions WHERE trigger_id IN (SELECT id FROM pim_app.triggers WHERE spec->'destination'->>'type' = 'existing_chat' AND spec->'destination'->>'chatId' = $1)", [id]));
			await app.conversations.remove(p, id);
			return ok({ deleted: true });
		}),

		route("GET", "/api/sessions/:id/activity", async ({ app, principal, params }) => {
			const p = await principal();
			await app.identity.authz.enforce(p, "api:read");
			const id = chatId(params[0]!);
			await sessionView(app, p, id);
			// The chat's latest turn, step by step: how long each model call and tool call took, what is running now, and what has gone quiet.
			return ok(await chatActivity(app, p.ownerId, id));
		}),
		route("GET", "/api/sessions/:id/cost", async ({ app, principal, params }) => {
			const p = await principal();
			await app.identity.authz.enforce(p, "api:read");
			const id = chatId(params[0]!);
			await sessionView(app, p, id);
			// The chat's own model calls and, apart from them, its coding threads' spend (`run_kind = 'coding_thread'`, recorded under the chat that started the thread, `provider` being the harness). A coding row counts toward the
			// cache hit rate only when its harness reported the cache tiers: one that reports tokens alone would read as a full miss.
			const rows = await app.db.owner(p.ownerId, async (tx) => (await tx.query(
				`${FAMILY} SELECT coalesce(provider, '') AS provider, coalesce(model, '') AS model, run_kind = 'coding_thread' AS coding, count(DISTINCT thread_id)::int AS threads,
				        sum(input_tokens)::bigint AS input, sum(output_tokens)::bigint AS output, sum(cache_read_tokens)::bigint AS cache_read, sum(cache_write_tokens)::bigint AS cache_write, sum(cost_microusd)::bigint AS cost,
				        coalesce(sum(input_tokens) FILTER (WHERE run_kind <> 'coding_thread' OR cache_read_tokens + cache_write_tokens > 0), 0)::bigint AS measured_input,
				        coalesce(sum(cache_read_tokens) FILTER (WHERE run_kind <> 'coding_thread' OR cache_read_tokens + cache_write_tokens > 0), 0)::bigint AS measured_read,
				        coalesce(sum(cache_write_tokens) FILTER (WHERE run_kind <> 'coding_thread' OR cache_read_tokens + cache_write_tokens > 0), 0)::bigint AS measured_write
				 FROM pim_app.model_calls WHERE public_chat_id IN (SELECT chat FROM family) GROUP BY 1, 2, 3 ORDER BY sum(cost_microusd) DESC, 1, 2`,
				[id],
			)).rows);
			const line = (r: any) => ({ provider: r.provider as string, model: r.model as string, input: Number(r.input), output: Number(r.output), cacheRead: Number(r.cache_read), cacheWrite: Number(r.cache_write), cost: Number(r.cost) / 1e6 });
			const models = rows.filter((r) => !r.coding).map(line);
			const coding = rows.filter((r) => r.coding).map((r) => ({ ...line(r), harness: r.provider as string, threads: r.threads as number }));
			const measured = (key: "measured_input" | "measured_read" | "measured_write") => rows.reduce((n, r) => n + Number(r[key]), 0);
			return ok({ total: [...models, ...coding].reduce((n, m) => n + m.cost, 0), cacheHitRatio: cacheHitRatio({ input: measured("measured_input"), cacheRead: measured("measured_read"), cacheWrite: measured("measured_write") }), models, coding });
		}),
		// The chat's last model calls, newest first, for the cost meter's history; read only when the person opens it.
		route("GET", "/api/sessions/:id/turns", async ({ app, principal, params }) => {
			const p = await principal();
			await app.identity.authz.enforce(p, "api:read");
			const id = chatId(params[0]!);
			await sessionView(app, p, id);
			const rows = await app.db.owner(p.ownerId, async (tx) => (await tx.query(
				`${FAMILY} SELECT id, at, model, input_tokens, output_tokens, cache_read_tokens, cache_write_tokens, cost_microusd
				 FROM pim_app.model_calls WHERE public_chat_id IN (SELECT chat FROM family) AND input_tokens + output_tokens + cache_read_tokens + cache_write_tokens > 0
				 ORDER BY at DESC, id DESC LIMIT ${MAX_TURN_HISTORY}`,
				[id],
			)).rows);
			return ok({ turns: turnHistory(rows) });
		}),
		// How full the chat's context is: the tokens the runtime counted (pi-durable's own measure, projected with the chat's line), out of what its model's context holds. Null until the chat has an answer.
		route("GET", "/api/sessions/:id/context", async ({ app, principal, params }) => {
			const p = await principal();
			await app.identity.authz.enforce(p, "api:read");
			const id = chatId(params[0]!);
			await sessionView(app, p, id);
			const summary = await app.db.owner(p.ownerId, async (tx) => (await tx.query("SELECT summary FROM pim_projection.sidebar_session_projection WHERE chat_id = $1", [id])).rows[0]?.summary as { contextTokens?: number; contextModel?: { provider: string; id: string } } | undefined);
			if (summary?.contextTokens === undefined || !summary.contextModel) return ok({ context: null });
			const window = await contextWindowOf(app, p, summary.contextModel);
			// pi-durable compacts a conversation once its context passes the window less the room it keeps for the answer; Pim leaves that policy as it is.
			const compactAt = window - DEFAULT_COMPACTION_POLICY.reserveTokens;
			return ok({ context: { tokens: summary.contextTokens, window, compactAt: compactAt > 0 ? compactAt : null, model: summary.contextModel.id } });
		}),
		// The summary is written by the utility model once the chat has something in it, and again only when more has been said since.
		route("GET", "/api/sessions/:id/summary", async ({ app, principal, params }) => {
			const p = await principal();
			await app.identity.authz.enforce(p, "api:read");
			const id = chatId(params[0]!);
			const row = await app.db.owner(p.ownerId, async (tx) => (await tx.query("SELECT summary, summary_of FROM pim_app.conversations WHERE public_chat_id = $1 AND deleted_at IS NULL", [id])).rows[0]);
			if (!row) throw new NotFoundError("No such chat");
			// A chat that carries another on keeps what its summary said of that one.
			if (row.summary_of) return ok({ summary: (row.summary as string | null) ?? null });
			const conversation = await chatConversation(app, p, id, 12000);
			if (conversation === "" || summarized.get(id) === conversation.length) return ok({ summary: (row.summary as string | null) ?? null });
			const written = await runUtility(app, env, p, SUMMARIZE_CHAT, conversation).catch((error) => (console.warn("the chat's summary failed", error), null));
			if (written === null) return ok({ summary: (row.summary as string | null) ?? null });
			summarized.set(id, conversation.length);
			await app.db.owner(p.ownerId, (tx) => tx.query("UPDATE pim_app.conversations SET summary = $2 WHERE public_chat_id = $1", [id, written]));
			return ok({ summary: written });
		}),
		// An empty chat offers Pim's starters. Once something is said, the utility model writes suggestions from the agent, what it remembers and this chat, and again only when that changed;
		// with no model, or when it fails, the last ones stay (none if there were none), as in v1.
		route("GET", "/api/sessions/:id/suggestions", async ({ app, principal, params, url }) => {
			const p = await principal();
			const id = chatId(params[0]!);
			const view = await sessionView(app, p, id);
			const locale = url.searchParams.get("locale") ?? "en";
			const conversation = await chatConversation(app, p, id, SUGGESTION_CHAT_CHARS);
			if (conversation === "") return ok({ suggestions: STARTERS[locale.split("-")[0]!.toLowerCase()] ?? STARTERS.en });
			const agent = await app.db.owner(p.ownerId, async (tx) => (await tx.query("SELECT id, name, description FROM pim_app.agents WHERE deleted_at IS NULL AND id = coalesce($1, pim_app.majordomo_id())", [view.agent?.id ?? null])).rows[0]);
			const reads = agent ? (await app.agents.memoryOf(p, agent.id as string)).reads : ["everyone"];
			const remembered = (await app.memories.list(p, reads).catch(() => [])).map((m) => `- ${m.title}: ${m.body.replace(/\s+/g, " ").slice(0, 200)}`).join("\n");
			const input = [
				agent ? `Assistant: ${agent.name}${agent.description ? `, ${agent.description}` : ""}` : "",
				`Language: ${locale}`,
				remembered === "" ? "" : `What it remembers about the person:\n${remembered.length > SUGGESTION_MEMORY_CHARS ? `…${remembered.slice(-SUGGESTION_MEMORY_CHARS)}` : remembered}`,
				`The chat:\n\n${conversation}`,
			].filter((part) => part !== "").join("\n\n");
			const key = `${p.ownerId}/${id}`;
			const of = createHash("sha256").update(input).digest("hex");
			const kept = suggested.get(key);
			if (kept?.of === of) return ok({ suggestions: kept.items });
			let writing = suggesting.get(key);
			if (!writing || writing.of !== of) {
				const promise = runUtility(app, env, p, SUGGEST_PROMPTS, input).then((answer) => {
					if (answer === null) throw new Error("no utility model");
					const items = suggestionsIn(answer);
					suggested.set(key, { of, items });
					return items;
				});
				writing = { of, promise };
				suggesting.set(key, writing);
				const done = () => void (suggesting.get(key)?.promise === promise && suggesting.delete(key));
				void promise.then(done, done);
			}
			return ok({ suggestions: await writing.promise.catch(() => kept?.items ?? []) });
		}),
		route("POST", "/api/sessions/:id/title", async ({ app, principal, params }) => {
			const p = await principal();
			await app.identity.authz.enforce(p, "api:write");
			const id = chatId(params[0]!);
			await sessionView(app, p, id);
			if ((await titleChat(app, env, p, id).catch((error) => (console.warn("the chat's title failed", error), null))) === null) needsModel("title");
			return ok(await sessionView(app, p, id));
		}),
		route("POST", "/api/prompts/improve", async ({ app, principal, json }) => {
			const p = await principal();
			await app.identity.authz.enforce(p, "api:write");
			const text = String((await json()).text ?? "").trim();
			if (text === "" || text.length > 20_000) throw new BadRequestError("text is 1 to 20000 characters");
			const improved = await runUtility(app, env, p, IMPROVE_PROMPT, text).catch((error) => (console.warn("improving a prompt failed", error), null));
			return improved === null ? needsModel("prompt improvement") : ok({ text: improved });
		}),

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
		// Asks the model again in a chat whose last request failed. A run held after the failure goes on where it stopped, with the message the person wrote and no second copy of it; one that ended before runs were held is sent that message again. A chat that is not waiting like that says so.
		route("POST", "/api/sessions/:id/retry", async ({ app, principal, params, json }) => {
			const p = await principal();
			const id = chatId(params[0]!);
			await sessionView(app, p, id);
			const messages = (await transcriptPage(app.db.pool, p.ownerId, id)).messages.filter((m) => !m.partial);
			const last = messages.at(-1);
			// The harness's own delivery reminders are user entries too, but not what the person asked.
			const asked = messages.findLast((m) => m.role === "user" && !isDeliveryReminder(m.parts.map((part) => (part.type === "text" ? part.text : "")).join("")));
			const text = asked?.parts.map((part) => (part.type === "text" ? part.text : "")).join("");
			if (last?.role !== "assistant" || last.stopReason !== "error" || !text) throw new ConflictError("This chat isn't waiting to try again", "not_held");
			const commandId = String(((await json().catch(() => ({}))) as Record<string, unknown>).commandId ?? `retry-${randomUUID()}`);
			await app.conversations.admit(p, { commandId, kind: "user_message", chatId: id, payload: { text, retry: true } });
			return ok({ session: id });
		}),
		// Asks the model again from one of the person's messages, in place: this chat's later messages (the agent's replies, tools, errors, the person's later messages) leave it, and the
		// message stays and is answered again. It is a command of the runtime (`retry_from`), which leaves the entries out of the model's context without deleting them, so nothing is
		// rebuilt. What tools did meanwhile is not undone. A chat at work is refused (the person stops it first); one held after a failed request is not at work, so its run is ended.
		route("POST", "/api/sessions/:id/messages/:message/retry", async ({ app, principal, params, json }) => {
			const p = await principal();
			const id = chatId(params[0]!);
			const view = await sessionView(app, p, id);
			const chat = (await app.db.owner(p.ownerId, async (tx) => (await tx.query("SELECT kind, room_of FROM pim_app.conversations WHERE public_chat_id = $1 AND deleted_at IS NULL", [id])).rows))[0];
			if (chat.kind === "visit" || chat.kind === "group" || chat.room_of !== null) throw new BadRequestError("A chat with someone else's agent, or with several agents, can't be retried from a message");
			const messages = (await transcriptPage(app.db.pool, p.ownerId, id)).messages.filter((m) => !m.partial);
			const message = messages.find((m) => m.id === params[1]);
			const said = message?.parts.map((part) => (part.type === "text" ? part.text : "")).join("");
			if (message?.role !== "user" || !/^\d+$/.test(message.id) || !fromPerson(said ?? "")) throw new BadRequestError("Retry from one of your own messages in this chat");
			const pending = await app.db.owner(p.ownerId, async (tx) => (await tx.query("SELECT 1 FROM pim_app.accepted_commands WHERE public_chat_id = $1 AND kind IN ('user_message', 'retry_from') AND state = 'inbox_accepted'", [id])).rowCount);
			const last = messages.at(-1);
			if (pending || (view.busy && !(last?.role === "assistant" && last.stopReason === "error"))) throw new ConflictError("The agent is at work in this chat; stop it first", "busy");
			const commandId = String(((await json().catch(() => ({}))) as Record<string, unknown>).commandId ?? `retry-${randomUUID()}`);
			await app.conversations.admit(p, { commandId, kind: "retry_from", chatId: id, payload: { entry: message.id } });
			// What was written of the chat from messages that are gone is written again when it is next asked for, even if the chat is as long as before.
			summarized.delete(id);
			suggested.delete(id);
			return ok({ session: id }, 202);
		}),
		// Lists an archived chat again; the web sends no command id, so one is made here.
		route("POST", "/api/sessions/:id/unarchive", async ({ app, principal, params }) => {
			await app.conversations.admit(await principal(), { commandId: `unarchive-${randomUUID()}`, kind: "unarchive", chatId: chatId(params[0]!), payload: {} });
			return ok({ ok: true });
		}),
		// A new chat with what was said in this one: through an agent's message (`at`), or up to one of the person's (`before`), to send it again changed.
		route("POST", "/api/sessions/:id/fork", async ({ app, principal, params, json }) => {
			const p = await principal();
			const id = chatId(params[0]!);
			const { at, before } = (await json()) as { at?: unknown; before?: unknown };
			const message = before ?? at;
			if (typeof message !== "string" || (at !== undefined && before !== undefined)) throw new BadRequestError("Give either at or before: a message's id");
			const chat = (await app.db.owner(p.ownerId, async (tx) => (await tx.query("SELECT agent_id, title, kind, room_of FROM pim_app.conversations WHERE public_chat_id = $1 AND deleted_at IS NULL", [id])).rows))[0];
			if (!chat) throw new NotFoundError("No such chat");
			if (chat.kind === "visit") throw new BadRequestError("A chat with someone else's agent can't be forked");
			if (chat.kind === "group" || chat.room_of !== null) throw new BadRequestError("A group chat can't be forked");
			const point = await forkPoint(app, p, id, message, before !== undefined);
			if (point === undefined) throw new BadRequestError(before !== undefined ? "before must be one of your messages in this chat" : "at must be one of the agent's messages in this chat");
			const title = await forkTitle(app, p, chat.title);
			// Nothing comes before the first message, so sending it again changed is a new chat.
			const fork = point === null ? await app.conversations.create(p, { agentId: chat.agent_id ?? undefined, title }) : (await app.conversations.admit(p, { commandId: `fork-${randomUUID()}`, kind: "fork", chatId: id, payload: { at: point, title } })).chatId!;
			return ok(await sessionView(app, p, fork));
		}),
		route("POST", "/api/sessions/:id/tasks/:task/cancel", async ({ app, principal, params }) => {
			const p = await principal();
			const find = () => app.db.owner(p.ownerId, async (tx) => (await tx.query(`${TASKS} WHERE t.task_id = $1 AND t.started_by = $2`, [params[1]!, chatId(params[0]!)])).rows[0]);
			if (!(await find())) throw new NotFoundError("No such task");
			await app.conversations.updateTask(p, params[1]!, "canceled");
			return ok(taskView(await find()));
		}),

		// ---- the queue behind a running turn: the runtime's inbox owns it ----
		route("POST", "/api/sessions/:id/queue/:item/steer", async ({ app, principal, params }) => {
			await changeQueued(app, await principal(), chatId(params[0]!), Number(params[1]), "steer");
			return ok({ id: Number(params[1]) });
		}),
		route("PUT", "/api/sessions/:id/queue/:item", async ({ app, principal, params, json }) => {
			const text = (await json()).text;
			if (typeof text !== "string") throw new BadRequestError("text is a string");
			await changeQueued(app, await principal(), chatId(params[0]!), Number(params[1]), { text });
			return ok({ id: Number(params[1]) });
		}),
		route("DELETE", "/api/sessions/:id/queue/:item", async ({ app, principal, params }) => {
			await changeQueued(app, await principal(), chatId(params[0]!), Number(params[1]), "cancel");
			return ok({ id: Number(params[1]) });
		}),

		// ---- the chat list, without the seats of group chats ----
		route("GET", "/api/sessions", async ({ app, principal, url }) => {
			const p = await principal();
			await app.identity.authz.enforce(p, "api:read");
			const limit = Number(url.searchParams.get("limit"));
			const sessions = await app.conversations.list(p.ownerId, { archived: url.searchParams.get("archived") === "true", limit: Number.isInteger(limit) && limit > 0 ? limit : 100 });
			const seats = new Set((await app.db.owner(p.ownerId, async (tx) => (await tx.query("SELECT public_chat_id FROM pim_app.conversations WHERE room_of IS NOT NULL AND public_chat_id = ANY($1::uuid[])", [sessions.map((s) => s.id)])).rows)).map((r) => r.public_chat_id as string));
			const shown = sessions.filter((s) => !seats.has(s.id));
			// Reading the list names one untitled chat, as reading the sidebar does.
			const named = url.searchParams.get("archived") === "true" ? null : await nameOneUntitled(app, process.env, p, shown);
			if (named) for (const s of shown) if (s.id === named.id) s.title = named.title;
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
		// How the agents of a group chat take turns: when mentioned (the default), or whenever the person speaks.
		route("PUT", "/api/sessions/:id/room", async ({ app, principal, params, json }) => {
			const p = await principal();
			await app.identity.authz.enforce(p, "api:write");
			const id = chatId(params[0]!);
			const mode = (await json()).mode;
			if (mode !== "mentions" && mode !== "open") throw new BadRequestError("mode is mentions or open");
			const changed = await app.db.owner(p.ownerId, async (tx) => (await tx.query("UPDATE pim_app.conversations SET room_mode = $2 WHERE public_chat_id = $1 AND deleted_at IS NULL AND room_of IS NULL AND EXISTS (SELECT 1 FROM pim_app.room_members WHERE public_chat_id = $1)", [id, mode])).rowCount);
			if (!changed) throw new NotFoundError("This chat is not a group chat");
			return ok({ room: await roomView(app, p, id) });
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
			const [message, block] = [params[0]!, params[1]!];
			return app.db.owner(p.ownerId, async (tx) => {
				const found = (await tx.query("SELECT message FROM pim_projection.chat_transcript_projection WHERE owner_id = $1 AND entry_id = $2 LIMIT 1", [p.ownerId, message])).rows[0];
				if (!found) throw new NotFoundError(`No such message ${message}`);
				// A block the message does not hold has no state; one it does is kept only as its program allows (`checkUiState`: shapes, sizes, at most 32 KB).
				const program = uiProgramsOf(found.message?.parts ?? []).get(block);
				if (!program) throw new NotFoundError(`Message ${message} has no ui block ${block}`);
				const checked = checkUiState(program, b.state);
				if (!checked.ok) throw new BadRequestError(checked.error);
				if (b.submitted === true && Object.keys(checked.state.submitted).length === 0) throw new BadRequestError("A block with no form submitted can't be marked submitted");
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
					[p.ownerId, message, block, JSON.stringify(checked.state), b.submitted === true],
				)).rows[0];
				return ok({ version: row.version, state: row.state, submitted: row.submitted, updatedAt: ms(row.updated_at) });
			});
		}),
	];
}
