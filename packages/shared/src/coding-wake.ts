/**
 * The message that tells an agent a coding thread it started ended a turn or stalled, in the form the chat view
 * recognises (`codingNoticeOf` in the web app, `CODING_EVENT` in ./transcript.ts). v1 writes the same text from
 * `turnEndedMessage` in src/coding/supervisor.ts; v2 writes it from Forge's wakes.
 */
export type CodingWakeFacts = {
	threadId: string;
	outcome: "completed" | "failed" | "cancelled";
	/** The thread's state in Forge, such as "idle" or "failed". */
	state: string;
	spentUsd: number;
	budgetUsd: number | null;
	/** The public URL of the deployment, or null when it has none, which leaves the link a path. */
	origin: string | null;
	/** Why it ended, when that adds to the outcome. */
	detail?: string | null;
	/** The short commit its changes are committed as. */
	checkpoint?: string | null;
	/** The thread's last message. */
	said?: string | null;
};

const OUTCOMES: Record<CodingWakeFacts["outcome"], string> = {
	completed: "finished its turn",
	failed: "stopped with an error",
	cancelled: "was cancelled",
};

/** Where a person opens a coding thread in the web app. */
export const codingThreadPath = (threadId: string) => `/coding/${threadId}`;

export function codingWakeText(f: CodingWakeFacts): string {
	const lines = [
		`[Coding thread ${f.threadId}] It ${OUTCOMES[f.outcome]}.`,
		`State: ${f.state}. Spent $${f.spentUsd.toFixed(2)}${f.budgetUsd === null ? "" : ` of its $${f.budgetUsd} budget`}.`,
		`Link: ${f.origin?.replace(/\/$/, "") ?? ""}${codingThreadPath(f.threadId)}`,
	];
	if (f.detail) lines.push(`Detail: ${f.detail}`);
	if (f.outcome === "failed") lines.push("This looks like a failure. If it is transient (workspace, manager or harness error), retry once by starting a fresh thread with the same task; if it fails again, tell the person.");
	if (f.checkpoint) lines.push(`Its changes are committed as ${f.checkpoint.slice(0, 12)}.`);
	if (f.said) lines.push("It last said:", f.said);
	lines.push(
		'Look with coding_inspect (view transcript with tail=true or role="assistant", then transcript_output for full messages; or status, diff or tests); tell it more with coding_steer. It pushes its own pim/… branch and opens its own pull request when its work is ready; a person merges it, you cannot. Never steer a thread just to ask for a summary or diff printout. Tell the person what matters.',
	);
	return lines.join("\n");
}

/** What the agent reads when a thread it started has made no progress, as v1's `Stalled:` message did. */
export function codingStallText(threadId: string, stage: string, reasons: readonly string[]): string {
	return `[Coding thread ${threadId}] Stalled: ${stage === "2" ? "escalated — " : ""}${reasons.length ? [...new Set(reasons)].join("; ") : "no progress"}. Supervision notice ${stage}/2: inspect once if needed; Pim won't wake again for this quiet spell unless it escalates or the turn ends.`;
}
