/** An approval as a turn's timeline reads it, by the call that filed it. */
export type CallApproval = { readonly id: string; readonly status: string; readonly createdAt: number; readonly decidedAt: number | null; readonly decidedBy: string | null };

/** One step of a turn: a model call, failed ones included, or a tool call, with how long it took; null while it goes on, or for a model call that didn't say. */
export type TurnStep =
	| { readonly kind: "model"; readonly at: number; readonly ms: number | null; readonly model: string; readonly stop: string; readonly error: string | null }
	| { readonly kind: "tool"; readonly id: string; readonly at: number; readonly ms: number | null; readonly name: string; readonly summary: string; readonly timeoutMs: number | null; readonly exitCode: number | null; readonly outputBytes: number | null; readonly error: boolean; readonly approval: (CallApproval & { readonly waitedMs: number }) | null };

/**
 * One turn of a chat, from what started it to its last step: how long its model
 * calls took, how long its tool calls ran apart from waiting for approvals, how
 * long those waits were, and its steps.
 */
export type Turn = {
	readonly startedAt: number;
	readonly endedAt: number;
	readonly inProgress: boolean;
	readonly modelMs: number;
	readonly toolsMs: number;
	readonly approvalsMs: number;
	readonly steps: readonly TurnStep[];
};

/** The same bounded, redacted activity record for diagnostics and the web app. Times are epoch ms. */
export type Activity = {
	readonly running: boolean;
	readonly lastActivityAt: number;
	readonly current: readonly { id?: string; name: string; summary: string; startedAt: number; elapsedMs: number; timeoutMs: number | null }[];
	readonly steps: readonly TurnStep[];
	readonly stalls: readonly { key: string; reason: string; since: number }[];
};

