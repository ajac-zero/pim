/**
 * How much of what a chat's model read came from the prompt cache, and the per-call history the cost meter lists. Both are computed from the
 * model-call ledger's rows (`pim_app.model_calls`), whose `input_tokens` are the uncached input and whose cache tiers are kept apart.
 */

/** The tokens of one ledger row or of a sum of rows. */
export type CallTokens = { input: number; cacheRead: number; cacheWrite: number };

/**
 * The share of all input tokens (uncached, cache-read and cache-write) that were read from the cache. Null when nothing was read or written
 * to the cache, which is also what a provider that reports no cache looks like: the ledger cannot tell that from a full miss, so it makes no claim.
 */
export function cacheHitRatio({ input, cacheRead, cacheWrite }: CallTokens): number | null {
	const total = input + cacheRead + cacheWrite;
	return total > 0 && cacheRead + cacheWrite > 0 ? cacheRead / total : null;
}

/** The most turns the history lists. */
export const MAX_TURN_HISTORY = 50;

export type TurnUsage = { id: string; at: string; model: string; input: number; cacheRead: number; cacheWrite: number; output: number; hitRatio: number | null; cost: number };

/** What the ledger returns for a call; the cache columns are null or missing on rows from before they were kept. */
export type CallRow = { id: string; at: Date | string; model?: string | null; input_tokens?: unknown; output_tokens?: unknown; cache_read_tokens?: unknown; cache_write_tokens?: unknown; cost_microusd?: unknown };

const count = (value: unknown) => {
	const n = Number(value ?? 0);
	return Number.isFinite(n) && n > 0 ? n : 0;
};

/** The calls' history, newest first and at most `limit` long; a call that used no tokens (one that failed before it started) is left out. */
export function turnHistory(rows: readonly CallRow[], limit = MAX_TURN_HISTORY): TurnUsage[] {
	return rows
		.map((r) => {
			const tokens = { input: count(r.input_tokens), cacheRead: count(r.cache_read_tokens), cacheWrite: count(r.cache_write_tokens) };
			return { id: r.id, at: new Date(r.at).toISOString(), model: r.model ?? "", ...tokens, output: count(r.output_tokens), hitRatio: cacheHitRatio(tokens), cost: count(r.cost_microusd) / 1e6 };
		})
		.filter((t) => t.input + t.cacheRead + t.cacheWrite + t.output > 0)
		.sort((a, b) => (a.at < b.at ? 1 : a.at > b.at ? -1 : a.id < b.id ? 1 : -1))
		.slice(0, Math.max(0, limit));
}
