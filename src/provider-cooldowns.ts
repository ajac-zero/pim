import {
	type Api,
	type AssistantMessage,
	type AssistantMessageEvent,
	createAssistantMessageEventStream,
	type Model,
	type ProviderResponse,
	type StreamOptions,
} from "@earendil-works/pi-ai";
import type { Models } from "@earendil-works/pi-ai/models";
import { failedResponse, QUOTA_MESSAGE, wrapStreams } from "./usage";

/**
 * A subscription, such as the ChatGPT plan, answers every request with an
 * error once its usage limit is reached, until the limit resets. Then its
 * provider cools down: until the reset the provider gave, or for a backoff
 * that grows with each limit in a row, its runs go to the deployment's
 * default model instead, without asking the subscription first. The first
 * request that finds the limit fails over at once, before anything of its
 * answer reached the run. Cooldowns are kept in the space's database, so a
 * restart doesn't send runs back to a plan that is still out.
 */

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
/** The longest reason kept. */
const REASON_LENGTH = 500;

export function backoffMs(failures: number): number {
	return BACKOFF_MS[Math.min(Math.max(failures, 1), BACKOFF_MS.length) - 1]!;
}

const USAGE_LIMIT =
	/usage[ _-]?limit|usage_not_included|rate[ _-]?limit[ _-]?(?:exceeded|reached)|insufficient[ _-]quota|quota[ _-](?:exceeded|reached|exhausted)|exceeded (?:your|the) (?:current )?quota|hit (?:your|the) (?:usage )?limit|(?:plan|subscription|request|rate) limit (?:has been |was )?reached|too many requests|\b429\b|resets_in_seconds|"resets_at"/i;

/** Whether an error says a subscription's usage or rate limit is used up, rather than that the request was wrong. Pim's own daily limits are not the provider's. */
export function isUsageLimitError(message: string | undefined): boolean {
	return message !== undefined && !message.startsWith(QUOTA_MESSAGE) && USAGE_LIMIT.test(message);
}

/** A failed request, as far as it is known: its error, and the HTTP answer it got, if any. */
export type Failure = { readonly message?: string; readonly status?: number; readonly headers?: Readonly<Record<string, string>> };

const isUsageLimit = (failure: Failure) => failure.status === 429 || isUsageLimitError(failure.message);

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

/**
 * When the headers say the limit resets: `retry-after-ms` or `retry-after`, else
 * the latest reset of the rate-limit windows that are used up (OpenAI's
 * `x-ratelimit-reset-*` and Codex's `x-codex-*-reset-*`). A window known not
 * to be used up is passed over: its reset is not the one that matters.
 */
function resetFromHeaders(raw: Readonly<Record<string, string>>, now: number): number | undefined {
	const headers = Object.fromEntries(Object.entries(raw).map(([name, value]) => [name.toLowerCase(), value.trim()]));
	const number = (value: string | undefined) => (value !== undefined && value !== "" && Number.isFinite(Number(value)) ? Number(value) : undefined);
	const ms = number(headers["retry-after-ms"]);
	if (ms !== undefined) return now + ms;
	const retryAfter = headers["retry-after"];
	if (retryAfter !== undefined) {
		const seconds = number(retryAfter);
		const date = Date.parse(retryAfter);
		if (seconds !== undefined) return now + seconds * 1000;
		if (!Number.isNaN(date)) return date;
	}
	const resets: number[] = [];
	for (const [name, value] of Object.entries(headers)) {
		const codex = /^x-codex-(.+)-reset-(after-seconds|at)$/.exec(name);
		if (codex) {
			const used = number(headers[`x-codex-${codex[1]}-used-percent`]);
			const amount = number(value);
			if ((used === undefined || used >= 100) && amount !== undefined) resets.push(codex[2] === "at" ? epochMs(amount) : now + amount * 1000);
			continue;
		}
		const openai = /^x-ratelimit-reset(-.+)?$/.exec(name);
		if (openai) {
			const remaining = number(headers[`x-ratelimit-remaining${openai[1] ?? ""}`]);
			if (remaining !== undefined && remaining > 0) continue;
			const amount = number(value);
			const reset = amount === undefined ? durationMs(value) : amount > 1e9 ? epochMs(amount) - now : amount * 1000;
			if (reset !== undefined) resets.push(now + reset);
		}
	}
	return resets.length > 0 ? Math.max(...resets) : undefined;
}

/** When a failure says its limit resets, if it says, kept between a moment and a week from now. */
export function resetAtOf(failure: Failure, now: number): number | undefined {
	const first = failure.headers && resetFromHeaders(failure.headers, now);
	const at = first ?? (failure.message ? resetFromMessage(failure.message, now) : undefined);
	return at === undefined || Number.isNaN(at) ? undefined : Math.min(Math.max(at, now + MIN_RESET_MS), now + MAX_RESET_MS);
}

/** A provider's cooldown: since when and until when its runs go elsewhere, why, and how many limits in a row brought it on. */
export type Cooldown = {
	readonly provider: string;
	readonly since: number;
	readonly until: number;
	readonly reason: string;
	readonly failures: number;
	/** Whether `until` is the reset the provider gave, or Pim's backoff. */
	readonly resetFrom: "provider" | "backoff";
};

const SCHEMA = `
CREATE TABLE IF NOT EXISTS pim_provider_cooldowns (
	provider TEXT PRIMARY KEY,
	since INTEGER NOT NULL,
	until INTEGER NOT NULL,
	reason TEXT NOT NULL,
	failures INTEGER NOT NULL,
	reset_from TEXT NOT NULL
);`;

/** The space's providers' cooldowns, in its database, with a copy in memory, since every model request reads them. */
export class ProviderCooldowns {
	readonly #sql: SqlStorage;
	readonly #rows = new Map<string, Cooldown>();

	constructor(sql: SqlStorage) {
		this.#sql = sql;
		sql.exec(SCHEMA);
		for (const row of sql.exec("SELECT provider, since, until, reason, failures, reset_from FROM pim_provider_cooldowns").toArray()) {
			const provider = String(row.provider);
			this.#rows.set(provider, {
				provider,
				since: Number(row.since),
				until: Number(row.until),
				reason: String(row.reason),
				failures: Number(row.failures),
				resetFrom: row.reset_from === "provider" ? "provider" : "backoff",
			});
		}
	}

	/** The provider's cooldown while it lasts. */
	active(provider: string, now = Date.now()): Cooldown | undefined {
		const cooldown = this.#rows.get(provider);
		return cooldown && cooldown.until > now ? cooldown : undefined;
	}

	/** Every cooldown kept, the ones that ended without the provider answering since included, latest first. */
	list(): Cooldown[] {
		return [...this.#rows.values()].sort((a, b) => b.until - a.until);
	}

	/**
	 * Cools the provider down after a failed request, when the failure is its
	 * usage limit, and answers the cooldown; else changes nothing. Requests that
	 * fail together count as one limit: the cooldown under way is only made
	 * longer, if the provider says so.
	 */
	failed(provider: string, failure: Failure, now = Date.now()): Cooldown | undefined {
		if (!isUsageLimit(failure)) return undefined;
		const previous = this.#rows.get(provider);
		const ongoing = previous !== undefined && previous.until > now;
		const recent = previous !== undefined && previous.until > now - DECAY_MS;
		const failures = ongoing ? previous.failures : recent ? previous.failures + 1 : 1;
		const reset = resetAtOf(failure, now);
		// Under way, only a later reset the provider gives changes the cooldown: a backoff was counted when it began.
		if (ongoing && (reset === undefined || reset <= previous.until)) return previous;
		const cooldown: Cooldown = {
			provider,
			since: ongoing ? previous.since : now,
			until: reset ?? now + backoffMs(failures),
			reason: (failure.message ?? `HTTP ${failure.status}`).slice(0, REASON_LENGTH),
			failures,
			resetFrom: reset === undefined ? "backoff" : "provider",
		};
		this.#sql.exec(
			"INSERT INTO pim_provider_cooldowns (provider, since, until, reason, failures, reset_from) VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT (provider) DO UPDATE SET since = excluded.since, until = excluded.until, reason = excluded.reason, failures = excluded.failures, reset_from = excluded.reset_from",
			provider,
			cooldown.since,
			cooldown.until,
			cooldown.reason,
			cooldown.failures,
			cooldown.resetFrom,
		);
		this.#rows.set(provider, cooldown);
		return cooldown;
	}

	/**
	 * Forgets the provider's cooldown, and its count of limits, once a request
	 * it answered shows it works again. A request sent before the cooldown began
	 * shows nothing: it may have been under way when the limit was reached.
	 */
	succeeded(provider: string, sentAt: number): void {
		const cooldown = this.#rows.get(provider);
		if (!cooldown || sentAt < cooldown.since) return;
		this.#sql.exec("DELETE FROM pim_provider_cooldowns WHERE provider = ?", provider);
		this.#rows.delete(provider);
	}
}

export type FailoverOptions = {
	readonly cooldowns: ProviderCooldowns;
	/** Whether a provider is a subscription whose usage limit sends its runs elsewhere, such as the ChatGPT plan. */
	readonly subscription: (provider: string) => boolean;
	/** The model a subscription's runs go to while it cools down, or none, when there is no other to use. */
	readonly fallback: (provider: string) => Model<Api> | undefined;
	/** Told when a provider starts cooling down, or its cooldown grows. */
	readonly cooled?: (cooldown: Cooldown) => void;
	readonly now?: () => number;
};

/**
 * `models` with subscriptions' requests failing over: a request to one that
 * is cooling down goes to the fallback model instead, and one that finds the
 * usage limit cools it down and asks the fallback model, unless part of the
 * answer had already reached the run. Without a fallback, the error is the
 * answer, as before.
 */
export function failingOver(models: Models, options: FailoverOptions): Models {
	const now = options.now ?? Date.now;
	return wrapStreams(models, (stream) => (model, context, streamOptions) => {
		if (!options.subscription(model.provider)) return stream(model, context, streamOptions);
		const fallback = options.cooldowns.active(model.provider, now()) ? options.fallback(model.provider) : undefined;
		if (fallback) return stream(fallback, context, streamOptions);
		const given = streamOptions as StreamOptions | undefined;
		let response: ProviderResponse | undefined;
		// The status and headers of the last HTTP answer: providers on an SDK only throw on a failed one, so its fetch is watched too.
		const send = given?.fetch ?? ((input, init) => fetch(input, init));
		const watched: StreamOptions = {
			...given,
			fetch: async (input, init) => {
				const answer = await send(input, init);
				response = { status: answer.status, headers: Object.fromEntries(answer.headers) };
				return answer;
			},
			onResponse: (answer, answered) => {
				response = answer;
				return given?.onResponse?.(answer, answered);
			},
		};
		const sentAt = now();
		const first = stream(model, context, watched);
		const out = createAssistantMessageEventStream();
		void (async () => {
			// The answer's start is held back until something follows it: a failure that follows at once can still go elsewhere.
			let start: AssistantMessageEvent | undefined;
			let end: AssistantMessageEvent | undefined;
			let forwarded = false;
			let message: AssistantMessage;
			try {
				for await (const event of first) {
					if (event.type === "done" || event.type === "error") end = event;
					else if (!forwarded && event.type === "start") start = event;
					else {
						if (!forwarded && start) out.push(start);
						forwarded = true;
						out.push(event);
					}
				}
				message = await first.result();
			} catch (error) {
				message = failedResponse(model, error instanceof Error ? error.message : String(error), now());
				end = { type: "error", reason: "error", error: message };
			}
			if (message.stopReason === "error") {
				const before = options.cooldowns.active(model.provider, now());
				const cooldown = options.cooldowns.failed(model.provider, { message: message.errorMessage, status: response?.status, headers: response?.headers }, now());
				if (cooldown && cooldown !== before) options.cooled?.(cooldown);
				const other = cooldown && !forwarded && !given?.signal?.aborted ? options.fallback(model.provider) : undefined;
				if (other) {
					try {
						const second = stream(other, context, streamOptions);
						for await (const event of second) out.push(event);
						out.end(await second.result());
						return;
					} catch (error) {
						console.warn(JSON.stringify({ event: "pim.failover_failed", provider: other.provider, model: other.id, error: String(error).slice(0, 500) }));
					}
				}
			} else if (message.stopReason !== "aborted") {
				options.cooldowns.succeeded(model.provider, sentAt);
			}
			if (!forwarded && start) out.push(start);
			out.push(
				end ??
					(message.stopReason === "error" || message.stopReason === "aborted"
						? { type: "error", reason: message.stopReason, error: message }
						: ({ type: "done", reason: message.stopReason, message } as AssistantMessageEvent)),
			);
			out.end(message);
		})();
		return out;
	});
}
