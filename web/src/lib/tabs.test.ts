import { beforeEach, describe, expect, it } from "vitest";
import { getTabs, pinTab, pruneTabs, unpinTab } from "~/lib/tabs";

const open = () => getTabs().map((tab) => tab.session);

describe("tabs", () => {
  beforeEach(() => pruneTabs(new Set()));

  it("pins a chat only once", () => {
    pinTab("b");
    pinTab("b");
    pinTab("a");
    expect(open()).toEqual(["b", "a"]);
  });

  it("shows the tab to the right of a closed one, or else the one to its left", () => {
    for (const session of ["a", "b", "c"]) pinTab(session);
    expect(unpinTab("b")).toBe("c");
    expect(unpinTab("c")).toBe("a");
    expect(unpinTab("a")).toBeUndefined();
    expect(unpinTab("missing")).toBeUndefined();
    expect(open()).toEqual([]);
  });

  it("closes the tabs of chats that no longer exist", () => {
    for (const session of ["a", "b", "c"]) pinTab(session);
    pruneTabs(new Set(["a", "b"]));
    expect(open()).toEqual(["a", "b"]);
  });
});
