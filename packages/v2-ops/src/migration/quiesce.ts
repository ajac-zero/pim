import { nextCronAfter, cronOccurrencesBetween } from "./cron.ts";
import { type DoDump, type SnapshotReader, rowsOf } from "./snapshot.ts";
import { canonical } from "./secrets.ts";
import { sha256 } from "./snapshot.ts";
import { readPi } from "./split.ts";

export type PlannedOperation = {
	readonly tenantId: string;
	readonly kind: string;
	readonly idempotencyKey: string;
	readonly status: "needs_reconciliation" | "succeeded";
	readonly payload: Record<string, unknown>;
	readonly reason: string;
};
export type PlannedDue = {
	readonly tenantId: string;
	readonly kind: string;
	readonly key: string;
	readonly state: "armed" | "done" | "recompute" | "dropped";
	readonly nextDueAtMs: number | null;
	readonly missed: readonly number[];
	readonly spec: unknown;
};
export type PlannedRemote = { readonly tenantId: string; readonly threadId: string; readonly provider: string; readonly remoteId: string; readonly adoption: "adopt" | "unknown"; readonly state: string; readonly lastEventAtMs: number | null; readonly startOperationId: string | null };
export type QuiescencePlan = {
	readonly operations: readonly PlannedOperation[];
	readonly dueWork: readonly PlannedDue[];
	readonly remoteThreads: readonly PlannedRemote[];
	/** pi task ids (per tenant) a Runner must not run again until a reconciler releases them. */
	readonly taskHolds: readonly { tenantId: string; taskId: number; reason: string }[];
	readonly resumableTasks: Readonly<Record<string, number>>;
};

const TERMINAL_THREAD = new Set(["archived", "failed", "done", "completed", "cancelled", "stopped"]);
const json = (value: unknown): any => (typeof value === "string" && value !== "" ? JSON.parse(value) : null);

/**
 * Decides, from the snapshot alone, what must not happen when the first Runner boots: tool calls and approvals that were
 * not settled at the fence become `needs_reconciliation` operations (and their pi tasks are held), schedule occurrences
 * due at or before the cutover are recorded as missed and never fired, and remote coding sessions are adopted by their remote id.
 */
export async function planQuiescence(reader: SnapshotReader, cutoverAt: number): Promise<QuiescencePlan> {
	const operations: PlannedOperation[] = [];
	const dueWork: PlannedDue[] = [];
	const remoteThreads: PlannedRemote[] = [];
	const taskHolds: { tenantId: string; taskId: number; reason: string }[] = [];
	const resumable: Record<string, number> = {};

	for (const owner of await reader.names("Pim")) {
		const dump = await reader.dump("Pim", owner);
		const pi = readPi(dump);
		const approvals = rowsOf(dump, "pim_approvals");
		const approvalByCall = new Map(approvals.filter((a) => a.call_id).map((a) => [String(a.call_id), a]));
		for (const row of pi.tasks) {
			if (row.status === "terminal") continue;
			const task = json(row.record) ?? {};
			if (row.kind === "pi.tool") {
				const approval = approvalByCall.get(String(task.callId ?? ""));
				const reason =
					approval?.status === "pending"
						? "An approval was pending at the cutover; a person decides again, and a timeout never approves."
						: approval && approval.status !== "pending" && approval.result === null
							? "The decision was recorded but no result receipt exists, so the effect may or may not have happened."
							: "The tool call was running at the cutover and its effect is unknown.";
				operations.push({
					tenantId: owner,
					kind: `tool:${String(task.tool ?? "unknown")}`,
					idempotencyKey: `tool:${owner}:${row.id}`,
					status: "needs_reconciliation",
					// The arguments can hold bodies and secrets: only their digest is kept.
					payload: { taskId: Number(row.id), conversationId: Number(row.conversation_id), callId: task.callId ?? null, taskStatus: row.status, approval: approval?.id ?? null, argsSha256: sha256(canonical(task.args ?? null)) },
					reason,
				});
				taskHolds.push({ tenantId: owner, taskId: Number(row.id), reason });
			} else {
				resumable[owner] = (resumable[owner] ?? 0) + 1;
			}
		}
		for (const approval of approvals) {
			if (approval.status !== "pending" && !(approval.result === null && approval.decided_at !== null)) continue;
			operations.push({
				tenantId: owner,
				kind: "approval",
				idempotencyKey: `approval:${owner}:${approval.id}`,
				status: "needs_reconciliation",
				payload: { approval: String(approval.id), status: String(approval.status), action: String(approval.action), onTimeout: approval.on_timeout, callId: approval.call_id },
				reason: approval.status === "pending" ? "Pending at the cutover; any expiry that came due during the fence is not applied." : "Decided, but the action's result was never recorded.",
			});
		}

		// Schedules: triggers.
		const revisions = new Map<string, any>();
		for (const row of rowsOf(dump, "pim_trigger_revisions")) revisions.set(`${row.trigger_id}:${row.revision}`, json(row.spec));
		for (const trigger of rowsOf(dump, "pim_triggers")) {
			if (trigger.lifecycle !== "active") continue;
			const source = rowsOf(dump, "pim_trigger_sources").find((s) => s.trigger_id === trigger.id);
			const spec = revisions.get(`${trigger.id}:${trigger.revision}`)?.source;
			if (!spec || spec.kind !== "time") continue;
			const last = Number(source?.last_observed_at ?? trigger.created_at);
			let next: number | null = null;
			let missed: number[] = [];
			let state: PlannedDue["state"] = "armed";
			if (spec.schedule === "cron") {
				if (spec.timeZone !== "UTC") state = "recompute";
				else {
					missed = cronOccurrencesBetween(spec.expression, last, cutoverAt, 100);
					next = nextCronAfter(spec.expression, cutoverAt);
				}
			} else if (spec.schedule === "interval") {
				const every = Number(spec.everyMs);
				const anchor = Number(spec.anchorAt);
				const firstAfter = (t: number) => anchor + Math.floor((t - anchor) / every + 1) * every;
				for (let t = firstAfter(last); t <= cutoverAt && missed.length < 100; t += every) missed.push(t);
				next = firstAfter(cutoverAt);
			} else if (spec.schedule === "once") {
				if (Number(spec.at) <= cutoverAt) {
					const done = rowsOf(dump, "pim_trigger_occurrences").some((o) => o.trigger_id === trigger.id && o.status !== "pending");
					if (!done) missed = [Number(spec.at)];
					state = done ? "done" : "dropped";
				} else next = Number(spec.at);
			}
			dueWork.push({ tenantId: owner, kind: `trigger:${spec.schedule}`, key: String(trigger.id), state, nextDueAtMs: state === "armed" ? next : null, missed, spec });
		}
		for (const outbox of rowsOf(dump, "pim_trigger_outbox")) {
			if (outbox.status === "done" || outbox.status === "delivered" || outbox.status === "submitted") continue;
			operations.push({ tenantId: owner, kind: "trigger_fire", idempotencyKey: `outbox:${owner}:${outbox.id}`, status: "needs_reconciliation", payload: { outbox: String(outbox.id), trigger: String(outbox.trigger_id), operationId: String(outbox.operation_id), availableAt: Number(outbox.available_at) }, reason: "A firing queued before the cutover is never delivered after it." });
		}
		for (const job of rowsOf(dump, "cf_agents_jobs")) {
			const dueAt = Number(job.time) * 1000;
			dueWork.push({ tenantId: owner, kind: "agents_job", key: String(job.id), state: dueAt <= cutoverAt ? "dropped" : "armed", nextDueAtMs: dueAt <= cutoverAt ? null : dueAt, missed: dueAt <= cutoverAt ? [dueAt] : [], spec: { fn: job.fn, payload: json(job.payload) } });
		}
	}

	for (const name of await reader.names("CodingThread")) {
		const dump: DoDump = await reader.dump("CodingThread", name);
		for (const thread of rowsOf(dump, "coding_thread")) {
			const owner = String(thread.space);
			const state = String(thread.state);
			const orb = json(thread.orb);
			if (thread.provider_kind === "agent-hosted" && orb?.threadId) {
				const events = rowsOf(dump, "coding_event");
				const last = events.reduce((m, e) => Math.max(m, Number(e.at)), 0);
				remoteThreads.push({ tenantId: owner, threadId: String(thread.thread_id), provider: String(thread.harness), remoteId: String(orb.threadId), adoption: TERMINAL_THREAD.has(state) ? "unknown" : "adopt", state, lastEventAtMs: last || null, startOperationId: thread.start_operation === null ? null : String(thread.start_operation) });
				// The remote start already happened: record it as done under the same key the Amp client dedupes on.
				operations.push({ tenantId: owner, kind: "remote_thread_start", idempotencyKey: `${thread.thread_id}:${thread.start_operation}`, status: "succeeded", payload: { remoteId: String(orb.threadId), provider: String(thread.harness) }, reason: "Started before the cutover; adopted by its remote id, never started again." });
			} else if (!TERMINAL_THREAD.has(state) && thread.harness !== "pi" && thread.provider_kind !== "agent-hosted") {
				const run = rowsOf(dump, "coding_harness_run").find((r) => r.status === "running");
				operations.push({ tenantId: owner, kind: "coding_cli_turn", idempotencyKey: `cli:${thread.thread_id}:${run?.operation_id ?? "unknown"}`, status: "needs_reconciliation", payload: { thread: String(thread.thread_id), harness: String(thread.harness), operationId: run?.operation_id ?? null }, reason: "A CLI turn was cut off by the fence; it may have run, pushed or changed files." });
			}
		}
	}
	return { operations, dueWork, remoteThreads, taskHolds, resumableTasks: resumable };
}
