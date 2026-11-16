import { describe, expect, it } from "vitest";
import { cronOccurrencesBetween, nextCronAfter } from "../src/migration/cron.ts";

const t = (s: string) => Date.parse(s);

describe("cron next occurrence (UTC, Vixie day rule)", () => {
	it("finds the first occurrence strictly after an instant, including on an exact match", () => {
		expect(nextCronAfter("*/15 * * * *", t("2026-11-20T03:00:00Z"))).toBe(t("2026-11-20T03:15:00Z"));
		expect(nextCronAfter("*/15 * * * *", t("2026-11-20T03:07:30Z"))).toBe(t("2026-11-20T03:15:00Z"));
		expect(nextCronAfter("0 9 * * 1-5", t("2026-11-20T09:00:00Z"))).toBe(t("2026-11-23T09:00:00Z")); // Friday 09:00 -> Monday
	});
	it("treats day-of-month and day-of-week as alternatives when both are restricted", () => {
		// The 13th, or any Friday: 2026-11-13 is a Friday and 2026-11-20 is the next Friday; the 13th of December 2026 is a Sunday.
		expect(nextCronAfter("0 0 13 * 5", t("2026-11-14T00:00:00Z"))).toBe(t("2026-11-20T00:00:00Z"));
		expect(nextCronAfter("0 0 13 * 5", t("2026-12-10T00:00:00Z"))).toBe(t("2026-12-11T00:00:00Z"));
		expect(nextCronAfter("0 0 29 2 *", t("2026-01-01T00:00:00Z"))).toBe(t("2028-02-29T00:00:00Z"));
	});
	it("lists the occurrences in a window, and none when the window holds none", () => {
		expect(cronOccurrencesBetween("*/15 * * * *", t("2026-11-20T02:38:00Z"), t("2026-11-20T03:00:00Z"))).toEqual([t("2026-11-20T02:45:00Z"), t("2026-11-20T03:00:00Z")]);
		expect(cronOccurrencesBetween("0 0 1 1 *", t("2026-11-20T00:00:00Z"), t("2026-12-31T00:00:00Z"))).toEqual([]);
		expect(() => nextCronAfter("* * *", 0)).toThrow();
	});
});
