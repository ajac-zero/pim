import type { ReactNode } from "react";
import { type CodingHarness, HARNESS_NAMES } from "~/lib/coding";
import { cn } from "~/lib/utils";

/*
 * A coding harness's mark: a small glyph in its product's rough brand color.
 * They are drawn here, not the products' own logos.
 */
const GLYPHS: Record<CodingHarness, { color: string; glyph: ReactNode }> = {
  // Pi: the Greek letter's bar and two legs.
  pi: {
    color: "#6d5bd0",
    glyph: (
      <path
        d="M5 8h14M9 8v9.5c0 1 .6 1.5 1.5 1.5M15 8v9.5c0 1 .6 1.5 1.5 1.5"
        fill="none"
        stroke="currentColor"
        strokeWidth="2.2"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    ),
  },
  // Claude Code: a burst of rays, in a warm orange.
  "claude-code": {
    color: "#d97757",
    glyph: (
      <path
        d="M12 4v16M4 12h16M6.3 6.3l11.4 11.4M17.7 6.3 6.3 17.7"
        stroke="currentColor"
        strokeWidth="2.2"
        strokeLinecap="round"
      />
    ),
  },
  // Codex: a terminal prompt, `>_`.
  codex: {
    color: "#10a37f",
    glyph: (
      <path
        d="m6 7.5 5 4.5-5 4.5M13 17h5"
        fill="none"
        stroke="currentColor"
        strokeWidth="2.2"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    ),
  },
};

/** The harness's mark, labelled with its name for screen readers. */
export function HarnessIcon({
  harness,
  className,
}: {
  harness: CodingHarness;
  className?: string;
}) {
  const { color, glyph } = GLYPHS[harness];
  return (
    <svg
      viewBox="0 0 24 24"
      role="img"
      aria-label={HARNESS_NAMES[harness]}
      data-harness={harness}
      className={cn("size-4 shrink-0", className)}
      style={{ color }}
    >
      {glyph}
    </svg>
  );
}
