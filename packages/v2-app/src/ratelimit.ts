import { createHash } from "node:crypto";
import type { Db } from "./db.ts";

/**
 * The application's own limits: how many times something may happen in a window, counted in PostgreSQL so every Gate process shares one count.
 * A key is a digest (of an address or an owner id), so the table names no one. The first hit of a window opens it; a hit after it ends starts the next.
 */
export class RateLimits {
	constructor(private readonly db: Db) {}

	/** Counts one hit against `limit` per `windowMs` for `key`; false when this hit is over the limit (it is counted, so a client that keeps trying stays limited). */
	async hit(name: string, key: string, limit: number, windowMs: number): Promise<boolean> {
		const digest = createHash("sha256").update(`pim-rate\n${key}`).digest("hex").slice(0, 32);
		const hits = await this.db.anonymous(async (tx) => {
			const r = await tx.query(
				`INSERT INTO pim_app.rate_limits (name, key, window_ends, hits) VALUES ($1, $2, now() + ($3 || ' milliseconds')::interval, 1)
				 ON CONFLICT (name, key) DO UPDATE SET
				   hits = CASE WHEN rate_limits.window_ends <= now() THEN 1 ELSE rate_limits.hits + 1 END,
				   window_ends = CASE WHEN rate_limits.window_ends <= now() THEN now() + ($3 || ' milliseconds')::interval ELSE rate_limits.window_ends END
				 RETURNING hits`,
				[name, digest, String(windowMs)],
			);
			if (Math.random() < 0.01) await tx.query("DELETE FROM pim_app.rate_limits WHERE window_ends < now() - interval '1 hour'");
			return r.rows[0].hits as number;
		});
		return hits <= limit;
	}
}
