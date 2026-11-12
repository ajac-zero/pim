import type { Activity, Turn } from "./activity-types";
export type { Activity } from "./activity-types";

/** A quiet command is worth investigating after five minutes, a quiet coding thread after fifteen. */
export function activityOf(turns: readonly Turn[], now: number, options: { running: boolean; startedAt: number; lastOutputAt?: number; coding?: boolean; quietMs?: number }): Activity {
	const turn = turns.at(-1);
	const steps = turn?.steps ?? [];
	const lastActivityAt = Math.max(options.startedAt, options.lastOutputAt ?? 0, ...steps.map((step) => step.at + (step.ms ?? 0)));
	const current = options.running ? steps.flatMap((step) => step.kind === "tool" && step.ms === null && step.approval?.status !== "pending" ? [{ name: step.name, summary: step.summary, startedAt: step.at, elapsedMs: Math.max(0, now - step.at), timeoutMs: step.timeoutMs }] : []) : [];
	const stalls: { key: string; reason: string; since: number }[] = [];
	for (const tool of current) {
		const timeout = tool.timeoutMs !== null && tool.elapsedMs > tool.timeoutMs;
		const quiet = now - Math.max(tool.startedAt, lastActivityAt) > (options.quietMs ?? 5 * 60_000);
		if (timeout || quiet) stalls.push({ key: `tool:${tool.startedAt}:${tool.name}`, reason: timeout ? "past declared timeout" : "no output for five minutes", since: tool.startedAt });
	}
	if (options.running && options.coding && now - lastActivityAt > 15 * 60_000) stalls.push({ key: `transcript:${options.startedAt}`, reason: "running with no transcript activity for fifteen minutes", since: lastActivityAt });
	return { running: options.running, lastActivityAt, current, steps: steps.slice(-120), stalls };
}

/** Durable output timestamps, independent of heartbeat and scheduler updates. No command text is stored. */
export class ActivityWatch {
	constructor(readonly sql: SqlStorage) {
		sql.exec("CREATE TABLE IF NOT EXISTS pim_activity (id TEXT PRIMARY KEY, output_at INTEGER NOT NULL)");
		sql.exec("CREATE TABLE IF NOT EXISTS pim_stall_notices (id TEXT PRIMARY KEY, at INTEGER NOT NULL)");
	}
	output(id: string, at: number): void {
		this.sql.exec("INSERT INTO pim_activity (id, output_at) VALUES (?, ?) ON CONFLICT(id) DO UPDATE SET output_at = excluded.output_at", id, at);
	}
	/** Claims a notice before waking its parent, so overlapping heartbeat jobs never send it twice. */
	claim(key: string, at: number): boolean {
		return this.sql.exec("INSERT OR IGNORE INTO pim_stall_notices (id, at) VALUES (?, ?) RETURNING id", key, at).toArray().length > 0;
	}
	retry(key: string): void {
		this.sql.exec("DELETE FROM pim_stall_notices WHERE id = ?", key);
	}
	lastOutput(id: string): number {
		return Number(this.sql.exec("SELECT output_at FROM pim_activity WHERE id = ?", id).toArray()[0]?.output_at ?? 0);
	}
}
