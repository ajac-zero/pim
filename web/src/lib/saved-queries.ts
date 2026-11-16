import { createAsyncStoragePersister } from "@tanstack/query-async-storage-persister";
import { persistQueryClient } from "@tanstack/query-persist-client-core";
import type { QueryClient } from "@tanstack/react-query";
import { del, get, keys, set } from "idb-keyval";

/**
 * The lists the app's frame and first pages show, kept on this device (in
 * IndexedDB) so the app opens with them at once and refreshes them while it
 * draws, rather than waiting on Pim before it shows anything. Only these
 * lists are kept: no secrets, and nothing of files' or apps' contents.
 *
 * They are kept per owner: each account's lists have a key of their own, and
 * the device remembers which account it last kept them for. When the account
 * that signs in is another, or access ends (signing out, a session that
 * expired, an account that was removed), everything kept is forgotten, for
 * every owner, together with what was read.
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
    ["skills"],
    ["visits"],
    ["profile"],
  ].map((key) => JSON.stringify(key)),
);

/** Lists kept longer than this are dropped rather than shown. */
const MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;

/** How long opening the app waits on the device's storage before it goes on without the kept lists. */
const RESTORE_WAIT_MS = 1_000;

const PREFIX = "pim-queries:";
const OWNER_KEY = "pim-queries-owner";

/** Where lists are kept: IndexedDB, or a stand-in in tests. */
export type KeptStorage = {
  get(key: string): Promise<unknown>;
  set(key: string, value: unknown): Promise<void>;
  del(key: string): Promise<void>;
  keys(): Promise<string[]>;
};

const idb: KeptStorage = {
  get: (key) => get(key),
  set: (key, value) => set(key, value),
  del: (key) => del(key),
  keys: async () => (await keys()).map(String),
};

let persisting: { owner: string; stop: () => void } | null = null;

function persist(
  queryClient: QueryClient,
  build: string,
  owner: string,
  storage: KeptStorage,
) {
  persisting?.stop();
  const [stop, restored] = persistQueryClient({
    queryClient,
    persister: createAsyncStoragePersister({
      storage: {
        getItem: (key) => storage.get(key) as Promise<string | null>,
        setItem: (key, value) => storage.set(key, value),
        removeItem: (key) => storage.del(key),
      },
      key: PREFIX + owner,
    }),
    maxAge: MAX_AGE_MS,
    buster: build,
    dehydrateOptions: {
      shouldDehydrateQuery: (query) =>
        query.state.status === "success" && SAVED.has(query.queryHash),
    },
  });
  persisting = { owner, stop };
  return restored;
}

/**
 * Puts the lists kept for the account this device last kept them for in
 * `queryClient`, and keeps saving them as they change. Lists another build
 * of the app kept are dropped: their shape may differ. Resolves once they're
 * restored, or once it gave up on them. `adoptOwner` settles whose they are
 * once the session says who is signed in.
 */
export function restoreSavedQueries(
  queryClient: QueryClient,
  build: string,
  storage: KeptStorage = idb,
): Promise<void> {
  const restore = storage
    .get(OWNER_KEY)
    .then((owner) =>
      typeof owner === "string" && owner
        ? persist(queryClient, build, owner, storage)
        : undefined,
    )
    .catch(() => {});
  return Promise.race([
    restore,
    new Promise<void>((resolve) => setTimeout(resolve, RESTORE_WAIT_MS)),
  ]);
}

/**
 * The session says who is signed in. Lists kept for someone else are never
 * shown to them: they and everything read so far go, and the lists are kept
 * under this account from now on.
 */
export async function adoptOwner(
  queryClient: QueryClient,
  build: string,
  owner: string,
  storage: KeptStorage = idb,
): Promise<void> {
  if (persisting?.owner === owner) return;
  const other = persisting !== null;
  persisting?.stop();
  persisting = null;
  if (other) {
    queryClient.removeQueries({
      predicate: (query) => query.queryKey[0] !== "auth",
    });
  }
  for (const key of await storage.keys()) {
    if (key.startsWith(PREFIX) && key !== PREFIX + owner)
      await storage.del(key);
  }
  await storage.set(OWNER_KEY, owner);
  await persist(queryClient, build, owner, storage).catch(() => {});
}

/** Access ended: nothing kept for any account stays on this device, and nothing is kept again until someone signs in. */
export async function wipeSavedQueries(
  queryClient: QueryClient,
  storage: KeptStorage = idb,
): Promise<void> {
  persisting?.stop();
  persisting = null;
  queryClient.removeQueries({
    predicate: (query) => query.queryKey[0] !== "auth",
  });
  for (const key of await storage.keys()) {
    if (key.startsWith(PREFIX)) await storage.del(key);
  }
  await storage.del(OWNER_KEY);
}
