/**
 * The approval a gated tool waits for, in one place for the tools that only ask a person before they change something in Pim (a skill written, a memory scope shared, a connector
 * added): no outside effect to make once afterwards, so the decision is all there is. The call files an approval, parks, and is woken by the person's decision, which arrives as a
 * signal naming the approval, so a later gated call of the same task never takes an earlier one's answer for its own.
 */
import type { App } from "@pim/v2-app/app";
import type { Principal } from "@pim/v2-contracts/identity";
import type { Db as RuntimeDb } from "@pim/v2-runtime/db";

type Result = { output: { type: "text"; text: string }[]; isError?: boolean };

/** What a parked call returns: the Runner suspends the task until the person's decision wakes it. */
export const WAITING = { output: [{ type: "text", text: "Waiting for a person's approval." }], control: { suspend: true } } as never as Result;

/** The note the person left with their decision, as a sentence for the agent; empty when there is none. */
async function noteOf(app: App, ownerId: string, approvalId: string): Promise<string> {
	const note = await app.db.owner(ownerId, async (tx) => (await tx.query("SELECT args->>'note' AS note FROM pim_app.approvals WHERE id = $1", [approvalId])).rows[0]?.note as string | undefined).catch(() => undefined);
	return note ? ` Their note: ${note}` : "";
}

/**
 * Asks a person before the call goes on. It returns `undefined` when the call may go on (approved, or covered by a standing approval), and otherwise what the call must answer:
 * the parked result while the approval waits, or the refusal when it was denied.
 */
export async function askFirst(
	deps: { app: App; runtime: RuntimeDb; ownerId: string },
	call: { chat: string | null; p: Principal; api: { taskId: unknown; callId: unknown } },
	ask: { action: string; resource?: Record<string, string>; summary: string; args?: Record<string, unknown>; explicit?: boolean; denied: string },
): Promise<Result | undefined> {
	const { app, runtime, ownerId } = deps;
	const taskId = String(call.api.taskId);
	const callId = String(call.api.callId);
	const filed = (await app.db.owner(ownerId, async (tx) => (await tx.query("SELECT id FROM pim_app.approvals WHERE tool = $1 AND args->>'taskId' = $2 AND args->>'callId' = $3 ORDER BY id DESC LIMIT 1", [ask.action, taskId, callId])).rows[0])) as { id: string } | undefined;
	if (!filed) {
		const gate = await app.approvals.gate(call.p, { action: ask.action, resource: ask.resource ?? {}, ...(call.chat ? { chatId: call.chat } : {}), args: { ...ask.args, taskId, callId, summary: ask.summary }, timeoutMs: 24 * 3600_000, onTimeout: "deny", ...(ask.explicit ? { explicit: true } : {}) });
		return gate.outcome === "waiting" ? WAITING : undefined;
	}
	const signal = (await runtime.read<{ payload: { approved?: boolean; approvalId?: string } }>(ownerId, "SELECT payload FROM pim_runtime.durable_signals WHERE owner_id = $1 AND task_id = $2 AND kind = 'approval' AND payload->>'approvalId' = $3 ORDER BY signal_id DESC LIMIT 1", [ownerId, taskId, filed.id])).rows[0];
	if (!signal) return WAITING;
	if (signal.payload.approved !== true) return { output: [{ type: "text", text: `${ask.denied}${await noteOf(app, ownerId, filed.id)}` }], isError: true };
	return undefined;
}
