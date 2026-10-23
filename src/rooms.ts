import { defineExtension, section } from "@earendil-works/pi-durable";
import type { Agent } from "./agents";
import { DELEGATE } from "./tasks";
import { ROOM_POST, type TranscriptMessage } from "./transcript";

export { ROOM_POST };

/**
 * Group chats. A chat is with one agent, its host, until someone in it
 * mentions another of the person's agents by name, as `@Coach`: that agent
 * joins the chat, with what was said so far, and talks there itself. The
 * chat is then a room: the person and their agents in one conversation, each
 * agent hearing what the others say and answering where the person reads it.
 *
 * Each agent in a room has a seat: a conversation of its own, as a chat's,
 * so it works as itself, with its own instructions, apps, memory and tools.
 * The host's seat is the chat itself, the conversation the person reads.
 * What the person says goes into every seat; what an agent sends goes into
 * every other seat as a message starting "[From Coach]", which the chat
 * shows as Coach's.
 *
 * Who takes a turn: in a room in `mentions` mode, the default, the host
 * answers what the person says to no one in particular, and an agent
 * mentioned answers what mentioned it. Everything else is written into the
 * other seats without waking them, so each knows it when it next speaks. In
 * `open` mode everything said wakes every other agent in the room, and each
 * decides whether to say something.
 *
 * Agents can set each other off: a turn an agent takes because another
 * spoke is one further from the person's message that began the chain, and
 * none is woken `MAX_ROOM_DEPTH` turns away from it.
 */

export type RoomMode = "mentions" | "open";

/** An agent's place in a room: the conversation it talks in there. */
export type Seat = {
	readonly room: string;
	readonly agent: string;
	/** The chat itself for the host; a conversation of its own for any other agent. */
	readonly conversation: string;
	/** How many turns agents set off for each other led to its latest one, since the person last spoke. */
	readonly depth: number;
	readonly joinedAt: number;
};

/**
 * How far agents in a room may set each other off after the person speaks.
 * Unbounded while we see whether agents go round in circles in practice;
 * the depth is counted either way.
 */
export const MAX_ROOM_DEPTH = Number.POSITIVE_INFINITY;

/** The kind of the entries a room writes into a seat without waking its agent. */
export const ROOM_ENTRY = "pim.room";


/** What another agent in the room said, as the other seats hear it. */
export const roomPost = (name: string, text: string) => `[From ${name}]\n${text}`;

/** How Pim's own notes about the room start, such as who joined. */
export const ROOM_NOTICE = "[Room]";

const SCHEMA = `
CREATE TABLE IF NOT EXISTS pim_rooms (
	session TEXT PRIMARY KEY,
	mode TEXT NOT NULL DEFAULT 'mentions',
	created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS pim_room_seats (
	conversation TEXT PRIMARY KEY,
	room TEXT NOT NULL,
	agent TEXT NOT NULL,
	depth INTEGER NOT NULL DEFAULT 0,
	joined_at INTEGER NOT NULL,
	UNIQUE (room, agent)
);
CREATE INDEX IF NOT EXISTS pim_room_seats_by_room ON pim_room_seats (room, joined_at);
`;

const seatOf = (row: Record<string, SqlStorageValue>): Seat => ({
	room: String(row.room),
	agent: String(row.agent),
	conversation: String(row.conversation),
	depth: Number(row.depth),
	joinedAt: Number(row.joined_at),
});

export class RoomStore {
	readonly #sql: SqlStorage;

	constructor(sql: SqlStorage) {
		this.#sql = sql;
		this.#sql.exec(SCHEMA);
	}

	/** Makes a chat a room, with its host in the first seat; nothing when it is one already. */
	open(room: string, host: string): void {
		const now = Date.now();
		this.#sql.exec("INSERT OR IGNORE INTO pim_rooms (session, created_at) VALUES (?, ?)", room, now);
		this.#sql.exec("INSERT OR IGNORE INTO pim_room_seats (conversation, room, agent, joined_at) VALUES (?, ?, ?, ?)", room, room, host, now);
	}

	/** Seats an agent in a room, in its own conversation. */
	seat(room: string, agent: string, conversation: string): Seat {
		this.#sql.exec("INSERT OR IGNORE INTO pim_room_seats (conversation, room, agent, joined_at) VALUES (?, ?, ?, ?)", conversation, room, agent, Date.now());
		return this.at(room, agent)!;
	}

	/** The seat a conversation is, in whichever room. */
	of(conversation: string): Seat | undefined {
		const [row] = this.#sql.exec("SELECT * FROM pim_room_seats WHERE conversation = ?", conversation).toArray();
		return row ? seatOf(row) : undefined;
	}

	/** An agent's seat in a room. */
	at(room: string, agent: string): Seat | undefined {
		const [row] = this.#sql.exec("SELECT * FROM pim_room_seats WHERE room = ? AND agent = ?", room, agent).toArray();
		return row ? seatOf(row) : undefined;
	}

	/** A room's seats, the host's first, then in the order their agents joined; none for a chat that isn't a room. */
	seats(room: string): Seat[] {
		return this.#sql
			.exec("SELECT * FROM pim_room_seats WHERE room = ? ORDER BY conversation = room DESC, joined_at, rowid", room)
			.toArray()
			.map(seatOf);
	}

	mode(room: string): RoomMode {
		const [row] = this.#sql.exec("SELECT mode FROM pim_rooms WHERE session = ?", room).toArray();
		return row?.mode === "open" ? "open" : "mentions";
	}

	setMode(room: string, mode: RoomMode): void {
		this.#sql.exec("UPDATE pim_rooms SET mode = ? WHERE session = ?", mode, room);
	}

	setDepth(conversation: string, depth: number): void {
		this.#sql.exec("UPDATE pim_room_seats SET depth = ? WHERE conversation = ?", depth, conversation);
	}

	/** The conversations agents talk in in rooms other than the room's own chat: none of them is a chat of the person's. */
	conversations(): Set<string> {
		return new Set(
			this.#sql
				.exec("SELECT conversation FROM pim_room_seats WHERE conversation != room")
				.toArray()
				.map((row) => String(row.conversation)),
		);
	}
}

const WORD = /[\p{L}\p{N}_]/u;

/**
 * The agents a message mentions, as `@Name` or `@Role`, in the order it
 * first mentions them. A name two of them share means neither; a role is
 * one agent's. The longest name that fits wins, so `@Trip planner` is the
 * trip planner, not `@Trip`.
 */
export function mentioned(text: string, agents: readonly Agent[]): Agent[] {
	const keys: { key: string; agent: Agent }[] = [];
	const names = new Map<string, number>();
	for (const agent of agents) names.set(agent.name.toLowerCase(), (names.get(agent.name.toLowerCase()) ?? 0) + 1);
	for (const agent of agents) {
		keys.push({ key: agent.role.toLowerCase(), agent });
		if (names.get(agent.name.toLowerCase()) === 1) keys.push({ key: agent.name.toLowerCase(), agent });
	}
	keys.sort((a, b) => b.key.length - a.key.length);
	const lower = text.toLowerCase();
	const found: Agent[] = [];
	for (const match of lower.matchAll(/@/g)) {
		// An address such as ada@example.com mentions no one.
		if (match.index > 0 && WORD.test(lower[match.index - 1]!)) continue;
		const rest = lower.slice(match.index + 1);
		const hit = keys.find(({ key }) => key !== "" && rest.startsWith(key) && !WORD.test(rest[key.length] ?? ""));
		if (hit && !found.includes(hit.agent)) found.push(hit.agent);
	}
	return found;
}

/** How much of what was said an agent joining a chat reads, in characters: the end of a longer chat. */
export const ROOM_HISTORY_CHARS = 24_000;

/**
 * What was said in a room's chat, for an agent joining it: the person's
 * messages, what the host sent, and what other agents said, by name. Pim's
 * own notices are left out, and so is the host's last message when it is
 * `except`, the one that brought the agent in. Long chats keep their end.
 */
export function roomHistory(messages: readonly TranscriptMessage[], host: string, limit: number, except?: string): string {
	const turns: string[] = [];
	for (const message of messages) {
		if (message.role === "user") {
			const text = message.parts
				.flatMap((part) => (part.type === "text" ? [part.text] : []))
				.join("\n")
				.trim();
			const post = ROOM_POST.exec(text);
			if (post) turns.push(`${post[1]}: ${text.slice(post[0].length).trim()}`);
			// Pim's own messages to the host start with a bracketed label: they weren't said in the chat.
			else if (text !== "" && !text.startsWith("[")) turns.push(`The person: ${text}`);
		} else if (message.role === "assistant") {
			for (const part of message.parts) {
				if (part.type !== "tool-call" || part.name !== "send_to_user") continue;
				const args = part.arguments as { message?: unknown; channel?: unknown } | null;
				if (typeof args?.message === "string" && args.message.trim() !== "" && args.channel !== "email") turns.push(`${host}: ${args.message.trim()}`);
			}
		}
	}
	if (except !== undefined && turns.at(-1) === `${host}: ${except.trim()}`) turns.pop();
	const text = turns.join("\n\n");
	return text.length > limit ? `…${text.slice(text.length - limit)}` : text;
}

/** What a room is to Pim's extensions. */
export type RoomsHost = {
	readonly rooms: RoomStore;
	/** The agent a conversation talks as, if it is a chat or a seat in a room; null for a task's, a review's or a visit's. */
	speaker(conversation: string): Agent | null;
	agent(id: string): Agent | undefined;
	/** The agents a conversation can bring into its chat by mentioning them. */
	invitable(conversation: string): Agent[];
};

const ROOMS_EXTENSION = "pim.rooms";

/** What an agent in a chat knows about bringing others in, and, once the chat is a room, who is in it and when to speak. */
export function roomSection(self: Agent, seats: readonly { agent: Agent; host: boolean }[], mode: RoomMode, invitable: readonly Agent[]): string | undefined {
	const bring =
		invitable.length === 0
			? []
			: [
					`To bring another of the person's agents into this chat, mention it in a message you send, as @Name: it joins, reads what was said so far, and answers here, where the person talks with it too. Bring one in when the person should talk with it directly; hand it a task with \`${DELEGATE}\` when it can work out of sight and report back. You can bring in: ${invitable.map((agent) => `@${agent.name}`).join(", ")}.`,
				];
	if (seats.length < 2) return bring.length === 0 ? undefined : bring.join("\n");
	const host = seats.find((seat) => seat.host)?.agent;
	const imHost = host?.id === self.id;
	return [
		"This chat is a group chat: the person, and these agents of theirs, each with its own instructions, apps and memory:",
		...seats.map(
			({ agent, host }) =>
				`- @${agent.name}${agent.role.toLowerCase() === agent.name.toLowerCase() ? "" : ` (${agent.role})`}${agent.id === self.id ? " (you)" : ""}${host ? " (the chat's host)" : ""}${agent.description ? `: ${agent.description}` : ""}`,
		),
		`Everyone in the chat reads what you send with \`send_to_user\`. What the other agents send comes to you in messages starting "[From Name]"; Pim's notes about the chat start "${ROOM_NOTICE}"; every other message is the person's. Speak to someone by mentioning them as @Name.`,
		mode === "open"
			? "Everything said here comes to you, and you decide whether to answer. Answer when you are mentioned, or when you have something to add that is yours to say: what your instructions, apps or memory give you that the others' don't. Otherwise end your turn without sending anything; staying quiet is often right. Don't repeat what others said, agree with them or thank them."
			: `You answer when you are mentioned${imHost ? ", and when the person says something without mentioning anyone" : ""}. Everything else said here comes to you without needing an answer, so you know it when you next speak: end your turn without sending anything then.`,
		"Answer the agents here, in the chat, rather than handing them tasks, unless the work should go on out of the person's sight.",
		...bring,
	].join("\n");
}

export function roomsExtension(host: RoomsHost) {
	return defineExtension({
		name: ROOMS_EXTENSION,
		sections: [
			section("chat_room", ({ conversationId }) => {
				const conversation = String(conversationId);
				const self = host.speaker(conversation);
				if (!self) return undefined;
				const room = host.rooms.of(conversation)?.room;
				const seats = room
					? host.rooms.seats(room).flatMap((seat) => {
							const agent = host.agent(seat.agent);
							return agent ? [{ agent, host: seat.conversation === room }] : [];
						})
					: [];
				return roomSection(self, seats, room ? host.rooms.mode(room) : "mentions", host.invitable(conversation));
			}),
		],
	});
}
