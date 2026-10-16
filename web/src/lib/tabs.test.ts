import { beforeEach, describe, expect, it } from "vitest";
import { closeTab, getTabs, pruneTabs, showTab } from "~/lib/tabs";

const open = () =>
  getTabs().map((tab) => (tab.kept ? tab.session : `(${tab.session})`));

describe("tabs", () => {
  beforeEach(() => pruneTabs(new Set()));

  it("opens a chat in the preview tab, where the next one replaces it", () => {
    showTab("a", true);
    showTab("b");
    showTab("c", true);
    expect(open()).toEqual(["a", "(b)", "c"]);
    showTab("d");
    expect(open()).toEqual(["a", "(d)", "c"]);
    // Showing a chat that has a tab leaves the preview alone.
    showTab("a");
    expect(open()).toEqual(["a", "(d)", "c"]);
  });

  it("keeps a previewed chat in its place, so the next chat gets a new tab", () => {
    showTab("a", true);
    showTab("b");
    showTab("c", true);
    showTab("b", true);
    showTab("d");
    expect(open()).toEqual(["a", "b", "c", "(d)"]);
  });

  it("shows the tab to the right of a closed one, or else the one to its left", () => {
    for (const session of ["a", "b", "c"]) showTab(session, true);
    expect(closeTab("b")).toBe("c");
    expect(closeTab("c")).toBe("a");
    expect(closeTab("a")).toBeUndefined();
    expect(closeTab("missing")).toBeUndefined();
    expect(open()).toEqual([]);
  });

  it("closes the tabs of chats that no longer exist", () => {
    showTab("a", true);
    showTab("b");
    showTab("c", true);
    pruneTabs(new Set(["a", "b"]));
    expect(open()).toEqual(["a", "(b)"]);
  });
});
