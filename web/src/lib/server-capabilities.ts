/**
 * Which Pim answers: the one this app was built for (v1: the Worker, one socket to a chat) or Pim v2 (HTTP snapshots under `/api/snapshot/*` and the Live
 * service's cursor protocol). It is learned by asking for the sidebar's first snapshot, which only v2 serves, once someone is signed in; until then, and on
 * any Pim that doesn't serve it, the app behaves as it always has.
 */
export type ServerGeneration = "unknown" | "v1" | "v2";

let generation: ServerGeneration = "unknown";
let probing: Promise<ServerGeneration> | null = null;
const listeners = new Set<() => void>();

export const serverGeneration = () => generation;

export function setServerGeneration(next: ServerGeneration): void {
  if (next === generation) return;
  generation = next;
  for (const listener of [...listeners]) listener();
}

export function onServerGeneration(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** Whether a response is v2's sidebar snapshot: a page of sessions with the topic's cursor. */
export function isSidebarSnapshot(body: unknown): boolean {
  return (
    typeof body === "object" &&
    body !== null &&
    Array.isArray((body as { sessions?: unknown }).sessions) &&
    "liveCursor" in body
  );
}

/**
 * Asks once. Not decided while signed out (the answer is 401 either way); a Pim that answers anything but a sidebar snapshot is v1, and a network
 * failure decides nothing, so the next ask tries again.
 */
export function probeServer(
  fetchImpl: typeof fetch = fetch,
): Promise<ServerGeneration> {
  if (generation !== "unknown") return Promise.resolve(generation);
  probing ??= (async () => {
    try {
      const response = await fetchImpl("/api/snapshot/sidebar?limit=1", {
        redirect: "manual",
        headers: { accept: "application/json" },
      });
      if (response.type === "opaqueredirect" || response.status === 401) {
        return generation;
      }
      const body =
        response.status === 200
          ? await response.json().catch(() => null)
          : null;
      setServerGeneration(isSidebarSnapshot(body) ? "v2" : "v1");
    } catch {
      // Offline: asked again next time.
    }
    return generation;
  })().finally(() => {
    probing = null;
  });
  return probing;
}

/** For tests: forget what was learned. */
export function resetServerGeneration(): void {
  generation = "unknown";
  probing = null;
}
