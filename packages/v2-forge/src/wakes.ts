// The wakes Forge sends to the normal agent that started a thread, in the contracts' envelopes (forge-seam.ts). Both ids are deduplicated by the outbox.
import { completionWakeId, ForgeCompletionWake, ForgeStallWake, stallWakeId } from "@pim/v2-contracts/forge-seam";

/** A wake id has no colons inside its parts, so an operation id that has one is made safe for the id only. */
const part = (s: string) => s.replace(/:/g, "_");

export function completionWake(threadId: string, operationId: string, outcome: "completed" | "failed" | "cancelled", summary?: string | null): ForgeCompletionWake {
	return ForgeCompletionWake.parse({ wakeId: completionWakeId(part(threadId), part(operationId)), threadId, operationId, outcome, ...(summary ? { summary: summary.slice(0, 500) } : {}) });
}

export function stallWake(threadId: string, stage: 1 | 2, progress: number): ForgeStallWake {
	return ForgeStallWake.parse({ wakeId: stallWakeId(part(threadId), String(stage), progress), threadId, source: threadId, stage: String(stage), progress: String(progress) });
}
