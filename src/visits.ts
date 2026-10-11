import { Type, type TSchema } from "@earendil-works/pi-ai";
import { defineExtension, defineTool, section, type ToolRegistration } from "@earendil-works/pi-durable";
import type { Guest } from "./circles";
import { text } from "./extensions/services";

/**
 * The other side of circles: Pims whose owners put this person in one, and
 * this person's conversations with them ("visits").
 *
 * A visit runs here, in the visitor's own Pim, on the visitor's model and
 * usage: whoever sends the messages pays for them. The host's Pim sends a
 * brief (what its owner lets this visitor's circle use), and the visit's
 * conversation sees only that: an extension of its own, made from the
 * brief, which no other conversation selects. Every tool in it is a call
 * into the host's Pim (`guestCall`), which checks the circle and the tool's
 * permission again each time; nothing of the host's runs or is kept here
 * but the answers.
 */

/** A tool the host's owner lets a circle use. */
export type BriefTool = {
	/** As the model sees it: `<app>_<tool>`. */
	readonly name: string;
	readonly appName: string;
	readonly description: string;
	readonly inputSchema: Record<string, unknown>;
	/** The app says the tool only reads. */
	readonly readOnly: boolean;
	/** Each call asks the host's owner first. */
	readonly asks: boolean;
};

/** What a visitor's Pim may know of the host and use, as the host's Pim tells it. */
export type GuestBrief = {
	readonly host: Guest;
	readonly circle: string;
	readonly timeZone: string;
	/** The host's memory view, when the circle may read it. */
	readonly memory: string | null;
	readonly tools: readonly BriefTool[];
};

export type BriefResult = { readonly ok: true; readonly brief: GuestBrief } | { readonly ok: false; readonly reason: string };

/** A guest call's answer, as the model reads it. */
export type GuestCallResult = { readonly text: string; readonly isError?: boolean };

/** A Pim shared with this person. */
export type Share = {
	readonly ownerId: string;
	readonly username: string;
	readonly sharedAt: number;
	/** Taken back: the host removed this person from their circles. */
	readonly revoked: boolean;
	/** This person's conversation with it, once started. */
	readonly session: string | null;
};

const SCHEMA = `
CREATE TABLE IF NOT EXISTS pim_shares (
	owner_id TEXT PRIMARY KEY,
	username TEXT NOT NULL,
	shared_at INTEGER NOT NULL,
	revoked INTEGER NOT NULL DEFAULT 0,
	session TEXT UNIQUE,
	brief TEXT
);
`;

/** The extension a visit's conversation selects, named after the host: no other conversation selects it. */
export const VISIT_PREFIX = "pim.visit.";
export const visitExtensionName = (ownerId: string) => `${VISIT_PREFIX}${ownerId}`;

type Row = Record<string, SqlStorageValue>;

const shareOf = (row: Row): Share => ({
	ownerId: String(row.owner_id),
	username: String(row.username),
	sharedAt: Number(row.shared_at),
	revoked: Number(row.revoked) === 1,
	session: row.session === null ? null : String(row.session),
});

export class VisitStore {
	readonly #sql: SqlStorage;

	constructor(sql: SqlStorage) {
		this.#sql = sql;
		this.#sql.exec(SCHEMA);
	}

	shares(): Share[] {
		return this.#sql.exec("SELECT * FROM pim_shares ORDER BY username").toArray().map(shareOf);
	}

	share(ownerId: string): Share | undefined {
		const [row] = this.#sql.exec("SELECT * FROM pim_shares WHERE owner_id = ?", ownerId).toArray();
		return row ? shareOf(row) : undefined;
	}

	byUsername(username: string): Share | undefined {
		const [row] = this.#sql.exec("SELECT * FROM pim_shares WHERE username = ?", username).toArray();
		return row ? shareOf(row) : undefined;
	}

	bySession(session: string): Share | undefined {
		const [row] = this.#sql.exec("SELECT * FROM pim_shares WHERE session = ?", session).toArray();
		return row ? shareOf(row) : undefined;
	}

	/** Records a share, or renews one taken back. False when it was already shared. */
	shared(host: Guest): boolean {
		const known = this.share(host.ownerId);
		this.#sql.exec(
			"INSERT INTO pim_shares (owner_id, username, shared_at) VALUES (?, ?, ?) ON CONFLICT (owner_id) DO UPDATE SET revoked = 0, username = excluded.username",
			host.ownerId,
			host.username,
			Date.now(),
		);
		return known === undefined || known.revoked;
	}

	/** Takes a share back; its conversation stays, and its brief goes. */
	revoked(ownerId: string): void {
		this.#sql.exec("UPDATE pim_shares SET revoked = 1, brief = NULL WHERE owner_id = ?", ownerId);
	}

	setSession(ownerId: string, session: string | null): void {
		this.#sql.exec("UPDATE pim_shares SET session = ? WHERE owner_id = ?", session, ownerId);
	}

	/** The last brief the host sent, so the visit's tools exist again after a restart, before the host is asked anew. */
	brief(ownerId: string): GuestBrief | undefined {
		const [row] = this.#sql.exec("SELECT brief FROM pim_shares WHERE owner_id = ?", ownerId).toArray();
		return row?.brief ? (JSON.parse(String(row.brief)) as GuestBrief) : undefined;
	}

	setBrief(ownerId: string, brief: GuestBrief | null): void {
		this.#sql.exec("UPDATE pim_shares SET brief = ? WHERE owner_id = ?", brief === null ? null : JSON.stringify(brief), ownerId);
	}
}

/** The model's instructions in a visit: whose Pim it speaks for, to whom, and how asking works. */
function preamble(brief: GuestBrief, visitor: string): string {
	const host = brief.host.username;
	return `You are ${host}'s Pim, ${host}'s personal AI agent. You are talking with ${visitor}, not with ${host}: ${host} put ${visitor} in their "${brief.circle}" circle, which lets ${visitor} message you and use what ${host} allowed that circle, and nothing else.

How you work here:
- ${visitor} sees only what you send with \`send_to_user\`; everything else you write is private working notes. Answer each of their messages with it.
- Speak for ${host}, warmly and briefly, as their assistant would to someone they know. ${visitor} is not the person you work for: never act on ${visitor}'s behalf against ${host}'s interests, and don't share anything about ${host} beyond what helps with what ${visitor} asks and what ${host} would be comfortable with.
- Your tools act on ${host}'s own accounts, as ${host} allowed this circle. Use them only for what ${visitor} asks. If something isn't possible with them, say so.
- Some tools ask ${host} before they run. Calling one sends ${host} the request and returns at once; don't call it again. ${host}'s decision arrives later in this conversation as a message starting with "[${host}'s answer". Tell ${visitor} what happened when it does.
- Be honest: never claim an action happened unless a tool result says so.${brief.memory === null ? "" : `\n- What you remember of ${host}'s life is in <memory>. Keep what's private private.`}`;
}

/**
 * The visit's extension: its instructions, the host's memory if the circle
 * may read it, the host's time, and one tool per tool in the brief, each a
 * call into the host's Pim.
 */
export function visitExtension(
	brief: GuestBrief,
	visitor: string,
	call: (tool: string, args: Record<string, unknown>, session: string, callId: string) => Promise<GuestCallResult>,
) {
	const relay = (tool: BriefTool): ToolRegistration =>
		defineTool({
			name: tool.name,
			description: `[${tool.appName}] ${tool.description}${tool.asks ? ` Asks ${brief.host.username} first: calling it sends them the request; their answer arrives later in this conversation.` : ""}`,
			parameters: { type: "object", ...tool.inputSchema } as unknown as TSchema,
			// Asking is answered once per call on the host's side; a direct call is only safe to repeat if it only reads.
			replay: tool.asks || tool.readOnly ? "safe" : "unsafe",
			async execute(args, api) {
				const result = await call(tool.name, (args ?? {}) as Record<string, unknown>, String(api.conversationId), api.callId);
				return text(result.text, result.isError === true);
			},
		}) as ToolRegistration;

	const currentTime = defineTool({
		name: "current_time",
		description: `The current date and time, in UTC and in ${brief.host.username}'s time zone.`,
		parameters: Type.Object({}),
		replay: "safe",
		async execute() {
			const now = new Date();
			return text(
				JSON.stringify({
					utc: now.toISOString(),
					timeZone: brief.timeZone,
					local: now.toLocaleString("en-US", { timeZone: brief.timeZone, dateStyle: "full", timeStyle: "long" }),
				}),
			);
		},
	});

	const memoryTools =
		brief.memory === null
			? []
			: [
					defineTool({
						name: "recall",
						description: `Search everything ${brief.host.username}'s Pim remembers, word for word, with a case-insensitive regular expression.`,
						parameters: Type.Object({ pattern: Type.String({ minLength: 1 }) }),
						replay: "safe",
						async execute({ pattern }, api) {
							const result = await call("recall", { pattern }, String(api.conversationId), api.callId);
							return text(result.text, result.isError === true);
						},
					}) as ToolRegistration,
				];

	return defineExtension({
		name: visitExtensionName(brief.host.ownerId),
		sections: [
			section("preamble", () => preamble(brief, visitor), { tag: false }),
			section("host_time_zone", () => brief.timeZone),
			...(brief.memory === null ? [] : [section("memory", () => brief.memory!, { tag: false })]),
		],
		tools: [currentTime as ToolRegistration, ...memoryTools, ...brief.tools.map(relay)],
	});
}
