/**
 * When a subscription's usage limit is used up, v1's way of telling how long to leave it (`src/provider-cooldowns.ts`): until the reset the provider's error gives, such as "try again in 42 min",
 * "try again at 5:32 PM" or a `resets_in_seconds` field; or else a backoff that grows with each limit in a row (5 minutes, 15 minutes, an hour, 3 hours, 6 hours). A reset is kept within
 * a moment from now at the least and a week at the most. The failover (`./provider-failover.ts`) applies it to a plan's models, which stay cooled for that long and go on to the next of the chat's list.
 */
import { QUOTA_MESSAGE } from "@pim/v2-app/quota";

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

/** How long a provider cools down after its first, second, third... usage limit in a row, when it says nothing of when the limit resets. */
export const BACKOFF_MS = [5 * MINUTE, 15 * MINUTE, HOUR, 3 * HOUR, 6 * HOUR] as const;
/** A reset the provider gives is kept within these bounds: a moment from now at the least, a week at the most. */
const MIN_RESET_MS = 1_000;
const MAX_RESET_MS = 7 * DAY;
/** A cooldown that ended this long ago no longer counts toward the next one's backoff. */
export const DECAY_MS = 6 * HOUR;


export function backoffMs(failures: number): number {
	return BACKOFF_MS[Math.min(Math.max(failures, 1), BACKOFF_MS.length) - 1]!;
}


const USAGE_LIMIT =
	/usage[ _-]?limit|usage_not_included|rate[ _-]?limit[ _-]?(?:exceeded|reached)|insufficient[ _-]quota|quota[ _-](?:exceeded|reached|exhausted)|exceeded (?:your|the) (?:current )?quota|hit (?:your|the) (?:usage )?limit|(?:plan|subscription|request|rate) limit (?:has been |was )?reached|too many requests|\b429\b|resets_in_seconds|"resets_at"/i;

/** Whether an error says a subscription's usage or rate limit is used up, rather than that the request was wrong. Pim's own daily limits are not the provider's. */
export function isUsageLimitError(message: string | undefined): boolean {
	return message !== undefined && !message.startsWith(QUOTA_MESSAGE) && USAGE_LIMIT.test(message);
}


const DURATION_PART = /(\d+(?:\.\d+)?)\s*(milliseconds?|ms|seconds?|secs?|s|minutes?|mins?|m|hours?|hrs?|h|days?|d)(?![a-z])\s*,?\s*(?:and\s+)?/iy;

/** The length of time `text` starts with, such as `3 days`, `~42 min`, `1h 30m` or `6m0s`, in milliseconds. */
export function durationMs(text: string): number | undefined {
	const start = /^\s*(?:about\s+|approximately\s+|~\s*)?/i.exec(text)![0].length;
	DURATION_PART.lastIndex = start;
	let total: number | undefined;
	for (let part = DURATION_PART.exec(text); part; part = DURATION_PART.exec(text)) {
		const unit = part[2]!.toLowerCase();
		const ms = unit === "ms" || unit.startsWith("milli") ? 1 : { s: 1000, m: MINUTE, h: HOUR, d: DAY }[unit[0] as "s" | "m" | "h" | "d"];
		total = (total ?? 0) + Number(part[1]) * ms;
	}
	return total;
}


/** An epoch time in seconds or milliseconds, as milliseconds. */
const epochMs = (value: number) => (value < 1e12 ? value * 1000 : value);

/**
 * The time `text` names, such as `2026-11-10T20:00:00Z`, `Nov 11, 2026 3:00 PM UTC`
 * or a bare `5:32 PM`, which is read as UTC, the next time it comes.
 */
function timeOf(text: string, now: number): number | undefined {
	const sentence = text.split(/[;!)\n]|\.(?:\s|$)/)[0]!.trim();
	// The whole sentence, which may be a date with a comma in it, else what comes before its first comma.
	for (const when of [sentence, sentence.split(",")[0]!.trim()]) {
		const parsed = Date.parse(when);
		// A date parsers guess a year for, such as `Nov 11`, can land far off: only the coming days count.
		if (!Number.isNaN(parsed) && parsed > now - DAY && parsed < now + MAX_RESET_MS) return parsed;
		const clock = /^(\d{1,2})(?::(\d{2}))?\s*(am|pm)?\s*(?:utc|gmt|z)?$/i.exec(when);
		if (!clock || (clock[2] === undefined && clock[3] === undefined)) continue;
		let hour = Number(clock[1]);
		const minute = Number(clock[2] ?? 0);
		const meridiem = clock[3]?.toLowerCase();
		if (meridiem) {
			if (hour < 1 || hour > 12) continue;
			hour = (hour % 12) + (meridiem === "pm" ? 12 : 0);
		}
		if (hour > 23 || minute > 59) continue;
		const day = new Date(now);
		const at = Date.UTC(day.getUTCFullYear(), day.getUTCMonth(), day.getUTCDate(), hour, minute);
		return at > now ? at : at + DAY;
	}
	return undefined;
}

/** When an error's text says the limit resets: the fields of the provider's error, or its wording, such as "try again in 42 min" or "try again at 5:32 PM". */
function resetFromMessage(message: string, now: number): number | undefined {
	const at = /"resets?_at"\s*:\s*"?(\d{9,13})/i.exec(message);
	if (at) return epochMs(Number(at[1]));
	const seconds = /"(?:resets_in_seconds|retry_after(?:_seconds)?)"\s*:\s*(\d+(?:\.\d+)?)/i.exec(message) ?? /requested (\d+(?:\.\d+)?)\s*s retry delay/i.exec(message);
	if (seconds) return now + Number(seconds[1]) * 1000;
	const after = /(?:try again|retry|resets?|available again)\s+in\s+([^\n]{1,60})/i.exec(message);
	const wait = after ? durationMs(after[1]!) : undefined;
	if (wait !== undefined) return now + wait;
	const on = /(?:try again|retry|resets?|available again)\s+(?:at|after|on)\s+([^\n]{1,80})/i.exec(message);
	return on ? timeOf(on[1]!, now) : undefined;
}


/** When an error says its limit resets, if it says, kept between a moment and a week from now. */
export function resetAtOf(message: string | undefined, now: number): number | undefined {
	const at = message ? resetFromMessage(message, now) : undefined;
	return at === undefined || Number.isNaN(at) ? undefined : Math.min(Math.max(at, now + MIN_RESET_MS), now + MAX_RESET_MS);
}

/** What a subscription's limits in a row did to its cooldown: when it ends and how many limits in a row brought it on. */
export type LimitState = { until: number; failures: number };

/**
 * The cooldown a usage limit starts or lengthens: requests that fail together count as one limit, so one under way is only made longer, if the error says it resets later; a limit
 * soon after the last cooldown ended is the next of a row, and brings a longer backoff.
 */
export function limitCooldown(previous: LimitState | undefined, message: string | undefined, now: number): LimitState {
	const ongoing = previous !== undefined && previous.until > now;
	const recent = previous !== undefined && previous.until > now - DECAY_MS;
	const failures = ongoing ? previous.failures : recent ? previous.failures + 1 : 1;
	const reset = resetAtOf(message, now);
	if (ongoing && (reset === undefined || reset <= previous.until)) return previous;
	return { until: reset ?? now + backoffMs(failures), failures };
}
