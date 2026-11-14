import type { FileSession } from "~/lib/file-session";
import { canonicalPath } from "~/lib/pim-client";

/*
 * The file sessions open in the canvas, by path, for what agents ask of the
 * canvas: what is open, where the selection is, and to scroll to a line.
 */

const sessions = new Map<string, FileSession>();
/** Lines asked for in files whose editor isn't showing yet: taken when it does. */
const reveals = new Map<string, number>();

export const canvasSessions = {
  add(session: FileSession) {
    sessions.set(canonicalPath(session.path), session);
  },
  remove(session: FileSession) {
    const key = canonicalPath(session.path);
    if (sessions.get(key) === session) sessions.delete(key);
  },
  get: (path: string) => sessions.get(canonicalPath(path)),
};

/** Scrolls a file's editor to a line: now if it is showing, else when it first does. */
export function requestReveal(path: string, line: number) {
  const key = canonicalPath(path);
  reveals.set(key, line);
  // The tab that was hidden is shown a moment after it is asked for.
  setTimeout(() => {
    if (reveals.get(key) === line && sessions.get(key)?.reveal(line)) {
      reveals.delete(key);
    }
  }, 100);
}

/** The line asked for in a file, once, as its editor appears. */
export function takeReveal(path: string) {
  const key = canonicalPath(path);
  const line = reveals.get(key);
  reveals.delete(key);
  return line;
}
