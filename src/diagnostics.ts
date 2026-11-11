import type { Message } from "@earendil-works/pi-ai";
import { redactSecrets } from "./hostops";
import { DELIVERY_REMINDER } from "./transcript";

/**
 * What the admin's majordomo reads to debug this Pim without the web app
 * (see ./extensions/meta-diagnostics.ts): the space's own failures, gathered
 * from the data it already keeps, and a small bounded log of events that were
 * only written to the console before, such as a slow request.
 *
 * Everything that leaves here is read-only, cut short, and scrubbed of what
 * looks like a secret, an address or a person's email.
 */

/** How many events the log keeps; older ones are dropped as new ones come. */
export const EVENT_KEEP = 200;
/** The longest text a diagnostic carries. */
const TEXT_LENGTH = 300;
const MINUTE = 60_000;
const DAY = 24 * 60 * MINUTE;

/** The kinds of thing `pim_diagnostics` reports on, which its `kind` chooses between. */
export const DIAGNOSTIC_KINDS = ["runs", "turns", "triggers", "model_calls", "provider_cooldowns", "coding", "connectors", "approvals", "events"] as const;
export type DiagnosticKind = (typeof DIAGNOSTIC_KINDS)[number];

const SECRET_KEY = /pass(word)?|secret|token|api[_-]?key|authorization|credential|cookie|bearer/i;

/** `text` with what looks like a secret, an address or an email taken out, and cut to `max` characters. */
export function scrub(text: string, max = TEXT_LENGTH): string {
	const clean = redactSecrets(text)
		// Addresses keep their path but not the host, the credentials in them, or what follows `?`.
		.replace(/\b[a-z][a-z0-9+.-]*:\/\/[^\s"'<>/?#]*([^\s"'<>?#]*)[^\s"'<>]*/gi, (_url, path: string) => `[address]${path}`)
		.replace(/\b((?:pass(?:word)?|secret|token|api[_-]?key|authorization|credential)s?)\s*[=:]\s*\S+/gi, "$1=[redacted]")
		.replace(/[^\s@"'<>,;]+@[^\s@"'<>,;]+\.[^\s@"'<>,;]+/g, "[email]");
	return clean.length > max ? `${clean.slice(0, max)}…` : clean;
}

/** `value` with every string scrubbed and every secret-looking field left out. */
export function scrubValue(value: unknown, depth = 0): unknown {
	if (typeof value === "string") return scrub(value);
	if (typeof value !== "object" || value === null) return value;
	if (depth > 4) return "[deep]";
	if (Array.isArray(value)) return value.slice(0, 50).map((item) => scrubValue(item, depth + 1));
	return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, SECRET_KEY.test(key) ? "[redacted]" : scrubValue(item, depth + 1)]));
}

const iso = (ms: number | null | undefined) => (ms === null || ms === undefined ? null : new Date(ms).toISOString());

/**
 * The window a query reads: an ISO 8601 time, or how long back (`90m`, `6h`,
 * `2d`); a day when it is not given. Throws what is wrong with one it can't
 * read.
 */
export function sinceOf(since: string | undefined, now: number): number {
	if (since === undefined || since.trim() === "") return now - DAY;
	const relative = /^(\d{1,4})\s*([mhd])$/i.exec(since.trim());
	if (relative) return now - Number(relative[1]) * { m: MINUTE, h: 60 * MINUTE, d: DAY }[relative[2]!.toLowerCase() as "m" | "h" | "d"];
	const at = Date.parse(since);
	if (Number.isNaN(at)) throw new Error(`since must be an ISO 8601 time or how long back, such as 90m, 6h or 2d, not "${scrub(since, 40)}"`);
	return at;
}

type Row = Record<string, SqlStorageValue>;

/** The last `EVENT_KEEP` things that happened to this space that only the console heard before. */
export class DiagnosticEvents {
	readonly #sql: SqlStorage;

	constructor(sql: SqlStorage) {
		this.#sql = sql;
		sql.exec(`
CREATE TABLE IF NOT EXISTS pim_diagnostic_events (
	id INTEGER PRIMARY KEY AUTOINCREMENT,
	ts INTEGER NOT NULL,
	kind TEXT NOT NULL,
	detail TEXT NOT NULL
);`);
	}

	/** Keeps an event, scrubbed, and drops the oldest beyond `EVENT_KEEP`. Never throws: a log must not break what it describes. */
	record(kind: string, detail: Record<string, unknown>, ts = Date.now()): void {
		try {
			this.#sql.exec("INSERT INTO pim_diagnostic_events (ts, kind, detail) VALUES (?, ?, ?)", ts, scrub(kind, 60), JSON.stringify(scrubValue(detail)));
			this.#sql.exec("DELETE FROM pim_diagnostic_events WHERE id <= (SELECT MAX(id) FROM pim_diagnostic_events) - ?", EVENT_KEEP);
		} catch (error) {
			console.warn(JSON.stringify({ event: "pim.diagnostic_event_failed", error: String(error).slice(0, 200) }));
		}
	}

	count(): number {
		return Number(this.#sql.exec("SELECT COUNT(*) AS n FROM pim_diagnostic_events").one().n);
	}

	/** Events since `since`, newest first. */
	since(since: number, limit: number): { at: string | null; kind: string; detail: unknown }[] {
		return this.#sql
			.exec("SELECT ts, kind, detail FROM pim_diagnostic_events WHERE ts >= ? ORDER BY id DESC LIMIT ?", since, limit)
			.toArray()
			.map((row) => ({ at: iso(Number(row.ts)), kind: String(row.kind), detail: JSON.parse(String(row.detail)) as unknown }));
	}
}

/** An approval as a turn's timeline reads it, by the call that filed it. */
export type CallApproval = { readonly id: string; readonly status: string; readonly createdAt: number; readonly decidedAt: number | null; readonly decidedBy: string | null };

/** One step of a turn: a model call, failed ones included, or a tool call, with how long it took; null while it goes on, or for a model call that didn't say. */
export type TurnStep =
	| { readonly kind: "model"; readonly at: number; readonly ms: number | null; readonly model: string; readonly stop: string; readonly error: string | null }
	| { readonly kind: "tool"; readonly at: number; readonly ms: number | null; readonly name: string; readonly error: boolean; readonly approval: (CallApproval & { readonly waitedMs: number }) | null };

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

/**
 * A chat's turns, from its messages in order: each begins with a message to
 * the agent, other than Pim's reminder to deliver, and goes on to the next.
 * A model call's message says when it started and how long it took; a tool
 * call starts as the model's answer ends, and ends when its result comes.
 * The last turn of a chat at work (`busy`) goes on until `now`.
 */
export function turnsOf(messages: readonly Message[], approvals: ReadonlyMap<string, CallApproval>, now: number, busy: boolean): Turn[] {
	const results = new Map(messages.flatMap((message) => (message.role === "toolResult" ? [[message.toolCallId, message] as const] : [])));
	const turns: { startedAt: number; endedAt: number; modelMs: number; toolsMs: number; approvalsMs: number; steps: TurnStep[] }[] = [];
	for (const message of messages) {
		if (message.role === "user") {
			const text = typeof message.content === "string" ? message.content : message.content.flatMap((part) => (part.type === "text" ? [part.text] : [])).join("");
			if (text !== DELIVERY_REMINDER) turns.push({ startedAt: message.timestamp, endedAt: message.timestamp, modelMs: 0, toolsMs: 0, approvalsMs: 0, steps: [] });
			continue;
		}
		const turn = turns.at(-1);
		if (message.role !== "assistant" || !turn) continue;
		const ms = message.durationMs ?? null;
		const answered = message.timestamp + (ms ?? 0);
		turn.steps.push({ kind: "model", at: message.timestamp, ms, model: message.model, stop: message.stopReason, error: message.errorMessage ?? null });
		turn.modelMs += ms ?? 0;
		turn.endedAt = Math.max(turn.endedAt, answered);
		const calls = message.content.flatMap((part) => (part.type === "toolCall" ? [part] : []));
		if (calls.length === 0) continue;
		// The calls of one answer may run side by side: the round lasts until its last result.
		let roundEnd = answered;
		let waited = 0;
		for (const call of calls) {
			const result = results.get(call.id);
			const approval = approvals.get(call.id);
			// A call left without its result or decision when the chat stopped took no time after.
			const waitedMs = approval ? Math.max(0, (approval.decidedAt ?? (busy ? now : approval.createdAt)) - approval.createdAt) : 0;
			turn.steps.push({ kind: "tool", at: answered, ms: result ? Math.max(0, result.timestamp - answered) : null, name: call.name, error: result?.isError ?? false, approval: approval ? { ...approval, waitedMs } : null });
			roundEnd = Math.max(roundEnd, result?.timestamp ?? (busy ? now : answered));
			waited += waitedMs;
		}
		turn.approvalsMs += waited;
		turn.toolsMs += Math.max(0, roundEnd - answered - waited);
		turn.endedAt = Math.max(turn.endedAt, roundEnd);
	}
	return turns.map((turn, index) => {
		const inProgress = busy && index === turns.length - 1;
		return { ...turn, endedAt: inProgress ? now : turn.endedAt, inProgress };
	});
}

/** What a space gives the report besides its SQL tables. */
export type DiagnosticSources = {
	readonly sql: SqlStorage;
	readonly events: DiagnosticEvents;
	readonly now: number;
	/** Chats whose run is held after a model error, with what failed. */
	heldRuns(): Promise<{ chat: string; agent: string; error: string }[]>;
	/** Chats whose run is at work or waits now, with what it waits on (already scrubbed, with its ids left whole) and, where the watchdog has seen it, since when it is at work and unchanged. */
	busyRuns(): Promise<{ chat: string; agent: string; waitingOn: string; seenAt: number | null; unchangedSince: number | null }[]>;
	/** The turns of `chat`, by its public id, or else of the chats at work since `since`, with each one's chat and agent. Throws for a chat there is no such. */
	turns(chat: string | null, since: number): Promise<{ chat: string; agent: string; turn: Turn }[]>;
	/** A chat's public id, by the id its conversation has inside the space. */
	chatId(session: string): string;
	/** Connectors, as the space's client sees them now. */
	connectors(): readonly { id: string; name: string; state: string; error: string | null }[];
	/** What went wrong with the space's triggers (see ./triggers/failures.ts) since the window began, or null where triggers are off. */
	triggerFailures(since: number, limit: number): readonly Readonly<Record<string, string | number | null>>[] | null;
	/** The space's coding threads. */
	codingThreads(): Promise<readonly { threadId: string; harness: string; state: string; stateReason: string | null; task: string; updatedAt: number; spentUsd: number; budgetUsd: number | null }[]>;
};

export type Section = { readonly count: number; readonly items: readonly unknown[]; readonly note?: string };

const rows = (sql: SqlStorage, query: string, ...bindings: SqlStorageValue[]): Row[] => sql.exec(query, ...bindings).toArray();
const section = (items: readonly unknown[], total = items.length, note?: string): Section => ({ count: total, items, ...(note ? { note } : {}) });

async function runs({ sql, heldRuns, busyRuns, chatId, now }: DiagnosticSources, since: number, limit: number): Promise<Section> {
	// The longest at work first: a run that should have ended long ago is what to look at.
	const busy = (await busyRuns())
		.sort((a, b) => (a.seenAt ?? now) - (b.seenAt ?? now))
		.map((run) => ({
			source: "chat",
			chat: run.chat,
			agent: run.agent,
			state: "working",
			waiting_on: run.waitingOn,
			working_since: iso(run.seenAt),
			working_minutes: run.seenAt === null ? null : Math.round((now - run.seenAt) / MINUTE),
			unchanged_since: iso(run.unchangedSince),
		}));
	const held = (await heldRuns()).map((run) => ({ source: "chat", chat: run.chat, agent: run.agent, error: scrub(run.error || "the model failed"), state: "held, waiting to be tried again" }));
	const failed = rows(sql, "SELECT id, agent, root, result, updated_at FROM pim_tasks WHERE state = 'failed' AND updated_at >= ? ORDER BY updated_at DESC LIMIT ?", since, limit).map((row) => ({
		source: "task",
		id: String(row.id),
		agent: String(row.agent),
		chat: chatId(String(row.root)),
		error: scrub(String(row.result ?? "")),
		at: iso(Number(row.updated_at)),
	}));
	const items = [...busy, ...held, ...failed];
	return section(
		items.slice(0, limit),
		items.length,
		"Working runs are those at work or waiting now, whatever since says; their times are when the watchdog, which looks every minute, first saw them and their state last changed, and are null before it has. A run that makes no progress for a long while is stopped, unless it waits on the person, on tasks it handed out or on a retry. Model errors are under model_calls.",
	);
}

/** The most steps a turn lists; a long turn's earliest are left out. */
const TURN_STEPS = 120;

/**
 * How long turns took, and where the time went: with `chat`, its turns that
 * went on in the window, newest first, step by step; without, the longest
 * turns of the chats at work in the window, with only their totals.
 */
async function turns({ turns: read }: DiagnosticSources, since: number, limit: number, chat: string | null): Promise<Section> {
	const found = await read(chat, since);
	const total = ({ turn }: { turn: Turn }) => turn.endedAt - turn.startedAt;
	const chosen = chat === null ? found.sort((a, b) => total(b) - total(a)) : found.sort((a, b) => b.turn.startedAt - a.turn.startedAt);
	const items = chosen.slice(0, limit).map(({ chat: id, agent, turn }) => {
		const totalMs = total({ turn });
		const item = {
			chat: id,
			agent,
			started_at: iso(turn.startedAt),
			ended_at: turn.inProgress ? null : iso(turn.endedAt),
			in_progress: turn.inProgress,
			total_ms: totalMs,
			model_ms: turn.modelMs,
			tools_ms: turn.toolsMs,
			approvals_ms: turn.approvalsMs,
			other_ms: Math.max(0, totalMs - turn.modelMs - turn.toolsMs - turn.approvalsMs),
			model_calls: turn.steps.filter((step) => step.kind === "model").length,
			tool_calls: turn.steps.filter((step) => step.kind === "tool").length,
		};
		if (chat === null) return item;
		const steps = turn.steps.slice(-TURN_STEPS).map((step) =>
			step.kind === "model"
				? { step: "model", at: iso(step.at), ms: step.ms, model: step.model, stop_reason: step.stop, ...(step.error === null ? {} : { error: scrub(step.error, 200) }) }
				: {
						step: "tool",
						at: iso(step.at),
						ms: step.ms,
						name: step.name,
						...(step.error ? { error: true } : {}),
						...(step.approval ? { approval: { id: step.approval.id, status: step.approval.status, decided_by: step.approval.decidedBy, waited_ms: step.approval.waitedMs } } : {}),
					},
		);
		return { ...item, steps, ...(turn.steps.length > TURN_STEPS ? { steps_left_out: turn.steps.length - TURN_STEPS } : {}) };
	});
	return section(
		items,
		found.length,
		`Times are in ms. model_ms is the model's time to answer, over all its calls, failed ones included; tools_ms is the time tool calls ran, apart from waiting for approvals; approvals_ms is the time they waited for a decision, the majordomo's review and then the person's; other_ms is the rest, such as waiting to retry the model.${chat === null ? " These are the longest turns of the chats at work in the window: give chat to read one chat's turns step by step." : ""}`,
	);
}

function triggers({ triggerFailures }: DiagnosticSources, since: number, limit: number): Section {
	const found = triggerFailures(since, limit);
	if (found === null) return section([], 0, "Triggers are not on in this space.");
	return section(
		found.slice(0, limit).map((failure) => ({ ...failure, error: typeof failure.error === "string" ? scrub(failure.error) : failure.error })),
		found.length,
	);
}

/** A call this slow or this dear is reported as unusual. */
const SLOW_CALL_MS = 60_000;
const COSTLY_CALL_USD = 1;

function modelCalls({ sql }: DiagnosticSources, since: number, limit: number): Section {
	const columns = "ts, agent_id, run_kind, provider, model, stop_reason, latency_ms, cost_usd, input, output";
	const call = (why: string) => (row: Row) => ({
		why: why || `stopped with ${String(row.stop_reason)}`,
		at: iso(Number(row.ts)),
		provider: String(row.provider),
		model: String(row.model),
		run_kind: row.run_kind === null ? null : String(row.run_kind),
		agent: row.agent_id === null ? null : String(row.agent_id),
		stop_reason: row.stop_reason === null ? null : String(row.stop_reason),
		latency_ms: row.latency_ms === null ? null : Number(row.latency_ms),
		cost_usd: row.cost_usd === null ? null : Number(row.cost_usd),
		input_tokens: Number(row.input),
		output_tokens: Number(row.output),
	});
	const failed = rows(sql, `SELECT ${columns} FROM pim_model_calls WHERE ts >= ? AND stop_reason IN ('error', 'aborted') ORDER BY ts DESC LIMIT ?`, since, limit).map(call(""));
	const unpriced = rows(sql, `SELECT ${columns} FROM pim_model_calls WHERE ts >= ? AND plan = 0 AND cost_usd IS NULL ORDER BY ts DESC LIMIT ?`, since, limit).map(call("no price for this model"));
	const slow = rows(sql, `SELECT ${columns} FROM pim_model_calls WHERE ts >= ? AND latency_ms >= ? ORDER BY latency_ms DESC LIMIT ?`, since, SLOW_CALL_MS, limit).map(call("slow"));
	const costly = rows(sql, `SELECT ${columns} FROM pim_model_calls WHERE ts >= ? AND cost_usd >= ? ORDER BY cost_usd DESC LIMIT ?`, since, COSTLY_CALL_USD, limit).map(call("costly"));
	const totals = rows(sql, "SELECT COUNT(*) AS calls, COALESCE(SUM(stop_reason IN ('error', 'aborted')), 0) AS errors FROM pim_model_calls WHERE ts >= ?", since)[0]!;
	const items = [...failed, ...unpriced, ...slow, ...costly];
	return section(items.slice(0, limit), items.length, `${Number(totals.calls)} calls in the window, ${Number(totals.errors)} of them errors or aborted. Slow is ${SLOW_CALL_MS / 1000} s or more, costly $${COSTLY_CALL_USD} or more.`);
}

/**
 * Subscriptions cooling down after their usage limit (see ./provider-cooldowns.ts), and those whose cooldown ended
 * without a request since, which keep their count of limits in a row. They are reported whatever the window.
 */
function providerCooldowns({ sql, now }: DiagnosticSources, _since: number, limit: number): Section {
	const all = rows(sql, "SELECT provider, since, until, reason, failures, reset_from FROM pim_provider_cooldowns ORDER BY until DESC");
	const items = all.slice(0, limit).map((row) => ({
		provider: String(row.provider),
		active: Number(row.until) > now,
		since: iso(Number(row.since)),
		until: iso(Number(row.until)),
		reason: scrub(String(row.reason)),
		failures: Number(row.failures),
		reset_from: String(row.reset_from),
	}));
	return section(items, all.length, "While a provider cools down, its runs go to the deployment's default model, and chats held on its limit are tried again when it ends. A provider's entry goes once it answers again.");
}

async function coding({ codingThreads }: DiagnosticSources, since: number, limit: number): Promise<Section> {
	const threads = (await codingThreads()).filter((thread) => thread.state === "failed" || thread.state === "waiting_input" || (thread.updatedAt >= since && thread.state === "running"));
	const items = threads.slice(0, limit).map((thread) => ({
		thread: thread.threadId,
		harness: thread.harness,
		state: thread.state,
		reason: thread.stateReason === null ? null : scrub(thread.stateReason),
		task: scrub(thread.task, 120),
		updated_at: iso(thread.updatedAt),
		spent_usd: thread.spentUsd,
		budget_usd: thread.budgetUsd,
	}));
	return section(items, threads.length);
}

function connectors({ connectors: servers }: DiagnosticSources, _since: number, limit: number): Section {
	const all = servers();
	const bad = all.filter((server) => server.state !== "ready" || server.error);
	return section(
		bad.slice(0, limit).map((server) => ({ id: server.id, name: scrub(server.name, 80), state: server.state, error: server.error === null ? null : scrub(server.error) })),
		bad.length,
		`${all.length} connectors in all.`,
	);
}

function approvals({ sql, now }: DiagnosticSources, _since: number, limit: number): Section {
	const total = Number(rows(sql, "SELECT COUNT(*) AS n FROM pim_approvals WHERE status = 'pending'")[0]!.n);
	const items = rows(sql, "SELECT id, action, summary, created_at, expires_at FROM pim_approvals WHERE status = 'pending' ORDER BY created_at ASC LIMIT ?", limit).map((row) => ({
		id: String(row.id),
		action: String(row.action),
		summary: scrub(String(row.summary), 200),
		asked_at: iso(Number(row.created_at)),
		waiting_minutes: Math.round((now - Number(row.created_at)) / MINUTE),
		expires_at: iso(row.expires_at === null ? null : Number(row.expires_at)),
	}));
	return section(items, total);
}

function events({ events: log }: DiagnosticSources, since: number, limit: number): Section {
	const items = log.since(since, limit);
	return section(items, items.length, `The log keeps the last ${EVENT_KEEP} events.`);
}

const READERS: Record<DiagnosticKind, (sources: DiagnosticSources, since: number, limit: number, chat: string | null) => Section | Promise<Section>> = {
	runs,
	turns,
	triggers,
	model_calls: modelCalls,
	provider_cooldowns: providerCooldowns,
	coding,
	connectors,
	approvals,
	events,
};

export const DEFAULT_LIMIT = 20;
export const MAX_LIMIT = 100;

/** The report: what went wrong since `since`, by kind, each with the most recent `limit` items; `chat` narrows the turns to one chat's. */
export async function diagnose(sources: DiagnosticSources, query: { since?: string; kind?: string; limit?: number; chat?: string }) {
	if (query.kind !== undefined && !(DIAGNOSTIC_KINDS as readonly string[]).includes(query.kind)) throw new Error(`kind must be one of ${DIAGNOSTIC_KINDS.join(", ")}`);
	const since = sinceOf(query.since, sources.now);
	const limit = Math.min(MAX_LIMIT, Math.max(1, Math.floor(query.limit ?? DEFAULT_LIMIT)));
	const kinds = query.kind === undefined ? DIAGNOSTIC_KINDS : [query.kind as DiagnosticKind];
	const found: Record<string, Section> = {};
	for (const kind of kinds) {
		try {
			found[kind] = await READERS[kind](sources, since, limit, query.chat?.trim() || null);
		} catch (error) {
			found[kind] = section([], 0, `Could not be read: ${scrub(error instanceof Error ? error.message : String(error), 120)}`);
		}
	}
	return { generated_at: iso(sources.now), since: iso(since), limit, sections: found };
}
