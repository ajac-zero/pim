import { awaitWithContext } from "@earendil-works/chord/context";
import type { Registry, ToolRegistration } from "@earendil-works/pi-durable";

/**
 * Makes every tool stoppable. pi-durable cancels a call's context when its
 * chat is stopped, and then waits for the call to return; a tool that
 * ignores the cancellation, such as one waiting on a Durable Object that
 * never answers, would hold the run, its queue and the Stop itself for good.
 * With the wait cut short by the cancellation, the call ends at once, and
 * whatever the tool was waiting for is left to finish or fail unheard.
 */
export function stoppable<R extends Registry>(registry: R): R {
	const guard = (tool: ToolRegistration): ToolRegistration => ({
		...tool,
		execute: (args, api, context) => {
			const called = Promise.resolve(tool.execute(args, api, context));
			// Called directly, as a test does, a tool has no run to be stopped with.
			return context ? awaitWithContext(called, context) : called;
		},
	});
	return new Proxy(registry, {
		get(target, property) {
			if (property === "install") {
				return (extension: Parameters<Registry["install"]>[0]) => target.install(extension.tools ? { ...extension, tools: extension.tools.map(guard) } : extension);
			}
			const value = Reflect.get(target, property, target);
			return typeof value === "function" ? value.bind(target) : value;
		},
	});
}

/** What names a run: its inputs, which move with it when a continuation takes it over. */
export function runKey(run: { readonly taskId: number; readonly inputs: readonly number[] }): string {
	return run.inputs.length > 0 ? run.inputs.join(",") : String(run.taskId);
}

/**
 * How long runs have gone without progress: for each chat's run, a
 * fingerprint of its live state, since when it has been the same, and since
 * when the run has been seen at work. It is kept in the space's storage, so a
 * restart, which every deploy and crash brings, doesn't start the count over.
 */
export class RunWatch {
	readonly #sql: SqlStorage;

	constructor(sql: SqlStorage) {
		this.#sql = sql;
		sql.exec("CREATE TABLE IF NOT EXISTS pim_run_watch (session TEXT PRIMARY KEY, run TEXT NOT NULL, seen_at INTEGER NOT NULL, fingerprint TEXT NOT NULL, since INTEGER NOT NULL)");
	}

	/**
	 * Notes the state of `session`'s run `run` at `now`, and says for how long
	 * it has been the same. A run that changed starts over, and another run
	 * starts over as seen at work from now.
	 */
	async observe(session: string, run: string, state: string, now: number): Promise<number> {
		const fingerprint = Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(state))), (byte) => byte.toString(16).padStart(2, "0")).join("");
		const seen = this.seen(session);
		if (seen?.run === run && seen.fingerprint === fingerprint) return now - seen.since;
		this.#sql.exec(
			"INSERT INTO pim_run_watch (session, run, seen_at, fingerprint, since) VALUES (?, ?, ?, ?, ?) ON CONFLICT (session) DO UPDATE SET run = excluded.run, seen_at = excluded.seen_at, fingerprint = excluded.fingerprint, since = excluded.since",
			session,
			run,
			seen?.run === run ? seen.seenAt : now,
			fingerprint,
			now,
		);
		return 0;
	}

	/** What was last seen of `session`'s run: which run, since when it was at work, and since when its state was the same. */
	seen(session: string): { run: string; seenAt: number; fingerprint: string; since: number } | undefined {
		const row = this.#sql.exec("SELECT run, seen_at, fingerprint, since FROM pim_run_watch WHERE session = ?", session).toArray()[0];
		return row && { run: String(row.run), seenAt: Number(row.seen_at), fingerprint: String(row.fingerprint), since: Number(row.since) };
	}

	/** Forgets every run not in `sessions`: it ended, or was stopped. */
	keepOnly(sessions: ReadonlySet<string>): void {
		for (const row of this.#sql.exec("SELECT session FROM pim_run_watch").toArray()) {
			if (!sessions.has(String(row.session))) this.#sql.exec("DELETE FROM pim_run_watch WHERE session = ?", row.session);
		}
	}
}
