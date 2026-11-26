import { QueryClient } from "@tanstack/react-query";
import { describe, expect, it } from "vitest";
import {
  adoptOwner,
  type KeptStorage,
  restoreSavedQueries,
  wipeSavedQueries,
} from "~/lib/saved-queries";

function memoryStorage(): KeptStorage & { data: Map<string, unknown> } {
  const data = new Map<string, unknown>();
  return {
    data,
    get: async (key) => data.get(key),
    set: async (key, value) => void data.set(key, value),
    del: async (key) => void data.delete(key),
    keys: async () => [...data.keys()],
  };
}

const flush = () => new Promise((resolve) => setTimeout(resolve, 1_100));
const client = () => new QueryClient();

describe("account-isolated saved queries", () => {
  it("keeps each account's lists under its own key and shows another account none of them", async () => {
    const storage = memoryStorage();
    const ada = client();
    await restoreSavedQueries(ada, "b1", storage);
    await adoptOwner(ada, "b1", "ada", storage);
    ada.setQueryData(["sessions"], [{ id: "ada-private-chat" }]);
    await flush();
    expect([...storage.data.keys()].sort()).toEqual([
      "pim-queries-owner",
      "pim-queries:ada",
    ]);

    // The same device opens again: Ada's lists come back at once.
    const reopened = client();
    await restoreSavedQueries(reopened, "b1", storage);
    expect(reopened.getQueryData(["sessions"])).toEqual([
      { id: "ada-private-chat" },
    ]);

    // The session says it is Grace: Ada's lists leave the screen's cache and the device.
    await adoptOwner(reopened, "b1", "grace", storage);
    expect(reopened.getQueryData(["sessions"])).toBeUndefined();
    expect([...storage.data.keys()]).toEqual(["pim-queries-owner"]);
    expect(storage.data.get("pim-queries-owner")).toBe("grace");
    reopened.setQueryData(["sessions"], [{ id: "grace-chat" }]);
    await flush();
    expect(JSON.stringify([...storage.data.values()])).not.toContain(
      "ada-private-chat",
    );
    expect(JSON.stringify(storage.data.get("pim-queries:grace"))).toContain(
      "grace-chat",
    );
    expect(storage.data.has("pim-queries:ada")).toBe(false);
  });

  it("keeps no approval or task on the device, so none is shown as current after a restart", async () => {
    const storage = memoryStorage();
    const ada = client();
    await restoreSavedQueries(ada, "b1", storage);
    await adoptOwner(ada, "b1", "ada", storage);
    ada.setQueryData(["sessions"], [{ id: "chat-1" }]);
    ada.setQueryData(["approvals"], [{ id: "approval-pending-1" }]);
    ada.setQueryData(["tasks", "chat-1"], [{ id: "task-running-1" }]);
    await flush();
    const kept = JSON.stringify(storage.data.get("pim-queries:ada"));
    expect(kept).toContain("chat-1");
    expect(kept).not.toContain("approval-pending-1");
    expect(kept).not.toContain("task-running-1");
    const reopened = client();
    await restoreSavedQueries(reopened, "b1", storage);
    expect(reopened.getQueryData(["sessions"])).toBeDefined();
    expect(reopened.getQueryData(["approvals"])).toBeUndefined();
  });

  it("wipes every kept list, and what was read, when access ends", async () => {
    const storage = memoryStorage();
    storage.data.set("pim-queries:someone-else", "stale");
    const qc = client();
    await adoptOwner(qc, "b1", "ada", storage);
    qc.setQueryData(["sessions"], [{ id: "x" }]);
    qc.setQueryData(["auth", "session"], { signedIn: false });
    await flush();
    await wipeSavedQueries(qc, storage);
    expect([...storage.data.keys()]).toEqual([]);
    expect(qc.getQueryData(["sessions"])).toBeUndefined();
    // The sign-in screen's own query stays.
    expect(qc.getQueryData(["auth", "session"])).toEqual({ signedIn: false });
    // Nothing is kept again until someone signs in: a late change does not write.
    qc.setQueryData(["sessions"], [{ id: "late" }]);
    await flush();
    expect([...storage.data.keys()]).toEqual([]);
  });

  it("starts with nothing to restore on a device that never kept lists", async () => {
    const qc = client();
    await restoreSavedQueries(qc, "b1", memoryStorage());
    expect(qc.getQueryData(["sessions"])).toBeUndefined();
  });
});
