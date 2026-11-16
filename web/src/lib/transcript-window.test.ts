import { describe, expect, it } from "vitest";
import {
  earlierStart,
  openingStart,
  WINDOW_ROWS,
  WINDOW_STEP,
} from "~/lib/transcript-window";

describe("transcript window", () => {
  it("opens on the newest rows and steps up to the start", () => {
    expect(openingStart(10)).toBe(0);
    expect(openingStart(5_000)).toBe(5_000 - WINDOW_ROWS);
    let start = openingStart(5_000);
    let steps = 0;
    while (start > 0) {
      const next = earlierStart(start);
      expect(next).toBe(Math.max(0, start - WINDOW_STEP));
      start = next;
      steps++;
    }
    expect(steps).toBe(Math.ceil((5_000 - WINDOW_ROWS) / WINDOW_STEP));
    expect(earlierStart(0)).toBe(0);
  });
});
