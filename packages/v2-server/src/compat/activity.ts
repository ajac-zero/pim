/**
 * What a chat is doing and how its turns went (v1's `src/activity.ts` and the turn timing of `src/diagnostics.ts`): the same redacted record the chat's page and the admin's diagnostics read.
 * A chat's turns are read from its projected transcript, with the ledger for how long each model call took (`pim_app.model_calls`) and the approvals the chat filed, which name the tool call
 * they were for. A model call's step starts at its answer's time; a tool call starts as the answer that made it ends, and ends when its result comes.
 */
import type { Activity, CallApproval, Turn, TurnStep } from "@pim/shared/activity-types";
import { isDeliveryReminder } from "@pim/shared/transcript";
import type { MessagePart, TranscriptMessage } from "@pim/shared/transcript";
import type { App } from "@pim/v2-app/app";
import { transcriptPage } from "@pim/v2-live/projections/snapshots";
import { scrub } from "./diagnostics.ts";

const MINUTE = 60_000;

/** Only operational arguments belong in a step's summary, never request bodies, prompts or environment values. */
export function toolSummary(input: Record<string, unknown>): string {
	const fields = ["command", "cmd", "thread", "threadId", "thread_id", "url", "path", "file_path", "cwd", "timeout", "timeoutMs", "timeout_ms"];
	return scrub(fields.filter((key) => input[key] !== undefined).map((key) => (typeof input[key] === "string" ? `${key}=${input[key]}` : `${key}=${JSON.stringify(input[key])}`)).join(" "), 200);
}

/** Pi uses seconds; Claude Code's Bash tool and explicit millisecond fields use milliseconds. */
export function toolTimeout(name: string, input: Record<string, unknown>): number | null {
	// A status or wait tool's timeout is how long one look may wait, not how long a command may run.
	if (/(?:^|[_-])(?:status|wait)(?:[_-]|$)|wait_session$/i.test(name)) return null;
	const ms = input.timeoutMs ?? input.timeout_ms ?? (typeof input.timeout === "number" ? input.timeout * (name === "Bash" ? 1 : 1000) : null);
	return typeof ms === "number" && Number.isFinite(ms) && ms > 0 ? ms : null;
}

const textOf = (message: TranscriptMessage) => message.parts.flatMap((part) => (part.type === "text" ? [part.text] : [])).join("");
const isCall = (part: MessagePart): part is Extract<MessagePart, { type: "tool-call" }> => part.type === "tool-call";
const isResult = (part: MessagePart): part is Extract<MessagePart, { type: "tool-result" }> => part.type === "tool-result";

/** What the ledger knows of a model call the transcript shows: who answered, and how long it took. Keyed by the answer's time. */
export type CallTimes = ReadonlyMap<number, { model: string; ms: number | null }>;
/** A model call that failed and was tried again on another model: the transcript shows nothing of it. */
export type FailedCall = { at: number; ms: number | null; model: string; error: string | null };

/**
 * A chat's turns, from its messages in order: each begins with a message to the agent, other than Pim's reminder to deliver, and goes on to the next. A tool call starts as the model's
 * answer ends, and ends when its result comes. The last turn of a chat at work (`busy`) goes on until `now`.
 */
export function turnsOf(messages: readonly TranscriptMessage[], approvals: ReadonlyMap<string, CallApproval>, now: number, busy: boolean, calls: CallTimes = new Map(), failed: readonly FailedCall[] = []): Turn[] {
	const results = new Map(messages.flatMap((message) => (message.role === "tool" ? message.parts.filter(isResult).map((part) => [part.id, { at: message.timestamp, part }] as const) : [])));
	const turns: { startedAt: number; endedAt: number; modelMs: number; toolsMs: number; approvalsMs: number; steps: TurnStep[] }[] = [];
	for (const message of messages) {
		if (message.role === "user") {
			if (!isDeliveryReminder(textOf(message))) turns.push({ startedAt: message.timestamp, endedAt: message.timestamp, modelMs: 0, toolsMs: 0, approvalsMs: 0, steps: [] });
			continue;
		}
		const turn = turns.at(-1);
		if (message.role !== "assistant" || !turn) continue;
		const known = calls.get(message.timestamp);
		const ms = known?.ms ?? null;
		const answered = message.timestamp + (ms ?? 0);
		turn.steps.push({ kind: "model", at: message.timestamp, ms, model: known?.model ?? "model", stop: message.stopReason ?? "stop", error: message.error ? scrub(message.error) : null });
		turn.modelMs += ms ?? 0;
		turn.endedAt = Math.max(turn.endedAt, answered);
		const made = message.parts.filter(isCall);
		if (made.length === 0) continue;
		// The calls of one answer may run side by side: the round lasts until its last result.
		let roundEnd = answered;
		let waited = 0;
		for (const call of made) {
			const result = results.get(call.id);
			const approval = approvals.get(call.id);
			// A call left without its result or decision when the chat stopped took no time after.
			const waitedMs = approval ? Math.max(0, (approval.decidedAt ?? (busy ? now : approval.createdAt)) - approval.createdAt) : 0;
			const input = (typeof call.arguments === "object" && call.arguments !== null && !Array.isArray(call.arguments) ? call.arguments : {}) as Record<string, unknown>;
			turn.steps.push({
				kind: "tool", id: call.id, at: answered, ms: result ? Math.max(0, result.at - answered) : null, name: call.name, summary: toolSummary(input), timeoutMs: toolTimeout(call.name, input), exitCode: null,
				outputBytes: result ? new TextEncoder().encode(JSON.stringify(result.part.content)).byteLength : null, error: result?.part.error ?? false, approval: approval ? { ...approval, waitedMs } : null,
			});
			roundEnd = Math.max(roundEnd, result?.at ?? (busy ? now : answered));
			waited += waitedMs;
		}
		turn.approvalsMs += waited;
		turn.toolsMs += Math.max(0, roundEnd - answered - waited);
		turn.endedAt = Math.max(turn.endedAt, roundEnd);
	}
	// A model call that failed and went to the next model is a step of the turn it happened in, though the transcript shows nothing of it.
	for (const call of failed) {
		const turn = turns.findLast((t) => t.startedAt <= call.at);
		if (!turn) continue;
		turn.steps.push({ kind: "model", at: call.at, ms: call.ms, model: call.model, stop: "error", error: call.error });
		turn.modelMs += call.ms ?? 0;
		turn.steps.sort((a, b) => a.at - b.at);
	}
	return turns.map((turn, index) => {
		const inProgress = busy && index === turns.length - 1;
		return { ...turn, endedAt: inProgress ? now : turn.endedAt, inProgress };
	});
}

/** Each stall has a key that changes when the thing stalled makes progress and goes quiet again. A quiet command is worth investigating after five minutes. */
export function activityOf(turns: readonly Turn[], now: number, options: { running: boolean; startedAt: number; lastOutputAt?: number; quietMs?: number }): Activity {
	const turn = turns.at(-1);
	const steps = turn?.steps ?? [];
	const lastActivityAt = Math.max(options.startedAt, options.lastOutputAt ?? 0, ...steps.map((step) => step.at + (step.ms ?? 0)));
	const current = options.running ? steps.flatMap((step) => (step.kind === "tool" && step.ms === null && step.approval?.status !== "pending" ? [{ id: step.id, name: step.name, summary: step.summary, startedAt: step.at, elapsedMs: Math.max(0, now - step.at), timeoutMs: step.timeoutMs }] : [])) : [];
	const stalls: Activity["stalls"][number][] = [];
	for (const tool of current) {
		const timeout = tool.timeoutMs !== null && tool.elapsedMs > tool.timeoutMs;
		// Tools print no output over time here: a quiet one is one that has run a long while with nothing else in the chat moving.
		const quiet = now - Math.max(tool.startedAt, lastActivityAt) > (options.quietMs ?? 5 * MINUTE);
		if (timeout) stalls.push({ key: `tool:${tool.id}`, reason: "past declared timeout", since: tool.startedAt });
		// Inside its own declared timeout a quiet command is only shown, never woken for.
		else if (quiet) stalls.push({ key: `tool:${tool.id}:${Math.max(tool.startedAt, lastActivityAt)}`, reason: "no output for five minutes", since: tool.startedAt, ...(tool.timeoutMs === null ? {} : { actionable: false as const }) });
	}
	return { running: options.running, lastActivityAt, current, steps: steps.slice(-120), stalls };
}

/** How many of a chat's newest messages are read for its latest turn. */
const MESSAGES = 200;

export type LedgerRow = { id: string; provider: string | null; model: string | null; latency_ms: number | string | null; error: string | null; at: number | string };

/**
 * The model calls the ledger kept for a chat, as the turns show them. A request that was answered is keyed by when it started (the answer's own time, in its id), and its latency says how long
 * it took. A request that failed and went to the next model is a row of its own, written when the request that followed it ended (`at` is that moment), so it is placed by what it led to: it
 * ended when the next attempt began, the first of which began when the answered request did (the stamp in its id), and each began its latency before that. Placed by its row's time instead,
 * every failed attempt shows later than it ran, by as long as the answered request took, and so overlaps it.
 */
export function callsOf(ledger: readonly LedgerRow[]): { calls: Map<number, { model: string; ms: number | null }>; failed: FailedCall[] } {
	const calls = new Map<number, { model: string; ms: number | null }>();
	const failed: FailedCall[] = [];
	const attempts = new Map<string, { n: number; row: LedgerRow }[]>();
	for (const row of ledger) {
		const model = [row.provider, row.model].filter(Boolean).join("/");
		const ms = row.latency_ms === null ? null : Number(row.latency_ms);
		const stamp = /^mc_c.+_(\d+)$/.exec(row.id)?.[1];
		if (stamp) calls.set(Number(stamp), { model, ms });
		const attempt = /^(mc_c.+_\d+)_f(\d+)$/.exec(row.id);
		if (attempt) attempts.set(attempt[1]!, [...(attempts.get(attempt[1]!) ?? []), { n: Number(attempt[2]), row }]);
		else if (/_f\d+$/.test(row.id)) failed.push({ at: Number(row.at) - (ms ?? 0), ms, model, error: row.error ? scrub(row.error) : null });
	}
	for (const [base, list] of attempts) {
		let began = Number(/_(\d+)$/.exec(base)![1]);
		for (const { row } of list.sort((a, b) => b.n - a.n)) {
			const ms = row.latency_ms === null ? null : Number(row.latency_ms);
			began -= ms ?? 0;
			failed.push({ at: began, ms, model: [row.provider, row.model].filter(Boolean).join("/"), error: row.error ? scrub(row.error) : null });
		}
	}
	return { calls, failed };
}

/** A chat's turns, as of `now`, with the ledger's and the approvals' side of them. Null when there is no such chat or it has said nothing. */
export async function chatTurns(app: App, ownerId: string, chat: string, now = Date.now()): Promise<{ turns: Turn[]; busy: boolean; updatedAt: number }> {
	const page = await transcriptPage(app.db.pool, ownerId, chat, { limit: MESSAGES });
	const messages = page.messages.filter((m) => !m.partial) as TranscriptMessage[];
	const from = messages.find((m) => m.role === "user")?.timestamp ?? now;
	const { busy, updatedAt, approvals, ledger } = await app.db.owner(ownerId, async (tx) => ({
		busy: ((await tx.query("SELECT busy FROM pim_projection.sidebar_session_projection WHERE chat_id = $1", [chat])).rows[0]?.busy ?? false) as boolean,
		updatedAt: Number((await tx.query("SELECT (extract(epoch FROM updated_at) * 1000)::bigint AS u FROM pim_app.conversations WHERE public_chat_id = $1", [chat])).rows[0]?.u ?? 0),
		approvals: (await tx.query("SELECT id, state, args->>'callId' AS call, created_at, decided_at, decided_by FROM pim_app.approvals WHERE public_chat_id = $1 AND args ? 'callId' AND created_at >= $2", [chat, new Date(from - MINUTE)])).rows,
		ledger: (await tx.query("SELECT id, provider, model, latency_ms, error, stop_reason, (extract(epoch FROM at) * 1000)::bigint AS at FROM pim_app.model_calls WHERE public_chat_id = $1 AND at >= $2", [chat, new Date(from - MINUTE)])).rows,
	}));
	const { calls, failed } = callsOf(ledger as LedgerRow[]);
	const bound = new Map<string, CallApproval>(approvals.map((r) => [r.call as string, { id: r.id as string, status: r.state === "waiting" ? "pending" : (r.state as string), createdAt: new Date(r.created_at).getTime(), decidedAt: r.decided_at ? new Date(r.decided_at).getTime() : null, decidedBy: (r.decided_by as string | null) ?? null }]));
	return { turns: turnsOf(messages, bound, now, busy, calls, failed), busy, updatedAt };
}

/** The activity of a chat's latest turn. */
export async function chatActivity(app: App, ownerId: string, chat: string, now = Date.now()): Promise<Activity> {
	const { turns, busy, updatedAt } = await chatTurns(app, ownerId, chat, now);
	return activityOf(turns, now, { running: busy, startedAt: turns.at(-1)?.startedAt ?? updatedAt });
}
