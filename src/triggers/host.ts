/**
 * The coordinator's host in Pim (`TriggerAgentHost`, ./coordinator.ts): it
 * makes a trigger's chats and submits its firings through the same
 * machinery as everything else that starts a run, `submitTo` from `pim`, so
 * a firing counts once against the run limit, is refused while the space is
 * suspended, and every action of its run still goes through approvals. The
 * trigger's instruction grants nothing.
 *
 * Every effect is keyed by the operation, and the key is recorded before the
 * effect, in this database, so a lookup can always say what happened:
 *
 * - A new chat is made in one pi commit with a document naming its
 *   operation (`TriggerChatDoc`), and its id is recorded here as pi stages
 *   that commit, before it is written. A recorded chat counts only once its
 *   document names the operation, so a chat pi never wrote, or an id pi gave
 *   another chat after a crash, is never taken for it.
 * - A submission goes in under one key for its operation, which `submitTo`
 *   tells this host before it submits (`StableOperation`), and every retry
 *   uses that key exactly. A finished task's chat is woken under `wake:` and
 *   its key keeps that form, whatever the task's state on a retry.
 * - What became of a submission and its run is read from pi's own record of
 *   the key (`submissionByRequest`), never assumed: no record is "not
 *   known", not an answer either way.
 *
 * Questions about an operation while this instance is still making its chat
 * or submitting it are answered "not known", so a coordinator that stopped
 * waiting never makes a second chat or a second run.
 */

import type { ConversationInit } from "@earendil-works/pi-durable";
import { defineDoc } from "@earendil-works/pi-durable";
import type { PiReceipt } from "agents/harness/pi";
import { HttpError } from "../http";
import type { StableOperation } from "../pim";
import type { ChatCreation, ChatLookup, HostPreflight, RunStatus, SubmissionLookup, SubmitResult, TimeEvidence, TriggerAgentHost } from "./coordinator";
import type { TriggerDestination } from "./spec";

/** In the commit that makes a trigger's chat: the operation it was made for. A fork starts without it. */
export const TriggerChatDoc = defineDoc<{ operationId: string }>({
	kind: "pim.trigger_chat",
	version: 1,
	scope: "conversation",
	history: "latest",
	fork: "initial",
	initial: () => ({ operationId: "" }),
});

const SCHEMA = `
CREATE TABLE IF NOT EXISTS pim_trigger_host_operations (
	operation_id TEXT PRIMARY KEY,
	agent_id TEXT NOT NULL,
	title TEXT,
	chat_id TEXT,
	chat_made INTEGER NOT NULL DEFAULT 0,
	chat_ready INTEGER NOT NULL DEFAULT 0,
	submission_chat TEXT,
	submission_key TEXT UNIQUE,
	keyed_at INTEGER,
	receipt TEXT,
	accepted_at INTEGER,
	created_at INTEGER NOT NULL,
	updated_at INTEGER NOT NULL
);
CREATE TRIGGER IF NOT EXISTS pim_trigger_host_key_pinned BEFORE UPDATE OF submission_key, submission_chat ON pim_trigger_host_operations
WHEN OLD.submission_key IS NOT NULL AND (NEW.submission_key IS NOT OLD.submission_key OR NEW.submission_chat IS NOT OLD.submission_chat)
BEGIN SELECT RAISE(ABORT, 'an operation keeps the key it was submitted under'); END;
CREATE TRIGGER IF NOT EXISTS pim_trigger_host_chat_pinned BEFORE UPDATE OF chat_id ON pim_trigger_host_operations
WHEN OLD.chat_ready = 1 AND NEW.chat_id IS NOT OLD.chat_id
BEGIN SELECT RAISE(ABORT, 'an operation keeps the chat made for it'); END;
`;

/** The host's table, beside the store's and the coordinator's, for erasing a space. */
export const HOST_TABLES = ["pim_trigger_host_operations"] as const;

/** What the host needs of the space, which `Pim` gives it. */
export interface TriggerSpace {
	/** `closed` once the space is erased or being erased. */
	state(): "active" | "suspended" | "closed";
	agentExists(agentId: string): boolean;
	/** The agent a chat is with, as Pim says (`AgentStore.ofSession`): a chat whose agent was deleted is the majordomo's, so it never matches the deleted agent. */
	chatAgent(chatId: string): string;
	/** Whether the chat is one of the space's own, there and not deleted. */
	chatOpen(chatId: string): Promise<boolean>;
	/** Makes a chat with the agent, within the person's limit on chats; `init` runs in the commit that makes it. */
	startChat(agentId: string, title: string, init: ConversationInit): Promise<string>;
	/** Ties a chat made by `startChat` to its agent and title, again, for a chat whose making was cut short after pi wrote it. */
	adoptChat(chatId: string, agentId: string, title: string): Promise<void>;
	/** The operation a chat's `TriggerChatDoc` names; null when there is no such chat, or it names none. */
	chatOrigin(chatId: string): Promise<string | null>;
	/** `submitTo(chatId, content, { operationId, stable }, "pim")`. */
	submit(chatId: string, content: string, operation: { operationId: string; stable: StableOperation }): Promise<PiReceipt>;
	/** pi's record of the input submitted to a chat under `key`, if there is one. */
	submission(chatId: string, key: string): Promise<{ status: "queued" | "placed" | "done" | "unanswered"; reason?: string } | undefined>;
	/** Whether an approval filed in the chat since `since` is waiting for its decision. */
	approvalPending(chatId: string, since: number): boolean;
}

type Row = {
	operationId: string;
	agentId: string;
	title: string | null;
	chatId: string | null;
	chatMade: boolean;
	chatReady: boolean;
	submissionChat: string | null;
	submissionKey: string | null;
	keyedAt: number | null;
	receipt: string | null;
	acceptedAt: number | null;
};

/** One record of what the host did for an operation, as tests and the export read it. */
export type HostOperation = Row;

/** Questions to the host while it is making the operation's chat or submitting it here: their answers aren't known yet. */
const BUSY = "another handoff of this operation is under way here";

export class PimTriggerHost implements TriggerAgentHost {
	readonly #sql: SqlStorage;
	readonly #space: TriggerSpace;
	readonly #now: () => number;
	readonly #busy = new Map<string, Promise<unknown>>();

	/** `now` is the space's own clock, which approvals are stamped with. */
	constructor(sql: SqlStorage, space: TriggerSpace, now: () => number = Date.now) {
		this.#sql = sql;
		this.#space = space;
		this.#now = now;
		this.#sql.exec(SCHEMA);
	}

	operation(operationId: string): HostOperation | undefined {
		const row = this.#sql.exec("SELECT * FROM pim_trigger_host_operations WHERE operation_id = ?", operationId).toArray()[0];
		if (!row) return undefined;
		const text = (value: SqlStorageValue | undefined) => (value === null || value === undefined ? null : String(value));
		const number = (value: SqlStorageValue | undefined) => (value === null || value === undefined ? null : Number(value));
		return {
			operationId: String(row.operation_id),
			agentId: String(row.agent_id),
			title: text(row.title),
			chatId: text(row.chat_id),
			chatMade: Number(row.chat_made) === 1,
			chatReady: Number(row.chat_ready) === 1,
			submissionChat: text(row.submission_chat),
			submissionKey: text(row.submission_key),
			keyedAt: number(row.keyed_at),
			receipt: text(row.receipt),
			acceptedAt: number(row.accepted_at),
		};
	}

	/** Erases every record, with the store's and the coordinator's, for erasing the space. */
	eraseAll(): void {
		for (const table of HOST_TABLES) this.#sql.exec(`DELETE FROM ${table}`);
	}

	async preflight(input: { triggerId: string; operationId: string; agentId: string; destination: TriggerDestination; sourceKind: "time" }): Promise<HostPreflight> {
		const state = this.#space.state();
		if (state === "closed") return { ok: false, reason: "the space was erased", retryable: false };
		if (state === "suspended") return { ok: false, reason: "the space is suspended", retryable: true };
		if (!this.#space.agentExists(input.agentId)) return { ok: false, reason: "the trigger's agent was deleted", retryable: false };
		if (input.destination.type === "existing_chat") {
			const refusal = await this.#chatRefusal(input.destination.chatId, input.agentId);
			if (refusal) return { ok: false, reason: refusal, retryable: false };
		}
		return { ok: true };
	}

	async findChat(input: { operationId: string }): Promise<ChatLookup> {
		if (this.#busy.has(input.operationId)) return { status: "unknown" };
		try {
			const chatId = await this.#madeChat(input.operationId);
			return chatId === null ? { status: "absent" } : { status: "found", chatId };
		} catch {
			return { status: "unknown" };
		}
	}

	createChat(input: { operationId: string; agentId: string; title: string }): Promise<ChatCreation> {
		return this.#exclusive(input.operationId, async () => {
			const made = await this.#madeChat(input.operationId);
			if (made !== null) return { status: "created", chatId: made };
			if (this.#space.state() === "closed") return { status: "denied", reason: "the space was erased" };
			// Suspended, it may yet be made: not known either way until it is asked again.
			if (this.#space.state() === "suspended") throw new Error("the space is suspended");
			if (!this.#space.agentExists(input.agentId)) return { status: "denied", reason: "the trigger's agent was deleted" };
			const now = this.#now();
			// The operation is recorded before the chat is asked for, and the chat's id as pi stages the commit that writes it.
			this.#sql.exec(
				"INSERT INTO pim_trigger_host_operations (operation_id, agent_id, title, chat_made, created_at, updated_at) VALUES (?, ?, ?, 1, ?, ?) ON CONFLICT (operation_id) DO UPDATE SET title = excluded.title, chat_made = 1, updated_at = excluded.updated_at",
				input.operationId,
				input.agentId,
				input.title,
				now,
				now,
			);
			let chatId: string;
			try {
				chatId = await this.#space.startChat(input.agentId, input.title, async (tx, conversationId) => {
					this.#sql.exec("UPDATE pim_trigger_host_operations SET chat_id = ?, updated_at = ? WHERE operation_id = ?", String(conversationId), this.#now(), input.operationId);
					const origin = await tx.doc(TriggerChatDoc, conversationId);
					origin.operationId = input.operationId;
				});
			} catch (error) {
				// The person's limit on chats refuses before anything is made.
				if (error instanceof HttpError && error.status === 429) return { status: "denied", reason: error.message };
				throw error;
			}
			this.#sql.exec("UPDATE pim_trigger_host_operations SET chat_id = ?, chat_ready = 1, updated_at = ? WHERE operation_id = ?", chatId, this.#now(), input.operationId);
			return { status: "created", chatId };
		});
	}

	async lookupSubmission(input: { operationId: string }): Promise<SubmissionLookup> {
		if (this.#busy.has(input.operationId)) return { status: "unknown" };
		const row = this.operation(input.operationId);
		// The key is recorded before anything is submitted under it: with none, nothing was.
		if (!row?.submissionKey || !row.submissionChat) return { status: "absent" };
		try {
			const record = await this.#space.submission(row.submissionChat, row.submissionKey);
			if (!record) return { status: "absent" };
			return { status: "accepted", receipt: await this.#accept(row) };
		} catch {
			return { status: "unknown" };
		}
	}

	async submit(input: { idempotencyKey: string; chatId: string; agentId: string; instruction: string; evidence: TimeEvidence }): Promise<SubmitResult> {
		const operationId = input.idempotencyKey;
		if (this.#busy.has(operationId)) return { status: "uncertain", reason: BUSY };
		return this.#exclusive(operationId, async (): Promise<SubmitResult> => {
			let row = this.operation(operationId);
			if (row?.submissionKey && row.submissionChat) {
				// Submitted before under its key: looked up, and never submitted under another.
				const record = await this.#space.submission(row.submissionChat, row.submissionKey).catch(() => null);
				if (record === null) return { status: "uncertain", reason: "pi's record of the submission couldn't be read" };
				if (record) return { status: "duplicate", receipt: await this.#accept(row) };
				if (row.submissionChat !== input.chatId) return { status: "failed", reason: "the operation was keyed for another chat" };
			}
			const state = this.#space.state();
			if (state === "closed") return { status: "failed", reason: "the space was erased" };
			if (state === "suspended") return { status: "suspended", reason: "the space is suspended" };
			if (!this.#space.agentExists(input.agentId)) return { status: "failed", reason: "the trigger's agent was deleted" };
			const refusal = await this.#chatRefusal(input.chatId, input.agentId);
			if (refusal) return { status: "failed", reason: refusal };
			const now = this.#now();
			this.#sql.exec(
				"INSERT OR IGNORE INTO pim_trigger_host_operations (operation_id, agent_id, created_at, updated_at) VALUES (?, ?, ?, ?)",
				operationId,
				input.agentId,
				now,
				now,
			);
			row = this.operation(operationId)!;
			let kept = false;
			const stable: StableOperation = {
				exact: row.submissionKey !== null,
				keep: (key) => {
					kept = true;
					this.#sql.exec(
						"UPDATE pim_trigger_host_operations SET submission_key = ?, submission_chat = ?, keyed_at = COALESCE(keyed_at, ?), updated_at = ? WHERE operation_id = ? AND submission_key IS NULL",
						key,
						input.chatId,
						this.#now(),
						this.#now(),
						operationId,
					);
				},
			};
			let receipt: PiReceipt;
			try {
				receipt = await this.#space.submit(input.chatId, firingText(input.instruction, input.evidence), { operationId: row.submissionKey ?? operationId, stable });
			} catch (error) {
				// Once its key was recorded, a failure may have come after pi took it.
				if (kept || !(error instanceof HttpError)) return { status: "uncertain", reason: errorText(error) };
				if (error.status === 429) return { status: "budget_blocked", reason: error.message };
				if (error.status === 403) return { status: "suspended", reason: error.message };
				if (error.status === 410) return { status: "failed", reason: error.message };
				return { status: "uncertain", reason: error.message };
			}
			const keyed = this.operation(operationId)!;
			if (keyed.submissionKey !== receipt.operationId) return { status: "uncertain", reason: "pi took the input under another key than the one recorded" };
			return { status: receipt.accepted ? "accepted" : "duplicate", receipt: await this.#accept(keyed) };
		});
	}

	async lookupRun(input: { operationId: string; receipt: string }): Promise<RunStatus> {
		const row = this.operation(input.operationId);
		if (!row?.submissionKey || !row.submissionChat || row.receipt !== input.receipt) return "unknown";
		try {
			const record = await this.#space.submission(row.submissionChat, row.submissionKey);
			switch (record?.status) {
				case "queued":
					return "queued";
				case "placed":
					return this.#space.approvalPending(row.submissionChat, row.keyedAt ?? 0) ? "waiting_approval" : "running";
				case "done":
					return "completed";
				case "unanswered":
					return record.reason === "aborted" ? "cancelled" : "failed";
				default:
					return "unknown";
			}
		} catch {
			return "unknown";
		}
	}

	/** Why the run can't go to an existing chat with this agent, or null when it can: never another agent's chat. */
	async #chatRefusal(chatId: string, agentId: string): Promise<string | null> {
		if (!(await this.#space.chatOpen(chatId))) return "the trigger's chat was deleted";
		if (this.#space.chatAgent(chatId) !== agentId) return "the trigger's chat is no longer with its agent";
		return null;
	}

	/**
	 * The chat made for an operation, if pi wrote one: the recorded chat,
	 * once its document names the operation. A recorded id pi never wrote, or
	 * gave to another chat since, is forgotten.
	 */
	async #madeChat(operationId: string): Promise<string | null> {
		const row = this.operation(operationId);
		if (!row?.chatMade || row.chatId === null) return null;
		if (row.chatReady) return row.chatId;
		if ((await this.#space.chatOrigin(row.chatId)) !== operationId) {
			this.#sql.exec("UPDATE pim_trigger_host_operations SET chat_id = NULL, updated_at = ? WHERE operation_id = ? AND chat_id = ? AND chat_ready = 0", this.#now(), operationId, row.chatId);
			return null;
		}
		// Made, but cut short before it was tied to its agent.
		await this.#space.adoptChat(row.chatId, row.agentId, row.title ?? "Trigger");
		this.#sql.exec("UPDATE pim_trigger_host_operations SET chat_ready = 1, updated_at = ? WHERE operation_id = ?", this.#now(), operationId);
		return row.chatId;
	}

	/** The operation's receipt, recorded with when it was first known accepted: fixed for its chat and key, whatever answer gave it. */
	async #accept(row: Row): Promise<string> {
		const receipt = row.receipt ?? (await receiptOf(row.submissionChat!, row.submissionKey!));
		this.#sql.exec(
			"UPDATE pim_trigger_host_operations SET receipt = ?, accepted_at = COALESCE(accepted_at, ?), updated_at = ? WHERE operation_id = ?",
			receipt,
			this.#now(),
			this.#now(),
			row.operationId,
		);
		return receipt;
	}

	/** Runs `work` as the only handoff of the operation in this instance; questions meanwhile are answered "not known". */
	async #exclusive<T>(operationId: string, work: () => Promise<T>): Promise<T> {
		const running = this.#busy.get(operationId);
		if (running) return running as Promise<T>;
		const promise = work().finally(() => this.#busy.delete(operationId));
		this.#busy.set(operationId, promise);
		return promise;
	}
}

/** An opaque receipt of a fixed length, the same for every answer about one submission: a digest of its chat and key. */
async function receiptOf(chatId: string, key: string): Promise<string> {
	const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(`${chatId}\n${key}`)));
	return `pim-trigger:${btoa(String.fromCharCode(...digest)).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "")}`;
}

/** What the agent reads when a time trigger fires: its instruction, and only when it was due. */
export function firingText(instruction: string, evidence: TimeEvidence): string {
	const missed = evidence.older && evidence.older.count > 0 ? ` ${evidence.older.count} earlier ${evidence.older.count === 1 ? "firing" : "firings"} were missed and won't run.` : "";
	const zone = evidence.schedule.schedule === "cron" ? ` (${evidence.schedule.timeZone})` : "";
	return `[Trigger "${evidence.label}" ${evidence.triggerId}] ${instruction}\n\n(Due at ${new Date(evidence.scheduledFor).toISOString()}${zone}.${missed})`;
}

function errorText(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}
