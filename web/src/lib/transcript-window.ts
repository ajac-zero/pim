import { useCallback, useEffect, useState } from "react";

/**
 * How much of a long transcript is drawn. A chat draws its newest rows and keeps older ones out of the page
 * until the person scrolls up to them, so a transcript of thousands of rows, with a dozen streaming at once,
 * costs what its newest screens cost. The window is anchored at a row, not at the end: rows added by the
 * stream extend it downward and never push the one being read out of view.
 */

/** Rows drawn when a chat opens, and how many more each step upward adds. */
export const WINDOW_ROWS = 60;
export const WINDOW_STEP = 60;

/** The first row drawn of a transcript with `total` rows, at its opening. */
export function openingStart(total: number, rows = WINDOW_ROWS): number {
  return Math.max(0, total - rows);
}

/** The first row drawn after one step up. */
export function earlierStart(start: number, step = WINDOW_STEP): number {
  return Math.max(0, start - step);
}

/** A jump to a row that isn't drawn asks for the whole transcript. */
const REVEAL = "pim:reveal-transcript";

export function revealWholeTranscript(): void {
  window.dispatchEvent(new Event(REVEAL));
}

/**
 * The window of a chat's rows: where drawing starts, whether there are
 * earlier rows, and how to draw them. It starts again for another chat.
 */
export function useTranscriptWindow(sessionId: string, total: number) {
  const [state, setState] = useState<{ session: string; start: number | null }>(
    {
      session: sessionId,
      start: null,
    },
  );
  // The first rows of a chat decide where it opens; the window follows the chat on screen.
  const start =
    state.session === sessionId && state.start !== null
      ? Math.min(state.start, total)
      : openingStart(total);
  useEffect(() => {
    setState((prev) =>
      prev.session === sessionId && prev.start !== null
        ? prev
        : { session: sessionId, start: total > 0 ? openingStart(total) : null },
    );
  }, [sessionId, total]);
  const earlier = useCallback(
    () =>
      setState((prev) => ({
        session: sessionId,
        start: earlierStart(prev.start ?? openingStart(total)),
      })),
    [sessionId, total],
  );
  useEffect(() => {
    const all = () => setState({ session: sessionId, start: 0 });
    window.addEventListener(REVEAL, all);
    return () => window.removeEventListener(REVEAL, all);
  }, [sessionId]);
  return { start, earlier };
}
