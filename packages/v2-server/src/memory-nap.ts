/**
 * The memory nap: while nobody is in a chat, a Runner reads what was said in it since it last napped there and keeps what is worth remembering as a memory, on the memory model.
 * The same loop summarizes the memory into its tree (v1's optmem nap, `src/extensions/optmem`; see `./memory-tree.ts`).
 *
 * - Which chats: those quiet for `PIM_MEMORY_NAP_IDLE_SECONDS` (default 600) that moved since their last nap (`pim_app.nap_candidates`, migration 0647, the one read across
 *   owners). Chats made for tasks, triggers, reviews and visits, a room's seats, archived and deleted chats are not napped.
 * - What it writes: one memory per chat, `m_nap_<hash of the chat>`, rewritten each time the chat is napped again, in the scope of the chat's agent (`everyone` for the majordomo).
 *   The memory and the chat's `napped_at` are one transaction, so a nap that is repeated, or raced by another Runner, writes the same row and never a second memory.
 * - Which model: `complete` of the agent host (`PIM_MEMORY_MODEL`, else the utility model, else the chosen model). A chat whose model is unavailable or fails is tried again later, not
 *   marked; a chat with nothing worth keeping is marked and its memory, if it had one, forgotten.
 * - `PIM_MEMORY_NAP=off` leaves the nap and the tree's summaries out; `PIM_MEMORY_NAP_POLL_MS` (default 60000) is how often a Runner looks.
 */
import { createHash } from "node:crypto";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import type { App } from "@pim/v2-app/app";
import type { Db as RuntimeDb } from "@pim/v2-runtime/db";
import { PgPiStorage } from "@pim/v2-runtime/storage";
import type { Pool } from "pg";
import { compressPass } from "./memory-tree.ts";

const MAX_TEXT = 20_000;
const MIN_TEXT = 120;
const CHATS_PER_PASS = 5;
const RETRY_AFTER_MS = 10 * 60_000;

const SYSTEM = [
	"You keep a person's long-term memory for their AI assistant.",
	"You are given a conversation between the person and the assistant. Write down what is worth remembering about the person from it: who they are, what they prefer, what they decided, what they are working on and what is still open.",
	"Reply with a title of at most 8 words on the first line, then the memory itself in a few short lines of plain text, in the conversation's language.",
	"Use only what the conversation says. If nothing in it is worth remembering, reply with the single word NOTHING.",
].join(" ");

type Candidate = { owner_id: string; public_chat_id: string; title: string | null; agent_id: string | null; updated_at: Date };
type Piece = { type?: string; text?: string; name?: string; arguments?: { message?: unknown } };

/** What the person said and what their agent sent them, one turn after another (what the agent only thought, and tool calls other than `send_to_user`, are left out); a long chat keeps its latest part. */
export function chatText(entries: readonly { model?: readonly any[] | undefined }[]): string {
	const turns: string[] = [];
	for (const message of entries.flatMap((e) => e.model ?? [])) {
		if (message.role === "user") {
			const body = (typeof message.content === "string" ? message.content : (message.content as Piece[]).flatMap((c) => (c.type === "text" ? [c.text ?? ""] : [])).join("\n")).trim();
			const from = /^\[From ([^\]\n]+)\]\n?/.exec(body);
			if (body === "") continue;
			turns.push(from ? `${from[1]}: ${body.slice(from[0].length).trim()}` : body.startsWith("[") ? `Event: ${body}` : `Person: ${body}`);
		} else if (message.role === "assistant" && Array.isArray(message.content)) {
			for (const part of message.content as Piece[]) {
				const sent = part.type === "toolCall" && part.name === "send_to_user" ? part.arguments?.message : undefined;
				if (typeof sent === "string" && sent.trim() !== "") turns.push(`Assistant: ${sent.trim()}`);
			}
		}
	}
	const joined = turns.join("\n\n");
	return joined.length > MAX_TEXT ? `…${joined.slice(joined.length - MAX_TEXT)}` : joined;
}

export type NapOptions = {
	/** The runtime's pool, for the one read across owners. */
	pool: Pool;
	db: RuntimeDb;
	/** The application's services, which write the memory. */
	app: App;
	complete(ownerId: string, system: string, prompt: string, maxTokens?: number): Promise<string | undefined>;
	env: Record<string, string | undefined>;
	onError?: (error: unknown) => void;
};

/** The memory a chat's nap keeps, by its chat. */
export const napMemoryId = (chatId: string) => `m_nap_${createHash("sha256").update(chatId).digest("hex").slice(0, 20)}`;

/** Naps the chats due now; returns how many it wrote a memory for. */
export async function napPass(options: NapOptions, failed = new Map<string, number>(), now = Date.now()): Promise<number> {
	const { pool, db, app } = options;
	const idle = Number(options.env.PIM_MEMORY_NAP_IDLE_SECONDS ?? 600);
	const due = (await pool.query<Candidate>("SELECT * FROM pim_app.nap_candidates($1, $2)", [idle, CHATS_PER_PASS + failed.size])).rows.filter((c) => (failed.get(c.public_chat_id) ?? 0) <= now).slice(0, CHATS_PER_PASS);
	let written = 0;
	for (const chat of due) {
		try {
			const where = (await db.read<{ partition_id: string; conversation_id: string }>(chat.owner_id, "SELECT partition_id, conversation_id FROM pim_runtime.conversation_partitions WHERE owner_id = $1 AND public_chat_id = $2", [chat.owner_id, chat.public_chat_id])).rows[0];
			let text = "";
			if (where) {
				const page = await PgPiStorage.forReading(db, chat.owner_id, where.partition_id).scanEntries({ conversationId: Number(where.conversation_id) as never, order: "descending" }, 400, undefined, BACKGROUND_CONTEXT);
				text = chatText([...page.items].reverse());
			}
			let answer: string | undefined = "NOTHING";
			if (text.length >= MIN_TEXT) {
				answer = await options.complete(chat.owner_id, SYSTEM, `Chat: ${chat.title ?? "untitled"}\n\n${text}`);
				if (!answer) {
					failed.set(chat.public_chat_id, now + RETRY_AFTER_MS);
					continue;
				}
			}
			const [first = "", ...rest] = (answer ?? "").split(/\r?\n/);
			const keep = !/^NOTHING\b/i.test((answer ?? "").trim()) && first.trim() !== "";
			const id = napMemoryId(chat.public_chat_id);
			await app.db.owner(chat.owner_id, async (tx) => {
				// A chat's own agent keeps what it learned in the agent's own scope; a migrated majordomo's is `private`.
				const scope = await (async () => {
					// A chat with no agent is the majordomo's.
					const own = (await tx.query("SELECT id, config->>'memoryScope' AS scope FROM pim_app.agents WHERE deleted_at IS NULL AND id = coalesce($1, pim_app.majordomo_id())", [chat.agent_id])).rows[0];
					return own ? ((own.scope as string | null) ?? `agent-${own.id}`) : "everyone";
				})();
				if (keep) {
					await tx.query(
						"INSERT INTO pim_app.memories (id, owner_id, scope, title, body) VALUES ($1, $2, $3, $4, $5) ON CONFLICT (owner_id, id) DO UPDATE SET scope = $3, title = $4, body = $5, updated_at = now(), deleted_at = NULL",
						[id, chat.owner_id, scope, first.replace(/^[#*\s]+|[*\s]+$/g, "").slice(0, 120), rest.join("\n").trim() || first.trim()],
					);
				} else await tx.query("UPDATE pim_app.memories SET deleted_at = now() WHERE id = $1 AND deleted_at IS NULL", [id]);
				await tx.query(
					"INSERT INTO pim_app.chat_naps (owner_id, public_chat_id, napped_at, memory_id) VALUES ($1, $2, $3, $4) ON CONFLICT (owner_id, public_chat_id) DO UPDATE SET napped_at = $3, memory_id = $4",
					[chat.owner_id, chat.public_chat_id, chat.updated_at, keep ? id : null],
				);
			});
			failed.delete(chat.public_chat_id);
			if (keep) written++;
		} catch (error) {
			failed.set(chat.public_chat_id, now + RETRY_AFTER_MS);
			options.onError?.(error);
		}
	}
	return written;
}

/** Starts the nap loop of a Runner, which naps chats and then summarizes the memory they and the agents kept; the returned function stops it, after any pass in flight. */
export function startMemoryNap(options: NapOptions): () => Promise<void> {
	if (options.env.PIM_MEMORY_NAP === "off") return async () => {};
	const failed = new Map<string, number>();
	const failedOwners = new Map<string, number>();
	let active: Promise<unknown> | undefined;
	const timer = setInterval(() => {
		if (!active) {
			active = napPass(options, failed)
				.catch((error) => options.onError?.(error))
				.then(() => compressPass(options, failedOwners))
				.catch((error) => options.onError?.(error))
				.finally(() => (active = undefined));
		}
	}, Number(options.env.PIM_MEMORY_NAP_POLL_MS ?? 60_000));
	timer.unref();
	return async () => {
		clearInterval(timer);
		await active;
	};
}
