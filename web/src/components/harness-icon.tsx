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
  // Mistral Vibe: an M of square blocks, as pixels, in Mistral's orange.
  "mistral-vibe": {
    color: "#fa500f",
    glyph: (
      <path
        d="M3 3h3.6v3.6H3zM17.4 3H21v3.6h-3.6zM3 6.6h3.6v3.6H3zM6.6 6.6h3.6v3.6H6.6zM13.8 6.6h3.6v3.6h-3.6zM17.4 6.6H21v3.6h-3.6zM3 10.2h3.6v3.6H3zM10.2 10.2h3.6v3.6h-3.6zM17.4 10.2H21v3.6h-3.6zM3 13.8h3.6v3.6H3zM17.4 13.8H21v3.6h-3.6zM3 17.4h3.6V21H3zM17.4 17.4H21V21h-3.6z"
        fill="currentColor"
      />
    ),
  },
  // Amp: a lightning bolt.
  amp: {
    color: "#2f80ed",
    glyph: (
      <path
        d="M13.5 3 5.5 13.5h6L10.5 21l8-10.5h-6z"
        fill="currentColor"
        stroke="currentColor"
        strokeWidth="1.2"
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
