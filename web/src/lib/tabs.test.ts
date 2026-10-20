import { beforeEach, describe, expect, it } from "vitest";
import { closeTab, getTabs, openTab, pruneTabs, showTab } from "~/lib/tabs";

const open = () => getTabs().map((tab) => tab.session);

describe("tabs", () => {
  beforeEach(() => pruneTabs(new Set()));

  it("shows a chat in the current tab, in place of the chat shown there", () => {
    showTab("a");
    expect(open()).toEqual(["a"]);
    openTab("b");
    showTab("b");
    showTab("c");
    expect(open()).toEqual(["a", "c"]);
    // A chat with a tab of its own shows there, and its tab becomes the current one.
    showTab("a");
    showTab("d");
    expect(open()).toEqual(["d", "c"]);
  });

  it("opens a chat in a new tab only once", () => {
    showTab("a");
    openTab("b");
    openTab("b");
    openTab("a");
    expect(open()).toEqual(["a", "b"]);
  });

  it("gives a chat a new tab when the current one is closed", () => {
    showTab("a");
    openTab("b");
    closeTab("a");
    showTab("c");
    expect(open()).toEqual(["b", "c"]);
  });

  it("shows the tab to the right of a closed one, or else the one to its left", () => {
    for (const session of ["a", "b", "c"]) openTab(session);
    expect(closeTab("b")).toBe("c");
    expect(closeTab("c")).toBe("a");
    expect(closeTab("a")).toBeUndefined();
    expect(closeTab("missing")).toBeUndefined();
    expect(open()).toEqual([]);
  });

  it("closes the tabs of chats that no longer exist", () => {
    for (const session of ["a", "b", "c"]) openTab(session);
    pruneTabs(new Set(["a", "b"]));
    expect(open()).toEqual(["a", "b"]);
  });
});
