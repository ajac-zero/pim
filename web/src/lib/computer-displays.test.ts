import { describe, expect, it } from "vitest";
import { allDisplays, defaultDisplay, idleFor } from "~/lib/computer-displays";
import type { ComputerDisplay, ComputerDisplays } from "~/lib/pim-api";

const one = (
  threadId: string,
  state: ComputerDisplay["state"],
): ComputerDisplay => ({
  threadId,
  title: null,
  state,
  control: "agent",
  idleSec: 0,
});

const data: ComputerDisplays = {
  displays: [one("a", "active"), one("s", "starting")],
  queue: [one("q", "queued")],
};

describe("the computer's displays", () => {
  it("lists those in use before the queued ones", () => {
    expect(allDisplays(data).map((d) => d.threadId)).toEqual(["a", "s", "q"]);
    expect(allDisplays(undefined)).toEqual([]);
  });

  it("opens on the open chat's display only when it can be shown", () => {
    expect(defaultDisplay(data, "a")).toBe("a");
    expect(defaultDisplay(data, "s")).toBeNull();
    expect(defaultDisplay(data, "q")).toBeNull();
    expect(defaultDisplay(data, "nobody")).toBeNull();
    expect(defaultDisplay(data, undefined)).toBeNull();
  });

  it("writes idle time in its shortest words", () => {
    expect([0, 59, 60, 245, 3599, 3600, 7500].map(idleFor)).toEqual([
      "0s",
      "59s",
      "1m",
      "4m",
      "59m",
      "1h",
      "2h 5m",
    ]);
  });
});
