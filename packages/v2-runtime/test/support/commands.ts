import { randomUUID } from "node:crypto";
import { OwnerId, PartitionId, type PublicChatId } from "@pim/v2-contracts/identity";
import type { CommandKind } from "@pim/v2-contracts/runtime-seam";
import type { PartitionInbox } from "../../src/signals.ts";

/** A contract command for a conversation of a partition; `commandId` doubles as the idempotency key. */
export function command(
	inbox: PartitionInbox,
	ownerId: string,
	partitionId: string,
	commandId: string,
	conversationId: number,
	payload: Record<string, unknown>,
	kind: CommandKind = "user_message",
) {
	return inbox.enqueueCommand({
		commandId,
		ownerId: OwnerId.parse(ownerId),
		partitionId: PartitionId.parse(partitionId),
		conversationId,
		publicChatId: randomUUID() as PublicChatId,
		piRequestId: `pi:${commandId}`,
		kind,
		payload,
		submittedAt: new Date().toISOString(),
	});
}
