/**
 * Notifications and Web Push for the person, made from what is committed. The maintenance role runs `notifyPass`: it turns an approval that is waiting, and an agent's
 * reply the runtime committed (read back from the committed conversation entries, found through the runtime's own map from the chat to its conversation), into what the bell lists and into messages for the person's devices, then sends the
 * messages that are due. Everything it knows is a database row, so a restart repeats nothing and loses nothing: a notification's id is derived from the event it is
 * about, and a message stays queued until it is sent or given up on.
 */
import type { Pool } from "pg";
import type { App } from "@pim/v2-app/app";
import { publicUrl } from "./agent-tools.ts";
import { webApproval } from "./compat/boot.ts";
import { type PushSubscription, type VapidKeys, sendPush } from "./push.ts";

export type NotifierOptions = {
	/** The deployment's VAPID keys; without them nothing is sent to devices, and the bell still fills. */
	vapid?: VapidKeys | undefined;
	/** The VAPID `sub` claim: the deployment's public URL or a `mailto:` address. */
	subject: string;
	/** Lets a push endpoint be plain http or on a private address: for a stand-in push service in development. */
	allowPrivate?: boolean;
	fetch?: typeof fetch;
	now?: () => Date;
};

/** How far back a pass looks for approvals and replies it has not announced, so a stack started on old data does not announce all of it. */
const LOOKBACK_MS = 60 * 60 * 1000;
/** How long a reply waits before its device alert, so a person who is reading it is not alerted, and how long a chat at work is waited for. */
export const REPLY_DELAY_MS = 10_000;
const BUSY_RETRY_MS = 30_000;
const GIVE_UP_MS = 10 * 60 * 1000;
const MAX_ATTEMPTS = 5;
const RETRY_MS = 60_000;
/** A device alert shows the opening sentences; a push message holds about 4 KB. */
const PUSH_BODY_MINIMUM = 90;
const PUSH_BODY_LENGTH = 240;

const WORD = /[\p{L}\p{N}_]/u;

/** Whether a message mentions the person, as `@` and any of their names, by the rules v1 used for its rooms. */
export function mentionsPerson(text: string, names: readonly string[]): boolean {
	const keys = names.map((name) => name.toLowerCase()).filter((name) => name !== "");
	const lower = text.toLowerCase();
	for (const match of lower.matchAll(/@/g)) {
		const at = match.index!;
		if (at > 0 && WORD.test(lower[at - 1]!)) continue;
		if (keys.some((key) => lower.startsWith(key, at + 1) && !WORD.test(lower[at + 1 + key.length] ?? ""))) return true;
	}
	return false;
}

/** The message with its markdown marks gone, cut to its opening sentences. */
export function opening(body: string): string {
	const plain = body.replace(/\*\*|`|^#+\s+/gm, "").replace(/\s*\n\s*/g, " ").trim();
	let out = "";
	for (const { segment } of new Intl.Segmenter(undefined, { granularity: "sentence" }).segment(plain)) {
		if (out !== "" && out.length + segment.length > PUSH_BODY_LENGTH) break;
		out += segment;
		if (out.length >= PUSH_BODY_MINIMUM) break;
	}
	return out.trim().slice(0, PUSH_BODY_LENGTH);
}

type Row = Record<string, any>;

/** Rows across owners: a read that sets `pim.scope` to `all`, which the tables maintenance finds work in admit for reading. */
async function acrossOwners(pool: Pool, sql: string, params: unknown[]): Promise<Row[]> {
	const client = await pool.connect();
	try {
		await client.query("BEGIN");
		await client.query("SELECT set_config('pim.scope', 'all', true)");
		const { rows } = await client.query(sql, params);
		await client.query("COMMIT");
		return rows;
	} catch (error) {
		await client.query("ROLLBACK").catch(() => undefined);
		throw error;
	} finally {
		client.release();
	}
}

type Entry = { model?: { role?: string; content?: unknown }[] };

/** What an agent last said to the person in a chat (what `send_to_user` was given) and whether the person had spoken since the agent said something before it. Entries are newest first. */
export function lastSaid(entries: readonly Entry[]): { message: string; asked: boolean } | undefined {
	const said = (entry: Entry): string | undefined => {
		const message = entry.model?.[0];
		if (message?.role !== "assistant" || !Array.isArray(message.content)) return undefined;
		const call = (message.content as { type?: string; name?: string; arguments?: { message?: unknown } }[]).findLast((part) => part.type === "toolCall" && part.name === "send_to_user");
		return typeof call?.arguments?.message === "string" ? call.arguments.message : undefined;
	};
	const at = entries.findIndex((entry) => said(entry) !== undefined);
	if (at < 0) return undefined;
	let asked = false;
	for (const entry of entries.slice(at + 1)) {
		if (said(entry) !== undefined) break;
		if (entry.model?.[0]?.role === "user") {
			asked = true;
			break;
		}
	}
	return { message: said(entries[at]!)!, asked };
}

/** One pass: announce what is new, then send what is due. How many notifications and device alerts it made or sent. */
export async function notifyPass(app: App, pool: Pool, options: NotifierOptions): Promise<number> {
	const now = (options.now ?? (() => new Date()))();
	return (await announceApprovals(app, pool, now)) + (await announceLostSignIns(app, pool, now)) + (await announceSchedules(app, pool, now)) + (await announceReplies(app, pool, now)) + (await deliver(app, pool, options, now));
}

/** The bell entry and, as a row of the same id, the device alert; once however often the event is seen. */
async function announce(app: App, ownerId: string, n: { id: string; kind: "general" | "mention" | "scheduled"; chat: string | null; title: string; body: string; /** No alert for the devices: the bell and the open apps only. */ quiet?: boolean }, at: Date): Promise<boolean> {
	return app.db.owner(ownerId, async (tx) => {
		const made = await tx.query("INSERT INTO pim_app.notifications (id, owner_id, kind, public_chat_id, title, body, created_at) VALUES ($1,$2,$3,$4,$5,$6,$7) ON CONFLICT DO NOTHING", [n.id, ownerId, n.kind, n.chat, n.title, n.body, at]);
		if (made.rowCount === 0) return false;
		if (n.quiet) return true;
		await tx.query("INSERT INTO pim_app.push_queue (id, owner_id, kind, public_chat_id, title, body, send_after, created_at) VALUES ($1,$2,'alert',$3,$4,$5,$6,$6) ON CONFLICT DO NOTHING", [n.id, ownerId, n.chat, n.title, n.body, at]);
		return true;
	});
}

/** An approval waiting is a row the application committed; it is announced once. */
async function announceApprovals(app: App, pool: Pool, now: Date): Promise<number> {
	const rows = await acrossOwners(
		pool,
		`SELECT a.* FROM pim_app.approvals a WHERE a.state = 'waiting' AND a.created_at > $1
		   AND NOT EXISTS (SELECT 1 FROM pim_app.notifications n WHERE n.owner_id = a.owner_id AND n.id = 'approval-' || a.id) ORDER BY a.created_at LIMIT 100`,
		[new Date(now.getTime() - LOOKBACK_MS)],
	);
	let made = 0;
	for (const row of rows) {
		const approval = webApproval(row);
		// A guest's or a circle member's call that asks the host says who asked and through what, as v1's alert did.
		const by = approval.requestedBy as { username?: unknown; circleName?: unknown } | null;
		const asked = typeof by?.username === "string" && typeof by.circleName === "string" ? { username: by.username, via: by.circleName } : null;
		const title = asked ? `${asked.username} asked ${asked.via}` : "Pim needs your approval";
		const body = asked ? `${asked.username} (${asked.via}) wants: ${typeof row.args?.summary === "string" ? row.args.summary : approval.summary}` : approval.summary;
		if (await announce(app, row.owner_id, { id: `approval-${row.id}`, kind: "general", chat: row.public_chat_id ?? null, title, body }, now)) made++;
	}
	return made;
}

/**
 * A connector whose sign-in the service revoked (`connector-credential.ts`) is a notification, once for each time it was lost: the person has to connect it again, and nothing
 * else tells them until an agent next tries to use it.
 */
async function announceLostSignIns(app: App, pool: Pool, now: Date): Promise<number> {
	const rows = await acrossOwners(
		pool,
		`SELECT c.owner_id, c.id, c.name, c.signin_lost_at FROM pim_app.connectors c WHERE c.signin_lost_at > $1 AND c.credential IS NULL
		   AND NOT EXISTS (SELECT 1 FROM pim_app.notifications n WHERE n.owner_id = c.owner_id AND n.id = 'connector-' || c.id || '-' || floor(extract(epoch FROM c.signin_lost_at) * 1000)::bigint) ORDER BY c.signin_lost_at LIMIT 100`,
		[new Date(now.getTime() - LOOKBACK_MS)],
	);
	let made = 0;
	for (const row of rows) {
		const id = `connector-${row.id}-${Math.floor(new Date(row.signin_lost_at).getTime())}`;
		if (await announce(app, row.owner_id, { id, kind: "general", chat: null, title: `${row.name} needs you to sign in again`, body: "Its sign-in was revoked or has expired. Connect it again from Connectors." }, now)) made++;
	}
	return made;
}

/**
 * A scheduled task that fired is a notification of its own kind, once per firing, as in v1: it names the task (its label, else what it asks) and links to the chat it runs in. It is for the
 * bell and the open apps only: the chat's own reply alerts the devices when it is ready.
 */
async function announceSchedules(app: App, pool: Pool, now: Date): Promise<number> {
	const rows = await acrossOwners(
		pool,
		`SELECT r.owner_id, r.schedule_id, r.command_id FROM pim_app.schedule_runs r
		  WHERE r.outcome = 'fired' AND r.command_id IS NOT NULL AND r.recorded_at > $1
		    AND NOT EXISTS (SELECT 1 FROM pim_app.notifications n WHERE n.owner_id = r.owner_id AND n.id = 'scheduled-' || r.command_id) ORDER BY r.recorded_at LIMIT 100`,
		[new Date(now.getTime() - LOOKBACK_MS)],
	);
	let made = 0;
	for (const row of rows) {
		const found = await app.db.owner(row.owner_id, async (tx) => ({
			task: (await tx.query("SELECT label, prompt FROM pim_app.schedules WHERE id = $1", [row.schedule_id])).rows[0],
			chat: (await tx.query("SELECT public_chat_id FROM pim_app.accepted_commands WHERE command_id = $1", [row.command_id])).rows[0]?.public_chat_id as string | undefined,
		}));
		const title = String(found.task?.label ?? found.task?.prompt ?? "Scheduled task").replace(/\s+/g, " ").trim();
		if (await announce(app, row.owner_id, { id: `scheduled-${row.command_id}`, kind: "scheduled", chat: found.chat ?? null, title: title.length > 80 ? `${title.slice(0, 79)}…` : title, body: "", quiet: true }, now)) made++;
	}
	return made;
}

/**
 * An agent's reply is announced from the committed conversation entries, not from the moment the run reported it: the text read is the text the runtime committed.
 * A reply that mentions the person is a notification of its own kind; any other reply is queued as a device alert that is judged when it is due.
 */
async function announceReplies(app: App, pool: Pool, now: Date): Promise<number> {
	const rows = await acrossOwners(
		pool,
		`SELECT c.owner_id, c.public_chat_id, c.title, c.response_at, a.name AS agent_name
		   FROM pim_app.conversations c LEFT JOIN pim_app.agents a ON a.owner_id = c.owner_id AND a.id = c.agent_id
		  WHERE c.response_at > $1 AND (c.notified_response_at IS NULL OR c.notified_response_at < c.response_at) AND c.deleted_at IS NULL AND c.kind NOT IN ('task', 'review')
		  ORDER BY c.response_at LIMIT 100`,
		[new Date(now.getTime() - LOOKBACK_MS)],
	);
	let made = 0;
	for (const row of rows) {
		const owner = row.owner_id as string;
		const at = row.response_at as Date;
		const said = await app.db.owner(owner, async (tx) => {
			const { rows: entries } = await tx.query("SELECT record FROM pim_runtime.entries WHERE owner_id = $1 AND conversation_id = (SELECT conversation_id FROM pim_runtime.conversation_partitions WHERE owner_id = $1 AND public_chat_id = $2) ORDER BY id DESC LIMIT 80", [owner, row.public_chat_id]);
			return lastSaid(entries.map((e) => JSON.parse(e.record)));
		});
		// The run reports a reply as it sends it; its text is committed with the model's message just before. Not seen yet: look again next pass, for a while.
		if (!said && now.getTime() - at.getTime() < 2 * 60_000) continue;
		const chat = row.public_chat_id as string;
		if (said) {
			const agent = (row.agent_name as string | null) ?? "Pim";
			const names = await app.db.owner(owner, async (tx) => {
				const username = (await tx.query("SELECT username FROM pim_app.accounts WHERE owner_id = $1", [owner])).rows[0]?.username as string | undefined;
				const named = (await tx.query("SELECT value FROM pim_app.owner_settings WHERE key = 'your_name'")).rows[0]?.value as string | undefined;
				return [username, named].filter((n): n is string => typeof n === "string");
			});
			if (said.message.includes("@") && mentionsPerson(said.message, names)) {
				if (await announce(app, owner, { id: `mention-${chat}-${at.getTime()}`, kind: "mention", chat, title: `${agent} mentioned you`, body: said.message.slice(0, 500) }, now)) made++;
			} else {
				await app.db.owner(owner, (tx) =>
					tx.query("INSERT INTO pim_app.push_queue (id, owner_id, kind, public_chat_id, title, body, asked, send_after) VALUES ($1,$2,'reply',$3,$4,$5,$6,$7) ON CONFLICT DO NOTHING", [`reply-${chat}-${at.getTime()}`, owner, chat, (row.title as string | null) ?? agent, said.message.slice(0, 500), said.asked, new Date(now.getTime() + REPLY_DELAY_MS)]),
				);
				made++;
			}
		}
		await app.db.owner(owner, (tx) => tx.query("UPDATE pim_app.conversations SET notified_response_at = $2 WHERE public_chat_id = $1", [chat, at]));
	}
	return made;
}

/** Sends the device alerts that are due, each claimed first so two passes never send one twice; one that cannot be sent now is tried again later. */
async function deliver(app: App, pool: Pool, options: NotifierOptions, now: Date): Promise<number> {
	const due = await acrossOwners(pool, "SELECT owner_id, id FROM pim_app.push_queue WHERE state = 'pending' AND send_after <= $1 ORDER BY send_after LIMIT 50", [now]);
	let sent = 0;
	for (const { owner_id: owner, id } of due) {
		const claimed = await app.db.owner(owner, async (tx) => {
			const row = (await tx.query("UPDATE pim_app.push_queue SET attempts = attempts + 1, send_after = $3 WHERE id = $1 AND owner_id = $2 AND state = 'pending' AND send_after <= $4 RETURNING *", [id, owner, new Date(now.getTime() + RETRY_MS), now])).rows[0];
			if (!row) return undefined;
			const chat = row.public_chat_id
				? (await tx.query(
						`SELECT c.response_at, c.read_at, coalesce((SELECT s.busy FROM pim_projection.sidebar_session_projection s WHERE s.chat_id = c.public_chat_id::text), false) AS busy
						   FROM pim_app.conversations c WHERE c.public_chat_id = $1`,
						[row.public_chat_id],
					)).rows[0]
				: undefined;
			const alerts = (await tx.query("SELECT value FROM pim_app.owner_settings WHERE key = 'settings.deviceAlerts'")).rows[0]?.value;
			const subscriptions = (await tx.query("SELECT endpoint, p256dh, auth FROM pim_app.push_subscriptions")).rows as PushSubscription[];
			return { row, chat, all: alerts === "all", subscriptions };
		});
		if (!claimed) continue;
		const { row, chat, all, subscriptions } = claimed;
		const finish = (state: "sent" | "dropped" | "pending", after?: Date) =>
			app.db.owner(owner, (tx) => tx.query("UPDATE pim_app.push_queue SET state = $3, send_after = coalesce($4, send_after) WHERE id = $1 AND owner_id = $2", [id, owner, state, after ?? null]));
		if (!options.vapid || subscriptions.length === 0) {
			await finish("dropped");
			continue;
		}
		if (row.kind === "reply") {
			// An answer alerts the devices only if the person has not read it, the chat is not at work again, and they asked for it (or want every message).
			const unread = chat && chat.response_at !== null && (chat.read_at === null || chat.read_at < chat.response_at);
			if (!unread || (!all && !row.asked)) {
				await finish("dropped");
				continue;
			}
			if (chat.busy && now.getTime() - new Date(row.created_at).getTime() < GIVE_UP_MS) {
				await finish("pending", new Date(now.getTime() + BUSY_RETRY_MS));
				continue;
			}
		}
		const message = { id, session: row.public_chat_id ?? null, agent: null, title: String(row.title).slice(0, 120), body: opening(row.body), ...(row.kind === "reply" ? { reply: true, kind: "reply" } : {}) };
		let failed = false;
		for (const subscription of subscriptions) {
			try {
				if (!options.allowPrivate) await publicUrl(subscription.endpoint);
				const alive = await sendPush(subscription, message, options.vapid, options.subject, options.fetch);
				if (!alive) await app.db.owner(owner, (tx) => tx.query("DELETE FROM pim_app.push_subscriptions WHERE endpoint = $1", [subscription.endpoint]));
			} catch (error) {
				failed = true;
				console.warn("web push failed", error instanceof Error ? error.message : error);
			}
		}
		await finish(failed && row.attempts < MAX_ATTEMPTS ? "pending" : "sent");
		sent++;
	}
	return sent;
}
