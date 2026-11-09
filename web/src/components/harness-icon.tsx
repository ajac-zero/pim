import type { ReactNode } from "react";
import type { CodingHarness } from "~/lib/coding";
import { cn } from "~/lib/utils";

/** Each harness's name, as its logo is labeled. */
export const HARNESS_NAMES: Record<CodingHarness, string> = {
  pi: "Pi",
  "claude-code": "Claude Code",
  codex: "Codex",
};

/**
 * Each harness's logo: a simple mark of Pim's own on a 24×24 tile. Pi's and
 * Codex's take the theme's foreground and background, inverted from each
 * other; Claude Code's keeps its orange in every theme.
 */
const MARKS: Record<CodingHarness, ReactNode> = {
  pi: (
    <>
      <rect width="24" height="24" rx="6" className="fill-foreground" />
      <path
        d="M6.5 8h11M9.5 8v9M14.5 8v7.5q0 1.5 1.5 1.5"
        fill="none"
        strokeWidth="2.2"
        strokeLinecap="round"
        className="stroke-background"
      />
    </>
  ),
  "claude-code": (
    <>
      <rect width="24" height="24" rx="6" fill="#d97757" />
      <path
        d="M12 4.5v15M4.5 12h15M6.7 6.7l10.6 10.6M17.3 6.7 6.7 17.3"
        fill="none"
        stroke="#fff"
        strokeWidth="2.2"
        strokeLinecap="round"
      />
    </>
  ),
  codex: (
    <>
      <rect
        x="0.75"
        y="0.75"
        width="22.5"
        height="22.5"
        rx="5.25"
        strokeWidth="1.5"
        className="fill-background stroke-foreground"
      />
      <path
        d="m7 8.5 3.5 3.5L7 15.5M12.5 16h4.5"
        fill="none"
        strokeWidth="2.2"
        strokeLinecap="round"
        strokeLinejoin="round"
        className="stroke-foreground"
      />
    </>
  ),
};

/** The logo of the coding agent a thread runs as, labeled with its name. */
export function HarnessIcon({
  harness,
  className,
}: {
  harness: CodingHarness;
  className?: string;
}) {
  return (
    <svg
      viewBox="0 0 24 24"
      role="img"
      aria-label={HARNESS_NAMES[harness]}
      data-harness={harness}
      className={cn("size-5 shrink-0", className)}
    >
      {MARKS[harness]}
    </svg>
  );
}
