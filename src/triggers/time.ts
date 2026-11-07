/**
 * When a time trigger fires: one computation of a time source's firings,
 * shared by what checks a schedule when it is saved, what shows the next
 * firings to the person, and what decides which firing is due. Nothing in
 * Pim uses it yet; see docs/triggers.md.
 *
 * Everything here is pure: it takes the clock's reading (`now`) and the
 * trigger's durable watermark (`after`) as arguments, and reads nothing else
 * but the runtime's time zone data. Admitting a firing stays the store's
 * (`TriggerStore.admitTimeFiring` in ./store.ts).
 *
 * A cron expression is read in its time zone. A local time the expression
 * names that doesn't exist that day, because clocks skip it, is skipped. A
 * local time that happens twice, because clocks go back, fires once, at its
 * first instant; its second instant is never a firing, so no restart or
 * preview that begins between the two can bring it back.
 *
 * Time zone offsets come from the runtime's `Intl` data, as the Temporal
 * polyfill reads them: the offset at an instant is what `Intl` shows there,
 * and a local time is resolved by trying the offsets a day before and a day
 * after it. That relies on a zone changing its offset at most once in any
 * three days, which holds for every zone from 2000 to 2115 (the closest two
 * changes are almost seven days apart).
 */

import { type CronFields, TRIGGER_DEFAULTS, TRIGGER_LIMITS, type TimeSource, cronFields, parseTimeZone } from "./spec";
import { TriggerValidationError, integer } from "./validate";

const SECOND = 1_000;
const MINUTE = 60 * SECOND;
const DAY = 24 * 60 * MINUTE;

export const TIME_LIMITS = {
	/**
	 * How far a search for a cron expression's firings looks, forward or
	 * back, in days: just over 12 years. That finds every expression whose
	 * days may match either day field, the 29th of February included (8 years
	 * apart around 2100), and a date on one day of the week (at most 11 years
	 * apart). A rarer expression, such as the 29th of February on a Sunday,
	 * has no firing within it.
	 */
	horizonDays: 4_400,
	/** Firings a preview shows by default, and at most. */
	previewCount: 3,
	maxPreviewCount: 10,
	/** Skipped local times a preview lists; it counts all of them. */
	skippedListed: 5,
} as const;

/** How far back selecting a cron expression's due firing looks, a little inside the horizon so every search it makes covers it. */
const LOOKBACK_MS = (TIME_LIMITS.horizonDays - 2) * DAY;

/**
 * An instant as read in a time zone. `local` is the date and time on the
 * clock there (`2026-11-01T01:30:00`, with milliseconds only when there are
 * some) and `offset` its offset from UTC (`-04:00`), so `local + offset` is
 * the instant in RFC 3339.
 */
export type ZonedTime = { readonly at: number; readonly timeZone: string; readonly local: string; readonly offset: string };

/** A local time a cron expression names that doesn't exist on its day, because clocks skip it. */
export type SkippedTime = { readonly timeZone: string; readonly local: string };

export type Preview = {
	/** The next firings after `now`, in order. */
	readonly firings: ZonedTime[];
	/** Local times skipped between `now` and the last firing shown, up to `TIME_LIMITS.skippedListed` of them. */
	readonly skipped: SkippedTime[];
	readonly skippedCount: number;
	/** Fewer firings than asked for: a one-time trigger whose time is past, or a cron expression with no more within the horizon. */
	readonly exhausted: boolean;
};

/** Firings older than the selected one, after the watermark, which won't run. */
export type OlderFirings = {
	readonly count: number;
	readonly first: number;
	readonly last: number;
	/** False when the watermark is further back than the horizon, so only the firings within it were counted. */
	readonly complete: boolean;
};

/**
 * The firing to admit now, if any. `due` is admitted to run: `now` is no
 * later than `deadline`, which is the firing's time plus the source's
 * lateness (`maxLatenessMs` or `catchUpMs`), inclusive. `missed` is past it,
 * and is admitted to be recorded as missed. The deadline depends only on
 * the firing, so retrying its delivery never moves it. `next` is the first
 * firing after `now`, for setting the next alarm.
 */
export type DueSelection =
	| { readonly status: "none"; readonly next: number | null }
	| { readonly status: "due" | "missed"; readonly scheduledFor: number; readonly deadline: number; readonly older: OlderFirings | null; readonly next: number | null };

/**
 * A local date and time, resolved in a time zone. It may name one instant,
 * two (when clocks go back), or none (when clocks skip it); the caller
 * chooses, and nothing here chooses for it. A nonexistent time's
 * `suggestion` is the same time moved later by the length of the skip, as
 * clocks would read it (02:30 on a day that skips 02:00 to 03:00 suggests
 * 03:30).
 */
export type LocalResolution =
	| { readonly kind: "unique"; readonly time: ZonedTime }
	| { readonly kind: "ambiguous"; readonly earlier: ZonedTime; readonly later: ZonedTime }
	| { readonly kind: "nonexistent"; readonly timeZone: string; readonly local: string; readonly suggestion: ZonedTime };

/**
 * The next firings of a time source after `now`, as the person would read
 * them: a cron expression's in its own time zone, the others' in `timeZone`
 * (UTC by default). Throws a `TriggerValidationError` for an input it can't
 * take. A cron expression whose preview has no firings has none within the
 * horizon, and should be refused when it is saved.
 */
export function previewFirings(source: TimeSource, input: { now: number; count?: number; timeZone?: string }): Preview {
	const schedule = scheduleOf(source);
	const now = instant(input.now, "now");
	const count = input.count === undefined ? TIME_LIMITS.previewCount : integer(input.count, "count", 1, TIME_LIMITS.maxPreviewCount);
	if (schedule instanceof CronSchedule && input.timeZone !== undefined) throw new TriggerValidationError("timeZone", "a cron expression is shown in its own time zone");
	const zone = schedule instanceof CronSchedule ? schedule.clock : clockOf(input.timeZone === undefined ? "UTC" : parseTimeZone(input.timeZone, "timeZone"));
	const skipped = { listed: [] as SkippedTime[], count: 0 };
	const firings = schedule.after(now, count, skipped);
	return { firings: firings.map((at) => zone.describe(at)), skipped: skipped.listed, skippedCount: skipped.count, exhausted: firings.length < count };
}

/**
 * Which firing of a time source is due at `now`, given `after`, the instant
 * after which firings count: the trigger's durable watermark (the last
 * firing it admitted), or before its first firing, the instant before it was
 * enabled. A firing at or before `after` is never selected again, so a
 * restart can't replay one. Of the firings after `after` and at or before
 * `now`, only the latest is selected; the older ones are summarized, never
 * listed.
 */
export function selectDueFiring(source: TimeSource, input: { now: number; after: number }): DueSelection {
	const schedule = scheduleOf(source);
	const now = instant(input.now, "now");
	// Exclusive, so it may be one millisecond before the first supported instant, for a firing at that instant to count.
	const after = integer(input.after, "after", TRIGGER_LIMITS.earliestAt - 1, TRIGGER_LIMITS.latestAt);
	const next = schedule.after(now, 1)[0] ?? null;
	// Only a cron expression's firings are searched for; the others' are worked out, however far back.
	const from = source.schedule === "cron" ? Math.max(after, now - LOOKBACK_MS) : after;
	const latest = after >= now ? null : schedule.atOrBefore(now, from);
	if (latest === null) return { status: "none", next };
	const deadline = latest + (source.schedule === "once" ? source.maxLatenessMs : source.catchUpMs);
	let older: OlderFirings | null = null;
	const first = schedule.after(from, 1)[0]!;
	if (first < latest) {
		const last = schedule.atOrBefore(latest - 1, first - 1)!;
		older = { count: schedule.count(first, last), first, last, complete: from === after };
	}
	return { status: now <= deadline ? "due" : "missed", scheduledFor: latest, deadline, older, next };
}

/** Whether `at` is a firing of the source: what a scheduler checks before it admits a firing it was handed. */
export function isScheduledFiring(source: TimeSource, at: number): boolean {
	const schedule = scheduleOf(source);
	const time = instant(at, "at");
	return schedule.after(time - 1, 1)[0] === time;
}

/** An instant as read in a time zone. */
export function describeInstant(at: number, timeZone: string): ZonedTime {
	return clockOf(parseTimeZone(timeZone, "timeZone")).describe(instant(at, "at"));
}

/**
 * Resolves a local date and time (`2026-11-01T01:30`, seconds optional) in
 * a time zone, for a one-time trigger a person sets on their own clock. It
 * applies no cron rule: an ambiguous or nonexistent time is returned as
 * such, for the caller to ask about.
 */
export function resolveLocalTime(local: string, timeZone: string): LocalResolution {
	const zone = clockOf(parseTimeZone(timeZone, "timeZone"));
	const match = typeof local === "string" ? /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2}))?$/.exec(local) : null;
	if (!match) throw new TriggerValidationError("local", "must be a local date and time such as 2026-11-01T01:30");
	const [year, month, day, hour, minute, second] = match.slice(1).map((part) => (part === undefined ? 0 : Number(part))) as [number, number, number, number, number, number];
	if (year < 2000 || year > 2100) throw new TriggerValidationError("local", "must be from 2000 to 2100");
	const wall = Date.UTC(year, month - 1, day, hour, minute, second);
	const date = new Date(wall);
	if (date.getUTCFullYear() !== year || date.getUTCMonth() !== month - 1 || date.getUTCDate() !== day || hour > 23 || minute > 59 || second > 59) {
		throw new TriggerValidationError("local", "is not a date and time that exists on a calendar");
	}
	const candidates = zone.resolve(wall);
	const result: LocalResolution =
		candidates.length === 0
			? { kind: "nonexistent", timeZone: zone.timeZone, local: formatLocal(wall), suggestion: zone.describe(wall - zone.offset(wall - DAY)) }
			: candidates.length === 1
				? { kind: "unique", time: zone.describe(candidates[0]!) }
				: { kind: "ambiguous", earlier: zone.describe(candidates[0]!), later: zone.describe(candidates[1]!) };
	const instants = result.kind === "unique" ? [result.time] : result.kind === "ambiguous" ? [result.earlier, result.later] : [result.suggestion];
	if (instants.some((time) => time.at < TRIGGER_LIMITS.earliestAt || time.at > TRIGGER_LIMITS.latestAt)) throw new TriggerValidationError("local", "must be from 2000 to 2100");
	return result;
}

// Schedules

type Skipped = { listed: SkippedTime[]; count: number };

type Schedule = {
	/** Up to `limit` firings after `time`, in order, noting local times skipped before the last of them. */
	after(time: number, limit: number, skipped?: Skipped): number[];
	/** The latest firing at or before `time` and after `floor`, or null. */
	atOrBefore(time: number, floor: number): number | null;
	/** How many firings are from `first` to `last`, both firings. */
	count(first: number, last: number): number;
};

function instant(value: unknown, path: string): number {
	return integer(value, path, TRIGGER_LIMITS.earliestAt, TRIGGER_LIMITS.latestAt);
}

/** The source's schedule, checked again here, since a caller may hand in a source that wasn't read by `parseTriggerSpec`. */
function scheduleOf(source: TimeSource): Schedule {
	if (typeof source !== "object" || source === null || source.kind !== "time") throw new TriggerValidationError("source", "must be a time source");
	switch (source.schedule) {
		case "once": {
			const at = instant(source.at, "source.at");
			integer(source.maxLatenessMs, "source.maxLatenessMs", 0, TRIGGER_DEFAULTS.maxLatenessMs);
			return {
				after: (time, limit) => (at > time && limit > 0 ? [at] : []),
				atOrBefore: (time, floor) => (at <= time && at > floor ? at : null),
				count: (first, last) => (first <= at && at <= last ? 1 : 0),
			};
		}
		case "interval": {
			const every = integer(source.everyMs, "source.everyMs", TRIGGER_DEFAULTS.minIntervalMs, TRIGGER_DEFAULTS.maxIntervalMs);
			const anchor = instant(source.anchorAt, "source.anchorAt");
			integer(source.catchUpMs, "source.catchUpMs", 0, TRIGGER_DEFAULTS.maxLatenessMs);
			// The anchor and every instant asked about are within 2000 to 2100, and a step is at least a minute, so these stay far below 2^53.
			return {
				after: (time, limit) => {
					const first = time < anchor ? anchor : anchor + (Math.floor((time - anchor) / every) + 1) * every;
					return Array.from({ length: limit }, (_, index) => first + index * every);
				},
				atOrBefore: (time, floor) => {
					if (time < anchor) return null;
					const latest = anchor + Math.floor((time - anchor) / every) * every;
					return latest > floor ? latest : null;
				},
				count: (first, last) => (last - first) / every + 1,
			};
		}
		case "cron": {
			integer(source.catchUpMs, "source.catchUpMs", 0, TRIGGER_DEFAULTS.maxLatenessMs);
			return new CronSchedule(cronFields(source.expression, "source.expression"), clockOf(parseTimeZone(source.timeZone, "source.timeZone")));
		}
		default:
			throw new TriggerValidationError("source.schedule", "must be once, cron or interval");
	}
}

/**
 * A cron expression in its time zone. It walks local calendar days, skipping
 * months the expression leaves out, and resolves only the times of days that
 * match, so a search is bounded by the horizon's days, never by its minutes.
 * Each local time maps to at most one instant, and later local times to
 * later instants, which is what lets it search forward and back.
 */
class CronSchedule implements Schedule {
	readonly clock: ZoneClock;
	readonly #fields: CronFields;
	/** Minutes after local midnight the expression names, in order. */
	readonly #times: number[];

	constructor(fields: CronFields, clock: ZoneClock) {
		this.#fields = fields;
		this.clock = clock;
		const hours = [...fields.hours].sort((a, b) => a - b);
		const minutes = [...fields.minutes].sort((a, b) => a - b);
		this.#times = hours.flatMap((hour) => minutes.map((minute) => hour * 60 + minute));
	}

	after(time: number, limit: number, skipped?: Skipped): number[] {
		const found: number[] = [];
		if (limit <= 0) return found;
		// A local time before the one `time` reads as fired before `time`, so the search starts on that day.
		const start = localDay(this.clock.wall(time));
		// Skipped local times, with the instant clocks skip them at.
		const pending: { local: number; at: number }[] = [];
		for (let day = start; day <= start + TIME_LIMITS.horizonDays; day++) {
			const skip = this.#monthSkip(day, 1);
			if (skip !== null) {
				day = skip - 1;
				continue;
			}
			if (!this.#matches(day)) continue;
			const span = this.clock.span(day);
			for (const minutes of this.#times) {
				const local = day * DAY + minutes * MINUTE;
				const at = firing(local, span);
				if (at === null) {
					if (span.change! > time) pending.push({ local, at: span.change! });
					continue;
				}
				if (at <= time) continue;
				found.push(at);
				if (found.length === limit) {
					if (skipped) note(skipped, pending, this.clock.timeZone, at);
					return found;
				}
			}
		}
		if (skipped) note(skipped, pending, this.clock.timeZone, Number.POSITIVE_INFINITY);
		return found;
	}

	atOrBefore(time: number, floor: number): number | null {
		// From the day after, in case a repeated hour reaches back across midnight: then a local time on the next day can have fired already.
		const start = localDay(this.clock.wall(time)) + 1;
		const end = Math.max(start - TIME_LIMITS.horizonDays, localDay(floor) - 2);
		for (let day = start; day >= end; day--) {
			const skip = this.#monthSkip(day, -1);
			if (skip !== null) {
				day = skip + 1;
				continue;
			}
			if (!this.#matches(day)) continue;
			const span = this.clock.span(day);
			for (let index = this.#times.length - 1; index >= 0; index--) {
				const at = firing(day * DAY + this.#times[index]! * MINUTE, span);
				if (at === null || at > time) continue;
				return at > floor ? at : null;
			}
		}
		return null;
	}

	count(first: number, last: number): number {
		let count = 0;
		const firstTime = this.#times[0]! * MINUTE;
		const lastTime = this.#times[this.#times.length - 1]! * MINUTE;
		// Both are firings, so each reads as its own local time, and no local time outside their days fires between them.
		for (let day = localDay(this.clock.wall(first)); day <= localDay(this.clock.wall(last)); day++) {
			const skip = this.#monthSkip(day, 1);
			if (skip !== null) {
				day = skip - 1;
				continue;
			}
			if (!this.#matches(day)) continue;
			const span = this.clock.span(day);
			// A whole day on one offset is counted without going through its times.
			if (span.change === null && day * DAY + firstTime - span.before >= first && day * DAY + lastTime - span.before <= last) {
				count += this.#times.length;
				continue;
			}
			for (const minutes of this.#times) {
				const at = firing(day * DAY + minutes * MINUTE, span);
				if (at !== null && at >= first && at <= last) count++;
			}
		}
		return count;
	}

	/** When `day`'s month isn't in the expression: the first day of the next month (going forward) or the last of the one before. */
	#monthSkip(day: number, direction: 1 | -1): number | null {
		const date = new Date(day * DAY);
		if (this.#fields.months.has(date.getUTCMonth() + 1)) return null;
		return Date.UTC(date.getUTCFullYear(), date.getUTCMonth() + (direction === 1 ? 1 : 0), direction === 1 ? 1 : 0) / DAY;
	}

	#matches(day: number): boolean {
		const date = new Date(day * DAY);
		const ofMonth = this.#fields.days.has(date.getUTCDate());
		const ofWeek = this.#fields.weekdays.has(date.getUTCDay());
		return this.#fields.daysAndWeekdays ? ofMonth && ofWeek : ofMonth || ofWeek;
	}

}

/**
 * The instant a local time of a day fires at: its only instant, or the
 * first of two when clocks go back, or null when clocks skip it.
 */
function firing(local: number, span: Span): number | null {
	if (span.change === null) return local - span.before;
	const early = local - span.before;
	if (early < span.change) return early;
	const late = local - span.after;
	return late >= span.change ? late : null;
}

/** Notes the skipped local times whose skip happened no later than `before`, the last firing found. */
function note(skipped: Skipped, pending: { local: number; at: number }[], timeZone: string, before: number) {
	for (const { local, at } of pending) {
		if (at > before) continue;
		skipped.count++;
		if (skipped.listed.length < TIME_LIMITS.skippedListed) skipped.listed.push({ timeZone, local: formatLocal(local) });
	}
}

/** The local day a wall-clock time falls on, counted in days from 1970-01-01. */
function localDay(wall: number): number {
	return Math.floor(wall / DAY);
}

// Time zones

/**
 * The offsets around one local day: from a day before its midnight to two
 * days after, which holds every instant its local times can have. The
 * offset is `before` until the instant `change`, and `after` from then on;
 * `change` is null when it doesn't change.
 */
type Span = { readonly before: number; readonly after: number; readonly change: number | null };

/**
 * A time zone's offsets, as `Intl` reports them. Wall-clock times are
 * written as milliseconds, as if the clock were in UTC.
 */
class ZoneClock {
	readonly timeZone: string;
	readonly #format: Intl.DateTimeFormat;
	/** Offsets already read, for one computation. */
	readonly #offsets = new Map<number, number>();

	constructor(timeZone: string, format: Intl.DateTimeFormat) {
		this.timeZone = timeZone;
		this.#format = format;
	}

	/** The zone's offset from UTC at an instant, in milliseconds. */
	offset(at: number): number {
		const second = Math.floor(at / SECOND) * SECOND;
		const known = this.#offsets.get(second);
		if (known !== undefined) return known;
		const parts: Record<string, number> = {};
		for (const part of this.#format.formatToParts(second)) if (part.type !== "literal") parts[part.type] = Number(part.value);
		const wall = Date.UTC(parts.year!, parts.month! - 1, parts.day!, parts.hour!, parts.minute!, parts.second!);
		const offset = wall - second;
		this.#offsets.set(second, offset);
		return offset;
	}

	wall(at: number): number {
		return at + this.offset(at);
	}

	/** The offsets around a local day; see `Span`. A change is found to the second by halving, in about 18 readings. */
	span(day: number): Span {
		let low = day * DAY - DAY;
		let high = day * DAY + 2 * DAY;
		const before = this.offset(low);
		const after = this.offset(high);
		if (before === after) return { before, after, change: null };
		while (high - low > SECOND) {
			const middle = low + Math.floor((high - low) / 2 / SECOND) * SECOND;
			if (this.offset(middle) === before) low = middle;
			else high = middle;
		}
		return { before, after, change: high };
	}

	/**
	 * The instants a wall-clock time happens at, earliest first: one, two
	 * when clocks go back, or none when they skip it. As in the Temporal
	 * polyfill, it tries the offsets a day before and a day after, and keeps
	 * those that read back as the same wall-clock time.
	 */
	resolve(wall: number): number[] {
		const offsets = new Set([this.offset(wall - DAY), this.offset(wall + DAY)]);
		return [...offsets]
			.map((offset) => wall - offset)
			.filter((at) => this.wall(at) === wall)
			.sort((a, b) => a - b);
	}

	describe(at: number): ZonedTime {
		const offset = this.offset(at);
		return { at, timeZone: this.timeZone, local: formatLocal(at + offset), offset: formatOffset(offset) };
	}
}

/** One formatter per zone, which is slow to make; a zone's offsets are read fresh in each computation. */
const formats = new Map<string, Intl.DateTimeFormat>();

function clockOf(timeZone: string): ZoneClock {
	let format = formats.get(timeZone);
	if (!format) {
		if (formats.size >= 64) formats.clear();
		format = new Intl.DateTimeFormat("en-US", {
			timeZone,
			calendar: "gregory",
			numberingSystem: "latn",
			hourCycle: "h23",
			year: "numeric",
			month: "numeric",
			day: "numeric",
			hour: "numeric",
			minute: "numeric",
			second: "numeric",
		});
		formats.set(timeZone, format);
	}
	return new ZoneClock(timeZone, format);
}

function formatLocal(wall: number): string {
	const iso = new Date(wall).toISOString();
	return wall % SECOND === 0 ? iso.slice(0, 19) : iso.slice(0, 23);
}

function formatOffset(offset: number): string {
	const sign = offset < 0 ? "-" : "+";
	const minutes = Math.abs(offset) / MINUTE;
	const text = `${sign}${String(Math.floor(minutes / 60)).padStart(2, "0")}:${String(Math.floor(minutes % 60)).padStart(2, "0")}`;
	return Math.abs(offset) % MINUTE === 0 ? text : `${text}:${String((Math.abs(offset) % MINUTE) / SECOND).padStart(2, "0")}`;
}
