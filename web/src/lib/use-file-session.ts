import { useQueryClient } from "@tanstack/react-query";
import { useEffect, useState, useSyncExternalStore } from "react";
import { canvasSessions } from "~/lib/canvas-live";
import { FileSession, type SessionState } from "~/lib/file-session";
import {
  decodeFile,
  MAX_EDITABLE_BYTES,
  MAX_VIEWABLE_BYTES,
} from "~/lib/file-text";
import { ApiError, readFile } from "~/lib/pim-api";
import { pimClient } from "~/lib/pim-client";

export type FileLoad =
  | { phase: "loading" }
  /** Too big or not text: the file is for downloading. */
  | { phase: "refused" }
  | { phase: "missing" }
  | { phase: "failed"; message: string }
  | { phase: "ready"; session: FileSession };

const LOADING: SessionState = {
  status: "loading",
  conflict: null,
  disk: null,
  error: null,
};

/** Opens `path` for editing when `enabled`, and closes it, saving what is pending, when it changes or the page leaves. */
export function useFileSession(path: string, enabled: boolean) {
  const [load, setLoad] = useState<FileLoad>({ phase: "loading" });
  const queryClient = useQueryClient();

  useEffect(() => {
    if (!enabled) return;
    setLoad({ phase: "loading" });
    let current: FileSession | null = null;
    let stopWatching: (() => void) | null = null;
    let cancelled = false;
    readFile(path).then(
      (read) => {
        if (cancelled) return;
        if (
          read.bytes.byteLength > MAX_VIEWABLE_BYTES ||
          decodeFile(read.bytes).kind === "binary"
        ) {
          setLoad({ phase: "refused" });
          return;
        }
        const session = new FileSession(path);
        session.open(read, read.bytes.byteLength > MAX_EDITABLE_BYTES);
        current = session;
        canvasSessions.add(session);
        // Pim watches the file while it is open: what changes it elsewhere reloads here, and the listing of its folder follows.
        stopWatching = pimClient.watchFile(path, (change) => {
          if (session.fileChanged(change)) {
            void queryClient.invalidateQueries({ queryKey: ["files"] });
          }
        });
        setLoad({ phase: "ready", session });
      },
      (failure) => {
        if (cancelled) return;
        setLoad(
          failure instanceof ApiError && failure.status === 404
            ? { phase: "missing" }
            : {
                phase: "failed",
                message:
                  failure instanceof Error ? failure.message : String(failure),
              },
        );
      },
    );
    // Saves as the page hides or the tab loses focus, besides on every pause in typing.
    const flush = () => void current?.flush();
    const hide = () => {
      if (document.visibilityState === "hidden") flush();
    };
    window.addEventListener("pagehide", flush);
    document.addEventListener("visibilitychange", hide);
    return () => {
      cancelled = true;
      window.removeEventListener("pagehide", flush);
      document.removeEventListener("visibilitychange", hide);
      stopWatching?.();
      if (current) canvasSessions.remove(current);
      current?.dispose();
    };
  }, [path, enabled, queryClient]);

  const session = load.phase === "ready" ? load.session : null;
  const state = useSyncExternalStore(
    session?.subscribe ?? noSubscribe,
    session?.getState ?? (() => LOADING),
  );
  return { load, state };
}

const noSubscribe = () => () => {};
