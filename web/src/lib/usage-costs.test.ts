import { describe, expect, it } from "vitest";
import type { CostReport } from "~/lib/pim-api";
import { OTHER, stackSeries, UNTAGGED } from "~/lib/usage-costs";

const day = (
  name: string,
  byAgent: { key: string | null; costUsd: number }[],
): CostReport["byDay"][number] => ({
  day: name,
  costUsd: byAgent.reduce((n, s) => n + s.costUsd, 0),
  calls: 1,
  cacheHitRatio: null,
  byAgent,
  byModel: [],
  byRunKind: [],
});

describe("stackSeries", () => {
  it("keeps the biggest series over the whole period and groups the rest as other", () => {
    const names = ["a", "b", "c", "d", "e", "f", "g", "h", "i", "j"];
    // Series k costs k+1 cents on day 1, and only j and i cost on day 2.
    const days = [
      day(
        "2026-11-01",
        names.map((key, i) => ({ key, costUsd: (i + 1) / 100 })),
      ),
      day("2026-11-02", [
        { key: "a", costUsd: 0.01 },
        { key: "j", costUsd: 0.5 },
      ]),
    ];
    const { series, days: stacked } = stackSeries(days, "agent");
    expect(series).toEqual(["j", "i", "h", "g", "f", "e", "d", "c", OTHER]);
    // a and b are folded into other, on both days.
    expect(stacked[0]?.parts[OTHER]).toBeCloseTo(0.03);
    expect(stacked[1]?.parts).toEqual({ j: 0.5, [OTHER]: 0.01 });
  });

  it("shows no other series when everything fits", () => {
    const { series } = stackSeries(
      [day("2026-11-01", [{ key: "a", costUsd: 1 }])],
      "agent",
    );
    expect(series).toEqual(["a"]);
  });

  it("names a null key as untagged, apart from other", () => {
    const { series, days } = stackSeries(
      [
        day("2026-11-01", [
          { key: null, costUsd: 2 },
          { key: "a", costUsd: 1 },
        ]),
      ],
      "agent",
    );
    expect(series).toEqual([UNTAGGED, "a"]);
    expect(days[0]?.parts[UNTAGGED]).toBe(2);
  });
});
