import { getAgentByName } from "agents";
import { deploymentSettings } from "../deployment";
import { threadPath } from "./api";
import { codingScheduler } from "./scheduler-do";
import type { CodingEventSink, TurnEndedEvent } from "./thread-do";

/**
 * Hearing of a coding thread's turns, for the agent that started it: when a
 * turn ends, the chat the agent started the thread from is woken with a
 * short message saying how it went (`Pim.codingTurnEnded`), as a scheduled
 * task wakes a chat. Who started the thread is in the space's list
 * (./thread-index.ts); a thread a person started is only logged. Each turn
 * wakes the chat once, by the turn's key, and a chat that's gone is left be.
 */
export function supervisorSink(env: Env): CodingEventSink {
	return {
		async emit(event) {
			const thread = await codingScheduler(env, event.space).thread(event.threadId);
			if (thread?.createdBy.type !== "agent") return;
			const pim = await getAgentByName(env.Pim, event.space);
			await pim.codingTurnEnded(thread.createdBy.chat, turnEndedMessage(event, deploymentSettings(env).publicUrl), `coding:${event.threadId}:${event.operationId}`, thread.createdBy.agent);
		},
	};
}

const OUTCOMES: Record<TurnEndedEvent["outcome"], string> = {
	completed: "finished its turn",
	error: "stopped with an error",
	cancelled: "was cancelled",
	needs_approval: "waits for an approval",
	interrupted: "was interrupted by a restart",
};

/** What the agent reads when a thread it started ends a turn. */
export function turnEndedMessage(event: TurnEndedEvent, origin: string | null): string {
	const reason = event.reason && event.reason !== event.outcome ? ` (${event.reason})` : "";
	const lines = [
		`[Coding thread ${event.threadId}] It ${OUTCOMES[event.outcome]}${reason}.`,
		`State: ${event.state}. ${event.unmetered ? "Its spend isn't metered, so its budget isn't enforced." : `Spent $${event.spentUsd.toFixed(2)}${event.budgetUsd === null ? "" : ` of its $${event.budgetUsd} budget`}.`}`,
		`Link: ${origin ?? ""}${threadPath(event.threadId)}`,
	];
	if (event.detail) lines.push(`Detail: ${event.detail}`);
	if (event.outcome === "error") lines.push("This looks like a failure. If it is transient (workspace, manager or harness error), retry once by starting a fresh thread with the same task; if it fails again, tell the person.");
	if (event.checkpoint) lines.push(`Its changes are committed as ${event.checkpoint.slice(0, 12)}.`);
	if (event.said) lines.push("It last said:", event.said);
	lines.push("Look with coding_status, coding_diff or coding_tests; tell it more with coding_steer; push its branch with coding_push (then coding_open_pull_request; neither needs approval), or ship it to the default branch with coding_merge (no approval needed: check its diff and tests first). Tell the person what matters.");
	return lines.join("\n");
}
