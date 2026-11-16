import { createHash } from "node:crypto";
import { z } from "zod";
import type { CommandSubmission } from "./runtime-seam.ts";

/**
 * A coding thread's id from its owner and the start's operation, so starting again with the same operation
 * reaches the same thread and no other owner's. It matches the legacy `codingThreadId` in `src/coding/threads.ts`.
 */
export function codingThreadId(ownerId: string, operationId: string): string {
	const hex = createHash("sha256").update(`pim coding thread\n${ownerId}\n${operationId}`).digest("hex");
	return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20, 32)}`;
}

export const HARNESS_IDS = ["pi", "claude-code", "codex", "mistral-vibe", "amp"] as const;
export type HarnessId = (typeof HARNESS_IDS)[number];

export type ExecutionClass = "sandbox-pi" | "sandbox-cli" | "remote-orb";

export interface HarnessCapabilityDescriptor {
	readonly id: HarnessId;
	readonly executionClass: ExecutionClass;
	readonly supportsResume: boolean;
	readonly supportsCostReporting: boolean;
	readonly supportsCheckpoints: boolean;
	/** Whether a turn needs a slot in a workspace pool; a remote orb does not. */
	readonly requiresWorkspacePool: boolean;
}

/** The five harnesses by what the audit found (B5 §0); a harness's own workstream may narrow a flag it cannot honour. */
export const HARNESS_CAPABILITIES: Readonly<Record<HarnessId, HarnessCapabilityDescriptor>> = {
	pi: { id: "pi", executionClass: "sandbox-pi", supportsResume: true, supportsCostReporting: true, supportsCheckpoints: true, requiresWorkspacePool: true },
	"claude-code": { id: "claude-code", executionClass: "sandbox-cli", supportsResume: true, supportsCostReporting: false, supportsCheckpoints: false, requiresWorkspacePool: true },
	codex: { id: "codex", executionClass: "sandbox-cli", supportsResume: true, supportsCostReporting: false, supportsCheckpoints: false, requiresWorkspacePool: true },
	"mistral-vibe": { id: "mistral-vibe", executionClass: "sandbox-cli", supportsResume: true, supportsCostReporting: false, supportsCheckpoints: false, requiresWorkspacePool: true },
	amp: { id: "amp", executionClass: "remote-orb", supportsResume: true, supportsCostReporting: false, supportsCheckpoints: false, requiresWorkspacePool: false },
};

/** A thread finished a turn: delivered to the normal agent that started it. `wakeId` is `coding:<threadId>:<operationId>`. */
export const ForgeCompletionWake = z.object({
	wakeId: z.string().regex(/^coding:[^:]+:[^:]+$/),
	threadId: z.string(),
	operationId: z.string(),
	outcome: z.enum(["completed", "failed", "cancelled"]),
	summary: z.string().optional(),
});
export type ForgeCompletionWake = z.infer<typeof ForgeCompletionWake>;

/** A thread has made no progress: `wakeId` is `stall:<source>:<stage>:<progress>`, so the same stall wakes the agent once. */
export const ForgeStallWake = z.object({
	wakeId: z.string().regex(/^stall:[^:]+:[^:]+:[^:]+$/),
	threadId: z.string(),
	source: z.string(),
	stage: z.string(),
	progress: z.string(),
});
export type ForgeStallWake = z.infer<typeof ForgeStallWake>;

export const completionWakeId = (threadId: string, operationId: string) => `coding:${threadId}:${operationId}`;
export const stallWakeId = (source: string, stage: string, progress: string | number) => `stall:${source}:${stage}:${progress}`;

/** A wake enters the normal agent's inbox as a `coding_wake` command, whose `commandId` is the wake's id. */
export type ForgeWakeCommand = CommandSubmission & { readonly kind: "coding_wake" };
