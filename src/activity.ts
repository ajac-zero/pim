import type { Activity, Turn } from "@pim/shared/activity-types";
export type { Activity } from "@pim/shared/activity-types";

/** Each stall has a key that changes when the thing stalled makes progress and goes quiet again, so a notice is sent once per quiet spell. A quiet command is worth investigating after five minutes, a quiet coding thread after fifteen. */
export function activityOf(turns: readonly Turn[], now: number, options: { running: boolean; startedAt: number; lastOutputAt?: number; coding?: boolean; quietMs?: number; outputByCall?: Readonly<Record<string, number>>; timeoutGraceMs?: number; streamsToolOutput?: boolean }): Activity {
	const turn = turns.at(-1);
	const steps = turn?.steps ?? [];
	const lastActivityAt = Math.max(options.startedAt, options.lastOutputAt ?? 0, ...steps.map((step) => step.at + (step.ms ?? 0)));
	const current = options.running ? steps.flatMap((step) => step.kind === "tool" && step.ms === null && step.approval?.status !== "pending" ? [{ id: step.id, name: step.name, summary: step.summary, startedAt: step.at, elapsedMs: Math.max(0, now - step.at), timeoutMs: step.timeoutMs }] : []) : [];
	const stalls: Activity["stalls"][number][] = [];
	for (const tool of current) {
		// A remote harness mirrors results on a poll, so a command that ended on time may still look pending for a poll or two.
		const timeout = tool.timeoutMs !== null && tool.elapsedMs > tool.timeoutMs + (options.timeoutGraceMs ?? 0);
		const outputAt = options.outputByCall === undefined ? lastActivityAt : options.outputByCall[tool.id] ?? tool.startedAt;
		// A harness that prints nothing until a tool call ends has no output to go quiet: only its declared timeout and the thread's own silence count.
		const quiet = options.streamsToolOutput !== false && now - Math.max(tool.startedAt, outputAt) > (options.quietMs ?? 5 * 60_000);
		if (timeout) stalls.push({ key: `tool:${tool.id}`, reason: "past declared timeout", since: tool.startedAt });
		// Inside its own declared timeout a quiet command is only shown, never woken for.
		else if (quiet) stalls.push({ key: `tool:${tool.id}:${Math.max(tool.startedAt, outputAt)}`, reason: "no output for five minutes", since: tool.startedAt, ...(tool.timeoutMs === null ? {} : { actionable: false as const }) });
	}
	if (options.running && options.coding && now - lastActivityAt > 15 * 60_000) stalls.push({ key: `transcript:${lastActivityAt}`, reason: "running with no transcript activity for fifteen minutes", since: lastActivityAt });
	return { running: options.running, lastActivityAt, current, steps: steps.slice(-120), stalls };
}

/** How long a quiet spell goes on, with no progress at all, before its parent is told once more that it has not ended. */
export const ESCALATED_STALL_MS = 45 * 60_000;
/** The least time between the first notice of a quiet spell and its escalation, so a spell that was long when first seen is not escalated at once. */
const ESCALATION_GAP_MS = 30 * 60_000;

/** The newest sign of life a stall set carries: the thread's last activity, or the output a stall key says it followed. */
export function progressOf(activity: Pick<Activity, "lastActivityAt" | "stalls">): number {
	return Math.max(activity.lastActivityAt, ...activity.stalls.map((stall) => Number(/^(?:tool:.+:|transcript:)(\d+)$/.exec(stall.key)?.[1] ?? 0)));
}

type Episode = { progress_at: number; stage: number; woken_at: number; hard: number };

/** Durable output timestamps, independent of heartbeat and scheduler updates. No command text is stored. */
export class ActivityWatch {
	constructor(readonly sql: SqlStorage) {
		sql.exec("CREATE TABLE IF NOT EXISTS pim_activity (id TEXT PRIMARY KEY, output_at INTEGER NOT NULL)");
		sql.exec("CREATE TABLE IF NOT EXISTS pim_stall_episodes (source TEXT PRIMARY KEY, progress_at INTEGER NOT NULL, stage INTEGER NOT NULL, woken_at INTEGER NOT NULL, hard INTEGER NOT NULL)");
	}
	output(id: string, at: number): void {
		this.sql.exec("INSERT INTO pim_activity (id, output_at) VALUES (?, ?) ON CONFLICT(id) DO UPDATE SET output_at = excluded.output_at", id, at);
	}
	lastOutput(id: string): number {
		return Number(this.sql.exec("SELECT output_at FROM pim_activity WHERE id = ?", id).toArray()[0]?.output_at ?? 0);
	}
	#episode(source: string): Episode | undefined {
		return this.sql.exec<Episode>("SELECT progress_at, stage, woken_at, hard FROM pim_stall_episodes WHERE source = ?", source).toArray()[0];
	}
	/**
	 * Which wake a source's stalls call for, claimed before it is sent so overlapping heartbeat jobs never send it twice: 0 for none, 1 for the first of a quiet
	 * spell, 2 for its one escalation. A spell is the time since the source's last progress; the same spell seen again, or joined by a longer-quiet kind of stall, is
	 * not a new one. It escalates once, when a quiet stall becomes a command past its declared timeout or the silence reaches `ESCALATED_STALL_MS`; after that,
	 * nothing more until progress or `clear`. `previous` restores the claim should the wake fail.
	 */
	episode(source: string, activity: Activity, now: number): { stage: 0 | 1 | 2; previous: Episode | undefined } {
		const actionable = activity.stalls.filter((stall) => stall.actionable !== false);
		const previous = this.#episode(source);
		if (actionable.length === 0) return { stage: 0, previous };
		const progressAt = progressOf(activity);
		const hard = actionable.some((stall) => stall.reason === "past declared timeout") ? 1 : 0;
		let stage: 1 | 2 | 0 = 0;
		if (!previous || progressAt > previous.progress_at) stage = 1;
		else if (previous.stage === 1 && ((hard === 1 && previous.hard === 0) || (now - progressAt >= ESCALATED_STALL_MS && now - previous.woken_at >= ESCALATION_GAP_MS))) stage = 2;
		if (stage !== 0) this.sql.exec("INSERT INTO pim_stall_episodes (source, progress_at, stage, woken_at, hard) VALUES (?, ?, ?, ?, ?) ON CONFLICT(source) DO UPDATE SET progress_at = excluded.progress_at, stage = excluded.stage, woken_at = excluded.woken_at, hard = excluded.hard", source, progressAt, stage, now, hard);
		return { stage, previous };
	}
	restore(source: string, previous: Episode | undefined): void {
		if (previous) this.sql.exec("INSERT OR REPLACE INTO pim_stall_episodes (source, progress_at, stage, woken_at, hard) VALUES (?, ?, ?, ?, ?)", source, previous.progress_at, previous.stage, previous.woken_at, previous.hard);
		else this.clear(source);
	}
	/** A turn ended: the next stall is a new quiet spell. */
	clear(source: string): void {
		this.sql.exec("DELETE FROM pim_stall_episodes WHERE source = ?", source);
	}
}
