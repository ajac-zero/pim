/**
 * The tools that go with group chats and with reading other chats, ported from v1 (`src/rooms.ts`, `src/extensions/chats.ts`): the host takes agents out of the chat once they are
 * no longer needed (`remove_from_chat`), and any agent reads another of the person's chats (`read_chat`), or with no id what was said in a group chat before it joined.
 */
import { Type } from "typebox";
import type { ToolRegistration } from "@earendil-works/pi-durable";
import type { App } from "@pim/v2-app/app";
import type { Principal } from "@pim/v2-contracts/identity";
import { ROOM_POST } from "@pim/shared/transcript";
import { transcriptPage } from "@pim/v2-live/projections/snapshots";
import type { Db as RuntimeDb } from "@pim/v2-runtime/db";
import { conversationText } from "./compat/utility.ts";
import { removeRoomMember } from "./rooms.ts";
import { agentCalled } from "./agent-team-tools.ts";

type Result = { output: { type: "text"; text: string }[]; isError?: boolean };
type Call = { chat: string | null; p: Principal; api: any; agentId: string | null; context: any };
type Define = (name: string, description: string, parameters: any, run: (app: App, call: Call, args: any) => Promise<Result>) => ToolRegistration;

const text = (s: string, isError = false): Result => ({ output: [{ type: "text", text: s }], ...(isError ? { isError } : {}) });

/** How much of a chat a read keeps: its latest part. */
const READ_CHAT_CHARS = 48_000;
const ROOM_HISTORY_CHARS = 24_000;

/**
 * What was said in a room, as an agent that joined late reads it: the person's messages, what the host sent, and what other agents said, by name. Pim's own notices are left out. A long
 * chat keeps its end.
 */
export function roomHistory(messages: readonly { role: string; parts: readonly { type: string; text?: string; name?: string; arguments?: unknown }[] }[], host: string, limit: number): string {
	const turns: string[] = [];
	for (const message of messages) {
		if (message.role === "user") {
			const said = message.parts.flatMap((part) => (part.type === "text" ? [part.text ?? ""] : [])).join("\n").trim();
			const post = ROOM_POST.exec(said);
			if (post) turns.push(`${post[1]}: ${said.slice(post[0].length).trim()}`);
			// Pim's own messages to the host start with a bracketed label: they weren't said in the chat.
			else if (said !== "" && !said.startsWith("[")) turns.push(`The person: ${said}`);
		} else if (message.role === "assistant") {
			for (const part of message.parts) {
				if (part.type !== "tool-call" || part.name !== "send_to_user") continue;
				const sent = (part.arguments as { message?: unknown } | null)?.message;
				if (typeof sent === "string" && sent.trim() !== "") turns.push(`${host}: ${sent.trim()}`);
			}
		}
	}
	const said = turns.join("\n\n");
	return said.length > limit ? `…${said.slice(said.length - limit)}` : said;
}

export function roomTools(deps: { ownerId: string; runtime: RuntimeDb; read: Define }): ToolRegistration[] {
	const { ownerId, runtime } = deps;
	const roomOf = async (chat: string | null) =>
		chat ? (await runtime.read<{ r: { role: "host" | "seat"; host: { id: string; name: string } | null; members: { id: string; name: string }[] } | null }>(ownerId, "SELECT pim_app.runner_room($1, $2) AS r", [ownerId, chat]).catch(() => ({ rows: [] as never[] }))).rows[0]?.r ?? null : null;

	const remove = deps.read(
		"remove_from_chat",
		"Take agents out of this group chat once they are no longer needed. Only the chat's host can. They hear nothing more said here, and can be brought in again by mentioning them.",
		Type.Object({ agents: Type.Array(Type.String({ description: "An agent's name, as the chat's list gives it." }), { minItems: 1 }) }),
		async (app, call, a) => {
			const room = await roomOf(call.chat);
			if (!room || room.role !== "host" || !call.chat) return text("Only the chat's host takes agents out of it.", true);
			const said: string[] = [];
			for (const name of a.agents as string[]) {
				const member = agentCalled(name.replace(/^@/, ""), room.members.map((m) => ({ ...m, role: m.name })));
				// Run again, it finds those it took out already gone.
				if (!member || !room.members.some((m) => m.id === member.id)) {
					said.push(`${name} isn't in this chat.`);
					continue;
				}
				await removeRoomMember(app, call.p, call.chat, member.id);
				said.push(`${member.name} left the chat.`);
			}
			return text(said.join("\n"));
		},
	);

	/** What was said in a group chat before this seat joined it. */
	const before = async (app: App, call: Call): Promise<Result> => {
		const room = await roomOf(call.chat);
		if (!room || room.role !== "seat" || !call.chat) return text("You have everything said in this chat already.");
		const seat = (await app.db.owner(ownerId, async (tx) => (await tx.query(
			"SELECT s.room_of, s.created_at, coalesce(a.name, 'Pim') AS host FROM pim_app.conversations s JOIN pim_app.conversations h ON h.public_chat_id = s.room_of LEFT JOIN pim_app.agents a ON a.id = h.agent_id WHERE s.public_chat_id = $1", [call.chat])).rows))[0];
		if (!seat) return text("You have everything said in this chat already.");
		const joined = (seat.created_at as Date).getTime();
		const before = (await transcriptPage(app.db.pool, ownerId, seat.room_of as string)).messages.filter((m) => m.timestamp < joined);
		const said = roomHistory(before, seat.host as string, ROOM_HISTORY_CHARS);
		return text(said === "" ? "Nothing was said in this chat before you joined." : said);
	};

	const readChat = deps.read(
		"read_chat",
		"Read another of the person's chats by its id, which they can copy from the chat's title bar: what they said and what the agent in it sent them. Use it to carry on from a chat in a new one, or to check what was done in a previous chat. A long chat is cut to its latest part. With no id, in a group chat you joined late, it reads what was said before you joined.",
		Type.Object({ id: Type.Optional(Type.String({ minLength: 1, description: "The chat's id." })) }),
		async (app, call, a) => {
			if (a.id === undefined) return before(app, call);
			const id = String(a.id).trim();
			const chat = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id)
				? (await app.db.owner(ownerId, async (tx) => (await tx.query("SELECT title FROM pim_app.conversations WHERE public_chat_id = $1 AND deleted_at IS NULL AND room_of IS NULL AND kind <> 'visit'", [id])).rows))[0]
				: undefined;
			if (!chat) return text(`The person has no chat with id ${a.id}.`, true);
			const said = conversationText((await transcriptPage(app.db.pool, ownerId, id)).messages, READ_CHAT_CHARS);
			return text(`Chat${chat.title ? ` "${chat.title}"` : ""}:\n\n${said || "(nothing was said)"}`);
		},
	);

	return [remove, readChat];
}
