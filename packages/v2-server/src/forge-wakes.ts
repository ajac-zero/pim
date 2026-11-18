/**
 * Delivers Forge's wakes to the normal agent that started a thread: each `wake` row of Forge's outbox becomes a
 * `coding_wake` command in the inbox of the partition that holds the chat. The wake's id is the command's id, so a
 * delivery repeated after a crash, or a stall wake for the same spell, puts the input in front of the agent once.
 */
import { codingStallText, codingWakeText } from "@pim/shared/coding-wake";
import { OwnerId, PartitionId, PublicChatId } from "@pim/v2-contracts/identity";
import type { Db } from "@pim/v2-runtime/db";
import type { PartitionInbox } from "@pim/v2-runtime/signals";
import type { Forge } from "@pim/v2-forge/forge";
import type { Queryable } from "@pim/v2-forge/db";

export type WakeDeps = {
	forge: Forge;
	/** Forge's database, to find the thread's owner. */
	forgeDb: Queryable;
	/** The runtime's, to find the partition that holds the chat. */
	runtime: Db;
	inbox: PartitionInbox;
	/** A wake whose chat is gone or was never a Pim chat has nowhere to go; it is reported and dropped, not retried forever. */
	onUnroutable?: (wakeId: string, reason: string) => void;
	/** The deployment's public URL (PIM_PUBLIC_URL), for the link to the thread. */
	publicUrl?: string;
	now?: () => Date;
};

/** What the agent is told: v1's coding message, so the chat view draws its notice and the agent learns the thread's state and what to do next. */
async function wakeText(deps: WakeDeps, wake: Record<string, any>): Promise<string> {
	if (wake.kind === "stall") return codingStallText(wake.threadId, String(wake.stage ?? "1"), Array.isArray(wake.reasons) ? wake.reasons : []);
	const thread = (await deps.forgeDb.query<{ state: string; state_detail: string | null; spent_usd: string; budget_usd: string | null }>("SELECT state, state_detail, spent_usd, budget_usd FROM pim_forge.forge_threads WHERE thread_id = $1", [wake.threadId])).rows[0];
	const last = (await deps.forgeDb.query<{ data: { text?: string } }>("SELECT data FROM pim_forge.forge_events WHERE thread_id = $1 AND kind = 'message' AND role = 'assistant' AND coalesce(data ->> 'text', '') <> '' ORDER BY seq DESC LIMIT 1", [wake.threadId])).rows[0];
	return codingWakeText({
		threadId: wake.threadId,
		outcome: wake.outcome,
		state: thread?.state ?? (wake.outcome === "failed" ? "failed" : "idle"),
		spentUsd: Number(thread?.spent_usd ?? 0),
		budgetUsd: thread?.budget_usd == null ? null : Number(thread.budget_usd),
		origin: deps.publicUrl ?? null,
		detail: wake.summary ?? thread?.state_detail,
		said: last?.data.text,
	});
}

/** Hands every undelivered wake to its chat's partition; how many were handled. */
export async function deliverForgeWakes(deps: WakeDeps, limit = 100): Promise<number> {
	return deps.forge.deliverOutbox(
		async (row) => {
			const wake = row.payload as Record<string, any>;
			const unroutable = (reason: string) => deps.onUnroutable?.(String(wake.wakeId ?? row.dedupeKey), reason);
			const thread = (await deps.forgeDb.query<{ owner_id: string }>("SELECT owner_id FROM pim_forge.forge_threads WHERE thread_id = $1", [wake.threadId])).rows[0];
			const owner = OwnerId.safeParse(thread?.owner_id);
			const chat = PublicChatId.safeParse(wake.chatId);
			if (!owner.success || !chat.success) return unroutable("the thread's owner or chat is not a Pim one");
			const home = (await deps.runtime.read<{ partition_id: string; conversation_id: string }>(owner.data, "SELECT partition_id, conversation_id FROM pim_runtime.conversation_partitions WHERE owner_id = $1 AND public_chat_id = $2", [owner.data, chat.data])).rows[0];
			if (!home) return unroutable("no such chat");
			await deps.inbox.enqueueCommand({
				commandId: String(wake.wakeId),
				ownerId: owner.data,
				partitionId: PartitionId.parse(home.partition_id),
				conversationId: Number(home.conversation_id),
				publicChatId: chat.data,
				piRequestId: `pi:${wake.wakeId}`,
				kind: "coding_wake",
				payload: { content: await wakeText(deps, wake), whenBusy: "followUp", wake },
				submittedAt: (deps.now?.() ?? new Date()).toISOString(),
			});
		},
		limit,
		["wake"],
	);
}
