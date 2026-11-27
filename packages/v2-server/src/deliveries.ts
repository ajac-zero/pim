/**
 * Forge's cost rows become the application's cost ledger: `run_kind = 'coding_thread'`, once per row (the ledger is idempotent on the call id). A row is kept under the chat that started the thread,
 * so the chat's cost counts its coding threads' spend; `provider` is the harness that spent it.
 */
import type { Usage } from "@pim/v2-app/usage";
import type { Queryable } from "@pim/v2-forge/db";
import type { Forge } from "@pim/v2-forge/forge";
import { OwnerId, PublicChatId } from "@pim/v2-contracts/identity";

export async function deliverCosts(deps: { forge: Forge; forgeDb: Queryable; usage: Usage; onUnroutable?: (id: string, reason: string) => void }, limit = 100): Promise<number> {
	return deps.forge.deliverOutbox(
		async (row) => {
			const cost = row.payload as { threadId: string; costUsd: number; tokensIn?: number; tokensOut?: number; model?: string; cacheReadTokens?: number; cacheWriteTokens?: number };
			const thread = (await deps.forgeDb.query<{ owner_id: string; chat_id: string | null; harness: string | null }>("SELECT owner_id, chat_id, harness FROM pim_forge.forge_threads WHERE thread_id = $1", [cost.threadId])).rows[0];
			const owner = OwnerId.safeParse(thread?.owner_id);
			if (!owner.success) return deps.onUnroutable?.(row.dedupeKey, "the thread's owner is not a Pim owner");
			await deps.usage.record(owner.data, {
				id: `coding:${row.dedupeKey}`,
				runKind: "coding_thread",
				threadId: cost.threadId,
				...(PublicChatId.safeParse(thread?.chat_id).success ? { chatId: thread!.chat_id! } : {}),
				...(thread?.harness ? { provider: thread.harness } : {}),
				...(cost.model ? { model: cost.model } : {}),
				cacheReadTokens: Math.max(0, Math.round(cost.cacheReadTokens ?? 0)),
				cacheWriteTokens: Math.max(0, Math.round(cost.cacheWriteTokens ?? 0)),
				inputTokens: Math.max(0, Math.round(cost.tokensIn ?? 0)),
				outputTokens: Math.max(0, Math.round(cost.tokensOut ?? 0)),
				costMicroUsd: Math.max(0, Math.round(cost.costUsd * 1_000_000)),
			});
		},
		limit,
		["cost_ledger"],
	);
}
