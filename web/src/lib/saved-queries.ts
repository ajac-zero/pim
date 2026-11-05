import { createAsyncStoragePersister } from "@tanstack/query-async-storage-persister";
import { persistQueryClient } from "@tanstack/query-persist-client-core";
import type { QueryClient } from "@tanstack/react-query";
import { del, get, set } from "idb-keyval";

/**
 * The lists the app's frame and first pages show, kept on this device (in
 * IndexedDB) so the app opens with them at once and refreshes them while it
 * draws, rather than waiting on Pim before it shows anything. Only these
 * lists are kept: no secrets, and nothing of files' or artifacts' contents.
 * Signing out forgets them, with the rest of what was read (see `SignedIn`).
 */
const SAVED = new Set(
  [
    ["auth", "session"],
    ["agents"],
    ["agents", "majordomo"],
    ["sessions"],
    ["extensions"],
    ["approvals"],
    ["notifications"],
    ["account"],
    ["computer"],
    ["artifacts"],
    ["schedules"],
    ["skills"],
    ["visits"],
    ["profile"],
  ].map((key) => JSON.stringify(key)),
);

/** Lists kept longer than this are dropped rather than shown. */
const MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;

/** How long opening the app waits on the device's storage before it goes on without the kept lists. */
const RESTORE_WAIT_MS = 1_000;

/**
 * Puts the kept lists in `queryClient` and keeps saving them as they change.
 * Lists another build of the app kept are dropped: their shape may differ.
 * Resolves once they're restored, or once it gave up on them.
 */
export function restoreSavedQueries(
  queryClient: QueryClient,
  build: string,
): Promise<void> {
  const [, restored] = persistQueryClient({
    queryClient,
    persister: createAsyncStoragePersister({
      storage: { getItem: get, setItem: set, removeItem: del },
      key: "pim-queries",
    }),
    maxAge: MAX_AGE_MS,
    buster: build,
    dehydrateOptions: {
      shouldDehydrateQuery: (query) =>
        query.state.status === "success" && SAVED.has(query.queryHash),
    },
  });
  return Promise.race([
    restored.catch(() => {}),
    new Promise<void>((resolve) => setTimeout(resolve, RESTORE_WAIT_MS)),
  ]);
}
