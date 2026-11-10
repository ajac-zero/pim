import amp from "~/assets/harness/amp.svg";
import claudeCode from "~/assets/harness/claude-code.svg";
import codex from "~/assets/harness/codex.svg";
import mistralVibe from "~/assets/harness/mistral-vibe.svg";
import pi from "~/assets/harness/pi.svg";
import { type CodingHarness, HARNESS_NAMES } from "~/lib/coding";
import { cn } from "~/lib/utils";

/* Each harness's own logo; their sources and licenses are in `assets/harness/README.md`. */
const LOGOS: Record<CodingHarness, string> = {
  pi,
  "claude-code": claudeCode,
  codex,
  "mistral-vibe": mistralVibe,
  amp,
};

/**
 * A coding harness's logo on its own, sized to fill the icon area. Codex's is
 * black, so in dark themes it is inverted to white; the others have colors
 * that read on both.
 */
export function HarnessIcon({
  harness,
  className,
}: {
  harness: CodingHarness;
  className?: string;
}) {
  return (
    <span
      data-harness={harness}
      className={cn(
        "flex size-5 shrink-0 items-center justify-center",
        className,
      )}
    >
      <img
        src={LOGOS[harness]}
        alt={HARNESS_NAMES[harness]}
        className={cn(
          "size-[90%] object-contain",
          harness === "codex" && "dark:invert",
        )}
      />
    </span>
  );
}
