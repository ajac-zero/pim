import type { Db } from "./db.ts";

/**
 * How much of PostgreSQL's commit acknowledgement a deployment promises.
 * - `strict`: `synchronous_commit` is `on`, `remote_write` or `remote_apply`, so an acknowledged commit survives a crash
 *   of the primary and, with a synchronous standby named, a failover.
 * - `relaxed`: anything but `off`; the commit is flushed locally.
 */
export type DurabilityProfile = "strict" | "relaxed";

const STRICT = new Set(["on", "remote_write", "remote_apply"]);

/**
 * Refuse to run commit-before-display on a server whose commit acknowledgement is weaker than the deployment declared:
 * with `synchronous_commit = off` a commit can be acknowledged and then lost, and a reply shown to a person would
 * describe a state that no longer exists. Reads the server's setting; returns it.
 */
export async function assertDurability(db: Db, profile: DurabilityProfile): Promise<string> {
	const result = await db.pool.query<{ synchronous_commit: string; standbys: string }>("SELECT current_setting('synchronous_commit') AS synchronous_commit, current_setting('synchronous_standby_names') AS standbys");
	const row = result.rows[0];
	const mode = row?.synchronous_commit ?? "off";
	if (mode === "off" || mode === "false" || (profile === "strict" && !STRICT.has(mode))) {
		throw new Error(`PostgreSQL synchronous_commit is ${mode}, which is weaker than the ${profile} durability profile requires`);
	}
	return mode;
}
