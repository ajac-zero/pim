/**
 * What went wrong with the space's triggers lately, read straight from the
 * triggers' tables for the admin's majordomo (../diagnostics.ts): triggers
 * whose source isn't healthy, runs that failed or were never handed on, and
 * deliveries that failed. Scheduled tasks are triggers, so they are here too.
 * It only reads. The tables exist only where triggers are on.
 */

export type TriggerFailure = Readonly<Record<string, string | number | null>>;

type Row = Record<string, SqlStorageValue>;

const iso = (ms: SqlStorageValue | undefined) => new Date(Number(ms)).toISOString();
const exists = (sql: SqlStorage, table: string) => sql.exec("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?", table).toArray().length > 0;
const text = (value: SqlStorageValue | undefined) => (value === null ? null : String(value));

/** The newest failures since `since`, unhealthy triggers first; `error` texts are as stored, for the caller to scrub. */
export function triggerFailures(sql: SqlStorage, since: number, limit: number): TriggerFailure[] {
	if (!exists(sql, "pim_triggers")) return [];
	const all = (query: string, ...bindings: SqlStorageValue[]): Row[] => sql.exec(query, ...bindings).toArray();
	const unhealthy = all(
		"SELECT id, lifecycle, health, health_detail, updated_at FROM pim_triggers WHERE lifecycle != 'deleted' AND health NOT IN ('healthy', 'unknown') ORDER BY updated_at DESC LIMIT ?",
		limit,
	).map((row) => ({ source: "trigger_health", trigger: String(row.id), lifecycle: String(row.lifecycle), health: String(row.health), error: text(row.health_detail), at: iso(row.updated_at) }));
	const runs = exists(sql, "pim_trigger_runs")
		? all(
				`SELECT operation_id, trigger_id, phase, last_error, deferrals, unknown_answers, scheduled_for, updated_at FROM pim_trigger_runs
				WHERE updated_at >= ? AND (phase IN ('failed', 'not_submitted') OR last_error IS NOT NULL) ORDER BY updated_at DESC LIMIT ?`,
				since,
				limit,
			).map((row) => ({
				source: "trigger_run",
				run: String(row.operation_id),
				trigger: String(row.trigger_id),
				phase: String(row.phase),
				error: text(row.last_error),
				deferrals: Number(row.deferrals),
				unknown_answers: Number(row.unknown_answers),
				scheduled_for: iso(row.scheduled_for),
				at: iso(row.updated_at),
			}))
		: [];
	const deliveries = exists(sql, "pim_trigger_outbox")
		? all("SELECT trigger_id, attempts, last_error, updated_at FROM pim_trigger_outbox WHERE last_error IS NOT NULL AND updated_at >= ? ORDER BY updated_at DESC LIMIT ?", since, limit).map((row) => ({
				source: "trigger_outbox",
				trigger: String(row.trigger_id),
				attempts: Number(row.attempts),
				error: text(row.last_error),
				at: iso(row.updated_at),
			}))
		: [];
	return [...unhealthy, ...runs, ...deliveries];
}
