// When a failed turn is tried again by itself: provider trouble, a rate limit, a connection that dropped, a sandbox that didn't answer (v1's rules, so people see the same behaviour).

const RETRY_PREFIX = "retry-";
const RETRY_BASE_MS = 30_000;
const RETRY_JITTER_MS = 30_000;
const RATE_LIMIT_RETRIES = 6;
const RATE_LIMIT_RETRY_BASE_MS = 60_000;
const RATE_LIMIT_RETRY_GROWTH = 1.5;
const RATE_LIMIT_RETRY_MAX_MS = 5 * 60_000;
const RATE_LIMIT_RETRY_JITTER_MS = 10_000;

/** What an error says when a provider's per-minute cap stopped a turn: a limit the whole account shares, so one thread's backoff outlasts it. */
export const RATE_LIMIT_ERROR = /rate.?limit|\b429\b|too many requests|per min/i;
/** Errors a retry can't help: the credentials, the request, the budget or the person. */
const PERMANENT_ERROR = /unauthori[sz]ed|forbidden|authenticat|invalid[ _-]?(api[ _-]?key|request|token|param)|api key|permission|budget|usage limit|quota|credit|billing|context (length|window)|too (long|large)|not found|\b(40[0-9]|41[0-9]|42[0-8]|4[3-9][0-9])\b/i;
/** Errors that come and go: provider trouble, rate limits and a connection that dropped. */
const TRANSIENT_ERROR = /\b(429|5\d\d)\b|rate.?limit|too many requests|overload|server error|bad gateway|unavailable|temporar|timed? ?out|timeout|no progress|network|connection|websocket|socket|ECONN\w*|ETIMEDOUT|EAI_AGAIN|fetch failed|capacity|internal error|try again|manager|workspace|container|sandbox/i;

/** Whether a failed turn's error is worth a retry: it reads as transient and not as permanent (a 429 is both, and counts as transient). */
export function isTransient(detail: string | null | undefined): boolean {
	const text = detail ?? "";
	if (PERMANENT_ERROR.test(text) && !/\b429\b/.test(text)) return false;
	return TRANSIENT_ERROR.test(text);
}

/** How many retries in a row an operation already is, counted by the `retry-` prefix and its numeral (`retry-<root>-<n>`); a turn that succeeds starts the count over with a new id. */
export const retryCount = (operation: string): number => (operation.startsWith(RETRY_PREFIX) ? Number(/-(\d+)$/.exec(operation)?.[1] ?? 1) : 0);

/** A provider's `retry-after` as an error's words give it, in ms; null when it names no plain count of seconds. */
export const retryAfterMs = (error: string): number | null => {
	const seconds = /retry[ _-]?after["':= ]*["']?(\d+)/i.exec(error)?.[1];
	return seconds ? Number(seconds) * 1000 : null;
};

/** The retry a failed turn gets: how many times in a row it may be retried, and how long the next one waits (a rate limit waits longer and is retried more often). Null when it is not retried. */
export function retryPlan(operation: string, detail: string | null | undefined, baseMs?: number): { attempt: number; delayMs: number } | null {
	if (!isTransient(detail)) return null;
	const error = detail ?? "";
	const rateLimited = RATE_LIMIT_ERROR.test(error);
	const attempt = retryCount(operation) + 1;
	if (attempt > (rateLimited ? RATE_LIMIT_RETRIES : 1)) return null;
	if (baseMs !== undefined) return { attempt, delayMs: baseMs };
	const backoff = rateLimited ? Math.min(RATE_LIMIT_RETRY_BASE_MS * RATE_LIMIT_RETRY_GROWTH ** (attempt - 1), RATE_LIMIT_RETRY_MAX_MS) + Math.random() * RATE_LIMIT_RETRY_JITTER_MS : RETRY_BASE_MS + Math.random() * RETRY_JITTER_MS;
	return { attempt, delayMs: Math.max(backoff, rateLimited ? (retryAfterMs(error) ?? 0) : 0) };
}
