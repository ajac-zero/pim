import type { CostReport, Spend } from "~/lib/pim-api";

export type Dimension = "agent" | "model" | "runKind";

/** Series keys for the calls with no tag and for the series beyond the top ones. */
export const UNTAGGED = "\0untagged";
export const OTHER = "\0other";

export type StackedDay = {
  day: string;
  total: number;
  /** Dollars by series key. */
  parts: Record<string, number>;
};

const spendOf = (
  day: CostReport["byDay"][number],
  dimension: Dimension,
): Spend[] =>
  dimension === "agent"
    ? day.byAgent
    : dimension === "model"
      ? day.byModel
      : day.byRunKind;

/**
 * The days' cost split by agent, model or run kind: the `max` series that cost
 * the most over the whole period, biggest first, and everything else as one
 * "other" series. A null key becomes UNTAGGED.
 */
export function stackSeries(
  byDay: CostReport["byDay"],
  dimension: Dimension,
  max = 8,
): { series: string[]; days: StackedDay[] } {
  const keyOf = (spend: Spend) => spend.key ?? UNTAGGED;
  const totals = new Map<string, number>();
  for (const day of byDay) {
    for (const spend of spendOf(day, dimension)) {
      totals.set(keyOf(spend), (totals.get(keyOf(spend)) ?? 0) + spend.costUsd);
    }
  }
  const ranked = [...totals].sort((a, b) => b[1] - a[1]).map(([key]) => key);
  const top = new Set(ranked.slice(0, max));
  const days = byDay.map((day) => {
    const parts: Record<string, number> = {};
    for (const spend of spendOf(day, dimension)) {
      const key = top.has(keyOf(spend)) ? keyOf(spend) : OTHER;
      parts[key] = (parts[key] ?? 0) + spend.costUsd;
    }
    return { day: day.day, total: day.costUsd, parts };
  });
  return {
    series: ranked.length > max ? [...ranked.slice(0, max), OTHER] : ranked,
    days,
  };
}
