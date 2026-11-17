/**
 * Group chats (rooms), ported from v1 (`src/rooms.ts`). A chat is with one agent, its host, until another of the person's agents is brought in from the chat's header or
 * mentioned as `@Name`; the chat is then a room. Each other agent has a seat: a conversation of its own (so it works as itself, with its own instructions, memory and tools),
 * hidden from the chat list and the sidebar (`room_of`, migration 0646). What the person says goes into every seat; what an agent sends with `send_to_user` goes into the host
 * chat as "[From Name]", which the web app shows as that agent's message.
 *
 * Who takes a turn: in `mentions` mode, the default, the host answers what the person says to no one in particular and an agent answers what mentions it; everything else is
 * only written into the other conversations, in their context from their next request, without waking them. In `open` mode everything the person says wakes every agent.
 *
 * Not ported: agents waking each other (what an agent posts reaches the host chat, and is written, not delivered as a wake, to the other seats: no one is set off by an agent,
 * so there is no loop to bound), and a model per seat.
 */
import type { App } from "@pim/v2-app/app";
import { createChat, requestId, requireChat } from "@pim/v2-app/conversations";
import type { Tx } from "@pim/v2-app/db";
import { ConflictError, NotFoundError } from "@pim/v2-app/errors";
import type { Principal } from "@pim/v2-contracts/identity";

const WORD = /[\p{L}\p{N}_]/u;

/** The agents a message mentions, as `@Name` (case-insensitive; an address such as ada@example.com mentions no one; the longest name wins). */
export function mentionedAgents(text: string, agents: readonly { id: string; name: string }[]): string[] {
	const lower = text.toLowerCase();
	const keys = agents.filter((a) => a.name !== "").map((a) => ({ key: a.name.toLowerCase(), id: a.id })).sort((a, b) => b.key.length - a.key.length);
	const found: string[] = [];
	for (const match of lower.matchAll(/@/g)) {
		if (match.index! > 0 && WORD.test(lower[match.index! - 1]!)) continue;
		const rest = lower.slice(match.index! + 1);
		const hit = keys.find(({ key }) => rest.startsWith(key) && !WORD.test(rest[key.length] ?? ""));
		if (hit && !found.includes(hit.id)) found.push(hit.id);
	}
	return found;
}

const accept = async (tx: Tx, ownerId: string, commandId: string, chat: string, payload: Record<string, unknown>): Promise<void> => {
	const first = await tx.query("INSERT INTO pim_app.accepted_commands (owner_id, command_id, kind, public_chat_id, pi_request_id, payload) VALUES ($1,$2,'user_message',$3,$4,$5) ON CONFLICT (owner_id, command_id) DO NOTHING RETURNING command_id", [
		ownerId, commandId, chat, requestId(ownerId, commandId), JSON.stringify(payload),
	]);
	if (first.rowCount) await tx.query("INSERT INTO pim_app.command_inbox (owner_id, command_id, partition_id) VALUES ($1, $2, (SELECT partition_id FROM pim_app.conversations WHERE public_chat_id = $3))", [ownerId, commandId, chat]);
};

/**
 * Gives the seats of a room what the person said, in the transaction that accepted it (`Conversations.onUserMessage`). A seat that is not woken has the message written into it.
 * Returns whether the host chat is woken by it; a chat that is not a room always is.
 */
async function hearInRoom(tx: Tx, ownerId: string, chatId: string, commandId: string, payload: Record<string, unknown>): Promise<{ host: boolean }> {
	const members = (await tx.query("SELECT m.member AS id, a.name, m.seat_chat_id FROM pim_app.room_members m JOIN pim_app.agents a ON a.id = m.member WHERE m.public_chat_id = $1 AND m.seat_chat_id IS NOT NULL ORDER BY m.member", [chatId])).rows;
	if (members.length === 0) return { host: true };
	const host = (await tx.query("SELECT c.room_mode, a.id AS agent_id, coalesce(a.name, 'Pim') AS name FROM pim_app.conversations c LEFT JOIN pim_app.agents a ON a.id = c.agent_id WHERE c.public_chat_id = $1", [chatId])).rows[0];
	const text = typeof payload.text === "string" ? payload.text : typeof payload.content === "string" ? payload.content : "";
	const hostId = (host.agent_id as string | null) ?? "host";
	const mentioned = mentionedAgents(text, [{ id: hostId, name: host.name }, ...members.map((m) => ({ id: m.id as string, name: m.name as string }))]);
	const open = host.room_mode === "open";
	for (const m of members) {
		const wake = open || mentioned.includes(m.id as string);
		await accept(tx, ownerId, `${commandId}:seat:${m.id}`.slice(0, 128), m.seat_chat_id as string, { ...payload, ...(wake ? {} : { write: true }) });
	}
	return { host: open || mentioned.length === 0 || mentioned.includes(hostId) };
}

/** Makes a deployment's Gate give a room's seats what the person says. */
export function installRooms(app: App): void {
	app.conversations.onUserMessage = hearInRoom;
}

/** Brings an agent into a chat's room: it gets a seat. The chat becomes a room (mentions mode) with its first member. */
export async function addRoomMember(app: App, p: Principal, chatId: string, agentId: string): Promise<void> {
	await app.identity.authz.enforce(p, "api:write");
	await app.db.owner(p.ownerId, async (tx) => {
		const host = await requireChat(tx, chatId);
		if (host.room_of) throw new ConflictError("A seat is not a chat of its own", "not_a_room");
		const agent = (await tx.query("SELECT name FROM pim_app.agents WHERE id = $1 AND deleted_at IS NULL", [agentId])).rows[0];
		if (!agent) throw new NotFoundError("No such agent");
		if (host.agent_id === agentId) throw new ConflictError("That agent is the chat's own", "already_member");
		if ((await tx.query("SELECT 1 FROM pim_app.room_members WHERE public_chat_id = $1 AND member = $2 AND seat_chat_id IS NOT NULL", [chatId, agentId])).rowCount) return;
		const seat = await createChat(tx, p.ownerId, { agentId, title: `${agent.name} in ${host.title ?? "a group chat"}` });
		await tx.query("UPDATE pim_app.conversations SET room_of = $2 WHERE public_chat_id = $1", [seat, chatId]);
		await tx.query("INSERT INTO pim_app.room_members (public_chat_id, owner_id, member, seat_chat_id) VALUES ($1, $2, $3, $4) ON CONFLICT (public_chat_id, member) DO UPDATE SET seat_chat_id = $4", [chatId, p.ownerId, agentId, seat]);
		await tx.query("UPDATE pim_app.conversations SET kind = CASE WHEN kind = 'normal' THEN 'group' ELSE kind END, room_mode = coalesce(room_mode, 'mentions') WHERE public_chat_id = $1", [chatId]);
	});
}

/** Takes an agent out of the room: it hears nothing more and its seat is deleted. It can be brought in again later, afresh. */
export async function removeRoomMember(app: App, p: Principal, chatId: string, agentId: string): Promise<void> {
	await app.identity.authz.enforce(p, "api:write");
	await app.db.owner(p.ownerId, async (tx) => {
		await requireChat(tx, chatId);
		const gone = (await tx.query("DELETE FROM pim_app.room_members WHERE public_chat_id = $1 AND member = $2 RETURNING seat_chat_id", [chatId, agentId])).rows[0];
		if (gone?.seat_chat_id) await tx.query("UPDATE pim_app.conversations SET deleted_at = now() WHERE public_chat_id = $1", [gone.seat_chat_id]);
	});
}

/**
 * What an agent in a room sends: it lands in the host chat as "[From Name]", written without waking the host, and the host chat is unread. Posted under a key (the tool call's),
 * so a replay posts nothing twice. Returns false for a chat that is not a seat, which has nothing to post to.
 */
export async function postToRoom(app: App, p: Principal, seatChatId: string, key: string, message: string): Promise<boolean> {
	await app.identity.authz.enforce(p, "api:write");
	return app.db.owner(p.ownerId, async (tx) => {
		const seat = (await tx.query("SELECT c.room_of, a.name FROM pim_app.conversations c LEFT JOIN pim_app.agents a ON a.id = c.agent_id WHERE c.public_chat_id = $1", [seatChatId])).rows[0];
		if (!seat?.room_of) return false;
		await accept(tx, p.ownerId, `room-post:${seatChatId}:${key}`.slice(0, 128), seat.room_of as string, { text: `[From ${seat.name ?? "an agent"}]\n${message}`, write: true });
		await tx.query("UPDATE pim_app.conversations SET response_at = now(), updated_at = now() WHERE public_chat_id = $1", [seat.room_of]);
		return true;
	});
}

/** The room of each of these chats as the app's `Room` (who is in it, which of them is at work, and the model each runs on); a chat that is not a room is absent from the map. */
export async function roomViews(app: App, ownerId: string, chatIds: readonly string[]) {
	const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
	const ids = chatIds.filter((id) => uuid.test(id));
	const rows = ids.length === 0 ? [] : await app.db.owner(ownerId, async (tx) => (await tx.query(
		`SELECT c.public_chat_id::text AS chat, c.room_mode, m.member, a.name, a.model, a.config,
		        coalesce((SELECT s.busy FROM pim_projection.sidebar_session_projection s WHERE s.chat_id = m.seat_chat_id::text), false) AS busy
		 FROM pim_app.room_members m JOIN pim_app.conversations c ON c.public_chat_id = m.public_chat_id LEFT JOIN pim_app.agents a ON a.id = m.member AND a.deleted_at IS NULL
		 WHERE m.public_chat_id = ANY($1::uuid[]) AND c.deleted_at IS NULL ORDER BY m.member`, [ids])).rows);
	const views = new Map<string, { mode: "mentions" | "open"; members: unknown[] }>();
	for (const r of rows) {
		const model = (r.config?.model as { provider: string; id: string } | undefined) ?? { provider: "", id: r.model ?? "" };
		const room = views.get(r.chat) ?? { mode: r.room_mode === "open" ? ("open" as const) : ("mentions" as const), members: [] };
		room.members.push({ id: r.member, name: r.name ?? r.member, busy: r.busy === true, held: false, error: null, model: { model: { provider: model.provider, id: model.id, name: model.id || "Default model", images: false }, override: false } });
		views.set(r.chat, room);
	}
	return views;
}
