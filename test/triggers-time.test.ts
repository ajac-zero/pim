import { describe, expect, it } from "vitest";
import { type CronSource, type IntervalSource, type OnceSource, type TimeSource, parseCron, parseTriggerSpec } from "../src/triggers/spec";
import { type Preview, TIME_LIMITS, describeInstant, isScheduledFiring, previewFirings, resolveLocalTime, selectDueFiring } from "../src/triggers/time";
import { TriggerValidationError } from "../src/triggers/validate";

// Triggers are not wired into Pim yet (docs/triggers.md). Expected instants were worked out apart from this code, with Temporal and by hand.

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;
const at = (iso: string) => {
	const ms = Date.parse(iso);
	if (Number.isNaN(ms)) throw new Error(`bad date ${iso}`);
	return ms;
};

/** A time source as a stored spec has it, read by `parseTriggerSpec`. */
function source<T extends TimeSource>(given: Record<string, unknown>): T {
	return parseTriggerSpec({ version: 1, owningAgentId: "agent-1", originChatId: "chat-1", label: "Time", instruction: "Do it.", destination: { type: "new_chat" }, source: { kind: "time", ...given } }).source as T;
}
const cron = (expression: string, timeZone = "America/New_York", catchUpMs?: number) => source<CronSource>({ schedule: "cron", expression, timeZone, catchUpMs });
const interval = (everyMs: number, anchorAt: number, catchUpMs?: number) => source<IntervalSource>({ schedule: "interval", everyMs, anchorAt, catchUpMs });
const once = (when: number, maxLatenessMs?: number) => source<OnceSource>({ schedule: "once", at: when, maxLatenessMs });

/** Each firing as `local` and `offset` together, which is the instant in RFC 3339. */
const shown = (preview: Preview) => preview.firings.map((firing) => `${firing.local}${firing.offset}`);
const next = (s: TimeSource, now: number, count = 3) => previewFirings(s, { now, count }).firings.map((firing) => firing.at);

/** What a scheduler would admit, one alarm at a time, from `now` with nothing admitted yet. */
function dispatch(s: TimeSource, now: number, count: number): number[] {
	const admitted: number[] = [];
	let watermark = now;
	let alarm = selectDueFiring(s, { now, after: watermark }).next;
	while (admitted.length < count && alarm !== null) {
		const selected = selectDueFiring(s, { now: alarm, after: watermark });
		if (selected.status !== "due") throw new Error(`expected a due firing at ${alarm}`);
		expect(selected.scheduledFor).toBe(alarm);
		expect(selected.older).toBeNull();
		admitted.push(selected.scheduledFor);
		watermark = selected.scheduledFor;
		alarm = selected.next;
	}
	return admitted;
}

describe("cron in a time zone", () => {
	it("skips 02:30 on the day clocks skip it, and says so apart from the firings", () => {
		const daily = cron("30 2 * * *");
		const preview = previewFirings(daily, { now: at("2026-03-07T00:00:00-05:00") });
		expect(shown(preview)).toEqual(["2026-03-07T02:30:00-05:00", "2026-03-09T02:30:00-04:00", "2026-03-10T02:30:00-04:00"]);
		expect(preview.skipped).toEqual([{ timeZone: "America/New_York", local: "2026-03-08T02:30:00" }]);
		expect(preview.skippedCount).toBe(1);
		expect(preview.exhausted).toBe(false);
		// No firing is made up for it, not even at 03:30.
		expect(isScheduledFiring(daily, at("2026-03-08T03:30:00-04:00"))).toBe(false);
	});

	it("runs 01:30 once on the day clocks go back, at its first instant", () => {
		const daily = cron("30 1 * * *");
		const first = at("2026-11-01T01:30:00-04:00");
		const second = at("2026-11-01T01:30:00-05:00");
		const tomorrow = at("2026-11-02T01:30:00-05:00");
		expect(shown(previewFirings(daily, { now: at("2026-10-31T12:00:00-04:00") }))).toEqual(["2026-11-01T01:30:00-04:00", "2026-11-02T01:30:00-05:00", "2026-11-03T01:30:00-05:00"]);
		expect(isScheduledFiring(daily, first)).toBe(true);
		expect(isScheduledFiring(daily, second)).toBe(false);

		// A preview, or a restart, before the first instant; between the two; and in the repeated hour before and after its 01:30.
		expect(next(daily, at("2026-11-01T01:00:00-04:00"), 1)).toEqual([first]);
		expect(next(daily, at("2026-11-01T01:45:00-04:00"), 1)).toEqual([tomorrow]);
		expect(next(daily, at("2026-11-01T01:10:00-05:00"), 1)).toEqual([tomorrow]);
		expect(next(daily, at("2026-11-01T01:40:00-05:00"), 1)).toEqual([tomorrow]);

		// After admitting the first instant, nothing is due in the repeated hour.
		expect(selectDueFiring(daily, { now: at("2026-11-01T01:10:00-05:00"), after: first })).toEqual({ status: "none", next: tomorrow });
		expect(selectDueFiring(daily, { now: at("2026-11-01T01:40:00-05:00"), after: first })).toEqual({ status: "none", next: tomorrow });
		// Down until the repeated hour: the first instant is what is due, or missed, never the second.
		const afterYesterday = at("2026-10-31T01:30:00-04:00");
		expect(selectDueFiring(daily, { now: at("2026-11-01T01:20:00-05:00"), after: afterYesterday })).toEqual({ status: "due", scheduledFor: first, deadline: first + HOUR, older: null, next: tomorrow });
		expect(selectDueFiring(daily, { now: at("2026-11-01T01:35:00-05:00"), after: afterYesterday })).toEqual({ status: "missed", scheduledFor: first, deadline: first + HOUR, older: null, next: tomorrow });
	});

	it("leaves UTC as it is: the same local times fire every day", () => {
		expect(shown(previewFirings(cron("30 2 * * *", "UTC"), { now: at("2026-03-07T12:00:00Z") }))).toEqual(["2026-03-08T02:30:00+00:00", "2026-03-09T02:30:00+00:00", "2026-03-10T02:30:00+00:00"]);
		const preview = previewFirings(cron("30 1 * * *", "UTC"), { now: at("2026-10-31T12:00:00Z") });
		expect(shown(preview)).toEqual(["2026-11-01T01:30:00+00:00", "2026-11-02T01:30:00+00:00", "2026-11-03T01:30:00+00:00"]);
		expect(preview.skippedCount).toBe(0);
	});

	it("reads offsets that aren't whole hours, and a half-hour change of daylight saving time", () => {
		expect(shown(previewFirings(cron("0 9 * * *", "Asia/Kathmandu"), { now: at("2026-07-01T00:00:00Z"), count: 1 }))).toEqual(["2026-07-01T09:00:00+05:45"]);
		expect(next(cron("0 9 * * *", "Asia/Kathmandu"), at("2026-07-01T00:00:00Z"), 1)).toEqual([1_782_875_700_000]);
		expect(next(cron("0 9 * * *", "Asia/Kolkata"), at("2026-07-01T00:00:00Z"), 1)).toEqual([1_782_876_600_000]);

		// Lord Howe Island goes from +10:30 to +11:00 at 02:00, which becomes 02:30, and back at 02:00, which becomes 01:30.
		const spring = previewFirings(cron("15 2 * * *", "Australia/Lord_Howe"), { now: at("2026-10-02T12:00:00Z") });
		expect(shown(spring)).toEqual(["2026-10-03T02:15:00+10:30", "2026-10-05T02:15:00+11:00", "2026-10-06T02:15:00+11:00"]);
		expect(spring.firings.map((firing) => firing.at).slice(0, 2)).toEqual([1_790_955_900_000, 1_791_126_900_000]);
		expect(spring.skipped).toEqual([{ timeZone: "Australia/Lord_Howe", local: "2026-10-04T02:15:00" }]);
		const autumn = previewFirings(cron("45 1 * * *", "Australia/Lord_Howe"), { now: at("2026-04-04T00:00:00Z") });
		expect(shown(autumn)).toEqual(["2026-04-05T01:45:00+11:00", "2026-04-06T01:45:00+10:30", "2026-04-07T01:45:00+10:30"]);
		expect(autumn.firings.map((firing) => firing.at).slice(0, 2)).toEqual([1_775_313_900_000, 1_775_402_100_000]);

		// St. John's is three and a half hours behind UTC, two and a half in summer.
		expect(shown(previewFirings(cron("30 2 * * *", "America/St_Johns"), { now: at("2026-03-07T12:00:00Z"), count: 2 }))).toEqual(["2026-03-09T02:30:00-02:30", "2026-03-10T02:30:00-02:30"]);
		expect(next(cron("30 1 * * *", "America/St_Johns"), at("2026-10-31T12:00:00Z"), 2)).toEqual([1_793_505_600_000, at("2026-11-02T01:30:00-03:30")]);
	});

	it("lists and counts every minute an hour-long skip removes, and only within the firings shown", () => {
		const everyMinute = cron("* * * * *");
		const now = at("2026-03-08T01:58:30-05:00");
		const one = previewFirings(everyMinute, { now, count: 1 });
		expect(shown(one)).toEqual(["2026-03-08T01:59:00-05:00"]);
		expect(one.skippedCount).toBe(0);
		// The skip happens at the instant of 03:00, so it is between the first firing and the second.
		expect(previewFirings(everyMinute, { now, count: 2 }).skippedCount).toBe(60);
		const three = previewFirings(everyMinute, { now, count: 3 });
		expect(shown(three)).toEqual(["2026-03-08T01:59:00-05:00", "2026-03-08T03:00:00-04:00", "2026-03-08T03:01:00-04:00"]);
		expect(three.skippedCount).toBe(60);
		expect(three.skipped.map((time) => time.local)).toEqual(["2026-03-08T02:00:00", "2026-03-08T02:01:00", "2026-03-08T02:02:00", "2026-03-08T02:03:00", "2026-03-08T02:04:00"]);
		expect(three.skipped).toHaveLength(TIME_LIMITS.skippedListed);
		// From the instant of the skip on, it is behind.
		expect(previewFirings(everyMinute, { now: at("2026-03-08T03:00:00-04:00"), count: 1 })).toMatchObject({ skippedCount: 0, firings: [{ local: "2026-03-08T03:01:00" }] });
	});
});

describe("cron days", () => {
	const utc = (expression: string, from: string, count: number) => shown(previewFirings(cron(expression, "UTC"), { now: at(from), count })).map((time) => time.slice(0, 16));

	it("fires on the 29th of February only in leap years, across 2100, which is not one", () => {
		expect(utc("0 12 29 2 *", "2026-01-01T00:00:00Z", 3)).toEqual(["2028-02-29T12:00", "2032-02-29T12:00", "2036-02-29T12:00"]);
		// From 2097 the next two are 2104 and 2108; 2112 is past the horizon.
		const late = previewFirings(cron("0 12 29 2 *", "UTC"), { now: at("2097-01-01T00:00:00Z"), count: 3 });
		expect(shown(late).map((time) => time.slice(0, 10))).toEqual(["2104-02-29", "2108-02-29"]);
		expect(late.exhausted).toBe(true);
	});

	it("passes over months without the day", () => {
		expect(utc("0 0 31 * *", "2026-01-15T00:00:00Z", 5)).toEqual(["2026-01-31T00:00", "2026-03-31T00:00", "2026-05-31T00:00", "2026-07-31T00:00", "2026-08-31T00:00"]);
		expect(utc("0 0 30 * *", "2027-01-31T00:00:00Z", 2)).toEqual(["2027-03-30T00:00", "2027-04-30T00:00"]);
	});

	it("fires on either day field when both are restricted, and on both when either starts with *", () => {
		// April 2026: Fridays are the 3rd, 10th, 17th and 24th; the 13th is a Monday.
		expect(utc("0 9 13 * 5", "2026-04-01T00:00:00Z", 4)).toEqual(["2026-04-03T09:00", "2026-04-10T09:00", "2026-04-13T09:00", "2026-04-17T09:00"]);
		// Odd days that are Fridays.
		expect(utc("0 9 */2 * 5", "2026-04-01T00:00:00Z", 4)).toEqual(["2026-04-03T09:00", "2026-04-17T09:00", "2026-05-01T09:00", "2026-05-15T09:00"]);
		// The 13th, whatever the day of the week.
		expect(utc("0 9 13 * */1", "2026-04-01T00:00:00Z", 2)).toEqual(["2026-04-13T09:00", "2026-05-13T09:00"]);
		// Every day of the week restricted the long way is still restricted: any day.
		expect(utc("0 9 13 * 0-6", "2026-04-01T00:00:00Z", 2)).toEqual(["2026-04-01T09:00", "2026-04-02T09:00"]);
		// The 31st of February or a Monday is every Monday in February.
		expect(utc("0 0 31 2 1", "2026-01-01T00:00:00Z", 3)).toEqual(["2026-02-02T00:00", "2026-02-09T00:00", "2026-02-16T00:00"]);
	});

	it("takes Sunday as 0 or 7", () => {
		const sundays = utc("0 9 * * 0", "2026-04-01T00:00:00Z", 3);
		expect(sundays).toEqual(["2026-04-05T09:00", "2026-04-12T09:00", "2026-04-19T09:00"]);
		expect(utc("0 9 * * 7", "2026-04-01T00:00:00Z", 3)).toEqual(sundays);
		expect(utc("0 9 * * 5-7", "2026-04-01T00:00:00Z", 4)).toEqual(["2026-04-03T09:00", "2026-04-04T09:00", "2026-04-05T09:00", "2026-04-10T09:00"]);
		expect(utc("0 9 * * 0,7", "2026-04-01T00:00:00Z", 1)).toEqual(["2026-04-05T09:00"]);
	});

	it("reads steps, ranges with steps, and repeated values once", () => {
		expect(utc("*/20 9-17/4 * * *", "2026-04-01T00:00:00Z", 10)).toEqual([
			"2026-04-01T09:00",
			"2026-04-01T09:20",
			"2026-04-01T09:40",
			"2026-04-01T13:00",
			"2026-04-01T13:20",
			"2026-04-01T13:40",
			"2026-04-01T17:00",
			"2026-04-01T17:20",
			"2026-04-01T17:40",
			"2026-04-02T09:00",
		]);
		expect(utc("5/20 0 * * *", "2026-04-01T00:00:00Z", 4)).toEqual(["2026-04-01T00:05", "2026-04-01T00:25", "2026-04-01T00:45", "2026-04-02T00:05"]);
		expect(utc("0,0,0-0 1,1 * * *", "2026-04-01T00:00:00Z", 2)).toEqual(["2026-04-01T01:00", "2026-04-02T01:00"]);
	});

	it("refuses an expression that names no day, and finds nothing past the horizon for one too rare to have a firing within it", () => {
		for (const expression of ["0 0 30 2 *", "0 0 31 4,6,9,11 *", "0 0 31 2 */2", "0 0 30-31 2 */7"]) {
			expect(() => parseCron(expression, "expression"), expression).toThrow("names no day that exists");
		}
		for (const expression of ["0 0 * * MON", "@daily", "0 0 L * *", "0 0 * * 1#2", "0 0 0 * *", "0 24 * * *", "0 0 * * 8", "0 0 1 1 * 2026"]) {
			expect(() => cron(expression), expression).toThrow(TriggerValidationError);
		}
		// The 29th of February on a Sunday: 2032, then 2060.
		const rare = cron("0 0 29 2 */7", "UTC");
		expect(next(rare, at("2026-01-01T00:00:00Z"))).toEqual([at("2032-02-29T00:00:00Z")]);
		const none = previewFirings(rare, { now: at("2033-01-01T00:00:00Z") });
		expect(none).toEqual({ firings: [], skipped: [], skippedCount: 0, exhausted: true });
		expect(selectDueFiring(rare, { now: at("2045-01-01T00:00:00Z"), after: at("2032-02-29T00:00:00Z") })).toEqual({ status: "none", next: null });
	});
});

describe("due firings", () => {
	it("admits a recurring firing up to and including an hour late, and records it missed a millisecond after", () => {
		const daily = cron("0 9 * * *");
		const nine = at("2026-06-10T09:00:00-04:00");
		const after = at("2026-06-09T09:00:00-04:00");
		expect(selectDueFiring(daily, { now: nine - 1, after })).toEqual({ status: "none", next: nine });
		expect(selectDueFiring(daily, { now: nine, after })).toMatchObject({ status: "due", scheduledFor: nine, deadline: nine + HOUR });
		expect(selectDueFiring(daily, { now: nine + HOUR, after })).toMatchObject({ status: "due", scheduledFor: nine, deadline: nine + HOUR });
		expect(selectDueFiring(daily, { now: nine + HOUR + 1, after })).toMatchObject({ status: "missed", scheduledFor: nine, deadline: nine + HOUR });
		// A source's own lateness, and an instant that is already the watermark.
		expect(selectDueFiring(cron("0 9 * * *", "America/New_York", 3 * HOUR), { now: nine + 3 * HOUR, after })).toMatchObject({ status: "due", deadline: nine + 3 * HOUR });
		expect(selectDueFiring(daily, { now: nine + 30 * MINUTE, after: nine })).toEqual({ status: "none", next: nine + DAY });
	});

	it("runs a one-time trigger up to its lateness, misses it after, and never twice", () => {
		const when = at("2026-06-10T09:00:00Z");
		const reminder = once(when);
		const before = when - DAY;
		expect(selectDueFiring(reminder, { now: when - 1, after: before })).toEqual({ status: "none", next: when });
		expect(selectDueFiring(reminder, { now: when + HOUR, after: before })).toEqual({ status: "due", scheduledFor: when, deadline: when + HOUR, older: null, next: null });
		expect(selectDueFiring(reminder, { now: when + HOUR + 1, after: before })).toEqual({ status: "missed", scheduledFor: when, deadline: when + HOUR, older: null, next: null });
		expect(selectDueFiring(reminder, { now: when + 10 * DAY, after: when })).toEqual({ status: "none", next: null });
		expect(selectDueFiring(once(when, 0), { now: when + 1, after: before })).toMatchObject({ status: "missed", deadline: when });
		// Long overdue is still missed, however far back.
		expect(selectDueFiring(once(at("2001-01-01T00:00:00Z")), { now: at("2026-01-01T00:00:00Z"), after: at("2000-06-01T00:00:00Z") })).toMatchObject({ status: "missed" });
		expect(previewFirings(reminder, { now: when })).toEqual({ firings: [], skipped: [], skippedCount: 0, exhausted: true });
		expect(shown(previewFirings(reminder, { now: before, timeZone: "Europe/Lisbon" }))).toEqual(["2026-06-10T10:00:00+01:00"]);
	});

	it("selects only the latest firing after an outage of days, and summarizes the rest, skipped times left out", () => {
		const daily = cron("30 2 * * *");
		const watermark = at("2026-03-05T02:30:00-05:00");
		const now = at("2026-03-11T02:45:00-04:00");
		expect(selectDueFiring(daily, { now, after: watermark })).toEqual({
			status: "due",
			scheduledFor: at("2026-03-11T02:30:00-04:00"),
			deadline: at("2026-03-11T03:30:00-04:00"),
			// The 6th, 7th, 9th and 10th; the 8th's 02:30 never happened.
			older: { count: 4, first: at("2026-03-06T02:30:00-05:00"), last: at("2026-03-10T02:30:00-04:00"), complete: true },
			next: at("2026-03-12T02:30:00-04:00"),
		});
	});

	it("counts a year of every minute exactly, and an outage past the horizon only within it", () => {
		const everyMinute = cron("* * * * *");
		const after = at("2026-01-01T00:00:00-05:00");
		const now = at("2027-01-01T00:00:00-05:00");
		const selected = selectDueFiring(everyMinute, { now, after });
		// 365 days of minutes after the watermark, less the 60 instants of the repeated hour, which are not firings, less the one selected.
		expect(selected).toEqual({ status: "due", scheduledFor: now, deadline: now + HOUR, older: { count: 365 * 1440 - 60 - 1, first: after + MINUTE, last: now - MINUTE, complete: true }, next: now + MINUTE });

		const longAgo = selectDueFiring(everyMinute, { now, after: at("2000-01-01T00:00:00Z") });
		if (longAgo.status !== "due" || !longAgo.older) throw new Error("expected a due firing with older ones");
		expect(longAgo.older.complete).toBe(false);
		expect(longAgo.older.first).toBeGreaterThan(now - TIME_LIMITS.horizonDays * DAY);
		expect(longAgo.older.last).toBe(now - MINUTE);
	});

	it("keeps an interval on its anchor, however late it is admitted", () => {
		const anchor = at("2026-06-01T08:07:00Z");
		const every = 90 * MINUTE;
		const s = interval(every, anchor);
		expect(next(s, anchor - DAY)).toEqual([anchor, anchor + every, anchor + 2 * every]);
		expect(next(s, anchor)).toEqual([anchor + every, anchor + 2 * every, anchor + 3 * every]);
		const now = anchor + 10 * every + 5 * MINUTE;
		const selected = selectDueFiring(s, { now, after: anchor + 7 * every });
		expect(selected).toEqual({ status: "due", scheduledFor: anchor + 10 * every, deadline: anchor + 10 * every + HOUR, older: { count: 2, first: anchor + 8 * every, last: anchor + 9 * every, complete: true }, next: anchor + 11 * every });
		// Asked again later, as a retry would, the firing and its deadline stay the same.
		expect(selectDueFiring(s, { now: now + 56 * MINUTE, after: anchor + 7 * every })).toMatchObject({ status: "missed", scheduledFor: anchor + 10 * every, deadline: anchor + 10 * every + HOUR });
		expect(selectDueFiring(s, { now: anchor - 1, after: anchor - DAY })).toEqual({ status: "none", next: anchor });
		expect(isScheduledFiring(s, anchor + 3 * every)).toBe(true);
		expect(isScheduledFiring(s, anchor + 3 * every + MINUTE)).toBe(false);
		expect(isScheduledFiring(s, anchor - every)).toBe(false);
		// The longest interval, far from its anchor.
		const yearly = interval(366 * DAY, at("2000-01-01T00:00:00Z"));
		expect(next(yearly, at("2099-12-31T00:00:00Z"), 1)).toEqual([at("2000-01-01T00:00:00Z") + 100 * 366 * DAY]);
	});

	it("admits, one alarm at a time, exactly the firings the preview showed", () => {
		const cases: [TimeSource, string][] = [
			[cron("30 1 * * *"), "2026-10-30T00:00:00Z"],
			[cron("30 2 * * *"), "2026-03-06T00:00:00Z"],
			[cron("*/30 0-3 * * *"), "2026-11-01T00:00:00-04:00"],
			[cron("*/30 0-3 * * *"), "2026-03-08T00:00:00-05:00"],
			[cron("15,45 1,2 * * *", "Australia/Lord_Howe"), "2026-04-04T00:00:00Z"],
			[cron("15,45 1,2 * * *", "Australia/Lord_Howe"), "2026-10-03T00:00:00Z"],
			[cron("0 9 13 * 5", "Europe/Lisbon"), "2026-03-20T00:00:00Z"],
			[interval(7 * MINUTE, at("2026-03-08T06:58:00Z")), "2026-03-08T06:00:00Z"],
		];
		for (const [s, from] of cases) {
			const preview = next(s, at(from), TIME_LIMITS.maxPreviewCount);
			expect(preview).toHaveLength(TIME_LIMITS.maxPreviewCount);
			expect(dispatch(s, at(from), TIME_LIMITS.maxPreviewCount), JSON.stringify(s)).toEqual(preview);
			for (const firing of preview) expect(isScheduledFiring(s, firing)).toBe(true);
		}
	});
});

describe("results", () => {
	it("serialize the same way every time, and read back as the instant", () => {
		const daily = cron("30 2 * * *");
		const now = at("2026-03-07T00:00:00-05:00");
		const preview = previewFirings(daily, { now });
		expect(JSON.stringify(preview)).toBe(
			'{"firings":[{"at":1772868600000,"timeZone":"America/New_York","local":"2026-03-07T02:30:00","offset":"-05:00"},{"at":1773037800000,"timeZone":"America/New_York","local":"2026-03-09T02:30:00","offset":"-04:00"},{"at":1773124200000,"timeZone":"America/New_York","local":"2026-03-10T02:30:00","offset":"-04:00"}],"skipped":[{"timeZone":"America/New_York","local":"2026-03-08T02:30:00"}],"skippedCount":1,"exhausted":false}',
		);
		expect(previewFirings(daily, { now })).toEqual(preview);
		for (const firing of preview.firings) expect(Date.parse(`${firing.local}${firing.offset}`)).toBe(firing.at);
		expect(describeInstant(at("2026-06-01T12:00:00.250Z"), "Asia/Kathmandu")).toEqual({ at: at("2026-06-01T12:00:00.250Z"), timeZone: "Asia/Kathmandu", local: "2026-06-01T17:45:00.250", offset: "+05:45" });
	});

	it("refuse inputs they can't take", () => {
		const daily = cron("0 9 * * *");
		const refused = (work: () => unknown, path: string) => {
			try {
				work();
			} catch (error) {
				expect(error).toBeInstanceOf(TriggerValidationError);
				expect((error as TriggerValidationError).path).toBe(path);
				return;
			}
			throw new Error(`expected ${path} to be refused`);
		};
		for (const now of [Number.NaN, Number.POSITIVE_INFINITY, 1.5, "1800000000000", 2 ** 53, at("1999-12-31T23:59:59Z"), at("2100-01-01T00:00:00Z") + 1]) {
			refused(() => previewFirings(daily, { now: now as number }), "now");
			refused(() => selectDueFiring(daily, { now: now as number, after: at("2026-01-01T00:00:00Z") }), "now");
			refused(() => selectDueFiring(daily, { now: at("2026-01-01T00:00:00Z"), after: now as number }), "after");
		}
		const now = at("2026-01-01T00:00:00Z");
		refused(() => previewFirings(daily, { now, count: 0 }), "count");
		refused(() => previewFirings(daily, { now, count: TIME_LIMITS.maxPreviewCount + 1 }), "count");
		refused(() => previewFirings(daily, { now, timeZone: "UTC" }), "timeZone");
		refused(() => previewFirings(once(now + DAY), { now, timeZone: "+01:00" }), "timeZone");
		refused(() => previewFirings({ ...daily, timeZone: "Mars/Olympus_Mons" }, { now }), "source.timeZone");
		refused(() => previewFirings({ ...daily, expression: "0 9 * * MON" }, { now }), "source.expression");
		refused(() => previewFirings({ ...daily, catchUpMs: -1 }, { now }), "source.catchUpMs");
		refused(() => previewFirings({ ...interval(HOUR, now), everyMs: 0 }, { now }), "source.everyMs");
		refused(() => previewFirings({ ...interval(HOUR, now), everyMs: 1e20 }, { now }), "source.everyMs");
		refused(() => previewFirings({ ...interval(HOUR, now), anchorAt: Number.NaN }, { now }), "source.anchorAt");
		refused(() => previewFirings({ ...once(now), at: 0 }, { now }), "source.at");
		refused(() => previewFirings({ kind: "poll" } as unknown as TimeSource, { now }), "source");
		refused(() => previewFirings({ kind: "time", schedule: "sometimes" } as unknown as TimeSource, { now }), "source.schedule");
		refused(() => isScheduledFiring(daily, Number.NaN), "at");
		// A clock behind the watermark selects nothing rather than replaying.
		expect(selectDueFiring(daily, { now, after: now + DAY })).toEqual({ status: "none", next: at("2026-01-01T09:00:00-05:00") });
	});
});

describe("local date and time for a one-time trigger", () => {
	it("tells unique, ambiguous and nonexistent times apart, and leaves the choice to the caller", () => {
		expect(resolveLocalTime("2026-07-01T09:00", "America/New_York")).toEqual({ kind: "unique", time: { at: at("2026-07-01T13:00:00Z"), timeZone: "America/New_York", local: "2026-07-01T09:00:00", offset: "-04:00" } });
		expect(resolveLocalTime("2026-11-01T01:30", "America/New_York")).toEqual({
			kind: "ambiguous",
			earlier: { at: 1_793_511_000_000, timeZone: "America/New_York", local: "2026-11-01T01:30:00", offset: "-04:00" },
			later: { at: 1_793_514_600_000, timeZone: "America/New_York", local: "2026-11-01T01:30:00", offset: "-05:00" },
		});
		expect(resolveLocalTime("2026-03-08T02:30", "America/New_York")).toEqual({
			kind: "nonexistent",
			timeZone: "America/New_York",
			local: "2026-03-08T02:30:00",
			suggestion: { at: 1_772_955_000_000, timeZone: "America/New_York", local: "2026-03-08T03:30:00", offset: "-04:00" },
		});
		expect(resolveLocalTime("2026-04-05T01:45:30", "Australia/Lord_Howe")).toMatchObject({ kind: "ambiguous", earlier: { offset: "+11:00", at: 1_775_313_930_000 }, later: { offset: "+10:30", at: 1_775_315_730_000 } });
		expect(resolveLocalTime("2026-10-04T02:15", "Australia/Lord_Howe")).toMatchObject({ kind: "nonexistent", suggestion: { local: "2026-10-04T02:45:00", offset: "+11:00", at: 1_791_042_300_000 } });
		expect(resolveLocalTime("2026-07-01T09:00", "Asia/Kathmandu")).toMatchObject({ kind: "unique", time: { at: 1_782_875_700_000, offset: "+05:45" } });
		expect(resolveLocalTime("2026-03-08T02:30", "UTC")).toMatchObject({ kind: "unique", time: { at: at("2026-03-08T02:30:00Z"), offset: "+00:00" } });
	});

	it("agrees with cron about which instant a repeated time is first", () => {
		const resolved = resolveLocalTime("2026-11-01T01:30", "America/New_York");
		if (resolved.kind !== "ambiguous") throw new Error("expected an ambiguous time");
		expect(next(cron("30 1 * * *"), at("2026-10-31T12:00:00Z"), 1)).toEqual([resolved.earlier.at]);
	});

	it("refuses what isn't a date and time on a calendar", () => {
		for (const local of ["2026-02-30T10:00", "2026-13-01T00:00", "2026-01-01T24:00", "2026-01-01T10:60", "2026-03-08 02:30", "2026-03-08T02:30Z", "2026-03-08T02:30-05:00", "1999-12-31T23:00", "2101-01-01T00:00", "", 17]) {
			expect(() => resolveLocalTime(local as string, "America/New_York"), String(local)).toThrow(TriggerValidationError);
		}
		expect(() => resolveLocalTime("2026-03-08T02:30", "EST5EDT+1")).toThrow(TriggerValidationError);
	});
});
